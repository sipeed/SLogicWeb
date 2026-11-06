// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Self-contained checks for the deterministic M0 SimDriver.
 *
 * Run:
 *   node_modules/.bin/esbuild src/device/simDriverSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/simdriver-selftest.mjs --log-level=error
 *   node /tmp/simdriver-selftest.mjs
 *
 * Every check is deterministic and host-driven: the file uses no timers, no hardware
 * and no test framework.
 */

import type { ChannelCount } from '../types.js';
import { MAX_SAMPLES, bytesPerSampleForChannels } from '../types.js';
import { MACRO_SAMPLES, fillMacro, makeTileBlock } from '../data/generator.js';
import { compileTriggerPlan, type TriggerPlan } from '../dsp/triggerPlan.js';
import type { DeviceProfile, TriggerKind } from './profileTypes.js';
import { SLOGIC16U3_PROFILE, SLOGIC32U3_PROFILE } from './profiles.js';
import {
  SIM_CH0_PERIOD_SAMPLES,
  SimDriver,
  SimDriverError,
  type SimDriverErrorCode,
  type SimDriverOptions,
  type SimFault,
  type SimGapSpan,
  type SimSink,
  type SimStartConfig,
} from './simDriver.js';
import { analogVoltsFromCode } from '../ui/channelBanks.js';

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

function describeError(error: unknown): string {
  if (error instanceof SimDriverError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function expectReject(
  name: string,
  run: () => Promise<unknown>,
  code: SimDriverErrorCode,
): Promise<void> {
  try {
    await run();
    check(name, false, 'resolved instead of rejecting');
  } catch (error) {
    check(
      name,
      error instanceof SimDriverError && error.code === code,
      describeError(error),
    );
  }
}

// ---------------------------------------------------------------- test helpers

class RecordingSink implements SimSink {
  readonly writes: Array<{ startByte: number; bytes: Uint8Array }> = [];
  readonly gaps: SimGapSpan[] = [];

  write(chunk: Uint8Array, startByte: number): void {
    this.writes.push({ startByte, bytes: chunk.slice() });
  }

  noteGap(gap: SimGapSpan): void {
    this.gaps.push({ ...gap });
  }

  /** Bytes in delivery order; valid as a stream when writes are contiguous. */
  bytes(): Uint8Array {
    let total = 0;
    for (const write of this.writes) total += write.bytes.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const write of this.writes) {
      out.set(write.bytes, offset);
      offset += write.bytes.length;
    }
    return out;
  }

  /**
   * True when every write starts exactly where the previous one ended. The first write
   * may start at a nonzero stream origin (a triggered acquisition starts at T-pre).
   */
  contiguous(): boolean {
    const first = this.writes[0];
    if (first === undefined) return true;
    let expected = first.startByte;
    for (const write of this.writes) {
      if (write.startByte !== expected) return false;
      expected += write.bytes.length;
    }
    return true;
  }

  /** Bytes for a sample range, or null when any byte in the range was not delivered. */
  bytesInRange(startSample: number, samples: number, bytesPerSample: number): Uint8Array | null {
    const out = new Uint8Array(samples * bytesPerSample);
    const covered = new Uint8Array(out.length);
    const from = startSample * bytesPerSample;
    const to = from + out.length;
    for (const write of this.writes) {
      const writeStart = write.startByte;
      const writeEnd = writeStart + write.bytes.length;
      const start = Math.max(writeStart, from);
      const end = Math.min(writeEnd, to);
      if (start >= end) continue;
      out.set(write.bytes.subarray(start - writeStart, end - writeStart), start - from);
      covered.fill(1, start - from, end - from);
    }
    for (let i = 0; i < covered.length; i++) if (covered[i] === 0) return null;
    return out;
  }
}

/** A sink with no gap path, used to prove the typed dropout fallback. */
class WriteOnlySink implements SimSink {
  bytesWritten = 0;
  write(chunk: Uint8Array): void {
    this.bytesWritten += chunk.length;
  }
}

function equalBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const byte of bytes) parts.push(byte.toString(16).padStart(2, '0'));
  return parts.join(' ');
}

const TEST_TILE = makeTileBlock();

/** Generator words for one macro period with the same seed the driver is using. */
function generatorWords(seed: number): Uint16Array {
  const macro = new Uint16Array(MACRO_SAMPLES);
  fillMacro(macro, 0, seed, TEST_TILE);
  return macro;
}

/** Independent little-endian packing of generator words for one width. */
function expectedBytes(seed: number, channels: ChannelCount, samples: number): Uint8Array {
  const macro = generatorWords(seed);
  const bps = bytesPerSampleForChannels(channels);
  const out = new Uint8Array(samples * bps);
  const usedBits = channels % 8;
  const tailMask = usedBits === 0 ? 0xff : (1 << usedBits) - 1;
  let offset = 0;
  for (let i = 0; i < samples; i++) {
    const low = macro[i]!;
    const word = channels > 16 ? (low | ((~low & 0xffff) << 16)) >>> 0 : low;
    for (let byte = 0; byte < bps; byte++) out[offset++] = (word >>> (byte * 8)) & 0xff;
    if (tailMask !== 0xff) out[offset - 1] = out[offset - 1]! & tailMask;
  }
  return out;
}

function startConfig(
  channels: ChannelCount,
  samplerate = 5e6,
  testMode?: 0 | 1 | 2,
): SimStartConfig {
  return {
    channels,
    samplerate,
    ...(testMode === undefined ? {} : { testMode }),
  };
}

/**
 * A real TriggerPlan from the M0 compiler. `preTriggerPercent` is a fraction of
 * `postSamples`; the compiler fills `preTrigger.samples`, the exact integer the
 * simulator must prefer over a `seconds * samplerate` round-trip.
 */
function compiledDigitalPlan(
  conditions: ReadonlyArray<{ signal: string; kind: TriggerKind; level?: 0 | 1 }>,
  channels: ChannelCount,
  samplerate: number,
  preTriggerPercent: number,
  postSamples: number,
  profile: DeviceProfile = SLOGIC32U3_PROFILE,
): TriggerPlan {
  const result = compileTriggerPlan({
    profile,
    enableMask: true,
    source: 'digital',
    digital: conditions,
    analog: [],
    preTriggerPercent,
    postTrigger: { kind: 'samples', value: postSamples },
    capture: { samplerate, channels },
    compiledAt: 0,
  });
  if (!result.ok) {
    throw new Error(`compiledDigitalPlan failed: ${result.reason}: ${result.detail}`);
  }
  return result.plan;
}

function analogPlan(): TriggerPlan {
  return {
    source: 'analog',
    conditions: [{ kind: 'analog', signal: 'a0', mode: 'rising', volts: 1 }],
    execution: 'host',
    preTrigger: { percent: 0, seconds: 0, capBytes: 0 },
    budget: { kind: 'samples', value: 8 },
    compiledAt: 0,
  };
}

interface DeliveredRange {
  first: number;
  end: number;
  samples: number;
  contiguous: boolean;
}

/** First/last emitted sample positions from the writes, in sample units. */
function deliveredRange(
  sink: RecordingSink,
  bytesPerSample: number,
): DeliveredRange | null {
  if (sink.writes.length === 0) return null;
  const firstWrite = sink.writes[0]!;
  const lastWrite = sink.writes[sink.writes.length - 1]!;
  const first = firstWrite.startByte / bytesPerSample;
  const end = (lastWrite.startByte + lastWrite.bytes.length) / bytesPerSample;
  return { first, end, samples: end - first, contiguous: sink.contiguous() };
}

/** True when no written sample range overlaps a gap the sink was told about. */
function writesAvoidGaps(sink: RecordingSink, bytesPerSample: number): boolean {
  for (const write of sink.writes) {
    const from = write.startByte / bytesPerSample;
    const to = (write.startByte + write.bytes.length) / bytesPerSample;
    for (const gap of sink.gaps) {
      if (from < gap.end && to > gap.start) return false;
    }
  }
  return true;
}

/** Expected bytes for samples [from, from + samples) of the deterministic generator. */
function expectedSampleRange(
  seed: number,
  channels: ChannelCount,
  from: number,
  samples: number,
): Uint8Array {
  const bps = bytesPerSampleForChannels(channels);
  const end = from + samples;
  return expectedBytes(seed, channels, end).subarray(from * bps, end * bps);
}

/** Run a bounded trigger plan to completion with deterministic host-driven steps. */
async function runBoundedTrigger(
  plan: TriggerPlan,
  channels: ChannelCount,
  options: SimDriverOptions = {},
  samplerate = 5e6,
): Promise<{ driver: SimDriver; sink: RecordingSink; steps: number }> {
  const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234, ...options });
  const sink = new RecordingSink();
  await driver.start(startConfig(channels, samplerate), sink, { trigger: plan });
  let steps = 0;
  while (!driver.complete && driver.state !== 'stopped' && steps < 1000) {
    await driver.step(4096);
    steps += 1;
  }
  return { driver, sink, steps };
}

async function capture(
  profile: DeviceProfile,
  channels: ChannelCount,
  options: SimDriverOptions,
  samples: number,
): Promise<RecordingSink> {
  const driver = new SimDriver(profile, options);
  const sink = new RecordingSink();
  await driver.start(startConfig(channels), sink);
  await driver.step(samples);
  return sink;
}

// ---------------------------------------------------------------- determinism

{
  const first = await capture(SLOGIC32U3_PROFILE, 8, { seed: 0x1234 }, 64);
  const second = await capture(SLOGIC32U3_PROFILE, 8, { seed: 0x1234 }, 64);
  check(
    'same seed produces identical bytes',
    equalBytes(first.bytes(), second.bytes()) && first.contiguous(),
    `${first.bytes().length} bytes, contiguous=${first.contiguous()}`,
  );

  const expected = expectedBytes(0x1234, 8, 64);
  check(
    'generator seed and packing match the reference bytes',
    equalBytes(first.bytes(), expected),
    `driver=${toHex(first.bytes().subarray(0, 16))}\n        expected=${toHex(expected.subarray(0, 16))}`,
  );

  // Literal prefix recorded from the generator, so a generator change is caught.
  const literal = '18 18 19 19 18 18 19 19 18 18 19 19 18 18 19 19';
  check(
    'first 16 bytes for seed 0x1234 are stable',
    toHex(first.bytes().subarray(0, 16)) === literal,
    toHex(first.bytes().subarray(0, 16)),
  );

  const ch0: number[] = [];
  for (let i = 0; i < 8; i++) ch0.push(first.bytes()[i]! & 1);
  check(
    'CH0 follows the defined period-4 square wave',
    SIM_CH0_PERIOD_SAMPLES === 4 && ch0.join('') === '00110011',
    `levels=${ch0.join('')}, period=${SIM_CH0_PERIOD_SAMPLES}`,
  );
}

// ---------------------------------------------------------------- packing widths

const WIDTHS: readonly ChannelCount[] = [4, 8, 16, 32];

for (const channels of WIDTHS) {
  const bps = bytesPerSampleForChannels(channels);
  const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234, transferBytes: 1 << 20 });
  const sink = new RecordingSink();
  await driver.start(startConfig(channels), sink);
  const advanced = await driver.step(16);
  const expected = expectedBytes(0x1234, channels, 16);
  check(
    `${channels} channels pack ${bps} byte(s) per little-endian sample`,
    advanced === 16 &&
      sink.writes.length === 1 &&
      sink.writes[0]!.startByte === 0 &&
      sink.writes[0]!.bytes.length === 16 * bps &&
      equalBytes(sink.bytes(), expected),
    `advanced=${advanced}, writes=${sink.writes.map((w) => w.bytes.length).join('/')}, ` +
      `bytes=${toHex(sink.bytes().subarray(0, Math.min(8, sink.bytes().length)))}`,
  );
}

{
  // Transfer geometry: a 7-byte target on 16 channels carries three 2-byte samples.
  const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234, transferBytes: 7 });
  const sink = new RecordingSink();
  await driver.start(startConfig(16), sink);
  await driver.step(8);
  const lengths = sink.writes.map((write) => write.bytes.length);
  check(
    'transferBytes bounds a transfer without splitting a normal sample',
    lengths.join('/') === '6/6/4' && sink.contiguous() &&
      equalBytes(sink.bytes(), expectedBytes(0x1234, 16, 8)),
    `lengths=${lengths.join('/')}, contiguous=${sink.contiguous()}`,
  );
}

// ---------------------------------------------------------------- stop and restart

{
  const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed: 7, transferBytes: 1 << 16 });
  const first = new RecordingSink();
  await driver.start(startConfig(8), first);
  const firstAdvanced = await driver.step(32);
  await driver.stop();
  await driver.stop();
  check(
    'stop reaches the stopped state and is idempotent',
    driver.state === 'stopped' && firstAdvanced === 32,
    `state=${driver.state}, advanced=${firstAdvanced}`,
  );
  await expectReject('step after stop is refused', () => driver.step(1), 'not-started');

  const second = new RecordingSink();
  await driver.start(startConfig(8), second);
  const secondAdvanced = await driver.step(32);
  check(
    'restart reproduces the same deterministic run',
    driver.state === 'running' && secondAdvanced === 32 &&
      equalBytes(first.bytes(), second.bytes()),
    `state=${driver.state}, bytes=${second.bytes().length}`,
  );

  await expectReject(
    'a second start while running is refused',
    () => driver.start(startConfig(8), new RecordingSink()),
    'already-started',
  );
}

// ---------------------------------------------------------------- updateTrigger

{
  const config = startConfig(8);
  const plan = compiledDigitalPlan([{ signal: 'd0', kind: 'rising' }], 8, 5e6, 25, 8);
  check(
    'the compiler plan states the exact pre-trigger sample count',
    plan.preTrigger.samples === 2 && plan.preTrigger.percent === 25 &&
      plan.preTrigger.seconds === 2 / 5e6,
    `samples=${String(plan.preTrigger.samples)}, seconds=${plan.preTrigger.seconds}`,
  );

  const free = new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234 });
  const freeSink = new RecordingSink();
  await free.start(config, freeSink);
  check(
    'updateTrigger is refused while free-running',
    free.state === 'running' && free.updateTrigger(plan) === false,
    `state=${free.state}`,
  );

  const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234 });
  const sink = new RecordingSink();
  await driver.start(config, sink, { trigger: plan });
  check(
    'a start with a trigger waits and accepts a retune',
    driver.state === 'waiting' && driver.updateTrigger(plan) === true,
    `state=${driver.state}`,
  );

  const rejectedAnalog = driver.updateTrigger(analogPlan());
  const rejectedSignal = driver.updateTrigger(
    compiledDigitalPlan([{ signal: 'd99', kind: 'rising' }], 8, 5e6, 0, 8),
  );
  check(
    'updateTrigger refuses analog and out-of-range-signal plans',
    rejectedAnalog === false && rejectedSignal === false && driver.state === 'waiting',
    `analog=${String(rejectedAnalog)}, signal=${String(rejectedSignal)}, state=${driver.state}`,
  );

  const advanced = await driver.step(4);
  check(
    'd0 rising matches at sample 2 and flushes the pre-trigger window',
    advanced === 3 && driver.state === 'running' && driver.triggeredAt === 2 &&
      sink.bytes().length === 3 &&
      equalBytes(sink.bytes(), expectedBytes(0x1234, 8, 3)),
    `advanced=${advanced}, state=${driver.state}, T=${String(driver.triggeredAt)}, ` +
      `bytes=${toHex(sink.bytes())}`,
  );
  check(
    'updateTrigger is refused after a match',
    driver.updateTrigger(plan) === false,
    `state=${driver.state}`,
  );

  await expectReject(
    'start with an unsupported trigger plan is refused',
    () => new SimDriver(SLOGIC32U3_PROFILE).start(
      config, new RecordingSink(), { trigger: analogPlan() },
    ),
    'trigger-unsupported',
  );
}

// ---------------------------------------------------------------- stream origin

{
  // T=4 with one pre sample starts the stream at sample 3. The stream is not
  // backfilled from 0, and T stays an absolute coordinate.
  const plan = compiledDigitalPlan([{ signal: 'd0', kind: 'falling' }], 8, 5e6, 25, 4);
  const { driver, sink } = await runBoundedTrigger(plan, 8);
  const range = deliveredRange(sink, 1);
  check(
    'the first emitted sample is T-pre and is reported as an absolute origin',
    plan.preTrigger.samples === 1 &&
      driver.triggeredAt === 4 &&
      driver.firstSample === 3 &&
      range !== null &&
      range.first === 3 &&
      range.end === 3 + 1 + 4 &&
      sink.writes[0]?.startByte === 3 &&
      equalBytes(
        sink.bytesInRange(3, 5, 1),
        expectedSampleRange(0x1234, 8, 3, 5),
      ),
    `T=${String(driver.triggeredAt)}, first=${String(driver.firstSample)}, ` +
      `startByte=${String(sink.writes[0]?.startByte)}, ` +
      `range=${range === null ? 'none' : `${range.first}..${range.end}`}`,
  );
}

// ---------------------------------------------------------------- total budget guard

{
  // preSamples + postSamples must stay inside the shared sample envelope.
  const boundaryPlan = compiledDigitalPlan(
    [{ signal: 'd0', kind: 'rising' }], 8, 5e6, 0, MAX_SAMPLES - 1,
  );
  const oversizedPlan = compiledDigitalPlan(
    [{ signal: 'd0', kind: 'rising' }], 8, 5e6, 0, MAX_SAMPLES,
  );

  const accepted = new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234 });
  let acceptedDetail: string;
  try {
    await accepted.start(startConfig(8), new RecordingSink(), { trigger: boundaryPlan });
    acceptedDetail = `state=${accepted.state}`;
  } catch (error) {
    acceptedDetail = describeError(error);
  }
  check(
    'a finite plan at the MAX_SAMPLES-1 budget boundary is accepted',
    accepted.state === 'waiting' &&
      acceptedDetail === 'state=waiting' &&
      boundaryPlan.preTrigger.samples === 0,
    acceptedDetail,
  );
  await accepted.stop();

  await expectReject(
    'a finite plan above the MAX_SAMPLES-1 budget boundary is refused',
    () => new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234 }).start(
      startConfig(8), new RecordingSink(), { trigger: oversizedPlan },
    ),
    'invalid-config',
  );
}

// ---------------------------------------------------------------- stream gaps

{
  const seed = 0x1234;
  const channels: ChannelCount = 8;
  const samplerate = 5e6;

  {
    // The lost span [0,2) ends before the retained window's first sample.
    const plan = compiledDigitalPlan(
      [{ signal: 'd0', kind: 'rising' }], channels, samplerate, 75, 4,
    );
    const { driver, sink } = await runBoundedTrigger(plan, channels, {
      faults: [{ kind: 'dropout', atSample: 0, count: 2 }],
    }, samplerate);
    check(
      'a dropout wholly before firstSample is suppressed',
      plan.preTrigger.samples === 3 &&
        driver.triggeredAt === 6 &&
        driver.firstSample === 3 &&
        sink.gaps.length === 0 &&
        writesAvoidGaps(sink, 1) &&
        sink.writes[0]?.startByte === 3,
      `T=${String(driver.triggeredAt)}, first=${String(driver.firstSample)}, ` +
        `gaps=${JSON.stringify(sink.gaps)}`,
    );
  }

  {
    // [1,4) would overlap the window a match at T=6 would flush, so the arm rule skips
    // that candidate and accepts the next rising edge at T=10; the window starts at 7.
    const plan = compiledDigitalPlan(
      [{ signal: 'd0', kind: 'rising' }], channels, samplerate, 75, 4,
    );
    const { driver, sink } = await runBoundedTrigger(plan, channels, {
      faults: [{ kind: 'dropout', atSample: 1, count: 3 }],
    }, samplerate);
    check(
      'a dropout that would overlap the window delays arming past the gap',
      plan.preTrigger.samples === 3 &&
        driver.triggeredAt === 10 &&
        driver.firstSample === 7 &&
        sink.gaps.length === 0 &&
        sink.writes[0]?.startByte === 7 &&
        writesAvoidGaps(sink, 1),
      `T=${String(driver.triggeredAt)}, first=${String(driver.firstSample)}, ` +
        `gaps=${JSON.stringify(sink.gaps)}`,
    );
  }

  {
    // A dropout after T is inside the delivered post range and is reported there.
    const plan = compiledDigitalPlan(
      [{ signal: 'd0', kind: 'rising' }], channels, samplerate, 0, 8,
    );
    const { driver, sink } = await runBoundedTrigger(plan, channels, {
      faults: [{ kind: 'dropout', atSample: 5, count: 2 }],
    }, samplerate);
    const gap = sink.gaps[0];
    check(
      'a dropout after T is reported inside the delivered range',
      driver.triggeredAt === 2 &&
        driver.firstSample === 2 &&
        sink.gaps.length === 1 &&
        gap !== undefined && gap.start === 5 && gap.end === 7 &&
        sink.bytesInRange(5, 2, 1) === null &&
        writesAvoidGaps(sink, 1),
      `T=${String(driver.triggeredAt)}, first=${String(driver.firstSample)}, ` +
        `gaps=${JSON.stringify(sink.gaps)}`,
    );
  }

  {
    // The dropout starts inside the budget but runs past its end: report only the
    // delivered part, never the tail past deliveryEnd.
    const plan = compiledDigitalPlan(
      [{ signal: 'd0', kind: 'rising' }], channels, samplerate, 0, 4,
    );
    const { driver, sink } = await runBoundedTrigger(plan, channels, {
      faults: [{ kind: 'dropout', atSample: 3, count: 4 }],
    }, samplerate);
    const gap = sink.gaps[0];
    check(
      'a dropout straddling the delivered end is clipped at that end',
      driver.triggeredAt === 2 &&
        driver.firstSample === 2 &&
        sink.gaps.length === 1 &&
        gap !== undefined && gap.start === 3 && gap.end === 6 &&
        writesAvoidGaps(sink, 1),
      `T=${String(driver.triggeredAt)}, first=${String(driver.firstSample)}, ` +
        `gaps=${JSON.stringify(sink.gaps)}`,
    );
  }

  {
    // A long search with many dropouts buffers spans, not samples; none of them is
    // emitted into or reported, and the match arms only after a clean pre-window.
    const faults: SimFault[] = [];
    for (let i = 0; i < 8; i++) {
      faults.push({ kind: 'dropout', atSample: 0, count: 1 });
    }
    const plan = compiledDigitalPlan(
      [{ signal: 'd0', kind: 'rising' }], channels, samplerate, 50, 4,
    );
    const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed, faults });
    const sink = new RecordingSink();
    await driver.start(startConfig(channels, samplerate), sink, { trigger: plan });
    const waitingOnly = await driver.step(9);
    const beforeMatch = { writes: sink.writes.length, gaps: sink.gaps.length };
    // Eight one-sample gaps [0,1)..[7,8) leave the search at 8. preSamples=2 then
    // arms at 10, so the retained window [8,14) is clean.
    let steps = 0;
    while (!driver.complete && steps < 100) {
      await driver.step(4096);
      steps += 1;
    }
    const range = deliveredRange(sink, 1);
    check(
      'waiting dropouts buffer only bounded spans, never emitted sample data',
      waitingOnly === 9 && beforeMatch.writes === 0 && beforeMatch.gaps === 0 &&
        driver.triggeredAt === 10 &&
        driver.firstSample === 8 &&
        sink.gaps.length === 0 &&
        range !== null && range.first === 8 &&
        range.samples === plan.preTrigger.samples! + 4 &&
        writesAvoidGaps(sink, 1),
      `waiting=${waitingOnly}, before=${JSON.stringify(beforeMatch)}, ` +
        `T=${String(driver.triggeredAt)}, first=${String(driver.firstSample)}, ` +
        `gaps=${JSON.stringify(sink.gaps)}, delivered=${range?.samples}`,
    );
  }
}

// ---------------------------------------------------------------- short packet

{
  const base = await capture(SLOGIC32U3_PROFILE, 16, { seed: 0x55, transferBytes: 1 << 16 }, 16);
  const options: SimDriverOptions = {
    seed: 0x55,
    transferBytes: 1 << 16,
    faults: [{ kind: 'short-packet', atSample: 0, count: 1 }],
  };
  const driver = new SimDriver(SLOGIC32U3_PROFILE, options);
  const sink = new RecordingSink();
  await driver.start(startConfig(16), sink);
  const advanced = await driver.step(16);
  check(
    'short-packet shortens exactly one transfer and loses no bytes',
    advanced === 16 && sink.writes.length === 2 &&
      sink.writes[0]!.bytes.length === 31 &&
      sink.writes[1]!.bytes.length === 1 &&
      sink.contiguous() && equalBytes(sink.bytes(), base.bytes()),
    `advanced=${advanced}, writes=${sink.writes.map((w) => w.bytes.length).join('/')}, ` +
      `contiguous=${sink.contiguous()}`,
  );
  check(
    'short-packet splits a sample across the transfer boundary',
    sink.writes[0]!.bytes.length % 2 === 1,
    `first transfer=${sink.writes[0]!.bytes.length} bytes at 2 bytes/sample`,
  );

  const repeat = new SimDriver(SLOGIC32U3_PROFILE, options);
  const repeatSink = new RecordingSink();
  await repeat.start(startConfig(16), repeatSink);
  await repeat.step(16);
  check(
    'short-packet fault is deterministic',
    repeatSink.writes.length === sink.writes.length &&
      repeatSink.writes.every((write, index) =>
        write.startByte === sink.writes[index]!.startByte &&
        equalBytes(write.bytes, sink.writes[index]!.bytes)),
    repeatSink.writes.map((write) => `${write.startByte}+${write.bytes.length}`).join(' '),
  );
}

// ---------------------------------------------------------------- short packet and matching

{
  // The matching sample (T=2, 16-bit sample) is split across two transfers by a
  // short-packet fault. The match position and the sample bytes must still be the
  // completed sample, not the fragment.
  const channels: ChannelCount = 16;
  const bps = bytesPerSampleForChannels(channels);
  const plan = compiledDigitalPlan(
    [{ signal: 'd0', kind: 'rising' }], channels, 5e6, 50, 4,
  );
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 0x1234,
    transferBytes: 1 << 16,
    faults: [{ kind: 'short-packet', atSample: 2, count: 1 }],
  });
  const sink = new RecordingSink();
  await driver.start(startConfig(channels), sink, { trigger: plan });
  const matchedStep = await driver.step(8);
  const afterMatch = {
    T: driver.triggeredAt,
    first: driver.firstSample,
    writes: sink.writes.map((write) => `${write.startByte}+${write.bytes.length}`).join(' '),
  };
  const deliveredStep = await driver.step(8);

  const sampleAtT = sink.bytesInRange(2, 1, bps);
  check(
    'a short-packet split of the matching sample keeps the completed-sample match',
    plan.preTrigger.samples === 2 &&
      matchedStep === 3 &&
      afterMatch.T === 2 &&
      afterMatch.first === 0 &&
      deliveredStep === 3 &&
      driver.complete &&
      driver.triggeredAt === 2 &&
      sink.writes.length === 4 &&
      sink.writes[0]!.bytes.length === 4 &&
      sink.writes[1]!.startByte === 4 && sink.writes[1]!.bytes.length === 1 &&
      sink.writes[2]!.startByte === 5 && sink.writes[2]!.bytes.length === 1 &&
      sink.writes[3]!.startByte === 6 && sink.writes[3]!.bytes.length === 6 &&
      sink.contiguous() &&
      equalBytes(sink.bytes(), expectedBytes(0x1234, channels, 6)) &&
      equalBytes(sampleAtT, expectedSampleRange(0x1234, channels, 2, 1)),
    `matchedStep=${matchedStep}, T=${String(afterMatch.T)}, first=${String(afterMatch.first)}, ` +
      `deliveredStep=${deliveredStep}, writes=${afterMatch.writes}, ` +
      `sampleAtT=${sampleAtT === null ? 'missing' : toHex(sampleAtT)}`,
  );
}

// ---------------------------------------------------------------- stall

{
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 1,
    faults: [{ kind: 'stall', atSample: 0, count: 1 }],
  });
  const sink = new RecordingSink();
  await driver.start(startConfig(8), sink);
  const stalled = await driver.step(8);
  const bytesWhileStalled = sink.bytes().length;
  const recovered = await driver.step(8);
  check(
    'stall makes one step deliver nothing, then the next step resumes',
    stalled === 0 && bytesWhileStalled === 0 && recovered === 8 && sink.bytes().length === 8,
    `stalled=${stalled}, recovered=${recovered}, bytes=${sink.bytes().length}`,
  );

  const double = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 1,
    faults: [{ kind: 'stall', atSample: 0, count: 2 }],
  });
  const doubleSink = new RecordingSink();
  await double.start(startConfig(8), doubleSink);
  const first = await double.step(8);
  const second = await double.step(8);
  const third = await double.step(8);
  check(
    'stall count is the number of consecutive empty steps',
    first === 0 && second === 0 && third === 8 && doubleSink.bytes().length === 8,
    `${first}/${second}/${third}, bytes=${doubleSink.bytes().length}`,
  );

  const late = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 1,
    faults: [{ kind: 'stall', atSample: 4, count: 1 }],
  });
  const lateSink = new RecordingSink();
  await late.start(startConfig(8), lateSink);
  const before = await late.step(8);
  const bytesBeforeStall = lateSink.bytes().length;
  const after = await late.step(8);
  check(
    'a stall at a sample position stops that step at the boundary',
    before === 4 && bytesBeforeStall === 4 && after === 8 &&
      lateSink.bytes().length === 12,
    `before=${before}, after=${after}, bytes=${lateSink.bytes().length}`,
  );
}

// ---------------------------------------------------------------- quota

{
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 1,
    faults: [{ kind: 'quota', atSample: 4 }],
  });
  const sink = new RecordingSink();
  await driver.start(startConfig(8), sink);
  await expectReject(
    'a quota fault stops the step with a typed error',
    () => driver.step(16),
    'quota',
  );
  check(
    'a quota fault leaves the driver stopped',
    driver.state === 'stopped',
    driver.state,
  );
}

// ---------------------------------------------------------------- dropout

{
  const base = await capture(SLOGIC32U3_PROFILE, 16, { seed: 0x55, transferBytes: 1 << 16 }, 16);
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 0x55,
    transferBytes: 1 << 16,
    faults: [{ kind: 'dropout', atSample: 4, count: 8 }],
  });
  const sink = new RecordingSink();
  await driver.start(startConfig(16), sink);
  const advanced = await driver.step(16);
  const gap = sink.gaps[0];
  const before = sink.bytesInRange(0, 4, 2);
  const after = sink.bytesInRange(12, 4, 2);
  check(
    'dropout reports one gap and resumes at the far side',
    advanced === 16 && sink.gaps.length === 1 && gap !== undefined &&
      gap.group === 'digital' && gap.start === 4 && gap.end === 12 &&
      gap.reason === 'dropout' &&
      sink.bytesInRange(4, 8, 2) === null &&
      equalBytes(before, base.bytesInRange(0, 4, 2)) &&
      equalBytes(after, base.bytesInRange(12, 4, 2)),
    `advanced=${advanced}, gaps=${JSON.stringify(sink.gaps)}, ` +
      `writes=${sink.writes.map((w) => `${w.startByte}+${w.bytes.length}`).join(' ')}`,
  );

  await expectReject(
    'dropout without a sink gap path is a typed error',
    async () => {
      const noGap = new SimDriver(SLOGIC32U3_PROFILE, {
        faults: [{ kind: 'dropout', atSample: 0, count: 4 }],
      });
      await noGap.start(startConfig(8), new WriteOnlySink());
      await noGap.step(8);
    },
    'dropout',
  );

  // A dropout in the trigger search resets edge continuity; the next rising edge wins.
  // With preSamples=0 any generated sample after the gap may match, and the lost span
  // ends before the first emitted sample, so it is not reported.
  const waiting = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 0x1234,
    faults: [{ kind: 'dropout', atSample: 0, count: 4 }],
  });
  const waitingSink = new RecordingSink();
  await waiting.start(startConfig(8), waitingSink, {
    trigger: compiledDigitalPlan([{ signal: 'd0', kind: 'rising' }], 8, 5e6, 0, 4),
  });
  const matched = await waiting.step(8);
  check(
    'dropout during a trigger search skips the span and restarts edge continuity',
    matched === 7 && waiting.triggeredAt === 6 && waiting.state === 'running' &&
      waiting.firstSample === 6 &&
      waitingSink.gaps.length === 0 &&
      waitingSink.writes[0]?.startByte === 6,
    `advanced=${matched}, T=${String(waiting.triggeredAt)}, state=${waiting.state}, ` +
      `first=${String(waiting.firstSample)}, gaps=${JSON.stringify(waitingSink.gaps)}`,
  );
}

// ---------------------------------------------------------------- trigger matching

{
  // CH0 of the seeded generator is the period-4 square wave 0,0,1,1,... verified above.
  // For a plan with preSamples=2 and postSamples=4 the pre-fill holdoff applies: T is
  // the first sample at or after position 2 satisfying the condition. `low` already holds
  // at samples 0..1, but those are held off, so it fires at the next low run (4).
  const seed = 0x1234;
  const channels: ChannelCount = 8;
  const samplerate = 5e6;
  const preSamples = 2;
  const postSamples = 4;
  const total = preSamples + postSamples;
  const bps = bytesPerSampleForChannels(channels);

  const cases: ReadonlyArray<{
    label: string;
    relation: string;
    condition: { signal: string; kind: TriggerKind; level?: 0 | 1 };
    match: number;
  }> = [
    { label: 'level high', relation: 'T = pre', condition: { signal: 'd0', kind: 'level', level: 1 }, match: 2 },
    { label: 'high', relation: 'T = pre', condition: { signal: 'd0', kind: 'high' }, match: 2 },
    { label: 'low', relation: 'held off until pre', condition: { signal: 'd0', kind: 'low' }, match: 4 },
    { label: 'rising', relation: 'T = pre', condition: { signal: 'd0', kind: 'rising' }, match: 2 },
    { label: 'falling', relation: 'T > pre', condition: { signal: 'd0', kind: 'falling' }, match: 4 },
    { label: 'edge', relation: 'T = pre', condition: { signal: 'd0', kind: 'edge' }, match: 2 },
  ];

  for (const testCase of cases) {
    const plan = compiledDigitalPlan(
      [testCase.condition], channels, samplerate, 50, postSamples,
    );
    const { driver, sink } = await runBoundedTrigger(plan, channels, {}, samplerate);
    const first = Math.max(0, testCase.match - preSamples);
    const range = deliveredRange(sink, bps);
    check(
      `trigger ${testCase.label} matches at T=${testCase.match} (${testCase.relation}) ` +
        `and delivers pre+post samples`,
      plan.preTrigger.samples === preSamples &&
        driver.triggeredAt === testCase.match &&
        driver.firstSample === first &&
        driver.complete &&
        range !== null &&
        range.first === first &&
        range.end === first + total &&
        range.samples === total &&
        range.contiguous &&
        equalBytes(
          sink.bytesInRange(first, total, bps),
          expectedSampleRange(seed, channels, first, total),
        ),
      `samples=${String(plan.preTrigger.samples)}, T=${String(driver.triggeredAt)}, ` +
        `first=${String(driver.firstSample)}, range=${range === null ? 'none' :
          `${range.first}..${range.end} (${range.samples})`}, ` +
        `state=${driver.state}`,
    );
  }

  {
    // No plan at all: free-run has no trigger coordinate and starts at sample 0.
    const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed });
    const sink = new RecordingSink();
    await driver.start(startConfig(channels, samplerate), sink);
    const before = { T: driver.triggeredAt, first: driver.firstSample };
    await driver.step(16);
    check(
      'free-run has no trigger and starts its stream at sample 0',
      before.T === null && before.first === null &&
        driver.triggeredAt === null && driver.firstSample === 0 &&
        driver.state === 'running' &&
        equalBytes(sink.bytes(), expectedBytes(seed, channels, 16)),
      `before=${String(before.T)}/${String(before.first)}, ` +
        `after=${String(driver.triggeredAt)}/${String(driver.firstSample)}`,
    );
  }

  {
    // Trigger enabled, no match within the stepped window: waiting emits nothing.
    const plan = compiledDigitalPlan(
      [{ signal: 'd0', kind: 'level', level: 1 }], channels, samplerate, 0, 4,
    );
    const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed });
    const sink = new RecordingSink();
    await driver.start(startConfig(channels, samplerate), sink, { trigger: plan });
    const advanced = await driver.step(1);
    check(
      'a trigger with no match yet stays waiting and emits nothing',
      advanced === 1 && driver.state === 'waiting' &&
        driver.triggeredAt === null && driver.firstSample === null &&
        sink.writes.length === 0 && sink.gaps.length === 0,
      `advanced=${advanced}, state=${driver.state}, T=${String(driver.triggeredAt)}, ` +
        `first=${String(driver.firstSample)}, writes=${sink.writes.length}`,
    );
  }
}

// ---------------------------------------------------------------- pre-trigger precision

{
  // 21.9% of 100 leaves 21 pre samples at 5 MHz. The compiler's exact `samples` is 21,
  // but the float seconds round-trip floors to 20: the driver must not use it.
  const plan = compiledDigitalPlan([{ signal: 'd0', kind: 'rising' }], 8, 5e6, 21.9, 100);
  const preSamples = plan.preTrigger.samples;
  const { driver, sink, steps } = await runBoundedTrigger(plan, 8);
  const range = deliveredRange(sink, 1);
  check(
    'a fractional pre-trigger percent uses the exact integer sample count',
    preSamples === 21 &&
      Math.floor(plan.preTrigger.seconds * 5e6) === 20 &&
      // Rising edges are at 2, 6, ..., 22; the holdoff needs 21 samples first.
      driver.triggeredAt === 22 &&
      range !== null &&
      range.first === 1 &&
      range.samples === 21 + 100 &&
      driver.complete &&
      steps > 0,
    `samples=${String(preSamples)}, floor(seconds*rate)=` +
      `${Math.floor(plan.preTrigger.seconds * 5e6)}, delivered=${range?.samples}, ` +
      `steps=${steps}`,
  );
}

// ---------------------------------------------------------------- disconnect

{
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 0x55,
    transferBytes: 1 << 16,
    faults: [{ kind: 'disconnect', atSample: 4 }],
  });
  const sink = new RecordingSink();
  await driver.start(startConfig(16), sink);
  await expectReject('disconnect rejects the step with a typed error', () => driver.step(16), 'disconnect');
  check(
    'disconnect stops the stream after the samples before the fault',
    driver.state === 'disconnected' && sink.bytes().length === 8,
    `state=${driver.state}, bytes=${sink.bytes().length}`,
  );
  await expectReject('step after disconnect is refused', () => driver.step(1), 'not-started');

  await driver.start(startConfig(16), new RecordingSink(), { faults: [] });
  check(
    'start is accepted again after a disconnect',
    driver.state === 'running',
    `state=${driver.state}`,
  );
}

// ---------------------------------------------------------------- malformed header

{
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    faults: [{ kind: 'malformed-header' }],
  });
  await expectReject(
    'malformed header rejects start with a typed error',
    () => driver.start(startConfig(8), new RecordingSink()),
    'malformed-header',
  );
  check('a failed handshake leaves the driver idle', driver.state === 'idle', `state=${driver.state}`);

  await driver.start(startConfig(8), new RecordingSink(), { faults: [] });
  check(
    'the next start clears the handshake fault',
    driver.state === 'running',
    `state=${driver.state}`,
  );
}

// ---------------------------------------------------------------- slow handshake

{
  const driver = new SimDriver(SLOGIC32U3_PROFILE, { seed: 0x1234 });
  const sink = new RecordingSink();
  const pending = driver.start(startConfig(8), sink, {
    faults: [{ kind: 'slow-handshake' }],
  });
  await Promise.resolve();
  check(
    'slow handshake stays pending without a step or a timer',
    driver.state === 'handshaking' && sink.bytes().length === 0,
    `state=${driver.state}`,
  );

  const handshakeStep = await driver.step(0);
  const running = driver.state;
  await pending;
  check(
    'step completes the handshake deterministically',
    handshakeStep === 0 && running === 'running',
    `advanced=${handshakeStep}, state=${running}`,
  );

  const advanced = await driver.step(8);
  check(
    'streaming works after the slow handshake completes',
    advanced === 8 && sink.bytes().length === 8,
    `advanced=${advanced}, bytes=${sink.bytes().length}`,
  );

  const stopped = new SimDriver(SLOGIC32U3_PROFILE);
  const stoppedStart = stopped.start(startConfig(8), new RecordingSink(), {
    faults: [{ kind: 'slow-handshake' }],
  });
  await stopped.stop();
  await stoppedStart;
  check(
    'stop completes a pending handshake and reaches stopped',
    stopped.state === 'stopped',
    `state=${stopped.state}`,
  );
}

// ---------------------------------------------------------------- capabilities

await expectReject(
  '16U3 refuses 32 channels',
  () => new SimDriver(SLOGIC16U3_PROFILE).start(startConfig(32), new RecordingSink()),
  'unsupported-channel-count',
);
await expectReject(
  'no profile accepts 64 channels',
  () => new SimDriver(SLOGIC32U3_PROFILE).start(
    startConfig(64 as ChannelCount), new RecordingSink(),
  ),
  'unsupported-channel-count',
);
await expectReject(
  'a discrete rate not in the table is refused',
  () => new SimDriver(SLOGIC32U3_PROFILE).start(
    startConfig(8, 3e6), new RecordingSink(),
  ),
  'unsupported-rate',
);
await expectReject(
  'a rate above the width ceiling is refused',
  () => new SimDriver(SLOGIC32U3_PROFILE).start(
    startConfig(8, 1.4e9), new RecordingSink(),
  ),
  'unsupported-rate',
);
await expectReject(
  'a Full Speed link offers no rate and is refused',
  () => new SimDriver(SLOGIC16U3_PROFILE).start(
    startConfig(8), new RecordingSink(), { linkRate: 'fs' },
  ),
  'unsupported-rate',
);
{
  const limited = JSON.parse(JSON.stringify(SLOGIC32U3_PROFILE)) as DeviceProfile;
  limited.digital.testModes = [0] as const;
  await expectReject(
    'test modes outside the profile are refused',
    () => new SimDriver(limited).start(
      startConfig(8, 5e6, 2), new RecordingSink(),
    ),
    'unsupported-test-mode',
  );
}

// ---------------------------------------------------------------- analog qualification

/** Bit-reverse of one byte, written independently of the driver's table. */
function reverseByte(value: number): number {
  let r = 0;
  for (let bit = 0; bit < 8; bit++) r |= ((value >>> bit) & 1) << (7 - bit);
  return r;
}

/** Small deterministic integer hash. */
function hash32(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

// Slow enough that genuine code transitions (one per ~64 samples at the steepest point,
// plus the dither) are further apart than the longest 14-sample artifact, as on the
// module at 100 MS/s: the artifacts are isolated, never chained.
const SINE_PERIOD = 40000;
const SINE_AMPLITUDE = 100;

/** The noiseless sine in fractional codes, and its slope sign. */
function sineClean(n: number): number {
  return 128 + SINE_AMPLITUDE * Math.sin(2 * Math.PI * n / SINE_PERIOD);
}
function sineRising(n: number): boolean {
  return Math.cos(2 * Math.PI * n / SINE_PERIOD) > 0;
}

/** The genuine converter code: the sine plus a +-1 code dither held for 32 samples. */
function sineCode(n: number): number {
  const dither = (hash32(Math.floor(n / 32)) % 3) - 1;
  return Math.max(0, Math.min(255, Math.round(sineClean(n)) + dither));
}

/**
 * What the host reads: at each genuine code transition the bus shows the OR of the old
 * and new codes for 1..14 samples (hash-chosen), the module's carry-boundary artifact.
 * A pure function of the position, as the SimDriver requires.
 */
function glitchedSineCode(n: number): number {
  for (let j = 0; j < 14; j++) {
    const m = n - j;
    if (m <= 0) break;
    const before = sineCode(m - 1);
    const after = sineCode(m);
    if (before !== after) return j < 1 + (hash32(m * 7 + 3) % 14) ? before | after : after;
  }
  return sineCode(n);
}

/** Device sample bytes at 8 channels with the ADC on bank 0: the reversed code. */
function analogBytes(code: (n: number) => number, from: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = reverseByte(code(from + i));
  return out;
}

function compiledAnalogPlan(
  kind: 'rising' | 'falling',
  code: number,
  samplerate: number,
  preTriggerPercent: number,
  postSamples: number,
): TriggerPlan {
  const result = compileTriggerPlan({
    profile: SLOGIC32U3_PROFILE,
    enableMask: true,
    source: 'analog',
    digital: [],
    analog: [{ signal: 'a0', kind, volts: analogVoltsFromCode(code) }],
    preTriggerPercent,
    postTrigger: { kind: 'samples', value: postSamples },
    capture: { samplerate, channels: 8 },
    compiledAt: 0,
  });
  if (!result.ok) throw new Error(`compiledAnalogPlan failed: ${result.reason}: ${result.detail}`);
  return result.plan;
}

/** Run an analog plan in small, uneven steps through a small transfer size. */
async function runAnalog(
  plan: TriggerPlan,
  code: (n: number) => number,
  options: SimDriverOptions = {},
  samplerate = 100e6,
): Promise<{ driver: SimDriver; sink: RecordingSink }> {
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 0x1234, transferBytes: 16, analog: { start: 0, code }, ...options,
  });
  const sink = new RecordingSink();
  await driver.start(startConfig(8, samplerate), sink, { trigger: plan });
  let steps = 0;
  while (!driver.complete && driver.state !== 'stopped' && steps < 20000) {
    await driver.step(7 + (steps % 5));
    steps += 1;
  }
  return { driver, sink };
}

{
  // The module's wiring: input 0 of the bank is the code's MSB, so the wire byte is the
  // bit-reversed code; the other banks keep the digital generator's bytes.
  const codes = [0x01, 0x80, 0x0f, 0x6f, 0x70, 0xa5];
  const driver = new SimDriver(SLOGIC32U3_PROFILE, {
    seed: 0x1234, analog: { start: 24, code: (n) => codes[n % codes.length]! },
  });
  const sink = new RecordingSink();
  await driver.start(startConfig(32), sink);
  await driver.step(12);
  const bytes = sink.bytes();
  const digital = expectedBytes(0x1234, 32, 12);
  let ok = bytes.length === 48 && bytes[3] === 0x80 && bytes[7] === 0x01;
  for (let i = 0; i < 12 && ok; i++) {
    ok = bytes[i * 4 + 3] === reverseByte(codes[i % codes.length]!) &&
      bytes[i * 4] === digital[i * 4] && bytes[i * 4 + 1] === digital[i * 4 + 1] &&
      bytes[i * 4 + 2] === digital[i * 4 + 2];
  }
  check(
    'an analog code is written bit-reversed on its bank (code 0x01 reads byte 0x80)',
    ok,
    toHex(bytes.subarray(0, 16)),
  );
}

await expectReject(
  'an analog source outside the capture width is refused',
  () => new SimDriver(SLOGIC32U3_PROFILE, { analog: { start: 24, code: () => 0 } })
    .start(startConfig(16), new RecordingSink()),
  'invalid-config',
);
await expectReject(
  'an out-of-range persistence window is refused',
  () => new SimDriver(SLOGIC32U3_PROFILE, {
    analog: { start: 0, code: () => 0 }, analogPersistSamples: 0,
  }).start(startConfig(8), new RecordingSink()),
  'invalid-config',
);

{
  // Raw crossings (h = 1, P = 1) fire on the wrong slope on this signal: proof that the
  // synthetic artifact is the one the qualification exists for.
  let wrong = 0;
  const raw: string[] = [];
  for (const kind of ['rising', 'falling'] as const) {
    for (const level of [60, 96, 112, 128, 144, 160, 200]) {
      const plan = compiledAnalogPlan(kind, level, 100e6, 0, 64);
      const { driver } = await runAnalog(plan, glitchedSineCode, {
        analogHysteresis: 1, analogPersistSamples: 1,
      });
      const t = driver.triggeredAt;
      if (t !== null && sineRising(t) !== (kind === 'rising')) {
        wrong += 1;
        raw.push(`${kind} ${level} T=${t}`);
      }
    }
  }
  check('a raw crossing test fires on the wrong slope of the glitched sine', wrong > 0,
    raw.join(', '));
}

{
  // Qualified (defaults: h = 4, P = 24 at 100 MS/s): every level, both slopes, reports
  // T on the correct slope at the candidate sample, with the exact pre-trigger prefix.
  const failures: string[] = [];
  const P = 24;
  for (const kind of ['rising', 'falling'] as const) {
    for (const level of [40, 60, 96, 112, 127, 128, 144, 160, 200, 215]) {
      for (const pre of [0, 3, 50]) {
        const post = 100;
        const plan = compiledAnalogPlan(kind, level, 100e6, pre / post * 100, post);
        const preSamples = plan.preTrigger.samples!;
        const { driver, sink } = await runAnalog(plan, glitchedSineCode);
        const t = driver.triggeredAt;
        const tag = `${kind} L=${level} pre=${preSamples}`;
        if (t === null || !driver.complete) {
          failures.push(`${tag}: no match`);
          continue;
        }
        const past = (c: number): boolean => kind === 'rising' ? c >= level : c <= level;
        // T is the candidate: past the level for P samples, and the sample before it is
        // not past (else the candidate would have started earlier).
        let persists = true;
        for (let i = 0; i < P; i++) persists &&= past(glitchedSineCode(t + i));
        const fresh = !past(glitchedSineCode(t - 1));
        // Correct slope, close to the noiseless crossing.
        const slope = sineRising(t) === (kind === 'rising');
        const near = Math.abs(sineClean(t) - level) <= 4;
        const range = deliveredRange(sink, 1);
        const exact = range !== null && range.contiguous &&
          range.first === t - preSamples && range.end === t + post &&
          driver.firstSample === t - preSamples &&
          equalBytes(sink.bytes(), analogBytes(glitchedSineCode, t - preSamples, preSamples + post));
        if (!persists || !fresh || !slope || !near || !exact) {
          failures.push(`${tag}: T=${t} persists=${persists} fresh=${fresh} slope=${slope} ` +
            `near=${near} clean=${sineClean(t).toFixed(2)} range=${JSON.stringify(range)}`);
        }
      }
    }
  }
  check(
    'qualified crossings report T on the correct slope at the candidate, prefix exact',
    failures.length === 0,
    failures.slice(0, 6).join('\n        ') || '60 runs',
  );
}

/** A piecewise-constant code: `steps` is [startSample, code] sorted by start. */
function stepsCode(steps: ReadonlyArray<readonly [number, number]>): (n: number) => number {
  return (n) => {
    let code = steps[0]![1];
    for (const [start, value] of steps) if (n >= start) code = value;
    return code;
  };
}

{
  // A budget shorter than the persistence window: confirmation lands P - 1 samples after
  // T, but delivery is still exactly [T - pre, T + post).
  const code = stepsCode([[0, 50], [100, 200]]);
  const plan = compiledAnalogPlan('rising', 128, 100e6, 200, 4);
  const pre = plan.preTrigger.samples!;
  const { driver, sink } = await runAnalog(plan, code);
  const range = deliveredRange(sink, 1);
  check(
    'a post budget below P still delivers exactly [T - pre, T + post)',
    driver.triggeredAt === 100 && driver.complete && range !== null && range.contiguous &&
      range.first === 100 - pre && range.end === 104 &&
      equalBytes(sink.bytes(), analogBytes(code, 100 - pre, pre + 4)),
    `T=${String(driver.triggeredAt)} pre=${pre} range=${JSON.stringify(range)}`,
  );
}

{
  // A candidate that falls back across the level is dropped but keeps the arm: the
  // codes after it (126, inside the hysteresis band) could never re-arm on their own.
  const code = stepsCode([[0, 50], [100, 200], [110, 126], [150, 200]]);
  const { driver } = await runAnalog(compiledAnalogPlan('rising', 128, 100e6, 0, 30), code);
  check(
    'a dropped candidate keeps the arm and the next persistent run is T',
    driver.triggeredAt === 150,
    `T=${String(driver.triggeredAt)}`,
  );
  // Arming needs P consecutive codes past the threshold: 23 low samples do not arm.
  const shortArm = stepsCode([[0, 200], [100, 50], [123, 200], [400, 50], [500, 200]]);
  const { driver: second } = await runAnalog(
    compiledAnalogPlan('rising', 128, 100e6, 0, 30), shortArm,
  );
  check(
    'an arm needs P consecutive samples past the threshold',
    second.triggeredAt === 500,
    `T=${String(second.triggeredAt)}`,
  );
}

{
  // Search limit accounting includes the persistence samples. T = 100 is confirmed at
  // sample 123, the 124th inspected sample.
  const code = stepsCode([[0, 50], [100, 200]]);
  const plan = compiledAnalogPlan('rising', 128, 100e6, 0, 30);
  const enough = await runAnalog(plan, code, { searchLimitSamples: 124 });
  const short = await runAnalog(plan, code, { searchLimitSamples: 123 });
  check(
    'a search limit that covers the confirmation matches',
    enough.driver.triggeredAt === 100 && enough.driver.complete &&
      !enough.driver.searchExhausted,
    `T=${String(enough.driver.triggeredAt)} exhausted=${enough.driver.searchExhausted}`,
  );
  check(
    'a search limit that ends inside the persistence window finds nothing',
    short.driver.triggeredAt === null && short.driver.searchExhausted &&
      short.driver.state === 'stopped' && short.sink.writes.length === 0 &&
      short.driver.position === 123,
    `T=${String(short.driver.triggeredAt)} exhausted=${short.driver.searchExhausted} ` +
      `state=${short.driver.state} writes=${short.sink.writes.length} pos=${short.driver.position}`,
  );
  // A digital plan obeys the same limit.
  const digitalPlan = compiledDigitalPlan([{ signal: 'd7', kind: 'rising' }], 8, 5e6, 0, 8);
  const digital = await runBoundedTrigger(digitalPlan, 8, { searchLimitSamples: 1 });
  check(
    'a digital search exhausts at its limit too',
    digital.driver.searchExhausted && digital.driver.triggeredAt === null,
    `exhausted=${digital.driver.searchExhausted} T=${String(digital.driver.triggeredAt)}`,
  );
}

{
  // A dropout in the middle of a candidate clears the candidate and the arm: the high
  // codes after the gap cannot confirm, and the next armed crossing is T.
  const code = stepsCode([[0, 50], [100, 200], [300, 50], [400, 200]]);
  const plan = compiledAnalogPlan('rising', 128, 100e6, 100, 8);
  const pre = plan.preTrigger.samples!;
  const { driver, sink } = await runAnalog(plan, code, {
    faults: [{ kind: 'dropout', atSample: 110, count: 32 }],
  });
  const range = deliveredRange(sink, 1);
  check(
    'a gap mid-candidate resets the qualification',
    driver.triggeredAt === 400 && range !== null && range.first === 400 - pre &&
      range.end === 408 && sink.gaps.length === 0,
    `T=${String(driver.triggeredAt)} range=${JSON.stringify(range)} gaps=${sink.gaps.length}`,
  );
  const clean = await runAnalog(plan, code);
  check('without the gap the first crossing is T', clean.driver.triggeredAt === 100,
    `T=${String(clean.driver.triggeredAt)}`);
}

{
  // A confirmation whose candidate lies inside the pre-fill holdoff is consumed
  // unmatched; the analog plan also needs a source on its bank.
  const code = stepsCode([[0, 50], [30, 200], [100, 50], [200, 200]]);
  const plan = compiledAnalogPlan('rising', 128, 100e6, 50, 120);
  const { driver } = await runAnalog(plan, code, { analogPersistSamples: 8 });
  check(
    'a candidate inside the holdoff is consumed; the next qualified crossing is T',
    plan.preTrigger.samples === 60 && driver.triggeredAt === 200,
    `pre=${String(plan.preTrigger.samples)} T=${String(driver.triggeredAt)}`,
  );
  await expectReject(
    'an analog plan without an analog source is refused',
    () => new SimDriver(SLOGIC32U3_PROFILE).start(
      startConfig(8, 100e6), new RecordingSink(), { trigger: plan },
    ),
    'trigger-unsupported',
  );
}

// ---------------------------------------------------------------- report

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
