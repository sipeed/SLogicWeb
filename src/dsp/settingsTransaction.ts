// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M0 settings transaction (docs/ARCHITECTURE.md §5.3).
 *
 * One pure `commitSettings` call merges a field patch into the canonical capture
 * configuration, validates it against the device profile, classifies every changed
 * field with `mayEdit`, compiles the trigger plans, and returns either the canonical
 * configuration plus the applied view, declared effects and pending list, or one typed
 * refusal. Nothing is committed on a refusal: `current` is never mutated and the
 * result carries no `next`.
 *
 * ## Applied versus canonical
 *
 * The result separates what the active acquisition uses from what the next acquisition
 * will use:
 *
 *   - `applied` is `current` with only the changed keys that the policy let apply now
 *     (a `live` key whose `mayEdit` decision is `allow`, plus view/preference keys).
 *     Staged keys (scope `next`, or a `next`/`restart` decision) keep the current
 *     value, so a pending trigger or budget edit can never leak into the running plan.
 *   - `next` is the canonical configuration including every staged key.
 *
 * `activePlan` is compiled from `applied` only while the acquisition is active
 * (`arming`, `waiting`, `running`, `restarting`, `retrying`) and its mask is armed.
 * `nextPlan` is compiled from `next` whenever its mask is armed. `recompile-trigger`
 * is declared only when the active plan's inputs actually changed (which includes
 * turning the mask on live); a pending-only edit never recompiles the active trigger.
 * Turning an active acquisition's mask from on to off declares `disarm-trigger`; a
 * mask-off at idle declares no trigger effect.
 *
 * ## Duration carry
 *
 * A bare mode switch carries the capture window between the two window fields on the
 * same samplerate seconds: switching into Loop sets `loopSeconds` from the current
 * duration, and switching out of Loop sets `durationSeconds` from the current Loop
 * window. An explicit `durationSeconds`/`loopSeconds` in the patch wins over the
 * carried value. Changing the samplerate never rescales a window: windows are stored
 * and carried in seconds.
 *
 * ## Static policy versus state-dependent decision
 *
 * `SETTING_POLICIES` is the §5.3 classification: `live` settings can apply to an
 * active capture, `next` settings are host-side budget/scheduling and only ever
 * configure a later acquisition, and `view`/`preference` settings never touch the
 * acquisition at all. The static scope alone cannot express "a trigger edit retunes
 * while waiting but is pending after a match", so `SETTING_EDIT_FEATURES` maps each
 * key to the `EditFeature` that `mayEdit` decides in the current context. The
 * transaction then applies these rules:
 *
 *   - a `refuse` decision aborts the whole transaction (`edit-refused`);
 *   - `allow` on a `live` key applies now (`apply-live`);
 *   - `allow` on a `next` key is staged, because host-side budget changes never
 *     reconfigure the running device;
 *   - `next` and `restart` decisions stage the key. `restart` additionally declares
 *     `restart-required`: a device-side edit is never applied by a silent restart,
 *     matching the named-restart rule in §5.1/§5.2.
 *
 * `pending` therefore means "the canonical value changed but was not applied to the
 * active acquisition". At idle a `next` key is still listed: it is the configuration
 * the next acquisition will use. The caller decides whether to render a Next badge
 * from the acquisition state; the transaction does not hide the distinction.
 *
 * ## Values and clamps
 *
 * - Width, rate, threshold, test mode and capture mode are refused with
 *   `unsupported-profile` when the profile does not offer them; malformed values are
 *   `invalid-value`.
 * - The rate must be a discrete value from `profile.digital.sampleratesHz` that is at
 *   or below the selected width's ceiling for the current `linkRate`. The profile is
 *   the data source; this module does not import the device protocol. A test profile
 *   that omits the table gets the ceiling check only, never a guessed offer.
 * - The pre-trigger percentage is clamped to `profile.trigger.preTriggerMaxPercent`;
 *   the compiler further clamps it to the retained byte/sample cap and reports the
 *   effective value on the plan. The configuration keeps the requested (profile
 *   clamped) percentage.
 * - Durations are clamped to the host storage envelope and must be at least one
 *   sample. For a Single/Repeat budget the duration is the largest sample count whose
 *   pre-trigger prefix also fits: `post + floor(post * percent / 100) <=
 *   MAX_SAMPLES - 1`, with the compiler's own floor/round rules. A Loop window is
 *   separately bounded by the 2 GiB / 2^30-sample retention budget (DESIGN §9, the
 *   same figure as the current UI); its stored `durationSeconds` keeps the plain
 *   `MAX_SAMPLES - 1` bound. A non-positive or non-finite duration is
 *   `invalid-value`, not a clamp.
 * - `thresholdVolts: null` in a profile means the profile declares no threshold
 *   choices; any finite value is then accepted.
 *
 * ## Trigger plan
 *
 * `nextPlan` is compiled from the canonical configuration whenever the resulting mask
 * is armed. This also covers edits that do not name a trigger field but change the
 * window the percentage applies to (rate, duration, Loop window). While the mask is
 * off, conditions stay stored and both plans are null; the compiler is not asked to
 * arm them. The compiler owns family capability checks, so an unsupported
 * analog/mixed request on a profile that lacks it surfaces as `trigger-plan` with the
 * compiler's reason in `detail`.
 *
 * `activePlan` is compiled from `applied` for an active acquisition, so a staged
 * trigger or budget edit only changes `nextPlan` until the acquisition ends.
 *
 * Budget mapping:
 *   - Single/Repeat -> a `time` budget of `durationSeconds`.
 *   - Loop -> an `unlimited` budget plus `loop.seconds = loopSeconds`. The plan owns
 *     the anchor: an armed Loop anchors to the trigger, a free-running Loop to free
 *     time. `CaptureConfig` deliberately has no anchor field.
 *
 * `compiledAt` is fixed at 0 because this transaction has no clock input. The result
 * is therefore byte-for-byte deterministic for the same input; a caller that needs a
 * wall-clock stamp can copy the plan and set it.
 *
 * Imports: only pure modules and type-only profile types. No DOM, UI, store or
 * device runtime code.
 */

import {
  MAX_SAMPLES,
  bytesPerSampleForChannels,
  isChannelCount,
  type ChannelCount,
} from '../types.js';
import type {
  AnalogTriggerInput,
  DigitalTriggerInput,
  TriggerBudget,
  TriggerPlan,
  TriggerPlanLoop,
  TriggerSource,
} from './triggerPlan.js';
import { compileTriggerPlan, type TriggerPlanFailureReason } from './triggerPlan.js';
import {
  mayEdit,
  type AcquisitionContext,
  type AcquisitionMode,
  type AcquisitionState,
  type EditFeature,
} from './acquisition.js';
import type { DeviceProfile, LinkRate, TestMode } from '../device/profileTypes.js';

/** The acquisition settings this transaction owns. */
export interface CaptureConfig {
  readonly mode: AcquisitionMode;
  readonly channels: ChannelCount;
  readonly samplerate: number;
  readonly thresholdVolts: number;
  /** Post-trigger duration for Single/Repeat. Also carries the last duration. */
  readonly durationSeconds: number;
  readonly repeatIntervalSeconds: number;
  /** The Loop data window D. */
  readonly loopSeconds: number;
  readonly triggerEnableMask: boolean;
  readonly triggerSource: TriggerSource;
  readonly digitalConditions: readonly DigitalTriggerInput[];
  readonly analogConditions: readonly AnalogTriggerInput[];
  readonly preTriggerPercent: number;
  readonly testMode: TestMode;
}

export type SettingKey = keyof CaptureConfig;

/** §5.3 application class of a setting. */
export type SettingScope = 'live' | 'next' | 'view' | 'preference';

/**
 * A profile capability path a policy depends on. This is deliberately a path, not a
 * value check: for example `modes` means "resolve `profile.modes[mode]`" and
 * `digital.rates` means "the width's rate tier". It mirrors the capability data in
 * `device/profileTypes.ts` without importing the device runtime.
 */
export type ProfileCapabilityKey =
  | 'modes'
  | 'modes.single'
  | 'modes.repeat'
  | 'modes.loop'
  | 'modes.record'
  | 'digital.widths'
  | 'digital.rates'
  | 'digital.thresholdVolts'
  | 'digital.testModes'
  | 'trigger'
  | 'trigger.digital'
  | 'trigger.analog'
  | 'trigger.mixed'
  | 'trigger.preTriggerMaxPercent';

export interface SettingPolicy {
  readonly scope: SettingScope;
  /** The profile capability a UI should consult before offering the control. */
  readonly capability?: ProfileCapabilityKey;
}

/** The canonical key order: validation, `pending` and effects all follow it. */
export const SETTING_KEYS: readonly SettingKey[] = [
  'mode',
  'channels',
  'samplerate',
  'thresholdVolts',
  'durationSeconds',
  'repeatIntervalSeconds',
  'loopSeconds',
  'triggerEnableMask',
  'triggerSource',
  'digitalConditions',
  'analogConditions',
  'preTriggerPercent',
  'testMode',
];

/**
 * The §5.3 table. Every `CaptureConfig` key has exactly one entry; the self-test
 * asserts coverage so a new field cannot ship without a policy.
 *
 * Device geometry is `live` even though an active capture needs a named restart:
 * `mayEdit` turns that case into a `restart` decision. Trigger fields are `live` for
 * the same reason (a waiting sweep retunes them); `mayEdit` reports `next` after a
 * match. Host budget/scheduling fields are statically `next`. This configuration has
 * no view or preference field; the scopes exist for the settings panel's other
 * sections and are handled without touching the acquisition.
 */
export const SETTING_POLICIES: Readonly<Record<SettingKey, SettingPolicy>> = {
  mode: { scope: 'live', capability: 'modes' },
  channels: { scope: 'live', capability: 'digital.widths' },
  samplerate: { scope: 'live', capability: 'digital.rates' },
  thresholdVolts: { scope: 'live', capability: 'digital.thresholdVolts' },
  durationSeconds: { scope: 'next' },
  repeatIntervalSeconds: { scope: 'next', capability: 'modes.repeat' },
  loopSeconds: { scope: 'next', capability: 'modes.loop' },
  triggerEnableMask: { scope: 'live', capability: 'trigger' },
  triggerSource: { scope: 'live', capability: 'trigger' },
  digitalConditions: { scope: 'live', capability: 'trigger.digital' },
  analogConditions: { scope: 'live', capability: 'trigger.analog' },
  preTriggerPercent: { scope: 'live', capability: 'trigger.preTriggerMaxPercent' },
  testMode: { scope: 'live', capability: 'digital.testModes' },
};

/**
 * The `mayEdit` feature that decides whether a key can apply now. Exported so the UI
 * can show the same decision without re-deriving it.
 */
export const SETTING_EDIT_FEATURES: Readonly<Record<SettingKey, EditFeature>> = {
  mode: 'mode',
  channels: 'width',
  samplerate: 'rate',
  thresholdVolts: 'threshold',
  durationSeconds: 'duration',
  repeatIntervalSeconds: 'repeatInterval',
  loopSeconds: 'loopWindow',
  triggerEnableMask: 'triggerMask',
  triggerSource: 'triggerSource',
  digitalConditions: 'digitalConditions',
  analogConditions: 'analogCondition',
  preTriggerPercent: 'preTrigger',
  testMode: 'testMode',
};

/** Stable side-effect identifiers; the runtime maps each to one concrete action. */
export const SETTINGS_EFFECTS = [
  'persist-settings',
  'apply-live',
  'restart-required',
  'recompile-trigger',
  'disarm-trigger',
] as const;
export type SettingsEffect = (typeof SETTINGS_EFFECTS)[number];

export type SettingsFailureReason =
  | 'unsupported-profile'
  | 'edit-refused'
  | 'invalid-value'
  | 'trigger-plan';

export interface SettingsFailure {
  readonly ok: false;
  readonly reason: SettingsFailureReason;
  readonly detail: string;
  readonly field?: SettingKey;
}

export interface SettingsSuccess {
  readonly ok: true;
  /**
   * `current` with only the changed keys applied now: live-scope keys whose `mayEdit`
   * decision is `allow`, plus view/preference keys. Staged keys keep the current value.
   */
  readonly applied: CaptureConfig;
  /** The canonical configuration, including staged keys. */
  readonly next: CaptureConfig;
  /** The plan driving the active acquisition; null while idle or mask-off. */
  readonly activePlan: TriggerPlan | null;
  /** The plan the next acquisition will use; null while the mask is off. */
  readonly nextPlan: TriggerPlan | null;
  readonly effects: readonly SettingsEffect[];
  readonly pending: readonly SettingKey[];
}

export type SettingsResult = SettingsSuccess | SettingsFailure;

export type SettingsPatch = Partial<CaptureConfig>;

export interface SettingsCommitInput {
  readonly current: CaptureConfig;
  readonly patch: SettingsPatch;
  readonly profile: DeviceProfile;
  /** Negotiated link class; the transaction validates that the rate is actually offered. */
  readonly linkRate: LinkRate;
  readonly context: AcquisitionContext;
}

const LOOP_RETENTION_MAX_BYTES = 2 ** 31;
const LOOP_RETENTION_MAX_SAMPLES = 2 ** 30;

/**
 * The acquisition phases in which a compiled plan is driving (or about to drive) the
 * device. Only these phases can produce an `activePlan`; `idle` and the frozen phases
 * (`stopping`, `suspended`, `lost`) use the next plan only.
 */
const ACTIVE_ACQUISITION_STATES: ReadonlySet<AcquisitionState> = new Set<AcquisitionState>([
  'arming',
  'waiting',
  'running',
  'restarting',
  'retrying',
]);

/**
 * CaptureConfig fields that feed `compileTriggerPlan`. A change to any other field
 * (threshold, test mode, repeat interval, view/preference) never requires the active
 * trigger to be recompiled.
 */
const PLAN_INPUT_KEYS: readonly SettingKey[] = [
  'mode',
  'channels',
  'samplerate',
  'durationSeconds',
  'loopSeconds',
  'triggerEnableMask',
  'triggerSource',
  'digitalConditions',
  'analogConditions',
  'preTriggerPercent',
];

type MutableConfig = { -readonly [K in keyof CaptureConfig]: CaptureConfig[K] };

function failure(
  reason: SettingsFailureReason,
  detail: string,
  field?: SettingKey,
): SettingsFailure {
  return field === undefined
    ? { ok: false, reason, detail }
    : { ok: false, reason, detail, field };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => sameValue(value, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]),
    );
  }
  return false;
}

/** Copy a configuration so the result never aliases the caller's containers. */
function cloneConfig(config: CaptureConfig): MutableConfig {
  return {
    mode: config.mode,
    channels: config.channels,
    samplerate: config.samplerate,
    thresholdVolts: config.thresholdVolts,
    durationSeconds: config.durationSeconds,
    repeatIntervalSeconds: config.repeatIntervalSeconds,
    loopSeconds: config.loopSeconds,
    triggerEnableMask: config.triggerEnableMask,
    triggerSource: config.triggerSource,
    digitalConditions: config.digitalConditions.map((condition) => ({ ...condition })),
    analogConditions: config.analogConditions.map((condition) => ({ ...condition })),
    preTriggerPercent: config.preTriggerPercent,
    testMode: config.testMode,
  };
}

/**
 * `current` with only the keys in `appliedNow` replaced by their canonical `next`
 * value. Staged keys keep the value the active acquisition is already using, so a
 * pending edit cannot leak into the active plan.
 */
function appliedConfig(
  current: CaptureConfig,
  next: CaptureConfig,
  appliedNow: ReadonlySet<SettingKey>,
): CaptureConfig {
  const applied = cloneConfig(current);
  if (appliedNow.has('mode')) applied.mode = next.mode;
  if (appliedNow.has('channels')) applied.channels = next.channels;
  if (appliedNow.has('samplerate')) applied.samplerate = next.samplerate;
  if (appliedNow.has('thresholdVolts')) applied.thresholdVolts = next.thresholdVolts;
  if (appliedNow.has('durationSeconds')) applied.durationSeconds = next.durationSeconds;
  if (appliedNow.has('repeatIntervalSeconds')) {
    applied.repeatIntervalSeconds = next.repeatIntervalSeconds;
  }
  if (appliedNow.has('loopSeconds')) applied.loopSeconds = next.loopSeconds;
  if (appliedNow.has('triggerEnableMask')) {
    applied.triggerEnableMask = next.triggerEnableMask;
  }
  if (appliedNow.has('triggerSource')) applied.triggerSource = next.triggerSource;
  if (appliedNow.has('digitalConditions')) {
    applied.digitalConditions = next.digitalConditions.map((condition) => ({ ...condition }));
  }
  if (appliedNow.has('analogConditions')) {
    applied.analogConditions = next.analogConditions.map((condition) => ({ ...condition }));
  }
  if (appliedNow.has('preTriggerPercent')) {
    applied.preTriggerPercent = next.preTriggerPercent;
  }
  if (appliedNow.has('testMode')) applied.testMode = next.testMode;
  return applied;
}

/**
 * Merge a patch and carry the capture window across a mode change (§5.3). Switching
 * into Loop takes the new window from the current duration; switching out of Loop
 * takes the new duration from the current Loop window. Both stay in seconds: a
 * samplerate change in the same patch never rescales them. An explicit
 * `durationSeconds`/`loopSeconds` patch wins over the carried value.
 */
function mergePatch(current: CaptureConfig, patch: SettingsPatch): CaptureConfig {
  const merged: CaptureConfig = { ...current, ...patch };
  if (patch.mode !== undefined && patch.mode !== current.mode) {
    if (patch.mode === 'loop') {
      if (patch.loopSeconds === undefined) {
        return {
          ...merged,
          loopSeconds: patch.durationSeconds ?? current.durationSeconds,
        };
      }
    } else if (current.mode === 'loop' && patch.durationSeconds === undefined) {
      return {
        ...merged,
        durationSeconds: patch.loopSeconds ?? current.loopSeconds,
      };
    }
  }
  return merged;
}

/**
 * Largest post-trigger sample count whose pre-trigger prefix still fits the host
 * storage envelope: `post + floor(post * percent / 100) <= MAX_SAMPLES - 1`, using
 * the compiler's own floor/round rules. The estimate is exact for a fractional
 * prefix; the loop recovers the sample the floor frees when the split lands on an
 * integer. The count is the base window of every Single/Repeat plan.
 */
function maxPostSamplesFor(preTriggerPercent: number): number {
  const maxTotal = MAX_SAMPLES - 1;
  if (!(preTriggerPercent > 0)) return maxTotal;
  let post = Math.floor(maxTotal / (1 + preTriggerPercent / 100));
  if (post < 1) post = 1;
  while (
    post < maxTotal &&
    post + 1 + Math.floor(((post + 1) * preTriggerPercent) / 100) <= maxTotal
  ) {
    post++;
  }
  while (post > 1 && post + Math.floor((post * preTriggerPercent) / 100) > maxTotal) {
    post--;
  }
  return post;
}

/**
 * The discrete rates offered for a width on the negotiated link, or null when the
 * profile does not declare its table (hand-built test profiles). A tier without a
 * ceiling for the current link is an empty offer, never a fallback to another link.
 */
function offeredRatesFor(
  profile: DeviceProfile,
  channels: ChannelCount,
  linkRate: LinkRate,
): readonly number[] | null {
  const tier = profile.digital.rates.find((candidate) => candidate.channels === channels);
  if (tier === undefined) return [];
  const ceiling = tier.hz[linkRate];
  if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) return [];
  const table = profile.digital.sampleratesHz;
  return table === undefined ? null : table.filter((hz) => hz <= ceiling);
}

function maxLoopSamples(channels: ChannelCount): number {
  return Math.min(
    Math.floor(LOOP_RETENTION_MAX_BYTES / bytesPerSampleForChannels(channels)),
    LOOP_RETENTION_MAX_SAMPLES,
  );
}

/**
 * Merge, validate and clamp. Only the merged configuration is inspected: a profile
 * change can make a previously valid field invalid, and committing that configuration
 * would be a lie even if the field was not in the patch.
 */
function normalizeConfig(
  config: CaptureConfig,
  profile: DeviceProfile,
  linkRate: LinkRate,
): { ok: true; config: CaptureConfig } | SettingsFailure {
  const mode = config.mode;
  if (mode !== 'single' && mode !== 'repeat' && mode !== 'loop') {
    return failure('invalid-value', `unknown capture mode ${String(mode)}`, 'mode');
  }
  if (!profile.modes[mode]) {
    return failure(
      'unsupported-profile',
      `profile ${profile.id} does not support ${mode} captures`,
      'mode',
    );
  }

  const channels = config.channels;
  if (!isChannelCount(channels)) {
    return failure(
      'invalid-value',
      `channels must be one of 4/8/16/32/64/128, got ${String(channels)}`,
      'channels',
    );
  }
  if (!profile.digital.widths.includes(channels)) {
    return failure(
      'unsupported-profile',
      `profile ${profile.id} does not offer ${channels} digital channels; ` +
        `offered widths are ${profile.digital.widths.join(', ')}`,
      'channels',
    );
  }

  const samplerate = config.samplerate;
  if (!Number.isFinite(samplerate) || samplerate <= 0) {
    return failure(
      'invalid-value',
      `samplerate must be a positive finite number, got ${String(samplerate)}`,
      'samplerate',
    );
  }
  const offered = offeredRatesFor(profile, channels, linkRate);
  if (offered !== null && !offered.includes(samplerate)) {
    return failure(
      'unsupported-profile',
      `profile ${profile.id} does not offer ${samplerate} Hz at ${channels} channels on a ` +
        `${linkRate} link; offered rates are ${offered.join(', ') || '(none)'}`,
      'samplerate',
    );
  }
  if (offered === null) {
    const tier = profile.digital.rates.find((candidate) => candidate.channels === channels);
    const ceiling = tier?.hz[linkRate];
    if (ceiling === undefined) {
      return failure(
        'unsupported-profile',
        `profile ${profile.id} offers no ${linkRate} rate tier for ${channels} channels`,
        'samplerate',
      );
    }
    if (samplerate > ceiling) {
      return failure(
        'unsupported-profile',
        `profile ${profile.id} offers at most ${ceiling} Hz at ${channels} channels on a ` +
          `${linkRate} link; requested ${samplerate} Hz`,
        'samplerate',
      );
    }
  }

  const thresholdVolts = config.thresholdVolts;
  if (!Number.isFinite(thresholdVolts)) {
    return failure(
      'invalid-value',
      `thresholdVolts must be finite, got ${String(thresholdVolts)}`,
      'thresholdVolts',
    );
  }
  const thresholds = profile.digital.thresholdVolts;
  if (thresholds !== null &&
      !thresholds.some((candidate) => Object.is(candidate, thresholdVolts))) {
    return failure(
      'unsupported-profile',
      `profile ${profile.id} does not offer a ${thresholdVolts} V threshold; ` +
        `offered thresholds are ${thresholds.join(', ')}`,
      'thresholdVolts',
    );
  }

  const rawDuration = config.durationSeconds;
  if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
    return failure(
      'invalid-value',
      `durationSeconds must be a positive finite number, got ${String(rawDuration)}`,
      'durationSeconds',
    );
  }
  const requestedDurationSeconds = Math.max(rawDuration, 1 / samplerate);

  const repeatIntervalSeconds = config.repeatIntervalSeconds;
  if (!Number.isFinite(repeatIntervalSeconds) || repeatIntervalSeconds <= 0) {
    return failure(
      'invalid-value',
      `repeatIntervalSeconds must be a positive finite number, got ` +
        `${String(repeatIntervalSeconds)}`,
      'repeatIntervalSeconds',
    );
  }

  const rawLoopSeconds = config.loopSeconds;
  if (!Number.isFinite(rawLoopSeconds) || rawLoopSeconds <= 0) {
    return failure(
      'invalid-value',
      `loopSeconds must be a positive finite number, got ${String(rawLoopSeconds)}`,
      'loopSeconds',
    );
  }
  const maxLoopSeconds = maxLoopSamples(channels) / samplerate;
  const loopSeconds = Math.min(
    Math.max(rawLoopSeconds, 1 / samplerate),
    maxLoopSeconds,
  );

  const triggerEnableMask = config.triggerEnableMask;
  if (typeof triggerEnableMask !== 'boolean') {
    return failure(
      'invalid-value',
      `triggerEnableMask must be boolean, got ${String(triggerEnableMask)}`,
      'triggerEnableMask',
    );
  }

  const triggerSource = config.triggerSource;
  if (triggerSource !== 'digital' && triggerSource !== 'analog' && triggerSource !== 'mixed') {
    return failure(
      'invalid-value',
      `unknown trigger source ${String(triggerSource)}`,
      'triggerSource',
    );
  }

  const digitalConditions = config.digitalConditions;
  if (!Array.isArray(digitalConditions)) {
    return failure(
      'invalid-value',
      'digitalConditions must be an array',
      'digitalConditions',
    );
  }

  const analogConditions = config.analogConditions;
  if (!Array.isArray(analogConditions)) {
    return failure(
      'invalid-value',
      'analogConditions must be an array',
      'analogConditions',
    );
  }

  const rawPreTriggerPercent = config.preTriggerPercent;
  if (!Number.isFinite(rawPreTriggerPercent) || rawPreTriggerPercent < 0) {
    return failure(
      'invalid-value',
      `preTriggerPercent must be a finite non-negative number, got ` +
        `${String(rawPreTriggerPercent)}`,
      'preTriggerPercent',
    );
  }
  const profileMaxPercent = Number.isFinite(profile.trigger.preTriggerMaxPercent)
    ? Math.max(0, Math.min(100, profile.trigger.preTriggerMaxPercent))
    : 0;
  const preTriggerPercent = Math.min(rawPreTriggerPercent, profileMaxPercent);

  // The pre-trigger prefix is retained in addition to the post-trigger budget, so a
  // Single/Repeat duration is bounded by the whole host envelope. A Loop is a sliding
  // window, not an additive budget, and keeps the plain envelope bound.
  const durationSeconds = mode === 'loop'
    ? Math.min(requestedDurationSeconds, (MAX_SAMPLES - 1) / samplerate)
    : Math.min(requestedDurationSeconds, maxPostSamplesFor(preTriggerPercent) / samplerate);

  const testMode = config.testMode;
  if (testMode !== 0 && testMode !== 1 && testMode !== 2) {
    return failure(
      'invalid-value',
      `testMode must be 0, 1 or 2, got ${String(testMode)}`,
      'testMode',
    );
  }
  if (!profile.digital.testModes.includes(testMode)) {
    return failure(
      'unsupported-profile',
      `profile ${profile.id} does not offer test mode ${testMode}`,
      'testMode',
    );
  }

  const next: MutableConfig = {
    mode,
    channels,
    samplerate,
    thresholdVolts,
    durationSeconds,
    repeatIntervalSeconds,
    loopSeconds,
    triggerEnableMask,
    triggerSource,
    digitalConditions: digitalConditions.map((condition) => ({ ...condition })),
    analogConditions: analogConditions.map((condition) => ({ ...condition })),
    preTriggerPercent,
    testMode,
  };
  return { ok: true, config: next };
}

interface PlanBudget {
  postTrigger: TriggerBudget;
  loop?: TriggerPlanLoop;
}

/** See the module header: how each mode's requested budget maps onto the plan. */
function planBudgetFor(config: CaptureConfig): PlanBudget {
  if (config.mode === 'loop') {
    return {
      postTrigger: { kind: 'unlimited' },
      loop: {
        seconds: config.loopSeconds,
        anchor: config.triggerEnableMask ? 'trigger' : 'free',
      },
    };
  }
  return { postTrigger: { kind: 'time', value: config.durationSeconds } };
}

function triggerPlanField(
  reason: TriggerPlanFailureReason,
  config: CaptureConfig,
): SettingKey {
  switch (reason) {
    case 'mask-off':
      return 'triggerEnableMask';
    case 'no-conditions':
      return config.triggerSource === 'analog'
        ? 'analogConditions'
        : config.triggerSource === 'mixed'
          ? 'triggerSource'
          : 'digitalConditions';
    case 'unsupported-digital':
      return 'digitalConditions';
    case 'unsupported-analog':
      return 'analogConditions';
    case 'mixed-unsupported':
      return 'triggerSource';
    case 'pre-trigger-cap':
      return 'preTriggerPercent';
    case 'invalid-budget':
      return config.mode === 'loop' ? 'loopSeconds' : 'durationSeconds';
    case 'unsupported-mode':
      return config.mode === 'loop' ? 'mode' : 'triggerSource';
  }
}

function compilePlan(
  config: CaptureConfig,
  profile: DeviceProfile,
): { ok: true; plan: TriggerPlan } | SettingsFailure {
  const budget = planBudgetFor(config);
  const result = compileTriggerPlan({
    profile,
    enableMask: config.triggerEnableMask,
    source: config.triggerSource,
    digital: config.digitalConditions,
    analog: config.analogConditions,
    preTriggerPercent: config.preTriggerPercent,
    postTrigger: budget.postTrigger,
    ...(budget.loop === undefined ? {} : { loop: budget.loop }),
    capture: { samplerate: config.samplerate, channels: config.channels },
    // No clock input: a fixed stamp keeps the transaction deterministic.
    compiledAt: 0,
  });
  if (!result.ok) {
    return failure(
      'trigger-plan',
      `${result.reason}: ${result.detail}`,
      triggerPlanField(result.reason, config),
    );
  }
  return { ok: true, plan: result.plan };
}

function changedKeys(current: CaptureConfig, next: CaptureConfig): SettingKey[] {
  return SETTING_KEYS.filter((key) => !sameValue(current[key], next[key]));
}

/**
 * Commit one field patch. Pure, deterministic and never throws for a typed input:
 * every refusal is a value with a stable reason and the offending field when one can
 * be named.
 */
export function commitSettings(input: SettingsCommitInput): SettingsResult {
  const { current, patch, profile, linkRate, context } = input;

  // 1. Merge, carrying the capture window across a bare mode switch (§5.3).
  // Array copies happen in normalization, so the result never aliases the caller's
  // containers.
  const merged = mergePatch(current, patch);

  // 2. Validate/clamp against the profile.
  const normalized = normalizeConfig(merged, profile, linkRate);
  if (!normalized.ok) return normalized;

  const next = normalized.config;
  const changed = changedKeys(current, next);

  // 3. Apply the edit policy in canonical key order; the first refusal wins and no
  // part of the patch is committed.
  const pending: SettingKey[] = [];
  const appliedNow = new Set<SettingKey>();
  let liveApplied = false;
  let restartRequired = false;
  for (const key of changed) {
    const decision = mayEdit(SETTING_EDIT_FEATURES[key], context);
    if (decision.kind === 'refuse') {
      return failure('edit-refused', decision.reason, key);
    }
    if (decision.kind === 'next' || decision.kind === 'restart') {
      pending.push(key);
      if (decision.kind === 'restart') restartRequired = true;
      continue;
    }
    switch (SETTING_POLICIES[key].scope) {
      case 'live':
        appliedNow.add(key);
        liveApplied = true;
        break;
      case 'next':
        // Host-side budget/scheduling never reconfigures the active device.
        pending.push(key);
        break;
      case 'view':
      case 'preference':
        // These do not touch the acquisition; the canonical value changes and the
        // runtime persists/relayouts it.
        appliedNow.add(key);
        break;
    }
  }
  const applied = appliedConfig(current, next, appliedNow);

  // 4. Compile the next plan whenever the canonical mask is armed. While armed this
  // also refreshes the pre-trigger window after a rate/duration/Loop-window change.
  let nextPlan: TriggerPlan | null = null;
  if (next.triggerEnableMask) {
    const compiled = compilePlan(next, profile);
    if (!compiled.ok) return compiled;
    nextPlan = compiled.plan;
  }

  // 5. Compile the active plan from what the active acquisition may actually use.
  // Pending edits stay out of it, so they cannot leak into the running trigger.
  const active = ACTIVE_ACQUISITION_STATES.has(context.acquisition);
  let activePlan: TriggerPlan | null = null;
  if (active && applied.triggerEnableMask) {
    const compiled = compilePlan(applied, profile);
    if (!compiled.ok) return compiled;
    activePlan = compiled.plan;
  }

  // 6. Declare the stable side effects of the accepted transaction.
  const effects: SettingsEffect[] = [];
  if (changed.length > 0) effects.push('persist-settings');
  if (liveApplied) effects.push('apply-live');
  if (restartRequired) effects.push('restart-required');
  const planInputsChanged = PLAN_INPUT_KEYS.some(
    (key) => !sameValue(current[key], applied[key]),
  );
  if (activePlan !== null && planInputsChanged) effects.push('recompile-trigger');
  if (active && current.triggerEnableMask && !applied.triggerEnableMask) {
    effects.push('disarm-trigger');
  }

  return { ok: true, applied, next, activePlan, nextPlan, effects, pending };
}
