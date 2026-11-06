// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Session and view-policy core for the capture pipeline.
 *
 * A **session** is one Capture -> Stop run. What happens inside it depends on the mode:
 *
 *   - Single: 1 session = 1 sweep.
 *   - Repeat: 1 session = N sweeps, one per interval; every RUN->STOP boundary starts a
 *     new sweep.
 *   - Loop:   1 session = 1 unbounded sweep. Loop has no sweep boundary at all; the
 *     device keeps running until the user stops it.
 *
 * A **sweep** is one device RUN -> STOP acquisition. Each sweep snapshots the capture
 * settings at its start. The app owns that snapshot: a Repeat edit therefore applies to
 * the *next* sweep, while starting a new session reads the current settings. This module
 * deliberately does not own settings; it owns the view policy that survives (or does not
 * survive) those boundaries.
 *
 * ## Time and the axis origin
 *
 * All intervals here are in seconds relative to the sweep's **display origin**:
 *
 *   - when the sweep has a trigger sample, the origin is T (the trigger sample), so
 *     pre-trigger data has negative time and T is always exactly 0 s;
 *   - otherwise the origin is the sweep start.
 *
 * The conversion helpers at the bottom turn those T-relative seconds into store/sample
 * indices at the sweep's samplerate. They are pure and never look at a store.
 *
 * ## View policy states
 *
 *   - `follow`: FollowLive. The viewport's right edge is pinned to the newest sample.
 *     This is the default for every new session and therefore for every mode.
 *   - `fixed`: the user panned or zoomed. The interval is stored relative to the display
 *     origin, so it means the same physical time across Repeat sweeps with different
 *     origins. Fixed is *not* persisted across sessions.
 *   - `triggerLocked`: a Loop with an armed software trigger that matched. T is pinned at
 *     `fraction` of the viewport (the configured pre-trigger fraction: 0 puts T on the
 *     left edge, 0.1 leaves 10 % of the view before T) and the sweep's retained span sets
 *     the window width. A Loop without a match never enters this state.
 *
 * Transitions:
 *
 *   - A new session always resets to `follow`.
 *   - A user pan/zoom replaces any policy with `fixed`. Once a user has taken the view,
 *     a later Loop trigger match does not steal it; `fixed` wins while it still fits.
 *   - A Loop trigger match turns `follow` into `triggerLocked`. Single and Repeat never
 *     lock the view on T; they still use T as the axis origin when a trigger exists.
 *   - Resolution (`resolveView` / `resolveSessionView`) is the only place that rejects a
 *     stale policy. A `fixed` interval that no longer fits the sweep's retained range
 *     falls back to the mode default: `follow` for Single/Repeat, or `triggerLocked` for
 *     a Loop whose trigger is active (otherwise `follow`). It never silently clamps/fits
 *     the old interval ("no automatic Fit"), and the returned policy should be adopted
 *     as the session's new policy.
 *
 * `retained` in this module means the sweep's retained T-relative range, including any
 * negative pre-trigger part. It is the range against which a `fixed` view must fit. Pass
 * the sweep's final/expected range, not a partially-filled live store: a Repeat view
 * that will be covered later in the sweep is not stale yet.
 *
 * The module is pure: no DOM, no store, no settings import, no dependency on app.ts.
 */

export type CaptureMode = 'single' | 'repeat' | 'loop';

/** How many device sweeps a session owns. Loop has no boundary, hence continuous. */
export type SessionSweepPattern = 'one-sweep' | 'multi-sweep' | 'continuous';

/** T-relative seconds. Pre-trigger time is negative; T itself is 0. */
export interface SecondsRange {
  startSec: number;
  endSec: number;
}

/** Store/sample indices after conversion at a samplerate. */
export interface SampleRange {
  start: number;
  end: number;
}

export interface FollowViewPolicy {
  kind: 'follow';
}

/**
 * A user-chosen interval. It is relative to the display origin (T when the sweep has a
 * trigger, otherwise the sweep start), never to the store's first sample.
 */
export interface FixedViewPolicy {
  kind: 'fixed';
  startSec: number;
  endSec: number;
}

/**
 * Loop trigger lock. `fraction` is where T sits in the viewport: 0 = left edge,
 * 1 = right edge. The view width comes from the retained range at resolution time.
 */
export interface TriggerLockedViewPolicy {
  kind: 'triggerLocked';
  fraction: number;
}

export type ViewPolicy = FollowViewPolicy | FixedViewPolicy | TriggerLockedViewPolicy;

/** A session's policy plus its sweep bookkeeping. */
export interface CaptureSession {
  readonly mode: CaptureMode;
  readonly policy: ViewPolicy;
  /** 0 before the first RUN; `beginSweep` increments it. Loop has exactly one sweep. */
  readonly sweepIndex: number;
}

/**
 * Context for resolving a policy against one sweep. `fraction` is the sweep's configured
 * pre-trigger fraction; it is only used when a rejected `fixed` view falls back onto a
 * Loop trigger lock. Pass the same `preTriggerPercent / 100` used to arm the sweep.
 */
export interface ViewResolveContext {
  /** A software trigger matched in this sweep (armed alone is not enough). */
  triggerActive: boolean;
  /** The sweep's retained T-relative range. Negative values are pre-trigger data. */
  retained: SecondsRange;
  /** Configured pre-trigger fraction, clamped to [0, 1]; defaults to 0 (T on the left). */
  fraction?: number;
}

/** Result of resolving a session for one sweep. Adopt `session` to keep the fallback. */
export interface ResolvedSessionView {
  session: CaptureSession;
  policy: ViewPolicy;
  view: SecondsRange;
}

/**
 * Tolerance for the inclusive containment test. A fixed interval that lands on the
 * retained boundary must not be rejected because a seconds->samples round trip moved it
 * by a few floating-point ulps. Callers that know the sample period can pass half a
 * sample instead.
 */
export const RANGE_FIT_EPSILON = 1e-9;

/** Clamp a pre-trigger fraction to [0, 1]; non-finite input means T on the left edge. */
export function clampViewFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * The default policy for a brand-new session: FollowLive for every mode, including Loop.
 * A Loop only leaves `follow` when its armed trigger actually matches.
 *
 * `_mode` is part of the API to make the rule explicit at every call site; the answer is
 * intentionally mode-independent.
 */
export function sessionDefaultView(_mode: CaptureMode): ViewPolicy {
  return { kind: 'follow' };
}

/**
 * The mode's fallback policy when a fixed interval can no longer be honoured.
 * Single/Repeat return FollowLive. Loop returns a trigger lock only when its trigger is
 * active; an unmatched (or expired) Loop returns FollowLive.
 */
export function sessionFallbackView(
  mode: CaptureMode, triggerActive: boolean, fraction = 0,
): ViewPolicy {
  if (mode === 'loop' && triggerActive) return { kind: 'triggerLocked', fraction: clampViewFraction(fraction) };
  return { kind: 'follow' };
}

/** Build a trigger lock with a clamped fraction (exported for event handlers/tests). */
export function triggerLockedView(fraction: number): ViewPolicy {
  return { kind: 'triggerLocked', fraction: clampViewFraction(fraction) };
}

/**
 * Record a manual pan/zoom as a fixed interval. Ends are put in order so a dragged
 * selection that arrives right-to-left still describes one interval. An empty or
 * non-finite interval cannot describe a viewport and falls back to FollowLive.
 */
export function manualView(startSec: number, endSec: number): ViewPolicy {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return { kind: 'follow' };
  const start = Math.min(startSec, endSec);
  const end = Math.max(startSec, endSec);
  if (!(end > start)) return { kind: 'follow' };
  return { kind: 'fixed', startSec: start + 0, endSec: end + 0 };
}

/**
 * Event transition for a trigger match.
 *
 * Only Loop locks on T, and only when the user has not already taken the view. A Loop
 * with no match never calls this (or calls it only after a match), so it stays `follow`.
 * Single and Repeat return the policy untouched: their trigger still moves the axis
 * origin to T, but it does not freeze a live viewport.
 */
export function viewAfterTrigger(policy: ViewPolicy, mode: CaptureMode, fraction = 0): ViewPolicy {
  if (mode !== 'loop') return policy;
  if (policy.kind === 'fixed') return policy;
  return triggerLockedView(fraction);
}

/** Normalize a range for geometry. Returns null when either end is non-finite. */
function orderedRange(range: SecondsRange): SecondsRange | null {
  if (!Number.isFinite(range.startSec) || !Number.isFinite(range.endSec)) return null;
  const startSec = Math.min(range.startSec, range.endSec);
  const endSec = Math.max(range.startSec, range.endSec);
  return { startSec, endSec };
}

/**
 * Inclusive containment of `range` in `retained`, with an optional absolute tolerance.
 * Both inputs must be finite and non-empty (`end > start`); a zero-width or reversed
 * range is not a view and does not fit.
 */
export function secondsRangeFits(
  range: SecondsRange, retained: SecondsRange, epsilon = RANGE_FIT_EPSILON,
): boolean {
  if (!(range.endSec > range.startSec) || !(retained.endSec > retained.startSec)) return false;
  if (!Number.isFinite(range.startSec) || !Number.isFinite(range.endSec) ||
      !Number.isFinite(retained.startSec) || !Number.isFinite(retained.endSec)) return false;
  const tolerance = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0;
  return range.startSec >= retained.startSec - tolerance &&
    range.endSec <= retained.endSec + tolerance;
}

/** Whether a policy's derived window still makes sense against this retained range. */
export function viewFitsRetained(policy: ViewPolicy, retained: SecondsRange): boolean {
  // Follow and triggerLocked are derived from the retained range, so they fit by
  // construction. Only a user-chosen fixed interval can be invalidated by a new sweep.
  if (policy.kind !== 'fixed') return true;
  return secondsRangeFits(policy, retained);
}

/**
 * Resolve a candidate policy against one sweep.
 *
 *   - follow stays follow (a trigger match is an *event*: call `viewAfterTrigger`; this
 *     function must not relock a view the user explicitly follows).
 *   - fixed stays fixed while it fits; otherwise the mode fallback applies.
 *   - triggerLocked stays while the Loop trigger is active; an expired trigger (or a
 *     mode that cannot lock) falls back to FollowLive.
 *
 * The result should be stored as the session's current policy so a fallback is durable.
 */
export function resolveView(
  policy: ViewPolicy, mode: CaptureMode, context: ViewResolveContext,
): ViewPolicy {
  switch (policy.kind) {
    case 'follow':
      return { kind: 'follow' };
    case 'triggerLocked':
      return mode === 'loop' && context.triggerActive
        ? triggerLockedView(policy.fraction)
        : { kind: 'follow' };
    case 'fixed':
      return secondsRangeFits(policy, context.retained)
        ? policy
        : sessionFallbackView(mode, context.triggerActive, context.fraction ?? 0);
  }
}

/**
 * The seconds interval a policy displays for a retained range.
 *
 *   - follow: the retained range itself (right edge at the newest sample).
 *   - fixed: the stored interval unchanged. This function never fits it; resolve first.
 *   - triggerLocked: a window as wide as the retained span with T at `fraction`:
 *     `[-f * span, (1 - f) * span]`. With pre-trigger retention that is exactly
 *     `[-f*span, ...]`; if the data does not reach that far, the plot shows blank time
 *     rather than pretending the data moved.
 *
 * The retained range is ordered before use and a non-finite retained range yields 0 s.
 */
export function viewRangeSeconds(policy: ViewPolicy, retained: SecondsRange): SecondsRange {
  const ordered = orderedRange(retained) ?? { startSec: 0, endSec: 0 };
  if (policy.kind === 'follow') return ordered;
  if (policy.kind === 'fixed') return { startSec: policy.startSec, endSec: policy.endSec };
  const span = ordered.endSec - ordered.startSec;
  const fraction = clampViewFraction(policy.fraction);
  return { startSec: -fraction * span, endSec: (1 - fraction) * span };
}

/**
 * T-relative seconds -> sample index, rounded to the nearest whole sample. Negative
 * pre-trigger times map to negative indices; `-0` is normalized to `0`. Invalid input
 * (non-finite time, or a non-positive samplerate) yields 0 rather than NaN so a bad
 * settings value cannot poison a viewport.
 */
export function secondsToSamples(seconds: number, samplerate: number): number {
  if (!Number.isFinite(seconds) || !Number.isFinite(samplerate) || samplerate <= 0) return 0;
  const samples = Math.round(seconds * samplerate);
  return samples === 0 ? 0 : samples;
}

/** Sample index -> T-relative seconds. Invalid input yields 0. */
export function samplesToSeconds(samples: number, samplerate: number): number {
  if (!Number.isFinite(samples) || !Number.isFinite(samplerate) || samplerate <= 0) return 0;
  return samples / samplerate;
}

/** Convert both ends of a T-relative seconds interval with the same rounding. */
export function secondsRangeToSamples(range: SecondsRange, samplerate: number): SampleRange {
  return {
    start: secondsToSamples(range.startSec, samplerate),
    end: secondsToSamples(range.endSec, samplerate),
  };
}

/** Convert both ends of a sample interval back to T-relative seconds. */
export function samplesRangeToSeconds(range: SampleRange, samplerate: number): SecondsRange {
  return {
    startSec: samplesToSeconds(range.start, samplerate),
    endSec: samplesToSeconds(range.end, samplerate),
  };
}

/** Sweep ownership documented as data: Single one, Repeat many, Loop continuous. */
export function sessionSweepPattern(mode: CaptureMode): SessionSweepPattern {
  if (mode === 'single') return 'one-sweep';
  if (mode === 'repeat') return 'multi-sweep';
  return 'continuous';
}

/**
 * Samples a software-trigger sweep may inspect while waiting before it reports
 * `not-found`.
 *
 * Repeat is the only mode that can retry: one sweep's own sample budget is its search
 * allowance, so a missing trigger ends that sweep (B1) and the next Interval tries
 * again. Single waits indefinitely for its one trigger; Loop is unbounded by design.
 * `sweepSamples` is the sweep's retained budget (post-trigger + pre-trigger); a
 * non-positive value leaves the limit at Infinity rather than inventing a search.
 */
export function triggerSearchSamples(mode: CaptureMode, sweepSamples: number): number {
  if (mode !== 'repeat') return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(sweepSamples) || sweepSamples <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(sweepSamples);
}

/**
 * Start a Capture -> Stop session. The policy always resets to FollowLive; a fixed view
 * from an earlier session is not carried over, even for the same mode.
 */
export function createSession(mode: CaptureMode): CaptureSession {
  return { mode, policy: sessionDefaultView(mode), sweepIndex: 0 };
}

/**
 * Mark a device RUN -> STOP boundary. The policy is intentionally kept: a user's fixed
 * view survives Repeat sweeps while it still fits. Loop has no boundary; callers should
 * call this once when its single unbounded sweep starts, not on an interval.
 *
 * The settings snapshot is the caller's job: capture the current settings as this sweep
 * begins so Repeat edits take effect on the next sweep.
 */
export function beginSweep(session: CaptureSession): CaptureSession {
  return { ...session, sweepIndex: session.sweepIndex + 1 };
}

/** Session transition for a manual pan/zoom. */
export function sessionWithManualView(
  session: CaptureSession, startSec: number, endSec: number,
): CaptureSession {
  const policy = manualView(startSec, endSec);
  if (policy.kind === 'follow' && session.policy.kind === 'follow') return session;
  return { ...session, policy };
}

/**
 * Whether the end of a sweep shows the whole capture. A Single that ran to completion
 * while still FollowLive has nothing left to follow: the live window it was tracking
 * is an arbitrary last slice, so the view becomes the whole retained range (T, when
 * there is one, stays the origin and sits at its pre-trigger position inside it).
 * Everything else keeps its view: a user's Fixed interval (`userView` also covers a
 * gesture not yet folded into the policy), a manual stop, a Repeat wave (the next
 * Interval reuses the view) and Loop (its window is the data window, not the capture).
 * This is the end-of-capture default, not a Fixed fallback: a stale Fixed view still
 * falls back without any automatic Fit.
 */
export function sweepEndFitsCapture(
  session: CaptureSession, reason: 'manual' | 'completed', userView: boolean,
): boolean {
  return session.mode === 'single' && reason === 'completed' &&
    session.policy.kind === 'follow' && !userView;
}

/** Session transition for a Loop trigger match (see `viewAfterTrigger`). */
export function sessionAfterTrigger(session: CaptureSession, fraction: number): CaptureSession {
  return { ...session, policy: viewAfterTrigger(session.policy, session.mode, fraction) };
}

/**
 * Resolve and adopt the session policy for one sweep, and return the window to display.
 * Call this when a sweep's retained range is known (or, for Repeat, as soon as the
 * expected range for the sweep is known - do not reject a view just because the store
 * is still filling). The returned session carries any fallback; the caller must keep it.
 */
export function resolveSessionView(
  session: CaptureSession, context: ViewResolveContext,
): ResolvedSessionView {
  const policy = resolveView(session.policy, session.mode, context);
  return {
    session: { ...session, policy },
    policy,
    view: viewRangeSeconds(policy, context.retained),
  };
}
