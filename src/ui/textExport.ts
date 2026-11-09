// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Text exports of the digital channels: VCD (value change dump, IEEE 1364 §18) for
 * GTKWave / PulseView / simulators, and CSV for spreadsheets and scripts.
 *
 * Both are built from each channel's transition list (`channelAcrossGaps`, the same
 * gap rule `.lwcap` and `.sr` use: inside a transfer gap a channel keeps its pre-gap level
 * and takes its post-gap level at the gap's end). Samples are never materialised: the
 * channels' edges are merged in time order through a small heap, so the work is
 * O(edges * log channels) whatever the capture length. The text is emitted in bounded
 * chunks (default 256 Ki characters), each encoded and yielded on its own; callers write
 * them to a file stream or hand them to a Blob as separate parts, never concatenated.
 *
 * VCD: `$timescale` is the largest unit (1/10/100 s..fs) in which one sample period is a
 * whole number of ticks, so every edge lands on an exact time. A rate with no such unit
 * (e.g. 3 MHz, period 333.3 ns) falls back to 1 ps with times rounded to the nearest
 * tick; consecutive samples still get distinct, ordered times for any rate up to 1 THz.
 * One `$var wire 1` per channel (the name with whitespace replaced by `_`), identifier
 * codes `!`, `"`, ... (base 94), `$dumpvars` with every channel's level at #0, one `#t`
 * block per distinct edge time, and a final `#t` at the capture's end so viewers know its
 * length. Gaps are not marked `x`; see above.
 *
 * CSV: one row per transition, not per sample - a per-sample table of a 100 MS/s
 * capture would be gigabytes of repeated levels. Columns `time_s,sample,channel,level`:
 * first each channel's initial level at sample 0 (so a channel that never toggles is
 * still listed and every level is explicit), then every transition in time order (ties
 * in channel order) with the level it switches TO. Rows = 1 header + channels + edges.
 * Channel names are quoted when needed, and a name that a spreadsheet would read as a
 * formula (`=`, `+`, `-`, `@`, tab, CR) is prefixed with `'`.
 */

import { channelAcrossGaps } from '../data/index.js';
import type { SampleStore } from '../data/types.js';
import { DiagnosticError } from '../diagnostics.js';

export interface ExportChannel {
  /** Store channel index. */
  index: number;
  name: string;
}

export interface TextExportOptions {
  /** Characters of text per yielded part (a part may exceed it by one line). */
  chunkChars?: number;
}

export interface VcdExportOptions extends TextExportOptions {
  /** `$date` text; omitted when absent (keeps tests deterministic). */
  date?: string;
}

export const TEXT_EXPORT_CHUNK_CHARS = 256 * 1024;

interface Snapshot {
  length: number;
  samplerate: number;
  names: string[];
  indices: number[];
  initial: Array<0 | 1>;
  edges: Int32Array[];
}

/** Validate and take everything the generator reads now, before the first await. */
function snapshot(store: SampleStore, channels: readonly ExportChannel[]): Snapshot {
  if (store.length === 0) throw new DiagnosticError('io.nothingToSave');
  if (channels.length === 0) throw new DiagnosticError('io.exportNoChannels');
  const initial: Array<0 | 1> = [];
  const edges: Int32Array[] = [];
  for (const c of channels) {
    const ch = channelAcrossGaps(store, c.index);
    initial.push(ch.initial);
    edges.push(ch.edges);
  }
  return {
    length: store.length,
    samplerate: store.samplerate,
    names: channels.map((c) => c.name),
    indices: channels.map((c) => c.index),
    initial,
    edges,
  };
}

/**
 * k-way merge of the channels' edge lists: `next()` advances to the next edge in time
 * order (ties in channel order) and exposes it as `pos`/`channel`.
 */
export class EdgeMerger {
  pos = -1;
  channel = -1;
  private readonly cursor: Int32Array;
  private readonly heap: number[] = [];

  constructor(private readonly edges: readonly Int32Array[]) {
    this.cursor = new Int32Array(edges.length);
    for (let c = 0; c < edges.length; c++) if (edges[c]!.length > 0) this.push(c);
  }

  next(): boolean {
    const heap = this.heap;
    if (heap.length === 0) return false;
    const c = heap[0]!;
    this.channel = c;
    this.pos = this.edges[c]![this.cursor[c]!]!;
    this.cursor[c]!++;
    const last = heap.pop()!;
    if (heap.length > 0) { heap[0] = last; this.down(0); }
    if (this.cursor[c]! < this.edges[c]!.length) this.push(c);
    return true;
  }

  private key(c: number): number {
    return this.edges[c]![this.cursor[c]!]!;
  }

  private less(a: number, b: number): boolean {
    const ka = this.key(a);
    const kb = this.key(b);
    return ka < kb || (ka === kb && a < b);
  }

  private push(c: number): void {
    const heap = this.heap;
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(heap[i]!, heap[parent]!)) break;
      [heap[i], heap[parent]] = [heap[parent]!, heap[i]!];
      i = parent;
    }
  }

  private down(i: number): void {
    const heap = this.heap;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && this.less(heap[l]!, heap[m]!)) m = l;
      if (r < heap.length && this.less(heap[r]!, heap[m]!)) m = r;
      if (m === i) return;
      [heap[i], heap[m]] = [heap[m]!, heap[i]!];
      i = m;
    }
  }
}

/** Collects text and hands out encoded parts once `limit` characters are buffered. */
class Chunker {
  private buf = '';
  private readonly enc = new TextEncoder();
  constructor(private readonly limit: number) {}
  add(s: string): Uint8Array<ArrayBuffer> | null {
    this.buf += s;
    return this.buf.length >= this.limit ? this.flush() : null;
  }
  flush(): Uint8Array<ArrayBuffer> | null {
    if (this.buf.length === 0) return null;
    const out = this.enc.encode(this.buf) as Uint8Array<ArrayBuffer>;
    this.buf = '';
    return out;
  }
}

// ---------------------------------------------------------------- VCD

export interface VcdTimescale {
  /** e.g. "100 ps" */
  label: string;
  /** Ticks of `label` per sample period. */
  ticksPerSample: number;
  /** False when the period is not a whole number of ticks (times are rounded). */
  exact: boolean;
}

const VCD_UNITS: ReadonlyArray<[string, number]> = [
  ['s', 0], ['ms', 3], ['us', 6], ['ns', 9], ['ps', 12], ['fs', 15],
];

export function vcdTimescale(samplerate: number): VcdTimescale {
  for (const [unit, exp] of VCD_UNITS) {
    for (const mult of [100, 10, 1]) {
      // ticks = period / (mult * 10^-exp) = 10^exp / (mult * rate)
      const ticks = 10 ** exp / (mult * samplerate);
      const whole = Math.round(ticks);
      if (whole >= 1 && Math.abs(ticks - whole) < 1e-6) {
        return { label: `${mult} ${unit}`, ticksPerSample: whole, exact: true };
      }
    }
  }
  return { label: '1 ps', ticksPerSample: 1e12 / samplerate, exact: false };
}

/** Time of sample `p` in timescale ticks, as decimal text (BigInt past 2^53). */
function vcdTime(p: number, ts: VcdTimescale, samplerate: number): string {
  if (ts.exact) {
    const t = p * ts.ticksPerSample;
    return Number.isSafeInteger(t) ? String(t) : (BigInt(p) * BigInt(ts.ticksPerSample)).toString();
  }
  const t = p * 1e12 / samplerate;
  if (t < 2 ** 52 || !Number.isInteger(samplerate)) return String(Math.round(t));
  const rate = BigInt(samplerate);
  return ((BigInt(p) * 10n ** 12n * 2n + rate) / (2n * rate)).toString();
}

/** VCD identifier code `i`: `!`..`~`, then `!!`, `"!`, ... (bijective base 94). */
export function vcdIdentifier(i: number): string {
  let s = '';
  let n = i;
  do {
    s += String.fromCharCode(33 + (n % 94));
    n = Math.floor(n / 94) - 1;
  } while (n >= 0);
  return s;
}

/** A `$var` reference: no whitespace, never empty. */
export function vcdName(name: string, index: number): string {
  const clean = name.replace(/[\s\u0000-\u001f\u007f]+/g, '_').replace(/^_+|_+$/g, '');
  return clean.length > 0 ? clean : `D${index}`;
}

/**
 * The VCD as encoded parts. Not itself a generator: the store is validated and
 * snapshotted at the call (like srExportParts), so a live capture appending while the
 * caller awaits the file cannot tear the export.
 */
export function vcdExportParts(
  store: SampleStore, channels: readonly ExportChannel[], options: VcdExportOptions = {},
): Generator<Uint8Array<ArrayBuffer>, void> {
  return vcdParts(snapshot(store, channels), options);
}

function* vcdParts(snap: Snapshot, options: VcdExportOptions): Generator<Uint8Array<ArrayBuffer>, void> {
  const chunk = new Chunker(options.chunkChars ?? TEXT_EXPORT_CHUNK_CHARS);
  const ts = vcdTimescale(snap.samplerate);
  const ids = snap.names.map((_, j) => vcdIdentifier(j));
  const head: string[] = [];
  if (options.date !== undefined) head.push(`$date\n  ${options.date.replace(/\$end/g, '')}\n$end`);
  head.push('$version slogicweb $end');
  head.push(`$comment samplerate ${snap.samplerate} Hz, ${snap.length} samples` +
    `${ts.exact ? '' : ', times rounded to 1 ps'} $end`);
  head.push(`$timescale ${ts.label} $end`);
  head.push('$scope module slogicweb $end');
  for (let j = 0; j < ids.length; j++) {
    head.push(`$var wire 1 ${ids[j]} ${vcdName(snap.names[j]!, snap.indices[j]!)} $end`);
  }
  head.push('$upscope $end', '$enddefinitions $end', '#0', '$dumpvars');
  for (let j = 0; j < ids.length; j++) head.push(`${snap.initial[j]}${ids[j]}`);
  head.push('$end', '');
  let part = chunk.add(head.join('\n'));
  if (part) yield part;

  const level = Uint8Array.from(snap.initial);
  const merger = new EdgeMerger(snap.edges);
  let lastPos = 0;
  while (merger.next()) {
    const p = merger.pos;
    const j = merger.channel;
    level[j]! ^= 1;
    const line = p !== lastPos
      ? `#${vcdTime(p, ts, snap.samplerate)}\n${level[j]}${ids[j]}\n`
      : `${level[j]}${ids[j]}\n`;
    lastPos = p;
    part = chunk.add(line);
    if (part) yield part;
  }
  part = chunk.add(`#${vcdTime(snap.length, ts, snap.samplerate)}\n`);
  if (part) yield part;
  part = chunk.flush();
  if (part) yield part;
}

// ---------------------------------------------------------------- CSV

/** A CSV field: quoted when it must be, and never read as a spreadsheet formula. */
export function csvField(text: string): string {
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Fixed-point seconds with sub-sample resolution (3 digits past the period). */
function csvSeconds(p: number, samplerate: number, digits: number): string {
  return (p / samplerate).toFixed(digits);
}

/** The CSV as encoded parts; snapshotted at the call, like `vcdExportParts`. */
export function csvExportParts(
  store: SampleStore, channels: readonly ExportChannel[], options: TextExportOptions = {},
): Generator<Uint8Array<ArrayBuffer>, void> {
  return csvParts(snapshot(store, channels), options);
}

function* csvParts(snap: Snapshot, options: TextExportOptions): Generator<Uint8Array<ArrayBuffer>, void> {
  const chunk = new Chunker(options.chunkChars ?? TEXT_EXPORT_CHUNK_CHARS);
  const digits = Math.min(20, Math.max(0, Math.ceil(Math.log10(snap.samplerate))) + 3);
  const names = snap.names.map(csvField);
  const zero = csvSeconds(0, snap.samplerate, digits);
  let part = chunk.add('time_s,sample,channel,level\n');
  if (part) yield part;
  for (let j = 0; j < names.length; j++) {
    part = chunk.add(`${zero},0,${names[j]},${snap.initial[j]}\n`);
    if (part) yield part;
  }
  const level = Uint8Array.from(snap.initial);
  const merger = new EdgeMerger(snap.edges);
  while (merger.next()) {
    const p = merger.pos;
    const j = merger.channel;
    level[j]! ^= 1;
    part = chunk.add(`${csvSeconds(p, snap.samplerate, digits)},${p},${names[j]},${level[j]}\n`);
    if (part) yield part;
  }
  part = chunk.flush();
  if (part) yield part;
}
