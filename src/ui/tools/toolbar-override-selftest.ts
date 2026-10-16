import {
  applyToolbarOverride,
  clearToolbarOverride,
  getToolbarOverride,
  initToolbarOverride,
  onToolbarOverrideChange,
  sanitizeToolbarOverride,
  setToolbarOverride,
  TOOLBAR_OVERRIDE_LIMITS,
  TOOLBAR_OVERRIDE_STORAGE_KEY,
  type ToolbarOverride,
} from '../toolbarOverride.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

interface StyleOp {
  op: 'set' | 'remove';
  name: string;
  value: string | null;
}

interface StorageOp {
  op: 'get' | 'set' | 'remove';
  key: string;
  value: string | null;
}

interface StorageStub {
  api: Storage;
  ops: StorageOp[];
  data: Map<string, string>;
}

function makeStyle(log: StyleOp[]): CSSStyleDeclaration {
  return {
    setProperty: (name: string, value: string) => { log.push({ op: 'set', name, value }); },
    removeProperty: (name: string) => { log.push({ op: 'remove', name, value: null }); },
  } as unknown as CSSStyleDeclaration;
}

function makeStorage(): StorageStub {
  const data = new Map<string, string>();
  const ops: StorageOp[] = [];
  const api = {
    getItem: (key: string) => {
      ops.push({ op: 'get', key, value: null });
      return data.has(key) ? data.get(key)! : null;
    },
    setItem: (key: string, value: string) => {
      ops.push({ op: 'set', key, value });
      data.set(key, value);
    },
    removeItem: (key: string) => {
      ops.push({ op: 'remove', key, value: null });
      data.delete(key);
    },
  } as unknown as Storage;
  return { api, ops, data };
}

function defineGlobal(name: 'localStorage' | 'document' | 'window', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function installDom(log: StyleOp[]): void {
  defineGlobal('document', { documentElement: { style: makeStyle(log) } });
}

function formatOps(ops: readonly StyleOp[]): string {
  return ops.map((o) => `${o.op}:${o.name}${o.value === null ? '' : `=${o.value}`}`).join(',');
}

function isAllNull(o: ToolbarOverride): boolean {
  return o.height === null && o.minHeight === null && o.minRatio === null;
}

function storageEvent(key: string | null): StorageEvent {
  return { key } as unknown as StorageEvent;
}

let storageListener: ((event: StorageEvent) => void) | null = null;

{
  const limits = TOOLBAR_OVERRIDE_LIMITS;
  const keys = Object.keys(limits).sort().join(',');
  const pass =
    TOOLBAR_OVERRIDE_STORAGE_KEY === 'logicweb.toolbar' &&
    keys === 'height,minHeight,minRatio' &&
    limits.height.min === 24 && limits.height.max === 240 &&
    limits.minHeight.min === 0 && limits.minHeight.max === 240 &&
    limits.minRatio.min === 0 && limits.minRatio.max === 50;
  check('storage key and per-field limits are the exact agreed literals', pass,
    `key=${TOOLBAR_OVERRIDE_STORAGE_KEY}, keys=${keys}, ` +
    `height=${limits.height.min}..${limits.height.max}, ` +
    `minHeight=${limits.minHeight.min}..${limits.minHeight.max}, ` +
    `minRatio=${limits.minRatio.min}..${limits.minRatio.max}`);
}

{
  const boot = getToolbarOverride();
  let initThrew = false;
  let initResult: ToolbarOverride | null = null;
  try {
    initResult = initToolbarOverride();
  } catch {
    initThrew = true;
  }
  let applyThrew = false;
  try {
    applyToolbarOverride({ height: 64, minHeight: 80, minRatio: 8 });
  } catch {
    applyThrew = true;
  }
  const pass = isAllNull(boot) && !initThrew && initResult !== null && isAllNull(initResult) &&
    !applyThrew && isAllNull(getToolbarOverride());
  check('a fresh module boots and touches no storage/DOM before any stub is installed', pass,
    `getToolbarOverride()=${JSON.stringify(boot)}, initThrew=${initThrew}, ` +
    `applyThrew=${applyThrew}, state=${JSON.stringify(getToolbarOverride())}`);
}

{
  const cases: [string, string | null, ToolbarOverride][] = [
    ['null', null, { height: null, minHeight: null, minRatio: null }],
    ['empty object', '{}', { height: null, minHeight: null, minRatio: null }],
    ['corrupt json', '{', { height: null, minHeight: null, minRatio: null }],
    ['array', '[]', { height: null, minHeight: null, minRatio: null }],
    ['number', '42', { height: null, minHeight: null, minRatio: null }],
    ['string', '"x"', { height: null, minHeight: null, minRatio: null }],
    ['boolean', 'true', { height: null, minHeight: null, minRatio: null }],
    ['json null', 'null', { height: null, minHeight: null, minRatio: null }],
    ['string field', '{"height":"64"}', { height: null, minHeight: null, minRatio: null }],
    ['boolean field', '{"height":true}', { height: null, minHeight: null, minRatio: null }],
    ['null field', '{"height":null}', { height: null, minHeight: null, minRatio: null }],
    ['round field', '{"height":64.6}', { height: 65, minHeight: null, minRatio: null }],
    ['clamp low', '{"height":-64}', { height: 24, minHeight: null, minRatio: null }],
    ['clamp high', '{"height":9999}', { height: 240, minHeight: null, minRatio: null }],
    ['minHeight low', '{"minHeight":-5}', { height: null, minHeight: 0, minRatio: null }],
    ['minHeight high', '{"minHeight":300}', { height: null, minHeight: 240, minRatio: null }],
    ['minRatio low', '{"minRatio":-1}', { height: null, minHeight: null, minRatio: 0 }],
    ['minRatio high', '{"minRatio":80}', { height: null, minHeight: null, minRatio: 50 }],
    ['zero is a value', '{"minHeight":0,"minRatio":0}', { height: null, minHeight: 0, minRatio: 0 }],
    ['full object', '{"height":64,"minHeight":80,"minRatio":8}',
      { height: 64, minHeight: 80, minRatio: 8 }],
    ['partial object', '{"height":64,"minHeight":null,"minRatio":null}',
      { height: 64, minHeight: null, minRatio: null }],
    ['unknown key ignored', '{"height":64,"bogus":123}',
      { height: 64, minHeight: null, minRatio: null }],
  ];
  const failures = cases.filter(([, raw, want]) => {
    const got = sanitizeToolbarOverride(raw);
    return got.height !== want.height || got.minHeight !== want.minHeight || got.minRatio !== want.minRatio;
  });
  check('sanitize rejects non-objects/type mismatches and rounds+clamps finite numbers', failures.length === 0,
    failures.length === 0
      ? `${cases.length} sanitize cases matched`
      : `failed=${failures.map(([label, raw]) => `${label}(${JSON.stringify(raw)})`).join(',')}`);
}

{
  const log: StyleOp[] = [];
  const storage = makeStorage();
  defineGlobal('localStorage', storage.api);
  installDom(log);

  let notified = 0;
  const unsubscribe = onToolbarOverrideChange(() => { notified += 1; });

  setToolbarOverride({ height: Number.NaN, minHeight: Number.POSITIVE_INFINITY, minRatio: Number.NEGATIVE_INFINITY });
  const afterNonFinite = getToolbarOverride();

  storage.ops.length = 0;
  log.length = 0;
  notified = 0;

  setToolbarOverride({ height: 1, minHeight: 300, minRatio: -4 });
  const afterClamp = getToolbarOverride();
  const stored = storage.data.get(TOOLBAR_OVERRIDE_STORAGE_KEY) ?? null;
  unsubscribe();

  const pass = isAllNull(afterNonFinite) &&
    afterClamp.height === 24 && afterClamp.minHeight === 240 && afterClamp.minRatio === 0 &&
    stored === '{"height":24,"minHeight":240,"minRatio":0}' &&
    notified === 1 &&
    formatOps(log) === 'set:--toolbar-height=24px,set:--toolbar-min-height=240px,set:--toolbar-min-ratio=0vh';
  check('set drops non-finite fields and clamps programmatic values into range', pass,
    `nonFinite=${JSON.stringify(afterNonFinite)}, clamped=${JSON.stringify(afterClamp)}, ` +
    `stored=${JSON.stringify(stored)}, notified=${notified}, ops=${formatOps(log)}`);
}

{
  const log: StyleOp[] = [];
  const storage = makeStorage();
  defineGlobal('localStorage', storage.api);
  installDom(log);

  clearToolbarOverride();
  storage.ops.length = 0;
  log.length = 0;

  let notified = 0;
  const unsubscribe = onToolbarOverrideChange(() => { notified += 1; });

  setToolbarOverride({ height: 64, minHeight: 80, minRatio: 8 });
  const afterFirst = getToolbarOverride();
  const writes = storage.ops.filter((o) => o.op === 'set' || o.op === 'remove').length;
  const stored = storage.data.get(TOOLBAR_OVERRIDE_STORAGE_KEY) ?? null;
  const opsAfterFirst = formatOps(log);
  const notifiedAfterFirst = notified;

  const writesAfter = storage.ops.length;
  const opsLengthAfter = log.length;
  const notifiedAfter = notified;
  setToolbarOverride({ height: 64, minHeight: 80, minRatio: 8 });
  const noopWrites = storage.ops.length === writesAfter;
  const noopApply = log.length === opsLengthAfter;
  const noopNotify = notified === notifiedAfter;
  unsubscribe();

  check('set persists exact JSON, applies the three inline properties, and notifies once',
    afterFirst.height === 64 && afterFirst.minHeight === 80 && afterFirst.minRatio === 8 &&
    stored === '{"height":64,"minHeight":80,"minRatio":8}' && writes === 1 &&
    notifiedAfterFirst === 1 &&
    opsAfterFirst === 'set:--toolbar-height=64px,set:--toolbar-min-height=80px,set:--toolbar-min-ratio=8vh',
    `state=${JSON.stringify(afterFirst)}, stored=${JSON.stringify(stored)}, writes=${writes}, ` +
    `notified=${notifiedAfterFirst}, ops=${opsAfterFirst}`);

  check('a deep-equal set is a total no-op (no write, no apply, no notify)',
    noopWrites && noopApply && noopNotify,
    `noopWrites=${noopWrites}, noopApply=${noopApply}, noopNotify=${noopNotify}`);
}

{
  const log: StyleOp[] = [];
  const storage = makeStorage();
  defineGlobal('localStorage', storage.api);
  installDom(log);

  storage.ops.length = 0;
  log.length = 0;
  let notified = 0;
  let unsubscribe = onToolbarOverrideChange(() => { notified += 1; });

  setToolbarOverride({ height: null, minHeight: null, minRatio: null });
  const afterSetNull = getToolbarOverride();
  const setNullRemoves = storage.ops.filter((o) => o.op === 'remove').length;
  const setNullWrites = storage.ops.filter((o) => o.op === 'set').length;
  const setNullOps = formatOps(log);
  const setNullNotified = notified;
  unsubscribe();

  setToolbarOverride({ height: 50, minHeight: null, minRatio: 10 });
  storage.ops.length = 0;
  log.length = 0;
  notified = 0;
  unsubscribe = onToolbarOverrideChange(() => { notified += 1; });
  clearToolbarOverride();
  const afterClear = getToolbarOverride();
  const clearRemoves = storage.ops.filter((o) => o.op === 'remove').length;
  const clearOps = formatOps(log);
  const clearNotified = notified;
  const storedAfterClear = storage.data.get(TOOLBAR_OVERRIDE_STORAGE_KEY) ?? null;
  unsubscribe();

  storage.data.set(TOOLBAR_OVERRIDE_STORAGE_KEY, '{');
  storage.ops.length = 0;
  log.length = 0;
  notified = 0;
  unsubscribe = onToolbarOverrideChange(() => { notified += 1; });
  clearToolbarOverride();
  const scrubRemoves = storage.ops.filter((o) => o.op === 'remove').length;
  const scrubOps = formatOps(log);
  const scrubNotified = notified;
  const scrubbed = storage.data.get(TOOLBAR_OVERRIDE_STORAGE_KEY) ?? null;
  unsubscribe();

  check('an all-null set removes the stored key, strips the three properties, and notifies once',
    isAllNull(afterSetNull) && setNullRemoves === 1 && setNullWrites === 0 &&
    setNullNotified === 1 &&
    setNullOps === 'remove:--toolbar-height,remove:--toolbar-min-height,remove:--toolbar-min-ratio',
    `state=${JSON.stringify(afterSetNull)}, removes=${setNullRemoves}, writes=${setNullWrites}, ` +
    `notified=${setNullNotified}, ops=${setNullOps}`);

  check('clear from a non-null state removeItems, strips the properties, and notifies once',
    isAllNull(afterClear) && clearRemoves === 1 && clearNotified === 1 && storedAfterClear === null &&
    clearOps === 'remove:--toolbar-height,remove:--toolbar-min-height,remove:--toolbar-min-ratio',
    `state=${JSON.stringify(afterClear)}, removes=${clearRemoves}, notified=${clearNotified}, ` +
    `stored=${JSON.stringify(storedAfterClear)}, ops=${clearOps}`);

  check('clear always removeItems (scrubbing a tolerated corrupt value) but notifies only on change',
    scrubRemoves === 1 && scrubNotified === 0 && scrubbed === null &&
    scrubOps === 'remove:--toolbar-height,remove:--toolbar-min-height,remove:--toolbar-min-ratio',
    `removes=${scrubRemoves}, notified=${scrubNotified}, stored=${JSON.stringify(scrubbed)}, ops=${scrubOps}`);
}

{
  const log: StyleOp[] = [];
  installDom(log);
  const windowCalls: string[] = [];
  const windowListeners = new Map<string, (event: StorageEvent) => void>();
  defineGlobal('window', {
    addEventListener: (type: string, listener: (event: StorageEvent) => void) => {
      windowCalls.push(type);
      windowListeners.set(type, listener);
    },
  });
  defineGlobal('localStorage', {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
    removeItem: () => { throw new Error('storage denied'); },
  });

  let bootThrew = false;
  let booted: ToolbarOverride | null = null;
  try {
    booted = initToolbarOverride();
  } catch {
    bootThrew = true;
  }

  let notified = 0;
  const unsubscribe = onToolbarOverrideChange(() => { notified += 1; });
  let switchThrew = false;
  try {
    setToolbarOverride({ height: 70, minHeight: null, minRatio: 12 });
  } catch {
    switchThrew = true;
  }
  const afterSwitch = getToolbarOverride();
  unsubscribe();

  const pass = !bootThrew && booted !== null && isAllNull(booted) && !switchThrew &&
    afterSwitch.height === 70 && afterSwitch.minHeight === null && afterSwitch.minRatio === 12 &&
    notified === 1 && windowCalls.join(',') === 'storage';
  storageListener = windowListeners.get('storage') ?? null;
  check('throwing storage never breaks boot or the switch, and memory still changes', pass,
    `bootThrew=${bootThrew}, booted=${JSON.stringify(booted)}, switchThrew=${switchThrew}, ` +
    `state=${JSON.stringify(afterSwitch)}, notified=${notified}, window=${windowCalls.join(',')}`);
}

{
  const log: StyleOp[] = [];
  const storage = makeStorage();
  storage.data.set(TOOLBAR_OVERRIDE_STORAGE_KEY, '{"height":72,"minHeight":90,"minRatio":7}');
  defineGlobal('localStorage', storage.api);
  installDom(log);

  const restored = initToolbarOverride();
  const afterBoot = getToolbarOverride();
  const bootOps = formatOps(log);

  let notified = 0;
  const unsubscribe = onToolbarOverrideChange(() => { notified += 1; });

  storage.data.set(TOOLBAR_OVERRIDE_STORAGE_KEY, '{"height":100,"minRatio":20}');
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent(TOOLBAR_OVERRIDE_STORAGE_KEY));
  const afterKeyEvent = getToolbarOverride();
  const keyOps = formatOps(log);
  const keyNotified = notified;

  storage.data.delete(TOOLBAR_OVERRIDE_STORAGE_KEY);
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent(null));
  const afterNullKeyEvent = getToolbarOverride();
  const nullKeyOps = formatOps(log);
  const nullKeyNotified = notified;

  setToolbarOverride({ height: 50, minHeight: null, minRatio: 5 });
  storage.data.set(TOOLBAR_OVERRIDE_STORAGE_KEY, '{"height":200,"minHeight":10,"minRatio":30}');
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent('logicweb.theme'));
  const afterUnrelatedEvent = getToolbarOverride();
  const unrelatedOps = formatOps(log);
  const unrelatedNotified = notified;

  storage.data.set(TOOLBAR_OVERRIDE_STORAGE_KEY, '{"height":50,"minRatio":5}');
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent(TOOLBAR_OVERRIDE_STORAGE_KEY));
  const afterEqualEvent = getToolbarOverride();
  const equalOps = formatOps(log);
  const equalNotified = notified;

  const reInitCalls: string[] = [];
  defineGlobal('window', {
    addEventListener: (type: string) => { reInitCalls.push(type); },
  });
  const reInit = initToolbarOverride();
  unsubscribe();

  const bootPass = restored.height === 72 && restored.minHeight === 90 && restored.minRatio === 7 &&
    afterBoot.height === 72 && afterBoot.minHeight === 90 && afterBoot.minRatio === 7 &&
    bootOps === 'set:--toolbar-height=72px,set:--toolbar-min-height=90px,set:--toolbar-min-ratio=7vh';
  check('a valid stored override is restored and applied on boot in px/px/vh', bootPass,
    `restored=${JSON.stringify(restored)}, state=${JSON.stringify(afterBoot)}, ops=${bootOps}`);

  const keyPass = afterKeyEvent.height === 100 && afterKeyEvent.minHeight === null &&
    afterKeyEvent.minRatio === 20 && keyNotified === 1 &&
    keyOps === 'set:--toolbar-height=100px,remove:--toolbar-min-height,set:--toolbar-min-ratio=20vh';
  check('a matching storage event applies the externally stored override and notifies once', keyPass,
    `state=${JSON.stringify(afterKeyEvent)}, notified=${keyNotified}, ops=${keyOps}`);

  const nullKeyPass = isAllNull(afterNullKeyEvent) && nullKeyNotified === 1 &&
    nullKeyOps === 'remove:--toolbar-height,remove:--toolbar-min-height,remove:--toolbar-min-ratio';
  check('a null-key storage event (storage.clear()) strips the override and notifies once', nullKeyPass,
    `state=${JSON.stringify(afterNullKeyEvent)}, notified=${nullKeyNotified}, ops=${nullKeyOps}`);

  const unrelatedPass = afterUnrelatedEvent.height === 50 && afterUnrelatedEvent.minHeight === null &&
    afterUnrelatedEvent.minRatio === 5 && unrelatedNotified === 0 && unrelatedOps === '';
  check('an unrelated storage key is a total no-op (no apply, no notify)', unrelatedPass,
    `state=${JSON.stringify(afterUnrelatedEvent)}, notified=${unrelatedNotified}, ops=${unrelatedOps}`);

  const equalPass = afterEqualEvent.height === 50 && afterEqualEvent.minHeight === null &&
    afterEqualEvent.minRatio === 5 && equalNotified === 0 && equalOps === '';
  check('a matching storage event whose value already matches state is a total no-op', equalPass,
    `state=${JSON.stringify(afterEqualEvent)}, notified=${equalNotified}, ops=${equalOps}`);

  const guardPass = storageListener !== null && reInitCalls.length === 0 &&
    reInit.height === 50 && reInit.minHeight === null && reInit.minRatio === 5;
  check('re-initializing does not register a second storage listener', guardPass,
    `captured=${storageListener !== null}, reInitCalls=${reInitCalls.join(',')}, ` +
    `state=${JSON.stringify(reInit)}`);
}

{
  const log: StyleOp[] = [];
  installDom(log);

  applyToolbarOverride({ height: null, minHeight: null, minRatio: null });
  const allNullOps = [...log];
  log.length = 0;

  applyToolbarOverride({ height: 50, minHeight: null, minRatio: 10 });
  const mixedOps = [...log];
  log.length = 0;

  applyToolbarOverride({ height: null, minHeight: 96, minRatio: null });
  const mixedTwoOps = [...log];

  const names = ['--toolbar-height', '--toolbar-min-height', '--toolbar-min-ratio'];
  const named = (ops: readonly StyleOp[]) => ops.every((o) => names.includes(o.name));
  const allNullPass = allNullOps.length === 3 && allNullOps.every((o) => o.op === 'remove') &&
    allNullOps.map((o) => o.name).join(',') === names.join(',');
  const mixedPass = mixedOps.length === 3 &&
    mixedOps[0]?.op === 'set' && mixedOps[0]?.name === '--toolbar-height' && mixedOps[0]?.value === '50px' &&
    mixedOps[1]?.op === 'remove' && mixedOps[1]?.name === '--toolbar-min-height' &&
    mixedOps[2]?.op === 'set' && mixedOps[2]?.name === '--toolbar-min-ratio' && mixedOps[2]?.value === '10vh';
  const mixedTwoPass = mixedTwoOps.length === 3 &&
    mixedTwoOps[0]?.op === 'remove' && mixedTwoOps[0]?.name === '--toolbar-height' &&
    mixedTwoOps[1]?.op === 'set' && mixedTwoOps[1]?.name === '--toolbar-min-height' &&
    mixedTwoOps[1]?.value === '96px' &&
    mixedTwoOps[2]?.op === 'remove' && mixedTwoOps[2]?.name === '--toolbar-min-ratio';
  const pass = allNullPass && mixedPass && mixedTwoPass &&
    named(allNullOps) && named(mixedOps) && named(mixedTwoOps);
  check('apply is a pure reflection: three properties, set when non-null, remove when null', pass,
    `allNull=${formatOps(allNullOps)}, mixed=${formatOps(mixedOps)}, mixedTwo=${formatOps(mixedTwoOps)}`);
}

{
  const css = fs.readFileSync('src/ui/style.css', 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const toolbarStart = code.indexOf('#toolbar {');
  const mainStart = code.indexOf('#main {');
  const toolbar = toolbarStart >= 0 && mainStart > toolbarStart ? code.slice(toolbarStart, mainStart) : '';
  const needles = [
    'min-height: max(var(--toolbar-min-height, var(--toolbar-h)), var(--toolbar-min-ratio, 0px));',
    'height: var(--toolbar-height, auto);',
  ];
  const missing = needles.filter((needle) => !toolbar.includes(needle));
  const factory = code.includes('--toolbar-h: 57px;');
  check('style.css composes the override in the two #toolbar declarations above #main',
    missing.length === 0 && factory,
    `missing=${JSON.stringify(missing)}, factoryToolbarH=${factory}, slice=${toolbar.length}`);
}

{
  const main = fs.readFileSync('src/ui/main.ts', 'utf8');
  const importNeedle = "import { initToolbarOverride } from './toolbarOverride.js';";
  const callNeedle = 'initToolbarOverride();';
  const hasImport = main.includes(importNeedle);
  const hasCall = main.includes(callNeedle);
  const discovery = /uictrl/i.test(main);
  check('src/ui/main.ts imports and boots the override module and mentions no console',
    hasImport && hasCall && !discovery,
    `import=${hasImport}, call=${hasCall}, discovery=${discovery}`);
}

{
  const html = fs.readFileSync('index.html', 'utf8');
  const discovery = /uictrl/i.test(html);
  check('root index.html keeps no console discovery reference', !discovery,
    `discovery=${discovery}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
