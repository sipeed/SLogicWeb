// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The v2 SignalStore contract from docs/ARCHITECTURE.md §4.
 *
 * This is deliberately separate from ./types.ts, which is the pre-v2 SampleStore
 * contract. The digital implementation in ./signalStore.ts may use a SampleStore
 * underneath, but callers only see this file: one canonical float64 sample-position
 * space per group, seconds for display, per-column status, and gap spans that carry a
 * reason.
 *
 * Digital columns carry low/high/edge/packed exactly like SampleStore's ColumnView.
 * `packed` keeps the same WebGL2 R8UI layout (bit0 high, bit1 low, bit2 edge, bit3 gap)
 * so the renderer can upload either view without a translation pass. Analog shapes are
 * declared here now so the interface does not change when analog groups arrive in M1.
 */

/** A float64 sample index at the group's rate. Exact integers up to 2^53. */
export type SamplePos = number;

/** Stable signal identity, e.g. "d0" for digital channel 0 or "a1" for analog 1. */
export type SignalId = string;

/** A group and its signals share one sample rate and one position space. */
export type SignalKind = 'digital' | 'analog';

/**
 * Why a span has no trustworthy samples. `dropout`, `overrun` and `suspend` are link
 * events; `record-gap` is an archive discontinuity; `import-gap` comes from a file;
 * `store-full` is a forced retention trim. A gap span is unknown data, not idle data.
 */
export type GapReason =
  | 'dropout'
  | 'overrun'
  | 'suspend'
  | 'record-gap'
  | 'import-gap'
  | 'store-full';

export interface SignalGroup {
  readonly id: string;
  readonly kind: SignalKind;
  /**
   * First device channel index covered by this group. This is a channel-range start,
   * not a time or sample-position origin: every group shares the canonical timeline and
   * position 0 is the same instant for all rates.
   */
  readonly start: number;
  readonly channels: number;
  readonly rateHz: number;
}

export interface SignalInfo {
  readonly id: SignalId;
  readonly group: string;
  /** Channel index inside the group (the index used by the storage layer). */
  readonly index: number;
  readonly kind: SignalKind;
  readonly name: string;
}

/** Per-column status. `pending` is not a gap; `gap` is not idle. */
export const COLUMN_OK = 0;
export const COLUMN_PENDING = 1;
export const COLUMN_GAP = 2;

export type ColumnStatus = typeof COLUMN_OK | typeof COLUMN_PENDING | typeof COLUMN_GAP;

/** Digital bins: 0/1 levels, edge flags, and the packed WebGL2 byte. */
export interface DigitalSignalColumns {
  readonly low: Uint8Array;
  readonly high: Uint8Array;
  readonly edge: Uint8Array;
  readonly packed: Uint8Array;
}

/** Analog bins, calibrated volts. Reserved for M1; the digital store never emits it. */
export interface AnalogSignalColumns {
  readonly min: Float32Array;
  readonly max: Float32Array;
  readonly mean: Float32Array;
}

/**
 * The result of one query. `start`/`end` are the realized integer sample range (the
 * requested bounds are expanded to whole samples), so callers converting bins back to
 * time must read these fields rather than reusing their request.
 *
 * `status` is one byte per bin: COLUMN_OK, COLUMN_PENDING or COLUMN_GAP. For a digital
 * store `digital` is always present and `analog` never is. A pending bin has no data
 * yet; a gap bin overlaps a span with no trustworthy samples.
 */
export interface SignalColumns {
  readonly signal: SignalId;
  readonly start: SamplePos;
  readonly end: SamplePos;
  readonly bins: number;
  readonly status: Uint8Array;
  readonly digital?: DigitalSignalColumns;
  readonly analog?: AnalogSignalColumns;
}

/**
 * A span of samples with no trustworthy data. `end` is exclusive. `signal` omitted means
 * the whole group. Overlapping spans are merged per signal scope; query() and gaps()
 * agree about whether a column is inside a gap.
 */
export interface GapSpan {
  readonly group: string;
  readonly signal?: SignalId;
  readonly start: SamplePos;
  readonly end: SamplePos;
  readonly reason: GapReason;
}

export type RecordState =
  | 'off'
  | 'armed'
  | 'recording'
  | 'paused'
  | 'exporting'
  | 'error'
  | 'full';

/**
 * Recording is orthogonal to retention. M0 ships only an unsupported controller
 * (state 'off'); OPFS recording and export are M1.
 */
export interface RecordController {
  readonly state: RecordState;
  readonly bytes: number;
  arm(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
  export(): Promise<void>;
}

/**
 * The v2 storage interface consumed by render, DSP, decode and the UI.
 *
 * Positions are float64 sample indices at each group's rate; `retainedFrom` is the
 * display window's left edge in canonical seconds. `newest` is exclusive and per group.
 */
export interface SignalStore {
  readonly groups: readonly SignalGroup[];
  readonly signals: readonly SignalInfo[];
  readonly retainedFrom: number;
  readonly newest: Readonly<Record<string, SamplePos>>;
  append(groupId: string, chunk: Uint8Array, start: SamplePos): void;
  dropBefore(seconds: number): void;
  query(signal: SignalId, start: SamplePos, end: SamplePos, bins: number): SignalColumns;
  sample(signal: SignalId, position: SamplePos): number | null;
  edges(signal: SignalId, start: SamplePos, end: SamplePos): Float64Array;
  noteGap(gap: GapSpan): void;
  gaps(): readonly GapSpan[];
  record: RecordController;
}
