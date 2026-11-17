// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../../data/adcTraceFiles.js';
import { createSampleStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import { scanAnalogCodes, type AnalogCodeScan } from '../../dsp/analogScan.js';
import { ADC_ZERO_CODE, analogBusConfig, analogVoltsPerCode } from '../channelBanks.js';
import { MEASUREMENT_DEFAULT_PARAMETERS, measurementUnit } from '../measurementCatalog.js';
import {
  addMeasurementRow, clearMeasurementRows, emptyMeasurementRows, removeMeasurementRow,
  setMeasurementFilter, undoClearMeasurementRows, visibleMeasurementRows,
  type MeasurementRow,
} from '../measurementRows.js';
import {
  MEASURE_TIER_DEFAULT, basicMeasurementView, defaultMeasurementConfig, isMeasurementBank,
  measurementAddStart, measurementCacheKey, measurementRangeKind, measurementRowEligible,
  measurementRowSettled, measurementRowViews, measurementSectionCounts, measurementSources,
  measurementWaveValue, reconcileMeasurementConfig, resolveMeasurementWindow, runMeasurement,
  selectMeasurementFilter, selectMeasurementRange,
  type MeasurementBusView, type MeasurementCacheInput, type MeasurementConfig,
  type MeasurementCursor, type MeasurementRangeKind, type MeasurementReadSummary,
  type MeasurementRowView, type MeasurementSectionView, type MeasurementSource,
  type MeasurementSourceResult, type MeasurementStatus, type MeasurementWindow,
  type MeasureTier,
} from '../measurementState.js';
import {
  accumulateSample, emptyAccumulator, excludeSample, measurementStatsView,
  retainMeasurementStats, type MeasurementAccumulator, type MeasurementStatsState,
  type MeasurementStatsView,
} from '../measurementStats.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const A0: MeasurementSource = { group: 0, start: 0, gain: 1, name: 'A0' };
const A2: MeasurementSource = { group: 2, start: 16, gain: 3, name: 'A2' };
const VIEWPORT: MeasurementWindow = { start: 0, end: 100 };
const LSB = analogVoltsPerCode(1);

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const workspaceSource = fs.readFileSync('src/ui/workspacePreferences.ts', 'utf8');

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  return start < 0 || end <= start ? '' : text.slice(start, end);
}

function bank(group: number, gain?: number): MeasurementBusView {
  return {
    name: `A${group}`,
    analogGroup: group,
    ...(gain === undefined ? {} : { analogGain: gain }),
    spec: { bits: Array.from({ length: 8 }, (_, k) => group * 8 + 7 - k) },
  };
}

function rowList(config: MeasurementConfig): MeasurementRow[] {
  return [...visibleMeasurementRows(config.rows)];
}

function rowRefs(config: MeasurementConfig): string {
  return visibleMeasurementRows(config.rows)
    .map((row) => `${row.id}:${row.start}:${row.parameter}`).join(',');
}

function scanFixture(over: Partial<AnalogCodeScan> = {}): AnalogCodeScan {
  return {
    analyzed: 1000,
    known: 1000,
    unknown: 0,
    minCode: 84,
    maxCode: 255,
    vppCodes: 171,
    vppVolts: 21.4588,
    minVolts: -5.4,
    maxVolts: 16.0,
    meanOffsetCodes: 1.5,
    meanVolts: 0.18825,
    rmsOffsetCodes: 32.6668,
    rmsVolts: 4.09936,
    crossingCount: 30,
    crossingCap: false,
    firstCrossing: 10,
    lastCrossing: 290010,
    periodSamples: 10000.4,
    periodSeconds: 1.00004e-4,
    frequencyHz: 9999.5877,
    dutyPercent: 42.5,
    dutyPeriods: 12,
    dutyExcludedPeriods: 3,
    dutyKnownSamples: 900,
    dutyHighSamples: 400,
    status: 'ok',
    clippedLow: false,
    clippedHigh: false,
    nearSampleLimit: false,
    ...over,
  };
}

function readFixture(over: Partial<MeasurementReadSummary> = {}): MeasurementReadSummary {
  return {
    analyzed: 1000, requestedSamples: 1000, truncated: false, rangeClipped: false,
    unknownSamples: 0, ...over,
  };
}

function resultFor(
  source: MeasurementSource, scan: AnalogCodeScan | null, read: MeasurementReadSummary | null,
  unavailable: MeasurementStatus | null = null,
): MeasurementSourceResult {
  return { source, scan, read, unavailable };
}

{
  const a0 = bank(0);
  const a2 = bank(2, 3);
  const duplicate = bank(0, 10);
  const ascending = { ...bank(0), spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7] } };
  const short = { ...bank(0), spec: { bits: [7, 6, 5, 4, 3, 2, 1] } };
  const wide = { ...bank(0), spec: { bits: [8, 7, 6, 5, 4, 3, 2, 1] } };
  const foreign = { ...bank(0), analogGroup: 4 };
  const negative = { ...bank(0), analogGroup: -1 };
  const fractional = { ...bank(0), analogGroup: 0.5 };
  const plain = { name: 'SPI', spec: { bits: [7, 6, 5, 4, 3, 2, 1, 0] } };
  const misplaced = { ...bank(2), spec: { bits: [7, 6, 5, 4, 3, 2, 1, 0] } };
  check('only a canonical eight-bit in-width bank is a measurement source',
    isMeasurementBank(a0, 32) && isMeasurementBank(a2, 32) &&
      !isMeasurementBank(ascending, 32) && !isMeasurementBank(short, 32) &&
      !isMeasurementBank(wide, 32) && !isMeasurementBank(foreign, 32) &&
      !isMeasurementBank(negative, 32) && !isMeasurementBank(fractional, 32) &&
      !isMeasurementBank(plain, 32) && !isMeasurementBank(misplaced, 16) &&
      !isMeasurementBank(a2, 16) && !isMeasurementBank(a0, 7),
    `a0=${isMeasurementBank(a0, 32)}, a2=${isMeasurementBank(a2, 32)}, ` +
      `ascending=${isMeasurementBank(ascending, 32)}, short=${isMeasurementBank(short, 32)}, ` +
      `wide=${isMeasurementBank(wide, 32)}, foreign=${isMeasurementBank(foreign, 32)}, ` +
      `fractional=${isMeasurementBank(fractional, 32)}, misplaced16=${isMeasurementBank(misplaced, 16)}`);
  const sources = measurementSources(
    [wide, short, plain, ascending, foreign, negative, fractional, a2, duplicate, a0], 32);
  const hiddenBank: MeasurementBusView & { hideSources: boolean; enabled: boolean } =
    { ...a0, hideSources: true, enabled: false };
  check('sources are sorted and de-duplicated with the group start and declared gain',
    sources.length === 2 && sources[0]!.group === 0 && sources[0]!.start === 0 &&
      sources[0]!.gain === 10 && sources[0]!.name === 'A0' &&
      sources[1]!.group === 2 && sources[1]!.start === 16 && sources[1]!.gain === 3 &&
      measurementSources([a0, duplicate], 32)[0]!.gain === 1 &&
      measurementSources([bank(1)], 16).length === 1 &&
      measurementSources([bank(2)], 16).length === 0 &&
      measurementSources([bank(0, 0)], 32)[0]?.gain === 1 &&
      measurementSources([hiddenBank], 32).length === 1,
    sources.map((s) => `${s.group}:${s.start}:${s.gain}:${s.name}`).join(', '));

  const colored = measurementSources(
    [{ ...bank(0), color: '#1f77b4' }, { ...bank(2), color: '#2ca02c' }], 32, 0);
  const unfocused = measurementSources([{ ...bank(0), color: '#1f77b4' }, bank(2)], 32);
  check('each source carries its bus colour and the bank the section focuses',
    colored[0]!.color === '#1f77b4' && colored[0]!.focused === true &&
      colored[1]!.color === '#2ca02c' && colored[1]!.focused === false &&
      unfocused[0]!.focused === false && unfocused[0]!.color === '#1f77b4' &&
      unfocused[1]!.color === '' &&
      measurementSources([bank(0)], 32, 8)[0]!.focused === false,
    colored.map((s) => `${s.start}:${s.color}:${s.focused}`).join(', '));
}

{
  const all = defaultMeasurementConfig([A2, A0]);
  const none = defaultMeasurementConfig([]);
  check('the default config seeds the lowest source with the three default rows and All filter',
    all.rows.filter === null && all.range.kind === 'capture' &&
      all.range.a === null && all.range.b === null &&
      rowRefs(all) === '1:0:frequency,2:0:vpp,3:0:rms' &&
      all.rows.nextId === 4 && all.rows.undo === null &&
      none.rows.rows.length === 0 && none.rows.nextId === 1 && none.rows.filter === null &&
      MEASUREMENT_DEFAULT_PARAMETERS.join(',') === 'frequency,vpp,rms',
    `rows=${rowRefs(all)}, empty=${none.rows.rows.length}, ` +
      `default=${MEASUREMENT_DEFAULT_PARAMETERS.join(',')}`);
}

{
  const clean = defaultMeasurementConfig([A2, A0]);
  const same = reconcileMeasurementConfig(clean, [A0, A2]);
  const copy = { range: clean.range, rows: clean.rows };
  const missing = reconcileMeasurementConfig(clean, [A2]);
  check('reconcile keeps a config whose rows and range are all live, by reference',
    same === clean && reconcileMeasurementConfig(copy, [A0, A2]) === copy &&
      copy !== clean && copy.rows === clean.rows,
    `same=${same === clean}, copy=${reconcileMeasurementConfig(copy, [A0, A2]) === copy}`);
  check('reconcile prunes rows of a vanished source and neutralises its filter',
    missing.rows.rows.length === 0 && missing.rows.filter === null &&
      missing.rows.nextId === 4 && missing !== clean,
    `rows=${missing.rows.rows.length}, filter=${String(missing.rows.filter)}, ` +
      `nextId=${missing.rows.nextId}`);
  const filtered = selectMeasurementFilter(clean, [A0, A2], 16);
  const kept = reconcileMeasurementConfig(filtered, [A0, A2]);
  const gone = reconcileMeasurementConfig(filtered, [A0]);
  check('a filter on a live source survives reconcile and follows the source when it leaves',
    kept === filtered && filtered.rows.filter === 16 &&
      gone.rows.filter === null && gone.rows.rows.length === 3,
    `kept=${kept === filtered}, filter=${String(filtered.rows.filter)}, ` +
      `gone=${String(gone.rows.filter)}`);
  const normalized = reconcileMeasurementConfig({
    ...clean, range: { kind: 'cursors' as const, a: Number.NaN, b: 4 },
  }, [A0, A2]);
  const stable = reconcileMeasurementConfig(normalized, [A0, A2]);
  check('reconcile normalizes the range once and is idempotent afterwards',
    normalized.range.a === null && normalized.range.b === 4 &&
      normalized.range.kind === 'cursors' && stable === normalized,
    `range=${JSON.stringify(normalized.range)}, stable=${stable === normalized}`);
}

{
  const base = defaultMeasurementConfig([A0, A2]);
  const picked = selectMeasurementFilter(base, [A0, A2], 16);
  const again = selectMeasurementFilter(picked, [A0, A2], 16);
  const unknown = selectMeasurementFilter(picked, [A0, A2], 7);
  const missing = selectMeasurementFilter(base, [], 0);
  const cleared = selectMeasurementFilter(picked, [A0, A2], null);
  check('the filter validates against the enumerated source starts and All is null',
    base.rows.filter === null && picked.rows.filter === 16 && picked !== base &&
      again === picked && unknown.rows.filter === null && missing.rows.filter === null &&
      cleared !== base && cleared.rows.filter === null &&
      selectMeasurementFilter(cleared, [A0, A2], null) === cleared,
    `picked=${String(picked.rows.filter)}, unknown=${String(unknown.rows.filter)}, ` +
      `missing=${String(missing.rows.filter)}, cleared=${String(cleared.rows.filter)}`);
  const two = selectMeasurementFilter(base, [A0, A2], 16);
  check('All exposes every row in row order while a source filter exposes only its rows',
    rowRefs(base) === '1:0:frequency,2:0:vpp,3:0:rms' &&
      rowRefs(two) === '' && rowList(base).length === 3 &&
      visibleMeasurementRows({ ...base.rows, filter: 0 }).length === 3,
    `all=${rowRefs(base)}, filtered=${rowRefs(two)}`);
}

{
  const base = defaultMeasurementConfig([A0]);
  const cursors = selectMeasurementRange(base, { kind: 'cursors', a: 2, b: null });
  const repeat = selectMeasurementRange(cursors, { kind: 'cursors', a: 2, b: null });
  const cleaned = selectMeasurementRange(base, {
    kind: 'cursors', a: Number.NaN, b: Number.POSITIVE_INFINITY,
  });
  const viewport = selectMeasurementRange(cursors, { kind: 'viewport', a: 2, b: 6 });
  check('the range reducer normalizes its endpoints and is idempotent',
    cursors !== base && cursors.range.kind === 'cursors' && cursors.range.a === 2 &&
      cursors.range.b === null && base.range.kind === 'capture' && repeat === cursors &&
      cleaned.range.a === null && cleaned.range.b === null &&
      viewport.range.kind === 'viewport' && viewport.range.a === 2 && viewport.range.b === 6 &&
      cursors.rows === base.rows,
    `cursors=${JSON.stringify(cursors.range)}, cleaned=${JSON.stringify(cleaned.range)}, ` +
      `viewport=${JSON.stringify(viewport.range)}`);
}

{
  let state = emptyMeasurementRows();
  state = addMeasurementRow(state, 0, 'vpp');
  state = addMeasurementRow(state, 16, 'vpp');
  state = addMeasurementRow(state, 0, 'duty');
  const refs = state.rows.map((row) => `${row.id}:${row.start}:${row.parameter}`).join(',');
  const duplicate = addMeasurementRow(state, 0, 'vpp');
  const removed = removeMeasurementRow(state, 1);
  check('the same parameter on two sources is two rows with distinct monotonic ids',
    refs === '1:0:vpp,2:16:vpp,3:0:duty' && state.nextId === 4 &&
      duplicate === state && removed.rows.length === 2 &&
      removed.rows[0]!.id === 2 && removed.rows[0]!.start === 16,
    `refs=${refs}, duplicate=${duplicate === state}, ` +
      `removed=${removed.rows.map((row) => `${row.id}:${row.start}`).join(',')}`);
}

{
  const base = defaultMeasurementConfig([A0, A2]);
  const filtered = selectMeasurementFilter(base, [A0, A2], 16);
  const second = addMeasurementRow(base.rows, 16, 'vpp');
  check('the add target is the filtered source, else the first source with room in the catalog',
    measurementAddStart([A0, A2], base.rows) === 0 &&
      measurementAddStart([A0, A2], filtered.rows) === 16 &&
      measurementAddStart([A2, A0], base.rows) === 0 &&
      measurementAddStart([], base.rows) === null &&
      measurementAddStart([A0, A2], { ...base.rows, rows: [] }) === 0,
    `all=${String(measurementAddStart([A0, A2], base.rows))}, ` +
      `filtered=${String(measurementAddStart([A0, A2], filtered.rows))}, ` +
      `empty=${String(measurementAddStart([], base.rows))}`);
  let full = base.rows;
  for (const parameter of ['max', 'min', 'mean', 'duty', 'period'] as const) {
    full = addMeasurementRow(full, 0, parameter);
  }
  check('a source with all eight rows is skipped for the next source with room',
    measurementAddStart([A0, A2], full) === 16 &&
      visibleMeasurementRows(full).length === 8,
    `target=${String(measurementAddStart([A0, A2], full))}, ` +
      `rows=${visibleMeasurementRows(full).length}`);
  check('a source that is already full leaves the filtered add target empty',
    measurementAddStart([A0, A2], { ...full, filter: 0 }) === 0 &&
      second.filter === null && second.rows.length === 4,
    `filteredFull=${String(measurementAddStart([A0, A2], { ...full, filter: 0 }))}`);
}

{
  let state = emptyMeasurementRows();
  state = addMeasurementRow(state, 0, 'vpp');
  state = addMeasurementRow(state, 16, 'rms');
  state = addMeasurementRow(state, 0, 'duty');
  const filtered = setMeasurementFilter(state, 0);
  const cleared = clearMeasurementRows(filtered);
  const undone = undoClearMeasurementRows(cleared);
  const mutated = addMeasurementRow(cleared, 0, 'vpp');
  const counts = measurementSectionCounts(state);
  check('rowCount is every row while the visible list is filtered, and undoCount is the snapshot size',
    counts.rowCount === 3 && counts.undoCount === null &&
      visibleMeasurementRows(filtered).length === 2 &&
      measurementSectionCounts(filtered).rowCount === 3 &&
      cleared.rows.length === 0 && measurementSectionCounts(cleared).undoCount === 3 &&
      measurementSectionCounts(undone).undoCount === null &&
      undone.rows.length === 3 && measurementSectionCounts(mutated).undoCount === null,
    `counts=${JSON.stringify(counts)}, visible=${visibleMeasurementRows(filtered).length}, ` +
      `cleared=${JSON.stringify(measurementSectionCounts(cleared))}, ` +
      `mutated=${JSON.stringify(measurementSectionCounts(mutated))}`);
  const shallow = { rowCount: (s: typeof state): number => visibleMeasurementRows(s).length };
  check('a visible-row count or a stale snapshot cannot pass that predicate',
    shallow.rowCount(filtered) !== counts.rowCount &&
      (cleared.undo === null) === false && mutated.undo === null &&
      measurementSectionCounts(filtered).undoCount === null,
    `visible=${shallow.rowCount(filtered)}, rowCount=${counts.rowCount}`);
}

{
  const defaultTierIs = (tier: MeasureTier): boolean => tier === 'basic';
  const defaultRangeIs = (kind: MeasurementRangeKind): boolean => kind === 'capture';
  const seeded = defaultMeasurementConfig([A0, A2]);
  check('the measurement tier defaults to the basic surface',
    MEASURE_TIER_DEFAULT === 'basic' && defaultTierIs(MEASURE_TIER_DEFAULT) &&
      !defaultTierIs('advanced'),
    `default=${MEASURE_TIER_DEFAULT}, forcedAdvancedIsBasic=${String(defaultTierIs('advanced'))}`);
  check('the seeded session range is the whole capture, not the viewport',
    seeded.range.kind === 'capture' && defaultRangeIs(seeded.range.kind) &&
      !defaultRangeIs('viewport') && seeded.range.a === null && seeded.range.b === null &&
      rowRefs(seeded) === '1:0:frequency,2:0:vpp,3:0:rms',
    `kind=${seeded.range.kind}, forcedViewportIsCapture=${String(defaultRangeIs('viewport'))}, ` +
      `rows=${rowRefs(seeded)}`);
}

{
  const sectionView = (over: Partial<MeasurementSectionView> = {}): MeasurementSectionView => ({
    sources: [],
    filter: null,
    range: { kind: 'capture', a: null, b: null },
    tier: 'basic',
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
  });
  const catalog: MeasurementRow[] = [
    { id: 1, start: 0, parameter: 'vpp' },
    { id: 2, start: 0, parameter: 'rms' },
    { id: 3, start: 0, parameter: 'frequency' },
    { id: 4, start: 0, parameter: 'duty' },
    { id: 5, start: 16, parameter: 'frequency' },
    { id: 6, start: 16, parameter: 'vpp' },
    { id: 7, start: 16, parameter: 'rms' },
  ];
  const results = new Map<number, MeasurementSourceResult>([
    [0, resultFor(A0,
      scanFixture({ frequencyHz: 1000, vppVolts: 2, rmsVolts: 0.5 }), readFixture())],
    [16, resultFor(A2,
      scanFixture({ frequencyHz: 2000, vppVolts: 3.5, rmsVolts: 0.75 }), readFixture())],
  ]);
  const rows = measurementRowViews(catalog, results, null);
  const inputOrder = rows.filter((row) => row.start === 0)
    .map((row) => row.parameter).join(',');
  const basic = basicMeasurementView(sectionView({ sources: [A0, A2], rows }));
  check('the basic surface reads the three key parameters in catalog order for the first source',
    basic.source === 0 && basic.range === 'capture' && basic.rows.length === 3 &&
      basic.rows.map((row) => row.parameter).join(',') ===
        MEASUREMENT_DEFAULT_PARAMETERS.join(',') &&
      basic.rows.map((row) => row.value).join(',') === '1000,2,0.5' &&
      basic.rows.every((row) => row.start === 0) &&
      inputOrder === 'vpp,rms,frequency,duty' &&
      inputOrder !== basic.rows.map((row) => row.parameter).join(','),
    `source=${String(basic.source)}, rows=${basic.rows.map((row) => row.parameter).join(',')}, ` +
      `values=${basic.rows.map((row) => row.value).join(',')}, input=${inputOrder}`);
  const filtered = basicMeasurementView(sectionView({ sources: [A0, A2], filter: 16, rows }));
  check('a source filter outranks the first source and no other source row leaks in',
    filtered.source === 16 && filtered.rows.length === 3 &&
      filtered.rows.every((row) => row.start === 16) &&
      filtered.rows.every((row) => row.sourceName === 'A2') &&
      filtered.rows.map((row) => row.parameter).join(',') ===
        MEASUREMENT_DEFAULT_PARAMETERS.join(',') &&
      filtered.rows.map((row) => row.value).join(',') === '2000,3.5,0.75',
    `source=${String(filtered.source)}, ` +
      `rows=${filtered.rows.map((row) => `${row.start}:${row.parameter}`).join(',')}`);
  const two = basicMeasurementView(sectionView({
    sources: [A0],
    rows: rows.filter((row) => row.start !== 0 || row.parameter !== 'frequency'),
  }));
  check('a source with two of the three rows shows two readouts and fabricates none',
    two.source === 0 && two.rows.length === 2 &&
      two.rows.map((row) => row.parameter).join(',') === 'vpp,rms' &&
      two.rows.map((row) => row.value).join(',') === '2,0.5',
    `rows=${two.rows.map((row) => `${row.parameter}=${row.value}`).join(',')}`);
  const empty = basicMeasurementView(sectionView({ sources: [] }));
  check('a session with no analog group has no source and no readout',
    empty.source === null && empty.rows.length === 0 && empty.range === 'capture' &&
      basicMeasurementView(sectionView()).rows.length === 0,
    `source=${String(empty.source)}, rows=${empty.rows.length}, range=${empty.range}`);
  const cursored = basicMeasurementView(sectionView({
    sources: [A0], rows, range: { kind: 'cursors', a: 1, b: 2 },
  }));
  check('the basic surface projects the section range kind unchanged',
    cursored.range === 'cursors' && cursored.rows.length === 3 &&
      defaultMeasurementConfig([A0]).range.kind !== cursored.range,
    `range=${cursored.range}, seeded=${defaultMeasurementConfig([A0]).range.kind}`);
}

{
  const snapshot = between(appSource, '  private workspaceSnapshot(): WorkspaceSnapshotV1 {',
    '  private persistWorkspace(): void {');
  const snapshotFields = (region: string): string[] =>
    (region.match(/^ {6}[A-Za-z]\w*:/gm) ?? []).map((line) => line.trim().slice(0, -1));
  const fields = snapshotFields(snapshot);
  const withTier = snapshotFields(snapshot.replace(
    '      analogLayout: this.analogLayout,',
    '      analogLayout: this.analogLayout,\n      measureTier: this.measureTier,'));
  const expected = 'version,detailedLabels,wheelZooms,developerTools,compactRows,' +
    'hideIdleChannels,fitRows,quickScroll,analogLayout,channels,order,capture,busViews,' +
    'analyzers,sidebar';
  check('the workspace snapshot field list is unchanged by a tier switch and carries no tier',
    fields.join(',') === expected && fields.length === 15 &&
      !snapshot.includes('measureTier') &&
      withTier.length === fields.length + 1 && withTier.includes('measureTier') &&
      withTier.join(',') !== fields.join(','),
    `fields=${fields.length}, withTier=${withTier.length}, ` +
      `equal=${String(withTier.join(',') === fields.join(','))}`);
  const setter = between(appSource, '  private setMeasureTier(tier: MeasureTier): void {',
    '  private pickMeasurementCursor(');
  const written = setter.match(/this\.\w+ = /g) ?? [];
  check('the tier setter writes the session field and re-renders, nothing else',
    setter !== '' && setter.includes('this.measureTier = tier;') &&
      setter.includes('this.renderPanels();') &&
      !setter.includes('persistWorkspace') && !setter.includes('this.measurementStats') &&
      !setter.includes('this.measurementConfig') && !setter.includes('this.cursors') &&
      written.join(',') === 'this.measureTier = ',
    `written=${written.join(',')}, setter=${setter.length}`);
  check('the App owns one session tier and projects it onto the section view',
    appSource.includes('  private measureTier: MeasureTier = MEASURE_TIER_DEFAULT;') &&
      appSource.includes('      tier: this.measureTier,') &&
      appSource.includes('onPickMeasureTier: (tier) => this.setMeasureTier(tier),') &&
      !snapshot.includes('tier'),
    `field=${appSource.includes('private measureTier: MeasureTier')}, ` +
      `view=${appSource.includes('tier: this.measureTier,')}, ` +
      `wired=${appSource.includes('onPickMeasureTier: (tier) =>')}`);
}

{
  const row = (id: number, parameter: MeasurementRow['parameter']): MeasurementRow =>
    ({ id, start: 0, parameter });
  const scan = scanFixture();
  const read = readFixture();
  const resultsMap = new Map<number, MeasurementSourceResult>([[0, resultFor(A0, scan, read)]]);
  const rows = measurementRowViews(
    [row(1, 'vpp'), row(2, 'max'), row(3, 'min'), row(4, 'mean'),
      row(5, 'rms'), row(6, 'frequency'), row(7, 'period'), row(8, 'duty')],
    resultsMap, null);
  const values = rows.map((view) => `${view.parameter}=${view.value}/${view.unit}`).join(', ');
  check('every catalog parameter reads its own field with the catalog unit',
    rows.length === 8 &&
      rows[0]!.value === scan.vppVolts && rows[0]!.unit === 'v' &&
      rows[1]!.value === scan.maxVolts && rows[1]!.unit === 'v' &&
      rows[2]!.value === scan.minVolts && rows[2]!.unit === 'v' &&
      rows[3]!.value === scan.meanVolts && rows[3]!.unit === 'v' &&
      rows[4]!.value === scan.rmsVolts && rows[4]!.unit === 'v' &&
      rows[5]!.value === scan.frequencyHz && rows[5]!.unit === 'hz' &&
      rows[6]!.value === scan.periodSeconds && rows[6]!.unit === 's' &&
      rows[7]!.value === scan.dutyPercent && rows[7]!.unit === '%' &&
      rows.every((view) => view.unit === measurementUnit(view.parameter)),
    values);
  check('every mapped row carries its source name, id and the shared read counts',
    rows.every((view) => view.sourceName === 'A0' && view.start === 0 &&
      view.analyzedSamples === 1000 && view.requestedSamples === 1000 &&
      !view.truncated && !view.rangeClipped && view.status === 'ok') &&
      rows[7]!.dutyPeriods === 12 && rows[7]!.dutyExcludedPeriods === 3,
    rows.map((view) => `${view.id}:${view.sourceName}:${view.analyzedSamples}`).join(', '));

  const noPeriods = measurementRowViews([row(1, 'duty')], new Map([[
    0, resultFor(A0, scanFixture({
      status: 'ok', dutyPeriods: 0, dutyExcludedPeriods: 2, dutyPercent: Number.NaN,
    }), read),
  ]]), null);
  const dutyNoPeriodStatus: MeasurementStatus = noPeriods[0]!.status;
  const notNoData = dutyNoPeriodStatus !== 'no-data';
  check('a duty row with samples but no complete period reads no-period, never no-data',
    dutyNoPeriodStatus === 'no-period' && notNoData &&
      Number.isNaN(noPeriods[0]!.value) && noPeriods[0]!.analyzedSamples === 1000 &&
      noPeriods[0]!.dutyPeriods === 0 && noPeriods[0]!.dutyExcludedPeriods === 2,
    `status=${noPeriods[0]!.status}, value=${noPeriods[0]!.value}, ` +
      `analyzed=${noPeriods[0]!.analyzedSamples}, periods=${noPeriods[0]!.dutyPeriods}`);
  const onePeriod = measurementRowViews([row(1, 'duty')], new Map([[
    0, resultFor(A0, scanFixture({ status: 'ok', dutyPeriods: 1, dutyPercent: 25 }), read),
  ]]), null);
  check('one complete qualified period is enough to report a duty value',
    onePeriod[0]!.status === 'ok' && onePeriod[0]!.value === 25,
    `status=${onePeriod[0]!.status}, value=${onePeriod[0]!.value}`);

  const periodless = measurementRowViews([row(1, 'frequency'), row(2, 'period')], new Map([[
    0, resultFor(A0, scanFixture({ status: 'one-crossing', crossingCount: 1 }), read),
  ]]), null);
  check('frequency and period share the scan status while vertical rows stay numeric',
    periodless[0]!.status === 'one-crossing' && periodless[1]!.status === 'one-crossing',
    `frequency=${periodless[0]!.status}, period=${periodless[1]!.status}`);
}

{
  const row = (id: number, start: number, parameter: MeasurementRow['parameter']): MeasurementRow =>
    ({ id, start, parameter });
  const resultsMap = new Map<number, MeasurementSourceResult>([
    [0, resultFor(A0, scanFixture({ vppVolts: 21.4588, maxVolts: 16, dutyPeriods: 9 }), readFixture())],
    [16, resultFor({ ...A2, gain: 3 },
      scanFixture({ vppVolts: 64.3764, maxVolts: 48, dutyPeriods: 4 }),
      readFixture({ analyzed: 500, requestedSamples: 600, unknownSamples: 7 }))],
  ]);
  const rows = measurementRowViews([
    row(1, 0, 'vpp'), row(2, 16, 'vpp'), row(3, 16, 'duty'), row(4, 0, 'max'),
  ], resultsMap, null);
  check('each row reads the scan of its own source, with that source gain and read summary',
    rows[0]!.value === 21.4588 && rows[0]!.sourceName === 'A0' && rows[0]!.start === 0 &&
      rows[1]!.value === 64.3764 && rows[1]!.sourceName === 'A2' && rows[1]!.start === 16 &&
      rows[1]!.analyzedSamples === 500 && rows[1]!.requestedSamples === 600 &&
      rows[1]!.gaps && rows[0]!.analyzedSamples === 1000 && !rows[0]!.gaps &&
      rows[2]!.dutyPeriods === 4 && rows[3]!.value === 16,
    rows.map((view) => `${view.id}:${view.start}:${view.sourceName}:${view.value}`).join(', '));
  check('two rows of the same parameter on different sources keep distinct ids and values',
    rows[0]!.id !== rows[1]!.id && rows[0]!.parameter === rows[1]!.parameter &&
      rows[0]!.value !== rows[1]!.value,
    `ids=${rows[0]!.id},${rows[1]!.id}, values=${rows[0]!.value},${rows[1]!.value}`);
  const dead = measurementRowViews([row(9, 24, 'vpp')], resultsMap, null);
  check('a row whose source has no result reports no-source without a number or flag',
    dead[0]!.status === 'no-source' && Number.isNaN(dead[0]!.value) &&
      dead[0]!.sourceName === '' && dead[0]!.analyzedSamples === 0 &&
      !dead[0]!.truncated && !dead[0]!.gaps,
    `status=${dead[0]!.status}, source=${JSON.stringify(dead[0]!.sourceName)}`);
  const windowless = measurementRowViews([row(1, 0, 'vpp'), row(2, 16, 'rms')], new Map([
    [0, resultFor(A0, null, null, 'no-window')],
    [16, resultFor(A2, null, null, 'no-window')],
  ]), null);
  check('an unresolved window reports no-window on every source row',
    windowless.every((view) => view.status === 'no-window' && Number.isNaN(view.value) &&
      view.analyzedSamples === 0),
    windowless.map((view) => `${view.start}:${view.status}`).join(', '));
}

{
  const viewportConfig = selectMeasurementRange(
    defaultMeasurementConfig([A0]), { kind: 'viewport', a: null, b: null });
  const cursorConfig = selectMeasurementRange(viewportConfig, { kind: 'cursors', a: 1, b: 2 });
  const pair: MeasurementCursor[] = [{ id: 1, sample: 4000 }, { id: 2, sample: 1000 }];
  const sameSample: MeasurementCursor[] = [{ id: 1, sample: 4000 }, { id: 2, sample: 4000 }];
  const brokenSample: MeasurementCursor[] = [
    { id: 1, sample: 4000 }, { id: 2, sample: Number.NaN },
  ];
  const fractionalSample: MeasurementCursor[] = [{ id: 1, sample: 0 }, { id: 2, sample: 4000.5 }];
  const viewport = resolveMeasurementWindow(viewportConfig, pair, { start: 10.4, end: 20.2 });
  check('the viewport window is clamped to integer samples',
    viewport !== null && viewport.start === 10 && viewport.end === 21 &&
      resolveMeasurementWindow(viewportConfig, [], { start: 0.2, end: 0.4 })?.start === 0 &&
      resolveMeasurementWindow(viewportConfig, [], { start: 0.2, end: 0.4 })?.end === 1,
    `viewport=${JSON.stringify(viewport)}, ` +
      `narrow=${JSON.stringify(resolveMeasurementWindow(viewportConfig, [], { start: 0.2, end: 0.4 }))}`);
  check('a degenerate or non-finite viewport resolves no window',
    resolveMeasurementWindow(viewportConfig, [], { start: 5, end: 5 }) === null &&
      resolveMeasurementWindow(viewportConfig, [], { start: 20, end: 10 }) === null &&
      resolveMeasurementWindow(viewportConfig, [], { start: Number.NaN, end: 10 }) === null &&
      resolveMeasurementWindow(viewportConfig, [], {
        start: 0, end: Number.POSITIVE_INFINITY,
      }) === null,
    'same, reversed, NaN and infinite viewports all return null');
  const inverted = resolveMeasurementWindow(cursorConfig, pair, VIEWPORT);
  const forward = resolveMeasurementWindow(
    selectMeasurementRange(cursorConfig, { kind: 'cursors', a: 2, b: 1 }), pair, VIEWPORT);
  check('a cursor pair resolves an exclusive min..max window whatever the order',
    inverted !== null && inverted.start === 1000 && inverted.end === 4000 &&
      forward !== null && forward.start === 1000 && forward.end === 4000 &&
      inverted.end - inverted.start === Math.abs(4000 - 1000),
    `inverted=${JSON.stringify(inverted)}, forward=${JSON.stringify(forward)}`);
  check('missing, duplicate, identical and non-finite cursor selections resolve no window',
    resolveMeasurementWindow(cursorConfig, [{ id: 1, sample: 10 }], VIEWPORT) === null &&
      resolveMeasurementWindow(
        selectMeasurementRange(cursorConfig, { kind: 'cursors', a: 1, b: 1 }), pair, VIEWPORT) === null &&
      resolveMeasurementWindow(cursorConfig, sameSample, VIEWPORT) === null &&
      resolveMeasurementWindow(cursorConfig, brokenSample, VIEWPORT) === null &&
      resolveMeasurementWindow(cursorConfig, fractionalSample, VIEWPORT) === null &&
      resolveMeasurementWindow(
        selectMeasurementRange(cursorConfig, { kind: 'cursors', a: 1, b: null }), pair,
        VIEWPORT) === null &&
      resolveMeasurementWindow(
        selectMeasurementRange(cursorConfig, { kind: 'cursors', a: null, b: 2 }), pair,
        VIEWPORT) === null,
    'missing, a === b, equal samples, NaN, fractional, null endpoints all return null');
}

{
  const input: MeasurementCacheInput = {
    store: {}, storeLength: 1000, droppedSamples: 0, samplerate: 100e6,
    windowStart: 0, windowEnd: 1000, group: 0, gain: 1, rising: true,
    level: 128, hysteresis: 4, window: 50,
  };
  const key = measurementCacheKey(input);
  const variants: MeasurementCacheInput[] = [
    { ...input, store: {} },
    { ...input, storeLength: 999 },
    { ...input, droppedSamples: 64 },
    { ...input, samplerate: 50e6 },
    { ...input, windowStart: 64 },
    { ...input, windowEnd: 999 },
    { ...input, group: 1 },
    { ...input, gain: 3 },
    { ...input, rising: false },
    { ...input, level: 129 },
    { ...input, hysteresis: 5 },
    { ...input, window: 51 },
  ];
  const keys = variants.map((variant) => measurementCacheKey(variant));
  check('equal inputs share one cache key and every listed field changes it',
    measurementCacheKey({ ...input }) === key && measurementCacheKey(input) === key &&
      keys.every((other) => other !== key) && new Set(keys).size === variants.length &&
      variants.length === 12,
    `variants=${variants.length}, distinct=${new Set(keys).size}, key=${key}`);
  const growing = measurementCacheKey({ ...input, storeLength: 2000 });
  const shrunk = measurementCacheKey({ ...input, storeLength: 1000, windowEnd: 2000 });
  check('a live window and a re-windowed one never collide',
    growing !== key && shrunk !== growing && shrunk !== key,
    `growing=${growing}, shrunk=${shrunk}`);
}

{
  const store = {};
  const keyOf = (
    source: MeasurementSource, rising: boolean, level: number, hysteresis: number, window: number,
  ): string => measurementCacheKey({
    store, storeLength: 1000, droppedSamples: 0, samplerate: 100e6,
    windowStart: 0, windowEnd: 1000, group: source.group, gain: source.gain,
    rising, level, hysteresis, window,
  });
  const a0 = keyOf(A0, true, 130, 4, 50);
  const a2 = keyOf(A2, false, 120, 6, 80);
  const sameSettingsOtherGroup = keyOf({ ...A0, group: A2.group, start: A2.start }, true, 130, 4, 50);
  const sameSettingsOtherGain = keyOf({ ...A0, gain: 3 }, true, 130, 4, 50);
  check('two sources never share a scan cache key even with identical trigger settings',
    keyOf(A0, true, 130, 4, 50) === a0 && a0 !== a2 && a0 !== sameSettingsOtherGroup &&
      a0 !== sameSettingsOtherGain && sameSettingsOtherGroup !== a2,
    `a0=${a0}, a2=${a2}, group=${sameSettingsOtherGroup}, gain=${sameSettingsOtherGain}`);
}

const TRACE = loadAdcTrace('sine');
const CHANNELS = 32;
const analog = analogBusConfig(0, CHANNELS, '#123456');
const BUS = { bits: analog.spec.bits, group: analog.analogGroup ?? 0, gain: analog.analogGain ?? 1 };

function fixtureWord(code: number): number {
  let word = 0;
  for (let k = 0; k < 8; k++) if ((code >> k) & 1) word |= 1 << (7 - k);
  return word;
}

function fixtureStore(codes: Uint8Array): SampleStore {
  const store = createSampleStore(CHANNELS, 100e6);
  const words = new Uint8Array(codes.length * 4);
  for (let i = 0; i < codes.length; i++) words[i * 4] = fixtureWord(codes[i]!);
  store.append(words);
  return store;
}

const SCAN = {
  samplerate: 100e6,
  zeroCode: ADC_ZERO_CODE,
  voltsPerCode: LSB,
  rising: true,
  level: 128,
  hysteresis: 4,
  window: 50,
};

const store = fixtureStore(TRACE);
const source0: MeasurementSource = { group: 0, start: 0, gain: BUS.gain, name: analog.name };
const config = defaultMeasurementConfig([source0]);
const requested: MeasurementWindow = { start: 0, end: TRACE.length };

function summary(read: {
  analyzed: number;
  requestedSamples: number;
  truncated: boolean;
  rangeClipped: boolean;
  unknownSamples: number;
}): MeasurementReadSummary {
  return {
    analyzed: read.analyzed,
    requestedSamples: read.requestedSamples,
    truncated: read.truncated,
    rangeClipped: read.rangeClipped,
    unknownSamples: read.unknownSamples,
  };
}

function rowsOf(scan: AnalogCodeScan | null, read: MeasurementReadSummary | null): {
  rows: ReturnType<typeof measurementRowViews>;
  vpp: ReturnType<typeof measurementRowViews>[number];
  rms: ReturnType<typeof measurementRowViews>[number];
  frequency: ReturnType<typeof measurementRowViews>[number];
} {
  const map = new Map<number, MeasurementSourceResult>([[0, resultFor(source0, scan, read)]]);
  const rows = measurementRowViews(rowList(config), map, null);
  return {
    rows,
    vpp: rows.find((row) => row.parameter === 'vpp')!,
    rms: rows.find((row) => row.parameter === 'rms')!,
    frequency: rows.find((row) => row.parameter === 'frequency')!,
  };
}

{
  const run = runMeasurement({ store, bus: BUS, window: requested, scan: SCAN });
  const scan = run.scan;
  const { rows, vpp, rms, frequency } = rowsOf(scan, summary(run.read));
  check('the default UI window scans the exact 65,536-sample prefix and discloses truncation',
    run.read.analyzed === 65536 && run.read.end === 65536 && run.read.truncated &&
      !run.read.rangeClipped && run.read.requestedSamples === TRACE.length &&
      scan !== null && scan.analyzed === 65536 && scan.status === 'ok',
    `analyzed=${run.read.analyzed}, truncated=${run.read.truncated}, ` +
      `requested=${run.read.requestedSamples}, status=${scan?.status}`);
  check('the prefix Vpp is the exact 171-code carry-inclusive amplitude',
    vpp.value === 171 * LSB && vpp.unit === 'v' && vpp.status === 'ok' &&
      scan !== null && scan.vppCodes === 171,
    `vpp=${vpp.value}, expected=${171 * LSB}, codes=${scan?.vppCodes}`);
  check('the prefix RMS is the exact calibrated centered prefix value',
    rms.value === scan?.rmsVolts && scan?.rmsOffsetCodes === 32.59432371371574 &&
      frequency.status === 'ok' &&
      Math.abs(frequency.value - 9999.5877) / 9999.5877 < 0.005 &&
      frequency.unit === 'hz',
    `rms=${rms.value}/${scan?.rmsOffsetCodes}, frequency=${frequency.value}`);
  check('the row view carries the read counts and the scan flags for every parameter',
    rows.length === 3 && rows.every((row) => row.analyzedSamples === 65536 &&
      row.requestedSamples === TRACE.length && row.truncated && !row.rangeClipped &&
      !row.gaps && !row.clippedLow && !row.clippedHigh && !row.nearSampleLimit &&
      !row.crossingCap && row.crossingCount === 6 && row.sourceName === analog.name),
    rows.map((row) => `${row.parameter}:${row.analyzedSamples}/${row.requestedSamples}` +
      `/${row.crossingCount}`).join(', '));
}

{
  const cursorConfig = selectMeasurementRange(config, { kind: 'cursors', a: 1, b: 2 });
  const cursors: MeasurementCursor[] = [{ id: 1, sample: 0 }, { id: 2, sample: TRACE.length }];
  const window = resolveMeasurementWindow(cursorConfig, cursors, {
    start: 0, end: 65536,
  });
  const run = runMeasurement({
    store, bus: BUS, window: window ?? requested, scan: SCAN, maxSamples: TRACE.length,
  });
  const scan = run.scan!;
  const map = new Map<number, MeasurementSourceResult>([
    [0, resultFor(source0, scan, summary(run.read))],
  ]);
  const rows = measurementRowViews(rowList(cursorConfig), map, null);
  const vpp = rows.find((row) => row.parameter === 'vpp')!;
  const rms = rows.find((row) => row.parameter === 'rms')!;
  const frequency = rows.find((row) => row.parameter === 'frequency')!;
  check('a cursor pair over the whole record answers from all 300,000 exact samples',
    window !== null && window.start === 0 && window.end === TRACE.length &&
      run.read.analyzed === TRACE.length && !run.read.truncated && !run.read.rangeClipped &&
      !rows.some((row) => row.truncated),
    `window=${JSON.stringify(window)}, analyzed=${run.read.analyzed}, ` +
      `truncated=${run.read.truncated}`);
  check('the full-record answers are the exact fixture amplitude and RMS',
    scan.vppCodes === 171 && vpp.value === 171 * LSB &&
      scan.rmsOffsetCodes === 32.66680430243114 && rms.value === scan.rmsVolts &&
      Math.abs(scan.vppVolts - 21.4588) < 1e-4 &&
      Math.abs(scan.rmsVolts - 4.09936) < 1e-5,
    `vpp=${vpp.value}, rms=${rms.value}, rmsCodes=${scan.rmsOffsetCodes}`);
  check('the full-record frequency matches the independent reference within 0.5%',
    scan.crossingCount === 30 && frequency.status === 'ok' &&
      Math.abs(frequency.value - 9999.5877) / 9999.5877 < 0.005,
    `crossings=${scan.crossingCount}, frequency=${frequency.value}, period=${scan.periodSamples}`);
}

{
  const empty = createSampleStore(CHANNELS, 100e6);
  const run = runMeasurement({ store: empty, bus: BUS, window: { start: 0, end: 100 }, scan: SCAN });
  const past = runMeasurement({
    store, bus: BUS, window: { start: TRACE.length, end: TRACE.length }, scan: SCAN,
  });
  const map = new Map<number, MeasurementSourceResult>([
    [0, resultFor(source0, null, null, 'no-data')],
  ]);
  const emptyRows = measurementRowViews(rowList(config), map, null);
  check('a window with no samples yields no scan and no-data rows without a number',
    run.read.analyzed === 0 && run.scan === null && past.scan === null &&
      past.read.analyzed === 0 && emptyRows.length === 3 &&
      emptyRows.every((row) => Number.isNaN(row.value) && row.status === 'no-data' &&
        row.analyzedSamples === 0 && row.requestedSamples === 0),
    `empty=${run.read.analyzed}/${String(run.scan)}, past=${past.read.analyzed}/${String(past.scan)}`);
}

{
  const blocked = scanAnalogCodes({ ...SCAN, codes: new Uint8Array(200).fill(128) });
  const once = scanAnalogCodes({
    ...SCAN,
    codes: new Uint8Array([...new Uint8Array(20).fill(100), ...new Uint8Array(20).fill(200)]),
    window: 4,
  });
  const read: MeasurementReadSummary = {
    analyzed: 200, requestedSamples: 200, truncated: false, rangeClipped: false, unknownSamples: 0,
  };
  const blockedRows = rowsOf(blocked, read).rows;
  const onceRows = rowsOf(once, read).rows;
  const frequency = (rows: typeof blockedRows) => rows.find((row) => row.parameter === 'frequency')!;
  const vpp = (rows: typeof blockedRows) => rows.find((row) => row.parameter === 'vpp')!;
  check('no crossing is a frequency status; amplitude rows stay numeric',
    blocked.status === 'no-crossing' && frequency(blockedRows).status === 'no-crossing' &&
      Number.isNaN(frequency(blockedRows).value) && frequency(blockedRows).unit === 'hz' &&
      vpp(blockedRows).status === 'ok' && vpp(blockedRows).value === 0,
    `frequency=${frequency(blockedRows).status}/${frequency(blockedRows).value}, ` +
      `vpp=${vpp(blockedRows).status}/${vpp(blockedRows).value}`);
  check('one crossing is a frequency status, not an amplitude status',
    once.status === 'one-crossing' && frequency(onceRows).status === 'one-crossing' &&
      Number.isNaN(frequency(onceRows).value) &&
      vpp(onceRows).status === 'ok' && vpp(onceRows).value === 100 * LSB,
    `frequency=${frequency(onceRows).status}, vpp=${vpp(onceRows).status}/${vpp(onceRows).value}`);
}

{
  const gapped: MeasurementReadSummary = {
    analyzed: 5000, requestedSamples: 6000, truncated: true, rangeClipped: true, unknownSamples: 100,
  };
  const scan: AnalogCodeScan = scanAnalogCodes({
    ...SCAN,
    codes: new Uint8Array(2000).fill(128),
    unknown: new Uint8Array(2000).fill(1),
  });
  const unavailable: MeasurementStatus[] = [
    'no-source', 'no-window', 'previous-wave-displayed', 'no-data',
  ];
  const blockedOk = unavailable.every((status) => measurementRowViews(
    rowList(config), new Map(), status).every((row) => Number.isNaN(row.value) &&
      row.status === status && row.analyzedSamples === 0 && row.requestedSamples === 0 &&
      !row.truncated && !row.rangeClipped && !row.gaps));
  const flagged = rowsOf(scan, gapped).rows;
  check('an unavailable section never leaks a number or a stale flag',
    blockedOk, `statuses=${unavailable.join(',')}`);
  check('gaps and truncation reach every row from the read summary',
    flagged.length === 3 && flagged.every((row) => row.gaps && row.truncated &&
      row.rangeClipped && row.analyzedSamples === 5000 && row.requestedSamples === 6000 &&
      Number.isNaN(row.value) && row.status === 'no-data' && !row.nearSampleLimit),
    flagged.map((row) => `${row.parameter}:${row.status}/${row.value}/gaps=${row.gaps}` +
      `/trunc=${row.truncated}`).join(', '));
}

{
  const fast = scanAnalogCodes({
    ...SCAN,
    codes: new Uint8Array(80).map((_, index) => index % 2 === 0 ? 100 : 200),
    window: 1,
  });
  const rows = rowsOf(fast, {
    analyzed: 80, requestedSamples: 80, truncated: false, rangeClipped: false, unknownSamples: 0,
  }).rows;
  check('a period near the sample limit is disclosed on every row',
    fast.nearSampleLimit && rows.every((row) => row.nearSampleLimit) &&
      rows.find((row) => row.parameter === 'frequency')!.status === 'ok',
    `period=${fast.periodSamples}, frequency=${fast.frequencyHz}, ` +
      `nearLimit=${rows.map((row) => row.nearSampleLimit).join(',')}`);
}

{
  const view = between(appSource,
    '  private measurementView(): MeasurementSectionView {', '  private measurementBase(');
  const setter = between(appSource,
    '  private measurementBase(', '  // ------------------------------------------------------------------ bus views');
  const scanAt = view.indexOf('runMeasurement(');
  check('the view analyses the current wave and every bus view, never display state',
    view !== '' && view.includes('const store = this.captureStore;') &&
      view.includes('measurementSources(this.busViews, store.channelCount)') &&
      view.includes('this.measurementRowsFor(sources, rows)') &&
      !view.includes('this.store.') && !view.includes('repeatComposite') &&
      !view.includes('visibleChannels(') && !view.includes('enabledChannels(') &&
      !view.includes('hideSources'),
    `region=${view.length}, scanAt=${scanAt}`);
  check('a held previous wave is unavailable and nothing is scanned',
    view.includes('if (this.repeatShowingFront) {') &&
      view.includes("'previous-wave-displayed'") &&
      view.indexOf('if (this.repeatShowingFront) {') < view.indexOf('resolveMeasurementWindow(') &&
      view.indexOf("'no-source'") < scanAt && view.indexOf("'previous-wave-displayed'") < scanAt &&
      view.indexOf("'no-window'") < scanAt,
    `repeatAt=${view.indexOf('if (this.repeatShowingFront) {')}, scanAt=${scanAt}`);
  check('the requested window is clipped to the current wave before the scans',
    view.includes('const start = Math.max(0, Math.min(window.start, store.length));') &&
      view.includes('const end = Math.max(start, Math.min(window.end, store.length));') &&
      view.includes('const clipped = start !== window.start || end !== window.end;') &&
      view.indexOf('const clipped =') < scanAt &&
      view.includes('window: { start, end },') &&
      view.includes('rangeClipped: cache.read.rangeClipped || clipped,'),
    `clippedAt=${view.indexOf('const clipped =')}, scanAt=${scanAt}`);
  check('the scan inputs come from each source trigger and the ADC scale',
    view.includes('this.settings.analogTriggers[source.start]') &&
      view.includes('trigger.kind === \'rising\'') &&
      view.includes('analogTriggerCode(trigger.kind, trigger.volts, source.gain)') &&
      view.includes('analogTriggerQualification(store.samplerate)') &&
      view.includes('hysteresis: qualification.analogHysteresis,') &&
      view.includes('window: qualification.analogArtifactSamples,') &&
      view.includes('zeroCode: ADC_ZERO_CODE,') &&
      view.includes('voltsPerCode: analogVoltsPerCode(source.gain),') &&
      view.includes('bus: { bits: bus.spec.bits, group: source.group, gain: source.gain },'),
    `scanAt=${scanAt}`);
  check('one bounded scan runs per distinct row source and is cached by that start',
    view.includes('const results = new Map<number, MeasurementSourceResult>();') &&
      view.includes('for (const source of this.measurementRowsFor(sources, rows)) {') &&
      view.includes('let cache = this.measurementCache.get(source.start);') &&
      view.includes('this.measurementCache.set(source.start, cache);') &&
      view.includes('if (entry.store !== store) this.measurementCache.delete(start);') &&
      view.indexOf('this.measurementCache.delete(start)') < scanAt &&
      (view.split('runMeasurement({').length - 1) === 1 &&
      view.includes('rows: measurementRowViews(rows, results, null, stats),'),
    `scans=${view.split('runMeasurement({').length - 1}, ` +
      `evictAt=${view.indexOf('this.measurementCache.delete(start)')}`);
  check('the cache key carries the wave identity, the source scan inputs and the window',
    view.includes('storeLength: store.length,') &&
      view.includes('droppedSamples: store.droppedSamples,') &&
      view.includes('samplerate: store.samplerate,') &&
      view.includes('windowStart: start,') && view.includes('windowEnd: end,') &&
      view.includes('group: source.group,') && view.includes('gain: source.gain,') &&
      view.includes('rising: scan.rising,') && view.includes('level: scan.level,') &&
      view.includes('hysteresis: scan.hysteresis,') && view.includes('window: scan.window,') &&
      view.includes('if (cache === undefined || cache.store !== store || cache.key !== key) {'),
    `keyAt=${view.indexOf('measurementCacheKey(')}`);
  const feed = (body: string): boolean =>
    body.includes('filter: state.filter,') &&
    body.includes('const addStart = sources.length === 0 ? null : measurementAddStart(sources, state);') &&
    body.includes('allRows: state.rows,') &&
    !body.includes('availableParameters') &&
    !body.includes('measurementRowViews(state.rows') &&
    !body.includes('source: config.source');
  const scannedFeed = view.replace('allRows: state.rows,',
    'allRows: measurementRowViews(state.rows, results, null),');
  const deadField = view.replace('allRows: state.rows,',
    'allRows: state.rows, availableParameters: [],');
  check('the filter and add target are derived, and the catalog feed is row identity alone',
    feed(view) && !feed(scannedFeed) && !feed(deadField) &&
      view.split('allRows: state.rows,').length - 1 === 1 &&
      !appSource.includes('availableParameters'),
    `addStartAt=${view.indexOf('measurementAddStart(')}, feed=${feed(view)}, ` +
      `scanned=${feed(scannedFeed)}, dead=${feed(deadField)}`);
  check('the measurement path runs on demand, without a clock or a workspace write',
    setter !== '' && !view.includes('requestAnimationFrame') &&
      !view.includes('setTimeout') && !view.includes('setInterval') &&
      !view.includes('runningPanelAt') && !view.includes('analysisPanelAt') &&
      !setter.includes('persistWorkspace') &&
      !workspaceSource.includes('measurement') &&
      !workspaceSource.includes('Measurement'),
    `setter=${setter.length}`);
  check('the debug surface drives the same reducers and a session-only reset',
    appSource.indexOf('readonly debug = {') >= 0 &&
      appSource.indexOf('readonly debug = {') < appSource.indexOf('measurement: () => this.measurementView(),') &&
      appSource.includes('measurement: () => this.measurementView(),') &&
      appSource.includes('setMeasurement: (patch: {') &&
      appSource.includes('resetMeasurement: () => this.resetMeasurement(),'),
    `debugAt=${appSource.indexOf('readonly debug = {')}`);
}

{
  const capture = selectMeasurementRange(config, { kind: 'capture', a: null, b: null });
  const reconciled = reconcileMeasurementConfig(capture, [source0]);
  const window = resolveMeasurementWindow(capture, [], VIEWPORT, 300000);
  check('the capture range resolves the whole retained current wave, never a cursor or viewport span',
    measurementRangeKind('viewport') === 'viewport' &&
      measurementRangeKind('cursors') === 'cursors' &&
      measurementRangeKind('capture') === 'capture' &&
      measurementRangeKind('whole') === 'viewport' &&
      capture.range.kind === 'capture' && reconciled.range.kind === 'capture' &&
      window !== null && window.start === 0 && window.end === 300000 &&
      resolveMeasurementWindow(capture, [], VIEWPORT, 0) === null &&
      resolveMeasurementWindow(capture, [], VIEWPORT, 1.5) === null &&
      resolveMeasurementWindow(capture, [], VIEWPORT) === null,
    `kind=${capture.range.kind}, window=${JSON.stringify(window)}`);

  const viewport = resolveMeasurementWindow(
    selectMeasurementRange(config, { kind: 'viewport', a: null, b: null }), [], VIEWPORT, 300000);
  const cursorConfig = selectMeasurementRange(config, { kind: 'cursors', a: 1, b: 2 });
  const cursors: MeasurementCursor[] = [{ id: 1, sample: 10 }, { id: 2, sample: 40 }];
  const cursorWindow = resolveMeasurementWindow(cursorConfig, cursors, VIEWPORT, 300000);
  check('the retained length only answers the capture range',
    viewport !== null && viewport.start === 0 && viewport.end === 100 &&
      cursorWindow !== null && cursorWindow.start === 10 && cursorWindow.end === 40,
    `viewport=${JSON.stringify(viewport)}, cursors=${JSON.stringify(cursorWindow)}`);
}

{
  const view = between(appSource,
    '  private measurementView(): MeasurementSectionView {', '  private measurementBase(');
  const section = between(appSource,
    '  private captureMeasurementSection(', '  private pumpMeasurementCapture(): void {');
  const scanAt = view.indexOf('runMeasurement(');
  const branchAt = view.indexOf("if (config.range.kind === 'capture' && " +
    "this.measureTier === 'advanced') {");
  check('the capture range leaves the bounded scan path before it starts',
    branchAt >= 0 && scanAt > branchAt &&
      view.includes('return this.captureMeasurementSection(base, rows, sources, store, start, end, clipped);') &&
      view.includes('captureRangeUnavailable({') &&
      view.indexOf('captureRangeUnavailable({') < scanAt &&
      view.includes('resolveMeasurementWindow(config, cursors, {') &&
      view.includes('}, store.length);') &&
      view.includes("if (config.range.kind !== 'capture' && this.measurementCapture !== null) {") &&
      view.includes('this.dropMeasurementCapture();') &&
      view.indexOf('this.dropMeasurementCapture();') < scanAt,
    `branch=${branchAt}, scan=${scanAt}`);
  check('a blocked capture range carries its own status on every row',
    view.includes("unavailable: captureBlocked,") &&
      view.includes('rows: measurementRowViews(rows, blocked, null, stats),') &&
      view.includes('window: null, unavailable: captureBlocked,'),
    `blocked=${view.includes('unavailable: captureBlocked,')}`);
  const projected = (source: string): boolean =>
    source.includes('const stats = this.measurementStatsViews(rows, sources, store.samplerate, config.range);') &&
    source.indexOf('this.measurementStatsViews(') < source.indexOf('const results = new Map<number, MeasurementSourceResult>();') &&
    (source.match(/measurementRowViews\(rows, /g) ?? []).length === 6 &&
    (source.match(/measurementRowViews\(rows, [^)]*, stats\)/g) ?? []).length === 6;
  check('one statistics projection runs before the branches and every row view carries it',
    projected(view) &&
      view.includes('statsSkipped: this.measurementStats.skipped,') &&
      view.includes('statsLoopUnavailable: this.captureIsLoop,') &&
      !projected(view.replace('const stats = this.measurementStatsViews(rows, sources, store.samplerate, config.range);', '')) &&
      !projected(view.replace(', stats)', ')')),
    `projected=${projected(view)}, ` +
    `all=${(view.match(/measurementRowViews\(rows, [^)]*, stats\)/g) ?? []).length}, ` +
    `skipped=${view.includes('statsSkipped: this.measurementStats.skipped,')}, ` +
    `loop=${view.includes('statsLoopUnavailable: this.captureIsLoop,')}`);
  check('the capture-range section projects the same statistics map for its own rows',
    section.includes('const stats = this.measurementStatsViews(rows, sources, store.samplerate, base.range);') &&
      section.includes('rows: measurementRowViews(rows, results, null, stats),'),
    `projection=${section.includes('this.measurementStatsViews(')}`);
  check('a finished job feeds the rows instead of a second bounded scan',
    section !== '' && section.includes('const done = entry.job.results();') &&
      section.includes('if (result === undefined) {') &&
      section.includes('unavailable: done === null ? status : \'no-source\',') &&
      !section.includes('runMeasurement(') &&
      section.includes('window: { start, end },') &&
      section.includes('droppedSamples: store.droppedSamples,'),
    `section=${section.length}, scans=${section.includes('runMeasurement(')}`);
  const fromJob = (source: string): boolean =>
    source.includes('const done = entry.job.results();') && !source.includes('runMeasurement(');
  const replayed = section.replace('entry.job.results()',
    'runMeasurement({} as never).scan as never');
  check('reading the job result is load-bearing: a second scan fails the contract',
    fromJob(section) && !fromJob(replayed) && !fromJob(''),
    `section=${fromJob(section)}, replayed=${fromJob(replayed)}, empty=${fromJob('')}`);
}

{
  const accumulate = (values: readonly number[], key: string): MeasurementAccumulator => {
    let acc = emptyAccumulator(key);
    for (const value of values) acc = accumulateSample(acc, value);
    return acc;
  };
  const rows: MeasurementRow[] = [
    { id: 1, start: 0, parameter: 'vpp' },
    { id: 2, start: 0, parameter: 'rms' },
    { id: 3, start: 0, parameter: 'frequency' },
  ];
  const resultsMap = new Map<number, MeasurementSourceResult>([
    [0, resultFor(A0, scanFixture(), readFixture())],
  ]);
  const state: MeasurementStatsState = {
    accumulators: new Map([
      [1, accumulate([1, 3, 5], 'match')],
      [2, accumulate([2, 4], 'superseded')],
    ]),
    skipped: 3,
    lastWaveKey: '0:7',
  };
  const stats = new Map<number, MeasurementStatsView>([
    [1, measurementStatsView(state, 1, 'match')],
    [2, measurementStatsView(state, 2, 'current')],
    [3, measurementStatsView(state, 3, 'current')],
  ]);
  const views: MeasurementRowView[] = measurementRowViews(rows, resultsMap, null, stats);
  check('a matching accumulator key projects its count, mean, extrema and sample standard deviation',
    views[0]!.stats.count === 3 && views[0]!.stats.mean === 3 &&
      views[0]!.stats.min === 1 && views[0]!.stats.max === 5 &&
      views[0]!.stats.stdDev !== null && Math.abs(views[0]!.stats.stdDev - 2) < 1e-12 &&
      !views[0]!.stats.capped && views[0]!.stats.excluded === 0,
    `count=${views[0]!.stats.count}, mean=${views[0]!.stats.mean}, ` +
    `min/max=${views[0]!.stats.min}/${views[0]!.stats.max}, ` +
    `stdDev=${views[0]!.stats.stdDev}`);
  const emptyStats = views.slice(1).map((view) => view.stats);
  check('a mismatched or missing accumulator key reports an empty history, never stale numbers',
    emptyStats.every((entry) => entry.count === 0 && Number.isNaN(entry.mean) &&
      Number.isNaN(entry.min) && Number.isNaN(entry.max) &&
      entry.stdDev === null && entry.excluded === 0 && !entry.capped) &&
      views[1]!.stats !== views[0]!.stats,
    `mismatched=${JSON.stringify(emptyStats[0])}, missing=${JSON.stringify(emptyStats[1])}`);
  const noStats = measurementRowViews(rows, resultsMap, null);
  check('a row view built without a statistics map carries the empty history, not undefined',
    noStats.every((view) => view.stats.count === 0 && Number.isNaN(view.stats.mean) &&
      view.stats.stdDev === null),
    `stats=${JSON.stringify(noStats[0]!.stats)}`);

  const capped = accumulate(Array.from({ length: 600 }, (_, k) => k), 'match');
  const cappedView = measurementStatsView({ ...state, accumulators: new Map([[1, capped]]) }, 1,
    'match');
  check('an accumulator that reached the cap keeps its count and reports the cap',
    cappedView.count === 512 && cappedView.capped && capped.count === 512,
    `count=${cappedView.count}, capped=${cappedView.capped}, held=${capped.count}`);

  const excluded = excludeSample(accumulate([1, 2], 'match'));
  const excludedView = measurementStatsView({ ...state, accumulators: new Map([[1, excluded]]) },
    1, 'match');
  check('an excluded result keeps the population and discloses its own count',
    excludedView.count === 2 && excludedView.excluded === 1 &&
      excludedView.mean === 1.5,
    `count=${excludedView.count}, excluded=${excludedView.excluded}, ` +
    `mean=${excludedView.mean}`);
}

{
  const row: MeasurementRow = { id: 1, start: 0, parameter: 'vpp' };
  const view = (
    scan: Partial<AnalogCodeScan> = {}, read: Partial<MeasurementReadSummary> = {},
  ): MeasurementRowView => measurementRowViews(
    [row],
    new Map([[0, resultFor(A0, scanFixture(scan), readFixture(read))]]), null,
  )[0]!;
  const eligible = view();
  const rejected: [string, MeasurementRowView][] = [
    ['status', view({ status: 'no-data' })],
    ['truncated', view({}, { truncated: true })],
    ['rangeClipped', view({}, { rangeClipped: true })],
    ['gaps', view({}, { unknownSamples: 3 })],
    ['clippedLow', view({ clippedLow: true })],
    ['clippedHigh', view({ clippedHigh: true })],
  ];
  const admitted = rejected.filter(([, entry]) => measurementRowEligible(entry) ||
    measurementWaveValue(entry) !== null);
  check('only an ok, complete, unclipped, gapless result is eligible for the statistics',
    measurementRowEligible(eligible) && measurementWaveValue(eligible) === eligible.value &&
      rejected.length === 6 && admitted.length === 0,
    `admitted=${JSON.stringify(admitted.map(([name]) => name))}, ` +
    `value=${measurementWaveValue(eligible)}`);
  const skipped = rejected.map(([, entry]) => measurementWaveValue(entry));
  check('an ineligible settled result offers no value, so the wave can only count it as excluded',
    skipped.every((value) => value === null),
    `values=${JSON.stringify(skipped)}`);
}

{
  const row: MeasurementRow = { id: 1, start: 0, parameter: 'vpp' };
  const pending: MeasurementStatus[] = [
    'no-source', 'no-window', 'previous-wave-displayed', 'analyzing', 'cancelled',
    'stable-capture-required', 'loop',
  ];
  const settled: MeasurementStatus[] = [
    'ok', 'no-data', 'no-crossing', 'one-crossing', 'no-period',
  ];
  const blank = (status: MeasurementStatus): MeasurementRowView => measurementRowViews(
    [row], new Map([[0, resultFor(A0, null, null, status)]]), null)[0]!;
  const unmeasured = pending.map(blank);
  const attempted = settled.map(blank);
  const wronglySettled = unmeasured.filter((view) => measurementRowSettled(view))
    .map((view) => view.status);
  const wronglyPending = attempted.filter((view) => !measurementRowSettled(view))
    .map((view) => view.status);
  check('only a completed measurement attempt may count as an excluded result',
    wronglySettled.length === 0 && wronglyPending.length === 0 &&
      unmeasured.map((view) => view.status).join(',') === pending.join(',') &&
      measurementRowViews([row], new Map([[0, resultFor(A0, null, null, 'analyzing')]]),
        null)[0]!.status === 'analyzing',
    `wronglySettled=${JSON.stringify(wronglySettled)}, ` +
    `wronglyPending=${JSON.stringify(wronglyPending)}`);
  check('a pending or unavailable result is neither a sample nor an exclusion',
    unmeasured.every((view) => measurementWaveValue(view) === null) &&
      attempted.every((view) => measurementWaveValue(view) === null),
    `pendingValues=${JSON.stringify(unmeasured.map((view) => measurementWaveValue(view)))}`);
  const wave = between(appSource, 'private measurementWaveRows(',
    'private recordMeasurementWave(');
  const needle = 'if (!measurementRowSettled(row)) continue;';
  const guarded = (source: string): boolean =>
    source.includes(needle) && source.indexOf(needle) < source.indexOf('wave.push({ rowId');
  check('the wave composer drops an unsettled row instead of offering it as an exclusion',
    wave.length > 0 && guarded(wave) && !guarded(wave.replace(needle, '')) &&
      !guarded(wave.replace(needle, 'if (false) continue;')),
    `guarded=${guarded(wave)}, dropped=${!guarded(wave.replace(needle, ''))}, ` +
    `disabled=${!guarded(wave.replace(needle, 'if (false) continue;'))}`);

  const accumulate = (values: readonly number[]): MeasurementAccumulator => {
    let acc = emptyAccumulator('k');
    for (const value of values) acc = accumulateSample(acc, value);
    return acc;
  };
  const population: MeasurementStatsState = {
    accumulators: new Map([[1, accumulate([1, 2])], [2, accumulate([3])], [9, accumulate([4])]]),
    skipped: 2,
    lastWaveKey: '0:4',
  };
  const kept = retainMeasurementStats(population, [1, 2]);
  const none: MeasurementStatsState = { accumulators: new Map(), skipped: 0, lastWaveKey: null };
  check('a pruned row hands its accumulator back, so the histories stay bounded',
    kept.accumulators.size === 2 && !kept.accumulators.has(9) &&
      kept.accumulators.get(1) === population.accumulators.get(1) &&
      kept.skipped === 2 && kept.lastWaveKey === '0:4' &&
      retainMeasurementStats(population, [1, 2, 9]) === population &&
      retainMeasurementStats(none, []) === none,
    `kept=${[...kept.accumulators.keys()].join(',')}, ` +
    `shared=${retainMeasurementStats(population, [1, 2, 9]) === population}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
