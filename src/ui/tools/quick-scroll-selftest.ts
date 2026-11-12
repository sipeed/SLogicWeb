import {
  QUICK_SCROLL_CLICK_SLOP, QUICK_SCROLL_DECAY_MS, QUICK_SCROLL_MIN_SPEED, QUICK_SCROLL_RECENT_MS,
  QUICK_SCROLL_STOP_SPEED, flingStep, releaseVelocity, startsFling, type QuickScrollSample,
} from '../quickScroll.js';
import { ViewTransform } from '../../render/transform.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
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

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const TOL = 1e-9;
const near = (actual: number, expected: number, tol = TOL): boolean =>
  Number.isFinite(actual) && Math.abs(actual - expected) <= tol;

const sample = (x: number, timeStamp: number): QuickScrollSample => ({ x, timeStamp });

function integrate(
  v0: number, dtMs: number, steps: number, stopAtThreshold = true,
): { sum: number; steps: number } {
  let sum = 0;
  let velocity = v0;
  for (let index = 0; index < steps; index++) {
    const step = flingStep(velocity, dtMs);
    sum += step.panCss;
    if (step.done && stopAtThreshold) return { sum, steps: index + 1 };
    velocity = stopAtThreshold ? step.velocity : velocity * Math.exp(-dtMs / QUICK_SCROLL_DECAY_MS);
  }
  return { sum, steps };
}

const unwindowedVelocity = (samples: readonly QuickScrollSample[]): number => {
  if (samples.length < 2) return 0;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return (last.x - first.x) / (last.timeStamp - first.timeStamp);
};

const absVelocity = (samples: readonly QuickScrollSample[], now: number): number =>
  Math.abs(releaseVelocity(samples, now));

const unguardedStep = (velocity: number, dtMs: number): number =>
  -velocity * QUICK_SCROLL_DECAY_MS * (1 - Math.exp(-dtMs / QUICK_SCROLL_DECAY_MS));

{
  check('the five motion constants are the PRD literals 100 / 0.5 / 325 / 0.02 / 3',
    QUICK_SCROLL_RECENT_MS === 100 && QUICK_SCROLL_MIN_SPEED === 0.5 &&
    QUICK_SCROLL_DECAY_MS === 325 && QUICK_SCROLL_STOP_SPEED === 0.02 &&
    QUICK_SCROLL_CLICK_SLOP === 3,
    `recent=${QUICK_SCROLL_RECENT_MS}, minSpeed=${QUICK_SCROLL_MIN_SPEED}, ` +
    `decay=${QUICK_SCROLL_DECAY_MS}, stop=${QUICK_SCROLL_STOP_SPEED}, ` +
    `slop=${QUICK_SCROLL_CLICK_SLOP}`);

  const constants: readonly number[] = [
    QUICK_SCROLL_RECENT_MS, QUICK_SCROLL_MIN_SPEED, QUICK_SCROLL_DECAY_MS,
    QUICK_SCROLL_STOP_SPEED, QUICK_SCROLL_CLICK_SLOP,
  ];
  const expected = [100, 0.5, 325, 0.02, 3];
  const mutated = expected.map((value) => (value === 325 ? 350 : value));
  check('control: the constant comparison is sensitive to any single mutated value',
    constants.every((value, index) => value === expected[index]) &&
    !mutated.every((value, index) => value === constants[index]),
    `actual=${constants.join(',')}, mutated=${mutated.join(',')}`);
}

{
  const right = releaseVelocity([sample(100, 1000), sample(200, 1045)], 1045);
  check('two samples over 45 ms give the plain 100/45 CSS px/ms speed',
    near(right, 2.2222222222222223), `velocity=${right}`);

  const left = releaseVelocity([sample(200, 1000), sample(100, 1045)], 1045);
  const absolute = absVelocity([sample(200, 1000), sample(100, 1045)], 1045);
  check('a leftward gesture reports a negative speed and the abs variant is the control',
    near(left, -2.2222222222222223) && near(absolute, 2.2222222222222223),
    `signed=${left}, absControl=${absolute}`);
}

{
  const inclusive = releaseVelocity([sample(100, 1045), sample(200, 1145)], 1145);
  const overWindow = releaseVelocity([sample(0, 0), sample(100, 100.01)], 100.01);
  const unwindowed = unwindowedVelocity([sample(0, 0), sample(100, 100.01)]);
  check('the 100 ms window is inclusive at exactly 100 ms and exclusive just past it',
    inclusive === 1 && overWindow === 0 && unwindowed !== 0,
    `inclusive=${inclusive}, at100.01=${overWindow}, unwindowedControl=${unwindowed}`);
}

{
  const samples = [sample(100, 900), sample(200, 1000), sample(300, 1045)];
  const windowed = releaseVelocity(samples, 1045);
  const unwindowed = unwindowedVelocity(samples);
  check('a sample older than the window is dropped so the window first/last pair decides',
    near(windowed, 2.2222222222222223) && near(unwindowed, 1.3793103448275863),
    `windowed=${windowed}, unwindowedControl=${unwindowed}`);
}

{
  const middling = releaseVelocity([sample(100, 1000), sample(140, 1020), sample(200, 1045)], 1045);
  const firstPair = (140 - 100) / (1020 - 1000);
  check('an inner sample never replaces the first/last endpoints of the window',
    near(middling, 2.2222222222222223) && !near(firstPair, middling),
    `windowed=${middling}, firstPairControl=${firstPair}`);
}

{
  const empty = releaseVelocity([], 1045);
  const single = releaseVelocity([sample(100, 1045)], 1045);
  const equalStamps = releaseVelocity([sample(100, 1040), sample(200, 1040)], 1045);
  const decreasing = releaseVelocity([sample(100, 1045), sample(200, 1000)], 1045);
  const equalStampsControl = (200 - 100) / (1040 - 1040);
  check('fewer than two samples, equal stamps, and decreasing stamps all report no motion',
    empty === 0 && single === 0 && equalStamps === 0 && decreasing === 0,
    `empty=${empty}, single=${single}, equal=${equalStamps}, decreasing=${decreasing}`);

  check('control: the missing dt > 0 guard divides by zero on equal stamps',
    !Number.isFinite(equalStampsControl), `unguarded=${equalStampsControl}`);
}

{
  const nanX = releaseVelocity([sample(0, 1000), sample(Number.NaN, 1045)], 1045);
  const nanNow = releaseVelocity([sample(100, 1000), sample(200, 1045)], Number.NaN);
  const infiniteStamp = releaseVelocity(
    [sample(100, 1000), sample(200, Number.POSITIVE_INFINITY)], Number.POSITIVE_INFINITY);
  const nanStamp = releaseVelocity([sample(100, Number.NaN), sample(200, 1045)], 1045);
  check('a non-finite x, clock, or timestamp yields 0 instead of NaN or Infinity',
    nanX === 0 && nanNow === 0 && infiniteStamp === 0 && nanStamp === 0,
    `nanX=${nanX}, nanNow=${nanNow}, infinite=${infiniteStamp}, nanStamp=${nanStamp}`);
}

{
  const rows: [number, number, boolean][] = [
    [3, 5, false],
    [3.0001, 5, true],
    [10, 0.5, true],
    [10, 0.4999, false],
    [10, -0.5, true],
    [0, 0, false],
    [-10, 5, false],
  ];
  const wrong = rows.filter(([travel, velocity, expected]) =>
    startsFling(travel, velocity) !== expected);
  check('startsFling needs > 3 CSS px of travel AND |v| >= 0.5 px/ms, either sign',
    wrong.length === 0, `wrong=${JSON.stringify(wrong)}`);

  const inclusiveControl = rows.filter(([travel, velocity, expected]) => {
    const passes = travel >= QUICK_SCROLL_CLICK_SLOP && Math.abs(velocity) >= QUICK_SCROLL_MIN_SPEED;
    return passes !== expected;
  });
  const noSpeedControl = rows.filter(([travel, velocity, expected]) => {
    const passes = travel > QUICK_SCROLL_CLICK_SLOP && Math.abs(velocity) >= 0;
    return passes !== expected;
  });
  check('control: an inclusive slop admits the dead 3 px tap',
    inclusiveControl.length === 1 && JSON.stringify(inclusiveControl[0]?.slice(0, 2)) === '[3,5]',
    `flagged=${JSON.stringify(inclusiveControl)}`);

  check('control: dropping the speed threshold admits a 0.4999 px/ms release',
    noSpeedControl.length === 1 && JSON.stringify(noSpeedControl[0]?.slice(0, 2)) === '[10,0.4999]',
    `flagged=${JSON.stringify(noSpeedControl)}`);
}

{
  const invalid: [number, number][] = [
    [10, Number.NaN], [10, Number.POSITIVE_INFINITY], [Number.NaN, 5],
    [Number.POSITIVE_INFINITY, 5], [Number.NEGATIVE_INFINITY, 5],
  ];
  check('a non-finite travel or speed never starts a fling',
    invalid.every(([travel, velocity]) => !startsFling(travel, velocity)),
    `results=${invalid.map(([t, v]) => String(startsFling(t, v))).join(',')}`);
}

{
  const full = flingStep(5, 325);
  const half = flingStep(5, 100);
  check('one 325 ms step pans -1027.1959080964061 CSS px and leaves 1.8393972058572117 px/ms',
    near(full.panCss, -1027.1959080964061) && near(full.velocity, 1.8393972058572117) &&
    full.done === false,
    `pan=${full.panCss}, velocity=${full.velocity}, done=${full.done}`);

  check('a 100 ms step pans -430.3950940385127 CSS px and leaves 3.6757074029584222 px/ms',
    near(half.panCss, -430.3950940385127) && near(half.velocity, 3.6757074029584222),
    `pan=${half.panCss}, velocity=${half.velocity}`);

  const noTau = -5 * (1 - Math.exp(-325 / QUICK_SCROLL_DECAY_MS));
  const linearTau = -5 * 100;
  check('control: dropping the 325 ms factor from the distance misses the literal',
    !near(noTau, full.panCss) && !near(linearTau, half.panCss),
    `noTau=${noTau}, linear=${linearTau}`);
}

{
  const leftward = flingStep(-0.8, 10);
  const signTable = [0.5, 2, 5, 12].map((velocity) => flingStep(velocity, 7));
  const signLeftward = [-0.5, -2, -5, -12].map((velocity) => flingStep(velocity, 7));
  check('the pan always opposes the release direction, so a leftward fling pans right',
    leftward.panCss > 0 && near(leftward.panCss, 7.8781757535784198) &&
    signTable.every((step) => step.panCss < 0) &&
    signLeftward.every((step) => step.panCss > 0),
    `leftward=${leftward.panCss}, right=${signTable.map((s) => s.panCss).join(',')}, ` +
    `left=${signLeftward.map((s) => s.panCss).join(',')}`);

  const noMinus = 5 * QUICK_SCROLL_DECAY_MS * (1 - Math.exp(-7 / QUICK_SCROLL_DECAY_MS));
  check('control: dropping the minus sign pans with the release instead of against it',
    noMinus > 0 && flingStep(5, 7).panCss < 0 && !near(noMinus, flingStep(5, 7).panCss),
    `noMinus=${noMinus}, real=${flingStep(5, 7).panCss}`);
}

{
  const decays: number[] = [];
  let velocity = 6;
  for (let index = 0; index < 6; index++) {
    const step = flingStep(velocity, 60);
    decays.push(Math.abs(step.panCss));
    velocity = step.velocity;
  }
  const strictlyDown = decays.every((value, index) => index === 0 || value < decays[index - 1]!);
  check('equal frame intervals produce strictly shrinking and visibly decaying steps',
    strictlyDown && decays[0]! > decays[5]! * 1.5 && decays[0]! < 400,
    `magnitudes=${decays.map((v) => v.toFixed(4)).join(',')}`);
}

{
  const still = flingStep(5, 0);
  const slow = flingStep(0.01, 0);
  check('a zero-length frame pans exactly 0 (not -0) and keeps the speed',
    still.panCss === 0 && Object.is(still.panCss, 0) && still.velocity === 5 &&
    still.done === false && slow.panCss === 0 && slow.done === true && slow.velocity === 0,
    `pan=${still.panCss} (isZero=${Object.is(still.panCss, 0)}), velocity=${still.velocity}, ` +
    `slowDone=${slow.done}`);
}

{
  const negative = flingStep(5, -10);
  const nan = flingStep(5, Number.NaN);
  const infinite = flingStep(5, Number.POSITIVE_INFINITY);
  const unguarded = unguardedStep(5, -10);
  check('a negative or non-finite interval is treated as zero elapsed time',
    negative.panCss === 0 && negative.velocity === 5 && negative.done === false &&
    nan.panCss === 0 && nan.velocity === 5 && infinite.panCss === 0 && infinite.velocity === 5,
    `negative=${negative.panCss}/${negative.velocity}, nan=${nan.panCss}, ` +
    `infinite=${infinite.panCss}, unguardedControl=${unguarded}`);

  check('control: an unguarded exp() turns a negative interval into a forward pan',
    unguarded > 50, `unguarded=${unguarded}`);
}

{
  const huge = flingStep(5, 1e9);
  check('a backgrounded tab saturates at -v*325 CSS px instead of Infinity',
    huge.panCss === -1625 && huge.done === true && huge.velocity === 0,
    `pan=${huge.panCss}, done=${huge.done}, velocity=${huge.velocity}`);
}

{
  const atThreshold = flingStep(QUICK_SCROLL_STOP_SPEED, 0);
  const belowAfterOne = flingStep(QUICK_SCROLL_STOP_SPEED, 1);
  const negativeAtThreshold = flingStep(-QUICK_SCROLL_STOP_SPEED, 1);
  const negativeAbove = flingStep(-0.03, 1);
  check('the stop speed is exclusive: 0.02 px/ms keeps running, one frame later it stops',
    atThreshold.done === false && atThreshold.velocity === 0.02 &&
    belowAfterOne.done === true && belowAfterOne.velocity === 0 &&
    near(belowAfterOne.panCss, -0.019969262303155322),
    `atThreshold=${atThreshold.done}/${atThreshold.velocity}, ` +
    `after1ms=${belowAfterOne.done}/${belowAfterOne.panCss}`);

  check('the stop threshold is symmetric and 0.03 px/ms still runs',
    negativeAtThreshold.done === true && negativeAtThreshold.velocity === 0 &&
    negativeAbove.done === false && near(negativeAbove.velocity, -0.029907834173985435),
    `negAt=${negativeAtThreshold.done}, negAbove=${negativeAbove.velocity}/${negativeAbove.done}`);

  const inclusiveStop = Math.abs(0.02 * Math.exp(0)) <= QUICK_SCROLL_STOP_SPEED;
  check('control: an inclusive comparison would stop a 0.02 px/ms fling that must keep going',
    inclusiveStop === true && atThreshold.done === false &&
    Math.abs(0.02) >= QUICK_SCROLL_STOP_SPEED,
    `inclusiveWouldStop=${inclusiveStop}, realDone=${atThreshold.done}`);
}

{
  const zero = flingStep(0, 16);
  const negativeZero = flingStep(-0, 16);
  const nan = flingStep(Number.NaN, 16);
  const infinite = flingStep(Number.POSITIVE_INFINITY, 16);
  const negativeInfinite = flingStep(Number.NEGATIVE_INFINITY, 16);
  const all = [zero, negativeZero, nan, infinite, negativeInfinite];
  check('a zero or non-finite speed is already finished with no pan',
    all.every((step) => step.panCss === 0 && step.velocity === 0 && step.done === true) &&
    Object.is(zero.panCss, 0) && Object.is(negativeZero.panCss, 0),
    `steps=${all.map((s) => `${s.panCss}/${s.velocity}/${s.done}`).join(',')}`);
}

{
  const oneMs = integrate(3, 1, 100).sum;
  const tenMs = integrate(3, 10, 10).sum;
  const hundredMs = integrate(3, 100, 1).sum;
  check('100 ms of decay telescopes: 100x1 ms, 10x10 ms and 1x100 ms agree within 1e-9',
    near(oneMs, -258.23705642310478, 1e-9) && near(tenMs, oneMs, 1e-9) &&
    near(hundredMs, oneMs, 1e-9),
    `1ms=${oneMs}, 10ms=${tenMs}, 100ms=${hundredMs}, ` +
    `spread=${Math.abs(oneMs - hundredMs)}`);

  check('control: the linear model lands on -300 CSS px instead of -258.237',
    !near(-3 * 100, oneMs, 1) && Math.abs(-3 * 100 - oneMs) > 40,
    `linear=${-3 * 100}, closedForm=${oneMs}`);
}

{
  const at60 = integrate(12, 1000 / 60, 60).sum;
  const at144 = integrate(12, 1000 / 144, 144).sum;
  check('one second of travel is identical at 60 Hz and 144 Hz within 1e-9',
    near(at60, at144, 1e-9) && near(at60, -3720.2065386394502, 1e-8),
    `60Hz=${at60}, 144Hz=${at144}, diff=${Math.abs(at60 - at144)}`);
}

{
  const midpoints = 200_000;
  const h = QUICK_SCROLL_DECAY_MS / midpoints;
  let quadrature = 0;
  for (let index = 0; index < midpoints; index++) {
    quadrature += 3 * Math.exp(-((index + 0.5) * h) / QUICK_SCROLL_DECAY_MS) * h;
  }
  const closedForm = -flingStep(3, QUICK_SCROLL_DECAY_MS).panCss;
  check('the closed form matches a 200 000-midpoint quadrature of v0*e^(-t/325) within 1e-6',
    near(quadrature, closedForm, 1e-6) && near(closedForm, 616.3175448578437, 1e-9),
    `quadrature=${quadrature}, closedForm=${closedForm}, ` +
    `diff=${Math.abs(quadrature - closedForm)}`);

  check('control: the constant-speed integral differs from the quadrature by more than 1',
    Math.abs(-3 * QUICK_SCROLL_DECAY_MS - quadrature) > 1,
    `linear=${-3 * QUICK_SCROLL_DECAY_MS}, quadrature=${quadrature}`);
}

{
  const bounds = [0.5, 3, 12].map((v0) => {
    const stopped = integrate(v0, 1000 / 60, 100_000);
    const magnitude = Math.abs(stopped.sum);
    const unstopped = Math.abs(integrate(v0, 1000 / 60, 100_000, false).sum);
    return {
      v0,
      magnitude,
      low: (v0 - QUICK_SCROLL_STOP_SPEED) * QUICK_SCROLL_DECAY_MS,
      high: v0 * QUICK_SCROLL_DECAY_MS,
      unstopped,
      steps: stopped.steps,
    };
  });
  check('total travel stops inside ((v0-0.02)*325, v0*325) for slow, medium and fast releases',
    bounds.every((row) => row.magnitude > row.low && row.magnitude < row.high),
    bounds.map((row) => `${row.v0}:${row.magnitude.toFixed(4)} in ` +
      `(${row.low.toFixed(2)},${row.high.toFixed(2)})@${row.steps}f`).join(' '));

  check('control: without the stop rule the same integration overshoots the bounded travel',
    bounds.every((row) => row.unstopped > row.magnitude + 1),
    bounds.map((row) => `${row.v0}:${row.unstopped.toFixed(4)}>${row.magnitude.toFixed(4)}`)
      .join(' '));
}

{
  const withDpr = new ViewTransform(1600, 0, 1600);
  withDpr.panPixels(-12.5 * 2);
  const dprFree = new ViewTransform(1600, 0, 1600);
  dprFree.panPixels(-12.5);
  check('multiplying the CSS-pixel pan by DPR=2 moves the viewport by exactly 25 samples',
    withDpr.start === -25 && withDpr.end === 1575 && dprFree.start === -12.5,
    `withDpr=${withDpr.start}..${withDpr.end}, dprFreeControl=${dprFree.start}`);

  const step = flingStep(2, 100).panCss;
  const real = new ViewTransform(1600, 0, 1600);
  real.panPixels(step * 2);
  const realFree = new ViewTransform(1600, 0, 1600);
  realFree.panPixels(step);
  check('a real fling step lands on exactly twice the DPR-free distance',
    near(step, -172.15803761540508) && near(real.start, step * 2) &&
    near(real.start, -344.31607523081016) && near(realFree.start, step),
    `panCss=${step}, dpr2=${real.start}, dpr1=${realFree.start}`);
}

{
  const source = fs.readFileSync('src/ui/quickScroll.ts', 'utf8');
  const forbidden = ['requestAnimationFrame', 'window', 'document', 'performance',
    'addEventListener', 'devicePixelRatio', 'setTimeout', 'setInterval', 'navigator',
    'Math.random', 'Date.now'];
  const scan = (text: string): string[] => forbidden.filter((token) => text.includes(token));
  const hits = scan(source);
  check('the motion model is DOM-free, scheduler-free, and import-free',
    hits.length === 0 && !source.includes('import ') && !source.includes('export {'),
    `hits=${JSON.stringify(hits)}, import=${source.includes('import ')}`);

  const injected = forbidden.map((token) => scan(`${source}\nconst extra = ${token};`).length);
  check('control: the purity scanner flags every injected browser token',
    injected.every((count) => count === 1), `counts=${injected.join(',')}`);

  const commentLines = source.split('\n').filter((line) => line.includes('//'));
  check('the motion model carries the SPDX line and no other comment',
    source.startsWith('// SPDX-License-Identifier: GPL-3.0-or-later') &&
    commentLines.length === 1 && !source.includes('/*'),
    `lines=${commentLines.length}, blockComment=${source.includes('/*')}`);
}

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const scheduleCount = (text: string): number =>
    (text.match(/requestAnimationFrame\(/g) ?? []).length;
  check('the app still schedules exactly one animation frame callback',
    scheduleCount(app) === 1, `count=${scheduleCount(app)}`);

  check('control: the counter sees an injected second frame loop',
    scheduleCount(`${app}\nrequestAnimationFrame(this.frame);`) === 2,
    `injected=${scheduleCount(`${app}\nrequestAnimationFrame(this.frame);`)}`);

  const quickScrollSource = fs.readFileSync('src/ui/quickScroll.ts', 'utf8');
  check('the fling math never schedules work of its own',
    !/requestAnimationFrame|setInterval|setTimeout/.test(quickScrollSource),
    'a fling-owned loop would double the pan rate');
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
