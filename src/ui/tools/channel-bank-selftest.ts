// SPDX-License-Identifier: GPL-3.0-or-later

import {
  ADC_CLOCK_HZ, ADC_LSB_V, ADC_MAX_CODE, ADC_MIN_SAMPLERATE_HZ, ADC_ZERO_CODE, ANALOG_GROUP_COUNT,
  CHANNEL_BANK_SIZE, CHANNEL_WIDTH_OPTIONS, analogBankActive, analogBusConfig, analogCodeFromVolts,
  analogGroupCount, analogSamplerates, analogTriggerVolts, analogVoltsFromCode, busChannelBank,
  busOutOfWidth, captureWidthTiers,
  channelBankIndices,
  channelBankRange, channelBankStart, channelBankStarts, channelWidthOptions, lockedChannelBanks,
} from '../channelBanks.js';
import { busLabel } from '../busView.js';
import { SAMPLERATES_HZ } from '../../device/index.js';

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

check('bank size and starts cover partial and complete groups',
  CHANNEL_BANK_SIZE === 8 && channelBankStarts(4).join(',') === '0' &&
  channelBankStarts(16).join(',') === '0,8' && channelBankStarts(32).join(',') === '0,8,16,24',
  `size=${CHANNEL_BANK_SIZE}, 4=${channelBankStarts(4)}, 16=${channelBankStarts(16)}, 32=${channelBankStarts(32)}`);

check('bank indices and ranges never invent unavailable channels',
  channelBankIndices(0, 4).join(',') === '0,1,2,3' && channelBankRange(0, 4) === 'D0–D3' &&
  channelBankIndices(8, 16).join(',') === '8,9,10,11,12,13,14,15' &&
  channelBankRange(8, 16) === 'D8–D15' && channelBankIndices(3, 16).length === 0,
  `partial=${channelBankRange(0, 4)}, full=${channelBankRange(8, 16)}, invalid=${channelBankIndices(3, 16).length}`);

check('bank start uses the absolute channel index',
  channelBankStart(0) === 0 && channelBankStart(7) === 0 && channelBankStart(8) === 8 &&
  channelBankStart(31) === 24,
  `0=${channelBankStart(0)}, 7=${channelBankStart(7)}, 8=${channelBankStart(8)}, 31=${channelBankStart(31)}`);

{
  const spec = (bits: number[]) => ({ bits, clock: null, encoding: 'unsigned' as const });
  const recognized = busChannelBank(spec([0, 1, 2, 3, 4, 5, 6, 7])) === 0 &&
    busChannelBank(spec([15, 14, 13, 12, 11, 10, 9, 8])) === 8 &&
    busChannelBank(spec([31, 30, 29, 28, 27, 26, 25, 24])) === 24;
  const rejected = busChannelBank(spec([0, 1, 2, 3])) === null &&
    busChannelBank(spec([1, 2, 3, 4, 5, 6, 7, 8])) === null &&
    busChannelBank(spec([0, 1, 2, 3, 4, 5, 6, 8])) === null &&
    busChannelBank(spec([0, 1, 2, 3, 4, 5, 6, 6])) === null;
  check('only eight aligned consecutive data bits identify an analog bank',
    recognized && rejected, `recognized=${recognized}, rejected=${rejected}`);
}

{
  // HSync model.rs: the SLogic32U3's ADC module has four groups, the 16U3 none, and a
  // group is read only when its whole eight inputs are inside the wire mode.
  const counts = [4, 8, 16, 32, 64].map(analogGroupCount).join(',');
  const activeAt = (channels: number) => analogBankActive([analogBusConfig(0, 32, '#fff')], channels);
  const genericEight = { spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' as const } };
  const markerOnly = !analogBankActive([genericEight], 8) &&
    lockedChannelBanks([genericEight], 8).size === 0;
  const gated = analogGroupCount(8) === 1 && analogGroupCount(16) === 2 &&
    analogGroupCount(32) === 4 && analogGroupCount(128) === ANALOG_GROUP_COUNT &&
    analogGroupCount(4) === 0 && analogGroupCount(0) === 0 && markerOnly;
  check('analog groups cover complete eight-input banks up to the module\'s four',
    counts === '0,1,2,4,4' && gated && activeAt(8) && !activeAt(4),
    `counts=${counts}, active@8=${activeAt(8)}, active@4=${activeAt(4)}, markerOnly=${markerOnly}`);
}

{
  // Profile scale (hardware team, 2026-11-06): 1.6 V * 20 / 255 per code, 0 V at 128.
  const codes = [-16.0628, 0, 15.9373, -99, 99, -15, 15].map((v) => analogCodeFromVolts(v));
  const volts = [0, 128, 255].map((c) => analogVoltsFromCode(c));
  check('ADC trigger levels map the module\'s -16.063..+15.937 V range onto codes 0..255',
    codes.join(',') === '0,128,255,0,255,8,248' &&
    Math.abs(ADC_LSB_V - 1.6 * 20 / 255) < 1e-12 && ADC_ZERO_CODE === 128 && ADC_MAX_CODE === 255 &&
    Math.abs(volts[0]! + 128 * 32 / 255) < 1e-9 && volts[1] === 0 &&
    Math.abs(volts[2]! - 127 * 32 / 255) < 1e-9,
    `codes=${codes.join(',')}, volts=${volts.join(',')}`);
}

{
  const rising = analogTriggerVolts('rising', -99);
  const falling = analogTriggerVolts('falling', 99);
  const mid = analogTriggerVolts('rising', 1.2);
  check('trigger levels snap to the converter grid and move the unreachable endpoints inward',
    rising === Number(analogVoltsFromCode(1).toFixed(4)) && rising === -15.9373 &&
    falling === Number(analogVoltsFromCode(254).toFixed(4)) && falling === 15.8118 &&
    mid === 1.2549,
    `rising=${rising}, falling=${falling}, mid=${mid}`);
}

{
  // HSync adc.rs: divisors of the module's 800 MHz clock from 100 MHz up; only the
  // slower divisors where the link cannot carry that minimum.
  const under = (ceiling: number) => SAMPLERATES_HZ.filter((r) => r <= ceiling);
  const mhz = (rates: number[]) => rates.map((r) => r / 1e6).join(',');
  const wide = mhz(analogSamplerates(under(800e6)));
  const narrow = mhz(analogSamplerates(under(200e6)));
  const usb2 = mhz(analogSamplerates(under(10e6)));
  const odd = analogSamplerates([1.4e9, 5e6]);
  check('analog rates divide the 800 MHz clock from 100 MHz, or fall back to slower divisors',
    ADC_CLOCK_HZ === 800e6 && ADC_MIN_SAMPLERATE_HZ === 100e6 &&
    wide === '100,160,200,400,800' && narrow === '100,160,200' &&
    usb2 === '5,8,10' && odd.length === 1 && odd[0] === 5e6,
    `wide=${wide}, narrow=${narrow}, usb2=${usb2}, odd=${odd.join(',')}`);
}

{
  const atZero = analogBusConfig(0, 32, '#4C9AFF');
  const atOne = analogBusConfig(8, 16, '#4C9AFF');
  const fixed = atZero.name === 'A0' && atOne.name === 'A1' &&
    atZero.bitOrder === 'msb' && atZero.spec.encoding === 'unsigned' &&
    atZero.spec.clock === null && atZero.hideSources === true &&
    Math.abs(atZero.fullScaleV! - 32) < 1e-9 && Math.abs(atZero.offsetV + 128 * 32 / 255) < 1e-9;
  // MSB first: input 0 is the converter's MSB, so the LSB-first bit list ends with it.
  const msbFirst = atZero.spec.bits.join(',') === '7,6,5,4,3,2,1,0' &&
    atOne.spec.bits.join(',') === '15,14,13,12,11,10,9,8';
  let invalid = false;
  try { analogBusConfig(4, 8, '#fff'); } catch (e) { invalid = e instanceof RangeError; }
  check('the Analog button creates a fixed MSB-first A0-A3 view over the profile scale',
    fixed && msbFirst && invalid,
    `name=${atZero.name}/${atOne.name}, bits0=${atZero.spec.bits}, bits1=${atOne.spec.bits}, ` +
    `order=${atZero.bitOrder}, scale=${atZero.offsetV}..${atZero.fullScaleV}, invalid=${invalid}`);
}

{
  // Code 0 is -16.063 V and code 255 +15.937 V; code 128 reads 0 V.
  const view = analogBusConfig(0, 8, '#fff');
  const low = busLabel(view, 0);
  const mid = busLabel(view, 128);
  const high = busLabel(view, 255);
  const midVolts = Number.parseFloat(mid) * (mid.includes('mV') ? 1e-3 : 1);
  check('analog codes map onto the module\'s profile range',
    low === '-16.06 V' && high === '15.94 V' && Math.abs(midVolts) < 1e-9,
    `0=${low}, 128=${mid}, 255=${high}`);
}

{
  const spec = (bits: number[]) => ({ bits, clock: null, encoding: 'unsigned' as const });
  const bankZero = spec([0, 1, 2, 3, 4, 5, 6, 7]);
  const locked = lockedChannelBanks([
    { spec: spec([15, 14, 13, 12, 11, 10, 9, 8]), analogGroup: 1 },
    { spec: spec([0, 1, 2, 3]), analogGroup: 0 },
    { spec: spec([1, 2, 3, 4, 5, 6, 7, 8]), analogGroup: 0 },
  ]);
  const narrow = lockedChannelBanks([{ spec: bankZero, analogGroup: 0 }], 4);
  const valid = lockedChannelBanks([{ spec: bankZero, analogGroup: 0 }], 8);
  const clocked = { ...bankZero, clock: { channel: 8, edge: 'rising' as const } };
  const clockNarrow = lockedChannelBanks([{ spec: clocked, analogGroup: 0 }], 8);
  const clockWide = lockedChannelBanks([{ spec: clocked, analogGroup: 0 }], 16);
  check('locked banks require an aligned eight-bit bus whose whole spec is valid at the current width',
    locked.size === 1 && locked.has(8) && !locked.has(0) && narrow.size === 0 &&
    valid.size === 1 && valid.has(0) && clockNarrow.size === 0 && clockWide.size === 1 && clockWide.has(0),
    `base=${[...locked]}, narrow=${[...narrow]}, valid=${[...valid]}, ` +
    `clockNarrow=${[...clockNarrow]}, clockWide=${[...clockWide]}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const busPanel = fs.readFileSync('src/ui/busPanel.ts', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

  const rows = panel.includes('for (const start of channelBankStarts(v.channels.length))') &&
    panel.includes('const indices = channelBankIndices(start, v.channels.length);') &&
    panel.includes('const active = activeBanks.has(start);') &&
    panel.includes('const usable = indices.length === CHANNEL_BANK_SIZE && group < v.analogGroups;');
  const rightSide = panel.includes('bank.appendChild(analogButton(start, active, usable && !analogBusy, hint,') &&
    panel.indexOf('bank.appendChild(grid);') >= 0 &&
    panel.indexOf('bank.appendChild(grid);') < panel.indexOf('bank.appendChild(analogButton(');
  // The cell is the gain control (analog-gain-cell-selftest drives it).
  const analogCell = panel.includes("const cell = div('analog-cell');") &&
    panel.includes('const gainCell = analogGainCell({') &&
    panel.includes('bank.appendChild(gainCell.cell);') &&
    panel.includes('label.title = analogInputHint(start, o.total, gain);') &&
    panel.includes("return t('capturePanel.analogEnable', {");
  const button = panel.includes("b.textContent = t('capturePanel.analog');") &&
    panel.includes("b.disabled = !enabled;") &&
    panel.includes("b.setAttribute('aria-pressed', String(active));") &&
    panel.includes("b.dataset.analogToggle = String(start);");
  const widthSelector = panel.includes('const widthOptions = v.widthOptions;') &&
    panel.includes('widthOptions: readonly number[];') &&
    panel.includes("b.textContent = `${n}CH`") &&
    panel.includes('b.disabled = v.stopping;');
  check('the Device panel renders one right-side Analog button per bank, including partial rows',
    rows && rightSide && analogCell && button && widthSelector,
    `rows=${rows}, right=${rightSide}, cell=${analogCell}, button=${button}, width=${widthSelector}`);

  const analogRates = panel.includes('const analogRates = activeBanks.size > 0 ? analogSamplerates(supported) : [];') &&
    panel.includes('const selectable = analogRates.length > 0 ? analogRates : supported;') &&
    panel.includes("t('capturePanel.analogRateNote')");
  const clamp = app.includes('private clampSettings(s: CaptureSettings): CaptureSettings') &&
    app.includes('analogBankActive(this.busViews, s.channels)') &&
    app.includes('analogSamplerates(SAMPLERATES_HZ.filter((rate) => rate <= ceiling))') &&
    app.includes('if (allowed.length > 0 && !allowed.includes(samplerate))');
  check('an active analog bank narrows the rate list to the ADC clock\'s divisors',
    analogRates && clamp, `panel=${analogRates}, clamp=${clamp}`);

  const toggle = app.includes('onToggleAnalog: (start) => this.toggleAnalog(start)') &&
    app.includes('private toggleAnalog(start: number): void') &&
    app.includes('if (start / CHANNEL_BANK_SIZE >= this.analogGroups()) return;') &&
    app.includes('...analogBusConfig(start, this.channels.length, color,') &&
    app.includes('this.busViews = this.busViews.filter((b) => b.analogGroup !== group);') &&
    app.includes('this.afterChannelChange();');
  const groups = app.includes('private analogGroups(): number') &&
    app.includes('private deviceAnalogGroups(): number') &&
    app.includes('(this.device.maxChannels ?? 0) >= 32') &&
    app.includes('this.loadedCapture() && this.channels.length >= 32') &&
    app.includes('analogGroupCount(this.renderChannelCount())') &&
    app.includes('analogGroups: this.analogGroups(),');
  const normalization = app.includes('private normalizeAnalogBanks(): void') &&
    app.includes('this.normalizeAnalogBanks();') &&
    app.includes('if (this.deviceAnalogGroups() === 0) {') &&
    app.includes('this.busViews = this.busViews.filter((bus) => bus.analogGroup === undefined);');
  check('App toggles the bank directly, gates it to the 32U3 and normalizes restored banks',
    toggle && groups && normalization, `toggle=${toggle}, groups=${groups}, normalize=${normalization}`);

  const retired = !panel.includes('oscilloscopeButton') && !panel.includes('oscilloscope') &&
    !panel.includes('channel-bank-sep') && !panel.includes('adc-channel-overlay') &&
    !panel.includes('chip.disabled = locked') &&
    !app.includes('BankBusDialog') && !app.includes('bankBusDrafts') &&
    !app.includes('openBankBus') && !app.includes('configureBankBus') &&
    !app.includes('retranslateBankBusConfig') && !app.includes('normalizeBankBusConfig') &&
    !busPanel.includes('BankBusDialog') && !busPanel.includes('bus.bankDialogTitle') &&
    !busPanel.includes('bus.enableBank');
  const fixedBank = app.includes('if (bus.analogGroup !== undefined) return;') &&
    busPanel.includes("if (b.analogGroup === undefined) {\n      const edit = button(t('bus.editButton'), 'bus-btn');") &&
    busPanel.includes('if (bus.analogGroup !== undefined) return;');
  check('the enable/MSB-LSB dialog is gone; an analog bank is fixed and not editable as a bus',
    retired && fixedBank, `retired=${retired}, fixed=${fixedBank}`);

  const sheetRules = sheet.includes('.analog-button {') && sheet.includes('.analog-button.on') &&
    sheet.includes('.analog-button:disabled') && sheet.includes('.analog-cell {') &&
    !sheet.includes('.adc-button') && !sheet.includes('.channel-bank-sep') &&
    !sheet.includes('.adc-channel-overlay') && !sheet.includes('.adc-locked');
  check('the sheet styles the text button and the analog cell, with the icon controls removed',
    sheetRules, `rules=${sheetRules}`);

  const widthPanel = panel.includes('widthOptions: readonly number[];') &&
    !panel.includes('channelWidthOptions(') &&
    panel.includes('onChannelWidth(channels: number): void') &&
    panel.includes('chSec.header.appendChild(widths)');
  const widthApp = app.includes('onChannelWidth: (n) => this.setChannelWidth(n)') &&
    app.includes('widthOptions: this.widthTiers()') &&
    app.includes('if (!this.widthTiers().includes(channels)) return;') &&
    app.includes('this.applySettings({ ...this.settings, channels });');
  const widthSheet = sheet.includes('.digital-section .panel-section-head > .channel-widths { flex: none; }') &&
    sheet.includes('.channel-widths .seg { padding: 1px 6px; font-size: 10px; }');
  check('the Device panel renders the channel-width selector through the App width setter',
    widthPanel && widthApp && widthSheet,
    `panel=${widthPanel}, app=${widthApp}, sheet=${widthSheet}`);

  const busGuards = app.includes('this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, channels));') &&
    app.includes('if (busOutOfWidth(cfg.spec, this.renderChannelCount())) return null;') &&
    app.includes('if (busOutOfWidth(cfg.spec, this.renderChannelCount())) return false;') &&
    !app.includes('scopeOutOfWidth');
  const clipApp = app.includes('private displayChannelCount(): number') &&
    app.includes('return this.loadedCapture() ? this.channels.length : this.settings.channels;') &&
    app.includes('if (index >= this.renderChannelCount()) return;') &&
    app.includes('lockedChannelBanks(this.busViews, this.renderChannelCount())') &&
    app.includes('private renderChannelCount(): number');
  check('width switching and channel locks still share the out-of-width test',
    busGuards && clipApp, `guards=${busGuards}, clip=${clipApp}`);
}

{
  const spec = (bits: number[], clock: number | null = null) => ({
    bits, clock: clock === null ? null : { channel: clock, edge: 'rising' as const }, encoding: 'unsigned' as const,
  });
  const options = channelWidthOptions(4).join(',') + '|' + channelWidthOptions(8).join(',') + '|' +
    channelWidthOptions(16).join(',') + '|' + channelWidthOptions(32).join(',') + '|' +
    channelWidthOptions(128).join(',');
  const edge = channelWidthOptions(7).join(',') === '4' && channelWidthOptions(0).join(',') === '' &&
    channelWidthOptions(17).join(',') === '4,8,16' && channelWidthOptions(3).join(',') === '';
  check('channel width options follow the model width without inventing tiers',
    CHANNEL_WIDTH_OPTIONS.join(',') === '4,8,16,32' && options === '4|4,8|4,8,16|4,8,16,32|4,8,16,32' && edge,
    `declared=${CHANNEL_WIDTH_OPTIONS}, 4=${channelWidthOptions(4)}, 8=${channelWidthOptions(8)}, ` +
    `16=${channelWidthOptions(16)}, 32=${channelWidthOptions(32)}, 128=${channelWidthOptions(128)}, ` +
    `3=${channelWidthOptions(3)}, 7=${channelWidthOptions(7)}, 17=${channelWidthOptions(17)}`);

  const tierValues = [
    captureWidthTiers(null, false), captureWidthTiers(16, false), captureWidthTiers(32, false),
    captureWidthTiers(8, false), captureWidthTiers(32, true), captureWidthTiers(16, true),
  ].map((list) => list.join(','));
  check('width tiers need a connected device and a capture that does not fix the width',
    tierValues.join('|') === '|4,8,16|4,8,16,32|4,8||',
    ['null,false', '16,false', '32,false', '8,false', '32,true', '16,true']
      .map((t, i) => `${t}=[${tierValues[i]}]`).join(', '));

  const clock20 = busOutOfWidth(spec([0, 1, 2, 3, 4, 5, 6, 7], 20), 16);
  const clock20Wide = busOutOfWidth(spec([0, 1, 2, 3, 4, 5, 6, 7], 20), 32);
  const bank8 = busOutOfWidth(spec([8, 9, 10, 11, 12, 13, 14, 15]), 8);
  const bank8Wide = busOutOfWidth(spec([8, 9, 10, 11, 12, 13, 14, 15]), 16);
  const descending = busOutOfWidth(spec([15, 14, 13, 12, 11, 10, 9, 8]), 8);
  const plain = busOutOfWidth(spec([0, 2, 3]), 4);
  const genericOut = busOutOfWidth(spec([0, 2, 4, 9]), 8);
  check('bus removal follows data bits and external clock against the new width',
    clock20 && !clock20Wide && bank8 && !bank8Wide && descending && !plain && genericOut,
    `clock20@16=${clock20}, clock20@32=${clock20Wide}, bank8@8=${bank8}, bank8@16=${bank8Wide}, ` +
    `desc@8=${descending}, plain@4=${plain}, genericOut@8=${genericOut}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
