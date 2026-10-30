// SPDX-License-Identifier: GPL-3.0-or-later

import { MAX_SAMPLES } from './captureIO.js';
import {
  maxTimeValue, minTimeValue, secondsFromTimeValue, timeValueFromSeconds,
  type TimeUnit,
} from './timeUnits.js';

export const MIN_CAPTURE_SECONDS = 0.001;
export const DEFAULT_CAPTURE_SECONDS = 1;
export const REPEAT_INTERVAL_SECONDS = { min: 0.1, max: 10, default: 1 } as const;

export function maxCaptureSeconds(samplerate: number): number {
  if (!Number.isFinite(samplerate) || samplerate <= 0) return 0;
  return (MAX_SAMPLES - 1) / samplerate;
}

export function clampCaptureSeconds(seconds: number, samplerate: number): number {
  const max = maxCaptureSeconds(samplerate);
  if (Number.isNaN(seconds)) return Math.min(DEFAULT_CAPTURE_SECONDS, max);
  if (seconds === Number.POSITIVE_INFINITY) return max;
  if (!Number.isFinite(seconds)) return MIN_CAPTURE_SECONDS;
  return Math.min(max, Math.max(MIN_CAPTURE_SECONDS, seconds));
}

export function clampRepeatIntervalSeconds(seconds: number): number {
  if (Number.isNaN(seconds)) return REPEAT_INTERVAL_SECONDS.default;
  if (seconds === Number.POSITIVE_INFINITY) return REPEAT_INTERVAL_SECONDS.max;
  if (!Number.isFinite(seconds)) return REPEAT_INTERVAL_SECONDS.min;
  return Math.min(REPEAT_INTERVAL_SECONDS.max, Math.max(REPEAT_INTERVAL_SECONDS.min, seconds));
}

export function minCaptureTimeValue(unit: TimeUnit): number {
  return minTimeValue(MIN_CAPTURE_SECONDS, unit);
}

export function maxCaptureTimeValue(samplerate: number, unit: TimeUnit): number {
  return maxTimeValue(maxCaptureSeconds(samplerate), unit);
}

export function captureTimeFromSeconds(
  seconds: number, unit: TimeUnit, samplerate: number,
): number | null {
  return timeValueFromSeconds(seconds, unit, MIN_CAPTURE_SECONDS, maxCaptureSeconds(samplerate));
}

export function captureSecondsFromTime(
  value: number, unit: TimeUnit, samplerate: number,
): number | null {
  return secondsFromTimeValue(value, unit, MIN_CAPTURE_SECONDS, maxCaptureSeconds(samplerate));
}

export function repeatIntervalTimeFromSeconds(seconds: number, unit: TimeUnit): number | null {
  return timeValueFromSeconds(
    seconds, unit, REPEAT_INTERVAL_SECONDS.min, REPEAT_INTERVAL_SECONDS.max,
  );
}

export function repeatIntervalSecondsFromTime(value: number, unit: TimeUnit): number | null {
  return secondsFromTimeValue(value, unit, REPEAT_INTERVAL_SECONDS.min, REPEAT_INTERVAL_SECONDS.max);
}
