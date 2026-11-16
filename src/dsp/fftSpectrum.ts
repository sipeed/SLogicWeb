// SPDX-License-Identifier: GPL-3.0-or-later

import {
  WINDOW_KINDS, createFftPlan, fftInPlace, fillWindow, windowPower, windowSum,
  type WindowKind,
} from './fft.js';

export const FFT_MAX_SAMPLES = 65536;
export const FFT_NOMINAL_FULL_SCALE_CODES = 127.5;
export const FFT_DBFS_FLOOR = -200;

export type SpectrumStatus = 'ok' | 'gap' | 'too-short';

export interface SpectrumInput {
  codes: ArrayLike<number>;
  unknown?: ArrayLike<number>;
  samplerate: number;
  zeroCode: number;
  voltsPerCode: number;
  window: WindowKind;
  maxSamples?: number;
}

export interface SpectrumPeak {
  bin: number;
  hz: number;
  interpolatedHz: number;
  dbfs: number;
  volts: number;
}

export interface Spectrum {
  status: SpectrumStatus;
  n: number;
  analyzed: number;
  requested: number;
  sampleRate: number;
  window: WindowKind;
  binHz: number;
  enbwBins: number;
  rbwHz: number;
  nyquistHz: number;
  magnitude: Float64Array;
  dbfs: Float64Array;
  dcVolts: number;
  dcDbfs: number;
  fullScaleVolts: number;
  quantizationFloorDbfs: number;
  gapAt: number | null;
  peak: SpectrumPeak | null;
}

export interface LogAxisInput {
  nyquistHz: number;
  minHz: number;
  binHz: number;
  width: number;
  height: number;
}

export interface LogAxisTick {
  hz: number;
  x: number;
  major: boolean;
}

export interface LogAxisColumn {
  x: number;
  firstBin: number;
  lastBin: number;
  binIndex: number;
  covered: boolean;
}

export interface LogAxis {
  minHz: number;
  nyquistHz: number;
  binHz: number;
  width: number;
  height: number;
  firstBin: number;
  lastBin: number;
  ticks: LogAxisTick[];
  columns: LogAxisColumn[];
}

function requireFinite(name: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite, got ${String(value)}`);
  }
  return value;
}

function requirePositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive, got ${String(value)}`);
  }
  return value;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function requireMaxSamples(value: number | undefined): number {
  if (value === undefined) return FFT_MAX_SAMPLES;
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new RangeError(`maxSamples must be an integer of at least 2, got ${String(value)}`);
  }
  if (value > FFT_MAX_SAMPLES) {
    throw new RangeError(`maxSamples ${value} exceeds the ${FFT_MAX_SAMPLES}-sample cap`);
  }
  return value;
}

export function spectrumSize(span: number): number | null {
  if (!Number.isFinite(span)) return null;
  const bounded = Math.min(Math.floor(span), FFT_MAX_SAMPLES);
  if (bounded < 2) return null;
  return 2 ** Math.floor(Math.log2(bounded));
}

function dbfsOf(volts: number, fullScaleVolts: number): number {
  const ratio = Math.abs(volts) / fullScaleVolts;
  if (!(ratio > 0)) return FFT_DBFS_FLOOR;
  return Math.max(FFT_DBFS_FLOOR, 20 * Math.log10(ratio));
}

export function parabolicPeakOffset(values: ArrayLike<number>, index: number): number {
  if (!Number.isSafeInteger(index) || index < 1 || index > values.length - 2) {
    throw new RangeError(
      `peak index must have two neighbours in [1, ${values.length - 2}], got ${String(index)}`,
    );
  }
  const left = requireFinite('left magnitude', values[index - 1]!);
  const centre = requireFinite('centre magnitude', values[index]!);
  const right = requireFinite('right magnitude', values[index + 1]!);
  const denominator = left - 2 * centre + right;
  if (denominator === 0) return 0;
  const offset = (0.5 * (left - right)) / denominator;
  if (!Number.isFinite(offset)) return 0;
  return Math.max(-0.5, Math.min(0.5, offset));
}

function emptySpectrum(
  base: Omit<Spectrum, 'status' | 'n' | 'analyzed' | 'binHz' | 'enbwBins' | 'rbwHz' | 'nyquistHz'
    | 'magnitude' | 'dbfs' | 'dcVolts' | 'dcDbfs' | 'gapAt' | 'peak'>,
  n: number,
  status: SpectrumStatus,
  gapAt: number | null,
): Spectrum {
  return {
    ...base,
    status,
    n,
    analyzed: 0,
    binHz: n > 0 ? base.sampleRate / n : Number.NaN,
    enbwBins: Number.NaN,
    rbwHz: Number.NaN,
    nyquistHz: base.sampleRate / 2,
    magnitude: new Float64Array(0),
    dbfs: new Float64Array(0),
    dcVolts: Number.NaN,
    dcDbfs: Number.NaN,
    gapAt,
    peak: null,
  };
}

export function computeSpectrum(input: SpectrumInput): Spectrum {
  const codes = input.codes;
  const unknown = input.unknown;
  const sampleRate = requirePositive('samplerate', input.samplerate);
  const voltsPerCode = requirePositive('voltsPerCode', input.voltsPerCode);
  const zeroCode = requireFinite('zeroCode', input.zeroCode);
  if (!WINDOW_KINDS.includes(input.window)) {
    throw new RangeError(`unknown window kind ${String(input.window)}`);
  }
  const window = input.window;
  const requested = codes.length;
  if (unknown !== undefined && unknown.length < requested) {
    throw new RangeError(
      `unknown mask must cover ${requested} samples, got ${unknown.length}`,
    );
  }
  const limit = requireMaxSamples(input.maxSamples);
  const fullScaleVolts = FFT_NOMINAL_FULL_SCALE_CODES * voltsPerCode;
  const quantizationFloorDbfs = dbfsOf(voltsPerCode / Math.sqrt(12), fullScaleVolts);
  const base = { requested, sampleRate, window, fullScaleVolts, quantizationFloorDbfs };

  const n = spectrumSize(Math.min(requested, limit));
  if (n === null) return emptySpectrum(base, 0, 'too-short', null);

  if (unknown !== undefined) {
    for (let i = 0; i < n; i += 1) {
      if (unknown[i] !== 0) return emptySpectrum(base, n, 'gap', i);
    }
  }

  const plan = createFftPlan(n);
  const weights = fillWindow(window, n);
  const coherent = windowSum(window, n);
  const noiseGain = windowPower(window, n);
  const re = plan.re;
  for (let i = 0; i < n; i += 1) {
    const code = requireFinite(`codes[${i}]`, codes[i]!);
    re[i] = (code - zeroCode) * voltsPerCode * weights[i]!;
  }
  plan.im.fill(0);
  fftInPlace(plan);

  const bins = n / 2 + 1;
  const magnitude = new Float64Array(bins);
  const dbfs = new Float64Array(bins);
  for (let k = 0; k < bins; k += 1) {
    const raw = Math.hypot(plan.re[k]!, plan.im[k]!);
    const singleSided = k === 0 || k === n / 2 ? raw : 2 * raw;
    const volts = singleSided / coherent;
    magnitude[k] = volts;
    dbfs[k] = dbfsOf(volts, fullScaleVolts);
  }
  const dcVolts = plan.re[0]! / coherent;
  const binHz = sampleRate / n;
  const enbwBins = (n * noiseGain) / (coherent * coherent);

  let peakBin = 0;
  let best = Number.NEGATIVE_INFINITY;
  for (let k = 1; k < bins; k += 1) {
    if (magnitude[k]! > best) {
      best = magnitude[k]!;
      peakBin = k;
    }
  }
  let peak: SpectrumPeak | null = null;
  if (peakBin > 0 && best > 0) {
    const hz = peakBin * binHz;
    const offset = peakBin + 1 < bins ? parabolicPeakOffset(dbfs, peakBin) : 0;
    peak = {
      bin: peakBin,
      hz,
      interpolatedHz: hz + offset * binHz,
      dbfs: dbfs[peakBin]!,
      volts: magnitude[peakBin]!,
    };
  }

  return {
    ...base,
    status: 'ok',
    n,
    analyzed: n,
    binHz,
    enbwBins,
    rbwHz: enbwBins * binHz,
    nyquistHz: sampleRate / 2,
    magnitude,
    dbfs,
    dcVolts,
    dcDbfs: dbfs[0]!,
    gapAt: null,
    peak,
  };
}

function assertAxisRange(minHz: number, nyquistHz: number): void {
  requirePositive('minHz', minHz);
  requirePositive('nyquistHz', nyquistHz);
  if (minHz >= nyquistHz) {
    throw new RangeError(
      `minHz ${minHz} must be below the ${nyquistHz} Hz Nyquist limit`,
    );
  }
}

export function logAxisX(
  hz: number, minHz: number, nyquistHz: number, width: number,
): number {
  assertAxisRange(minHz, nyquistHz);
  requirePositiveInteger('width', width);
  requirePositive('hz', hz);
  return (width * Math.log(hz / minHz)) / Math.log(nyquistHz / minHz);
}

export function logAxisHz(
  x: number, minHz: number, nyquistHz: number, width: number,
): number {
  assertAxisRange(minHz, nyquistHz);
  requirePositiveInteger('width', width);
  if (!Number.isFinite(x)) throw new RangeError(`x must be finite, got ${String(x)}`);
  return minHz * (nyquistHz / minHz) ** (x / width);
}

const TICK_MANTISSAS = [1, 2, 5] as const;

export function logFrequencyAxis(input: LogAxisInput): LogAxis {
  const nyquistHz = input.nyquistHz;
  const minHz = input.minHz;
  const binHz = input.binHz;
  assertAxisRange(minHz, nyquistHz);
  requirePositive('binHz', binHz);
  const width = requirePositiveInteger('width', input.width);
  const height = requirePositiveInteger('height', input.height);

  const ticks: LogAxisTick[] = [];
  const firstDecade = Math.floor(Math.log10(minHz)) - 1;
  const lastDecade = Math.ceil(Math.log10(nyquistHz)) + 1;
  for (let decade = firstDecade; decade <= lastDecade; decade += 1) {
    for (const mantissa of TICK_MANTISSAS) {
      const hz = Number(`${mantissa}e${decade}`);
      if (hz < minHz || hz > nyquistHz) continue;
      ticks.push({ hz, x: logAxisX(hz, minHz, nyquistHz, width), major: mantissa === 1 });
    }
  }

  const maxBin = Math.floor(nyquistHz / binHz + 1e-9);
  const firstBin = Math.max(1, Math.ceil(minHz / binHz - 1e-9));
  const columns: LogAxisColumn[] = [];
  for (let x = 0; x < width; x += 1) {
    columns.push({ x, firstBin: -1, lastBin: -1, binIndex: -1, covered: false });
  }
  for (let bin = firstBin; bin <= maxBin; bin += 1) {
    const hz = bin * binHz;
    if (hz < minHz || hz > nyquistHz) continue;
    const position = Math.floor(logAxisX(hz, minHz, nyquistHz, width));
    const column = columns[Math.min(width - 1, Math.max(0, position))]!;
    if (column.covered) {
      column.lastBin = bin;
    } else {
      column.covered = true;
      column.firstBin = bin;
      column.lastBin = bin;
      column.binIndex = bin;
    }
  }
  for (const column of columns) {
    if (column.covered) continue;
    const centreHz = logAxisHz(column.x + 0.5, minHz, nyquistHz, width);
    const nearest = Math.round(centreHz / binHz);
    column.binIndex = Math.min(maxBin, Math.max(firstBin, nearest));
  }

  return {
    minHz,
    nyquistHz,
    binHz,
    width,
    height,
    firstBin,
    lastBin: maxBin,
    ticks,
    columns,
  };
}

export function aggregateColumns(
  columns: readonly LogAxisColumn[], values: ArrayLike<number>,
): Float64Array {
  const out = new Float64Array(columns.length);
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i]!;
    if (!column.covered) {
      out[i] = Number.NaN;
      continue;
    }
    let best = Number.NEGATIVE_INFINITY;
    for (let bin = column.firstBin; bin <= column.lastBin; bin += 1) {
      const value = values[bin]!;
      if (Number.isNaN(value)) {
        best = Number.NaN;
        break;
      }
      if (value > best) best = value;
    }
    out[i] = best;
  }
  return out;
}
