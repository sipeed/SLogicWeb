// SPDX-License-Identifier: GPL-3.0-or-later

import {
  moveOscilloscopeChannel, orderOscilloscopeChannels, oscilloscopeBitLabel, oscilloscopeChannelLabel,
} from '../oscilloscopeChannels.js';
import type { ChannelState } from '../state.js';

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

const palette = ['#C81A21', '#E4602A', '#997100', '#5A7100', '#B0733C', '#3191D9', '#007971', '#E94D95'];
const channels: ChannelState[] = palette.map((color, index) => ({
  index, name: `D${index}`, color, enabled: true,
}));
const indices = (entries: readonly ChannelState[]): string => entries.map((channel) => channel.index).join(',');

{
  const requested = [7, 2, 5, 0, 6, 1, 4, 3];
  const ordered = orderOscilloscopeChannels(channels, requested);
  check('bank channels follow the exact requested LSB-first order',
    indices(ordered) === requested.join(',') && indices(channels) === '0,1,2,3,4,5,6,7',
    `ordered=${indices(ordered)}, input=${indices(channels)}`);

  const repaired = orderOscilloscopeChannels(channels, [7, 2, 7, 99]);
  check('ordering drops duplicates and foreign indices then appends missing bank channels',
    indices(repaired) === '7,2,0,1,3,4,5,6', indices(repaired));
}

{
  const input = orderOscilloscopeChannels(channels, [7, 2, 5, 0, 6, 1, 4, 3]);
  const before = indices(input);
  const forward = moveOscilloscopeChannel(input, 1, 5);
  const backward = moveOscilloscopeChannel(input, 6, 2);
  const same = moveOscilloscopeChannel(input, 3, 3);
  const invalid = [
    moveOscilloscopeChannel(input, -1, 2), moveOscilloscopeChannel(input, 2, -1),
    moveOscilloscopeChannel(input, 8, 2), moveOscilloscopeChannel(input, 2, 8),
    moveOscilloscopeChannel(input, 1.5, 2), moveOscilloscopeChannel(input, 2, Number.NaN),
  ];
  check('forward, backward and same-position moves preserve membership without mutating the draft input',
    indices(forward) === '7,5,0,6,1,2,4,3' && indices(backward) === '7,2,4,5,0,6,1,3' &&
    indices(same) === before && indices(input) === before && same !== input,
    `forward=${indices(forward)}, backward=${indices(backward)}, same=${indices(same)}, input=${indices(input)}`);
  check('out-of-range and non-integer moves are atomic no-ops',
    invalid.every((next) => indices(next) === before && next !== input),
    invalid.map(indices).join(' | '));
}

{
  const named = { ...channels[2]!, name: '  DATA_IN  ' };
  const blank = { ...channels[5]!, name: '   ' };
  const labels = Array.from({ length: 8 }, (_, position) => oscilloscopeBitLabel(position, 8));
  check('channel labels prefer the trimmed user name and fall back to the absolute channel number',
    oscilloscopeChannelLabel(named) === 'DATA_IN' && oscilloscopeChannelLabel(blank) === 'D5',
    `named=${oscilloscopeChannelLabel(named)}, blank=${oscilloscopeChannelLabel(blank)}`);
  check('bit badges map positions to LSB, B1 through B6 and MSB',
    labels.join(',') === 'LSB,B1,B2,B3,B4,B5,B6,MSB', labels.join(','));
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const source = fs.readFileSync('src/ui/oscilloscopeChannels.ts', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const sourceContract = source.includes("document.createElement('div')") &&
    !source.includes("document.createElement('button')") &&
    source.includes('chip.draggable = !this.disabled') &&
    source.includes('chip.style.background = channel.color') &&
    source.includes('chip.style.color = chipForeground(channel.color)') &&
    source.includes('Array.from({ length: 6 })') &&
    source.includes('this.onChange(this.channels.map((entry) => entry.index))') &&
    !source.includes('document.addEventListener') && !source.includes('window.addEventListener') &&
    !source.includes('innerHTML');
  const styleBlock = sheet.split('/* --------------------------------------------------- oscilloscope channel grid */')[1] ?? '';
  const rule = (selector: string): string => {
    const start = styleBlock.indexOf(selector);
    if (start < 0) return '';
    const bodyStart = styleBlock.indexOf('{', start);
    const bodyEnd = styleBlock.indexOf('}', bodyStart);
    return bodyStart < 0 || bodyEnd < 0 ? '' : styleBlock.slice(start, bodyEnd + 1);
  };
  const gridRule = rule('.oscilloscope-channel-grid {');
  const dividerRule = rule('.oscilloscope-channel-grid::before');
  const slotRule = rule('.oscilloscope-channel-slot {');
  const styleNeedles: Array<[string, boolean]> = [
    ['two columns', gridRule.includes('grid-template-columns: repeat(2, minmax(0, 1fr))')],
    ['column gap', gridRule.includes('gap: 12px 30px')],
    ['one-pixel divider', dividerRule.includes('width: 1px')],
    ['slot height', /(?:^|[;{])\s*height: 52px/.test(slotRule)],
    ['dashed slot', slotRule.includes('border: 1px dashed')],
    ['focus state', rule('.oscilloscope-channel-chip:focus-visible').includes('outline: 2px')],
    ['disabled state', rule('.oscilloscope-channel-grid.disabled .oscilloscope-channel-chip').includes('opacity: 0.55')],
    ['drop target', rule('.oscilloscope-channel-slot.drop-target').includes('border-color: var(--primary)')],
    ['dragging state', rule('.oscilloscope-channel-item.dragging .oscilloscope-channel-chip').includes('opacity: 0.42')],
    ['independent bit badge', rule('.oscilloscope-channel-bit {').includes('height: 30px')],
  ];
  const styleMisses = styleNeedles.filter(([, pass]) => !pass).map(([name]) => name);
  check('grid source keeps drag draft-only, channel-colored, non-button and free of global listeners',
    sourceContract, `sourceContract=${sourceContract}`);
  check('grid styles pin the approved two-column slots, divider, badges and interaction states',
    styleBlock.length > 0 && styleMisses.length === 0,
    styleMisses.length === 0 ? `${styleNeedles.length} scoped declarations` : `missing=${styleMisses.join(', ')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
