// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Repeat session's two-layer display.
 *
 * A Repeat session runs one device sweep per Interval. The new sweep is captured into a
 * new store while the previous, complete sweep must stay on screen - a Fixed viewport
 * that the new sweep has not reached yet would otherwise show a vacuum. The layer is a
 * SampleStore that serves the current sweep up to its frontier and the previous sweep
 * beyond it. Both waves are read in the *new* store's coordinate space:
 *
 *   composite index c  -> new sample c                     (c < back.length)
 *                      -> old sample c - delta             (otherwise, if in the old store)
 *
 * with `delta = backOrigin - frontOrigin`. The origins are the waves' display origins
 * (the trigger sample T when the wave has one, otherwise the sweep start), so the old
 * trace is placed at the same relative time in the new sweep. This is the geometric form
 * of the rule "T is 0 s and pre-trigger data has negative time": both waves' T land on
 * the same relative second, and the old wave simply continues to supply the times the
 * new wave has not captured yet.
 *
 * The store never copies or merges the captures. `query` splits a mixed range into its
 * new and old parts, asks each underlying store for its own bins, and merges them into
 * this store's borrowed scratch arrays - the same ownership contract as every other
 * SampleStore. Edges, gaps and sampleAt are mapped the same way.
 *
 * A layer's bins are laid out over that layer's own sub-range, so a source bin can cross
 * a composite column boundary; its levels and edge then contribute to both columns. That
 * one-column over-approximation is deliberate and conservative (a source bin is at most
 * one composite column wide, so the smear is bounded by roughly one column worth of
 * context, usually sub-pixel). The gap bit is *not* smeared: it is re-derived from the
 * display's actual gap spans, so a column is NO_DATA only when it really overlaps an
 * unknown sample and `query` agrees with `gaps()`.
 *
 * `repeatSurfacePixels` answers the visual question: which x spans of the viewport are
 * old and which are current, for the two background tints that distinguish them. There
 * is deliberately no vertical rule; the tint boundary is the signal.
 *
 * Unsupported (documented, not guessed):
 *   - both stores must have the same channel count and samplerate (the Repeat session
 *     only reuses a front wave when its capture shape matches);
 *   - a composite has no meaning before the current wave has a display origin, so the
 *     App only installs one once the wave has triggered or is running trigger-free.
 */

import { GAP_BIT, type ColumnView, type GapSpan, type SampleStore } from '../data/types.js';
import { repeatRegions, spanToPixels, type RelativeSpan, type RepeatRegions } from './displaySwap.js';

export interface RepeatLayerStore {
  readonly store: SampleStore;
  /** Display origin in this store's coordinates: trigger T, else the sweep start. */
  readonly origin: number;
  /** The wave has a trigger sample, so T is meaningful to draw. */
  readonly hasTrigger: boolean;
  /** The wave was an analog Auto sweep forced without a trigger (never with T). */
  readonly forced?: boolean;
}

/** A display-relative seconds interval, used for the tint calculation. */
export interface RepeatSurfacePixels {
  /** The region geometry, in display-relative seconds. */
  regions: RepeatRegions;
  /** Old-wave x spans (CSS px, unclipped), one per visible old region. */
  old: { x0: number; x1: number }[];
  /** Current-wave x span (CSS px, unclipped), or null before it reaches the viewport. */
  current: { x0: number; x1: number } | null;
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * SampleStore over a current (back) and previous (front) wave. See the module comment
 * for the coordinate mapping. `back` grows while the capture runs; `front` is fixed.
 */
export class RepeatCompositeStore implements SampleStore {
  private backStore: SampleStore;
  private frontStore: SampleStore | null;
  private backOriginValue: number;
  private frontOriginValue: number;
  private scratchBins = -1;
  private scratchLow = new Uint8Array(0);
  private scratchHigh = new Uint8Array(0);
  private scratchEdge = new Uint8Array(0);
  private scratchPacked = new Uint8Array(0);
  private scratchCovered = new Uint8Array(0);
  private scratchGap = new Uint8Array(0);

  /** Allocate the query scratch for `bins`; returns true when it was reallocated. */
  private ensureScratch(bins: number): boolean {
    if (bins === this.scratchBins) return false;
    this.scratchBins = bins;
    this.scratchLow = new Uint8Array(bins);
    this.scratchHigh = new Uint8Array(bins);
    this.scratchEdge = new Uint8Array(bins);
    this.scratchPacked = new Uint8Array(bins);
    this.scratchCovered = new Uint8Array(bins);
    this.scratchGap = new Uint8Array(bins);
    return true;
  }

  constructor(back: SampleStore, backOrigin: number, front: RepeatLayerStore | null) {
    if (front && (front.store.channelCount !== back.channelCount ||
        front.store.samplerate !== back.samplerate)) {
      throw new Error('Repeat layers must share channel count and samplerate');
    }
    if (front && front.store === back) {
      throw new Error('Repeat layers must be two distinct stores');
    }
    if (!Number.isInteger(backOrigin)) {
      throw new Error(`Repeat back origin must be a whole sample, got ${backOrigin}`);
    }
    if (front && !Number.isInteger(front.origin)) {
      throw new Error(`Repeat front origin must be a whole sample, got ${front.origin}`);
    }
    this.backStore = back;
    this.frontStore = front?.store ?? null;
    this.backOriginValue = backOrigin;
    this.frontOriginValue = front?.origin ?? 0;
  }

  get back(): SampleStore {
    return this.backStore;
  }

  get front(): SampleStore | null {
    return this.frontStore;
  }

  get channelCount(): number {
    return this.backStore.channelCount;
  }

  get samplerate(): number {
    return this.backStore.samplerate;
  }

  /**
   * The display extent: at least the current wave's data, extended by the previous
   * wave's data where it reaches further. A Fixed viewport that the current wave has
   * not filled yet is covered by the old layer rather than clamped away.
   */
  get length(): number {
    const frontier = this.backStore.length;
    const oldEnd = this.frontStore ? this.oldEnd : 0;
    return Math.max(0, frontier, oldEnd);
  }

  get droppedSamples(): number {
    return this.backStore.droppedSamples;
  }

  get frontier(): number {
    return this.backStore.length;
  }

  get backOrigin(): number {
    return this.backOriginValue;
  }

  get frontOrigin(): number {
    return this.frontOriginValue;
  }

  /** `delta = backOrigin - frontOrigin`; composite index + delta = old-store index. */
  get delta(): number {
    return this.backOriginValue - this.frontOriginValue;
  }

  /** End of the old layer in composite coordinates (exclusive). */
  get oldEnd(): number {
    return this.frontStore ? this.delta + this.frontStore.length : 0;
  }

  /** Visible old coverage: `[max(0, delta), oldEnd)`, clipped to the composite length. */
  get oldCoverage(): { start: number; end: number } | null {
    if (!this.frontStore) return null;
    const start = Math.max(0, this.delta);
    const end = Math.min(this.length, this.oldEnd);
    return end > start ? { start, end } : null;
  }

  /** The trigger change of a Repeat wave moves the origin; the old mapping follows it. */
  setBackOrigin(origin: number): void {
    if (!Number.isInteger(origin)) {
      throw new Error(`Repeat back origin must be a whole sample, got ${origin}`);
    }
    this.backOriginValue = origin;
  }

  append(chunk: Uint8Array): void {
    this.backStore.append(chunk);
  }

  dropFront(samples: number): void {
    this.backStore.dropFront(samples);
  }

  noteGap(startSample: number, endSample: number): void {
    this.backStore.noteGap(startSample, endSample);
  }

  gaps(): GapSpan[] {
    const frontier = this.backStore.length;
    const out: GapSpan[] = this.backStore.gaps().map((g) => ({ ...g }));
    const front = this.frontStore;
    if (front) {
      const delta = this.delta;
      const limit = this.length;
      // The synthetic gap between the current frontier and a later old layer is real
      // display state (query marks it NO_DATA), so report it here too.
      const oldDisplayStart = Math.max(frontier, Math.max(0, delta));
      if (oldDisplayStart > frontier) {
        out.push({ startSample: frontier, endSample: Math.min(limit, oldDisplayStart) });
      }
      for (const gap of front.gaps()) {
        const start = Math.max(frontier, gap.startSample + delta, 0);
        const end = Math.min(limit, gap.endSample + delta);
        if (end > start) out.push({ startSample: start, endSample: end });
      }
    }
    out.sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample);
    return out;
  }

  sampleAt(channel: number, index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`sample ${index} is outside the Repeat display [0, ${this.length})`);
    }
    if (index < this.backStore.length) return this.backStore.sampleAt(channel, index);
    const front = this.frontStore;
    const oldIndex = index - this.delta;
    if (front && oldIndex >= 0 && oldIndex < front.length) return front.sampleAt(channel, oldIndex);
    return 0;
  }

  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView {
    if (!(bins > 0) || (bins | 0) !== bins) {
      throw new Error(`bins must be a positive integer, got ${bins}`);
    }
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`query range must be finite, got [${startSample}, ${endSample})`);
    }
    const length = this.length;
    const s = Math.max(0, Math.floor(startSample));
    const e = Math.min(length, Math.ceil(endSample));
    if (s >= e) throw new Error(`empty range [${startSample}, ${endSample})`);
    this.ensureScratch(bins);

    const frontier = this.backStore.length;
    const back = this.backStore;
    const front = this.frontStore;
    const oldStart = Math.max(0, this.delta);
    const oldEnd = front ? Math.min(length, this.oldEnd) : 0;
    // New data wins where the layers overlap, so the old layer is displayed only from
    // the frontier (or its own start, when that is later).
    const oldDisplayStart = Math.max(frontier, oldStart);
    const hasNew = s < frontier;
    const hasOld = front !== null && Math.max(s, oldDisplayStart) < Math.min(e, oldEnd);

    if (hasNew && !hasOld && e <= frontier) {
      const view = back.query(channel, s, e, bins);
      return this.adoptView(view, s, e, bins, 0);
    }
    if (!hasNew && hasOld && s > oldDisplayStart && e <= oldEnd) {
      const view = front.query(channel, s - this.delta, e - this.delta, bins);
      return this.adoptView(view, s, e, bins, this.delta);
    }
    if (!hasNew && !hasOld) {
      return this.blankView(channel, s, e, bins);
    }

    // Mixed or gapped range. Each layer is queried over its covered part, then every
    // source bin is merged into every composite column it overlaps. A column can hold
    // new data, old data, a gap, or parts of several; taking one source bin per column
    // (which is finer than the column) would drop pulses and misplace transitions.
    const low = this.scratchLow, high = this.scratchHigh;
    const edge = this.scratchEdge, packed = this.scratchPacked;
    const covered = this.scratchCovered, gapBits = this.scratchGap;
    low.fill(1); high.fill(0); edge.fill(0); packed.fill(0);
    covered.fill(0); gapBits.fill(0);
    const width = e - s;
    const colStart = (i: number): number => s + Math.floor((i * width) / bins);
    const colEnd = (i: number): number => {
      const c0 = colStart(i);
      const raw = i + 1 < bins ? s + Math.floor(((i + 1) * width) / bins) : e;
      return Math.min(e, raw > c0 ? raw : c0 + 1);
    };
    const mergeView = (
      view: ColumnView, sourceDelta: number, seamSource: number | null,
    ): void => {
      const vw = view.endSample - view.startSample;
      if (!(vw > 0) || view.bins <= 0) return;
      let ci = 0;
      for (let j = 0; j < view.bins; j++) {
        const bs = view.startSample + Math.floor((j * vw) / view.bins);
        let be = view.startSample + Math.floor(((j + 1) * vw) / view.bins);
        if (be <= bs) be = bs + 1;
        if (be > view.endSample) be = view.endSample;
        const cs = bs + sourceDelta;
        const ce = be + sourceDelta;
        if (cs >= e || ce <= s) continue;
        while (ci + 1 < bins && colEnd(ci) <= cs) ci++;
        // The old store's first displayed sample (and any inner bin that starts there)
        // measured its edge against a sample hidden by the new layer. Suppress those
        // edges; the explicit seam below and the column's low/high aggregate carry the
        // visible transition.
        const spuriousEdge = seamSource !== null && bs === seamSource;
        for (let i = ci; i < bins; i++) {
          const c0 = colStart(i), c1 = colEnd(i);
          if (c1 <= cs) continue;
          if (c0 >= ce) break;
          if (view.low[j]! < low[i]!) low[i] = view.low[j]!;
          if (view.high[j]! > high[i]!) high[i] = view.high[j]!;
          if (!spuriousEdge && view.edge[j]) edge[i] = 1;
          if ((view.packed[j]! & GAP_BIT) !== 0) gapBits[i] = 1;
          covered[i] = 1;
        }
      }
    };

    if (hasNew) {
      mergeView(back.query(channel, s, Math.min(e, frontier), bins), 0, null);
    }
    const oldRangeStart = Math.max(s, oldDisplayStart);
    const oldRangeEnd = Math.min(e, oldEnd);
    if (hasOld && oldRangeStart < oldRangeEnd) {
      mergeView(
        front!.query(channel, oldRangeStart - this.delta, oldRangeEnd - this.delta, bins),
        this.delta,
        oldRangeStart === oldDisplayStart ? oldRangeStart - this.delta : null,
      );
    }

    // The seam between new and old data is not an edge in the old store (its hidden
    // predecessor differs) and may fall inside a composite column that also holds new
    // samples. Add it explicitly; never clear an internal edge that the merge found.
    if (front && oldDisplayStart < oldEnd && oldDisplayStart === frontier && frontier > 0 &&
        oldDisplayStart >= s && oldDisplayStart < e) {
      const differs = back.sampleAt(channel, frontier - 1) !==
        front.sampleAt(channel, oldDisplayStart - this.delta);
      if (differs) {
        let i = 0;
        while (i + 1 < bins && colEnd(i) <= oldDisplayStart) i++;
        edge[i] = 1;
        covered[i] = 1;
      }
    }

    // The per-source-bin gap bit is conservative at a column boundary: the straddling
    // source bin flags both columns even when the unknown span lies wholly in one. The
    // display's own gap spans are exact, so a gap anywhere in the queried layers
    // triggers a re-derivation over them. A column is NO_DATA only when it really
    // overlaps a span with no data (query and gaps() then always agree).
    let anyGapBit = false;
    for (let i = 0; i < bins; i++) if (gapBits[i]) { anyGapBit = true; break; }
    const syntheticStart = frontier;
    const syntheticEnd = oldDisplayStart;
    if (anyGapBit || syntheticEnd > syntheticStart) {
      gapBits.fill(0);
      const spans = this.gaps();
      let gi = 0;
      for (let i = 0; i < bins; i++) {
        const c0 = colStart(i), c1 = colEnd(i);
        while (gi < spans.length && spans[gi]!.endSample <= c0) gi++;
        if (gi < spans.length && spans[gi]!.startSample < c1) gapBits[i] = 1;
      }
    }

    // Anything no layer covers is NO_DATA. A column that only partly overlaps a gap
    // between the frontier and a later old layer is marked as a gap too (the contract's
    // bit means "overlaps a span with no data", not "is entirely empty").
    for (let i = 0; i < bins; i++) {
      if (!covered[i]) {
        low[i] = 0; high[i] = 0; edge[i] = 0; packed[i] = GAP_BIT;
        continue;
      }
      if (low[i] !== high[i]) edge[i] = 1;
      packed[i] = high[i]! | (low[i]! << 1) | (edge[i]! << 2) | (gapBits[i] ? GAP_BIT : 0);
    }
    return { channel, startSample: s, endSample: e, bins, low, high, edge, packed };
  }

  /** Columns with no layer behind them: the renderer's NO_DATA, not a held level. */
  private blankView(channel: number, s: number, e: number, bins: number): ColumnView {
    this.ensureScratch(bins);
    this.scratchLow.fill(0);
    this.scratchHigh.fill(0);
    this.scratchEdge.fill(0);
    this.scratchPacked.fill(GAP_BIT);
    return {
      channel, startSample: s, endSample: e, bins,
      low: this.scratchLow, high: this.scratchHigh,
      edge: this.scratchEdge, packed: this.scratchPacked,
    };
  }

  edges(channel: number, startSample: number, endSample: number): Int32Array {
    if (!Number.isFinite(startSample) || !Number.isFinite(endSample)) {
      throw new Error(`edges range must be finite, got [${startSample}, ${endSample})`);
    }
    const s = Math.max(0, Math.floor(startSample));
    const e = Math.min(this.length, Math.ceil(endSample));
    if (s >= e) return new Int32Array(0);
    const frontier = this.backStore.length;
    const parts: number[] = [];
    if (s < frontier) {
      for (const at of this.backStore.edges(channel, s, Math.min(e, frontier))) parts.push(at);
    }
    const front = this.frontStore;
    const oldStart = Math.max(0, this.delta);
    const oldEnd = front ? Math.min(this.length, this.oldEnd) : 0;
    const oldDisplayStart = Math.max(frontier, oldStart);
    const oldFrom = Math.max(s, oldDisplayStart);
    const oldTo = Math.min(e, oldEnd);
    if (front && oldFrom < oldTo) {
      const delta = this.delta;
      const sourceStart = oldFrom - delta;
      for (const at of front.edges(channel, sourceStart, oldTo - delta)) {
        // The old store's first edge was measured against a hidden predecessor; the
        // composite seam below replaces it.
        if (oldFrom === oldDisplayStart && at === sourceStart) continue;
        parts.push(at + delta);
      }
      if (oldFrom === oldDisplayStart) {
        const corrected = oldDisplayStart === frontier && frontier > 0
          ? (this.backStore.sampleAt(channel, frontier - 1) !== front.sampleAt(channel, sourceStart) ? 1 : 0)
          : 0;
        if (corrected) parts.push(oldDisplayStart);
      }
    }
    parts.sort((a, b) => a - b);
    return Int32Array.from(parts);
  }

  edgeCount(channel: number, startSample: number, endSample: number): number {
    // The seam correction differs from the inner stores' own edge accounting, so derive
    // the count from the same list edges() returns rather than risk a divergent count.
    return this.edges(channel, startSample, endSample).length;
  }

  /** The index of the source column that contains composite sample `c0`. */
  private columnAt(view: ColumnView, c0: number): number {
    const width = view.endSample - view.startSample;
    if (!(width > 0)) return 0;
    const index = Math.floor(((c0 - view.startSample) * view.bins) / width);
    return clampInt(index, 0, view.bins - 1);
  }

  /**
   * A single-layer query: copy the source's borrowed columns into this store's scratch.
   * `sourceDelta` is the offset between composite indices and that layer's store
   * indices (0 for the current wave, `delta` for the old one). The copy is not optional:
   * returning the inner store's borrowed arrays would be overwritten when this store is
   * queried for the next channel inside the same frame.
   */
  private adoptView(
    view: ColumnView, s: number, e: number, bins: number, sourceDelta: number,
  ): ColumnView {
    const low = this.scratchLow, high = this.scratchHigh;
    const edge = this.scratchEdge, packed = this.scratchPacked;
    const exact = view.bins === bins &&
      view.startSample === s - sourceDelta && view.endSample === e - sourceDelta;
    if (exact) {
      low.set(view.low); high.set(view.high);
      edge.set(view.edge); packed.set(view.packed);
    } else {
      const width = e - s;
      for (let i = 0; i < bins; i++) {
        const c0 = s + Math.floor((i * width) / bins);
        const j = this.columnAt(view, c0 - sourceDelta);
        low[i] = view.low[j]!;
        high[i] = view.high[j]!;
        edge[i] = view.edge[j]!;
        packed[i] = view.packed[j]!;
      }
    }
    return { channel: view.channel, startSample: s, endSample: e, bins, low, high, edge, packed };
  }
}

/** A Repeat wave can wait for a trigger or run trigger-free; both hold the old frame. */
export type RepeatTriggerState = 'off' | 'waiting' | 'triggered' | 'forced' | 'not-found';

/**
 * Whether the previous wave should hand the plot to the current one.
 *
 * The hold ends when the current wave has data and is not still waiting for its trigger:
 * trigger-free waves hand over at their first samples, triggered waves at the block that
 * follows the match. An empty current wave never ends the hold, and a not-found wave is
 * settled by the session end path instead (B1 keeps the previous wave visible).
 */
export function repeatHoldReleased(input: {
  showingFront: boolean;
  backLength: number;
  softwareTrigger: boolean;
  triggerState: RepeatTriggerState;
  /** The current wave's T, when known: the hand-over waits until that sample exists. */
  triggerSampleIndex?: number | null;
}): boolean {
  if (!input.showingFront) return false;
  if (!(input.backLength > 0)) return false;
  if (input.softwareTrigger && input.triggerState === 'waiting') return false;
  // With coalescing the prefix can arrive before the block that carries T. Releasing
  // then would show the new wave with an axis origin the store cannot yet back.
  if (input.softwareTrigger && input.triggerState === 'triggered' &&
      input.triggerSampleIndex !== null && input.triggerSampleIndex !== undefined &&
      input.backLength <= input.triggerSampleIndex) return false;
  return true;
}

/**
 * Move a marker from the previous wave's coordinates into the current wave's before a
 * Repeat hand-over. Both layers are placed at the same relative time, so the offset is
 * `newOrigin - oldOrigin`. Null means the marker cannot be represented in the new
 * display (outside it, or an empty capture) and should be cleared.
 */
export function remapRepeatSample(
  sample: number | null, delta: number, length: number,
): number | null {
  if (sample === null || !Number.isFinite(sample) || !Number.isFinite(delta) ||
      !Number.isFinite(length) || !(length > 0)) return null;
  const moved = Math.round(sample + delta);
  if (!Number.isFinite(moved) || moved < 0 || moved >= length) return null;
  return moved;
}

/**
 * Old/current x spans for the Repeat background tint. `viewport` is the visible interval
 * in display-relative seconds and must be the same interval the renderer was given.
 * Returns null when the composite is not the displayed store or the geometry is empty.
 */
export function repeatSurfacePixels(
  composite: RepeatCompositeStore,
  viewport: RelativeSpan,
  widthPx: number,
): RepeatSurfacePixels | null {
  const rate = composite.samplerate;
  const front = composite.oldCoverage;
  if (!(rate > 0) || !(widthPx > 0) || !(viewport.endSec > viewport.startSec)) return null;
  const relative = (index: number): number => (index - composite.backOrigin) / rate;
  const regions = repeatRegions({
    viewport,
    newWave: { startSec: relative(0), endSec: relative(composite.frontier) },
    // Without an old layer, the old coverage is explicitly absent: gaps are reported
    // rather than filled. `oldCoverage` is already clipped to the display extent.
    oldWave: front
      ? { startSec: relative(front.start), endSec: relative(front.end), triggerSec: null }
      : null,
  });
  const old: { x0: number; x1: number }[] = [];
  for (const span of regions.oldRegions) {
    const box = spanToPixels(span, viewport, widthPx);
    if (box && box.visible) old.push({ x0: box.clippedX0, x1: box.clippedX1 });
  }
  const current = regions.new ? spanToPixels(regions.new, viewport, widthPx) : null;
  return {
    regions,
    old,
    current: current && current.visible ? { x0: current.clippedX0, x1: current.clippedX1 } : null,
  };
}
