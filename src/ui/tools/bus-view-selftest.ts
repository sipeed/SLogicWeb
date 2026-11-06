// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bus-view helpers: bit order (Auto/MSB/LSB), contiguous fills and the summary text.
 *
 *   node_modules/.bin/esbuild src/ui/tools/bus-view-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/bus-view-selftest.mjs && node /tmp/bus-view-selftest.mjs
 */

import { busSteps, type BusSpec } from '../../data/busValue.js';
import { PlanarSampleStore } from '../../data/planarStore.js';
import {
  analogFrame, applyBusBitOrder, beginAnalogFrameBudget, busRun, busSummary,
  endAnalogFrameBudget, resolveBusBitOrder, runBits, runStart, swapBusOrder,
  type BusBitOrder,
  type BusViewConfig, type BusViewState,
} from '../busView.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

check('busRun sees ascending, descending and scrambled bits',
  busRun([0, 1, 2]) === 'up' && busRun([11, 10, 9]) === 'down' && busRun([0, 2, 1]) === null && busRun([4]) === null);

check('runBits: the start channel is the LSB', eq(runBits(2, 4, 16, false), [2, 3, 4, 5]));
check('runBits: with msbFirst the start channel is the MSB, same channels',
  eq(runBits(2, 4, 16, true), [5, 4, 3, 2]));
check('a run is shifted to fit below the channel count', eq(runBits(14, 4, 16, false), [12, 13, 14, 15]) &&
  eq(runBits(14, 4, 16, true), [15, 14, 13, 12]));
check('runStart reads the editor state back from the bits',
  eq(runStart([2, 3, 4, 5]), { start: 2, msbFirst: false }) && eq(runStart([5, 4, 3, 2]), { start: 2, msbFirst: true }) &&
  eq(runStart([3, 0, 7]), { start: 3, msbFirst: false }));
check('runBits and runStart round-trip', [false, true].every((m) => {
  const r = runStart(runBits(6, 12, 32, m));
  return r.start === 6 && r.msbFirst === m;
}));

// The A/D switch: which end of a contiguous run is the code's MSB.
{
  const cfg = (bits: number[], bitOrder: BusBitOrder): BusViewConfig => ({
    name: 'ADC', bitOrder, spec: { bits, clock: null, encoding: 'unsigned' },
    color: '#000000', fullScaleV: null, offsetV: 0, style: 'line', heightCss: 120, hideSources: false,
  });
  check('Auto is MSB on live input and LSB on test patterns',
    resolveBusBitOrder('auto', 0) === 'msb' && resolveBusBitOrder('auto', 1) === 'lsb' &&
    resolveBusBitOrder('auto', 2) === 'lsb');
  check('Auto orients a run for the mode; applying it again changes nothing',
    eq(applyBusBitOrder(cfg([0, 1, 2, 3], 'auto'), 0).spec.bits, [3, 2, 1, 0]) &&
    eq(applyBusBitOrder(cfg([0, 1, 2, 3], 'auto'), 2).spec.bits, [0, 1, 2, 3]) &&
    eq(applyBusBitOrder(cfg([3, 2, 1, 0], 'auto'), 2).spec.bits, [0, 1, 2, 3]) &&
    (() => {
      const once = applyBusBitOrder(cfg([0, 1, 2, 3], 'auto'), 0);
      return applyBusBitOrder(once, 0) === once;
    })());
  check('an explicit order wins over the mode',
    eq(applyBusBitOrder(cfg([0, 1, 2, 3], 'msb'), 2).spec.bits, [3, 2, 1, 0]) &&
    eq(applyBusBitOrder(cfg([3, 2, 1, 0], 'lsb'), 0).spec.bits, [0, 1, 2, 3]));
  check('an already-correct orientation is returned unchanged',
    (() => { const c = cfg([3, 2, 1, 0], 'auto'); return applyBusBitOrder(c, 0) === c; })());
  check('scrambled wiring is left alone',
    eq(applyBusBitOrder(cfg([3, 0, 7], 'auto'), 0).spec.bits, [3, 0, 7]));
}

{
  const spec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], clock: { channel: 12, edge: 'rising' }, encoding: 'twos' };
  const once = swapBusOrder(spec);
  check('swapping reverses the bits and keeps clock and encoding',
    eq(once.bits, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) && eq(once.clock, spec.clock) && once.encoding === 'twos');
  check('swapping twice is the original', eq(swapBusOrder(once), spec));
  check('the input spec is not mutated', spec.bits[0] === 0);
  check('summaries read LSB first in both directions',
    busSummary(spec) === 'D0–D11 · ↑D12' && busSummary(once) === 'D11–D0 · ↑D12',
    `${busSummary(spec)} | ${busSummary(once)}`);
  check('scrambled bits are listed one by one', busSummary({ ...spec, bits: [3, 0, 7], clock: null }) === 'D3,D0,D7');
}

// What a swap means for the values: every code is bit-reversed.
{
  const n = 10;
  const len = 2000;
  const words = new Uint16Array(len);
  for (let i = 0; i < len; i++) words[i] = (i * 37 + (i >> 3)) & ((1 << n) - 1);
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
  store.append(new Uint8Array(words.buffer));
  const spec: BusSpec = { bits: Array.from({ length: n }, (_, i) => i), clock: null, encoding: 'unsigned' };
  const swapped = swapBusOrder(spec);
  const rev = (x: number) => { let r = 0; for (let k = 0; k < n; k++) r = (r << 1) | ((x >> k) & 1); return r; };
  const a = busSteps(store, spec, 0, len);
  const b = busSteps(store, swapped, 0, len);
  let bad = '';
  if (a.count !== b.count) bad = `step counts ${a.count} vs ${b.count}`;
  for (let i = 0; i < a.count && !bad; i++) {
    if (a.pos[i] !== b.pos[i] || b.val[i] !== rev(a.val[i]!)) bad = `step ${i}: ${a.val[i]} -> ${b.val[i]}, want ${rev(a.val[i]!)}`;
  }
  check('a swapped bus reads every code bit-reversed', bad === '', bad);
}

// Cache identity: appending outside a fixed window must not rescan it.
{
  const store = new PlanarSampleStore({ channelCount: 4, samplerate: 1e6 });
  store.append(Uint8Array.from({ length: 16 }, (_, i) => i & 1));
  const bv: BusViewState = {
    name: 'D0', bitOrder: 'lsb', spec: { bits: [0], clock: null, encoding: 'unsigned' },
    color: '#000000', fullScaleV: null, offsetV: 0, style: 'line', heightCss: 120, hideSources: false,
    id: 'cache-test', builder: null, builtFor: null, cache: null,
  };
  const live = analogFrame(store, bv, 0, 4, 64, true);
  const stopped = analogFrame(store, bv, 0, 4, 64, false);
  store.append(Uint8Array.from({ length: 16 }, (_, i) => i & 1));
  const appended = analogFrame(store, bv, 0, 4, 64, false);
  const edgeBefore = analogFrame(store, bv, 0, store.length, 64, true);
  store.append(Uint8Array.from([1, 0, 1, 0]));
  const edgeAfter = analogFrame(store, bv, 0, store.length, 64, true);
  check('analog cache ignores unrelated appends but tracks live state and a growing visible edge',
    live !== stopped && stopped === appended && edgeBefore !== edgeAfter,
    `live=${live !== stopped}, fixed=${stopped === appended}, edge=${edgeBefore !== edgeAfter}`);
}

// A Repeat composite keeps its length but its frontier advances: the frame cache must not
// serve the envelope from before the fill.
{
  const inner = new PlanarSampleStore({ channelCount: 4, samplerate: 1e6 });
  inner.append(Uint8Array.from({ length: 20 }, (_, i) => i & 1));
  let frontier = 10;
  const wrapped = {
    get channelCount() { return inner.channelCount; },
    get samplerate() { return inner.samplerate; },
    get length() { return inner.length; },
    get droppedSamples() { return inner.droppedSamples; },
    get frontier() { return frontier; },
    append: (chunk: Uint8Array) => inner.append(chunk),
    dropFront: (n: number) => inner.dropFront(n),
    query: (channel: number, a: number, b: number, bins: number) => inner.query(channel, a, b, bins),
    edges: (channel: number, a: number, b: number) => inner.edges(channel, a, b),
    sampleAt: (channel: number, i: number) => inner.sampleAt(channel, i),
    noteGap: (a: number, b: number) => inner.noteGap(a, b),
    gaps: () => inner.gaps(),
  } as unknown as Parameters<typeof analogFrame>[0] & { frontier: number };
  const bv: BusViewState = {
    name: 'D0', bitOrder: 'lsb', spec: { bits: [0], clock: null, encoding: 'unsigned' },
    color: '#000000', fullScaleV: null, offsetV: 0, style: 'line', heightCss: 120, hideSources: false,
    id: 'frontier-test', builder: null, builtFor: null, cache: null,
  };
  const first = analogFrame(wrapped, bv, 0, inner.length, 64, true);
  frontier = 15;
  const second = analogFrame(wrapped, bv, 0, inner.length, 64, true);
  check('a composite frontier invalidates the analog frame cache with a stable length',
    first !== second,
    `same=${first === second}, length=${wrapped.length}, frontier=${wrapped.frontier}`);
}

// Zoomed-out analog rows never fall through both paths. The fast loop suspends the
// pyramid builder, and the exact envelope stops at two pyramid leaves (2048 samples)
// per pixel; a bounded sample of each unbuilt column keeps a coarse envelope on screen.
{
  const len = 400_000;
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
  const words = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    const code = Math.round(128 + 90 * Math.sin(i / 1940));
    words[i] = code & 0xff;
  }
  store.append(new Uint8Array(words.buffer));
  const spec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
  const view = (): BusViewState => ({
    id: 'provisional', name: 'ADC', spec, color: '#fff', fullScaleV: null, offsetV: 0, bitOrder: 'msb',
    style: 'line', heightCss: 120, hideSources: false, builder: null, builtFor: null, cache: null,
  });

  const frame = analogFrame(store, view(), 0, len, 100, true);
  let finite = 0;
  let bracket = true;
  if (frame.kind === 'columns') {
    for (let c = 0; c < 100; c++) {
      if (!Number.isNaN(frame.min[c]!)) finite++;
      if (frame.min[c]! > frame.max[c]!) bracket = false;
    }
  }
  check('a coarse window without a builder renders a provisional envelope',
    frame.kind === 'columns' && frame.provisional === true && finite === 100 && bracket,
    frame.kind === 'columns' ? `finite=${finite}/100 provisional=${frame.provisional}` : `kind=${frame.kind}`);

  // Read cost is capped by the frame width, not by the visible window: a 2^31-sample
  // window must not walk samples, and columns outside the store stay unknown.
  let reads = 0;
  const counted = new Proxy(store, {
    get(target, prop) {
      if (prop === 'sampleAt') {
        return (channel: number, index: number): number => {
          reads++;
          return target.sampleAt(channel, index);
        };
      }
      return Reflect.get(target, prop, target);
    },
  });
  const huge = analogFrame(counted, view(), 0, 2 ** 31, 100, true);
  const hugeFinite = huge.kind === 'columns'
    ? huge.min.reduce((n, v) => n + (Number.isNaN(v) ? 0 : 1), 0) : -1;
  check('provisional reads are bounded by width, not by the visible window',
    huge.kind === 'columns' && huge.provisional === true && reads <= 100 * 64 &&
    hugeFinite >= 1 && hugeFinite < 5,
    `reads=${reads}, finite=${hugeFinite}`);

  // A capture gap is unknown, not a value to interpolate across.
  store.noteGap(80_000, 120_000);
  const gapped = analogFrame(store, view(), 0, len, 20, true);
  const gappedAt = (c: number): boolean => gapped.kind === 'columns' &&
    !Number.isNaN(gapped.min[c]!);
  check('provisional columns inside a capture gap stay unknown',
    gapped.kind === 'columns' && gappedAt(3) && !gappedAt(4) && !gappedAt(5) && gappedAt(6),
    gapped.kind === 'columns'
      ? `c3=${gappedAt(3)} c4=${gappedAt(4)} c5=${gappedAt(5)} c6=${gappedAt(6)}`
      : `kind=${gapped.kind}`);

  // A clocked bus latches on an edge; sampling it at arbitrary positions would be a
  // different value, so it keeps the existing "wait for the builder" note.
  const clocked: BusViewState = {
    ...view(),
    spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: { channel: 8, edge: 'rising' }, encoding: 'unsigned' },
  };
  const clockedFrame = analogFrame(store, clocked, 0, len, 20, true);
  check('a coarse clocked bus without a builder stays a live placeholder',
    clockedFrame.kind === 'empty' && clockedFrame.reason === 'live',
    `kind=${clockedFrame.kind}`);
  // The App brackets a draw with a shared read budget, so four analog banks and user
  // buses cannot multiply the provisional cost by the number of rows.
  {
    const budgetStore = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
    const words = new Uint16Array(400_000);
    for (let i = 0; i < words.length; i++) words[i] = Math.round(128 + 90 * Math.sin(i / 1940)) & 0xff;
    budgetStore.append(new Uint8Array(words.buffer));
    const budgetSpec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
    const budgetView = (id: string): BusViewState => ({
      id, name: 'ADC', spec: budgetSpec, color: '#fff', fullScaleV: null, offsetV: 0, bitOrder: 'msb',
      style: 'line', heightCss: 120, hideSources: false, builder: null, builtFor: null, cache: null,
    });
    beginAnalogFrameBudget(1_600); // 8-bit: 200 positions across the frame
    const first = analogFrame(budgetStore, budgetView('budget-a'), 0, 400_000, 100, true);
    const second = analogFrame(budgetStore, budgetView('budget-b'), 0, 400_000, 100, true);
    endAnalogFrameBudget();
    const firstFinite = first.kind === 'columns' && first.provisional === true &&
      first.min.every((v) => !Number.isNaN(v));
    check('provisional reads share one per-draw budget across buses',
      firstFinite && second.kind === 'empty',
      first.kind === 'columns' && second.kind === 'columns'
        ? `first=${first.kind}/${first.provisional} second=columns(${second.min[0]})`
        : `first=${first.kind} second=${second.kind}`);
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `\n        ${r.detail}`}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
