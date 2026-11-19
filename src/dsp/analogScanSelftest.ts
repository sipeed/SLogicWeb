// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ADC_TRACE_LEVELS, TRACE_HYSTERESIS, TRACE_WINDOW, loadAdcTrace, traceCrossings,
} from '../data/adcTraceFiles.js';
import { qualifiedCrossings } from '../data/analogRunQualifier.js';
import { analogVoltsPerCode } from '../ui/channelBanks.js';
import { MEASURE_SCAN_SAMPLES } from '../ui/measureSamples.js';
import {
  ANALOG_NEAR_LIMIT_PERIOD_SAMPLES, ANALOG_SCAN_MAX_CROSSINGS, AnalogCodeScanAccumulator,
  scanAnalogCodes, type AnalogCodeScan, type AnalogCodeScanInput,
} from './analogScan.js';

interface TestResult { name: string; pass: boolean; detail: string }

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function nearly(name: string, actual: number, expected: number, tolerance = 1e-12): void {
  check(name, closeTo(actual, expected, tolerance), `got ${actual}, expected ${expected} +/- ${tolerance}`);
}

function isNaNField(name: string, value: number): void {
  check(name, Number.isNaN(value), `got ${value}, expected NaN`);
}

interface ExactCodes { sum: bigint; squareSum: bigint; min: number; max: number }

function exactCentered(codes: ArrayLike<number>): ExactCodes {
  let sum = 0n;
  let squareSum = 0n;
  let min = 255;
  let max = 0;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!;
    if (code < min) min = code;
    if (code > max) max = code;
    const centered = BigInt(code - ZERO);
    sum += centered;
    squareSum += centered * centered;
  }
  return { sum, squareSum, min, max };
}

function throwsRange(name: string, action: () => void): void {
  try {
    action();
    check(name, false, 'did not throw');
  } catch (error) {
    check(
      name,
      error instanceof RangeError,
      `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
  }
}

const RATE = 100e6;
const ZERO = 128;
const H = TRACE_HYSTERESIS;
const W = TRACE_WINDOW;
const LSB = analogVoltsPerCode(1);

type ScanOverrides = Partial<Omit<AnalogCodeScanInput, 'codes'>>;

const BASE: Omit<AnalogCodeScanInput, 'codes'> = {
  samplerate: RATE,
  zeroCode: ZERO,
  voltsPerCode: LSB,
  rising: true,
  level: 128,
  hysteresis: H,
  window: W,
};

function scan(codes: ArrayLike<number>, extra: ScanOverrides = {}): AnalogCodeScan {
  return scanAnalogCodes({ ...BASE, codes, ...extra });
}

function filled(length: number, code: number): Uint8Array {
  return new Uint8Array(length).fill(code);
}

function periodic(length: number, period: number, low: number, high: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % period === 0 ? low : high;
  return out;
}

function squareWave(length: number, period: number, highSamples: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = i % period < highSamples ? 200 : 60;
  return out;
}

const sine = loadAdcTrace('sine');

function sameScan(a: AnalogCodeScan, b: AnalogCodeScan): string {
  const diffs: string[] = [];
  for (const key of Object.keys(a) as (keyof AnalogCodeScan)[]) {
    const left = a[key];
    const right = b[key];
    const equal = typeof left === 'number' && typeof right === 'number'
      ? left === right || (Number.isNaN(left) && Number.isNaN(right))
      : left === right;
    if (!equal) diffs.push(`${String(key)}: ${String(left)} vs ${String(right)}`);
  }
  return diffs.join('; ');
}

function chunked(
  codes: Uint8Array, nextSize: () => number, extra: ScanOverrides = {}, unknown?: Uint8Array,
): AnalogCodeScan {
  const accumulator = new AnalogCodeScanAccumulator({ ...BASE, ...extra });
  for (let at = 0; at < codes.length;) {
    const end = Math.min(codes.length, at + Math.max(1, nextSize()));
    if (unknown === undefined) accumulator.push(codes.subarray(at, end));
    else accumulator.push(codes.subarray(at, end), unknown.subarray(at, end));
    at = end;
  }
  return accumulator.finish();
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function perturbed(source: AnalogCodeScan, key: keyof AnalogCodeScan): AnalogCodeScan {
  const out = { ...source } as Record<string, unknown>;
  const value = out[key];
  if (typeof value === 'number') out[key] = Number.isNaN(value) ? 0 : value + 1;
  else if (typeof value === 'boolean') out[key] = !value;
  else out[key] = value === 'ok' ? 'no-data' : 'ok';
  return out as unknown as AnalogCodeScan;
}

check(
  'scan constants',
  ANALOG_SCAN_MAX_CROSSINGS === 512 && ANALOG_NEAR_LIMIT_PERIOD_SAMPLES === 4,
  `maxCrossings=${ANALOG_SCAN_MAX_CROSSINGS}, nearLimit=${ANALOG_NEAR_LIMIT_PERIOD_SAMPLES}`,
);

{
  const full = scan(sine);
  check(
    'full sine: counts',
    full.analyzed === sine.length && full.known === sine.length && full.unknown === 0,
    `analyzed=${full.analyzed}, known=${full.known}, unknown=${full.unknown}`,
  );
  check(
    'full sine: exact code extrema and 171-code Vpp',
    full.minCode === 84 && full.maxCode === 255 && full.vppCodes === 171,
    `min=${full.minCode}, max=${full.maxCode}, vpp=${full.vppCodes}`,
  );
  check(
    'full sine: Vpp volts are the exact calibrated code span',
    full.vppVolts === full.vppCodes * LSB &&
      closeTo(LSB, 0.1372549, 1e-12),
    `got ${full.vppVolts}, expected ${171 * LSB} (calibrated LSB ${LSB})`,
  );
  nearly('full sine: min volts', full.minVolts, (84 - ZERO) * LSB);
  nearly('full sine: max volts', full.maxVolts, (255 - ZERO) * LSB);
  nearly('full sine: centered mean code', full.meanOffsetCodes, 1.8368166666666668, 1e-9);
  nearly('full sine: centered RMS code', full.rmsOffsetCodes, 32.66680430243114, 1e-9);
  const exact = exactCentered(sine);
  check(
    'full sine: 300,000 samples match the exact integer sum and square sum bit for bit',
    full.meanOffsetCodes === Number(exact.sum) / sine.length &&
      full.rmsOffsetCodes === Math.sqrt(Number(exact.squareSum) / sine.length) &&
      exact.squareSum === 320136031n,
    `mean=${full.meanOffsetCodes}/${Number(exact.sum) / sine.length}, ` +
      `rms=${full.rmsOffsetCodes}/${Math.sqrt(Number(exact.squareSum) / sine.length)}, ` +
      `squareSum=${exact.squareSum}`,
  );
  check(
    'full sine: RMS volts are the exact calibrated centered RMS',
    full.rmsVolts === full.rmsOffsetCodes * LSB &&
      closeTo(LSB, 0.1372549, 1e-12),
    `got ${full.rmsVolts}, expected ${full.rmsOffsetCodes * LSB} (calibrated LSB)`,
  );
  check(
    'full sine: the 11-sample 255 carry run is not sustained clipping',
    !full.clippedLow && !full.clippedHigh,
    `low=${full.clippedLow}, high=${full.clippedHigh}`,
  );
  check(
    'full sine: 30 qualified crossings, no cap',
    full.crossingCount === 30 && !full.crossingCap && full.status === 'ok',
    `count=${full.crossingCount}, cap=${full.crossingCap}, status=${full.status}`,
  );
  check(
    'full sine: frequency within 0.5% of the independent 9999.5877 Hz reference',
    Math.abs(full.frequencyHz - 9999.5877) / 9999.5877 < 0.005,
    `got ${full.frequencyHz} Hz, period ${full.periodSamples} samples`,
  );
  check(
    'full sine: period seconds is the measured period over the sample rate',
    Number.isFinite(full.periodSeconds) && full.periodSeconds === full.periodSamples / RATE &&
      Math.abs(full.periodSeconds - 1e-4) / 1e-4 < 0.005 &&
      Math.abs(full.frequencyHz * full.periodSeconds - 1) < 1e-12,
    `periodSeconds=${full.periodSeconds}, periodSamples=${full.periodSamples}, ` +
      `frequency=${full.frequencyHz}`,
  );
  const dutyOracle: number[] = qualifiedCrossings(sine, true, 128, H, W);
  let oracleHigh = 0;
  let oracleKnown = 0;
  for (let k = 1; k < dutyOracle.length; k += 1) {
    for (let i = dutyOracle[k - 1]!; i < dutyOracle[k]!; i += 1) {
      oracleKnown += 1;
      if (sine[i]! >= 128) oracleHigh += 1;
    }
  }
  check(
    'full sine: duty is the per-period high fraction of the qualified crossings',
    dutyOracle.length === full.crossingCount && full.dutyPeriods === dutyOracle.length - 1 &&
      full.dutyExcludedPeriods === 0 && full.dutyKnownSamples === oracleKnown &&
      full.dutyHighSamples === oracleHigh &&
      full.dutyPercent === (100 * oracleHigh) / oracleKnown && full.dutyPercent > 0 &&
      full.dutyPercent < 100,
    `duty=${full.dutyPercent}, periods=${full.dutyPeriods}, excluded=${full.dutyExcludedPeriods}, ` +
      `known=${full.dutyKnownSamples}/${oracleKnown}, high=${full.dutyHighSamples}/${oracleHigh}`,
  );

  const oracle144 = qualifiedCrossings(sine, true, 144, H, W);
  const at144 = scan(sine, { level: 144 });
  check(
    'level 144: crossings equal the qualified oracle positions',
    at144.crossingCount === oracle144.length && at144.firstCrossing === oracle144[0] &&
      at144.lastCrossing === oracle144[oracle144.length - 1] && oracle144.length > 1,
    `got ${at144.crossingCount}/${at144.firstCrossing}/${at144.lastCrossing}, ` +
      `oracle ${oracle144.length}/${oracle144[0]}/${oracle144[oracle144.length - 1]}`,
  );
}

{
  const prefixCodes = sine.subarray(0, MEASURE_SCAN_SAMPLES);
  const prefix = scan(prefixCodes);
  const exact = exactCentered(prefixCodes);
  check(
    'UI default prefix: the 65,536-sample window analyzes every exact sample',
    MEASURE_SCAN_SAMPLES === 65536 && prefix.analyzed === 65536 &&
      prefix.known === 65536 && prefix.unknown === 0,
    `limit=${MEASURE_SCAN_SAMPLES}, analyzed=${prefix.analyzed}, known=${prefix.known}`,
  );
  check(
    'UI default prefix: exact code extrema and 171-code Vpp',
    prefix.minCode === exact.min && prefix.maxCode === exact.max &&
      prefix.vppCodes === exact.max - exact.min && prefix.vppCodes === 171,
    `min=${prefix.minCode}, max=${prefix.maxCode}, vpp=${prefix.vppCodes}`,
  );
  check(
    'UI default prefix: mean and RMS match the exact integer aggregates bit for bit',
    prefix.meanOffsetCodes === Number(exact.sum) / prefixCodes.length &&
      prefix.rmsOffsetCodes === Math.sqrt(Number(exact.squareSum) / prefixCodes.length) &&
      prefix.meanOffsetCodes === 0.3162689208984375 &&
      prefix.rmsOffsetCodes === 32.59432371371574,
    `mean=${prefix.meanOffsetCodes}/${Number(exact.sum) / prefixCodes.length}, ` +
      `rms=${prefix.rmsOffsetCodes}/${Math.sqrt(Number(exact.squareSum) / prefixCodes.length)}`,
  );
  check(
    'UI default prefix: 6 qualified crossings and a disclosed in-tolerance frequency',
    prefix.crossingCount === 6 && !prefix.crossingCap && prefix.status === 'ok' &&
      Math.abs(prefix.frequencyHz - 9999.5877) / 9999.5877 < 0.005,
    `count=${prefix.crossingCount}, cap=${prefix.crossingCap}, status=${prefix.status}, ` +
      `freq=${prefix.frequencyHz}`,
  );
}

{
  const codes = loadAdcTrace('multitone');
  const details: string[] = [];
  let pass = true;
  for (const rising of [true, false]) {
    for (const level of ADC_TRACE_LEVELS.multitone) {
      const oracle = traceCrossings(codes, rising, level, 0, H, W);
      const got = scan(codes, { rising, level, maxCrossings: 4096 });
      const ok = got.crossingCount === oracle.length && got.firstCrossing === oracle[0] &&
        got.lastCrossing === oracle[oracle.length - 1] && got.status === 'ok';
      if (!ok) pass = false;
      details.push(`${rising ? 'R' : 'F'}${level}: ${got.crossingCount}/${got.firstCrossing}/${got.lastCrossing}` +
        ` vs ${oracle.length}/${oracle[0]}/${oracle[oracle.length - 1]}`);
    }
  }
  check('multitone: qualified crossings match the independent oracle at every documented level',
    pass, details.join('; '));
}

{
  let rawCount = 0;
  let rawFirst = -1;
  let rawLast = -1;
  for (let i = 1; i < sine.length; i += 1) {
    if (sine[i] >= 128 && sine[i - 1] < 128) {
      rawCount += 1;
      if (rawFirst < 0) rawFirst = i;
      rawLast = i;
    }
  }
  const rawFrequency = RATE / ((rawLast - rawFirst) / (rawCount - 1));
  const qualified = scan(sine);
  check(
    'raw-crossing control: a naive rising count reports 257 crossings',
    rawCount === 257,
    `raw=${rawCount}, first=${rawFirst}, last=${rawLast}`,
  );
  check(
    'raw-crossing control: the qualified scan is not the raw count or period',
    qualified.crossingCount === 30 && qualified.frequencyHz !== rawFrequency &&
      Math.abs(qualified.frequencyHz - rawFrequency) / rawFrequency > 0.5,
    `qualified=${qualified.crossingCount}/${qualified.frequencyHz} Hz, raw=${rawCount}/${rawFrequency} Hz`,
  );
}

{
  const clamped = new Uint8Array(sine.length);
  for (let i = 0; i < sine.length; i += 1) clamped[i] = Math.min(175, Math.max(84, sine[i]));
  const got = scan(clamped);
  check(
    'clamping the sine to 84..175 yields a 91-code Vpp, so the 171-code answer keeps carry artifacts',
    got.minCode === 84 && got.maxCode === 175 && got.vppCodes === 91,
    `min=${got.minCode}, max=${got.maxCode}, vpp=${got.vppCodes}`,
  );
}

{
  const low = filled(200, 128);
  low.fill(0, 50, 110);
  const lowGot = scan(low, { window: 50 });
  check(
    'a sustained code-0 run flags low clipping only',
    lowGot.clippedLow && !lowGot.clippedHigh,
    `low=${lowGot.clippedLow}, high=${lowGot.clippedHigh}`,
  );

  const high = filled(200, 128);
  high.fill(255, 50, 110);
  const highGot = scan(high, { window: 50 });
  check(
    'a sustained code-255 run flags high clipping only',
    highGot.clippedHigh && !highGot.clippedLow,
    `low=${highGot.clippedLow}, high=${highGot.clippedHigh}`,
  );

  const artifact = filled(100, 128);
  artifact[40] = 127;
  artifact[41] = 255;
  artifact[42] = 255;
  artifact[43] = 255;
  const artifactGot = scan(artifact, { window: 50 });
  check(
    'a 3-sample endpoint run between 127 and 128 is not clipping',
    !artifactGot.clippedLow && !artifactGot.clippedHigh,
    `low=${artifactGot.clippedLow}, high=${artifactGot.clippedHigh}`,
  );

  const atThreshold = filled(150, 128);
  atThreshold.fill(255, 50, 100);
  const belowThreshold = filled(150, 128);
  belowThreshold.fill(255, 50, 99);
  const atGot = scan(atThreshold, { window: 50 });
  const belowGot = scan(belowThreshold, { window: 50 });
  check(
    'clipping is thresholded at max(1, window): 50 samples flag, 49 do not',
    atGot.clippedHigh && !belowGot.clippedHigh,
    `at=${atGot.clippedHigh}, below=${belowGot.clippedHigh}`,
  );

  const single = filled(20, 128);
  single[10] = 255;
  const singleHigh = filled(20, 128);
  singleHigh[10] = 0;
  const atZero = scan(single, { window: 0 });
  const pairAtTwo = filled(20, 128);
  pairAtTwo.fill(255, 10, 12);
  check(
    'window 0 thresholds clipping at a single endpoint sample',
    atZero.clippedHigh && !atZero.clippedLow && scan(singleHigh, { window: 0 }).clippedLow,
    `high=${atZero.clippedHigh}, low=${scan(singleHigh, { window: 0 }).clippedLow}`,
  );
  check(
    'window 2 needs two endpoint samples before it flags clipping',
    !scan(single, { window: 2 }).clippedHigh && scan(pairAtTwo, { window: 2 }).clippedHigh,
    `single=${scan(single, { window: 2 }).clippedHigh}, pair=${scan(pairAtTwo, { window: 2 }).clippedHigh}`,
  );

  const noWindow = scan(sine, { window: 0 });
  check(
    'at window 0 the 11-sample 255 carry run counts as high clipping',
    noWindow.clippedHigh && !noWindow.clippedLow && noWindow.crossingCount === 30,
    `low=${noWindow.clippedLow}, high=${noWindow.clippedHigh}, count=${noWindow.crossingCount}`,
  );
}

{
  const codes = new Uint8Array(70);
  codes.fill(100, 0, 30);
  codes.fill(200, 30, 70);
  const mask = new Uint8Array(70);
  mask.fill(1, 30, 40);
  const gapped = scan(codes, { unknown: mask, window: 4 });
  const contiguous = scan(codes, { window: 4 });
  check(
    'an unknown span resets the qualifier so no crossing spans the gap',
    gapped.crossingCount === 0 && gapped.status === 'no-crossing' &&
      contiguous.crossingCount === 1 && contiguous.firstCrossing === 30,
    `gapped=${gapped.crossingCount}, contiguous=${contiguous.crossingCount}/${contiguous.firstCrossing}`,
  );
  check(
    'unknown samples are excluded from the amplitude and counts',
    gapped.analyzed === 70 && gapped.known === 60 && gapped.unknown === 10 &&
      gapped.minCode === 100 && gapped.maxCode === 200 && gapped.vppCodes === 100 &&
      gapped.meanOffsetCodes === 22,
    `analyzed=${gapped.analyzed}, known=${gapped.known}, unknown=${gapped.unknown}, ` +
      `min=${gapped.minCode}, max=${gapped.maxCode}, mean=${gapped.meanOffsetCodes}`,
  );

  const allUnknown = scan(filled(10, 128), { unknown: filled(10, 1) });
  check(
    'an all-unknown scan reports no-data with no amplitude',
    allUnknown.status === 'no-data' && allUnknown.analyzed === 10 && allUnknown.known === 0 &&
      allUnknown.unknown === 10 && allUnknown.crossingCount === 0 &&
      allUnknown.firstCrossing === -1 && allUnknown.lastCrossing === -1,
    `status=${allUnknown.status}, analyzed=${allUnknown.analyzed}, known=${allUnknown.known}`,
  );
  isNaNField('all unknown: min code is NaN', allUnknown.minCode);
  isNaNField('all unknown: max code is NaN', allUnknown.maxCode);
  isNaNField('all unknown: Vpp codes is NaN', allUnknown.vppCodes);
  isNaNField('all unknown: mean code is NaN', allUnknown.meanOffsetCodes);
  isNaNField('all unknown: RMS code is NaN', allUnknown.rmsOffsetCodes);
  isNaNField('all unknown: Vpp volts is NaN', allUnknown.vppVolts);
  isNaNField('all unknown: RMS volts is NaN', allUnknown.rmsVolts);
  isNaNField('all unknown: period is NaN', allUnknown.periodSamples);
  isNaNField('all unknown: period seconds is NaN', allUnknown.periodSeconds);
  isNaNField('all unknown: frequency is NaN', allUnknown.frequencyHz);
  isNaNField('all unknown: duty is NaN', allUnknown.dutyPercent);
  check(
    'all unknown: no duty period is claimed',
    allUnknown.dutyPeriods === 0 && allUnknown.dutyExcludedPeriods === 0 &&
      allUnknown.dutyKnownSamples === 0 && allUnknown.dutyHighSamples === 0,
    `periods=${allUnknown.dutyPeriods}, excluded=${allUnknown.dutyExcludedPeriods}, ` +
      `known=${allUnknown.dutyKnownSamples}, high=${allUnknown.dutyHighSamples}`,
  );
}

{
  const flat = scan(filled(1000, 128), { window: 4 });
  check(
    'flat DC input reports no-crossing',
    flat.status === 'no-crossing' && flat.crossingCount === 0,
    `status=${flat.status}, count=${flat.crossingCount}`,
  );
  isNaNField('flat DC input: period is NaN', flat.periodSamples);
  isNaNField('flat DC input: period seconds is NaN', flat.periodSeconds);
  isNaNField('flat DC input: frequency is NaN', flat.frequencyHz);
  isNaNField('flat DC input: duty is NaN', flat.dutyPercent);

  const high = scan(filled(100, 200));
  const low = scan(filled(100, 100));
  check(
    'a flat waveform keeps its signed DC offset in both mean and RMS',
    high.meanOffsetCodes === 72 && high.rmsOffsetCodes === 72 &&
      low.meanOffsetCodes === -28 && low.rmsOffsetCodes === 28 &&
      high.meanVolts === 72 * LSB && low.meanVolts === -28 * LSB,
    `high=${high.meanOffsetCodes}/${high.rmsOffsetCodes}, ` +
      `low=${low.meanOffsetCodes}/${low.rmsOffsetCodes}`,
  );

  const empty = scan(new Uint8Array(0));
  check(
    'an empty input reports no-data with zero analysis',
    empty.analyzed === 0 && empty.known === 0 && empty.unknown === 0 &&
      empty.status === 'no-data' && empty.crossingCount === 0 && !empty.crossingCap &&
      empty.firstCrossing === -1 && empty.lastCrossing === -1,
    `analyzed=${empty.analyzed}, status=${empty.status}, count=${empty.crossingCount}`,
  );
  isNaNField('empty input: mean is NaN', empty.meanOffsetCodes);
  isNaNField('empty input: RMS is NaN', empty.rmsOffsetCodes);
  isNaNField('empty input: Vpp is NaN', empty.vppCodes);
  isNaNField('empty input: frequency is NaN', empty.frequencyHz);
  isNaNField('empty input: period seconds is NaN', empty.periodSeconds);
  isNaNField('empty input: duty is NaN', empty.dutyPercent);
  check(
    'empty input: no sustained endpoint clipping',
    !empty.clippedLow && !empty.clippedHigh && !empty.nearSampleLimit,
    `low=${empty.clippedLow}, high=${empty.clippedHigh}, near=${empty.nearSampleLimit}`,
  );

  const one = new Uint8Array(60);
  one.fill(100, 0, 30);
  one.fill(200, 30, 60);
  const oneGot = scan(one, { window: 4 });
  check(
    'exactly one qualified crossing reports one-crossing',
    oneGot.status === 'one-crossing' && oneGot.crossingCount === 1 && oneGot.firstCrossing === 30 &&
      !oneGot.nearSampleLimit,
    `status=${oneGot.status}, count=${oneGot.crossingCount}, first=${oneGot.firstCrossing}, ` +
      `near=${oneGot.nearSampleLimit}`,
  );
  isNaNField('one crossing: period is NaN', oneGot.periodSamples);
  isNaNField('one crossing: period seconds is NaN', oneGot.periodSeconds);
  isNaNField('one crossing: frequency is NaN', oneGot.frequencyHz);
  isNaNField('one crossing: duty is NaN', oneGot.dutyPercent);
  check(
    'one crossing: no complete period exists for the duty',
    oneGot.dutyPeriods === 0 && oneGot.dutyExcludedPeriods === 0 &&
      oneGot.dutyKnownSamples === 0 && oneGot.dutyHighSamples === 0,
    `periods=${oneGot.dutyPeriods}, excluded=${oneGot.dutyExcludedPeriods}, ` +
      `known=${oneGot.dutyKnownSamples}, high=${oneGot.dutyHighSamples}`,
  );

  const shortWave = scan(periodic(4, 3, 0, 255), { window: 0 });
  const wave = scan(periodic(5, 3, 0, 255), { window: 0 });
  check(
    'a period-3 square wave needs a second crossing before it is ok',
    shortWave.status === 'one-crossing' && wave.status === 'ok' && wave.crossingCount === 2,
    `short=${shortWave.status}/${shortWave.crossingCount}, wave=${wave.status}/${wave.crossingCount}`,
  );
  check(
    'a period-3 square wave is ok and near the sample limit',
    wave.periodSamples === 3 && wave.frequencyHz === RATE / 3 && wave.nearSampleLimit,
    `period=${wave.periodSamples}, frequency=${wave.frequencyHz}, near=${wave.nearSampleLimit}`,
  );

  const period4 = scan(periodic(20, 4, 0, 255), { window: 0 });
  check(
    'a period-4 square wave is not near the sample limit',
    period4.status === 'ok' && period4.periodSamples === 4 && !period4.nearSampleLimit,
    `period=${period4.periodSamples}, near=${period4.nearSampleLimit}`,
  );
}

{
  const quarter = scan(squareWave(96, 8, 2));
  check(
    '25% duty: ten complete 8-sample periods of 2 high samples read exactly 25%',
    quarter.status === 'ok' && quarter.crossingCount === 11 &&
      quarter.firstCrossing === 8 && quarter.lastCrossing === 88 &&
      quarter.dutyPeriods === 10 && quarter.dutyExcludedPeriods === 0 &&
      quarter.dutyKnownSamples === 80 && quarter.dutyHighSamples === 20 &&
      quarter.dutyPercent === 25 && quarter.periodSeconds === 8 / RATE,
    `crossings=${quarter.crossingCount}/${quarter.firstCrossing}/${quarter.lastCrossing}, ` +
      `periods=${quarter.dutyPeriods}/${quarter.dutyExcludedPeriods}, ` +
      `known=${quarter.dutyKnownSamples}, high=${quarter.dutyHighSamples}, ` +
      `duty=${quarter.dutyPercent}, periodSeconds=${quarter.periodSeconds}`,
  );

  const threeQuarters = scan(squareWave(96, 8, 6));
  check(
    '75% duty: the same ten periods of 6 high samples read exactly 75%',
    threeQuarters.status === 'ok' && threeQuarters.dutyPeriods === 10 &&
      threeQuarters.dutyExcludedPeriods === 0 && threeQuarters.dutyKnownSamples === 80 &&
      threeQuarters.dutyHighSamples === 60 && threeQuarters.dutyPercent === 75,
    `periods=${threeQuarters.dutyPeriods}, known=${threeQuarters.dutyKnownSamples}, ` +
      `high=${threeQuarters.dutyHighSamples}, duty=${threeQuarters.dutyPercent}`,
  );

  const lowHalf = scan(squareWave(96, 8, 4));
  check(
    '50% duty: four high samples per 8-sample period read exactly 50%',
    lowHalf.dutyPeriods === 10 && lowHalf.dutyKnownSamples === 80 &&
      lowHalf.dutyHighSamples === 40 && lowHalf.dutyPercent === 50,
    `periods=${lowHalf.dutyPeriods}, known=${lowHalf.dutyKnownSamples}, ` +
      `high=${lowHalf.dutyHighSamples}, duty=${lowHalf.dutyPercent}`,
  );
}

{
  const codes = squareWave(96, 8, 2);
  const mask = new Uint8Array(96);
  mask[28] = 1;
  const gapped = scan(codes, { unknown: mask });
  check(
    'a gap inside one middle period excludes exactly that period and keeps the 25% duty',
    gapped.crossingCount === 11 && gapped.dutyPeriods === 9 &&
      gapped.dutyExcludedPeriods === 1 && gapped.dutyKnownSamples === 72 &&
      gapped.dutyHighSamples === 18 && gapped.dutyPercent === 25,
    `crossings=${gapped.crossingCount}, periods=${gapped.dutyPeriods}, ` +
      `excluded=${gapped.dutyExcludedPeriods}, known=${gapped.dutyKnownSamples}, ` +
      `high=${gapped.dutyHighSamples}, duty=${gapped.dutyPercent}`,
  );
  check(
    'the gap exclusion is the only difference from the ungapped scan',
    scan(codes).dutyExcludedPeriods === 0 && gapped.unknown === 1 &&
      gapped.dutyKnownSamples === scan(codes).dutyKnownSamples - 8,
    `excluded=${gapped.dutyExcludedPeriods}, unknown=${gapped.unknown}, ` +
      `known=${gapped.dutyKnownSamples} vs ${scan(codes).dutyKnownSamples}`,
  );

  const clippedCodes = squareWave(96, 8, 2);
  clippedCodes.fill(255, 40, 42);
  const clipped = scan(clippedCodes, { window: 2 });
  check(
    'a sustained clip run inside one middle period excludes exactly that period',
    clipped.clippedHigh && !clipped.clippedLow && clipped.crossingCount === 11 &&
      clipped.dutyPeriods === 9 && clipped.dutyExcludedPeriods === 1 &&
      clipped.dutyKnownSamples === 72 && clipped.dutyPercent === 25,
    `clipped=${clipped.clippedHigh}/${clipped.clippedLow}, crossings=${clipped.crossingCount}, ` +
      `periods=${clipped.dutyPeriods}, excluded=${clipped.dutyExcludedPeriods}, ` +
      `known=${clipped.dutyKnownSamples}, duty=${clipped.dutyPercent}`,
  );
  const unclipped = scan(squareWave(96, 8, 2), { window: 2 });
  check(
    'the same corner is a normal period without the clip run',
    unclipped.dutyPeriods === 10 && unclipped.dutyExcludedPeriods === 0 &&
      unclipped.dutyPercent === 25,
    `periods=${unclipped.dutyPeriods}, excluded=${unclipped.dutyExcludedPeriods}, ` +
      `duty=${unclipped.dutyPercent}`,
  );
}

{
  const core = squareWave(64, 8, 2);
  const codes = new Uint8Array(20 + core.length + 20);
  codes.fill(200, 0, 20);
  codes.set(core, 20);
  codes.fill(200, 20 + core.length, codes.length);
  const duty = scan(codes);
  let wholeHigh = 0;
  for (let i = 0; i < codes.length; i += 1) if (codes[i]! >= 128) wholeHigh += 1;
  const wholePercent = (100 * wholeHigh) / codes.length;
  check(
    'leading and trailing highs outside the recorded crossings never enter the duty',
    duty.dutyPeriods === 6 && duty.dutyKnownSamples === 48 && duty.dutyHighSamples === 12 &&
      duty.dutyPercent === 25 && wholePercent > 50,
    `periods=${duty.dutyPeriods}, known=${duty.dutyKnownSamples}, ` +
      `high=${duty.dutyHighSamples}, duty=${duty.dutyPercent}, whole=${wholePercent}`,
  );
}

{
  const capped = scan(squareWave(96, 8, 2), { maxCrossings: 4 });
  check(
    'a crossing cap pairs only the recorded crossings and never claims full coverage',
    capped.crossingCap && capped.crossingCount === 4 && capped.firstCrossing === 8 &&
      capped.lastCrossing === 32 && capped.dutyPeriods === 3 &&
      capped.dutyExcludedPeriods === 0 && capped.dutyKnownSamples === 24 &&
      capped.dutyHighSamples === 6 && capped.dutyPercent === 25,
    `cap=${capped.crossingCap}, crossings=${capped.crossingCount}, ` +
      `first=${capped.firstCrossing}, last=${capped.lastCrossing}, ` +
      `periods=${capped.dutyPeriods}, known=${capped.dutyKnownSamples}, ` +
      `duty=${capped.dutyPercent}`,
  );
}

{
  const build = (first: readonly number[], second: readonly number[]): Uint8Array => {
    const out = new Uint8Array(40);
    out.fill(200, 0, 10);
    out.set(first, 10);
    out.fill(60, 10 + first.length, 20);
    out.fill(200, 20, 30);
    out.set(second, 30);
    out.fill(60, 30 + second.length, 40);
    return out;
  };
  const atLevel = scan(build([128, 60], [120, 60]), { rising: false, window: 2 });
  check(
    'a falling crossing decided one sample late keeps the level sample at the period boundary',
    atLevel.crossingCount === 2 && atLevel.firstCrossing === 10 && atLevel.lastCrossing === 30 &&
      atLevel.dutyPeriods === 1 && atLevel.dutyExcludedPeriods === 0 &&
      atLevel.dutyKnownSamples === 20 && atLevel.dutyHighSamples === 11 &&
      atLevel.dutyPercent === 55,
    `crossings=${atLevel.crossingCount}/${atLevel.firstCrossing}/${atLevel.lastCrossing}, ` +
      `known=${atLevel.dutyKnownSamples}, high=${atLevel.dutyHighSamples}, ` +
      `duty=${atLevel.dutyPercent}`,
  );
  const levelRun = scan(build([128, 128, 128], [120, 120]), { rising: false, window: 2 });
  check(
    'the delayed decision samples stay in the closing period and are counted once',
    levelRun.crossingCount === 2 && levelRun.dutyPeriods === 1 &&
      levelRun.dutyKnownSamples === 20 && levelRun.dutyHighSamples === 13 &&
      levelRun.dutyPercent === 65,
    `crossings=${levelRun.crossingCount}, known=${levelRun.dutyKnownSamples}, ` +
      `high=${levelRun.dutyHighSamples}, duty=${levelRun.dutyPercent}`,
  );
}

{
  const capped = scan(periodic(4000, 4, 0, 255), { window: 0 });
  check(
    'a long square wave reports the 512-crossing cap from the first 512 crossings',
    capped.crossingCap && capped.crossingCount === 512 && capped.firstCrossing === 1 &&
      capped.lastCrossing === 2045 && capped.periodSamples === 4 &&
      capped.frequencyHz === RATE / 4 && capped.status === 'ok',
    `cap=${capped.crossingCap}, count=${capped.crossingCount}, first=${capped.firstCrossing}, ` +
      `last=${capped.lastCrossing}, period=${capped.periodSamples}`,
  );
}

{
  const base = scan(sine);
  const gain3 = scan(sine, { voltsPerCode: LSB / 3 });
  check(
    'a 3x gain leaves every code-domain answer unchanged',
    gain3.minCode === base.minCode && gain3.maxCode === base.maxCode &&
      gain3.vppCodes === base.vppCodes && gain3.meanOffsetCodes === base.meanOffsetCodes &&
      gain3.rmsOffsetCodes === base.rmsOffsetCodes && gain3.crossingCount === base.crossingCount,
    `vpp=${gain3.vppCodes}, mean=${gain3.meanOffsetCodes}, rms=${gain3.rmsOffsetCodes}`,
  );
  nearly('3x gain: Vpp volts scale exactly', gain3.vppVolts, base.vppVolts / 3, 1e-9);
  nearly('3x gain: min volts scale exactly', gain3.minVolts, base.minVolts / 3, 1e-9);
  nearly('3x gain: max volts scale exactly', gain3.maxVolts, base.maxVolts / 3, 1e-9);
  nearly('3x gain: mean volts scale exactly', gain3.meanVolts, base.meanVolts / 3, 1e-9);
  nearly('3x gain: RMS volts scale exactly', gain3.rmsVolts, base.rmsVolts / 3, 1e-9);
}

{
  const codes = filled(8, 128);
  const refuses = (extra: ScanOverrides): boolean => {
    try {
      scan(codes, extra);
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  };
  const negativeLength = { length: -1 } as unknown as ArrayLike<number>;
  throwsRange('refuses a negative codes length',
    () => scanAnalogCodes({ ...BASE, codes: negativeLength }));
  check(
    'refuses every invalid calibration, threshold, window, cap and mask',
    refuses({ samplerate: 0 }) && refuses({ samplerate: -1 }) && refuses({ samplerate: Number.NaN }) &&
      refuses({ samplerate: Number.POSITIVE_INFINITY }) &&
      refuses({ zeroCode: Number.NaN }) && refuses({ zeroCode: Number.POSITIVE_INFINITY }) &&
      refuses({ voltsPerCode: 0 }) && refuses({ voltsPerCode: -1 }) &&
      refuses({ voltsPerCode: Number.NaN }) && refuses({ voltsPerCode: Number.POSITIVE_INFINITY }) &&
      refuses({ level: -1 }) && refuses({ level: 256 }) && refuses({ level: 1.5 }) &&
      refuses({ level: Number.NaN }) &&
      refuses({ hysteresis: -1 }) && refuses({ hysteresis: 1.5 }) && refuses({ hysteresis: Number.NaN }) &&
      refuses({ window: -1 }) && refuses({ window: 1.5 }) && refuses({ window: Number.NaN }) &&
      refuses({ maxCrossings: 0 }) && refuses({ maxCrossings: -1 }) &&
      refuses({ maxCrossings: 1.5 }) && refuses({ maxCrossings: Number.NaN }) &&
      refuses({ unknown: new Uint8Array(3) }),
    'one or more invalid inputs were accepted',
  );

  const acceptsCodes = (codes: ArrayLike<number>): boolean => {
    try {
      scan(codes as Uint8Array, { window: 1 });
      return true;
    } catch {
      return false;
    }
  };
  const refusesCode = (code: number): boolean => !acceptsCodes([100, 200, code, 100]);
  check(
    'refuses a code that is outside 0..255 or not a whole number',
    refusesCode(-1) && refusesCode(256) && refusesCode(1.5) && refusesCode(Number.NaN) &&
      refusesCode(Number.POSITIVE_INFINITY),
    'an out-of-range or non-integer code was accepted',
  );
  check(
    'accepts the endpoint codes 0 and 255',
    acceptsCodes([0, 255, 0, 255]) && acceptsCodes(new Uint8Array([255, 0, 255, 0])),
    'an in-range code was refused',
  );
}

{
  const whole = scan(sine);
  const failures: string[] = [];
  for (const size of [1, 2, 3, 7, 64, 1000]) {
    const diff = sameScan(whole, chunked(sine, () => size));
    if (diff) failures.push(`${size}: ${diff}`);
  }
  check(
    'chunked sine: chunk sizes 1, 2, 3, 7, 64 and 1000 reproduce every whole-array field',
    failures.length === 0,
    failures.join(' | '),
  );

  const random = lcg(0x5eed_1234);
  const randomFailures: string[] = [];
  for (let run = 0; run < 5; run += 1) {
    const diff = sameScan(whole, chunked(sine, () => 1 + Math.floor(random() * 997)));
    if (diff) randomFailures.push(`run ${run}: ${diff}`);
  }
  check(
    'chunked sine: five pseudo-random splits reproduce every whole-array field',
    randomFailures.length === 0,
    randomFailures.join(' | '),
  );

  let singles = 0;
  let sixtyFours = 0;
  const singleSample = chunked(sine, () => { singles += 1; return 1; });
  const sixtyFour = chunked(sine, () => { sixtyFours += 1; return 64; });
  check(
    'the chunked driver really splits the fixture into 300 000 and 4688 pushes',
    singles === 300000 && sixtyFours === 4688 &&
      sameScan(whole, singleSample) === '' && sameScan(whole, sixtyFour) === '',
    `singles=${singles}, sixtyFours=${sixtyFours}`,
  );
  check(
    'chunked sine: the equivalence covers 30 carried crossings and 29 carried duty periods',
    whole.crossingCount === 30 && whole.dutyPeriods === 29 && whole.dutyExcludedPeriods === 0 &&
      whole.dutyKnownSamples > 0 && whole.frequencyHz === chunked(sine, () => 64).frequencyHz,
    `crossings=${whole.crossingCount}, periods=${whole.dutyPeriods}, ` +
      `known=${whole.dutyKnownSamples}`,
  );
}

{
  const codes = periodic(4000, 4, 0, 255);
  const whole = scan(codes, { window: 0 });
  const coarse = chunked(codes, () => 1000, { window: 0 });
  const fine = chunked(codes, () => 3, { window: 0 });
  check(
    'chunked cap: the 512-crossing cap and its frozen duty survive every chunk boundary',
    whole.crossingCap && whole.crossingCount === 512 && whole.firstCrossing === 1 &&
      whole.lastCrossing === 2045 && sameScan(whole, coarse) === '' && sameScan(whole, fine) === '',
    `cap=${whole.crossingCap}, count=${whole.crossingCount}, ` +
      `coarse=${sameScan(whole, coarse)}, fine=${sameScan(whole, fine)}`,
  );
}

{
  const accumulator = new AnalogCodeScanAccumulator({ ...BASE });
  accumulator.push(sine.subarray(0, 5000));
  accumulator.push(sine.subarray(5000, 9000));
  const first = accumulator.finish();
  const again = accumulator.finish();
  check(
    'finish() is idempotent: a second call returns the same result object',
    first === again && first.analyzed === 9000 && sameScan(first, scan(sine.subarray(0, 9000))) === '',
    `same=${first === again}, analyzed=${first.analyzed}`,
  );
  throwsRange('push after finish() throws RangeError', () => accumulator.push(new Uint8Array(1)));
  check(
    'push after finish() leaves the returned result untouched',
    accumulator.finish() === first && first.analyzed === 9000,
    `analyzed=${first.analyzed}`,
  );
}

{
  const accumulator = new AnalogCodeScanAccumulator({ ...BASE });
  accumulator.push(sine.subarray(0, 600));
  throwsRange(
    'a rejected sample marks the accumulator',
    () => accumulator.push([sine[600]!, 999, sine[601]!]),
  );
  throwsRange('finish after a rejected sample throws RangeError', () => accumulator.finish());
  throwsRange(
    'push after a rejected sample throws RangeError',
    () => accumulator.push(sine.subarray(603, 700)),
  );
  throwsRange('finish stays refused for a rejected accumulator', () => accumulator.finish());

  const validated = new AnalogCodeScanAccumulator({ ...BASE });
  validated.push(sine.subarray(0, 4));
  throwsRange(
    'a length-only rejection does not mark the accumulator',
    () => validated.push(sine.subarray(4, 8), new Uint8Array(2)),
  );
  validated.push(sine.subarray(4, 8));
  check(
    'a length-only rejection leaves the accumulator usable and counting',
    sameScan(validated.finish(), scan(sine.subarray(0, 8))) === '',
    sameScan(validated.finish(), scan(sine.subarray(0, 8))),
  );
}

{
  const whole = scan(sine);
  const accumulator = new AnalogCodeScanAccumulator({ ...BASE });
  const head = sine.slice(0, 30000);
  const mask = new Uint8Array(30000);
  accumulator.push(head, mask);
  head.fill(0);
  mask.fill(1);
  accumulator.push(sine.subarray(30000));
  check(
    'no pushed chunk is retained: overwriting it in place after push changes nothing',
    sameScan(whole, accumulator.finish()) === '',
    sameScan(whole, accumulator.finish()),
  );
}

{
  const whole = scan(sine.subarray(0, 20000));
  const accumulator = new AnalogCodeScanAccumulator({ ...BASE });
  for (let at = 0; at < 20000; at += 500) {
    accumulator.push(sine.subarray(at, at));
    accumulator.push(sine.subarray(at, at + 500));
    accumulator.push(sine.subarray(at, at));
  }
  const withEmpties = accumulator.finish();
  check(
    'empty pushes are legal and change nothing',
    sameScan(whole, withEmpties) === '' && withEmpties.analyzed === 20000,
    sameScan(whole, withEmpties),
  );
  const nothing = new AnalogCodeScanAccumulator({ ...BASE }).finish();
  check(
    'a scan with no pushes reports the empty no-data result',
    nothing.analyzed === 0 && nothing.known === 0 && nothing.unknown === 0 &&
      nothing.status === 'no-data' && nothing.crossingCount === 0 && !nothing.crossingCap &&
      nothing.firstCrossing === -1 && nothing.lastCrossing === -1 &&
      nothing.dutyPeriods === 0 && Number.isNaN(nothing.dutyPercent),
    `analyzed=${nothing.analyzed}, status=${nothing.status}`,
  );
}

{
  const codes = squareWave(96, 8, 2);
  const mask = new Uint8Array(96);
  mask[28] = 1;
  const wholeGap = scan(codes, { unknown: mask });
  const clipCodes = squareWave(96, 8, 2);
  clipCodes.fill(255, 40, 44);
  const wholeClip = scan(clipCodes, { window: 2 });
  const failures: string[] = [];
  for (const size of [5, 27, 28, 29]) {
    const diff = sameScan(wholeGap, chunked(codes, () => size, {}, mask));
    if (diff) failures.push(`gap@${size}: ${diff}`);
  }
  for (const size of [40, 41, 42, 43]) {
    const diff = sameScan(wholeClip, chunked(clipCodes, () => size, { window: 2 }));
    if (diff) failures.push(`clip@${size}: ${diff}`);
  }
  check(
    'a gap run straddling a chunk boundary keeps the whole-array excluded-period count',
    wholeGap.dutyExcludedPeriods === 1 && wholeGap.dutyPeriods === 9 &&
      wholeGap.dutyKnownSamples === 72 && wholeGap.dutyPercent === 25 && failures.length === 0,
    `excluded=${wholeGap.dutyExcludedPeriods}, periods=${wholeGap.dutyPeriods}, ` +
      `known=${wholeGap.dutyKnownSamples}, duty=${wholeGap.dutyPercent} ${failures.join(' | ')}`,
  );
  check(
    'a clipping run straddling a chunk boundary keeps the whole-array excluded-period count',
    wholeClip.clippedHigh && !wholeClip.clippedLow && wholeClip.dutyExcludedPeriods === 1 &&
      wholeClip.dutyPeriods === 9 && wholeClip.dutyKnownSamples === 72 && failures.length === 0,
    `clipped=${wholeClip.clippedHigh}/${wholeClip.clippedLow}, ` +
      `excluded=${wholeClip.dutyExcludedPeriods}, periods=${wholeClip.dutyPeriods}, ` +
      `known=${wholeClip.dutyKnownSamples} ${failures.join(' | ')}`,
  );
}

{
  const whole = scan(sine);
  const missed: string[] = [];
  for (const key of Object.keys(whole) as (keyof AnalogCodeScan)[]) {
    if (sameScan(whole, perturbed(whole, key)) === '') missed.push(String(key));
  }
  check(
    'the chunk comparator detects a one-unit change in every single scan field',
    missed.length === 0,
    `undetected: ${missed.join(', ')}`,
  );

  const perChunk: AnalogCodeScan = (() => {
    let last = scan(sine.subarray(0, 1000));
    let analyzed = 0;
    let known = 0;
    let unknown = 0;
    for (let at = 0; at < sine.length; at += 1000) {
      last = scan(sine.subarray(at, at + 1000));
      analyzed += last.analyzed;
      known += last.known;
      unknown += last.unknown;
    }
    return { ...last, analyzed, known, unknown };
  })();
  const rejected = sameScan(whole, perChunk);
  check(
    'a driver that restarts indices and the duty ring per chunk is rejected by the comparator',
    rejected.includes('crossingCount') && rejected.includes('dutyPeriods') &&
      rejected.includes('firstCrossing') && rejected.includes('dutyKnownSamples'),
    rejected,
  );
}

{
  const accumulator = new AnalogCodeScanAccumulator({ ...BASE });
  accumulator.push(sine.subarray(0, 4));
  throwsRange(
    'a later push whose unknown mask has a different length throws RangeError',
    () => accumulator.push(sine.subarray(4, 8), new Uint8Array(2)),
  );
  let message = '';
  let rangeError = false;
  try {
    accumulator.push([100, 200, 300, 120]);
  } catch (error) {
    rangeError = error instanceof RangeError;
    message = error instanceof Error ? error.message : String(error);
  }
  check(
    'an out-of-range code in a later push names its absolute sample index',
    rangeError && message === 'codes[6] must be an integer in 0..255, got 300',
    message,
  );
  let wholeMessage = '';
  try {
    scan([100, 200, 300, 120]);
  } catch (error) {
    wholeMessage = error instanceof Error ? error.message : String(error);
  }
  check(
    'the whole-array path keeps the same absolute-index code message',
    wholeMessage === 'codes[2] must be an integer in 0..255, got 300',
    wholeMessage,
  );
}

for (const result of results) {
  if (result.pass) {
    console.log(`ok   ${result.name}`);
  } else {
    console.log(`FAIL ${result.name}: ${result.detail}`);
  }
}
const failures = results.filter((result) => !result.pass);
console.log(`analog scan selftest: ${results.length - failures.length}/${results.length} passed`);
if (failures.length > 0) {
  throw new Error(`${failures.length} analog scan selftest check(s) failed`);
}
