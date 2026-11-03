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
  check('the position cell is formatDuration(seconds) joined to the absolute sample by /',
    cursorSection.includes('pos.textContent = `${formatDuration(row.seconds)}/${row.sample}`;') &&
    panel.includes("from './format.js'") &&
    panel.includes('formatDuration,'),
    `composed=${cursorSection.includes('${formatDuration(row.seconds)}/${row.sample}')}`);
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
  const render = slice(app, 'this.capturePanel.render({', 'this.analyzerPanel.render({');
  check('the view hands the rows to the capture panel',
    render.includes('cursors: this.cursorRows(),') &&
    app.includes('onRemoveCursor: (id) => this.removeCursor(id),'),
    `view=${render.includes('cursors: this.cursorRows(),')}, ` +
    `callback=${app.includes('onRemoveCursor: (id) => this.removeCursor(id),')}`);
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
}

{
  const keys = [
    'capturePanel.cursors', 'capturePanel.cursorEmpty', 'capturePanel.removeCursor',
  ] as const satisfies readonly MessageKey[];
  const catalogs: [string, Readonly<Record<string, string>>][] = [
    ['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr],
  ];
  const missing = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => typeof dict[key] !== 'string' || dict[key]!.trim() === '')
      .map((key) => `${locale}:${key}`));
  check('all four catalogs define the three cursor keys with non-empty values',
    missing.length === 0, `missing=${JSON.stringify(missing)}`);

  const english = {
    'capturePanel.cursors': 'Cursors',
    'capturePanel.cursorEmpty': 'Double-click the waveform to place a cursor.',
    'capturePanel.removeCursor': 'Remove cursor {label}',
  };
  const mismatched = keys.filter((key) => en[key] !== english[key]);
  check('the English values are the contracted strings',
    mismatched.length === 0,
    `mismatched=${JSON.stringify(mismatched.map((key) => [key, en[key]]))}`);

  const placeholderMissing = catalogs.filter(([, dict]) =>
    !dict['capturePanel.removeCursor']!.includes('{label}')).map(([locale]) => locale);
  check('every catalog keeps the {label} placeholder in the remove label',
    placeholderMissing.length === 0, `missing=${JSON.stringify(placeholderMissing)}`);

  const copied = catalogs.filter(([locale]) => locale !== 'en')
    .filter(([, dict]) => keys.some((key) => dict[key] === en[key])).map(([locale]) => locale);
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
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
