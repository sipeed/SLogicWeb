// SPDX-License-Identifier: GPL-3.0-or-later

import {
  measurementCaptureState, measurementNoteText, measurementStatusText, measurementValueText,
  measurementWindowText,
  CapturePanel, type CapturePanelCallbacks, type CapturePanelView,
} from '../capturePanel.js';
import { defaultCaptureSettings } from '../state.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';
import {
  isMeasurementBank, type MeasurementRowView, type MeasurementSectionView,
  type MeasurementStatus,
} from '../measurementState.js';
import {
  accumulateSample, emptyAccumulator, measurementStatsView, noMeasurementStatsView,
  type MeasurementStatsState, type MeasurementStatsView,
} from '../measurementStats.js';
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
const catalogSource = read('src/ui/measurementCatalogDialog.ts');
const app = read('src/ui/app.ts');
const css = read('src/ui/style.css');

const measureSection = slice(panel, 'const measureSec = section(',
  'return measureSec.el;');
const measureUpdater = slice(panel, 'updateMeasurements(view: MeasurementSectionView): void {',
  'updateCursors(rows: readonly CursorRowView[]): void {');
const appView = slice(app, 'private capturePanelView(): CapturePanelView {',
  'private primaryAction(): void {');
const measureView = slice(app, 'private measurementView(): MeasurementSectionView {',
  'private measurementBase(');
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
  'private toggleMeasurementParameter(');
const toggleParameter = slice(app, 'private toggleMeasurementParameter(',
  'private async clearMeasurementRows(');
const clearRows = slice(app, 'private async clearMeasurementRows(',
  'private undoMeasurementRows(');
const undoRows = slice(app, 'private undoMeasurementRows(',
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
    stats: noMeasurementStatsView(),
    ...over,
  };
}

function sectionView(over: Partial<MeasurementSectionView> = {}): MeasurementSectionView {
  return {
    sources: [],
    filter: null,
    range: { kind: 'viewport', a: null, b: null },
    tier: 'advanced',
    cursors: [],
    rows: [],
    allRows: [],
    rowCount: 0,
    undoCount: null,
    addStart: null,
    window: null,
    unavailable: null,
    capture: null,
    statsSkipped: 0,
    statsLoopUnavailable: false,
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
  'analyzing': 'analysing the current capture',
  'cancelled': 'capture analysis cancelled; analyze again to resume',
  'stable-capture-required': 'analysis needs a completed Single or Repeat capture',
  'loop': 'Loop captures cannot be analysed; stop a Single or Repeat capture first',
  'paused': 'paused while an analysis view (FFT or XY) is shown',
};

{
  check('the section is titled and legended from the measurement keys',
    measureSection.includes("const measureSec = section(t('capturePanel.measure'));") &&
    measureSection.includes("measureLegend.className = 'cursor-legend';") &&
    measureSection.includes("measureLegend.textContent = t('capturePanel.measureFormat');") &&
    measureSection.includes('measureSec.header.appendChild(measureLegend);'),
    `title=${measureSection.includes("section(t('capturePanel.measure'))")}, ` +
    `legend=${measureSection.includes("t('capturePanel.measureFormat')")}`);

  const cursorAppend = panel.indexOf('measurePage.appendChild(cursorSec.el)');
  const distanceAppend = panel.indexOf('measurePage.appendChild(distanceSec.el)');
  const edgeAppend = panel.indexOf('measurePage.appendChild(edgeSec.el)');
  const gateAppend = panel.indexOf('measurePage.appendChild(this.measurementSection(v))');
  check('the oscilloscope group is the last section on the measure page, after cursors, distance and edges',
    cursorAppend >= 0 && distanceAppend > cursorAppend && edgeAppend > distanceAppend &&
    gateAppend > edgeAppend &&
    panel.indexOf('const measureSec = section(') > gateAppend &&
    panel.includes('return measureSec.el;') &&
    !panel.includes('measurePage.appendChild(measureSec.el)') &&
    !panel.includes('capture.appendChild(measureSec.el)'),
    `cursor=${cursorAppend}, distance=${distanceAppend}, edge=${edgeAppend}, ` +
    `gate=${gateAppend}`);
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

  check('the range select offers the Viewport, between-cursors and whole-capture kinds',
    measureSection.includes("['viewport', t('capturePanel.measureRangeViewport')],") &&
    measureSection.includes("['cursors', t('capturePanel.measureRangeCursors')],") &&
    measureSection.includes("['capture', t('capturePanel.measureRangeCapture')],") &&
    measureSection.includes('v.measurement.range.kind,') &&
    measureSection.includes("measureRange.addEventListener('change', " +
      '() => this.cb.onPickMeasurementRange(') &&
    measureSection.includes('measurementRangeKind(measureRange.value)') &&
    !measureSection.includes("measureRange.value === 'cursors' ? 'cursors' : 'viewport'") &&
    panel.includes('onPickMeasurementRange(kind: MeasurementRangeKind): void;'),
    `wired=${measureSection.includes('this.cb.onPickMeasurementRange(')}, ` +
    `capture=${measureSection.includes("t('capturePanel.measureRangeCapture')")}`);
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
    measureSection.includes('v.measurement.rows.forEach((row, index) => {') &&
    measureSection.includes("const item = div('measure-row');") &&
    measureSection.includes('item.dataset.measureId = String(row.id);') &&
    measureSection.includes("source.className = 'measure-source';") &&
    measureSection.includes('source.textContent = row.sourceName;') &&
    measureSection.includes("parameter.className = 'measure-param';") &&
    measureSection.includes("value.className = 'measure-value';") &&
    measureSection.includes("status.className = 'measure-status';") &&
    measureSection.includes('item.append(source, toggle, status, remove, details);'),
    `rows=${measureSection.includes('v.measurement.rows')}, ` +
    `dataset=${measureSection.includes('item.dataset.measureId = String(row.id);')}, ` +
    `order=${measureSection.includes('item.append(source, toggle, status, remove, details);')}`);

  check('the row text comes from the shared parameter, value and status composition',
    measureSection.includes('parameter.textContent = measurementParameterText(row.parameter);') &&
    measureSection.includes('value.textContent = measurementValueText(row);') &&
    measureSection.includes('status.textContent = measurementStatusText(row);') &&
    measureSection.includes('toggle.append(parameter, measureChevron(), value);') &&
    panel.includes('function measureChevron(): SVGSVGElement {') &&
    panel.includes("appendIconPath(icon, 'm6 9 6 6 6-6');") &&
    panel.includes('export function measurementValueText(row: MeasurementRowView): string {') &&
    panel.includes('export function measurementStatusText(row: MeasurementRowView): string {'),
    `parameter=${measureSection.includes('measurementParameterText(row.parameter)')}, ` +
    `value=${measureSection.includes('measurementValueText(row)')}, ` +
    `status=${measureSection.includes('measurementStatusText(row)')}, ` +
    `chevron=${measureSection.includes('measureChevron()')}`);

  const removeFocus = "() => this.runMeasureAction('row', remove,\n" +
    '            () => this.cb.onRemoveMeasurementRow(row.id), row.id, index)';
  check('each row removes exactly its own row id through the shared remove button',
    measureSection.includes('const remove = cursorRemoveButton(') &&
    measureSection.includes("t('capturePanel.measureRemove', { parameter: label })") &&
    measureSection.includes('const label = measurementRowLabel(row);') &&
    measureSection.includes(removeFocus) &&
    measureSection.indexOf('cursorRemoveButton(') <
      measureSection.indexOf('this.cb.onRemoveMeasurementRow(row.id)') &&
    measureSection.indexOf("this.runMeasureAction('row', remove") <
      measureSection.indexOf('this.cb.onRemoveMeasurementRow(row.id)') &&
    panel.includes('onRemoveMeasurementRow(id: number): void;'),
    `wired=${measureSection.includes(removeFocus)}, ` +
      `armed=${measureSection.includes("this.runMeasureAction('row', remove")}`);

  const armFirst = 'const intent = this.armMeasureFocus(kind, from, id, row);\n' +
    '    try {\n      action();';
  const armAfterEmit = panel.replace(armFirst,
    'try {\n      action();\n    } finally {\n' +
    '      this.dropMeasureFocus(intent);\n    }\n' +
    '    const intent = this.armMeasureFocus(kind, from, id, row);');
  check('the action runs only after its hand-off is armed, and a no-rebuild action drops it',
    panel.includes(armFirst) && !armAfterEmit.includes(armFirst) &&
      panel.includes('    } finally {\n      this.dropMeasureFocus(intent);\n    }') &&
      panel.includes('if (this.measureFocus === intent) this.measureFocus = null;'),
    `armFirst=${panel.includes(armFirst)}, lateArm=${armAfterEmit.includes(armFirst)}, ` +
      `drop=${panel.includes('if (this.measureFocus === intent) this.measureFocus = null;')}`);

  check('the row actions are real buttons, so every control is keyboard reachable',
    panel.includes("b.type = 'button';") &&
    measureSection.includes("addOpen.type = 'button';") &&
    measureSection.includes("clearAll.type = 'button';") &&
    panel.includes('function cursorRemoveButton(label: string, onRemove: () => void): ' +
      'HTMLButtonElement {'),
    `remove=${panel.includes("b.type = 'button';")}, ` +
    `add=${measureSection.includes("addOpen.type = 'button';")}`);

  check('an empty row list shows the add hint instead of a list',
    measureSection.includes('if (v.measurement.rows.length === 0) {') &&
    measureSection.includes("hint.textContent = t('capturePanel.measureEmpty');") &&
    measureSection.indexOf("t('capturePanel.measureEmpty')") <
      measureSection.indexOf("div('measure-list')"),
    `empty=${measureSection.includes("t('capturePanel.measureEmpty')")}`);
}

{
  const clearClick = "clearAll.addEventListener('click', () => {\n" +
    "      const intent = this.armMeasureFocus('clear', clearAll);\n" +
    '      void this.cb.onClearMeasurementRows(clearAll)\n' +
    '        .finally(() => this.dropMeasureFocus(intent));';
  const undoClick = "undo.addEventListener('click', () => {\n" +
    "        this.runMeasureAction('undo', undo, () => this.cb.onUndoMeasurementRows());\n" +
    '      });';
  const footer = (source: string): boolean =>
    source.includes("const measureActions = div('measure-actions');") &&
    source.includes("addOpen.dataset.measureOpen = '';") &&
    source.includes("addOpen.setAttribute('aria-haspopup', 'dialog');") &&
    source.includes("addOpen.textContent = t('capturePanel.measureAddOpen');") &&
    source.includes('addOpen.disabled = v.measurement.sources.length === 0;') &&
    source.includes('this.catalogDialog.open(\n' +
      '      measurementCatalogView(v.measurement), addOpen)') &&
    source.includes("clearAll.dataset.measureClearAll = '';") &&
    source.includes("clearAll.textContent = t('capturePanel.measureClearAll');") &&
    source.includes('clearAll.disabled = v.measurement.rowCount === 0;') &&
    source.includes(clearClick) &&
    source.includes('measureActions.append(addOpen, clearAll);');
  const noEnable = footer(measureSection.replace(
    'addOpen.disabled = v.measurement.sources.length === 0;', 'addOpen.disabled = false;'));
  const visibleOnly = footer(measureSection.replace(
    'clearAll.disabled = v.measurement.rowCount === 0;',
    'clearAll.disabled = v.measurement.rows.length === 0;'));
  check('the footer row carries the catalog opener and Clear all, and no temporary add select',
    footer(measureSection) && !noEnable && !visibleOnly &&
    !measureSection.includes('measure-add-row') &&
    !measureSection.includes("'measure.add'") &&
    !measureSection.includes('onAddMeasurementRow') &&
    panel.includes('onToggleMeasurementRow(start: number, parameter: MeasurementParameter): void;') &&
    panel.includes('onClearMeasurementRows(invoker: HTMLElement | null): Promise<void>;') &&
    panel.includes('onUndoMeasurementRows(): void;'),
    `footer=${footer(measureSection)}, noEnable=${noEnable}, visibleOnly=${visibleOnly}, ` +
      `temp=${measureSection.includes('onAddMeasurementRow')}`);

  const noticeAt = measureSection.indexOf("const undoNotice = div('measure-undo');");
  const notice = (source: string): boolean =>
    source.includes('if (v.measurement.undoCount !== null) {') &&
    source.includes("undoNotice.dataset.measureUndoNotice = '';") &&
    source.includes("undoNotice.setAttribute('role', 'status');") &&
    source.includes("undoText.className = 'measure-undo-text';") &&
    source.includes('undoText.textContent = measurementClearedText(v.measurement);') &&
    source.includes("undo.className = 'analyzer-act measure-undo-action';") &&
    source.includes("undo.dataset.measureUndo = '';") &&
    source.includes("undo.textContent = t('capturePanel.measureUndo');") &&
    source.includes(undoClick) &&
    source.includes('undoNotice.append(undoText, undo);');
  const alwaysShown = notice(measureSection.replace(
    'if (v.measurement.undoCount !== null) {', 'if (true) {'));
  check('each management callback has exactly one owning control',
    panel.split('this.cb.onToggleMeasurementRow(').length - 1 === 1 &&
      panel.split('this.cb.onRemoveMeasurementRow(').length - 1 === 1 &&
      panel.split('this.cb.onClearMeasurementRows(').length - 1 === 1 &&
      panel.split('this.cb.onUndoMeasurementRows(').length - 1 === 1 &&
      panel.includes('onToggle: (start, parameter) => ' +
        'this.cb.onToggleMeasurementRow(start, parameter),') &&
      panel.includes('onPickSource: (start) => this.cb.onPickMeasurementFilter(start),') &&
      measureSection.includes(clearClick) &&
      measureSection.includes(undoClick),
    `toggle=${panel.split('this.cb.onToggleMeasurementRow(').length - 1}, ` +
      `clear=${panel.split('this.cb.onClearMeasurementRows(').length - 1}, ` +
      `undo=${panel.split('this.cb.onUndoMeasurementRows(').length - 1}`);

  check('the undo notice is a live status line with its own count and one Undo button',
    notice(measureSection) && !alwaysShown &&
    noticeAt > measureSection.indexOf('measureActions.append(addOpen, clearAll);') &&
    noticeAt < measureSection.indexOf("const measureNote = div('measure-note');") &&
    panel.includes('export function measurementClearedText(view: MeasurementSectionView): string {'),
    `noticeAt=${noticeAt}, alwaysShown=${alwaysShown}`);

  const guardLine = 'if (this.catalogDialog.isOpen) ' +
    'this.catalogDialog.update(measurementCatalogView(v.measurement));';
  const owned = (source: string): boolean =>
    source.split('new MeasurementCatalogDialog(').length - 1 === 1 &&
    source.indexOf('new MeasurementCatalogDialog(') <
      source.indexOf('render(v: CapturePanelView): void {') &&
    source.split(guardLine).length - 1 === 1 &&
    source.includes('this.catalogDialog.close();') &&
    source.includes('private readonly catalogDialog: MeasurementCatalogDialog;');
  const missingUpdate = panel.replace(guardLine, '');
  const unguarded = panel.replace('if (this.catalogDialog.isOpen) ' +
    'this.catalogDialog.update(measurementCatalogView(v.measurement));',
  'this.catalogDialog.update(measurementCatalogView(v.measurement));');
  const secondInstance = panel.replace('render(v: CapturePanelView): void {',
    'render(v: CapturePanelView): void {\n' +
    '    new MeasurementCatalogDialog({ onToggle: () => {}, onPickSource: () => {} });');
  const modal = (source: string): boolean =>
    source.includes("this.dialog = document.createElement('dialog');") &&
    source.includes('this.dialog.showModal();') &&
    !source.includes('.show();') && !source.includes('.open = true') &&
    source.includes('this.dialog.close();') &&
    source.includes("document.body.appendChild(this.dialog);");
  check('the catalog is a native modal, so the browser owns the focus trap the plot cannot reach',
    modal(catalogSource) &&
      !modal(catalogSource.replace('this.dialog.showModal();', 'this.dialog.open = true;')) &&
      !modal(catalogSource.replace('this.dialog.showModal();', 'this.dialog.show();')),
    `modal=${modal(catalogSource)}, ` +
      `openFlag=${modal(catalogSource.replace('this.dialog.showModal();', 'this.dialog.open = true;'))}`);

  check('one catalog instance owned by the panel survives every rebuild and is re-pointed after it',
    owned(panel) && !owned(missingUpdate) && !owned(unguarded) && !owned(secondInstance) &&
      measureUpdater.includes('this.catalogDialog.update(measurementCatalogView(view));') &&
      panel.includes('dispose(): void {\n    this.catalogDialog.close();'),
    `owned=${owned(panel)}, missingUpdate=${owned(missingUpdate)}, ` +
      `unguarded=${owned(unguarded)}, second=${owned(secondInstance)}, ` +
      `updater=${measureUpdater.includes('this.catalogDialog.update(')}`);

  const quiet = (source: string): boolean =>
    (source.match(/setAttribute\('role'/g) ?? []).length === 3 &&
    source.split("undoNotice.setAttribute('role', 'status');").length - 1 === 1 &&
    source.split("progress.setAttribute('role', 'progressbar');").length - 1 === 1 &&
    source.split("viewSwitch.setAttribute('role', 'group');").length - 1 === 1 &&
    !source.includes('aria-live') && (source.match(/role="/g) ?? []).length === 0;
  const rowLive = measureSection.replace(
    'item.append(source, toggle, status, remove, details);',
    "item.setAttribute('role', 'status');\n        " +
      'item.append(source, toggle, status, remove, details);');
  const valueLive = measureSection.replace(
    'value.textContent = measurementValueText(row);',
    "value.setAttribute('role', 'status');\n        " +
      'value.textContent = measurementValueText(row);');
  const progressLive = measureSection.replace(
    "progress.setAttribute('role', 'progressbar');",
    "progress.setAttribute('role', 'status');");
  check('the undo notice is the only status role, the progress bar is a progressbar, and no row is live',
    quiet(measureSection) && !quiet(rowLive) && !quiet(valueLive) && !quiet(progressLive),
    `quiet=${quiet(measureSection)}, rowLive=${quiet(rowLive)}, ` +
      `valueLive=${quiet(valueLive)}, progressLive=${quiet(progressLive)}, ` +
      `roles=${(measureSection.match(/setAttribute\('role'/g) ?? []).length}`);

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
  const makeUndoNotice = (root: FakeElement): void => {
    const notice = doc.createElement('div');
    notice.className = 'measure-undo';
    notice.dataset.measureUndoNotice = '';
    notice.setAttribute('role', 'status');
    notice.hidden = true;
    const text = doc.createElement('span');
    text.className = 'measure-undo-text';
    text.textContent = '';
    const undo = doc.createElement('button');
    undo.type = 'button';
    undo.dataset.measureUndo = '';
    undo.textContent = 'Undo';
    notice.append(text, undo);
    root.appendChild(notice);
  };
  for (const root of [capture, cursors]) {
    makeRow(root, 1, 'old vpp');
    makeRow(root, 2, 'old rms');
    makeRow(root, 3, 'old hz');
    makeNote(root);
    makeWindowLine(root);
    makeUndoNotice(root);
  }
  const cb = {} as CapturePanelCallbacks;
  const target = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    measure: cursors as unknown as HTMLElement,
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

  const undoOf = (root: FakeElement): FakeElement | null =>
    root.querySelector('[data-measure-undo-notice]');
  const undoTextOf = (root: FakeElement): string =>
    root.querySelector('.measure-undo-text')?.textContent ?? '';
  target.updateMeasurements(sectionView({ rows: [vpp, rms], undoCount: 3, rowCount: 3 }));
  const undoShown = [capture, cursors].map((root) =>
    `${undoTextOf(root)}/${undoOf(root)?.hidden}/${undoOf(root)?.children.length}`);
  check('a clear notice is refreshed in place with its count and keeps exactly its text and Undo',
    undoShown.every((entry) => entry === 'Cleared 3 measurements/false/2') &&
      [capture, cursors].every((root) =>
        root.querySelector('[data-measure-undo]')?.textContent === 'Undo' &&
        undoOf(root)?.getAttribute('role') === 'status'),
    `notice=${JSON.stringify(undoShown)}`);
  target.updateMeasurements(sectionView({ rows: [vpp, rms] }));
  const undoHidden = [capture, cursors].map((root) =>
    `${undoTextOf(root)}/${undoOf(root)?.hidden}`);
  check('a cleared snapshot hides the notice instead of leaving the last count up',
    undoHidden.every((entry) => entry === '/true'), `notice=${JSON.stringify(undoHidden)}`);

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
    source.includes('const samples = formatCount(window.end - window.start);') &&
    source.includes("t('capturePanel.measureWindowSamples', { samples })") &&
    (source.match(/formatCount\(window\.end - window\.start\)/g) ?? []).length === 1;
  const zeroed = composer.replace('const samples = formatCount(window.end - window.start);',
    "const samples = '0';");
  const untranslated = composer.replace("t('capturePanel.measureWindowSamples', { samples })",
    "'Window: ' + samples");
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
    measure: doc.createElement('div') as unknown as HTMLElement,
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
    wrong.length === 0 && statuses.length === 12 &&
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
    repeated.length === 0 && unavailableStates.length === 12,
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
    'capturePanel.measureRangeCapture': 'Whole capture',
    'capturePanel.measureCursorA': 'First cursor',
    'capturePanel.measureCursorB': 'Second cursor',
    'capturePanel.measureCursorUnset': 'not set',
    'capturePanel.measureCursorHint': 'Place two cursors on the waveform to measure between them.',
    'capturePanel.measureEmpty': 'Add a measurement row.',
    'capturePanel.measureAddOpen': 'Add measurement…',
    'capturePanel.measureClearAll': 'Clear all',
    'capturePanel.measureRemove': 'Remove row: {parameter}',
    'capturePanel.measureClearTitle': 'Clear all measurements?',
    'capturePanel.measureClearBody': 'This removes every measurement row. ' +
      'Undo restores them in their original order.',
    'capturePanel.measureClearConfirm': 'Clear all',
    'capturePanel.measureClearCancel': 'Cancel',
    'capturePanel.measureCleared': 'Cleared {count} measurements',
    'capturePanel.measureUndo': 'Undo',
    'capturePanel.measureCatalogTitle': 'Add measurements',
    'capturePanel.measureCatalogSource': 'Source',
    'capturePanel.measureCatalogVertical': 'Vertical',
    'capturePanel.measureCatalogHorizontal': 'Horizontal',
    'capturePanel.measureCatalogDone': 'Done',
    'capturePanel.measureCatalogMethodFrequency': 'mean period of qualified crossings',
    'capturePanel.measureCatalogMethodPeriod': 'mean qualified-crossing interval, in seconds',
    'capturePanel.measureCatalogMethodDuty':
      'known samples at or above the level over complete qualified periods',
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
    'capturePanel.measureStatusAnalyzing': 'analysing the current capture',
    'capturePanel.measureStatusCancelled': 'capture analysis cancelled; ' +
      'analyze again to resume',
    'capturePanel.measureStatusStableCapture': 'analysis needs a completed Single or Repeat capture',
    'capturePanel.measureStatusLoop': 'Loop captures cannot be analysed; ' +
      'stop a Single or Repeat capture first',
    'capturePanel.measurePartial': 'partial: {analyzed} of {requested} samples',
    'capturePanel.measureWindowSamples': 'Window: {samples} samples',
    'capturePanel.measureWindowRetained': 'Window: {samples} samples (captured {from} – {to})',
    'capturePanel.measureCaptureLabel': 'Capture range analysis',
    'capturePanel.measureCaptureProgress': 'Analyzing capture: {done} / {total} samples ({percent}%)',
    'capturePanel.measureCaptureCancel': 'Cancel',
    'capturePanel.measureCaptureRestart': 'Analyze again',
    'capturePanel.measureCaptureCancelled': 'Analysis cancelled',
    'capturePanel.measureRangeClipped': 'window clipped to captured samples',
    'capturePanel.measureGaps': 'missing samples in the window are ignored',
    'capturePanel.measureClippedLow': 'signal reaches code 0',
    'capturePanel.measureClippedHigh': 'signal reaches code 255',
    'capturePanel.measureNearLimit': 'period near the sample limit',
    'capturePanel.measureCrossingCap': 'crossing scan stopped at {count}',
    'capturePanel.measureDutyExcluded': '{periods} complete periods excluded (gaps or clipping)',
    'capturePanel.measureDetailsShow': 'Show statistics details: {parameter}',
    'capturePanel.measureDetailsHide': 'Hide statistics details: {parameter}',
    'capturePanel.measureDetailsCurrent': 'Current',
    'capturePanel.measureDetailsMean': 'Mean',
    'capturePanel.measureDetailsMin': 'Min',
    'capturePanel.measureDetailsMax': 'Max',
    'capturePanel.measureDetailsStdDev': 'StdDev',
    'capturePanel.measureDetailsCount': 'Count',
    'capturePanel.measureDetailsExcluded': 'Excluded',
    'capturePanel.measureDetailsSkipped': 'Skipped visibility intervals: {count}',
    'capturePanel.measureStatsCapped': 'capped at {count}',
    'capturePanel.measureStatsReset': 'Reset statistics',
    'capturePanel.measureStatsResetAll': 'Reset all statistics',
    'capturePanel.measureStatsLoop': 'cross-acquisition statistics are unavailable in Loop captures',
    'capturePanel.measureStatsNote': 'Statistics are cross-acquisition and kept for this session only.',
    'capturePanel.measureValueNone': '–',
  };
  const keys = Object.keys(english);
  const catalogs: [string, Readonly<Record<string, string>>][] = [
    ['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr],
  ];
  const value = (dict: Readonly<Record<string, string>>, key: string): string => dict[key] ?? '';
  const missing = catalogs.flatMap(([locale, dict]) =>
    keys.filter((key) => value(dict, key).trim() === '').map((key) => `${locale}:${key}`));
  check('all four catalogs define the eighty-eight measurement keys',
    missing.length === 0 && keys.length === 88, `missing=${JSON.stringify(missing)}`);

  const mismatched = keys.filter((key) => value(en, key) !== english[key]);
  check('the English measurement copy matches the approved vocabulary',
    mismatched.length === 0,
    `mismatched=${JSON.stringify(mismatched.map((key) => [key, value(en, key)]))}`);

  const variables: Record<string, readonly string[]> = {
    'capturePanel.measureDetailsShow': ['{parameter}'],
    'capturePanel.measureDetailsHide': ['{parameter}'],
    'capturePanel.measureDetailsSkipped': ['{count}'],
    'capturePanel.measureStatsCapped': ['{count}'],
    'capturePanel.measureRemove': ['{parameter}'],
    'capturePanel.measureCleared': ['{count}'],
    'capturePanel.measureMethodFrequency': ['{count}'],
    'capturePanel.measureMethodPeriod': ['{count}'],
    'capturePanel.measureMethodDuty': ['{periods}'],
    'capturePanel.measureDutyExcluded': ['{periods}'],
    'capturePanel.measureCrossingCap': ['{count}'],
    'capturePanel.measurePartial': ['{analyzed}', '{requested}'],
    'capturePanel.measureWindowSamples': ['{samples}'],
    'capturePanel.measureWindowRetained': ['{samples}', '{from}', '{to}'],
    'capturePanel.measureCaptureProgress': ['{done}', '{total}', '{percent}'],
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
    'capturePanel.measureValueNone', 'capturePanel.measureCatalogSource']);
  const copied = catalogs.filter(([locale]) => locale !== 'en')
    .filter(([, dict]) => keys.some((key) => !localeNeutral.has(key) &&
      value(dict, key) === value(en, key)))
    .map(([locale]) => locale);
  check('no locale reuses English measurement prose; units and the dash stay neutral',
    copied.length === 0, `copied=${JSON.stringify(copied)}`);

  const counted = ['capturePanel.measureMethodFrequency', 'capturePanel.measureMethodPeriod',
    'capturePanel.measureMethodDuty'] as const;
  const describe = ['capturePanel.measureCatalogMethodFrequency',
    'capturePanel.measureCatalogMethodPeriod',
    'capturePanel.measureCatalogMethodDuty'] as const;
  const describeHits = catalogs.flatMap(([locale, dict]) => describe
    .filter((key) => /\{\w+\}/.test(value(dict, key)) ||
      /\b0\b/.test(value(dict, key)))
    .map((key) => `${locale}:${key}`));
  check('the catalog copy is count-free in every locale while the row status keeps its count',
    describeHits.length === 0 &&
      counted.every((key) => /\{\w+\}/.test(value(en, key))) &&
      describe.every((key) => !value(en, key).includes('0 ')),
    `hits=${JSON.stringify(describeHits)}, counted=${JSON.stringify(
      counted.map((key) => value(en, key)))}`);

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
    'onToggleMeasurementRow: (start, parameter) =>\n' +
      '          this.toggleMeasurementParameter(start, parameter),',
    'onRemoveMeasurementRow: (id) => this.removeMeasurementRowById(id),',
    'onClearMeasurementRows: (invoker) => this.clearMeasurementRows(invoker),',
    'onUndoMeasurementRows: () => this.undoMeasurementRows(),',
  ];
  const absent = registrations.filter((line) => !app.includes(line));
  const declared = [
    'onPickMeasurementFilter(start: number | null): void;',
    'onPickMeasurementRange(kind: MeasurementRangeKind): void;',
    "onPickMeasurementCursor(side: 'a' | 'b', cursorId: number | null): void;",
    'onToggleMeasurementRow(start: number, parameter: MeasurementParameter): void;',
    'onRemoveMeasurementRow(id: number): void;',
    'onClearMeasurementRows(invoker: HTMLElement | null): Promise<void>;',
    'onUndoMeasurementRows(): void;',
  ].filter((line) => !panel.includes(line));
  check('the panel emits all seven measurement callbacks and App registers each one',
    absent.length === 0 && declared.length === 0 && registrations.length === 7 &&
    panel.split('onPickMeasurementFilter').length - 1 >= 2 &&
    !panel.includes('onAddMeasurementRow') && !app.includes('onAddMeasurementRow'),
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
      body.includes('this.running && this.measurePageShown() && this.analogScopeActive()') &&
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

  const forcedAt = frame.indexOf(
    'if (forced && !this.running && this.measurePageShown() && this.analogScopeActive()) {');
  const clearedAt = frame.indexOf('this.dirty = false;');
  const forcedRefresh = (source: string): boolean => {
    const at = source.indexOf(
      'if (forced && !this.running && this.measurePageShown() && this.analogScopeActive()) {');
    const cleared = source.indexOf('this.dirty = false;');
    return at >= 0 && cleared >= 0 && at > cleared &&
      source.slice(at, at + 200).includes(
        'this.capturePanel.updateMeasurements(this.measurementView());');
  };
  const gatedOff = frame.replace(
    'if (forced && !this.running && this.measurePageShown() && this.analogScopeActive()) {',
    'if (false) {');
  const movedFirst = frame.replace('this.dirty = false;',
    'if (forced && !this.running && this.measurePageShown() && this.analogScopeActive()) {' +
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

  check('the row actions toggle, remove, clear and undo through the same reducers and setter',
    toggleParameter.includes('toggleMeasurementRow(base.rows, start, parameter)') &&
    removeParameter.includes('removeMeasurementRow(base.rows, id)') &&
    clearRows.includes('clearMeasurementRows(base.rows)') &&
    undoRows.includes('undoClearMeasurementRows(base.rows)') &&
    undoRows.includes('if (rows === base.rows) return;') &&
    [toggleParameter, removeParameter, clearRows, undoRows]
      .every((body) => body.includes('this.withMeasurementRows(') &&
        body.includes('this.applyMeasurementConfig(') &&
        !body.includes('persistWorkspace')) &&
    applyConfig.includes('this.applyMeasurementConfig(') === false,
    `toggle=${toggleParameter.length}, remove=${removeParameter.length}, ` +
      `clear=${clearRows.length}, undo=${undoRows.length}`);

  const untouched = ['selectMeasurementRange', 'selectMeasurementFilter', 'this.cursors',
    'range', 'captureStore.replace', 'settings.', 'repeatTimer', 'startCapture'];
  const leaked = [toggleParameter, removeParameter, clearRows, undoRows]
    .flatMap((body) => untouched.filter((needle) => body.includes(needle)));
  const spreads = [toggleParameter, removeParameter, clearRows, undoRows]
    .filter((body) => body.includes('this.measurementBase(sources)')).length;
  check('no row action touches the range, the filter, the cursors or the acquisition',
    leaked.length === 0 && spreads === 4 &&
      app.includes('return rows === config.rows ? config : { ...config, rows };'),
    `leaked=${JSON.stringify(leaked)}, spreads=${spreads}`);

  const ask = clearRows.slice(0, clearRows.indexOf('if (!confirmed) return;'));
  const guarded = (body: string): boolean => {
    const guardAt = body.indexOf('if (!confirmed) return;');
    return guardAt >= 0 &&
      guardAt < body.indexOf('clearMeasurementRows(base.rows)') &&
      guardAt < body.indexOf('this.applyMeasurementConfig(') &&
      guardAt < body.indexOf('this.withMeasurementRows(');
  };
  const noGuard = clearRows.replace('if (!confirmed) return;', '');
  const guardAfter = clearRows.replace('if (!confirmed) return;\n', '')
    + '\n    if (!confirmed) return;';
  check('Clear all confirms first through the shared dialog and changes nothing on Escape or Cancel',
    ask.includes('await this.confirmDialog.ask({') &&
      ask.includes("title: t('capturePanel.measureClearTitle'),") &&
      ask.includes("body: t('capturePanel.measureClearBody'),") &&
      ask.includes("confirm: t('capturePanel.measureClearConfirm'),") &&
      ask.includes("cancel: t('capturePanel.measureClearCancel'),") &&
      ask.includes('}, invoker);') &&
      guarded(clearRows) && !guarded(noGuard) && !guarded(guardAfter) &&
      clearRows.indexOf('await this.confirmDialog.ask({') <
        clearRows.indexOf('if (!confirmed) return;') &&
      !clearRows.includes('requestAnimationFrame') && !clearRows.includes('setTimeout') &&
      app.split('clearMeasurementRows(base.rows)').length - 1 === 1,
    `askAt=${ask.length}, guard=${clearRows.indexOf('if (!confirmed) return;')}, ` +
      `noGuard=${guarded(noGuard)}, lateGuard=${guarded(guardAfter)}`);

  const payload = (body: string): boolean =>
    body.includes('...measurementSectionCounts(state),') &&
    body.includes('const rows = visibleMeasurementRows(state);') &&
    !body.includes('rowCount: rows.length');
  check('the view exposes the whole row count and the undo snapshot size, not the filtered count',
    payload(measureView) && measureView.includes('allRows: state.rows,') &&
      !measureView.includes('availableParameters') &&
      !app.includes('measurementRowViews(state.rows'),
    `counts=${payload(measureView)}, ` +
      `allRows=${measureView.split('allRows: state.rows,').length - 1}, ` +
      `scanIntoCatalog=${app.includes('measurementRowViews(state.rows')}`);

  check('only the visible rows are scanned, and the catalog receives row identity alone',
    measureView.includes('const results = new Map<number, MeasurementSourceResult>();') &&
      measureView.includes('for (const source of this.measurementRowsFor(sources, rows)) {') &&
      measureView.includes('rows: measurementRowViews(rows, results, null, stats),') &&
      measureView.split('runMeasurement({').length - 1 === 1 &&
      !measureView.includes('measurementRowViews(state.rows') &&
      app.includes('const wanted = new Set(rows.map((row) => row.start));'),
    `scans=${measureView.split('runMeasurement({').length - 1}, ` +
      `visibleOnly=${measureView.includes('this.measurementRowsFor(sources, rows)')}`);
}

{
  const rules = ['.measure-controls {', '.measure-cursors {', '.measure-row {',
    '.measure-param {', '.measure-value {', '.measure-status {', '.measure-actions {',
    '.analyzer-act.measure-add {', '.measure-note {', '.measure-window {',
    '.measure-undo {', '.measure-undo-text {', '.analyzer-act.measure-undo-action {',
    '.measure-catalog-dialog {', '.measure-catalog-body {', '.measure-catalog-source > .field {',
    '.measure-catalog-list {', '.measure-catalog-group {', '.measure-catalog-row {',
    '.measure-catalog-check {', '.measure-catalog-text {', '.measure-catalog-param {',
    '.measure-catalog-method {', '.measure-capture {', '.measure-capture-progress {',
    '.measure-capture-actions {', '.analyzer-act.measure-capture-cancel {',
    '.analyzer-act.measure-capture-restart {'];
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
    measureSection.indexOf('item.append(source, toggle, status, remove, details);') > 0 &&
    measureSection.indexOf('status.className') <
      measureSection.indexOf('item.append(source, toggle, status, remove, details);'),
    `order=${status.includes('order: 1;')}`);

  check('the source column wraps and the footer actions wrap at the narrow rail',
    slice(css, '.measure-source {', '}').includes('overflow-wrap: anywhere;') &&
    slice(css, '.measure-actions {', '}').includes('flex-wrap: wrap;') &&
    !css.includes('.measure-add-row'),
    `source=${css.includes('.measure-source {')}, ` +
      `actions=${css.includes('.measure-actions {')}, ` +
      `temp=${css.includes('.measure-add-row')}`);

  const catalogRow = slice(css, '.measure-catalog-row {', '}');
  const catalogMethod = slice(css, '.measure-catalog-method {', '}');
  check('a catalog row lays out checkbox, name and method without forcing horizontal overflow',
    catalogRow.includes('align-items: flex-start;') &&
      catalogRow.includes('cursor: pointer;') &&
      catalogMethod.includes('overflow-wrap: anywhere;') &&
      slice(css, '.measure-catalog-text {', '}').includes('min-width: 0;') &&
      slice(css, '.measure-catalog-dialog {', '}')
        .includes('width: min(420px, calc(100vw - 32px));'),
    `row=${catalogRow.length}, method=${catalogMethod.length}`);

  const hiddenRules = ['\n.measure-undo[hidden] { display: none; }',
    '\n.measure-capture[hidden] { display: none; }',
    '\n.measure-capture-cancel[hidden], .measure-capture-restart[hidden] { display: none; }'];
  const missingHidden = hiddenRules.filter((rule) => !css.includes(rule));
  const unguarded = hiddenRules.filter((rule) => {
    const cls = rule.slice(1, rule.indexOf('['));
    return !css.includes(`${cls} {`) && !css.includes(`${cls},`);
  });
  check('every measurement block with an author display still collapses when hidden',
    missingHidden.length === 0 && unguarded.length === 0 &&
      slice(css, '.measure-capture {', '}').includes('display: flex;') &&
      slice(css, '.measure-undo {', '}').includes('display: flex;'),
    `missing=${JSON.stringify(missingHidden)}, authorRule=${JSON.stringify(
      hiddenRules.map((rule) => css.includes(rule.slice(1, rule.indexOf('[')) + ' {')))}`);

  const block = slice(css, '.measure-controls {', '.cursor-edge-channel {');
  const colour = block.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/g) ?? [];
  check('the measurement rules reuse the sheet tokens and add no colour literal',
    block.length > 0 && colour.length === 0 && !block.includes('!important') &&
    block.includes('var(--text50)') && block.includes('var(--text80)'),
    `colours=${JSON.stringify(colour)}, block=${block.length} chars`);

  const addRule = slice(css, '.analyzer-act.measure-add {', '}');
  const clearRule = slice(css, '.analyzer-act.measure-clear {', '}');
  const undoRule = slice(css, '.analyzer-act.measure-undo-action {', '}');
  check('the three text actions override the icon box so their translated labels fit',
    [addRule, clearRule, undoRule].every((rule) => rule.includes('width: auto;') &&
      rule.includes('padding: 0 6px;') && rule.includes('white-space: nowrap;') &&
      !rule.includes('!important')),
    `add=${addRule.length}, clear=${clearRule.length}, undo=${undoRule.length}`);
}

{
  const doc = installFakeDom();
  const capture = doc.createElement('div');
  const cursors = doc.createElement('div');
  doc.body.append(capture, cursors);
  const panelView = (section: MeasurementSectionView): CapturePanelView => ({
    settings: defaultCaptureSettings(),
    channels: [],
    widthOptions: [16],
    buses: [],
    analogGroups: 0,
    deviceName: 'fixture',
    running: false,
    stopping: false,
    repeatPending: false,
    captureState: 'ready',
    result: null,
    progress: null,
    maxSamplerateHz: { 16: 200e6 },
    triggerState: 'off',
    cursors: [],
    cursorDistances: [],
    cursorEdges: [],
    cursorEdgeChannels: [],
    triggerViewLost: false,
    triggerViewPending: false,
    triggerLocked: false,
    triggerRetuneRejected: false,
    triggerAnalogRolling: false,
    triggerArmed: false,
    triggerAutoDisarmed: false,
    settingsArmed: false,
    activeTriggerPreSamples: undefined,
    measurement: section,
    analogScopeActive: true,
    persistence: { frames: 0, effective: 0, loop: false, clear: null },
  });
  const source: MeasurementSectionView['sources'] = [{ group: 0, start: 0, gain: 1, name: 'A0' }];
  const rowViews = (ids: readonly number[]): MeasurementRowView[] =>
    ids.map((id) => rowView({ id, parameter: 'vpp', unit: 'v', value: id }));
  const rowModels = (): MeasurementSectionView['allRows'] =>
    rows.map((row) => ({ id: row.id, start: row.start, parameter: row.parameter }));

  let rows = rowViews([1, 2, 3]);
  let undoCount: number | null = null;
  let cancelClear = false;
  let holdClear = false;
  const pendingClear: (() => void)[] = [];
  let openDialogFirst = false;
  let dropRemoveRender = false;
  let throwRemove = false;
  let dropUndoRender = false;
  let panel: CapturePanel;
  const render = (): void => {
    panel.render(panelView(sectionView({
      sources: source, rows, allRows: rowModels(), rowCount: rows.length, undoCount,
    })));
  };
  const focusDialog = doc.createElement('input');
  const dialog = doc.createElement('dialog');
  dialog.appendChild(focusDialog);
  doc.body.appendChild(dialog);
  panel = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    measure: cursors as unknown as HTMLElement,
  }, {
    onRemoveMeasurementRow: (id: number) => {
      if (openDialogFirst) {
        focusDialog.focus();
        openDialogFirst = false;
      }
      if (throwRemove) throw new Error('measurement remove failed');
      if (dropRemoveRender) return;
      rows = rows.filter((row) => row.id !== id);
      render();
    },
    onClearMeasurementRows: () => {
      if (cancelClear) {
        cancelClear = false;
        return Promise.resolve();
      }
      const apply = (): void => {
        undoCount = rows.length;
        rows = [];
        render();
      };
      if (holdClear) {
        return new Promise<void>((resolve) => {
          pendingClear.push(() => { apply(); resolve(); });
        });
      }
      apply();
      return Promise.resolve();
    },
    onUndoMeasurementRows: () => {
      if (dropUndoRender) return;
      rows = rowViews([1, 2, 3]);
      undoCount = null;
      render();
    },
  } as unknown as CapturePanelCallbacks);

  const active = (): FakeElement | null =>
    doc.activeElement === doc.body ? null : doc.activeElement;
  const removeOf = (id: number): FakeElement | null =>
    cursors.querySelector(`.measure-row[data-measure-id="${id}"] .analyzer-act--remove`);
  const addOf = (): FakeElement | null => cursors.querySelector('[data-measure-open]');
  const shownIds = (): string[] =>
    cursors.querySelectorAll('.measure-row').map((item) => item.dataset.measureId ?? '');

  const reset = (ids: readonly number[]): void => {
    rows = rowViews(ids);
    undoCount = null;
    cancelClear = false;
    holdClear = false;
    pendingClear.length = 0;
    openDialogFirst = false;
    throwRemove = false;
    render();
  };

  reset([1, 2, 3]);
  removeOf(2)?.focus();
  const middleFocused = active() === removeOf(2);
  removeOf(2)?.click();
  const afterMiddle = active();
  check('removing a middle row hands the focus to the next row in the same list',
    middleFocused && JSON.stringify(shownIds()) === JSON.stringify(['1', '3']) &&
      afterMiddle !== null && afterMiddle === removeOf(3) && afterMiddle !== addOf(),
    `focused=${middleFocused}, ids=${JSON.stringify(shownIds())}, ` +
      `next=${afterMiddle === removeOf(3)}, add=${afterMiddle === addOf()}`);

  reset([1, 2, 3]);
  removeOf(3)?.focus();
  removeOf(3)?.click();
  const afterLast = active();
  check('removing the last row hands the focus to the previous row',
    JSON.stringify(shownIds()) === JSON.stringify(['1', '2']) &&
      afterLast !== null && afterLast === removeOf(2) && afterLast !== addOf(),
    `ids=${JSON.stringify(shownIds())}, previous=${afterLast === removeOf(2)}`);

  reset([7]);
  removeOf(7)?.focus();
  removeOf(7)?.click();
  const afterOnly = active();
  check('removing the only row hands the focus to the Add measurement button',
    shownIds().length === 0 && afterOnly !== null && afterOnly === addOf(),
    `ids=${JSON.stringify(shownIds())}, add=${afterOnly === addOf()}`);

  reset([1, 2, 3]);
  const clear = cursors.querySelector('[data-measure-clear-all]');
  clear?.focus();
  const clearFocused = clear !== null && clear.disabled === false && active() === clear;
  clear?.click();
  const afterClear = active();
  check('a confirmed Clear all hands the focus to Add because the Clear button goes away',
    clearFocused && shownIds().length === 0 && afterClear !== null && afterClear === addOf(),
    `ids=${JSON.stringify(shownIds())}, focused=${clearFocused}, ` +
      `add=${afterClear === addOf()}`);

  const undo = cursors.querySelector('[data-measure-undo]');
  undo?.focus();
  const undoFocused = undo !== null && active() === undo;
  undo?.click();
  const afterUndo = active();
  check('Undo hands the focus to Add because the Undo button disappears',
    undoFocused && JSON.stringify(shownIds()) === JSON.stringify(['1', '2', '3']) &&
      cursors.querySelector('[data-measure-undo]') === null &&
      afterUndo !== null && afterUndo === addOf(),
    `focused=${undoFocused}, ids=${JSON.stringify(shownIds())}, ` +
      `gone=${cursors.querySelector('[data-measure-undo]') === null}, ` +
      `add=${afterUndo === addOf()}`);

  reset([1, 2, 3]);
  removeOf(2)?.focus();
  const liveTarget = active();
  panel.updateMeasurements(sectionView({
    sources: source, rows, allRows: rowModels(), rowCount: rows.length,
  }));
  check('a live measurement refresh moves no focus',
    liveTarget === removeOf(2) && active() === liveTarget && liveTarget !== addOf(),
    `before=${liveTarget === removeOf(2)}, after=${active() === liveTarget}`);

  reset([1, 2, 3]);
  removeOf(2)?.focus();
  render();
  check('an unrelated re-render neither keeps a hand-off nor steals the focus to Add',
    active() === null && addOf() !== null && removeOf(2) !== null,
    `active=${active() === null ? 'body' : 'other'}, add=${addOf() !== null}`);

  reset([1, 2, 3]);
  dropRemoveRender = true;
  removeOf(2)?.focus();
  removeOf(2)?.click();
  dropRemoveRender = false;
  rows = rowViews([1, 3]);
  render();
  const afterDroppedRemove = active();
  check('a row action that produced no rebuild drops its hand-off instead of taking a later one',
    JSON.stringify(shownIds()) === JSON.stringify(['1', '3']) && removeOf(3) !== null &&
      afterDroppedRemove === null,
    `ids=${JSON.stringify(shownIds())}, target=${removeOf(3) !== null}, ` +
      `active=${afterDroppedRemove === null ? 'body' : 'other'}`);

  reset([1, 2, 3]);
  throwRemove = true;
  removeOf(2)?.focus();
  let threw = false;
  try {
    removeOf(2)?.click();
  } catch {
    threw = true;
  }
  throwRemove = false;
  rows = rowViews([1, 3]);
  render();
  const afterThrownRemove = active();
  check('a row action whose callback throws drops its hand-off before the error escapes',
    threw && JSON.stringify(shownIds()) === JSON.stringify(['1', '3']) &&
      removeOf(3) !== null && afterThrownRemove === null,
    `threw=${threw}, ids=${JSON.stringify(shownIds())}, ` +
      `active=${afterThrownRemove === null ? 'body' : 'other'}`);

  reset([1, 2, 3]);
  const clearCancelled = cursors.querySelector('[data-measure-clear-all]');
  clearCancelled?.focus();
  cancelClear = true;
  clearCancelled?.click();
  rows = [];
  undoCount = null;
  render();
  const afterCancelledClear = active();
  check('a cancelled Clear all drops its hand-off instead of taking a later empty render',
    shownIds().length === 0 && addOf() !== null && afterCancelledClear === null,
    `ids=${JSON.stringify(shownIds())}, target=${addOf() !== null}, ` +
      `active=${afterCancelledClear === null ? 'body' : 'other'}`);

  await Promise.resolve();
  undoCount = 2;
  render();
  const afterSettledClear = active();
  check('a settled Clear all is one-shot, so a much later render cannot take its hand-off',
    shownIds().length === 0 && undoCount === 2 && addOf() !== null && afterSettledClear === null,
    `undo=${undoCount}, target=${addOf() !== null}, ` +
      `active=${afterSettledClear === null ? 'body' : 'other'}`);

  reset([1, 2, 3]);
  holdClear = true;
  const deferredClear = cursors.querySelector('[data-measure-clear-all]');
  deferredClear?.focus();
  deferredClear?.click();
  render();
  const duringClear = active();
  pendingClear.shift()?.();
  const afterDeferredClear = active();
  check('a pending Clear all keeps its hand-off across an unrelated rebuild and uses it on confirmation',
    duringClear === null && shownIds().length === 0 && afterDeferredClear === addOf(),
    `during=${duringClear === null ? 'body' : 'other'}, ids=${JSON.stringify(shownIds())}, ` +
      `add=${afterDeferredClear === addOf()}`);

  reset([1, 2, 3]);
  cursors.querySelector('[data-measure-clear-all]')?.click();
  const undoStale = cursors.querySelector('[data-measure-undo]');
  undoStale?.focus();
  dropUndoRender = true;
  undoStale?.click();
  dropUndoRender = false;
  render();
  const afterStaleUndo = active();
  check('an Undo that changed nothing drops its hand-off instead of taking a later one',
    shownIds().length === 0 && cursors.querySelector('[data-measure-undo]') !== null &&
      afterStaleUndo === null,
    `ids=${JSON.stringify(shownIds())}, ` +
      `undo=${cursors.querySelector('[data-measure-undo]') !== null}, ` +
      `active=${afterStaleUndo === null ? 'body' : 'other'}`);

  reset([1, 2, 3]);
  openDialogFirst = true;
  removeOf(2)?.focus();
  removeOf(2)?.click();
  check('a control that already holds the focus before the rebuild keeps it',
    JSON.stringify(shownIds()) === JSON.stringify(['1', '3']) && active() === focusDialog,
    `dialog=${active() === focusDialog}, ids=${JSON.stringify(shownIds())}`);
}

{
  const running = sectionView({
    capture: { status: 'running', scanned: 98304, total: 300000, droppedSamples: 1200000 },
  });
  const analyzing = measurementCaptureState(running);
  check('the analyzing line states done, total and percent with numeric progress values',
    analyzing !== null &&
      analyzing.text === 'Analyzing capture: 98,304 / 300,000 samples (32%)' &&
      analyzing.valueNow === 98304 && analyzing.valueMax === 300000 &&
      analyzing.running && !analyzing.cancelled,
    `text=${analyzing?.text}, now=${analyzing?.valueNow}/${analyzing?.valueMax}`);

  const cancelled = measurementCaptureState(sectionView({
    capture: { status: 'cancelled', scanned: 98304, total: 300000, droppedSamples: 0 },
  }));
  check('a cancelled job states that it stopped and offers the restart, never a percentage',
    cancelled !== null && cancelled.text === 'Analysis cancelled' &&
      !cancelled.running && cancelled.cancelled &&
      !cancelled.text.includes('%'),
    `text=${cancelled?.text}`);

  const done = measurementCaptureState(sectionView({
    capture: { status: 'done', scanned: 300000, total: 300000, droppedSamples: 0 },
  }));
  check('a finished job hides the progress line because the rows carry the values',
    done === null && measurementCaptureState(sectionView()) === null,
    `done=${String(done)}, none=${String(measurementCaptureState(sectionView()))}`);

  const retained = measurementWindowText(sectionView({
    window: { start: 0, end: 300000 },
    capture: { status: 'running', scanned: 0, total: 300000, droppedSamples: 1200000 },
  }));
  const plain = measurementWindowText(sectionView({ window: { start: 0, end: 300000 } }));
  check('the capture window discloses the absolute retained range and the plain window does not',
    retained === 'Window: 300,000 samples (captured 1,200,000 – 1,500,000)' &&
      plain === 'Window: 300,000 samples',
    `retained=${retained}, plain=${plain}`);
}

{
  const progressBlock = slice(measureSection, 'if (v.measurement.capture !== null) {',
    'if (v.measurement.rows.length === 0) {');
  const built = (source: string): boolean =>
    source.includes("const capture = div('measure-capture');") &&
    source.includes("capture.dataset.measureCapture = '';") &&
    source.includes("const progress = div('measure-capture-progress');") &&
    source.includes("progress.dataset.measureCaptureProgress = '';") &&
    source.includes("progress.setAttribute('role', 'progressbar');") &&
    source.includes("progress.setAttribute('aria-valuemin', '0');") &&
    source.includes("progress.setAttribute('aria-label', t('capturePanel.measureCaptureLabel'));") &&
    source.includes("cancel.dataset.measureCaptureCancel = '';") &&
    source.includes("cancel.textContent = t('capturePanel.measureCaptureCancel');") &&
    source.includes("restart.dataset.measureCaptureRestart = '';") &&
    source.includes("restart.textContent = t('capturePanel.measureCaptureRestart');") &&
    source.includes('this.runMeasureAction(\'capture-cancel\', cancel,') &&
    source.includes('() => this.cb.onCancelMeasurementCapture()') &&
    source.includes('this.runMeasureAction(\'capture-restart\', restart,') &&
    source.includes('() => this.cb.onRestartMeasurementCapture()') &&
    source.includes('captureActions.append(cancel, restart);') &&
    source.includes('capture.append(progress, captureActions);') &&
    source.includes('measureSec.body.appendChild(capture);') &&
    source.includes('applyMeasurementCapture(capture, measurementCaptureState(v.measurement));');
  const noRole = built(progressBlock.replace(
    "progress.setAttribute('role', 'progressbar');", ''));
  const noCancel = built(progressBlock.replace(
    '() => this.cb.onCancelMeasurementCapture()', '() => {}'));
  const windowAt = measureSection.indexOf("const measureWindow = div('measure-window');");
  const rowAt = measureSection.indexOf("const list = div('measure-list');");
  const blockAt = measureSection.indexOf('if (v.measurement.capture !== null) {');
  check('the progress line sits between the window line and the rows with role, label and actions',
    built(progressBlock) && !noRole && !noCancel &&
      blockAt > windowAt && blockAt < rowAt &&
      progressBlock.includes("if (v.measurement.capture !== null) {") &&
      panel.includes('onCancelMeasurementCapture(): void;') &&
      panel.includes('onRestartMeasurementCapture(): void;'),
    `built=${built(progressBlock)}, blockAt=${blockAt}, rows=${rowAt}`);

  const updaterQuiet = (source: string): boolean =>
    source.includes('const capture = measurementCaptureState(view);') &&
    source.includes("root.querySelectorAll<HTMLElement>('[data-measure-capture]')") &&
    source.includes('applyMeasurementCapture(item, capture);') &&
    !source.includes('createElement') && !source.includes('this.cb.');
  const noFill = updaterQuiet(measureUpdater.replace(
    'applyMeasurementCapture(item, capture);', ''));
  check('the live refresh rewrites the progress text and action visibility in place',
    updaterQuiet(measureUpdater) && !noFill &&
      panel.includes('function applyMeasurementCapture(') &&
      panel.includes("progress.setAttribute('aria-valuemax', String(state.valueMax));") &&
      panel.includes("progress.setAttribute('aria-valuenow', String(state.valueNow));") &&
      panel.includes('if (cancel !== null) cancel.hidden = !state.running;') &&
      panel.includes('if (restart !== null) restart.hidden = !state.cancelled;') &&
      panel.includes('root.hidden = state === null;'),
    `update=${updaterQuiet(measureUpdater)}, fill=${panel.includes('function applyMeasurementCapture(')}`);
}

{
  const doc = installFakeDom();
  const capture = doc.createElement('div');
  const cursors = doc.createElement('div');
  doc.body.append(capture, cursors);
  let state: 'running' | 'cancelled' | 'done' = 'running';
  let scans = 0;
  const total = 300000;
  const section = (): MeasurementSectionView => sectionView({
    sources: [{ group: 0, start: 0, gain: 1, name: 'A0' }],
    rows: [rowView({ id: 1, parameter: 'vpp', unit: 'v', value: state === 'done' ? 21.4588 : Number.NaN, status: state === 'done' ? 'ok' : state === 'cancelled' ? 'cancelled' : 'analyzing' })],
    window: { start: 0, end: total },
    capture: {
      status: state,
      scanned: state === 'running' ? 98304 : total,
      total,
      droppedSamples: 1200000,
    },
  });
  const view = (): CapturePanelView => ({
    settings: defaultCaptureSettings(),
    channels: [],
    widthOptions: [16],
    buses: [],
    analogGroups: 0,
    deviceName: 'fixture',
    running: false,
    stopping: false,
    repeatPending: false,
    captureState: 'ready',
    result: null,
    progress: null,
    maxSamplerateHz: { 16: 200e6 },
    triggerState: 'off',
    cursors: [],
    cursorDistances: [],
    cursorEdges: [],
    cursorEdgeChannels: [],
    triggerViewLost: false,
    triggerViewPending: false,
    triggerLocked: false,
    triggerRetuneRejected: false,
    triggerAnalogRolling: false,
    triggerArmed: false,
    triggerAutoDisarmed: false,
    settingsArmed: false,
    activeTriggerPreSamples: undefined,
    measurement: section(),
    analogScopeActive: true,
    persistence: { frames: 0, effective: 0, loop: false, clear: null },
  });
  const panel = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    measure: cursors as unknown as HTMLElement,
  }, {
    onCancelMeasurementCapture: () => { scans += 1; state = 'cancelled'; render(); },
    onRestartMeasurementCapture: () => { scans += 1; state = 'running'; render(); },
  } as unknown as CapturePanelCallbacks);
  const render = (): void => panel.render(view());
  const progressOf = (): FakeElement | null =>
    cursors.querySelector('[data-measure-capture-progress]');
  const wrapperOf = (): FakeElement | null => cursors.querySelector('[data-measure-capture]');
  const cancelOf = (): FakeElement | null => cursors.querySelector('[data-measure-capture-cancel]');
  const restartOf = (): FakeElement | null => cursors.querySelector('[data-measure-capture-restart]');
  const active = (): FakeElement | null =>
    doc.activeElement === doc.body ? null : doc.activeElement;

  render();
  const first = {
    text: progressOf()?.textContent ?? '',
    max: progressOf()?.getAttribute('aria-valuemax') ?? '',
    now: progressOf()?.getAttribute('aria-valuenow') ?? '',
    role: progressOf()?.getAttribute('role') ?? '',
    min: progressOf()?.getAttribute('aria-valuemin') ?? '',
    label: progressOf()?.getAttribute('aria-label') ?? '',
    cancel: cancelOf()?.hidden,
    restart: restartOf()?.hidden,
    hidden: wrapperOf()?.hidden,
  };
  check('the running job renders one progress bar with numeric aria values and only Cancel',
    first.text === 'Analyzing capture: 98,304 / 300,000 samples (32%)' &&
      first.max === '300000' && first.now === '98304' && first.min === '0' &&
      first.role === 'progressbar' && first.label === 'Capture range analysis' &&
      first.cancel === false && first.restart === true && first.hidden === false,
    `first=${JSON.stringify(first)}`);

  panel.updateMeasurements(sectionView({
    ...section(),
    rows: [rowView({ id: 1, parameter: 'vpp', unit: 'v', status: 'cancelled' })],
    capture: { ...section().capture!, status: 'cancelled' },
  }));
  const cancelledState = {
    text: progressOf()?.textContent ?? '',
    cancel: cancelOf()?.hidden,
    restart: restartOf()?.hidden,
    row: cursors.querySelector('.measure-row .measure-status')?.textContent ?? '',
  };
  check('a cancelled job is disclosed in place with the restart and no live row update',
    cancelledState.text === 'Analysis cancelled' &&
      cancelledState.cancel === true && cancelledState.restart === false &&
      cancelledState.row.includes('cancelled'),
    `state=${JSON.stringify(cancelledState)}`);

  panel.updateMeasurements(sectionView({
    ...section(), capture: { ...section().capture!, status: 'done' },
  }));
  check('a finished job collapses the progress line in place and leaves the wrapper reusable',
    wrapperOf() !== null && wrapperOf()?.hidden === true,
    `hidden=${wrapperOf()?.hidden}`);

  panel.updateMeasurements(section());
  check('a refreshed running job restores its own progress state without a rebuild',
    progressOf()?.getAttribute('aria-valuenow') === '98304' &&
      cancelOf()?.hidden === false && restartOf()?.hidden === true,
    `now=${progressOf()?.getAttribute('aria-valuenow')}`);

  state = 'running';
  render();
  cancelOf()?.focus();
  const cancelFocused = active() === cancelOf();
  cancelOf()?.click();
  const afterCancel = active();
  const afterCancelState: string = state;
  check('Cancel stops the job, keeps the hand-off and lands on Analyze again',
    cancelFocused && scans === 1 && afterCancelState === 'cancelled' &&
      afterCancel !== null && afterCancel !== doc.body && afterCancel === restartOf(),
    `focused=${cancelFocused}, scans=${scans}, restart=${afterCancel === restartOf()}`);

  restartOf()?.focus();
  const restartFocused = active() === restartOf();
  restartOf()?.click();
  const afterRestart = active();
  const afterRestartState: string = state;
  check('Analyze again starts a new job and hands the focus back to Cancel',
    restartFocused && scans === 2 && afterRestartState === 'running' &&
      afterRestart !== null && afterRestart !== doc.body && afterRestart === cancelOf(),
    `focused=${restartFocused}, scans=${scans}, cancel=${afterRestart === cancelOf()}`);
}

{
  const doc = installFakeDom();
  const capture = doc.createElement('div');
  const cursors = doc.createElement('div');
  doc.body.append(capture, cursors);
  const statsOf = (over: Partial<MeasurementStatsView> = {}): MeasurementStatsView => ({
    count: 2, mean: 3.5, min: 1, max: 5, stdDev: 1.5, excluded: 0, capped: false, ...over,
  });
  const section = (over: Partial<MeasurementSectionView> = {}): MeasurementSectionView =>
    sectionView({
      sources: [{ group: 0, start: 0, gain: 1, name: 'A0' }],
      rows: [rowView({
        id: 1, parameter: 'vpp', unit: 'v', value: 21.4588, analyzedSamples: 1000,
        requestedSamples: 1000, crossingCount: 0, stats: statsOf(),
      })],
      allRows: [{ id: 1, start: 0, parameter: 'vpp' }],
      rowCount: 1,
      window: { start: 0, end: 1000 },
      ...over,
    });
  const view = (over: Partial<MeasurementSectionView> = {}): CapturePanelView => ({
    settings: defaultCaptureSettings(),
    channels: [],
    widthOptions: [16],
    buses: [],
    analogGroups: 0,
    deviceName: 'fixture',
    running: false,
    stopping: false,
    repeatPending: false,
    captureState: 'ready',
    result: null,
    progress: null,
    maxSamplerateHz: { 16: 200e6 },
    triggerState: 'off',
    cursors: [],
    cursorDistances: [],
    cursorEdges: [],
    cursorEdgeChannels: [],
    triggerViewLost: false,
    triggerViewPending: false,
    triggerLocked: false,
    triggerRetuneRejected: false,
    triggerAnalogRolling: false,
    triggerArmed: false,
    triggerAutoDisarmed: false,
    settingsArmed: false,
    activeTriggerPreSamples: undefined,
    measurement: section(over),
    analogScopeActive: true,
    persistence: { frames: 0, effective: 0, loop: false, clear: null },
  });
  const resets: string[] = [];
  const target = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    measure: cursors as unknown as HTMLElement,
  }, {
    onResetMeasurementStats: (rowId: number) => resets.push(`row:${rowId}`),
    onResetAllMeasurementStats: () => resets.push('all'),
  } as unknown as CapturePanelCallbacks);
  const toggleOf = (): FakeElement | null => cursors.querySelector('.measure-row .measure-open');
  const detailsOf = (): FakeElement | null => cursors.querySelector('[data-measure-details]');
  const chevronOf = (): FakeElement | null =>
    cursors.querySelector('.measure-open .measure-chevron');
  const toggleClasses = (): string[] => (toggleOf()?.children ?? [])
    .map((child) => child.className);
  const disclosureOrder = (classes: readonly string[]): boolean =>
    classes.length === 3 && classes[0] === 'measure-param' &&
      classes[1] === 'measure-chevron' && classes[2] === 'measure-value';
  const cellOf = (key: string): string =>
    cursors.querySelector(`[data-measure-detail="${key}"]`)?.textContent ?? '';
  const active = (): FakeElement | null =>
    doc.activeElement === doc.body ? null : doc.activeElement;

  target.render(view());
  const closed = {
    tag: toggleOf()?.tagName ?? '',
    expanded: toggleOf()?.getAttribute('aria-expanded') ?? '',
    controls: toggleOf()?.getAttribute('aria-controls') ?? '',
    label: toggleOf()?.getAttribute('aria-label') ?? '',
    id: detailsOf()?.id ?? '',
    hidden: detailsOf()?.hidden,
    param: cursors.querySelector('.measure-open .measure-param')?.textContent ?? '',
    value: cursors.querySelector('.measure-open .measure-value')?.textContent ?? '',
  };
  check('the parameter and value region is a disclosure button wired to one details block',
    closed.tag === 'BUTTON' && closed.expanded === 'false' &&
      closed.controls === 'measure-details-1' && closed.id === 'measure-details-1' &&
      closed.hidden === true && closed.param === 'Vpp' && closed.value === '21.5 V' &&
      closed.label === 'Show statistics details: A0 Vpp',
    `closed=${JSON.stringify(closed)}`);

  const chevron = chevronOf();
  const chevronPath = chevron?.children[0] ?? null;
  const chevronAttr = (name: string): string => chevron?.getAttribute(name) ?? '';
  const pathAttr = (name: string): string => chevronPath?.getAttribute(name) ?? '';
  const swapped = ['measure-param', 'measure-value', 'measure-chevron'];
  const missingChevron = ['measure-param', 'measure-value'];
  check('the disclosure affordance sits between the parameter and the value',
    disclosureOrder(toggleClasses()) &&
      cursors.querySelectorAll('.measure-open .measure-chevron').length === 1 &&
      !disclosureOrder(swapped) && !disclosureOrder(missingChevron),
    `classes=${JSON.stringify(toggleClasses())}, swapped=${disclosureOrder(swapped)}, ` +
      `missing=${disclosureOrder(missingChevron)}`);
  check('the affordance is a decorative down chevron drawn by the shared icon path helper',
    chevronAttr('viewBox') === '0 0 24 24' && chevronAttr('aria-hidden') === 'true' &&
      chevronAttr('focusable') === 'false' && chevronAttr('data-icon') === 'inline-end' &&
      chevron?.children.length === 1 && pathAttr('d') === 'm6 9 6 6 6-6' &&
      pathAttr('fill') === 'none' && pathAttr('stroke') === 'currentColor' &&
      pathAttr('stroke-width') === '2',
    `attrs=${JSON.stringify([chevronAttr('aria-hidden'), chevronAttr('focusable'),
      chevronAttr('data-icon'), pathAttr('d')])}`);

  toggleOf()?.focus();
  const focused = active() === toggleOf();
  toggleOf()?.click();
  const opened = {
    expanded: toggleOf()?.getAttribute('aria-expanded') ?? '',
    label: toggleOf()?.getAttribute('aria-label') ?? '',
    hidden: detailsOf()?.hidden,
    focus: active() === toggleOf(),
    method: cellOf('method'),
    window: cellOf('window'),
    current: cellOf('current'),
    mean: cellOf('mean'),
    min: cellOf('min'),
    max: cellOf('max'),
    stdDev: cellOf('stdDev'),
    count: cellOf('count'),
    excluded: cellOf('excluded'),
    loop: cellOf('loop'),
  };
  check('opening the details carries the method, the window, the current value and the population',
    focused && opened.expanded === 'true' &&
      opened.label === 'Hide statistics details: A0 Vpp' && opened.hidden === false &&
      opened.focus && opened.method === 'exact code extrema' &&
      opened.window === 'Window: 1,000 samples' && opened.current === '21.5 V' &&
      opened.mean === '3.5 V' && opened.min === '1 V' && opened.max === '5 V' &&
      opened.stdDev === '1.5 V' && opened.count === '2' && opened.excluded === '0' &&
      opened.loop === '',
    `opened=${JSON.stringify(opened)}`);
  check('the session-only statistics note is part of the details in every theme',
    cellOf('note') === 'Statistics are cross-acquisition and kept for this session only.' &&
      cellOf('note').length > 0,
    `note=${cellOf('note')}`);
  check('expanding rotates the same chevron through aria-expanded instead of swapping its path',
    opened.expanded === 'true' && chevronOf() === chevron &&
      (chevronOf()?.children[0]?.getAttribute('d') ?? '') === 'm6 9 6 6 6-6',
    `same=${chevronOf() === chevron}, d=${chevronOf()?.children[0]?.getAttribute('d') ?? ''}, ` +
      `expanded=${opened.expanded}`);

  toggleOf()?.click();
  check('a second activation collapses the details without rebuilding the row',
    toggleOf()?.getAttribute('aria-expanded') === 'false' && detailsOf()?.hidden === true &&
      active() === toggleOf() && cursors.querySelectorAll('.measure-row').length === 1,
    `expanded=${toggleOf()?.getAttribute('aria-expanded')}, hidden=${detailsOf()?.hidden}`);
  toggleOf()?.click();

  target.updateMeasurements(section({ rows: [rowView({
    id: 1, parameter: 'vpp', unit: 'v', value: 22, analyzedSamples: 1000,
    requestedSamples: 1000, crossingCount: 0, stats: statsOf({
      count: 3, mean: 4, min: 2, max: 6, stdDev: 2, excluded: 1,
    }),
  })] }));
  const updated = {
    value: cursors.querySelector('.measure-open .measure-value')?.textContent ?? '',
    count: cellOf('count'),
    mean: cellOf('mean'),
    excluded: cellOf('excluded'),
  };
  check('a live refresh rewrites the open details in place and still hides the closed ones',
    updated.value === '22 V' && updated.count === '3' && updated.mean === '4 V' &&
      updated.excluded === '1' && detailsOf()?.hidden === false,
    `updated=${JSON.stringify(updated)}`);

  const nodes = (): FakeElement[] => [
    cursors.querySelector('[data-measure-detail="count"]')!,
    cursors.querySelector('[data-measure-details]')!,
  ];
  const before = nodes();
  target.updateMeasurements(section());
  check('the in-place refresh keeps the same details elements, so nothing is rebuilt per update',
    nodes()[0] === before[0] && nodes()[1] === before[1] && cellOf('count') === '2',
    `same=${nodes()[0] === before[0]}, count=${cellOf('count')}`);

  const rebuilt = (source: string): boolean => source.includes('details.replaceChildren()') ||
    source.includes('item.replaceChildren()');
  check('an updater that rebuilt the details instead of rewriting text fails that control',
    !rebuilt(slice(panel, 'updateMeasurements(view: MeasurementSectionView): void {',
      'updateCursors(rows: readonly CursorRowView[]): void {')),
    `rebuilt=${rebuilt(slice(panel, 'updateMeasurements(view: MeasurementSectionView): void {',
      'updateCursors(rows: readonly CursorRowView[]): void {'))}`);

  target.render(view({
    rows: [rowView({
      id: 1, parameter: 'vpp', unit: 'v', value: 21.4588, crossingCount: 0,
      stats: statsOf({ count: 1, mean: 21.4588, min: 21.4588, max: 21.4588, stdDev: null }),
    })],
  }));
  toggleOf()?.click();
  check('a single sample renders StdDev as the locale-neutral dash, never a zero spread',
    cellOf('stdDev') === '--' && cellOf('count') === '1',
    `stdDev=${JSON.stringify(cellOf('stdDev'))}, count=${cellOf('count')}`);

  target.render(view({
    rows: [rowView({
      id: 1, parameter: 'vpp', unit: 'v', value: 21.4588, crossingCount: 0,
      stats: statsOf({ count: 512, capped: true, excluded: 4 }),
    })],
    statsSkipped: 3,
  }));
  toggleOf()?.click();
  const capped = {
    count: cellOf('count'),
    excluded: cellOf('excluded'),
    skipped: cellOf('skipped'),
    skippedHidden: cursors.querySelector('[data-measure-detail="skipped"]')?.hidden,
  };
  check('the cap is stated on the count and the excluded and skipped intervals are disclosed',
    capped.count === '512 (capped at 512)' && capped.excluded === '4' &&
      capped.skipped === 'Skipped visibility intervals: 3' && capped.skippedHidden === false,
    `capped=${JSON.stringify(capped)}`);

  target.render(view({
    rows: [rowView({
      id: 1, parameter: 'vpp', unit: 'v', value: 21.4588, crossingCount: 0,
      stats: noMeasurementStatsView(),
    })],
    statsSkipped: 0,
    statsLoopUnavailable: true,
  }));
  toggleOf()?.click();
  const loop = {
    statsHidden: cursors.querySelector('[data-measure-stats]')?.hidden,
    loop: cellOf('loop'),
    skippedHidden: cursors.querySelector('[data-measure-detail="skipped"]')?.hidden,
    count: cellOf('count'),
    current: cellOf('current'),
  };
  check('Loop discloses the unavailable statistics with the reason instead of a zero count',
    loop.statsHidden === true && loop.count === '--' &&
      loop.loop === 'cross-acquisition statistics are unavailable in Loop captures' &&
      loop.skippedHidden === true && loop.current === '21.5 V',
    `loop=${JSON.stringify(loop)}`);

  const reset = cursors.querySelector('[data-measure-stats-reset]');
  const resetAll = cursors.querySelector('[data-measure-stats-reset-all]');
  check('the details own the per-row and all-rows reset actions',
    reset !== null && resetAll !== null &&
      reset.textContent === 'Reset statistics' &&
      resetAll.textContent === 'Reset all statistics' &&
      reset.getAttribute('data-measure-stats-reset') === '1',
    `row=${reset?.textContent}, all=${resetAll?.textContent}`);
  reset?.click();
  resetAll?.click();
  check('each reset button emits its own callback once, without touching the section',
    JSON.stringify(resets) === JSON.stringify(['row:1', 'all']) &&
      cursors.querySelectorAll('.measure-row').length === 1,
    `resets=${JSON.stringify(resets)}`);

  const accumulate = (values: readonly number[]): MeasurementStatsState => {
    let acc = emptyAccumulator('current');
    for (const value of values) acc = accumulateSample(acc, value);
    return { accumulators: new Map([[1, acc]]), skipped: 0, lastWaveKey: null };
  };
  const state = accumulate([2, 4]);
  const stale = measurementStatsView(state, 1, 'superseded');
  target.render(view({
    rows: [rowView({
      id: 1, parameter: 'vpp', unit: 'v', value: 21.4588, crossingCount: 0,
      stats: measurementStatsView(state, 1, 'current'),
    })],
  }));
  toggleOf()?.click();
  const matchedCount = cellOf('count');
  target.updateMeasurements(section({
    rows: [rowView({
      id: 1, parameter: 'vpp', unit: 'v', value: 21.4588, crossingCount: 0, stats: stale,
    })],
  }));
  const staleCount = cellOf('count');
  check('a superseded configuration key renders Count 0 instead of the previous population',
    matchedCount === '2' && staleCount === '0' && stale.mean !== stale.mean,
    `matched=${matchedCount}, stale=${staleCount}, staleMean=${String(stale.mean)}`);
}

{
  const rules = ['.measure-open {', '.measure-chevron {', '.measure-details {', '.measure-detail-method,',
    '.measure-detail-stats {', '.measure-detail-row {', '.measure-detail-label {',
    '.measure-detail-value {', '.measure-detail-actions {',
    '.analyzer-act.measure-stats-reset {', '.analyzer-act.measure-stats-reset-all {'];
  const absent = rules.filter((rule) => !css.includes(rule));
  const hiddenRules = ['\n.measure-details[hidden] { display: none; }',
    '\n.measure-detail-stats[hidden] { display: none; }'];
  const missingHidden = hiddenRules.filter((rule) => !css.includes(rule));
  check('the details block has its own sheet rules and every author display collapses when hidden',
    absent.length === 0 && missingHidden.length === 0 &&
      slice(css, '.measure-details {', '}').includes('display: flex;') &&
      slice(css, '.measure-detail-stats {', '}').includes('display: flex;'),
    `absent=${JSON.stringify(absent)}, hidden=${JSON.stringify(missingHidden)}`);

  const details = slice(css, '.measure-details {', '.measure-detail-stats {');
  const colour = details.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/g) ?? [];
  check('the details rules reuse the sheet tokens and add no colour literal',
    details.length > 0 && colour.length === 0 && !details.includes('!important'),
    `colours=${JSON.stringify(colour)}, block=${details.length} chars`);

  check('the details markup stays div/span/button, never a table, a list or string HTML',
    ['<table', '<dl', 'innerHTML', "createElement('table')", "createElement('dl')"]
      .every((needle) => !slice(panel, 'private measurementDetailsBlock(',
        'dispose(): void {').includes(needle)),
    `markup=${JSON.stringify(['<table', '<dl', 'innerHTML'].filter((needle) => slice(panel,
      'private measurementDetailsBlock(', 'dispose(): void {').includes(needle)))}`);

  const chevronRule = slice(css, '.measure-chevron {', '}');
  const chevronOpenRule = slice(css, '.measure-open[aria-expanded="true"] .measure-chevron {', '}');
  const ruleBody = (rule: string): string =>
    rule.slice(rule.indexOf('{') + 1).trim();
  const rotationOnly = (body: string): boolean => body === 'transform: rotate(180deg);';
  const chevronOpen = ruleBody(chevronOpenRule);
  const resizedOpen = ruleBody(chevronOpenRule.replace(
    'transform: rotate(180deg);', 'transform: rotate(180deg); width: 18px;'));
  const chevronRotate = (source: string): boolean =>
    rotationOnly(ruleBody(slice(source, '.measure-open[aria-expanded="true"] .measure-chevron {',
      '}')));
  const collapsedOnly = css.replace('.measure-open[aria-expanded="true"] .measure-chevron',
    '.measure-open[aria-expanded="false"] .measure-chevron');
  check('the chevron keeps one fixed box in both states and rotates through the expanded attribute',
    chevronRule.includes('width: 10px;') && chevronRule.includes('height: 10px;') &&
      chevronRule.includes('flex: none;') &&
      chevronRule.includes('color: var(--muted-foreground);') &&
      chevronRule.includes('transition: transform var(--motion-fast) var(--motion-ease);') &&
      !chevronRule.includes('display: none') && !chevronRule.includes('rotate(') &&
      rotationOnly(chevronOpen) && !rotationOnly(resizedOpen) &&
      chevronRotate(css) && !chevronRotate(collapsedOnly) &&
      !chevronOpenRule.includes('#') && !chevronOpenRule.includes('rgb'),
    `rule=${chevronRule}, open=${chevronOpen}, resized=${rotationOnly(resizedOpen)}, ` +
      `collapsedOnly=${chevronRotate(collapsedOnly)}`);
}

{
  const doc = installFakeDom();
  const capture = doc.createElement('div');
  const measure = doc.createElement('div');
  doc.body.append(capture, measure);
  const cursorRows = [
    { id: 1, label: 'A', color: '#ff0000', seconds: 0, sample: 0, time: '0 s' },
    { id: 2, label: 'B', color: '#00ff00', seconds: 1, sample: 100, time: '1.000 s' },
  ];
  const measured = (): MeasurementSectionView => sectionView({
    sources: [{ group: 0, start: 0, gain: 1, name: 'A0' }],
    rows: [rowView({ id: 1, parameter: 'vpp', unit: 'v', value: 1.5 })],
    allRows: [{ id: 1, start: 0, parameter: 'vpp' }],
    rowCount: 1,
  });
  const view = (gate: boolean): CapturePanelView => ({
    settings: defaultCaptureSettings(),
    channels: [],
    widthOptions: [16],
    buses: [],
    analogGroups: 0,
    deviceName: 'fixture',
    running: false,
    stopping: false,
    repeatPending: false,
    captureState: 'ready',
    result: null,
    progress: null,
    maxSamplerateHz: { 16: 200e6 },
    triggerState: 'off',
    cursors: cursorRows,
    cursorDistances: [],
    cursorEdges: [],
    cursorEdgeChannels: [],
    triggerViewLost: false,
    triggerViewPending: false,
    triggerLocked: false,
    triggerRetuneRejected: false,
    triggerAnalogRolling: false,
    triggerArmed: false,
    triggerAutoDisarmed: false,
    settingsArmed: false,
    activeTriggerPreSamples: undefined,
    measurement: measured(),
    analogScopeActive: gate,
    persistence: { frames: 0, effective: 0, loop: false, clear: null },
  });
  const panel = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    measure: measure as unknown as HTMLElement,
  }, {} as unknown as CapturePanelCallbacks);
  const all = (el: FakeElement): FakeElement[] =>
    el.children.flatMap((child) => [child, ...all(child)]);
  const titles = (): string[] => measure.querySelectorAll('.panel-section')
    .map((el) => el.children[0]?.children[0]?.textContent ?? '');
  const controls = (): number =>
    all(measure).filter((el) => /(^|\s)measure-/.test(el.className)).length;
  const hint = (): FakeElement | null => measure.querySelector('[data-measure-scope-off]');
  const listed = (): string[] => measure.querySelectorAll('.cursor-row')
    .map((el) => el.dataset.cursorId ?? '');
  const pageText = (): string => measure.textContent;

  panel.render(view(true));
  const openTitles = titles();
  const openControls = controls();
  const openPersistence = measure.querySelectorAll('.measure-persistence').length;
  const openRows = measure.querySelectorAll('.measure-row').length;
  check('with the gate open the measurement group renders last, after Cursors, Cursor distance and Edges',
    JSON.stringify(openTitles) === JSON.stringify([
      en['capturePanel.cursors'], en['capturePanel.cursorDistance'],
      en['capturePanel.cursorEdges'], en['capturePanel.measure'],
    ]) && openControls > 0 && openPersistence === 1 && openRows === 1 && hint() === null,
    `titles=${JSON.stringify(openTitles)}, controls=${openControls}, ` +
      `persistence=${openPersistence}, rows=${openRows}, hint=${hint() !== null}`);

  panel.render(view(true));
  const secondOpen = `${titles().join('|')}#${controls()}#${pageText()}`;
  panel.render(view(true));
  const thirdOpen = `${titles().join('|')}#${controls()}#${pageText()}`;
  check('an open gate renders the same measurement section on every pass',
    secondOpen === thirdOpen && openControls === controls() &&
      measure.querySelectorAll('.measure-row').length === openRows,
    `stable=${secondOpen === thirdOpen}, controls=${controls()}`);

  panel.render(view(false));
  const closedTitles = titles();
  const closedLast = measure.children[measure.children.length - 1];
  const closedHint = hint();
  check('with the gate closed the measured group is one enable hint as the last child',
    JSON.stringify(closedTitles) === JSON.stringify(openTitles.slice(0, 3)) &&
      controls() === 0 && measure.querySelectorAll('.measure-persistence').length === 0 &&
      measure.querySelector('[data-view-mode]') === null &&
      measure.querySelector('.measure-list') === null &&
      measure.querySelectorAll('.measure-row').length === 0 &&
      closedHint !== null && closedLast === closedHint &&
      closedHint.className === 'panel-note' &&
      closedHint.textContent === en['capturePanel.measureScopeOff'] &&
      !pageText().includes(en['capturePanel.measure']),
    `titles=${JSON.stringify(closedTitles)}, controls=${controls()}, ` +
      `last=${closedLast === closedHint}, text=${closedHint?.textContent ===
        en['capturePanel.measureScopeOff']}`);

  check('the cursor sections keep rendering in both gate states',
    JSON.stringify(listed()) === JSON.stringify(['1', '2']) &&
      measure.querySelectorAll('.cursor-dist-add-row').length === 1 &&
      measure.querySelectorAll('.cursor-edge-add-row').length === 1 &&
      closedTitles.length === 3,
    `rows=${JSON.stringify(listed())}, ` +
      `distance=${measure.querySelectorAll('.cursor-dist-add-row').length}, ` +
      `edges=${measure.querySelectorAll('.cursor-edge-add-row').length}`);

  let threw = '';
  try {
    panel.updateMeasurements(measured());
    panel.updatePersistence({ frames: 8, effective: 8, loop: false, clear: null });
    panel.updateCursors(cursorRows);
    panel.updateCursorDistances([]);
    panel.updateCursorEdges([]);
    panel.updateCursorEdges([{ id: 3, row: 1, a: null, b: null, channel: null, result: '-' }]);
  } catch (e) {
    threw = String(e);
  }
  check('the in-place updaters survive a gate that closed between renders',
    threw === '' && controls() === 0 && titles().length === 3 &&
      measure.children[measure.children.length - 1] === hint(),
    `threw=${threw}, controls=${controls()}, titles=${titles().length}`);
}

{
  const doc = installFakeDom();
  const capture = doc.createElement('div');
  const measure = doc.createElement('div');
  doc.body.append(capture, measure);
  const pending: (() => void)[] = [];
  let rows = [rowView({ id: 1, parameter: 'vpp', unit: 'v', value: 1.5 })];
  let undoCount: number | null = null;
  const view = (gate: boolean): CapturePanelView => ({
    settings: defaultCaptureSettings(),
    channels: [],
    widthOptions: [16],
    buses: [],
    analogGroups: 0,
    deviceName: 'fixture',
    running: false,
    stopping: false,
    repeatPending: false,
    captureState: 'ready',
    result: null,
    progress: null,
    maxSamplerateHz: { 16: 200e6 },
    triggerState: 'off',
    cursors: [],
    cursorDistances: [],
    cursorEdges: [],
    cursorEdgeChannels: [],
    triggerViewLost: false,
    triggerViewPending: false,
    triggerLocked: false,
    triggerRetuneRejected: false,
    triggerAnalogRolling: false,
    triggerArmed: false,
    triggerAutoDisarmed: false,
    settingsArmed: false,
    activeTriggerPreSamples: undefined,
    measurement: sectionView({
      sources: [{ group: 0, start: 0, gain: 1, name: 'A0' }],
      rows,
      allRows: rows.map((row) => ({ id: row.id, start: row.start, parameter: row.parameter })),
      rowCount: rows.length,
      undoCount,
    }),
    analogScopeActive: gate,
    persistence: { frames: 0, effective: 0, loop: false, clear: null },
  });
  const panel = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    measure: measure as unknown as HTMLElement,
  }, {
    onClearMeasurementRows: () => new Promise<void>((resolve) => { pending.push(resolve); }),
  } as unknown as CapturePanelCallbacks);
  const active = (): FakeElement | null =>
    doc.activeElement === doc.body ? null : doc.activeElement;
  const addOf = (): FakeElement | null => measure.querySelector('[data-measure-open]');
  const armClear = (): void => {
    panel.render(view(true));
    const clear = measure.querySelector('[data-measure-clear-all]');
    clear?.focus();
    clear?.click();
  };

  armClear();
  panel.render(view(false));
  const closed = active();
  rows = [];
  undoCount = 2;
  panel.render(view(true));
  const afterClosed = active();
  pending.shift()?.();

  rows = [rowView({ id: 2, parameter: 'vpp', unit: 'v', value: 2.5 })];
  undoCount = null;
  armClear();
  rows = [];
  undoCount = 3;
  panel.render(view(true));
  const appliedInRender = active() === addOf();

  check('a pending measurement hand-off is dropped by a closed-gate render and applied in an open one',
    closed === null && afterClosed === null && addOf() !== null && appliedInRender,
    `closed=${closed === null ? 'body' : 'other'}, ` +
      `reopened=${afterClosed === null ? 'body' : 'other'}, ` +
      `add=${addOf() !== null}, applied=${appliedInRender}`);
  pending.length = 0;
}

{
  const gateBody = slice(app, 'private analogScopeActive(): boolean {', '  }');
  const shared = 'return measurementSources(this.busViews, this.captureStore.channelCount).length > 0;';
  const sharedExpression = (source: string): boolean =>
    source.includes(shared) &&
    !source.includes('displayChannelCount') && !source.includes('isMeasurementBank') &&
    !source.includes('this.sidebar') && !source.includes('persistWorkspace') &&
    !source.includes('analogGroup');
  const displayWidthGate = gateBody.replace(shared,
    'const width = this.displayChannelCount();\n' +
      '    return this.busViews.some((bus) => isMeasurementBank(bus, width));');
  const pendingWidth = gateBody.replace('this.captureStore.channelCount',
    'this.displayChannelCount()');
  check('the gate is the same measurementSources expression over the same width as the source list',
    gateBody.length > 0 && sharedExpression(gateBody) &&
      app.includes('analogScopeActive: this.analogScopeActive(),') &&
      appView.includes('analogScopeActive: this.analogScopeActive(),') &&
      panel.includes('analogScopeActive: boolean;') &&
      !app.includes('analogScopeActive =') && !app.includes('private analogScopeActive: boolean'),
    `body=${gateBody.length} chars, shared=${sharedExpression(gateBody)}, ` +
      `view=${app.includes('analogScopeActive: this.analogScopeActive(),')}; red only if ` +
      'displayChannelCount (pending/idle width) and captureStore.channelCount (on-screen wave) ' +
      'diverge: a narrowed pending width while a capture runs, or a widened idle width after a ' +
      'finished narrower wave');

  check('the retired display-width gate and a bare display-width swap both fail that expression',
    displayWidthGate !== gateBody && !sharedExpression(displayWidthGate) &&
      pendingWidth !== gateBody && !sharedExpression(pendingWidth),
    `retired=${sharedExpression(displayWidthGate)}, pendingWidth=${sharedExpression(pendingWidth)}`);
}

{
  const clock = 'if (this.running && this.measurePageShown() && this.analogScopeActive()) {';
  const stopped = 'if (forced && !this.running && this.measurePageShown() && this.analogScopeActive()) {';
  const pumpLine = 'if (!this.measurePageShown() || !this.analogScopeActive()) return;';
  const submission =
    "const visible = this.measurePageShown() && this.analogScopeActive() && this.viewMode === 'time';";
  const pump = slice(app, 'private pumpMeasurementCapture(): void {', 'private withMeasurementRows(');
  const record = slice(app, 'private recordMeasurementWave(reason: CaptureStopReason): void {',
    'private measurementView(): MeasurementSectionView {');
  const persistence = slice(app, 'private submitPersistenceWave(reason: CaptureStopReason): void {',
    'private clearPersistence(');
  const once = (source: string, needle: string): boolean =>
    needle.length > 0 && source.split(needle).length - 1 === 1;
  const gatedPersistence = persistence.replace('const commit = shouldCommitPersistence({',
    'if (!this.analogScopeActive()) return;\n    const commit = shouldCommitPersistence({');
  const calls = app.split('this.analogScopeActive()').length - 1;
  check('all four measurement clocks and jobs short-circuit on the same gate',
    once(frame, clock) && once(frame, stopped) && once(pump, pumpLine) &&
      once(record, submission) && calls === 5,
    `clock=${once(frame, clock)}, stopped=${once(frame, stopped)}, ` +
      `pump=${once(pump, pumpLine)}, record=${once(record, submission)}, calls=${calls}`);

  const ungated = (needle: string): string => needle
    .replace(' && this.analogScopeActive()', '')
    .replace(' || !this.analogScopeActive()', '');
  const gated = [clock, stopped, pumpLine, submission];
  const gateIsTheDiff = gated.every((needle) => {
    const bare = ungated(needle);
    return bare !== needle && !bare.includes('analogScopeActive');
  });
  check('the gate is the only difference at each site, and persistence carries none',
    gateIsTheDiff && !persistence.includes('analogScopeActive') &&
      gatedPersistence.includes('this.analogScopeActive()'),
    `diff=${gateIsTheDiff}, persistence=${persistence.includes('analogScopeActive')}, ` +
      `gatedPersistence=${gatedPersistence.includes('this.analogScopeActive()')}`);
}

{
  const bank = (over: {
    analogGroup?: number; bits?: readonly number[];
  } = {}): { name: string; analogGroup?: number; spec: { bits: readonly number[] } } => ({
    name: 'A0',
    analogGroup: 0,
    spec: { bits: over.bits ?? [7, 6, 5, 4, 3, 2, 1, 0] },
    ...over,
  });
  const valid = bank();
  const outOfRange = bank({ analogGroup: 4 });
  const ascending = bank({ bits: [0, 1, 2, 3, 4, 5, 6, 7] });
  const sevenBit = bank({ bits: [7, 6, 5, 4, 3, 2, 1] });
  const second = bank({ analogGroup: 2, bits: [23, 22, 21, 20, 19, 18, 17, 16] });
  const plain: { name: string; spec: { bits: readonly number[] } } = {
    name: 'D0-D7', spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7] },
  };
  const gate = (width: number, ...buses: readonly { name: string; analogGroup?: number;
    spec: { bits: readonly number[] } }[]): boolean =>
    buses.some((bus) => isMeasurementBank(bus, width));
  check('the gate opens on a canonical ADC bank and stays shut on a foreign, reversed or short one',
    gate(32, valid) && gate(32, second) && gate(32, plain, valid) &&
      !gate(32, outOfRange) && !gate(32, ascending) && !gate(32, sevenBit) && !gate(32, plain) &&
      !gate(7, valid) && !gate(16, second),
    `valid=${gate(32, valid)}, second=${gate(32, second)}, mixed=${gate(32, plain, valid)}, ` +
      `outOfRange=${gate(32, outOfRange)}, ascending=${gate(32, ascending)}, ` +
      `short=${gate(32, sevenBit)}, plain=${gate(32, plain)}, ` +
      `narrow=${gate(7, valid)}, tier=${gate(16, second)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
