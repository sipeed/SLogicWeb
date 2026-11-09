// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic self-test for the legacy capture-trigger bridge.
 *
 * Run with:
 *   node_modules/.bin/esbuild src/dsp/captureTriggerPlanSelftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/capturetriggerplan-selftest.mjs \
 *     --log-level=error && node /tmp/capturetriggerplan-selftest.mjs
 *
 * The fake profiles model the shipped U3 capability set (all digital kinds, analog
 * rising/falling, 75 % / 64 MiB pre-trigger caps) plus variants for device execution,
 * digital-only and no-Loop profiles. The legacy oracle functions below mirror
 * `capturePostTriggerSamples`, the pre-trigger formula in `app.ts` and
 * `triggerSearchSamples` in `captureSession.ts`, so each assertion compares the bridge
 * with the old capture path's arithmetic rather than with the compiler alone. No
 * device, DOM, clock or storage is involved.
 */

import { MAX_SAMPLES, type ChannelCount } from '../types.js';
import type {
  AnalogTriggerKind,
  DeviceProfile,
  TriggerKind,
} from '../device/profileTypes.js';
import {
  captureTriggerPlan,
  type CaptureTriggerPlanArmed,
  type CaptureTriggerPlanInput,
  type CaptureTriggerPlanResult,
  type CaptureTriggerRefusal,
  type LegacyAnalogCondition,
  type LegacyCaptureMode,
  type LegacyDigitalCondition,
  type LegacyTriggerSource,
} from './captureTriggerPlan.js';
import {
  ADC_TRIGGER_HYSTERESIS_CODES,
  analogTriggerArtifactSamples,
} from '../ui/channelBanks.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function armed(result: CaptureTriggerPlanResult): CaptureTriggerPlanArmed | null {
  return result.ok && result.armed ? result : null;
}

function show(result: CaptureTriggerPlanResult): string {
  if (!result.ok) return `${result.reason}: ${result.detail}`;
  if (!result.armed) return 'free-run';
  return `armed ${result.plan.source} plan pre=${String(result.plan.preTrigger.samples)} ` +
    `search=${String(result.host.searchLimitSamples)}`;
}

function showRefusal(result: CaptureTriggerPlanResult): string {
  return result.ok ? show(result) : `${result.reason}: ${result.detail}`;
}

function refusalOf(result: CaptureTriggerPlanResult): CaptureTriggerRefusal | null {
  return result.ok ? null : result;
}

// ---------------------------------------------------------------------------------
// Legacy oracle: the old capture path's arithmetic, copied from the documented rules
// ---------------------------------------------------------------------------------

function bytesPerSample(channels: number): number {
  return Math.ceil(channels / 8);
}

/** `app.ts` pre-trigger ring: percent of the base budget, capped by base and bytes. */
function legacyPreTriggerSamples(
  baseSamples: number,
  percent: number,
  channels: number,
  capBytes: number,
): number {
  return Math.min(
    Math.max(0, baseSamples - 1),
    Math.max(0, Math.floor(baseSamples * percent / 100)),
    Math.floor(capBytes / bytesPerSample(channels)),
  );
}

/** `captureLimitSamples` after the old path adds the retained prefix. */
function legacyCaptureLimitSamples(
  mode: LegacyCaptureMode,
  postTriggerSamples: number,
  preTriggerSamples: number,
): number {
  if (mode === 'loop') return Number.POSITIVE_INFINITY;
  return Math.min(MAX_SAMPLES - 1, postTriggerSamples + preTriggerSamples);
}

/**
 * `captureSession.ts` triggerSearchSamples: only Repeat retries within one sweep, and the
 * pre-fill holdoff's `pre` inspected samples sit on top of the one-sweep match window.
 */
function legacySearchSamples(
  mode: LegacyCaptureMode, sweepSamples: number, preTriggerSamples: number,
): number {
  if (mode !== 'repeat') return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(sweepSamples) || sweepSamples <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.floor(sweepSamples) + Math.max(0, Math.floor(preTriggerSamples));
}

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

const ALL_DIGITAL: readonly TriggerKind[] = [
  'level', 'rising', 'falling', 'edge', 'high', 'low',
];
const ALL_ANALOG: readonly AnalogTriggerKind[] = ['rising', 'falling'];
const PREFIX_BYTES = 64 * 1024 * 1024;

interface ProfileOptions {
  execution?: 'device' | 'host';
  analog?: boolean;
  loop?: boolean;
  digital?: readonly TriggerKind[];
  preTriggerMaxPercent?: number;
  preTriggerMaxBytes?: number;
  maxChannels?: ChannelCount;
  widths?: readonly ChannelCount[];
}

function makeProfile(id: string, options: ProfileOptions = {}): DeviceProfile {
  const maxChannels = options.maxChannels ?? 128;
  return {
    id,
    name: `Fake ${id}`,
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
      maxChannels,
      groups: [{ start: 0, channels: maxChannels }],
      widths: options.widths ?? [4, 8, 16, 32, 64, 128],
      rates: [],
      thresholdVolts: [1.2, 3.3],
      testModes: [0],
    },
    analog: options.analog === false
      ? { groups: [], calibration: { id: 'no-analog', version: 0 } }
      : {
        groups: [{
          start: 0,
          channels: 8,
          ranges: [15],
          adcSpanV: 1.6,
          frontEndAttenuation: 20,
          codeDenominator: 255,
          zeroCode: 128,
          gains: [1],
          resolutionBits: 8,
          maxHz: {},
        }],
        calibration: { id: 'fake-cal', version: 1 },
      },
    trigger: {
      execution: options.execution ?? 'host',
      digital: options.digital ?? ALL_DIGITAL,
      analog: options.analog === false ? [] : ALL_ANALOG,
      mixed: false,
      preTriggerMaxPercent: options.preTriggerMaxPercent ?? 75,
      preTriggerMaxBytes: options.preTriggerMaxBytes ?? PREFIX_BYTES,
    },
    modes: {
      single: true,
      repeat: true,
      loop: options.loop ?? true,
      record: true,
    },
    firmware: { min: '0.0.0' },
  };
}

const HOST_PROFILE = makeProfile('host-128');
const DEVICE_PROFILE = makeProfile('device', { execution: 'device' });
const NO_ANALOG_PROFILE = makeProfile('digital-only', { analog: false });
const NO_LOOP_PROFILE = makeProfile('no-loop', { loop: false });
const SMALL_CAP_PROFILE = makeProfile('small-cap', { preTriggerMaxBytes: 100 });
const RISING_ONLY_PROFILE = makeProfile('rising-only', { digital: ['rising'] });

function makeInput(
  overrides: Partial<CaptureTriggerPlanInput> = {},
): CaptureTriggerPlanInput {
  return {
    profile: HOST_PROFILE,
    enableMask: true,
    source: 'digital',
    digital: [{ channel: 0, kind: 'rising' }],
    analog: [],
    preTriggerPercent: 25,
    mode: 'single',
    postTriggerSamples: 1000,
    channels: 8,
    samplerate: 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------
// Legacy free-run gate: mask off, no conditions, and source filtering
// ---------------------------------------------------------------------------------

{
  const result = captureTriggerPlan(makeInput({ enableMask: false }));
  check(
    'an off enable mask free-runs and leaves stored conditions unarmed',
    result.ok && !result.armed && result.plan === null && result.host === null,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({ digital: [], analog: [] }));
  check(
    'an armed mask with no effective condition free-runs',
    result.ok && !result.armed && result.plan === null,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    source: 'digital',
    digital: [],
    analog: [{ start: 0, kind: 'rising', volts: 1 }],
  }));
  check(
    'the stored analog family cannot arm a digital source',
    result.ok && !result.armed,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    source: 'analog',
    digital: [{ channel: 0, kind: 'rising' }],
    analog: [],
  }));
  check(
    'the stored digital family cannot arm an analog source',
    result.ok && !result.armed,
    show(result),
  );
}

{
  const malformed = [{ channel: -3, kind: 'bogus' as TriggerKind }];
  const result = captureTriggerPlan(makeInput({ enableMask: false, digital: malformed }));
  check(
    'a disabled mask does not validate stored malformed conditions',
    result.ok && !result.armed,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    source: 'digital',
    digital: [{ channel: 0, kind: 'rising' }],
    analog: 'not-an-array' as unknown as readonly LegacyAnalogCondition[],
  }));
  check(
    'a malformed unselected family is ignored, exactly like the legacy filter',
    armed(result) !== null,
    show(result),
  );
}

// ---------------------------------------------------------------------------------
// Digital translation: channel names, level polarity, high/low and the single alias
// ---------------------------------------------------------------------------------

{
  const result = captureTriggerPlan(makeInput({
    digital: [{ channel: 3, kind: 'rising' }],
  }));
  const plan = armed(result)?.plan;
  check(
    'a legacy rising condition on channel 3 maps to d3',
    plan !== undefined &&
      plan.source === 'digital' &&
      plan.execution === 'host' &&
      sameJson(plan.conditions, [
        { kind: 'digital', signal: 'd3', mode: 'rising' },
      ]),
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    digital: [
      { channel: 0, kind: 'level', level: 1 },
      { channel: 1, kind: 'level', level: 0 },
      { channel: 2, kind: 'high' },
      { channel: 3, kind: 'low' },
    ],
  }));
  const plan = armed(result)?.plan;
  check(
    'level polarity and the high/low aliases keep their meaning',
    sameJson(plan?.conditions, [
      { kind: 'digital', signal: 'd0', mode: 'level', level: 1 },
      { kind: 'digital', signal: 'd1', mode: 'level', level: 0 },
      { kind: 'digital', signal: 'd2', mode: 'high' },
      { kind: 'digital', signal: 'd3', mode: 'low' },
    ]),
    show(result),
  );
}

{
  const viaList = armed(captureTriggerPlan(makeInput({
    digital: [{ channel: 5, kind: 'level', level: 0 }],
  })));
  const viaSingle = armed(captureTriggerPlan(makeInput({
    digital: [],
    single: { channel: 5, kind: 'level', level: 0 },
  })));
  check(
    'the legacy single-condition alias compiles like a one-item condition list',
    viaList !== null && viaSingle !== null && sameJson(viaList.plan, viaSingle.plan),
    viaSingle === null ? 'single alias refused' : show(viaSingle),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    digital: [{ channel: 1, kind: 'rising' }],
    single: { channel: 5, kind: 'falling' },
  }));
  const plan = armed(result)?.plan;
  check(
    'confirmed per-channel conditions take precedence over the single alias',
    sameJson(plan?.conditions, [
      { kind: 'digital', signal: 'd1', mode: 'rising' },
    ]),
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    digital: [
      { channel: 0, kind: 'rising' },
      { channel: 2, kind: 'falling' },
    ],
  }));
  const plan = armed(result)?.plan;
  check(
    'multiple conditions stay ordered and ANDed on one sample',
    sameJson(plan?.conditions, [
      { kind: 'digital', signal: 'd0', mode: 'rising' },
      { kind: 'digital', signal: 'd2', mode: 'falling' },
    ]),
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    channels: 128,
    digital: [{ channel: 100, kind: 'rising' }],
  }));
  const plan = armed(result)?.plan;
  check(
    'a 128-channel capture resolves channel 100 to d100',
    plan !== undefined &&
      plan.conditions[0]?.kind === 'digital' &&
      plan.conditions[0].signal === 'd100' &&
      armed(result)?.host.channels === 128,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    channels: 128,
    digital: [{ channel: 128, kind: 'rising' }],
  }));
  check(
    'a channel outside the capture width is a typed refusal',
    !result.ok && result.reason === 'invalid-channel',
    showRefusal(result),
  );
}

// ---------------------------------------------------------------------------------
// Budget and pre-trigger base
// ---------------------------------------------------------------------------------

for (const sample of [
  { post: 1000, percent: 25 },
  { post: 500, percent: 75 },
  { post: 100, percent: 75 },
  { post: 4096, percent: 10 },
  { post: 1000, percent: 0 },
]) {
  const result = captureTriggerPlan(makeInput({
    postTriggerSamples: sample.post,
    preTriggerPercent: sample.percent,
  }));
  const plan = armed(result)?.plan;
  const expectedPre = legacyPreTriggerSamples(
    sample.post, sample.percent, 8, PREFIX_BYTES,
  );
  check(
    `pre-trigger for post=${sample.post}, percent=${sample.percent} matches the legacy floor`,
    plan !== undefined &&
      plan.preTrigger.samples === expectedPre &&
      plan.preTrigger.seconds === expectedPre / 1000 &&
      plan.preTrigger.percent === Math.min(sample.percent, 75) &&
      sameJson(plan.budget, { kind: 'samples', value: sample.post }),
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({ preTriggerPercent: 90 }));
  const plan = armed(result)?.plan;
  check(
    'the profile pre-trigger percent cap is left to the compiler',
    plan?.preTrigger.percent === 75 &&
      plan.preTrigger.samples === 750 &&
      plan.preTrigger.seconds === 0.75,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    profile: SMALL_CAP_PROFILE,
    channels: 16,
    preTriggerPercent: 75,
  }));
  const plan = armed(result)?.plan;
  check(
    'the profile pre-trigger byte cap is left to the compiler',
    plan?.preTrigger.capBytes === 100 &&
      plan.preTrigger.samples === 50 &&
      plan.preTrigger.seconds === 0.05,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    channels: 4,
    digital: [{ channel: 3, kind: 'edge' }],
    postTriggerSamples: 400,
    preTriggerPercent: 50,
  }));
  const plan = armed(result)?.plan;
  check(
    'a 4-channel capture keeps whole one-byte samples in the pre-trigger window',
    plan?.preTrigger.samples === 200 &&
      plan.preTrigger.seconds === 0.2 &&
      sameJson(plan.conditions, [
        { kind: 'digital', signal: 'd3', mode: 'edge' },
      ]),
    show(result),
  );
}

// ---------------------------------------------------------------------------------
// Loop: unlimited budget, window as pre-trigger base, anchor, refusal
// ---------------------------------------------------------------------------------

{
  const result = captureTriggerPlan(makeInput({
    mode: 'loop',
    postTriggerSamples: 4096,
    preTriggerPercent: 10,
  }));
  const plan = armed(result)?.plan;
  const expectedPre = legacyPreTriggerSamples(4096, 10, 8, PREFIX_BYTES);
  check(
    'Loop uses an unlimited budget, the legacy window and a trigger anchor',
    plan !== undefined &&
      sameJson(plan.budget, { kind: 'unlimited' }) &&
      plan.loop !== undefined &&
      plan.loop.anchor === 'trigger' &&
      plan.loop.seconds === 4.096 &&
      plan.preTrigger.samples === expectedPre &&
      armed(result)?.host.searchLimitSamples === Number.POSITIVE_INFINITY,
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    mode: 'loop',
    postTriggerSamples: 4096,
    loopAnchor: 'free',
  }));
  check(
    'a free-anchored Loop is refused for host execution',
    !result.ok && result.reason === 'unsupported-loop-anchor',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    profile: NO_LOOP_PROFILE,
    mode: 'loop',
    postTriggerSamples: 4096,
  }));
  check(
    'Loop on a profile without Loop support passes the compiler refusal through',
    !result.ok && result.reason === 'unsupported-mode',
    showRefusal(result),
  );
}

{
  const zero = captureTriggerPlan(makeInput({ mode: 'loop', postTriggerSamples: 0 }));
  const fractional = captureTriggerPlan(makeInput({
    mode: 'loop',
    postTriggerSamples: 10.5,
  }));
  const refusal = refusalOf(zero);
  const fractionRefusal = refusalOf(fractional);
  check(
    'a Loop window must be a positive whole sample count',
    refusal?.reason === 'invalid-budget' &&
      fractionRefusal?.reason === 'invalid-budget',
    `${showRefusal(zero)} / ${showRefusal(fractional)}`,
  );
}

// ---------------------------------------------------------------------------------
// Repeat search allowance: compared with triggerSearchSamples()
// ---------------------------------------------------------------------------------

{
  const result = captureTriggerPlan(makeInput({
    mode: 'repeat',
    postTriggerSamples: 1000,
    preTriggerPercent: 25,
  }));
  const plan = armed(result)?.plan;
  const pre = plan?.preTrigger.samples;
  const expected = pre === undefined
    ? Number.NaN
    : legacySearchSamples('repeat', legacyCaptureLimitSamples('repeat', 1000, pre), pre);
  check(
    'Repeat exposes the one-sweep match window after the pre-fill holdoff',
    plan !== undefined &&
      armed(result) !== null &&
      armed(result)!.host.searchLimitSamples === expected &&
      expected === 1250 + (pre ?? Number.NaN),
    show(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    mode: 'repeat',
    postTriggerSamples: MAX_SAMPLES - 1,
    preTriggerPercent: 75,
  }));
  const pre = armed(result)?.plan.preTrigger.samples ?? Number.NaN;
  check(
    'the Repeat match window caps at MAX_SAMPLES - 1 like the legacy capture limit',
    armed(result)?.host.searchLimitSamples === MAX_SAMPLES - 1 + pre,
    show(result),
  );
}

{
  const single = captureTriggerPlan(makeInput({ mode: 'single' }));
  const loop = captureTriggerPlan(makeInput({
    mode: 'loop',
    postTriggerSamples: 4096,
  }));
  check(
    'Single and Loop searches are unbounded',
    armed(single)?.host.searchLimitSamples === Number.POSITIVE_INFINITY &&
      armed(loop)?.host.searchLimitSamples === Number.POSITIVE_INFINITY,
    `${show(single)} / ${show(loop)}`,
  );
}

// ---------------------------------------------------------------------------------
// Analog: compiled in volts, then refused as not host-executable
// ---------------------------------------------------------------------------------

{
  const result = captureTriggerPlan(makeInput({
    source: 'analog',
    digital: [],
    analog: [{ start: 0, kind: 'rising', volts: 2.5 }],
  }));
  check(
    'a valid analog trigger compiles but is refused as not host-executable',
    !result.ok && result.reason === 'unsupported-analog-host',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    source: 'analog',
    digital: [],
    analog: [{ start: 0, kind: 'rising', volts: 99 }],
  }));
  check(
    'analog volts reach the compiler range check rather than an ADC code conversion',
    !result.ok && result.reason === 'unsupported-analog',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    profile: NO_ANALOG_PROFILE,
    source: 'analog',
    digital: [],
    analog: [{ start: 0, kind: 'falling', volts: 1 }],
  }));
  check(
    'an analog request on a digital-only profile is refused by the compiler',
    !result.ok && result.reason === 'unsupported-analog',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    enableMask: false,
    source: 'analog',
    digital: [],
    analog: [{ start: 0, kind: 'rising', volts: 2.5 }],
  }));
  check(
    'an analog trigger with the mask off free-runs',
    result.ok && !result.armed,
    show(result),
  );
}

// ---------------------------------------------------------------------------------
// Malformed input and policy delegation
// ---------------------------------------------------------------------------------

{
  const badMode = captureTriggerPlan(makeInput({
    mode: 'record' as unknown as LegacyCaptureMode,
  }));
  check(
    'an unknown capture mode is a typed refusal',
    !badMode.ok && badMode.reason === 'invalid-mode',
    showRefusal(badMode),
  );
}

{
  const badSource = captureTriggerPlan(makeInput({
    source: 'mixed' as unknown as LegacyTriggerSource,
  }));
  check(
    'a mixed legacy source is a typed refusal',
    !badSource.ok && badSource.reason === 'invalid-source',
    showRefusal(badSource),
  );
}

{
  const wide = captureTriggerPlan(makeInput({
    digital: [{ channel: 8, kind: 'rising' }],
  }));
  const fractional = captureTriggerPlan(makeInput({
    digital: [{ channel: 1.5, kind: 'rising' }],
  }));
  const wideRefusal = refusalOf(wide);
  const fractionRefusal = refusalOf(fractional);
  check(
    'channels outside the width or non-integer channels are refused',
    wideRefusal?.reason === 'invalid-channel' &&
      fractionRefusal?.reason === 'invalid-channel',
    `${showRefusal(wide)} / ${showRefusal(fractional)}`,
  );
}

{
  const result = captureTriggerPlan(makeInput({
    source: 'analog',
    digital: [],
    analog: [{ start: -8, kind: 'rising', volts: 1 }],
  }));
  check(
    'an invalid analog group start is refused',
    !result.ok && result.reason === 'invalid-analog-group',
    showRefusal(result),
  );
}

{
  const zero = captureTriggerPlan(makeInput({ postTriggerSamples: 0 }));
  const nan = captureTriggerPlan(makeInput({ postTriggerSamples: Number.NaN }));
  check(
    'a non-positive or non-numeric post budget is refused',
    refusalOf(zero)?.reason === 'invalid-budget' &&
      refusalOf(nan)?.reason === 'invalid-budget',
    `${showRefusal(zero)} / ${showRefusal(nan)}`,
  );
}

{
  const result = captureTriggerPlan(makeInput({
    digital: [{ channel: 0, kind: 'bogus' as unknown as TriggerKind }],
  }));
  check(
    'the compiler owns unknown digital kinds',
    !result.ok && result.reason === 'unsupported-digital',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    source: 'analog',
    digital: [],
    analog: [{
      start: 0,
      kind: 'both' as unknown as AnalogTriggerKind,
      volts: 1,
    }],
  }));
  check(
    'the compiler owns unknown analog kinds',
    !result.ok && result.reason === 'unsupported-analog',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    digital: [null as unknown as LegacyDigitalCondition],
  }));
  check(
    'a malformed condition entry is a typed refusal',
    !result.ok && result.reason === 'invalid-condition',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    digital: 'd0' as unknown as readonly LegacyDigitalCondition[],
  }));
  check(
    'a non-array condition list is a typed refusal',
    !result.ok && result.reason === 'invalid-condition',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    profile: RISING_ONLY_PROFILE,
    digital: [{ channel: 0, kind: 'falling' }],
  }));
  check(
    'profile digital capability policy stays in the compiler',
    !result.ok && result.reason === 'unsupported-digital',
    showRefusal(result),
  );
}

{
  const result = captureTriggerPlan(makeInput({ profile: DEVICE_PROFILE }));
  check(
    'a device-executed plan cannot become a HostTrigger descriptor',
    !result.ok && result.reason === 'device-execution',
    showRefusal(result),
  );
}

// ---------------------------------------------------------------------------------
// Determinism, no mutation and descriptor shape
// ---------------------------------------------------------------------------------

{
  const conditions: LegacyDigitalCondition[] = [{ channel: 0, kind: 'rising' }];
  const input = makeInput({ digital: conditions });
  const first = captureTriggerPlan(input);
  const second = captureTriggerPlan(input);
  check(
    'the same input produces byte-identical results',
    sameJson(first, second),
    show(first),
  );
  check(
    'the input condition list is not mutated or aliased',
    conditions.length === 1 && conditions[0]!.channel === 0,
    JSON.stringify(conditions),
  );
  check(
    'the bridge is deterministic by default (compiledAt 0)',
    armed(first)?.plan.compiledAt === 0,
    show(first),
  );
  const clocked = captureTriggerPlan(makeInput({ compiledAt: 123 }));
  check(
    'an explicit compiledAt is forwarded',
    armed(clocked)?.plan.compiledAt === 123,
    show(clocked),
  );
}

{
  const result = captureTriggerPlan(makeInput({
    channels: 16,
    samplerate: 2_000_000,
  }));
  check(
    'the host descriptor carries the capture width and rate',
    armed(result)?.host.channels === 16 &&
      armed(result)?.host.samplerate === 2_000_000,
    show(result),
  );
}

// ---------------------------------------------------------------------------------
// Analog qualification: hysteresis and persistence travel in the descriptor
// ---------------------------------------------------------------------------------

{
  // P = ceil(240 ns * rate), from the plan's samplerate; h is the module's 4 codes.
  const cases: Array<[number, number]> = [
    [100e6, 24], [200e6, 48], [400e6, 96], [800e6, 192], [1000, 1], [12.5e6, 3],
  ];
  for (const [samplerate, persist] of cases) {
    const result = captureTriggerPlan(makeInput({
      source: 'analog',
      digital: [],
      analog: [{ start: 0, kind: 'rising', volts: 2.5 }],
      samplerate,
    }));
    const host = result.ok ? null : result.host;
    check(
      `the analog refusal carries h=4 and P=${persist} at ${samplerate} Hz`,
      !result.ok && result.reason === 'unsupported-analog-host' &&
        result.plan?.source === 'analog' && host !== undefined && host !== null &&
        host.analogHysteresis === ADC_TRIGGER_HYSTERESIS_CODES &&
        host.analogHysteresis === 4 &&
        host.analogArtifactSamples === persist &&
        host.analogArtifactSamples === analogTriggerArtifactSamples(samplerate) &&
        host.samplerate === samplerate,
      showRefusal(result) + ` host=${JSON.stringify(host)}`,
    );
  }
}

{
  // The Repeat allowance is unchanged by persistence: an executor counts persistence
  // samples as inspected, so no analog term is added to the sweep.
  const digital = captureTriggerPlan(makeInput({ mode: 'repeat', samplerate: 100e6 }));
  const analogResult = captureTriggerPlan(makeInput({
    mode: 'repeat',
    samplerate: 100e6,
    source: 'analog',
    digital: [],
    analog: [{ start: 0, kind: 'falling', volts: -1 }],
  }));
  const analogHost = analogResult.ok ? undefined : analogResult.host;
  check(
    'an analog Repeat descriptor keeps the legacy search allowance',
    armed(digital) !== null && analogHost !== undefined &&
      analogHost.searchLimitSamples === armed(digital)!.host.searchLimitSamples &&
      analogHost.searchLimitSamples === 1000 + 250 + 250,
    `${show(digital)} ${JSON.stringify(analogHost)}`,
  );
}

{
  // Legacy defaults: the plan stays in volts with no volt hysteresis unless the legacy
  // input states one; a digital descriptor carries the same numbers, which a digital
  // matcher ignores.
  const plain = captureTriggerPlan(makeInput({
    source: 'analog',
    digital: [],
    analog: [{ start: 0, kind: 'rising', volts: 2.5 }],
    samplerate: 100e6,
  }));
  const condition = plain.ok ? undefined : plain.plan?.conditions[0];
  check(
    'an analog plan keeps volts and adds no volt hysteresis by default',
    condition !== undefined && condition.kind === 'analog' && condition.volts === 2.5 &&
      !('hysteresis' in condition),
    JSON.stringify(condition),
  );
  const withHysteresis = captureTriggerPlan(makeInput({
    source: 'analog',
    digital: [],
    analog: [{ start: 0, kind: 'rising', volts: 2.5, hysteresis: 0.5 }],
    samplerate: 100e6,
  }));
  const explicit = withHysteresis.ok ? undefined : withHysteresis.plan?.conditions[0];
  check(
    'an explicit legacy volt hysteresis still reaches the plan',
    explicit !== undefined && explicit.kind === 'analog' && explicit.hysteresis === 0.5,
    JSON.stringify(explicit),
  );
  const digitalResult = captureTriggerPlan(makeInput({ samplerate: 100e6 }));
  check(
    'a digital descriptor carries the qualification too (ignored by digital matching)',
    armed(digitalResult)?.host.analogHysteresis === 4 &&
      armed(digitalResult)?.host.analogArtifactSamples === 24,
    show(digitalResult),
  );
  const other = captureTriggerPlan(makeInput({ digital: [{ channel: 9, kind: 'rising' }] }));
  check(
    'refusals other than unsupported-analog-host carry no plan or descriptor',
    !other.ok && other.reason === 'invalid-channel' &&
      other.plan === undefined && other.host === undefined,
    showRefusal(other),
  );
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
  `captureTriggerPlan selftest: ${results.length - failures.length}/${results.length} passed`,
);
if (failures.length > 0) {
  throw new Error(`${failures.length} captureTriggerPlan selftest check(s) failed`);
}
