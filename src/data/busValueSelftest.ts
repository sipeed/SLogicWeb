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
  BUS_LEAF, BusBuilder, BusPyramid, busRange, busSteps, busValue, latchedBefore, validateBusSpec,
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

  {
    const rampStore = (): PlanarSampleStore => {
      const s = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
      const w16 = new Uint16Array(N);
      for (let i = 0; i < N; i++) w16[i] = Math.floor(i / 250) & 0xff;
      s.append(new Uint8Array(w16.buffer));
      return s;
    };
    const rampSpec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
    const rampAt = (i: number): number => Math.floor(i / 250) & 0xff;
    const rampDiff = (p: BusPyramid, off: number, len: number): string => {
      let bad = '';
      for (let leaf = 0; leaf * BUS_LEAF < len && !bad; leaf++) {
        const s = leaf * BUS_LEAF;
        const e = Math.min(len, s + BUS_LEAF);
        const got = p.range(s, e);
        const want = { min: rampAt(off + s), max: rampAt(off + e - 1) };
        if (!got || got.min !== want.min || got.max !== want.max) {
          bad = `leaf ${leaf}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
        }
      }
      if (bad) return bad;
      const all = p.range(0, len);
      return all && all.min === rampAt(off) && all.max === rampAt(off + len - 1)
        ? '' : `whole range ${JSON.stringify(all)} vs ${rampAt(off)}..${rampAt(off + len - 1)}`;
    };
    const build = (b: BusBuilder): string => {
      let guard = 0;
      while (!b.step(1)) if (++guard > 10_000) return 'builder never finished';
      return '';
    };

    const gstore = rampStore();
    const grown = new BusBuilder(gstore, rampSpec, 5_000, 4099);
    const caps: number[] = [grown.pyramid.length];
    const levelCounts: number[] = [grown.pyramid.levels.length];
    let growBad = '';
    for (const target of [9_000, 17_000, 33_000, N]) {
      grown.setLength(target);
      caps.push(grown.pyramid.length);
      levelCounts.push(grown.pyramid.levels.length);
      growBad = build(grown);
      if (growBad) break;
    }
    check('a grown builder finishes every growth stage', growBad);
    check('builder growth doubles capacity geometrically',
      caps.join(',') === '5000,10000,20000,40000,40000' ? '' : caps.join(','));
    check('builder growth adds a level across BUS_LEAF*FAN',
      levelCounts.join(',') === '2,2,3,3,3' ? '' : levelCounts.join(','));
    check('a grown pyramid is exact per leaf and overall', rampDiff(grown.pyramid, 0, N));
    const fresh = new BusBuilder(rampStore(), rampSpec, N, 4099);
    build(fresh);
    const oddWindows: [number, number][] = [[1, 977], [8_999, 9_403], [12_345, 30_001], [N - 17, N]];
    const oddBad = oddWindows
      .filter(([s, e]) => JSON.stringify(grown.pyramid.range(s, e)) !== JSON.stringify(fresh.pyramid.range(s, e)))
      .map(([s, e]) => `[${s},${e}): ${JSON.stringify(grown.pyramid.range(s, e))} vs ${JSON.stringify(fresh.pyramid.range(s, e))}`);
    check('a grown pyramid matches a fresh build on odd windows', oddBad.join('; '));

    gstore.dropFront(4096);
    grown.reset(gstore.length);
    const preStep = grown.pyramid.range(0, gstore.length);
    check('reset clears built content and keeps the grown capacity',
      grown.pyramid.length === 40_000 && grown.pyramid.doneUpTo === 0 && grown.progress === 0 && preStep === null
        ? ''
        : `capacity=${grown.pyramid.length} doneUpTo=${grown.pyramid.doneUpTo} range=${JSON.stringify(preStep)}`);
    check('a reset builder finishes', build(grown));
    check('a reset pyramid matches the shifted ramp', rampDiff(grown.pyramid, 4096, gstore.length));

    const capHigh = new BusBuilder(rampStore(), rampSpec, 2_000, 4099, 50_000);
    const capLow = new BusBuilder(rampStore(), rampSpec, 5_000, 4099, 1_000);
    check('the constructor capacity hint sizes the pyramid, clamped to the length',
      capHigh.pyramid.length === 50_000 && capLow.pyramid.length === 5_000
        ? ''
        : `high=${capHigh.pyramid.length} low=${capLow.pyramid.length}`);

    // The loop path: a drop moves the window; the builder's absolute frontier means no
    // reset, no rebuild - the pyramid just follows.
    const loopStore = rampStore();
    const loopBuilder = new BusBuilder(loopStore, rampSpec, N, 4099, N * 2);
    check('a loop-window builder finishes', build(loopBuilder));
    loopStore.dropFront(8192); // leaf-aligned: 8 x 1024
    loopBuilder.setLength(loopStore.length); // the app's pump does this every frame
    check('a finished builder stays done across a drop',
      loopBuilder.done && loopBuilder.progress === 1
        ? ''
        : `done=${loopBuilder.done} progress=${loopBuilder.progress}`);
    check('a dropped pyramid matches the shifted ramp without a reset',
      rampDiff(loopBuilder.pyramid, 8192, loopStore.length));
    // A mid-build drop overtakes the frontier: the builder skips to the window's left
    // edge instead of rebuilding what it had.
    const slowStore = rampStore();
    const slow = new BusBuilder(slowStore, rampSpec, N, 4099, N * 2);
    slow.step(1);
    slow.step(1);
    const builtBefore = slow.pyramid.doneUpTo;
    slowStore.dropFront(20480);
    slow.setLength(slowStore.length);
    check('a drop past the frontier skips the builder forward',
      build(slow) === '' && slow.done ? '' : `done=${slow.done} builtBefore=${builtBefore}`);
    check('a skip-forward pyramid matches the shifted ramp',
      rampDiff(slow.pyramid, 20480, slowStore.length));
    check('the skipped builder reports full progress',
      slow.progress === 1 ? '' : `progress=${slow.progress}`);

    // A skip forgets the clocked carry too: the value before the window is unknown, not the
    // one the frontier happened to hold (the frontier can be several clock edges behind).
    const carryStore = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
    {
      const SLOW = 4096; // rising clock edges at 2048 + k*4096
      const len = 40_000;
      const w = new Uint16Array(len);
      for (let i = 0; i < len; i++) w[i] = (Math.floor(i / SLOW) & 0xf) | ((i % SLOW >= SLOW / 2 ? 1 : 0) << 4);
      carryStore.append(new Uint8Array(w.buffer));
    }
    const carrySpec: BusSpec = { bits: [0, 1, 2, 3], clock: { channel: 4, edge: 'rising' }, encoding: 'unsigned' };
    const carried = new BusBuilder(carryStore, carrySpec, carryStore.length, 1_000, N * 2);
    for (let i = 0; i < 8; i++) carried.step(0); // one piece each: frontier 8000, past the 6144 latch
    carryStore.dropFront(24_576); // 64 multiple; the first edge left in the window is 26624
    carried.setLength(carryStore.length);
    check('a skip-forward builder finishes (clocked)', build(carried));
    check('a skipped frontier forgets the clocked carry',
      carried.pyramid.range(0, 2_048) === null
        ? '' : `prefix=${JSON.stringify(carried.pyramid.range(0, 2_048))}`);
    check('a skipped builder latches again at the first in-window clock edge',
      JSON.stringify(carried.pyramid.range(2_048, 3_072)) === JSON.stringify({ min: 6, max: 6 })
        ? '' : `${JSON.stringify(carried.pyramid.range(2_048, 3_072))} vs 6`);

    // 64-sample drops are almost never leaf aligned, so the window origin (and with it the
    // ring slot of every bin) moves off a leaf boundary. A window exactly as long as the
    // ring's capacity is the tightest packing the design allows (one slack slot): if a
    // live bin ever aliased a stale one, these leaves would come back wrong.
    const R = 8 * BUS_LEAF + 512; // deliberately not a leaf multiple
    const rampSlice = (from: number, to: number): Uint8Array => {
      const w16 = new Uint16Array(to - from);
      for (let i = from; i < to; i++) w16[i - from] = rampAt(i) & 0xffff;
      return new Uint8Array(w16.buffer);
    };
    const slideStore = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
    slideStore.append(rampSlice(0, R));
    const slide = new BusBuilder(slideStore, rampSpec, slideStore.length, 2_500, R);
    check('a tight-capacity sliding builder finishes', build(slide));
    let slideD = 0;
    let slideBad = '';
    for (const step of [64, 960, 512, 448, 960, 192, 64, 960, 512, 320, 64, 960]) {
      slideStore.dropFront(step);
      slideStore.append(rampSlice(slideD + R, slideD + R + step));
      slideD += step;
      slide.setLength(slideStore.length); // exactly the ring's capacity: no growth
      const stopped = build(slide);
      if (stopped) { slideBad = `at D=${slideD}: ${stopped}`; break; }
      // Every leaf fully inside the window is fully sampled, so its min/max is the ramp's.
      for (let b = Math.ceil(slideD / BUS_LEAF); (b + 1) * BUS_LEAF <= slideD + slideStore.length; b++) {
        const s = b * BUS_LEAF - slideD;
        const got = slide.pyramid.range(s, s + BUS_LEAF);
        const want = { min: rampAt(b * BUS_LEAF), max: rampAt((b + 1) * BUS_LEAF - 1) };
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          slideBad = `D=${slideD} (origin%${BUS_LEAF}=${slideD % BUS_LEAF}) leaf ${b}: `
            + `${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
          break;
        }
      }
      // The partial window-start leaf keeps its slot too: with one slot too few it is the
      // one the partial end leaf overwrites, and the first pixel of every frame goes blank.
      // (This builder never skips its frontier, so the leaf is always known from before.)
      if (!slideBad && slideD % BUS_LEAF !== 0) {
        const firstLeafEnd = (Math.floor(slideD / BUS_LEAF) + 1) * BUS_LEAF - slideD;
        if (slide.pyramid.range(0, firstLeafEnd) === null) {
          slideBad = `D=${slideD}: the window-start leaf lost its ring slot`;
        }
      }
      if (slideBad) break;
    }
    check('a window as long as the ring capacity keeps every leaf it covers exact', slideBad);
  }

  {
    const small = new BusPyramid(BUS_LEAF);
    small.add({ pos: new Int32Array([0]), val: new Float64Array([7]), count: 1, truncated: false, carry: 7 }, BUS_LEAF);
    small.doneUpTo = BUS_LEAF;
    const big = small.growTo(512 * BUS_LEAF);
    const wide = big.range(0, 512 * BUS_LEAF);
    const deep = big.range(0, 4 * BUS_LEAF);
    check('growTo recomputes new top levels and carries doneUpTo',
      small.growTo(1) === small && big.length === 512 * BUS_LEAF && big.levels.length === 4 &&
        big.doneUpTo === BUS_LEAF &&
        wide !== null && wide.min === 7 && wide.max === 7 && deep !== null && deep.min === 7 && deep.max === 7
        ? ''
        : `wide=${JSON.stringify(wide)} levels=${big.levels.length} doneUpTo=${big.doneUpTo} deep=${JSON.stringify(deep)}`);
  }

  {
    const SLOW = 4096;
    const len = 40_000;
    const w = new Uint16Array(len);
    for (let i = 0; i < len; i++) w[i] = (Math.floor(i / SLOW) & 0xf) | ((i % SLOW >= SLOW / 2 ? 1 : 0) << 4);
    const store = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
    store.append(new Uint8Array(w.buffer));
    const spec: BusSpec = { bits: [0, 1, 2, 3], clock: { channel: 4, edge: 'rising' }, encoding: 'unsigned' };
    const b = new BusBuilder(store, spec, len, 4099);
    let guard = 0;
    while (!b.step(1)) if (++guard > 10_000) break;
    store.dropFront(1536);
    b.reset(store.length);
    guard = 0;
    while (!b.step(1)) if (++guard > 10_000) break;
    let bad = '';
    for (let leaf = 0; leaf * BUS_LEAF < store.length && !bad; leaf++) {
      const s = leaf * BUS_LEAF;
      const e = Math.min(store.length, s + BUS_LEAF);
      const at = (i: number) => (i < 512 ? Number.NaN : Math.floor((i - 512) / SLOW) & 0xf);
      let mn = Number.POSITIVE_INFINITY;
      let mx = Number.NEGATIVE_INFINITY;
      for (let i = s; i < e; i++) {
        const v = at(i);
        if (Number.isNaN(v)) continue;
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
      const got = b.pyramid.range(s, e);
      const want = mn <= mx ? { min: mn, max: mx } : null;
      if (JSON.stringify(got) !== JSON.stringify(want)) bad = `leaf ${leaf}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`;
    }
    check('a reset rebuilds a clocked bus without a stale carry', bad);
  }

  check('validateBusSpec rejects reuse and out-of-range channels',
    validateBusSpec({ bits: [0, 0], clock: null, encoding: 'unsigned' }, 16).length > 0 &&
    validateBusSpec({ bits: [0, 1], clock: { channel: 20, edge: 'rising' }, encoding: 'unsigned' }, 16).length > 0 &&
    validateBusSpec({ bits: [0, 1], clock: { channel: 2, edge: 'rising' }, encoding: 'unsigned' }, 16).length === 0
      ? '' : 'validation');
  return results;
}
