// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M1 measurements over complete samples (docs/ARCHITECTURE.md §2, DESIGN.md §6.3).
 *
 * Pure, deterministic and DOM-free: every function here reads a caller-owned sample
 * array and never touches a store, a device, a worker or the UI. Automatic measurements
 * run on the visible retention window, so the caller passes an explicit `[start, end)`
 * range; this module never scans an unbounded capture on its own.
 *
 * ## Units and coordinates
 *
 * - Analog samples are calibrated volts (the same values the analog columns carry).
 * - Digital samples are one logic level per sample: `0` is low, any nonzero finite
 *   value is high. This module measures levels, not packed device bytes; a caller that
 *   holds packed samples unpacks one level per sample first.
 * - `start` is inclusive and `end` exclusive, in whole sample positions (exact
 *   integers). Both are validated: a fractional, negative, reversed or out-of-range
 *   bound is a `RangeError`, never a silent clamp.
 * - `min`, `max`, `mean`, `rms` and `peakToPeak` carry the input unit: volts for
 *   analog, logic levels (0/1) for digital. `dutyCycle` is a fraction in `[0, 1]`.
 * - Frequency is hertz and period is seconds; the sample rate is supplied by the
 *   caller because a bare sample array has no time base.
 *
 * ## Unknown samples
 *
 * Non-finite samples (NaN, ±Infinity) are "no trustworthy data", matching the analog
 * column convention. They are skipped, never propagated: `count` reports how many
 * finite samples were measured and can therefore be smaller than `end - start`. An
 * empty range, or a range with no finite samples, reports `count: 0` and `NaN` for
 * every statistic rather than inventing a zero.
 *
 * ## Numerical limits
 *
 * `mean` and `rms` use Neumaier compensated summation in Float64, so a long block
 * accumulates with roughly one rounding error instead of a growing drift. RMS is
 * `sqrt(sum(x^2) / count)`; squares overflow Float64 above about `1.3e154` per sample,
 * and inputs with a huge DC offset lose relative precision in the sum of squares (as
 * they do in any Float64 RMS computed this way). Results are only as accurate as the
 * caller's calibration.
 *
 * ## Allocation
 *
 * Each call allocates one small result object unless `out` is supplied; supplying the
 * same `out` on every measurement update makes the hot path allocation-free. The input
 * arrays are never copied.
 *
 * ## Frequency/period estimation
 *
 * `estimateDigitalFrequency` is a bounded, streaming edge measurement:
 *
 * - It inspects at most `maxSamples` samples (default
 *   `DEFAULT_FREQUENCY_MAX_SAMPLES`), starting at `start`, even when the requested
 *   range or the capture is larger. `inspectedSamples` reports the prefix actually
 *   examined, so a caller can show that the estimate is windowed.
 * - Edges are counted between two consecutive finite samples *inside* the inspected
 *   window. The first inspected sample has no predecessor in the window, so an edge
 *   across the window boundary is not counted. A non-finite sample breaks continuity:
 *   no edge is counted across it.
 * - A rising edge is a low sample followed by a high sample. The period is the mean
 *   interval between the first and last rising edge, `(last - first) / (edges - 1)`,
 *   and the frequency is `sampleRateHz / periodSamples`. Two rising edges (one full
 *   period) are the minimum; fewer yields a typed `status` and `NaN` values.
 * - Edge positions are whole samples, so the period is quantized to one sample and the
 *   relative error falls with the number of periods in the window. Watch the Nyquist
 *   limit: `sampleRateHz` must exceed twice the signal's fundamental, otherwise the
 *   estimate reports the alias. Duty cycle is the high fraction between the first and
 *   last rising edge (an integer number of periods), not the possibly partial
 *   boundary.
 */

/** Statistics of an analog sample range. Units: volts. */
export interface AnalogMeasurements {
  /** Number of finite samples measured; at most `end - start`. */
  count: number;
  /** Smallest finite sample, or NaN when `count` is 0. */
  min: number;
  /** Largest finite sample, or NaN when `count` is 0. */
  max: number;
  /** Arithmetic mean of the finite samples, or NaN when `count` is 0. */
  mean: number;
  /** Root mean square of the finite samples, or NaN when `count` is 0. */
  rms: number;
  /** `max - min`, or NaN when `count` is 0. */
  peakToPeak: number;
}

/**
 * Statistics of a digital sample range. Levels are normalized to 0/1 before
 * measurement, so `mean` is the high fraction and `rms` is its square root.
 */
export interface DigitalMeasurements extends AnalogMeasurements {
  /** Number of finite samples measured high. */
  highCount: number;
  /** `highCount / count`, a fraction in `[0, 1]`, or NaN when `count` is 0. */
  dutyCycle: number;
}

/** Why a frequency estimate has no value. */
export type DigitalFrequencyStatus =
  | 'ok'
  | 'empty-range'
  | 'no-rising-edges'
  | 'one-rising-edge';

/**
 * Result of `estimateDigitalFrequency`. Fields that need a period are NaN unless
 * `status` is `'ok'`; `firstRisingIndex`/`lastRisingIndex` are -1 when no rising edge
 * was found.
 */
export interface DigitalFrequencyEstimate {
  status: DigitalFrequencyStatus;
  /** Samples examined, at most `maxSamples`. */
  inspectedSamples: number;
  /** Finite samples among the examined ones. */
  measuredSamples: number;
  /** Rising edges counted inside the window. */
  risingEdges: number;
  /** Falling edges counted inside the window. */
  fallingEdges: number;
  /** Absolute sample index of the first rising edge, or -1. */
  firstRisingIndex: number;
  /** Absolute sample index of the last rising edge, or -1. */
  lastRisingIndex: number;
  /** Mean rising-edge interval in samples, NaN unless `status` is `'ok'`. */
  periodSamples: number;
  /** `periodSamples / sampleRateHz`, NaN unless `status` is `'ok'`. */
  periodSeconds: number;
  /** `sampleRateHz / periodSamples`, NaN unless `status` is `'ok'`. */
  frequencyHz: number;
  /** High fraction between the first and last rising edge, NaN unless ok. */
  dutyCycle: number;
}

/** Options for `estimateDigitalFrequency`. */
export interface DigitalFrequencyOptions {
  /** First sample to inspect (inclusive). Defaults to 0. */
  start?: number;
  /** End of the requested range (exclusive). Defaults to `levels.length`. */
  end?: number;
  /**
   * Maximum samples to inspect from `start`. Defaults to
   * `DEFAULT_FREQUENCY_MAX_SAMPLES`. Must be a positive safe integer.
   */
  maxSamples?: number;
}

/** Default scan bound: 2^20 samples per estimate. */
export const DEFAULT_FREQUENCY_MAX_SAMPLES = 1 << 20;

function assertRange(name: string, length: number, start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new RangeError(
      `${name}: start and end must be safe integers, got ${String(start)} and ${String(end)}`,
    );
  }
  if (start < 0 || end < start || end > length) {
    throw new RangeError(
      `${name}: range [${start}, ${end}) is outside [0, ${length})`,
    );
  }
}

function emptyAnalog(out: AnalogMeasurements): AnalogMeasurements {
  out.count = 0;
  out.min = Number.NaN;
  out.max = Number.NaN;
  out.mean = Number.NaN;
  out.rms = Number.NaN;
  out.peakToPeak = Number.NaN;
  return out;
}

function emptyDigital(out: DigitalMeasurements): DigitalMeasurements {
  emptyAnalog(out);
  out.highCount = 0;
  out.dutyCycle = Number.NaN;
  return out;
}

/**
 * Min, max, mean, RMS and peak-to-peak of `samples[start..end)` in volts.
 *
 * Non-finite samples are skipped. An empty or all-unknown range returns
 * `count: 0` with NaN statistics. Supplying `out` reuses that object (all fields are
 * overwritten) and makes repeated updates allocation-free.
 */
export function measureAnalogRange(
  samples: ArrayLike<number>,
  start: number,
  end: number,
  out?: AnalogMeasurements,
): AnalogMeasurements {
  assertRange('measureAnalogRange', samples.length, start, end);
  const target = out ?? {
    count: 0,
    min: Number.NaN,
    max: Number.NaN,
    mean: Number.NaN,
    rms: Number.NaN,
    peakToPeak: Number.NaN,
  };

  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let sumCompensation = 0;
  let squareSum = 0;
  let squareCompensation = 0;

  for (let i = start; i < end; i += 1) {
    const value = samples[i];
    if (!Number.isFinite(value)) continue;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;

    // Neumaier summation: the compensation term keeps a long block's error bounded.
    let next = sum + value;
    sumCompensation += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;

    const square = value * value;
    next = squareSum + square;
    squareCompensation += Math.abs(squareSum) >= Math.abs(square)
      ? (squareSum - next) + square
      : (square - next) + squareSum;
    squareSum = next;
  }

  if (count === 0) return emptyAnalog(target);
  target.count = count;
  target.min = min;
  target.max = max;
  target.mean = (sum + sumCompensation) / count;
  target.rms = Math.sqrt((squareSum + squareCompensation) / count);
  target.peakToPeak = max - min;
  return target;
}

/**
 * Min, max, mean, RMS, peak-to-peak and duty cycle of `levels[start..end)`.
 *
 * Digital levels are normalized to 0/1 (`0` low, any nonzero finite value high), so
 * `mean` and `dutyCycle` both report the high fraction and `rms` is its square root.
 * Unknown samples are skipped and are never counted as high or low.
 */
export function measureDigitalRange(
  levels: ArrayLike<number>,
  start: number,
  end: number,
  out?: DigitalMeasurements,
): DigitalMeasurements {
  assertRange('measureDigitalRange', levels.length, start, end);
  const target = out ?? {
    count: 0,
    min: Number.NaN,
    max: Number.NaN,
    mean: Number.NaN,
    rms: Number.NaN,
    peakToPeak: Number.NaN,
    highCount: 0,
    dutyCycle: Number.NaN,
  };

  let count = 0;
  let highCount = 0;
  for (let i = start; i < end; i += 1) {
    const value = levels[i];
    if (!Number.isFinite(value)) continue;
    count += 1;
    if (value !== 0) highCount += 1;
  }

  if (count === 0) return emptyDigital(target);
  const dutyCycle = highCount / count;
  target.count = count;
  target.min = highCount === count ? 1 : 0;
  target.max = highCount === 0 ? 0 : 1;
  target.mean = dutyCycle;
  target.rms = Math.sqrt(dutyCycle);
  target.peakToPeak = target.max - target.min;
  target.highCount = highCount;
  target.dutyCycle = dutyCycle;
  return target;
}

function emptyFrequencyEstimate(): DigitalFrequencyEstimate {
  return {
    status: 'empty-range',
    inspectedSamples: 0,
    measuredSamples: 0,
    risingEdges: 0,
    fallingEdges: 0,
    firstRisingIndex: -1,
    lastRisingIndex: -1,
    periodSamples: Number.NaN,
    periodSeconds: Number.NaN,
    frequencyHz: Number.NaN,
    dutyCycle: Number.NaN,
  };
}

/**
 * Estimate the fundamental frequency, period and duty cycle of a digital level array.
 *
 * At most `maxSamples` samples from `start` are inspected (never the whole capture by
 * default), which bounds the work per update. The estimate is the average between the
 * first and last rising edge; see the module comment for edge, boundary, Nyquist and
 * quantization rules. Returns `status: 'empty-range'`, `'no-rising-edges'` or
 * `'one-rising-edge'` with NaN values when no period exists. Invalid ranges, sample
 * rates and scan bounds throw `RangeError`; the caller supplies `sampleRateHz` in
 * hertz and it must be finite and positive.
 */
export function estimateDigitalFrequency(
  levels: ArrayLike<number>,
  sampleRateHz: number,
  options: DigitalFrequencyOptions = {},
  out?: DigitalFrequencyEstimate,
): DigitalFrequencyEstimate {
  const start = options.start ?? 0;
  const end = options.end ?? levels.length;
  assertRange('estimateDigitalFrequency', levels.length, start, end);
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new RangeError(
      `estimateDigitalFrequency: sampleRateHz must be finite and positive, got ${String(sampleRateHz)}`,
    );
  }
  const maxSamples = options.maxSamples ?? DEFAULT_FREQUENCY_MAX_SAMPLES;
  if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
    throw new RangeError(
      `estimateDigitalFrequency: maxSamples must be a positive safe integer, got ${String(maxSamples)}`,
    );
  }

  const inspectEnd = Math.min(end, start + maxSamples);
  let inspectedSamples = 0;
  let measuredSamples = 0;
  let risingEdges = 0;
  let fallingEdges = 0;
  let firstRisingIndex = -1;
  let lastRisingIndex = -1;
  // null means "no known predecessor": the window boundary or an unknown sample.
  let previousHigh: boolean | null = null;

  for (let i = start; i < inspectEnd; i += 1) {
    inspectedSamples += 1;
    const value = levels[i];
    if (!Number.isFinite(value)) {
      previousHigh = null;
      continue;
    }
    measuredSamples += 1;
    const high = value !== 0;
    if (previousHigh !== null) {
      if (high && !previousHigh) {
        risingEdges += 1;
        if (firstRisingIndex < 0) firstRisingIndex = i;
        lastRisingIndex = i;
      } else if (!high && previousHigh) {
        fallingEdges += 1;
      }
    }
    previousHigh = high;
  }

  let status: DigitalFrequencyStatus;
  if (inspectedSamples === 0) status = 'empty-range';
  else if (risingEdges === 0) status = 'no-rising-edges';
  else if (risingEdges === 1) status = 'one-rising-edge';
  else status = 'ok';

  const target = out ?? emptyFrequencyEstimate();
  target.status = status;
  target.inspectedSamples = inspectedSamples;
  target.measuredSamples = measuredSamples;
  target.risingEdges = risingEdges;
  target.fallingEdges = fallingEdges;
  target.firstRisingIndex = firstRisingIndex;
  target.lastRisingIndex = lastRisingIndex;
  target.periodSamples = Number.NaN;
  target.periodSeconds = Number.NaN;
  target.frequencyHz = Number.NaN;
  target.dutyCycle = Number.NaN;

  if (status !== 'ok') return target;

  const periodSamples = (lastRisingIndex - firstRisingIndex) / (risingEdges - 1);
  target.periodSamples = periodSamples;
  target.periodSeconds = periodSamples / sampleRateHz;
  target.frequencyHz = sampleRateHz / periodSamples;

  // Duty over whole periods only: [firstRising, lastRising) is an integer number of
  // periods, so a partial period at either window boundary cannot bias it.
  let spanSamples = 0;
  let spanHigh = 0;
  for (let i = firstRisingIndex; i < lastRisingIndex; i += 1) {
    const value = levels[i];
    if (!Number.isFinite(value)) continue;
    spanSamples += 1;
    if (value !== 0) spanHigh += 1;
  }
  if (spanSamples > 0) target.dutyCycle = spanHigh / spanSamples;
  return target;
}
