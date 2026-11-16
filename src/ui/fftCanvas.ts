// SPDX-License-Identifier: GPL-3.0-or-later

import type { LogAxis, LogAxisTick } from '../dsp/fftSpectrum.js';
import type { CanvasPalette } from './canvasPalette.js';
import { formatFreq } from './format.js';

export const FFT_TICK_FONT = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const FFT_LABEL_MIN_PX = 46;

export interface FftTickLabel {
  x: number;
  label: string;
  major: boolean;
}

export interface FftViewportInput {
  scrollTop: number;
  viewportHeight: number;
  stripsHeight: number;
  plotHeight: number;
  width: number;
}

export interface FftViewportBox {
  top: number;
  height: number;
  width: number;
}

export function fftViewportBox(input: FftViewportInput): FftViewportBox {
  const finite = (value: number): number => (Number.isFinite(value) ? value : 0);
  const width = Math.max(1, Math.round(finite(input.width)));
  const plotHeight = Math.max(1, Math.round(finite(input.plotHeight)));
  const room = Math.max(1, Math.round(finite(input.viewportHeight) - finite(input.stripsHeight)));
  const top = Math.min(Math.max(0, Math.round(finite(input.scrollTop))), plotHeight - 1);
  return { top, width, height: Math.min(room, plotHeight - top) };
}

export interface FftPaintInput {
  palette: CanvasPalette;
  axis: LogAxis;
  ticks: readonly FftTickLabel[];
  columns: Float64Array;
  values: Float64Array;
  dbTop: number;
  dbBottom: number;
  peak: { x: number; dbfs: number; label: string } | null;
  hover: { x: number; label: string } | null;
  message: string | null;
}

export function fftTickLayout(axis: LogAxis, minLabelPx = FFT_LABEL_MIN_PX): FftTickLabel[] {
  const out: FftTickLabel[] = [];
  let lastX = Number.NEGATIVE_INFINITY;
  for (const tick of axis.ticks) {
    if (tick.major || tick.x - lastX >= minLabelPx) {
      out.push({ x: tick.x, label: formatFreq(tick.hz), major: tick.major });
      lastX = tick.x;
    }
  }
  return out;
}

export function fftMajors(axis: LogAxis): LogAxisTick[] {
  return axis.ticks.filter((tick) => tick.major);
}

export function fftHoverHz(axis: LogAxis, x: number, width: number): number | null {
  if (!Number.isFinite(x) || width <= 0) return null;
  if (x < 0 || x > width) return null;
  const span = Math.log(axis.nyquistHz / axis.minHz);
  return axis.minHz * Math.exp((Math.min(width, Math.max(0, x)) / width) * span);
}

export function fftNearestBin(hz: number, binHz: number, bins: number): number {
  if (!Number.isFinite(hz) || !Number.isFinite(binHz) || binHz <= 0) return -1;
  const bin = Math.round(hz / binHz);
  return Math.min(Math.max(1, bin), Math.max(1, bins - 1));
}

export function fftCoveredRange(axis: LogAxis): { first: number; last: number } {
  let first = -1;
  let last = -1;
  for (const column of axis.columns) {
    if (!column.covered) continue;
    if (first < 0) first = column.x;
    last = column.x;
  }
  return { first, last };
}

export function fftDbLabelY(y: number, height: number): number {
  return Math.min(Math.max(7, y - 6), Math.max(7, height - 8));
}

export class FftCanvas {
  readonly el: HTMLCanvasElement;

  private widthCss = 0;
  private heightCss = 0;

  constructor(host: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.className = 'fft-canvas';
    canvas.dataset.fftCanvas = '';
    canvas.setAttribute('role', 'img');
    canvas.tabIndex = 0;
    canvas.hidden = true;
    host.appendChild(canvas);
    this.el = canvas;
  }

  get context(): CanvasRenderingContext2D {
    const ctx = this.el.getContext('2d');
    if (ctx === null) throw new Error('fft canvas has no 2d context');
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

  draw(input: FftPaintInput): void {
    const ctx = this.context;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = this.widthCss;
    const h = this.heightCss;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = input.palette.bg;
    ctx.fillRect(0, 0, w, h);

    const plotHeight = h - 14;
    const span = input.dbTop - input.dbBottom;
    if (input.message !== null) {
      ctx.font = FFT_TICK_FONT;
      ctx.fillStyle = input.palette.text50;
      ctx.textBaseline = 'middle';
      const lines = input.message.split('\n');
      const lineHeight = 15;
      const top = Math.max(8, (h - lines.length * lineHeight) / 2);
      lines.forEach((line, index) => ctx.fillText(line, 10, top + index * lineHeight));
      return;
    }
    if (span <= 0) return;

    ctx.font = FFT_TICK_FONT;
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = input.palette.gridMinor;
    ctx.fillStyle = input.palette.text50;
    ctx.lineWidth = 1;
    const stepDb = span > 100 ? 40 : span > 50 ? 20 : 10;
    for (let db = Math.ceil(input.dbBottom / stepDb) * stepDb; db <= input.dbTop; db += stepDb) {
      const y = Math.round(((input.dbTop - db) / span) * plotHeight) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${db} dB`, 4, fftDbLabelY(y, plotHeight));
    }

    for (const tick of input.ticks) {
      const x = Math.round(tick.x) + 0.5;
      ctx.strokeStyle = tick.major ? input.palette.gridMajor : input.palette.gridMinor;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotHeight);
      ctx.stroke();
      ctx.fillStyle = tick.major ? input.palette.text80 : input.palette.text50;
      const labelWidth = ctx.measureText(tick.label).width;
      const labelX = Math.min(Math.max(2, x - labelWidth / 2), w - labelWidth - 2);
      ctx.fillText(tick.label, labelX, h - 6);
    }

    const yOf = (dbfs: number): number | null => {
      if (!Number.isFinite(dbfs)) return null;
      const clamped = Math.min(input.dbTop, Math.max(input.dbBottom, dbfs));
      return ((input.dbTop - clamped) / span) * plotHeight;
    };

    ctx.strokeStyle = input.palette.selection;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let previousX = -2;
    let previousY = Number.NaN;
    for (let x = 0; x < input.columns.length; x += 1) {
      const value = input.columns[x]!;
      if (!Number.isFinite(value)) {
        previousX = -2;
        previousY = Number.NaN;
        continue;
      }
      const y = yOf(value);
      if (y === null) {
        previousX = -2;
        previousY = Number.NaN;
        continue;
      }
      if (x === previousX + 1 && Number.isFinite(previousY)) ctx.lineTo(x + 0.5, y);
      else ctx.moveTo(x + 0.5, y);
      previousX = x;
      previousY = y;
    }
    ctx.stroke();

    ctx.fillStyle = input.palette.text50;
    for (const column of input.axis.columns) {
      if (column.covered) continue;
      if (column.binIndex < 0 || column.binIndex >= input.values.length) continue;
      const value = input.values[column.binIndex]!;
      const y = yOf(value);
      if (y === null) continue;
      ctx.fillRect(column.x, Math.round(y), 1, 1);
    }

    if (input.peak !== null) {
      const y = yOf(input.peak.dbfs);
      if (y !== null) {
        ctx.fillStyle = input.palette.selection;
        ctx.beginPath();
        ctx.arc(input.peak.x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        this.label(input.peak.label, input.peak.x + 6, y - 12, w, input.palette);
      }
    }

    if (input.hover !== null) {
      const x = Math.round(input.hover.x) + 0.5;
      ctx.strokeStyle = input.palette.text50;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, plotHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      this.label(input.hover.label, x + 6, 14, w, input.palette);
    }
  }

  private label(text: string, x: number, y: number, width: number, palette: CanvasPalette): void {
    const ctx = this.context;
    ctx.font = FFT_TICK_FONT;
    const textWidth = ctx.measureText(text).width;
    const left = Math.min(Math.max(2, x), Math.max(2, width - textWidth - 8));
    const top = Math.min(Math.max(2, y), Math.max(2, this.heightCss - 18));
    ctx.fillStyle = palette.bubbleBg;
    ctx.fillRect(left - 3, top - 8, textWidth + 6, 15);
    ctx.fillStyle = palette.text80;
    ctx.fillText(text, left, top);
  }

  dispose(): void {
    this.el.remove();
  }
}
