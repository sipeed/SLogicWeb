// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The overview strip above the time axis: the whole retained capture compressed into a
 * density envelope, with the current viewport drawn as a frame.
 *
 * It lives on its own canvas in `#plot-col`, above (not inside) `#plot`, for the same
 * reason the axis does: the plot's pointer machinery, marker hit-testing and scroll
 * gestures must not see these events. Coordinates in the strip are purely proportional
 * to `store.length`; the main plot's device-pixel transform does not apply.
 *
 * Interaction follows HSync's verified overview: clicking or dragging centers the
 * viewport on the pointer's sample, while the wheel zooms around the pointer. The app
 * receives samples (store-relative) and owns the viewport, so `noteViewportIntent()` and
 * the renderer clamps stay in one place.
 *
 * The density is the share of the queried channels that are high in each column, with
 * gaps marked underneath. Columns are cached on the store identity, length, dropped
 * count, bin count and channel set, so panning, hovering and zooming redraw the frame
 * without querying the store again.
 */

import { GAP_BIT, type SampleStore } from '../data/index.js';
import { wheelSpanFactor } from '../render/index.js';
import { wheelAction, type WheelAction } from './wheelGesture.js';
import { canvasLabelMeasure, computeTicks, type TickLabelMetrics } from './timeAxis.js';

const OVERVIEW_TICK_FONT = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
/** Labels start this far right of their tick, CSS px. */
const OVERVIEW_LABEL_OFFSET = 3;
import type { CanvasPalette } from './canvasPalette.js';

export interface OverviewState {
  store: SampleStore;
  /** Channels to summarize; indices outside the store are ignored. */
  channels: readonly number[];
  /** Store-relative viewport, fractional samples allowed. */
  viewport: { start: number; end: number };
  /**
   * Store-relative extent the strip represents, normally the loop window. Fixed while a
   * loop runs so the strip's scale and frame stop following the retained length; the
   * density inside it rolls with the data. Defaults to the whole store.
   */
  windowStart?: number;
  windowSpan?: number;
  triggerSample: number | null;
  /** What the zero tick is called: Trigger when present, otherwise Start. */
  originLabel: string;
  /** Native tooltip for the viewport frame, e.g. "Showing -5 ms – 15 ms". */
  viewportTitle: string;
  /**
   * End of the data that is still changing, in store coordinates. Defaults to the store's
   * length. A Repeat composite's length includes the completed previous wave and stays
   * constant while the current wave fills, so the density cache must key on this frontier
   * instead or it serves the frame from before the fill began.
   */
  dataEnd?: number;
  palette: CanvasPalette;
}

export interface OverviewCallbacks {
  /** A viewport gesture began: clear follow mode and any repeat viewport anchor. */
  onIntent(): void;
  /** Center the viewport on this store-relative sample, preserving its span. */
  onCenter(sample: number): void;
  /** Move the viewport by this many samples, preserving its span. */
  onPan(samples: number): void;
  /** Multiply the visible span by `factor`, keeping `anchor` at its place. */
  onZoom(anchor: number, factor: number): void;
  /**
   * The shared wheel decision (wheelGesture.ts). Omitted: the default grammar with rows
   * overflowing - plain wheel scrolls, Ctrl zooms, Shift pans.
   */
  wheelAction?(event: WheelEvent): WheelAction;
  /** Scroll the channel stack by this wheel event (Ctrl+wheel with "wheel zooms" on). */
  onScrollRows?(event: WheelEvent): void;
}

export interface OverviewViewportBox {
  left: number;
  width: number;
}

/** The pointer's sample position in a strip of `width` CSS px showing `length` samples
 *  from `start`. */
export function overviewSampleFromPointer(
  clientX: number, stripLeft: number, stripWidth: number, length: number, start = 0,
): number {
  if (!(stripWidth > 0) || !(length > 0) || !Number.isFinite(clientX)) return start;
  const fraction = Math.min(1, Math.max(0, (clientX - stripLeft) / stripWidth));
  return start + fraction * length;
}

/**
 * The viewport frame in CSS px, clipped to the strip and given a 3 px minimum so a
 * deeply zoomed-in view stays visible.
 */
export function overviewViewportBox(
  start: number, end: number, length: number, width: number,
): OverviewViewportBox {
  if (!(length > 0) || !(width > 0)) return { left: 0, width: 0 };
  const toX = (sample: number): number => Math.min(width, Math.max(0, sample / length * width));
  const left = toX(start);
  const right = toX(end);
  const frameWidth = Math.max(3, right - left);
  return {
    left: Math.min(width - frameWidth, left),
    width: Math.min(width, frameWidth),
  };
}

export interface OverviewDensity {
  /** Share of queried channels with an edge in each column, 0..1: where the data moves. */
  density: Float32Array;
  /** Share of queried channels high in each column, 0..1: a quiet context floor. */
  high: Float32Array;
  /** Bit 0: at least one queried channel has a gap in this column. */
  gaps: Uint8Array;
}

/** Summarize `count` columns of the store over [start, end). Returns copies, not store
 *  scratch. A window that reaches past the retained data leaves the missing columns
 *  empty instead of stretching the existing ones. */
export function overviewDensity(
  store: SampleStore, channels: readonly number[], bins: number,
  start = 0, end = store.length,
): OverviewDensity {
  const count = Math.max(1, Math.min(8192, Math.round(bins)));
  const density = new Float32Array(count);
  const high = new Float32Array(count);
  const gaps = new Uint8Array(count);
  const span = end - start;
  const lo = Math.max(0, start);
  const hi = Math.min(store.length, end);
  if (store.length <= 0 || channels.length === 0 || !(span > 0) || hi <= lo) {
    return { density, high, gaps };
  }
  const columns = Math.max(1, Math.min(count, Math.round(count * (hi - lo) / span)));
  const offset = Math.min(count - 1, Math.max(0, Math.floor(count * (lo - start) / span)));
  let used = 0;
  for (const channel of channels) {
    if (channel < 0 || channel >= store.channelCount) continue;
    const view = store.query(channel, lo, hi, columns);
    const usedColumns = Math.min(columns, view.low.length, count - offset);
    for (let i = 0; i < usedColumns; i++) {
      const j = offset + i;
      density[j] = (density[j] ?? 0) + (view.edge[i] ?? 0);
      high[j] = (high[j] ?? 0) + (view.high[i] ?? 0);
      if (((view.packed[i] ?? 0) & GAP_BIT) !== 0) gaps[j] = 1;
    }
    used++;
  }
  if (used > 0) {
    for (let i = 0; i < count; i++) {
      density[i] = (density[i] ?? 0) / used;
      high[i] = (high[i] ?? 0) / used;
    }
  }
  return { density, high, gaps };
}

interface CachedDensity extends OverviewDensity {
  store: SampleStore;
  length: number;
  dataEnd: number;
  dropped: number;
  bins: number;
  start: number;
  end: number;
  channels: string;
}

/** Least time between two overview redraws. */
export const OVERVIEW_MIN_MS = 100;

let nextOverviewStoreId = 1;
const overviewStoreIds = new WeakMap<SampleStore, number>();

function overviewStoreId(store: SampleStore): number {
  let id = overviewStoreIds.get(store);
  if (id === undefined) {
    id = nextOverviewStoreId++;
    overviewStoreIds.set(store, id);
  }
  return id;
}

/** Everything the strip's pixels are a function of, as one comparable string. */
export function overviewSignature(
  state: OverviewState, widthCss: number, heightCss: number,
): string {
  const length = state.store.length;
  const palette = state.palette;
  return [
    overviewStoreId(state.store), length, state.store.droppedSamples, state.store.samplerate,
    state.dataEnd ?? length, state.windowStart ?? 0, state.windowSpan ?? length,
    state.viewport.start, state.viewport.end, state.channels.join(','),
    state.triggerSample ?? -1, state.originLabel, state.viewportTitle,
    Math.round(widthCss), Math.round(heightCss),
    palette.text, palette.text50, palette.selection, palette.warning, palette.noDataColor,
    palette.gridMinor, palette.axisTickMajor,
  ].join('|');
}

/** The strip's redraw clock: a changed signature, at most once per OVERVIEW_MIN_MS. */
export function overviewDue(
  lastSignature: string, lastRenderedAt: number, signature: string, nowMs: number,
  force = false,
): boolean {
  if (!force && nowMs - lastRenderedAt < OVERVIEW_MIN_MS) return false;
  return signature !== lastSignature;
}

export class OverviewStrip {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly labelMetrics: TickLabelMetrics = {
    measure: canvasLabelMeasure(() => this.ctx, OVERVIEW_TICK_FONT),
    offset: OVERVIEW_LABEL_OFFSET,
  };
  private state: OverviewState | null = null;
  private cached: CachedDensity | null = null;
  private widthCss = 0;
  private heightCss = 0;
  private dragging = false;
  private activePointer: number | null = null;
  private lastSignature = '';
  private lastRenderedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: OverviewCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('overview 2D context unavailable');
    this.ctx = ctx;
    this.syncSize();
    canvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
    canvas.addEventListener('pointermove', (event) => this.pointerMove(event));
    canvas.addEventListener('pointerup', (event) => this.pointerUp(event));
    canvas.addEventListener('pointercancel', (event) => this.pointerUp(event));
    canvas.addEventListener('wheel', (event) => this.wheelEvent(event), { passive: false });
  }

  /** Match the backing store to the CSS size and the current device pixel ratio. */
  syncSize(): void {
    const dpr = globalThis.devicePixelRatio || 1;
    this.widthCss = Math.max(1, this.canvas.clientWidth);
    this.heightCss = Math.max(1, this.canvas.clientHeight);
    const width = Math.max(1, Math.round(this.widthCss * dpr));
    const height = Math.max(1, Math.round(this.heightCss * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** True when the strip's inputs changed and its clock allows another redraw. */
  due(state: OverviewState, nowMs: number, force = false): boolean {
    return overviewDue(
      this.lastSignature, this.lastRenderedAt,
      overviewSignature(state, this.widthCss, this.heightCss), nowMs, force,
    );
  }

  render(state: OverviewState, nowMs = performance.now()): void {
    this.state = state;
    if (this.canvas.title !== state.viewportTitle) this.canvas.title = state.viewportTitle;
    this.syncSize();
    this.lastSignature = overviewSignature(state, this.widthCss, this.heightCss);
    this.lastRenderedAt = nowMs;
    const width = this.widthCss;
    const height = this.heightCss;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    const length = state.store.length;
    // A fixed window (the loop window while running) keeps the scale and frame from
    // following the retained length; without one the whole store is the strip.
    const windowStart = state.windowStart ?? 0;
    const windowSpan = state.windowSpan ?? length;
    if (length <= 0 || !(windowSpan > 0)) return;
    const windowEnd = windowStart + windowSpan;

    const bins = Math.max(1, Math.min(8192, Math.round(width)));
    const data = this.densityFor(state, bins, windowStart, windowEnd);
    // The bottom 16 px is the fixed time scale; the envelope and frame live above it.
    const densityBottom = Math.max(8, height - 16);
    const base = Math.max(1, densityBottom - 3);

    // Unknown spans (USB dropouts) first, as a quiet floor under the envelope.
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = state.palette.noDataColor;
    for (let i = 0; i < bins; i++) {
      if (data.gaps[i]) ctx.fillRect(i, 0, 1, densityBottom);
    }
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = state.palette.text;
    for (let i = 0; i < bins; i++) {
      const share = data.high[i]!;
      if (share <= 0) continue;
      const bar = Math.max(1, share * base);
      ctx.fillRect(i, densityBottom - 1 - bar, 1, bar);
    }
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = state.palette.selection;
    for (let i = 0; i < bins; i++) {
      const share = data.density[i]!;
      if (share <= 0) continue;
      const bar = Math.max(1, share * base);
      ctx.fillRect(i, densityBottom - 1 - bar, 1, bar);
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = state.palette.gridMinor;
    ctx.fillRect(0, densityBottom, width, 1);

    const box = overviewViewportBox(
      state.viewport.start - windowStart, state.viewport.end - windowStart,
      windowSpan, width,
    );
    if (box.width > 0) {
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = state.palette.text;
      ctx.fillRect(box.left, 1, box.width, Math.max(1, densityBottom - 3));
      ctx.globalAlpha = 1;
      ctx.strokeStyle = state.palette.text;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.left + 0.75, 1.75, Math.max(0, box.width - 1.5),
        Math.max(0, densityBottom - 4.5));
    }
    if (state.triggerSample !== null &&
        state.triggerSample >= windowStart && state.triggerSample <= windowEnd) {
      const x = Math.min(width - 1, Math.max(0,
        (state.triggerSample - windowStart) / windowSpan * width));
      ctx.fillStyle = state.palette.warning;
      ctx.fillRect(Math.round(x), 0, 1, densityBottom);
    }

    // The fixed scale: major ticks of the whole capture, trigger-relative like the axis.
    // 12 px minor spacing puts major labels about 120 px apart, the overview's reading
    // granularity; the axis below carries the finer time grid. Labels are measured in
    // this strip's font; a label the layout dropped (it would collide, or run past the
    // right edge) stays blank.
    const samplerate = state.store.samplerate;
    if (samplerate > 0) {
      const origin = state.triggerSample ?? 0;
      const ticks = computeTicks(
        (windowStart - origin) / samplerate * 1e12,
        (windowEnd - origin) / samplerate * 1e12,
        width, samplerate, 12, this.labelMetrics,
      );
      ctx.font = OVERVIEW_TICK_FONT;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      const labelY = height - 3;
      const drawTick = (x: number, label: string, origin = false): void => {
        const px = Math.round(x);
        ctx.fillStyle = state.palette.axisTickMajor;
        ctx.fillRect(px, densityBottom + 1, 1, 3);
        ctx.fillStyle = origin ? state.palette.text : state.palette.text50;
        ctx.fillText(label, px + OVERVIEW_LABEL_OFFSET, labelY);
      };
      // A base time (only far from the origin): the major labels are offsets from it.
      if (ticks.pinned) drawTick(0, ticks.pinned.label);
      for (const tick of ticks.ticks) {
        if (!tick.major || tick.label === '' || tick.x > width - 1) continue;
        const origin = Math.abs(tick.ps) < 1e-6;
        drawTick(tick.x, origin ? state.originLabel : tick.label, origin);
      }
    }
    ctx.globalAlpha = 1;
  }

  private densityFor(state: OverviewState, bins: number, start: number, end: number): OverviewDensity {
    const channels = state.channels.join(',');
    const dataEnd = state.dataEnd ?? state.store.length;
    const cached = this.cached;
    if (cached && cached.store === state.store && cached.length === state.store.length &&
        cached.dataEnd === dataEnd &&
        cached.dropped === state.store.droppedSamples && cached.bins === bins &&
        cached.start === start && cached.end === end && cached.channels === channels) {
      return cached;
    }
    const next = overviewDensity(state.store, state.channels, bins, start, end);
    this.cached = {
      ...next,
      store: state.store,
      length: state.store.length,
      dataEnd,
      dropped: state.store.droppedSamples,
      bins,
      start,
      end,
      channels,
    };
    return next;
  }

  private sampleAt(clientX: number): number {
    const state = this.state;
    if (!state) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const start = state.windowStart ?? 0;
    const span = state.windowSpan ?? state.store.length;
    return overviewSampleFromPointer(
      clientX, rect.left, rect.width || this.widthCss, span, start,
    );
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.state || this.state.store.length <= 0) return;
    event.preventDefault();
    this.dragging = true;
    this.activePointer = event.pointerId;
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    this.cb.onIntent();
    this.cb.onCenter(this.sampleAt(event.clientX));
  }

  private pointerMove(event: PointerEvent): void {
    if (!this.dragging || event.pointerId !== this.activePointer) return;
    event.preventDefault();
    this.cb.onCenter(this.sampleAt(event.clientX));
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.dragging || event.pointerId !== this.activePointer) return;
    this.dragging = false;
    this.activePointer = null;
    try { this.canvas.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }

  private wheelEvent(event: WheelEvent): void {
    // The plot's grammar: by default an unmodified wheel lets the page scroll the channel
    // stack, Ctrl zooms time and Shift pans it. Stop the browser's page zoom before
    // checking for data: with no capture loaded the strip is still under the pointer, and
    // letting Ctrl+wheel through zooms the page.
    const state = this.state;
    const action = this.cb.wheelAction?.(event) ?? wheelAction(event, {
      wheelZooms: false, rowsOverflow: true, hasCapture: !!state && state.store.length > 0,
    });
    if (action === 'native') return;
    event.preventDefault();
    if (action === 'block') return;
    if (action === 'scroll-rows') {
      this.cb.onScrollRows?.(event);
      return;
    }
    if (!state || state.store.length <= 0) return;
    if (action === 'zoom') {
      if (event.deltaY === 0) return;
      const physical = event.deltaX === 0 && Math.abs(event.deltaY) >= 100 &&
        Number.isInteger(event.deltaY);
      this.cb.onIntent();
      this.cb.onZoom(this.sampleAt(event.clientX),
        wheelSpanFactor(event.deltaY, { isPhysicalWheel: physical, shift: false }));
      return;
    }
    const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width || this.widthCss;
    const span = state.windowSpan ?? state.store.length;
    this.cb.onIntent();
    this.cb.onPan((delta / Math.max(1, width)) * span);
  }
}
