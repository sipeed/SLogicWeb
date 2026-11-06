// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Loop display's continuous ADC crossing scanner: group byte, bit order, stride,
 * chunk boundaries, continuity across a retune/gap, and wide-sample layouts.
 */

import { AnalogCrossingScanner } from '../analogCrossingScan.js';
import { reverseAdcByte } from '../../data/softwareTrigger.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../../types.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function encode(channels: ChannelCount, samples: readonly number[]): Uint8Array {
  const bps = bytesPerSampleForChannels(channels);
  const out = new Uint8Array(samples.length * bps);
  for (let i = 0; i < samples.length; i++) {
    let word = samples[i]!;
    for (let b = 0; b < bps; b++) { out[i * bps + b] = word & 0xff; word >>>= 8; }
  }
  return out;
}

/** A sample word whose ADC group byte (at `start`) encodes `code`. */
function adcWord(start: number, code: number): number {
  return (reverseAdcByte(code) & 0xff) << ((start >>> 3) * 8);
}

/** The 8-channel sample word (one byte) carrying `code` on the ADC group. */
const adc = (code: number): number => adcWord(0, code);

{
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 128 }, stride: 1,
  });
  const bytes = encode(8, [adc(100), adc(120), adc(128), adc(140)]);
  const found = scanner.feed(bytes, 0);
  check('a rising crossing is reported at the first scanned sample at the level',
    found.length === 1 && found[0] === 2, `found=${JSON.stringify(found)}`);
}

{
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'falling', level: 128 }, stride: 1,
  });
  const found = scanner.feed(encode(8, [adc(140), adc(128), adc(100)]), 1_000);
  check('a falling crossing is reported with absolute positions',
    found.length === 1 && found[0] === 1_001, `found=${JSON.stringify(found)}`);
}

{
  // The group byte is bit-reversed exactly as the matcher reads it, and a group above
  // channel 7 lives in a later byte of a wide sample.
  const channels: ChannelCount = 16;
  const scanner = new AnalogCrossingScanner({
    channels, condition: { start: 8, kind: 'rising', level: 200 }, stride: 1,
  });
  const bytes = encode(channels, [adcWord(8, 190), adcWord(8, 205)]);
  const found = scanner.feed(bytes, 0);
  check('a second ADC group is read from its own byte with the ADC bit order',
    found.length === 1 && found[0] === 1, `found=${JSON.stringify(found)}`);
}

{
  // A crossing is still found when the two samples straddle two transport chunks.
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 100 }, stride: 1,
  });
  const first = encode(8, [adc(90)]);
  const second = encode(8, [adc(100)]);
  const a = scanner.feed(first, 40);
  const b = scanner.feed(second, 41);
  check('continuity is kept across chunk boundaries',
    a.length === 0 && b.length === 1 && b[0] === 41, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
}

{
  // A stride skips intermediate samples but still reports a genuine crossing.
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 100 }, stride: 2,
  });
  const found = scanner.feed(encode(8, [adc(10), adc(50), adc(120), adc(40), adc(130)]), 0);
  check('a strided scan reports the scanned crossing positions only',
    found.length === 1 && found[0] === 2, `found=${JSON.stringify(found)}`);
}

{
  // The scanned interval is refined at sample resolution, so a re-anchor does not lag by
  // the stride: this chunk scans samples 0 (10) and 4 (130); the real crossing is 2.
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 100 }, stride: 4,
  });
  const found = scanner.feed(encode(8, [adc(10), adc(20), adc(120), adc(140), adc(130)]), 0);
  check('a strided crossing is refined to the first sample on the far side',
    found.length === 1 && found[0] === 2, `found=${JSON.stringify(found)}`);
}

{
  // A dirty transport gap and a live level edit both restart continuity: the first sample
  // after the edit cannot complete a transition from the old level.
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 100 }, stride: 1,
  });
  scanner.feed(encode(8, [adc(90)]), 0);
  scanner.resetContinuity();
  const afterGap = scanner.feed(encode(8, [adc(120)]), 1);
  scanner.setCondition({ start: 0, kind: 'rising', level: 50 });
  const afterEdit = scanner.feed(encode(8, [adc(40)]), 2);
  const later = scanner.feed(encode(8, [adc(60)]), 3);
  check('a gap and a retune both break edge continuity',
    afterGap.length === 0 && afterEdit.length === 0 && later.length === 1 && later[0] === 3,
    `gap=${JSON.stringify(afterGap)} edit=${JSON.stringify(afterEdit)} later=${JSON.stringify(later)}`);
}

{
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 100 }, stride: 1,
  });
  const noCross = scanner.feed(encode(8, [adc(10), adc(20), adc(30), adc(40)]), 0);
  const down = scanner.feed(encode(8, [adc(90), adc(80), adc(70)]), 4);
  check('a rising scan ignores descending codes and never invents a crossing',
    noCross.length === 0 && down.length === 0,
    `none=${JSON.stringify(noCross)} down=${JSON.stringify(down)}`);
}

{
  // A periodic signal whose period divides the stride would land on the same phase at
  // every scanned sample. The grid advances one sample per chunk, so every phase is
  // eventually sampled and the crossing is not missed.
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 150 }, stride: 5,
  });
  const period = [adc(100), adc(100), adc(200), adc(200), adc(200)];
  const chunk = [...period, ...period];
  const found: number[] = [];
  for (let c = 0; c < 6; c++) found.push(...scanner.feed(encode(8, chunk), c * chunk.length));
  check('a period that divides the stride is still found as the scan grid advances',
    found.length > 0 && found.every((at) => at >= 0), `found=${JSON.stringify(found.slice(0, 4))}`);
}

{
  // A group above channel 15 lives in the third byte of a 32-channel sample.
  const channels: ChannelCount = 32;
  const scanner = new AnalogCrossingScanner({
    channels, condition: { start: 16, kind: 'rising', level: 200 }, stride: 1,
  });
  const bytes = encode(channels, [adcWord(16, 190), adcWord(16, 205)]);
  const found = scanner.feed(bytes, 0);
  check('a 32-channel sample reads a later ADC group byte with the ADC bit order',
    found.length === 1 && found[0] === 1, `found=${JSON.stringify(found)}`);
}


{
  // Dense reports are thinned to one per minGap but each still marks a real crossing.
  const scanner = new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 100 }, stride: 1,
  });
  const square = [adc(0), adc(0), adc(200), adc(200)];
  const chunk: number[] = [];
  for (let i = 0; i < 10; i++) chunk.push(...square);
  const found = scanner.feed(encode(8, chunk), 0, 10);
  let spaced = true;
  for (let i = 1; i < found.length; i++) spaced &&= found[i]! - found[i - 1]! >= 10;
  check('minGap thins dense crossing reports without losing their phase',
    found.length > 1 && spaced && found.every((at) => chunk[at] === adc(200)),
    `found=${JSON.stringify(found.slice(0, 6))}`);
}

{
  // Wide samples put later ADC groups in later bytes (8 bytes at 64 ch, 16 at 128).
  const wide = (channels: ChannelCount, start: number): boolean => {
    const bps = bytesPerSampleForChannels(channels);
    const byte = start >>> 3;
    const bytes = new Uint8Array(2 * bps);
    bytes[0 * bps + byte] = reverseAdcByte(190);
    bytes[1 * bps + byte] = reverseAdcByte(205);
    const scanner = new AnalogCrossingScanner({
      channels, condition: { start, kind: 'rising', level: 200 }, stride: 1,
    });
    const found = scanner.feed(bytes, 0);
    return found.length === 1 && found[0] === 1;
  };
  check('64- and 128-channel samples read a later ADC group byte',
    wide(64, 24) && wide(128, 120), `wide=${wide(64, 24)}/${wide(128, 120)}`);
}

// A crossing whose strided interval spans a chunk boundary is refined from the kept tail
// of the previous chunk too. Unrefined, it was reported up to a stride late - on a fast
// signal past the peak, so a Rising level drew T on the falling slope.
{
  const n = 120_000;
  const level = 160;
  for (const kind of ['rising', 'falling'] as const) {
    let bad = '';
    let total = 0;
    for (const stride of [4, 16, 64]) {
      for (const period of [37, 100, 1000]) {
        const codes = new Uint8Array(n);
        for (let i = 0; i < n; i++) codes[i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * i) / period));
        const bytes = new Uint8Array(n * 2);
        for (let i = 0; i < n; i++) bytes[2 * i] = reverseAdcByte(codes[i]!);
        const scanner = new AnalogCrossingScanner({ channels: 16, condition: { start: 0, kind, level }, stride });
        let pos = 0;
        let chunk = 997;
        while (pos < n && !bad) {
          const len = Math.min(n - pos, chunk);
          chunk = 500 + ((chunk * 7919) % 4000);
          for (const at of scanner.feed(bytes.subarray(pos * 2, (pos + len) * 2), pos)) {
            total++;
            const before = codes[at - 1];
            const here = codes[at]!;
            const real = before !== undefined && (kind === 'rising'
              ? before < level && here >= level : before > level && here <= level);
            if (!real) bad = `stride ${stride} period ${period}: sample ${at} (${before} -> ${here})`;
          }
          pos += len;
        }
      }
    }
    check(`every ${kind} crossing is exact across chunk boundaries at strides 4-64`,
      bad === '' && total > 0, bad || `${total} crossings`);
  }
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
