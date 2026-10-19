// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { channelColor, defaultChannelName, defaultChannels } from '../state.js';

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

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
