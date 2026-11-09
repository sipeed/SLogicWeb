// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Legacy capture-trigger -> TriggerPlan/HostTrigger bridge
 * (docs/ARCHITECTURE.md §5.1).
 *
 * `captureTriggerPlan` is a pure translation from the *effective* legacy
 * `CaptureSettings` trigger fields into the M0 plan path. It owns no trigger policy:
 * profile capabilities, condition shapes, the P0 single-family rule, budget validation
 * and the effective pre-trigger window all stay in `compileTriggerPlan`. The bridge only
 * translates the legacy representation:
 *
 *  1. **Legacy free-run gate.** `triggerEnableMask` plus at least one effective
 *     condition is the legacy `softwareTrigger` predicate. A mask-off or condition-less
 *     request is a successful free-running capture (`armed: false`, no plan), not a
 *     typed error: the old path simply did not arm the matcher then.
 *  2. **Source filtering.** Only the selected family (`triggerSource`) can arm; the
 *     other family stays stored and is never validated, exactly as the legacy capture
 *     path filters it out. A source with no effective conditions therefore free-runs.
 *  3. **Single-condition alias.** When there are no confirmed per-channel conditions,
 *     the legacy `triggerChannel` / `triggerKind` / `triggerLevel` triple (`single`)
 *     supplies the one condition, mirroring `clampCaptureSettings`'s fallback.
 *  4. **Names and kinds.** Channels are named the way `SignalStore` names its signals:
 *     `d<channel>` for digital and `a<start>` for an analog bank start. A legacy
 *     `level` condition keeps its `level` polarity; `high`/`low` pass through as the
 *     aliases they are (the compiler normalizes both). An edge condition's `level`
 *     field carries no semantics and is dropped.
 *  5. **Budget and pre-trigger base.** Single/Repeat pass the legacy effective
 *     post-trigger sample count as a `samples` budget, so the compiler applies the
 *     percentage to it. Loop passes an `unlimited` budget plus the legacy Loop window
 *     (`postTriggerSamples / samplerate`) and a trigger anchor, so the percentage
 *     applies to the Loop window instead. `preTriggerPercent` is forwarded unchanged;
 *     the compiler owns the profile/byte/base caps.
 *  6. **Repeat search limit.** One Repeat sweep searches for `triggerSearchSamples(
 *     'repeat', captureLimitSamples)`, i.e. `min(MAX_SAMPLES - 1, post + pre)` whole
 *     samples, where `pre` is the plan's exact `preTrigger.samples`. Single and Loop
 *     wait indefinitely. The descriptor exposes that allowance for `HostTrigger`. The
 *     matcher's pre-fill holdoff inspects the first `pre` samples without matching, so
 *     a Repeat sweep may match in the remaining `post` samples.
 *
 * ## What success means
 *
 * A successful armed result carries the compiled `TriggerPlan` and the fields of
 * `HostTriggerOptions` the bridge can supply (`channels`, `samplerate`,
 * `searchLimitSamples`). The default `HostTrigger` signal resolver understands the
 * `d<channel>` names this bridge emits, so no `resolveChannel` is needed:
 *
 *     const result = captureTriggerPlan(legacyInput);
 *     if (result.ok && result.armed) {
 *       const trigger = new HostTrigger({ plan: result.plan, ...result.host, emit });
 *     }
 *
 * `HostTrigger` itself derives its total emitted budget as
 * `preTrigger.samples + postTriggerSamples`; the capture/storage layer still owns the
 * `MAX_SAMPLES` envelope (the legacy path clamped `captureLimitSamples` for that). The
 * bridge preserves the legacy *search* allowance in `searchLimitSamples` but does not
 * silently shrink the requested post-trigger budget.
 *
 * ## Typed refusals
 *
 * Malformed or unsupported input is a typed refusal, never an exception. Compiler
 * refusals (`invalid-budget`, `unsupported-digital`, `unsupported-analog`, ...) pass
 * through unchanged, so this module does not duplicate the compiler's policy table.
 * An armed request that `HostTrigger` cannot execute is also refused instead of being
 * silently downgraded to a free-running capture:
 *
 *  - analog conditions compile but need the M1 analog executor (`unsupported-analog-host`);
 *  - a device-executed profile needs the firmware path (`device-execution`);
 *  - a free-anchored Loop never waits for a match (`unsupported-loop-anchor`).
 *
 * Analog `volts` are carried in volts (never encoded to an ADC code) into the plan
 * input, so the compiler's range check sees exactly the legacy level.
 *
 * ## Analog qualification
 *
 * Analog crossings are qualified, never raw (docs/ARCHITECTURE.md trigger section). The
 * descriptor carries the two numbers every analog executor takes, with the
 * `SoftwareTriggerConfig` field names: `analogHysteresis` (h, the module's
 * `ADC_TRIGGER_HYSTERESIS_CODES` = 4 codes) and `analogArtifactSamples` (W, the
 * transition-glitch window, `analogTriggerArtifactSamples(samplerate)` = ceil(500 ns * rate),
 * 50 at 100 MS/s), both
 * from `analogTriggerQualification`. They are in codes and samples, not part of the
 * plan: the plan stays in volts, and its optional volt `hysteresis` is still only set
 * when the legacy input supplies one (the legacy default is none). A digital plan
 * carries them too; a digital matcher ignores them. The `unsupported-analog-host`
 * refusal carries the compiled plan and this descriptor, so lifting the refusal once an
 * analog executor exists needs no plan change. The up to W - 1 look-ahead samples that
 * decide a crossing are inspected samples: an executor counts them toward
 * `searchLimitSamples`, so the Repeat allowance
 * below needs no analog term (T must still lie inside the sweep).
 *
 * ## Assumptions
 *
 * The caller supplies *effective* fields: conditions already filtered to visible
 * channels and clamped to the capture width, `preTriggerPercent` already clamped by
 * the UI, and `postTriggerSamples` equal to `capturePostTriggerSamples(settings)`
 * (Single/Repeat post-trigger length, or `clampLoopSamples(loopSamples, channels)` for
 * Loop). The bridge still checks the channel/group indices it turns into signal names,
 * because an out-of-range name is not executable by `HostTrigger`. The plan's
 * `compiledAt` defaults to 0 so the function is deterministic; pass `compiledAt` for a
 * wall-clock stamp.
 */

import { MAX_SAMPLES, type ChannelCount } from '../types.js';
import type {
  AnalogTriggerKind,
  DeviceProfile,
  TriggerKind,
} from '../device/profileTypes.js';
import {
  compileTriggerPlan,
  type AnalogTriggerInput,
  type DigitalTriggerInput,
  type TriggerBudget,
  type TriggerPlan,
  type TriggerPlanFailureReason,
  type TriggerPlanLoop,
} from './triggerPlan.js';
import { analogTriggerQualification } from '../ui/channelBanks.js';

/** The mode names used by the legacy `CaptureSettings`. */
export type LegacyCaptureMode = 'single' | 'repeat' | 'loop';
/** The legacy `triggerSource`: exactly one family is armed. */
export type LegacyTriggerSource = 'digital' | 'analog';

/** One effective legacy per-channel condition (`CaptureSettings.triggerConditions`). */
export interface LegacyDigitalCondition {
  /** Absolute digital channel index; the bridge names it `d<channel>`. */
  readonly channel: number;
  /** One of the six glyphs; `level` carries its polarity in `level`. */
  readonly kind: TriggerKind;
  /** Meaningful for `level`; defaults to 1 (high), as the legacy condition does. */
  readonly level?: 0 | 1;
}

/** One effective legacy analog trigger (`CaptureSettings.analogTriggers` value). */
export interface LegacyAnalogCondition {
  /** First input of the ADC bank, i.e. the key in `analogTriggers`. */
  readonly start: number;
  readonly kind: AnalogTriggerKind;
  /** Crossing level in volts; passed through in volts, never as an ADC code. */
  readonly volts: number;
  /** Optional plan extension; the legacy settings have no hysteresis (0 V). */
  readonly hysteresis?: number;
}

/** All inputs needed to turn the legacy trigger fields into one compiled plan. */
export interface CaptureTriggerPlanInput {
  readonly profile: DeviceProfile;
  /** Legacy global `triggerEnableMask`; false always free-runs. */
  readonly enableMask: boolean;
  /** Legacy `triggerSource`; the other family is stored but not armed. */
  readonly source: LegacyTriggerSource;
  /** Effective per-channel conditions; used when non-empty. */
  readonly digital?: readonly LegacyDigitalCondition[];
  /**
   * Legacy single-condition fallback (`triggerChannel`/`triggerKind`/`triggerLevel`).
   * Used only when `digital` is empty, exactly like `clampCaptureSettings`.
   */
  readonly single?: LegacyDigitalCondition;
  /** Effective analog conditions; only considered when `source` is `analog`. */
  readonly analog?: readonly LegacyAnalogCondition[];
  /** Legacy `preTriggerPercent`; the compiler applies the profile/byte/base caps. */
  readonly preTriggerPercent: number;
  readonly mode: LegacyCaptureMode;
  /**
   * Legacy effective post-trigger budget in whole samples: the Single/Repeat
   * post-trigger length, or the Loop window for `mode: 'loop'`. This is
   * `capturePostTriggerSamples(settings)` in the legacy capture path and is also the
   * base the pre-trigger percentage applies to.
   */
  readonly postTriggerSamples: number;
  /** Loop anchor; defaults to `trigger` (the legacy armed-Loop behaviour). */
  readonly loopAnchor?: 'trigger' | 'free';
  /** Capture width; also validates the channel/group indices named into signals. */
  readonly channels: ChannelCount;
  readonly samplerate: number;
  /** Deterministic plan clock override; defaults to 0 (the bridge is pure). */
  readonly compiledAt?: number;
}

/** The `HostTriggerOptions` fields the bridge can supply; add `emit`/`onMatch`. */
export interface CaptureHostTriggerDescriptor {
  readonly channels: ChannelCount;
  readonly samplerate: number;
  /**
   * Samples one search sweep may inspect before reporting `not-found`: a Repeat
   * sweep's retained budget, or Infinity for Single and Loop.
   */
  readonly searchLimitSamples: number;
  /** Analog arming hysteresis in ADC codes (`SoftwareTriggerConfig.analogHysteresis`). */
  readonly analogHysteresis: number;
  /**
   * The analog transition-glitch window W, `ceil(500 ns * samplerate)`: a shorter run of
   * glitch codes neither arms nor fires (`SoftwareTriggerConfig.analogArtifactSamples`).
   */
  readonly analogArtifactSamples: number;
}

export type CaptureTriggerRefusalReason =
  | TriggerPlanFailureReason
  | 'invalid-input'
  | 'invalid-source'
  | 'invalid-mode'
  | 'invalid-condition'
  | 'invalid-channel'
  | 'invalid-analog-group'
  | 'invalid-pre-trigger'
  | 'unsupported-analog-host'
  | 'device-execution'
  | 'unsupported-loop-anchor';

/** A typed bridge refusal. Callers branch on `reason`, never on the message. */
export interface CaptureTriggerRefusal {
  readonly ok: false;
  readonly reason: CaptureTriggerRefusalReason;
  readonly detail: string;
  /**
   * Only on `unsupported-analog-host`: the compiled plan and the descriptor an analog
   * host executor would take (qualification included).
   */
  readonly plan?: TriggerPlan;
  readonly host?: CaptureHostTriggerDescriptor;
}

/** The trigger is disabled or has no effective condition: the capture free-runs. */
export interface CaptureTriggerPlanFreeRun {
  readonly ok: true;
  readonly armed: false;
  readonly plan: null;
  readonly host: null;
}

/** An armed plan plus everything `HostTrigger` needs except the callbacks. */
export interface CaptureTriggerPlanArmed {
  readonly ok: true;
  readonly armed: true;
  readonly plan: TriggerPlan;
  readonly host: CaptureHostTriggerDescriptor;
}

export type CaptureTriggerPlanResult =
  | CaptureTriggerPlanFreeRun
  | CaptureTriggerPlanArmed
  | CaptureTriggerRefusal;

/** Left side of a translation that can carry a typed refusal. */
type Translated<T> = { readonly ok: true; readonly value: T } | CaptureTriggerRefusal;

function refusal(
  reason: CaptureTriggerRefusalReason,
  detail: string,
): CaptureTriggerRefusal {
  return { ok: false, reason, detail };
}

function freeRun(): CaptureTriggerPlanFreeRun {
  return { ok: true, armed: false, plan: null, host: null };
}

/**
 * The selected family's digital conditions. The unselected family is deliberately not
 * read, so a malformed stored value there cannot break an armed digital capture.
 */
function effectiveDigital(
  input: CaptureTriggerPlanInput,
): Translated<readonly LegacyDigitalCondition[]> {
  if (input.source !== 'digital') return { ok: true, value: [] };
  if (input.digital !== undefined) {
    if (!Array.isArray(input.digital)) {
      return refusal('invalid-condition', 'digital must be an array of conditions');
    }
    if (input.digital.length > 0) return { ok: true, value: input.digital };
  }
  if (input.single !== undefined) {
    if (input.single === null || typeof input.single !== 'object') {
      return refusal('invalid-condition', 'single must be a digital condition object');
    }
    return { ok: true, value: [input.single] };
  }
  return { ok: true, value: [] };
}

/** The selected family's analog conditions; the unselected family is not read. */
function effectiveAnalog(
  input: CaptureTriggerPlanInput,
): Translated<readonly LegacyAnalogCondition[]> {
  if (input.source !== 'analog') return { ok: true, value: [] };
  if (input.analog === undefined) return { ok: true, value: [] };
  if (!Array.isArray(input.analog)) {
    return refusal('invalid-condition', 'analog must be an array of conditions');
  }
  return { ok: true, value: input.analog };
}

/** `d<channel>` (the SignalStore id and HostTrigger's default naming convention). */
function translateDigital(
  condition: LegacyDigitalCondition,
  channels: ChannelCount,
): Translated<DigitalTriggerInput> {
  if (condition === null || typeof condition !== 'object') {
    return refusal('invalid-condition', 'a digital trigger condition must be an object');
  }
  const channel = condition.channel;
  if (!Number.isSafeInteger(channel) || channel < 0 || channel >= channels) {
    return refusal(
      'invalid-channel',
      `digital trigger channel must be an integer inside 0..${channels - 1}, ` +
        `got ${String(channel)}`,
    );
  }
  const signal = `d${channel}`;
  const kind = condition.kind;
  if (kind === 'level') {
    return { ok: true, value: { signal, kind, level: condition.level ?? 1 } };
  }
  if (kind === 'high' || kind === 'low') {
    return {
      ok: true,
      value: {
        signal,
        kind,
        ...(condition.level === undefined ? {} : { level: condition.level }),
      },
    };
  }
  // Edge/transition kinds have no polarity; the legacy level field is a don't-care.
  return { ok: true, value: { signal, kind } };
}

/** `a<start>`; a start is a channel index, and volts stay in volts for the compiler. */
function translateAnalog(
  condition: LegacyAnalogCondition,
  channels: ChannelCount,
): Translated<AnalogTriggerInput> {
  if (condition === null || typeof condition !== 'object') {
    return refusal('invalid-condition', 'an analog trigger condition must be an object');
  }
  const start = condition.start;
  if (!Number.isSafeInteger(start) || start < 0 || start >= channels) {
    return refusal(
      'invalid-analog-group',
      `analog trigger group start must be an integer inside 0..${channels - 1}, ` +
        `got ${String(start)}`,
    );
  }
  return {
    ok: true,
    value: {
      signal: `a${start}`,
      kind: condition.kind,
      volts: condition.volts,
      ...(condition.hysteresis === undefined
        ? {}
        : { hysteresis: condition.hysteresis }),
    },
  };
}

/**
 * The legacy Repeat search allowance. Mirrors `triggerSearchSamples(mode,
 * captureLimitSamples)` from the capture-session policy: only Repeat retries, and one
 * sweep's match window is its finite retained budget (`post + pre`, capped by the host
 * sample envelope), plus the `pre` samples the pre-fill holdoff inspects first. Single waits indefinitely and Loop is unbounded.
 */
function legacySearchLimit(
  mode: LegacyCaptureMode,
  postTriggerSamples: number,
  preTriggerSamples: number,
): number {
  if (mode !== 'repeat') return Number.POSITIVE_INFINITY;
  const sweepSamples = Math.min(
    MAX_SAMPLES - 1,
    postTriggerSamples + preTriggerSamples,
  );
  // The pre-fill holdoff spends the first `pre` samples without matching; they are
  // added on top so the match window stays one sweep (as triggerSearchSamples does).
  return Number.isFinite(sweepSamples) && sweepSamples > 0
    ? Math.floor(sweepSamples) + Math.max(0, Math.floor(preTriggerSamples))
    : Number.POSITIVE_INFINITY;
}

/**
 * Compile the effective legacy trigger fields into one plan and the descriptor needed
 * to drive a `HostTrigger`.
 *
 * Pure for a given input: no clock, DOM, device or storage is touched, and
 * `compiledAt` defaults to 0. Returns a typed refusal for malformed input, a compiler
 * refusal for anything the plan compiler rejects, and a typed refusal when the
 * compiled plan is not host-executable. A disabled or condition-less trigger is a
 * successful free-run, not a refusal.
 */
export function captureTriggerPlan(
  input: CaptureTriggerPlanInput,
): CaptureTriggerPlanResult {
  if (input === null || typeof input !== 'object') {
    return refusal('invalid-input', 'capture trigger input must be an object');
  }
  // The legacy gate, first: a disabled mask leaves stored conditions unarmed and the
  // capture free-runs, so those stored values are deliberately not validated.
  if (!input.enableMask) return freeRun();
  if (input.source !== 'digital' && input.source !== 'analog') {
    return refusal(
      'invalid-source',
      `trigger source must be 'digital' or 'analog', got ${String(input.source)}`,
    );
  }
  if (input.profile === null || typeof input.profile !== 'object') {
    return refusal('invalid-input', 'profile must be a DeviceProfile object');
  }

  const digital = effectiveDigital(input);
  if (!digital.ok) return digital;
  const analog = effectiveAnalog(input);
  if (!analog.ok) return analog;
  // Same predicate as the legacy `softwareTrigger`: no effective condition means the
  // matcher is not armed and the capture free-runs.
  if (digital.value.length === 0 && analog.value.length === 0) return freeRun();

  if (input.mode !== 'single' && input.mode !== 'repeat' && input.mode !== 'loop') {
    return refusal(
      'invalid-mode',
      `capture mode must be 'single', 'repeat' or 'loop', got ${String(input.mode)}`,
    );
  }
  // The legacy loop window is a whole-sample count; Single/Repeat hand the same value
  // to the compiler as a samples budget, which validates it again.
  if (!Number.isSafeInteger(input.postTriggerSamples) ||
      input.postTriggerSamples < 1) {
    return refusal(
      'invalid-budget',
      `postTriggerSamples must be a positive safe integer, ` +
        `got ${String(input.postTriggerSamples)}`,
    );
  }

  const digitalInputs: DigitalTriggerInput[] = [];
  for (const condition of digital.value) {
    const translated = translateDigital(condition, input.channels);
    if (!translated.ok) return translated;
    digitalInputs.push(translated.value);
  }
  const analogInputs: AnalogTriggerInput[] = [];
  for (const condition of analog.value) {
    const translated = translateAnalog(condition, input.channels);
    if (!translated.ok) return translated;
    analogInputs.push(translated.value);
  }

  const isLoop = input.mode === 'loop';
  const postTrigger: TriggerBudget = isLoop
    ? { kind: 'unlimited' }
    : { kind: 'samples', value: input.postTriggerSamples };
  // An armed Loop uses the legacy window and the legacy anchor ('trigger' waits for
  // the first match). Everything else about the Loop is the compiler's / executor's.
  const loop: TriggerPlanLoop | undefined = isLoop
    ? {
      seconds: input.postTriggerSamples / input.samplerate,
      anchor: input.loopAnchor ?? 'trigger',
    }
    : undefined;

  const compiled = compileTriggerPlan({
    profile: input.profile,
    enableMask: true,
    source: input.source,
    digital: digitalInputs,
    analog: analogInputs,
    preTriggerPercent: input.preTriggerPercent,
    postTrigger,
    capture: { samplerate: input.samplerate, channels: input.channels },
    compiledAt: input.compiledAt ?? 0,
    ...(loop === undefined ? {} : { loop }),
  });
  if (!compiled.ok) {
    return { ok: false, reason: compiled.reason, detail: compiled.detail };
  }
  const plan = compiled.plan;

  // The compiler owns plan policy; these three checks only establish that HostTrigger
  // can execute the result. Refuse instead of silently free-running or throwing later.
  if (plan.execution !== 'host') {
    return refusal(
      'device-execution',
      `profile ${input.profile.id} executes this trigger in the firmware; the bridge ` +
        'produces HostTrigger descriptors and cannot run a device plan',
    );
  }
  if (plan.source !== 'digital') {
    const pre = plan.preTrigger.samples;
    return {
      ...refusal(
        'unsupported-analog-host',
        `the compiled plan is ${plan.source}; host execution supports digital plans only ` +
          '(analog trigger execution is M1 work)',
      ),
      plan,
      ...(pre !== undefined && Number.isSafeInteger(pre) && pre >= 0
        ? { host: hostDescriptor(input, pre) }
        : {}),
    };
  }
  if (plan.loop !== undefined && plan.loop.anchor !== 'trigger') {
    return refusal(
      'unsupported-loop-anchor',
      'a free-anchored Loop never waits for a match; only anchor: trigger is ' +
        'executable by HostTrigger',
    );
  }
  const preTriggerSamples = plan.preTrigger.samples;
  if (preTriggerSamples === undefined ||
      !Number.isSafeInteger(preTriggerSamples) ||
      preTriggerSamples < 0) {
    return refusal(
      'invalid-pre-trigger',
      'the compiled plan did not report an exact pre-trigger sample prefix',
    );
  }

  return { ok: true, armed: true, plan, host: hostDescriptor(input, preTriggerSamples) };
}

/** The `HostTriggerOptions` fields for a plan with an exact `pre` prefix. */
function hostDescriptor(
  input: CaptureTriggerPlanInput,
  preTriggerSamples: number,
): CaptureHostTriggerDescriptor {
  return {
    channels: input.channels,
    samplerate: input.samplerate,
    searchLimitSamples: legacySearchLimit(
      input.mode,
      input.postTriggerSamples,
      preTriggerSamples,
    ),
    ...analogTriggerQualification(input.samplerate),
  };
}
