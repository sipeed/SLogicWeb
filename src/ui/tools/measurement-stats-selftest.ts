// SPDX-License-Identifier: GPL-3.0-or-later

import {
  acquisitionWaveCompleted, acquisitionWaveKey, type AcquisitionWaveFacts,
} from '../acquisitionWave.js';
import type { CaptureStopReason } from '../captureViewport.js';
import type { MeasurementParameter } from '../measurementCatalog.js';
import {
  MEASUREMENT_STATS_CAP, accumulateSample, emptyAccumulator, emptyMeasurementStats,
  excludeSample, measurementStatsKey, measurementStatsSummary, resetAllMeasurementStats,
  resetMeasurementStatsFor, submitMeasurementWave,
  type MeasurementAccumulator, type MeasurementStatsKeyInput, type MeasurementStatsState,
  type MeasurementWaveRow, type MeasurementWaveSubmission,
} from '../measurementStats.js';

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

function close(a: number, b: number, tolerance = 1e-9): boolean {
  return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}

function naive(values: readonly number[]): {
  n: number; mean: number; m2: number; min: number; max: number;
} {
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const mean = sum / values.length;
  let m2 = 0;
  for (const value of values) m2 += (value - mean) * (value - mean);
  return { n: values.length, mean, m2, min, max };
}

function seededSamples(count: number, base = 0): number[] {
  let seed = 20261116;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out.push(base + (seed / 2147483648 - 0.5) * 20 + 0.125);
  }
  return out;
}

function accumulateAll(values: readonly number[], key = 'welford'): MeasurementAccumulator {
  let acc = emptyAccumulator(key);
  for (const value of values) acc = accumulateSample(acc, value);
  return acc;
}

function throwsRange(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof RangeError;
  }
}

function facts(overrides: Partial<AcquisitionWaveFacts> = {}): AcquisitionWaveFacts {
  return { reason: 'completed', loop: false, samples: 1000, missed: false, ...overrides };
}

const ROW_VALUE: MeasurementWaveRow = { rowId: 1, key: '3:vpp', value: 1.5 };

function wave(overrides: Partial<MeasurementWaveSubmission> = {}): MeasurementWaveSubmission {
  return {
    sessionId: 3,
    generation: 1,
    loop: false,
    reason: 'completed',
    samples: 4096,
    missed: false,
    visible: true,
    rows: [ROW_VALUE],
    ...overrides,
  };
}

function countOf(state: MeasurementStatsState, rowId: number): number {
  return state.accumulators.get(rowId)?.count ?? -1;
}

const KEY_BASE: MeasurementStatsKeyInput = {
  sessionId: 7,
  source: 0,
  parameter: 'vpp',
  rangeKind: 'cursors',
  cursorA: 100,
  cursorB: 900,
  gain: 1,
  level: 128,
  rising: true,
  hysteresis: 4,
  artifactWindow: 3,
  samplerate: 100e6,
};

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sharedStopReason: MutuallyAssignable<CaptureStopReason, AcquisitionWaveFacts['reason']> = true;
const stopReasonVocabulary:
  MutuallyAssignable<CaptureStopReason, 'manual' | 'completed' | 'error'> = true;

{
  check('the statistics cap is 512 samples and never slides',
    MEASUREMENT_STATS_CAP === 512 && Number.isInteger(MEASUREMENT_STATS_CAP),
    `cap=${MEASUREMENT_STATS_CAP}`);
}

{
  const rows: [string, AcquisitionWaveFacts, boolean][] = [
    ['completed single', facts(), true],
    ['one-sample wave', facts({ samples: 1 }), true],
    ['manual stop', facts({ reason: 'manual' }), false],
    ['error stop', facts({ reason: 'error' }), false],
    ['loop retention', facts({ loop: true }), false],
    ['loop that also stopped manually', facts({ loop: true, reason: 'manual' }), false],
    ['empty wave', facts({ samples: 0 }), false],
    ['missed trigger', facts({ missed: true }), false],
    ['negative samples', facts({ samples: -1 }), false],
    ['fractional samples', facts({ samples: 11.5 }), false],
    ['NaN samples', facts({ samples: Number.NaN }), false],
    ['infinite samples', facts({ samples: Number.POSITIVE_INFINITY }), false],
    ['unsafe integer samples', facts({ samples: Number.MAX_SAFE_INTEGER + 2 }), false],
  ];
  const actual = rows.map(([, input, expected]) => {
    const got = acquisitionWaveCompleted(input);
    return `${got === expected ? 'ok' : 'BAD'}(${got})`;
  });
  check('the shared completion predicate accepts only completed, non-loop, nonempty, non-missed waves',
    actual.every((entry) => entry.startsWith('ok')),
    actual.join(' '));
}

{
  const key = acquisitionWaveKey(4, 17);
  const invalid: [string, () => string][] = [
    ['negative session', () => acquisitionWaveKey(-1, 0)],
    ['fractional session', () => acquisitionWaveKey(1.5, 0)],
    ['NaN session', () => acquisitionWaveKey(Number.NaN, 0)],
    ['negative generation', () => acquisitionWaveKey(0, -2)],
    ['fractional generation', () => acquisitionWaveKey(0, 2.25)],
    ['infinite generation', () => acquisitionWaveKey(0, Number.POSITIVE_INFINITY)],
  ];
  const thrown = invalid.map(([, run]) => throwsRange(run));
  check('a wave key is the exact session:generation pair and rejects invalid indices',
    key === '4:17' && acquisitionWaveKey(0, 0) === '0:0' &&
      acquisitionWaveKey(4, 17) === key && acquisitionWaveKey(4, 18) !== key &&
      acquisitionWaveKey(5, 17) !== key && acquisitionWaveKey(41, 7) !== key &&
      thrown.every(Boolean),
    `key=${key} thrown=${thrown.join(',')}`);
}

{
  const viewport = fs.readFileSync('src/ui/captureViewport.ts', 'utf8');
  const waveSource = fs.readFileSync('src/ui/acquisitionWave.ts', 'utf8');
  const declarationNeedle = /export type CaptureStopReason\b/;
  const canonicalNeedle = "export type CaptureStopReason = 'manual' | 'completed' | 'error';";
  const waveImportNeedle = "import type { CaptureStopReason } from './captureViewport.js';";
  const duplicated = "export type CaptureStopReason = 'manual' | 'completed';";
  const scannerControl = declarationNeedle.test(duplicated) && !duplicated.includes(waveImportNeedle);
  const declarations = [viewport, waveSource].filter((text) => declarationNeedle.test(text)).length;
  check('one stop-reason declaration is shared by the wave model, the session and the viewport',
    sharedStopReason && stopReasonVocabulary && viewport.includes(canonicalNeedle) &&
      !declarationNeedle.test(waveSource) && waveSource.includes(waveImportNeedle) &&
      declarations === 1 && scannerControl,
    `shared=${sharedStopReason} vocabulary=${stopReasonVocabulary} ` +
      `canonical=${viewport.includes(canonicalNeedle)} ` +
      `waveDeclares=${declarationNeedle.test(waveSource)} declarations=${declarations} ` +
      `scannerControl=${scannerControl}`);
}

{
  const samples = seededSamples(257);
  const acc = accumulateAll(samples);
  const reference = naive(samples);
  const summary = measurementStatsSummary(acc);
  check('Welford matches an independent naive mean/M2/min/max over 257 samples',
    acc.count === 257 && acc.count === reference.n &&
      close(acc.mean, reference.mean) && close(acc.m2, reference.m2, 1e-8) &&
      summary.stdDev !== null && close(summary.stdDev, Math.sqrt(reference.m2 / 256)) &&
      acc.min === reference.min && acc.max === reference.max &&
      acc.excluded === 0 && !acc.capped,
    `count=${acc.count} mean=${acc.mean}/${reference.mean} m2=${acc.m2}/${reference.m2} ` +
      `stdDev=${summary.stdDev} min=${acc.min} max=${acc.max}`);
}

{
  const offsets = Array.from({ length: 400 }, (_, i) => i);
  const values = offsets.map((i) => 1e9 + i);
  const exactMean = 1e9 + 199.5;
  let exactM2 = 0;
  for (const offset of offsets) exactM2 += (offset - 199.5) * (offset - 199.5);
  const acc = accumulateAll(values);
  const summary = measurementStatsSummary(acc);
  const naiveSquares = 1e18 + 1e9 * 399 + (offsets.reduce((sum, i) => sum + i * i, 0) / 400) -
    (1e9 + 199.5) * (1e9 + 199.5);
  check('a large-magnitude small-variance run keeps an exact mean and M2 where naive squares drift',
    close(acc.mean, exactMean, 1e-12) && close(acc.m2, exactM2, 1e-9) &&
      acc.m2 >= 0 && summary.stdDev !== null &&
      close(summary.stdDev, Math.sqrt(exactM2 / 399), 1e-9) &&
      !close(naiveSquares, exactM2 / 400, 1e-4),
    `mean=${acc.mean}/${exactMean} m2=${acc.m2}/${exactM2} stdDev=${summary.stdDev} ` +
      `naiveSquares=${naiveSquares}/${exactM2 / 400}`);
}

{
  const pair = accumulateAll([1e9 + 1, 1e9 + 3]);
  const summary = measurementStatsSummary(pair);
  check('two samples one code apart far from zero give the exact mean and M2',
    pair.mean === 1e9 + 2 && pair.m2 === 2 && pair.min === 1e9 + 1 && pair.max === 1e9 + 3 &&
      summary.stdDev === Math.sqrt(2),
    `mean=${pair.mean} m2=${pair.m2} stdDev=${summary.stdDev}`);
}

{
  const runs = [seededSamples(3), seededSamples(33), seededSamples(257), seededSamples(512)];
  const negativeM2 = runs.filter((values) => accumulateAll(values).m2 < 0);
  const nanStdDev = runs.filter((values) => {
    const summary = measurementStatsSummary(accumulateAll(values));
    return summary.stdDev !== null && Number.isNaN(summary.stdDev);
  });
  const descending = [512, -512, 1e-9, 1e9, 0, -0.5, 7];
  const descendingAcc = accumulateAll(descending);
  check('M2 never goes negative and StdDev is never a NaN for finite samples',
    negativeM2.length === 0 && nanStdDev.length === 0 && descendingAcc.m2 >= 0 &&
      Math.sqrt(descendingAcc.m2) >= 0,
    `negativeM2=${negativeM2.length} nanStdDev=${nanStdDev.length} ` +
      `descendingM2=${descendingAcc.m2}`);
}

{
  const one = accumulateSample(emptyAccumulator('k'), 2.5);
  const oneSummary = measurementStatsSummary(one);
  const empty = measurementStatsSummary(emptyAccumulator('k'));
  const pair = accumulateSample(accumulateSample(emptyAccumulator('k'), 0), 10);
  const pairSummary = measurementStatsSummary(pair);
  check('N=1 renders no StdDev and N=2 is exact, with NaN extrema before the first sample',
    oneSummary.count === 1 && oneSummary.stdDev === null &&
      oneSummary.mean === 2.5 && oneSummary.min === 2.5 && oneSummary.max === 2.5 &&
      empty.count === 0 && empty.stdDev === null && Number.isNaN(empty.mean) &&
      Number.isNaN(empty.min) && Number.isNaN(empty.max) && empty.capped === false &&
      pairSummary.stdDev === Math.sqrt(50) && pairSummary.mean === 5 && pair.count === 2,
    `one=${JSON.stringify(oneSummary)} empty=${JSON.stringify(empty)} ` +
      `pairStdDev=${pairSummary.stdDev}/${Math.sqrt(50)}`);
}

{
  let acc = emptyAccumulator('cap');
  for (let i = 1; i <= MEASUREMENT_STATS_CAP; i += 1) acc = accumulateSample(acc, i);
  const atCap = acc;
  const overCap = accumulateSample(atCap, 100000);
  const stillCapped = accumulateSample(overCap, 200000);
  const sliding = naive([...Array.from({ length: MEASUREMENT_STATS_CAP - 1 }, (_, i) => i + 2), 200000]);
  const reference = naive(Array.from({ length: MEASUREMENT_STATS_CAP }, (_, i) => i + 1));
  const summary = measurementStatsSummary(stillCapped);
  check('the 513th sample is dropped, the cap is disclosed, and the population never slides',
    atCap.count === MEASUREMENT_STATS_CAP && atCap.capped === false &&
      close(atCap.mean, reference.mean) &&
      overCap !== atCap && overCap.capped && overCap.count === MEASUREMENT_STATS_CAP &&
      overCap.mean === atCap.mean && overCap.m2 === atCap.m2 &&
      overCap.min === atCap.min && overCap.max === atCap.max &&
      stillCapped === overCap && summary.capped &&
      !close(summary.mean, sliding.mean, 1e-6),
    `count=${overCap.count} mean=${summary.mean} slidingWould=${sliding.mean} ` +
      `cappedAt=${atCap.capped} droppedSetsCapped=${overCap.capped} ` +
      `sameRef=${stillCapped === overCap}`);
}

{
  const base = accumulateSample(accumulateSample(emptyAccumulator('k'), 2), 4);
  const excluded = excludeSample(base);
  const excludedTwice = excludeSample(excluded);
  const thrown = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map((value) =>
    throwsRange(() => accumulateSample(base, value)));
  const emptyExcluded = excludeSample(emptyAccumulator('k'));
  check('exclusion only counts, never enters or caps, and non-finite samples throw',
    excluded.excluded === 1 && excludedTwice.excluded === 2 &&
      excludedTwice.count === base.count && excludedTwice.mean === base.mean &&
      excludedTwice.m2 === base.m2 && excludedTwice.min === base.min &&
      excludedTwice.max === base.max && !excludedTwice.capped &&
      emptyExcluded.excluded === 1 && emptyExcluded.count === 0 &&
      Number.isNaN(emptyExcluded.min) && thrown.every(Boolean),
    `excluded=${excludedTwice.excluded} count=${excludedTwice.count} thrown=${thrown.join(',')}`);
}

{
  const shape = Object.keys(emptyAccumulator('k')).sort().join(',');
  check('an accumulator stays constant memory with the documented field set',
    shape === 'capped,count,excluded,key,m2,max,mean,min',
    shape);
}

{
  const fields = Object.keys(KEY_BASE).sort().join(',');
  const baseKey = measurementStatsKey(KEY_BASE);
  const mutations: [string, MeasurementStatsKeyInput][] = [
    ['sessionId', { ...KEY_BASE, sessionId: 8 }],
    ['source', { ...KEY_BASE, source: 8 }],
    ['parameter', { ...KEY_BASE, parameter: 'rms' }],
    ['rangeKind', { ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null }],
    ['cursorA', { ...KEY_BASE, cursorA: 101 }],
    ['cursorB', { ...KEY_BASE, cursorB: 901 }],
    ['gain', { ...KEY_BASE, gain: 3 }],
    ['level', { ...KEY_BASE, level: 129 }],
    ['rising', { ...KEY_BASE, rising: false }],
    ['hysteresis', { ...KEY_BASE, hysteresis: 5 }],
    ['artifactWindow', { ...KEY_BASE, artifactWindow: 4 }],
    ['samplerate', { ...KEY_BASE, samplerate: 50e6 }],
  ];
  const changed = mutations.map(([field, input]) =>
    `${field}:${measurementStatsKey(input) !== baseKey ? 'ok' : 'SAME'}`);
  const keys = new Set([baseKey, ...mutations.map(([, input]) => measurementStatsKey(input))]);
  check('the statistics key is stable and distinguishes every documented input field',
    baseKey === measurementStatsKey({ ...KEY_BASE }) && keys.size === mutations.length + 1 &&
      changed.every((entry) => entry.endsWith(':ok')) &&
      fields === 'artifactWindow,cursorA,cursorB,gain,hysteresis,level,parameter,rangeKind,' +
        'rising,samplerate,sessionId,source',
    `${changed.join(' ')} distinct=${keys.size}/${mutations.length + 1} fields=${fields}`);
}

{
  const viewport: MeasurementStatsKeyInput = {
    ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null,
  };
  const capture: MeasurementStatsKeyInput = { ...viewport, rangeKind: 'capture' };
  const viewportKey = measurementStatsKey(viewport);
  const captureKey = measurementStatsKey(capture);
  const cursorKey = measurementStatsKey(KEY_BASE);
  check('cursor fields participate only for the cursors range and all three ranges stay distinct',
    measurementStatsKey({ ...viewport, cursorA: 10, cursorB: 20 }) === viewportKey &&
      measurementStatsKey({ ...capture, cursorA: 10, cursorB: 20 }) === captureKey &&
      measurementStatsKey({ ...KEY_BASE, cursorA: 20, cursorB: 10 }) !== cursorKey &&
      measurementStatsKey({ ...KEY_BASE, cursorA: null, cursorB: 900 }) !== cursorKey &&
      new Set([viewportKey, captureKey, cursorKey]).size === 3,
    `viewportStable=${measurementStatsKey({ ...viewport, cursorA: 10, cursorB: 20 }) === viewportKey} ` +
      `captureStable=${measurementStatsKey({ ...capture, cursorA: 10, cursorB: 20 }) === captureKey} ` +
      `kinds=${new Set([viewportKey, captureKey, cursorKey]).size}`);
}

{
  const selection: MeasurementStatsKeyInput = {
    ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null,
  };
  const key = measurementStatsKey(selection);
  const pan: readonly { start: number; end: number; value: number }[] = [
    { start: 0, end: 8192, value: 3.3 },
    { start: 4096, end: 12288, value: 3.34 },
    { start: 9000, end: 17192, value: 3.28 },
  ];
  const windowedKeys = pan.map((step) => `${key}|${step.start}|${step.end}`);
  let state = emptyMeasurementStats();
  const counts: number[] = [];
  const offered: number[] = [];
  pan.forEach((step, index) => {
    const result = submitMeasurementWave(state, wave({
      generation: index + 1, rows: [{ rowId: 1, key, value: step.value }],
    }));
    state = result.state;
    offered.push(result.submitted);
    counts.push(countOf(state, 1));
  });
  const acc = state.accumulators.get(1);
  let fragmented = emptyMeasurementStats();
  const fragmentedCounts = pan.map((step, index) => {
    fragmented = submitMeasurementWave(fragmented, wave({
      generation: index + 1,
      rows: [{ rowId: 1, key: windowedKeys[index], value: step.value }],
    })).state;
    return countOf(fragmented, 1);
  });
  check('three visible Repeat waves with different transient windows stay one population',
    new Set(windowedKeys).size === pan.length && new Set(offered).size === 1 &&
      offered[0] === 1 && counts.join(',') === '1,2,3' && acc !== undefined &&
      acc.count === 3 && acc.capped === false &&
      close(acc.mean, (3.3 + 3.34 + 3.28) / 3) && state.skipped === 0 &&
      state.lastWaveKey === acquisitionWaveKey(3, 3) &&
      fragmentedCounts.join(',') === '1,1,1' && fragmented.skipped === 0,
    `windows=${new Set(windowedKeys).size} offered=${offered.join(',')} ` +
      `counts=${counts.join(',')} count=${acc?.count} mean=${acc?.mean} ` +
      `windowInKeyWouldFragment=${fragmentedCounts.join(',')}`);
}

{
  const cursors = (a: number | null, b: number | null): MeasurementStatsKeyInput => ({
    ...KEY_BASE, rangeKind: 'cursors', cursorA: a, cursorB: b,
  });
  const steps: MeasurementStatsKeyInput[] = [
    cursors(100, 900),
    cursors(100, 900),
    cursors(100, 901),
    { ...cursors(null, null), rangeKind: 'viewport' },
    { ...cursors(null, null), rangeKind: 'capture' },
    cursors(100, 900),
  ];
  let state = emptyMeasurementStats();
  const counts: number[] = [];
  steps.forEach((selection, index) => {
    const key = measurementStatsKey(selection);
    state = submitMeasurementWave(state, wave({
      generation: index + 1, rows: [{ rowId: 1, key, value: index + 1 }],
    })).state;
    counts.push(countOf(state, 1));
  });
  check('a range-selection change restarts the population and returning does not resume it',
    counts.join(',') === '1,2,1,1,1,1' && state.skipped === 0 &&
      state.accumulators.get(1)?.count === 1 &&
      new Set(steps.map((selection) => measurementStatsKey(selection))).size === 4,
    `counts=${counts.join(',')} distinct=${new Set(steps.map((s) => measurementStatsKey(s))).size}`);
}

{
  const selection: MeasurementStatsKeyInput = { ...KEY_BASE };
  const key = measurementStatsKey(selection);
  const churn: readonly (MeasurementStatsKeyInput & {
    theme: string; locale: string; panel: string; visible: boolean;
  })[] = [
    { ...selection, theme: 'dark', locale: 'en', panel: 'cursors', visible: true },
    { ...selection, theme: 'light', locale: 'en', panel: 'cursors', visible: true },
    { ...selection, theme: 'light', locale: 'zh-CN', panel: 'measure', visible: false },
    { ...selection, theme: 'dark', locale: 'zh-CN', panel: 'plot', visible: true },
  ];
  let state = emptyMeasurementStats();
  let hiddenKeptAccumulator = false;
  const keys: string[] = [];
  const counts: number[] = [];
  churn.forEach((step, index) => {
    keys.push(measurementStatsKey(step));
    const previous = state.accumulators.get(1);
    state = submitMeasurementWave(state, wave({
      generation: index + 1, visible: step.visible,
      rows: [{ rowId: 1, key, value: index + 1 }],
    })).state;
    const current = state.accumulators.get(1);
    if (!step.visible && previous !== undefined) hiddenKeptAccumulator = current === previous;
    counts.push(countOf(state, 1));
  });
  check('theme, locale and panel-only changes never reset a population',
    new Set(keys).size === 1 && keys[0] === key && hiddenKeptAccumulator &&
      counts.join(',') === '1,2,2,3' && state.skipped === 1 &&
      state.accumulators.get(1)?.count === 3 &&
      close(state.accumulators.get(1)?.mean ?? Number.NaN, (1 + 2 + 4) / 3),
    `keys=${new Set(keys).size} hiddenKept=${hiddenKeptAccumulator} ` +
      `counts=${counts.join(',')} skipped=${state.skipped}`);
}

{
  const baseKey = measurementStatsKey({ ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null });
  const same = (input: Partial<MeasurementStatsKeyInput>, base = KEY_BASE): boolean =>
    measurementStatsKey({ ...base, rangeKind: 'viewport', cursorA: null, cursorB: null, ...input }) === baseKey;
  const distinctPairs: [number, number][] = [
    [0, -0],
    [0.1 + 0.2, 0.3],
    [1e21, 1e21 + 1e5],
    [2 ** 53, 2 ** 53 + 2],
    [1 / 3, 1 / 3 + Number.EPSILON],
    [5e-324, 1e-323],
    [1.7976931348623157e308, 1.7976931348623155e308],
  ];
  const collisions = distinctPairs.filter(([a, b]) =>
    measurementStatsKey({ ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null, gain: a }) ===
      measurementStatsKey({ ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null, gain: b }));
  const rejected: [string, () => string][] = [
    ['NaN gain', () => measurementStatsKey({ ...KEY_BASE, gain: Number.NaN })],
    ['infinite samplerate', () => measurementStatsKey({ ...KEY_BASE, samplerate: Number.POSITIVE_INFINITY })],
    ['NaN cursor', () => measurementStatsKey({ ...KEY_BASE, cursorA: Number.NaN })],
    ['fractional session', () => measurementStatsKey({ ...KEY_BASE, sessionId: 1.5 })],
    ['unsafe session', () => measurementStatsKey({ ...KEY_BASE, sessionId: 2 ** 53 })],
    ['negative source', () => measurementStatsKey({ ...KEY_BASE, source: -8 })],
    ['unknown parameter', () => measurementStatsKey({ ...KEY_BASE, parameter: 'jitter' as MeasurementParameter })],
    ['unknown range', () => measurementStatsKey({ ...KEY_BASE, rangeKind: 'window' as 'viewport' })],
  ];
  const rejectedOk = rejected.map(([, run]) => throwsRange(run));
  check('canonical key text never collides for distinct doubles and rejects unusable fields',
    collisions.length === 0 && rejectedOk.every(Boolean) &&
      same({ gain: 1 }) && !same({ gain: 2 }) &&
      measurementStatsKey({ ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null, gain: -0 }) !==
        measurementStatsKey({ ...KEY_BASE, rangeKind: 'viewport', cursorA: null, cursorB: null, gain: 0 }),
    `collisions=${collisions.map(([a, b]) => `${a}/${b}`).join(' ')} rejected=${rejectedOk.join(',')}`);
}

{
  const start = emptyMeasurementStats();
  const looped = submitMeasurementWave(start, wave({ loop: true }));
  const manual = submitMeasurementWave(start, wave({ reason: 'manual' }));
  const errored = submitMeasurementWave(start, wave({ reason: 'error' }));
  const emptyWave = submitMeasurementWave(start, wave({ samples: 0 }));
  const missed = submitMeasurementWave(start, wave({ missed: true }));
  const all = [looped, manual, errored, emptyWave, missed];
  check('Loop, manual, error, empty and missed notifications submit and skip nothing',
    all.every((result) => result.state === start && result.submitted === 0 &&
      result.skipped === 0 && !result.duplicate) &&
      start.accumulators.size === 0 && start.skipped === 0 && start.lastWaveKey === null,
    all.map((r) => `${r.submitted}/${r.skipped}/${r.duplicate}`).join(' '));
}

{
  let state = emptyMeasurementStats();
  const offered: number[] = [];
  for (const generation of [1, 2, 3]) {
    const result = submitMeasurementWave(state, wave({
      generation, rows: [{ ...ROW_VALUE, value: generation }],
    }));
    state = result.state;
    offered.push(result.submitted);
  }
  const acc = state.accumulators.get(1);
  check('three eligible visible waves contribute exactly three samples',
    acc !== undefined && acc.count === 3 && acc.mean === 2 &&
      offered.join(',') === '1,1,1' && state.skipped === 0 &&
      state.lastWaveKey === acquisitionWaveKey(3, 3),
    `count=${countOf(state, 1)} mean=${acc?.mean} offered=${offered.join(',')} ` +
      `lastWaveKey=${state.lastWaveKey}`);
}

{
  let state = emptyMeasurementStats();
  state = submitMeasurementWave(state, wave({ generation: 1 })).state;
  const once = state;
  const repeat = submitMeasurementWave(once, wave({ generation: 1 }));
  let churn: MeasurementStatsState = once;
  let churnDuplicates = 0;
  for (let frame = 0; frame < 500; frame += 1) {
    const result = submitMeasurementWave(churn, wave({ generation: 1 }));
    churn = result.state;
    if (result.duplicate) churnDuplicates += 1;
  }
  const next = submitMeasurementWave(once, wave({ generation: 2 })).state;
  check('a duplicate wave key never adds twice, including 500 frame-style re-notifications',
    repeat.duplicate && repeat.submitted === 0 && repeat.state === once &&
      countOf(repeat.state, 1) === 1 && churnDuplicates === 500 &&
      countOf(churn, 1) === 1 && countOf(next, 1) === 2,
    `duplicate=${repeat.duplicate} churnDuplicates=${churnDuplicates} ` +
      `countOnce=${countOf(once, 1)} countNext=${countOf(next, 1)}`);
}

{
  let state = emptyMeasurementStats();
  const hidden = submitMeasurementWave(state, wave({ generation: 1, visible: false }));
  state = hidden.state;
  const hiddenAgain = submitMeasurementWave(state, wave({ generation: 1, visible: false }));
  const backfill = submitMeasurementWave(state, wave({ generation: 1, visible: true }));
  const visible = submitMeasurementWave(state, wave({ generation: 2, visible: true }));
  state = visible.state;
  const hiddenSecond = submitMeasurementWave(state, wave({ generation: 3, visible: false }));
  state = hiddenSecond.state;
  check('a hidden eligible wave is disclosed once, never back-filled, and later visible waves count',
    hidden.skipped === 1 && hidden.submitted === 0 && !hidden.duplicate &&
      hidden.state.accumulators.get(1) === undefined && hidden.state.skipped === 1 &&
      hiddenAgain.duplicate && hiddenAgain.skipped === 0 && backfill.duplicate &&
      backfill.skipped === 0 && hidden.state.skipped === 1 &&
      visible.submitted === 1 && visible.skipped === 0 &&
      state.skipped === 2 && countOf(state, 1) === 1,
    `skipped=${state.skipped} count=${countOf(state, 1)} ` +
      `hiddenAgainDuplicate=${hiddenAgain.duplicate} backfillDuplicate=${backfill.duplicate}`);
}

{
  let state = emptyMeasurementStats();
  state = submitMeasurementWave(state, wave({ generation: 1, rows: [] })).state;
  const listed = submitMeasurementWave(state, wave({ generation: 1, rows: [ROW_VALUE] }));
  const nextWave = submitMeasurementWave(state, wave({ generation: 2, rows: [ROW_VALUE] }));
  check('an eligible wave with no rows still consumes its generation exactly once',
    state.accumulators.size === 0 && state.lastWaveKey === acquisitionWaveKey(3, 1) &&
      listed.duplicate && listed.submitted === 0 && countOf(listed.state, 1) === -1 &&
      nextWave.submitted === 1 && countOf(nextWave.state, 1) === 1,
    `listedDuplicate=${listed.duplicate} nextSubmitted=${nextWave.submitted} ` +
      `count=${countOf(nextWave.state, 1)}`);
}

{
  let state = emptyMeasurementStats();
  state = submitMeasurementWave(state, wave({
    generation: 1, rows: [{ rowId: 1, key: 'a', value: 2 }],
  })).state;
  state = submitMeasurementWave(state, wave({
    generation: 2, rows: [{ rowId: 1, key: 'a', value: 4 }],
  })).state;
  const neighbourBefore = state.accumulators.get(1);
  const changed = submitMeasurementWave(state, wave({
    generation: 3,
    rows: [
      { rowId: 1, key: 'b', value: 100 },
      { rowId: 2, key: 'c', value: null },
    ],
  }));
  state = changed.state;
  const resetRow = resetMeasurementStatsFor(state, 1);
  const readded = submitMeasurementWave(state, wave({
    generation: 4, rows: [{ rowId: 9, key: 'a', value: 7 }],
  }));
  check('a key change restarts one row, a null result is excluded, and a new row id starts empty',
    neighbourBefore?.count === 2 && countOf(state, 1) === 1 &&
      state.accumulators.get(1)?.mean === 100 &&
      state.accumulators.get(2)?.count === 0 && state.accumulators.get(2)?.excluded === 1 &&
      changed.submitted === 1 && !resetRow.accumulators.has(1) &&
      resetRow.accumulators.has(2) && resetRow.skipped === state.skipped &&
      resetRow.lastWaveKey === state.lastWaveKey &&
      countOf(readded.state, 9) === 1 && countOf(readded.state, 2) === 0 &&
      readded.state.accumulators.get(1) !== undefined,
    `row1=${countOf(state, 1)} mean1=${state.accumulators.get(1)?.mean} ` +
      `row2Excluded=${state.accumulators.get(2)?.excluded} submitted=${changed.submitted} ` +
      `resetRow1=${resetRow.accumulators.has(1)} newRow=${countOf(readded.state, 9)}`);
}

{
  const state = submitMeasurementWave(emptyMeasurementStats(), wave()).state;
  const untouched = submitMeasurementWave(state, wave({
    generation: 2, rows: [{ rowId: 5, key: 'other', value: 1 }],
  }));
  const excluded = submitMeasurementWave(state, wave({
    generation: 3, rows: [{ rowId: 1, key: ROW_VALUE.key, value: Number.NaN }],
  }));
  check('rows absent from a submission keep their own history and NaN results are excluded',
    untouched.state.accumulators.get(1) === state.accumulators.get(1) &&
      countOf(untouched.state, 1) === 1 && countOf(untouched.state, 5) === 1 &&
      countOf(excluded.state, 1) === 1 && excluded.state.accumulators.get(1)?.excluded === 1 &&
      excluded.submitted === 0 && state.accumulators.get(1)?.excluded === 0,
    `keptSameRef=${untouched.state.accumulators.get(1) === state.accumulators.get(1)} ` +
      `excluded=${excluded.state.accumulators.get(1)?.excluded}`);
}

{
  let state = emptyMeasurementStats();
  let cappedAt = -1;
  let submittedAtCap = -1;
  let submittedAfterCap = -1;
  const values: number[] = [];
  for (let generation = 1; generation <= MEASUREMENT_STATS_CAP + 1; generation += 1) {
    const result = submitMeasurementWave(state, wave({
      generation, rows: [{ rowId: 1, key: 'k', value: generation }],
    }));
    state = result.state;
    values.push(generation);
    if (state.accumulators.get(1)?.capped && cappedAt < 0) {
      cappedAt = generation;
      submittedAtCap = result.submitted;
    }
    if (generation === MEASUREMENT_STATS_CAP + 1) submittedAfterCap = result.submitted;
  }
  const acc = state.accumulators.get(1) as MeasurementAccumulator;
  const reference = naive(values.slice(0, MEASUREMENT_STATS_CAP));
  const sliding = naive(values.slice(1));
  check('submissions stop at the cap, keep the first 512 samples and never slide',
    cappedAt === MEASUREMENT_STATS_CAP + 1 && submittedAtCap === 1 && submittedAfterCap === 1 &&
      acc.count === MEASUREMENT_STATS_CAP && acc.capped &&
      close(acc.mean, reference.mean) && acc.min === 1 &&
      acc.max === MEASUREMENT_STATS_CAP && !close(acc.mean, sliding.mean, 1e-6) &&
      state.skipped === 0,
    `cappedAt=${cappedAt} count=${acc.count} mean=${acc.mean}/${reference.mean} ` +
      `slidingWould=${sliding.mean}`);
}

{
  let state = emptyMeasurementStats();
  for (let generation = 1; generation <= 3; generation += 1) {
    state = submitMeasurementWave(state, wave({
      generation, rows: [{ rowId: 1, key: 'k', value: generation }],
    })).state;
  }
  const beforeKeyChange = state;
  const changed = submitMeasurementWave(state, wave({
    generation: 4, rows: [{ rowId: 1, key: 'k2', value: 10 }],
  })).state;
  const afterChange = submitMeasurementWave(changed, wave({
    generation: 5, rows: [{ rowId: 1, key: 'k2', value: 20 }],
  })).state;
  check('a population key change starts a fresh count instead of sliding the old window',
    countOf(beforeKeyChange, 1) === 3 && countOf(changed, 1) === 1 &&
      changed.accumulators.get(1)?.mean === 10 && countOf(afterChange, 1) === 2 &&
      afterChange.accumulators.get(1)?.mean === 15 &&
      afterChange.accumulators.get(1)?.min === 10,
    `before=${countOf(beforeKeyChange, 1)} restarted=${countOf(changed, 1)} ` +
      `mean=${afterChange.accumulators.get(1)?.mean}`);
}

{
  let state = emptyMeasurementStats();
  state = submitMeasurementWave(state, wave({ generation: 1, visible: false })).state;
  state = submitMeasurementWave(state, wave({ generation: 2 })).state;
  state = submitMeasurementWave(state, wave({ generation: 3, visible: false })).state;
  const before = JSON.stringify({ skipped: state.skipped, count: countOf(state, 1) });
  const cleared = resetAllMeasurementStats(state);
  const duplicate = submitMeasurementWave(cleared, wave({ generation: 3 }));
  const fresh = submitMeasurementWave(cleared, wave({ generation: 4 }));
  const pristine = emptyMeasurementStats();
  const noopReset = resetAllMeasurementStats(pristine);
  check('reset all clears history and skipped yet keeps duplicate protection and accepts new waves',
    state.skipped === 2 && countOf(state, 1) === 1 && cleared.accumulators.size === 0 &&
      cleared.skipped === 0 && cleared.lastWaveKey === state.lastWaveKey &&
      duplicate.duplicate && countOf(duplicate.state, 1) === -1 &&
      fresh.submitted === 1 && countOf(fresh.state, 1) === 1 &&
      noopReset === pristine && noopReset.accumulators.size === 0 &&
      before === JSON.stringify({ skipped: 2, count: 1 }),
    `skipped=${state.skipped} clearedSkipped=${cleared.skipped} ` +
      `duplicateAfterReset=${duplicate.duplicate} freshCount=${countOf(fresh.state, 1)}`);
}

{
  const state = submitMeasurementWave(emptyMeasurementStats(), wave()).state;
  const one = resetMeasurementStatsFor(state, 1);
  const absent = resetMeasurementStatsFor(state, 42);
  const submittedAfterReset = submitMeasurementWave(one, wave({ generation: 2 }));
  check('resetting one row clears only that row and later waves repopulate it',
    one.accumulators.size === 0 && one.skipped === state.skipped &&
      absent === state && submittedAfterReset.submitted === 1 &&
      countOf(submittedAfterReset.state, 1) === 1,
    `afterReset=${one.accumulators.size} absentSameRef=${absent === state} ` +
      `count=${countOf(submittedAfterReset.state, 1)}`);
}

{
  const state = emptyMeasurementStats();
  const before = JSON.stringify(state);
  const submitted = submitMeasurementWave(state, wave({ generation: 12 }));
  const replaced = submitMeasurementWave(submitted.state, wave({
    generation: 13, sessionId: 4, rows: [{ rowId: 1, key: '4:vpp', value: 9 }],
  }));
  check('submission never mutates the state it is given and a new session restarts the population',
    JSON.stringify(state) === before && state.accumulators.size === 0 &&
      submitted.state !== state && submitted.state.accumulators !== state.accumulators &&
      submitted.state.lastWaveKey === '3:12' && replaced.state.lastWaveKey === '4:13' &&
      countOf(submitted.state, 1) === 1 && countOf(replaced.state, 1) === 1 &&
      replaced.state.accumulators.get(1)?.key === '4:vpp',
    `unchanged=${JSON.stringify(state) === before} ` +
      `lastWaveKeys=${submitted.state.lastWaveKey}/${replaced.state.lastWaveKey}`);
}

{
  const state = emptyMeasurementStats();
  const duplicateRow = (): unknown => submitMeasurementWave(state, wave({
    generation: 1, rows: [ROW_VALUE, { ...ROW_VALUE, value: 9 }],
  }));
  const badId = (): unknown => submitMeasurementWave(state, wave({
    generation: 1, rows: [{ ...ROW_VALUE, rowId: -1 }],
  }));
  const fractionalId = (): unknown => submitMeasurementWave(state, wave({
    generation: 1, rows: [{ ...ROW_VALUE, rowId: 1.5 }],
  }));
  const thrown = [duplicateRow, badId, fractionalId].map(throwsRange);
  check('one wave cannot offer the same row twice and every row id must be a real index',
    thrown.every(Boolean) && state.accumulators.size === 0 && state.lastWaveKey === null,
    `thrown=${thrown.join(',')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
