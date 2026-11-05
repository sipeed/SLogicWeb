// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * M0 digital SignalStore.
 *
 * One digital group backed by the existing SampleStore layouts, adapted
 * to the v2 contract in ./signalTypes.ts:
 *
 *   - positions are absolute float64 sample indices starting at 0 for the first append;
 *     the underlying store's relative index is `position - droppedSamples`;
 *   - queries add per-bin status (pending beyond `newest`, gap over a noteGap span);
 *   - gaps and their reasons live here, not in the SampleStore, so signal-specific spans
 *     are possible and `edges()` can filter them per signal;
 *   - `dropBefore()` moves the retention window without changing absolute positions.
 *
 * M0 intentionally refuses a second group. Multi-rate is representable in the types
 * (SignalGroup.rateHz, per-group `newest`), but a second group needs time alignment and
 * per-group storage, which is M1 work. Refusing loudly is safer than silently mapping a
 * second group's channels into the first group's position space.
 *
 * The digital chunk format is the existing device format: little-endian interleaved
 * samples, `bytesPerSampleForChannels(channels)` bytes each, exactly what SampleStore
 * consumes. `start` is the sample position of the chunk's first sample.
 */

import { InterleavedSampleStore } from './interleavedStore.js';
import { PlanarSampleStore } from './planarStore.js';
import { DROP_FRONT_QUANTUM, GAP_BIT } from './types.js';
import type { SampleStore } from './types.js';
import {
  COLUMN_GAP,
  COLUMN_OK,
  COLUMN_PENDING,
  type GapReason,
  type GapSpan,
  type RecordController,
  type SamplePos,
  type SignalColumns,
  type SignalGroup,
  type SignalId,
  type SignalInfo,
  type SignalStore,
} from './signalTypes.js';
import { bytesPerSampleForChannels, isChannelCount, type ChannelCount } from '../types.js';

function createDigitalStore(channels: ChannelCount, rateHz: number): SampleStore {
  if (channels === 8 || channels === 16 || channels === 32) {
    return new InterleavedSampleStore(rateHz, channels);
  }
  return new PlanarSampleStore({ channelCount: channels, samplerate: rateHz });
}

// The contract lives in signalTypes.ts; re-export it here so callers can take everything
// they need from the implementation module.
export type {
  AnalogSignalColumns,
  ColumnStatus,
  DigitalSignalColumns,
  GapReason,
  GapSpan,
  RecordController,
  RecordState,
  SamplePos,
  SignalColumns,
  SignalGroup,
  SignalId,
  SignalInfo,
  SignalKind,
  SignalStore,
} from './signalTypes.js';
export { COLUMN_GAP, COLUMN_OK, COLUMN_PENDING } from './signalTypes.js';

const GAP_REASONS: readonly GapReason[] = [
  'dropout', 'overrun', 'suspend', 'record-gap', 'import-gap', 'store-full',
];

/** Error codes are stable so callers and tests can branch without parsing messages. */
export type SignalStoreErrorCode =
  | 'unknown-group'
  | 'unknown-signal'
  | 'invalid-group'
  | 'invalid-position'
  | 'invalid-chunk'
  | 'overlap'
  | 'non-contiguous'
  | 'gap-invalid'
  | 'gap-out-of-range'
  | 'group-limit'
  | 'record-unsupported';

export class SignalStoreError extends Error {
  readonly code: SignalStoreErrorCode;

  constructor(code: SignalStoreErrorCode, message: string) {
    super(message);
    this.name = 'SignalStoreError';
    this.code = code;
  }
}

/**
 * M0 supports exactly one group. A second group is a typed refusal, never a silent
 * merge into one position space.
 */
export class UnsupportedSignalGroupError extends SignalStoreError {
  constructor(message: string) {
    super('group-limit', message);
    this.name = 'UnsupportedSignalGroupError';
  }
}

/** Recording and export are not implemented in M0. */
export class UnsupportedRecordError extends SignalStoreError {
  constructor(method: string) {
    super(
      'record-unsupported',
      `RecordController.${method}() is unavailable in M0; recording/OPFS is M1 work`,
    );
    this.name = 'UnsupportedRecordError';
  }
}

/**
 * M0 RecordController: state is always 'off' and every transition refuses with a typed
 * error. In particular `arm()` must not look successful while nothing is being archived.
 */
export class UnsupportedRecordController implements RecordController {
  readonly state = 'off';
  readonly bytes = 0;

  arm(): void {
    throw new UnsupportedRecordError('arm');
  }

  async pause(): Promise<void> {
    throw new UnsupportedRecordError('pause');
  }

  async resume(): Promise<void> {
    throw new UnsupportedRecordError('resume');
  }

  async close(): Promise<void> {
    throw new UnsupportedRecordError('close');
  }

  async export(): Promise<void> {
    throw new UnsupportedRecordError('export');
  }
}

export interface DigitalSignalGroupOptions {
  /** Group id; default "digital". */
  id?: string;
  channels: ChannelCount;
  rateHz: number;
  /**
   * First device channel index for the group (a channel range, not a time origin).
   * Default 0. Signal ids are `d<start + localChannelIndex>`.
   */
  start?: number;
  /** Optional labels, one per local channel. Defaults to `D<absolute index>`. */
  names?: readonly string[];
}

export interface DigitalSignalStoreOptions {
  /**
   * Digital groups. M0 requires exactly one: zero is an invalid configuration and a
   * second throws UnsupportedSignalGroupError.
   */
  groups: readonly DigitalSignalGroupOptions[];
}

export class DigitalSignalStore implements SignalStore {
  readonly groups: readonly SignalGroup[];
  readonly signals: readonly SignalInfo[];
  readonly record: RecordController;

  private readonly group: SignalGroup;
  private readonly channels: ChannelCount;
  private readonly store: SampleStore;
  /** Signal id -> underlying store channel (the group-local index). */
  private readonly channelBySignal = new Map<SignalId, number>();
  /** Sorted by start; spans with different `signal` scopes may overlap. */
  private gapList: GapSpan[] = [];

  constructor(options: DigitalSignalStoreOptions) {
    if (options.groups.length === 0) {
      throw new UnsupportedSignalGroupError(
        'DigitalSignalStore requires exactly one digital group, got none',
      );
    }
    if (options.groups.length > 1) {
      throw new UnsupportedSignalGroupError(
        `M0 DigitalSignalStore supports exactly one group, got ${options.groups.length}; ` +
        'multi-rate groups are represented in the SignalStore types but are M1 work',
      );
    }

    const spec = options.groups[0]!;
    const id = spec.id ?? 'digital';
    if (id.length === 0) {
      throw new SignalStoreError('invalid-group', 'group id must be a non-empty string');
    }
    if (!isChannelCount(spec.channels)) {
      throw new SignalStoreError(
        'invalid-group',
        `channels must be one of 4, 8, 16, 32, 64 or 128, got ${spec.channels}`,
      );
    }
    if (!Number.isFinite(spec.rateHz) || !(spec.rateHz > 0)) {
      throw new SignalStoreError(
        'invalid-group',
        `rateHz must be a positive finite number, got ${spec.rateHz}`,
      );
    }
    const channelStart = spec.start ?? 0;
    if (!Number.isSafeInteger(channelStart) || channelStart < 0) {
      throw new SignalStoreError(
        'invalid-group',
        `group start must be a non-negative integer channel index, got ${channelStart}`,
      );
    }
    if (spec.names !== undefined && spec.names.length !== spec.channels) {
      throw new SignalStoreError(
        'invalid-group',
        `names has ${spec.names.length} entries for ${spec.channels} channels`,
      );
    }

    this.channels = spec.channels;
    this.group = Object.freeze({
      id,
      kind: 'digital' as const,
      start: channelStart,
      channels: spec.channels,
      rateHz: spec.rateHz,
    });

    const signals: SignalInfo[] = [];
    for (let i = 0; i < this.channels; i++) {
      const absolute = channelStart + i;
      const signalId = `d${absolute}`;
      this.channelBySignal.set(signalId, i);
      signals.push(Object.freeze({
        id: signalId,
        group: id,
        index: i,
        kind: 'digital' as const,
        name: spec.names?.[i] ?? `D${absolute}`,
      }));
    }
    this.signals = Object.freeze(signals);
    this.groups = Object.freeze([this.group]);
    this.store = createDigitalStore(this.channels, spec.rateHz);
    this.record = new UnsupportedRecordController();
  }

  // ---------------------------------------------------------------- retention

  /** Canonical seconds; 0 is the group's first sample. */
  get retainedFrom(): number {
    return this.store.droppedSamples / this.group.rateHz;
  }

  /** Exclusive newest absolute position, per group. */
  get newest(): Readonly<Record<string, SamplePos>> {
    return { [this.group.id]: this.newestPos() };
  }

  /** Absolute position of the oldest retained sample. */
  private retainedPos(): SamplePos {
    return this.store.droppedSamples;
  }

  /** Absolute position one past the newest appended sample. */
  private newestPos(): SamplePos {
    return this.store.droppedSamples + this.store.length;
  }

  /**
   * Move the retention window so every sample before `seconds` is dropped. The
   * underlying store drops in DROP_FRONT_QUANTUM-sample units and only full units, so
   * the requested position is rounded up to a quantum and then clamped to the newest
   * full quantum the store holds. `retainedFrom` reports where the window actually is.
   *
   * Absolute positions never move: `newest` is unchanged, and the sample at a given
   * position keeps that position for the store's lifetime.
   */
  dropBefore(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      throw new SignalStoreError('invalid-position', `dropBefore needs finite seconds, got ${seconds}`);
    }
    if (seconds <= 0) return;

    const newest = this.newestPos();
    const wanted = Math.min(newest, samplesBefore(seconds, this.group.rateHz));
    // Round up so the requested time is not left in the window, then clamp to the last
    // full quantum the store can actually drop.
    const aligned = Math.ceil(wanted / DROP_FRONT_QUANTUM) * DROP_FRONT_QUANTUM;
    const dropped = this.store.droppedSamples;
    const longest = dropped +
      Math.floor(this.store.length / DROP_FRONT_QUANTUM) * DROP_FRONT_QUANTUM;
    const target = Math.min(aligned, longest);
    if (target <= dropped) return;

    this.store.dropFront(target - dropped);
    this.trimGapsFront(this.store.droppedSamples);
  }

  // ---------------------------------------------------------------- append

  append(groupId: string, chunk: Uint8Array, start: SamplePos): void {
    this.requireGroup(groupId);
    if (!Number.isFinite(start) || !Number.isSafeInteger(start) || start < 0) {
      throw new SignalStoreError(
        'invalid-position',
        `append start must be a non-negative integer sample position, got ${start}`,
      );
    }
    const newest = this.newestPos();
    if (start < newest) {
      throw new SignalStoreError(
        'overlap',
        `append to ${groupId} starts at ${start}, before newest ${newest}; ` +
        'appended chunks must not overlap retained or pending positions',
      );
    }
    if (start > newest) {
      throw new SignalStoreError(
        'non-contiguous',
        `append to ${groupId} starts at ${start}, leaving [${newest}, ${start}) unrepresented; ` +
        'append filler samples and note a gap instead of skipping positions',
      );
    }

    const bytesPerSample = bytesPerSampleForChannels(this.channels);
    if (chunk.byteLength % bytesPerSample !== 0) {
      throw new SignalStoreError(
        'invalid-chunk',
        `chunk of ${chunk.byteLength} bytes is not a whole number of ${bytesPerSample}-byte samples`,
      );
    }
    if (chunk.byteLength === 0) return;

    const samples = chunk.byteLength / bytesPerSample;
    if (!Number.isSafeInteger(start + samples)) {
      throw new SignalStoreError(
        'invalid-position',
        `append would end at unsafe sample position ${start + samples}`,
      );
    }
    // The underlying store validates the capture ceiling and appends at its end, which
    // is exactly `newest` after the contiguity checks above.
    this.store.append(chunk);
  }

  // ---------------------------------------------------------------- query

  /**
   * O(bins) with no per-sample work. When the whole requested range is retained, known
   * and gap-free the underlying ColumnView is used directly; otherwise each bin's known
   * sub-ranges are asked as width-one ColumnViews and combined.
   *
   * Status precedence: a bin overlapping a noteGap is COLUMN_GAP even if part of it is
   * also beyond `newest`. Bins wholly or partly before the retention window are reported
   * as COLUMN_GAP (unknown) even though no GapSpan records the eviction.
   */
  query(signal: SignalId, start: SamplePos, end: SamplePos, bins: number): SignalColumns {
    const channel = this.requireChannel(signal);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new SignalStoreError(
        'invalid-position',
        `query range must be finite, got [${start}, ${end})`,
      );
    }
    if (!Number.isInteger(bins) || bins <= 0) {
      throw new SignalStoreError('invalid-position', `bins must be a positive integer, got ${bins}`);
    }
    const s = Math.max(0, Math.floor(start));
    const e = Math.ceil(end);
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e)) {
      throw new SignalStoreError(
        'invalid-position',
        `query range must use safe integer sample positions, got [${start}, ${end})`,
      );
    }
    if (s >= e) {
      throw new SignalStoreError('invalid-position', `empty query range [${start}, ${end})`);
    }

    const retained = this.retainedPos();
    const newest = this.newestPos();

    // Fast path: the entire view is known data with no gap. One ColumnView, O(bins).
    // Arrays are copied because the underlying view borrows scratch buffers.
    if (s >= retained && e <= newest && !this.hasGapIn(signal, s, e)) {
      const view = this.store.query(channel, s - retained, e - retained, bins);
      return {
        signal,
        start: view.startSample + retained,
        end: view.endSample + retained,
        bins,
        status: new Uint8Array(bins),
        digital: {
          low: view.low.slice(),
          high: view.high.slice(),
          edge: view.edge.slice(),
          packed: view.packed.slice(),
        },
      };
    }

    const status = new Uint8Array(bins);
    const low = new Uint8Array(bins);
    const high = new Uint8Array(bins);
    const edge = new Uint8Array(bins);
    const packed = new Uint8Array(bins);
    const gaps = this.gapList;
    const width = e - s;

    // Gaps are sorted and columns ascend, so the pending/gap walk is monotone.
    let gapAt = 0;
    for (let i = 0; i < bins; i++) {
      let c0 = s + Math.floor((i * width) / bins);
      let c1 = s + Math.floor(((i + 1) * width) / bins);
      if (c1 <= c0) c1 = c0 + 1;
      if (c1 > e) c1 = e;

      while (gapAt < gaps.length) {
        const gap = gaps[gapAt]!;
        if (gap.end <= c0 || !this.gapApplies(gap, signal)) {
          gapAt++;
          continue;
        }
        break;
      }
      const gapHit = gapAt < gaps.length && gaps[gapAt]!.start < c1;
      const pending = c1 > newest;
      const evicted = c0 < retained;
      status[i] = gapHit ? COLUMN_GAP : pending ? COLUMN_PENDING : evicted ? COLUMN_GAP : COLUMN_OK;

      // Best-effort levels and edges from the known sub-ranges of this bin. A gap bin
      // keeps these bits so the renderer can draw it under its NO_DATA wash.
      let lowBits = 1;
      let highBits = 0;
      let edgeBits = 0;
      let known = false;
      const knownEnd = Math.min(c1, newest);
      let segStart = Math.max(c0, retained);
      if (segStart < knownEnd) {
        let g = gapAt;
        while (g < gaps.length && gaps[g]!.start < knownEnd) {
          const gap = gaps[g]!;
          if (!this.gapApplies(gap, signal)) {
            g++;
            continue;
          }
          if (gap.end <= segStart) {
            g++;
            continue;
          }
          if (gap.start > segStart) {
            const segEnd = Math.min(gap.start, knownEnd);
            if (segStart < segEnd) {
              const view = this.store.query(channel, segStart - retained, segEnd - retained, 1);
              lowBits &= view.low[0]!;
              highBits |= view.high[0]!;
              edgeBits |= view.edge[0]!;
              known = true;
            }
          }
          if (gap.end > segStart) segStart = gap.end;
          if (segStart >= knownEnd) break;
          g++;
        }
        if (segStart < knownEnd) {
          const view = this.store.query(channel, segStart - retained, knownEnd - retained, 1);
          lowBits &= view.low[0]!;
          highBits |= view.high[0]!;
          edgeBits |= view.edge[0]!;
          known = true;
        }
      }
      if (!known) {
        lowBits = 0;
        highBits = 0;
        edgeBits = 0;
      }
      low[i] = lowBits;
      high[i] = highBits;
      edge[i] = edgeBits;
      packed[i] = highBits | (lowBits << 1) | (edgeBits << 2) |
        (status[i] === COLUMN_GAP ? GAP_BIT : 0);
    }

    return {
      signal,
      start: s,
      end: e,
      bins,
      status,
      digital: { low, high, edge, packed },
    };
  }

  // ---------------------------------------------------------------- sample / edges

  /** 0/1 inside the retained known window, null outside it or inside a gap. */
  sample(signal: SignalId, position: SamplePos): number | null {
    const channel = this.requireChannel(signal);
    if (!Number.isFinite(position) || !Number.isSafeInteger(position)) {
      throw new SignalStoreError(
        'invalid-position',
        `sample position must be an integer, got ${position}`,
      );
    }
    const retained = this.retainedPos();
    if (position < retained || position >= this.newestPos()) return null;
    if (this.gapCovers(signal, position)) return null;
    return this.store.sampleAt(channel, position - retained);
  }

  /**
   * Exact transition positions in [start, end), in absolute sample space. Delegates the
   * scan to the underlying SampleStore one gap-free sub-range at a time, so a transition
   * strictly inside a gap is never reported. A transition exactly at a gap's end is
   * reported when the first known sample differs from the gap's filler, which is the
   * underlying store's documented split-around-gaps semantics.
   */
  edges(signal: SignalId, start: SamplePos, end: SamplePos): Float64Array {
    const channel = this.requireChannel(signal);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new SignalStoreError(
        'invalid-position',
        `edges range must be finite, got [${start}, ${end})`,
      );
    }
    if (!(end > start)) return new Float64Array(0);

    const retained = this.retainedPos();
    const newest = this.newestPos();
    // Position 0 and the first retained sample have no retained predecessor, so no
    // transition can be proven there.
    const s = Math.max(1, retained + 1, Math.floor(start));
    const e = Math.min(newest, Math.ceil(end));
    if (s >= e) return new Float64Array(0);

    const parts: Array<[number, number]> = [];
    let a = s;
    for (const gap of this.gapList) {
      if (!this.gapApplies(gap, signal)) continue;
      if (gap.end <= a) continue;
      if (gap.start >= e) break;
      if (gap.start > a) parts.push([a, Math.min(gap.start, e)]);
      if (gap.end > a) a = gap.end;
      if (a >= e) break;
    }
    if (a < e) parts.push([a, e]);

    const chunks: Int32Array[] = [];
    let total = 0;
    for (const [partStart, partEnd] of parts) {
      if (partStart >= partEnd) continue;
      const found = this.store.edges(channel, partStart - retained, partEnd - retained);
      chunks.push(found);
      total += found.length;
    }

    const out = new Float64Array(total);
    let w = 0;
    for (const found of chunks) {
      for (let i = 0; i < found.length; i++) out[w++] = found[i]! + retained;
    }
    return out;
  }

  // ---------------------------------------------------------------- gaps

  /**
   * Record an unknown span. `group` must name this store's group, `signal` (when given)
   * must exist in it, and the span must lie inside [retained, newest): pending samples
   * are not gaps. A span that starts before the retention window is clamped; one wholly
   * before it is ignored.
   *
   * Overlapping or touching spans with the same signal scope merge. The merged span
   * keeps the reason of the earliest (leftmost) note. Group-wide and signal-specific
   * spans coexist because they apply to different signals.
   */
  noteGap(gap: GapSpan): void {
    this.requireGroup(gap.group);
    if (gap.signal !== undefined) this.requireChannel(gap.signal);
    if (!isGapReason(gap.reason)) {
      throw new SignalStoreError('gap-invalid', `unknown gap reason ${String(gap.reason)}`);
    }
    if (
      !Number.isSafeInteger(gap.start) || !Number.isSafeInteger(gap.end) ||
      gap.start < 0 || gap.end <= gap.start
    ) {
      throw new SignalStoreError(
        'gap-invalid',
        `gap must have integer bounds with 0 <= start < end, got [${gap.start}, ${gap.end})`,
      );
    }
    const retained = this.retainedPos();
    const newest = this.newestPos();
    if (gap.end > newest) {
      throw new SignalStoreError(
        'gap-out-of-range',
        `gap [${gap.start}, ${gap.end}) ends after newest ${newest}; ` +
        'pending data is not a gap',
      );
    }
    const start = Math.max(gap.start, retained);
    if (start >= gap.end) return;
    this.gapList = mergeGapSpan(
      this.gapList,
      makeGap(this.group.id, gap.signal, start, gap.end, gap.reason),
    );
  }

  gaps(): readonly GapSpan[] {
    return this.gapList.map(copyGap);
  }

  // ---------------------------------------------------------------- internals

  private requireGroup(groupId: string): void {
    if (groupId !== this.group.id) {
      throw new SignalStoreError(
        'unknown-group',
        `unknown group ${JSON.stringify(groupId)}; this store has ${JSON.stringify(this.group.id)}`,
      );
    }
  }

  private requireChannel(signal: SignalId): number {
    const channel = this.channelBySignal.get(signal);
    if (channel === undefined) {
      throw new SignalStoreError(
        'unknown-signal',
        `unknown signal ${JSON.stringify(signal)}; signals are d${this.group.start}..` +
        `d${this.group.start + this.channels - 1}`,
      );
    }
    return channel;
  }

  private gapApplies(gap: GapSpan, signal: SignalId): boolean {
    return gap.signal === undefined || gap.signal === signal;
  }

  private gapCovers(signal: SignalId, position: SamplePos): boolean {
    for (const gap of this.gapList) {
      if (gap.start > position) break;
      if (this.gapApplies(gap, signal) && position < gap.end) return true;
    }
    return false;
  }

  private hasGapIn(signal: SignalId, start: SamplePos, end: SamplePos): boolean {
    for (const gap of this.gapList) {
      if (gap.start >= end) break;
      if (gap.end <= start) continue;
      if (this.gapApplies(gap, signal)) return true;
    }
    return false;
  }

  private trimGapsFront(retained: SamplePos): void {
    const out: GapSpan[] = [];
    for (const gap of this.gapList) {
      if (gap.end <= retained) continue;
      const start = Math.max(gap.start, retained);
      out.push(
        start === gap.start
          ? copyGap(gap)
          : makeGap(gap.group, gap.signal, start, gap.end, gap.reason),
      );
    }
    this.gapList = out;
  }
}

export function createDigitalSignalStore(options: DigitalSignalStoreOptions): DigitalSignalStore {
  return new DigitalSignalStore(options);
}

// ---------------------------------------------------------------- module helpers

function isGapReason(value: string): value is GapReason {
  return (GAP_REASONS as readonly string[]).includes(value);
}

function makeGap(
  group: string,
  signal: SignalId | undefined,
  start: SamplePos,
  end: SamplePos,
  reason: GapReason,
): GapSpan {
  return signal === undefined
    ? { group, start, end, reason }
    : { group, signal, start, end, reason };
}

function copyGap(gap: GapSpan): GapSpan {
  return makeGap(gap.group, gap.signal, gap.start, gap.end, gap.reason);
}

/**
 * Insert a span into a start-sorted list, merging overlap/adjacency with spans of the
 * same signal scope. The reason of the leftmost span wins so a merge is deterministic.
 */
function mergeGapSpan(list: readonly GapSpan[], incoming: GapSpan): GapSpan[] {
  const signal = incoming.signal;
  let start = incoming.start;
  let end = incoming.end;
  let reason = incoming.reason;

  const rest: GapSpan[] = [];
  for (const gap of list) {
    if (gap.signal !== signal) {
      rest.push(gap);
      continue;
    }
    // Touching spans merge too, matching the SampleStore gap algebra.
    if (gap.end < start || gap.start > end) {
      rest.push(gap);
      continue;
    }
    if (gap.start < start) {
      start = gap.start;
      reason = gap.reason;
    }
    if (gap.end > end) end = gap.end;
  }

  const merged = makeGap(incoming.group, signal, start, end, reason);
  const out: GapSpan[] = [];
  let placed = false;
  for (const gap of rest) {
    if (!placed && gap.start > start) {
      out.push(merged);
      placed = true;
    }
    out.push(gap);
  }
  if (!placed) out.push(merged);
  return out;
}

/**
 * Number of sample positions strictly before `seconds`, with a small relative tolerance
 * so `n / rate` converted back to seconds does not gain an extra sample to float error.
 */
function samplesBefore(seconds: number, rateHz: number): number {
  const raw = seconds * rateHz;
  if (!Number.isFinite(raw)) return Number.MAX_SAFE_INTEGER;
  const nearest = Math.round(raw);
  const tolerance = 1e-9 * Math.max(1, Math.abs(raw));
  return Math.abs(raw - nearest) <= tolerance ? nearest : Math.ceil(raw);
}
