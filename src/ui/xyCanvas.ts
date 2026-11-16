// SPDX-License-Identifier: GPL-3.0-or-later

import type { CanvasPalette } from './canvasPalette.js';
import type { FftViewportBox } from './fftCanvas.js';
import {
  xyPixelX, xyPixelY, xyVoltsStep, xyZeroLineX, xyZeroLineY,
  type XyAxes, type XyDensity, type XyRange,
} from './xyView.js';

export const XY_TICK_FONT = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const XY_LABEL_MIN_PX = 48;

export interface XyTick {
  pos: number;
  label: string;
}

export interface XyTickLayout {
  x: XyTick[];
  y: XyTick[];
  stepX: number;
  stepY: number;
}

function tickLabel(value: number, step: number): string {
  if (!Number.isFinite(value)) return '-';
  const digits = step >= 1 ? 0 : Math.min(6, Math.max(0, -Math.floor(Math.log10(step)) + 1));
  if (Math.abs(value) < step * 1e-9) return '0 V';
  return `${value.toFixed(digits)} V`;
}

function axisTicks(
  range: XyRange, size: number, horizontal: boolean,
): { ticks: XyTick[]; step: number } {
  const span = range.max - range.min;
  if (!(span > 0) || !Number.isFinite(span)) return { ticks: [], step: 0 };
  const capacity = Math.max(2, Math.floor(size / XY_LABEL_MIN_PX));
  const step = xyVoltsStep(span / capacity);
  if (!(step > 0)) return { ticks: [], step: 0 };
  const first = Math.ceil(range.min / step) * step;
  const ticks: XyTick[] = [];
  const limit = Math.ceil((range.max - first) / step) + 1;
  for (let k = 0; k < limit; k += 1) {
    const value = first + k * step;
    if (value > range.max + step * 1e-9) break;
    const pos = horizontal
      ? xyPixelX(range, size, value)
      : xyPixelY(range, size, value);
    const label = tickLabel(value, step);
    const last = ticks[ticks.length - 1];
    if (last === undefined || last.pos !== pos) ticks.push({ pos, label });
  }
  return { ticks, step };
}

export function xyTickLayout(axes: XyAxes, width: number, height: number): XyTickLayout {
  const horizontal = axisTicks(axes.x, Math.max(1, Math.round(width)), true);
  const vertical = axisTicks(axes.y, Math.max(1, Math.round(height)), false);
  return {
    x: horizontal.ticks,
    y: vertical.ticks,
    stepX: horizontal.step,
    stepY: vertical.step,
  };
}

export interface XyPaintInput {
  palette: CanvasPalette;
  axes: XyAxes;
  ticks: XyTickLayout;
  density: XyDensity | null;
  message: string | null;
  sourceX: string;
  sourceY: string;
}

function hexRgb(hex: string): [number, number, number] {
  const value = hex.trim();
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (match === null) return [255, 255, 255];
  const int = Number.parseInt(match[1]!, 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

export class XyCanvas {
  readonly el: HTMLCanvasElement;

  private widthCss = 0;
  private heightCss = 0;
  private readonly raster: HTMLCanvasElement;
  private rasterImage: ImageData | null = null;

  constructor(host: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.className = 'xy-canvas';
    canvas.dataset.xyCanvas = '';
    canvas.setAttribute('role', 'img');
    canvas.tabIndex = 0;
    canvas.hidden = true;
    host.appendChild(canvas);
    this.el = canvas;
    this.raster = document.createElement('canvas');
  }

  get context(): CanvasRenderingContext2D {
    const ctx = this.el.getContext('2d');
    if (ctx === null) throw new Error('xy canvas has no 2d context');
    return ctx;
  }

  syncSize(box: FftViewportBox): boolean {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(box.width * dpr));
    const h = Math.max(1, Math.round(box.height * dpr));
    const changed = this.el.width !== w || this.el.height !== h;
    if (changed) {
      this.el.width = w;
      this.el.height = h;
    }
    this.el.style.width = `${box.width}px`;
    this.el.style.height = `${box.height}px`;
    this.el.style.top = `${box.top}px`;
    this.widthCss = Math.max(1, box.width);
    this.heightCss = Math.max(1, box.height);
    return changed;
  }

  draw(input: XyPaintInput): void {
    const ctx = this.context;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = this.widthCss;
    const h = this.heightCss;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = input.palette.bg;
    ctx.fillRect(0, 0, w, h);

    if (input.message !== null) {
      ctx.font = XY_TICK_FONT;
      ctx.fillStyle = input.palette.text50;
      ctx.textBaseline = 'middle';
      const lines = input.message.split('\n');
      const lineHeight = 15;
      const top = Math.max(8, (h - lines.length * lineHeight) / 2);
      lines.forEach((line, index) => ctx.fillText(line, 10, top + index * lineHeight));
      return;
    }

    const spanX = input.axes.x.max - input.axes.x.min;
    const spanY = input.axes.y.max - input.axes.y.min;
    if (!(spanX > 0) || !(spanY > 0)) return;

    this.paintDensity(input.density, input.palette);

    ctx.font = XY_TICK_FONT;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (const tick of input.ticks.y) {
      const y = Math.round(tick.pos) + 0.5;
      ctx.strokeStyle = input.palette.gridMinor;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = input.palette.text50;
      ctx.fillText(tick.label, 4, Math.min(Math.max(7, y), Math.max(7, h - 8)));
    }
    for (const tick of input.ticks.x) {
      const x = Math.round(tick.pos) + 0.5;
      ctx.strokeStyle = input.palette.gridMinor;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.fillStyle = input.palette.text50;
      const labelWidth = ctx.measureText(tick.label).width;
      const labelX = Math.min(Math.max(2, x - labelWidth / 2), Math.max(2, w - labelWidth - 2));
      ctx.fillText(tick.label, labelX, h - 6);
    }

    const zeroX = xyZeroLineX(input.axes.x, w);
    if (zeroX !== null) {
      const x = Math.round(zeroX) + 0.5;
      ctx.strokeStyle = input.palette.text80;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    const zeroY = xyZeroLineY(input.axes.y, h);
    if (zeroY !== null) {
      const y = Math.round(zeroY) + 0.5;
      ctx.strokeStyle = input.palette.text80;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    ctx.font = XY_TICK_FONT;
    ctx.textBaseline = 'middle';
    this.axisLabel(input.sourceY, 4, 10, w, input.palette);
    const xWidth = ctx.measureText(input.sourceX).width;
    this.axisLabel(input.sourceX, Math.max(4, w - xWidth - 6), h - 20, w, input.palette);
  }

  private axisLabel(
    text: string, x: number, y: number, width: number, palette: CanvasPalette,
  ): void {
    const ctx = this.context;
    ctx.font = XY_TICK_FONT;
    const textWidth = ctx.measureText(text).width;
    const left = Math.min(Math.max(2, x), Math.max(2, width - textWidth - 6));
    ctx.fillStyle = palette.bubbleBg;
    ctx.fillRect(left - 2, y - 7, textWidth + 4, 14);
    ctx.fillStyle = palette.text80;
    ctx.fillText(text, left, y);
  }

  private paintDensity(density: XyDensity | null, palette: CanvasPalette): void {
    if (density === null) return;
    const width = density.width;
    const height = density.height;
    if (width < 1 || height < 1) return;
    if (this.raster.width !== width || this.raster.height !== height) {
      this.raster.width = width;
      this.raster.height = height;
      this.rasterImage = null;
    }
    const rasterCtx = this.raster.getContext('2d');
    if (rasterCtx === null) return;
    if (this.rasterImage === null) {
      this.rasterImage = rasterCtx.createImageData(width, height);
    }
    const data = this.rasterImage.data;
    const [r, g, b] = hexRgb(palette.selection);
    data.fill(0);
    const counts = density.counts;
    const alpha = density.alpha;
    for (let i = 0; i < counts.length; i += 1) {
      if (counts[i] === 0) continue;
      const at = i * 4;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
      data[at + 3] = alpha[i]!;
    }
    rasterCtx.putImageData(this.rasterImage, 0, 0);
    const ctx = this.context;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.raster, 0, 0, this.el.width, this.el.height);
    ctx.restore();
  }

  dispose(): void {
    this.el.remove();
  }
}
