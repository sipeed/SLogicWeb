// SPDX-License-Identifier: GPL-3.0-or-later

import { MAX_SAMPLES } from './captureIO.js';
import { clampCaptureSeconds } from './captureTime.js';
import { clampLoopSamples, type CaptureSettings } from './state.js';

export function capturePostTriggerSamples(settings: CaptureSettings): number {
  if (settings.mode === 'loop') return clampLoopSamples(settings.loopSamples, settings.channels);
  if (settings.mode === 'single' && settings.singleUnlimited) return MAX_SAMPLES - 1;
  const seconds = clampCaptureSeconds(settings.seconds, settings.samplerate);
  return Math.min(MAX_SAMPLES - 1, Math.max(1, Math.round(seconds * settings.samplerate)));
}
