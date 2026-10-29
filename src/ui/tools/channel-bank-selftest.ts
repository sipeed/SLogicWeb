// SPDX-License-Identifier: GPL-3.0-or-later

import {
  CHANNEL_BANK_SIZE, busChannelBank, channelBankIndices, channelBankRange, channelBankStart, channelBankStarts,
  channelBankStatus, clearChannelBanks, lockedChannelBanks, toggleChannelBank, type ChannelEnableState,
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

function channels(enabled: readonly number[], count = 16): ChannelEnableState[] {
  const on = new Set(enabled);
  return Array.from({ length: count }, (_, index) => ({ index, enabled: on.has(index) }));
}

function enabled(flags: readonly boolean[] | null): number[] {
  return flags?.flatMap((on, index) => on ? [index] : []) ?? [];
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
  const none = channelBankStatus(channels([], 16), 0);
  const mixed = channelBankStatus(channels([1, 4], 16), 0);
  const all = channelBankStatus(channels([0, 1, 2, 3, 4, 5, 6, 7], 16), 0);
  check('bank status distinguishes none, mixed and all',
    none.state === 'none' && none.enabled === 0 && none.total === 8 &&
    mixed.state === 'mixed' && mixed.enabled === 2 && mixed.total === 8 &&
    all.state === 'all' && all.enabled === 8 && all.total === 8,
    `none=${none.state}:${none.enabled}/${none.total}, mixed=${mixed.state}:${mixed.enabled}/${mixed.total}, all=${all.state}:${all.enabled}/${all.total}`);
}

{
  const input = channels([0, 1, 2, 3, 4, 5, 6, 7, 8], 16);
  const next = toggleChannelBank(input, 0);
  check('an all-enabled bank toggles off while preserving other banks',
    enabled(next).join(',') === '8' && input[0]?.enabled === true,
    `next=${enabled(next)}, input=${enabled(input.map((c) => c.enabled))}`);
}

{
  const next = toggleChannelBank(channels([1, 8], 16), 0);
  check('a mixed bank toggles fully on', enabled(next).join(',') === '0,1,2,3,4,5,6,7,8',
    enabled(next).join(','));
}

{
  const next = toggleChannelBank(channels([8], 16), 0);
  check('an empty bank toggles fully on', enabled(next).join(',') === '0,1,2,3,4,5,6,7,8',
    enabled(next).join(','));
}

{
  const input = channels([0, 1, 2, 3, 4, 5, 6, 7], 16);
  const before = JSON.stringify(input);
  const next = toggleChannelBank(input, 0);
  check('bank toggle rejects a transition to zero enabled channels',
    next === null && JSON.stringify(input) === before,
    `next=${next}, unchanged=${JSON.stringify(input) === before}`);
}

{
  const input = channels([0, 1, 2, 3], 4);
  const status = channelBankStatus(input, 0);
  const next = toggleChannelBank(input, 0);
  check('a partial four-channel bank uses its real total and zero guard',
    status.total === 4 && status.enabled === 4 && status.state === 'all' && next === null,
    `status=${status.state}:${status.enabled}/${status.total}, next=${next}`);
}

{
  const off = toggleChannelBank(channels(Array.from({ length: 17 }, (_, i) => i), 16), 8);
  const on = toggleChannelBank(channels([0, 9], 16), 8);
  check('a non-zero bank toggles off and on without changing bank zero',
    enabled(off).join(',') === '0,1,2,3,4,5,6,7' &&
    enabled(on).join(',') === '0,8,9,10,11,12,13,14,15',
    `off=${enabled(off)}, on=${enabled(on)}`);
}

{
  const next = toggleChannelBank(channels([0, 25, 29], 32), 24);
  check('the final bank of a 32-channel model toggles fully on',
    enabled(next).join(',') === '0,24,25,26,27,28,29,30,31', enabled(next).join(','));
}

{
  const input = channels([0, 1, 2, 3, 4, 5, 6, 7], 16);
  const status = channelBankStatus(input, 3);
  const next = toggleChannelBank(input, 3);
  check('unaligned bank starts are rejected by both status and toggle',
    status.total === 0 && status.enabled === 0 && status.state === 'none' && next === null,
    `status=${status.state}:${status.enabled}/${status.total}, next=${next}`);
}

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
  const input = channels([0, 1, 2, 3, 4, 5, 6, 7, 8], 16);
  const next = toggleChannelBank(input, 0, new Set([0]));
  check('bank toggle rejects a locked bank without mutating input', next === null && input[0]?.enabled === true,
    `next=${next}, D0=${input[0]?.enabled}`);
}

{
  const input = channels([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 16);
  const before = JSON.stringify(input);
  const cleared = clearChannelBanks(input);
  check('Clear without locked banks preserves only D0 without mutating input',
    enabled(cleared).join(',') === '0' && JSON.stringify(input) === before,
    `cleared=${enabled(cleared)}, unchanged=${JSON.stringify(input) === before}`);
}

check('Clear on a partial four-channel model preserves only real D0',
  enabled(clearChannelBanks(channels([0, 1, 2, 3], 4))).join(',') === '0' &&
  clearChannelBanks(channels([0, 1, 2, 3], 4)).length === 4,
  enabled(clearChannelBanks(channels([0, 1, 2, 3], 4))).join(','));

check('Clear restores every channel in locked banks and adds D0 when needed',
  enabled(clearChannelBanks(channels([8, 10], 16), new Set([8]))).join(',') === '0,8,9,10,11,12,13,14,15',
  enabled(clearChannelBanks(channels([8, 10], 16), new Set([8]))).join(','));

check('Clear with D0 locked preserves that whole bank without an extra channel',
  enabled(clearChannelBanks(channels([0, 8], 16), new Set([0]))).join(',') === '0,1,2,3,4,5,6,7',
  enabled(clearChannelBanks(channels([0, 8], 16), new Set([0]))).join(','));

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
  const grouped = panel.includes('for (const start of channelBankStarts(v.channels.length))') &&
    panel.includes('channelBankStatus(v.channels, start)') &&
    panel.includes('channelBankIndices(start, v.channels.length)') &&
    panel.includes("div('chip-grid channel-bank-grid')") &&
    panel.includes('chSec.body.appendChild(banks)');
  const accessible = panel.includes("toggle.type = 'checkbox'") &&
    panel.includes("toggle.indeterminate = status.state === 'mixed'") &&
    panel.includes("'capturePanel.bankToggle'") &&
    panel.includes("chip.setAttribute('aria-pressed', String(c.enabled))");
  const wired = app.includes('onToggleBank: (start) => this.setBankEnabled(start)') &&
    app.includes('const next = toggleChannelBank(this.channels, start, lockedChannelBanks(this.busViews, this.channels.length));') &&
    app.includes('const next = clearChannelBanks(this.channels, lockedChannelBanks(this.busViews, this.channels.length));');
  const grid = sheet.includes('grid-template-columns: repeat(8, minmax(0, 1fr))') &&
    sheet.includes('.channel-bank-head') && sheet.includes('.channel-bank-count');
  check('the real Device panel renders accessible eight-channel banks through App state',
    grouped && accessible && wired && grid,
    `grouped=${grouped}, accessible=${accessible}, wired=${wired}, grid=${grid}`);

  const rejectedBranch = panel.split('if (toggle.isConnected) {')[1]?.split('} else {')[0] ?? '';
  const rejectedSync = rejectedBranch.includes("toggle.checked = status.state === 'all'") &&
    rejectedBranch.includes("toggle.indeterminate = status.state === 'mixed'");
  const focusContinuity = panel.includes('this.root.querySelector<HTMLInputElement>(`[data-bank-toggle="${start}"]`)?.focus');
  check('bank toggles resync rejected native state and retain keyboard focus after rebuild',
    rejectedSync && focusContinuity, `rejectedSync=${rejectedSync}, focusContinuity=${focusContinuity}`);

  const iconStart = panel.indexOf('function oscilloscopeButton');
  const icon = panel.slice(iconStart, panel.indexOf('function nearest', iconStart));
  const iconOnly = iconStart >= 0 && icon.includes('createElementNS') &&
    icon.includes("b.setAttribute('aria-haspopup', 'dialog')") && !icon.includes('textContent');
  const dialog = busPanel.split('export class BankBusDialog')[1] ?? '';
  const sharedFields = busPanel.includes('function busAdvancedFields') &&
    (busPanel.match(/busAdvancedFields\(/g) ?? []).length >= 3 && busPanel.includes('bankStart: null') &&
    dialog.includes('bankStart: this.start') && busPanel.includes('clockOptions');
  const sortable = dialog.includes('new OscilloscopeChannelGrid') &&
    dialog.includes('config.spec = { ...config.spec, bits }') &&
    !dialog.includes("t('bus.msbFirst')") && !dialog.includes("t('bus.perBit')") &&
    !dialog.includes('runBits(') && !dialog.includes('bankEnabledNote');
  const disclosures = dialog.includes('details?.el.remove()') &&
    dialog.includes("document.createElement('details')") && dialog.includes("t('bus.advanced')");
  const nativeDialog = busPanel.includes('this.dialog.showModal()') &&
    busPanel.indexOf("this.dialog.close('applied')") >= 0 &&
    busPanel.indexOf("this.dialog.close('applied')") < busPanel.indexOf('this.cb.onConfirm(this.start');
  const realState = panel.includes('buses: readonly BusViewState[]') &&
    app.includes('buses: this.busViews') && app.includes('this.configureBankBus(start, cfg, enabled, loopSamples)') &&
    app.includes('if (active) this.updateBus(active.id, next, true);') && app.includes('else this.addBus(next);');
  check('the bank dialog uses shared advanced fields and a sortable draft without legacy bit controls',
    iconOnly && sharedFields && sortable && disclosures && nativeDialog && realState,
    `iconOnly=${iconOnly}, sharedFields=${sharedFields}, sortable=${sortable}, ` +
    `disclosures=${disclosures}, nativeDialog=${nativeDialog}, realState=${realState}`);

  const enableGate = dialog.includes('const enableBlock = context.enableBlock;') &&
    dialog.includes('enable.disabled = context.locked;') &&
    !dialog.includes('enable.disabled = context.locked ||') &&
    dialog.includes('enable.checked = false;') &&
    dialog.includes('showBlockNote();') &&
    dialog.includes("blockNote.dataset.scopeRateNote = '';") &&
    dialog.includes("div('panel-note error')") &&
    dialog.includes('enableLabel.after(blockNote);') &&
    dialog.includes('if (enabled && enableBlock !== null) {') &&
    dialog.includes("t('bus.scopeRateLimited', {") &&
    dialog.includes('formatRate(enableBlock.effectiveRate)') &&
    dialog.includes('formatRate(enableBlock.maxRate)') &&
    dialog.includes('if (blockNote === null) {') &&
    (dialog.match(/showBlockNote\(\);/g) ?? []).length === 2;
  const enCatalog2 = fs.readFileSync('src/ui/locales/en.ts', 'utf8');
  const rateLimitedKey = /'bus\.scopeRateLimited': '[^']*\{rate\}[^']*\{channels\}[^']*\{width\}[^']*\{maxRate\}[^']*'/.test(enCatalog2);
  check('the bank dialog blocks enable attempts with a lazy reason note and a submit guard',
    enableGate && rateLimitedKey, `enableGate=${enableGate}, rateLimitedKey=${rateLimitedKey}`);

  const editorGate = busPanel.includes('samplerate: number;') &&
    busPanel.includes('captureChannels: ChannelCount;') &&
    busPanel.includes('rateCeilings: Readonly<Record<number, number>>;') &&
    busPanel.includes('if (problems.length === 0 && draftBank !== null) {') &&
    busPanel.includes('scopeEnableVerdict({') &&
    busPanel.includes('currentWidth: v.captureChannels') &&
    busPanel.includes('rate: v.samplerate') &&
    busPanel.includes('ceilings: v.rateCeilings') &&
    busPanel.includes('deviceChannels: v.channelCount') &&
    busPanel.includes("err.textContent = t('bus.scopeRateLimited', {") &&
    busPanel.includes('formatRate(scopeBlock.effectiveRate)') &&
    busPanel.includes('channels: scopeBlock.maxWidth') &&
    busPanel.includes('width: scopeBlock.requiredWidth') &&
    busPanel.includes('formatRate(scopeBlock.maxRate)') &&
    busPanel.includes('go.disabled = problems.length > 0 || scopeBlock !== null ||') &&
    (busPanel.match(/err\.dataset\.scopeRateNote = '';/g) ?? []).length === 1 &&
    app.includes('samplerate: this.settings.samplerate, captureChannels: this.settings.channels');
  check('the generic bus editor blocks rate-limited bank drafts with the shared reason note',
    editorGate, `editorGate=${editorGate}`);

  const globalLoop = dialog.includes('loopSamplesFromTime') && dialog.includes('maxLoopTimeValue') &&
    dialog.includes('formatDuration(samples / context.samplerate)') &&
    app.includes('this.settings = this.bankCaptureSettings(start, loopSamples, next);') &&
    app.includes('this.bankCaptureSettings(start, this.settings.loopSamples, config)') &&
    app.includes('channelWidthForProbes(config.spec.clock.channel + 1)') &&
    app.includes('activeBanks.has(bank) && bus.spec.clock') &&
    app.includes('captureChannels: preview.channels') && app.includes('samplerate: preview.samplerate');
  const updateBus = app.split('private updateBus(')[1]?.split('private removeBus(')[0] ?? '';
  const names = busPanel.includes("t('bus.defaultName')") &&
    app.includes('retranslateBankBusConfig(bus)') && app.includes('retranslateBankBusConfig(draft)') &&
    updateBus.includes('if (!preserveDefaultName && next.name !== current.name) delete next.usesDefaultName;') &&
    app.includes('this.updateBus(active.id, next, true)');
  const locks = dialog.includes('enable.disabled = context.locked') &&
    dialog.includes('confirm.disabled = context.locked') && dialog.includes('disabled: context.locked') &&
    app.includes('if (this.running || this.stopping ||') && app.includes('locked: this.running || this.stopping');
  const noBankSwap = busPanel.includes('if (busChannelBank(b.spec) === null) {');
  const editBus = app.split('private editBus(')[1]?.split('private addBus(')[0] ?? '';
  const bankEditor = editBus.includes('const bank = busChannelBank(bus.spec)') &&
    editBus.includes('bank !== null && this.openBankBus(bank)') && editBus.includes('this.busPanel.edit(bus)') &&
    app.includes('private openBankBus(start: number): boolean') &&
    app.includes('length !== CHANNEL_BANK_SIZE) return false;') && app.includes('return true;') &&
    app.includes('onEditBus: (id) => this.editBus(id)') && app.includes('onEdit: (id) => this.editBus(id)') &&
    busPanel.includes("edit.addEventListener('click', () => this.cb.onEdit(b.id))");
  check('App wires global loop, localized names, capture locks and bank-only editing without reversal shortcuts',
    globalLoop && names && locks && noBankSwap && bankEditor,
    `globalLoop=${globalLoop}, names=${names}, locks=${locks}, noBankSwap=${noBankSwap}, bankEditor=${bankEditor}`);

  const modelLock = (app.match(/lockedChannelBanks\(this.busViews, this.channels.length\)/g) ?? []).length >= 4 &&
    app.includes('locked.has(channelBankStart(c.index))');
  const visualLock = panel.includes('lockedChannelBanks(v.buses, v.channels.length)') &&
    panel.includes('toggle.disabled = locked') && panel.includes('chip.disabled = locked') &&
    panel.includes("t('capturePanel.oscilloscopeActive')") &&
    sheet.includes('pointer-events: none') && sheet.includes('brightness(0.88)');
  check('active bus banks enforce model locks and render the non-interactive localized overlay',
    modelLock && visualLock, `modelLock=${modelLock}, visualLock=${visualLock}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
