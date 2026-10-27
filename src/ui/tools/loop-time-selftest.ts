// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChannelCount } from '../../types.js';
import {
  DEFAULT_LOOP_SAMPLES, LOOP_WINDOW_QUANTUM, clampLoopSamples, maxLoopSamples,
} from '../state.js';
import {
  DEFAULT_LOOP_TIME_UNIT, LOOP_TIME_UNITS, isLoopTimeUnit, loopSamplesFromTime, loopTimeFromSamples,
  maxLoopTimeValue, type LoopTimeUnit,
} from '../loopTime.js';

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

check('time units are us, ms and s with ms as the draft default',
  LOOP_TIME_UNITS.join(',') === 'us,ms,s' && DEFAULT_LOOP_TIME_UNIT === 'ms' &&
  isLoopTimeUnit('us') && isLoopTimeUnit('ms') && isLoopTimeUnit('s') &&
  !isLoopTimeUnit('min') && !isLoopTimeUnit(''),
  `units=${LOOP_TIME_UNITS.join(',')}, default=${DEFAULT_LOOP_TIME_UNIT}`);

{
  const invalid = [0, -0, -1, -100, 1.5, 0.001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const failures = LOOP_TIME_UNITS.flatMap((unit) => invalid.flatMap((value) => {
    const result = loopSamplesFromTime(value, unit, 16e6, 16);
    return result === null ? [] : [`${value}${unit}→${result}`];
  }));
  const invalidRates = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const rateFailures = invalidRates.flatMap((rate) => {
    const samples = loopSamplesFromTime(1, 'ms', rate, 16);
    const max = maxLoopTimeValue(16, rate, 'ms');
    const displayed = loopTimeFromSamples(DEFAULT_LOOP_SAMPLES, 'ms', rate, 16);
    return samples === null && max === 0 && displayed === null
      ? [] : [`rate=${rate}: samples=${samples}, max=${max}, displayed=${displayed}`];
  });
  const invalidUnit = 'min' as LoopTimeUnit;
  const unitRejected = maxLoopTimeValue(16, 16e6, invalidUnit) === 0 &&
    loopSamplesFromTime(1, invalidUnit, 16e6, 16) === null &&
    loopTimeFromSamples(16_000_000, invalidUnit, 16e6, 16) === null;
  const invalidSamples = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const sampleFailures = invalidSamples.filter((samples) => loopTimeFromSamples(samples, 'ms', 16e6, 16) !== null);
  check('zero, negative, fractional and non-finite inputs cannot produce a sample window',
    failures.length === 0 && rateFailures.length === 0 && unitRejected && sampleFailures.length === 0,
    [...failures, ...rateFailures].join('; ') ||
    `${invalid.length * LOOP_TIME_UNITS.length} values and ${invalidRates.length} rates rejected; ` +
    `unitRejected=${unitRejected}, invalidSamples=${sampleFailures.join(',') || 'none'}`);
}

{
  const rate = 1.4e9;
  const max = maxLoopTimeValue(4, rate, 's');
  const displayed = loopTimeFromSamples(maxLoopSamples(4), 's', rate, 4);
  const clamped = loopSamplesFromTime(1, 's', rate, 4);
  check('a coarse unit with no positive integer maximum has no prefill but still clamps forward conversion',
    max === 0 && displayed === null && clamped === maxLoopSamples(4),
    `max=${max}, displayed=${displayed}, clamped=${clamped}, budget=${maxLoopSamples(4)}`);
}

{
  const oneUs = loopSamplesFromTime(1, 'us', 16e6, 8);
  const oneMs = loopSamplesFromTime(1, 'ms', 16e6, 8);
  const oneSecond = loopSamplesFromTime(1, 's', 16e6, 8);
  check('short positive inputs expose the existing quantum instead of pretending to be exact',
    oneUs === LOOP_WINDOW_QUANTUM && oneMs === 16_384 && oneSecond === 16_000_000 &&
    loopTimeFromSamples(oneUs ?? 0, 'us', 16e6, 8) === 64 &&
    loopTimeFromSamples(oneMs ?? 0, 'us', 16e6, 8) === 1024,
    `1us→${oneUs} samples (${loopTimeFromSamples(oneUs ?? 0, 'us', 16e6, 8)}us), ` +
    `1ms→${oneMs} samples (${loopTimeFromSamples(oneMs ?? 0, 'us', 16e6, 8)}us), 1s→${oneSecond}`);
}

{
  const defaultMs = loopTimeFromSamples(DEFAULT_LOOP_SAMPLES, 'ms', 16e6, 16);
  const defaultSamples = loopSamplesFromTime(defaultMs ?? 0, 'ms', 16e6, 16);
  const throughUnits = LOOP_TIME_UNITS.map((unit) => {
    const value = loopTimeFromSamples(DEFAULT_LOOP_SAMPLES, unit, 16e6, 16);
    return `${unit}:${value}→${loopSamplesFromTime(value ?? 0, unit, 16e6, 16)}`;
  });
  check('the default sample window round-trips through every display unit',
    defaultMs === 1000 && defaultSamples === DEFAULT_LOOP_SAMPLES &&
    throughUnits.join(',') === 'us:1000000→16000000,ms:1000→16000000,s:1→16000000',
    `default=${defaultMs}ms→${defaultSamples}, ${throughUnits.join(', ')}`);
}

{
  const samples = 99_900_416;
  const values = LOOP_TIME_UNITS.map((unit) => loopTimeFromSamples(samples, unit, 100e6, 8));
  const quantizedRoundTrips = LOOP_TIME_UNITS.slice(0, 2).every((unit, index) =>
    loopSamplesFromTime(values[index] ?? 0, unit, 100e6, 8) === samples);
  const nearest = loopTimeFromSamples(1_500, 'ms', 1e6, 8) === 2 &&
    loopTimeFromSamples(1_499, 'ms', 1e6, 8) === 1 && loopTimeFromSamples(1, 's', 100e6, 8) === 1;
  check('unit changes preserve physical time where possible and choose the nearest positive integer',
    values.join(',') === '999004,999,1' && quantizedRoundTrips && nearest,
    `values=${values.join(',')}, quantizedRoundTrips=${quantizedRoundTrips}, nearest=${nearest}`);
}

{
  const widths: ChannelCount[] = [4, 8, 16, 32];
  const rates = [1e6, 16e6, 100e6];
  const unitSeconds = { us: 1e-6, ms: 1e-3, s: 1 } as const;
  const expectedMax = (channels: ChannelCount, rate: number, unit: LoopTimeUnit): number => {
    const scale = unitSeconds[unit] * rate;
    const budget = maxLoopSamples(channels);
    let low = 0;
    let high = budget;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (middle * scale <= budget) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  const failures: string[] = [];
  let cases = 0;
  for (const channels of widths) {
    for (const rate of rates) {
      for (const unit of LOOP_TIME_UNITS) {
        cases++;
        const max = maxLoopTimeValue(channels, rate, unit);
        const expected = expectedMax(channels, rate, unit);
        const atMax = loopSamplesFromTime(max, unit, rate, channels);
        const above = loopSamplesFromTime(max + 1, unit, rate, channels);
        const prefill = loopTimeFromSamples(maxLoopSamples(channels), unit, rate, channels);
        if (max !== expected || max <= 0 || atMax === null || atMax > maxLoopSamples(channels) ||
          atMax % LOOP_WINDOW_QUANTUM !== 0 || above !== maxLoopSamples(channels) ||
          prefill === null || prefill < 1 || prefill > max) {
          failures.push(`${channels}ch@${rate}/${unit}: max=${max}/${expected}, at=${atMax}, ` +
            `above=${above}, prefill=${prefill}`);
        }
      }
    }
  }
  const literalMaxima = maxLoopTimeValue(4, 16e6, 'us') === 67_108_864 &&
    maxLoopTimeValue(4, 16e6, 'ms') === 67_108 && maxLoopTimeValue(4, 16e6, 's') === 67 &&
    maxLoopTimeValue(32, 16e6, 'us') === 33_554_432 &&
    maxLoopTimeValue(32, 16e6, 'ms') === 33_554 && maxLoopTimeValue(32, 16e6, 's') === 33;
  check('4/8/16/32-channel maxima derive from width, samplerate and the shared budget at multiple rates',
    failures.length === 0 && literalMaxima,
    failures.join('; ') || `${cases} independent max/at-max/above-max/prefill cases; literals=${literalMaxima}`);
}

{
  const huge = loopSamplesFromTime(Number.MAX_SAFE_INTEGER, 's', 100e6, 32);
  const expected = clampLoopSamples(Number.POSITIVE_INFINITY, 32);
  check('finite over-budget input is capped by the existing clamp and never exceeds the sample budget',
    huge === maxLoopSamples(32) && huge === expected, `huge=${huge}, budget=${expected}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const source = fs.readFileSync('src/ui/loopTime.ts', 'utf8');
  const forbidden = ['LOOP_RETENTION_MAX_BYTES', 'LOOP_RETENTION_MAX_SAMPLES', 'LOOP_WINDOW_QUANTUM',
    'DEFAULT_LOOP_SAMPLES', 'bytesPerSampleForChannels', '2 ** 31', '2 ** 30', '2**31', '2**30',
    '2147483648', '1073741824', '536870912', '268435456', '1024'];
  const leaked = forbidden.filter((needle) => source.includes(needle));
  const routed = source.includes('clampLoopSamples(value * UNIT_SECONDS[unit] * samplerate, channels)') &&
    source.includes('Math.floor(maxLoopSamples(channels) / samplerate / UNIT_SECONDS[unit])');
  check('time conversion has no second memory budget or quantum and routes through the shared helpers',
    leaked.length === 0 && routed, `leaked=${leaked.join(',') || 'none'}, routed=${routed}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
