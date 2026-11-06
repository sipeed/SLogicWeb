// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * When a running capture redraws for newly arrived samples.
 *
 * Data arrives in many small chunks; the interface reads the newest window on the
 * animation-frame clock instead of being pushed every packet.
 *
 * User interactions are not throttled: pan, zoom, hover and marker edits set the normal
 * dirty flag and draw in the next animation frame. This gate applies only to data-driven
 * refreshes, and runs in the animation-frame callback, so it can never draw more often
 * than the display refreshes.
 */

/** Least time between two data-driven redraws, however cheap the last frame was. */
export const LIVE_FRAME_FLOOR_MS = 1000 / 120;

/** Most time the gate will wait after an expensive frame: at least 30 live frames/s. */
export const LIVE_FRAME_CEIL_MS = 1000 / 30;

const LIVE_FRAME_COST_FACTOR = 1.25;

/** Interval before the next data-driven draw, from the cost of the last one. */
export function liveFrameIntervalMs(lastCostMs: number): number {
  const paced = lastCostMs * LIVE_FRAME_COST_FACTOR;
  if (!Number.isFinite(paced) || paced <= LIVE_FRAME_FLOOR_MS) return LIVE_FRAME_FLOOR_MS;
  return Math.min(paced, LIVE_FRAME_CEIL_MS);
}

/**
 * Whether a running capture has new data due for the screen. `lastDrawnAt` is the time of
 * the last draw for either reason.
 */
export function liveDrawDue(
  now: number, lastDrawnAt: number, lastCostMs: number, pending: boolean, running: boolean,
): boolean {
  return running && pending && now - lastDrawnAt >= liveFrameIntervalMs(lastCostMs);
}

/** The store window a frame drew, in absolute capture samples. */
export interface LiveWindow {
  viewStart: number;
  viewEnd: number;
  /** End of the data that can still grow: `store.length`, or a composite's frontier. */
  dataLen: number;
  dropped: number;
}

/**
 * True when a new sample can reach the pixels of the current window. A fixed window that
 * no new sample enters, over data that did not shift under it, is already on screen.
 */
export function liveWindowHasNewData(
  follow: boolean,
  viewStart: number, viewEnd: number, dataLen: number, dropped: number,
  drawn: LiveWindow,
): boolean {
  if (follow) return true;
  const start = dropped + viewStart;
  const end = dropped + viewEnd;
  const drawnStart = drawn.dropped + drawn.viewStart;
  const drawnEnd = drawn.dropped + drawn.viewEnd;
  if (start !== drawnStart || end !== drawnEnd) return true;
  const drawnFrontier = drawn.dropped + drawn.dataLen;
  const frontier = dropped + dataLen;
  return frontier > drawnFrontier && frontier > start && drawnFrontier < end;
}
