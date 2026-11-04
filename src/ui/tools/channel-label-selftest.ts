// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { carryChannelState, channelColor, defaultChannelName, defaultChannels } from '../state.js';
import type { ChannelState } from '../state.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

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

// --------------------------------------------- channel-model rebuild sites

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const occursOnce = (needle: string): boolean => app.split(needle).length === 2;
  const bodyBetween = (start: string, end: string): string =>
    occursOnce(start) && occursOnce(end) ? app.split(start)[1].split(end)[0] : '';
  const orderWrites = (body: string): number => body.split('this.order = ').length - 1;

  const deviceBody = bodyBetween('private adoptDeviceChannels(', 'private async startCapture(');
  const startBody = bodyBetween('private async startCapture(', 'private enforceLoopRetention(');
  const adoptBody = bodyBetween('private adoptCapture(', 'private save(');

  const sanctioned = [
    'this.channels = (workspace.channels ?? defaultChannels(16)).map((channel, index) => ({ ...channel, index }));',
    'this.channels = defaultChannels(store.channelCount);',
    'this.channels = carryChannelState(this.channels, max);',
    'this.channels = carryChannelState(this.channels, model);',
  ];
  const missing = sanctioned.filter((site) => !occursOnce(site));
  const siteCount = app.split('this.channels = ').length - 1;

  const defaultSites = [
    'private channels: ChannelState[] = defaultChannels(16);',
    '(workspace.channels ?? defaultChannels(16)).map(',
    'this.channels = defaultChannels(store.channelCount);',
  ];
  const strayDefaults = defaultSites.filter((site) => !occursOnce(site));
  const defaultCount = app.split('defaultChannels(').length - 1;

  const orderAfterCarry = (body: string): boolean => {
    const carryAt = body.indexOf('carryChannelState(this.channels,');
    const orderAt = body.indexOf('restoreOrder(this.order, this.channels.length)');
    return carryAt >= 0 && orderAt > carryAt && !body.includes('this.order = this.channels.map(') &&
      orderWrites(body) === 1;
  };
  const deviceOrder = orderAfterCarry(deviceBody);
  const startOrder = orderAfterCarry(startBody);
  const identityOrder = adoptBody.includes('this.order = this.channels.map((c) => c.index);');
  const noDefaultsInResize = !deviceBody.includes('defaultChannels(') &&
    !startBody.includes('defaultChannels(');

  check('every App channel-model rebuild is sanctioned and rebuilds the order after the carry',
    siteCount === 4 && missing.length === 0 && defaultCount === 3 && strayDefaults.length === 0 &&
    noDefaultsInResize && deviceOrder && startOrder && identityOrder,
    `sites=${siteCount}, missing=${missing.length === 0 ? 'none' : missing.join(' | ')}, ` +
    `defaultChannels=${defaultCount}, strayDefaults=${strayDefaults.length}, ` +
    `noDefaultsInResize=${noDefaultsInResize}, ` +
    `orderWrites=${orderWrites(deviceBody)}/${orderWrites(startBody)}, deviceOrder=${deviceOrder}, ` +
    `startOrder=${startOrder}, adoptIdentityOrder=${identityOrder}`);
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
