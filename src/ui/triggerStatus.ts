// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which trigger-state note the device panel should show.
 *
 * Pure precedence, separate from the DOM, so the waiting / lost / locked / triggered /
 * miss order is testable without a panel. The Repeat miss-retry note is not part of this
 * state: it belongs to an earlier Interval and is shown alongside whatever this wave is
 * doing (see `fillTriggerStatus`).
 */

export type TriggerNoteMode = 'single' | 'repeat' | 'loop';
export type TriggerNoteState = 'off' | 'waiting' | 'triggered' | 'not-found';

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
}

export type TriggerNote =
  | 'waiting'
  | 'viewLost'
  | 'loopAnalog'
  | 'loopDigital'
  | 'loopReleased'
  | 'loopReleasedDigital'
  | 'triggered'
  | 'notFound'
  | null;

/** The single applicable note, or null when the trigger section should stay quiet. */
export function triggerStatusNote(v: TriggerNoteInput): TriggerNote {
  if (v.triggerState === 'waiting') return 'waiting';
  if (v.triggerState === 'not-found') return 'notFound';
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
  return {
    pending: v.running && !v.stopping && v.triggerState === 'triggered' &&
      !liveAnalog && !releasedOneShot,
    arming: v.running && v.settingsArmed && !v.triggerArmed && !v.triggerAutoDisarmed,
    armedSummary: v.settingsArmed && !v.triggerAutoDisarmed &&
      (!v.running || v.triggerState === 'waiting'),
    memoryReleased: v.running && v.triggerAutoDisarmed,
  };
}
