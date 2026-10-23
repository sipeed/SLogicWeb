// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Canvas 2D fallback for `WaveformRenderer`, for browsers whose WebGL2 is missing or
 * blocked (a GPU-blocklisted Chrome, a VM without GPU pass-through, `chrome://gpu`
 * software-renderering-disabled). Without it `new App()` dies at construction and the
 * shell paints a red stack trace; with it the app runs unchanged, only slower.
 *
 * It deliberately mirrors the WebGL renderer's public surface and frame shape rather
 * than sharing a base class with it: the WebGL path is the hot one and stays untouched,
 * and this file is a straight transcription of FRAGMENT_SRC's per-pixel rules (the same
 * transcription cpuRaster.ts carries, but fed by the production data path -
 * `planColumns` + `fillAtlas` - so fractional zoom and live-edge clamping behave
 * identically instead of only for integer viewports).
 *
 * Cost: one `putImageData` of the whole canvas per frame, O(width x height) writes.
 * That is far heavier than the GPU path's O(columns x rows), so this exists as the
 * degraded mode, not an alternative to it.
 */

import type { SampleStore } from '../data/types.js';
import { BIT_EDGE, BIT_GAP, BIT_HIGH, fillAtlas, planColumns, type ColumnPlan } from './columns.js';
import { computeLayout, type LayoutMetrics } from './layout.js';
import { MAX_ROWS } from './shaders.js';
import {
  DARK_THEME,
  DEFAULT_GUTTER_CSS_PX,
  DEFAULT_LINE_WIDTH_CSS_PX,
  DEFAULT_ROW_HEIGHT_CSS_PX,
  parseHexColor,
  type Theme,
} from './theme.js';
import { MIN_SAMPLES_ON_SCREEN, ViewTransform } from './transform.js';
import type { FrameStats, WaveformRendererOptions } from './waveformRenderer.js';

/** Pack r/g/b (0-1 floats) into the little-endian ABGR word of an ImageData pixel. */
function pack32(rgb: readonly number[]): number {
  const r = Math.round(rgb[0]! * 255);
  const g = Math.round(rgb[1]! * 255);
  const b = Math.round(rgb[2]! * 255);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class Canvas2dRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly store: SampleStore;

  private readonly ctx: CanvasRenderingContext2D;
  private theme: Theme;
  private rowHeightCssPx: number;
  private rowHeightsCssPx: number[] | undefined;
  private gutterCssPx: number;
  private lineWidthCssPx: number;
  private edgeWidthDevicePx: number;
  private dpr: number;

  private channels: number[];
  private layout: LayoutMetrics;
  private layoutDirty = true;

  private atlas = new Uint8Array(0);
  private atlasWidth = 0;
  private img: ImageData | null = null;
  /** Column classification scratch for the row being painted, sized to the canvas. */
  private colBitsArr = new Uint8Array(0);
  private colHasArr = new Uint8Array(0);

  // 0-1 floats, refreshed by rebuildLayout(); packed per paint.
  private bgRgb: [number, number, number] = [0, 0, 0];
  private sepRgb: [number, number, number] = [0, 0, 0];
  private noDataRgb: [number, number, number] = [0, 0, 0];

  private widthPx = 0;
  private heightPx = 0;

  private readonly view: ViewTransform;
  private follow = false;
  private rafHandle = 0;

  /** Stats for the most recent render(). */
  lastFrame: FrameStats = {
    totalMs: 0, queryMs: 0, uploadMs: 0, drawMs: 0,
    dataBins: 0, widthPx: 0, samplesPerPixel: 0, rows: 0,
  };

  constructor(opts: WaveformRendererOptions) {
    this.canvas = opts.canvas;
    this.store = opts.store;
    this.theme = opts.theme ?? DARK_THEME;
    this.rowHeightCssPx = opts.rowHeightCssPx ?? DEFAULT_ROW_HEIGHT_CSS_PX;
    this.rowHeightsCssPx = opts.rowHeightsCssPx ? [...opts.rowHeightsCssPx] : undefined;
    this.gutterCssPx = opts.gutterCssPx ?? DEFAULT_GUTTER_CSS_PX;
    this.lineWidthCssPx = opts.lineWidthCssPx ?? DEFAULT_LINE_WIDTH_CSS_PX;
    this.edgeWidthDevicePx = opts.edgeWidthDevicePx ?? 1;
    this.dpr = opts.devicePixelRatio ?? (globalThis.devicePixelRatio || 1);

    const all: number[] = [];
    for (let i = 0; i < this.store.channelCount; i++) all.push(i);
    this.channels = [...(opts.channels ?? all)];
    this.assertChannels();

    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available on this context');
    this.ctx = ctx;

    this.layout = computeLayout(this.layoutOptions());
    this.syncCanvasSize();

    const len = Math.max(this.store.length, 1);
    this.view = new ViewTransform(Math.max(this.widthPx, 1), 0, len);
  }

  // ------------------------------------------------------------------ config

  private layoutOptions() {
    return {
      rowCount: this.channels.length,
      rowHeightCssPx: this.rowHeightCssPx,
      ...(this.rowHeightsCssPx ? { rowHeightsCssPx: this.rowHeightsCssPx } : {}),
      gutterCssPx: this.gutterCssPx,
      lineWidthCssPx: this.lineWidthCssPx,
      edgeWidthDevicePx: this.edgeWidthDevicePx,
      noDataBorderCssPx: this.theme.noDataBorderCssPx,
      rowSeparatorCssPx: this.theme.rowSeparatorCssPx,
      dpr: this.dpr,
    };
  }

  private assertChannels(): void {
    if (this.channels.length === 0) throw new Error('at least one channel must be visible');
    if (this.channels.length > MAX_ROWS) {
      throw new Error(`at most ${MAX_ROWS} rows are supported, got ${this.channels.length}`);
    }
    for (const c of this.channels) {
      if (!Number.isInteger(c) || c < 0 || c >= this.store.channelCount) {
        throw new Error(`channel ${c} is out of range 0..${this.store.channelCount - 1}`);
      }
    }
  }

  setChannels(channels: readonly number[]): void {
    this.channels = [...channels];
    this.assertChannels();
    this.layoutDirty = true;
  }

  getChannels(): readonly number[] {
    return this.channels;
  }

  setRowHeights(heights: readonly number[] | undefined): void {
    this.rowHeightsCssPx = heights ? [...heights] : undefined;
    this.layoutDirty = true;
  }

  setRowMetrics(m: {
    rowHeightCssPx?: number;
    gutterCssPx?: number;
    lineWidthCssPx?: number;
    edgeWidthDevicePx?: number;
  }): void {
    if (m.rowHeightCssPx !== undefined) this.rowHeightCssPx = m.rowHeightCssPx;
    if (m.gutterCssPx !== undefined) this.gutterCssPx = m.gutterCssPx;
    if (m.lineWidthCssPx !== undefined) this.lineWidthCssPx = m.lineWidthCssPx;
    if (m.edgeWidthDevicePx !== undefined) this.edgeWidthDevicePx = m.edgeWidthDevicePx;
    this.layoutDirty = true;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.layoutDirty = true;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  setDevicePixelRatio(dpr: number): void {
    if (!(dpr > 0)) throw new Error(`dpr must be positive, got ${dpr}`);
    this.dpr = dpr;
    this.layoutDirty = true;
    this.syncCanvasSize();
  }

  // ------------------------------------------------------------------ sizing

  syncCanvasSize(): boolean {
    const cssW = this.canvas.clientWidth || this.canvas.width || 1;
    const cssH = this.canvas.clientHeight || this.canvas.height || 1;
    return this.resize(cssW, cssH);
  }

  resize(cssWidth: number, cssHeight: number): boolean {
    const w = Math.max(1, Math.round(cssWidth * this.dpr));
    const h = Math.max(1, Math.round(cssHeight * this.dpr));
    if (w === this.widthPx && h === this.heightPx) return false;
    this.canvas.width = w;
    this.canvas.height = h;
    this.widthPx = w;
    this.heightPx = h;
    // Same worst-case width as the WebGL path: fully zoomed in, the integer sample
    // range can spill one sample past each screen edge.
    this.atlasWidth = w + 2 * Math.ceil(w / 8) + 8;
    this.atlas = new Uint8Array(this.atlasWidth * MAX_ROWS);
    this.img = null; // recreated lazily by the next paint
    if (this.view) this.view.widthPx = w;
    return true;
  }

  get widthDevicePx(): number {
    return this.widthPx;
  }

  get heightDevicePx(): number {
    return this.heightPx;
  }

  // ------------------------------------------------------------------ viewport

  get transform(): ViewTransform {
    return this.view;
  }

  get viewport(): { start: number; end: number } {
    return { start: this.view.start, end: this.view.end };
  }

  setViewport(startSample: number, endSample: number): void {
    this.view.set(startSample, endSample);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  zoomToFit(): void {
    const len = Math.max(this.store.length, 1);
    this.view.set(0, len);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  panPixels(dx: number): void {
    this.view.panPixels(dx);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  zoomAt(pixelX: number, spanFactor: number): void {
    this.view.zoomAt(pixelX, spanFactor);
    this.view.clampTo(this.store.length);
    this.follow = false;
  }

  setFollowLatest(on: boolean): void {
    this.follow = on;
  }

  get followLatest(): boolean {
    return this.follow;
  }

  // ------------------------------------------------------------------ drawing

  requestRender(): void {
    if (this.rafHandle !== 0) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.render();
    });
  }

  render(): FrameStats {
    const t0 = performance.now();
    // One length snapshot per frame, same as the WebGL path: during a live capture the
    // store grows underneath us and every row must be drawn against the same length.
    const length = this.store.length;

    if (this.follow && length > 0) {
      const span = Math.min(this.view.span, length);
      this.view.set(Math.max(0, length - span), length);
      this.view.clampTo(length, {
        minVisibleFraction: 0,
        minSpan: Math.min(MIN_SAMPLES_ON_SCREEN, length),
      });
    }

    if (this.layoutDirty) this.rebuildLayout();

    const rows = this.channels.length;
    const plan: ColumnPlan = planColumns(
      this.view.start, this.view.end, this.widthPx, length, this.atlasWidth,
    );

    const t1 = performance.now();
    if (plan.hasData) fillAtlas(this.store, this.channels, plan, this.atlas, this.atlasWidth);
    const t2 = performance.now();

    this.paint(plan);
    const t3 = performance.now();

    this.lastFrame = {
      totalMs: t3 - t0,
      queryMs: t2 - t1,
      uploadMs: 0,
      drawMs: t3 - t2,
      dataBins: plan.hasData ? plan.dataBins : 0,
      widthPx: this.widthPx,
      samplesPerPixel: this.view.samplesPerPixel,
      rows,
    };
    return this.lastFrame;
  }

  /** The row geometry the last frame used. The UI needs it to line labels up. */
  get rowGeometry(): LayoutMetrics {
    if (this.layoutDirty) this.rebuildLayout();
    return this.layout;
  }

  private rebuildLayout(): void {
    this.layout = computeLayout(this.layoutOptions());
    this.layoutDirty = false;
    this.bgRgb = parseHexColor(this.theme.background);
    this.noDataRgb = parseHexColor(this.theme.noDataColor);
    this.sepRgb = parseHexColor(this.theme.rowSeparatorColor);
  }

  /**
   * Per-pixel transcription of FRAGMENT_SRC. All geometry is already integral (layout
   * rounds to device px), so coverage comes out 0 or 1 and the picture matches the GPU
   * path; fractional dpr or a hand-set line width degrades to area coverage, same as
   * the shader's arithmetic.
   */
  private paint(plan: ColumnPlan): void {
    const W = this.widthPx;
    const H = this.heightPx;
    if (!this.img || this.img.width !== W || this.img.height !== H) {
      this.img = this.ctx.createImageData(W, H);
    }
    const img = this.img;
    const px = new Uint32Array(img.data.buffer, img.data.byteOffset, W * H);
    const bg32 = pack32(this.bgRgb);
    px.fill(bg32);

    if (this.colBitsArr.length < W) {
      this.colBitsArr = new Uint8Array(W);
      this.colHasArr = new Uint8Array(W);
    }
    const bits = this.colBitsArr;
    const has = this.colHasArr;

    const sep32 = pack32(this.sepRgb);
    const wash = mix3(this.bgRgb, this.noDataRgb, this.theme.noDataWashAlpha);
    const wash32 = pack32(wash);
    // NO_DATA's top border blends the wash further towards the no-data colour.
    const washBorder = mix3(wash, this.noDataRgb, this.theme.noDataBorderAlpha);
    const washBorder32 = pack32(washBorder);

    const { lineWidth: lw, edgeWidth: ew } = this.layout;
    const rad = Math.ceil((ew - 1) / 2);
    const back = Math.floor((ew - 1) / 2);
    const bins = plan.hasData ? plan.dataBins : 0;
    const inv = 1 / plan.scale;

    for (let r = 0; r < this.channels.length; r++) {
      const g = this.layout.rows[r];
      if (!g || g.top >= H) break;
      const rowBottom = Math.min(g.top + g.height, H);
      const bandBottom = Math.min(g.top + g.bandHeight, H);

      // colBits(), hoisted: one classification per screen column for the whole row.
      const atlasRow = this.atlas.subarray(r * this.atlasWidth, r * this.atlasWidth + bins);
      for (let x = 0; x < W; x++) {
        let a = Math.floor((x - plan.offset) * inv);
        let b = Math.ceil((x + 1 - plan.offset) * inv) - 1;
        if (a < 0) a = 0;
        if (b > bins - 1) b = bins - 1;
        if (bins === 0 || b < a) {
          has[x] = 0;
          bits[x] = 0;
          continue;
        }
        has[x] = 1;
        let acc = 0;
        for (let j = a; j <= b && j - a < 8; j++) acc |= atlasRow[j]!;
        bits[x] = acc;
      }

      const rgb = parseHexColor(
        this.theme.channelColors[this.channels[r]! % this.theme.channelColors.length]!,
      );

      for (let x = 0; x < W; x++) {
        if (has[x] === 0 || (bits[x]! & BIT_GAP) !== 0) {
          // NO_DATA: wash over the band, darker border strip at the row top. Both the
          // "past the end of the capture" and the "declared gap" arm draw the same way.
          for (let y = g.top; y < bandBottom; y++) {
            px[y * W + x] = y - g.top < this.layout.noDataBorder ? washBorder32 : wash32;
          }
          continue;
        }
        const b = bits[x]!;
        const bandTop = g.yHiTop;
        const bandBot = g.yLoTop + lw;
        for (let y = g.top; y < bandBottom; y++) {
          let cov = 0;
          if ((b & BIT_EDGE) === 0) {
            const t = (b & BIT_HIGH) !== 0 ? g.yHiTop : g.yLoTop;
            cov = clamp01(Math.min(t + lw, y + 1) - Math.max(t, y));
          }
          const covY = clamp01(Math.min(bandBot, y + 1) - Math.max(bandTop, y));
          if (covY > 0) {
            for (let dq = -rad; dq <= rad; dq++) {
              const q = x + dq;
              if (q < 0 || q >= W) continue;
              if (has[q] === 0) continue;
              const nb = dq === 0 ? b : bits[q]!;
              if ((nb & BIT_EDGE) === 0) continue;
              if ((nb & BIT_GAP) !== 0) continue;
              const x0 = q - back;
              const covX = clamp01(Math.min(x0 + ew, x + 1) - Math.max(x0, x));
              cov = Math.max(cov, covX * covY);
            }
          }
          if (cov <= 0) continue;
          px[y * W + x] = cov >= 1 ? pack32(rgb) : pack32(mix3(this.bgRgb, rgb, cov));
        }
      }

      // Row separator, flat over the bottom of the pitch, painted last so neither the
      // trace nor the NO_DATA wash bleeds into it (the shader returns it first).
      if (this.layout.separator > 0) {
        for (let y = bandBottom; y < rowBottom; y++) px.fill(sep32, y * W, y * W + W);
      }
    }

    this.ctx.putImageData(img, 0, 0);
  }

  dispose(): void {
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.img = null;
  }
}

function mix3(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [
    a[0]! + (b[0]! - a[0]!) * t,
    a[1]! + (b[1]! - a[1]!) * t,
    a[2]! + (b[2]! - a[2]!) * t,
  ];
}
