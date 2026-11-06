// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * OPFS adapter for the record core (docs/ARCHITECTURE.md §4.3).
 *
 * `createOpfsRecordStorage(root?)` implements `RecordStorage` on the Origin Private File
 * System, rooted at `root` or at `navigator.storage.getDirectory()` when no root is
 * supplied. Paths are `/`-separated and relative to that root; `open(path, true)` creates
 * missing intermediate directories. There are no DOM/UI imports and no network access.
 *
 * File backends, in preference order:
 *   1. `FileSystemSyncAccessHandle` (`createSyncAccessHandle()`), exposed only to
 *      dedicated workers. Offset reads/writes are synchronous inside the worker; this is
 *      the fast path. If the browser exposes the method but refuses it here (main thread:
 *      `NoModificationAllowedError` / `SecurityError` / `NotSupportedError`), the adapter
 *      falls back to the writable path.
 *   2. `createWritable({ keepExistingData: true })`. Stream writes are buffered until the
 *      stream closes, so this adapter flushes (closes) the stream before every
 *      `size()`/`read()` and lazily reopens it with `keepExistingData` on the next write.
 *      That is a read-modify-write cycle: correct, but slower than the worker path.
 *
 * Errors: a missing path is surfaced as an `Error` with `name === 'ENOENT'`. Other
 * DOMExceptions are rethrown unchanged, so quota refusals keep `QuotaExceededError` /
 * `NS_ERROR_DOM_QUOTA_REACHED` for the record core's `mapStorageError`. The adapter's own
 * range/state failures use DOMException-compatible names (`EINVAL`, `EIO`,
 * `InvalidStateError`, `NotSupportedError`).
 *
 * Assumptions and limits (also the integration contract):
 *   - `rename()` is the record commit point and uses `FileSystemHandle.move()`; OPFS move
 *     is atomic within the root, which is what the record protocol depends on. A browser
 *     without `move()` cannot host a record (typed `NotSupportedError`).
 *   - Some move() implementations refuse to replace an existing destination. Only in that
 *     case does the adapter remove the destination and retry, because the record core
 *     rewrites `manifest.json` under its own name. That overwrite window is not atomic;
 *     a crash there leaves a manifest recoverable from `meta.json` plus the chunk
 *     headers, and the chunk commit path never needs the fallback (its target is new).
 *   - One open `RecordFile` per path at a time; the adapter adds no locking beyond OPFS.
 *   - `list()` returns the direct children of the record root, sorted. Record roots are
 *     flat; nested paths are supported by `open`/`remove`/`rename` for other callers.
 *   - Sync access handles are closed synchronously; the writable path commits on
 *     `close()`, which every `RecordFile` user must call.
 */

import type { RecordFile, RecordStorage } from './opfsRecord.js';

// ------------------------------------------------------- structural OPFS handle types

/** The subset of `FileSystemHandle` this adapter needs. */
export interface OpfsHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
}

/** A `Blob`-shaped view of a file, as returned by `FileSystemFileHandle.getFile()`. */
export interface OpfsBlob {
  readonly size: number;
  slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

/** The subset of `FileSystemWritableFileStream` the slow path uses. */
export interface OpfsWritableStream {
  write(data: Uint8Array): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

/** The subset of `FileSystemSyncAccessHandle` the fast path uses. */
export interface OpfsSyncAccessHandle {
  getSize(): number;
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
}

/** A `FileSystemFileHandle` as used here; `move` is not in TypeScript's DOM lib yet. */
export interface OpfsFileHandle extends OpfsHandle {
  readonly kind: 'file';
  getFile(): Promise<OpfsBlob>;
  createWritable?(options?: { keepExistingData?: boolean }): Promise<OpfsWritableStream>;
  createSyncAccessHandle?(): Promise<OpfsSyncAccessHandle>;
  move?(destinationDirectory: OpfsDirectoryHandle, newName?: string): Promise<void>;
}

/** A `FileSystemDirectoryHandle`; OPFS entries iterate as `[name, handle]` pairs. */
export interface OpfsDirectoryHandle extends OpfsHandle {
  readonly kind: 'directory';
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?(): AsyncIterableIterator<[string, OpfsFileHandle | OpfsDirectoryHandle]>;
}

// ------------------------------------------------------------------------- errors

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function isMissing(error: unknown): boolean {
  const name = errorName(error);
  return name === 'NotFoundError' || name === 'ENOENT';
}

/** Preserve quota and other DOMException names; normalize a missing path to ENOENT. */
function translatePathError(error: unknown, what: string): Error {
  if (isMissing(error)) {
    return namedError('ENOENT', `ENOENT: no such file or directory (${what})`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function assertOffset(offset: number, what: string): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw namedError('EINVAL', `${what}: offset ${offset} must be a non-negative integer`);
  }
}

function assertLength(length: number, what: string): void {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw namedError('EINVAL', `${what}: length ${length} must be a non-negative integer`);
  }
}

// --------------------------------------------------------------------------- paths

/** Split a relative OPFS path into entry names, rejecting traversal and empty segments. */
function splitPath(path: string, what: string): string[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw namedError('EINVAL', `${what}: path must be a non-empty string`);
  }
  if (path.startsWith('/')) {
    throw namedError('EINVAL', `${what}: absolute path '${path}' is not allowed`);
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw namedError('EINVAL', `${what}: path '${path}' has an empty segment`);
    }
    if (segment === '.' || segment === '..') {
      throw namedError('EINVAL', `${what}: path '${path}' has a dot segment`);
    }
    if (segment.includes('\0')) {
      throw namedError('EINVAL', `${what}: path '${path}' contains a NUL byte`);
    }
  }
  return segments;
}

async function resolveDirectory(
  root: OpfsDirectoryHandle,
  segments: readonly string[],
  create: boolean,
): Promise<OpfsDirectoryHandle> {
  let directory = root;
  for (const name of segments) {
    directory = await directory.getDirectoryHandle(name, { create });
  }
  return directory;
}

// ------------------------------------------------------------------- file backends

/**
 * Worker fast path: offset reads/writes through a `FileSystemSyncAccessHandle`. The
 * handle owns the file until `close()`; operations are synchronous but the RecordFile
 * methods remain async to match the contract.
 */
class SyncAccessRecordFile implements RecordFile {
  private closed = false;

  constructor(
    private readonly access: OpfsSyncAccessHandle,
    private readonly path: string,
  ) {}

  private assertOpen(): void {
    if (this.closed) throw namedError('InvalidStateError', `file '${this.path}' is closed`);
  }

  async size(): Promise<number> {
    this.assertOpen();
    return this.access.getSize();
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    this.assertOpen();
    assertOffset(offset, `write '${this.path}'`);
    let written = 0;
    while (written < data.length) {
      const count = this.access.write(data.subarray(written), { at: offset + written });
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw namedError('EIO', `short write to '${this.path}' at byte ${offset + written}`);
      }
      written += count;
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    assertOffset(offset, `read '${this.path}'`);
    assertLength(length, `read '${this.path}'`);
    if (length === 0) return new Uint8Array(0);
    const bytes = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const count = this.access.read(bytes.subarray(filled), { at: offset + filled });
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw namedError(
          'EIO',
          `read past the end of '${this.path}' at byte ${offset + filled}`,
        );
      }
      filled += count;
    }
    return bytes;
  }

  async truncate(length: number): Promise<void> {
    this.assertOpen();
    assertLength(length, `truncate '${this.path}'`);
    this.access.truncate(length);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.access.close();
  }
}

/**
 * Main-thread path: `createWritable({ keepExistingData: true })` with a read-modify-write
 * cycle. The stream buffers writes until `close()`, so `size()` and `read()` flush it
 * first and a later write lazily reopens it on the same bytes. This is slower than the
 * sync path but works everywhere OPFS does.
 */
class WritableRecordFile implements RecordFile {
  private stream: OpfsWritableStream | null = null;
  private closed = false;

  constructor(
    private readonly handle: OpfsFileHandle,
    private readonly path: string,
  ) {}

  private assertOpen(): void {
    if (this.closed) throw namedError('InvalidStateError', `file '${this.path}' is closed`);
  }

  private async ensureStream(): Promise<OpfsWritableStream> {
    this.assertOpen();
    if (this.stream !== null) return this.stream;
    const createWritable = this.handle.createWritable;
    if (typeof createWritable !== 'function') {
      throw namedError('NotSupportedError', `'${this.path}' has no createWritable()`);
    }
    this.stream = await createWritable.call(this.handle, { keepExistingData: true });
    return this.stream;
  }

  /** Commit buffered writes so `getFile()` observes them. */
  private async flush(): Promise<void> {
    const stream = this.stream;
    if (stream === null) return;
    this.stream = null;
    await stream.close();
  }

  async size(): Promise<number> {
    this.assertOpen();
    await this.flush();
    return (await this.handle.getFile()).size;
  }

  async write(offset: number, data: Uint8Array): Promise<void> {
    this.assertOpen();
    assertOffset(offset, `write '${this.path}'`);
    if (data.length === 0) return;
    const stream = await this.ensureStream();
    await stream.seek(offset);
    await stream.write(data);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    assertOffset(offset, `read '${this.path}'`);
    assertLength(length, `read '${this.path}'`);
    if (length === 0) return new Uint8Array(0);
    await this.flush();
    const file = await this.handle.getFile();
    if (offset > file.size || offset + length > file.size) {
      throw namedError(
        'EIO',
        `read past the end of '${this.path}': ${length} bytes at ${offset}, size ${file.size}`,
      );
    }
    const buffer = await file.slice(offset, offset + length).arrayBuffer();
    const bytes = new Uint8Array(buffer);
    if (bytes.length !== length) {
      throw namedError('EIO', `short read from '${this.path}' at byte ${offset}`);
    }
    return bytes;
  }

  async truncate(length: number): Promise<void> {
    this.assertOpen();
    assertLength(length, `truncate '${this.path}'`);
    const stream = await this.ensureStream();
    await stream.truncate(length);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }
}

/** Names meaning "this context may not use a sync access handle"; any other error is real. */
const SYNC_REFUSAL_NAMES: ReadonlySet<string> = new Set([
  'NotSupportedError',
  'SecurityError',
  'NoModificationAllowedError',
]);

async function createRecordFile(handle: OpfsFileHandle, path: string): Promise<RecordFile> {
  const createSync = handle.createSyncAccessHandle;
  if (typeof createSync === 'function') {
    try {
      const access = await createSync.call(handle);
      return new SyncAccessRecordFile(access, path);
    } catch (error) {
      const name = errorName(error);
      if (name === null || !SYNC_REFUSAL_NAMES.has(name)) throw error;
      // Main thread (or a policy refusal): fall through to createWritable().
    }
  }
  if (typeof handle.createWritable === 'function') {
    return new WritableRecordFile(handle, path);
  }
  throw namedError(
    'NotSupportedError',
    `OPFS file '${path}' supports neither createSyncAccessHandle() nor createWritable()`,
  );
}

// ------------------------------------------------------------------------ storage

/** Move failures that mean "the destination already exists" in some implementations. */
function isOccupiedDestination(error: unknown): boolean {
  const name = errorName(error);
  return name === 'InvalidModificationError' || name === 'TypeMismatchError';
}

class OpfsRecordStorage implements RecordStorage {
  constructor(private readonly root: OpfsDirectoryHandle) {}

  async open(path: string, create: boolean): Promise<RecordFile> {
    const segments = splitPath(path, 'open');
    const name = segments.pop();
    if (name === undefined) throw namedError('EINVAL', `open '${path}': no file name`);
    try {
      const parent = await resolveDirectory(this.root, segments, create);
      const handle = await parent.getFileHandle(name, { create });
      return await createRecordFile(handle, path);
    } catch (error) {
      throw translatePathError(error, `open '${path}'`);
    }
  }

  async list(): Promise<readonly string[]> {
    try {
      const entries = this.root.entries;
      if (typeof entries !== 'function') {
        throw namedError('NotSupportedError', 'OPFS directory iteration (entries()) is unavailable');
      }
      const names: string[] = [];
      for await (const [name] of entries.call(this.root)) names.push(name);
      names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return names;
    } catch (error) {
      throw translatePathError(error, 'list record root');
    }
  }

  async remove(path: string): Promise<void> {
    const segments = splitPath(path, 'remove');
    const name = segments.pop();
    if (name === undefined) throw namedError('EINVAL', `remove '${path}': no file name`);
    try {
      const parent = await resolveDirectory(this.root, segments, false);
      await parent.removeEntry(name);
    } catch (error) {
      throw translatePathError(error, `remove '${path}'`);
    }
  }

  /**
   * Commit point: `FileSystemHandle.move()` is atomic inside one OPFS root. `move()` is
   * not yet in TypeScript's DOM lib, hence the structural `OpfsFileHandle.move` type.
   */
  async rename(from: string, to: string): Promise<void> {
    const fromSegments = splitPath(from, 'rename source');
    const toSegments = splitPath(to, 'rename target');
    const fromName = fromSegments.pop();
    const toName = toSegments.pop();
    if (fromName === undefined || toName === undefined) {
      throw namedError('EINVAL', `rename '${from}' -> '${to}': missing file name`);
    }
    if (fromSegments.join('/') === toSegments.join('/') && fromName === toName) return;
    try {
      const fromParent = await resolveDirectory(this.root, fromSegments, false);
      const toParent = await resolveDirectory(this.root, toSegments, false);
      const source = await fromParent.getFileHandle(fromName, { create: false });
      const move = source.move;
      if (typeof move !== 'function') {
        throw namedError(
          'NotSupportedError',
          'FileSystemHandle.move() is unavailable; the record adapter requires atomic rename',
        );
      }
      try {
        await move.call(source, toParent, toName);
      } catch (error) {
        if (!isOccupiedDestination(error)) throw error;
        // Some implementations refuse to replace an existing destination. The record
        // core renames manifest.json onto itself, so drop the target and retry. The
        // chunk commit path never takes this branch (its target name is new).
        try {
          await toParent.removeEntry(toName);
        } catch (removeError) {
          if (!isMissing(removeError)) throw removeError;
        }
        await move.call(source, toParent, toName);
      }
    } catch (error) {
      throw translatePathError(error, `rename '${from}' -> '${to}'`);
    }
  }
}

// ------------------------------------------------------------------------ factory

interface NavigatorWithStorage {
  readonly storage?: {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
}

async function defaultDirectory(): Promise<OpfsDirectoryHandle> {
  const navigatorValue = (globalThis as { navigator?: NavigatorWithStorage }).navigator;
  const storage = navigatorValue?.storage;
  if (storage === undefined || typeof storage.getDirectory !== 'function') {
    throw namedError(
      'NotSupportedError',
      'OPFS is unavailable: navigator.storage.getDirectory() is missing',
    );
  }
  return (await storage.getDirectory()) as unknown as OpfsDirectoryHandle;
}

/**
 * Open the record storage rooted at `root`, or at the origin private file system root
 * when `root` is omitted. Fails with `NotSupportedError` when OPFS is unavailable.
 */
export async function createOpfsRecordStorage(
  root?: FileSystemDirectoryHandle,
): Promise<RecordStorage> {
  const directory = root === undefined
    ? await defaultDirectory()
    : (root as unknown as OpfsDirectoryHandle);
  return new OpfsRecordStorage(directory);
}
