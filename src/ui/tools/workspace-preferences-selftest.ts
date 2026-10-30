import {
  analyzerStatesFrom, MAX_PERSISTED_ANALYZERS, nextAnalyzerSequence, parseWorkspaceSnapshot,
  readWorkspaceSnapshot, serializeWorkspaceSnapshot,
  WORKSPACE_SCHEMA_VERSION, WORKSPACE_STORAGE_KEY, writeWorkspaceSnapshot,
  type PersistedAnalyzer, type WorkspaceSnapshotV1,
} from '../workspacePreferences.js';
import {
  analyzerColor, analyzerLaneChannel, defaultCaptureSettings, defaultChannelName, defaultChannels,
  modesToConditions, THRESHOLD_VOLT_OPTIONS,
} from '../state.js';
import { busChannelBank } from '../channelBanks.js';
import type { BusViewConfig } from '../busView.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const process = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!process || typeof process.exit !== 'function') throw new Error('this entry point only runs under node');
  return process;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function defineStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
}

check('workspace storage uses the exact logicweb.workspace key and schema version 1',
  WORKSPACE_STORAGE_KEY === 'logicweb.workspace' && WORKSPACE_SCHEMA_VERSION === 1,
  `${WORKSPACE_STORAGE_KEY} / ${WORKSPACE_SCHEMA_VERSION}`);

const rejected = [null, '', '{', 'null', '[]', '1', '"text"',
  '{"version":0,"detailedLabels":false}', '{"version":2,"detailedLabels":false}',
  '{"version":"1","detailedLabels":false}', '{"detailedLabels":false}',
];
check('absent, malformed, non-object and unsupported-version input yields no snapshot',
  rejected.every((raw) => parseWorkspaceSnapshot(raw) === null),
  `${rejected.length} negative controls`);

const wrongLabelTypes = ['false', 0, null, {}, []].map((detailedLabels) =>
  JSON.stringify({ version: 1, detailedLabels }));
check('non-boolean detailedLabels values independently fall back to default on',
  wrongLabelTypes.every((raw) => parseWorkspaceSnapshot(raw)?.detailedLabels === true),
  `${wrongLabelTypes.length} field controls`);

const falseSnapshot = parseWorkspaceSnapshot('{"version":1,"detailedLabels":false}');
const trueSnapshot = parseWorkspaceSnapshot('{"version":1,"detailedLabels":true}');
check('literal false and true survive parsing without coercion',
  falseSnapshot?.detailedLabels === false && trueSnapshot?.detailedLabels === true,
  JSON.stringify([falseSnapshot, trueSnapshot]));

{
  const data = new Map<string, string>();
  const calls: string[] = [];
  defineStorage({
    getItem: (key: string) => {
      calls.push(`get:${key}`);
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      calls.push(`set:${key}:${value}`);
      data.set(key, value);
    },
  });
  const absent = readWorkspaceSnapshot();
  const offWrite = writeWorkspaceSnapshot({ version: 1, detailedLabels: false });
  const offRead = readWorkspaceSnapshot();
  const onWrite = writeWorkspaceSnapshot({ version: 1, detailedLabels: true });
  const onRead = readWorkspaceSnapshot();
  check('guarded storage round-trips both label preferences under the exact key',
    absent === null && offWrite && onWrite && offRead?.detailedLabels === false &&
    onRead?.detailedLabels === true &&
    data.get(WORKSPACE_STORAGE_KEY) === '{"version":1,"detailedLabels":true,"analyzers":[]}' &&
    calls.every((call) => call.includes(WORKSPACE_STORAGE_KEY)),
    calls.join(' | '));
}

{
  const crafted: WorkspaceSnapshotV1 & { runtime: { samples: number } } = {
    version: 1,
    detailedLabels: false,
    runtime: { samples: 42 },
  };
  const serialized = serializeWorkspaceSnapshot(crafted);
  check('serialization emits only the versioned preference whitelist',
    serialized === '{"version":1,"detailedLabels":false,"analyzers":[]}' &&
    !serialized.includes('runtime') && !serialized.includes('samples'),
    serialized);
}

{
  defineStorage({
    getItem: () => { throw new Error('blocked read'); },
    setItem: () => { throw new Error('blocked write'); },
  });
  let readThrew = false;
  let writeThrew = false;
  let restored: WorkspaceSnapshotV1 | null = null;
  let wrote = true;
  try { restored = readWorkspaceSnapshot(); } catch { readThrew = true; }
  try { wrote = writeWorkspaceSnapshot({ version: 1, detailedLabels: false }); } catch { writeThrew = true; }
  check('throwing getItem and setItem degrade to null/false without escaping',
    !readThrew && !writeThrew && restored === null && wrote === false,
    `readThrew=${readThrew}, writeThrew=${writeThrew}, restored=${restored}, wrote=${wrote}`);
}

{
  Object.defineProperty(globalThis, 'localStorage', {
    get: () => { throw new Error('blocked storage getter'); },
    configurable: true,
  });
  let readThrew = false;
  let writeThrew = false;
  let restored: WorkspaceSnapshotV1 | null = null;
  let wrote = true;
  try { restored = readWorkspaceSnapshot(); } catch { readThrew = true; }
  try { wrote = writeWorkspaceSnapshot({ version: 1, detailedLabels: true }); } catch { writeThrew = true; }
  check('a throwing localStorage getter is also non-fatal',
    !readThrew && !writeThrew && restored === null && wrote === false,
    `readThrew=${readThrew}, writeThrew=${writeThrew}, restored=${restored}, wrote=${wrote}`);
  defineStorage(undefined);
  check('missing browser storage is node-safe and non-fatal',
    readWorkspaceSnapshot() === null && !writeWorkspaceSnapshot({ version: 1, detailedLabels: true }),
    'undefined storage');
}

{
  const first = defaultCaptureSettings();
  const second = defaultCaptureSettings();
  const defaultsMatch = first.channels === 16 && first.samplerate === 16e6 &&
    first.thresholdVolts === 1.2 && first.mode === 'timer' && first.seconds === 1 &&
    first.loopSamples === 16_000_000 && first.testMode === 0 && !first.triggerEnableMask &&
    !first.softwareTrigger && first.triggerChannel === 0 && first.triggerKind === 'rising' &&
    first.triggerLevel === 1 && first.preTriggerPercent === 10;
  first.triggerModes[0] = 'high';
  first.triggerConditions.push({ channel: 0, kind: 'level', level: 1 });
  check('default capture settings preserve shipping values and allocate independent nested state',
    defaultsMatch && Object.keys(second.triggerModes).length === 0 && second.triggerConditions.length === 0 &&
    THRESHOLD_VOLT_OPTIONS.join(',') === '0.6,0.9,1.2,1.5,1.65,1.8,2.5,3.3',
    JSON.stringify(second));
}

for (const capacity of [4, 8, 16, 32, 64, 128] as const) {
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    channels: Array.from({ length: capacity }, () => ({})),
  }));
  check(`supported ${capacity}-channel capacity restores with a complete natural order`,
    parsed?.channels?.length === capacity && parsed.order?.length === capacity &&
    parsed.order.every((index, i) => index === i) && parsed.channels.every((channel, i) =>
      channel.name === defaultChannelName(i) && channel.enabled),
    `capacity=${capacity}, order=${parsed?.order?.length}`);
}

{
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    channels: [
      { name: '  Alpha  ', color: '#A1b2C3', enabled: false },
      { name: '   ', color: 'red', enabled: 'false' },
      null,
      { name: 'D4', color: '#123456', enabled: true },
    ],
    order: [0, 0, 99, -1, 1.5, 2],
  }));
  const defaults = defaultChannels(4);
  check('channel fields sanitize independently and order becomes a first-unique complete permutation',
    parsed?.channels?.[0]?.name === 'Alpha' && parsed.channels[0].color === '#A1b2C3' &&
    !parsed.channels[0].enabled && parsed.channels[1]?.name === defaultChannelName(1) &&
    parsed.channels[1].color === defaults[1]!.color && parsed.channels[1].enabled &&
    parsed.channels[2]?.name === defaultChannelName(2) && parsed.channels[2]?.color === defaults[2]!.color &&
    parsed.channels[3]?.name === 'D4' && parsed.channels[3]?.color === '#123456' &&
    JSON.stringify(parsed.order) === '[0,2,1,3]',
    JSON.stringify(parsed));
}

{
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    channels: Array.from({ length: 8 }, () => ({ enabled: false })),
    order: [7, 7, 3],
  }));
  check('all-disabled input restores one safe enabled channel without losing absolute order repair',
    parsed?.channels?.[0]?.enabled === true && parsed.channels.slice(1).every((channel) => !channel.enabled) &&
    JSON.stringify(parsed.order) === '[7,3,0,1,2,4,5,6]',
    JSON.stringify(parsed));
}

{
  const invalidCapacities = [[], Array(3).fill(null), Array(5).fill(null), Array(1000).fill(null), { length: 4 }, null];
  const bounded = invalidCapacities.every((channels) => {
    const parsed = parseWorkspaceSnapshot(JSON.stringify({ version: 1, channels }));
    return parsed?.channels?.length === 16 && parsed.order?.length === 16;
  });
  const explicitFallback = parseWorkspaceSnapshot(JSON.stringify({ version: 1, channels: [] }), 4);
  check('invalid or excessive channel capacities use the bounded factory fallback',
    bounded && explicitFallback?.channels?.length === 4 && explicitFallback.order?.join(',') === '0,1,2,3',
    `${invalidCapacities.length} invalid shapes + explicit fallback`);
}

{
  const data = new Map<string, string>();
  defineStorage({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  });
  const channels = defaultChannels(32).map(({ name, color, enabled }, index) => ({
    name: index === 31 ? 'Upper clock' : name,
    color: index === 31 ? '#ABCDEF' : color,
    enabled: index % 3 === 0 ? enabled : false,
  }));
  const order = Array.from({ length: 32 }, (_, index) => 31 - index);
  const wrote = writeWorkspaceSnapshot({ version: 1, detailedLabels: false, channels, order });
  const restored = readWorkspaceSnapshot();
  check('32-channel custom upper identity, selection and reversed absolute order round-trip',
    wrote && restored?.channels?.length === 32 && restored.channels[31]?.name === 'Upper clock' &&
    restored.channels[31].color === '#ABCDEF' && restored.channels[31].enabled === false &&
    restored.channels[0]?.enabled === true && restored.order?.[0] === 31 && restored.order[31] === 0,
    JSON.stringify({ wrote, upper: restored?.channels?.[31], order: restored?.order }));
}

{
  const channel = { name: 'D0', color: '#010203', enabled: true, index: 0 };
  const serialized = serializeWorkspaceSnapshot({
    version: 1,
    detailedLabels: true,
    channels: [channel],
    order: [0],
  });
  check('channel serialization keeps array identity but excludes derived index/runtime fields',
    serialized === '{"version":1,"detailedLabels":true,"channels":[{"name":"D0","color":"#010203","enabled":true}],"order":[0],"analyzers":[]}',
    serialized);
}

{
  const capture = {
    samplerate: 25e6,
    thresholdVolts: 1.65,
    mode: 'free' as const,
    seconds: 2.5,
    loopSamples: 123_456,
    testMode: 2 as const,
    triggerEnableMask: true,
    triggerModes: { 0: 'rising' as const, 3: 'dont-care' as const, 7: 'high' as const },
    preTriggerPercent: 35,
  };
  const parsed = parseWorkspaceSnapshot(serializeWorkspaceSnapshot({
    version: 1,
    detailedLabels: true,
    capture,
  }));
  check('every canonical capture/trigger field round-trips with deterministic trigger-key ordering',
    JSON.stringify(parsed?.capture) === JSON.stringify(capture),
    JSON.stringify(parsed?.capture));
}

{
  const base = {
    samplerate: 25e6,
    thresholdVolts: 1.65,
    mode: 'free' as const,
    seconds: 2.5,
    loopSamples: 123_456,
    testMode: 2 as const,
    triggerEnableMask: true,
    triggerModes: { 0: 'rising' as const },
    preTriggerPercent: 35,
  };
  const explicit = serializeWorkspaceSnapshot({
    version: 1,
    detailedLabels: true,
    capture: { ...base, samplerateExplicit: true },
  });
  const parsedExplicit = parseWorkspaceSnapshot(explicit);
  check('an explicit capture rate marker round-trips as true directly after samplerate',
    parsedExplicit?.capture?.samplerateExplicit === true &&
    explicit.includes('"samplerate":25000000,"samplerateExplicit":true'),
    explicit);
  const absent = serializeWorkspaceSnapshot({ version: 1, detailedLabels: true, capture: base });
  const explicitFalse = serializeWorkspaceSnapshot({
    version: 1,
    detailedLabels: true,
    capture: { ...base, samplerateExplicit: false },
  });
  check('absent and explicit false capture rate markers serialize without the key',
    !absent.includes('samplerateExplicit') && !explicitFalse.includes('samplerateExplicit'),
    `${absent} | ${explicitFalse}`);
}

{
  const dirty = ['yes', 1, null, [], {}];
  const rows = dirty.map((samplerateExplicit) => {
    const parsed = parseWorkspaceSnapshot(JSON.stringify({ version: 1, capture: { samplerateExplicit } }));
    const capture = parsed?.capture;
    const serialized = capture === undefined
      ? 'missing capture'
      : serializeWorkspaceSnapshot({ version: 1, detailedLabels: true, capture });
    return { value: samplerateExplicit, flag: capture?.samplerateExplicit, serialized };
  });
  check('dirty capture rate markers never restore or serialize as explicit',
    rows.every((row) => row.serialized !== 'missing capture' && row.flag !== true &&
      !row.serialized.includes('samplerateExplicit')),
    rows.map((row) => `${JSON.stringify(row.value)}=>${String(row.flag)}`).join(', '));
}

{
  const legacy = '{"version":1,"channels":[{},{}],"capture":{"samplerate":16000000,' +
    '"thresholdVolts":1.2,"mode":"timer","seconds":1,"loopSamples":16000000,"testMode":0,' +
    '"triggerEnableMask":false,"triggerModes":{},"preTriggerPercent":10}}';
  let threw = false;
  let parsed: WorkspaceSnapshotV1 | null = null;
  try { parsed = parseWorkspaceSnapshot(legacy); } catch { threw = true; }
  const capture = parsed?.capture;
  const serialized = capture === undefined
    ? ''
    : serializeWorkspaceSnapshot({ version: 1, detailedLabels: true, capture });
  check('legacy capture payload without the marker parses as not explicit and stays key-free',
    !threw && capture?.samplerate === 16e6 && capture?.samplerateExplicit !== true &&
    serialized.includes('"samplerate":16000000') && !serialized.includes('samplerateExplicit'),
    `threw=${threw}, capture=${JSON.stringify(capture)}`);
}

{
  const base = {
    samplerate: 25e6,
    thresholdVolts: 1.65,
    mode: 'free' as const,
    seconds: 2.5,
    loopSamples: 123_456,
    testMode: 2 as const,
    triggerEnableMask: true,
    triggerModes: { 0: 'rising' as const },
    preTriggerPercent: 35,
  };
  const explicit = serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, capture: { ...base, channels: 8 as const, widthExplicit: true },
  });
  const parsedWidth = parseWorkspaceSnapshot(explicit);
  check('an explicit capture width pins its tier and survives a round trip',
    parsedWidth?.capture?.channels === 8 && parsedWidth?.capture?.widthExplicit === true &&
    explicit.includes('"channels":8,"widthExplicit":true'),
    explicit);

  const absent = serializeWorkspaceSnapshot({ version: 1, detailedLabels: true, capture: base });
  const falseFlag = serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, capture: { ...base, channels: 16, widthExplicit: false },
  });
  check('an absent width and a false width marker serialize without widthExplicit',
    !absent.includes('"channels"') && !falseFlag.includes('widthExplicit') &&
    falseFlag.includes('"channels":16'),
    `${absent} | ${falseFlag}`);

  const capacity = Array.from({ length: 16 }, () => ({}));
  const dirtyWidths: unknown[] = [7, 64, 0, '16', null, 16.5];
  const widthRows = dirtyWidths.map((channels) => {
    const dirty = parseWorkspaceSnapshot(JSON.stringify({ version: 1, channels: capacity, capture: { channels } }));
    return { channels, width: dirty?.capture?.channels };
  });
  const overCapacity = parseWorkspaceSnapshot(JSON.stringify({
    version: 1, channels: capacity, capture: { channels: 32 },
  }));
  check('widths outside the storage tiers or past the channel capacity never restore',
    widthRows.every((row) => row.width === undefined) && overCapacity?.capture?.channels === undefined,
    widthRows.map((row) => `${JSON.stringify(row.channels)}=>${String(row.width)}`).join(', ') +
    `, 32of16=>${String(overCapacity?.capture?.channels)}`);

  const dirtyFlags: unknown[] = ['yes', 1, null, [], {}];
  const flagRows = dirtyFlags.map((widthExplicit) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1, capture: { channels: 16, widthExplicit },
  })));
  check('a dirty width marker never restores as explicit',
    flagRows.every((snapshot) => snapshot?.capture?.widthExplicit !== true),
    dirtyFlags.map((flag) => JSON.stringify(flag)).join(', '));
}

{
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    capture: {
      samplerate: 123_456,
      thresholdVolts: 1.3,
      mode: 'invalid',
      testMode: 9,
      triggerEnableMask: 'true',
      seconds: '2',
      loopSamples: null,
      preTriggerPercent: null,
    },
  }));
  const defaults = defaultCaptureSettings();
  check('unsupported capture scalars independently fall back to factory defaults',
    parsed?.capture?.samplerate === defaults.samplerate &&
    parsed.capture.thresholdVolts === defaults.thresholdVolts && parsed.capture.mode === defaults.mode &&
    parsed.capture.testMode === defaults.testMode &&
    parsed.capture.triggerEnableMask === defaults.triggerEnableMask &&
    parsed.capture.seconds === defaults.seconds && parsed.capture.loopSamples === defaults.loopSamples &&
    parsed.capture.preTriggerPercent === defaults.preTriggerPercent,
    JSON.stringify(parsed?.capture));
}

{
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    channels: Array.from({ length: 4 }, () => ({})),
    capture: {
      triggerModes: {
        0: 'rising', 1: 'invalid', 2: 'high', 4: 'edge', '-1': 'low', '01': 'falling', x: 'edge',
      },
    },
  }));
  check('invalid trigger channel keys and modes are dropped without creating conditions',
    JSON.stringify(parsed?.capture?.triggerModes) === '{"0":"rising","2":"high"}' &&
    modesToConditions(parsed?.capture?.triggerModes ?? {}).length === 2,
    JSON.stringify(parsed?.capture?.triggerModes));
}

{
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    capture: {
      samplerate: 25e6,
      triggerEnableMask: false,
      triggerModes: { 0: 'rising' },
      channels: 128,
      softwareTrigger: true,
      triggerConditions: [{ channel: 99, kind: 'edge', level: 1 }],
      triggerChannel: 99,
      triggerKind: 'edge',
      triggerLevel: 0,
      samples: 1000,
      analyzers: ['uart'],
    },
  }));
  const capture = parsed?.capture;
  if (!capture) throw new Error('capture did not parse');
  const derivedAbsent = capture && !('channels' in capture) && !('softwareTrigger' in capture) &&
    !('triggerConditions' in capture) && !('triggerChannel' in capture) && !('triggerKind' in capture) &&
    !('triggerLevel' in capture) && !('samples' in capture) && !('analyzers' in capture);
  const serialized = serializeWorkspaceSnapshot({ version: 1, detailedLabels: true, capture });
  check('crafted derived capture/runtime fields are neither restored nor serialized',
    derivedAbsent && !serialized.includes('softwareTrigger') && !serialized.includes('triggerConditions') &&
    !serialized.includes('triggerChannel') && !serialized.includes('samples') &&
    !serialized.includes('uart') && serialized.includes('"analyzers":[]'),
    serialized);
}

{
  const generic: BusViewConfig = {
    name: ' ADC custom ',
    spec: { bits: [3, 1], clock: null, encoding: 'twos' },
    color: '#010203',
    fullScaleV: 5,
    offsetV: -1,
    style: 'step',
    heightCss: 240,
    hideSources: true,
  };
  const active: BusViewConfig = {
    name: 'Forme d’onde analogique',
    usesDefaultName: true,
    spec: { bits: [15, 14, 13, 12, 11, 10, 9, 8], clock: { channel: 4, edge: 'falling' }, encoding: 'offset' },
    color: '#112233',
    fullScaleV: null,
    offsetV: 0.5,
    style: 'line',
    heightCss: 160,
    hideSources: false,
  };
  const disabled: BusViewConfig = {
    name: 'Disabled scope',
    spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' },
    color: '#445566',
    fullScaleV: 3.3,
    offsetV: 0.25,
    style: 'step',
    heightCss: 120,
    hideSources: true,
  };
  const parsed = parseWorkspaceSnapshot(serializeWorkspaceSnapshot({
    version: 1,
    detailedLabels: true,
    channels: defaultChannels(16),
    busViews: [generic, active],
    bankBusDrafts: { 0: disabled, 8: { ...active, name: 'Conflicting draft' } },
  }));
  check('generic/bank configs and disabled drafts round-trip with active-view conflict resolution',
    parsed?.busViews?.length === 2 && parsed.busViews[0]?.name === 'ADC custom' &&
    !('usesDefaultName' in (parsed.busViews[0] ?? {})) && parsed.busViews[0]?.style === 'step' &&
    parsed.busViews[0]?.heightCss === 240 && parsed.busViews[0]?.hideSources === true &&
    parsed.busViews[1]?.name === 'Analog waveform' && parsed.busViews[1]?.usesDefaultName === true &&
    parsed.busViews[1]?.spec.bits.join(',') === '15,14,13,12,11,10,9,8' &&
    parsed.busViews[1]?.spec.clock?.channel === 4 && parsed.busViews[1]?.spec.clock.edge === 'falling' &&
    parsed.bankBusDrafts?.[0]?.name === 'Disabled scope' &&
    parsed.bankBusDrafts[0]?.fullScaleV === 3.3 && parsed.bankBusDrafts[0]?.offsetV === 0.25 &&
    parsed.bankBusDrafts[0]?.hideSources === true && parsed.bankBusDrafts[8]?.name === 'Analog waveform',
    JSON.stringify({ views: parsed?.busViews, drafts: parsed?.bankBusDrafts }));
}

{
  const base: BusViewConfig = {
    name: 'Bank',
    spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' },
    color: '#4C9AFF',
    fullScaleV: null,
    offsetV: 0,
    style: 'line',
    heightCss: 120,
    hideSources: false,
  };
  const duplicate = { ...base, spec: { ...base.spec, bits: [0, 0, 1, 2, 3, 4, 5, 6] } };
  const badClock = { ...base, spec: { ...base.spec, clock: { channel: 3, edge: 'rising' as const } } };
  const badEncoding = { ...base, spec: { ...base.spec, encoding: 'invalid' } };
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    channels: Array.from({ length: 16 }, () => ({})),
    busViews: [duplicate, badClock, badEncoding, base],
    bankBusDrafts: {
      0: { ...base, spec: { ...base.spec, bits: [1, 2, 3, 4, 5, 6, 7, 8] } },
      8: badClock,
      9: base,
    },
  }));
  check('duplicate/foreign bits, invalid clocks/encodings and unaligned draft keys cannot create active banks or drafts',
    parsed?.busViews?.length === 1 && busChannelBank(parsed.busViews[0]!.spec) === 0 &&
    Object.keys(parsed.bankBusDrafts ?? {}).join(',') === '0',
    JSON.stringify({ views: parsed?.busViews, drafts: parsed?.bankBusDrafts }));
}

{
  const runtimeConfig = {
    name: 'Runtime',
    spec: { bits: [0], clock: null, encoding: 'unsigned' as const },
    color: '#4C9AFF',
    fullScaleV: null,
    offsetV: 0,
    style: 'line' as const,
    heightCss: 120,
    hideSources: false,
    id: 'bus-crafted',
    builder: { done: true },
    builtFor: {},
    cache: { key: 'crafted' },
  };
  const serialized = serializeWorkspaceSnapshot({
    version: 1,
    detailedLabels: true,
    busViews: [runtimeConfig],
    bankBusDrafts: {},
  });
  check('bus runtime IDs/builders/stores/caches and analyzer runtime fields never serialize',
    !serialized.includes('bus-crafted') && !serialized.includes('builder') && !serialized.includes('builtFor') &&
    !serialized.includes('cache') && !serialized.includes('samples') &&
    serialized.endsWith('"analyzers":[]}') && !serialized.includes('"result"') &&
    !serialized.includes('"status"') && !serialized.includes('"note"'),
    serialized);
}

{
  const analyzers: PersistedAnalyzer[] = [
    {
      id: 'i2c-0',
      decoderId: 'i2c',
      label: 'I2C',
      color: '#9A7B2E',
      channels: { 0: 3, 1: 4, 2: -1 },
      options: { address_format: 'unshifted', address: 72, bitrate: 100000 },
      laneChannel: 4,
    },
    {
      id: 'spi-1',
      decoderId: 'spi',
      label: 'SPI',
      color: '#A8504E',
      channels: { 0: 6, 1: 7 },
      options: {},
      laneChannel: 7,
    },
  ];
  const parsed = parseWorkspaceSnapshot(serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, analyzers,
  }))?.analyzers ?? [];
  const [i2c, spi] = parsed;
  check('legal analyzer mounts round-trip with unassigned channels and per-instance identities',
    parsed.length === 2 && i2c?.id === 'i2c-0' && i2c.decoderId === 'i2c' && i2c.label === 'I2C' &&
    i2c.color === '#9A7B2E' && JSON.stringify(i2c.channels) === '{"0":3,"1":4,"2":-1}' &&
    i2c.options.address === 72 && i2c.options.address_format === 'unshifted' && i2c.options.bitrate === 100000 &&
    i2c.laneChannel === 4 && spi?.id === 'spi-1' && spi.decoderId === 'spi' && spi.laneChannel === 7,
    JSON.stringify(parsed));
}

{
  const legacy = parseWorkspaceSnapshot('{"version":1,"detailedLabels":true}');
  const nonArray = [null, 'i2c', 1, {}, true].map((analyzers) =>
    parseWorkspaceSnapshot(JSON.stringify({ version: 1, analyzers }))?.analyzers);
  const empty = serializeWorkspaceSnapshot({ version: 1, detailedLabels: true });
  check('a missing or non-array analyzers section restores empty and still serializes as []',
    JSON.stringify(legacy?.analyzers) === '[]' &&
    nonArray.every((list) => JSON.stringify(list) === '[]') &&
    empty === '{"version":1,"detailedLabels":true,"analyzers":[]}',
    `${empty} | ${nonArray.map((list) => JSON.stringify(list)).join(', ')}`);
}

{
  const invalidDecoders = ['', 'I2C', 'i2c ', 'xy2-100!', '-xy2', 'a'.repeat(65), 42, null, ['i2c']];
  const dropped = invalidDecoders.map((decoderId) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1, analyzers: [{ decoderId, channels: {} }],
  }))?.analyzers?.length);
  const boundary = [65, 64].map((length) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1, analyzers: [{ decoderId: 'a'.repeat(length), channels: {} }],
  }))?.analyzers?.[0]?.decoderId.length);
  const mixed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    analyzers: [
      { decoderId: 'I2C', channels: {} },
      { decoderId: 'i2c', channels: {} },
      { decoderId: '', channels: {} },
    ],
  }))?.analyzers ?? [];
  check('mounts without a stock decoderId shape are dropped while the 64-character bound is exact',
    dropped.every((length) => length === 0) && boundary[0] === undefined && boundary[1] === 64 &&
    mixed.length === 1 && mixed[0]?.decoderId === 'i2c',
    `${dropped.join(',')} | ${boundary.join(',')} | mixed=${mixed.length}`);
}

{
  const decoderMounts = (decoderId: unknown) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1, analyzers: [{ decoderId, channels: {} }],
  }))?.analyzers?.[0]?.decoderId;
  check('the decoder-id charset admits interior and trailing dashes but still rejects leading ones',
    decoderMounts('xy2-100') === 'xy2-100' && decoderMounts('i2c-') === 'i2c-' &&
    decoderMounts('-xy2') === undefined && decoderMounts('xy2-100!') === undefined,
    [decoderMounts('xy2-100'), decoderMounts('i2c-'), decoderMounts('-xy2'), decoderMounts('xy2-100!')]
      .map((value) => String(value)).join(' | '));
}

{
  const kept = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    analyzers: [{ decoderId: '_xy2', channels: { 0: 1 } }, { decoderId: 'i2c', channels: {} }],
  }))?.analyzers ?? [];
  check('a decoder id starting with an underscore is dropped whole instead of surviving beside valid mounts',
    kept.length === 1 && kept[0]?.decoderId === 'i2c',
    JSON.stringify(kept.map((analyzer) => analyzer.decoderId)));
}

{
  const snapshot: WorkspaceSnapshotV1 = {
    version: 1,
    detailedLabels: true,
    analyzers: [{
      id: 'xy2-100-1',
      decoderId: 'xy2-100',
      label: 'XY2-100',
      color: '#9A7B2E',
      channels: { 0: 2, 1: 3, 2: -1 },
      options: { address: 0 },
      laneChannel: 3,
    }],
  };
  const baseline = serializeWorkspaceSnapshot(snapshot);
  const restored = parseWorkspaceSnapshot(baseline)?.analyzers ?? [];
  const reserialized = serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, analyzers: restored,
  });
  const [xy2] = restored;
  check('dashed decoder mounts round-trip byte-identically and keep their stock per-instance id',
    restored.length === 1 && xy2?.id === 'xy2-100-1' && xy2.decoderId === 'xy2-100' &&
    JSON.stringify(xy2.channels) === '{"0":2,"1":3,"2":-1}' && xy2.laneChannel === 3 &&
    reserialized === baseline && nextAnalyzerSequence(restored) === 2,
    `${restored.length} | ${xy2?.id} | byte-equal=${reserialized === baseline} | next=${nextAnalyzerSequence(restored)}`);
}

{
  const idOf = (id: unknown) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1, analyzers: [{ id, decoderId: 'xy2-100', channels: {} }],
  }))?.analyzers?.[0]?.id;
  const synthesized = ['xy2-100-x', 'XY2-100-1', 'xy2-100-', 'xy2-100-1.5'].map(idOf);
  check('analyzer ids keep dashed decoder prefixes and synthesize anything that is not <prefix>-<n>',
    idOf('xy2-100-1') === 'xy2-100-1' && idOf('xy2-100-0') === 'xy2-100-0' &&
    synthesized.every((id) => id === 'xy2-100-0'),
    `${idOf('xy2-100-1')} | ${synthesized.join(',')}`);
}

{
  const options = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    analyzers: [{
      decoderId: 'xy2-100',
      channels: {},
      options: {
        'stop-bits': 8, 'data-bits': '7', 'trailing-': 1, '-leading': 2, 'UP-per': 3,
        plain_key: 4, '': 5,
      },
    }],
  }))?.analyzers?.[0]?.options ?? {};
  check('analyzer option keys share the dashed token charset and drop only the illegal shapes',
    options['stop-bits'] === 8 && options['data-bits'] === '7' && options['trailing-'] === 1 &&
    options.plain_key === 4 && Object.keys(options).length === 4 &&
    !('-leading' in options) && !('UP-per' in options) && !('' in options),
    JSON.stringify(options));
}

{
  const options = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    analyzers: [{ decoderId: 'i2c', channels: {}, options: { _addr: 72, addr: 7, a_b: 1 } }],
  }))?.analyzers?.[0]?.options ?? {};
  check('an option key starting with an underscore is dropped key by key while its siblings survive',
    !('_addr' in options) && options.addr === 7 && options.a_b === 1 &&
    Object.keys(options).length === 2,
    JSON.stringify(options));
}

{
  const invalidChannels: unknown[] = [
    { 0: 16 }, { 0: -2 }, { 0: 1.5 }, { 0: '3' }, { 0: null }, { '01': 0 }, { '-1': 0 }, { 64: 0 },
    null, [], 'i2c', 3,
  ];
  const dropped = invalidChannels.map((channels) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    channels: Array.from({ length: 16 }, () => ({})),
    analyzers: [{ decoderId: 'i2c', channels }],
  }))?.analyzers?.length);
  const unassigned = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    channels: Array.from({ length: 16 }, () => ({})),
    analyzers: [{ decoderId: 'i2c', channels: { 0: 15, 1: -1 } }],
  }))?.analyzers?.[0]?.channels;
  check('channel maps keep -1 and reject out-of-capacity, fractional or non-canonical keys whole',
    dropped.every((length) => length === 0) && JSON.stringify(unassigned) === '{"0":15,"1":-1}',
    `${dropped.join(',')} | ${JSON.stringify(unassigned)}`);
}

{
  const raw = '{"version":1,"analyzers":[{"decoderId":"i2c","channels":{},"options":' +
    '{"address":72,"address_format":"unshifted","UPPER":1,"has space":2,"":3,' +
    '"bool":true,"nothing":null,"nested":{},"list":[],"infinite":1e999,' +
    `"${'x'.repeat(65)}":4,"negative":-5,"fractional":0.5}}]}`;
  const options = parseWorkspaceSnapshot(raw)?.analyzers?.[0]?.options ?? {};
  check('analyzer options drop illegal keys and non-string finite-number values one by one',
    JSON.stringify(options) === JSON.stringify({
      address: 72, address_format: 'unshifted', negative: -5, fractional: 0.5,
    }),
    JSON.stringify(options));
}

{
  const label = (value: unknown) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1, analyzers: [{ decoderId: 'i2c', channels: {}, label: value }],
  }))?.analyzers?.[0]?.label;
  const padded = label('  Inter-Integrated Circuit  ');
  const truncated = label('L'.repeat(80));
  check('analyzer labels trim, cap at 64 characters, and fall back to the decoder id',
    padded === 'Inter-Integrated Circuit' && truncated === 'L'.repeat(64) &&
    ['', '   ', 42, null, {}, ['x']].every((value) => label(value) === 'i2c'),
    `${padded} | ${truncated?.length}`);
}

{
  const color = (value: unknown) => parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    analyzers: [{ decoderId: 'i2c', channels: {} }, { decoderId: 'spi', channels: {}, color: value }],
  }))?.analyzers?.[1]?.color;
  const invalid = ['red', '#12345', '#1234567', '#GGGGGG', 12, null];
  const fallbacks = invalid.map((value) => color(value));
  check('invalid analyzer colors fall back to the analyzer palette position while valid hex survives',
    fallbacks.every((value) => value === analyzerColor(1)) && fallbacks.every((value) => value !== analyzerColor(0)) &&
    color('#aAbBcC') === '#aAbBcC',
    `${fallbacks.join(',')} | ${color('#aAbBcC')}`);
}

{
  const lane = (laneChannel: unknown, channels: Record<number, number>) =>
    parseWorkspaceSnapshot(JSON.stringify({
      version: 1, analyzers: [{ decoderId: 'i2c', channels, laneChannel }],
    }))?.analyzers?.[0]?.laneChannel;
  const invalid = [16, -1, 1.5, '3', null];
  const derived = invalid.map((value) => lane(value, { 0: 3, 1: 5, 2: -1 }));
  check('invalid lane channels derive from the highest assigned decoder channel, or 0 when unassigned',
    derived.every((value) => value === 5) && lane(undefined, { 0: -1 }) === 0 &&
    lane(undefined, {}) === 0 && lane(0, { 0: 5 }) === 0,
    `${derived.join(',')} | ${lane(undefined, { 0: -1 })}, ${lane(undefined, {})}`);
}

{
  const lane = (laneChannel: unknown, channels: Record<number, number>) =>
    parseWorkspaceSnapshot(JSON.stringify({
      version: 1, analyzers: [{ decoderId: 'i2c', channels, laneChannel }],
    }))?.analyzers?.[0]?.laneChannel;
  const channels = { 0: 5, 1: 2 };
  const largestValue = Math.max(...Object.values(channels));
  const restored = [null, undefined, 16, -1, 1.5].map((value) => lane(value, channels));
  check('an unusable persisted lane channel restores the highest mapped decoder channel, not the largest value',
    restored.every((value) => value === 2) && largestValue === 5 &&
    lane(undefined, { 0: -1, 3: 4 }) === 4 && lane(null, { 0: 6, 1: 1 }) === 1,
    `${restored.join(',')} | largest=${largestValue}`);
}

{
  const legacyLaneChannel = (channels: Record<number, number>): number => {
    const [last] = Object.keys(channels).map(Number).sort((a, b) => a - b).slice(-1);
    return last === undefined ? 0 : channels[last]!;
  };
  const maxAssignedLaneChannel = (channels: Record<number, number>): number => {
    const mapped = Object.values(channels).filter((channel) => channel >= 0);
    return mapped.length ? Math.max(...mapped) : 0;
  };
  const fullyAssigned: Array<Record<number, number>> = [
    { 0: 5, 1: 2 },
    { 0: 2, 1: 3, 2: 0 },
    { 1: 4, 0: 6 },
    { 3: 1 },
    { 2: 7, 0: 1, 4: 3, 1: 9 },
    { 0: 0, 1: 1 },
    { 5: 2, 4: 8, 3: 6 },
    { 7: 3, 6: 5, 5: 4, 4: 1 },
  ];
  const legacyRows = fullyAssigned.map((channels) =>
    `${JSON.stringify(channels)}=>${analyzerLaneChannel(channels)}/${legacyLaneChannel(channels)}`);
  const legacyMismatch = fullyAssigned.filter((channels) =>
    analyzerLaneChannel(channels) !== legacyLaneChannel(channels));
  const discriminates = maxAssignedLaneChannel({ 0: 5, 1: 2 }) === 5 &&
    analyzerLaneChannel({ 0: 5, 1: 2 }) === 2;
  check('the lane rule matches the attach expression on every fully assigned map and rejects the max-value rule',
    legacyMismatch.length === 0 && legacyRows.length >= 8 && discriminates,
    legacyRows.join(', '));
}

{
  const lanes: Array<[Record<number, number>, number]> = [
    [{ 0: 5, 1: 2 }, 2],
    [{ 0: 3, 1: -1 }, 3],
    [{ 0: -1 }, 0],
    [{}, 0],
    [{ 2: 7 }, 7],
    [{ 1: 4, 0: 6, 2: -1 }, 4],
  ];
  const failed = lanes.filter(([channels, expected]) => analyzerLaneChannel(channels) !== expected);
  const channels = { 0: 3, 1: -1 };
  const mounted: PersistedAnalyzer = {
    id: 'jtag-0', decoderId: 'jtag', label: 'JTAG', color: analyzerColor(0),
    channels: { ...channels }, options: {}, laneChannel: analyzerLaneChannel(channels),
  };
  const roundTripped = parseWorkspaceSnapshot(serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, analyzers: [mounted],
  }))?.analyzers?.[0]?.laneChannel;
  const serializedLane = JSON.parse(serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, analyzers: [mounted],
  }))?.analyzers?.[0]?.laneChannel;
  check('the lane derivation keeps the legacy mount position and skips unassigned top channels on both paths',
    failed.length === 0 && mounted.laneChannel === 3 && roundTripped === 3 && serializedLane === 3,
    `${failed.map(([row, expected]) => `${JSON.stringify(row)}=>${analyzerLaneChannel(row)}/${expected}`)
      .join(', ') || 'all rows matched'} | mount=${mounted.laneChannel}, ` +
    `roundTrip=${roundTripped}, serialized=${serializedLane}`);
}

{
  const parsed = parseWorkspaceSnapshot(JSON.stringify({
    version: 1,
    analyzers: [
      { id: 'i2c-0', decoderId: 'i2c', channels: {} },
      { id: 'i2c-0', decoderId: 'i2c', channels: {} },
      { id: 'I2C-1', decoderId: 'i2c', channels: {} },
      { id: 'i2c', decoderId: 'i2c', channels: {} },
      { id: 'i2c_2', decoderId: 'i2c', channels: {} },
      { id: 'uart-3', decoderId: 'uart', channels: {} },
    ],
  }))?.analyzers ?? [];
  const ids = parsed.map((analyzer) => analyzer.id);
  check('analyzer ids keep unique stock-shaped values and synthesize a non-colliding id otherwise',
    JSON.stringify(ids) === JSON.stringify(['i2c-0', 'i2c-1', 'i2c-2', 'i2c-3', 'i2c-4', 'uart-3']) &&
    new Set(ids).size === ids.length,
    JSON.stringify(ids));
}

{
  const entries = Array.from({ length: MAX_PERSISTED_ANALYZERS + 4 }, (_, index) => ({
    id: `i2c-${index}`, decoderId: 'i2c', channels: {}, label: `#${index}`,
  }));
  const capped = parseWorkspaceSnapshot(JSON.stringify({ version: 1, analyzers: entries }))?.analyzers ?? [];
  const under = parseWorkspaceSnapshot(JSON.stringify({
    version: 1, analyzers: entries.slice(0, MAX_PERSISTED_ANALYZERS),
  }))?.analyzers?.length;
  check('analyzer restoration truncates past the 64-entry cap instead of dropping the section',
    capped.length === MAX_PERSISTED_ANALYZERS && capped[0]?.label === '#0' &&
    capped[capped.length - 1]?.label === `#${MAX_PERSISTED_ANALYZERS - 1}` &&
    under === MAX_PERSISTED_ANALYZERS,
    `${capped.length} / ${under}`);
}

{
  const snapshot: WorkspaceSnapshotV1 = {
    version: 1,
    detailedLabels: true,
    analyzers: [{
      id: 'i2c-0',
      decoderId: 'i2c',
      label: 'I2C',
      color: '#9A7B2E',
      channels: { 5: 9, 0: 3, 2: -1 },
      options: { sample_rate: 400000, address: 72, address_format: 'shifted' },
      laneChannel: 9,
    }],
  };
  const first = serializeWorkspaceSnapshot(snapshot);
  const second = serializeWorkspaceSnapshot(snapshot);
  const reparsed = parseWorkspaceSnapshot(first);
  const reserialized = serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, analyzers: reparsed?.analyzers ?? [],
  });
  check('analyzer serialization is stable and orders channel keys numerically and options lexically',
    first === second && reserialized === first &&
    first.includes('"channels":{"0":3,"2":-1,"5":9}') &&
    first.includes('"options":{"address":72,"address_format":"shifted","sample_rate":400000}') &&
    first.indexOf('"label"') < first.indexOf('"channels"') &&
    first.indexOf('"channels"') < first.indexOf('"options"') &&
    first.indexOf('"options"') < first.indexOf('"laneChannel"'),
    first);
}

{
  const raw = '{"version":1,"analyzers":[{"id":"i2c-0","decoderId":"i2c","label":"I2C",' +
    '"channels":{"0":1},"options":{},"laneChannel":1,"result":{"instances":[]},' +
    '"index":{"keys":[1]},"status":"done","note":{"kind":"pending"}}]}';
  const parsed = parseWorkspaceSnapshot(raw);
  const analyzer = parsed?.analyzers?.[0];
  const keys = analyzer ? Object.keys(analyzer).sort().join(',') : '';
  const serialized = serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, analyzers: parsed?.analyzers ?? [],
  });
  check('restored analyzer DTOs carry no decode result, status, note or annotation index',
    keys === 'channels,color,decoderId,id,label,laneChannel,options' &&
    !serialized.includes('"result"') && !serialized.includes('"status"') &&
    !serialized.includes('"note"') && !serialized.includes('"index"'),
    `${keys} | ${serialized}`);
}

{
  const persisted: PersistedAnalyzer[] = [{
    id: 'i2c-0', decoderId: 'i2c', label: 'I2C', color: '#9A7B2E',
    channels: { 0: 3 }, options: { address: 72 }, laneChannel: 3,
  }];
  const states = analyzerStatesFrom(persisted);
  const state = states[0];
  const shape = states.length === 1 && state?.id === 'i2c-0' && state.decoderId === 'i2c' &&
    state.label === 'I2C' && state.color === '#9A7B2E' && state.laneChannel === 3 &&
    state.result === null && state.index === null && state.status === 'idle' &&
    JSON.stringify(state.note) === '{"kind":"pending"}' &&
    JSON.stringify(state.channels) === '{"0":3}' && JSON.stringify(state.options) === '{"address":72}';
  persisted[0]!.channels[0] = 9;
  persisted[0]!.options.address = 0;
  check('analyzerStatesFrom projects mounts to idle, result-free state with isolated nested maps',
    shape && state?.channels[0] === 3 && state.options.address === 72,
    JSON.stringify(state));
}

{
  const rows: Array<[string[], number]> = [
    [[], 0],
    [['i2c-0'], 1],
    [['i2c-3', 'uart-1'], 4],
    [['i2c-7', 'uart-2'], 8],
    [['i2c', 'uart-x', 'spi-'], 0],
    [['i2c-0', 'i2c-1', 'i2c-2'], 3],
  ];
  const failed = rows.filter(([ids, expected]) =>
    nextAnalyzerSequence(ids.map((id) => ({ id }))) !== expected);
  const restoredIds = ['i2c-7', 'i2c-2', 'spi-0'].map((id) => ({ id }));
  const next = nextAnalyzerSequence(restoredIds);
  const collision = restoredIds.some((analyzer) => analyzer.id === `i2c-${next}`);
  check('nextAnalyzerSequence follows the highest numeric suffix and never collides with restored ids',
    failed.length === 0 && !collision,
    failed.map(([ids]) => `${ids.join('+')}=>${nextAnalyzerSequence(ids.map((id) => ({ id })))}`)
      .join(', ') || `all rows matched, next=${next}`);
}

const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const preferences = fs.readFileSync('src/ui/workspacePreferences.ts', 'utf8');
const stateSource = fs.readFileSync('src/ui/state.ts', 'utf8');
function appMethodBody(name: string): string {
  const syncStart = app.indexOf(`private ${name}(`);
  const start = syncStart >= 0 ? syncStart : app.indexOf(`private async ${name}(`);
  const end = start >= 0 ? app.indexOf('\n  }', start) : -1;
  return start >= 0 && end > start ? app.slice(start, end) : '';
}
const restoreStart = preferences.indexOf('function restoredLaneChannel(');
const restoreEnd = restoreStart >= 0 ? preferences.indexOf('\n}', restoreStart) : -1;
const restoreLaneBody = restoreStart >= 0 && restoreEnd > restoreStart
  ? preferences.slice(restoreStart, restoreEnd) : '';
const constructorStart = app.indexOf('constructor() {');
const constructorEnd = constructorStart >= 0
  ? app.indexOf('\n  // ------------------------------------------------------------------ layout', constructorStart) : -1;
const constructorBody = constructorStart >= 0 && constructorEnd > constructorStart
  ? app.slice(constructorStart, constructorEnd) : '';
const restoreOrder = [
  'applyStaticI18n(document);',
  'readWorkspaceSnapshot()',
  'channels: initialWidth',
  'this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));',
  'this.syncBankChannels();',
  'this.reflectDetailedLabels();',
  'createSampleStore(',
].map((needle) => constructorBody.indexOf(needle));
const restoreHasNoWrite = !constructorBody.includes('this.persistWorkspace();') &&
  !constructorBody.includes('writeWorkspaceSnapshot(');
check('App restores sanitized labels before reflection and initial store creation without writing',
  restoreOrder.every((index, i) => index >= 0 && (i === 0 || index > restoreOrder[i - 1])) && restoreHasNoWrite,
  `order=${JSON.stringify(restoreOrder)}, noWrite=${restoreHasNoWrite}`);

const bootAnalyzerLine = 'this.analyzers = analyzerStatesFrom(workspace?.analyzers ?? []);';
const bootSequenceLine = 'this.nextAnalyzer = nextAnalyzerSequence(this.analyzers);';
const bootAnchor = 'this.lastWorkspaceSnapshot = serializeWorkspaceSnapshot(';
const bootRestoreOrder = [
  'const workspace = readWorkspaceSnapshot();',
  bootAnalyzerLine,
  bootSequenceLine,
  bootAnchor,
].map((needle) => constructorBody.indexOf(needle));
const bootSliceStart = bootRestoreOrder[0] ?? -1;
const bootSliceEnd = bootRestoreOrder[3] ?? -1;
const bootRestoreSlice = bootSliceStart >= 0 && bootSliceEnd > bootSliceStart
  ? constructorBody.slice(bootSliceStart, bootSliceEnd) : '';
const bootForbidden = [
  'hydrateDecoders', 'runDecode', 'persistWorkspace', 'writeWorkspaceSnapshot', 'demoAnalyzers',
  'attachAnalyzer', 'warmup', 'adoptDeviceChannels',
];
const bootLeaks = bootForbidden.filter((needle) => bootRestoreSlice.includes(needle));
check('App rebuilds analyzer mounts and the id sequence before the unchanged-value baseline',
  bootRestoreOrder.every((index, i) => index >= 0 && (i === 0 || index > bootRestoreOrder[i - 1])) &&
  app.includes('analyzerStatesFrom, nextAnalyzerSequence, readWorkspaceSnapshot'),
  `order=${JSON.stringify(bootRestoreOrder)}`);

check('the boot restoration slice never hydrates, decodes, connects, claims demo rows or writes',
  bootRestoreSlice.includes(bootAnalyzerLine) && bootRestoreSlice.includes(bootSequenceLine) &&
  bootRestoreSlice.includes('this.syncBankChannels();') && bootLeaks.length === 0,
  `slice=${bootRestoreSlice.length}B, leaks=${JSON.stringify(bootLeaks)}`);

{
  const stored = JSON.stringify({
    version: 1,
    detailedLabels: true,
    analyzers: [
      { id: 'i2c-7', decoderId: 'i2c', label: 'I2C', color: '#9A7B2E',
        channels: { 0: 1, 1: -1 }, options: { address: 72 }, laneChannel: 1 },
      { id: 'spi-2', decoderId: 'spi', label: 'SPI', color: '#A8504E',
        channels: { 0: 3 }, options: {}, laneChannel: 3 },
    ],
  });
  const parsedAnalyzers = parseWorkspaceSnapshot(stored)?.analyzers ?? [];
  const restored = analyzerStatesFrom(parsedAnalyzers);
  const next = nextAnalyzerSequence(restored);
  const runtimeFields = restored.filter((analyzer) => analyzer.result !== null || analyzer.index !== null ||
    analyzer.status !== 'idle' || JSON.stringify(analyzer.note) !== '{"kind":"pending"}');
  const collided = [...restored.map((analyzer) => analyzer.id), ...parsedAnalyzers.map((a) => a.id)]
    .some((id) => id === `i2c-${next}` || id === `spi-${next}`);
  const empty = nextAnalyzerSequence(analyzerStatesFrom(parseWorkspaceSnapshot(
    JSON.stringify({ version: 1, detailedLabels: true }))?.analyzers ?? []));
  check('a stored workspace restores idle analyzer states and a non-colliding next sequence',
    parsedAnalyzers.length === 2 && restored.length === 2 &&
    restored.map((analyzer) => analyzer.id).join(',') === 'i2c-7,spi-2' && next === 8 &&
    !collided && empty === 0 && runtimeFields.length === 0,
    `ids=${restored.map((a) => a.id).join(',')}, next=${next}, empty=${empty}, runtime=${runtimeFields.length}`);
}

const settingsStart = app.indexOf('private settingsItems(');
const settingsEnd = settingsStart >= 0 ? app.indexOf('\n  }', settingsStart) : -1;
const settingsBody = settingsStart >= 0 && settingsEnd > settingsStart
  ? app.slice(settingsStart, settingsEnd) : '';
const toggleOrder = [
  'this.detailedLabels = !this.detailedLabels;',
  'this.reflectDetailedLabels();',
  'this.persistWorkspace();',
  'this.relayout();',
].map((needle) => settingsBody.indexOf(needle));
const retranslateStart = app.indexOf('private retranslate(): void {');
const retranslateEnd = retranslateStart >= 0 ? app.indexOf('\n  }', retranslateStart) : -1;
const retranslateBody = retranslateStart >= 0 && retranslateEnd > retranslateStart
  ? app.slice(retranslateStart, retranslateEnd) : '';
check('the real label toggle writes immediately after reflection and retranslation stays write-free',
  toggleOrder.every((index, i) => index >= 0 && (i === 0 || index > toggleOrder[i - 1])) &&
  !retranslateBody.includes('persistWorkspace'),
  `order=${JSON.stringify(toggleOrder)}`);

const persistStart = app.indexOf('private persistWorkspace(): void {');
const persistEnd = persistStart >= 0 ? app.indexOf('\n  }', persistStart) : -1;
const persistBody = persistStart >= 0 && persistEnd > persistStart
  ? app.slice(persistStart, persistEnd) : '';
const snapshotStart = app.indexOf('private workspaceSnapshot(): WorkspaceSnapshotV1 {');
const snapshotBody = snapshotStart >= 0 && persistStart > snapshotStart
  ? app.slice(snapshotStart, persistStart) : '';
check('the App snapshot boundary serializes canonical labels/channels/order and caches only successful writes',
  snapshotBody.includes('version: WORKSPACE_SCHEMA_VERSION') &&
  snapshotBody.includes('detailedLabels: this.detailedLabels') &&
  snapshotBody.includes('channels: this.channels.map') && snapshotBody.includes('order: [...this.order]') &&
  persistBody.includes('serializeWorkspaceSnapshot(snapshot)') &&
  persistBody.includes('if (serialized === this.lastWorkspaceSnapshot) return;') &&
  persistBody.includes('if (writeWorkspaceSnapshot(snapshot)) this.lastWorkspaceSnapshot = serialized;') &&
  constructorBody.includes('this.lastWorkspaceSnapshot = serializeWorkspaceSnapshot(this.workspaceSnapshot());') &&
  !app.includes('localStorage'),
  persistBody.replace(/\s+/g, ' ').trim());

const analyzerProjectionAt = snapshotBody.indexOf('analyzers: this.analyzers');
const analyzerProjection = analyzerProjectionAt >= 0 ? snapshotBody.slice(analyzerProjectionAt) : '';
const projectionFields = [
  'id: a.id', 'decoderId: a.decoderId', 'label: a.label', 'color: a.color',
  'channels: { ...a.channels }', 'options: { ...a.options }', 'laneChannel: a.laneChannel',
];
const projectionMissing = projectionFields.filter((needle) => !analyzerProjection.includes(needle));
const runtimeLeak = ['a.result', 'a.index', 'a.status', 'a.note', 'result:', 'status:', 'note:']
  .filter((needle) => analyzerProjection.includes(needle));
check('the snapshot projects analyzer mounts as a typed fresh DTO and never copies decode runtime fields',
  analyzerProjectionAt >= 0 && projectionMissing.length === 0 && runtimeLeak.length === 0 &&
  analyzerProjection.includes('.map((a): PersistedAnalyzer => ({') && app.includes('type PersistedAnalyzer,'),
  `missing=${JSON.stringify(projectionMissing)}, leak=${JSON.stringify(runtimeLeak)}`);

const demoExclusion = analyzerProjection.includes('.filter((a) => !this.demoAnalyzers.has(a.id))') &&
  analyzerProjection.includes('.map((a): PersistedAnalyzer => ({') &&
  !snapshotBody.includes('this.analyzers.map(') &&
  !snapshotBody.includes('analyzers: this.analyzers,');
check('the analyzer projection drops demo-owned mounts before mapping so loader rows stay out',
  demoExclusion,
  `projection=${analyzerProjection.replace(/\s+/g, ' ').trim()}`);

const attachStart = app.indexOf('private async attachAnalyzer(');
const attachEnd = attachStart >= 0 ? app.indexOf('\n  }', attachStart) : -1;
const attachBody = attachStart >= 0 && attachEnd > attachStart
  ? app.slice(attachStart, attachEnd) : '';
const attachOrder = [
  'this.analyzers.push(a);',
  'if (demoOwned) this.demoAnalyzers.add(a.id);',
  'this.persistWorkspace();',
  'this.renderPanels();',
  'await this.runDecode(a.id);',
].map((needle) => attachBody.indexOf(needle));
check('attaching a mount records demo ownership before persisting and writes before decoding',
  attachBody.length > 0 && attachBody.split('this.persistWorkspace();').length === 2 &&
  attachOrder.every((index, i) => index >= 0 && (i === 0 || index > attachOrder[i - 1])),
  `order=${JSON.stringify(attachOrder)}`);

const laneBodyStart = stateSource.indexOf('export function analyzerLaneChannel(');
const laneBodyEnd = laneBodyStart >= 0
  ? stateSource.indexOf('\n}', laneBodyStart) : -1;
const laneBody = laneBodyStart >= 0 && laneBodyEnd > laneBodyStart
  ? stateSource.slice(laneBodyStart, laneBodyEnd) : '';
const laneRule = {
  declared: stateSource.split('export function analyzerLaneChannel(').length - 1,
  rule: laneBody.includes('value < 0') && laneBody.includes('index <= decoderChannel') &&
    !laneBody.includes('Math.max'),
  attach: attachBody.includes('analyzerLaneChannel(channels)') &&
    !attachBody.includes('mapped[mapped.length - 1]') && !attachBody.includes('Object.keys(channels)'),
  restore: restoreLaneBody.includes('analyzerLaneChannel(channels)') &&
    !restoreLaneBody.includes('Math.max(...mapped)'),
  singleSite: !app.includes('Math.max(...mapped)') && !preferences.includes('Math.max(...mapped)'),
};
check('the lane rule lives once in state and both the write and restore paths call it',
  laneRule.declared === 1 && laneRule.rule && laneRule.attach && laneRule.restore && laneRule.singleSite,
  JSON.stringify(laneRule));

const removeStart = app.indexOf('private removeAnalyzer(id: string): void {');
const removeEnd = removeStart >= 0 ? app.indexOf('\n  }', removeStart) : -1;
const removeBody = removeStart >= 0 && removeEnd > removeStart
  ? app.slice(removeStart, removeEnd) : '';
const removeOrder = [
  'this.demoAnalyzers.delete(id);',
  'this.analyzers = this.analyzers.filter((a) => a.id !== id);',
  'this.persistWorkspace();',
  'this.relayout();',
].map((needle) => removeBody.indexOf(needle));
check('removing a mount persists exactly once after the array and demo ownership drop',
  removeBody.length > 0 && removeBody.split('this.persistWorkspace();').length === 2 &&
  removeOrder.every((index, i) => index >= 0 && (i === 0 || index > removeOrder[i - 1])),
  `order=${JSON.stringify(removeOrder)}`);

const runDecodeStart = app.indexOf('private async runDecode(');
const runDecodeEnd = runDecodeStart >= 0 ? app.indexOf('private setEnabledChannels(', runDecodeStart) : -1;
const runDecodeBody = runDecodeStart >= 0 && runDecodeEnd > runDecodeStart
  ? app.slice(runDecodeStart, runDecodeEnd) : '';
check('decoding never writes the workspace snapshot',
  runDecodeBody.length > 0 && !runDecodeBody.includes('persistWorkspace') &&
  !runDecodeBody.includes('writeWorkspaceSnapshot'),
  `bytes=${runDecodeBody.length}`);

const appMethodNames = [...app.matchAll(/^  private (?:async )?([A-Za-z0-9_]+)\(/gm)]
  .map((match) => match[1] ?? '');
const persistWriters = [...new Set(appMethodNames
  .filter((name) => appMethodBody(name).includes('this.persistWorkspace();')))].sort();
const expectedWriters = [
  'adoptCapture', 'adoptDeviceChannels', 'afterChannelChange', 'applySettings', 'attachAnalyzer',
  'configureBankBus', 'configureChannel', 'removeAnalyzer', 'reorder', 'settingsItems',
  'startCapture',
].sort();
const quietMethods = ['runDecode', 'discardDecodeState', 'renderPanels', 'relayout', 'retranslate'];
const quiet = quietMethods.map((name) => ({ name, body: appMethodBody(name) }));
const quietLeaks = quiet.filter((entry) => entry.body.includes('persistWorkspace'))
  .map((entry) => entry.name);
check('the committed mutation methods are the only workspace writers and no render or scan pass writes',
  JSON.stringify(persistWriters) === JSON.stringify(expectedWriters) &&
  quiet.every((entry) => entry.body.length > 0) && quietLeaks.length === 0 &&
  !constructorBody.includes('persistWorkspace') && attachBody.includes('this.persistWorkspace();') &&
  removeBody.includes('this.persistWorkspace();'),
  `writers=${JSON.stringify(persistWriters)}, quiet=${JSON.stringify(quietLeaks)}`);

const writeMethods = [
  'applySettings', 'afterChannelChange', 'configureChannel', 'reorder', 'adoptCapture', 'adoptDeviceChannels',
  'startCapture', 'configureBankBus',
];
const missingWriteMethods = writeMethods.filter((name) =>
  !appMethodBody(name).includes('this.persistWorkspace();'));
check('all committed channel paths share the writer and the initial empty store covers the whole channel model',
  missingWriteMethods.length === 0 && constructorBody.includes(
    'createSampleStore(channelWidthForProbes(this.channels.length), this.settings.samplerate)') &&
  !constructorBody.includes('createSampleStore(this.settings.channels, this.settings.samplerate)'),
  `missing=${JSON.stringify(missingWriteMethods)}`);

const capturePanel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const captureDerivation = constructorBody.includes('const triggerConditions = modesToConditions(triggerModes);') &&
  constructorBody.includes('triggerChannel: first?.channel ?? 0') &&
  constructorBody.includes('triggerKind: first?.kind ?? \'rising\'') &&
  constructorBody.includes('triggerLevel: first?.level ?? 1') &&
  constructorBody.includes('channels: initialWidth') &&
  constructorBody.includes('}, this.rateCeilings);');
const sharedSettingsPath = app.includes('onSettings: (s) => this.applySettings(s)') &&
  app.includes('this.applySettings({ ...this.settings, ...s });') &&
  app.includes('private applySettings(s: CaptureSettings): void {');
check('capture restore rebuilds canonical trigger derivatives and panel/debug/assistant use one commit path',
  app.includes('private settings: CaptureSettings = defaultCaptureSettings();') &&
  capturePanel.includes('THRESHOLD_VOLT_OPTIONS') && !capturePanel.includes('const THRESHOLDS') &&
  captureDerivation && sharedSettingsPath && snapshotBody.includes('capture: {') &&
  snapshotBody.includes('samplerate: this.settings.samplerate') &&
  snapshotBody.includes('triggerModes: { ...this.settings.triggerModes }') &&
  !snapshotBody.includes('softwareTrigger') && !snapshotBody.includes('triggerConditions') &&
  !snapshotBody.includes('triggerChannel') && snapshotBody.includes('busViews: this.busViews.map') &&
  snapshotBody.includes('bankBusDrafts: Object.fromEntries') &&
  !snapshotBody.includes('builder') && !snapshotBody.includes('builtFor') && !snapshotBody.includes('cache'),
  `derivation=${captureDerivation}, shared=${sharedSettingsPath}`);

const applySettingsStart = app.indexOf('private applySettings(s: CaptureSettings): void {');
const applySettingsEnd = applySettingsStart >= 0 ? app.indexOf('\n  }', applySettingsStart) : -1;
const applySettingsBody = applySettingsStart >= 0 && applySettingsEnd > applySettingsStart
  ? app.slice(applySettingsStart, applySettingsEnd) : '';
const explicitMark = 'if (s.samplerate !== this.settings.samplerate) this.samplerateExplicit = true;';
const explicitRestore = 'this.samplerateExplicit = workspace?.capture?.samplerateExplicit === true;';
const markAt = applySettingsBody.indexOf(explicitMark);
const clampAt = applySettingsBody.indexOf('clampSettings(');
const restoreAt = constructorBody.indexOf(explicitRestore);
const composeAt = constructorBody.indexOf('this.settings = clampSettings(');
const explicitWiring = app.includes('private samplerateExplicit = false;') &&
  applySettingsBody.includes(`private applySettings(s: CaptureSettings): void {\n    ${explicitMark}`) &&
  applySettingsBody.split(explicitMark).length === 2 && markAt >= 0 && clampAt > markAt &&
  restoreAt >= 0 && composeAt > restoreAt && !app.includes('this.settings.samplerateExplicit') &&
  snapshotBody.includes('samplerateExplicit: this.samplerateExplicit,');
check('App keeps the explicit-rate marker outside CaptureSettings and marks only real rate changes',
  explicitWiring,
  `mark=${markAt}, clamp=${clampAt}, restore=${restoreAt}, compose=${composeAt}, wiring=${explicitWiring}`);

const deviceBody = app.split('private adoptDeviceChannels(')[1]?.split('private async startCapture(')[0] ?? '';
check('a narrower device keeps the restored channel mask',
  deviceBody.includes('const masks = this.channels.map((c) => c.enabled);') &&
  deviceBody.includes('defaultChannels(max).map((c) => ({ ...c, enabled: masks[c.index] ?? true }))'),
  deviceBody.replace(/\s+/g, ' ').trim());

const widthSetterBody = app.split('private setChannelWidth(channels: number): void')[1]
  ?.split('private afterChannelChange(')[0] ?? '';
const afterMaskBody = app.split('private afterChannelChange(): void {')[1]?.split('\n  }')[0] ?? '';
const adoptBody = app.split('private adoptCapture(')[1]?.split('private save(')[0] ?? '';
const widthWiring = app.includes('private widthExplicit = false;') &&
  adoptBody.includes('this.widthExplicit = false;') &&
  constructorBody.includes('this.widthExplicit = workspace?.capture?.widthExplicit === true;') &&
  constructorBody.includes('const initialWidth = workspace?.capture?.channels ?? channelWidthForProbes(this.channels.length);') &&
  widthSetterBody.includes('if (channels !== this.settings.channels) this.widthExplicit = true;') &&
  widthSetterBody.includes('this.applySettings({ ...this.settings, channels });') &&
  !widthSetterBody.includes('enabled = i < channels') &&
  !app.includes('neededWidth(') &&
  app.includes('const width = this.widthExplicit && this.settings.channels < max ? this.settings.channels : max;') &&
  snapshotBody.includes('channels: this.settings.channels,') &&
  snapshotBody.includes('widthExplicit: this.widthExplicit,') &&
  afterMaskBody.length > 0 && !afterMaskBody.includes('channels:') && !afterMaskBody.includes('neededWidth');
check('the capture width is explicit state and a mask flip never rewrites it',
  widthWiring,
  `setter=${widthSetterBody.replace(/\s+/g, ' ').trim()}, mask=${afterMaskBody.replace(/\s+/g, ' ').trim()}`);

const busRestoreWiring = constructorBody.includes('id: `bus-${id}`, builder: null, builtFor: null, cache: null') &&
  constructorBody.includes('this.nextBus = this.busViews.length;') &&
  constructorBody.includes('this.bankBusDrafts.set(bank, cloneBusConfig(bus));') &&
  constructorBody.includes('this.syncBankChannels();');
const busMutationWiring = ['addBus', 'updateBus', 'removeBus'].every((name) => {
  const start = app.indexOf(`private ${name}(`);
  const end = start >= 0 ? app.indexOf('\n  }', start) : -1;
  return start >= 0 && end > start && app.slice(start, end).includes('this.afterChannelChange();');
});
check('restored views get fresh IDs/null runtime and all generic/bank mutations share normalized writes',
  busRestoreWiring && busMutationWiring &&
  app.includes('this.settings = clampSettings({ ...this.settings }, this.rateCeilings);'),
  `restore=${busRestoreWiring}, mutations=${busMutationWiring}`);

const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const probe = scripts.find((script) => script.includes("localStorage.getItem('logicweb.workspace')")) ?? '';
const themeAt = html.indexOf("localStorage.getItem('logicweb.theme')");
const panelAt = html.indexOf("localStorage.getItem('logicweb.panelWidth')");
const workspaceAt = html.indexOf("localStorage.getItem('logicweb.workspace')");
const stylesheetAt = html.indexOf('<link rel="stylesheet"');
const probeGuard = probe.includes("try {\n      const workspace = JSON.parse(localStorage.getItem('logicweb.workspace') ?? 'null');") &&
  probe.includes('if (workspace?.version === 1 && workspace.detailedLabels === false)') &&
  probe.includes("document.documentElement.setAttribute('data-toolbar-labels', 'off');") &&
  !probe.includes('setItem') && !probe.includes('removeItem') && !probe.includes('innerHTML');
check('the pre-paint probe follows theme/panel width, precedes CSS, and only honors literal v1 false',
  themeAt >= 0 && panelAt > themeAt && workspaceAt > panelAt && stylesheetAt > workspaceAt && probeGuard,
  `order=${themeAt}/${panelAt}/${workspaceAt}/${stylesheetAt}, guard=${probeGuard}`);

let failures = 0;
for (const result of results) {
  if (!result.pass) failures++;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
if (failures) nodeProcess.exit(1);
