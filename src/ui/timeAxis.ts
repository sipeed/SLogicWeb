// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The time axis: which ticks, where, and what they are called.
 *
 * Minor spacing normally uses the smallest power of ten that keeps ticks at least
 * `minimumHorizontalTickSpacingPx = 45` apart. At high zoom, once individual samples
 * have that much room, ticks instead follow the exact sampling period. This preserves
 * 5 ns at 200 MS/s, 2.5 ns at 400 MS/s and 833 ps at 1.2 GS/s instead of rounding all
 * of them up to the next decimal decade. Major spacing is exactly ten minor ticks.
 *
 * [MEASURED] on 01-idle-empty-session.png: minor ticks 46.3 CSS px apart, majors at
 * 0/10/20/30 ms with 1 ms minors, minor tick marks in the bottom 3.5 CSS px, major tick
 * lines starting halfway down. The screenshot and the source agree, so both are used.
 *
 * Decimal tick positions use integer picoseconds. Sampling ticks are derived from an
 * integer sample index so repeating periods such as 1e12/1.2e9 ps do not accumulate
 * incremental floating-point drift.
 *
 * Label text is decided in `axisLabels.ts` (absolute, one unit and one decimal count per
 * axis, a single base only when needed); this module decides which ticks are labelled so
 * that no two labels overlap, using measured text widths.
 */

import { AXIS } from './metrics.js';
import type { CanvasPalette } from './canvasPalette.js';
import { axisLabel, formatStandaloneTime, planAxisLabels } from './axisLabels.js';
import { MIN_SAMPLES_ON_SCREEN } from '../render/transform.js';

export interface Tick {
  /** Time in picoseconds from t0. */
  ps: number;
  /** Device px from the left edge of the plot area. */
  x: number;
  major: boolean;
  /** The label text, or '' when this tick is not labelled (it would collide). */
  label: string;
}

export interface TickSet {
  minorPs: number;
  majorPs: number;
  ticks: Tick[];
  /** A single time drawn at x=0: the base the tick labels are offsets from (see
   *  `axisLabels.ts`), or, on a plot too narrow to label any tick, the left edge's time.
   *  Null in the normal case, where every tick label is an absolute time. */
  pinned: Tick | null;
}

/** How labels are measured and placed: `measure` returns a label's width in CSS px and
 *  `offset` is how far right of its (rounded) tick x a label starts. */
export interface TickLabelMetrics {
  measure(text: string): number;
  offset: number;
}

/** Clear space kept between two labels in the same row, CSS px. */
export const LABEL_GAP = 6;
/** Label strides tried, in minor ticks; each divides the ten minors of a major. */
const LABEL_STRIDES = [1, 2, 5, 10] as const;

/** A canvas-free width estimate for the 11 px bold tick font (generous for digits). */
export function estimateLabelWidth(text: string): number {
  return text.length * 6.6;
}

const DEFAULT_METRICS: TickLabelMetrics = { measure: estimateLabelWidth, offset: 1 };

/**
 * A memoised `measureText` for one canvas font. Tick strings repeat from frame to frame,
 * so the cache keeps axis layout to a few map lookups; it is cleared when it grows.
 */
export function canvasLabelMeasure(
  ctx: () => CanvasRenderingContext2D | null, font: string,
): (text: string) => number {
  const cache = new Map<string, number>();
  return (text: string): number => {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const c = ctx();
    if (!c) return estimateLabelWidth(text);
    c.font = font;
    const w = c.measureText(text).width;
    if (cache.size > 512) cache.clear();
    cache.set(text, w);
    return w;
  };
}

interface RawTick {
  ps: number;
  x: number;
  major: boolean;
  /** Position within its major, 0..9. */
  index: number;
}

/**
 * @param startPs  time at the left edge of the plot
 * @param endPs    time at the right edge
 * @param widthCss plot width in CSS px
 * @param samplerateHz capture sampling rate; enables sample-aligned high-zoom ticks
 * @param metrics  label measurement; the default is a canvas-free estimate
 */
export function computeTicks(
  startPs: number,
  endPs: number,
  widthCss: number,
  samplerateHz?: number,
  minSpacing: number = AXIS.minTickSpacing,
  metrics: TickLabelMetrics = DEFAULT_METRICS,
): TickSet {
  if (!(endPs > startPs) || !(widthCss > 0)) {
    return { minorPs: 1, majorPs: 10, ticks: [], pinned: null };
  }
  const spanPs = endPs - startPs;
  const pxPerPs = widthCss / spanPs;

  const samplePeriodPs = samplerateHz !== undefined && samplerateHz > 0
    ? 1e12 / samplerateHz : Infinity;
  const samplesVisible = spanPs / samplePeriodPs;
  const sampleAligned = Number.isFinite(samplePeriodPs) && (
    samplePeriodPs * pxPerPs >= minSpacing ||
    samplesVisible <= MIN_SAMPLES_ON_SCREEN * (1 + 1e-9)
  );
  const { minorPs, raw } = sampleAligned
    ? sampleTicks(startPs, endPs, pxPerPs, samplePeriodPs)
    : decimalTicks(startPs, endPs, pxPerPs, minSpacing);
  return labelTicks(raw, startPs, minorPs, minorPs * pxPerPs, widthCss, metrics);
}

function decimalTicks(
  startPs: number, endPs: number, pxPerPs: number, minSpacing: number,
): { minorPs: number; raw: RawTick[] } {
  // Smallest power of ten at least AXIS.minTickSpacing px wide. 1 ps is the floor: below
  // that there is nothing meaningful left to label.
  let k = Math.ceil(Math.log10(minSpacing / pxPerPs));
  if (!Number.isFinite(k)) k = 0;
  if (k < 0) k = 0;
  const minorPs = Math.pow(10, k);
  const raw: RawTick[] = [];
  // A guard, not a policy: at 45 px minimum spacing a 4000 px window holds under 100
  // ticks, so anything near this bound means the arithmetic went wrong upstream.
  const maxTicks = 4096;
  for (let n = Math.ceil(startPs / minorPs); n * minorPs < endPs && raw.length < maxTicks; n++) {
    const t = n * minorPs;
    const index = ((n % 10) + 10) % 10;
    raw.push({ ps: t, x: (t - startPs) * pxPerPs, major: index === 0, index });
  }
  return { minorPs, raw };
}

/** Sampling-period ticks, calculated from sample indices rather than repeated addition. */
function sampleTicks(
  startPs: number, endPs: number, pxPerPs: number, periodPs: number,
): { minorPs: number; raw: RawTick[] } {
  const raw: RawTick[] = [];
  // The tolerance only prevents an exact sample boundary represented one ulp high from
  // being skipped. It is far too small to admit the preceding sample.
  const firstSample = Math.ceil(startPs / periodPs - 1e-10);
  const lastSample = Math.ceil(endPs / periodPs - 1e-10);
  const maxTicks = 4096;
  for (let sample = firstSample; sample < lastSample && raw.length < maxTicks; sample++) {
    const exactPs = sample * periodPs;
    const index = ((sample % 10) + 10) % 10;
    raw.push({ ps: exactPs, x: (exactPs - startPs) * pxPerPs, major: index === 0, index });
  }
  return { minorPs: periodPs, raw };
}

/**
 * Choose which ticks carry a label and what it says.
 *
 * Majors are drawn in the top row (with the base, when there is one) and the other
 * labelled ticks in the bottom row, so collisions are per row. The stride is the smallest
 * of 1, 2, 5, 10 minors at which the widest measured minor label plus {@link LABEL_GAP}
 * fits the stride's spacing; the labels' decimals come from that labelled step. A final
 * per-row pass still drops a label that would run into the previous one, into the base
 * at the left, or past the right edge - widths vary ("-100 ms" against "0 ms"), and a
 * missing label is better than two overprinted ones.
 */
function labelTicks(
  raw: readonly RawTick[], startPs: number, minorPs: number, minorPx: number, widthCss: number,
  metrics: TickLabelMetrics,
): TickSet {
  const majorPs = minorPs * 10;
  const ticks: Tick[] = raw.map((t) => ({ ps: t.ps, x: t.x, major: t.major, label: '' }));
  let chosen: { texts: [number, string][]; base: Tick | null } | null = null;
  for (const stride of LABEL_STRIDES) {
    const picked: number[] = [];
    for (let i = 0; i < raw.length; i++) if (raw[i]!.index % stride === 0) picked.push(i);
    if (picked.length === 0) continue;
    const plan = planAxisLabels(picked.map((i) => raw[i]!.ps), minorPs * stride);
    let widest = 0;
    const texts = picked.map((i): [number, string] => {
      const text = axisLabel(raw[i]!.ps, plan);
      if (!raw[i]!.major) widest = Math.max(widest, metrics.measure(text));
      return [i, text];
    });
    const base = plan.basePs === null || plan.baseLabel === null
      ? null : { ps: plan.basePs, x: 0, major: true, label: plan.baseLabel };
    chosen = { texts, base };
    if (widest + LABEL_GAP <= stride * minorPx) break;
  }
  if (!chosen) return { minorPs, majorPs, ticks, pinned: leftEdgeLabel(startPs, minorPs) };

  const pinned = chosen.base;
  // Row 0 is the major row, shared with the base; row 1 is the minor row.
  const rowRight = [
    pinned ? baseLabelLeft() + metrics.measure(pinned.label) + LABEL_GAP : Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const [i, text] of chosen.texts) {
    const tick = ticks[i]!;
    const row = tick.major ? 0 : 1;
    const left = Math.round(tick.x) + metrics.offset;
    const right = left + metrics.measure(text);
    if (left < rowRight[row]! || right > widthCss) continue;
    tick.label = text;
    rowRight[row] = right + LABEL_GAP;
  }
  if (pinned === null && ticks.every((t) => t.label === '')) {
    return { minorPs, majorPs, ticks, pinned: leftEdgeLabel(startPs, minorPs) };
  }
  return { minorPs, majorPs, ticks, pinned };
}

/**
 * A narrow plot can hold one tick or none (minor spacing is a power of ten up to ten
 * times the minimum spacing). Then the left edge itself is labelled, to a tenth of the
 * minor step, so the axis never shows no time at all.
 */
function leftEdgeLabel(startPs: number, minorPs: number): Tick {
  const step = minorPs / 10;
  const ps = Math.floor(startPs / step) * step;
  return { ps, x: 0, major: true, label: formatStandaloneTime(ps, step) };
}

/** Where the base label starts: just right of the pinned arrow. */
function baseLabelLeft(): number {
  return AXIS.pinnedArrow.w + 2;
}

/**
 * Paint the axis strip. `ctx` is already scaled so 1 unit is 1 CSS px; the caller owns
 * the canvas sizing.
 */
export function drawAxis(
  ctx: CanvasRenderingContext2D,
  set: TickSet,
  widthCss: number,
  heightCss: number,
  palette: CanvasPalette,
): void {
  ctx.clearRect(0, 0, widthCss, heightCss);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, widthCss, heightCss);

  ctx.font = AXIS.tickFont;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const majorTop = heightCss * AXIS.majorTickFraction;
  const minorTop = heightCss - AXIS.minorTickLength;

  for (const t of set.ticks) {
    const x = Math.round(t.x) + 0.5;
    ctx.strokeStyle = t.major ? palette.axisTickMajor : palette.axisTickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, t.major ? majorTop : minorTop);
    ctx.lineTo(x, heightCss);
    ctx.stroke();

    if (t.label === '') continue;
    ctx.fillStyle = t.major ? palette.text : palette.text50;
    ctx.fillText(t.label, Math.round(t.x) + 1, t.major ? AXIS.majorBaseline : AXIS.minorBaseline);
  }

  if (set.pinned) {
    // The base the offsets are measured from: a 4x6 px left-pointing arrow (it lies at
    // or before the left edge) and its absolute time.
    const { w, h } = AXIS.pinnedArrow;
    ctx.fillStyle = palette.text;
    ctx.beginPath();
    ctx.moveTo(0, majorTop + h / 2);
    ctx.lineTo(w, majorTop);
    ctx.lineTo(w, majorTop + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillText(set.pinned.label, baseLabelLeft(), AXIS.majorBaseline);
  }
}
