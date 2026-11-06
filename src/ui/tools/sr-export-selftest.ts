// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `.sr` export (src/ui/srSave.ts) and the default save name (src/ui/captureFileName.ts).
 *
 *   npm test -- --filter sr-export
 *
 * Pinned four ways:
 *   - generated stores of every supported width (incl. a 24-probe subset, unitsize 3,
 *     and gap spans), cut into tiny chunks so edges land on chunk boundaries, export
 *     stored and deflated and re-parse through the existing reader (srLoad.ts) with
 *     identical edges, names and samplerate;
 *   - the fixtures load -> export -> reload equal, and the exported uart.sr sample member
 *     is byte-identical to the original's (same CRC32 as the original zip records);
 *   - every member CRC is checked with node's zlib, independently of our CRC table
 *     (the reader does not check CRCs, so a wrong one would otherwise pass);
 *   - the default file name, with injected local-time parts.
 */

import { channelAcrossGaps, createEdgeStore, createSampleStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import type { ChannelCount } from '../../types.js';
import { diagnosticOf } from '../../diagnostics.js';
import { parseSr } from '../srLoad.js';
import {
  saveSr, srExportParts, srMetadata, srProbeName, srSamplerateString, type SrProbe,
} from '../srSave.js';
import {
  captureFileName, fileBaseName, formatForFileName, localDateParts, rateToken, saveFilePickerTypes,
} from '../captureFileName.js';

const nodeProcess = (globalThis as {
  process?: { exit(code: number): never; cwd(): string; getBuiltinModule?(name: string): unknown };
}).process!;
const fs = nodeProcess.getBuiltinModule?.('fs') as { readFileSync(p: string): Uint8Array };
const zlib = nodeProcess.getBuiltinModule?.('zlib') as {
  crc32?(data: Uint8Array): number;
  inflateRawSync(data: Uint8Array): Uint8Array;
};

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`PASS  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

function readBuf(p: string): ArrayBuffer {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Minimal independent central-directory walk: name -> raw member bytes + crc. */
function members(buf: ArrayBuffer): Map<string, { method: number; crc: number; data: Uint8Array }> {
  const dv = new DataView(buf);
  let eocd = buf.byteLength - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const count = dv.getUint16(eocd + 10, true);
  let o = dv.getUint32(eocd + 16, true);
  const out = new Map<string, { method: number; crc: number; data: Uint8Array }>();
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(o + 10, true);
    const crc = dv.getUint32(o + 16, true);
    const csize = dv.getUint32(o + 20, true);
    const nameLen = dv.getUint16(o + 28, true);
    const extra = dv.getUint16(o + 30, true);
    const comment = dv.getUint16(o + 32, true);
    const local = dv.getUint32(o + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, o + 46, nameLen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = new Uint8Array(buf, start, csize);
    out.set(name, { method, crc, data: method === 8 ? zlib.inflateRawSync(raw) : raw.slice() });
    o += 46 + nameLen + extra + comment;
  }
  return out;
}

function crcProblems(buf: ArrayBuffer): string[] {
  if (typeof zlib.crc32 !== 'function') return [];
  const bad: string[] = [];
  for (const [name, m] of members(buf)) {
    if ((zlib.crc32(m.data) >>> 0) !== m.crc) bad.push(name);
  }
  return bad;
}

/** Deterministic pseudo-random levels with bursts of edges and long idle runs. */
function generatedStore(width: ChannelCount, length: number, seed: number, gaps = false): SampleStore {
  let x = seed >>> 0 || 1;
  const rnd = (): number => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
  const channels = Array.from({ length: width }, (_, c) => {
    const edges: number[] = [];
    let p = 0;
    const meanGap = 1 + (c % 7) * 3;
    for (;;) {
      p += 1 + Math.floor(rnd() * meanGap * 2);
      if (p >= length) break;
      edges.push(p);
    }
    return { initial: (c & 1) as 0 | 1, edges: new Int32Array(edges) };
  });
  const spans = gaps ? [{ startSample: Math.floor(length / 3), endSample: Math.floor(length / 3) + 17 }] : undefined;
  return createEdgeStore(width, 25e6, length, channels, spans);
}

function sameEdges(a: Int32Array, b: Int32Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function roundTrip(
  tag: string, store: SampleStore, probes: SrProbe[], chunkBytes: number,
  compression: 'store' | 'deflate',
): Promise<void> {
  const blob = await saveSr(store, probes, { chunkBytes, compression });
  const buf = await blob.arrayBuffer();
  const back = await parseSr(buf, `${tag}.sr`);
  const problems: string[] = [];
  if (back.store.length !== store.length) problems.push(`length ${back.store.length} != ${store.length}`);
  if (back.store.samplerate !== store.samplerate) problems.push(`rate ${back.store.samplerate}`);
  probes.forEach((p, j) => {
    if (back.channelNames[j] !== srProbeName(p.name, p.index)) problems.push(`name ${j} ${back.channelNames[j]}`);
    const want = channelAcrossGaps(store, p.index);
    const got = channelAcrossGaps(back.store, j);
    if (got.initial !== want.initial || !sameEdges(got.edges, want.edges)) problems.push(`probe ${j} (ch${p.index}) edges`);
  });
  const crc = crcProblems(buf);
  if (crc.length) problems.push(`crc ${crc.join(',')}`);
  check(`${tag} round-trips (${compression}, ${probes.length} probes, ${blob.size} B)`,
    problems.length === 0, problems.slice(0, 5).join('; '));
}

async function main(): Promise<void> {
  // ------------------------------------------------------------ metadata
  check('samplerate strings use whole units', [16e6, 1.5e6, 100, 1e9, 250e3]
    .map(srSamplerateString).join('|') === '16 MHz|1500 kHz|100 Hz|1 GHz|250 kHz');
  const meta = srMetadata([{ index: 0, name: 'SDA' }, { index: 3, name: 'bad\nname' }, { index: 5, name: ' ' }], 16e6);
  check('metadata has the session-v2 device keys',
    meta.includes('capturefile=logic-1\ntotal probes=3\nsamplerate=16 MHz\ntotal analog=0\n' +
      'probe1=SDA\nprobe2=bad name\nprobe3=D5\nunitsize=1\n'), meta);

  // ------------------------------------------------------------ generated stores
  for (const width of [4, 8, 16, 32, 64, 128] as ChannelCount[]) {
    const store = generatedStore(width, 3001, width * 7 + 1);
    const probes = Array.from({ length: width }, (_, c) => ({ index: c, name: `S${c}` }));
    const unitsize = Math.ceil(width / 8);
    // A chunk that is not a whole multiple of anything interesting.
    await roundTrip(`${width}ch`, store, probes, unitsize * 97, 'store');
    await roundTrip(`${width}ch`, store, probes, unitsize * 1000, 'deflate');
  }
  {
    // 24 of 32 enabled, out of order indices skipped: unitsize 3, the byte-lane path.
    const store = generatedStore(32, 5000, 99);
    const probes = Array.from({ length: 32 }, (_, c) => ({ index: c, name: `N${c}` }))
      .filter((p) => p.index % 4 !== 1);
    await roundTrip('24-of-32 subset', store, probes, 3 * 11, 'deflate');
    await roundTrip('single probe', store, [{ index: 7, name: 'CLK' }], 13, 'store');
  }
  {
    const store = generatedStore(16, 4000, 5, true);
    const probes = Array.from({ length: 16 }, (_, c) => ({ index: c, name: `G${c}` }));
    await roundTrip('gap store', store, probes, 2 * 50, 'store');
  }
  {
    // A sample store (not an edge store) built by appending raw words.
    const store = createSampleStore(8, 1e6);
    const raw = new Uint8Array(777);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) ^ (i >>> 3);
    store.append(raw);
    const probes = Array.from({ length: 8 }, (_, c) => ({ index: c, name: `D${c}` }));
    const blob = await saveSr(store, probes, { chunkBytes: 100, compression: 'deflate' });
    const m = members(await blob.arrayBuffer());
    const data: number[] = [];
    for (let k = 1; m.has(`logic-1-${k}`); k++) data.push(...m.get(`logic-1-${k}`)!.data);
    check('appended 8-ch store exports its raw bytes exactly across 8 chunks',
      data.length === raw.length && data.every((v, i) => v === raw[i]) && m.has('logic-1-8') && !m.has('logic-1-9'),
      `${data.length} bytes`);
    check('version member is stored "2"', m.get('version')?.method === 0 &&
      new TextDecoder().decode(m.get('version')!.data) === '2');
  }

  // ------------------------------------------------------------ fixtures
  for (const name of ['i2c', 'spi', 'uart']) {
    const orig = readBuf(`${nodeProcess.cwd()}/fixtures/${name}.sr`);
    const cap = await parseSr(orig, `${name}.sr`);
    const probes = cap.channelNames.map((n, c) => ({ index: c, name: n }));
    const blob = await saveSr(cap.store, probes);
    const buf = await blob.arrayBuffer();
    const back = await parseSr(buf, `${name}.out.sr`);
    let edgesOk = back.store.length === cap.store.length && back.store.samplerate === cap.store.samplerate;
    for (let c = 0; c < 16 && edgesOk; c++) {
      edgesOk = sameEdges(back.store.edges(c, 0, back.store.length), cap.store.edges(c, 0, cap.store.length));
    }
    const namesOk = back.channelNames.join() === cap.channelNames.join();
    const a = members(orig).get('logic-1-1')!;
    const b = members(buf).get('logic-1-1')!;
    const bytesOk = a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i]!) && a.crc === b.crc;
    check(`${name}.sr fixture -> export -> reload is equal, sample bytes identical`,
      edgesOk && namesOk && bytesOk && crcProblems(buf).length === 0,
      `edges ${edgesOk} names ${namesOk} bytes ${bytesOk} crc ${a.crc.toString(16)}/${b.crc.toString(16)}`);
  }

  // ------------------------------------------------------------ streaming / errors
  {
    const store = generatedStore(16, 10_000, 3);
    const probes = [{ index: 0, name: 'A' }, { index: 1, name: 'B' }];
    let parts = 0;
    let largest = 0;
    for await (const p of srExportParts(store, probes, { chunkBytes: 1000, compression: 'store' })) {
      parts++;
      largest = Math.max(largest, p.length);
    }
    check('export streams bounded parts (no whole-capture buffer)', parts > 20 && largest <= 1000 + 64,
      `${parts} parts, largest ${largest}`);
    // The snapshot is taken when the export is created, not when parts are pulled.
    const live = createSampleStore(8, 1e6);
    live.append(new Uint8Array(500).fill(0x55));
    const pending = srExportParts(live, [{ index: 0, name: 'A' }], { compression: 'store' });
    live.append(new Uint8Array(300).fill(0xaa));
    const chunks: Uint8Array[] = [];
    for await (const p of pending) chunks.push(p);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const assembled = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { assembled.set(c, at); at += c.length; }
    const snap = await parseSr(assembled.buffer, 'live.sr');
    check('export of a growing store keeps the length it had when created', snap.store.length === 500, `${snap.store.length}`);
    let code = '';
    try { await saveSr(createSampleStore(8, 1e6), probes); } catch (e) { code = diagnosticOf(e)?.code ?? String(e); }
    check('empty store refuses with io.nothingToSave', code === 'io.nothingToSave', code);
    code = '';
    try { await saveSr(store, []); } catch (e) { code = diagnosticOf(e)?.code ?? String(e); }
    check('zero probes refuses with io.srProbes', code === 'io.srProbes', code);
  }

  // ------------------------------------------------------------ file names
  const when = { year: 2026, month: 11, day: 6, hour: 11, minute: 0, second: 50 };
  check('device name: model, channels, rate, local stamp',
    captureFileName({ model: 'SLogic32 U3', channels: 16, samplerateHz: 100e6, when }, 'lwcap') ===
      'SLogic32U3_16ch_100MHz_20261106-110050.lwcap');
  check('no device falls back to "capture"',
    captureFileName({ model: null, channels: 8, samplerateHz: 1.5e6, when: { ...when, month: 1, day: 2, hour: 3, minute: 4, second: 5 } }, 'sr') ===
      'capture_8ch_1.5MHz_20260102-030405.sr');
  check('a model of only unsafe characters falls back to "capture"',
    captureFileName({ model: ' / ', channels: 4, samplerateHz: 500, when }, 'sr') === 'capture_4ch_500Hz_20261106-110050.sr');
  check('opened file keeps its base name, new extension',
    captureFileName({ model: 'X', channels: 16, samplerateHz: 16e6, when, sourceFileName: 'uart.sr' }, 'lwcap') === 'uart.lwcap' &&
    captureFileName({ model: null, channels: 16, samplerateHz: 16e6, when, sourceFileName: 'my run.v2.lwcap' }, 'sr') === 'my run.v2.sr');
  check('base name strips folders and only the last extension',
    fileBaseName('a/b\\c.d.sr') === 'c.d' && fileBaseName('.hidden') === '.hidden');
  check('rate tokens', [100e6, 250e3, 1e9, 33.333333e6, 999].map(rateToken).join() === '100MHz,250kHz,1GHz,33.333MHz,999Hz');
  const names = { lwcap: 'L', sr: 'S', vcd: 'V', csv: 'C' };
  const ext = (list: ReturnType<typeof saveFilePickerTypes>): string =>
    list.map((ty) => Object.values(ty.accept)[0]![0]).join(',');
  const types = saveFilePickerTypes('sr', names);
  check('picker offers every type, chosen first, the rest in menu order',
    ext(types) === '.sr,.lwcap,.vcd,.csv' && types[0]!.description === 'S' &&
    ext(saveFilePickerTypes('csv', names)) === '.csv,.lwcap,.sr,.vcd' &&
    ext(saveFilePickerTypes('lwcap', names)) === '.lwcap,.sr,.vcd,.csv' &&
    saveFilePickerTypes('vcd', names)[0]!.accept['text/plain']?.[0] === '.vcd', ext(types));
  check('picked name decides the format',
    formatForFileName('x.SR', 'lwcap') === 'sr' && formatForFileName('x.lwcap', 'sr') === 'lwcap' &&
    formatForFileName('x.VCD', 'sr') === 'vcd' && formatForFileName('x.csv', 'lwcap') === 'csv' &&
    formatForFileName('x.bin', 'sr') === 'sr');
  const d = new Date(2026, 10, 6, 11, 0, 50);
  const parts = localDateParts(d);
  check('localDateParts reads local wall time', parts.year === 2026 && parts.month === 11 && parts.day === 6 &&
    parts.hour === 11 && parts.minute === 0 && parts.second === 50);

  console.log(`\n${passed}/${passed + failures.length} passed`);
  nodeProcess.exit(failures.length === 0 ? 0 : 1);
}

void main();
