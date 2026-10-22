// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the theme core suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/theme-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/theme-selftest.mjs && node /tmp/theme-selftest.mjs
 *
 * Run from the repository root. Prints PASS/FAIL per check and exits non-zero on any
 * failure.
 *
 * What is pinned here:
 *
 *   - the theme registry (default,dark,light), the mode registry (light,dark,system),
 *     and the storage-key literal;
 *   - pickMode falls back to dark for absent/unknown values and migrates a stored
 *     legacy 'default' pick to dark; resolveMode maps system through the explicit
 *     systemDark argument (the no-matchMedia fallback resolves to dark);
 *   - every theme id and every mode has a label key that exists (non-empty) in the
 *     English catalog;
 *   - a fresh module boots to mode dark + resolved dark - asserted BEFORE any stub
 *     injection, so the node-safety of module evaluation is part of the pass;
 *   - setMode persists the mode, applies the resolved <html> attribute only when the
 *     resolved id changes, and notifies on every real mode change (the button icon
 *     follows the mode even when the resolved id is unchanged); a same-mode pick is
 *     a silent no-op (no write, no notify);
 *   - the returned unsubscribe stops further notifications;
 *   - initTheme never notifies on boot, resolves a stored 'system' pick through the
 *     stubbed matchMedia, and installs exactly ONE matchMedia-change listener and ONE
 *     storage listener across repeated calls (the latch);
 *   - the matchMedia listener re-resolves only while mode is 'system' and only when
 *     the resolved id actually flips (explicit modes get zero notifications);
 *   - the storage listener adopts the MODE from other tabs (key match or null),
 *     re-resolves locally, ignores unrelated keys and same-mode writes;
 *   - a storage whose getItem/setItem throw does not break boot or the switch;
 *   - index.html resolves the persisted mode (including 'system' via matchMedia)
 *     BEFORE the stylesheet link, keyed by THEME_STORAGE_KEY's actual value;
 *   - style.css keeps every themed rule scoped to [data-theme="dark"] /
 *     [data-theme="light"] (never default), theme blocks never redefine the chrome
 *     metric variables, the light token block matches LIGHT_CHROME_TOKENS exactly,
 *     and both token blocks carry their color-scheme;
 *   - the channel-card geometry stays wired: neutral display:contents wrappers, the
 *     themed card's --ch-lane-offset margin, the reserved 14px decoder strip, the
 *     themed scrollbars, and the TS side that sets/feeds the property (NOTES §13).
 *
 * The checks are ordered fresh-state first, mutation next: checks 7-10 inject fake
 * localStorage/document/window/matchMedia globals, so an earlier check must not
 * observe them. The style.css/index.html scans are read-only and unaffected by stubs.
 */

import { DARK_THEME, LIGHT_THEME, LOGIC2_CHANNEL_COLORS } from '../../render/index.js';
import { hexFromHsv, hsvFromHex } from '../colorMath.js';
import { en } from '../locales/en.js';
import { canvasPalette } from '../canvasPalette.js';
import {
  ANALYZER_COLORS, CHANNEL_COLORS, CHANNEL_COLOR_PRESETS, CHROME, chipForeground, COLORS,
  GRID, LIGHT_CHROME_TOKENS, ROWS,
} from '../metrics.js';
import { defaultChannels } from '../state.js';
import {
  getMode, getTheme, initTheme, onThemeChange, pickMode, resolveMode, setMode,
  THEME_LABEL_KEYS, THEME_MODE_LABEL_KEYS, THEME_MODES, THEME_STORAGE_KEY, THEMES,
  type ThemeMode,
} from '../theme.js';

/** Same structural-typing trick as i18n-selftest.ts: node access without @types/node. */
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

/** The fs subset the file-scan checks need, via getBuiltinModule (see i18n-selftest). */
interface FsLike {
  readFileSync(p: string, enc: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

/**
 * Install a global for the mutation checks. Object.defineProperty rather than a plain
 * assignment so the stub wins even where node exposes the name as an accessor.
 */
function defineGlobal(name: 'localStorage' | 'document' | 'window' | 'matchMedia', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// ------------------------------------------------------------------ registry

{
  const ids = [...THEMES].join(',');
  const modes = [...THEME_MODES].join(',');
  check('THEMES is default,dark,light; THEME_MODES is light,dark,system; key is logicweb.theme',
    ids === 'default,dark,light' && modes === 'light,dark,system' && THEME_STORAGE_KEY === 'logicweb.theme',
    `themes=[${ids}], modes=[${modes}], key=${THEME_STORAGE_KEY}`);
}

// ---------------------------------------------------- default channel colors

{
  const channels = defaultChannels(17);
  const defaultsMatch = channels.every((channel, index) =>
    channel.index === index && channel.color === CHANNEL_COLORS[index % CHANNEL_COLORS.length]);
  const palettesMatch = CHANNEL_COLORS.length === LOGIC2_CHANNEL_COLORS.length &&
    CHANNEL_COLORS.every((color, index) => color === LOGIC2_CHANNEL_COLORS[index]);
  check('default channel state preserves the exact UI and renderer color cycles',
    defaultsMatch && palettesMatch,
    `defaultsMatch=${defaultsMatch}, palettesMatch=${palettesMatch}, channels=${channels.length}`);

  const presetCount = CHANNEL_COLOR_PRESETS.length;
  const unique = new Set(CHANNEL_COLOR_PRESETS).size === presetCount;
  const valid = CHANNEL_COLOR_PRESETS.every((color) => /^#[0-9A-F]{6}$/.test(color));
  const defaultsFirst = CHANNEL_COLORS.every((color, index) => CHANNEL_COLOR_PRESETS[index] === color);
  check('the dialog has 15 unique valid presets with the unchanged defaults first',
    presetCount === 15 && unique && valid && defaultsFirst,
    `count=${presetCount}, unique=${unique}, valid=${valid}, defaultsFirst=${defaultsFirst}`);
}

// ------------------------------------------------------- pickMode/resolveMode

{
  const absent = pickMode(null);
  const unknown = pickMode('xx');
  const legacy = pickMode('default');
  const light = pickMode('light');
  const dark = pickMode('dark');
  const system = pickMode('system');
  const picksOk = absent === 'dark' && unknown === 'dark' && legacy === 'dark' &&
    light === 'light' && dark === 'dark' && system === 'system';

  const sysDark = resolveMode('system', true);
  const sysLight = resolveMode('system', false);
  const lightExplicit = resolveMode('light', true);
  const darkExplicit = resolveMode('dark', false);
  const resolvesOk = sysDark === 'dark' && sysLight === 'light' &&
    lightExplicit === 'light' && darkExplicit === 'dark';

  check('pickMode honors the three modes and migrates absent/unknown/legacy-default to dark',
    picksOk, `null→${absent}, xx→${unknown}, default→${legacy}, light→${light}, system→${system}`);
  check('resolveMode maps system through systemDark; explicit modes ignore it (dark fallback pinned)',
    resolvesOk,
    `system+dark→${sysDark}, system+light→${sysLight}, light+dark→${lightExplicit}, dark+light→${darkExplicit}`);
}

// ------------------------------------------- label keys ↔ en catalog

{
  const catalog = en as Record<string, string>;
  const missingThemes = THEMES.filter((id) => (catalog[THEME_LABEL_KEYS[id]] ?? '').trim() === '');
  const missingModes = THEME_MODES.filter((m) => (catalog[THEME_MODE_LABEL_KEYS[m]] ?? '').trim() === '');
  const extraThemeKeys = Object.keys(THEME_LABEL_KEYS)
    .filter((k) => !(THEMES as readonly string[]).includes(k));
  const extraModeKeys = Object.keys(THEME_MODE_LABEL_KEYS)
    .filter((k) => !(THEME_MODES as readonly string[]).includes(k));
  const ok = missingThemes.length === 0 && missingModes.length === 0 &&
    extraThemeKeys.length === 0 && extraModeKeys.length === 0;
  check('every theme id and every mode has a non-empty label key present in the en catalog',
    ok,
    ok
      ? THEME_MODES.map((m) => `${m}=${THEME_MODE_LABEL_KEYS[m]}`).join(', ')
      : `missingThemes=${missingThemes.join(',') || '(none)'} missingModes=${missingModes.join(',') || '(none)'}`);
}

// ------------------------------------------------- fresh-state node boot

{
  // Asserted before any stub: the module was bundled --platform=node, so reaching
  // this line already proves module evaluation touched neither storage nor the DOM
  // (either touch would have thrown), and the state must be the mandated default.
  check('a fresh module boots to mode dark and resolved dark before any storage/DOM access',
    getMode() === 'dark' && getTheme() === 'dark',
    `getMode()=${getMode()}, getTheme()=${getTheme()}`);
}

// ------------------------------------------------- mutation checks (ordered)

// 7. Persistence + notify semantics, the same-mode no-op, and the resolved-id gate.
{
  const writes: [string, string][] = [];
  defineGlobal('localStorage', {
    getItem: () => null,
    setItem: (key: string, value: string) => { writes.push([key, value]); },
  });
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  defineGlobal('document', doc);
  let notified = 0;
  const unsubscribe = onThemeChange(() => { notified += 1; });

  setMode('light'); // real change: write + attribute + notify
  const afterLight = { writes: writes.length, notified, attr: doc.documentElement.dataset.theme };
  setMode('light'); // same mode: total no-op
  const afterNoop = { writes: writes.length, notified };

  setMode('system'); // systemDark defaults true (no matchMedia): resolved dark, a real flip
  const afterSystem = { writes: writes.length, notified, attr: doc.documentElement.dataset.theme };
  setMode('dark'); // mode change, resolved UNCHANGED: persists + notifies, no attribute write
  const attrBefore = doc.documentElement.dataset.theme;
  const afterSameResolved = { writes: writes.length, notified, attr: doc.documentElement.dataset.theme };
  unsubscribe();
  setMode('light'); // unsubscribed: no notify
  const finalNotify = notified;

  const ok = afterLight.writes === 1 && afterLight.notified === 1 && afterLight.attr === 'light' &&
    afterNoop.writes === 1 && afterNoop.notified === 1 &&
    afterSystem.writes === 2 && afterSystem.notified === 2 && afterSystem.attr === 'dark' &&
    writes[1]?.[1] === 'system' &&
    afterSameResolved.writes === 3 && afterSameResolved.notified === 3 &&
    afterSameResolved.attr === 'dark' && attrBefore === 'dark' &&
    writes[2]?.[0] === THEME_STORAGE_KEY && writes[2]?.[1] === 'dark' &&
    finalNotify === 3;
  check('setMode persists the MODE, gates the attribute on the resolved id, notifies per mode change; no-op and unsubscribe hold',
    ok,
    `writes=${JSON.stringify(writes)}, notified=${notified}, attr=${doc.documentElement.dataset.theme}, theme=${getTheme()}`);
}

// 8. Listeners: latched install, matchMedia re-resolution, cross-tab storage adoption.
{
  const mqlListeners: ((e: { matches: boolean }) => void)[] = [];
  const mql = {
    matches: false,
    addEventListener: (type: string, cb: (e: { matches: boolean }) => void) => {
      if (type === 'change') mqlListeners.push(cb);
    },
  };
  defineGlobal('matchMedia', (_query: string) => mql);
  const storageListeners: ((e: { key: string | null; newValue: string | null }) => void)[] = [];
  defineGlobal('window', {
    addEventListener: (type: string, cb: (e: { key: string | null; newValue: string | null }) => void) => {
      if (type === 'storage') storageListeners.push(cb);
    },
  });
  const listenerWrites: [string, string][] = [];
  defineGlobal('localStorage', {
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? 'system' : null),
    setItem: (key: string, value: string) => { listenerWrites.push([key, value]); },
  });
  const doc = { documentElement: { dataset: { theme: 'dark' } as Record<string, string> } };
  defineGlobal('document', doc);

  let notified = 0;
  onThemeChange(() => { notified += 1; });
  const booted = initTheme(); // stored 'system' + mql.matches=false -> light; boot must not notify
  const bootAttr = doc.documentElement.dataset.theme;
  doc.documentElement.dataset.theme = 'dark'; // a repeat initTheme must re-apply, not no-op
  initTheme(); // second call: the latch must keep listener counts at exactly one
  const reapplyAttr = doc.documentElement.dataset.theme;
  const counts = { mql: mqlListeners.length, storage: storageListeners.length };
  const bootNotified = notified;

  mqlListeners[0]?.({ matches: true }); // system mode, resolved flips dark
  const afterFlipDark = { notified, attr: getTheme() };
  mqlListeners[0]?.({ matches: false }); // flips back to light
  const afterFlipLight = { notified, attr: getTheme() };

  setMode('dark'); // explicit mode now
  const afterExplicit = notified;
  mqlListeners[0]?.({ matches: true }); // explicit mode: ZERO notifications
  const afterExplicitFlip = notified;

  const fireStorage = (key: string | null, newValue: string | null) => {
    storageListeners[0]?.({ key, newValue });
  };
  fireStorage('logicweb.panelWidth', '420'); // unrelated key: ignored
  const afterUnrelated = notified;
  fireStorage(THEME_STORAGE_KEY, 'dark'); // same mode as current: no-op
  const afterSameMode = notified;
  fireStorage(THEME_STORAGE_KEY, 'system'); // adopt the MODE; re-resolve against systemDark=true
  const afterAdopt = { notified, mode: getMode(), theme: getTheme() };
  fireStorage(null, null); // external clear() -> absent -> dark; resolved unchanged, still notifies
  const afterClear = { notified, mode: getMode(), theme: getTheme() };

  const ok = booted === 'system' && bootAttr === 'light' && reapplyAttr === 'light' && bootNotified === 0 &&
    counts.mql === 1 && counts.storage === 1 &&
    afterFlipDark.notified === 1 && afterFlipDark.attr === 'dark' &&
    afterFlipLight.notified === 2 && afterFlipLight.attr === 'light' &&
    afterExplicit === 3 && afterExplicitFlip === 3 &&
    afterUnrelated === 3 && afterSameMode === 3 &&
    afterAdopt.notified === 4 && afterAdopt.mode === 'system' && afterAdopt.theme === 'dark' &&
    afterClear.notified === 5 && afterClear.mode === 'dark' && afterClear.theme === 'dark' &&
    listenerWrites.length === 1 && listenerWrites[0]?.[1] === 'dark';
  check('initTheme latches both listeners, system re-resolves live, explicit modes stay silent, storage adopts modes',
    ok,
    `boot=${booted}/${bootAttr}, reapply=${reapplyAttr}, counts=${counts.mql}/${counts.storage}, notified=${notified}, bootNotified=${bootNotified}, ` +
    `adopt=${afterAdopt.mode}/${afterAdopt.theme}, clear=${afterClear.mode}, listenerWrites=${listenerWrites.length}`);
}

// 9. The no-matchMedia fallback: a stored system pick resolves to dark, pinned as
// the fallback (not confused with 'system works').
{
  defineGlobal('matchMedia', undefined);
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  defineGlobal('document', doc);
  defineGlobal('localStorage', {
    getItem: (key: string) => (key === THEME_STORAGE_KEY ? 'system' : null),
    setItem: () => {},
  });
  const booted = initTheme();
  check('without matchMedia, a stored system mode resolves to the dark fallback',
    booted === 'system' && getMode() === 'system' && getTheme() === 'dark' &&
    doc.documentElement.dataset.theme === 'dark',
    `boot=${booted}, mode=${getMode()}, theme=${getTheme()}, attr=${doc.documentElement.dataset.theme}`);
}

// 10. Throwing storage must not break boot or the switch.
{
  defineGlobal('localStorage', {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
  });
  let booted: ThemeMode = 'light';
  let bootThrew = false;
  try {
    booted = initTheme();
  } catch {
    bootThrew = true;
  }
  const afterBoot = { mode: getMode(), theme: getTheme() };
  let switchThrew = false;
  try {
    setMode('light'); // a real switch through the throwing setItem
  } catch {
    switchThrew = true;
  }
  check('throwing storage does not break boot or the in-memory switch',
    !bootThrew && booted === 'dark' && afterBoot.mode === 'dark' && afterBoot.theme === 'dark' &&
    !switchThrew && getMode() === 'light' && getTheme() === 'light',
    `boot=${booted}, bootThrew=${bootThrew}, switchThrew=${switchThrew}, mode=${getMode()}, theme=${getTheme()}`);
}

// ------------------------------------------- theme.ts listener-shape needles

// The legacy MediaQueryList.addListener fallback and the single cross-tab storage
// listener are unpinned by behavior (the latch consumes the stub before a legacy
// variant could be exercised), so pin the source intent directly.
{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const src = fs.readFileSync('src/ui/theme.ts', 'utf8');
  const addListenerFallback = src.includes('mql.addListener?.(onSystemChange)');
  const storageListener = src.includes("window.addEventListener('storage', onStorage)");
  check('theme.ts keeps the addListener fallback and the single cross-tab storage listener',
    addListenerFallback && storageListener,
    `addListenerFallback=${addListenerFallback}, storageListener=${storageListener}`);
}

// ------------------------------------------- index.html pre-paint script (check 12)

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  // Read from the CWD, same convention as i18n-selftest's index.html check.
  const html = fs.readFileSync('index.html', 'utf8');
  // The needle is built from the constant's VALUE as the exact quoted storage read:
  // renaming THEME_STORAGE_KEY without touching the inline script (or vice versa)
  // fails here. A quoted-literal match, not a substring - 'logicweb.themex' still
  // contains 'logicweb.theme', so a looser match would not catch that drift.
  const needle = `getItem('${THEME_STORAGE_KEY}')`;
  const keyIdx = html.indexOf(needle);
  const cssIdx = html.indexOf('<link rel="stylesheet"');
  const head = keyIdx !== -1 && cssIdx !== -1 ? html.slice(Math.max(0, keyIdx - 600), cssIdx) : '';
  const modesPresent = ["'light'", "'dark'", "'system'"].every((l) => head.includes(l));
  const mqlPresent = head.includes("matchMedia('(prefers-color-scheme: dark)')");
  // Pin the pick expression itself, not just the literals: dropping the
  // 'light'/'system' honor branch would flash dark for those users on boot while
  // the trailing ternary literals keep a looser needle green.
  const pickExpr = head.includes("stored === 'light' || stored === 'dark' || stored === 'system'");
  check('index.html resolves the persisted mode (system via matchMedia) before the stylesheet link',
    keyIdx !== -1 && cssIdx !== -1 && keyIdx < cssIdx &&
    head.includes('data-theme') && modesPresent && mqlPresent && pickExpr,
    `storageKey@${keyIdx}, stylesheet@${cssIdx}, modes=${modesPresent}, mql=${mqlPresent}, pickExpr=${pickExpr}`);
}
// (no assert against a second hardcoded 'logicweb.theme' literal: THEME_STORAGE_KEY IS the needle)

// ------------------------------------------- style.css theme-scope guards (check 13)

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const css = fs.readFileSync('src/ui/style.css', 'utf8');

  // Comments can mention theme selectors, and a naive scan would then attribute the
  // NEXT block's declarations to them. Strip comments first so only real rules are
  // examined. The sheet has no CSS nesting; media-wrapped rules match as their inner
  // selector+body pairs, which is exactly what the scans below want.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Every themed rule in one flat scan: selector mentions data-theme => the ids must
  // be a subset of the live theme overrides (dark|light - a default scope would
  // double-source the legacy palette), and no themed block may redefine a frozen
  // chrome metric.
  const METRIC_VARS = ['--toolbar-h', '--axis-h', '--status-h', '--labels-w', '--strip-w', '--panel-w'];
  const LIVE_THEME_SCOPES = ['dark', 'light'];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  const badIds: string[] = [];
  const metricOffenders: string[] = [];
  let themedBlocks = 0;
  let lightTokenBody: string | null = null;
  let darkTokenBody: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(code)) !== null) {
    const selector = m[1] ?? '';
    const body = m[2] ?? '';
    if (!selector.includes('data-theme')) continue;
    themedBlocks += 1;
    const ids = [...selector.matchAll(/data-theme="([^"]+)"/g)].map((x) => x[1]!);
    for (const id of ids) {
      if (!(LIVE_THEME_SCOPES as readonly string[]).includes(id)) badIds.push(id);
    }
    if (selector.trim() === 'html[data-theme="light"]') lightTokenBody = body;
    if (selector.trim() === 'html[data-theme="dark"]') darkTokenBody = body;
    for (const v of METRIC_VARS) {
      if (new RegExp(`${v}\\s*:`).test(body)) metricOffenders.push(`${v} @ ${selector.trim().slice(0, 48)}`);
    }
  }
  check('style.css: theme rules are scoped to dark/light only and never redefine chrome metrics',
    themedBlocks > 0 && badIds.length === 0 && metricOffenders.length === 0,
    `themedBlocks=${themedBlocks}, badIds=${badIds.join(',') || '(none)'}, ` +
    `metricOffenders=${metricOffenders.join(',') || '(none)'}`);

  const undeclaredMetrics = METRIC_VARS.filter((v) => !new RegExp(`${v}\\s*:`).test(code));
  const railMetricRetired = !/--rail-w\s*:/.test(code);
  check('style.css: the frozen metric set is exactly the live vars and --rail-w is retired',
    undeclaredMetrics.length === 0 && railMetricRetired,
    `undeclared=${JSON.stringify(undeclaredMetrics)}, railMetric=${railMetricRetired}`);

  const darkScheme = darkTokenBody !== null && /color-scheme:\s*dark/.test(darkTokenBody);
  const lightScheme = lightTokenBody !== null && /color-scheme:\s*light/.test(lightTokenBody);
  check('style.css: both theme token blocks carry their color-scheme',
    darkScheme && lightScheme, `dark=${darkScheme}, light=${lightScheme}`);

  // The CSS side of the CSS<->TS light-theme duplication contract: the light token
  // block must equal LIGHT_CHROME_TOKENS exactly - no missing, no extra, no drift.
  const parsed = new Map<string, string>();
  if (lightTokenBody !== null) {
    for (const decl of lightTokenBody.split(';')) {
      const dm = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(decl);
      if (dm) parsed.set(dm[1]!, dm[2]!);
    }
  }
  const expected = new Map(Object.entries(LIGHT_CHROME_TOKENS));
  const missing = [...expected.keys()].filter((k) => parsed.get(k) !== expected.get(k));
  const extra = [...parsed.keys()].filter((k) => !expected.has(k));
  check('style.css: the light token block matches LIGHT_CHROME_TOKENS exactly',
    lightTokenBody !== null && missing.length === 0 && extra.length === 0 && parsed.size === expected.size,
    `parsed=${parsed.size}, expected=${expected.size}, ` +
    `missing/drift=${missing.join(',') || '(none)'}, extra=${extra.join(',') || '(none)'}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const css = fs.readFileSync('src/ui/style.css', 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const toolbarStart = code.indexOf('#toolbar {');
  const mainStart = code.indexOf('#main {');
  const toolbar = toolbarStart >= 0 && mainStart > toolbarStart ? code.slice(toolbarStart, mainStart) : '';
  const cssHeight = Number(/--toolbar-h:\s*(\d+)px/.exec(code)?.[1]);
  const semanticNeedles = [
    'background: var(--background)',
    'border-bottom: 1px solid var(--border)',
    'background: var(--primary)',
    'background: var(--destructive)',
    'background: var(--muted)',
    'outline: 2px solid var(--ring)',
  ];
  const missingSemantic = semanticNeedles.filter((needle) => !toolbar.includes(needle));
  const darkToolbarOverrides = /html\[data-theme="dark"\] #toolbar\s*\{/.test(toolbar);
  const mirror = cssHeight === CHROME.toolbarHeight + CHROME.borderWidth;
  check('toolbar chrome uses semantic roles and keeps its CSS/TS height mirror',
    mirror && missingSemantic.length === 0 && !darkToolbarOverrides,
    `css=${cssHeight}px, ts=${CHROME.toolbarHeight}+${CHROME.borderWidth}px, ` +
    `missing=${JSON.stringify(missingSemantic)}, darkToolbarOverrides=${darkToolbarOverrides}`);
}

// ------------------------------------------- channel-card geometry guards (check 14)

// The waveform-table cards (NOTES.md section 13) hang on a few load-bearing threads:
// the wrappers stay display:contents in the base layer (else the default theme
// moves), the dark card reads --ch-lane-offset (else decoded channels grow again),
// the reserved strip keeps its measured min-height, and the TS side actually sets
// the property. Each needle would turn red on the drift that removes it.
{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const css = fs.readFileSync('src/ui/style.css', 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const baseNeutral = /\.ch-card, \.ch-analyzers\s*\{\s*display:\s*contents/.test(code);
  const themed = ':is(html[data-theme="dark"], html[data-theme="light"])';
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const laneMargin = new RegExp(`${esc(themed)} \\.ch-card\\s*\\{[^}]*margin-top:\\s*var\\(--ch-lane-offset, 0px\\)`).test(code);
  const stripReserved = new RegExp(`${esc(themed)} \\.ch-analyzers\\s*\\{[^}]*min-height:\\s*14px`).test(code);
  const scrollRe = new RegExp(
    `${esc(themed)} #scroll-area,\\s*${esc(themed)} #side-panel\\s*\\{[^}]*scrollbar-width:\\s*thin`,
  );
  const scrollbars = scrollRe.test(code);

  const channelList = fs.readFileSync('src/ui/channelList.ts', 'utf8');
  const tsSetsProperty = channelList.includes("setProperty('--ch-lane-offset'");
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const appFeedsLane = app.includes('laneCss:');

  check('channel-card geometry: neutral base wrappers, lane-offset margin, reserved strip, scrollbars, TS plumbing',
    baseNeutral && laneMargin && stripReserved && scrollbars && tsSetsProperty && appFeedsLane,
    `neutral=${baseNeutral}, laneMargin=${laneMargin}, strip=${stripReserved}, ` +
    `scrollbars=${scrollbars}, tsSets=${tsSetsProperty}, appFeeds=${appFeedsLane}`);
}

// ------------------------------------------- readable row minimum (check 15)

// The reserved one-line card needs 46 px including its insets and borders (NOTES §14).
// Pin the approved value exactly, and keep the upper auto-fit clamp ordered above it.
{
  const pass = ROWS.minRowHeight === 48 && ROWS.maxRowHeight >= ROWS.minRowHeight;
  check('channel rows keep the readable 48px minimum below the maximum clamp',
    pass, `min=${ROWS.minRowHeight}px, max=${ROWS.maxRowHeight}px`);
}

// ------------------------------------------- light canvas palette (checks 21-24)

{
  const seamDark = DARK_THEME.background === '#1B1B1C' && COLORS.bg10 === '#1B1B1C';
  const seamLight = LIGHT_THEME.background === LIGHT_CHROME_TOKENS['--bg10'];
  const geometry = LIGHT_THEME.rowSeparatorCssPx === DARK_THEME.rowSeparatorCssPx &&
    LIGHT_THEME.noDataWashAlpha === DARK_THEME.noDataWashAlpha &&
    LIGHT_THEME.noDataBorderAlpha === DARK_THEME.noDataBorderAlpha &&
    LIGHT_THEME.noDataBorderCssPx === DARK_THEME.noDataBorderCssPx;
  const sharedChannels = LIGHT_THEME.channelColors === DARK_THEME.channelColors &&
    LIGHT_THEME.channelColors === LOGIC2_CHANNEL_COLORS;
  const separators = LIGHT_THEME.rowSeparatorColor === LIGHT_CHROME_TOKENS['--border-high'] &&
    LIGHT_THEME.noDataColor === LIGHT_CHROME_TOKENS['--text50'];
  check('LIGHT_THEME keeps the dark geometry, shares the channel cycle, and meets the light seams',
    seamDark && seamLight && geometry && sharedChannels && separators,
    `seamDark=${seamDark}, seamLight=${seamLight}, geometry=${geometry}, ` +
    `sharedChannels=${sharedChannels}, separators=${separators}`);
}

{
  const dark = canvasPalette('dark');
  const legacy = dark.bg === COLORS.bg10 && dark.text === COLORS.text &&
    dark.text80 === COLORS.text80 && dark.text50 === COLORS.text50 &&
    dark.bubbleBg === COLORS.bg30 && dark.bubbleBorder === COLORS.borderHigh &&
    dark.gridMinor === GRID.minorColor && dark.gridMajor === GRID.majorColor &&
    dark.axisTickMinor === GRID.minorColor && dark.axisTickMajor === GRID.majorColor &&
    dark.warning === COLORS.warning && dark.negative === COLORS.negative &&
    dark.selection === COLORS.selection && dark.bubbleInk === dark.bg &&
    dark.noDataColor === DARK_THEME.noDataColor;
  check('the dark canvas palette is byte-identical to the legacy constants',
    legacy, `legacy=${legacy}`);
}

{
  const light = canvasPalette('light');
  const links = light.bg === LIGHT_THEME.background &&
    light.text === LIGHT_CHROME_TOKENS['--text'] &&
    light.text80 === LIGHT_CHROME_TOKENS['--text80'] &&
    light.text50 === LIGHT_CHROME_TOKENS['--text50'] &&
    light.negative === LIGHT_CHROME_TOKENS['--negative'] &&
    light.bubbleBg === LIGHT_CHROME_TOKENS['--bg30'] &&
    light.bubbleBorder === LIGHT_CHROME_TOKENS['--border-high'] &&
    light.bubbleInk === light.bg && light.noDataColor === LIGHT_THEME.noDataColor;
  const axisMinor: string = light.axisTickMinor;
  const axisMajor: string = light.axisTickMajor;
  const gridMinor: string = light.gridMinor;
  const gridMajor: string = light.gridMajor;
  const lightLiterals = axisMinor !== gridMinor && axisMajor !== gridMajor &&
    gridMinor === '#EDE9DC' && gridMajor === '#F3EEE2' &&
    axisMinor === '#D3C9AE' && axisMajor === '#C9BF9F' &&
    light.warning === '#A67C00' && light.selection === '#1B7FA8';
  const hex = /^#[0-9A-Fa-f]{6}$/;
  const bad: string[] = [];
  for (const id of ['dark', 'light'] as const) {
    for (const [k, v] of Object.entries(canvasPalette(id))) {
      if (!hex.test(v)) bad.push(`${id}.${k}`);
    }
  }
  for (const [k, v] of Object.entries({
    background: LIGHT_THEME.background,
    rowSeparatorColor: LIGHT_THEME.rowSeparatorColor,
    noDataColor: LIGHT_THEME.noDataColor,
  })) {
    if (!hex.test(v)) bad.push(`LIGHT_THEME.${k}`);
  }
  check('the light canvas palette derives from LIGHT_THEME plus pinned tokens, and every canvas color is #rrggbb',
    links && lightLiterals && bad.length === 0,
    `links=${links}, lightLiterals=${lightLiterals}, nonHex=${bad.join(',') || '(none)'}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const css = fs.readFileSync('src/ui/style.css', 'utf8');
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const baseBlend = /\.grid-canvas\s*\{[^}]*mix-blend-mode:\s*lighten/.test(code);
  const lightFlip = /html\[data-theme="light"\] \.grid-canvas\s*\{\s*mix-blend-mode:\s*darken;\s*\}/.test(code);
  check('the grid canvas keeps the lighten blend with a darken flip under the light theme',
    baseBlend && lightFlip, `baseBlend=${baseBlend}, lightFlip=${lightFlip}`);
}

// ------------------------------------------- dual-theme color metrics (checks 25-28)

// sRGB math for the acceptance-criterion pins: relative luminance + WCAG contrast,
// CIEDE2000 pairwise distance, and a Machado-2009 deuteranopia simulation. The
// thresholds come from the task's design table (min pairwise dE00 >= 12, min
// cycle-adjacent >= 15, min simulated >= 3.5, >= 2.9:1 against both plot grounds).
function hex255(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function linearize(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
function relLuminance(hex: string): number {
  const [r, g, b] = hex255(hex).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function lab(hex: string): [number, number, number] {
  const [r, g, b] = hex255(hex).map(linearize);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (val: number) => (val > 0.008856 ? Math.cbrt(val) : 7.787 * val + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function deltaE00(c1: string, c2: string): number {
  const [l1, a1, b1] = lab(c1);
  const [l2, a2, b2] = lab(c2);
  const c1s = Math.hypot(a1, b1);
  const c2s = Math.hypot(a2, b2);
  const cBar = (c1s + c2s) / 2;
  const g = 0.5 * (1 - Math.sqrt(Math.pow(cBar, 7) / (Math.pow(cBar, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + g);
  const a2p = a2 * (1 + g);
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) + 2 * Math.PI) % (2 * Math.PI);
  const h2p = (Math.atan2(b2, a2p) + 2 * Math.PI) % (2 * Math.PI);
  const dLp = l2 - l1;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > Math.PI) dhp -= 2 * Math.PI;
    if (dhp < -Math.PI) dhp += 2 * Math.PI;
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(dhp / 2);
  const lBarP = (l1 + l2) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP: number;
  if (c1p * c2p === 0) hBarP = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= Math.PI) hBarP = (h1p + h2p) / 2;
  else hBarP = (h1p + h2p + (h1p + h2p < 2 * Math.PI ? 2 * Math.PI : -2 * Math.PI)) / 2;
  const tt = 1 - 0.17 * Math.cos(hBarP - Math.PI / 6) + 0.24 * Math.cos(2 * hBarP) +
    0.32 * Math.cos(3 * hBarP + Math.PI / 30) - 0.2 * Math.cos(4 * hBarP - 63 * Math.PI / 180);
  const dTheta = (30 * Math.PI / 180) *
    Math.exp(-Math.pow((hBarP - 275 * Math.PI / 180) / (25 * Math.PI / 180), 2));
  const rc = 2 * Math.sqrt(Math.pow(cBarP, 7) / (Math.pow(cBarP, 7) + Math.pow(25, 7)));
  const sl = 1 + (0.015 * Math.pow(lBarP - 50, 2)) / Math.sqrt(20 + Math.pow(lBarP - 50, 2));
  const sc = 1 + 0.045 * cBarP;
  const sh = 1 + 0.015 * cBarP * tt;
  const rt = -Math.sin(2 * dTheta) * rc;
  return Math.sqrt(
    Math.pow(dLp / sl, 2) + Math.pow(dCp / sc, 2) + Math.pow(dHp / sh, 2) +
    rt * (dCp / sc) * (dHp / sh),
  );
}
function deuteranope(hex: string): [number, number, number] {
  const [r, g, b] = hex255(hex).map(linearize);
  return [
    0.367322 * r + 0.860646 * g - 0.227968 * b,
    0.280085 * r + 0.672501 * g + 0.047413 * b,
    -0.011820 * r + 0.042940 * g + 0.968881 * b,
  ].map((c) => {
    const cl = Math.min(1, Math.max(0, c));
    const s = cl <= 0.0031308 ? 12.92 * cl : 1.055 * Math.pow(cl, 1 / 2.4) - 0.055;
    return Math.round(s * 255);
  }) as [number, number, number];
}
function rgb255ToHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

{
  const darkBg = '#1B1B1C';
  const beige = LIGHT_THEME.background;
  const channelSet = [...new Set([...CHANNEL_COLORS, ...LOGIC2_CHANNEL_COLORS])];
  const floors = channelSet.map((c) => Math.min(contrast(c, darkBg), contrast(c, beige)));
  const minFloor = Math.min(...floors);

  let minPair = Infinity;
  let minPairDeutan = Infinity;
  let minAdjacent = Infinity;
  for (let i = 0; i < channelSet.length; i++) {
    for (let j = i + 1; j < channelSet.length; j++) {
      const a = channelSet[i]!;
      const b = channelSet[j]!;
      minPair = Math.min(minPair, deltaE00(a, b));
      minPairDeutan = Math.min(minPairDeutan,
        deltaE00(rgb255ToHex(deuteranope(a)), rgb255ToHex(deuteranope(b))));
      if (j === i + 1) minAdjacent = Math.min(minAdjacent, deltaE00(a, b));
    }
  }
  minAdjacent = Math.min(minAdjacent,
    deltaE00(channelSet[0]!, channelSet[channelSet.length - 1]!));
  check('channel colors hold >=2.9:1 on both plot grounds and stay pairwise distinguishable',
    minFloor >= 2.9 && minPair >= 12 && minAdjacent >= 15 && minPairDeutan >= 3.5,
    `minFloor=${minFloor.toFixed(2)}, minPairDE=${minPair.toFixed(1)}, ` +
    `minAdjacentDE=${minAdjacent.toFixed(1)}, minDeutanDE=${minPairDeutan.toFixed(1)}`);

  const card = LIGHT_CHROME_TOKENS['--card']!;
  const bubbleInk = canvasPalette('light').bubbleInk;
  const analyzerFloors = ANALYZER_COLORS.map((c) => Math.min(
    contrast(c, darkBg), contrast(c, beige), contrast(c, card), contrast(bubbleInk, c),
  ));
  const minAnalyzer = Math.min(...analyzerFloors);
  check('analyzer colors clear both plot grounds, the light card, and paper-ink-on-bubble',
    minAnalyzer >= 2.9 &&
      ANALYZER_COLORS.every((c) => contrast(bubbleInk, c) >= 3 && contrast(c, card) >= 3),
    `minAnalyzer=${minAnalyzer.toFixed(2)}`);

  const namedRoundTrip = CHANNEL_COLOR_PRESETS.every((c) => hexFromHsv(hsvFromHex(c)) === c);
  check('every named channel color survives an exact hex to hsv to hex round trip',
    namedRoundTrip && CHANNEL_COLOR_PRESETS.length === 15,
    `roundTrip=${namedRoundTrip}, count=${CHANNEL_COLOR_PRESETS.length}`);
}

{
  const expectedInk: Record<string, string> = {
    '#C81A21': '#FFFDF4', '#E4602A': '#141415', '#997100': '#FFFDF4', '#5A7100': '#FFFDF4',
    '#B0733C': '#141415', '#3191D9': '#141415', '#007971': '#FFFDF4', '#E94D95': '#141415',
  };
  const misses = CHANNEL_COLORS.filter((c) => chipForeground(c) !== expectedInk[c]);
  check('chipForeground picks the winning ink for every default channel fill',
    misses.length === 0 && Object.keys(expectedInk).length === CHANNEL_COLORS.length,
    `misses=${misses.join(',') || '(none)'}`);

  const gridMinor = canvasPalette('light').gridMinor;
  const gridMajor = canvasPalette('light').gridMajor;
  const grid = hex255(gridMinor);
  const major = hex255(gridMajor);
  const bg = hex255(LIGHT_THEME.background);
  const notched: string[] = [];
  for (const ink of [...LOGIC2_CHANNEL_COLORS, LIGHT_THEME.rowSeparatorColor, LIGHT_THEME.noDataColor]) {
    const c = hex255(ink);
    if (c.some((v, i) => v > grid[i]!)) notched.push(ink);
  }
  const majorDimmer = major.every((v, i) => v >= grid[i]!);
  const gridVisible = grid.every((v, i) => v < bg[i]!);
  check('the light grid clears the darken blend window (no trace notching, major stays dimmer)',
    notched.length === 0 && majorDimmer && gridVisible,
    `notched=${notched.join(',') || '(none)'}, majorDimmer=${majorDimmer}, gridVisible=${gridVisible}`);
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
