// SPDX-License-Identifier: GPL-3.0-or-later

import { timeSliderBounds } from '../timeControl.js';
import { acquisitionTimeDigitBasis } from '../timeSlider.js';

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

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = a >= 0 ? source.indexOf(end, a) : -1;
  return a >= 0 && b > a ? source.slice(a, b) : '';
}

{
  const finite = timeSliderBounds(0.1, 10, 'ms');
  const seconds = timeSliderBounds(0.001, 2.5, 's');
  check('finite slider bounds retain real time limits inside the normalized position domain',
    finite.min === 100 && finite.finiteMax === 10_000 && finite.max === 1000 &&
    finite.unlimitedValue === null && seconds.min === 1 && seconds.finiteMax === 2 &&
    seconds.max === 1000,
    `repeat=${finite.min}/${finite.finiteMax}/${finite.max}, seconds=${seconds.min}/${seconds.finiteMax}/${seconds.max}`);
}

{
  const unlimited = timeSliderBounds(0.1, 10, 'ms', true);
  const coarse = timeSliderBounds(0.000064, 0.000768, 's', true);
  check('Single uses the separate 1120 Unlimited sentinel even when a coarse unit is unusable',
    unlimited.max === 1120 && unlimited.finiteMax === 10_000 && unlimited.unlimitedValue === 1120 &&
    coarse.finiteMax === 0 && coarse.max === 1120 && coarse.unlimitedValue === 1120,
    `finite=${unlimited.finiteMax}, slider=${unlimited.max}, coarse=${coarse.max}`);
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const source = fs.readFileSync('src/ui/timeControl.ts', 'utf8');
const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

{
  const rangeInput = between(source, "range.addEventListener('input'", "range.addEventListener('change'");
  const rangeChange = between(source, "range.addEventListener('change'", 'unitControl.addEventListener');
  check('range input stays local while change commits an exact approximate value or Unlimited',
    rangeInput.includes('syncRange(true)') &&
    (rangeInput.match(/setFieldInvalid\(false\)/g) ?? []).length === 1 &&
    !rangeInput.includes('onValue') &&
    rangeChange.includes('isUnlimitedTimeSlider(Number(range.value), hasUnlimited)') &&
    rangeChange.includes('options.unlimited?.onSelect()') &&
    rangeChange.includes('timeValueFromSlider(Number(range.value), bounds.min, bounds.finiteMax)') &&
    rangeChange.includes('commitValue(value)') && source.includes('options.onValue(clamped, unit)'),
    `input=${rangeInput.length}, change=${rangeChange.length}`);
}

{
  const numberInput = between(source, "input.addEventListener('input'", "input.addEventListener('change'");
  const numberChange = between(source, "input.addEventListener('change'", 'range.addEventListener');
  check('number input synchronizes valid drafts without committing or rewriting the caret',
    numberInput.includes('timeValueToSlider(value, bounds.min, bounds.finiteMax)') &&
    numberInput.includes('range.value = String(position)') && numberInput.includes('syncRange(false)') &&
    numberInput.includes('setFieldInvalid(true)') && !numberInput.includes('onValue') &&
    !numberInput.includes('input.value =') && numberChange.includes('isPositiveInteger(value)') &&
    numberChange.includes('input.reportValidity()') && numberChange.includes('commitValue(value)') &&
    !numberChange.includes('onUnit'),
    `input=${numberInput.length}, change=${numberChange.length}`);
}

{
  const commit = between(source, 'const commitValue =', "range.addEventListener('input'");
  check('commits clamp once, restore the exact number, and only then notify App',
    commit.includes('Math.min(bounds.finiteMax, Math.max(bounds.min, value))') &&
    commit.includes('syncRange(false)') && commit.includes('number.value = String(clamped)') &&
    commit.includes('options.onValue(clamped, unit)') &&
    commit.indexOf('number.value = String(clamped)') < commit.indexOf('options.onValue(clamped, unit)'),
    `commit=${commit.length}`);
}

{
  const numberBlock = between(source, 'function ensureNumber()', "range.addEventListener('input'");
  const unitChange = between(source, "unitControl.addEventListener('change'", 'setFieldInvalid(false);');
  check('Unlimited has no checkbox, omits committed number DOM, and preserves finite drafts through units',
    numberBlock.includes("document.createElement('input')") && numberBlock.includes("input.type = 'number'") &&
    !source.includes("type = 'checkbox'") && source.includes("unlimitedValue.textContent = '∞'") &&
    source.includes('isUnlimitedTimeSlider(position, hasUnlimited)') &&
    source.includes('unlimitedValue.hidden = !unlimited') &&
    source.includes('if (!options.unlimited?.active) ensureNumber();') &&
    source.includes('timeValueFromSlider(Number(range.value), bounds.min, bounds.finiteMax)') &&
    source.includes('inputGroup.insertBefore(input, unlimitedValue)') &&
    unitChange.includes('options.onUnit(nextUnit, null)') && unitChange.includes('options.unlimited.onSelect()'),
    `numberBlock=${numberBlock.length}, unitChange=${unitChange.length}`);
}

{
  const invalid = between(source, 'const setFieldInvalid =', 'const syncRange =');
  check('invalid drafts set both Field state and ARIA while valid recovery clears them',
    invalid.includes("root.dataset.invalid = 'true'") && invalid.includes('delete root.dataset.invalid') &&
    invalid.includes("number.setAttribute('aria-invalid', 'true')") &&
    invalid.includes("number.removeAttribute('aria-invalid')") &&
    source.includes("root.dataset.disabled = String(options.disabled || unavailable)"),
    `invalid=${invalid.length}`);
}

{
  const sync = between(source, 'const syncRange =', 'const commitValue =');
  const rangeInput = between(source, "range.addEventListener('input'", "range.addEventListener('change'");
  check('slider ARIA follows the visible draft and Unlimited return creates a stable finite input',
    sync.includes('? `${number.value} ${unit}`') &&
    sync.indexOf('range.setAttribute(\'aria-valuetext\'') > sync.indexOf('number.value = String(value)') &&
    rangeInput.includes('ensureNumber();') && !/range\.value\s*=/.test(rangeInput) &&
    source.includes('inputGroup.insertBefore(input, unlimitedValue)'),
    `sync=${sync.length}, input=${rangeInput.length}`);
}

{
  const unitChange = between(source, "unitControl.addEventListener('change'", 'setFieldInvalid(false);');
  const nativeSelectNeedle = ['createElement(', "'select'", ')'].join('');
  check('unit commits retain SelectControl, range fallback, normalization, and silent callbacks',
    source.includes('selectControl(`${options.key}.unit`') && unitChange.includes('timeUnitForRange') &&
    unitChange.includes('timeValueFromSeconds') && unitChange.includes('unitControl.value = nextUnit') &&
    unitChange.includes('options.onUnit(nextUnit, nextValue)') && !source.includes(nativeSelectNeedle) &&
    !source.includes('conversionNotice') && !source.includes('actualValue'),
    `unitChange=${unitChange.length}`);
}

{
  const safe = !source.includes('innerHTML') && !source.includes('document.addEventListener') &&
    !source.includes('window.addEventListener') && source.includes("range.type = 'range'") &&
    source.includes("range.min = '0'") && source.includes("range.step = '1'") &&
    source.includes("input.step = '1'") &&
    source.includes('unitControl.disabled = options.disabled || unavailable') &&
    source.includes('range.disabled = options.disabled || unavailable') &&
    source.includes('input.disabled = options.disabled || unavailable');
  check('the control uses bounded local DOM, integer inputs, and consistent disabled states',
    safe, `safe=${safe}`);
}

{
  const start = sheet.indexOf('.acquisition-time {');
  const end = sheet.indexOf('.field-row', start);
  const block = start >= 0 && end > start ? sheet.slice(start, end) : '';
  const classes = [
    'acquisition-time-head', 'acquisition-time-unit', 'acquisition-time-body',
    'acquisition-time-slider-wrap', 'acquisition-time-slider', 'acquisition-time-value',
    'acquisition-time-input-group', 'acquisition-time-unlimited', 'acquisition-time-slider-labels',
  ];
  const tokenOnly = !/#(?:[0-9a-fA-F]{3,8})\b|oklch\(|rgb\(/.test(block);
  check('time-control styles cover the complete structure with theme tokens only',
    classes.every((name) => block.includes(`.${name}`)) && tokenOnly &&
    block.includes('font-variant-numeric: tabular-nums') &&
    block.includes('var(--primary)') && block.includes('var(--muted)') &&
    between(block, '.acquisition-time-slider-labels span:last-child', '}').includes('color: var(--warning)'),
    `block=${block.length}, tokenOnly=${tokenOnly}`);
}

{
  const start = sheet.indexOf('.acquisition-time {');
  const end = sheet.indexOf('.field-row', start);
  const block = start >= 0 && end > start ? sheet.slice(start, end) : '';
  const basis = acquisitionTimeDigitBasis();
  check('the 40% container decision mirrors the derived nine-digit input basis',
    basis.digits === 9 && block.includes('container-type: inline-size') &&
    block.includes('@container (min-width: calc(22.5ch + 225px))') &&
    block.includes('width: calc(9ch + 90px)') &&
    block.includes('grid-template-columns: calc(9ch + 34px) 56px'),
    `digits=${basis.digits}`);
}

{
  const start = sheet.indexOf('.acquisition-time {');
  const end = sheet.indexOf('.field-row', start);
  const block = start >= 0 && end > start ? sheet.slice(start, end) : '';
  const slider = between(block, '.acquisition-time-slider {', '}');
  check('wrapped and inline layouts allocate every available pixel without a slider pixel cap',
    block.includes('grid-template-columns: minmax(0, 1fr); gap: 6px 12px') &&
    block.includes('grid-template-columns: minmax(0, 1fr) max-content; column-gap: 12px') &&
    block.includes('grid-template-columns: minmax(0, 1fr) 56px') &&
    block.includes('grid-template-columns: 89.285% 10.715%') &&
    slider.includes('width: 100%') && !slider.includes('max-width') &&
    !block.includes('minmax(64px, 88px)') && !block.includes('margin-inline: -'),
    `slider=${JSON.stringify(slider)}`);
}

{
  const start = sheet.indexOf('.acquisition-time {');
  const end = sheet.indexOf('.field-row', start);
  const block = start >= 0 && end > start ? sheet.slice(start, end) : '';
  const value = between(block, '.acquisition-time-value,\n.acquisition-time-unlimited {', '}');
  const trigger = between(block, '.acquisition-time-unit .select-trigger {', '}');
  const label = between(block, '.acquisition-time-unit > label {', '}');
  check('number and unit form one 30px token-backed control without a second label row',
    value.includes('height: 30px') && value.includes('background: var(--background)') &&
    value.includes('border: 1px solid var(--border)') &&
    value.includes('border-radius: var(--radius) 0 0 var(--radius)') &&
    label.includes('position: absolute') && label.includes('width: 1px') &&
    label.includes('height: 1px') && label.includes('clip-path: inset(50%)') &&
    !label.includes('display: none') &&
    trigger.includes('height: 30px') && trigger.includes('margin-left: -1px') &&
    trigger.includes('border-radius: 0 var(--radius) var(--radius) 0'),
    `value=${value.length}, trigger=${trigger.length}`);
}

check('the production editor has no Unlimited checkbox, native select, or retired exact/approximate copy',
  !source.includes("type = 'checkbox'") &&
  !source.includes(['createElement(', "'select'", ')'].join('')) &&
  !/approximate duration|exact duration|Actual:|actual:/i.test(source) &&
  sheet.includes('89.285%') && sheet.includes('90.5%'),
  'approved segmented control and quiet copy are pinned');

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
