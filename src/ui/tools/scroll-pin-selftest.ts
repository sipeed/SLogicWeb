// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The row stack's pinned chrome and row density (DESIGN §3.4, §5.4, §6.1), source-level.
 *
 *   node src/tools/run-all-tests.mjs --filter scroll-pin
 *
 * A sticky box only stays pinned while its containing block is on screen. #overview and
 * #axis live in #plot-col, the corner cell in #labels-col; both columns are flex items of
 * the scrolling #scroll-area. With the default `align-items: stretch` the columns are
 * exactly as tall as the scroll viewport, so past the first screen of rows the ruler,
 * overview and corner scrolled away with them. The checks pin the fix (columns grow to
 * the row stack, and still fill the viewport when it is short), the markup it relies on,
 * and the "Compact rows" / "Hide idle channels" chrome that lives in the same column.
 */

export {};

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

const css = fs.readFileSync('src/ui/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync('index.html', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const dialog = fs.readFileSync('src/ui/settingsDialog.ts', 'utf8');
const channelList = fs.readFileSync('src/ui/channelList.ts', 'utf8');
const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');

interface Rule { selectors: string[]; decls: Map<string, string>; media: string | null }

/** Flat rules with their enclosing @media (one level, which is all the sheet uses). */
function rules(source: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  let media: string | null = null;
  let mediaDepth = 0;
  let depth = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    const close = source.indexOf('}', i);
    if (open === -1 && close === -1) break;
    if (close !== -1 && (open === -1 || close < open)) {
      depth--;
      if (media !== null && depth < mediaDepth) media = null;
      i = close + 1;
      continue;
    }
    const prelude = source.slice(i, open).trim();
    if (prelude.startsWith('@')) {
      if (prelude.startsWith('@media')) { media = prelude; mediaDepth = depth + 1; }
      depth++;
      i = open + 1;
      continue;
    }
    const end = source.indexOf('}', open);
    const body = source.slice(open + 1, end);
    const decls = new Map<string, string>();
    for (const part of body.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    out.push({ selectors: splitSelectors(prelude), decls, media });
    i = end + 1;
  }
  return out;
}

/** A selector list split on its top-level commas (not the ones inside `:is(...)`). */
function splitSelectors(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(prelude.slice(from, i)); from = i + 1; }
  }
  parts.push(prelude.slice(from));
  return parts.map((s) => s.trim().replace(/\s+/g, ' '));
}

const all = rules(css);
/** The cascaded value of one property for a selector in the base (non-@media) layer. */
function base(selector: string, prop: string, ruleSet: readonly Rule[] = all): string | undefined {
  let value: string | undefined;
  for (const rule of ruleSet) {
    if (rule.media !== null || !rule.selectors.includes(selector)) continue;
    const v = rule.decls.get(prop);
    if (v !== undefined) value = v;
  }
  return value;
}
/** Media-scoped rules that set `prop` on exactly `selector` (would undo the base rule). */
function mediaOverrides(selector: string, prop: string): string[] {
  return all.filter((rule) => rule.media !== null && rule.selectors.includes(selector) &&
    rule.decls.has(prop)).map((rule) => `${rule.media} ${prop}:${rule.decls.get(prop)}`);
}

// ------------------------------------------------------------------ #09 pinned chrome

{
  const align = base('#scroll-area', 'align-items');
  const overflow = base('#scroll-area', 'overflow-y');
  const display = base('#scroll-area', 'display');
  check('the scroll area is a flex row that scrolls and lets its columns grow past the viewport',
    display === 'flex' && overflow === 'auto' && align === 'flex-start' &&
      mediaOverrides('#scroll-area', 'align-items').length === 0,
    `display=${display}, overflow-y=${overflow}, align-items=${align}, ` +
    `overrides=${JSON.stringify(mediaOverrides('#scroll-area', 'align-items'))}`);
}

{
  const labels = base('#labels-col', 'min-height');
  const plot = base('#plot-col', 'min-height');
  const bad = [...mediaOverrides('#labels-col', 'min-height'), ...mediaOverrides('#plot-col', 'min-height'),
    ...mediaOverrides('#labels-col', 'height'), ...mediaOverrides('#plot-col', 'height')];
  const noCap = base('#labels-col', 'height') === undefined && base('#plot-col', 'height') === undefined &&
    base('#labels-col', 'max-height') === undefined && base('#plot-col', 'max-height') === undefined;
  check('both columns fill at least the viewport and are never capped to it',
    labels === '100%' && plot === '100%' && noCap && bad.length === 0,
    `labels=${labels}, plot=${plot}, noCap=${noCap}, overrides=${JSON.stringify(bad)}`);
}

{
  const pins = [
    ['#overview', 'top', '0'],
    ['#axis', 'top', 'var(--overview-h)'],
    ['#labels-spacer', 'top', '0'],
  ] as const;
  const bad = pins.filter(([sel, prop, want]) =>
    base(sel, 'position') !== 'sticky' || base(sel, prop) !== want ||
    mediaOverrides(sel, 'position').length > 0)
    .map(([sel]) => `${sel}: position=${base(sel, 'position')}, top=${base(sel, 'top')}`);
  const zOk = pins.every(([sel]) => Number(base(sel, 'z-index')) >= 3);
  check('the overview, ruler and corner cell are sticky at their stacked offsets above the rows',
    bad.length === 0 && zOk, bad.length === 0 ? `zOk=${zOk}` : bad.join('; '));
}

{
  // The containing blocks: the sticky boxes must be direct children of the columns that
  // grow, and the columns direct children of the scroll area. A wrapper in between would
  // be a new (viewport-high) containing block and break the pin again.
  const area = html.slice(html.indexOf('<div id="scroll-area">'), html.indexOf('<div id="panel-resizer"'));
  const order = ['id="scroll-area"', 'id="labels-col"', 'id="labels-spacer"', 'id="channel-list"',
    'id="plot-col"', 'id="overview"', 'id="axis"', 'id="plot"'].map((id) => area.indexOf(id));
  const ordered = order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!));
  const plotColDirect =
    /<div id="plot-col">\s*<canvas id="overview"[^>]*><\/canvas>\s*<canvas id="axis"[^>]*><\/canvas>\s*<div id="plot"/
      .test(area);
  const labelsDirect = /<div id="labels-col"[^>]*>\s*<div id="labels-spacer"/.test(area) &&
    /<div id="scroll-area">\s*<div id="labels-col"/.test(area);
  check('markup: the sticky overview/axis sit directly in #plot-col and the corner directly in #labels-col',
    ordered && plotColDirect && labelsDirect,
    `order=${order.join(',')}, plotCol=${plotColDirect}, labelsCol=${labelsDirect}`);
}

{
  // The rows still auto-fit the *viewport* (not the grown column) and the label wheel
  // still scrolls the shared scroll area.
  const fit = app.includes('const plotH = Math.max(120, (this.el.scroll.clientHeight || 630) - axisH - overviewH - analogH);');
  const wheel = app.includes('scroll.scrollTop += wheelDeltaPixels(e.deltaY, e.deltaMode, scroll.clientHeight);');
  check('row fit and the row-scroll wheel still read the scroll viewport',
    fit && wheel, `fit=${fit}, wheel=${wheel}`);
}

{
  const bottom = 'calc(50% - (var(--overview-h) + var(--axis-h)) / 2)';
  const pinned = (ruleSet: readonly Rule[]): boolean =>
    base('#empty-hint', 'position', ruleSet) === 'sticky' &&
    base('#empty-hint', 'bottom', ruleSet) === bottom &&
    base('#empty-hint', 'height', ruleSet) === '0' &&
    base('#empty-hint', 'contain', ruleSet) === 'layout' &&
    base('#empty-hint', 'inset', ruleSet) === undefined &&
    base('#empty-hint', 'align-items', ruleSet) === 'flex-start' &&
    base('#empty-hint', 'justify-content', ruleSet) === 'center' &&
    base('#empty-hint', 'color', ruleSet) === 'var(--text50)' &&
    base('.empty-hint-body', 'transform', ruleSet) === 'translateY(-50%)';
  const absolute = css.replace(`#empty-hint {\n  position: sticky;\n  bottom: ${bottom};`,
    '#empty-hint {\n  position: absolute; inset: 0;');
  const untransformed = css.replace('.empty-hint-body { transform: translateY(-50%); }', '');
  const uncontained = css.replace('  contain: layout;\n', '');
  const recolored = css.replace('color: var(--text50); pointer-events: none; text-align: center;',
    'color: var(--text80); pointer-events: none; text-align: center;');
  const direct = /<div id="plot"[^>]*>\s*<div id="wave-stack"><\/div>\s*<div id="empty-hint" translate="yes">/.test(html);
  const noOverrides = ['position', 'bottom', 'height', 'contain', 'color'].every((prop) =>
    mediaOverrides('#empty-hint', prop).length === 0);
  const controls = [absolute, untransformed, uncontained, recolored].every((mutated) =>
    mutated !== css && !pinned(rules(mutated)));
  check('the empty hint sticks to the visible plot center and keeps its muted ink',
    pinned(all) && direct && noOverrides && controls,
    `pinned=${pinned(all)}, direct=${direct}, noOverrides=${noOverrides}, controls=${controls}`);
}

// ------------------------------------------------------------------ #11 density chrome

{
  const note = '.ch-idle-note';
  const sticky = base(note, 'position') === 'sticky' && base(note, 'bottom') === '0';
  const after = channelList.includes('if (note.previousElementSibling !== this.root) this.root.after(note);');
  const label = channelList.includes("note.textContent = t('channels.idleHidden', { count });") &&
    channelList.includes("note.title = t('channels.idleHiddenTip');") &&
    channelList.includes("this.idleNote = document.createElement('button');");
  const wired = app.includes('this.channelList.renderIdleNote(filtered.hidden, () => this.showIdleChannels());');
  check('the hidden-idle note is a button after the last row, pinned to the bottom, that shows them again',
    sticky && after && label && wired,
    `sticky=${sticky}, after=${after}, label=${label}, wired=${wired}`);
}

{
  const body = base('.ch-cell.compact .ch-body', 'padding-top') === '0';
  const strip = base('.ch-cell.compact .ch-analyzers', 'display') === 'none';
  const themed = all.some((rule) => rule.media === null &&
    rule.selectors.some((s) => s.endsWith('.ch-cell.compact .ch-analyzers') && s.startsWith(':is(')) &&
    rule.decls.get('display') === 'none');
  const classed = channelList.includes("if (isCompactRow(cell.heightCss - cell.laneCss)) el.classList.add('compact');");
  check('a compact cell drops the decoder strip and body padding in both theme layers',
    body && strip && themed && classed, `body=${body}, strip=${strip}, themed=${themed}, classed=${classed}`);
}

{
  const tip = panel.includes("chip.title = t('capturePanel.chipToggle', { id });") &&
    panel.includes("chip.setAttribute('aria-label', chip.title);");
  const hidden = base('.channel-bank-grid .chip:not(.on)', 'border-style') === 'dashed' &&
    base('.channel-bank-grid .chip:not(.on)', 'text-decoration') === 'line-through';
  check('capture-panel chips say they show/hide (not acquire) and a hidden chip looks hidden',
    tip && hidden, `tip=${tip}, hidden=${hidden}`);
}

{
  const paneBody = (() => {
    const start = dialog.indexOf('private paneContent(section: SettingsSectionId): HTMLElement[] {');
    const end = start >= 0 ? dialog.indexOf('\n  }', start) : -1;
    return start >= 0 && end > start ? dialog.slice(start, end) : '';
  })();
  const order = ['labelsRow', 'wheelZoomsRow', 'compactRowsRow', 'hideIdleRow']
    .map((row) => paneBody.indexOf(`this.${row}()`));
  const ordered = order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!));
  const generalPane = paneBody.indexOf('this.developerToolsRow()');
  const defaults = app.includes('  private compactRows = false;') &&
    app.includes('  private hideIdleChannels = false;');
  const restored = app.includes('this.compactRows = workspace.compactRows === true;') &&
    app.includes('this.hideIdleChannels = workspace.hideIdleChannels === true;');
  const atRest = app.includes('if (!this.hideIdleChannels || this.running || this.stopping || this.store.length === 0) {');
  check('both density toggles sit next to "wheel zooms" in the settings window, default off, restore, and idle-hiding waits for rest',
    ordered && generalPane > order[order.length - 1]! && defaults && restored && atRest,
    `order=${order.join(',')}, general=${generalPane}, defaults=${defaults}, restored=${restored}, atRest=${atRest}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
