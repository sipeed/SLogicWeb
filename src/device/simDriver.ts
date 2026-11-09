// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Deterministic M0 SimDriver (docs/ARCHITECTURE.md §3.4).
 *
 * A device-shaped sample source with no WebUSB, DOM or wall-clock dependency. The same
 * profile, config, seed and fault list always produce the same bytes and the same state
 * transitions, so contract and UI tests can step the stream by hand.
 *
 * ## Host-driven model
 *
 * `start()` performs the handshake and then returns; it does not generate samples by
 * itself. `step(samples)` is the only pump: it advances the simulation by at most
 * `samples` device samples and delivers whatever bytes become available. Nothing is
 * scheduled on a timer, so tests never wait on wall time.
 *
 * `step()` returns the number of device samples the call advanced. It can exceed the
 * requested count only when a dropout gap crosses the step boundary (the gap is a
 * single device-time discontinuity; see `SimFault.count`). Bytes delivered to the sink
 * may also exceed the return value on the step where a trigger matches, because the
 * retained pre-trigger window is flushed at that point.
 *
 * State machine:
 *
 *   idle -> handshaking -> waiting -> running -> stopped
 *                              \          ^         ^
 *                               `---------/         |
 *   any active state -> disconnected                 |
 *   stop() from any active state --------------------+
 *
 * A free-run start goes straight to `running`; a start with an accepted trigger plan
 * goes to `waiting` and emits nothing until a condition matches. `stop()` is idempotent
 * and returns to `stopped`; `start()` is accepted again from `idle`, `stopped` and
 * `disconnected`.
 *
 * ## Sink and byte layout
 *
 * The sink receives device-shaped bytes, little-endian, `ceil(channels / 8)` bytes per
 * sample. The 4-channel wire mode packs two samples per byte; like the real transport
 * adapter, this simulator emits the post-expansion one byte per sample that SignalStore
 * consumes, so the sink never sees the 4-bit packing. Chunks are not necessarily
 * sample-aligned: a `short-packet` fault ends a transfer at an arbitrary byte, exactly
 * like a short USB packet, and the next write continues the partial sample.
 * `startByte` is the absolute byte offset in the stream, so a sink can place fragments
 * without guessing. A sink that wants store positions must buffer incomplete samples
 * itself.
 *
 * The first emitted sample is not necessarily sample 0. A triggered acquisition starts
 * at `from = T - preSamples` (never negative: see the pre-fill holdoff below) and never
 * backfills the positions before it: the
 * device did not deliver them. `firstSample` is null until the first byte is written,
 * then reports the absolute device sample position of that first emitted sample (also
 * derivable as `Math.floor(firstWrite.startByte / bytesPerSample)`). A sink wiring this
 * stream into SignalStore uses `firstSample` as the group origin and must not treat the
 * missing `0..firstSample` prefix as data. `triggeredAt` is reported in the same
 * absolute sample coordinate, so `triggeredAt - firstSample` is T's index in the
 * emitted stream.
 *
 * A dropout is reported through `sink.noteGap()` with absolute sample positions. Gaps
 * seen while waiting are buffered as a bounded list of spans (never sample data) and
 * only their intersection with the emitted range is reported at the match: a gap wholly
 * before `firstSample` is dropped, and no gap extends past the delivered end. A dropout
 * after T is reported when it happens, clipped to that delivered end. When the sink has
 * no gap path the driver throws a typed `SimDriverError('dropout')` as soon as a gap
 * that must be reported materialises, instead of silently splicing the stream.
 *
 * ## Trigger matching
 *
 * `updateTrigger()` installs a `TriggerPlan` and is accepted only while
 * `state === 'waiting'`. Matching is evaluated on complete generated samples (never on
 * byte fragments), across `step()` boundaries, with all conditions ANDed. A retune
 * restarts edge continuity and any analog arm/candidate, as ARCHITECTURE §5.1 requires.
 * Mixed plans, signals outside the configured width, and analog plans without a
 * matching `analog` source are refused by returning `false` (a simulator limitation,
 * not a profile statement).
 *
 * ## Analog source and qualified crossings
 *
 * The digital generator has no ADC. `options.analog` supplies one: `code(position)`
 * returns the converter code (0..255) at a device sample position, and the driver
 * writes it into the eight inputs of the bank at `start` with the module's wiring -
 * input 0 carries the code's MSB, so the byte on the wire is the bit-reversed code
 * (`reverseAdcByte`). `code` must be a pure function of the position: the pre-trigger
 * window is regenerated from it at the match. A test models the module's carry-boundary
 * artifact (the OR of the old and new codes for a few samples) inside `code`.
 *
 * An analog plan is one `rising`/`falling` condition on `a<start>`, the source's bank;
 * several analog conditions are refused (the sim has one source and the qualification
 * pins T to one candidate sample). Its volts are converted to a code at 1x gain
 * (`analogTriggerCode`); the sim has no declared gain. Crossings are qualified, never
 * raw (docs/ARCHITECTURE.md trigger section), by the shared streaming rule
 * `AnalogRunQualifier` (src/data/analogRunQualifier.ts) with the same field names as
 * `SoftwareTrigger`:
 *
 *  - hysteresis `analogHysteresis` (h codes, default `ADC_TRIGGER_HYSTERESIS_CODES`, or
 *    the plan's volt hysteresis in codes when that is larger): a rising condition arms
 *    only on a code <= level - h (falling: >= level + h, clamped to the code range); one
 *    fire per arm;
 *  - OR-artifact rejection with window `analogArtifactSamples` (W, default
 *    `analogTriggerArtifactSamples(rate)`, i.e. ceil(240 ns * rate), 24 at 100 MS/s): a
 *    run past a threshold that is at most W samples long, ends, and whose every code g
 *    has `(g & a) === a`, `(g & b) === b`, `g > max(a, b)` (a/b the samples before/after
 *    it) neither arms nor fires. Any other run is real. W = 0 disables the rejection.
 *
 * T is the first sample of a real candidate run, decided at most W samples later. The
 * delivered range is still exactly [T - preSamples, T + postSamples): the window up to the
 * deciding sample is regenerated at the match, so no extra prefix is retained while
 * waiting (the qualifier keeps O(1) state per run, not its codes). The holdoff applies to
 * T; a decision whose T lies inside it is consumed (disarmed) without a match. The first
 * sample after start, a waiting dropout or `updateTrigger()` has no predecessor: it can
 * arm but never fire. `stop()` clears the arm and any pending run.
 *
 * ## Search limit
 *
 * `options.searchLimitSamples` bounds one search (a Repeat sweep): once that many
 * samples have been inspected while waiting without a match, the driver stops with
 * `searchExhausted === true` and delivers nothing. Analog look-ahead samples are
 * inspected samples, so a crossing decided past the limit is not a match. Samples
 * lost to a dropout are not inspected and do not count. Default: unlimited.
 *
 * Waiting retains no search prefix. The pre-trigger window is regenerated from the
 * deterministic source when a match occurs, bounded by `preTrigger.samples` when the
 * plan states it; otherwise by the smaller of the whole-sample `capBytes` extent and
 * `Math.round(seconds * samplerate)` (never a bare floor of the float round-trip).
 * Nothing grows while a trigger is searched for.
 *
 * Pre-fill holdoff: a candidate match is accepted only after `preSamples` complete
 * samples have been generated since arming (position 0) or, after a dropout during the
 * search, past the gap's end. A dense trigger signal therefore cannot fire on its first
 * edge with an empty prefix: every delivered capture carries the full pre-trigger window.
 * After a dropout this also keeps the regenerated window entirely after the lost span, so the driver never writes
 * samples into positions it has reported (or must report) as unknown. Waiting gaps are
 * therefore before the retained window by construction; only their overlap with the
 * delivered range would be reported, and a gap wholly before `firstSample` is dropped.
 *
 * For a finite plan the total delivered budget is `preSamples + postSamples` whole
 * samples: emission starts at `from = T - preSamples` and ends at
 * `T + postSamples`. The holdoff rules out an early match (T < preSamples). An
 * unlimited budget keeps its open-ended post span. A finite plan whose
 * `preSamples + postSamples` exceeds `MAX_SAMPLES - 1` is refused with
 * `SimDriverError('invalid-config')`.
 *
 * ## Fault injection
 *
 * `atSample` is device sample position relative to the acquisition start; `count`
 * depends on the kind:
 *
 *   short-packet        bytes omitted from one transfer (default 1)
 *   stall               step() calls that deliver nothing (default 1)
 *   dropout             samples lost and skipped (default 32); reported through noteGap
 *                       when the lost span overlaps emitted data
 *   disconnect          ignored; the fault throws at `atSample`
 *   malformed-header    fires during start() and start() rejects
 *   slow-handshake      start() stays pending until step() or stop() is called
 *   quota               storage quota exhaustion; throws SimDriverError('quota')
 *
 * Faults fire at most once per acquisition and are reset by the next `start()`, so a
 * stop/restart reproduces the same run. Fault order in the array decides ties at one
 * sample position.
 */

import { fillMacro, makeTileBlock, MACRO_SAMPLES } from '../data/generator.js';
import {
  MAX_SAMPLES,
  bytesPerSampleForChannels,
  isChannelCount,
  type ChannelCount,
} from '../types.js';
import type { TriggerPlan } from '../dsp/triggerPlan.js';
import { reverseAdcByte } from '../data/softwareTrigger.js';
import { AnalogRunQualifier } from '../data/analogRunQualifier.js';
import {
  ADC_LSB_V,
  ADC_TRIGGER_HYSTERESIS_CODES,
  analogTriggerCode,
  analogTriggerArtifactSamples,
} from '../ui/channelBanks.js';
import { emulationRules } from './emulationPattern.js';
import { sampleRatesFor } from './profile.js';
import type {
  DeviceProfile,
  LinkRate,
  TestMode,
  TriggerKind,
} from './profileTypes.js';

/** CH0 in the normal test mode is the generator's period-4 square wave. */
export const SIM_CH0_PERIOD_SAMPLES = 4;

/**
 * The simulator has direct per-sample access only up to 32 channels. Both shipped U3
 * profiles are within that limit; a profile that offers more is refused rather than
 * silently emitting zeroes for the upper bank.
 */
const SIM_MAX_CHANNELS = 32;

const DEFAULT_SEED = 0x5109c16;
const DEFAULT_TRANSFER_BYTES = 4096;
const DEFAULT_GROUP_ID = 'digital';
const DEFAULT_DROPOUT_SAMPLES = 32;

/** Inputs of one ADC bank. */
const SIM_ANALOG_BANK = 8;
/** Bounds of the qualification fields (`analogHysteresis` 1..255, `analogArtifactSamples`
 * 0..4096; W = 0 disables artifact rejection, see the module header). */
const SIM_ANALOG_HYSTERESIS_MAX = 255;
const SIM_ANALOG_ARTIFACT_MAX = 4096;

const LINK_RATES: readonly LinkRate[] = ['fs', 'hs', 'ss5', 'ss10'];
const TRIGGER_KINDS: readonly TriggerKind[] = [
  'level', 'rising', 'falling', 'edge', 'high', 'low',
];

let sharedTileBlock: Uint16Array | null = null;

/** The generator's immutable tile block, built once for every SimDriver in the process. */
function generatorTileBlock(): Uint16Array {
  if (sharedTileBlock === null) sharedTileBlock = makeTileBlock();
  return sharedTileBlock;
}

export type SimFaultKind =
  | 'short-packet'
  | 'stall'
  | 'dropout'
  | 'disconnect'
  | 'malformed-header'
  | 'slow-handshake'
  | 'quota';

const SIM_FAULT_KINDS: readonly SimFaultKind[] = [
  'short-packet', 'stall', 'dropout', 'disconnect', 'malformed-header', 'slow-handshake',
  'quota',
];

/** One deterministic fault. See the module header for the meaning of each field. */
export interface SimFault {
  readonly kind: SimFaultKind;
  /** Device sample position at which the fault fires. Default 0. */
  readonly atSample?: number;
  /** Kind-specific size; see the module header. */
  readonly count?: number;
}

/** A dropout span in absolute device sample positions; `end` is exclusive. */
export interface SimGapSpan {
  readonly group: string;
  readonly start: number;
  readonly end: number;
  readonly reason: 'dropout';
}

/**
 * The sample sink. `write` receives raw device bytes and their absolute byte offset;
 * chunks may end in the middle of a sample. `noteGap` receives an untrusted span.
 */
export interface SimSink {
  write(chunk: Uint8Array, startByte: number): void | Promise<void>;
  noteGap?(gap: SimGapSpan): void;
}

/**
 * A deterministic ADC source overlaid on the eight inputs of the bank at `start` (see
 * the module header). `code` must be a pure function of the device sample position and
 * return an integer 0..255.
 */
export interface SimAnalogSource {
  readonly start: number;
  code(position: number): number;
}

export interface SimStartConfig {
  readonly channels: ChannelCount;
  readonly samplerate: number;
  /** 0 normal waveform, 1 counter pattern, 2 emulation-pattern counter. Default 0. */
  readonly testMode?: 0 | 1 | 2;
}

export interface SimDriverOptions {
  /** Generator seed. Default 0x5109c16. */
  readonly seed?: number;
  /** Link rate used for the profile's offered-rate lookup. Default: the highest offered. */
  readonly linkRate?: LinkRate;
  /** Group id carried by gap reports. Default 'digital' (the SignalStore default). */
  readonly groupId?: string;
  /** Target transfer size in bytes. A transfer still carries at least one sample. */
  readonly transferBytes?: number;
  /** Faults for the next acquisition; reset on every start(). */
  readonly faults?: readonly SimFault[];
  /**
   * Initial trigger plan. When present the driver starts in `waiting`; when absent it
   * free-runs. `null` clears a plan inherited from the constructor options.
   */
  readonly trigger?: TriggerPlan | null;
  /** Called once, synchronously, when a bounded trigger budget has been delivered. */
  readonly onEnd?: (() => void) | null;
  /** ADC source for the bank at `start`; `null` clears an inherited one. Default none. */
  readonly analog?: SimAnalogSource | null;
  /**
   * Analog arming hysteresis in codes, an integer 1..255. Default
   * `ADC_TRIGGER_HYSTERESIS_CODES` (4). Same meaning as `SoftwareTriggerConfig`.
   */
  readonly analogHysteresis?: number;
  /**
   * OR-artifact window W in samples, an integer 0..4096 (module header): a run at most
   * W samples long with the OR shape neither arms nor fires; 0 disables the rejection.
   * Default `analogTriggerArtifactSamples(samplerate)` = ceil(240 ns * rate), 24 at
   * 100 MS/s.
   */
  readonly analogArtifactSamples?: number;
  /**
   * Samples one search may inspect before the driver gives up (`searchExhausted`), a
   * positive integer or Infinity. Default Infinity.
   */
  readonly searchLimitSamples?: number;
}

export type SimDriverErrorCode =
  | 'unsupported-channel-count'
  | 'unsupported-rate'
  | 'unsupported-test-mode'
  | 'trigger-unsupported'
  | 'invalid-config'
  | 'already-started'
  | 'not-started'
  | 'dropout'
  | 'malformed-header'
  | 'disconnect'
  | 'quota';

/** Typed SimDriver failure. Callers branch on `code`, never on the message. */
export class SimDriverError extends Error {
  readonly code: SimDriverErrorCode;

  constructor(code: SimDriverErrorCode, message: string) {
    super(message);
    this.name = 'SimDriverError';
    this.code = code;
  }
}

export type SimDriverState =
  | 'idle'
  | 'handshaking'
  | 'waiting'
  | 'running'
  | 'stopped'
  | 'disconnected';

/** Merged constructor/start options, with every default applied. */
interface ResolvedOptions {
  readonly seed: number;
  readonly linkRate: LinkRate;
  readonly groupId: string;
  readonly transferBytes: number;
  readonly faults: readonly SimFault[];
  readonly trigger: TriggerPlan | null;
  readonly onEnd: (() => void) | null;
  readonly analog: SimAnalogSource | null;
  /** Null: use the default for the resolved rate. */
  readonly analogHysteresis: number | null;
  readonly analogArtifactSamples: number | null;
  readonly searchLimitSamples: number;
}

interface ResolvedConfig {
  readonly channels: ChannelCount;
  readonly samplerate: number;
  readonly testMode: TestMode;
  readonly bytesPerSample: number;
  readonly chunkSamples: number;
  readonly groupId: string;
  readonly analog: SimAnalogSource | null;
  readonly analogHysteresis: number;
  readonly analogArtifactSamples: number;
  readonly searchLimitSamples: number;
}

interface FaultState {
  readonly kind: SimFaultKind;
  readonly atSample: number;
  readonly count: number;
  fired: boolean;
}

interface SimTriggerCondition {
  readonly channel: number;
  readonly mode: TriggerKind;
  readonly level: 0 | 1;
}

/** One qualified analog crossing in code space (see the module header). */
interface SimAnalogCondition {
  readonly rising: boolean;
  /** The code the signal crosses. */
  readonly level: number;
  /** Hysteresis h in codes (the arming threshold is level -/+ h, clamped). */
  readonly hysteresis: number;
  /** OR-artifact window W in samples. */
  readonly window: number;
}

interface SimTrigger {
  readonly conditions: readonly SimTriggerCondition[];
  /** The analog crossing of an analog plan; null for a digital plan. */
  readonly analog: SimAnalogCondition | null;
  /** Whole samples of history flushed when the trigger matches. */
  readonly preSamples: number;
  /** Samples delivered from T inclusive; Infinity for an unlimited budget. */
  readonly postSamples: number;
}

function invalid(message: string): SimDriverError {
  return new SimDriverError('invalid-config', message);
}

function isFaultKind(value: unknown): value is SimFaultKind {
  return SIM_FAULT_KINDS.includes(value as SimFaultKind);
}

function isTriggerKind(value: unknown): value is TriggerKind {
  return TRIGGER_KINDS.includes(value as TriggerKind);
}

/**
 * Digital kinds are interchangeable in the `level`/`high`/`low` family, matching the
 * TriggerPlan compiler: a profile that can express one polarity can express the others.
 */
function supportsDigitalKind(
  profile: DeviceProfile,
  mode: TriggerKind,
  level: 0 | 1,
): boolean {
  const caps = profile.trigger.digital;
  if (mode === 'level') return caps.includes('level') || caps.includes(level === 1 ? 'high' : 'low');
  if (mode === 'high' || mode === 'low') return caps.includes(mode) || caps.includes('level');
  return caps.includes(mode);
}

function signalChannel(signal: string): number | null {
  const match = /^d(\d+)$/.exec(signal);
  if (match === null) return null;
  const channel = Number(match[1]);
  return Number.isSafeInteger(channel) ? channel : null;
}

function isSafeSampleCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Compile a plan for the simulator, or return null when it is outside what the sim can
 * execute. This is a capability check, not a second TriggerPlan compiler: the plan is
 * already compiled and owns pre-trigger clamping. The simulator only resolves those
 * values into its sample space.
 */
function compileSimTrigger(
  plan: TriggerPlan,
  config: ResolvedConfig,
  profile: DeviceProfile,
): SimTrigger | null {
  if (plan === null || typeof plan !== 'object') return null;
  if (plan.source !== 'digital' && plan.source !== 'analog') return null;
  if (!Array.isArray(plan.conditions) || plan.conditions.length === 0) return null;
  if (plan.execution !== 'device' && plan.execution !== 'host') return null;

  const conditions: SimTriggerCondition[] = [];
  let analog: SimAnalogCondition | null = null;
  if (plan.source === 'analog') {
    analog = compileSimAnalog(plan, config, profile);
    if (analog === null) return null;
  }
  for (const condition of plan.source === 'digital' ? plan.conditions : []) {
    if (condition === null || typeof condition !== 'object') return null;
    if (condition.kind !== 'digital') return null;
    if (typeof condition.signal !== 'string') return null;
    const channel = signalChannel(condition.signal);
    if (channel === null || channel >= config.channels) return null;
    if (!isTriggerKind(condition.mode)) return null;
    if (condition.level !== undefined && condition.level !== 0 && condition.level !== 1) {
      return null;
    }
    const level: 0 | 1 = condition.mode === 'level' ? (condition.level ?? 1) : 0;
    if ((condition.mode === 'high' && condition.level === 0) ||
        (condition.mode === 'low' && condition.level === 1)) {
      return null;
    }
    if (!supportsDigitalKind(profile, condition.mode, condition.mode === 'level' ? level : 1)) {
      return null;
    }
    conditions.push({ channel, mode: condition.mode, level });
  }

  const preTrigger = plan.preTrigger;
  if (preTrigger === null || typeof preTrigger !== 'object') return null;
  if (!Number.isFinite(preTrigger.seconds) || preTrigger.seconds < 0) return null;
  if (!Number.isFinite(preTrigger.capBytes) || preTrigger.capBytes < 0) return null;

  // Exact pre-trigger count, in order of trust:
  //   1. `preTrigger.samples`, the compiler's whole-sample prefix. Never recover the
  //      count by flooring `seconds * samplerate`: that round-trip can lose a sample.
  //   2. The whole samples stated by `capBytes`, when the byte count divides evenly.
  //   3. `Math.round(seconds * samplerate)`.
  // The byte and time forms are bounds, so the fallbacks take the smaller one: a plan
  // without `capture` reports the profile's hard byte cap in `capBytes` (it cannot know
  // T's real byte position), and that cap must not inflate the window.
  let preSamples: number;
  if (preTrigger.samples !== undefined) {
    if (!isSafeSampleCount(preTrigger.samples)) return null;
    preSamples = preTrigger.samples;
  } else {
    const bySeconds = Math.round(preTrigger.seconds * config.samplerate);
    if (!isSafeSampleCount(bySeconds)) return null;
    const byBytes = preTrigger.capBytes / config.bytesPerSample;
    preSamples = Number.isSafeInteger(byBytes) ? Math.min(byBytes, bySeconds) : bySeconds;
  }
  const byProfileBytes = Math.floor(profile.trigger.preTriggerMaxBytes / config.bytesPerSample);
  preSamples = Math.min(preSamples, byProfileBytes);
  if (!isSafeSampleCount(preSamples)) return null;

  const budget = plan.budget;
  if (budget === null || typeof budget !== 'object') return null;
  let postSamples: number;
  switch (budget.kind) {
    case 'samples':
      if (!Number.isSafeInteger(budget.value) || budget.value < 1) return null;
      postSamples = budget.value;
      break;
    case 'time': {
      if (!Number.isFinite(budget.value) || budget.value <= 0) return null;
      const samples = Math.round(budget.value * config.samplerate);
      if (!isSafeSampleCount(samples)) return null;
      postSamples = Math.max(1, samples);
      break;
    }
    case 'unlimited':
      postSamples = Number.POSITIVE_INFINITY;
      break;
    default:
      return null;
  }

  // The emitted stream is preSamples + postSamples whole samples for a finite plan; it
  // must fit the shared sample-position envelope. An unlimited plan has no finite total.
  if (Number.isFinite(postSamples) && preSamples + postSamples > MAX_SAMPLES - 1) {
    throw new SimDriverError(
      'invalid-config',
      `trigger budget ${preSamples} pre + ${postSamples} post samples exceeds the ` +
        `${MAX_SAMPLES - 1}-sample capture envelope`,
    );
  }

  return { conditions, analog, preSamples, postSamples };
}

/**
 * The single qualified crossing of an analog plan, or null when the simulator cannot
 * run it: no source, a signal other than the source's bank, more than one condition, or
 * a kind the profile does not advertise. Volts become a code at 1x gain.
 */
function compileSimAnalog(
  plan: TriggerPlan,
  config: ResolvedConfig,
  profile: DeviceProfile,
): SimAnalogCondition | null {
  const source = config.analog;
  if (source === null || plan.conditions.length !== 1) return null;
  const condition = plan.conditions[0]!;
  if (condition === null || typeof condition !== 'object' || condition.kind !== 'analog') {
    return null;
  }
  if (condition.signal !== `a${source.start}`) return null;
  if (condition.mode !== 'rising' && condition.mode !== 'falling') return null;
  if (!profile.trigger.analog.includes(condition.mode)) return null;
  if (!Number.isFinite(condition.volts)) return null;
  const rise = condition.mode === 'rising';
  const level = analogTriggerCode(condition.mode, condition.volts);
  // A plan's volt hysteresis can only widen the module's code hysteresis.
  let h = config.analogHysteresis;
  const volts = condition.hysteresis;
  if (volts !== undefined) {
    if (!Number.isFinite(volts) || volts < 0) return null;
    h = Math.min(SIM_ANALOG_HYSTERESIS_MAX, Math.max(h, Math.round(volts / ADC_LSB_V)));
  }
  // A level within h of the code range's end arms at the end code itself.
  return { rising: rise, level, hysteresis: h, window: config.analogArtifactSamples };
}

function validateFaults(faults: readonly SimFault[]): FaultState[] {
  if (!Array.isArray(faults)) throw invalid('faults must be an array');
  const out: FaultState[] = [];
  for (const fault of faults) {
    if (fault === null || typeof fault !== 'object') throw invalid('every fault must be an object');
    if (!isFaultKind(fault.kind)) throw invalid(`unknown fault kind ${String(fault.kind)}`);
    const atSample = fault.atSample ?? 0;
    if (!isSafeSampleCount(atSample)) {
      throw invalid(`fault atSample must be a non-negative safe integer, got ${String(atSample)}`);
    }
    let count = 0;
    if (fault.kind === 'short-packet' || fault.kind === 'stall' || fault.kind === 'dropout') {
      count = fault.count ?? (fault.kind === 'dropout' ? DEFAULT_DROPOUT_SAMPLES : 1);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw invalid(`fault count must be a positive integer, got ${String(count)}`);
      }
    }
    out.push({ kind: fault.kind, atSample, count, fired: false });
  }
  return out;
}

/** Highest link class in `LINK_RATES` that the profile declares. */
function highestOfferedLinkRate(profile: DeviceProfile): LinkRate {
  for (let index = LINK_RATES.length - 1; index >= 0; index--) {
    const rate = LINK_RATES[index]!;
    if (profile.link.rates.includes(rate)) return rate;
  }
  // A profile with no link cannot resolve a rate; resolveConfig reports it.
  return LINK_RATES[LINK_RATES.length - 1]!;
}

function resolveOptions(
  profile: DeviceProfile,
  defaults: SimDriverOptions,
  overrides: SimDriverOptions | undefined,
): ResolvedOptions {
  const source = overrides ?? {};
  const seed = source.seed ?? defaults.seed ?? DEFAULT_SEED;
  if (!Number.isSafeInteger(seed)) throw invalid(`seed must be a safe integer, got ${String(seed)}`);

  const linkRate = source.linkRate ?? defaults.linkRate ?? highestOfferedLinkRate(profile);
  if (!LINK_RATES.includes(linkRate)) throw invalid(`unknown link rate ${String(linkRate)}`);

  const groupId = source.groupId ?? defaults.groupId ?? DEFAULT_GROUP_ID;
  if (typeof groupId !== 'string' || groupId.trim().length === 0) {
    throw invalid('groupId must be a non-empty string');
  }

  const transferBytes = source.transferBytes ?? defaults.transferBytes ?? DEFAULT_TRANSFER_BYTES;
  if (!Number.isSafeInteger(transferBytes) || transferBytes < 1) {
    throw invalid(`transferBytes must be a positive integer, got ${String(transferBytes)}`);
  }

  const faults = source.faults !== undefined
    ? source.faults
    : defaults.faults !== undefined ? defaults.faults : [];
  const trigger = source.trigger !== undefined
    ? source.trigger
    : defaults.trigger !== undefined ? defaults.trigger : null;
  const onEnd = source.onEnd !== undefined
    ? source.onEnd
    : defaults.onEnd !== undefined ? defaults.onEnd : null;
  if (onEnd !== null && typeof onEnd !== 'function') throw invalid('onEnd must be a function');

  const analog = source.analog !== undefined
    ? source.analog
    : defaults.analog !== undefined ? defaults.analog : null;
  if (analog !== null) {
    if (typeof analog !== 'object' || typeof analog.code !== 'function') {
      throw invalid('analog must be { start, code(position) }');
    }
    if (!Number.isSafeInteger(analog.start) || analog.start < 0 ||
        analog.start % SIM_ANALOG_BANK !== 0) {
      throw invalid(`analog start must be a bank start (a multiple of 8), got ${String(analog.start)}`);
    }
    if (!profile.analog.groups.some((group) => group.start === analog.start)) {
      throw invalid(`profile ${profile.id} has no analog group at input ${analog.start}`);
    }
  }
  const analogHysteresis = source.analogHysteresis ?? defaults.analogHysteresis ?? null;
  if (analogHysteresis !== null &&
      (!Number.isInteger(analogHysteresis) || analogHysteresis < 1 ||
        analogHysteresis > SIM_ANALOG_HYSTERESIS_MAX)) {
    throw invalid(`analogHysteresis must be an integer code count 1..255, got ${String(analogHysteresis)}`);
  }
  const analogArtifactSamples = source.analogArtifactSamples ?? defaults.analogArtifactSamples ?? null;
  if (analogArtifactSamples !== null &&
      (!Number.isInteger(analogArtifactSamples) || analogArtifactSamples < 0 ||
        analogArtifactSamples > SIM_ANALOG_ARTIFACT_MAX)) {
    throw invalid(
      `analogArtifactSamples must be an integer 0..${SIM_ANALOG_ARTIFACT_MAX}, got ${String(analogArtifactSamples)}`,
    );
  }
  const searchLimitSamples = source.searchLimitSamples ?? defaults.searchLimitSamples ??
    Number.POSITIVE_INFINITY;
  if (searchLimitSamples !== Number.POSITIVE_INFINITY &&
      (!Number.isSafeInteger(searchLimitSamples) || searchLimitSamples < 1)) {
    throw invalid(`searchLimitSamples must be a positive integer or Infinity, got ${String(searchLimitSamples)}`);
  }

  return {
    seed, linkRate, groupId, transferBytes, faults, trigger, onEnd,
    analog, analogHysteresis, analogArtifactSamples, searchLimitSamples,
  };
}

/**
 * A deterministic simulated device. Construct with a profile; options are defaults that
 * a `start()` call may override. Instances are single-acquisition: one `start()` at a
 * time, with any number of `step()` calls between it and `stop()`.
 */
export class SimDriver {
  readonly profile: DeviceProfile;

  private readonly defaults: SimDriverOptions;

  private phase: SimDriverState = 'idle';
  private config: ResolvedConfig | null = null;
  private options: ResolvedOptions | null = null;
  private sink: SimSink | null = null;
  private trigger: SimTrigger | null = null;
  private faults: FaultState[] = [];
  private handshakeResolve: (() => void) | null = null;

  /** Next device sample position to generate. */
  private nextSample = 0;
  /** Previous complete sample, for rising/falling/edge matching. */
  private previousWord: number | null = null;
  /** Analog qualification state (module header): arm, pending run, predecessor. Null
   *  without an analog plan. */
  private analogQ: AnalogRunQualifier | null = null;
  /** Samples inspected by the current search (dropout samples excluded). */
  private inspected = 0;
  private exhausted = false;
  /** Position of the matching sample, or null before a match. */
  private matchPosition: number | null = null;
  /** Samples still owed after T inclusive. Infinity for an unlimited budget. */
  private postRemaining = 0;
  /** Consecutive step() calls that must deliver nothing (stall fault). */
  private stallRemaining = 0;
  /** Tail of a transfer shortened by a short-packet fault. */
  private pending: Uint8Array | null = null;
  private pendingStartByte = 0;
  private completed = false;
  private stepping = false;
  private macro: Uint16Array | null = null;
  private macroIndex = -1;
  private emulation: ReturnType<typeof emulationRules> = null;
  /**
   * Dropouts seen while waiting. They are buffered as spans (no sample data) and only
   * their overlap with the emitted range is reported once a match fixes that range.
   */
  private waitingGaps: SimGapSpan[] = [];
  /**
   * End of the most recent waiting dropout, or null when the search has not lost data.
   * A match is not armed until `preSamples` complete samples have been generated after
   * this position, so the regenerated pre-trigger window never covers a lost span.
   */
  private lastGapEnd: number | null = null;
  /** Absolute position of the first sample written to the sink; null before any write. */
  private firstSamplePosition: number | null = null;
  /** Exclusive end of the planned delivered range; Infinity for a free/unlimited run. */
  private deliveryEnd = Number.POSITIVE_INFINITY;

  constructor(profile: DeviceProfile, options: SimDriverOptions = {}) {
    this.profile = profile;
    this.defaults = options;
  }

  get state(): SimDriverState {
    return this.phase;
  }

  /** Next device sample position; equals the number of samples advanced so far. */
  get position(): number {
    return this.nextSample;
  }

  /**
   * True when the search inspected `searchLimitSamples` samples without a match; the
   * driver is then `stopped` and delivered nothing.
   */
  get searchExhausted(): boolean {
    return this.exhausted;
  }

  /** True once a bounded post-trigger budget has been fully delivered. */
  get complete(): boolean {
    return this.completed;
  }

  /**
   * Absolute device sample position of the matching sample, or null. It is in the same
   * coordinate space as `firstSample`: `triggeredAt - firstSample` is T's index in the
   * emitted stream, and T can be after the first emitted sample when T > preSamples.
   */
  get triggeredAt(): number | null {
    return this.matchPosition;
  }

  /**
   * Absolute device sample position of the first sample written to the sink, or null
   * before any emission. It is the group origin for a sink that stores this stream (it
   * can also derive it as `Math.floor(firstWrite.startByte / bytesPerSample)`); the
   * positions before it were never delivered and must not be backfilled. Free runs and
   * triggers with no pre-trigger history start at 0.
   */
  get firstSample(): number | null {
    return this.firstSamplePosition;
  }

  /**
   * Handshake and arm the driver. Resolves once the device is ready; samples are
   * produced only by `step()`. With the `slow-handshake` fault the promise stays
   * pending until the first `step()` (or `stop()`) completes the handshake.
   */
  start(config: SimStartConfig, sink: SimSink, options?: SimDriverOptions): Promise<void> {
    if (this.phase === 'running' || this.phase === 'waiting' || this.phase === 'handshaking') {
      return Promise.reject(
        new SimDriverError('already-started', `cannot start while the driver is ${this.phase}`),
      );
    }
    if (sink === null || typeof sink !== 'object' || typeof sink.write !== 'function') {
      return Promise.reject(invalid('sink must provide a write(chunk, startByte) method'));
    }
    if (sink.noteGap !== undefined && typeof sink.noteGap !== 'function') {
      return Promise.reject(invalid('sink.noteGap must be a function when present'));
    }

    let resolved: ResolvedOptions;
    let cfg: ResolvedConfig;
    let faults: FaultState[];
    let trigger: SimTrigger | null;
    try {
      resolved = resolveOptions(this.profile, this.defaults, options);
      cfg = this.resolveConfig(config, resolved);
      faults = validateFaults(resolved.faults);
      trigger = resolved.trigger === null
        ? null
        : compileSimTrigger(resolved.trigger, cfg, this.profile);
      if (resolved.trigger !== null && trigger === null) {
        throw new SimDriverError(
          'trigger-unsupported',
          'the initial trigger plan is not executable by the simulator: it must be a ' +
            'non-empty digital plan, or one analog crossing on the analog source bank, ' +
            'whose signals and modes fit the profile and width',
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }

    this.config = cfg;
    this.options = resolved;
    this.sink = sink;
    this.trigger = trigger;
    this.faults = faults;
    this.nextSample = 0;
    this.previousWord = null;
    this.resetAnalog();
    this.inspected = 0;
    this.exhausted = false;
    this.matchPosition = null;
    this.postRemaining = 0;
    this.stallRemaining = 0;
    this.pending = null;
    this.pendingStartByte = 0;
    this.completed = false;
    this.stepping = false;
    this.macro = null;
    this.macroIndex = -1;
    this.waitingGaps = [];
    this.lastGapEnd = null;
    this.firstSamplePosition = null;
    this.deliveryEnd = Number.POSITIVE_INFINITY;
    this.emulation = cfg.testMode === 2 ? emulationFor(this.profile, cfg.channels) : null;

    const malformed = this.faults.find(
      (fault) => fault.kind === 'malformed-header' && !fault.fired,
    );
    if (malformed !== undefined) {
      malformed.fired = true;
      this.phase = 'idle';
      return Promise.reject(
        new SimDriverError('malformed-header', 'simulated malformed handshake header'),
      );
    }

    const slow = this.faults.find((fault) => fault.kind === 'slow-handshake' && !fault.fired);
    if (slow !== undefined) {
      slow.fired = true;
      this.phase = 'handshaking';
      return new Promise<void>((resolve) => {
        this.handshakeResolve = () => resolve();
      });
    }

    this.phase = 'handshaking';
    this.finishHandshake();
    return Promise.resolve();
  }

  /**
   * Advance the simulation by at most `samples` device samples and deliver the bytes.
   * Returns the number of device samples advanced (0 for a stalled call; a dropout may
   * push the result past `samples`). No timers are involved.
   */
  async step(samples: number): Promise<number> {
    if (!isSafeSampleCount(samples)) {
      throw invalid(`step count must be a non-negative safe integer, got ${String(samples)}`);
    }
    if (this.stepping) throw invalid('step() is already running');
    if (this.phase === 'handshaking') this.finishHandshake();
    if (this.phase !== 'waiting' && this.phase !== 'running') {
      throw new SimDriverError('not-started', `cannot step while the driver is ${this.phase}`);
    }

    this.stepping = true;
    try {
      return this.phase === 'waiting'
        ? await this.stepWaiting(samples)
        : await this.stepRunning(samples);
    } finally {
      this.stepping = false;
    }
  }

  /** Stop the acquisition. Pending bytes are drained; safe to call repeatedly. */
  async stop(): Promise<void> {
    if (this.phase === 'handshaking') this.finishHandshake();
    if (this.phase !== 'idle') this.phase = 'stopped';
    this.stallRemaining = 0;
    if (this.pending !== null) await this.flushPending();
    this.trigger = null;
    this.previousWord = null;
    this.resetAnalog();
    // Nothing was emitted for waiting dropouts, so there is no delivered range to clip
    // them against; the next start() re-arms from scratch.
    this.waitingGaps = [];
    this.lastGapEnd = null;
  }

  /**
   * Replace the plan while the driver is waiting. Returns false when the driver is not
   * waiting, after a match, or when the plan is not executable on the simulator.
   * Retuning restarts edge continuity (§5.1).
   */
  updateTrigger(plan: TriggerPlan): boolean {
    if (this.phase !== 'waiting' || this.config === null) return false;
    const compiled = compileSimTrigger(plan, this.config, this.profile);
    if (compiled === null) return false;
    this.trigger = compiled;
    this.previousWord = null;
    this.resetAnalog();
    return true;
  }

  // ---------------------------------------------------------------- validation

  private resolveConfig(config: SimStartConfig, options: ResolvedOptions): ResolvedConfig {
    if (config === null || typeof config !== 'object') {
      throw invalid('config must be an object');
    }
    const channels = config.channels;
    if (typeof channels !== 'number' || !isChannelCount(channels)) {
      throw new SimDriverError(
        'unsupported-channel-count',
        `channels must be one of 4, 8, 16, 32, 64, 128, got ${String(channels)}`,
      );
    }
    if (channels > SIM_MAX_CHANNELS) {
      throw new SimDriverError(
        'unsupported-channel-count',
        `the simulator generates complete samples for up to ${SIM_MAX_CHANNELS} channels, ` +
          `got ${channels}`,
      );
    }
    if (!this.profile.digital.widths.includes(channels)) {
      throw new SimDriverError(
        'unsupported-channel-count',
        `profile ${this.profile.id} does not offer ${channels} channels; ` +
          `offered widths are ${this.profile.digital.widths.join(', ')}`,
      );
    }
    if (!this.profile.link.rates.includes(options.linkRate)) {
      throw new SimDriverError(
        'unsupported-rate',
        `profile ${this.profile.id} does not declare a ${options.linkRate} link`,
      );
    }

    const samplerate = config.samplerate;
    if (!Number.isFinite(samplerate) || samplerate <= 0) {
      throw new SimDriverError(
        'unsupported-rate',
        `samplerate must be a positive finite number, got ${String(samplerate)}`,
      );
    }
    const offered = sampleRatesFor(this.profile, channels, options.linkRate);
    if (offered.length === 0) {
      throw new SimDriverError(
        'unsupported-rate',
        `profile ${this.profile.id} offers no sample rate for ${channels} channels on a ` +
          `${options.linkRate} link`,
      );
    }
    if (!offered.includes(samplerate)) {
      throw new SimDriverError(
        'unsupported-rate',
        `profile ${this.profile.id} does not offer ${samplerate} Hz for ${channels} ` +
          `channels on a ${options.linkRate} link; offered rates are ${offered.join(', ')}`,
      );
    }

    const testMode: TestMode = config.testMode ?? 0;
    if (testMode !== 0 && testMode !== 1 && testMode !== 2) {
      throw new SimDriverError(
        'unsupported-test-mode',
        `testMode must be 0, 1 or 2, got ${String(testMode)}`,
      );
    }
    if (!this.profile.digital.testModes.includes(testMode)) {
      throw new SimDriverError(
        'unsupported-test-mode',
        `profile ${this.profile.id} does not offer test mode ${testMode}; offered modes are ` +
          `${this.profile.digital.testModes.join(', ')}`,
      );
    }

    const bytesPerSample = bytesPerSampleForChannels(channels);
    const chunkSamples = Math.max(1, Math.floor(options.transferBytes / bytesPerSample));
    if (options.analog !== null &&
        options.analog.start + SIM_ANALOG_BANK > channels) {
      throw invalid(
        `analog bank ${options.analog.start} lies outside the ${channels}-channel width`,
      );
    }
    return {
      channels,
      samplerate,
      testMode,
      bytesPerSample,
      chunkSamples,
      groupId: options.groupId,
      analog: options.analog,
      analogHysteresis: options.analogHysteresis ?? ADC_TRIGGER_HYSTERESIS_CODES,
      analogArtifactSamples: options.analogArtifactSamples ?? analogTriggerArtifactSamples(samplerate),
      searchLimitSamples: options.searchLimitSamples,
    };
  }

  private finishHandshake(): void {
    if (this.phase !== 'handshaking') return;
    this.phase = this.trigger === null ? 'running' : 'waiting';
    const resolve = this.handshakeResolve;
    this.handshakeResolve = null;
    if (resolve !== null) resolve();
  }

  // ---------------------------------------------------------------- sample source

  private sampleWordAt(index: number): number {
    const word = this.digitalWordAt(index);
    const analog = this.config!.analog;
    if (analog === null) return word;
    // Input 0 of the bank is the code's MSB: the wire byte is the bit-reversed code.
    const mask = (0xff << analog.start) >>> 0;
    return ((word & ~mask) | (reverseAdcByte(this.analogCodeAt(index)) << analog.start)) >>> 0;
  }

  /** The source's converter code at a position, validated. */
  private analogCodeAt(index: number): number {
    const code = this.config!.analog!.code(index);
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw invalid(`analog code at sample ${index} must be an integer 0..255, got ${String(code)}`);
    }
    return code;
  }

  private digitalWordAt(index: number): number {
    const cfg = this.config!;
    if (cfg.testMode === 2) return this.emulationWordAt(index);
    const low = cfg.testMode === 1 ? index & 0xffff : this.generatorWordAt(index);
    if (cfg.channels <= 16) return low >>> 0;
    // The upper 16-channel bank mirrors the complement of the lower bank. It is a
    // defined, deterministic pattern rather than dead channels at 32-bit widths.
    return (low | ((~low & 0xffff) << 16)) >>> 0;
  }

  private generatorWordAt(index: number): number {
    const macroIndex = Math.floor(index / MACRO_SAMPLES);
    if (this.macro === null) this.macro = new Uint16Array(MACRO_SAMPLES);
    if (this.macroIndex !== macroIndex) {
      fillMacro(this.macro, macroIndex, this.options!.seed, generatorTileBlock());
      this.macroIndex = macroIndex;
    }
    return this.macro[index - macroIndex * MACRO_SAMPLES]!;
  }

  private emulationWordAt(index: number): number {
    const rules = this.emulation;
    const counter = index & 0xffff;
    if (rules === null) return counter;
    let word = 0;
    for (let channel = 0; channel < rules.length; channel++) {
      const rule = rules[channel]!;
      const bit = (counter >>> rule.bit) & 1;
      const value = rule.inverted ? bit ^ 1 : bit;
      if (value === 1) word |= 1 << channel;
    }
    return word >>> 0;
  }

  private pack(start: number, count: number): Uint8Array {
    const cfg = this.config!;
    const bps = cfg.bytesPerSample;
    const out = new Uint8Array(count * bps);
    const usedBits = cfg.channels % 8;
    const tailMask = usedBits === 0 ? 0xff : (1 << usedBits) - 1;
    let offset = 0;
    for (let i = 0; i < count; i++) {
      const word = this.sampleWordAt(start + i);
      for (let byte = 0; byte < bps; byte++) out[offset++] = (word >>> (byte * 8)) & 0xff;
      if (tailMask !== 0xff) out[offset - 1] = out[offset - 1]! & tailMask;
    }
    return out;
  }

  // ---------------------------------------------------------------- trigger match

  private matches(word: number, previous: number | null): boolean {
    const trigger = this.trigger;
    if (trigger === null) return false;
    for (const condition of trigger.conditions) {
      const current = (word >>> condition.channel) & 1;
      switch (condition.mode) {
        case 'level':
          if (current !== condition.level) return false;
          break;
        case 'high':
          if (current !== 1) return false;
          break;
        case 'low':
          if (current !== 0) return false;
          break;
        case 'rising':
          if (previous === null ||
              ((previous >>> condition.channel) & 1) !== 0 || current !== 1) return false;
          break;
        case 'falling':
          if (previous === null ||
              ((previous >>> condition.channel) & 1) !== 1 || current !== 0) return false;
          break;
        case 'edge':
          if (previous === null ||
              ((previous >>> condition.channel) & 1) === current) return false;
          break;
        default:
          return false;
      }
    }
    return true;
  }

  /** Forget the arm, the pending run and the predecessor (start, gap, retune, stop). */
  private resetAnalog(): void {
    const a = this.trigger?.analog ?? null;
    this.analogQ = a === null ? null : new AnalogRunQualifier(a);
  }

  // ---------------------------------------------------------------- stepping

  private async stepWaiting(samples: number): Promise<number> {
    if (this.stallRemaining > 0) {
      this.stallRemaining--;
      return 0;
    }
    let consumed = 0;
    while (consumed < samples) {
      const due = this.dueFault();
      if (due !== null) {
        if (due.kind === 'disconnect') {
          due.fired = true;
          this.phase = 'disconnected';
          throw new SimDriverError(
            'disconnect',
            `simulated device disconnect at sample ${this.nextSample}`,
          );
        }
        if (due.kind === 'stall') {
          due.fired = true;
          this.stallRemaining = Math.max(0, due.count - 1);
          return consumed;
        }
        if (due.kind === 'quota') {
          due.fired = true;
          this.phase = 'stopped';
          throw new SimDriverError(
            'quota',
            `simulated storage quota exhaustion at sample ${this.nextSample}`,
          );
        }
        // Dropout: no data exists for the span. Buffer the span (no sample data is kept)
        // and skip device time; whether it must be reported depends on the emitted range
        // that a later match fixes.
        due.fired = true;
        const start = this.nextSample;
        const end = start + due.count;
        this.waitingGaps.push({ group: this.config!.groupId, start, end, reason: 'dropout' });
        this.lastGapEnd = end;
        this.nextSample = end;
        this.previousWord = null;
        this.resetAnalog();
        consumed += due.count;
        continue;
      }

      const trigger = this.trigger!;
      const position = this.nextSample;
      const word = this.sampleWordAt(position);
      let matchPosition = -1;
      if (trigger.analog !== null) {
        // T is the first sample of a real candidate run, decided up to W samples later.
        // A decision whose T lies inside the holdoff is consumed (disarmed) unmatched.
        const code = reverseAdcByte((word >>> this.config!.analog!.start) & 0xff);
        const candidate = this.analogQ!.step(code, position);
        if (candidate >= 0 && this.matchArmed(candidate)) matchPosition = candidate;
      } else if (this.matches(word, this.previousWord) && this.matchArmed(position)) {
        matchPosition = position;
      }
      this.previousWord = word;
      this.nextSample += 1;
      consumed += 1;
      this.inspected += 1;

      if (matchPosition >= 0) {
        this.matchPosition = matchPosition;
        this.phase = 'running';
        // §5.1: deliver preSamples + postSamples whole samples starting at `from`. The
        // holdoff (matchArmed) guarantees matchPosition >= preSamples; the clamp is
        // defensive. The samples up to the deciding one (T itself, or an analog
        // decision) are regenerated now, never retained while waiting; a budget
        // shorter than the look-ahead ends inside them.
        const total = trigger.preSamples + trigger.postSamples;
        const from = Math.max(0, matchPosition - trigger.preSamples);
        this.deliveryEnd = Number.isFinite(total)
          ? from + total
          : Number.POSITIVE_INFINITY;
        this.flushWaitingGaps(from);
        const emitted = Math.min(position + 1 - from, total);
        await this.emitRange(from, emitted);
        this.postRemaining = total - emitted;
        if (this.postRemaining <= 0) {
          await this.flushPending();
          this.finish();
        }
        return consumed;
      }
      if (this.inspected >= this.config!.searchLimitSamples) {
        // One sweep found nothing: stop without delivering (Repeat's not-found).
        this.exhausted = true;
        this.phase = 'stopped';
        return consumed;
      }
    }
    return consumed;
  }

  /**
   * Pre-fill holdoff. Arm a candidate match only once `preSamples` complete samples have
   * been generated since arming (position 0) or since the last waiting gap, so
   * `[T - preSamples, T]` is entirely generated, contiguous data: the delivered prefix is
   * always the full window and never contains samples the device lost. A retune is
   * evaluated with the current plan's `preSamples`. Edge state is the true previous word
   * (`previousWord`), so an edge whose new value is the first armed sample is valid.
   */
  private matchArmed(position: number): boolean {
    const armedFrom = this.lastGapEnd ?? 0;
    return position - this.trigger!.preSamples >= armedFrom;
  }

  private async stepRunning(samples: number): Promise<number> {
    if (this.stallRemaining > 0) {
      this.stallRemaining--;
      return 0;
    }
    await this.flushPending();

    let remaining = samples;
    let advanced = 0;
    while (remaining > 0) {
      if (this.trigger !== null && this.postRemaining <= 0) {
        await this.flushPending();
        this.finish();
        break;
      }

      const due = this.dueFault();
      if (due !== null) {
        if (due.kind === 'disconnect') {
          due.fired = true;
          this.phase = 'disconnected';
          throw new SimDriverError(
            'disconnect',
            `simulated device disconnect at sample ${this.nextSample}`,
          );
        }
        if (due.kind === 'stall') {
          due.fired = true;
          this.stallRemaining = Math.max(0, due.count - 1);
          return advanced;
        }
        if (due.kind === 'quota') {
          due.fired = true;
          this.phase = 'stopped';
          throw new SimDriverError(
            'quota',
            `simulated storage quota exhaustion at sample ${this.nextSample}`,
          );
        }
        // Dropout: one device-time discontinuity, reported when its start lies inside
        // the delivered range; a straddling span is clipped to the delivered end.
        due.fired = true;
        const start = this.nextSample;
        const end = start + due.count;
        this.reportGap(start, end);
        this.nextSample = end;
        this.previousWord = null;
        advanced += due.count;
        remaining = Math.max(0, remaining - due.count);
        if (this.trigger !== null) {
          this.postRemaining -= due.count;
          if (this.postRemaining <= 0) {
            await this.flushPending();
            this.finish();
            break;
          }
        }
        continue;
      }

      const allowed = this.trigger === null
        ? remaining
        : Math.min(remaining, this.postRemaining);
      let count = Math.min(allowed, this.config!.chunkSamples);
      const boundary = this.nextDeviceBoundary();
      if (boundary !== null && boundary > this.nextSample) {
        count = Math.min(count, boundary - this.nextSample);
      }
      if (count <= 0) continue;

      await this.emitRange(this.nextSample, count);
      this.nextSample += count;
      advanced += count;
      remaining -= count;
      if (this.trigger !== null) {
        this.postRemaining -= count;
        if (this.postRemaining <= 0) {
          await this.flushPending();
          this.finish();
          break;
        }
      }
    }
    await this.flushPending();
    return advanced;
  }

  private finish(): void {
    if (this.completed) return;
    this.completed = true;
    this.phase = 'stopped';
    const onEnd = this.options?.onEnd ?? null;
    if (onEnd !== null) onEnd();
  }

  // ---------------------------------------------------------------- fault helpers

  /** First unfired stream fault at or before the current device position. */
  private dueFault(): FaultState | null {
    for (const fault of this.faults) {
      if (fault.fired) continue;
      if (fault.kind === 'short-packet' || fault.kind === 'malformed-header' ||
          fault.kind === 'slow-handshake') continue;
      if (fault.atSample <= this.nextSample) return fault;
    }
    return null;
  }

  /** Earliest sample position after the cursor that bounds the next transfer. */
  private nextDeviceBoundary(): number | null {
    let boundary: number | null = null;
    for (const fault of this.faults) {
      if (fault.fired) continue;
      if (fault.kind === 'malformed-header' || fault.kind === 'slow-handshake') continue;
      if (fault.atSample <= this.nextSample) continue;
      if (boundary === null || fault.atSample < boundary) boundary = fault.atSample;
    }
    return boundary;
  }

  /**
   * Report waiting gaps that overlap the emitted range fixed by the match. The emitted
   * stream starts at `firstSample` and ends at `deliveryEnd`, so a gap wholly before
   * `firstSample` carries no information about delivered samples (fill-before-arm makes
   * this the normal case after a waiting dropout) and is dropped; a straddling gap is
   * clipped to the delivered range.
   */
  private flushWaitingGaps(firstSample: number): void {
    const gaps = this.waitingGaps;
    this.waitingGaps = [];
    for (const gap of gaps) {
      const start = Math.max(gap.start, firstSample);
      const end = Math.min(gap.end, this.deliveryEnd);
      if (end > start) this.reportGap(start, end);
    }
  }

  /** Report a dropout span clipped to the delivered end (never past it). */
  private reportGap(start: number, end: number): void {
    const clippedEnd = Math.min(end, this.deliveryEnd);
    if (clippedEnd <= start) return;
    const sink = this.sink!;
    if (typeof sink.noteGap !== 'function') {
      this.phase = 'stopped';
      throw new SimDriverError(
        'dropout',
        `a dropout at [${start}, ${clippedEnd}) cannot be reported: the sink has no ` +
          'noteGap path',
      );
    }
    sink.noteGap({
      group: this.config!.groupId,
      start,
      end: clippedEnd,
      reason: 'dropout',
    });
  }

  // ---------------------------------------------------------------- byte delivery

  /**
   * Record the first emitted sample. Bytes always start at a sample boundary for the
   * first write of an acquisition; a later pending tail continues that same sample, so
   * this is never called with a mid-sample offset before the origin is known.
   */
  private markFirstSample(startByte: number): void {
    if (this.firstSamplePosition === null) {
      this.firstSamplePosition = Math.floor(startByte / this.config!.bytesPerSample);
    }
  }

  private async emitRange(start: number, count: number): Promise<void> {
    const cfg = this.config!;
    const sink = this.sink!;
    let offset = 0;
    while (offset < count) {
      await this.flushPending();
      const position = start + offset;
      let take = Math.min(count - offset, cfg.chunkSamples);
      for (const fault of this.faults) {
        if (fault.fired || fault.kind !== 'short-packet') continue;
        if (fault.atSample > position) take = Math.min(take, fault.atSample - position);
      }
      const bytes = this.pack(position, take);
      let keep = bytes.length;

      for (const fault of this.faults) {
        if (fault.fired || fault.kind !== 'short-packet') continue;
        if (fault.atSample > position) continue;
        fault.fired = true;
        const omit = Math.min(fault.count, bytes.length);
        keep = bytes.length - omit;
        if (omit > 0) {
          this.pending = bytes.slice(keep);
          this.pendingStartByte = position * cfg.bytesPerSample + keep;
        }
        break;
      }

      if (keep > 0) {
        const startByte = position * cfg.bytesPerSample;
        this.markFirstSample(startByte);
        await sink.write(bytes.subarray(0, keep), startByte);
      }
      offset += take;
    }
  }

  private async flushPending(): Promise<void> {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    // A short-packet fault may omit an entire chunk, leaving an empty tail; that is not
    // an emitted sample and must not fix the stream origin.
    if (pending.length === 0) return;
    this.markFirstSample(this.pendingStartByte);
    await this.sink!.write(pending, this.pendingStartByte);
  }
}

/** The profile's data-driven test-mode-2 table; validation guarantees it is present. */
function emulationFor(
  profile: DeviceProfile,
  channels: ChannelCount,
): ReturnType<typeof emulationRules> | null {
  const pattern = profile.digital.emulationPattern;
  if (pattern === undefined) return null;
  return emulationRules(pattern, channels);
}
