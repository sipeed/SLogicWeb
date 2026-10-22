// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bus-view helpers: bit order (MSB/LSB swap), contiguous fills and the summary text.
 *
 *   node_modules/.bin/esbuild src/ui/tools/bus-view-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/bus-view-selftest.mjs && node /tmp/bus-view-selftest.mjs
 */

import { busSteps, type BusSpec } from '../../data/busValue.js';
import { PlanarSampleStore } from '../../data/planarStore.js';
import { busRun, busSummary, runBits, runStart, swapBusOrder } from '../busView.js';

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

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `\n        ${r.detail}`}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
