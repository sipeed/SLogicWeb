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
 *   - the theme registry and the storage-key literal;
 *   - pickTheme falls back to dark for absent and unknown stored values, and
 *     migrates a stored legacy 'default' pick to dark as well;
 *   - every theme has a label key that exists (non-empty) in the English catalog;
 *   - a fresh module boots to dark - asserted BEFORE any stub injection, so the
 *     node-safety of module evaluation is part of the pass;
 *   - setTheme persists the pick, applies the <html> attribute, and notifies exactly
 *     once per real change; a same-id pick is a silent no-op (no write, no notify);
 *   - the returned unsubscribe stops further notifications;
 *   - a storage whose getItem/setItem throw does not break boot or the switch;
 *   - index.html restores the persisted theme BEFORE the stylesheet link, keyed by
 *     THEME_STORAGE_KEY's actual value (renaming the key on either side turns this red);
 *   - style.css keeps every dark rule scoped to [data-theme="dark"] and never
 *     redefines the chrome metric variables inside a dark block (vacuous until the
 *     token layer lands, load-bearing from then on);
 *   - the channel-card geometry stays wired: neutral display:contents wrappers, the
 *     dark card's --ch-lane-offset margin, the reserved 14px decoder strip, the
 *     themed scrollbars, and the TS side that sets/feeds the property (NOTES §13).
 *
 * The checks are ordered fresh-state first, mutation next: checks 5-8 inject fake
 * localStorage/document globals, so an earlier check must not observe them. Checks
 * 9-10 are read-only file scans and are unaffected by those stubs.
 */

import { LOGIC2_CHANNEL_COLORS } from '../../render/index.js';
import { en } from '../locales/en.js';
import { CHANNEL_COLORS, CHANNEL_COLOR_PRESETS, CHROME, ROWS } from '../metrics.js';
import { defaultChannels } from '../state.js';
import {
  getTheme, initTheme, onThemeChange, pickTheme, setTheme,
  THEME_LABEL_KEYS, THEME_STORAGE_KEY, THEMES, type ThemeId,
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
function defineGlobal(name: 'localStorage' | 'document', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// ------------------------------------------------------------------ registry

{
  const ids = [...THEMES].join(',');
  check('THEMES is exactly default,dark and the storage key is logicweb.theme',
    ids === 'default,dark' && THEME_STORAGE_KEY === 'logicweb.theme',
    `themes=[${ids}], key=${THEME_STORAGE_KEY}`);
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

// ------------------------------------------------------------------ pickTheme

{
  const absent = pickTheme(null);
  const unknown = pickTheme('xx');
  const dark = pickTheme('dark');
  const legacy = pickTheme('default');
  check('pickTheme falls back to dark for absent/unknown and migrates the legacy default pick',
    absent === 'dark' && unknown === 'dark' && dark === 'dark' && legacy === 'dark',
    `null→${absent}, xx→${unknown}, dark→${dark}, default→${legacy}`);
}

// ------------------------------------------- label keys ↔ en catalog

{
  const catalog = en as Record<string, string>;
  const missing = THEMES.filter((id) => {
    const key = THEME_LABEL_KEYS[id];
    return key === undefined || (catalog[key] ?? '').trim() === '';
  });
  const extra = Object.keys(THEME_LABEL_KEYS)
    .filter((k) => !(THEMES as readonly string[]).includes(k));
  check('every theme has a non-empty label key present in the en catalog',
    missing.length === 0 && extra.length === 0,
    missing.length === 0 && extra.length === 0
      ? THEMES.map((id) => `${id}=${THEME_LABEL_KEYS[id]}`).join(', ')
      : `missing=${missing.join(',') || '(none)'} extra=${extra.join(',') || '(none)'}`);
}

// ------------------------------------------------- fresh-state node boot

{
  // Asserted before any stub: the module was bundled --platform=node, so reaching
  // this line already proves module evaluation touched neither storage nor the DOM
  // (either touch would have thrown), and the state must be the mandated default.
  const boot = getTheme();
  check('a fresh module boots to dark before any storage/DOM access',
    boot === 'dark', `getTheme()=${boot}`);
}

// ------------------------------------------------- mutation checks (ordered)

// 5. Persistence + notification, and the same-id no-op.
{
  const writes: [string, string][] = [];
  defineGlobal('localStorage', {
    getItem: () => null,
    setItem: (key: string, value: string) => { writes.push([key, value]); },
  });
  let notified = 0;
  const unsubscribe = onThemeChange(() => { notified += 1; });

  setTheme('default'); // fresh state is dark: this is the first real change
  const afterFirst = { theme: getTheme(), writes: writes.length, notified };
  setTheme('default'); // same id: must not persist or notify again
  unsubscribe();

  const ok = afterFirst.theme === 'default' && afterFirst.writes === 1 && afterFirst.notified === 1 &&
    writes.length === 1 && writes[0]?.[0] === THEME_STORAGE_KEY && writes[0]?.[1] === 'default' &&
    notified === 1;
  check('setTheme persists and notifies once, and a same-id pick is a silent no-op',
    ok, `theme=${getTheme()}, writes=${writes.length}, notified=${notified}`);
}

// 6. One notification per real change; unsubscribe stops the stream.
{
  let fired = 0;
  const unsubscribe = onThemeChange(() => { fired += 1; });
  setTheme('dark'); // real change
  const afterReal = fired;
  setTheme('dark'); // no-op
  unsubscribe();
  setTheme('default'); // real change while unsubscribed
  check('onThemeChange fires once per real change and unsubscribe stops it',
    afterReal === 1 && fired === 1 && getTheme() === 'default',
    `afterReal=${afterReal}, fired=${fired}, theme=${getTheme()}`);
}

// 7. The <html data-theme> side effect.
{
  setTheme('dark'); // settle before the stub goes in
  const doc = { documentElement: { dataset: {} as Record<string, string> } };
  defineGlobal('document', doc);
  setTheme('default');
  check('applyTheme writes the theme id onto <html data-theme>',
    doc.documentElement.dataset.theme === 'default',
    `data-theme=${JSON.stringify(doc.documentElement.dataset.theme)}`);
}

// 8. Throwing storage must not break boot or the switch.
{
  defineGlobal('localStorage', {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
  });
  let booted: ThemeId = 'default';
  let bootThrew = false;
  try {
    booted = initTheme();
  } catch {
    bootThrew = true;
  }
  const afterBoot = getTheme();
  let switchThrew = false;
  try {
    setTheme('default'); // boot landed dark: a real switch through the throwing setItem
  } catch {
    switchThrew = true;
  }
  check('throwing storage does not break boot or the in-memory switch',
    !bootThrew && booted === 'dark' && afterBoot === 'dark' && !switchThrew &&
    getTheme() === 'default',
    `boot=${booted}, bootThrew=${bootThrew}, switchThrew=${switchThrew}, theme=${getTheme()}`);
}

// ------------------------------------------- index.html pre-paint script (check 9)

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
  check('index.html restores the persisted theme before the stylesheet link',
    keyIdx !== -1 && cssIdx !== -1 && keyIdx < cssIdx &&
    html.includes('data-theme') && html.includes("'dark'"),
    `storageKey@${keyIdx}, stylesheet@${cssIdx}, data-theme=${html.includes('data-theme')}`);
}
// (no assert against a second hardcoded 'logicweb.theme' literal: THEME_STORAGE_KEY IS the needle)

// ------------------------------------------- style.css dark-scope guards (check 10)

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const css = fs.readFileSync('src/ui/style.css', 'utf8');

  // Comments can mention the dark selector (the token-layer header does), and a naive
  // scan would then attribute the NEXT block's declarations to it. Strip comments
  // first so only real rules are examined.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // (a) Dark-only scoping: a [data-theme="default"] colour rule would double-source the
  // default palette and break the pixel-identity-by-construction argument.
  const defaultScopes = code.match(/\[data-theme="default"\]/g) ?? [];

  // (b) The chrome metric freeze: theme blocks recolour, they never resize. Naive brace
  // matching is adequate here - this sheet has no CSS nesting, and dark rules are
  // top-level blocks. Vacuously true until the token layer lands (no dark block yet).
  const METRIC_VARS = ['--toolbar-h', '--axis-h', '--status-h', '--labels-w', '--strip-w', '--panel-w'];
  const offenders: string[] = [];
  let darkBlocks = 0;
  let from = 0;
  for (;;) {
    const open = code.indexOf('html[data-theme="dark"]', from);
    if (open === -1) break;
    const brace = code.indexOf('{', open);
    const close = brace === -1 ? -1 : code.indexOf('}', brace);
    if (brace === -1 || close === -1) break;
    darkBlocks += 1;
    const body = code.slice(brace + 1, close);
    for (const v of METRIC_VARS) {
      if (new RegExp(`${v}\\s*:`).test(body)) offenders.push(v);
    }
    from = close + 1;
  }
  check('style.css: no default-scope rules and dark blocks never redefine chrome metrics',
    defaultScopes.length === 0 && offenders.length === 0,
    `darkBlocks=${darkBlocks}, defaultScopes=${defaultScopes.length}, ` +
    `metricOffenders=${offenders.join(',') || '(none)'}${darkBlocks === 0 ? ' (vacuous until the token layer lands)' : ''}`);

  const undeclaredMetrics = METRIC_VARS.filter((v) => !new RegExp(`${v}\\s*:`).test(code));
  const railMetricRetired = !/--rail-w\s*:/.test(code);
  check('style.css: the frozen metric set is exactly the live vars and --rail-w is retired',
    undeclaredMetrics.length === 0 && railMetricRetired,
    `undeclared=${JSON.stringify(undeclaredMetrics)}, railMetric=${railMetricRetired}`);
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
  const darkToolbarOverrides = toolbar.includes('html[data-theme="dark"] #toolbar');
  const mirror = cssHeight === CHROME.toolbarHeight + CHROME.borderWidth;
  check('toolbar chrome uses semantic roles and keeps its CSS/TS height mirror',
    mirror && missingSemantic.length === 0 && !darkToolbarOverrides,
    `css=${cssHeight}px, ts=${CHROME.toolbarHeight}+${CHROME.borderWidth}px, ` +
    `missing=${JSON.stringify(missingSemantic)}, darkToolbarOverrides=${darkToolbarOverrides}`);
}

// ------------------------------------------- channel-card geometry guards (check 11)

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
  const laneMargin = /html\[data-theme="dark"\] \.ch-card\s*\{[^}]*margin-top:\s*var\(--ch-lane-offset, 0px\)/.test(code);
  const stripReserved = /html\[data-theme="dark"\] \.ch-analyzers\s*\{[^}]*min-height:\s*14px/.test(code);
  const scrollbars = /html\[data-theme="dark"\] #scroll-area,\s*html\[data-theme="dark"\] #side-panel\s*\{[^}]*scrollbar-width:\s*thin/.test(code);

  const channelList = fs.readFileSync('src/ui/channelList.ts', 'utf8');
  const tsSetsProperty = channelList.includes("setProperty('--ch-lane-offset'");
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const appFeedsLane = app.includes('laneCss:');

  check('channel-card geometry: neutral base wrappers, lane-offset margin, reserved strip, scrollbars, TS plumbing',
    baseNeutral && laneMargin && stripReserved && scrollbars && tsSetsProperty && appFeedsLane,
    `neutral=${baseNeutral}, laneMargin=${laneMargin}, strip=${stripReserved}, ` +
    `scrollbars=${scrollbars}, tsSets=${tsSetsProperty}, appFeeds=${appFeedsLane}`);
}

// ------------------------------------------- readable row minimum (check 12)

// The reserved one-line card needs 46 px including its insets and borders (NOTES §14).
// Pin the approved value exactly, and keep the upper auto-fit clamp ordered above it.
{
  const pass = ROWS.minRowHeight === 48 && ROWS.maxRowHeight >= ROWS.minRowHeight;
  check('channel rows keep the readable 48px minimum below the maximum clamp',
    pass, `min=${ROWS.minRowHeight}px, max=${ROWS.maxRowHeight}px`);
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
