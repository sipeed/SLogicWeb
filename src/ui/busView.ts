// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Parallel-bus (ADC) views: configuration, and what each frame draws.
 *
 * A bus view turns n capture channels into one analog row (src/data/busValue.ts does the
 * reading). Per frame, `analogFrame` picks one of two sources for the visible range:
 *
 *   - zoomed in (few samples per pixel): the exact value timeline for the window, drawn
 *     as points when there are fewer values than pixels, or as a min/max per pixel
 *     column when there are more;
 *   - zoomed out: the background-built pyramid, a min/max per pixel column - the part not
 *     built yet is simply left empty and fills in as the builder runs.
 *
 * Both are cached by window, so a redraw for a hover or cursor costs nothing.
 */

import {
  BusBuilder, busRange, busSteps, latchedBefore, type BusSpec,
} from '../data/busValue.js';
import type { SampleStore } from '../data/types.js';

export type BusDrawStyle = 'line' | 'step';

export interface BusViewConfig {
  name: string;
  spec: BusSpec;
  color: string;
  /** Volts for the full code range (2^n LSB); null shows raw values. */
  fullScaleV: number | null;
  offsetV: number;
  /** Points joined by lines (an ADC's samples) or held as steps. */
  style: BusDrawStyle;
  heightCss: number;
  /** Leave the source bits out of the plot. Display only: capture settings are untouched. */
  hideSources: boolean;
}

export interface BusViewState extends BusViewConfig {
  id: string;
  /** Built for `builtFor`; null until there is a capture to build from. */
  builder: BusBuilder | null;
  builtFor: SampleStore | null;
  cache: { key: string; frame: AnalogFrame } | null;
}

export const BUS_HEIGHTS = [80, 120, 160, 240] as const;

/**
 * Trace colours, cycled per bus view: the vivid tones of the channel palette. The
 * analyzer palette is deliberately muted for lane fills, and as a 1 px trace it sank into
 * the grid lines and labels.
 */
const BUS_COLORS = ['#4C9AFF', '#48C860', '#FF9E2C', '#F2D024', '#FF4D4D'] as const;

export function busColor(n: number): string {
  return BUS_COLORS[n % BUS_COLORS.length]!;
}
export const DEFAULT_BUS_HEIGHT = 120;

/** Up to this many samples per device pixel the exact timeline is used. */
const EXACT_SPP = 256;
/** And never over a window wider than this (the steps would be too many to cache). */
const EXACT_WINDOW = 4_000_000;

export type AnalogFrame =
  | { kind: 'points'; x: Float64Array; v: Float64Array; count: number }
  | { kind: 'columns'; min: Float64Array; max: Float64Array }
  | { kind: 'empty'; reason: 'no-capture' | 'live' };

/** The value range the row's height spans: full scale for the bit width. */
export function busYRange(cfg: BusViewConfig): { min: number; max: number } {
  return busRange(cfg.spec.bits.length, cfg.spec.encoding);
}

/** A value as the row labels it: volts when a full scale is set, else the raw value. */
export function busLabel(cfg: BusViewConfig, v: number): string {
  if (cfg.fullScaleV === null) return String(v);
  const volts = cfg.offsetV + (v / 2 ** cfg.spec.bits.length) * cfg.fullScaleV;
  const abs = Math.abs(volts);
  return abs !== 0 && abs < 1 ? `${(volts * 1000).toPrecision(4)} mV` : `${volts.toPrecision(4)} V`;
}

/** The bits run one channel apart, in either direction (LSB on the lowest or highest). */
export function busRun(bits: readonly number[]): 'up' | 'down' | null {
  if (bits.length < 2) return null;
  if (bits.every((c, i) => i === 0 || c === bits[i - 1]! + 1)) return 'up';
  if (bits.every((c, i) => i === 0 || c === bits[i - 1]! - 1)) return 'down';
  return null;
}

/** The same bus with its bit order reversed: the LSB becomes the MSB and back. */
export function swapBusOrder(spec: BusSpec): BusSpec {
  return { ...spec, bits: [...spec.bits].reverse() };
}

/**
 * Bits (LSB first) for `width` consecutive channels from `start` upwards, shifted to fit
 * in `cc` channels. The start channel is the LSB, or with `msbFirst` the MSB - the order
 * is then reversed, as when an ADC's data lines are wired MSB-first.
 */
export function runBits(start: number, width: number, cc: number, msbFirst: boolean): number[] {
  const s = Math.max(0, Math.min(start, cc - width));
  const bits = Array.from({ length: width }, (_, i) => s + i);
  return msbFirst ? bits.reverse() : bits;
}

/** The editor's view of a bus's bits: the run's first channel and whether it is the MSB. */
export function runStart(bits: readonly number[]): { start: number; msbFirst: boolean } {
  const run = busRun(bits);
  return run ? { start: Math.min(...bits), msbFirst: run === 'down' } : { start: bits[0] ?? 0, msbFirst: false };
}

/**
 * "D0–D11 · ↑D12": the bits from LSB to MSB, then the clock. A reversed contiguous bus
 * reads "D11–D0" - LSB first, like every other summary.
 */
export function busSummary(spec: BusSpec): string {
  const b = spec.bits;
  const run = busRun(b);
  const bits = b.length === 1 ? `D${b[0]}`
    : run ? `D${b[0]}–D${b[b.length - 1]}`
      : b.map((c) => `D${c}`).join(',');
  const clock = spec.clock ? ` · ${spec.clock.edge === 'rising' ? '↑' : '↓'}D${spec.clock.channel}` : '';
  return `${bits}${clock}`;
}

/**
 * What to draw for one bus over [start, end) on `widthPx` device pixels. `live` means the
 * store is still growing; the pyramid then covers only what the builder has reached.
 */
export function analogFrame(
  store: SampleStore, bv: BusViewState, start: number, end: number, widthPx: number, live: boolean,
): AnalogFrame {
  if (store.length === 0 || widthPx <= 0 || !(end > start)) return { kind: 'empty', reason: 'no-capture' };
  // droppedSamples distinguishes two loop generations at the same length/doneUpTo.
  const key = [store.length, store.droppedSamples, start, end, widthPx, bv.builder?.pyramid.doneUpTo ?? -1].join(':');
  if (bv.cache?.key === key) return bv.cache.frame;
  const frame = compute(store, bv, start, end, widthPx, live);
  bv.cache = { key, frame };
  return frame;
}

function compute(
  store: SampleStore, bv: BusViewState, start: number, end: number, widthPx: number, live: boolean,
): AnalogFrame {
  const span = end - start;
  const spp = span / widthPx;
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(store.length, Math.ceil(end));
  if (e > s && spp <= EXACT_SPP && e - s <= EXACT_WINDOW) {
    const carry = latchedBefore(store, bv.spec, s);
    const st = busSteps(store, bv.spec, s, e, { carry, maxSteps: widthPx * 8 });
    if (!st.truncated) {
      const x = (sample: number) => ((sample - start) / span) * widthPx;
      if (st.count <= widthPx / 2) {
        const xs = new Float64Array(st.count);
        for (let i = 0; i < st.count; i++) xs[i] = x(st.pos[i]!);
        return { kind: 'points', x: xs, v: st.val.slice(0, st.count), count: st.count };
      }
      // More values than pixels: the min/max each column covers.
      const min = new Float64Array(widthPx).fill(Number.NaN);
      const max = new Float64Array(widthPx).fill(Number.NaN);
      for (let i = 0; i < st.count; i++) {
        const v = st.val[i]!;
        if (Number.isNaN(v)) continue;
        const c0 = Math.max(0, Math.floor(x(st.pos[i]!)));
        const c1 = Math.min(widthPx - 1, Math.floor(x(i + 1 < st.count ? st.pos[i + 1]! : e) - 1e-9));
        for (let c = c0; c <= c1; c++) {
          if (!(v >= min[c]!)) min[c] = v;
          if (!(v <= max[c]!)) max[c] = v;
        }
      }
      return { kind: 'columns', min, max };
    }
  }
  if (!bv.builder) return { kind: 'empty', reason: live ? 'live' : 'no-capture' };
  const pyramid = bv.builder.pyramid;
  // The bins are absolute, so `range()` converts through the window origin the builder
  // carries - refresh it from the store here rather than trusting the pump. A drop can
  // land between the pump's `setLength` and this draw (a bus the one-bus-per-frame pump
  // has not reached yet, or the stop drain, where the pump does not run at all), and a
  // stale origin reads bins the window has already left, i.e. pre-drop data.
  pyramid.setOrigin(store.droppedSamples);
  const min = new Float64Array(widthPx).fill(Number.NaN);
  const max = new Float64Array(widthPx).fill(Number.NaN);
  for (let c = 0; c < widthPx; c++) {
    const a = start + c * spp;
    const b = a + spp;
    if (b <= 0 || a >= Math.min(store.length, pyramid.doneUpTo)) continue;
    const r = pyramid.range(Math.max(0, a), Math.min(b, pyramid.doneUpTo));
    if (r) { min[c] = r.min; max[c] = r.max; }
  }
  return { kind: 'columns', min, max };
}

/** The value at one sample, for the hover readout. NaN when unknown. */
export function busValueAt(store: SampleStore, spec: BusSpec, sample: number): number {
  if (sample < 0 || sample >= store.length) return Number.NaN;
  const st = busSteps(store, spec, sample, sample + 1, { carry: latchedBefore(store, spec, sample) });
  return st.count ? st.val[st.count - 1]! : Number.NaN;
}
