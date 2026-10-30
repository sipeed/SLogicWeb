// SPDX-License-Identifier: GPL-3.0-or-later

import {
  CHANNEL_BANK_SIZE, CHANNEL_WIDTH_OPTIONS, busChannelBank, channelBankIndices, channelBankRange,
  channelBankStart, channelBankStarts, channelWidthOptions, lockedChannelBanks, scopeOutOfWidth,
} from '../channelBanks.js';
import { defaultBankBusConfig, normalizeBankBusConfig } from '../busPanel.js';

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
  check('only eight aligned consecutive data bits identify an oscilloscope bank',
    recognized && rejected, `recognized=${recognized}, rejected=${rejected}`);
}

{
  const base = defaultBankBusConfig(16, 8);
  const reversed = normalizeBankBusConfig({
    ...base,
    spec: {
      bits: [15, 14, 13, 12, 11, 10, 9, 8],
      clock: { channel: 3, edge: 'falling' },
      encoding: 'twos',
    },
  }, 16, 8);
  const inside = normalizeBankBusConfig({
    ...base, spec: { ...base.spec, clock: { channel: 10, edge: 'rising' } },
  }, 16, 8);
  const outside = normalizeBankBusConfig({
    ...base, spec: { ...base.spec, clock: { channel: 99, edge: 'rising' } },
  }, 16, 8);
  const shuffled = normalizeBankBusConfig({
    ...base,
    spec: { ...base.spec, bits: [10, 15, 8, 12, 9, 14, 11, 13] },
  }, 16, 8);
  const repaired = normalizeBankBusConfig({
    ...base,
    spec: { ...base.spec, bits: [10, 10, 99, 8, 7, -1, 12] },
  }, 16, 8);
  const normalized = base.spec.bits.join(',') === '8,9,10,11,12,13,14,15' &&
    reversed.spec.bits.join(',') === '15,14,13,12,11,10,9,8' &&
    shuffled.spec.bits.join(',') === '10,15,8,12,9,14,11,13' &&
    repaired.spec.bits.join(',') === '10,8,12,9,11,13,14,15' &&
    reversed.spec.clock?.channel === 3 && reversed.spec.clock.edge === 'falling' &&
    reversed.spec.encoding === 'twos' && inside.spec.clock === null && outside.spec.clock === null;
  let invalid = false;
  try { defaultBankBusConfig(4, 0); } catch (e) { invalid = e instanceof RangeError; }
  check('fixed-bank config preserves arbitrary order, repairs invalid bits and drops invalid clocks',
    normalized && invalid, `normalized=${normalized}, invalidStart=${invalid}`);
}

{
  const base = defaultBankBusConfig(16, 0);
  const custom = normalizeBankBusConfig({ ...base, name: '  CUSTOM  ', usesDefaultName: false }, 16, 0);
  const blank = normalizeBankBusConfig({ ...base, name: ' ', usesDefaultName: false }, 16, 0);
  const defaults = base.name === 'Analog waveform' && base.usesDefaultName === true &&
    blank.name === 'Analog waveform' && blank.usesDefaultName === true;
  const customized = custom.name === 'CUSTOM' && custom.usesDefaultName !== true;
  check('bank names track the default marker while custom and blank drafts keep distinct semantics',
    defaults && customized,
    `base=${base.name}/${base.usesDefaultName}, custom=${custom.name}/${custom.usesDefaultName}, ` +
    `blank=${blank.name}/${blank.usesDefaultName}`);
}

{
  const spec = (bits: number[]) => ({ bits, clock: null, encoding: 'unsigned' as const });
  const bankZero = spec([0, 1, 2, 3, 4, 5, 6, 7]);
  const locked = lockedChannelBanks([
    { spec: spec([15, 14, 13, 12, 11, 10, 9, 8]) },
    { spec: spec([0, 1, 2, 3]) },
    { spec: spec([1, 2, 3, 4, 5, 6, 7, 8]) },
  ]);
  const narrow = lockedChannelBanks([{ spec: bankZero }], 4);
  const valid = lockedChannelBanks([{ spec: bankZero }], 8);
  const clocked = { ...bankZero, clock: { channel: 8, edge: 'rising' as const } };
  const clockNarrow = lockedChannelBanks([{ spec: clocked }], 8);
  const clockWide = lockedChannelBanks([{ spec: clocked }], 16);
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
  const scopeBlockStart = panel.indexOf('if (indices.length === CHANNEL_BANK_SIZE) {');
  const scopeBlock = scopeBlockStart >= 0
    ? panel.slice(scopeBlockStart, panel.indexOf('const grid = div(', scopeBlockStart))
    : '';
  const grouped = panel.includes('for (const start of channelBankStarts(v.channels.length))') &&
    panel.includes('const indices = channelBankIndices(start, v.channels.length);') &&
    scopeBlockStart >= 0 &&
    scopeBlock.includes('oscilloscopeButton') && scopeBlock.includes("div('channel-bank-sep')") &&
    !panel.includes('channel-bank-head') &&
    panel.includes("div('chip-grid channel-bank-grid')") &&
    panel.includes('chSec.body.appendChild(banks)');
  const accessible = panel.includes("grid.setAttribute('role', 'group')") &&
    panel.includes("grid.setAttribute('aria-label', range)") &&
    panel.includes("chip.setAttribute('aria-pressed', String(c.enabled))");
  const wired = app.includes('onChannelWidth: (n) => this.setChannelWidth(n)') &&
    !panel.includes('capturePanel.all') && !panel.includes('channel-enabled-count');
  const grid = sheet.includes('grid-template-columns: repeat(8, minmax(0, 1fr))') &&
    sheet.includes('.channel-bank-sep') && !sheet.includes('.channel-bank-head') &&
    sheet.includes('.channel-bank { display: flex; align-items: center; gap: 6px; min-width: 0; }') &&
    sheet.includes('.channel-bank-grid { flex: 1 1 auto; position: relative; min-width: 0; }');
  check('the real Device panel renders accessible eight-channel banks through App state',
    grouped && accessible && wired && grid,
    `grouped=${grouped}, accessible=${accessible}, wired=${wired}, grid=${grid}`);

  const retiredControls = !panel.includes('channel-bank-toggle') &&
    !panel.includes('channel-bank-title') && !panel.includes('channel-bank-count') &&
    !panel.includes('capturePanel.bankToggle') && !panel.includes('capturePanel.bankLocked') &&
    !panel.includes('onToggleBank') && !app.includes('onToggleBank') &&
    !app.includes('setBankEnabled');
  check('the per-bank toggle, its group title and its count are gone from panel and App',
    retiredControls, `retiredControls=${retiredControls}`);

  const retiredSheet = !sheet.includes('.channel-bank-toggle') &&
    !sheet.includes('.channel-bank-title') && !sheet.includes('.channel-bank-count');
  check('the retired per-bank control styles are gone from the sheet',
    retiredSheet, `retiredSheet=${retiredSheet}`);

  const iconStart = panel.indexOf('function oscilloscopeButton');
  const icon = panel.slice(iconStart, panel.indexOf('function nearest', iconStart));
  const iconOnly = iconStart >= 0 && icon.includes('createElementNS') &&
    icon.includes("b.setAttribute('aria-haspopup', 'dialog')") && !icon.includes('textContent');
  const dialog = busPanel.split('export class BankBusDialog')[1] ?? '';
  const sharedFields = busPanel.includes('function busAdvancedFields') &&
    (busPanel.match(/busAdvancedFields\(/g) ?? []).length === 2 && busPanel.includes('clockOptions') &&
    !dialog.includes('busAdvancedFields') && !busPanel.includes('bankStart');
  const draftOrderWrite = dialog.includes('    };\n    writeOrder();\n    order.disabled = context.locked;');
  const orderChange = dialog.includes("    order.addEventListener('change', writeOrder);\n    body.appendChild(order.el);");
  const orderMode = dialog.includes("const order = selectControl('bus.channelOrder', t('bus.channelOrder')") &&
    dialog.includes("[['lsb', 'LSB'], ['msb', 'MSB']]") &&
    dialog.includes("runStart(config.spec.bits).msbFirst ? 'msb' : 'lsb'") &&
    dialog.includes("bits: runBits(this.start, CHANNEL_BANK_SIZE, this.channelCount, order.value === 'msb')") &&
    draftOrderWrite && orderChange &&
    !dialog.includes('new Oscilloscope' + 'ChannelGrid') && !dialog.includes("t('bus.drag" + "ToOrder')") &&
    !dialog.includes("t('bus.msbFirst')") && !dialog.includes("t('bus.perBit')") &&
    !dialog.includes('bankEnabledNote');
  const disclosures = dialog.includes('details?.el.remove()') &&
    !dialog.includes("document.createElement('details')") && !dialog.includes("t('bus.advanced')") &&
    !dialog.includes('oscilloscopeAdvanced');
  const nativeDialog = busPanel.includes('this.dialog.showModal()') &&
    busPanel.indexOf("this.dialog.close('applied')") >= 0 &&
    busPanel.indexOf("this.dialog.close('applied')") < busPanel.indexOf('this.cb.onConfirm(this.start');
  const realState = panel.includes('buses: readonly BusViewState[]') &&
    app.includes('buses: this.busViews') && app.includes('this.configureBankBus(start, cfg, enabled)') &&
    app.includes('if (active) this.updateBus(active.id, next, true);') && app.includes('else this.addBus(next);');
  check('the bank dialog uses shared advanced fields and a two-mode canonical order draft',
    iconOnly && sharedFields && orderMode && disclosures && nativeDialog && realState,
    `iconOnly=${iconOnly}, sharedFields=${sharedFields}, orderMode=${orderMode}, ` +
    `disclosures=${disclosures}, nativeDialog=${nativeDialog}, realState=${realState}`);

  const loopDecoupled = !dialog.includes('loopSamples') && !dialog.includes('maxLoopTimeValue') &&
    !dialog.includes('data-loop-input') && !dialog.includes('bank-bus-loop') &&
    app.includes('private bankCaptureSettings(start: number, config: BusViewConfig): CaptureSettings') &&
    app.includes('{ ...this.settings, channels }, this.rateCeilings') &&
    app.includes('this.settings = this.bankCaptureSettings(start, next);') &&
    !app.includes('loopSamples: preview.loopSamples') && !app.includes('captureChannels: preview.channels') &&
    app.includes('channelWidthForProbes(config.spec.clock.channel + 1)') &&
    app.includes('activeBanks.has(bank) && bus.spec.clock');
  const updateBus = app.split('private updateBus(')[1]?.split('private removeBus(')[0] ?? '';
  const names = busPanel.includes("t('bus.defaultName')") &&
    app.includes('retranslateBankBusConfig(bus)') && app.includes('retranslateBankBusConfig(draft)') &&
    updateBus.includes('if (!preserveDefaultName && next.name !== current.name) delete next.usesDefaultName;') &&
    app.includes('this.updateBus(active.id, next, true)');
  const locks = dialog.includes('enable.disabled = context.locked') &&
    dialog.includes('confirm.disabled = context.locked') && dialog.includes('order.disabled = context.locked') &&
    app.includes('if (this.running || this.stopping ||') && app.includes('locked: this.running || this.stopping');
  const noBankSwap = busPanel.includes('if (busChannelBank(b.spec) === null) {');
  const editBus = app.split('private editBus(')[1]?.split('private addBus(')[0] ?? '';
  const bankEditor = editBus.includes('const bank = busChannelBank(bus.spec)') &&
    editBus.includes('bank !== null && this.openBankBus(bank)') && editBus.includes('this.busPanel.edit(bus)') &&
    app.includes('private openBankBus(start: number): boolean') &&
    app.includes('length !== CHANNEL_BANK_SIZE) return false;') && app.includes('return true;') &&
    app.includes('onEditBus: (id) => this.editBus(id)') && app.includes('onEdit: (id) => this.editBus(id)') &&
    busPanel.includes("edit.addEventListener('click', () => this.cb.onEdit(b.id))");
  check('the bank dialog no longer owns the loop window and App keeps loopSamples in settings',
    loopDecoupled && names && locks && noBankSwap && bankEditor,
    `loopDecoupled=${loopDecoupled}, names=${names}, locks=${locks}, noBankSwap=${noBankSwap}, bankEditor=${bankEditor}`);

  const modelLock = (app.match(/lockedChannelBanks\(this.busViews, this.channels.length\)/g) ?? []).length >= 4 &&
    app.includes('locked.has(channelBankStart(c.index))');
  const visualLock = panel.includes('lockedChannelBanks(v.buses, v.channels.length)') &&
    panel.includes('grid.dataset.adcLocked = String(locked)') && panel.includes('chip.disabled = locked') &&
    panel.includes("t('capturePanel.oscilloscopeActive')") &&
    sheet.includes('pointer-events: none') && sheet.includes('brightness(0.88)');
  check('active bus banks enforce model locks and render the non-interactive localized overlay',
    modelLock && visualLock, `modelLock=${modelLock}, visualLock=${visualLock}`);

  const widthPanel = panel.includes('channelWidthOptions(v.channels.length)') &&
    panel.includes("b.className = 'seg' + (s.channels === n ? ' on' : '')") &&
    panel.includes("b.dataset.channelWidth = String(n)") &&
    panel.includes('b.disabled = v.running || v.stopping') &&
    panel.includes("b.title = t('capturePanel.channelWidthBusy')") &&
    panel.includes("widths.setAttribute('aria-label', t('capturePanel.channelWidth'))") &&
    panel.includes('onChannelWidth(channels: number): void') &&
    panel.includes('chSec.header.appendChild(widths)');
  const widthSetter = app.split('private setChannelWidth(channels: number): void')[1]?.split('private afterChannelChange(')[0] ?? '';
  const widthApp = app.includes('onChannelWidth: (n) => this.setChannelWidth(n)') &&
    app.includes('private setChannelWidth(channels: number): void') &&
    app.includes('!scopeOutOfWidth(bus.spec, channels)') &&
    app.includes('this.channels[i]!.enabled = i < channels') &&
    widthSetter.includes('if (this.running || this.stopping) return;') &&
    widthSetter.includes('this.afterChannelChange();');
  const widthSheet = sheet.includes('.digital-section .panel-section-head > .channel-widths { flex: none; }') &&
    sheet.includes('.channel-widths .seg { padding: 1px 6px; font-size: 10px; }');
  check('the Device panel renders the channel-width selector through the App width setter',
    widthPanel && widthApp && widthSheet,
    `panel=${widthPanel}, app=${widthApp}, sheet=${widthSheet}`);
}

{
  const spec = (bits: number[], clock: number | null = null) => ({
    bits, clock: clock === null ? null : { channel: clock, edge: 'rising' as const }, encoding: 'unsigned' as const,
  });
  const options = channelWidthOptions(4).join(',') + '|' + channelWidthOptions(8).join(',') + '|' +
    channelWidthOptions(16).join(',') + '|' + channelWidthOptions(32).join(',') + '|' +
    channelWidthOptions(128).join(',');
  const edge = channelWidthOptions(7).join(',') === '' && channelWidthOptions(0).join(',') === '' &&
    channelWidthOptions(17).join(',') === '8,16';
  check('channel width options follow the model width without inventing tiers',
    CHANNEL_WIDTH_OPTIONS.join(',') === '8,16,32' && options === '|8|8,16|8,16,32|8,16,32' && edge,
    `declared=${CHANNEL_WIDTH_OPTIONS}, 4=${channelWidthOptions(4)}, 8=${channelWidthOptions(8)}, ` +
    `16=${channelWidthOptions(16)}, 32=${channelWidthOptions(32)}, 128=${channelWidthOptions(128)}, ` +
    `7=${channelWidthOptions(7)}, 17=${channelWidthOptions(17)}`);

  const clock20 = scopeOutOfWidth(spec([0, 1, 2, 3, 4, 5, 6, 7], 20), 16);
  const clock20Wide = scopeOutOfWidth(spec([0, 1, 2, 3, 4, 5, 6, 7], 20), 32);
  const bank8 = scopeOutOfWidth(spec([8, 9, 10, 11, 12, 13, 14, 15]), 8);
  const bank8Wide = scopeOutOfWidth(spec([8, 9, 10, 11, 12, 13, 14, 15]), 16);
  const descending = scopeOutOfWidth(spec([15, 14, 13, 12, 11, 10, 9, 8]), 8);
  const plain = scopeOutOfWidth(spec([0, 2, 4]), 4);
  check('scope removal follows bank data bits and external clock against the new width',
    clock20 && !clock20Wide && bank8 && !bank8Wide && descending && !plain,
    `clock20@16=${clock20}, clock20@32=${clock20Wide}, bank8@8=${bank8}, bank8@16=${bank8Wide}, ` +
    `desc@8=${descending}, plain@4=${plain}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
