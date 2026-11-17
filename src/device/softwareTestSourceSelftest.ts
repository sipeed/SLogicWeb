// SPDX-License-Identifier: GPL-3.0-or-later
/** Host-side checks for the software test pattern tile and its rate helpers. */

import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import { reverseAdcByte } from '../data/softwareTrigger.js';
import { SLOGIC32U3_PROFILE } from './profiles.js';
import {
  SOFTWARE_TEST_AMPLITUDE_CODES,
  SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES,
  SOFTWARE_TEST_TILE_SAMPLES,
  SOFTWARE_TEST_ZERO_CODE,
  SoftwareTestPattern,
  softwareTestHalfSignalHz,
  softwareTestSignalHz,
} from './softwareTestPattern.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const WIDTHS: readonly ChannelCount[] = [4, 8, 16, 32];
const SAMPLES = [0, 1, 17, 64, 65, 128, 191, 200, 255, 256, 300, 384, 511] as const;

function patternOf(channels: number, analogGroups: number): SoftwareTestPattern {
  return new SoftwareTestPattern({ channels: channels as ChannelCount, analogGroups });
}

function sineFull(sample: number): number {
  return Math.sin(2 * Math.PI * sample / SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES);
}

function cosineFull(sample: number): number {
  return Math.cos(2 * Math.PI * sample / SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES);
}

function sineHalf(sample: number): number {
  return Math.sin(2 * Math.PI * sample / SOFTWARE_TEST_TILE_SAMPLES);
}

function cosineHalf(sample: number): number {
  return Math.cos(2 * Math.PI * sample / SOFTWARE_TEST_TILE_SAMPLES);
}

function codeFor(sample: number, amplitude: number, shape: (s: number) => number): number {
  return Math.round(SOFTWARE_TEST_ZERO_CODE + amplitude * shape(sample));
}

function bankByte(pattern: SoftwareTestPattern, group: number, sample: number): number {
  return pattern.tile[sample * pattern.bytesPerSample + group]!;
}

function codeFromBankByte(byte: number): number {
  let code = 0;
  for (let input = 0; input < 8; input++) code |= ((byte >>> input) & 1) << (7 - input);
  return code;
}

function bytesAt(
  pattern: SoftwareTestPattern,
  startSample: number,
  samples = 1,
): Uint8Array {
  const out = new Uint8Array(samples * pattern.bytesPerSample);
  pattern.fill(out, startSample);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function thrown(run: () => void): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

function expectRangeError(name: string, run: () => void): void {
  const error = thrown(run);
  check(name, error instanceof RangeError,
    error === null ? 'did not throw' : `threw ${String(error)}`);
}

function amplitudeMismatch(pattern: SoftwareTestPattern, amplitude: number): number | null {
  for (const sample of SAMPLES) {
    const expected = codeFor(sample, amplitude, sineFull);
    if (codeFromBankByte(bankByte(pattern, 0, sample)) !== expected) return sample;
  }
  return null;
}

for (const channels of WIDTHS) {
  const bytesPerSample = bytesPerSampleForChannels(channels);
  const pattern = patternOf(channels, Math.min(4, Math.floor(channels / 8)));
  check(`the tile holds ${SOFTWARE_TEST_TILE_SAMPLES} samples at ${channels} channels`,
    pattern.tile.length === SOFTWARE_TEST_TILE_SAMPLES * bytesPerSample &&
      pattern.bytesPerSample === bytesPerSample &&
      pattern.channels === channels,
    `${pattern.tile.length} bytes, ${pattern.bytesPerSample} per sample, channels ${pattern.channels}`);
}

{
  const pattern = patternOf(32, 4);
  const mismatches: string[] = [];
  for (const sample of SAMPLES) {
    const wantSine = codeFor(sample, SOFTWARE_TEST_AMPLITUDE_CODES, sineFull);
    const wantCosine = codeFor(sample, SOFTWARE_TEST_AMPLITUDE_CODES, cosineFull);
    if (bankByte(pattern, 0, sample) !== reverseAdcByte(wantSine)) {
      mismatches.push(`A0 @${sample}: ${bankByte(pattern, 0, sample)} != ${reverseAdcByte(wantSine)}`);
    }
    if (bankByte(pattern, 1, sample) !== reverseAdcByte(wantCosine)) {
      mismatches.push(`A1 @${sample}: ${bankByte(pattern, 1, sample)} != ${reverseAdcByte(wantCosine)}`);
    }
  }
  check('A0 and A1 carry the full-rate sine and cosine codes',
    mismatches.length === 0, mismatches.slice(0, 4).join('; ') || `${SAMPLES.length} samples`);

  let low = 255;
  let high = 0;
  for (let sample = 0; sample < SOFTWARE_TEST_TILE_SAMPLES; sample++) {
    const code = codeFromBankByte(bankByte(pattern, 0, sample));
    low = Math.min(low, code);
    high = Math.max(high, code);
  }
  check('the sine stays inside the 0..255 code range at full amplitude',
    low === SOFTWARE_TEST_ZERO_CODE - SOFTWARE_TEST_AMPLITUDE_CODES &&
      high === SOFTWARE_TEST_ZERO_CODE + SOFTWARE_TEST_AMPLITUDE_CODES,
    `codes ${low}..${high}`);
}

{
  const pattern = patternOf(32, 4);
  const mismatches: string[] = [];
  for (const sample of SAMPLES) {
    const wantSine = codeFor(sample, SOFTWARE_TEST_AMPLITUDE_CODES, sineHalf);
    const wantCosine = codeFor(sample, SOFTWARE_TEST_AMPLITUDE_CODES, cosineHalf);
    if (bankByte(pattern, 2, sample) !== reverseAdcByte(wantSine)) {
      mismatches.push(`A2 @${sample}: ${bankByte(pattern, 2, sample)} != ${reverseAdcByte(wantSine)}`);
    }
    if (bankByte(pattern, 3, sample) !== reverseAdcByte(wantCosine)) {
      mismatches.push(`A3 @${sample}: ${bankByte(pattern, 3, sample)} != ${reverseAdcByte(wantCosine)}`);
    }
  }
  check('A2 and A3 carry the half-rate sine and cosine codes',
    mismatches.length === 0, mismatches.slice(0, 4).join('; ') || `${SAMPLES.length} samples`);

  const wrapMismatch: string[] = [];
  for (const sample of SAMPLES) {
    const shifted = sample + SOFTWARE_TEST_TILE_SAMPLES;
    if (bankByte(pattern, 2, sample) !==
      reverseAdcByte(codeFor(shifted, SOFTWARE_TEST_AMPLITUDE_CODES, sineHalf))) {
      wrapMismatch.push(`A2 @${sample}`);
    }
    if (bankByte(pattern, 3, sample) !==
      reverseAdcByte(codeFor(shifted, SOFTWARE_TEST_AMPLITUDE_CODES, cosineHalf))) {
      wrapMismatch.push(`A3 @${sample}`);
    }
  }
  check('the half-rate groups repeat a full period later',
    wrapMismatch.length === 0,
    wrapMismatch.slice(0, 4).join('; ') || `${SAMPLES.length} samples shifted by 512`);

  const early = bankByte(pattern, 2, 64);
  check('the half-rate groups differ a half period later',
    bankByte(pattern, 2, 320) !== early &&
      bankByte(pattern, 3, 320) !== bankByte(pattern, 3, 64),
    `A2 ${early} vs ${bankByte(pattern, 2, 320)}, A3 ` +
      `${bankByte(pattern, 3, 64)} vs ${bankByte(pattern, 3, 320)}`);

  check('the full-rate groups repeat one period later',
    bankByte(pattern, 0, 320) === bankByte(pattern, 0, 64) &&
      bankByte(pattern, 1, 320) === bankByte(pattern, 1, 64),
    `A0 ${bankByte(pattern, 0, 64)} vs ${bankByte(pattern, 0, 320)}`);
}

{
  const pattern = patternOf(32, 4);
  const bad: string[] = [];
  for (const sample of SAMPLES) {
    const wire = bankByte(pattern, 0, sample);
    const expected = codeFor(sample, SOFTWARE_TEST_AMPLITUDE_CODES, sineFull);
    if (wire !== reverseAdcByte(expected)) bad.push(`byte @${sample}: ${wire}`);
    if (codeFromBankByte(wire) !== expected) {
      bad.push(`fold @${sample}: ${codeFromBankByte(wire)} != ${expected}`);
    }
    if (reverseAdcByte(wire) !== expected) bad.push(`decode @${sample}`);
  }
  check('the bank byte is the bit-reversed code, MSB first',
    bad.length === 0, bad.slice(0, 4).join('; ') || `${SAMPLES.length} samples round-trip`);
}

{
  const pattern = patternOf(4, 0);
  const bad: number[] = [];
  for (let sample = 0; sample < SOFTWARE_TEST_TILE_SAMPLES; sample++) {
    if (pattern.tile[sample] !== (sample & 0x0f)) bad.push(sample);
  }
  check('width 4 has no analog bank and masks the counter to four bits',
    pattern.analogGroups === 0 && pattern.bytesPerSample === 1 && bad.length === 0,
    bad.length === 0 ? 'all 512 samples' : `first mismatch ${bad[0]}`);
}

{
  const pattern = patternOf(16, 0);
  const bad: string[] = [];
  for (const sample of SAMPLES) {
    const at = sample * pattern.bytesPerSample;
    if (pattern.tile[at] !== (sample & 0xff)) bad.push(`low @${sample}: ${pattern.tile[at]}`);
    if (pattern.tile[at + 1] !== ((sample >>> 8) & 0xff)) {
      bad.push(`high @${sample}: ${pattern.tile[at + 1]}`);
    }
  }
  check('width 16 counts little-endian across both bytes',
    bad.length === 0, bad.slice(0, 4).join('; ') || `${SAMPLES.length} samples`);
}

{
  const pattern = patternOf(128, 0);
  const at = 1 * pattern.bytesPerSample;
  const high = pattern.tile.subarray(at + 4, at + pattern.bytesPerSample);
  check('bytes above the 32-bit counter carry zero',
    pattern.bytesPerSample === 16 && high.every((byte) => byte === 0),
    `${high.length} bytes above byte 3`);
}

{
  const pattern = patternOf(16, 2);
  const bytesPerSample = pattern.bytesPerSample;
  const whole = new Uint8Array(4 * bytesPerSample);
  pattern.fill(whole, 0);
  const first = new Uint8Array(2 * bytesPerSample);
  pattern.fill(first, 0);
  const second = new Uint8Array(2 * bytesPerSample);
  pattern.fill(second, 2);
  const joined = new Uint8Array(whole.length);
  joined.set(first, 0);
  joined.set(second, first.length);
  check('fill is chunk-invariant', equalBytes(whole, joined),
    `${whole.length} bytes in two chunks`);
}

{
  const pattern = patternOf(32, 4);
  const bytesPerSample = pattern.bytesPerSample;
  const wrapStart = SOFTWARE_TEST_TILE_SAMPLES - 4;
  const wrapSamples = 8;
  const wrapped = new Uint8Array(wrapSamples * bytesPerSample);
  pattern.fill(wrapped, wrapStart);
  const expected = new Uint8Array(wrapped.length);
  for (let i = 0; i < wrapSamples; i++) {
    const sample = (wrapStart + i) % SOFTWARE_TEST_TILE_SAMPLES;
    expected.set(pattern.tile.subarray(sample * bytesPerSample, (sample + 1) * bytesPerSample),
      i * bytesPerSample);
  }
  check('fill wraps across the tile boundary', equalBytes(wrapped, expected),
    `start ${wrapStart}, ${wrapSamples} samples`);
  check('fill does not repeat at the half-tile period',
    !equalBytes(bytesAt(pattern, wrapStart, wrapSamples),
      bytesAt(pattern,
        Math.max(0, wrapStart - SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES), wrapSamples)),
    `start ${wrapStart} vs ${wrapStart - SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES}`);
}

check('the signal helpers define rate / 256 and rate / 512',
  softwareTestSignalHz(100e6) === 390625 &&
    softwareTestHalfSignalHz(100e6) === 195312.5 &&
    softwareTestSignalHz(200e6) === 781250 &&
    softwareTestHalfSignalHz(200e6) === 390625,
  `${softwareTestSignalHz(100e6)} Hz and ${softwareTestHalfSignalHz(100e6)} Hz at 100 MS/s`);

check('the pattern zero code is the 32U3 profile zero code',
  SLOGIC32U3_PROFILE.analog.groups.length === 4 &&
    SLOGIC32U3_PROFILE.analog.groups[0]!.zeroCode === SOFTWARE_TEST_ZERO_CODE,
  `profile ${String(SLOGIC32U3_PROFILE.analog.groups[0]?.zeroCode)}`);

check('the pattern constants are the documented literals',
  SOFTWARE_TEST_ZERO_CODE === 128 &&
    SOFTWARE_TEST_AMPLITUDE_CODES === 96 &&
    SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES === 256 &&
    SOFTWARE_TEST_TILE_SAMPLES === 512,
  `zero ${SOFTWARE_TEST_ZERO_CODE}, amplitude ${SOFTWARE_TEST_AMPLITUDE_CODES}, ` +
    `period ${SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES}, tile ${SOFTWARE_TEST_TILE_SAMPLES}`);

{
  const real = patternOf(32, 4);
  const shortAmp = new SoftwareTestPattern({
    channels: 32, analogGroups: 4, amplitudeCodes: SOFTWARE_TEST_AMPLITUDE_CODES - 1,
  });
  check('control: one code of amplitude is detected',
    amplitudeMismatch(real, SOFTWARE_TEST_AMPLITUDE_CODES) === null &&
      amplitudeMismatch(real, SOFTWARE_TEST_AMPLITUDE_CODES - 1) !== null &&
      amplitudeMismatch(shortAmp, SOFTWARE_TEST_AMPLITUDE_CODES) !== null,
    `real ${String(amplitudeMismatch(real, SOFTWARE_TEST_AMPLITUDE_CODES))}, ` +
      `amplitude-1 ${String(amplitudeMismatch(real, SOFTWARE_TEST_AMPLITUDE_CODES - 1))}, ` +
      `table ${String(amplitudeMismatch(shortAmp, SOFTWARE_TEST_AMPLITUDE_CODES))}`);
}

expectRangeError('a channel count off the supported widths is refused',
  () => patternOf(12, 0));
expectRangeError('a channel count above 128 is refused', () => patternOf(256, 0));
expectRangeError('analog groups beyond the width are refused', () => patternOf(8, 2));
expectRangeError('analog groups beyond four are refused', () => patternOf(64, 5));
expectRangeError('a negative analog group count is refused', () => patternOf(32, -1));
expectRangeError('a fractional analog group count is refused', () => patternOf(32, 1.5));
expectRangeError('a zero code above 255 is refused',
  () => new SoftwareTestPattern({ channels: 32, analogGroups: 4, zeroCode: 256 }));
expectRangeError('a fractional zero code is refused',
  () => new SoftwareTestPattern({ channels: 32, analogGroups: 4, zeroCode: 128.5 }));
expectRangeError('an amplitude below one code is refused',
  () => new SoftwareTestPattern({ channels: 32, analogGroups: 4, amplitudeCodes: 0 }));
expectRangeError('a fractional amplitude is refused',
  () => new SoftwareTestPattern({ channels: 32, analogGroups: 4, amplitudeCodes: 3.5 }));
expectRangeError('a swing below code 0 is refused',
  () => new SoftwareTestPattern({ channels: 32, analogGroups: 4, zeroCode: 100, amplitudeCodes: 101 }));
expectRangeError('a swing above code 255 is refused',
  () => new SoftwareTestPattern({ channels: 32, analogGroups: 4, zeroCode: 200 }));

{
  const pattern = patternOf(16, 2);
  expectRangeError('a negative fill start is refused', () => pattern.fill(new Uint8Array(2), -1));
  expectRangeError('a fractional fill start is refused', () => pattern.fill(new Uint8Array(2), 1.5));
  expectRangeError('an unsafe fill start is refused',
    () => pattern.fill(new Uint8Array(2), Number.MAX_SAFE_INTEGER + 2));
  expectRangeError('an empty fill target is refused', () => pattern.fill(new Uint8Array(0), 0));
  expectRangeError('a fill target off the sample grid is refused',
    () => pattern.fill(new Uint8Array(3), 0));
  expectRangeError('a non-positive rate is refused', () => softwareTestSignalHz(0));
  expectRangeError('a non-finite rate is refused', () => softwareTestHalfSignalHz(Number.POSITIVE_INFINITY));
  check('control: the refusal probe accepts a valid pattern',
    thrown(() => new SoftwareTestPattern({ channels: 32, analogGroups: 4 })) === null &&
      thrown(() => pattern.fill(new Uint8Array(4), 0)) === null,
    'valid construction and fill');
}

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
