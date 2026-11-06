// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The rate an analog group takes away, and gives back.
 *
 * An active ADC group needs a sample clock divided from the module's 800 MHz PLL
 * (100 MS/s and up, `analogSamplerates`), so turning the FIRST group on moves a pending
 * 10 MS/s capture to 100 MS/s. Turning the LAST group off gives the user's rate back
 * (re-clamped by the normal settings clamp), unless the user picked another rate in
 * between - then their pick stands and the memory is forgotten. Every rate the app
 * moves on the user's behalf is announced as a panel note.
 *
 * Pure: no DOM, no device. The app owns the memory and the clamp.
 */

/** Remembered when the first analog group was enabled. */
export interface AnalogRateMemory {
  /** The pending rate the user had before the analog clamp. */
  pending: number;
  /** The rate the clamp moved it to; a different current rate means the user chose. */
  applied: number;
}

export type RateChangeReason = 'analog' | 'restored' | 'clamped';

export interface RateChangeNote {
  from: number;
  to: number;
  reason: RateChangeReason;
}

export interface AnalogToggleInput {
  wasAnalog: boolean;
  isAnalog: boolean;
  /** The pending rate before the toggle. */
  rateBefore: number;
}

/**
 * Before the clamp: the rate to clamp from. Disabling the last group with an untouched
 * memory restores the remembered rate; everything else keeps the current one. The
 * memory is cleared once the last group is off either way.
 */
export function analogRateBeforeClamp(
  memory: AnalogRateMemory | null, input: AnalogToggleInput,
): { rate: number; memory: AnalogRateMemory | null; restoring: boolean } {
  if (input.wasAnalog && !input.isAnalog) {
    const restoring = memory !== null && memory.applied === input.rateBefore &&
      memory.pending !== input.rateBefore;
    return { rate: restoring ? memory!.pending : input.rateBefore, memory: null, restoring };
  }
  return { rate: input.rateBefore, memory, restoring: false };
}

/**
 * After the clamp: remember the pre-analog rate when the first group came on, and the
 * note for a rate that moved. `rateAfter` is the clamped result.
 */
export function analogRateAfterClamp(
  memory: AnalogRateMemory | null, input: AnalogToggleInput & { rateAfter: number; restoring: boolean },
): { memory: AnalogRateMemory | null; note: RateChangeNote | null } {
  let next = memory;
  if (!input.wasAnalog && input.isAnalog) {
    next = { pending: input.rateBefore, applied: input.rateAfter };
  } else if (input.isAnalog && next !== null && input.rateAfter !== next.applied) {
    // Another group (or a width change) moved the analog rate again: that is still the
    // rate the app chose, so a later restore keeps tracking it.
    next = { ...next, applied: input.rateAfter };
  }
  const note: RateChangeNote | null = input.rateAfter === input.rateBefore ? null : {
    from: input.rateBefore,
    to: input.rateAfter,
    reason: input.restoring ? 'restored' : input.isAnalog ? 'analog' : 'clamped',
  };
  return { memory: next, note };
}

/** A rate the user picks supersedes the memory: the next disable keeps their pick. */
export function analogRateUserEdit(
  memory: AnalogRateMemory | null, rate: number,
): AnalogRateMemory | null {
  return memory !== null && rate !== memory.applied ? null : memory;
}

export function rateChangeMessageKey(note: RateChangeNote):
  'capturePanel.rateRaisedAnalog' | 'capturePanel.rateLoweredAnalog' |
  'capturePanel.rateRestoredAnalog' | 'capturePanel.rateClamped' {
  if (note.reason === 'restored') return 'capturePanel.rateRestoredAnalog';
  if (note.reason === 'clamped') return 'capturePanel.rateClamped';
  return note.to > note.from ? 'capturePanel.rateRaisedAnalog' : 'capturePanel.rateLoweredAnalog';
}
