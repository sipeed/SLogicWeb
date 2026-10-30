// SPDX-License-Identifier: GPL-3.0-or-later

import {
  DEFAULT_CAPTURE_SECONDS, MIN_CAPTURE_SECONDS, REPEAT_INTERVAL_SECONDS,
  captureSecondsFromTime, captureTimeFromSeconds, clampCaptureSeconds, clampRepeatIntervalSeconds,
  maxCaptureSeconds, maxCaptureTimeValue, minCaptureTimeValue,
  repeatIntervalSecondsFromTime, repeatIntervalTimeFromSeconds,
} from '../captureTime.js';
import {
  DEFAULT_TIME_UNIT, TIME_UNITS, isPositiveInteger, isTimeUnit, maxTimeValue, minTimeValue,
  secondsFromTimeValue, timeUnitForRange, timeUnitSeconds, timeValueFromSeconds,
} from '../timeUnits.js';
import { capturePostTriggerSamples } from '../capturePolicy.js';
import { defaultCaptureSettings } from '../state.js';

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

check('time units are us, ms and s with ms as the shared default',
  TIME_UNITS.join(',') === 'us,ms,s' && DEFAULT_TIME_UNIT === 'ms' &&
  isTimeUnit('us') && isTimeUnit('ms') && isTimeUnit('s') && !isTimeUnit('min') &&
  timeUnitSeconds('us') === 1e-6 && timeUnitSeconds('ms') === 1e-3 && timeUnitSeconds('s') === 1,
  `units=${TIME_UNITS.join(',')}, default=${DEFAULT_TIME_UNIT}`);

{
  const invalid = [0, -0, -1, 1.5, 0.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const rejected = invalid.every((value) => !isPositiveInteger(value) &&
    secondsFromTimeValue(value, 'ms', 0.001, 10) === null);
  const accepted = isPositiveInteger(1) && isPositiveInteger(Number.MAX_SAFE_INTEGER);
  const badRanges = [0, -1, Number.NaN, Number.POSITIVE_INFINITY].every((min) =>
    timeValueFromSeconds(1, 's', min, 10) === null &&
    secondsFromTimeValue(1, 's', min, 10) === null);
  const badCanonical = timeValueFromSeconds(Number.POSITIVE_INFINITY, 'ms', 0.001, 1) === null &&
    timeValueFromSeconds(Number.NaN, 'ms', 0.001, 1) === null;
  check('zero, negative, fractional and non-finite editor values cannot produce time',
    rejected && accepted && badRanges && badCanonical && secondsFromTimeValue(1, 's', 2, 1) === null,
    `invalid=${invalid.length}, acceptedPositiveIntegers=${accepted}, badRanges=${badRanges}, ` +
    `badCanonical=${badCanonical}`);
}

{
  const rate = 16e6;
  const expectedMax = (2 ** 31 - 1) / rate;
  const maxima = maxCaptureSeconds(rate) === expectedMax &&
    maxCaptureTimeValue(rate, 's') === 134 && maxCaptureTimeValue(rate, 'ms') === 134217 &&
    maxCaptureTimeValue(rate, 'us') === 134217727;
  const minima = minCaptureTimeValue('s') === 1 && minCaptureTimeValue('ms') === 1 &&
    minCaptureTimeValue('us') === 1000 && minTimeValue(0.0015, 'ms') === 2 &&
    minTimeValue(0.0015, 'us') === 1500 && minTimeValue(0.0015, 's') === 1;
  const defaults = captureTimeFromSeconds(1, 's', rate) === 1 &&
    captureTimeFromSeconds(1, 'ms', rate) === 1000 && captureTimeFromSeconds(1, 'us', rate) === 1_000_000;
  const subSecond = captureSecondsFromTime(100, 'ms', rate) === 0.1 &&
    captureSecondsFromTime(100_000, 'us', rate) === 0.1;
  check('finite capture bounds and positive-integer conversions derive from the real sample ceiling',
    maxima && minima && defaults && subSecond,
    `max=${expectedMax}, maxima=${maxima}, minima=${minima}, defaults=${defaults}, 100ms=${subSecond}`);
}

{
  const rate = 16e6;
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
  const rejected = invalid.every((value) => captureSecondsFromTime(value, 'ms', rate) === null);
  const below = captureSecondsFromTime(1, 'us', rate) === MIN_CAPTURE_SECONDS;
  const above = captureSecondsFromTime(Number.MAX_SAFE_INTEGER, 's', rate) === 134;
  const clamps = clampCaptureSeconds(Number.NaN, rate) === DEFAULT_CAPTURE_SECONDS &&
    clampCaptureSeconds(Number.POSITIVE_INFINITY, rate) === maxCaptureSeconds(rate) &&
    clampCaptureSeconds(Number.NEGATIVE_INFINITY, rate) === MIN_CAPTURE_SECONDS &&
    clampCaptureSeconds(0, rate) === MIN_CAPTURE_SECONDS &&
    clampCaptureSeconds(1e9, rate) === maxCaptureSeconds(rate);
  check('finite capture commits clamp to 1 ms and the rate-derived maximum without accepting bad drafts',
    rejected && below && above && clamps,
    `rejected=${rejected}, below=${below}, above=${above}, clamps=${clamps}`);
}

{
  const bounds = minTimeValue(REPEAT_INTERVAL_SECONDS.min, 'ms') === 100 &&
    maxTimeValue(REPEAT_INTERVAL_SECONDS.max, 'ms') === 10_000 &&
    minTimeValue(REPEAT_INTERVAL_SECONDS.min, 'us') === 100_000 &&
    maxTimeValue(REPEAT_INTERVAL_SECONDS.max, 'us') === 10_000_000 &&
    minTimeValue(REPEAT_INTERVAL_SECONDS.min, 's') === 1 &&
    maxTimeValue(REPEAT_INTERVAL_SECONDS.max, 's') === 10;
  const exact = repeatIntervalTimeFromSeconds(0.1, 'ms') === 100 &&
    repeatIntervalSecondsFromTime(100, 'ms') === 0.1 &&
    repeatIntervalTimeFromSeconds(0.1, 'us') === 100_000 &&
    repeatIntervalSecondsFromTime(100_000, 'us') === 0.1;
  const clamps = clampRepeatIntervalSeconds(Number.NaN) === 1 &&
    clampRepeatIntervalSeconds(0) === 0.1 && clampRepeatIntervalSeconds(11) === 10 &&
    clampRepeatIntervalSeconds(Number.POSITIVE_INFINITY) === 10 &&
    clampRepeatIntervalSeconds(Number.NEGATIVE_INFINITY) === 0.1;
  const rejected = repeatIntervalSecondsFromTime(0.5, 's') === null &&
    repeatIntervalSecondsFromTime(99, 'ms') === 0.1 &&
    repeatIntervalSecondsFromTime(10_001, 'ms') === 10;
  check('Repeat interval expresses 100 ms through 10 s with integers and unit changes',
    bounds && exact && clamps && rejected,
    `bounds=${bounds}, exact=${exact}, clamps=${clamps}, normalized=${rejected}`);
}

{
  const preferred = timeUnitForRange('ms', 0.1, 10) === 'ms';
  const fallback = timeUnitForRange('s', 0.000064, 0.000768) === 'us';
  const invalid = timeUnitForRange('s', 0, 1) === null && timeUnitForRange('s', 2, 1) === null;
  check('a coarse unit with no positive integer range falls back to the finest usable unit',
    preferred && fallback && invalid,
    `preferred=${preferred}, fallback=${fallback}, invalid=${invalid}`);
}

{
  const exactMs = captureTimeFromSeconds(2.5, 'ms', 16e6) === 2500 &&
    captureSecondsFromTime(2500, 'ms', 16e6) === 2.5;
  const roundedSeconds = captureTimeFromSeconds(2.5, 's', 16e6) === 3 &&
    captureSecondsFromTime(3, 's', 16e6) === 3;
  check('unit changes preserve physical time when possible and otherwise expose the normalized integer',
    exactMs && roundedSeconds,
    `exactMs=${exactMs}, roundedSeconds=${roundedSeconds}`);
}

{
  const rates = [5e6, 16e6, 100e6, 1.4e9];
  const valid = rates.every((rate) => maxCaptureSeconds(rate) > 0 &&
    maxCaptureTimeValue(rate, 'us') >= minCaptureTimeValue('us'));
  const invalid = maxCaptureSeconds(0) === 0 && maxCaptureSeconds(-1) === 0 &&
    maxCaptureSeconds(Number.NaN) === 0 && maxCaptureSeconds(Number.POSITIVE_INFINITY) === 0 &&
    captureTimeFromSeconds(1, 's', 0) === null;
  check('every shipping rate has a usable microsecond range and invalid rates have none',
    valid && invalid, `rates=${rates.length}, valid=${valid}, invalid=${invalid}`);
}

{
  const base = defaultCaptureSettings();
  const finite = capturePostTriggerSamples({ ...base, seconds: 0.0015 }) === 24_000;
  const unlimited = capturePostTriggerSamples({ ...base, singleUnlimited: true }) === 2 ** 31 - 1;
  const repeat = capturePostTriggerSamples({
    ...base, mode: 'repeat', singleUnlimited: true, seconds: 0.0015,
  }) === 24_000;
  const loop = capturePostTriggerSamples({ ...base, mode: 'loop', loopSamples: 12_345 }) === 13_312;
  check('post-trigger policy shares finite, repeat, unlimited and loop budgets',
    finite && unlimited && repeat && loop,
    `finite=${finite}, unlimited=${unlimited}, repeat=${repeat}, loop=${loop}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const captureSource = fs.readFileSync('src/ui/captureTime.ts', 'utf8');
  const unitSource = fs.readFileSync('src/ui/timeUnits.ts', 'utf8');
  const forbidden = ['2 ** 31', '2**31', '2147483647', '2147483648', 'LOOP_RETENTION_MAX_BYTES',
    'LOOP_RETENTION_MAX_SAMPLES', 'LOOP_WINDOW_QUANTUM', 'maxLoopSamples'];
  const leaked = forbidden.filter((needle) => captureSource.includes(needle));
  const routed = captureSource.includes('(MAX_SAMPLES - 1) / samplerate') &&
    unitSource.includes("const UNIT_SECONDS: Record<TimeUnit, number> = { us: 1e-6, ms: 1e-3, s: 1 }");
  check('time conversion keeps one sample-ceiling authority and one unit table',
    leaked.length === 0 && routed, `leaked=${leaked.join(',') || 'none'}, routed=${routed}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
