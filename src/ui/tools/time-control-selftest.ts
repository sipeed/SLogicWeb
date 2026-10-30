// SPDX-License-Identifier: GPL-3.0-or-later

import { timeSliderBounds } from '../timeControl.js';

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
  const finite = timeSliderBounds(0.1, 10, 'ms');
  const seconds = timeSliderBounds(0.001, 2.5, 's');
  check('finite slider bounds use the exact positive-integer unit range',
    finite.min === 100 && finite.max === 10_000 && finite.finiteMax === 10_000 &&
    finite.unlimitedValue === null && seconds.min === 1 && seconds.max === 2 && seconds.finiteMax === 2,
    `repeat=${finite.min}..${finite.max}, seconds=${seconds.min}..${seconds.max}`);
}

{
  const unlimited = timeSliderBounds(0.1, 10, 'ms', true);
  const coarse = timeSliderBounds(0.000064, 0.000768, 's', true);
  check('Unlimited is one opt-in endpoint beyond the finite maximum, including a zero coarse maximum',
    unlimited.max === 10_001 && unlimited.finiteMax === 10_000 && unlimited.unlimitedValue === 10_001 &&
    coarse.finiteMax === 0 && coarse.max === 1 && coarse.unlimitedValue === 1,
    `finite=${unlimited.finiteMax}, slider=${unlimited.max}, coarse=${coarse.max}`);
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const source = fs.readFileSync('src/ui/timeControl.ts', 'utf8');
const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

{
  const rangeInput = source.split("range.addEventListener('input'")[1]?.split("range.addEventListener('change'")[0] ?? '';
  const rangeChange = source.split("range.addEventListener('change'")[1]?.split('if (number) {')[0] ?? '';
  check('range edits synchronize locally and only the change event commits',
    rangeInput.includes('syncRange') && !rangeInput.includes('onValue') &&
    rangeChange.includes('commitValue(Number(range.value))') && rangeChange.includes('options.unlimited?.onSelect()') &&
    source.includes('options.onValue(clamped, unit)'),
    `input=${rangeInput.length}, change=${rangeChange.length}`);
}

{
  const numberInput = source.split("number.addEventListener('input'")[1]?.split("number.addEventListener('change'")[0] ?? '';
  const numberChange = source.split("number.addEventListener('change'")[1]?.split('unitControl.addEventListener')[0] ?? '';
  check('number edits mirror valid integers locally and reject invalid drafts without committing',
    numberInput.includes('isPositiveInteger') && numberInput.includes('range.value') &&
    !numberInput.includes('onValue') && numberChange.includes('reportValidity') &&
    numberChange.includes('commitValue(value)') && !numberChange.includes('onUnit'),
    `input=${numberInput.length}, change=${numberChange.length}`);
}

{
  const numberBlock = source.split('if (!options.unlimited?.active) {')[1]?.split('const syncRange')[0] ?? '';
  check('committed Unlimited omits the number input and keeps a visible infinity marker',
    numberBlock.includes("document.createElement('input')") && numberBlock.includes("number.type = 'number'") &&
    source.includes("marker.textContent = '∞'") && source.includes('options.unlimited?.onSelect()') &&
    source.includes('bounds.unlimitedValue !== null'),
    `numberBlock=${numberBlock.length}`);
}

{
  const unitChange = source.split("unitControl.addEventListener('change'")[1] ?? '';
  const nativeSelectNeedle = ['createElement(', "'select'", ')'].join('');
  check('unit commits use the shared select, range fallback and normalized value',
    source.includes('selectControl(`${options.key}.unit`') && unitChange.includes('timeUnitForRange') &&
    unitChange.includes('timeValueFromSeconds') && unitChange.includes('options.onUnit(nextUnit, nextValue)') &&
    unitChange.includes('options.unlimited?.active') && !source.includes(nativeSelectNeedle),
    `unitChange=${unitChange.length}`);
}

{
  const safe = !source.includes('innerHTML') && !source.includes('document.addEventListener') &&
    !source.includes('window.addEventListener') && source.includes("range.type = 'range'") &&
    source.includes("range.step = '1'") && source.includes("number.step = '1'") &&
    source.includes('unitControl.disabled = options.disabled || unavailable') &&
    source.includes('range.disabled = options.disabled || unavailable') &&
    source.includes('number.disabled = options.disabled || unavailable');
  check('the control uses bounded local DOM, integer inputs and consistent disabled states',
    safe, `safe=${safe}`);
}

{
  const start = sheet.indexOf('.acquisition-time {');
  const end = sheet.indexOf('.field-row', start);
  const block = start >= 0 && end > start ? sheet.slice(start, end) : '';
  const classes = ['acquisition-time-head', 'acquisition-time-unit', 'acquisition-time-body',
    'acquisition-time-slider', 'acquisition-time-value', 'acquisition-time-unlimited'];
  const tokenOnly = !/#(?:[0-9a-fA-F]{3,8})\b|oklch\(|rgb\(/.test(block);
  check('time-control styles cover every class with layout and theme tokens only',
    classes.every((name) => block.includes(`.${name}`)) && tokenOnly &&
    block.includes('grid-template-columns') && block.includes('accent-color: var(--accent)') &&
    block.includes('font-variant-numeric: tabular-nums'),
    `block=${block.length}, tokenOnly=${tokenOnly}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
