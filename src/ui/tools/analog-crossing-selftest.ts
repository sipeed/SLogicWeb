// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Loop display's continuous ADC crossing scanner: group byte, bit order, stride,
 * chunk boundaries, continuity across a retune/gap, and wide-sample layouts.
 */

import { AnalogCrossingScanner } from '../analogCrossingScan.js';
import {
  ADC_TRIGGER_HYSTERESIS_CODES, analogTriggerPersistSamples, analogTriggerQualification,
} from '../channelBanks.js';
import { reverseAdcByte } from '../../data/softwareTrigger.js';
import {
  adcArtifactTrace, checkCrossings, cleanCrossings, cleanSlope, fixtureRng, rawCrossings,
} from '../../data/adcArtifactFixture.js';
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

// ---------------------------------------------------------------------------------------
// Qualified crossings on the measured ADC carry-boundary artifact (adcArtifactFixture):
// hysteresis 4 codes, persistence 24 samples (240 ns at 100 MS/s).
// ---------------------------------------------------------------------------------------

const P = 24;
const H = 4;
const LEVELS = [100, 112, 128, 144, 160] as const;

function encodeCodes(codes: Uint8Array, channels: ChannelCount, start: number, seed: number): Uint8Array {
  const bps = bytesPerSampleForChannels(channels);
  const rng = fixtureRng(seed);
  const out = new Uint8Array(codes.length * bps);
  for (let i = 0; i < codes.length; i++) {
    for (let b = 0; b < bps; b++) out[i * bps + b] = Math.floor(rng() * 256);
    out[i * bps + (start >>> 3)] = reverseAdcByte(codes[i]!);
  }
  return out;
}

/** Scan in seeded chunks of 1..maxSamples samples, as the page does. */
function scanChunks(
  scanner: AnalogCrossingScanner, raw: Uint8Array, bps: number, seed: number, maxSamples: number,
): number[] {
  const rng = fixtureRng(seed);
  const out: number[] = [];
  const samples = raw.length / bps;
  let pos = 0;
  while (pos < samples) {
    const len = Math.min(samples - pos, 1 + Math.floor(rng() * maxSamples));
    out.push(...scanner.feed(raw.subarray(pos * bps, (pos + len) * bps), pos));
    pos += len;
  }
  return out;
}

{
  const trace = adcArtifactTrace({ length: 100_000, period: 10_000, seed: 5, phase: 0.7, ditherNear: LEVELS });
  let bad = '';
  let total = 0;
  let rawWrong = 0;
  for (const kind of ['rising', 'falling'] as const) {
    for (const level of LEVELS) {
      const want = kind === 'rising' ? 1 : -1;
      rawWrong += rawCrossings(trace.codes, kind, level).filter((i) => cleanSlope(trace, i) !== want).length;
      for (const stride of [1, 4, 16, 64]) {
        for (const [channels, start] of [[16, 8], [32, 24], [64, 40], [128, 120]] as const) {
          const bps = bytesPerSampleForChannels(channels);
          const raw = encodeCodes(trace.codes, channels, start, stride + level);
          const scanner = new AnalogCrossingScanner({
            channels, condition: { start, kind, level }, stride,
            analogHysteresis: H, analogPersistSamples: P,
          });
          const found = scanChunks(scanner, raw, bps, stride * 7 + level + channels, 4000);
          const clean = cleanCrossings(trace, kind, level).filter((c) => c > 200).length;
          const err = checkCrossings(trace, kind, level, found);
          const name = `${kind} ${level} stride ${stride} ${channels}ch`;
          if (err) bad = `${name}: ${err}`;
          else if (found.filter((c) => c > 200).length !== clean) {
            bad = `${name}: ${found.length} found, ${clean} clean crossings`;
          }
          total += found.length;
          if (bad) break;
        }
        if (bad) break;
      }
      if (bad) break;
    }
    if (bad) break;
  }
  check('the Loop scanner reports every qualified crossing on the right slope (strides 1-64)',
    bad === '' && total > 0 && rawWrong > 0,
    bad || `${total} crossings; a raw test would have put ${rawWrong} on the wrong slope`);
}

{
  // Levels outside the signal: the artifact reaches 255 (127 -> 128) in short bursts only.
  const trace = adcArtifactTrace({ length: 60_000, period: 10_000, seed: 9, ditherNear: LEVELS });
  const raw = encodeCodes(trace.codes, 16, 0, 3);
  const fired: string[] = [];
  for (const [kind, level] of [['rising', 200], ['rising', 80], ['falling', 60], ['falling', 190]] as const) {
    for (const stride of [1, 16]) {
      const scanner = new AnalogCrossingScanner({
        channels: 16, condition: { start: 0, kind, level }, stride,
        analogHysteresis: H, analogPersistSamples: P,
      });
      const found = scanChunks(scanner, raw, 2, level + stride, 3000);
      if (found.length > 0) fired.push(`${kind} ${level} stride ${stride}: ${found[0]}`);
    }
  }
  check('the Loop scanner never fires for a level outside the signal', fired.length === 0,
    fired.join('; ') || 'rising 200/80, falling 60/190 at strides 1 and 16');
}

{
  // The persistence window spans a chunk boundary; the reported crossing is the
  // candidate in the earlier chunk. A one-sample chunk splits it further.
  const codes = new Uint8Array(200);
  for (let i = 0; i < codes.length; i++) codes[i] = i < 70 ? 90 : 140;
  const raw = encodeCodes(codes, 32, 16, 4);
  const got: string[] = [];
  let pass = true;
  for (const stride of [1, 4, 16]) {
    const scanner = new AnalogCrossingScanner({
      channels: 32, condition: { start: 16, kind: 'rising', level: 128 }, stride,
      analogHysteresis: H, analogPersistSamples: P,
    });
    const a = scanner.feed(raw.subarray(0, 75 * 4), 0);
    const b = scanner.feed(raw.subarray(75 * 4, 76 * 4), 75);
    const c = scanner.feed(raw.subarray(76 * 4), 76);
    const ok = a.length === 0 && b.length === 0 && c.length === 1 && c[0] === 70;
    if (!ok) pass = false;
    got.push(`stride ${stride}: ${JSON.stringify([a, b, c])}`);
  }
  check('a persistence window spanning chunks reports the candidate sample', pass, got.join(' '));
}

{
  // A gap (resetContinuity) or a discontinuous chunk mid-candidate restarts the arm.
  const mk = (parts: Array<[number, number]>): Uint8Array => {
    const codes: number[] = [];
    for (const [code, n] of parts) for (let i = 0; i < n; i++) codes.push(code);
    return encodeCodes(Uint8Array.from(codes), 8, 0, 6);
  };
  const run = (how: 'reset' | 'skip'): number[] => {
    const scanner = new AnalogCrossingScanner({
      channels: 8, condition: { start: 0, kind: 'rising', level: 128 }, stride: 4,
      analogHysteresis: H, analogPersistSamples: P,
    });
    const out: number[] = [];
    out.push(...scanner.feed(mk([[90, 40], [140, 10]]), 0));
    if (how === 'reset') {
      scanner.resetContinuity();
      out.push(...scanner.feed(mk([[140, 40]]), 50));
    } else {
      out.push(...scanner.feed(mk([[140, 40]]), 60)); // chunk 50..59 was never scanned
    }
    out.push(...scanner.feed(mk([[90, 40], [140, 40]]), 100));
    return out;
  };
  const reset = run('reset');
  const skip = run('skip');
  check('a gap or a skipped chunk mid-candidate restarts the scanner',
    reset.length === 1 && reset[0] === 140 && skip.length === 1 && skip[0] === 140,
    `reset=${JSON.stringify(reset)} skip=${JSON.stringify(skip)}`);
}

{
  const refused = (opts: { analogHysteresis?: number; analogPersistSamples?: number }): boolean => {
    try {
      new AnalogCrossingScanner({
        channels: 8, condition: { start: 0, kind: 'rising', level: 128 }, stride: 1, ...opts,
      });
      return false;
    } catch { return true; }
  };
  check('the scanner validates its qualification strictly',
    refused({ analogHysteresis: 0 }) && refused({ analogHysteresis: 300 }) &&
    refused({ analogPersistSamples: 0 }) && refused({ analogPersistSamples: 1.5 }) &&
    !refused({ analogHysteresis: H, analogPersistSamples: P }),
    'hysteresis 0/300 and persistence 0/1.5 refused');
}

{
  // P = ceil(240 ns x rate) without the float product rounding 24 up to 25.
  const rates = [100e6, 160e6, 200e6, 400e6, 800e6, 1e6];
  const got = rates.map((r) => analogTriggerPersistSamples(r));
  const q = analogTriggerQualification(100e6);
  check('the persistence window is ceil(240 ns x samplerate), 24 at 100 MS/s',
    got.join(',') === '24,39,48,96,192,1' && q.analogHysteresis === ADC_TRIGGER_HYSTERESIS_CODES &&
    q.analogHysteresis === 4 && q.analogPersistSamples === 24,
    `P=${got.join(',')}, h=${q.analogHysteresis}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
