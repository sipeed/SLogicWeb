// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which trigger-state note the device panel should show.
 *
 * Pure precedence, separate from the DOM, so the waiting / lost / locked / triggered /
 * miss order is testable without a panel. The Repeat miss-retry note is not part of this
 * state: it belongs to an earlier Interval and is shown alongside whatever this wave is
 * doing (see `fillTriggerStatus`).
 */

import type { CaptureLabel } from './state.js';
import type { TriggerReconcilePhase } from './triggerViewport.js';

export type TriggerNoteMode = 'single' | 'repeat' | 'loop';
/**
 * The app's trigger state for the capture in flight (or last finished).
 *
 * `forced` is the analog Auto sweep (ARCHITECTURE "Analog triggers sweep in Auto, digital
 * ones in Normal"): no qualified crossing was decided within one capture window, so the
 * matcher captured the window at the current sample anyway. The data is real but
 * untriggered: there is no T, and it is never a miss ("no capture"/not-found).
 */
export type TriggerNoteState = 'off' | 'waiting' | 'triggered' | 'forced' | 'not-found';

export interface TriggerNoteInput {
  mode: TriggerNoteMode;
  running: boolean;
  triggerState: TriggerNoteState;
  /** A loop trigger matched but T was evicted before the view could lock. */
  triggerViewLost: boolean;
  /** The match message arrived but the block carrying T has not been placed yet. */
  triggerViewPending: boolean;
  /** A loop trigger currently owns the viewport. */
  triggerLocked: boolean;
  /** The loop lock rolls on scanned analog crossings (not a one-shot digital lock). */
  triggerAnalogRolling: boolean;
  /** The matcher is still in its pre-fill holdoff (see `preTriggerFill`); null/absent
   * once the window has filled or when there is no holdoff. */
  triggerPreFill?: PreTriggerFill | null;
}

export type TriggerNote =
  | 'preFilling'
  | 'waiting'
  | 'viewLost'
  | 'loopAnalog'
  | 'loopDigital'
  | 'loopReleased'
  | 'loopReleasedDigital'
  | 'triggered'
  | 'autoForced'
  | 'notFound'
  | null;

/** The single applicable note, or null when the trigger section should stay quiet. */
export function triggerStatusNote(v: TriggerNoteInput): TriggerNote {
  if (v.triggerState === 'waiting') return v.triggerPreFill ? 'preFilling' : 'waiting';
  if (v.triggerState === 'not-found') return 'notFound';
  // Shown after the capture ended too: the plot holds untriggered data and must say so.
  if (v.triggerState === 'forced') return 'autoForced';
  if (v.triggerState !== 'triggered' || !v.running) return null;
  if (v.triggerViewLost) return 'viewLost';
  if (v.mode === 'loop') {
    if (v.triggerLocked) return v.triggerAnalogRolling ? 'loopAnalog' : 'loopDigital';
    if (v.triggerViewPending) return null;
    // Unlocked with a live scanner: the quiet-window release is waiting for an edge to
    // re-lock. Without one, a digital one-shot lock was evicted and cannot re-arm.
    return v.triggerAnalogRolling ? 'loopReleased' : 'loopReleasedDigital';
  }
  return 'triggered';
}

export interface TriggerPanelNoteInput {
  running: boolean;
  stopping: boolean;
  mode: TriggerNoteMode;
  triggerState: TriggerNoteState;
  /** The live settings request a trigger and have at least one effective condition. */
  settingsArmed: boolean;
  /** The running acquisition actually armed the device matcher. */
  triggerArmed: boolean;
  triggerLocked: boolean;
  triggerAnalogRolling: boolean;
  triggerViewPending: boolean;
  /** The trigger was disarmed by the Loop store's hard memory cap. */
  triggerAutoDisarmed: boolean;
  /** Configuring a condition auto-enabled the trigger during this free-running capture;
   * it applies from the next acquisition (see `autoArmDefersToNextCapture`). */
  triggerArmDeferred?: boolean;
}

export interface TriggerPanelNotes {
  /** Show "edits apply to the next acquisition". */
  pending: boolean;
  /** Show "restarting to arm the matcher". */
  arming: boolean;
  /** Show the "Armed: ..." summary. */
  armedSummary: boolean;
  /** Show "released to keep the loop store bounded". */
  memoryReleased: boolean;
  /** Show "the trigger was turned on by configuring a condition; it arms the next
   * capture" (instead of `arming`: the running capture is not restarted). */
  armNext: boolean;
}

/**
 * Which informational notes the trigger panel should render.
 *
 * A matched one-shot is no longer "armed": the summary and the pending note must not
 * contradict the released status. A Loop analog detector is live after the match, so its
 * edits are not pending. A capture that was restarted to arm (or auto-disarmed by the
 * memory cap) must not claim an arming action that is not running.
 */
export function triggerPanelNotes(v: TriggerPanelNoteInput): TriggerPanelNotes {
  const liveAnalog = v.mode === 'loop' && v.triggerAnalogRolling;
  const releasedOneShot = v.mode === 'loop' && v.running && v.triggerState === 'triggered' &&
    !v.triggerLocked && !v.triggerAnalogRolling && !v.triggerViewPending;
  // A deferred auto-arm only exists on a running capture that did not arm a matcher.
  const deferred = v.triggerArmDeferred === true && v.running && !v.stopping &&
    !v.triggerArmed;
  return {
    // A forced (Auto) sweep has finished searching just like a match: edits apply next.
    pending: v.running && !v.stopping &&
      (v.triggerState === 'triggered' || v.triggerState === 'forced') &&
      !liveAnalog && !releasedOneShot,
    arming: v.running && v.settingsArmed && !v.triggerArmed && !v.triggerAutoDisarmed &&
      !deferred,
    armedSummary: v.settingsArmed && !v.triggerAutoDisarmed &&
      (!v.running || v.triggerState === 'waiting'),
    memoryReleased: v.running && v.triggerAutoDisarmed,
    armNext: deferred && v.settingsArmed,
  };
}

export interface PreTriggerObtainedInput {
  mode: TriggerNoteMode;
  triggerState: TriggerNoteState;
  /** The acquisition's effective pre-trigger window in samples; null when none armed. */
  configuredSamples: number | null;
  /** Store-relative T, i.e. the pre-trigger samples the capture actually holds. */
  triggerSampleIndex: number | null;
}

/**
 * Pre-trigger samples a triggered Single/Repeat capture actually holds, when that is less
 * than configured; null otherwise.
 *
 * The host matcher's pre-fill holdoff normally makes T equal the configured window, so
 * this is a defensive readout for paths that cannot hold off (a future device-executed
 * trigger, or an executor whose stream started late). Loop is excluded: its retention
 * drops the front by design and T's position is governed by the Loop window.
 */
export function preTriggerShortfall(v: PreTriggerObtainedInput): number | null {
  if (v.mode === 'loop' || v.triggerState !== 'triggered') return null;
  if (v.configuredSamples === null || v.triggerSampleIndex === null) return null;
  if (!Number.isFinite(v.triggerSampleIndex) || !Number.isFinite(v.configuredSamples)) return null;
  const obtained = Math.max(0, Math.floor(v.triggerSampleIndex));
  return obtained < v.configuredSamples ? obtained : null;
}

export interface PreTriggerFill {
  /** Stream time observed since the matcher armed, seconds (0 <= elapsed < total). */
  elapsedSec: number;
  /** The effective (already capped) pre-trigger window, seconds. */
  totalSec: number;
}

export interface PreTriggerFillInput {
  triggerState: TriggerNoteState;
  /** The running acquisition armed a host-side matcher. */
  triggerArmed: boolean;
  /** The acquisition's effective pre-trigger samples (after the percentage, post-budget
   * and prefix-byte caps), exactly as sent to the matcher. */
  preTriggerSamples: number;
  /** The acquisition's sample rate, Hz. */
  samplerate: number;
  /** Wall time since the device stream was armed, ms; null before it is armed. */
  streamMs: number | null;
}

/**
 * Progress of the matcher's pre-fill holdoff, or null when it is over (or there is none).
 *
 * After arming, the matcher ignores every match until `preTriggerSamples` complete samples
 * have been observed (ARCHITECTURE §5.1 "Pre-fill holdoff"). With a long window at a low
 * rate that lasts seconds, during which a trigger cannot fire, so the panel says so
 * instead of the plain "waiting" note.
 *
 * Assumption: the page receives nothing from the matcher while it waits, so the observed
 * count is estimated from wall time since the stream was armed, at the capture rate. A
 * real device streams at that rate or overflows; the error is the RUN-to-first-byte
 * latency and transfer queueing, so the note can end slightly before the matcher's own
 * holdoff does (never noticeably later). A retune keeps the remaining holdoff, so it does
 * not restart this clock; each Single/Repeat wave and each restart is a new acquisition
 * with a new clock. Loop holds off only its first match and is only `waiting` before it,
 * so the same rule covers it. The transport does not restart the matcher's holdoff on a
 * dropout (it does not call `noteGap`), so neither does this estimate.
 */
export function preTriggerFill(v: PreTriggerFillInput): PreTriggerFill | null {
  if (!v.triggerArmed || v.triggerState !== 'waiting') return null;
  if (v.streamMs === null || !Number.isFinite(v.streamMs)) return null;
  if (!(v.samplerate > 0) || !(v.preTriggerSamples > 0)) return null;
  const totalSec = v.preTriggerSamples / v.samplerate;
  const elapsedSec = Math.max(0, v.streamMs / 1000);
  return elapsedSec < totalSec ? { elapsedSec, totalSec } : null;
}

export interface AutoArmInput {
  /** The edit turns the global trigger on (`edgeTriggerAutoArms`/`analogTriggerAutoArms`). */
  autoArms: boolean;
  running: boolean;
  stopping: boolean;
  /** The running acquisition armed a matcher (it cannot have while the mask was off). */
  captureArmed: boolean;
}

/**
 * Whether an auto-arm (configuring the first condition while the global trigger is off)
 * applies to the next acquisition instead of restarting the running one.
 *
 * An explicit enable while a capture free-runs restarts it to arm, with the visible
 * "restarting" note. An auto-arm is a side effect of configuring a condition; restarting
 * there would discard the running capture's data behind the user's back (DESIGN §8: a
 * restart is never a hidden side effect). So the running capture keeps free-running, the
 * panel says the trigger applies from the next capture, and the existing Stop → Capture
 * path arms it now. Repeat picks it up at its next interval. While stopping there is
 * nothing to defer: the next start reads the enabled mask.
 */
export function autoArmDefersToNextCapture(v: AutoArmInput): boolean {
  return v.autoArms && v.running && !v.stopping && !v.captureArmed;
}

export interface AutoSweepInput {
  mode: TriggerNoteMode;
  /** The armed conditions are analog only (no digital condition in the plan). */
  analogSource: boolean;
  /** The capture window in samples: the store budget `pre + post`. */
  captureWindowSamples: number;
}

/**
 * The matcher's `autoAfterSamples` for this acquisition, or undefined for Normal.
 *
 * An analog trigger sweeps in Auto in Single and Repeat: when no qualified crossing is
 * decided within one capture window (`pre + post` samples counted after the pre-fill
 * holdoff) the matcher forces the capture, like an oscilloscope's Auto sweep. Loop does
 * the same with its loop window: the stream starts untriggered and locks on the first
 * real crossing after it (without it Loop delivered nothing until a crossing, so an
 * unreachable level looked like a hung capture). A digital condition stays Normal
 * (Single waits; Repeat misses and retries; Loop waits).
 *
 * Assumption: a plan that mixes digital and analog conditions (P1 `profile.trigger.mixed`)
 * stays Normal, because its digital condition must still be waited for; P0 never mixes.
 */
export function triggerAutoAfterSamples(v: AutoSweepInput): number | undefined {
  if (!v.analogSource) return undefined;
  const n = Math.floor(v.captureWindowSamples);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The reconcile/re-anchor phase for an app trigger state. A forced (Auto) sweep is past
 * its search exactly like a match, so edits reconcile as they would after `triggered`
 * (pending for the next acquisition, or a disable when the trigger is turned off).
 */
export function triggerReconcilePhase(state: TriggerNoteState): TriggerReconcilePhase {
  return state === 'forced' ? 'triggered' : state;
}

/**
 * The title a finished device capture gets. A not-found Single recorded nothing; a forced
 * (Auto) sweep holds real untriggered data and says so instead of looking triggered.
 */
export function finishedCaptureLabel(
  state: TriggerNoteState, samples: number, rate: number,
): CaptureLabel {
  if (state === 'not-found') return { kind: 'stoppedNoTrigger', samples };
  const seconds = rate > 0 ? samples / rate : 0;
  if (state === 'forced') return { kind: 'autoForced', samples, rate, seconds };
  return { kind: 'live', samples, rate, seconds };
}
