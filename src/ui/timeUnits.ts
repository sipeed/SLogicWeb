// SPDX-License-Identifier: GPL-3.0-or-later

export const TIME_UNITS = ['us', 'ms', 's'] as const;
export type TimeUnit = (typeof TIME_UNITS)[number];
export const DEFAULT_TIME_UNIT: TimeUnit = 'ms';

const UNIT_SECONDS: Record<TimeUnit, number> = { us: 1e-6, ms: 1e-3, s: 1 };
const UNIT_MICROSECONDS: Record<TimeUnit, number> = { us: 1, ms: 1000, s: 1_000_000 };

export function isTimeUnit(value: string): value is TimeUnit {
  return (TIME_UNITS as readonly string[]).includes(value);
}

export function timeUnitSeconds(unit: TimeUnit): number {
  return UNIT_SECONDS[unit];
}

export function isPositiveInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function validRange(minSeconds: number, maxSeconds: number): boolean {
  return Number.isFinite(minSeconds) && Number.isFinite(maxSeconds) &&
    minSeconds > 0 && maxSeconds >= minSeconds;
}

export function minTimeValue(minSeconds: number, unit: TimeUnit): number {
  if (!isTimeUnit(unit) || !Number.isFinite(minSeconds) || minSeconds <= 0) return 0;
  return Math.max(1, Math.ceil(minSeconds * 1e6 / UNIT_MICROSECONDS[unit]));
}

export function maxTimeValue(maxSeconds: number, unit: TimeUnit): number {
  if (!isTimeUnit(unit) || !Number.isFinite(maxSeconds) || maxSeconds <= 0) return 0;
  return Math.max(0, Math.floor(maxSeconds * 1e6 / UNIT_MICROSECONDS[unit]));
}

export function timeValueFromSeconds(
  seconds: number, unit: TimeUnit, minSeconds: number, maxSeconds: number,
): number | null {
  if (!Number.isFinite(seconds) || !validRange(minSeconds, maxSeconds)) return null;
  const min = minTimeValue(minSeconds, unit);
  const max = maxTimeValue(maxSeconds, unit);
  if (min < 1 || max < min) return null;
  return Math.min(max, Math.max(min, Math.round(seconds * 1e6 / UNIT_MICROSECONDS[unit])));
}

export function secondsFromTimeValue(
  value: number, unit: TimeUnit, minSeconds: number, maxSeconds: number,
): number | null {
  if (!isPositiveInteger(value) || !validRange(minSeconds, maxSeconds)) return null;
  const min = minTimeValue(minSeconds, unit);
  const max = maxTimeValue(maxSeconds, unit);
  if (min < 1 || max < min) return null;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.min(maxSeconds, Math.max(minSeconds, clamped * UNIT_MICROSECONDS[unit] / 1e6));
}

export function timeUnitForRange(
  preferred: TimeUnit, minSeconds: number, maxSeconds: number,
): TimeUnit | null {
  if (!validRange(minSeconds, maxSeconds) || !isTimeUnit(preferred)) return null;
  if (timeValueFromSeconds(minSeconds, preferred, minSeconds, maxSeconds) !== null) return preferred;
  for (const unit of TIME_UNITS) {
    if (timeValueFromSeconds(minSeconds, unit, minSeconds, maxSeconds) !== null) return unit;
  }
  return null;
}
