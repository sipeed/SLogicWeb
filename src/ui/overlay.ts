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
import { AXIS, BUBBLE, GRID, ROWS } from './metrics.js';
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

export class Overlay {
  readonly grid: HTMLCanvasElement;
  readonly top: HTMLCanvasElement;
  private gridCtx: CanvasRenderingContext2D;
  private ctx: CanvasRenderingContext2D;
  private wCss = 0;
  private hCss = 0;
  private dpr = 1;
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
    if (wCss === this.wCss && hCss === this.hCss && dpr === this.dpr) return;
    this.wCss = wCss;
    this.hCss = hCss;
    this.dpr = dpr;
    for (const [el, ctx] of [[this.grid, this.gridCtx], [this.top, this.ctx]] as const) {
      el.width = Math.max(1, Math.round(wCss * dpr));
      el.height = Math.max(1, Math.round(hCss * dpr));
      el.style.width = `${wCss}px`;
      el.style.height = `${hCss}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  beginFrame(): void {
    this.gridCtx.clearRect(0, 0, this.wCss, this.hCss);
    this.ctx.clearRect(0, 0, this.wCss, this.hCss);
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
  }): void {
    const c = this.ctx;
    const pad = 6;
    const h = Math.max(1, o.band - 2 * pad);
    const y = (v: number) => o.top + pad + ((o.yMax - v) / (o.yMax - o.yMin || 1)) * h;
    c.save();
    c.beginPath();
    c.rect(0, o.top, this.wCss, o.band);
    c.clip();

    // Zero line for signed encodings, and the full-scale labels.
    if (o.yMin < 0 && o.yMax > 0) {
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
    if (f.kind === 'columns') {
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
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillText(o.labels.top, 4, o.top + 2);
    c.textBaseline = 'bottom';
    c.fillText(o.labels.bottom, 4, o.top + o.band - 2);
    c.restore();
  }

  drawDemoWatermark(channelHeightCss: number): void {
    const c = this.ctx;
    c.save();
    c.globalAlpha = 0.12;
    c.fillStyle = this.palette.text80;
    c.font = `600 ${channelHeightCss * 2}px -apple-system, BlinkMacSystemFont, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('DEMO', this.wCss / 2, this.hCss / 2);
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
    c.fillStyle = this.palette.warning;
    roundRect(c, x - w / 2, 0, w, 15, 2);
    c.fill();
    c.fillStyle = this.palette.bg;
    c.fillText(label, x - w / 2 + 5, 2);
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

export function paintMarkerChip(
  ctx: CanvasRenderingContext2D, x: number, wCss: number, heightCss: number,
  color: string, label: string, palette: CanvasPalette,
): void {
  if (heightCss <= 0 || x < -20 || x > wCss + 20) return;
  const c = ctx;
  const { top, height, radius, padX, font } = AXIS.markerChip;
  c.save();
  c.font = font;
  c.textBaseline = 'top';
  const w = c.measureText(label).width + 2 * padX;
  c.fillStyle = color;
  roundRect(c, x - w / 2, top, w, height, radius);
  c.fill();
  c.fillStyle = palette.bg;
  c.fillText(label, x - w / 2 + padX, top + 2);
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
