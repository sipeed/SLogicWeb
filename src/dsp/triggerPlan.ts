// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M0 TriggerPlan compiler (docs/ARCHITECTURE.md §5.1).
 *
 * One pure function turns the requested trigger configuration into the single plan that
 * drives device and host execution. The compiler owns the P0 single-family rule, the
 * profile capability check, budget validation and the effective pre-trigger window; it
 * never touches a device, the DOM or the UI state.
 *
 * ## Pre-trigger units
 *
 * `preTriggerPercent` is a fraction of the requested post-trigger budget, matching the
 * acquisition path today (`capturePostTriggerSamples()` then
 * `floor(post * percent / 100)`), and of the Loop window in Loop mode. That base window
 * is either derivable from `postTrigger` (`time`, or `samples` together with `capture`)
 * or must be supplied as `retentionSeconds` (or `loop.seconds` for a Loop plan). When
 * neither a duration nor `capture` is supplied an unlimited/samples plan cannot state
 * `preTrigger.seconds`; the compiler refuses it with `invalid-budget` instead of
 * inventing a value.
 *
 * `preTrigger.capBytes` is the effective byte position of T in the retained stream, as
 * §5.1 describes it. It is the whole-sample prefix this plan may retain, clamped by the
 * profile's `preTriggerMaxBytes`. When bytes cannot be derived (no `capture`), the
 * profile's hard byte cap is reported instead and `capBytesIsBound` is true: it is then
 * an upper bound, not T's position.
 *
 * A Loop plan owns an unbounded window, so `loop` is accepted only with an `unlimited`
 * post-trigger budget; the pre-trigger percentage applies to `loop.seconds`.
 *
 * `preTrigger.samples` is the exact whole-sample prefix whenever the compiler knows it:
 * the budget itself is in samples, or `capture` gives the rate and width. It is the
 * authoritative value for consumers (the SimDriver and the host matcher); `seconds` is a
 * float and a `seconds * samplerate` round-trip may land one sample short, so no consumer
 * should recover the count by flooring that product. It is omitted when only a duration
 * is known (time budget with no capture) because no exact sample count exists then.
 *
 * ## Caps: clamp, do not refuse
 *
 * A request above `profile.trigger.preTriggerMaxPercent`, above the byte cap (when
 * `capture` makes it derivable), or at/above the post-trigger base (the historic
 * `post - 1` rule) is clamped, and the plan reports the effective values. The UI already
 * presents this as "up to" history (DESIGN.md §8). `pre-trigger-cap` is reserved for a
 * malformed request (non-finite or negative percent), never for a request that can be
 * compiled by reducing it.
 *
 * ## Budget
 *
 * `TriggerPlanInput.postTrigger` is the requested post-trigger budget and is echoed as
 * `TriggerPlan.budget` unchanged. The acquisition layer adds the retained prefix to the
 * total store limit, exactly as the current `captureLimitSamples = post + pre` path does.
 *
 * This file deliberately imports only types and no runtime module, so it is safe to
 * use in the host executor, a worker or a deterministic self-test.
 */

import type {
  AnalogTriggerKind,
  DeviceProfile,
  TriggerKind,
} from '../device/profileTypes.js';
import type { ChannelCount } from '../types.js';

export type TriggerSource = 'digital' | 'analog' | 'mixed';

export type TriggerBudget =
  | { kind: 'samples'; value: number }
  | { kind: 'time'; value: number }
  | { kind: 'unlimited' };

/**
 * A single ANDed condition on one complete sample.
 *
 * `mode` is the requested `TriggerKind`. For `mode: 'level'` the optional `level` field
 * carries the polarity (default 1 / high), because the architecture's condition type
 * alone cannot express a plain level condition. `high` and `low` already carry it in
 * `mode`. `hysteresis` is in volts and defaults to zero.
 */
export type TriggerCondition =
  | { kind: 'digital'; signal: string; mode: TriggerKind; level?: 0 | 1 }
  | {
    kind: 'analog';
    signal: string;
    mode: AnalogTriggerKind;
    volts: number;
    hysteresis?: number;
  };

export interface TriggerPlanLoop {
  seconds: number;
  anchor: 'trigger' | 'free';
}

/**
 * The effective pre-trigger window.
 *
 * `samples` is the exact whole-sample prefix when the compiler could derive it (the
 * budget is in samples, or `capture` states rate and width). Consumers must prefer it:
 * `seconds` is the float duration and `Math.floor(seconds * samplerate)` can lose a
 * whole sample to floating-point round-off. It is absent when only a duration is known.
 */
export interface TriggerPlanPreTrigger {
  percent: number;
  seconds: number;
  capBytes: number;
  samples?: number;
  /**
   * True when `capBytes` is only the profile's hard upper bound, not T's actual byte
   * position (no capture rate/width was supplied). Consumers must not treat it as a
   * position in that case.
   */
  capBytesIsBound?: boolean;
}

export interface TriggerPlan {
  source: TriggerSource;
  conditions: readonly TriggerCondition[];
  execution: 'device' | 'host';
  preTrigger: TriggerPlanPreTrigger;
  budget: TriggerBudget;
  loop?: TriggerPlanLoop;
  compiledAt: number;
}

/** Requested digital condition. `level` is only meaningful for `kind: 'level'`. */
export interface DigitalTriggerInput {
  signal: string;
  kind: TriggerKind;
  level?: 0 | 1;
}

/** Requested analog condition. `volts` and `hysteresis` are in volts. */
export interface AnalogTriggerInput {
  signal: string;
  kind: AnalogTriggerKind;
  volts: number;
  hysteresis?: number;
}

/**
 * Rate/width context. Supplying it lets the compiler derive
 * `preTrigger.seconds` from a samples budget and enforce `preTriggerMaxBytes`.
 * Without it a samples budget still compiles when `retentionSeconds` states the
 * window duration.
 */
export interface TriggerPlanCapture {
  samplerate: number;
  channels: ChannelCount;
}

export interface TriggerPlanInput {
  profile: DeviceProfile;
  /** Global enable mask. When false nothing is armed and compilation is refused. */
  enableMask: boolean;
  /** Requested family. Conditions of the other family are stored but not armed. */
  source: TriggerSource;
  digital: readonly DigitalTriggerInput[];
  analog: readonly AnalogTriggerInput[];
  /** Percent of `postTrigger` (or of the Loop window) retained before T. */
  preTriggerPercent: number;
  /** Requested post-trigger budget; the base the percentage applies to. */
  postTrigger: TriggerBudget;
  loop?: TriggerPlanLoop;
  /**
   * Duration of the retention window in seconds. It resolves the pre-trigger seconds
   * when `postTrigger` alone cannot (samples without `capture`, unlimited). If it is
   * supplied while the budget already implies a duration, the two must agree.
   */
  retentionSeconds?: number;
  capture?: TriggerPlanCapture;
  /** Deterministic clock override for tests; defaults to Date.now(). */
  compiledAt?: number;
}

export type TriggerPlanFailureReason =
  | 'mask-off'
  | 'no-conditions'
  | 'unsupported-digital'
  | 'unsupported-analog'
  | 'mixed-unsupported'
  | 'pre-trigger-cap'
  | 'invalid-budget'
  | 'unsupported-mode';

export type TriggerPlanResult =
  | { ok: true; plan: TriggerPlan }
  | { ok: false; reason: TriggerPlanFailureReason; detail: string };

export const TRIGGER_KINDS: readonly TriggerKind[] = [
  'level', 'rising', 'falling', 'edge', 'high', 'low',
];
const ANALOG_TRIGGER_KINDS: readonly AnalogTriggerKind[] = ['rising', 'falling'];
const CHANNEL_COUNTS: readonly ChannelCount[] = [4, 8, 16, 32, 64, 128];

function fail(reason: TriggerPlanFailureReason, detail: string): TriggerPlanResult {
  return { ok: false, reason, detail };
}

function isTriggerKind(value: unknown): value is TriggerKind {
  return TRIGGER_KINDS.includes(value as TriggerKind);
}

function isAnalogTriggerKind(value: unknown): value is AnalogTriggerKind {
  return ANALOG_TRIGGER_KINDS.includes(value as AnalogTriggerKind);
}

function isChannelCount(value: number): value is ChannelCount {
  return CHANNEL_COUNTS.includes(value as ChannelCount);
}

function bytesPerSampleForChannels(channels: ChannelCount): number {
  return Math.ceil(channels / 8);
}

function signalProblem(signal: unknown): string | null {
  if (typeof signal !== 'string' || signal.trim().length === 0) {
    return 'condition signal must be a non-empty string';
  }
  return null;
}

/**
 * A profile that can express one of `high`/`low` can express the equivalent `level`
 * polarity, and a profile with generic `level` support also supports `high`/`low`.
 * Capability lists are otherwise checked exactly.
 */
function supportsDigitalKind(
  kind: TriggerKind,
  level: 0 | 1 | undefined,
  capabilities: readonly TriggerKind[],
): boolean {
  if (kind === 'level') {
    const effective = level ?? 1;
    return capabilities.includes('level') ||
      capabilities.includes(effective === 1 ? 'high' : 'low');
  }
  if (kind === 'high' || kind === 'low') {
    return capabilities.includes(kind) || capabilities.includes('level');
  }
  return capabilities.includes(kind);
}

/**
 * The plan does not resolve signals to groups; it only checks that the requested volts
 * can be represented by at least one analog group. A group with no usable range is
 * ignored rather than treated as a zero range.
 */
function voltsFitAnyGroup(profile: DeviceProfile, volts: number): boolean {
  let sawRange = false;
  for (const group of profile.analog.groups) {
    for (const range of group.ranges) {
      if (!Number.isFinite(range) || range <= 0) continue;
      sawRange = true;
      if (Math.abs(volts) <= range) return true;
    }
  }
  return !sawRange;
}

function budgetProblem(budget: TriggerBudget): string | null {
  if (budget === null || typeof budget !== 'object') {
    return 'postTrigger must be a TriggerBudget object';
  }
  switch (budget.kind) {
    case 'samples':
      return Number.isInteger(budget.value) && budget.value >= 1
        ? null
        : `samples budget must be a positive integer, got ${String(budget.value)}`;
    case 'time':
      return Number.isFinite(budget.value) && budget.value > 0
        ? null
        : `time budget must be a positive finite number of seconds, got ${String(budget.value)}`;
    case 'unlimited':
      return null;
    default:
      return `unknown postTrigger kind ${String((budget as { kind?: unknown }).kind)}`;
  }
}

function copyBudget(budget: TriggerBudget): TriggerBudget {
  if (budget.kind === 'unlimited') return { kind: 'unlimited' };
  if (budget.kind === 'samples') return { kind: 'samples', value: budget.value };
  return { kind: 'time', value: budget.value };
}

/** Relative comparison for a supplied `retentionSeconds` that must agree with the budget. */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Compile the requested trigger configuration into the one plan used by device and host
 * execution. Pure: the same input (including `compiledAt`) always produces the same plan.
 */
export function compileTriggerPlan(input: TriggerPlanInput): TriggerPlanResult {
  // 1. Mask first: an off mask disables every stored condition, so no plan is armed.
  if (!input.enableMask) {
    return fail(
      'mask-off',
      'the global trigger enable mask is off; stored conditions remain unarmed',
    );
  }

  const source: string = input.source;
  if (source !== 'digital' && source !== 'analog' && source !== 'mixed') {
    return fail('unsupported-mode', `unknown trigger source ${String(input.source)}`);
  }

  // 2. Source filtering. Per DESIGN.md §8 the unselected family stays stored but is not
  // armed, so its conditions must not be validated or fail the selected family.
  const rawDigital = source === 'analog' ? [] : (input.digital ?? []);
  const rawAnalog = source === 'digital' ? [] : (input.analog ?? []);
  if (rawDigital.length === 0 && rawAnalog.length === 0) {
    return fail(
      'no-conditions',
      source === 'mixed'
        ? 'trigger mask is on but neither family has a condition'
        : `trigger mask is on but the selected ${source} family has no condition`,
    );
  }

  // 3. P0 phase rule: a mixed request needs an explicitly mixed-capable profile.
  if (source === 'mixed' && !input.profile.trigger.mixed) {
    return fail(
      'mixed-unsupported',
      `profile ${input.profile.id} cannot execute mixed digital+analog conditions ` +
        '(trigger.mixed=false; P0 keeps the single-family rule)',
    );
  }

  // 4. Digital conditions: shape, local consistency and profile capability.
  const digitalConditions: TriggerCondition[] = [];
  for (const condition of rawDigital) {
    if (condition === null || typeof condition !== 'object') {
      return fail('unsupported-digital', 'digital condition must be an object');
    }
    const badSignal = signalProblem(condition.signal);
    if (badSignal !== null) return fail('unsupported-digital', badSignal);
    if (!isTriggerKind(condition.kind)) {
      return fail(
        'unsupported-digital',
        `unknown digital trigger kind ${String(condition.kind)} on ${condition.signal}`,
      );
    }
    if (condition.level !== undefined &&
        condition.level !== 0 && condition.level !== 1) {
      return fail(
        'unsupported-digital',
        `level condition on ${condition.signal} must be 0 or 1, got ` +
          `${String(condition.level)}`,
      );
    }
    if ((condition.kind === 'high' && condition.level === 0) ||
        (condition.kind === 'low' && condition.level === 1)) {
      return fail(
        'unsupported-digital',
        `${condition.signal} requests ${condition.kind} with contradictory level ` +
          `${condition.level}`,
      );
    }
    const effectiveLevel = condition.kind === 'level' ? (condition.level ?? 1) : undefined;
    if (!supportsDigitalKind(condition.kind, effectiveLevel, input.profile.trigger.digital)) {
      return fail(
        'unsupported-digital',
        `profile ${input.profile.id} does not support digital trigger ` +
          `${condition.kind}${effectiveLevel === undefined ? '' : ` ${effectiveLevel}`} ` +
          `on ${condition.signal}`,
      );
    }
    digitalConditions.push({
      kind: 'digital',
      signal: condition.signal,
      mode: condition.kind,
      ...(effectiveLevel === undefined ? {} : { level: effectiveLevel }),
    });
  }

  // 5. Analog conditions: shape, profile kind/group capability and full-scale range.
  const analogConditions: TriggerCondition[] = [];
  for (const condition of rawAnalog) {
    if (condition === null || typeof condition !== 'object') {
      return fail('unsupported-analog', 'analog condition must be an object');
    }
    const badSignal = signalProblem(condition.signal);
    if (badSignal !== null) return fail('unsupported-analog', badSignal);
    if (!isAnalogTriggerKind(condition.kind)) {
      return fail(
        'unsupported-analog',
        `unknown analog trigger kind ${String(condition.kind)} on ${condition.signal}`,
      );
    }
    if (!input.profile.trigger.analog.includes(condition.kind)) {
      return fail(
        'unsupported-analog',
        `profile ${input.profile.id} does not support analog ${condition.kind} ` +
          `on ${condition.signal}`,
      );
    }
    if (input.profile.analog.groups.length === 0) {
      return fail(
        'unsupported-analog',
        `profile ${input.profile.id} exposes no analog groups for ${condition.signal}`,
      );
    }
    if (!Number.isFinite(condition.volts)) {
      return fail(
        'unsupported-analog',
        `analog trigger volts on ${condition.signal} must be finite, got ` +
          `${String(condition.volts)}`,
      );
    }
    if (condition.hysteresis !== undefined &&
        (!Number.isFinite(condition.hysteresis) || condition.hysteresis < 0)) {
      return fail(
        'unsupported-analog',
        `analog trigger hysteresis on ${condition.signal} must be a finite ` +
          `non-negative number, got ${String(condition.hysteresis)}`,
      );
    }
    if (!voltsFitAnyGroup(input.profile, condition.volts)) {
      return fail(
        'unsupported-analog',
        `analog trigger level ${condition.volts} V on ${condition.signal} exceeds every ` +
          `group full-scale range`,
      );
    }
    analogConditions.push({
      kind: 'analog',
      signal: condition.signal,
      mode: condition.kind,
      volts: condition.volts,
      ...(condition.hysteresis === undefined
        ? {}
        : { hysteresis: condition.hysteresis }),
    });
  }

  const familyCount =
    (digitalConditions.length > 0 ? 1 : 0) + (analogConditions.length > 0 ? 1 : 0);
  if (familyCount === 0) {
    return fail('no-conditions', 'no effective trigger condition remains after filtering');
  }
  if (familyCount > 1 && !input.profile.trigger.mixed) {
    return fail(
      'mixed-unsupported',
      `profile ${input.profile.id} cannot execute mixed digital+analog conditions ` +
        '(trigger.mixed=false)',
    );
  }

  // 6. Budget, Loop and capture context.
  const budgetIssue = budgetProblem(input.postTrigger);
  if (budgetIssue !== null) return fail('invalid-budget', budgetIssue);

  let loop: TriggerPlanLoop | undefined;
  if (input.loop !== undefined) {
    if (!input.profile.modes.loop) {
      return fail(
        'unsupported-mode',
        `profile ${input.profile.id} does not support Loop captures`,
      );
    }
    if (input.loop.anchor !== 'trigger' && input.loop.anchor !== 'free') {
      return fail(
        'unsupported-mode',
        `unknown Loop anchor ${String(input.loop.anchor)}; expected 'trigger' or 'free'`,
      );
    }
    if (!Number.isFinite(input.loop.seconds) || input.loop.seconds <= 0) {
      return fail(
        'invalid-budget',
        `Loop seconds must be a positive finite number, got ${String(input.loop.seconds)}`,
      );
    }
    if (input.postTrigger.kind !== 'unlimited') {
      return fail(
        'invalid-budget',
        'a Loop plan owns an unbounded window; postTrigger must be unlimited so the ' +
          'pre-trigger percentage cannot apply to a second, finite budget',
      );
    }
    loop = { seconds: input.loop.seconds, anchor: input.loop.anchor };
  }

  let capture: { samplerate: number; channels: ChannelCount; bytesPerSample: number } | null =
    null;
  if (input.capture !== undefined) {
    const { samplerate, channels } = input.capture;
    if (!Number.isFinite(samplerate) || samplerate <= 0) {
      return fail(
        'invalid-budget',
        `capture.samplerate must be a positive finite number, got ${String(samplerate)}`,
      );
    }
    if (!isChannelCount(channels)) {
      return fail(
        'invalid-budget',
        `capture.channels must be one of ${CHANNEL_COUNTS.join('/')}, got ${String(channels)}`,
      );
    }
    capture = {
      samplerate,
      channels,
      bytesPerSample: bytesPerSampleForChannels(channels),
    };
  }

  // 7. Pre-trigger window.
  if (!Number.isFinite(input.preTriggerPercent) || input.preTriggerPercent < 0) {
    return fail(
      'pre-trigger-cap',
      `preTriggerPercent must be a finite non-negative number, got ` +
        `${String(input.preTriggerPercent)}`,
    );
  }
  if (input.retentionSeconds !== undefined &&
      (!Number.isFinite(input.retentionSeconds) || input.retentionSeconds <= 0)) {
    return fail(
      'invalid-budget',
      `retentionSeconds must be a positive finite number, got ` +
        `${String(input.retentionSeconds)}`,
    );
  }

  const profileMaxPercent = Number.isFinite(input.profile.trigger.preTriggerMaxPercent)
    ? Math.max(0, Math.min(100, input.profile.trigger.preTriggerMaxPercent))
    : 0;
  // A zero byte cap means no history can be retained even when no rate is supplied.
  const profileMaxBytes = Number.isFinite(input.profile.trigger.preTriggerMaxBytes)
    ? Math.max(0, input.profile.trigger.preTriggerMaxBytes)
    : 0;

  // The window the percentage applies to. A time budget states it directly; a samples
  // budget states it when the capture rate is known. Loop/samples callers can supply the
  // duration explicitly, or a Loop plan falls back to its own window length.
  const post = input.postTrigger;
  let baseSeconds: number | null = post.kind === 'time'
    ? post.value
    : post.kind === 'samples' && capture !== null
      ? post.value / capture.samplerate
      : null;
  if (input.retentionSeconds !== undefined) {
    if (baseSeconds !== null && !nearlyEqual(baseSeconds, input.retentionSeconds)) {
      return fail(
        'invalid-budget',
        `retentionSeconds ${input.retentionSeconds} does not match the ` +
          `${post.kind} budget duration ${baseSeconds}`,
      );
    }
    baseSeconds = input.retentionSeconds;
  } else if (baseSeconds === null && loop !== undefined) {
    baseSeconds = loop.seconds;
  }

  // Whole samples in the base window. A samples budget states them directly; otherwise
  // the capture rate quantizes the duration the same way capturePostTriggerSamples()
  // does for a time budget.
  let baseSamples: number | null = post.kind === 'samples'
    ? post.value
    : capture !== null && baseSeconds !== null
      ? Math.round(baseSeconds * capture.samplerate)
      : null;

  let percent = Math.min(input.preTriggerPercent, profileMaxPercent);
  if (profileMaxBytes === 0) percent = 0;
  if (baseSamples !== null) {
    // The historic rule: keep at least the trigger sample (and one post-trigger sample)
    // inside the requested base budget. The byte cap is applied to the resulting whole
    // sample count below, not to the percentage: clamping the percentage first would
    // floor the product one sample below floor(capBytes / bytesPerSample).
    percent = baseSamples > 0
      ? Math.min(percent, Math.max(0, ((baseSamples - 1) * 100) / baseSamples))
      : 0;
  }

  let preSamples: number | null = null;
  if (baseSamples !== null) {
    const byPercent = Math.floor((baseSamples * percent) / 100);
    const maxByBase = Math.max(0, baseSamples - 1);
    const maxByBytes = capture !== null
      ? Math.floor(profileMaxBytes / capture.bytesPerSample)
      : Number.POSITIVE_INFINITY;
    preSamples = Math.max(0, Math.min(byPercent, maxByBase, maxByBytes));
    // Only a cap that actually reduces the request changes the reported percentage.
    // A plain integer floor (4096 * 10% = 409) must keep the requested 10%, not report
    // 9.985...; the byte cap, by contrast, is a user-visible "up to" limit.
    if (baseSamples > 0 && preSamples < byPercent) {
      percent = (preSamples * 100) / baseSamples;
    }
  }

  let preSeconds: number;
  if (preSamples !== null && capture !== null) {
    preSeconds = preSamples / capture.samplerate;
  } else if (baseSeconds !== null) {
    preSeconds = (baseSeconds * percent) / 100;
  } else if (percent === 0) {
    preSeconds = 0;
  } else {
    return fail(
      'invalid-budget',
      'preTrigger.seconds cannot be derived: supply capture.samplerate and ' +
        'capture.channels, retentionSeconds, a time budget, or loop.seconds',
    );
  }

  // §5.1: capBytes is T's byte position in the retained stream. Without rate/width it
  // cannot be computed, so the profile's hard bound is the only honest value and is
  // marked as a bound rather than a position.
  let capBytes: number;
  let capBytesIsBound = false;
  if (percent === 0) {
    capBytes = 0;
  } else if (capture !== null && preSamples !== null) {
    capBytes = Math.min(profileMaxBytes, preSamples * capture.bytesPerSample);
  } else {
    capBytes = profileMaxBytes;
    capBytesIsBound = true;
  }

  const planSource: TriggerSource =
    digitalConditions.length > 0 && analogConditions.length > 0
      ? 'mixed'
      : digitalConditions.length > 0
        ? 'digital'
        : 'analog';

  const compiledAt = typeof input.compiledAt === 'number' &&
      Number.isFinite(input.compiledAt)
    ? input.compiledAt
    : Date.now();

  const plan: TriggerPlan = {
    source: planSource,
    conditions: [...digitalConditions, ...analogConditions],
    execution: input.profile.trigger.execution,
    preTrigger: {
      percent,
      seconds: preSeconds,
      capBytes,
      ...(capBytesIsBound ? { capBytesIsBound: true } : {}),
      // Exact whole-sample prefix whenever it exists. This is what SimDriver and the host
      // matcher must use instead of recovering a count from the float `seconds`.
      ...(preSamples === null ? {} : { samples: preSamples }),
    },
    budget: copyBudget(post),
    ...(loop === undefined ? {} : { loop: { ...loop } }),
    compiledAt,
  };
  return { ok: true, plan };
}
