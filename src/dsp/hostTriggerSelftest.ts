// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic self-test for the TriggerPlan host executor adapter.
 *
 * Run with:
 *   node_modules/.bin/esbuild src/dsp/hostTriggerSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/hosttrigger-selftest.mjs --log-level=error \
 *     && node /tmp/hosttrigger-selftest.mjs
 *
 * Plans are produced by the real `compileTriggerPlan`, so the adapter is exercised
 * against the compiler's actual output (pre-trigger samples, budgets, conditions). No
 * device, DOM, timer or test framework is involved.
 */

import { MAX_SOFTWARE_TRIGGER_PREFIX_BYTES } from '../data/softwareTrigger.js';
import type { ChannelCount } from '../types.js';
import type { DeviceProfile, TriggerKind } from '../device/profileTypes.js';
import {
  compileTriggerPlan,
  type DigitalTriggerInput,
  type TriggerPlan,
  type TriggerPlanInput,
} from './triggerPlan.js';
import {
  HostTrigger,
  HostTriggerError,
  type HostTriggerErrorCode,
  type HostTriggerMatch,
  type HostTriggerOptions,
} from './hostTrigger.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sameNumbers(actual: readonly number[], expected: readonly number[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) return false;
  }
  return true;
}

const ALL_DIGITAL: readonly TriggerKind[] = [
  'level', 'rising', 'falling', 'edge', 'high', 'low',
];

function makeProfile(
  id: string,
  execution: 'device' | 'host' = 'host',
  mixed = false,
): DeviceProfile {
  return {
    id,
    name: `Test ${id}`,
    vid: 0x1d50,
    pid: 0x6018,
    link: {
      interfaceClass: 0xff,
      endpoints: { in: 1, out: 2 },
      maxTransferBytes: 262_144,
      rates: ['ss5'],
      probe: { bytes: 64, bursts: 1 },
    },
    digital: {
      maxChannels: 32,
      groups: [{ start: 0, channels: 32 }],
      widths: [4, 8, 16, 32],
      rates: [],
      thresholdVolts: [1.2, 3.3],
      testModes: [0],
    },
    analog: {
      groups: [{
        start: 0,
        channels: 8,
        ranges: [1, 5, 15],
        resolutionBits: 8,
        maxHz: {},
      }],
      calibration: { id: 'test-cal', version: 1 },
    },
    trigger: {
      execution,
      digital: ALL_DIGITAL,
      analog: ['rising', 'falling'],
      mixed,
      preTriggerMaxPercent: 75,
      preTriggerMaxBytes: MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
    },
    modes: { single: true, repeat: true, loop: true, record: true },
    firmware: { min: '0.0.0' },
  };
}

const HOST_PROFILE = makeProfile('host');
const DEVICE_PROFILE = makeProfile('device', 'device');
const MIXED_PROFILE = makeProfile('mixed', 'host', true);

function compile(
  profile: DeviceProfile,
  overrides: Partial<TriggerPlanInput> = {},
): TriggerPlan {
  const result = compileTriggerPlan({
    profile,
    enableMask: true,
    source: 'digital',
    digital: [],
    analog: [],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
    compiledAt: 7,
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`test plan did not compile: ${result.reason}: ${result.detail}`);
  }
  return result.plan;
}

function packSamples(channels: number, values: readonly number[]): Uint8Array {
  const bps = Math.ceil(channels / 8);
  const out = new Uint8Array(values.length * bps);
  for (let i = 0; i < values.length; i++) {
    let word = values[i]!;
    for (let byte = 0; byte < bps; byte++) {
      out[i * bps + byte] = word & 0xff;
      word = Math.floor(word / 256);
    }
  }
  return out;
}

function decodeSamples(bytes: Uint8Array, bps: number): number[] {
  const out: number[] = [];
  for (let offset = 0; offset + bps <= bytes.length; offset += bps) {
    let word = 0;
    for (let byte = 0; byte < bps; byte++) {
      word += bytes[offset + byte]! * 2 ** (byte * 8);
    }
    out.push(word);
  }
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

class Recorder {
  readonly chunks: Uint8Array[] = [];
  readonly matches: HostTriggerMatch[] = [];

  readonly emit = (chunk: Uint8Array): void => {
    this.chunks.push(chunk.slice());
  };

  readonly onMatch = (match: HostTriggerMatch): void => {
    this.matches.push({ index: match.index, count: match.count });
  };

  samples(bps: number): number[] {
    return decodeSamples(concat(this.chunks), bps);
  }

  emittedBytes(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    return total;
  }
}

/** Feed `bytes` in fragments of at most `chunkBytes`, including mid-sample splits. */
function feedAll(trigger: HostTrigger, bytes: Uint8Array, chunkBytes = bytes.length): void {
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    trigger.feed(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
  }
}

function expectHostError(
  name: string,
  run: () => unknown,
  code: HostTriggerErrorCode,
): void {
  try {
    run();
    check(name, false, 'accepted instead of refusing');
  } catch (error) {
    check(
      name,
      error instanceof HostTriggerError && error.code === code,
      error instanceof HostTriggerError ? `${error.code}: ${error.message}` : String(error),
    );
  }
}

// ---------------------------------------------------------------------------------
// Complete samples across arbitrary byte-chunk boundaries
// ---------------------------------------------------------------------------------

{
  // 16 channels = 2 bytes/sample, so a 3-byte fragment always splits a sample.
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 8 },
    capture: { samplerate: 1000, channels: 16 },
  });
  check(
    'compiler output gives the adapter an exact sample-aligned prefix',
    plan.preTrigger.samples === 2 && plan.budget.kind === 'samples' &&
      plan.budget.value === 8,
    show(plan.preTrigger),
  );

  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 16,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  check(
    'adapter geometry is pre + post samples in the matcher budget',
    trigger.bytesPerSample === 2 && trigger.preTriggerSamples === 2 &&
      trigger.postTriggerSamples === 8 && trigger.maxSamples === 10 &&
      trigger.mode === 'one-shot',
    `bps=${trigger.bytesPerSample} pre=${trigger.preTriggerSamples} ` +
      `post=${trigger.postTriggerSamples} max=${trigger.maxSamples} mode=${trigger.mode}`,
  );

  const values = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const bytes = packSamples(16, values);

  // Samples 0..3 (8 bytes) contain no match. Feed them in 3-byte fragments so calls
  // end mid-sample; nothing may be emitted and the partial tail must be carried.
  feedAll(trigger, bytes.subarray(0, 8), 3);
  check(
    'waiting emits nothing and inspects one complete sample per sample',
    recorder.chunks.length === 0 && trigger.stats.inspectedSamples === 4 &&
      !trigger.stats.matched && trigger.waiting,
    `chunks=${recorder.chunks.length} inspected=${trigger.stats.inspectedSamples}`,
  );

  feedAll(trigger, bytes.subarray(8), 3);
  const expected = values.slice(2, 12);
  check(
    'a sample split across chunks matches once at the first complete match',
    trigger.stats.matched && trigger.triggerSampleIndex === 2 &&
      trigger.stats.matchCount === 1,
    `matched=${trigger.stats.matched} T=${String(trigger.triggerSampleIndex)} ` +
      `count=${trigger.stats.matchCount}`,
  );
  check(
    'emitted stream is bounded prefix + trigger + post, all whole samples',
    sameNumbers(recorder.samples(2), expected) && recorder.chunks.every((c) => c.length % 2 === 0),
    `emitted=${show(recorder.samples(2))} expected=${show(expected)}`,
  );
  check(
    'one-shot reports one emitted-coordinate match and completes the budget',
    recorder.matches.length === 1 && recorder.matches[0]!.index === 2 &&
      recorder.matches[0]!.count === 1 && trigger.complete &&
      trigger.stats.emittedSamples === 10,
    `matches=${show(recorder.matches)} complete=${trigger.complete} ` +
      `emitted=${trigger.stats.emittedSamples}`,
  );
}

// ---------------------------------------------------------------------------------
// All six digital modes, including the high/low -> level mapping
// ---------------------------------------------------------------------------------

const MODE_CASES: ReadonlyArray<{
  name: string;
  condition: DigitalTriggerInput;
  values: readonly number[];
  deviceT: number;
}> = [
  {
    name: 'level defaults to polarity 1',
    condition: { signal: 'd0', kind: 'level' },
    values: [1, 1, 0, 0, 0, 0, 0, 0],
    deviceT: 1,
  },
  {
    name: 'level 0',
    condition: { signal: 'd0', kind: 'level', level: 0 },
    values: [0, 0, 1, 1, 1, 1, 1, 1],
    deviceT: 1,
  },
  {
    name: 'high maps to level 1',
    condition: { signal: 'd0', kind: 'high' },
    values: [1, 1, 0, 0, 0, 0, 0, 0],
    deviceT: 1,
  },
  {
    name: 'low maps to level 0',
    condition: { signal: 'd0', kind: 'low' },
    values: [0, 0, 1, 1, 1, 1, 1, 1],
    deviceT: 1,
  },
  {
    name: 'rising',
    condition: { signal: 'd0', kind: 'rising' },
    values: [0, 0, 1, 1, 1, 1, 1, 1],
    deviceT: 2,
  },
  {
    name: 'falling',
    condition: { signal: 'd0', kind: 'falling' },
    values: [1, 1, 0, 0, 0, 0, 0, 0],
    deviceT: 2,
  },
  {
    name: 'edge',
    condition: { signal: 'd0', kind: 'edge' },
    values: [0, 0, 1, 1, 1, 1, 1, 1],
    deviceT: 2,
  },
];

for (const modeCase of MODE_CASES) {
  const plan = compile(HOST_PROFILE, {
    digital: [modeCase.condition],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  feedAll(trigger, packSamples(8, modeCase.values), 2);

  // preTrigger is 1 sample, so the emitted stream starts one sample before T. The level
  // cases are true from sample 0, but the pre-fill holdoff makes sample 1 (the first with
  // a full one-sample prefix) the trigger.
  const start = Math.max(0, modeCase.deviceT - 1);
  const expected = modeCase.values.slice(start, start + 5);
  const expectedT = Math.min(modeCase.deviceT, 1);
  check(
    `digital mode ${modeCase.name}: plan condition and match are exact`,
    plan.conditions.length === 1 && plan.conditions[0]!.kind === 'digital' &&
      plan.conditions[0]!.mode === modeCase.condition.kind &&
      trigger.stats.matched && trigger.triggerSampleIndex === expectedT &&
      recorder.matches.length === 1 && recorder.matches[0]!.index === expectedT,
    `T=${String(trigger.triggerSampleIndex)} expected=${expectedT} ` +
      `matches=${show(recorder.matches)}`,
  );
  check(
    `digital mode ${modeCase.name}: emitted prefix + trigger + post is correct`,
    sameNumbers(recorder.samples(1), expected),
    `emitted=${show(recorder.samples(1))} expected=${show(expected)}`,
  );
}

// ---------------------------------------------------------------------------------
// No trigger / search budget, and emitted-stream T coordinates
// ---------------------------------------------------------------------------------

{
  // preTriggerPercent 0 gives pre = 0, maxSamples = 4. An explicit search budget of 4
  // ends a never-matching capture as noTrigger; the default is Infinity so a Single
  // capture keeps waiting.
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 0,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
    searchLimitSamples: 4,
  });
  feedAll(trigger, packSamples(8, new Array<number>(10).fill(0)), 1);
  check(
    'an explicit search budget ends a never-matching capture as noTrigger',
    trigger.noTrigger && !trigger.stats.matched && trigger.complete === false &&
      recorder.emittedBytes() === 0 && trigger.stats.inspectedSamples === 4,
    `noTrigger=${trigger.noTrigger} inspected=${trigger.stats.inspectedSamples} ` +
      `bytes=${recorder.emittedBytes()}`,
  );
}

{
  // Repeat's miss budget is one sweep (pre + post); pass maxSamples explicitly.
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
    searchLimitSamples: 5,
  });
  feedAll(trigger, packSamples(8, new Array<number>(8).fill(0)), 1);
  check(
    'a Repeat-style search limit includes the prefix, not an extra pre window',
    trigger.noTrigger && trigger.stats.inspectedSamples === 5 &&
      recorder.emittedBytes() === 0,
    `noTrigger=${trigger.noTrigger} inspected=${trigger.stats.inspectedSamples} ` +
      `bytes=${recorder.emittedBytes()}`,
  );
}

{
  // A finite plan with no explicit search limit keeps waiting, matching the Single mode
  // policy; finish() then discards the bounded prefix and reports noTrigger.
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  feedAll(trigger, packSamples(8, new Array<number>(40).fill(0)), 1);
  const stillWaiting = trigger.waiting && !trigger.noTrigger && recorder.emittedBytes() === 0;
  trigger.finish();
  trigger.finish();
  check(
    'a finite plan defaults to an unbounded search; finish() is idempotent and discards the prefix',
    stillWaiting && trigger.noTrigger && !trigger.waiting &&
      recorder.emittedBytes() === 0 && recorder.matches.length === 0,
    `waiting=${trigger.waiting} noTrigger=${trigger.noTrigger} ` +
      `bytes=${recorder.emittedBytes()} matches=${show(recorder.matches)}`,
  );
}

{
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 0,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
    searchLimitSamples: 5,
  });
  const values = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  feedAll(trigger, packSamples(8, values));
  check(
    'a match past the search budget is never inspected or reported',
    trigger.noTrigger && recorder.matches.length === 0 &&
      recorder.emittedBytes() === 0 && trigger.stats.inspectedSamples === 5,
    `noTrigger=${trigger.noTrigger} matches=${show(recorder.matches)} ` +
      `inspected=${trigger.stats.inspectedSamples}`,
  );
}

{
  // With pre = 0 the emitted stream starts at T, so T is index 0 even though the match
  // is the sixth sample fed to the executor.
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 0,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
    searchLimitSamples: 6,
  });
  const values = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  feedAll(trigger, packSamples(8, values), 3);
  check(
    'T is reported in emitted-stream coordinates (pre = 0 puts T at 0)',
    trigger.stats.matched && trigger.triggerSampleIndex === 0 &&
      recorder.matches.length === 1 && recorder.matches[0]!.index === 0 &&
      sameNumbers(recorder.samples(1), values.slice(5, 9)) && trigger.complete,
    `T=${String(trigger.triggerSampleIndex)} emitted=${show(recorder.samples(1))}`,
  );
}

// ---------------------------------------------------------------------------------
// Pre-fill holdoff keeps the full prefix and the total pre + post budget
// ---------------------------------------------------------------------------------

{
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 16 },
    capture: { samplerate: 1000, channels: 8 },
  });
  check(
    'early-match plan resolves to pre 4 + post 16 = 20 total samples',
    plan.preTrigger.samples === 4 && plan.budget.kind === 'samples' &&
      plan.budget.value === 16,
    show(plan.preTrigger),
  );

  // Pre-fill holdoff: the pulse at sample 1 lies inside the unfilled 4-sample window and
  // is ignored; the next one (sample 6) triggers with the full prefix.
  const earlyValues = [0, 1, 0, 0, 0, 0, 1, ...new Array<number>(33).fill(0)];
  const early = new Recorder();
  const earlyTrigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: early.emit,
    onMatch: early.onMatch,
  });
  feedAll(earlyTrigger, packSamples(8, earlyValues), 7);
  check(
    'a match before the pre-trigger window fills is held off; the next carries the full prefix',
    earlyTrigger.stats.emittedSamples === 20 && earlyTrigger.complete &&
      earlyTrigger.triggerSampleIndex === 4 && early.matches.length === 1 &&
      sameNumbers(early.samples(1), earlyValues.slice(2, 22)),
    `emitted=${earlyTrigger.stats.emittedSamples} T=${String(earlyTrigger.triggerSampleIndex)} ` +
      `stream=${show(early.samples(1))}`,
  );

  const lateValues = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, ...new Array<number>(29).fill(0)];
  const late = new Recorder();
  const lateTrigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: late.emit,
    onMatch: late.onMatch,
  });
  feedAll(lateTrigger, packSamples(8, lateValues), 7);
  check(
    'a late match emits the same total budget and starts at T - pre',
    lateTrigger.stats.emittedSamples === 20 && lateTrigger.complete &&
      lateTrigger.triggerSampleIndex === 4 &&
      sameNumbers(late.samples(1), lateValues.slice(6, 26)),
    `emitted=${lateTrigger.stats.emittedSamples} T=${String(lateTrigger.triggerSampleIndex)} ` +
      `stream=${show(late.samples(1))}`,
  );
}

// ---------------------------------------------------------------------------------
// Bounded prefix: a long wait retains only the configured window
// ---------------------------------------------------------------------------------

{
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 16 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
    searchLimitSamples: Number.POSITIVE_INFINITY,
  });

  const matchedAt = 9999;
  const total = 10_020;
  const values: number[] = [];
  for (let i = 0; i < total; i++) {
    // Bit 0 is the trigger input and stays low until the match; the higher bits carry a
    // position-dependent pattern so a retained prefix can be identified exactly.
    values.push(i === matchedAt ? ((i & 0x7f) << 1) | 1 : (i & 0x7f) << 1);
  }

  feedAll(trigger, packSamples(8, values.slice(0, matchedAt)), 97);
  check(
    'waiting for 9999 samples emits nothing and is still bounded',
    recorder.chunks.length === 0 && !trigger.stats.matched &&
      trigger.stats.inspectedSamples === matchedAt,
    `chunks=${recorder.chunks.length} inspected=${trigger.stats.inspectedSamples}`,
  );

  feedAll(trigger, packSamples(8, values.slice(matchedAt)), 97);
  check(
    'the retained prefix is exactly preTriggerSamples, never the search prefix',
    trigger.stats.emittedSamples === 20 && trigger.complete &&
      trigger.triggerSampleIndex === 4 &&
      sameNumbers(recorder.samples(1), values.slice(matchedAt - 4, matchedAt + 16)),
    `emitted=${trigger.stats.emittedSamples} T=${String(trigger.triggerSampleIndex)} ` +
      `stream=${show(recorder.samples(1))}`,
  );
}

// ---------------------------------------------------------------------------------
// Budget forms: time, unlimited, and Loop (continuous)
// ---------------------------------------------------------------------------------

{
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'time', value: 0.016 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  check(
    'a time budget quantizes to round(seconds * samplerate) post samples',
    plan.preTrigger.samples === 4 && trigger.postTriggerSamples === 16 &&
      trigger.maxSamples === 20,
    `pre=${trigger.preTriggerSamples} post=${trigger.postTriggerSamples} ` +
      `max=${trigger.maxSamples}`,
  );
  const values = [0, 0, 0, 0, 1, ...new Array<number>(35).fill(0)];
  feedAll(trigger, packSamples(8, values), 5);
  check(
    'a time-budget capture retires pre + round(time * rate) samples',
    trigger.complete && trigger.stats.emittedSamples === 20 &&
      trigger.triggerSampleIndex === 4,
    `complete=${trigger.complete} emitted=${trigger.stats.emittedSamples} ` +
      `T=${String(trigger.triggerSampleIndex)}`,
  );
}

{
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'unlimited' },
    retentionSeconds: 0.016,
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  check(
    'an unlimited budget maps to Infinity and one-shot stays live after the match',
    plan.budget.kind === 'unlimited' && trigger.postTriggerSamples === Infinity &&
      trigger.maxSamples === Infinity && trigger.mode === 'one-shot',
    `post=${trigger.postTriggerSamples} max=${trigger.maxSamples} mode=${trigger.mode}`,
  );
  // The high sample sits after the pre-fill holdoff, so T == preTriggerSamples and the
  // emitted stream is everything from T - pre onward.
  const highAt = 10;
  const values = new Array<number>(50).fill(0);
  values[highAt] = 1;
  feedAll(trigger, packSamples(8, values), 9);
  const pre = trigger.preTriggerSamples;
  check(
    'an unlimited one-shot capture emits every post sample and never completes',
    pre < highAt && trigger.stats.matched &&
      trigger.stats.emittedSamples === 50 - highAt + pre &&
      !trigger.complete && trigger.triggerSampleIndex === pre,
    `emitted=${trigger.stats.emittedSamples} complete=${trigger.complete} ` +
      `T=${String(trigger.triggerSampleIndex)}`,
  );
}

{
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'unlimited' },
    loop: { seconds: 0.01, anchor: 'trigger' },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  check(
    'a trigger-anchored Loop maps to continuous matching with no total budget',
    plan.loop !== undefined && trigger.mode === 'continuous' &&
      trigger.maxSamples === Infinity && trigger.preTriggerSamples === 2,
    `mode=${trigger.mode} max=${trigger.maxSamples} pre=${trigger.preTriggerSamples}`,
  );
  const values = [0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  feedAll(trigger, packSamples(8, values), 5);
  check(
    'continuous mode reports every later match in emitted-stream coordinates',
    trigger.stats.matched && trigger.stats.matchCount === 2 &&
      trigger.triggerSampleIndex === 2 &&
      recorder.matches.length === 2 && recorder.matches[0]!.index === 2 &&
      recorder.matches[1]!.index === 4 &&
      sameNumbers(recorder.samples(1), values) && !trigger.complete,
    `matches=${show(recorder.matches)} emitted=${show(recorder.samples(1))}`,
  );
}

// ---------------------------------------------------------------------------------
// Pre-trigger fallbacks when the compiler could not state an exact sample count
// ---------------------------------------------------------------------------------

{
  // No capture: no exact sample count exists, so capBytes is only a bound.
  const result = compileTriggerPlan({
    profile: HOST_PROFILE,
    enableMask: true,
    source: 'digital',
    digital: [{ signal: 'd0', kind: 'high' }],
    analog: [],
    preTriggerPercent: 10,
    postTrigger: { kind: 'time', value: 1 },
    compiledAt: 7,
  });
  if (!result.ok) throw new Error(`time-only plan did not compile: ${result.detail}`);
  const plan = result.plan;
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
  });
  check(
    'without preTrigger.samples the seconds*rate bound is used, never floor',
    plan.preTrigger.samples === undefined && plan.preTrigger.capBytesIsBound === true &&
      trigger.preTriggerSamples === 100,
    `plan=${show(plan.preTrigger)} resolved=${trigger.preTriggerSamples}`,
  );
}

{
  const base = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    postTrigger: { kind: 'samples', value: 8 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const plan: TriggerPlan = {
    ...base,
    preTrigger: { percent: 10, seconds: 0.1, capBytes: 4 },
  };
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
  });
  check(
    'without preTrigger.samples the smaller capBytes and seconds bound wins',
    trigger.preTriggerSamples === 4 && trigger.maxSamples === 12,
    `pre=${trigger.preTriggerSamples} max=${trigger.maxSamples}`,
  );
}

{
  // A plan that states samples and a bound-only capBytes uses the smaller bound.
  const base = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    postTrigger: { kind: 'samples', value: 8 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const capped: TriggerPlan = {
    ...base,
    preTrigger: {
      percent: 50, seconds: 0.1, capBytes: 8, samples: 40, capBytesIsBound: true,
    },
  };
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan: capped,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
  });
  check(
    'an exact sample count is still capped by a bound-only capBytes',
    trigger.preTriggerSamples === 8 && trigger.maxSamples === 16,
    `pre=${trigger.preTriggerSamples} max=${trigger.maxSamples}`,
  );

  let mismatch: unknown = null;
  try {
    new HostTrigger({
      plan: { ...base, preTrigger: { percent: 50, seconds: 0.1, capBytes: 8, samples: 40 } },
      channels: 8,
      samplerate: 1000,
      emit: recorder.emit,
    });
  } catch (error) {
    mismatch = error;
  }
  check(
    'a hand-built samples/capBytes mismatch is a typed refusal',
    mismatch instanceof HostTriggerError && mismatch.code === 'invalid-pre-trigger',
    mismatch instanceof Error ? `${mismatch.name}: ${mismatch.message}` : String(mismatch),
  );
}

{
  // The old bound used 0.1 s at 1 kHz, where floor and round agree. This case
  // distinguishes them: 0.00055 s * 1000 = 0.55 -> round 1, floor 0.
  const result = compileTriggerPlan({
    profile: HOST_PROFILE,
    enableMask: true,
    source: 'digital',
    digital: [{ signal: 'd0', kind: 'high' }],
    analog: [],
    preTriggerPercent: 50,
    postTrigger: { kind: 'time', value: 0.0011 },
    compiledAt: 7,
  });
  if (!result.ok) throw new Error(`rounding plan did not compile: ${result.detail}`);
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan: result.plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
  });
  check(
    'the seconds fallback rounds to the nearest sample, not floor',
    result.plan.preTrigger.samples === undefined && trigger.preTriggerSamples === 1,
    `plan=${show(result.plan.preTrigger)} resolved=${trigger.preTriggerSamples}`,
  );
}

{
  // Retune while waiting: the new falling condition matches, and the retained prefix
  // survives the reconfigure rather than restarting the stream.
  const rising = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'rising' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const falling = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'falling' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan: rising,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  feedAll(trigger, packSamples(8, [0, 0]), 1);
  const accepted = trigger.reconfigure(falling);
  feedAll(trigger, packSamples(8, [1, 0, 0, 0, 0]), 1);
  check(
    'reconfigure applies a waiting plan and keeps the retained prefix',
    accepted && trigger.stats.matched && trigger.triggerSampleIndex === 1 &&
      recorder.matches.length === 1 && sameNumbers(recorder.samples(1), [1, 0, 0, 0, 0]),
    `accepted=${accepted} T=${String(trigger.triggerSampleIndex)} ` +
      `emitted=${show(recorder.samples(1))}`,
  );

  let shape: unknown = null;
  try {
    trigger.reconfigure(compile(HOST_PROFILE, {
      digital: [{ signal: 'd0', kind: 'falling' }],
      preTriggerPercent: 25,
      postTrigger: { kind: 'samples', value: 8 },
      capture: { samplerate: 1000, channels: 8 },
    }));
  } catch (error) {
    shape = error;
  }
  check(
    'a reconfigure that changes the capture shape is refused',
    shape instanceof HostTriggerError && shape.code === 'reconfigure-refused',
    shape instanceof Error ? `${shape.name}: ${shape.message}` : String(shape),
  );
}

{
  // Conditions are ANDed on one complete sample.
  const plan = compile(HOST_PROFILE, {
    digital: [
      { signal: 'd0', kind: 'rising' },
      { signal: 'd1', kind: 'high' },
    ],
    preTriggerPercent: 0,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  // d0 rises at sample 1 but d1 is low; d0 stays high while d1 rises. The first sample
  // where both conditions hold is the d0 rise at sample 4 with d1 already high.
  feedAll(trigger, packSamples(8, [0, 1, 3, 2, 3, 0, 0, 0]), 1);
  check(
    'multiple conditions are ANDed on the same complete sample',
    trigger.stats.matched && trigger.triggerSampleIndex === 0 &&
      recorder.matches.length === 1 && sameNumbers(recorder.samples(1), [3, 0, 0, 0]),
    `T=${String(trigger.triggerSampleIndex)} emitted=${show(recorder.samples(1))}`,
  );
}

{
  // The matching sample itself is split across two feeds; no decision before the last
  // byte arrives, exactly one match after it.
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'rising' }],
    preTriggerPercent: 0,
    postTrigger: { kind: 'samples', value: 2 },
    capture: { samplerate: 1000, channels: 16 },
  });
  const raw = packSamples(16, [0, 1, 0]);
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 16,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  trigger.feed(raw.subarray(0, 3));
  const before = trigger.stats.matched;
  trigger.feed(raw.subarray(3));
  check(
    'a sample split across feeds matches only after the complete sample arrives',
    !before && trigger.stats.matched && trigger.triggerSampleIndex === 0 &&
      recorder.matches.length === 1 && sameNumbers(recorder.samples(2), [1, 0]),
    `before=${before} T=${String(trigger.triggerSampleIndex)} ` +
      `emitted=${show(recorder.samples(2))}`,
  );
}

{
  // Geometry sweep: 4/8/16/32/64/128 channel samples, all fed as one-byte fragments.
  const wideProfile: DeviceProfile = {
    ...HOST_PROFILE,
    digital: {
      ...HOST_PROFILE.digital,
      maxChannels: 128,
      widths: [4, 8, 16, 32, 64, 128],
      groups: [{ start: 0, channels: 128 }],
    },
  };
  for (const channels of [4, 8, 16, 32, 64, 128] as const) {
    const plan = compile(wideProfile, {
      digital: [{ signal: 'd0', kind: 'high' }],
      preTriggerPercent: 0,
      postTrigger: { kind: 'samples', value: 2 },
      capture: { samplerate: 1000, channels },
    });
    const recorder = new Recorder();
    const trigger = new HostTrigger({
      plan,
      channels,
      samplerate: 1000,
      emit: recorder.emit,
      onMatch: recorder.onMatch,
    });
    const bps = Math.ceil(channels / 8);
    feedAll(trigger, packSamples(channels, [0, 1, 0]), 1);
    check(
      `host executor geometry ${channels}ch: whole samples and exact T`,
      trigger.stats.matched && trigger.triggerSampleIndex === 0 &&
        sameNumbers(recorder.samples(bps), [1, 0]) &&
        recorder.chunks.every((chunk) => chunk.length % bps === 0),
      `T=${String(trigger.triggerSampleIndex)} bps=${bps} ` +
        `emitted=${show(recorder.samples(bps))} bytes=${recorder.emittedBytes()}`,
    );
  }
}

{
  // A continuity reset clears the ring and restarts emitted-stream coordinates; a match
  // after the gap has T in the new emitted stream, not the absolute fed position.
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
  });
  feedAll(trigger, packSamples(8, [0, 0, 0]), 1);
  trigger.noteGap(10);
  // The gap emptied the ring, so the pre-fill holdoff restarts: the high first sample
  // after the gap cannot trigger (its prefix would span the gap); the second one does.
  feedAll(trigger, packSamples(8, [1, 1, 0, 0, 0, 0]), 1);
  check(
    'noteGap restarts the emitted stream and T lies in the new prefix',
    trigger.stats.matched && trigger.triggerSampleIndex === 1 &&
      recorder.matches.length === 1 && recorder.emittedBytes() === 5 &&
      sameNumbers(recorder.samples(1), [1, 1, 0, 0, 0]),
    `T=${String(trigger.triggerSampleIndex)} bytes=${recorder.emittedBytes()} ` +
      `matches=${show(recorder.matches)}`,
  );
}

// ---------------------------------------------------------------------------------
// Custom signal resolution
// ---------------------------------------------------------------------------------

{
  const plan = compile(HOST_PROFILE, {
    digital: [{ signal: 'clk', kind: 'rising' }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'samples', value: 4 },
    capture: { samplerate: 1000, channels: 8 },
  });
  const recorder = new Recorder();
  const trigger = new HostTrigger({
    plan,
    channels: 8,
    samplerate: 1000,
    emit: recorder.emit,
    onMatch: recorder.onMatch,
    resolveChannel: (signal) => (signal === 'clk' ? 2 : null),
  });
  const values = [0, 0, 4, 4, 4, 4, 4, 4];
  feedAll(trigger, packSamples(8, values));
  check(
    'a custom resolver maps non-dN signals onto the configured width',
    trigger.stats.matched && trigger.triggerSampleIndex === 1 &&
      recorder.matches.length === 1 && recorder.matches[0]!.index === 1,
    `T=${String(trigger.triggerSampleIndex)} matches=${show(recorder.matches)}`,
  );
}

// ---------------------------------------------------------------------------------
// Typed refusals for plans this host executor cannot run
// ---------------------------------------------------------------------------------

{
  const valid = compile(HOST_PROFILE, {
    digital: [{ signal: 'd0', kind: 'high' }],
    postTrigger: { kind: 'samples', value: 4 },
  });
  const build = (overrides: Partial<HostTriggerOptions> = {}): HostTrigger => new HostTrigger({
    plan: valid,
    channels: 8,
    samplerate: 1000,
    emit: () => {},
    ...overrides,
  });

  expectHostError(
    'an analog plan is refused with a typed source reason',
    () => new HostTrigger({
      plan: compile(HOST_PROFILE, {
        source: 'analog',
        digital: [],
        analog: [{ signal: 'a0', kind: 'rising', volts: 1 }],
      }),
      channels: 8,
      samplerate: 1000,
      emit: () => {},
    }),
    'unsupported-source',
  );

  expectHostError(
    'a mixed plan is refused with a typed source reason',
    () => new HostTrigger({
      plan: compile(MIXED_PROFILE, {
        source: 'mixed',
        digital: [{ signal: 'd0', kind: 'rising' }],
        analog: [{ signal: 'a0', kind: 'rising', volts: 1 }],
      }),
      channels: 8,
      samplerate: 1000,
      emit: () => {},
    }),
    'unsupported-source',
  );

  expectHostError(
    'a device-executed plan is refused by the host executor',
    () => new HostTrigger({
      plan: compile(DEVICE_PROFILE, {
        digital: [{ signal: 'd0', kind: 'high' }],
      }),
      channels: 8,
      samplerate: 1000,
      emit: () => {},
    }),
    'device-execution',
  );

  expectHostError(
    'an unresolvable signal name is refused',
    () => new HostTrigger({
      plan: compile(HOST_PROFILE, {
        digital: [{ signal: 'clk', kind: 'rising' }],
      }),
      channels: 8,
      samplerate: 1000,
      emit: () => {},
    }),
    'unknown-signal',
  );

  expectHostError(
    'an unsupported channel width is refused',
    () => build({ channels: 7 as ChannelCount }),
    'unsupported-channels',
  );

  expectHostError(
    'a non-positive samplerate is refused',
    () => build({ samplerate: 0 }),
    'invalid-samplerate',
  );

  expectHostError(
    'a malformed budget is refused',
    () => build({
      plan: { ...valid, budget: { kind: 'samples', value: 0 } },
    }),
    'invalid-budget',
  );

  expectHostError(
    'a prefix above the bounded-prefix byte cap is refused',
    () => build({
      plan: {
        ...valid,
        budget: { kind: 'samples', value: 1 },
        preTrigger: {
          ...valid.preTrigger,
          samples: Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / 1) + 1,
          capBytes: Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / 1) + 1,
        },
      },
    }),
    'pre-trigger-too-large',
  );

  expectHostError(
    'a free-anchored Loop is refused because the matcher gates on a match',
    () => new HostTrigger({
      plan: compile(HOST_PROFILE, {
        digital: [{ signal: 'd0', kind: 'high' }],
        postTrigger: { kind: 'unlimited' },
        loop: { seconds: 0.01, anchor: 'free' },
      }),
      channels: 8,
      samplerate: 1000,
      emit: () => {},
    }),
    'unsupported-loop-anchor',
  );

  expectHostError(
    'a Loop plan with a finite post-trigger budget is refused',
    () => build({
      plan: { ...valid, loop: { seconds: 0.01, anchor: 'trigger' } },
    }),
    'invalid-budget',
  );

  expectHostError(
    'an empty condition list is refused',
    () => build({ plan: { ...valid, conditions: [] } }),
    'no-conditions',
  );

  expectHostError(
    'a sparse condition array is a typed refusal, not a TypeError',
    () => build({
      plan: { ...valid, conditions: new Array(1) as unknown as TriggerPlan['conditions'] },
    }),
    'unsupported-condition',
  );

  expectHostError(
    'an invalid search limit is refused',
    () => build({ searchLimitSamples: 0 }),
    'invalid-search-limit',
  );

  {
    const trigger = build();
    expectHostError(
      'a non-Uint8Array fed fragment is refused',
      () => trigger.feed('not bytes' as unknown as Uint8Array),
      'invalid-chunk',
    );
  }
}

// ---------------------------------------------------------------------------------

for (const result of results) {
  if (result.pass) {
    console.log(`ok   ${result.name}`);
  } else {
    console.log(`FAIL ${result.name}: ${result.detail}`);
  }
}
const failures = results.filter((result) => !result.pass);
console.log(
  `hostTrigger selftest: ${results.length - failures.length}/${results.length} passed`,
);
if (failures.length > 0) {
  throw new Error(`${failures.length} hostTrigger selftest check(s) failed`);
}
