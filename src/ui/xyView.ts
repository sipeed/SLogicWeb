// SPDX-License-Identifier: GPL-3.0-or-later

import { ADC_MAX_CODE } from './channelBanks.js';
import { MEASURE_SCAN_SAMPLES } from './measureSamples.js';

export const XY_MAX_POINTS = 2 ** 18;

export const XY_MAX_ANALYZED = MEASURE_SCAN_SAMPLES;

export const XY_MIN_PAIRS = 2;

export const XY_MIN_SPAN_V = 1e-3;

export const XY_FIT_PAD = 0.1;

export const XY_FIT_TICKS = 4;

export const XY_DENSITY_MAX_PER_PIXEL = 4096;

export const XY_DENSITY_MAX_COUNT = 65535;

export const XY_DENSITY_MAX_PIXELS = 2 ** 22;

export type XyRefusal = 'same-source' | 'unavailable' | 'too-few' | 'gap';

export const XY_REASON_KEYS: Readonly<Record<XyRefusal, string>> = {
  'same-source': 'capturePanel.xySameSource',
  unavailable: 'capturePanel.xyUnavailable',
  'too-few': 'capturePanel.xyTooFew',
  gap: 'capturePanel.xyGap',
};

export interface XyRange {
  min: number;
  max: number;
}

export interface XyPlanInput {
  sourceX: number | null;
  sourceY: number | null;
  codesX: ArrayLike<number>;
  codesY: ArrayLike<number>;
  zeroX: number;
  zeroY: number;
  voltsPerCodeX: number;
  voltsPerCodeY: number;
  unknownX?: ArrayLike<number>;
  unknownY?: ArrayLike<number>;
  maxPoints?: number;
  maxAnalyzed?: number;
  requestedSamples?: number;
}

export interface XyPlotPlan {
  status: 'ok';
  sourceX: number;
  sourceY: number;
  stride: number;
  points: Float64Array;
  requested: number;
  analyzed: number;
  paired: number;
  plotted: number;
  gapExcluded: number;
  saturated: boolean;
  rangeX: XyRange;
  rangeY: XyRange;
  observedX: XyRange;
  observedY: XyRange;
  zeroX: number;
  zeroY: number;
  voltsPerCodeX: number;
  voltsPerCodeY: number;
}

export interface XyRefusalPlan {
  status: 'refuse';
  reason: XyRefusal;
  reasonKey: string;
  requested: number;
  analyzed: number;
  paired: number;
  gapExcluded: number;
}

export type XyPlan = XyPlotPlan | XyRefusalPlan;

export interface XyAxes {
  fit: boolean;
  x: XyRange;
  y: XyRange;
}

export interface XyDensityOptions {
  width: number;
  height: number;
  axes?: XyAxes;
  maxPerPixel?: number;
}

export interface XyDensity {
  width: number;
  height: number;
  counts: Uint16Array;
  alpha: Uint8Array;
  plotted: number;
  stride: number;
  axes: XyAxes;
  maxPerPixel: number;
  peak: number;
  saturatedPixels: number;
}

export interface XySummary {
  status: 'ok' | 'refuse';
  reason: XyRefusal | null;
  reasonKey: string | null;
  requested: number;
  analyzed: number;
  paired: number;
  plotted: number;
  gapExcluded: number;
  stride: number;
  pointSaturated: boolean;
  fit: boolean;
  rangeX: XyRange | null;
  rangeY: XyRange | null;
  zeroFractionX: number | null;
  zeroFractionY: number | null;
  density: {
    plotted: number;
    stride: number;
    saturatedPixels: number;
    maxPerPixel: number;
  } | null;
}

function pairUnknown(mask: ArrayLike<number> | undefined, index: number): boolean {
  if (mask === undefined) return false;
  if (index >= mask.length) return false;
  return mask[index] !== 0;
}

function xyMaxPoints(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return XY_MAX_POINTS;
  return Math.min(Math.floor(raw), XY_MAX_POINTS);
}

function xyMaxAnalyzed(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return XY_MAX_ANALYZED;
  return Math.min(Math.floor(raw), XY_MAX_ANALYZED);
}

function xyRequested(raw: number | undefined, available: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < available) return available;
  return Math.floor(raw);
}

export function planXy(input: XyPlanInput): XyPlan {
  const lengthX = input.codesX.length;
  const lengthY = input.codesY.length;
  const available = Math.min(lengthX, lengthY);
  const requested = xyRequested(input.requestedSamples, available);
  const analyzed = Math.min(available, xyMaxAnalyzed(input.maxAnalyzed));
  const refusal = (
    reason: XyRefusal, paired = 0, gapExcluded = 0,
  ): XyRefusalPlan => ({
    status: 'refuse', reason, reasonKey: XY_REASON_KEYS[reason],
    requested, analyzed, paired, gapExcluded,
  });

  if (input.sourceX === null || input.sourceY === null) return refusal('unavailable');
  if (input.sourceX === input.sourceY) return refusal('same-source');
  if (lengthX !== lengthY) return refusal('unavailable');
  if (!Number.isFinite(input.zeroX) || !Number.isFinite(input.zeroY)) {
    return refusal('unavailable');
  }
  if (!(input.voltsPerCodeX > 0) || !(input.voltsPerCodeY > 0) ||
    !Number.isFinite(input.voltsPerCodeX) || !Number.isFinite(input.voltsPerCodeY)) {
    return refusal('unavailable');
  }

  const maxPoints = xyMaxPoints(input.maxPoints);
  let paired = 0;
  let gapExcluded = 0;
  let observedMinX = Number.POSITIVE_INFINITY;
  let observedMaxX = Number.NEGATIVE_INFINITY;
  let observedMinY = Number.POSITIVE_INFINITY;
  let observedMaxY = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < analyzed; i += 1) {
    if (pairUnknown(input.unknownX, i) || pairUnknown(input.unknownY, i)) {
      gapExcluded += 1;
      continue;
    }
    const x = (input.codesX[i] - input.zeroX) * input.voltsPerCodeX;
    const y = (input.codesY[i] - input.zeroY) * input.voltsPerCodeY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      gapExcluded += 1;
      continue;
    }
    paired += 1;
    if (x < observedMinX) observedMinX = x;
    if (x > observedMaxX) observedMaxX = x;
    if (y < observedMinY) observedMinY = y;
    if (y > observedMaxY) observedMaxY = y;
  }

  if (paired < XY_MIN_PAIRS) {
    return refusal(paired === 0 && gapExcluded > 0 ? 'gap' : 'too-few', paired, gapExcluded);
  }

  const stride = Math.max(1, Math.ceil(paired / maxPoints));
  const plotted = Math.ceil(paired / stride);
  const points = new Float64Array(plotted * 2);
  let seen = 0;
  let at = 0;
  for (let i = 0; i < analyzed && at < points.length; i += 1) {
    if (pairUnknown(input.unknownX, i) || pairUnknown(input.unknownY, i)) continue;
    const x = (input.codesX[i] - input.zeroX) * input.voltsPerCodeX;
    const y = (input.codesY[i] - input.zeroY) * input.voltsPerCodeY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (seen % stride === 0) {
      points[at] = x;
      points[at + 1] = y;
      at += 2;
    }
    seen += 1;
  }

  return {
    status: 'ok',
    sourceX: input.sourceX,
    sourceY: input.sourceY,
    stride,
    points,
    requested,
    analyzed,
    paired,
    plotted: points.length / 2,
    gapExcluded,
    saturated: stride > 1,
    rangeX: {
      min: (0 - input.zeroX) * input.voltsPerCodeX,
      max: (ADC_MAX_CODE - input.zeroX) * input.voltsPerCodeX,
    },
    rangeY: {
      min: (0 - input.zeroY) * input.voltsPerCodeY,
      max: (ADC_MAX_CODE - input.zeroY) * input.voltsPerCodeY,
    },
    observedX: { min: observedMinX, max: observedMaxX },
    observedY: { min: observedMinY, max: observedMaxY },
    zeroX: input.zeroX,
    zeroY: input.zeroY,
    voltsPerCodeX: input.voltsPerCodeX,
    voltsPerCodeY: input.voltsPerCodeY,
  };
}

export function xyVoltsStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const power = 10 ** exponent;
  const fraction = raw / power;
  const mantissa = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return mantissa * power;
}

function fittedRange(low: number, high: number, voltsPerCode: number): XyRange {
  let min = Math.min(low, high);
  let max = Math.max(low, high);
  const quantum = Math.max(Math.abs(voltsPerCode), XY_MIN_SPAN_V);
  if (!(max - min > 0)) {
    min -= quantum / 2;
    max += quantum / 2;
  }
  const pad = (max - min) * XY_FIT_PAD;
  min -= pad;
  max += pad;
  const step = xyVoltsStep((max - min) / XY_FIT_TICKS);
  const snappedMin = Math.floor(min / step) * step;
  const snappedMax = Math.ceil(max / step) * step;
  if (!(snappedMax > snappedMin)) return { min: snappedMin - step, max: snappedMax + step };
  return { min: snappedMin === 0 ? 0 : snappedMin, max: snappedMax };
}

export function fitXyAxes(plan: XyPlotPlan): XyAxes {
  return {
    fit: true,
    x: fittedRange(plan.observedX.min, plan.observedX.max, plan.voltsPerCodeX),
    y: fittedRange(plan.observedY.min, plan.observedY.max, plan.voltsPerCodeY),
  };
}

export function xyAxes(plan: XyPlan, options: { fit?: boolean } = {}): XyAxes | null {
  if (plan.status !== 'ok') return null;
  if (options.fit === true) return fitXyAxes(plan);
  return { fit: false, x: { ...plan.rangeX }, y: { ...plan.rangeY } };
}

export function xyFractionX(range: XyRange, volts: number): number {
  const span = range.max - range.min;
  if (!(span > 0) || !Number.isFinite(volts)) return 0.5;
  return (volts - range.min) / span;
}

export function xyFractionY(range: XyRange, volts: number): number {
  const span = range.max - range.min;
  if (!(span > 0) || !Number.isFinite(volts)) return 0.5;
  return (range.max - volts) / span;
}

function axisPixel(fraction: number, size: number): number {
  const limit = Math.max(1, Math.round(Number.isFinite(size) ? size : 1));
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  return Math.min(limit - 1, Math.floor(clamped * limit));
}

export function xyPixelX(range: XyRange, width: number, volts: number): number {
  return axisPixel(xyFractionX(range, volts), width);
}

export function xyPixelY(range: XyRange, height: number, volts: number): number {
  return axisPixel(xyFractionY(range, volts), height);
}

export function xyZeroFraction(range: XyRange): number | null {
  if (!(range.max > range.min)) return null;
  if (range.min > 0 || range.max < 0) return null;
  return (0 - range.min) / (range.max - range.min);
}

export function xyZeroFractionY(range: XyRange): number | null {
  const fraction = xyZeroFraction(range);
  return fraction === null ? null : 1 - fraction;
}

export function xyZeroLineX(range: XyRange, width: number): number | null {
  const fraction = xyZeroFraction(range);
  if (fraction === null) return null;
  return fraction * Math.max(1, Number.isFinite(width) ? width : 1);
}

export function xyZeroLineY(range: XyRange, height: number): number | null {
  const fraction = xyZeroFractionY(range);
  if (fraction === null) return null;
  return fraction * Math.max(1, Number.isFinite(height) ? height : 1);
}

export function xyDensitySize(
  width: number, height: number,
): { width: number; height: number } {
  const w = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
  const h = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const pixels = w * h;
  if (pixels <= XY_DENSITY_MAX_PIXELS) return { width: w, height: h };
  const scale = Math.sqrt(XY_DENSITY_MAX_PIXELS / pixels);
  return {
    width: Math.max(1, Math.floor(w * scale)),
    height: Math.max(1, Math.floor(h * scale)),
  };
}

function xyDimension(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`xy ${name} must be a positive finite number`);
  }
  return Math.round(value);
}

function xyCeiling(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 1) return XY_DENSITY_MAX_PER_PIXEL;
  return Math.min(XY_DENSITY_MAX_COUNT, Math.floor(raw));
}

export function xyDensity(plan: XyPlan, options: XyDensityOptions): XyDensity | null {
  if (plan.status !== 'ok') return null;
  const width = xyDimension(options.width, 'width');
  const height = xyDimension(options.height, 'height');
  const pixels = width * height;
  if (pixels > XY_DENSITY_MAX_PIXELS) {
    throw new RangeError(`xy density buffer ${width}x${height} exceeds ${XY_DENSITY_MAX_PIXELS}`);
  }
  const axes = options.axes ?? { fit: false, x: { ...plan.rangeX }, y: { ...plan.rangeY } };
  const ceiling = xyCeiling(options.maxPerPixel);
  const counts = new Uint16Array(pixels);
  const saturated = new Uint8Array(pixels);
  const points = plan.points;
  for (let i = 0; i < points.length; i += 2) {
    const column = xyPixelX(axes.x, width, points[i]);
    const row = xyPixelY(axes.y, height, points[i + 1]);
    const index = row * width + column;
    if (counts[index] >= ceiling) {
      saturated[index] = 1;
      continue;
    }
    counts[index] += 1;
  }
  let peak = 0;
  let saturatedPixels = 0;
  for (let i = 0; i < pixels; i += 1) {
    if (saturated[i] === 1) saturatedPixels += 1;
    if (counts[i] > peak) peak = counts[i];
  }
  const alpha = new Uint8Array(pixels);
  const scale = Math.log1p(Math.max(1, peak));
  for (let i = 0; i < pixels; i += 1) {
    if (counts[i] === 0) continue;
    alpha[i] = Math.max(1, Math.round((255 * Math.log1p(counts[i])) / scale));
  }
  return {
    width,
    height,
    counts,
    alpha,
    plotted: points.length / 2,
    stride: plan.stride,
    axes,
    maxPerPixel: ceiling,
    peak,
    saturatedPixels,
  };
}

export function xySummary(
  plan: XyPlan,
  options: { axes?: XyAxes | null; density?: XyDensity | null } = {},
): XySummary {
  const axes = options.axes === undefined ? xyAxes(plan) : options.axes;
  const density = options.density ?? null;
  return {
    status: plan.status === 'ok' ? 'ok' : 'refuse',
    reason: plan.status === 'refuse' ? plan.reason : null,
    reasonKey: plan.status === 'refuse' ? plan.reasonKey : null,
    requested: plan.requested,
    analyzed: plan.analyzed,
    paired: plan.paired,
    plotted: plan.status === 'ok' ? plan.plotted : 0,
    gapExcluded: plan.gapExcluded,
    stride: plan.status === 'ok' ? plan.stride : 1,
    pointSaturated: plan.status === 'ok' ? plan.saturated : false,
    fit: axes?.fit === true,
    rangeX: axes === null ? null : axes.x,
    rangeY: axes === null ? null : axes.y,
    zeroFractionX: axes === null ? null : xyZeroFraction(axes.x),
    zeroFractionY: axes === null ? null : xyZeroFractionY(axes.y),
    density: density === null ? null : {
      plotted: density.plotted,
      stride: density.stride,
      saturatedPixels: density.saturatedPixels,
      maxPerPixel: density.maxPerPixel,
    },
  };
}
