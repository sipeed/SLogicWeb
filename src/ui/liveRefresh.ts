// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * When a running capture redraws for newly arrived samples.
 *
 * Data arrives in many small chunks; drawing on each of them would put the whole capture
 * path at the mercy of the renderer. The interface therefore reads the newest window on
 * the animation-frame clock and paces that read by the cost of the previous frame, so a
 * cheap frame is not held back and an expensive one is not retried immediately.
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
