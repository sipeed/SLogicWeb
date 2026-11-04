// SPDX-License-Identifier: GPL-3.0-or-later

import { LIVE_REFRESH_MS, liveDrawDue } from '../liveRefresh.js';

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
  const cases: [number, number, boolean, boolean, boolean][] = [
    // now, lastDrawnAt, pending, running, due
    [0, 0, true, true, false],
    [49, 0, true, true, false],
    [50, 0, true, true, true],
    [51, 0, true, true, true],
    [1000, 950, true, true, true],
    [1000, 951, true, true, false],
    [1000, 900, true, false, false],
    [1000, 900, false, true, false],
    [1000, 900, false, false, false],
  ];
  const bad = cases.filter(([now, last, pending, running, want]) =>
    liveDrawDue(now, last, pending, running) !== want);
  check('liveDrawDue is due only while running, with data, 50 ms after the last draw',
    LIVE_REFRESH_MS === 50 && bad.length === 0,
    bad.length === 0
      ? `${cases.length} cases match (interval ${LIVE_REFRESH_MS} ms)`
      : bad.map(([now, last, pending, running, want]) =>
        `${now}/${last}/${pending}/${running} want ${want}`).join('; '));
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
  const gated = frame.includes('liveDrawDue(now, this.liveDrawAt, this.livePending, this.running)') &&
    frame.includes('this.dirty = false;') && frame.includes('this.livePending = false;') &&
    frame.includes('this.liveDrawAt = now;') && frame.includes('this.draw();');
  // The old high-rate branch returned before drawing: a fast loop showed no live view.
  const liveAtAnyRate = frame.length > 0 && !frame.includes('if (highRateLoop) return;') &&
    frame.includes('this.pumpBusBuilders();');
  check('the frame loop draws interactions at once and new samples on the 50 ms clock',
    gated && liveAtAnyRate,
    `gated=${gated}, live=${liveAtAnyRate}, bytes=${frame.length}`);

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
