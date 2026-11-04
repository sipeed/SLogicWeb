// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure display swap/frontier model for Loop and Repeat.
 *
 * This module is deliberately free of DOM, timers, stores and rendering. It answers two
 * questions the display layer needs:
 *
 *   Loop   - how much newly arrived data may be swapped into the visible window at once,
 *            while keeping the display phase-locked on T and moving in whole signal
 *            periods? (A partial block, not necessarily a full-window repaint.)
 *   Repeat - where is the frontier between the finished wave still on screen and the
 *            current wave that is progressively replacing it, and which relative-time
 *            spans of a viewport show old data, new data, or nothing at all?
 *
 * Coordinate convention
 * ---------------------
 * Every time in the public API is in seconds relative to the *display origin*: the
 * trigger T when one is present, otherwise the sweep start. A sample at index `s` with
 * display origin `origin` is at `(s - origin) / samplerate`; pre-trigger samples are
 * therefore negative. Helpers convert between samples, seconds and pixels.
 *
 * Trigger positions
 * -----------------
 * In the Repeat frame, the current wave's T is at 0 by construction (the display origin
 * is its T, or its sweep start when it has no trigger). The old wave keeps its own T,
 * supplied in the same display-relative frame; `oldTriggerVisible` says whether that
 * point still falls in an old span rather than having been overwritten by new data.
 *
 * Unsupported combinations (documented rather than guessed):
 *   - A period longer than the visible loop window cannot be phase-locked and produces
 *     no ready block.
 *   - Without a known signal period (periodSamples/periodSeconds), Loop degrades to one
 *     frame-budget block per update; `periodKnown` is false.
 *   - Repeat assumes both waves share one samplerate; convert with the seconds helpers
 *     if that ever stops being true.
 */

import { bytesPerSampleForChannels, isChannelCount } from '../types.js';

/** Default display target for Loop block planning. */
export const DEFAULT_SWAP_TARGET_FPS = 60;

/**
 * Per-block display budget. This bounds the work (and, at wide sample widths, the copy)
 * of one local swap; it never bounds capture retention. A full-window repaint is only
 * allowed when the window itself fits this and the frame budget.
 */
export const DEFAULT_SWAP_BUFFER_BYTES = 4 * 1024 * 1024;

/** Comparison slack for merged relative-time spans (seconds). */
const SPAN_EPS = 1e-12;

export interface RelativeSpan {
  /** Start of the interval, seconds relative to the display origin. Inclusive. */
  startSec: number;
  /** End of the interval, seconds relative to the display origin. Exclusive. */
  endSec: number;
}

/* -------------------------------------------------------------------------- */
/* Loop block planning                                                         */
/* -------------------------------------------------------------------------- */

export interface LoopSwapInput {
  /** Capture sampling rate in Hz. */
  samplerate: number;
  /** Logic channel count (4/8/16/32/64/128); used for the byte cap. */
  channels: number;
  /** New samples not yet reflected on screen. */
  availableSamples: number;
  /** The whole visible loop window, in samples. */
  windowSamples: number;
  /** Display target; defaults to {@link DEFAULT_SWAP_TARGET_FPS}. */
  targetFps?: number;
  /** Signal period in samples. Takes precedence over `periodSeconds`. */
  periodSamples?: number;
  /** Signal period in seconds; used when `periodSamples` is absent. */
  periodSeconds?: number;
  /** Per-block byte cap; defaults to {@link DEFAULT_SWAP_BUFFER_BYTES}. */
  bufferCapBytes?: number;
  /** Optional per-block sample cap, applied together with the byte cap. */
  bufferCapSamples?: number;
  /**
   * Largest fraction of the visible window one local swap may cover, 0 < f <= 1.
   * Defaults to 1 (the whole window may be swapped by one block). The App asks for a
   * quarter: a local update should let the waveform flow rather than repaint the whole
   * window unless the caller explicitly wants a full-window swap.
   */
  maxWindowFraction?: number;
}

export type LoopSwapLimit =
  /** The caller has not accumulated a full period yet. */
  | 'available'
  /** One frame's sample budget (samplerate / targetFps) is the binding cap. */
  | 'frame-budget'
  /** The visible loop window is the binding cap. */
  | 'window'
  /** The per-block memory/sample cap is the binding cap. */
  | 'buffer'
  /** One whole period does not fit any cap; no block can be ready. */
  | 'period'
  /** Invalid samplerate/channels/target. */
  | 'invalid';

export interface LoopSwapPlan {
  /** Samples to swap in this update; a whole number of periods when periodKnown. */
  blockSamples: number;
  /** Whole signal periods in `blockSamples` (0 when not ready; 1 for an unaligned batch). */
  periods: number;
  /**
   * Expected display update rate when blocks of this size keep arriving:
   * min(targetFps, samplerate / blockSamples). 0 when not ready.
   */
  estimatedRefreshHz: number;
  /** True when blockSamples > 0. */
  ready: boolean;
  /** Which cap determined the block. */
  limit: LoopSwapLimit;
  /** Resolved period in samples; 0 when the caller supplied no period. */
  periodSamples: number;
  /** Whether the block is actually period-aligned (not the fallback batch). */
  periodKnown: boolean;
  /** samplerate / targetFps, at least 1. */
  frameBudgetSamples: number;
  /** Effective per-block sample cap from bytes and `bufferCapSamples`. */
  bufferCapSamples: number;
  /** Clamped inputs, echoed for the panel/status readout. */
  availableSamples: number;
  windowSamples: number;
  /** Samples left over after the largest whole-period block (`limit - block`). */
  periodRemainderSamples: number;
  /** Bytes in one block at this channel width. */
  blockBytes: number;
  /** The block is the whole window: a full-window repaint is justified. */
  fullWindow: boolean;
  /** The fraction-derived cap the block had to respect (the window's own span by default). */
  windowCapSamples: number;
  /** One period was taken even though it exceeds the frame budget. */
  overFrameBudget: boolean;
}

function notReady(limit: LoopSwapLimit, frameBudgetSamples = 0): LoopSwapPlan {
  return {
    blockSamples: 0,
    periods: 0,
    estimatedRefreshHz: 0,
    ready: false,
    limit,
    periodSamples: 0,
    periodKnown: false,
    frameBudgetSamples,
    bufferCapSamples: 0,
    availableSamples: 0,
    windowSamples: 0,
    periodRemainderSamples: 0,
    blockBytes: 0,
    fullWindow: false,
    windowCapSamples: 0,
    overFrameBudget: false,
  };
}

function integerAtLeastZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function validPeriodSamples(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : null;
}

/** Which of the equal-to-limit resources to report, in a stable display order. */
function limitingResource(
  limit: number,
  available: number,
  window: number,
  buffer: number,
  budget: number,
): LoopSwapLimit {
  if (available <= limit) return 'available';
  if (window <= limit) return 'window';
  if (buffer <= limit) return 'buffer';
  return budget <= limit ? 'frame-budget' : 'period';
}

/**
 * Plan one local Loop display swap.
 *
 * The block is the largest whole-period multiple that fits all of: the new data, the
 * frame budget, the visible window and the memory/sample cap. When at least one period
 * fits the data/window/memory caps but the frame budget is smaller than a period, one
 * period is still taken ({@link LoopSwapPlan.overFrameBudget}); phase alignment is more
 * important than the nominal frame rate, and the estimated refresh reports the cost.
 * When the data is short of one period (or the period cannot fit the window/memory cap)
 * nothing is ready and the caller keeps the current frame.
 *
 * A known period must be a positive integer number of samples. `periodSeconds` is
 * rounded to the nearest sample. Without either, the model cannot phase-lock and returns
 * one whole frame-budget batch (`periodKnown: false`).
 */
export function planLoopSwap(input: LoopSwapInput): LoopSwapPlan {
  const rate = input.samplerate;
  const fps = input.targetFps === undefined ? DEFAULT_SWAP_TARGET_FPS : input.targetFps;
  const channels = input.channels;
  if (!Number.isFinite(rate) || rate <= 0 ||
      !Number.isFinite(fps) || fps <= 0 ||
      !isChannelCount(channels)) {
    return notReady('invalid');
  }

  const frameBudgetSamples = Math.max(1, Math.floor(rate / fps));
  const availableSamples = integerAtLeastZero(input.availableSamples);
  const windowSamples = integerAtLeastZero(input.windowSamples);
  const bytesPerSample = bytesPerSampleForChannels(channels);
  const byteCap = input.bufferCapBytes !== undefined &&
    Number.isFinite(input.bufferCapBytes) && input.bufferCapBytes > 0
    ? Math.floor(input.bufferCapBytes / bytesPerSample)
    : Math.floor(DEFAULT_SWAP_BUFFER_BYTES / bytesPerSample);
  const sampleCap = input.bufferCapSamples !== undefined &&
    Number.isFinite(input.bufferCapSamples) && input.bufferCapSamples > 0
    ? Math.floor(input.bufferCapSamples)
    : Number.POSITIVE_INFINITY;
  const bufferCapSamples = Math.max(0, Math.min(byteCap, sampleCap));
  const fraction = input.maxWindowFraction === undefined
    ? 1
    : Number.isFinite(input.maxWindowFraction)
      ? Math.min(1, Math.max(0, input.maxWindowFraction))
      : 1;
  const windowCapSamples = windowSamples > 0 && fraction > 0 && fraction < 1
    ? Math.max(1, Math.floor(windowSamples * fraction))
    : windowSamples;

  if (availableSamples <= 0) {
    return {
      ...notReady('available', frameBudgetSamples),
      availableSamples,
      windowSamples,
      bufferCapSamples,
      windowCapSamples,
    };
  }
  if (windowSamples <= 0) {
    return {
      ...notReady('window', frameBudgetSamples),
      availableSamples,
      windowSamples,
      bufferCapSamples,
      windowCapSamples,
    };
  }
  if (bufferCapSamples <= 0) {
    return {
      ...notReady('buffer', frameBudgetSamples),
      availableSamples,
      windowSamples,
      bufferCapSamples,
      windowCapSamples,
    };
  }

  const periodSamples = validPeriodSamples(input.periodSamples)
    ?? (input.periodSeconds !== undefined && Number.isFinite(input.periodSeconds) &&
        input.periodSeconds > 0
      ? Math.max(1, Math.round(input.periodSeconds * rate))
      : null);
  const periodKnown = periodSamples !== null;

  if (!periodKnown) {
    // No signal period: batch one frame budget, bounded by data/window/memory.
    const blockSamples = Math.min(
      availableSamples, frameBudgetSamples, windowCapSamples, bufferCapSamples,
    );
    const limit = limitingResource(
      blockSamples, availableSamples, windowCapSamples, bufferCapSamples, frameBudgetSamples,
    );
    return {
      blockSamples,
      periods: blockSamples > 0 ? 1 : 0,
      estimatedRefreshHz: blockSamples > 0 ? Math.min(fps, rate / blockSamples) : 0,
      ready: blockSamples > 0,
      limit,
      periodSamples: 0,
      periodKnown: false,
      frameBudgetSamples,
      bufferCapSamples,
      availableSamples,
      windowSamples,
      windowCapSamples,
      periodRemainderSamples: 0,
      blockBytes: blockSamples * bytesPerSample,
      fullWindow: blockSamples >= windowSamples,
      overFrameBudget: false,
    };
  }

  const period = periodSamples;
  const limitSamples = Math.min(
    availableSamples, frameBudgetSamples, windowCapSamples, bufferCapSamples,
  );
  let periods = limitSamples >= period ? Math.floor(limitSamples / period) : 0;
  let blockSamples = periods * period;
  let limit: LoopSwapLimit = limitingResource(
    limitSamples, availableSamples, windowCapSamples, bufferCapSamples, frameBudgetSamples,
  );
  let overFrameBudget = false;

  if (periods < 1) {
    // The frame budget may be below one period even though the data could supply it.
    // Take one whole period if the data, window and memory caps allow it; otherwise
    // report the cap that makes a period impossible.
    const dataLimit = Math.min(availableSamples, windowCapSamples, bufferCapSamples);
    if (dataLimit >= period) {
      periods = 1;
      blockSamples = period;
      limit = 'frame-budget';
      overFrameBudget = true;
    } else {
      blockSamples = 0;
      limit = dataLimit === availableSamples
        ? 'available'
        : dataLimit === windowCapSamples ? 'window' : 'buffer';
    }
  }

  return {
    blockSamples,
    periods,
    estimatedRefreshHz: blockSamples > 0 ? Math.min(fps, rate / blockSamples) : 0,
    ready: blockSamples > 0,
    limit,
    periodSamples: period,
    periodKnown: true,
    frameBudgetSamples,
    bufferCapSamples,
    availableSamples,
    windowSamples,
    windowCapSamples,
    periodRemainderSamples: Math.max(0, limitSamples - blockSamples),
    blockBytes: blockSamples * bytesPerSample,
    fullWindow: blockSamples > 0 && blockSamples >= windowSamples,
    overFrameBudget,
  };
}

/* -------------------------------------------------------------------------- */
/* Repeat frontier and old/new regions                                         */
/* -------------------------------------------------------------------------- */

export interface RepeatWaveSpan extends RelativeSpan {
  /**
   * This wave's trigger T in display-relative seconds. Omitted means 0 (the wave's T is
   * the display origin, the normal case). `null` means the wave has no trigger and its
   * sweep start is the origin, so there is no T marker to draw.
   */
  triggerSec?: number | null;
}

export interface RepeatRegionInput {
  /**
   * Current (back) wave captured so far. `endSec` is the frontier: the right edge of the
   * data that may replace the old wave.
   */
  newWave: RepeatWaveSpan;
  /**
   * Previous (front) wave, already complete, in the same display-relative frame.
   * `undefined` means the old wave covers the entire viewport (the normal progressive
   * replacement assumption); `null` means there is no old wave, so uncovered spans are
   * reported as gaps instead of being filled.
   */
  oldWave?: RepeatWaveSpan | null;
  /** The user's Fixed viewport, in display-relative seconds. */
  viewport?: RelativeSpan | null;
  /** Display span used when no viewport is supplied. */
  display?: RelativeSpan | null;
}

export interface RepeatRegions {
  /** Relative time of the current wave's captured right edge (`newWave.endSec`). */
  frontierSec: number;
  /** The viewport these regions were clipped to. */
  viewport: RelativeSpan;
  /** Current-wave span visible in the viewport, or null before it reaches it. */
  new: RelativeSpan | null;
  /** Largest old span (the primary region for hit-testing/labels), or null. */
  old: RelativeSpan | null;
  /** Every visible old span, ascending. A viewport that begins before new data and ends
   *  after the frontier yields two. */
  oldRegions: RelativeSpan[];
  /** Old wave's T, in display-relative seconds; null when it has none. */
  oldTriggerSec: number | null;
  /** Current wave's T, normally 0; null when the wave has no trigger. */
  newTriggerSec: number | null;
  /** Whether each T currently falls in a visible span of its own wave. */
  oldTriggerVisible: boolean;
  newTriggerVisible: boolean;
  /** Fraction of the viewport width replaced by current-wave data (0..1). */
  progress: number;
  /** Both new and old data are visible at once. */
  replacing: boolean;
  /** True when new + old spans cover the whole viewport. */
  coverageComplete: boolean;
  /** Uncovered viewport spans (no old wave data and no new data yet). */
  gaps: RelativeSpan[];
}

function normalizeSpan(span: RelativeSpan | null | undefined): RelativeSpan | null {
  if (!span) return null;
  const { startSec, endSec } = span;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) return null;
  return { startSec, endSec };
}

function clipSpan(span: RelativeSpan, viewport: RelativeSpan): RelativeSpan | null {
  const startSec = Math.max(span.startSec, viewport.startSec);
  const endSec = Math.min(span.endSec, viewport.endSec);
  return endSec > startSec ? { startSec, endSec } : null;
}

/** `span` minus `hole`; returns at most two spans (both inputs are contiguous). */
function subtractSpan(span: RelativeSpan, hole: RelativeSpan | null): RelativeSpan[] {
  if (!hole || hole.endSec <= span.startSec || hole.startSec >= span.endSec) return [span];
  const out: RelativeSpan[] = [];
  if (hole.startSec > span.startSec) {
    out.push({ startSec: span.startSec, endSec: Math.min(hole.startSec, span.endSec) });
  }
  if (hole.endSec < span.endSec) {
    out.push({ startSec: Math.max(hole.endSec, span.startSec), endSec: span.endSec });
  }
  return out;
}

function mergeSpans(spans: readonly RelativeSpan[]): RelativeSpan[] {
  const sorted = spans
    .filter((span) => span.endSec > span.startSec)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);
  const merged: RelativeSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.startSec <= last.endSec + SPAN_EPS) {
      last.endSec = Math.max(last.endSec, span.endSec);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function spanContains(span: RelativeSpan, seconds: number): boolean {
  return seconds >= span.startSec - SPAN_EPS && seconds < span.endSec - SPAN_EPS;
}

function resolvedTrigger(triggerSec: number | null | undefined): number | null {
  if (triggerSec === null) return null;
  if (triggerSec === undefined) return 0;
  return Number.isFinite(triggerSec) ? triggerSec : null;
}

/**
 * Split a viewport into the region that already holds current-wave data and the region
 * that must keep showing the previous wave.
 *
 * The current wave grows from `newWave.startSec` to `newWave.endSec` (the frontier).
 * Everything else in the viewport stays old: the part left of the current wave and the
 * part right of the frontier. That second split is why a Fixed viewport spanning both
 * waves was previously at risk of showing a blank vacuum; here the old wave explicitly
 * fills both sides, and `coverageComplete`/`gaps` say whether anything really is missing.
 *
 * Span semantics are half-open `[startSec, endSec)`, so a trigger exactly on a boundary
 * belongs to the span on its right. New data wins over old where they meet.
 */
export function repeatRegions(input: RepeatRegionInput): RepeatRegions {
  const newRaw = normalizeSpan(input.newWave);
  const oldRaw = input.oldWave === undefined
    ? undefined
    : normalizeSpan(input.oldWave);
  const explicitDisplay = normalizeSpan(input.display);
  const explicitViewport = normalizeSpan(input.viewport);
  const frontierSec = Number.isFinite(input.newWave.endSec) ? input.newWave.endSec : 0;

  // An explicit but malformed viewport is not silently replaced by another display
  // span: the caller asked for a specific window, and pretending it is valid would put
  // regions on screen under the wrong coordinates.
  const viewport = (input.viewport !== undefined && input.viewport !== null
    ? explicitViewport
    : explicitViewport ?? explicitDisplay ?? (oldRaw ?? (newRaw ?? { startSec: 0, endSec: 0 })))
    ?? { startSec: 0, endSec: 0 };

  if (viewport.endSec <= viewport.startSec) {
    return {
      frontierSec,
      viewport: { startSec: 0, endSec: 0 },
      new: null,
      old: null,
      oldRegions: [],
      oldTriggerSec: resolvedTrigger(input.oldWave ? input.oldWave.triggerSec : null),
      newTriggerSec: resolvedTrigger(input.newWave.triggerSec),
      oldTriggerVisible: false,
      newTriggerVisible: false,
      progress: 0,
      replacing: false,
      coverageComplete: true,
      gaps: [],
    };
  }

  const newSpan = newRaw ? clipSpan(newRaw, viewport) : null;

  // Old coverage: an omitted oldWave is the completed frame that covers the viewport;
  // an explicit null means this is the first wave and there is nothing old to show.
  const oldCoverage: RelativeSpan[] = [];
  if (input.oldWave !== null) {
    const source = oldRaw ?? viewport;
    const clipped = clipSpan(source, viewport);
    if (clipped) oldCoverage.push(clipped);
  }
  const oldRegions = mergeSpans(oldCoverage.flatMap((span) => subtractSpan(span, newSpan)));

  const coverage = mergeSpans([
    ...(newSpan ? [newSpan] : []),
    ...oldRegions,
  ]);
  let gaps: RelativeSpan[] = [viewport];
  for (const span of coverage) {
    gaps = gaps.flatMap((gap) => subtractSpan(gap, span));
  }

  const newTriggerSec = resolvedTrigger(input.newWave.triggerSec);
  const oldTriggerSec = input.oldWave
    ? resolvedTrigger(input.oldWave.triggerSec)
    : null;
  const viewportSeconds = viewport.endSec - viewport.startSec;
  const newSeconds = newSpan ? newSpan.endSec - newSpan.startSec : 0;

  let old: RelativeSpan | null = null;
  for (const span of oldRegions) {
    if (old === null || span.endSec - span.startSec > old.endSec - old.startSec) old = span;
  }

  return {
    frontierSec,
    viewport,
    new: newSpan,
    old,
    oldRegions,
    oldTriggerSec,
    newTriggerSec,
    oldTriggerVisible: oldTriggerSec !== null &&
      oldRegions.some((span) => spanContains(span, oldTriggerSec)),
    newTriggerVisible: newTriggerSec !== null &&
      newSpan !== null && spanContains(newSpan, newTriggerSec),
    progress: viewportSeconds > 0 ? Math.min(1, newSeconds / viewportSeconds) : 0,
    replacing: newSpan !== null && oldRegions.length > 0,
    coverageComplete: gaps.length === 0,
    gaps,
  };
}

/* -------------------------------------------------------------------------- */
/* Seconds <-> samples <-> pixels                                              */
/* -------------------------------------------------------------------------- */

/** Convert a sample count (or relative sample index) to seconds. Null if invalid. */
export function secondsFromSamples(samples: number, samplerate: number): number | null {
  if (!Number.isFinite(samples) || !Number.isFinite(samplerate) || samplerate <= 0) return null;
  return samples / samplerate;
}

/** Convert seconds to the nearest sample count/index. Null if invalid. */
export function samplesFromSeconds(seconds: number, samplerate: number): number | null {
  if (!Number.isFinite(seconds) || !Number.isFinite(samplerate) || samplerate <= 0) return null;
  return Math.round(seconds * samplerate);
}

/** Relative time of `sampleIndex` when `originSample` is the display origin (T or sweep). */
export function relativeSecondsAtSample(
  sampleIndex: number, originSample: number, samplerate: number,
): number | null {
  if (!Number.isFinite(sampleIndex) || !Number.isFinite(originSample)) return null;
  return secondsFromSamples(sampleIndex - originSample, samplerate);
}

/**
 * Build a display-relative span from a half-open sample range `[startSample, endSample)`.
 * Both samples and the origin are in the same store/stream coordinates.
 */
export function relativeSpanFromSamples(
  startSample: number, endSample: number, originSample: number, samplerate: number,
): RelativeSpan | null {
  const startSec = relativeSecondsAtSample(startSample, originSample, samplerate);
  const endSec = relativeSecondsAtSample(endSample, originSample, samplerate);
  if (startSec === null || endSec === null || endSec <= startSec) return null;
  return { startSec, endSec };
}

export interface WaveFromSamplesInput {
  samplerate: number;
  /** First captured sample (inclusive). */
  startSample: number;
  /** End of captured data (exclusive); the frontier for a running wave. */
  endSample: number;
  /** The display origin: T when present, else the sweep start. */
  originSample: number;
  /** Trigger sample index, or null when there is no trigger. Omit for T at the origin. */
  triggerSample?: number | null;
}

/** Convenience: build a {@link RepeatWaveSpan} from store-relative sample indices. */
export function waveSpanFromSamples(input: WaveFromSamplesInput): RepeatWaveSpan | null {
  const span = relativeSpanFromSamples(
    input.startSample, input.endSample, input.originSample, input.samplerate,
  );
  if (!span) return null;
  let triggerSec: number | null;
  if (input.triggerSample === null) {
    triggerSec = null;
  } else if (input.triggerSample === undefined) {
    triggerSec = 0;
  } else {
    triggerSec = relativeSecondsAtSample(
      input.triggerSample, input.originSample, input.samplerate,
    );
    if (triggerSec === null) return null;
  }
  return { ...span, triggerSec };
}

export interface PixelSpan {
  /** Unclipped pixel positions; may lie outside the plot. x0 <= x1. */
  x0: number;
  x1: number;
  /** Pixel positions clamped to the plot width. */
  clippedX0: number;
  clippedX1: number;
  /** The span intersects the plot. */
  visible: boolean;
}

/**
 * Map a relative-time span to plot pixels for a viewport. `viewport` is the same span the
 * renderer draws; `widthPx` is the plot width. Null for invalid inputs.
 */
export function spanToPixels(
  span: RelativeSpan, viewport: RelativeSpan, widthPx: number,
): PixelSpan | null {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return null;
  const duration = viewport.endSec - viewport.startSec;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(span.startSec) || !Number.isFinite(span.endSec)) return null;
  const rawX0 = ((span.startSec - viewport.startSec) / duration) * widthPx;
  const rawX1 = ((span.endSec - viewport.startSec) / duration) * widthPx;
  const x0 = Math.min(rawX0, rawX1);
  const x1 = Math.max(rawX0, rawX1);
  const clippedX0 = Math.min(widthPx, Math.max(0, x0));
  const clippedX1 = Math.min(widthPx, Math.max(0, x1));
  return {
    x0,
    x1,
    clippedX0,
    clippedX1,
    visible: x1 > 0 && x0 < widthPx && x1 > x0,
  };
}
