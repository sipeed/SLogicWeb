// SPDX-License-Identifier: GPL-3.0-or-later

import { acquisitionTimeDigitBasis } from '../timeScale.js';

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

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const source = fs.readFileSync('src/ui/timeControl.ts', 'utf8');
const scaleSource = fs.readFileSync('src/ui/timeScale.ts', 'utf8');
const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

{
  const staged = source.includes("from './timeScale.js'") &&
    source.includes('buildTimeScale(options.minSeconds, options.maxSeconds, hasUnlimited)') &&
    source.includes('positionForSeconds(scale, options.seconds)') &&
    source.includes('timeAtPosition(scale, position)') &&
    source.includes('secondsInUnit(typed, unit)') &&
    source.includes('unitValueText');
  check('the control is built on the staged scale, not a linear per-unit mapping',
    staged && !source.includes("from './timeSlider.js'") && !source.includes('SLIDER_FINITE_MAX'),
    `staged=${staged}, sliderImport=${source.includes("from './timeSlider.js'")}`);
}

{
  const rangeInput = between(source, "range.addEventListener('input'", "range.addEventListener('change'");
  const rangeChange = between(source, "range.addEventListener('change'", 'number.addEventListener');
  check('the slider previews its stage while dragging and commits only on change',
    rangeInput.includes('syncFromPosition(Number(range.value))') &&
    !rangeInput.includes('commitSeconds') &&
    rangeChange.includes('scale.unlimited !== null && position === scale.unlimited') &&
    rangeChange.includes('options.unlimited?.onSelect()') &&
    rangeChange.includes('commitSeconds(value.seconds)'),
    `input=${rangeInput.length}, change=${rangeChange.length}`);
}

{
  const numberInput = between(source, "number.addEventListener('input'", "number.addEventListener('change'");
  const numberChange = between(source, "number.addEventListener('change'", 'return { el: root };');
  check('the numeric field is the exact editor: fractional units, stage-aware slider, clamped commit',
    source.includes("number.step = 'any'") && source.includes("number.inputMode = 'decimal'") &&
    numberInput.includes('secondsInUnit(typed, unit)') &&
    numberInput.includes('positionForSeconds(scale, seconds)') &&
    numberInput.includes('setFieldInvalid(') && !numberInput.includes('commitSeconds') &&
    numberChange.includes('Number.isFinite(typed)') && numberChange.includes('number.reportValidity()') &&
    numberChange.includes('commitSeconds(seconds)'),
    `input=${numberInput.length}, change=${numberChange.length}`);
}

{
  const unit = source.includes("unitControl = selectControl(") &&
    source.includes("unitControl.el.classList.add('acquisition-time-unit')") &&
    source.includes('setUnit(value.unit)') &&
    source.includes("unitControl.addEventListener('change'") &&
    source.includes('unitControl.value = next');
  check('the unit select follows the stage but stays manually overridable for exact entry',
    unit && !source.includes('unitBadge'), `unit=${unit}, badge=${source.includes('unitBadge')}`);
}

{
  const sync = between(source, 'const syncFromPosition =', 'const commitSeconds =');
  const initial = between(source, 'const initialSeconds = options.seconds;', 'setFieldInvalid(false);');
  check('Unlimited hides the number, shows the warning glyph, and a finite value restores it',
    sync.includes('number.hidden = true') && sync.includes('unlimitedValue.hidden = false') &&
    sync.includes("range.classList.add('is-unlimited')") &&
    initial.includes('number.hidden = false') && initial.includes('unlimitedValue.hidden = true'),
    `sync=${sync.length}, initial=${initial.length}`);
}

{
  const invalid = between(source, 'const setFieldInvalid =', 'const setUnit =');
  check('invalid drafts mark both the field and ARIA, and valid recovery clears them',
    invalid.includes("root.dataset.invalid = 'true'") &&
    invalid.includes('delete root.dataset.invalid') &&
    invalid.includes("number.setAttribute('aria-invalid', 'true')") &&
    invalid.includes("number.removeAttribute('aria-invalid')"),
    `invalid=${invalid.length}`);
}

{
  const fill = source.includes('position / scale.sliderMax') &&
    source.includes("'--acquisition-fill'");
  const aria = source.includes("range.setAttribute('aria-valuetext'") &&
    source.includes('options.unlimited?.label');
  check('the fill fraction and ARIA text follow the staged position and the Unlimited label',
    fill && aria, `fill=${fill}, aria=${aria}`);
}

{
  const panelWired = panel.includes('acquisitionTimeControl({') &&
    (panel.match(/onValue: \(seconds\) =>/g) ?? []).length === 3 &&
    !panel.includes('captureTimeUnit') && !panel.includes('repeatIntervalUnit') &&
    !panel.includes('loopTimeUnit') && !panel.includes('unitLabel:') &&
    !panel.includes('onUnit:');
  check('all three controls pass seconds, and the panel keeps no per-control unit state',
    panelWired, `panel=${panelWired}`);
}

{
  const start = sheet.indexOf('.acquisition-time {');
  const end = sheet.indexOf('.field-row', start);
  const block = start >= 0 && end > start ? sheet.slice(start, end) : '';
  const trigger = between(block, '.acquisition-time-unit .select-trigger {', '}');
  const hiddenLabel = between(block, '.acquisition-time-unit > label {', '}');
  check('the unit segment is the existing token-backed select without a second label row',
    trigger.includes('height: 30px') && trigger.includes('margin-left: -1px') &&
    trigger.includes('border-radius: 0 var(--radius) var(--radius) 0') &&
    hiddenLabel.includes('position: absolute') && hiddenLabel.includes('clip-path: inset(50%)'),
    `trigger=${trigger.length}, label=${hiddenLabel.length}`);
}

{
  const block = between(sheet, '.acquisition-time {', '.field-row');
  const basis = acquisitionTimeDigitBasis();
  check('the width budget still covers the widest integer value and the 56 px badge',
    basis.digits === 9 && block.includes('grid-template-columns: minmax(0, 1fr) 56px') &&
    block.includes('width: calc(9ch + 90px)') &&
    block.includes('grid-template-columns: calc(9ch + 34px) 56px'),
    `digits=${basis.digits}`);
}

{
  check('the scale module owns the thresholds and has no DOM dependency',
    scaleSource.includes("'us', belowSeconds: 0.001") &&
    scaleSource.includes("'ms', belowSeconds: 5") &&
    scaleSource.includes("'s', belowSeconds: 60") &&
    !scaleSource.includes('document.') && !scaleSource.includes('HTMLElement'),
    'thresholds and DOM-free scale');
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
