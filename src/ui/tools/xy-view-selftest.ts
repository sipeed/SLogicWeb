// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ADC_LSB_V, ADC_MAX_CODE, ADC_ZERO_CODE, analogVoltsFromCode, analogVoltsPerCode,
} from '../channelBanks.js';
import {
  XY_DENSITY_MAX_COUNT, XY_DENSITY_MAX_PER_PIXEL, XY_DENSITY_MAX_PIXELS, XY_MAX_POINTS,
  XY_MIN_PAIRS, XY_REASON_KEYS, fitXyAxes, planXy, xyAxes, xyDensity, xyDensitySize,
  xyFractionY, xyPixelX, xyPixelY, xySummary, xyZeroFraction, xyZeroFractionY, xyZeroLineX,
  xyZeroLineY,
  type XyPlotPlan, type XyPlanInput, type XyRefusalPlan,
} from '../xyView.js';
import {
  XY_DEFAULT_CONFIG, reconcileXyConfig, selectXySource, setXyFit, xyAccessibleText,
  xyStatusReason, xySummaryLines,
  type XyAnalysis, type XySectionView,
} from '../xyPanel.js';
import { XY_LABEL_MIN_PX, xyTickLayout } from '../xyCanvas.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

const read = (path: string): string => fs.readFileSync(path, 'utf8');
const slice = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
};

const viewSource = read('src/ui/xyView.ts');
const app = read('src/ui/app.ts');
const panel = read('src/ui/capturePanel.ts');
const css = read('src/ui/style.css');
const canvasSource = read('src/ui/xyCanvas.ts');
const panelSource = read('src/ui/xyPanel.ts');
const design = read('docs/DESIGN.md');
const architecture = read('docs/ARCHITECTURE.md');

interface PlanOverrides {
  sourceX?: number | null;
  sourceY?: number | null;
  unknownX?: ArrayLike<number>;
  unknownY?: ArrayLike<number>;
  zeroX?: number;
  zeroY?: number;
  voltsPerCodeX?: number;
  voltsPerCodeY?: number;
  maxPoints?: number;
}

function planInput(
  codesX: ArrayLike<number>, codesY: ArrayLike<number>, over: PlanOverrides = {},
): XyPlanInput {
  const input: XyPlanInput = {
    sourceX: over.sourceX === undefined ? 0 : over.sourceX,
    sourceY: over.sourceY === undefined ? 8 : over.sourceY,
    codesX,
    codesY,
    zeroX: over.zeroX ?? ADC_ZERO_CODE,
    zeroY: over.zeroY ?? ADC_ZERO_CODE,
    voltsPerCodeX: over.voltsPerCodeX ?? ADC_LSB_V,
    voltsPerCodeY: over.voltsPerCodeY ?? ADC_LSB_V,
  };
  if (over.unknownX !== undefined) input.unknownX = over.unknownX;
  if (over.unknownY !== undefined) input.unknownY = over.unknownY;
  if (over.maxPoints !== undefined) input.maxPoints = over.maxPoints;
  return input;
}

function okPlan(
  codesX: ArrayLike<number>, codesY: ArrayLike<number>, over: PlanOverrides = {},
): XyPlotPlan {
  const plan = planXy(planInput(codesX, codesY, over));
  if (plan.status !== 'ok') throw new Error(`expected an ok plan, got ${plan.reason}`);
  return plan;
}

function refusedPlan(
  codesX: ArrayLike<number>, codesY: ArrayLike<number>, over: PlanOverrides = {},
): XyRefusalPlan {
  const plan = planXy(planInput(codesX, codesY, over));
  if (plan.status !== 'refuse') throw new Error('expected a refusal plan');
  return plan;
}

function ramp(n: number, start = 0, step = 1): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = start + step * i;
  return out;
}

function allFinite(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function throwsRangeError(run: () => unknown): boolean {
  try {
    run();
  } catch (error) {
    return error instanceof RangeError;
  }
  return false;
}

function nonzeroPixels(counts: Uint16Array): number {
  let seen = 0;
  for (let i = 0; i < counts.length; i += 1) if (counts[i] > 0) seen += 1;
  return seen;
}

{
  const n = 4096;
  const codesX = new Float64Array(n);
  const codesY = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const theta = (2 * Math.PI * i) / n;
    codesX[i] = Math.round(ADC_ZERO_CODE + 100 * Math.cos(theta));
    codesY[i] = Math.round(ADC_ZERO_CODE + 100 * Math.sin(theta));
  }
  const circle = okPlan(codesX, codesY);
  const expectedRadius = 100 * ADC_LSB_V;
  const bins = new Uint32Array(16);
  let minRadius = Number.POSITIVE_INFINITY;
  let maxRadius = 0;
  let radiusSum = 0;
  let ordered = true;
  for (let i = 0; i < circle.plotted; i += 1) {
    const vx = circle.points[2 * i];
    const vy = circle.points[2 * i + 1];
    const radius = Math.hypot(vx, vy);
    minRadius = Math.min(minRadius, radius);
    maxRadius = Math.max(maxRadius, radius);
    radiusSum += radius;
    if (vx !== (codesX[i] - ADC_ZERO_CODE) * ADC_LSB_V) ordered = false;
    if (vy !== (codesY[i] - ADC_ZERO_CODE) * ADC_LSB_V) ordered = false;
    const angle = ((Math.atan2(vy, vx) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    bins[Math.min(15, Math.floor(angle / ((2 * Math.PI) / 16)))] += 1;
  }
  const radiusSpread = maxRadius - minRadius;
  check('a synthetic sine/cosine pair plots on the expected radius',
    circle.status === 'ok' && circle.plotted === n && circle.stride === 1 &&
      !circle.saturated && circle.requested === n && circle.paired === n &&
      circle.gapExcluded === 0 &&
      closeTo(radiusSum / n, expectedRadius, 0.25 * ADC_LSB_V) &&
      radiusSpread <= 1.5 * ADC_LSB_V && minRadius > 0 &&
      closeTo(expectedRadius, (100 * 32) / 255, 1e-9),
    `plotted=${circle.plotted}, stride=${circle.stride}, radius=${radiusSum / n}, ` +
      `expected=${expectedRadius}, spread=${radiusSpread}`);
  const half = new Float64Array(n);
  const halfY = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const theta = (Math.PI * i) / n;
    half[i] = Math.round(ADC_ZERO_CODE + 100 * Math.cos(theta));
    halfY[i] = Math.round(ADC_ZERO_CODE + 100 * Math.sin(theta));
  }
  const halfPlan = okPlan(half, halfY);
  const halfBins = new Uint32Array(16);
  for (let i = 0; i < halfPlan.plotted; i += 1) {
    const angle = Math.atan2(halfPlan.points[2 * i + 1], halfPlan.points[2 * i]);
    halfBins[Math.min(15, Math.floor((((angle % (2 * Math.PI)) + 2 * Math.PI) %
      (2 * Math.PI)) / ((2 * Math.PI) / 16)))] += 1;
  }
  check('the phase distribution is uniform over sixteen bins',
    [...bins].every((count) => Math.abs(count - n / 16) <= 6) &&
      [...bins].reduce((sum, count) => sum + count, 0) === n,
    `bins=${JSON.stringify([...bins])}`);
  check('a half-circle control leaves the upper half of the bins empty',
    [...halfBins].slice(9).every((count) => count === 0) &&
      halfBins[8] < 20 && halfBins[7] > 400 &&
      [...halfBins].reduce((sum, count) => sum + count, 0) === n,
    `halfBins=${JSON.stringify([...halfBins])}`);
  check('point i is the same-index pair of sample i, in sample order',
    ordered && circle.points.length === n * 2,
    `ordered=${ordered}, floats=${circle.points.length}`);
  check('every plotted voltage is finite',
    allFinite(circle.points), `floats=${circle.points.length}`);
}

{
  const n = 512;
  const codesX = new Float64Array(n);
  const codesY = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const theta = (2 * Math.PI * i) / n;
    codesX[i] = Math.round(ADC_ZERO_CODE + 90 * Math.cos(theta));
    codesY[i] = Math.round(ADC_ZERO_CODE + 70 * Math.sin(3 * theta));
  }
  const forward = okPlan(codesX, codesY);
  const mirrored = okPlan(codesY, codesX);
  let exactMirror = true;
  for (let i = 0; i < forward.plotted; i += 1) {
    if (mirrored.points[2 * i] !== forward.points[2 * i + 1]) exactMirror = false;
    if (mirrored.points[2 * i + 1] !== forward.points[2 * i]) exactMirror = false;
  }
  const reversedY = [...codesY].reverse();
  const scrambled = okPlan(reversedY, codesX);
  let scrambledMirror = true;
  for (let i = 0; i < forward.plotted; i += 1) {
    if (scrambled.points[2 * i] !== forward.points[2 * i + 1]) scrambledMirror = false;
    if (scrambled.points[2 * i + 1] !== forward.points[2 * i]) scrambledMirror = false;
  }
  check('swapping X and Y mirrors every coordinate exactly',
    forward.plotted === mirrored.plotted && forward.plotted === n && exactMirror,
    `plotted=${forward.plotted}, mirrored=${exactMirror}`);
  check('a reversed Y source does not mirror, so the pairing is index-ordered',
    !scrambledMirror && scrambled.plotted === n,
    `scrambledMirror=${scrambledMirror}`);
}

{
  const codes = ramp(8, 120, 2);
  const sameSource = refusedPlan(codes, codes, { sourceY: 0 });
  const equalCodes = okPlan(codes, codes);
  const missing = refusedPlan(codes, codes, { sourceY: null });
  const unaligned = refusedPlan(ramp(8), ramp(9));
  const zeroScale = refusedPlan(codes, codes, { voltsPerCodeX: 0 });
  const nanScale = refusedPlan(codes, codes, { voltsPerCodeY: Number.NaN });
  const nanZero = refusedPlan(codes, codes, { zeroX: Number.NaN });
  check('the same source id on both axes is refused before any pairing',
    sameSource.reason === 'same-source' &&
      sameSource.reasonKey === XY_REASON_KEYS['same-source'] &&
      sameSource.paired === 0 && equalCodes.paired === 8,
    `reason=${sameSource.reason}, key=${sameSource.reasonKey}, ` +
      `distinctSources=${equalCodes.paired}`);
  check('a missing, unaligned or uncalibrated source is unavailable, not plotted',
    missing.reason === 'unavailable' && unaligned.reason === 'unavailable' &&
      zeroScale.reason === 'unavailable' && nanScale.reason === 'unavailable' &&
      nanZero.reason === 'unavailable' &&
      unaligned.requested === 8 && unaligned.reasonKey === XY_REASON_KEYS.unavailable,
    `reasons=${JSON.stringify([missing.reason, unaligned.reason, zeroScale.reason,
      nanScale.reason, nanZero.reason])}`);
  const single = refusedPlan(ramp(1), ramp(1));
  const empty = refusedPlan(ramp(0), ramp(0));
  check('fewer than two known pairs is too-few',
    single.reason === 'too-few' && single.requested === 1 && single.paired === 1 &&
      empty.reason === 'too-few' && empty.requested === 0 &&
      XY_MIN_PAIRS === 2,
    `single=${single.reason}/${single.requested}/${single.paired}, empty=${empty.reason}`);
}

{
  const n = 10;
  const codesX = ramp(n, 100);
  const codesY = ramp(n, 140);
  const unknownX = new Uint8Array(n);
  unknownX[2] = 1;
  unknownX[3] = 1;
  const unknownY = new Uint8Array(n);
  unknownY[5] = 1;
  const plan = okPlan(codesX, codesY, { unknownX, unknownY });
  const expectedIndices = [0, 1, 4, 6, 7, 8, 9];
  let exactPairs = plan.plotted === expectedIndices.length;
  for (let k = 0; k < expectedIndices.length && exactPairs; k += 1) {
    const index = expectedIndices[k];
    if (plan.points[2 * k] !== (codesX[index] - ADC_ZERO_CODE) * ADC_LSB_V) exactPairs = false;
    if (plan.points[2 * k + 1] !== (codesY[index] - ADC_ZERO_CODE) * ADC_LSB_V) exactPairs = false;
  }
  check('one- and both-sided gaps drop exact pairs and are counted',
    plan.requested === n && plan.paired === 7 && plan.plotted === 7 &&
      plan.gapExcluded === 3 && plan.stride === 1 && exactPairs &&
      plan.paired + plan.gapExcluded === plan.requested,
    `requested=${plan.requested}, paired=${plan.paired}, excluded=${plan.gapExcluded}, ` +
      `exactPairs=${exactPairs}`);

  const oneSidedAll = new Uint8Array(n).fill(1);
  const gap = refusedPlan(codesX, codesY, { unknownX: oneSidedAll });
  const bothSided = refusedPlan(new Float64Array([0, 1, 2, 3]), new Float64Array([0, 1, 2, 3]), {
    unknownX: new Uint8Array([0, 0, 1, 1]),
    unknownY: new Uint8Array([1, 1, 0, 0]),
  });
  check('a gap on every pair refuses with the gap reason and exact counts',
    gap.reason === 'gap' && gap.paired === 0 && gap.gapExcluded === 10 &&
      gap.requested === 10 && gap.reasonKey === XY_REASON_KEYS.gap &&
      bothSided.reason === 'gap' && bothSided.gapExcluded === 4,
    `oneSided=${gap.reason}/${gap.gapExcluded}, bothSided=${bothSided.reason}/` +
      `${bothSided.gapExcluded}`);

  const oneKnown = refusedPlan(codesX, codesY, {
    unknownX: new Uint8Array([0, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
  });
  const nanCode = okPlan(new Float64Array([100, 101, Number.NaN, 103, 104]),
    new Float64Array([140, 141, 142, 143, 144]));
  check('a single surviving pair is too-few while a non-finite code is excluded',
    oneKnown.reason === 'too-few' && oneKnown.paired === 1 && oneKnown.gapExcluded === 9 &&
      nanCode.paired === 4 && nanCode.gapExcluded === 1 && nanCode.plotted === 4 &&
      allFinite(nanCode.points),
    `oneKnown=${oneKnown.reason}/${oneKnown.paired}/${oneKnown.gapExcluded}, ` +
      `nanCode=${nanCode.paired}/${nanCode.gapExcluded}/${allFinite(nanCode.points)}`);

  const shortMask = okPlan(codesX, codesY, { unknownY: new Uint8Array([0]) });
  check('a mask shorter than the window leaves the uncovered samples known',
    shortMask.paired === n && shortMask.gapExcluded === 0,
    `paired=${shortMask.paired}, excluded=${shortMask.gapExcluded}`);
}

{
  const n = 1000;
  const codesX = ramp(n);
  const codesY = ramp(n, 50);
  const exact = okPlan(codesX, codesY, { maxPoints: n });
  const capped = okPlan(codesX, codesY, { maxPoints: n - 1 });
  const half = okPlan(codesX, codesY, { maxPoints: n / 2 });
  let cappedOrder = true;
  for (let k = 0; k < capped.plotted; k += 1) {
    const index = 2 * k;
    if (capped.points[2 * k] !== (codesX[index] - ADC_ZERO_CODE) * ADC_LSB_V) cappedOrder = false;
  }
  check('exactly maxPoints pairs plot without a stride',
    exact.stride === 1 && exact.plotted === n && !exact.saturated &&
      exact.points.length === 2 * n,
    `stride=${exact.stride}, plotted=${exact.plotted}, saturated=${exact.saturated}`);
  check('one pair past the cap doubles the uniform stride and halves the plot',
    capped.stride === 2 && capped.plotted === 500 && capped.saturated &&
      capped.paired === n && capped.gapExcluded === 0 &&
      capped.points.length === 1000 && cappedOrder,
    `stride=${capped.stride}, plotted=${capped.plotted}, floats=${capped.points.length}, ` +
      `order=${cappedOrder}`);
  check('a doubled window lands exactly on the cap',
    half.stride === 2 && half.plotted === n / 2 && half.saturated &&
      half.points.length === n,
    `stride=${half.stride}, plotted=${half.plotted}, floats=${half.points.length}`);
}

{
  const n = XY_MAX_POINTS + 1;
  const codesX = ramp(n);
  const codesY = ramp(n, 60);
  const plan = okPlan(codesX, codesY);
  const lastIndex = 2 * (plan.plotted - 1);
  check('the real point cap is 2^18 and an oversized window is strided, not truncated',
    XY_MAX_POINTS === 262144 && plan.paired === n && plan.stride === 2 &&
      plan.plotted === Math.ceil(n / 2) && plan.saturated &&
      plan.points.length === plan.plotted * 2 &&
      plan.points[plan.points.length - 2] ===
        (codesX[n - 1] - ADC_ZERO_CODE) * ADC_LSB_V &&
      plan.points[2] === (codesX[2] - ADC_ZERO_CODE) * ADC_LSB_V &&
      plan.points[2] !== (codesX[1] - ADC_ZERO_CODE) * ADC_LSB_V &&
      plan.points[lastIndex] === plan.points[plan.points.length - 2],
    `cap=${XY_MAX_POINTS}, paired=${plan.paired}, stride=${plan.stride}, ` +
      `plotted=${plan.plotted}, floats=${plan.points.length}`);
}

{
  const codes = new Float64Array([118, 128, 138, 123]);
  const plan = okPlan(codes, codes, { voltsPerCodeX: 0.125, voltsPerCodeY: 0.125 });
  const spent = xyAxes(plan);
  const fitted = xyAxes(plan, { fit: true });
  const observed = plan.observedX;
  const step = (fitted!.x.max - fitted!.x.min) / 4;
  const mantissa = step / 10 ** Math.floor(Math.log10(step));
  check('the default axes are the source\'s full calibrated code span',
    spent !== null && spent.fit === false &&
      spent.x.min === (0 - ADC_ZERO_CODE) * 0.125 &&
      spent.x.max === (ADC_MAX_CODE - ADC_ZERO_CODE) * 0.125 &&
      spent.y.min === spent.x.min && spent.y.max === spent.x.max,
    `x=${JSON.stringify(spent?.x)}, y=${JSON.stringify(spent?.y)}`);
  check('Fit samples pads the observed pairs onto a 1-2-5 range',
    fitted !== null && fitted.fit && fitted.x.min === -2 && fitted.x.max === 2 &&
      fitted.y.min === -2 && fitted.y.max === 2 &&
      observed.min === -1.25 && observed.max === 1.25 &&
      mantissa === 1 && Number.isInteger(step / 10 ** Math.floor(Math.log10(step))),
    `range=${JSON.stringify(fitted?.x)}, observed=${JSON.stringify(observed)}, ` +
      `step=${step}, mantissa=${mantissa}`);
  check('the fitted range is strictly wider than the observed extremes',
    fitted!.x.min < observed.min && fitted!.x.max > observed.max &&
      fitted!.x.min !== observed.min && fitted!.x.max !== observed.max,
    `fit=${fitted!.x.min}..${fitted!.x.max}, observed=${observed.min}..${observed.max}`);

  const positive = new Float64Array([140, 145, 150]);
  const positiveFit = xyAxes(okPlan(positive, positive), { fit: true });
  check('a fitted range away from 0 V has no 0 V line',
    positiveFit !== null && positiveFit.x.min === 1 && positiveFit.x.max === 3 &&
      xyZeroFraction(positiveFit.x) === null && xyZeroFractionY(positiveFit.y) === null &&
      xyZeroLineX(positiveFit.x, 100) === null && xyZeroLineY(positiveFit.y, 100) === null,
    `range=${JSON.stringify(positiveFit)}, zero=${xyZeroFraction(positiveFit!.x)}`);

  const flat = xyAxes(okPlan(new Float64Array([128, 128, 128]), new Float64Array([128, 128, 128])),
    { fit: true });
  check('a flat trace still fits a non-degenerate symmetric range',
    flat !== null && flat.x.max > flat.x.min && flat.x.min < 0 && flat.x.max > 0 &&
      flat.x.min === -flat.x.max && flat.y.min === flat.x.min,
    `range=${JSON.stringify(flat)}`);

  check('refusal plans have no axes at all',
    xyAxes(refusedPlan(codes, codes, { sourceY: 0 })) === null &&
      fitXyAxes(plan).fit,
    `refusedAxes=${JSON.stringify(xyAxes(refusedPlan(codes, codes, { sourceY: 0 })))}`);
}

{
  const gains = [1, 2, 3, 5, 10];
  const bad: string[] = [];
  for (const gain of gains) {
    const voltsPerCode = analogVoltsPerCode(gain);
    const codes = new Float64Array([40, 128, 200]);
    const plan = okPlan(codes, codes, {
      voltsPerCodeX: voltsPerCode, voltsPerCodeY: voltsPerCode,
    });
    if (plan.rangeX.min !== analogVoltsFromCode(0, gain)) bad.push(`${gain}x min`);
    if (plan.rangeX.max !== analogVoltsFromCode(ADC_MAX_CODE, gain)) bad.push(`${gain}x max`);
    if (plan.voltsPerCodeX !== voltsPerCode) bad.push(`${gain}x slope`);
    if (!closeTo(plan.rangeX.max / plan.rangeX.min, -127 / 128, 1e-12)) bad.push(`${gain}x ratio`);
  }
  check('every declarable gain scales its own axis span from the code endpoints',
    bad.length === 0 && analogVoltsPerCode(1) === ADC_LSB_V &&
      closeTo(analogVoltsPerCode(10) * 10, ADC_LSB_V, 1e-15),
    `failures=${JSON.stringify(bad)}`);

  const plan = okPlan(ramp(4), ramp(4));
  const axes = xyAxes(plan)!;
  const upPixels = [0, 1, 2, 3, 4].map((k) =>
    xyPixelY(axes.y, 100, axes.y.min + ((axes.y.max - axes.y.min) * k) / 4));
  const rightPixels = [0, 1, 2, 3, 4].map((k) =>
    xyPixelX(axes.x, 200, axes.x.min + ((axes.x.max - axes.x.min) * k) / 4));
  const monotoneUp = upPixels.every((value, i) => i === 0 || value < upPixels[i - 1]);
  const monotoneRight = rightPixels.every((value, i) => i === 0 || value > rightPixels[i - 1]);
  check('X maps rightward and Y maps upward with the endpoints pinned',
    monotoneUp && monotoneRight &&
      xyPixelX(axes.x, 200, axes.x.min) === 0 &&
      xyPixelX(axes.x, 200, axes.x.max) === 199 &&
      xyPixelY(axes.y, 100, axes.y.max) === 0 &&
      xyPixelY(axes.y, 100, axes.y.min) === 99,
    `up=${JSON.stringify(upPixels)}, right=${JSON.stringify(rightPixels)}`);

  const zeroX = xyZeroFraction(axes.x)!;
  const zeroY = xyZeroFractionY(axes.y)!;
  check('the 0 V line sits at its exact calibrated position on both axes',
    closeTo(zeroX, 128 / 255, 1e-15) && closeTo(zeroY, 127 / 255, 1e-15) &&
      closeTo(xyZeroLineX(axes.x, 200) ?? Number.NaN, (128 / 255) * 200, 1e-12) &&
      closeTo(xyZeroLineY(axes.y, 100) ?? Number.NaN, (127 / 255) * 100, 1e-12) &&
      closeTo(xyFractionY(axes.y, 0), 127 / 255, 1e-15) &&
      closeTo(xyFractionY(axes.y, axes.y.max), 0, 1e-15) &&
      closeTo(xyFractionY(axes.y, axes.y.min), 1, 1e-15),
    `zeroX=${zeroX}, zeroY=${zeroY}, lineX=${xyZeroLineX(axes.x, 200)}, ` +
      `lineY=${xyZeroLineY(axes.y, 100)}`);
}

{
  const center = new Float64Array(100).fill(ADC_ZERO_CODE);
  const plan = okPlan(center, center);
  const saturated = xyDensity(plan, { width: 8, height: 8, maxPerPixel: 4 })!;
  const centerIndex = 3 * 8 + 4;
  let countSum = 0;
  for (let i = 0; i < saturated.counts.length; i += 1) countSum += saturated.counts[i];
  check('per-pixel counts saturate at the disclosed ceiling',
    XY_DENSITY_MAX_PER_PIXEL === 4096 && XY_DENSITY_MAX_COUNT === 65535 &&
      saturated.maxPerPixel === 4 && saturated.peak === 4 &&
      saturated.saturatedPixels === 1 && saturated.counts[centerIndex] === 4 &&
      saturated.alpha[centerIndex] === 255 && countSum === 4 &&
      saturated.plotted === 100 && Number.isInteger(countSum),
    `index=${centerIndex}, count=${saturated.counts[centerIndex]}, peak=${saturated.peak}, ` +
      `sum=${countSum}, saturated=${saturated.saturatedPixels}`);

  const defaultCeiling = xyDensity(okPlan(new Float64Array(5000).fill(ADC_ZERO_CODE),
    new Float64Array(5000).fill(ADC_ZERO_CODE)), { width: 8, height: 8 })!;
  check('the default density ceiling is the disclosed constant',
    defaultCeiling.maxPerPixel === XY_DENSITY_MAX_PER_PIXEL &&
      defaultCeiling.counts[centerIndex] === XY_DENSITY_MAX_PER_PIXEL &&
      defaultCeiling.saturatedPixels === 1,
    `ceiling=${defaultCeiling.maxPerPixel}, count=${defaultCeiling.counts[centerIndex]}`);

  const corners = okPlan(new Float64Array([0, ADC_MAX_CODE]), new Float64Array([0, ADC_MAX_CODE]));
  const sparse = xyDensity(corners, { width: 16, height: 16 })!;
  const atA = 15 * 16 + 0;
  const atB = 0 * 16 + 15;
  check('points mark single pixels and never a connecting line',
    nonzeroPixels(sparse.counts) === 2 && sparse.counts[atA] === 1 &&
      sparse.counts[atB] === 1 && sparse.counts[8 * 16 + 8] === 0 &&
      sparse.counts[7 * 16 + 8] === 0 && sparse.plotted === 2 && sparse.stride === 1 &&
      !/lineTo|moveTo|beginPath|stroke|segment/i.test(viewSource),
    `nonzero=${nonzeroPixels(sparse.counts)}, atA=${sparse.counts[atA]}, ` +
      `atB=${sparse.counts[atB]}, mid=${sparse.counts[8 * 16 + 8]}`);

  const thin = xyDensity(okPlan(new Float64Array([ADC_ZERO_CODE, ADC_ZERO_CODE]),
    new Float64Array([ADC_ZERO_CODE, ADC_ZERO_CODE])), { width: 8, height: 8 })!;
  check('alpha rises with density and a thin pixel still reaches the top of the ramp',
    sparse.alpha[atA] === 255 && thin.alpha[centerIndex] === 255 &&
      thin.counts[centerIndex] === 2 && saturated.alpha[centerIndex] === 255,
    `thin=${thin.alpha[centerIndex]}/${thin.counts[centerIndex]}, ` +
      `corner=${sparse.alpha[atA]}`);

  const degenerate = xyDensity(plan, {
    width: 8,
    height: 8,
    axes: { fit: false, x: { min: 1, max: 1 }, y: { min: -1, max: 1 } },
  })!;
  const degenerateSum = degenerate.counts.reduce((sum, value) => sum + value, 0);
  check('a degenerate axis maps to the middle pixel without any NaN',
    degenerateSum === 100 && degenerate.counts[4 * 8 + 4] === 100,
    `sum=${degenerateSum}, middle=${degenerate.counts[4 * 8 + 4]}`);

  const huge = xyDensitySize(8000, 4000);
  const plain = xyDensitySize(100, 50);
  const degenerateSize = xyDensitySize(0, Number.NaN);
  check('an oversized display scales the density buffer under the pixel ceiling',
    huge.width * huge.height <= XY_DENSITY_MAX_PIXELS &&
      huge.width < 8000 && huge.height < 4000 &&
      plain.width === 100 && plain.height === 50 &&
      degenerateSize.width === 1 && degenerateSize.height === 1,
    `huge=${JSON.stringify(huge)}, plain=${JSON.stringify(plain)}, ` +
      `degenerate=${JSON.stringify(degenerateSize)}`);

  check('density refuses a refusal plan and rejects impossible buffers',
    xyDensity(refusedPlan(ramp(4), ramp(4), { sourceY: 0 }), { width: 8, height: 8 }) === null &&
      throwsRangeError(() => xyDensity(plan, { width: 0, height: 8 })) &&
      throwsRangeError(() => xyDensity(plan, { width: Number.NaN, height: 8 })) &&
      throwsRangeError(() => xyDensity(plan, { width: 8, height: -1 })) &&
      throwsRangeError(() => xyDensity(plan, { width: 4096, height: 4096 })),
    `null=${xyDensity(refusedPlan(ramp(4), ramp(4), { sourceY: 0 }),
      { width: 8, height: 8 }) === null}`);
}

{
  const plan = okPlan(ramp(6, 100), ramp(6, 150));
  const axes = xyAxes(plan)!;
  const density = xyDensity(plan, { width: 12, height: 9 })!;
  const summary = xySummary(plan, { axes, density });
  const closeX = xySummary(plan);
  const bareX = xySummary(plan, { density });
  const refused = xySummary(refusedPlan(ramp(4), ramp(4), { sourceY: 0 }));
  const fitted = xySummary(plan, { axes: xyAxes(plan, { fit: true }), density });
  check('the summary discloses exact counts and the density ceiling',
    summary.status === 'ok' && summary.reason === null && summary.reasonKey === null &&
      summary.requested === 6 && summary.paired === 6 && summary.plotted === 6 &&
      summary.gapExcluded === 0 && summary.stride === 1 && !summary.pointSaturated &&
      summary.density !== null && summary.density.stride === 1 &&
      summary.density.maxPerPixel === XY_DENSITY_MAX_PER_PIXEL &&
      summary.density.saturatedPixels === 0 && summary.density.plotted === 6,
    `summary=${JSON.stringify(summary)}`);
  check('the summary carries the active axis ranges and 0 V fractions',
    closeX.rangeX !== null && closeX.rangeX.min === summary.rangeX!.min &&
      closeX.fit === false && closeX.zeroFractionX !== null &&
      closeX.zeroFractionY !== null && closeX.density === null &&
      bareX.density !== null &&
      fitted.fit === true && fitted.rangeX!.min > summary.rangeX!.min &&
      fitted.rangeX!.max < summary.rangeX!.max,
    `fit=${fitted.fit}, default=${JSON.stringify(summary.rangeX)}, ` +
      `fittedRange=${JSON.stringify(fitted.rangeX)}`);
  check('a refusal summary names the locale-free reason key and no axes',
    refused.status === 'refuse' && refused.reason === 'same-source' &&
      refused.reasonKey === XY_REASON_KEYS['same-source'] && refused.plotted === 0 &&
      refused.stride === 1 && refused.rangeX === null && refused.rangeY === null &&
      refused.zeroFractionX === null && refused.zeroFractionY === null &&
      refused.density === null,
    `refused=${JSON.stringify(refused)}`);
}

{
  const commentLines = viewSource.split('\n')
    .filter((line) => line.trim().startsWith('//') || line.includes('/*'));
  check('the planner carries only its license header, no explanatory comment',
    commentLines.length === 1 && commentLines[0].includes('SPDX'),
    `comments=${JSON.stringify(commentLines)}`);
  check('the planner never sorts, interpolates or resamples a source',
    !viewSource.includes('.sort(') && !/interpolat|resampl|nearest/i.test(viewSource) &&
      viewSource.includes('input.codesX[i] - input.zeroX') &&
      viewSource.includes('input.codesY[i] - input.zeroY'),
    `sort=${viewSource.includes('.sort(')}, interp=${/interpolat|resampl/.test(viewSource)}`);
}

{
  const A0 = { group: 0, start: 0, gain: 1, name: 'A0' };
  const A1 = { group: 1, start: 8, gain: 2, name: 'A1' };
  const A2 = { group: 2, start: 16, gain: 5, name: 'A2' };
  const sources = [A0, A1, A2];
  const preferred = reconcileXyConfig(
    { sourceX: null, sourceY: null, fit: false }, sources, A1.start);
  const kept = reconcileXyConfig({ sourceX: 0, sourceY: 8, fit: true }, sources, null);
  const equal = reconcileXyConfig({ sourceX: 0, sourceY: 0, fit: false }, sources, null);
  const missing = reconcileXyConfig({ sourceX: 16, sourceY: 99, fit: false }, sources, 8);
  const single = reconcileXyConfig(
    { sourceX: null, sourceY: null, fit: false }, [A0], null);
  const none = reconcileXyConfig(XY_DEFAULT_CONFIG, [], null);
  check('X follows the preferred group and Y is a different present group',
    preferred.sourceX === 8 && preferred.sourceY === 0 &&
      kept.sourceX === 0 && kept.sourceY === 8 && kept.fit &&
      equal.sourceX === 0 && equal.sourceY === 8 &&
      missing.sourceX === 16 && missing.sourceY === 8 &&
      single.sourceX === 0 && single.sourceY === null &&
      none.sourceX === null && none.sourceY === null,
    `preferred=${JSON.stringify(preferred)}, kept=${JSON.stringify(kept)}, ` +
      `equal=${JSON.stringify(equal)}, missing=${JSON.stringify(missing)}`);
  check('a reconciled config that already differs returns the same object',
    reconcileXyConfig(kept, sources, null) === kept &&
      reconcileXyConfig(preferred, sources, 0) === preferred &&
      equal !== kept && equal.sourceX !== equal.sourceY,
    `keptIdentity=${reconcileXyConfig(kept, sources, null) === kept}`);

  const swapped = selectXySource({ sourceX: 0, sourceY: 8, fit: false }, 'y', 0);
  const swappedBack = selectXySource(swapped, 'x', 0);
  const plain = selectXySource({ sourceX: 0, sourceY: 8, fit: true }, 'y', 16);
  const noop = selectXySource({ sourceX: 0, sourceY: 8, fit: true }, 'y', 8);
  const fitOn = setXyFit({ sourceX: 0, sourceY: 8, fit: false }, true);
  const fitSame = setXyFit(fitOn, true);
  check('picking the other axis\'s source swaps X and Y instead of aliasing them',
    swapped.sourceX === 8 && swapped.sourceY === 0 &&
      swappedBack.sourceX === 0 && swappedBack.sourceY === 8 &&
      plain.sourceX === 0 && plain.sourceY === 16 && plain.fit &&
      noop.sourceX === 0 && noop.sourceY === 8 &&
      fitOn.fit && fitOn.sourceX === 0 && fitOn.sourceY === 8 && fitSame === fitOn,
    `swapped=${JSON.stringify(swapped)}, back=${JSON.stringify(swappedBack)}, ` +
      `plain=${JSON.stringify(plain)}`);
}

function analysisOf(
  codesX: ArrayLike<number>, codesY: ArrayLike<number>, over: PlanOverrides = {},
  analysisOver: Partial<XyAnalysis> = {},
): XyAnalysis {
  const plan = okPlan(codesX, codesY, over);
  const axes = xyAxes(plan)!;
  const density = xyDensity(plan, { width: 64, height: 32, axes })!;
  const summary = xySummary(plan, { axes, density });
  return {
    status: 'ok',
    sourceX: { group: 0, start: 0, gain: 1, name: 'A0' },
    sourceY: { group: 1, start: 8, gain: 2, name: 'A1' },
    windowStart: 1_000,
    windowEnd: 1_000 + plan.requested,
    requestedSamples: plan.requested,
    analyzedSamples: plan.requested,
    clipped: false,
    truncated: false,
    fit: false,
    plan,
    axes,
    density,
    summary,
    ...analysisOver,
  };
}

function sectionOf(analysis: XyAnalysis | null, over: Partial<XySectionView> = {}): XySectionView {
  return {
    mode: 'xy',
    sources: [
      { group: 0, start: 0, gain: 1, name: 'A0' },
      { group: 1, start: 8, gain: 2, name: 'A1' },
    ],
    sourceX: 0,
    sourceY: 8,
    fit: false,
    analysis,
    ...over,
  };
}

{
  const analysis = analysisOf(ramp(32, 100), ramp(32, 150));
  const lines = xySummaryLines(sectionOf(analysis));
  const joined = lines.join('\n');
  check('the XY summary names both sources, their gains and the absolute window',
    lines[0]!.includes('A0') && lines[0]!.includes('1\u00d7') &&
      lines[0]!.includes('A1') && lines[0]!.includes('2\u00d7') &&
      joined.includes('1,000') && joined.includes('1,032') &&
      joined.includes('32 samples'),
    `lines=${JSON.stringify(lines)}`);
  check('the XY summary discloses requested, plotted and gap-excluded counts',
    lines[2]!.includes('32') && analysis.summary!.requested === 32 &&
      analysis.summary!.plotted === 32 && analysis.summary!.gapExcluded === 0 &&
      !joined.includes('Display stride'),
    `counts=${lines[2]}`);
  check('the XY summary states the density ceiling and axis ranges',
    joined.includes('4,096') && joined.includes('saturated pixels 0') &&
      joined.includes('X -16.1 V') && joined.includes('Y -16.1 V') &&
      joined.includes('full calibrated code span') &&
      joined.includes('0 V at') && joined.includes('Quantization X'),
    `lines=${JSON.stringify(lines)}`);

  const strided = analysisOf(ramp(1000), ramp(1000, 50), { maxPoints: 100 });
  const stridedLines = xySummaryLines(sectionOf(strided));
  check('an oversized window states its uniform display stride',
    strided.summary!.stride === 10 &&
      stridedLines.some((line) => line.includes('Display stride') &&
        line.includes('10')) &&
      stridedLines.some((line) => line.includes('1,000') && line.includes('100')),
    `stride=${strided.summary!.stride}, lines=${JSON.stringify(stridedLines)}`);

  const cropped = analysisOf(ramp(16), ramp(16, 40), {}, {
    clipped: true, truncated: true, analyzedSamples: 12,
  });
  const croppedLines = xySummaryLines(sectionOf(cropped));
  check('a cropped or truncated window is disclosed in the summary',
    croppedLines.some((line) => line.includes('cropped to the current wave')) &&
      croppedLines.some((line) => line.includes('analyzed 12 of 16 samples')),
    `lines=${JSON.stringify(croppedLines)}`);

  const fitted = analysisOf(new Float64Array([118, 128, 138, 123]),
    new Float64Array([118, 128, 138, 123]), { voltsPerCodeX: 0.125, voltsPerCodeY: 0.125 });
  fitted.fit = true;
  fitted.axes = xyAxes(fitted.plan!, { fit: true });
  fitted.density = xyDensity(fitted.plan!, {
    width: 64, height: 32, axes: fitted.axes!,
  });
  fitted.summary = xySummary(fitted.plan!, { axes: fitted.axes, density: fitted.density });
  const fitLines = xySummaryLines(sectionOf(fitted, { fit: true }));
  check('Fit samples changes the disclosed range, not the pair data',
    fitLines.some((line) => line.includes('fitted to the sample extrema')) &&
      fitLines.some((line) => line.includes('X -2 V \u2013 2 V')) &&
      fitted.summary!.paired === 4 && fitted.summary!.plotted === 4,
    `lines=${JSON.stringify(fitLines)}`);

  const outside = analysisOf(new Float64Array([140, 145, 150]), new Float64Array([140, 145, 150]));
  outside.axes = xyAxes(outside.plan!, { fit: true });
  outside.summary = xySummary(outside.plan!, { axes: outside.axes });
  check('a fitted range away from 0 V says so instead of drawing a phantom 0 V line',
    xySummaryLines(sectionOf(outside)).some((line) => line.includes('0 V is outside')),
    `lines=${JSON.stringify(xySummaryLines(sectionOf(outside)))}`);
}

{
  const codes = ramp(8, 120, 2);
  const same = refusedPlan(codes, codes, { sourceY: 0 });
  const sameAnalysis = analysisOf(ramp(4), ramp(4));
  sameAnalysis.status = 'same-source';
  sameAnalysis.plan = same;
  sameAnalysis.axes = null;
  sameAnalysis.density = null;
  sameAnalysis.summary = xySummary(same);
  const sameLines = xySummaryLines(sectionOf(sameAnalysis));
  const unavailable = analysisOf(ramp(4), ramp(4));
  unavailable.status = 'unavailable';
  unavailable.plan = refusedPlan(ramp(4), ramp(9));
  unavailable.axes = null;
  unavailable.density = null;
  unavailable.summary = xySummary(unavailable.plan);
  const tooFew = analysisOf(ramp(2), ramp(2));
  tooFew.status = 'too-few';
  tooFew.plan = refusedPlan(ramp(1), ramp(1));
  tooFew.axes = null;
  tooFew.density = null;
  tooFew.requestedSamples = 1;
  tooFew.analyzedSamples = 1;
  tooFew.summary = xySummary(tooFew.plan);
  const gap = analysisOf(ramp(4), ramp(4));
  gap.status = 'gap';
  gap.plan = refusedPlan(ramp(4), ramp(4), {
    unknownX: new Uint8Array([1, 1, 1, 1]),
  });
  gap.axes = null;
  gap.density = null;
  gap.summary = xySummary(gap.plan);
  check('the refusal matrix states same-source, unavailable, too-few and gap',
    sameLines[0] === 'X and Y must be different analog groups' &&
      sameLines[1]!.includes('Requested') &&
      xySummaryLines(sectionOf(unavailable))[0] ===
        'a selected analog group is unavailable' &&
      xySummaryLines(sectionOf(tooFew))[0] ===
        'fewer than two known pairs in the window' &&
      xySummaryLines(sectionOf(gap))[0] ===
        'no sample is known on both sources in the window' &&
      xyStatusReason(unavailable) === 'a selected analog group is unavailable',
    `same=${JSON.stringify(sameLines)}, gap=${JSON.stringify(xySummaryLines(sectionOf(gap)))}`);

  const noSource = analysisOf(ramp(4), ramp(4));
  noSource.status = 'no-source';
  noSource.sourceY = null;
  noSource.plan = null;
  noSource.axes = null;
  noSource.density = null;
  noSource.summary = null;
  const noWindow = { ...noSource, status: 'no-window' as const };
  const previous = { ...noSource, status: 'previous-wave-displayed' as const };
  check('missing source, missing window and a held previous wave each refuse explicitly',
    xySummaryLines(sectionOf(noSource, { sourceY: null }))[0] ===
      'two different analog groups are required' &&
      xySummaryLines(sectionOf(noWindow, { sourceY: null }))[0] ===
        'no measurement window' &&
      xySummaryLines(sectionOf(previous, { sourceY: null }))[0] ===
        'an older capture is on screen; waiting for the current one' &&
      xySummaryLines(sectionOf(null))[0] === 'two different analog groups are required' &&
      xySummaryLines(sectionOf(analysisOf(ramp(4), ramp(4)), { mode: 'time' }))[0] ===
        'XY view is off',
    `noSource=${JSON.stringify(xySummaryLines(sectionOf(noSource, { sourceY: null })))}`);
}

{
  const analysis = analysisOf(ramp(12, 100), ramp(12, 150));
  const lines = xySummaryLines(sectionOf(analysis));
  check('the accessible description is the same summary in one sentence',
    xyAccessibleText(sectionOf(analysis)) === lines.join(' \u00b7 ') &&
      xyAccessibleText(sectionOf(analysis)).includes('Requested') &&
      xyAccessibleText(sectionOf(analysis)).includes('A0'),
    `label=${xyAccessibleText(sectionOf(analysis))}`);
}

{
  const plan = okPlan(ramp(4), ramp(4));
  const spent = xyAxes(plan)!;
  const ticks = xyTickLayout(spent, 400, 400);
  const labels = [...ticks.x, ...ticks.y].map((tick) => tick.label);
  const xPositions = ticks.x.map((tick) => tick.pos);
  const yPositions = ticks.y.map((tick) => tick.pos);
  const monotone = (values: number[], up: boolean): boolean =>
    values.every((value, index) => index === 0 || (up ? value > values[index - 1]! : value < values[index - 1]!));
  check('linear voltage ticks rise with X and fall down the Y axis, with 0 V labelled',
    ticks.x.length >= 4 && ticks.y.length >= 4 &&
      monotone(xPositions, true) && monotone(yPositions, false) &&
      labels.includes('0 V') &&
      ticks.stepX > 0 && ticks.stepY > 0 &&
      ticks.x[0]!.pos >= 0 && ticks.x[ticks.x.length - 1]!.pos < 400 &&
      ticks.y[0]!.pos >= 0 && ticks.y[ticks.y.length - 1]!.pos < 400 &&
      ticks.x.every((tick) => tick.pos >= 0 && tick.pos < 400) &&
      ticks.y.every((tick) => tick.pos >= 0 && tick.pos < 400),
    `x=${JSON.stringify(ticks.x)}, y=${JSON.stringify(ticks.y)}`);

  const fittedAxes = xyAxes(okPlan(new Float64Array([118, 128, 138, 123]),
    new Float64Array([118, 128, 138, 123]), { voltsPerCodeX: 0.125, voltsPerCodeY: 0.125 }),
  { fit: true })!;
  const fitTicks = xyTickLayout(fittedAxes, 300, 200);
  const mantissa = (step: number): number => step / 10 ** Math.floor(Math.log10(step));
  check('fitted 1-2-5 ticks stay inside the display box and cover 0 V',
    fitTicks.x.length >= 4 && fitTicks.y.length >= 4 &&
      [1, 2, 5, 10].includes(Math.round(mantissa(fitTicks.stepX))) &&
      fitTicks.x.some((tick) => tick.label === '0 V') &&
      fitTicks.y.some((tick) => tick.label === '0 V') &&
      XY_LABEL_MIN_PX === 48,
    `x=${JSON.stringify(fitTicks.x)}, step=${fitTicks.stepX}`);
}

{
  const syncStart = app.indexOf('  private syncViewMode(): void {');
  const sync = syncStart < 0 ? '' : app.slice(syncStart, app.indexOf('\n  }', syncStart));
  const modeStart = app.indexOf('  private setViewMode(mode: AnalysisViewMode): void {');
  const setter = modeStart < 0 ? '' : app.slice(modeStart, app.indexOf('\n  }', modeStart));
  const forbidden = [
    'setViewport(', 'clearCursors(', 'addCursor(', 'removeCursor(', 'startCapture(',
    'stopCapture(', 'persistWorkspace(', 'this.settings =', 'captureStore.replace(',
    'noteViewportIntent(', 'this.dirty = true;\n    this.relayout',
  ];
  const setterBodies = [
    setter,
    slice(app, '  private setXySource(', '  private setXyFit('),
    slice(app, '  private setXyFit(', '  private applyFftBounds('),
  ];
  const leaked = setterBodies.flatMap((body) =>
    forbidden.filter((needle) => body.includes(needle)));
  const inject = setter.replace('this.viewMode = mode;',
    'this.viewMode = mode;\n    this.stack.setViewport(0, 1);');
  check('switching to XY changes visibility and analysis state only',
    setter.includes("mode !== 'time' && mode !== 'fft' && mode !== 'xy'") &&
      setter.includes('this.syncViewMode();') && setter.includes('this.xyPending = true;') &&
      leaked.length === 0 && inject.includes('this.stack.setViewport(0, 1);') &&
      sync.includes("classList.toggle('xy-active', xy)") &&
      sync.includes('this.xyCanvas.el.hidden = !xy;'),
    `leaked=${JSON.stringify(leaked)}, inject=${inject.includes('setViewport')}`);

  const oneSwitch = panel.split('measure-view-mode').length - 1;
  check('the one Time/FFT/XY switch lives in the measurement section with XY controls',
    oneSwitch === 2 && panel.includes("['xy', 'capturePanel.viewXy']") &&
      panel.includes('onPickXySource(axis: XyAxis, start: number | null): void;') &&
      panel.includes('onPickXyFit(fit: boolean): void;') &&
      app.includes('onPickXySource: (axis, start) => this.setXySource(axis, start)') &&
      app.includes('onPickXyFit: (fit) => this.setXyFit(fit)') &&
      !panel.includes("section(t('capturePanel.xy"),
    `switch=${oneSwitch}`);

  const frameStart = app.indexOf('private frame = (): void => {');
  const frameEnd = app.indexOf('\n  };', frameStart);
  const frame = frameStart < 0 ? '' : app.slice(frameStart, frameEnd);
  const branch = (source: string): boolean => {
    const at = source.indexOf('if (now - this.analysisPanelAt > 500) {');
    const end = source.indexOf('now - this.runningPanelAt > 500');
    const body = at < 0 || end < 0 ? '' : source.slice(at, end);
    return body.includes("if (this.running && this.viewMode === 'xy') {") &&
      body.includes('this.xyPending = true;') && body.includes('this.dirty = true;') &&
      !body.includes('requestAnimationFrame') && !body.includes('setTimeout') &&
      !body.includes('setInterval');
  };
  const noTick = frame.replace('this.xyPending = true;', '');
  check('running XY updates ride the separate analysisPanelAt branch with no new clock',
    branch(frame) && !branch(noTick) &&
      count(app, 'private analysisPanelAt = 0;') === 1,
    `branch=${branch(frame)}, noTick=${branch(noTick)}`);

  const drawStart = app.indexOf('  private draw(force = true): void {');
  const drawHead = drawStart < 0 ? '' : app.slice(drawStart, drawStart + 320);
  check('a stopped XY view is drawn event-driven through the ordinary frame path',
    drawHead.includes("if (this.viewMode === 'xy') {") &&
      drawHead.includes('this.drawXyView();') &&
      !app.includes('xyTimer') && !app.includes('xyInterval') &&
      canvasSource.indexOf('requestAnimationFrame') < 0 &&
      panelSource.indexOf('setInterval') < 0,
    `head=${drawHead.length}`);
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

{
  const view = slice(app, 'private measurementView(): MeasurementSectionView {',
    'private measurementBase(');
  const pump = slice(app, 'private pumpMeasurementCapture(): void {', '\n  }');
  const record = slice(app, 'private recordMeasurementWave(reason: CaptureStopReason): void {', '\n  }');
  const persist = slice(app, 'private submitPersistenceWave(', 'private clearPersistence(');
  const analysis = slice(app, '  private xyAnalysis(', '  private xyDensityFor(');
  check('measurements, the capture job, statistics and Persistence pause for XY too',
    view.includes("if (this.viewMode !== 'time') {") &&
      view.includes('const xy = this.xySectionView();') &&
      pump.includes("if (this.viewMode !== 'time') return;") &&
      record.includes("this.cursorsPageShown() && this.viewMode === 'time'") &&
      persist.includes('viewMode: this.viewMode,') &&
      !persist.includes("viewMode: 'time',"),
    `view=${view.includes('xySectionView')}, pump=${pump.includes('viewMode')}, ` +
      `record=${record.includes('viewMode')}`);

  check('XY reads the current wave through the exact reader for both sources only',
    slice(app, '  private xySectionView(', '  private xyAnalysis(')
      .includes('this.captureStore') &&
      count(analysis, 'readMeasureSamples(store, {') === 2 &&
      analysis.includes('planXy({') &&
      analysis.includes('unknownX: readX.unknown') &&
      analysis.includes('unknownY: readY.unknown') &&
      !analysis.includes('sampleAt(') && !analysis.includes('this.store.query(') &&
      !analysis.includes('interpolat') && !analysis.includes('resampl'),
    `reader=${count(analysis, 'readMeasureSamples(store, {')}`);

  const holdNeedle = "if (this.repeatShowingFront) return { ...base, status: 'previous-wave-displayed' };";
  const holdAt = analysis.indexOf(holdNeedle);
  const windowAt = analysis.indexOf('resolveMeasurementWindow(');
  const held = analysis.replace(holdNeedle, "if (false) return base;");
  check('a repeat display holding the older wave refuses before any window or pairing',
    holdAt >= 0 && windowAt > holdAt && held !== analysis &&
      !held.includes(holdNeedle) && held.indexOf('resolveMeasurementWindow(') >= 0,
    `holdAt=${holdAt}, windowAt=${windowAt}`);

  check('both reads resolve one store-relative window, crop it and form requested counts after it',
    analysis.includes('resolveMeasurementWindow(') &&
      analysis.includes('Math.min(window.start, store.length)') &&
      analysis.includes('Math.min(window.end, store.length)') &&
      analysis.includes('const requested = end - start;') &&
      analysis.includes('maxSamples: Math.max(1, requested)') &&
      analysis.includes('windowStart: start + store.droppedSamples') &&
      analysis.includes('clipped,'),
    `window=${analysis.includes('resolveMeasurementWindow(')}, ` +
      `requested=${analysis.includes('const requested = end - start;')}`);

  const key = slice(app, '    const key = [', '].join');
  const fitOnly = slice(app, '  private setXyFit(', '\n  }');
  const sourceOnly = slice(app, '  private setXySource(', '  private setXyFit(');
  check('the settled cache key covers the wave, both sources and the window, never the fit flag',
    key.includes('store.length') && key.includes('store.droppedSamples') &&
      key.includes('sourceX.start') && key.includes('sourceX.gain') &&
      key.includes('sourceY.start') && key.includes('sourceY.gain') &&
      key.includes('start, end') && !key.includes('config.fit') &&
      !fitOnly.includes('this.xyCache = null') &&
      sourceOnly.includes('this.xyCache = null') &&
      app.includes('if (settled && !tick) {'),
    `key=${key.length}, fitClearsPlan=${fitOnly.includes('this.xyCache = null')}`);
}

{
  const draw = slice(app, '  private drawXyView(): void {', '  private wireXy(): void {');
  const wire = slice(app, '  private wireXy(): void {', '  private fftCanvasBox(): FftViewportBox {');
  const box = slice(app, '  private xyDensityFor(', '  private drawXyView(): void {');
  check('the XY canvas is the accessible image and its textual summary is the description',
    canvasSource.includes("canvas.className = 'xy-canvas';") &&
      canvasSource.includes("canvas.setAttribute('role', 'img');") &&
      canvasSource.includes('canvas.tabIndex = 0;') &&
      draw.includes("this.xyCanvas.el.setAttribute('aria-label', xyAccessibleText(view));") &&
      panel.includes("summary.dataset.xySummary = '';") &&
      panel.includes("item.textContent = xySummaryLines(xy).join('\\n');") &&
      panel.includes('measure-note xy-summary'),
    `label=${draw.includes('xyAccessibleText(view)')}`);

  check('the density buffer is rasterised once per result through ImageData, never as lines',
    canvasSource.includes('createImageData') && canvasSource.includes('putImageData') &&
      canvasSource.includes('drawImage') &&
      canvasSource.includes('density.counts') && canvasSource.includes('density.alpha') &&
      !canvasSource.includes('density.points') && !canvasSource.includes('lineTo(density') &&
      viewSource.includes('new Uint16Array(pixels)') &&
      XY_DENSITY_MAX_PIXELS === 2 ** 22,
    `image=${canvasSource.includes('putImageData')}`);

  check('XY draws independent axes with emphasised 0 V lines and no NaN-sensitive path',
    canvasSource.includes('xyZeroLineX') && canvasSource.includes('xyZeroLineY') &&
      canvasSource.includes('input.palette.text80') &&
      canvasSource.includes('ctx.fillText(tick.label, 4') &&
      canvasSource.includes('ctx.fillText(tick.label, labelX, h - 6)') &&
      canvasSource.includes('this.axisLabel(input.sourceY') &&
      canvasSource.includes('this.axisLabel(input.sourceX') &&
      draw.includes('sourceX: xySourceLabel(analysis.sourceX)') &&
      draw.includes('sourceY: xySourceLabel(analysis.sourceY)') &&
      !canvasSource.includes('Infinity') &&
      box.includes('xyDensitySize(box.width, box.height)') &&
      box.includes('const width = size.width;') &&
      box.includes('const height = size.height;'),
    `zero=${canvasSource.includes('xyZeroLineX')}/${canvasSource.includes('xyZeroLineY')}`);

  check('the XY canvas takes the same visible-viewport box as FFT, not the content height',
    draw.includes('const box = this.fftCanvasBox();') &&
      draw.includes('this.xyCanvas.syncSize(box);') &&
      !draw.includes('this.el.plot.clientHeight') &&
      box.includes('this.fftCanvasBox()') &&
      canvasSource.includes("this.el.style.width = `${box.width}px`;") &&
      canvasSource.includes("this.el.style.top = `${box.top}px`;"),
    `box=${box.includes('this.fftCanvasBox()')}`);

  check('XY steals plot gestures so pan, zoom and pointer actions cannot touch the viewport',
    wire.includes("xyCanvas.addEventListener('pointerdown', steal);") &&
      wire.includes("xyCanvas.addEventListener('wheel', steal, { passive: false });") &&
      wire.includes('event.preventDefault();') && wire.includes('event.stopPropagation();') &&
      wire.includes("if (this.viewMode !== 'xy') return;") &&
      !wire.includes('setViewport(') && !wire.includes('addCursor('),
    `wire=${wire.length}`);
}

{
  check('the sheet styles the XY canvas and wraps the XY controls at a narrow rail',
    ['.xy-canvas {', '.xy-canvas:focus-visible', '#plot:not(.xy-active) > .xy-canvas {',
      '.xy-controls {', '.xy-controls > .field {', '.xy-summary {']
      .every((rule) => css.includes(rule)) &&
      slice(css, '.xy-controls {', '}').includes('flex-wrap: wrap;') &&
      slice(css, '.xy-summary {', '}').includes('white-space: pre-line;') &&
      css.includes('#plot.xy-active #wave-stack') &&
      css.includes('#plot-col.xy-active #axis'),
    `canvas=${css.includes('.xy-canvas {')}`);

  const catalogKeys = Object.keys(en).filter((key) =>
    key === 'capturePanel.viewXy' || key.startsWith('capturePanel.xy') ||
    key === 'capturePanel.measureStatusPaused');
  const missing = catalogKeys.filter((key) =>
    !(key in zhCN) || !(key in ru) || !(key in fr));
  const empty = catalogKeys.filter((key) =>
    ![en, zhCN, ru, fr].every((catalog) => (catalog as Record<string, string>)[key]?.trim()));
  const symbolOnly = new Set(['capturePanel.viewXy', 'capturePanel.xyLineAxes']);
  const identical = catalogKeys.filter((key) => !symbolOnly.has(key) &&
    (zhCN as Record<string, string>)[key] === (en as Record<string, string>)[key] &&
    (ru as Record<string, string>)[key] === (en as Record<string, string>)[key] &&
    (fr as Record<string, string>)[key] === (en as Record<string, string>)[key]);
  const reasonKeys = Object.values(XY_REASON_KEYS);
  check('every XY string exists in all four catalogs with real translated text',
    catalogKeys.length >= 27 && missing.length === 0 && empty.length === 0 &&
      identical.length === 0 &&
      reasonKeys.every((key) => key in en) &&
      (zhCN as Record<string, string>)['capturePanel.viewXy'] === 'XY',
    `keys=${catalogKeys.length}, missing=${JSON.stringify(missing)}, ` +
      `identical=${JSON.stringify(identical)}`);

  const placeholders = (text: string | undefined): string =>
    [...(text ?? '').matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',');
  const english = en as Record<string, string>;
  const placeholderDrift = (catalog: Record<string, string>): string[] =>
    catalogKeys.filter((key) => placeholders(catalog[key]) !== placeholders(english[key]));
  const brokenZh = { ...(zhCN as Record<string, string>) };
  brokenZh['capturePanel.xyLineStride'] = 'showing stride {stride}';
  brokenZh['capturePanel.xyLineCounts'] = 'Requested {requested} · plotted {plotted}';
  check('every locale keeps every XY placeholder, including repeated ones',
    placeholderDrift(zhCN as Record<string, string>).length === 0 &&
      placeholderDrift(ru as Record<string, string>).length === 0 &&
      placeholderDrift(fr as Record<string, string>).length === 0 &&
      placeholders(english['capturePanel.xyLineStride']) === 'stride,stride' &&
      placeholderDrift(brokenZh).sort().join('|') ===
        'capturePanel.xyLineCounts|capturePanel.xyLineStride',
    `zh=${JSON.stringify(placeholderDrift(zhCN as Record<string, string>))}, ` +
      `control=${JSON.stringify(placeholderDrift(brokenZh))}`);
}

{
  check('the design and architecture records state XY pairing, gaps, stride and the lossless return',
    design.includes('XY view is a relationship of two real analog groups') &&
      design.includes('same-index only') &&
      design.includes('resampling or carried value across a gap') &&
      design.includes('uniform display stride') &&
      design.includes('returning to Time restores every field unchanged') &&
      architecture.includes('`xyConfig`') &&
      architecture.includes('XY reads two sources through the same exact reader') &&
      architecture.includes('with no interpolation'),
    `design=${design.includes('same-index only')}, ` +
      `architecture=${architecture.includes('`xyConfig`')}`);
}

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
