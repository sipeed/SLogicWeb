// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bounded software trigger for an interleaved device sample stream.
 *
 * This module deliberately sits below WebUSB and above SampleStore. `feed()` accepts
 * arbitrary transfer fragments, carries an incomplete sample to the next call, and
 * invokes `emit` synchronously with complete sample-aligned byte ranges. The emitted
 * ranges must be consumed before `feed()` returns; this matches SampleStore.append().
 *
 * The waiting state owns at most `preTriggerSamples * bytesPerSample` bytes. It never
 * accumulates an unbounded search prefix. Once a match is found, the retained prefix
 * and the trigger sample are emitted, followed by post-trigger samples until
 * `maxSamples` is reached.
 *
 * Pre-fill holdoff: after arming, and after any reset that empties the ring
 * (`resetContinuity()`, `noteGap()`), matches are ignored until `preTriggerSamples`
 * complete samples have been observed. A match therefore always carries the full
 * configured prefix (T == preTriggerSamples in the emitted stream), however dense the
 * trigger signal is. A condition edit (`reconfigure()`) keeps the ring and so does not
 * restart the holdoff. Continuous (Loop) mode applies it to the first match only; later
 * matches are on the already-emitted stream and need no ring. With
 * `preTriggerSamples === 0` there is no holdoff.
 *
 * Analog (ADC) crossings are qualified, never raw (docs/ARCHITECTURE.md, trigger
 * section). The ADC module's bus is sampled asynchronously to its code transitions, so
 * at a carry boundary the host reads the OR of the old and new codes for up to ~140 ns;
 * a raw "previous < level <= current" test fires a Rising condition on the falling
 * slope. Every analog condition therefore runs a small state machine:
 *
 *  - hysteresis `h` (`analogHysteresis`): a rising condition arms only after P
 *    consecutive codes <= `level - h` (falling: >= `level + h`, both clamped to the code
 *    range);
 *  - persistence `P` (`analogArtifactSamples`): the first armed sample at/past the level
 *    is a *candidate*; it is confirmed only when P consecutive samples, the candidate
 *    included, stay at/past the level. A sample back across the level drops the
 *    candidate and keeps the arm; confirmation disarms.
 *
 * The artifact only ever raises a code (the OR of two codes is >= both), so it fakes a
 * rising *candidate* and a falling *arm*: 111 -> 112 reads 127, which would arm a
 * Falling 112 trigger on the rising slope, after which the genuine codes <= 112 persist.
 * Persistence therefore applies to arming as well; with P = 1 both rules reduce to one
 * sample.
 *
 * T is the candidate sample, confirmed P - 1 samples later. To still emit exactly
 * `preTriggerSamples` before T, the waiting ring holds `preTriggerSamples + P - 1`
 * samples (bounded by MAX_ANALOG_ARTIFACT_SAMPLES); the persistence samples are inspected
 * and count toward `searchLimitSamples`. The pre-fill holdoff then applies to T: a
 * confirmation whose candidate lies inside the holdoff is consumed without a match.
 * Candidate state carries across transfers (complete samples only); a gap,
 * `resetContinuity()` or a condition edit resets it.
 *
 * Mixed digital + analog: the analog part must be confirmed and every digital condition
 * must hold on T itself (its edge evaluated against T - 1). Several analog conditions
 * must all have their candidate on the same sample T. An analog candidate whose digital
 * part fails at T is still confirmed (and so disarms) without a match: the slope it
 * belongs to was crossed while the gate was closed.
 */

import { bytesPerSampleForChannels, isChannelCount, type ChannelCount } from '../types.js';

export type SoftwareTriggerKind = 'level' | 'rising' | 'falling' | 'edge';
export type SoftwareTriggerLevel = 0 | 1;
/**
 * `one-shot` ends the search at the first match, which is what Single and Repeat need.
 * `continuous` keeps the same matcher and the same unbounded emitted stream after the
 * first match, re-arming it and reporting every later match by its absolute emitted-stream
 * sample index. This is the Loop form: when the App selects it, the page runs no second
 * scanner (until then Loop still uses the page-side analog path).
 */
export type SoftwareTriggerMode = 'one-shot' | 'continuous';
/** Hard heap ceiling for retained pre-trigger samples, including direct API use. */
export const MAX_SOFTWARE_TRIGGER_PREFIX_BYTES = 64 * 1024 * 1024;
/**
 * Default analog hysteresis in ADC codes for direct API use: the ADC module's measured
 * value (`ADC_TRIGGER_HYSTERESIS_CODES` beside the scale data in `ui/channelBanks.ts`,
 * which the app always passes explicitly).
 */
export const DEFAULT_ANALOG_HYSTERESIS_CODES = 4;
/**
 * Upper bound on `analogArtifactSamples`. 240 ns at the ADC's 800 MS/s ceiling is 192
 * samples; the bound only keeps a mistyped value from growing the waiting ring.
 */
export const MAX_ANALOG_ARTIFACT_SAMPLES = 4096;

/**
 * Bounded-cost scanning for repeated (continuous-mode) matches.
 *
 * Waiting for the first match is always a stride-1 scan: a trigger must be exact. After
 * the first match the stream can run for hours, so continuous scanning may evaluate only
 * every `stride`-th sample. A strided candidate that matches is refined locally at stride
 * 1 over the samples since the previous scanned sample, so the reported index is still the
 * exact crossing/edge sample. Candidates are `stride + 1` apart, so a pulse that lies
 * entirely in the `stride` samples between two candidates can be missed; keep the stride
 * below the narrowest pulse that must be caught.
 *
 * With `nsPerStreamSample` set, the controller compares measured scan time per stream
 * sample against `nsPerStreamSample * cpuFraction` and changes the stride by `step` at a
 * time. Changes only happen after `updateEverySamples` stream samples and only outside the
 * `lowWater`..`highWater` band (hysteresis), so a noisy measurement cannot oscillate the
 * stride every buffer. Without `nsPerStreamSample` the stride is fixed at `initialStride`.
 */
export interface SoftwareTriggerScanOptions {
  /** Smallest stride the controller may choose. Default 1. */
  minStride?: number;
  /** Largest stride the controller may choose; bounds retained history and CPU cost.
   * Default 1024 samples. Two buffers of `maxStride + 2` samples each are capped at
   * 64 MiB in total; a larger value is refused. */
  maxStride?: number;
  /** Stride used once continuous scanning starts. Default 1. */
  initialStride?: number;
  /**
   * Wall-clock nanoseconds one emitted stream sample represents, normally
   * `1e9 / samplerate`. Enables the cost controller when set; leave it unset for a fixed
   * stride (tests and callers that already chose their own budget).
   */
  nsPerStreamSample?: number;
  /** Fraction of one stream sample's wall time scanning may consume. Default 0.25. */
  cpuFraction?: number;
  /** Stream samples accumulated between stride updates. Default 8192. */
  updateEverySamples?: number;
  /** Multiplicative change per update. Default 2. */
  step?: number;
  /** Measured cost/budget ratio above which the stride grows. Default 1.25. */
  highWater?: number;
  /** Measured cost/budget ratio below which the stride shrinks. Default 0.5. */
  lowWater?: number;
}

export interface SoftwareTriggerCondition {
  channel: number;
  kind: SoftwareTriggerKind;
  level?: SoftwareTriggerLevel;
}

/**
 * An ADC-analog crossing. `start` is the first input of the group (bank-aligned); the
 * converter's code is the bit-reverse of that input byte (HSync adc.rs: input 0 is the
 * code's MSB). `level` is the code 0..255 the signal crosses.
 */
export interface SoftwareTriggerAnalogCondition {
  start: number;
  kind: 'rising' | 'falling';
  level: number;
}

/** Bit-reverse of one byte: the ADC group's MSB-first code from its input byte. */
export function reverseAdcByte(value: number): number {
  return REVERSED_BYTE[value & 0xff]!;
}

const REVERSED_BYTE = (() => {
  const table = new Uint8Array(256);
  for (let value = 0; value < 256; value++) {
    let v = value;
    let r = 0;
    for (let bit = 0; bit < 8; bit++) {
      r = (r << 1) | (v & 1);
      v >>>= 1;
    }
    table[value] = r;
  }
  return table;
})();

export interface SoftwareTriggerConfig {
  channels: ChannelCount;
  /**
   * All conditions must match on the same complete sample (logical AND). Contradictory
   * combinations (for example `level 0` with `level 1` on one channel, or `rising` with
   * `level 0`) are accepted but can never hold; the search simply ends as `noTrigger`
   * when its budget runs out.
   */
  conditions?: readonly SoftwareTriggerCondition[];
  /** Qualified analog crossings; T is their common candidate sample, on which the
   * digital conditions must hold (see the module comment). */
  analog?: readonly SoftwareTriggerAnalogCondition[];
  /**
   * Analog arming hysteresis in codes, an integer 1..255; default
   * DEFAULT_ANALOG_HYSTERESIS_CODES. 1 arms on any code before the level, which with
   * `analogArtifactSamples: 1` is the old raw crossing test. May change on `reconfigure()`
   * (omitted there: keep the running value).
   */
  analogHysteresis?: number;
  /**
   * Samples an analog candidate must stay at/past the level, the candidate included,
   * an integer 1..MAX_ANALOG_ARTIFACT_SAMPLES; default 1 (no persistence). The app passes
   * `ceil(240 ns * samplerate)`. Fixed for a matcher, because it sizes the waiting ring:
   * `reconfigure()` refuses a different value (omitted there: keep the running value).
   */
  analogArtifactSamples?: number;
  /** Legacy single-condition fields; retained for callers upgrading from v1. */
  kind?: SoftwareTriggerKind;
  /** Used by `level`; rising/falling/edge use the transition between samples. */
  level?: SoftwareTriggerLevel;
  channel?: number;
  /**
   * Number of samples retained immediately before the trigger sample. Matching is held
   * off until this many complete samples have been observed since arming (or since the
   * last continuity reset), so a delivered capture always has the full prefix.
   */
  preTriggerSamples: number;
  /**
   * Total samples emitted, including the retained prefix and trigger sample.
   * `Infinity` is the loop-capture form: after the match the stream is unbounded,
   * `complete` never sets, and the capture ends only on a manual stop.
   */
  maxSamples: number;
  /** Optional waiting budget. Infinity means keep rolling the prefix until stopped.
   * Pre-fill holdoff samples are inspected and count toward it. */
  searchLimitSamples?: number;
  /**
   * One-shot (default) or continuous (Loop) matching. The mode is fixed for the life of a
   * matcher; `reconfigure()` cannot switch it. Continuous mode requires `maxSamples` to be
   * `Infinity` or another finite stream budget: either way every match after the first is
   * reported on the same emitted stream, and the pre-trigger ring is only used before the
   * first match (the stream already contains everything after it).
   */
  mode?: SoftwareTriggerMode;
  /** Continuous-scan stride policy; ignored in one-shot mode. See SoftwareTriggerScanOptions. */
  scan?: SoftwareTriggerScanOptions;
  /**
   * Minimum emitted-stream sample distance between match callbacks in continuous mode.
   * `0` (default) reports every match to `onMatch`; a positive value throttles the
   * UI-facing callback only. `matchCount` and `lastTriggerSampleIndex` still account for
   * every match, and the first match is always reported.
   */
  reportGapSamples?: number;
}

export interface SoftwareTriggerStats {
  /** Samples inspected while waiting, through the deciding sample if found: the trigger
   * sample, or for an analog set the sample that confirmed it (T + P - 1). */
  inspectedSamples: number;
  /** Samples emitted to the downstream store. */
  emittedSamples: number;
  /** Whether a trigger condition has matched. Remains true after the first continuous
   * match; `matchCount` says how many matches were seen. */
  matched: boolean;
  /** Zero-based index of the first trigger sample in the emitted stream. */
  triggerSampleIndex: number | null;
  /** All matches, including the first, in continuous mode; 1 for one-shot. */
  matchCount: number;
  /** Emitted-stream index of the most recent match. */
  lastTriggerSampleIndex: number | null;
  /** Current continuous-scan stride. Always 1 while waiting for the first match. */
  scanStride: number;
  /** True after finish() when no trigger condition matched. */
  noTrigger: boolean;
  /** Whether maxSamples has been emitted and the caller can stop the device. Never
   * sets for an unbounded (loop) trigger, whose maxSamples is Infinity. */
  complete: boolean;
}

/** One reported match. `index` is the zero-based emitted-stream sample index. */
export interface SoftwareTriggerMatch {
  index: number;
  count: number;
}

export interface SoftwareTriggerOptions {
  config: SoftwareTriggerConfig;
  emit: (chunk: Uint8Array) => void;
  /**
   * Called for every reported match. The first match is always called; later continuous
   * matches are suppressed when they are closer than `reportGapSamples`. A caller that
   * needs every match, statistics included, reads `stats`.
   */
  onMatch?: (match: SoftwareTriggerMatch) => void;
  /** Monotonic wall clock in milliseconds, for the stride controller. Injectable so the
   * cost policy can be tested deterministically; defaults to performance.now(). */
  now?: () => number;
}

/** A condition pre-digested for the per-sample scan (no property lookups per sample). */
interface CompiledCondition {
  channel: number;
  /** Byte inside one sample holding the channel. */
  byte: number;
  /** Bit inside that byte. */
  bit: number;
  kind: SoftwareTriggerKind;
  level: number;
}

interface CompiledAnalogCondition {
  /** Byte inside one sample holding the group's inputs. */
  byte: number;
  rise: boolean;
  level: number;
  /** Arming threshold: rising arms at code <= arm, falling at code >= arm. */
  arm: number;
}

/** Fully-defaulted form of SoftwareTriggerScanOptions. */
interface ScanSettings {
  minStride: number;
  maxStride: number;
  initialStride: number;
  /** null disables cost adaptation and keeps the stride fixed. */
  nsPerStreamSample: number | null;
  cpuFraction: number;
  updateEverySamples: number;
  step: number;
  highWater: number;
  lowWater: number;
}

/** Strided analog reads (continuous mode): see `coarseRead`. */
const COARSE_NONE = 0;
const COARSE_HIT = 1;
const COARSE_ARM = 2;

const DEFAULT_SCAN_MAX_STRIDE = 1024;
const DEFAULT_SCAN_CPU_FRACTION = 0.25;
const DEFAULT_SCAN_UPDATE_SAMPLES = 8192;
const DEFAULT_SCAN_STEP = 2;
const DEFAULT_SCAN_HIGH_WATER = 1.25;
const DEFAULT_SCAN_LOW_WATER = 0.5;

/** The history ring and the refinement scratch are each `maxStride + 2` samples; both
 * must fit inside the same bound as the largest pre-trigger prefix, so a mistyped stride
 * cannot allocate an arbitrary amount of memory. */
function scanBuffersFit(maxStride: number, bytesPerSample: number): boolean {
  return (maxStride + 2) * bytesPerSample * 2 <= MAX_SOFTWARE_TRIGGER_PREFIX_BYTES;
}

function sameScanSettings(a: ScanSettings, b: ScanSettings): boolean {
  return a.minStride === b.minStride && a.maxStride === b.maxStride &&
    a.initialStride === b.initialStride &&
    a.nsPerStreamSample === b.nsPerStreamSample &&
    a.cpuFraction === b.cpuFraction &&
    a.updateEverySamples === b.updateEverySamples &&
    a.step === b.step && a.highWater === b.highWater && a.lowWater === b.lowWater;
}

function normalizeScanOptions(options: SoftwareTriggerScanOptions | undefined): ScanSettings {
  const minStride = options?.minStride ?? 1;
  const maxStride = options?.maxStride ?? DEFAULT_SCAN_MAX_STRIDE;
  const initialStride = options?.initialStride ?? 1;
  const nsPerStreamSample = options?.nsPerStreamSample;
  const cpuFraction = options?.cpuFraction ?? DEFAULT_SCAN_CPU_FRACTION;
  const updateEverySamples = options?.updateEverySamples ?? DEFAULT_SCAN_UPDATE_SAMPLES;
  const step = options?.step ?? DEFAULT_SCAN_STEP;
  const highWater = options?.highWater ?? DEFAULT_SCAN_HIGH_WATER;
  const lowWater = options?.lowWater ?? DEFAULT_SCAN_LOW_WATER;
  if (!Number.isInteger(minStride) || minStride < 1) {
    throw new Error(`scan minStride must be a positive integer, got ${minStride}`);
  }
  if (!Number.isInteger(maxStride) || maxStride < minStride) {
    throw new Error(`scan maxStride must be an integer >= minStride (${minStride}), got ${maxStride}`);
  }
  if (!Number.isInteger(initialStride) || initialStride < minStride || initialStride > maxStride) {
    throw new Error(`scan initialStride must be an integer in ${minStride}..${maxStride}, got ${initialStride}`);
  }
  if (nsPerStreamSample !== undefined &&
      (!Number.isFinite(nsPerStreamSample) || nsPerStreamSample <= 0)) {
    throw new Error(`scan nsPerStreamSample must be a positive finite number, got ${nsPerStreamSample}`);
  }
  if (!Number.isFinite(cpuFraction) || cpuFraction <= 0 || cpuFraction > 1) {
    throw new Error(`scan cpuFraction must be in (0, 1], got ${cpuFraction}`);
  }
  if (!Number.isInteger(updateEverySamples) || updateEverySamples < 1) {
    throw new Error(`scan updateEverySamples must be a positive integer, got ${updateEverySamples}`);
  }
  if (!Number.isFinite(step) || step <= 1) {
    throw new Error(`scan step must be greater than 1, got ${step}`);
  }
  if (!Number.isFinite(lowWater) || lowWater <= 0 ||
      !Number.isFinite(highWater) || highWater <= lowWater) {
    throw new Error(`scan water marks must satisfy 0 < lowWater < highWater, got ${lowWater}/${highWater}`);
  }
  return {
    minStride, maxStride, initialStride,
    nsPerStreamSample: nsPerStreamSample ?? null,
    cpuFraction, updateEverySamples, step, highWater, lowWater,
  };
}

function defaultNow(): number {
  return performance.now();
}

function assertConfig(c: SoftwareTriggerConfig): void {
  if (!isChannelCount(c.channels)) {
    throw new Error(`unsupported trigger channel width ${c.channels}`);
  }
  const conditions = c.conditions?.length
    ? c.conditions
    : c.channel !== undefined && c.kind !== undefined
      ? [{ channel: c.channel, kind: c.kind, level: c.level }]
      : [];
  const analog = c.analog ?? [];
  if (conditions.length === 0 && analog.length === 0) {
    throw new Error('software trigger requires at least one condition');
  }
  for (const condition of conditions) {
    if (!Number.isInteger(condition.channel) || condition.channel < 0 || condition.channel >= c.channels) {
      throw new Error(`trigger channel ${condition.channel} outside 0..${c.channels - 1}`);
    }
    if (condition.kind !== 'level' && condition.kind !== 'rising' &&
        condition.kind !== 'falling' && condition.kind !== 'edge') {
      throw new Error(`unsupported trigger kind ${String(condition.kind)}`);
    }
    if (condition.kind === 'level' && condition.level !== 0 && condition.level !== 1) {
      throw new Error(`level trigger requires level 0 or 1, got ${condition.level}`);
    }
  }
  for (const a of analog) {
    if (!Number.isInteger(a.start) || a.start < 0 || a.start % 8 !== 0 ||
        a.start + 8 > c.channels) {
      throw new Error(`analog trigger group ${a.start} is not a bank inside 0..${c.channels - 1}`);
    }
    if (a.kind !== 'rising' && a.kind !== 'falling') {
      throw new Error(`analog trigger kind must be rising or falling, got ${a.kind}`);
    }
    if (!Number.isInteger(a.level) || a.level < 0 || a.level > 255) {
      throw new Error(`analog trigger level must be a code 0..255, got ${a.level}`);
    }
    if (a.kind === 'rising' && a.level === 0) {
      throw new Error('a rising analog trigger cannot cross code 0');
    }
    if (a.kind === 'falling' && a.level === 255) {
      throw new Error('a falling analog trigger cannot cross code 255');
    }
  }
  if (!Number.isInteger(c.preTriggerSamples) || c.preTriggerSamples < 0) {
    throw new Error(`preTriggerSamples must be a non-negative integer, got ${c.preTriggerSamples}`);
  }
  if (c.maxSamples !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(c.maxSamples) || c.maxSamples < 1)) {
    throw new Error(`maxSamples must be a positive integer or Infinity, got ${c.maxSamples}`);
  }
  if (c.searchLimitSamples !== undefined && c.searchLimitSamples !== Infinity &&
      (!Number.isInteger(c.searchLimitSamples) || c.searchLimitSamples < 1)) {
    throw new Error(`searchLimitSamples must be a positive integer or Infinity, got ${c.searchLimitSamples}`);
  }
  if (c.mode !== undefined && c.mode !== 'one-shot' && c.mode !== 'continuous') {
    throw new Error(`unsupported trigger mode ${String(c.mode)}`);
  }
  if (c.reportGapSamples !== undefined &&
      (!Number.isInteger(c.reportGapSamples) || c.reportGapSamples < 0)) {
    throw new Error(`reportGapSamples must be a non-negative integer, got ${c.reportGapSamples}`);
  }
  if (c.analogHysteresis !== undefined &&
      (!Number.isInteger(c.analogHysteresis) || c.analogHysteresis < 1 || c.analogHysteresis > 255)) {
    throw new Error(`analogHysteresis must be an integer code count 1..255, got ${c.analogHysteresis}`);
  }
  if (c.analogArtifactSamples !== undefined &&
      (!Number.isInteger(c.analogArtifactSamples) || c.analogArtifactSamples < 1 ||
        c.analogArtifactSamples > MAX_ANALOG_ARTIFACT_SAMPLES)) {
    throw new Error(
      `analogArtifactSamples must be an integer 1..${MAX_ANALOG_ARTIFACT_SAMPLES}, got ${c.analogArtifactSamples}`,
    );
  }
  normalizeScanOptions(c.scan);
  if (c.kind === 'level' && c.level !== 0 && c.level !== 1) {
    throw new Error(`level trigger requires level 0 or 1, got ${c.level}`);
  }
}

/**
 * A synchronous, bounded trigger state machine.
 *
 * A pre-trigger equal to the full capture budget is reduced by one sample so the
 * trigger sample itself can always be retained. This makes the output budget an
 * invariant rather than a best effort.
 */
export class SoftwareTrigger {
  readonly channels: ChannelCount;
  readonly bytesPerSample: number;
  /** Fixed for this matcher; see reconfigure(). */
  readonly mode: SoftwareTriggerMode;
  /** First condition, kept for callers that read one trigger; updated by reconfigure(). */
  channel!: number;
  kind!: SoftwareTriggerKind;
  level: SoftwareTriggerLevel | undefined;
  readonly preTriggerSamples: number;
  readonly maxSamples: number;
  conditions!: readonly SoftwareTriggerCondition[];
  /** Analog (ADC) crossings, all ANDed with the digital conditions. */
  analog!: readonly SoftwareTriggerAnalogCondition[];
  /** Maximum complete samples inspected while waiting. Defaults to output budget plus
   * retained prefix; callers may use Infinity for a timer that starts at trigger time. */
  readonly searchLimitSamples: number;
  /** Analog arming hysteresis in codes; updated by reconfigure(). */
  analogHysteresis: number;
  /** Analog persistence in samples; fixed (it sizes the ring). */
  readonly analogArtifactSamples: number;

  private readonly emit: (chunk: Uint8Array) => void;
  private readonly onMatch: ((match: SoftwareTriggerMatch) => void) | null;
  private readonly now: () => number;
  private reportGapSamples: number;
  private scanSettings: ScanSettings;
  private readonly ring: Uint8Array;
  private compiled!: CompiledCondition[];
  private analogCompiled!: CompiledAnalogCondition[];
  /** Per-condition channel value of the sample being evaluated; see `findMatch`. */
  private values!: Uint8Array;
  /** Per analog condition: armed (1) or not, see the module comment. */
  private analogArmed!: Uint8Array;
  /** Per analog condition: samples at/past the level since the candidate, 0 = none. */
  private analogRun!: Int32Array;
  /** Per analog condition, while unarmed: consecutive samples past the arming
   * threshold; the condition arms when this reaches the persistence window. */
  private analogArmRun!: Int32Array;
  /** Per analog condition: whether the digital conditions held on its candidate. */
  private analogCandDigital!: Uint8Array;
  /** Per analog condition, continuous mode: armed as seen by the strided scan. */
  private coarseArmed!: Uint8Array;
  /** Continuous mode with analog conditions: the exact (stride-1) machine is running. */
  private exactLive = false;
  /** Continuous mode: the exact machine may hand back to the strided scan only after
   * this emitted-stream sample, and only with no candidate pending. */
  private exactIdleAfterAbs = 0;
  /** Offset of the sample at which `stepQualified` last stopped for being idle. */
  private qualifiedStopOff = 0;
  /** Pre-trigger ring capacity: `preTriggerSamples + analogArtifactSamples - 1`. */
  private readonly ringCapacity: number;
  private ringStart = 0;
  private ringCount = 0;
  private partial = new Uint8Array(0);
  private previous!: Array<number | null>;
  /** Current stride for repeated matches; always 1 while waiting for the first. */
  private strideValue = 1;
  /** Absolute emitted-stream index of the last sample evaluated by the strided scan. */
  private lastScannedAbs = -1;
  /** Whether `lastScannedSample` / `previous` describe that sample. False after a
   * condition edit or a transport gap, where continuity deliberately restarts. */
  private hasScannedContinuity = false;
  /** Raw bytes of `lastScannedAbs`, used to rebuild per-condition state when a strided
   * candidate matches and the samples since then must be refined at stride 1. */
  private lastScannedSample: Uint8Array;
  /** Absolute emitted-stream index of the next strided candidate. */
  private nextScanAbs = 0;
  /**
   * Bounded ring of the most recent continuous-mode samples. A refinement segment
   * starts at `lastScannedAbs + 1`, which is at most `stride + 1` samples back; retaining
   * `maxStride + 2` samples makes the segment readable across transfer boundaries without
   * an unbounded search prefix.
   */
  private history: Uint8Array;
  private historyCapacity: number;
  private historyCount = 0;
  private historyHead = 0;
  private historyStartAbs = 0;
  private historyEndAbs = 0;
  /** Segment scratch for local refinement, sized like the history ring. */
  private refineScratch: Uint8Array;
  private scanCostMs = 0;
  private scanCoveredSamples = 0;
  /** Last index handed to onMatch, for reportGapSamples. */
  private lastReportedIndex = Number.NEGATIVE_INFINITY;
  private statsValue: SoftwareTriggerStats = {
    inspectedSamples: 0,
    emittedSamples: 0,
    matched: false,
    triggerSampleIndex: null,
    matchCount: 0,
    lastTriggerSampleIndex: null,
    scanStride: 1,
    noTrigger: false,
    complete: false,
  };

  constructor(opts: SoftwareTriggerOptions) {
    assertConfig(opts.config);
    this.channels = opts.config.channels;
    this.bytesPerSample = bytesPerSampleForChannels(this.channels);
    this.mode = opts.config.mode ?? 'one-shot';
    this.maxSamples = opts.config.maxSamples;
    this.reportGapSamples = opts.config.reportGapSamples ?? 0;
    this.scanSettings = normalizeScanOptions(opts.config.scan);
    this.strideValue = this.scanSettings.initialStride;
    this.onMatch = opts.onMatch ?? null;
    this.now = opts.now ?? defaultNow;
    const conditions: readonly SoftwareTriggerCondition[] = opts.config.conditions?.length
      ? opts.config.conditions
      : opts.config.channel !== undefined && opts.config.kind !== undefined
        ? [{
          channel: opts.config.channel, kind: opts.config.kind,
          ...(opts.config.level !== undefined ? { level: opts.config.level } : {}),
        }]
        : [];
    const analog = opts.config.analog ?? [];
    if (conditions.length === 0 && analog.length === 0) {
      throw new Error('software trigger requires at least one condition');
    }
    this.analogHysteresis = opts.config.analogHysteresis ?? DEFAULT_ANALOG_HYSTERESIS_CODES;
    this.analogArtifactSamples = opts.config.analogArtifactSamples ?? 1;
    this.installConditions(conditions, analog);
    this.preTriggerSamples = this.clampPreTrigger(opts.config.preTriggerSamples);
    this.ringCapacity = this.preTriggerSamples + this.analogArtifactSamples - 1;
    this.searchLimitSamples = opts.config.searchLimitSamples ?? this.maxSamples + this.preTriggerSamples;
    this.emit = opts.emit;
    // Validate the scan-buffer cap before allocating anything, so a rejected configuration
    // cannot transiently allocate the pre-trigger ring.
    if (this.mode === 'continuous' &&
        !scanBuffersFit(this.scanSettings.maxStride, this.bytesPerSample)) {
      throw new Error(
        `scan maxStride ${this.scanSettings.maxStride} needs more than ` +
        `${MAX_SOFTWARE_TRIGGER_PREFIX_BYTES} bytes for the bounded scan buffers`,
      );
    }
    this.ring = new Uint8Array(this.ringCapacity * this.bytesPerSample);
    // One-shot matching never scans after its single match, so it needs no history.
    this.historyCapacity = this.mode === 'continuous' ? this.scanSettings.maxStride + 2 : 0;
    this.history = new Uint8Array(this.historyCapacity * this.bytesPerSample);
    this.refineScratch = new Uint8Array(this.historyCapacity * this.bytesPerSample);
    this.lastScannedSample = new Uint8Array(this.bytesPerSample);
    // Waiting for the first match is exact, so the exposed stride starts at 1 even if
    // continuous mode was configured with a larger initial stride.
    this.statsValue.scanStride = 1;
  }

  get waiting(): boolean {
    return !this.statsValue.matched && !this.statsValue.noTrigger;
  }

  /** The retained prefix a request gets: below the output budget, and inside the byte
   * bound together with the analog persistence samples the ring also holds. */
  private clampPreTrigger(requested: number): number {
    return Math.min(
      requested,
      Math.max(0, this.maxSamples - 1),
      Math.max(0, Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / this.bytesPerSample) -
        (this.analogArtifactSamples - 1)),
    );
  }

  /**
   * Replace the matching conditions while the matcher can still accept an edit, keeping
   * the pre-trigger ring, emitted-stream accounting and inspected budget.
   *
   * In one-shot mode this is the "edit while waiting" path and returns false once the
   * matcher has matched. In continuous mode the matcher is still live after a match and
   * the edit applies immediately so a Loop trigger can be retuned while it runs; it
   * returns false only once the stream is terminal (`noTrigger` or `complete`).
   *
   * The capture width, retained-prefix size, output budget and mode are fixed for a
   * running capture: the ring was allocated at that size, the emitted-stream accounting
   * depends on it, and switching modes would change what the stream means. A caller that
   * needs to change those restarts the capture instead. Scan cost parameters and
   * `reportGapSamples` are tuning, not capture shape, and may be updated live.
   */
  reconfigure(config: SoftwareTriggerConfig): boolean {
    // An omitted mode means "the mode this matcher already runs", so existing one-shot
    // callers that build a config without the new field keep working.
    const requestedMode = config.mode ?? this.mode;
    if (requestedMode !== this.mode) return false;
    if (this.mode === 'continuous') {
      if (this.statsValue.complete || this.statsValue.noTrigger) return false;
    } else if (!this.waiting) {
      return false;
    }
    if (config.channels !== this.channels) return false;
    // The persistence window sizes the ring like the prefix does; omitted keeps it.
    if (config.analogArtifactSamples !== undefined &&
        config.analogArtifactSamples !== this.analogArtifactSamples) return false;
    // The constructor clamps the requested prefix to the capture budget and the prefix
    // byte bound; a caller repeating its original request must still be accepted.
    const effectivePreTrigger = this.clampPreTrigger(config.preTriggerSamples);
    if (effectivePreTrigger !== this.preTriggerSamples) return false;
    // The output budget fixes where the capture stops; a different one cannot be adopted
    // mid-stream. searchLimitSamples is also kept as-is (the observed search budget).
    if (config.maxSamples !== this.maxSamples) return false;
    assertConfig({
      ...config,
      channels: this.channels,
      preTriggerSamples: this.preTriggerSamples,
      maxSamples: this.maxSamples,
      mode: this.mode,
    });
    const nextHysteresis = config.analogHysteresis ?? this.analogHysteresis;
    const conditions: readonly SoftwareTriggerCondition[] = config.conditions?.length
      ? config.conditions
      : config.channel !== undefined && config.kind !== undefined
        ? [{
          channel: config.channel, kind: config.kind,
          ...(config.level !== undefined ? { level: config.level } : {}),
        }]
        : [];
    const analog = config.analog ?? [];
    if (conditions.length === 0 && analog.length === 0) return false;
    const nextScan = config.scan !== undefined ? normalizeScanOptions(config.scan) : null;
    const scanChanged = nextScan !== null && !sameScanSettings(nextScan, this.scanSettings);
    const conditionsChanged = !this.sameConditions(conditions, analog) ||
      (analog.length > 0 && nextHysteresis !== this.analogHysteresis);
    // Every field is validated before anything is written: a refused retune must not
    // partially apply (in particular, reportGapSamples must keep its old value).
    const nextReportGap = config.reportGapSamples ?? this.reportGapSamples;
    if (this.mode === 'continuous' && this.statsValue.matched) {
      // After the first match a tuning-only retune (`reportGapSamples`, or a scan policy
      // identical to the running one) must not restart the scan: doing so would invent a
      // null previous value at the edit and drop an edge that straddles it. Only an edit
      // that changes what is scanned re-anchors continuity at the next sample.
      if (scanChanged && !this.adoptScanOptions(nextScan)) return false;
      this.analogHysteresis = nextHysteresis;
      if (conditionsChanged) this.installConditions(conditions, analog);
      if (conditionsChanged || scanChanged) this.resetPostMatchScanAtNextSample();
      this.reportGapSamples = nextReportGap;
      return true;
    }
    // Waiting (one-shot, or continuous before its first match): the documented retune
    // contract restarts edge continuity so no transition is invented across the edit, and
    // the retained prefix is history that stays valid.
    if (nextScan !== null && !this.adoptScanOptions(nextScan)) return false;
    this.analogHysteresis = nextHysteresis;
    this.installConditions(conditions, analog);
    this.reportGapSamples = nextReportGap;
    return true;
  }

  /** Whether `conditions`/`analog` describe exactly the installed matcher. */
  private sameConditions(
    conditions: readonly SoftwareTriggerCondition[],
    analog: readonly SoftwareTriggerAnalogCondition[],
  ): boolean {
    if (conditions.length !== this.conditions.length || analog.length !== this.analog.length) {
      return false;
    }
    for (let i = 0; i < conditions.length; i++) {
      const a = this.conditions[i]!;
      const b = conditions[i]!;
      if (a.channel !== b.channel || a.kind !== b.kind || a.level !== b.level) return false;
    }
    for (let i = 0; i < analog.length; i++) {
      const a = this.analog[i]!;
      const b = analog[i]!;
      if (a.start !== b.start || a.kind !== b.kind || a.level !== b.level) return false;
    }
    return true;
  }

  /** Adopt new scan tuning, reallocating the bounded history whenever its capacity
   * changes (growth or shrink). Returns false when the requested stride needs more
   * memory than the scan-buffer cap. */
  private adoptScanOptions(next: ScanSettings): boolean {
    if (this.mode === 'continuous' &&
        !scanBuffersFit(next.maxStride, this.bytesPerSample)) {
      return false;
    }
    this.scanSettings = next;
    const capacity = this.mode === 'continuous' ? next.maxStride + 2 : 0;
    if (capacity !== this.historyCapacity) {
      this.historyCapacity = capacity;
      this.history = new Uint8Array(capacity * this.bytesPerSample);
      this.refineScratch = new Uint8Array(capacity * this.bytesPerSample);
    }
    // The ring caches samples scanned under the old stride policy. Restart it even when
    // the capacity is unchanged: in particular, a shrinking policy would otherwise leave
    // `historyHead` past the end of the smaller allocation. The caller restarts scan
    // continuity at the next sample, so the empty ring is never used to bridge the edit.
    this.historyHead = 0;
    this.historyCount = 0;
    this.historyStartAbs = this.statsValue.emittedSamples;
    this.historyEndAbs = this.statsValue.emittedSamples;
    this.strideValue = Math.min(next.maxStride, Math.max(next.minStride,
      this.statsValue.matched ? this.strideValue : next.initialStride));
    this.statsValue.scanStride = this.statsValue.matched ? this.strideValue : 1;
    this.scanCostMs = 0;
    this.scanCoveredSamples = 0;
    return true;
  }

  /**
   * Install a condition set and reset edge continuity: a transition that straddles the
   * edit must not be invented from the old condition's last sample. The pre-trigger ring
   * is history and stays valid; the waiting search simply continues from the next sample.
   */
  private installConditions(
    conditions: readonly SoftwareTriggerCondition[],
    analog: readonly SoftwareTriggerAnalogCondition[],
  ): void {
    const first = conditions[0];
    this.channel = first?.channel ?? 0;
    this.kind = first?.kind ?? 'level';
    this.level = first?.level;
    for (const c of conditions) {
      if (!Number.isInteger(c.channel) || c.channel < 0 || c.channel >= this.channels) {
        throw new Error(`trigger channel ${c.channel} outside 0..${this.channels - 1}`);
      }
      if (c.kind === 'level' && c.level !== 0 && c.level !== 1) {
        throw new Error(`level trigger requires level 0 or 1, got ${c.level}`);
      }
    }
    this.conditions = conditions.map((c) => c.level === undefined
      ? { channel: c.channel, kind: c.kind! }
      : { channel: c.channel, kind: c.kind!, level: c.level });
    this.analog = analog.map((a) => ({ start: a.start, kind: a.kind, level: a.level }));
    this.compiled = this.conditions.map((c) => ({
      channel: c.channel, byte: c.channel >>> 3, bit: c.channel & 7,
      kind: c.kind, level: c.level ?? 0,
    }));
    // A level within `h` of the code range's end arms at the end code itself (rising
    // level 3 with h = 4 arms at code 0), so every level 1..254 stays reachable.
    const h = this.analogHysteresis;
    this.analogCompiled = this.analog.map((a) => ({
      byte: a.start >>> 3, rise: a.kind === 'rising', level: a.level,
      arm: a.kind === 'rising' ? Math.max(0, a.level - h) : Math.min(255, a.level + h),
    }));
    this.values = new Uint8Array(this.compiled.length);
    this.previous = Array.from({ length: this.channels }, () => null);
    const n = this.analogCompiled.length;
    this.analogArmed = new Uint8Array(n);
    this.analogRun = new Int32Array(n);
    this.analogArmRun = new Int32Array(n);
    this.analogCandDigital = new Uint8Array(n);
    this.coarseArmed = new Uint8Array(n);
  }

  /** Forget every analog arm and candidate (a gap, a reset or a condition edit). */
  private resetAnalogState(): void {
    this.analogArmed.fill(0);
    this.analogRun.fill(0);
    this.analogArmRun.fill(0);
    this.analogCandDigital.fill(0);
    this.coarseArmed.fill(0);
  }

  get stats(): SoftwareTriggerStats {
    return { ...this.statsValue };
  }

  /**
   * Feed any transfer fragment. A fragment may end in the middle of a wide sample.
   * The only retained bytes outside the ring are at most bytesPerSample - 1.
   *
   * Work is done in whole-sample blocks, not per sample: the waiting scan walks the
   * fragment once, the retained prefix is copied with at most two `ring.set` calls,
   * and everything after a match is handed downstream as one range. A per-sample
   * `subarray` and emit would allocate and copy millions of times per second on the
   * read thread and cap triggered captures far below the transport's own rate.
   */
  feed(fragment: Uint8Array): void {
    if (fragment.byteLength === 0 || this.statsValue.complete || this.statsValue.noTrigger) return;

    let src = fragment;
    if (this.partial.length > 0) {
      const need = this.bytesPerSample - this.partial.length;
      const take = Math.min(need, src.length);
      const joined = new Uint8Array(this.partial.length + take);
      joined.set(this.partial);
      joined.set(src.subarray(0, take), this.partial.length);
      src = src.subarray(take);
      if (joined.length < this.bytesPerSample) {
        this.partial = joined;
        return;
      }
      this.partial = new Uint8Array(0);
      this.consumeWhole(joined);
      if (this.statsValue.complete || this.statsValue.noTrigger) return;
      // Fall through: `src` still holds whole samples and (in continuous mode) may hold
      // later matches, whether or not the joined sample matched.
    }

    const whole = src.length - (src.length % this.bytesPerSample);
    if (whole < src.length) this.partial = src.slice(whole);
    if (whole === 0) return;
    this.consumeWhole(src.subarray(0, whole));
  }

  /**
   * Route one whole-sample block to the state it belongs to.
   *
   * Waiting: the block is scanned at stride 1 and, on a match, the ring and trigger sample
   * are emitted. Matched one-shot: everything is post-trigger output. Matched continuous:
   * the same block is scanned for repeated matches and emitted; scanning happens before
   * emission so the matcher may read the caller's buffer without the sink detaching it.
   */
  private consumeWhole(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.statsValue.complete || this.statsValue.noTrigger) return;
    if (this.statsValue.matched) {
      if (this.mode === 'continuous') this.consumeContinuous(bytes);
      else this.emitPost(bytes);
      return;
    }
    const matchEnd = this.consumeAligned(bytes);
    if (matchEnd < 0) return;
    if (this.mode === 'continuous') {
      if (matchEnd < bytes.length) this.consumeContinuous(bytes.subarray(matchEnd));
    } else if (matchEnd < bytes.length) {
      this.emitPost(bytes.subarray(matchEnd));
    }
  }

  /**
   * End a capture that stopped before a match. The ring is discarded and no
   * untriggered samples are emitted: callers can expose `noTrigger` to the UI.
   */
  finish(): void {
    if (this.statsValue.matched || this.statsValue.complete) return;
    this.partial = new Uint8Array(0);
    this.ringStart = 0;
    this.ringCount = 0;
    this.statsValue.noTrigger = true;
  }

  /**
   * A device dropout invalidates a transition across the gap and any pre-trigger
   * bytes spanning it. The processor remains bounded and continues searching. While
   * waiting, the emptied ring restarts the pre-fill holdoff: no match is accepted until
   * `preTriggerSamples` contiguous samples after the gap have been observed, so the
   * delivered prefix never spans the discontinuity. After the first match the ring is
   * unused and only scan continuity restarts.
   */
  resetContinuity(): void {
    this.previous.fill(null);
    this.resetAnalogState();
    this.partial = new Uint8Array(0);
    this.ringStart = 0;
    this.ringCount = 0;
    // A continuous matcher keeps scanning the same stream; the samples on either side of
    // a gap are not contiguous, so refinement must not bridge it either.
    this.resetPostMatchScanAtNextSample();
  }

  /** Forget continuous-scan state and resume at the next stream sample. Used by a live
   * condition edit and by a transport gap. The emitted index of that next sample is
   * `emittedSamples`, so a virtual previous position one sample earlier makes the first
   * refinement segment start there even when the first candidate is `stride` away. */
  private resetPostMatchScanAtNextSample(): void {
    this.hasScannedContinuity = false;
    this.lastScannedAbs = this.statsValue.emittedSamples - 1;
    this.nextScanAbs = this.statsValue.emittedSamples;
    this.historyCount = 0;
    this.historyHead = 0;
    this.historyStartAbs = this.statsValue.emittedSamples;
    this.historyEndAbs = this.statsValue.emittedSamples;
    this.scanCostMs = 0;
    this.scanCoveredSamples = 0;
    // Analog: restart the machine exactly at the next sample, from no arm and no edge
    // history; its first idle sample hands back to the strided scan.
    if (this.analogCompiled.length > 0) {
      this.previous.fill(null);
      this.resetAnalogState();
    }
    this.exactLive = true;
    this.exactIdleAfterAbs = this.statsValue.emittedSamples;
  }

  /** Account for samples lost in a transport gap without allowing a transition
   * across the gap. The bounded search budget still advances.
   *
   * `noteGap` has no caller in the device path today, but if it advances
   * `inspectedSamples` to the search limit between feeds, the next block is allowed to
   * scan zero samples and the search ends: the budget is enforced before matching. That
   * is stricter than the old per-sample loop (which matched before testing the limit)
   * and is the intended reading of "never look past the search budget". */
  noteGap(samples: number): void {
    if (!Number.isFinite(samples) || samples <= 0 || !this.waiting) {
      this.resetContinuity();
      return;
    }
    this.statsValue.inspectedSamples += Math.floor(samples);
    this.resetContinuity();
    if (this.statsValue.inspectedSamples >= this.searchLimitSamples) this.finish();
  }

  /**
   * Inspect one whole-sample buffer while waiting, then either stop at a match or add
   * the scanned prefix to the ring. Returns the offset just past the trigger sample
   * (relative to `bytes`), or -1 when nothing matched.
   */
  private consumeAligned(bytes: Uint8Array): number {
    if (this.statsValue.matched || this.statsValue.complete || this.statsValue.noTrigger) return -1;
    const total = bytes.length / this.bytesPerSample;
    if (total <= 0) return -1;

    // Never look past the search budget: a match beyond the limit must be ignored.
    // One nuance versus the old per-sample loop: after `noteGap()` pushed the count to
    // the limit between feeds, the old loop still inspected (and could match) one more
    // sample. Here the budget is enforced before the scan; see `noteGap()`.
    let scanSamples = total;
    if (Number.isFinite(this.searchLimitSamples)) {
      const budget = this.searchLimitSamples - this.statsValue.inspectedSamples;
      scanSamples = Math.min(total, Math.max(0, Math.floor(budget)));
    }
    if (scanSamples <= 0) {
      this.finish();
      return -1;
    }
    const to = scanSamples * this.bytesPerSample;
    // Pre-fill holdoff (oscilloscope semantics): a match is accepted only once the ring
    // holds `preTriggerSamples` complete samples observed since arming or since the last
    // ring reset (`resetContinuity`/`noteGap`). Without it a dense signal would trigger on
    // its first edge after arm and deliver almost no negative time. The ring only fills
    // while waiting, so `preTriggerSamples - ringCount` is exactly the holdoff left; no
    // extra state is needed and nothing beyond the ring is retained.
    //
    // Holdoff samples are inspected (they advance `inspectedSamples` and therefore count
    // toward `searchLimitSamples`): they consumed stream time. A finite search limit must
    // therefore exceed `preTriggerSamples` to allow any match; the defaults (`maxSamples +
    // preTriggerSamples`, and Repeat's `pre + post`) leave exactly the post budget for
    // matching.
    //
    // Edge state is primed from the last holdoff sample, so the first post-holdoff sample
    // is compared with its true predecessor (which is the newest ring sample): an edge
    // whose new value lands on that sample is valid. A sample joined across transfers
    // reaches here as a one-sample block, so it is primed or matched like any other.
    //
    // A set with analog conditions takes the qualified path instead (its holdoff applies
    // to T, see consumeAlignedAnalog). The ring may be larger than the prefix (it also
    // holds the analog persistence samples), so the holdoff left is clamped at zero.
    if (this.analogCompiled.length > 0) return this.consumeAlignedAnalog(bytes, scanSamples);
    const holdoff = Math.max(0, Math.min(scanSamples, this.preTriggerSamples - this.ringCount));
    let from = 0;
    if (holdoff > 0) {
      from = holdoff * this.bytesPerSample;
      this.restorePrevious(bytes.subarray(from - this.bytesPerSample, from));
    }
    const match = from < to ? this.findMatch(bytes, from, to) : -1;
    if (match >= 0) return this.acceptMatch(bytes, match, 0);
    this.statsValue.inspectedSamples += scanSamples;
    this.appendRing(bytes, 0, to);
    if (this.statsValue.inspectedSamples >= this.searchLimitSamples) this.finish();
    return -1;
  }

  /**
   * The waiting scan for a condition set with analog crossings. The qualified machine
   * runs over every inspected sample, holdoff included, so an arm or a candidate is
   * never invented at the holdoff's end. A confirmation counts only when its candidate T
   * has `preTriggerSamples` observed samples before it; one inside the holdoff is
   * consumed (it disarms) and the scan continues. The ring holds `pre + P - 1` samples,
   * so at a confirmation C it still holds [T - pre, C) even when T arrived in an earlier
   * transfer. Persistence samples are inspected, so a confirmation past the search limit
   * is never seen.
   */
  private consumeAlignedAnalog(bytes: Uint8Array, scanSamples: number): number {
    const bps = this.bytesPerSample;
    const to = scanSamples * bps;
    const lag = this.analogArtifactSamples - 1;
    // `ringCount` is the samples observed since the last ring reset, exact below the
    // ring's capacity - and the capacity is exactly the `pre + lag` a match needs.
    const need = this.preTriggerSamples + lag;
    let from = 0;
    while (from < to) {
      const confirm = this.stepQualified(bytes, from, to, Number.POSITIVE_INFINITY);
      if (confirm < 0) break;
      if (this.ringCount + confirm / bps >= need) return this.acceptMatch(bytes, confirm, lag);
      from = confirm + bps;
    }
    this.statsValue.inspectedSamples += scanSamples;
    this.appendRing(bytes, 0, to);
    if (this.statsValue.inspectedSamples >= this.searchLimitSamples) this.finish();
    return -1;
  }

  /**
   * Emit the first match. `match` is the offset in `bytes` of the deciding sample C; T
   * lies `lag` samples before it (0 for a digital set, P - 1 for an analog one).
   * Everything before C goes to the ring first, so the ring's newest `pre + lag` samples
   * are [T - pre, C). They and C are emitted inside `maxSamples`, and T's emitted index
   * is exactly `pre`. Returns the offset just past C.
   */
  private acceptMatch(bytes: Uint8Array, match: number, lag: number): number {
    const bps = this.bytesPerSample;
    this.statsValue.inspectedSamples += match / bps; // samples before C
    this.appendRing(bytes, 0, match);
    this.statsValue.matched = true;
    const before = this.statsValue.emittedSamples;
    this.emitRingNewest(this.preTriggerSamples + lag);
    // The first `pre` samples just emitted precede T, the exact T=0 sample seen by
    // SampleStore.
    this.statsValue.triggerSampleIndex = before + this.preTriggerSamples;
    this.statsValue.lastTriggerSampleIndex = this.statsValue.triggerSampleIndex;
    this.statsValue.matchCount = 1;
    if (this.mode === 'continuous') {
      this.beginContinuousScan(bytes, match, this.statsValue.triggerSampleIndex + lag);
    }
    // `pre <= maxSamples - 1` keeps T inside the budget; the persistence samples after
    // it (and C) may not all fit a tiny budget.
    if (this.statsValue.emittedSamples < this.maxSamples) {
      this.emit(bytes.subarray(match, match + bps));
      this.statsValue.emittedSamples += 1;
    }
    this.statsValue.inspectedSamples += 1; // the deciding sample itself
    if (this.statsValue.emittedSamples >= this.maxSamples) this.statsValue.complete = true;
    // Report after the trigger sample has been handed to the sink: the first match
    // keeps the one-shot ordering (data, then event). Later continuous matches are
    // reported while scanning, before their block is emitted.
    this.reportMatch(this.statsValue.triggerSampleIndex);
    return match + bps;
  }

  /* ---------------------------------------------------------------------------------
   * Continuous mode: repeated matching on the unbounded emitted stream.
   *
   * Everything below runs only after the first match. The samples are emitted unchanged;
   * the matcher merely chooses which of them to evaluate. A strided candidate that matches
   * is refined at stride 1 over the samples since the previous scanned sample, so every
   * reported index is the exact sample where the condition first held.
   * ------------------------------------------------------------------------------- */

  /** Seed the repeated-match scan at the deciding sample (the trigger sample, or for an
   * analog set its confirming sample; `triggerIndex` is that sample's emitted index).
   * Called before the sample is emitted, so its bytes are copied first: a sink may
   * detach the buffer. An analog set keeps its exact machine (just confirmed, so
   * disarmed) running until it is idle. */
  private beginContinuousScan(bytes: Uint8Array, match: number, triggerIndex: number): void {
    this.exactLive = true;
    this.exactIdleAfterAbs = triggerIndex + 1;
    this.strideValue = this.scanSettings.initialStride;
    this.statsValue.scanStride = this.strideValue;
    this.lastScannedAbs = triggerIndex;
    this.hasScannedContinuity = true;
    const off = match;
    this.lastScannedSample.set(bytes.subarray(off, off + this.bytesPerSample));
    this.nextScanAbs = triggerIndex + 1;
    this.historyCount = 0;
    this.historyHead = 0;
    this.historyStartAbs = triggerIndex + 1;
    this.historyEndAbs = triggerIndex + 1;
    this.scanCostMs = 0;
    this.scanCoveredSamples = 0;
    this.lastReportedIndex = Number.NEGATIVE_INFINITY;
  }

  /** Report a match to the caller, subject to reportGapSamples. Statistics have already
   * been updated by the caller; this only decides whether the UI-facing callback fires. */
  private reportMatch(index: number): void {
    const onMatch = this.onMatch;
    if (onMatch === null) return;
    if (this.reportGapSamples > 0 && index - this.lastReportedIndex < this.reportGapSamples) return;
    this.lastReportedIndex = index;
    onMatch({ index, count: this.statsValue.matchCount });
  }

  /**
   * Scan and emit one post-match whole-sample block.
   *
   * Scanning happens first, while the block is still valid; the block is then copied into
   * the bounded history ring before `emit`, because the device sink may detach the
   * buffer. Only `maxSamples` can bound the emitted stream; a loop trigger uses Infinity
   * and never sets `complete`.
   */
  private consumeContinuous(bytes: Uint8Array): void {
    const bps = this.bytesPerSample;
    const available = Math.floor(bytes.length / bps);
    if (available <= 0) return;
    const remaining = this.maxSamples - this.statsValue.emittedSamples;
    const count = Number.isFinite(remaining)
      ? Math.min(available, Math.max(0, Math.floor(remaining)))
      : available;
    if (count <= 0) return;
    const n = count * bps;
    const region = bytes.subarray(0, n);
    // Every sample in this region is about to be emitted, so its stream index is the
    // current output count. Matches are reported with that absolute numbering.
    const baseAbs = this.statsValue.emittedSamples;
    const started = this.now();
    const analog = this.analogCompiled.length > 0;
    if (analog) this.scanPostMatchAnalog(region, baseAbs, count);
    else this.scanPostMatch(region, baseAbs, count);
    // A finite stream ends here, and striding may have left the last `scanStep() - 1`
    // samples after the final candidate. Finish them at stride 1 so a genuine crossing in
    // the final samples of the budget is still reported and counted.
    if (Number.isFinite(this.maxSamples) && baseAbs + count >= this.maxSamples) {
      if (analog) this.drainFinalTailAnalog(region, baseAbs, count);
      else this.drainFinalTail(region, baseAbs, count);
    }
    const elapsedMs = this.now() - started;
    this.recordScanCost(elapsedMs, count);
    this.appendScanHistory(region, baseAbs, count);
    this.emit(region);
    this.statsValue.emittedSamples += count;
    if (this.statsValue.emittedSamples >= this.maxSamples) this.statsValue.complete = true;
  }

  /**
   * Distance between strided candidates. At stride 1 there is none (the scan is exact).
   * Above 1 the grid advances by `stride + 1`, which rotates its phase by one sample per
   * candidate. Without that, a periodic signal whose period divides the stride would land
   * on the same phase every time and its crossings would never become candidates; with it,
   * every residue class is visited within `stride` candidates. The extra sample is why the
   * history/scratch bound is `maxStride + 2`, and it does not change the CPU bound.
   */
  private scanStep(): number {
    return this.strideValue > 1 ? this.strideValue + 1 : 1;
  }

  /**
   * Evaluate strided candidates in `region`. `baseAbs` is the emitted-stream index of its
   * first sample. The scan grid advances by `scanStep()`, not by the bare stride, so a
   * periodic signal cannot hide behind an unlucky phase.
   */
  private scanPostMatch(region: Uint8Array, baseAbs: number, count: number): void {
    const bps = this.bytesPerSample;
    const endAbs = baseAbs + count;
    // A candidate may already be due inside this block (the previous block ended before
    // the step elapsed). Samples skipped at the head are covered by the history ring.
    let candAbs = Math.max(this.nextScanAbs, baseAbs);
    while (candAbs < endAbs) {
      // The cost controller can shrink the stride between blocks, so the last re-anchor
      // (made with the previous, larger `scanStep()`) can land before this block. Never
      // scan outside the block: the bounded history ring already covers those samples and
      // the next refinement reads them from there. Without this clamp `off` would be
      // negative and the byte offsets/subarray indices meaningless.
      candAbs = Math.max(candAbs, baseAbs);
      const off = candAbs - baseAbs;
      // One-sample findMatch gives the exact same condition semantics as the waiting
      // scan, including "evaluate against previous, then update". On a hit it has already
      // advanced `previous` to the candidate; refineMatch restores the state at the last
      // scanned sample from lastScannedSample and rescans the gap at stride 1.
      const hit = this.findMatch(region, off * bps, (off + 1) * bps);
      if (hit >= 0) {
        const exactAbs = this.refineMatch(region, baseAbs, candAbs);
        // -1 means the candidate only matched against stale state from the previous
        // candidate; with an AND of conditions that is a false positive. refineMatch has
        // already restored the state at the candidate, so treat it as an ordinary miss.
        if (exactAbs >= 0) {
          this.statsValue.matchCount += 1;
          this.statsValue.lastTriggerSampleIndex = exactAbs;
          this.reportMatch(exactAbs);
          this.lastScannedAbs = exactAbs;
          this.hasScannedContinuity = true;
          // Re-anchor the strided grid at the exact crossing so the reported phase does
          // not drift. Samples between the crossing and the next candidate are not
          // re-examined: refinement reports the first match in the gap only, and a second
          // crossing there is seen only if a later candidate lands on it.
          this.nextScanAbs = exactAbs + this.scanStep();
          candAbs = this.nextScanAbs;
          continue;
        }
      } else {
        // No match: findMatch left `previous` at the candidate.
        this.lastScannedSample.set(region.subarray(off * bps, (off + 1) * bps));
      }
      this.lastScannedAbs = candAbs;
      this.hasScannedContinuity = true;
      this.nextScanAbs = candAbs + this.scanStep();
      candAbs = this.nextScanAbs;
    }
  }

  /**
   * Refine the tail of a finite stream after the last strided candidate. `count` samples
   * end the capture (`baseAbs + count >= maxSamples`), so no later candidate can discover
   * a crossing in the remaining `scanStep() - 1` samples. Reuse `refineMatch` at stride 1,
   * reporting every genuine match in order until the segment is exhausted. The loop is
   * bounded by `count` samples and never scans beyond the emitted budget.
   */
  private drainFinalTail(region: Uint8Array, baseAbs: number, count: number): void {
    const endAbs = baseAbs + count;
    if (endAbs <= 0) return;
    const candidateAbs = endAbs - 1;
    while (this.lastScannedAbs < candidateAbs) {
      const exactAbs = this.refineMatch(region, baseAbs, candidateAbs);
      if (exactAbs < 0) {
        // refineMatch has already restored the state at the final candidate.
        this.lastScannedAbs = candidateAbs;
        this.hasScannedContinuity = true;
        this.nextScanAbs = endAbs;
        return;
      }
      this.statsValue.matchCount += 1;
      this.statsValue.lastTriggerSampleIndex = exactAbs;
      this.reportMatch(exactAbs);
      this.lastScannedAbs = exactAbs;
      this.hasScannedContinuity = true;
      this.nextScanAbs = endAbs;
    }
  }

  /* ---------------------------------------------------------------------------------
   * Continuous mode with analog conditions.
   *
   * The qualified machine has history (arm, candidate run), so it cannot be rebuilt from
   * one raw sample the way the digital refinement is. Two states alternate instead:
   *
   *  - exact: the machine runs at stride 1 on every sample, across blocks, and reports
   *    each confirmed T (which may lie in an earlier, already emitted block - the index
   *    is absolute). It runs while a candidate is pending, at stride 1, and until the
   *    sample that made it start; once idle it hands back to the strided scan with its
   *    arm state.
   *  - strided: every `scanStep()`-th sample is read coarsely. The strided scan never
   *    arms by itself (one sample may be an artifact): an unarmed condition past its
   *    arming threshold starts the exact machine at that sample, which qualifies the arm
   *    over P samples and hands the result back. A code at/past the level while armed is
   *    a hit: the exact machine restarts at the sample after the previous strided one
   *    (read from the bounded history ring when that lies in an earlier block), armed,
   *    with the digital edge state rebuilt from that previous sample.
   *
   * Every reported T is a crossing qualified at stride 1; the stride can only miss one.
   * The strided scan assumes no qualified crossing hid between two strided samples, so a
   * crossing whose P samples all lie between strided samples (P < stride) can be missed,
   * and the arm taken from before it can then qualify a later candidate: keep the stride
   * at or below the persistence window when that matters. Exact runs are bounded by
   * `stride + P` samples per strided sample plus the time a candidate or an arm is
   * pending.
   * ------------------------------------------------------------------------------- */

  private scanPostMatchAnalog(region: Uint8Array, baseAbs: number, count: number): void {
    const bps = this.bytesPerSample;
    const endAbs = baseAbs + count;
    let pos = baseAbs;
    while (pos < endAbs) {
      if (this.exactLive) {
        pos = this.runExact(region, baseAbs, pos, endAbs);
        continue;
      }
      // The grid may lag this block after a shrink or an exact run that ended in the
      // history part; never read outside the block (see scanPostMatch).
      const candAbs = Math.max(this.nextScanAbs, pos);
      if (candAbs >= endAbs) break;
      const off = (candAbs - baseAbs) * bps;
      const coarse = this.scanStep() === 1 ? COARSE_HIT : this.coarseRead(region, off);
      if (coarse === COARSE_HIT) {
        pos = this.enterExact(baseAbs, candAbs);
        continue;
      }
      if (coarse === COARSE_ARM) {
        pos = this.enterExact(baseAbs, candAbs, candAbs + this.analogArtifactSamples - 1);
        continue;
      }
      this.lastScannedSample.set(region.subarray(off, off + bps));
      this.lastScannedAbs = candAbs;
      this.hasScannedContinuity = true;
      this.nextScanAbs = candAbs + this.scanStep();
      pos = candAbs + 1;
    }
  }

  /** The finite stream ends in this block: run the exact machine over whatever the
   * strided scan left after its last sample, to the end. A candidate still pending at
   * the end can never be confirmed. */
  private drainFinalTailAnalog(region: Uint8Array, baseAbs: number, count: number): void {
    const endAbs = baseAbs + count;
    // A live machine has already run to the end. Each pass otherwise either runs to the
    // end or hands back at a later sample, so the loop advances and is bounded by `count`.
    while (!this.exactLive && this.lastScannedAbs < endAbs - 1) {
      const pos = this.enterExact(baseAbs, endAbs - 1);
      if (this.exactLive && pos < endAbs) this.runExact(region, baseAbs, pos, endAbs);
    }
  }

  /** Strided read of one sample: COARSE_HIT when every analog condition is armed and
   * at/past its level here, COARSE_ARM when an unarmed one is past its arming threshold
   * (the exact machine must qualify that arm), COARSE_NONE otherwise. */
  private coarseRead(region: Uint8Array, off: number): number {
    const an = this.analogCompiled;
    const coarse = this.coarseArmed;
    let hit = true;
    let arm = false;
    for (let i = 0; i < an.length; i++) {
      const a = an[i]!;
      const code = REVERSED_BYTE[region[off + a.byte]!]!;
      if (coarse[i] === 0) {
        hit = false;
        if (a.rise ? code <= a.arm : code >= a.arm) arm = true;
      } else if (!(a.rise ? code >= a.level : code <= a.level)) {
        hit = false;
      }
    }
    return hit ? COARSE_HIT : arm ? COARSE_ARM : COARSE_NONE;
  }

  /**
   * Restart the exact machine at `lastScannedAbs + 1` for a strided sample at
   * `candAbs`: armed as the exact machine last handed back, no candidate, digital state
   * from the previous strided sample. It runs at least through `idleAfterAbs` - the hit
   * sample, or for an arm `candAbs + P - 1`, since an arm needs P samples. Samples before
   * `baseAbs` come from the history ring and are run here; the return value is where the
   * caller continues inside the block.
   */
  private enterExact(baseAbs: number, candAbs: number, idleAfterAbs = candAbs): number {
    const startAbs = this.lastScannedAbs + 1;
    this.restorePrevious(this.hasScannedContinuity ? this.lastScannedSample : null);
    this.analogArmed.set(this.coarseArmed);
    this.analogRun.fill(0);
    this.analogArmRun.fill(0);
    this.exactLive = true;
    this.exactIdleAfterAbs = idleAfterAbs;
    if (startAbs >= baseAbs) return startAbs;
    const wanted = baseAbs - startAbs;
    if (!this.historyCovers(startAbs, wanted)) {
      // Defensive, as in refineMatch: never bridge samples we do not have.
      this.restorePrevious(null);
      return baseAbs;
    }
    this.copyHistory(startAbs, wanted, this.refineScratch, 0);
    return Math.max(baseAbs, this.runExact(this.refineScratch, startAbs, startAbs, baseAbs));
  }

  /**
   * Run the exact machine over `[fromAbs, toAbs)` of `buf`, whose first sample is
   * `bufBaseAbs`. Reports every confirmation. Returns the sample after the one where the
   * machine went idle and handed back to the strided scan, or `toAbs` while still live.
   */
  private runExact(buf: Uint8Array, bufBaseAbs: number, fromAbs: number, toAbs: number): number {
    const bps = this.bytesPerSample;
    const lag = this.analogArtifactSamples - 1;
    let abs = fromAbs;
    while (abs < toAbs) {
      // At stride 1 the machine never hands back: it is the scan.
      const idleFrom = this.scanStep() > 1
        ? (Math.max(abs, this.exactIdleAfterAbs) - bufBaseAbs) * bps
        : Number.POSITIVE_INFINITY;
      const r = this.stepQualified(
        buf, (abs - bufBaseAbs) * bps, (toAbs - bufBaseAbs) * bps, idleFrom,
      );
      if (r >= 0) {
        const confirmAbs = bufBaseAbs + r / bps;
        const exactAbs = confirmAbs - lag;
        this.statsValue.matchCount += 1;
        this.statsValue.lastTriggerSampleIndex = exactAbs;
        this.reportMatch(exactAbs);
        this.exactIdleAfterAbs = confirmAbs + 1;
        abs = confirmAbs + 1;
        continue;
      }
      if (r === -2) {
        const off = this.qualifiedStopOff;
        const stopAbs = bufBaseAbs + off / bps;
        this.exactLive = false;
        this.coarseArmed.set(this.analogArmed);
        this.lastScannedSample.set(buf.subarray(off, off + bps));
        this.lastScannedAbs = stopAbs;
        this.hasScannedContinuity = true;
        this.nextScanAbs = stopAbs + this.scanStep();
        return stopAbs + 1;
      }
      return toAbs;
    }
    return toAbs;
  }

  /**
   * Advance the qualified analog machine (and the digital edge state) over whole samples
   * `[from, to)` of `bytes`. Returns the offset of the sample that confirms a match (T is
   * `analogArtifactSamples - 1` samples earlier), -1 at `to`, or -2 when, at a sample at
   * or after `idleFrom`, no candidate is pending (`qualifiedStopOff` is that sample).
   * See the module comment for the rule; state lives in the fields, so a call may stop
   * and resume anywhere, including across transfers.
   */
  private stepQualified(bytes: Uint8Array, from: number, to: number, idleFrom: number): number {
    const bps = this.bytesPerSample;
    const persist = this.analogArtifactSamples;
    const an = this.analogCompiled;
    const conds = this.compiled;
    const armed = this.analogArmed;
    const run = this.analogRun;
    const armRun = this.analogArmRun;
    const prev = this.previous;
    if (conds.length === 0 && an.length === 1) {
      // The common case, one crossing with no gate, gets a tight loop of its own.
      const a = an[0]!;
      const byte = a.byte;
      const level = a.level;
      const arm = a.arm;
      const rise = a.rise;
      let isArmed = armed[0]!;
      let r = run[0]!;
      let ar = armRun[0]!;
      for (let off = from; off < to; off += bps) {
        const code = REVERSED_BYTE[bytes[off + byte]!]!;
        const past = rise ? code >= level : code <= level;
        if (r > 0) r = past ? r + 1 : 0;
        else if (past) {
          // Past the level is not past the arming threshold: an arm run restarts.
          if (isArmed === 1) r = 1;
          else ar = 0;
        } else if (isArmed === 0) {
          ar = (rise ? code <= arm : code >= arm) ? ar + 1 : 0;
          if (ar >= persist) { isArmed = 1; ar = 0; }
        }
        if (r >= persist) {
          armed[0] = 0;
          run[0] = 0;
          armRun[0] = 0;
          return off;
        }
        if (r === 0 && ar === 0 && off >= idleFrom) {
          armed[0] = isArmed;
          run[0] = 0;
          armRun[0] = 0;
          this.qualifiedStopOff = off;
          return -2;
        }
      }
      armed[0] = isArmed;
      run[0] = r;
      armRun[0] = ar;
      return -1;
    }
    const cand = this.analogCandDigital;
    if (conds.length === 1 && an.length === 1) {
      // The natural mixed case - a digital gate plus an ADC crossing.
      const d = conds[0]!;
      const mask = 1 << d.bit;
      const a = an[0]!;
      const rise = a.rise;
      let digital = prev[d.channel] ?? null;
      let isArmed = armed[0]!;
      let r = run[0]!;
      let ar = armRun[0]!;
      let gate = cand[0]!;
      for (let off = from; off < to; off += bps) {
        const bit = (bytes[off + d.byte]! & mask) === 0 ? 0 : 1;
        const digitalOk = d.kind === 'level' ? bit === d.level
          : d.kind === 'rising' ? digital === 0 && bit === 1
            : d.kind === 'falling' ? digital === 1 && bit === 0
              : digital !== null && digital !== bit;
        digital = bit;
        const code = REVERSED_BYTE[bytes[off + a.byte]!]!;
        const past = rise ? code >= a.level : code <= a.level;
        if (r > 0) r = past ? r + 1 : 0;
        else if (past) {
          if (isArmed === 1) {
            r = 1;
            gate = digitalOk ? 1 : 0;
          } else {
            ar = 0;
          }
        } else if (isArmed === 0) {
          ar = (rise ? code <= a.arm : code >= a.arm) ? ar + 1 : 0;
          if (ar >= persist) { isArmed = 1; ar = 0; }
        }
        if (r >= persist) {
          isArmed = 0;
          r = 0;
          if (gate === 1) {
            prev[d.channel] = digital;
            armed[0] = 0;
            run[0] = 0;
            armRun[0] = 0;
            cand[0] = gate;
            return off;
          }
        }
        if (r === 0 && ar === 0 && off >= idleFrom) {
          prev[d.channel] = digital;
          armed[0] = isArmed;
          run[0] = 0;
          armRun[0] = 0;
          cand[0] = gate;
          this.qualifiedStopOff = off;
          return -2;
        }
      }
      prev[d.channel] = digital;
      armed[0] = isArmed;
      run[0] = r;
      armRun[0] = ar;
      cand[0] = gate;
      return -1;
    }
    const values = this.values;
    for (let off = from; off < to; off += bps) {
      let digitalOk = true;
      for (let i = 0; i < conds.length; i++) {
        const c = conds[i]!;
        const value = (bytes[off + c.byte]! >>> c.bit) & 1;
        values[i] = value;
        const old = prev[c.channel]!;
        switch (c.kind) {
          case 'level': if (value !== c.level) digitalOk = false; break;
          case 'rising': if (!(old === 0 && value === 1)) digitalOk = false; break;
          case 'falling': if (!(old === 1 && value === 0)) digitalOk = false; break;
          case 'edge': if (!(old !== null && old !== value)) digitalOk = false; break;
          default: digitalOk = false; break;
        }
      }
      for (let i = 0; i < conds.length; i++) prev[conds[i]!.channel] = values[i]!;
      // Every analog condition must confirm on this sample: with equal persistence their
      // candidates then all began on the same T, where cand[0] says the gate held.
      let all = true;
      let pending = false;
      for (let i = 0; i < an.length; i++) {
        const a = an[i]!;
        const code = REVERSED_BYTE[bytes[off + a.byte]!]!;
        const past = a.rise ? code >= a.level : code <= a.level;
        let r = run[i]!;
        if (r > 0) r = past ? r + 1 : 0;
        else if (past) {
          if (armed[i] === 1) {
            r = 1;
            cand[i] = digitalOk ? 1 : 0;
          } else {
            armRun[i] = 0;
          }
        } else if (armed[i] === 0) {
          const ar = (a.rise ? code <= a.arm : code >= a.arm) ? armRun[i]! + 1 : 0;
          if (ar >= persist) {
            armed[i] = 1;
            armRun[i] = 0;
          } else {
            armRun[i] = ar;
          }
        }
        if (r >= persist) {
          armed[i] = 0;
          r = 0;
        } else {
          all = false;
        }
        if (r > 0 || armRun[i]! > 0) pending = true;
        run[i] = r;
      }
      if (all && cand[0] === 1) return off;
      if (!pending && off >= idleFrom) {
        this.qualifiedStopOff = off;
        return -2;
      }
    }
    return -1;
  }

  /**
   * Refine a strided candidate at stride 1 and return the absolute index of the first
   * matching sample in `(lastScannedAbs, candidateAbs]`, or -1 when the stride-1 segment
   * contains no sample where every condition holds together.
   *
   * -1 is not hypothetical for an AND of conditions: the candidate was tested against the
   * state left at the previous candidate, so two conditions that became true at different
   * samples can look satisfied together. The exact sample the caller reports must come
   * from this stride-1 scan, never from the candidate alone.
   *
   * The segment is copied into a reusable scratch buffer: its tail comes from the current
   * region, and any prefix from a previous transfer comes from the bounded history ring.
   * Then the condition state at the last scanned sample is rebuilt from its raw bytes and
   * the ordinary `findMatch` runs at stride 1, so byte packing, bank-aligned analog bytes
   * and complete samples are exactly those of the waiting scan. The scratch is bounded by
   * `maxStride + 2` samples; no search prefix is ever retained.
   */
  private refineMatch(current: Uint8Array, baseAbs: number, candidateAbs: number): number {
    const bps = this.bytesPerSample;
    const startAbs = this.lastScannedAbs + 1;
    let effectiveStartAbs = startAbs;
    let offsetSamples = 0;
    let continuity = this.hasScannedContinuity;

    if (startAbs < baseAbs) {
      const wanted = baseAbs - startAbs;
      if (this.historyCovers(startAbs, wanted)) {
        this.copyHistory(startAbs, wanted, this.refineScratch, 0);
        offsetSamples = wanted;
      } else {
        // Defensive: this cannot happen while `historyCapacity >= maxStride + 2` and the
        // stride/phase bounds are respected. If it ever does, drop the unavailable prefix
        // and restart continuity at this block rather than bridging samples we do not have.
        effectiveStartAbs = baseAbs;
        offsetSamples = 0;
        continuity = false;
      }
    }

    const currentStartAbs = Math.max(startAbs, baseAbs);
    const currentCount = candidateAbs - currentStartAbs + 1;
    if (currentCount > 0) {
      const src = (currentStartAbs - baseAbs) * bps;
      this.refineScratch.set(
        current.subarray(src, src + currentCount * bps), offsetSamples * bps,
      );
      offsetSamples += currentCount;
    }
    if (offsetSamples <= 0) {
      // Unreachable while the candidate lies inside the current region. Never report the
      // candidate unverified: leave the state at the candidate as an ordinary miss.
      this.setScannedCandidate(current, baseAbs, candidateAbs);
      return -1;
    }

    this.restorePrevious(continuity ? this.lastScannedSample : null);
    const found = this.findMatch(this.refineScratch, 0, offsetSamples * bps);
    if (found >= 0) {
      const exactAbs = effectiveStartAbs + found / bps;
      this.lastScannedSample.set(this.refineScratch.subarray(found, found + bps));
      return exactAbs;
    }
    // The candidate matched only against stale state; the stride-1 segment has no sample
    // where all conditions hold. Continue from the candidate as a miss.
    this.setScannedCandidate(current, baseAbs, candidateAbs);
    return -1;
  }

  /** Copy one sample out of the current region into `lastScannedSample` and restore the
   * per-condition state from it. Used when a strided candidate is known not to match. */
  private setScannedCandidate(
    current: Uint8Array, baseAbs: number, candidateAbs: number,
  ): void {
    const bps = this.bytesPerSample;
    const off = (candidateAbs - baseAbs) * bps;
    this.lastScannedSample.set(current.subarray(off, off + bps));
    this.restorePrevious(this.lastScannedSample);
  }

  /** Rebuild the digital previous-value state from one raw sample. `null` restarts edge
   * continuity (a condition edit or transport gap). The analog machine has history and
   * is never rebuilt from one sample; see stepQualified/enterExact. */
  private restorePrevious(sample: Uint8Array | null): void {
    if (sample === null) {
      this.previous.fill(null);
      return;
    }
    const prev = this.previous;
    for (let channel = 0; channel < this.channels; channel++) {
      prev[channel] = (sample[channel >>> 3]! >>> (channel & 7)) & 1;
    }
  }

  /** Whether the bounded history ring can supply every sample in [start, start+count). */
  private historyCovers(startAbs: number, count: number): boolean {
    return this.historyCount > 0 && startAbs >= this.historyStartAbs &&
      startAbs + count <= this.historyEndAbs;
  }

  /** Copy `count` samples starting at `startAbs` out of the history ring. The caller has
   * checked coverage. At most two `set` calls. */
  private copyHistory(
    startAbs: number, count: number, out: Uint8Array, outSampleOffset: number,
  ): void {
    const cap = this.historyCapacity;
    const bps = this.bytesPerSample;
    const offset = startAbs - this.historyStartAbs;
    let ringIndex = (this.historyHead - this.historyCount + offset) % cap;
    if (ringIndex < 0) ringIndex += cap;
    let remaining = count;
    let dst = outSampleOffset;
    while (remaining > 0) {
      const first = Math.min(remaining, cap - ringIndex);
      out.set(this.history.subarray(ringIndex * bps, (ringIndex + first) * bps), dst * bps);
      dst += first;
      remaining -= first;
      ringIndex = (ringIndex + first) % cap;
    }
  }

  /** Append the newest samples of an emitted block to the bounded ring. Only the tail can
   * ever be needed: a refinement segment reaches back at most stride + 1 samples. */
  private appendScanHistory(region: Uint8Array, baseAbs: number, count: number): void {
    const cap = this.historyCapacity;
    const bps = this.bytesPerSample;
    const take = Math.min(count, cap);
    if (take <= 0) return;
    const startSample = count - take;
    const startAbs = baseAbs + startSample;
    const endAbs = baseAbs + count;
    if (take === cap) {
      this.history.set(region.subarray(startSample * bps, count * bps), 0);
      this.historyHead = 0;
      this.historyCount = cap;
      this.historyStartAbs = startAbs;
      this.historyEndAbs = endAbs;
      return;
    }
    const first = Math.min(take, cap - this.historyHead);
    this.history.set(
      region.subarray(startSample * bps, (startSample + first) * bps),
      this.historyHead * bps,
    );
    if (first < take) {
      this.history.set(region.subarray((startSample + first) * bps, count * bps), 0);
    }
    this.historyHead = (this.historyHead + take) % cap;
    this.historyStartAbs = this.historyCount === 0
      ? startAbs
      : Math.max(this.historyStartAbs, endAbs - cap);
    this.historyCount = Math.min(cap, this.historyCount + take);
    this.historyEndAbs = endAbs;
  }

  /**
   * Accumulate measured scan cost and, once enough stream samples have passed, move the
   * stride one step. The measured quantity is scan milliseconds per stream sample (all
   * samples in the blocks scanned, not just candidates), so refinement and condition work
   * are included. Hysteresis plus the update interval keep a noisy clock from oscillating
   * the stride; performance can only change the stride, never the reported index.
   */
  private recordScanCost(elapsedMs: number, coveredSamples: number): void {
    if (!(elapsedMs >= 0) || coveredSamples <= 0) return;
    this.scanCostMs += elapsedMs;
    this.scanCoveredSamples += coveredSamples;
    if (this.scanCoveredSamples < this.scanSettings.updateEverySamples) return;
    const budgetNs = this.scanSettings.nsPerStreamSample;
    if (budgetNs !== null) {
      const budgetMs = (budgetNs * this.scanSettings.cpuFraction) / 1e6;
      if (budgetMs > 0) {
        const ratio = (this.scanCostMs / this.scanCoveredSamples) / budgetMs;
        if (ratio >= this.scanSettings.highWater) {
          this.setStride(Math.min(
            this.scanSettings.maxStride,
            Math.max(this.strideValue + 1, Math.ceil(this.strideValue * this.scanSettings.step)),
          ));
        } else if (ratio <= this.scanSettings.lowWater) {
          this.setStride(Math.max(
            this.scanSettings.minStride,
            Math.min(this.strideValue - 1, Math.floor(this.strideValue / this.scanSettings.step)),
          ));
        }
      }
    }
    this.scanCostMs = 0;
    this.scanCoveredSamples = 0;
  }

  private setStride(stride: number): void {
    this.strideValue = Math.min(this.scanSettings.maxStride, Math.max(this.scanSettings.minStride, stride));
    this.statsValue.scanStride = this.strideValue;
  }

  /**
   * Offset of the first sample in [from, to) whose conditions all hold, or -1.
   *
   * Conditions are evaluated against `previous` before any condition updates it, so
   * two conditions on one channel see the same old value; the trigger sample is then
   * included in the update, matching the original per-sample path. `values` is a
   * reusable per-condition scratch buffer, so the scan allocates nothing.
   */
  private findMatch(bytes: Uint8Array, from: number, to: number): number {
    const bps = this.bytesPerSample;
    const conds = this.compiled;
    const prev = this.previous;
    // The single-condition case is the overwhelming majority (one level or one edge).
    // It needs no per-condition scratch, no kind dispatch per sample and no second
    // update pass, so it gets a tight loop of its own.
    if (conds.length === 1 && this.analogCompiled.length === 0) {
      const c = conds[0]!;
      const mask = 1 << c.bit;
      const old = prev[c.channel];
      switch (c.kind) {
        case 'level': {
          const want = c.level === 1 ? mask : 0;
          for (let off = from; off < to; off += bps) {
            if ((bytes[off + c.byte]! & mask) === want) {
              prev[c.channel] = c.level;
              return off;
            }
          }
          prev[c.channel] = c.level === 1 ? 0 : 1;
          return -1;
        }
        case 'rising':
        case 'falling': {
          const rise = c.kind === 'rising';
          let previous = old;
          for (let off = from; off < to; off += bps) {
            const value = (bytes[off + c.byte]! & mask) === 0 ? 0 : 1;
            const matched = rise ? previous === 0 && value === 1 : previous === 1 && value === 0;
            previous = value;
            if (matched) {
              prev[c.channel] = value;
              return off;
            }
          }
          prev[c.channel] = previous;
          return -1;
        }
        case 'edge': {
          let previous = old;
          for (let off = from; off < to; off += bps) {
            const value = (bytes[off + c.byte]! & mask) === 0 ? 0 : 1;
            const matched = previous !== null && previous !== value;
            previous = value;
            if (matched) {
              prev[c.channel] = value;
              return off;
            }
          }
          prev[c.channel] = previous;
          return -1;
        }
      }
    }
    // Digital conditions only: a set with analog crossings runs stepQualified instead.
    const values = this.values;
    for (let off = from; off < to; off += bps) {
      let matched = true;
      for (let i = 0; i < conds.length; i++) {
        const c = conds[i]!;
        const value = (bytes[off + c.byte]! >>> c.bit) & 1;
        values[i] = value;
        const old = prev[c.channel]!;
        switch (c.kind) {
          case 'level': if (value !== c.level) matched = false; break;
          case 'rising': if (!(old === 0 && value === 1)) matched = false; break;
          case 'falling': if (!(old === 1 && value === 0)) matched = false; break;
          case 'edge': if (!(old !== null && old !== value)) matched = false; break;
          default: matched = false; break;
        }
      }
      for (let i = 0; i < conds.length; i++) prev[conds[i]!.channel] = values[i]!;
      if (matched) return off;
    }
    return -1;
  }

  /**
   * Append whole samples [from, to) to the pre-trigger ring, overwriting the oldest
   * when it is full. At most two `set` calls, and only samples that survive: when an
   * incoming range is longer than the whole ring, its earlier part is never copied.
   */
  private appendRing(bytes: Uint8Array, from: number, to: number): void {
    const capacity = this.ringCapacity;
    if (capacity === 0 || to <= from) return;
    const bps = this.bytesPerSample;
    const count = (to - from) / bps;
    if (count >= capacity) {
      // Only the newest `capacity` samples can be retained, in logical order.
      this.ringStart = 0;
      this.ringCount = capacity;
      this.ring.set(bytes.subarray(to - capacity * bps, to));
      return;
    }
    const insert = (this.ringStart + this.ringCount) % capacity;
    const first = Math.min(count, capacity - insert);
    const firstBytes = first * bps;
    this.ring.set(bytes.subarray(from, from + firstBytes), insert * bps);
    if (first < count) this.ring.set(bytes.subarray(from + firstBytes, to), 0);
    if (this.ringCount + count <= capacity) {
      this.ringCount += count;
    } else {
      // Writing at `insert` overwrote the oldest samples; the logical start moves
      // forward by exactly the overflow.
      this.ringStart = (this.ringStart + this.ringCount + count - capacity) % capacity;
      this.ringCount = capacity;
    }
  }

  /**
   * Hand post-trigger samples downstream in one range. `feed()` has already stashed any
   * sub-sample tail in `partial`, so this only ever sees whole samples.
   *
   * These samples are emitted, not inspected: `inspectedSamples` deliberately stops at
   * the trigger sample while `matched` (its documented meaning is the waiting scan).
   * Only `maybeFinishTrigger()` consumes it, and only while `waiting`.
   */
  private emitPost(bytes: Uint8Array): void {
    if (this.statsValue.complete || this.statsValue.noTrigger) return;
    const available = Math.floor(bytes.length / this.bytesPerSample);
    if (available <= 0) return;
    const remaining = this.maxSamples - this.statsValue.emittedSamples;
    const count = Math.min(available, remaining);
    if (count <= 0) return;
    const n = count * this.bytesPerSample;
    this.emit(bytes.subarray(0, n));
    this.statsValue.emittedSamples += count;
    if (this.statsValue.emittedSamples >= this.maxSamples) this.statsValue.complete = true;
  }

  /**
   * Emit the newest `want` ring samples (oldest first) inside the output budget, then
   * empty the ring. The ring holds at least `want` samples whenever a match is
   * accepted; it may hold more (a digital match leaves the analog persistence room
   * unused), and those older samples are dropped. At most two copies: the span's two
   * contiguous parts. Per-sample copies would create avoidable allocation pressure for
   * a large pre-trigger window.
   */
  private emitRingNewest(want: number): void {
    const capacity = this.ringCapacity;
    const take = Math.min(want, this.ringCount);
    const count = Math.min(take, Math.max(0, this.maxSamples - this.statsValue.emittedSamples));
    if (count > 0) {
      const bps = this.bytesPerSample;
      const start = (this.ringStart + this.ringCount - take) % capacity;
      const first = Math.min(count, capacity - start);
      this.emit(this.ring.slice(start * bps, (start + first) * bps));
      if (first < count) this.emit(this.ring.slice(0, (count - first) * bps));
      this.statsValue.emittedSamples += count;
    }
    this.ringStart = 0;
    this.ringCount = 0;
  }
}
