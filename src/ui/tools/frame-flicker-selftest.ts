// SPDX-License-Identifier: GPL-3.0-or-later

import {
  BLANK_COLLAPSE_RATIO, BLANK_PAINTED_MIN_MEAN, CAPTURE_START_SETTLE_FRAMES, OUTLIER_RATIO,
  analyzeCaptureStart, blankCanvasFrames, brightnessOutliers,
  type CanvasSample, type FlickerFrame,
} from '../frameFlicker.js';

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

function sample(mean: number, alpha = 1, hash = `${mean}`): CanvasSample {
  return { mean, alpha, hash };
}

function framesOf(
  count: number, canvases: (index: number) => Record<string, CanvasSample>,
): FlickerFrame[] {
  const frames: FlickerFrame[] = [];
  for (let i = 0; i < count; i++) frames.push({ canvases: canvases(i) });
  return frames;
}

function waveSeries(count: number, wobble = 3): FlickerFrame[] {
  return framesOf(count, (i) => {
    const sway = i % 2 === 0 ? wobble : -wobble;
    return {
      'wave[0]': sample(160 + sway),
      'wave[1]': sample(156 - sway),
      'grid[0]': sample(0.4, 0.06),
    };
  });
}

{
  const pinned = BLANK_PAINTED_MIN_MEAN === 8 && BLANK_COLLAPSE_RATIO === 0.25 &&
    OUTLIER_RATIO === 1.12 && CAPTURE_START_SETTLE_FRAMES === 12;
  check('the published thresholds are the pinned ones', pinned,
    `painted>${BLANK_PAINTED_MIN_MEAN}, collapse<=${BLANK_COLLAPSE_RATIO} of the median, ` +
    `outlier>${OUTLIER_RATIO} of the median, settle=${CAPTURE_START_SETTLE_FRAMES}`);
}

{
  const report = blankCanvasFrames(waveSeries(60));
  check('a steady capture with two painted canvases reports no blank frame',
    report.hits.length === 0 && report.painted.join(',') === 'wave[0],wave[1]',
    `hits=${report.hits.length}, painted=[${report.painted.join(',')}]`);
}

{
  const frames = waveSeries(60);
  frames[30] = {
    canvases: { 'wave[0]': sample(159), 'wave[1]': sample(0.6), 'grid[0]': sample(0.4, 0.06) },
  };
  const report = blankCanvasFrames(frames);
  const hit = report.hits[0];
  const exact = report.hits.length === 1 && hit !== undefined && hit.frame === 30 &&
    hit.canvas === 'wave[1]' && hit.from === 156 && hit.to === 0.6;
  check('a canvas that is painted and then cleared is a blank frame',
    exact, `hits=${JSON.stringify(report.hits)}`);

  const stale = waveSeries(60);
  for (let index = 30; index < 40; index++) {
    stale[index] = {
      canvases: {
        'wave[0]': { ...sample(0), stale: true },
        'wave[1]': sample(156),
        'grid[0]': { ...sample(0, 0.06), stale: true },
      },
    };
  }
  const staleReport = blankCanvasFrames(stale);
  check('a sample the owning layer did not redraw cannot be called a blank frame',
    staleReport.hits.length === 0 && staleReport.painted.join(',') === 'wave[0],wave[1]',
    `hits=${JSON.stringify(staleReport.hits)}, painted=[${staleReport.painted.join(',')}]`);

  const staleThenCleared = waveSeries(60);
  staleThenCleared[30] = {
    canvases: {
      'wave[0]': { ...sample(0), stale: true },
      'wave[1]': sample(1),
      'grid[0]': sample(0.4, 0.06),
    },
  };
  const staleThenClearedReport = blankCanvasFrames(staleThenCleared);
  check('a redrawn canvas that collapses in the same frame is still a blank frame',
    staleThenClearedReport.hits.length === 1 &&
      staleThenClearedReport.hits[0]!.canvas === 'wave[1]' &&
      staleThenClearedReport.hits[0]!.frame === 30,
    `hits=${JSON.stringify(staleThenClearedReport.hits)}`);
}

{
  const frames = waveSeries(40);
  frames[10] = { canvases: { 'wave[0]': sample(0), 'wave[1]': sample(0), 'grid[0]': sample(0, 0) } };
  frames[11] = { canvases: { 'wave[0]': sample(0), 'wave[1]': sample(0), 'grid[0]': sample(0, 0) } };
  const report = blankCanvasFrames(frames);
  const cleared = report.hits.filter((h) => h.frame === 10 || h.frame === 11).length;
  const elsewhere = report.hits.filter((h) => h.frame !== 10 && h.frame !== 11).length;
  check('two cleared frames in the middle of a paint series are both blank hits',
    cleared === 4 && elsewhere === 0,
    `hits=${JSON.stringify(report.hits.map((h) => `${h.frame}:${h.canvas}`))}`);

  const opening = framesOf(40, (i) => ({
    'wave[0]': sample(i < 5 ? 0 : 160),
  }));
  const openingReport = blankCanvasFrames(opening);
  check('an all-zero opening is not a blank frame; the series starts at the first paint',
    openingReport.hits.length === 0 && openingReport.painted.join(',') === 'wave[0]',
    `hits=${JSON.stringify(openingReport.hits)}, painted=[${openingReport.painted.join(',')}]`);

  const never = blankCanvasFrames(framesOf(30, () => ({
    'wave[0]': sample(0), 'grid[0]': sample(0.4, 0.06),
  })));
  check('a canvas whose median never reaches the painted threshold is not watched',
    never.hits.length === 0 && never.painted.length === 0,
    `hits=${never.hits.length}, painted=[${never.painted.join(',')}]`);
}

{
  const steady = Array.from({ length: 40 }, () => 100);
  const flat = brightnessOutliers(steady);
  const wobble = brightnessOutliers(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 105 : 95)));
  check('a flat plot and a 5% wobble are not brightness outliers',
    flat.outliers.length === 0 && flat.median === 100 &&
    wobble.outliers.length === 0 && wobble.median === 100,
    `flat=${flat.outliers.length}/${flat.median}, wobble=${wobble.outliers.length}/${wobble.median}`);

  const tight = brightnessOutliers(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 105 : 95)),
    { ratio: 1.02 });
  check('the same wobble is flagged once the ratio is tightened, so the comparison is live',
    tight.outliers.length === 20, `flagged=${tight.outliers.length} with ratio 1.02`);

  const edge = brightnessOutliers([100, 100, 112, 112.5, 100]);
  check('the outlier boundary is exactly the median ratio',
    edge.outliers.length === 1 && edge.outliers[0]!.frame === 3 && edge.outliers[0]!.mean === 112.5,
    `outliers=${JSON.stringify(edge.outliers)}`);
}

{
  const settled = Array.from({ length: 60 }, () => 100);
  const flash = [...settled];
  for (let i = 20; i < 24; i++) flash[i] = 131;
  const start = analyzeCaptureStart(flash, 20);
  const startFrames = start.outliers.map((o) => o.frame).join(',');
  check('four bright frames right after a capture start are a start flash',
    start.settledMean === 100 && startFrames === '20,21,22,23',
    `settled=${start.settledMean}, frames=[${startFrames}]`);

  const later = analyzeCaptureStart(flash, 30);
  check('frames before the start frame are not counted against the capture start',
    later.outliers.length === 0 && later.settledMean === 100,
    `outliers=${later.outliers.length}, settled=${later.settledMean}`);

  const noisy = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 105 : 95));
  const noFlash = analyzeCaptureStart(noisy, 20);
  check('a steady capture start reports no flash',
    noFlash.outliers.length === 0 && noFlash.settledMean === 100,
    `outliers=${noFlash.outliers.length}, settled=${noFlash.settledMean}`);

  const empty = analyzeCaptureStart([], 0);
  check('an empty series cannot be judged and reports nothing',
    empty.outliers.length === 0 && empty.settledMean === 0,
    `outliers=${empty.outliers.length}, settled=${empty.settledMean}`);

  const leadingFlash = [
    ...Array.from({ length: CAPTURE_START_SETTLE_FRAMES }, () => 131),
    ...Array.from({ length: 48 }, () => 100),
  ];
  const fromHead = analyzeCaptureStart(leadingFlash, 0);
  check('the settled reference is the far end of the series, so a leading flash is still measured',
    fromHead.settledMean === 100 && fromHead.outliers.length === CAPTURE_START_SETTLE_FRAMES,
    `settled=${fromHead.settledMean}, outliers=${fromHead.outliers.length}`);

  const late = [...settled];
  for (let i = 20; i < 24; i++) late[i] = 131;
  late[40] = 140;
  const bounded = analyzeCaptureStart(late, 20, { windowFrames: 6 });
  const unbounded = analyzeCaptureStart(late, 20);
  check('a bounded start window counts only its own frames, an unbounded scan keeps the late one',
    bounded.outliers.map((o) => o.frame).join(',') === '20,21,22,23' &&
    bounded.settledMean === 100 && unbounded.outliers.length === 5 &&
    unbounded.outliers[4]!.frame === 40,
    `bounded=[${bounded.outliers.map((o) => o.frame).join(',')}] at ${bounded.settledMean}, ` +
    `unbounded=[${unbounded.outliers.map((o) => o.frame).join(',')}]`);

  const zeroWindow = analyzeCaptureStart(leadingFlash, 0, { windowFrames: 0 });
  check('an empty start window reports no flash but still settles',
    zeroWindow.outliers.length === 0 && zeroWindow.settledMean === 100,
    `outliers=${zeroWindow.outliers.length}, settled=${zeroWindow.settledMean}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
