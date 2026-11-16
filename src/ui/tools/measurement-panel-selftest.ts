// SPDX-License-Identifier: GPL-3.0-or-later

import {
  measurementNoteText, measurementStatusText, measurementValueText, measurementWindowText,
  CapturePanel, type CapturePanelCallbacks,
} from '../capturePanel.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';
import type {
  MeasurementRowView, MeasurementSectionView, MeasurementStatus,
} from '../measurementState.js';
import { installFakeDom, type FakeElement } from './fakeDom.js';

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
const app = read('src/ui/app.ts');
const css = read('src/ui/style.css');

const measureSection = slice(panel, 'const measureSec = section(',
  'cursorPage.appendChild(measureSec.el)');
const measureUpdater = slice(panel, 'updateMeasurements(view: MeasurementSectionView): void {',
  'updateCursors(rows: readonly CursorRowView[]): void {');
const appView = slice(app, 'private capturePanelView(): CapturePanelView {',
  'private primaryAction(): void {');
const frame = (() => {
  const start = app.indexOf('private frame = (): void => {');
  if (start < 0) return '';
  const end = app.indexOf('\n  };', start);
  return end < 0 ? '' : app.slice(start, end);
})();
const applyConfig = slice(app, 'private applyMeasurementConfig(',
  'private pickMeasurementFilter(');
const pickRange = slice(app, 'private pickMeasurementRange(',
  'private pickMeasurementCursor(');
const pickCursor = slice(app, 'private pickMeasurementCursor(',
  'private addMeasurementParameter(');
const addParameter = slice(app, 'private addMeasurementParameter(',
  'private removeMeasurementRowById(');
const removeParameter = slice(app, 'private removeMeasurementRowById(',
  '// ------------------------------------------------------------------ bus views');

function rowView(over: Partial<MeasurementRowView> = {}): MeasurementRowView {
  return {
    id: 1,
    start: 0,
    sourceName: 'A0',
    parameter: 'frequency',
    value: Number.NaN,
    unit: 'hz',
    status: 'ok',
    analyzedSamples: 0,
    requestedSamples: 0,
    truncated: false,
    rangeClipped: false,
    gaps: false,
    clippedLow: false,
    clippedHigh: false,
    nearSampleLimit: false,
    crossingCap: false,
    crossingCount: 0,
    dutyPeriods: 0,
    dutyExcludedPeriods: 0,
    ...over,
  };
}

function sectionView(over: Partial<MeasurementSectionView> = {}): MeasurementSectionView {
  return {
    sources: [],
    filter: null,
    range: { kind: 'viewport', a: null, b: null },
    cursors: [],
    rows: [],
    addStart: null,
    availableParameters: [],
    window: null,
    unavailable: null,
    ...over,
  };
}

const STATUS_TEXT: Record<MeasurementStatus, string> = {
  'ok': '',
  'no-source': 'no analog group selected',
  'no-window': 'no measurement window',
  'no-data': 'no samples in the window',
  'no-crossing': 'no qualified crossing',
  'one-crossing': 'one qualified crossing; a period needs two',
  'no-period': 'no complete qualified period',
  'previous-wave-displayed': 'an older capture is on screen; waiting for the current one',
};

{
  check('the section is titled and legended from the measurement keys',
    measureSection.includes("const measureSec = section(t('capturePanel.measure'));") &&
    measureSection.includes("measureLegend.className = 'cursor-legend';") &&
    measureSection.includes("measureLegend.textContent = t('capturePanel.measureFormat');") &&
    measureSection.includes('measureSec.header.appendChild(measureLegend);'),
    `title=${measureSection.includes("section(t('capturePanel.measure'))")}, ` +
    `legend=${measureSection.includes("t('capturePanel.measureFormat')")}`);

  const cursorAppend = panel.indexOf('cursorPage.appendChild(cursorSec.el)');
  const measureStart = panel.indexOf('const measureSec = section(');
  const distanceStart = panel.indexOf("const distanceSec = section(t('capturePanel.cursorDistance'));");
  const edgeStart = panel.indexOf("const edgeSec = section(t('capturePanel.cursorEdges'));");
  check('the measurement section sits second on the cursors page, between cursors and distance',
    cursorAppend >= 0 && measureStart > cursorAppend && distanceStart > measureStart &&
    edgeStart > distanceStart &&
    !panel.includes('capture.appendChild(measureSec.el)'),
    `cursor=${cursorAppend}, measure=${measureStart}, distance=${distanceStart}, ` +
    `edge=${edgeStart}`);
}

{
  const filterAt = measureSection.indexOf("selectControl(\n      'measure.filter',");
  const rangeAt = measureSection.indexOf("selectControl(\n      'measure.range',");
  check('the filter and range selects are the first two controls of the section',
    filterAt >= 0 && rangeAt > filterAt &&
    measureSection.includes("t('capturePanel.measureSource')") &&
    measureSection.includes("t('capturePanel.measureRange')") &&
    measureSection.includes("['', t('capturePanel.measureSourceAll')],") &&
    measureSection.includes('(source): SelectOptionTuple => ' +
      '[String(source.start), source.name])') &&
    measureSection.includes("v.measurement.filter === null ? '' : String(v.measurement.filter)"),
    `filter=${filterAt}, range=${rangeAt}, ` +
    `all=${measureSection.includes("t('capturePanel.measureSourceAll')")}`);

  check('the filter select reports the picked source start and the All choice',
    measureSection.includes("measureFilter.addEventListener('change', " +
      '() => this.cb.onPickMeasurementFilter(') &&
    measureSection.includes("measureFilter.value === '' ? null : Number(measureFilter.value)") &&
    panel.includes('onPickMeasurementFilter(start: number | null): void;'),
    `wired=${measureSection.includes('this.cb.onPickMeasurementFilter(')}`);

  const disabled = 'measureFilter.disabled = v.measurement.sources.length === 0;';
  check('a session with no analog group disables the filter combobox instead of offering none',
    measureSection.includes(disabled) &&
    !measureSection.replace(disabled, '').includes('measureFilter.disabled'),
    `disabled=${measureSection.includes(disabled)}`);

  check('the range select offers the Viewport and between-cursors kinds',
    measureSection.includes("['viewport', t('capturePanel.measureRangeViewport')],") &&
    measureSection.includes("['cursors', t('capturePanel.measureRangeCursors')],") &&
    measureSection.includes('v.measurement.range.kind,') &&
    measureSection.includes("measureRange.addEventListener('change', " +
      '() => this.cb.onPickMeasurementRange(') &&
    measureSection.includes("measureRange.value === 'cursors' ? 'cursors' : 'viewport'") &&
    panel.includes('onPickMeasurementRange(kind: MeasurementRangeKind): void;'),
    `wired=${measureSection.includes('this.cb.onPickMeasurementRange(')}`);
}

{
  check('the cursor pair selects render only in cursor range mode',
    measureSection.includes("if (v.measurement.range.kind === 'cursors') {") &&
    measureSection.indexOf("if (v.measurement.range.kind === 'cursors') {") >
      measureSection.indexOf("'measure.range',") &&
    measureSection.includes("const measureCursors = div('measure-cursors');") &&
    measureSection.includes("selectControl('measure.cursor.a', t('capturePanel.measureCursorA'),") &&
    measureSection.includes("selectControl('measure.cursor.b', t('capturePanel.measureCursorB'),") &&
    measureSection.includes("['', t('capturePanel.measureCursorUnset')],") &&
    measureSection.includes('v.measurement.cursors.map(') &&
    measureSection.includes('v.measurement.range.a === null ? ' +
      "'' : String(v.measurement.range.a)") &&
    measureSection.includes('v.measurement.range.b === null ? ' +
      "'' : String(v.measurement.range.b)"),
    `branch=${measureSection.includes("range.kind === 'cursors'")}, ` +
    `a=${measureSection.includes("'measure.cursor.a'")}, ` +
    `b=${measureSection.includes("'measure.cursor.b'")}`);

  check('each cursor select picks its own side through the panel callback',
    measureSection.includes("this.cb.onPickMeasurementCursor('a',") &&
    measureSection.includes("first.value === '' ? null : Number(first.value)") &&
    measureSection.includes("this.cb.onPickMeasurementCursor('b',") &&
    measureSection.includes("second.value === '' ? null : Number(second.value)") &&
    panel.includes("onPickMeasurementCursor(side: 'a' | 'b', cursorId: number | null): void;"),
    `a=${measureSection.includes("onPickMeasurementCursor('a'")}, ` +
    `b=${measureSection.includes("onPickMeasurementCursor('b'")}`);

  check('the cursor mode hints when the two cursors do not exist yet',
    measureSection.includes('if (v.measurement.cursors.length < 2) {') &&
    measureSection.includes("hint.className = 'cursor-dist-hint';") &&
    measureSection.includes("hint.textContent = t('capturePanel.measureCursorHint');"),
    `guard=${measureSection.includes('v.measurement.cursors.length < 2')}, ` +
    `hint=${measureSection.includes("t('capturePanel.measureCursorHint')")}`);
}

{
  check('one rendered row per visible row, keyed by row id for the live update',
    measureSection.includes("const list = div('measure-list');") &&
    measureSection.includes('for (const row of v.measurement.rows) {') &&
    measureSection.includes("const item = div('measure-row');") &&
    measureSection.includes('item.dataset.measureId = String(row.id);') &&
    measureSection.includes("source.className = 'measure-source';") &&
    measureSection.includes('source.textContent = row.sourceName;') &&
    measureSection.includes("parameter.className = 'measure-param';") &&
    measureSection.includes("value.className = 'measure-value';") &&
    measureSection.includes("status.className = 'measure-status';") &&
    measureSection.includes('item.append(source, parameter, value, status, remove);'),
    `rows=${measureSection.includes('v.measurement.rows')}, ` +
    `dataset=${measureSection.includes('item.dataset.measureId = String(row.id);')}, ` +
    `order=${measureSection.includes('item.append(source, parameter, value, status, remove);')}`);

  check('the row text comes from the shared parameter, value and status composition',
    measureSection.includes('parameter.textContent = measurementParameterText(row.parameter);') &&
    measureSection.includes('value.textContent = measurementValueText(row);') &&
    measureSection.includes('status.textContent = measurementStatusText(row);') &&
    panel.includes('export function measurementValueText(row: MeasurementRowView): string {') &&
    panel.includes('export function measurementStatusText(row: MeasurementRowView): string {'),
    `parameter=${measureSection.includes('measurementParameterText(row.parameter)')}, ` +
    `value=${measureSection.includes('measurementValueText(row)')}, ` +
    `status=${measureSection.includes('measurementStatusText(row)')}`);

  check('each row removes exactly its own row id through the shared remove button',
    measureSection.includes('const remove = cursorRemoveButton(') &&
    measureSection.includes("t('capturePanel.measureRemove', { parameter: label })") &&
    measureSection.includes('const label = `${row.sourceName} ' +
      '${measurementParameterText(row.parameter)}`;') &&
    measureSection.includes('() => this.cb.onRemoveMeasurementRow(row.id),') &&
    measureSection.indexOf('cursorRemoveButton(') <
      measureSection.indexOf('this.cb.onRemoveMeasurementRow(row.id)') &&
    panel.includes('onRemoveMeasurementRow(id: number): void;'),
    `wired=${measureSection.includes('this.cb.onRemoveMeasurementRow(row.id)')}`);

  check('the row actions are real buttons, so every control is keyboard reachable',
    panel.includes("b.type = 'button';") &&
    measureSection.includes("add.type = 'button';") &&
    panel.includes('function cursorRemoveButton(label: string, onRemove: () => void): ' +
      'HTMLButtonElement {'),
    `remove=${panel.includes("b.type = 'button';")}, ` +
    `add=${measureSection.includes("add.type = 'button';")}`);

  check('an empty row list shows the add hint instead of a list',
    measureSection.includes('if (v.measurement.rows.length === 0) {') &&
    measureSection.includes("hint.textContent = t('capturePanel.measureEmpty');") &&
    measureSection.indexOf("t('capturePanel.measureEmpty')") <
      measureSection.indexOf("div('measure-list')"),
    `empty=${measureSection.includes("t('capturePanel.measureEmpty')")}`);
}

{
  check('the temporary add control is one parameter select plus one Add button on the target source',
    measureSection.includes('const addStart = v.measurement.addStart;') &&
    measureSection.includes('if (addStart !== null && ' +
      'v.measurement.availableParameters.length > 0) {') &&
    measureSection.includes("const addRow = div('measure-add-row');") &&
    measureSection.includes("'measure.add',") &&
    measureSection.includes("t('capturePanel.measureAdd'),") &&
    measureSection.includes('v.measurement.availableParameters.map(') &&
    measureSection.includes("add.textContent = t('capturePanel.measureAddRow');") &&
    measureSection.includes('const parameter = picker.value;') &&
    measureSection.includes('if (isMeasurementParameter(parameter)) ' +
      'this.cb.onAddMeasurementRow(addStart, parameter);') &&
    measureSection.includes('addRow.append(picker.el, add);') &&
    panel.includes('onAddMeasurementRow(start: number, parameter: MeasurementParameter): void;'),
    `guard=${measureSection.includes('addStart !== null')}, ` +
    `wired=${measureSection.includes('this.cb.onAddMeasurementRow(addStart, parameter)')}`);

  check('the section note is textual and carries its own data hook',
    measureSection.includes("const measureNote = div('measure-note');") &&
    measureSection.includes("measureNote.dataset.measureNote = '';") &&
    measureSection.includes('measureNote.textContent = measurementNoteText(v.measurement);') &&
    measureSection.includes("measureNote.hidden = measureNote.textContent === '';"),
    `note=${measureSection.includes("div('measure-note')")}, ` +
    `hook=${measureSection.includes("measureNote.dataset.measureNote = '';")}`);

  const windowLine = measureSection.indexOf("const measureWindow = div('measure-window');");
  check('the section states the window sample count between the controls and the rows',
    windowLine > measureSection.indexOf('measureSec.body.appendChild(measureCursors);') &&
    windowLine < measureSection.indexOf("const list = div('measure-list');") &&
    windowLine < measureSection.indexOf('if (v.measurement.rows.length === 0) {') &&
    measureSection.includes("measureWindow.dataset.measureWindow = '';") &&
    measureSection.includes('measureWindow.textContent = measurementWindowText(v.measurement);') &&
    measureSection.includes('measureWindow.hidden = v.measurement.window === null;') &&
    measureSection.includes('measureSec.body.appendChild(measureWindow);') &&
    panel.includes('export function measurementWindowText(view: MeasurementSectionView): string {'),
    `line=${windowLine}, ` +
    `hidden=${measureSection.includes('measureWindow.hidden = v.measurement.window === null;')}`);

  const markup = ['<table', '<thead', '<tbody', '<tr', '<th', '<td', 'innerHTML',
    "createElement('table')", "createElement('th')", "createElement('td')"]
    .filter((needle) => measureSection.includes(needle));
  check('the measurement section is div/span/button markup, never a table or string HTML',
    markup.length === 0, `hits=${JSON.stringify(markup)}`);
}

{
  const liveRow = (source: string): boolean => {
    const guard = 'if (row === undefined) continue;';
    return source.includes('for (const root of this.roots()) {') &&
      source.includes("root.querySelectorAll<HTMLElement>('.measure-row')") &&
      source.includes('const id = Number(item.dataset.measureId);') &&
      source.includes('const row = Number.isInteger(id) ? byId.get(id) : undefined;') &&
      source.includes('const byId = new Map<number, MeasurementRowView>();') &&
      source.includes(guard) &&
      source.includes("item.querySelector<HTMLElement>('.measure-value')") &&
      source.includes('value.textContent = measurementValueText(row);') &&
      source.includes("item.querySelector<HTMLElement>('.measure-status')") &&
      source.includes('status.textContent = measurementStatusText(row);') &&
      source.includes("root.querySelectorAll<HTMLElement>('[data-measure-note]')") &&
      source.includes('item.textContent = note;') &&
      source.includes('item.hidden = note === \'\';');
  };
  const structural = ['replaceChildren', 'appendChild', 'insertBefore', 'remove(',
    'innerHTML', 'classList', 'createElement', 'this.cb.']
    .filter((needle) => measureUpdater.includes(needle));
  check('the live update rewrites only existing row and note text, through both page roots',
    liveRow(measureUpdater) && structural.length === 0 &&
    !measureUpdater.includes('renderPanels(') &&
    !measureUpdater.includes('requestAnimationFrame') &&
    !measureUpdater.includes('setTimeout'),
    `update=${measureUpdater.length} chars, hits=${JSON.stringify(structural)}`);

  const droppedGuard = measureUpdater.replace('if (row === undefined) continue;', '');
  const rebuild = measureUpdater.replace('value.textContent = measurementValueText(row);',
    'value.replaceChildren();');
  check('the in-place update is load-bearing: a dropped id guard or a rebuild fails',
    !liveRow(droppedGuard) && !liveRow(rebuild) && liveRow(measureUpdater),
    `dropped=${liveRow(droppedGuard)}, rebuilt=${liveRow(rebuild)}`);

  const liveWindow = (source: string): boolean =>
    source.includes('const windowText = measurementWindowText(view);') &&
    source.includes("root.querySelectorAll<HTMLElement>('[data-measure-window]')") &&
    source.includes('item.textContent = windowText;') &&
    source.includes('item.hidden = view.window === null;');
  const hardCoded = measureUpdater.replace('item.textContent = windowText;',
    "item.textContent = 'Window: 0 samples';");
  const neverHidden = measureUpdater.replace('item.hidden = view.window === null;',
    'item.hidden = false;');
  check('the window line is refreshed text-only inside the same root loop',
    liveWindow(measureUpdater) && !liveWindow(hardCoded) && !liveWindow(neverHidden),
    `live=${liveWindow(measureUpdater)}, hardCoded=${liveWindow(hardCoded)}, ` +
    `neverHidden=${liveWindow(neverHidden)}`);
}

{
  const doc = installFakeDom();
  const capture = doc.createElement('div');
  const cursors = doc.createElement('div');
  doc.body.append(capture, cursors);
  const makeRow = (root: FakeElement, id: number, value: string): void => {
    const item = doc.createElement('div');
    item.className = 'measure-row';
    item.dataset.measureId = String(id);
    const name = doc.createElement('span');
    name.className = 'measure-param';
    name.textContent = 'label';
    const cell = doc.createElement('span');
    cell.className = 'measure-value';
    cell.textContent = value;
    const status = doc.createElement('span');
    status.className = 'measure-status';
    status.textContent = 'stale';
    item.append(name, cell, status);
    root.appendChild(item);
  };
  const makeNote = (root: FakeElement): void => {
    const note = doc.createElement('div');
    note.className = 'measure-note';
    note.dataset.measureNote = '';
    note.textContent = 'stale';
    note.hidden = false;
    root.appendChild(note);
  };
  const makeWindowLine = (root: FakeElement): void => {
    const line = doc.createElement('div');
    line.className = 'measure-window';
    line.dataset.measureWindow = '';
    line.textContent = 'stale';
    line.hidden = false;
    root.appendChild(line);
  };
  for (const root of [capture, cursors]) {
    makeRow(root, 1, 'old vpp');
    makeRow(root, 2, 'old rms');
    makeRow(root, 3, 'old hz');
    makeNote(root);
    makeWindowLine(root);
  }
  const cb = {} as CapturePanelCallbacks;
  const target = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    cursors: cursors as unknown as HTMLElement,
  }, cb);
  const vpp = rowView({
    id: 1, parameter: 'vpp', unit: 'v', value: 21.4588, crossingCount: 0,
    analyzedSamples: 32768, requestedSamples: 65536, truncated: true,
  });
  const rms = rowView({ id: 2, parameter: 'rms', unit: 'v', value: 4.09936 });
  target.updateMeasurements(sectionView({ rows: [vpp, rms] }));

  const cells = (root: FakeElement, id: number, cls: string): string =>
    root.querySelector(`.measure-row[data-measure-id="${id}"] .${cls}`)?.textContent ?? '';
  const labelOf = (root: FakeElement, id: number): string =>
    root.querySelector(`.measure-row[data-measure-id="${id}"] .measure-param`)
      ?.textContent ?? '';
  const noteOf = (root: FakeElement): FakeElement | null =>
    root.querySelector('[data-measure-note]');
  const windowOf = (root: FakeElement): FakeElement | null =>
    root.querySelector('[data-measure-window]');
  const written = [capture, cursors].map((root) => [
    cells(root, 1, 'measure-value'),
    cells(root, 1, 'measure-status'),
    cells(root, 2, 'measure-value'),
    cells(root, 2, 'measure-status'),
    cells(root, 3, 'measure-value'),
    cells(root, 3, 'measure-status'),
    labelOf(root, 1),
    noteOf(root)?.textContent ?? '',
    noteOf(root)?.hidden,
  ]);
  const rowsKept = [capture, cursors].every((root) =>
    root.querySelectorAll('.measure-row').length === 3);
  check('a live update writes value, status and note text in both roots and leaves unlisted rows alone',
    written.every((entry) => entry[0] === '21.5 V' && entry[2] === '4.1 V' &&
      entry[4] === 'old hz' && entry[5] === 'stale' && entry[6] === 'label') &&
    written.every((entry) => entry[1] === 'exact code extrema · ' +
      'partial: 32,768 of 65,536 samples') &&
    written.every((entry) => entry[7] ===
      'partial: 32,768 of 65,536 samples' && entry[8] === false) &&
    rowsKept,
    `written=${JSON.stringify(written)}, rows=${rowsKept}`);

  const wide = rowView({
    id: 1, parameter: 'vpp', unit: 'v', value: 21.4588,
    analyzedSamples: 65536, requestedSamples: 300000, truncated: true,
  });
  target.updateMeasurements(sectionView({
    rows: [wide, rms],
    window: { start: 0, end: 300000 },
  }));
  const windowLines = [capture, cursors].map((root) =>
    `${windowOf(root)?.textContent}/${windowOf(root)?.hidden}`);
  check('the window line names the requested window, and the truncated row its own prefix',
    windowLines.every((entry) => entry === 'Window: 300,000 samples/false') &&
    [capture, cursors].every((root) =>
      cells(root, 1, 'measure-status').includes('partial: 65,536 of 300,000 samples') &&
      !(windowOf(root)?.textContent ?? '').includes('65,536')),
    `lines=${JSON.stringify(windowLines)}, ` +
    `row=${cells(capture, 1, 'measure-status')}`);

  target.updateMeasurements(sectionView({ rows: [vpp, rms] }));
  const clearedWindow = [capture, cursors].map((root) =>
    `${windowOf(root)?.textContent}/${windowOf(root)?.hidden}`);
  check('a null window collapses the count line instead of leaving the last span up',
    clearedWindow.every((entry) => entry === '/true'),
    `lines=${JSON.stringify(clearedWindow)}`);

  const composer = slice(panel, 'export function measurementWindowText(',
    'export function measurementNoteText(');
  const honestComposer = (source: string): boolean =>
    source.includes("if (window === null) return '';") &&
    source.includes("t('capturePanel.measureWindowSamples', {") &&
    source.includes('samples: formatCount(window.end - window.start),');
  const zeroed = composer.replace('samples: formatCount(window.end - window.start),',
    "samples: '0',");
  const untranslated = composer.replace("t('capturePanel.measureWindowSamples', {",
    "'Window: ' + ({");
  check('the count is the resolved span and a translated key: a zeroed or literal composer fails',
    honestComposer(composer) && !honestComposer(zeroed) &&
    !honestComposer(untranslated) &&
    measurementWindowText(sectionView({ window: { start: 1024, end: 66560 } })) ===
      'Window: 65,536 samples' &&
    measurementWindowText(sectionView({ window: null })) === '',
    `zeroed=${honestComposer(zeroed)}, untranslated=${honestComposer(untranslated)}, ` +
    `text=${measurementWindowText(sectionView({ window: { start: 1024, end: 66560 } }))}`);

  target.updateMeasurements(sectionView({
    rows: [
      rowView({ id: 1, parameter: 'vpp', unit: 'v', status: 'no-data' }),
      rowView({ id: 2, parameter: 'rms', unit: 'v', status: 'no-data' }),
    ],
    unavailable: 'no-data',
  }));
  const hidden = [capture, cursors].map((root) => {
    const note = noteOf(root);
    return `${note?.textContent}/${note?.hidden}`;
  });
  check('an unavailable section labels every row and leaves the section note collapsed',
    [capture, cursors].every((root) =>
      cells(root, 1, 'measure-value') === '–' &&
      cells(root, 1, 'measure-status') === 'no samples in the window' &&
      cells(root, 2, 'measure-status') === 'no samples in the window') &&
    hidden.every((entry) => entry === '/true'),
    `note=${JSON.stringify(hidden)}`);

  target.updateMeasurements(sectionView({ rows: [{ ...rms, id: 2 }] }));
  const cleared = [capture, cursors].map((root) => {
    const note = noteOf(root);
    return `${note?.textContent}/${note?.hidden}`;
  });
  check('a clean section collapses the note instead of leaving the last status up',
    cleared.every((entry) => entry === '/true'),
    `note=${JSON.stringify(cleared)}`);
}

{
  const doc = installFakeDom();
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const makeRow = (id: number): void => {
    const item = doc.createElement('div');
    item.className = 'measure-row';
    item.dataset.measureId = String(id);
    const name = doc.createElement('span');
    name.className = 'measure-param';
    name.textContent = 'Vpp';
    const cell = doc.createElement('span');
    cell.className = 'measure-value';
    cell.textContent = 'stale';
    const status = doc.createElement('span');
    status.className = 'measure-status';
    status.textContent = 'stale';
    item.append(name, cell, status);
    root.appendChild(item);
  };
  makeRow(4);
  makeRow(5);
  makeRow(6);
  const target = new CapturePanel({
    capture: root as unknown as HTMLElement,
    cursors: doc.createElement('div') as unknown as HTMLElement,
  }, {} as CapturePanelCallbacks);
  target.updateMeasurements(sectionView({
    rows: [
      rowView({ id: 4, start: 0, sourceName: 'A0', parameter: 'vpp', unit: 'v', value: 1 }),
      rowView({ id: 5, start: 16, sourceName: 'A2', parameter: 'vpp', unit: 'v', value: 2 }),
    ],
  }));
  const cellOf = (id: number, cls: string): string =>
    root.querySelector(`.measure-row[data-measure-id="${id}"] .${cls}`)?.textContent ?? '';
  check('two rows of one parameter on different sources update by row id, not by parameter',
    cellOf(4, 'measure-value') === '1 V' && cellOf(5, 'measure-value') === '2 V' &&
      cellOf(6, 'measure-value') === 'stale',
    `a0=${cellOf(4, 'measure-value')}, a2=${cellOf(5, 'measure-value')}, ` +
      `unlisted=${cellOf(6, 'measure-value')}`);
}

{
  check('Frequency renders through the shared frequency formatter',
    measurementValueText(rowView({ value: 9999.59 })) === '10.00 kHz' &&
    measurementValueText(rowView({ value: 1234567.8 })) === '1.23 MHz',
    `slow=${measurementValueText(rowView({ value: 9999.59 }))}, ` +
    `fast=${measurementValueText(rowView({ value: 1234567.8 }))}`);

  const vpp = measurementValueText(rowView({ parameter: 'vpp', unit: 'v', value: 21.4588 }));
  const rms = measurementValueText(rowView({ parameter: 'rms', unit: 'v', value: 4.09936 }));
  check('amplitude rows render volts to three significant digits',
    vpp === '21.5 V' && rms === '4.1 V', `vpp=${vpp}, rms=${rms}`);

  const missing = measurementValueText(rowView({ status: 'no-source' }));
  check('a missing value is the dash, never NaN text',
    missing === '–' && !missing.includes('NaN'),
    `value=${JSON.stringify(missing)}`);
}

{
  const frequency = measurementStatusText(rowView({ crossingCount: 12 }));
  const vpp = measurementStatusText(rowView({ parameter: 'vpp', unit: 'v', value: 1 }));
  const rms = measurementStatusText(rowView({ parameter: 'rms', unit: 'v', value: 1 }));
  check('an ok row states its method: qualified period, extrema, DC-coupled RMS',
    frequency === 'mean period of 12 qualified crossings' &&
    vpp === 'exact code extrema' &&
    rms === 'DC-coupled RMS of exact samples',
    `frequency=${frequency}, vpp=${vpp}, rms=${rms}`);

  const statuses = (Object.keys(STATUS_TEXT) as MeasurementStatus[])
    .filter((status) => status !== 'ok')
    .map((status) => [status, measurementStatusText(rowView({ status }))] as const);
  const wrong = statuses.filter(([status, text]) => text !== STATUS_TEXT[status]);
  check('every non-ok state prints its own explicit status, never a number',
    wrong.length === 0 && statuses.length === 7 &&
    statuses.every(([, text]) => text !== '' && !text.includes('NaN')),
    `wrong=${JSON.stringify(wrong)}, statuses=${statuses.length}`);
}

{
  const full = rowView({
    parameter: 'frequency', value: 1000, analyzedSamples: 1000, requestedSamples: 2000,
    truncated: true, rangeClipped: true, gaps: true, clippedLow: true, clippedHigh: true,
    nearSampleLimit: true, crossingCap: true, crossingCount: 4096,
  });
  const shared = 'partial: 1,000 of 2,000 samples · ' +
    'window clipped to captured samples · missing samples in the window are ignored · ' +
    'signal reaches code 0 · signal reaches code 255';
  const text = measurementStatusText(full);
  const expected = 'mean period of 4,096 qualified crossings · ' + shared +
    ' · period near the sample limit · crossing scan stopped at 4,096';
  check('every qualification rides the frequency status in its fixed order, joined by the readout dot',
    text === expected, `text=${text}`);

  const vppFull = measurementStatusText({ ...full, parameter: 'vpp', unit: 'v', value: 3.3 });
  const rmsFull = measurementStatusText({ ...full, parameter: 'rms', unit: 'v', value: 3.3 });
  const leaked = [vppFull, rmsFull].filter((entry) => entry.includes('period near the sample limit') ||
    entry.includes('crossing scan stopped'));
  check('the frequency-only qualifications never reach the amplitude rows',
    vppFull === `exact code extrema · ${shared}` &&
    rmsFull === `DC-coupled RMS of exact samples · ${shared}` && leaked.length === 0,
    `vpp=${vppFull}, rms=${rmsFull}, leaked=${JSON.stringify(leaked)}`);

  const gate = "if (row.parameter === 'frequency' || row.parameter === 'period') {";
  const gated = (source: string): boolean => source.includes(gate) &&
    source.includes('const parts = measurementSharedFlagText(row);');
  check('the vertical rows keep shared-only flags because of the horizontal gate, not luck',
    gated(panel) && !gated(panel.replaceAll(gate, 'if (false) {')),
    `gate=${panel.includes(gate)}, dropped=${gated(panel.replaceAll(gate, 'if (false) {'))}`);

  const periodFull = measurementStatusText({ ...full, parameter: 'period', unit: 's', value: 1 });
  const dutyFull = measurementStatusText({
    ...full, parameter: 'duty', unit: '%', value: 42.5, dutyPeriods: 9, dutyExcludedPeriods: 2,
  });
  check('period discloses the same validity flags as frequency and duty its excluded periods',
    periodFull === `mean period of 4,096 qualified crossings · ${shared}` +
      ' · period near the sample limit · crossing scan stopped at 4,096' &&
      dutyFull === 'known samples above the level over 9 complete periods · ' + shared +
      ' · 2 complete periods excluded (gaps or clipping)',
    `period=${periodFull}, duty=${dutyFull}`);

  const dutyClean = measurementStatusText({
    ...rowView({ parameter: 'duty', unit: '%', value: 12.5, dutyPeriods: 3 }),
  });
  check('a duty row with no excluded period adds no disclosure',
    dutyClean === 'known samples above the level over 3 complete periods' &&
      !dutyClean.includes('excluded'),
    `duty=${dutyClean}`);

  const dutyNoPeriod = measurementStatusText({
    ...rowView({ parameter: 'duty', unit: '%', status: 'no-period', dutyExcludedPeriods: 2 }),
  });
  check('a duty row lacking a complete period names that, never "no samples in the window"',
    dutyNoPeriod === 'no complete qualified period · ' +
      '2 complete periods excluded (gaps or clipping)' &&
      dutyNoPeriod !== STATUS_TEXT['no-data'],
    `duty=${dutyNoPeriod}`);

  const onlyCap = measurementStatusText(rowView({ crossingCap: true, crossingCount: 4096 }));
  const noFlags = measurementStatusText(rowView({ crossingCount: 3 }));
  check('a flag appears only when its own predicate holds, without empty separators',
    onlyCap === 'mean period of 4,096 qualified crossings · crossing scan stopped at 4,096' &&
    noFlags === 'mean period of 3 qualified crossings' && !noFlags.includes(' · '),
    `cap=${onlyCap}, plain=${noFlags}`);

  const unavailableStates = (Object.keys(STATUS_TEXT) as MeasurementStatus[])
    .filter((status) => status !== 'ok')
    .map((status) => [status, measurementNoteText(sectionView({
      unavailable: status, rows: [rowView({ status }), rowView({ status })] }))] as const);
  const repeated = unavailableStates.filter(([, note]) => note !== '');
  check('an unavailable section adds no note line that repeats the row status verbatim',
    repeated.length === 0 && unavailableStates.length === 7,
    `repeated=${JSON.stringify(repeated)}`);

  const clipped = measurementNoteText(sectionView({ rows: [full, { ...full, parameter: 'vpp' }] }));
  const clean = measurementNoteText(sectionView({ rows: [rowView({ value: 1 })] }));
  const frequencyOnly = [full].filter((row) => measurementNoteText(sectionView({ rows: [row] }))
    .includes('crossing scan stopped'));
  check('the section note carries only the cross-row flags, deduplicated across rows',
    clipped === shared && clean === '' && frequencyOnly.length === 0,
    `clipped=${clipped}, clean=${JSON.stringify(clean)}`);
}

{
  const english: Record<string, string> = {
    'capturePanel.measure': 'Automatic measurements',
    'capturePanel.measureFormat': 'source · window · method',
    'capturePanel.measureSource': 'Source',
    'capturePanel.measureSourceAll': 'All sources',
    'capturePanel.measureRange': 'Range',
    'capturePanel.measureRangeViewport': 'Viewport',
    'capturePanel.measureRangeCursors': 'Between cursors',
    'capturePanel.measureCursorA': 'First cursor',
    'capturePanel.measureCursorB': 'Second cursor',
    'capturePanel.measureCursorUnset': 'not set',
    'capturePanel.measureCursorHint': 'Place two cursors on the waveform to measure between them.',
    'capturePanel.measureEmpty': 'Add a measurement row.',
    'capturePanel.measureAdd': 'Add measurement',
    'capturePanel.measureAddRow': 'Add',
    'capturePanel.measureRemove': 'Remove row: {parameter}',
    'capturePanel.measureFrequency': 'Frequency',
    'capturePanel.measureVpp': 'Vpp',
    'capturePanel.measureMax': 'Max',
    'capturePanel.measureMin': 'Min',
    'capturePanel.measureMean': 'Mean',
    'capturePanel.measureRms': 'RMS',
    'capturePanel.measurePeriod': 'Period',
    'capturePanel.measureDuty': 'Duty',
    'capturePanel.measureMethodFrequency': 'mean period of {count} qualified crossings',
    'capturePanel.measureMethodVpp': 'exact code extrema',
    'capturePanel.measureMethodMax': 'exact known-sample maximum',
    'capturePanel.measureMethodMin': 'exact known-sample minimum',
    'capturePanel.measureMethodMean': 'compensated mean of known samples',
    'capturePanel.measureMethodRms': 'DC-coupled RMS of exact samples',
    'capturePanel.measureMethodPeriod': 'mean period of {count} qualified crossings',
    'capturePanel.measureMethodDuty': 'known samples above the level over {periods} complete periods',
    'capturePanel.measureStatusNoSource': 'no analog group selected',
    'capturePanel.measureStatusNoWindow': 'no measurement window',
    'capturePanel.measureStatusNoData': 'no samples in the window',
    'capturePanel.measureStatusNoCrossing': 'no qualified crossing',
    'capturePanel.measureStatusOneCrossing': 'one qualified crossing; a period needs two',
    'capturePanel.measureStatusNoPeriod': 'no complete qualified period',
    'capturePanel.measureStatusPreviousWave': 'an older capture is on screen; ' +
      'waiting for the current one',
    'capturePanel.measurePartial': 'partial: {analyzed} of {requested} samples',
    'capturePanel.measureWindowSamples': 'Window: {samples} samples',
    'capturePanel.measureRangeClipped': 'window clipped to captured samples',
    'capturePanel.measureGaps': 'missing samples in the window are ignored',
    'capturePanel.measureClippedLow': 'signal reaches code 0',
    'capturePanel.measureClippedHigh': 'signal reaches code 255',
    'capturePanel.measureNearLimit': 'period near the sample limit',
    'capturePanel.measureCrossingCap': 'crossing scan stopped at {count}',
    'capturePanel.measureDutyExcluded': '{periods} complete periods excluded (gaps or clipping)',
    'capturePanel.measureValueNone': '–',
  };
  const keys = Object.keys(english);
  const catalogs: [string, Readonly<Record<string, string>>][] = [
    ['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr],
  ];
  const value = (dict: Readonly<Record<string, string>>, key: string): string => dict[key] ?? '';
  const missing = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => value(dict, key).trim() === '').map((key) => `${locale}:${key}`));
  check('all four catalogs define the forty-eight measurement keys',
    missing.length === 0 && keys.length === 48, `missing=${JSON.stringify(missing)}`);

  const mismatched = keys.filter((key) => value(en, key) !== english[key]);
  check('the English measurement copy matches the approved vocabulary',
    mismatched.length === 0,
    `mismatched=${JSON.stringify(mismatched.map((key) => [key, value(en, key)]))}`);

  const variables: Record<string, readonly string[]> = {
    'capturePanel.measureRemove': ['{parameter}'],
    'capturePanel.measureMethodFrequency': ['{count}'],
    'capturePanel.measureMethodPeriod': ['{count}'],
    'capturePanel.measureMethodDuty': ['{periods}'],
    'capturePanel.measureDutyExcluded': ['{periods}'],
    'capturePanel.measureCrossingCap': ['{count}'],
    'capturePanel.measurePartial': ['{analyzed}', '{requested}'],
    'capturePanel.measureWindowSamples': ['{samples}'],
  };
  const placeholderProblems = catalogs.flatMap(([locale, dict]) => {
    const problems: string[] = [];
    for (const key of keys) {
      const text = value(dict, key);
      const expected = variables[key] ?? [];
      for (const token of expected) {
        if (!text.includes(token)) problems.push(`${locale}:${key} missing ${token}`);
      }
      for (const token of text.match(/\{[a-zA-Z]+\}/g) ?? []) {
        if (!expected.includes(token)) problems.push(`${locale}:${key} extra ${token}`);
      }
    }
    return problems;
  });
  check('every locale keeps exactly the documented placeholders',
    placeholderProblems.length === 0,
    `problems=${JSON.stringify(placeholderProblems)}`);

  const localeNeutral = new Set(['capturePanel.measureSource', 'capturePanel.measureVpp',
    'capturePanel.measureValueNone']);
  const copied = catalogs.filter(([locale]) => locale !== 'en')
    .filter(([, dict]) => keys.some((key) => !localeNeutral.has(key) &&
      value(dict, key) === value(en, key)))
    .map(([locale]) => locale);
  check('no locale reuses English measurement prose; units and the dash stay neutral',
    copied.length === 0, `copied=${JSON.stringify(copied)}`);

  const scripts: [string, RegExp][] = [
    ['zh-CN', /\p{Script=Han}/u],
    ['ru', /\p{Script=Cyrillic}/u],
  ];
  const scriptMissing = scripts.filter(([locale, pattern]) => {
    const dict = catalogs.find(([name]) => name === locale)?.[1];
    return dict === undefined || !pattern.test(value(dict, 'capturePanel.measure'));
  }).map(([locale]) => locale);
  check('the section title is written in each locale script',
    scriptMissing.length === 0, `missing=${JSON.stringify(scriptMissing)}`);

  const windowKey = 'capturePanel.measureWindowSamples';
  const windowValues = catalogs.map(([locale, dict]) => [locale, value(dict, windowKey)] as const);
  const windowMissing = windowValues.filter(([, text]) =>
    text.trim() === '' || !text.includes('{samples}'));
  const windowCopied = windowValues.filter(([locale, text]) =>
    locale !== 'en' && text === value(en, windowKey));
  check('every locale names the window sample count in its own prose',
    windowValues.length === 4 && windowMissing.length === 0 && windowCopied.length === 0,
    `values=${JSON.stringify(windowValues)}, copied=${JSON.stringify(windowCopied)}`);
}

{
  check('the view struct carries the measurement section',
    appView.includes('measurement: this.measurementView(),') &&
    panel.includes('measurement: MeasurementSectionView;') &&
    panel.includes("} from './measurementState.js';"),
    `view=${appView.includes('measurement: this.measurementView(),')}, ` +
    `field=${panel.includes('measurement: MeasurementSectionView;')}`);

  const registrations = [
    'onPickMeasurementFilter: (start) => this.pickMeasurementFilter(start),',
    'onPickMeasurementRange: (kind) => this.pickMeasurementRange(kind),',
    'onPickMeasurementCursor: (side, cursorId) => ' +
      'this.pickMeasurementCursor(side, cursorId),',
    'onAddMeasurementRow: (start, parameter) => this.addMeasurementParameter(start, parameter),',
    'onRemoveMeasurementRow: (id) => this.removeMeasurementRowById(id),',
  ];
  const absent = registrations.filter((line) => !app.includes(line));
  const declared = [
    'onPickMeasurementFilter(start: number | null): void;',
    'onPickMeasurementRange(kind: MeasurementRangeKind): void;',
    "onPickMeasurementCursor(side: 'a' | 'b', cursorId: number | null): void;",
    'onAddMeasurementRow(start: number, parameter: MeasurementParameter): void;',
    'onRemoveMeasurementRow(id: number): void;',
  ].filter((line) => !panel.includes(line));
  check('the panel emits all five measurement callbacks and App registers each one',
    absent.length === 0 && declared.length === 0 &&
    panel.split('onPickMeasurementFilter').length - 1 >= 2,
    `absent=${JSON.stringify(absent)}, declared=${JSON.stringify(declared)}`);

  const restart = app.split('this.runningPanelAt = 0;').length - 1;
  check('App starts every capture with a fresh measurement panel clock',
    restart === 1 &&
    app.includes('this.runningPanelAt = 0;\n      this.analysisPanelAt = 0;') &&
    app.includes('private analysisPanelAt = 0;'),
    `resets=${restart}`);
}

{
  const analysisAt = frame.indexOf('if (now - this.analysisPanelAt > 500) {');
  const runningAt = frame.indexOf('now - this.runningPanelAt > 500');
  const block = analysisAt < 0 ? '' : frame.slice(analysisAt, runningAt);
  const independent = (source: string): boolean => {
    const at = source.indexOf('if (now - this.analysisPanelAt > 500) {');
    const end = source.indexOf('now - this.runningPanelAt > 500');
    const body = at < 0 || end < 0 ? '' : source.slice(at, end);
    return body.includes('this.analysisPanelAt = now;') &&
      body.includes('this.running && this.cursorsPageShown()') &&
      body.includes('this.capturePanel.updateMeasurements(this.measurementView());') &&
      !body.includes('this.runningPanelAt = now;') &&
      !body.includes('updateProgress') && !body.includes('updateTriggerStatus');
  };
  check('the measurement clock is its own 500 ms branch ahead of the capture panel clock',
    analysisAt >= 0 && runningAt > analysisAt && independent(frame) &&
    !block.includes('requestAnimationFrame') && !block.includes('setTimeout') &&
    !block.includes('setInterval') && !block.includes('renderPanels('),
    `analysis=${analysisAt}, running=${runningAt}, block=${block.length}`);

  const shared = frame.replace('this.analysisPanelAt = now;', 'this.runningPanelAt = now;');
  const reused = frame.replace('now - this.analysisPanelAt > 500',
    'now - this.runningPanelAt > 500');
  check('sharing the capture timestamp with the measurement branch fails that contract',
    !independent(shared) && !independent(reused),
    `shared=${independent(shared)}, reused=${independent(reused)}`);

  const forcedAt = frame.indexOf('if (forced && !this.running && this.cursorsPageShown()) {');
  const clearedAt = frame.indexOf('this.dirty = false;');
  const forcedRefresh = (source: string): boolean => {
    const at = source.indexOf('if (forced && !this.running && this.cursorsPageShown()) {');
    const cleared = source.indexOf('this.dirty = false;');
    return at >= 0 && cleared >= 0 && at > cleared &&
      source.slice(at, at + 200).includes(
        'this.capturePanel.updateMeasurements(this.measurementView());');
  };
  const gatedOff = frame.replace('if (forced && !this.running && this.cursorsPageShown()) {',
    'if (false) {');
  const movedFirst = frame.replace('this.dirty = false;',
    'if (forced && !this.running && this.cursorsPageShown()) {' +
    ' this.capturePanel.updateMeasurements(this.measurementView()); } this.dirty = false;');
  check('a stopped session refreshes measurements on the drawing gesture, not a clock',
    clearedAt >= 0 && forcedAt > clearedAt && forcedRefresh(frame) &&
    !forcedRefresh(gatedOff) && !forcedRefresh(movedFirst),
    `forced=${forcedAt}, cleared=${clearedAt}, gatedOff=${forcedRefresh(gatedOff)}, ` +
    `movedFirst=${forcedRefresh(movedFirst)}`);
}

{
  check('one App setter owns every measurement configuration change',
    applyConfig.includes('this.measurementConfig = reconcileMeasurementConfig(next, sources);') &&
    applyConfig.includes('this.renderPanels();') &&
    applyConfig.includes('this.dirty = true;') &&
    !applyConfig.includes('persistWorkspace') &&
    !removeParameter.includes('persistWorkspace') &&
    !removeParameter.includes('workspacePreferences'),
    `apply=${applyConfig.length} chars, ` +
    `persist=${applyConfig.includes('persistWorkspace')}`);

  check('the range reducer seeds the first two cursor ids only when the pair is unset',
    pickRange.includes("kind === 'viewport'") &&
    pickRange.includes("{ kind: 'viewport', a: null, b: null }") &&
    pickRange.includes('a: base.range.a ?? seeded[0] ?? null,') &&
    pickRange.includes('b: base.range.b ?? seeded[1] ?? null,') &&
    pickRange.includes('cursor.marker.sample') &&
    pickRange.includes('selectMeasurementRange(base, range)'),
    `range=${pickRange.length} chars`);

  check('the cursor side reducer only rewrites a pair in cursor mode',
    pickCursor.includes("if (base.range.kind !== 'cursors') return;") &&
    pickCursor.includes('side === \'a\'') &&
    pickCursor.includes('{ ...base.range, a: cursorId } : { ...base.range, b: cursorId }') &&
    pickCursor.includes('selectMeasurementRange(base, range)'),
    `cursor=${pickCursor.length} chars`);

  check('the row actions add and remove exactly one row of the targeted source id',
    addParameter.includes('addMeasurementRow(base.rows, start, parameter)') &&
    removeParameter.includes('removeMeasurementRow(base.rows, id)') &&
    addParameter.includes('this.withMeasurementRows(') &&
    removeParameter.includes('this.withMeasurementRows(') &&
    addParameter.includes('this.applyMeasurementConfig(') &&
    removeParameter.includes('this.applyMeasurementConfig(') &&
    applyConfig.includes('this.applyMeasurementConfig(') === false,
    `add=${addParameter.length}, remove=${removeParameter.length}`);
}

{
  const rules = ['.measure-controls {', '.measure-cursors {', '.measure-row {',
    '.measure-param {', '.measure-value {', '.measure-status {', '.measure-add-row {',
    '.analyzer-act.measure-add {', '.measure-note {', '.measure-window {'];
  const absent = rules.filter((rule) => !css.includes(rule));
  check('the sheet carries every measurement rule', absent.length === 0,
    `absent=${JSON.stringify(absent)}`);

  const windowRule = slice(css, '.measure-window {', '}');
  const noteRule = slice(css, '.measure-note {', '}');
  check('the window count line is secondary body text that wraps at the narrow rail',
    windowRule.includes('font-size: 10px;') && windowRule.includes('color: var(--text50);') &&
    windowRule.includes('line-height: 1.5;') &&
    windowRule.includes('overflow-wrap: anywhere;') && windowRule.includes('margin: 0;') &&
    windowRule === noteRule.replace('.measure-note', '.measure-window'),
    `rule=${windowRule}`);

  const row = slice(css, '.measure-row {', '}');
  const status = slice(css, '.measure-status {', '}');
  const value = slice(css, '.measure-value {', '}');
  check('rows wrap and their value/status columns never force horizontal overflow',
    row.includes('flex-wrap: wrap;') && row.includes('row-gap: 2px;') &&
    value.includes('min-width: 0;') && value.includes('overflow-wrap: anywhere;') &&
    status.includes('flex: 1 0 100%;') && status.includes('min-width: 0;') &&
    status.includes('overflow-wrap: anywhere;'),
    `wrap=${row.includes('flex-wrap: wrap;')}, ` +
    `valueMin=${value.includes('min-width: 0;')}, ` +
    `statusFull=${status.includes('flex: 1 0 100%;')}`);

  check('the status line is ordered after the remove control without moving it in the DOM',
    status.includes('order: 1;') &&
    measureSection.indexOf('item.append(source, parameter, value, status, remove);') > 0 &&
    measureSection.indexOf('status.className') <
      measureSection.indexOf('item.append(source, parameter, value, status, remove);'),
    `order=${status.includes('order: 1;')}`);

  check('the source column and the add-row select share the section layout tokens',
    slice(css, '.measure-source {', '}').includes('overflow-wrap: anywhere;') &&
    slice(css, '.measure-add-row > .field {', '}').includes('flex: 1 1 90px;'),
    `source=${css.includes('.measure-source {')}, ` +
    `field=${css.includes('.measure-add-row > .field {')}`);

  const block = slice(css, '.measure-controls {', '.cursor-edge-channel {');
  const colour = block.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/g) ?? [];
  check('the measurement rules reuse the sheet tokens and add no colour literal',
    block.length > 0 && colour.length === 0 && !block.includes('!important') &&
    block.includes('var(--text50)') && block.includes('var(--text80)'),
    `colours=${JSON.stringify(colour)}, block=${block.length} chars`);

  const addRule = slice(css, '.analyzer-act.measure-add {', '}');
  check('the add control overrides the icon box so its translated label fits',
    addRule.includes('width: auto;') && addRule.includes('padding: 0 6px;') &&
    addRule.includes('white-space: nowrap;') && !addRule.includes('!important'),
    `rule=${addRule.length} chars`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
