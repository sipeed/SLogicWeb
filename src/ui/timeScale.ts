// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The staged time scale behind the acquisition Duration slider.
 *
 * A single linear slider over 1 ms - 7 min would make the millisecond end unusable, and a
 * unit dropdown makes the user do the thinking. Instead the slider is split into stages
 * that change unit as it moves right, like reading a time value out loud:
 *
 *   1 ms ... 4999 ms | 5 s ... 59 s | 1 min ... 2 min | ∞
 *
 * The thresholds are fixed in seconds so the crossing is predictable: below 1 ms values
 * step in microseconds, below 5 s in milliseconds, below 60 s in seconds, and after that
 * in minutes. A stage whose range is too small to exist is left out, so a range that ends
 * at 21 s has only the millisecond and second stages. Within a stage the step is a whole
 * number of its unit, chosen to keep the stage under {@link MAX_STAGE_STEPS} slider
 * positions; the numeric field remains the exact editor.
 *
 * The finite track positions are stable; the Unlimited notch, when offered, sits at the
 * end of the track and is handled by the control, not by {@link timeAtPosition}.
 */

import { maxCaptureTimeValue } from './captureTime.js';
import { maxLoopTimeValue } from './loopTime.js';

export type ScaleUnit = 'us' | 'ms' | 's' | 'min';

export const SCALE_UNIT_SECONDS: Record<ScaleUnit, number> = {
  us: 1e-6, ms: 1e-3, s: 1, min: 60,
};

/** Unit stages, each ending where the next begins. */
export const STAGE_LIMITS: readonly { unit: ScaleUnit; belowSeconds: number }[] = [
  { unit: 'us', belowSeconds: 0.001 },
  { unit: 'ms', belowSeconds: 5 },
  { unit: 's', belowSeconds: 60 },
  { unit: 'min', belowSeconds: Number.POSITIVE_INFINITY },
];

/** The most slider positions a single stage gets; larger ranges use a whole-unit step. */
export const MAX_STAGE_STEPS = 256;

export interface TimeStage {
  unit: ScaleUnit;
  /** First and last selectable values, in seconds. The last is inclusive. */
  fromSeconds: number;
  toSeconds: number;
  /** The same bounds as whole units of `unit`. */
  fromUnits: number;
  toUnits: number;
  /** Slider increments inside the stage, in whole units. */
  stepUnits: number;
  /** Number of increments from `from` to `to`; 0 for a single-value stage. */
  steps: number;
  /** Global slider position of the stage's first value. */
  start: number;
}

export interface StagedTimeScale {
  stages: readonly TimeStage[];
  /** Position of the last finite value. */
  finiteMax: number;
  /** Position of the Unlimited notch, or null when this control has no Unlimited. */
  unlimited: number | null;
  /** The range input's max attribute. */
  sliderMax: number;
}

export interface ScaledTimeValue {
  seconds: number;
  /** The value in its stage's unit, always a whole number. */
  value: number;
  unit: ScaleUnit;
  stage: TimeStage;
}

/** Fraction of the track used by finite values when Unlimited is offered. */
const UNLIMITED_FINITE_FRACTION = 1000 / 1120;

function validRange(minSeconds: number, maxSeconds: number): boolean {
  return Number.isFinite(minSeconds) && Number.isFinite(maxSeconds) &&
    minSeconds > 0 && maxSeconds >= minSeconds;
}

/** 1, 2, 5, 10, 20, 50 ...: the smallest nice integer at least `n`. */
export function niceStep(n: number): number {
  if (!Number.isFinite(n) || n <= 1) return 1;
  const power = 10 ** Math.floor(Math.log10(n));
  for (const multiplier of [1, 2, 5, 10]) {
    if (n <= multiplier * power) return multiplier * power;
  }
  return 10 * power;
}

function makeStage(
  unit: ScaleUnit, fromSeconds: number, toSeconds: number, exclusiveEnd: boolean,
): Omit<TimeStage, 'start'> | null {
  const base = SCALE_UNIT_SECONDS[unit];
  // Round with a small epsilon so 5 s in milliseconds is 5000, not 4999.
  const fromUnits = Math.ceil(fromSeconds / base - 1e-9);
  const toUnits = exclusiveEnd
    ? Math.ceil(toSeconds / base - 1e-9) - 1
    : Math.floor(toSeconds / base + 1e-9);
  if (toUnits < fromUnits) return null;
  const span = toUnits - fromUnits;
  const stepUnits = niceStep(Math.max(1, Math.ceil(span / MAX_STAGE_STEPS)));
  const steps = Math.ceil(span / stepUnits);
  return {
    unit,
    fromSeconds: fromUnits * base,
    toSeconds: toUnits * base,
    fromUnits,
    toUnits,
    stepUnits,
    steps,
  };
}

/**
 * Build the stages covering [minSeconds, maxSeconds]. `unlimited` reserves the warning
 * segment at the end of the track (only Single's duration offers it).
 */
export function buildTimeScale(
  minSeconds: number, maxSeconds: number, unlimited = false,
): StagedTimeScale {
  if (!validRange(minSeconds, maxSeconds)) {
    return { stages: [], finiteMax: 0, unlimited: null, sliderMax: 0 };
  }
  const stages: TimeStage[] = [];
  let nextStart = 0;
  for (let i = 0; i < STAGE_LIMITS.length; i++) {
    const limit = STAGE_LIMITS[i]!;
    const hasNext = i + 1 < STAGE_LIMITS.length;
    const lo = i === 0
      ? minSeconds
      : Math.max(minSeconds, STAGE_LIMITS[i - 1]!.belowSeconds);
    if (lo > maxSeconds) break;
    const hi = Math.min(maxSeconds, limit.belowSeconds);
    if (hi < lo) continue;
    const atUpperThreshold = hasNext && hi === limit.belowSeconds && hi === maxSeconds;
    // The value exactly at a threshold belongs to the next unit (5000 ms is 5 s).
    if (hi === lo && atUpperThreshold) continue;
    const inclusiveEnd = hi === maxSeconds || !hasNext;
    const made = makeStage(limit.unit, lo, hi, !inclusiveEnd);
    if (!made) continue;
    const stage: TimeStage = { ...made, start: nextStart };
    stages.push(stage);
    nextStart = stage.start + stage.steps + 1;
    // A range that ends below this unit's ceiling has no later unit to own its top.
    if (inclusiveEnd) break;
  }
  if (stages.length === 0) {
    // A degenerate range (e.g. min == max) still needs one position.
    const made = makeStage('ms', minSeconds, maxSeconds, false);
    if (made) stages.push({ ...made, start: 0 });
  }
  const finiteMax = stages.length > 0
    ? stages[stages.length - 1]!.start + stages[stages.length - 1]!.steps
    : 0;
  if (!unlimited) {
    return { stages, finiteMax, unlimited: null, sliderMax: finiteMax };
  }
  const sliderMax = Math.max(finiteMax + 1, Math.round(finiteMax / UNLIMITED_FINITE_FRACTION));
  return { stages, finiteMax, unlimited: sliderMax, sliderMax };
}

/** The value at a finite slider position. Positions on the Unlimited notch return null. */
export function timeAtPosition(scale: StagedTimeScale, position: number): ScaledTimeValue | null {
  if (!Number.isFinite(position) || !Number.isInteger(position) ||
      position < 0 || position > scale.finiteMax) return null;
  let stage = scale.stages[0]!;
  for (const candidate of scale.stages) {
    if (position >= candidate.start) stage = candidate;
  }
  const local = Math.min(stage.steps, Math.max(0, Math.round(position - stage.start)));
  const units = Math.min(stage.toUnits, stage.fromUnits + local * stage.stepUnits);
  const base = SCALE_UNIT_SECONDS[stage.unit];
  return { seconds: units * base, value: units, unit: stage.unit, stage };
}

export interface ScaledTimePosition {
  position: number;
  value: ScaledTimeValue;
}

/**
 * The slider position and display value for `seconds`. Values between a stage's last
 * whole step and the next threshold land on the nearest finite step.
 */
export function positionForSeconds(
  scale: StagedTimeScale, seconds: number,
): ScaledTimePosition | null {
  if (scale.stages.length === 0 || !Number.isFinite(seconds) || seconds <= 0) return null;
  let stage = scale.stages[0]!;
  for (const candidate of scale.stages) {
    if (seconds >= candidate.fromSeconds - 1e-12) stage = candidate;
  }
  const base = SCALE_UNIT_SECONDS[stage.unit];
  const local = Math.round((seconds / base - stage.fromUnits) / stage.stepUnits);
  const clamped = Math.min(stage.steps, Math.max(0, local));
  const position = stage.start + clamped;
  const value = timeAtPosition(scale, position);
  return value ? { position, value } : null;
}

/** The largest finite value the control can show, in its stage's unit. */
export function finiteMaxValue(scale: StagedTimeScale): ScaledTimeValue | null {
  return timeAtPosition(scale, scale.finiteMax);
}

/** The seconds a value in `unit` stands for (no rounding; the control formats it). */
export function secondsInUnit(value: number, unit: ScaleUnit): number {
  return value * SCALE_UNIT_SECONDS[unit];
}

/** A value in `unit` with at most six significant digits, for the numeric field. */
export function unitValueText(seconds: number, unit: ScaleUnit): string {
  const value = seconds / SCALE_UNIT_SECONDS[unit];
  if (!Number.isFinite(value)) return '';
  return String(Number(value.toPrecision(6)));
}

export interface AcquisitionTimeDigitBasis {
  capture: number;
  loop: number;
  repeatInterval: number;
  digits: number;
}

/** Kept for the layout tests: the widest integer the old microsecond field showed. */
export function acquisitionTimeDigitBasis(): AcquisitionTimeDigitBasis {
  const capture = maxCaptureTimeValue(5e6, 'us');
  const loop = maxLoopTimeValue(4, 5e6, 'us');
  const repeatInterval = 10 * 1e6;
  const digits = Math.max(
    String(capture).length, String(loop).length, String(repeatInterval).length,
  );
  return { capture, loop, repeatInterval, digits };
}
