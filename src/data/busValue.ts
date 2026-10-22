// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A parallel bus - typically an ADC's data lines - read back as one number per sample,
 * so its digital output can be drawn as the analog signal it encodes.
 *
 * A bus is n capture channels taken as bits, LSB first, plus an optional clock:
 *
 *   - without a clock the value changes whenever any data bit changes (asynchronous);
 *   - with one it is latched on the clock's active edge and held until the next, which
 *     is what an ADC's DCLK means and keeps the glitches of bits switching a few samples
 *     apart out of the picture.
 *
 * The value is piecewise constant: a list of steps (sample position, value) where each
 * value holds until the next step. NaN means unknown: inside a capture gap, and in
 * clocked mode from a gap until the next active clock edge latches a fresh value.
 *
 * Two readers sit on that timeline. `busSteps` computes it exactly for a sample range -
 * for a zoomed-in view, or one chunk at a time. `BusPyramid` keeps the min and max per
 * 1024-sample leaf and per 16x coarser level, built once in the background by
 * `BusBuilder`, so a zoomed-out view of 2^31 samples is a handful of lookups per pixel.
 */

import type { SampleStore } from './types.js';

export type BusEncoding = 'unsigned' | 'twos' | 'offset';

export interface BusClock {
  channel: number;
  edge: 'rising' | 'falling';
}

export interface BusSpec {
  /** Capture channels as bits, LSB first. */
  bits: readonly number[];
  clock: BusClock | null;
  encoding: BusEncoding;
}

export const MAX_BUS_BITS = 32;

/** Samples per pyramid leaf, and the fan-out of each coarser level (as planarStore). */
export const BUS_LEAF = 1024;
const FAN = 16;

/** Samples handled per piece, bounding the per-sample toggle mask to 4 MB. */
const PIECE = 1 << 20;

/** Problems with a spec for a store of `channelCount` channels; empty when valid. */
export function validateBusSpec(spec: BusSpec, channelCount: number): string[] {
  const out: string[] = [];
  const n = spec.bits.length;
  if (n < 1 || n > MAX_BUS_BITS) out.push(`a bus has 1 to ${MAX_BUS_BITS} bits, not ${n}`);
  const all = [...spec.bits, ...(spec.clock ? [spec.clock.channel] : [])];
  for (const ch of all) {
    if (!Number.isInteger(ch) || ch < 0 || ch >= channelCount) out.push(`channel ${ch} is not in D0-D${channelCount - 1}`);
  }
  if (new Set(all).size !== all.length) out.push('a channel is used twice');
  return out;
}

/** The signed value a code stands for. */
export function busValue(code: number, bits: number, encoding: BusEncoding): number {
  const full = 2 ** bits;
  const half = full / 2;
  if (encoding === 'unsigned') return code;
  if (encoding === 'offset') return code - half;
  return code >= half ? code - full : code;
}

/** The full-scale range of values for `bits` bits. */
export function busRange(bits: number, encoding: BusEncoding): { min: number; max: number } {
  const full = 2 ** bits;
  return encoding === 'unsigned' ? { min: 0, max: full - 1 } : { min: -full / 2, max: full / 2 - 1 };
}

/** The data bits at one sample as an unsigned code. */
export function readCode(store: SampleStore, bits: readonly number[], index: number): number {
  let code = 0;
  for (let k = bits.length - 1; k >= 0; k--) code = code * 2 + store.sampleAt(bits[k]!, index);
  return code;
}

export interface BusSteps {
  /** Step positions, ascending; `val[i]` holds from `pos[i]` to `pos[i + 1]` (or the end). */
  pos: Int32Array;
  val: Float64Array;
  count: number;
  /** `maxSteps` was reached before `end`: the steps cover only part of the range. */
  truncated: boolean;
  /** The value at the end of the range, to carry into the next one (clocked mode). */
  carry: number;
}

class StepSink {
  pos = new Int32Array(1024);
  val = new Float64Array(1024);
  count = 0;

  constructor(private readonly maxSteps: number) {}

  /** Append a step unless it repeats the last value. False once the cap is reached. */
  push(p: number, v: number): boolean {
    const last = this.count - 1;
    if (last >= 0) {
      const lv = this.val[last]!;
      if (lv === v || (Number.isNaN(lv) && Number.isNaN(v))) return true;
      if (this.pos[last] === p) { this.val[last] = v; return true; }
    }
    if (this.count >= this.maxSteps) return false;
    if (this.count === this.pos.length) {
      const pos = new Int32Array(this.pos.length * 2);
      const val = new Float64Array(this.val.length * 2);
      pos.set(this.pos);
      val.set(this.val);
      this.pos = pos;
      this.val = val;
    }
    this.pos[this.count] = p;
    this.val[this.count] = v;
    this.count++;
    return true;
  }

  get last(): number {
    return this.count ? this.val[this.count - 1]! : Number.NaN;
  }
}

/**
 * The value timeline over [start, end). In clocked mode the value at `start` is
 * `opts.carry` (the value latched before the range; NaN when unknown) - `latchedBefore`
 * finds it for an arbitrary window. Stops early at `opts.maxSteps` and says so.
 */
export function busSteps(
  store: SampleStore, spec: BusSpec, start: number, end: number,
  opts: { carry?: number; maxSteps?: number } = {},
): BusSteps {
  const sink = new StepSink(opts.maxSteps ?? Number.POSITIVE_INFINITY);
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(store.length, Math.ceil(end));
  let truncated = false;
  if (e > s) {
    const n = spec.bits.length;
    const decode = (code: number) => busValue(code, n, spec.encoding);
    const allGaps = store.gaps();
    const gaps = allGaps.filter((g) => g.endSample > s && g.startSample < e);
    // Walk the known ranges between gaps; a gap is a NaN step. A range that starts at a
    // gap's end - even the window's own start - has no known predecessor sample.
    let cur = s;
    let carry = spec.clock ? (opts.carry ?? Number.NaN) : Number.NaN;
    const known = (a: number, b: number): boolean => {
      if (b <= a) return true;
      const afterGap = allGaps.some((g) => g.endSample === a);
      return spec.clock
        ? clockedRange(store, spec, a, b, afterGap, carry, decode, sink)
        : asyncRange(store, spec.bits, a, b, decode, sink);
    };
    for (const g of gaps) {
      if (!known(cur, Math.min(g.startSample, e))) { truncated = true; break; }
      carry = Number.NaN;
      if (!sink.push(Math.max(g.startSample, s), Number.NaN)) { truncated = true; break; }
      cur = Math.max(cur, g.endSample);
    }
    if (!truncated && cur < e && !known(cur, e)) truncated = true;
  }
  return { pos: sink.pos, val: sink.val, count: sink.count, truncated, carry: sink.last };
}

/** Asynchronous: re-read the bits at `a`, then apply every data-bit edge in order. */
function asyncRange(
  store: SampleStore, bits: readonly number[], a: number, b: number,
  decode: (code: number) => number, sink: StepSink,
): boolean {
  let code = readCode(store, bits, a) | 0;
  if (!sink.push(a, decode(code >>> 0))) return false;
  const mask = new Int32Array(Math.min(PIECE, b - a));
  for (let p0 = a + 1; p0 < b; p0 += PIECE) {
    const p1 = Math.min(b, p0 + PIECE);
    const len = p1 - p0;
    mask.fill(0, 0, len);
    for (let k = 0; k < bits.length; k++) {
      const flip = 1 << k;
      const ed = store.edges(bits[k]!, p0, p1);
      for (let i = 0; i < ed.length; i++) mask[ed[i]! - p0] ^= flip;
    }
    for (let i = 0; i < len; i++) {
      const m = mask[i]!;
      if (m === 0) continue;
      code ^= m;
      if (!sink.push(p0 + i, decode(code >>> 0))) return false;
    }
  }
  return true;
}

/** Clocked: hold `carry`, latch the bits at every active clock edge. */
function clockedRange(
  store: SampleStore, spec: BusSpec, a: number, b: number, afterGap: boolean, carry: number,
  decode: (code: number) => number, sink: StepSink,
): boolean {
  const clock = spec.clock!;
  const want = clock.edge === 'rising' ? 1 : 0;
  if (!sink.push(a, carry)) return false;
  const ed = store.edges(clock.channel, a, b);
  for (let i = 0; i < ed.length; i++) {
    const p = ed[i]!;
    // An edge at a gap's end compares against filler, not data: its direction is unknown.
    if (afterGap && p === a) continue;
    if (store.sampleAt(clock.channel, p) !== want) continue;
    if (!sink.push(p, decode(readCode(store, spec.bits, p)))) return false;
  }
  return true;
}

/**
 * The value a clocked bus holds just before `index`: the bits at the last active clock
 * edge before it. NaN if there is none within `maxLookback` samples, or a gap lies
 * between that edge and `index`. Asynchronous buses have no history: NaN.
 */
export function latchedBefore(store: SampleStore, spec: BusSpec, index: number, maxLookback = 1 << 24): number {
  const clock = spec.clock;
  if (!clock || index <= 0) return Number.NaN;
  const want = clock.edge === 'rising' ? 1 : 0;
  const gaps = store.gaps();
  let hi = Math.min(index, store.length);
  for (let span = 4096; ; span *= 4) {
    const lo = Math.max(0, index - span);
    const ed = store.edges(clock.channel, lo, hi);
    for (let i = ed.length - 1; i >= 0; i--) {
      const p = ed[i]!;
      if (store.sampleAt(clock.channel, p) !== want) continue;
      if (gaps.some((g) => g.endSample > p && g.startSample < index)) return Number.NaN;
      if (gaps.some((g) => g.endSample === p)) continue;   // direction unknown, see above
      return busValue(readCode(store, spec.bits, p), spec.bits.length, spec.encoding);
    }
    if (lo === 0 || index - lo >= maxLookback) return Number.NaN;
    hi = lo;
  }
}

/**
 * Min and max of the value per 1024-sample leaf and per 16x coarser level. NaN steps are
 * left out, so a leaf with no known value keeps min > max and reads as unknown.
 */
export class BusPyramid {
  readonly levels: { min: Float64Array; max: Float64Array }[] = [];
  /** Samples [0, doneUpTo) are in. */
  doneUpTo = 0;

  constructor(readonly length: number) {
    let bins = Math.max(1, Math.ceil(length / BUS_LEAF));
    for (;;) {
      const min = new Float64Array(bins).fill(Number.POSITIVE_INFINITY);
      const max = new Float64Array(bins).fill(Number.NEGATIVE_INFINITY);
      this.levels.push({ min, max });
      if (bins === 1) break;
      bins = Math.ceil(bins / FAN);
    }
  }

  /** Fold steps covering [steps.pos[0], end) into the leaves, then their parents. */
  add(steps: BusSteps, end: number): void {
    if (steps.count === 0) return;
    const leaf = this.levels[0]!;
    const first = Math.floor(steps.pos[0]! / BUS_LEAF);
    let lastLeaf = first;
    for (let i = 0; i < steps.count; i++) {
      const v = steps.val[i]!;
      const p = steps.pos[i]!;
      const q = i + 1 < steps.count ? steps.pos[i + 1]! : end;
      if (q <= p) continue;
      const b1 = Math.floor((q - 1) / BUS_LEAF);
      lastLeaf = Math.max(lastLeaf, b1);
      if (Number.isNaN(v)) continue;
      for (let b = Math.floor(p / BUS_LEAF); b <= b1; b++) {
        if (v < leaf.min[b]!) leaf.min[b] = v;
        if (v > leaf.max[b]!) leaf.max[b] = v;
      }
    }
    let lo = first;
    let hi = lastLeaf;
    for (let l = 1; l < this.levels.length; l++) {
      const child = this.levels[l - 1]!;
      const own = this.levels[l]!;
      lo = Math.floor(lo / FAN);
      hi = Math.floor(hi / FAN);
      for (let j = lo; j <= hi; j++) {
        let mn = Number.POSITIVE_INFINITY;
        let mx = Number.NEGATIVE_INFINITY;
        const c1 = Math.min(child.min.length, (j + 1) * FAN);
        for (let c = j * FAN; c < c1; c++) {
          if (child.min[c]! < mn) mn = child.min[c]!;
          if (child.max[c]! > mx) mx = child.max[c]!;
        }
        own.min[j] = mn;
        own.max[j] = mx;
      }
    }
  }

  /**
   * Min and max over the leaves overlapping [start, end) - exact at leaf granularity, so
   * it may reach up to one leaf beyond either end. Null when nothing there is known.
   */
  range(start: number, end: number): { min: number; max: number } | null {
    let lo = Math.max(0, Math.floor(start / BUS_LEAF));
    let hi = Math.min(this.levels[0]!.min.length, Math.ceil(end / BUS_LEAF));
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    const take = (l: number, b: number) => {
      const lv = this.levels[l]!;
      if (lv.min[b]! < mn) mn = lv.min[b]!;
      if (lv.max[b]! > mx) mx = lv.max[b]!;
    };
    for (let l = 0; lo < hi; l++) {
      if (l + 1 < this.levels.length && hi - lo >= 2 * FAN) {
        while (lo % FAN !== 0) take(l, lo++);
        while (hi % FAN !== 0) take(l, --hi);
        lo /= FAN;
        hi /= FAN;
        continue;
      }
      for (let b = lo; b < hi; b++) take(l, b);
      break;
    }
    return mn <= mx ? { min: mn, max: mx } : null;
  }
}

/**
 * Builds a `BusPyramid` over a whole capture in slices, so a caller can spread the work
 * over animation frames: call `step()` until it returns true.
 */
export class BusBuilder {
  readonly pyramid: BusPyramid;
  private next = 0;
  private carry = Number.NaN;

  /** `piece` is the chunk size; smaller only in tests, to cross many chunk boundaries. */
  constructor(
    private readonly store: SampleStore, private readonly spec: BusSpec,
    readonly length = store.length, private readonly piece = PIECE,
  ) {
    this.pyramid = new BusPyramid(length);
  }

  get done(): boolean {
    return this.next >= this.length;
  }

  /** Fraction of the capture processed, 0..1. */
  get progress(): number {
    return this.length ? this.next / this.length : 1;
  }

  /** Work for about `budgetMs`; true once the whole capture is in. */
  step(budgetMs = 8): boolean {
    const t0 = performance.now();
    while (this.next < this.length) {
      const e = Math.min(this.length, this.next + this.piece);
      const st = busSteps(this.store, this.spec, this.next, e, { carry: this.carry });
      this.pyramid.add(st, e);
      this.carry = st.carry;
      this.next = e;
      this.pyramid.doneUpTo = e;
      if (performance.now() - t0 >= budgetMs) break;
    }
    return this.done;
  }
}
