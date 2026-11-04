// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Repeat two-layer display: composite coordinate mapping, mixed queries, edges, gaps,
 * and the old/current tint spans. No DOM needed: the composite is a SampleStore.
 */

import { createSampleStore } from '../../data/index.js';
import { GAP_BIT } from '../../data/types.js';
import { RepeatCompositeStore, remapRepeatSample, repeatHoldReleased, repeatSurfacePixels } from '../repeatDisplay.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

/** 8-channel store, channel 0 bits given MSB-first in `bits`; other channels 0. */
function store(bits: readonly number[], rate = 1e6) {
  const s = createSampleStore(8, rate);
  const bytes = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) bytes[i] = bits[i] ? 1 : 0;
  s.append(bytes);
  return s;
}
const bits = (n: number, f: (i: number) => number): number[] =>
  Array.from({ length: n }, (_, i) => f(i));
const columns = (view: { low: Uint8Array; high: Uint8Array; bins: number }): number[] =>
  Array.from({ length: view.bins }, (_, i) => (view.high[i] === view.low[i] ? view.low[i]! : 2));

{
  const released = (showingFront: boolean, backLength: number,
    softwareTrigger: boolean, triggerState: 'off' | 'waiting' | 'triggered' | 'not-found',
    triggerSampleIndex: number | null = null) =>
    repeatHoldReleased({ showingFront, backLength, softwareTrigger, triggerState, triggerSampleIndex });
  check('the old frame is released exactly when the new wave can show something',
    !released(false, 100, true, 'triggered') &&
    !released(true, 0, true, 'triggered') &&
    !released(true, 100, true, 'waiting') &&
    !released(true, 100, true, 'triggered', 150) &&
    released(true, 101, true, 'triggered', 100) &&
    released(true, 100, false, 'off') &&
    released(true, 100, false, 'waiting') &&
    released(true, 100, true, 'triggered'),
    `waiting=${released(true, 100, true, 'waiting')}, ` +
    `empty=${released(true, 0, true, 'triggered')}, ` +
    `T-missing=${released(true, 100, true, 'triggered', 150)}, ` +
    `free=${released(true, 100, false, 'off')}`);
}

{
  // A zoomed-out composite column covers many samples: the mixed query must aggregate
  // the whole column, not copy one finer source bin. A 10-sample pulse inside the first
  // 100-sample column must set its low/high/edge.
  const backBits = new Array<number>(10_000).fill(0);
  for (let i = 50; i < 60; i++) backBits[i] = 1;
  const back = store(backBits);
  const front = store(new Array<number>(100_000).fill(0));
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const view = c.query(0, 0, 100_000, 1000);
  check('a mixed query aggregates every sample in a wide composite column',
    view.bins === 1000 && view.low[0] === 0 && view.high[0] === 1 && view.edge[0] === 1 &&
    view.low[999] === 0 && view.high[999] === 0 && view.edge[999] === 0,
    `low=${view.low[0]}, high=${view.high[0]}, edge=${view.edge[0]}, ` +
    `last=${view.low[999]}/${view.high[999]}/${view.edge[999]}`);
}

{
  // A wide column can straddle the synthetic gap and a layer. It stays NO_DATA (the
  // contract marks any column overlapping unknown samples) while its covered part
  // contributes levels.
  const back = store([1, 0]);
  const front = store([0, 1, 0]);
  const c = new RepeatCompositeStore(back, 4, { store: front, origin: 0, hasTrigger: true });
  const view = c.query(0, 0, 7, 2);
  check('a column straddling the synthetic gap carries the gap bit and covered levels',
    c.frontier === 2 && c.delta === 4 && c.length === 7 &&
    (view.packed[0]! & GAP_BIT) !== 0 && (view.packed[1]! & GAP_BIT) !== 0 &&
    view.high[0] === 1 && view.low[0] === 0 &&
    view.high[1] === 1 && view.low[1] === 0,
    `frontier=${c.frontier}, delta=${c.delta}, ` +
    `col0=${view.low[0]}/${view.high[0]}/${view.packed[0]! & GAP_BIT}, ` +
    `col1=${view.low[1]}/${view.high[1]}/${view.packed[1]! & GAP_BIT}`);
}

{
  // The frontier can fall inside a composite column: the column holds new samples, the
  // seam, and old samples; all three must contribute.
  const back = store([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const front = store([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const view = c.query(0, 0, 12, 4);
  check('a seam inside a composite column contributes its transition and old samples',
    view.bins === 4 &&
    view.low[3] === 0 && view.high[3] === 1 && view.edge[3] === 1 &&
    view.low[2] === 0 && view.high[2] === 0 && view.edge[2] === 0,
    `col3=${view.low[3]}/${view.high[3]}/${view.edge[3]}, ` +
    `col2=${view.low[2]}/${view.high[2]}/${view.edge[2]}`);
}

{
  // More bins than the old layer has samples must not shift the old samples onto the
  // wrong composite columns.
  const front = store([1, 0, 1, 0, 1]);
  const back = store([0, 0, 0]);
  const c = new RepeatCompositeStore(back, 4, { store: front, origin: 0, hasTrigger: true });
  const view = c.query(0, 0, 9, 9);
  check('sub-sample old bins map to the right composite columns',
    columns(view).slice(4, 9).join(',') === '1,0,1,0,1' &&
    (view.packed[3]! & GAP_BIT) !== 0,
    `cols=${columns(view).join(',')}, gap3=${(view.packed[3]! & GAP_BIT) !== 0}`);
}

{
  // front: 1010101010, back: 1100. backOrigin 2, frontOrigin 4 => delta -2.
  const front = store(bits(10, (i) => i % 2));
  const back = store([1, 1, 0, 0]);
  const c = new RepeatCompositeStore(back, 2, { store: front, origin: 4, hasTrigger: true });
  check('the display extent joins the current frontier and the old layer',
    c.length === 8 && c.frontier === 4 && c.delta === -2 &&
    c.oldCoverage?.start === 0 && c.oldCoverage?.end === 8,
    `length=${c.length}, frontier=${c.frontier}, delta=${c.delta}, ` +
    `coverage=${JSON.stringify(c.oldCoverage)}`);
  check('sampleAt serves current data up to the frontier and old data beyond',
    c.sampleAt(0, 0) === 1 && c.sampleAt(0, 1) === 1 && c.sampleAt(0, 2) === 0 &&
    c.sampleAt(0, 3) === 0 && c.sampleAt(0, 4) === front.sampleAt(0, 6) &&
    c.sampleAt(0, 7) === front.sampleAt(0, 9),
    `new=${[0, 1, 2, 3].map((i) => c.sampleAt(0, i))}, ` +
    `old=${[4, 5, 6, 7].map((i) => c.sampleAt(0, i))}`);
}

{
  const front = store(bits(10, (i) => i % 2));
  const back = store([1, 1, 0, 0]);
  const c = new RepeatCompositeStore(back, 2, { store: front, origin: 4, hasTrigger: true });
  const whole = c.query(0, 0, 8, 8);
  const mixed = c.query(0, 2, 6, 4);
  const oldOnly = c.query(0, 5, 8, 3);
  const newOnly = c.query(0, 0, 4, 4);
  check('a whole-layer query keeps each composite column',
    whole.startSample === 0 && whole.endSample === 8 &&
    columns(whole).join(',') === '1,1,0,0,0,1,0,1',
    `columns=${columns(whole).join(',')}`);
  check('a mixed query picks current columns before the frontier and old after it',
    columns(mixed).join(',') === '0,0,0,1' &&
    mixed.startSample === 2 && mixed.endSample === 6,
    `columns=${columns(mixed).join(',')}`);
  check('single-layer queries clamp to their own range and keep composite coordinates',
    columns(oldOnly).join(',') === '1,0,1' && oldOnly.startSample === 5 &&
    columns(newOnly).join(',') === '1,1,0,0' && newOnly.startSample === 0,
    `old=${columns(oldOnly).join(',')}, new=${columns(newOnly).join(',')}`);
}

{
  // An old-layer internal transition is reported; the composite does not invent a seam
  // edge from the current layer's last sample into the old layer.
  const front = store([0, 0, 1, 0]);
  const back = store([1, 1]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const all = Array.from(c.edges(0, 0, c.length));
  const count = c.edgeCount(0, 0, c.length);
  const view = c.query(0, 0, 4, 4);
  const edgeBits = Array.from({ length: 4 }, (_, i) => (view.packed[i]! >> 2) & 1);
  check('the composite seam uses the visible new sample as the old layer neighbour',
    all.join(',') === '3' && count === 1 && c.length === 4 &&
    edgeBits.join(',') === '0,0,0,1',
    `edges=${all.join(',')}, count=${count}, length=${c.length}, bits=${edgeBits.join(',')}`);
}

{
  // The same seam in the other direction: the source has no edge there, but the
  // composite does (the last new sample is 1, the first old sample is 0).
  const front = store([0, 0, 0]);
  const back = store([1, 1]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const edges = Array.from(c.edges(0, 0, 3));
  const view = c.query(0, 0, 3, 3);
  const edgeBits = Array.from({ length: 3 }, (_, i) => (view.packed[i]! >> 2) & 1);
  check('a riser at the composite seam is reported even when the old store had none',
    edges.join(',') === '2' && edgeBits.join(',') === '0,0,1',
    `edges=${edges.join(',')}, bits=${edgeBits.join(',')}`);
}

{
  const front = store([0, 1, 0, 1, 0, 1, 0, 1], 1e6);
  const back = store([1, 1, 1], 1e6);
  front.noteGap(5, 7);
  back.noteGap(1, 2);
  const c = new RepeatCompositeStore(back, 1, { store: front, origin: 3, hasTrigger: true });
  const gaps = c.gaps();
  check('gaps from both layers are clipped into the old region of the composite',
    gaps.length === 2 &&
    gaps[0]!.startSample === 1 && gaps[0]!.endSample === 2 &&
    gaps[1]!.startSample === 3 && gaps[1]!.endSample === 5,
    `delta=${c.delta}, length=${c.length}, gaps=${JSON.stringify(gaps)}`);
}

{
  const front = store([0, 0, 0]);
  const back = store([1, 0, 1, 0]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  check('an old layer shorter than the current data extends nothing',
    c.length === 4 && c.oldCoverage?.end === 3,
    `length=${c.length}, coverage=${JSON.stringify(c.oldCoverage)}`);
  const noFront = new RepeatCompositeStore(back, 0, null);
  check('a composite without an old layer is just the current store',
    noFront.length === 4 && !noFront.oldCoverage &&
    noFront.sampleAt(0, 0) === 1 && noFront.sampleAt(0, 2) === 1,
    `length=${noFront.length}`);
}

{
  let threw = false;
  try {
    new RepeatCompositeStore(createSampleStore(8, 1e6), 0,
      { store: createSampleStore(16, 1e6), origin: 0, hasTrigger: false });
  } catch { threw = true; }
  const same = store([0]);
  let sameThrew = false;
  try {
    new RepeatCompositeStore(same, 0, { store: same, origin: 0, hasTrigger: false });
  } catch { sameThrew = true; }
  let nanThrew = false;
  try {
    new RepeatCompositeStore(store([0]), 0,
      { store: store([0]), origin: Number.NaN, hasTrigger: true });
  } catch { nanThrew = true; }
  let fractionalThrew = false;
  try {
    new RepeatCompositeStore(store([0]), 0.5, null);
  } catch { fractionalThrew = true; }
  const empty = new RepeatCompositeStore(createSampleStore(8, 1e6), 0, null);
  check('mismatched layer shapes, the same store twice, and non-integral origins are refused',
    threw && sameThrew && nanThrew && fractionalThrew &&
    empty.length === 0 && empty.frontier === 0 && empty.gaps().length === 0,
    `threw=${threw}, same=${sameThrew}, nan=${nanThrew}, fractional=${fractionalThrew}, ` +
    `length=${empty.length}`);
}

{
  check('a marker remaps by the layer offset and is dropped outside the new display',
    remapRepeatSample(10, 5, 100) === 15 &&
    remapRepeatSample(10, -5, 100) === 5 &&
    remapRepeatSample(95, 10, 100) === null &&
    remapRepeatSample(2, -5, 100) === null &&
    remapRepeatSample(0, 0, 0) === null &&
    remapRepeatSample(null, 5, 100) === null &&
    remapRepeatSample(1, Number.NaN, 100) === null,
    `moves=${remapRepeatSample(10, 5, 100)}/${remapRepeatSample(10, -5, 100)}, ` +
    `drop=${remapRepeatSample(95, 10, 100)}/${remapRepeatSample(2, -5, 100)}`);
}

{
  // New data wins in the overlap: an old edge that falls on a current-wave sample must
  // not be emitted again.
  const front = store([1, 0, 1, 0]);
  const back = store([0, 1]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const edges = Array.from(c.edges(0, 0, 4));
  const view = c.query(0, 0, 4, 4);
  const edgeBits = Array.from({ length: 4 }, (_, i) => (view.packed[i]! >> 2) & 1);
  check('edges from the overlapped part of the old layer are not duplicated',
    edges.join(',') === '1,3' && c.edgeCount(0, 0, 4) === 2 &&
    edgeBits.join(',') === '0,1,0,1',
    `edges=${edges.join(',')}, count=${c.edgeCount(0, 0, 4)}, bits=${edgeBits.join(',')}`);
}

{
  // The origins differ enough that the old layer starts after the new frontier: the
  // composite has a real gap between them and must not repeat old data into it.
  const front = store([0, 0, 1, 1, 0]);
  const back = store([1, 0]);
  const c = new RepeatCompositeStore(back, 10, { store: front, origin: 0, hasTrigger: true });
  const view = c.query(0, 0, 15, 15);
  const gapColumns = [];
  for (let i = 0; i < view.bins; i++) if ((view.packed[i]! & GAP_BIT) !== 0) gapColumns.push(i);
  const edges = Array.from(c.edges(0, 0, 15));
  const coverage = c.oldCoverage;
  const gaps = c.gaps();
  check('a gap between the new frontier and a later old layer is NO_DATA, not old data',
    c.frontier === 2 && c.delta === 10 && c.length === 15 &&
    coverage?.start === 10 && coverage?.end === 15 &&
    gapColumns.join(',') === '2,3,4,5,6,7,8,9' &&
    columns(view).slice(10, 15).join(',') === '0,0,1,1,0' &&
    edges.join(',') === '1,12,14' &&
    gaps.length === 1 && gaps[0]!.startSample === 2 && gaps[0]!.endSample === 10,
    `frontier=${c.frontier}, delta=${c.delta}, length=${c.length}, ` +
    `coverage=${JSON.stringify(coverage)}, gaps=${gapColumns.join(',')}, ` +
    `edges=${edges.join(',')}, storeGaps=${JSON.stringify(gaps)}`);
}

{
  // The old layer can end exactly at the frontier while the new covers everything; there
  // is no displayed old sample, so the seam probe must not read past the old store.
  const front = store([0, 1]);
  const back = store([1, 0]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const view = c.query(0, 0, 2, 2);
  const edges = Array.from(c.edges(0, 0, 2));
  check('an old layer ending at the frontier is not probed past its end',
    c.length === 2 && columns(view).join(',') === '1,0' && edges.join(',') === '1',
    `length=${c.length}, columns=${columns(view).join(',')}, edges=${edges.join(',')}`);
}

{
  // The old layer is queried with bins over its own sub-range, so a source bin can cross
  // a composite column boundary. Its levels and edge are conservatively merged into both
  // columns (documented trade-off), but its gap bit must not leak into a column whose
  // samples are all known. Repro from review: old layer has a gap at [3,5), the source
  // bin [1,7) straddles the column boundary at 6, and only column 0 really has the gap.
  const front = store([0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  front.noteGap(3, 5);
  const back = store([0]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const view = c.query(0, 0, 20, 3);
  const colGap = (i: number): boolean => (view.packed[i]! & GAP_BIT) !== 0;
  const gaps = c.gaps();
  check('a gap in a straddling source bin marks only the column that really contains it',
    colGap(0) && !colGap(1) && !colGap(2) &&
    view.low[0] === 0 && view.high[0] === 1 &&
    view.low[1] === 0 && view.high[1] === 1 && view.edge[1] === 1 &&
    view.low[2] === 0 && view.high[2] === 0 &&
    gaps.length === 1 && gaps[0]!.startSample === 3 && gaps[0]!.endSample === 5,
    `gap=${[0, 1, 2].map(colGap).join(',')}, ` +
    `col1=${view.low[1]}/${view.high[1]}/${view.edge[1]}, gaps=${JSON.stringify(gaps)}`);
}

{
  // The same conservative merge with a real gap on a later source bin: the pulse and gap
  // now belong to column 1, and column 0 must not inherit either of them.
  const front = store([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  front.noteGap(9, 11);
  const back = store([0]);
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: false });
  const view = c.query(0, 0, 20, 3);
  const colGap = (i: number): boolean => (view.packed[i]! & GAP_BIT) !== 0;
  check('a gap in a source bin that spills backwards marks only its own column',
    !colGap(0) && colGap(1) && !colGap(2) &&
    view.low[0] === 0 && view.high[0] === 0 && view.edge[0] === 0 &&
    view.low[1] === 0 && view.high[1] === 1,
    `gap=${[0, 1, 2].map(colGap).join(',')}, ` +
    `col0=${view.low[0]}/${view.high[0]}/${view.edge[0]}, ` +
    `col1=${view.low[1]}/${view.high[1]}`);
}

{
  // sr = 1 MHz, both origins at 0: current [0,5us], old [0,10us].
  // viewport [-1us, 10us] -> 100 px/us at 1100 px.
  const front = store(bits(10, () => 0));
  const back = store(bits(5, () => 0));
  const c = new RepeatCompositeStore(back, 0, { store: front, origin: 0, hasTrigger: true });
  const s = repeatSurfacePixels(c, { startSec: -1e-6, endSec: 10e-6 }, 1100);
  check('the tint reports the current span and the contiguous old span',
    s !== null && s.current !== null &&
    near(s.current.x0, 100, 0.01) && near(s.current.x1, 600, 0.01) &&
    s.old.length === 1 &&
    near(s.old[0]!.x0, 600, 0.01) && near(s.old[0]!.x1, 1100, 0.01) &&
    !s.regions.coverageComplete && s.regions.gaps.length === 1 &&
    near(s.regions.gaps[0]!.startSec, -1e-6) && near(s.regions.gaps[0]!.endSec, 0),
    `current=${JSON.stringify(s?.current)}, old=${JSON.stringify(s?.old)}, ` +
    `gaps=${JSON.stringify(s?.regions.gaps)}`);
}

{
  const c = new RepeatCompositeStore(store([0, 0, 0]), 0, null);
  const s = repeatSurfacePixels(c, { startSec: 0, endSec: 3e-6 }, 300);
  check('without an old layer the tint is current-only and the display is complete',
    s !== null && s.old.length === 0 && s.current !== null &&
    near(s.current.x0, 0, 0.01) && near(s.current.x1, 300, 0.01) &&
    s.regions.coverageComplete,
    `old=${JSON.stringify(s?.old)}, current=${JSON.stringify(s?.current)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
