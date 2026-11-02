// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Getting a capture in and out.
 *
 * IN, from sigrok: `.sr` session files load through `src/ui/srLoad.ts` into an edge store.
 * Logic captures only; the format carries no gaps.
 *
 * OUT, and back in: `.lwcap` is ours. It stores transitions, not samples, so a 5 s
 * 16-channel capture is ~400 kB instead of 200 MB, and it round-trips through
 * `SampleStore.edges()` exactly - which also means it loads straight into an edge store
 * with no expansion pass at all. `channelAcrossGaps` keeps the level correct across a
 * dropout; see `src/data/gaps.ts`.
 *
 * Both paths land in the same place: transitions, never expanded into samples, so opening
 * a capture is O(edges) rather than O(samples).
 */

import { channelAcrossGaps, createEdgeStore } from '../data/index.js';
import type { GapSpan, SampleStore } from '../data/types.js';
import { DiagnosticError } from '../diagnostics.js';
import { CHANNEL_COUNTS, isChannelCount, type ChannelCount } from '../types.js';
import { parseSr } from './srLoad.js';

/** [src/data] `append` throws past 2^31 samples rather than wrapping. */
export const MAX_SAMPLES = 2 ** 31;

export interface LoadedCapture {
  store: SampleStore;
  channelNames: string[];
  /** Seconds of wall time the capture covers. */
  duration: number;
  sourceDescription: string;
}

/** Load whatever the user picked: a sigrok session, or our own file. */
export async function loadFiles(files: File[]): Promise<LoadedCapture> {
  if (files.length === 0) throw new DiagnosticError('file.noFiles');

  const lw = files.find((f) => f.name.toLowerCase().endsWith('.lwcap'));
  if (lw) return loadLwcap(await lw.arrayBuffer(), lw.name);

  const sr = files.find((f) => f.name.toLowerCase().endsWith('.sr'));
  if (sr) return parseSr(await sr.arrayBuffer(), sr.name);

  throw new DiagnosticError('file.unsupported', {
    names: files.map((f) => f.name).join(', '),
  });
}

// ---------------------------------------------------------------- our own format

/** v1: no gap spans, the u32 at offset 12 was reserved and always 0. */
const LWCAP_MAGIC_V1 = 'LWCAP1\0\0';
/** v2: gap spans follow the name blob; the u32 at offset 12 is the gap count. */
const LWCAP_MAGIC_V2 = 'LWCAP2\0\0';

/**
 * Serialise a capture as transitions.
 *
 * Layout, little-endian: magic[8], u32 channelCount, u32 gapCount, f64 samplerate,
 * f64 length, u32 nameLen, names, then `gapCount` x { u32 start, u32 end } gap spans,
 * then per channel { u8 initial, pad[3], u32 edgeCount } followed by all the edge
 * arrays back to back. Files written before gap support carry magic `LWCAP1` and a
 * zero in the slot that v2 uses for `gapCount`; both are readable.
 */
export function saveLwcap(store: SampleStore, names: readonly string[]): Blob {
  const n = store.channelCount;
  const len = store.length;
  const edges: Int32Array[] = [];
  const initials: number[] = [];
  for (let c = 0; c < n; c++) {
    // Not store.edges() directly: see channelAcrossGaps - a gap that swallowed an odd
    // number of edges would save a capture whose post-gap levels are inverted.
    const ch = channelAcrossGaps(store, c);
    edges.push(ch.edges);
    initials.push(ch.initial);
  }
  const gaps = store.gaps();
  const nameBlob = new TextEncoder().encode(JSON.stringify(names));
  let bytes = 8 + 4 + 4 + 8 + 8 + 4 + nameBlob.length + gaps.length * 8 + n * 8;
  for (const e of edges) bytes += e.length * 4;

  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < 8; i++) dv.setUint8(i, LWCAP_MAGIC_V2.charCodeAt(i));
  dv.setUint32(8, n, true);
  dv.setUint32(12, gaps.length, true);
  dv.setFloat64(16, store.samplerate, true);
  dv.setFloat64(24, len, true);
  dv.setUint32(32, nameBlob.length, true);
  u8.set(nameBlob, 36);
  let o = 36 + nameBlob.length;
  for (const g of gaps) {
    dv.setUint32(o, g.startSample, true);
    dv.setUint32(o + 4, g.endSample, true);
    o += 8;
  }
  for (let c = 0; c < n; c++) {
    dv.setUint8(o, initials[c]!);
    dv.setUint8(o + 1, 0);
    dv.setUint16(o + 2, 0, true);
    dv.setUint32(o + 4, edges[c]!.length, true);
    o += 8;
  }
  for (const e of edges) {
    for (let i = 0; i < e.length; i++) { dv.setInt32(o, e[i]!, true); o += 4; }
  }
  return new Blob([buf], { type: 'application/octet-stream' });
}

const LWCAP_HEADER_BYTES = 36;

function isChannelNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function loadLwcap(buf: ArrayBuffer, source: string): LoadedCapture {
  if (buf.byteLength < 8) {
    throw new DiagnosticError('file.lwcap.header', {
      bytes: buf.byteLength, need: LWCAP_HEADER_BYTES,
    });
  }
  const dv = new DataView(buf);
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(dv.getUint8(i));
  if (magic !== LWCAP_MAGIC_V1 && magic !== LWCAP_MAGIC_V2) {
    throw new DiagnosticError('file.lwcap.magic', { magic: JSON.stringify(magic) });
  }
  if (buf.byteLength < LWCAP_HEADER_BYTES) {
    throw new DiagnosticError('file.lwcap.header', {
      bytes: buf.byteLength, need: LWCAP_HEADER_BYTES,
    });
  }
  const n = dv.getUint32(8, true);
  if (!isChannelCount(n)) {
    throw new DiagnosticError('file.lwcap.channels', {
      channels: n, widths: CHANNEL_COUNTS.join('/'),
    });
  }
  const gapCount = dv.getUint32(12, true);
  const samplerate = dv.getFloat64(16, true);
  const length = dv.getFloat64(24, true);
  if (!Number.isInteger(length) || !(length >= 0) || length >= MAX_SAMPLES) {
    throw new DiagnosticError('file.lwcap.length', { length });
  }
  if (!(samplerate > 0)) {
    throw new DiagnosticError('file.lwcap.samplerate', { samplerate });
  }
  const nameLen = dv.getUint32(32, true);
  if (36 + nameLen > buf.byteLength) {
    throw new DiagnosticError('file.lwcap.namesTruncated', { bytes: nameLen });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 36, nameLen)));
  } catch (e) {
    throw new DiagnosticError(
      'file.lwcap.namesInvalid', undefined, e instanceof Error ? e.message : String(e));
  }
  if (!isChannelNameList(parsed)) throw new DiagnosticError('file.lwcap.namesInvalid');
  const names = parsed;

  let o = 36 + nameLen;
  const gaps: GapSpan[] = [];
  for (let g = 0; g < gapCount; g++) {
    if (o + 8 > buf.byteLength) throw new DiagnosticError('file.lwcap.gapTruncated', { index: g });
    const s = dv.getUint32(o, true);
    const e = dv.getUint32(o + 4, true);
    o += 8;
    if (!(e > s) || e > length) {
      throw new DiagnosticError('file.lwcap.gapSpan', { start: s, end: e, source });
    }
    if (g > 0) {
      const prev = gaps[g - 1]!;
      if (!(s > prev.endSample)) {
        throw new DiagnosticError('file.lwcap.gapOrder', { index: g });
      }
    }
    gaps.push({ startSample: s, endSample: e });
  }
  if (o + n * 8 > buf.byteLength) {
    throw new DiagnosticError('file.lwcap.channelHeaders');
  }
  const initials: (0 | 1)[] = [];
  const counts: number[] = [];
  for (let c = 0; c < n; c++) {
    const initial = dv.getUint8(o);
    if (initial !== 0 && initial !== 1) {
      throw new DiagnosticError('file.lwcap.initial', { channel: c, level: initial });
    }
    initials.push(initial === 1 ? 1 : 0);
    counts.push(dv.getUint32(o + 4, true));
    o += 8;
  }
  let edgeBytes = 0;
  for (let c = 0; c < n; c++) edgeBytes += counts[c]! * 4;
  if (o + edgeBytes !== buf.byteLength) {
    throw new DiagnosticError('file.lwcap.edgeBytes', {
      actual: buf.byteLength, expected: o + edgeBytes,
    });
  }
  const edges: Int32Array[] = [];
  for (let c = 0; c < n; c++) {
    const e = new Int32Array(counts[c]!);
    let previous = 0;
    for (let i = 0; i < e.length; i++) {
      const p = dv.getInt32(o, true);
      o += 4;
      if (p < 1 || p >= length) {
        throw new DiagnosticError('file.lwcap.edgeRange', {
          channel: c, index: i, value: p, length,
        });
      }
      if (i > 0 && !(p > previous)) {
        throw new DiagnosticError('file.lwcap.edgeOrder', { channel: c, index: i });
      }
      e[i] = p;
      previous = p;
    }
    edges.push(e);
  }

  // The file already IS the edge store's representation: load straight into it, no
  // sample-space expansion.
  const store = createEdgeStore(n as ChannelCount, samplerate, length,
    Array.from({ length: n }, (_, c) => ({ initial: initials[c]!, edges: edges[c]! })),
    gaps);
  return {
    store,
    channelNames: names,
    duration: length / samplerate,
    sourceDescription: source,
  };
}

/** Level of `channel` at `sample`, via a 1-bin query. */
export function levelAt(store: SampleStore, channel: number, sample: number): 0 | 1 {
  if (store.length === 0) return 0;
  const s = Math.max(0, Math.min(store.length - 1, Math.floor(sample)));
  const v = store.query(channel, s, s + 1, 1);
  return v.high[0] ? 1 : 0;
}
