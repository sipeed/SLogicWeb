import {
  applyPanelWidth,
  clampPanelWidth,
  getPanelWidth,
  initPanelWidth,
  maxPanelWidth,
  onPanelWidthChange,
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_RESERVE,
  PANEL_WIDTH_STEP,
  PANEL_WIDTH_STORAGE_KEY,
  sanitizePanelWidth,
  setPanelWidth,
  widthFromKey,
  widthFromPointer,
} from '../panelWidth.js';

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

type StorageListener = (event: StorageEvent) => void;

const WIDTH_PROPERTY = '--side-panel-w';

function makeStyle(log: StyleOp[]): CSSStyleDeclaration {
  return {
    setProperty: (name: string, value: string) => { log.push({ op: 'set', name, value }); },
    removeProperty: (name: string) => { log.push({ op: 'remove', name, value: null }); },
  } as unknown as CSSStyleDeclaration;
}

function makeReflectingStyle(log: StyleOp[]): CSSStyleDeclaration {
  const props = new Map<string, string>();
  const style = {
    setProperty: (name: string, value: string) => {
      log.push({ op: 'set', name, value });
      props.set(name, value);
    },
    removeProperty: (name: string) => {
      log.push({ op: 'remove', name, value: null });
      props.delete(name);
    },
    get cssText(): string {
      return [...props.entries()].map(([name, value]) => `${name}: ${value};`).join(' ');
    },
  };
  return style as unknown as CSSStyleDeclaration;
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

function storageEvent(key: string | null): StorageEvent {
  return { key } as unknown as StorageEvent;
}

let storageListener: StorageListener | null = null;

{
  const ordered = PANEL_WIDTH_MIN < PANEL_WIDTH_DEFAULT && PANEL_WIDTH_DEFAULT < PANEL_WIDTH_MAX;
  const pass = PANEL_WIDTH_STORAGE_KEY === 'logicweb.panelWidth' &&
    PANEL_WIDTH_DEFAULT === 296 && PANEL_WIDTH_MIN === 240 && PANEL_WIDTH_MAX === 560 &&
    PANEL_WIDTH_RESERVE === 320 && PANEL_WIDTH_STEP === 16 && ordered;
  check('storage key and width constants are the exact agreed literals', pass,
    `key=${PANEL_WIDTH_STORAGE_KEY}, default=${PANEL_WIDTH_DEFAULT}, min=${PANEL_WIDTH_MIN}, ` +
    `max=${PANEL_WIDTH_MAX}, reserve=${PANEL_WIDTH_RESERVE}, step=${PANEL_WIDTH_STEP}, ordered=${ordered}`);
}

{
  const boot = getPanelWidth();
  let initThrew = false;
  let initResult: number | null = 420;
  try {
    initResult = initPanelWidth();
  } catch {
    initThrew = true;
  }
  let applyThrew = false;
  try {
    applyPanelWidth(420);
  } catch {
    applyThrew = true;
  }
  check('a fresh module boots with no override and touches no storage/DOM before the stubs',
    boot === null && !initThrew && initResult === null && !applyThrew && getPanelWidth() === null,
    `getPanelWidth()=${boot}, init=${initResult}, initThrew=${initThrew}, applyThrew=${applyThrew}`);
}

{
  const cases: [string, string | null, number | null][] = [
    ['null', null, null],
    ['empty', '', null],
    ['blank', '   ', null],
    ['letters', 'abc', null],
    ['nan literal', 'NaN', null],
    ['zero', '0', null],
    ['negative', '-5', null],
    ['negative fraction', '-420.7', null],
    ['infinity', 'Infinity', null],
    ['round', '420.7', 421],
    ['clamp high', '9999', 560],
    ['clamp low', '100', 240],
    ['padded', ' 420 ', 420],
    ['factory default', '296', 296],
  ];
  const failures = cases.filter(([, raw, want]) => sanitizePanelWidth(raw) !== want);
  check('sanitize treats non-positive/unparseable as absent and clamps positive values', failures.length === 0,
    failures.length === 0
      ? `${cases.length} sanitize cases matched`
      : `failed=${failures.map(([label, raw]) => `${label}(${JSON.stringify(raw)})=${sanitizePanelWidth(raw)}`).join(',')}`);
}

{
  const clampCases: [number, number][] = [
    [0, PANEL_WIDTH_MIN], [-5, PANEL_WIDTH_MIN], [240, 240], [296, 296], [420.4, 420],
    [559.6, 560], [9999, PANEL_WIDTH_MAX], [Number.NaN, PANEL_WIDTH_DEFAULT],
    [Number.POSITIVE_INFINITY, PANEL_WIDTH_DEFAULT],
  ];
  const clampFailures = clampCases.filter(([input, want]) => clampPanelWidth(input) !== want);
  const maxCases: [number, number][] = [
    [1200, 560], [800, 480], [761, 441], [600, 280], [500, 240], [320, 240], [100, 240],
  ];
  const maxFailures = maxCases.filter(([rowWidth, want]) => maxPanelWidth(rowWidth) !== want);
  check('clampPanelWidth rounds+clamps and maxPanelWidth keeps the reserve on the row',
    clampFailures.length === 0 && maxFailures.length === 0,
    `clampFailed=${JSON.stringify(clampFailures)}, maxFailed=${JSON.stringify(maxFailures)}, ` +
    `max(1200)=${maxPanelWidth(1200)}, max(600)=${maxPanelWidth(600)}, max(500)=${maxPanelWidth(500)}`);
}

{
  setPanelWidth(500);
  const applied = getPanelWidth();
  const grow = widthFromPointer(296, 500, 400, 560);
  const shrink = widthFromPointer(296, 500, 600, 560);
  const pastUpper = widthFromPointer(296, 500, 0, 560);
  const pastLower = widthFromPointer(296, 500, 900, 560);
  const rowCap = widthFromPointer(296, 500, 300, 400);
  const beyondCap = widthFromPointer(296, 500, 0, 400);
  const backInside = widthFromPointer(296, 500, 400, 400);
  const otherStart = widthFromPointer(320, 500, 400, 560);
  check('widthFromPointer is an absolute delta from the drag start: leftward grows, both ends clamp, no drift across the cap, the applied width is ignored',
    applied === 500 && grow === 396 && shrink === PANEL_WIDTH_MIN && pastUpper === PANEL_WIDTH_MAX &&
    pastLower === PANEL_WIDTH_MIN && rowCap === 400 && beyondCap === 400 && backInside === 396 &&
    otherStart === 420,
    `applied=${applied}, grow=${grow}, shrink=${shrink}, pastUpper=${pastUpper}, ` +
    `pastLower=${pastLower}, rowCap=${rowCap}, beyondCap=${beyondCap}, ` +
    `backInside=${backInside}, otherStart=${otherStart}`);
}

{
  const cases: [string, number, string, boolean, number, number | null][] = [
    ['arrow left', 300, 'ArrowLeft', false, 560, 316],
    ['arrow right', 300, 'ArrowRight', false, 560, 284],
    ['shift left', 300, 'ArrowLeft', true, 560, 364],
    ['shift right at floor', 300, 'ArrowRight', true, 560, 240],
    ['left past ceiling', 550, 'ArrowLeft', true, 560, 560],
    ['right below floor', 250, 'ArrowRight', false, 560, 240],
    ['home', 420, 'Home', false, 560, 240],
    ['end', 300, 'End', false, 560, 560],
    ['end on a narrow row', 300, 'End', false, 480, 480],
    ['enter resets', 420, 'Enter', false, 560, PANEL_WIDTH_DEFAULT],
    ['space resets', 420, ' ', false, 560, PANEL_WIDTH_DEFAULT],
    ['zoom-to-fit passthrough', 420, 'f', false, 560, null],
    ['select-all passthrough', 420, 'a', false, 560, null],
    ['escape passthrough', 420, 'Escape', false, 560, null],
  ];
  const failures = cases.filter(([, width, key, shift, maxWidth, want]) =>
    widthFromKey(width, key, shift, maxWidth) !== want);
  check('widthFromKey steps/clamps the arrows, bounds End to the row, resets on Enter/Space',
    failures.length === 0,
    failures.length === 0
      ? `${cases.length} key cases matched`
      : `failed=${failures.map(([label, width, key, shift, maxWidth]) =>
        `${label}=${widthFromKey(width, key, shift, maxWidth)}`).join(',')}`);
}

{
  const log: StyleOp[] = [];
  const storage = makeStorage();
  defineGlobal('localStorage', storage.api);
  installDom(log);

  let notified = 0;
  const unsubscribe = onPanelWidthChange(() => { notified += 1; });

  setPanelWidth(420);
  const firstStored = storage.data.get(PANEL_WIDTH_STORAGE_KEY) ?? null;
  const firstOps = formatOps(log);
  const firstNotified = notified;

  storage.ops.length = 0;
  log.length = 0;
  notified = 0;
  setPanelWidth(420);
  const noopWrites = storage.ops.length;
  const noopOps = formatOps(log);
  const noopNotified = notified;

  setPanelWidth(PANEL_WIDTH_DEFAULT);
  const defaultRemoves = storage.ops.filter((o) => o.op === 'remove').length;
  const defaultStored = storage.data.get(PANEL_WIDTH_STORAGE_KEY) ?? null;
  const defaultOps = formatOps(log);
  const defaultNotified = notified;

  storage.ops.length = 0;
  log.length = 0;
  notified = 0;
  setPanelWidth(9999);
  const cappedStored = storage.data.get(PANEL_WIDTH_STORAGE_KEY) ?? null;
  const cappedOps = formatOps(log);
  const cappedNotified = notified;

  storage.ops.length = 0;
  log.length = 0;
  notified = 0;
  setPanelWidth(null);
  const nullRemoves = storage.ops.filter((o) => o.op === 'remove').length;
  const nullStored = storage.data.get(PANEL_WIDTH_STORAGE_KEY) ?? null;
  const nullOps = formatOps(log);
  const nullNotified = notified;

  unsubscribe();
  storage.ops.length = 0;
  log.length = 0;
  notified = 0;
  setPanelWidth(300);
  const afterUnsubscribe = notified;

  check('setPanelWidth persists a bare integer, reflects one property, and notifies once',
    firstStored === '420' && firstOps === `set:${WIDTH_PROPERTY}=420px` && firstNotified === 1,
    `stored=${JSON.stringify(firstStored)}, ops=${firstOps}, notified=${firstNotified}`);

  check('a same-width set is a total no-op (no write, no apply, no notify)',
    noopWrites === 0 && noopOps === '' && noopNotified === 0,
    `writes=${noopWrites}, ops=${noopOps}, notified=${noopNotified}`);

  check('the factory default collapses to absence: removeItem plus removeProperty',
    defaultRemoves === 1 && defaultStored === null && defaultNotified === 1 &&
    defaultOps === `remove:${WIDTH_PROPERTY}`,
    `removes=${defaultRemoves}, stored=${JSON.stringify(defaultStored)}, ` +
    `ops=${defaultOps}, notified=${defaultNotified}`);

  check('an out-of-range programmatic width is stored clamped, not rejected',
    cappedStored === '560' && cappedOps === `set:${WIDTH_PROPERTY}=560px` && cappedNotified === 1,
    `stored=${JSON.stringify(cappedStored)}, ops=${cappedOps}, notified=${cappedNotified}`);

  check('setPanelWidth(null) clears the stored override and the inline property',
    nullRemoves === 1 && nullStored === null && nullNotified === 1 &&
    nullOps === `remove:${WIDTH_PROPERTY}`,
    `removes=${nullRemoves}, stored=${JSON.stringify(nullStored)}, ops=${nullOps}, ` +
    `notified=${nullNotified}`);

  check('the unsubscribe returned by onPanelWidthChange stops further notifications',
    afterUnsubscribe === 0 && getPanelWidth() === 300,
    `notified=${afterUnsubscribe}, state=${getPanelWidth()}`);
}

{
  const log: StyleOp[] = [];
  const doc = { documentElement: { style: makeReflectingStyle(log) } };
  defineGlobal('document', doc);

  applyPanelWidth(null);
  const cleanOps = formatOps(log);
  const cleanCssText = doc.documentElement.style.cssText;

  log.length = 0;
  applyPanelWidth(420);
  const setCssText = doc.documentElement.style.cssText;

  log.length = 0;
  applyPanelWidth(null);
  const clearedCssText = doc.documentElement.style.cssText;
  const clearedOps = formatOps(log);

  check('apply is a pure reflection: a null apply leaves a clean document untouched',
    cleanOps === `remove:${WIDTH_PROPERTY}` && cleanCssText === '' &&
    setCssText === `${WIDTH_PROPERTY}: 420px;` && clearedCssText === '' &&
    clearedOps === `remove:${WIDTH_PROPERTY}`,
    `cleanOps=${cleanOps}, cleanCssText=${JSON.stringify(cleanCssText)}, ` +
    `setCssText=${JSON.stringify(setCssText)}, clearedCssText=${JSON.stringify(clearedCssText)}`);
}

{
  const log: StyleOp[] = [];
  installDom(log);
  defineGlobal('localStorage', {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
    removeItem: () => { throw new Error('storage denied'); },
  });

  let bootThrew = false;
  let booted: number | null = 420;
  try {
    booted = initPanelWidth();
  } catch {
    bootThrew = true;
  }

  let setThrew = false;
  try {
    setPanelWidth(420);
  } catch {
    setThrew = true;
  }
  const afterSet = getPanelWidth();

  let clearThrew = false;
  try {
    setPanelWidth(null);
  } catch {
    clearThrew = true;
  }
  const afterClear = getPanelWidth();

  check('throwing storage never breaks boot, set, or reset, and the in-memory width still changes',
    !bootThrew && booted === null && !setThrew && afterSet === 420 && !clearThrew && afterClear === null,
    `bootThrew=${bootThrew}, booted=${booted}, setThrew=${setThrew}, afterSet=${afterSet}, ` +
    `clearThrew=${clearThrew}, afterClear=${afterClear}`);
}

{
  const log: StyleOp[] = [];
  const storage = makeStorage();
  storage.data.set(PANEL_WIDTH_STORAGE_KEY, '350');
  defineGlobal('localStorage', storage.api);
  installDom(log);

  const windowCalls: string[] = [];
  const windowListeners = new Map<string, StorageListener>();
  defineGlobal('window', {
    addEventListener: (type: string, listener: StorageListener) => {
      windowCalls.push(type);
      windowListeners.set(type, listener);
    },
  });

  const restored = initPanelWidth();
  const bootOps = formatOps(log);
  storageListener = windowListeners.get('storage') ?? null;

  check('a stored width is restored and applied on boot in px',
    restored === 350 && getPanelWidth() === 350 && bootOps === `set:${WIDTH_PROPERTY}=350px` &&
    storageListener !== null && windowCalls.join(',') === 'storage',
    `restored=${restored}, state=${getPanelWidth()}, ops=${bootOps}, ` +
    `listener=${storageListener !== null}, window=${windowCalls.join(',')}`);

  let notified = 0;
  const unsubscribe = onPanelWidthChange(() => { notified += 1; });

  storage.data.set(PANEL_WIDTH_STORAGE_KEY, '420.7');
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent(PANEL_WIDTH_STORAGE_KEY));
  const afterKey = getPanelWidth();
  const keyOps = formatOps(log);
  const keyNotified = notified;

  storage.data.set(PANEL_WIDTH_STORAGE_KEY, '500');
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent('logicweb.theme'));
  const afterUnrelated = getPanelWidth();
  const unrelatedOps = formatOps(log);
  const unrelatedNotified = notified;

  storage.data.set(PANEL_WIDTH_STORAGE_KEY, '421');
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent(PANEL_WIDTH_STORAGE_KEY));
  const afterEqual = getPanelWidth();
  const equalOps = formatOps(log);
  const equalNotified = notified;

  storage.data.delete(PANEL_WIDTH_STORAGE_KEY);
  log.length = 0;
  notified = 0;
  storageListener?.(storageEvent(null));
  const afterNullKey = getPanelWidth();
  const nullKeyOps = formatOps(log);
  const nullKeyNotified = notified;

  storage.data.set(PANEL_WIDTH_STORAGE_KEY, '300');
  log.length = 0;
  notified = 0;
  const reInit = initPanelWidth();
  const reInitOps = formatOps(log);
  const reInitNotified = notified;
  unsubscribe();

  check('a matching storage event adopts the sanitized external width and notifies once',
    afterKey === 421 && keyOps === `set:${WIDTH_PROPERTY}=421px` && keyNotified === 1,
    `state=${afterKey}, ops=${keyOps}, notified=${keyNotified}`);

  check('an unrelated storage key is a total no-op (no apply, no notify)',
    afterUnrelated === 421 && unrelatedOps === '' && unrelatedNotified === 0,
    `state=${afterUnrelated}, ops=${unrelatedOps}, notified=${unrelatedNotified}`);

  check('a storage event whose value already matches the applied width is a total no-op',
    afterEqual === 421 && equalOps === '' && equalNotified === 0,
    `state=${afterEqual}, ops=${equalOps}, notified=${equalNotified}`);

  check('a null-key storage event (storage.clear()) drops the override and notifies once',
    afterNullKey === null && nullKeyOps === `remove:${WIDTH_PROPERTY}` && nullKeyNotified === 1,
    `state=${afterNullKey}, ops=${nullKeyOps}, notified=${nullKeyNotified}`);

  check('re-initializing does not register a second storage listener',
    reInit === 300 && reInitOps === `set:${WIDTH_PROPERTY}=300px` && windowCalls.length === 1 &&
    reInitNotified === 0,
    `reInit=${reInit}, ops=${reInitOps}, addEventListenerCalls=${windowCalls.length}, ` +
    `notified=${reInitNotified}`);
}

interface FsLike {
  readFileSync(p: string, enc: 'utf8'): string;
  existsSync(p: string): boolean;
}

interface SourceRange {
  start: number;
  end: number;
}

function readSource(path: string): string {
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  return fs.readFileSync(path, 'utf8');
}

function hasSource(path: string): boolean {
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.existsSync !== 'function') return false;
  return fs.existsSync(path);
}

function readStyleCode(): string {
  return readSource('src/ui/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
}

function mediaRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('@media', from);
    if (start === -1) break;
    const brace = source.indexOf('{', start);
    const end = brace === -1 ? -1 : source.indexOf('\n}', brace);
    if (brace === -1 || end === -1) break;
    ranges.push({ start, end });
    from = end + 1;
  }
  return ranges;
}

function topLevelRules(source: string, selector: string, media: readonly SourceRange[]): string[] {
  const rules: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`${selector} {`, from);
    if (start === -1) break;
    const end = source.indexOf('}', start);
    if (end === -1 || end <= start) break;
    const insideMedia = media.some((range) => start > range.start && start < range.end);
    if (!insideMedia) rules.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return rules;
}

function mediaRule(source: string, selector: string, media: readonly SourceRange[]): string {
  for (const range of media) {
    const block = source.slice(range.start, range.end);
    const start = block.indexOf(`${selector} {`);
    if (start === -1) continue;
    const end = block.indexOf('}', start);
    if (end > start) return block.slice(start, end + 1);
  }
  return '';
}

function mediaBlocks(source: string, query: string): string[] {
  return mediaRanges(source)
    .map((range) => source.slice(range.start, range.end))
    .filter((block) => block.startsWith(`@media ${query}`));
}

function readIndexHtml(): string {
  return readSource('index.html');
}

{
  const css = readStyleCode();
  const media = mediaRanges(css);
  const rootRules = topLevelRules(css, ':root', media);
  const metricsRoot = rootRules.find((rule) => rule.includes('--panel-w:')) ?? '';
  const factoryMirror = metricsRoot.includes(`--panel-w: ${PANEL_WIDTH_DEFAULT}px;`);
  const reserveNeedle = `--panel-reserve-w: ${PANEL_WIDTH_RESERVE}px;`;
  const reserveInRoot = metricsRoot.includes(reserveNeedle);
  const overrideDeclaredInCss = rootRules.some((rule) => rule.includes('--side-panel-w:'));
  check('style.css: :root keeps the factory --panel-w mirror, declares the reserve, and never declares the runtime override',
    factoryMirror && reserveInRoot && !overrideDeclaredInCss,
    `rootBlocks=${rootRules.length}, factoryMirror=${factoryMirror}, ` +
    `reserve=${JSON.stringify(reserveNeedle)}=${reserveInRoot}, ` +
    `overrideDeclared=${overrideDeclaredInCss}`);
}

{
  const css = readStyleCode();
  const media = mediaRanges(css);
  const mainRule = topLevelRules(css, '#main', media)[0] ?? '';
  const chainNeedle =
    '--panel-effective-w: min(var(--side-panel-w, var(--panel-w)), calc(100% - var(--panel-reserve-w)));';
  check('style.css: #main exposes the effective width as the override/fallback chain capped by the reserve',
    mainRule.includes(chainNeedle),
    `chain=${JSON.stringify(chainNeedle)}=${mainRule.includes(chainNeedle)}, mainRule=${mainRule.length}ch`);
}

{
  const css = readStyleCode();
  const media = mediaRanges(css);
  const desktopRules = topLevelRules(css, '#side-panel', media);
  const desktopRule = desktopRules.find((rule) => rule.includes('--panel-effective-w')) ?? '';
  const widthRetargeted = desktopRule.includes('width: var(--panel-effective-w);');
  const minWidthRetargeted = desktopRule.includes('min-width: var(--panel-effective-w);');
  const factoryMetricRetired = desktopRules.length > 0 &&
    !desktopRules.some((rule) => rule.includes('var(--panel-w)'));
  const mobileRule = mediaRule(css, '#side-panel', media);
  const mobileLiteral = mobileRule.includes('width: min(var(--panel-w), 100%);');
  const mobileIgnoresOverride = !mobileRule.includes('--panel-effective-w');
  check('style.css: the in-flow side panel reads the effective width, the factory metric is retired there, the overlay literal survives',
    widthRetargeted && minWidthRetargeted && factoryMetricRetired && mobileLiteral &&
    mobileIgnoresOverride && desktopRules.length > 0,
    `desktopRules=${desktopRules.length}, width=${widthRetargeted}, minWidth=${minWidthRetargeted}, ` +
    `factoryRetired=${factoryMetricRetired}, mobileLiteral=${mobileLiteral}, ` +
    `mobileIgnoresOverride=${mobileIgnoresOverride}`);
}

{
  const css = readStyleCode();
  const themedVars = ['--side-panel-w', '--panel-reserve-w', '--panel-effective-w'];
  const offenders: string[] = [];
  let darkBlocks = 0;
  let from = 0;
  for (;;) {
    const open = css.indexOf('html[data-theme="dark"]', from);
    if (open === -1) break;
    const brace = css.indexOf('{', open);
    const close = brace === -1 ? -1 : css.indexOf('}', brace);
    if (brace === -1 || close === -1) break;
    darkBlocks += 1;
    const body = css.slice(brace + 1, close);
    for (const variable of themedVars) {
      if (new RegExp(`${variable}\\s*:`).test(body)) offenders.push(variable);
    }
    from = close + 1;
  }
  check('style.css: no dark block redefines the width override, the reserve, or the effective width',
    darkBlocks > 0 && offenders.length === 0,
    `darkBlocks=${darkBlocks}, offenders=${offenders.join(',') || '(none)'}`);
}

{
  const css = readStyleCode();
  const base = /(?:^|\n)#panel-resizer \{([^}]*)\}/.exec(css)?.[0] ?? '';
  const needles = [
    'position: absolute',
    'right: calc(var(--panel-effective-w) - 3px)',
    'width: 6px',
    'cursor: col-resize',
    'touch-action: none',
  ];
  const missing = needles.filter((needle) => !base.includes(needle));
  check('style.css: the resize handle is an out-of-flow 6px hit box centred on the panel seam',
    base !== '' && missing.length === 0,
    `missing=${JSON.stringify(missing)}, base=${JSON.stringify(base.replace(/\s+/g, ' ').slice(0, 200))}`);
}

{
  const css = readStyleCode();
  const media = mediaRanges(css);
  const hiddenRule = topLevelRules(css, '#panel-resizer.hidden', media)[0] ?? '';
  const guardRule =
    topLevelRules(css, '#main:has(> #side-panel.hidden) > #panel-resizer', media)[0] ?? '';
  const resizingRule = topLevelRules(css, 'html.resizing', media)[0] ?? '';
  const hiddenOk = hiddenRule.includes('display: none');
  const guardOk = guardRule === '' && !css.includes(':has(> #side-panel.hidden)');
  const resizingOk = resizingRule.includes('cursor: col-resize') &&
    resizingRule.includes('user-select: none');
  check('style.css: the handle hides through its own class only - the temporary :has() panel guard is gone - and html.resizing owns the drag cursor',
    hiddenOk && guardOk && resizingOk,
    `hidden=${hiddenOk}(${JSON.stringify(hiddenRule)}), guardGone=${guardOk}(${JSON.stringify(guardRule)}), ` +
    `resizing=${resizingOk}(${JSON.stringify(resizingRule)})`);
}

{
  const css = readStyleCode();
  const mobile = mediaBlocks(css, '(max-width: 760px)');
  const withHandle = mobile.filter((block) => block.includes('#panel-resizer'));
  const handleBlock = withHandle[0] ?? '';
  const overlayBlock = mobile.find((block) => block.includes('min(var(--panel-w), 100%)')) ?? '';
  check('style.css: the handle is hidden in its own 760px block, never appended to the existing responsive block',
    mobile.length >= 2 && withHandle.length === 1 && handleBlock.includes('#panel-resizer {') &&
    handleBlock.includes('display: none') && overlayBlock !== '' &&
    !overlayBlock.includes('#panel-resizer'),
    `mobileBlocks=${mobile.length}, withHandle=${withHandle.length}, overlay=${overlayBlock !== ''}, ` +
    `overlayMentionsHandle=${overlayBlock.includes('#panel-resizer')}, ` +
    `block=${JSON.stringify(handleBlock.replace(/\s+/g, ' ').slice(0, 120))}`);
}

{
  const html = readIndexHtml();
  const tag = /<div[^>]*\bid="panel-resizer"[^>]*>/.exec(html)?.[0] ?? '';
  const attributes = [
    'role="separator"',
    'aria-orientation="vertical"',
    'tabindex="0"',
    'aria-controls="side-panel"',
    'aria-label="Resize sidebar"',
    'data-i18n-aria-label="panel.resizeLabel"',
    'data-i18n-title="panel.resizeTitle"',
  ];
  const missing = attributes.filter((attribute) => !tag.includes(attribute));
  check('index.html: the resize handle is a focusable vertical separator bound to #side-panel',
    tag !== '' && missing.length === 0,
    `missing=${JSON.stringify(missing)}, tag=${JSON.stringify(tag.replace(/\s+/g, ' ').slice(0, 240))}`);
}

{
  const html = readIndexHtml();
  const scroll = html.indexOf('id="scroll-area"');
  const handle = html.indexOf('id="panel-resizer"');
  const panel = html.indexOf('id="side-panel"');
  check('index.html: the handle sits between the scroll area and the side panel',
    scroll !== -1 && handle !== -1 && panel !== -1 && scroll < handle && handle < panel,
    `scroll-area=${scroll}, panel-resizer=${handle}, side-panel=${panel}`);
}

{
  const html = readIndexHtml();
  const needle = `getItem('${PANEL_WIDTH_STORAGE_KEY}')`;
  const needleAt = html.indexOf(needle);
  const linkAt = html.indexOf('<link rel="stylesheet"');
  const scriptStart = needleAt === -1 ? -1 : html.lastIndexOf('<script>', needleAt);
  const scriptEnd = scriptStart === -1 ? -1 : html.indexOf('</script>', scriptStart);
  const script = scriptStart !== -1 && scriptEnd > scriptStart
    ? html.slice(scriptStart, scriptEnd)
    : '';
  const clampNeedle = `Math.min(${PANEL_WIDTH_MAX}, Math.max(${PANEL_WIDTH_MIN}, Math.round(`;
  const mirrors = script.includes(`setProperty('--side-panel-w'`) &&
    script.includes('Number.isFinite(') && script.includes(clampNeedle) &&
    !script.includes('--panel-w');
  check('index.html restores the stored width before the stylesheet, clamped into the sibling property and never the factory metric',
    needleAt !== -1 && linkAt !== -1 && needleAt < linkAt && script !== '' && mirrors,
    `needle=${JSON.stringify(needle)}, needleAt=${needleAt}, linkAt=${linkAt}, ` +
    `scriptFound=${script !== ''}, mirrors=${mirrors}`);
}

{
  const app = readSource('src/ui/app.ts');
  const needles = [
    "must<HTMLDivElement>('panel-resizer')",
    'new PanelResizer(',
    'setHidden(this.panel === null)',
  ];
  const missing = needles.filter((needle) => !app.includes(needle));
  check('app.ts owns the handle element, constructs the resizer, and hides it with the same panel source of truth',
    missing.length === 0,
    `missing=${JSON.stringify(missing)}`);
}

{
  const exists = hasSource('src/ui/panelResizer.ts');
  const resizer = exists ? readSource('src/ui/panelResizer.ts') : '';
  const needles = [
    'setPointerCapture(',
    'lostpointercapture',
    'AbortController',
    'stopPropagation()',
    'onPanelWidthChange(',
    'setHidden(',
  ];
  const missing = needles.filter((needle) => !resizer.includes(needle));
  check('panelResizer.ts exists and wires capture, a cancellable drag, consumed keys, and the width-change subscription',
    exists && missing.length === 0,
    `exists=${exists}, missing=${JSON.stringify(missing)}`);
  const filtered = (resizer.match(/pointerId !== /g) ?? []).length;
  check('panelResizer.ts ignores pointer events that belong to a pointer other than the drag owner',
    exists && filtered === 4,
    `pointerIdFilters=${filtered}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
