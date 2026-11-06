// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M1 presenter and window-class contract (docs/DESIGN.md §3, §10;
 * docs/ARCHITECTURE.md §6).
 *
 * This module is DOM-free. The only mutation it performs is freezing the panel view
 * model it is handed, which is how the immutable-view-model invariant is enforced at
 * runtime as well as in the type system.
 *
 * It states the layout grammar as data and as pure functions:
 *
 *   - `windowClassForWidth` and `decidePresenter` map a viewport and pointer class to a
 *     `WindowClass` and the preferred presenter, with a stable reason code.
 *   - `openPresenter` enforces one presenter instance per layout: opening another
 *     presenter replaces the active one, so two instances never coexist.
 *   - `PanelViewModel` is deeply readonly, and every view passed to `openPresenter` is
 *     deep-frozen.
 *
 * Assumptions and unsupported combinations:
 *
 *   - The window class depends on width only. `heightPx` caps the sheet height
 *     (`min(72dvh, viewport - 96px)`, DESIGN §3.1) and never selects a class, so
 *     portrait and landscape of the same width share one grammar.
 *   - A wide layout docks even when the active pointer is touch: DESIGN §3.1 gives Wide
 *     a docked presenter column, and §3.3 only carves out Medium touch. A medium
 *     non-touch layout docks; only medium touch and every compact width use a sheet.
 *     Compact uses a sheet regardless of pointer.
 *   - `keyboard` is not a pointing grammar and follows the non-touch branch: it never
 *     forces the large-target sheet a touch layout needs.
 *   - A dialog is requested explicitly (a destructive/complex confirmation, or a panel
 *     that must block the plot), never derived from width. ARCHITECTURE §6 gives one
 *     view model three presenters, so a dialog takes the same single presenter slot as
 *     Docked or Sheet.
 *   - Crossing a width breakpoint is caller-driven: recompute `decidePresenter` and
 *     `openPresenter` with the same view model. The single-slot transition replaces the
 *     presenter, so a docked panel cannot linger behind a sheet (or the reverse).
 *   - Touch layouts require 48x48 CSS px targets (`TOUCH_TARGET_PX`), so a touch
 *     decision reports `minimumTargetPx: 48`; non-touch decisions report `null`. The
 *     in-row trigger slot's 24 px visual / 48 px hit-area exception belongs to the row,
 *     not to the presenter.
 *   - The sheet height is reported as a cap; the drag range between peek and full and
 *     the persisted per-panel height are shell state, not this contract.
 */

/** A layout grammar; DESIGN §3.1 fixes the breakpoints. */
export type WindowClass = 'wide' | 'medium' | 'compact';

/** The three presenters that render one panel view model (DESIGN §3.3). */
export type PresenterKind = 'docked' | 'sheet' | 'dialog';

/** Pointer grammar detected from the event, not from the device (DESIGN §3.2). */
export type PointerClass = 'mouse' | 'touch' | 'pen' | 'keyboard';

/** The explicit reasons a modal presenter can be requested. */
export type ModalReason = 'destructive-confirmation' | 'blocking-panel';

/**
 * Stable reason for the chosen presenter. Callers and i18n key off these codes; they
 * are not diagnostic prose.
 */
export type PresenterReason =
  | 'wide-docked'
  | 'medium-docked'
  | 'medium-touch-sheet'
  | 'compact-sheet'
  | 'modal-destructive-confirmation'
  | 'modal-blocking-panel';

/**
 * DESIGN §3.1 layout numbers, as data. All widths are CSS px.
 *
 * `plotMinWidthPx` is the floor the plot keeps in each class: the compact floor is
 * 240 px, and rows scroll horizontally below it. `dockedPresenterMinWidthPx` is the
 * Medium docked presenter floor. `compactLabelColumnPx` is the compact label column.
 * `sheetMaxHeightRatio`/`sheetMaxHeightInsetPx` define the sheet cap
 * `min(72dvh, viewport - 96px)`.
 */
export const LAYOUT_BREAKPOINTS = Object.freeze({
  wideMinWidthPx: 1000,
  mediumMinWidthPx: 760,
  plotMinWidthPx: Object.freeze({ wide: 480, medium: 480, compact: 240 } as const),
  dockedPresenterMinWidthPx: 280,
  compactLabelColumnPx: 104,
  sheetMaxHeightRatio: 0.72,
  sheetMaxHeightInsetPx: 96,
} as const);

/** DESIGN §3.2: touch layouts never show a control below 48x48 CSS px. */
export const TOUCH_TARGET_PX = 48;

/** The panels of ARCHITECTURE §6, declared once. */
export const PANEL_IDS = Object.freeze([
  'device',
  'acquire',
  'trigger',
  'measure',
  'analyze',
  'record',
  'settings',
  'diagnostics',
] as const);

/** One panel identity; the type is derived from the single `PANEL_IDS` declaration. */
export type PanelId = (typeof PANEL_IDS)[number];

/**
 * Recursively readonly view of presentation data. Functions are left callable; arrays
 * and objects become readonly at every level. `DeepReadonly` is type-level only; the
 * runtime half of the invariant is `freezePanelViewModel`.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * A presentation-ready panel view model. The same instance is rendered by Docked, Sheet
 * and Dialog; presenters do not re-derive values (DESIGN §10, ARCHITECTURE §6).
 *
 * `data` is deeply readonly and the whole model is deep-frozen by
 * `createPanelViewModel`/`freezePanelViewModel`. The presenter boundary erases the
 * concrete data type to `object`; panels keep their typed model.
 */
export interface PanelViewModel<Data extends object = object> {
  /** The one panel this model renders. */
  readonly panel: PanelId;
  /** The panel's single header, rendered once by every presenter. */
  readonly title: string;
  /** Presentation-ready values; never a second source of truth. */
  readonly data: DeepReadonly<Data>;
}

/** A viewport snapshot in CSS px. */
export interface Viewport {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** Everything the presenter choice depends on. */
export interface PresenterInput {
  readonly viewport: Viewport;
  readonly pointer: PointerClass;
  /**
   * Present when a modal presenter is required. Dialog is explicit, not a layout
   * result; it takes the single presenter slot.
   */
  readonly modal?: ModalReason;
}

/** The chosen presenter. */
export interface PresenterChoice {
  readonly kind: 'present';
  readonly windowClass: WindowClass;
  readonly presenter: PresenterKind;
  readonly reason: PresenterReason;
  /** The plot floor kept by this window class (DESIGN §3.1). */
  readonly plotMinWidthPx: number;
  /** `min(72dvh, viewport - 96px)` for a sheet; `null` for docked and dialog. */
  readonly sheetMaxHeightPx: number | null;
  /** 48 on touch; `null` when the pointer class has no minimum target. */
  readonly minimumTargetPx: number | null;
}

/** A malformed viewport is refused instead of guessing a layout. */
export interface PresenterRefusal {
  readonly kind: 'refuse';
  readonly reason: 'invalid-viewport';
  readonly detail: string;
}

export type PresenterDecision = PresenterChoice | PresenterRefusal;

/**
 * A single mounted presenter instance. `view` is frozen before the instance exists.
 */
export interface PresenterInstance {
  readonly id: number;
  readonly presenter: PresenterKind;
  readonly windowClass: WindowClass;
  readonly reason: PresenterReason;
  readonly view: PanelViewModel;
}

/**
 * The presenter slot of one layout. `active` is a single instance, not a stack/collection:
 * DESIGN §3.3 and §10 allow one presenter at a time.
 */
export interface PresenterLayoutState {
  readonly active: PresenterInstance | null;
  /** Monotonic id source; ids of closed instances are never reused. */
  readonly nextInstanceId: number;
}

export interface PresenterOpened {
  readonly kind: 'opened';
  readonly layout: PresenterLayoutState;
  readonly instance: PresenterInstance;
  /** The instance this open replaced; it is no longer mounted. */
  readonly replaced: PresenterInstance | null;
}

export interface PresenterClosed {
  readonly kind: 'closed' | 'unchanged';
  readonly layout: PresenterLayoutState;
  readonly closed: PresenterInstance | null;
}

/** Map a positive finite CSS px width to the DESIGN §3.1 window class. */
export function windowClassForWidth(widthPx: number): WindowClass {
  if (!Number.isFinite(widthPx) || widthPx <= 0) {
    throw new RangeError(
      `widthPx must be a positive finite CSS px value, got ${String(widthPx)}`,
    );
  }
  if (widthPx >= LAYOUT_BREAKPOINTS.wideMinWidthPx) return 'wide';
  if (widthPx >= LAYOUT_BREAKPOINTS.mediumMinWidthPx) return 'medium';
  return 'compact';
}

/**
 * The DESIGN §3.1 sheet cap `min(72dvh, viewport - 96px)`, clamped at zero for very
 * short viewports. A non-positive/non-finite height has no sheet and reports 0.
 */
export function sheetMaxHeightPx(viewportHeightPx: number): number {
  if (!Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0) return 0;
  const dvhCap = viewportHeightPx * LAYOUT_BREAKPOINTS.sheetMaxHeightRatio;
  const viewportCap = viewportHeightPx - LAYOUT_BREAKPOINTS.sheetMaxHeightInsetPx;
  return Math.max(0, Math.min(dvhCap, viewportCap));
}

/**
 * Choose the window class and preferred presenter for a viewport and pointer class.
 *
 * Precedence: an explicit modal first (dialog on every class), then compact (always a
 * sheet), then medium touch (sheet), then wide/medium non-touch (docked). Invalid
 * viewports are refused with `invalid-viewport`.
 */
export function decidePresenter(input: PresenterInput): PresenterDecision {
  const { viewport, pointer } = input;
  const invalid = viewportError(viewport);
  if (invalid !== null) return invalidViewport(invalid);

  const windowClass = windowClassForWidth(viewport.widthPx);

  if (input.modal !== undefined) {
    return choice(
      windowClass,
      'dialog',
      input.modal === 'destructive-confirmation'
        ? 'modal-destructive-confirmation'
        : 'modal-blocking-panel',
      pointer,
      viewport.heightPx,
    );
  }

  if (windowClass === 'compact') {
    return choice(windowClass, 'sheet', 'compact-sheet', pointer, viewport.heightPx);
  }

  if (windowClass === 'medium' && pointer === 'touch') {
    return choice(windowClass, 'sheet', 'medium-touch-sheet', pointer, viewport.heightPx);
  }

  return windowClass === 'wide'
    ? choice(windowClass, 'docked', 'wide-docked', pointer, viewport.heightPx)
    : choice(windowClass, 'docked', 'medium-docked', pointer, viewport.heightPx);
}

/**
 * Build a deeply readonly, deep-frozen panel view model. A blank header is refused
 * because each panel has exactly one header naming its scope (DESIGN §10).
 */
export function createPanelViewModel<Data extends object>(
  panel: PanelId,
  title: string,
  data: Data,
): PanelViewModel<Data> {
  if (title.trim().length === 0) {
    throw new RangeError('a panel view model needs a single non-empty header');
  }
  const view: PanelViewModel<Data> = {
    panel,
    title,
    data: data as unknown as DeepReadonly<Data>,
  };
  return freezePanelViewModel(view);
}

/**
 * Deep-freeze a view model in place and return it. Idempotent; already-frozen views pass
 * through. Freezing the caller's object is deliberate: the same immutable model must be
 * safe to hand to all three presenters.
 */
export function freezePanelViewModel<Data extends object>(
  view: PanelViewModel<Data>,
): PanelViewModel<Data> {
  deepFreeze(view);
  return view;
}

/** The empty presenter slot of a fresh layout: zero instances. */
export function createPresenterLayout(): PresenterLayoutState {
  return Object.freeze({ active: null, nextInstanceId: 1 });
}

/** 0 or 1; the layout structurally cannot hold a second instance. */
export function presenterInstanceCount(layout: PresenterLayoutState): 0 | 1 {
  return layout.active === null ? 0 : 1;
}

/**
 * Open a presenter in the layout's single slot. Any active instance is replaced in the
 * same transition and returned as `replaced`; the previous state is left untouched.
 * The view model is deep-frozen before the instance is created.
 */
export function openPresenter(
  layout: PresenterLayoutState,
  decision: PresenterChoice,
  view: PanelViewModel,
): PresenterOpened {
  const instance: PresenterInstance = Object.freeze({
    id: layout.nextInstanceId,
    presenter: decision.presenter,
    windowClass: decision.windowClass,
    reason: decision.reason,
    view: freezePanelViewModel(view),
  });
  const next = Object.freeze({
    active: instance,
    nextInstanceId: layout.nextInstanceId + 1,
  });
  return Object.freeze({
    kind: 'opened',
    layout: next,
    instance,
    replaced: layout.active,
  });
}

/**
 * Close the active presenter. With `instanceId`, a stale id (a close from an invoker
 * whose instance was already replaced) is ignored; without it, the active instance is
 * closed, which is the back/close-button path. Closing an empty layout is `unchanged`.
 */
export function closePresenter(
  layout: PresenterLayoutState,
  instanceId?: number,
): PresenterClosed {
  const active = layout.active;
  if (active === null || (instanceId !== undefined && instanceId !== active.id)) {
    return Object.freeze({ kind: 'unchanged', layout, closed: null });
  }
  const next = Object.freeze({ active: null, nextInstanceId: layout.nextInstanceId });
  return Object.freeze({ kind: 'closed', layout: next, closed: active });
}

// ---- internals ----------------------------------------------------------

function viewportError(viewport: Viewport): string | null {
  if (!Number.isFinite(viewport.widthPx) || viewport.widthPx <= 0) {
    return `viewport.widthPx must be a positive finite CSS px value, got ${String(viewport.widthPx)}`;
  }
  if (!Number.isFinite(viewport.heightPx) || viewport.heightPx <= 0) {
    return `viewport.heightPx must be a positive finite CSS px value, got ${String(viewport.heightPx)}`;
  }
  return null;
}

function invalidViewport(detail: string): PresenterRefusal {
  return Object.freeze({ kind: 'refuse', reason: 'invalid-viewport', detail });
}

function choice(
  windowClass: WindowClass,
  presenter: PresenterKind,
  reason: PresenterReason,
  pointer: PointerClass,
  viewportHeightPx: number,
): PresenterChoice {
  return Object.freeze({
    kind: 'present',
    windowClass,
    presenter,
    reason,
    plotMinWidthPx: LAYOUT_BREAKPOINTS.plotMinWidthPx[windowClass],
    sheetMaxHeightPx: presenter === 'sheet' ? sheetMaxHeightPx(viewportHeightPx) : null,
    minimumTargetPx: pointer === 'touch' ? TOUCH_TARGET_PX : null,
  });
}

/**
 * Freeze every object/array reachable from the view model. A `WeakSet` makes a cyclic
 * model harmless; a view model is expected to be a tree, but freezing must not hang.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  Object.freeze(object);
  for (const child of Object.values(object as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return value;
}
