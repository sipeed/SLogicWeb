// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Loop display's continuous ADC crossing scanner: group byte, bit order, stride,
 * chunk boundaries, continuity across a retune/gap, wide-sample layouts, and the
 * OR-artifact qualification on synthetic and real (fixtures/) ADC traces.
 */

import { AnalogCrossingScanner } from '../analogCrossingScan.js';
import {
  ADC_TRIGGER_HYSTERESIS_CODES, analogTriggerArtifactSamples, analogTriggerQualification,
} from '../channelBanks.js';
import { MAX_ANALOG_ARTIFACT_SAMPLES, reverseAdcByte } from '../../data/softwareTrigger.js';
import { AnalogRunQualifier } from '../../data/analogRunQualifier.js';
import {
  ADC_TRACE_LEVELS, crossingProblem, loadAdcTrace, traceCrossings, traceSlope,
  type AdcTraceName,
} from '../../data/adcTraceFiles.js';
import {
  adcArtifactTrace, cleanSlope, fixtureRng, rawCrossings,
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
// hysteresis 4 codes, artifact window W = 24 samples (240 ns at 100 MS/s).
// ---------------------------------------------------------------------------------------

const W = 24;
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
  // The synthetic artifact trace (adcArtifactFixture), across layouts, strides and seeded
  // chunk sizes: stride 1 reports exactly the rule's crossings, every stride reports only
  // real ones. Not checked against the clean sine's slope: with dither the generator can
  // hide a new code entirely behind its OR (126 -> [254 254] -> 127, where 128 is never
  // read), a shape the measured traces never show and the rule deliberately calls real.
  // The slope is pinned on the measured traces below.
  const trace = adcArtifactTrace({ length: 100_000, period: 10_000, seed: 5, phase: 0.7, ditherNear: LEVELS });
  const codes = trace.codes;
  let bad = '';
  let total = 0;
  let rawWrong = 0;
  for (const kind of ['rising', 'falling'] as const) {
    const rising = kind === 'rising';
    for (const level of LEVELS) {
      const want = kind === 'rising' ? 1 : -1;
      rawWrong += rawCrossings(codes, kind, level).filter((i) => cleanSlope(trace, i) !== want).length;
      const rule = traceCrossings(codes, rising, level, 0, H, W)
        .filter((t) => t < codes.length - W - 1).join();
      for (const stride of [1, 4, 16, 64]) {
        for (const [channels, start] of [[16, 8], [32, 24], [64, 40], [128, 120]] as const) {
          const bps = bytesPerSampleForChannels(channels);
          const raw = encodeCodes(codes, channels, start, stride + level);
          const scanner = new AnalogCrossingScanner({
            channels, condition: { start, kind, level }, stride,
            analogHysteresis: H, analogArtifactSamples: W,
          });
          const found = scanChunks(scanner, raw, bps, stride * 7 + level + channels, 4000);
          const name = `${kind} ${level} stride ${stride} ${channels}ch`;
          for (const t of found) {
            const problem = crossingProblem(codes, t, rising, level, W);
            if (problem) { bad = `${name}: ${problem}`; break; }
          }
          if (!bad && stride === 1 && found.filter((t) => t < codes.length - W - 1).join() !== rule) {
            bad = `${name}: ${found.length} reports differ from the rule`;
          }
          if (!bad && found.length === 0) bad = `${name}: nothing reported`;
          total += found.length;
          if (bad) break;
        }
        if (bad) break;
      }
      if (bad) break;
    }
    if (bad) break;
  }
  check('the Loop scanner follows the rule on the synthetic artifact trace (strides 1-64)',
    bad === '' && total > 0 && rawWrong > 0,
    bad || `${total} crossings; a raw test would have put ${rawWrong} on the wrong slope`);
}

{
  // Levels outside the measured sine (84..175) and the 3.3 MHz AM wave (~95..161): the OR
  // artifact reaches 255 (127 -> 128) and dips nowhere, in short OR-shaped runs only, so
  // nothing fires. (The 33 MHz AM trace is not used here: at ~3 samples per carrier
  // period its bus reads arbitrary old/new bit mixes - 1, 32, 211 - that are not OR-shaped
  // and do cross far levels; see ADC-TRACES.md.)
  const fired: string[] = [];
  for (const name of ['sine', 'am3'] as const) {
    const raw = encodeCodes(loadAdcTrace(name), 16, 0, 3);
    for (const [kind, level] of [['rising', 200], ['rising', 80], ['falling', 60], ['falling', 190]] as const) {
      for (const stride of [1, 16]) {
        const scanner = new AnalogCrossingScanner({
          channels: 16, condition: { start: 0, kind, level }, stride,
          analogHysteresis: H, analogArtifactSamples: W,
        });
        const found = scanChunks(scanner, raw, 2, level + stride, 3000);
        if (found.length > 0) fired.push(`${name} ${kind} ${level} stride ${stride}: ${found[0]}`);
      }
    }
  }
  check('the Loop scanner never fires for a level outside the measured signal', fired.length === 0,
    fired.join('; ') || 'sine and 3.3 MHz AM: rising 200/80, falling 60/190 at strides 1 and 16');
}

{
  // A run that straddles chunk boundaries is judged across them. 64 -> 192 has the OR
  // shape (192 & 64 === 64, 192 > 64): the run at 70..79 ends on 64 within W, an
  // artifact, and is never reported although it is split by two boundaries; the run from
  // 120 outlasts W and is real, decided at 144 in a later chunk, reported as T = 120.
  const codes = new Uint8Array(260);
  for (let i = 0; i < codes.length; i++) codes[i] = i >= 70 && i < 80 ? 192 : i < 120 ? 64 : 192;
  const raw = encodeCodes(codes, 32, 16, 4);
  const got: string[] = [];
  let pass = true;
  for (const stride of [1, 4, 16]) {
    for (const cuts of [[75, 76, 121, 130], [70, 80, 120, 144], [71, 79, 143, 145]]) {
      const scanner = new AnalogCrossingScanner({
        channels: 32, condition: { start: 16, kind: 'rising', level: 128 }, stride,
        analogHysteresis: H, analogArtifactSamples: W,
      });
      const out: number[][] = [];
      let from = 0;
      for (const to of [...cuts, codes.length]) {
        out.push(scanner.feed(raw.subarray(from * 4, to * 4), from));
        from = to;
      }
      const flat = out.flat();
      // Reported in the chunk holding the deciding sample 144 (the run's (W+1)-th).
      const at = [...cuts, codes.length].findIndex((to) => to > 144);
      const ok = flat.length === 1 && flat[0] === 120 && out[at]!.length === 1;
      if (!ok) pass = false;
      got.push(`stride ${stride} cuts ${cuts.join('/')}: ${JSON.stringify(out)}`);
    }
  }
  check('a run straddling chunks is judged once across them (artifact dropped, real T kept)',
    pass, pass ? '9 chunkings' : got.join(' | '));
}

{
  // A gap (resetContinuity) or a discontinuous chunk with a run pending drops it and the
  // arm: the pending OR-shaped run at 40 (192 after 64) never reports, the first sample
  // after the gap cannot fire, and the next armed crossing is T.
  const mk = (parts: Array<[number, number]>): Uint8Array => {
    const codes: number[] = [];
    for (const [code, n] of parts) for (let i = 0; i < n; i++) codes.push(code);
    return encodeCodes(Uint8Array.from(codes), 8, 0, 6);
  };
  const run = (how: 'reset' | 'skip' | 'none', stride: number): number[] => {
    const scanner = new AnalogCrossingScanner({
      channels: 8, condition: { start: 0, kind: 'rising', level: 128 }, stride,
      analogHysteresis: H, analogArtifactSamples: W,
    });
    const out: number[] = [];
    out.push(...scanner.feed(mk([[64, 40], [192, 10]]), 0));
    if (how === 'reset') {
      scanner.resetContinuity();
      out.push(...scanner.feed(mk([[192, 50]]), 50));
    } else if (how === 'skip') {
      out.push(...scanner.feed(mk([[192, 40]]), 60)); // chunk 50..59 was never scanned
    } else {
      out.push(...scanner.feed(mk([[192, 50]]), 50));
    }
    out.push(...scanner.feed(mk([[64, 40], [192, 40]]), 100));
    return out;
  };
  const got: string[] = [];
  let pass = true;
  for (const stride of [1, 4]) {
    const reset = run('reset', stride);
    const skip = run('skip', stride);
    const none = run('none', stride);
    pass &&= reset.join() === '140' && skip.join() === '140' && none.join() === '40,140';
    got.push(`stride ${stride}: reset=${reset} skip=${skip} contiguous=${none}`);
  }
  check('a gap or a skipped chunk with a run pending restarts the scanner', pass, got.join('; '));
}

{
  const refused = (opts: { analogHysteresis?: number; analogArtifactSamples?: number }): boolean => {
    try {
      new AnalogCrossingScanner({
        channels: 8, condition: { start: 0, kind: 'rising', level: 128 }, stride: 1, ...opts,
      });
      return false;
    } catch { return true; }
  };
  check('the scanner validates its qualification strictly',
    refused({ analogHysteresis: 0 }) && refused({ analogHysteresis: 300 }) &&
    refused({ analogArtifactSamples: -1 }) && refused({ analogArtifactSamples: 1.5 }) &&
    refused({ analogArtifactSamples: MAX_ANALOG_ARTIFACT_SAMPLES + 1 }) &&
    !refused({ analogArtifactSamples: 0 }) && !refused({ analogArtifactSamples: 1 }) &&
    !refused({ analogHysteresis: H, analogArtifactSamples: W }),
    'hysteresis 0/300 and window -1/1.5/MAX+1 refused; W = 0 and 1 accepted');
}

{
  // Degenerate windows. W = 0: no artifact rejection (hysteresis only) - the one-sample
  // OR run 127 -> 255 -> 128 is a crossing. W = 1 rejects exactly that single-sample run
  // but not a two-sample one; W = 24 rejects both.
  const one = [100, 127, 255, 127, 100, 100];
  const two = [100, 127, 255, 255, 127, 100];
  const scan = (codes: number[], w: number): number[] => new AnalogCrossingScanner({
    channels: 8, condition: { start: 0, kind: 'rising', level: 128 }, stride: 1,
    analogHysteresis: H, analogArtifactSamples: w,
  }).feed(encode(8, codes.map(adc)), 0);
  const got = [0, 1, 24].map((w) => `${JSON.stringify(scan(one, w))}/${JSON.stringify(scan(two, w))}`);
  check('W = 0 disables artifact rejection; W = 1 rejects one-sample OR runs only',
    got.join(' ') === '[2]/[2] []/[2] []/[]', got.join(' '));
}

// ---------------------------------------------------------------------------------------
// The real ADC traces (fixtures/ADC-TRACES.md), fed as MSB-first bus bytes.
// ---------------------------------------------------------------------------------------

const TRACES: readonly AdcTraceName[] = ['sine', 'am3', 'am33'];

{
  // The streaming qualifier against the flat-array rule, sample for sample (a run still
  // undecided at the end of the trace is the only allowed difference).
  let bad = '';
  let total = 0;
  for (const name of TRACES) {
    const codes = loadAdcTrace(name);
    for (const level of ADC_TRACE_LEVELS[name]) {
      for (const rising of [true, false]) {
        const want = traceCrossings(codes, rising, level).filter((t) => t < codes.length - W - 1);
        const q = new AnalogRunQualifier({ rising, level, hysteresis: H, window: W });
        const got: number[] = [];
        for (let i = 0; i < codes.length; i++) {
          const t = q.step(codes[i]!, i);
          if (t >= 0 && t < codes.length - W - 1) got.push(t);
        }
        total += got.length;
        if (got.join() !== want.join()) {
          bad = `${name} ${rising ? 'rising' : 'falling'} ${level}: ${got.length} vs ${want.length}`;
        }
      }
    }
  }
  check('the streaming qualifier equals the flat-array rule on the three real traces',
    bad === '' && total > 0, bad || `${total} crossings`);
}

{
  // The Loop scanner on the real traces at strides 1/4/16/64, seeded chunk sizes and
  // several sample layouts: every reported T is a real crossing (predecessor on the other
  // side, T past the level, not an OR-artifact run), the sine reports one per period on
  // the configured slope and none on the other, and both AM traces report crossings at
  // every stride. At stride 1 the reports are exactly the rule's crossings.
  const layouts = [[8, 0], [16, 8], [32, 24], [64, 40], [128, 120]] as const;
  const lines: string[] = [];
  let bad = '';
  let rawWrong = 0;
  for (const name of TRACES) {
    const codes = loadAdcTrace(name);
    for (const level of ADC_TRACE_LEVELS[name]) {
      for (const kind of ['rising', 'falling'] as const) {
        const rising = kind === 'rising';
        const want = traceCrossings(codes, rising, level);
        if (name === 'sine') {
          rawWrong += rawCrossings(codes, kind, level)
            .filter((t) => (traceSlope(codes, t) > 0) !== rising && traceSlope(codes, t) !== 0).length;
        }
        const counts: number[] = [];
        for (const [li, stride] of [1, 4, 16, 64].entries()) {
          const [channels, start] = layouts[(li + level) % layouts.length]!;
          const bps = bytesPerSampleForChannels(channels);
          const raw = encodeCodes(codes, channels, start, stride + level);
          const scanner = new AnalogCrossingScanner({
            channels, condition: { start, kind, level }, stride,
            analogHysteresis: H, analogArtifactSamples: W,
          });
          const found = scanChunks(scanner, raw, bps, stride * 7 + level + channels, 5000);
          counts.push(found.length);
          const tag = `${name} ${kind} ${level} stride ${stride} ${channels}ch`;
          for (const t of found) {
            const problem = crossingProblem(codes, t, rising, level);
            if (problem) { bad = `${tag}: ${problem}`; break; }
            if (name === 'sine' && (traceSlope(codes, t) > 0) !== rising) {
              bad = `${tag}: T=${t} is on the wrong slope`;
              break;
            }
          }
          if (!bad && stride === 1 && found.filter((t) => t < codes.length - W - 1).join() !==
            want.filter((t) => t < codes.length - W - 1).join()) {
            bad = `${tag}: ${found.length} reports, the rule gives ${want.length}`;
          }
          if (!bad && found.length === 0) bad = `${tag}: no crossing reported`;
          if (!bad && name === 'sine' && Math.abs(found.length - want.length) > 1) {
            bad = `${tag}: ${found.length} reports for ${want.length} periods`;
          }
          if (bad) break;
        }
        lines.push(`${name} ${kind[0]}${level}: ${counts.join('/')}`);
        if (bad) break;
      }
      if (bad) break;
    }
    if (bad) break;
  }
  check('the Loop scanner reports only real crossings on the real ADC traces (strides 1-64)',
    bad === '' && rawWrong > 0,
    bad || `${lines.join('; ')}; a raw test put ${rawWrong} sine crossings on the wrong slope`);
}

{
  // W = ceil(240 ns x rate) without the float product rounding 24 up to 25.
  const rates = [100e6, 160e6, 200e6, 400e6, 800e6, 1e6];
  const got = rates.map((r) => analogTriggerArtifactSamples(r));
  const q = analogTriggerQualification(100e6);
  check('the artifact window W is ceil(240 ns x samplerate), 24 at 100 MS/s',
    got.join(',') === '24,39,48,96,192,1' && q.analogHysteresis === ADC_TRIGGER_HYSTERESIS_CODES &&
    q.analogHysteresis === 4 && q.analogArtifactSamples === 24,
    `W=${got.join(',')}, h=${q.analogHysteresis}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
