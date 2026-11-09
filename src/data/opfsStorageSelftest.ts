// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Deterministic self-test for the OPFS record adapter. No real OPFS, no browser, no
 * timers: structural in-memory fakes of `FileSystemDirectoryHandle` /
 * `FileSystemFileHandle` and of both file backends (sync access handle and
 * `createWritable` + read-modify-write) drive the adapter through directory creation,
 * recursive paths, offset I/O, truncate, rename/remove, missing-path errors and a full
 * `OpfsRecordWriter` -> `OpfsRecordReader` round-trip.
 *
 * Run:
 *   node_modules/.bin/esbuild src/data/opfsStorageSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/opfsstorage-selftest.mjs --log-level=error
 *   node /tmp/opfsstorage-selftest.mjs
 */

import {
  OpfsRecordReader,
  OpfsRecordWriter,
  type RecordProfile,
  type RecordStorage,
} from './opfsRecord.js';
import { createOpfsRecordStorage } from './opfsStorage.js';

// --------------------------------------------------------------- in-memory OPFS fakes

function fakeError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

type SyncMode = 'on' | 'off' | 'denied';

interface FakeOptions {
  /** 'on' exposes a working sync access handle; 'off' exposes one that refuses it. */
  readonly sync: SyncMode;
  readonly writable: boolean;
  /** false models implementations whose move() refuses to replace a destination. */
  readonly overwriteOnMove: boolean;
  /** Make createWritable() fail with a quota DOMException. */
  readonly quotaOnWritable: boolean;
}

interface FakeStats {
  syncAttempts: number;
  syncOpens: number;
  writableOpens: number;
  moves: number;
  removes: number;
}

interface FakeWorld {
  readonly root: FakeDirectoryHandle;
  readonly options: FakeOptions;
  readonly stats: FakeStats;
}

class FakeDirectory {
  readonly children = new Map<string, FakeFileEntry | FakeDirectory>();

  constructor(
    readonly name: string,
    public parent: FakeDirectory | null,
  ) {}
}

class FakeFileEntry {
  data: Uint8Array = new Uint8Array(0);

  constructor(
    public name: string,
    public parent: FakeDirectory | null,
  ) {}
}

class FakeBlob {
  constructor(private readonly bytes: Uint8Array) {}

  get size(): number {
    return this.bytes.length;
  }

  slice(start = 0, end = this.bytes.length): FakeBlob {
    const from = Math.min(Math.max(start, 0), this.bytes.length);
    const to = Math.min(Math.max(end, from), this.bytes.length);
    return new FakeBlob(this.bytes.slice(from, to));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.slice().buffer as ArrayBuffer;
  }
}

/** Models FileSystemWritableFileStream; keepExistingData copies the current bytes. */
class FakeWritable {
  private buffer: Uint8Array;
  private position = 0;
  private closed = false;

  constructor(
    private readonly entry: FakeFileEntry,
    keepExistingData: boolean,
  ) {
    this.buffer = keepExistingData ? entry.data.slice() : new Uint8Array(0);
  }

  async write(data: Uint8Array): Promise<void> {
    this.assertOpen();
    const end = this.position + data.length;
    if (end > this.buffer.length) {
      const next = new Uint8Array(end);
      next.set(this.buffer);
      this.buffer = next;
    }
    this.buffer.set(data, this.position);
    this.position = end;
  }

  async seek(position: number): Promise<void> {
    this.assertOpen();
    this.position = position;
  }

  async truncate(size: number): Promise<void> {
    this.assertOpen();
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, Math.min(size, this.buffer.length)));
    this.buffer = next;
    if (this.position > size) this.position = size;
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.closed = true;
    this.entry.data = this.buffer;
  }

  private assertOpen(): void {
    if (this.closed) throw fakeError('InvalidStateError', 'writable stream is closed');
  }
}

/** Models FileSystemSyncAccessHandle; reads/writes hit the entry's bytes directly. */
class FakeSyncAccessHandle {
  private closed = false;

  constructor(private readonly entry: FakeFileEntry) {}

  getSize(): number {
    this.assertOpen();
    return this.entry.data.length;
  }

  read(buffer: Uint8Array, options: { at?: number } = {}): number {
    this.assertOpen();
    const at = options.at ?? 0;
    const available = Math.max(0, this.entry.data.length - at);
    const count = Math.min(buffer.length, available);
    buffer.set(this.entry.data.subarray(at, at + count));
    return count;
  }

  write(buffer: Uint8Array, options: { at?: number } = {}): number {
    this.assertOpen();
    const at = options.at ?? 0;
    const end = at + buffer.length;
    if (end > this.entry.data.length) {
      const next = new Uint8Array(end);
      next.set(this.entry.data);
      this.entry.data = next;
    }
    this.entry.data.set(buffer, at);
    return buffer.length;
  }

  truncate(newSize: number): void {
    this.assertOpen();
    const next = new Uint8Array(newSize);
    next.set(this.entry.data.subarray(0, Math.min(newSize, this.entry.data.length)));
    this.entry.data = next;
  }

  flush(): void {
    this.assertOpen();
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw fakeError('InvalidStateError', 'sync access handle is closed');
  }
}

class FakeFileHandle {
  readonly kind = 'file' as const;

  constructor(
    private readonly entry: FakeFileEntry,
    private readonly options: FakeOptions,
    private readonly stats: FakeStats,
  ) {}

  get name(): string {
    return this.entry.name;
  }

  async getFile(): Promise<FakeBlob> {
    return new FakeBlob(this.entry.data.slice());
  }

  async createWritable(options?: { keepExistingData?: boolean }): Promise<FakeWritable> {
    if (!this.options.writable) {
      throw fakeError('NotSupportedError', 'createWritable() is disabled');
    }
    if (this.options.quotaOnWritable) {
      throw fakeError('QuotaExceededError', 'simulated OPFS quota refusal');
    }
    this.stats.writableOpens++;
    return new FakeWritable(this.entry, options?.keepExistingData === true);
  }

  async createSyncAccessHandle(): Promise<FakeSyncAccessHandle> {
    this.stats.syncAttempts++;
    if (this.options.sync === 'off') {
      throw fakeError('NotSupportedError', 'sync access handles are disabled');
    }
    if (this.options.sync === 'denied') {
      throw fakeError('NoModificationAllowedError', 'not a dedicated worker');
    }
    this.stats.syncOpens++;
    return new FakeSyncAccessHandle(this.entry);
  }

  async move(destination: FakeDirectoryHandle, newName?: string): Promise<void> {
    const name = newName ?? this.entry.name;
    const existing = destination.directory.children.get(name);
    if (existing !== undefined && !this.options.overwriteOnMove) {
      throw fakeError('InvalidModificationError', `destination '${name}' already exists`);
    }
    this.entry.parent?.children.delete(this.entry.name);
    this.entry.name = name;
    this.entry.parent = destination.directory;
    destination.directory.children.set(name, this.entry);
    this.stats.moves++;
  }
}

class FakeDirectoryHandle {
  readonly kind = 'directory' as const;

  constructor(
    readonly directory: FakeDirectory,
    private readonly options: FakeOptions,
    private readonly stats: FakeStats,
  ) {}

  get name(): string {
    return this.directory.name;
  }

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeDirectoryHandle> {
    const existing = this.directory.children.get(name);
    if (existing instanceof FakeDirectory) {
      return new FakeDirectoryHandle(existing, this.options, this.stats);
    }
    if (existing !== undefined) {
      throw fakeError('TypeMismatchError', `'${name}' is not a directory`);
    }
    if (options.create !== true) throw fakeError('NotFoundError', `no directory '${name}'`);
    const created = new FakeDirectory(name, this.directory);
    this.directory.children.set(name, created);
    return new FakeDirectoryHandle(created, this.options, this.stats);
  }

  async getFileHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<FakeFileHandle> {
    const existing = this.directory.children.get(name);
    if (existing instanceof FakeFileEntry) {
      return new FakeFileHandle(existing, this.options, this.stats);
    }
    if (existing !== undefined) {
      throw fakeError('TypeMismatchError', `'${name}' is not a file`);
    }
    if (options.create !== true) throw fakeError('NotFoundError', `no file '${name}'`);
    const created = new FakeFileEntry(name, this.directory);
    this.directory.children.set(name, created);
    return new FakeFileHandle(created, this.options, this.stats);
  }

  async removeEntry(name: string): Promise<void> {
    const existing = this.directory.children.get(name);
    if (existing === undefined) throw fakeError('NotFoundError', `no entry '${name}'`);
    if (existing instanceof FakeDirectory && existing.children.size > 0) {
      throw fakeError('InvalidModificationError', `directory '${name}' is not empty`);
    }
    this.directory.children.delete(name);
    this.stats.removes++;
  }

  async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirectoryHandle], void, unknown> {
    for (const [name, child] of [...this.directory.children]) {
      const handle = child instanceof FakeDirectory
        ? new FakeDirectoryHandle(child, this.options, this.stats)
        : new FakeFileHandle(child, this.options, this.stats);
      yield [name, handle];
    }
  }
}

function makeWorld(overrides: Partial<FakeOptions> = {}): FakeWorld {
  const options: FakeOptions = {
    sync: 'on',
    writable: true,
    overwriteOnMove: true,
    quotaOnWritable: false,
    ...overrides,
  };
  const stats: FakeStats = {
    syncAttempts: 0,
    syncOpens: 0,
    writableOpens: 0,
    moves: 0,
    removes: 0,
  };
  const root = new FakeDirectory('root', null);
  return { root: new FakeDirectoryHandle(root, options, stats), options, stats };
}

async function adapterFor(world: FakeWorld): Promise<RecordStorage> {
  return createOpfsRecordStorage(world.root as unknown as FileSystemDirectoryHandle);
}

// --------------------------------------------------------------------------- helpers

let checks = 0;
let failures = 0;

function check(label: string, condition: boolean): void {
  checks++;
  if (condition) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL ${label}`);
  }
}

async function rejection(operation: () => Promise<unknown>): Promise<Error | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function nameOf(error: Error | null): string {
  return error === null ? '(resolved)' : error.name;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 3) & 0xff;
  return bytes;
}

async function readAll(storage: RecordStorage, path: string): Promise<Uint8Array> {
  const file = await storage.open(path, false);
  try {
    const size = await file.size();
    return await file.read(0, size);
  } finally {
    await file.close();
  }
}

async function writeAll(
  storage: RecordStorage,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const file = await storage.open(path, true);
  try {
    await file.truncate(0);
    await file.write(0, bytes);
  } finally {
    await file.close();
  }
}

// ----------------------------------------------------------------------------- tests

async function testDirectoryCreationAndRecursivePaths(): Promise<void> {
  console.log('\ndirectory creation, recursive paths and list');
  const world = makeWorld();
  const storage = await adapterFor(world);
  check('a fresh root lists no entries', (await storage.list()).length === 0);

  const file = await storage.open('captures/run-1/notes.bin', true);
  check('open(create) creates intermediate directories', world.root.directory.children.has('captures'));
  await file.write(0, Uint8Array.of(1, 2, 3));
  await file.close();
  check(
    'list returns direct children only',
    JSON.stringify(await storage.list()) === '["captures"]',
  );

  const reopened = await storage.open('captures/run-1/notes.bin', false);
  check('a recursive path reopens the file', (await reopened.size()) === 3);
  check('the reopened bytes survive', sameBytes(await reopened.read(0, 3), Uint8Array.of(1, 2, 3)));
  await reopened.close();

  const missingFile = await rejection(() => storage.open('captures/run-1/missing.bin', false));
  check('a missing file rejects with ENOENT', nameOf(missingFile) === 'ENOENT');
  const missingParent = await rejection(() => storage.open('nope/run/file.bin', false));
  check('a missing parent directory rejects with ENOENT', nameOf(missingParent) === 'ENOENT');

  const traversal = await rejection(() => storage.open('captures/../escape.bin', true));
  check('a dot-dot path rejects with EINVAL', nameOf(traversal) === 'EINVAL');
}

async function testOffsetIo(world: FakeWorld, label: string): Promise<void> {
  console.log(`\noffset reads/writes and truncate (${label})`);
  const storage = await adapterFor(world);
  const file = await storage.open('offset.bin', true);

  await file.write(0, Uint8Array.of(1, 2));
  await file.write(4, Uint8Array.of(5, 6));
  check(`${label}: an offset write extends with a zero gap`, (await file.size()) === 6);
  check(
    `${label}: an offset read sees the zero gap`,
    sameBytes(await file.read(0, 6), Uint8Array.of(1, 2, 0, 0, 5, 6)),
  );

  await file.truncate(3);
  check(`${label}: truncate shrinks the file`, (await file.size()) === 3);
  check(
    `${label}: truncate keeps the prefix`,
    sameBytes(await file.read(0, 3), Uint8Array.of(1, 2, 0)),
  );

  await file.truncate(5);
  check(
    `${label}: truncate grows with zeros`,
    sameBytes(await file.read(0, 5), Uint8Array.of(1, 2, 0, 0, 0)),
  );

  await file.write(5, Uint8Array.of(9));
  check(
    `${label}: a write at the old end appends`,
    sameBytes(await file.read(0, 6), Uint8Array.of(1, 2, 0, 0, 0, 9)),
  );

  const pastEnd = await rejection(() => file.read(5, 2));
  check(`${label}: a read past the end rejects with EIO`, nameOf(pastEnd) === 'EIO');
  const negative = await rejection(() => file.write(-1, Uint8Array.of(1)));
  check(`${label}: a negative offset rejects with EINVAL`, nameOf(negative) === 'EINVAL');

  await file.close();
  await file.close();
  const afterClose = await rejection(() => file.size());
  check(
    `${label}: closing twice is harmless and use after close rejects`,
    nameOf(afterClose) === 'InvalidStateError',
  );
  check(
    `${label}: the expected backend ran`,
    label === 'sync access handle'
      ? world.stats.syncOpens > 0 && world.stats.writableOpens === 0
      : world.stats.syncAttempts > 0 && world.stats.writableOpens > 0,
  );
}

async function testRenameAndRemove(): Promise<void> {
  console.log('\natomic rename and remove');
  for (const overwriteOnMove of [true, false]) {
    const label = overwriteOnMove ? 'move overwrites' : 'move refuses, remove+retry';
    const world = makeWorld({ sync: 'off', overwriteOnMove });
    const storage = await adapterFor(world);
    await writeAll(storage, 'from.bin', Uint8Array.of(1, 2, 3));
    await writeAll(storage, 'nested/to.bin', Uint8Array.of(9));

    const movesBefore = world.stats.moves;
    const writableBefore = world.stats.writableOpens;
    await storage.rename('from.bin', 'nested/renamed.bin');
    check(
      `${label}: the source path is gone`,
      nameOf(await rejection(() => storage.open('from.bin', false))) === 'ENOENT',
    );
    check(
      `${label}: the destination has the original bytes`,
      sameBytes(await readAll(storage, 'nested/renamed.bin'), Uint8Array.of(1, 2, 3)),
    );
    check(
      `${label}: rename is a move, not a copy`,
      world.stats.moves === movesBefore + 1 && world.stats.writableOpens === writableBefore,
    );

    const removesBefore = world.stats.removes;
    await storage.rename('nested/renamed.bin', 'nested/to.bin');
    check(
      `${label}: rename replaces an existing destination`,
      sameBytes(await readAll(storage, 'nested/to.bin'), Uint8Array.of(1, 2, 3)),
    );
    check(
      `${label}: rename replaces through move()`,
      world.stats.moves === movesBefore + 2,
    );
    check(
      `${label}: a refusing move falls back to removing the target`,
      overwriteOnMove || world.stats.removes === removesBefore + 1,
    );

    const movesAtNoop = world.stats.moves;
    await storage.rename('nested/to.bin', 'nested/to.bin');
    check(
      `${label}: renaming a path onto itself is a no-op`,
      world.stats.moves === movesAtNoop &&
        sameBytes(await readAll(storage, 'nested/to.bin'), Uint8Array.of(1, 2, 3)),
    );

    const missing = await rejection(() => storage.rename('nope.bin', 'x.bin'));
    check(`${label}: a missing source rejects with ENOENT`, nameOf(missing) === 'ENOENT');

    await storage.remove('nested/to.bin');
    check(
      `${label}: remove deletes the file`,
      nameOf(await rejection(() => storage.open('nested/to.bin', false))) === 'ENOENT',
    );
    check(
      `${label}: removing a missing entry rejects with ENOENT`,
      nameOf(await rejection(() => storage.remove('nested/to.bin'))) === 'ENOENT',
    );
    check(`${label}: the nested directory remains`, (await storage.list()).includes('nested'));
  }
}

async function testQuotaPreserved(): Promise<void> {
  console.log('\nquota errors');
  const world = makeWorld({ sync: 'off', quotaOnWritable: true });
  const storage = await adapterFor(world);
  const file = await storage.open('quota.bin', true);
  const error = await rejection(() => file.write(0, Uint8Array.of(1)));
  check(
    'a quota refusal keeps its DOMException name',
    nameOf(error) === 'QuotaExceededError',
  );
  check(
    'a quota refusal is not rewritten as ENOENT',
    nameOf(error) !== 'ENOENT',
  );
  await file.close();
}

async function testSyncRefusalFallback(): Promise<void> {
  console.log('\nsync access handle refusal');
  const world = makeWorld({ sync: 'denied' });
  const storage = await adapterFor(world);
  await writeAll(storage, 'worker.bin', Uint8Array.of(4, 5, 6));
  check(
    'a refused sync handle falls back to createWritable',
    world.stats.syncAttempts > 0 && world.stats.writableOpens > 0,
  );
  check(
    'the writable fallback preserves the bytes',
    sameBytes(await readAll(storage, 'worker.bin'), Uint8Array.of(4, 5, 6)),
  );
}

const PROFILE: RecordProfile = {
  profileId: 'fake-opfs',
  calibrationId: null,
  channels: 8,
  sampleRateHz: 1_000_000,
  bytesPerSample: 1,
};

async function testRecordRoundTrip(
  sync: SyncMode,
  overwriteOnMove: boolean,
  label: string,
): Promise<void> {
  console.log(`\nOpfsRecordWriter round-trip (${label})`);
  const world = makeWorld({ sync, overwriteOnMove });
  const storage = await adapterFor(world);
  const writer = new OpfsRecordWriter(storage, {
    profile: PROFILE,
    maxChunkBytes: 16,
    clock: () => 1234,
  });

  await writer.arm();
  const data = pattern(40);
  const chunks = await writer.append(data, { startSeconds: 0, endSeconds: 4 });
  check(
    `${label}: append splits into bounded chunks`,
    chunks.length === 3 && chunks.every((chunk) => chunk.bytes <= 16),
  );
  await writer.close();

  const names = await storage.list();
  check(
    `${label}: the root lists committed files only`,
    names.join(',') === [
      'chunk-00000000.lwc',
      'chunk-00000001.lwc',
      'chunk-00000002.lwc',
      'manifest.json',
      'meta.json',
    ].join(','),
  );
  check(`${label}: no .part file survives`, !names.some((name) => name.endsWith('.part')));

  const reader = new OpfsRecordReader(storage);
  const manifest = await reader.readManifest();
  check(
    `${label}: the manifest carries the profile and byte count`,
    manifest.profile.profileId === PROFILE.profileId && manifest.bytes === data.length,
  );
  const exported = await reader.export();
  check(`${label}: the exported bytes equal the recorded bytes`, sameBytes(exported.bytes, data));
  check(
    `${label}: the expected backend ran`,
    sync === 'on'
      ? world.stats.syncOpens > 0 && world.stats.writableOpens === 0
      : world.stats.syncAttempts > 0 && world.stats.writableOpens > 0,
  );
  check(`${label}: renaming used move()`, world.stats.moves > 0);
}

// ------------------------------------------------------------------------------ main

async function main(): Promise<void> {
  console.log('OPFS record storage adapter self-test');
  await testDirectoryCreationAndRecursivePaths();
  await testOffsetIo(makeWorld({ sync: 'on' }), 'sync access handle');
  await testOffsetIo(makeWorld({ sync: 'off' }), 'createWritable');
  await testRenameAndRemove();
  await testQuotaPreserved();
  await testSyncRefusalFallback();
  await testRecordRoundTrip('on', true, 'sync access handle');
  await testRecordRoundTrip('off', false, 'createWritable with a refusing move');
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
  console.error('FAIL opfs storage selftest crashed:', error);
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
  throw new Error('OPFS storage self-test failed and there is no process to exit');
}
