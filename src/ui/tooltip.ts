export const TOOLTIP = {
  showDelayMs: 400,
  anchorGap: 6,
  viewportMargin: 8,
} as const;

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

export function titledAncestor(start: Pick<Element, 'closest'> | null): Element | null {
  const el = start?.closest('[title]') ?? null;
  if (el === null) return null;
  return (el.getAttribute('title') ?? '').trim() === '' ? null : el;
}

export type TipPhase = 'hidden' | 'pending' | 'visible';

export interface TipState {
  readonly phase: TipPhase;
  readonly anchor: unknown | null;
  readonly stashed: boolean;
  readonly pointerInside: boolean;
  readonly focusInside: boolean;
  readonly suppressed: boolean;
}

export type TipEvent =
  | { readonly type: 'enter'; readonly anchor: unknown }
  | { readonly type: 'leave' }
  | { readonly type: 'focus'; readonly anchor: unknown }
  | { readonly type: 'blur' }
  | { readonly type: 'down' }
  | { readonly type: 'escape' }
  | { readonly type: 'scroll' }
  | { readonly type: 'timer' }
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
        return { state: { ...state, stashed: true }, act: s.stashed ? NONE : act({ stash: true }) };
      }
      const leaveActs = { unstash: s.stashed, cancelTimer: s.phase === 'pending' };
      const base: TipState = {
        anchor: e.anchor, stashed: true, pointerInside: true,
        focusInside: false, suppressed: false, phase: s.phase,
      };
      if (s.phase === 'visible') {
        return { state: base, act: act({ ...leaveActs, stash: true, show: true }) };
      }
      return { state: { ...base, phase: 'pending' }, act: act({ ...leaveActs, stash: true, startTimer: true }) };
    }
    case 'leave': {
      if (s.anchor === null) return { state: s, act: NONE };
      if (s.focusInside && s.phase === 'visible') {
        return {
          state: { ...s, pointerInside: false, suppressed: false, stashed: false },
          act: act({ unstash: s.stashed, cancelTimer: false }),
        };
      }
      return cleanup(s);
    }
    case 'focus': {
      if (s.pointerInside && s.anchor !== null) {
        return e.anchor === s.anchor
          ? { state: { ...s, focusInside: true }, act: NONE }
          : { state: s, act: NONE };
      }
      if (s.anchor === e.anchor && s.focusInside) return { state: s, act: NONE };
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
      return { state: s, act: act({ stash: true, updateText: true }) };
    }
    case 'anchorDied': {
      if (s.anchor === null) return { state: s, act: NONE };
      return {
        state: TIP_HIDDEN,
        act: act({ cancelTimer: true, hide: s.phase !== 'hidden' }),
      };
    }
  }
}

let active = false;

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
    if ((e.type === 'enter' || e.type === 'focus') && next.state.anchor === e.anchor) {
      anchorEl = e.anchor as Element;
    }
    if (a.stash) doStash();
    state = next.state;
    if (a.updateText) {
      el().textContent = anchorText();
      if (state.phase === 'visible') doShow();
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
    if (e.key === 'Escape') emit({ type: 'escape' });
  };

  const onFocusIn = (e: FocusEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    const anchor = titledAncestor(target);
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

export function disposeTooltip(): void {
  disposer?.();
}
