import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';
import { MAX_CURSOR_DISTANCE_ROWS, distanceCell, seedDistanceRow,
  type CursorDistanceRow } from '../cursorDistance.js';
import { CURSOR_EDGE_EMPTY_RESULT, MAX_CURSOR_EDGE_ROWS } from '../cursorEdges.js';
import { formatCount } from '../format.js';
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

const cursorSection = slice(panel, 'const cursorSec = section(', 'cursorPage.appendChild(cursorSec.el)');
const distanceSection = slice(panel,
  "const distanceSec = section(t('capturePanel.cursorDistance'));",
  'cursorPage.appendChild(distanceSec.el)');
const sideControlSource = slice(panel, 'function distanceSideControl(', 'function distanceAddButton(');
const sideIdSource = slice(panel, 'export function cursorDistanceSideId(', 'function distanceSideControl(');
const addControlSource = slice(panel, 'function distanceAddButton(', 'function distanceAddIcon(');
const addRowSource = slice(distanceSection, "const addRow = div('cursor-dist-add-row');",
  'distanceSec.body.appendChild(addRow);');
const distanceUpdate = slice(panel,
  'updateCursorDistances(rows: readonly CursorDistanceRowView[]): void {',
  'updateCursorEdges(rows: readonly CursorEdgeRowView[]): void {');
const edgeUpdate = slice(panel,
  'updateCursorEdges(rows: readonly CursorEdgeRowView[]): void {',
  'updateCursors(rows: readonly CursorRowView[]): void {');
const distanceRowsSource = slice(app,
  'private cursorDistanceRows(): CursorDistanceRowView[] {',
  'private edgeChannels(): number[] {');
const edgeSection = slice(panel,
  "const edgeSec = section(t('capturePanel.cursorEdges'));",
  'cursorPage.appendChild(edgeSec.el)');
const edgeSideControlSource = slice(panel, 'function edgeSideControl(', 'function edgeAddButton(');
const edgeSideIdSource = slice(panel, 'export function cursorEdgeSideId(', 'function edgeSideControl(');
const edgeAddControlSource = slice(panel, 'function edgeAddButton(', 'function appendIconPath(');
const edgeRowsSource = slice(app,
  'private cursorEdgeRows(): CursorEdgeRowView[] {',
  'private focusCursor(id: number): void {');
const edgeMethodsSource = slice(app,
  'private edgeChannels(): number[] {',
  'private cursorRows(): CursorRowView[] {');

{
  const owner = slice(panel, 'export interface CapturePanelHost {',
    'export interface CapturePanelView {').trim();
  check('the panel is constructed over the page-container pair and keeps no single root',
    owner === 'export interface CapturePanelHost {\n  capture: HTMLElement;\n  cursors: HTMLElement;\n}' &&
    panel.includes('private readonly host: CapturePanelHost,') &&
    !panel.includes('readonly root:') && !panel.includes('this.root.'),
    `host=${owner.length} chars, singleRoot=${panel.includes('this.root.')}`);

  const walks = panel.split('for (const root of this.roots()) {').length - 1;
  check('every in-place row updater walks both stored page containers',
    walks === 3 && panel.split('private *roots()').length === 2 &&
    panel.includes('yield this.host.capture;') && panel.includes('yield this.host.cursors;'),
    `walks=${walks}`);
}

{
  const captures = [
    'capture.appendChild(chSec.el)',
    'capture.appendChild(modeSec.el)',
    'capture.appendChild(triggerSec.el)',
    'capture.appendChild(advanced)',
  ].map((needle) => panel.indexOf(needle));
  const ascending = captures.every((index, i) =>
    index >= 0 && (i === 0 || index > captures[i - 1]!));
  check('the capture page order is channels, capture, trigger, advanced',
    ascending && captures.length === 4 &&
    panel.includes("const capture = this.host.capture;") &&
    panel.includes('capture.replaceChildren();'),
    `indices=${captures.join(',')}`);
}

{
  const cursors = [
    'cursorPage.appendChild(cursorSec.el)',
    'cursorPage.appendChild(distanceSec.el)',
    'cursorPage.appendChild(edgeSec.el)',
  ].map((needle) => panel.indexOf(needle));
  const ascending = cursors.every((index, i) =>
    index >= 0 && (i === 0 || index > cursors[i - 1]!));
  check('the cursors page order is cursors, distance, edges',
    ascending && cursors.length === 3 &&
    panel.includes("const cursorPage = this.host.cursors;") &&
    panel.includes('cursorPage.replaceChildren();'),
    `indices=${cursors.join(',')}`);
}

{
  const count = (needle: string): number => panel.split(needle).length - 1;
  const owner = (el: string): string => {
    const onCapture = count(`capture.appendChild(${el})`);
    const onCursors = count(`cursorPage.appendChild(${el})`);
    if (onCapture === 1 && onCursors === 0) return 'capture';
    if (onCursors === 1 && onCapture === 0) return 'cursors';
    return 'none';
  };
  const owners = ['chSec.el', 'modeSec.el', 'triggerSec.el', 'advanced',
    'cursorSec.el', 'distanceSec.el', 'edgeSec.el'].map(owner);
  check('every section is appended to exactly one page, so neither page carries the other page\u2019s sections',
    owners.join(',') === 'capture,capture,capture,capture,cursors,cursors,cursors' &&
    count('capture.replaceChildren();') === 1 && count('cursorPage.replaceChildren();') === 1,
    `owners=${owners.join(',')}, clears=${count('capture.replaceChildren();')}/` +
    `${count('cursorPage.replaceChildren();')}`);
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
  check('the position cell delegates its time/sample composition to one shared helper',
    cursorSection.includes('pos.textContent = cursorCellText(row);') &&
    !cursorSection.includes('${row.time}/${row.sample}') &&
    !cursorSection.includes('formatDuration(row.seconds)') &&
    panel.includes("from './format.js'") &&
    panel.includes('formatDuration,'),
    `delegated=${cursorSection.includes('pos.textContent = cursorCellText(row);')}, ` +
    `inline=${cursorSection.includes('${row.time}/${row.sample}')}, ` +
    `rederived=${cursorSection.includes('formatDuration(row.seconds)')}`);
}

{
  const helper = slice(panel, 'function cursorCellText(', 'function cursorRemoveButton(');
  const localHits = ['toLocaleString', 'toFixed', 'String(', 'innerHTML']
    .filter((needle) => helper.includes(needle));
  check('one module-local helper composes the row time and the formatted sample by /',
    helper.length > 0 &&
    helper.includes('function cursorCellText(row: CursorRowView): string {') &&
    helper.includes('return `${row.time}/${formatCount(row.sample)}`;') &&
    localHits.length === 0,
    `helper=${helper.length} chars, time=${helper.includes('row.time')}, ` +
    `sample=${helper.includes('formatCount(row.sample)')}, local=${JSON.stringify(localHits)}`);

  const calls = (panel.match(/cursorCellText\(row\)/g) ?? []).length;
  const compositions = (panel.match(/`\$\{row\.time\}/g) ?? []).length;
  check('both the rebuild and the live refresh read the cell through that one helper',
    calls === 2 && compositions === 1 &&
    slice(panel, 'updateCursors(rows: readonly CursorRowView[]): void {', 'private fillProgress(progress:')
      .includes('pos.textContent = cursorCellText(row);') &&
    cursorSection.includes('pos.textContent = cursorCellText(row);'),
    `calls=${calls}, compositions=${compositions}`);

  const importAt = panel.indexOf('} from \'./format.js\';');
  const importBlock = importAt < 0 ? '' : panel.slice(panel.lastIndexOf('import {', importAt), importAt);
  const importStatements = (panel.match(/from '\.\/format\.js';/g) ?? []).length;
  check('the helper reuses the shared count formatter through the existing format import',
    importBlock.includes('formatCount,') && importStatements === 1 &&
    helper.includes('formatCount(row.sample)') &&
    formatCount(123400) !== '123400' &&
    formatCount(123400).replace(/\D/g, '') === '123400',
    `imported=${importBlock.includes('formatCount,')}, statements=${importStatements}, ` +
    `grouped=${formatCount(123400) !== '123400'}`);

  check('the helper sits with the other module-local cursor DOM helpers',
    panel.indexOf('function cursorCellText(') > panel.indexOf('export class CapturePanel') &&
    panel.indexOf('function cursorCellText(') < panel.indexOf('function cursorRemoveButton(') &&
    panel.indexOf('function cursorCellText(') < panel.indexOf('function cursorRemoveIcon('),
    `at=${panel.indexOf('function cursorCellText(')}, ` +
    `remove=${panel.indexOf('function cursorRemoveButton(')}`);
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
  const render = slice(app, 'private capturePanelView(): CapturePanelView {', 'private primaryAction(): void {');
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
    consumed.slice(0, updateAt).includes('if (this.cursorsPageShown())') &&
    !consumed.includes('renderPanels('),
    `consumed=${consumed.length} chars, activate=${activateAt}, update=${updateAt}`);

  const distanceAt = consumed.indexOf(
    'if (this.cursorsPageShown()) this.capturePanel.updateCursorDistances(this.cursorDistanceRows());');
  check('a consumed drag move follows the same drag in the distance rows, after the cursor list',
    consumed.length > 0 && updateAt >= 0 && distanceAt > updateAt &&
    !consumed.slice(distanceAt).includes('renderPanels('),
    `consumed=${consumed.length} chars, update=${updateAt}, distance=${distanceAt}`);

  const callSites = (app.match(/updateCursorDistances\(/g) ?? []).length;
  const rowSites = (app.match(/updateCursorDistances\(this\.cursorDistanceRows\(\)\)/g) ?? []).length;
  const compositions = (app.match(/private cursorDistanceRows\(\): CursorDistanceRowView\[\] \{/g) ?? []).length;
  check('every distance refresh reads the one view-row composition, never an ad-hoc map',
    callSites === 4 && rowSites === 4 && compositions === 1,
    `calls=${callSites}, rows=${rowSites}, compositions=${compositions}`);
}

{
  const body = slice(app, 'private renderSidebarContent(): void {',
    'private capturePanelView(): CapturePanelView {');
  const twoPage = "if (this.sidebar.page === 'capture' || this.sidebar.page === 'cursors') {";
  const branchAt = body.indexOf(twoPage);
  const panelAt = body.indexOf('this.capturePanel.render(this.capturePanelView());');
  const analyzerAt = body.indexOf('this.analyzerPanel.render({');
  const busAt = body.lastIndexOf('this.busPanel.render(this.busPanelView());');
  const returnAt = panelAt < 0 ? -1 : body.indexOf('return;', panelAt);
  check('the sidebar content renders the capture panel for the capture page and the cursors page',
    body.length > 0 && branchAt >= 0 && panelAt > branchAt && returnAt > panelAt &&
    analyzerAt > returnAt && busAt > analyzerAt &&
    !body.includes("if (this.sidebar.page === 'capture') {") &&
    !body.includes("if (this.sidebar.page === 'cursors') {"),
    `branch=${branchAt}, panel=${panelAt}, return=${returnAt}, analyzer=${analyzerAt}, ` +
    `bus=${busAt}`);
}

{
  const shown = slice(app, 'private cursorsPageShown(): boolean {',
    'private decodersPageShown(): boolean {');
  const captureShown = slice(app, 'private capturePageShown(): boolean {',
    'private cursorsPageShown(): boolean {');
  check('the cursors page predicate tests the cursors page only, so live drag refreshes keep running there',
    shown.length > 0 &&
    shown.includes("return s.visible && s.page === 'cursors';") &&
    !shown.includes('assistant') && !shown.includes('capture') &&
    captureShown.includes("s.page === 'capture'") &&
    !captureShown.includes("'cursors'"),
    `shown=${shown.length} chars, capture=${shown.includes('capture')}, ` +
    `predicate=${shown.includes("s.page === 'cursors'")}`);
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
    update.indexOf('for (const root of this.roots()) {') >= 0 &&
    update.indexOf("root.querySelectorAll<HTMLElement>('.cursor-row')") >
      update.indexOf('new Map<number, CursorRowView>()'),
    `update=${update.length} chars, write=${write.length} chars, hits=${JSON.stringify(structuralHits)}`);

  const writeBans = structural.concat(['dataset', 'className']);
  const writeHits = writeBans.filter((needle) => write.includes(needle));
  check('the write site touches only the position text of an existing row',
    write.includes('pos.textContent = cursorCellText(row);') &&
    !write.includes('${row.time}/${row.sample}') &&
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
    `liveWalk=${update.includes("root.querySelectorAll<HTMLElement>('.cursor-row')")}`);
}

{
  const retention = slice(app, 'private enforceLoopRetention(store: SampleStore): void {',
    'private async stopCapture(');
  const shiftAt = retention.indexOf('if (cursor.marker.sample !== sample) shifted = true;');
  const branchAt = retention.indexOf('} else if (shifted && this.cursorsPageShown()) {');
  const updateAt = retention.indexOf('this.capturePanel.updateCursors(this.cursorRows());');
  const originAt = retention.indexOf('const next = this.triggerSampleIndex! - drop;');
  check('a retention shift with an intact cursor list refreshes the rows in place',
    retention.length > 0 && shiftAt >= 0 && branchAt > shiftAt && updateAt > branchAt &&
    originAt >= 0 && originAt < shiftAt &&
    retention.lastIndexOf('const next = this.triggerSampleIndex! - drop;') < updateAt,
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

  const shiftBranch = slice(retention, '} else if (shifted && this.cursorsPageShown()) {',
    'this.hover = null;');
  const shiftListAt = shiftBranch.indexOf('this.capturePanel.updateCursors(this.cursorRows());');
  const shiftDistanceAt = shiftBranch.indexOf(
    'this.capturePanel.updateCursorDistances(this.cursorDistanceRows());');
  check('a retention shift refreshes the distance rows after the cursor list, in the same branch',
    shiftBranch.length > 0 && shiftListAt >= 0 && shiftDistanceAt > shiftListAt &&
    !shiftBranch.includes('renderPanels('),
    `branch=${shiftBranch.length} chars, list=${shiftListAt}, distance=${shiftDistanceAt}`);

  const pruneAt = retention.indexOf('this.distanceRows = pruneDistancePairs(');
  const dropRenderAt = dropAt < 0 ? -1 : retention.indexOf('this.renderPanels();', dropAt);
  check('a retention drop prunes the pairs that lost their cursor before the panel renders',
    dropAt >= 0 && pruneAt > dropAt && dropRenderAt > pruneAt &&
    retention.slice(pruneAt, dropRenderAt).includes(
      'new Set(this.cursors.map((cursor) => cursor.id)),'),
    `drop=${dropAt}, prune=${pruneAt}, render=${dropRenderAt}`);
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
  const declarations = (css.match(/\.cursor-legend\s*\{/g) ?? []).length;
  const scoped = (css.match(/\.cursor-dist-head \.cursor-legend\s*\{/g) ?? []).length;
  const baseRules = declarations - scoped;
  check('the sheet styles the legend as a muted tabular 10 px caption',
    rule.length > 0 && absentProps.length === 0 && !rule.includes('!important') &&
    !rule.includes('margin') && baseRules === 1 && scoped === 1,
    `absent=${JSON.stringify(absentProps)}, important=${rule.includes('!important')}, ` +
    `margin=${rule.includes('margin')}, baseRules=${baseRules}, scoped=${scoped}`);
}

{
  const cursorsAppend = panel.indexOf('cursorPage.appendChild(cursorSec.el)');
  const distanceAppend = panel.indexOf('cursorPage.appendChild(distanceSec.el)');
  check('the Cursor distance section follows Cursors on the cursors page and never reaches the capture page',
    distanceSection.length > 0 && cursorsAppend >= 0 && distanceAppend > cursorsAppend &&
    !panel.includes('capture.appendChild(distanceSec.el)') &&
    panel.includes("const distanceSec = section(t('capturePanel.cursorDistance'));"),
    `cursors=${cursorsAppend}, distance=${distanceAppend}`);
}

{
  const legendAt = distanceSection.indexOf('distanceSec.header.appendChild(distanceLegend);');
  const headAppends = distanceSection.match(/distanceSec\.header\.appendChild\(/g) ?? [];
  check('the section head carries only the title and the translated legend',
    legendAt >= 0 && headAppends.length === 1 &&
    distanceSection.includes("distanceLegend.className = 'cursor-legend';") &&
    distanceSection.includes("distanceLegend.textContent = t('capturePanel.cursorDistanceFormat');") &&
    !distanceSection.includes('distanceSec.header.appendChild(distanceAddButton(') &&
    !distanceSection.includes('distanceSec.body.appendChild(distanceLegend)'),
    `legend=${legendAt}, headAppends=${headAppends.length}`);
}

{
  const emptyAt = distanceSection.indexOf('if (v.cursorDistances.length === 0) {');
  const listAt = distanceSection.indexOf("const list = div('cursor-dist-list');");
  const addRowAt = distanceSection.indexOf("const addRow = div('cursor-dist-add-row');");
  const addAt = distanceSection.indexOf('addRow.appendChild(distanceAddButton(');
  const bodyAddAt = distanceSection.indexOf('distanceSec.body.appendChild(addRow);');
  const addCalls = distanceSection.match(/distanceAddButton\(/g) ?? [];
  const addRowRule = slice(css, '.cursor-dist-add-row {', '}');
  check("the add control is the section body's last line, left-aligned",
    emptyAt >= 0 && listAt > emptyAt && addRowAt > listAt && addAt > addRowAt &&
    bodyAddAt > addAt && addCalls.length === 1 && addRowSource.length > 0 &&
    !distanceSection.slice(bodyAddAt + 1).includes('distanceSec.body.appendChild(') &&
    addRowRule.includes('display: flex;') && addRowRule.includes('align-items: center;') &&
    addRowRule.includes('justify-content: flex-start;') && !addRowRule.includes('!important'),
    `empty=${emptyAt}, list=${listAt}, row=${addRowAt}, add=${addAt}, body=${bodyAddAt}, ` +
    `calls=${addCalls.length}, rule=${addRowRule.length} chars`);
}

{
  const emptyAt = distanceSection.indexOf('if (v.cursorDistances.length === 0) {');
  const listAt = distanceSection.indexOf("const list = div('cursor-dist-list');");
  const emptyBranch = emptyAt < 0 ? '' : distanceSection.slice(emptyAt, listAt);
  const emptyKeys = (emptyBranch.match(/capturePanel\.cursorDistanceEmpty/g) ?? []).length;
  const noRowsKeys = (emptyBranch.match(/capturePanel\.cursorDistanceNoRows/g) ?? []).length;
  check('the empty hint word is chosen from the cursor count, not from the row count',
    emptyBranch.length > 0 && listAt > emptyAt &&
    emptyBranch.includes('t(v.cursors.length < 2') &&
    emptyBranch.includes("? 'capturePanel.cursorDistanceEmpty' : 'capturePanel.cursorDistanceNoRows');") &&
    emptyKeys === 1 && noRowsKeys === 1 &&
    emptyBranch.includes("hint.className = 'cursor-dist-hint';") &&
    !emptyBranch.includes('cursorDistances.length < 2'),
    `empty=${emptyKeys}, noRows=${noRowsKeys}, list=${listAt}, branch=${emptyBranch.length} chars`);
}

{
  const titleRule = slice(css, '.cursor-dist-head > span:first-child {', '}');
  const legendRule = slice(css, '.cursor-dist-head .cursor-legend {', '}');
  const titleDecls = ['min-width: 0;', 'white-space: nowrap;', 'overflow: hidden;',
    'text-overflow: ellipsis;'];
  const missingTitle = titleDecls.filter((decl) => !titleRule.includes(decl));
  const headClass = "distanceSec.header.classList.add('cursor-dist-head');";
  check('the distance title ellipsizes on one line inside the head',
    distanceSection.includes(headClass) && missingTitle.length === 0 &&
    !titleRule.includes('container-type') && !titleRule.includes('!important'),
    `class=${distanceSection.includes(headClass)}, missing=${JSON.stringify(missingTitle)}, ` +
    `important=${titleRule.includes('!important')}`);

  const forbiddenLegend = ['flex: 0 1 auto;', 'min-width: 0;', 'overflow: hidden;',
    'text-overflow: ellipsis;', 'display: none;'].filter((decl) => legendRule.includes(decl));
  check('the head legend never hides and never shrinks',
    legendRule.includes('flex: none;') && forbiddenLegend.length === 0 &&
    !legendRule.includes('!important'),
    `rule=${legendRule.length} chars, forbidden=${JSON.stringify(forbiddenLegend)}`);

  const containerBlocks = css.match(/@container[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
  const distanceContainers = containerBlocks.filter((block) => block.includes('.cursor-dist-head'));
  const legendHideRules = [...css.matchAll(/([^{}]+)\{([^{}]*display:\s*none;[^{}]*)\}/g)]
    .filter((match) => match[1]!.includes('.cursor-legend'));
  check('no sheet rule or container query hides the distance legend at any width',
    distanceContainers.length === 0 && legendHideRules.length === 0,
    `containers=${distanceContainers.length}, hideRules=${legendHideRules.length}`);
}

{
  check('the add control refuses the sixteenth row through the shared cap literal',
    addRowSource.includes('v.cursorDistances.length >= MAX_CURSOR_DISTANCE_ROWS,') &&
    addRowSource.includes('() => this.cb.onAddCursorDistance(),') &&
    panel.includes("from './cursorDistance.js';") &&
    MAX_CURSOR_DISTANCE_ROWS === 15,
    `guard=${addRowSource.includes('v.cursorDistances.length >= MAX_CURSOR_DISTANCE_ROWS,')}, ` +
    `callback=${addRowSource.includes('this.cb.onAddCursorDistance()')}, ` +
    `cap=${MAX_CURSOR_DISTANCE_ROWS}`);

  check('the add control reuses the shared compact action shape and names itself',
    addControlSource.includes("b.className = 'analyzer-act cursor-dist-add';") &&
    addControlSource.includes('b.disabled = disabled;') &&
    addControlSource.includes("const label = t('capturePanel.cursorDistanceAdd');") &&
    addControlSource.includes('b.title = label;') &&
    addControlSource.includes("b.setAttribute('aria-label', label);") &&
    addControlSource.includes('b.appendChild(distanceAddIcon());') &&
    addControlSource.includes("b.addEventListener('click', onAdd);") &&
    !addControlSource.includes('style.'),
    `shape=${addControlSource.includes("b.className = 'analyzer-act cursor-dist-add';")}, ` +
    `disabled=${addControlSource.includes('b.disabled = disabled;')}, ` +
    `inline=${addControlSource.includes('style.')}`);

  const ownAddRule = /\.cursor-dist-add\s*\{/.test(css);
  check('the add geometry comes from the shared action class, not a copied rule',
    !ownAddRule && css.includes('.analyzer-act {') &&
    css.includes('.analyzer-act svg { display: block; width: 13px; height: 13px; }'),
    `ownRule=${ownAddRule}`);

  const titleWrites = (addControlSource.match(/\.title = /g) ?? []).length;
  check('the capped add control keeps the add label as its single tooltip',
    addRowSource.includes('v.cursorDistances.length >= MAX_CURSOR_DISTANCE_ROWS,') &&
    addControlSource.includes("const label = t('capturePanel.cursorDistanceAdd');") &&
    addControlSource.includes('b.disabled = disabled;') &&
    addControlSource.includes('b.title = label;') &&
    titleWrites === 1 &&
    !addControlSource.includes('disabled ?') &&
    !addControlSource.includes("'capturePanel.cursorDistanceAdd' +"),
    `titles=${titleWrites}, cap=${addRowSource.includes('MAX_CURSOR_DISTANCE_ROWS,')}, ` +
    `conditional=${addControlSource.includes('disabled ?')}`);
}

{
  check('each row carries its stable row id for the live updater',
    distanceSection.includes('item.dataset.distanceId = String(row.id);') &&
    distanceSection.includes("const item = div('cursor-dist-row');") &&
    distanceSection.includes("const list = div('cursor-dist-list');"),
    `dataset=${distanceSection.includes('item.dataset.distanceId = String(row.id);')}`);

  const aAt = distanceSection.indexOf("distanceSideControl(row, 'a', v.cursors,");
  const markAt = distanceSection.indexOf("mark.className = 'cursor-dist-mark';");
  const bAt = distanceSection.indexOf("distanceSideControl(row, 'b', v.cursors,");
  const deltaAt = distanceSection.indexOf("delta.className = 'cursor-dist-delta';");
  const removeAt = distanceSection.indexOf('const remove = cursorRemoveButton(');
  const tailAt = distanceSection.indexOf("const tail = div('cursor-dist-tail');");
  const tailAppendAt = distanceSection.indexOf('tail.append(delta, remove);');
  const appendAt = distanceSection.indexOf(
    'item.append(a.el, mark, b.el, tail, a.popover, b.popover);');
  check('the row is side A, minus mark, side B, then one tail holding the delta and remove',
    aAt >= 0 && markAt > aAt && bAt > markAt && deltaAt > bAt && removeAt > deltaAt &&
    tailAt > removeAt && tailAppendAt > tailAt && appendAt > tailAppendAt &&
    !distanceSection.includes('item.append(a.el, mark, b.el, remove, delta, a.popover, b.popover);') &&
    !distanceSection.includes('item.append(a.el, mark, b.el, delta, remove, a.popover, b.popover);') &&
    distanceSection.includes("mark.textContent = '→';") &&
    distanceSection.includes("mark.setAttribute('aria-hidden', 'true');"),
    `a=${aAt}, mark=${markAt}, b=${bAt}, delta=${deltaAt}, remove=${removeAt}, ` +
    `tail=${tailAt}, tailAppend=${tailAppendAt}, append=${appendAt}`);
}

{
  const tailRule = slice(css, '.cursor-dist-tail {', '.cursor-dist-delta {');
  const rowAppend = slice(distanceSection,
    'item.append(a.el, mark, b.el,', 'list.appendChild(item);');
  const tailIsOneItem = rowAppend.includes('tail, a.popover, b.popover);') &&
    !rowAppend.includes('delta,') && !rowAppend.includes('remove,');
  check('the delta and the remove control share one wrapping flex item',
    tailRule.length > 0 &&
    tailRule.includes('display: flex;') &&
    tailRule.includes('flex: 1 0 auto;') &&
    tailRule.includes('align-items: center;') &&
    tailRule.includes('gap: 6px;') &&
    !tailRule.includes('!important') &&
    distanceSection.includes('tail.append(delta, remove);') &&
    tailIsOneItem,
    `rule=${tailRule.length} chars, oneItem=${tailIsOneItem}, ` +
    `append=${rowAppend.replace(/\s+/g, ' ').trim()}`);
}

{
  const rowRule = slice(css, '.cursor-dist-row {\n  display: flex;', '.cursor-dist-side.is-unset {');
  check('the distance row is the approved adaptive-wrap flex row',
    rowRule.length > 0 &&
    rowRule.includes('display: flex; flex-wrap: wrap; align-items: center;') &&
    rowRule.includes('column-gap: 6px; row-gap: 2px;') &&
    rowRule.includes('font-size: 11px;') && !rowRule.includes('!important'),
    `rule=${rowRule.length} chars`);

  const deltaRule = slice(css, '.cursor-dist-delta {', '.cursor-dist-hint {');
  const truncation = ['text-overflow', 'overflow: hidden', 'ellipsis']
    .filter((needle) => deltaRule.includes(needle));
  check('the delta wraps as one item and is never truncated',
    deltaRule.length > 0 && deltaRule.includes('flex: 1 0 auto; min-width: 0;') &&
    deltaRule.includes('color: var(--text80);') &&
    deltaRule.includes('font-variant-numeric: tabular-nums;') &&
    deltaRule.includes('white-space: nowrap;') && truncation.length === 0,
    `rule=${deltaRule.length} chars, truncation=${JSON.stringify(truncation)}`);
}

{
  check('an unset side renders the placeholder with its muted state class',
    sideControlSource.includes(
      "el.className = 'cursor-idx cursor-dist-side' + (pick === null ? ' is-unset' : '');") &&
    sideControlSource.includes("el.textContent = pick === null ? '–' : pick.label;") &&
    css.includes('.cursor-dist-side.is-unset {') &&
    slice(css, '.cursor-dist-side.is-unset {', '}').includes('color: var(--text80);') &&
    css.includes('box-shadow: inset 0 0 0 1px var(--border-high);') &&
    !css.includes('box-shadow: inset 0 0 0 1px var(--border-low);'),
    `class=${sideControlSource.includes('is-unset')}, ` +
    `glyph=${sideControlSource.includes("pick === null ? '–' : pick.label")}, ` +
    `ring=${css.includes('inset 0 0 0 1px var(--border-high)')}`);

  check('a set side paints the cursor colour with its own foreground',
    sideControlSource.includes('el.style.background = pick.color;') &&
    sideControlSource.includes('el.style.color = chipForeground(pick.color);') &&
    !sideControlSource.includes('chipForeground(undefined'),
    `bg=${sideControlSource.includes('el.style.background = pick.color;')}, ` +
    `fg=${sideControlSource.includes('el.style.color = chipForeground(pick.color);')}`);

  check('the accessible name names the row, the side and the current pick',
    sideControlSource.includes(
      "t(side === 'a' ? 'capturePanel.cursorDistanceStart' : 'capturePanel.cursorDistanceEnd',") &&
    sideControlSource.includes('{ row: row.row });') &&
    sideControlSource.includes(
      "const name = `${action}: ${pick === null ? t('capturePanel.cursorDistanceUnset') : pick.label}`;") &&
    sideControlSource.includes('el.title = name;') &&
    sideControlSource.includes("el.setAttribute('aria-label', name);"),
    `action=${sideControlSource.includes('capturePanel.cursorDistanceStart')}, ` +
    `unset=${sideControlSource.includes("t('capturePanel.cursorDistanceUnset')")}`);

  check('the side button keeps Space for its own popover activation',
    sideControlSource.includes("el.addEventListener('keydown', (e) => {") &&
    sideControlSource.includes("if (e.key === ' ') e.stopPropagation();"),
    `guarded=${sideControlSource.includes("if (e.key === ' ') e.stopPropagation();")}`);

  const listenerBody = (source: string): string => {
    const start = source.indexOf("window.addEventListener('keydown', (e) => {");
    return start < 0 ? '' : source.slice(start, source.indexOf('\n    });', start));
  };
  const pickerGuardOrder = (source: string): boolean => {
    const listener = listenerBody(source);
    const anywhere = listener.indexOf('if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {');
    const guard = listener.indexOf("closest('.select-field");
    const dispatch = listener.indexOf('this.runShortcut(id, e.shiftKey)', guard);
    return anywhere >= 0 && guard > anywhere && dispatch > guard;
  };
  const anywhereBlock = '      if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {\n' +
    '        if (this.runShortcut(id, e.shiftKey)) e.preventDefault();\n' +
    '        return;\n      }\n';
  const movedBelowGuard = app.replace(anywhereBlock, '').replace(
    "            target.closest('.ch-editor-popover, button, [role=\"button\"], [role=\"slider\"]') !== null)) return;\n",
    "            target.closest('.ch-editor-popover, button, [role=\"button\"], [role=\"slider\"]') !== null)) return;\n" +
      anywhereBlock);
  check('the popover keeps Space and Escape for its own picker',
    app.includes("target.closest('.select-field, .assistant-panel, .cursor-dist-popover') !== null") &&
    pickerGuardOrder(app) && movedBelowGuard !== app && !pickerGuardOrder(movedBelowGuard),
    `guard=${app.includes('.cursor-dist-popover')}, real=${pickerGuardOrder(app)}, ` +
    `moved=${pickerGuardOrder(movedBelowGuard)}`);

  const escapeBlock = slice(app, "case 'cursors.clear':", 'this.clearCursors();');
  check('an open picker hands Escape back to the browser before the cursor clear',
    escapeBlock.includes(
      "        if (document.querySelector('.cursor-dist-popover:popover-open') !== null) return false;\n" +
      '        this.releaseMarkerPointer();') &&
    !escapeBlock.includes('clearCursors'),
    `block=${escapeBlock.length} chars, clear=${escapeBlock.includes('clearCursors')}`);
}

{
  check('the side button anchors a native auto popover under its own id',
    sideIdSource.includes(
      'export function cursorDistanceSideId(rowId: number, side: DistanceSide): string {') &&
    sideControlSource.includes('const id = cursorDistanceSideId(row.id, side);') &&
    sideControlSource.includes('el.id = id;') &&
    sideControlSource.includes("el.setAttribute('popovertarget', menuId);") &&
    sideControlSource.includes("el.style.setProperty('anchor-name', `--${id}`);") &&
    sideControlSource.includes('popover.id = menuId;') &&
    sideControlSource.includes("popover.setAttribute('popover', 'auto');") &&
    sideControlSource.includes("popover.style.setProperty('position-anchor', `--${id}`);"),
    `target=${sideControlSource.includes('popovertarget')}, ` +
    `anchor=${sideControlSource.includes('anchor-name')}, ` +
    `position=${sideControlSource.includes('position-anchor')}`);

  const resolveIdExpr = (expr: string, vars: Record<string, string>): string | null => {
    const trimmed = expr.trim();
    const named = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(trimmed);
    if (named) {
      return Object.prototype.hasOwnProperty.call(vars, trimmed) ? vars[trimmed] : null;
    }
    const literal = /^`([^`]*)`$/.exec(trimmed);
    if (literal === null) return null;
    let out = '';
    let rest = literal[1];
    for (;;) {
      const at = rest.indexOf('${');
      if (at < 0) return out + rest;
      out += rest.slice(0, at);
      const end = rest.indexOf('}', at);
      if (end < 0) return null;
      const key = rest.slice(at + 2, end);
      if (!Object.prototype.hasOwnProperty.call(vars, key)) return null;
      out += vars[key];
      rest = rest.slice(end + 1);
    }
  };
  const idExpr = /return (`[^`]*`);/.exec(sideIdSource)?.[1] ?? '';
  const menuExpr = /const menuId = (`[^`]*`);/.exec(sideControlSource)?.[1] ?? '';
  const base = resolveIdExpr(idExpr, { rowId: '7', side: 'a' });
  const menu = resolveIdExpr(menuExpr, { id: base ?? '' });
  const vars: Record<string, string> = { 'row.id': '7', side: 'a' };
  if (base !== null) vars.id = base;
  if (menu !== null) vars.menuId = menu;
  const expr = (pattern: RegExp): string => pattern.exec(sideControlSource)?.[1] ?? '';
  const invoker = resolveIdExpr(expr(/el\.id = ([^;]+);/), vars);
  const popoverId = resolveIdExpr(expr(/popover\.id = ([^;]+);/), vars);
  const target = resolveIdExpr(expr(/el\.setAttribute\('popovertarget', ([^)]+)\);/), vars);
  const anchor = resolveIdExpr(expr(/el\.style\.setProperty\('anchor-name', ([^)]+)\);/), vars);
  const position = resolveIdExpr(expr(/popover\.style\.setProperty\('position-anchor', ([^)]+)\);/), vars);
  check('the invoker and its popover take different ids joined by popovertarget',
    base !== null && menu !== null &&
    invoker === base && popoverId === menu && invoker !== popoverId &&
    target === popoverId &&
    anchor === `--${base}` && position === `--${base}`,
    `invoker=${invoker}, popover=${popoverId}, target=${target}, ` +
    `anchor=${anchor}, position=${position}`);

  const popoverRule = slice(css, '.cursor-dist-popover {\n  position: fixed;',
    '.cursor-dist-popover:popover-open {');
  check('the popover surface takes the shared tokens and the anchor fallbacks',
    popoverRule.includes('position-area: bottom center;') &&
    popoverRule.includes('position-try-fallbacks: flip-block, flip-inline;') &&
    popoverRule.includes('background: var(--popover); color: var(--popover-foreground);') &&
    popoverRule.includes('border: 1px solid var(--border); border-radius: var(--radius);') &&
    popoverRule.includes('max-height: 224px;') && popoverRule.includes('overflow-y: auto;') &&
    popoverRule.includes('animation: motion-pop var(--motion-fast) var(--motion-ease);'),
    `rule=${popoverRule.length} chars`);

  check('closing the popover returns focus to its side button with no document listener',
    sideControlSource.includes("popover.addEventListener('toggle', () => {") &&
    sideControlSource.includes("if (popover.matches(':popover-open')) return;") &&
    sideControlSource.includes('if (el.isConnected) el.focus();') &&
    !sideControlSource.includes('document.addEventListener') &&
    !sideControlSource.includes('window.addEventListener') &&
    !sideControlSource.includes('showPopover'),
    `toggle=${sideControlSource.includes('matches(\':popover-open\')')}, ` +
    `global=${sideControlSource.includes('document.addEventListener')}`);
}

{
  check('each choice row carries the cursor id, its colour chip and the shared cell text',
    sideControlSource.includes('choice.dataset.cursorId = String(cursor.id);') &&
    sideControlSource.includes("chip.className = 'cursor-idx';") &&
    sideControlSource.includes('chip.style.background = cursor.color;') &&
    sideControlSource.includes('chip.style.color = chipForeground(cursor.color);') &&
    sideControlSource.includes("pos.className = 'cursor-pos';") &&
    sideControlSource.includes('pos.textContent = cursorCellText(cursor);') &&
    sideControlSource.includes('choice.append(mark, chip, pos);') &&
    !sideControlSource.includes('${cursor.time}/${cursor.sample}'),
    `chip=${sideControlSource.includes('chip.style.background = cursor.color;')}, ` +
    `cell=${sideControlSource.includes('cursorCellText(cursor)')}`);

  check('the current pick marks itself with the state class and the check column',
    sideControlSource.includes(
      "choice.className = 'cursor-dist-choice' + (current ? ' is-current' : '');") &&
    sideControlSource.includes("mark.className = 'cursor-dist-choice-mark';") &&
    sideControlSource.includes("mark.setAttribute('aria-hidden', 'true');") &&
    sideControlSource.includes("mark.textContent = current ? '✓' : '';") &&
    sideControlSource.includes('const current = pick !== null && pick.id === cursor.id;') &&
    sideControlSource.includes("choice.addEventListener('click', () => onPick(cursor.id));"),
    `current=${sideControlSource.includes('is-current')}, ` +
    `pick=${sideControlSource.includes('onPick(cursor.id)')}`);

  check('a picker with no cursors reuses the existing cursor empty hint',
    sideControlSource.includes('if (cursors.length === 0) {') &&
    sideControlSource.includes("empty.className = 'cursor-dist-popover-empty';") &&
    sideControlSource.includes("empty.textContent = t('capturePanel.cursorEmpty');") &&
    !sideControlSource.includes('cursorDistanceEmpty'),
    `reused=${sideControlSource.includes("t('capturePanel.cursorEmpty')")}`);
}

{
  check('the three distance callbacks are part of the panel contract',
    panel.includes('onAddCursorDistance(): void;') &&
    panel.includes('onRemoveCursorDistance(rowId: number): void;') &&
    panel.includes('onPickCursorDistance(rowId: number, side: DistanceSide, cursorId: number): void;') &&
    panel.includes("from './cursorDistance.js';"),
    `add=${panel.includes('onAddCursorDistance(): void;')}, ` +
    `remove=${panel.includes('onRemoveCursorDistance(rowId: number): void;')}, ` +
    `pick=${panel.includes('onPickCursorDistance(')}`);

  check('the row controls raise the row-scoped callbacks',
    distanceSection.includes("(cursorId) => this.cb.onPickCursorDistance(row.id, 'a', cursorId));") &&
    distanceSection.includes("(cursorId) => this.cb.onPickCursorDistance(row.id, 'b', cursorId));") &&
    distanceSection.includes('() => this.cb.onRemoveCursorDistance(row.id),') &&
    distanceSection.includes("t('capturePanel.cursorDistanceRemove', { row: row.row }),"),
    `pickA=${distanceSection.includes("this.cb.onPickCursorDistance(row.id, 'a'")}, ` +
    `pickB=${distanceSection.includes("this.cb.onPickCursorDistance(row.id, 'b'")}, ` +
    `remove=${distanceSection.includes('this.cb.onRemoveCursorDistance(row.id)')}`);

  check('App routes the three callbacks to its own row list',
    app.includes('onAddCursorDistance: () => this.addDistanceRow(),') &&
    app.includes('onRemoveCursorDistance: (rowId) => this.removeDistanceRow(rowId),') &&
    app.includes('this.pickDistanceCursor(rowId, side, cursorId),'),
    `add=${app.includes('onAddCursorDistance: () => this.addDistanceRow(),')}, ` +
    `remove=${app.includes('onRemoveCursorDistance:')}, ` +
    `pick=${app.includes('this.pickDistanceCursor(rowId, side, cursorId)')}`);
}

{
  const seed = slice(app, 'private addCursor(sample: number): void {',
    'private addDistanceRow(): void {');
  check('placing a second cursor seeds one row from the current list, once',
    seed.includes('if (this.cursors.length === 2) {') &&
    seed.includes('const seeded = seedDistanceRow(') &&
    seed.indexOf('const seeded = seedDistanceRow(') > seed.indexOf('if (this.cursors.length === 2) {') &&
    seed.includes('this.distanceRows, this.nextDistanceRowId, this.defaultCursorPair() ?? [],') &&
    seed.includes('if (seeded !== null) {') &&
    seed.includes('this.nextDistanceRowId++;') &&
    !seed.includes('this.distanceRows.push'),
    `gate=${seed.includes('if (this.cursors.length === 2) {')}, ` +
    `seed=${seed.includes('seedDistanceRow(')}, ` +
    `guard=${seed.includes('if (seeded !== null) {')}, ` +
    `mutate=${seed.includes('this.distanceRows.push')}`);

  const gate = /if \(this\.cursors\.length === (\d+)\) \{/.exec(seed)?.[1];
  const gateLimit = gate === undefined ? Number.NaN : Number(gate);
  const afterAdd = (cursorCount: number, rows: readonly CursorDistanceRow[]) =>
    cursorCount === gateLimit
      ? seedDistanceRow(rows, 1, Array.from({ length: cursorCount }, (_, i) => i + 10)) ?? rows
      : rows;
  const firstPair = afterAdd(2, []);
  const thirdCursor = afterAdd(3, []);
  check('the seed belongs to the first pair, so a third cursor never restores a removed row',
    gateLimit === 2 && firstPair.length === 1 &&
    firstPair[0]?.a === 10 && firstPair[0]?.b === 11 &&
    thirdCursor.length === 0,
    `gate=${gateLimit}, first=${JSON.stringify(firstPair)}, third=${JSON.stringify(thirdCursor)}`);

  const add = slice(app, 'private addDistanceRow(): void {',
    'private removeDistanceRow(rowId: number): void {');
  check('the add control appends one row, pre-filled with the latest cursor pair, and re-renders',
    add.includes('const rows = appendDistanceRow(this.distanceRows, this.nextDistanceRowId, this.defaultCursorPair());') &&
    add.includes('if (rows === this.distanceRows) return;') &&
    add.includes('this.nextDistanceRowId++;') && add.includes('this.renderPanels();'),
    `call=${add.includes('appendDistanceRow(this.distanceRows, this.nextDistanceRowId)')}`);

  const remove = slice(app, 'private removeDistanceRow(rowId: number): void {',
    'private pickDistanceCursor(rowId: number, side: DistanceSide, cursorId: number): void {');
  check('the row remove control drops exactly its row and re-renders',
    remove.includes('this.distanceRows = dropDistanceRow(this.distanceRows, rowId);') &&
    remove.includes('this.renderPanels();'),
    `drop=${remove.includes('dropDistanceRow(this.distanceRows, rowId)')}`);

  const pick = slice(app,
    'private pickDistanceCursor(rowId: number, side: DistanceSide, cursorId: number): void {',
    'private cursorDistanceRows(): CursorDistanceRowView[] {');
  check('a pick assigns one side of one row and re-renders',
    pick.includes('this.distanceRows = assignDistanceCursor(this.distanceRows, rowId, side, cursorId);') &&
    pick.includes('this.renderPanels();'),
    `assign=${pick.includes('assignDistanceCursor(this.distanceRows, rowId, side, cursorId)')}`);

  const renderAt = pick.indexOf('this.renderPanels();');
  const lookupAt = pick.indexOf('const invoker = document.getElementById(cursorDistanceSideId(rowId, side));');
  const focusAt = pick.indexOf('if (invoker !== null) invoker.focus();');
  const focusCalls = (pick.match(/\.focus\(\)/g) ?? []).length;
  check('a pick hands focus back to the rebuilt side button after the panel rebuild',
    renderAt >= 0 && lookupAt > renderAt && focusAt > lookupAt && focusCalls === 1 &&
    app.includes('import { CapturePanel, cursorDistanceSideId,') &&
    !add.includes('focus') && !remove.includes('focus'),
    `render=${renderAt}, lookup=${lookupAt}, focus=${focusAt}, calls=${focusCalls}`);

  const cursorRemove = slice(app, 'private removeCursor(id: number): void {',
    'private clearCursors(): void {');
  check('removing a cursor clears only the sides that referenced it',
    cursorRemove.includes('this.distanceRows = pruneDistancePairs(') &&
    cursorRemove.includes('new Set(this.cursors.map((cursor) => cursor.id)),'),
    `prune=${cursorRemove.includes('pruneDistancePairs(')}`);

  const clear = slice(app, 'private clearCursors(): void {', 'private cancelMarkerDrags(): void {');
  check('clearing every cursor empties the sides and keeps the rows',
    clear.includes('this.distanceRows = clearDistancePairs(this.distanceRows);') &&
    !clear.includes('this.distanceRows = []'),
    `pairClear=${clear.includes('clearDistancePairs(this.distanceRows)')}, ` +
    `dropped=${clear.includes('this.distanceRows = []')}`);
}

{
  check('the view resolves labels and colours from the current list position',
    distanceRowsSource.includes('const labels = cursorLabels(this.cursors.length);') &&
    distanceRowsSource.includes(
      'sides.set(cursor.id, { id: cursor.id, label: labels[index]!, color: cursorColor(index) });') &&
    distanceRowsSource.includes('row: index + 1,') &&
    distanceRowsSource.includes('a: row.a === null ? null : sides.get(row.a) ?? null,') &&
    distanceRowsSource.includes('b: row.b === null ? null : sides.get(row.b) ?? null,'),
    `rows=${distanceRowsSource.length} chars`);

  check('only finite samples enter the map, so an unset cursor stays an absent key',
    distanceRowsSource.includes('const sample = cursor.marker.sample;') &&
    distanceRowsSource.includes('if (sample !== null && Number.isFinite(sample)) samples.set(cursor.id, sample);') &&
    !distanceRowsSource.includes('?? 0') && !distanceRowsSource.includes('as number') &&
    !distanceRowsSource.includes('Number(sample)') &&
    distanceRowsSource.includes('delta: distanceCell(row, samples, samplePeriod),') &&
    distanceRowsSource.includes('const samplePeriod = 1 / this.store.samplerate;'),
    `finite=${distanceRowsSource.includes('Number.isFinite(sample)')}, ` +
    `coerced=${distanceRowsSource.includes('?? 0')}`);

  const render = slice(app, 'private capturePanelView(): CapturePanelView {', 'private primaryAction(): void {');
  check('the view carries the resolved distance rows to the capture panel',
    render.includes('cursorDistances: this.cursorDistanceRows(),') &&
    panel.includes('cursorDistances: readonly CursorDistanceRowView[];'),
    `view=${render.includes('cursorDistances: this.cursorDistanceRows(),')}`);

  check('an incomplete pair keeps an empty delta cell, never a fabricated zero',
    distanceSection.includes('delta.textContent = row.delta;') &&
    !distanceSection.includes("?? '0") && !distanceSection.includes("'0 s/0'") &&
    distanceCell({ id: 1, a: 3, b: null }, new Map([[3, 10]]), 1e-8) === '' &&
    distanceCell({ id: 2, a: 3, b: 4 }, new Map([[3, 10]]), 1e-8) === '',
    `unset=${distanceCell({ id: 1, a: 3, b: null }, new Map([[3, 10]]), 1e-8) === ''}, ` +
    `missing=${distanceCell({ id: 2, a: 3, b: 4 }, new Map([[3, 10]]), 1e-8) === ''}`);
}

{
  const structural = ['replaceChildren', 'appendChild', 'insertBefore', 'remove(', 'innerHTML',
    'createElement', 'renderPanels'];
  const structuralHits = structural.filter((needle) => distanceUpdate.includes(needle));
  check('the live distance update walks the rendered rows and rebuilds nothing',
    distanceUpdate.length > 0 && structuralHits.length === 0 &&
    distanceUpdate.includes("root.querySelectorAll<HTMLElement>('.cursor-dist-row')") &&
    distanceUpdate.includes('byId.get(Number(item.dataset.distanceId))') &&
    distanceUpdate.includes('if (row === undefined) continue;') &&
    distanceUpdate.includes('if (delta === null) continue;') &&
    !distanceUpdate.includes('this.cb.'),
    `update=${distanceUpdate.length} chars, hits=${JSON.stringify(structuralHits)}`);

  const writeAt = distanceUpdate.indexOf(
    "const delta = item.querySelector<HTMLElement>('.cursor-dist-delta');");
  const write = writeAt < 0 ? '' : distanceUpdate.slice(writeAt);
  const writeBans = structural.concat(['dataset', 'className', 'style']);
  const writeHits = writeBans.filter((needle) => write.includes(needle));
  check('the write site touches only the delta text of an existing row',
    write.includes('delta.textContent = row.delta;') && writeHits.length === 0,
    `write=${write.length} chars, hits=${JSON.stringify(writeHits)}`);
}

{
  const keys = [
    'capturePanel.cursorDistance', 'capturePanel.cursorDistanceFormat',
    'capturePanel.cursorDistanceEmpty', 'capturePanel.cursorDistanceNoRows',
    'capturePanel.cursorDistanceAdd', 'capturePanel.cursorDistanceRemove',
    'capturePanel.cursorDistanceStart', 'capturePanel.cursorDistanceEnd',
    'capturePanel.cursorDistanceUnset',
  ] as const satisfies readonly MessageKey[];
  const catalogs: [string, Readonly<Record<string, string>>][] = [
    ['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr],
  ];
  const value = (dict: Readonly<Record<string, string>>, key: string): string => dict[key] ?? '';

  const missing = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => value(dict, key).trim() === '').map((key) => `${locale}:${key}`));
  check('all four catalogs define the nine cursor distance keys',
    missing.length === 0 && keys.length === 9, `missing=${JSON.stringify(missing)}`);

  const english: Record<string, string> = {
    'capturePanel.cursorDistance': 'Cursor distance',
    'capturePanel.cursorDistanceFormat': 'Δtime/Δsamples · 1/Δt',
    'capturePanel.cursorDistanceEmpty':
      'Place two cursors on the waveform to read the distance between them.',
    'capturePanel.cursorDistanceNoRows': 'Add a row to compare two cursors.',
    'capturePanel.cursorDistanceAdd': 'Add a distance row',
    'capturePanel.cursorDistanceRemove': 'Remove distance row {row}',
    'capturePanel.cursorDistanceStart': 'Choose the first cursor for row {row}',
    'capturePanel.cursorDistanceEnd': 'Choose the second cursor for row {row}',
    'capturePanel.cursorDistanceUnset': 'not set',
  };
  const mismatched = keys.filter((key) => value(en, key) !== english[key]);
  check('the English distance values are the contracted strings',
    mismatched.length === 0,
    `mismatched=${JSON.stringify(mismatched.map((key) => [key, value(en, key)]))}`);

  const rowKeys = keys.filter((key) => english[key].includes('{row}'));
  const placeholderMissing = catalogs.flatMap(([locale, dict]) =>
    rowKeys.filter((key) => !value(dict, key).includes('{row}')).map((key) => `${locale}:${key}`));
  const placeholderExtra = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => !rowKeys.includes(key) && value(dict, key).includes('{row}'))
      .map((key) => `${locale}:${key}`));
  check('every catalog keeps {row} on exactly the three row-bearing labels',
    rowKeys.length === 3 && placeholderMissing.length === 0 && placeholderExtra.length === 0,
    `rowKeys=${JSON.stringify(rowKeys)}, missing=${JSON.stringify(placeholderMissing)}, ` +
    `extra=${JSON.stringify(placeholderExtra)}`);

  const copied = catalogs.filter(([locale]) => locale !== 'en')
    .filter(([, dict]) => keys.some((key) => value(dict, key) === value(en, key)))
    .map(([locale]) => locale);
  check('no locale reuses the English cursor distance prose',
    copied.length === 0, `copied=${JSON.stringify(copied)}`);

  const hints = catalogs.map(([locale, dict]) => [locale,
    value(dict, 'capturePanel.cursorDistanceEmpty'),
    value(dict, 'capturePanel.cursorDistanceNoRows')] as const);
  const repeated = hints.filter(([, empty, noRows]) =>
    noRows.trim() === '' || empty === noRows).map(([locale]) => locale);
  check('the no-cursors and no-rows hints stay distinct in every locale',
    repeated.length === 0, `repeated=${JSON.stringify(repeated)}`);

  const legend = catalogs.map(([locale, dict]) =>
    [locale, value(dict, 'capturePanel.cursorDistanceFormat')] as const);
  const malformed = legend.filter(([, text]) => !text.includes('Δ') || !text.includes('/'));
  check('the distance legend stays a Δ pair in every locale',
    malformed.length === 0 && !legend.some(([locale]) => locale !== 'en' &&
      legend[0]?.[1] === legend.find(([l]) => l === locale)?.[1]),
    `values=${JSON.stringify(legend)}`);
}

{
  const cursorDistanceAppend = panel.indexOf('cursorPage.appendChild(distanceSec.el)');
  const edgeAppend = panel.indexOf('cursorPage.appendChild(edgeSec.el)');
  check('the Edges section immediately follows Cursor distance on the cursors page',
    edgeSection.length > 0 && cursorDistanceAppend >= 0 && edgeAppend > cursorDistanceAppend &&
    !panel.includes('capture.appendChild(edgeSec.el)') &&
    panel.includes("const edgeSec = section(t('capturePanel.cursorEdges'));"),
    `distance=${cursorDistanceAppend}, edges=${edgeAppend}`);

  const headAppends = edgeSection.match(/edgeSec\.header\.appendChild\(/g) ?? [];
  check('the Edges head carries only its translated rising/falling/total legend',
    edgeSection.includes("edgeSec.header.classList.add('cursor-edge-head');") &&
    edgeSection.includes("edgeLegend.className = 'cursor-legend';") &&
    edgeSection.includes("edgeLegend.textContent = t('capturePanel.cursorEdgesFormat');") &&
    headAppends.length === 1 && !edgeSection.includes('edgeSec.body.appendChild(edgeLegend)'),
    `headAppends=${headAppends.length}`);
}

{
  const emptyAt = edgeSection.indexOf('if (v.cursorEdges.length === 0) {');
  const listAt = edgeSection.indexOf("const list = div('cursor-edge-list');");
  const emptyBranch = emptyAt < 0 ? '' : edgeSection.slice(emptyAt, listAt);
  check('the Edges empty hint distinguishes too few cursors from no measurement rows',
    emptyAt >= 0 && listAt > emptyAt && emptyBranch.includes('t(v.cursors.length < 2') &&
    emptyBranch.includes("? 'capturePanel.cursorEdgesEmpty' : 'capturePanel.cursorEdgesNoRows');") &&
    emptyBranch.includes("hint.className = 'cursor-edge-hint';"),
    `empty=${emptyAt}, list=${listAt}, branch=${emptyBranch.length} chars`);

  const addRowAt = edgeSection.indexOf("const edgeAddRow = div('cursor-edge-add-row');");
  const addAt = edgeSection.indexOf('edgeAddRow.appendChild(edgeAddButton(');
  const bodyAddAt = edgeSection.indexOf('edgeSec.body.appendChild(edgeAddRow);');
  check('the bottom Edges add action is left aligned, capped at fifteen, and wired to App',
    addRowAt > listAt && addAt > addRowAt && bodyAddAt > addAt &&
    !edgeSection.slice(bodyAddAt + 1).includes('edgeSec.body.appendChild(') &&
    edgeSection.includes('v.cursorEdges.length >= MAX_CURSOR_EDGE_ROWS,') &&
    edgeSection.includes('() => this.cb.onAddCursorEdge(),') &&
    MAX_CURSOR_EDGE_ROWS === 15 &&
    slice(css, '.cursor-edge-add-row {', '}').includes('justify-content: flex-start;'),
    `row=${addRowAt}, add=${addAt}, body=${bodyAddAt}, cap=${MAX_CURSOR_EDGE_ROWS}`);

  check('the Edges add button reuses the shared compact action and plus icon',
    edgeAddControlSource.includes("b.className = 'analyzer-act cursor-edge-add';") &&
    edgeAddControlSource.includes('b.disabled = disabled;') &&
    edgeAddControlSource.includes("const label = t('capturePanel.cursorEdgesAdd');") &&
    edgeAddControlSource.includes('b.appendChild(distanceAddIcon());') &&
    edgeAddControlSource.includes("b.addEventListener('click', onAdd);") &&
    !/\.cursor-edge-add\s*\{/.test(css),
    `source=${edgeAddControlSource.length} chars`);
}

{
  const aAt = edgeSection.indexOf("edgeSideControl(row, 'a', v.cursors,");
  const markAt = edgeSection.indexOf("mark.className = 'cursor-dist-mark cursor-edge-mark';");
  const bAt = edgeSection.indexOf("edgeSideControl(row, 'b', v.cursors,");
  const atAt = edgeSection.indexOf("at.className = 'cursor-dist-mark cursor-edge-mark';");
  const channelAt = edgeSection.indexOf('const channel = selectControl(');
  const resultAt = edgeSection.indexOf("result.className = 'cursor-edge-result';");
  const tailAt = edgeSection.indexOf("const tail = div('cursor-edge-tail');");
  const appendAt = edgeSection.indexOf(
    'item.append(a.el, mark, b.el, at, channel.el, tail, a.popover, b.popover);');
  check('each Edges row is A, minus, B, @, channel, then one result/remove tail',
    edgeSection.includes('item.dataset.edgeId = String(row.id);') &&
    aAt >= 0 && markAt > aAt && bAt > markAt && atAt > bAt && channelAt > atAt &&
    resultAt > channelAt && tailAt > resultAt && appendAt > tailAt &&
    edgeSection.includes("mark.textContent = '−';") && edgeSection.includes("at.textContent = '@';") &&
    edgeSection.includes('tail.append(result, remove);') &&
    edgeSection.includes('result.textContent = row.result;'),
    `a=${aAt}, mark=${markAt}, b=${bAt}, at=${atAt}, channel=${channelAt}, ` +
    `result=${resultAt}, tail=${tailAt}, append=${appendAt}`);

  const rowRule = slice(css, '.cursor-edge-row {', '.cursor-edge-mark {');
  const tailRule = slice(css, '.cursor-edge-tail {', '.cursor-edge-result {');
  const resultRule = slice(css, '.cursor-edge-result {', '.cursor-edge-add-row {');
  const truncation = ['text-overflow', 'overflow: hidden', 'ellipsis']
    .filter((needle) => resultRule.includes(needle));
  check('Edges rows use the distance adaptive-wrap geometry and never truncate results',
    rowRule.includes('display: flex; flex-wrap: wrap; align-items: center;') &&
    rowRule.includes('column-gap: 6px; row-gap: 2px;') &&
    tailRule.includes('display: flex; flex: 1 0 auto; align-items: center; gap: 6px;') &&
    resultRule.includes('flex: 1 0 auto; min-width: 0;') &&
    resultRule.includes('font-variant-numeric: tabular-nums;') &&
    resultRule.includes('white-space: nowrap;') && truncation.length === 0,
    `row=${rowRule.length}, tail=${tailRule.length}, result=${resultRule.length}, ` +
    `truncation=${JSON.stringify(truncation)}`);
}

{
  check('edge cursor chips share the distance set/unset appearance and current cursor colours',
    edgeSideControlSource.includes(
      "el.className = 'cursor-idx cursor-dist-side cursor-edge-side' + (pick === null ? ' is-unset' : '');") &&
    edgeSideControlSource.includes("el.textContent = pick === null ? '–' : pick.label;") &&
    edgeSideControlSource.includes('el.style.background = pick.color;') &&
    edgeSideControlSource.includes('el.style.color = chipForeground(pick.color);') &&
    css.includes('.cursor-dist-side.is-unset {'),
    `class=${edgeSideControlSource.includes('cursor-dist-side cursor-edge-side')}, ` +
    `unset=${edgeSideControlSource.includes('is-unset')}`);

  check('edge cursor controls have row/side-specific translated names and preserve Space activation',
    edgeSideControlSource.includes(
      "t(side === 'a' ? 'capturePanel.cursorEdgesStart' : 'capturePanel.cursorEdgesEnd',") &&
    edgeSideControlSource.includes('{ row: row.row });') &&
    edgeSideControlSource.includes('el.title = name;') &&
    edgeSideControlSource.includes("el.setAttribute('aria-label', name);") &&
    edgeSideControlSource.includes("if (e.key === ' ') e.stopPropagation();"),
    `source=${edgeSideControlSource.length} chars`);

  check('each edge cursor chip anchors its own native auto popover with distinct invoker/menu ids',
    edgeSideIdSource.includes('return `cursor-edge-${rowId}-${side}`;') &&
    edgeSideControlSource.includes('const id = cursorEdgeSideId(row.id, side);') &&
    edgeSideControlSource.includes('const menuId = `${id}-menu`;') &&
    edgeSideControlSource.includes('el.id = id;') &&
    edgeSideControlSource.includes('popover.id = menuId;') &&
    edgeSideControlSource.includes("el.setAttribute('popovertarget', menuId);") &&
    edgeSideControlSource.includes("popover.setAttribute('popover', 'auto');") &&
    edgeSideControlSource.includes("el.style.setProperty('anchor-name', `--${id}`);") &&
    edgeSideControlSource.includes("popover.style.setProperty('position-anchor', `--${id}`);") &&
    edgeSideControlSource.includes("popover.className = 'cursor-dist-popover cursor-edge-popover';") &&
    !edgeSideControlSource.includes('document.addEventListener') &&
    !edgeSideControlSource.includes('window.addEventListener'),
    `id=${edgeSideIdSource.length} chars, control=${edgeSideControlSource.length} chars`);

  check('edge picker rows reuse the distance choice anatomy and restore invoker focus on close',
    edgeSideControlSource.includes(
      "choice.className = 'cursor-dist-choice cursor-edge-choice' + (current ? ' is-current' : '');") &&
    edgeSideControlSource.includes('choice.dataset.cursorId = String(cursor.id);') &&
    edgeSideControlSource.includes('pos.textContent = cursorCellText(cursor);') &&
    edgeSideControlSource.includes("choice.addEventListener('click', () => onPick(cursor.id));") &&
    edgeSideControlSource.includes("popover.addEventListener('toggle', () => {") &&
    edgeSideControlSource.includes('if (el.isConnected) el.focus();'),
    `choice=${edgeSideControlSource.includes('cursor-dist-choice cursor-edge-choice')}, ` +
    `focus=${edgeSideControlSource.includes('if (el.isConnected) el.focus();')}`);
}

{
  check('the compact channel select has an explicit unset and enabled channels in App display order',
    edgeSection.includes("['', t('capturePanel.cursorEdgesUnset')],") &&
    edgeSection.includes('...v.cursorEdgeChannels.map((channel): SelectOptionTuple => [String(channel.index), channel.name]),') &&
    edgeSection.includes('`cursor.edge.channel.${row.id}`,') &&
    edgeSection.includes("t('capturePanel.cursorEdgesChannel', { row: row.row }),") &&
    edgeSection.includes("row.channel === null ? '' : String(row.channel),") &&
    !edgeSection.includes(['createElement(', "'select'", ')'].join('')),
    `unset=${edgeSection.includes('capturePanel.cursorEdgesUnset')}, ` +
    `channels=${edgeSection.includes('String(channel.index)')}`);

  const optionLine = edgeSection.split('\n')
    .find((line) => line.includes('v.cursorEdgeChannels.map(')) ?? '';
  check('edge channel options are labelled with the channel name itself, untranslated and unprefixed',
    optionLine.length > 0 &&
    optionLine.includes('[String(channel.index), channel.name]') &&
    !optionLine.includes('t(') &&
    !edgeSection.includes('`D${') &&
    edgeSection.includes("row.id, channel.value === '' ? null : Number(channel.value),"),
    `option=${optionLine.trim().length} chars, ` +
    `prefix=${edgeSection.includes('`D${')}, ` +
    `absolute=${edgeSection.includes("channel.value === '' ? null : Number(channel.value)")}`);

  const configure = slice(app, 'private configureChannel(', 'private relayout(): void {');
  const nameWriteAt = configure.indexOf('this.channels[channel] = { ...current, name, color: config.color };');
  const configureRenderAt = configure.indexOf('this.renderPanels();');
  check('a rename normalizes and stores the channel name before the rebuild that relabels the picker',
    configure.includes('const name = config.name.trim() || defaultChannelName(channel);') &&
    nameWriteAt >= 0 && configureRenderAt > nameWriteAt,
    `write=${nameWriteAt}, render=${configureRenderAt}, ` +
    `fallback=${configure.includes('config.name.trim() || defaultChannelName(channel)')}`);

  check('channel changes commit an absolute channel or null through the row-scoped callback',
    edgeSection.includes("channel.el.classList.add('cursor-edge-channel');") &&
    edgeSection.includes("channel.addEventListener('change', () => this.cb.onPickCursorEdgeChannel(") &&
    edgeSection.includes("row.id, channel.value === '' ? null : Number(channel.value),"),
    `change=${edgeSection.includes('onPickCursorEdgeChannel')}`);

  const channelRule = slice(css, '.cursor-edge-channel {', '.cursor-edge-channel > label {');
  const labelRule = slice(css, '.cursor-edge-channel > label {', '.cursor-edge-channel .select-trigger {');
  const triggerRule = slice(css, '.cursor-edge-channel .select-trigger {',
    '.cursor-edge-channel .select-trigger-icon {');
  check('the channel field is compact while its associated accessible label remains present',
    channelRule.includes('flex: 0 0 58px; width: 58px; gap: 0;') &&
    labelRule.includes('position: absolute; width: 1px; height: 1px;') &&
    labelRule.includes('clip-path: inset(50%);') &&
    triggerRule.includes('height: 20px; min-height: 20px; padding: 1px 4px; gap: 2px;') &&
    !triggerRule.includes('animation:') && !triggerRule.includes('!important'),
    `field=${channelRule.length}, label=${labelRule.length}, trigger=${triggerRule.length}`);
}

{
  check('the four edge callbacks are panel inputs, not panel-local session state',
    panel.includes('onAddCursorEdge(): void;') &&
    panel.includes('onRemoveCursorEdge(rowId: number): void;') &&
    panel.includes('onPickCursorEdge(rowId: number, side: DistanceSide, cursorId: number): void;') &&
    panel.includes('onPickCursorEdgeChannel(rowId: number, channel: number | null): void;') &&
    !edgeSection.includes('countCursorEdges') && !edgeSection.includes('.edges(') &&
    !edgeSection.includes('sampleAt(') && !edgeSection.includes('formatCount('),
    `section=${edgeSection.length} chars`);

  check('App owns monotonically allocated edge rows and routes every panel callback',
    app.includes('private edgeRows: readonly CursorEdgeRow[] = [];') &&
    app.includes('private nextEdgeRowId = 1;') &&
    app.includes('onAddCursorEdge: () => this.addEdgeRow(),') &&
    app.includes('onRemoveCursorEdge: (rowId) => this.removeEdgeRow(rowId),') &&
    app.includes('onPickCursorEdge: (rowId, side, cursorId) => this.pickEdgeCursor(rowId, side, cursorId),') &&
    app.includes('onPickCursorEdgeChannel: (rowId, channel) => this.pickEdgeChannel(rowId, channel),'),
    `methods=${edgeMethodsSource.length} chars`);

  check('a new edge row defaults to the first enabled available channel and respects the pure cap',
    edgeMethodsSource.includes(
      'this.edgeRows, this.nextEdgeRowId, this.edgeChannels()[0] ?? null, this.defaultCursorPair());') &&
    edgeMethodsSource.includes('return this.enabledChannels().map((channel) => channel.index);') &&
    edgeMethodsSource.includes('if (rows === this.edgeRows) return;') &&
    edgeMethodsSource.indexOf('this.nextEdgeRowId++;') >
      edgeMethodsSource.indexOf('if (rows === this.edgeRows) return;') &&
    edgeMethodsSource.includes('this.edgeRows = dropEdgeRow(this.edgeRows, rowId);'),
    `source=${edgeMethodsSource.length} chars`);

  const pick = slice(app,
    'private pickEdgeCursor(rowId: number, side: DistanceSide, cursorId: number): void {',
    'private pickEdgeChannel(rowId: number, channel: number | null): void {');
  const renderAt = pick.indexOf('this.renderPanels();');
  const focusAt = pick.indexOf('if (invoker !== null) invoker.focus();');
  check('cursor and channel picks update App state, rebuild, and restore cursor-invoker focus',
    pick.includes('this.edgeRows = assignEdgeCursor(this.edgeRows, rowId, side, cursorId);') &&
    pick.includes('document.getElementById(cursorEdgeSideId(rowId, side))') &&
    renderAt >= 0 && focusAt > renderAt &&
    edgeMethodsSource.includes('this.edgeRows = assignEdgeChannel(this.edgeRows, rowId, channel);'),
    `render=${renderAt}, focus=${focusAt}`);
}

{
  check('App projects cursor identities and labels without deriving measurements in the panel',
    edgeRowsSource.includes('const labels = cursorLabels(this.cursors.length);') &&
    edgeRowsSource.includes(
      'sides.set(cursor.id, { id: cursor.id, label: labels[index]!, color: cursorColor(index) });') &&
    edgeRowsSource.includes('a: row.a === null ? null : sides.get(row.a) ?? null,') &&
    edgeRowsSource.includes('b: row.b === null ? null : sides.get(row.b) ?? null,') &&
    edgeRowsSource.includes('row: index + 1,'),
    `source=${edgeRowsSource.length} chars`);

  check('only complete, available, in-range rows on a usable current capture invoke the exact counter',
    edgeRowsSource.includes('let result = CURSOR_EDGE_EMPTY_RESULT;') &&
    edgeRowsSource.includes('this.store.length > 0 && row.channel !== null && channels.has(row.channel)') &&
    !edgeRowsSource.includes('!this.running') &&
    edgeRowsSource.includes('aSample !== undefined && bSample !== undefined &&') &&
    edgeRowsSource.includes('aSample <= this.store.length && bSample <= this.store.length') &&
    edgeRowsSource.includes('countCursorEdges(this.store, row.channel, aSample, bSample).cell') &&
    edgeRowsSource.includes('channel: row.channel !== null && channels.has(row.channel) ? row.channel : null,') &&
    CURSOR_EDGE_EMPTY_RESULT === '-/-/-',
    `empty=${CURSOR_EDGE_EMPTY_RESULT}, source=${edgeRowsSource.length} chars`);

  const render = slice(app, 'private capturePanelView(): CapturePanelView {', 'private primaryAction(): void {');
  const edgeChannelView = slice(panel, 'export interface CursorEdgeChannelView {', 'export interface CapturePanelHost {').trim();
  check('the capture view carries resolved edge rows and the named enabled available channels',
    render.includes('cursorEdges: this.cursorEdgeRows(),') &&
    render.includes('cursorEdgeChannels: this.edgeChannelOptions(),') &&
    panel.includes('cursorEdges: readonly CursorEdgeRowView[];') &&
    panel.includes('cursorEdgeChannels: readonly CursorEdgeChannelView[];') &&
    edgeChannelView === 'export interface CursorEdgeChannelView {\n  index: number;\n  name: string;\n}' &&
    app.includes('return this.enabledChannels().map((channel) => ({ index: channel.index, name: channel.name }));'),
    `rows=${render.includes('cursorEdges:')}, channels=${render.includes('cursorEdgeChannels:')}, ` +
    `view=${edgeChannelView.length} chars`);

  const move = slice(app, "plot.addEventListener('pointermove', (e) => {", 'const end = (e: PointerEvent) => {');
  check('pointer movement never recomputes edge counts; the existing drag-end rebuild owns refresh',
    !move.includes('cursorEdgeRows') && !move.includes('countCursorEdges') &&
    !move.includes('updateCursorEdges'),
    `move=${move.length} chars`);
}

{
  const remove = slice(app, 'private removeCursor(id: number): void {', 'private clearCursors(): void {');
  const removePrune = remove.indexOf('this.edgeRows = pruneEdgeCursors(');
  const removeRender = remove.indexOf('this.renderPanels();');
  check('deleting a cursor prunes its id from edge rows before the rebuild without dropping rows',
    removePrune >= 0 && removeRender > removePrune &&
    remove.slice(removePrune, removeRender).includes(
      'new Set(this.cursors.map((cursor) => cursor.id)),') &&
    !remove.includes('this.edgeRows = []'),
    `prune=${removePrune}, render=${removeRender}`);

  const clear = slice(app, 'private clearCursors(): void {', 'private cancelMarkerDrags(): void {');
  check('clearing cursors empties both edge sides while preserving every row and channel',
    clear.includes('this.edgeRows = clearEdgeCursors(this.edgeRows);') &&
    !clear.includes('this.edgeRows = []') && !clear.includes('assignEdgeChannel'),
    `clear=${clear.length} chars`);

  const reconcile = slice(app, 'private reconcileEdgeChannels(): void {', 'private addEdgeRow(): void {');
  const channelCallers = [
    slice(app, 'private applySettings(s: CaptureSettings): void {', 'private configureChannel('),
    slice(app, 'private afterChannelChange(): void {', 'private reorder('),
    slice(app, 'private adoptCapture(store: SampleStore', 'private saveItems(): SettingsMenuItem[] {'),
    slice(app, 'private adoptDeviceChannels(device: Device): void {', 'private async startCapture('),
    slice(app, 'private async startCapture(', 'private enforceLoopRetention('),
  ];
  check('mask, width, device, file, and hardware-capture transitions reconcile absolute channels in state',
    reconcile.includes('this.edgeRows = pruneEdgeChannels(this.edgeRows, new Set(this.edgeChannels()));') &&
    channelCallers.every((caller) => caller.includes('this.reconcileEdgeChannels();')),
    `callers=${channelCallers.map((caller) => caller.includes('this.reconcileEdgeChannels();')).join(',')}`);

  const reorder = slice(app, 'private reorder(from: number, to: number): void {', '// ------------------------------------------------------------------ frame');
  const configure = slice(app, 'private configureChannel(', 'private relayout(): void {');
  check('reorder and rename retain edge identities while rebuilding current labels and channel order',
    reorder.includes('this.renderPanels();') && !reorder.includes('pruneEdge') &&
    !reorder.includes('assignEdge') && !configure.includes('pruneEdge') &&
    !configure.includes('assignEdge') && configure.includes('this.renderPanels();'),
    `reorderRender=${reorder.includes('this.renderPanels();')}`);

  const retention = slice(app, 'private enforceLoopRetention(store: SampleStore): void {',
    'private async stopCapture(');
  const drop = retention.indexOf('if (this.cursors.length !== beforeDrop) {');
  const prune = retention.indexOf('this.edgeRows = pruneEdgeCursors(');
  const render = retention.indexOf('this.renderPanels();', Math.max(0, drop));
  check('a retention drop prunes deleted cursor ids from edge rows before its whole-panel refresh',
    drop >= 0 && prune > drop && render > prune &&
    retention.slice(prune, render).includes('new Set(this.cursors.map((cursor) => cursor.id)),'),
    `drop=${drop}, prune=${prune}, render=${render}`);

  const shift = slice(retention, '} else if (shifted && this.cursorsPageShown()) {', 'this.hover = null;');
  const cursorAt = shift.indexOf('this.capturePanel.updateCursors(this.cursorRows());');
  const distanceAt = shift.indexOf('this.capturePanel.updateCursorDistances(this.cursorDistanceRows());');
  const edgeAt = shift.indexOf('this.capturePanel.updateCursorEdges(this.cursorEdgeRows());');
  check('a retention shift refreshes edge results after adjusted cursor and distance rows, without a rebuild',
    cursorAt >= 0 && distanceAt > cursorAt && edgeAt > distanceAt && !shift.includes('renderPanels('),
    `cursor=${cursorAt}, distance=${distanceAt}, edge=${edgeAt}`);

  const structural = ['replaceChildren', 'appendChild', 'insertBefore', 'remove(', 'innerHTML',
    'createElement'].filter((needle) => edgeUpdate.includes(needle));
  check('the retention edge updater resolves stable row ids and rewrites only result text',
    edgeUpdate.includes("root.querySelectorAll<HTMLElement>('.cursor-edge-row')") &&
    edgeUpdate.includes('byId.get(Number(item.dataset.edgeId))') &&
    edgeUpdate.includes("item.querySelector<HTMLElement>('.cursor-edge-result')") &&
    edgeUpdate.includes('result.textContent = row.result;') && structural.length === 0,
    `source=${edgeUpdate.length} chars, structural=${JSON.stringify(structural)}`);
}

{
  const keys = [
    'capturePanel.cursorEdges', 'capturePanel.cursorEdgesFormat',
    'capturePanel.cursorEdgesEmpty', 'capturePanel.cursorEdgesNoRows',
    'capturePanel.cursorEdgesAdd', 'capturePanel.cursorEdgesRemove',
    'capturePanel.cursorEdgesStart', 'capturePanel.cursorEdgesEnd',
    'capturePanel.cursorEdgesChannel', 'capturePanel.cursorEdgesUnset',
  ] as const satisfies readonly MessageKey[];
  const catalogs: [string, Readonly<Record<string, string>>][] = [
    ['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr],
  ];
  const value = (dict: Readonly<Record<string, string>>, key: string): string => dict[key] ?? '';
  const missing = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => value(dict, key).trim() === '').map((key) => `${locale}:${key}`));
  check('all four catalogs define the ten Edges strings',
    missing.length === 0 && keys.length === 10, `missing=${JSON.stringify(missing)}`);

  const english: Record<string, string> = {
    'capturePanel.cursorEdges': 'Edges',
    'capturePanel.cursorEdgesFormat': 'Rising/Falling/Edges',
    'capturePanel.cursorEdgesEmpty': 'Place two cursors on the waveform to count edges between them.',
    'capturePanel.cursorEdgesNoRows': 'Add a row to count edges between two cursors.',
    'capturePanel.cursorEdgesAdd': 'Add an edge row',
    'capturePanel.cursorEdgesRemove': 'Remove edge row {row}',
    'capturePanel.cursorEdgesStart': 'Choose the first cursor for edge row {row}',
    'capturePanel.cursorEdgesEnd': 'Choose the second cursor for edge row {row}',
    'capturePanel.cursorEdgesChannel': 'Choose the channel for edge row {row}',
    'capturePanel.cursorEdgesUnset': '–',
  };
  const mismatched = keys.filter((key) => value(en, key) !== english[key]);
  check('the English Edges copy matches the approved measurement vocabulary',
    mismatched.length === 0,
    `mismatched=${JSON.stringify(mismatched.map((key) => [key, value(en, key)]))}`);

  const rowKeys = keys.filter((key) => english[key].includes('{row}'));
  const placeholderMissing = catalogs.flatMap(([locale, dict]) =>
    rowKeys.filter((key) => !value(dict, key).includes('{row}')).map((key) => `${locale}:${key}`));
  const placeholderExtra = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => !rowKeys.includes(key) && value(dict, key).includes('{row}'))
      .map((key) => `${locale}:${key}`));
  check('every locale keeps {row} on exactly the four row-bearing Edges labels',
    rowKeys.length === 4 && placeholderMissing.length === 0 && placeholderExtra.length === 0,
    `rows=${JSON.stringify(rowKeys)}, missing=${JSON.stringify(placeholderMissing)}, ` +
    `extra=${JSON.stringify(placeholderExtra)}`);

  const proseKeys = keys.filter((key) => key !== 'capturePanel.cursorEdgesUnset');
  const copied = catalogs.filter(([locale]) => locale !== 'en')
    .filter(([, dict]) => proseKeys.some((key) => value(dict, key) === value(en, key)))
    .map(([locale]) => locale);
  check('no locale reuses English Edges prose; the symbolic unset stays locale-neutral',
    copied.length === 0 && catalogs.every(([, dict]) =>
      value(dict, 'capturePanel.cursorEdgesUnset') === '–'),
    `copied=${JSON.stringify(copied)}`);

  const hints = catalogs.map(([locale, dict]) => [locale,
    value(dict, 'capturePanel.cursorEdgesEmpty'), value(dict, 'capturePanel.cursorEdgesNoRows')] as const);
  const legends = catalogs.map(([locale, dict]) =>
    [locale, value(dict, 'capturePanel.cursorEdgesFormat')] as const);
  check('Edges hints stay distinct and every legend names a three-part slash readout',
    hints.every(([, empty, noRows]) => empty !== noRows) &&
    legends.every(([, legend]) => legend.split('/').length === 3),
    `hints=${JSON.stringify(hints)}, legends=${JSON.stringify(legends)}`);

  check('the themed Edges hint uses the same muted token as Cursor distance',
    css.includes(':is(html[data-theme="dark"], html[data-theme="light"]) .cursor-dist-hint,\n' +
      ':is(html[data-theme="dark"], html[data-theme="light"]) .cursor-edge-hint { color: var(--muted-foreground); }'),
    `themed=${css.includes('.cursor-edge-hint { color: var(--muted-foreground); }')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
