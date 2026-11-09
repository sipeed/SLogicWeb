// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Viewport arithmetic for the channel table.
 *
 * This is deliberately UI-owned and pure: fit, overflow and annotation-lane boundaries
 * can be checked without constructing App or a renderer. The caller handles an empty
 * enabled-channel list before asking for a row height.
 */

import { ROWS } from './metrics.js';

/**
 * Return the one integral base pitch shared by every channel row in a layout pass.
 * `compact` ("Compact rows", DESIGN §5.4) lowers the floor from `ROWS.minRowHeight` to
 * `ROWS.compactMinRowHeight`; the auto-fit and the upper clamp are unchanged, so a stack
 * that already fits looks the same with it on.
 */
export function computeChannelRowHeight(
  plotHeightCss: number,
  channelCount: number,
  laneCount: number,
  compact = false,
): number {
  const available = plotHeightCss - laneCount * ROWS.laneHeight;
  const fit = Math.floor(available / channelCount);
  const floor = compact ? ROWS.compactMinRowHeight : ROWS.minRowHeight;
  return Math.max(floor, Math.min(ROWS.maxRowHeight, fit));
}

/** True when a channel row's pitch is below the full card's floor (render it compact). */
export function isCompactRow(baseRowHeightCss: number): boolean {
  return baseRowHeightCss < ROWS.minRowHeight;
}

/**
 * Whether one whole-capture column of a channel holds both levels, i.e. at least one
 * transition (`ColumnView` `low != high`). The edge bit alone is not used: it also counts
 * a transition "into" the first sample from before the capture, which is not an edge.
 */
export function columnHasEdge(low: number, high: number): boolean {
  return low !== high;
}

export interface IdleFilterResult<T> {
  readonly shown: T[];
  /** How many rows the filter removed (0 when it removed none). */
  readonly hidden: number;
}

/**
 * "Hide idle channels" (DESIGN §5.4): drop rows whose channel has no edge in the capture.
 *
 * Assumptions and unsupported combinations:
 *   - `idle` holds only channels the capture on screen has; a row the capture does not
 *     have (a widened width, shown blank) is never hidden here.
 *   - A channel in `keep` (one carrying a decoder lane) is never hidden, so a decoder's
 *     annotations cannot vanish with a quiet chip-select line.
 *   - If every row would be hidden, none is: a capture with no edges anywhere still shows
 *     its rows instead of an empty plot.
 */
export function filterIdleRows<T extends { readonly index: number }>(
  rows: readonly T[], idle: ReadonlySet<number>, keep: ReadonlySet<number>,
): IdleFilterResult<T> {
  const shown = rows.filter((row) => !idle.has(row.index) || keep.has(row.index));
  if (shown.length === 0) return { shown: [...rows], hidden: 0 };
  return { shown, hidden: rows.length - shown.length };
}
