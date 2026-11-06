// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic self-test for the M1 radix-2 FFT, windows and spectrum helpers.
 *
 * Run with:
 *   node_modules/.bin/esbuild src/dsp/fftSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/fft-selftest.mjs --log-level=error \
 *     && node /tmp/fft-selftest.mjs
 *
 * Known signals (DC, impulse, Nyquist, single sine/cosine bin) and a fixed LCG noise
 * sequence give derivable expectations. No device, DOM or storage is involved.
 */

import {
  MAX_FFT_SIZE,
  WINDOW_KINDS,
  assertFftSize,
  binFrequencyHz,
  binMagnitude,
  binPhase,
  createFftPlan,
  fft,
  fftInPlace,
  fillWindow,
  ifft,
  ifftInPlace,
  magnitudeSpectrum,
  phaseSpectrum,
  windowCoefficient,
  windowPower,
  windowSum,
  type FftPlan,
  type WindowKind,
} from './fft.js';

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

function loadPlan(plan: FftPlan, real: ArrayLike<number>): void {
  plan.re.set(real);
  plan.im.fill(0);
}

function transformed(real: Float64Array): FftPlan {
  const plan = createFftPlan(real.length);
  loadPlan(plan, real);
  fftInPlace(plan);
  return plan;
}

function maxAbsDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    max = Math.max(max, Math.abs(a[i] - b[i]));
  }
  return max;
}

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ---------------------------------------------------------------------------------
// Sizes and plans

{
  const sizes = [1, 2, 4, 8, 1024];
  let accepted = true;
  for (const size of sizes) {
    const plan = createFftPlan(size);
    if (
      plan.size !== size ||
      plan.re.length !== size ||
      plan.im.length !== size ||
      plan.bitReversal.length !== size
    ) {
      accepted = false;
    }
  }
  check('fft plan: powers of two are accepted', accepted, `sizes ${sizes.join(', ')}`);

  const badSizes = [0, 3, 5, 6, 7, 12, 100, -4, 2.5, Number.NaN, Number.POSITIVE_INFINITY];
  const acceptedBad: number[] = [];
  for (const size of badSizes) {
    try {
      createFftPlan(size);
      acceptedBad.push(size);
    } catch (error) {
      if (!(error instanceof RangeError)) acceptedBad.push(size);
    }
  }
  check(
    'fft plan: zero, negative, fractional and non-power-of-two sizes are refused',
    acceptedBad.length === 0,
    `accepted ${acceptedBad.join(', ')}`,
  );

  throwsRange('fft plan: non-power-of-two refusal names the rule', () => assertFftSize(3));
  throwsRange('fft plan: size zero is refused', () => assertFftSize(0));
  throwsRange(
    'fft plan: sizes above MAX_FFT_SIZE are refused',
    () => assertFftSize(MAX_FFT_SIZE + 1),
  );
}

{
  // N = 1 is the identity transform, and its unique spectrum is the single bin.
  const plan = createFftPlan(1);
  plan.re[0] = 5;
  plan.im[0] = -2;
  fftInPlace(plan);
  check(
    'fft N=1: forward is the identity',
    plan.re[0] === 5 && plan.im[0] === -2,
    `${plan.re[0]} + ${plan.im[0]}i`,
  );
  ifftInPlace(plan);
  check(
    'fft N=1: inverse is the identity',
    plan.re[0] === 5 && plan.im[0] === -2,
    `${plan.re[0]} + ${plan.im[0]}i`,
  );
  const magnitudes = magnitudeSpectrum(plan.re, plan.im);
  check('fft N=1: one spectrum bin', magnitudes.length === 1, `got ${magnitudes.length}`);
  nearly('fft N=1: magnitude', magnitudes[0], Math.hypot(5, -2));
}

{
  // Two samples: DC and Nyquist are the only bins.
  const dc = new Float64Array([1, 1]);
  const plan = transformed(dc);
  nearly('fft N=2 DC: bin 0', plan.re[0], 2);
  nearly('fft N=2 DC: bin 1', plan.re[1], 0);
  nearly('fft N=2 DC: imaginary bin 1', plan.im[1], 0);

  const nyquist = new Float64Array([1, -1]);
  const plan2 = transformed(nyquist);
  nearly('fft N=2 Nyquist: bin 0', plan2.re[0], 0);
  nearly('fft N=2 Nyquist: bin 1', plan2.re[1], 2);
}

// ---------------------------------------------------------------------------------
// Known transforms

{
  const n = 8;
  const plan = createFftPlan(n);
  plan.re.fill(1);
  fftInPlace(plan);
  nearly('fft DC: X[0] is N times the amplitude', plan.re[0], n);
  let rest = 0;
  for (let k = 1; k < n; k += 1) {
    rest = Math.max(rest, Math.hypot(plan.re[k], plan.im[k]));
  }
  check('fft DC: all other bins are zero', rest <= 1e-12, `max magnitude ${rest}`);
}

{
  const n = 16;
  const plan = createFftPlan(n);
  plan.re[0] = 1;
  fftInPlace(plan);
  let worst = 0;
  for (let k = 0; k < n; k += 1) {
    worst = Math.max(worst, Math.abs(plan.re[k] - 1), Math.abs(plan.im[k]));
  }
  check('fft impulse: every bin is 1 + 0i', worst <= 1e-12, `max deviation ${worst}`);
}

{
  const n = 8;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = i % 2 === 0 ? 1 : -1;
  const plan = transformed(values);
  nearly('fft Nyquist: X[N/2] is N', plan.re[n / 2], n);
  let rest = 0;
  for (let k = 0; k < n; k += 1) {
    if (k === n / 2) continue;
    rest = Math.max(rest, Math.hypot(plan.re[k], plan.im[k]));
  }
  check('fft Nyquist: all other bins are zero', rest <= 1e-12, `max magnitude ${rest}`);
}

{
  // A full-cycle sine at bin 5: X[5] = -i*N/2 and X[N-5] = +i*N/2.
  const n = 64;
  const k = 5;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = Math.sin((2 * Math.PI * k * i) / n);
  const plan = transformed(values);
  nearly('fft sine: real part at k', plan.re[k], 0, 1e-12);
  nearly('fft sine: imaginary part at k is -N/2', plan.im[k], -n / 2, 1e-12);
  nearly('fft sine: real part at N-k', plan.re[n - k], 0, 1e-12);
  nearly('fft sine: imaginary part at N-k is +N/2', plan.im[n - k], n / 2, 1e-12);
  nearly('fft sine: binMagnitude', binMagnitude(plan.re, plan.im, k), n / 2, 1e-12);
  nearly('fft sine: binPhase', binPhase(plan.re, plan.im, k), -Math.PI / 2, 1e-12);

  const magnitudes = magnitudeSpectrum(plan.re, plan.im);
  check('fft sine: magnitude spectrum has N/2+1 bins', magnitudes.length === n / 2 + 1, `got ${magnitudes.length}`);
  nearly('fft sine: magnitude at k', magnitudes[k], n / 2, 1e-12);
  const phases = phaseSpectrum(plan.re, plan.im);
  nearly('fft sine: phase at k', phases[k], -Math.PI / 2, 1e-12);
  nearly('fft sine: bin frequency', binFrequencyHz(k, n, 640), 50);
}

{
  // A full-cycle cosine at bin 5 is real and positive in both conjugate bins.
  const n = 64;
  const k = 5;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = Math.cos((2 * Math.PI * k * i) / n);
  const plan = transformed(values);
  nearly('fft cosine: real part at k is N/2', plan.re[k], n / 2, 1e-12);
  nearly('fft cosine: real part at N-k is N/2', plan.re[n - k], n / 2, 1e-12);
  nearly('fft cosine: imaginary part at k', plan.im[k], 0, 1e-12);
  nearly('fft cosine: phase at k', binPhase(plan.re, plan.im, k), 0, 1e-12);
}

{
  // Parseval: sum |x|^2 equals (1/N) sum |X|^2 for a deterministic broadband signal.
  const n = 128;
  const next = makeLcg(0x9e3779b9);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    values[i] =
      0.8 * Math.sin((2 * Math.PI * 7 * i) / n) +
      0.5 * Math.cos((2 * Math.PI * 19 * i) / n) +
      0.1 * (next() - 0.5);
  }
  let timePower = 0;
  for (let i = 0; i < n; i += 1) timePower += values[i] * values[i];
  const plan = transformed(values);
  let frequencyPower = 0;
  for (let k = 0; k < n; k += 1) {
    frequencyPower += plan.re[k] * plan.re[k] + plan.im[k] * plan.im[k];
  }
  frequencyPower /= n;
  check(
    'fft Parseval: sum |x|^2 equals (1/N) sum |X|^2',
    Math.abs(timePower - frequencyPower) <= 1e-9 * Math.max(1, timePower),
    `time ${timePower}, frequency ${frequencyPower}`,
  );
}

{
  // Forward followed by inverse returns the input to rounding error.
  const n = 64;
  const next = makeLcg(12345);
  const plan = createFftPlan(n);
  for (let i = 0; i < n; i += 1) plan.re[i] = next() * 2 - 1;
  const original = Float64Array.from(plan.re);
  fftInPlace(plan);
  ifftInPlace(plan);
  const error = maxAbsDifference(plan.re, original);
  check('fft round trip: inverse restores the input', error <= 1e-12, `max error ${error}`);
  check(
    'fft round trip: imaginary part is zero',
    maxAbsDifference(plan.im, new Float64Array(n)) <= 1e-12,
    `max imaginary ${maxAbsDifference(plan.im, new Float64Array(n))}`,
  );
}

{
  // The convenience wrappers match the plan path and refuse invalid buffers.
  const n = 32;
  const next = makeLcg(777);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = next() * 2 - 1;

  const re = Float64Array.from(values);
  const im = new Float64Array(n);
  fft(re, im);
  const plan = transformed(values);
  check(
    'fft convenience: forward matches the plan path',
    maxAbsDifference(re, plan.re) <= 1e-12 &&
      maxAbsDifference(im, plan.im) <= 1e-12,
    `re error ${maxAbsDifference(re, plan.re)}, im error ${maxAbsDifference(im, plan.im)}`,
  );
  ifft(re, im);
  check(
    'ifft convenience: inverse restores the input',
    maxAbsDifference(re, values) <= 1e-12,
    `max error ${maxAbsDifference(re, values)}`,
  );

  throwsRange(
    'fft convenience refuses non-power-of-two buffers',
    () => fft(new Float64Array(3), new Float64Array(3)),
  );
  throwsRange(
    'fft convenience refuses mismatched buffer lengths',
    () => fft(new Float64Array(4), new Float64Array(2)),
  );
  throwsRange(
    'ifft convenience refuses non-power-of-two buffers',
    () => ifft(new Float64Array(6), new Float64Array(6)),
  );
}

{
  // A plan never reallocates its buffers when reused.
  const plan = createFftPlan(16);
  const re = plan.re;
  const im = plan.im;
  const bitReversal = plan.bitReversal;
  const cosTable = plan.cosTable;
  const sinTable = plan.sinTable;
  plan.re[0] = 1;
  fftInPlace(plan);
  fftInPlace(plan);
  check(
    'fft plan reuse: transform keeps the same buffers and tables',
    plan.re === re && plan.im === im && plan.bitReversal === bitReversal &&
      plan.cosTable === cosTable && plan.sinTable === sinTable && plan.size === 16,
    'a buffer or table was replaced',
  );

  const magnitudeOut = new Float64Array(9);
  check(
    'fft spectrum: magnitude output buffer is reused',
    magnitudeSpectrum(plan.re, plan.im, magnitudeOut) === magnitudeOut,
    'a new array was returned',
  );
  const phaseOut = new Float64Array(9);
  check(
    'fft spectrum: phase output buffer is reused',
    phaseSpectrum(plan.re, plan.im, phaseOut) === phaseOut,
    'a new array was returned',
  );
  throwsRange(
    'fft spectrum: magnitude output length is checked',
    () => magnitudeSpectrum(plan.re, plan.im, new Float64Array(8)),
  );
}

{
  // Non-finite input propagates, as documented; callers must clean gaps first.
  const plan = createFftPlan(4);
  plan.re.set([0, Number.NaN, 0, 0]);
  fftInPlace(plan);
  let allNaN = true;
  for (let k = 0; k < 4; k += 1) {
    if (!Number.isNaN(plan.re[k]) || !Number.isNaN(plan.im[k])) allNaN = false;
  }
  check('fft non-finite input: every bin is NaN', allNaN, 'a finite bin survived');
}

// ---------------------------------------------------------------------------------
// Windows

{
  check(
    'window kinds: all four periodic windows are exported',
    WINDOW_KINDS.join(',') === 'rectangular,hann,hamming,blackman',
    WINDOW_KINDS.join(','),
  );

  const n = 64;
  const rectangular = fillWindow('rectangular', n);
  let allOnes = true;
  for (let i = 0; i < n; i += 1) if (rectangular[i] !== 1) allOnes = false;
  check('window rectangular: every coefficient is 1', allOnes, 'a coefficient differs');
  nearly('window rectangular: sum is N', windowSum('rectangular', n), n);
  nearly('window rectangular: power is N', windowPower('rectangular', n), n);

  const hann = fillWindow('hann', n);
  nearly('window Hann: w[0] is 0', hann[0], 0);
  nearly('window Hann: w[N/2] is 1', hann[n / 2], 1);
  nearly('window Hann: sum is N/2', windowSum('hann', n), n / 2, 1e-10);
  nearly('window Hann: power is 3N/8', windowPower('hann', n), (3 * n) / 8, 1e-10);

  const hamming = fillWindow('hamming', n);
  nearly('window Hamming: w[0] is 0.08', hamming[0], 0.08, 1e-12);
  nearly('window Hamming: w[N/2] is 1', hamming[n / 2], 1, 1e-12);
  nearly('window Hamming: sum is 0.54N', windowSum('hamming', n), 0.54 * n, 1e-10);
  nearly('window Hamming: power is 0.3974N', windowPower('hamming', n), 0.3974 * n, 1e-10);

  const blackman = fillWindow('blackman', n);
  nearly('window Blackman: w[0] is 0', blackman[0], 0, 1e-12);
  nearly('window Blackman: w[N/2] is 1', blackman[n / 2], 1, 1e-12);
  nearly('window Blackman: sum is 0.42N', windowSum('blackman', n), 0.42 * n, 1e-10);
  nearly('window Blackman: power is 0.3046N', windowPower('blackman', n), 0.3046 * n, 1e-10);

  for (const kind of WINDOW_KINDS) {
    const window = fillWindow(kind, n);
    let sum = 0;
    let power = 0;
    for (let i = 0; i < n; i += 1) {
      sum += window[i];
      power += window[i] * window[i];
    }
    check(
      `window ${kind}: windowSum agrees with the coefficients`,
      closeTo(windowSum(kind, n), sum, 1e-10),
      `${windowSum(kind, n)} vs ${sum}`,
    );
    check(
      `window ${kind}: windowPower agrees with the coefficients`,
      closeTo(windowPower(kind, n), power, 1e-10),
      `${windowPower(kind, n)} vs ${power}`,
    );
  }
}

{
  const empty = fillWindow('hann', 0);
  check('window empty: zero-length coefficients', empty.length === 0, `got ${empty.length}`);
  nearly('window empty: sum is zero', windowSum('hann', 0), 0);
  nearly('window empty: power is zero', windowPower('hann', 0), 0);

  nearly('window length 1: rectangular coefficient', windowCoefficient('rectangular', 0, 1), 1);
  nearly('window length 1: Hann coefficient', windowCoefficient('hann', 0, 1), 0);
  nearly('window length 1: Hamming coefficient', windowCoefficient('hamming', 0, 1), 0.08);
  nearly('window length 1: Blackman coefficient', windowCoefficient('blackman', 0, 1), 0);
}

{
  const out = new Float64Array(16);
  const window = fillWindow('hamming', 16, out);
  check('window out: the supplied array is returned', window === out, 'a new array was returned');
  nearly('window out: the supplied array is filled', out[0], 0.08);

  throwsRange(
    'window out: a wrong output length is refused',
    () => fillWindow('hann', 8, new Float64Array(7)),
  );
  throwsRange(
    'window index: an index at the length is refused',
    () => windowCoefficient('hann', 8, 8),
  );
  throwsRange(
    'window index: a negative index is refused',
    () => windowCoefficient('hann', -1, 8),
  );
  throwsRange(
    'window length: a negative length is refused',
    () => fillWindow('hann', -1),
  );
  throwsRange(
    'window kind: an unknown runtime kind is refused',
    () => windowCoefficient('gauss' as WindowKind, 0, 8),
  );
}

// ---------------------------------------------------------------------------------
// Bins

{
  const re = new Float64Array([3, 0, -1]);
  const im = new Float64Array([4, 1, 0]);
  nearly('bin helpers: magnitude', binMagnitude(re, im, 0), 5);
  nearly('bin helpers: phase +pi/2', binPhase(re, im, 1), Math.PI / 2);
  nearly('bin helpers: phase pi', binPhase(re, im, 2), Math.PI);
  throwsRange(
    'bin helpers: mismatched lengths are refused',
    () => binMagnitude(new Float64Array(2), new Float64Array(3), 0),
  );
  throwsRange('bin helpers: an out-of-range index is refused', () => binPhase(re, im, 3));
  throwsRange('bin helpers: a fractional index is refused', () => binPhase(re, im, 0.5));
}

{
  const n = 64;
  const sampleRate = 640;
  nearly('bin frequency: DC', binFrequencyHz(0, n, sampleRate), 0);
  nearly('bin frequency: k=5', binFrequencyHz(5, n, sampleRate), 50);
  nearly('bin frequency: Nyquist', binFrequencyHz(n / 2, n, sampleRate), 320);
  nearly('bin frequency: last bin is negative', binFrequencyHz(n - 1, n, sampleRate), -10);
  nearly('bin frequency: upper half mirrors', binFrequencyHz(60, n, sampleRate), -40);

  // Odd size: the middle bin is the negative side.
  nearly('bin frequency: odd k=2', binFrequencyHz(2, 5, 500), 200);
  nearly('bin frequency: odd k=3', binFrequencyHz(3, 5, 500), -200);
  nearly('bin frequency: odd last bin', binFrequencyHz(4, 5, 500), -100);

  throwsRange('bin frequency: an index at size is refused', () => binFrequencyHz(n, n, sampleRate));
  throwsRange('bin frequency: a negative index is refused', () => binFrequencyHz(-1, n, sampleRate));
  throwsRange('bin frequency: a fractional index is refused', () => binFrequencyHz(1.5, n, sampleRate));
  throwsRange('bin frequency: size zero is refused', () => binFrequencyHz(0, 0, sampleRate));
  throwsRange('bin frequency: a zero sample rate is refused', () => binFrequencyHz(0, n, 0));
  throwsRange('bin frequency: a NaN sample rate is refused', () => binFrequencyHz(0, n, Number.NaN));
}

{
  const oddRe = new Float64Array(5);
  const oddIm = new Float64Array(5);
  check(
    'spectrum: odd lengths produce floor(N/2)+1 bins',
    magnitudeSpectrum(oddRe, oddIm).length === 3,
    `got ${magnitudeSpectrum(oddRe, oddIm).length}`,
  );
  throwsRange(
    'spectrum: an empty input is refused',
    () => magnitudeSpectrum(new Float64Array(0), new Float64Array(0)),
  );
  throwsRange(
    'spectrum: mismatched lengths are refused',
    () => phaseSpectrum(new Float64Array(4), new Float64Array(3)),
  );
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
console.log(`fft selftest: ${results.length - failures.length}/${results.length} passed`);
if (failures.length > 0) {
  throw new Error(`${failures.length} fft selftest check(s) failed`);
}
