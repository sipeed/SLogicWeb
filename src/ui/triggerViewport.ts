// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trigger-anchored viewing for a Loop capture.
 *
 * Two windows, and the distinction is the whole design:
 *
 *   - the data window `D = [T - f*L, T + (1 - f)*L]` carries the loop data. `L` is the
 *     Loop Duration and `f` the pre-trigger fraction, so T is at `f` of D (0% puts T on
 *     D's left edge, 0 s). D's span never changes and D never pans; it advances in local,
 *     phase-aligned steps when new trigger edges arrive.
 *   - the ViewWindow `V = [v0, v1)` is the user's observation window inside D, stored as
 *     offsets from T. Zoom changes its span, pan moves it, Fit resets it to the whole D.
 *     V never moves D, and a roll leaves V's offsets unchanged, so the waveform under V
 *     updates in place with the same phase and does not scroll.
 *
 * The lock is not a viewport state: it means "the current data and trigger configuration
 * still produce trigger edges". It is taken when a match fires, kept by every local
 * roll, and released when no new edge exists for a whole Duration. Fit and view gestures
 * never release it. A digital lock has no page detector to roll: it is one-shot, so the
 * store front drops normally and the view releases when T leaves retention.
 *
 * A local roll (all quantities in samples):
 *
 *   fresh = live - (T + (1 - f) * L)         data beyond the DurationWindow's right edge
 *   a     = suitable local block (<= fresh; whole periods, <= L/4, frame/memory capped)
 *   T'    = latest reported edge in (T, T + a]   (search back from T + a)
 *   step  = T' - T
 *
 * Shift D by `step`: keep its retained prefix and append the first `step` new samples at
 * the tail, so its length stays L. The rest of the new data waits for the next roll. The
 * store's 64-sample drop quantum is internal alignment only; it is never the step, and
 * because V is measured from T, its residue cannot shift the displayed waveform.
 */

import { DROP_FRONT_QUANTUM } from '../data/types.js';

export type CaptureMode = 'single' | 'repeat' | 'loop';

export interface TriggerViewLock {
  /** T's configured fraction of the DurationWindow (0 = left edge, 0 s). */
  fraction: number;
  /** Follow-latest was on when the lock was taken, so a release may return to it. */
  readonly resumeFollow: boolean;
}

/** Loop plus an armed software trigger: the only combination that locks the view. */
export function captureLocksTriggerView(mode: CaptureMode, softwareTrigger: boolean): boolean {
  return mode === 'loop' && softwareTrigger;
}

export type TriggerReconcilePhase = 'off' | 'waiting' | 'triggered' | 'not-found';
export type TriggerReconcileAction = 'none' | 'retune' | 'restart' | 'disable';

export interface TriggerReconcileInput {
  running: boolean;
  stopping: boolean;
  /** Loop is the only mode with a page-side post-match detector. */
  loop: boolean;
  /** The running acquisition was actually started with a software trigger. */
  captureArmed: boolean;
  phase: TriggerReconcilePhase;
  /** The current settings enable the mask and have at least one in-width condition. */
  settingsArmed: boolean;
}

/**
 * What a live trigger-configuration edit means for the running acquisition.
 *
 * The device matcher is one-shot: it can be retuned while waiting, but it cannot be
 * armed, disarmed or retuned after it has matched. Loop has a page-side analog detector
 * after the match; Single/Repeat do not. Turning the trigger off means "no trigger now"
 * and must tear the page detector down so a released view cannot re-lock on a condition
 * the matcher never armed. Turning it on in a capture that started free-running must
 * restart the acquisition, because matching cannot begin mid-stream.
 */
export function reconcileTrigger(input: TriggerReconcileInput): TriggerReconcileAction {
  if (!input.running || input.stopping) return 'none';
  if (input.phase === 'not-found') return 'none';
  if (!input.settingsArmed) {
    if (input.phase === 'waiting') return 'restart';
    if (input.phase === 'triggered') return 'disable';
    return 'none';
  }
  if (!input.captureArmed || input.phase === 'off') return 'restart';
  if (input.phase === 'waiting') return 'retune';
  return input.loop ? 'retune' : 'none';
}

export interface ReanchorInput {
  running: boolean;
  stopping: boolean;
  loop: boolean;
  captureArmed: boolean;
  phase: TriggerReconcilePhase;
  mask: boolean;
  locked: boolean;
  pending: boolean;
}

/**
 * Whether a scanned crossing may take the view lock again. A released Lock can re-lock
 * on a later edge only while the acquisition is still trigger-governed and the live
 * configuration still requests a trigger; a disabled trigger must never re-lock.
 */
export function mayReanchor(input: ReanchorInput): boolean {
  return input.running && !input.stopping && input.loop && input.captureArmed &&
    input.phase === 'triggered' && input.mask && !input.locked && !input.pending;
}

export interface LoopOverviewWindowInput {
  loop: boolean;
  length: number;
  retention: number;
  /** Lock fraction, or null when no lock owns the view. */
  lockFraction: number | null;
  triggerSample: number | null;
}

/**
 * The store-relative extent the overview strip represents.
 *
 * A locked Loop must map the true data window [T - f*L, T + (1-f)*L], not the store
 * front: a local roll floors the front drop to the 64-sample store quantum, so the front
 * can lead the window start by up to 63 samples. Anchoring the strip at 0 would shift
 * the envelope, frame, trigger marker and ticks by that residue after every roll. A
 * negative start is valid: pre-trigger time before retained data is blank.
 */
export function loopOverviewWindow(input: LoopOverviewWindowInput): { start: number; span: number } {
  if (input.loop && input.retention > 0) {
    const span = input.retention;
    if (input.lockFraction !== null && input.triggerSample !== null &&
        Number.isFinite(input.lockFraction) && Number.isFinite(input.triggerSample)) {
      const f = Math.min(1, Math.max(0, input.lockFraction));
      return { start: input.triggerSample - f * span, span };
    }
    return { start: Math.max(0, input.length - span), span };
  }
  return { start: 0, span: Math.max(1, input.length) };
}

/** Pre-trigger percentage as a viewport fraction. Garbage restores to 0 (0 s edge). */
export function triggerViewFraction(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(1, Math.max(0, percent / 100));
}

/**
 * Store-relative position of a trigger the device reported by emitted-stream index.
 * Null when the sample is already behind the store's front: the trigger cannot be
 * pinned to a sample that is no longer retained.
 */
export function relativeTriggerSample(reported: number, droppedSamples: number): number | null {
  if (!Number.isFinite(reported) || !Number.isFinite(droppedSamples)) return null;
  const relative = reported - droppedSamples;
  return relative >= 0 ? relative : null;
}

/**
 * When the trigger sample leaves retention, follow-latest resumes only if the capture
 * is still running and it was following before the lock.
 */
export function resumeTriggerFollow(resumeFollow: boolean, running: boolean): boolean {
  return resumeFollow && running;
}

/**
 * The extra samples a locked Loop store may retain beyond its visible window, so a new
 * crossing can be found before the current anchor is evicted. One window is the natural
 * bound (a window that does not hold one signal period cannot show a stable triggered
 * waveform anyway); 50 ms keeps the update latency imperceptible, and 64 MiB caps the
 * extra memory at very wide samples.
 */
export const TRIGGER_SLACK_BYTES = 64 * 1024 * 1024;
export function triggerSlackSamples(retention: number, samplerate: number, bytesPerSample: number): number {
  if (!(retention > 0) || !(samplerate > 0) || !(bytesPerSample > 0)) return 0;
  const byTime = Math.round(samplerate * 0.05);
  const byMemory = Math.floor(TRIGGER_SLACK_BYTES / bytesPerSample);
  return Math.max(0, Math.min(retention, Math.max(65_536, byTime), byMemory));
}

/** Store limit while a lock may hold a carried excess; the visible window is `retention`. */
export function loopStoreLimit(retention: number, locked: boolean, slack: number): number {
  return retention + (locked ? slack : 0);
}

/**
 * The hold before the view is placed: the matched sample must survive until the
 * coalesced transport block carrying it arrives, and the pre-trigger ring is capped at
 * 64 MiB. The floor is the same 64 MiB budget in samples.
 */
export function loopPendingLimit(retention: number, slack: number, bytesPerSample: number): number {
  const floor = bytesPerSample > 0
    ? Math.floor(TRIGGER_SLACK_BYTES / bytesPerSample) : 0;
  return Math.max(retention + slack, floor);
}

/**
 * Median of the newest (at most 8) inter-crossing intervals. `scratch` is caller-owned
 * and reused so the per-crossing ingest path allocates nothing; the input stays in
 * chronological order for its own push/shift window.
 */
export function medianOfRecent(values: readonly number[], scratch: number[]): number {
  scratch.length = 0;
  for (let i = 0; i < values.length && i < 8; i++) scratch.push(values[i]!);
  for (let i = 1; i < scratch.length; i++) {
    const value = scratch[i]!;
    let j = i - 1;
    while (j >= 0 && scratch[j]! > value) {
      scratch[j + 1] = scratch[j]!;
      j--;
    }
    scratch[j + 1] = value;
  }
  return scratch.length > 0 ? scratch[Math.floor(scratch.length / 2)]! : 0;
}

/**
 * Keep a ViewWindow inside the DurationWindow. Offsets are samples relative to T;
 * the whole window is [-fraction*L, (1-fraction)*L]. A span wider than the window, or a
 * window moved past an edge, is clamped rather than allowed to show time outside D.
 */
export function clampLoopViewOffsets(
  offsetStart: number, offsetEnd: number, fraction: number, windowSamples: number,
): { start: number; end: number } {
  const L = Number.isFinite(windowSamples) && windowSamples > 0 ? windowSamples : 1;
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const lo = -f * L;
  const hi = (1 - f) * L;
  let s = Number.isFinite(offsetStart) ? offsetStart : lo;
  let e = Number.isFinite(offsetEnd) ? offsetEnd : hi;
  if (!(e > s) || e - s > L) return { start: lo, end: hi };
  if (s < lo) { e += lo - s; s = lo; }
  if (e > hi) { s -= e - hi; e = hi; }
  if (s < lo) { e += lo - s; s = lo; }
  return { start: s, end: e };
}

export interface LocalTriggerStepInput {
  /** Absolute sample index of the current trigger edge T. */
  triggerAbs: number;
  /** Absolute index of the retained store front. */
  frontAbs: number;
  /** Absolute live edge (front + retained length). */
  liveAbs: number;
  /** DurationWindow length in samples (the Loop Duration). */
  windowSamples: number;
  /** Pre-trigger fraction, 0..1. */
  fraction: number;
  /** Local step budget in samples (fresh data and local block already applied). */
  blockSamples: number;
  /** Reported crossing positions, absolute and ascending. */
  crossings: readonly number[];
  /** The user's ViewWindow offsets relative to T. */
  viewOffsetStart: number;
  viewOffsetEnd: number;
}

export interface LocalTriggerStep {
  /** The new trigger edge (absolute). */
  anchorAbs: number;
  /** Front samples to drop before placing the new window. */
  drop: number;
  /** T' - T in samples. */
  step: number;
  /** Store-relative T after the drop. */
  triggerSample: number;
  /** Store-relative ViewWindow after the drop. */
  viewStart: number;
  viewEnd: number;
}

/**
 * Plan one local, phase-aligned roll. Returns null unless a real edge exists in
 * `(T, T + block]` and a full window after it is covered by retained/new data.
 *
 * The latest edge in the budget is chosen (searching back from T + a): it keeps the
 * window as far forward as the local block allows while reusing as much of the retained
 * window as possible. The remaining new data stays for the next step.
 */
export function planLocalTriggerStep(input: LocalTriggerStepInput): LocalTriggerStep | null {
  const L = input.windowSamples;
  if (!(L > 0) || !(input.blockSamples > 0)) return null;
  if (!Number.isFinite(input.triggerAbs) || !Number.isFinite(input.frontAbs) ||
      !Number.isFinite(input.liveAbs)) return null;
  const f = Number.isFinite(input.fraction) ? Math.min(1, Math.max(0, input.fraction)) : 0;
  const fresh = input.liveAbs - (input.triggerAbs + (1 - f) * L);
  if (!(fresh > 0)) return null;
  const budget = Math.min(input.blockSamples, fresh);
  if (!(budget > 0)) return null;
  const to = input.triggerAbs + budget;
  let anchor: number | null = null;
  for (const c of input.crossings) {
    if (!Number.isFinite(c)) continue;
    if (c > input.triggerAbs && c <= to) anchor = c;
    else if (c > to) break;
  }
  if (anchor === null) return null;
  const step = anchor - input.triggerAbs;
  const windowStartAbs = anchor - f * L;
  const desired = windowStartAbs - input.frontAbs;
  const drop = desired > 0 ? Math.floor(desired / DROP_FRONT_QUANTUM) * DROP_FRONT_QUANTUM : 0;
  const dropped = input.frontAbs + drop;
  const triggerSample = anchor - dropped;
  return {
    anchorAbs: anchor,
    drop,
    step,
    triggerSample,
    viewStart: triggerSample + input.viewOffsetStart,
    viewEnd: triggerSample + input.viewOffsetEnd,
  };
}
