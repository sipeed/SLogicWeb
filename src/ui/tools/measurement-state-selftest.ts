// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../../data/adcTraceFiles.js';
import { createSampleStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import { scanAnalogCodes, type AnalogCodeScan } from '../../dsp/analogScan.js';
import { ADC_ZERO_CODE, analogBusConfig, analogVoltsPerCode } from '../channelBanks.js';
import {
  MEASUREMENT_MAX_ROWS, MEASUREMENT_PARAMETERS, addMeasurementRow, defaultMeasurementConfig,
  isMeasurementBank, measurementCacheKey, measurementRowViews, measurementSources,
  reconcileMeasurementConfig, removeMeasurementRow, resolveMeasurementWindow, runMeasurement,
  selectMeasurementRange, selectMeasurementSource,
  type MeasurementBusView, type MeasurementCacheInput, type MeasurementConfig,
  type MeasurementCursor, type MeasurementReadSummary, type MeasurementSource,
  type MeasurementStatus, type MeasurementWindow,
} from '../measurementState.js';

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
}

function rowNames(config: MeasurementConfig): string {
  return config.rows.join(',');
}

{
  const all = defaultMeasurementConfig([A2, A0]);
  const none = defaultMeasurementConfig([]);
  check('the default config selects the first source, the viewport range and all three rows',
    all.source === A2.group && rowNames(all) === 'frequency,vpp,rms' &&
      all.range.kind === 'viewport' && all.range.a === null && all.range.b === null &&
      none.source === null && rowNames(none) === 'frequency,vpp,rms' &&
      MEASUREMENT_PARAMETERS.join(',') === 'frequency,vpp,rms' && MEASUREMENT_MAX_ROWS === 3,
    `source=${all.source}, rows=${rowNames(all)}, empty=${none.source}, max=${MEASUREMENT_MAX_ROWS}`);
}

{
  const clean = defaultMeasurementConfig([A2, A0]);
  const same = reconcileMeasurementConfig(clean, [A0, A2]);
  const dropped = reconcileMeasurementConfig({ ...clean, source: 2 }, [A0]);
  const dupes = reconcileMeasurementConfig(
    { ...clean, rows: ['rms', 'frequency', 'rms'] }, [A2, A0]);
  const overCap = reconcileMeasurementConfig(
    { ...clean, rows: ['rms', 'vpp', 'frequency', 'vpp'] }, [A2, A0]);
  const unselected = reconcileMeasurementConfig({ ...clean, source: null }, [A0, A2]);
  const once = reconcileMeasurementConfig(dupes, [A2, A0]);
  check('reconcile keeps a live selection and never invents one',
    same === clean && dropped.source === null && dropped !== clean &&
      unselected.source === null && reconcileMeasurementConfig(unselected, [A0, A2]) === unselected,
    `same=${same === clean}, dropped=${String(dropped.source)}, unselected=${String(unselected.source)}`);
  check('reconcile orders and de-duplicates rows inside the cap',
    rowNames(dupes) === 'frequency,rms' && rowNames(overCap) === 'frequency,vpp,rms' &&
      dupes.rows !== clean.rows && overCap.rows !== clean.rows,
    `dupes=${rowNames(dupes)}, overCap=${rowNames(overCap)}`);
  check('reconcile is idempotent and returns the same object on the second pass',
    once === dupes && reconcileMeasurementConfig(clean, [A2, A0]) === clean,
    `once=${once === dupes}`);
}

{
  const base = defaultMeasurementConfig([A0, A2]);
  const picked = selectMeasurementSource(base, [A0, A2], 2);
  const again = selectMeasurementSource(picked, [A0, A2], 2);
  const unknown = selectMeasurementSource(base, [A0, A2], 7);
  const missing = selectMeasurementSource(base, [], 0);
  const cleared = selectMeasurementSource(picked, [A0, A2], null);
  check('selecting a source validates it against the enumerated groups',
    picked.source === 2 && picked !== base && base.source === 0 &&
      again === picked && unknown === base && missing === base &&
      cleared.source === null && selectMeasurementSource(cleared, [A0, A2], null) === cleared,
    `picked=${String(picked.source)}, unknown=${String(unknown.source)}, ` +
      `missing=${String(missing.source)}, cleared=${String(cleared.source)}`);
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
      cursors.range.b === null && base.range.kind === 'viewport' && repeat === cursors &&
      cleaned.range.a === null && cleaned.range.b === null &&
      viewport.range.kind === 'viewport' && viewport.range.a === 2 && viewport.range.b === 6,
    `cursors=${JSON.stringify(cursors.range)}, cleaned=${JSON.stringify(cleaned.range)}, ` +
      `viewport=${JSON.stringify(viewport.range)}`);
}

{
  const all = defaultMeasurementConfig([A0]);
  const two = removeMeasurementRow(all, 'vpp');
  const readded = addMeasurementRow(two, 'vpp');
  const fromOne = addMeasurementRow({ ...all, rows: ['rms'] }, 'frequency');
  const removedMissing = removeMeasurementRow(two, 'vpp');
  const removedAgain = removeMeasurementRow(two, 'frequency');
  const cleared = MEASUREMENT_PARAMETERS.reduce(
    (config, parameter) => removeMeasurementRow(config, parameter), all);
  check('row reducers enforce catalog order, uniqueness and the row cap',
    rowNames(two) === 'frequency,rms' && rowNames(readded) === 'frequency,vpp,rms' &&
      rowNames(fromOne) === 'frequency,rms' && rowNames(cleared) === '',
    `two=${rowNames(two)}, readded=${rowNames(readded)}, fromOne=${rowNames(fromOne)}, ` +
      `cleared=${rowNames(cleared)}`);
  check('adding an existing or over-cap row and removing a missing row are no-ops',
    addMeasurementRow(all, 'rms') === all && addMeasurementRow(all, 'vpp') === all &&
      removedMissing === two && removedAgain.rows.join(',') === 'rms',
    `existing=${addMeasurementRow(all, 'rms') === all}, ` +
      `overCap=${addMeasurementRow(all, 'vpp') === all}, missing=${removedMissing === two}`);
}

{
  const viewportConfig = defaultMeasurementConfig([A0]);
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
const config = defaultMeasurementConfig([
  { group: 0, start: 0, gain: BUS.gain, name: analog.name },
]);
const requested: MeasurementWindow = { start: 0, end: TRACE.length };

{
  const run = runMeasurement({ store, bus: BUS, window: requested, scan: SCAN });
  const scan = run.scan;
  const read: MeasurementReadSummary = {
    analyzed: run.read.analyzed,
    requestedSamples: run.read.requestedSamples,
    truncated: run.read.truncated,
    rangeClipped: run.read.rangeClipped,
    unknownSamples: run.read.unknownSamples,
  };
  const rows = measurementRowViews(config.rows, scan, read, null);
  const vpp = rows.find((row) => row.parameter === 'vpp')!;
  const rms = rows.find((row) => row.parameter === 'rms')!;
  const frequency = rows.find((row) => row.parameter === 'frequency')!;
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
      !row.crossingCap && row.crossingCount === 6),
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
  const rows = measurementRowViews(cursorConfig.rows, scan, {
    analyzed: run.read.analyzed,
    requestedSamples: run.read.requestedSamples,
    truncated: run.read.truncated,
    rangeClipped: run.read.rangeClipped,
    unknownSamples: run.read.unknownSamples,
  }, null);
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
  const emptyRows = measurementRowViews(config.rows, run.scan, null, 'no-data');
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
  const blockedRows = measurementRowViews(config.rows, blocked, read, null);
  const onceRows = measurementRowViews(config.rows, once, read, null);
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
    config.rows, scan, gapped, status).every((row) => Number.isNaN(row.value) &&
      row.status === status && row.analyzedSamples === 0 && row.requestedSamples === 0 &&
      !row.truncated && !row.rangeClipped && !row.gaps));
  const flagged = measurementRowViews(config.rows, scan, gapped, null);
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
  const rows = measurementRowViews(config.rows, fast, {
    analyzed: 80, requestedSamples: 80, truncated: false, rangeClipped: false, unknownSamples: 0,
  }, null);
  check('a period near the sample limit is disclosed on every row',
    fast.nearSampleLimit && rows.every((row) => row.nearSampleLimit) &&
      rows.find((row) => row.parameter === 'frequency')!.status === 'ok',
    `period=${fast.periodSamples}, frequency=${fast.frequencyHz}, ` +
      `nearLimit=${rows.map((row) => row.nearSampleLimit).join(',')}`);
}

{
  const view = between(appSource,
    '  private measurementView(): MeasurementSectionView {', '  private setMeasurement(patch: {');
  const setter = between(appSource,
    '  private setMeasurement(patch: {',
    '  // ------------------------------------------------------------------ bus views');
  const scanAt = view.indexOf('runMeasurement(');
  check('the view analyses the current wave and every bus view, never display state',
    view !== '' && view.includes('const store = this.captureStore;') &&
      view.includes('measurementSources(this.busViews, store.channelCount)') &&
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
  check('the requested window is clipped to the current wave before the scan',
    view.includes('const start = Math.max(0, Math.min(window.start, store.length));') &&
      view.includes('const end = Math.max(start, Math.min(window.end, store.length));') &&
      view.includes('const clipped = start !== window.start || end !== window.end;') &&
      view.indexOf('const clipped =') < scanAt &&
      view.includes('window: { start, end },') &&
      view.includes('rangeClipped: cache.read.rangeClipped || clipped,'),
    `clippedAt=${view.indexOf('const clipped =')}, scanAt=${scanAt}`);
  check('the scan inputs come from the group trigger and the ADC scale',
    view.includes('this.settings.analogTriggers[selected.start]') &&
      view.includes('trigger.kind === \'rising\'') &&
      view.includes('analogTriggerCode(trigger.kind, trigger.volts, selected.gain)') &&
      view.includes('analogTriggerQualification(store.samplerate)') &&
      view.includes('hysteresis: qualification.analogHysteresis,') &&
      view.includes('window: qualification.analogArtifactSamples,') &&
      view.includes('zeroCode: ADC_ZERO_CODE,') &&
      view.includes('voltsPerCode: analogVoltsPerCode(selected.gain),') &&
      view.includes('bus: { bits: bus.spec.bits, group: selected.group, gain: selected.gain },'),
    `scanAt=${scanAt}`);
  check('the cache key carries the wave identity, the scan inputs and the window',
    view.includes('storeLength: store.length,') &&
      view.includes('droppedSamples: store.droppedSamples,') &&
      view.includes('samplerate: store.samplerate,') &&
      view.includes('windowStart: start,') && view.includes('windowEnd: end,') &&
      view.includes('group: selected.group,') && view.includes('gain: selected.gain,') &&
      view.includes('rising: scan.rising,') && view.includes('level: scan.level,') &&
      view.includes('hysteresis: scan.hysteresis,') && view.includes('window: scan.window,') &&
      view.includes('if (cache === null || cache.store !== store || cache.key !== key) {') &&
      view.includes('this.measurementCache = cache;'),
    `keyAt=${view.indexOf('measurementCacheKey(')}`);
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

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
