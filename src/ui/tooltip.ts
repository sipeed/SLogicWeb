// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Themed hover tooltip layer. Native `title` tooltips cannot be styled, so this
 * module intercepts them at hover time: on `pointerover` of a titled element it
 * removes the `title` attribute (suppressing the native tooltip before its ~1 s
 * timer can fire), stashes the text, and shows a themed floating chip in the
 * browser top layer (`popover="manual"`, so tooltips also work inside the
 * `showModal()` channel dialog and above every other overlay). The attribute is
 * restored when the pointer actually leaves the anchor subtree.
 *
 * Sources of truth stay put: call sites keep assigning `title` (and i18n keeps
 * translating `data-i18n-title`); nothing migrates to `data-tooltip`.
 *
 * Event-model notes:
 * - Pointer events, never mouse events, and the disabled `#btn-connect`
 *   no-WebUSB hint is a hard requirement [MEASURED 2026-10-19, real-input
 *   spikes with a disabled <button>, Chrome 150 via CDP and Firefox 157 via
 *   WebDriver: both engines dispatch pointerover/pointerenter/pointermove and
 *   the mouse hover family, both dispatch pointerdown/pointerup, and neither
 *   dispatches mousedown/mouseup/click or focus events. So a parked press on a
 *   disabled control hides the chip through the ordinary `down` path]. An
 *   `elementFromPoint` retry covers engines that retarget instead.
 * - `pointerType === 'touch'` is ignored: a tap acts, it does not hover.
 * - Hide and unstash are separate: on pointerdown/Escape/scroll the chip hides
 *   but the attribute stays stashed while the pointer is parked on the anchor
 *   (restoring it could resurrect the native tooltip over a just-clicked
 *   control). Re-show is suppressed until a real leave.
 * - The keyboard path (`focusin` gated on `:focus-visible`, like the sheet's
 *   own focus rings) shows the chip WITHOUT stashing: browsers render no
 *   native tooltip on focus, and the attribute is an AT description that must
 *   not be deleted while a screen reader may be reading it.
 * - Panels rebuild via `replaceChildren()`; a stationary pointer then leaves a
 *   dead anchor behind. An rAF-throttled `pointermove` revalidates
 *   `anchor.isConnected` and dismisses.
 * - All listeners share one AbortController dropped by `disposeTooltip()`.
 *
 * The risky logic lives in the pure `tipTransition` state machine and the pure
 * `placeTooltip` / `titledAncestor` helpers so the node selftest can drive them
 * without a DOM; `initTooltip()` is only the DOM adapter.
 */

export const TOOLTIP = {
  showDelayMs: 400, // [CHOSEN] hover-intent delay, native-tooltip feel
  anchorGap: 6, // [CHOSEN] px between the anchor edge and the chip
  viewportMargin: 8, // [CHOSEN] px clamp margin to the viewport edges
} as const;

// ------------------------------------------------------------------ placement

export interface TooltipRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface TooltipSize {
  readonly width: number;
  readonly height: number;
}

export interface TooltipPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: 'below' | 'above';
}

/**
 * Below-centered by default; flips above when below overflows and above has
 * room; clamps to the viewport margins on both axes. The lower bound wins in
 * degenerate viewports (tip wider/taller than the viewport minus margins).
 */
export function placeTooltip(
  anchor: TooltipRect,
  tip: TooltipSize,
  viewport: TooltipSize,
): TooltipPlacement {
  const margin = TOOLTIP.viewportMargin;
  const belowTop = anchor.bottom + TOOLTIP.anchorGap;
  const aboveTop = anchor.top - TOOLTIP.anchorGap - tip.height;
  const fitsBelow = belowTop + tip.height <= viewport.height - margin;
  const fitsAbove = aboveTop >= margin;
  const side: TooltipPlacement['side'] = fitsBelow || !fitsAbove ? 'below' : 'above';
  const unclampedTop = side === 'below' ? belowTop : aboveTop;
  const top = Math.max(margin, Math.min(unclampedTop, viewport.height - margin - tip.height));
  const centered = anchor.left + (anchor.right - anchor.left) / 2 - tip.width / 2;
  const left = Math.max(margin, Math.min(centered, viewport.width - margin - tip.width));
  return { left, top, side };
}

// ------------------------------------------------------------ anchor resolution

/**
 * The nearest titled ancestor with non-empty text, or null. Empty titles
 * (`t()` can yield one) never anchor. Typed structurally so the selftest can
 * drive it with stubs.
 */
export function titledAncestor(start: Pick<Element, 'closest'> | null): Element | null {
  const el = start?.closest('[title]') ?? null;
  if (el === null) return null;
  return (el.getAttribute('title') ?? '').trim() === '' ? null : el;
}

// -------------------------------------------------------------- state machine

export type TipPhase = 'hidden' | 'pending' | 'visible';

export interface TipState {
  readonly phase: TipPhase;
  /** Opaque anchor handle — the adapter stores the Element, tests use stubs. */
  readonly anchor: unknown | null;
  /** We currently hold the anchor's `title` attribute (pointer path only). */
  readonly stashed: boolean;
  readonly pointerInside: boolean;
  readonly focusInside: boolean;
  /** Hidden by down/Escape/scroll while the pointer is parked; no re-show until leave. */
  readonly suppressed: boolean;
}

export type TipEvent =
  | { readonly type: 'enter'; readonly anchor: unknown }
  | { readonly type: 'leave' }
  | { readonly type: 'focus'; readonly anchor: unknown }
  | { readonly type: 'blur' }
  | { readonly type: 'down' }
  | { readonly type: 'escape' }
  /** Scroll and resize both mis-anchor the chip; same handling. */
  | { readonly type: 'scroll' }
  | { readonly type: 'timer' }
  /** External code set `title` on the anchor while we hold it. */
  | { readonly type: 'rewrite' }
  | { readonly type: 'anchorDied' };

export interface TipActions {
  readonly unstash: boolean;
  readonly stash: boolean;
  readonly updateText: boolean;
  readonly startTimer: boolean;
  readonly cancelTimer: boolean;
  readonly show: boolean;
  readonly hide: boolean;
}

const NONE: TipActions = {
  unstash: false, stash: false, updateText: false,
  startTimer: false, cancelTimer: false, show: false, hide: false,
};

const act = (p: Partial<TipActions>): TipActions => ({ ...NONE, ...p });

export const TIP_HIDDEN: TipState = {
  phase: 'hidden', anchor: null, stashed: false,
  pointerInside: false, focusInside: false, suppressed: false,
};

const cleanup = (s: TipState): { state: TipState; act: TipActions } => ({
  state: TIP_HIDDEN,
  act: act({ unstash: s.stashed, cancelTimer: true, hide: s.phase !== 'hidden' }),
});

/**
 * Pure transition function. The adapter executes the returned action flags in
 * this canonical order: unstash → stash → updateText → cancelTimer →
 * startTimer → hide → show.
 */
export function tipTransition(s: TipState, e: TipEvent): { state: TipState; act: TipActions } {
  switch (e.type) {
    case 'enter': {
      if (s.anchor === e.anchor) {
        if (s.pointerInside) return { state: s, act: NONE };
        const state: TipState = { ...s, pointerInside: true };
        if (s.suppressed) return { state, act: NONE };
        if (s.phase === 'hidden') {
          return {
            state: { ...state, phase: 'pending', stashed: true },
            act: act({ stash: !s.stashed, startTimer: true }),
          };
        }
        // Focus-owned and already visible: pointer entry only adds the stash
        // that suppresses the native tooltip during hover.
        return { state: { ...state, stashed: true }, act: s.stashed ? NONE : act({ stash: true }) };
      }
      // A different anchor: leave the old one first (restore its attribute
      // before stashing the next — nested titled carriers exist, e.g. the
      // analyzer × button inside its titled chip), then anchor the new one.
      const leaveActs = { unstash: s.stashed, cancelTimer: s.phase === 'pending' };
      const base: TipState = {
        anchor: e.anchor, stashed: true, pointerInside: true,
        focusInside: false, suppressed: false, phase: s.phase,
      };
      if (s.phase === 'visible') {
        // Tooltip tour: moving directly between titled elements re-anchors instantly.
        return { state: base, act: act({ ...leaveActs, stash: true, show: true }) };
      }
      return { state: { ...base, phase: 'pending' }, act: act({ ...leaveActs, stash: true, startTimer: true }) };
    }
    case 'leave': {
      if (s.anchor === null) return { state: s, act: NONE };
      if (s.focusInside && s.phase === 'visible') {
        // Keyboard focus still owns the anchor: keep the chip, restore the
        // attribute (no native tooltip fires on focus).
        return {
          state: { ...s, pointerInside: false, suppressed: false, stashed: false },
          act: act({ unstash: s.stashed, cancelTimer: false }),
        };
      }
      return cleanup(s);
    }
    case 'focus': {
      if (s.pointerInside && s.anchor !== null) {
        // The pointer owns an anchor; focus only matters for that same anchor.
        return e.anchor === s.anchor
          ? { state: { ...s, focusInside: true }, act: NONE }
          : { state: s, act: NONE };
      }
      if (s.anchor === e.anchor && s.focusInside) return { state: s, act: NONE };
      // Keyboard-owned anchor: immediate show, no stash (see module header).
      return {
        state: {
          phase: 'visible', anchor: e.anchor, stashed: false,
          pointerInside: false, focusInside: true, suppressed: false,
        },
        act: act({
          unstash: s.stashed,
          cancelTimer: s.phase === 'pending',
          hide: s.anchor !== null && s.anchor !== e.anchor,
          show: true,
        }),
      };
    }
    case 'blur': {
      if (!s.focusInside) return { state: s, act: NONE };
      if (s.pointerInside) return { state: { ...s, focusInside: false }, act: NONE };
      return cleanup(s);
    }
    case 'down':
    case 'escape':
    case 'scroll': {
      if (s.anchor === null) return { state: s, act: NONE };
      if (s.pointerInside) {
        // Pointer parked on the anchor: hide + suppress, stay stashed (module header).
        return {
          state: { ...s, phase: 'hidden', suppressed: true },
          act: act({ cancelTimer: true, hide: s.phase !== 'hidden' }),
        };
      }
      return cleanup(s);
    }
    case 'timer': {
      if (s.phase === 'pending' && s.pointerInside && !s.suppressed) {
        return { state: { ...s, phase: 'visible' }, act: act({ show: true }) };
      }
      return { state: s, act: NONE };
    }
    case 'rewrite': {
      if (s.anchor === null || !s.stashed) return { state: s, act: NONE };
      // Re-stash the new value (the observer fired because the attribute came
      // back) and refresh the visible text + layout.
      return { state: s, act: act({ stash: true, updateText: true }) };
    }
    case 'anchorDied': {
      if (s.anchor === null) return { state: s, act: NONE };
      // No unstash: the element is detached; restoring its attribute is pointless.
      return {
        state: TIP_HIDDEN,
        act: act({ cancelTimer: true, hide: s.phase !== 'hidden' }),
      };
    }
  }
}

// --------------------------------------------------------------- DOM adapter

let active = false;

/**
 * Install the singleton tooltip layer. Idempotent. Node-safe by construction:
 * nothing above this function touches the DOM at module scope.
 */
export function initTooltip(): void {
  if (active) return;
  active = true;

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('popover', 'manual');
  tip.setAttribute('role', 'tooltip');
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);

  const abort = new AbortController();
  const signal = abort.signal;
  let state: TipState = TIP_HIDDEN;
  let anchorEl: Element | null = null;
  let stashText = '';
  let timer = 0;
  let moveRaf = 0;

  // Watches the anchor while stashed; our own removeAttribute shows up here as
  // a null read and is skipped — only a non-null value is an external write.
  const observer = new MutationObserver(() => {
    if (anchorEl === null) return;
    if (anchorEl.getAttribute('title') === null) return;
    emit({ type: 'rewrite' });
  });

  const el = (): HTMLElement => tip;

  const doUnstash = (): void => {
    observer.disconnect();
    if (anchorEl !== null && anchorEl.getAttribute('title') === null) {
      anchorEl.setAttribute('title', stashText);
    }
  };

  const doStash = (): void => {
    if (anchorEl === null) return;
    stashText = anchorEl.getAttribute('title') ?? '';
    anchorEl.removeAttribute('title');
    observer.observe(anchorEl, { attributes: true, attributeFilter: ['title'] });
  };

  const anchorText = (): string =>
    state.stashed ? stashText : (anchorEl?.getAttribute('title') ?? '');

  const doShow = (): void => {
    if (anchorEl === null) return;
    el().textContent = anchorText();
    // Measure → position → reveal in one task: the popover renders at
    // opacity 0 (no .open yet) but is measurable, so there is no flash.
    if (!el().matches(':popover-open')) el().showPopover();
    const rect = anchorEl.getBoundingClientRect();
    const placement = placeTooltip(
      rect,
      { width: el().offsetWidth, height: el().offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    el().style.left = `${placement.left}px`;
    el().style.top = `${placement.top}px`;
    el().classList.add('open');
  };

  const doHide = (): void => {
    el().classList.remove('open');
    if (el().matches(':popover-open')) el().hidePopover();
  };

  const emit = (e: TipEvent): void => {
    const next = tipTransition(state, e);
    const a = next.act;
    if (a.unstash) doUnstash();
    // Adopt the event's anchor only when the transition took it: a `focus` that
    // the pointer path rejects keeps the old anchor, and moving `anchorEl` to
    // the focused element would strand the old attribute stashed for good.
    if ((e.type === 'enter' || e.type === 'focus') && next.state.anchor === e.anchor) {
      anchorEl = e.anchor as Element;
    }
    if (a.stash) doStash();
    state = next.state;
    if (a.updateText) {
      el().textContent = anchorText();
      if (state.phase === 'visible') doShow(); // re-lay out around the new text
    }
    if (a.cancelTimer) { clearTimeout(timer); timer = 0; }
    if (a.startTimer) {
      clearTimeout(timer);
      timer = window.setTimeout(() => emit({ type: 'timer' }), TOOLTIP.showDelayMs);
    }
    if (a.hide) doHide();
    if (a.show) doShow();
    if (state.anchor === null) anchorEl = null;
  };

  const onOver = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const target = e.target instanceof Element ? e.target : null;
    const anchor = titledAncestor(target)
      ?? titledAncestor(document.elementFromPoint(e.clientX, e.clientY));
    if (anchor !== null) emit({ type: 'enter', anchor });
  };

  const onOut = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    if (anchorEl === null || !state.pointerInside) return;
    if (!(e.target instanceof Node) || !anchorEl.contains(e.target)) return;
    const to = e.relatedTarget;
    if (to instanceof Node && anchorEl.contains(to)) return;
    emit({ type: 'leave' });
  };

  const onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    if (anchorEl === null || moveRaf !== 0) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (anchorEl !== null && !anchorEl.isConnected) emit({ type: 'anchorDied' });
    });
  };

  const onDown = (): void => emit({ type: 'down' });

  const onKey = (e: KeyboardEvent): void => {
    // Non-capture and never preventDefault/stopPropagation: the plot's own
    // Escape path keeps working; we only hide our chip.
    if (e.key === 'Escape') emit({ type: 'escape' });
  };

  const onFocusIn = (e: FocusEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const anchor = titledAncestor(target);
    // Mouse-click focus must not pop a tooltip; keyboard focus does.
    if (anchor === null || !anchor.matches(':focus-visible')) return;
    emit({ type: 'focus', anchor });
  };

  const onFocusOut = (e: FocusEvent): void => {
    if (anchorEl === null || !state.focusInside) return;
    const to = e.relatedTarget;
    if (to instanceof Node && anchorEl.contains(to)) return;
    emit({ type: 'blur' });
  };

  document.addEventListener('pointerover', onOver, { signal });
  document.addEventListener('pointerout', onOut, { signal });
  document.addEventListener('pointermove', onMove, { signal, passive: true });
  document.addEventListener('pointerdown', onDown, { signal, capture: true });
  document.addEventListener('keydown', onKey, { signal });
  document.addEventListener('focusin', onFocusIn, { signal });
  document.addEventListener('focusout', onFocusOut, { signal });
  window.addEventListener('scroll', () => emit({ type: 'scroll' }), { signal, capture: true, passive: true });
  window.addEventListener('resize', () => emit({ type: 'scroll' }), { signal, passive: true });

  disposer = (): void => {
    abort.abort();
    observer.disconnect();
    clearTimeout(timer);
    if (moveRaf !== 0) cancelAnimationFrame(moveRaf);
    doUnstash();
    tip.remove();
    state = TIP_HIDDEN;
    anchorEl = null;
    active = false;
    disposer = null;
  };
}

let disposer: (() => void) | null = null;

/** Tear down the singleton (symmetry with the lifecycle spec; no caller today). */
export function disposeTooltip(): void {
  disposer?.();
}
