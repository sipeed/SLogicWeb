// SPDX-License-Identifier: GPL-3.0-or-later

import {
  persistenceSignature, trailDecay,
  type PersistenceSourceKey,
} from '../persistenceTrail.js';
import {
  PersistenceTrail, type PersistenceBandSpec, type PersistenceSyncInput,
} from '../persistenceSurfaces.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

interface FakeCanvas {
  width: number;
  height: number;
}

class FakeCtx {
  readonly ops: string[] = [];
  transform: readonly number[] = [1, 0, 0, 1, 0, 0];
  globalAlpha = 1;
  globalCompositeOperation = 'source-over';
  fillStyle = '';
  private readonly stack: (readonly number[])[] = [];
  constructor(readonly canvas: FakeCanvas) {}
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
  }
  save(): void {
    this.ops.push('save');
    this.stack.push(this.transform);
  }
  restore(): void {
    this.ops.push('restore');
    const saved = this.stack.pop();
    if (saved !== undefined) this.transform = saved;
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(`clear:${x},${y},${w},${h}`);
  }
  fillRect(): void { this.ops.push('fill'); }
}

interface Harness {
  trail: PersistenceTrail;
  canvases: FakeCanvas[];
}

function harness(): Harness {
  const canvases: FakeCanvas[] = [];
  const trail = new PersistenceTrail(() => {
    const canvas: FakeCanvas = { width: 0, height: 0 };
    canvases.push(canvas);
    return {
      canvas: canvas as unknown as HTMLCanvasElement,
      ctx: new FakeCtx(canvas) as unknown as CanvasRenderingContext2D,
    };
  });
  return { trail, canvases };
}

function ctxOf(frame: { ctx: CanvasRenderingContext2D }): FakeCtx {
  return frame.ctx as unknown as FakeCtx;
}

function clears(frame: { ctx: CanvasRenderingContext2D }): number {
  return ctxOf(frame).ops.filter((op) => op.startsWith('clear:')).length;
}

const SOURCE_A: PersistenceSourceKey = {
  busId: 'bus-a',
  gain: 2,
  fullScaleV: 1.65,
  voltsPerDiv: 0.5,
  zeroPosition: 0.5,
  offsetV: 0,
  color: '#2683D9',
  visible: true,
};

const SOURCE_B: PersistenceSourceKey = {
  busId: 'bus-b',
  gain: 1,
  fullScaleV: null,
  voltsPerDiv: null,
  zeroPosition: 0.25,
  offsetV: 0.1,
  color: '#CD427E',
  visible: false,
};

function bandA(over: Partial<PersistenceBandSpec> = {}): PersistenceBandSpec {
  return { id: 'band-a', top: 0, height: 160, sources: [SOURCE_A], ...over };
}

function bandB(over: Partial<PersistenceBandSpec> = {}): PersistenceBandSpec {
  return { id: 'band-b', top: 160, height: 120, sources: [SOURCE_B], ...over };
}

function baseInput(over: Partial<PersistenceSyncInput> = {}): PersistenceSyncInput {
  return {
    frames: 8,
    width: 800,
    dpr: 2,
    viewportStart: 1000,
    viewportEnd: 9000,
    analogLayout: 'stacked',
    samplerate: 100e6,
    event: 'none',
    bands: [bandA(), bandB()],
    ...over,
  };
}

{
  const { trail, canvases } = harness();
  const result = trail.sync(baseInput());
  const a = trail.surface('band-a');
  const b = trail.surface('band-b');
  check('one bounded surface per current analog band, sized in CSS px and backed at the device ratio',
    canvases.length === 2 && trail.views().length === 2 &&
    a !== undefined && b !== undefined &&
    a.width === 800 && a.height === 160 && a.top === 0 &&
    a.canvas.width === 1600 && a.canvas.height === 320 &&
    b.canvas.width === 1600 && b.canvas.height === 240 &&
    JSON.stringify(ctxOf(a).transform) === '[2,0,0,2,0,0]' &&
    !result.reallocated && result.removed.length === 0 && result.reasons.length === 0,
    `canvases=${canvases.length}, size=${a?.canvas.width}x${a?.canvas.height}, ` +
    `transform=${JSON.stringify(a ? ctxOf(a).transform : null)}`);
  check('a fresh surface starts at generation 1 with no commits',
    a !== undefined && a.generation === 1 && a.commits === 0 && a.key !== null,
    `generation=${a?.generation}, commits=${a?.commits}`);
}

{
  const { trail, canvases } = harness();
  trail.sync(baseInput());
  const a = trail.surface('band-a')!;
  const canvas = a.canvas;
  const before = clears(a);
  const result = trail.sync(baseInput());
  check('an unchanged display clears nothing, reallocates nothing and allocates nothing',
    clears(a) === before && a.canvas === canvas && a.generation === 1 &&
    !result.reallocated && result.reasons.length === 0 && canvases.length === 2,
    `clears=${clears(a)}/${before}, generation=${a.generation}, canvases=${canvases.length}`);
}

{
  const mutations: Array<[string, Partial<PersistenceSyncInput>]> = [
    ['viewport span', { viewportEnd: 9001 }],
    ['plot width', { width: 801 }],
    ['sample rate', { samplerate: 50e6 }],
    ['analog layout', { analogLayout: 'merged' }],
    ['band top', { bands: [bandA({ top: 4 }), bandB()] }],
    ['source gain', { bands: [bandA({ sources: [{ ...SOURCE_A, gain: 4 }] }), bandB()] }],
    ['source calibration', {
      bands: [bandA({ sources: [{ ...SOURCE_A, fullScaleV: 3.3 }] }), bandB()] }],
    ['source V/div', { bands: [bandA({ sources: [{ ...SOURCE_A, voltsPerDiv: 1 }] }), bandB()] }],
    ['source zero', { bands: [bandA({ sources: [{ ...SOURCE_A, zeroPosition: 0.4 }] }), bandB()] }],
    ['source offset', { bands: [bandA({ sources: [{ ...SOURCE_A, offsetV: 0.2 }] }), bandB()] }],
    ['source colour', {
      bands: [bandA({ sources: [{ ...SOURCE_A, color: '#123456' }] }), bandB()] }],
    ['source visibility', {
      bands: [bandA({ sources: [{ ...SOURCE_A, visible: false }] }), bandB()] }],
  ];
  const missed: string[] = [];
  const noReason: string[] = [];
  for (const [label, over] of mutations) {
    const { trail } = harness();
    trail.sync(baseInput());
    const a = trail.surface('band-a')!;
    const generation = a.generation;
    const before = clears(a);
    const result = trail.sync(baseInput(over));
    if (clears(a) === before || a.generation === generation) missed.push(label);
    if (!result.reasons.includes('display-change')) noReason.push(label);
  }
  check('every viewport span, geometry, layout, rate and per-source calibration change clears before the next commit',
    missed.length === 0 && noReason.length === 0,
    `notCleared=${JSON.stringify(missed)}, noReason=${JSON.stringify(noReason)}`);

  const dpr = harness();
  dpr.trail.sync(baseInput());
  const ratio = dpr.trail.surface('band-a')!;
  const before = clears(ratio);
  const result = dpr.trail.sync(baseInput({ dpr: 3 }));
  check('a device-ratio change reallocates the backing store and follows it with the transform',
    result.reallocated && ratio.canvas.width === 2400 && ratio.canvas.height === 480 &&
    JSON.stringify(ctxOf(ratio).transform) === '[3,0,0,3,0,0]' &&
    clears(ratio) === before + 1,
    `reallocated=${result.reallocated}, size=${ratio.canvas.width}x${ratio.canvas.height}, ` +
    `transform=${JSON.stringify(ctxOf(ratio).transform)}`);

  const control = harness();
  control.trail.sync(baseInput());
  const same = control.trail.surface('band-a')!;
  const controlBefore = clears(same);
  control.trail.sync(baseInput({ viewportStart: 1000, samplerate: 100e6 }));
  check('control: re-sending the same display does not clear',
    clears(same) === controlBefore, `clears=${clears(same)}/${controlBefore}`);
}

{
  const { trail } = harness();
  trail.sync(baseInput());
  const a = trail.surface('band-a')!;
  trail.commit('band-a');
  trail.commit('band-a');
  trail.commit('band-a');
  const committed = a.commits;
  const generation = a.generation;
  const before = clears(a);
  trail.sync(baseInput({ viewportStart: 1000, viewportEnd: 9500 }));
  check('a clear drops the retained commits and bumps the generation the frame signature reads',
    committed === 3 && a.commits === 0 && a.generation === generation + 1 &&
    clears(a) === before + 1,
    `commits=${committed}->${a.commits}, generation=${generation}->${a.generation}`);
}

{
  const { trail } = harness();
  trail.sync(baseInput({ frames: 8 }));
  const a = trail.surface('band-a')!;
  const advances: ReturnType<PersistenceTrail['sync']>[] = [];
  for (let wave = 0; wave < 3; wave++) {
    advances.push(trail.sync(baseInput({
      viewportStart: 1000 + wave * 100, viewportEnd: 9000 + wave * 100,
    })));
    trail.commit('band-a');
  }
  const retained = Math.pow(trailDecay(8), 3);
  check('AC1: three Repeat waves under a following viewport accumulate three commits, no generation bump',
    advances.every((result) => !result.reallocated && result.reasons.length === 0) &&
    a.generation === 1 && a.commits === 3 && retained > 0 && retained < 1,
    `generation=${a.generation}, commits=${a.commits}, retained=${retained}`);
  const control = trail.sync(baseInput({ viewportEnd: 12000 }));
  check('control: the same loop with a changing span would drop every commit',
    control.reasons.includes('display-change') && a.generation === 2 && a.commits === 0,
    `reasons=${JSON.stringify(control.reasons)}, generation=${a.generation}, commits=${a.commits}`);
}

{
  const { trail, canvases } = harness();
  trail.sync(baseInput());
  const a = trail.surface('band-a')!;
  const canvas = a.canvas;
  const resized = trail.sync(baseInput({ bands: [bandA({ height: 240 }), bandB()] }));
  check('a band resize reallocates its canvas instead of stretching stale pixels',
    resized.reallocated && canvas.height === 480 && a.canvas === canvas &&
    a.generation === 2 && a.commits === 0 && canvases.length === 2,
    `reallocated=${resized.reallocated}, height=${canvas.height}, ` +
    `generation=${a.generation}, canvases=${canvases.length}`);
  const same = trail.sync(baseInput({ bands: [bandA({ height: 240 }), bandB()] }));
  check('control: a repeated sync at the new geometry does not reallocate again',
    !same.reallocated && a.generation === 2,
    `reallocated=${same.reallocated}, generation=${a.generation}`);
}

{
  const { trail, canvases } = harness();
  trail.sync(baseInput({ frames: 8 }));
  const a = trail.surface('band-a')!;
  trail.commit('band-a');
  const generation = a.generation;
  const before = clears(a);
  const longer = trail.sync(baseInput({ frames: 32 }));
  const view = trail.trailOf('band-a', 32, false);
  check('changing the trail length keeps the retained surface and only changes the decay',
    !longer.reallocated && longer.reasons.length === 0 && a.generation === generation &&
    a.commits === 1 && clears(a) === before && canvases.length === 2 &&
    view !== undefined && Math.abs(view.decay - 0.96875) < 1e-15,
    `reasons=${JSON.stringify(longer.reasons)}, generation=${a.generation}/${generation}, ` +
    `commits=${a.commits}, decay=${view?.decay}`);
}

{
  const { trail } = harness();
  trail.sync(baseInput());
  const removed = trail.sync(baseInput({ bands: [bandA()] }));
  check('dropping a band releases only that surface and states the reason',
    removed.removed.length === 1 && removed.removed[0] === 'band-b' &&
    trail.surface('band-b') === undefined && trail.surface('band-a') !== undefined &&
    removed.reasons.includes('band-removed'),
    `removed=${JSON.stringify(removed.removed)}, reasons=${JSON.stringify(removed.reasons)}`);

  const off = harness();
  off.trail.sync(baseInput());
  const released = off.trail.sync(baseInput({ frames: 0 }));
  check('Off releases every surface and keeps no hidden accumulation',
    off.trail.views().length === 0 && released.removed.length === 2 &&
    released.reasons.length === 0,
    `surfaces=${off.trail.views().length}, removed=${released.removed.length}, ` +
    `reasons=${JSON.stringify(released.reasons)}`);

  const loop = harness();
  loop.trail.sync(baseInput({ frames: 8 }));
  const loopOff = loop.trail.sync(baseInput({ frames: 0 }));
  loop.trail.sync(baseInput({ frames: 0 }));
  check('a Loop-forced Off takes the same release path, so nothing accumulates behind it',
    loopOff.removed.length === 2 && loop.trail.views().length === 0 &&
    loop.canvases.length === 2,
    `removed=${loopOff.removed.length}, canvases=${loop.canvases.length}`);
}

{
  const { trail } = harness();
  const session = trail.sync(baseInput({ event: 'capture-session' }));
  const replacement = trail.sync(baseInput({ event: 'capture-replacement' }));
  const cleared = trail.sync(baseInput({ event: 'clear' }));
  check('a new session, a capture replacement and an explicit Clear each carry their own reason',
    session.reasons.length === 0 &&
    replacement.reasons.includes('capture-replacement') &&
    cleared.reasons.includes('clear'),
    `session=${JSON.stringify(session.reasons)}, ` +
    `replacement=${JSON.stringify(replacement.reasons)}, ` +
    `clear=${JSON.stringify(cleared.reasons)}`);
}

{
  const { trail, canvases } = harness();
  trail.sync(baseInput());
  const a = trail.surface('band-a')!;
  const garbage = baseInput({
    viewportStart: Number.NaN,
    viewportEnd: Number.POSITIVE_INFINITY,
    width: Number.NaN,
    dpr: Number.NaN,
    samplerate: Number.NaN,
    bands: [bandA({
      top: Number.NaN,
      height: Number.NaN,
      sources: [{ ...SOURCE_A, gain: Number.NaN, fullScaleV: Number.NaN, voltsPerDiv: Number.NaN }],
    }), bandB()],
  });
  const first = trail.sync(garbage);
  const generation = a.generation;
  const before = clears(a);
  const second = trail.sync(garbage);
  check('a non-finite display input is sanitised into the key instead of throwing out of the frame',
    first.reasons.every((reason) => reason === 'display-change') &&
    second.reasons.length === 0 && !second.reallocated &&
    clears(a) === before && a.generation === generation && canvases.length === 2,
    `first=${JSON.stringify(first.reasons)}, second=${JSON.stringify(second.reasons)}, ` +
    `generation=${a.generation}/${generation}`);
  const finite = trail.sync(baseInput());
  check('control: the sanitised key is still falsifiable - a finite display change clears',
    finite.reasons.includes('display-change') && a.generation === generation + 1,
    `reasons=${JSON.stringify(finite.reasons)}, generation=${a.generation}`);
}

{
  const { trail } = harness();
  trail.sync(baseInput({ frames: 16 }));
  const a = trail.surface('band-a')!;
  const view = trail.trailOf('band-a', 16, false);
  const commit = trail.trailOf('band-a', 16, true);
  const eight = trail.trailOf('band-a', 8, false);
  check('the trail view carries the exponential decay of its own N, never a frame-ring weight',
    view !== undefined && Math.abs(view.decay - trailDecay(16)) < 1e-15 &&
    Math.abs(view.decay - 0.9375) < 1e-15 && view.commit === false &&
    commit !== undefined && commit.commit === true &&
    eight !== undefined && Math.abs(eight.decay - 0.875) < 1e-15 &&
    view.canvas === a.canvas && view.ctx === a.ctx &&
    Math.abs(view.decay - (1 - 1 / 17)) > 1e-6,
    `decay=${view?.decay}, eight=${eight?.decay}, commit=${commit?.commit}`);
  check('an unknown band has no trail to blit',
    trail.trailOf('band-z', 16, true) === undefined,
    `unknown=${String(trail.trailOf('band-z', 16, true))}`);
}

{
  const { trail, canvases } = harness();
  trail.sync(baseInput());
  const empty = persistenceSignature(8, trail.views());
  trail.commit('band-a');
  const committed = persistenceSignature(8, trail.views());
  trail.sync(baseInput({ viewportEnd: 9500 }));
  const clearedNow = persistenceSignature(8, trail.views());
  const off = persistenceSignature(0, []);
  check('the bus frame signature sees each commit and each clear through the surface views',
    empty !== committed && committed !== clearedNow && clearedNow !== off && off === '0' &&
    JSON.stringify(trail.views().map((view) => view.id)) === '["band-a","band-b"]',
    `empty=${empty}, committed=${committed}, cleared=${clearedNow}, off=${off}`);
  check('a commit never allocates: only the commit counter moves',
    trail.views().length === 2 && canvases.length === 2,
    `surfaces=${trail.views().length}, canvases=${canvases.length}`);
}

{
  const { trail } = harness();
  trail.sync(baseInput());
  trail.releaseAll();
  check('releaseAll drops every canvas for a teardown path',
    trail.views().length === 0 && trail.surface('band-a') === undefined,
    `surfaces=${trail.views().length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
