// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Deterministic self-test for the OPFS record core. No real OPFS, no timers.
 *
 * The storage adapter below is a synchronous-commit in-memory implementation of
 * `RecordStorage`; it can simulate a quota refusal part-way through a write, flip a byte,
 * truncate a committed chunk, or leave a `.part` behind, so every crash/recovery path is
 * exercised without a browser.
 *
 * Run:
 *   node_modules/.bin/esbuild src/data/opfsRecordSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/opfsrecord-selftest.mjs --log-level=error
 *   node /tmp/opfsrecord-selftest.mjs
 */

import {
  CHUNK_HEADER_BYTES,
  MANIFEST_PATH,
  META_PATH,
  OpfsRecordReader,
  OpfsRecordWriter,
  RecordError,
  recordChunkPath,
  recordCrc32,
  type RecordFile,
  type RecordManifest,
  type RecordProfile,
  type RecordStorage,
} from './opfsRecord.js';

// ------------------------------------------------------------- in-memory test adapter

class MemoryRecordFile implements RecordFile {
  private closed = false;

  constructor(
    private readonly storage: MemoryRecordStorage,
    private readonly path: string,
  ) {}

  private bytes(): Uint8Array {
    const bytes = this.storage.files.get(this.path);
    if (bytes === undefined) throw new Error(`ENOENT: ${this.path}`);
    return bytes;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`file is closed: ${this.path}`);
  }

  async size(): Promise<number> {
    this.assertOpen();
    return this.bytes().length;
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('bad write offset');
    const failure = this.storage.beginWrite();
    const allowed = failure === null ? data.length : Math.min(failure.afterBytes, data.length);
    if (allowed > 0) {
      const current = this.bytes();
      const end = offset + allowed;
      const next = new Uint8Array(Math.max(current.length, end));
      next.set(current);
      next.set(data.subarray(0, allowed), offset);
      this.storage.files.set(this.path, next);
    }
    if (failure !== null) throw failure.error;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0) {
      throw new Error('bad read range');
    }
    const bytes = this.bytes();
    if (offset + length > bytes.length) throw new Error('read past end of file');
    return bytes.slice(offset, offset + length);
  }

  async truncate(length: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('bad truncate length');
    const current = this.bytes();
    const next = new Uint8Array(length);
    next.set(current.subarray(0, Math.min(current.length, length)));
    this.storage.files.set(this.path, next);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface SimulatedFailure {
  readonly writesRemaining: number;
  readonly afterBytes: number;
  readonly error: unknown;
}

class MemoryRecordStorage implements RecordStorage {
  readonly files = new Map<string, Uint8Array>();
  private failure: SimulatedFailure | null = null;

  /** Fail (and optionally partially write) the Nth `write()` from now; 0 = the next one. */
  failAfterWrites(writesBeforeFailure: number, afterBytes = 0, name = 'QuotaExceededError'): void {
    const error = new Error(`simulated ${name}`);
    error.name = name;
    this.failure = { writesRemaining: writesBeforeFailure, afterBytes, error };
  }

  beginWrite(): { afterBytes: number; error: unknown } | null {
    if (this.failure === null) return null;
    if (this.failure.writesRemaining > 0) {
      this.failure = { ...this.failure, writesRemaining: this.failure.writesRemaining - 1 };
      return null;
    }
    const failure = this.failure;
    this.failure = null;
    return { afterBytes: failure.afterBytes, error: failure.error };
  }

  async open(path: string, create: boolean): Promise<RecordFile> {
    if (!this.files.has(path)) {
      if (!create) throw new Error(`ENOENT: ${path}`);
      this.files.set(path, new Uint8Array(0));
    }
    return new MemoryRecordFile(this, path);
  }

  async list(): Promise<readonly string[]> {
    return [...this.files.keys()];
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (bytes === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.delete(from);
    this.files.set(to, bytes);
  }

  committedChunks(): string[] {
    return [...this.files.keys()]
      .filter((path) => /^chunk-\d{8}\.lwc$/.test(path))
      .sort();
  }

  partPaths(): string[] {
    return [...this.files.keys()].filter((path) => path.endsWith('.part')).sort();
  }

  bytesOf(path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
    return bytes;
  }

  setBytes(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes.slice());
  }

  truncateFile(path: string, length: number): void {
    const bytes = this.bytesOf(path);
    const next = new Uint8Array(length);
    next.set(bytes.subarray(0, Math.min(bytes.length, length)));
    this.files.set(path, next);
  }

  flipByte(path: string, index: number): void {
    const bytes = this.bytesOf(path).slice();
    bytes[index] = bytes[index]! ^ 0xff;
    this.files.set(path, bytes);
  }
}

// ------------------------------------------------------------------------ test helpers

const PROFILE: RecordProfile = {
  profileId: 'slogic16u3',
  calibrationId: 'cal-2026-11',
  channels: 16,
  sampleRateHz: 1_000_000,
  bytesPerSample: 2,
};
const FIXED_TIME = 1_700_000_000_000;
const fixedClock = (): number => FIXED_TIME;

let checks = 0;
let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
  checks++;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` :: ${detail}`}`);
  }
}

async function expectRecordError(operation: () => Promise<unknown>): Promise<RecordError> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof RecordError) return error;
    throw new Error(`expected a RecordError, received ${String(error)}`);
  }
  throw new Error('expected a RecordError, but the operation succeeded');
}

function makeWriter(
  storage: RecordStorage,
  maxChunkBytes = 8,
  maxBytes = Number.POSITIVE_INFINITY,
): OpfsRecordWriter {
  return new OpfsRecordWriter(storage, {
    profile: PROFILE,
    maxChunkBytes,
    maxBytes,
    clock: fixedClock,
  });
}

function pattern(length: number, seed = 11): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 37 + seed) & 0xff;
  return bytes;
}

function equalBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function sameManifest(a: RecordManifest, b: RecordManifest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describeBytes(bytes: Uint8Array): string {
  return `length=${bytes.length}`;
}

// ----------------------------------------------------------------------------- tests

async function testArmAndManifest(): Promise<void> {
  console.log('\narm, metadata and the empty manifest');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage);
  check(
    'a new writer is off with zero bytes and no chunks',
    writer.state === 'off' && writer.bytes === 0 && writer.chunkCount === 0,
    `state=${writer.state} bytes=${writer.bytes}`,
  );

  const earlyAppend = await expectRecordError(() => writer.append(pattern(4)));
  check('append before arm refuses with a state error', earlyAppend.code === 'state');
  const earlyGap = await expectRecordError(
    () => writer.noteGap({ startSeconds: 0, endSeconds: 1, reason: 'dropout', group: null }),
  );
  check('noteGap before arm refuses with a state error', earlyGap.code === 'state');

  await writer.arm();
  check('arm moves off -> armed', writer.state === 'armed');
  check(
    'arm commits meta.json and manifest.json atomically',
    storage.files.has(META_PATH) && storage.files.has(MANIFEST_PATH) &&
      storage.partPaths().length === 0,
    storage.partPaths().join(','),
  );

  const reader = new OpfsRecordReader(storage);
  const manifest = await reader.readManifest();
  check('the empty manifest round-trips', sameManifest(manifest, writer.manifest));
  check(
    'the manifest carries profile and calibration metadata',
    manifest.profile.profileId === 'slogic16u3' &&
      manifest.profile.calibrationId === 'cal-2026-11' &&
      manifest.profile.channels === 16 &&
      manifest.profile.sampleRateHz === 1_000_000 &&
      manifest.profile.bytesPerSample === 2,
    JSON.stringify(manifest.profile),
  );
  check('startedAt comes from the injected clock, not a timer',
    manifest.startedAt === FIXED_TIME, String(manifest.startedAt));
  check('an armed empty record has no gaps and no chunks',
    manifest.gaps.length === 0 && manifest.chunks.length === 0 && manifest.bytes === 0);
  check('the empty export is zero bytes',
    (await writer.export()).bytes.length === 0);

  const secondArm = await expectRecordError(() => writer.arm());
  check('arming twice refuses with a state error', secondArm.code === 'state');

  await writer.close();
  check('close from armed leaves the writer off', writer.state === 'off');
  await writer.close();
  check('close is idempotent', writer.state === 'off');

  const reused = makeWriter(storage);
  const reuseError = await expectRecordError(() => reused.arm());
  check('arming a root that already holds a record refuses', reuseError.code === 'state',
    reuseError.message);
}

async function testContiguousTimeChunks(): Promise<void> {
  console.log('\ncontiguous large appends keep manifest time order');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 4 * 1024 * 1024);
  await writer.arm();
  const first = new Uint8Array(3 * 1024 * 1024);
  const second = new Uint8Array(3 * 1024 * 1024);
  first.fill(0xa5);
  second.fill(0x5a);
  await writer.append(first, { startSeconds: 0, endSeconds: 0.1 });
  await writer.append(second, { startSeconds: 0.1, endSeconds: 0.2 });
  check(
    'the last chunk ends exactly at the caller end, not an ULP above',
    writer.manifest.chunks.at(-1)!.timeEnd === 0.2,
    String(writer.manifest.chunks.at(-1)!.timeEnd),
  );
  const reader = new OpfsRecordReader(storage);
  let manifestOk = false;
  try {
    manifestOk = sameManifest(await reader.readManifest(), writer.manifest);
  } catch {
    manifestOk = false;
  }
  check('the persisted manifest parses after two contiguous large appends', manifestOk);

  const recovered = await reader.recover();
  check(
    'recovery keeps every committed chunk of the contiguous record',
    recovered.torn.length === 0 && recovered.scannedChunks === writer.chunkCount &&
      recovered.manifest.bytes === 6 * 1024 * 1024,
    `torn=${recovered.torn.join(',')} chunks=${recovered.scannedChunks} ` +
      `bytes=${recovered.manifest.bytes}`,
  );
  const exported = await reader.export();
  check(
    'export returns both large chunks byte for byte',
    equalBytes(exported.bytes.subarray(0, first.length), first) &&
      equalBytes(exported.bytes.subarray(first.length), second),
    `bytes=${exported.bytes.length}`,
  );
}

async function testRoundTrip(): Promise<void> {
  console.log('\nchunk round-trip, byte/time ranges and export equality');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 8);
  await writer.arm();
  const source = pattern(60);

  const empty = await writer.append(new Uint8Array(0));
  check('an empty append is a no-op', empty.length === 0 && writer.state === 'armed');

  const first = await writer.append(source.subarray(0, 10), { startSeconds: 0, endSeconds: 10 });
  const second = await writer.append(source.subarray(10, 25), { startSeconds: 10, endSeconds: 25 });
  const third = await writer.append(source.subarray(25, 60));
  check('bounded chunks split 10 bytes as 8+2', first.length === 2,
    first.map((chunk) => chunk.bytes).join(','));
  check('bounded chunks split 15 bytes as 8+7', second.length === 2,
    second.map((chunk) => chunk.bytes).join(','));
  check('bounded chunks split 35 bytes as 8+8+8+8+3', third.length === 5,
    third.map((chunk) => chunk.bytes).join(','));
  check('the writer is recording after data arrives', writer.state === 'recording');

  const manifest = writer.manifest;
  check('the manifest counts every byte and chunk',
    manifest.bytes === 60 && manifest.chunks.length === 9 && writer.chunkCount === 9,
    `bytes=${manifest.bytes} chunks=${manifest.chunks.length}`);
  let contiguous = true;
  let expectedByte = 0;
  for (const chunk of manifest.chunks) {
    if (chunk.byteStart !== expectedByte || chunk.byteEnd !== chunk.byteStart + chunk.bytes) {
      contiguous = false;
    }
    expectedByte = chunk.byteEnd;
  }
  check('chunk byte ranges are contiguous from 0', contiguous && expectedByte === 60);
  check(
    'time ranges are divided proportionally inside one append',
    manifest.chunks[0]!.timeStart === 0 && manifest.chunks[0]!.timeEnd === 8 &&
      manifest.chunks[1]!.timeStart === 8 && manifest.chunks[1]!.timeEnd === 10 &&
      manifest.chunks[2]!.timeStart === 10 && manifest.chunks[2]!.timeEnd === 18 &&
      manifest.chunks[3]!.timeStart === 18 && manifest.chunks[3]!.timeEnd === 25,
    JSON.stringify(manifest.chunks.slice(0, 4).map((chunk) => [chunk.timeStart, chunk.timeEnd])),
  );
  check('an append without time metadata records null ranges',
    manifest.chunks.slice(4).every((chunk) => chunk.timeStart === null && chunk.timeEnd === null));
  check('each chunk checksum covers exactly its payload',
    manifest.chunks.every((chunk) =>
      chunk.checksum === recordCrc32(source.subarray(chunk.byteStart, chunk.byteEnd))));

  const reader = new OpfsRecordReader(storage);
  const stored = await reader.readManifest();
  check('the written manifest round-trips byte for byte',
    sameManifest(stored, manifest),
    `${JSON.stringify(stored).slice(0, 80)} vs ${JSON.stringify(manifest).slice(0, 80)}`);

  let chunksMatch = true;
  for (const chunk of manifest.chunks) {
    const read = await reader.readChunk(chunk.index);
    if (!equalBytes(read.bytes, source.subarray(chunk.byteStart, chunk.byteEnd))) {
      chunksMatch = false;
    }
    if (read.info.checksum !== chunk.checksum || read.info.timeStart !== chunk.timeStart) {
      chunksMatch = false;
    }
  }
  check('every chunk reads back with its payload and header metadata', chunksMatch);

  const middle = await reader.readBytes(3, 27);
  check('a byte range crossing chunks reads back exactly',
    equalBytes(middle, source.subarray(3, 27)), describeBytes(middle));
  const wholeRange = await reader.readBytes(0, 60);
  check('a range covering the whole record reads back exactly',
    equalBytes(wholeRange, source));

  const badRange = await expectRecordError(() => reader.readBytes(0, 61));
  check('a byte range past the record is a config error', badRange.code === 'config');

  const liveExport = writer.export();
  check('export exposes the exporting state while it runs', writer.state === 'exporting');
  const exported = await liveExport;
  check('export returns to the previous state', writer.state === 'recording',
    writer.state);
  check('writer export bytes equal the appended bytes',
    equalBytes(exported.bytes, source) && exported.manifest.bytes === 60);
  check('the exported manifest is the live manifest',
    sameManifest(exported.manifest, manifest));

  const readerExport = await reader.export();
  check('reader export bytes equal the appended bytes',
    equalBytes(readerExport.bytes, source) && readerExport.manifest.bytes === 60);

  await writer.close();
  check('close marks the manifest closed',
    writer.state === 'off' && writer.manifest.status === 'closed');
  const afterClose = await writer.export();
  check('export still works after close', equalBytes(afterClose.bytes, source));
  check('the closed manifest round-trips', sameManifest(await reader.readManifest(), afterClose.manifest));
}

async function testPauseResume(): Promise<void> {
  console.log('\npause, resume and close idempotence');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 8);
  await writer.arm();

  await writer.pause();
  check('pause from armed is paused', writer.state === 'paused');
  await writer.pause();
  check('pause is idempotent', writer.state === 'paused');
  await writer.resume();
  check('resume with no data returns to armed', writer.state === 'armed');
  await writer.resume();
  check('resume is idempotent', writer.state === 'armed');

  await writer.append(pattern(5));
  check('append after resume records', writer.state === 'recording' && writer.bytes === 5);
  await writer.pause();
  const pausedAppend = await expectRecordError(() => writer.append(pattern(1)));
  check('append while paused refuses with a state error', pausedAppend.code === 'state');
  check('the refused append wrote nothing', writer.bytes === 5 && writer.chunkCount === 1);

  await writer.resume();
  check('resume returns to recording', writer.state === 'recording');
  await writer.append(pattern(3));
  check('appending after resume continues the stream',
    writer.bytes === 8 && writer.chunkCount === 2);

  await writer.close();
  check('close leaves the writer off', writer.state === 'off');
  await writer.close();
  check('close twice is harmless', writer.state === 'off');
  const closedAppend = await expectRecordError(() => writer.append(pattern(1)));
  check('append after close refuses with a state error', closedAppend.code === 'state');

  const exported = await writer.export();
  const expected = new Uint8Array([...pattern(5), ...pattern(3)]);
  check('bytes appended before and after pause export in order',
    equalBytes(exported.bytes, expected));
}

async function testGaps(): Promise<void> {
  console.log('\ngap metadata');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 8);
  await writer.arm();
  await writer.noteGap({ startSeconds: 1, endSeconds: 2, reason: 'dropout', group: 'digital' });
  await writer.noteGap({ startSeconds: 2, endSeconds: 3, reason: 'dropout', group: 'digital' });
  await writer.noteGap({ startSeconds: 5, endSeconds: 6, reason: 'record-gap', group: null });
  await writer.append(pattern(4), { startSeconds: 10, endSeconds: 14 });

  const manifest = await new OpfsRecordReader(storage).readManifest();
  check('adjacent gaps with the same reason and group merge',
    manifest.gaps.length === 2 && manifest.gaps[0]!.startSeconds === 1 &&
      manifest.gaps[0]!.endSeconds === 3,
    JSON.stringify(manifest.gaps));
  check('gap reasons and group scopes round-trip',
    manifest.gaps[0]!.reason === 'dropout' && manifest.gaps[0]!.group === 'digital' &&
      manifest.gaps[1]!.reason === 'record-gap' && manifest.gaps[1]!.group === null);
  check('gaps survive in the writer snapshot too',
    sameManifest(writer.manifest, manifest));

  const emptyGap = await expectRecordError(
    () => writer.noteGap({ startSeconds: 4, endSeconds: 4, reason: 'dropout', group: null }),
  );
  check('an empty gap range is a config error', emptyGap.code === 'config');
  const badReason = await expectRecordError(
    () => writer.noteGap({ startSeconds: 4, endSeconds: 5, reason: 'bogus' as never, group: null }),
  );
  check('an unknown gap reason is a config error', badReason.code === 'config');

  const monotonic = await expectRecordError(
    () => writer.append(pattern(2), { startSeconds: 13, endSeconds: 15 }),
  );
  check('time ranges must not move backwards across appends', monotonic.code === 'config');
}

async function testFullBudget(): Promise<void> {
  console.log('\nrecord budget refusal');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 8, 16);
  await writer.arm();
  await writer.append(pattern(12));
  check('an append inside the budget is accepted', writer.bytes === 12 && writer.chunkCount === 2);
  const committedBefore = storage.committedChunks().length;

  const error = await expectRecordError(() => writer.append(pattern(8)));
  check('an append past maxBytes is a typed full error', error.code === 'full', error.message);
  check('the writer reports the full state', writer.state === 'full', writer.state);
  check('a refused append changes neither bytes nor chunks',
    writer.bytes === 12 && writer.chunkCount === 2 &&
      storage.committedChunks().length === committedBefore,
    `bytes=${writer.bytes} chunks=${writer.chunkCount} files=${storage.committedChunks().length}`);
  check('a refused append leaves no visible chunk or part',
    storage.partPaths().length === 0);

  const exported = await writer.export();
  check('a full record still exports its recorded prefix',
    equalBytes(exported.bytes, pattern(12)));
  await writer.close();
  check('close from full is safe', writer.state === 'off');
}

async function testStorageFailures(): Promise<void> {
  console.log('\nquota, IO failure and half-written chunks');
  {
    const storage = new MemoryRecordStorage();
    const writer = makeWriter(storage, 16);
    await writer.arm();
    storage.failAfterWrites(0, 10);
    const error = await expectRecordError(() => writer.append(pattern(16)));
    check('a storage quota refusal is typed quota', error.code === 'quota', error.message);
    check('a quota refusal marks the record error', writer.state === 'error');
    check('a failed first chunk is never committed', storage.committedChunks().length === 0,
      storage.committedChunks().join(','));
    check('a failed first chunk leaves no .part visible', storage.partPaths().length === 0,
      storage.partPaths().join(','));
    await writer.close();
    check('close after a quota error leaves the writer off', writer.state === 'off');
  }
  {
    const storage = new MemoryRecordStorage();
    const writer = makeWriter(storage, 8);
    await writer.arm();
    // Chunk 0 writes its header and payload (2 writes), then chunk 1's header fails.
    storage.failAfterWrites(2, 4);
    const error = await expectRecordError(() => writer.append(pattern(24)));
    check('a quota failure after one complete chunk is cached as quota',
      error.code === 'quota');
    check('the completed chunk survives the later failure',
      writer.bytes === 8 && writer.chunkCount === 1 &&
        storage.committedChunks().length === 1,
      `bytes=${writer.bytes} chunks=${storage.committedChunks().length}`);
    check('the failed chunk leaves no committed file or part',
      storage.partPaths().length === 0 && storage.committedChunks().length === 1);

    const reader = new OpfsRecordReader(storage);
    const recovery = await reader.recover();
    check('recovery rebuilds a manifest around the completed chunk',
      recovery.recovered && recovery.manifest.chunks.length === 1 &&
        recovery.manifest.bytes === 8,
      `chunks=${recovery.manifest.chunks.length} bytes=${recovery.manifest.bytes}`);
    check('the rebuilt record exports the completed chunk',
      equalBytes((await reader.export()).bytes, pattern(8)));
  }
  {
    const storage = new MemoryRecordStorage();
    const writer = makeWriter(storage, 16);
    await writer.arm();
    storage.failAfterWrites(0, 0, 'Error');
    const error = await expectRecordError(() => writer.append(pattern(16)));
    check('a non-quota storage failure is typed io', error.code === 'io', error.message);
    check('an IO failure marks the record error', writer.state === 'error');
  }
}

async function testTornTail(): Promise<void> {
  console.log('\ntorn-tail recovery and stale temp files');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 4);
  const source = pattern(12);
  await writer.arm();
  await writer.append(source, { startSeconds: 100, endSeconds: 112 });
  await writer.close();
  const chunks = storage.committedChunks();
  check('the record has three committed chunks', chunks.length === 3, chunks.join(','));
  const lastPath = chunks[2]!;
  storage.truncateFile(lastPath, CHUNK_HEADER_BYTES + 2);
  const stalePart = `${recordChunkPath(9)}.part`;
  storage.setBytes(stalePart, pattern(5));

  const reader = new OpfsRecordReader(storage);
  const recovery = await reader.recover();
  check('recovery drops a truncated trailing chunk', recovery.torn.length === 1 &&
    recovery.torn[0] === lastPath, recovery.torn.join(','));
  check('recovery removes stale .part files', recovery.removedParts.length === 1 &&
    recovery.removedParts[0] === stalePart, recovery.removedParts.join(','));
  check('the valid prefix is kept', recovery.manifest.chunks.length === 2 &&
    recovery.manifest.bytes === 8 && recovery.scannedChunks === 2,
    `chunks=${recovery.manifest.chunks.length} bytes=${recovery.manifest.bytes}`);
  check('recovery reports that it repaired the record', recovery.recovered);
  check('the torn chunk and part are gone from the root',
    !storage.files.has(lastPath) && !storage.files.has(stalePart));
  check('the recovered prefix exports its bytes',
    equalBytes((await reader.export()).bytes, source.subarray(0, 8)));

  const again = await reader.recover();
  check('a second recovery is a clean no-op', !again.recovered &&
    again.torn.length === 0 && again.removedParts.length === 0 &&
    again.manifest.chunks.length === 2);
}

async function testStaleManifestRecovery(): Promise<void> {
  console.log('\nmanifest rebuild from chunks and metadata');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 100);
  await writer.arm();
  await writer.append(pattern(5));
  const staleManifest = storage.bytesOf(MANIFEST_PATH).slice();
  await writer.append(pattern(5, 99));
  const currentChunks = storage.committedChunks();
  check('two appends produced two chunks', currentChunks.length === 2);

  storage.setBytes(MANIFEST_PATH, staleManifest);
  const reader = new OpfsRecordReader(storage);
  const staleRecovery = await reader.recover();
  check('a manifest that misses a committed chunk is rebuilt',
    staleRecovery.recovered && staleRecovery.manifest.chunks.length === 2 &&
      staleRecovery.manifest.bytes === 10,
    `recovered=${staleRecovery.recovered} chunks=${staleRecovery.manifest.chunks.length}`);
  check('the rebuilt manifest is readable afterwards',
    (await reader.readManifest()).chunks.length === 2);

  const broken = storage.bytesOf(MANIFEST_PATH).slice();
  broken[20] = broken[20]! ^ 0xff;
  storage.setBytes(MANIFEST_PATH, broken);
  const corruptRecovery = await reader.recover();
  check('a corrupt manifest is rebuilt from meta.json and the chunks',
    corruptRecovery.recovered && corruptRecovery.manifest.chunks.length === 2 &&
      corruptRecovery.manifest.profile.profileId === PROFILE.profileId,
    `recovered=${corruptRecovery.recovered} chunks=${corruptRecovery.manifest.chunks.length}`);

  storage.files.delete(META_PATH);
  storage.setBytes(MANIFEST_PATH, broken);
  const unreadable = await expectRecordError(() => reader.recover());
  check('unreadable manifest plus missing metadata is a corruption error',
    unreadable.code === 'corruption', unreadable.message);
}

async function testCorruptionDetection(): Promise<void> {
  console.log('\nchecksum corruption detection');
  {
    const storage = new MemoryRecordStorage();
    const writer = makeWriter(storage, 4);
    await writer.arm();
    await writer.append(pattern(12));
    await writer.close();
    const chunks = storage.committedChunks();
    storage.flipByte(chunks[0]!, CHUNK_HEADER_BYTES + 1);
    const reader = new OpfsRecordReader(storage);
    const chunkError = await expectRecordError(() => reader.readChunk(0));
    check('a flipped payload byte is a corruption error', chunkError.code === 'corruption',
      chunkError.message);
    const exportError = await expectRecordError(() => reader.export());
    check('export refuses a corrupt chunk with corruption', exportError.code === 'corruption');
    const recoverError = await expectRecordError(() => reader.recover());
    check('corruption in a non-trailing chunk is not tolerated',
      recoverError.code === 'corruption', recoverError.message);
  }
  {
    const storage = new MemoryRecordStorage();
    const writer = makeWriter(storage, 4);
    await writer.arm();
    await writer.append(pattern(12));
    await writer.close();
    const chunks = storage.committedChunks();
    storage.flipByte(chunks[2]!, CHUNK_HEADER_BYTES + 2);
    const recovery = await new OpfsRecordReader(storage).recover();
    check('a corrupt final chunk is treated as a torn tail',
      recovery.torn.length === 1 && recovery.manifest.chunks.length === 2,
      `torn=${recovery.torn.join(',')} chunks=${recovery.manifest.chunks.length}`);
  }
  {
    const storage = new MemoryRecordStorage();
    const writer = makeWriter(storage, 4);
    await writer.arm();
    await writer.append(pattern(12));
    await writer.close();
    const chunks = storage.committedChunks();
    storage.flipByte(chunks[0]!, 13); // header index byte
    const headerError = await expectRecordError(() => new OpfsRecordReader(storage).readChunk(0));
    check('a corrupted chunk header is a corruption error', headerError.code === 'corruption',
      headerError.message);
  }
}

async function testArgumentValidation(): Promise<void> {
  console.log('\nargument validation');
  const storage = new MemoryRecordStorage();
  const writer = makeWriter(storage, 8);
  await writer.arm();
  const negative = await expectRecordError(
    () => writer.append(pattern(2), { startSeconds: 5, endSeconds: 1 }),
  );
  check('an inverted time range is a config error', negative.code === 'config');

  const reader = new OpfsRecordReader(storage);
  const badIndex = await expectRecordError(() => reader.readChunk(-1));
  check('a negative chunk index is a config error', badIndex.code === 'config');

  const badProfile = await expectRecordError(async () => {
    new OpfsRecordWriter(storage, {
      profile: { ...PROFILE, channels: 0 },
      clock: fixedClock,
    });
  });
  check('an invalid profile is a config error', badProfile.code === 'config');

  const badChunkSize = await expectRecordError(async () => {
    new OpfsRecordWriter(storage, {
      profile: PROFILE,
      maxChunkBytes: 0,
      clock: fixedClock,
    });
  });
  check('an invalid chunk bound is a config error', badChunkSize.code === 'config');
}

async function main(): Promise<void> {
  console.log('OPFS record core self-test');
  await testArmAndManifest();
  await testRoundTrip();
  await testContiguousTimeChunks();
  await testPauseResume();
  await testGaps();
  await testFullBudget();
  await testStorageFailures();
  await testTornTail();
  await testStaleManifestRecovery();
  await testCorruptionDetection();
  await testArgumentValidation();
}

main().then(() => {
  console.log('');
  if (failures > 0) {
    console.error(`FAILED ${failures} of ${checks} checks`);
    exitOne();
    return;
  }
  console.log(`PASS all ${checks} checks`);
}).catch((error: unknown) => {
  console.error('FAIL opfs record selftest crashed:', error);
  exitOne();
});

interface NodeProcess {
  exit?: (code?: number) => never;
  exitCode?: number;
}

function exitOne(): void {
  const proc = (globalThis as { process?: NodeProcess }).process;
  if (proc?.exit !== undefined) {
    proc.exit(1);
    return;
  }
  if (proc !== undefined) {
    proc.exitCode = 1;
    return;
  }
  throw new Error('OPFS record self-test failed and there is no process to exit');
}
