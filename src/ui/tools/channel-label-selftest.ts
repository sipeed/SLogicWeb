// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { carryChannelState, channelColor, defaultChannelName, defaultChannels } from '../state.js';
import type { ChannelState } from '../state.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

// ------------------------------------------------- default channel names

{
  const shape: [number, string][] = [[0, 'D0'], [3, 'D3'], [15, 'D15']];
  const wrongShape = shape.filter(([index, want]) => defaultChannelName(index) !== want);
  check('defaultChannelName is the D-prefixed channel index',
    wrongShape.length === 0,
    wrongShape.length === 0
      ? shape.map(([index, want]) => `${index}→${want}`).join(', ')
      : wrongShape.map(([index, want]) =>
        `${index}→${JSON.stringify(defaultChannelName(index))} (want ${want})`).join('; '));

  const channels = defaultChannels(17);
  const wrongNames = channels.filter((c) => c.name !== `D${c.index}`);
  const emptyNames = channels.filter((c) => c.name === '');
  const wrongIndices = channels.filter((c, i) => c.index !== i);
  const wrongColors = channels.filter((c, i) => c.color !== channelColor(i));
  check('defaultChannels names every channel after its own index and keeps index and color',
    channels.length === 17 && wrongNames.length === 0 && emptyNames.length === 0 &&
    wrongIndices.length === 0 && wrongColors.length === 0,
    `n=${channels.length}, names=${channels.map((c) => c.name).join(',')}, ` +
    `wrongNames=${wrongNames.length}, emptyNames=${emptyNames.length}, ` +
    `wrongIndices=${wrongIndices.length}, wrongColors=${wrongColors.length}`);

  const routed = defaultChannels(5).every((c) => c.name === defaultChannelName(c.index));
  check('defaultChannels routes through defaultChannelName and the helper tracks its argument',
    routed && defaultChannelName(1) !== defaultChannelName(3),
    `routed=${routed}, D1=${defaultChannelName(1)}, D3=${defaultChannelName(3)}`);
}

// ------------------------------------------------------- carryChannelState

const sameRow = (a: ChannelState, b: ChannelState): boolean =>
  a.index === b.index && a.name === b.name && a.color === b.color && a.enabled === b.enabled;

const describeRow = (c: ChannelState): string =>
  `D${c.index}=${c.name}/${c.color}/${c.enabled ? 'on' : 'off'}`;

const fixture: ChannelState[] = defaultChannels(8).map((c) => ({
  ...c,
  name: c.index === 1 ? 'SDA' : `user${c.index}`,
  color: c.index === 1 ? '#123456' : `#00000${c.index}`,
  enabled: c.index !== 0 && c.index !== 1,
}));

{
  const grown = carryChannelState(fixture.slice(0, 4), 8);
  const defaults = defaultChannels(8);
  const kept = grown.slice(0, 4).every((c, i) => sameRow(c, fixture[i]!));
  const fresh = grown.slice(4).every((c, i) => sameRow(c, defaults[4 + i]!));
  check('carryChannelState grows 4→8 keeping metadata 0-3 and defaulting 4-7',
    grown.length === 8 && grown.every((c, i) => c.index === i) && kept && fresh,
    `${grown.map(describeRow).join(', ')}, kept=${kept}, fresh=${fresh}`);

  const shrunk = carryChannelState(fixture, 4);
  const shrinkKept = shrunk.every((c, i) => sameRow(c, fixture[i]!));
  check('carryChannelState shrinks 8→4 keeping metadata 0-3 with identity indices',
    shrunk.length === 4 && shrunk.every((c, i) => c.index === i) && shrinkKept,
    `${shrunk.map(describeRow).join(', ')}, length=${shrunk.length}, kept=${shrinkKept}`);

  const renamed = carryChannelState(fixture, 8)[1]!;
  check('carryChannelState keeps a custom name, colour and a disabled mask verbatim',
    renamed.name === 'SDA' && renamed.color === '#123456' && renamed.enabled === false &&
    renamed.name !== defaultChannelName(1) && renamed.color !== channelColor(1),
    `${describeRow(renamed)}, defaultName=${defaultChannelName(1)}, defaultColor=${channelColor(1)}`);

  const fromEmpty = carryChannelState([], 5);
  const emptyDefaults = defaultChannels(5);
  check('carryChannelState over an empty previous model reproduces defaultChannels',
    fromEmpty.length === 5 && fromEmpty.every((c, i) => sameRow(c, emptyDefaults[i]!)),
    `${fromEmpty.map(describeRow).join(', ')}`);

  const holed = carryChannelState([fixture[0], undefined, fixture[2]], 3);
  const defaults3 = defaultChannels(3);
  check('carryChannelState fills a hole from the default row',
    sameRow(holed[0]!, fixture[0]!) && sameRow(holed[1]!, defaults3[1]!) &&
    sameRow(holed[2]!, fixture[2]!),
    `${holed.map(describeRow).join(', ')}, holeWant=${describeRow(defaults3[1]!)}`);
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
