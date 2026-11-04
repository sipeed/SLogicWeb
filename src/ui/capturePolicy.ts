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

/**
 * Keep one duration across modes and rates, as HSync does: "changing the rate, the
 * channels or the mode keeps the capture about as long" (DESIGN.md §4).
 *
 * Single and Repeat store the duration in seconds; Loop stores its rolling window in
 * whole samples. So entering Loop takes the duration the other modes were using (unless
 * the caller set a new window in the same edit), leaving Loop takes the window's
 * duration, and a rate change while looping rescales the window so its duration holds.
 * In Loop mode `seconds` mirrors the window, so the mode switch reads one value either
 * way. The window's memory ceiling can shorten the carried duration; that limit is
 * honest and shown in the panel.
 */
export function carryCaptureDuration(
  previous: CaptureSettings, next: CaptureSettings,
): CaptureSettings {
  if (next.mode === 'loop') {
    let loopSamples = next.loopSamples;
    if (previous.mode !== 'loop') {
      // A caller that changed the window explicitly keeps it; a bare mode switch carries
      // the duration the other modes were using.
      if (next.loopSamples === previous.loopSamples) {
        loopSamples = clampLoopSamples(Math.round(previous.seconds * next.samplerate), next.channels);
      }
    } else if (next.samplerate !== previous.samplerate && next.loopSamples === previous.loopSamples) {
      loopSamples = clampLoopSamples(
        Math.round(previous.loopSamples / previous.samplerate * next.samplerate), next.channels);
    }
    loopSamples = clampLoopSamples(loopSamples, next.channels);
    return {
      ...next,
      loopSamples,
      // The window may be shorter than Single's 1 ms control minimum; this field carries
      // the exact duration across a switch, and the clamp happens when leaving Loop.
      seconds: loopSamples / next.samplerate,
    };
  }
  if (previous.mode === 'loop') {
    return {
      ...next,
      seconds: clampCaptureSeconds(previous.loopSamples / previous.samplerate, next.samplerate),
    };
  }
  return next;
}
