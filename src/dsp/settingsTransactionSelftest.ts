// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic checks for the M0 settings transaction. Self-contained: fake
 * 16U3-like/32U3-like profiles, in-memory contexts, no device, DOM or storage.
 *
 * Run:
 *   node_modules/.bin/esbuild src/dsp/settingsTransactionSelftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/settings-selftest.mjs --log-level=error
 *   node /tmp/settings-selftest.mjs
 */

import type {
  AnalogTriggerKind,
  DeviceProfile,
  LinkRate,
  RateTier,
  TestMode,
} from '../device/profileTypes.js';
import type { ChannelCount } from '../types.js';
import { MAX_SAMPLES } from '../types.js';
import {
  createAcquisitionContext,
  type AcquisitionContext,
} from './acquisition.js';
import type { DigitalTriggerInput, TriggerSource } from './triggerPlan.js';
import {
  SETTINGS_EFFECTS,
  SETTING_EDIT_FEATURES,
  SETTING_KEYS,
  SETTING_POLICIES,
  commitSettings,
  type CaptureConfig,
  type SettingsResult,
  type SettingScope,
} from './settingsTransaction.js';

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

function failDetail(result: SettingsResult): string {
  return result.ok
    ? 'committed unexpectedly'
    : `${result.reason}: ${result.detail}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as unknown as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fake profiles and contexts
// ---------------------------------------------------------------------------

const ALL_DIGITAL = ['level', 'rising', 'falling', 'edge', 'high', 'low'] as const;
const ALL_ANALOG: readonly AnalogTriggerKind[] = ['rising', 'falling'];

function digitalCeiling(channels: ChannelCount): number {
  switch (channels) {
    case 4:
      return 800e6;
    case 8:
      return 400e6;
    case 16:
      return 200e6;
    case 32:
      return 200e6;
    case 64:
      return 100e6;
    case 128:
      return 50e6;
  }
}

function digitalTier(channels: ChannelCount): RateTier {
  const ss = digitalCeiling(channels);
  const hz: Partial<Record<LinkRate, number>> = {
    ss5: ss,
    hs: Math.min(ss, 320e6 / channels),
  };
  return { channels, hz };
}

interface ProfileOptions {
  id?: string;
  widths?: readonly ChannelCount[];
  analog?: boolean;
  mixed?: boolean;
  modes?: Partial<DeviceProfile['modes']>;
  testModes?: readonly TestMode[];
  thresholds?: readonly number[] | null;
  preTriggerMaxPercent?: number;
  preTriggerMaxBytes?: number;
}

function makeProfile(options: ProfileOptions = {}): DeviceProfile {
  const widths = options.widths ?? [4, 8, 16];
  const maxChannels = widths[widths.length - 1] ?? 16;
  return {
    id: options.id ?? 'fake-16u3',
    name: options.id ?? 'Fake 16U3',
    vid: 0x1d50,
    pid: 0x60e6,
    serial: { required: false },
    link: {
      interfaceClass: 0xff,
      endpoints: { in: 1, out: null },
      maxTransferBytes: 1024 * 1024,
      rates: ['fs', 'hs', 'ss5'],
      probe: { bytes: 4096, bursts: 2 },
    },
    digital: {
      maxChannels,
      groups: [{ start: 0, channels: maxChannels }],
      widths,
      rates: widths.map(digitalTier),
      sampleratesHz: [
        5e6, 8e6, 10e6, 16e6, 20e6, 25e6, 32e6, 40e6, 50e6, 80e6, 100e6, 160e6,
        200e6, 400e6, 800e6,
      ],
      thresholdVolts: options.thresholds === undefined
        ? [0.6, 1.2, 1.8, 3.3]
        : options.thresholds,
      testModes: options.testModes ?? [0, 1, 2],
      emulationPattern: 'slogic16u3',
    },
    analog: {
      groups: options.analog
        ? [{
          start: 0,
          channels: 8,
          ranges: [15],
          adcSpanV: 1.6,
          frontEndAttenuation: 20,
          codeDenominator: 255,
          zeroCode: 128,
          gains: [1],
          resolutionBits: 8,
          maxHz: { ss5: 800e6, hs: 40e6 },
        }]
        : [],
      calibration: { id: options.analog ? 'fake-adc' : 'no-analog', version: 1 },
    },
    trigger: {
      execution: 'host',
      digital: ALL_DIGITAL,
      analog: options.analog ? ALL_ANALOG : [],
      mixed: options.mixed === true,
      preTriggerMaxPercent: options.preTriggerMaxPercent ?? 75,
      preTriggerMaxBytes: options.preTriggerMaxBytes ?? 64 * 1024 * 1024,
    },
    modes: {
      single: true,
      repeat: true,
      loop: true,
      record: true,
      ...options.modes,
    },
    firmware: { min: '0' },
  };
}

const PROFILE_16U3 = makeProfile();
const PROFILE_32U3 = makeProfile({
  id: 'fake-32u3',
  widths: [4, 8, 16, 32],
  analog: true,
  mixed: true,
});

function ctx(overrides: Partial<AcquisitionContext> = {}): AcquisitionContext {
  return createAcquisitionContext({
    connection: 'ready',
    acquisition: 'idle',
    ...overrides,
  });
}

function baseConfig(overrides: Partial<CaptureConfig> = {}): CaptureConfig {
  return {
    mode: 'single',
    channels: 16,
    samplerate: 16e6,
    thresholdVolts: 1.2,
    durationSeconds: 1,
    unlimited: false,
    repeatIntervalSeconds: 1,
    loopSeconds: 1,
    triggerEnableMask: false,
    triggerSource: 'digital',
    digitalConditions: [],
    analogConditions: [],
    preTriggerPercent: 10,
    testMode: 0,
    ...overrides,
  };
}

const RISING_D0: DigitalTriggerInput = { signal: 'd0', kind: 'rising' };
const FALLING_D0: DigitalTriggerInput = { signal: 'd0', kind: 'falling' };

// ---------------------------------------------------------------------------
// Live / next / restart classification
// ---------------------------------------------------------------------------

{
  const current = deepFreeze(baseConfig());
  const result = commitSettings({
    current,
    patch: { channels: 8, samplerate: 20e6, thresholdVolts: 1.8 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'live width/rate/threshold settings apply while idle',
    result.ok &&
      result.next.channels === 8 &&
      result.next.samplerate === 20e6 &&
      result.next.thresholdVolts === 1.8 &&
      result.applied.channels === 8 &&
      result.applied.samplerate === 20e6 &&
      result.applied.thresholdVolts === 1.8,
    failDetail(result),
  );
  check(
    'live changes declare apply-live and leave pending empty',
    result.ok &&
      result.effects.includes('apply-live') &&
      result.pending.length === 0,
    result.ok ? `pending=${result.pending.join(',')}` : failDetail(result),
  );
}

{
  const current = baseConfig({ mode: 'loop' });
  const idle = commitSettings({
    current,
    patch: { loopSeconds: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a Loop window edit is allowed while idle',
    idle.ok && idle.next.loopSeconds === 2,
    failDetail(idle),
  );
  check(
    'the statically-next Loop window is staged rather than applied live',
    idle.ok &&
      idle.pending.includes('loopSeconds') &&
      !idle.effects.includes('apply-live'),
    idle.ok ? `pending=${idle.pending.join(',')}` : failDetail(idle),
  );

  const running = commitSettings({
    current,
    patch: { loopSeconds: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'running', mode: 'loop' }),
  });
  check(
    'a Loop window edit while running is accepted and pending, not refused',
    running.ok && running.pending.includes('loopSeconds'),
    failDetail(running),
  );
}

{
  const result = commitSettings({
    current: baseConfig(),
    patch: { samplerate: 10e6 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'running' }),
  });
  check(
    'a rate edit while running is accepted but pending for the next acquisition',
    result.ok && result.next.samplerate === 10e6 && result.pending.includes('samplerate'),
    failDetail(result),
  );
  check(
    'a device setting that needs a restart declares restart-required',
    result.ok && result.effects.includes('restart-required'),
    result.ok ? `effects=${result.effects.join(',')}` : failDetail(result),
  );
}

{
  const current = deepFreeze(baseConfig());
  const result = commitSettings({
    current,
    patch: { durationSeconds: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'stopping' }),
  });
  check(
    'a capture edit while stopping is refused with a typed reason and field',
    !result.ok &&
      result.reason === 'edit-refused' &&
      result.field === 'durationSeconds',
    failDetail(result),
  );
  check(
    'a refused transaction returns no next configuration',
    !result.ok && !('next' in result),
  );
  check(
    'a refused transaction leaves the current configuration untouched',
    current.durationSeconds === 1,
  );
}

// ---------------------------------------------------------------------------
// Profile validation and atomicity
// ---------------------------------------------------------------------------

{
  const result = commitSettings({
    current: baseConfig(),
    patch: {
      triggerEnableMask: true,
      triggerSource: 'analog',
      analogConditions: [{ signal: 'a0', kind: 'rising', volts: 1 }],
    },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'analog trigger on a 16U3-like profile is a trigger-plan refusal',
    !result.ok &&
      result.reason === 'trigger-plan' &&
      result.field === 'analogConditions' &&
      result.detail.includes('unsupported-analog'),
    failDetail(result),
  );
}

{
  const badWidth = commitSettings({
    current: baseConfig(),
    patch: { channels: 3 as unknown as ChannelCount },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a non-channel-count width is invalid-value',
    !badWidth.ok && badWidth.reason === 'invalid-value' && badWidth.field === 'channels',
    failDetail(badWidth),
  );

  const badRate = commitSettings({
    current: baseConfig(),
    patch: { samplerate: 0 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a non-positive rate is invalid-value',
    !badRate.ok && badRate.reason === 'invalid-value' && badRate.field === 'samplerate',
    failDetail(badRate),
  );

  const unoffered = commitSettings({
    current: baseConfig(),
    patch: { samplerate: 3e6 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a rate the device does not offer is unsupported-profile',
    !unoffered.ok &&
      unoffered.reason === 'unsupported-profile' &&
      unoffered.field === 'samplerate',
    failDetail(unoffered),
  );

  const hsTooFast = commitSettings({
    current: baseConfig({ samplerate: 20e6 }),
    patch: { samplerate: 25e6 },
    profile: PROFILE_16U3,
    linkRate: 'hs',
    context: ctx(),
  });
  check(
    'a rate above the HS ceiling is unsupported-profile',
    !hsTooFast.ok &&
      hsTooFast.reason === 'unsupported-profile' &&
      hsTooFast.field === 'samplerate',
    failDetail(hsTooFast),
  );

  const noTier = commitSettings({
    current: baseConfig(),
    patch: {},
    profile: PROFILE_16U3,
    linkRate: 'ss10',
    context: ctx(),
  });
  check(
    'a link class with no tier is unsupported-profile',
    !noTier.ok &&
      noTier.reason === 'unsupported-profile' &&
      noTier.field === 'samplerate',
    failDetail(noTier),
  );

  const wide = commitSettings({
    current: baseConfig(),
    patch: { channels: 32 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a width the profile does not offer is unsupported-profile',
    !wide.ok && wide.reason === 'unsupported-profile' && wide.field === 'channels',
    failDetail(wide),
  );

  const fast = commitSettings({
    current: baseConfig(),
    patch: { samplerate: 800e6 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a rate above the width ceiling is unsupported-profile',
    !fast.ok && fast.reason === 'unsupported-profile' && fast.field === 'samplerate',
    failDetail(fast),
  );

  const threshold = commitSettings({
    current: baseConfig(),
    patch: { thresholdVolts: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a threshold the profile does not offer is unsupported-profile',
    !threshold.ok &&
      threshold.reason === 'unsupported-profile' &&
      threshold.field === 'thresholdVolts',
    failDetail(threshold),
  );

  const noRepeat = makeProfile({ modes: { repeat: false } });
  const mode = commitSettings({
    current: baseConfig(),
    patch: { mode: 'repeat' },
    profile: noRepeat,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'an unsupported capture mode is unsupported-profile',
    !mode.ok && mode.reason === 'unsupported-profile' && mode.field === 'mode',
    failDetail(mode),
  );

  const limitedTestModes = makeProfile({ testModes: [0, 1] });
  const testMode = commitSettings({
    current: baseConfig(),
    patch: { testMode: 2 },
    profile: limitedTestModes,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a test mode the profile does not offer is unsupported-profile',
    !testMode.ok &&
      testMode.reason === 'unsupported-profile' &&
      testMode.field === 'testMode',
    failDetail(testMode),
  );

  const badTestMode = commitSettings({
    current: baseConfig(),
    patch: { testMode: 7 as unknown as TestMode },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a test mode outside 0..2 is invalid-value',
    !badTestMode.ok &&
      badTestMode.reason === 'invalid-value' &&
      badTestMode.field === 'testMode',
    failDetail(badTestMode),
  );

  const badSource = commitSettings({
    current: baseConfig(),
    patch: { triggerSource: 'both' as unknown as TriggerSource },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'an unknown trigger source is invalid-value',
    !badSource.ok &&
      badSource.reason === 'invalid-value' &&
      badSource.field === 'triggerSource',
    failDetail(badSource),
  );
}

{
  const current = deepFreeze(baseConfig());
  const result = commitSettings({
    current,
    patch: { channels: 8, samplerate: -1 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'one invalid field refuses the whole patch',
    !result.ok && result.reason === 'invalid-value' && result.field === 'samplerate',
    failDetail(result),
  );
  check(
    'no partial commit occurred for the valid field in the same patch',
    current.channels === 16 && current.samplerate === 16e6,
  );
}

// ---------------------------------------------------------------------------
// Trigger plan compilation and pending tracking
// ---------------------------------------------------------------------------

{
  const armed = commitSettings({
    current: baseConfig(),
    patch: { triggerEnableMask: true, digitalConditions: [RISING_D0] },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  const armedNext = armed.ok ? armed.next : baseConfig();
  check(
    'enabling the mask at idle compiles the next plan and no active plan',
    armed.ok &&
      armed.activePlan === null &&
      armed.nextPlan !== null &&
      armed.nextPlan.source === 'digital' &&
      armed.nextPlan.conditions.length === 1 &&
      armed.nextPlan.conditions[0]?.kind === 'digital' &&
      armed.nextPlan.conditions[0]?.mode === 'rising',
    failDetail(armed),
  );
  check(
    'the next plan is deterministic (compiledAt is fixed)',
    armed.ok && armed.nextPlan !== null && armed.nextPlan.compiledAt === 0,
    armed.ok && armed.nextPlan !== null
      ? `compiledAt=${armed.nextPlan.compiledAt}`
      : failDetail(armed),
  );
  check(
    'an idle transaction declares no trigger recompile',
    armed.ok && !armed.effects.includes('recompile-trigger'),
    armed.ok ? `effects=${armed.effects.join(',')}` : failDetail(armed),
  );

  const changedCondition = commitSettings({
    current: armedNext,
    patch: { digitalConditions: [FALLING_D0] },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'changing a condition updates the next plan',
    changedCondition.ok &&
      changedCondition.nextPlan !== null &&
      changedCondition.nextPlan.conditions[0]?.mode === 'falling',
    failDetail(changedCondition),
  );
  check(
    'an idle trigger edit does not declare recompile-trigger',
    changedCondition.ok && !changedCondition.effects.includes('recompile-trigger'),
    changedCondition.ok
      ? `effects=${changedCondition.effects.join(',')}`
      : failDetail(changedCondition),
  );

  const disarmed = commitSettings({
    current: changedCondition.ok ? changedCondition.next : armedNext,
    patch: { triggerEnableMask: false },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'disabling the mask keeps conditions stored and returns null plans',
    disarmed.ok &&
      disarmed.activePlan === null &&
      disarmed.nextPlan === null &&
      disarmed.next.digitalConditions[0]?.kind === 'falling',
    failDetail(disarmed),
  );
  check(
    'mask-off at idle declares no trigger effect',
    disarmed.ok && !disarmed.effects.includes('disarm-trigger'),
    disarmed.ok ? `effects=${disarmed.effects.join(',')}` : failDetail(disarmed),
  );
}

{
  const current = baseConfig({
    triggerEnableMask: true,
    digitalConditions: [RISING_D0],
  });
  const result = commitSettings({
    current,
    patch: {
      samplerate: 10e6,
      loopSeconds: 2,
      digitalConditions: [FALLING_D0],
    },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'waiting' }),
  });
  check(
    'pending lists exactly the changed settings that did not apply live',
    result.ok &&
      result.pending.length === 2 &&
      result.pending[0] === 'samplerate' &&
      result.pending[1] === 'loopSeconds',
    result.ok ? `pending=${result.pending.join(',')}` : failDetail(result),
  );
  check(
    'a mixed live+restart patch keeps staged values out of applied',
    result.ok &&
      result.applied.samplerate === current.samplerate &&
      result.applied.loopSeconds === current.loopSeconds &&
      result.next.samplerate === 10e6 &&
      result.next.loopSeconds === 2,
    result.ok
      ? `applied=${result.applied.samplerate}/${result.applied.loopSeconds} ` +
        `next=${result.next.samplerate}/${result.next.loopSeconds}`
      : failDetail(result),
  );
  check(
    'a waiting trigger condition edit retunes the active plan live',
    result.ok &&
      result.activePlan !== null &&
      result.activePlan.conditions[0]?.mode === 'falling' &&
      result.effects.includes('apply-live') &&
      result.effects.includes('restart-required') &&
      result.effects.includes('recompile-trigger'),
    failDetail(result),
  );
  check(
    'the next plan is compiled from the canonical pending configuration',
    result.ok && result.nextPlan !== null,
    failDetail(result),
  );
}

{
  const current = baseConfig({
    triggerEnableMask: true,
    digitalConditions: [RISING_D0],
  });
  const result = commitSettings({
    current,
    patch: { digitalConditions: [FALLING_D0] },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'running', triggerMatched: true }),
  });
  check(
    'a trigger edit after a match stays pending and leaves the active plan alone',
    result.ok &&
      result.pending.includes('digitalConditions') &&
      result.applied.digitalConditions[0]?.kind === 'rising' &&
      result.activePlan !== null &&
      result.activePlan.conditions[0]?.mode === 'rising' &&
      result.nextPlan !== null &&
      result.nextPlan.conditions[0]?.mode === 'falling',
    failDetail(result),
  );
  check(
    'a trigger edit after a match declares no recompile-trigger',
    result.ok && !result.effects.includes('recompile-trigger'),
    result.ok ? `effects=${result.effects.join(',')}` : failDetail(result),
  );
}

{
  const current = baseConfig({
    triggerEnableMask: true,
    digitalConditions: [RISING_D0],
  });
  const result = commitSettings({
    current,
    patch: { durationSeconds: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'running' }),
  });
  check(
    'a pending duration keeps the active plan on the current budget',
    result.ok &&
      result.pending.includes('durationSeconds') &&
      result.applied.durationSeconds === 1 &&
      result.activePlan !== null &&
      result.activePlan.budget.kind === 'time' &&
      result.activePlan.budget.value === 1,
    failDetail(result),
  );
  check(
    'a pending duration refreshes only the next plan and does not recompile',
    result.ok &&
      result.nextPlan !== null &&
      result.nextPlan.budget.kind === 'time' &&
      result.nextPlan.budget.value === 2 &&
      !result.effects.includes('recompile-trigger'),
    result.ok ? `effects=${result.effects.join(',')}` : failDetail(result),
  );

  const loopCurrent = baseConfig({
    mode: 'loop',
    triggerEnableMask: true,
    digitalConditions: [RISING_D0],
  });
  const loopPending = commitSettings({
    current: loopCurrent,
    patch: { loopSeconds: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'running', mode: 'loop' }),
  });
  check(
    'a pending Loop window keeps the active plan on the current window',
    loopPending.ok &&
      loopPending.pending.includes('loopSeconds') &&
      loopPending.activePlan?.loop?.seconds === 1 &&
      loopPending.nextPlan?.loop?.seconds === 2 &&
      !loopPending.effects.includes('recompile-trigger'),
    failDetail(loopPending),
  );
}

{
  const current = baseConfig({
    triggerEnableMask: true,
    digitalConditions: [RISING_D0],
  });
  const result = commitSettings({
    current,
    patch: { triggerEnableMask: false },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'waiting' }),
  });
  check(
    'turning the mask off while waiting disarms the active trigger',
    result.ok &&
      result.applied.triggerEnableMask === false &&
      result.activePlan === null &&
      result.nextPlan === null &&
      result.effects.includes('disarm-trigger') &&
      !result.effects.includes('recompile-trigger'),
    failDetail(result),
  );
}

{
  const result = commitSettings({
    current: baseConfig(),
    patch: { triggerEnableMask: true, digitalConditions: [] },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'an armed mask with no conditions is a trigger-plan refusal',
    !result.ok &&
      result.reason === 'trigger-plan' &&
      result.field === 'digitalConditions' &&
      result.detail.includes('no-conditions'),
    failDetail(result),
  );
}

// ---------------------------------------------------------------------------
// Mode-specific budgets and clamps
// ---------------------------------------------------------------------------

{
  const result = commitSettings({
    current: baseConfig(),
    patch: {
      mode: 'loop',
      loopSeconds: 2,
      triggerEnableMask: true,
      digitalConditions: [{ signal: 'd0', kind: 'edge' }],
    },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a Loop plan uses the loop window, an unlimited budget and a trigger anchor',
    result.ok &&
      result.nextPlan !== null &&
      result.nextPlan.loop?.seconds === 2 &&
      result.nextPlan.loop.anchor === 'trigger' &&
      result.nextPlan.budget.kind === 'unlimited' &&
      result.nextPlan.preTrigger.seconds > 0,
    failDetail(result),
  );

  const huge = commitSettings({
    current: baseConfig({ mode: 'loop' }),
    patch: { loopSeconds: 1e9 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  const expectedMaxSeconds = (2 ** 30) / 16e6;
  check(
    'a Loop window is clamped to the host retention budget',
    huge.ok && Math.abs(huge.next.loopSeconds - expectedMaxSeconds) < 1e-9,
    huge.ok ? `loopSeconds=${huge.next.loopSeconds}` : failDetail(huge),
  );
}

{
  const result = commitSettings({
    current: baseConfig({ unlimited: true }),
    patch: { triggerEnableMask: true, digitalConditions: [RISING_D0] },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'an unlimited Single capture still derives a bounded pre-trigger window',
    result.ok &&
      result.nextPlan !== null &&
      result.nextPlan.budget.kind === 'unlimited' &&
      result.nextPlan.preTrigger.seconds > 0,
    failDetail(result),
  );
}

{
  const result = commitSettings({
    current: baseConfig(),
    patch: { preTriggerPercent: 150 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a pre-trigger percentage above the profile cap is clamped',
    result.ok && result.next.preTriggerPercent === 75,
    failDetail(result),
  );

  const negative = commitSettings({
    current: baseConfig(),
    patch: { preTriggerPercent: -1 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a negative pre-trigger percentage is invalid-value',
    !negative.ok &&
      negative.reason === 'invalid-value' &&
      negative.field === 'preTriggerPercent',
    failDetail(negative),
  );
}

// ---------------------------------------------------------------------------
// Total budget envelope (post-trigger + pre-trigger)
// ---------------------------------------------------------------------------

{
  const maxTotal = MAX_SAMPLES - 1;
  const samplerate = 16e6;

  const at75 = commitSettings({
    current: baseConfig({ preTriggerPercent: 75 }),
    patch: { durationSeconds: 1e9 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  const post75 = at75.ok ? Math.round(at75.next.durationSeconds * samplerate) : -1;
  const pre75 = post75 >= 0 ? Math.floor((post75 * 75) / 100) : -1;
  check(
    'a 75% pre-trigger duration clamps so post + pre fits MAX_SAMPLES - 1',
    at75.ok && post75 + pre75 <= maxTotal,
    at75.ok ? `post=${post75} pre=${pre75}` : failDetail(at75),
  );
  check(
    'the 75% clamp keeps the largest duration that still fits',
    at75.ok &&
      post75 + 1 + Math.floor(((post75 + 1) * 75) / 100) > maxTotal,
    at75.ok ? `post=${post75}` : failDetail(at75),
  );

  const profile100 = makeProfile({ preTriggerMaxPercent: 100 });
  const at100 = commitSettings({
    current: baseConfig({ preTriggerPercent: 100 }),
    patch: { durationSeconds: 1e9 },
    profile: profile100,
    linkRate: 'ss5',
    context: ctx(),
  });
  const post100 = at100.ok ? Math.round(at100.next.durationSeconds * samplerate) : -1;
  const pre100 = post100 >= 0 ? Math.floor((post100 * 100) / 100) : -1;
  check(
    'a 100% pre-trigger duration clamps so post + pre fits MAX_SAMPLES - 1',
    at100.ok && post100 + pre100 <= maxTotal,
    at100.ok ? `post=${post100} pre=${pre100}` : failDetail(at100),
  );
  check(
    'the 100% clamp keeps the largest duration that still fits',
    at100.ok &&
      post100 + 1 + Math.floor(((post100 + 1) * 100) / 100) > maxTotal,
    at100.ok ? `post=${post100}` : failDetail(at100),
  );

  const armed75 = commitSettings({
    current: baseConfig({ preTriggerPercent: 75, durationSeconds: 1e9 }),
    patch: { triggerEnableMask: true, digitalConditions: [RISING_D0] },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  const plan75 = armed75.ok ? armed75.nextPlan : null;
  const planPost75 = plan75 !== null && plan75.budget.kind === 'time'
    ? Math.round(plan75.budget.value * samplerate)
    : -1;
  const planPre75 = plan75 === null
    ? -1
    : (plan75.preTrigger.samples ?? Math.round(plan75.preTrigger.seconds * samplerate));
  check(
    'the compiled 75% plan keeps its retained prefix and budget in the envelope',
    planPre75 >= 0 && planPost75 >= 0 && planPre75 + planPost75 <= maxTotal,
    `post=${planPost75} pre=${planPre75}`,
  );

  const unlimited100 = commitSettings({
    current: baseConfig({ preTriggerPercent: 100, unlimited: true }),
    patch: { triggerEnableMask: true, digitalConditions: [RISING_D0] },
    profile: profile100,
    linkRate: 'ss5',
    context: ctx(),
  });
  const unlimitedPlan = unlimited100.ok ? unlimited100.nextPlan : null;
  const unlimitedPre = unlimitedPlan === null
    ? -1
    : (unlimitedPlan.preTrigger.samples ??
      Math.round(unlimitedPlan.preTrigger.seconds * samplerate));
  const unlimitedBase = Math.floor(maxTotal / 2);
  check(
    'an unlimited Single base plus its 100% prefix fits MAX_SAMPLES - 1',
    unlimitedPre >= 0 && unlimitedBase + unlimitedPre <= maxTotal,
    `base=${unlimitedBase} pre=${unlimitedPre}`,
  );
}

// ---------------------------------------------------------------------------
// Duration carry across mode changes
// ---------------------------------------------------------------------------

{
  const single = baseConfig({ durationSeconds: 0.25 });

  const toLoop = commitSettings({
    current: single,
    patch: { mode: 'loop' },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'Single -> Loop carries the duration into the Loop window',
    toLoop.ok &&
      toLoop.next.loopSeconds === 0.25 &&
      toLoop.next.durationSeconds === 0.25 &&
      toLoop.applied.loopSeconds === single.loopSeconds,
    failDetail(toLoop),
  );

  const loop = baseConfig({ mode: 'loop', loopSeconds: 0.5 });
  const toSingle = commitSettings({
    current: loop,
    patch: { mode: 'single' },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'Loop -> Single carries the Loop window into the duration',
    toSingle.ok &&
      toSingle.next.durationSeconds === 0.5 &&
      toSingle.next.loopSeconds === 0.5,
    failDetail(toSingle),
  );

  const explicitLoop = commitSettings({
    current: single,
    patch: { mode: 'loop', loopSeconds: 3 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'an explicit loopSeconds patch wins over the carried duration',
    explicitLoop.ok && explicitLoop.next.loopSeconds === 3,
    failDetail(explicitLoop),
  );

  const explicitDuration = commitSettings({
    current: single,
    patch: { mode: 'loop', durationSeconds: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'an explicit durationSeconds patch wins over the carried duration',
    explicitDuration.ok &&
      explicitDuration.next.loopSeconds === 2 &&
      explicitDuration.next.durationSeconds === 2,
    failDetail(explicitDuration),
  );

  const explicitOut = commitSettings({
    current: loop,
    patch: { mode: 'single', durationSeconds: 4 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'an explicit durationSeconds patch wins when leaving Loop',
    explicitOut.ok && explicitOut.next.durationSeconds === 4,
    failDetail(explicitOut),
  );

  const rateCarry = commitSettings({
    current: single,
    patch: { mode: 'loop', samplerate: 8e6 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a rate change keeps the carried window in seconds',
    rateCarry.ok &&
      rateCarry.next.samplerate === 8e6 &&
      rateCarry.next.loopSeconds === 0.25,
    failDetail(rateCarry),
  );
}

// ---------------------------------------------------------------------------
// Mixed trigger family
// ---------------------------------------------------------------------------

{
  const mixed = commitSettings({
    current: baseConfig(),
    patch: {
      triggerEnableMask: true,
      triggerSource: 'mixed',
      digitalConditions: [RISING_D0],
      analogConditions: [{ signal: 'a0', kind: 'falling', volts: 1 }],
    },
    profile: PROFILE_32U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a mixed-capable profile compiles a mixed next plan',
    mixed.ok && mixed.nextPlan !== null && mixed.nextPlan.source === 'mixed',
    failDetail(mixed),
  );

  const refused = commitSettings({
    current: baseConfig(),
    patch: {
      triggerEnableMask: true,
      triggerSource: 'mixed',
      digitalConditions: [RISING_D0],
      analogConditions: [{ signal: 'a0', kind: 'falling', volts: 1 }],
    },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx(),
  });
  check(
    'a profile without mixed support refuses with trigger-plan/triggerSource',
    !refused.ok &&
      refused.reason === 'trigger-plan' &&
      refused.field === 'triggerSource' &&
      refused.detail.includes('mixed-unsupported'),
    failDetail(refused),
  );
}

// ---------------------------------------------------------------------------
// Policy table contract and determinism
// ---------------------------------------------------------------------------

{
  const configKeys = Object.keys(baseConfig()).sort();
  const policyKeys = Object.keys(SETTING_POLICIES).sort();
  check(
    'SETTING_POLICIES covers exactly the CaptureConfig keys',
    configKeys.length === policyKeys.length &&
      configKeys.every((key, index) => key === policyKeys[index]),
    `config=${configKeys.join(',')} policies=${policyKeys.join(',')}`,
  );

  const scopes: readonly SettingScope[] = ['live', 'next', 'view', 'preference'];
  let policiesValid = true;
  for (const key of SETTING_KEYS) {
    const policy = SETTING_POLICIES[key];
    if (!scopes.includes(policy.scope)) policiesValid = false;
    if (SETTING_EDIT_FEATURES[key] === undefined) policiesValid = false;
  }
  check('every policy has a valid scope and an edit-feature mapping', policiesValid);
  check(
    'the canonical key list has no duplicates',
    new Set(SETTING_KEYS).size === SETTING_KEYS.length,
  );
  check(
    'record is not a settings key and its effects are gone',
    !(SETTING_KEYS as readonly string[]).includes('record') &&
      !(SETTINGS_EFFECTS as readonly string[]).includes('arm-record') &&
      !(SETTINGS_EFFECTS as readonly string[]).includes('disarm-record'),
    `keys=${SETTING_KEYS.join(',')} effects=${SETTINGS_EFFECTS.join(',')}`,
  );
  check(
    'disarm-trigger is a declared settings effect',
    SETTINGS_EFFECTS.includes('disarm-trigger'),
  );
}

{
  const input = {
    current: baseConfig({ triggerEnableMask: true, digitalConditions: [RISING_D0] }),
    patch: { samplerate: 20e6, durationSeconds: 2 },
    profile: PROFILE_16U3,
    linkRate: 'ss5',
    context: ctx({ acquisition: 'waiting' }),
  } as const;
  const first = commitSettings(input);
  const second = commitSettings(input);
  check(
    'the same input produces a byte-identical result',
    JSON.stringify(first) === JSON.stringify(second),
  );
}

console.log(
  `\n${failures === 0
    ? 'all settings transaction checks passed'
    : `${failures} settings transaction check(s) FAILED`}`,
);
if (failures > 0) failExit();
