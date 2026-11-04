// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Self-test for the pure Emulation pattern checker.
 *
 * This is the part of Sipeed's hardware self-verification that can run without
 * a board: synthetic sink streams generated from the vendor rules must pass,
 * and the faults the hardware self-test has to catch (a flipped channel, a
 * lost head sample) must be reported at the exact channel and sample.
 *
 * Run:
 *   node_modules/.bin/esbuild src/device/emulationPatternTest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/emulation-pattern-test.mjs
 *   node /tmp/emulation-pattern-test.mjs
 */

import {
  EmulationPatternCheck,
  emulationRules,
  type EmulationModel,
  type EmulationRule,
} from './emulationPattern.js';

let failures = 0;

/** This file runs under node, but tsconfig only pulls in the DOM types. */
function failExit(): void {
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc) proc.exitCode = 1;
}

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

/** Sink bytes per sample: below 8 channels expandPacked already made it one. */
function sampleBytesFor(channels: number): number {
  return Math.max(1, Math.ceil(channels / 8));
}

/** One sample word for `counter`, D0 in bit 0, as Sipeed's table defines it. */
function wordFor(rules: readonly EmulationRule[], counter: number): number {
  let word = 0;
  for (let channel = 0; channel < rules.length; channel++) {
    const rule = rules[channel]!;
    const bit = ((counter >>> rule.bit) & 1) ^ (rule.inverted ? 1 : 0);
    word |= bit << channel;
  }
  return word >>> 0;
}

/** `count` samples counting from `first`, wrapping at 16 bits, little-endian. */
function encode(
  rules: readonly EmulationRule[],
  first: number,
  count: number,
  sampleBytes: number,
): Uint8Array {
  const bytes = new Uint8Array(count * sampleBytes);
  for (let sample = 0; sample < count; sample++) {
    const word = wordFor(rules, (first + sample) & 0xffff);
    for (let byte = 0; byte < sampleBytes; byte++) {
      bytes[sample * sampleBytes + byte] = (word >>> (8 * byte)) & 0xff;
    }
  }
  return bytes;
}

function flipChannel(
  bytes: Uint8Array,
  sample: number,
  channel: number,
  sampleBytes: number,
): void {
  const index = sample * sampleBytes + (channel >> 3);
  bytes[index] = bytes[index]! ^ (1 << (channel & 7));
}

/** Push with chunk sizes that are not sample-aligned, cycling through `sizes`. */
function pushInChunks(
  checker: EmulationPatternCheck,
  bytes: Uint8Array,
  sizes: readonly number[],
): void {
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = sizes[index % sizes.length]!;
    checker.push(bytes.subarray(offset, Math.min(offset + size, bytes.length)));
    offset += size;
    index += 1;
  }
}

function describeRules(rules: readonly EmulationRule[] | null): string {
  if (rules === null) return 'null';
  return rules.map((rule) => `${rule.inverted ? '~' : ''}c${rule.bit}`).join(' ');
}

const SUPPORTED: readonly { model: EmulationModel; channels: number }[] = [
  { model: 'slogic16u3', channels: 4 },
  { model: 'slogic16u3', channels: 8 },
  { model: 'slogic16u3', channels: 16 },
  { model: 'slogic32u3', channels: 4 },
  { model: 'slogic32u3', channels: 8 },
  { model: 'slogic32u3', channels: 16 },
  { model: 'slogic32u3', channels: 32 },
];

function main(): void {
  console.log('emulation pattern checker (pure, no hardware)\n');

  console.log('vendor table');
  {
    const low4 = '~c0 ~c1 ~c2 c3';
    const low8 = `${low4} c4 c5 c6 c7`;
    const low16 = `${low8} c8 c9 c10 c11 c12 c13 c14 c15`;
    const high = 'c0 ~c0 c1 ~c1 c2 ~c2 ~c3 c3 ~c4 c4 ~c5 c5 ~c6 c6 ~c7 c7';
    check('16U3 4ch', describeRules(emulationRules('slogic16u3', 4)) === low4,
      describeRules(emulationRules('slogic16u3', 4)));
    check('16U3 8ch', describeRules(emulationRules('slogic16u3', 8)) === low8,
      describeRules(emulationRules('slogic16u3', 8)));
    check('16U3 16ch', describeRules(emulationRules('slogic16u3', 16)) === low16,
      describeRules(emulationRules('slogic16u3', 16)));
    check('32U3 4ch', describeRules(emulationRules('slogic32u3', 4)) === low4,
      describeRules(emulationRules('slogic32u3', 4)));
    check('32U3 8ch', describeRules(emulationRules('slogic32u3', 8)) === low8,
      describeRules(emulationRules('slogic32u3', 8)));
    check('32U3 16ch', describeRules(emulationRules('slogic32u3', 16)) === low16,
      describeRules(emulationRules('slogic32u3', 16)));
    check('32U3 32ch repeats the low counter on D16..D31',
      describeRules(emulationRules('slogic32u3', 32)) === `${low16} ${high}`,
      describeRules(emulationRules('slogic32u3', 32)));
    check('16U3 at 32 channels has no rule',
      emulationRules('slogic16u3', 32) === null);
    check('a width the vendor table does not list is refused',
      emulationRules('slogic32u3', 2) === null);
  }

  console.log('\nsynthetic streams, odd chunk sizes (3/5/7/11 bytes)');
  for (const { model, channels } of SUPPORTED) {
    const rules = emulationRules(model, channels)!;
    const bytes = encode(rules, 0, 300, sampleBytesFor(channels));
    const checker = new EmulationPatternCheck(model, channels);
    pushInChunks(checker, bytes, [3, 5, 7, 11]);
    check(`${model} ${channels}ch passes from counter 0`,
      checker.enabled && checker.checkedSamples === 300 && checker.wrong === 0 &&
        checker.firstWrong === null && checker.startCounter === 0 &&
        checker.verdict() ===
          `all 300 samples of ${channels} channels match from counter 0`,
      checker.verdict());
  }

  console.log('\nsingle-bit faults');
  {
    // A low channel: D3 carries c3, so flipping that bit is one disagreement.
    const channels = 16;
    const rules = emulationRules('slogic32u3', channels)!;
    const bytes = encode(rules, 0, 100, sampleBytesFor(channels));
    flipChannel(bytes, 37, 3, sampleBytesFor(channels));
    const checker = new EmulationPatternCheck('slogic32u3', channels);
    pushInChunks(checker, bytes, [5]);
    const first = checker.firstWrong;
    check('a flipped low channel is reported at D3 sample 37',
      checker.wrong === 1 && first !== null && first.channel === 3 && first.sample === 37 &&
        checker.verdict() === '1 of 1600 channel samples differ, the first at D3 sample 37',
      checker.verdict());
  }
  {
    // D17 is the inverted copy of c0 in the 32-channel high half.
    const channels = 32;
    const rules = emulationRules('slogic32u3', channels)!;
    const bytes = encode(rules, 0, 100, sampleBytesFor(channels));
    flipChannel(bytes, 53, 17, sampleBytesFor(channels));
    const checker = new EmulationPatternCheck('slogic32u3', channels);
    pushInChunks(checker, bytes, [7]);
    const first = checker.firstWrong;
    check('a flipped high-pair channel is reported at D17 sample 53',
      checker.wrong === 1 && first !== null && first.channel === 17 && first.sample === 53 &&
        checker.verdict().includes('the first at D17 sample 53'),
      checker.verdict());
  }

  console.log('\ncounter anchor and wrap');
  {
    const rules = emulationRules('slogic16u3', 16)!;
    const bytes = encode(rules, 5, 50, sampleBytesFor(16));
    const checker = new EmulationPatternCheck('slogic16u3', 16);
    pushInChunks(checker, bytes, [11]);
    check('a stream whose first sample is counter 5 anchors at 5',
      checker.startCounter === 5 && checker.checkedSamples === 50 && checker.wrong === 0 &&
        checker.verdict().includes('from counter 5'),
      checker.verdict());
  }
  {
    const rules = emulationRules('slogic16u3', 16)!;
    const bytes = encode(rules, 65530, 20, sampleBytesFor(16));
    const checker = new EmulationPatternCheck('slogic16u3', 16);
    pushInChunks(checker, bytes, [3, 5]);
    check('the counter wraps 65535 -> 0 without a mismatch',
      checker.startCounter === 65530 && checker.checkedSamples === 20 && checker.wrong === 0,
      checker.verdict());
  }

  console.log('\nlost head sample (the regression this module exists for)');
  {
    const channels = 32;
    const sampleBytes = sampleBytesFor(channels);
    const rules = emulationRules('slogic32u3', channels)!;
    const whole = encode(rules, 0, 64, sampleBytes);
    // Exactly what the old unconditional four-byte drop did on the 32U3: it
    // removed one whole 32-channel sample, so the stream began at counter 1.
    const dropped = whole.subarray(sampleBytes);
    const checker = new EmulationPatternCheck('slogic32u3', channels, 0);
    pushInChunks(checker, dropped, [5, 7]);
    const first = checker.firstWrong;
    check('a stream missing its first sample fails when the start is known to be 0',
      first !== null && first.sample === 0 && checker.wrong > 0 &&
        checker.verdict().includes(`the first at D${first.channel} sample ${first.sample}`),
      checker.verdict());
    // The first surviving sample is counter 1; the sample index is where the
    // checker found it in the stream, so the report names sample 0.
    check('the failure detail names the sample index of the first mismatch',
      checker.verdict().includes('sample 0'), checker.verdict());

    // Auto-anchoring cannot distinguish a dropped prefix from a triggered
    // capture: both are a suffix of the pattern starting at an arbitrary
    // counter. That is why the untriggered caller has to pin the start to 0.
    const anchored = new EmulationPatternCheck('slogic32u3', channels);
    pushInChunks(anchored, dropped, [5, 7]);
    check('without a known start the same suffix re-anchors at counter 1',
      anchored.startCounter === 1 && anchored.wrong === 0, anchored.verdict());
  }

  {
    // Half a sample, then the rest: the carry has to survive the split.
    const rules = emulationRules('slogic16u3', 16)!;
    const bytes = encode(rules, 0, 2, sampleBytesFor(16));
    const checker = new EmulationPatternCheck('slogic16u3', 16);
    checker.push(bytes.subarray(0, 3));
    const afterPartial = checker.checkedSamples;
    checker.push(bytes.subarray(3));
    check('a sample split across chunks is carried, not dropped',
      afterPartial === 1 && checker.checkedSamples === 2 && checker.wrong === 0,
      `${afterPartial} then ${checker.checkedSamples} samples, ${checker.wrong} wrong`);
  }

  console.log('\nno rule, no guess');
  {
    const checker = new EmulationPatternCheck('slogic16u3', 32);
    checker.push(Uint8Array.of(1, 2, 3, 4, 5, 6, 7));
    check('a rule-less model and width is not checked and consumes nothing',
      !checker.enabled && checker.checkedSamples === 0 && checker.wrong === 0 &&
        checker.firstWrong === null && checker.startCounter === null &&
        checker.verdict().includes('not checked'),
      checker.verdict());
  }

  console.log(
    `\n${failures === 0
      ? 'all emulation pattern checks passed'
      : failures + ' emulation pattern check(s) FAILED'}`,
  );
  if (failures) failExit();
}

main();
