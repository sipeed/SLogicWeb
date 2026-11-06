// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic self-test for the M0 `LinkSession` state machine.
 *
 * This is a contract test, not a hardware test. It drives the session through a
 * fake `LinkPort` and checks:
 *
 *   - the stock-device path: USB descriptors (VID/PID/serial/link class) are the
 *     required identity source, and every shipped PROFILE reaches `ready` with
 *     `probe: null` and no control-plane request;
 *   - the proposed firmware-extension path: when `control()` exists and answers,
 *     the LW identity record and bounded probe are cross-checked and reported;
 *   - an `unsupported` control refusal falls back to descriptors;
 *   - `profile.firmware.min` is documentation: the shipped 32U3 hardware-S/N
 *     floor is not parsed or enforced, and an old reported firmware still ready;
 *   - descriptor/identity profile mismatches are typed `profile`/`handshake`
 *     refusals in `idle`; a VID/PID mismatch closes the device unclaimed, and
 *     later identity mismatches release the already-claimed interface;
 *   - a probe failure is `lost` and no automatic retry follows;
 *   - suspend/resume re-handshakes and a failed resume becomes `lost`;
 *   - a device disconnect event becomes `lost` and explicit disconnect closes;
 *   - a concurrent connect/handshake is refused and does not run twice;
 *   - the descriptor is read once per connect, after open() and before claim(),
 *     and a VID/PID mismatch is refused without claiming the interface.
 *
 * Timing is deterministic: the fake port never sleeps. A test that needs to
 * interleave two transitions holds `open()` with a deferred promise and
 * releases it manually; cleanup and negative retry assertions use explicit
 * microtask flushes. Probe timing is checked as an invariant of the reported
 * numbers (mean round-trip = elapsedMs / bursts), never against wall-clock
 * values.
 *
 * Run:
 *   node_modules/.bin/esbuild src/link/linkSessionSelftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/linksession-selftest.mjs \
 *     --log-level=error
 *   node /tmp/linksession-selftest.mjs
 */

import {
  LINK_IDENTITY_FORMAT,
  LINK_PROTOCOL_MAJOR,
  LINK_PROTOCOL_MINOR,
  LinkError,
  LinkSession,
  MAX_PROBE_BURSTS,
  type LinkClass,
  type LinkControlRequest,
  type LinkErrorReason,
  type LinkPort,
  type LinkPortDescriptor,
  type LinkProbeOptions,
  type LinkSessionOptions,
  type LinkState,
} from './linkSession.js';
import { PROFILES } from '../device/profiles.js';
import type { DeviceProfile, LinkRate } from '../device/profileTypes.js';

const PROFILE: DeviceProfile = {
  id: 'slogic32u3',
  name: 'SLogic32 U3 (self-test)',
  vid: 0x359f,
  pid: 0x3032,
  serial: { required: true },
  link: {
    interfaceClass: 0xff,
    endpoints: { in: 2, out: 2 },
    maxTransferBytes: 1024 * 1024,
    rates: ['hs', 'ss5', 'ss10'],
    probe: { bytes: 1024, bursts: 4 },
  },
  digital: {
    maxChannels: 32,
    groups: [{ start: 0, channels: 32 }],
    widths: [4, 8, 16, 32],
    rates: [],
    thresholdVolts: null,
    testModes: [0],
  },
  analog: {
    groups: [],
    calibration: { id: 'none', version: 1 },
  },
  trigger: {
    execution: 'device',
    digital: ['level', 'rising', 'falling', 'edge'],
    analog: [],
    mixed: false,
    preTriggerMaxPercent: 50,
    preTriggerMaxBytes: 4096,
  },
  modes: { single: true, repeat: false, loop: false, record: false },
  firmware: { min: '1.0.0' },
};

const DEFAULT_SERIAL = 'SN-202610300413';

const DEFAULT_DESCRIPTOR: LinkPortDescriptor = {
  vendorId: PROFILE.vid,
  productId: PROFILE.pid,
  serialNumber: DEFAULT_SERIAL,
  linkClass: 'ss5',
};

const DEFAULT_IDENTITY: IdentityOverrides = {
  magic: [0x4c, 0x57],
  format: LINK_IDENTITY_FORMAT,
  reserved: 0,
  protocol: [LINK_PROTOCOL_MAJOR, LINK_PROTOCOL_MINOR],
  firmware: [1, 2, 3],
  serial: DEFAULT_SERIAL,
  profileId: PROFILE.id,
  channels: PROFILE.digital.maxChannels,
  analogGroups: 0,
  linkRateCode: 2,
};

interface IdentityOverrides {
  readonly magic?: readonly [number, number];
  readonly format?: number;
  readonly reserved?: number;
  readonly protocol?: readonly [number, number];
  readonly firmware?: readonly [number, number, number];
  readonly serial?: string;
  readonly profileId?: string;
  readonly channels?: number;
  readonly analogGroups?: number;
  readonly linkRateCode?: number;
}

type ProbeFailure = 'throw-link' | 'throw-generic' | 'short' | 'unsupported';

class FakePort implements LinkPort {
  readonly calls: string[] = [];
  readonly stateAtCall: LinkState[] = [];
  session: LinkSession | null = null;
  identity = DEFAULT_IDENTITY;
  descriptor: LinkPortDescriptor = { ...DEFAULT_DESCRIPTOR };
  probeFailure: ProbeFailure | null = null;
  identityError: unknown = null;
  openError: unknown = null;
  claimError: unknown = null;
  describeError: unknown = null;
  probeBursts = 0;
  probeBytes = 0;

  /**
   * The proposed extension. `undefined` models a stock port that has no such
   * request at all; tests set it to `undefined` to exercise the descriptor-only
   * path.
   */
  control: ((request: LinkControlRequest) => Promise<Uint8Array>) | undefined;

  private disconnectCallback: (() => void) | null = null;
  /** When armed, open() stays pending until releaseOpen() resolves it. */
  private openGate: Deferred<void> | null = null;

  constructor() {
    this.control = (request) => this.handleControl(request);
  }

  /** Hold open() pending so a test can interleave another transition. */
  deferOpen(): void {
    this.openGate = deferred<void>();
  }

  /** Resolve a deferred open(); a no-op when open() is not held. */
  releaseOpen(): void {
    const gate = this.openGate;
    this.openGate = null;
    gate?.resolve();
  }

  async open(): Promise<void> {
    this.record('open');
    await this.openGate?.promise;
    if (this.openError !== null) throw this.openError;
  }

  async claim(): Promise<void> {
    this.record('claim');
    if (this.claimError !== null) throw this.claimError;
  }

  async release(): Promise<void> {
    this.record('release');
  }

  async close(): Promise<void> {
    this.record('close');
  }

  async describe(): Promise<LinkPortDescriptor> {
    this.record('describe');
    if (this.describeError !== null) throw this.describeError;
    return { ...this.descriptor };
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback;
  }

  emitDisconnect(): void {
    this.disconnectCallback?.();
  }

  count(call: string): number {
    return this.calls.filter((entry) => entry === call).length;
  }

  private async handleControl(request: LinkControlRequest): Promise<Uint8Array> {
    this.record(request.kind);
    if (request.kind === 'identity') {
      if (this.identityError !== null) throw this.identityError;
      return encodeIdentity(this.identity);
    }

    this.probeBursts += 1;
    this.probeBytes += request.bytes;
    if (this.probeFailure === 'throw-link') {
      throw new LinkError('transfer', 'simulated probe stall');
    }
    if (this.probeFailure === 'throw-generic') {
      throw new Error('simulated probe stall');
    }
    if (this.probeFailure === 'unsupported') {
      throw new LinkError('unsupported', 'probe request is not implemented');
    }
    if (this.probeFailure === 'short') {
      return new Uint8Array(Math.max(0, request.bytes - 1));
    }
    return new Uint8Array(request.bytes);
  }

  private record(call: string): void {
    this.calls.push(call);
    this.stateAtCall.push(this.session?.state ?? 'idle');
  }
}

function encodeIdentity(overrides: IdentityOverrides): Uint8Array {
  const spec = { ...DEFAULT_IDENTITY, ...overrides };
  const magic = spec.magic ?? [0x4c, 0x57];
  const protocol = spec.protocol ?? [LINK_PROTOCOL_MAJOR, LINK_PROTOCOL_MINOR];
  const firmware = spec.firmware ?? [1, 2, 3];
  const serial = ascii(spec.serial ?? DEFAULT_SERIAL);
  const profileId = ascii(spec.profileId ?? PROFILE.id);
  const bytes = new Uint8Array(15 + serial.length + 1 + profileId.length + 4);
  const view = new DataView(bytes.buffer);

  bytes[0] = magic[0] & 0xff;
  bytes[1] = magic[1] & 0xff;
  bytes[2] = (spec.format ?? LINK_IDENTITY_FORMAT) & 0xff;
  bytes[3] = (spec.reserved ?? 0) & 0xff;
  view.setUint16(4, protocol[0], true);
  view.setUint16(6, protocol[1], true);
  view.setUint16(8, firmware[0], true);
  view.setUint16(10, firmware[1], true);
  view.setUint16(12, firmware[2], true);
  bytes[14] = serial.length;
  bytes.set(serial, 15);

  let offset = 15 + serial.length;
  bytes[offset] = profileId.length;
  offset += 1;
  bytes.set(profileId, offset);
  offset += profileId.length;
  view.setUint16(offset, spec.channels ?? PROFILE.digital.maxChannels, true);
  bytes[offset + 2] = (spec.analogGroups ?? 0) & 0xff;
  bytes[offset + 3] = (spec.linkRateCode ?? 2) & 0xff;
  return bytes;
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; ++i) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) throw new Error(`self-test string is not printable ASCII: ${text}`);
    bytes[i] = code;
  }
  return bytes;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

/** A promise a test can settle by hand instead of sleeping. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Drain the microtask queue. `LinkSession` schedules no timers and the fake
 * port never sleeps, so every pending transition, cleanup and would-be retry
 * runs as a promise continuation; a bounded number of rounds settles them all.
 */
async function flushMicrotasks(rounds = 32): Promise<void> {
  for (let round = 0; round < rounds; ++round) {
    await Promise.resolve();
  }
}

/**
 * Pick a link class a shipped profile declares. Prefers the fastest named class
 * so the test tracks the profile table without hard-coding a model.
 */
function rateForProfile(profile: DeviceProfile): LinkRate {
  const preferred: readonly LinkRate[] = ['ss10', 'ss5', 'hs', 'fs'];
  for (const rate of preferred) {
    if (profile.link.rates.includes(rate)) return rate;
  }
  throw new Error(`profile ${profile.id} declares no link rate the self-test can use`);
}

function descriptorForProfile(profile: DeviceProfile): LinkPortDescriptor {
  return {
    vendorId: profile.vid,
    productId: profile.pid,
    serialNumber: `SN-${profile.id}`,
    linkClass: rateForProfile(profile),
  };
}

function linkRateCodeForClass(linkClass: LinkClass): number {
  switch (linkClass) {
    case 'fs': return 0;
    case 'hs': return 1;
    case 'ss5': return 2;
    case 'ss10': return 3;
  }
}

function identityForProfile(profile: DeviceProfile, linkClass: LinkClass): IdentityOverrides {
  return {
    ...DEFAULT_IDENTITY,
    serial: `SN-${profile.id}`,
    profileId: profile.id,
    channels: profile.digital.maxChannels,
    analogGroups: profile.analog.groups.length,
    linkRateCode: linkRateCodeForClass(linkClass),
  };
}

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
  checks += 1;
  if (condition) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail === undefined ? '' : ` - ${detail}`}`);
}

function checkState(name: string, session: LinkSession, expected: LinkState): void {
  check(name, session.state === expected, `state ${session.state}, expected ${expected}`);
}

function newSession(
  port: FakePort,
  probe?: LinkProbeOptions,
  profile: DeviceProfile = PROFILE,
): LinkSession {
  const options: LinkSessionOptions = probe === undefined
    ? { port, profile, capabilities: { usb: true, secureContext: true } }
    : { port, profile, capabilities: { usb: true, secureContext: true }, probe };
  const session = new LinkSession(options);
  port.session = session;
  return session;
}

async function expectLinkError(
  name: string,
  operation: Promise<unknown>,
  reason: LinkErrorReason,
): Promise<LinkError | null> {
  try {
    await operation;
    check(name, false, 'operation resolved');
    return null;
  } catch (error) {
    const ok = error instanceof LinkError && error.reason === reason;
    check(
      name,
      ok,
      error instanceof LinkError ? `reason ${error.reason}, expected ${reason}` : String(error),
    );
    return error instanceof LinkError ? error : null;
  }
}

async function connectFailure(
  name: string,
  overrides: IdentityOverrides,
  reason: LinkErrorReason,
  expectedState: LinkState,
  descriptorOverrides: Partial<LinkPortDescriptor> = {},
): Promise<FakePort> {
  const port = new FakePort();
  port.identity = { ...DEFAULT_IDENTITY, ...overrides };
  port.descriptor = { ...DEFAULT_DESCRIPTOR, ...descriptorOverrides };
  const session = newSession(port);
  const error = await expectLinkError(`${name}: typed reason`, session.connect(), reason);
  checkState(`${name}: state`, session, expectedState);
  check(`${name}: handshake cleared`, session.handshake === null);
  if (error !== null) {
    check(`${name}: session.error carries the failure`, session.error === error);
  }
  return port;
}

async function main(): Promise<void> {
  console.log('== every shipped profile reaches ready ==');
  for (const profile of PROFILES) {
    // Stock device: descriptors only, no proposed control plane.
    {
      const port = new FakePort();
      port.control = undefined;
      port.descriptor = descriptorForProfile(profile);
      const session = newSession(port, undefined, profile);

      checkState(`${profile.id}: stock session starts idle`, session, 'idle');
      await session.connect();
      checkState(`${profile.id}: stock device reaches ready`, session, 'ready');

      const handshake = session.handshake;
      check(`${profile.id}: descriptor-only identity source`,
        handshake?.identitySource === 'descriptor', handshake?.identitySource);
      check(`${profile.id}: firmware is unknown`, handshake?.firmware === null, String(handshake?.firmware));
      check(`${profile.id}: profile id is unknown`, handshake?.profileId === null, String(handshake?.profileId));
      check(`${profile.id}: protocol is unknown`, handshake?.protocol === null);
      check(`${profile.id}: channel inventory is unknown`, handshake?.channels === null);
      check(`${profile.id}: analog inventory is unknown`, handshake?.analogGroups === null);
      check(`${profile.id}: probe is optional and skipped`, handshake?.probe === null);
      check(`${profile.id}: serial comes from the descriptor`,
        handshake?.serial === port.descriptor.serialNumber, handshake?.serial);
      check(`${profile.id}: link rate comes from the descriptor`,
        handshake?.linkRate === port.descriptor.linkClass,
        `${String(handshake?.linkRate)} vs ${port.descriptor.linkClass}`);
      check(`${profile.id}: no extension request was sent`,
        port.count('identity') === 0 && port.count('probe') === 0,
        `identity ${port.count('identity')}, probe ${port.count('probe')}`);
      if (profile.id === 'slogic32u3') {
        check('32U3 hardware-S/N firmware floor does not gate ready',
          profile.firmware.min === '202610150528' && session.state === 'ready',
          `${profile.firmware.min} in ${session.state}`);
      }
      await session.disconnect();
    }

    // Proposed extension: the identity + probe path stays a contract test for
    // the future firmware request.
    {
      const port = new FakePort();
      port.descriptor = descriptorForProfile(profile);
      port.identity = identityForProfile(profile, port.descriptor.linkClass);
      const session = newSession(port, { bytes: 1024, bursts: 2 }, profile);

      await session.connect();
      checkState(`${profile.id}: extension device reaches ready`, session, 'ready');

      const handshake = session.handshake;
      check(`${profile.id}: control identity source`,
        handshake?.identitySource === 'control', handshake?.identitySource);
      check(`${profile.id}: firmware is reported`, handshake?.firmware === '1.2.3', String(handshake?.firmware));
      check(`${profile.id}: profile id is reported`,
        handshake?.profileId === profile.id, String(handshake?.profileId));
      check(`${profile.id}: channel inventory is reported`,
        handshake?.channels === profile.digital.maxChannels, String(handshake?.channels));
      check(`${profile.id}: analog inventory is reported`,
        handshake?.analogGroups === profile.analog.groups.length, String(handshake?.analogGroups));
      check(`${profile.id}: bounded probe ran`, handshake?.probe?.totalBytes === 2048,
        String(handshake?.probe?.totalBytes));
      await session.disconnect();
    }
  }

  console.log('== happy path with the proposed extension ==');
  {
    const port = new FakePort();
    const session = newSession(port);
    checkState('new session is idle', session, 'idle');
    check('new session has no error', session.error === null);
    check('new session has no handshake', session.handshake === null);

    await session.connect();

    checkState('connect reaches ready', session, 'ready');
    check('ready session has no error', session.error === null);
    check('selecting is the state while open() selects', port.stateAtCall[0] === 'selecting', port.stateAtCall[0]);
    check('opening is the state during the descriptor guard',
      port.stateAtCall[1] === 'opening', port.stateAtCall[1]);
    check('claiming is the state during claim()', port.stateAtCall[2] === 'claiming', port.stateAtCall[2]);
    check('handshaking is the state during identity()', port.stateAtCall[3] === 'handshaking', port.stateAtCall[3]);
    check('open is called once', port.count('open') === 1, String(port.count('open')));
    check('claim is called once', port.count('claim') === 1, String(port.count('claim')));
    check('descriptor is read once per connect', port.count('describe') === 1, String(port.count('describe')));
    check('descriptor is read before claim (post-open guard)',
      port.calls.indexOf('describe') < port.calls.indexOf('claim'), port.calls.join(','));
    check('descriptor is read before identity', port.calls.indexOf('describe') < port.calls.indexOf('identity'),
      port.calls.join(','));

    const handshake = session.handshake;
    check('handshake snapshot exists', handshake !== null);
    if (handshake !== null) {
      check('identity source is the control plane', handshake.identitySource === 'control', handshake.identitySource);
      check('protocol is stored', handshake.protocol?.major === 1 && handshake.protocol?.minor === 0);
      check('firmware is stored', handshake.firmware === '1.2.3', String(handshake.firmware));
      check('serial is stored', handshake.serial === DEFAULT_SERIAL, handshake.serial);
      check('profile id is stored', handshake.profileId === PROFILE.id, String(handshake.profileId));
      check('channel inventory is stored', handshake.channels === 32, String(handshake.channels));
      check('analog inventory is stored', handshake.analogGroups === 0, String(handshake.analogGroups));
      check('link rate is stored', handshake.linkRate === 'ss5', handshake.linkRate);
      check('probe burst size is stored', handshake.probe?.bytesPerBurst === 1024);
      check('probe burst count is stored', handshake.probe?.bursts === 4);
      check('probe moved the configured bytes', handshake.probe?.totalBytes === 4096);
      const probe = handshake.probe;
      check('probe reports a finite, non-negative elapsed time',
        probe !== null && Number.isFinite(probe.elapsedMs) && probe.elapsedMs >= 0,
        String(probe?.elapsedMs));
      check('probe latency is the mean round-trip (elapsedMs / bursts)',
        probe !== null && probe.latencyMs === probe.elapsedMs / probe.bursts,
        `${String(probe?.latencyMs)} vs ${String(probe?.elapsedMs)} / ${String(probe?.bursts)}`);
      check('probe throughput is derived from elapsed time, 0 when the clock did not advance',
        probe !== null && (probe.elapsedMs > 0
          ? probe.bytesPerSecond === probe.totalBytes / (probe.elapsedMs / 1000)
          : probe.bytesPerSecond === 0),
        String(probe?.bytesPerSecond));
    }
    check('four probe bursts ran', port.count('probe') === 4, String(port.count('probe')));

    await session.disconnect('test complete');
    checkState('disconnect closes the session', session, 'closed');
  }

  console.log('== firmware.min is documentation ==');
  {
    const port = new FakePort();
    port.identity = { ...DEFAULT_IDENTITY, firmware: [0, 9, 0] };
    const session = newSession(port);
    await session.connect();
    checkState('old reported firmware still reaches ready', session, 'ready');
    check('old firmware is reported, not enforced', session.handshake?.firmware === '0.9.0',
      String(session.handshake?.firmware));
    check('profile firmware minimum does not gate old firmware',
      PROFILE.firmware.min === '1.0.0' && session.state === 'ready');
    await session.disconnect();
  }

  console.log('== descriptor-only fallback ==');
  {
    const port = new FakePort();
    port.control = undefined;
    const session = newSession(port);
    await session.connect();
    checkState('port without a control plane reaches ready', session, 'ready');
    check('fallback identity source is the descriptor', session.handshake?.identitySource === 'descriptor',
      session.handshake?.identitySource);
    check('fallback leaves firmware unknown', session.handshake?.firmware === null);
    check('fallback leaves inventory unknown', session.handshake?.channels === null);
    check('fallback reports probe null', session.handshake?.probe === null);
    check('fallback makes no identity or probe request',
      port.count('identity') === 0 && port.count('probe') === 0,
      `identity ${port.count('identity')}, probe ${port.count('probe')}`);
    await session.disconnect();
  }
  {
    const port = new FakePort();
    port.identityError = new LinkError('unsupported', 'no identity register');
    const session = newSession(port);
    await session.connect();
    checkState('unsupported identity control falls back to descriptors', session, 'ready');
    check('unsupported fallback keeps descriptor identity', session.handshake?.identitySource === 'descriptor',
      session.handshake?.identitySource);
    check('unsupported fallback marks firmware unknown', session.handshake?.firmware === null);
    check('unsupported fallback skips the probe', session.handshake?.probe === null && port.count('probe') === 0,
      `probe ${port.count('probe')}`);
    check('identity request was attempted exactly once', port.count('identity') === 1,
      String(port.count('identity')));
    await session.disconnect();
  }
  {
    const port = new FakePort();
    port.probeFailure = 'unsupported';
    const session = newSession(port);
    await session.connect();
    checkState('unsupported probe keeps the identity handshake ready', session, 'ready');
    check('unsupported probe reports null', session.handshake?.probe === null);
    check('unsupported probe keeps the control identity', session.handshake?.identitySource === 'control',
      session.handshake?.identitySource);
    check('unsupported probe leaves firmware known', session.handshake?.firmware === '1.2.3',
      String(session.handshake?.firmware));
    await session.disconnect();
  }
  {
    const port = new FakePort();
    port.descriptor = { ...DEFAULT_DESCRIPTOR, serialNumber: 'USB-SERIAL-1' };
    port.identity = { ...DEFAULT_IDENTITY, serial: 'FIRMWARE-SERIAL-9' };
    const session = newSession(port);
    await session.connect();
    check('descriptor serial wins over the proposed identity serial',
      session.handshake?.serial === 'USB-SERIAL-1', String(session.handshake?.serial));
    await session.disconnect();
  }

  console.log('== reconnect without a permission gesture ==');
  {
    const port = new FakePort();
    const session = newSession(port);
    await session.connect({ requestPermission: false });
    checkState('reconnect reaches ready', session, 'ready');
    check('reconnect enters opening during open()', port.stateAtCall[0] === 'opening', port.stateAtCall[0]);
    await session.close();
  }

  console.log('== unsupported platform ==');
  {
    const port = new FakePort();
    const session = new LinkSession({
      port,
      profile: PROFILE,
      capabilities: { usb: false, secureContext: true },
    });
    port.session = session;
    checkState('missing WebUSB is unsupported', session, 'unsupported');
    check('unsupported has a typed reason', session.error?.reason === 'unsupported', session.error?.reason);
    await expectLinkError('connect refuses without WebUSB', session.connect(), 'unsupported');
    checkState('refusal keeps unsupported', session, 'unsupported');
    check('unsupported never touched the port', port.calls.length === 0, port.calls.join(','));

    const insecure = new LinkSession({
      port: new FakePort(),
      profile: PROFILE,
      capabilities: { usb: true, secureContext: false },
    });
    checkState('insecure context is unsupported', insecure, 'unsupported');
    check('insecure context reason', insecure.error?.reason === 'unsupported');
  }

  console.log('== claim busy ==');
  {
    const port = new FakePort();
    port.claimError = new LinkError('busy', 'another tab holds the interface');
    const session = newSession(port);
    const error = await expectLinkError('claim conflict is busy', session.connect(), 'busy');
    checkState('claim conflict state is busy', session, 'busy');
    check('busy error is recorded', session.error === error);
    check('busy keeps no handshake', session.handshake === null);
    check('busy attempt closes what it opened', port.count('claim') === 1 && port.count('close') === 1,
      `claim ${port.count('claim')}, close ${port.count('close')}`);
    check('busy attempt does not release an unclaimed interface', port.count('release') === 0,
      String(port.count('release')));

    port.claimError = null;
    await session.connect();
    checkState('explicit retry after busy reaches ready', session, 'ready');
    check('retry opens again exactly once', port.count('open') === 2, String(port.count('open')));
    await session.disconnect();
  }

  console.log('== handshake and profile refusals ==');
  {
    const port = await connectFailure(
      'descriptor VID/PID mismatch',
      {},
      'profile',
      'idle',
      { productId: 0x9999 },
    );
    check('descriptor mismatch is refused before claim', port.count('claim') === 0,
      String(port.count('claim')));
    check('descriptor mismatch releases nothing (nothing was claimed)', port.count('release') === 0,
      String(port.count('release')));
    check('descriptor mismatch closes the device', port.count('close') === 1, String(port.count('close')));
    check('descriptor mismatch sends no identity request', port.count('identity') === 0,
      String(port.count('identity')));
  }
  {
    await connectFailure(
      'descriptor link class unsupported by the profile',
      {},
      'profile',
      'idle',
      { linkClass: 'fs' },
    );
  }
  {
    await connectFailure(
      'descriptor missing required serial',
      {},
      'profile',
      'idle',
      { serialNumber: '' },
    );
  }
  {
    await connectFailure(
      'malformed descriptor link class',
      {},
      'handshake',
      'idle',
      { linkClass: 'ss20' as LinkClass },
    );
  }
  {
    const port = await connectFailure(
      'profile id mismatch',
      { profileId: 'slogic16u3' },
      'profile',
      'idle',
    );
    check('profile mismatch releases the claim', port.count('release') === 1, String(port.count('release')));
    check('profile mismatch closes the device', port.count('close') === 1, String(port.count('close')));
    check('profile mismatch does not probe', port.count('probe') === 0, String(port.count('probe')));
  }
  {
    const port = await connectFailure(
      'channel inventory mismatch',
      { channels: 16 },
      'profile',
      'idle',
    );
    check('channel mismatch is refused after identity', port.count('identity') === 1);
  }
  {
    await connectFailure(
      'analog inventory mismatch',
      { analogGroups: 1 },
      'profile',
      'idle',
    );
  }
  {
    await connectFailure(
      'unsupported reported link rate',
      { linkRateCode: 0 },
      'profile',
      'idle',
    );
  }
  {
    await connectFailure(
      'malformed identity magic',
      { magic: [0, 0] },
      'handshake',
      'idle',
    );
  }
  {
    await connectFailure(
      'incompatible protocol major',
      { protocol: [2, 0] },
      'handshake',
      'idle',
    );
  }

  console.log('== probe failure ==');
  {
    const port = new FakePort();
    port.probeFailure = 'throw-generic';
    const session = newSession(port);
    const error = await expectLinkError('probe failure is a transfer error', session.connect(), 'transfer');
    checkState('probe failure becomes lost', session, 'lost');
    check('probe failure clears the handshake', session.handshake === null);
    check('probe failure keeps the typed error', session.error === error);
    check('probe failure releases and closes', port.count('release') === 1 && port.count('close') === 1,
      `release ${port.count('release')}, close ${port.count('close')}`);
    check('failed probe stops at the first burst', port.probeBursts === 1, String(port.probeBursts));

    port.probeFailure = null;
    await session.connect();
    checkState('explicit retry after a lost probe reaches ready', session, 'ready');
    check('explicit retry re-read identity and probed again',
      port.count('identity') === 2 && port.probeBursts === 5,
      `identity ${port.count('identity')}, bursts ${port.probeBursts}`);
    await session.disconnect();
  }
  {
    const port = new FakePort();
    port.probeFailure = 'short';
    const session = newSession(port);
    await expectLinkError('short probe reply is a transfer error', session.connect(), 'transfer');
    checkState('short probe reply becomes lost', session, 'lost');
  }
  {
    const port = new FakePort();
    port.describeError = new Error('descriptor read failed');
    const session = newSession(port);
    await expectLinkError('descriptor read failure is a transfer error', session.connect(), 'transfer');
    checkState('descriptor read failure becomes lost', session, 'lost');
    check('descriptor read failure closes the unclaimed device',
      port.count('release') === 0 && port.count('close') === 1,
      `release ${port.count('release')}, close ${port.count('close')}`);
    check('descriptor read failure never claims', port.count('claim') === 0, String(port.count('claim')));
    check('descriptor read failure sends no identity request', port.count('identity') === 0);
  }

  console.log('== suspend and resume ==');
  {
    const port = new FakePort();
    const session = newSession(port);
    await session.connect();
    const firstHandshake = session.handshake;
    check('identity read once after connect', port.count('identity') === 1);

    session.suspend();
    checkState('suspend enters suspended', session, 'suspended');
    check('suspended keeps the identity for display', session.handshake === firstHandshake);
    check('suspended is not an error', session.error === null);
    await expectLinkError('connect while suspended is refused', session.connect(), 'suspended');
    checkState('refused connect keeps suspended', session, 'suspended');
    check('refused connect does not reopen the port', port.count('open') === 1, String(port.count('open')));

    await session.resume();
    checkState('resume returns to ready', session, 'ready');
    check('resume re-handshakes', port.count('identity') === 2, String(port.count('identity')));
    check('resume ran a second probe', port.probeBursts === 8, String(port.probeBursts));
    check('resume re-reads the descriptor', port.count('describe') === 2, String(port.count('describe')));

    await session.resume();
    checkState('resume on a ready link is a no-op', session, 'ready');
    check('no-op resume does not re-handshake', port.count('identity') === 2);

    session.suspend();
    port.probeFailure = 'throw-link';
    await expectLinkError('failed resume is a transfer error', session.resume(), 'transfer');
    checkState('failed resume becomes lost', session, 'lost');
    check('failed resume clears the handshake', session.handshake === null);
    check('failed resume releases and closes', port.count('release') === 1 && port.count('close') === 1,
      `release ${port.count('release')}, close ${port.count('close')}`);
  }

  console.log('== device disconnect ==');
  {
    const port = new FakePort();
    const session = newSession(port);
    await session.connect();
    port.emitDisconnect();
    checkState('disconnect event becomes lost', session, 'lost');
    check('disconnect event has a lost reason', session.error?.reason === 'lost', session.error?.reason);
    check('disconnect event clears the handshake', session.handshake === null);
    await flushMicrotasks();
    check('disconnect event releases and closes', port.count('release') === 1 && port.count('close') === 1,
      `release ${port.count('release')}, close ${port.count('close')}`);

    const callsBeforeExplicit = port.calls.length;
    await session.disconnect('after loss');
    checkState('disconnect after a loss still closes', session, 'closed');
    check('closed after loss makes no extra port calls', port.calls.length === callsBeforeExplicit,
      port.calls.slice(callsBeforeExplicit).join(','));
  }

  console.log('== explicit disconnect ==');
  {
    const port = new FakePort();
    const session = newSession(port);
    await session.connect();
    await session.disconnect('user chose disconnect');
    checkState('explicit disconnect is closed', session, 'closed');
    check('explicit disconnect has no error', session.error === null);
    check('explicit disconnect clears the handshake', session.handshake === null);
    check('explicit disconnect keeps its reason', session.closeReason === 'user chose disconnect');
    check('explicit disconnect releases then closes', port.count('release') === 1 && port.count('close') === 1,
      `release ${port.count('release')}, close ${port.count('close')}`);

    const callsBeforeClose = port.calls.length;
    await session.close();
    check('close is idempotent', port.calls.length === callsBeforeClose, port.calls.slice(callsBeforeClose).join(','));
  }

  console.log('== no unbounded retry ==');
  {
    const port = new FakePort();
    port.probeFailure = 'throw-link';
    const session = newSession(port);
    await expectLinkError('initial attempt fails', session.connect(), 'transfer');
    const calls = port.calls.slice();

    // LinkSession owns no timer: a failed attempt publishes `lost` and stops.
    // Draining the microtask queue settles every continuation it could have
    // queued, so any retry would already appear in `calls`.
    await flushMicrotasks();
    check('no retry fires after a failed attempt',
      calls.length === port.calls.length && calls.every((call, index) => port.calls[index] === call),
      `before ${calls.join(',')} after ${port.calls.join(',')}`);
    checkState('failed attempt stays lost while idle', session, 'lost');
    check('one open, one claim, one describe, one identity, one probe',
      port.count('open') === 1 && port.count('claim') === 1 &&
      port.count('describe') === 1 && port.count('identity') === 1 && port.count('probe') === 1,
      `open ${port.count('open')}, claim ${port.count('claim')}, describe ${port.count('describe')}, ` +
      `identity ${port.count('identity')}, probe ${port.count('probe')}`);
  }

  console.log('== concurrent operations ==');
  {
    const port = new FakePort();
    const session = newSession(port);
    const first = session.connect();
    const second = session.connect();
    await expectLinkError('second concurrent connect is busy', second, 'busy');
    await first;
    checkState('first connect still reaches ready', session, 'ready');
    check('concurrent refusal does not open twice', port.count('open') === 1, String(port.count('open')));
    await session.disconnect();
  }
  {
    const port = new FakePort();
    const session = newSession(port);
    const connecting = session.connect();
    await expectLinkError('handshake during connect is busy', session.handshakeAndProbe(), 'busy');
    await connecting;
    checkState('connect survives a refused concurrent handshake', session, 'ready');
    check('identity is read once', port.count('identity') === 1, String(port.count('identity')));
    await session.disconnect();
  }

  console.log('== bounded probe configuration ==');
  {
    const port = new FakePort();
    const session = newSession(port, { bytes: 0, bursts: 1 });
    await expectLinkError('zero probe bytes is a profile refusal', session.connect(), 'profile');
    checkState('invalid probe config leaves idle', session, 'idle');
    check('invalid probe config never reads identity', port.count('identity') === 0, String(port.count('identity')));
    check('invalid probe config never probes', port.count('probe') === 0, String(port.count('probe')));
    check('invalid probe config releases the claim', port.count('release') === 1);
  }
  {
    const port = new FakePort();
    const session = newSession(port, { bytes: 1024, bursts: MAX_PROBE_BURSTS + 1 });
    await expectLinkError('too many probe bursts is a profile refusal', session.connect(), 'profile');
    check('too many bursts never probes', port.count('probe') === 0, String(port.count('probe')));
  }

  console.log('== open failure mapping ==');
  {
    const port = new FakePort();
    const denied = new Error('blocked by policy');
    denied.name = 'SecurityError';
    port.openError = denied;
    const session = newSession(port);
    await expectLinkError('open SecurityError is denied', session.connect(), 'denied');
    checkState('denied open leaves idle', session, 'idle');
    check('denied open still closes the port', port.count('close') === 1, String(port.count('close')));
  }

  console.log('== disconnect racing open ==');
  {
    const port = new FakePort();
    port.deferOpen();
    const session = newSession(port);
    const connecting = session.connect();
    await flushMicrotasks();

    checkState('connect waits in selecting while open() is held', session, 'selecting');
    check('nothing is claimed while open() is held', port.count('claim') === 0, String(port.count('claim')));

    const closing = session.disconnect('user cancelled');
    await flushMicrotasks();
    checkState('disconnect during a pending open leaves closed', session, 'closed');
    check('disconnect closes the device while open() is still pending',
      port.count('close') === 1, String(port.count('close')));
    check('disconnect during a pending open never claims', port.count('claim') === 0,
      String(port.count('claim')));

    port.releaseOpen();
    await expectLinkError('connect superseded by disconnect fails lost', connecting, 'lost');
    await closing;
    checkState('racing disconnect leaves closed', session, 'closed');
    check('the later open is closed again, never claimed',
      port.count('claim') === 0 && port.count('close') >= 2,
      `claim ${port.count('claim')}, close ${port.count('close')}`);
  }
}

main().then(() => {
  console.log('');
  if (failures > 0) {
    console.error(`FAILED ${failures} of ${checks} checks`);
    exitOne();
    return;
  }
  console.log(`PASS all ${checks} checks`);
}).catch((error: unknown) => {
  console.error('FAIL selftest crashed:', error);
  exitOne();
});

interface NodeProcess {
  exit?: (code?: number) => never;
  exitCode?: number;
}

function exitOne(): void {
  const proc = (globalThis as { process?: NodeProcess }).process;
  if (proc?.exit !== undefined) {
    proc.exit(1);
    return;
  }
  if (proc !== undefined) {
    proc.exitCode = 1;
    return;
  }
  throw new Error('LinkSession self-test failed and there is no process to exit');
}
