// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * When a running capture redraws for newly arrived samples.
 *
 * Data arrives in many small chunks; drawing on each of them would put the whole capture
 * path at the mercy of the renderer. HSync separates the two the same way: its ingest
 * thread appends every packet but tells the interface of progress at most every 50 ms
 * (`hsync-session` `STATUS_INTERVAL`). The UI then reads the newest window, rather than
 * being pushed every packet.
 *
 * User interactions are not throttled: pan, zoom, hover and marker edits set the normal
 * dirty flag and draw in the next animation frame. This gate applies only to data-driven
 * refreshes, and runs in the animation-frame callback, so it can never draw more often
 * than the display refreshes.
 */

/** Least time between two data-driven redraws of a running capture. */
export const LIVE_REFRESH_MS = 50;

/**
 * Whether a running capture has new data due for the screen. `lastDrawnAt` is the time of
 * the last draw for either reason; a draw at time 0 is treated as due immediately.
 */
export function liveDrawDue(
  now: number, lastDrawnAt: number, pending: boolean, running: boolean,
): boolean {
  return running && pending && now - lastDrawnAt >= LIVE_REFRESH_MS;
}
