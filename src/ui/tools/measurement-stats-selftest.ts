// SPDX-License-Identifier: GPL-3.0-or-later

import {
  acquisitionWaveCompleted, acquisitionWaveKey, type AcquisitionWaveFacts,
} from '../acquisitionWave.js';
import type { CaptureStopReason } from '../captureViewport.js';
import type { MeasurementParameter } from '../measurementCatalog.js';
import { measurementMatrixView } from '../measurementRows.js';
import type { MeasurementRowView, MeasurementSectionView } from '../measurementState.js';
import {
  MEASUREMENT_STATS_CAP, accumulateSample, emptyAccumulator, emptyMeasurementStats,
  excludeSample, measurementStatsKey, measurementStatsSummary, measurementStatsView,
  resetAllMeasurementStats, resetMeasurementStatsFor, submitMeasurementWave,
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

const app = fs.readFileSync('src/ui/app.ts', 'utf8');

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + from.length);
  return start < 0 || end <= start ? '' : text.slice(start, end);
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

{
  const finish = between(app, "private finishCapture(reason: CaptureStopReason = 'manual'): void {",
    '// ------------------------------------------------------------------ analyzers');
  const record = between(app, 'private recordMeasurementWave(reason: CaptureStopReason): void {',
    'private measurementView(): MeasurementSectionView {');
  const settled = finish.indexOf('this.recordMeasurementWave(reason);');
  check('one submission sits at the end of finishCapture, after the store and rows settle',
    finish.length > 0 && record.length > 0 && settled > finish.indexOf('this.renderPanels();') &&
      settled > finish.indexOf('this.syncUnloadGuard();') &&
      settled < finish.indexOf('const waiters = this.captureWaiters;') &&
      finish.split('this.recordMeasurementWave(reason);').length - 1 === 1,
    `record=${record.length}, at=${settled}, waiters=${finish.indexOf('const waiters')}`);
  const late = finish.replace('    this.recordMeasurementWave(reason);\n', '')
    + '\n    this.recordMeasurementWave(reason);';
  const twice = finish.replace('this.syncUnloadGuard();',
    'this.syncUnloadGuard(); this.recordMeasurementWave(reason);');
  const wires = (body: string): boolean =>
    body.indexOf('this.recordMeasurementWave(reason);') > body.indexOf('this.renderPanels();') &&
    body.indexOf('this.recordMeasurementWave(reason);') <
      body.indexOf('const waiters = this.captureWaiters;') &&
    body.split('this.recordMeasurementWave(reason);').length - 1 === 1;
  check('a submission after the waiters or a second one per stop fails that placement control',
    !wires(late) && !wires(twice) && wires(finish),
    `late=${wires(late)}, twice=${wires(twice)}, finish=${wires(finish)}`);

  const submitted = (body: string): boolean =>
    body.includes('submitMeasurementWave(this.measurementStats, {') &&
    body.includes('sessionId: this.captureSessionId,') &&
    body.includes('generation: this.captureWaveGeneration,') &&
    body.includes('loop: this.captureIsLoop,') &&
    body.includes("reason: this.captureAbort === null ? reason : 'error',") &&
    body.includes('samples: store.length,') &&
    body.includes("missed: this.triggerState === 'not-found',") &&
    body.includes("const visible = this.measurePageShown() && this.analogScopeActive() && this.viewMode === 'time';") &&
    body.includes('visible,') &&
    body.includes('rows.push(...this.measurementWaveRows(\n        view.rows, view.sources, store.samplerate, view.range));') &&
    !body.includes('visible: true');
  const aborted = record.replace("reason: this.captureAbort === null ? reason : 'error',",
    'reason,');
  const alwaysVisible = record.replace(
    "const visible = this.measurePageShown() && this.analogScopeActive() && this.viewMode === 'time';",
    'const visible = true;');
  const analysisVisible = record.replace("this.viewMode === 'time'", "this.viewMode !== 'time'");
  const gateOff = record.replace(" && this.analogScopeActive()", '');
  const ungated = record.replace("missed: this.triggerState === 'not-found',", 'missed: false,');
  check('the wave submission is memory-abort aware, visibility and gate gated and carries the shared facts',
    submitted(record) && !submitted(aborted) && !submitted(alwaysVisible) &&
      !submitted(analysisVisible) && !submitted(gateOff) && !submitted(ungated),
    `submitted=${submitted(record)}, aborted=${submitted(aborted)}, ` +
    `visible=${submitted(alwaysVisible)}, analysis=${submitted(analysisVisible)}, ` +
    `gateOff=${submitted(gateOff)}, missed=${submitted(ungated)}`);
  const hiddenScan = (body: string): boolean =>
    body.includes('if (visible) {') &&
    body.indexOf('if (visible) {') < body.indexOf('this.measurementView()') &&
    body.indexOf('const rows: MeasurementWaveRow[] = [];') <
      body.indexOf('this.measurementView()');
  check('a hidden wave builds no measurement rows, so its submission cannot scan the capture',
    hiddenScan(record) &&
      !hiddenScan(record.replace('if (visible) {', 'if (true) {')),
    `guarded=${hiddenScan(record)}, always=${hiddenScan(record.replace('if (visible) {', 'if (true) {'))}`);
  const stored = ['localStorage', 'sessionStorage', 'persistWorkspace', 'localForage', 'opfs'];
  const leaks = stored.filter((needle) => record.includes(needle));
  check('a submitted wave writes no persisted state: the history is session-only',
    record.length > 0 && leaks.length === 0,
    `leaks=${JSON.stringify(leaks)}`);

  const start = between(app, 'const generation = ++this.captureGeneration;',
    'this.startMutatedCapture = false;');
  check('the App pins one wave generation for the whole sweep, so a duplicate end cannot count twice',
    start.includes('this.captureWaveGeneration = generation;') &&
      app.split('this.captureWaveGeneration =').length - 1 === 1 &&
      record.includes('generation: this.captureWaveGeneration,') &&
      record.split('submitMeasurementWave(').length - 1 === 1,
    `start=${start.includes('this.captureWaveGeneration = generation;')}, ` +
    `assignments=${app.split('this.captureWaveGeneration =').length - 1}`);

  const newSession = between(app, 'if (newSession) {', 'this.lastCaptureChannels = cfg.channels;');
  const repeatWave = newSession.replace(
    'this.captureSessionId += 1;\n        this.measurementStats = emptyMeasurementStats();\n', '');
  check('a new session increments the capture-session key and empties the population',
    newSession.includes('this.captureSessionId += 1;') &&
      newSession.includes('this.measurementStats = emptyMeasurementStats();') &&
      newSession.includes('this.repeatMissed = false;') &&
      app.split('this.captureSessionId += 1;').length - 1 === 3,
    `block=${newSession.length}, increments=${app.split('this.captureSessionId += 1;').length - 1}`);
  const outsideSession = newSession.replace('if (newSession) {', 'if (origin === \'repeat\') {');
  check('an ordinary Repeat wave cannot reach the session reset, because only the new-session branch owns it',
    !repeatWave.includes('this.captureSessionId += 1;') &&
      outsideSession.includes('this.captureSessionId += 1;') &&
      !newSession.includes("origin === 'repeat'"),
    `repeat=${repeatWave.includes('this.captureSessionId += 1;')}, ` +
    `moved=${outsideSession.includes('this.captureSessionId += 1;')}`);

  const adopt = between(app, 'private adoptCapture(', 'private async openExample(): Promise<void> {');
  check('a replaced capture opens a new statistical population',
    adopt.includes('this.captureSessionId += 1;') &&
      adopt.includes('this.measurementStats = emptyMeasurementStats();') &&
      adopt.indexOf('this.captureSessionId += 1;') < adopt.indexOf('this.relayout();'),
    `adopt=${adopt.length}, reset=${adopt.includes('this.captureSessionId += 1;')}`);
}

{
  const builder = between(app, 'private measurementStatsRowKey(',
    'private measurementStatsViews(');
  const fields = [
    'sessionId: this.captureSessionId,',
    'source: source.start,',
    'parameter: row.parameter,',
    'rangeKind: range.kind,',
    'cursorA: range.a,',
    'cursorB: range.b,',
    'gain: source.gain,',
    'level: analogTriggerCode(trigger.kind, trigger.volts, source.gain),',
    "rising: trigger.kind === 'rising',",
    'hysteresis: qualification.analogHysteresis,',
    'artifactWindow: qualification.analogArtifactSamples,',
    'samplerate,',
  ];
  const missing = fields.filter((needle) => !builder.includes(needle));
  const keepsEveryField = (source: string): boolean =>
    fields.every((needle) => source.includes(needle));
  const dropped = fields.filter((needle) => keepsEveryField(builder.replace(needle, '')));
  check('one key builder carries every reset-key field for the projection and the submission',
    builder.length > 0 && missing.length === 0 && dropped.length === 0 &&
      app.split('this.measurementStatsRowKey(').length - 1 === 2 &&
      app.split('measurementStatsKey({').length - 1 === 1,
    `missing=${JSON.stringify(missing)}, dropped=${JSON.stringify(dropped)}, ` +
    `calls=${app.split('this.measurementStatsRowKey(').length - 1}, ` +
    `keys=${app.split('measurementStatsKey({').length - 1}`);
  const callers = (source: string): boolean =>
    source.split('this.measurementStatsRowKey(').length - 1 === 2 &&
    source.split('measurementStatsKey({').length - 1 === 1;
  check('a second key-construction site or a dropped caller fails that contract',
    callers(app) &&
      !callers(app.replace('const key = this.measurementStatsRowKey(',
        'const key = this.measurementStatsRowKeyUnused(')) &&
      !callers(app.replace('return measurementStatsKey({',
        'const extra = measurementStatsKey({ params: [] as never });\n    return measurementStatsKey({')),
    `callers=${callers(app)}, ` +
    `dropped=${!callers(app.replace('const key = this.measurementStatsRowKey(', 'const key = x('))}`);

  const view = between(app, 'private measurementView(): MeasurementSectionView {',
    'private measurementBase(');
  const prunes = (source: string): boolean =>
    source.includes('retainMeasurementStats(') &&
    source.includes('state.rows.map((row) => row.id)') &&
    source.indexOf('retainMeasurementStats(') <
      source.indexOf('this.measurementStatsViews(');
  check('the projection hands back the accumulators of rows the configuration no longer holds',
    prunes(view) && !prunes(view.replace('retainMeasurementStats(', 'noRetain(')) &&
      !prunes(view.replace('state.rows.map((row) => row.id)', '[]')),
    `prunes=${prunes(view)}, ` +
    `dropped=${!prunes(view.replace('retainMeasurementStats(', 'noRetain('))}`);
}

{
  const removeRow = between(app, 'private removeMeasurementRowById(id: number): void {',
    'private cancelMeasurementCapture(): void {');
  const clear = between(app, 'private async clearMeasurementRows(invoker: HTMLElement | null): Promise<void> {',
    'private undoMeasurementRows(): void {');
  const undo = between(app, 'private undoMeasurementRows(): void {',
    'private removeMeasurementRowById(id: number): void {');
  const toggle = between(app, 'private toggleMeasurementParameter(start: number, parameter: MeasurementParameter): void {',
    'private async clearMeasurementRows(');
  const reset = between(app, 'private resetMeasurement(): void {',
    'private resetMeasurementStatsRow(rowId: number): void {');
  check('removal, Clear all, Undo and reset each drop the population they invalidate',
    removeRow.includes('resetMeasurementStatsFor(this.measurementStats, id)') &&
      clear.includes('resetAllMeasurementStats(this.measurementStats)') &&
      undo.includes('resetAllMeasurementStats(this.measurementStats)') &&
      toggle.includes('resetMeasurementStatsFor(this.measurementStats, removed.id)') &&
      reset.includes('resetAllMeasurementStats(this.measurementStats)') &&
      reset.includes('this.captureSessionId += 1;'),
    `remove=${removeRow.includes('resetMeasurementStatsFor(')}, ` +
    `clear=${clear.includes('resetAllMeasurementStats(')}, ` +
    `undo=${undo.includes('resetAllMeasurementStats(')}, ` +
    `toggle=${toggle.includes('resetMeasurementStatsFor(')}, ` +
    `reset=${reset.includes('resetAllMeasurementStats(')}`);
  const pruned = clear.replace('this.measurementStats = resetAllMeasurementStats(this.measurementStats);', '');
  const undoKept = undo.replace('this.measurementStats = resetAllMeasurementStats(this.measurementStats);', '');
  check('a Clear all or Undo that kept the old population fails that control',
    !pruned.includes('resetAllMeasurementStats(') &&
      !undoKept.includes('resetAllMeasurementStats('),
    `cleared=${pruned.includes('resetAllMeasurementStats(')}, ` +
    `undo=${undoKept.includes('resetAllMeasurementStats(')}`);

  const resetRow = between(app, 'private resetMeasurementStatsRow(rowId: number): void {',
    'private resetAllMeasurementStatsRows(): void {');
  const resetAll = between(app, 'private resetAllMeasurementStatsRows(): void {',
    'private refreshMeasurementStats(): void {');
  const untouched = ['measurementConfig', 'measurementCache', 'this.cursors', 'captureStore',
    'startCapture', 'repeatTimer', 'persistWorkspace', 'renderPanels', 'captureSessionId'];
  const leaked = [resetRow, resetAll].flatMap((body) => untouched.filter((needle) => body.includes(needle)));
  check('a statistics reset touches the population only, never rows, range, cursors or acquisition',
    resetRow.includes('resetMeasurementStatsFor(this.measurementStats, rowId)') &&
      resetAll.includes('resetAllMeasurementStats(this.measurementStats)') &&
      resetRow.includes('this.refreshMeasurementStats();') &&
      resetAll.includes('this.refreshMeasurementStats();') &&
      leaked.length === 0,
    `leaked=${JSON.stringify(leaked)}`);

  const refresh = between(app, 'private refreshMeasurementStats(): void {',
    'private applyMeasurementConfig(');
  check('the reset publishes the new history as text, without rebuilding the panel',
    refresh.includes('this.capturePanel.updateMeasurements(this.measurementView());') &&
      !refresh.includes('renderPanels()') && refresh.includes('this.dirty = true;'),
    `refresh=${refresh.length}`);

  check('App registers both statistics reset callbacks on the capture panel',
    app.includes('onResetMeasurementStats: (rowId) => this.resetMeasurementStatsRow(rowId),') &&
      app.includes('onResetAllMeasurementStats: () => this.resetAllMeasurementStatsRows(),'),
    `row=${app.includes('onResetMeasurementStats:')}, ` +
    `all=${app.includes('onResetAllMeasurementStats:')}`);
}

{
  const rowView = (
    id: number, start: number, state: MeasurementStatsState,
  ): MeasurementRowView => ({
    id,
    start,
    sourceName: start === 0 ? 'A0' : 'A1',
    parameter: 'vpp',
    unit: 'v',
    value: id,
    status: 'ok',
    analyzedSamples: 1024,
    requestedSamples: 1024,
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
    stats: measurementStatsView(state, id, start === 0 ? '0:vpp' : '8:vpp'),
  });
  const matrixOf = (state: MeasurementStatsState): ReturnType<typeof measurementMatrixView> => {
    const rows = [rowView(1, 0, state), rowView(2, 8, state)];
    const view: MeasurementSectionView = {
      sources: [
        { group: 0, start: 0, gain: 1, name: 'A0' },
        { group: 1, start: 8, gain: 1, name: 'A1' },
      ],
      filter: null,
      range: { kind: 'viewport', a: null, b: null },
      tier: 'advanced',
      cursors: [],
      rows,
      allRows: rows.map((row) => ({ id: row.id, start: row.start, parameter: row.parameter })),
      rowCount: rows.length,
      undoCount: null,
      addStart: null,
      window: null,
      unavailable: null,
      capture: null,
      statsSkipped: 0,
      statsLoopUnavailable: false,
    };
    return measurementMatrixView(view);
  };
  let state = emptyMeasurementStats();
  state = submitMeasurementWave(state, wave({
    generation: 1,
    rows: [
      { rowId: 1, key: '0:vpp', value: 2 },
      { rowId: 2, key: '8:vpp', value: 10 },
    ],
  })).state;
  state = submitMeasurementWave(state, wave({
    generation: 2,
    rows: [
      { rowId: 1, key: '0:vpp', value: 4 },
      { rowId: 2, key: '8:vpp', value: 20 },
    ],
  })).state;
  const before = matrixOf(state);
  const beforeCells = before.rows.map((row) => row.cells[0]?.row ?? null);
  check('two cells of the same parameter keep independent Count/Mean per source',
    before.columns.length === 1 && before.columns[0]?.parameter === 'vpp' &&
      before.rows.length === 2 &&
      beforeCells.every((cell) => cell !== null) &&
      beforeCells[0]?.start === 0 && beforeCells[1]?.start === 8 &&
      beforeCells[0]?.stats.count === 2 && beforeCells[1]?.stats.count === 2 &&
      beforeCells[0]?.stats.mean === 3 && beforeCells[1]?.stats.mean === 15,
    `cells=${JSON.stringify(beforeCells.map((cell) => [cell?.start, cell?.stats.count,
      cell?.stats.mean]))}`);

  const neighbour = JSON.stringify(state.accumulators.get(2));
  const values = beforeCells.map((cell) => cell?.value);
  const one = resetMeasurementStatsFor(state, 1);
  const afterOne = matrixOf(one);
  const afterCells = afterOne.rows.map((row) => row.cells[0]?.row ?? null);
  check('resetting one cell clears its history and leaves the neighbour byte-identical',
    afterCells[0]?.stats.count === 0 && afterCells[0]?.stats.mean !== afterCells[0]?.stats.mean &&
      afterCells[1]?.stats.count === 2 && afterCells[1]?.stats.mean === 15 &&
      JSON.stringify(one.accumulators.get(2)) === neighbour &&
      one.accumulators.has(1) === false &&
      JSON.stringify(afterCells.map((cell) => cell?.value)) === JSON.stringify(values),
    `counts=${afterCells.map((cell) => cell?.stats.count)}, ` +
      `neighbour=${JSON.stringify(one.accumulators.get(2)) === neighbour}`);

  const all = resetAllMeasurementStats(state);
  const afterAll = matrixOf(all);
  const allCells = afterAll.rows.map((row) => row.cells[0]?.row ?? null);
  check('reset all clears every cell history and keeps every value and the duplicate guard',
    all.accumulators.size === 0 && all.lastWaveKey === state.lastWaveKey &&
      allCells.every((cell) => cell !== null && cell.stats.count === 0) &&
      JSON.stringify(allCells.map((cell) => cell?.value)) === JSON.stringify(values),
    `size=${all.accumulators.size}, counts=${allCells.map((cell) => cell?.stats.count)}, ` +
      `values=${JSON.stringify(allCells.map((cell) => cell?.value))}`);
}


console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
