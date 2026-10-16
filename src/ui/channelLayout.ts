// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Viewport arithmetic for the channel table.
 *
 * This is deliberately UI-owned and pure: fit, overflow and annotation-lane boundaries
 * can be checked without constructing App or a renderer. The caller handles an empty
 * enabled-channel list before asking for a row height.
 */

import { ROWS } from './metrics.js';

/** Return the one integral base pitch shared by every channel row in a layout pass. */
export function computeChannelRowHeight(
  plotHeightCss: number,
  channelCount: number,
  laneCount: number,
): number {
  const available = plotHeightCss - laneCount * ROWS.laneHeight;
  const fit = Math.floor(available / channelCount);
  return Math.max(ROWS.minRowHeight, Math.min(ROWS.maxRowHeight, fit));
}
