// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../data/adcTraceFiles.js';
import { ADC_LSB_V, ADC_ZERO_CODE } from '../ui/channelBanks.js';
import { WINDOW_KINDS, windowPower, windowSum, type WindowKind } from './fft.js';
import {
  FFT_DBFS_FLOOR, FFT_MAX_SAMPLES, FFT_NOMINAL_FULL_SCALE_CODES,
  aggregateColumns, computeSpectrum, logAxisHz, logAxisX, logFrequencyAxis,
  parabolicPeakOffset, spectrumSize,
  type LogAxisColumn, type Spectrum,
} from './fftSpectrum.js';

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

function nearly(name: string, actual: number, expected: number, tolerance = 1e-12): void {
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

function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function testWindow(kind: WindowKind, index: number, length: number): number {
  const phase = (2 * Math.PI * index) / length;
  switch (kind) {
    case 'rectangular':
      return 1;
    case 'hann':
      return 0.5 - 0.5 * Math.cos(phase);
    case 'hamming':
      return 0.54 - 0.46 * Math.cos(phase);
    case 'blackman':
      return 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase);
  }
}

function naiveAmplitudes(
  samples: ArrayLike<number>, kind: WindowKind, zeroCode: number, voltsPerCode: number,
): Float64Array {
  const n = samples.length;
  const bins = n / 2 + 1;
  let coherent = 0;
  for (let i = 0; i < n; i += 1) coherent += testWindow(kind, i, n);
  const out = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      const x = (samples[i]! - zeroCode) * voltsPerCode * testWindow(kind, i, n);
      const angle = (2 * Math.PI * k * i) / n;
      re += x * Math.cos(angle);
      im -= x * Math.sin(angle);
    }
    const raw = Math.hypot(re, im);
    out[k] = (k === 0 || k === n / 2 ? raw : 2 * raw) / coherent;
  }
  return out;
}

const ZERO = 128;
const LSB = 0.12549;

interface CodeOverrides {
  unknown?: ArrayLike<number>;
  samplerate?: number;
  zeroCode?: number;
  voltsPerCode?: number;
  window?: WindowKind;
  maxSamples?: number;
}

function spectrum(codes: ArrayLike<number>, extra: CodeOverrides = {}): Spectrum {
  return computeSpectrum({
    codes,
    samplerate: 640,
    zeroCode: ZERO,
    voltsPerCode: LSB,
    window: 'rectangular',
    ...extra,
  });
}

function sine(amplitude: number, bin: number, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = ZERO + amplitude * Math.sin((2 * Math.PI * bin * i) / n);
  }
  return out;
}

function tones(n: number, seed: number): Float64Array {
  const next = makeLcg(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = ZERO +
      60 * Math.sin((2 * Math.PI * 5 * i) / n) +
      20 * Math.cos((2 * Math.PI * 13 * i) / n) +
      4 * (next() - 0.5);
  }
  return out;
}

{
  const table: [number, number | null][] = [
    [2, 2], [3, 2], [4, 4], [7, 4], [8, 8], [1000, 512], [1023, 512], [1024, 1024],
    [65536, 65536], [65537, 65536], [100000, 65536], [1e7, 65536],
    [1, null], [0, null], [-8, null], [1.9, null], [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
  ];
  const wrong = table.filter(([span, expected]) => spectrumSize(span) !== expected);
  check(
    'spectrum size: the largest power of two at or below the span',
    wrong.length === 0,
    `wrong for ${wrong.map(([span, expected]) => `${span} -> ${String(spectrumSize(span))} (want ${String(expected)})`).join(', ')}`,
  );
  check(
    'spectrum size: a span one past 65536 is not zero-padded to 131072',
    spectrumSize(65537) === FFT_MAX_SAMPLES && spectrumSize(1e9) === FFT_MAX_SAMPLES,
    `got ${String(spectrumSize(65537))} and ${String(spectrumSize(1e9))}`,
  );
}

{
  const n = 64;
  const codes = tones(n, 0x51ed);
  let worst = 0;
  for (const kind of WINDOW_KINDS) {
    const got = spectrum(codes, { window: kind });
    const expected = naiveAmplitudes(codes, kind, ZERO, LSB);
    for (let k = 0; k < expected.length; k += 1) {
      worst = Math.max(worst, Math.abs(got.magnitude[k]! - expected[k]!));
    }
  }
  check(
    'spectrum: one-sided amplitudes match a naive DFT oracle for all four windows',
    worst <= 1e-9,
    `max deviation ${worst} volts`,
  );
  const hann = spectrum(codes, { window: 'hann' });
  check(
    'spectrum: the one-sided bins run from DC to Nyquist',
    hann.magnitude.length === n / 2 + 1 && hann.dbfs.length === n / 2 + 1,
    `magnitude ${hann.magnitude.length}, dbfs ${hann.dbfs.length}`,
  );
  check('spectrum: the requested window is echoed', hann.window === 'hann', `window ${hann.window}`);
  check(
    'spectrum: every emitted bin is finite',
    Array.from(hann.magnitude).every((value) => Number.isFinite(value)) &&
      Array.from(hann.dbfs).every((value) => Number.isFinite(value)),
    'a non-finite bin was emitted',
  );
  const silent = spectrum(new Float64Array(n).fill(ZERO), { window: 'hann' });
  check(
    'spectrum: silence reports the dBFS floor instead of minus infinity',
    Array.from(silent.dbfs).every((value) => value === FFT_DBFS_FLOOR),
    `min ${Math.min(...Array.from(silent.dbfs))}`,
  );
  check('spectrum: silence reports no peak', silent.peak === null, `peak ${String(silent.peak)}`);
  nearly('spectrum: silence reports zero DC', silent.dcVolts, 0, 1e-12);
  check(
    'spectrum: the naive oracle is non-trivial (a peak above one code)',
    Math.max(...Array.from(naiveAmplitudes(codes, 'hann', ZERO, LSB))) > LSB,
    'oracle peak is degenerate',
  );
}

{
  const n = 64;
  for (const window of ['rectangular', 'hann'] as const) {
    const full = spectrum(sine(FFT_NOMINAL_FULL_SCALE_CODES, 8, n), { window });
    const half = spectrum(sine(FFT_NOMINAL_FULL_SCALE_CODES / 2, 8, n), { window });
    nearly(`spectrum ${window}: a full-scale integer-bin sine reads 0 dBFS`, full.peak!.dbfs, 0, 1e-9);
    nearly(`spectrum ${window}: a half-scale integer-bin sine reads -6.02 dBFS`, half.peak!.dbfs, 20 * Math.log10(0.5), 1e-9);
    nearly(`spectrum ${window}: the full-scale peak bin amplitude`, full.peak!.volts, FFT_NOMINAL_FULL_SCALE_CODES * LSB, 1e-9);
    nearly(`spectrum ${window}: the half-scale peak bin amplitude`, half.peak!.volts, (FFT_NOMINAL_FULL_SCALE_CODES / 2) * LSB, 1e-9);
    check(`spectrum ${window}: the peak is the tone bin`, full.peak!.bin === 8, `peak bin ${full.peak!.bin}`);
    nearly(`spectrum ${window}: the peak frequency is the bin centre`, full.peak!.hz, 80, 1e-9);
  }
  const hann = spectrum(sine(FFT_NOMINAL_FULL_SCALE_CODES, 8, n), { window: 'hann' });
  nearly('spectrum Hann: the adjacent bins sit at half amplitude', hann.dbfs[7]!, 20 * Math.log10(0.5), 1e-9);
  nearly('spectrum Hann: the adjacent bins mirror', hann.dbfs[7]!, hann.dbfs[9]!, 1e-9);
  const rectangular = spectrum(sine(FFT_NOMINAL_FULL_SCALE_CODES, 8, n));
  nearly('spectrum rectangular: neighbouring bins carry no coherent tone', rectangular.magnitude[7]!, 0, 1e-9);
}

{
  const n = 32;
  for (const window of WINDOW_KINDS) {
    const positive = spectrum(new Float64Array(n).fill(ZERO + 100), { window });
    const negative = spectrum(new Float64Array(n).fill(ZERO - 100), { window });
    nearly(`spectrum ${window}: positive DC reads its own amplitude`, positive.dcVolts, 100 * LSB, 1e-9);
    nearly(`spectrum ${window}: DC is signed`, negative.dcVolts, -100 * LSB, 1e-9);
    nearly(`spectrum ${window}: DC shares the DC bin magnitude`, positive.magnitude[0]!, 100 * LSB, 1e-9);
    nearly(`spectrum ${window}: DC dBFS uses the 127.5-code reference`, positive.dcDbfs, 20 * Math.log10(100 / 127.5), 1e-9);
    nearly(`spectrum ${window}: DC dBFS ignores the sign`, negative.dcDbfs, positive.dcDbfs, 1e-12);
    nearly(`spectrum ${window}: a constant wave has no tone beyond the window's own support`, Math.max(...Array.from(positive.magnitude.slice(4, n / 2))), 0, 1e-9);
  }
}

{
  const n = 64;
  const alternating = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    alternating[i] = ZERO + FFT_NOMINAL_FULL_SCALE_CODES * (i % 2 === 0 ? 1 : -1);
  }
  for (const window of WINDOW_KINDS) {
    const nyquist = spectrum(alternating, { window });
    nearly(`spectrum ${window}: the Nyquist bin reads 0 dBFS`, nyquist.dbfs[n / 2]!, 0, 1e-9);
    nearly(`spectrum ${window}: Nyquist carries no factor of two`, nyquist.magnitude[n / 2]!, FFT_NOMINAL_FULL_SCALE_CODES * LSB, 1e-9);
  }
  const rectangularNyquist = spectrum(alternating);
  check('spectrum rectangular: a Nyquist tone peaks on the Nyquist bin', rectangularNyquist.peak!.bin === n / 2, `peak bin ${rectangularNyquist.peak!.bin}`);
  nearly('spectrum rectangular: the Nyquist peak needs no interpolation', rectangularNyquist.peak!.interpolatedHz, rectangularNyquist.peak!.hz, 1e-12);
  const hannNyquist = spectrum(alternating, { window: 'hann' });
  check('spectrum hann: a Nyquist tone folds into its neighbours', hannNyquist.peak!.bin === n / 2 - 1, `peak bin ${hannNyquist.peak!.bin}`);
  nearly('spectrum hann: the folded neighbour equals the Nyquist bin', hannNyquist.magnitude[n / 2 - 1]!, hannNyquist.magnitude[n / 2]!, 1e-9);
  const gainTwo = spectrum(alternating, { window: 'hann', voltsPerCode: LSB * 2 });
  nearly('spectrum: a Nyquist tone doubles in volts at twice the volts per code', gainTwo.magnitude[n / 2]!, FFT_NOMINAL_FULL_SCALE_CODES * LSB * 2, 1e-9);
  nearly('spectrum: a Nyquist tone keeps its dBFS when the scale changes', gainTwo.dbfs[n / 2]!, 0, 1e-12);
}

{
  const n = 256;
  const codes = tones(n, 0xbeef);
  for (const window of WINDOW_KINDS) {
    const result = spectrum(codes, { window });
    let coherent = 0;
    let power = 0;
    let timePower = 0;
    for (let i = 0; i < n; i += 1) {
      const w = testWindow(window, i, n);
      coherent += w;
      power += w * w;
      const x = (codes[i]! - ZERO) * LSB * w;
      timePower += x * x;
    }
    let spectrumPower = result.magnitude[0]! ** 2 + result.magnitude[n / 2]! ** 2;
    for (let k = 1; k < n / 2; k += 1) spectrumPower += 0.5 * result.magnitude[k]! ** 2;
    spectrumPower *= (coherent * coherent) / n;
    check(
      `spectrum ${window}: Parseval holds between the windowed time power and the one-sided amplitudes`,
      closeTo(spectrumPower, timePower, 1e-9 * timePower),
      `time ${timePower}, spectrum ${spectrumPower}`,
    );
    nearly(`spectrum ${window}: ENBW matches the window's own sums`, result.enbwBins, (n * power) / (coherent * coherent), 1e-9);
    nearly(`spectrum ${window}: ENBW matches fft.ts windowSum/windowPower`, result.enbwBins, (n * windowPower(window, n)) / (windowSum(window, n) ** 2), 1e-12);
    nearly(`spectrum ${window}: RBW is ENBW in hertz`, result.rbwHz, result.enbwBins * result.binHz, 1e-12);
  }
  const closedForm: Record<WindowKind, number> = {
    rectangular: 1,
    hann: 1.5,
    hamming: 0.3974 / 0.2916,
    blackman: 0.3046 / 0.1764,
  };
  for (const kind of WINDOW_KINDS) {
    nearly(`spectrum ${kind}: ENBW matches the periodic closed form`, spectrum(codes, { window: kind }).enbwBins, closedForm[kind], 1e-9);
  }
}

{
  const n = 256;
  const toneAt = new Float64Array(n);
  for (let i = 0; i < n; i += 1) toneAt[i] = ZERO + 100 * Math.sin((2 * Math.PI * 5.5 * i) / n);
  const rectangular = spectrum(toneAt);
  const hann = spectrum(toneAt, { window: 'hann' });
  check(
    'spectrum: Hann suppresses a non-bin-centred tone far better than rectangular',
    hann.dbfs[25]! < rectangular.dbfs[25]! - 20,
    `rectangular ${rectangular.dbfs[25]}, Hann ${hann.dbfs[25]}`,
  );
  check(
    'spectrum: the leakage control is non-trivial (both windows see the tone)',
    rectangular.dbfs[25]! > FFT_DBFS_FLOOR && hann.dbfs[25]! > FFT_DBFS_FLOOR,
    `rectangular ${rectangular.dbfs[25]}, Hann ${hann.dbfs[25]}`,
  );
  check(
    'spectrum: a half-bin tone splits between its two neighbours',
    rectangular.peak!.bin >= 5 && rectangular.peak!.bin <= 6 &&
      closeTo(rectangular.magnitude[5]!, rectangular.magnitude[6]!, 0.15 * rectangular.magnitude[6]!),
    `peak bin ${rectangular.peak!.bin}, ${rectangular.magnitude[5]} vs ${rectangular.magnitude[6]}`,
  );
}

{
  const n = 128;
  const codes = tones(n, 0x777);
  const base = spectrum(codes, { window: 'hann' });
  const boosted = spectrum(codes, { window: 'hann', voltsPerCode: LSB / 3 });
  let worstDbfs = 0;
  for (let k = 0; k < base.dbfs.length; k += 1) {
    worstDbfs = Math.max(worstDbfs, Math.abs(base.dbfs[k]! - boosted.dbfs[k]!));
  }
  check(
    'spectrum: a gain change does not move dBFS',
    worstDbfs <= 1e-12,
    `max dBFS drift ${worstDbfs}`,
  );
  check(
    'spectrum: a threefold gain divides the linear volts',
    closeTo(boosted.magnitude[5]!, base.magnitude[5]! / 3, 1e-9 * base.magnitude[5]!),
    `${boosted.magnitude[5]} vs ${base.magnitude[5]} / 3`,
  );
  nearly('spectrum: the quantization floor is gain-invariant', boosted.quantizationFloorDbfs, base.quantizationFloorDbfs, 1e-12);
  nearly('spectrum: the peak dBFS is gain-invariant', boosted.peak!.dbfs, base.peak!.dbfs, 1e-12);
  nearly(
    'spectrum: the quantization floor is one code of RMS noise against the 127.5-code reference',
    base.quantizationFloorDbfs,
    20 * Math.log10(1 / (Math.sqrt(12) * FFT_NOMINAL_FULL_SCALE_CODES)),
    1e-12,
  );
  const idealSnrDb = 20 * Math.log10((FFT_NOMINAL_FULL_SCALE_CODES / Math.SQRT2) * Math.sqrt(12));
  check(
    'spectrum: the ideal 8-bit SNR relation holds for the floor',
    closeTo(idealSnrDb, 6.0206 * 8 + 1.7609, 0.05) &&
      closeTo(base.quantizationFloorDbfs, -idealSnrDb - 20 * Math.log10(Math.SQRT2), 1e-9),
    `floor ${base.quantizationFloorDbfs} dBFS, ideal SNR ${idealSnrDb} dB`,
  );
  nearly('spectrum: the full-scale sine reference is in volts', base.fullScaleVolts, FFT_NOMINAL_FULL_SCALE_CODES * LSB, 1e-12);
}

{
  const codes = tones(64, 0x1f);
  const gapMask = new Uint8Array(64);
  gapMask[3] = 1;
  const gap = spectrum(codes, { unknown: gapMask });
  check('spectrum gap: an unknown sample inside the consumed span refuses the transform', gap.status === 'gap', `status ${gap.status}`);
  check('spectrum gap: the refused sample is disclosed', gap.gapAt === 3, `gapAt ${String(gap.gapAt)}`);
  check('spectrum gap: no bins are fabricated', gap.magnitude.length === 0 && gap.dbfs.length === 0, `bins ${gap.magnitude.length}`);
  check('spectrum gap: nothing is analyzed', gap.analyzed === 0, `analyzed ${gap.analyzed}`);
  check('spectrum gap: no peak is reported', gap.peak === null, `peak ${String(gap.peak)}`);
  check('spectrum gap: DC is not fabricated', Number.isNaN(gap.dcVolts) && Number.isNaN(gap.dcDbfs), `dc ${gap.dcVolts}/${gap.dcDbfs}`);
  nearly('spectrum gap: the planned size stays disclosed', gap.n, 64);

  const clearMask = new Uint8Array(64);
  check('spectrum gap: the same wave without the mask becomes analyzable', spectrum(codes, { unknown: clearMask }).status === 'ok', 'still refused');

  const outsideMask = new Uint8Array(100);
  outsideMask[80] = 1;
  const truncated = spectrum(tones(100, 0x2f), { unknown: outsideMask, maxSamples: 64 });
  check('spectrum gap: a gap beyond the analyzed prefix is not a gap', truncated.status === 'ok', `status ${truncated.status}`);
  check('spectrum gap: the prefix bound is what was analyzed', truncated.analyzed === 64 && truncated.n === 64, `analyzed ${truncated.analyzed}, n ${truncated.n}`);

  const insideMask = new Uint8Array(100);
  insideMask[10] = 1;
  check('spectrum gap: a gap inside the analyzed prefix still refuses', spectrum(tones(100, 0x2f), { unknown: insideMask, maxSamples: 64 }).status === 'gap', 'refused sample escaped');

  throwsRange(
    'spectrum gap: a mask shorter than the wave is refused',
    () => spectrum(codes, { unknown: new Uint8Array(63) }),
  );
  const nanCodes = new Float64Array(64).fill(ZERO);
  nanCodes[5] = Number.NaN;
  throwsRange('spectrum gap: a NaN code never enters the transform', () => spectrum(nanCodes));
}

{
  const empty = spectrum(new Float64Array(0));
  check('spectrum short: an empty wave has no transform', empty.status === 'too-short', `status ${empty.status}`);
  check('spectrum short: nothing is analyzed or sized', empty.n === 0 && empty.analyzed === 0, `n ${empty.n}, analyzed ${empty.analyzed}`);
  check('spectrum short: no peak and no bins', empty.peak === null && empty.magnitude.length === 0, 'a value survived');
  const one = spectrum(new Float64Array([ZERO]));
  check('spectrum short: one sample has no transform', one.status === 'too-short' && one.requested === 1, `status ${one.status}`);

  const two = spectrum(new Float64Array([ZERO + 100, ZERO - 100]));
  check('spectrum short: two samples give a DC and a Nyquist bin', two.status === 'ok' && two.magnitude.length === 2, `status ${two.status}, bins ${two.magnitude.length}`);
  check('spectrum short: two samples pick the Nyquist peak', two.peak!.bin === 1, `peak bin ${two.peak!.bin}`);
  nearly('spectrum short: two samples need no interpolation', two.peak!.interpolatedHz, two.peak!.hz, 1e-12);
  nearly('spectrum short: two samples report the fs/2 bin width', two.binHz, 320, 1e-12);
}

{
  const span = 100000;
  const n = 65536;
  const codes = new Float64Array(span);
  for (let i = 0; i < span; i += 1) codes[i] = ZERO + 100 * Math.sin((2 * Math.PI * 1000 * i) / n);
  const result = spectrum(codes, { samplerate: n * 10 });
  check('spectrum cap: a longer request is analyzed as its prefix', result.analyzed === n && result.requested === span, `analyzed ${result.analyzed}, requested ${result.requested}`);
  check('spectrum cap: the transform uses exactly 65536 samples', result.n === FFT_MAX_SAMPLES, `n ${result.n}`);
  check('spectrum cap: the prefix tone lands on its bin', result.peak!.bin === 1000, `peak bin ${result.peak!.bin}`);
  nearly('spectrum cap: the bin width follows the analyzed size', result.binHz, 10, 1e-12);
  nearly('spectrum cap: the prefix peak keeps its dBFS', result.peak!.dbfs, 20 * Math.log10(100 / 127.5), 1e-9);

  const unpadded = spectrum(tones(1000, 0x33), { samplerate: 1000 });
  check('spectrum cap: a 1000-sample span is not zero-padded to 1024', unpadded.n === 512 && unpadded.analyzed === 512, `n ${unpadded.n}`);
  nearly('spectrum cap: the unpadded bin width is fs/512', unpadded.binHz, 1000 / 512, 1e-12);

  const bounded = spectrum(tones(1000, 0x34), { samplerate: 1000, maxSamples: 256 });
  check('spectrum cap: an explicit bound shrinks the analyzed prefix', bounded.n === 256 && bounded.analyzed === 256 && bounded.requested === 1000, `n ${bounded.n}, analyzed ${bounded.analyzed}`);
  throwsRange('spectrum cap: a bound below two samples is refused', () => spectrum(tones(64, 0x35), { maxSamples: 1 }));
  throwsRange('spectrum cap: a bound above 65536 is refused', () => spectrum(tones(64, 0x36), { maxSamples: FFT_MAX_SAMPLES + 1 }));
  throwsRange('spectrum cap: a fractional bound is refused', () => spectrum(tones(64, 0x37), { maxSamples: 2.5 }));
}

{
  const axis = logFrequencyAxis({ nyquistHz: 512, minHz: 0.5, binHz: 1, width: 100, height: 200 });
  const expected = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
  check(
    'log axis: the 1-2-5 ticks span the range',
    axis.ticks.length === expected.length &&
      axis.ticks.every((tick, i) => Math.abs(tick.hz - expected[i]!) <= 1e-12 * expected[i]!),
    axis.ticks.map((tick) => tick.hz).join(','),
  );
  check(
    'log axis: every tick is a 1-2-5 mantissa',
    axis.ticks.every((tick) => {
      const decade = Math.floor(Math.log10(tick.hz) + 1e-9);
      const mantissa = tick.hz / 10 ** decade;
      return [1, 2, 5].some((value) => Math.abs(mantissa - value) <= 1e-9);
    }),
    axis.ticks.map((tick) => tick.hz).join(','),
  );
  check(
    'log axis: ticks are strictly ascending in frequency and x',
    axis.ticks.every((tick, i) => i === 0 ||
      (tick.hz > axis.ticks[i - 1]!.hz && tick.x > axis.ticks[i - 1]!.x)),
    'a tick is out of order',
  );
  nearly('log axis: the lower bound maps to x=0', axis.ticks[0]!.x, 0, 1e-9);
  nearly('log axis: 500 Hz sits at its logarithmic column', axis.ticks[axis.ticks.length - 1]!.x, 99.6579, 1e-3);
  check(
    'log axis: decade ticks are major and 2/5 ticks are minor',
    axis.ticks.filter((tick) => tick.major).map((tick) => tick.hz).join(',') === '1,10,100',
    axis.ticks.filter((tick) => tick.major).map((tick) => tick.hz).join(','),
  );
  check(
    'log axis: no DC tick is produced',
    axis.ticks.every((tick) => tick.hz > 0 && tick.hz >= axis.minHz),
    'a zero or sub-minimum tick appeared',
  );

  const shifted = logFrequencyAxis({ nyquistHz: 20000, minHz: 20, binHz: 10, width: 80, height: 120 });
  check(
    'log axis: a shifted range keeps the 1-2-5 sequence inside its bounds',
    shifted.ticks.map((tick) => tick.hz).join(',') === '20,50,100,200,500,1000,2000,5000,10000,20000',
    shifted.ticks.map((tick) => tick.hz).join(','),
  );
  check('log axis: the height is passed through', shifted.height === 120, `height ${shifted.height}`);
}

{
  const cases: [number, number, number][] = [
    [0.5, 512, 100], [20, 20000, 80], [1, 1.5, 33], [1e-3, 5e7, 1200],
  ];
  let worst = 0;
  for (const [minHz, nyquistHz, width] of cases) {
    for (const fraction of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      const hz = logAxisHz(fraction * width, minHz, nyquistHz, width);
      worst = Math.max(worst, Math.abs(logAxisX(hz, minHz, nyquistHz, width) / width - fraction));
    }
  }
  check('log axis: the mapping and its inverse round-trip', worst <= 1e-12, `max deviation ${worst}`);
  nearly('log axis mapping: the lower bound is x=0', logAxisX(0.5, 0.5, 512, 100), 0, 1e-12);
  nearly('log axis mapping: Nyquist is x=width', logAxisX(512, 0.5, 512, 100), 100, 1e-12);
  nearly('log axis mapping: a decade is a constant fraction of the width', logAxisX(5, 0.5, 512, 100) - logAxisX(0.5, 0.5, 512, 100), 100 * Math.log10(10) / Math.log10(1024), 1e-9);
  throwsRange('log axis mapping: a zero frequency is refused', () => logAxisX(0, 0.5, 512, 100));
  throwsRange('log axis mapping: a zero minimum is refused', () => logAxisX(1, 0, 512, 100));
  throwsRange('log axis mapping: a minimum at Nyquist is refused', () => logAxisX(1, 512, 512, 100));
  throwsRange('log axis mapping: a zero width is refused', () => logAxisHz(0, 0.5, 512, 0));
  throwsRange('log axis: a zero bin width is refused', () => logFrequencyAxis({ nyquistHz: 512, minHz: 0.5, binHz: 0, width: 100, height: 200 }));
  throwsRange('log axis: a NaN Nyquist is refused', () => logFrequencyAxis({ nyquistHz: Number.NaN, minHz: 0.5, binHz: 1, width: 100, height: 200 }));
  throwsRange('log axis: a fractional width is refused', () => logFrequencyAxis({ nyquistHz: 512, minHz: 0.5, binHz: 1, width: 100.5, height: 200 }));
}

{
  const axis = logFrequencyAxis({ nyquistHz: 512, minHz: 0.5, binHz: 1, width: 100, height: 200 });
  const values = new Float64Array(513);
  for (let bin = 0; bin < values.length; bin += 1) values[bin] = bin;
  const aggregated = aggregateColumns(axis.columns, values);
  check('log axis columns: one column per device pixel', axis.columns.length === 100, `columns ${axis.columns.length}`);
  check(
    'log axis columns: x ascends without gaps',
    axis.columns.every((column, i) => column.x === i),
    'a column is missing or out of order',
  );
  check(
    'log axis columns: no covered column starts at DC',
    axis.columns.every((column) => !column.covered || column.firstBin >= 1),
    'DC entered the log axis',
  );
  check(
    'log axis columns: uncovered columns never point at DC',
    axis.columns.every((column) => column.covered || column.binIndex >= 1),
    'an uncovered column points at DC',
  );
  check(
    'log axis columns: covered columns span an inclusive bin range',
    axis.columns.every((column) => !column.covered ||
      (column.lastBin >= column.firstBin && column.binIndex === column.firstBin)),
    'a covered range is malformed',
  );
  const covered = axis.columns.filter((column) => column.covered);
  const uncovered = axis.columns.filter((column) => !column.covered);
  check('log axis columns: both covered and empty columns exist', covered.length > 0 && uncovered.length > 0, `covered ${covered.length}, empty ${uncovered.length}`);
  check(
    'log axis columns: empty columns aggregate to no value',
    uncovered.every((column) => Number.isNaN(aggregated[column.x]!)),
    'an empty column invented a value',
  );
  check(
    'log axis columns: covered columns keep the maximum of their bins',
    covered.every((column) => aggregated[column.x]! === column.lastBin),
    'a covered column did not keep its maximum bin',
  );
  const spike = axis.columns.find((column) => column.covered && column.lastBin - column.firstBin >= 3)!;
  const spiked = new Float64Array(513);
  spiked[spike.lastBin] = 99;
  check(
    'log axis columns: a maximum in the last covered bin survives aggregation',
    aggregateColumns(axis.columns, spiked)[spike.x] === 99,
    `got ${aggregateColumns(axis.columns, spiked)[spike.x]}`,
  );
  check(
    'log axis columns: a first-bin aggregation would drop that maximum',
    spike.firstBin !== spike.lastBin,
    'the control column covers a single bin',
  );
  const finite = Array.from(aggregated).filter((value) => Number.isFinite(value));
  check(
    'log axis columns: every finite aggregate is an actual bin value',
    finite.every((value) => values[value] === value),
    'an interpolated or splined value appeared',
  );
  check(
    'log axis columns: no finite aggregate sits between two bins',
    finite.every((value) => Number.isInteger(value)),
    'a fractional magnitude appeared',
  );
  check(
    'log axis columns: high columns cover many bins',
    covered[covered.length - 1]!.lastBin - covered[covered.length - 1]!.firstBin >= 2,
    `range ${covered[covered.length - 1]!.firstBin}..${covered[covered.length - 1]!.lastBin}`,
  );
  nearly('log axis columns: the last column reaches Nyquist', covered[covered.length - 1]!.lastBin, 512);
  check(
    'log axis columns: aggregation refuses NaN bins instead of inventing one',
    Number.isNaN(aggregateColumns(axis.columns, new Float64Array(513).fill(Number.NaN))[covered[0]!.x]!),
    'a NaN bin produced a value',
  );
}

{
  const single = logFrequencyAxis({ nyquistHz: 512, minHz: 0.5, binHz: 1, width: 1, height: 50 });
  check('log axis columns: a one-pixel axis covers the whole range', single.columns.length === 1 && single.columns[0]!.firstBin === 1 && single.columns[0]!.lastBin === 512, JSON.stringify(single.columns[0]));
  const narrow: LogAxisColumn = single.columns[0]!;
  check('log axis columns: Nyquist still lands on the only column', narrow.binIndex === 1 && narrow.covered, JSON.stringify(narrow));
}

{
  const axis = logFrequencyAxis({ nyquistHz: 512000, minHz: 0.001, binHz: 1000, width: 200, height: 90 });
  check(
    'log axis columns: a minimum far below the bin width still excludes DC',
    axis.columns.every((column) => !column.covered || column.firstBin >= 1) && axis.firstBin === 1,
    `firstBin ${axis.firstBin}`,
  );
  check(
    'log axis columns: a minimum far below the bin width leaves empty columns with a positive bin',
    axis.columns.some((column) => !column.covered) &&
      axis.columns.every((column) => column.covered || column.binIndex >= 1),
    'an empty column resolved to DC',
  );
  nearly('log axis columns: the first usable bin is the first one above the minimum', axis.firstBin, 1, 0);
  check(
    'log axis columns: the disclosed Nyquist bin is the last covered bin',
    axis.columns[axis.columns.length - 1]!.lastBin === 512,
    `last bin ${axis.columns[axis.columns.length - 1]!.lastBin}`,
  );
}

{
  const axis = logFrequencyAxis({ nyquistHz: 50000, minHz: 20, binHz: 1000, width: 400, height: 200 });
  check(
    'log axis columns: a positive minimum above 20 Hz keeps every bin above it',
    axis.columns.every((column) => !column.covered || column.firstBin * 1000 >= 20),
    'a bin below the disclosed minimum was covered',
  );
}

{
  const table: [string, () => void][] = [
    ['a zero sample rate', () => spectrum(tones(16, 1), { samplerate: 0 })],
    ['a negative sample rate', () => spectrum(tones(16, 2), { samplerate: -1 })],
    ['a NaN sample rate', () => spectrum(tones(16, 3), { samplerate: Number.NaN })],
    ['a zero volts-per-code', () => spectrum(tones(16, 4), { voltsPerCode: 0 })],
    ['a negative volts-per-code', () => spectrum(tones(16, 5), { voltsPerCode: -1 })],
    ['an infinite zero code', () => spectrum(tones(16, 6), { zeroCode: Number.POSITIVE_INFINITY })],
    ['an unknown window kind', () => spectrum(tones(16, 7), { window: 'gauss' as WindowKind })],
  ];
  for (const [label, action] of table) throwsRange(`spectrum input: ${label} is refused`, action);
}

{
  const onBin = [-2, -1, -2];
  nearly('peak interpolation: a symmetric peak stays on its bin', parabolicPeakOffset(onBin, 1), 0);
  check(
    'peak interpolation: a peak with a heavier right neighbour moves right',
    parabolicPeakOffset([-2, -1, -1.5], 1) > 0,
    `offset ${parabolicPeakOffset([-2, -1, -1.5], 1)}`,
  );
  check(
    'peak interpolation: a peak with a heavier left neighbour moves left',
    parabolicPeakOffset([-1.5, -1, -2], 1) < 0,
    `offset ${parabolicPeakOffset([-1.5, -1, -2], 1)}`,
  );
  nearly('peak interpolation: the vertex of a parabola at a quarter bin is recovered', parabolicPeakOffset([-1.5625, -0.0625, -0.5625], 1), 0.25, 1e-12);
  nearly('peak interpolation: the offset is clamped to half a bin', parabolicPeakOffset([-1, -3, -100], 1), -0.5);
  nearly('peak interpolation: the positive clamp holds too', parabolicPeakOffset([-100, -3, -1], 1), 0.5);
  nearly('peak interpolation: a flat triple has no direction', parabolicPeakOffset([-5, -5, -5], 1), 0);
  throwsRange('peak interpolation: index zero is refused', () => parabolicPeakOffset([-1, -2, -3], 0));
  throwsRange('peak interpolation: the last index is refused', () => parabolicPeakOffset([-1, -2, -3], 2));
  throwsRange('peak interpolation: a fractional index is refused', () => parabolicPeakOffset([-1, -2, -3], 0.5));
  throwsRange('peak interpolation: a non-finite magnitude is refused', () => parabolicPeakOffset([-1, Number.NaN, -3], 1));
}

{
  const n = 64;
  const onBin = sine(100, 5, n);
  const exact = spectrum(onBin, { window: 'hann' });
  nearly('peak interpolation: a bin-centred tone interpolates to its own bin', exact.peak!.interpolatedHz, exact.peak!.hz, 1e-9);
  check('peak interpolation: the raw bin is disclosed next to the interpolated one', exact.peak!.bin === 5 && exact.peak!.hz === exact.peak!.bin * exact.binHz, `bin ${exact.peak!.bin}`);
  nearly('peak interpolation: a bin-centred Hann tone keeps full amplitude', exact.peak!.dbfs, 20 * Math.log10(100 / 127.5), 1e-9);

  const offset = new Float64Array(n);
  for (let i = 0; i < n; i += 1) offset[i] = ZERO + 100 * Math.sin((2 * Math.PI * 5.3 * i) / n);
  const interpolated = spectrum(offset, { window: 'hann' });
  const trueHz = 5.3 * interpolated.binHz;
  check('peak interpolation: an off-bin tone reports the raw bin below the truth', interpolated.peak!.hz < trueHz, `${interpolated.peak!.hz} vs ${trueHz}`);
  check(
    'peak interpolation: the interpolated frequency moves toward the tone',
    Math.abs(interpolated.peak!.interpolatedHz - trueHz) <= 0.15 * interpolated.binHz &&
      interpolated.peak!.interpolatedHz > interpolated.peak!.hz,
    `${interpolated.peak!.interpolatedHz} from ${interpolated.peak!.hz}, truth ${trueHz}`,
  );
  check(
    'peak interpolation: the reported offset never exceeds half a bin',
    Math.abs(interpolated.peak!.interpolatedHz - interpolated.peak!.hz) <= 0.5 * interpolated.binHz + 1e-9,
    `offset ${interpolated.peak!.interpolatedHz - interpolated.peak!.hz}`,
  );

  const halfBin = new Float64Array(n);
  for (let i = 0; i < n; i += 1) halfBin[i] = ZERO + 100 * Math.sin((2 * Math.PI * 5.5 * i) / n);
  const half = spectrum(halfBin, { window: 'hann' });
  nearly('peak interpolation: a half-bin tone lands on the half bin', half.peak!.interpolatedHz, 5.5 * half.binHz, 0.1 * half.binHz);
}

{
  const codes = loadAdcTrace('sine');
  const rate = 100e6;
  const reference = 9999.5877;
  const result = computeSpectrum({
    codes, samplerate: rate, zeroCode: ADC_ZERO_CODE, voltsPerCode: ADC_LSB_V, window: 'hann',
  });
  check('adc fixture: the 10 kHz trace is analyzable', result.status === 'ok', `status ${result.status}`);
  check('adc fixture: the whole trace is requested and the prefix analyzed', result.requested === codes.length && result.analyzed === FFT_MAX_SAMPLES, `requested ${result.requested}, analyzed ${result.analyzed}`);
  nearly('adc fixture: the bin width is fs/65536', result.binHz, rate / 65536, 1e-9);
  nearly('adc fixture: Nyquist is disclosed', result.nyquistHz, rate / 2, 1e-9);
  nearly('adc fixture: Hann ENBW is 1.5 bins', result.enbwBins, 1.5, 1e-9);
  nearly('adc fixture: RBW follows ENBW', result.rbwHz, 1.5 * result.binHz, 1e-9);
  const error = Math.abs(result.peak!.interpolatedHz - reference);
  check(
    'adc fixture: the interpolated peak is within half a bin of 9999.59 Hz',
    error <= 0.5 * result.binHz,
    `${result.peak!.interpolatedHz} Hz, error ${error} Hz = ${error / result.binHz} bins`,
  );
  check(
    'adc fixture: the interpolation improves on the raw bin',
    error < Math.abs(result.peak!.hz - reference),
    `interpolated error ${error} Hz, raw error ${Math.abs(result.peak!.hz - reference)} Hz`,
  );
  check(
    'adc fixture: the peak is a measured bin, not a fabricated one',
    result.peak!.bin > 0 && result.peak!.bin < result.n / 2 && result.peak!.volts === result.magnitude[result.peak!.bin],
    `bin ${result.peak!.bin}`,
  );
  check(
    'adc fixture: the interpolated frequency differs from the raw bin',
    Math.abs(result.peak!.interpolatedHz - result.peak!.hz) > 1,
    `offset ${result.peak!.interpolatedHz - result.peak!.hz} Hz`,
  );
  check(
    'adc fixture: the trace peak is a plausible tone level',
    result.peak!.dbfs < 0 && result.peak!.dbfs > -20,
    `peak ${result.peak!.dbfs} dBFS`,
  );
  const gained = computeSpectrum({
    codes, samplerate: rate, zeroCode: ADC_ZERO_CODE, voltsPerCode: ADC_LSB_V / 3, window: 'hann',
  });
  check(
    'adc fixture: a gain change does not move the peak dBFS',
    Math.abs(gained.peak!.dbfs - result.peak!.dbfs) <= 1e-12,
    `${gained.peak!.dbfs} vs ${result.peak!.dbfs}`,
  );
  const gapMask = new Uint8Array(codes.length);
  gapMask[100] = 1;
  const gapped = computeSpectrum({
    codes, unknown: gapMask, samplerate: rate, zeroCode: ADC_ZERO_CODE, voltsPerCode: ADC_LSB_V,
    window: 'hann',
  });
  check('adc fixture: a gapped window produces no spectrum', gapped.status === 'gap' && gapped.gapAt === 100, `status ${gapped.status}, gapAt ${String(gapped.gapAt)}`);
  check('adc fixture: the gapped window reports no peak', gapped.peak === null && gapped.magnitude.length === 0, 'a value survived');
}

for (const result of results) {
  if (result.pass) {
    console.log(`ok   ${result.name}`);
  } else {
    console.log(`FAIL ${result.name}: ${result.detail}`);
  }
}
const failures = results.filter((result) => !result.pass);
console.log(`fft spectrum selftest: ${results.length - failures.length}/${results.length} passed`);
if (failures.length > 0) {
  throw new Error(`${failures.length} fft spectrum selftest check(s) failed`);
}
