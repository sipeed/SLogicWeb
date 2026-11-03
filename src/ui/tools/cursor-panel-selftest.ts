import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';
import type { MessageKey } from '../i18n.js';

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

const read = (path: string): string => fs.readFileSync(path, 'utf8');
const slice = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
};

const panel = read('src/ui/capturePanel.ts');
const analyzerPanel = read('src/ui/analyzerPanel.ts');
const app = read('src/ui/app.ts');
const css = read('src/ui/style.css');

const cursorSection = slice(panel, 'const cursorSec = section(', 'this.root.appendChild(cursorSec.el)');

{
  const triggerAppend = panel.indexOf('this.root.appendChild(triggerSec.el)');
  const cursorAppend = panel.indexOf('this.root.appendChild(cursorSec.el)');
  const advanced = panel.indexOf("const advanced = document.createElement('details')");
  check('the Cursors section is appended after the software trigger and before Advanced',
    triggerAppend >= 0 && cursorAppend > triggerAppend && advanced > cursorAppend &&
    panel.includes("const cursorSec = section(t('capturePanel.cursors'))"),
    `trigger=${triggerAppend}, cursors=${cursorAppend}, advanced=${advanced}`);
}

{
  const ordered = [
    'this.root.appendChild(chSec.el)',
    'this.root.appendChild(modeSec.el)',
    'this.root.appendChild(triggerSec.el)',
    'this.root.appendChild(cursorSec.el)',
    'this.root.appendChild(advanced)',
  ].map((needle) => panel.indexOf(needle));
  const ascending = ordered.every((index, i) => index >= 0 && (i === 0 || index > ordered[i - 1]!));
  check('the device panel order is channels, capture, trigger, cursors, advanced',
    ascending && ordered.length === 5, `indices=${ordered.join(',')}`);
}

{
  check('each row carries its cursor id for the row model',
    cursorSection.includes('item.dataset.cursorId = String(row.id);'),
    `dataset=${cursorSection.includes('item.dataset.cursorId')}`);

  check('the row is order chip, time/sample, remove control in that DOM order',
    cursorSection.indexOf("order.className = 'cursor-idx'") >= 0 &&
    cursorSection.indexOf("order.className = 'cursor-idx'") <
      cursorSection.indexOf("pos.className = 'cursor-pos'") &&
    cursorSection.indexOf("pos.className = 'cursor-pos'") <
      cursorSection.indexOf('cursorRemoveButton('),
    `idx=${cursorSection.indexOf("order.className = 'cursor-idx'")}, ` +
    `pos=${cursorSection.indexOf("pos.className = 'cursor-pos'")}, ` +
    `remove=${cursorSection.indexOf('cursorRemoveButton(')}`);
}

{
  check('the position cell is the row time joined to the absolute sample by /',
    cursorSection.includes('pos.textContent = `${row.time}/${row.sample}`;') &&
    !cursorSection.includes('formatDuration(row.seconds)') &&
    panel.includes("from './format.js'") &&
    panel.includes('formatDuration,'),
    `composed=${cursorSection.includes('${row.time}/${row.sample}')}, ` +
    `rederived=${cursorSection.includes('formatDuration(row.seconds)')}`);
}

{
  const markup = ['<table', '<thead', '<tbody', '<tr', '<th', '<td', 'innerHTML',
    "createElement('table')", "createElement('th')", "createElement('td')",
    "createElement('tbody')", "createElement('thead')"];
  const hits = markup.filter((needle) => panel.includes(needle));
  check('the section is div/span/button markup, never a table or string-built HTML',
    hits.length === 0, `hits=${JSON.stringify(hits)}`);
}

{
  check('the order chip is filled with the cursor colour and reads its own foreground',
    cursorSection.includes('order.style.background = row.color;') &&
    cursorSection.includes('order.style.color = chipForeground(row.color);') &&
    panel.includes('chipForeground'),
    `bg=${cursorSection.includes('order.style.background = row.color;')}, ` +
    `fg=${cursorSection.includes('order.style.color = chipForeground(row.color);')}`);

  const chip = slice(cursorSection, "const order = document.createElement('button');",
    "const pos = document.createElement('span');");
  check('the order chip is a real button so the jump is keyboard reachable',
    chip.length > 0 && chip.includes("order.type = 'button';"),
    `chip=${chip.length} chars, type=${chip.includes("order.type = 'button';")}`);

  check('the chip is named by the translated focus label in both title and aria-label',
    chip.includes("const focusLabel = t('capturePanel.focusCursor', { label: row.label });") &&
    chip.includes('order.title = focusLabel;') &&
    chip.includes("order.setAttribute('aria-label', focusLabel);"),
    `label=${chip.includes('capturePanel.focusCursor')}, ` +
    `title=${chip.includes('order.title = focusLabel;')}, ` +
    `aria=${chip.includes("order.setAttribute('aria-label', focusLabel);")}`);

  check('clicking the chip focuses exactly its own cursor through the panel callback',
    chip.includes("order.addEventListener('click', () => this.cb.onFocusCursor(row.id));") &&
    panel.includes('onFocusCursor(id: number): void;'),
    `wired=${chip.includes('this.cb.onFocusCursor(row.id)')}, ` +
    `callback=${panel.includes('onFocusCursor(id: number): void;')}`);

  check('the chip keeps Space for its own activation instead of the capture shortcut',
    chip.includes("order.addEventListener('keydown', (e) => {\n          if (e.key === ' ') e.stopPropagation();\n        });"),
    `guarded=${chip.includes("if (e.key === ' ') e.stopPropagation();")}`);
}

{
  check('the remove control deletes exactly its own cursor through the panel callback',
    panel.includes("const remove = cursorRemoveButton(t('capturePanel.removeCursor', { label: row.label }),\n          () => this.cb.onRemoveCursor(row.id));") &&
    panel.includes('b.type = \'button\';') &&
    panel.includes("b.setAttribute('aria-label', label);"),
    `callback=${panel.includes('() => this.cb.onRemoveCursor(row.id)')}, ` +
    `aria=${panel.includes("b.setAttribute('aria-label', label);")}`);

  check('the remove control reuses the shared compact action class and its remove variant',
    panel.includes("b.className = 'analyzer-act analyzer-act--remove';") &&
    analyzerPanel.includes("actionButton('analyzer-act analyzer-act--remove',") &&
    !panel.includes('cursor-remove') && !css.includes('cursor-remove'),
    `reuse=${panel.includes("b.className = 'analyzer-act analyzer-act--remove';")}, ` +
    `shared=${analyzerPanel.includes("actionButton('analyzer-act analyzer-act--remove',")}, ` +
    `strayPanel=${panel.includes('cursor-remove')}, strayCss=${css.includes('cursor-remove')}`);

  const icons = (panel.match(/path\.setAttribute\('d', d\);/g) ?? []).length;
  check('the remove glyph is a local 13 px cross pair, not an import from another panel',
    panel.includes("for (const d of ['M18 6 6 18', 'm6 6 12 12'])") && icons === 1 &&
    !panel.includes('analyzerPanel.js'),
    `crosses=${icons}, import=${panel.includes('analyzerPanel.js')}`);
}

{
  check('an empty list shows only the double-click hint in the same section',
    cursorSection.includes('if (v.cursors.length === 0) {') &&
    cursorSection.includes("hint.textContent = t('capturePanel.cursorEmpty');") &&
    cursorSection.indexOf("t('capturePanel.cursorEmpty')") < cursorSection.indexOf("div('cursor-list')"),
    `branch=${cursorSection.includes('if (v.cursors.length === 0) {')}, ` +
    `hint=${cursorSection.includes("t('capturePanel.cursorEmpty')")}`);

  const listInsideElse = cursorSection.indexOf('} else {') >= 0 &&
    cursorSection.indexOf("div('cursor-list')") > cursorSection.indexOf('} else {');
  check('the list branch is the else of the empty-state branch (mutually exclusive rows)',
    listInsideElse,
    `else=${cursorSection.indexOf('} else {')}, list=${cursorSection.indexOf("div('cursor-list')")}`);

  const emptyBranch = slice(cursorSection, 'if (v.cursors.length === 0) {', '} else {');
  check('the empty hint reuses the shared panel note class',
    emptyBranch.length > 0 && emptyBranch.includes("const hint = div('panel-note');") &&
    !emptyBranch.includes('cursor-row'),
    `branch=${emptyBranch.length} chars, note=${emptyBranch.includes("div('panel-note')")}`);
}

{
  const legend = slice(cursorSection, "const legend = document.createElement('span');",
    "const list = div('cursor-list');");
  check('the section head names the row format with the translated legend',
    legend.length > 0 && legend.includes("legend.className = 'cursor-legend';") &&
    legend.includes("legend.textContent = t('capturePanel.cursorFormat');") &&
    !legend.includes('legend.style'),
    `class=${legend.includes("legend.className = 'cursor-legend';")}, ` +
    `text=${legend.includes("t('capturePanel.cursorFormat')")}, ` +
    `inline=${legend.includes('legend.style')}, legend=${legend.length} chars`);

  const legendInBody = cursorSection.includes('cursorSec.body.appendChild(legend)');
  check('the legend rides the section head, never the scrolling body',
    cursorSection.includes('cursorSec.header.appendChild(legend);') && !legendInBody &&
    cursorSection.indexOf('cursorSec.header.appendChild(legend);') <
      cursorSection.indexOf("div('cursor-list')"),
    `head=${cursorSection.includes('cursorSec.header.appendChild(legend);')}, ` +
    `body=${legendInBody}`);

  const emptySlice = slice(cursorSection, 'if (v.cursors.length === 0) {', '} else {');
  const listBranch = slice(cursorSection, '} else {', 'cursorSec.body.appendChild(list);');
  check('the legend labels a rendered list only, so the empty hint stays alone',
    emptySlice.length > 0 && !emptySlice.includes('cursorFormat') &&
    !emptySlice.includes('cursor-legend') &&
    listBranch.includes("t('capturePanel.cursorFormat')"),
    `empty=${emptySlice.length} chars, emptyFormat=${emptySlice.includes('cursorFormat')}, ` +
    `emptyClass=${emptySlice.includes('cursor-legend')}, ` +
    `listFormat=${listBranch.includes('cursorFormat')}`);
}

{
  const key = 'capturePanel.cursorFormat' as const satisfies MessageKey;
  const catalogs: [string, Readonly<Record<string, string>>][] = [
    ['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr],
  ];
  const observed = catalogs.map(([locale, dict]) => [locale, dict[key] ?? ''] as const);
  const blankOrMalformed = observed
    .filter(([, text]) => text.trim() === '' || !text.includes('/') || text.includes('{'))
    .map(([locale, text]) => [locale, text]);
  check('all four catalogs define the cursor format legend as an unparameterised slash pair',
    blankOrMalformed.length === 0 && observed.find(([locale]) => locale === 'en')?.[1] === 'time / sample',
    `malformed=${JSON.stringify(blankOrMalformed)}, ` +
    `english=${JSON.stringify(observed.find(([locale]) => locale === 'en')?.[1])}`);

  const copied = observed.filter(([locale, text]) => locale !== 'en' && text === (en[key] ?? ''))
    .map(([locale]) => locale);
  check('no locale reuses the English cursor format legend',
    copied.length === 0,
    `copied=${JSON.stringify(copied)}, values=${JSON.stringify(observed)}`);
}

{
  const rows = slice(app, 'private cursorRows(): CursorRowView[] {', 'private removeCursor(id: number): void {');
  check('App derives the row time from the trigger origin and the live samplerate',
    rows.includes('const origin = this.triggerSampleIndex ?? 0;') &&
    rows.includes('seconds: (sample - origin) / this.store.samplerate,') &&
    rows.includes('sample,') && !rows.includes('row.sample ='),
    `origin=${rows.includes('this.triggerSampleIndex ?? 0')}, ` +
    `rate=${rows.includes('this.store.samplerate')}`);

  check('the row carries the marker identity, not a re-derived label or colour',
    rows.includes('label: cursor.marker.label,') && rows.includes('color: cursor.marker.color,') &&
    rows.includes('id: cursor.id,'), `body=${rows.length} chars`);

  check('a cursor without a sample contributes no row',
    rows.includes('if (sample === null) continue;') && !rows.includes('sample ?? 0') &&
    !rows.includes('sample as number'),
    `skip=${rows.includes('if (sample === null) continue;')}`);
}

{
  const view = slice(panel, 'export interface CursorRowView {', 'export interface CapturePanelView {');
  check('the row view carries the resolved time beside its seconds and sample',
    view.includes('seconds: number;') && view.includes('sample: number;') &&
    view.includes('time: string;'), `view=${view.length} chars`);

  const body = slice(app, 'private cursorRows(): CursorRowView[] {',
    'private focusCursor(id: number): void {');
  const calls = (body.match(/formatCursorTimes\(/g) ?? []).length;
  check('App resolves every row time from one neighbour-aware call over the cursor list',
    body.length > 0 && calls === 1 &&
    body.includes('const times = formatCursorTimes(rows, 1 / this.store.samplerate);') &&
    body.includes('return rows.map((row, index) => ({ ...row, time: times[index]! }));') &&
    app.includes("import { formatCursorTimes } from './cursorTime.js';") &&
    !body.includes('formatDuration'),
    `body=${body.length} chars, calls=${calls}, ` +
    `import=${app.includes("from './cursorTime.js'")}, ` +
    `reformatted=${body.includes('formatDuration')}`);

  const sites = slice(panel, 'updateCursors(rows: readonly CursorRowView[]): void {',
    'private fillProgress(progress:');
  const policy = ['formatCursorTimes', 'Math.log10', 'toFixed', 'formatDuration'];
  const leaks = policy.filter((needle) => cursorSection.includes(needle) || sites.includes(needle));
  check('the panel projects the resolved time and owns no precision policy of its own',
    sites.length > 0 && leaks.length === 0 && !panel.includes("from './cursorTime.js'"),
    `leaks=${JSON.stringify(leaks)}, sites=${sites.length} chars`);
}

{
  const render = slice(app, 'this.capturePanel.render({', 'this.analyzerPanel.render({');
  check('the view hands the rows to the capture panel',
    render.includes('cursors: this.cursorRows(),') &&
    app.includes('onRemoveCursor: (id) => this.removeCursor(id),'),
    `view=${render.includes('cursors: this.cursorRows(),')}, ` +
    `callback=${app.includes('onRemoveCursor: (id) => this.removeCursor(id),')}`);

  check('the panel focus callback routes to App.focusCursor',
    app.includes('onFocusCursor: (id) => this.focusCursor(id),'),
    `wired=${app.includes('onFocusCursor: (id) => this.focusCursor(id),')}`);

  const focus = slice(app, 'private focusCursor(id: number): void {',
    'private removeCursor(id: number): void {');
  const intentAt = focus.indexOf('this.noteViewportIntent();');
  const setAt = focus.indexOf('this.stack.setViewport(');
  check('the jump invalidates the continuation anchor before moving the viewport',
    focus.length > 0 && intentAt >= 0 && setAt > intentAt,
    `focus=${focus.length} chars, intent=${intentAt}, set=${setAt}`);

  check('the jump centres on the cursor sample and keeps the zoom span',
    focus.includes('const span = this.stack.viewport.end - this.stack.viewport.start;') &&
    focus.includes('this.stack.setViewport(sample - span / 2, sample + span / 2);') &&
    !focus.includes('zoomToFit') && !focus.includes('samplesPerPixel') &&
    !focus.includes('setViewportSeconds'),
    `span=${focus.includes('this.stack.viewport.end - this.stack.viewport.start')}, ` +
    `call=${focus.includes('this.stack.setViewport(sample - span / 2, sample + span / 2);')}`);

  check('a sample-less cursor has no jump target and the jumped cursor becomes active',
    focus.includes('if (sample === null) return;') &&
    focus.includes('this.activeCursorId = id;') &&
    focus.includes('this.renderPanels();') && focus.includes('this.dirty = true;'),
    `sample=${focus.includes('if (sample === null) return;')}, ` +
    `active=${focus.includes('this.activeCursorId = id;')}`);
}

{
  const end = slice(app, 'const end = (e: PointerEvent) => {', 'plot.addEventListener(\'pointerup\', end);');
  const renders = end.match(/renderPanels\(\)/g) ?? [];
  check('a committed cursor drag renders the panel exactly once',
    renders.length === 1 && end.includes('if (markerEnded) { this.renderPanels(); this.dirty = true; return; }'),
    `renders=${renders.length}`);

  const move = slice(app, "plot.addEventListener('pointermove', (e) => {", 'const end = (e: PointerEvent) => {');
  check('a drag move redraws without rebuilding the panel',
    move.length > 0 && !move.includes('renderPanels(') && move.includes('if (consumed) {'),
    `move=${move.length} chars, render=${move.includes('renderPanels(')}`);

  const consumed = slice(move, 'if (consumed) {', 'this.dirty = true; return;');
  const activateAt = consumed.indexOf('this.activeCursorId = cursor.id;');
  const updateAt = consumed.indexOf('this.capturePanel.updateCursors(this.cursorRows());');
  check('a consumed drag move refreshes the open cursor list in place, after the move',
    consumed.length > 0 && activateAt >= 0 && updateAt > activateAt &&
    consumed.slice(0, updateAt).includes("if (this.panel === 'device')") &&
    !consumed.includes('renderPanels('),
    `consumed=${consumed.length} chars, activate=${activateAt}, update=${updateAt}`);
}

{
  const update = slice(panel, 'updateCursors(rows: readonly CursorRowView[]): void {',
    "private fillProgress(progress: NonNullable<CapturePanelView['progress']>): void {");
  const writeAt = update.indexOf("const pos = item.querySelector<HTMLElement>('.cursor-pos');");
  const write = writeAt < 0 ? '' : update.slice(writeAt);
  const structural = ['replaceChildren', 'appendChild', 'insertBefore', 'remove(',
    'innerHTML', 'style', 'createElement'];
  const structuralHits = structural.filter((needle) => update.includes(needle));
  check('the live row update walks the rendered rows and rewrites nothing but their text',
    update.length > 0 && write.includes('textContent') && structuralHits.length === 0 &&
    update.indexOf('this.root.querySelectorAll') >= 0 &&
    update.indexOf("this.root.querySelectorAll<HTMLElement>('.cursor-row')") >
      update.indexOf('new Map<number, CursorRowView>()'),
    `update=${update.length} chars, write=${write.length} chars, hits=${JSON.stringify(structuralHits)}`);

  const writeBans = structural.concat(['dataset', 'className']);
  const writeHits = writeBans.filter((needle) => write.includes(needle));
  check('the write site touches only the position text of an existing row',
    write.includes('pos.textContent = `${row.time}/${row.sample}`;') &&
    !write.includes('formatDuration') && writeHits.length === 0,
    `hits=${JSON.stringify(writeHits)}, text=${write.includes('pos.textContent')}`);

  check('the update resolves rows by data-cursor-id and ignores ids it does not know',
    update.includes('byId.get(Number(item.dataset.cursorId))') &&
    update.includes('if (row === undefined) continue;') &&
    update.includes('if (pos === null) continue;') &&
    !update.includes('this.cb.'),
    `dataset=${update.includes('item.dataset.cursorId')}, ` +
    `skip=${update.includes('if (row === undefined) continue;')}`);

  check('an unrendered panel has no rows to walk, so the update is a no-op there',
    update.length > 0 && !update.includes('cursorSec') &&
    !update.includes('replaceChildren') && update.includes("'.cursor-row'") &&
    !update.includes('this.cursorRows'),
    `liveWalk=${update.includes("this.root.querySelectorAll<HTMLElement>('.cursor-row')")}`);
}

{
  const retention = slice(app, 'private enforceLoopRetention(store: SampleStore): void {',
    'private async stopCapture(');
  const shiftAt = retention.indexOf('if (cursor.marker.sample !== sample) shifted = true;');
  const branchAt = retention.indexOf("} else if (shifted && this.panel === 'device') {");
  const updateAt = retention.indexOf('this.capturePanel.updateCursors(this.cursorRows());');
  const originAt = retention.indexOf('this.triggerSampleIndex = this.triggerSampleIndex - drop >= 0');
  check('a retention shift with an intact cursor list refreshes the rows in place',
    retention.length > 0 && shiftAt >= 0 && branchAt > shiftAt && updateAt > branchAt &&
    originAt >= 0 && originAt < shiftAt &&
    retention.lastIndexOf('this.triggerSampleIndex = this.triggerSampleIndex - drop >= 0') < updateAt,
    `retention=${retention.length} chars, shift=${shiftAt}, branch=${branchAt}, ` +
    `update=${updateAt}, origin=${originAt}`);

  const renders = retention.match(/renderPanels\(\)/g) ?? [];
  const updates = retention.match(/updateCursors\(/g) ?? [];
  const dropAt = retention.indexOf('if (this.cursors.length !== beforeDrop) {');
  check('a retention drop keeps the single whole-panel render and the drop branch wins',
    renders.length === 1 && updates.length === 1 && dropAt >= 0 && dropAt < branchAt &&
    retention.indexOf('this.renderPanels();') > dropAt &&
    retention.indexOf('this.renderPanels();') < branchAt,
    `renders=${renders.length}, updates=${updates.length}, drop=${dropAt}, branch=${branchAt}`);
}

{
  const keys = [
    'capturePanel.cursors', 'capturePanel.cursorEmpty', 'capturePanel.removeCursor',
    'capturePanel.focusCursor',
  ] as const satisfies readonly MessageKey[];
  const catalogs: [string, Readonly<Record<string, string>>][] = [
    ['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr],
  ];
  const value = (dict: Readonly<Record<string, string>>, key: string): string => dict[key] ?? '';

  const missing = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => value(dict, key).trim() === '').map((key) => `${locale}:${key}`));
  check('all four catalogs define the four cursor keys with non-empty values',
    missing.length === 0, `missing=${JSON.stringify(missing)}`);

  const english = {
    'capturePanel.cursors': 'Cursors',
    'capturePanel.cursorEmpty': 'Double-click the waveform to place a cursor.',
    'capturePanel.removeCursor': 'Remove cursor {label}',
    'capturePanel.focusCursor': 'Centre the view on cursor {label}',
  };
  const mismatched = keys.filter((key) => value(en, key) !== english[key]);
  check('the English values are the contracted strings',
    mismatched.length === 0,
    `mismatched=${JSON.stringify(mismatched.map((key) => [key, value(en, key)]))}`);

  const placeholderMissing = catalogs.filter(([, dict]) =>
    !value(dict, 'capturePanel.removeCursor').includes('{label}')).map(([locale]) => locale);
  check('every catalog keeps the {label} placeholder in the remove label',
    placeholderMissing.length === 0, `missing=${JSON.stringify(placeholderMissing)}`);

  const focusPlaceholderMissing = catalogs.filter(([, dict]) =>
    !value(dict, 'capturePanel.focusCursor').includes('{label}')).map(([locale]) => locale);
  check('every catalog keeps the {label} placeholder in the focus label',
    focusPlaceholderMissing.length === 0, `missing=${JSON.stringify(focusPlaceholderMissing)}`);

  const copied = catalogs.filter(([locale]) => locale !== 'en')
    .filter(([, dict]) => keys.some((key) => value(dict, key) === value(en, key)))
    .map(([locale]) => locale);
  check('no locale reuses the English cursor prose',
    copied.length === 0, `copied=${JSON.stringify(copied)}`);
}

{
  const classes = ['.cursor-list {', '.cursor-row {', '.cursor-idx {', '.cursor-pos {'];
  const absent = classes.filter((rule) => !css.includes(rule));
  check('the sheet carries the four cursor rules',
    absent.length === 0, `absent=${JSON.stringify(absent)}`);

  const block = slice(css, '.cursor-list {', '.analyzer-name {');
  check('the cursor rules avoid !important and own their numeric columns',
    block.length > 0 && !block.includes('!important') &&
    block.includes('font-variant-numeric: tabular-nums;') &&
    block.includes('text-overflow: ellipsis;'),
    `block=${block.length} chars, important=${block.includes('!important')}`);

  const chipRule = slice(css, '.cursor-idx {', '.cursor-pos {');
  const resets = ['border: 0;', 'cursor: pointer;', 'font-family: inherit;', 'appearance: none;'];
  const absentResets = resets.filter((prop) => !chipRule.includes(prop));
  check('the chip drops the UA button chrome and keeps the measured chip box',
    absentResets.length === 0 &&
    chipRule.includes('min-width: 18px; height: 16px; padding: 0 4px;') &&
    chipRule.includes('border-radius: 3px;') &&
    chipRule.includes('font-size: 10px; font-weight: 600;') &&
    !chipRule.includes('!important'),
    `absent=${JSON.stringify(absentResets)}, ` +
    `box=${chipRule.includes('min-width: 18px; height: 16px; padding: 0 4px;')}`);
}

{
  const rule = slice(css, '.cursor-legend {', '}');
  const required = ['flex: none;', 'color: var(--text50);', 'font-size: 10px;',
    'font-weight: 400;', 'font-variant-numeric: tabular-nums;', 'white-space: nowrap;'];
  const absentProps = required.filter((prop) => !rule.includes(prop));
  const declarations = (css.match(/\.cursor-legend/g) ?? []).length;
  check('the sheet styles the legend as a muted tabular 10 px caption',
    rule.length > 0 && absentProps.length === 0 && !rule.includes('!important') &&
    !rule.includes('margin') && declarations === 1,
    `absent=${JSON.stringify(absentProps)}, important=${rule.includes('!important')}, ` +
    `margin=${rule.includes('margin')}, declarations=${declarations}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
