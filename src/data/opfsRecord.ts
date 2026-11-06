// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * M1 OPFS record core (docs/ARCHITECTURE.md §4.3-§4.4): a chunked, checksummed,
 * crash-recoverable archive that is independent of the RAM retention window.
 *
 * The core knows nothing about OPFS or the DOM. All storage goes through the injected
 * `RecordStorage` adapter, whose contract is the subset of OPFS a record needs: open a
 * file, read/write/truncate it, list the root, remove an entry, and atomically rename an
 * entry. An OPFS implementation can be built on `navigator.storage.getDirectory()`
 * (`FileSystemFileHandle.createWritable()` or `createSyncAccessHandle()`) plus
 * `FileSystemHandle.move()`; browser types never appear here.
 *
 * On-disk layout inside one record root:
 *
 *   meta.json               profile/calibration metadata (envelope LWM2)
 *   manifest.json           chunk index, byte/time ranges, gaps (envelope LWM1)
 *   chunk-00000000.lwc      committed chunk: 64-byte header + payload
 *   *.part                  uncommitted temporary file; never scanned as a chunk
 *
 * Every chunk is written to `<path>.part`, read back for length, then renamed onto its
 * committed name. A crash can therefore leave a complete chunk, a short `.part`, or a
 * truncated committed file; `recover()` ignores/removes `.part` files and treats an
 * invalid *last* committed chunk as a torn tail. A corrupt chunk that has a valid
 * successor is data loss in the middle of the record and is a typed `corruption` error.
 *
 * Assumptions and limits (also the integration contract):
 *   - One writer owns a root. `arm()` refuses a root that already contains record files;
 *     use the reader to recover/export an interrupted record instead.
 *   - Appends are contiguous: chunk byte ranges start at 0 and never skip. Time ranges
 *     are caller-supplied, absolute, and monotonic across appends; when one append spans
 *     several chunks the range is divided proportionally by bytes. Pass chunk-sized
 *     appends if exact per-chunk time membership matters.
 *   - The chunk size is bounded (default 4 MiB). A large append becomes several chunks;
 *     a small append becomes one smaller chunk, so chunks are bounded, not padded.
 *   - `maxBytes` is the record budget. Exhausting it is typed `full` (state 'full') and
 *     writes nothing; a storage quota failure is typed `quota` (state 'error').
 *   - `recover()` verifies every payload checksum, so it is O(record bytes). It is a
 *     startup operation: do not run it while a writer is live in the same root.
 *   - There are no timers and no ambient clock reads; `clock` is injected for tests.
 */

import type { GapReason, RecordState } from './signalTypes.js';

export const RECORD_FORMAT_VERSION = 1;
export const CHUNK_HEADER_BYTES = 64;
export const DEFAULT_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const MANIFEST_PATH = 'manifest.json';
export const META_PATH = 'meta.json';
export const CHUNK_PREFIX = 'chunk-';
export const CHUNK_SUFFIX = '.lwc';

const CHUNK_MAGIC = [0x4c, 0x57, 0x43, 0x31] as const; // "LWC1"
const MANIFEST_MAGIC = [0x4c, 0x57, 0x4d, 0x31] as const; // "LWM1"
const META_MAGIC = [0x4c, 0x57, 0x4d, 0x32] as const; // "LWM2"
const ENVELOPE_HEADER_BYTES = 16;

const GAP_REASONS: ReadonlySet<string> = new Set<GapReason>([
  'dropout', 'overrun', 'suspend', 'record-gap', 'import-gap', 'store-full',
]);

// ----------------------------------------------------------------------------- errors

export type RecordErrorCode = 'state' | 'config' | 'quota' | 'full' | 'io' | 'corruption';

/** Every refusal or storage failure surfaces as this typed error. */
export class RecordError extends Error {
  readonly code: RecordErrorCode;

  constructor(code: RecordErrorCode, message: string) {
    super(message);
    this.name = 'RecordError';
    this.code = code;
  }
}

function corruption(message: string): RecordError {
  return new RecordError('corruption', message);
}

function configError(message: string): RecordError {
  return new RecordError('config', message);
}

/** Map adapter failures (DOMException-shaped or plain) onto the record error space. */
function mapStorageError(error: unknown): RecordError {
  if (error instanceof RecordError) return error;
  const name = typeof error === 'object' && error !== null
    ? (error as { name?: unknown }).name
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new RecordError('quota', `record storage quota exceeded: ${message}`);
  }
  return new RecordError('io', `record storage failure: ${message}`);
}

// ---------------------------------------------------------------------------- storage

/**
 * One open file in the record root. `write` must not silently drop bytes; `read` must
 * return exactly `length` bytes or reject. Closing an already-closed file is harmless.
 */
export interface RecordFile {
  size(): Promise<number>;
  write(offset: number, data: Uint8Array): Promise<void>;
  read(offset: number, length: number): Promise<Uint8Array>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * The record root. `rename` is the commit point and must be atomic within the root
 * (OPFS `FileSystemHandle.move()` satisfies this); without it a torn chunk could become
 * visible under its committed name.
 */
export interface RecordStorage {
  open(path: string, create: boolean): Promise<RecordFile>;
  list(): Promise<readonly string[]>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

// --------------------------------------------------------------------------- metadata

/** Archive metadata fixed at `arm()` and repeated in the manifest. */
export interface RecordProfile {
  readonly profileId: string;
  /** Calibration set the sample bytes were produced with; null when not calibrated. */
  readonly calibrationId: string | null;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bytesPerSample: number;
}

/** Absolute seconds on the capture timeline (not sample positions). */
export interface RecordTimeRange {
  readonly startSeconds: number;
  readonly endSeconds: number;
}

export interface RecordChunkInfo {
  readonly index: number;
  readonly path: string;
  /** Absolute byte offset of this chunk's first payload byte in the record stream. */
  readonly byteStart: number;
  /** Exclusive end byte; `byteEnd - byteStart === bytes`. */
  readonly byteEnd: number;
  readonly timeStart: number | null;
  readonly timeEnd: number | null;
  readonly bytes: number;
  /** CRC32 of the payload; the header carries its own CRC. */
  readonly checksum: number;
}

/** A span with no trustworthy recorded data (link loss, suspension, forced trim, ...). */
export interface RecordGap {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly reason: GapReason;
  /** Signal group scope, or null for the whole record. */
  readonly group: string | null;
}

export type RecordManifestStatus = 'open' | 'closed';

export interface RecordManifest {
  readonly version: 1;
  readonly status: RecordManifestStatus;
  readonly profile: RecordProfile;
  readonly startedAt: number;
  readonly bytes: number;
  readonly gaps: readonly RecordGap[];
  readonly chunks: readonly RecordChunkInfo[];
}

export interface RecordOptions {
  readonly profile: RecordProfile;
  /** Record budget in bytes; `Infinity` (the default) means quota-bound only. */
  readonly maxBytes?: number;
  /** Upper bound for one chunk's payload; defaults to 4 MiB. */
  readonly maxChunkBytes?: number;
  /** Wall clock used for `startedAt`; injected so tests stay deterministic. */
  readonly clock?: () => number;
}

export interface RecordExport {
  readonly manifest: RecordManifest;
  readonly bytes: Uint8Array;
}

export interface RecordRecovery {
  readonly manifest: RecordManifest;
  /** True when recovery rewrote the manifest or dropped a torn tail / stale temp file. */
  readonly recovered: boolean;
  /** Committed chunk files dropped because they were the invalid tail. */
  readonly torn: readonly string[];
  /** Stale `.part` files removed from the root. */
  readonly removedParts: readonly string[];
  readonly scannedChunks: number;
}

export interface RecordChunkRead {
  readonly info: RecordChunkInfo;
  readonly bytes: Uint8Array;
}

interface RecordMeta {
  readonly version: 1;
  readonly profile: RecordProfile;
  readonly startedAt: number;
}

// ------------------------------------------------------------------------------ CRC32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

/** CRC32 (IEEE), used for chunk headers, chunk payloads and manifest envelopes. */
export function recordCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// -------------------------------------------------------------------- binary helpers

function writeMagic(bytes: Uint8Array, magic: readonly number[]): void {
  for (let i = 0; i < magic.length; i++) bytes[i] = magic[i]!;
}

function hasMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

function encodeEnvelope(magic: readonly number[], value: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(ENVELOPE_HEADER_BYTES + json.length);
  writeMagic(bytes, magic);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, RECORD_FORMAT_VERSION, true);
  view.setUint32(8, json.length, true);
  view.setUint32(12, recordCrc32(json), true);
  bytes.set(json, ENVELOPE_HEADER_BYTES);
  return bytes;
}

function decodeEnvelope(bytes: Uint8Array, magic: readonly number[], label: string): unknown {
  if (bytes.length < ENVELOPE_HEADER_BYTES) throw corruption(`${label} is truncated`);
  if (!hasMagic(bytes, magic)) throw corruption(`${label} has a bad magic`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== RECORD_FORMAT_VERSION) {
    throw corruption(`${label} has an unsupported version`);
  }
  const jsonLength = view.getUint32(8, true);
  if (ENVELOPE_HEADER_BYTES + jsonLength !== bytes.length) {
    throw corruption(`${label} has the wrong length`);
  }
  const json = bytes.subarray(ENVELOPE_HEADER_BYTES);
  if (recordCrc32(json) !== view.getUint32(12, true)) {
    throw corruption(`${label} checksum mismatch`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(json);
  } catch {
    throw corruption(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw corruption(`${label} is not valid JSON`);
  }
}

interface ChunkHeader {
  readonly index: number;
  readonly dataLength: number;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly timeStart: number | null;
  readonly timeEnd: number | null;
  readonly payloadCrc: number;
}

function encodeChunkHeader(header: ChunkHeader): Uint8Array {
  const bytes = new Uint8Array(CHUNK_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  writeMagic(bytes, CHUNK_MAGIC);
  view.setUint16(4, RECORD_FORMAT_VERSION, true);
  view.setUint16(6, header.timeStart === null ? 0 : 1, true);
  view.setUint32(8, CHUNK_HEADER_BYTES, true);
  view.setUint32(12, header.index, true);
  view.setUint32(16, header.dataLength, true);
  view.setUint32(20, 0, true);
  view.setFloat64(24, header.byteStart, true);
  view.setFloat64(32, header.byteEnd, true);
  view.setFloat64(40, header.timeStart ?? Number.NaN, true);
  view.setFloat64(48, header.timeEnd ?? Number.NaN, true);
  view.setUint32(56, header.payloadCrc, true);
  view.setUint32(60, recordCrc32(bytes.subarray(0, 60)), true);
  return bytes;
}

function decodeChunkHeader(bytes: Uint8Array, label: string): ChunkHeader {
  if (bytes.length !== CHUNK_HEADER_BYTES) throw corruption(`${label} has a short header`);
  if (!hasMagic(bytes, CHUNK_MAGIC)) throw corruption(`${label} has a bad magic`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== RECORD_FORMAT_VERSION) {
    throw corruption(`${label} has an unsupported version`);
  }
  const flags = view.getUint16(6, true);
  if ((flags & ~1) !== 0) throw corruption(`${label} has unknown header flags`);
  if (view.getUint32(8, true) !== CHUNK_HEADER_BYTES) {
    throw corruption(`${label} has an unsupported header size`);
  }
  if (recordCrc32(bytes.subarray(0, 60)) !== view.getUint32(60, true)) {
    throw corruption(`${label} header checksum mismatch`);
  }
  const index = view.getUint32(12, true);
  const dataLength = view.getUint32(16, true);
  const byteStart = view.getFloat64(24, true);
  const byteEnd = view.getFloat64(32, true);
  const hasTime = (flags & 1) !== 0;
  const timeStart = hasTime ? view.getFloat64(40, true) : null;
  const timeEnd = hasTime ? view.getFloat64(48, true) : null;
  if (!Number.isSafeInteger(byteStart) || byteStart < 0) {
    throw corruption(`${label} has an invalid byte start`);
  }
  if (!Number.isSafeInteger(byteEnd) || byteEnd - byteStart !== dataLength) {
    throw corruption(`${label} has an invalid byte range`);
  }
  if (hasTime) {
    if (timeStart === null || timeEnd === null ||
        !Number.isFinite(timeStart) || !Number.isFinite(timeEnd) || timeEnd < timeStart) {
      throw corruption(`${label} has an invalid time range`);
    }
  }
  return {
    index,
    dataLength,
    byteStart,
    byteEnd,
    timeStart,
    timeEnd,
    payloadCrc: view.getUint32(56, true),
  };
}

// ------------------------------------------------------------------------ JSON guards

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw corruption(`${label} is not an object`);
  return value;
}

function requireString(object: Record<string, unknown>, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw corruption(`${label}.${key} is not a string`);
  return value;
}

function requireNullableString(
  object: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw corruption(`${label}.${key} is not a string or null`);
  return value;
}

function requireFinite(object: Record<string, unknown>, key: string, label: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw corruption(`${label}.${key} is not a finite number`);
  }
  return value;
}

function requireInteger(
  object: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  label: string,
): number {
  const value = requireFinite(object, key, label);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw corruption(`${label}.${key} is not an integer in [${min}, ${max}]`);
  }
  return value;
}

function parseProfile(value: unknown, label: string): RecordProfile {
  const object = requireObject(value, `${label} profile`);
  const profileId = requireString(object, 'profileId', `${label} profile`);
  if (profileId.length === 0) throw corruption(`${label} profile id is empty`);
  const calibrationId = requireNullableString(object, 'calibrationId', `${label} profile`);
  const channels = requireInteger(object, 'channels', 1, 4096, `${label} profile`);
  const sampleRateHz = requireFinite(object, 'sampleRateHz', `${label} profile`);
  if (sampleRateHz <= 0) throw corruption(`${label} profile sample rate is not positive`);
  const bytesPerSample = requireInteger(object, 'bytesPerSample', 1, 64, `${label} profile`);
  return { profileId, calibrationId, channels, sampleRateHz, bytesPerSample };
}

function normalizeProfile(profile: RecordProfile): RecordProfile {
  if (typeof profile.profileId !== 'string' || profile.profileId.length === 0) {
    throw configError('record profile id must be a non-empty string');
  }
  if (profile.calibrationId !== null && typeof profile.calibrationId !== 'string') {
    throw configError('record calibration id must be a string or null');
  }
  if (!Number.isSafeInteger(profile.channels) || profile.channels <= 0) {
    throw configError('record profile channels must be a positive integer');
  }
  if (!Number.isFinite(profile.sampleRateHz) || profile.sampleRateHz <= 0) {
    throw configError('record profile sample rate must be positive');
  }
  if (!Number.isSafeInteger(profile.bytesPerSample) || profile.bytesPerSample <= 0) {
    throw configError('record profile bytes-per-sample must be a positive integer');
  }
  return {
    profileId: profile.profileId,
    calibrationId: profile.calibrationId,
    channels: profile.channels,
    sampleRateHz: profile.sampleRateHz,
    bytesPerSample: profile.bytesPerSample,
  };
}

function parseGap(value: unknown, label: string): RecordGap {
  const object = requireObject(value, `${label} gap`);
  const startSeconds = requireFinite(object, 'startSeconds', `${label} gap`);
  const endSeconds = requireFinite(object, 'endSeconds', `${label} gap`);
  if (endSeconds <= startSeconds) throw corruption(`${label} gap range is empty or inverted`);
  const reason = requireString(object, 'reason', `${label} gap`);
  if (!GAP_REASONS.has(reason)) throw corruption(`${label} gap has an unknown reason`);
  const group = requireNullableString(object, 'group', `${label} gap`);
  return { startSeconds, endSeconds, reason: reason as GapReason, group };
}

function parseChunk(value: unknown, expectedIndex: number, label: string): RecordChunkInfo {
  const object = requireObject(value, `${label}.chunks[${expectedIndex}]`);
  const chunkLabel = `${label}.chunks[${expectedIndex}]`;
  const index = requireInteger(object, 'index', 0, 99_999_999, chunkLabel);
  if (index !== expectedIndex) throw corruption(`${chunkLabel} is out of sequence`);
  const path = requireString(object, 'path', chunkLabel);
  if (path !== recordChunkPath(index)) throw corruption(`${chunkLabel} has an unexpected path`);
  const byteStart = requireInteger(object, 'byteStart', 0, Number.MAX_SAFE_INTEGER, chunkLabel);
  const byteEnd = requireInteger(object, 'byteEnd', 0, Number.MAX_SAFE_INTEGER, chunkLabel);
  const bytes = requireInteger(object, 'bytes', 1, 0xffffffff, chunkLabel);
  if (byteEnd - byteStart !== bytes) throw corruption(`${chunkLabel} has an inconsistent range`);
  const timeStart = object['timeStart'];
  const timeEnd = object['timeEnd'];
  let timeStartValue: number | null = null;
  let timeEndValue: number | null = null;
  if (timeStart !== null || timeEnd !== null) {
    if (typeof timeStart !== 'number' || !Number.isFinite(timeStart) ||
        typeof timeEnd !== 'number' || !Number.isFinite(timeEnd) || timeEnd < timeStart) {
      throw corruption(`${chunkLabel} has an invalid time range`);
    }
    timeStartValue = timeStart;
    timeEndValue = timeEnd;
  }
  const checksum = requireInteger(object, 'checksum', 0, 0xffffffff, chunkLabel);
  return {
    index, path, byteStart, byteEnd, timeStart: timeStartValue, timeEnd: timeEndValue,
    bytes, checksum,
  };
}

function parseManifest(value: unknown): RecordManifest {
  const label = 'record manifest';
  const object = requireObject(value, label);
  if (requireInteger(object, 'version', 1, 1, label) !== RECORD_FORMAT_VERSION) {
    throw corruption(`${label} has an unsupported version`);
  }
  const rawStatus = requireString(object, 'status', label);
  if (rawStatus !== 'open' && rawStatus !== 'closed') {
    throw corruption(`${label} has an unknown status`);
  }
  const profile = parseProfile(object['profile'], label);
  const startedAt = requireFinite(object, 'startedAt', label);
  const bytes = requireInteger(object, 'bytes', 0, Number.MAX_SAFE_INTEGER, label);
  const rawGaps = object['gaps'];
  if (!Array.isArray(rawGaps)) throw corruption(`${label}.gaps is not an array`);
  const gaps = rawGaps.map((gap, index) => parseGap(gap, `${label}.gaps[${index}]`));
  for (let i = 1; i < gaps.length; i++) {
    if (gaps[i]!.startSeconds < gaps[i - 1]!.startSeconds) {
      throw corruption(`${label}.gaps is not sorted`);
    }
  }
  const rawChunks = object['chunks'];
  if (!Array.isArray(rawChunks)) throw corruption(`${label}.chunks is not an array`);
  const chunks: RecordChunkInfo[] = [];
  let expectedByte = 0;
  let lastTimeEnd: number | null = null;
  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = parseChunk(rawChunks[i], i, label);
    if (chunk.byteStart !== expectedByte) {
      throw corruption(`${label}.chunks is not byte-contiguous`);
    }
    if (chunk.timeStart !== null && lastTimeEnd !== null && chunk.timeStart < lastTimeEnd) {
      throw corruption(`${label}.chunks has out-of-order time ranges`);
    }
    if (chunk.timeEnd !== null) lastTimeEnd = chunk.timeEnd;
    expectedByte = chunk.byteEnd;
    chunks.push(chunk);
  }
  if (expectedByte !== bytes) throw corruption(`${label}.bytes does not match its chunks`);
  return {
    version: RECORD_FORMAT_VERSION,
    status: rawStatus,
    profile,
    startedAt,
    bytes,
    gaps,
    chunks,
  };
}

function parseMeta(value: unknown): RecordMeta {
  const label = 'record metadata';
  const object = requireObject(value, label);
  if (requireInteger(object, 'version', 1, 1, label) !== RECORD_FORMAT_VERSION) {
    throw corruption(`${label} has an unsupported version`);
  }
  return {
    version: RECORD_FORMAT_VERSION,
    profile: parseProfile(object['profile'], label),
    startedAt: requireFinite(object, 'startedAt', label),
  };
}

// ------------------------------------------------------------------------ path names

/** Canonical committed path for a chunk index; also the manifest's `path` value. */
export function recordChunkPath(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 99_999_999) {
    throw configError(`record chunk index ${index} is out of range`);
  }
  return `${CHUNK_PREFIX}${String(index).padStart(8, '0')}${CHUNK_SUFFIX}`;
}

function parseChunkPath(path: string): number | null {
  const match = /^chunk-(\d{8})\.lwc$/.exec(path);
  if (match === null) return null;
  return Number(match[1]);
}

function isRecordArtifact(path: string): boolean {
  if (path === MANIFEST_PATH || path === META_PATH) return true;
  if (path === `${MANIFEST_PATH}.part` || path === `${META_PATH}.part`) return true;
  return path.startsWith(CHUNK_PREFIX) &&
    (path.endsWith(CHUNK_SUFFIX) || path.endsWith(`${CHUNK_SUFFIX}.part`));
}

// -------------------------------------------------------------------- storage helpers

async function listRoot(storage: RecordStorage): Promise<readonly string[]> {
  try {
    return await storage.list();
  } catch (error) {
    throw mapStorageError(error);
  }
}

async function readWholeFile(storage: RecordStorage, path: string): Promise<Uint8Array> {
  let file: RecordFile | null = null;
  try {
    file = await storage.open(path, false);
    const size = await file.size();
    return await file.read(0, size);
  } catch (error) {
    throw mapStorageError(error);
  } finally {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // A close failure cannot change the bytes we already read.
      }
    }
  }
}

/** Write `bytes` to `path` so a reader never observes a partial file. */
async function writeFileAtomic(
  storage: RecordStorage,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const part = `${path}.part`;
  let file: RecordFile | null = null;
  try {
    file = await storage.open(part, true);
    await file.truncate(0);
    await file.write(0, bytes);
    if (await file.size() !== bytes.length) {
      throw new RecordError('io', `short write for ${path}`);
    }
    await file.close();
    file = null;
    await storage.rename(part, path);
  } catch (error) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // Best effort: the part file is removed below.
      }
    }
    try {
      await storage.remove(part);
    } catch {
      // Best effort: a leftover `.part` is ignored by recovery.
    }
    throw mapStorageError(error);
  }
}

/** Read and fully verify one committed chunk file. */
async function readChunkFile(
  storage: RecordStorage,
  path: string,
  expectedIndex: number,
): Promise<RecordChunkRead> {
  let file: RecordFile | null = null;
  let header: ChunkHeader;
  let payload: Uint8Array;
  try {
    file = await storage.open(path, false);
    const size = await file.size();
    if (size < CHUNK_HEADER_BYTES) throw corruption(`chunk ${path} is truncated`);
    const headerBytes = await file.read(0, CHUNK_HEADER_BYTES);
    header = decodeChunkHeader(headerBytes, `chunk ${path}`);
    if (header.index !== expectedIndex) {
      throw corruption(`chunk ${path} claims index ${header.index}, expected ${expectedIndex}`);
    }
    const expectedSize = CHUNK_HEADER_BYTES + header.dataLength;
    if (size !== expectedSize) {
      throw corruption(`chunk ${path} has ${size} bytes, expected ${expectedSize}`);
    }
    payload = await file.read(CHUNK_HEADER_BYTES, header.dataLength);
  } catch (error) {
    throw mapStorageError(error);
  } finally {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // Reading already finished; a close failure cannot alter the verified bytes.
      }
    }
  }
  if (recordCrc32(payload) !== header.payloadCrc) {
    throw corruption(`chunk ${path} payload checksum mismatch`);
  }
  return {
    info: {
      index: header.index,
      path,
      byteStart: header.byteStart,
      byteEnd: header.byteEnd,
      timeStart: header.timeStart,
      timeEnd: header.timeEnd,
      bytes: header.dataLength,
      checksum: header.payloadCrc,
    },
    bytes: payload,
  };
}

function sameChunk(a: RecordChunkInfo, b: RecordChunkInfo): boolean {
  return a.index === b.index && a.path === b.path &&
    a.byteStart === b.byteStart && a.byteEnd === b.byteEnd &&
    a.timeStart === b.timeStart && a.timeEnd === b.timeEnd &&
    a.bytes === b.bytes && a.checksum === b.checksum;
}

async function exportManifest(
  storage: RecordStorage,
  manifest: RecordManifest,
): Promise<RecordExport> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const chunk of manifest.chunks) {
    const read = await readChunkFile(storage, chunk.path, chunk.index);
    if (!sameChunk(read.info, chunk)) {
      throw corruption(`chunk ${chunk.path} does not match the manifest`);
    }
    parts.push(read.bytes);
    total += read.bytes.length;
  }
  if (total !== manifest.bytes) throw corruption('record byte count does not match its manifest');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { manifest, bytes };
}

async function readRange(
  storage: RecordStorage,
  manifest: RecordManifest,
  byteStart: number,
  byteEnd: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) ||
      byteStart < 0 || byteEnd < byteStart || byteEnd > manifest.bytes) {
    throw configError(`record byte range [${byteStart}, ${byteEnd}) is invalid`);
  }
  const out = new Uint8Array(byteEnd - byteStart);
  if (out.length === 0) return out;
  let filled = 0;
  for (const chunk of manifest.chunks) {
    if (chunk.byteEnd <= byteStart) continue;
    if (chunk.byteStart >= byteEnd) break;
    const read = await readChunkFile(storage, chunk.path, chunk.index);
    if (!sameChunk(read.info, chunk)) {
      throw corruption(`chunk ${chunk.path} does not match the manifest`);
    }
    const from = Math.max(byteStart, chunk.byteStart);
    const to = Math.min(byteEnd, chunk.byteEnd);
    out.set(read.bytes.subarray(from - chunk.byteStart, to - chunk.byteStart), from - byteStart);
    filled += to - from;
  }
  if (filled !== out.length) throw corruption('record chunk ranges do not cover the request');
  return out;
}

// ------------------------------------------------------------------------------ writer

/**
 * A single-record writer. Construct it off, `arm()` it to create metadata, then
 * `append()` complete device bytes as they arrive. Append writes chunks off the
 * caller's critical path: await it from the recording queue, never from acquisition.
 */
export class OpfsRecordWriter {
  private readonly storage: RecordStorage;
  private readonly profileValue: RecordProfile;
  private readonly maxBytesValue: number;
  private readonly maxChunkBytesValue: number;
  private readonly clock: () => number;
  private stateValue: RecordState = 'off';
  private statusValue: RecordManifestStatus = 'open';
  private startedAtValue = 0;
  private chunkList: RecordChunkInfo[] = [];
  private gapList: RecordGap[] = [];
  private byteCount = 0;
  private nextIndex = 0;
  private lastTimeEnd: number | null = null;
  private inFlightExport: Promise<RecordExport> | null = null;

  constructor(storage: RecordStorage, options: RecordOptions) {
    this.storage = storage;
    this.profileValue = normalizeProfile(options.profile);
    const maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0 ||
        maxChunkBytes > 0xffffffff) {
      throw configError('record maxChunkBytes must be a positive 32-bit integer');
    }
    this.maxChunkBytesValue = maxChunkBytes;
    const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    if (maxBytes !== Number.POSITIVE_INFINITY &&
        (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
      throw configError('record maxBytes must be a positive integer or Infinity');
    }
    this.maxBytesValue = maxBytes;
    this.clock = options.clock ?? (() => Date.now());
  }

  get state(): RecordState {
    return this.stateValue;
  }

  /** Bytes accepted into committed chunks so far. */
  get bytes(): number {
    return this.byteCount;
  }

  get chunkCount(): number {
    return this.chunkList.length;
  }

  /** Snapshot of what is durable (or about to be persisted). */
  get manifest(): RecordManifest {
    return this.snapshot();
  }

  private snapshot(): RecordManifest {
    return {
      version: RECORD_FORMAT_VERSION,
      status: this.statusValue,
      profile: { ...this.profileValue },
      startedAt: this.startedAtValue,
      bytes: this.byteCount,
      gaps: this.gapList.map((gap) => ({ ...gap })),
      chunks: this.chunkList.map((chunk) => ({ ...chunk })),
    };
  }

  private requireWritable(action: string): void {
    if (this.stateValue !== 'armed' && this.stateValue !== 'recording') {
      throw new RecordError('state', `cannot ${action} while record state is '${this.stateValue}'`);
    }
  }

  /** Create the record metadata. Refuses a root that already holds record files. */
  async arm(): Promise<void> {
    if (this.stateValue !== 'off') {
      throw new RecordError('state', `cannot arm while record state is '${this.stateValue}'`);
    }
    const paths = await listRoot(this.storage);
    const existing = paths.find(isRecordArtifact);
    if (existing !== undefined) {
      throw new RecordError(
        'state',
        `record root already contains '${existing}'; recover or remove it before arming`,
      );
    }
    const startedAt = this.clock();
    if (!Number.isFinite(startedAt)) throw configError('record clock returned a non-finite time');
    this.startedAtValue = startedAt;
    try {
      const meta: RecordMeta = {
        version: RECORD_FORMAT_VERSION,
        profile: this.profileValue,
        startedAt,
      };
      await writeFileAtomic(this.storage, META_PATH, encodeEnvelope(META_MAGIC, meta));
      await this.persistManifest();
    } catch (error) {
      this.stateValue = 'error';
      throw mapStorageError(error);
    }
    this.stateValue = 'armed';
  }

  /**
   * Append complete bytes. The data is split into bounded chunks; each chunk commits by
   * rename before the next one starts. The manifest is persisted after the whole append,
   * so a crash mid-append leaves valid chunks that `recover()` re-indexes.
   */
  async append(
    data: Uint8Array,
    time?: RecordTimeRange,
  ): Promise<readonly RecordChunkInfo[]> {
    this.requireWritable('append');
    if (data.length === 0) return [];
    if (!Number.isSafeInteger(this.byteCount + data.length)) {
      throw configError('record byte count would exceed 2^53');
    }
    if (time !== undefined) {
      validateTimeRange(time, 'append time');
      if (this.lastTimeEnd !== null && time.startSeconds < this.lastTimeEnd) {
        throw configError('record time ranges must be monotonic across appends');
      }
    }
    if (this.byteCount + data.length > this.maxBytesValue) {
      this.stateValue = 'full';
      throw new RecordError(
        'full',
        `record budget of ${this.maxBytesValue} bytes is exhausted ` +
        `(${this.byteCount} used, ${data.length} requested)`,
      );
    }

    const total = data.length;
    const written: RecordChunkInfo[] = [];
    let offset = 0;
    try {
      while (offset < total) {
        const length = Math.min(this.maxChunkBytesValue, total - offset);
        const byteStart = this.byteCount;
        let timeStart: number | null = null;
        let timeEnd: number | null = null;
        if (time !== undefined) {
          const span = time.endSeconds - time.startSeconds;
          // Pin the first start and final end to the caller's exact values. A
          // proportional split can round the last chunk's end one ULP above the
          // requested end; the next append is admitted against that exact end, and the
          // persisted manifest then fails its own monotonicity check on recovery.
          timeStart = offset === 0
            ? time.startSeconds
            : time.startSeconds + (span * offset) / total;
          timeEnd = offset + length === total
            ? time.endSeconds
            : time.startSeconds + (span * (offset + length)) / total;
        }
        const info = await this.writeChunk(
          this.nextIndex,
          byteStart,
          data.subarray(offset, offset + length),
          timeStart,
          timeEnd,
        );
        this.chunkList.push(info);
        this.byteCount = info.byteEnd;
        this.nextIndex++;
        written.push(info);
        offset += length;
      }
      if (time !== undefined) this.lastTimeEnd = time.endSeconds;
      await this.persistManifest();
    } catch (error) {
      const mapped = mapStorageError(error);
      if (mapped.code === 'io' || mapped.code === 'quota') this.stateValue = 'error';
      throw mapped;
    }
    if (this.stateValue === 'armed') this.stateValue = 'recording';
    return written;
  }

  private async writeChunk(
    index: number,
    byteStart: number,
    payload: Uint8Array,
    timeStart: number | null,
    timeEnd: number | null,
  ): Promise<RecordChunkInfo> {
    const path = recordChunkPath(index);
    const part = `${path}.part`;
    const checksum = recordCrc32(payload);
    const byteEnd = byteStart + payload.length;
    const header = encodeChunkHeader({
      index,
      dataLength: payload.length,
      byteStart,
      byteEnd,
      timeStart,
      timeEnd,
      payloadCrc: checksum,
    });
    let file: RecordFile | null = null;
    try {
      file = await this.storage.open(part, true);
      await file.truncate(0);
      await file.write(0, header);
      await file.write(CHUNK_HEADER_BYTES, payload);
      if (await file.size() !== CHUNK_HEADER_BYTES + payload.length) {
        throw new RecordError('io', `short write for ${path}`);
      }
      await file.close();
      file = null;
      await this.storage.rename(part, path);
    } catch (error) {
      if (file !== null) {
        try {
          await file.close();
        } catch {
          // Best effort: the part file is removed below.
        }
      }
      try {
        await this.storage.remove(part);
      } catch {
        // Best effort: a leftover `.part` is never visible as a chunk.
      }
      this.stateValue = 'error';
      throw mapStorageError(error);
    }
    return {
      index, path, byteStart, byteEnd, timeStart, timeEnd,
      bytes: payload.length, checksum,
    };
  }

  /** Record a discontinuity. Overlapping/adjacent spans with the same reason merge. */
  async noteGap(gap: RecordGap): Promise<void> {
    if (this.stateValue !== 'armed' && this.stateValue !== 'recording' &&
        this.stateValue !== 'paused') {
      throw new RecordError('state', `cannot note a gap while record state is '${this.stateValue}'`);
    }
    if (!Number.isFinite(gap.startSeconds) || !Number.isFinite(gap.endSeconds) ||
        gap.endSeconds <= gap.startSeconds) {
      throw configError('record gap must have a finite, non-empty range');
    }
    if (!GAP_REASONS.has(gap.reason)) throw configError(`unknown record gap reason '${gap.reason}'`);
    if (gap.group !== null && typeof gap.group !== 'string') {
      throw configError('record gap group must be a string or null');
    }
    this.insertGap({
      startSeconds: gap.startSeconds,
      endSeconds: gap.endSeconds,
      reason: gap.reason,
      group: gap.group,
    });
    try {
      await this.persistManifest();
    } catch (error) {
      this.stateValue = 'error';
      throw mapStorageError(error);
    }
  }

  private insertGap(gap: RecordGap): void {
    const sorted = [...this.gapList, gap].sort(
      (a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds,
    );
    const merged: RecordGap[] = [];
    for (const current of sorted) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.reason === current.reason &&
          last.group === current.group && current.startSeconds <= last.endSeconds) {
        merged[merged.length - 1] = {
          startSeconds: last.startSeconds,
          endSeconds: Math.max(last.endSeconds, current.endSeconds),
          reason: last.reason,
          group: last.group,
        };
      } else {
        merged.push(current);
      }
    }
    this.gapList = merged;
  }

  /** Stop accepting appends without finalizing the record. Idempotent. */
  async pause(): Promise<void> {
    if (this.stateValue === 'armed' || this.stateValue === 'recording') {
      this.stateValue = 'paused';
    }
  }

  /** Continue a paused record. Idempotent. */
  async resume(): Promise<void> {
    if (this.stateValue === 'paused') {
      this.stateValue = this.chunkList.length === 0 ? 'armed' : 'recording';
    }
  }

  /**
   * Finalize and close. Safe to call twice and while an export is running (it waits).
   * After close, `export()` still returns the archived bytes and manifest.
   */
  async close(): Promise<void> {
    if (this.stateValue === 'exporting' && this.inFlightExport !== null) {
      try {
        await this.inFlightExport;
      } catch {
        // The export already moved the writer to 'error'.
      }
    }
    if (this.stateValue === 'off') return;
    if (this.stateValue === 'error') {
      this.statusValue = 'closed';
      this.stateValue = 'off';
      return;
    }
    this.statusValue = 'closed';
    try {
      await this.persistManifest();
    } catch (error) {
      this.stateValue = 'error';
      throw mapStorageError(error);
    }
    this.stateValue = 'off';
  }

  /**
   * Read back every committed chunk, verify it, and return the bytes plus the manifest.
   * The writer keeps recording/its state afterwards; an export never mutates the archive.
   */
  async export(): Promise<RecordExport> {
    if (this.stateValue === 'exporting') {
      throw new RecordError('state', 'an export is already in progress');
    }
    if (this.stateValue === 'off' && this.startedAtValue === 0) {
      throw new RecordError('state', 'cannot export before the record is armed');
    }
    const resumeState = this.stateValue;
    this.stateValue = 'exporting';
    const manifest = this.snapshot();
    const operation = exportManifest(this.storage, manifest);
    this.inFlightExport = operation;
    try {
      const result = await operation;
      this.stateValue = resumeState;
      return result;
    } catch (error) {
      this.stateValue = 'error';
      throw mapStorageError(error);
    } finally {
      this.inFlightExport = null;
    }
  }

  private async persistManifest(): Promise<void> {
    try {
      await writeFileAtomic(
        this.storage,
        MANIFEST_PATH,
        encodeEnvelope(MANIFEST_MAGIC, this.snapshot()),
      );
    } catch (error) {
      throw mapStorageError(error);
    }
  }
}

function validateTimeRange(range: RecordTimeRange, label: string): void {
  if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds)) {
    throw configError(`${label} must be finite`);
  }
  if (range.endSeconds < range.startSeconds) {
    throw configError(`${label} end must not precede its start`);
  }
}

// ------------------------------------------------------------------------------ reader

/**
 * Reads/recover-verifies a record root. `recover()` rebuilds a stale or corrupt manifest
 * from the chunk headers and the metadata envelope; a torn tail is dropped rather than
 * making the whole record unreadable.
 */
export class OpfsRecordReader {
  private readonly storage: RecordStorage;

  constructor(storage: RecordStorage) {
    this.storage = storage;
  }

  async readManifest(): Promise<RecordManifest> {
    const paths = await listRoot(this.storage);
    if (!paths.includes(MANIFEST_PATH)) {
      throw new RecordError('io', `record root has no ${MANIFEST_PATH}`);
    }
    const bytes = await readWholeFile(this.storage, MANIFEST_PATH);
    return parseManifest(decodeEnvelope(bytes, MANIFEST_MAGIC, MANIFEST_PATH));
  }

  /** Scan the root, drop a torn tail/stale parts, and rebuild the manifest if needed. */
  async recover(): Promise<RecordRecovery> {
    const paths = await listRoot(this.storage);
    const stored = await this.tryReadManifest(paths);
    const meta = stored === null ? await this.tryReadMeta(paths) : null;

    const chunkNames = paths
      .map((path) => ({ path, index: parseChunkPath(path) }))
      .filter((entry): entry is { path: string; index: number } => entry.index !== null)
      .sort((a, b) => a.index - b.index);
    const partNames = paths.filter((path) => path.endsWith('.part'));
    if (stored === null && meta === null && chunkNames.length === 0) {
      throw new RecordError('io', 'record root contains no record to recover');
    }

    const chunks: RecordChunkInfo[] = [];
    const torn: string[] = [];
    let expectedByte = 0;
    let lastTimeEnd: number | null = null;
    for (let i = 0; i < chunkNames.length; i++) {
      const entry = chunkNames[i]!;
      if (entry.index !== i) {
        throw corruption(`record chunk '${entry.path}' is out of sequence`);
      }
      try {
        const read = await readChunkFile(this.storage, entry.path, entry.index);
        if (read.info.byteStart !== expectedByte) {
          throw corruption(
            `chunk '${entry.path}' starts at byte ${read.info.byteStart}, expected ${expectedByte}`,
          );
        }
        if (read.info.timeStart !== null && lastTimeEnd !== null &&
            read.info.timeStart < lastTimeEnd) {
          throw corruption(`chunk '${entry.path}' has an out-of-order time range`);
        }
        chunks.push(read.info);
        expectedByte = read.info.byteEnd;
        if (read.info.timeEnd !== null) lastTimeEnd = read.info.timeEnd;
      } catch (error) {
        const mapped = mapStorageError(error);
        const isLast = i === chunkNames.length - 1;
        if (isLast && mapped.code === 'corruption') {
          torn.push(entry.path);
          break;
        }
        throw mapped;
      }
    }

    const removedParts: string[] = [];
    for (const path of partNames) {
      try {
        await this.storage.remove(path);
      } catch (error) {
        throw mapStorageError(error);
      }
      removedParts.push(path);
    }
    for (const path of torn) {
      try {
        await this.storage.remove(path);
      } catch (error) {
        throw mapStorageError(error);
      }
    }

    let manifest: RecordManifest;
    let rebuilt = false;
    if (stored !== null && torn.length === 0 && stored.bytes === expectedByte &&
        stored.chunks.length === chunks.length &&
        stored.chunks.every((chunk, index) => sameChunk(chunk, chunks[index]!))) {
      manifest = stored;
    } else {
      const base: { readonly profile: RecordProfile; readonly startedAt: number } | null =
        stored ?? meta;
      if (base === null) {
        throw corruption('record metadata is unreadable and the chunks cannot be attributed');
      }
      manifest = {
        version: RECORD_FORMAT_VERSION,
        status: 'open',
        profile: base.profile,
        startedAt: base.startedAt,
        bytes: expectedByte,
        gaps: stored === null ? [] : stored.gaps.map((gap) => ({ ...gap })),
        chunks: chunks.map((chunk) => ({ ...chunk })),
      };
      await writeFileAtomic(
        this.storage,
        MANIFEST_PATH,
        encodeEnvelope(MANIFEST_MAGIC, manifest),
      );
      rebuilt = true;
    }
    return {
      manifest,
      recovered: rebuilt || torn.length > 0 || removedParts.length > 0,
      torn,
      removedParts,
      scannedChunks: chunks.length,
    };
  }

  private async tryReadManifest(paths: readonly string[]): Promise<RecordManifest | null> {
    if (!paths.includes(MANIFEST_PATH)) return null;
    const bytes = await readWholeFile(this.storage, MANIFEST_PATH);
    try {
      return parseManifest(decodeEnvelope(bytes, MANIFEST_MAGIC, MANIFEST_PATH));
    } catch (error) {
      if (error instanceof RecordError && error.code === 'corruption') return null;
      throw mapStorageError(error);
    }
  }

  private async tryReadMeta(paths: readonly string[]): Promise<RecordMeta | null> {
    if (!paths.includes(META_PATH)) return null;
    const bytes = await readWholeFile(this.storage, META_PATH);
    try {
      return parseMeta(decodeEnvelope(bytes, META_MAGIC, META_PATH));
    } catch (error) {
      if (error instanceof RecordError && error.code === 'corruption') return null;
      throw mapStorageError(error);
    }
  }

  /** Read and verify one committed chunk by index. */
  async readChunk(index: number): Promise<RecordChunkRead> {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw configError(`record chunk index ${index} is invalid`);
    }
    return readChunkFile(this.storage, recordChunkPath(index), index);
  }

  /** Read a verified byte range that may span chunks. */
  async readBytes(byteStart: number, byteEnd: number): Promise<Uint8Array> {
    const manifest = await this.readManifest();
    return readRange(this.storage, manifest, byteStart, byteEnd);
  }

  /** Read back every chunk and return the recorded bytes in order, plus the manifest. */
  async export(): Promise<RecordExport> {
    const manifest = await this.readManifest();
    return exportManifest(this.storage, manifest);
  }
}
