// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Whether the effective capture rate runs above what the profile measured the USB link
 * to sustain at this width (`RateTier.recommendedHz`, delivered per width as
 * `Device.recommendedSamplerateHz`). Pure and import-free; it names no width or model,
 * all numbers come from the caller.
 *
 * At-risk combination (documented in docs/DESIGN.md §9): an active analog group needs an
 * ADC-legal rate - a divisor of the 800 MHz PLL from 100 MS/s up - so on a 5 Gbit/s link
 * a 32-channel capture with an analog group cannot reach its 50 MS/s recommendation and
 * runs at 100 MS/s (400 MB/s, which aborted on hardware). The UI does not change the
 * user's channel selection to avoid it; it says so. Reducing the width (16 CH) keeps an
 * analog capture inside the recommendation.
 */

export type RateAdviceKey = 'capturePanel.rateAboveAdvised' | 'capturePanel.rateAnalogForced';

export interface RateAdviceInput {
  /** Effective (already clamped) settings. */
  channels: number;
  samplerate: number;
  /** Per-width sustainable rate; a width without an entry has no measured limit. */
  recommended: Readonly<Record<number, number>>;
  /** The lowest rate the active analog group allows, or undefined with no analog group. */
  analogMinHz?: number | undefined;
}

export interface RateAdvice {
  key: RateAdviceKey;
  advised: number;
  /** Set for the analog-forced case: the ADC's minimum rate. */
  analogMinHz?: number | undefined;
}

export function rateAdvice(input: RateAdviceInput): RateAdvice | null {
  const advised = input.recommended[input.channels];
  if (advised === undefined || !(input.samplerate > advised)) return null;
  if (input.analogMinHz !== undefined && input.analogMinHz > advised &&
      input.samplerate <= input.analogMinHz) {
    return { key: 'capturePanel.rateAnalogForced', advised, analogMinHz: input.analogMinHz };
  }
  return { key: 'capturePanel.rateAboveAdvised', advised };
}
