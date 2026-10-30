// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the .sr loader suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/sr-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/logicweb-sr-tests.mjs && node /tmp/logicweb-sr-tests.mjs
 *
 * Exits non-zero on the first failure. The loader (src/ui/srLoad.ts) is pinned three ways:
 *
 *   - the three real captures in fixtures/ parse to the documented shape
 *     (16 probes, 16 MHz, exact sample counts), and their edges round-trip through
 *     .lwcap byte-identical;
 *   - hand-built zips (stored and deflated, v1 and v2 member naming) parse to hand-
 *     derived edges - the zip reader cannot pass on faith;
 *   - the uart.sr edge list, framed with an independent 8N1 decoder written for this
 *     test, spells "Hello" - the generator was commanded `uart 115200 48 65 6c 6c 6f`
 *     (src/decode/tools/build-hwfixture.mjs), so this proves the whole zip -> edges
 *     path, not just the format plumbing.
 */

import { saveLwcap, loadLwcap } from '../captureIO.js';
import { createProtocolFixture } from './protocolFixture.js';
import { parseSr } from '../srLoad.js';
import { getDecoder, hydrateDecoders, validateStack } from '../../decode/registry.js';
import type { SampleStore } from '../../data/index.js';

/**
 * Node access without @types/node: the project's ambient types are the DOM's, and this
 * file is a development tool, so it reaches for node through structural types (same
 * pattern as src/data/bench/nodeglobals.ts). Run from the repository root.
 */
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: {
      exit(code: number): never;
      cwd(): string;
      getBuiltinModule?(name: string): unknown;
    };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(p: string): Uint8Array;
}

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike;
if (!fs || typeof fs.readFileSync !== 'function') {
  throw new Error('node fs module unavailable');
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function readFileAsBuffer(p: string): ArrayBuffer {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const HWCAP = `${nodeProcess.cwd()}/fixtures`;

function compareStores(a: SampleStore, b: SampleStore, tag: string): string | null {
  if (a.length !== b.length) return `${tag}: length ${a.length} != ${b.length}`;
  for (let c = 0; c < a.channelCount; c++) {
    const ea = a.edges(c, 0, a.length);
    const eb = b.edges(c, 0, b.length);
    if (ea.length !== eb.length || ea.some((v, i) => v !== eb[i])) return `${tag}: ch${c} edges differ`;
  }
  return null;
}

/** Level of one channel at sample p, straight from the edge list. */
function levelAt(edges: readonly number[], initial: number, p: number): number {
  // first edge > p
  let lo = 0, hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (edges[mid]! <= p) lo = mid + 1;
    else hi = mid;
  }
  return initial ^ (lo & 1);
}

/**
 * Independent 8N1 framer: idle high, falling edge = start bit, LSB first, one stop bit.
 * Written for this test only - deliberately shares no code with src/decode. Start bits
 * must be at least 9.5 bit periods apart (stop bit + margin), so the falling edges
 * *inside* a byte can never be mistaken for the start of the next frame.
 */
function frameUart(edges: readonly number[], initial: number, bitPeriod: number, length: number): number[] {
  const bytes: number[] = [];
  let lastStart = -Infinity;
  for (let i = 0; i < edges.length; i++) {
    const p = edges[i]!;
    if (p - lastStart < bitPeriod * 9.5) continue;
    // Falling edge: level before the flip is 1, after is 0.
    if (levelAt(edges, initial, p - 1) !== 1) continue;
    if (levelAt(edges, initial, p) !== 0) continue;
    // Real start bit: no rising edge for half a bit period.
    if (i + 1 < edges.length && edges[i + 1]! < p + bitPeriod / 2) continue;
    let byte = 0;
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) {
      const s = Math.round(p + (1.5 + k) * bitPeriod);
      if (s >= length) { ok = false; break; }
      if (levelAt(edges, initial, s) === 1) byte |= 1 << k;
    }
    if (!ok) continue;
    const stop = Math.round(p + 9.5 * bitPeriod);
    if (stop < length && levelAt(edges, initial, stop) !== 1) continue;
    bytes.push(byte);
    lastStart = p;
  }
  return bytes;
}

interface LevelTrace {
  edges: readonly number[];
  initial: number;
}

function traceOf(store: SampleStore, channel: number): LevelTrace {
  return {
    edges: Array.from(store.edges(channel, 0, store.length)),
    initial: store.query(channel, 0, 1, 1).high[0]!,
  };
}

function risingEdges(trace: LevelTrace): number[] {
  const out: number[] = [];
  for (const p of trace.edges) {
    if (levelAt(trace.edges, trace.initial, p) !== 1) continue;
    if (levelAt(trace.edges, trace.initial, p - 1) === 1) continue;
    out.push(p);
  }
  return out;
}

function spiWords(data: LevelTrace, clk: LevelTrace, cs: LevelTrace, offset: number): number[] {
  const words: number[] = [];
  let value = 0;
  let bits = 0;
  for (const edge of risingEdges(clk)) {
    if (levelAt(cs.edges, cs.initial, edge) !== 0) continue;
    value = (value << 1) | levelAt(data.edges, data.initial, edge + offset);
    bits += 1;
    if (bits === 8) {
      words.push(value);
      value = 0;
      bits = 0;
    }
  }
  return words;
}

interface I2cTransfer {
  start: number;
  stop: number;
  address: number;
  data: number[];
  acks: number[];
}

function i2cTransfer(scl: LevelTrace, sda: LevelTrace, offset: number): I2cTransfer {
  let start = -1;
  let stop = -1;
  for (const p of sda.edges) {
    if (levelAt(scl.edges, scl.initial, p) !== 1) continue;
    const before = levelAt(sda.edges, sda.initial, p - 1);
    const after = levelAt(sda.edges, sda.initial, p);
    if (before === 1 && after === 0 && start < 0) start = p;
    if (before === 0 && after === 1) stop = p;
  }
  const bits = risingEdges(scl)
    .filter((p) => p > start && p < stop)
    .map((p) => levelAt(sda.edges, sda.initial, p + offset));
  const address = bits.slice(0, 8).reduce((acc, b) => (acc << 1) | b, 0);
  const data: number[] = [];
  const acks: number[] = [];
  let i = 8;
  while (i < bits.length) {
    acks.push(bits[i]!);
    i += 1;
    if (i + 8 <= bits.length) {
      data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
      i += 8;
    }
  }
  return { start, stop, address, data, acks };
}

function hexBytes(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function asciiBytes(bytes: readonly number[]): string {
  return JSON.stringify(String.fromCharCode(...bytes));
}

// ---------------------------------------------------------------- synthetic zip

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}

function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** Minimal zip writer for the test: stored or deflated members, no CRC (the loader
 *  does not check it - the sizes are the invariant). */
async function buildZip(entries: Array<{ name: string; data: Uint8Array; deflate?: boolean }>): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let cdSize = 0;
  for (const e of entries) {
    const payload = e.deflate
      ? await (async () => {
          const s = new CompressionStream('deflate-raw');
          const w = s.writable.getWriter();
          void w.write(new Uint8Array(e.data)).then(() => w.close());
          const r = s.readable.getReader();
          const chunks: Uint8Array[] = [];
          let n = 0;
          for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            chunks.push(value);
            n += value.length;
          }
          const out = new Uint8Array(n);
          let o = 0;
          for (const c of chunks) { out.set(c, o); o += c.length; }
          return out;
        })()
      : e.data;
    const name = new TextEncoder().encode(e.name);
    const local = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(e.deflate ? 8 : 0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(payload.length), ...u32(e.data.length),
      ...u16(name.length), ...u16(0),
    ]);
    const localOffset = parts.reduce((a, p) => a + p.length, 0);
    parts.push(local, name, payload);
    const entry = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(e.deflate ? 8 : 0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(payload.length), ...u32(e.data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(localOffset),
    ]);
    central.push(entry, name);
    cdSize += entry.length + name.length;
  }
  const cdOffset = parts.reduce((a, p) => a + p.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(cdSize), ...u32(cdOffset), ...u16(0),
  ]);
  const all = [...parts, ...central, eocd];
  const total = all.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out.buffer;
}

async function main(): Promise<void> {
  let preThrew = false;
  try { getDecoder('uart'); } catch { preThrew = true; }
  await hydrateDecoders();
  const hydrated = getDecoder('uart');
  const declared = [...hydrated.channels, ...hydrated.optional_channels].map((c) => c.id);
  const hydratedOk = declared.join(',') === 'rx,tx' &&
    hydrated.annotations.length > 0 && hydrated.annotation_rows.length > 0;
  results.push({
    name: 'getDecoder guards the unhydrated path and detail hydrates on demand',
    pass: preThrew && hydratedOk,
    detail: preThrew
      ? `uart detail after hydration: channels ${declared.join('/')}, ` +
        `${hydrated.annotations.length} annotation classes`
      : 'getDecoder returned detail before hydrateDecoders() ran',
  });

  // ---------------------------------------------------------------- real files
  for (const name of ['i2c', 'spi', 'uart']) {
    const expected = name === 'uart' ? 200000 : 100000;
    const cap = await parseSr(readFileAsBuffer(`${HWCAP}/${name}.sr`), `${name}.sr`);
    const s = cap.store;
    const okShape =
      s.channelCount === 16 && s.samplerate === 16e6 && s.length === expected;
    const busy = name === 'i2c' ? [13, 15] : name === 'spi' ? [10, 11, 12] : [9];
    const edgeCounts = busy.map((c) => s.edges(c, 0, s.length).length);
    const okBusy = edgeCounts.every((n) => n > 0);
    results.push({
      name: `${name}.sr parses to the documented shape`,
      pass: okShape && okBusy,
      detail: okShape
        ? `${s.length} samples, ${s.samplerate / 1e6} MSa/s, ${s.channelCount} ch, edges on ch${busy.join(',')}: ${edgeCounts.join(',')}`
        : `channels ${s.channelCount}, rate ${s.samplerate}, length ${s.length} (want 16 / 16e6 / ${expected})`,
    });

    // Round trip: the parsed edges must survive .lwcap untouched.
    const blob = saveLwcap(s, cap.channelNames);
    const back = loadLwcap(await blob.arrayBuffer(), `${name}.rt.lwcap`);
    const fail = compareStores(s, back.store, `${name} round trip`);
    results.push({
      name: `${name}.sr round-trips through .lwcap byte-identical`,
      pass: fail === null,
      detail: fail ?? `${blob.size} bytes, all ${s.channelCount} channels`,
    });
  }

  // The known-answer control: uart.sr's D9 spells "Hello" at 115200.
  {
    const cap = await parseSr(readFileAsBuffer(`${HWCAP}/uart.sr`), 'uart.sr');
    const edges = cap.store.edges(9, 0, cap.store.length);
    const initial = cap.store.query(9, 0, 1, 1).high[0]!;
    const bytes = frameUart(Array.from(edges), initial, cap.store.samplerate / 115200, cap.store.length);
    const want = [0x48, 0x65, 0x6c, 0x6c, 0x6f];
    const ok = bytes.length >= want.length && want.every((v, i) => bytes[i] === v);
    results.push({
      name: "uart.sr's D9 frames to the generator's known answer",
      pass: ok,
      detail: ok ? `first bytes: ${bytes.map((b) => String.fromCharCode(b)).join('')}` : `got [${bytes.join(',')}] want Hello`,
    });
  }

  // ---------------------------------------------------------------- synthetic
  // 8 samples, 4 probes, unitsize 1: the bit walks are hand-derived below.
  {
    const samples = [0b0000, 0b0001, 0b0011, 0b0010, 0b0000, 0b1111, 0b0101, 0b1010];
    const data = new Uint8Array(samples);
    const metadata = [
      '[global]', 'sigrok version=test',
      '[device 1]', 'capturefile=logic-1', 'total probes=4', 'samplerate=10 kHz',
      'total analog=0', 'unitsize=1',
      'probe1=P0', 'probe2=P1', 'probe3=P2', 'probe4=P3',
      '',
    ].join('\n');
    const version = new TextEncoder().encode('2');
    const expected: Array<{ initial: number; edges: number[] }> = [
      { initial: 0, edges: [1, 3, 5, 7] },      // bit0: 0 1 1 0 0 1 1 0
      { initial: 0, edges: [2, 4, 5, 6, 7] },   // bit1: 0 0 1 1 0 1 0 1
      { initial: 0, edges: [5, 7] },            // bit2: 0 0 0 0 0 1 1 0
      { initial: 0, edges: [5, 6, 7] },         // bit3: 0 0 0 0 0 1 0 1
    ];

    for (const deflate of [false, true]) {
      const zip = await buildZip([
        { name: 'version', data: version },
        { name: 'metadata', data: new TextEncoder().encode(metadata), deflate },
        { name: 'logic-1-1', data, deflate },
      ]);
      const cap = await parseSr(zip, `synthetic-${deflate ? 'deflate' : 'stored'}.sr`);
      const s = cap.store;
      let fail = '';
      if (s.length !== 8 || s.channelCount !== 4 || s.samplerate !== 1e4) {
        fail = `length ${s.length}, ch ${s.channelCount}, rate ${s.samplerate}`;
      }
      for (let c = 0; c < 4 && !fail; c++) {
        const got = s.edges(c, 0, 8);
        const want = expected[c]!;
        if (got.length !== want.edges.length || got.some((v, i) => v !== want.edges[i])) {
          fail = `ch${c} got [${Array.from(got).join(',')}] want [${want.edges.join(',')}]`;
        }
      }
      if (!fail && cap.channelNames[0] !== 'P0') fail = `names ${cap.channelNames.join(',')}`;
      results.push({
        name: `synthetic ${deflate ? 'deflated' : 'stored'} zip parses to hand-derived edges`,
        pass: fail === '',
        detail: fail !== '' ? fail : '4 channels, 8 samples, names P0..P3',
      });
    }

    // v1 member naming: the data member is exactly the capturefile.
    const zipV1 = await buildZip([
      { name: 'version', data: new TextEncoder().encode('1') },
      { name: 'metadata', data: new TextEncoder().encode(metadata) },
      { name: 'logic-1', data },
    ]);
    const capV1 = await parseSr(zipV1, 'synthetic-v1.sr');
    const okV1 =
      capV1.store.length === 8 &&
      capV1.store.edges(0, 0, 8).length === expected[0]!.edges.length &&
      capV1.store.edges(0, 0, 8).every((v, i) => v === expected[0]!.edges[i]);
    results.push({
      name: 'v1 member naming (capturefile exactly) parses',
      pass: okV1,
      detail: okV1 ? '8 samples, 4 channels' : 'edges differ from the v2 archive',
    });
  }

  // ---------------------------------------------------------------- corrupt
  {
    const mk = (metadata: string, data?: Uint8Array) =>
      buildZip([
        { name: 'version', data: new TextEncoder().encode('2') },
        { name: 'metadata', data: new TextEncoder().encode(metadata) },
        ...(data ? [{ name: 'logic-1-1', data }] : []),
      ]);
    const base = '[device 1]\ncapturefile=logic-1\ntotal probes=4\nsamplerate=10 kHz\ntotal analog=0\nunitsize=1\n';
    const cases: Array<[string, ArrayBuffer, RegExp]> = [
      ['analog capturefile', await mk('[device 1]\ncapturefile=analog-1\ntotal probes=4\nsamplerate=10 kHz\nunitsize=1\n', new Uint8Array(16)), /not a logic unit/],
      ['no capturefile', await mk('[device 1]\ntotal probes=4\nsamplerate=10 kHz\nunitsize=1\n', new Uint8Array(16)), /no logic capturefile/],
      ['bad samplerate', await mk(base.replace('10 kHz', 'quack'), new Uint8Array(16)), /unparsable samplerate/],
      ['unitsize 17', await mk(base.replace('unitsize=1', 'unitsize=17'), new Uint8Array(16)), /outside 1..16/],
      ['zero probes', await mk(base.replace('total probes=4', 'total probes=0'), new Uint8Array(16)), /outside 1\.\.128/],
      ['no data member', await mk(base), /no data members/],
    ];
    let bad: string[] = [];
    for (const [name, zip, want] of cases) {
      try {
        await parseSr(zip, `corrupt-${name}.sr`);
        bad.push(name);
      } catch (e) {
        if (!want.test(String(e))) bad.push(`${name}: wrong error ${String(e)}`);
      }
    }
    results.push({
      name: 'corrupt sessions throw the documented errors',
      pass: bad.length === 0,
      detail: bad.length === 0 ? `${cases.length} corrupt inputs all threw correctly` : bad.join('; '),
    });

    // A truncated archive (EOCD gone) must not be mistaken for anything.
    const whole = await mk(base);
    const cut = whole.slice(0, whole.byteLength - 10);
    let truncatedThrew = false;
    try { await parseSr(cut, 'truncated.sr'); } catch { truncatedThrew = true; }
    results.push({
      name: 'a truncated archive throws',
      pass: truncatedThrew,
      detail: truncatedThrew ? 'rejected' : 'parsed without an EOCD record',
    });
  }

  {
    const fixture = createProtocolFixture();
    const s = fixture.store;
    const wantNames = ['I2C SCL', 'I2C SDA', 'SPI CLK', 'SPI MISO', 'SPI MOSI', 'SPI CS#', 'UART RX', 'UART TX'];
    const wantInitial = [1, 1, 0, 0, 0, 1, 1, 1];
    const wantEdges = [56, 8, 32, 13, 11, 2, 26, 32];
    const shape: string[] = [];
    if (s.channelCount !== 8) shape.push(`channels ${s.channelCount}`);
    if (s.samplerate !== 16e6) shape.push(`samplerate ${s.samplerate}`);
    if (s.length !== 18000) shape.push(`length ${s.length}`);
    if (fixture.channelNames.join('|') !== wantNames.join('|')) {
      shape.push(`names ${fixture.channelNames.join(',')}`);
    }
    for (let c = 0; c < fixture.channelNames.length; c++) {
      const initial = s.query(c, 0, 1, 1).high[0]!;
      const count = s.edges(c, 0, s.length).length;
      if (initial !== wantInitial[c]) shape.push(`ch${c} initial ${initial}`);
      if (count !== wantEdges[c]) shape.push(`ch${c} ${count} edges`);
    }
    results.push({
      name: 'protocol fixture has the documented eight-channel shape',
      pass: shape.length === 0,
      detail: shape.length === 0
        ? `8 ch, ${s.samplerate / 1e6} MSa/s, ${s.length} samples, edges ${wantEdges.join(',')}`
        : shape.join('; '),
    });

    const manifest: Array<{
      id: string;
      channels: string[];
      capture: number[];
      options: Record<string, string | number>;
    }> = [
      {
        id: 'i2c', channels: ['scl', 'sda'], capture: [0, 1],
        options: { address_format: 'shifted' },
      },
      {
        id: 'spi', channels: ['clk', 'miso', 'mosi', 'cs'], capture: [2, 3, 4, 5],
        options: { cs_polarity: 'active-low', cpol: 0, cpha: 0, bitorder: 'msb-first', wordsize: 8 },
      },
      {
        id: 'uart', channels: ['rx', 'tx'], capture: [6, 7],
        options: {
          baudrate: 115200, data_bits: 8, parity: 'none', stop_bits: 1,
          bit_order: 'lsb-first', format: 'ascii',
        },
      },
    ];
    const mapping: string[] = [];
    if (fixture.analyzers.length !== manifest.length) mapping.push(`${fixture.analyzers.length} analyzers`);
    for (const want of manifest) {
      const got = fixture.analyzers.find((a) => a.id === want.id);
      if (!got) {
        mapping.push(`missing ${want.id}`);
        continue;
      }
      const info = getDecoder(want.id);
      const declared = [...info.channels, ...info.optional_channels].map((c) => c.id);
      if (declared.join(',') !== want.channels.join(',')) {
        mapping.push(`${want.id} declares ${declared.join(',')}`);
      }
      const capture = Object.keys(got.channels)
        .map(Number).sort((a, b) => a - b).map((k) => got.channels[k]!);
      if (capture.join(',') !== want.capture.join(',')) {
        mapping.push(`${want.id} maps ${capture.join(',')}`);
      }
      const options = got.options ?? {};
      for (const [key, value] of Object.entries(want.options)) {
        if (options[key] !== value) mapping.push(`${want.id}.${key} is ${String(options[key])}`);
      }
      if (Object.keys(options).length !== Object.keys(want.options).length) {
        mapping.push(`${want.id} carries unexpected options`);
      }
    }
    mapping.push(...validateStack(fixture.analyzers, s.channelCount));
    results.push({
      name: 'protocol fixture analyzers match the decoder manifest and validate',
      pass: mapping.length === 0,
      detail: mapping.length === 0
        ? 'i2c scl/sda, spi clk/miso/mosi/cs, uart rx/tx on the documented options'
        : mapping.join('; '),
    });

    const scl = traceOf(s, 0);
    const sda = traceOf(s, 1);
    const i2c = i2cTransfer(scl, sda, 0);
    const i2cProblems: string[] = [];
    if (i2c.start !== 500 || i2c.stop !== 4860) i2cProblems.push(`start/stop ${i2c.start}/${i2c.stop}`);
    if (i2c.address !== 0xa0) i2cProblems.push(`address ${hexBytes([i2c.address])}`);
    if (i2c.data.join(',') !== '0,255') i2cProblems.push(`data ${hexBytes(i2c.data)}`);
    if (i2c.acks.join(',') !== '0,0,0') i2cProblems.push(`acks ${i2c.acks.join(',')}`);
    results.push({
      name: 'protocol fixture I2C lines carry START, 50 write, 00 FF and STOP',
      pass: i2cProblems.length === 0,
      detail: i2cProblems.length === 0
        ? `start ${i2c.start}, address byte a0 (0x50 write), data ${hexBytes(i2c.data)}, ${i2c.acks.length} ACKs, stop ${i2c.stop}`
        : i2cProblems.join('; '),
    });
    const i2cShifted = i2cTransfer(scl, sda, -80);
    results.push({
      name: 'sampling the I2C lines on the falling clock edge breaks the payload',
      pass: i2cShifted.address !== 0xa0 && i2cShifted.data.join(',') !== '0,255',
      detail: `falling-edge sampling reads address ${hexBytes([i2cShifted.address])} and data ${hexBytes(i2cShifted.data)}`,
    });

    const spiClk = traceOf(s, 2);
    const spiCs = traceOf(s, 5);
    const miso = spiWords(traceOf(s, 3), spiClk, spiCs, 0);
    const mosi = spiWords(traceOf(s, 4), spiClk, spiCs, 0);
    const clocks = risingEdges(spiClk)
      .filter((p) => levelAt(spiCs.edges, spiCs.initial, p) === 0).length;
    const spiProblems: string[] = [];
    if (mosi.join(',') !== `${0xde},${0xad}`) spiProblems.push(`MOSI ${hexBytes(mosi)}`);
    if (miso.join(',') !== `${0x5a},${0xa5}`) spiProblems.push(`MISO ${hexBytes(miso)}`);
    if (clocks !== 16) spiProblems.push(`${clocks} clock edges while CS# is low`);
    if (spiCs.edges.join(',') !== '7000,10040') spiProblems.push(`CS# spans ${spiCs.edges.join(',')}`);
    const clkFirst = spiClk.edges[0]!;
    const clkLast = spiClk.edges[spiClk.edges.length - 1]!;
    if (clkFirst !== 7400 || clkLast !== 9880) spiProblems.push(`clocks span ${clkFirst}..${clkLast}`);
    results.push({
      name: 'protocol fixture SPI carries DE AD on MOSI and 5A A5 on MISO',
      pass: spiProblems.length === 0,
      detail: spiProblems.length === 0
        ? `MOSI ${hexBytes(mosi)}, MISO ${hexBytes(miso)}, ${clocks} clocks under CS#`
        : spiProblems.join('; '),
    });
    const spiShifted = spiWords(traceOf(s, 4), spiClk, spiCs, 80);
    results.push({
      name: 'sampling SPI on the falling clock edge breaks the MOSI word',
      pass: spiShifted.join(',') !== `${0xde},${0xad}`,
      detail: `falling-edge sampling reads ${hexBytes(spiShifted)}`,
    });

    const uartBit = s.samplerate / 115200;
    const uartRx = traceOf(s, 6);
    const uartTx = traceOf(s, 7);
    const rx = frameUart(uartRx.edges, uartRx.initial, uartBit, s.length);
    const tx = frameUart(uartTx.edges, uartTx.initial, uartBit, s.length);
    const uartProblems: string[] = [];
    if (String.fromCharCode(...rx) !== 'OK\r\n') uartProblems.push(`RX ${asciiBytes(rx)}`);
    if (String.fromCharCode(...tx) !== 'Hello') uartProblems.push(`TX ${asciiBytes(tx)}`);
    const rxSpan = `${uartRx.edges[0]}..${uartRx.edges[uartRx.edges.length - 1]}`;
    const txSpan = `${uartTx.edges[0]}..${uartTx.edges[uartTx.edges.length - 1]}`;
    if (rxSpan !== '8000..13417') uartProblems.push(`RX frames span ${rxSpan}`);
    if (txSpan !== '8000..14806') uartProblems.push(`TX frames span ${txSpan}`);
    results.push({
      name: 'protocol fixture UART frames carry Hello and OK at 115200',
      pass: uartProblems.length === 0,
      detail: uartProblems.length === 0
        ? `RX ${asciiBytes(rx)} ${rxSpan}, TX ${asciiBytes(tx)} ${txSpan}, ${rx.length + tx.length} frames`
        : uartProblems.join('; '),
    });
    const slow = frameUart(uartTx.edges, uartTx.initial, s.samplerate / 57600, s.length);
    results.push({
      name: 'framing the fixture UART at half the baud rate breaks the payload',
      pass: String.fromCharCode(...slow) !== 'Hello',
      detail: `57600 baud reads ${asciiBytes(slow)}`,
    });

    const blob = saveLwcap(s, fixture.channelNames);
    const back = loadLwcap(await blob.arrayBuffer(), 'protocol-fixture.lwcap');
    const roundTrip = compareStores(s, back.store, 'protocol fixture round trip')
      ?? (back.store.samplerate === s.samplerate ? null : `samplerate ${back.store.samplerate}`)
      ?? (back.channelNames.join('|') === fixture.channelNames.join('|')
        ? null : `names ${back.channelNames.join(',')}`);
    results.push({
      name: 'protocol fixture round-trips through .lwcap byte-identical',
      pass: roundTrip === null,
      detail: roundTrip ?? `${blob.size} bytes, all ${s.channelCount} channels and names`,
    });
  }

  const decodeText = (p: string) => new TextDecoder().decode(readFileAsBuffer(`${nodeProcess.cwd()}/${p}`));
  const clientSrc = decodeText('src/decode/client.ts');
  const workerSrc = decodeText('src/decode/worker.ts');
  const fillNeedle = 'result.instances = request.stack.map(s => getDecoder(s.id))';
  const instanceProblems: string[] = [];
  if (!clientSrc.includes(fillNeedle)) instanceProblems.push('client does not attach instances from request.stack');
  if (/from ['"]\.\/registry(\.js)?['"]/.test(workerSrc)) instanceProblems.push('worker imports the registry');
  results.push({
    name: 'decode client attaches instance metadata and the worker ships no registry',
    pass: instanceProblems.length === 0,
    detail: instanceProblems.length === 0
      ? 'client.ts fills result.instances from request.stack; worker.ts has no registry import'
      : instanceProblems.join('; '),
  });

  console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  nodeProcess.exit(failed === 0 ? 0 : 1);
}

void main();
