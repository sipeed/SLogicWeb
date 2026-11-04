// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic tests for the pure session/view-policy core. Runs under node through the
 * standard `*-selftest.ts` bundle pattern; no DOM, no device and no dependencies.
 */

import {
  RANGE_FIT_EPSILON, beginSweep, createSession, manualView, resolveSessionView, resolveView,
  samplesRangeToSeconds, samplesToSeconds, secondsRangeFits, secondsRangeToSamples,
  secondsToSamples, sessionAfterTrigger, sessionDefaultView, sessionFallbackView,
  sessionSweepPattern, sessionWithManualView, triggerLockedView, triggerSearchSamples,
  viewAfterTrigger, viewFitsRetained, viewRangeSeconds,
  type CaptureMode, type SecondsRange, type ViewPolicy,
} from '../captureSession.js';

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

const EPSILON = 1e-12;
function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}
function sameRange(a: SecondsRange, b: SecondsRange): boolean {
  return close(a.startSec, b.startSec) && close(a.endSec, b.endSec);
}
function rangeText(range: SecondsRange): string {
  return `[${range.startSec}, ${range.endSec}]`;
}
function kind(policy: ViewPolicy): string {
  return policy.kind;
}

// --- New sessions ---------------------------------------------------------------

{
  const modes: CaptureMode[] = ['single', 'repeat', 'loop'];
  const defaults = modes.map((mode) => kind(sessionDefaultView(mode))).join(',');
  const empty = createSession('repeat');
  const touched = sessionWithManualView(empty, -0.01, 0.02);
  const reset = createSession('repeat');
  check('every new session defaults to FollowLive and a new session drops a fixed view',
    defaults === 'follow,follow,follow' && empty.sweepIndex === 0 &&
    kind(empty.policy) === 'follow' && touched.policy.kind === 'fixed' &&
    kind(reset.policy) === 'follow' && reset.sweepIndex === 0,
    `defaults=${defaults}, touched=${kind(touched.policy)}, reset=${kind(reset.policy)}`);
}

{
  const patterns: CaptureMode[] = ['single', 'repeat', 'loop'];
  const actual = patterns.map(sessionSweepPattern).join(',');
  check('Single owns one sweep, Repeat many, Loop one continuous sweep',
    actual === 'one-sweep,multi-sweep,continuous', actual);
}

// --- Manual pan/zoom -> fixed ---------------------------------------------------

{
  const forward = manualView(0.002, 0.007);
  const reversed = manualView(0.007, 0.002);
  const empty = manualView(0.003, 0.003);
  const broken = manualView(Number.NaN, 0.01);
  const forwardFixed = forward.kind === 'fixed' ? forward : null;
  const reversedFixed = reversed.kind === 'fixed' ? reversed : null;
  check('a manual gesture stores a normalized fixed interval and rejects unusable ones',
    forwardFixed !== null && reversedFixed !== null &&
    forwardFixed.startSec === 0.002 && forwardFixed.endSec === 0.007 &&
    reversedFixed.startSec === 0.002 && reversedFixed.endSec === 0.007 &&
    kind(empty) === 'follow' && kind(broken) === 'follow',
    `forward=${forwardFixed && rangeText(forwardFixed)}, reversed=${reversedFixed && rangeText(reversedFixed)}, ` +
    `empty=${kind(empty)}, broken=${kind(broken)}`);
}

// --- Loop trigger match -> triggerLocked ----------------------------------------

{
  const matched = viewAfterTrigger({ kind: 'follow' }, 'loop', 0.1);
  const clampedHigh = viewAfterTrigger({ kind: 'follow' }, 'loop', 1.7);
  const clampedLow = viewAfterTrigger({ kind: 'follow' }, 'loop', Number.NaN);
  const resolved = resolveView(matched, 'loop', {
    triggerActive: true, retained: { startSec: -0.001, endSec: 0.009 },
  });
  check('a matched Loop trigger locks FollowLive on T at the configured fraction',
    matched.kind === 'triggerLocked' && close(matched.fraction, 0.1) &&
    clampedHigh.kind === 'triggerLocked' && close(clampedHigh.fraction, 1) &&
    clampedLow.kind === 'triggerLocked' && close(clampedLow.fraction, 0) &&
    resolved.kind === 'triggerLocked' && close(resolved.fraction, 0.1),
    `matched=${kind(matched)}, high=${clampedHigh.kind === 'triggerLocked' ? clampedHigh.fraction : '?'}, ` +
    `low=${clampedLow.kind === 'triggerLocked' ? clampedLow.fraction : '?'}, resolved=${kind(resolved)}`);
}

{
  const manual = manualView(-0.01, 0.02);
  const afterManual = viewAfterTrigger(manual, 'loop', 0.5);
  const single = viewAfterTrigger({ kind: 'follow' }, 'single', 0.5);
  const repeat = viewAfterTrigger(manualView(0, 1), 'repeat', 0.5);
  check('a Loop trigger does not steal a manual view, and Single/Repeat never lock',
    kind(afterManual) === 'fixed' && kind(single) === 'follow' && kind(repeat) === 'fixed',
    `loopAfterManual=${kind(afterManual)}, single=${kind(single)}, repeat=${kind(repeat)}`);
}

// --- Unmatched or expired Loop trigger stays follow ------------------------------

{
  const retention: SecondsRange = { startSec: -0.001, endSec: 0.009 };
  const unmatched = resolveView({ kind: 'follow' }, 'loop', {
    triggerActive: false, retained: retention,
  });
  const expired = resolveView(triggerLockedView(0.1), 'loop', {
    triggerActive: false, retained: retention,
  });
  const cannotLock = resolveView(triggerLockedView(0.1), 'single', {
    triggerActive: true, retained: retention,
  });
  check('a Loop with no match stays FollowLive, an expired lock releases, and non-Loop cannot lock',
    kind(unmatched) === 'follow' && kind(expired) === 'follow' && kind(cannotLock) === 'follow',
    `unmatched=${kind(unmatched)}, expired=${kind(expired)}, single=${kind(cannotLock)}`);
}

// --- Fixed persists across Repeat sweeps within a session ------------------------

{
  const first = sessionWithManualView(createSession('repeat'), -0.01, 0.04);
  const sweep1 = resolveSessionView(first, {
    triggerActive: false, retained: { startSec: -0.02, endSec: 0.09 },
  });
  const afterBoundary = beginSweep(sweep1.session);
  const sweep2 = resolveSessionView(afterBoundary, {
    triggerActive: false, retained: { startSec: -0.01, endSec: 0.04 },
  });
  const afterSecond = beginSweep(sweep2.session);
  check('a fixed view survives Repeat sweep boundaries while it still fits',
    kind(sweep1.policy) === 'fixed' && kind(sweep2.policy) === 'fixed' &&
    sameRange(sweep1.view, { startSec: -0.01, endSec: 0.04 }) &&
    sameRange(sweep2.view, { startSec: -0.01, endSec: 0.04 }) &&
    first.sweepIndex === 0 && afterBoundary.sweepIndex === 1 && afterSecond.sweepIndex === 2,
    `sweep1=${kind(sweep1.policy)}, sweep2=${kind(sweep2.policy)}, ` +
    `view=${rangeText(sweep2.view)}, sweeps=${afterSecond.sweepIndex}`);
}

// --- Fixed out of range -> mode fallback, no automatic Fit -----------------------

{
  const fixed = manualView(2, 3);
  const outside: SecondsRange = { startSec: 0, endSec: 1 };
  const single = resolveView(fixed, 'single', {
    triggerActive: true, retained: outside, fraction: 0.1,
  });
  const repeat = resolveView(fixed, 'repeat', {
    triggerActive: false, retained: outside, fraction: 0.1,
  });
  const loopIdle = resolveView(fixed, 'loop', {
    triggerActive: false, retained: outside, fraction: 0.1,
  });
  const loopArmed = resolveView(fixed, 'loop', {
    triggerActive: true, retained: outside, fraction: 0.1,
  });
  const notFitted = viewRangeSeconds(fixed, outside);
  const fallbackView = viewRangeSeconds(loopArmed, outside);
  check('an out-of-range fixed view falls back per mode without clamping the interval',
    kind(single) === 'follow' && kind(repeat) === 'follow' && kind(loopIdle) === 'follow' &&
    loopArmed.kind === 'triggerLocked' && close(loopArmed.fraction, 0.1) &&
    sameRange(notFitted, { startSec: 2, endSec: 3 }) &&
    sameRange(fallbackView, { startSec: -0.1, endSec: 0.9 }),
    `single=${kind(single)}, repeat=${kind(repeat)}, idle=${kind(loopIdle)}, armed=${kind(loopArmed)}, ` +
    `fixedRange=${rangeText(notFitted)}, fallbackRange=${rangeText(fallbackView)}`);
}

{
  const fixed = manualView(2, 3);
  const rejected = resolveSessionView(sessionWithManualView(createSession('repeat'), 2, 3), {
    triggerActive: false, retained: { startSec: 0, endSec: 1 },
  });
  const later = resolveSessionView(beginSweep(rejected.session), {
    triggerActive: false, retained: { startSec: 0, endSec: 4 },
  });
  check('a fallback is durable: an old fixed interval is not revived by a later sweep',
    kind(rejected.policy) === 'follow' && kind(later.policy) === 'follow' &&
    sameRange(later.view, { startSec: 0, endSec: 4 }) && fixed.kind === 'fixed',
    `rejected=${kind(rejected.policy)}, later=${kind(later.policy)}, laterView=${rangeText(later.view)}`);
}

// --- Trigger lock geometry and negative pre-trigger time -------------------------

{
  const retained: SecondsRange = { startSec: -0.001, endSec: 0.009 };
  const left = viewRangeSeconds(triggerLockedView(0), retained);
  const configured = viewRangeSeconds(triggerLockedView(0.1), retained);
  const middle = viewRangeSeconds(triggerLockedView(0.5), retained);
  const right = viewRangeSeconds(triggerLockedView(1), retained);
  const reversed = viewRangeSeconds(triggerLockedView(0.1), {
    startSec: retained.endSec, endSec: retained.startSec,
  });
  const broken = viewRangeSeconds(triggerLockedView(0.1), {
    startSec: Number.NaN, endSec: 0.009,
  });
  check('a trigger-locked view puts T=0 at the fraction and keeps pre-trigger time negative',
    sameRange(left, { startSec: 0, endSec: 0.01 }) &&
    sameRange(configured, { startSec: -0.001, endSec: 0.009 }) &&
    sameRange(middle, { startSec: -0.005, endSec: 0.005 }) &&
    sameRange(right, { startSec: -0.01, endSec: 0 }) &&
    sameRange(reversed, configured) &&
    sameRange(broken, { startSec: 0, endSec: 0 }),
    `0%=${rangeText(left)}, 10%=${rangeText(configured)}, 50%=${rangeText(middle)}, ` +
    `100%=${rangeText(right)}, broken=${rangeText(broken)}`);
}

// --- Containment and follow/fixed view ranges ------------------------------------

{
  const retained: SecondsRange = { startSec: -0.001, endSec: 0.009 };
  const inside = secondsRangeFits({ startSec: -0.0005, endSec: 0.004 }, retained);
  const before = secondsRangeFits({ startSec: -0.002, endSec: 0.004 }, retained);
  const after = secondsRangeFits({ startSec: 0.005, endSec: 0.02 }, retained);
  const reversed = secondsRangeFits({ startSec: 1, endSec: 0 }, retained);
  const empty = secondsRangeFits({ startSec: 0, endSec: 0 }, retained);
  const broken = secondsRangeFits({ startSec: Number.NaN, endSec: 1 }, retained);
  check('containment is inclusive and rejects reversed, empty and non-finite ranges',
    inside && !before && !after && !reversed && !empty && !broken,
    `inside=${inside}, before=${before}, after=${after}, reversed=${reversed}, empty=${empty}, broken=${broken}`);
}

{
  const tolerant = secondsRangeFits({ startSec: 0, endSec: 1 },
    { startSec: 1e-10, endSec: 1 - 1e-10 });
  const strict = secondsRangeFits({ startSec: 0, endSec: 1 },
    { startSec: 1e-10, endSec: 1 - 1e-10 }, 0);
  const excluded = secondsRangeFits({ startSec: 0, endSec: 1 }, { startSec: 0.5, endSec: 1.5 });
  check('range fit allows a small boundary tolerance and can be checked exactly on request',
    RANGE_FIT_EPSILON > 0 && tolerant && !strict && !excluded,
    `epsilon=${RANGE_FIT_EPSILON}, tolerant=${tolerant}, strict=${strict}, excluded=${excluded}`);
}

{
  const retained: SecondsRange = { startSec: -2, endSec: 3 };
  const fixed = manualView(2, 3);
  const followFits = viewFitsRetained({ kind: 'follow' }, { startSec: 9, endSec: 10 });
  const lockFits = viewFitsRetained(triggerLockedView(0.1), { startSec: 9, endSec: 10 });
  const fixedFits = viewFitsRetained(fixed, retained);
  const fixedMisses = viewFitsRetained(fixed, { startSec: 0, endSec: 1 });
  const followRange = viewRangeSeconds({ kind: 'follow' }, retained);
  const fixedRange = viewRangeSeconds(fixed, { startSec: 0, endSec: 1 });
  check('follow shows the retained range and fixed returns its stored interval without fitting',
    followFits && lockFits && fixedFits && !fixedMisses &&
    sameRange(followRange, retained) && sameRange(fixedRange, { startSec: 2, endSec: 3 }),
    `followFits=${followFits}, lockFits=${lockFits}, fixedFits=${fixedFits}, fixedMisses=${fixedMisses}, ` +
    `followRange=${rangeText(followRange)}, fixedRange=${rangeText(fixedRange)}`);
}

// --- Seconds <-> samples at different samplerates --------------------------------

{
  const mega = [
    secondsToSamples(0.001, 1e6),
    secondsToSamples(-2.5e-4, 16e6),
    secondsToSamples(1 / (3e6), 3e6),
    secondsToSamples(-0.5 / 1e6, 1e6),
    samplesToSeconds(-4000, 16e6),
  ];
  const giga = secondsRangeToSamples({ startSec: -1e-9, endSec: 2e-9 }, 1e9);
  const back = samplesRangeToSeconds({ start: -1000, end: 2000 }, 1e6);
  const invalid = [
    secondsToSamples(1, 0),
    secondsToSamples(Number.NaN, 1e6),
    samplesToSeconds(5, -1),
    samplesToSeconds(Number.POSITIVE_INFINITY, 1e6),
  ];
  check('seconds convert to nearest samples at 1 MHz, 3 MHz, 1 GHz and preserve negative time',
    mega[0] === 1000 && mega[1] === -4000 && mega[2] === 1 && mega[3] === 0 &&
    close(mega[4]!, -0.00025) &&
    giga.start === -1 && giga.end === 2 &&
    close(back.startSec, -0.001) && close(back.endSec, 0.002) &&
    invalid.every((value) => value === 0),
    `mega=${mega.join(',')}, giga=${giga.start}:${giga.end}, back=${back.startSec}:${back.endSec}, ` +
    `invalid=${invalid.join(',')}`);
}

// --- Session trigger transition and sweep bookkeeping ----------------------------

{
  let session = createSession('loop');
  const started = beginSweep(session);
  session = sessionAfterTrigger(started, 0.25);
  const locked = session.policy.kind === 'triggerLocked' ? session.policy : null;
  const fallback = sessionFallbackView('loop', true, 0.25);
  const fallbackIdle = sessionFallbackView('loop', false, 0.25);
  const fallbackSingle = sessionFallbackView('single', true, 0.25);
  check('a session records the Loop match across its single sweep; fallbacks are mode-aware',
    locked !== null && close(locked.fraction, 0.25) && session.sweepIndex === 1 &&
    fallback.kind === 'triggerLocked' && close(fallback.fraction, 0.25) &&
    kind(fallbackIdle) === 'follow' && kind(fallbackSingle) === 'follow',
    `locked=${locked ? locked.fraction : '?'}, sweep=${session.sweepIndex}, ` +
    `fallback=${kind(fallback)}, idle=${kind(fallbackIdle)}, single=${kind(fallbackSingle)}`);
}

{
  // B1 is only reachable if the Repeat matcher has a finite search allowance. Single
  // waits for its one trigger and Loop is unbounded; both stay Infinity.
  const repeat = triggerSearchSamples('repeat', 2_500_000);
  const repeatEmpty = triggerSearchSamples('repeat', 0);
  check('only Repeat gets a finite one-sweep trigger search allowance',
    repeat === 2_500_000 && repeatEmpty === Number.POSITIVE_INFINITY &&
    triggerSearchSamples('single', 2_500_000) === Number.POSITIVE_INFINITY &&
    triggerSearchSamples('loop', 2_500_000) === Number.POSITIVE_INFINITY,
    `repeat=${repeat}, empty=${repeatEmpty}, ` +
    `single=${triggerSearchSamples('single', 2_500_000)}, ` +
    `loop=${triggerSearchSamples('loop', 2_500_000)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
