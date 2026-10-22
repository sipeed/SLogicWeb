// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * busValue against a brute-force, per-sample reference, on every store kind.
 *
 * The capture is a 12-bit sine on non-contiguous channels with a DCLK that rises in the
 * middle of each stable data window, plus a few deliberately skewed bit changes (bits
 * switching one sample apart, as real parallel buses do) that an asynchronous read must
 * show and a clocked read must not. It is stored planar (16 ch), interleaved (32 ch),
 * as RLE, and planar/RLE with gaps; each is read back with busSteps over odd windows
 * and with the BusBuilder pyramid, and compared sample by sample with the reference.
 */

import {
  BUS_LEAF, BusBuilder, busRange, busSteps, busValue, latchedBefore, validateBusSpec,
  type BusEncoding, type BusSpec,
} from './busValue.js';
import { InterleavedSampleStore } from './interleavedStore.js';
import { PlanarSampleStore } from './planarStore.js';
import { RleSampleStore } from './rleStore.js';
import type { SampleStore } from './types.js';

export interface BusTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const N = 40_000;
const BITS = [3, 0, 7, 5, 9, 1, 11, 2, 13, 4, 6, 8];   // LSB..MSB, deliberately scrambled
const CLK = 14;
const PERIOD = 16;

/** The raw capture words, built once. */
function makeWords(): Uint32Array {
  const words = new Uint32Array(N);
  let code = 0;
  for (let i = 0; i < N; i++) {
    const phase = i % PERIOD;
    // A new code is driven at the start of each period; bit 3 of it lags by one sample
    // (skew), and DCLK rises mid-period, long after the data settled.
    if (phase === 0) code = Math.round(2047.5 + 2047.5 * Math.sin((2 * Math.PI * i) / 6000)) & 0xfff;
    let w = 0;
    for (let k = 0; k < BITS.length; k++) {
      let bit = (code >> k) & 1;
      if (k === 3 && phase === 0 && i >= PERIOD) bit = (words[i - 1]! >> BITS[k]!) & 1;   // late bit
      w |= bit << BITS[k]!;
    }
    if (phase >= PERIOD / 2) w |= 1 << CLK;
    words[i] = w >>> 0;
  }
  return words;
}

const WORDS = makeWords();

function planar(): PlanarSampleStore {
  const s = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
  const w16 = new Uint16Array(N);
  for (let i = 0; i < N; i++) w16[i] = WORDS[i]! & 0xffff;
  s.append(new Uint8Array(w16.buffer));
  return s;
}

function interleaved(): InterleavedSampleStore {
  const s = new InterleavedSampleStore(1e6, 32);
  s.append(new Uint8Array(WORDS.slice().buffer));
  return s;
}

const GAPS: [number, number][] = [[9_001, 9_400], [25_000, 25_017]];

function gapped(): PlanarSampleStore {
  const s = planar();
  for (const [a, b] of GAPS) s.noteGap(a, b);
  return s;
}

/** The per-sample truth, read from WORDS directly - never from a store. */
function reference(spec: BusSpec, gaps: readonly [number, number][]): Float64Array {
  const n = spec.bits.length;
  const out = new Float64Array(N);
  const inGap = (i: number) => gaps.some(([a, b]) => i >= a && i < b);
  const code = (i: number) => {
    let c = 0;
    for (let k = n - 1; k >= 0; k--) c = c * 2 + ((WORDS[i]! >>> spec.bits[k]!) & 1);
    return busValue(c, n, spec.encoding);
  };
  let held = Number.NaN;
  for (let i = 0; i < N; i++) {
    if (inGap(i)) { out[i] = Number.NaN; held = Number.NaN; continue; }
    if (!spec.clock) { out[i] = code(i); continue; }
    const clk = spec.clock.channel;
    const want = spec.clock.edge === 'rising' ? 1 : 0;
    const level = (WORDS[i]! >>> clk) & 1;
    // An edge needs a known predecessor: not at sample 0, not right after a gap.
    if (i > 0 && !inGap(i - 1) && level !== ((WORDS[i - 1]! >>> clk) & 1) && level === want) held = code(i);
    out[i] = held;
  }
  return out;
}

const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/** Expand steps over [s, e) to one value per sample and compare. */
function checkSteps(store: SampleStore, spec: BusSpec, ref: Float64Array, s: number, e: number): string {
  const st = busSteps(store, spec, s, e, { carry: s > 0 ? latchedBefore(store, spec, s) : Number.NaN });
  if (st.truncated) return 'truncated';
  if (st.count === 0 || st.pos[0] !== s) return `first step at ${st.pos[0]}, expected ${s}`;
  let k = 0;
  for (let i = s; i < e; i++) {
    while (k + 1 < st.count && st.pos[k + 1]! <= i) k++;
    const got = st.val[k]!;
    if (!same(got, ref[i]!)) return `sample ${i}: got ${got}, want ${ref[i]}`;
  }
  return '';
}

function checkPyramid(store: SampleStore, spec: BusSpec, ref: Float64Array, piece?: number): string {
  const b = new BusBuilder(store, spec, store.length, piece);
  let guard = 0;
  while (!b.step(1)) if (++guard > 10_000) return 'builder never finished';
  for (let leaf = 0; leaf * BUS_LEAF < N; leaf++) {
    const s = leaf * BUS_LEAF;
    const e = Math.min(N, s + BUS_LEAF);
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    for (let i = s; i < e; i++) {
      const v = ref[i]!;
      if (Number.isNaN(v)) continue;
      mn = Math.min(mn, v);
      mx = Math.max(mx, v);
    }
    const got = b.pyramid.range(s, e);
    const want = mn <= mx ? { min: mn, max: mx } : null;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return `leaf ${leaf}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
    }
  }
  // A wide range must equal the min/max over all of its leaves (exercises the levels).
  const all = b.pyramid.range(0, N);
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (const v of ref) if (!Number.isNaN(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  if (!all || all.min !== mn || all.max !== mx) return `whole range ${JSON.stringify(all)} vs ${mn}..${mx}`;
  return '';
}

export function runBusValueSuite(): BusTestResult[] {
  const results: BusTestResult[] = [];
  const check = (name: string, detail: string) => results.push({ name, pass: detail === '', detail: detail || 'ok' });

  const plain = planar();
  const stores: [string, SampleStore, readonly [number, number][]][] = [
    ['planar', plain, []],
    ['interleaved', interleaved(), []],
    ['rle', RleSampleStore.fromStore(plain), []],
    ['planar+gaps', gapped(), GAPS],
    ['rle+gaps', RleSampleStore.fromStore(gapped()), GAPS],
  ];
  const specs: [string, BusSpec][] = [];
  for (const encoding of ['unsigned', 'twos', 'offset'] as BusEncoding[]) {
    specs.push([`async/${encoding}`, { bits: BITS, clock: null, encoding }]);
  }
  specs.push(['clock-rising/twos', { bits: BITS, clock: { channel: CLK, edge: 'rising' }, encoding: 'twos' }]);
  specs.push(['clock-falling/unsigned', { bits: BITS, clock: { channel: CLK, edge: 'falling' }, encoding: 'unsigned' }]);
  specs.push(['clock-rising/1-bit', { bits: [BITS[11]!], clock: { channel: CLK, edge: 'rising' }, encoding: 'unsigned' }]);

  // Includes windows that start exactly at a gap's end (9_400, 25_017).
  const windows: [number, number][] = [
    [0, N], [1, 977], [8_999, 9_403], [9_400, 9_600], [24_990, 25_100], [25_017, 25_300],
    [12_345, 30_001], [N - 17, N],
  ];
  for (const [sname, store, gaps] of stores) {
    for (const [pname, spec] of specs) {
      const ref = reference(spec, gaps);
      const bad = windows.map(([s, e]) => checkSteps(store, spec, ref, s, e)).filter(Boolean);
      check(`bus steps ${sname} ${pname}`, bad[0] ?? '');
      check(`bus pyramid ${sname} ${pname}`, checkPyramid(store, spec, ref));
      // A prime chunk size crosses many chunk boundaries off the leaf grid.
      check(`bus pyramid in 4099-sample chunks ${sname} ${pname}`, checkPyramid(store, spec, ref, 4099));
    }
  }

  // The skewed bit is visible asynchronously (a one-sample glitch) and absent when clocked.
  {
    const asyncSteps = busSteps(plain, { bits: BITS, clock: null, encoding: 'unsigned' }, 0, N);
    const clocked = busSteps(plain, { bits: BITS, clock: { channel: CLK, edge: 'rising' }, encoding: 'unsigned' }, 0, N);
    const glitches = asyncSteps.count - clocked.count;
    check('async shows the skewed-bit glitches a clocked read hides', glitches > 100 ? '' : `async ${asyncSteps.count} vs clocked ${clocked.count}`);
  }

  // Encodings and ranges.
  {
    const cases: [number, number, BusEncoding, number][] = [
      [0, 12, 'unsigned', 0], [4095, 12, 'unsigned', 4095],
      [2048, 12, 'twos', -2048], [2047, 12, 'twos', 2047], [4095, 12, 'twos', -1],
      [0, 12, 'offset', -2048], [4095, 12, 'offset', 2047],
      [2 ** 32 - 1, 32, 'twos', -1], [2 ** 31, 32, 'offset', 0],
    ];
    const bad = cases.filter(([c, n, e, v]) => busValue(c, n, e) !== v).map((x) => x.join('/'));
    check('busValue decodes unsigned, two\'s complement and offset binary', bad.join(', '));
    const r = busRange(12, 'twos');
    check('busRange gives the full-scale limits', r.min === -2048 && r.max === 2047 ? '' : JSON.stringify(r));
  }

  // 32 bits through the sign bit, and a step cap that truncates.
  {
    const store = interleaved();
    const spec: BusSpec = { bits: Array.from({ length: 32 }, (_, i) => i), clock: null, encoding: 'twos' };
    const st = busSteps(store, spec, 0, 2000);
    let bad = '';
    for (let k = 0; k < st.count && !bad; k++) {
      const p = st.pos[k]!;
      const want = WORDS[p]! >= 2 ** 31 ? WORDS[p]! - 2 ** 32 : WORDS[p]!;
      if (st.val[k] !== want) bad = `at ${p}: ${st.val[k]} vs ${want}`;
    }
    check('32-bit buses keep the sign bit', bad);
    const capped = busSteps(store, spec, 0, N, { maxSteps: 10 });
    check('maxSteps truncates and says so', capped.truncated && capped.count === 10 ? '' : `truncated=${capped.truncated} count=${capped.count}`);
  }

  // A clock slower than a pyramid leaf: a latched value spans whole leaves, so it must be
  // carried across builder chunks rather than restarting unknown at each one.
  {
    const SLOW = 4096;
    const len = 40_000;
    const w = new Uint16Array(len);
    for (let i = 0; i < len; i++) w[i] = (Math.floor(i / SLOW) & 0xf) | ((i % SLOW >= SLOW / 2 ? 1 : 0) << 4);
    const store = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
    store.append(new Uint8Array(w.buffer));
    const spec: BusSpec = { bits: [0, 1, 2, 3], clock: { channel: 4, edge: 'rising' }, encoding: 'unsigned' };
    const b = new BusBuilder(store, spec, len, 4099);
    while (!b.step(1)) { /* build */ }
    let bad = '';
    for (let leaf = 3; leaf * BUS_LEAF < len && !bad; leaf++) {
      // From the first rising edge (2048) on, every sample holds the code latched at the
      // last rising edge: floor((i - 2048) / 4096) & 0xf for i >= 2048.
      const s = leaf * BUS_LEAF;
      const e = Math.min(len, s + BUS_LEAF);
      const lo = Math.floor((s - 2048) / SLOW) & 0xf;
      const hi = Math.floor((e - 1 - 2048) / SLOW) & 0xf;
      const got = b.pyramid.range(s, e);
      const want = { min: Math.min(lo, hi), max: Math.max(lo, hi) };
      if (!got || got.min !== want.min || got.max !== want.max) bad = `leaf ${leaf}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
    }
    check('a slow clock holds its latched value across builder chunks', bad);
  }

  check('validateBusSpec rejects reuse and out-of-range channels',
    validateBusSpec({ bits: [0, 0], clock: null, encoding: 'unsigned' }, 16).length > 0 &&
    validateBusSpec({ bits: [0, 1], clock: { channel: 20, edge: 'rising' }, encoding: 'unsigned' }, 16).length > 0 &&
    validateBusSpec({ bits: [0, 1], clock: { channel: 2, edge: 'rising' }, encoding: 'unsigned' }, 16).length === 0
      ? '' : 'validation');
  return results;
}
