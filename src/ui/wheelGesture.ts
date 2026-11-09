// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What one wheel event over the plot, time axis or overview strip does.
 *
 * The plot, axis and overview share this one decision so their handlers and the bottom
 * hint bar (`interactionHints`) cannot drift apart.
 *
 *   - Shift+wheel always pans time.
 *   - Default (`wheelZooms` off): Ctrl/⌘+wheel zooms time; a plain wheel only scrolls the
 *     row stack (when every row fits it does nothing) - it never zooms, so the setting is
 *     the one switch between the two habits.
 *   - "Wheel zooms" on (PulseView/sigrok habit): a plain wheel zooms time and
 *     Ctrl/⌘+wheel scrolls the row stack.
 *
 * Without a capture there is nothing to zoom or pan: a plain wheel keeps the browser's
 * scrolling, Ctrl+wheel is still swallowed so it never zooms the page, and with "wheel
 * zooms" on Ctrl+wheel scrolls rows exactly as it would with a capture.
 */

export interface WheelModifiers {
  readonly ctrlKey: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey: boolean;
}

export interface WheelContext {
  /** The persisted "wheel zooms without Ctrl" preference. */
  readonly wheelZooms: boolean;
  readonly hasCapture: boolean;
}

/**
 * - `zoom`        zoom time around the pointer
 * - `pan`         pan time
 * - `native`      do nothing; let the browser scroll the row stack
 * - `scroll-rows` swallow the event and scroll the row stack by its delta
 * - `block`       swallow the event (stops the browser's Ctrl+wheel page zoom)
 */
export type WheelAction = 'zoom' | 'pan' | 'native' | 'scroll-rows' | 'block';

export function wheelAction(mods: WheelModifiers, ctx: WheelContext): WheelAction {
  const ctrl = mods.ctrlKey || mods.metaKey === true;
  if (mods.shiftKey) return ctx.hasCapture ? 'pan' : 'block';
  if (ctrl) {
    if (ctx.wheelZooms) return 'scroll-rows';
    return ctx.hasCapture ? 'zoom' : 'block';
  }
  if (!ctx.hasCapture) return 'native';
  return ctx.wheelZooms ? 'zoom' : 'native';
}

/**
 * The wheel over the corner cell's Fit button (DESIGN §3.4): it is a zoom control, not a
 * row surface, so a plain wheel and Ctrl/⌘+wheel both zoom time and Shift+wheel pans,
 * whatever the "wheel zooms" preference. Without a capture the usual rules hold: a plain
 * wheel stays native scrolling and Ctrl/Shift are swallowed.
 */
export function fitWheelAction(mods: WheelModifiers, hasCapture: boolean): WheelAction {
  if (mods.shiftKey) return hasCapture ? 'pan' : 'block';
  const ctrl = mods.ctrlKey || mods.metaKey === true;
  if (!hasCapture) return ctrl ? 'block' : 'native';
  return 'zoom';
}

/** Pixels for one wheel event's vertical delta, whatever its `deltaMode`. */
export function wheelDeltaPixels(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * Math.max(1, pageHeight);
  return deltaY;
}
