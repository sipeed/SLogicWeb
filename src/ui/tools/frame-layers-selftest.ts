// SPDX-License-Identifier: GPL-3.0-or-later

import {
  fingerprintOf, planLayers, type FrameFingerprint, type FrameLayerPlan,
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
  dataLen: 5000, dropped: 0, frontier: 5000, triggerSample: null,
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
    ['the ticks changed', changed({ tickSig: 23 }), [false, true, false, false]],
    ['the live edge moved', changed({ frontier: 5001 }), [false, false, true, true]],
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
  const equal = fingerprintOf(['a', 1, true, null]) === fingerprintOf(['a', 1, true, null]);
  const changed = fingerprintOf(['a', 1]) !== fingerprintOf(['a', 2]);
  const separated = fingerprintOf(['a', 'b']) !== fingerprintOf(['ab']);
  const unsigned = fingerprintOf([1.5, 'x']) >= 0 && Number.isInteger(fingerprintOf([1.5, 'x']));
  check('the rolling hash is stable, order-aware and separator-aware',
    equal && changed && separated && unsigned,
    `equal=${equal}, changed=${changed}, separated=${separated}, unsigned=${unsigned}`);
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

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
