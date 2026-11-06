// SPDX-License-Identifier: GPL-3.0-or-later

import {
  LIVE_FRAME_CEIL_MS, LIVE_FRAME_FLOOR_MS, liveDrawDue, liveFrameIntervalMs,
  liveWindowHasNewData, type LiveWindow,
} from '../liveRefresh.js';

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

{
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  const cases: [number, number][] = [
    [0, LIVE_FRAME_FLOOR_MS],
    [2, LIVE_FRAME_FLOOR_MS],
    [10, 12.5],
    [20, 25],
    [40, LIVE_FRAME_CEIL_MS],
    [200, LIVE_FRAME_CEIL_MS],
    [-5, LIVE_FRAME_FLOOR_MS],
    [Number.NaN, LIVE_FRAME_FLOOR_MS],
  ];
  const bad = cases.filter(([cost, want]) => !near(liveFrameIntervalMs(cost), want));
  check('the next live draw waits 1.25x the last frame cost, clamped to 8.33..33.33 ms',
    near(LIVE_FRAME_FLOOR_MS, 1000 / 120) && near(LIVE_FRAME_CEIL_MS, 1000 / 30) &&
    LIVE_FRAME_FLOOR_MS < LIVE_FRAME_CEIL_MS && bad.length === 0,
    bad.length === 0
      ? `${cases.length} costs match`
      : bad.map(([cost, want]) => `${cost}->${liveFrameIntervalMs(cost)} want ${want}`).join('; '));
}

{
  const cases: [number, number, number, boolean, boolean, boolean][] = [
    // now, lastDrawnAt, lastCostMs, pending, running, due
    [0, 0, 0, true, true, false],
    [8, 0, 2, true, true, false],
    [10000, 0, 2, true, true, true],
    [8.33, 0, 2, true, true, false],
    [8.34, 0, 2, true, true, true],
    [12.4, 0, 10, true, true, false],
    [12.5, 0, 10, true, true, true],
    [30, 0, 40, true, true, false],
    [33.33, 0, 40, true, true, false],
    [33.34, 0, 40, true, true, true],
    [1000, 900, 2, true, true, true],
    [1000, 900, 2, true, false, false],
    [1000, 900, 2, false, true, false],
    [1000, 900, 2, false, false, false],
  ];
  const bad = cases.filter(([now, last, cost, pending, running, want]) =>
    liveDrawDue(now, last, cost, pending, running) !== want);
  check('liveDrawDue is due only while running, with data, once the paced interval elapsed',
    bad.length === 0,
    bad.length === 0
      ? `${cases.length} cases match`
      : bad.map(([now, last, cost, pending, running, want]) =>
        `${now}/${last}/${cost}/${pending}/${running} want ${want}`).join('; '));
}

{
  const drawn = (viewStart: number, viewEnd: number, dataLen: number, dropped = 0): LiveWindow =>
    ({ viewStart, viewEnd, dataLen, dropped });
  const cases: [string, boolean, number, number, number, number, LiveWindow, boolean][] = [
    // name, follow, viewStart, viewEnd, dataLen, dropped, drawn, relevant
    ['following always sees new data', true, 100, 200, 500, 0, drawn(100, 200, 400), true],
    ['fixed window, data grows inside it', false, 100, 200, 150, 0, drawn(100, 200, 140), true],
    ['fixed window, data grows past it', false, 100, 200, 500, 0, drawn(100, 200, 500), false],
    ['fixed window, data lands exactly on the right edge', false, 100, 200, 200, 0, drawn(100, 200, 199), true],
    ['fixed window, data was already past it', false, 100, 200, 500, 0, drawn(100, 200, 600), false],
    ['fixed window before the first sample', false, 0, 100, 500, 0, drawn(0, 100, 0), true],
    ['front drop shifts the window under a fixed view', false, 100, 200, 500, 64, drawn(100, 200, 500), true],
    ['front drop with the view translated by the same amount', false, 36, 136, 500, 64, drawn(100, 200, 500), false],
    ['a pan without new data', false, 300, 400, 500, 0, drawn(100, 200, 500), true],
    ['viewport zoom without new data', false, 100, 400, 500, 0, drawn(100, 200, 500), true],
  ];
  const bad = cases.filter(([, follow, start, end, len, dropped, prev, want]) =>
    liveWindowHasNewData(follow, start, end, len, dropped, prev) !== want);
  check('a live frame is relevant only when a new sample can reach the visible window',
    bad.length === 0,
    bad.length === 0
      ? `${cases.length} cases match`
      : bad.map(c => c[0]).join('; '));
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');

  const frameStart = app.indexOf('private frame = (): void => {');
  const frameEnd = frameStart >= 0 ? app.indexOf('\n  };', frameStart) : -1;
  const frame = frameEnd > frameStart ? app.slice(frameStart, frameEnd) : '';
  const call = frame.indexOf('liveDrawDue(');
  const callArgs = call >= 0 ? frame.slice(call, frame.indexOf(');', call)) : '';
  const gated = ['now', 'this.liveDrawAt', 'this.lastFrameCostMs', 'this.livePending', 'this.running']
    .every((arg, i, all) => {
      const at = callArgs.indexOf(arg);
      const previous = i === 0 ? -1 : callArgs.indexOf(all[i - 1]!);
      return at > previous;
    }) &&
    frame.includes('this.dirty = false;') && frame.includes('this.livePending = false;') &&
    frame.includes('this.liveDrawAt = now;') && /this\.draw\([^)]*\);/.test(frame);
  // The old high-rate branch returned before drawing: a fast loop showed no live view.
  const liveAtAnyRate = frame.length > 0 && !frame.includes('if (highRateLoop) return;') &&
    frame.includes('this.pumpBusBuilders();');
  check('the frame loop draws interactions at once and new samples on the paced clock',
    gated && liveAtAnyRate,
    `gated=${gated}, live=${liveAtAnyRate}, bytes=${frame.length}`);

  const policy = fs.readFileSync('src/ui/liveRefresh.ts', 'utf8');
  const ceilingGone = !app.includes('LIVE_REFRESH_MS') && !policy.includes('LIVE_REFRESH_MS') &&
    !frame.includes('LIVE_REFRESH_MS') && !/\b50\b/.test(policy);
  check('the 50 ms policy ceiling is gone from the gate and its caller',
    ceilingGone, `app=${!app.includes('LIVE_REFRESH_MS')}, policy=${!policy.includes('LIVE_REFRESH_MS')}, literal50=${!/\b50\b/.test(policy)}`);

  const sinkStart = app.indexOf('await device.start(cfg, (chunk) => {');
  const sinkEnd = sinkStart >= 0 ? app.indexOf('}, (pos, missing) => {', sinkStart) : -1;
  const sink = sinkEnd > sinkStart ? app.slice(sinkStart, sinkEnd) : '';
  const appended = (sink.match(/this\.livePending = true;/g) ?? []).length >= 2 &&
    !sink.includes('this.dirty = true;');
  const drop = app.slice(sinkEnd, sinkEnd + 3_000);
  const dropout = drop.includes('this.livePending = true;') &&
    drop.includes('this.analogScanner?.resetContinuity();') &&
    drop.includes('if (isLoop)');
  check('data arrival marks a pending live frame instead of forcing a dirty draw',
    sink.length > 0 && appended && drop.length > 0 && dropout,
    `sink=${sink.length}, appended=${appended}, dropout=${dropout}`);

  const pumpStart = app.indexOf('private pumpBusBuilders(): void {');
  const pumpEnd = pumpStart >= 0 ? app.indexOf('\n  }', pumpStart) : -1;
  const pump = pumpEnd > pumpStart ? app.slice(pumpStart, pumpEnd) : '';
  const background = pump.includes('if (this.running) this.livePending = true;') &&
    pump.includes('else this.dirty = true;');
  check('bus building feeds the same live clock while running and draws freely after',
    background, `pump=${pump.length}, background=${background}`);

  const duration = panel.includes("label: t('capturePanel.duration'),") &&
    !panel.includes('capturePanel.loopRetention') &&
    panel.includes("key: 'capture.loopWindow'");
  check('the loop window control is labelled Duration like the other modes',
    duration, `duration=${duration}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
