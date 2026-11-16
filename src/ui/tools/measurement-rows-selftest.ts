// SPDX-License-Identifier: GPL-3.0-or-later

import {
  MEASUREMENT_CATALOG, MEASUREMENT_DEFAULT_PARAMETERS, MEASUREMENT_PARAMETERS, catalogEntry,
  isMeasurementParameter, measurementGroup, measurementUnit, type MeasurementParameter,
} from '../measurementCatalog.js';
import {
  MEASUREMENT_MAX_ROWS, addMeasurementRow, availableMeasurementParameters, clearMeasurementRows,
  emptyMeasurementRows, measurementRowKey, pruneMeasurementRows, removeMeasurementRow,
  setMeasurementFilter, toggleMeasurementRow, undoClearMeasurementRows, visibleMeasurementRows,
  type MeasurementRow, type MeasurementRowState,
} from '../measurementRows.js';

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

const keys = (rows: readonly MeasurementRow[]): string => rows.map(measurementRowKey).join(',');
const ids = (rows: readonly MeasurementRow[]): string => rows.map((row) => String(row.id)).join(',');

function seeded(): MeasurementRowState {
  const mean = addMeasurementRow(emptyMeasurementRows(), 16, 'mean');
  const vpp = addMeasurementRow(mean, 0, 'vpp');
  return addMeasurementRow(vpp, 16, 'duty');
}

{
  const expected = [
    ['vpp', 'vertical', 'v', 'capturePanel.measureVpp', 'capturePanel.measureMethodVpp'],
    ['max', 'vertical', 'v', 'capturePanel.measureMax', 'capturePanel.measureMethodMax'],
    ['min', 'vertical', 'v', 'capturePanel.measureMin', 'capturePanel.measureMethodMin'],
    ['mean', 'vertical', 'v', 'capturePanel.measureMean', 'capturePanel.measureMethodMean'],
    ['rms', 'vertical', 'v', 'capturePanel.measureRms', 'capturePanel.measureMethodRms'],
    ['frequency', 'horizontal', 'hz',
      'capturePanel.measureFrequency', 'capturePanel.measureMethodFrequency'],
    ['period', 'horizontal', 's', 'capturePanel.measurePeriod', 'capturePanel.measureMethodPeriod'],
    ['duty', 'horizontal', '%', 'capturePanel.measureDuty', 'capturePanel.measureMethodDuty'],
  ];
  const actual = MEASUREMENT_CATALOG.map((entry) => [
    entry.parameter, entry.group, entry.unit, entry.labelKey, entry.methodKey,
  ]);
  check('the catalog lists eight parameters in display order with group, unit and key pair',
    JSON.stringify(actual) === JSON.stringify(expected) &&
      MEASUREMENT_CATALOG.length === 8,
    JSON.stringify(actual));
}

{
  const vertical = MEASUREMENT_CATALOG.filter((e) => e.group === 'vertical').map((e) => e.parameter);
  check('the parameters derive from the catalog order with five vertical then three horizontal rows',
    MEASUREMENT_PARAMETERS.join(',') === 'vpp,max,min,mean,rms,frequency,period,duty' &&
      MEASUREMENT_PARAMETERS.length === MEASUREMENT_CATALOG.length &&
      vertical.join(',') === 'vpp,max,min,mean,rms' &&
      MEASUREMENT_DEFAULT_PARAMETERS.join(',') === 'frequency,vpp,rms' &&
      MEASUREMENT_DEFAULT_PARAMETERS.every((parameter) =>
        MEASUREMENT_PARAMETERS.includes(parameter)),
    `parameters=${MEASUREMENT_PARAMETERS.join(',')}, vertical=${vertical.join(',')}, ` +
      `default=${MEASUREMENT_DEFAULT_PARAMETERS.join(',')}`);
}

{
  const unitOf = MEASUREMENT_PARAMETERS.map((parameter) => measurementUnit(parameter)).join('');
  const groupOf = MEASUREMENT_PARAMETERS.map((parameter) => measurementGroup(parameter)).join(',');
  check('unit and group helpers answer from the one catalog entry per parameter',
    unitOf === 'vvvvvhzs%' &&
      groupOf === 'vertical,vertical,vertical,vertical,vertical,horizontal,horizontal,horizontal' &&
      catalogEntry('duty').unit === '%' && catalogEntry('period').unit === 's' &&
      catalogEntry('frequency').unit === 'hz' &&
      measurementUnit('rms') === 'v' && measurementGroup('max') === 'vertical',
    `units=${unitOf}, groups=${groupOf}`);
}

{
  const failures: string[] = [];
  for (const parameter of ['vpp', 'max', 'min', 'mean', 'rms', 'frequency', 'period', 'duty']) {
    try {
      catalogEntry(parameter as MeasurementParameter);
    } catch (error) {
      failures.push(`threw for ${parameter}: ${String(error)}`);
    }
  }
  const rejects = (value: MeasurementParameter): boolean => {
    try {
      catalogEntry(value);
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  };
  const aliases: string[] = ['', 'Vpp', 'vrms', 'dutyCycle', 'period '];
  check('an unknown parameter raises RangeError and the guard rejects only exact names',
    failures.length === 0 && rejects('bogus' as MeasurementParameter) &&
      rejects('' as MeasurementParameter) && rejects('Vpp' as MeasurementParameter) &&
      aliases.every((value) => !isMeasurementParameter(value)) &&
      MEASUREMENT_PARAMETERS.every((value) => isMeasurementParameter(value)) &&
      !isMeasurementParameter('RMS') && !isMeasurementParameter('frequency '),
    `throws=${failures.length === 0}, aliases=${JSON.stringify(aliases)}`);
}

{
  const empty = emptyMeasurementRows();
  check('an empty row state starts at id 1 with no filter and no undo snapshot',
    empty.rows.length === 0 && empty.nextId === 1 && empty.filter === null && empty.undo === null &&
      MEASUREMENT_MAX_ROWS === 64,
    `nextId=${empty.nextId}, filter=${String(empty.filter)}, undo=${String(empty.undo)}, ` +
      `max=${MEASUREMENT_MAX_ROWS}`);
}

{
  const empty = emptyMeasurementRows();
  const one = addMeasurementRow(empty, 0, 'vpp');
  const duplicate = addMeasurementRow(one, 0, 'vpp');
  const sameParameterOtherSource = addMeasurementRow(one, 8, 'vpp');
  check('a duplicate add is a same-reference no-op that does not advance nextId',
    duplicate === one && one !== empty && empty.rows.length === 0 &&
      one.rows.length === 1 && one.rows[0].id === 1 && one.rows[0].start === 0 &&
      one.rows[0].parameter === 'vpp' && one.nextId === 2 &&
      sameParameterOtherSource.rows.length === 2 &&
      sameParameterOtherSource.rows[1].id === 2 && sameParameterOtherSource.nextId === 3,
    `dupSame=${duplicate === one}, ids=${ids(one.rows)}, next=${one.nextId}`);

  const removed = removeMeasurementRow(one, 1);
  const readded = addMeasurementRow(removed, 0, 'vpp');
  check('removing then re-adding the same slot takes a fresh monotonic id and appends last',
    removed.rows.length === 0 && readded.rows.length === 1 && readded.rows[0].id === 2 &&
      readded.nextId === 3,
    `removedIds=${ids(removed.rows)}, readdedIds=${ids(readded.rows)}, next=${readded.nextId}`);
}

{
  const state = seeded();
  const toggledOnce = toggleMeasurementRow(state, 0, 'vpp');
  const toggledTwice = toggleMeasurementRow(toggledOnce, 0, 'vpp');
  const toggleNewSource = toggleMeasurementRow(state, 8, 'rms');
  check('toggle removes the matching source row only, and adds it back at the end',
    keys(state.rows) === '16:mean,0:vpp,16:duty' &&
      keys(toggledOnce.rows) === '16:mean,16:duty' && ids(toggledOnce.rows) === '1,3' &&
      keys(toggledTwice.rows) === '16:mean,16:duty,0:vpp' &&
      ids(toggledTwice.rows) === '1,3,4' && toggledTwice.nextId === 5 &&
      keys(toggleNewSource.rows) === '16:mean,0:vpp,16:duty,8:rms' &&
      ids(toggleNewSource.rows) === '1,2,3,4',
    `state=${keys(state.rows)}, once=${keys(toggledOnce.rows)}, twice=${keys(toggledTwice.rows)}, ` +
      `newSource=${keys(toggleNewSource.rows)}`);
}

{
  const state = seeded();
  const unknownId = removeMeasurementRow(state, 99);
  const dropForeign = removeMeasurementRow(state, 2);
  const dropLastOfFilter = removeMeasurementRow(setMeasurementFilter(state, 0), 2);
  const dropOneOfFiltered = removeMeasurementRow(setMeasurementFilter(state, 16), 3);
  check('removal of an unknown id is a no-op and a vanished filtered source falls back to All',
    unknownId === state && keys(dropForeign.rows) === '16:mean,16:duty' &&
      dropForeign.filter === null &&
      keys(dropLastOfFilter.rows) === '16:mean,16:duty' &&
      dropLastOfFilter.filter === null && dropLastOfFilter.nextId === state.nextId &&
      keys(dropOneOfFiltered.rows) === '16:mean,0:vpp' && dropOneOfFiltered.filter === 16,
    `unknownSame=${unknownId === state}, foreign=${keys(dropForeign.rows)}, ` +
      `lastOfFilter=${keys(dropLastOfFilter.rows)} filter=${String(dropLastOfFilter.filter)}, ` +
      `oneOfFiltered=${keys(dropOneOfFiltered.rows)} filter=${String(dropOneOfFiltered.filter)}`);

  const kept = removeMeasurementRow(setMeasurementFilter(state, 0), 1);
  const stillThere = removeMeasurementRow(kept, 3);
  check('removing a row of another source keeps the filtered source and its rows',
    kept.filter === 0 && keys(kept.rows) === '0:vpp,16:duty' &&
      stillThere.filter === 0 && keys(stillThere.rows) === '0:vpp' &&
      stillThere.rows[0].id === 2,
    `keptFilter=${String(kept.filter)}, kept=${keys(kept.rows)}, ` +
      `stillThereFilter=${String(stillThere.filter)}, rows=${keys(stillThere.rows)}`);
}

{
  const state = seeded();
  const cleared = clearMeasurementRows(state);
  const clearedAgain = clearMeasurementRows(cleared);
  check('clear empties rows and filter while keeping nextId and one undo snapshot',
    cleared.rows.length === 0 && cleared.filter === null && cleared.nextId === 4 &&
      cleared.undo !== null && keys(cleared.undo.rows) === '16:mean,0:vpp,16:duty' &&
      cleared.undo.nextId === 4 && clearedAgain === cleared &&
      clearedAgain.undo === cleared.undo,
    `rows=${cleared.rows.length}, next=${cleared.nextId}, ` +
      `undo=${cleared.undo === null ? 'null' : keys(cleared.undo.rows)}, ` +
      `emptyClearSame=${clearedAgain === cleared}`);

  const restored = undoClearMeasurementRows(cleared);
  const restoredAgain = undoClearMeasurementRows(restored);
  const emptyState = emptyMeasurementRows();
  check('undo restores the exact row order and nextId once, then clears the snapshot',
    keys(restored.rows) === '16:mean,0:vpp,16:duty' && ids(restored.rows) === '1,2,3' &&
      restored.nextId === 4 && restored.undo === null && restoredAgain === restored &&
      undoClearMeasurementRows(state) === state &&
      undoClearMeasurementRows(emptyState) === emptyState,
    `rows=${keys(restored.rows)}, ids=${ids(restored.rows)}, next=${restored.nextId}, ` +
      `undo=${String(restored.undo)}, secondUndoSame=${restoredAgain === restored}`);

  const afterAdd = addMeasurementRow(cleared, 0, 'min');
  const afterUndo = undoClearMeasurementRows(afterAdd);
  check('any add after clear discards the snapshot so undo is a same-reference no-op',
    afterAdd.undo === null && afterUndo === afterAdd &&
      keys(afterAdd.rows) === '0:min' && afterAdd.rows[0].id === 4,
    `undo=${String(afterAdd.undo)}, rows=${keys(afterAdd.rows)}, undoAfterAddSame=${afterUndo === afterAdd}`);

  const reCleared = clearMeasurementRows(restored);
  const restoredTwice = undoClearMeasurementRows(reCleared);
  check('a second clear over non-empty rows replaces the snapshot instead of stacking',
    reCleared.undo !== null && reCleared.undo.rows === restored.rows &&
      keys(restoredTwice.rows) === '16:mean,0:vpp,16:duty' && restoredTwice.undo === null,
    `snapshot=${reCleared.undo === null ? 'null' : keys(reCleared.undo.rows)}, ` +
      `restored=${keys(restoredTwice.rows)}`);
}

{
  const state = seeded();
  const untouched = pruneMeasurementRows(state, [0, 16]);
  const pruned = pruneMeasurementRows(setMeasurementFilter(state, 16), [0]);
  const keptFilter = pruneMeasurementRows(setMeasurementFilter(state, 0), [0]);
  const withUndo: MeasurementRowState = {
    rows: state.rows, nextId: 4, filter: 16, undo: { rows: [], nextId: 4 },
  };
  const undoKept = pruneMeasurementRows(withUndo, [0]);
  check('prune keeps order and nextId, drops dead sources and neutralises a stale filter',
    untouched === state && keys(pruned.rows) === '0:vpp' && ids(pruned.rows) === '2' &&
      pruned.nextId === 4 && pruned.filter === null && pruned.undo === null &&
      keys(keptFilter.rows) === '0:vpp' && keptFilter.filter === 0,
    `untouchedSame=${untouched === state}, pruned=${keys(pruned.rows)}, ` +
      `filter=${String(pruned.filter)}, keptFilter=${String(keptFilter.filter)}`);

  check('prune keeps an undo snapshot whose every source survives',
    undoKept !== withUndo && undoKept.undo === withUndo.undo &&
      keys(undoKept.rows) === '0:vpp' && undoKept.filter === null &&
      undoKept.nextId === withUndo.nextId,
    `sameUndo=${undoKept.undo === withUndo.undo}, filter=${String(undoKept.filter)}`);

  const snapshotWithDeadSource: MeasurementRowState = {
    rows: state.rows.filter((row) => row.start === 0), nextId: 4, filter: 0,
    undo: { rows: state.rows, nextId: 4 },
  };
  const undoDropped = pruneMeasurementRows(snapshotWithDeadSource, [0]);
  check('prune drops an undo snapshot that references a removed source, even with rows intact',
    keys(undoDropped.rows) === '0:vpp' && undoDropped.undo === null &&
      undoDropped.filter === 0 && undoDropped !== snapshotWithDeadSource &&
      undoClearMeasurementRows(undoDropped) === undoDropped,
    `rows=${keys(undoDropped.rows)}, undo=${String(undoDropped.undo)}, ` +
      `filter=${String(undoDropped.filter)}`);

  const cleared = clearMeasurementRows(state);
  const sourceRemoved = pruneMeasurementRows(cleared, [0]);
  const undoneAfterRemoval = undoClearMeasurementRows(sourceRemoved);
  check('clear then remove a source leaves no undo that restores the dead source row',
    cleared.undo !== null && sourceRemoved.undo === null &&
      undoneAfterRemoval === sourceRemoved && undoneAfterRemoval.rows.length === 0 &&
      pruneMeasurementRows(cleared, [0, 16]) === cleared &&
      keys(undoClearMeasurementRows(cleared).rows) === '16:mean,0:vpp,16:duty',
    `undoAfterRemoval=${String(sourceRemoved.undo)}, ` +
      `rows=${keys(undoneAfterRemoval.rows)}, ` +
      `survivingPruneSame=${pruneMeasurementRows(cleared, [0, 16]) === cleared}`);
}

{
  const state = seeded();
  const filtered = setMeasurementFilter(state, 16);
  const cleared = setMeasurementFilter(filtered, null);
  const visibleAll = visibleMeasurementRows(state);
  const visible16 = visibleMeasurementRows(filtered);
  const visibleNone = visibleMeasurementRows(setMeasurementFilter(state, 24));
  check('the filter changes display only and never touches rows, ids, nextId or undo',
    filtered.filter === 16 && filtered.rows === state.rows && filtered.nextId === state.nextId &&
      filtered.undo === state.undo && setMeasurementFilter(filtered, 16) === filtered &&
      cleared.filter === null && cleared.rows === state.rows &&
      setMeasurementFilter(state, -1) === state && setMeasurementFilter(state, 1.5) === state &&
      setMeasurementFilter(state, Number.NaN) === state,
    `filter=${String(filtered.filter)}, rowsSame=${filtered.rows === state.rows}, ` +
      `sameFilterSame=${setMeasurementFilter(filtered, 16) === filtered}`);

  check('visibility follows the filter without reordering or copying the unfiltered list',
    visibleAll === state.rows && keys(visibleAll) === '16:mean,0:vpp,16:duty' &&
      keys(visible16) === '16:mean,16:duty' && ids(visible16) === '1,3' &&
      visibleNone.length === 0,
    `all=${keys(visibleAll)}, filtered=${keys(visible16)}, none=${visibleNone.length}`);
}

{
  const state = seeded();
  const all = availableMeasurementParameters(emptyMeasurementRows(), 0);
  const at0 = availableMeasurementParameters(state, 0);
  const at16 = availableMeasurementParameters(state, 16);
  const unknownStart = availableMeasurementParameters(state, 24);
  check('available parameters are the catalog order minus the rows already added for a source',
    all.join(',') === MEASUREMENT_PARAMETERS.join(',') &&
      at0.join(',') === 'max,min,mean,rms,frequency,period,duty' &&
      at16.join(',') === 'vpp,max,min,rms,frequency,period' &&
      unknownStart.join(',') === MEASUREMENT_PARAMETERS.join(','),
    `all=${all.length}, at0=${at0.join(',')}, at16=${at16.join(',')}`);
}

{
  const empty = emptyMeasurementRows();
  const invalidStarts: number[] = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1];
  const rejected = invalidStarts.every((start) => addMeasurementRow(empty, start, 'vpp') === empty);
  const badParameter = addMeasurementRow(empty, 0, 'bogus' as MeasurementParameter);
  check('add rejects non-integer, negative, unsafe starts and unknown parameters',
    rejected && badParameter === empty && empty.rows.length === 0 && empty.nextId === 1,
    `rejected=${rejected}, badParameterSame=${badParameter === empty}`);
}

{
  let state = emptyMeasurementRows();
  for (let group = 0; group < 8; group++) {
    for (const parameter of MEASUREMENT_PARAMETERS) {
      state = addMeasurementRow(state, group * 8, parameter);
    }
  }
  const atCap = state;
  const overCap = addMeasurementRow(atCap, 64, 'vpp');
  check('exactly 64 rows are accepted and the cap refuses further rows without sliding or reuse',
    atCap.rows.length === MEASUREMENT_MAX_ROWS && atCap.rows.length === 64 &&
      atCap.nextId === 65 && atCap.rows[63].id === 64 &&
      measurementRowKey(atCap.rows[63]) === '56:duty' &&
      overCap === atCap && atCap.rows.filter((row) => row.id === 1).length === 1,
    `rows=${atCap.rows.length}, next=${atCap.nextId}, last=${measurementRowKey(atCap.rows[63])}, ` +
      `overCapSame=${overCap === atCap}`);
}

{
  const state = seeded();
  const before = JSON.stringify(state);
  const rowRef = state.rows[0];
  addMeasurementRow(state, 8, 'rms');
  toggleMeasurementRow(state, 0, 'vpp');
  toggleMeasurementRow(state, 24, 'min');
  removeMeasurementRow(state, 2);
  setMeasurementFilter(state, 16);
  pruneMeasurementRows(state, [0]);
  const cleared = clearMeasurementRows(state);
  const restored = undoClearMeasurementRows(cleared);
  check('reducers never mutate their input rows array or row objects',
    JSON.stringify(state) === before && state.rows[0] === rowRef &&
      state.rows.length === 3 && state.nextId === 4 && restored.rows === state.rows,
    `unchanged=${JSON.stringify(state) === before}, rows=${state.rows.length}, ` +
      `next=${state.nextId}, restoredSameRows=${restored.rows === state.rows}`);

  const emptyState = emptyMeasurementRows();
  const filtered16 = setMeasurementFilter(state, 16);
  const noopSame = {
    addDuplicateOrInvalid: addMeasurementRow(state, 0, 'vpp') === state &&
      addMeasurementRow(state, 0, 'bogus' as MeasurementParameter) === state &&
      addMeasurementRow(state, -1, 'vpp') === state,
    removeUnknown: removeMeasurementRow(state, 42) === state,
    clearEmpty: clearMeasurementRows(emptyState) === emptyState,
    undoWithoutSnapshot: undoClearMeasurementRows(state) === state &&
      undoClearMeasurementRows(emptyState) === emptyState,
    pruneAllValid: pruneMeasurementRows(state, [0, 16]) === state,
    sameOrInvalidFilter: setMeasurementFilter(filtered16, 16) === filtered16 &&
      setMeasurementFilter(state, null) === state &&
      setMeasurementFilter(state, -1) === state,
  };
  check('every documented no-op path returns the same state reference',
    Object.values(noopSame).every(Boolean) && filtered16 !== state &&
      toggleMeasurementRow(state, 8, 'rms') !== state &&
      setMeasurementFilter(state, 8) !== state,
    JSON.stringify(noopSame));
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
