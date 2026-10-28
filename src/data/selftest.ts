// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Correctness tests for the sample store. Runs unchanged in node and in the browser.
 *
 * The controls that matter:
 *  - every query result is compared against a brute-force scan of the same samples, so a
 *    pyramid bug cannot hide behind a pyramid-shaped reference;
 *  - the planar store and the interleaved store are compared against each other, so a bug
 *    in the shared descent logic has to be present identically in two different layouts to
 *    go unnoticed;
 *  - the narrow-glitch case is tested at the full 100M x 1000 columns scale, not scaled
 *    down, because that is exactly the case where a wrong level choice stops mattering.
 */

import { PlanarSampleStore } from './planarStore.js';
import { InterleavedSampleStore } from './interleavedStore.js';
import { RleSampleStore } from './rleStore.js';
import { BitPlane } from './bitplane.js';
import { GAP_BIT } from './types.js';
import { appendLostSamples } from './gaps.js';
import { bytesPerSampleForChannels } from '../types.js';
import { generateCapture, fillMacro, makeTileBlock, MACRO_SAMPLES } from './generator.js';
import type { SampleStore, ColumnView } from './types.js';
import { runSoftwareTriggerSuite } from './softwareTriggerSelftest.js';
import { runBusValueSuite } from './busValueSelftest.js';

export interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

type Log = (line: string) => void;

/** Column boundaries exactly as query() defines them. */
function columnBounds(s: number, e: number, bins: number): { a: Int32Array; b: Int32Array } {
  const a = new Int32Array(bins), b = new Int32Array(bins);
  const width = e - s;
  for (let i = 0; i < bins; i++) {
    const c0 = s + Math.floor((i * width) / bins);
    let c1 = s + Math.floor(((i + 1) * width) / bins);
    if (c1 <= c0) c1 = c0 + 1;
    if (c1 > e) c1 = e;
    a[i] = c0;
    b[i] = c1;
  }
  return { a, b };
}

/** Independent check that the column definition itself is sane. */
function checkTiling(s: number, e: number, bins: number): string | null {
  const { a, b } = columnBounds(s, e, bins);
  if (a[0] !== s) return `first column starts at ${a[0]}, not ${s}`;
  if (b[bins - 1] !== e) return `last column ends at ${b[bins - 1]}, not ${e}`;
  for (let i = 0; i < bins; i++) {
    if (b[i]! <= a[i]!) return `column ${i} is empty`;
    if (i > 0 && e - s >= bins && a[i] !== b[i - 1]) return `gap or overlap between column ${i - 1} and ${i}`;
  }
  return null;
}

/** Brute force: one pass over every sample in the range. */
function referenceQuery(
  sample: (i: number) => number, s: number, e: number, bins: number,
): { low: Uint8Array; high: Uint8Array; edge: Uint8Array } {
  const bounds = columnBounds(s, e, bins);
  const low = new Uint8Array(bins), high = new Uint8Array(bins), edge = new Uint8Array(bins);
  for (let i = 0; i < bins; i++) {
    const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
    let anyHi = 0, anyLo = 0;
    for (let j = c0; j < c1; j++) {
      if (sample(j)) anyHi = 1; else anyLo = 1;
    }
    high[i] = anyHi;
    low[i] = anyLo ? 0 : 1;
    let eh = anyHi, el = anyLo;
    if (c0 > 0) { if (sample(c0 - 1)) eh = 1; else el = 1; }
    edge[i] = eh && el ? 1 : 0;
  }
  return { low, high, edge };
}

function referenceEdges(sample: (i: number) => number, s: number, e: number, len: number): number[] {
  const out: number[] = [];
  const a = Math.max(1, s), z = Math.min(e, len);
  for (let i = a; i < z; i++) if (sample(i) !== sample(i - 1)) out.push(i);
  return out;
}

function compareView(
  got: ColumnView, want: { low: Uint8Array; high: Uint8Array; edge: Uint8Array }, tag: string,
): string | null {
  for (let i = 0; i < got.bins; i++) {
    if (got.low[i] !== want.low[i] || got.high[i] !== want.high[i] || got.edge[i] !== want.edge[i]) {
      return `${tag}: column ${i} got low=${got.low[i]} high=${got.high[i]} edge=${got.edge[i]}` +
             ` want low=${want.low[i]} high=${want.high[i]} edge=${want.edge[i]}`;
    }
    const expectPacked = got.high[i]! | (got.low[i]! << 1) | (got.edge[i]! << 2);
    if (got.packed[i] !== expectPacked) return `${tag}: packed mismatch at column ${i}`;
  }
  return null;
}

// ---------------------------------------------------------------------------

/** The zoom ladder every brute-force comparison runs. */
function zoomCases(totalSamples: number): Array<[number, number, number]> {
  const zooms: Array<[number, number, number]> = [];
  const widths = [totalSamples, Math.floor(totalSamples / 3), 100000, 12345, 1024, 257, 33, 7, 1];
  for (const w of widths) {
    if (w < 1 || w > totalSamples) continue;
    for (const off of [0, 1, 17, 4095, 65536, totalSamples - w]) {
      if (off < 0 || off + w > totalSamples) continue;
      for (const bins of [1, 7, 256, 1000, 1920]) zooms.push([off, off + w, bins]);
    }
  }
  return zooms;
}

/**
 * Build a small store from generated content plus a reference copy of the same samples,
 * then check append round-trip, query at many zooms and edges against brute force.
 */
function testAgainstBruteForce(log: Log, chunkSamples: number, totalSamples: number): TestResult[] {
  const results: TestResult[] = [];
  const ref = new Uint16Array(totalSamples);
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  const inter = new InterleavedSampleStore(100e6);

  let written = 0;
  for (const chunk of generateCapture({ totalSamples, chunkSamples })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    ref.set(view, written);
    store.append(chunk);
    inter.append(chunk);
    written += n;
  }

  let bad = -1;
  for (let i = 0; i < totalSamples && bad < 0; i++) {
    for (let c = 0; c < 16; c++) {
      if (store.sampleAt(c, i) !== ((ref[i]! >>> c) & 1)) { bad = i; break; }
    }
  }
  results.push({
    name: `append round-trip (chunk=${chunkSamples}, n=${totalSamples})`,
    pass: bad < 0,
    detail: bad < 0 ? `${totalSamples * 16} bits verified` : `first mismatch at sample ${bad}`,
  });
  if (bad >= 0) return results;

  let qFail: string | null = null;
  let qChecked = 0;
  for (const ch of [0, 2, 3, 5, 8, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e, bins] of zoomCases(totalSamples)) {
      const want = referenceQuery(sample, s, e, bins);
      qFail = compareView(store.query(ch, s, e, bins), want, `planar ch${ch} [${s},${e}) x${bins}`);
      if (qFail) break;
      qFail = compareView(inter.query(ch, s, e, bins), want, `interleaved ch${ch} [${s},${e}) x${bins}`);
      if (qFail) break;
      qChecked++;
    }
    if (qFail) break;
  }
  results.push({
    name: `query vs brute force (chunk=${chunkSamples})`,
    pass: qFail === null,
    detail: qFail ?? `${qChecked} (channel, viewport, bins) combinations, both layouts`,
  });

  let eFail: string | null = null;
  let eChecked = 0;
  for (const ch of [0, 3, 5, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e] of [[0, totalSamples], [1, 999], [12345, 200000], [totalSamples - 5000, totalSamples], [7, 8]] as Array<[number, number]>) {
      if (e > totalSamples) continue;
      const want = referenceEdges(sample, s, e, totalSamples);
      const gotP = Array.from(store.edges(ch, s, e));
      const gotI = Array.from(inter.edges(ch, s, e));
      if (gotP.length !== want.length || gotP.some((v, i) => v !== want[i])) {
        eFail = `planar ch${ch} [${s},${e}): got ${gotP.length} edges want ${want.length}` +
                (gotP.length === want.length ? ` (first diff at ${gotP.findIndex((v, i) => v !== want[i])})` : '');
        break;
      }
      if (gotI.length !== want.length || gotI.some((v, i) => v !== want[i])) {
        eFail = `interleaved ch${ch} [${s},${e}) disagrees with brute force`;
        break;
      }
      eChecked++;
    }
    if (eFail) break;
  }
  results.push({
    name: `edges vs brute force (chunk=${chunkSamples})`,
    pass: eFail === null,
    detail: eFail ?? `${eChecked} (channel, window) combinations, both layouts`,
  });

  log(`  brute-force set done for chunk=${chunkSamples}`);
  return results;
}

// ---------------------------------------------------------------------------

/**
 * The RLE store against the same brute-force reference: derive it from a planar store
 * (the round trip an import goes through), then hold it to every zoom and every edge
 * window the planar store was held to. A query bug in either store now needs to agree
 * with the brute-force scan to pass, so the two cannot cancel out.
 */
function testRleAgainstBruteForce(log: Log, chunkSamples: number, totalSamples: number): TestResult[] {
  const results: TestResult[] = [];
  const ref = new Uint16Array(totalSamples);
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });

  let written = 0;
  for (const chunk of generateCapture({ totalSamples, chunkSamples })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    ref.set(view, written);
    store.append(chunk);
    written += n;
  }
  const rle = RleSampleStore.fromStore(store);

  // Level round trip at a scatter of positions, plus the ends and the first samples.
  let rtFail = '';
  const spots = [0, 1, 2, 31, 32, 33, 997, 4095, 4096, 65537, totalSamples - 2, totalSamples - 1];
  for (const i of spots) {
    if (i < 0 || i >= totalSamples) continue;
    for (let c = 0; c < 16 && !rtFail; c++) {
      if (rle.sampleAt(c, i) !== store.sampleAt(c, i)) rtFail = `level ch${c} @${i}`;
    }
  }
  results.push({
    name: `rle sampleAt round trip (chunk=${chunkSamples})`,
    pass: rtFail === '',
    detail: rtFail ? `first mismatch: ${rtFail}` : `${spots.length} positions x 16 channels verified`,
  });

  let qFail: string | null = null;
  let qChecked = 0;
  for (const ch of [0, 2, 3, 5, 8, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e, bins] of zoomCases(totalSamples)) {
      const want = referenceQuery(sample, s, e, bins);
      qFail = compareView(rle.query(ch, s, e, bins), want, `rle ch${ch} [${s},${e}) x${bins}`);
      if (qFail) break;
      qChecked++;
    }
    if (qFail) break;
  }
  results.push({
    name: `rle query vs brute force (chunk=${chunkSamples})`,
    pass: qFail === null,
    detail: qFail ?? `${qChecked} (channel, viewport, bins) combinations`,
  });

  let eFail: string | null = null;
  let eChecked = 0;
  for (const ch of [0, 3, 5, 11, 12, 13, 14, 15]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    for (const [s, e] of [[0, totalSamples], [1, 999], [12345, 200000], [totalSamples - 5000, totalSamples], [7, 8]] as Array<[number, number]>) {
      if (e > totalSamples) continue;
      const want = referenceEdges(sample, s, e, totalSamples);
      const got = Array.from(rle.edges(ch, s, e));
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
        eFail = `rle ch${ch} [${s},${e}): got ${got.length} edges want ${want.length}` +
                (got.length === want.length ? ` (first diff at ${got.findIndex((v, i) => v !== want[i])})` : '');
        break;
      }
      eChecked++;
    }
    if (eFail) break;
  }
  results.push({
    name: `rle edges vs brute force (chunk=${chunkSamples})`,
    pass: eFail === null,
    detail: eFail ?? `${eChecked} (channel, window) combinations`,
  });

  log(`  rle brute-force set done for chunk=${chunkSamples}`);
  return results;
}

/**
 * The quantisation rule `fromTransitions` implements, checked against an independent
 * sample-stream simulation of the same rule - the control for the transition-time ->
 * edge-position conversion. The rule itself is the one the old planar import path used
 * (transition time -> first sample at or after it), so this pins the contract between
 * the two stores.
 */
function testRleQuantization(): TestResult[] {
  const results: TestResult[] = [];
  const sr = 10e6;
  const length = 1000;

  // Simulate the sample stream exactly as the old expansion did, per channel: levels
  // first, edges derived from the levels.
  const quantizeReference = (initial: number, times: readonly number[]): Int8Array => {
    const level = new Int8Array(length);
    let state = initial;
    let cursor = 0;
    for (let p = 0; p < length; p++) {
      while (cursor < times.length && Math.ceil(times[cursor]! * sr) <= p) { state ^= 1; cursor++; }
      level[p] = state;
    }
    return level;
  };
  const edgesOf = (level: Int8Array): number[] => {
    const edges: number[] = [];
    for (let p = 1; p < length; p++) if (level[p] !== level[p - 1]) edges.push(p);
    return edges;
  };

  const cases: Array<{ name: string; initial: number; times: number[] }> = [
    { name: 'grid-exact, all interior', initial: 0, times: [0.0000001, 0.0000003, 0.0000007] },
    // 0.00000015 -> ceil(1.5)=2, 0.00000019 -> ceil(1.9)=2, 0.00000029 -> ceil(2.9)=3:
    // three at 2 cancel to one, plus the grid-exact pair of 2s from the first case shape.
    { name: 'same-sample cancels pairwise', initial: 0, times: [0.00000015, 0.00000019, 0.00000029] },
    { name: 'three on one sample leave one', initial: 1, times: [0.0000001, 0.00000015, 0.00000019] },
    // ceil(0)=0: flips the level at sample 0, but never produces an edge.
    { name: 'transition at t=0 flips initial only', initial: 0, times: [0, 0.0000003] },
    // ceil(999.5)=1000 >= length: dropped.
    { name: 'transition past the end is dropped', initial: 0, times: [0.0000001, 0.00009995] },
    { name: 'idle channel', initial: 1, times: [] },
  ];

  let fail: string | null = null;
  let checks = 0;
  for (const cse of cases) {
    const sources = Array.from({ length: 4 }, () => ({ initial: 0, transitions: new Float64Array(0) }));
    sources[0] = { initial: cse.initial, transitions: new Float64Array(cse.times) };
    const store = RleSampleStore.fromTransitions(4, sr, length, sources);

    const levelRef = quantizeReference(cse.initial, cse.times);
    const wantEdges = edgesOf(levelRef);
    const gotEdges = Array.from(store.edges(0, 0, length));
    if (gotEdges.length !== wantEdges.length || gotEdges.some((v, i) => v !== wantEdges[i])) {
      fail = `${cse.name}: got edges [${gotEdges.join(', ')}] want [${wantEdges.join(', ')}]`;
      break;
    }
    // Level at sample 0 must absorb t=0 flips, and levels elsewhere follow the edges.
    for (const p of [0, 1, 2, 3, 500, 998, 999]) {
      if (store.sampleAt(0, p) !== levelRef[p]!) {
        fail = `${cse.name}: level at ${p} is ${store.sampleAt(0, p)}, stream says ${levelRef[p]}`;
        break;
      }
      checks++;
    }
    if (fail) break;
    // Full-view sanity: the store must agree with a brute-force query over the stream.
    const sample = (i: number) => levelRef[i]!;
    for (const bins of [1, 7, 256, 1000]) {
      const want = referenceQuery(sample, 0, length, bins);
      const q = compareView(store.query(0, 0, length, bins), want, `quantize ${cse.name} x${bins}`);
      if (q) { fail = q; break; }
      checks++;
    }
    if (fail) break;
  }
  results.push({
    name: 'fromTransitions quantisation vs a stream simulation',
    pass: fail === null,
    detail: fail ?? `${cases.length} cases, ${checks} checks`,
  });

  // Bad input must throw, not produce a plausible-looking store.
  const badInputs: Array<[string, () => unknown]> = [
    ['non-ascending transitions', () => RleSampleStore.fromTransitions(4, sr, 100, [
      { initial: 0, transitions: new Float64Array([1e-6, 0.5e-6]) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
    ])],
    ['bad initial', () => RleSampleStore.fromTransitions(4, sr, 100, [
      { initial: 2, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
      { initial: 0, transitions: new Float64Array(0) },
    ])],
  ];
  const notThrown: string[] = [];
  for (const [name, fn] of badInputs) {
    try { fn(); notThrown.push(name); } catch { /* expected */ }
  }
  results.push({
    name: 'fromTransitions rejects bad input',
    pass: notThrown.length === 0,
    detail: notThrown.length === 0 ? `${badInputs.length} bad-input cases all threw` : `did not throw: ${notThrown.join(', ')}`,
  });

  return results;
}

function testInterleavedGapParity(): TestResult[] {
  const results: TestResult[] = [];
  const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
    a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
  for (const channels of [8, 16, 32] as const) {
    const total = 4096;
    const bytes = bytesPerSampleForChannels(channels);
    const planar = new PlanarSampleStore({ channelCount: channels, samplerate: 100e6 });
    const interleaved = new InterleavedSampleStore(100e6, channels);
    for (let from = 0; from < total; from += 257) {
      const n = Math.min(257, total - from);
      const chunk = new Uint8Array(n * bytes);
      const view = new DataView(chunk.buffer);
      for (let i = 0; i < n; i++) {
        const value = Math.imul(from + i, 0x9e3779b1) >>> 0;
        if (bytes === 1) view.setUint8(i, value & 0xff);
        else if (bytes === 2) view.setUint16(i * 2, value & 0xffff, true);
        else view.setUint32(i * 4, value, true);
      }
      planar.append(chunk);
      interleaved.append(chunk);
    }
    for (const store of [planar, interleaved]) {
      store.noteGap(500, 1000);
      store.noteGap(750, 1500);
      store.noteGap(2000, 2001);
    }
    const wantedGaps = JSON.stringify([
      { startSample: 500, endSample: 1500 },
      { startSample: 2000, endSample: 2001 },
    ]);
    let invalidRejected = true;
    for (const [start, end] of [[10, 5], [-1, 5], [0, total + 1]]) {
      try { interleaved.noteGap(start, end); invalidRejected = false; } catch { }
    }
    const copy = interleaved.gaps() as { startSample: number; endSample: number }[];
    copy[0]!.startSample = 0;
    results.push({
      name: `interleaved ${channels}ch merges, validates and defensively returns gaps`,
      pass: JSON.stringify(interleaved.gaps()) === wantedGaps && invalidRejected &&
        interleaved.gaps()[0]!.startSample === 500,
      detail: JSON.stringify(interleaved.gaps()),
    });

    const cases = [[0, total, 64], [100, 2000, 37], [400, 1600, 31], [2000, 2048, 1]];
    const testChannels = channels === 8 ? [0, 3, 7] : [0, 3, 7, channels - 1];
    const compareColumns = (): string => {
      for (const ch of testChannels) {
        for (const [s, e, bins] of cases) {
          const a = planar.query(ch, s, e, bins);
          const b = interleaved.query(ch, s, e, bins);
          if (!same(a.low, b.low) || !same(a.high, b.high) ||
              !same(a.edge, b.edge) || !same(a.packed, b.packed)) {
            return `ch${ch} [${s},${e}) x${bins}`;
          }
        }
      }
      return '';
    };
    const compareEdges = (): string => {
      for (const ch of testChannels) {
        const a = planar.edges(ch, 0, planar.length);
        const b = interleaved.edges(ch, 0, interleaved.length);
        const count = interleaved.edgeCount(ch, 0, interleaved.length);
        if (!same(a, b) || count !== a.length || planar.edgeCount(ch, 0, planar.length) !== count) {
          return `ch${ch}: ${a.length}/${b.length}/${count} edges`;
        }
      }
      return '';
    };
    const queryFailure = compareColumns();
    results.push({
      name: `interleaved ${channels}ch gap query matches planar including bit3`,
      pass: queryFailure === '',
      detail: queryFailure || `${cases.length * testChannels.length} viewports matched`,
    });
    const edgeFailure = compareEdges();
    results.push({
      name: `interleaved ${channels}ch gap-filtered edges match planar`,
      pass: edgeFailure === '',
      detail: edgeFailure || `${testChannels.length} channels matched`,
    });

    planar.dropFront(512);
    interleaved.dropFront(512);
    const droppedQueryFailure = compareColumns();
    const droppedEdgeFailure = compareEdges();
    results.push({
      name: `interleaved ${channels}ch dropFront shifts gaps without changing query or edges`,
      pass: JSON.stringify(interleaved.gaps()) === JSON.stringify(planar.gaps()) &&
        droppedQueryFailure === '' && droppedEdgeFailure === '',
      detail: droppedQueryFailure || droppedEdgeFailure || JSON.stringify(interleaved.gaps()),
    });

    const planarLost = appendLostSamples(planar, 128, planar.length + 128);
    const interleavedLost = appendLostSamples(interleaved, 128, interleaved.length + 128);
    const liveQueryFailure = compareColumns();
    const liveEdgeFailure = compareEdges();
    results.push({
      name: `interleaved ${channels}ch live dropout append matches planar`,
      pass: planarLost === 128 && interleavedLost === 128 &&
        JSON.stringify(interleaved.gaps()) === JSON.stringify(planar.gaps()) &&
        liveQueryFailure === '' && liveEdgeFailure === '',
      detail: liveQueryFailure || liveEdgeFailure || JSON.stringify(interleaved.gaps()),
    });
    const memory = interleaved.memory();
    const expectedSlack = memory.baseBytes - interleaved.length * bytes;
    results.push({
      name: `interleaved ${channels}ch memory slack uses its native sample width`,
      pass: memory.slackBytes === expectedSlack && memory.slackBytes >= 0,
      detail: `slack ${memory.slackBytes}, expected ${expectedSlack}`,
    });
  }
  return results;
}

/**
 * Gap spans: noteGap merging, bit3 in query output, and edge filtering - on the planar
 * store and on an RLE store derived from it, which must agree bit for bit.
 */
function testGaps(): TestResult[] {
  const results: TestResult[] = [];
  const total = 400000;
  const ref = new Uint16Array(total);
  const clean = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  const gapped = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });

  let written = 0;
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples: 4099 })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    ref.set(view, written);
    clean.append(chunk);
    gapped.append(chunk);
    written += n;
  }

  const G0 = 50000, G1 = 160000;
  gapped.noteGap(G0, 100000);
  gapped.noteGap(150000, 150001); // 1-sample gap
  gapped.noteGap(70000, 160000);  // overlaps both -> must merge into [50000, 160000)

  const gapList = gapped.gaps();
  const merged =
    gapList.length === 1 && gapList[0]!.startSample === G0 && gapList[0]!.endSample === G1;
  results.push({
    name: 'noteGap merges overlapping and adjacent spans',
    pass: merged,
    detail: merged ? `[${G0}, ${G1})` : `got ${JSON.stringify(gapList)}`,
  });

  // Validation: out-of-range and empty gaps must throw.
  const badGaps: Array<[string, () => void]> = [
    ['start > end', () => gapped.noteGap(10, 5)],
    ['end past length', () => gapped.noteGap(0, total + 1)],
    ['negative start', () => gapped.noteGap(-1, 5)],
  ];
  const notThrown: string[] = [];
  for (const [name, fn] of badGaps) {
    try { fn(); notThrown.push(name); } catch { /* expected */ }
  }
  results.push({
    name: 'noteGap rejects invalid spans',
    pass: notThrown.length === 0,
    detail: notThrown.length === 0 ? `${badGaps.length} invalid spans all threw` : `did not throw: ${notThrown.join(', ')}`,
  });

  // Query: low/high/edge identical to the gap-free store; bit3 exactly on intersecting
  // columns. The one gap [G0, G1) covers many zoom levels, and column boundaries rarely
  // line up with it, so this exercises partial overlap.
  let qFail: string | null = null;
  let qChecked = 0;
  const CHANNELS = [0, 3, 5, 11, 12, 15];
  for (const ch of CHANNELS) {
    for (const [s, e, bins] of zoomCases(total)) {
      const a = clean.query(ch, s, e, bins);
      const b = gapped.query(ch, s, e, bins);
      const bounds = columnBounds(s, e, bins);
      for (let i = 0; i < bins && !qFail; i++) {
        const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
        const wantGap = c0 < G1 && c1 > G0 ? 1 : 0;
        if (b.low[i] !== a.low[i] || b.high[i] !== a.high[i] || b.edge[i] !== a.edge[i]) {
          qFail = `ch${ch} [${s},${e}) x${bins} column ${i}: gapped store changed low/high/edge`;
          break;
        }
        if (b.packed[i] !== (a.packed[i]! | (wantGap ? GAP_BIT : 0))) {
          qFail = `ch${ch} [${s},${e}) x${bins} column ${i}: packed ${b.packed[i]} want ${a.packed[i]! | (wantGap ? GAP_BIT : 0)}`;
          break;
        }
        qChecked++;
      }
      if (qFail) break;
    }
    if (qFail) break;
  }
  results.push({
    name: 'gap bit3 lands exactly on intersecting columns, other bits unchanged',
    pass: qFail === null,
    detail: qFail ?? `${qChecked} columns verified`,
  });

  // edges(): the gap-free edges with the ones inside [G0, G1) removed.
  let eFail: string | null = null;
  let eChecked = 0;
  for (const ch of CHANNELS) {
    const want = clean.edges(ch, 0, total).filter((p) => p < G0 || p >= G1);
    const got = gapped.edges(ch, 0, total);
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
      eFail = `ch${ch}: got ${got.length} edges want ${want.length}`;
      break;
    }
    eChecked++;
  }
  results.push({
    name: 'edges() never reports a transition inside a gap',
    pass: eFail === null,
    detail: eFail ?? `${eChecked} channels verified against the gap-free store`,
  });

  // The RLE store derived from the gapped store must agree with it exactly on bit3 and on
  // the bits of every column that does not intersect a gap - before it AND after it.
  // Only columns that touch the gap are exempt: there the planar store keeps drawing its
  // (untrusted) stored samples while the RLE store's best effort is a frozen level, so
  // comparing them would be comparing two unspecified values. Columns after the gap are
  // NOT exempt - the data there is known, and getting their levels right across the gap
  // is exactly what channelAcrossGaps exists for. This comment used to say "inside and
  // after", which is what let the inversion bug sit here unnoticed.
  // The edge lists must agree everywhere: both filter gap transitions out.
  const rle = RleSampleStore.fromStore(gapped);
  let rFail: string | null = null;
  let rChecked = 0;
  // Channels 1, 2 and 11 are the ones whose [G0, G1) swallows an ODD number of edges at
  // this capture's shape - they are the only ones a parity bug in the reconstruction can
  // show up on, and the old list [0, 5, 12, 15] happened to contain none of them.
  for (const ch of [0, 1, 2, 5, 11, 12, 15]) {
    for (const [s, e, bins] of zoomCases(total)) {
      const a = gapped.query(ch, s, e, bins);
      const b = rle.query(ch, s, e, bins);
      const bounds = columnBounds(s, e, bins);
      for (let i = 0; i < bins && !rFail; i++) {
        const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
        const gapHit = c0 < G1 && c1 > G0;
        if (((b.packed[i]! ^ a.packed[i]!) & GAP_BIT) !== 0) {
          rFail = `ch${ch} [${s},${e}) x${bins} column ${i}: bit3 ${b.packed[i]! & GAP_BIT} vs ${a.packed[i]! & GAP_BIT}`;
          break;
        }
        if (!gapHit) {
          if (b.low[i] !== a.low[i] || b.high[i] !== a.high[i] || b.edge[i] !== a.edge[i]) {
            rFail = `ch${ch} [${s},${e}) x${bins} column ${i} (${c0 >= G1 ? 'post' : 'pre'}-gap)`;
            break;
          }
          rChecked++;
        }
      }
      if (rFail) break;
    }
    if (!rFail) {
      const a = gapped.edges(ch, 0, total);
      const b = rle.edges(ch, 0, total);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) rFail = `ch${ch} edges disagree`;
    }
    if (rFail) break;
  }
  results.push({
    name: 'rle store derived from a gapped store agrees on bit3, non-gap bits and edges',
    pass: rFail === null,
    detail: rFail ?? `${rChecked} columns outside the gap (both sides) plus edge lists verified`,
  });

  // Brute-force control for the edge filtering itself: referenceEdges on the samples,
  // minus the gap, must equal the gapped store's output.
  let bFail: string | null = null;
  for (const ch of [0, 3, 5, 11]) {
    const sample = (i: number) => (ref[i]! >>> ch) & 1;
    const want = referenceEdges(sample, 0, total, total).filter((p) => p < G0 || p >= G1);
    const got = Array.from(gapped.edges(ch, 0, total));
    if (got.length !== want.length || got.some((v, i) => v !== want[i])) { bFail = `ch${ch}`; break; }
  }
  results.push({
    name: 'gap-filtered edges vs brute force',
    pass: bFail === null,
    detail: bFail ? `first mismatch on ${bFail}` : '4 channels verified',
  });

  return results;
}

/** 4 and 8 channel modes: one byte per sample from the device layer. */
function testNarrowModes(): TestResult[] {
  const out: TestResult[] = [];
  for (const nch of [4, 8] as const) {
    const n = 300000;
    const raw = new Uint8Array(n);
    let x = 12345;
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x |= 0; x ^= x >>> 17; x ^= x << 5; x |= 0;
      // channel 0 a clock, channel 1 mostly idle, the rest pseudorandom-ish but bursty
      let v = ((i >> 3) & 1);
      if ((i % 50000) < 200) v |= (x & 0xfe);
      if (i > 100000 && i < 100003) v |= 2;
      raw[i] = v & ((1 << nch) - 1);
    }
    const store = new PlanarSampleStore({ channelCount: nch, samplerate: 10e6 });
    for (let off = 0; off < n; ) {
      const take = Math.min(7919, n - off); // prime chunk size, exercises head and tail
      store.append(raw.subarray(off, off + take));
      off += take;
    }
    let bad = -1;
    for (let i = 0; i < n && bad < 0; i++) {
      for (let c = 0; c < nch; c++) if (store.sampleAt(c, i) !== ((raw[i]! >>> c) & 1)) { bad = i; break; }
    }
    let qFail: string | null = null;
    if (bad < 0) {
      for (let c = 0; c < nch && !qFail; c++) {
        const sample = (i: number) => (raw[i]! >>> c) & 1;
        for (const bins of [1, 333, 1000]) {
          qFail = compareView(store.query(c, 0, n, bins), referenceQuery(sample, 0, n, bins), `${nch}ch ch${c} x${bins}`);
          if (qFail) break;
        }
      }
    }
    out.push({
      name: `${nch}-channel mode, prime-sized chunks`,
      pass: bad < 0 && qFail === null,
      detail: bad >= 0 ? `sample mismatch at ${bad}` : (qFail ?? 'round-trip and query verified'),
    });
  }
  return out;
}

/** Byte-oriented sample widths used by SLogic32 U3 and future 64/128-channel boards. */
function testWideModes(): TestResult[] {
  const out: TestResult[] = [];
  for (const nch of [32, 64, 128] as const) {
    const n = 4097;
    const bps = nch / 8;
    const raw = new Uint8Array(n * bps);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        if (((i * 17 + c * 13) % 31) < 7) raw[i * bps + (c >>> 3)]! |= 1 << (c & 7);
      }
    }
    const store = new PlanarSampleStore({ channelCount: nch, samplerate: 200e6 });
    for (let i = 0; i < n; i += 257) {
      store.append(raw.subarray(i * bps, Math.min(n, i + 257) * bps));
    }
    let fail = '';
    for (const c of [0, 7, 15, 31, 63, 127].filter((c) => c < nch)) {
      for (let i = 0; i < n; i++) {
        const want = (raw[i * bps + (c >>> 3)]! >>> (c & 7)) & 1;
        if (store.sampleAt(c, i) !== want) { fail = `ch${c} sample ${i}`; break; }
      }
      if (fail) break;
    }
    out.push({
      name: `${nch}-channel little-endian sample mode`,
      pass: fail === '',
      detail: fail || `${n} samples round-tripped`,
    });
  }
  {
    const n = 65_539;
    const raw = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const word = (Math.imul(i, 0x9e3779b1) ^ (i >>> 3)) >>> 0;
      new DataView(raw.buffer).setUint32(i * 4, word, true);
    }
    const planar = new PlanarSampleStore({ channelCount: 32, samplerate: 200e6 });
    const native = new InterleavedSampleStore(200e6, 32);
    for (let i = 0; i < n; i += 1009) {
      const chunk = raw.subarray(i * 4, Math.min(n, i + 1009) * 4);
      planar.append(chunk);
      native.append(chunk);
    }
    let fail = '';
    for (const c of [0, 1, 7, 15, 16, 23, 30, 31]) {
      for (const i of [0, 1, 31, 32, 1008, 1009, 65_535, n - 1]) {
        if (native.sampleAt(c, i) !== planar.sampleAt(c, i)) {
          fail = `sampleAt ch${c} sample ${i}`;
          break;
        }
      }
      if (fail) break;
      for (const [start, end, bins] of [[0, n, 997], [17, 40_003, 333], [n - 100, n, 100]]) {
        const a = planar.query(c, start!, end!, bins!);
        const b = native.query(c, start!, end!, bins!);
        for (let j = 0; j < bins!; j++) {
          if (a.packed[j] !== b.packed[j]) { fail = `query ch${c} bin ${j}`; break; }
        }
        if (fail) break;
      }
      if (fail) break;
      const aEdges = planar.edges(c, 0, n);
      const bEdges = native.edges(c, 0, n);
      if (aEdges.length !== bEdges.length || aEdges.some((v, i) => v !== bEdges[i])) {
        fail = `edges ch${c}`;
        break;
      }
    }
    out.push({
      name: '32-channel native-word shipping store matches planar reference',
      pass: fail === '',
      detail: fail || `${n} samples, sample/query/edge paths agree`,
    });
  }
  return out;
}

/** Query correctness while the capture is still arriving and levels are incomplete. */
function testLiveCapture(): TestResult[] {
  const total = 2_000_003; // deliberately not a multiple of any bin size
  const ref = new Uint16Array(total);
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  let written = 0;
  let fail: string | null = null;
  let checks = 0;
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples: 65537 })) {
    const n = chunk.byteLength / 2;
    ref.set(new Uint16Array(chunk.buffer, chunk.byteOffset, n), written);
    store.append(chunk);
    written += n;
    if (written % 7 === 0 || written === total) {
      for (const ch of [0, 11, 12, 15]) {
        const sample = (i: number) => (ref[i]! >>> ch) & 1;
        const got = store.query(ch, 0, written, 137);
        fail = compareView(got, referenceQuery(sample, 0, written, 137), `live ch${ch} at n=${written}`);
        if (fail) break;
        checks++;
      }
    }
    if (fail) break;
  }
  return [{
    name: 'query during a live capture (incomplete pyramid levels)',
    pass: fail === null,
    detail: fail ?? `${checks} mid-capture queries verified against brute force`,
  }];
}

// ---------------------------------------------------------------------------

export interface GlitchCase {
  bins: number;
  start: number;
  end: number;
  pulse: number;
}

/**
 * The failure this component is famous for: a one-sample pulse in an otherwise idle
 * channel, viewed with 100,000 samples per pixel column, silently disappearing.
 *
 * Builds a real 100M-sample 16-channel store whose channel 0 is entirely low except for a
 * single high sample, then checks every one of the 1000 columns, not just the interesting
 * one - reporting the glitch everywhere would be just as wrong as reporting it nowhere.
 */
export function testNarrowGlitch(log: Log, totalSamples: number, pulses: number[]): TestResult[] {
  const results: TestResult[] = [];
  for (const pulse of pulses) {
    const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
    const zero = new Uint8Array(MACRO_SAMPLES * 2);
    let written = 0;
    while (written < totalSamples) {
      const take = Math.min(MACRO_SAMPLES, totalSamples - written);
      let patched = -1;
      if (pulse >= written && pulse < written + take) {
        patched = (pulse - written) * 2;
        zero[patched] = 1; // channel 0, low byte, bit 0
      }
      store.append(zero.subarray(0, take * 2));
      if (patched >= 0) zero[patched] = 0;
      written += take;
    }
    if (store.length !== totalSamples) throw new Error(`store length ${store.length} != ${totalSamples}`);
    if (store.sampleAt(0, pulse) !== 1) throw new Error(`pulse not stored at ${pulse}`);

    const cases: GlitchCase[] = [
      { bins: 1000, start: 0, end: totalSamples, pulse },
      { bins: 1920, start: 0, end: totalSamples, pulse },
      { bins: 1, start: 0, end: totalSamples, pulse },
      { bins: 1000, start: 7, end: totalSamples - 13, pulse },
      { bins: 997, start: 0, end: totalSamples, pulse },
    ];

    for (const c of cases) {
      const view = store.query(0, c.start, c.end, c.bins);
      const bounds = columnBounds(view.startSample, view.endSample, c.bins);
      let fail: string | null = checkTiling(view.startSample, view.endSample, c.bins);
      let flagged = 0;
      for (let i = 0; i < c.bins && !fail; i++) {
        const c0 = bounds.a[i]!, c1 = bounds.b[i]!;
        const inCol = pulse >= c0 && pulse < c1;
        const inColOrPrev = pulse >= c0 - 1 && pulse < c1;
        const wantHigh = inCol ? 1 : 0;
        const wantLow = inCol && c1 - c0 === 1 ? 1 : 0;
        const wantEdge = inColOrPrev ? 1 : 0;
        if (view.high[i] !== wantHigh || view.low[i] !== wantLow || view.edge[i] !== wantEdge) {
          fail = `column ${i} [${c0},${c1}) got low=${view.low[i]} high=${view.high[i]} edge=${view.edge[i]}` +
                 ` want low=${wantLow} high=${wantHigh} edge=${wantEdge}`;
          break;
        }
        if (view.edge[i]) flagged++;
      }
      results.push({
        name: `1-sample pulse at ${pulse} of ${totalSamples}, [${c.start},${c.end}) across ${c.bins} columns`,
        pass: fail === null,
        detail: fail ?? `${flagged} of ${c.bins} columns flagged (expected ${pulse === 0 ? 1 : 'the 1 or 2 straddling it'})`,
      });
      if (fail) log(`  FAIL ${fail}`);
    }

    // Same pulse, but seen through edges() at full range - the exact-position path.
    const ed = store.edges(0, 0, totalSamples);
    const wantEd: number[] = [];
    if (pulse >= 1) wantEd.push(pulse);
    if (pulse + 1 < totalSamples) wantEd.push(pulse + 1);
    const ok = ed.length === wantEd.length && wantEd.every((v, i) => ed[i] === v);
    results.push({
      name: `edges() finds the same 1-sample pulse at ${pulse}`,
      pass: ok,
      detail: ok ? `[${Array.from(ed).join(', ')}]` : `got [${Array.from(ed).join(', ')}] want [${wantEd.join(', ')}]`,
    });
  }
  return results;
}

/**
 * The same property on generated content rather than a hand-placed pulse: find the
 * narrowest pulse the generator actually produced on the glitch channel and confirm the
 * fully zoomed out view still shows it.
 */
export function testGeneratedGlitch(store: SampleStore, log: Log): TestResult[] {
  const ed = store.edges(12, 0, store.length);
  let narrowest = Infinity;
  let at = -1;
  for (let i = 0; i + 1 < ed.length; i++) {
    const w = ed[i + 1]! - ed[i]!;
    if (w < narrowest) { narrowest = w; at = ed[i]!; }
  }
  if (at < 0) return [{ name: 'generated glitch channel', pass: false, detail: 'no edges found on ch12' }];
  log(`  narrowest pulse on ch12: ${narrowest} sample(s) at ${at} (${ed.length} edges total)`);
  const bins = 1000;
  const view = store.query(12, 0, store.length, bins);
  const bounds = columnBounds(view.startSample, view.endSample, bins);
  let col = -1;
  for (let i = 0; i < bins; i++) if (at >= bounds.a[i]! && at < bounds.b[i]!) { col = i; break; }
  const pass = col >= 0 && view.edge[col] === 1 && view.low[col] === 0;
  return [{
    name: `generated ${narrowest}-sample pulse on ch12 survives ${store.length} samples / ${bins} columns`,
    pass,
    detail: pass
      ? `column ${col} reports edge=1 low=0 high=${view.high[col]}`
      : `column ${col} reports edge=${col >= 0 ? view.edge[col] : 'n/a'} - the glitch was dropped`,
  }];
}

// ---------------------------------------------------------------------------

/**
 * Force pyramid levels 4, 5 and 6 to be built from real content and actually read.
 *
 * The gap this closes: runFastSuite tops out at 400,000 samples, which only ever builds
 * levels 1-3, and the 100M glitch cases run against an all-zeros channel where a broken
 * upper level is indistinguishable from a working one. Mutation testing showed the top
 * two levels could be filled with garbage and the suite would still report 40/40.
 *
 * Level k is selected when 16^k * coreBins <= samplesPerBin. Sweeping coreBins makes the
 * same range get answered from several different levels, and they must all agree with
 * brute force and therefore with each other - the level is an implementation choice, not
 * part of the answer, so disagreement localises the broken level immediately.
 */
function testDeepLevels(log: Log): TestResult[] {
  const total = 24_000_000; // level 4 at coreBins=32, level 6 at coreBins=1
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });

  // Keep the reference as one byte per sample for a handful of channels rather than a
  // full copy: 24M x 16 channels of reference would be 384 MB.
  const checked = [0, 3, 5, 11, 12, 14, 15];
  const bits = new Map<number, Uint8Array>();
  for (const c of checked) bits.set(c, new Uint8Array(total));

  let written = 0;
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples: 1 << 20 })) {
    const n = chunk.byteLength / 2;
    const view = new Uint16Array(chunk.buffer, chunk.byteOffset, n);
    for (const c of checked) {
      const dst = bits.get(c)!;
      for (let i = 0; i < n; i++) dst[written + i] = (view[i]! >>> c) & 1;
    }
    store.append(chunk);
    written += n;
  }

  const results: TestResult[] = [];
  let fail: string | null = null;
  const levelsSeen = new Set<number>();
  let checks = 0;

  for (const coreBins of [1, 2, 8, 32]) {
    store.coreBins = coreBins;
    for (const bins of [1, 3, 17, 1000]) {
      const spb = total / bins;
      let lvl = 0;
      while (lvl < 6 && Math.pow(16, lvl + 1) * coreBins <= spb) lvl++;
      levelsSeen.add(lvl);
      for (const c of checked) {
        const ref = bits.get(c)!;
        const sample = (i: number) => ref[i]!;
        const want = referenceQuery(sample, 0, total, bins);
        fail = compareView(store.query(c, 0, total, bins), want,
                           `deep ch${c} bins=${bins} coreBins=${coreBins} level=${lvl}`);
        if (fail) break;
        checks++;
      }
      if (fail) break;
    }
    if (fail) break;
  }
  store.coreBins = 32;

  const sorted = [...levelsSeen].sort((a, b) => a - b);
  log(`  pyramid levels selected: ${sorted.join(', ')}`);
  results.push({
    name: `pyramid levels 4-6 vs brute force (${total.toLocaleString()} samples of real content)`,
    pass: fail === null && levelsSeen.has(4) && levelsSeen.has(5) && levelsSeen.has(6),
    detail: fail ?? `${checks} queries verified across levels ${sorted.join('/')}`,
  });
  return results;
}

/** Invalid arguments must throw, not produce columns with low > high. */
function testBadArguments(store: SampleStore, tag: string): TestResult[] {
  const cases: Array<[string, () => unknown]> = [
    ['query NaN start', () => store.query(0, NaN, 500, 100)],
    ['query NaN end', () => store.query(0, 0, NaN, 100)],
    ['query Infinity start', () => store.query(0, Infinity, 500, 100)],
    ['query -Infinity start', () => store.query(0, -Infinity, 500, 100)],
    ['query Infinity end', () => store.query(0, 0, Infinity, 100)],
    ['query NaN bins', () => store.query(0, 0, 500, NaN)],
    ['query zero bins', () => store.query(0, 0, 500, 0)],
    ['query channel 16', () => store.query(16, 0, 500, 10)],
    ['query channel -1', () => store.query(-1, 0, 500, 10)],
    ['edges NaN start', () => store.edges(0, NaN, 500)],
    ['edges NaN end', () => store.edges(0, 0, NaN)],
  ];
  const bad: string[] = [];
  for (const [name, fn] of cases) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) bad.push(name);
  }
  // And the specific impossible output the guard exists to prevent.
  let impossible = '';
  try {
    const v = store.query(0, NaN, 500, 100);
    if (v.low[0]! > v.high[0]!) impossible = ` and returned low=${v.low[0]} > high=${v.high[0]}`;
  } catch { /* expected */ }
  return [{
    name: `invalid arguments throw instead of returning impossible columns (${tag})`,
    pass: bad.length === 0,
    detail: bad.length === 0
      ? `${cases.length} bad-argument cases all threw`
      : `did not throw: ${bad.join(', ')}${impossible}`,
  }];
}

function dropFrontStream(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.imul(i ^ 0x5bd1e995, 2654435761) >>> 0;
    out[i] = ((v >>> 24) ^ (v >>> 13) ^ i) & 0xff;
  }
  return out;
}

function testDropFront(log: Log): TestResult[] {
  const results: TestResult[] = [];

  const equalStores = (a: SampleStore, b: SampleStore, label: string): void => {
    const len = a.length;
    let queryOk = b.length === len;
    if (queryOk && len > 0) {
      for (const [s, e, bins] of [[0, len, 997], [Math.floor(len / 3), Math.floor(len / 2), 513]] as const) {
        if (!(e > s)) continue;
        for (let c = 0; c < a.channelCount && queryOk; c++) {
          const qa = a.query(c, s, e, bins);
          const pa = qa.packed.slice();
          const pb = b.query(c, s, e, bins).packed;
          for (let i = 0; i < bins; i++) {
            if ((pa[i]! & 7) !== (pb[i]! & 7)) { queryOk = false; break; }
          }
        }
      }
    }
    results.push({
      name: `dropFront query columns equal a fresh tail store (${label})`,
      pass: queryOk,
      detail: `length ${len}, channels ${a.channelCount}`,
    });
    let edgesOk = b.length === len;
    if (edgesOk && len > 1) {
      for (let c = 0; c < a.channelCount && edgesOk; c++) {
        const ea = a.edges(c, 0, Math.min(len, 300_000));
        const eb = b.edges(c, 0, Math.min(len, 300_000));
        if (ea.length !== eb.length) { edgesOk = false; break; }
        for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) { edgesOk = false; break; }
      }
    }
    results.push({
      name: `dropFront edges equal a fresh tail store (${label})`,
      pass: edgesOk,
      detail: `length ${len}`,
    });
    let atOk = b.length === len;
    if (atOk && len > 0) {
      for (const p of [0, 1, 511, 512, 513, len - 1, Math.floor(len / 2)]) {
        if (p < 0 || p >= len) continue;
        for (let c = 0; c < a.channelCount; c++) {
          if (a.sampleAt(c, p) !== b.sampleAt(c, p)) { atOk = false; break; }
        }
      }
    }
    results.push({
      name: `dropFront sampleAt equals a fresh tail store (${label})`,
      pass: atOk,
      detail: `length ${len}`,
    });
  };

  {
    const bytes = dropFrontStream(3_000_000);
    const stepAt = 1_500_000;
    for (let i = 0; i < bytes.length; i++) bytes[i] = (bytes[i]! & 0xfe) | (i >= stepAt ? 1 : 0);
    const dropped = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    for (let o = 0; o < 1_500_000; o += 4099) {
      dropped.append(bytes.subarray(o, Math.min(o + 4099, 1_500_000)));
    }
    let keptFrom = 0;
    let keptTo = 1_500_000;
    const fresh = (): PlanarSampleStore => {
      const s = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
      s.append(bytes.subarray(keptFrom, keptTo));
      return s;
    };

    dropped.dropFront(512);
    keptFrom += 512;
    equalStores(dropped, fresh(), 'after first 512 drop');

    dropped.append(bytes.subarray(keptTo, 2_000_000));
    keptTo = 2_000_000;
    equalStores(dropped, fresh(), 'append after a drop');

    dropped.dropFront(999_936);
    keptFrom += 999_936;
    equalStores(dropped, fresh(), 'after a 999936 drop');

    dropped.append(bytes.subarray(keptTo, 3_000_000));
    keptTo = 3_000_000;
    dropped.dropFront(512);
    keptFrom += 512;
    equalStores(dropped, fresh(), 'drop after refilling');

    const boundary = stepAt - keptFrom;
    const col = (s: number, e: number): number => dropped.query(0, s, e, 1).packed[0]! & 7;
    const across = col(boundary - 256, boundary + 256);
    const before = col(boundary - 256, boundary);
    const after = col(boundary, boundary + 256);
    results.push({
      name: 'dropFront rebuilt pyramid classifies a step boundary exactly',
      pass: across === 5 && before === 0 && after === 7,
      detail: `across ${across} (want 5), before ${before} (want 0), after ${after} (want 7)`,
    });
    const pyr = dropped.memory().pyramidBytes;
    results.push({
      name: 'dropFront republishes pyramid bins',
      pass: pyr > 0,
      detail: `pyramid bytes ${pyr} over length ${dropped.length}`,
    });
  }

  for (const [cc, bps, chunk] of [[16, 2, 8198], [32, 4, 16396]] as const) {
    const n = 1_200_000;
    const raw = dropFrontStream(n * bps);
    const first = 900_000 * bps;
    const s = new PlanarSampleStore({ channelCount: cc as 16 | 32, samplerate: 100e6 });
    for (let o = 0; o < first; o += chunk) s.append(raw.subarray(o, Math.min(o + chunk, first)));
    const drop = 524_288;
    s.dropFront(drop);
    for (let o = first; o < raw.length; o += chunk) s.append(raw.subarray(o, Math.min(o + chunk, raw.length)));
    const tail = new PlanarSampleStore({ channelCount: cc as 16 | 32, samplerate: 100e6 });
    tail.append(raw.subarray(drop * bps));
    equalStores(s, tail, `${cc}ch append after a drop`);
  }

  log('drop-front across a base block boundary (17M samples)');
  {
    const big = (1 << 24) + 65_536;
    const bytes = dropFrontStream(big);
    const s = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    s.append(bytes);
    const before = s.memory().baseBytes;
    s.dropFront(1 << 24);
    const released = before - s.memory().baseBytes;
    results.push({
      name: 'dropFront releases whole base blocks',
      pass: released === 4 * (1 << 21),
      detail: `base bytes ${before} -> ${s.memory().baseBytes}`,
    });
    const tail = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    tail.append(bytes.subarray(1 << 24));
    equalStores(s, tail, 'whole-block drop');
  }

  log('drop-front at the 64-sample loop quantum (randomized interleave)');
  {
    // Interleaved appends and drops at the loop quantum, including drops that are
    // not 512-multiples (the retired quantum), then compare against a fresh store
    // holding exactly the surviving tail. Pins the absolute-addressed pyramid:
    // a coordinate bug shows up here as a query/edge mismatch.
    let seed = 0x9e3779b9;
    const rand = (n: number): number => {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0;
      seed = Math.imul(seed ^ (seed >>> 13), 3266489917) >>> 0;
      seed = (seed ^ (seed >>> 16)) >>> 0;
      return seed % n;
    };
    const totalSamples = 2_000_000;
    const raw = dropFrontStream(totalSamples * 2); // 16ch, 2 bytes per sample
    const s = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
    let fed = 0;
    let keptFrom = 0;
    let drops = 0;
    while (fed < totalSamples) {
      const n = Math.min(1 + rand(9999), totalSamples - fed);
      s.append(raw.subarray(fed * 2, (fed + n) * 2));
      fed += n;
      // Keep at least 100k samples so the comparisons stay meaty.
      if (s.length > 100_000 + 64 && rand(3) === 0) {
        const room = Math.floor((s.length - 100_000) / 64);
        const d = 64 * Math.min(1 + rand(2000), room);
        if (d > 0) {
          s.dropFront(d);
          keptFrom += d;
          drops++;
        }
      }
    }
    const tail = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
    tail.append(raw.subarray(keptFrom * 2, fed * 2));
    equalStores(s, tail, `randomized 64-quantum drops (${drops} drops)`);
    results.push({
      name: 'randomized 64-quantum drops conserve the retained length',
      pass: s.length === totalSamples - keptFrom,
      detail: `keptFrom ${keptFrom} (base skew ${keptFrom % 512}), length ${s.length}`,
    });
  }

  log('drop-front pyramid release accounting');
  {
    // Dropping one whole base block (2^24 samples) plus a 64-multiple tail releases
    // exactly one block at pyramid levels 1-3 per plane and nothing above:
    // level k block covers 2^24 samples for k <= 3, more above.
    const big = (1 << 24) + 65_536;
    const bytes = dropFrontStream(big);
    const s = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    s.append(bytes);
    const before = s.memory();
    s.dropFront((1 << 24) + 64_000);
    const after = s.memory();
    const released = before.pyramidBytes - after.pyramidBytes;
    const want = (2 ** 20 / 8 + 2 ** 16 / 8 + 2 ** 12 / 8) * 2 * 4;
    results.push({
      name: 'dropFront releases whole pyramid blocks, not contents',
      pass: released === want,
      detail: `pyramid bytes ${before.pyramidBytes} -> ${after.pyramidBytes} (released ${released}, want ${want})`,
    });
    const tail = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    tail.append(bytes.subarray((1 << 24) + 64_000));
    equalStores(s, tail, 'pyramid-release drop');
  }

  log('drop-front: pyramid block release followed by more appends');
  {
    // The randomized test above stays under one 16.7M-sample level-1 block, so it never
    // releases storage; the accounting test above releases but never appends again. This
    // is the only path where reduceRange reads a source plane whose storage starts at a
    // non-zero levelHead/baseOrigin, after a drop that leaves the base head neither zero
    // nor equal to baseOrigin.
    const before = (1 << 25) + 100_000;
    const after = 1_000_000;
    const drop = (1 << 24) + 512 * 300 + 192; // 512-aligned part plus a 64-quantum tail
    const raw = dropFrontStream(before + after); // 4ch, 1 byte per sample
    const s = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    s.append(raw.subarray(0, before));
    const pyramidBefore = s.memory().pyramidBytes;
    s.dropFront(drop);
    const pyramidAfterDrop = s.memory().pyramidBytes;
    s.append(raw.subarray(before, before + after));
    const pyramidAfterAppend = s.memory().pyramidBytes;
    results.push({
      name: 'dropFront releases pyramid blocks before the next append',
      pass: pyramidAfterDrop < pyramidBefore && pyramidAfterAppend < pyramidBefore,
      detail: `pyramid ${pyramidBefore} -> ${pyramidAfterDrop} (drop ${drop}) -> ${pyramidAfterAppend} ` +
        `after ${after} more appends, length ${s.length}`,
    });
    const tail = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    tail.append(raw.subarray(drop, before + after));
    equalStores(s, tail, 'append after a pyramid block release');

    // A second release past the next level-1 block, with the planes already shifted.
    const second = (1 << 20) * 16 + 64;
    s.dropFront(second);
    const tail2 = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    tail2.append(raw.subarray(drop + second, before + after));
    equalStores(s, tail2, 'append after a second pyramid block release');
  }

  log('drop-front: snapColumns rounds to absolute bins');
  {
    // Bins are absolute, so column snapping must round there too: a store that dropped a
    // non-bin-aligned prefix must place every column boundary on the same ABSOLUTE bin as
    // an undropped store over the same absolute window. A single-set-sample needle is the
    // sharpest probe: with the drop at 64*1001 the level-2 (256-sample) bin grid is off by
    // 64 samples in the store's own frame, and the needle sits between the two candidate
    // column-0 boundaries, so relative-space rounding puts it in column 0 while the
    // absolute rounding (and the undropped store) puts it in column 1.
    const drop = 64 * 1001;
    const length = 128_000;
    const needle = 16_096;
    const raw = new Uint8Array(drop + length); // 4ch, 1 byte per sample, all zero
    raw[drop + needle] = 1;
    const dropped = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6, snapColumns: true });
    dropped.append(raw.subarray(0, drop));
    dropped.dropFront(drop);
    dropped.append(raw.subarray(drop));
    const whole = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6, snapColumns: true });
    whole.append(raw);
    const bins = 8;
    const fromDropped = dropped.query(0, 0, length, bins).packed.slice();
    const fromWhole = whole.query(0, drop, drop + length, bins).packed;
    const snapBad = Array.from({ length: bins }, (_, i) => i)
      .filter((i) => fromDropped[i] !== fromWhole[i])
      .map((i) => `column ${i}: ${fromDropped[i]} vs ${fromWhole[i]}`);
    results.push({
      name: 'snapColumns rounds to absolute bins after a drop',
      pass: snapBad.length === 0 && fromWhole[0] === 0 && fromWhole[1] === 5,
      detail: snapBad.length === 0
        ? `needle in column 1 of ${bins}, packed ${Array.from(fromDropped).join(',')}`
        : snapBad.join('; '),
    });
  }

  {
    const bytes = dropFrontStream(12_000);
    const g = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    g.append(bytes);
    g.noteGap(1000, 2000);
    g.noteGap(5000, 6000);
    g.noteGap(9000, 10_000);
    g.dropFront(4096);
    const want1 = [{ startSample: 904, endSample: 1904 }, { startSample: 4904, endSample: 5904 }];
    const got1 = g.gaps();
    const gapsOk =
      got1.length === want1.length &&
      want1.every((w, i) => got1[i]!.startSample === w.startSample && got1[i]!.endSample === w.endSample);
    results.push({
      name: 'dropFront shifts gap spans and forgets dropped ones',
      pass: gapsOk,
      detail: JSON.stringify(got1),
    });
    const clip = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    clip.append(bytes.subarray(0, 4096));
    clip.noteGap(100, 700);
    clip.dropFront(512);
    const got2 = clip.gaps();
    const clipOk = got2.length === 1 && got2[0]!.startSample === 0 && got2[0]!.endSample === 188;
    results.push({
      name: 'dropFront clips a partially dropped gap at zero',
      pass: clipOk,
      detail: JSON.stringify(got2),
    });
    const query = clip.query(0, 0, clip.length, 64);
    const gapBitsOk = (query.packed[0]! & GAP_BIT) !== 0;
    results.push({
      name: 'shifted gaps still flag query columns',
      pass: gapBitsOk,
      detail: `packed[0] = ${query.packed[0]}`,
    });
  }

  {
    const s = new PlanarSampleStore({ channelCount: 4, samplerate: 100e6 });
    s.append(dropFrontStream(1000));
    const cases: Array<[string, () => void]> = [
      ['a non-multiple of the quantum', () => s.dropFront(500)],
      ['a negative count', () => s.dropFront(-512)],
      ['a non-integer', () => s.dropFront(512.5)],
      ['more than the length', () => s.dropFront(1024)],
    ];
    const bad: string[] = [];
    for (const [name, fn] of cases) {
      let threw = false;
      try { fn(); } catch { threw = true; }
      if (!threw) bad.push(name);
    }
    let noop = true;
    try { s.dropFront(0); } catch { noop = false; }
    if (!noop) bad.push('zero drop');
    if (s.length !== 1000) bad.push('length changed by refused drops');
    results.push({
      name: 'dropFront argument contract is enforced',
      pass: bad.length === 0,
      detail: bad.length === 0 ? `${cases.length + 1} cases behaved` : `failed: ${bad.join(', ')}`,
    });
    const rle = RleSampleStore.fromTransitions(16, 100e6, 4096,
      Array.from({ length: 16 }, () => ({ initial: 0, transitions: new Float64Array(0) })));
    let rleThrows = false;
    try { rle.dropFront(512); } catch { rleThrows = true; }
    const inter = new InterleavedSampleStore(100e6, 32);
    inter.append(new Uint8Array(4096 * 4));
    let interRefusedBad = false;
    try { inter.dropFront(100); } catch { interRefusedBad = true; }
    results.push({
      name: 'rle refuses dropFront, interleaved enforces the quantum',
      pass: rleThrows && interRefusedBad && inter.length === 4096,
      detail: `rle ${rleThrows ? 'threw' : 'accepted'}, interleaved 100-sample drop ${
        interRefusedBad ? 'refused' : 'accepted'}`,
    });
  }

  {
    // The interleaved store shares the absolute-addressed drop scheme with the planar
    // store; cross-check a randomized 64-quantum drop sequence at both widths against a
    // fresh tail store.
    let seed = 0x85ebca6b;
    const rand = (n: number): number => {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0;
      seed = Math.imul(seed ^ (seed >>> 13), 3266489917) >>> 0;
      seed = (seed ^ (seed >>> 16)) >>> 0;
      return seed % n;
    };
    for (const cc of [8, 16, 32] as const) {
      const bps = cc >>> 3;
      const totalSamples = 1_200_000;
      const raw = dropFrontStream(totalSamples * bps);
      const s = new InterleavedSampleStore(100e6, cc);
      let fed = 0;
      let keptFrom = 0;
      let drops = 0;
      while (fed < totalSamples) {
        const n = Math.min(1 + rand(7777), totalSamples - fed);
        s.append(raw.subarray(fed * bps, (fed + n) * bps));
        fed += n;
        if (s.length > 60_000 + 64 && rand(3) === 0) {
          const room = Math.floor((s.length - 60_000) / 64);
          const d = 64 * Math.min(1 + rand(1500), room);
          if (d > 0) {
            s.dropFront(d);
            keptFrom += d;
            drops++;
          }
        }
      }
      const tail = new InterleavedSampleStore(100e6, cc);
      tail.append(raw.subarray(keptFrom * bps, fed * bps));
      let ok = tail.length === s.length;
      if (ok && s.length > 1) {
        for (const [st, en, bins] of [[0, s.length, 997], [17, Math.floor(s.length / 2), 513]] as const) {
          if (!(en > st)) continue;
          for (let c = 0; c < cc && ok; c++) {
            const qa = s.query(c, st, en, bins).packed.slice();
            const qb = tail.query(c, st, en, bins).packed;
            for (let i = 0; i < bins; i++) if ((qa[i]! & 7) !== (qb[i]! & 7)) { ok = false; break; }
          }
        }
        for (let c = 0; c < cc && ok; c++) {
          const ea = s.edges(c, 0, Math.min(s.length, 250_000));
          const eb = tail.edges(c, 0, Math.min(s.length, 250_000));
          if (ea.length !== eb.length) { ok = false; break; }
          for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) { ok = false; break; }
        }
        if (ok) {
          for (const p of [0, 1, 511, 512, 513, s.length - 1, Math.floor(s.length / 2)]) {
            if (p < 0 || p >= s.length) continue;
            for (let c = 0; c < cc; c++) {
              if (s.sampleAt(c, p) !== tail.sampleAt(c, p)) { ok = false; break; }
            }
          }
        }
      }
      results.push({
        name: `interleaved dropFront equals a fresh tail store (${cc}ch, ${drops} drops)`,
        pass: ok,
        detail: `length ${s.length}, keptFrom ${keptFrom}`,
      });
    }
  }

  log('interleaved drop-front: base-block splice and pyramid block release');
  {
    // The randomized cross-check above never leaves one level-1 block (2^24 samples), so it
    // never splices a base block and never releases pyramid storage - and those are the
    // only codepaths where `head` and `levelHead` stop being zero. The planar store has the
    // same test; the interleaved store keeps its own cursors over its own base layout, so it
    // needs its own copy. 16 channels: the release arithmetic is per level and per bin and
    // the word width only changes the byte count, while the randomized cases above already
    // cover 32 channels.
    const cc = 16;
    const bps = cc >>> 3;
    const wordBytes = 2; // 16-channel words are uint16
    const drop = (1 << 24) + 512 * 300 + 192; // a whole base block plus a 64-quantum tail
    const before = drop + 400_000;
    const after = 1_000_000;
    const raw = dropFrontStream((before + after) * bps);

    const matchesTail = (
      s: InterleavedSampleStore, tail: InterleavedSampleStore, label: string,
    ): void => {
      let ok = tail.length === s.length;
      let detail = `length ${s.length}`;
      if (ok && s.length > 1) {
        for (const [st, en, bins] of [
          [0, s.length, 997], [17, Math.floor(s.length / 2), 513], [0, Math.min(s.length, 65_537), 1021],
          // Two columns over the whole window is ~700k samples per column, which is the
          // only way to force the descent to level 4 - and level 4 is one of the levels
          // the drop above releases, so this reads through a non-zero levelHead.
          [0, s.length, 2],
        ] as const) {
          if (!(en > st)) continue;
          for (let c = 0; c < s.channelCount && ok; c++) {
            const qa = s.query(c, st, en, bins).packed.slice();
            const qb = tail.query(c, st, en, bins).packed;
            for (let i = 0; i < bins; i++) {
              if ((qa[i]! & 7) !== (qb[i]! & 7)) {
                ok = false; detail = `query c${c} [${st},${en}) bin ${i}`; break;
              }
            }
          }
        }
        for (let c = 0; c < s.channelCount && ok; c++) {
          const ea = s.edges(c, 0, Math.min(s.length, 250_000));
          const eb = tail.edges(c, 0, Math.min(s.length, 250_000));
          if (ea.length !== eb.length) {
            ok = false; detail = `edges c${c} count ${ea.length} vs ${eb.length}`; break;
          }
          for (let i = 0; i < ea.length; i++) {
            if (ea[i] !== eb[i]) { ok = false; detail = `edges c${c} #${i} ${ea[i]} vs ${eb[i]}`; break; }
          }
        }
        for (const p of [0, 1, 511, 512, 513, s.length - 1, Math.floor(s.length / 2)]) {
          if (p < 0 || p >= s.length) continue;
          for (let c = 0; c < s.channelCount && ok; c++) {
            if (s.sampleAt(c, p) !== tail.sampleAt(c, p)) { ok = false; detail = `sampleAt c${c} ${p}`; }
          }
        }
      }
      results.push({ name: `interleaved dropFront equals a fresh tail store (${label})`, pass: ok, detail });
    };

    const s = new InterleavedSampleStore(100e6, cc);
    s.append(raw.subarray(0, before * bps));
    const beforePyramid = s.memory().pyramidBytes;
    s.dropFront(drop);
    const afterDrop = s.memory();
    s.append(raw.subarray(before * bps, (before + after) * bps));
    const afterAppendPyramid = s.memory().pyramidBytes;
    // A level-k block is 2^max(8, 24-4k) bins and a level-1 bin is 16 samples, so this
    // drop (just over 2^24 samples) covers exactly one whole block at levels 1-4 and
    // nothing above them. Two planes per level, uint16 words.
    const wantReleased = (2 ** 20 + 2 ** 16 + 2 ** 12 + 2 ** 8) * 2 * wordBytes;
    // One whole base block spliced: 2^24 uint16 samples per block, however much is left.
    const wantBase = 2 ** 24 * wordBytes;
    results.push({
      name: 'interleaved dropFront splices a base block and releases pyramid blocks',
      pass: beforePyramid - afterDrop.pyramidBytes === wantReleased &&
        afterDrop.baseBytes === wantBase &&
        afterAppendPyramid === afterDrop.pyramidBytes,
      detail: `pyramid ${beforePyramid} -> ${afterDrop.pyramidBytes} (released ${
        beforePyramid - afterDrop.pyramidBytes}, want ${wantReleased}) -> ${afterAppendPyramid} after ${
        after} appends; base ${afterDrop.baseBytes} (want ${wantBase})`,
    });
    const tail = new InterleavedSampleStore(100e6, cc);
    tail.append(raw.subarray(drop * bps, (before + after) * bps));
    matchesTail(s, tail, 'after a base-block splice');

    // A second, sub-block drop: `head` and the level heads are already shifted and no
    // block is released, which is the steady loop shape (drops land between boundaries).
    const second = 64 * 1001;
    s.dropFront(second);
    const tail2 = new InterleavedSampleStore(100e6, cc);
    tail2.append(raw.subarray((drop + second) * bps, (before + after) * bps));
    matchesTail(s, tail2, 'after a sub-block drop past a release');
  }

  {
    const bit = (i: number): number => (Math.imul(i ^ 0x27d4eb2f, 2654435761) >>> 31) & 1;
    const p = new BitPlane(6);
    p.extendTo(1000);
    for (let i = 0; i < 1000; i++) p.setBit(i, bit(i));
    let droppedBits = 0;
    let planeOk = true;
    let blocksBefore = p.blocks.length;
    const verify = (): void => {
      for (let i = 0; i < p.bits; i++) {
        if (p.getBit(i) !== bit(i + droppedBits)) { planeOk = false; return; }
      }
      const st = p.rangeState(0, Math.min(97, p.bits));
      let want = 0;
      for (let i = 0; i < Math.min(97, p.bits); i++) want |= bit(i + droppedBits) ? 1 : 2;
      if (st !== want) planeOk = false;
      if (p.anyOne(0, p.bits) !== (want & 1 ? true : false)) planeOk = false;
    };
    p.dropFront(32);
    droppedBits += 32;
    verify();
    const released: number[] = [];
    for (let k = 0; k < 10; k++) {
      p.dropFront(64);
      droppedBits += 64;
      released.push(blocksBefore - p.blocks.length);
      blocksBefore = p.blocks.length;
      verify();
    }
    const shrank = released.some((d) => d > 0);
    results.push({
      name: 'BitPlane dropFront keeps bits, ranges and releases blocks',
      pass: planeOk && shrank && p.bits === 1000 - droppedBits,
      detail: `bits left ${p.bits}, block releases per drop ${released.join(',')}`,
    });
    const planeBad: string[] = [];
    for (const [name, d] of [['31 bits', 31], ['zero', 0], ['past written', p.bits + 32]] as const) {
      let threw = false;
      try { p.dropFront(d as number); } catch { threw = true; }
      if (!threw) planeBad.push(name as string);
    }
    results.push({
      name: 'BitPlane dropFront argument contract is enforced',
      pass: planeBad.length === 0,
      detail: planeBad.length === 0 ? 'all refused' : `accepted: ${planeBad.join(', ')}`,
    });
  }

  return results;
}

/** The full suite minus the 100M-sample cases, which are driven by the bench. */
export function runFastSuite(log: Log): TestResult[] {
  const results: TestResult[] = [];
  log('software trigger');
  results.push(...runSoftwareTriggerSuite());
  log('parallel bus value');
  results.push(...runBusValueSuite());
  log('generator sanity');
  {
    const tile = makeTileBlock();
    const buf = new Uint16Array(MACRO_SAMPLES);
    const toggling = new Array<number>(16).fill(0);
    for (let m = 0; m < 8; m++) {
      fillMacro(buf, m, 1, tile);
      for (let c = 0; c < 16; c++) {
        let last = (buf[0]! >>> c) & 1;
        let n = 0;
        for (let i = 1; i < MACRO_SAMPLES; i++) { const v = (buf[i]! >>> c) & 1; if (v !== last) { n++; last = v; } }
        toggling[c]! += n;
      }
    }
    // A fast clock, several bursty buses that move but not constantly, a couple of
    // near-static lines, and two rails that never move at all.
    const pass =
      toggling[0]! > 1_000_000 &&                        // fast clock
      toggling[14] === 0 && toggling[15] === 0 &&        // rails
      toggling[12]! > 0 && toggling[12]! < 40 &&         // glitch channel: rare
      toggling[13]! > 0 && toggling[13]! < 40 &&         // enable: rare
      toggling[3]! > 100 && toggling[3]! < 100_000 &&    // UART: bursty
      toggling[5]! > 100 && toggling[5]! < 100_000;      // SPI clock: bursty
    results.push({
      name: 'generator produces a mix, not noise',
      pass,
      detail: `edges per 8 x 2^20 samples per channel: ${toggling.join(', ')}`,
    });
  }
  log('brute-force comparison, aligned chunks');
  results.push(...testAgainstBruteForce(log, 1 << 16, 400000));
  log('brute-force comparison, prime chunks (unaligned append)');
  results.push(...testAgainstBruteForce(log, 4099, 400000));
  log('rle brute-force comparison, aligned chunks');
  results.push(...testRleAgainstBruteForce(log, 1 << 16, 400000));
  log('rle brute-force comparison, prime chunks (unaligned append)');
  results.push(...testRleAgainstBruteForce(log, 4099, 400000));
  log('rle transition quantisation');
  results.push(...testRleQuantization());
  log('gap spans');
  results.push(...testGaps());
  log('interleaved gap parity');
  results.push(...testInterleavedGapParity());
  log('narrow channel modes');
  results.push(...testNarrowModes());
  log('wide channel modes');
  results.push(...testWideModes());
  log('live capture');
  results.push(...testLiveCapture());
  log('drop-front retention');
  results.push(...testDropFront(log));
  log('bad arguments');
  {
    const planar = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
    planar.append(new Uint8Array(4096 * 2));
    results.push(...testBadArguments(planar, 'planar'));
    const interleaved = new InterleavedSampleStore(100e6, 16);
    interleaved.append(new Uint8Array(4096 * 2));
    results.push(...testBadArguments(interleaved, 'interleaved'));
    const rle = RleSampleStore.fromTransitions(16, 100e6, 4096,
      Array.from({ length: 16 }, () => ({ initial: 0, transitions: new Float64Array(0) })));
    results.push(...testBadArguments(rle, 'rle'));
    let rleAppendThrows = false;
    try { rle.append(new Uint8Array(2)); } catch { rleAppendThrows = true; }
    results.push({
      name: 'rle append throws (immutable store)',
      pass: rleAppendThrows,
      detail: rleAppendThrows ? 'append() refused' : 'append() did not throw',
    });
  }
  log('deep pyramid levels (24M samples, this one takes a few seconds)');
  results.push(...testDeepLevels(log));
  return results;
}

export function formatResults(results: TestResult[]): string {
  const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
  const failed = results.filter((r) => !r.pass).length;
  lines.push(`\n${results.length - failed}/${results.length} passed`);
  return lines.join('\n');
}
