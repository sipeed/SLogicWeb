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
 * Identity sources, in order:
 *
 * - `LinkPort.describe()` is the required source. The stock U3 protocol has no
 *   identity, firmware or inventory register: the libsigrok driver learns all of
 *   it from USB descriptors (VID/PID/serial and the negotiated link class), so
 *   the descriptor path is what a real device uses today.
 * - The `identity` control request and the `probe` control request are a
 *   PROPOSAL for a future firmware extension, not current device protocol. The
 *   stock protocol exposes only vendor requests 0x00/0x01 (register read/write
 *   in 4-byte chunks, docs/PROTOCOL-SLOGIC16U3.md); there is no LW identity
 *   record, no firmware-version register and no 15 MB probe. They run only when
 *   the port implements `control()` and answers; an `unsupported` refusal falls
 *   back to descriptors with firmware, profile id and inventory unknown and
 *   `probe: null`. A stock device must reach `ready` without either request.
 *
 * Deliberate rules:
 *
 * - There is no automatic reconnect. Pairing and the connect/disconnect events
 *   produce at most one attempt per caller action; a failure is a terminal
 *   `lost`/`idle`/`busy` state and the UI offers Reconnect. No timers fire here.
 * - The descriptor's VID/PID (and shape) are checked immediately after `open()`
 *   and before `claim()`: the session never claims the interface of a device
 *   that does not match the selected profile. A descriptor/profile/id/inventory
 *   mismatch is a typed `profile` refusal; a wrong device is closed unclaimed,
 *   and a later identity mismatch releases the interface for another owner. A
 *   transport failure during descriptor, identity or probe is
 *   `transfer`/`lost`; the device is not usable.
 * - The probe is optional (see above) and, when it runs, bounded twice: by the
 *   profile/options and by the hard limits below. A probe is `bursts` control
 *   round-trips of `bytes` payload bytes; it never grows while a device is
 *   answering slowly.
 * - Duplicate/ambiguous-serial detection (P6) is out of scope for a single
 *   session. This session sees only the one descriptor behind its injected
 *   `LinkPort`; deciding that two granted devices share a serial requires
 *   enumerating the origin's devices and holding cross-device state, which
 *   belongs to the platform adapter that selects the port, not here. The
 *   session enforces only what one descriptor can prove: a profile that
 *   requires a serial refuses an empty one, and the origin-scoped descriptor
 *   string is never treated as a stable unit identity.
 * - `profile.firmware.min` is documentation only: the stock protocol cannot
 *   read a firmware version, and the shipped 32U3 floor is a hardware S/N, not
 *   a dotted version.
 *
 * Assumptions resolved from the contract:
 *
 * - `connect()` reads the descriptor once, right after `open()` returns and
 *   before `claim()`, and reuses that verified descriptor for the handshake so
 *   the identity guard costs no extra port round-trip. `handshakeAndProbe()`
 *   (resume/re-probe) reads a fresh descriptor on the already-claimed link.
 * - `LinkPort.open()` covers selection and `USBDevice.open()`; the state is
 *   `selecting` while it is pending when a user-gesture permission request was
 *   asked for, and `opening` when reconnecting from an existing grant. The port
 *   boundary does not expose the chooser/open split, so `opening` is entered as
 *   soon as `open()` returns and is immediately followed by `claiming`.
 * - The descriptor's negotiated link class is the rate source and is validated
 *   against `profile.link.rates`. M0 stores measured probe throughput and
 *   latency for stream sizing when the optional probe ran, but never infers a
 *   different USB speed from a control-transfer round-trip: control latency
 *   cannot distinguish FS/HS/SS reliably, and guessing would violate "a profile
 *   mismatch is never a fallback that guesses".
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
 * USB link class the port observed for this connection.
 *
 * The adapter maps the platform's USB speed report to this vocabulary: full
 * speed -> `fs`, high speed -> `hs`, SuperSpeed 5 Gbps -> `ss5`, SuperSpeed+
 * 10 Gbps -> `ss10`. This is the only rate source; a probe measures throughput
 * and latency but never re-classifies the link.
 */
export type LinkClass = 'fs' | 'hs' | 'ss5' | 'ss10';

/**
 * Facts the transport can obtain without any device-specific request: USB
 * descriptors and the link class. This is the required identity source for a
 * stock U3 device and is available before (or without) any control-plane
 * extension.
 *
 * `serialNumber` is WebUSB's origin-scoped serial (empty when the browser
 * withholds it), not a stable unit identity.
 */
export interface LinkPortDescriptor {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber: string;
  readonly linkClass: LinkClass;
}

/**
 * One control-plane request the session makes through the injected port.
 *
 * These are PROPOSALS requiring a future firmware extension; the stock protocol
 * has no such request. The session only sends them when the port implements
 * `control()`, and treats an `unsupported` refusal as "extension absent".
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
 * translates these calls to `USBDevice.open()`/`claimInterface()`/descriptor
 * reads/vendor control transfers, and the fake port in the self-test implements
 * them directly. `release()` is called exactly once after a successful claim;
 * `close()` closes whatever `open()` acquired. The adapter owns the per-origin
 * Web Lock and must throw `LinkError('busy', owner)` (P7) when another owner
 * holds the interface.
 *
 * `describe()` is required: VID/PID, serial and link class all come from USB
 * descriptors the stock protocol already provides. `control()` is optional and
 * implements the proposed extension only; a port that does not implement it (or
 * that throws `LinkError('unsupported')`) yields a descriptor-only handshake
 * with `probe: null`.
 */
export interface LinkPort {
  open(): Promise<void>;
  claim(): Promise<void>;
  release(): Promise<void>;
  describe(): Promise<LinkPortDescriptor>;
  /**
   * Optional proposed extension. `undefined` is the stock device: no identity
   * or probe request exists.
   */
  control?: ((request: LinkControlRequest) => Promise<Uint8Array>) | undefined;
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
  /**
   * Mean host-measured round-trip time of one probe burst (`elapsedMs /
   * bursts`), not the USB link latency: it includes scheduling, transport and
   * device turnaround, so it is not comparable across hosts and must never be
   * used to classify FS/HS/SS. It is reported for diagnostics and stream
   * sizing only.
   */
  readonly latencyMs: number;
}

/**
 * Which identity source produced the handshake. `descriptor` is the stock
 * device: the proposed control-plane extension is absent, so firmware, profile
 * id, protocol and inventory are all `null` and no probe ran.
 */
export type LinkIdentitySource = 'control' | 'descriptor';

/** Immutable identity plus optional probe snapshot stored on a ready session. */
export interface LinkHandshake {
  readonly identitySource: LinkIdentitySource;
  /** From the optional identity record; null when only descriptors are available. */
  readonly protocol: { readonly major: number; readonly minor: number } | null;
  /** From the optional identity record; null when the protocol cannot report it. */
  readonly firmware: string | null;
  /** Descriptor serial: always available, possibly empty. */
  readonly serial: string;
  /** From the optional identity record; null when only descriptors are available. */
  readonly profileId: string | null;
  /** From the optional identity record; null when only descriptors are available. */
  readonly channels: number | null;
  /** From the optional identity record; null when only descriptors are available. */
  readonly analogGroups: number | null;
  /** Negotiated link class from the descriptor, validated against the profile. */
  readonly linkRate: LinkRate;
  /** Null when the optional probe is unsupported by the port. */
  readonly probe: LinkProbeResult | null;
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

/** Format version of the proposed identity record below (not a stock request). */
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
 * PROPOSED identity record for a future firmware extension (all integers
 * little-endian). The stock U3 protocol has no such request; see the module
 * header. It is used only when the port implements `control()`.
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
 *   19+N+M  1     link rate code (0=fs, 1=hs, 2=ss5, 3=ss10)
 *
 * Trailing bytes are accepted because the vendor control transport rounds
 * transfers up to four bytes. Anything else is a `handshake` refusal.
 */
interface IdentityRecord {
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly firmware: string;
  readonly serial: string;
  readonly profileId: string;
  readonly channels: number;
  readonly analogGroups: number;
  readonly linkRate: LinkRate;
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

      // Post-open, pre-claim identity guard: open() selected a device, but the
      // profile is only usable when that device's descriptor carries the same
      // VID/PID (and is well formed). Refuse before taking the interface so a
      // wrong device is closed instead of claimed, then reused by the
      // handshake without a second describe() round-trip.
      const descriptor = await this.verifyOpenedDevice(epoch);

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
      await this.runHandshake(epoch, descriptor);
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

  /**
   * Identity and optional probe on an already-claimed link.
   *
   * `openedDescriptor` is the descriptor `connect()` read and identity-checked
   * between `open()` and `claim()`. Passing it avoids a second `describe()`
   * round-trip; it is re-validated here so this method stands alone.
   * `handshakeAndProbe()` passes nothing and reads a fresh descriptor, because
   * a resumed or re-probed device may have changed.
   */
  private async runHandshake(
    epoch: number,
    openedDescriptor?: LinkPortDescriptor,
  ): Promise<LinkHandshake> {
    try {
      this.validateProfile();
      this.assertEpoch(epoch);

      // The control plane is a proposed extension. Validate its probe bounds
      // only when it is actually present, so a stock device is never refused
      // for a probe it will not run.
      const control = this.port.control?.bind(this.port);
      const probeConfig = control === undefined ? null : this.resolveProbe();
      this.assertEpoch(epoch);

      // The descriptor is the required identity source: the stock device has no
      // identity register, only USB descriptors.
      const descriptor = openedDescriptor ?? await this.readDescriptor(epoch);
      this.validateDescriptor(descriptor);
      this.assertEpoch(epoch);

      let identity: IdentityRecord | null = null;
      if (control !== undefined) {
        try {
          const rawIdentity = await control({ kind: 'identity' });
          this.assertEpoch(epoch);
          identity = decodeIdentity(rawIdentity);
          this.validateIdentity(identity);
          this.assertEpoch(epoch);
        } catch (error) {
          if (!isControlUnsupported(error)) {
            throw toTransferError(error, 'identity read failed');
          }
          // The extension is absent (or this firmware does not implement it):
          // stay on descriptors rather than failing the handshake.
          identity = null;
        }
      }

      // The probe is optional for the same reason. If identity control is
      // unsupported, skip the probe instead of sending another request the
      // device cannot answer.
      let probeResult: LinkProbeResult | null = null;
      if (identity !== null && probeConfig !== null && control !== undefined) {
        try {
          probeResult = await this.runProbe(epoch, probeConfig, control);
        } catch (error) {
          if (!isControlUnsupported(error)) throw error;
          probeResult = null;
        }
      }
      this.assertEpoch(epoch);

      const handshake: LinkHandshake = Object.freeze({
        identitySource: identity === null ? 'descriptor' : 'control',
        protocol: identity === null
          ? null
          : Object.freeze({
            major: identity.protocolMajor,
            minor: identity.protocolMinor,
          }),
        firmware: identity === null ? null : identity.firmware,
        // The descriptor serial is the required source; the proposed identity
        // record's serial is not trusted over it.
        serial: descriptor.serialNumber,
        profileId: identity === null ? null : identity.profileId,
        channels: identity === null ? null : identity.channels,
        analogGroups: identity === null ? null : identity.analogGroups,
        linkRate: linkRateForClass(descriptor.linkClass),
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

  private async readDescriptor(epoch: number): Promise<LinkPortDescriptor> {
    try {
      return await this.port.describe();
    } catch (error) {
      this.assertEpoch(epoch);
      throw toTransferError(error, 'port descriptor read failed');
    }
  }

  /**
   * Post-open identity guard: read the descriptor and confirm it names the
   * profile's device before the session claims the interface. A wrong or
   * malformed descriptor is a typed refusal (`profile` or `handshake`) and the
   * port is closed unclaimed. Descriptor failures use the handshake mapping so
   * they surface as `transfer`/`lost` exactly like a handshake descriptor read.
   */
  private async verifyOpenedDevice(epoch: number): Promise<LinkPortDescriptor> {
    let descriptor: LinkPortDescriptor;
    try {
      descriptor = await this.readDescriptor(epoch);
      this.validateDeviceIdentity(descriptor);
    } catch (error) {
      throw await this.failHandshake(epoch, error);
    }
    await this.throwIfSuperseded(epoch);
    return descriptor;
  }

  private async runProbe(
    epoch: number,
    config: LinkProbeOptions,
    control: (request: LinkControlRequest) => Promise<Uint8Array>,
  ): Promise<LinkProbeResult> {
    const started = monotonicNow();
    let totalBytes = 0;

    for (let burst = 0; burst < config.bursts; ++burst) {
      let reply: Uint8Array;
      try {
        reply = await control({ kind: 'probe', bytes: config.bytes });
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
    // `firmware.min` is documentation, not a handshake gate: the stock register
    // protocol exposes no firmware version register. The shipped 32U3 value is a
    // vendor hardware S/N ("202610150528"), not a dotted version, and parsing it
    // as one would make that device permanently unreachable. Only the profile
    // schema's non-empty-string rule is checked here.
    if (typeof this.profile.firmware.min !== 'string' || this.profile.firmware.min.trim().length === 0) {
      throw new LinkError(
        'profile',
        `profile ${this.profile.id} has an empty firmware minimum`,
      );
    }
  }

  /**
   * Descriptor facts required before claiming the interface: a well-formed USB
   * identity that matches the profile's VID/PID. A mismatch is a typed
   * `profile` refusal, never a fallback that guesses. The remaining descriptor
   * checks (serial field, link class, profile requirements) run in
   * `validateDescriptor()` during the handshake.
   */
  private validateDeviceIdentity(descriptor: LinkPortDescriptor): void {
    if (!Number.isInteger(descriptor.vendorId) || descriptor.vendorId < 0 ||
      !Number.isInteger(descriptor.productId) || descriptor.productId < 0) {
      throw new LinkError('handshake', 'the port descriptor has no valid USB identity');
    }
    if (descriptor.vendorId !== this.profile.vid || descriptor.productId !== this.profile.pid) {
      throw new LinkError(
        'profile',
        `device is ${hex4(descriptor.vendorId)}:${hex4(descriptor.productId)}, ` +
        `profile ${this.profile.id} expects ${hex4(this.profile.vid)}:${hex4(this.profile.pid)}`,
      );
    }
  }

  private validateDescriptor(descriptor: LinkPortDescriptor): void {
    this.validateDeviceIdentity(descriptor);
    if (typeof descriptor.serialNumber !== 'string') {
      throw new LinkError('handshake', 'the port descriptor has no serial number field');
    }
    if (!isLinkClass(descriptor.linkClass)) {
      throw new LinkError(
        'handshake',
        `the port descriptor reports unknown link class '${String(descriptor.linkClass)}'`,
      );
    }
    const linkRate = linkRateForClass(descriptor.linkClass);
    if (!this.profile.link.rates.includes(linkRate)) {
      throw new LinkError(
        'profile',
        `device reports link class '${linkRate}', which profile ${this.profile.id} does not support`,
      );
    }
    if (this.profile.serial?.required === true && descriptor.serialNumber.length === 0) {
      throw new LinkError('profile', `profile ${this.profile.id} requires a serial number`);
    }
  }

  /**
   * Cross-check the optional identity record against the profile. This is not
   * weakened when the control plane is present: channel/profile inventory and
   * the reported rate must still agree with the profile. `firmware.min` is not
   * enforced here (see validateProfile()).
   */
  private validateIdentity(identity: IdentityRecord): void {
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
  const firmwareMajor = view.getUint16(8, true);
  const firmwareMinor = view.getUint16(10, true);
  const firmwarePatch = view.getUint16(12, true);
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
    firmware: `${firmwareMajor}.${firmwareMinor}.${firmwarePatch}`,
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
    // Historical "ss" split into its two named SuperSpeed classes. Code 3 is
    // part of the proposed extension; no stock firmware emits either.
    case 2: return 'ss5';
    case 3: return 'ss10';
    default:
      throw new LinkError('handshake', `identity reports unknown link rate code ${code}`);
  }
}

function isLinkClass(value: unknown): value is LinkClass {
  return value === 'fs' || value === 'hs' || value === 'ss5' || value === 'ss10';
}

/**
 * Map the port's negotiated link class onto the profile vocabulary. The two
 * unions currently have the same members, but this is the single mapping point:
 * the descriptor is the only rate source and profiles validate the result.
 */
function linkRateForClass(linkClass: LinkClass): LinkRate {
  switch (linkClass) {
    case 'fs': return 'fs';
    case 'hs': return 'hs';
    case 'ss5': return 'ss5';
    case 'ss10': return 'ss10';
  }
}

/** True when a control-plane extension is simply not implemented. */
function isControlUnsupported(error: unknown): boolean {
  return error instanceof LinkError && error.reason === 'unsupported';
}

function hex4(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}

function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf !== undefined && typeof perf.now === 'function') return perf.now();
  return Date.now();
}
