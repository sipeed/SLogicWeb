// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Parallel-bus (ADC) views: configuration, and what each frame draws.
 *
 * A bus view turns n capture channels into one analog row (src/data/busValue.ts does the
 * reading). Per frame, `analogFrame` picks one of two sources for the visible range:
 *
 *   - zoomed in (few samples per pixel): the exact value timeline for the window, drawn
 *     as points when there are fewer values than pixels or fewer than four samples per
 *     device-pixel column, otherwise as the min/max of the samples timestamped in each
 *     pixel column;
 *   - between that and two pyramid leaves per column: the same exact in-column min/max,
 *     streamed through the window in bounded chunks. A pyramid leaf (BUS_LEAF samples)
 *     wider than a column would paint one flat box over several columns - the staircase
 *     a dense analog signal (a step on nearly every sample) used to fall back to;
 *   - zoomed out: the background-built pyramid, a min/max per pixel column - the part not
 *     built yet is simply left empty and fills in as the builder runs.
 *
 * Both are cached by window, so a redraw for a hover or cursor costs nothing.
 */

import {
  BUS_LEAF, BusBuilder, busRange, busSteps, busValue, latchedBefore, readCode, type BusSpec,
} from '../data/busValue.js';
import type { GapSpan, SampleStore } from '../data/types.js';
import { SMOOTH_POINTS_MAX_SPP } from './analogGeometry.js';

export type BusDrawStyle = 'line' | 'step';

/**
 * Which end of a contiguous bit run carries the code's MSB.
 *
 * `auto` follows the device: on live inputs Sipeed's ADC module wires CH0 to the MSB,
 * while the firmware's built-in test patterns send their bytes LSB first (vendor
 * CHANGELOG, "ADC bit order" - ngscopeclient calls the same rule *Auto*). Test mode 0 is
 * the normal input path, so auto means MSB there and LSB in any test pattern (modes 1
 * and 2). The explicit settings do not depend on the capture mode. A bus whose bits are
 * not a contiguous run has no meaningful end, so the order is ignored for it.
 */
export type BusBitOrder = 'auto' | 'msb' | 'lsb';

export interface BusViewConfig {
  name: string;
  usesDefaultName?: boolean;
  spec: BusSpec;
  /** Defaults to `auto` for views restored from older workspaces. */
  bitOrder?: BusBitOrder;
  color: string;
  /** Volts for the full code range (2^n LSB); null shows raw values. */
  fullScaleV: number | null;
  offsetV: number;
  /** Set only by the Analog button: this view is the ADC group `analogGroup` (0–3). */
  analogGroup?: number;
  /**
   * The gain ratio the user declared for the ADC module's front-end stage (set on the
   * module, never programmed by the host). Only on an analog group; absent means 1x.
   * `fullScaleV`/`offsetV` are derived from it (`analogSpan`), never set independently.
   */
  analogGain?: number;
  /** Analog scope vertical scale; null fits the full code range. */
  voltsPerDiv?: number | null;
  /** Where 0 V sits in the row, 0 (top) .. 1 (bottom); default 0.5. */
  zeroPosition?: number;
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
/**
 * Below this many samples per column the envelope is read exactly from the store: a
 * leaf then covers at most half a column, so the pyramid could only smear it.
 */
const EXACT_COLUMN_SPP = 2 * BUS_LEAF;
/** Samples per streamed chunk of the exact column envelope (bounds its step arrays). */
const EXACT_COLUMN_CHUNK = 1 << 16;
/**
 * The streamed envelope reads every sample (~25 ns each on a dense 8-bit bus), so it is
 * capped at ~25 ms per window change. A wider window at under EXACT_COLUMN_SPP samples
 * per column only happens on very wide canvases, where a leaf is already about one
 * device pixel or less.
 */
const EXACT_COLUMN_WINDOW = 1 << 20;

/**
 * Sample positions one coarse frame may spend on provisional columns, per bus. The
 * pyramid is the authoritative envelope, but a fast loop deliberately stops building it
 * (the ingest path has priority) and the builder always lags a live edge. Sampling a
 * bounded number of points per column keeps a coarse min/max envelope on screen instead
 * of a blank row; the next frame with a more complete pyramid replaces it. The budget is
 * POSITIONS: each costs one `readCode`, i.e. `bits.length` sample reads, so 24k positions
 * is about 1 ms for an 8-bit bank and 4-6 ms for a 32-bit user bus on a desktop. The
 * fast-loop draw cadence is 50 ms and this path only runs while the built envelope is
 * unavailable.
 */
const PROVISIONAL_READ_BUDGET = 24_000;
const PROVISIONAL_MIN_PER_COL = 2;
const PROVISIONAL_MAX_PER_COL = 64;
/** Sample reads the App may spend on all provisional columns in one draw. */
const PROVISIONAL_FRAME_READS = 240_000;
let frameReadsLeft: number | null = null;

/**
 * Start a draw's shared provisional budget. Without this (direct API use, tests) each
 * frame is budgeted independently; the App brackets its draw so four analog banks plus
 * user buses cannot multiply the cost of one frame.
 */
export function beginAnalogFrameBudget(reads = PROVISIONAL_FRAME_READS): void {
  frameReadsLeft = Math.max(0, reads);
}

export function endAnalogFrameBudget(): void {
  frameReadsLeft = null;
}

export type AnalogFrame =
  | { kind: 'points'; x: Float64Array; v: Float64Array; count: number }
  /** `provisional`: some columns were sampled, not built, so the envelope is coarse. */
  | { kind: 'columns'; min: Float64Array; max: Float64Array; provisional?: boolean }
  | { kind: 'empty'; reason: 'no-capture' | 'live' };

/** The value range the row's height spans: full scale for the bit width. */
export function busYRange(cfg: BusViewConfig): { min: number; max: number } {
  return busRange(cfg.spec.bits.length, cfg.spec.encoding);
}

/** A value as the row labels it: volts when a full scale is set, else the raw value. */
export function busLabel(cfg: BusViewConfig, v: number): string {
  if (cfg.fullScaleV === null) return String(v);
  // The code range spans 2^n - 1 steps, not 2^n. An ADC group's offset and span are
  // derived from its profile scale and gain (`analogSpan`), so this linear reading equals
  // (code - 128) * LSB / G there.
  const steps = 2 ** cfg.spec.bits.length - 1;
  const volts = cfg.offsetV + (v / steps) * cfg.fullScaleV;
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

/** What `order` means for a capture in `testMode`; see `BusBitOrder` for the rule. */
export function resolveBusBitOrder(order: BusBitOrder, testMode: number): 'msb' | 'lsb' {
  if (order !== 'auto') return order;
  return testMode === 0 ? 'msb' : 'lsb';
}

/**
 * The config with its bit run oriented for `testMode`. Only a contiguous run is touched:
 * arbitrary per-bit wiring was chosen channel by channel and has no "end". Returns the
 * same object when nothing changes, so callers can use identity to skip work.
 */
export function applyBusBitOrder<T extends BusViewConfig>(config: T, testMode: number): T {
  if (busRun(config.spec.bits) === null) return config;
  const wantMsb = resolveBusBitOrder(config.bitOrder ?? 'auto', testMode) === 'msb';
  const isMsb = runStart(config.spec.bits).msbFirst;
  if (wantMsb === isMsb) return config;
  return { ...config, spec: swapBusOrder(config.spec) };
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
  // A fixed historical window must survive unrelated appends. `visibleEnd` changes only
  // when the window itself reaches the growing edge; loop drops still invalidate by origin.
  // A Repeat composite keeps its length while its current-wave frontier advances, so its
  // frontier is part of the key: the provisional/live envelope must follow the fill.
  const visibleEnd = Math.min(store.length, Math.ceil(end));
  const frontier = (store as SampleStore & { frontier?: number }).frontier;
  const key = [visibleEnd, store.droppedSamples, start, end, widthPx,
    bv.builder?.pyramid.doneUpTo ?? -1, live,
    frontier === undefined ? '' : frontier].join(':');
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
  if (e > s && spp < EXACT_COLUMN_SPP &&
      e - s <= (spp > EXACT_SPP ? EXACT_COLUMN_WINDOW : EXACT_WINDOW)) {
    const carry = latchedBefore(store, bv.spec, s);
    if (spp > EXACT_SPP) {
      return { kind: 'columns', ...exactColumns(store, bv.spec, start, end, widthPx, carry) };
    }
    // 16 steps per column: a signal changing on every sample keeps the exact
    // (in-column) envelope up to 16 samples per column before the pyramid takes over.
    const st = busSteps(store, bv.spec, s, e, { carry, maxSteps: widthPx * 16 });
    if (!st.truncated) {
      const x = (sample: number) => ((sample - start) / span) * widthPx;
      // Points while they are sparse, and also while a column holds fewer than
      // SMOOTH_POINTS_MAX_SPP samples: at 1.4-2 samples per column the envelope below
      // has one or two values per column and reads as stair steps, while the curve
      // through the samples is exact. spp < 4 bounds the steps at four per column,
      // so the path stays O(width).
      if (st.count <= widthPx / 2 || spp < SMOOTH_POINTS_MAX_SPP) {
        const xs = new Float64Array(st.count);
        for (let i = 0; i < st.count; i++) xs[i] = x(st.pos[i]!);
        return { kind: 'points', x: xs, v: st.val.slice(0, st.count), count: st.count };
      }
      // More values than pixels: the min/max of the samples whose timestamps fall in
      // each column. A step holds its value from its position to the next step's, so it
      // covers the columns of its first and last sample timestamp - not the column the
      // last sample's period merely ends in, which smeared each value one column right
      // and widened every band by a neighbour's value.
      const min = new Float64Array(widthPx).fill(Number.NaN);
      const max = new Float64Array(widthPx).fill(Number.NaN);
      for (let i = 0; i < st.count; i++) {
        const v = st.val[i]!;
        if (Number.isNaN(v)) continue;
        const first = Math.max(st.pos[i]!, Math.ceil(start));
        const last = (i + 1 < st.count ? st.pos[i + 1]! : e) - 1;
        if (last < first) continue;
        const c0 = Math.max(0, Math.floor(x(first)));
        const c1 = Math.min(widthPx - 1, Math.floor(x(last)));
        for (let c = c0; c <= c1; c++) {
          if (!(v >= min[c]!)) min[c] = v;
          if (!(v <= max[c]!)) max[c] = v;
        }
      }
      return { kind: 'columns', min, max };
    }
    // More steps than the cached step list may hold (a dense analog signal changes on
    // nearly every sample): stream the same in-column envelope instead of falling back
    // to leaves wider than a column.
    return { kind: 'columns', ...exactColumns(store, bv.spec, start, end, widthPx, carry) };
  }
  const pyramid = bv.builder?.pyramid ?? null;
  if (pyramid) {
    // The bins are absolute, so `range()` converts through the window origin the builder
    // carries - refresh it from the store here rather than trusting the pump. A drop can
    // land between the pump's `setLength` and this draw (a bus the one-bus-per-frame pump
    // has not reached yet, or the stop drain, where the pump does not run at all), and a
    // stale origin reads bins the window has already left, i.e. pre-drop data.
    pyramid.setOrigin(store.droppedSamples);
  }
  const done = pyramid ? Math.min(store.length, pyramid.doneUpTo) : 0;
  const gaps = store.gaps();
  const gapCursor = { at: 0 };
  const bits = Math.max(1, bv.spec.bits.length);
  // Positions the shared frame budget can still afford for this bus (or the direct-call
  // per-bus budget). Below the two-per-column floor, leave the columns unknown rather
  // than blow the frame budget.
  const positions = Math.min(
    PROVISIONAL_READ_BUDGET,
    frameReadsLeft === null ? PROVISIONAL_READ_BUDGET : Math.floor(frameReadsLeft / bits),
  );
  const wanted = Math.floor(positions / Math.max(1, widthPx));
  const perCol = wanted < PROVISIONAL_MIN_PER_COL
    ? 0 : Math.min(PROVISIONAL_MAX_PER_COL, wanted);
  const min = new Float64Array(widthPx).fill(Number.NaN);
  const max = new Float64Array(widthPx).fill(Number.NaN);
  let provisional = false;
  let known = 0;
  let probed = 0;
  for (let c = 0; c < widthPx; c++) {
    const a = start + c * spp;
    const b = a + spp;
    if (b <= 0 || a >= store.length) continue;
    const lo = Math.max(0, a);
    const hi = Math.min(b, store.length);
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    if (pyramid && done > lo) {
      const r = pyramid.range(lo, Math.min(hi, done));
      if (r) { mn = r.min; mx = r.max; }
    }
    // Nothing is built past `done` (fast loop, or a builder still walking forward). A
    // bounded sample of that part is the difference between a coarse envelope and no
    // waveform at all. Clocked buses latch on edges, so a plain sample is not their
    // value; they keep the exact path and wait for the builder.
    const probeLo = Math.max(lo, done);
    if (perCol > 0 && probeLo < hi && !bv.spec.clock) {
      const r = provisionalRange(store, bv.spec, probeLo, hi, gaps, gapCursor, perCol);
      probed++;
      if (r) {
        if (r.min < mn) mn = r.min;
        if (r.max > mx) mx = r.max;
        provisional = true;
      }
    }
    if (mn <= mx) { min[c] = mn; max[c] = mx; known++; }
  }
  if (frameReadsLeft !== null) {
    frameReadsLeft = Math.max(0, frameReadsLeft - probed * perCol * bits);
  }
  // A clocked bus with no built columns has nothing truthful to show yet; keep the
  // existing live/empty note rather than inventing latched values.
  if (known === 0) return { kind: 'empty', reason: live ? 'live' : 'no-capture' };
  return provisional
    ? { kind: 'columns', min, max, provisional: true }
    : { kind: 'columns', min, max };
}

/**
 * The exact min/max of the samples timestamped in each column of [start, end), read in
 * EXACT_COLUMN_CHUNK pieces so no step list grows with the window. Same rule as the
 * cached exact path: a step covers the columns of its first and last sample timestamp.
 */
function exactColumns(
  store: SampleStore, spec: BusSpec, start: number, end: number, widthPx: number, carry: number,
): { min: Float64Array; max: Float64Array } {
  const span = end - start;
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(store.length, Math.ceil(end));
  const first0 = Math.ceil(start);
  const min = new Float64Array(widthPx).fill(Number.NaN);
  const max = new Float64Array(widthPx).fill(Number.NaN);
  const col = (sample: number) => Math.floor(((sample - start) / span) * widthPx);
  let latched = carry;
  for (let a = s; a < e; a += EXACT_COLUMN_CHUNK) {
    const b = Math.min(e, a + EXACT_COLUMN_CHUNK);
    const st = busSteps(store, spec, a, b, { carry: latched });
    latched = st.carry;
    for (let i = 0; i < st.count; i++) {
      const v = st.val[i]!;
      if (Number.isNaN(v)) continue;
      const first = Math.max(st.pos[i]!, first0);
      const last = (i + 1 < st.count ? st.pos[i + 1]! : b) - 1;
      if (last < first) continue;
      const c0 = Math.max(0, col(first));
      const c1 = Math.min(widthPx - 1, col(last));
      for (let c = c0; c <= c1; c++) {
        if (!(v >= min[c]!)) min[c] = v;
        if (!(v <= max[c]!)) max[c] = v;
      }
    }
  }
  return { min, max };
}

/**
 * Min/max over up to `perCol` evenly spread samples of [a, b). This is a coarse envelope,
 * not the exact one: `perCol` bounds the work by the frame width instead of the window
 * (which can be 2^31 samples in a loop). Positions inside a capture gap are unknown and
 * skipped. Returns null when every sampled position is unknown.
 */
function provisionalRange(
  store: SampleStore, spec: BusSpec, a: number, b: number, gaps: readonly GapSpan[],
  cursor: { at: number }, perCol: number,
): { min: number; max: number } | null {
  const lo = Math.max(0, Math.floor(a));
  const hi = Math.min(store.length, Math.ceil(b));
  if (hi <= lo) return null;
  const width = hi - lo;
  const n = spec.bits.length;
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < perCol; k++) {
    const p = lo + Math.floor(((k + 0.5) * width) / perCol);
    if (p < lo || p >= hi) continue;
    // Gaps are sorted and the column walk moves forward; advance the shared cursor
    // instead of searching from the start for every sample.
    while (cursor.at < gaps.length && gaps[cursor.at]!.endSample <= p) cursor.at++;
    if (cursor.at < gaps.length && gaps[cursor.at]!.startSample <= p) continue;
    const v = busValue(readCode(store, spec.bits, p), n, spec.encoding);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return mn <= mx ? { min: mn, max: mx } : null;
}

/** The value at one sample, for the hover readout. NaN when unknown. */
export function busValueAt(store: SampleStore, spec: BusSpec, sample: number): number {
  if (sample < 0 || sample >= store.length) return Number.NaN;
  const st = busSteps(store, spec, sample, sample + 1, { carry: latchedBefore(store, spec, sample) });
  return st.count ? st.val[st.count - 1]! : Number.NaN;
}
