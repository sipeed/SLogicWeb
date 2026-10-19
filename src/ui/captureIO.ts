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
import type { DecoderInstance } from '../decode/types.js';
import { isChannelCount, type ChannelCount } from '../types.js';
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
  if (files.length === 0) throw new Error('no files selected');

  const lw = files.find((f) => f.name.toLowerCase().endsWith('.lwcap'));
  if (lw) return loadLwcap(await lw.arrayBuffer(), lw.name);

  const sr = files.find((f) => f.name.toLowerCase().endsWith('.sr'));
  if (sr) return parseSr(await sr.arrayBuffer(), sr.name);

  throw new Error(
    `nothing loadable in ${files.map((f) => f.name).join(', ')}. ` +
    `Expected a sigrok .sr session or a .lwcap.`);
}

export interface ProtocolDemoCapture {
  store: SampleStore;
  channelNames: string[];
  analyzers: DecoderInstance[];
}

const DEMO_SAMPLERATE = 16_000_000;
const DEMO_SAMPLES = 18_000;
const DEMO_I2C_START = 500;
const DEMO_I2C_BIT = 160;
const DEMO_SPI_START = 7000;
const DEMO_SPI_BIT = 160;
const DEMO_UART_START = 8000;
const DEMO_UART_BAUD = 115200;

interface TraceWriter {
  initial: 0 | 1;
  edges: number[];
  set(at: number, level: 0 | 1): void;
}

function demoChannel(initial: 0 | 1): TraceWriter {
  const edges: number[] = [];
  let level = initial;
  return {
    initial,
    edges,
    set(at, next) {
      if (next === level) return;
      if (!Number.isInteger(at)) throw new Error(`transition at ${at} is not a sample`);
      const last = edges.length > 0 ? edges[edges.length - 1]! : 0;
      if (!(at > last)) throw new Error(`transition at ${at} does not follow ${last}`);
      edges.push(at);
      level = next;
    },
  };
}

function writeUartFrames(w: TraceWriter, start: number, bitPeriod: number, bytes: readonly number[]): void {
  bytes.forEach((byte, frame) => {
    const t = start + frame * 10 * bitPeriod;
    w.set(Math.round(t), 0);
    for (let bit = 0; bit < 8; bit++) {
      w.set(Math.round(t + (1 + bit) * bitPeriod), ((byte >> bit) & 1) as 0 | 1);
    }
    w.set(Math.round(t + 9 * bitPeriod), 1);
  });
}

function writeI2cTransfer(
  scl: TraceWriter, sda: TraceWriter, start: number, bit: number,
  address: number, data: readonly number[],
): void {
  const bits: number[] = [];
  for (let b = 7; b >= 0; b--) bits.push(((address << 1) >> b) & 1);
  bits.push(0);
  for (const byte of data) {
    for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
    bits.push(0);
  }
  sda.set(start, 0);
  scl.set(start + bit / 2, 0);
  bits.forEach((value, k) => {
    sda.set(start + bit / 2 + 10 + k * bit, value as 0 | 1);
    scl.set(start + bit + k * bit, 1);
    scl.set(start + bit + bit / 2 + k * bit, 0);
  });
  const last = bits.length - 1;
  sda.set(start + bit + bit / 4 + last * bit, 1);
  scl.set(start + 2 * bit + last * bit, 1);
}

function writeSpiTransfer(
  clk: TraceWriter, miso: TraceWriter, mosi: TraceWriter, cs: TraceWriter,
  start: number, bit: number, misoBytes: readonly number[], mosiBytes: readonly number[],
): void {
  const misoBits: number[] = [];
  const mosiBits: number[] = [];
  for (const byte of misoBytes) for (let b = 7; b >= 0; b--) misoBits.push((byte >> b) & 1);
  for (const byte of mosiBytes) for (let b = 7; b >= 0; b--) mosiBits.push((byte >> b) & 1);
  const words = Math.max(misoBits.length, mosiBits.length);
  cs.set(start, 0);
  for (let k = 0; k < words; k++) {
    const rise = start + bit * 5 / 2 + k * bit;
    miso.set(rise - bit / 2, (misoBits[k] ?? 0) as 0 | 1);
    mosi.set(rise - bit / 2, (mosiBits[k] ?? 0) as 0 | 1);
    clk.set(rise, 1);
    clk.set(rise + bit / 2, 0);
  }
  cs.set(start + bit * 5 / 2 + words * bit + bit / 2, 1);
}

export function createProtocolDemoCapture(): ProtocolDemoCapture {
  const i2cScl = demoChannel(1);
  const i2cSda = demoChannel(1);
  const spiClk = demoChannel(0);
  const spiMiso = demoChannel(0);
  const spiMosi = demoChannel(0);
  const spiCs = demoChannel(1);
  const uartRx = demoChannel(1);
  const uartTx = demoChannel(1);

  writeI2cTransfer(i2cScl, i2cSda, DEMO_I2C_START, DEMO_I2C_BIT, 0x50, [0x00, 0xff]);
  writeSpiTransfer(spiClk, spiMiso, spiMosi, spiCs, DEMO_SPI_START, DEMO_SPI_BIT,
    [0x5a, 0xa5], [0xde, 0xad]);
  const uartBit = DEMO_SAMPLERATE / DEMO_UART_BAUD;
  writeUartFrames(uartRx, DEMO_UART_START, uartBit, [0x4f, 0x4b, 0x0d, 0x0a]);
  writeUartFrames(uartTx, DEMO_UART_START, uartBit, [0x48, 0x65, 0x6c, 0x6c, 0x6f]);

  const traces = [i2cScl, i2cSda, spiClk, spiMiso, spiMosi, spiCs, uartRx, uartTx];
  return {
    store: createEdgeStore(8, DEMO_SAMPLERATE, DEMO_SAMPLES,
      traces.map((t) => ({ initial: t.initial, edges: Int32Array.from(t.edges) }))),
    channelNames: ['I2C SCL', 'I2C SDA', 'SPI CLK', 'SPI MISO', 'SPI MOSI', 'SPI CS#', 'UART RX', 'UART TX'],
    analyzers: [
      { id: 'i2c', channels: { 0: 0, 1: 1 }, options: { address_format: 'shifted' } },
      {
        id: 'spi', channels: { 0: 2, 1: 3, 2: 4, 3: 5 },
        options: { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize: 8 },
      },
      {
        id: 'uart', channels: { 0: 6, 1: 7 },
        options: {
          baudrate: DEMO_UART_BAUD, data_bits: 8, parity: 'none', stop_bits: 1,
          bit_order: 'lsb-first', format: 'ascii',
        },
      },
    ],
  };
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

export function loadLwcap(buf: ArrayBuffer, source: string): LoadedCapture {
  const dv = new DataView(buf);
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(dv.getUint8(i));
  if (magic !== LWCAP_MAGIC_V1 && magic !== LWCAP_MAGIC_V2) {
    throw new Error(`not a .lwcap file (magic ${JSON.stringify(magic)})`);
  }
  const n = dv.getUint32(8, true);
  if (!isChannelCount(n)) throw new Error(`channelCount ${n} is not a supported width (4/8/16/32/64/128)`);
  const gapCount = dv.getUint32(12, true);
  const samplerate = dv.getFloat64(16, true);
  const length = dv.getFloat64(24, true);
  if (!(length >= 0) || length >= MAX_SAMPLES) throw new Error(`implausible length ${length}`);
  const nameLen = dv.getUint32(32, true);
  if (36 + nameLen > buf.byteLength) throw new Error(`truncated .lwcap (name blob of ${nameLen} past end)`);
  const names = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 36, nameLen))) as string[];

  let o = 36 + nameLen;
  const gaps: GapSpan[] = [];
  for (let g = 0; g < gapCount; g++) {
    if (o + 8 > buf.byteLength) throw new Error(`truncated .lwcap (gap span ${g} past end)`);
    const s = dv.getUint32(o, true);
    const e = dv.getUint32(o + 4, true);
    o += 8;
    if (!(e > s) || e > length) throw new Error(`corrupt gap span [${s}, ${e}) in ${source}`);
    if (g > 0) {
      const prev = gaps[g - 1]!;
      if (!(s > prev.endSample)) throw new Error(`gap spans overlap or unsorted at index ${g}`);
    }
    gaps.push({ startSample: s, endSample: e });
  }
  if (o + n * 8 > buf.byteLength) throw new Error('truncated .lwcap (channel headers past end)');
  const initials: number[] = [];
  const counts: number[] = [];
  for (let c = 0; c < n; c++) {
    initials.push(dv.getUint8(o));
    counts.push(dv.getUint32(o + 4, true));
    o += 8;
  }
  let edgeBytes = 0;
  for (let c = 0; c < n; c++) edgeBytes += counts[c]! * 4;
  if (o + edgeBytes !== buf.byteLength) {
    throw new Error(`truncated or trailing bytes in .lwcap (${buf.byteLength} vs ${o + edgeBytes})`);
  }
  const edges: Int32Array[] = [];
  for (let c = 0; c < n; c++) {
    const e = new Int32Array(counts[c]!);
    for (let i = 0; i < e.length; i++) { e[i] = dv.getInt32(o, true); o += 4; }
    edges.push(e);
  }

  // The file already IS the edge store's representation: load straight into it, no
  // sample-space expansion.
  const store = createEdgeStore(n as ChannelCount, samplerate, length,
    Array.from({ length: n }, (_, c) => ({ initial: initials[c]! as 0 | 1, edges: edges[c]! })),
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
