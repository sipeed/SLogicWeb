// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic self-test for the M0 TriggerPlan compiler.
 *
 * Run with:
 *   node_modules/.bin/esbuild src/dsp/triggerPlanSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/triggerplan-selftest.mjs --log-level=error \
 *     && node /tmp/triggerplan-selftest.mjs
 *
 * The fake profiles below model the P0 32U3-like capability set (single digital or
 * single analog family) and a P1 mixed profile. No device, DOM or storage is involved.
 */

import type {
  AnalogTriggerKind,
  DeviceProfile,
  TriggerKind,
} from '../device/profileTypes.js';
import {
  compileTriggerPlan,
  type TriggerPlanInput,
  type TriggerPlanResult,
} from './triggerPlan.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function failDetail(result: TriggerPlanResult): string {
  return result.ok ? 'compiled unexpectedly' : `${result.reason}: ${result.detail}`;
}

const ALL_DIGITAL: readonly TriggerKind[] = [
  'level', 'rising', 'falling', 'edge', 'high', 'low',
];
const ALL_ANALOG: readonly AnalogTriggerKind[] = ['rising', 'falling'];

interface ProfileOptions {
  execution?: 'device' | 'host';
  mixed?: boolean;
  digital?: readonly TriggerKind[];
  analog?: readonly AnalogTriggerKind[];
  preTriggerMaxPercent?: number;
  preTriggerMaxBytes?: number;
  loop?: boolean;
  analogRanges?: readonly number[];
  analogGroups?: boolean;
}

function makeProfile(id: string, options: ProfileOptions = {}): DeviceProfile {
  return {
    id,
    name: `Fake ${id}`,
    vid: 0x1d50,
    pid: 0x6018,
    link: {
      interfaceClass: 0xff,
      endpoints: { in: 1, out: 2 },
      maxTransferBytes: 262_144,
      rates: ['ss'],
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
      groups: options.analogGroups === false
        ? []
        : [{
          start: 0,
          channels: 8,
          ranges: options.analogRanges ?? [1, 5, 15],
          resolutionBits: 8,
          maxHz: {},
        }],
      calibration: { id: 'fake-cal', version: 1 },
    },
    trigger: {
      execution: options.execution ?? 'host',
      digital: options.digital ?? ALL_DIGITAL,
      analog: options.analog ?? ALL_ANALOG,
      mixed: options.mixed ?? false,
      preTriggerMaxPercent: options.preTriggerMaxPercent ?? 75,
      preTriggerMaxBytes: options.preTriggerMaxBytes ?? 64 * 1024 * 1024,
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

function makeInput(
  profile: DeviceProfile,
  overrides: Partial<TriggerPlanInput> = {},
): TriggerPlanInput {
  return {
    profile,
    enableMask: true,
    source: 'digital',
    digital: [],
    analog: [],
    preTriggerPercent: 10,
    postTrigger: { kind: 'time', value: 1 },
    compiledAt: 42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------
// P0 mixed rule and source filtering
// ---------------------------------------------------------------------------------

{
  const p0 = makeProfile('p0-32u3');
  const result = compileTriggerPlan(makeInput(p0, {
    source: 'mixed',
    digital: [{ signal: 'd0', kind: 'rising' }],
    analog: [{ signal: 'a0', kind: 'rising', volts: 1 }],
  }));
  check(
    'P0 profile rejects a mixed digital+analog request',
    !result.ok && result.reason === 'mixed-unsupported',
    failDetail(result),
  );
}

{
  const p1 = makeProfile('p1-32u3', { mixed: true });
  const result = compileTriggerPlan(makeInput(p1, {
    source: 'mixed',
    digital: [{ signal: 'd0', kind: 'rising' }],
    analog: [{ signal: 'a0', kind: 'rising', volts: 1, hysteresis: 0.1 }],
  }));
  check(
    'mixed-capable profile accepts mixed conditions as one ANDed plan',
    result.ok && result.plan.source === 'mixed' && result.plan.conditions.length === 2,
    failDetail(result),
  );
}

{
  // A mixed request is a request for a capability, not a statement about the current
  // non-empty arrays: P0 must refuse it even if only digital happens to be configured.
  const p0 = makeProfile('p0-32u3');
  const result = compileTriggerPlan(makeInput(p0, {
    source: 'mixed',
    digital: [{ signal: 'd0', kind: 'rising' }],
  }));
  check(
    'P0 profile rejects source=mixed even with only digital conditions',
    !result.ok && result.reason === 'mixed-unsupported',
    failDetail(result),
  );
}

{
  const p0 = makeProfile('p0-32u3');
  const result = compileTriggerPlan(makeInput(p0, {
    source: 'digital',
    digital: [{ signal: 'd0', kind: 'rising' }],
    // Stored analog conditions are not armed when the digital family is selected.
    analog: [{ signal: 'a0', kind: 'sideways' as AnalogTriggerKind, volts: 1 }],
  }));
  check(
    'source=digital ignores the stored-but-unarmed analog family',
    result.ok && result.plan.source === 'digital' && result.plan.conditions.length === 1,
    failDetail(result),
  );
}

{
  const p0 = makeProfile('p0-32u3');
  const result = compileTriggerPlan(makeInput(p0, {
    source: 'analog',
    digital: [{ signal: 'd0', kind: 'not-a-kind' as TriggerKind }],
    analog: [{ signal: 'a0', kind: 'falling', volts: 2.5 }],
  }));
  check(
    'source=analog ignores the stored-but-unarmed digital family',
    result.ok && result.plan.source === 'analog' && result.plan.conditions.length === 1,
    failDetail(result),
  );
}

// ---------------------------------------------------------------------------------
// Mask and effective conditions
// ---------------------------------------------------------------------------------

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    enableMask: false,
    digital: [{ signal: 'd0', kind: 'rising' }],
  }));
  check(
    'mask off yields mask-off and never arms stored conditions',
    !result.ok && result.reason === 'mask-off',
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3')));
  check(
    'mask on without an effective condition yields no-conditions',
    !result.ok && result.reason === 'no-conditions',
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    source: 'digital',
    digital: [],
    analog: [{ signal: 'a0', kind: 'rising', volts: 1 }],
  }));
  check(
    'conditions outside the selected source leave no effective condition',
    !result.ok && result.reason === 'no-conditions',
    failDetail(result),
  );
}

// ---------------------------------------------------------------------------------
// Single-family acceptance, execution owner and condition shape
// ---------------------------------------------------------------------------------

{
  const profile = makeProfile('p0-32u3');
  const result = compileTriggerPlan(makeInput(profile, {
    source: 'digital',
    digital: [{ signal: 'd3', kind: 'rising' }],
    preTriggerPercent: 10,
    postTrigger: { kind: 'time', value: 1 },
    capture: { samplerate: 1e6, channels: 16 },
  }));
  const plan = result.ok ? result.plan : null;
  check(
    '32U3-like profile accepts a single digital condition',
    plan !== null &&
      plan.source === 'digital' &&
      plan.execution === 'host' &&
      plan.conditions.length === 1 &&
      plan.conditions[0]!.kind === 'digital' &&
      plan.conditions[0]!.signal === 'd3' &&
      plan.conditions[0]!.mode === 'rising',
    failDetail(result),
  );
  check(
    'digital plan has the configured budget, a sample-aligned pre-trigger and the byte cap',
    plan !== null &&
      plan.budget.kind === 'time' && plan.budget.value === 1 &&
      plan.preTrigger.percent === 10 &&
      plan.preTrigger.seconds === 0.1 &&
      plan.preTrigger.capBytes === 200_000 &&
      plan.compiledAt === 42,
    plan === null ? failDetail(result) : JSON.stringify(plan.preTrigger),
  );
}

{
  const profile = makeProfile('p0-32u3');
  const result = compileTriggerPlan(makeInput(profile, {
    source: 'analog',
    analog: [{ signal: 'a0', kind: 'falling', volts: 2.5, hysteresis: 0.1 }],
    preTriggerPercent: 25,
    postTrigger: { kind: 'time', value: 2 },
    capture: { samplerate: 1e6, channels: 16 },
  }));
  const plan = result.ok ? result.plan : null;
  const condition = plan?.conditions[0];
  check(
    '32U3-like profile accepts a single analog condition with hysteresis',
    plan !== null &&
      plan.source === 'analog' &&
      condition !== undefined &&
      condition.kind === 'analog' &&
      condition.signal === 'a0' &&
      condition.mode === 'falling' &&
      condition.volts === 2.5 &&
      condition.hysteresis === 0.1,
    failDetail(result),
  );
  check(
    'analog plan derives pre-trigger seconds and bytes from the rate',
    plan !== null &&
      plan.preTrigger.percent === 25 &&
      plan.preTrigger.seconds === 0.5 &&
      plan.preTrigger.capBytes === 1_000_000,
    plan === null ? failDetail(result) : JSON.stringify(plan.preTrigger),
  );
}

{
  const device = makeProfile('device-32u3', { execution: 'device' });
  const result = compileTriggerPlan(makeInput(device, {
    digital: [{ signal: 'd0', kind: 'edge' }],
  }));
  check(
    'execution is copied from the profile',
    result.ok && result.plan.execution === 'device',
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3', { digital: ['level', 'rising'] });
  const polarity = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd1', kind: 'level', level: 0 }],
  }));
  const defaulted = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd2', kind: 'level' }],
  }));
  check(
    'a plain level condition carries its polarity, defaulting to high',
    polarity.ok &&
      polarity.plan.conditions[0]!.kind === 'digital' &&
      polarity.plan.conditions[0]!.mode === 'level' &&
      polarity.plan.conditions[0]!.level === 0 &&
      defaulted.ok &&
      defaulted.plan.conditions[0]!.kind === 'digital' &&
      defaulted.plan.conditions[0]!.level === 1,
    failDetail(polarity.ok ? defaulted : polarity),
  );
}

// ---------------------------------------------------------------------------------
// Capability refusals
// ---------------------------------------------------------------------------------

{
  const profile = makeProfile('p0-32u3', { digital: ['rising'] });
  const result = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'falling' }],
  }));
  check(
    'an unsupported digital kind is refused',
    !result.ok && result.reason === 'unsupported-digital',
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3', { analog: [] });
  const result = compileTriggerPlan(makeInput(profile, {
    source: 'analog',
    analog: [{ signal: 'a0', kind: 'rising', volts: 1 }],
  }));
  check(
    'an unsupported analog kind is refused',
    !result.ok && result.reason === 'unsupported-analog',
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3', { analogGroups: false });
  const result = compileTriggerPlan(makeInput(profile, {
    source: 'analog',
    analog: [{ signal: 'a0', kind: 'rising', volts: 1 }],
  }));
  check(
    'analog conditions on a profile with no analog groups are refused',
    !result.ok && result.reason === 'unsupported-analog',
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3', { analogRanges: [1] });
  const result = compileTriggerPlan(makeInput(profile, {
    source: 'analog',
    analog: [{ signal: 'a0', kind: 'rising', volts: 2.5 }],
  }));
  check(
    'an analog level beyond every full-scale range is refused',
    !result.ok && result.reason === 'unsupported-analog',
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3', { digital: ['low'] });
  const viaLow = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'level', level: 0 }],
  }));
  const viaHigh = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'level', level: 1 }],
  }));
  check(
    'level polarity is checked through the equivalent high/low capability',
    viaLow.ok && !viaHigh.ok && viaHigh.reason === 'unsupported-digital',
    `low=${failDetail(viaLow)} high=${failDetail(viaHigh)}`,
  );
}

// ---------------------------------------------------------------------------------
// Budget validation and pre-trigger derivation
// ---------------------------------------------------------------------------------

{
  const samplesZero = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'samples', value: 0 },
  }));
  const timeNaN = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'time', value: Number.NaN },
  }));
  const badKind = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'bogus' } as unknown as TriggerPlanInput['postTrigger'],
  }));
  check(
    'malformed budgets are refused as invalid-budget',
    !samplesZero.ok && samplesZero.reason === 'invalid-budget' &&
      !timeNaN.ok && timeNaN.reason === 'invalid-budget' &&
      !badKind.ok && badKind.reason === 'invalid-budget',
    `${failDetail(samplesZero)}; ${failDetail(timeNaN)}; ${failDetail(badKind)}`,
  );
}

{
  // A samples budget without rate/width cannot state preTrigger.seconds and has no
  // honest fallback; the caller must supply the retain window duration.
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'samples', value: 1000 },
  }));
  check(
    'a samples budget without capture or retentionSeconds is refused',
    !result.ok && result.reason === 'invalid-budget',
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'samples', value: 1000 },
    retentionSeconds: 0.001,
    preTriggerPercent: 10,
  }));
  check(
    'retentionSeconds supplies the duration for a samples budget without capture',
    result.ok &&
      result.plan.preTrigger.percent === 10 &&
      result.plan.preTrigger.seconds === 0.0001 &&
      result.plan.budget.kind === 'samples' &&
      result.plan.budget.value === 1000,
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'samples', value: 1000 },
    capture: { samplerate: 1e6, channels: 16 },
    preTriggerPercent: 10,
  }));
  check(
    'capture derives sample-quantized pre-trigger seconds for a samples budget',
    result.ok &&
      result.plan.preTrigger.percent === 10 &&
      result.plan.preTrigger.seconds === 0.0001 &&
      result.plan.preTrigger.capBytes === 200,
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3');
  const result = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'unlimited' },
    loop: { seconds: 1, anchor: 'trigger' },
    preTriggerPercent: 10,
    capture: { samplerate: 1e6, channels: 16 },
  }));
  check(
    'an unlimited Loop budget uses loop.seconds as the pre-trigger base',
    result.ok &&
      result.plan.budget.kind === 'unlimited' &&
      result.plan.loop !== undefined &&
      result.plan.loop.anchor === 'trigger' &&
      result.plan.preTrigger.seconds === 0.1 &&
      result.plan.preTrigger.capBytes === 200_000,
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'unlimited' },
    preTriggerPercent: 10,
  }));
  check(
    'an unlimited budget without a duration is refused for a non-zero percent',
    !result.ok && result.reason === 'invalid-budget',
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'samples', value: 1000 },
    preTriggerPercent: 0,
  }));
  check(
    'a zero percent needs no retention length and yields an empty prefix',
    result.ok &&
      result.plan.preTrigger.percent === 0 &&
      result.plan.preTrigger.seconds === 0 &&
      result.plan.preTrigger.capBytes === 0,
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'time', value: 1 },
    retentionSeconds: 2,
  }));
  check(
    'retentionSeconds contradicting the time budget is refused',
    !result.ok && result.reason === 'invalid-budget',
    failDetail(result),
  );
}

// ---------------------------------------------------------------------------------
// Pre-trigger caps: clamp, never silently promise history
// ---------------------------------------------------------------------------------

{
  const profile = makeProfile('p0-32u3', { preTriggerMaxPercent: 10 });
  const result = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'rising' }],
    preTriggerPercent: 50,
    postTrigger: { kind: 'time', value: 1 },
    capture: { samplerate: 1e6, channels: 16 },
  }));
  check(
    'the profile percent cap clamps the requested pre-trigger fraction',
    result.ok &&
      result.plan.preTrigger.percent === 10 &&
      result.plan.preTrigger.seconds === 0.1,
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3', {
    preTriggerMaxPercent: 75,
    preTriggerMaxBytes: 1000,
  });
  const result = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'rising' }],
    preTriggerPercent: 75,
    postTrigger: { kind: 'time', value: 1 },
    capture: { samplerate: 1000, channels: 16 },
  }));
  // 1 s at 16 channels is 2000 B, so 1000 B is 50%.
  check(
    'the profile byte cap clamps percent and capBytes reports the real prefix',
    result.ok &&
      result.plan.preTrigger.percent === 50 &&
      result.plan.preTrigger.seconds === 0.5 &&
      result.plan.preTrigger.capBytes === 1000,
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3', {
    preTriggerMaxPercent: 75,
    preTriggerMaxBytes: 1000,
  });
  const result = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'rising' }],
    preTriggerPercent: 75,
    postTrigger: { kind: 'samples', value: 1000 },
    capture: { samplerate: 1e6, channels: 16 },
  }));
  // 1000 samples x 2 B = 2000 B; the cap keeps 500 samples (50%).
  check(
    'the byte cap clamps a samples budget to a whole number of samples',
    result.ok &&
      result.plan.preTrigger.percent === 50 &&
      result.plan.preTrigger.seconds === 0.0005 &&
      result.plan.preTrigger.capBytes === 1000,
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    preTriggerPercent: -1,
  }));
  check(
    'a malformed pre-trigger percent is refused as pre-trigger-cap',
    !result.ok && result.reason === 'pre-trigger-cap',
    failDetail(result),
  );
}

{
  const result = compileTriggerPlan(makeInput(makeProfile('p0-32u3'), {
    digital: [{ signal: 'd0', kind: 'rising' }],
    preTriggerPercent: Number.POSITIVE_INFINITY,
  }));
  check(
    'a non-finite pre-trigger percent is refused as pre-trigger-cap',
    !result.ok && result.reason === 'pre-trigger-cap',
    failDetail(result),
  );
}

// ---------------------------------------------------------------------------------
// Loop mode and immutability
// ---------------------------------------------------------------------------------

{
  const profile = makeProfile('p0-32u3', { loop: false });
  const result = compileTriggerPlan(makeInput(profile, {
    digital: [{ signal: 'd0', kind: 'rising' }],
    postTrigger: { kind: 'time', value: 1 },
    loop: { seconds: 1, anchor: 'free' },
  }));
  check(
    'a Loop plan on a profile without Loop support is refused as unsupported-mode',
    !result.ok && result.reason === 'unsupported-mode',
    failDetail(result),
  );
}

{
  const profile = makeProfile('p0-32u3');
  const postTrigger = { kind: 'time' as const, value: 1 };
  const digital = [{ signal: 'd0', kind: 'rising' as const }];
  const result = compileTriggerPlan(makeInput(profile, {
    digital,
    postTrigger,
  }));
  check(
    'the compiler copies the budget and conditions instead of aliasing its input',
    result.ok &&
      result.plan.budget !== postTrigger &&
      result.plan.conditions !== (digital as readonly unknown[]) &&
      result.plan.budget.kind === 'time' &&
      result.plan.budget.value === 1,
    failDetail(result),
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
  `triggerPlan selftest: ${results.length - failures.length}/${results.length} passed`,
);
if (failures.length > 0) {
  throw new Error(`${failures.length} triggerPlan selftest check(s) failed`);
}
