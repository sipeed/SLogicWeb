// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic self-test for the real WebUSB `LinkPort` adapter.
 *
 * No hardware and no browser are involved: `WebUsbPort` accepts a structural
 * `WebUsbDeviceLike`, so the fake below implements exactly the fields the
 * adapter uses plus a `reset()` method it must never call. The test covers:
 *
 *   - descriptor identity (VID/PID, origin-scoped serial, caller-supplied link
 *     class) without touching the device, and `null` serial -> `''`;
 *   - the stock protocol: the port has NO `control()` method, so a session
 *     stays on descriptor identity and never sends a fabricated identity or
 *     probe request;
 *   - open -> claim selects a configuration only when none is active, claims
 *     exactly the vendor class 0xff interface and never a neighbouring
 *     interface, and is idempotent;
 *   - release is issued at most once, is safe twice, and close is idempotent;
 *   - every WebUSB/DOMException is mapped to a typed `LinkError` (`busy`,
 *     `transfer`, `lost`, `profile`, `unsupported`, `denied`) with the original
 *     error kept only as `cause`; teardown still closes after a failure;
 *   - interface selection: explicit number, missing/non-vendor number,
 *     ambiguous vendor interfaces, vendor only on a non-default alternate, the
 *     device-level vendor-class fallback, no vendor interface, no
 *     configuration;
 *   - disconnect notification attaches after open, matches the granted device,
 *     ignores other devices, detaches on close and reattaches after reconnect;
 *   - a real `LinkSession` reaches `ready` through this port with descriptor
 *     identity and no probe, disconnects with exactly one release and one
 *     close, and a claim conflict surfaces `busy` after teardown;
 *   - `USBDevice.reset()` is never called anywhere.
 *
 * Run:
 *   node_modules/.bin/esbuild src/link/webUsbPortSelftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/webusbport-selftest.mjs \
 *     --log-level=error
 *   node /tmp/webusbport-selftest.mjs
 */

import {
  LinkError,
  LinkSession,
  type LinkClass,
  type LinkErrorReason,
  type LinkPort,
  type LinkState,
} from './linkSession.js';
import {
  WebUsbPort,
  createWebUsbPort,
  type WebUsbAlternateLike,
  type WebUsbConfigurationLike,
  type WebUsbDeviceLike,
  type WebUsbDisconnectEvent,
  type WebUsbEventSource,
  type WebUsbInterfaceLike,
} from './webUsbPort.js';
import type { DeviceProfile } from '../device/profileTypes.js';

const PROFILE: DeviceProfile = {
  id: 'slogic16u3',
  name: 'SLogic16 U3 (webUsbPort self-test)',
  vid: 0x359f,
  pid: 0x3031,
  serial: { required: true },
  link: {
    interfaceClass: 0xff,
    endpoints: { in: 2, out: null },
    maxTransferBytes: 1024 * 1024,
    rates: ['hs', 'ss5'],
    probe: { bytes: 1024, bursts: 1 },
  },
  digital: {
    maxChannels: 16,
    groups: [{ start: 0, channels: 16 }],
    widths: [4, 8, 16],
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

const DEFAULT_SERIAL = 'SN-TEST-0001';

/** A DOMException-shaped error without depending on the DOMException global. */
function domError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function alt(interfaceClass: number, alternateSetting = 0): WebUsbAlternateLike {
  return { alternateSetting, interfaceClass };
}

function iface(
  interfaceNumber: number,
  ...alternates: readonly WebUsbAlternateLike[]
): WebUsbInterfaceLike {
  const list = alternates.length > 0 ? alternates : [alt(0xff)];
  return { interfaceNumber, alternate: list[0]!, alternates: list };
}

function config(value: number, ...interfaces: readonly WebUsbInterfaceLike[]): WebUsbConfigurationLike {
  return { configurationValue: value, interfaces };
}

/** Interface 0 is the stock vendor interface; interface 1 is a decoy. */
const STOCK_CONFIG = config(1, iface(0), iface(1, alt(0x08)));

interface FakeOptions {
  readonly configurations?: readonly WebUsbConfigurationLike[];
  readonly active?: boolean;
  readonly vendorId?: number;
  readonly productId?: number;
  readonly serialNumber?: string | null;
  readonly deviceClass?: number;
}

/**
 * Structural fake of the adapter boundary. It deliberately also has `reset()`
 * (as `USBDevice` does) so the test can prove the adapter never calls it.
 */
class FakeUsbDevice implements WebUsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly deviceClass: number;
  serialNumber: string | null;
  configuration: WebUsbConfigurationLike | null;
  readonly configurations: readonly WebUsbConfigurationLike[];

  opened = false;
  readonly calls: string[] = [];
  readonly claimedInterfaces = new Set<number>();
  resetCalls = 0;

  openError: unknown = null;
  closeError: unknown = null;
  claimError: unknown = null;
  releaseError: unknown = null;
  selectConfigurationError: unknown = null;

  constructor(options: FakeOptions = {}) {
    this.configurations = options.configurations ?? [STOCK_CONFIG];
    this.configuration = (options.active ?? true) ? this.configurations[0] ?? null : null;
    this.vendorId = options.vendorId ?? PROFILE.vid;
    this.productId = options.productId ?? PROFILE.pid;
    this.deviceClass = options.deviceClass ?? 0xff;
    this.serialNumber = options.serialNumber === undefined
      ? DEFAULT_SERIAL
      : options.serialNumber;
  }

  async open(): Promise<void> {
    this.record('open');
    if (this.openError !== null) throw this.openError;
    this.opened = true;
  }

  async close(): Promise<void> {
    this.record('close');
    if (this.closeError !== null) throw this.closeError;
    this.opened = false;
    // Closing a USB device drops its interface claims.
    this.claimedInterfaces.clear();
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    this.record(`selectConfiguration:${configurationValue}`);
    if (this.selectConfigurationError !== null) throw this.selectConfigurationError;
    const match = this.configurations.find((entry) => entry.configurationValue === configurationValue);
    if (match === undefined) throw domError('NotFoundError', `no configuration ${configurationValue}`);
    this.configuration = match;
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    this.record(`claim:${interfaceNumber}`);
    if (this.claimError !== null) throw this.claimError;
    if (!this.opened) throw domError('InvalidStateError', 'device is not open');
    if (this.claimedInterfaces.has(interfaceNumber)) {
      throw domError('InvalidStateError', 'interface is already claimed');
    }
    const exists = this.configuration?.interfaces.some(
      (entry) => entry.interfaceNumber === interfaceNumber,
    ) ?? false;
    if (!exists) throw domError('NotFoundError', `no interface ${interfaceNumber}`);
    this.claimedInterfaces.add(interfaceNumber);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.record(`release:${interfaceNumber}`);
    if (this.releaseError !== null) throw this.releaseError;
    if (!this.claimedInterfaces.has(interfaceNumber)) {
      throw domError('InvalidStateError', `interface ${interfaceNumber} is not claimed`);
    }
    this.claimedInterfaces.delete(interfaceNumber);
  }

  /** Present only to catch a forbidden call; the adapter must never use it. */
  async reset(): Promise<void> {
    this.resetCalls += 1;
  }

  count(name: string): number {
    return this.calls.filter((entry) => entry === name).length;
  }

  countPrefix(prefix: string): number {
    return this.calls.filter((entry) => entry.startsWith(prefix)).length;
  }

  private record(call: string): void {
    this.calls.push(call);
  }
}

type DisconnectListener = (event: WebUsbDisconnectEvent) => void;

class FakeEventSource implements WebUsbEventSource {
  readonly listeners = new Set<DisconnectListener>();
  additions = 0;
  removals = 0;

  addEventListener(
    type: 'disconnect',
    listener: DisconnectListener,
    _options?: boolean | AddEventListenerOptions,
  ): void {
    if (type !== 'disconnect') return;
    this.additions += 1;
    this.listeners.add(listener);
  }

  removeEventListener(
    type: 'disconnect',
    listener: DisconnectListener,
    _options?: boolean | EventListenerOptions | boolean,
  ): void {
    if (type !== 'disconnect') return;
    if (this.listeners.delete(listener)) this.removals += 1;
  }

  emit(device: WebUsbDeviceLike): void {
    for (const listener of [...this.listeners]) listener({ device });
  }
}

const devices: FakeUsbDevice[] = [];

function newDevice(options: FakeOptions = {}): FakeUsbDevice {
  const device = new FakeUsbDevice(options);
  devices.push(device);
  return device;
}

function portFor(device: FakeUsbDevice, options: {
  readonly linkClass?: LinkClass;
  readonly interfaceNumber?: number;
  readonly eventSource?: WebUsbEventSource | null;
} = {}): WebUsbPort {
  return new WebUsbPort(device, {
    linkClass: options.linkClass ?? 'ss5',
    ...(options.interfaceNumber === undefined ? {} : { interfaceNumber: options.interfaceNumber }),
    eventSource: options.eventSource ?? null,
  });
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

function expectLinkErrorSync(
  name: string,
  operation: () => unknown,
  reason: LinkErrorReason,
): LinkError | null {
  try {
    operation();
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

async function main(): Promise<void> {
  console.log('== boundary and descriptor identity ==');
  {
    const missing = expectLinkErrorSync(
      'a missing granted device is unsupported',
      () => createWebUsbPort(null, { linkClass: 'ss5' }),
      'unsupported',
    );
    check('the unsupported error carries no browser exception', missing?.cause === undefined);

    const device = newDevice();
    expectLinkErrorSync(
      'an invalid link class is a profile refusal',
      () => new WebUsbPort(device, { linkClass: 'usb3' as LinkClass }),
      'profile',
    );
    expectLinkErrorSync(
      'an out-of-range interface number is a profile refusal',
      () => new WebUsbPort(device, { linkClass: 'ss5', interfaceNumber: 256 }),
      'profile',
    );

    const port = portFor(device);
    const descriptor = await port.describe();
    check('describe reports the USB VID', descriptor.vendorId === PROFILE.vid);
    check('describe reports the USB PID', descriptor.productId === PROFILE.pid);
    check('describe reports the origin-scoped serial', descriptor.serialNumber === DEFAULT_SERIAL);
    check('describe reports the caller-supplied link class', descriptor.linkClass === 'ss5');
    check('describe reads no device state beyond descriptors', device.calls.length === 0);

    const noSerial = newDevice({ serialNumber: null });
    const normalized = await portFor(noSerial, { linkClass: 'hs' }).describe();
    check('a withheld serial is normalized to the empty string', normalized.serialNumber === '');
    check('the caller-supplied class is mirrored for other classes', normalized.linkClass === 'hs');

    const linkPort: LinkPort = port;
    check(
      'the stock port implements no fabricated identity/probe control plane',
      !('control' in port) && linkPort.control === undefined,
    );
  }

  console.log('== open, claim, release, close ==');
  {
    const events = new FakeEventSource();
    const device = newDevice({ active: false });
    const port = portFor(device, { eventSource: events });

    let disconnects = 0;
    port.onDisconnect(() => { disconnects += 1; });
    check('a disconnect callback waits for open()', events.listeners.size === 0, String(events.listeners.size));

    await port.open();
    check('open opens the granted device', device.opened && device.count('open') === 1);
    check('open attaches the disconnect listener', events.listeners.size === 1, String(events.listeners.size));

    await port.claim();
    check(
      'claim selects the first configuration when none is active',
      device.count('selectConfiguration:1') === 1,
      device.calls.join(','),
    );
    check(
      'claim claims exactly the vendor interface',
      device.claimedInterfaces.size === 1 && device.claimedInterfaces.has(0),
      [...device.claimedInterfaces].join(','),
    );
    check('claim never claims the decoy interface', device.count('claim:1') === 0);

    await port.claim();
    check('claim is idempotent', device.countPrefix('claim:') === 1, String(device.countPrefix('claim:')));

    events.emit(device);
    check('a matching disconnect event reaches the callback', disconnects === 1, String(disconnects));

    await port.release();
    check('release releases the claimed interface once', device.count('release:0') === 1);
    check('release drops the local claim', device.claimedInterfaces.size === 0);
    await port.release();
    check('a second release is a no-op', device.countPrefix('release:') === 1);

    await port.close();
    check('close closes the open device', !device.opened && device.count('close') === 1);
    check('close detaches the disconnect listener', events.listeners.size === 0 && events.removals === 1);
    await port.close();
    check('close is idempotent', device.count('close') === 1, String(device.count('close')));

    events.emit(device);
    check('no disconnect callback runs after close', disconnects === 1, String(disconnects));

    await port.open();
    check('reconnect reattaches the disconnect listener', events.listeners.size === 1);
    events.emit(device);
    check('a reattached listener fires after reconnect', disconnects === 2, String(disconnects));
    events.emit(newDevice({ serialNumber: 'OTHER-DEVICE' }));
    check('a different device is ignored', disconnects === 2, String(disconnects));
    events.emit(newDevice({ serialNumber: DEFAULT_SERIAL }));
    check('the same descriptor identity matches the granted device', disconnects === 3, String(disconnects));
    await port.close();
  }

  console.log('== error mapping and teardown ==');
  {
    const device = newDevice();
    const port = portFor(device);

    const network = domError('NetworkError', 'device gone');
    device.openError = network;
    const lost = await expectLinkError('an open NetworkError is lost', port.open(), 'lost');
    check('the raw exception is kept only as the cause', lost?.cause === network);
    check('a failed open records no open state', !device.opened);

    device.openError = domError('SecurityError');
    await expectLinkError('an open SecurityError is denied', port.open(), 'denied');
    device.openError = domError('NotSupportedError');
    await expectLinkError('an unopenable device is unsupported', port.open(), 'unsupported');
    device.openError = domError('InvalidStateError');
    await expectLinkError('an open state conflict is busy', port.open(), 'busy');
    device.openError = domError('UnknownError');
    await expectLinkError('an unknown open failure is lost', port.open(), 'lost');
    device.openError = null;
  }
  {
    const device = newDevice();
    const port = portFor(device);
    await port.open();
    device.claimError = domError('InvalidStateError');
    await expectLinkError('a claim conflict is busy', port.claim(), 'busy');
    check('a refused claim records no claim', device.claimedInterfaces.size === 0);
    check('a refused claim is not released', device.countPrefix('release:') === 0);
    await port.close();
    check('teardown still closes after a refused claim', !device.opened && device.count('close') === 1);
  }
  {
    const device = newDevice();
    const port = portFor(device);
    await port.open();
    device.claimError = domError('NotFoundError');
    await expectLinkError('a missing interface at claim time is a profile refusal', port.claim(), 'profile');
    device.claimError = domError('NetworkError');
    await expectLinkError('a lost device at claim time is lost', port.claim(), 'lost');
    await port.close();
  }
  {
    const device = newDevice({ active: false });
    const port = portFor(device);
    await port.open();
    device.selectConfigurationError = domError('NetworkError');
    await expectLinkError('a lost device during configuration selection is lost', port.claim(), 'lost');
    device.selectConfigurationError = domError('SecurityError');
    await expectLinkError('a denied configuration selection is denied', port.claim(), 'denied');
    device.selectConfigurationError = domError('InvalidStateError');
    await expectLinkError('a configuration state conflict is busy', port.claim(), 'busy');
    device.selectConfigurationError = domError('TypeError');
    await expectLinkError('an unusable configuration is a profile refusal', port.claim(), 'profile');
    check('no configuration failure claims an interface', device.countPrefix('claim:') === 0);
    await port.close();
  }
  {
    const device = newDevice();
    const port = portFor(device);
    await port.open();
    await port.claim();

    const releaseFailure = domError('NetworkError', 'unplugged during release');
    device.releaseError = releaseFailure;
    const error = await expectLinkError('a release failure is lost', port.release(), 'lost');
    check('the release failure keeps its cause', error?.cause === releaseFailure);
    check('a failed release still clears the local claim', device.claimedInterfaces.size === 1);
    await port.release();
    check('a failed release is not retried', device.countPrefix('release:') === 1);
    device.releaseError = null;
    await port.close();
  }
  {
    const device = newDevice();
    const port = portFor(device);
    await port.open();
    device.closeError = domError('NetworkError', 'device gone during close');
    const closeFailure = await expectLinkError('a close failure is lost', port.close(), 'lost');
    check('the close failure keeps its cause', closeFailure?.cause instanceof Error);
    await port.close();
    check('a failed close is not retried', device.count('close') === 1, String(device.count('close')));
  }

  console.log('== interface selection ==');
  {
    const device = newDevice({ configurations: [config(1, iface(0), iface(1))] });
    const port = portFor(device, { interfaceNumber: 1 });
    await port.open();
    await port.claim();
    check('an explicit vendor interface number is claimed', device.claimedInterfaces.has(1));
    check('no other interface is claimed', device.claimedInterfaces.size === 1);
    await port.release();
    await port.close();
  }
  {
    const device = newDevice({ configurations: [config(1, iface(0), iface(1))] });
    const port = portFor(device);
    await port.open();
    await expectLinkError('ambiguous vendor interfaces are a profile refusal', port.claim(), 'profile');
    check('an ambiguous claim touches no interface', device.countPrefix('claim:') === 0);
    await port.close();
  }
  {
    const device = newDevice({ configurations: [config(1, iface(0), iface(1, alt(0x08)))] });
    const port = portFor(device, { interfaceNumber: 1 });
    await port.open();
    await expectLinkError('an explicit non-vendor interface is a profile refusal', port.claim(), 'profile');
    await port.close();
  }
  {
    const device = newDevice({ configurations: [config(1, iface(0))] });
    const port = portFor(device, { interfaceNumber: 9 });
    await port.open();
    await expectLinkError('a missing explicit interface is a profile refusal', port.claim(), 'profile');
    await port.close();
  }
  {
    const device = newDevice({
      configurations: [config(1, iface(0, alt(0x08), alt(0xff, 1)))],
    });
    const port = portFor(device);
    await port.open();
    await port.claim();
    check('vendor class on a non-default alternate is detected', device.claimedInterfaces.has(0));
    await port.release();
    await port.close();
  }
  {
    const device = newDevice({ configurations: [config(1, iface(0, alt(0x08)))], deviceClass: 0x00 });
    const port = portFor(device);
    await port.open();
    await expectLinkError('a device without a vendor interface is a profile refusal', port.claim(), 'profile');
    await port.close();
  }
  {
    const device = newDevice({
      configurations: [config(1, iface(0, alt(0x00)))],
      deviceClass: 0xff,
    });
    const port = portFor(device);
    await port.open();
    await port.claim();
    check(
      'a device-level vendor class makes its sole interface the vendor interface',
      device.claimedInterfaces.has(0),
    );
    await port.release();
    await port.close();
  }
  {
    const device = newDevice({
      configurations: [config(1, iface(0, alt(0x00)), iface(1, alt(0x00)))],
      deviceClass: 0xff,
    });
    const port = portFor(device);
    await port.open();
    await expectLinkError(
      'several classless interfaces under a vendor device are a profile refusal',
      port.claim(),
      'profile',
    );
    check('the ambiguous classless device is left unclaimed', device.countPrefix('claim:') === 0);
    await port.close();
  }
  {
    const device = newDevice({ configurations: [], active: false });
    const port = portFor(device);
    await port.open();
    await expectLinkError('a device without a configuration is a profile refusal', port.claim(), 'profile');
    check('no configuration means no selectConfiguration call', device.countPrefix('selectConfiguration:') === 0);
    await port.close();
  }

  console.log('== LinkSession integration (stock descriptor identity) ==');
  {
    const events = new FakeEventSource();
    const device = newDevice({ active: false });
    const port = portFor(device, { eventSource: events });
    const session = new LinkSession({
      port,
      profile: PROFILE,
      capabilities: { usb: true, secureContext: true },
    });

    checkState('the session starts idle', session, 'idle');
    await session.connect({ requestPermission: false });
    checkState('the session reaches ready through the real adapter', session, 'ready');

    const handshake = session.handshake;
    check('identity comes from descriptors only', handshake?.identitySource === 'descriptor');
    check('no protocol version is fabricated', handshake?.protocol === null && handshake?.firmware === null);
    check('no profile id or inventory is fabricated',
      handshake?.profileId === null && handshake?.channels === null && handshake?.analogGroups === null);
    check('no probe runs on the stock protocol', handshake?.probe === null);
    check('the descriptor serial reaches the session', handshake?.serial === DEFAULT_SERIAL);
    check('the caller-supplied link class selects the rate', handshake?.linkRate === 'ss5');
    check('the session listener is attached', events.listeners.size === 1, String(events.listeners.size));
    check('the vendor interface is claimed once', device.countPrefix('claim:') === 1);
    check('the session restored a configuration before claim', device.count('selectConfiguration:1') === 1);

    await session.disconnect('self-test done');
    checkState('disconnect closes the session', session, 'closed');
    check('disconnect releases exactly once', device.countPrefix('release:') === 1, String(device.countPrefix('release:')));
    check('disconnect closes the device exactly once', device.count('close') === 1, String(device.count('close')));
    check('disconnect leaves no interface claimed', device.claimedInterfaces.size === 0);
    check('disconnect detaches the listener', events.listeners.size === 0);
    check('the device was never reset', device.resetCalls === 0);
  }
  {
    const events = new FakeEventSource();
    const device = newDevice();
    const port = portFor(device, { eventSource: events });
    const session = new LinkSession({
      port,
      profile: PROFILE,
      capabilities: { usb: true, secureContext: true },
    });
    await session.connect({ requestPermission: false });

    events.emit(device);
    checkState('a device disconnect event moves the session to lost', session, 'lost');
    await session.disconnect('event cleanup');
    checkState('the lost session can still be closed', session, 'closed');
    check('a disconnect event releases exactly once', device.countPrefix('release:') === 1,
      String(device.countPrefix('release:')));
    check('a disconnect event closes exactly once', device.count('close') === 1,
      String(device.count('close')));
    check('a disconnect event does not reset the device', device.resetCalls === 0);
  }
  {
    const device = newDevice();
    const port = portFor(device);
    const session = new LinkSession({
      port,
      profile: PROFILE,
      capabilities: { usb: true, secureContext: true },
    });
    device.claimError = domError('InvalidStateError', 'claimed by another owner');
    await expectLinkError('a session claim conflict is busy', session.connect({ requestPermission: false }), 'busy');
    checkState('a claim conflict leaves the session busy', session, 'busy');
    check('a claim conflict releases nothing', device.countPrefix('release:') === 0);
    check('a claim conflict still closes the device', device.count('close') === 1);
    check('a claim conflict does not reset the device', device.resetCalls === 0);
    await session.disconnect('cleanup');
  }
  {
    const device = newDevice();
    const port = portFor(device, { linkClass: 'fs' });
    const session = new LinkSession({
      port,
      profile: PROFILE,
      capabilities: { usb: true, secureContext: true },
    });
    await expectLinkError('an unsupported link class is a profile refusal', session.connect({ requestPermission: false }), 'profile');
    checkState('the unsupported class leaves the session idle', session, 'idle');
    check('the unsupported class releases the claim once', device.countPrefix('release:') === 1);
    check('the unsupported class closes the device', device.count('close') === 1);
  }

  console.log('== forbidden reset ==');
  check(
    'USBDevice.reset() is never called by any adapter path',
    devices.every((device) => device.resetCalls === 0),
    devices.map((device) => device.resetCalls).join(','),
  );
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
  throw new Error('WebUSB port self-test failed and there is no process to exit');
}
