// SPDX-License-Identifier: GPL-3.0-or-later

import {
  CHANNEL_BANK_SIZE, channelBankIndices, channelBankRange, channelBankStart, channelBankStarts,
  channelBankStatus, clearChannelBanks, toggleChannelBank, type ChannelEnableState,
} from '../channelBanks.js';

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
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const grouped = panel.includes('for (const start of channelBankStarts(v.channels.length))') &&
    panel.includes('channelBankStatus(v.channels, start)') &&
    panel.includes('channelBankIndices(start, v.channels.length)') &&
    panel.includes("div('chip-grid channel-bank-grid')") &&
    panel.includes('chSec.body.appendChild(banks)');
  const accessible = panel.includes("toggle.type = 'checkbox'") &&
    panel.includes("toggle.indeterminate = status.state === 'mixed'") &&
    panel.includes("t('capturePanel.bankToggle', { range })") &&
    panel.includes("chip.setAttribute('aria-pressed', String(c.enabled))");
  const wired = app.includes('onToggleBank: (start) => this.setBankEnabled(start)') &&
    app.includes('const next = toggleChannelBank(this.channels, start);') &&
    app.includes('const next = clearChannelBanks(this.channels);');
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
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
