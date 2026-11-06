// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Everything drawn on top of (and, optically, underneath) the waveform canvases.
 *
 * Two canvases, not one, and the reason is a measured z-order rather than a preference.
 *
 * The waveform canvas is opaque - `src/render` creates its context with `alpha: false` and
 * clears to the background - so gridlines cannot be painted underneath it. Painting them
 * on top at full opacity would let a gridline cut a notch through a trace, which a
 * does not do: [MEASURED] where a gridline crosses a row separator the separator's
 * `#57575F` survives, and where it crosses background the gridline's `#39393D` survives.
 * That is a per-channel maximum, so the grid canvas carries `mix-blend-mode: lighten` and
 * the compositor reproduces the observed order exactly instead of approximating it.
 *
 * The second canvas is normal compositing and carries the annotation lanes, the cursors,
 * the hover measurement and the live-edge marker - all of which really are on top.
 */

import type { Bubble } from './annotationLayout.js';
import type { AnalogFrame } from './busView.js';
import { canvasPalette, type CanvasPalette } from './canvasPalette.js';
import type { ClearedCanvases } from './frameLayers.js';
import { AXIS, BUBBLE, GRID, ROWS } from './metrics.js';
import {
  SCOPE_DIVISIONS, SCOPE_PAD_CSS, formatScopeVolts, scopeGeometry, scopeTickIndices,
} from './scopeScale.js';
import type { TickSet } from './timeAxis.js';

export interface HoverMeasurement {
  /** CSS px inside the plot area. */
  pointerX: number;
  rowTop: number;
  rowBand: number;
  color: string;
  /** Pulse under the pointer, CSS px. Null when the channel never toggles in range. */
  widthX0: number | null;
  widthX1: number | null;
  /** To the next same-edge transition, CSS px. */
  periodX0: number | null;
  periodX1: number | null;
  lines: string[];
}

/** [SOURCE] "Brackets are suppressed when the two points are closer than a minimum pixel
 *  distance, so the readout does not turn into confetti at high zoom-out." */
const MIN_BRACKET_PX = 6;
/** [SOURCE] the readout box is offset 30 px to the side away from the pointer. */
const READOUT_OFFSET = 30;

/**
 * Catmull-Rom samples through the analog points: `visit` receives the first point and
 * then every interpolated sample. `steps` is the samples per span; callers working from
 * one column per device pixel can lower it, since the source is already resolved in x.
 */
function catmullRomWalk(
  xs: readonly number[], ys: readonly number[],
  visit: (x: number, sample: number) => void, steps = 12,
): void {
  if (xs.length === 0) return;
  visit(xs[0]!, ys[0]!);
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[Math.max(0, i - 1)]!, y0 = ys[Math.max(0, i - 1)]!;
    const x1 = xs[i]!, y1 = ys[i]!;
    const x2 = xs[i + 1]!, y2 = ys[i + 1]!;
    const x3 = xs[Math.min(xs.length - 1, i + 2)]!, y3 = ys[Math.min(xs.length - 1, i + 2)]!;
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const px = 0.5 * ((2 * x1) + (-x0 + x2) * t +
        (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (-x0 + 3 * x1 - 3 * x2 + x3) * t3);
      const py = 0.5 * ((2 * y1) + (-y0 + y2) * t +
        (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
      visit(px, py);
    }
  }
}

/**
 * Catmull-Rom reconstruction through the analog points. The ADC is a sampled signal, so a
 * straight polyline makes every sample a corner; this is the practical band-limited
 * interpolation the scope look wants (a windowed sinc on an irregular point set is not
 * well defined). The caller clips it to the row.
 */
function smoothTrace(
  c: CanvasRenderingContext2D, xs: readonly number[], ys: readonly number[], y: (v: number) => number,
): void {
  let first = true;
  catmullRomWalk(xs, ys, (px, py) => {
    if (first) {
      c.moveTo(px, y(py));
      first = false;
    } else {
      c.lineTo(px, y(py));
    }
  });
}

/**
 * The two edges of a column frame's min/max band, as Catmull-Rom curves through the
 * per-column maxima and minima.
 *
 * A straight envelope through one column per device pixel is a staircase, and the old
 * polygon fill built that way read as a rectangular backdrop behind the centreline at
 * some zoom windows. Smoothing both edges turns the band into a curve at every zoom.
 *
 * Both edges are sampled at the same x positions so they can be clamped against each
 * other: a spline through a steep jump can overshoot, and an unclamped upper edge would
 * cross below the lower edge where the band is thin, filling as a bow-tie.
 */
function smoothBandEdges(
  xs: readonly number[], mins: readonly number[], maxs: readonly number[],
): { x: number[]; upper: number[]; lower: number[] } {
  // A span is already about one device pixel wide in the columns path; twelve
  // subdivisions per span would only add path points, not visible smoothness.
  const steps = Math.max(2, Math.min(12, Math.ceil(480 / Math.max(1, xs.length))));
  const x: number[] = [];
  const upper: number[] = [];
  const rawLower: number[] = [];
  catmullRomWalk(xs, maxs, (px, py) => { x.push(px); upper.push(py); }, steps);
  catmullRomWalk(xs, mins, (_px, py) => { rawLower.push(py); }, steps);
  const lower: number[] = [];
  for (let i = 0; i < upper.length; i++) {
    let hi = upper[i]!;
    let lo = rawLower[i]!;
    if (hi < lo) {
      const mid = (hi + lo) / 2;
      hi = mid;
      lo = mid;
    }
    upper[i] = hi;
    lower.push(lo);
  }
  return { x, upper, lower };
}

/**
 * One horizontal span of Repeat-display surface, in CSS px inside the plot.
 *
 * Regions are x ranges only: the same two surfaces run across every visible row, and no
 * vertical rule is drawn at the boundary (the two background colours are the whole
 * signal). The caller supplies the colour, normally
 * `CanvasPalette.repeatPreviousSurface` or `CanvasPalette.repeatCurrentSurface`.
 */
export interface RegionTint {
  /** Left edge, CSS px from the plot's left edge. */
  startCss: number;
  /** Right edge (exclusive), CSS px. */
  endCss: number;
  color: string;
}

/**
 * A vertical span the tint may cover: one row's trace band, in CSS px from the plot's
 * top. `band` excludes the row separator, so the separator keeps the colour the
 * renderer gave it.
 */
export interface RegionTintRow {
  top: number;
  band: number;
}

/** A snapped device-pixel-aligned fill, still expressed in CSS px. */
export interface RegionTintRect {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

/**
 * Resolve Repeat-display regions into fill rects: clamp x to the plot, snap every edge
 * to a device pixel (so a region border cannot land half-on a pixel at a fractional
 * DPR), and clip each region to each row's trace band. Pure, so the layout can be
 * tested without a canvas.
 */
export function regionTintRects(
  regions: readonly RegionTint[],
  rows: readonly RegionTintRow[],
  widthCss: number,
  dpr: number,
): RegionTintRect[] {
  if (!(widthCss > 0) || !(dpr > 0) || !Number.isFinite(widthCss) || !Number.isFinite(dpr)) {
    return [];
  }
  const snap = (v: number): number => Math.round(v * dpr) / dpr;
  const out: RegionTintRect[] = [];
  for (const region of regions) {
    if (!Number.isFinite(region.startCss) || !Number.isFinite(region.endCss)) continue;
    const x0 = snap(Math.max(0, Math.min(widthCss, region.startCss)));
    const x1 = snap(Math.max(0, Math.min(widthCss, region.endCss)));
    if (!(x1 > x0)) continue;
    for (const row of rows) {
      if (!Number.isFinite(row.top) || !Number.isFinite(row.band) || !(row.band > 0)) continue;
      const y0 = snap(row.top);
      const y1 = snap(row.top + row.band);
      if (!(y1 > y0)) continue;
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, color: region.color });
    }
  }
  return out;
}

export class Overlay {
  readonly grid: HTMLCanvasElement;
  readonly top: HTMLCanvasElement;
  private gridCtx: CanvasRenderingContext2D;
  private ctx: CanvasRenderingContext2D;
  private wCss = 0;
  private hCss = 0;
  private widthDevice = 0;
  private heightDevice = 0;
  private dpr = 1;
  private gridCleared = false;
  private topCleared = false;
  private palette: CanvasPalette = canvasPalette('dark');

  constructor(container: HTMLElement) {
    this.grid = document.createElement('canvas');
    this.grid.className = 'grid-canvas';
    this.top = document.createElement('canvas');
    this.top.className = 'overlay-canvas';
    container.appendChild(this.grid);
    container.appendChild(this.top);
    const g = this.grid.getContext('2d');
    const c = this.top.getContext('2d');
    if (!g || !c) throw new Error('2D canvas context is unavailable');
    this.gridCtx = g;
    this.ctx = c;
  }

  setPalette(next: CanvasPalette): void {
    this.palette = next;
  }

  /** A context with the bubble font set, for measuring text during layout. */
  get measureCtx(): CanvasRenderingContext2D {
    this.ctx.font = BUBBLE.font;
    return this.ctx;
  }

  syncSize(wCss: number, hCss: number): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    if (w === this.widthDevice && h === this.heightDevice && dpr === this.dpr &&
      wCss === this.wCss && hCss === this.hCss) return;
    const reallocated = w !== this.widthDevice || h !== this.heightDevice;
    this.wCss = wCss;
    this.hCss = hCss;
    this.widthDevice = w;
    this.heightDevice = h;
    this.dpr = dpr;
    for (const [el, ctx] of [[this.grid, this.gridCtx], [this.top, this.ctx]] as const) {
      if (reallocated) {
        el.width = w;
        el.height = h;
      }
      el.style.width = `${wCss}px`;
      el.style.height = `${hCss}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (!reallocated) return;
    this.gridCleared = true;
    this.topCleared = true;
  }

  consumeInvalidation(): { overlay: boolean; bus: boolean } {
    const grid = this.gridCleared;
    const top = this.topCleared;
    this.gridCleared = false;
    this.topCleared = false;
    return { overlay: grid || top, bus: top };
  }

  beginFrame(clear: ClearedCanvases): void {
    if (clear.grid) this.gridCtx.clearRect(0, 0, this.wCss, this.hCss);
    if (clear.top) this.ctx.clearRect(0, 0, this.wCss, this.hCss);
  }

  /**
   * [CHOSEN] Repeat display: show which part of the plot still holds the PREVIOUS sweep
   * and which part the CURRENT sweep has already filled.
   *
   * This is drawn on the GRID canvas, not the annotation canvas, and before `drawGrid()`.
   * The waveform canvases are opaque (`alpha: false`), so no element can literally be
   * drawn behind them. The grid canvas is the layer that reproduces "behind" optically:
   * it composites with `mix-blend-mode: lighten` in the dark theme and `darken` in the
   * light one (style.css), so an opaque surface a little lighter than the dark plot (or
   * darker than the white one) replaces the background, while a channel trace - brighter
   * than the tint in dark, darker in light - wins the per-channel comparison and keeps
   * its colour. The annotation canvas stays above the grid canvas, so cursors, bubbles,
   * lane surfaces and the hover readout are never tinted by this call.
   *
   * `rows` are the trace bands to clip to (the row separator is excluded), in CSS px from
   * the top of the plot. Each region is an x span with its own surface colour; no
   * vertical line is drawn. Ordering in the frame:
   *
   *   overlay.beginFrame(clearedCanvases(plan));
   *   overlay.drawRegionTint(regions, boxes);
   *   overlay.drawGrid(ticks);
   *
   * Calling it before `drawGrid()` keeps the gridlines visible over both surfaces; they
   * are stroked after the tint on the same canvas, so their measured colours survive.
   */
  drawRegionTint(regions: readonly RegionTint[], rows: readonly RegionTintRow[]): void {
    this.paintRegionTint(this.gridCtx, regions, rows);
  }

  /**
   * The same tint on the annotation canvas, for rows the App repaints opaquely after the
   * grid pass (analyzer lanes, analog rows and blank rows). Without this the Repeat
   * surfaces would be cut at every such row and read as a third region. The waveform rows
   * stay untouched: the annotation canvas is transparent over them, so only the caller's
   * opaque row surfaces need re-tinting.
   */
  drawRegionTintOverlay(regions: readonly RegionTint[], rows: readonly RegionTintRow[]): void {
    this.paintRegionTint(this.ctx, regions, rows);
  }

  private paintRegionTint(
    ctx: CanvasRenderingContext2D,
    regions: readonly RegionTint[],
    rows: readonly RegionTintRow[],
  ): void {
    const rects = regionTintRects(regions, rows, this.wCss, this.dpr);
    if (rects.length === 0) return;
    ctx.save();
    for (const r of rects) {
      ctx.fillStyle = r.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  /**
   * [MEASURED] 1 CSS px wide, dashed 3 on / 3 off, dropped from every minor tick through
   * the whole stack. The gridline at a MAJOR tick is dimmer than at a minor one
   * (`#262629` against `#39393D`) - checked on all four majors of
   * 01-idle-empty-session.png against their neighbouring minors. That is the opposite of
   * what intuition says, and it is what the pixels say.
   */
  drawGrid(ticks: TickSet): void {
    const g = this.gridCtx;
    g.save();
    g.setLineDash([...GRID.dash]);
    g.lineWidth = GRID.width;
    for (const t of ticks.ticks) {
      g.strokeStyle = t.major ? this.palette.gridMajor : this.palette.gridMinor;
      const x = Math.round(t.x) + 0.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, this.hCss);
      g.stroke();
    }
    g.restore();
  }

  /**
   * Paint the annotation lane opaque before anything goes in it.
   *
   * The lane is a renderer row (NOTES.md section 2), so the renderer has already drawn a
   * trace and a separator in it. Covering the lane completely is what makes the row below
   * a plain base-height row with correct gutters, which is how an annotated
   * row out - lane above, band unchanged.
   */
  fillLane(top: number, height: number): void {
    this.ctx.fillStyle = this.palette.bg;
    this.ctx.fillRect(0, top, this.wCss, height);
  }

  /**
   * A covered row with a centred one-line note, for a channel the capture lacks. Only the
   * trace band is covered, so the row keeps its separator like the channel rows around it.
   */
  drawBlankRow(
    top: number, band: number, note: string, tint?: readonly RegionTint[] | null,
  ): void {
    this.fillLane(top, band);
    if (tint) this.drawRegionTintOverlay(tint, [{ top, band }]);
    const c = this.ctx;
    // The caller draws levels and bubbles right after this row; beginFrame() only
    // clears, so alignment and font set here would leak into them. Keep the note's
    // canvas state local.
    c.save();
    c.fillStyle = this.palette.text50;
    c.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(note, this.wCss / 2, top + band / 2);
    c.restore();
  }

  /**
   * One parallel-bus (ADC) row: the value as an analog trace over the full-scale range.
   *
   * Column frames come in device pixels and are drawn there, one bar per pixel from the
   * column's min to its max, stretched to meet the neighbouring column so a steep signal
   * stays a connected line. Point frames are drawn in CSS px: joined by straight lines
   * (`line`, an ADC's samples) or held as steps (`step`), with a dot per sample once they
   * are far enough apart to see. NaN (a gap, or no latch yet) breaks the trace.
   */
  drawAnalog(o: {
    top: number; band: number; frame: AnalogFrame; yMin: number; yMax: number;
    color: string; style: 'line' | 'step'; labels: { top: string; bottom: string }; note: string;
    /** ADC scope rows: a smooth reconstruction and a vertical V/Div grid. */
    smooth?: boolean;
    scope?: {
      voltsPerDiv: number; zeroPosition: number; offsetV: number; fullScaleV: number;
      /** Target V/Div: fixed voltage ticks move through the animated display scale. */
      tickVoltsPerDiv?: number;
      /** Localized scale unit after the number, e.g. "V/div" or "V/格". */
      voltsPerDivUnit?: string;
      /** The armed analog trigger level and slope, drawn on the shared geometry. */
      triggerVolts?: number;
      triggerKind?: 'rising' | 'falling';
    };
  }): void {
    const c = this.ctx;
    const scope = o.scope;
    // The trace, graticule, ruler and trigger all use `scopeGeometry`; App uses the same
    // module to place its drag handles, so a canvas tick cannot drift from its handle.
    const geometry = scope
      ? scopeGeometry(o.top, o.band, scope.voltsPerDiv, scope.zeroPosition) : null;
    const pad = SCOPE_PAD_CSS;
    const h = geometry ? geometry.innerHeight : Math.max(1, o.band - 2 * pad);
    const y = (v: number): number => geometry && scope
      ? geometry.yVolts(scope.offsetV + (v / 255) * scope.fullScaleV)
      : o.top + pad + ((o.yMax - v) / (o.yMax - o.yMin || 1)) * h;
    // Tick labels use the target scale while their Y positions use the animated one.
    // Thus a real voltage mark (1 V, 2 V, ...) travels away from or toward 0 V as the
    // ruler extends/contracts; recomputing labels from the animated V/Div would instead
    // pin every tick to the same four division positions and merely change its text.
    const perDiv = geometry ? (geometry.topV - geometry.bottomV) / SCOPE_DIVISIONS : 0;
    const tickStep = scope?.tickVoltsPerDiv ?? perDiv;
    const ticks = geometry ? scopeTickIndices(geometry, tickStep) : [];
    c.save();
    c.beginPath();
    c.rect(0, o.top, this.wCss, o.band);
    c.clip();

    if (geometry && scope) {
      // The graticule is anchored at 0 V: every visible integer division is drawn, so
      // moving the trace never leaves a sparse or mislabelled scale. 0 V is the thick
      // line; the others stay thin so a trace crossing them is not visually cut.
      c.strokeStyle = this.palette.text50;
      c.lineWidth = 1;
      c.globalAlpha = 0.7;
      for (const k of ticks) {
        if (k === 0) continue;
        const yy = Math.round(geometry.yVolts(k * tickStep)) + 0.5;
        c.beginPath();
        c.moveTo(0, yy);
        c.lineTo(this.wCss, yy);
        c.stroke();
      }
      if (geometry.bottomV <= 0 && geometry.topV >= 0) {
        c.globalAlpha = 0.95;
        c.strokeStyle = this.palette.text50;
        c.lineWidth = 2;
        const y0 = Math.round(geometry.yVolts(0)) + 0.5;
        c.beginPath();
        c.moveTo(0, y0);
        c.lineTo(this.wCss, y0);
        c.stroke();
      }
      c.globalAlpha = 1;
    } else if (o.yMin < 0 && o.yMax > 0) {
      c.strokeStyle = this.palette.gridMajor;
      c.setLineDash([3, 3]);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, Math.round(y(0)) + 0.5);
      c.lineTo(this.wCss, Math.round(y(0)) + 0.5);
      c.stroke();
      c.setLineDash([]);
    }

    const f = o.frame;
    c.fillStyle = o.color;
    c.strokeStyle = o.color;
    c.lineWidth = 1.25;
    c.lineJoin = 'round';
    if (f.kind === 'columns' && o.smooth) {
      // The zoomed-out half: a smooth min/max band with a smooth centreline, not one
      // opaque bar per column - and not the old straight-edged envelope polygon, which
      // read as a staircase of rectangular blocks at some zoom windows. Columns are
      // device px; this path draws in CSS px.
      //
      // A run is the contiguous span of known columns between NaN columns (a gap, or a
      // region the builder has not reached). Each run is smoothed on its own: joining
      // across a NaN would paint unknown time as signal. Provisional columns are sampled
      // rather than built, so their band is a touch lighter.
      const d = this.dpr;
      const len = f.min.length;
      const known = (x: number): boolean =>
        !Number.isNaN(f.min[x]!) && !Number.isNaN(f.max[x]!);
      const bandAlpha = f.provisional ? 0.12 : 0.18;
      const edgeAlpha = f.provisional ? 0.45 : 0.65;
      for (let x = 0; x < len;) {
        if (!known(x)) { x++; continue; }
        let end = x;
        while (end + 1 < len && known(end + 1)) end++;
        const xs: number[] = [];
        const mins: number[] = [];
        const maxs: number[] = [];
        for (let i = x; i <= end; i++) {
          xs.push(i / d);
          mins.push(f.min[i]!);
          maxs.push(f.max[i]!);
        }
        const band = smoothBandEdges(xs, mins, maxs);
        const last = band.x.length - 1;
        // One smooth closed path through the Catmull-Rom samples: upper edge, right
        // cap, lower edge, left cap. It is filled as a translucent wash - never the
        // opaque block the raw min/max polygon used to paint - and stroked so the
        // silhouette stays readable where the centreline is nearly flat (a sine whose
        // period is only a few columns wide).
        c.beginPath();
        c.moveTo(band.x[0]!, y(band.upper[0]!));
        for (let i = 1; i < band.x.length; i++) c.lineTo(band.x[i]!, y(band.upper[i]!));
        c.lineTo(band.x[last]!, y(band.lower[last]!));
        for (let i = last; i >= 0; i--) c.lineTo(band.x[i]!, y(band.lower[i]!));
        c.closePath();
        c.globalAlpha = bandAlpha;
        c.fill();
        c.globalAlpha = edgeAlpha;
        c.lineWidth = 1;
        c.stroke();
        x = end + 1;
      }
      c.globalAlpha = 1;
      c.lineWidth = 1.25;
      for (let x = 0; x < len;) {
        if (!known(x)) { x++; continue; }
        let end = x;
        while (end + 1 < len && known(end + 1)) end++;
        const cx: number[] = [];
        const cy: number[] = [];
        for (let i = x; i <= end; i++) {
          cx.push(i / d);
          cy.push((f.min[i]! + f.max[i]!) / 2);
        }
        c.beginPath();
        smoothTrace(c, cx, cy, y);
        c.stroke();
        x = end + 1;
      }
    } else if (f.kind === 'columns') {
      c.setTransform(1, 0, 0, 1, 0, 0);
      const d = this.dpr;
      for (let x = 0; x < f.min.length; x++) {
        let lo = f.min[x]!;
        let hi = f.max[x]!;
        if (Number.isNaN(lo)) continue;
        const pl = x > 0 ? f.min[x - 1]! : Number.NaN;
        const ph = x > 0 ? f.max[x - 1]! : Number.NaN;
        if (!Number.isNaN(pl)) {
          if (ph < lo) lo = ph;
          if (pl > hi) hi = pl;
        }
        const y0 = Math.floor(y(hi) * d);
        const y1 = Math.ceil(y(lo) * d);
        c.fillRect(x, y0, 1, Math.max(Math.round(d), y1 - y0));
      }
    } else if (f.kind === 'points' && o.smooth) {
      const d = this.dpr;
      let runX: number[] = [];
      let runY: number[] = [];
      c.beginPath();
      let lastY = 0;
      let hasLast = false;
      const flush = (): void => {
        smoothTrace(c, runX, runY, y);
        if (runX.length > 0) {
          lastY = runY[runY.length - 1]!;
          hasLast = true;
        }
        runX = [];
        runY = [];
      };
      for (let i = 0; i < f.count; i++) {
        const v = f.v[i]!;
        if (Number.isNaN(v)) { flush(); continue; }
        runX.push(f.x[i]! / d);
        runY.push(v);
      }
      flush();
      // Hold the last value to the right edge only when the frame itself ends on a known
      // sample. A trailing NaN is unknown time (a gap, or a trigger-anchored view whose
      // right part is not captured yet) and must not be painted as a flat line.
      const endsKnown = f.count > 0 && !Number.isNaN(f.v[f.count - 1]!);
      if (hasLast && endsKnown) c.lineTo(this.wCss, y(lastY));
      c.stroke();
    } else if (f.kind === 'points') {
      const d = this.dpr;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < f.count; i++) { xs.push(f.x[i]! / d); ys.push(f.v[i]!); }
      c.beginPath();
      let open = false;
      for (let i = 0; i < f.count; i++) {
        const v = ys[i]!;
        if (Number.isNaN(v)) { open = false; continue; }
        const x = xs[i]!;
        if (!open) { c.moveTo(x, y(v)); open = true; continue; }
        if (o.style === 'step') c.lineTo(x, y(ys[i - 1]!));
        c.lineTo(x, y(v));
      }
      // The last value holds to the right edge.
      const last = ys[f.count - 1];
      if (open && last !== undefined && !Number.isNaN(last)) c.lineTo(this.wCss, y(last));
      c.stroke();
      let minGap = Number.POSITIVE_INFINITY;
      for (let i = 1; i < xs.length; i++) minGap = Math.min(minGap, xs[i]! - xs[i - 1]!);
      if (minGap >= 8) {
        for (let i = 0; i < f.count; i++) {
          if (Number.isNaN(ys[i]!)) continue;
          c.beginPath();
          c.arc(xs[i]!, y(ys[i]!), 2, 0, 2 * Math.PI);
          c.fill();
        }
      }
    } else if (o.note) {
      c.fillStyle = this.palette.text50;
      c.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(o.note, this.wCss / 2, o.top + o.band / 2);
    }

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.font = '9px -apple-system, BlinkMacSystemFont, sans-serif';
    c.fillStyle = this.palette.text50;
    if (geometry && scope) {
      // The armed trigger level, on the same geometry as the trace. App owns the pointer
      // handle; the line is painted now and its readout goes above the ruler labels below.
      if (scope.triggerVolts !== undefined && scope.triggerVolts >= geometry.bottomV &&
          scope.triggerVolts <= geometry.topV) {
        c.globalAlpha = 0.9;
        c.strokeStyle = this.palette.warning;
        c.lineWidth = 1;
        c.setLineDash([4, 3]);
        const ty = Math.round(geometry.yVolts(scope.triggerVolts)) + 0.5;
        c.beginPath();
        c.moveTo(0, ty);
        c.lineTo(this.wCss, ty);
        c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 1;
      }
      // The voltage ruler is on the right, inside the analog row. The plot has no
      // reserved right gutter, so the rule sits just inside the canvas edge and the
      // labels are right-aligned against it; the top and bottom edge labels are gone
      // because every division, including the visible extremes, now has one label.
      const rulerX = Math.round(this.wCss - 6) + 0.5;
      c.strokeStyle = this.palette.text50;
      c.lineWidth = 1;
      c.globalAlpha = 0.75;
      c.beginPath();
      c.moveTo(rulerX, geometry.yVolts(geometry.topV));
      c.lineTo(rulerX, geometry.yVolts(geometry.bottomV));
      c.stroke();
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      c.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';

      // Compact readouts share the ruler rather than consuming the left channel control.
      // Their opaque chips sit on top of the tick labels, so a label that would be cut in
      // half by a chip is left out below. Placement is decided first for the same reason.
      const scaleLabel =
        `${scope.tickVoltsPerDiv ?? scope.voltsPerDiv} ${scope.voltsPerDivUnit ?? 'V/div'}`;
      const scaleX = rulerX - 6;
      const scaleY = o.top + o.band - 10;
      const scaleWidth = c.measureText(scaleLabel).width + 8;
      const vdiv = { x0: scaleX - scaleWidth, x1: scaleX, y0: scaleY - 8, y1: scaleY + 8 };
      const triggerVisible = scope.triggerVolts !== undefined && scope.triggerKind !== undefined &&
        scope.triggerVolts >= geometry.bottomV && scope.triggerVolts <= geometry.topV;
      const triggerLabel = triggerVisible
        ? `${scope.triggerKind === 'rising' ? 'R' : 'F'} ${formatScopeVolts(scope.triggerVolts!)}`
        : '';
      const triggerY = triggerVisible ? geometry.yVolts(scope.triggerVolts!) : 0;
      const triggerWidth = triggerVisible ? c.measureText(triggerLabel).width + 8 : 0;
      // Right edge of the trigger chip. A level in the lowest division would otherwise
      // paint over the V/div readout: slide the chip left instead, keeping its Y on the
      // trigger line.
      let triggerX = rulerX - 12;
      if (triggerVisible && triggerY + 8 > vdiv.y0 && triggerY - 8 < vdiv.y1) {
        triggerX = vdiv.x0 - 2;
      }
      const hidesLabel = (yy: number): boolean =>
        (yy > vdiv.y0 && yy < vdiv.y1) ||
        (triggerVisible && yy > triggerY - 8 && yy < triggerY + 8);

      let lastLabelY: number | null = null;
      for (const k of ticks) {
        const volts = k * tickStep;
        const yy = Math.round(geometry.yVolts(volts)) + 0.5;
        c.beginPath();
        c.moveTo(rulerX - 4, yy);
        c.lineTo(rulerX, yy);
        c.stroke();
        if (hidesLabel(yy)) continue;
        // During the animated zoom a changing scale can place marks closer than the 10 px
        // label; keep the outermost of a crowded pair rather than overprinting both.
        if (lastLabelY !== null && lastLabelY - yy < 11) continue;
        lastLabelY = yy;
        c.fillStyle = this.palette.text50;
        c.fillText(formatScopeVolts(volts), rulerX - 6, yy);
      }
      c.globalAlpha = 1;

      c.fillStyle = this.palette.bg;
      roundRect(c, vdiv.x0, vdiv.y0, scaleWidth, 16, 3);
      c.fill();
      c.fillStyle = this.palette.text50;
      c.fillText(scaleLabel, scaleX - 4, scaleY);

      if (triggerVisible) {
        c.fillStyle = this.palette.bg;
        roundRect(c, triggerX - triggerWidth, triggerY - 8, triggerWidth, 16, 3);
        c.fill();
        c.fillStyle = this.palette.warning;
        c.fillText(triggerLabel, triggerX - 4, triggerY);
      }
    } else {
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillText(o.labels.top, 4, o.top + 2);
      c.textBaseline = 'bottom';
      c.fillText(o.labels.bottom, 4, o.top + o.band - 2);
    }
    c.restore();
  }

  /**
   * [CHOSEN] The two levels of every channel row are marked with a small "H" and "L"
   * at the left edge of the plot - visible in all five screenshots, including
   * 01-idle-empty-session.png where they are the only thing in an empty row. The glyphs
   * sit at device x 220..226, i.e. 4..7 CSS px into the plot, vertically on the idle-line
   * positions.
   *
   * They come from the same gutter arithmetic `src/render/layout.ts` uses, not from a
   * separate constant, so they cannot drift away from the lines they label.
   */
  drawLevels(boxes: readonly { top: number; band: number; isChannel: boolean }[]): void {
    const c = this.ctx;
    c.save();
    c.font = '8px -apple-system, BlinkMacSystemFont, sans-serif';
    c.fillStyle = this.palette.text50;
    c.textBaseline = 'middle';
    for (const b of boxes) {
      if (!b.isChannel) continue;
      const yHi = b.top + ROWS.gutter + ROWS.lineWidth / 2;
      const yLo = b.top + b.band - ROWS.gutter - ROWS.lineWidth / 2;
      if (yLo - yHi < 10) continue;
      c.fillText('H', 4, yHi);
      c.fillText('L', 4, yLo);
    }
    c.restore();
  }

  drawBubbles(bubbles: readonly Bubble[], laneTop: number, color: string): void {
    const c = this.ctx;
    const y = laneTop + ROWS.lanePadTop;
    const h = ROWS.bubbleHeight;
    c.font = BUBBLE.font;
    c.textBaseline = 'middle';
    for (const b of bubbles) {
      const w = Math.max(1, b.x1 - b.x0);
      c.fillStyle = color;
      roundRect(c, b.x0, y, w, h, BUBBLE.radius);
      c.fill();

      // [SOURCE] a 3 px solid triangle on the overflowing side says the bubble continues.
      if (b.overflowLeft) triangle(c, b.x0, y + h / 2, -BUBBLE.overflowTriangle, color);
      if (b.overflowRight) triangle(c, b.x1, y + h / 2, BUBBLE.overflowTriangle, color);

      let tx = b.x0 + BUBBLE.padX;
      if (b.badge) {
        // [SOURCE] a 9 px, 2 px-padded, 5 px-radius chip in background-30.
        c.font = `${BUBBLE.badgeFontPx}px ${BUBBLE.font.split('px ')[1] ?? 'sans-serif'}`;
        const bw = c.measureText(b.badge).width + 2 * BUBBLE.badgePad;
        const bh = BUBBLE.badgeFontPx + 2 * BUBBLE.badgePad;
        c.fillStyle = this.palette.bubbleBg;
        roundRect(c, tx, y + (h - bh) / 2, bw, bh, BUBBLE.badgeRadius);
        c.fill();
        c.fillStyle = this.palette.text80;
        c.fillText(b.badge, tx + BUBBLE.badgePad, y + h / 2);
        tx += bw + 3;
        c.font = BUBBLE.font;
      }
      if (b.text) {
        c.save();
        c.beginPath();
        c.rect(b.x0, y, w, h);
        c.clip();
        c.fillStyle = this.palette.bubbleInk;
        c.fillText(b.text, tx, y + h / 2 + 0.5);
        c.restore();
      }
    }
  }

  /** A vertical cursor line at the top of the stack; its chip is painted in the axis. */
  drawCursor(x: number, color: string): void {
    const c = this.ctx;
    if (x < -20 || x > this.wCss + 20) return;
    c.save();
    c.strokeStyle = color;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, 0);
    c.lineTo(Math.round(x) + 0.5, this.hCss);
    c.stroke();
    c.restore();
  }

  /** The sample where all software-trigger conditions became true: this is T=0. */
  drawTrigger(x: number): void {
    const c = this.ctx;
    if (x < -20 || x > this.wCss + 20) return;
    const px = Math.round(x) + 0.5;
    c.save();
    c.strokeStyle = this.palette.warning;
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(px, 0);
    c.lineTo(px, this.hCss);
    c.stroke();
    c.font = 'bold 10px -apple-system, BlinkMacSystemFont, sans-serif';
    c.textBaseline = 'top';
    const label = 'T';
    const w = c.measureText(label).width + 10;
    // A trigger pinned to 0 s sits on the left edge; keep the chip fully on the canvas
    // rather than clipping half of it.
    const chipX = Math.min(Math.max(0, x - w / 2), Math.max(0, this.wCss - w));
    c.fillStyle = this.palette.warning;
    roundRect(c, chipX, 0, w, 15, 2);
    c.fill();
    c.fillStyle = this.palette.bg;
    c.fillText(label, chipX + 5, 2);
    c.restore();
  }

  /** The live edge during a capture: where the newest sample is. */
  drawLiveEdge(x: number): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = this.palette.negative;
    c.lineWidth = 1;
    c.setLineDash([2, 2]);
    c.beginPath();
    c.moveTo(Math.round(x) + 0.5, 0);
    c.lineTo(Math.round(x) + 0.5, this.hCss);
    c.stroke();
    c.restore();
  }

  /**
   * [CHOSEN] : hovering a digital pulse produces measurements with no
   * clicking at all - a width bracket along the top gutter, a period bracket along the
   * bottom gutter, and a floating readout offset 30 px away from the pointer.
   */
  drawHover(h: HoverMeasurement): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = h.color;
    c.fillStyle = h.color;
    c.lineWidth = 1;

    const topY = h.rowTop + ROWS.gutter / 2;
    const botY = h.rowTop + h.rowBand - ROWS.gutter / 2;
    if (h.widthX0 !== null && h.widthX1 !== null && h.widthX1 - h.widthX0 >= MIN_BRACKET_PX) {
      bracket(c, h.widthX0, h.widthX1, topY);
    }
    if (h.periodX0 !== null && h.periodX1 !== null && h.periodX1 - h.periodX0 >= MIN_BRACKET_PX) {
      bracket(c, h.periodX0, h.periodX1, botY);
    }

    if (h.lines.length) {
      c.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      c.textBaseline = 'top';
      const w = Math.max(...h.lines.map((l) => c.measureText(l).width)) + 12;
      const boxH = h.lines.length * 14 + 8;
      // Away from the pointer, and kept inside the plot.
      let bx = h.pointerX + READOUT_OFFSET;
      if (bx + w > this.wCss) bx = h.pointerX - READOUT_OFFSET - w;
      if (bx < 0) bx = 0;
      let by = h.rowTop + h.rowBand + 2;
      if (by + boxH > this.hCss) by = h.rowTop - boxH - 2;
      if (by < 0) by = 0;
      c.fillStyle = this.palette.bubbleBg;
      roundRect(c, bx, by, w, boxH, 3);
      c.fill();
      c.strokeStyle = this.palette.bubbleBorder;
      c.stroke();
      c.fillStyle = this.palette.text80;
      h.lines.forEach((l, i) => c.fillText(l, bx + 6, by + 4 + i * 14));
    }
    c.restore();
  }
}

function bracket(c: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  const a = Math.round(x0) + 0.5;
  const b = Math.round(x1) + 0.5;
  c.beginPath();
  c.moveTo(a, y - 3);
  c.lineTo(a, y + 3);
  c.moveTo(a, y);
  c.lineTo(b, y);
  c.moveTo(b, y - 3);
  c.lineTo(b, y + 3);
  c.stroke();
}

function triangle(c: CanvasRenderingContext2D, x: number, y: number, dx: number, color: string): void {
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(x + dx, y);
  c.lineTo(x, y - dx);
  c.lineTo(x, y + dx);
  c.closePath();
  c.fill();
}

export interface MarkerChipPaint {
  anchorX: number;
  boxX: number;
  row: 0 | 1;
  label: string;
  color: string;
}

export function paintMarkerChip(
  ctx: CanvasRenderingContext2D, chip: MarkerChipPaint,
  widthCss: number, heightCss: number, palette: CanvasPalette,
): void {
  if (heightCss <= 0 || chip.anchorX < -20 || chip.anchorX > widthCss + 20) return;
  const c = ctx;
  const { top: rowTop, height, rowGap, radius, padX, font } = AXIS.markerChip;
  const top = rowTop + chip.row * (height + rowGap);
  const anchor = Math.round(chip.anchorX) + 0.5;
  c.save();
  c.font = font;
  c.textBaseline = 'top';
  const w = c.measureText(chip.label).width + 2 * padX;
  c.strokeStyle = chip.color;
  c.lineWidth = 1;
  if (chip.row === 0) {
    c.beginPath();
    c.moveTo(anchor, top + height);
    c.lineTo(anchor, heightCss);
    c.stroke();
  }
  if (Math.abs(chip.boxX - chip.anchorX) > 0.5) {
    c.beginPath();
    c.moveTo(Math.round(chip.boxX) + 0.5, top + height);
    c.lineTo(anchor, top + height);
    c.stroke();
  }
  c.fillStyle = chip.color;
  roundRect(c, chip.boxX - w / 2, top, w, height, radius);
  c.fill();
  c.fillStyle = palette.bg;
  c.fillText(chip.label, chip.boxX - w / 2 + padX, top + 2);
  c.restore();
}

function roundRect(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}
