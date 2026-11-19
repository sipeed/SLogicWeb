// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The analog group's cell is its gain control (DESIGN §5.2 "Gain is declared, not set"):
 * `A0 [±16 V ▾] ?`, the select holding the profile's preset ranges. The ratio and the
 * calibrated step live in the help tip; there is no custom-ratio entry. Built on a fake
 * DOM (`fakeDom.ts`) and driven the way the cell listens: item clicks.
 */

import { installFakeDom, type FakeElement } from './fakeDom.js';
import { ANALOG_GAIN_PRESETS, analogHalfRangeV } from '../channelBanks.js';
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
  gains: number[];
}

function build(overrides: Partial<AnalogGainCellOptions> = {}): Harness {
  doc.body.replaceChildren();
  const gains: number[] = [];
  const made = analogGainCell({
    start: 0, total: 32, gain: 1, busy: false,
    onGain: (gain) => gains.push(gain),
    ...overrides,
  });
  const cell = made.cell as unknown as FakeElement;
  doc.body.append(cell);
  return { cell, gains };
}

const trigger = (h: Harness): FakeElement | null =>
  h.cell.querySelector('.select-trigger[data-select-key="capture.analogGain.0"]');
const itemLabels = (h: Harness): string[] =>
  h.cell.querySelectorAll('.select-item-label').map((el) => el.textContent);
function pick(h: Harness, label: string): void {
  const item = h.cell.querySelectorAll('.select-item')
    .find((el) => el.querySelector('.select-item-label')?.textContent === label);
  if (!item) throw new Error(`no option ${label}`);
  item.click();
}

const rangeLabel = (gain: number): string =>
  `±${String(Number(analogHalfRangeV(gain).toPrecision(3)))} V`;
const presetRanges = ANALOG_GAIN_PRESETS.map(rangeLabel);

// The cell is the control: name, the range select and the tip, in that order.
{
  const h = build();
  const parts = h.cell.children.map((el) => el.className);
  const select = trigger(h);
  const tip = h.cell.querySelector('.help-tip');
  check('the cell reads A0 [±16 V ▾] ? and its select holds exactly the preset ranges',
    parts.join(',') === 'analog-cell-name,analog-cell-gain,help-tip' &&
      h.cell.querySelector('.analog-cell-name')?.textContent === 'A0' &&
      select !== null && select.querySelector('.select-value')?.textContent === '±16 V' &&
      JSON.stringify(itemLabels(h)) === JSON.stringify(presetRanges) &&
      JSON.stringify(presetRanges) === JSON.stringify(['±16 V', '±8 V', '±4 V', '±2 V']) &&
      h.cell.getAttribute('role') === 'group' && h.cell.getAttribute('aria-label') === 'A0 analog input' &&
      h.cell.querySelector('[data-analog-gain-input]') === null,
    `parts=${parts}, value=${select?.textContent}, items=${itemLabels(h)}`);
  const label = h.cell.querySelector('.select-field > label');
  check('the select is named "A0 gain" for assistive tech; the tip carries the ratio and calibrated step',
    label?.textContent === 'A0 gain' && label.htmlFor === select?.id &&
      tip !== null && tip.title.startsWith('The gain must match the setting on the module') &&
      tip.title.endsWith('×1 · 8-bit · 137.3 mV/code') &&
      (tip.getAttribute('aria-label') ?? '').includes('137.3 mV/code'),
    `label=${label?.textContent}, tip=${tip?.title}`);
}

// Readout precision: four significant digits; the step includes the 35/32 calibration.
check('bits and volts per code read 137.3 / 68.63 / 45.75 / 13.73 mV at 1x / 2x / 3x / 10x',
  analogGainReadout(1) === '8-bit · 137.3 mV/code' && analogGainReadout(2) === '8-bit · 68.63 mV/code' &&
    analogGainReadout(3) === '8-bit · 45.75 mV/code' && analogGainReadout(10) === '8-bit · 13.73 mV/code',
  `${analogGainReadout(1)} | ${analogGainReadout(2)} | ${analogGainReadout(3)} | ${analogGainReadout(10)}`);

// A preset applies straight from the select.
{
  const h = build();
  pick(h, '±4 V');
  pick(h, '±16 V');
  check('picking a preset declares it (and re-picking the declared one does nothing)',
    JSON.stringify(h.gains) === '[4]', `gains=${h.gains}`);
}

// A saved custom ratio stays visible so its readings keep their scale, but it is not a
// new choice and there is no Custom… entry.
{
  const h = build({ gain: 3 });
  const labels = itemLabels(h);
  check('a saved custom ratio shows as ±5.33 V, with no Custom… option',
    trigger(h)?.querySelector('.select-value')?.textContent === '±5.33 V' &&
      labels.includes('±5.33 V') && !labels.includes('Custom…') &&
      JSON.stringify(labels) === JSON.stringify([...presetRanges, '±5.33 V']),
    `items=${labels}`);
}

// Stopping: shown, not changeable.
{
  const h = build({ busy: true });
  const select = trigger(h);
  pick(h, '±8 V');
  check('while stopping the select is disabled and a click changes nothing',
    select?.disabled === true && h.gains.length === 0,
    `disabled=${select?.disabled}, gains=${h.gains}`);
}

// Panel wiring: the compact cell replaces the old rows; the clamped-level note stays.
{
  const fs = (nodeProcess.getBuiltinModule?.('node:fs') ?? null) as FsLike | null;
  if (!fs) throw new Error('node fs module unavailable');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const retired = !panel.includes('analogGainChoice') && !panel.includes('parseAnalogGain') &&
    !panel.includes('analogGainRow') && !panel.includes('analog-gain-row') &&
    !panel.includes('analog-gain-input') && !panel.includes('analogGainCustom') &&
    !panel.includes('analogGainRatio') && !panel.includes('analogGainRange') &&
    !panel.includes('gainEdit') && !panel.includes('analogGainRejected') &&
    !panel.includes('analogGainHelp = ') && !panel.includes('dataset.analogGainHelp') &&
    !sheet.includes('.analog-gain-input') && !sheet.includes('.analog-cell-range') &&
    !sheet.includes('.analog-gain-row') && !sheet.includes('.analog-gain-readout');
  const wired = panel.includes('const gainCell = analogGainCell({') &&
    panel.includes('onGain: (next) => this.cb.onAnalogGain(start, next),') &&
    panel.includes('bank.appendChild(gainCell.cell);') &&
    panel.includes("note.dataset.analogLevelClamped = '';") &&
    panel.includes('if (active && clamped && clamped.start === start) {') &&
    panel.includes('busy: analogBusy');
  check('the panel builds the compact cell; custom ratio entry and its note are gone',
    retired && wired, `retired=${retired}, wired=${wired}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed === 0 ? 'all' : results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
