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
 *   - #plot       wheel per `wheelAction` (see below); Shift+wheel pans time; left drag
 *                 pans; left double-click adds a cursor.
 *   - #axis       wheel per `wheelAction`; Shift+wheel pans time; left drag pans.
 *   - #overview   wheel per `wheelAction`; Shift+wheel pans the timeline; left click or
 *                 drag centers the viewport.
 *   - #labels-spacer (the corner cell, DESIGN §3.4) click Fit fits the view; the wheel
 *                 over Fit zooms with or without Ctrl and Shift+wheel pans
 *                 (`fitWheelAction`); clicking the capture summary opens the Capture
 *                 panel; clicking + Decoder opens the Decoders panel. It sits inside
 *                 #labels-col, so it is matched first.
 *   - #labels-col wheel scrolls the row stack; double-clicking a name renames it; the
 *                 trigger slot opens the trigger editor.
 *   - #side-panel wheel scrolls the panel.
 *   - #toolbar    a click activates the command.
 *
 * The wheel over the plot, axis and overview is decided by `wheelAction` (wheelGesture.ts),
 * which the handlers call too, so the three wheel variants below are the only ones:
 *
 *   - rows overflow, "wheel zooms" off: wheel scrolls rows, Ctrl+wheel zooms;
 *   - rows all fit,  "wheel zooms" off: wheel zooms (nothing to scroll);
 *   - "wheel zooms" on:                 wheel zooms, Ctrl+wheel scrolls rows.
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
import { fitWheelAction, wheelAction } from './wheelGesture.js';

export const INTERACTION_AREAS = [
  'none', 'toolbar', 'labels', 'plot', 'axis', 'overview', 'side-panel', 'corner',
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
  /** The "wheel zooms without Ctrl" preference; default off. */
  readonly wheelZooms?: boolean;
  /** Whether the row stack overflows vertically; default true (a plain wheel scrolls). */
  readonly rowsOverflow?: boolean;
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
  Object.freeze({ area: 'corner', selector: '#labels-spacer' }),
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
    case 'corner': return 'hints.area.corner';
    case 'none': return 'hints.area.none';
  }
}

function hint(
  key: MessageKey, mouse: MousePart, ...modifiers: MouseModifier[]
): HintSpec {
  return Object.freeze({ key, mouse, modifiers: Object.freeze(modifiers) });
}

const NO_CAPTURE = hint('hints.noCapture', 'none');

const PLOT_NO_CAPTURE = Object.freeze([
  NO_CAPTURE,
  hint('hints.plot.scroll', 'wheel'),
]);

const AXIS_NO_CAPTURE = Object.freeze([
  NO_CAPTURE,
  hint('hints.axis.scroll', 'wheel'),
]);

const OVERVIEW_NO_CAPTURE = Object.freeze([
  NO_CAPTURE,
  hint('hints.overview.scroll', 'wheel'),
]);

type WheelArea = 'plot' | 'axis' | 'overview';
type WheelVariant = 'scroll' | 'fit' | 'wheelZooms';

const WHEEL_KEYS: Readonly<Record<WheelArea, { scroll: MessageKey; zoom: MessageKey; pan: MessageKey }>> = {
  plot: { scroll: 'hints.plot.scroll', zoom: 'hints.plot.zoom', pan: 'hints.plot.pan' },
  axis: { scroll: 'hints.axis.scroll', zoom: 'hints.axis.zoom', pan: 'hints.axis.pan' },
  overview: { scroll: 'hints.overview.scroll', zoom: 'hints.overview.zoom', pan: 'hints.overview.pan' },
};

const POINTER_HINTS: Readonly<Record<WheelArea, readonly HintSpec[]>> = {
  plot: [hint('hints.plot.dragPan', 'left'), hint('hints.plot.addCursor', 'left')],
  axis: [hint('hints.axis.dragPan', 'left')],
  overview: [hint('hints.overview.center', 'left')],
};

/** The wheel hints for one area and variant, read off `wheelAction` itself. */
function wheelHints(area: WheelArea, variant: WheelVariant): readonly HintSpec[] {
  const ctx = {
    hasCapture: true, wheelZooms: variant === 'wheelZooms', rowsOverflow: variant !== 'fit',
  };
  const keys = WHEEL_KEYS[area];
  const out: HintSpec[] = [];
  const plain = wheelAction({ ctrlKey: false, shiftKey: false }, ctx);
  const ctrl = wheelAction({ ctrlKey: true, shiftKey: false }, ctx);
  if (plain === 'zoom') out.push(hint(keys.zoom, 'wheel'));
  else out.push(hint(keys.scroll, 'wheel'));
  // A Ctrl variant that repeats the plain wheel is not worth a second hint.
  if (ctrl === 'scroll-rows') out.push(hint('hints.wheel.scrollRows', 'wheel', 'Ctrl'));
  else if (ctrl === 'zoom' && plain !== 'zoom') out.push(hint(keys.zoom, 'wheel', 'Ctrl'));
  if (wheelAction({ ctrlKey: false, shiftKey: true }, ctx) === 'pan') {
    out.push(hint(keys.pan, 'wheel', 'Shift'));
  }
  return Object.freeze([...out, ...POINTER_HINTS[area]]);
}

const WHEEL_CAPTURE: Readonly<Record<WheelArea, Readonly<Record<WheelVariant, readonly HintSpec[]>>>> =
  Object.freeze(Object.fromEntries((['plot', 'axis', 'overview'] as const).map((area) => [
    area,
    Object.freeze({
      scroll: wheelHints(area, 'scroll'),
      fit: wheelHints(area, 'fit'),
      wheelZooms: wheelHints(area, 'wheelZooms'),
    }),
  ])) as Record<WheelArea, Record<WheelVariant, readonly HintSpec[]>>);

function wheelVariant(context: InteractionContext): WheelVariant {
  if (context.wheelZooms === true) return 'wheelZooms';
  return context.rowsOverflow === false ? 'fit' : 'scroll';
}

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

/** The corner's Fit wheel hints, read off `fitWheelAction` like the other wheel areas. */
function cornerWheelHints(): HintSpec[] {
  const out: HintSpec[] = [];
  const plain = fitWheelAction({ ctrlKey: false, shiftKey: false }, true);
  const ctrl = fitWheelAction({ ctrlKey: true, shiftKey: false }, true);
  if (plain === 'zoom') out.push(hint('hints.corner.zoom', 'wheel'));
  if (ctrl === 'zoom' && plain !== 'zoom') out.push(hint('hints.corner.zoom', 'wheel', 'Ctrl'));
  if (fitWheelAction({ ctrlKey: false, shiftKey: true }, true) === 'pan') {
    out.push(hint('hints.corner.pan', 'wheel', 'Shift'));
  }
  return out;
}

const CORNER_PANELS = [
  hint('hints.corner.summary', 'left'),
  hint('hints.corner.addDecoder', 'left'),
];

const CORNER_CAPTURE = Object.freeze([
  hint('hints.corner.fit', 'left'),
  ...cornerWheelHints(),
  ...CORNER_PANELS,
]);

/** Fit is disabled without a capture; the summary and + Decoder still open their panels. */
const CORNER_NO_CAPTURE = Object.freeze([NO_CAPTURE, ...CORNER_PANELS]);

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
    case 'plot':
      return context.hasCapture ? WHEEL_CAPTURE.plot[wheelVariant(context)] : PLOT_NO_CAPTURE;
    case 'axis':
      return context.hasCapture ? WHEEL_CAPTURE.axis[wheelVariant(context)] : AXIS_NO_CAPTURE;
    case 'overview':
      return context.hasCapture ? WHEEL_CAPTURE.overview[wheelVariant(context)] : OVERVIEW_NO_CAPTURE;
    case 'labels': return context.hasCapture ? LABELS_CAPTURE : LABELS_NO_CAPTURE;
    case 'side-panel': return SIDE_PANEL_HINTS;
    case 'corner': return context.hasCapture ? CORNER_CAPTURE : CORNER_NO_CAPTURE;
    case 'toolbar': return TOOLBAR_HINTS;
    case 'none': return GENERAL_HINTS;
  }
}
