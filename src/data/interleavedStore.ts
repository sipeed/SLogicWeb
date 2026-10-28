// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * InterleavedSampleStore - native device-order storage.
 *
 * Same contract, same pyramid shape, same block allocator, same query descent. The only
 * difference is the layout of the two big arrays:
 *
 *   - base: device order, one uint16/uint32 per sample. This is the memcpy case - append
 *     is a straight copy with no transpose.
 *   - pyramid: per bin, one word each for "some channel was high" and "some channel was
 *     low". That is 2 bits per channel per bin, exactly what the planar pyramid costs.
 *
 * What it cannot do is answer "is there a 1 anywhere in these 512 samples" with one
 * compare. It has to look at every sample, or every bin, one at a time.
 */

import { assertGapBounds, mergeGap, shiftGapsFront, splitAroundGaps } from './gaps.js';
import { DROP_FRONT_QUANTUM, GAP_BIT } from './types.js';
import type { ColumnView, GapSpan, MemoryReport, SampleStore } from './types.js';
import type { ChannelCount } from '../types.js';

const BASE_BLOCK_LOG = 24; // 2^24 samples per block = 32 MiB of uint16 for 16 channels
const BASE_BLOCK = 1 << BASE_BLOCK_LOG;
const BASE_BLOCK_MASK = BASE_BLOCK - 1;
const LEVEL_LOG = 4;
const MAX_LEVEL = 6;
/**
 * Default only. This has to be tunable for the same reason planar's is: comparing a swept
 * constant against a hardcoded one is not a comparison, it is a handicap. The bench sweeps
 * both stores over the same range and quotes each at its own best.
 */
const DEFAULT_CORE_BINS = 8;

const HAS_ONE = 1;
const HAS_ZERO = 2;
const HAS_BOTH = 3;

function levelBlockLog(level: number): number {
  return Math.max(8, BASE_BLOCK_LOG - LEVEL_LOG * level);
}

type WordArray = Uint16Array | Uint32Array;

function words(bits: 16 | 32, length: number): WordArray {
  return bits === 16 ? new Uint16Array(length) : new Uint32Array(length);
}

class MaskLevel {
  readonly blockLog: number;
  readonly block: number;
  readonly mask: number;
  readonly hi: WordArray[] = [];
  readonly lo: WordArray[] = [];

  constructor(blockLog: number, private readonly wordBits: 16 | 32) {
    this.blockLog = blockLog;
    this.block = 1 << blockLog;
    this.mask = this.block - 1;
  }

  reserve(bins: number): void {
    const need = Math.ceil(bins / this.block);
    while (this.hi.length < need) {
      this.hi.push(words(this.wordBits, this.block));
      this.lo.push(words(this.wordBits, this.block));
    }
  }

  dropFrontBlocks(count: number): void {
    if (count > 0) {
      this.hi.splice(0, count);
      this.lo.splice(0, count);
    }
  }

  byteLength(): number {
    return (this.hi.length + this.lo.length) * this.block * (this.wordBits >>> 3);
  }
}

export class InterleavedSampleStore implements SampleStore {
  readonly channelCount: ChannelCount;
  readonly samplerate: number;
  length = 0;

  /** Samples dropped from the front over the store's life. */
  get droppedSamples(): number {
    return this.droppedTotal;
  }
  /** Query-time only, so the bench can sweep it on an already-built store. */
  coreBins: number = DEFAULT_CORE_BINS;

  private readonly base: WordArray[] = [];
  private readonly wordBits: 16 | 32;
  private readonly bytesPerSample: 2 | 4;
  private readonly levels: MaskLevel[] = [];
  private readonly validBins: number[] = [];
  private readonly binSize: number[] = [];
  private gapList: GapSpan[] = [];

  /**
   * Loop drop cursors, the same scheme as PlanarSampleStore: pyramid bins are
   * addressed in ABSOLUTE sample space, so a drop moves nothing - the base blocks
   * advance a 512-aligned origin, each pyramid level releases only the whole blocks
   * the dropped span fully covers, and no bin is ever rebuilt. `head` is the sample
   * offset of absolute sample `baseOrigin` inside base block 0 (baseOrigin % 2^24).
   */
  private droppedTotal = 0;
  private baseOrigin = 0;
  private baseSkew = 0;
  private head = 0;
  /** Absolute bin each pyramid level's storage starts at (block-aligned). */
  private readonly levelHead: number[] = [];

  private scratchBins = 0;
  private scratchLow = new Uint8Array(0);
  private scratchHigh = new Uint8Array(0);
  private scratchEdge = new Uint8Array(0);
  private scratchPacked = new Uint8Array(0);

  constructor(samplerate: number, channelCount: 16 | 32 = 16) {
    if (!(samplerate > 0)) throw new Error(`samplerate must be positive, got ${samplerate}`);
    if (channelCount !== 16 && channelCount !== 32) {
      throw new Error(`interleaved channelCount must be 16 or 32, got ${channelCount}`);
    }
    this.channelCount = channelCount;
    this.wordBits = channelCount;
    this.bytesPerSample = channelCount >>> 3 as 2 | 4;
    this.samplerate = samplerate;
    this.binSize[0] = 1;
    this.validBins[0] = 0;
    this.levelHead[0] = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      this.levels[k] = new MaskLevel(levelBlockLog(k), this.wordBits);
      this.binSize[k] = Math.pow(2, LEVEL_LOG * k);
      this.validBins[k] = 0;
      this.levelHead[k] = 0;
    }
  }

  /**
   * Base-block position of an ABSOLUTE sample: block 0 starts at absolute sample
   * `baseOrigin - head`, so position p covers absolute sample `baseOrigin - head + p`.
   */
  private basePos(absSample: number): number {
    return absSample - this.baseOrigin + this.head;
  }

  dropFront(samples: number): void {
    if (!Number.isInteger(samples) || samples < 0 || samples % DROP_FRONT_QUANTUM !== 0) {
      throw new Error(`dropFront drops a non-negative multiple of ${DROP_FRONT_QUANTUM}, got ${samples}`);
    }
    if (samples > this.length) throw new Error(`dropFront ${samples} past length ${this.length}`);
    if (samples === 0) return;
    this.droppedTotal += samples;
    this.length -= samples;
    this.validBins[0] = this.length;
    // Base blocks drop only on 512 boundaries, keeping level-1's 16-sample bin reads
    // aligned with the absolute bin grid; the sub-512 slack stays stored (baseSkew).
    const origin = this.droppedTotal - (this.droppedTotal % 512);
    if (origin > this.baseOrigin) {
      const d = origin - this.baseOrigin;
      const h = this.head + d;
      const whole = Math.floor(h / BASE_BLOCK);
      if (whole > 0) this.base.splice(0, whole);
      this.head = h % BASE_BLOCK;
      this.baseOrigin = origin;
    }
    this.baseSkew = this.droppedTotal - this.baseOrigin;
    this.gapList = shiftGapsFront(this.gapList, samples);
    // Pyramid bins are absolute: release only the whole blocks the dropped span
    // fully covers, one splice per level. No content is ever rebuilt.
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const target = Math.floor(this.droppedTotal / this.binSize[k]!);
      const blockBins = this.levels[k]!.block;
      const releasable = target - (target % blockBins);
      if (releasable > this.levelHead[k]!) {
        this.levels[k]!.dropFrontBlocks((releasable - this.levelHead[k]!) / blockBins);
        this.levelHead[k] = releasable;
      }
    }
  }

  append(chunk: Uint8Array): void {
    const bps = this.bytesPerSample;
    if (chunk.byteLength % bps !== 0) throw new Error(`chunk of ${chunk.byteLength} bytes is not whole samples`);
    const n = chunk.byteLength / bps;
    if (n === 0) return;
    const from = this.length;
    const to = from + n;
    if (to > 0x7fffffff) throw new Error(`capture would exceed the 2^31 sample ceiling (${to})`);

    const room = to + this.baseSkew + this.head;
    while (this.base.length * BASE_BLOCK < room) this.base.push(words(this.wordBits, BASE_BLOCK));

    const src = (chunk.byteOffset & (bps - 1)) === 0
      ? wordsView(chunk, this.wordBits, n)
      : (() => { const t = words(this.wordBits, n); new Uint8Array(t.buffer).set(chunk); return t; })();

    let si = 0;
    let dst = from + this.baseSkew + this.head;
    while (si < n) {
      const blk = dst >>> BASE_BLOCK_LOG;
      const off = dst & BASE_BLOCK_MASK;
      const take = Math.min(n - si, BASE_BLOCK - off);
      this.base[blk]!.set(src.subarray(si, si + take), off);
      si += take;
      dst += take;
    }

    this.length = to;
    this.validBins[0] = to;
    this.updatePyramid(to);
  }

  private updatePyramid(to: number): void {
    const absEnd = this.droppedTotal + to;
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const B = this.binSize[k]!;
      const b0 = this.validBins[k]!;
      const b1 = Math.floor(absEnd / B);
      if (b1 <= b0) break;
      const lv = this.levels[k]!;
      const dh = this.levelHead[k]!;
      lv.reserve(b1 - dh);
      if (k === 1) {
        for (let i = b0; i < b1; i++) {
          const s0 = this.basePos(i * 16);
          const blk = s0 >>> BASE_BLOCK_LOG;
          const arr = this.base[blk]!;
          const off = s0 & BASE_BLOCK_MASK;
          let h = 0, l = 0;
          for (let j = 0; j < 16; j++) { const v = arr[off + j]!; h |= v; l |= ~v; }
          const di = i - dh;
          lv.hi[di >>> lv.blockLog]![di & lv.mask] = h;
          lv.lo[di >>> lv.blockLog]![di & lv.mask] = l;
        }
      } else {
        const src = this.levels[k - 1]!;
        const sh0 = this.levelHead[k - 1]!;
        for (let i = b0; i < b1; i++) {
          const s0 = i * 16 - sh0;
          const sBlk = s0 >>> src.blockLog;
          const sh = src.hi[sBlk]!, sl = src.lo[sBlk]!;
          const off = s0 & src.mask;
          let h = 0, l = 0;
          for (let j = 0; j < 16; j++) { h |= sh[off + j]!; l |= sl[off + j]!; }
          const di = i - dh;
          lv.hi[di >>> lv.blockLog]![di & lv.mask] = h;
          lv.lo[di >>> lv.blockLog]![di & lv.mask] = l;
        }
      }
      this.validBins[k] = b1;
    }
  }

  private sampleBit(ch: number, i: number): number {
    const p = i + this.baseSkew + this.head;
    return (this.base[p >>> BASE_BLOCK_LOG]![p & BASE_BLOCK_MASK]! >>> ch) & 1;
  }

  /** HAS_ONE | HAS_ZERO over ABSOLUTE samples [s0, s1). */
  private baseState(ch: number, s0: number, s1: number): number {
    let st = 0;
    let p = this.basePos(s0);
    const pEnd = this.basePos(s1);
    while (p < pEnd) {
      const blk = p >>> BASE_BLOCK_LOG;
      const arr = this.base[blk]!;
      const stop = Math.min(pEnd, (blk + 1) * BASE_BLOCK);
      for (let j = p & BASE_BLOCK_MASK; p < stop; p++, j++) {
        st |= ((arr[j]! >>> ch) & 1) !== 0 ? HAS_ONE : HAS_ZERO;
        if (st === HAS_BOTH) return HAS_BOTH;
      }
    }
    return st;
  }

  /** Bins [a, b) of a level, ABSOLUTE bin indices. */
  private levelState(level: number, ch: number, a: number, b: number): number {
    const lv = this.levels[level]!;
    const lh = this.levelHead[level]!;
    let st = 0;
    for (let i = a; i < b; i++) {
      const local = i - lh;
      const blk = local >>> lv.blockLog;
      const off = local & lv.mask;
      if ((lv.hi[blk]![off]! >>> ch) & 1) st |= HAS_ONE;
      if ((lv.lo[blk]![off]! >>> ch) & 1) st |= HAS_ZERO;
      if (st === HAS_BOTH) return HAS_BOTH;
    }
    return st;
  }

  private rangeState(ch: number, s0: number, s1: number, level: number): number {
    while (level > 0) {
      const B = this.binSize[level]!;
      const a = Math.ceil(s0 / B);
      let b = Math.floor(s1 / B);
      const vb = this.validBins[level]!;
      if (b > vb) b = vb;
      if (a >= b) { level--; continue; }
      const coreStart = a * B;
      const coreEnd = b * B;
      let st = this.levelState(level, ch, a, b);
      if (st !== HAS_BOTH && s0 < coreStart) st |= this.rangeState(ch, s0, coreStart, level - 1);
      if (st !== HAS_BOTH && coreEnd < s1) st |= this.rangeState(ch, coreEnd, s1, level - 1);
      return st;
    }
    return this.baseState(ch, s0, s1);
  }

  private pickLevel(samplesPerBin: number): number {
    const want = this.coreBins;
    let k = 0;
    while (k < MAX_LEVEL && this.binSize[k + 1]! * want <= samplesPerBin) k++;
    return k;
  }

  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) throw new Error(`channel ${channel} out of range`);
    if (!(bins > 0) || (bins | 0) !== bins) throw new Error(`bins must be a positive integer, got ${bins}`);
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`query range must be finite, got [${startSample}, ${endSample})`);
    }
    if (this.length === 0) throw new Error('query on an empty store');
    const s = Math.max(0, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) throw new Error(`empty range [${startSample}, ${endSample})`);

    const width = e - s;
    const level = this.pickLevel(width / bins);

    if (bins !== this.scratchBins) {
      this.scratchBins = bins;
      this.scratchLow = new Uint8Array(bins);
      this.scratchHigh = new Uint8Array(bins);
      this.scratchEdge = new Uint8Array(bins);
      this.scratchPacked = new Uint8Array(bins);
    }
    const low = this.scratchLow, high = this.scratchHigh;
    const edge = this.scratchEdge, packed = this.scratchPacked;

    const D = this.droppedTotal;
    const gaps = this.gapList;
    let gp = 0;
    for (let i = 0; i < bins; i++) {
      const c0 = s + Math.floor((i * width) / bins);
      let c1 = s + Math.floor(((i + 1) * width) / bins);
      if (c1 <= c0) c1 = c0 + 1;
      if (c1 > e) c1 = e;
      let st = this.rangeState(channel, c0 + D, c1 + D, level);
      const hv = (st & HAS_ONE) !== 0 ? 1 : 0;
      const lv = (st & HAS_ZERO) !== 0 ? 0 : 1;
      if (c0 > 0) st |= this.sampleBit(channel, c0 - 1) !== 0 ? HAS_ONE : HAS_ZERO;
      const ev = st === HAS_BOTH ? 1 : 0;
      high[i] = hv; low[i] = lv; edge[i] = ev;
      while (gp < gaps.length && gaps[gp]!.endSample <= c0) gp++;
      const gapHit = gp < gaps.length && gaps[gp]!.startSample < c1;
      packed[i] = hv | (lv << 1) | (ev << 2) | (gapHit ? GAP_BIT : 0);
    }
    return { channel, startSample: s, endSample: e, bins, low, high, edge, packed };
  }

  edges(channel: number, startSample: number, endSample: number): Int32Array {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return new Int32Array(0);
    let n = 0;
    for (const [a, b] of segs) n += this.scanEdgesRange(channel, a, b, null, 0);
    if (n === 0) return new Int32Array(0);
    const out = new Int32Array(n);
    let w = 0;
    for (const [a, b] of segs) w += this.scanEdgesRange(channel, a, b, out, w);
    if (w !== n) throw new Error(`edge count changed between passes: ${n} then ${w}`);
    return out;
  }

  edgeCount(channel: number, startSample: number, endSample: number): number {
    const segs = this.edgeSegments(channel, startSample, endSample);
    if (segs === null) return 0;
    let n = 0;
    for (const [a, b] of segs) n += this.scanEdgesRange(channel, a, b, null, 0);
    return n;
  }

  private edgeSegments(
    channel: number, startSample: number, endSample: number,
  ): Array<[number, number]> | null {
    if (channel < 0 || channel >= this.channelCount || (channel | 0) !== channel) {
      throw new Error(`channel ${channel} out of range 0..${this.channelCount - 1}`);
    }
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`edges range must be finite, got [${startSample}, ${endSample})`);
    }
    const s = Math.max(1, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) return null;
    return splitAroundGaps(this.gapList, s, e);
  }

  private scanEdgesRange(
    channel: number, s: number, e: number, out: Int32Array | null, outOff: number,
  ): number {
    const skew = this.baseSkew + this.head;
    let n = outOff;
    let prev = this.sampleBit(channel, s - 1);
    let i = s;
    let p = i + skew;
    const pEnd = e + skew;
    while (p < pEnd) {
      const blk = p >>> BASE_BLOCK_LOG;
      const arr = this.base[blk]!;
      const stop = Math.min(pEnd, (blk + 1) * BASE_BLOCK);
      let j = p & BASE_BLOCK_MASK;
      for (; p < stop; p++, i++, j++) {
        const v = (arr[j]! >>> channel) & 1;
        if (v !== prev) {
          if (out !== null) out[n] = i;
          n++;
          prev = v;
        }
      }
    }
    return n - outOff;
  }

  noteGap(startSample: number, endSample: number): void {
    assertGapBounds(startSample, endSample, this.length);
    this.gapList = mergeGap(this.gapList, startSample, endSample);
  }

  gaps(): GapSpan[] {
    return this.gapList.map((g) => ({ ...g }));
  }

  memory(): MemoryReport {
    const baseBytes = this.base.length * BASE_BLOCK * this.bytesPerSample;
    let pyramidBytes = 0;
    for (let k = 1; k <= MAX_LEVEL; k++) pyramidBytes += this.levels[k]!.byteLength();
    return {
      baseBytes,
      pyramidBytes,
      totalBytes: baseBytes + pyramidBytes,
      overhead: baseBytes === 0 ? 0 : pyramidBytes / baseBytes,
      slackBytes: baseBytes - this.length * 2,
    };
  }

  sampleAt(channel: number, index: number): number {
    if (index < 0 || index >= this.length) throw new Error(`sample ${index} out of range`);
    return this.sampleBit(channel, index);
  }
}

function wordsView(chunk: Uint8Array, bits: 16 | 32, length: number): WordArray {
  return bits === 16
    ? new Uint16Array(chunk.buffer, chunk.byteOffset, length)
    : new Uint32Array(chunk.buffer, chunk.byteOffset, length);
}
