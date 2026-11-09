// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Production host executor adapter for a compiled `TriggerPlan`
 * (docs/ARCHITECTURE.md §5.1).
 *
 * A host plan runs in `dsp` on complete samples. This module maps one digital
 * `TriggerPlan` onto the bounded `SoftwareTrigger` matcher and exposes it as a small
 * byte-stream executor. It owns no device, DOM, timer or storage: the caller feeds
 * transfer fragments as they arrive and consumes emitted byte ranges synchronously.
 *
 * ## Plan mapping
 *
 * - Only `execution: 'host'` plans are executable here: a `'device'` plan is downloaded
 *   to the firmware, so passing one is a wiring bug and is refused. Only
 *   `source: 'digital'` is supported; analog and mixed plans need the M1 analog executor
 *   and are refused with a typed reason. When that mapping lands it must pass the
 *   matcher's qualification explicitly: `analogHysteresis` = the larger of the ADC's
 *   code hysteresis and the plan's `hysteresis` volts in codes, and
 *   `analogArtifactSamples` = W = `ceil(240 ns * samplerate)`, the longest OR-artifact
 *   run the matcher may reject (`analogTriggerQualification` in `ui/channelBanks.ts`
 *   holds both constants). The matcher's own defaults (4 codes, W = 1: no artifact
 *   rejection) are for direct callers, not for plans.
 * - A condition's `signal` is resolved to a channel by `resolveChannel`, or by the
 *   default `d<index>` convention (the same one the SimDriver uses). An unresolved or
 *   out-of-range signal is refused.
 * - `level`/`high`/`low` all become a `SoftwareTrigger` `level` condition: `high` is
 *   level 1, `low` is level 0, and a bare `level` defaults to 1 (the compiler's default).
 *   `rising`, `falling` and `edge` map unchanged. Conditions are ANDed on one complete
 *   sample, as the plan states.
 * - `preTrigger.samples` is authoritative when present, but the effective prefix is
 *   still capped by `capBytes / bytesPerSample`; a plan whose exact byte position does
 *   not equal `samples * bytesPerSample` (and is not marked `capBytesIsBound`) is
 *   malformed and refused. Otherwise the prefix is the smaller of
 *   `round(seconds * samplerate)` and `floor(capBytes / bytesPerSample)`: both are bounds
 *   in that case (and `capBytesIsBound` says the byte cap is only the profile's hard
 *   bound), so the smaller bound is the only safe prefix. The resulting allocation is
 *   refused above `MAX_SOFTWARE_TRIGGER_PREFIX_BYTES`.
 * - `budget.kind: 'samples'` is the post-trigger span. `'time'` is converted with
 *   `Math.round(seconds * samplerate)`, at least one sample. `'unlimited'` is Infinity.
 *   The matcher's `maxSamples` is the total emitted stream: `preTriggerSamples +
 *   postTriggerSamples`, or Infinity for an unlimited budget. This is the §5.1 rule:
 *   a finite acquisition retires pre + post samples in total. Because the matcher holds
 *   matches off until the pre-trigger window is full (below), the split is exactly
 *   `pre` before T and `post` from T onward.
 * - A plan with `loop` maps to the matcher's `continuous` mode; without `loop` it is
 *   `one-shot` (Single and each Repeat sweep). Only a trigger-anchored Loop is
 *   executable here: the matcher always waits for the first match before emitting, so a
 *   `free` anchor (which never waits) is refused. The adapter does not enforce the Loop
 *   window `loop.seconds`; §5.1 leaves that to the acquisition executor's `dropBefore`.
 * - `reconfigure()` applies a recompiled plan while the matcher is waiting or live and
 *   keeps the retained prefix; changing the capture shape (width, prefix, total budget
 *   or mode) is refused because that requires a named restart.
 *
 * ## Coordinates and chunk semantics
 *
 * `feed()` accepts arbitrary byte fragments. Bytes at the end that do not form a whole
 * sample are retained (at most `bytesPerSample - 1`) and joined with the next fragment,
 * so every matching decision is made on complete samples and a sample split across two
 * transfers still matches exactly once. Emitted ranges are always whole samples: a
 * multiple of `bytesPerSample` bytes, encoded little-endian like the device stream.
 *
 * `emit` is called synchronously from `feed()`, and a chunk may alias the caller's
 * buffer, so the sink must consume or copy it before returning. A feed must not re-enter
 * the executor.
 *
 * T (`onMatch.index`, `triggerSampleIndex`) is a zero-based index in the **emitted**
 * stream, in complete samples, not a device-stream index and not a byte offset. The
 * emitted stream starts at the retained prefix. The matcher applies a pre-fill holdoff:
 * a match is accepted only once `preTrigger` complete samples have been fed since arming
 * (so `deviceT >= preTrigger`), and therefore T always equals `preTrigger` - a dense
 * trigger signal cannot fire on the first edge after arm with an empty prefix.
 * `noteGap()`/`resetContinuity()` deliberately clear the ring, restart the holdoff and
 * restart emitted-stream accounting at the first sample retained after the
 * discontinuity, so the delivered prefix never spans a gap; a caller that positions store
 * chunks after a dropout must use the emitted coordinate, not the absolute device
 * coordinate. A retune (`reconfigure()`) keeps the ring and does not restart the
 * holdoff. Holdoff samples count toward `searchLimitSamples`. With a zero pre-trigger window
 * T is always 0 even when the match happens much later in the fed stream; use
 * `stats.inspectedSamples` to recover how many samples were searched. The caller that
 * knows the stream origin adds it to obtain an absolute position.
 *
 * The first match is reported after the trigger sample has been handed to `emit`. In
 * continuous (Loop) mode later matches are reported for every matching sample, using
 * the same emitted-stream numbering, while the surrounding block is being scanned (it
 * may be emitted just after the callback). `stats.matchCount` counts all of them.
 *
 * ## Boundedness
 *
 * Waiting retains only the fixed pre-trigger ring; no search prefix grows. The search
 * budget defaults to `Infinity` (wait until a match, `finish()` or a transport stop), so
 * a Single capture behaves like the established mode policy. A caller that needs a
 * finite search (Repeat uses one sweep) passes `searchLimitSamples`; the acquisition
 * adapter must mirror `triggerSearchSamples(mode, maxSamples)`. `finish()`/`noteGap()`/
 * `resetContinuity()` are exposed for a caller-driven stop and transport
 * discontinuities.
 *
 * This module deliberately imports no DOM, device, store or UI code; it is usable in a
 * worker or a deterministic self-test.
 */

import {
  MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
  SoftwareTrigger,
  type SoftwareTriggerCondition,
  type SoftwareTriggerConfig,
  type SoftwareTriggerMode,
  type SoftwareTriggerOptions,
  type SoftwareTriggerStats,
} from '../data/softwareTrigger.js';
import type { TriggerKind } from '../device/profileTypes.js';
import { bytesPerSampleForChannels, isChannelCount, type ChannelCount } from '../types.js';
import type { TriggerCondition, TriggerPlan } from './triggerPlan.js';
import { TRIGGER_KINDS } from './triggerPlan.js';

export type HostTriggerErrorCode =
  | 'invalid-options'
  | 'invalid-plan'
  | 'device-execution'
  | 'unsupported-source'
  | 'unsupported-condition'
  | 'no-conditions'
  | 'unknown-signal'
  | 'unsupported-channels'
  | 'invalid-samplerate'
  | 'invalid-pre-trigger'
  | 'pre-trigger-too-large'
  | 'invalid-budget'
  | 'invalid-search-limit'
  | 'unsupported-loop-anchor'
  | 'reconfigure-refused'
  | 'invalid-chunk';

/** Typed refusal. Callers branch on `code`, never on the message. */
export class HostTriggerError extends Error {
  readonly code: HostTriggerErrorCode;

  constructor(code: HostTriggerErrorCode, message: string) {
    super(message);
    this.name = 'HostTriggerError';
    this.code = code;
  }
}

/** One reported match. `index` is T in emitted-stream samples (see the module header). */
export interface HostTriggerMatch {
  readonly index: number;
  /** 1 in one-shot mode; the running match count in continuous (Loop) mode. */
  readonly count: number;
}

export interface HostTriggerOptions {
  readonly plan: TriggerPlan;
  /** Capture width of the stream fed to `feed()`. */
  readonly channels: ChannelCount;
  /** Sample rate of the stream; used only to convert time budgets and seconds. */
  readonly samplerate: number;
  /** Consumes one whole-sample byte range synchronously; it may alias the fed buffer. */
  readonly emit: (chunk: Uint8Array) => void;
  /** Called for every reported match. */
  readonly onMatch?: (match: HostTriggerMatch) => void;
  /**
   * Resolve a plan signal name to a digital channel. Defaults to `d<index>`.
   * The result must be an integer inside the configured width.
   */
  readonly resolveChannel?: (signal: string) => number | null;
  /**
   * Maximum complete samples inspected while waiting for a match. Defaults to
   * `Infinity` (wait until a match, `finish()` or a transport stop); the acquisition
   * adapter should pass the mode policy, e.g. `maxSamples` for a Repeat sweep.
   */
  readonly searchLimitSamples?: number;
}

export type HostTriggerStats = SoftwareTriggerStats;

function fail(code: HostTriggerErrorCode, message: string): never {
  throw new HostTriggerError(code, message);
}

function isTriggerMode(value: unknown): value is TriggerKind {
  return TRIGGER_KINDS.includes(value as TriggerKind);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Default signal convention, shared with the SimDriver: `d0`, `d1`, ... */
function defaultChannelForSignal(signal: string): number | null {
  const match = /^d(\d+)$/.exec(signal);
  if (match === null) return null;
  const channel = Number(match[1]);
  return Number.isSafeInteger(channel) ? channel : null;
}

/**
 * Resolve one digital plan condition to the matcher's condition form. `high`/`low` are
 * the level polarity spellings; a bare `level` defaults to 1 exactly like the compiler.
 */
function mapCondition(
  raw: unknown,
  channels: number,
  resolveChannel: (signal: string) => number | null,
): SoftwareTriggerCondition {
  if (raw === null || typeof raw !== 'object') {
    fail('unsupported-condition', 'a trigger condition must be an object');
  }
  const condition = raw as TriggerCondition;
  if (condition.kind !== 'digital') {
    fail(
      'unsupported-source',
      `host execution supports digital conditions only, got a ${String(condition.kind)} condition`,
    );
  }
  if (typeof condition.signal !== 'string' || condition.signal.trim().length === 0) {
    fail('unsupported-condition', 'a digital condition needs a non-empty signal name');
  }
  if (!isTriggerMode(condition.mode)) {
    fail(
      'unsupported-condition',
      `unknown digital trigger mode ${String(condition.mode)} on ${condition.signal}`,
    );
  }
  const mode = condition.mode;
  const level = condition.level;
  if (level !== undefined && level !== 0 && level !== 1) {
    fail(
      'unsupported-condition',
      `condition level on ${condition.signal} must be 0 or 1, got ${String(level)}`,
    );
  }
  if ((mode === 'high' && level === 0) || (mode === 'low' && level === 1)) {
    fail(
      'unsupported-condition',
      `${condition.signal} requests ${mode} with contradictory level ${String(level)}`,
    );
  }
  const channel = resolveChannel(condition.signal);
  if (channel === null || !Number.isInteger(channel) || channel < 0 || channel >= channels) {
    fail(
      'unknown-signal',
      `signal ${condition.signal} does not resolve to a channel inside 0..${channels - 1}`,
    );
  }
  switch (mode) {
    case 'high':
      return { channel, kind: 'level', level: 1 };
    case 'low':
      return { channel, kind: 'level', level: 0 };
    case 'level':
      return { channel, kind: 'level', level: level ?? 1 };
    case 'rising':
    case 'falling':
    case 'edge':
      return { channel, kind: mode };
    default:
      return fail('unsupported-condition', `unsupported digital mode ${String(mode)}`);
  }
}

/**
 * Convert the plan budget to the matcher's post-trigger span (samples, or Infinity).
 * A time budget is quantized with `Math.round` like the compiler's own base window, and
 * never to less than one sample.
 */
function resolvePostTriggerSamples(budget: TriggerPlan['budget'], samplerate: number): number {
  if (budget === null || typeof budget !== 'object') {
    fail('invalid-budget', 'the plan budget must be an object');
  }
  switch (budget.kind) {
    case 'samples':
      if (!Number.isSafeInteger(budget.value) || budget.value < 1) {
        fail(
          'invalid-budget',
          `samples budget must be a positive safe integer, got ${String(budget.value)}`,
        );
      }
      return budget.value;
    case 'time': {
      if (!Number.isFinite(budget.value) || budget.value <= 0) {
        fail(
          'invalid-budget',
          `time budget must be a positive finite number of seconds, got ${String(budget.value)}`,
        );
      }
      const samples = Math.round(budget.value * samplerate);
      if (!Number.isSafeInteger(samples)) {
        fail(
          'invalid-budget',
          `time budget ${budget.value} s at ${samplerate} Hz is outside the sample envelope`,
        );
      }
      return Math.max(1, samples);
    }
    case 'unlimited':
      return Number.POSITIVE_INFINITY;
    default:
      return fail(
        'invalid-budget',
        `unknown budget kind ${String((budget as { kind?: unknown }).kind)}`,
      );
  }
}

/**
 * Resolve the effective whole-sample pre-trigger prefix.
 *
 * `preTrigger.samples` is authoritative. Without it, both remaining forms are bounds:
 * `seconds` is a duration the compiler derived from a percentage, and `capBytes` may be
 * the profile's hard cap (`capBytesIsBound`) rather than T's position. Taking the smaller
 * bound cannot retain more history than the plan allows and never overstates T.
 */
function resolvePreTriggerSamples(
  preTrigger: TriggerPlan['preTrigger'],
  bytesPerSample: number,
  samplerate: number,
): number {
  if (preTrigger === null || typeof preTrigger !== 'object') {
    fail('invalid-pre-trigger', 'the plan preTrigger must be an object');
  }
  if (!Number.isFinite(preTrigger.seconds) || preTrigger.seconds < 0) {
    fail(
      'invalid-pre-trigger',
      `preTrigger.seconds must be a finite non-negative number, got ${String(preTrigger.seconds)}`,
    );
  }
  if (!Number.isFinite(preTrigger.capBytes) || preTrigger.capBytes < 0) {
    fail(
      'invalid-pre-trigger',
      `preTrigger.capBytes must be a finite non-negative number, got ${String(preTrigger.capBytes)}`,
    );
  }
  if (preTrigger.samples !== undefined) {
    if (!isSafeCount(preTrigger.samples)) {
      fail(
        'invalid-pre-trigger',
        `preTrigger.samples must be a non-negative safe integer, got ${String(preTrigger.samples)}`,
      );
    }
    const byBytes = Math.floor(preTrigger.capBytes / bytesPerSample);
    if (!isSafeCount(byBytes)) {
      fail(
        'invalid-pre-trigger',
        `preTrigger.capBytes ${preTrigger.capBytes} is outside the sample envelope`,
      );
    }
    // The compiler's capBytes is exactly samples * bytesPerSample. A hand-built plan
    // that claims a different position is malformed; a bound-only capBytes is trusted
    // as an upper bound and the smaller value wins.
    if (preTrigger.capBytesIsBound !== true &&
        preTrigger.capBytes !== preTrigger.samples * bytesPerSample) {
      fail(
        'invalid-pre-trigger',
        `preTrigger.capBytes ${preTrigger.capBytes} does not match ${preTrigger.samples} ` +
          `samples at ${bytesPerSample} bytes/sample`,
      );
    }
    return Math.min(preTrigger.samples, byBytes);
  }
  const bySeconds = Math.round(preTrigger.seconds * samplerate);
  if (!isSafeCount(bySeconds)) {
    fail(
      'invalid-pre-trigger',
      `preTrigger.seconds ${preTrigger.seconds} s at ${samplerate} Hz is outside the sample envelope`,
    );
  }
  const byBytes = Math.floor(preTrigger.capBytes / bytesPerSample);
  if (!isSafeCount(byBytes)) {
    fail(
      'invalid-pre-trigger',
      `preTrigger.capBytes ${preTrigger.capBytes} is outside the sample envelope`,
    );
  }
  return Math.min(bySeconds, byBytes);
}

/**
 * A host trigger executor: one plan, one stream, bounded matching in
 * `SoftwareTrigger`. Construction validates and resolves the plan; `feed()` is the
 * only pump and never schedules work.
 */
export class HostTrigger {
  private activePlan: TriggerPlan;
  readonly channels: ChannelCount;
  readonly samplerate: number;
  readonly bytesPerSample: number;
  /** Effective whole-sample prefix retained before T. */
  readonly preTriggerSamples: number;
  /** Requested post-trigger span in samples; Infinity for an unlimited budget. */
  readonly postTriggerSamples: number;
  /** Total emitted samples (pre + post); Infinity for an unlimited budget. */
  readonly maxSamples: number;
  readonly mode: SoftwareTriggerMode;

  private readonly matcher: SoftwareTrigger;
  private readonly resolveChannel: (signal: string) => number | null;

  /** The plan currently driving the matcher; replaced only by `reconfigure()`. */
  get plan(): TriggerPlan {
    return this.activePlan;
  }

  constructor(options: HostTriggerOptions) {
    if (options === null || typeof options !== 'object') {
      fail('invalid-options', 'HostTrigger options must be an object');
    }
    if (typeof options.emit !== 'function') {
      fail('invalid-options', 'HostTrigger requires an emit(chunk) callback');
    }
    const plan = options.plan;
    if (plan === null || typeof plan !== 'object') {
      fail('invalid-plan', 'the plan must be an object');
    }
    const channels = options.channels;
    if (!isChannelCount(channels)) {
      fail(
        'unsupported-channels',
        `channels must be one of 4, 8, 16, 32, 64, 128, got ${String(channels)}`,
      );
    }
    if (!Number.isFinite(options.samplerate) || options.samplerate <= 0) {
      fail(
        'invalid-samplerate',
        `samplerate must be a positive finite number, got ${String(options.samplerate)}`,
      );
    }
    const samplerate = options.samplerate;
    const resolveChannel = options.resolveChannel ?? defaultChannelForSignal;
    if (typeof resolveChannel !== 'function') {
      fail('invalid-options', 'resolveChannel must be a function when present');
    }
    if (options.onMatch !== undefined && typeof options.onMatch !== 'function') {
      fail('invalid-options', 'onMatch must be a function when present');
    }

    // A device plan belongs to the firmware; running it here would match in the wrong
    // stream. The compiler owns profile capability checks; this adapter only refuses
    // plan shapes it cannot execute.
    if (plan.execution === 'device') {
      fail(
        'device-execution',
        'the plan is device-executed; the host executor accepts only execution: host',
      );
    }
    if (plan.execution !== 'host') {
      fail('invalid-plan', `unknown plan execution ${String(plan.execution)}`);
    }
    if (plan.source === 'analog' || plan.source === 'mixed') {
      fail(
        'unsupported-source',
        `host execution supports digital plans only; ${plan.source} plans need the M1 ` +
          'analog executor',
      );
    }
    if (plan.source !== 'digital') {
      fail('invalid-plan', `unknown plan source ${String(plan.source)}`);
    }
    if (!Array.isArray(plan.conditions) || plan.conditions.length === 0) {
      if (Array.isArray(plan.conditions)) {
        fail('no-conditions', 'the plan has no trigger condition');
      }
      fail('invalid-plan', 'plan.conditions must be an array');
    }

    const bytesPerSample = bytesPerSampleForChannels(channels);
    // An index loop, not map: a sparse conditions array must become a typed refusal,
    // never a TypeError from the matcher's property lookup.
    const conditions: SoftwareTriggerCondition[] = [];
    for (let i = 0; i < plan.conditions.length; i++) {
      const condition = plan.conditions[i];
      if (condition === undefined) {
        fail('unsupported-condition', `plan.conditions[${i}] is a missing array entry`);
      }
      conditions.push(mapCondition(condition, channels, resolveChannel));
    }

    const postTriggerSamples = resolvePostTriggerSamples(plan.budget, samplerate);

    let mode: SoftwareTriggerMode = 'one-shot';
    if (plan.loop !== undefined) {
      const loop = plan.loop;
      if (loop === null || typeof loop !== 'object') {
        fail('invalid-plan', 'plan.loop must be an object when present');
      }
      if (loop.anchor !== 'trigger' && loop.anchor !== 'free') {
        fail('invalid-plan', `unknown Loop anchor ${String(loop.anchor)}`);
      }
      if (loop.anchor === 'free') {
        fail(
          'unsupported-loop-anchor',
          'a free-anchored Loop never waits for a match; the host matcher emits only ' +
            'from the first match, so only anchor: trigger is executable',
        );
      }
      if (plan.budget.kind !== 'unlimited') {
        fail(
          'invalid-budget',
          'a Loop plan must have an unlimited post-trigger budget, as the compiler requires',
        );
      }
      if (!Number.isFinite(loop.seconds) || loop.seconds <= 0) {
        fail(
          'invalid-plan',
          `loop.seconds must be a positive finite number, got ${String(loop.seconds)}`,
        );
      }
      // The matcher's continuous mode reports every later match on the same emitted
      // stream. The Loop window itself (loop.seconds) is enforced by the acquisition
      // executor with dropBefore, not by this matcher.
      mode = 'continuous';
    }

    const preTriggerSamples = resolvePreTriggerSamples(
      plan.preTrigger, bytesPerSample, samplerate,
    );
    const maxPrefixSamples = Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSample);
    if (preTriggerSamples > maxPrefixSamples) {
      fail(
        'pre-trigger-too-large',
        `preTriggerSamples ${preTriggerSamples} at ${bytesPerSample} bytes/sample exceeds ` +
          `the ${MAX_SOFTWARE_TRIGGER_PREFIX_BYTES}-byte bounded prefix`,
      );
    }

    let maxSamples: number;
    if (postTriggerSamples === Number.POSITIVE_INFINITY) {
      maxSamples = Number.POSITIVE_INFINITY;
    } else {
      maxSamples = preTriggerSamples + postTriggerSamples;
      if (!Number.isSafeInteger(maxSamples)) {
        fail(
          'invalid-budget',
          `${preTriggerSamples} pre + ${postTriggerSamples} post samples is outside the ` +
            'sample envelope',
        );
      }
    }

    let searchLimitSamples = Number.POSITIVE_INFINITY;
    const requestedSearch = options.searchLimitSamples;
    if (requestedSearch !== undefined) {
      if (requestedSearch !== Number.POSITIVE_INFINITY &&
          (!Number.isSafeInteger(requestedSearch) || requestedSearch < 1)) {
        fail(
          'invalid-search-limit',
          `searchLimitSamples must be a positive safe integer or Infinity, got ` +
            `${String(requestedSearch)}`,
        );
      }
      searchLimitSamples = requestedSearch;
    }

    const config: SoftwareTriggerConfig = {
      channels,
      conditions,
      preTriggerSamples,
      maxSamples,
      mode,
      searchLimitSamples,
    };
    const emit = options.emit;
    const onMatch = options.onMatch;
    const matcherOptions: SoftwareTriggerOptions = {
      config,
      emit,
      ...(onMatch === undefined
        ? {}
        : { onMatch: (match) => onMatch({ index: match.index, count: match.count }) }),
    };

    this.activePlan = plan;
    this.channels = channels;
    this.samplerate = samplerate;
    this.bytesPerSample = bytesPerSample;
    this.preTriggerSamples = preTriggerSamples;
    this.postTriggerSamples = postTriggerSamples;
    this.maxSamples = maxSamples;
    this.mode = mode;
    this.resolveChannel = resolveChannel;
    this.matcher = new SoftwareTrigger(matcherOptions);
  }

  /** True while the matcher is still searching for its first match. */
  get waiting(): boolean {
    return this.matcher.waiting;
  }

  /** Whether the finite total budget has been emitted (never true for unlimited). */
  get complete(): boolean {
    return this.matcher.stats.complete;
  }

  /** True after `finish()` (or the search budget) ended a capture before a match. */
  get noTrigger(): boolean {
    return this.matcher.stats.noTrigger;
  }

  /** T in emitted-stream samples, or null before the first match. */
  get triggerSampleIndex(): number | null {
    return this.matcher.stats.triggerSampleIndex;
  }

  /** A snapshot of the matcher's counters; see `SoftwareTriggerStats`. */
  get stats(): HostTriggerStats {
    return this.matcher.stats;
  }

  /**
   * Feed an arbitrary transfer fragment. A trailing partial sample is carried to the
   * next call. Matching and `emit` are synchronous; see the module header.
   */
  feed(fragment: Uint8Array): void {
    if (!(fragment instanceof Uint8Array)) {
      fail('invalid-chunk', 'feed requires a Uint8Array fragment');
    }
    this.matcher.feed(fragment);
  }

  /**
   * Apply a recompiled plan while the matcher is still waiting (one-shot) or live
   * (continuous Loop). The capture shape (channels, prefix, total budget, mode) is fixed;
   * a plan that changes any of it is refused with a typed error and the caller must
   * restart. Conditions and other scan inputs are delegated to the bounded matcher,
   * which keeps the retained prefix, carried partial sample and inspected budget.
   * Returns false when the matcher is terminal (matched one-shot or finished).
   */
  reconfigure(next: TriggerPlan): boolean {
    if (next === null || typeof next !== 'object') {
      fail('invalid-plan', 'the replacement plan must be an object');
    }
    if (next.execution !== 'host') {
      fail(
        next.execution === 'device' ? 'device-execution' : 'invalid-plan',
        'only a host-executed plan can retune this executor',
      );
    }
    if (next.source !== 'digital') {
      fail('unsupported-source', 'host execution supports digital plans only');
    }
    if (!Array.isArray(next.conditions) || next.conditions.length === 0) {
      fail('no-conditions', 'the replacement plan has no trigger condition');
    }
    const conditions: SoftwareTriggerCondition[] = [];
    for (let i = 0; i < next.conditions.length; i++) {
      const condition = next.conditions[i];
      if (condition === undefined) {
        fail('unsupported-condition', `replacement conditions[${i}] is a missing array entry`);
      }
      conditions.push(mapCondition(condition, this.channels, this.resolveChannel));
    }
    const preTriggerSamples = resolvePreTriggerSamples(
      next.preTrigger, this.bytesPerSample, this.samplerate,
    );
    const postTriggerSamples = resolvePostTriggerSamples(next.budget, this.samplerate);
    const maxSamples = postTriggerSamples === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : preTriggerSamples + postTriggerSamples;
    const mode: SoftwareTriggerMode = next.loop === undefined ? 'one-shot' : 'continuous';
    if (next.loop !== undefined) {
      if (next.loop.anchor !== 'trigger') {
        fail(
          'unsupported-loop-anchor',
          'only a trigger-anchored Loop can retune a host matcher',
        );
      }
      if (next.budget.kind !== 'unlimited') {
        fail('invalid-budget', 'a Loop plan must have an unlimited post-trigger budget');
      }
    }
    if (mode !== this.mode || preTriggerSamples !== this.preTriggerSamples ||
        maxSamples !== this.maxSamples) {
      fail(
        'reconfigure-refused',
        'a retune cannot change the capture shape (mode, prefix or total budget); ' +
          'restart the acquisition instead',
      );
    }
    const accepted = this.matcher.reconfigure({
      channels: this.channels,
      conditions,
      preTriggerSamples: this.preTriggerSamples,
      maxSamples: this.maxSamples,
      mode: this.mode,
    });
    if (accepted) this.activePlan = next;
    return accepted;
  }

  /** End a capture that stopped before a match; the prefix is discarded. Idempotent. */
  finish(): void {
    this.matcher.finish();
  }

  /** A transport gap invalidates a transition across it; matching resumes bounded. */
  resetContinuity(): void {
    this.matcher.resetContinuity();
  }

  /** Account for `samples` lost to a transport gap without bridging the discontinuity. */
  noteGap(samples: number): void {
    this.matcher.noteGap(samples);
  }
}
