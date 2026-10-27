// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChannelCount } from '../types.js';
import { clampLoopSamples, maxLoopSamples } from './state.js';

export const LOOP_TIME_UNITS = ['us', 'ms', 's'] as const;
export type LoopTimeUnit = (typeof LOOP_TIME_UNITS)[number];
export const DEFAULT_LOOP_TIME_UNIT: LoopTimeUnit = 'ms';

const UNIT_SECONDS: Record<LoopTimeUnit, number> = { us: 1e-6, ms: 1e-3, s: 1 };

export function isLoopTimeUnit(value: string): value is LoopTimeUnit {
  return (LOOP_TIME_UNITS as readonly string[]).includes(value);
}

function validSamplerate(samplerate: number): boolean {
  return Number.isFinite(samplerate) && samplerate > 0;
}

export function maxLoopTimeValue(channels: ChannelCount, samplerate: number, unit: LoopTimeUnit): number {
  if (!isLoopTimeUnit(unit) || !validSamplerate(samplerate)) return 0;
  return Math.floor(maxLoopSamples(channels) / samplerate / UNIT_SECONDS[unit]);
}

export function loopSamplesFromTime(
  value: number, unit: LoopTimeUnit, samplerate: number, channels: ChannelCount,
): number | null {
  if (!isLoopTimeUnit(unit) || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0 ||
    !validSamplerate(samplerate)) return null;
  return clampLoopSamples(value * UNIT_SECONDS[unit] * samplerate, channels);
}

export function loopTimeFromSamples(
  samples: number, unit: LoopTimeUnit, samplerate: number, channels: ChannelCount,
): number | null {
  if (!Number.isFinite(samples) || samples <= 0) return null;
  const max = maxLoopTimeValue(channels, samplerate, unit);
  if (max < 1) return null;
  return Math.min(max, Math.max(1, Math.round(samples / samplerate / UNIT_SECONDS[unit])));
}
