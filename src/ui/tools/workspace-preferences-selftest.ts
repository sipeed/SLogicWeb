import {
  parseWorkspaceSnapshot, readWorkspaceSnapshot, serializeWorkspaceSnapshot,
  WORKSPACE_SCHEMA_VERSION, WORKSPACE_STORAGE_KEY, writeWorkspaceSnapshot,
  type WorkspaceSnapshotV1,
} from '../workspacePreferences.js';
import { defaultChannelName, defaultChannels } from '../state.js';

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
    onRead?.detailedLabels === true && data.get(WORKSPACE_STORAGE_KEY) === '{"version":1,"detailedLabels":true}' &&
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
    serialized === '{"version":1,"detailedLabels":false}' &&
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
    serialized === '{"version":1,"detailedLabels":true,"channels":[{"name":"D0","color":"#010203","enabled":true}],"order":[0]}',
    serialized);
}

const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const constructorStart = app.indexOf('constructor() {');
const constructorEnd = constructorStart >= 0
  ? app.indexOf('\n  // ------------------------------------------------------------------ layout', constructorStart) : -1;
const constructorBody = constructorStart >= 0 && constructorEnd > constructorStart
  ? app.slice(constructorStart, constructorEnd) : '';
const restoreOrder = [
  'applyStaticI18n(document);',
  'readWorkspaceSnapshot()',
  'this.reflectDetailedLabels();',
  'createSampleStore(',
].map((needle) => constructorBody.indexOf(needle));
const restoreHasNoWrite = !constructorBody.includes('this.persistWorkspace();') &&
  !constructorBody.includes('writeWorkspaceSnapshot(');
check('App restores sanitized labels before reflection and initial store creation without writing',
  restoreOrder.every((index, i) => index >= 0 && (i === 0 || index > restoreOrder[i - 1])) && restoreHasNoWrite,
  `order=${JSON.stringify(restoreOrder)}, noWrite=${restoreHasNoWrite}`);

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

const writeMethods = ['afterChannelChange', 'configureChannel', 'reorder', 'adoptCapture', 'adoptDeviceChannels', 'startCapture'];
const missingWriteMethods = writeMethods.filter((name) => {
  const syncStart = app.indexOf(`private ${name}(`);
  const start = syncStart >= 0 ? syncStart : app.indexOf(`private async ${name}(`);
  const end = start >= 0 ? app.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? app.slice(start, end) : '';
  return !body.includes('this.persistWorkspace();');
});
check('all committed channel paths share the writer and the initial empty store covers the whole channel model',
  missingWriteMethods.length === 0 && constructorBody.includes(
    'createSampleStore(channelWidthForProbes(this.channels.length), this.settings.samplerate)') &&
  !constructorBody.includes('createSampleStore(this.settings.channels, this.settings.samplerate)'),
  `missing=${JSON.stringify(missingWriteMethods)}`);

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
