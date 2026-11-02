// SPDX-License-Identifier: GPL-3.0-or-later

import {
  REPEAT_INTERVAL_SECONDS, maxCaptureTimeValue, repeatIntervalTimeFromSeconds,
} from './captureTime.js';
import { maxLoopTimeValue } from './loopTime.js';
import { isPositiveInteger, type TimeUnit } from './timeUnits.js';

export const SLIDER_FINITE_MAX = 1000;
export const SLIDER_UNLIMITED_VALUE = 1120;
export const SLIDER_UNLIMITED_TRACK_START = 0.905;

export interface TimeSliderTrackGeometry {
  max: number;
  finiteFraction: number;
  unlimitedStartFraction: number | null;
}

export interface AcquisitionTimeDigitBasis {
  capture: number;
  loop: number;
  repeatInterval: number;
  digits: number;
}

function validBounds(min: number, max: number): boolean {
  return isPositiveInteger(min) && isPositiveInteger(max) && max >= min;
}

export function timeSliderTrackGeometry(unlimited = false): TimeSliderTrackGeometry {
  return {
    max: unlimited ? SLIDER_UNLIMITED_VALUE : SLIDER_FINITE_MAX,
    finiteFraction: unlimited ? SLIDER_FINITE_MAX / SLIDER_UNLIMITED_VALUE : 1,
    unlimitedStartFraction: unlimited ? SLIDER_UNLIMITED_TRACK_START : null,
  };
}

export function timeValueToSlider(value: number, min: number, max: number): number | null {
  if (!validBounds(min, max) || !isPositiveInteger(value)) return null;
  if (max === min) return 0;
  const clamped = Math.min(max, Math.max(min, value));
  return Math.round((clamped - min) / (max - min) * SLIDER_FINITE_MAX);
}

export function timeValueFromSlider(position: number, min: number, max: number): number | null {
  if (!validBounds(min, max) || !Number.isFinite(position) || !Number.isInteger(position)) return null;
  if (max === min) return min;
  const clamped = Math.min(SLIDER_FINITE_MAX, Math.max(0, position));
  return Math.round(min + clamped / SLIDER_FINITE_MAX * (max - min));
}

export function isUnlimitedTimeSlider(position: number, unlimited: boolean): boolean {
  return unlimited && position === SLIDER_UNLIMITED_VALUE;
}

export function timeSliderFiniteMaxLabel(max: number, unit: TimeUnit): string {
  return isPositiveInteger(max) ? `${max} ${unit}` : '';
}

export function timeSliderAriaValueText(
  position: number,
  min: number,
  max: number,
  unit: TimeUnit,
  unlimitedLabel?: string,
): string {
  if (unlimitedLabel !== undefined && isUnlimitedTimeSlider(position, true)) return unlimitedLabel;
  const value = timeValueFromSlider(position, min, max);
  return value === null ? '' : `${value} ${unit}`;
}

export function acquisitionTimeDigitBasis(): AcquisitionTimeDigitBasis {
  const capture = maxCaptureTimeValue(5e6, 'us');
  const loop = maxLoopTimeValue(4, 5e6, 'us');
  const repeatInterval = repeatIntervalTimeFromSeconds(REPEAT_INTERVAL_SECONDS.max, 'us') ?? 0;
  const digits = Math.max(
    String(capture).length,
    String(loop).length,
    String(repeatInterval).length,
  );
  return { capture, loop, repeatInterval, digits };
}
