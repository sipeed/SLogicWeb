// SPDX-License-Identifier: GPL-3.0-or-later

import {
  NO_INVALIDATION, fingerprintOf, planLayers, storeSignature,
  type FrameFingerprint, type FrameLayerPlan, type LayerInvalidation,
} from '../frameLayers.js';

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

const base: FrameFingerprint = {
  viewStart: 1000, viewEnd: 2000, widthPx: 1024, heightPx: 600,
  dataLen: 5000, dropped: 0, frontier: 5000, storeSig: 1, triggerSample: null,
  rowSig: 11, themeSig: 'dark', tickSig: 22, busSig: 33, tintSig: 44,
};

{
  const equal = planLayers(base, { ...base }, false);
  const changed = (patch: Partial<FrameFingerprint>): FrameLayerPlan =>
    planLayers(base, { ...base, ...patch }, false);
  const cases: [string, FrameLayerPlan, [boolean, boolean, boolean, boolean]][] = [
    ['equal inputs', equal, [false, false, false, false]],
    ['a new sample', changed({ dataLen: 5001 }), [true, false, true, true]],
    ['a front drop', changed({ dropped: 64 }), [true, false, true, true]],
    ['the viewport moved', changed({ viewStart: 1001, viewEnd: 2001 }), [true, false, true, true]],
    ['the plot was resized', changed({ widthPx: 1025 }), [true, true, true, true]],
    ['the row list changed', changed({ rowSig: 12 }), [true, false, true, true]],
    ['the theme changed', changed({ themeSig: 'light' }), [true, false, true, true]],
    ['the ticks changed', changed({ tickSig: 23 }), [false, true, true, true]],
    ['the displayed store was swapped', changed({ storeSig: 2 }), [true, false, true, true]],
    ['the current wave advanced (repeat composite)', changed({ frontier: 5001 }), [true, false, true, true]],
    ['the trigger moved', changed({ triggerSample: 1500 }), [false, false, true, true]],
    ['the repeat tint changed', changed({ tintSig: 45 }), [false, false, true, true]],
    ['a bus input changed', changed({ busSig: 34 }), [false, false, false, true]],
  ];
  const bad = cases.filter(([, plan, want]) =>
    plan.wave !== want[0] || plan.axis !== want[1] ||
    plan.overlay !== want[2] || plan.bus !== want[3]);
  check('each layer is redrawn only when its own inputs changed',
    bad.length === 0,
    bad.length === 0
      ? `${cases.length} cases match`
      : bad.map(([name, plan]) => `${name}->${JSON.stringify(plan)}`).join('; '));

  const forced = planLayers(base, { ...base }, true);
  const first = planLayers(null, { ...base }, false);
  const all = (plan: FrameLayerPlan): boolean =>
    plan.wave && plan.axis && plan.overlay && plan.bus;
  check('force bypasses every skip and an unknown previous frame draws everything',
    all(forced) && all(first), `forced=${JSON.stringify(forced)}, first=${JSON.stringify(first)}`);
}

{
  const invalidate = (patch: Partial<LayerInvalidation>): LayerInvalidation =>
    ({ ...NO_INVALIDATION, ...patch });
  const quiet = planLayers(base, { ...base }, false);
  const cases: [string, FrameLayerPlan, [boolean, boolean, boolean, boolean]][] = [
    ['no invalidation', quiet, [false, false, false, false]],
    ['the default argument', planLayers(base, { ...base }, false, NO_INVALIDATION),
      [false, false, false, false]],
    ['a wave buffer reallocation', planLayers(base, { ...base }, false, invalidate({ wave: true })),
      [true, false, false, false]],
    ['an axis buffer reallocation', planLayers(base, { ...base }, false, invalidate({ axis: true })),
      [false, true, false, false]],
    ['an annotation buffer reallocation',
      planLayers(base, { ...base }, false, invalidate({ overlay: true })),
      [false, false, true, true]],
    ['a bus-only reallocation', planLayers(base, { ...base }, false, invalidate({ bus: true })),
      [false, false, false, true]],
    ['every buffer reallocated',
      planLayers(base, { ...base }, false,
        invalidate({ wave: true, axis: true, overlay: true, bus: true })),
      [true, true, true, true]],
  ];
  const bad = cases.filter(([, plan, want]) =>
    plan.wave !== want[0] || plan.axis !== want[1] ||
    plan.overlay !== want[2] || plan.bus !== want[3]);
  check('a canvas invalidation forces exactly the layers that paint on it',
    bad.length === 0,
    bad.length === 0
      ? `${cases.length} cases match`
      : bad.map(([name, plan]) => `${name}->${JSON.stringify(plan)}`).join('; '));

  const forcedWithInvalidation = planLayers(base, { ...base }, true, invalidate({ wave: true }));
  const firstWithInvalidation = planLayers(null, { ...base }, false, invalidate({ axis: true }));
  const unchanged = planLayers(base, { ...base, busSig: 34 }, false, invalidate({ wave: true }));
  check('an invalidation cannot mask a changed input, a force or an unknown frame',
    forcedWithInvalidation.wave && forcedWithInvalidation.axis &&
      firstWithInvalidation.axis && firstWithInvalidation.overlay &&
      unchanged.wave && unchanged.bus && !unchanged.axis,
    `forced=${JSON.stringify(forcedWithInvalidation)}, ` +
      `first=${JSON.stringify(firstWithInvalidation)}, changed=${JSON.stringify(unchanged)}`);
}

{
  const equal = fingerprintOf(['a', 1, true, null]) === fingerprintOf(['a', 1, true, null]);
  const changed = fingerprintOf(['a', 1]) !== fingerprintOf(['a', 2]);
  const separated = fingerprintOf(['a', 'b']) !== fingerprintOf(['ab']);
  const unsigned = fingerprintOf([1.5, 'x']) >= 0 && Number.isInteger(fingerprintOf([1.5, 'x']));
  const a = {};
  const b = {};
  const stable = storeSignature(a) === storeSignature(a) && storeSignature(a) !== storeSignature(b);
  check('the rolling hash is stable, order-aware and separator-aware',
    equal && changed && separated && unsigned && stable,
    `equal=${equal}, changed=${changed}, separated=${separated}, unsigned=${unsigned}, store=${stable}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = app.indexOf('private draw(force = true): void {');
  const end = start >= 0 ? app.indexOf('private frameFingerprint(', start) : -1;
  const draw = end > start ? app.slice(start, end) : '';
  const consulted = draw.includes('const wavePlan = planLayers(') &&
    draw.includes('const plan = planLayers(') &&
    draw.includes('this.layerFingerprint = fingerprint;');
  const counted = [
    'this.layerDraws.wave += 1;', 'this.layerSkips.wave += 1;',
    'this.layerDraws.axis += 1;', 'this.layerSkips.axis += 1;',
    'this.layerDraws.overlay += 1;', 'this.layerSkips.overlay += 1;',
    'this.layerDraws.bus += 1;', 'this.layerSkips.bus += 1;',
  ].every((needle) => draw.includes(needle));
  const overlayClearsOnce = (draw.match(/this\.overlay\.beginFrame\(\)/g) ?? []).length === 1 &&
    draw.includes('if (plan.overlay) {\n      this.overlay.beginFrame();');
  check('draw() plans every layer, counts each decision, and clears the overlay once',
    consulted && counted && overlayClearsOnce,
    `consulted=${consulted}, counted=${counted}, beginFrame=${overlayClearsOnce}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = app.indexOf('private draw(force = true): void {');
  const end = start >= 0 ? app.indexOf('private frameFingerprint(', start) : -1;
  const draw = end > start ? app.slice(start, end) : '';
  const calls: string[] = [];
  let at = draw.indexOf('planLayers(');
  while (at >= 0) {
    const stop = draw.indexOf(';', at);
    calls.push(stop > at ? draw.slice(at, stop) : draw.slice(at));
    at = draw.indexOf('planLayers(', stop > at ? stop : at + 1);
  }
  const planned = calls.length === 2 && calls.every((call) => call.includes('invalidated'));
  const consumed = draw.includes('this.stack.consumeInvalidation()') &&
    draw.includes('this.overlay.consumeInvalidation()');
  check('both layer plans take the frame invalidation set, which the frame consumes',
    planned && consumed,
    `calls=${calls.length}, planned=${planned}, consumed=${consumed}`);

  const overlaySrc = fs.readFileSync('src/ui/overlay.ts', 'utf8');
  const syncStart = overlaySrc.indexOf('syncSize(wCss: number, hCss: number): void {');
  const syncEnd = syncStart >= 0 ? overlaySrc.indexOf('beginFrame()', syncStart) : -1;
  const syncBody = syncEnd > syncStart ? overlaySrc.slice(syncStart, syncEnd) : '';
  const deviceRounded = syncBody.includes('const w = Math.max(1, Math.round(wCss * dpr));') &&
    syncBody.includes('const h = Math.max(1, Math.round(hCss * dpr));') &&
    syncBody.includes('if (w === this.widthDevice && h === this.heightDevice && dpr === this.dpr') &&
    syncBody.includes('const reallocated = w !== this.widthDevice || h !== this.heightDevice;') &&
    syncBody.indexOf('const reallocated') < syncBody.indexOf('this.widthDevice = w;') &&
    syncBody.includes('this.gridCleared = true;') && syncBody.includes('this.topCleared = true;');
  const reports = overlaySrc.includes(
    'consumeInvalidation(): { overlay: boolean; bus: boolean }') &&
    overlaySrc.includes('return { overlay: grid || top, bus: top };');
  check('the overlay reallocates on device size and reports the buffers it cleared',
    deviceRounded && reports, `rounded=${deviceRounded}, reports=${reports}`);

  const stackSrc = fs.readFileSync('src/ui/waveformStack.ts', 'utf8');
  const stackConsumes = stackSrc.includes('syncSize(): { rescaled: boolean }') &&
    stackSrc.includes('consumeInvalidation(): boolean') &&
    stackSrc.includes('if (r.syncCanvasSize()) this.reallocated = true;') &&
    stackSrc.includes('r.setDevicePixelRatio(dpr);\n        this.reallocated = true;');
  check('the stack reports a drawing-buffer reallocation beside the viewport rescale',
    stackConsumes, `consumes=${stackConsumes}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
