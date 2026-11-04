// SPDX-License-Identifier: GPL-3.0-or-later

import {
  MAX_STAGE_STEPS, buildTimeScale, finiteMaxValue, niceStep, positionForSeconds,
  secondsInUnit, timeAtPosition, unitValueText,
} from '../timeScale.js';

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
  const stages = (min: number, max: number) =>
    buildTimeScale(min, max).stages.map((s) => `${s.unit}:${s.fromUnits}-${s.toUnits}`).join('|');
  const capture = stages(0.001, 134);
  const tight = stages(0.001, 21.47);
  const fast = stages(0.001, 1.53);
  const loop = stages(5.12e-6, 0.08);
  const interval = stages(0.1, 10);
  check('stages follow milliseconds, seconds and minutes as the range crosses their thresholds',
    capture === 'ms:1-4999|s:5-59|min:1-2' &&
    tight === 'ms:1-4999|s:5-21' &&
    fast === 'ms:1-1530' &&
    loop === 'us:6-999|ms:1-80' &&
    interval === 'ms:100-4999|s:5-10',
    `capture=${capture}; tight=${tight}; fast=${fast}; loop=${loop}; interval=${interval}`);
}

{
  // At a threshold the next unit owns the value: 5000 ms is 5 s, not the last ms step.
  const scale = buildTimeScale(0.001, 134);
  const before = timeAtPosition(scale, positionForSeconds(scale, 4.999)!.position)!;
  const at = timeAtPosition(scale, positionForSeconds(scale, 5)!.position)!;
  const minute = timeAtPosition(scale, positionForSeconds(scale, 60)!.position)!;
  check('the unit switches at 5 s and 60 s and the boundary belongs to the finer new unit',
    before.unit === 'ms' && before.seconds === 4.999 &&
    at.unit === 's' && at.value === 5 && at.seconds === 5 &&
    minute.unit === 'min' && minute.value === 1 && minute.seconds === 60,
    `4.999=${before.value}${before.unit}, 5=${at.value}${at.unit}, 60=${minute.value}${minute.unit}`);
}

{
  const scale = buildTimeScale(0.001, 134);
  const every: string[] = [];
  for (let p = 0; p <= scale.finiteMax; p++) {
    const v = timeAtPosition(scale, p);
    if (!v) { every.push(`bad@${p}`); break; }
    every.push(`${v.unit}:${v.value}`);
  }
  const units = new Set(every.map((x) => x.split(':')[0]));
  const steps = scale.stages.map((s) => s.steps);
  check('every finite position maps to one whole unit value, within the stage step cap',
    every.length === scale.finiteMax + 1 && !every.some((x) => x.startsWith('bad')) &&
    units.size === 3 && steps.every((n) => n <= MAX_STAGE_STEPS) &&
    scale.finiteMax === steps.reduce((sum, n) => sum + n, 0) + (scale.stages.length - 1),
    `positions=${every.length}, units=${[...units]}, steps=${steps}, finiteMax=${scale.finiteMax}`);
}

{
  const scale = buildTimeScale(0.001, 21.47, true);
  const fraction = scale.finiteMax / scale.sliderMax;
  const top = finiteMaxValue(scale);
  const last = timeAtPosition(scale, scale.finiteMax);
  check('the finite track leaves the HSync 89.285% share before the Unlimited notch',
    Math.abs(fraction - 1000 / 1120) < 0.002 && scale.unlimited === scale.sliderMax &&
    top !== null && last !== null && top.seconds === last.seconds &&
    timeAtPosition(scale, scale.unlimited!) === null,
    `finite=${scale.finiteMax}, slider=${scale.sliderMax}, unlimited=${scale.unlimited}, fraction=${fraction.toFixed(4)}`);
}

{
  const zero = buildTimeScale(0, 1);
  const reversed = buildTimeScale(1, 0.5);
  const same = buildTimeScale(2, 2);
  check('invalid ranges produce no stages and a single-value range still produces one',
    zero.stages.length === 0 && reversed.stages.length === 0 &&
    same.stages.length === 1 && same.stages[0]!.fromUnits === same.stages[0]!.toUnits &&
    timeAtPosition(same, 0)?.seconds === 2,
    `zero=${zero.stages.length}, reversed=${reversed.stages.length}, same=${same.stages.length}`);
}

{
  const steps = [1, 2, 5, 10, 25, 49, 50, 51, 99, 100, 101, 499, 500, 501].map(niceStep);
  check('unit steps snap up to the 1-2-5 sequence',
    steps.join(',') === '1,2,5,10,50,50,50,100,100,100,200,500,500,1000',
    steps.join(','));
}

{
  const text = [
    unitValueText(4.5e-3, 'ms'),
    unitValueText(7.5, 's'),
    unitValueText(134, 'min'),
    unitValueText(0.000006, 'us'),
    secondsInUnit(2.5, 'min'),
  ];
  check('unit text keeps six significant digits and converts both ways',
    text[0] === '4.5' && text[1] === '7.5' && text[2] === '2.23333' &&
    text[3] === '6' && text[4] === 150,
    text.join(' | '));
}

{
  // The exact maximum above the last whole minute stays reachable through the numeric
  // field: the scale tops out at 2 min, but 134 s is still a valid value for it.
  const scale = buildTimeScale(0.001, 134);
  const placed = positionForSeconds(scale, 134);
  const shown = finiteMaxValue(scale);
  check('a value above the last whole step lands on the top position without being lost',
    placed !== null && placed.position === scale.finiteMax &&
    shown !== null && shown.seconds === 120,
    `position=${placed?.position}/${scale.finiteMax}, shown=${shown?.seconds}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
