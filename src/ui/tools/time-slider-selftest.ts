// SPDX-License-Identifier: GPL-3.0-or-later

import {
  SLIDER_FINITE_MAX,
  SLIDER_UNLIMITED_TRACK_START,
  SLIDER_UNLIMITED_VALUE,
  acquisitionTimeDigitBasis,
  isUnlimitedTimeSlider,
  timeSliderAriaValueText,
  timeSliderFiniteMaxLabel,
  timeSliderTrackGeometry,
  timeValueFromSlider,
  timeValueToSlider,
} from '../timeSlider.js';

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

check('slider constants preserve the approved finite and Unlimited domains',
  SLIDER_FINITE_MAX === 1000 && SLIDER_UNLIMITED_VALUE === 1120 &&
  SLIDER_UNLIMITED_TRACK_START === 0.905,
  `finite=${SLIDER_FINITE_MAX}, unlimited=${SLIDER_UNLIMITED_VALUE}, start=${SLIDER_UNLIMITED_TRACK_START}`);

{
  const finite = timeSliderTrackGeometry();
  const unlimited = timeSliderTrackGeometry(true);
  check('track geometry separates the finite segment from the approved Unlimited segment',
    finite.max === 1000 && finite.finiteFraction === 1 && finite.unlimitedStartFraction === null &&
    unlimited.max === 1120 && unlimited.finiteFraction === 1000 / 1120 &&
    unlimited.unlimitedStartFraction === 0.905,
    `finite=${JSON.stringify(finite)}, unlimited=${JSON.stringify(unlimited)}`);
}

{
  const rows = [
    { value: 99, expected: 0 },
    { value: 100, expected: 0 },
    { value: 600, expected: 500 },
    { value: 1100, expected: 1000 },
    { value: 1101, expected: 1000 },
  ];
  const actual = rows.map((row) => timeValueToSlider(row.value, 100, 1100));
  check('finite values map linearly and clamp to the real integer limits',
    actual.every((value, index) => value === rows[index]!.expected), JSON.stringify(actual));
}

{
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 0.5];
  const actual = invalid.map((value) => timeValueToSlider(value, 100, 1100));
  const badBounds = timeValueToSlider(100, 0, 1100) === null &&
    timeValueToSlider(100, 100, 99) === null && timeValueToSlider(100, 100.5, 1100) === null;
  check('invalid numeric drafts and invalid bounds never produce slider movement',
    actual.every((value) => value === null) && badBounds, JSON.stringify(actual));
}

{
  const rows = [
    { position: -10, expected: 100 },
    { position: 0, expected: 100 },
    { position: 250, expected: 350 },
    { position: 500, expected: 600 },
    { position: 1000, expected: 1100 },
    { position: 1120, expected: 1100 },
  ];
  const actual = rows.map((row) => timeValueFromSlider(row.position, 100, 1100));
  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, 0.5]
    .every((position) => timeValueFromSlider(position, 100, 1100) === null);
  check('slider positions clamp and map back to exact approximate integer values',
    actual.every((value, index) => value === rows[index]!.expected) && invalid, JSON.stringify(actual));
}

{
  const forward = timeValueToSlider(550, 1, 1100);
  const reverse = timeValueFromSlider(500, 1, 1100);
  const loop = timeValueFromSlider(500, 13, 214748364);
  check('approximate mappings round at non-integral positions in both directions',
    forward === 500 && reverse === 551 && loop === 107374189,
    `forward=${forward}, reverse=${reverse}, loop=${loop}`);
}

check('degenerate finite ranges remain stable in both mapping directions',
  timeValueToSlider(100, 100, 100) === 0 && timeValueToSlider(101, 100, 100) === 0 &&
  timeValueFromSlider(0, 100, 100) === 100 && timeValueFromSlider(1000, 100, 100) === 100,
  'min=max maps to the sole finite value');

check('Unlimited is a distinct opt-in sentinel, never a finite maximum alias',
  isUnlimitedTimeSlider(1120, true) && !isUnlimitedTimeSlider(1120, false) &&
  !isUnlimitedTimeSlider(1000, true) && !isUnlimitedTimeSlider(1121, true),
  '1120 is Unlimited only for a Single-style track');

{
  const units = ['us', 'ms', 's'] as const;
  const aria = units.map((unit) => timeSliderAriaValueText(500, 100, 1100, unit));
  const labels = units.map((unit) => timeSliderFiniteMaxLabel(1100, unit));
  check('ARIA and finite-max labels expose exact values in every supported unit',
    aria.join('|') === '600 us|600 ms|600 s' && labels.join('|') === '1100 us|1100 ms|1100 s' &&
    timeSliderAriaValueText(1120, 100, 1100, 'ms', 'Unlimited') === 'Unlimited' &&
    timeSliderAriaValueText(Number.NaN, 100, 1100, 'ms') === '' &&
    timeSliderFiniteMaxLabel(0, 'ms') === '',
    `aria=${aria.join('|')}, labels=${labels.join('|')}`);
}

{
  const basis = acquisitionTimeDigitBasis();
  check('the shared input basis is derived from the real capture, Loop, and Repeat authorities',
    basis.capture === 429496729 && basis.loop === 214748364 && basis.repeatInterval === 10000000 &&
    String(basis.capture).length === 9 && String(basis.loop).length === 9 &&
    String(basis.repeatInterval).length === 8 && basis.digits === 9,
    JSON.stringify(basis));
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const sliderSource = fs.readFileSync('src/ui/timeSlider.ts', 'utf8');
const digitSource = sliderSource.split('export function acquisitionTimeDigitBasis()')[1] ?? '';
check('the digit basis cannot degenerate into detached literal outputs',
  digitSource.includes("maxCaptureTimeValue(5e6, 'us')") &&
  digitSource.includes("maxLoopTimeValue(4, 5e6, 'us')") &&
  digitSource.includes("repeatIntervalTimeFromSeconds(REPEAT_INTERVAL_SECONDS.max, 'us')") &&
  !digitSource.includes('429496729') && !digitSource.includes('214748364') &&
  !digitSource.includes('10000000'),
  `source=${digitSource.length}`);

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
