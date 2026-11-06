// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Analog trace geometry at the zooms that used to look stair-stepped (1-8 samples per
 * device-pixel column): which frame form `analogFrame` picks, the exact polyline the
 * overlay strokes for points (`smoothPolyline`), and the per-column envelope.
 *
 *   node_modules/.bin/esbuild src/ui/tools/analog-geometry-selftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/analog-geometry-selftest.mjs && \
 *     node /tmp/analog-geometry-selftest.mjs
 */

import type { BusSpec } from '../../data/busValue.js';
import { PlanarSampleStore } from '../../data/planarStore.js';
import {
  SMOOTH_POINTS_MAX_SPP, catmullRomWalk, smoothBandEdges, smoothPolyline,
} from '../analogGeometry.js';
import { analogFrame, type BusViewState } from '../busView.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  results.push({ name, pass, detail });
};

// An 8-bit ADC sine, 40 samples per period, on channels 0-7 of a 16-channel store.
const LEN = 8000;
const PERIOD = 40;
const codes = new Uint8Array(LEN);
for (let i = 0; i < LEN; i++) codes[i] = Math.round(128 + 120 * Math.sin((2 * Math.PI * i) / PERIOD));
const words = new Uint16Array(LEN);
for (let i = 0; i < LEN; i++) words[i] = codes[i]!;
const store = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
store.append(new Uint8Array(words.buffer));
const spec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
const view = (): BusViewState => ({
  id: 'sine', name: 'ADC', spec, color: '#fff', fullScaleV: null, offsetV: 0, bitOrder: 'lsb',
  style: 'line', heightCss: 120, hideSources: false, builder: null, builtFor: null, cache: null,
});

const WIDTH = 300;
const START = 100.3; // fractional on purpose: columns do not align with samples

for (const spp of [1, 1.4, 1.5, 2, 2.5, 3, 3.9, 4, 5, 6, 7, 8, 12]) {
  const end = START + spp * WIDTH;
  const frame = analogFrame(store, view(), START, end, WIDTH, false);
  const tag = `${spp} samples/column`;
  if (spp < SMOOTH_POINTS_MAX_SPP) {
    if (frame.kind !== 'points') {
      check(`${tag}: drawn as the point curve`, false, `kind=${frame.kind}`);
      continue;
    }
    const xs = Array.from(frame.x.subarray(0, frame.count));
    const vs = Array.from(frame.v.subarray(0, frame.count));
    const line = smoothPolyline(xs, vs);
    const periodPx = 1 / spp;
    let backwards = 0;
    let outside = 0;
    let longestFlat = 0;
    let flatFrom = 0;
    // Vertex index of each input point: the walk visits every point exactly.
    let missing = 0;
    let seg = 0;
    for (let k = 1; k < line.x.length; k++) {
      if (!(line.x[k]! > line.x[k - 1]!)) backwards++;
      if (Math.abs(line.y[k]! - line.y[k - 1]!) > 1e-9) flatFrom = k;
      else longestFlat = Math.max(longestFlat, line.x[k]! - line.x[flatFrom]!);
      while (seg + 1 < xs.length && line.x[k]! > xs[seg + 1]! + 1e-9) seg++;
      const lo = Math.min(vs[seg]!, vs[Math.min(seg + 1, vs.length - 1)]!);
      const hi = Math.max(vs[seg]!, vs[Math.min(seg + 1, vs.length - 1)]!);
      if (line.y[k]! < lo - 1e-9 || line.y[k]! > hi + 1e-9) outside++;
    }
    let j = 0;
    for (let i = 0; i < xs.length; i++) {
      while (j < line.x.length && line.x[j]! < xs[i]! - 1e-9) j++;
      if (j >= line.x.length || Math.abs(line.x[j]! - xs[i]!) > 1e-9 || line.y[j] !== vs[i]) missing++;
    }
    // A sample-rate sine changes code on almost every sample here: the curve has one point
    // per sample, not one per column.
    const perSample = frame.count >= Math.floor(spp * WIDTH * 0.8);
    check(`${tag}: the curve passes through every sample, never steps back in x, stays ` +
      'monotone between samples and has no flat run longer than a sample period',
    perSample && backwards === 0 && outside === 0 && missing === 0 && longestFlat <= periodPx + 1e-9,
    `points=${frame.count}, vertices=${line.x.length}, backwards=${backwards}, outside=${outside}, ` +
      `missing=${missing}, flat=${longestFlat.toFixed(3)}px`);
    check(`${tag}: path cost is bounded by the plot width, not the samples`,
      line.x.length <= 5 * WIDTH + 1, `vertices=${line.x.length} for ${WIDTH} columns`);
  } else {
    if (frame.kind !== 'columns') {
      check(`${tag}: drawn as the column envelope`, false, `kind=${frame.kind}`);
      continue;
    }
    // The truth: min/max of the codes whose sample timestamp lies in each column.
    let mismatch = '';
    let wider = 0;
    for (let c = 0; c < WIDTH && !mismatch; c++) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let k = Math.ceil(START); k < Math.ceil(end); k++) {
        if (Math.floor(((k - START) / spp)) !== c) continue;
        mn = Math.min(mn, codes[k]!);
        mx = Math.max(mx, codes[k]!);
      }
      if (frame.min[c] !== mn || frame.max[c] !== mx) {
        mismatch = `column ${c}: got ${frame.min[c]}..${frame.max[c]}, in-column ${mn}..${mx}`;
      }
      if (frame.max[c]! - frame.min[c]! > mx - mn) wider++;
    }
    check(`${tag}: each column's band is exactly the in-column sample min..max (no held-value smear)`,
      mismatch === '' && wider === 0, mismatch);
    const xs = Array.from({ length: WIDTH }, (_, i) => i);
    const band = smoothBandEdges(xs, Array.from(frame.min), Array.from(frame.max));
    let order = 0;
    let crossed = 0;
    for (let k = 1; k < band.x.length; k++) if (!(band.x[k]! > band.x[k - 1]!)) order++;
    for (let k = 0; k < band.x.length; k++) if (band.upper[k]! < band.lower[k]!) crossed++;
    check(`${tag}: the smoothed band edges advance in x and never cross`,
      order === 0 && crossed === 0, `backwards=${order}, crossed=${crossed}`);
  }
}

{
  // The riser the old parametric Catmull-Rom drew where a held value made spacing uneven.
  const xs = [0, 10, 11, 21];
  const ys = [0, 1, 2, 3];
  const px: number[] = [];
  const py: number[] = [];
  catmullRomWalk(xs, ys, (x, y) => { px.push(x); py.push(y); });
  let ok = true;
  for (let k = 1; k < px.length; k++) if (!(px[k]! > px[k - 1]!) || py[k]! < py[k - 1]!) ok = false;
  check('uneven spacing cannot fold the curve back in x or make it non-monotone', ok,
    px.map((x, k) => `${x.toFixed(2)}:${py[k]!.toFixed(2)}`).slice(10, 16).join(' '));
}

// A dense sine sampled far faster than it moves (the 30-1000 samples/column zooms of a
// real ADC capture): every column must hold the true min/max of its own samples. The
// old fallback drew 1024-sample pyramid leaves, ~10 px flat boxes, as a staircase.
{
  const len = 2_500_000;
  const period = 10_000;
  const dense = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    // +-1 LSB of deterministic dither: a real ADC changes code on nearly every sample,
    // which is what overflowed the cached step list into the leaf fallback.
    dense[i] = Math.round(128 + 60 * Math.sin((2 * Math.PI * i) / period)) + ((i * 7919) % 3) - 1;
  }
  const denseStore = new PlanarSampleStore({ channelCount: 16, samplerate: 100e6 });
  denseStore.append(new Uint8Array(dense.buffer));
  const width = 1000;
  for (const spp of [50, 100, 300, 700, 1000]) {
    const start = 1234.5;
    const end = start + spp * width;
    const frame = analogFrame(denseStore, view(), start, end, width, false);
    if (frame.kind !== 'columns') {
      check(`dense sine at ${spp} samples/column: drawn as columns`, false, `kind=${frame.kind}`);
      continue;
    }
    let bad = '';
    let widest = 0;
    for (let c = 0; c < width && !bad; c++) {
      const lo = Math.max(0, Math.ceil(start + c * spp));
      const hi = Math.min(len, Math.ceil(start + (c + 1) * spp));
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = lo; i < hi; i++) { mn = Math.min(mn, dense[i]!); mx = Math.max(mx, dense[i]!); }
      if (frame.min[c] !== mn || frame.max[c] !== mx) {
        bad = `column ${c}: got [${frame.min[c]}, ${frame.max[c]}], want [${mn}, ${mx}]`;
      }
      widest = Math.max(widest, mx - mn);
    }
    // A column of spp samples on this sine spans at most 2*pi*60*spp/period codes (+3 for
    // rounding and dither); a leaf-wide box would be several times that at the small zooms.
    const bound = Math.ceil((2 * Math.PI * 60 * spp) / period) + 3;
    check(`dense sine at ${spp} samples/column: each column is its own samples' min/max`,
      bad === '' && widest <= bound, bad || `widest band ${widest} codes, bound ${bound}`);
  }
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
