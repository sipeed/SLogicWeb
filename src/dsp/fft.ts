// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M1 FFT, window and spectrum helpers (docs/ARCHITECTURE.md §2, DESIGN.md §5.3, §6.3).
 *
 * Pure, deterministic and DOM-free. The transforms are radix-2 decimation-in-time,
 * in place, with precomputed bit-reversal and twiddle tables. This module owns no time
 * base of its own: a caller that needs hertz supplies `sampleRateHz`.
 *
 * ## Transform convention
 *
 * For a length-`N` complex sequence `x[n]`, the forward transform is
 *
 *   X[k] = sum over n of x[n] * exp(-2πi k n / N)
 *
 * and the inverse divides by `N` after the conjugate transform. The forward transform
 * is unscaled: a DC input of amplitude `A` produces `X[0] = A*N`. Bin `k <= N/2`
 * corresponds to `k * sampleRateHz / N` hertz; bins above `N/2` mirror negative
 * frequencies. A real input's unique spectrum is `k = 0..floor(N/2)`, which is what
 * `magnitudeSpectrum`/`phaseSpectrum` return. The sample rate must exceed twice the
 * highest input component for an unambiguous spectrum; the FFT itself does not know
 * about Nyquist and happily transforms an aliased signal.
 *
 * ## Sizes and limits
 *
 * `N` must be a power of two (`1, 2, 4, ...`). Any other size is refused with a
 * `RangeError` rather than silently padded or truncated: the caller owns the choice of
 * FFT length. `N = 1` is the identity transform. Sizes above `MAX_FFT_SIZE` are
 * refused because the bit-reversal table stores 32-bit indices; practical memory is a
 * far lower limit (a plan holds two Float64 buffers and two Float64 tables).
 *
 * ## Numerical limits
 *
 * Twiddles are computed once in Float64 with `Math.cos`/`Math.sin`; a length-`N`
 * transform has the usual `O(epsilon log N)` relative error. Parseval holds up to
 * rounding: `sum |x[n]|^2 = (1/N) sum |X[k]|^2`. Inputs must be finite; a NaN or
 * Infinity sample propagates to every output bin, so callers should replace data gaps
 * before transforming.
 *
 * ## Windows
 *
 * `WINDOW_KINDS` are the periodic (DFT-even) windows, with denominator `N`:
 * rectangular, Hann, Hamming and Blackman. Periodic windows are the right choice for
 * spectral analysis of a length-`N` FFT; a symmetric window belongs to FIR design and
 * is not provided here. For typical lengths the sums are `N` (rectangular), `N/2`
 * (Hann), `0.54N` (Hamming) and `0.42N` (Blackman); Blackman's closed form assumes
 * `N >= 3`. `windowSum`/`windowPower` always loop, so they are exact for any length,
 * including the degenerate `N = 1` (values `1, 0, 0.08, 0`).
 *
 * ## Allocation
 *
 * `createFftPlan(N)` allocates the input/output buffers and tables once;
 * `fftInPlace`/`ifftInPlace` then perform zero allocations per transform, which is the
 * intended path for repeated UI updates. `fft(re, im)`/`ifft(re, im)` are convenience
 * wrappers that allocate the O(N) tables on every call. Spectrum and window helpers
 * allocate their result only when `out` is omitted; passing `out` makes them
 * allocation-free. The transforms mutate the supplied Float64 buffers in place, so a
 * readonly sample array must be copied in by the caller.
 */

/** Periodic (DFT-even) window kinds supported by this module. */
export const WINDOW_KINDS = ['rectangular', 'hann', 'hamming', 'blackman'] as const;

export type WindowKind = (typeof WINDOW_KINDS)[number];

/** Largest accepted FFT length: the bit-reversal table stores 32-bit indices. */
export const MAX_FFT_SIZE = 2 ** 31;

/**
 * The length must be a positive safe integer no larger than `MAX_FFT_SIZE`.
 *
 * Exposed as a guard for callers that pick an FFT size from a viewport or a sample
 * count before allocating a plan.
 */
export function assertFftSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`FFT size must be a positive safe integer, got ${String(size)}`);
  }
  if (size > MAX_FFT_SIZE) {
    throw new RangeError(`FFT size ${size} exceeds the ${MAX_FFT_SIZE}-sample limit`);
  }
  if (!isPowerOfTwo(size)) {
    throw new RangeError(`FFT size must be a power of two, got ${size}`);
  }
}

function isPowerOfTwo(value: number): boolean {
  let rest = value;
  while (rest > 1) {
    if (rest % 2 !== 0) return false;
    rest /= 2;
  }
  return true;
}

function assertWindowLength(length: number): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`window length must be a non-negative safe integer, got ${String(length)}`);
  }
}

function windowValue(kind: WindowKind, index: number, length: number): number {
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
    default:
      throw new RangeError(`unknown window kind ${String(kind)}`);
  }
}

/**
 * One coefficient of a periodic window of `length` samples, for `index` in
 * `[0, length)`. Rectangular returns 1. Length 0 has no valid index.
 */
export function windowCoefficient(kind: WindowKind, index: number, length: number): number {
  assertWindowLength(length);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new RangeError(
      `window index must be a safe integer in [0, ${length}), got ${String(index)}`,
    );
  }
  return windowValue(kind, index, length);
}

/**
 * Fill `out` (or a new Float64Array) with the periodic window of `length` samples.
 * The returned array is `out` when supplied, so repeated updates can reuse one buffer.
 */
export function fillWindow(
  kind: WindowKind,
  length: number,
  out?: Float64Array,
): Float64Array {
  assertWindowLength(length);
  const target = out ?? new Float64Array(length);
  if (target.length !== length) {
    throw new RangeError(
      `window output length must be ${length}, got ${target.length}`,
    );
  }
  for (let i = 0; i < length; i += 1) target[i] = windowValue(kind, i, length);
  return target;
}

/**
 * Sum of the window coefficients (coherent gain times `N`). Allocates nothing.
 */
export function windowSum(kind: WindowKind, length: number): number {
  assertWindowLength(length);
  let sum = 0;
  let compensation = 0;
  for (let i = 0; i < length; i += 1) {
    const value = windowValue(kind, i, length);
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + compensation;
}

/**
 * Sum of the squared window coefficients (the noise-power gain used for ENBW and
 * Parseval corrections). Allocates nothing.
 */
export function windowPower(kind: WindowKind, length: number): number {
  assertWindowLength(length);
  let sum = 0;
  let compensation = 0;
  for (let i = 0; i < length; i += 1) {
    const value = windowValue(kind, i, length);
    const square = value * value;
    const next = sum + square;
    compensation += Math.abs(sum) >= Math.abs(square)
      ? (sum - next) + square
      : (square - next) + sum;
    sum = next;
  }
  return sum + compensation;
}

/**
 * A reusable radix-2 FFT workspace.
 *
 * Fill `re`/`im` with the input, call `fftInPlace(plan)`, then read `re`/`im`. The
 * buffers and tables are owned by the plan and never reallocated by the transforms.
 * `cosTable[k]`/`sinTable[k]` hold `cos`/`sin(2πk/N)` for `k < N/2`.
 */
export interface FftPlan {
  readonly size: number;
  readonly re: Float64Array;
  readonly im: Float64Array;
  readonly bitReversal: Uint32Array;
  readonly cosTable: Float64Array;
  readonly sinTable: Float64Array;
}

interface FftTables {
  bitReversal: Uint32Array;
  cosTable: Float64Array;
  sinTable: Float64Array;
}

function reverseBits(value: number, bits: number): number {
  let result = 0;
  let rest = value;
  for (let bit = 0; bit < bits; bit += 1) {
    result = result * 2 + (rest % 2);
    rest = Math.floor(rest / 2);
  }
  return result;
}

function createFftTables(size: number): FftTables {
  let bits = 0;
  for (let rest = size; rest > 1; rest /= 2) bits += 1;

  const bitReversal = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) bitReversal[i] = reverseBits(i, bits);

  const half = Math.floor(size / 2);
  const cosTable = new Float64Array(half);
  const sinTable = new Float64Array(half);
  for (let k = 0; k < half; k += 1) {
    const phase = (2 * Math.PI * k) / size;
    cosTable[k] = Math.cos(phase);
    sinTable[k] = Math.sin(phase);
  }
  return { bitReversal, cosTable, sinTable };
}

/**
 * Allocate a transform plan for a power-of-two `size`. Non-powers of two, zero,
 * fractional and negative sizes throw `RangeError`. The plan is reusable and its
 * buffers can be filled directly before each transform.
 */
export function createFftPlan(size: number): FftPlan {
  assertFftSize(size);
  const tables = createFftTables(size);
  return {
    size,
    re: new Float64Array(size),
    im: new Float64Array(size),
    bitReversal: tables.bitReversal,
    cosTable: tables.cosTable,
    sinTable: tables.sinTable,
  };
}

function transformInPlace(
  size: number,
  re: Float64Array,
  im: Float64Array,
  bitReversal: Uint32Array,
  cosTable: Float64Array,
  sinTable: Float64Array,
  inverse: boolean,
): void {
  // Decimation in time starts from bit-reversed input order.
  for (let i = 0; i < size; i += 1) {
    const j = bitReversal[i];
    if (j > i) {
      const reValue = re[i];
      const imValue = im[i];
      re[i] = re[j];
      im[i] = im[j];
      re[j] = reValue;
      im[j] = imValue;
    }
  }

  for (let length = 2; length <= size; length *= 2) {
    const half = length / 2;
    const tableStep = size / length;
    for (let start = 0; start < size; start += length) {
      for (let k = 0; k < half; k += 1) {
        const tableIndex = k * tableStep;
        const wr = cosTable[tableIndex];
        const wi = inverse ? sinTable[tableIndex] : -sinTable[tableIndex];
        const even = start + k;
        const odd = even + half;
        const oddRe = re[odd];
        const oddIm = im[odd];
        const tr = wr * oddRe - wi * oddIm;
        const ti = wr * oddIm + wi * oddRe;
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
      }
    }
  }

  if (inverse) {
    const scale = 1 / size;
    for (let i = 0; i < size; i += 1) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }
}

/**
 * In-place forward transform of a plan's buffers. Zero allocations.
 */
export function fftInPlace(plan: FftPlan): void {
  transformInPlace(
    plan.size, plan.re, plan.im,
    plan.bitReversal, plan.cosTable, plan.sinTable, false,
  );
}

/**
 * In-place inverse transform of a plan's buffers, scaled by `1/N`. Zero allocations.
 */
export function ifftInPlace(plan: FftPlan): void {
  transformInPlace(
    plan.size, plan.re, plan.im,
    plan.bitReversal, plan.cosTable, plan.sinTable, true,
  );
}

function transformBuffers(re: Float64Array, im: Float64Array, inverse: boolean): void {
  if (re.length !== im.length) {
    throw new RangeError(
      `FFT real and imaginary buffers must have equal length, got ${re.length} and ${im.length}`,
    );
  }
  const size = re.length;
  assertFftSize(size);
  const tables = createFftTables(size);
  transformInPlace(
    size, re, im,
    tables.bitReversal, tables.cosTable, tables.sinTable, inverse,
  );
}

/**
 * Convenience in-place forward transform of two caller-owned Float64 buffers.
 *
 * Validates equal lengths and the power-of-two rule, then allocates the O(N) tables
 * for this call. Prefer a plan for repeated transforms. The arrays are mutated.
 */
export function fft(re: Float64Array, im: Float64Array): void {
  transformBuffers(re, im, false);
}

/**
 * Convenience in-place inverse transform (scaled by `1/N`) of two caller arrays.
 * Allocates the O(N) tables for this call; prefer a plan when repeating.
 */
export function ifft(re: Float64Array, im: Float64Array): void {
  transformBuffers(re, im, true);
}

function assertComplexBin(
  name: string,
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  index: number,
): void {
  if (re.length !== im.length) {
    throw new RangeError(
      `${name}: real and imaginary lengths differ (${re.length} and ${im.length})`,
    );
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= re.length) {
    throw new RangeError(`${name}: bin index must be in [0, ${re.length}), got ${String(index)}`);
  }
}

/** Magnitude `sqrt(re^2 + im^2)` of one complex bin. */
export function binMagnitude(
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  index: number,
): number {
  assertComplexBin('binMagnitude', re, im, index);
  return Math.hypot(re[index], im[index]);
}

/** Phase `atan2(im, re)` of one complex bin, in radians in `(-pi, pi]`. */
export function binPhase(
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  index: number,
): number {
  assertComplexBin('binPhase', re, im, index);
  return Math.atan2(im[index], re[index]);
}

function spectrumBins(length: number, name: string): number {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new RangeError(`${name}: spectrum length must be a positive integer, got ${String(length)}`);
  }
  return Math.floor(length / 2) + 1;
}

/**
 * Magnitudes of the unique bins `0..floor(N/2)` of a complex spectrum. The input is
 * normally `plan.re`/`plan.im` after `fftInPlace`. Allocates only when `out` is
 * omitted; `out` must have exactly `floor(N/2) + 1` elements.
 */
export function magnitudeSpectrum(
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  out?: Float64Array,
): Float64Array {
  if (re.length !== im.length) {
    throw new RangeError(
      `magnitudeSpectrum: real and imaginary lengths differ (${re.length} and ${im.length})`,
    );
  }
  const bins = spectrumBins(re.length, 'magnitudeSpectrum');
  const target = out ?? new Float64Array(bins);
  if (target.length !== bins) {
    throw new RangeError(`magnitudeSpectrum: output must have ${bins} elements, got ${target.length}`);
  }
  for (let k = 0; k < bins; k += 1) target[k] = Math.hypot(re[k], im[k]);
  return target;
}

/**
 * Phases of the unique bins `0..floor(N/2)` in radians. The input is normally
 * `plan.re`/`plan.im` after `fftInPlace`. Allocates only when `out` is omitted.
 */
export function phaseSpectrum(
  re: ArrayLike<number>,
  im: ArrayLike<number>,
  out?: Float64Array,
): Float64Array {
  if (re.length !== im.length) {
    throw new RangeError(
      `phaseSpectrum: real and imaginary lengths differ (${re.length} and ${im.length})`,
    );
  }
  const bins = spectrumBins(re.length, 'phaseSpectrum');
  const target = out ?? new Float64Array(bins);
  if (target.length !== bins) {
    throw new RangeError(`phaseSpectrum: output must have ${bins} elements, got ${target.length}`);
  }
  for (let k = 0; k < bins; k += 1) target[k] = Math.atan2(im[k], re[k]);
  return target;
}

/**
 * Principal frequency of bin `index` for an FFT of `size` at `sampleRateHz`.
 *
 * Returns `index * sampleRateHz / size` for the lower half and the mirrored negative
 * frequency for the upper half, in `[-sampleRateHz/2, sampleRateHz/2]`. The odd-length
 * middle bin is the negative side. The caller must satisfy Nyquist for a meaningful
 * result.
 */
export function binFrequencyHz(
  index: number,
  size: number,
  sampleRateHz: number,
): number {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`binFrequencyHz: FFT size must be a positive integer, got ${String(size)}`);
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= size) {
    throw new RangeError(`binFrequencyHz: bin index must be in [0, ${size}), got ${String(index)}`);
  }
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new RangeError(
      `binFrequencyHz: sampleRateHz must be finite and positive, got ${String(sampleRateHz)}`,
    );
  }
  const principal = index > size / 2 ? index - size : index;
  return (principal * sampleRateHz) / size;
}
