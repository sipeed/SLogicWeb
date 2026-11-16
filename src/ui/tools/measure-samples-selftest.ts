// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../../data/adcTraceFiles.js';
import { readCode } from '../../data/busValue.js';
import { createSampleStore } from '../../data/index.js';
import { GAP_BIT, type ColumnView, type SampleStore } from '../../data/types.js';
import { analogBusConfig } from '../channelBanks.js';
import { MEASURE_READ_CHUNK, MEASURE_SCAN_SAMPLES, readMeasureSamples, type MeasureRead } from '../measureSamples.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const trace = loadAdcTrace('sine');
const CHANNELS = 32;
const config = analogBusConfig(0, CHANNELS, '#123456');
const bus = { bits: config.spec.bits, group: config.analogGroup ?? 0, gain: config.analogGain ?? 1 };

function fixtureWord(code: number): number {
  let word = 0;
  for (let k = 0; k < 8; k++) if ((code >> k) & 1) word |= 1 << (7 - k);
  return word;
}

function fixtureWords(codes: Uint8Array): Uint8Array {
  const words = new Uint8Array(codes.length * 4);
  for (let i = 0; i < codes.length; i++) words[i * 4] = fixtureWord(codes[i]!);
  return words;
}

function fixtureStore(): SampleStore {
  const store = createSampleStore(CHANNELS, 100e6);
  store.append(fixtureWords(trace));
  return store;
}

function firstMismatch(actual: Uint8Array, expected: Uint8Array, offset: number): number {
  const n = Math.min(actual.length, expected.length - offset);
  for (let i = 0; i < n; i++) if (actual[i] !== expected[offset + i]) return i;
  return -1;
}

function holdingCodes(
  store: SampleStore, bits: readonly number[], from: number, count: number,
): Uint8Array {
  const views: ColumnView[] = bits.map((ch) => store.query(ch, from, from + count, count));
  const codes = new Uint8Array(count);
  for (let k = 0; k < views.length; k++) {
    const low = views[k]!.low;
    const weight = 1 << k;
    for (let i = 0; i < count; i++) if (low[i] !== 0) codes[i]! += weight;
  }
  return codes;
}

/** The reader's own invariants: one sample per code, and nothing dropped in silence. */
function shaped(read: MeasureRead): boolean {
  return read.codes.length === read.analyzed && read.unknown.length === read.analyzed &&
    read.end === read.start + read.analyzed && read.availableSamples >= read.analyzed &&
    read.truncated === (read.analyzed < read.availableSamples) &&
    read.end <= read.start + read.availableSamples;
}

const store = fixtureStore();

check('the analog group reads the fixture bank LSB first',
  bus.bits.join(',') === '7,6,5,4,3,2,1,0' && bus.group === 0 && bus.gain === 1 &&
    readCode(store, bus.bits, 0) === trace[0] && readCode(store, bus.bits, 1234) === trace[1234] &&
    readCode(store, bus.bits, trace.length - 1) === trace[trace.length - 1],
  `bits=${bus.bits.join(',')}, group=${bus.group}, gain=${bus.gain}`);

{
  const read = readMeasureSamples(store, bus, { start: 0, end: trace.length, maxSamples: trace.length });
  const bad = firstMismatch(read.codes, trace, 0);
  check('every one of the 300000 real ADC codes is reconstructed exactly',
    bad === -1 && read.analyzed === trace.length && read.requestedSamples === trace.length &&
      read.availableSamples === trace.length && read.limit === trace.length &&
      read.start === 0 && read.end === trace.length && shaped(read) &&
      !read.truncated && !read.rangeClipped && read.unknownSamples === 0 &&
      read.gapsAbsolute.length === 0,
    `mismatch=${bad}, analyzed=${read.analyzed}, truncated=${read.truncated}, ` +
      `clipped=${read.rangeClipped}, unknown=${read.unknownSamples}`);
}

{
  const read = readMeasureSamples(store, bus, { start: 0, end: trace.length });
  const bad = firstMismatch(read.codes, trace, 0);
  check('the default read stops at the 65536-sample bound and says so',
    bad === -1 && read.analyzed === MEASURE_SCAN_SAMPLES && read.codes.length === MEASURE_SCAN_SAMPLES &&
      read.limit === MEASURE_SCAN_SAMPLES && read.truncated && !read.rangeClipped &&
      read.requestedSamples === trace.length && read.availableSamples === trace.length &&
      read.end === MEASURE_SCAN_SAMPLES && shaped(read),
    `analyzed=${read.analyzed}, end=${read.end}, limit=${read.limit}, ` +
      `truncated=${read.truncated}, mismatch=${bad}`);
}

{
  const read = readMeasureSamples(store, bus, {
    start: 0, end: trace.length, maxSamples: trace.length, chunkSamples: 4093,
  });
  const bad = firstMismatch(read.codes, trace, 0);
  check('a chunk size that does not divide the range keeps every code exact',
    bad === -1 && read.analyzed === trace.length && !read.truncated && shaped(read),
    `chunk=4093, analyzed=${read.analyzed}, mismatch=${bad}`);
}

{
  const read = readMeasureSamples(store, bus, { start: 1000, end: 5000, chunkSamples: 1000 });
  const bad = firstMismatch(read.codes, trace, 1000);
  check('a window inside the record stays store-relative and exact',
    bad === -1 && read.start === 1000 && read.end === 5000 && read.analyzed === 4000 &&
      read.requestedStart === 1000 && read.requestedEnd === 5000 && read.requestedSamples === 4000 &&
      read.availableSamples === 4000 && !read.rangeClipped && !read.truncated && shaped(read),
    `start=${read.start}, end=${read.end}, analyzed=${read.analyzed}, mismatch=${bad}`);
}

{
  const shifted = fixtureStore();
  shifted.dropFront(1024);
  shifted.noteGap(2000, 2100);
  const read = readMeasureSamples(shifted, bus, { start: 0, end: 5000 });
  const bad = firstMismatch(read.codes, trace, 1024);
  let maskOk = true;
  for (let i = 0; i < read.analyzed; i++) {
    const want = i >= 2000 && i < 2100 ? 1 : 0;
    if (read.unknown[i] !== want) maskOk = false;
  }
  const gap = read.gapsAbsolute[0];
  check('a noted gap marks unknown samples and is disclosed in absolute positions',
    read.droppedSamples === 1024 && read.unknownSamples === 100 && maskOk && gap !== undefined &&
      read.gapsAbsolute.length === 1 && gap.startSample === 3024 && gap.endSample === 3124 &&
      bad === -1 && read.analyzed === 5000 && read.codes.length === 5000 &&
      read.unknown.length === 5000 && shaped(read),
    `dropped=${read.droppedSamples}, unknown=${read.unknownSamples}, mask=${maskOk}, ` +
      `gaps=${JSON.stringify(read.gapsAbsolute)}, mismatch=${bad}`);
}

{
  const shifted = fixtureStore();
  shifted.dropFront(1024);
  shifted.noteGap(2000, 2100);
  const read = readMeasureSamples(shifted, bus, { start: 0, end: 2050 });
  check('a gap is clipped to the analyzed range before it is disclosed',
    read.gapsAbsolute.length === 1 && read.gapsAbsolute[0]!.startSample === 3024 &&
      read.gapsAbsolute[0]!.endSample === 3074 && read.unknownSamples === 50 && read.analyzed === 2050 &&
      shaped(read),
    `gaps=${JSON.stringify(read.gapsAbsolute)}, unknown=${read.unknownSamples}`);
}

{
  const late = fixtureStore();
  late.noteGap(MEASURE_SCAN_SAMPLES, MEASURE_SCAN_SAMPLES + 100);
  late.noteGap(70000, 70100);
  const bounded = readMeasureSamples(late, bus, { start: 0, end: trace.length });
  const windowed = readMeasureSamples(late, bus, {
    start: 1000, end: trace.length, maxSamples: 500,
  });
  const bad = firstMismatch(windowed.codes, trace, 1000);
  check('a bound below the available range scans an exact prefix and drops gaps past it',
    bounded.analyzed === MEASURE_SCAN_SAMPLES && bounded.end === MEASURE_SCAN_SAMPLES &&
      bounded.gapsAbsolute.length === 0 && bounded.unknownSamples === 0 && bounded.truncated &&
      shaped(bounded) && windowed.start === 1000 && windowed.end === 1500 &&
      windowed.analyzed === 500 && windowed.availableSamples === trace.length - 1000 &&
      windowed.requestedSamples === trace.length - 1000 && windowed.truncated &&
      windowed.gapsAbsolute.length === 0 && windowed.unknownSamples === 0 && bad === -1 &&
      shaped(windowed),
    `bounded=${bounded.end}/${bounded.analyzed}/gaps=${bounded.gapsAbsolute.length}, ` +
      `windowed=${windowed.start}..${windowed.end}/${windowed.analyzed}, mismatch=${bad}`);
}

{
  const gapped = fixtureStore();
  gapped.noteGap(700, 900);
  gapped.noteGap(4000, 5000);
  const read = readMeasureSamples(gapped, bus, { start: 0, end: 6000, chunkSamples: 256 });
  let maskOk = true;
  for (let i = 0; i < read.analyzed; i++) {
    const want = (i >= 700 && i < 900) || (i >= 4000 && i < 5000) ? 1 : 0;
    if (read.unknown[i] !== want) maskOk = false;
  }
  const gapSum = read.gapsAbsolute.reduce((n, g) => n + (g.endSample - g.startSample), 0);
  const insideGap = readMeasureSamples(gapped, bus, { start: 4000, end: 4500 });
  const gapEnd = readMeasureSamples(gapped, bus, { start: 5000, end: 5500 });
  const cutStart = readMeasureSamples(gapped, bus, { start: 800, end: 1000 });
  check('gaps stay per-sample across chunk and window boundaries and add up to the mask',
    maskOk && read.unknownSamples === 1200 && gapSum === read.unknownSamples &&
      read.gapsAbsolute.length === 2 && read.gapsAbsolute[0]!.startSample === 700 &&
      read.gapsAbsolute[0]!.endSample === 900 && read.gapsAbsolute[1]!.startSample === 4000 &&
      read.gapsAbsolute[1]!.endSample === 5000 && shaped(read) &&
      insideGap.unknownSamples === 500 && insideGap.gapsAbsolute.length === 1 &&
      gapEnd.unknownSamples === 0 && gapEnd.gapsAbsolute.length === 0 &&
      cutStart.unknownSamples === 100 && cutStart.gapsAbsolute.length === 1 &&
      cutStart.gapsAbsolute[0]!.startSample === 800 &&
      cutStart.gapsAbsolute[0]!.endSample === 900,
    `mask=${maskOk}, unknown=${read.unknownSamples}, gaps=${JSON.stringify(read.gapsAbsolute)}, ` +
      `inside=${insideGap.unknownSamples}, end=${gapEnd.unknownSamples}, ` +
      `cut=${cutStart.unknownSamples}/${JSON.stringify(cutStart.gapsAbsolute)}`);
}

{
  const a = store.query(0, 0, 64, 64);
  const b = store.query(1, 0, 64, 64);
  const aliased = a.low === b.low && a.packed === b.packed;
  const held = holdingCodes(store, bus.bits, 0, 300);
  const bad = firstMismatch(held, trace, 0);
  const read = readMeasureSamples(store, bus, { start: 0, end: 300 });
  const readerBad = firstMismatch(read.codes, trace, 0);
  check('borrowed view arrays make a view-holding reader wrong while this one stays exact',
    aliased && bad !== -1 && readerBad === -1 && read.analyzed === 300 && read.codes.length === 300,
    `aliased=${aliased}, holdingMismatch=${bad}, readerMismatch=${readerBad}`);
}

{
  const corrupting = Object.create(store) as SampleStore;
  let last: ColumnView | null = null;
  corrupting.query = (channel: number, startSample: number, endSample: number, bins: number): ColumnView => {
    if (last) {
      last.low.fill(0xff);
      last.packed.fill(0xff);
    }
    store.query(channel, startSample, endSample, bins + 1);
    const view = store.query(channel, startSample, endSample, bins);
    last = view;
    return view;
  };
  const read = readMeasureSamples(corrupting, bus, { start: 0, end: 2048, chunkSamples: 512 });
  const readerBad = firstMismatch(read.codes, trace, 0);
  const held = holdingCodes(corrupting, bus.bits, 0, 512);
  const holdingBad = firstMismatch(held, trace, 0);
  let oracleOk = true;
  for (let i = 0; i < read.analyzed; i += 61) {
    if (readMeasureSamples(store, bus, { start: i, end: i + 1 }).codes[0] !== readCode(store, bus.bits, i)) {
      oracleOk = false;
    }
  }
  check('a store that corrupts the previous view before answering cannot leak stale codes',
    readerBad === -1 && read.analyzed === 2048 && read.codes.length === 2048 &&
      read.unknownSamples === 0 && oracleOk && holdingBad !== -1 && shaped(read),
    `readerMismatch=${readerBad}, unknown=${read.unknownSamples}, oracle=${oracleOk}, ` +
      `holdingMismatch=${holdingBad}`);
}

{
  const marked = [5, 4095, 4096, 9000];
  const gapChannel = bus.bits[3]!;
  const perChannel = Object.create(store) as SampleStore;
  perChannel.query = (channel: number, startSample: number, endSample: number, bins: number): ColumnView => {
    const view = store.query(channel, startSample, endSample, bins);
    if (channel === gapChannel) {
      for (const at of marked) if (at >= startSample && at < endSample) view.packed[at - startSample]! |= GAP_BIT;
    }
    return view;
  };
  const read = readMeasureSamples(perChannel, bus, { start: 0, end: 12000 });
  let maskOk = read.analyzed === 12000;
  for (let i = 0; i < read.analyzed; i++) {
    const want = marked.includes(i) ? 1 : 0;
    if (read.unknown[i] !== want) maskOk = false;
  }
  const bad = firstMismatch(read.codes, trace, 0);
  check('one unknown source bit marks only that sample unknown',
    maskOk && read.unknownSamples === marked.length && bad === -1 &&
      read.gapsAbsolute.length === 0,
    `mask=${maskOk}, unknown=${read.unknownSamples}, mismatch=${bad}, ` +
      `gaps=${JSON.stringify(read.gapsAbsolute)}`);
}

{
  const shapes: string[] = [];
  const recording = Object.create(store) as SampleStore;
  recording.query = (channel: number, startSample: number, endSample: number, bins: number): ColumnView => {
    shapes.push(bins === endSample - startSample ? 'exact' : `bins=${bins}/samples=${endSample - startSample}`);
    return store.query(channel, startSample, endSample, bins);
  };
  recording.sampleAt = (): number => {
    throw new Error('the reader must not read samples one at a time');
  };
  const read = readMeasureSamples(recording, bus, { start: 500, end: 2500, chunkSamples: 700 });
  const exact = shapes.length === 24 && shapes.every((s) => s === 'exact');
  const read2 = readMeasureSamples(recording, bus, { start: 0, end: 2 * MEASURE_READ_CHUNK });
  const defaultShapes = shapes.slice(24);
  const defaultExact = defaultShapes.length === 16 && read2.analyzed === 2 * MEASURE_READ_CHUNK &&
    defaultShapes.every((s) => s === 'exact');
  const read3 = readMeasureSamples(recording, bus, { start: 10, end: 110, chunkSamples: 4096 });
  const singleExact = shapes.length === 48 && read3.analyzed === 100;
  check('every chunk queries one exact sample per bin and never reads sampleAt',
    exact && defaultExact && singleExact && read.analyzed === 2000 &&
      firstMismatch(read.codes, trace, 500) === -1,
    `shapes=${shapes.length}/${shapes.filter((s) => s === 'exact').length} exact, ` +
      `default=${defaultShapes.length}, analyzed=${read.analyzed}/${read2.analyzed}/${read3.analyzed}`);
}

{
  const beyond = readMeasureSamples(store, bus, { start: 0, end: trace.length + 5000 });
  const past = readMeasureSamples(store, bus, { start: 400000, end: 400100 });
  const empty = readMeasureSamples(store, bus, { start: 1234, end: 1234 });
  const emptied = readMeasureSamples(createSampleStore(CHANNELS, 100e6), bus, { start: 0, end: 100 });
  const ok = beyond.rangeClipped && beyond.requestedEnd === trace.length + 5000 &&
    beyond.requestedSamples === trace.length + 5000 && beyond.availableSamples === trace.length &&
    beyond.end === MEASURE_SCAN_SAMPLES && beyond.analyzed === MEASURE_SCAN_SAMPLES &&
    beyond.truncated && shaped(beyond) &&
    past.rangeClipped && past.start === trace.length && past.end === trace.length &&
    past.availableSamples === 0 && past.analyzed === 0 && past.codes.length === 0 &&
    past.unknownSamples === 0 && past.requestedStart === 400000 && past.requestedSamples === 100 &&
    !past.truncated && shaped(past) &&
    empty.analyzed === 0 && empty.codes.length === 0 && empty.unknown.length === 0 &&
    empty.unknownSamples === 0 && empty.gapsAbsolute.length === 0 && !empty.rangeClipped &&
    !empty.truncated && empty.requestedSamples === 0 && shaped(empty) &&
    emptied.rangeClipped && emptied.analyzed === 0 && emptied.codes.length === 0 &&
    emptied.gapsAbsolute.length === 0 && shaped(emptied);
  check('clipped, empty and degenerate requests disclose instead of inventing data', ok,
    `beyond=${beyond.rangeClipped}/${beyond.availableSamples}/${beyond.analyzed}, ` +
      `past=${past.start}/${past.availableSamples}/${past.analyzed}, ` +
      `empty=${empty.analyzed}, emptied=${emptied.analyzed}/${emptied.rangeClipped}`);
}

{
  const throws = (fn: () => unknown): boolean => {
    try { fn(); return false; } catch (e) { return e instanceof RangeError; }
  };
  const ok = throws(() => readMeasureSamples(store, bus, { start: Number.NaN, end: 10 })) &&
    throws(() => readMeasureSamples(store, bus, { start: 0, end: Number.POSITIVE_INFINITY })) &&
    throws(() => readMeasureSamples(store, bus, { start: 1.5, end: 10 })) &&
    throws(() => readMeasureSamples(store, bus, { start: -1, end: 10 })) &&
    throws(() => readMeasureSamples(store, bus, { start: 10, end: 5 })) &&
    throws(() => readMeasureSamples(store, bus, { start: 0, end: 10, maxSamples: 0 })) &&
    throws(() => readMeasureSamples(store, bus, { start: 0, end: 10, chunkSamples: 2.5 })) &&
    throws(() => readMeasureSamples(store, { ...bus, bits: [] }, { start: 0, end: 10 })) &&
    throws(() => readMeasureSamples(store, { ...bus, bits: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
      { start: 0, end: 10 })) &&
    throws(() => readMeasureSamples(store, { ...bus, bits: [0, 1, 1, 2] }, { start: 0, end: 10 })) &&
    throws(() => readMeasureSamples(store, { ...bus, bits: [0, 32] }, { start: 0, end: 10 })) &&
    throws(() => readMeasureSamples(store, { ...bus, bits: [0, 1.5] }, { start: 0, end: 10 }));
  check('invalid bounds, limits and group bits raise RangeError', ok, `throws=${ok}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
