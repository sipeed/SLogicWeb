// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M0 `LinkSession`: the one owner of the physical USB connection.
 *
 * Source of truth: docs/ARCHITECTURE.md §3.1 and the platform rules P1-P10 in
 * §1.3. The session owns pairing/open/claim/handshake/link-probe/reconnect
 * policy and exposes a typed state and a typed error. It has no WebUSB types and
 * no DOM: the concrete transport is injected as a `LinkPort`, so the same state
 * machine is exercised by the fake port in `linkSessionSelftest.ts` and by the
 * browser adapter without a branch.
 *
 * Deliberate rules:
 *
 * - There is no automatic reconnect. Pairing and the connect/disconnect events
 *   produce at most one attempt per caller action; a failure is a terminal
 *   `lost`/`idle`/`busy` state and the UI offers Reconnect. No timers fire here.
 * - The link probe is bounded twice: by the profile/options and by the hard
 *   limits below. A probe is `bursts` control round-trips of `bytes` payload
 *   bytes; it never grows while a device is answering slowly.
 * - A profile/id/firmware/inventory mismatch is a typed `profile` refusal and
 *   the interface is released for another owner. A transport failure during
 *   identity or probe is `transfer`/`lost`; the device is not usable.
 * - The identity format below is the M0 control-plane contract between the
 *   page and the firmware's identity reply. The injected `LinkPort` owns the
 *   vendor request that produces it; the session only parses and validates the
 *   reply, so no WebUSB request fields leak into this module.
 *
 * Assumptions resolved from the contract:
 *
 * - `LinkPort.open()` covers selection and `USBDevice.open()`; the state is
 *   `selecting` while it is pending when a user-gesture permission request was
 *   asked for, and `opening` when reconnecting from an existing grant. The port
 *   boundary does not expose the chooser/open split, so `opening` is entered as
 *   soon as `open()` returns and is immediately followed by `claiming`.
 * - The firmware-reported link rate is validated against `profile.link.rates`.
 *   M0 stores the measured probe throughput and latency for stream sizing but
 *   does not infer a different USB speed from a control-transfer round-trip:
 *   control latency cannot distinguish FS/HS/SS reliably, and guessing would
 *   violate "a profile mismatch is never a fallback that guesses".
 */

import type { DeviceProfile, LinkRate } from '../device/profileTypes.js';

/** Connection zone of the composite state machine (ARCHITECTURE §3.1, §5.2). */
export type LinkState =
  | 'unsupported'
  | 'idle'
  | 'selecting'
  | 'opening'
  | 'claiming'
  | 'handshaking'
  | 'ready'
  | 'busy'
  | 'suspended'
  | 'lost'
  | 'closed';

/** Every failure has one of these reasons (ARCHITECTURE §3.1). */
export type LinkErrorReason =
  | 'unsupported'
  | 'denied'
  | 'busy'
  | 'handshake'
  | 'profile'
  | 'transfer'
  | 'lost'
  | 'suspended';

/**
 * A typed link failure. `detail` is a short human-readable sentence; it is not
 * a diagnostic code and callers must not parse it. `cause` preserves the
 * underlying exception for the Diagnostics panel/console.
 */
export class LinkError extends Error {
  readonly reason: LinkErrorReason;
  readonly detail: string | undefined;

  constructor(reason: LinkErrorReason, detail?: string, cause?: unknown) {
    super(detail === undefined ? reason : `${reason}: ${detail}`);
    this.name = 'LinkError';
    this.reason = reason;
    this.detail = detail;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * One control-plane request the session makes through the injected port.
 *
 * - `identity`: the firmware's fixed identity record (layout below).
 * - `probe`: one link-probe burst. The port must move exactly `bytes` payload
 *   bytes and return exactly that many bytes; a short reply is a transfer
 *   failure. A concrete adapter performs the vendor/bulk work.
 */
export type LinkControlRequest =
  | { readonly kind: 'identity' }
  | { readonly kind: 'probe'; readonly bytes: number };

/**
 * The injectable USB boundary. No WebUSB type appears here: the browser adapter
 * translates these calls to `USBDevice.open()`/`claimInterface()`/vendor
 * control transfers, and the fake port in the self-test implements them
 * directly. `release()` is called exactly once after a successful claim;
 * `close()` closes whatever `open()` acquired. The adapter owns the per-origin
 * Web Lock and must throw `LinkError('busy', owner)` (P7) when another owner
 * holds the interface.
 */
export interface LinkPort {
  open(): Promise<void>;
  claim(): Promise<void>;
  release(): Promise<void>;
  control(request: LinkControlRequest): Promise<Uint8Array>;
  close(): Promise<void>;
  /** Optional disconnect notification (cable unplugged, device reset, ...). */
  onDisconnect?(callback: () => void): void;
}

export interface LinkProbeOptions {
  /** Payload bytes per probe burst. */
  readonly bytes: number;
  /** Number of probe bursts; the total work is bounded by the constants below. */
  readonly bursts: number;
}

/** Measured link-probe result. Values are payload throughput, not line rate. */
export interface LinkProbeResult {
  readonly bytesPerBurst: number;
  readonly bursts: number;
  readonly totalBytes: number;
  readonly elapsedMs: number;
  /** Payload bytes/second over the whole probe. 0 when the clock did not advance. */
  readonly bytesPerSecond: number;
  /** Mean wall-clock time of one probe round-trip. */
  readonly latencyMs: number;
}

/** Immutable identity plus probe snapshot stored on a ready session. */
export interface LinkHandshake {
  readonly protocol: { readonly major: number; readonly minor: number };
  readonly firmware: string;
  readonly serial: string;
  readonly profileId: string;
  readonly channels: number;
  readonly analogGroups: number;
  readonly linkRate: LinkRate;
  readonly probe: LinkProbeResult;
}

/** Platform facts supplied by `src/platform` (P1). */
export interface LinkCapabilities {
  readonly usb: boolean;
  readonly secureContext: boolean;
}

export interface LinkSessionOptions {
  readonly port: LinkPort;
  readonly profile: DeviceProfile;
  readonly capabilities: LinkCapabilities;
  /** Overrides `profile.link.probe` for deterministic tests/bench runs. */
  readonly probe?: LinkProbeOptions;
}

export interface LinkConnectOptions {
  /**
   * True when the call runs from a user gesture and may open the browser
   * chooser (P2). False reconnects a device the origin already has permission
   * for (`getDevices()`); the port decides how to honour that.
   */
  readonly requestPermission?: boolean;
}

/** Protocol version this app understands. */
export const LINK_PROTOCOL_MAJOR = 1;
export const LINK_PROTOCOL_MINOR = 0;

/** Format version of the identity record below. */
export const LINK_IDENTITY_FORMAT = 1;

/** Hard bounds on the link probe; profile/options cannot exceed them. */
export const MAX_PROBE_BURSTS = 256;
export const MAX_PROBE_BYTES_PER_BURST = 4 * 1024 * 1024;
export const MAX_PROBE_TOTAL_BYTES = 16 * 1024 * 1024;

/** Identity record bounds. */
export const MAX_IDENTITY_BYTES = 512;
const SERIAL_MAX_BYTES = 128;
const PROFILE_ID_MAX_BYTES = 64;

/**
 * Identity record (all integers little-endian):
 *
 *   offset  size  field
 *   0       2     magic 'L' 'W'
 *   2       1     format version (1)
 *   3       1     reserved, must be 0
 *   4       2     protocol major
 *   6       2     protocol minor
 *   8       2     firmware major
 *   10      2     firmware minor
 *   12      2     firmware patch
 *   14      1     serial length N (0..128)
 *   15      N     serial, printable ASCII
 *   15+N    1     profile id length M (1..64)
 *   16+N    M     profile id, printable ASCII
 *   16+N+M  2     reported digital channel inventory
 *   18+N+M  1     analog group count
 *   19+N+M  1     link rate code (0=fs, 1=hs, 2=ss)
 *
 * Trailing bytes are accepted because the vendor control transport rounds
 * transfers up to four bytes. Anything else is a `handshake` refusal.
 */
interface IdentityRecord {
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly firmware: string;
  readonly firmwareVersion: Version;
  readonly serial: string;
  readonly profileId: string;
  readonly channels: number;
  readonly analogGroups: number;
  readonly linkRate: LinkRate;
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export class LinkSession {
  private readonly port: LinkPort;
  private readonly profile: DeviceProfile;
  private readonly probeOverride: LinkProbeOptions | undefined;
  private readonly platformError: LinkError | null;

  private _state: LinkState;
  private _error: LinkError | null = null;
  private _handshake: LinkHandshake | null = null;
  private _closeReason: string | undefined;

  /** Invalidates in-flight operations whenever the session changes ownership. */
  private epoch = 0;
  /** The port was opened (or a call to open was made) and may need closing. */
  private portTouched = false;
  /** The interface claim succeeded and must be released. */
  private portClaimed = false;
  /** Serialises release() -> close(); never rejects. */
  private portCleanup: Promise<string | null> | null = null;
  /** Loss cleanup may still run when the caller immediately reconnects. */
  private lossCleanup: Promise<string | null> | null = null;
  private connectInFlight = false;
  private handshakeInFlight = false;

  constructor(options: LinkSessionOptions) {
    this.port = options.port;
    this.profile = options.profile;
    this.probeOverride = options.probe;

    if (!options.capabilities.usb || !options.capabilities.secureContext) {
      const missing: string[] = [];
      if (!options.capabilities.usb) missing.push('WebUSB is not available');
      if (!options.capabilities.secureContext) missing.push('the page is not a secure context');
      this.platformError = new LinkError('unsupported', missing.join('; '));
      this._state = 'unsupported';
      this._error = this.platformError;
    } else {
      this.platformError = null;
      this._state = 'idle';
    }

    // Registered once. After close() a late event is ignored by state checks in
    // `handleDisconnect`; the port interface intentionally has no remove method.
    try {
      this.port.onDisconnect?.(this.handleDisconnect);
    } catch (error) {
      throw new LinkError(
        'transfer',
        `disconnect listener registration failed: ${errorMessage(error)}`,
        error,
      );
    }
  }

  get state(): LinkState {
    return this._state;
  }

  get error(): LinkError | null {
    return this._error;
  }

  get handshake(): LinkHandshake | null {
    return this._handshake;
  }

  /** The reason passed to the most recent `disconnect()`, if any. */
  get closeReason(): string | undefined {
    return this._closeReason;
  }

  /**
   * Pair/open/claim/handshake. Enters `selecting` when a chooser is requested,
   * then `opening`, `claiming`, `handshaking`, and finally `ready`. Failures
   * are terminal for the attempt; there is no internal retry.
   */
  async connect(options: LinkConnectOptions = {}): Promise<void> {
    if (this.platformError !== null) {
      this._state = 'unsupported';
      this._error = this.platformError;
      throw this.platformError;
    }

    switch (this._state) {
      case 'ready':
        // Idempotent: an already-ready session does not re-open or re-probe.
        return;
      case 'suspended':
        throw new LinkError('suspended', 'resume the suspended link before connecting again');
      case 'selecting':
      case 'opening':
      case 'claiming':
      case 'handshaking':
        throw new LinkError('busy', `connect is already in progress (${this._state})`);
      case 'unsupported':
        throw this.platformError ?? new LinkError('unsupported', 'this platform has no WebUSB link');
      case 'idle':
      case 'busy':
      case 'lost':
      case 'closed':
        break;
    }

    if (this.connectInFlight || this.handshakeInFlight) {
      throw new LinkError('busy', 'a link operation is already in progress');
    }

    this.connectInFlight = true;
    const epoch = ++this.epoch;
    this._error = null;
    this._handshake = null;
    this._closeReason = undefined;

    try {
      // A loss or disconnect cleanup from the previous session may still own
      // the port. `releasePort` joins any cleanup already in flight and flushes
      // acquisitions that landed after it, so the new open cannot race a close.
      await this.releasePort();
      this.assertEpoch(epoch);

      const requestPermission = options.requestPermission ?? true;
      // `open()` covers both the chooser and USBDevice.open(); the two states
      // are the only observable split this boundary offers (see file header).
      this._state = requestPermission ? 'selecting' : 'opening';
      this.portTouched = true;
      try {
        await this.port.open();
      } catch (error) {
        throw await this.failOpen(epoch, requestPermission, error);
      }
      // Mark the acquisition before checking the epoch: a concurrent
      // disconnect() may already have run its first close while open() was
      // pending, and this open still has to be closed by this attempt.
      this.portTouched = true;
      await this.throwIfSuperseded(epoch);

      if (requestPermission) this._state = 'opening';
      this._state = 'claiming';
      try {
        await this.port.claim();
      } catch (error) {
        throw await this.failClaim(epoch, error);
      }
      // Same race as open(): the claim may have landed after disconnect()
      // ran, so record it and release it ourselves if the attempt is stale.
      this.portClaimed = true;
      this.portTouched = true;
      await this.throwIfSuperseded(epoch);

      this._state = 'handshaking';
      await this.runHandshake(epoch);
    } finally {
      this.connectInFlight = false;
    }
  }

  /**
   * Re-read identity and run the bounded link probe. Valid on a ready link
   * (re-probe) and on a suspended link (what `resume()` uses); other states
   * have no claimed port to handshake on.
   */
  async handshakeAndProbe(): Promise<LinkHandshake> {
    if (this.platformError !== null) {
      this._state = 'unsupported';
      this._error = this.platformError;
      throw this.platformError;
    }
    if (this.handshakeInFlight || this.connectInFlight) {
      throw new LinkError('busy', 'a link operation is already in progress');
    }
    if (this._state !== 'ready' && this._state !== 'suspended') {
      throw new LinkError('lost', `handshake requires an open link (state ${this._state})`);
    }

    this.handshakeInFlight = true;
    const epoch = ++this.epoch;
    this._state = 'handshaking';
    this._handshake = null;
    this._error = null;
    try {
      return await this.runHandshake(epoch);
    } finally {
      this.handshakeInFlight = false;
    }
  }

  /**
   * Page hidden/backgrounded (P9). Only a ready link has samples to suspend;
   * an in-progress transition refuses, and a session that is already idle,
   * lost, closed, busy or unsupported has nothing to suspend.
   */
  suspend(): void {
    if (this._state === 'suspended') return;
    if (this._state === 'selecting' || this._state === 'opening' ||
      this._state === 'claiming' || this._state === 'handshaking') {
      throw new LinkError('busy', `cannot suspend during ${this._state}`);
    }
    if (this._state !== 'ready') return;
    this._state = 'suspended';
    this._error = null;
  }

  /**
   * Page visible again: re-handshake on the existing claim. The device may have
   * reset or dropped the stream while hidden; `handshakeAndProbe` then yields
   * `lost` rather than pretending the old session is still valid.
   */
  async resume(): Promise<void> {
    if (this._state === 'ready') return;
    if (this._state !== 'suspended') {
      throw new LinkError('lost', `cannot resume a link in state ${this._state}`);
    }
    await this.handshakeAndProbe();
  }

  /**
   * User-initiated disconnect: release the claim, close the device, enter
   * `closed`, and stop exposing a handshake. Cleanup failures leave the state
   * `closed` (nothing is usable any more) but surface a typed `transfer` error.
   */
  async disconnect(reason?: string): Promise<void> {
    if (this._state === 'closed') return;

    ++this.epoch;
    this._state = 'closed';
    this._handshake = null;
    this._error = null;
    this._closeReason = reason;

    const lossIssue = await this.settleLossCleanup();
    const issue = combineIssues(lossIssue, await this.releasePort());
    if (issue !== null) {
      const error = new LinkError('transfer', `disconnect cleanup failed: ${issue}`);
      this._error = error;
      throw error;
    }
  }

  /** Terminal teardown; equivalent to `disconnect()` without a reason. */
  async close(): Promise<void> {
    await this.disconnect();
  }

  private readonly handleDisconnect = (): void => {
    if (this._state === 'idle' || this._state === 'unsupported' ||
      this._state === 'lost' || this._state === 'closed') {
      return;
    }

    ++this.epoch;
    this._state = 'lost';
    this._handshake = null;
    this._error = new LinkError('lost', 'the device disconnected');
    this.startLossCleanup();
  };

  private async runHandshake(epoch: number): Promise<LinkHandshake> {
    try {
      const probe = this.resolveProbe();
      this.validateProfile();
      this.assertEpoch(epoch);

      let rawIdentity: Uint8Array;
      try {
        rawIdentity = await this.port.control({ kind: 'identity' });
      } catch (error) {
        this.assertEpoch(epoch);
        throw toTransferError(error, 'identity read failed');
      }
      this.assertEpoch(epoch);

      const identity = decodeIdentity(rawIdentity);
      this.validateIdentity(identity);
      this.assertEpoch(epoch);

      const probeResult = await this.runProbe(epoch, probe);
      this.assertEpoch(epoch);

      const handshake: LinkHandshake = Object.freeze({
        protocol: Object.freeze({
          major: identity.protocolMajor,
          minor: identity.protocolMinor,
        }),
        firmware: identity.firmware,
        serial: identity.serial,
        profileId: identity.profileId,
        channels: identity.channels,
        analogGroups: identity.analogGroups,
        linkRate: identity.linkRate,
        probe: probeResult,
      });
      this._handshake = handshake;
      this._state = 'ready';
      this._error = null;
      return handshake;
    } catch (error) {
      throw await this.failHandshake(epoch, error);
    }
  }

  private async runProbe(epoch: number, config: LinkProbeOptions): Promise<LinkProbeResult> {
    const started = monotonicNow();
    let totalBytes = 0;

    for (let burst = 0; burst < config.bursts; ++burst) {
      let reply: Uint8Array;
      try {
        reply = await this.port.control({ kind: 'probe', bytes: config.bytes });
      } catch (error) {
        this.assertEpoch(epoch);
        throw toTransferError(error, `probe burst ${burst + 1} failed`);
      }
      this.assertEpoch(epoch);
      if (reply.byteLength !== config.bytes) {
        throw new LinkError(
          'transfer',
          `probe burst ${burst + 1} returned ${reply.byteLength} bytes, expected ${config.bytes}`,
        );
      }
      totalBytes += reply.byteLength;
    }

    const elapsedMs = Math.max(0, monotonicNow() - started);
    return Object.freeze({
      bytesPerBurst: config.bytes,
      bursts: config.bursts,
      totalBytes,
      elapsedMs,
      // 0 means "the clock could not resolve the interval", never Infinity.
      bytesPerSecond: elapsedMs > 0 ? totalBytes / (elapsedMs / 1000) : 0,
      latencyMs: elapsedMs / config.bursts,
    });
  }

  private resolveProbe(): LinkProbeOptions {
    const config = this.probeOverride ?? this.profile.link.probe;
    const maxTransfer = this.profile.link.maxTransferBytes;

    if (!Number.isInteger(maxTransfer) || maxTransfer < 1) {
      throw new LinkError('profile', `profile ${this.profile.id} has an invalid maxTransferBytes`);
    }
    if (!Number.isInteger(config.bytes) || config.bytes < 1) {
      throw new LinkError('profile', 'probe bytes must be a positive integer');
    }
    if (!Number.isInteger(config.bursts) || config.bursts < 1) {
      throw new LinkError('profile', 'probe bursts must be a positive integer');
    }
    if (config.bytes > maxTransfer) {
      throw new LinkError(
        'profile',
        `probe burst ${config.bytes} exceeds maxTransferBytes ${maxTransfer}`,
      );
    }
    if (config.bytes > MAX_PROBE_BYTES_PER_BURST) {
      throw new LinkError('profile', `probe burst ${config.bytes} exceeds the ${MAX_PROBE_BYTES_PER_BURST}-byte cap`);
    }
    if (config.bursts > MAX_PROBE_BURSTS) {
      throw new LinkError('profile', `probe bursts ${config.bursts} exceeds the ${MAX_PROBE_BURSTS} cap`);
    }
    const total = config.bytes * config.bursts;
    if (!Number.isSafeInteger(total) || total > MAX_PROBE_TOTAL_BYTES) {
      throw new LinkError('profile', `probe total of ${config.bytes} x ${config.bursts} exceeds the ${MAX_PROBE_TOTAL_BYTES}-byte cap`);
    }
    return { bytes: config.bytes, bursts: config.bursts };
  }

  private validateProfile(): void {
    if (this.profile.id.length === 0) {
      throw new LinkError('profile', 'the profile has no id');
    }
    if (!Number.isInteger(this.profile.digital.maxChannels) || this.profile.digital.maxChannels < 1) {
      throw new LinkError('profile', `profile ${this.profile.id} has no digital channel inventory`);
    }
    if (parseVersion(this.profile.firmware.min) === null) {
      throw new LinkError(
        'profile',
        `profile ${this.profile.id} has an invalid firmware minimum '${this.profile.firmware.min}'`,
      );
    }
  }

  private validateIdentity(identity: IdentityRecord): void {
    const minimum = parseVersion(this.profile.firmware.min);
    if (minimum === null) {
      // validateProfile() already refused; keep the guard local and explicit.
      throw new LinkError('profile', `profile ${this.profile.id} has an invalid firmware minimum`);
    }
    if (compareVersions(identity.firmwareVersion, minimum) < 0) {
      throw new LinkError(
        'profile',
        `firmware ${identity.firmware} is older than ${this.profile.firmware.min} required by profile ${this.profile.id}`,
      );
    }
    if (identity.profileId !== this.profile.id) {
      throw new LinkError(
        'profile',
        `device reports profile '${identity.profileId}', expected '${this.profile.id}'`,
      );
    }
    if (identity.channels !== this.profile.digital.maxChannels) {
      throw new LinkError(
        'profile',
        `device reports ${identity.channels} digital channels, profile ${this.profile.id} declares ${this.profile.digital.maxChannels}`,
      );
    }
    if (identity.analogGroups !== this.profile.analog.groups.length) {
      throw new LinkError(
        'profile',
        `device reports ${identity.analogGroups} analog groups, profile ${this.profile.id} declares ${this.profile.analog.groups.length}`,
      );
    }
    if (!this.profile.link.rates.includes(identity.linkRate)) {
      throw new LinkError(
        'profile',
        `device reports link rate '${identity.linkRate}', which profile ${this.profile.id} does not support`,
      );
    }
    if (this.profile.serial?.required === true && identity.serial.length === 0) {
      throw new LinkError('profile', `profile ${this.profile.id} requires a serial number`);
    }
  }

  private async failOpen(
    epoch: number,
    requestPermission: boolean,
    error: unknown,
  ): Promise<LinkError> {
    this.assertEpoch(epoch);
    const linkError = toOpenError(error, requestPermission);
    return this.failAttempt(epoch, linkError);
  }

  private async failClaim(epoch: number, error: unknown): Promise<LinkError> {
    this.assertEpoch(epoch);
    const linkError = toClaimError(error);
    return this.failAttempt(epoch, linkError);
  }

  /**
   * Release whatever the failed attempt acquired, then publish the terminal
   * state. The original reason is preserved; a cleanup failure is appended to
   * the detail rather than replacing it.
   */
  private async failAttempt(epoch: number, linkError: LinkError): Promise<LinkError> {
    const issue = await this.releasePort();
    if (this.epoch !== epoch) {
      // A disconnect/close superseded this attempt and owns the state now.
      throw this.currentFailure(linkError);
    }
    this._state = stateForReason(linkError.reason);
    this._handshake = null;
    const finalError = issue === null
      ? linkError
      : new LinkError(linkError.reason, appendDetail(linkError.detail, `cleanup failed: ${issue}`), linkError);
    this._error = finalError;
    return finalError;
  }

  private async failHandshake(epoch: number, error: unknown): Promise<LinkError> {
    if (this.epoch !== epoch) {
      // handleDisconnect()/disconnect() already set lost/closed and started
      // cleanup; do not overwrite it with a secondary idle/transfer state.
      throw this.currentFailure(error);
    }
    const linkError = toHandshakeError(error);
    return this.failAttempt(epoch, linkError);
  }

  private currentFailure(preferred: unknown): LinkError {
    if (this._error !== null) return this._error;
    if (preferred instanceof LinkError) return preferred;
    return new LinkError('lost', 'the link changed during the operation', preferred);
  }

  /** Throw if a disconnect/close/suspend made `epoch` stale. */
  private assertEpoch(epoch: number): void {
    if (this.epoch === epoch) return;
    if (this._state === 'lost') {
      throw this._error ?? new LinkError('lost', 'the link was lost during the operation');
    }
    if (this._state === 'closed') {
      throw new LinkError('lost', 'the session was closed during the operation');
    }
    if (this._state === 'suspended') {
      throw new LinkError('suspended', 'the session was suspended during the operation');
    }
    throw new LinkError('busy', 'the operation was superseded by another session transition');
  }

  /**
   * `assertEpoch` for a just-acquired open/claim: if a disconnect raced the
   * acquisition, release what this attempt acquired before rethrowing.
   */
  private async throwIfSuperseded(epoch: number): Promise<void> {
    try {
      this.assertEpoch(epoch);
    } catch (error) {
      const issue = await this.releasePort();
      if (issue !== null && error instanceof LinkError) {
        throw new LinkError(error.reason, appendDetail(error.detail, `cleanup failed: ${issue}`), error);
      }
      throw error;
    }
  }

  private settleLossCleanup(): Promise<string | null> {
    return this.lossCleanup ?? Promise.resolve(null);
  }

  private startLossCleanup(): void {
    if (this.lossCleanup !== null) return;
    let promise: Promise<string | null>;
    promise = this.releasePort().then((issue) => {
      if (issue !== null && this._state === 'lost') {
        const base = this._error ?? new LinkError('lost', 'the device disconnected');
        this._error = new LinkError(
          base.reason,
          appendDetail(base.detail, `cleanup failed: ${issue}`),
          base,
        );
      }
      return issue;
    }).catch((error: unknown) => {
      // releasePort() is written not to reject; this guards the state update
      // above so a loss cannot also become an unhandled rejection.
      const issue = `cleanup threw: ${errorMessage(error)}`;
      if (this._state === 'lost') {
        const base = this._error ?? new LinkError('lost', 'the device disconnected');
        this._error = new LinkError(base.reason, appendDetail(base.detail, issue), base);
      }
      return issue;
    }).finally(() => {
      if (this.lossCleanup === promise) this.lossCleanup = null;
    });
    this.lossCleanup = promise;
  }

  /**
   * Serialised release -> close. Never rejects: failures are returned as a
   * detail string so the caller can attach them to the state's typed error.
   *
   * The loop matters: an open()/claim() that was pending when an earlier
   * cleanup ran can land afterwards, re-raising `portTouched`/`portClaimed`.
   * This caller then has to release that later acquisition too instead of
   * returning the earlier cleanup's result and leaking the interface.
   */
  private async releasePort(): Promise<string | null> {
    let carried: string | null = null;
    for (;;) {
      while (this.portCleanup !== null) {
        carried = combineIssues(carried, await this.portCleanup);
      }

      const claimed = this.portClaimed;
      const touched = this.portTouched;
      if (!claimed && !touched) return carried;
      this.portClaimed = false;
      this.portTouched = false;

      let promise: Promise<string | null>;
      promise = this.cleanupOnce(claimed, touched)
        .catch((error: unknown) => `cleanup threw: ${errorMessage(error)}`)
        .finally(() => {
          if (this.portCleanup === promise) this.portCleanup = null;
        });
      this.portCleanup = promise;
      carried = combineIssues(carried, await promise);
    }
  }

  private async cleanupOnce(claimed: boolean, touched: boolean): Promise<string | null> {
    let issue: string | null = null;
    if (claimed) {
      try {
        await this.port.release();
      } catch (error) {
        issue = `release failed: ${describeError(error)}`;
      }
    }
    if (touched || claimed) {
      try {
        await this.port.close();
      } catch (error) {
        issue = combineIssues(issue, `close failed: ${describeError(error)}`);
      }
    }
    return issue;
  }
}

function stateForReason(reason: LinkErrorReason): LinkState {
  switch (reason) {
    case 'handshake':
    case 'profile':
    case 'denied':
      return 'idle';
    case 'unsupported':
      return 'unsupported';
    case 'busy':
      return 'busy';
    case 'suspended':
      return 'suspended';
    case 'transfer':
    case 'lost':
      return 'lost';
  }
}

function toOpenError(error: unknown, requestPermission: boolean): LinkError {
  if (error instanceof LinkError) return error;
  const name = errorName(error);
  if (name === 'SecurityError' || name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new LinkError('denied', errorMessage(error), error);
  }
  if (name === 'NotFoundError') {
    return requestPermission
      ? new LinkError('denied', 'device selection was cancelled', error)
      : new LinkError('lost', 'no granted device to reconnect', error);
  }
  return new LinkError('lost', `device open failed: ${errorMessage(error)}`, error);
}

/**
 * A claim failure is a conflict with another owner (P7), so the state is
 * `busy`; only a LinkError the port already typed (denied/lost/unsupported) is
 * allowed to keep its own reason.
 */
function toClaimError(error: unknown): LinkError {
  if (error instanceof LinkError) return error;
  return new LinkError('busy', `interface claim failed: ${errorMessage(error)}`, error);
}

function toTransferError(error: unknown, context: string): LinkError {
  if (error instanceof LinkError) return error;
  const name = errorName(error);
  if (name === 'NetworkError' || name === 'NotFoundError' || name === 'SecurityError') {
    return new LinkError('lost', `${context}: ${errorMessage(error)}`, error);
  }
  return new LinkError('transfer', `${context}: ${errorMessage(error)}`, error);
}

function toHandshakeError(error: unknown): LinkError {
  if (error instanceof LinkError) return error;
  return toTransferError(error, 'handshake failed');
}

function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return 'unprintable error';
  }
}

function describeError(error: unknown): string {
  if (error instanceof LinkError) {
    return error.detail === undefined ? error.reason : `${error.reason} (${error.detail})`;
  }
  return errorMessage(error);
}

function appendDetail(detail: string | undefined, extra: string): string {
  return detail === undefined || detail.length === 0 ? extra : `${detail}; ${extra}`;
}

function combineIssues(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return `${a}; ${b}`;
}

function decodeIdentity(bytes: Uint8Array): IdentityRecord {
  if (bytes.byteLength > MAX_IDENTITY_BYTES) {
    throw new LinkError('handshake', `identity reply is ${bytes.byteLength} bytes, limit ${MAX_IDENTITY_BYTES}`);
  }
  if (bytes.byteLength < 21) {
    throw new LinkError('handshake', `identity reply is only ${bytes.byteLength} bytes`);
  }
  if (bytes[0] !== 0x4c || bytes[1] !== 0x57) {
    throw new LinkError('handshake', 'identity reply has no LW magic');
  }
  if (bytes[2] !== LINK_IDENTITY_FORMAT) {
    throw new LinkError('handshake', `identity format ${bytes[2]} is not ${LINK_IDENTITY_FORMAT}`);
  }
  if (bytes[3] !== 0) {
    throw new LinkError('handshake', `identity reserved byte is ${bytes[3]}, expected 0`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const protocolMajor = view.getUint16(4, true);
  const protocolMinor = view.getUint16(6, true);
  const firmwareVersion: Version = {
    major: view.getUint16(8, true),
    minor: view.getUint16(10, true),
    patch: view.getUint16(12, true),
  };
  if (protocolMajor !== LINK_PROTOCOL_MAJOR) {
    throw new LinkError(
      'handshake',
      `device protocol ${protocolMajor}.${protocolMinor}, this app speaks ${LINK_PROTOCOL_MAJOR}.${LINK_PROTOCOL_MINOR}`,
    );
  }
  if (protocolMinor > LINK_PROTOCOL_MINOR) {
    throw new LinkError(
      'handshake',
      `device protocol ${protocolMajor}.${protocolMinor} is newer than ${LINK_PROTOCOL_MAJOR}.${LINK_PROTOCOL_MINOR}`,
    );
  }

  let offset = 14;
  const serialLength = bytes[offset];
  offset += 1;
  if (serialLength > SERIAL_MAX_BYTES) {
    throw new LinkError('handshake', `serial length ${serialLength} exceeds ${SERIAL_MAX_BYTES}`);
  }
  if (offset + serialLength + 1 > bytes.byteLength) {
    throw new LinkError('handshake', 'identity reply ends inside the serial number');
  }
  const serial = decodePrintableAscii(bytes.subarray(offset, offset + serialLength), 'serial');
  offset += serialLength;

  const profileLength = bytes[offset];
  offset += 1;
  if (profileLength < 1 || profileLength > PROFILE_ID_MAX_BYTES) {
    throw new LinkError('handshake', `profile id length ${profileLength} is outside 1..${PROFILE_ID_MAX_BYTES}`);
  }
  if (offset + profileLength + 4 > bytes.byteLength) {
    throw new LinkError('handshake', 'identity reply ends inside the profile id or inventory');
  }
  const profileId = decodePrintableAscii(bytes.subarray(offset, offset + profileLength), 'profile id');
  offset += profileLength;

  const channels = view.getUint16(offset, true);
  const analogGroups = bytes[offset + 2];
  const linkRate = linkRateFromCode(bytes[offset + 3]);

  return {
    protocolMajor,
    protocolMinor,
    firmware: `${firmwareVersion.major}.${firmwareVersion.minor}.${firmwareVersion.patch}`,
    firmwareVersion,
    serial,
    profileId,
    channels,
    analogGroups,
    linkRate,
  };
}

function decodePrintableAscii(bytes: Uint8Array, field: string): string {
  let text = '';
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) {
      throw new LinkError(
        'handshake',
        `${field} contains non-printable byte 0x${byte.toString(16).padStart(2, '0')}`,
      );
    }
    text += String.fromCharCode(byte);
  }
  return text;
}

function linkRateFromCode(code: number): LinkRate {
  switch (code) {
    case 0: return 'fs';
    case 1: return 'hs';
    case 2: return 'ss';
    default:
      throw new LinkError('handshake', `identity reports unknown link rate code ${code}`);
  }
}

function parseVersion(text: string): Version | null {
  // The device identity always carries a full triple; the profile minimum may
  // be written as "1", "1.2" or "1.2.3". Missing components are zero.
  const match = /^v?(\d{1,6})(?:\.(\d{1,6}))?(?:\.(\d{1,6}))?$/.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function compareVersions(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
