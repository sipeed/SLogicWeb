// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The analog group's cell is its gain control (DESIGN §5.2 "Gain is declared, not set"):
 * `A0 [×1 ▾] ±16 V ?`, the select holding the profile presets and "Custom…", which turns
 * into a ratio field in place. Built on a fake DOM (`fakeDom.ts`) and driven the way the
 * cell listens: item clicks, input, Enter/Escape keydowns and blur.
 */

import { fakeEvent, installFakeDom, type FakeElement } from './fakeDom.js';
import { ANALOG_GAIN_MAX, ANALOG_GAIN_MIN, ANALOG_GAIN_PRESETS } from '../channelBanks.js';
import { analogGainCell, analogGainReadout, type AnalogGainCellOptions } from '../capturePanel.js';

interface FsLike { readFileSync(path: string, encoding: 'utf8'): string }
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

const doc = installFakeDom();

interface Harness {
  cell: FakeElement;
  note: FakeElement;
  gains: number[];
  editing: (string | null)[];
  focusField(): void;
  setLive(live: boolean): void;
}

function build(overrides: Partial<AnalogGainCellOptions> = {}): Harness {
  doc.body.replaceChildren();
  const gains: number[] = [];
  const editing: (string | null)[] = [];
  let live = true;
  const made = analogGainCell({
    start: 0, total: 32, gain: 1, busy: false, editing: null,
    live: () => live,
    onEditing: (text) => editing.push(text),
    onGain: (gain) => gains.push(gain),
    ...overrides,
  });
  const cell = made.cell as unknown as FakeElement;
  const note = made.note as unknown as FakeElement;
  doc.body.append(cell, note);
  return { cell, note, gains, editing, focusField: made.focusField, setLive: (v) => { live = v; } };
}

const trigger = (h: Harness): FakeElement | null =>
  h.cell.querySelector('.select-trigger[data-select-key="capture.analogGain.0"]');
const field = (h: Harness): FakeElement | null => h.cell.querySelector('[data-analog-gain-input]');
const itemLabels = (h: Harness): string[] =>
  h.cell.querySelectorAll('.select-item-label').map((el) => el.textContent);
function pick(h: Harness, label: string): void {
  const item = h.cell.querySelectorAll('.select-item')
    .find((el) => el.querySelector('.select-item-label')?.textContent === label);
  if (!item) throw new Error(`no option ${label}`);
  item.click();
}
function type(input: FakeElement, text: string): void {
  input.value = text;
  input.dispatchEvent(fakeEvent('input'));
}
const key = (input: FakeElement, k: string) => {
  const event = fakeEvent('keydown', { key: k });
  input.dispatchEvent(event);
  return event;
};

// The cell is the control: name, the select, the range and the tip, in that order.
{
  const h = build();
  const parts = h.cell.children.map((el) => el.className);
  const select = trigger(h);
  const tip = h.cell.querySelector('.help-tip');
  const presets = ANALOG_GAIN_PRESETS.map((g) => `×${g}`);
  check('the cell reads A0 [×1 ▾] ±16 V ? and its select holds the presets and Custom…',
    parts.join(',') === 'analog-cell-name,analog-cell-gain,analog-cell-range,help-tip' &&
      h.cell.querySelector('.analog-cell-name')?.textContent === 'A0' &&
      select !== null && select.querySelector('.select-value')?.textContent === '×1' &&
      h.cell.querySelector('.analog-cell-range')?.textContent === '±16 V' &&
      JSON.stringify(itemLabels(h)) === JSON.stringify([...presets, 'Custom…']) &&
      h.cell.getAttribute('role') === 'group' && h.cell.getAttribute('aria-label') === 'A0 analog input' &&
      field(h) === null && h.note.hidden,
    `parts=${parts}, value=${select?.textContent}, items=${itemLabels(h)}`);
  const label = h.cell.querySelector('.select-field > label');
  check('the select is named "A0 gain" for assistive tech; the tip carries the sentence and the code step',
    label?.textContent === 'A0 gain' && label.htmlFor === select?.id &&
      tip !== null && tip.title.startsWith('The gain must match the setting on the module') &&
      tip.title.endsWith('8-bit · 125.5 mV/code') &&
      (tip.getAttribute('aria-label') ?? '').includes('125.5 mV/code'),
    `label=${label?.textContent}, tip=${tip?.title}`);
}

// Readout precision: four significant digits, so 125.49 reads 125.5, not 125.
check('bits and volts per code read 125.5 / 62.75 / 41.83 / 12.55 mV at 1x / 2x / 3x / 10x',
  analogGainReadout(1) === '8-bit · 125.5 mV/code' && analogGainReadout(2) === '8-bit · 62.75 mV/code' &&
    analogGainReadout(3) === '8-bit · 41.83 mV/code' && analogGainReadout(10) === '8-bit · 12.55 mV/code',
  `${analogGainReadout(1)} | ${analogGainReadout(2)} | ${analogGainReadout(3)} | ${analogGainReadout(10)}`);

// A preset applies straight from the select.
{
  const h = build();
  pick(h, '×5');
  pick(h, '×1');
  check('picking a preset declares it (and re-picking the declared one does nothing)',
    JSON.stringify(h.gains) === '[5]', `gains=${h.gains}`);
}

// A declared custom ratio reads as itself.
{
  const h = build({ gain: 3 });
  check('a custom gain shows as ×3 in the select, with Custom… still last',
    trigger(h)?.querySelector('.select-value')?.textContent === '×3' &&
      itemLabels(h).at(-1) === 'Custom…' && itemLabels(h).includes('×3') &&
      h.cell.querySelector('.analog-cell-range')?.textContent === '±5.33 V',
    `items=${itemLabels(h)}, range=${h.cell.querySelector('.analog-cell-range')?.textContent}`);
}

// Custom… turns the select into a field in place; Enter applies.
{
  const h = build();
  pick(h, 'Custom…');
  const input = field(h);
  const inPlace = input !== null && input.parentNode?.className === 'analog-cell-gain' &&
    trigger(h) === null && doc.activeElement === input && input.value === '1';
  if (input) {
    type(input, '×4');
    const enter = key(input, 'Enter');
    check('Custom… opens a focused ratio field in the cell; Enter applies the typed ratio',
      inPlace && enter.defaultPrevented && JSON.stringify(h.gains) === '[4]' && field(h) === null &&
        trigger(h) !== null && h.editing.at(-1) === null && h.note.hidden,
      `inPlace=${inPlace}, gains=${h.gains}, editing=${h.editing}`);
  } else {
    check('Custom… opens a focused ratio field in the cell; Enter applies the typed ratio', false, 'no field');
  }
}

// Esc reverts: nothing applied, the select is back and focused.
{
  const h = build();
  pick(h, 'Custom…');
  const input = field(h)!;
  type(input, '7');
  const esc = key(input, 'Escape');
  check('Esc reverts the entry: no gain change, the select returns with the focus',
    h.gains.length === 0 && esc.defaultPrevented && esc.propagationStopped &&
      field(h) === null && doc.activeElement === trigger(h) && h.editing.at(-1) === null &&
      trigger(h)?.querySelector('.select-value')?.textContent === '×1',
    `gains=${h.gains}, active=${doc.activeElement.className}`);
}

// Leaving the field applies a valid ratio.
{
  const h = build();
  pick(h, 'Custom…');
  const input = field(h)!;
  type(input, '2,5');
  input.blur();
  check('blur applies a valid ratio (a decimal comma accepted)',
    JSON.stringify(h.gains) === '[2.5]' && field(h) === null, `gains=${h.gains}`);
}

// Invalid Enter: the field stays with the declared ratio and the validity bubble, which
// is still set after reportValidity() (clearing it at once hides the bubble) and clears
// on the next keystroke.
{
  const h = build();
  pick(h, 'Custom…');
  const input = field(h)!;
  type(input, String(ANALOG_GAIN_MAX * 10));
  key(input, 'Enter');
  const kept = field(h) === input && input.value === '1' && input.reported === 1 &&
    input.validationMessage === `Enter a gain ratio from ${ANALOG_GAIN_MIN} to ${ANALOG_GAIN_MAX}.` &&
    !h.note.hidden && h.note.getAttribute('role') === 'alert' && h.gains.length === 0;
  type(input, '2');
  check('an out-of-range Enter reports validity, reverts the text and keeps the message until the next input',
    kept && input.validationMessage === '', `kept=${kept}, message=${input.validationMessage}`);
}

// Invalid blur: back to the select, nothing applied, the note says why.
{
  const h = build();
  pick(h, 'Custom…');
  const input = field(h)!;
  type(input, 'abc');
  input.blur();
  check('an invalid ratio on blur reverts to the select and shows the range in the note',
    h.gains.length === 0 && field(h) === null && trigger(h) !== null && !h.note.hidden &&
      h.note.textContent.includes(String(ANALOG_GAIN_MAX)),
    `gains=${h.gains}, note=${h.note.textContent}`);
  pick(h, '×2');
  check('the next gain choice clears the rejection note', h.note.hidden && JSON.stringify(h.gains) === '[2]',
    `hidden=${h.note.hidden}`);
}

// A rebuild mid-entry: the text comes back in the field and takes the focus; the old
// field's removal blur is not a commit.
{
  const h = build({ editing: '3.3' });
  const input = field(h);
  h.focusField();
  const restored = input !== null && input.value === '3.3' && doc.activeElement === input;
  h.setLive(false);
  doc.body.replaceChildren();          // the owner detaches the tree: Chrome blurs the field
  check('a rebuild keeps the typed ratio and focus; the detaching blur applies nothing',
    restored && h.gains.length === 0, `restored=${restored}, gains=${h.gains}`);
}

// Stopping: shown, not changeable.
{
  const h = build({ busy: true, editing: '4' });
  const select = trigger(h);
  pick(h, '×5');
  check('while stopping the select is disabled and an entry in progress is not reopened',
    select?.disabled === true && field(h) === null && h.gains.length === 0,
    `disabled=${select?.disabled}, gains=${h.gains}`);
}

// Panel wiring: the cell replaces the old rows; the clamped-level note stays.
{
  const fs = (nodeProcess.getBuiltinModule?.('node:fs') ?? null) as FsLike | null;
  if (!fs) throw new Error('node fs module unavailable');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const retired = !panel.includes('analogGainRow') && !panel.includes('analog-gain-row') &&
    !panel.includes('analogGainHelp = ') && !panel.includes('dataset.analogGainHelp') &&
    !panel.includes('customGainStarts') && !panel.includes("t('capturePanel.analogGainDetail'") &&
    !sheet.includes('.analog-gain-row') && !sheet.includes('.analog-gain-readout');
  const wired = panel.includes('const gainCell = analogGainCell({') &&
    panel.includes('onGain: (next) => this.cb.onAnalogGain(start, next),') &&
    panel.includes('bank.appendChild(gainCell.cell);') &&
    panel.includes("note.dataset.analogLevelClamped = '';") &&
    panel.includes('if (active && clamped && clamped.start === start) {') &&
    panel.includes('busy: analogBusy');
  check('the panel builds the cell in the bank row; no separate gain rows or help note remain',
    retired && wired, `retired=${retired}, wired=${wired}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed === 0 ? 'all' : results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
