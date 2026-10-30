// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChannelCount } from '../types.js';
import { clampLoopSamples, maxLoopSamples } from './state.js';
import {
  DEFAULT_TIME_UNIT, TIME_UNITS, isTimeUnit, timeUnitSeconds, type TimeUnit,
} from './timeUnits.js';

export const LOOP_TIME_UNITS = TIME_UNITS;
export type LoopTimeUnit = TimeUnit;
export const DEFAULT_LOOP_TIME_UNIT: LoopTimeUnit = DEFAULT_TIME_UNIT;

export function isLoopTimeUnit(value: string): value is LoopTimeUnit {
  return isTimeUnit(value);
}

function validSamplerate(samplerate: number): boolean {
  return Number.isFinite(samplerate) && samplerate > 0;
}

export function maxLoopTimeValue(channels: ChannelCount, samplerate: number, unit: LoopTimeUnit): number {
  if (!isLoopTimeUnit(unit) || !validSamplerate(samplerate)) return 0;
  return Math.floor(maxLoopSamples(channels) / samplerate / timeUnitSeconds(unit));
}

export function loopSamplesFromTime(
  value: number, unit: LoopTimeUnit, samplerate: number, channels: ChannelCount,
): number | null {
  if (!isLoopTimeUnit(unit) || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0 ||
    !validSamplerate(samplerate)) return null;
  return clampLoopSamples(value * timeUnitSeconds(unit) * samplerate, channels);
}

export function loopTimeFromSamples(
  samples: number, unit: LoopTimeUnit, samplerate: number, channels: ChannelCount,
): number | null {
  if (!Number.isFinite(samples) || samples <= 0) return null;
  const max = maxLoopTimeValue(channels, samplerate, unit);
  if (max < 1) return null;
  return Math.min(max, Math.max(1, Math.round(samples / samplerate / timeUnitSeconds(unit))));
}
