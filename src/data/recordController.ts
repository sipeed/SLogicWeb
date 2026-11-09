// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * M1 record integration: the `RecordController` a `SignalStore` exposes, backed by the
 * chunked, checksummed archive in ./opfsRecord.ts (docs/ARCHITECTURE.md §4.3-§4.4).
 *
 * ## The synchronous `arm()` contract
 *
 * `RecordController.arm()` returns `void`, but creating the record metadata is storage
 * I/O and therefore asynchronous. This controller settles the mismatch explicitly:
 *
 *   - `arm()` validates the transition synchronously, marks the controller `armed`
 *     immediately, and queues `OpfsRecordWriter.arm()` behind the capture queue. The UI
 *     may leave its disabled state and the store may start forwarding samples at once.
 *   - A failure of that queued arm (quota, I/O, a root that already holds a record) is
 *     not thrown from `arm()`; it surfaces as `state === 'error'` plus `lastError`, the
 *     same as every other storage failure. Callers that need the durable outcome await
 *     `whenIdle()` and inspect `state`.
 *   - Only an invalid transition (arming twice, arming after this controller already
 *     owned a record) throws synchronously, because no storage work is needed to know
 *     it is a bug.
 *
 * One controller owns one record root. After `close()`/failure, construct a new
 * controller on a fresh storage root; the writer refuses a root that already holds a
 * record. Use `RecordArchive` to recover or export an existing root instead.
 *
 * ## Never block acquisition
 *
 * `capture()` is the integration surface called from `DigitalSignalStore.append()`. It
 * snapshots the bytes and returns without awaiting any storage operation. The snapshot
 * copy is required because acquisition reuses its transfer buffers; it is plain memory
 * bandwidth, not storage latency. Writes run on a private promise chain, in call order.
 * The backlog is bounded by `maxQueuedBytes` (default 64 MiB): exceeding it is a record
 * `error` and stops further captures rather than growing memory without bound. The
 * acquisition and display paths keep running in every case (§4.4).
 *
 * `bytes` reports committed archive bytes; `queuedBytes` reports the backlog that has
 * not reached the writer yet. Neither is a promise and neither waits for OPFS.
 */

import {
  OpfsRecordReader,
  OpfsRecordWriter,
  RecordError,
  type RecordExport,
  type RecordGap,
  type RecordManifest,
  type RecordOptions,
  type RecordProfile,
  type RecordRecovery,
  type RecordStorage,
  type RecordTimeRange,
} from './opfsRecord.js';
import type { RecordController, RecordState } from './signalTypes.js';

export {
  RecordError,
  CHUNK_HEADER_BYTES,
  DEFAULT_MAX_CHUNK_BYTES,
  MANIFEST_PATH,
  META_PATH,
  RECORD_FORMAT_VERSION,
  recordChunkPath,
  type RecordChunkInfo,
  type RecordChunkRead,
  type RecordErrorCode,
  type RecordExport,
  type RecordFile,
  type RecordGap,
  type RecordManifest,
  type RecordProfile,
  type RecordRecovery,
  type RecordStorage,
  type RecordTimeRange,
} from './opfsRecord.js';

/** Default ceiling for bytes queued but not yet committed to the archive. */
export const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export interface OpfsRecordControllerOptions {
  readonly profile: RecordProfile;
  /** Record budget in bytes; `Infinity` means quota-bound only. */
  readonly maxBytes?: number;
  /** Upper bound for one archive chunk; defaults to 4 MiB. */
  readonly maxChunkBytes?: number;
  /** Bound on the write backlog before recording stops with `error`. */
  readonly maxQueuedBytes?: number;
  /** Injected wall clock for the manifest's `startedAt`. */
  readonly clock?: () => number;
}

/**
 * Read/recover/export an existing record root. Intended for startup recovery and for
 * exporting an archive after `error`, `full`, or `close`; do not run `recover()` while a
 * writer is live in the same root (the record core documents the same restriction).
 */
export class RecordArchive {
  private readonly reader: OpfsRecordReader;

  constructor(storage: RecordStorage) {
    this.reader = new OpfsRecordReader(storage);
  }

  readManifest(): Promise<RecordManifest> {
    return this.reader.readManifest();
  }

  /** Verify every chunk, drop a torn tail/stale parts, and rebuild the manifest. */
  recover(): Promise<RecordRecovery> {
    return this.reader.recover();
  }

  /** Read a verified byte range that may span chunks. */
  readBytes(byteStart: number, byteEnd: number): Promise<Uint8Array> {
    return this.reader.readBytes(byteStart, byteEnd);
  }

  /** Read back every committed chunk plus the manifest, without mutating the archive. */
  export(): Promise<RecordExport> {
    return this.reader.export();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OpfsRecordController implements RecordController {
  private readonly writer: OpfsRecordWriter;
  private readonly maxQueuedBytesValue: number;
  private stateValue: RecordState = 'off';
  /** Whether `capture()`/`noteGap()` should enqueue; true between arm and pause/close. */
  private accepting = false;
  /** One record per controller: after arming, a second arm needs a fresh root. */
  private armedOnce = false;
  private lastErrorValue: string | null = null;
  private queuedBytesValue = 0;
  /** Serializes every writer operation in call order. Always resolves. */
  private tail: Promise<void> = Promise.resolve();
  private lastExportValue: RecordExport | null = null;

  /** Recovery/export surface for an existing root; see `RecordArchive`. */
  readonly archive: RecordArchive;

  constructor(storage: RecordStorage, options: OpfsRecordControllerOptions) {
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    if (!Number.isSafeInteger(maxQueuedBytes) || maxQueuedBytes <= 0) {
      throw new RecordError('config', 'record maxQueuedBytes must be a positive safe integer');
    }
    const writerOptions: RecordOptions = {
      profile: options.profile,
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(options.maxChunkBytes !== undefined ? { maxChunkBytes: options.maxChunkBytes } : {}),
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
    };
    this.writer = new OpfsRecordWriter(storage, writerOptions);
    this.maxQueuedBytesValue = maxQueuedBytes;
    this.archive = new RecordArchive(storage);
  }

  get state(): RecordState {
    return this.stateValue;
  }

  /** Bytes committed to the archive so far. Queue contents are not included. */
  get bytes(): number {
    return this.writer.bytes;
  }

  /** Bytes captured but not yet committed (bounded by `maxQueuedBytes`). */
  get queuedBytes(): number {
    return this.queuedBytesValue;
  }

  /** Human-readable cause of the last `error`/`full` transition; null while healthy. */
  get lastError(): string | null {
    return this.lastErrorValue;
  }

  /** Snapshot of committed chunks as the writer sees them. */
  get manifest(): RecordManifest {
    return this.writer.manifest;
  }

  /** Result of the most recent successful export; null before the first one. */
  get lastExport(): RecordExport | null {
    return this.lastExportValue;
  }

  /**
   * Begin a record. Returns `void` per the contract and reports `armed` immediately;
   * the metadata write runs on the queue and any failure becomes `state: 'error'` +
   * `lastError` (see the module comment). Throws only for an invalid transition.
   */
  arm(): void {
    if (this.armedOnce) {
      throw new RecordError(
        'state',
        'this controller has already owned a record; construct a controller on a fresh root',
      );
    }
    if (this.stateValue !== 'off') {
      throw new RecordError('state', `cannot arm while record state is '${this.stateValue}'`);
    }
    this.armedOnce = true;
    this.stateValue = 'armed';
    this.accepting = true;
    this.schedule(async () => {
      try {
        await this.writer.arm();
      } catch (error) {
        this.fail(error);
      }
    });
  }

  /**
   * Stop accepting new samples and commit everything already queued. Resolves when the
   * queue is drained; storage failures surface through `state`/`lastError`, not by
   * rejection. Idempotent; a no-op in terminal states.
   */
  async pause(): Promise<void> {
    this.accepting = false;
    if (this.stateValue === 'off' || this.stateValue === 'full' || this.stateValue === 'error') {
      return;
    }
    await this.enqueue(async () => {
      if (this.stateValue === 'off' || this.stateValue === 'full' ||
          this.stateValue === 'error') {
        return;
      }
      try {
        await this.writer.pause();
        if (this.stateValue !== 'exporting') this.stateValue = 'paused';
      } catch (error) {
        this.fail(error);
      }
    });
  }

  /** Continue a paused record. Idempotent; a no-op outside `paused`. */
  async resume(): Promise<void> {
    if (this.stateValue !== 'paused') return;
    this.accepting = true;
    await this.enqueue(async () => {
      if (this.stateValue !== 'paused') return;
      try {
        await this.writer.resume();
        this.stateValue = this.writer.bytes > 0 ? 'recording' : 'armed';
      } catch (error) {
        this.fail(error);
      }
    });
  }

  /** Finalize the record. Waits for queued writes; resolves even if finalizing fails. */
  async close(): Promise<void> {
    this.accepting = false;
    if (this.stateValue === 'off') return;
    await this.enqueue(async () => {
      if (this.stateValue === 'off') return;
      try {
        await this.writer.close();
        this.stateValue = 'off';
      } catch (error) {
        this.fail(error);
      }
    });
  }

  /** Contract export. Rejects on failure; the archive itself is never mutated. */
  export(): Promise<void> {
    return this.exportArchive().then(() => undefined);
  }

  /**
   * Export with the bytes and manifest in hand (the UI needs both). Runs after every
   * operation queued so far, so the snapshot is well defined. Allowed after `close()`
   * and after `error`/`full`; a failed export moves the controller to `error`.
   */
  exportArchive(): Promise<RecordExport> {
    return this.enqueue(async () => {
      const previous = this.stateValue;
      if (previous === 'off' && !this.armedOnce) {
        throw new RecordError('state', 'cannot export before the record is armed');
      }
      this.stateValue = 'exporting';
      try {
        const result = await this.writer.export();
        this.lastExportValue = result;
        this.stateValue = previous;
        return result;
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
  }

  /**
   * Store integration: snapshot `data` and queue one append. Never throws, never waits.
   * Ignored unless the controller is armed/recording; after `error`, `full`, `paused`
   * or `close` the store keeps acquiring and the record simply stops.
   */
  capture(data: Uint8Array, time: RecordTimeRange): void {
    if (!this.accepting || data.length === 0) return;
    if (this.queuedBytesValue + data.length > this.maxQueuedBytesValue) {
      this.fail(new RecordError(
        'io',
        `record write backlog exceeded ${this.maxQueuedBytesValue} bytes ` +
        `(${this.queuedBytesValue} queued, ${data.length} requested); recording stopped`,
      ));
      return;
    }
    const owned = data.slice();
    this.queuedBytesValue += owned.length;
    this.schedule(async () => {
      try {
        await this.writer.append(owned, time);
        if (this.stateValue === 'armed') this.stateValue = 'recording';
      } catch (error) {
        this.fail(error);
      } finally {
        this.queuedBytesValue -= owned.length;
      }
    });
  }

  /** Store integration: record a discontinuity while accepting. Never throws. */
  noteGap(gap: RecordGap): void {
    if (!this.accepting) return;
    const copy: RecordGap = {
      startSeconds: gap.startSeconds,
      endSeconds: gap.endSeconds,
      reason: gap.reason,
      group: gap.group,
    };
    this.schedule(async () => {
      try {
        await this.writer.noteGap(copy);
      } catch (error) {
        this.fail(error);
      }
    });
  }

  /** Resolves when every operation queued so far has finished (success or failure). */
  whenIdle(): Promise<void> {
    return this.tail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private schedule(operation: () => Promise<void>): void {
    void this.enqueue(operation).catch(() => {
      // Failure was already mapped onto state/lastError by the operation.
    });
  }

  private fail(error: unknown): void {
    // A terminal state already has the causal failure. A later queued append/export
    // refused because the writer is no longer writable is a downstream symptom; do not
    // overwrite the original lastError with a generic state refusal.
    if ((this.stateValue === 'full' || this.stateValue === 'error') &&
        error instanceof RecordError && error.code === 'state') {
      this.accepting = false;
      return;
    }
    this.lastErrorValue = describeError(error);
    this.accepting = false;
    if (error instanceof RecordError && error.code === 'full') {
      this.stateValue = 'full';
      return;
    }
    // Any other failure (a failed export, a corrupted read) is a real error and wins.
    this.stateValue = 'error';
  }
}
