// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * M1 multi-group SignalStore.
 *
 * One store owns every `SignalGroup` (digital or analog). Each group has its own
 * channels, sample rate, absolute sample-position space, retention window and gaps;
 * append/query/sample/edges/gaps route by group id. Groups are aligned by TIME, never
 * by index: append positions are per-group sample indices and are valid independently
 * for every rate.
 *
 * Digital groups delegate sample storage to the existing SampleStore layouts. The
 * adaptation to the v2 contract in ./signalTypes.ts keeps M0 behavior:
 *
 *   - positions are absolute float64 sample indices in the group's own space. The first
 *     append fixes that group's **origin** to its start position (SimDriver emits from
 *     T-pre, so that is usually nonzero); positions before the origin are unknown and
 *     report as GAP, never pending;
 *   - the underlying store's relative index is `position - (origin + droppedSamples)`;
 *     `retainedPos` is its absolute left edge;
 *   - queries add per-bin status (gap > evicted > pending > ok);
 *   - gaps and their reasons live here, not in the SampleStore, per group, so
 *     signal-specific spans are possible and `edges()` can filter them per signal. A gap
 *     may extend past `newest`: that is a watermark for samples the stream already knows
 *     it lost. A later append that starts beyond `newest` is accepted only when a
 *     group-wide gap covers the skipped span, and the store appends filler so its index
 *     space stays contiguous and bounded;
 *   - `dropBefore()` converts canonical seconds to each group's own position space and
 *     drops every group, so multi-rate groups stay aligned by time and absolute
 *     positions never move.
 *
 * Analog groups store calibrated volts as interleaved little-endian Float32 samples:
 * `append()` receives `channels * 4` bytes per sample and a chunk may start at any
 * integer position. Values are already calibrated by the caller; raw codes and the
 * calibration id belong in the record manifest, not here. Analog queries answer
 * O(bins)-ish range summaries from a per-channel block pyramid (block 64, fanout 16),
 * with raw samples only at bin boundaries. Unknown bins (evicted, pending, or inside a
 * gap) report NaN min/max/mean so zero volts is never implied for missing data; a bin
 * that is only partly unknown summarizes its known sub-ranges.
 *
 * Retention is bounded per group by `maxSamples`. Exceeding it is a typed `store-full`
 * error, never a silent truncation. The public `retainedFrom` scalar is the latest
 * per-group left edge (the time from which every group is consistently retained);
 * `retainedFromOf(groupId)` exposes each group's own edge.
 *
 * Analog signals have no digital transitions: `edges(analogSignal, ...)` returns an
 * empty Float64Array. This is the only intentional semantic difference between kinds
 * at the store surface.
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
import { OpfsRecordController } from './recordController.js';
import {
  RecordError,
  type RecordProfile,
  type RecordStorage,
} from './opfsRecord.js';
import { bytesPerSampleForChannels, isChannelCount, MAX_SAMPLES, type ChannelCount } from '../types.js';

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
  | 'store-full'
  | 'record-unsupported'
  | 'invalid-record';

export class SignalStoreError extends Error {
  readonly code: SignalStoreErrorCode;

  constructor(code: SignalStoreErrorCode, message: string) {
    super(message);
    this.name = 'SignalStoreError';
    this.code = code;
  }
}

/**
 * Configuration-level refusal. M1 accepts multiple groups, but zero groups remains an
 * invalid store and a signal-id collision across groups is refused rather than silently
 * remapping one group's channels onto another's identity.
 */
export class UnsupportedSignalGroupError extends SignalStoreError {
  constructor(message: string) {
    super('group-limit', message);
    this.name = 'UnsupportedSignalGroupError';
  }
}

/** Recording and export are not implemented in M0/M1 foundation. */
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

interface SignalGroupOptionsBase {
  /** Group id. Defaults to "digital" or "analog" for a single group of that kind. */
  id?: string;
  rateHz: number;
  /**
   * First device channel index for the group (a channel range, not a time origin).
   * Default 0. Signal ids are `d<start + localChannelIndex>` for digital groups and
   * `a<start + localChannelIndex>` for analog groups.
   */
  start?: number;
  /** Optional labels, one per local channel. Defaults to `D<absolute index>` / `A<...>`. */
  names?: readonly string[];
  /**
   * Maximum number of samples this group's retained window may hold (resident samples,
   * not absolute positions). Appends beyond it, including filler for a skipped span,
   * throw SignalStoreError('store-full'). Retention is bounded per group; a multi-group
   * store is therefore bounded by the sum of its groups' budgets.
   */
  maxSamples?: number;
}

export interface DigitalSignalGroupOptions extends SignalGroupOptionsBase {
  /** Default 'digital'; kept optional so M0 configuration literals stay valid. */
  kind?: 'digital';
  channels: ChannelCount;
}

export interface AnalogSignalGroupOptions extends SignalGroupOptionsBase {
  kind: 'analog';
  /**
   * Number of analog channels. Analog data is not bit-packed, so any positive integer up
   * to the 128-channel device envelope is accepted (unlike the power-of-two digital
   * widths).
   */
  channels: number;
}

export type SignalGroupOptions = DigitalSignalGroupOptions | AnalogSignalGroupOptions;

/**
 * Optional OPFS record backend. Install it and the store exposes an
 * `OpfsRecordController` as `store.record`; leave it out and the store keeps the typed
 * unsupported stub. Recording is orthogonal to retention (§4.3): it never affects which
 * samples stay in RAM, and `dropBefore()` never touches the archive.
 *
 * The archive holds exactly one group's appended bytes, selected by `groupId` (default:
 * the store's first group). `profile` must describe that group's byte stream:
 * `channels` and `sampleRateHz` match the group, and `bytesPerSample` is the group's
 * bytes per delivered frame (`bytesPerSampleForChannels(channels)` for digital groups,
 * `4 * channels` for interleaved calibrated-Float32 analog groups). `append()` bytes
 * are archived verbatim; signal-specific store gaps are not archive gaps because the
 * bytes for the other channels are still present.
 *
 * `maxBytes` bounds the archive; exceeding it is record state `full`. `maxChunkBytes`
 * bounds one archive chunk (default 4 MiB). `maxQueuedBytes` bounds the backlog the
 * acquisition path may create ahead of OPFS; exceeding it is record state `error`.
 */
export interface SignalRecordOptions {
  readonly storage: RecordStorage;
  readonly profile: RecordProfile;
  /** Record budget in bytes; `Infinity` means quota-bound only. */
  readonly maxBytes?: number;
  /** Upper bound for one archive chunk; defaults to 4 MiB. */
  readonly maxChunkBytes?: number;
  /** Bound on queued-but-uncommitted bytes; defaults to 64 MiB. */
  readonly maxQueuedBytes?: number;
  /** Group whose appends are recorded; defaults to the store's first group. */
  readonly groupId?: string;
  /** Injected wall clock for the manifest's `startedAt`. */
  readonly clock?: () => number;
}

export interface DigitalSignalStoreOptions {
  /** Groups, digital or analog. M0 configuration literals (no `kind`) still mean digital. */
  groups: readonly SignalGroupOptions[];
  /**
   * Optional recording backend. Absent means `UnsupportedRecordController`, exactly as
   * before this option existed; every other store behavior is unchanged.
   */
  record?: SignalRecordOptions;
}

/** Filler is appended in blocks of this many samples so a huge legal skip never needs
 *  a same-size allocation. Must stay a positive integer. */
const FILLER_BLOCK_SAMPLES = 65_536;

// ---------------------------------------------------------------- analog storage

const ANALOG_BYTES_PER_VALUE = 4;
/** Level-0 analog block. Must equal DROP_FRONT_QUANTUM so a legal drop never splits one. */
const ANALOG_BLOCK = DROP_FRONT_QUANTUM;
const ANALOG_FANOUT_LOG = 4;
const ANALOG_FANOUT = 1 << ANALOG_FANOUT_LOG; // 16
/** Sizes: 64, 1024, 16K, 256K, 4M, 64M, 1G, 16G. The top covers MAX_SAMPLES. */
const ANALOG_MAX_LEVEL = 8;
const ANALOG_MAX_CHANNELS = 128;

/**
 * One rung of the analog pyramid. Every stored block is complete, so its sample count
 * is exactly `block`; only min/max/sum are kept. Arrays are laid out block-major with
 * `channels` values per block. `first` is the absolute block index of element 0
 * (relative to the group origin). The front is sliced on `dropBefore`, mirroring the
 * underlying SampleStore pyramid: absolute positions never move.
 */
interface AnalogSummaryLevel {
  readonly block: number;
  first: number;
  readonly min: number[];
  readonly max: number[];
  readonly sum: number[];
}

interface AnalogRangeStats {
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly count: number;
}

const EMPTY_STATS: AnalogRangeStats = { min: Infinity, max: -Infinity, sum: 0, count: 0 };

/**
 * Calibrated-volt storage for one analog group.
 *
 * Samples live in a ring buffer of interleaved Float32 values. The ring is an
 * implementation detail: `sampleAt` and `stats` take positions relative to the group
 * origin, exactly like the digital store's relative indices.
 *
 * Appends are contiguous (the SignalStore layer enforces it) and summary blocks form
 * in order as they complete. `dropFront` only advances cursors; it does not renumber
 * positions, rebuild raw blocks, or rewrite retained summaries except to discard the
 * prefix a drop fully covers plus any block the drop only partly covers (that block is
 * no longer trustworthy and must not answer a query).
 */
class AnalogSampleStore {
  readonly channels: number;
  length = 0;
  droppedSamples = 0;

  private values = new Float32Array(0);
  /** Number of samples the ring can hold. */
  private capacity = 0;
  /** Ring index (in samples) of the oldest retained sample. */
  private head = 0;
  private readonly levels: AnalogSummaryLevel[] = [];
  /** Next level-0 block to form. */
  private nextBlock0 = 0;
  /** Next parent block index to form at each level (parent of levels[k]). */
  private readonly nextParent: number[] = [];

  constructor(channels: number) {
    this.channels = channels;
    for (let k = 0; k < ANALOG_MAX_LEVEL; k++) {
      this.levels.push({
        block: ANALOG_BLOCK * ANALOG_FANOUT ** k,
        first: 0,
        min: [],
        max: [],
        sum: [],
      });
    }
    for (let k = 0; k < ANALOG_MAX_LEVEL - 1; k++) this.nextParent.push(0);
  }

  /** Decode `samples` interleaved little-endian Float32 samples and append them. */
  appendInterleaved(chunk: Uint8Array, samples: number): void {
    if (samples === 0) return;
    this.ensureCapacity(this.length + samples);
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const channels = this.channels;
    let offset = 0;
    const ringSlots = this.capacity * channels;
    let slot = ((this.head + this.length) % this.capacity) * channels;
    for (let i = 0; i < samples; i++) {
      for (let ch = 0; ch < channels; ch++) {
        this.values[slot + ch] = view.getFloat32(offset, true);
        offset += ANALOG_BYTES_PER_VALUE;
      }
      slot += channels;
      if (slot === ringSlots) slot = 0;
    }
    this.length += samples;
    this.formSummaries();
  }

  /**
   * Append `count` NaN samples. Filler is only used for a span a group-wide gap already
   * covers, so it is never reported as known data; NaN makes a bug that leaks it
   * visible instead of disguised as 0 V.
   */
  appendFiller(count: number): void {
    if (count <= 0) return;
    this.ensureCapacity(this.length + count);
    const channels = this.channels;
    const ringSlots = this.capacity * channels;
    let slot = ((this.head + this.length) % this.capacity) * channels;
    for (let i = 0; i < count; i++) {
      for (let ch = 0; ch < channels; ch++) this.values[slot + ch] = Number.NaN;
      slot += channels;
      if (slot === ringSlots) slot = 0;
    }
    this.length += count;
    this.formSummaries();
  }

  dropFront(samples: number): void {
    if (!Number.isInteger(samples) || samples < 0 || samples % DROP_FRONT_QUANTUM !== 0) {
      throw new Error(
        `analog dropFront drops a non-negative multiple of ${DROP_FRONT_QUANTUM}, got ${samples}`,
      );
    }
    if (samples > this.length) {
      throw new Error(`analog dropFront ${samples} past length ${this.length}`);
    }
    if (samples === 0) return;
    this.head = (this.head + samples) % this.capacity;
    this.length -= samples;
    this.droppedSamples += samples;
    this.trimSummaries();
  }

  /** One calibrated-volt sample of `channel` at a position relative to the group origin. */
  sampleAt(channel: number, relative: number): number {
    return this.valueAt(relative, channel);
  }

  /**
   * Range summary over [start, end), positions relative to the origin and already
   * clamped to the retained known window by the caller. O(levels * fanout) blocks plus
   * at most two partial blocks of raw samples, independent of the range width.
   */
  stats(channel: number, start: number, end: number): AnalogRangeStats {
    const lo = Math.max(start, this.droppedSamples);
    const hi = Math.min(end, this.droppedSamples + this.length);
    if (lo >= hi) return EMPTY_STATS;

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    const add = (value: number): void => {
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
      count++;
    };

    let cur = lo;
    // Head: reach a level-0 boundary so the greedy block descent is aligned.
    while (cur < hi && cur % ANALOG_BLOCK !== 0) {
      add(this.valueAt(cur, channel));
      cur++;
    }
    // Middle: take the largest aligned complete block that fits, then try coarser
    // levels again at the new cursor. The canonical decomposition uses O(log) blocks.
    const top = this.levels.length - 1;
    let level = top;
    while (cur < hi) {
      while (level >= 0) {
        const lvl = this.levels[level]!;
        const block = lvl.block;
        if (cur % block !== 0 || cur + block > hi) {
          level--;
          continue;
        }
        const index = cur / block - lvl.first;
        if (index < 0 || index >= lvl.min.length / this.channels) {
          level--;
          continue;
        }
        const at = index * this.channels + channel;
        if (lvl.min[at]! < min) min = lvl.min[at]!;
        if (lvl.max[at]! > max) max = lvl.max[at]!;
        sum += lvl.sum[at]!;
        count += block;
        cur += block;
        level = top;
        break;
      }
      if (level < 0) break;
    }
    // Tail: the last incomplete block, or a block not formed yet.
    while (cur < hi) {
      add(this.valueAt(cur, channel));
      cur++;
    }
    return { min, max, sum, count };
  }

  private valueAt(relative: number, channel: number): number {
    const index = relative - this.droppedSamples;
    if (index < 0 || index >= this.length) {
      throw new Error(
        `analog sample ${relative} is outside the retained window ` +
        `[${this.droppedSamples}, ${this.droppedSamples + this.length})`,
      );
    }
    const slot = (this.head + index) % this.capacity;
    return this.values[slot * this.channels + channel]!;
  }

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let capacity = Math.max(ANALOG_BLOCK * ANALOG_FANOUT, this.capacity);
    while (capacity < needed) capacity *= 2;
    const channels = this.channels;
    const next = new Float32Array(capacity * channels);
    if (this.length > 0) {
      const head = this.head;
      const cap = this.capacity;
      if (head + this.length <= cap) {
        next.set(this.values.subarray(head * channels, (head + this.length) * channels));
      } else {
        const firstPart = cap - head;
        next.set(this.values.subarray(head * channels, cap * channels));
        next.set(
          this.values.subarray(0, (this.length - firstPart) * channels),
          firstPart * channels,
        );
      }
    }
    this.values = next;
    this.capacity = capacity;
    this.head = 0;
  }

  /** Form every level-0 block the retained data has completed, then roll them upward. */
  private formSummaries(): void {
    const completeBlocks = Math.floor((this.droppedSamples + this.length) / ANALOG_BLOCK);
    const level0 = this.levels[0]!;
    while (this.nextBlock0 < completeBlocks) {
      const blockIndex = this.nextBlock0;
      this.nextBlock0++;
      const blockStart = blockIndex * ANALOG_BLOCK;
      // A complete block cannot be dropped piecemeal: retained positions are always a
      // multiple of the same 64-sample quantum. Keep the guard explicit so a future
      // change to the drop quantum cannot silently produce a bogus summary.
      if (blockStart < this.droppedSamples) continue;
      const channels = this.channels;
      const min: number[] = [];
      const max: number[] = [];
      const sum: number[] = [];
      for (let ch = 0; ch < channels; ch++) {
        let lo = Infinity;
        let hi = -Infinity;
        let total = 0;
        for (let i = 0; i < ANALOG_BLOCK; i++) {
          const value = this.valueAt(blockStart + i, ch);
          if (value < lo) lo = value;
          if (value > hi) hi = value;
          total += value;
        }
        min.push(lo);
        max.push(hi);
        sum.push(total);
      }
      this.pushSummary(level0, blockIndex, min, max, sum);
    }
    this.cascadeSummaries();
  }

  private cascadeSummaries(): void {
    const channels = this.channels;
    for (let k = 0; k < this.levels.length - 1; k++) {
      const child = this.levels[k]!;
      const parent = this.levels[k + 1]!;
      for (;;) {
        const parentIndex = this.nextParent[k]!;
        const childStart = parentIndex * ANALOG_FANOUT;
        const childEnd = childStart + ANALOG_FANOUT;
        const childBlocks = child.min.length / channels;
        if (childEnd > child.first + childBlocks) break; // children not complete yet
        if (childStart < child.first || parentIndex < parent.first) {
          // The child span crosses a drop: the parent is partly unknown and unusable.
          // Skip it; the formed parent sequence stays contiguous from `parent.first`.
          this.nextParent[k] = parentIndex + 1;
          continue;
        }
        const min: number[] = [];
        const max: number[] = [];
        const sum: number[] = [];
        for (let ch = 0; ch < channels; ch++) {
          let lo = Infinity;
          let hi = -Infinity;
          let total = 0;
          for (let i = 0; i < ANALOG_FANOUT; i++) {
            const at = (childStart + i - child.first) * channels + ch;
            if (child.min[at]! < lo) lo = child.min[at]!;
            if (child.max[at]! > hi) hi = child.max[at]!;
            total += child.sum[at]!;
          }
          min.push(lo);
          max.push(hi);
          sum.push(total);
        }
        this.pushSummary(parent, parentIndex, min, max, sum);
        this.nextParent[k] = parentIndex + 1;
      }
    }
  }

  private pushSummary(
    level: AnalogSummaryLevel,
    blockIndex: number,
    min: readonly number[],
    max: readonly number[],
    sum: readonly number[],
  ): void {
    const have = level.min.length / this.channels;
    if (have === 0) {
      level.first = blockIndex;
    } else if (blockIndex !== level.first + have) {
      throw new Error(
        `analog summary blocks out of order: want ${level.first + have}, got ${blockIndex}`,
      );
    }
    for (let ch = 0; ch < this.channels; ch++) {
      level.min.push(min[ch]!);
      level.max.push(max[ch]!);
      level.sum.push(sum[ch]!);
    }
  }

  private trimSummaries(): void {
    const dropped = this.droppedSamples;
    for (const level of this.levels) {
      const firstUsable = Math.ceil(dropped / level.block);
      if (firstUsable <= level.first) continue;
      const blocks = level.min.length / this.channels;
      const remove = Math.min(firstUsable - level.first, blocks);
      if (remove > 0) {
        const values = remove * this.channels;
        level.min.splice(0, values);
        level.max.splice(0, values);
        level.sum.splice(0, values);
        level.first += remove;
      }
      // If the drop consumed every stored block of this level, the next formed block
      // starts after the gap; pushSummary rebases `first` when the arrays are empty.
      if (level.min.length === 0 && level.first < firstUsable) level.first = firstUsable;
    }
  }
}

// ---------------------------------------------------------------- group state

interface GroupStateBase {
  readonly group: SignalGroup;
  readonly maxSamples: number;
  readonly channels: number;
  readonly channelBySignal: Map<SignalId, number>;
  originPos: SamplePos | undefined;
  gapList: GapSpan[];
}

interface DigitalGroupState extends GroupStateBase {
  readonly kind: 'digital';
  readonly store: SampleStore;
}

interface AnalogGroupState extends GroupStateBase {
  readonly kind: 'analog';
  readonly store: AnalogSampleStore;
}

type GroupState = DigitalGroupState | AnalogGroupState;

interface SignalEntry {
  readonly group: GroupState;
  readonly index: number;
}

/**
 * Multi-group SignalStore implementation. The M0 class name and factory are retained
 * for source compatibility; `groups` may now contain digital and analog groups.
 */
export class DigitalSignalStore implements SignalStore {
  readonly groups: readonly SignalGroup[];
  readonly signals: readonly SignalInfo[];
  readonly record: RecordController;

  private readonly groupList: readonly GroupState[];
  private readonly groupById = new Map<string, GroupState>();
  private readonly signalById = new Map<SignalId, SignalEntry>();
  /** The group whose append bytes are archived; null when recording is unsupported. */
  private readonly recordGroup: GroupState | null;
  /** Concrete controller (the public `record` is the same object, or the stub). */
  private readonly recordController: OpfsRecordController | null;

  constructor(options: DigitalSignalStoreOptions) {
    if (options.groups.length === 0) {
      throw new UnsupportedSignalGroupError(
        'DigitalSignalStore requires at least one group, got none',
      );
    }

    const groupList: GroupState[] = [];
    const groups: SignalGroup[] = [];
    const signals: SignalInfo[] = [];

    for (const spec of options.groups) {
      const rawKind: unknown = (spec as { kind?: unknown }).kind;
      const kind = rawKind === undefined ? 'digital' : rawKind;
      if (kind !== 'digital' && kind !== 'analog') {
        throw new SignalStoreError(
          'invalid-group',
          `group kind must be "digital" or "analog", got ${JSON.stringify(kind)}`,
        );
      }

      const id = spec.id ?? kind;
      if (id.length === 0) {
        throw new SignalStoreError('invalid-group', 'group id must be a non-empty string');
      }
      if (this.groupById.has(id)) {
        throw new SignalStoreError('invalid-group', `duplicate group id ${JSON.stringify(id)}`);
      }

      const channels = spec.channels;
      if (kind === 'digital') {
        if (!isChannelCount(channels)) {
          throw new SignalStoreError(
            'invalid-group',
            `digital channels must be one of 4, 8, 16, 32, 64 or 128, got ${channels}`,
          );
        }
      } else if (
        !Number.isSafeInteger(channels) || channels < 1 || channels > ANALOG_MAX_CHANNELS
      ) {
        throw new SignalStoreError(
          'invalid-group',
          `analog channels must be an integer in [1, ${ANALOG_MAX_CHANNELS}], got ${channels}`,
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
      if (spec.names !== undefined && spec.names.length !== channels) {
        throw new SignalStoreError(
          'invalid-group',
          `names has ${spec.names.length} entries for ${channels} channels`,
        );
      }
      const maxSamples = spec.maxSamples ?? MAX_SAMPLES;
      if (!Number.isSafeInteger(maxSamples) || maxSamples < 1) {
        throw new SignalStoreError(
          'invalid-group',
          `maxSamples must be a positive safe integer, got ${maxSamples}`,
        );
      }

      const group = Object.freeze({
        id,
        kind,
        start: channelStart,
        channels,
        rateHz: spec.rateHz,
      }) as SignalGroup;

      const channelBySignal = new Map<SignalId, number>();
      for (let i = 0; i < channels; i++) {
        const absolute = channelStart + i;
        const signalId = `${kind === 'digital' ? 'd' : 'a'}${absolute}`;
        if (this.signalById.has(signalId)) {
          throw new SignalStoreError(
            'invalid-group',
            `duplicate signal id ${JSON.stringify(signalId)}; overlapping channel ranges ` +
            'of the same kind need distinct group ranges',
          );
        }
        const name = spec.names?.[i] ?? `${kind === 'digital' ? 'D' : 'A'}${absolute}`;
        const info: SignalInfo = Object.freeze({
          id: signalId,
          group: id,
          index: i,
          kind,
          name,
        });
        channelBySignal.set(signalId, i);
        signals.push(info);
      }

      const base = {
        group,
        maxSamples,
        channels,
        channelBySignal,
        originPos: undefined as SamplePos | undefined,
        gapList: [] as GapSpan[],
      };
      const state: GroupState = kind === 'digital'
        ? { ...base, kind, store: createDigitalStore(channels as ChannelCount, spec.rateHz) }
        : { ...base, kind, store: new AnalogSampleStore(channels) };

      for (const signalId of channelBySignal.keys()) {
        this.signalById.set(signalId, { group: state, index: channelBySignal.get(signalId)! });
      }
      this.groupById.set(id, state);
      groupList.push(state);
      groups.push(group);
    }

    this.groupList = Object.freeze(groupList);
    this.groups = Object.freeze(groups);
    this.signals = Object.freeze(signals);
    const backend = createRecordBackend(options.record, groupList, this.groupById);
    this.recordGroup = backend.group;
    this.recordController = backend.controller;
    this.record = backend.controller ?? new UnsupportedRecordController();
  }

  // ---------------------------------------------------------------- retention

  /**
   * Absolute position of the first group's first appended sample. Before the first append
   * this is 0. Kept for single-group callers; use `originOf(groupId)` with several groups.
   */
  get origin(): SamplePos {
    return this.groupList[0]!.originPos ?? 0;
  }

  /** Absolute origin of one group (0 before its first append). */
  originOf(groupId: string): SamplePos {
    return this.requireGroup(groupId).originPos ?? 0;
  }

  /**
   * Canonical seconds of the latest per-group retained left edge. A multi-rate store can
   * round each group's drop to a different sample, so this is the time from which every
   * group is consistently retained. Single-group behavior is unchanged: it is exactly
   * that group's left edge.
   */
  get retainedFrom(): number {
    let latest = 0;
    for (const group of this.groupList) {
      latest = Math.max(latest, this.retainedPos(group) / group.group.rateHz);
    }
    return latest;
  }

  /** Canonical seconds of one group's retained left edge. */
  retainedFromOf(groupId: string): number {
    const group = this.requireGroup(groupId);
    return this.retainedPos(group) / group.group.rateHz;
  }

  /** Exclusive newest absolute position, per group. */
  get newest(): Readonly<Record<string, SamplePos>> {
    const out: Record<string, SamplePos> = {};
    for (const group of this.groupList) out[group.group.id] = this.newestPos(group);
    return out;
  }

  /** Absolute position of a group's oldest retained sample. */
  private retainedPos(group: GroupState): SamplePos {
    return (group.originPos ?? 0) + group.store.droppedSamples;
  }

  /** Absolute position one past a group's newest appended sample. */
  private newestPos(group: GroupState): SamplePos {
    return this.retainedPos(group) + group.store.length;
  }

  /**
   * Move every group's retention window so its own sample space is dropped before the
   * canonical time `seconds`. Each rate converts the same time independently; nothing
   * assumes index alignment across groups. The underlying stores drop in
   * DROP_FRONT_QUANTUM-sample units measured from the group origin, so the requested
   * position is rounded up to the next quantum and then clamped to the newest full
   * quantum the store holds. `retainedFromOf` reports where each window actually is.
   *
   * Absolute positions never move: `newest` is unchanged, and the sample at a given
   * position keeps that position for the store's lifetime.
   */
  dropBefore(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      throw new SignalStoreError('invalid-position', `dropBefore needs finite seconds, got ${seconds}`);
    }
    if (seconds <= 0) return;

    for (const group of this.groupList) this.dropGroupBefore(group, seconds);
  }

  private dropGroupBefore(group: GroupState, seconds: number): void {
    const origin = group.originPos ?? 0;
    const newest = this.newestPos(group);
    const wanted = Math.min(newest, samplesBefore(seconds, group.group.rateHz));
    // The underlying store's drop quantum is relative to the origin, not to absolute
    // position 0, so translate before rounding. Round up so the requested time is not
    // left in the window, then clamp to the last full quantum the store can drop.
    const wantedRelative = wanted - origin;
    const alignedRelative =
      Math.ceil(wantedRelative / DROP_FRONT_QUANTUM) * DROP_FRONT_QUANTUM;
    const dropped = group.store.droppedSamples;
    const longest = dropped +
      Math.floor(group.store.length / DROP_FRONT_QUANTUM) * DROP_FRONT_QUANTUM;
    const target = Math.min(Math.max(0, alignedRelative), longest);
    if (target <= dropped) return;

    group.store.dropFront(target - dropped);
    this.trimGapsFront(group, this.retainedPos(group));
  }

  // ---------------------------------------------------------------- append

  append(groupId: string, chunk: Uint8Array, start: SamplePos): void {
    const group = this.requireGroup(groupId);
    if (!Number.isFinite(start) || !Number.isSafeInteger(start) || start < 0) {
      throw new SignalStoreError(
        'invalid-position',
        `append start must be a non-negative integer sample position, got ${start}`,
      );
    }

    const bytesPerSample = group.kind === 'digital'
      ? bytesPerSampleForChannels(group.channels as ChannelCount)
      : ANALOG_BYTES_PER_VALUE * group.channels;
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

    // The first non-empty append fixes the group origin. Everything before it is
    // unknown (GAP), so it must never be treated as a pending prefix.
    if (
      group.originPos === undefined &&
      group.store.length === 0 &&
      group.store.droppedSamples === 0
    ) {
      group.originPos = start;
      this.trimGapsFront(group, start);
    }

    const newest = this.newestPos(group);
    if (start < newest) {
      throw new SignalStoreError(
        'overlap',
        `append to ${groupId} starts at ${start}, before newest ${newest}; ` +
        'appended chunks must not overlap retained or pending positions',
      );
    }

    // A gap watermark may legitimately sit ahead of the data. Skipping those positions
    // is allowed only when a group-wide gap covers every one of them; the store then
    // appends filler so relative indices stay contiguous. A signal-specific gap cannot
    // authorize the skip: sampling is group-wide and the other channels would silently
    // receive invented data. The covering span is not clipped: if it extends past
    // `start`, the appended samples stay marked GAP, so callers must note spans that
    // will receive no data.
    let fillerSamples = 0;
    if (start > newest) {
      if (!this.groupGapsCover(group, newest, start)) {
        throw new SignalStoreError(
          'non-contiguous',
          `append to ${groupId} starts at ${start}, leaving [${newest}, ${start}) unrepresented; ` +
          'note a group-wide gap over the skipped span and append filler samples instead',
        );
      }
      fillerSamples = start - newest;
    }

    const total = group.store.length + fillerSamples + samples;
    // `MAX_SAMPLES - 1` is the underlying SampleStore's hard ceiling: it rejects a
    // relative length above 0x7fffffff. Checking it here as well as in the append
    // catch keeps a failed append from committing its filler half.
    const ceiling = Math.min(group.maxSamples, MAX_SAMPLES - 1);
    if (total > ceiling) {
      throw new SignalStoreError(
        'store-full',
        `append to ${groupId} would hold ${total} samples, beyond the configured ` +
        `ceiling ${ceiling}`,
      );
    }

    try {
      this.appendFiller(group, fillerSamples);
      if (group.kind === 'digital') {
        group.store.append(chunk);
      } else {
        group.store.appendInterleaved(chunk, samples);
      }
    } catch (error) {
      throw this.translateAppendError(error);
    }

    // Record only bytes the store accepted, and only on the archival path. The
    // controller snapshots and queues; it never makes acquisition or display wait on
    // OPFS. Filler appended for a covered skip is a store detail and is not archived.
    this.recordAppend(group, chunk, start, samples);
  }

  /** Append `count` deterministic samples in bounded blocks. */
  private appendFiller(group: GroupState, count: number): void {
    if (count <= 0) return;
    if (group.kind === 'analog') {
      group.store.appendFiller(count);
      return;
    }
    const bytesPerSample = bytesPerSampleForChannels(group.channels as ChannelCount);
    const blockSamples = Math.min(count, FILLER_BLOCK_SAMPLES);
    const filler = new Uint8Array(blockSamples * bytesPerSample); // all zeros
    let remaining = count;
    while (remaining > 0) {
      const n = Math.min(remaining, blockSamples);
      group.store.append(n === blockSamples ? filler : filler.subarray(0, n * bytesPerSample));
      remaining -= n;
    }
  }

  /** The underlying stores throw a plain Error at their 2^31 hard ceiling. */
  private translateAppendError(error: unknown): unknown {
    if (error instanceof SignalStoreError) return error;
    if (error instanceof Error && error.message.includes('2^31 sample ceiling')) {
      return new SignalStoreError(
        'store-full',
        `store is at its hard sample ceiling: ${error.message}`,
      );
    }
    return error;
  }

  // ---------------------------------------------------------------- query

  /**
   * O(bins) with no per-sample work. Digital groups delegate to the underlying
   * ColumnView when the whole requested range is retained, known and gap-free; otherwise
   * each bin's known sub-ranges are asked as width-one ColumnViews and combined. Analog
   * groups summarize known sub-ranges with the per-channel block pyramid.
   *
   * Status precedence: explicit gap (including a pending gap watermark ahead of
   * `newest`) wins over eviction, eviction wins over pending, then ok: a bin whose start
   * is before the retention window is GAP even when its end is past `newest`. Positions
   * before the group origin are therefore GAP, never pending.
   */
  query(signal: SignalId, start: SamplePos, end: SamplePos, bins: number): SignalColumns {
    const entry = this.requireSignal(signal);
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

    return entry.group.kind === 'digital'
      ? this.queryDigital(entry.group, signal, entry.index, s, e, bins)
      : this.queryAnalog(entry.group, signal, entry.index, s, e, bins);
  }

  private queryDigital(
    group: DigitalGroupState,
    signal: SignalId,
    channel: number,
    s: SamplePos,
    e: SamplePos,
    bins: number,
  ): SignalColumns {
    const retained = this.retainedPos(group);
    const newest = this.newestPos(group);

    // Fast path: the entire view is known data with no gap. One ColumnView, O(bins).
    // Arrays are copied because the underlying view borrows scratch buffers.
    if (s >= retained && e <= newest && !this.hasGapIn(group, signal, s, e)) {
      const view = group.store.query(channel, s - retained, e - retained, bins);
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
    const gaps = group.gapList;
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
      status[i] = gapHit ? COLUMN_GAP : evicted ? COLUMN_GAP : pending ? COLUMN_PENDING : COLUMN_OK;

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
              const view = group.store.query(channel, segStart - retained, segEnd - retained, 1);
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
          const view = group.store.query(channel, segStart - retained, knownEnd - retained, 1);
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

  private queryAnalog(
    group: AnalogGroupState,
    signal: SignalId,
    channel: number,
    s: SamplePos,
    e: SamplePos,
    bins: number,
  ): SignalColumns {
    const retained = this.retainedPos(group);
    const newest = this.newestPos(group);
    const status = new Uint8Array(bins);
    const min = new Float32Array(bins);
    const max = new Float32Array(bins);
    const mean = new Float32Array(bins);
    const gaps = group.gapList;
    const width = e - s;
    // Analog storage addresses samples relative to the group origin; query bounds are
    // absolute positions in the same space as `retained`/`newest`.
    const origin = group.originPos ?? 0;

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
      status[i] = gapHit ? COLUMN_GAP : evicted ? COLUMN_GAP : pending ? COLUMN_PENDING : COLUMN_OK;

      // Summarize only trustworthy samples. A bin with none reports NaN so an unknown
      // interval is never drawn as 0 V; a bin that is partly unknown summarizes the
      // known sub-ranges, matching the digital store's best-effort bits under a wash.
      let knownMin = Infinity;
      let knownMax = -Infinity;
      let knownSum = 0;
      let knownCount = 0;
      const knownEnd = Math.min(c1, newest);
      let segStart = Math.max(c0, retained);
      const addRange = (from: number, to: number): void => {
        if (from >= to) return;
        const stats = group.store.stats(channel, from - origin, to - origin);
        if (stats.count === 0) return;
        if (stats.min < knownMin) knownMin = stats.min;
        if (stats.max > knownMax) knownMax = stats.max;
        knownSum += stats.sum;
        knownCount += stats.count;
      };
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
          if (gap.start > segStart) addRange(segStart, Math.min(gap.start, knownEnd));
          if (gap.end > segStart) segStart = gap.end;
          if (segStart >= knownEnd) break;
          g++;
        }
        if (segStart < knownEnd) addRange(segStart, knownEnd);
      }

      if (knownCount === 0) {
        min[i] = Number.NaN;
        max[i] = Number.NaN;
        mean[i] = Number.NaN;
      } else {
        min[i] = knownMin;
        max[i] = knownMax;
        mean[i] = knownSum / knownCount;
      }
    }

    return {
      signal,
      start: s,
      end: e,
      bins,
      status,
      analog: { min, max, mean },
    };
  }

  // ---------------------------------------------------------------- sample / edges

  /** Digital 0/1 or analog calibrated volts; null outside the known retained window. */
  sample(signal: SignalId, position: SamplePos): number | null {
    const entry = this.requireSignal(signal);
    if (!Number.isFinite(position) || !Number.isSafeInteger(position)) {
      throw new SignalStoreError(
        'invalid-position',
        `sample position must be an integer, got ${position}`,
      );
    }
    const group = entry.group;
    const retained = this.retainedPos(group);
    if (position < retained || position >= this.newestPos(group)) return null;
    if (this.gapCovers(group, signal, position)) return null;
    if (group.kind === 'digital') return group.store.sampleAt(entry.index, position - retained);
    return group.store.sampleAt(entry.index, position - (group.originPos ?? 0));
  }

  /**
   * Exact digital transition positions in [start, end), in absolute sample space.
   * Delegates the scan to the underlying SampleStore one gap-free sub-range at a time,
   * so a transition strictly inside a gap is never reported. A transition exactly at a
   * gap's end is reported when the first known sample differs from the gap's filler,
   * which is the underlying store's documented split-around-gaps semantics.
   *
   * Analog signals have no digital transitions; the result is empty.
   */
  edges(signal: SignalId, start: SamplePos, end: SamplePos): Float64Array {
    const entry = this.requireSignal(signal);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new SignalStoreError(
        'invalid-position',
        `edges range must be finite, got [${start}, ${end})`,
      );
    }
    if (!(end > start)) return new Float64Array(0);

    const group = entry.group;
    if (group.kind === 'analog') return new Float64Array(0);

    const channel = entry.index;
    const retained = this.retainedPos(group);
    const newest = this.newestPos(group);
    // Position 0 and the first retained sample have no retained predecessor, so no
    // transition can be proven there.
    const s = Math.max(1, retained + 1, Math.floor(start));
    const e = Math.min(newest, Math.ceil(end));
    if (s >= e) return new Float64Array(0);

    const parts: Array<{ start: number; end: number; suppressFirst: boolean }> = [];
    let a = s;
    let afterGap = false;
    for (const gap of group.gapList) {
      if (!this.gapApplies(gap, signal)) continue;
      if (gap.end <= a) continue;
      if (gap.start >= e) break;
      if (gap.start > a) {
        parts.push({ start: a, end: Math.min(gap.start, e), suppressFirst: afterGap });
      }
      if (gap.end > a) a = gap.end;
      afterGap = true;
      if (a >= e) break;
    }
    if (a < e) parts.push({ start: a, end: e, suppressFirst: afterGap });

    // Preallocate one Float64Array instead of holding every part's Int32Array and
    // copying afterwards: a clock-like channel can have millions of edges per part.
    // edgeCount() gives the exact size without materialising anything; the fallback
    // count pass releases each part before the next one is asked for.
    let total = 0;
    const hasEdgeCount = typeof group.store.edgeCount === 'function';
    for (const part of parts) {
      if (part.start >= part.end) continue;
      if (hasEdgeCount) {
        total += group.store.edgeCount!(channel, part.start - retained, part.end - retained);
      } else {
        total += group.store.edges(channel, part.start - retained, part.end - retained).length;
      }
    }

    const out = new Float64Array(total);
    let w = 0;
    for (const part of parts) {
      if (part.start >= part.end) continue;
      const found = group.store.edges(channel, part.start - retained, part.end - retained);
      let i = 0;
      // The first sample after a gap has no known predecessor: the edge bit the
      // underlying store computed against the gap filler is not a real transition.
      if (part.suppressFirst && found.length > 0 &&
          found[0]! + retained === part.start) {
        i = 1;
      }
      for (; i < found.length; i++) out[w++] = found[i]! + retained;
    }
    if (w > total) {
      throw new Error(`edge count under-estimated during edges(): ${total} then ${w}`);
    }
    return w === total ? out : out.subarray(0, w);
  }

  // ---------------------------------------------------------------- gaps

  /**
   * Record an unknown span in one group. `group` must exist, `signal` (when given) must
   * belong to that group, and the span must have integer bounds inside the stream:
   * start >= origin and end > start. `end` may be **past `newest`**: that is a pending
   * watermark for samples the stream already knows it lost, and queries report GAP over
   * it.
   *
   * A span that starts before the group's retention window is clamped; one wholly before
   * it is ignored. Positions before the origin are unknown by construction, so a span
   * noted there can be dropped without losing information.
   *
   * Overlapping or touching spans with the same signal scope merge. The merged span
   * keeps the reason of the earliest (leftmost) note. Group-wide and signal-specific
   * spans coexist because they apply to different signals; only a group-wide span can
   * authorize an append that skips positions.
   */
  noteGap(gap: GapSpan): void {
    const group = this.requireGroup(gap.group);
    if (gap.signal !== undefined) {
      const entry = this.signalById.get(gap.signal);
      if (entry === undefined || entry.group !== group) {
        throw new SignalStoreError(
          'unknown-signal',
          `unknown signal ${JSON.stringify(gap.signal)} in group ${JSON.stringify(gap.group)}`,
        );
      }
    }
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
    const retained = this.retainedPos(group);
    const start = Math.max(gap.start, retained, group.originPos ?? 0);
    if (start >= gap.end) return;
    group.gapList = mergeGapSpan(
      group.gapList,
      makeGap(group.group.id, gap.signal, start, gap.end, gap.reason),
    );
    // The archive only carries whole-group discontinuities. A signal-specific gap does
    // not mean the group's recorded bytes are missing.
    if (gap.signal === undefined) {
      this.recordNoteGap(group, start, gap.end, gap.reason);
    }
  }

  /** Every group's gaps, in group declaration order then sample order within a group. */
  gaps(): readonly GapSpan[] {
    const out: GapSpan[] = [];
    for (const group of this.groupList) {
      for (const gap of group.gapList) out.push(copyGap(gap));
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  /**
   * Forward accepted append bytes to the record queue. Canonical time is absolute
   * position / rate (§4.1); the controller copies the chunk and returns immediately.
   */
  private recordAppend(
    group: GroupState,
    chunk: Uint8Array,
    start: SamplePos,
    samples: number,
  ): void {
    const controller = this.recordController;
    if (controller === null || group !== this.recordGroup) return;
    const rateHz = group.group.rateHz;
    controller.capture(chunk, {
      startSeconds: start / rateHz,
      endSeconds: (start + samples) / rateHz,
    });
  }

  /** Forward a whole-group gap in the recorded group's timeline. Never throws. */
  private recordNoteGap(
    group: GroupState,
    start: SamplePos,
    end: SamplePos,
    reason: GapReason,
  ): void {
    const controller = this.recordController;
    if (controller === null || group !== this.recordGroup) return;
    const rateHz = group.group.rateHz;
    controller.noteGap({
      startSeconds: start / rateHz,
      endSeconds: end / rateHz,
      reason,
      group: group.group.id,
    });
  }

  private requireGroup(groupId: string): GroupState {
    const group = this.groupById.get(groupId);
    if (group === undefined) {
      const ids = this.groupList.map((state) => JSON.stringify(state.group.id)).join(', ');
      throw new SignalStoreError(
        'unknown-group',
        `unknown group ${JSON.stringify(groupId)}; this store has ${ids}`,
      );
    }
    return group;
  }

  private requireSignal(signal: SignalId): SignalEntry {
    const entry = this.signalById.get(signal);
    if (entry === undefined) {
      throw new SignalStoreError(
        'unknown-signal',
        `unknown signal ${JSON.stringify(signal)}; this store has ` + this.describeSignals(),
      );
    }
    return entry;
  }

  private describeSignals(): string {
    const parts: string[] = [];
    for (const group of this.groupList) {
      const prefix = group.kind === 'digital' ? 'd' : 'a';
      const first = group.group.start;
      const last = first + group.channels - 1;
      parts.push(first === last ? `${prefix}${first}` : `${prefix}${first}..${prefix}${last}`);
    }
    return parts.join(', ');
  }

  private gapApplies(gap: GapSpan, signal: SignalId): boolean {
    return gap.signal === undefined || gap.signal === signal;
  }

  /**
   * Whether group-wide gaps cover every position in [start, end). Signal-specific spans
   * do not count: an append that skips samples fills every channel, so only a note that
   * declares the whole group unknown justifies it.
   */
  private groupGapsCover(group: GroupState, start: SamplePos, end: SamplePos): boolean {
    let covered = start;
    for (const gap of group.gapList) {
      if (gap.start > covered) break; // sorted: nothing later can reach `covered`
      if (gap.signal !== undefined) continue;
      if (gap.end > covered) {
        covered = gap.end;
        if (covered >= end) return true;
      }
    }
    return covered >= end;
  }

  private gapCovers(group: GroupState, signal: SignalId, position: SamplePos): boolean {
    for (const gap of group.gapList) {
      if (gap.start > position) break;
      if (this.gapApplies(gap, signal) && position < gap.end) return true;
    }
    return false;
  }

  private hasGapIn(group: GroupState, signal: SignalId, start: SamplePos, end: SamplePos): boolean {
    for (const gap of group.gapList) {
      if (gap.start >= end) break;
      if (gap.end <= start) continue;
      if (this.gapApplies(gap, signal)) return true;
    }
    return false;
  }

  private trimGapsFront(group: GroupState, retained: SamplePos): void {
    const out: GapSpan[] = [];
    for (const gap of group.gapList) {
      if (gap.end <= retained) continue;
      const start = Math.max(gap.start, retained);
      out.push(
        start === gap.start
          ? copyGap(gap)
          : makeGap(gap.group, gap.signal, start, gap.end, gap.reason),
      );
    }
    group.gapList = out;
  }
}

interface RecordBackend {
  readonly controller: OpfsRecordController | null;
  readonly group: GroupState | null;
}

/**
 * Validate and build the optional recording backend. The archive is one byte stream, so
 * it captures exactly one group; the profile must describe that group's frame layout,
 * otherwise the manifest would misattribute the recorded bytes.
 */
function createRecordBackend(
  options: SignalRecordOptions | undefined,
  groupList: readonly GroupState[],
  groupById: ReadonlyMap<string, GroupState>,
): RecordBackend {
  if (options === undefined) return { controller: null, group: null };

  const groupId = options.groupId ?? groupList[0]!.group.id;
  const group = groupById.get(groupId);
  if (group === undefined) {
    throw new SignalStoreError(
      'invalid-record',
      `record group ${JSON.stringify(groupId)} is not one of this store's groups`,
    );
  }
  const profile = options.profile;
  const bytesPerSample = group.kind === 'digital'
    ? bytesPerSampleForChannels(group.channels as ChannelCount)
    : ANALOG_BYTES_PER_VALUE * group.channels;
  if (
    profile.channels !== group.channels ||
    profile.sampleRateHz !== group.group.rateHz ||
    profile.bytesPerSample !== bytesPerSample
  ) {
    throw new SignalStoreError(
      'invalid-record',
      `record profile ${JSON.stringify(profile.profileId)} ` +
      `(${profile.channels} channels at ${profile.sampleRateHz} Hz, ` +
      `${profile.bytesPerSample} bytes/frame) does not match group ` +
      `${JSON.stringify(groupId)} (${group.channels} channels at ${group.group.rateHz} Hz, ` +
      `${bytesPerSample} bytes/frame)`,
    );
  }

  try {
    const controller = new OpfsRecordController(options.storage, {
      profile,
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(options.maxChunkBytes !== undefined ? { maxChunkBytes: options.maxChunkBytes } : {}),
      ...(options.maxQueuedBytes !== undefined ? { maxQueuedBytes: options.maxQueuedBytes } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    });
    return { controller, group };
  } catch (error) {
    if (error instanceof RecordError) {
      throw new SignalStoreError('invalid-record', error.message);
    }
    throw error;
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
