// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Deterministic self-test for the OPFS record controller and its SignalStore
 * integration. No real OPFS, no timers: `MemoryRecordStorage` commits synchronously in
 * microtasks and can gate writes, fail a write with a quota-shaped error, or leave a
 * torn chunk / stale `.part` for the recovery path.
 *
 *   node_modules/.bin/esbuild src/data/recordControllerSelftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/recordcontroller-selftest.mjs \
 *     --log-level=error
 *   node /tmp/recordcontroller-selftest.mjs
 */

import {
  META_PATH,
  MANIFEST_PATH,
  OpfsRecordController,
  RecordArchive,
  RecordError,
  recordChunkPath,
  type RecordFile,
  type RecordProfile,
  type RecordStorage,
} from './recordController.js';
import {
  UnsupportedRecordController,
  createDigitalSignalStore,
  type DigitalSignalStore,
} from './signalStore.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';

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
    await this.storage.awaitWriteGate();
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
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;

  /** Fail (and optionally partially write) the Nth `write()` from now; 0 = the next. */
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

  /** Hold every subsequent `write()` until `releaseWrites()` (proves non-blocking). */
  blockWrites(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseWrites(): void {
    const release = this.release;
    this.gate = null;
    this.release = null;
    release?.();
  }

  async awaitWriteGate(): Promise<void> {
    const gate = this.gate;
    if (gate !== null) await gate;
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

  setBytes(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes.slice());
  }

  truncateFile(path: string, length: number): void {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
    const next = new Uint8Array(length);
    next.set(bytes.subarray(0, Math.min(bytes.length, length)));
    this.files.set(path, next);
  }
}

// ------------------------------------------------------------------------ test helpers

const RATE = 1_000_000;
const FIXED_TIME = 1_700_000_000_000;

function profileFor(channels: number, rateHz = RATE): RecordProfile {
  return {
    profileId: `test-${channels}`,
    calibrationId: null,
    channels,
    sampleRateHz: rateHz,
    bytesPerSample: bytesPerSampleForChannels(channels),
  };
}

function pattern(length: number, seed = 11): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 37 + seed) & 0xff;
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function equalBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

function range(startSamples: number, endSamples: number): { startSeconds: number; endSeconds: number } {
  return { startSeconds: startSamples / RATE, endSeconds: endSamples / RATE };
}

/** Device-order bytes for integer sample words, one bit per channel. */
function encodeWords(words: readonly number[], channels: number): Uint8Array {
  const bytesPerSample = bytesPerSampleForChannels(channels);
  const out = new Uint8Array(words.length * bytesPerSample);
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    for (let b = 0; b < bytesPerSample; b++) {
      out[i * bytesPerSample + b] = word & 0xff;
      word = Math.floor(word / 256);
    }
  }
  return out;
}

function thrown(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

function makeController(storage: RecordStorage, maxChunkBytes = 8): OpfsRecordController {
  return new OpfsRecordController(storage, {
    profile: profileFor(4),
    maxChunkBytes,
    clock: () => FIXED_TIME,
  });
}

async function armAndSettle(controller: OpfsRecordController): Promise<void> {
  controller.arm();
  await controller.whenIdle();
}

export interface RecordControllerTestResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

type Check = (name: string, pass: boolean, detail?: string) => void;

// ------------------------------------------------------------------------------ tests

async function testArmContract(check: Check): Promise<void> {
  const storage = new MemoryRecordStorage();
  const controller = makeController(storage);
  check(
    'a new controller is off with no bytes, backlog or error',
    controller.state === 'off' && controller.bytes === 0 &&
      controller.queuedBytes === 0 && controller.lastError === null,
    `state=${controller.state}`,
  );

  controller.capture(pattern(4), range(0, 4));
  check('capture before arm is ignored', controller.queuedBytes === 0);

  storage.blockWrites();
  controller.arm();
  check('arm() reports armed synchronously, before storage finishes',
    controller.state === 'armed', `state=${controller.state}`);

  const secondArm = thrown(() => controller.arm());
  check('arming twice is a synchronous state refusal',
    secondArm instanceof RecordError && secondArm.code === 'state',
    secondArm instanceof Error ? secondArm.message : String(secondArm));

  storage.releaseWrites();
  await controller.whenIdle();
  check(
    'the queued arm commits meta.json and manifest.json atomically',
    storage.files.has(META_PATH) && storage.files.has(MANIFEST_PATH) &&
      storage.partPaths().length === 0,
    storage.partPaths().join(','),
  );
  check(
    'a successful async arm leaves the controller armed with no bytes',
    controller.state === 'armed' && controller.bytes === 0,
    `state=${controller.state}`,
  );

  await controller.close();
  check('close from armed leaves the controller off', controller.state === 'off');
  await controller.close();
  check('close is idempotent', controller.state === 'off');

  const reuse = thrown(() => controller.arm());
  check('one controller cannot re-arm after close',
    reuse instanceof RecordError && reuse.code === 'state',
    reuse instanceof Error ? reuse.message : String(reuse));
}

async function testCaptureAndExport(check: Check): Promise<void> {
  const storage = new MemoryRecordStorage();
  const controller = makeController(storage);
  await armAndSettle(controller);

  const first = pattern(8, 1);
  const second = pattern(6, 2);
  controller.capture(first, range(0, 8));
  controller.capture(second, range(8, 14));
  check(
    'captures are queued synchronously without waiting for storage',
    controller.queuedBytes === 14,
    `queued=${controller.queuedBytes}`,
  );

  await controller.whenIdle();
  check(
    'draining the queue commits every chunk and reports recording',
    controller.state === 'recording' && controller.bytes === 14 &&
      controller.queuedBytes === 0,
    `state=${controller.state} bytes=${controller.bytes}`,
  );

  const exported = await controller.exportArchive();
  check(
    'export returns the captured bytes in order',
    equalBytes(exported.bytes, concat(first, second)),
    `length=${exported.bytes.length}`,
  );
  check(
    'the manifest lists bounded chunks with the profile and clock',
    exported.manifest.chunks.length === 2 &&
      exported.manifest.chunks.every((chunk) => chunk.bytes <= 8) &&
      exported.manifest.profile.profileId === 'test-4' &&
      exported.manifest.startedAt === FIXED_TIME &&
      exported.manifest.bytes === 14,
    JSON.stringify(exported.manifest.chunks),
  );

  await controller.export();
  check(
    'the contract export() resolves, keeps recording and retains the result',
    controller.state === 'recording' && controller.lastExport !== null &&
      controller.lastExport.bytes.length === 14,
    `state=${controller.state}`,
  );

  await controller.close();
  const afterClose = await controller.exportArchive();
  check(
    'export still works after close and never mutates the archive',
    controller.state === 'off' && equalBytes(afterClose.bytes, concat(first, second)),
    `state=${controller.state}`,
  );
}

async function testPauseResumeClose(check: Check): Promise<void> {
  const storage = new MemoryRecordStorage();
  const controller = makeController(storage);
  await armAndSettle(controller);

  const first = pattern(4, 1);
  const second = pattern(4, 2);
  const third = pattern(4, 3);
  controller.capture(first, range(0, 4));
  await controller.pause();
  check(
    'pause drains queued captures before reporting paused',
    controller.state === 'paused' && controller.bytes === first.length,
    `state=${controller.state} bytes=${controller.bytes}`,
  );

  controller.capture(second, range(4, 8));
  await controller.whenIdle();
  check('captures while paused are ignored',
    controller.bytes === first.length && controller.queuedBytes === 0);

  await controller.resume();
  check('resume returns a non-empty record to recording',
    controller.state === 'recording', `state=${controller.state}`);
  controller.capture(third, range(4, 8));
  await controller.whenIdle();
  check('recording continues after resume', controller.bytes === first.length + third.length);

  await controller.close();
  check('close finalizes and leaves the controller off',
    controller.state === 'off' && controller.bytes === first.length + third.length);
  controller.capture(pattern(4), range(0, 4));
  await controller.whenIdle();
  check('captures after close are ignored', controller.bytes === first.length + third.length);

  const empty = makeController(new MemoryRecordStorage());
  await armAndSettle(empty);
  await empty.pause();
  await empty.resume();
  check('resume of an empty record returns to armed', empty.state === 'armed',
    `state=${empty.state}`);
  await empty.close();
}

async function testErrorAndFull(check: Check): Promise<void> {
  // Arm failure: arm() must not throw, and the error must be readable.
  const armStorage = new MemoryRecordStorage();
  armStorage.failAfterWrites(0);
  const armController = makeController(armStorage);
  let armThrew = false;
  try {
    armController.arm();
  } catch {
    armThrew = true;
  }
  check('arm() does not throw when its storage work will fail', !armThrew);
  await armController.whenIdle();
  check(
    'a failed arm surfaces as error state plus a readable lastError',
    armController.state === 'error' && armController.lastError !== null &&
      armController.lastError.includes('quota'),
    `state=${armController.state} lastError=${String(armController.lastError)}`,
  );
  armController.capture(pattern(4), range(0, 4));
  await armController.whenIdle();
  check('captures after an arm failure are ignored and never throw',
    armController.state === 'error' && armController.bytes === 0);
  await armController.close();
  check('close recovers an errored controller to off',
    armController.state === 'off', `state=${armController.state}`);

  // Append failure after a successful arm: the committed prefix stays exportable.
  const appendStorage = new MemoryRecordStorage();
  const appendController = makeController(appendStorage);
  await armAndSettle(appendController);
  appendStorage.failAfterWrites(0);
  appendController.capture(pattern(4), range(0, 4));
  await appendController.whenIdle();
  check(
    'an append failure marks the record error without reaching acquisition',
    appendController.state === 'error' && appendController.bytes === 0 &&
      appendController.lastError !== null,
    `state=${appendController.state} lastError=${String(appendController.lastError)}`,
  );
  const erroredExport = await appendController.exportArchive();
  check(
    'an errored record still exports its committed prefix and stays errored',
    erroredExport.bytes.length === 0 && appendController.state === 'error',
    `state=${appendController.state}`,
  );
  await appendController.close();

  // Budget exhaustion is the distinct `full` state, not `error`.
  const fullStorage = new MemoryRecordStorage();
  const full = new OpfsRecordController(fullStorage, {
    profile: profileFor(4),
    maxBytes: 4,
    maxChunkBytes: 4,
    clock: () => FIXED_TIME,
  });
  await armAndSettle(full);
  full.capture(pattern(8), range(0, 8));
  await full.whenIdle();
  check(
    'exceeding maxBytes reports full with the budget in lastError',
    full.state === 'full' && full.bytes === 0 &&
      full.lastError !== null && full.lastError.includes('budget'),
    `state=${full.state} lastError=${String(full.lastError)}`,
  );
  full.capture(pattern(4), range(0, 4));
  await full.whenIdle();
  check('captures after full are ignored', full.state === 'full' && full.bytes === 0);
  const fullExport = await full.exportArchive();
  check('a full record exports its committed prefix and stays full',
    fullExport.bytes.length === 0 && full.state === 'full');
  await full.close();
  check('close from full leaves the controller off', full.state === 'off');
}

async function testQueueOverflow(check: Check): Promise<void> {
  const storage = new MemoryRecordStorage();
  const controller = new OpfsRecordController(storage, {
    profile: profileFor(4),
    maxChunkBytes: 8,
    maxQueuedBytes: 8,
    clock: () => FIXED_TIME,
  });
  await armAndSettle(controller);

  storage.blockWrites();
  controller.capture(pattern(8, 1), range(0, 8));
  controller.capture(pattern(8, 2), range(8, 16));
  check(
    'an unbounded write backlog stops recording with a readable error',
    controller.state === 'error' && controller.lastError !== null &&
      controller.lastError.includes('backlog') && controller.queuedBytes === 8,
    `state=${controller.state} queued=${controller.queuedBytes}`,
  );

  storage.releaseWrites();
  await controller.whenIdle();
  check(
    'the capture already accepted commits, and the backlog error is not downgraded',
    controller.bytes === 8 && controller.queuedBytes === 0 && controller.state === 'error',
    `state=${controller.state} bytes=${controller.bytes}`,
  );
  await controller.close();
}

async function testGaps(check: Check): Promise<void> {
  const storage = new MemoryRecordStorage();
  const controller = makeController(storage);
  await armAndSettle(controller);

  const before = pattern(4, 1);
  const after = pattern(4, 2);
  controller.capture(before, range(0, 4));
  controller.noteGap({ startSeconds: range(4, 8).startSeconds, endSeconds: range(4, 8).endSeconds, reason: 'dropout', group: null });
  controller.noteGap({ startSeconds: range(8, 12).startSeconds, endSeconds: range(8, 12).endSeconds, reason: 'dropout', group: null });
  controller.capture(after, range(12, 16));
  await controller.whenIdle();

  const exported = await controller.exportArchive();
  const gaps = exported.manifest.gaps;
  check(
    'recorded gaps merge and keep the absolute time range',
    gaps.length === 1 && gaps[0]!.startSeconds === 4 / RATE &&
      gaps[0]!.endSeconds === 12 / RATE && gaps[0]!.reason === 'dropout',
    JSON.stringify(gaps),
  );
  check(
    'chunk time ranges skip the gap and the bytes stay contiguous',
    exported.manifest.chunks.length === 2 &&
      exported.manifest.chunks[0]!.timeEnd === 4 / RATE &&
      exported.manifest.chunks[1]!.timeStart === 12 / RATE &&
      equalBytes(exported.bytes, concat(before, after)),
    JSON.stringify(exported.manifest.chunks),
  );
}

async function testRecoveryArchive(check: Check): Promise<void> {
  const storage = new MemoryRecordStorage();
  const controller = makeController(storage, 4);
  await armAndSettle(controller);
  const first = pattern(4, 1);
  controller.capture(first, range(0, 4));
  controller.capture(pattern(4, 2), range(4, 8));
  await controller.whenIdle();
  await controller.close();

  // Simulate a crash: a stale temporary file and a torn committed tail.
  const stalePart = `${recordChunkPath(2)}.part`;
  storage.setBytes(stalePart, pattern(4));
  storage.truncateFile(recordChunkPath(1), 10);

  const archive = new RecordArchive(storage);
  const recovery = await archive.recover();
  check(
    'recovery drops the torn tail and the stale part file',
    recovery.recovered && recovery.torn.includes(recordChunkPath(1)) &&
      recovery.removedParts.includes(stalePart) && recovery.scannedChunks === 1,
    JSON.stringify({ torn: recovery.torn, parts: recovery.removedParts }),
  );
  const manifest = await archive.readManifest();
  check(
    'the rebuilt manifest keeps only complete chunks',
    manifest.bytes === first.length && manifest.chunks.length === 1,
    `bytes=${manifest.bytes} chunks=${manifest.chunks.length}`,
  );
  const exported = await archive.export();
  check('the recovered archive exports the committed prefix',
    equalBytes(exported.bytes, first));
  const slice = await archive.readBytes(1, 3);
  check('readBytes returns a verified sub-range',
    equalBytes(slice, first.subarray(1, 3)), `length=${slice.length}`);
}

function recordStoreOptions(
  storage: RecordStorage,
  channels: number,
  overrides: { maxChunkBytes?: number; groupId?: string } = {},
): Parameters<typeof createDigitalSignalStore>[0] {
  return {
    groups: [{ id: 'digital', channels: channels as ChannelCount, rateHz: RATE }],
    record: {
      storage,
      profile: profileFor(channels),
      maxChunkBytes: overrides.maxChunkBytes ?? 16,
      ...(overrides.groupId !== undefined ? { groupId: overrides.groupId } : {}),
      clock: () => FIXED_TIME,
    },
  };
}

async function testStoreIntegration(check: Check): Promise<void> {
  // Default: no record option keeps the typed unsupported stub.
  const plain: DigitalSignalStore = createDigitalSignalStore({
    groups: [{ id: 'digital', channels: 4, rateHz: RATE }],
  });
  check(
    'a store without a record option keeps the unsupported controller',
    plain.record instanceof UnsupportedRecordController && plain.record.state === 'off',
    plain.record.constructor.name,
  );
  plain.append('digital', encodeWords([1, 2, 3, 4], 4), 0);
  check('the store without a record backend still stores samples normally',
    plain.newest['digital'] === 4 && plain.sample('d0', 0) === 1);

  // Store + controller: arm synchronously, capture without blocking acquisition.
  const storage = new MemoryRecordStorage();
  const store = createDigitalSignalStore(recordStoreOptions(storage, 4, { maxChunkBytes: 16 }));
  const controller = store.record;
  check('the store exposes the installed OPFS controller',
    controller instanceof OpfsRecordController, controller.constructor.name);
  if (!(controller instanceof OpfsRecordController)) return;

  controller.arm();
  check('the store sees the synchronous armed transition',
    controller.state === 'armed', `state=${controller.state}`);
  await controller.whenIdle();

  storage.blockWrites();
  const a = encodeWords([1, 2, 3, 4], 4);
  store.append('digital', a, 0);
  check(
    'store.append returns while the OPFS write is blocked',
    controller.queuedBytes === a.length,
    `queued=${controller.queuedBytes}`,
  );
  storage.releaseWrites();
  await controller.whenIdle();
  check(
    'the blocked append commits and the record starts recording',
    controller.bytes === a.length && controller.state === 'recording',
    `state=${controller.state} bytes=${controller.bytes}`,
  );

  // A real gap: the store pads filler for the skip, the archive must not contain it.
  const b = encodeWords([5, 6, 7, 8], 4);
  const c = encodeWords([9, 10, 11, 12], 4);
  store.append('digital', b, 4);
  store.noteGap({ group: 'digital', start: 8, end: 12, reason: 'dropout' });
  store.append('digital', c, 12);
  await controller.whenIdle();
  check(
    'the store archives only real samples, not filler for a covered skip',
    controller.bytes === 12 && store.newest['digital'] === 16,
    `bytes=${controller.bytes} newest=${store.newest['digital']}`,
  );
  const exported = await controller.exportArchive();
  check(
    'exported bytes are the accepted chunks in append order',
    equalBytes(exported.bytes, concat(a, b, c)),
    `length=${exported.bytes.length}`,
  );
  const archiveGap = exported.manifest.gaps.find((gap) => gap.reason === 'dropout');
  check(
    'the group-wide store gap is recorded on the archive timeline',
    archiveGap !== undefined && archiveGap.startSeconds === 8 / RATE &&
      archiveGap.endSeconds === 12 / RATE && archiveGap.group === 'digital',
    JSON.stringify(archiveGap),
  );

  // Retention is orthogonal: a drop changes RAM, never the archive.
  const long = new Uint8Array(128); // 128 four-channel samples
  store.append('digital', long, 16);
  await controller.whenIdle();
  const beforeDrop = controller.bytes;
  store.dropBefore(80 / RATE);
  await controller.whenIdle();
  check(
    'dropBefore never changes the recorded bytes',
    controller.bytes === beforeDrop && beforeDrop === 140,
    `bytes=${controller.bytes}`,
  );

  // A refused store append must never reach the archive.
  thrown(() => { store.append('digital', encodeWords([0], 4), 0); });
  await controller.whenIdle();
  check('a rejected store append is not archived', controller.bytes === beforeDrop);

  // A storage failure must not break acquisition or display.
  const errorStorage = new MemoryRecordStorage();
  const errorStore = createDigitalSignalStore(recordStoreOptions(errorStorage, 4));
  const errorController = errorStore.record;
  if (!(errorController instanceof OpfsRecordController)) return;
  await armAndSettle(errorController);
  errorStorage.failAfterWrites(0);
  let appendThrew = false;
  try {
    errorStore.append('digital', encodeWords([1, 2, 3, 4], 4), 0);
  } catch {
    appendThrew = true;
  }
  await errorController.whenIdle();
  check(
    'a record storage failure does not throw from store.append',
    !appendThrew && errorController.state === 'error',
    `state=${errorController.state}`,
  );
  check(
    'the store keeps the samples and acquisition continues after a record error',
    errorStore.newest['digital'] === 4 && errorStore.sample('d0', 0) === 1 &&
      errorStore.query('d0', 0, 4, 4).status.every((status) => status === 0),
    `newest=${errorStore.newest['digital']}`,
  );
  errorStore.append('digital', encodeWords([0, 1, 0, 1], 4), 4);
  check('acquisition advances after the record stopped',
    errorStore.newest['digital'] === 8);

  // Recording targets one group; a multi-group store archives only that group.
  const groupStorage = new MemoryRecordStorage();
  const twoGroups = createDigitalSignalStore({
    groups: [
      { id: 'a', channels: 4, rateHz: RATE },
      { id: 'b', channels: 4, rateHz: RATE, start: 4 },
    ],
    record: {
      storage: groupStorage,
      profile: { ...profileFor(4), profileId: 'group-b' },
      groupId: 'b',
      maxChunkBytes: 16,
      clock: () => FIXED_TIME,
    },
  });
  const groupController = twoGroups.record;
  if (!(groupController instanceof OpfsRecordController)) {
    check('a multi-group store exposes its controller', false);
    return;
  }
  await armAndSettle(groupController);
  twoGroups.append('a', encodeWords([1, 1, 1, 1], 4), 0);
  check('appends to a non-recorded group are not queued',
    groupController.queuedBytes === 0);
  const bChunk = encodeWords([2, 2, 2, 2], 4);
  twoGroups.append('b', bChunk, 0);
  await groupController.whenIdle();
  const groupExport = await groupController.exportArchive();
  check(
    'only the selected group is archived',
    groupController.bytes === bChunk.length && equalBytes(groupExport.bytes, bChunk),
    `bytes=${groupController.bytes}/${bChunk.length}`,
  );
  await groupController.close();

  // Every supported digital width crosses the record path unchanged.
  for (const channels of [4, 8, 16, 32, 64, 128] as ChannelCount[]) {
    const widthStorage = new MemoryRecordStorage();
    const widthStore = createDigitalSignalStore(recordStoreOptions(widthStorage, channels));
    const widthController = widthStore.record;
    if (!(widthController instanceof OpfsRecordController)) {
      check(`${channels}-channel store exposes its controller`, false);
      continue;
    }
    await armAndSettle(widthController);
    const chunk = encodeWords([1, 2, 3, 4], channels);
    widthStore.append('digital', chunk, 0);
    await widthController.whenIdle();
    const widthExport = await widthController.exportArchive();
    check(
      `${channels}-channel store archives the exact append bytes`,
      equalBytes(widthExport.bytes, chunk) && widthController.bytes === chunk.length,
      `bytes=${widthController.bytes}/${chunk.length}`,
    );
  }
}

// ------------------------------------------------------------------------------- main

export async function runRecordControllerSelftest(): Promise<RecordControllerTestResult[]> {
  const results: RecordControllerTestResult[] = [];
  const check: Check = (name, pass, detail = '') => {
    results.push({ name, pass, detail });
  };

  await testArmContract(check);
  await testCaptureAndExport(check);
  await testPauseResumeClose(check);
  await testErrorAndFull(check);
  await testQueueOverflow(check);
  await testGaps(check);
  await testRecoveryArchive(check);
  await testStoreIntegration(check);
  return results;
}

function setExitCode(code: number): void {
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc !== undefined) {
    proc.exitCode = code;
    return;
  }
  throw new Error(`record controller selftest failed (exit ${code}) with no process`);
}

runRecordControllerSelftest().then((results) => {
  for (const result of results) {
    const detail = result.detail === '' ? '' : `\n        ${result.detail}`;
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.pass ? '' : detail}`);
  }
  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) setExitCode(1);
}).catch((error: unknown) => {
  console.error('FAIL record controller selftest crashed:', error);
  setExitCode(1);
});
