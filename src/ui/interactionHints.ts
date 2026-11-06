// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The bottom interaction-hint bar's pure mapping.
 *
 * `interactionHints(area, context)` turns the area under the pointer into the exact
 * gestures that area's handlers implement. It is DOM-free and side-effect-free, so the
 * self-test can pin every area without a browser, and App is left with only rendering.
 *
 * The mapping is evidence-based: it is derived from the real handlers, not from what a
 * mouse could theoretically do.
 *
 *   - #plot       wheel scrolls the row stack (browser default); Ctrl+wheel zooms time;
 *                 Shift+wheel pans time; left drag pans; left double-click adds a cursor.
 *   - #axis       wheel scrolls the row stack; Ctrl+wheel zooms time; Shift+wheel pans
 *                 time; left drag pans.
 *   - #overview   wheel scrolls the row stack; Ctrl+wheel zooms the timeline; Shift+wheel
 *                 pans it; left click or drag centers the viewport.
 *   - #labels-col wheel scrolls the row stack; double-clicking a name renames it; the
 *                 trigger slot opens the trigger editor.
 *   - #side-panel wheel scrolls the panel.
 *   - #toolbar    a click activates the command.
 *
 * The axis and overview strip require Ctrl for zoom and Shift for pan for the same reason
 * the plot does: an unmodified wheel keeps scrolling channels, which is the gesture users
 * expect over any part of the row stack.
 *
 * Assumptions and unsupported combinations:
 *
 *   - Zoom, pan and cursor gestures are unavailable before a capture exists. The no-
 *     capture mapping still lists the scroll that works and says how to get a capture,
 *     rather than advertising gestures that would be no-ops.
 *   - `right` is part of `MousePart` for completeness; no area implements a right-click
 *     gesture today, so no mapping returns it.
 *   - `running` is accepted because callers know it, but no current hint depends on it:
 *     the same gestures stay available while a capture runs.
 */

import type { MessageKey } from './i18n.js';

export const INTERACTION_AREAS = [
  'none', 'toolbar', 'labels', 'plot', 'axis', 'overview', 'side-panel',
] as const;

export type InteractionArea = (typeof INTERACTION_AREAS)[number];

/** Which part of the mouse glyph the hint highlights. */
export type MousePart = 'wheel' | 'left' | 'right' | 'none';

/** Modifier keycap drawn before the mouse glyph. */
export type MouseModifier = 'Ctrl' | 'Shift';

export interface InteractionContext {
  readonly hasCapture: boolean;
  /** Accepted for callers that want state-dependent hints later; currently unused. */
  readonly running?: boolean;
}

export interface HintSpec {
  /** Catalog key for the readable instruction. */
  readonly key: MessageKey;
  /** Mouse part to highlight in the inline glyph. */
  readonly mouse: MousePart;
  /** Keycaps drawn in order before the glyph. */
  readonly modifiers: readonly MouseModifier[];
}

/** Catalog keys naming each mouse part for the glyph's accessible name. */
export const MOUSE_PART_LABEL_KEYS: Readonly<Record<Exclude<MousePart, 'none'>, MessageKey>> =
  Object.freeze({
    wheel: 'hints.mouse.wheel',
    left: 'hints.mouse.left',
    right: 'hints.mouse.right',
  });

export interface InteractionAreaSelector {
  readonly area: InteractionArea;
  readonly selector: string;
}

/**
 * The DOM elements that define each hover area. App walks this list with `closest()`;
 * the self-test uses the same list with a stub element, so the selector set cannot
 * drift from the mapping.
 */
export const INTERACTION_AREA_SELECTORS: readonly InteractionAreaSelector[] = Object.freeze([
  Object.freeze({ area: 'plot', selector: '#plot' }),
  Object.freeze({ area: 'axis', selector: '#axis' }),
  Object.freeze({ area: 'overview', selector: '#overview' }),
  Object.freeze({ area: 'labels', selector: '#labels-col' }),
  Object.freeze({ area: 'side-panel', selector: '#side-panel' }),
  Object.freeze({ area: 'toolbar', selector: '#toolbar' }),
]);

/** The structural slice of `Element` the area lookup needs - no document required. */
export interface ClosestLike {
  closest(selector: string): unknown;
}

/** The first matching area in selector order, or `none` outside every tracked area. */
export function interactionAreaOf(target: ClosestLike | null): InteractionArea {
  if (target === null) return 'none';
  for (const entry of INTERACTION_AREA_SELECTORS) {
    if (target.closest(entry.selector)) return entry.area;
  }
  return 'none';
}

/** The bar's leading area label. */
export function interactionAreaLabelKey(area: InteractionArea): MessageKey {
  switch (area) {
    case 'toolbar': return 'hints.area.toolbar';
    case 'labels': return 'hints.area.labels';
    case 'plot': return 'hints.area.plot';
    case 'axis': return 'hints.area.axis';
    case 'overview': return 'hints.area.overview';
    case 'side-panel': return 'hints.area.sidePanel';
    case 'none': return 'hints.area.none';
  }
}

function hint(
  key: MessageKey, mouse: MousePart, ...modifiers: MouseModifier[]
): HintSpec {
  return Object.freeze({ key, mouse, modifiers: Object.freeze(modifiers) });
}

const NO_CAPTURE = hint('hints.noCapture', 'none');

const PLOT_CAPTURE = Object.freeze([
  hint('hints.plot.scroll', 'wheel'),
  hint('hints.plot.zoom', 'wheel', 'Ctrl'),
  hint('hints.plot.pan', 'wheel', 'Shift'),
  hint('hints.plot.dragPan', 'left'),
  hint('hints.plot.addCursor', 'left'),
]);

const PLOT_NO_CAPTURE = Object.freeze([
  NO_CAPTURE,
  hint('hints.plot.scroll', 'wheel'),
]);

const AXIS_CAPTURE = Object.freeze([
  hint('hints.axis.scroll', 'wheel'),
  hint('hints.axis.zoom', 'wheel', 'Ctrl'),
  hint('hints.axis.pan', 'wheel', 'Shift'),
  hint('hints.axis.dragPan', 'left'),
]);

const AXIS_NO_CAPTURE = Object.freeze([
  NO_CAPTURE,
  hint('hints.axis.scroll', 'wheel'),
]);

const OVERVIEW_CAPTURE = Object.freeze([
  hint('hints.overview.scroll', 'wheel'),
  hint('hints.overview.zoom', 'wheel', 'Ctrl'),
  hint('hints.overview.pan', 'wheel', 'Shift'),
  hint('hints.overview.center', 'left'),
]);

const OVERVIEW_NO_CAPTURE = Object.freeze([
  NO_CAPTURE,
  hint('hints.overview.scroll', 'wheel'),
]);

const LABELS_CAPTURE = Object.freeze([
  hint('hints.labels.scroll', 'wheel'),
  hint('hints.labels.rename', 'left'),
  hint('hints.labels.trigger', 'left'),
]);

const LABELS_NO_CAPTURE = Object.freeze([
  hint('hints.labels.scroll', 'wheel'),
  hint('hints.labels.rename', 'left'),
  hint('hints.labels.trigger', 'left'),
]);

const SIDE_PANEL_HINTS = Object.freeze([
  hint('hints.sidePanel.scroll', 'wheel'),
]);

const TOOLBAR_HINTS = Object.freeze([
  hint('hints.toolbar.activate', 'left'),
]);

const GENERAL_HINTS = Object.freeze([
  hint('hints.general', 'none'),
]);

/** The deterministic hint list for an area and capture state. */
export function interactionHints(
  area: InteractionArea, context: InteractionContext,
): readonly HintSpec[] {
  switch (area) {
    case 'plot': return context.hasCapture ? PLOT_CAPTURE : PLOT_NO_CAPTURE;
    case 'axis': return context.hasCapture ? AXIS_CAPTURE : AXIS_NO_CAPTURE;
    case 'overview': return context.hasCapture ? OVERVIEW_CAPTURE : OVERVIEW_NO_CAPTURE;
    case 'labels': return context.hasCapture ? LABELS_CAPTURE : LABELS_NO_CAPTURE;
    case 'side-panel': return SIDE_PANEL_HINTS;
    case 'toolbar': return TOOLBAR_HINTS;
    case 'none': return GENERAL_HINTS;
  }
}
