// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic checks for the pure display swap/frontier model. No DOM, no capture:
 * every case is derived from sampling parameters alone.
 */

import {
  DEFAULT_SWAP_BUFFER_BYTES,
  planLoopSwap,
  relativeSecondsAtSample,
  relativeSpanFromSamples,
  repeatRegions,
  samplesFromSeconds,
  secondsFromSamples,
  spanToPixels,
  waveSpanFromSamples,
  type LoopSwapPlan,
  type RepeatRegions,
} from '../displaySwap.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const plan = (input: Parameters<typeof planLoopSwap>[0]): LoopSwapPlan => planLoopSwap(input);
const spans = (value: RepeatRegions['oldRegions']): string =>
  value.map((s) => `[${s.startSec},${s.endSec})`).join(' ');
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

/* -------------------------------------------------------------------------- */
/* Loop planning                                                               */
/* -------------------------------------------------------------------------- */

{
  const p = plan({
    samplerate: 16e6, channels: 16, targetFps: 60,
    periodSamples: 1000, availableSamples: 1_000_000, windowSamples: 16_000_000,
  });
  check('loop blocks are the largest whole-period multiple under the frame budget',
    p.ready && p.periodKnown && p.limit === 'frame-budget' &&
    p.frameBudgetSamples === 266_666 && p.periods === 266 && p.blockSamples === 266_000 &&
    p.blockSamples % p.periodSamples === 0 && p.periodRemainderSamples === 666 &&
    near(p.estimatedRefreshHz, 60) && !p.fullWindow && !p.overFrameBudget,
    `block=${p.blockSamples}, periods=${p.periods}, remainder=${p.periodRemainderSamples}, ` +
    `budget=${p.frameBudgetSamples}, refresh=${p.estimatedRefreshHz}, limit=${p.limit}`);
}

{
  const p = plan({
    samplerate: 1e6, channels: 8, targetFps: 60,
    periodSamples: 1000, availableSamples: 2500, windowSamples: 100_000,
  });
  check('available data caps the block and leaves a whole-period remainder unswapped',
    p.ready && p.limit === 'available' && p.periods === 2 && p.blockSamples === 2000 &&
    p.periodRemainderSamples === 500 && near(p.estimatedRefreshHz, 60),
    `block=${p.blockSamples}, periods=${p.periods}, remainder=${p.periodRemainderSamples}, ` +
    `limit=${p.limit}, refresh=${p.estimatedRefreshHz}`);
}

{
  const p = plan({
    samplerate: 1e6, channels: 8, periodSamples: 1000,
    availableSamples: 500, windowSamples: 100_000,
  });
  check('less than one period of new data holds the current frame',
    !p.ready && p.blockSamples === 0 && p.periods === 0 && p.limit === 'available' &&
    p.estimatedRefreshHz === 0 && p.blockBytes === 0,
    `ready=${p.ready}, block=${p.blockSamples}, periods=${p.periods}, limit=${p.limit}`);
}

{
  const p = plan({
    samplerate: 100_000, channels: 4, targetFps: 1000,
    periodSamples: 200, availableSamples: 5000, windowSamples: 10_000,
  });
  check('one period is taken even when it exceeds a small frame budget',
    p.ready && p.overFrameBudget && p.limit === 'frame-budget' &&
    p.frameBudgetSamples === 100 && p.periods === 1 && p.blockSamples === 200 &&
    near(p.estimatedRefreshHz, 500),
    `budget=${p.frameBudgetSamples}, block=${p.blockSamples}, refresh=${p.estimatedRefreshHz}, ` +
    `over=${p.overFrameBudget}`);
}

{
  const p = plan({
    samplerate: 1e6, channels: 128, targetFps: 60, periodSamples: 2500,
    availableSamples: 1_000_000, windowSamples: 1_000_000,
    bufferCapBytes: 160_000,
  });
  check('the byte cap bounds a block and the reported bytes stay inside it',
    p.ready && p.limit === 'buffer' && p.bufferCapSamples === 10_000 &&
    p.periods === 4 && p.blockSamples === 10_000 && p.blockBytes === 160_000 &&
    !p.fullWindow,
    `cap=${p.bufferCapSamples}, block=${p.blockSamples}, bytes=${p.blockBytes}, limit=${p.limit}`);
}

{
  const p = plan({
    samplerate: 1e6, channels: 4, targetFps: 60, periodSamples: 100,
    availableSamples: 1_000_000, windowSamples: 1_000_000, bufferCapSamples: 1234,
  });
  check('an explicit sample cap composes with the byte cap',
    p.ready && p.limit === 'buffer' && p.bufferCapSamples === 1234 &&
    p.periods === 12 && p.blockSamples === 1200 && p.periodRemainderSamples === 34,
    `cap=${p.bufferCapSamples}, block=${p.blockSamples}, remainder=${p.periodRemainderSamples}`);
}

{
  const p = plan({
    samplerate: 1e6, channels: 4, targetFps: 60, periodSamples: 1000,
    availableSamples: 1_000_000, windowSamples: 4000,
  });
  check('a visible window smaller than the data caps the block and marks a full repaint',
    p.ready && p.limit === 'window' && p.periods === 4 && p.blockSamples === 4000 &&
    p.fullWindow && p.estimatedRefreshHz === 60,
    `window=${p.windowSamples}, block=${p.blockSamples}, full=${p.fullWindow}, limit=${p.limit}`);
}

{
  const halfPeriod = plan({
    samplerate: 1e6, channels: 4, periodSamples: 5000,
    availableSamples: 1_000_000, windowSamples: 4000,
  });
  check('a period wider than the visible window cannot phase-lock and is not ready',
    !halfPeriod.ready && halfPeriod.blockSamples === 0 && halfPeriod.limit === 'window' &&
    halfPeriod.periodSamples === 5000,
    `ready=${halfPeriod.ready}, block=${halfPeriod.blockSamples}, limit=${halfPeriod.limit}`);
}

{
  const wide = plan({
    samplerate: 2e6, channels: 8, targetFps: 30, periodSamples: 500,
    availableSamples: 1_000_000, windowSamples: 1_000_000,
  });
  const fast = plan({
    samplerate: 1e6, channels: 8, targetFps: 120, periodSamples: 500,
    availableSamples: 1_000_000, windowSamples: 1_000_000,
  });
  const secondsPeriod = plan({
    samplerate: 100e6, channels: 4, targetFps: 60, periodSeconds: 1e-5,
    availableSamples: 10_000_000, windowSamples: 100_000_000,
  });
  check('different rates and frame targets keep whole-period blocks',
    wide.ready && wide.frameBudgetSamples === 66_666 && wide.periods === 133 &&
    wide.blockSamples === 66_500 && near(wide.estimatedRefreshHz, 30) &&
    fast.ready && fast.frameBudgetSamples === 8333 && fast.periods === 16 &&
    fast.blockSamples === 8000 && near(fast.estimatedRefreshHz, 120) &&
    secondsPeriod.ready && secondsPeriod.periodSamples === 1000 &&
    secondsPeriod.periods === 1666 && secondsPeriod.blockSamples === 1_666_000,
    `wide=${wide.blockSamples}@${wide.estimatedRefreshHz}Hz, ` +
    `fast=${fast.blockSamples}@${fast.estimatedRefreshHz}Hz, ` +
    `seconds=${secondsPeriod.blockSamples}/${secondsPeriod.periodSamples}`);
}

{
  const p = plan({
    samplerate: 1e6, channels: 4, targetFps: 10, periodSamples: 1000,
    availableSamples: 1_000_000, windowSamples: 100_000, maxWindowFraction: 0.1,
  });
  const full = plan({
    samplerate: 1e6, channels: 4, targetFps: 10, periodSamples: 1000,
    availableSamples: 1_000_000, windowSamples: 100_000,
  });
  check('a local-window fraction caps the block below a full-window swap',
    p.ready && p.windowCapSamples === 10_000 && p.limit === 'window' &&
    p.blockSamples === 10_000 && !p.fullWindow &&
    full.windowCapSamples === 100_000 && full.blockSamples === 100_000 &&
    full.limit === 'window' && full.fullWindow,
    `local=${p.blockSamples}/${p.windowCapSamples}/${p.limit}, ` +
    `full=${full.blockSamples}/${full.windowCapSamples}/${full.limit}`);
}

{
  const p = plan({
    samplerate: 1e6, channels: 4, targetFps: 60,
    availableSamples: 1000, windowSamples: 10_000,
  });
  check('without a known period the model degenerates to one frame-budget batch',
    p.ready && !p.periodKnown && p.periodSamples === 0 && p.periods === 1 &&
    p.blockSamples === 1000 && p.limit === 'available' && p.periodRemainderSamples === 0,
    `block=${p.blockSamples}, periods=${p.periods}, limit=${p.limit}, known=${p.periodKnown}`);
}

{
  const invalid = plan({
    samplerate: 0, channels: 16, periodSamples: 1000,
    availableSamples: 1000, windowSamples: 1000,
  });
  const badChannels = plan({
    samplerate: 1e6, channels: 3 as number, periodSamples: 100,
    availableSamples: 1000, windowSamples: 1000,
  });
  const noData = plan({
    samplerate: 1e6, channels: 16, periodSamples: 100,
    availableSamples: 0, windowSamples: 1000,
  });
  const noWindow = plan({
    samplerate: 1e6, channels: 16, periodSamples: 100,
    availableSamples: 1000, windowSamples: 0,
  });
  check('invalid configuration and empty data/window produce a safe not-ready plan',
    !invalid.ready && invalid.limit === 'invalid' &&
    !badChannels.ready && badChannels.limit === 'invalid' &&
    !noData.ready && noData.limit === 'available' &&
    !noWindow.ready && noWindow.limit === 'window',
    `invalid=${invalid.limit}, channels=${badChannels.limit}, ` +
    `noData=${noData.limit}, noWindow=${noWindow.limit}`);
}

{
  const counts = [4, 8, 16, 32, 64, 128] as const;
  const failures: string[] = [];
  for (const channels of counts) {
    const capBytes = 1024 * 1024;
    const p = plan({
      // 100 MS/s keeps the frame budget (1,666,666 samples) above every width's byte cap.
      samplerate: 100e6, channels, targetFps: 60, periodSamples: 1000,
      availableSamples: 10_000_000, windowSamples: 10_000_000, bufferCapBytes: capBytes,
    });
    if (!p.ready || p.blockSamples === 0 || p.blockSamples % p.periodSamples !== 0 ||
        p.blockBytes > capBytes || p.limit !== 'buffer' ||
        p.bufferCapSamples !== Math.floor(capBytes / Math.ceil(channels / 8))) {
      failures.push(`${channels}ch: block=${p.blockSamples}, bytes=${p.blockBytes}, ` +
        `limit=${p.limit}, cap=${p.bufferCapSamples}`);
    }
  }
  check('4/8/16/32/64/128-channel byte caps all keep an aligned block inside the buffer',
    failures.length === 0,
    failures.length === 0
      ? `${counts.length} widths, cap=${DEFAULT_SWAP_BUFFER_BYTES} default; all blocks aligned`
      : failures.join('; '));
}

/* -------------------------------------------------------------------------- */
/* Repeat regions                                                              */
/* -------------------------------------------------------------------------- */

{
  const r = repeatRegions({
    viewport: { startSec: -1, endSec: 2 },
    newWave: { startSec: 0, endSec: 0.5 },
  });
  check('a Fixed viewport spanning both waves is filled by new and old, never blank',
    r.new !== null && near(r.new.startSec, 0) && near(r.new.endSec, 0.5) &&
    r.oldRegions.length === 2 &&
    spans(r.oldRegions) === '[-1,0) [0.5,2)' && r.coverageComplete && r.gaps.length === 0 &&
    r.old !== null && near(r.old.startSec, 0.5) && near(r.old.endSec, 2) &&
    r.replacing && near(r.progress, 0.5 / 3) && near(r.frontierSec, 0.5),
    `new=${JSON.stringify(r.new)}, old=${spans(r.oldRegions)}, gaps=${r.gaps.length}, ` +
    `progress=${r.progress}`);
}

{
  const r = repeatRegions({
    viewport: { startSec: -1, endSec: 1 },
    oldWave: { startSec: -1, endSec: 1, triggerSec: 0 },
    newWave: { startSec: -0.25, endSec: -0.05, triggerSec: 0 },
  });
  check('pre-trigger frontier keeps the old T visible and hides the new T',
    r.oldRegions.length === 2 &&
    spans(r.oldRegions) === '[-1,-0.25) [-0.05,1)' &&
    r.coverageComplete && !r.newTriggerVisible &&
    r.oldTriggerVisible && r.newTriggerSec === 0 && r.oldTriggerSec === 0 &&
    near(r.frontierSec, -0.05) && near(r.progress, 0.1),
    `frontier=${r.frontierSec}, old=${spans(r.oldRegions)}, ` +
    `oldT=${r.oldTriggerVisible}, newT=${r.newTriggerVisible}`);
}

{
  const r = repeatRegions({
    viewport: { startSec: -1, endSec: 1 },
    oldWave: { startSec: -1, endSec: 1, triggerSec: 0 },
    newWave: { startSec: 0, endSec: 0.5, triggerSec: 0 },
  });
  check('once new data covers T, the new T is drawn and the old T is not',
    r.newTriggerVisible && !r.oldTriggerVisible &&
    spans(r.oldRegions) === '[-1,0) [0.5,1)' && r.coverageComplete,
    `oldT=${r.oldTriggerVisible}, newT=${r.newTriggerVisible}, old=${spans(r.oldRegions)}`);
}

{
  const r = repeatRegions({
    viewport: { startSec: -1, endSec: 1 },
    oldWave: { startSec: -1, endSec: 1, triggerSec: 0 },
    newWave: { startSec: -0.5, endSec: 0, triggerSec: 0 },
  });
  check('an empty new region at the frontier leaves the old T on the boundary',
    !r.newTriggerVisible && r.oldTriggerVisible &&
    spans(r.oldRegions) === '[-1,-0.5) [0,1)',
    `frontier=${r.frontierSec}, oldT=${r.oldTriggerVisible}, newT=${r.newTriggerVisible}`);
}

{
  const r = repeatRegions({
    viewport: { startSec: -1, endSec: 1 },
    oldWave: { startSec: -1, endSec: 0.2, triggerSec: -0.6 },
    newWave: { startSec: 0, endSec: 0.5, triggerSec: 0 },
  });
  check('both trigger positions are reported and visibility follows their own spans',
    near(r.oldTriggerSec ?? Number.NaN, -0.6) && r.newTriggerSec === 0 &&
    r.oldTriggerVisible && r.newTriggerVisible &&
    spans(r.oldRegions) === '[-1,0)' && !r.coverageComplete &&
    r.gaps.length === 1 && near(r.gaps[0]!.startSec, 0.5) && near(r.gaps[0]!.endSec, 1),
    `oldT=${r.oldTriggerSec}, newT=${r.newTriggerSec}, old=${spans(r.oldRegions)}, ` +
    `gaps=${JSON.stringify(r.gaps)}`);
}

{
  const noOld = repeatRegions({
    viewport: { startSec: -0.5, endSec: 0.5 },
    oldWave: null,
    newWave: { startSec: 0, endSec: 0.2 },
  });
  const complete = repeatRegions({
    viewport: { startSec: -0.5, endSec: 0.5 },
    oldWave: null,
    newWave: { startSec: -0.5, endSec: 0.5 },
  });
  check('an explicit null old wave reports gaps instead of inventing old data',
    noOld.oldRegions.length === 0 && !noOld.coverageComplete &&
    JSON.stringify(noOld.gaps.map((s) => [s.startSec, s.endSec])) ===
      JSON.stringify([[-0.5, 0], [0.2, 0.5]]) &&
    complete.coverageComplete && complete.gaps.length === 0 && complete.progress === 1,
    `noOld=${JSON.stringify(noOld.gaps)}, fullNew=${complete.coverageComplete}`);
}

{
  const sweep = repeatRegions({
    viewport: { startSec: -0.5, endSec: 0.5 },
    oldWave: { startSec: -0.5, endSec: 0.5, triggerSec: null },
    newWave: { startSec: -0.2, endSec: 0.1, triggerSec: null },
  });
  check('sweep-start waves report no trigger positions',
    sweep.oldTriggerSec === null && sweep.newTriggerSec === null &&
    !sweep.oldTriggerVisible && !sweep.newTriggerVisible,
    `oldT=${sweep.oldTriggerSec}, newT=${sweep.newTriggerSec}`);
}

{
  const fromOld = repeatRegions({
    oldWave: { startSec: -0.5, endSec: 0.5 },
    newWave: { startSec: 0, endSec: 0.2 },
  });
  const fromNew = repeatRegions({
    newWave: { startSec: 0, endSec: 0.2 },
  });
  check('the default display span prefers the completed old wave, then the new wave',
    near(fromOld.viewport.startSec, -0.5) && near(fromOld.viewport.endSec, 0.5) &&
    spans(fromOld.oldRegions) === '[-0.5,0) [0.2,0.5)' &&
    near(fromNew.viewport.startSec, 0) && near(fromNew.viewport.endSec, 0.2) &&
    fromNew.oldRegions.length === 0,
    `old=${spans(fromOld.oldRegions)}, newViewport=[${fromNew.viewport.startSec},${fromNew.viewport.endSec})`);
}

{
  const r = repeatRegions({
    viewport: { startSec: 2, endSec: 1 },
    newWave: { startSec: 0, endSec: 0.5 },
  });
  check('an invalid viewport yields a safe empty region set',
    r.new === null && r.old === null && r.oldRegions.length === 0 && !r.replacing &&
    r.progress === 0 && r.coverageComplete,
    `new=${JSON.stringify(r.new)}, old=${JSON.stringify(r.old)}, progress=${r.progress}`);
}

/* -------------------------------------------------------------------------- */
/* Seconds / samples / pixels                                                  */
/* -------------------------------------------------------------------------- */

{
  const rate = 16e6;
  const pre = relativeSecondsAtSample(0, 1600, rate);
  const atOrigin = relativeSecondsAtSample(1600, 1600, rate);
  const span = relativeSpanFromSamples(0, 1600, 1600, rate);
  const wave = waveSpanFromSamples({
    samplerate: rate, originSample: 1600, startSample: 0, endSample: 1600,
    triggerSample: 1600,
  });
  const noTrigger = waveSpanFromSamples({
    samplerate: rate, originSample: 1600, startSample: 0, endSample: 1600,
    triggerSample: null,
  });
  check('pre-trigger sample ranges map to negative relative seconds with T at 0',
    pre !== null && near(pre, -1e-4) && atOrigin === 0 &&
    span !== null && near(span.startSec, -1e-4) && span.endSec === 0 &&
    wave !== null && near(wave.startSec, -1e-4) && wave.endSec === 0 &&
    wave.triggerSec === 0 && noTrigger !== null && noTrigger.triggerSec === null &&
    samplesFromSeconds(-1e-4, rate) === -1600 && secondsFromSamples(-1600, rate) === -1e-4,
    `pre=${pre}, span=${JSON.stringify(span)}, wave=${JSON.stringify(wave)}, ` +
    `roundTrip=${samplesFromSeconds(-1e-4, rate)}`);
}

{
  const invalid = [
    secondsFromSamples(1, 0), samplesFromSeconds(1, Number.NaN),
    relativeSecondsAtSample(0, 0, -1), relativeSpanFromSamples(0, 0, 0, 1e6),
    waveSpanFromSamples({ samplerate: -1, startSample: 0, endSample: 1, originSample: 0 }),
  ];
  check('invalid rates and empty spans return null rather than NaN geometry',
    invalid.every((value) => value === null), `${invalid.length} invalid cases`);
}

{
  const viewport = { startSec: -1, endSec: 1 };
  const middle = spanToPixels({ startSec: 0, endSec: 0.5 }, viewport, 800);
  const left = spanToPixels({ startSec: -2, endSec: -1.5 }, viewport, 800);
  const right = spanToPixels({ startSec: 1.5, endSec: 2 }, viewport, 800);
  const cross = spanToPixels({ startSec: -2, endSec: 0 }, viewport, 800);
  check('regions map to pixels and clip to the plot on both sides',
    middle !== null && middle.x0 === 400 && middle.x1 === 600 &&
    middle.clippedX0 === 400 && middle.clippedX1 === 600 && middle.visible &&
    left !== null && left.x0 === -400 && left.x1 === -200 &&
    left.clippedX0 === 0 && left.clippedX1 === 0 && !left.visible &&
    right !== null && right.clippedX0 === 800 && right.clippedX1 === 800 && !right.visible &&
    cross !== null && cross.clippedX0 === 0 && cross.clippedX1 === 400 && cross.visible,
    `middle=${JSON.stringify(middle)}, left=${JSON.stringify(left)}, ` +
    `right=${JSON.stringify(right)}, cross=${JSON.stringify(cross)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
