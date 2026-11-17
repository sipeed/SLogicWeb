// SPDX-License-Identifier: GPL-3.0-or-later
/** Host-side checks for the software test pattern, its stream pump and its device adapter. */

import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import { reverseAdcByte } from '../data/softwareTrigger.js';
import { SLOGIC32U3_PROFILE } from './profiles.js';
import type { CaptureConfig, Device } from './types.js';
import {
  REAL_SOFTWARE_TEST_SCHEDULE,
  SOFTWARE_TEST_CHUNK_BYTES,
  SoftwareTestStream,
  softwareTestDevice,
  type SoftwareTestSchedule,
  type SoftwareTestStreamOptions,
} from './softwareTestSource.js';
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

class FakeSchedule implements SoftwareTestSchedule {
  private readonly callbacks = new Map<number, () => void>();
  private nextHandle = 1;

  set(fn: () => void): unknown {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, fn);
    return handle;
  }

  clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  get pending(): number {
    return this.callbacks.size;
  }

  run(cap = 64): number {
    let ticks = 0;
    while (this.callbacks.size > 0 && ticks < cap) {
      const [handle, fn] = this.callbacks.entries().next().value!;
      this.callbacks.delete(handle);
      fn();
      ticks++;
    }
    return ticks;
  }
}

interface StreamRecord {
  chunks: number[];
  events: string[];
  bytes: Uint8Array[];
}

function freshRecord(): StreamRecord {
  return { chunks: [], events: [], bytes: [] };
}

function recordingSink(record: StreamRecord): (chunk: Uint8Array) => void {
  return (chunk) => {
    record.chunks.push(chunk.length);
    record.events.push('sink');
    record.bytes.push(chunk);
  };
}

function streamWith(overrides: Partial<SoftwareTestStreamOptions> = {}): SoftwareTestStream {
  return new SoftwareTestStream({
    channels: 8,
    samplerate: 1e6,
    analogGroups: 1,
    zeroCode: SOFTWARE_TEST_ZERO_CODE,
    sink: () => undefined,
    schedule: new FakeSchedule(),
    chunkBytes: 4,
    ...overrides,
  });
}

async function rejected(run: () => Promise<void>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function totalBytes(record: StreamRecord): number {
  return record.chunks.reduce((sum, bytes) => sum + bytes, 0);
}

check('the default chunk constant is 4 MiB',
  SOFTWARE_TEST_CHUNK_BYTES === 4 * 1024 * 1024,
  `${SOFTWARE_TEST_CHUNK_BYTES} bytes`);

{
  let ran = false;
  const cleared = REAL_SOFTWARE_TEST_SCHEDULE.set(() => { ran = true; });
  REAL_SOFTWARE_TEST_SCHEDULE.clear(cleared);
  await new Promise((resolve) => setTimeout(resolve, 5));
  check('the real schedule clears a pending tick', ran === false, `ran ${String(ran)}`);

  const ranLater = { value: false };
  REAL_SOFTWARE_TEST_SCHEDULE.set(() => { ranLater.value = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  check('the real schedule runs a tick asynchronously', ranLater.value,
    `ran ${String(ranLater.value)}`);
}

{
  const schedule = new FakeSchedule();
  const record = freshRecord();
  const observed: number[] = [];
  const stream: SoftwareTestStream = streamWith({
    sink: (chunk) => {
      record.chunks.push(chunk.length);
      record.events.push('sink');
      record.bytes.push(chunk);
      observed.push(stream.emittedSamples);
    },
    samples: 10,
    onEnd: () => { record.events.push('end'); },
    schedule,
  });
  stream.start();
  const ticks = schedule.run();
  check('a finite budget streams whole chunks, then ends once',
    ticks === 3 && record.chunks.join(',') === '4,4,2' &&
      record.events.join(',') === 'sink,sink,sink,end' &&
      stream.emittedSamples === 10 && stream.finished && schedule.pending === 0,
    `${ticks} ticks, chunks ${record.chunks.join('/')}, events ${record.events.join(',')}, ` +
      `emitted ${stream.emittedSamples}, finished ${String(stream.finished)}, ` +
      `pending ${schedule.pending}`);

  check('the emitted count advances before the sink call',
    observed.join(',') === '4,8,10',
    `emitted at each sink call ${observed.join('/')}`);

  const joined = new Uint8Array(record.chunks.reduce((sum, bytes) => sum + bytes, 0));
  let at = 0;
  for (const chunk of record.bytes) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  const whole = new Uint8Array(joined.length);
  patternOf(8, 1).fill(whole, 0);
  check('the stream advances the pattern by whole chunks',
    equalBytes(joined, whole) && at === joined.length,
    `${at} bytes compared with one fill`);
}

{
  const schedule = new FakeSchedule();
  const record = freshRecord();
  const stream = streamWith({
    sink: recordingSink(record), samples: 7, chunkBytes: 3, schedule,
  });
  stream.start();
  schedule.run();
  check('a budget that is not a chunk multiple delivers exactly the budget',
    record.chunks.join(',') === '3,3,1' && totalBytes(record) === 7 &&
      stream.emittedSamples === 7 && stream.finished &&
      Math.ceil(7 / 3) * 3 === 9,
    `chunks ${record.chunks.join('/')}, ${totalBytes(record)} bytes, ` +
      `a padded tail would deliver 9`);
}

{
  const schedule = new FakeSchedule();
  const record = freshRecord();
  const stream = streamWith({
    channels: 16, sink: recordingSink(record), schedule, chunkBytes: 8,
  });
  stream.start();
  const ticks = schedule.run(3);
  const emitted = stream.emittedSamples;
  await stream.stop();
  const pending = schedule.pending;
  const ticksAfterStop = schedule.run();
  const stopAgain = await rejected(() => stream.stop());
  check('an unbounded stream stops on request and never ticks again',
    ticks === 3 && record.chunks.length === 3 && emitted === 12 &&
      stream.emittedSamples === emitted && pending === 0 && ticksAfterStop === 0 &&
      stopAgain === null && !stream.finished,
    `${ticks} ticks, ${emitted} samples, pending ${pending}, ` +
      `${ticksAfterStop} ticks after stop`);
}

{
  const schedule = new FakeSchedule();
  const record = freshRecord();
  let chunks = 0;
  let stopPromise: Promise<void> = Promise.resolve();
  const stream: SoftwareTestStream = new SoftwareTestStream({
    channels: 8,
    samplerate: 1e6,
    analogGroups: 1,
    zeroCode: SOFTWARE_TEST_ZERO_CODE,
    schedule,
    chunkBytes: 4,
    sink: (chunk) => {
      record.chunks.push(chunk.length);
      chunks++;
      if (chunks === 1) stopPromise = stream.stop();
    },
  });
  stream.start();
  const ticks = schedule.run();
  const raced = await Promise.race([
    stopPromise.then(() => 'stopped'),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50)),
  ]);
  check('a stop from inside the sink resolves after the tick, without a new chunk',
    raced === 'stopped' && chunks === 1 && ticks === 1 && schedule.pending === 0 &&
      stream.emittedSamples === 4,
    `${raced} after ${ticks} tick, ${chunks} chunks, ${stream.emittedSamples} samples`);
}

{
  const schedule = new FakeSchedule();
  const record = freshRecord();
  let stopPromise: Promise<void> = Promise.resolve();
  const stream: SoftwareTestStream = new SoftwareTestStream({
    channels: 8,
    samplerate: 1e6,
    analogGroups: 1,
    zeroCode: SOFTWARE_TEST_ZERO_CODE,
    schedule,
    chunkBytes: 4,
    samples: 4,
    onEnd: () => { record.events.push('end'); },
    sink: (chunk) => {
      record.chunks.push(chunk.length);
      stopPromise = stream.stop();
    },
  });
  stream.start();
  const ticks = schedule.run();
  await stopPromise;
  const afterStop = schedule.run();
  check('a caller stop in the final tick keeps the completion callback silent',
    ticks === 1 && record.chunks.join(',') === '4' && !record.events.includes('end') &&
      stream.finished && stream.emittedSamples === 4 && afterStop === 0,
    `${ticks} tick, chunks ${record.chunks.join('/')}, ` +
      `events ${record.events.join(',') || 'none'}, finished ${String(stream.finished)}, ` +
      `pending after stop ${afterStop}`);

  const midSchedule = new FakeSchedule();
  const midRecord = freshRecord();
  let midStop: Promise<void> = Promise.resolve();
  let midEnds = 0;
  const mid = new SoftwareTestStream({
    channels: 8,
    samplerate: 1e6,
    analogGroups: 1,
    zeroCode: SOFTWARE_TEST_ZERO_CODE,
    schedule: midSchedule,
    chunkBytes: 4,
    samples: 12,
    onEnd: () => { midEnds++; },
    sink: (chunk) => {
      midRecord.chunks.push(chunk.length);
      midStop = mid.stop();
    },
  });
  mid.start();
  const midTicks = midSchedule.run();
  await midStop;
  check('a caller stop before the budget never reports completion',
    midTicks === 1 && midRecord.chunks.length === 1 && midEnds === 0 && !mid.finished &&
      mid.emittedSamples === 4 && midSchedule.pending === 0,
    `${midTicks} tick, ${midRecord.chunks.length} chunk, ends ${midEnds}, ` +
      `finished ${String(mid.finished)}, ${mid.emittedSamples} samples`);
}

{
  const stream = streamWith();
  const beforeStart = await rejected(() => stream.stop());
  const beforeStartAgain = await rejected(() => stream.stop());
  check('stop resolves before start and is idempotent',
    beforeStart === null && beforeStartAgain === null && !stream.finished,
    'both calls resolved');

  const fresh = streamWith({ schedule: new FakeSchedule() });
  const first = thrown(() => fresh.start());
  const second = thrown(() => fresh.start());
  await fresh.stop();
  const afterStop = thrown(() => fresh.start());
  check('start throws on the second call and after stop',
    first === null && second instanceof Error && afterStop instanceof Error,
    `first ${String(first)}, second ${String(second)}, after stop ${String(afterStop)}`);
}

{
  expectRangeError('a zero sample budget is refused', () => streamWith({ samples: 0 }));
  expectRangeError('a negative sample budget is refused', () => streamWith({ samples: -4 }));
  expectRangeError('a fractional sample budget is refused', () => streamWith({ samples: 2.5 }));
  expectRangeError('a chunk below one sample is refused', () => streamWith({ chunkBytes: 0 }));
  expectRangeError('a fractional chunk is refused', () => streamWith({ chunkBytes: 2.5 }));
  expectRangeError('a non-positive samplerate is refused', () => streamWith({ samplerate: 0 }));
  expectRangeError('a non-finite samplerate is refused',
    () => streamWith({ samplerate: Number.POSITIVE_INFINITY }));
  expectRangeError('an unsupported width is refused',
    () => streamWith({ channels: 12 as ChannelCount }));
  const badSink = thrown(() => streamWith({ sink: 0 as unknown as SoftwareTestStreamOptions['sink'] }));
  check('a non-callable sink is refused', badSink instanceof TypeError, String(badSink));
  check('control: the stream probe accepts a valid configuration',
    thrown(() => streamWith()) === null && thrown(() => streamWith({ samples: 1, chunkBytes: 1 })) === null,
    'valid construction');
}

{
  const schedule = new FakeSchedule();
  const baseCalls: string[] = [];
  const base: Device = {
    name: 'Fake SLogic32U3',
    serial: 'FAKE-0001',
    async start(): Promise<void> {
      baseCalls.push('start');
      throw new Error('the base device must not be started');
    },
    async stop(): Promise<void> {
      baseCalls.push('stop');
    },
    terminate(): void {
      baseCalls.push('terminate');
    },
  };
  const cfg: CaptureConfig = { channels: 8, samplerate: 1e6, thresholdVolts: 1.2, testMode: 0 };
  const adapter = softwareTestDevice(base, {
    analogGroups: 1, zeroCode: SOFTWARE_TEST_ZERO_CODE, schedule,
  });
  check('the software source delegates device metadata',
    adapter.name === base.name && adapter.serial === base.serial,
    `${adapter.name} / ${adapter.serial}`);

  const record = freshRecord();
  await adapter.start(cfg, recordingSink(record));
  const ticks = schedule.run(3);
  const streamed = record.chunks.length;
  await adapter.stop();
  const pending = schedule.pending;
  const afterStop = schedule.run();
  check('the software source streams a capture and stops on request',
    ticks === 3 && streamed === 3 && record.chunks.length === 3 && pending === 0 &&
      afterStop === 0,
    `${ticks} ticks, ${streamed} chunks, pending ${pending}, ${afterStop} after stop`);

  let ended = 0;
  const limitedRecord = freshRecord();
  const limited = softwareTestDevice(base, {
    analogGroups: 1, zeroCode: SOFTWARE_TEST_ZERO_CODE, schedule,
  });
  await limited.start(cfg, recordingSink(limitedRecord), undefined, {
    deviceSampleLimit: 10,
    onEnd: () => { ended++; },
  });
  schedule.run();
  check('the adapter forwards the host budget and ends once',
    ended === 1 && totalBytes(limitedRecord) === 10 && schedule.pending === 0,
    `ended ${ended}, ${totalBytes(limitedRecord)} bytes`);

  let zeroEnds = 0;
  const zeroRecord = freshRecord();
  const zeroLimited = softwareTestDevice(base, {
    analogGroups: 1, zeroCode: SOFTWARE_TEST_ZERO_CODE, schedule,
  });
  const zeroStart = await rejected(() => zeroLimited.start(
    cfg, recordingSink(zeroRecord), undefined,
    { deviceSampleLimit: 0, onEnd: () => { zeroEnds++; } },
  ));
  const zeroTicks = schedule.run(2);
  const zeroChunks = zeroRecord.chunks.length;
  await zeroLimited.stop();
  check('a zero device sample limit means an unbounded stream',
    zeroStart === null && zeroTicks === 2 && zeroChunks === 2 && zeroEnds === 0 &&
      schedule.pending === 0,
    `start ${String(zeroStart)}, ${zeroTicks} ticks, ${zeroChunks} chunks, ends ${zeroEnds}`);

  const terminatedRecord = freshRecord();
  const terminated = softwareTestDevice(base, {
    analogGroups: 1, zeroCode: SOFTWARE_TEST_ZERO_CODE, schedule,
  });
  await terminated.start(cfg, recordingSink(terminatedRecord));
  schedule.run(1);
  terminated.terminate();
  const afterTerminate = terminatedRecord.chunks.length;
  schedule.run();
  check('terminate stops the pump',
    schedule.pending === 0 && terminatedRecord.chunks.length === afterTerminate,
    `${afterTerminate} chunks kept`);

  const triggerAdapter = softwareTestDevice(base, {
    analogGroups: 1, zeroCode: SOFTWARE_TEST_ZERO_CODE, schedule,
  });
  const triggerError = await rejected(() =>
    triggerAdapter.start(cfg, () => undefined, undefined, {
      softwareTrigger: { channels: 8, preTriggerSamples: 0, maxSamples: 16 },
    }));
  check('the software source refuses a software trigger', triggerError instanceof Error,
    String(triggerError));

  const twice = softwareTestDevice(base, {
    analogGroups: 1, zeroCode: SOFTWARE_TEST_ZERO_CODE, schedule,
  });
  await twice.start(cfg, () => undefined);
  const secondStart = await rejected(() => twice.start(cfg, () => undefined));
  const twiceStop = await rejected(() => twice.stop());
  check('the software source refuses a second start and stops idempotently',
    secondStart instanceof Error && twiceStop === null,
    `second start ${String(secondStart)}, second stop ${String(twiceStop)}`);

  check('the software source never starts, stops or terminates the base device',
    baseCalls.length === 0, baseCalls.join(',') || 'no base call');
}

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
