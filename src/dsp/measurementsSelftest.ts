// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic self-test for the M1 measurements module.
 *
 * Run with:
 *   node_modules/.bin/esbuild src/dsp/measurementsSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/measurements-selftest.mjs --log-level=error \
 *     && node /tmp/measurements-selftest.mjs
 *
 * No device, DOM, store or storage is involved. Signals are synthesized from known
 * formulas, so every expected value is derivable rather than captured.
 */

import {
  DEFAULT_FREQUENCY_MAX_SAMPLES,
  estimateDigitalFrequency,
  measureAnalogRange,
  measureDigitalRange,
  type AnalogMeasurements,
  type DigitalFrequencyEstimate,
  type DigitalMeasurements,
} from './measurements.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function nearly(
  name: string,
  actual: number,
  expected: number,
  tolerance = 1e-12,
): void {
  check(
    name,
    closeTo(actual, expected, tolerance),
    `got ${actual}, expected ${expected} +/- ${tolerance}`,
  );
}

function isNaNField(name: string, value: number): void {
  check(name, Number.isNaN(value), `got ${value}, expected NaN`);
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

// ---------------------------------------------------------------------------------
// Analog summaries

{
  const dc = new Float64Array(64);
  dc.fill(2.5);
  const m = measureAnalogRange(dc, 0, dc.length);
  check('analog DC: count', m.count === 64, `got ${m.count}`);
  nearly('analog DC: min', m.min, 2.5);
  nearly('analog DC: max', m.max, 2.5);
  nearly('analog DC: mean', m.mean, 2.5);
  nearly('analog DC: rms', m.rms, 2.5);
  nearly('analog DC: peak-to-peak', m.peakToPeak, 0);
}

{
  // Eight full cycles over 1024 samples: the mean is zero and the RMS is A/sqrt(2).
  const amplitude = 2;
  const cycles = 8;
  const n = 1024;
  const sine = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    sine[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / n);
  }
  const m = measureAnalogRange(sine, 0, n);
  check('analog sine: count', m.count === n, `got ${m.count}`);
  nearly('analog sine: mean', m.mean, 0, 1e-12);
  nearly('analog sine: rms', m.rms, amplitude / Math.SQRT2, 1e-12);
  nearly('analog sine: min', m.min, -amplitude, 1e-12);
  nearly('analog sine: max', m.max, amplitude, 1e-12);
  nearly('analog sine: peak-to-peak', m.peakToPeak, 2 * amplitude, 1e-12);
}

{
  const ramp: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const m = measureAnalogRange(ramp, 2, 5);
  check('analog range: only [start, end) is measured', m.count === 3, `got ${m.count}`);
  nearly('analog range: min', m.min, 2);
  nearly('analog range: max', m.max, 4);
  nearly('analog range: mean', m.mean, 3);
  nearly('analog range: rms', m.rms, Math.sqrt(29 / 3), 1e-12);
  nearly('analog range: peak-to-peak', m.peakToPeak, 2);
}

{
  const float32 = new Float32Array([0.5, 1.5, 2.5]);
  const m = measureAnalogRange(float32, 0, float32.length);
  nearly('analog Float32Array input: mean', m.mean, 1.5);
  nearly('analog Float32Array input: rms', m.rms, Math.sqrt(8.75 / 3), 1e-6);
}

{
  const empty = measureAnalogRange(new Float64Array(4), 2, 2);
  check('analog empty range: count is zero', empty.count === 0, `got ${empty.count}`);
  isNaNField('analog empty range: min is NaN', empty.min);
  isNaNField('analog empty range: max is NaN', empty.max);
  isNaNField('analog empty range: mean is NaN', empty.mean);
  isNaNField('analog empty range: rms is NaN', empty.rms);
  isNaNField('analog empty range: peak-to-peak is NaN', empty.peakToPeak);
}

{
  const one = measureAnalogRange(new Float64Array([-3.5]), 0, 1);
  check('analog one sample: count', one.count === 1, `got ${one.count}`);
  nearly('analog one sample: min', one.min, -3.5);
  nearly('analog one sample: max', one.max, -3.5);
  nearly('analog one sample: mean', one.mean, -3.5);
  nearly('analog one sample: rms', one.rms, 3.5);
  nearly('analog one sample: peak-to-peak', one.peakToPeak, 0);
}

{
  const withUnknown = new Float64Array([1, Number.NaN, 3, Number.POSITIVE_INFINITY]);
  const m = measureAnalogRange(withUnknown, 0, withUnknown.length);
  check('analog unknown samples: skipped, not counted', m.count === 2, `got ${m.count}`);
  nearly('analog unknown samples: min', m.min, 1);
  nearly('analog unknown samples: max', m.max, 3);
  nearly('analog unknown samples: mean', m.mean, 2);
  nearly('analog unknown samples: rms', m.rms, Math.sqrt(5), 1e-12);
}

{
  const centered = new Float64Array([-1, 1]);
  const m = measureAnalogRange(centered, 0, 2);
  nearly('analog negative samples: mean', m.mean, 0);
  nearly('analog negative samples: rms', m.rms, 1);
}

{
  // Naive summation loses both 1s here; Neumaier compensation must keep them.
  const tricky = new Float64Array([1e16, 1, -1e16, 1]);
  const m = measureAnalogRange(tricky, 0, tricky.length);
  nearly('analog compensated sum: mean keeps the small terms', m.mean, 0.5, 1e-9);
}

{
  const out: AnalogMeasurements = {
    count: -1,
    min: -1,
    max: -1,
    mean: -1,
    rms: -1,
    peakToPeak: -1,
  };
  const returned = measureAnalogRange(new Float64Array([1, 2, 3]), 0, 3, out);
  check('analog out: the supplied object is returned', returned === out, 'a new object was returned');
  check(
    'analog out: every field is overwritten',
    out.count === 3 && out.min === 1 && out.max === 3 && out.mean === 2 &&
      closeTo(out.rms, Math.sqrt(14 / 3), 1e-12) && out.peakToPeak === 2,
    JSON.stringify(out),
  );
  measureAnalogRange(new Float64Array([1, 2, 3]), 1, 1, out);
  check('analog out: empty measurement overwrites stale fields', out.count === 0, `got ${out.count}`);
  check(
    'analog out: empty measurement clears highCount-like stale values',
    Number.isNaN(out.min) && Number.isNaN(out.mean) && Number.isNaN(out.peakToPeak),
    JSON.stringify(out),
  );
}

{
  const samples = new Float64Array(4);
  throwsRange('analog range refuses a negative start', () => measureAnalogRange(samples, -1, 2));
  throwsRange('analog range refuses an end past the array', () => measureAnalogRange(samples, 0, 5));
  throwsRange('analog range refuses a reversed range', () => measureAnalogRange(samples, 3, 2));
  throwsRange('analog range refuses a fractional bound', () => measureAnalogRange(samples, 0.5, 2));
  throwsRange('analog range refuses a NaN bound', () => measureAnalogRange(samples, 0, Number.NaN));
}

// ---------------------------------------------------------------------------------
// Digital summaries

{
  const square = new Uint8Array(100);
  square.fill(1, 0, 50);
  const m = measureDigitalRange(square, 0, square.length);
  check('digital square: count', m.count === 100, `got ${m.count}`);
  check('digital square: highCount', m.highCount === 50, `got ${m.highCount}`);
  nearly('digital square: min', m.min, 0);
  nearly('digital square: max', m.max, 1);
  nearly('digital square: mean equals duty', m.mean, 0.5);
  nearly('digital square: dutyCycle', m.dutyCycle, 0.5);
  nearly('digital square: rms', m.rms, Math.SQRT1_2);
  nearly('digital square: peak-to-peak', m.peakToPeak, 1);
}

{
  // Digital levels are normalized to 0/1: any nonzero finite value is high.
  const levels = new Uint8Array([0, 2, 255, 0]);
  const m = measureDigitalRange(levels, 0, levels.length);
  check('digital nonzero levels: normalized high count', m.highCount === 2, `got ${m.highCount}`);
  nearly('digital nonzero levels: min is a level', m.min, 0);
  nearly('digital nonzero levels: max is a level', m.max, 1);
  nearly('digital nonzero levels: mean', m.mean, 0.5);
  nearly('digital nonzero levels: dutyCycle', m.dutyCycle, 0.5);
}

{
  const levels = new Float64Array([0, Number.NaN, 1, Number.POSITIVE_INFINITY]);
  const m = measureDigitalRange(levels, 0, levels.length);
  check('digital unknown samples: skipped', m.count === 2, `got ${m.count}`);
  check('digital unknown samples: not counted high', m.highCount === 1, `got ${m.highCount}`);
  nearly('digital unknown samples: duty over known samples', m.dutyCycle, 0.5);
}

{
  const allLow = measureDigitalRange(new Uint8Array(4), 0, 4);
  check(
    'digital all low: min/max/mean/rms are 0',
    allLow.min === 0 && allLow.max === 0 && allLow.mean === 0 && allLow.rms === 0,
    JSON.stringify(allLow),
  );
  check('digital all low: duty 0', allLow.dutyCycle === 0, `got ${allLow.dutyCycle}`);
  const allHigh = measureDigitalRange(new Uint8Array([1, 1, 1]), 0, 3);
  check(
    'digital all high: min/max/mean/rms are 1',
    allHigh.min === 1 && allHigh.max === 1 && allHigh.mean === 1 && allHigh.rms === 1,
    JSON.stringify(allHigh),
  );
  check('digital all high: duty 1', allHigh.dutyCycle === 1, `got ${allHigh.dutyCycle}`);
}

{
  const empty = measureDigitalRange(new Uint8Array(4), 1, 1);
  check('digital empty range: count is zero', empty.count === 0, `got ${empty.count}`);
  check('digital empty range: highCount is zero', empty.highCount === 0, `got ${empty.highCount}`);
  isNaNField('digital empty range: min is NaN', empty.min);
  isNaNField('digital empty range: duty is NaN', empty.dutyCycle);

  const one = measureDigitalRange(new Uint8Array([1]), 0, 1);
  check('digital one sample: count', one.count === 1, `got ${one.count}`);
  nearly('digital one sample: duty', one.dutyCycle, 1);
}

{
  const levels = new Uint8Array([0, 1, 1, 0, 1, 0]);
  const m = measureDigitalRange(levels, 1, 5);
  check('digital range: count', m.count === 4, `got ${m.count}`);
  check('digital range: highCount', m.highCount === 3, `got ${m.highCount}`);
  nearly('digital range: duty', m.dutyCycle, 0.75);
}

{
  const out: DigitalMeasurements = {
    count: -1,
    min: -1,
    max: -1,
    mean: -1,
    rms: -1,
    peakToPeak: -1,
    highCount: -1,
    dutyCycle: -1,
  };
  const returned = measureDigitalRange(new Uint8Array([1, 0]), 0, 2, out);
  check('digital out: the supplied object is returned', returned === out, 'a new object was returned');
  check(
    'digital out: every field is overwritten',
    out.count === 2 && out.highCount === 1 && out.min === 0 && out.max === 1 &&
      out.mean === 0.5 && out.dutyCycle === 0.5,
    JSON.stringify(out),
  );
}

// ---------------------------------------------------------------------------------
// Frequency/period estimation

function squareWave(length: number, period: number, highSamples: number): Uint8Array {
  const levels = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    if (i % period < highSamples) levels[i] = 1;
  }
  return levels;
}

{
  const levels = squareWave(200, 20, 10);
  const estimate = estimateDigitalFrequency(levels, 1000);
  check('frequency square: status ok', estimate.status === 'ok', estimate.status);
  check('frequency square: inspected the whole range', estimate.inspectedSamples === 200, `got ${estimate.inspectedSamples}`);
  check('frequency square: measured samples', estimate.measuredSamples === 200, `got ${estimate.measuredSamples}`);
  check('frequency square: rising edges', estimate.risingEdges === 9, `got ${estimate.risingEdges}`);
  // The falling edge at sample 190 completes the last high run, so it is counted
  // even though the following rising edge would be outside the window.
  check('frequency square: falling edges', estimate.fallingEdges === 10, `got ${estimate.fallingEdges}`);
  check('frequency square: first rising index', estimate.firstRisingIndex === 20, `got ${estimate.firstRisingIndex}`);
  check('frequency square: last rising index', estimate.lastRisingIndex === 180, `got ${estimate.lastRisingIndex}`);
  nearly('frequency square: period samples', estimate.periodSamples, 20);
  nearly('frequency square: period seconds', estimate.periodSeconds, 0.02);
  nearly('frequency square: frequency', estimate.frequencyHz, 50);
  nearly('frequency square: duty', estimate.dutyCycle, 0.5);
}

{
  const levels = squareWave(200, 20, 10);
  const estimate = estimateDigitalFrequency(levels, 1000, { start: 20, end: 120 });
  check('frequency range: status ok', estimate.status === 'ok', estimate.status);
  check('frequency range: inspected only the range', estimate.inspectedSamples === 100, `got ${estimate.inspectedSamples}`);
  check('frequency range: first rising index', estimate.firstRisingIndex === 40, `got ${estimate.firstRisingIndex}`);
  check('frequency range: last rising index', estimate.lastRisingIndex === 100, `got ${estimate.lastRisingIndex}`);
  nearly('frequency range: frequency', estimate.frequencyHz, 50);
  nearly('frequency range: duty', estimate.dutyCycle, 0.5);
}

{
  const levels = squareWave(200, 20, 10);
  const bounded = estimateDigitalFrequency(levels, 1000, { maxSamples: 45 });
  check('frequency bound: inspect at most maxSamples', bounded.inspectedSamples === 45, `got ${bounded.inspectedSamples}`);
  check('frequency bound: last rising index inside the prefix', bounded.lastRisingIndex === 40, `got ${bounded.lastRisingIndex}`);
  nearly('frequency bound: frequency still exact', bounded.frequencyHz, 50);
  check(
    'frequency default bound is 2^20',
    DEFAULT_FREQUENCY_MAX_SAMPLES === 1 << 20,
    `got ${DEFAULT_FREQUENCY_MAX_SAMPLES}`,
  );

  const oneEdge = estimateDigitalFrequency(levels, 1000, { maxSamples: 21 });
  check('frequency bound: one rising edge is not a period', oneEdge.status === 'one-rising-edge', oneEdge.status);
  check('frequency bound: one edge inspected', oneEdge.inspectedSamples === 21, `got ${oneEdge.inspectedSamples}`);
  isNaNField('frequency bound: period NaN without two edges', oneEdge.periodSamples);
  isNaNField('frequency bound: frequency NaN without two edges', oneEdge.frequencyHz);

  const noEdge = estimateDigitalFrequency(levels, 1000, { maxSamples: 1 });
  check('frequency bound: a one-sample prefix has no edge', noEdge.status === 'no-rising-edges', noEdge.status);
  check('frequency bound: one sample inspected', noEdge.inspectedSamples === 1, `got ${noEdge.inspectedSamples}`);
}

{
  const noEdges = estimateDigitalFrequency(new Uint8Array(100), 1000);
  check('frequency constant low: no rising edges', noEdges.status === 'no-rising-edges', noEdges.status);
  check('frequency constant low: inspected all', noEdges.inspectedSamples === 100, `got ${noEdges.inspectedSamples}`);
  check('frequency constant low: first index is -1', noEdges.firstRisingIndex === -1, `got ${noEdges.firstRisingIndex}`);
  isNaNField('frequency constant low: duty NaN', noEdges.dutyCycle);

  const constantHigh = estimateDigitalFrequency(new Uint8Array(100).fill(1), 1000);
  check('frequency constant high: no rising edges', constantHigh.status === 'no-rising-edges', constantHigh.status);
}

{
  // Unknown samples break continuity; no edge is counted across the gap.
  const levels = new Float64Array([0, 1, Number.NaN, 1, 0, 1, 0, 1]);
  const estimate = estimateDigitalFrequency(levels, 1000);
  check('frequency gap: status ok', estimate.status === 'ok', estimate.status);
  check('frequency gap: three rising edges', estimate.risingEdges === 3, `got ${estimate.risingEdges}`);
  check('frequency gap: two falling edges', estimate.fallingEdges === 2, `got ${estimate.fallingEdges}`);
  check('frequency gap: measured finite samples', estimate.measuredSamples === 7, `got ${estimate.measuredSamples}`);
  nearly('frequency gap: period', estimate.periodSamples, 3);
  nearly('frequency gap: duty over finite span', estimate.dutyCycle, 0.6);
}

{
  const empty = estimateDigitalFrequency(new Uint8Array(8), 1000, { start: 4, end: 4 });
  check('frequency empty range: status', empty.status === 'empty-range', empty.status);
  check('frequency empty range: inspected zero', empty.inspectedSamples === 0, `got ${empty.inspectedSamples}`);
  check('frequency empty range: first index -1', empty.firstRisingIndex === -1, `got ${empty.firstRisingIndex}`);
  isNaNField('frequency empty range: frequency NaN', empty.frequencyHz);

  const one = estimateDigitalFrequency(new Uint8Array([1]), 1000);
  check('frequency one sample: no edge', one.status === 'no-rising-edges', one.status);
}

{
  // Nyquist-rate square wave: one period every two samples.
  const levels = new Uint8Array(100);
  for (let i = 0; i < levels.length; i += 1) levels[i] = i % 2;
  const estimate = estimateDigitalFrequency(levels, 1000);
  check('frequency Nyquist square: status ok', estimate.status === 'ok', estimate.status);
  nearly('frequency Nyquist square: period', estimate.periodSamples, 2);
  nearly('frequency Nyquist square: frequency', estimate.frequencyHz, 500);
  nearly('frequency Nyquist square: duty', estimate.dutyCycle, 0.5);
}

{
  const out: DigitalFrequencyEstimate = {
    status: 'empty-range',
    inspectedSamples: -1,
    measuredSamples: -1,
    risingEdges: -1,
    fallingEdges: -1,
    firstRisingIndex: -1,
    lastRisingIndex: -1,
    periodSamples: -1,
    periodSeconds: -1,
    frequencyHz: -1,
    dutyCycle: -1,
  };
  const returned = estimateDigitalFrequency(squareWave(200, 20, 10), 1000, {}, out);
  check('frequency out: the supplied object is returned', returned === out, 'a new object was returned');
  check(
    'frequency out: every field is overwritten',
    out.status === 'ok' && out.inspectedSamples === 200 && out.risingEdges === 9 &&
      closeTo(out.frequencyHz, 50, 1e-12) && closeTo(out.dutyCycle, 0.5, 1e-12),
    JSON.stringify(out),
  );
}

{
  const levels = new Uint8Array(8);
  throwsRange('frequency refuses a zero sample rate', () => estimateDigitalFrequency(levels, 0));
  throwsRange('frequency refuses a negative sample rate', () => estimateDigitalFrequency(levels, -1));
  throwsRange('frequency refuses a NaN sample rate', () => estimateDigitalFrequency(levels, Number.NaN));
  throwsRange('frequency refuses a zero scan bound', () => estimateDigitalFrequency(levels, 1, { maxSamples: 0 }));
  throwsRange('frequency refuses a fractional scan bound', () => estimateDigitalFrequency(levels, 1, { maxSamples: 0.5 }));
  throwsRange('frequency refuses a reversed range', () => estimateDigitalFrequency(levels, 1, { start: 4, end: 2 }));
  throwsRange('frequency refuses an out-of-range end', () => estimateDigitalFrequency(levels, 1, { end: 9 }));
}

// ---------------------------------------------------------------------------------

for (const result of results) {
  if (result.pass) {
    console.log(`ok   ${result.name}`);
  } else {
    console.log(`FAIL ${result.name}: ${result.detail}`);
  }
}
const failures = results.filter((result) => !result.pass);
console.log(`measurements selftest: ${results.length - failures.length}/${results.length} passed`);
if (failures.length > 0) {
  throw new Error(`${failures.length} measurements selftest check(s) failed`);
}
