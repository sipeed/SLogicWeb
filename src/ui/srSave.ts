// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Writer for sigrok `.sr` session files (session format version 2), so a capture opens
 * in PulseView / sigrok-cli. Written from the documented file layout (and checked
 * against the real captures in `fixtures/` and our reader `srLoad.ts`), not from
 * libsigrok's code:
 *
 *   version        "2"
 *   metadata       INI: [global] + [device 1] with capturefile=logic-1, total probes,
 *                  samplerate, total analog=0, probe1..probeN names, unitsize
 *   logic-1-1..K   raw samples, `unitsize` bytes each, little-endian, bit j = probe j+1
 *
 * What is exported, and what is not:
 *
 *   - Digital channels only. The caller chooses which store channels become probes (the
 *     app passes the enabled ones, in channel order); `unitsize = ceil(probes / 8)`.
 *   - Analog groups are NOT written as sigrok analog channels: in this app an analog
 *     group is a display interpretation of eight captured digital inputs (the ADC code
 *     bits), and those inputs are exported unchanged as ordinary probes. Nothing is lost,
 *     but PulseView shows the raw bits rather than volts.
 *   - No trigger position: `metadata` has no documented trigger key.
 *   - No gaps: sigrok has no "unknown" span. Inside a transfer gap each probe holds its
 *     level from before the gap and takes its post-gap level at the gap's end - the same
 *     rule `.lwcap` uses (`channelAcrossGaps`, src/data/gaps.ts).
 *
 * Memory: the samples are generated chunk by chunk (default 4 MiB) straight from each
 * channel's transition list, so the export never holds a full sample-space copy besides
 * the output itself. Callers stream the parts to a file (File System Access) or hand
 * them to a Blob as separate parts; neither concatenates them.
 *
 * Zip: one stored `version`, then every other member deflated through
 * `CompressionStream('deflate-raw')` when the runtime has it (logic data compresses by
 * orders of magnitude), stored otherwise. No ZIP64, no data descriptors - exactly the
 * subset `srLoad.ts` reads. An archive that would pass 4 GiB is refused.
 */

import { channelAcrossGaps } from '../data/index.js';
import { recordCrc32 } from '../data/opfsRecord.js';
import type { SampleStore } from '../data/types.js';
import { DiagnosticError } from '../diagnostics.js';

export interface SrProbe {
  /** Store channel index the probe reads. */
  index: number;
  name: string;
}

/** Wall-clock parts for the zip member timestamps (local time, already resolved). */
export interface LocalDateParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface SrExportOptions {
  /** Bytes of sample data per `logic-1-K` member, rounded down to a whole sample. */
  chunkBytes?: number;
  /** `deflate` needs CompressionStream; `auto` uses it when present. */
  compression?: 'auto' | 'deflate' | 'store';
  /** Member timestamps; defaults to the DOS epoch (1980-01-01 00:00:00). */
  modified?: LocalDateParts;
}

export const SR_DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
export const SR_MAX_PROBES = 128;

/** "16 MHz", "1500 kHz", "100 Hz": the largest unit whose value is a whole number. */
export function srSamplerateString(hz: number): string {
  const r = Math.round(hz);
  if (r % 1e9 === 0 && r >= 1e9) return `${r / 1e9} GHz`;
  if (r % 1e6 === 0 && r >= 1e6) return `${r / 1e6} MHz`;
  if (r % 1e3 === 0 && r >= 1e3) return `${r / 1e3} kHz`;
  return `${r} Hz`;
}

/** A probe name the INI line can carry: no line breaks/controls, never empty. */
export function srProbeName(name: string, index: number): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean.length > 0 ? clean : `D${index}`;
}

export function srMetadata(probes: readonly SrProbe[], samplerate: number): string {
  const unitsize = Math.ceil(probes.length / 8);
  const lines = [
    '[global]',
    // Informational in session files; the value is the libsigrok release line whose
    // session format (v2) this file follows.
    'sigrok version=0.5.2',
    '',
    '[device 1]',
    'capturefile=logic-1',
    `total probes=${probes.length}`,
    `samplerate=${srSamplerateString(samplerate)}`,
    'total analog=0',
    ...probes.map((p, j) => `probe${j + 1}=${srProbeName(p.name, p.index)}`),
    `unitsize=${unitsize}`,
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- samples

export interface ChannelEdges {
  initial: 0 | 1;
  edges: Int32Array;
  /** Edges at positions <= the current chunk start already consumed. */
  cursor: number;
}

/**
 * Samples [start, end) as `unitsize`-byte words. XOR-delta then prefix-XOR: each edge
 * flips its probe bit in the word where the level changes, and one pass
 * `word[i] ^= word[i-1]` turns the deltas into levels - O(edges + bytes) per chunk,
 * whatever the edge density, for any unitsize.
 */
function fillChunk(
  out: Uint8Array, start: number, end: number, unitsize: number, channels: ChannelEdges[],
): void {
  out.fill(0);
  for (let j = 0; j < channels.length; j++) {
    const ch = channels[j]!;
    const e = ch.edges;
    let k = ch.cursor;
    while (k < e.length && e[k]! <= start) k++;
    const byte = j >>> 3;
    const bit = 1 << (j & 7);
    if ((ch.initial ^ (k & 1)) === 1) out[byte]! ^= bit;
    while (k < e.length && e[k]! < end) {
      out[(e[k]! - start) * unitsize + byte]! ^= bit;
      k++;
    }
    // Edges at `end` belong to the next chunk's start word.
    ch.cursor = k;
  }
  const lane = unitsize % 4 === 0 ? 4 : unitsize % 2 === 0 ? 2 : 1;
  const words = lane === 4 ? new Uint32Array(out.buffer, out.byteOffset, out.length / 4)
    : lane === 2 ? new Uint16Array(out.buffer, out.byteOffset, out.length / 2)
      : out;
  const stride = unitsize / lane;
  for (let i = stride; i < words.length; i++) words[i]! ^= words[i - stride]!;
}

/**
 * Everything the sample generator reads, taken in one synchronous step: the length and
 * each probe's transition list. Later appends (or a Loop dropping its front) during an
 * asynchronous export cannot tear the file.
 */
export interface SrSnapshot {
  length: number;
  unitsize: number;
  channels: ChannelEdges[];
}

export function srSnapshot(store: SampleStore, probes: readonly SrProbe[]): SrSnapshot {
  return {
    length: store.length,
    unitsize: Math.ceil(probes.length / 8),
    channels: probes.map((p) => ({ ...channelAcrossGaps(store, p.index), cursor: 0 })),
  };
}

/** Generate the raw sample bytes of a snapshot, chunk by chunk. */
export function* srSampleChunks(
  snap: SrSnapshot, chunkBytes = SR_DEFAULT_CHUNK_BYTES,
): Generator<Uint8Array<ArrayBuffer>> {
  const { length, unitsize, channels } = snap;
  for (const ch of channels) ch.cursor = 0;
  const chunkSamples = Math.max(1, Math.floor(chunkBytes / unitsize));
  for (let s = 0; s < length; s += chunkSamples) {
    const e = Math.min(length, s + chunkSamples);
    const out = new Uint8Array((e - s) * unitsize);
    fillChunk(out, s, e, unitsize, channels);
    yield out;
  }
}

// ---------------------------------------------------------------- zip

function dosTime(d: LocalDateParts | undefined): { time: number; date: number } {
  if (!d || d.year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.hour << 11) | (d.minute << 5) | (d.second >>> 1),
    date: ((d.year - 1980) << 9) | (d.month << 5) | d.day,
  };
}

async function deflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await written;
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

interface CentralEntry {
  name: Uint8Array;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

const ZIP_LIMIT = 0xffffffff;

/**
 * The `.sr` archive as a sequence of byte parts, in file order. Each yielded part may be
 * written out and dropped before the next is requested.
 */
export function srExportParts(
  store: SampleStore, probes: readonly SrProbe[], options: SrExportOptions = {},
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  // Validate and snapshot NOW, not at the first next(): the caller may await between
  // creating the export and pulling parts.
  if (store.length === 0) throw new DiagnosticError('io.nothingToSave');
  if (probes.length < 1 || probes.length > SR_MAX_PROBES) {
    throw new DiagnosticError('io.srProbes', { probes: probes.length, max: SR_MAX_PROBES });
  }
  return zipParts(srSnapshot(store, probes), srMetadata(probes, store.samplerate), options);
}

async function* zipParts(
  snap: SrSnapshot, metadata: string, options: SrExportOptions,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const want = options.compression ?? 'auto';
  const deflate = want === 'deflate' ||
    (want === 'auto' && typeof CompressionStream === 'function');
  const { time, date } = dosTime(options.modified);
  const enc = new TextEncoder();
  const central: CentralEntry[] = [];
  let offset = 0;

  async function* member(nameText: string, data: Uint8Array<ArrayBuffer>, compress: boolean): AsyncGenerator<Uint8Array<ArrayBuffer>> {
    const name = enc.encode(nameText);
    const crc = recordCrc32(data);
    const body = compress ? await deflateRaw(data) : data;
    const method = compress ? 8 : 0;
    if (offset + 30 + name.length + body.length > ZIP_LIMIT) {
      throw new DiagnosticError('io.srTooLarge');
    }
    const head = new Uint8Array(30 + name.length);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, method, true);
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, body.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    dv.setUint16(28, 0, true);
    head.set(name, 30);
    central.push({ name, method, crc, compressed: body.length, size: data.length, offset });
    offset += head.length + body.length;
    yield head;
    yield body;
  }

  yield* member('version', enc.encode('2'), false);
  yield* member('metadata', enc.encode(metadata), deflate);
  let pack = 1;
  for (const chunk of srSampleChunks(snap, options.chunkBytes)) {
    yield* member(`logic-1-${pack++}`, chunk, deflate);
  }
  if (central.length > 0xffff) throw new DiagnosticError('io.srTooLarge');

  let cdSize = 0;
  for (const c of central) cdSize += 46 + c.name.length;
  if (offset + cdSize + 22 > ZIP_LIMIT) throw new DiagnosticError('io.srTooLarge');
  const cd = new Uint8Array(cdSize + 22);
  const dv = new DataView(cd.buffer);
  let o = 0;
  for (const c of central) {
    dv.setUint32(o, 0x02014b50, true);
    dv.setUint16(o + 4, 20, true);       // made by: 2.0, MS-DOS attributes
    dv.setUint16(o + 6, 20, true);       // needed
    dv.setUint16(o + 8, 0, true);
    dv.setUint16(o + 10, c.method, true);
    dv.setUint16(o + 12, time, true);
    dv.setUint16(o + 14, date, true);
    dv.setUint32(o + 16, c.crc, true);
    dv.setUint32(o + 20, c.compressed, true);
    dv.setUint32(o + 24, c.size, true);
    dv.setUint16(o + 28, c.name.length, true);
    // extra, comment, disk, internal attrs, external attrs all zero
    dv.setUint32(o + 42, c.offset, true);
    cd.set(c.name, o + 46);
    o += 46 + c.name.length;
  }
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 8, central.length, true);
  dv.setUint16(o + 10, central.length, true);
  dv.setUint32(o + 12, cdSize, true);
  dv.setUint32(o + 16, offset, true);
  yield cd;
}

/** The whole archive as a Blob built from the parts (no concatenated copy). */
export async function saveSr(
  store: SampleStore, probes: readonly SrProbe[], options: SrExportOptions = {},
): Promise<Blob> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const source = srExportParts(store, probes, options);
  for await (const p of source) parts.push(p);
  return new Blob(parts, { type: 'application/zip' });
}
