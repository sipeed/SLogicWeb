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
  /** Analog crossings that must hold on the same sample as the digital conditions. */
  analog?: readonly SoftwareTriggerAnalogCondition[];
  /** Legacy single-condition fields; retained for callers upgrading from v1. */
  kind?: SoftwareTriggerKind;
  /** Used by `level`; rising/falling/edge use the transition between samples. */
  level?: SoftwareTriggerLevel;
  channel?: number;
  /** Number of samples retained immediately before the trigger sample. */
  preTriggerSamples: number;
  /**
   * Total samples emitted, including the retained prefix and trigger sample.
   * `Infinity` is the loop-capture form: after the match the stream is unbounded,
   * `complete` never sets, and the capture ends only on a manual stop.
   */
  maxSamples: number;
  /** Optional waiting budget. Infinity means keep rolling the prefix until stopped. */
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
  /** Samples inspected while waiting, including the trigger sample if found. */
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
  kind: 'rising' | 'falling';
  level: number;
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
  private analogValues!: Uint8Array;
  /** Previous code of each sample byte, -1 before the first sample; see `findMatch`. */
  private previousAnalog!: Int16Array;
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
    this.installConditions(conditions, analog);
    this.preTriggerSamples = Math.min(
      opts.config.preTriggerSamples,
      Math.max(0, this.maxSamples - 1),
      Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / this.bytesPerSample),
    );
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
    this.ring = new Uint8Array(this.preTriggerSamples * this.bytesPerSample);
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
    // The constructor clamps the requested prefix to the capture budget and the prefix
    // byte bound; a caller repeating its original request must still be accepted.
    const effectivePreTrigger = Math.min(
      config.preTriggerSamples,
      Math.max(0, this.maxSamples - 1),
      Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / this.bytesPerSample),
    );
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
    const conditionsChanged = !this.sameConditions(conditions, analog);
    // Every field is validated before anything is written: a refused retune must not
    // partially apply (in particular, reportGapSamples must keep its old value).
    const nextReportGap = config.reportGapSamples ?? this.reportGapSamples;
    if (this.mode === 'continuous' && this.statsValue.matched) {
      // After the first match a tuning-only retune (`reportGapSamples`, or a scan policy
      // identical to the running one) must not restart the scan: doing so would invent a
      // null previous value at the edit and drop an edge that straddles it. Only an edit
      // that changes what is scanned re-anchors continuity at the next sample.
      if (scanChanged && !this.adoptScanOptions(nextScan)) return false;
      if (conditionsChanged) this.installConditions(conditions, analog);
      if (conditionsChanged || scanChanged) this.resetPostMatchScanAtNextSample();
      this.reportGapSamples = nextReportGap;
      return true;
    }
    // Waiting (one-shot, or continuous before its first match): the documented retune
    // contract restarts edge continuity so no transition is invented across the edit, and
    // the retained prefix is history that stays valid.
    if (nextScan !== null && !this.adoptScanOptions(nextScan)) return false;
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
    this.analogCompiled = this.analog.map((a) => ({
      byte: a.start >>> 3, kind: a.kind, level: a.level,
    }));
    this.values = new Uint8Array(this.compiled.length);
    this.analogValues = new Uint8Array(this.analogCompiled.length);
    this.previous = Array.from({ length: this.channels }, () => null);
    this.previousAnalog = new Int16Array(this.bytesPerSample).fill(-1);
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
   * bytes spanning it. The processor remains bounded and continues searching.
   */
  resetContinuity(): void {
    this.previous.fill(null);
    this.previousAnalog.fill(-1);
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
    const match = this.findMatch(bytes, 0, to);
    if (match >= 0) {
      this.statsValue.inspectedSamples += match / this.bytesPerSample; // pre-trigger samples
      this.appendRing(bytes, 0, match);
      this.statsValue.matched = true;
      this.emitRing();
      // emitRing() has just accounted for every retained pre-trigger sample, so
      // the next output slot is the exact T=0 sample seen by SampleStore.
      this.statsValue.triggerSampleIndex = this.statsValue.emittedSamples;
      this.statsValue.lastTriggerSampleIndex = this.statsValue.triggerSampleIndex;
      this.statsValue.matchCount = 1;
      if (this.mode === 'continuous') {
        this.beginContinuousScan(bytes, match, this.statsValue.triggerSampleIndex);
      }
      this.emit(bytes.subarray(match, match + this.bytesPerSample));
      this.statsValue.inspectedSamples += 1; // the trigger sample itself
      this.statsValue.emittedSamples += 1;
      if (this.statsValue.emittedSamples >= this.maxSamples) this.statsValue.complete = true;
      // Report after the trigger sample has been handed to the sink: the first match
      // keeps the one-shot ordering (data, then event). Later continuous matches are
      // reported while scanning, before their block is emitted.
      this.reportMatch(this.statsValue.triggerSampleIndex);
      return match + this.bytesPerSample;
    }
    this.statsValue.inspectedSamples += scanSamples;
    this.appendRing(bytes, 0, to);
    if (this.statsValue.inspectedSamples >= this.searchLimitSamples) this.finish();
    return -1;
  }

  /* ---------------------------------------------------------------------------------
   * Continuous mode: repeated matching on the unbounded emitted stream.
   *
   * Everything below runs only after the first match. The samples are emitted unchanged;
   * the matcher merely chooses which of them to evaluate. A strided candidate that matches
   * is refined at stride 1 over the samples since the previous scanned sample, so every
   * reported index is the exact sample where the condition first held.
   * ------------------------------------------------------------------------------- */

  /** Seed the repeated-match scan at the trigger sample. Called before the trigger sample
   * is emitted, so the sample bytes are copied first: a sink may detach the buffer. */
  private beginContinuousScan(bytes: Uint8Array, match: number, triggerIndex: number): void {
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
    this.scanPostMatch(region, baseAbs, count);
    // A finite stream ends here, and striding may have left the last `scanStep() - 1`
    // samples after the final candidate. Finish them at stride 1 so a genuine crossing in
    // the final samples of the budget is still reported and counted.
    if (Number.isFinite(this.maxSamples) && baseAbs + count >= this.maxSamples) {
      this.drainFinalTail(region, baseAbs, count);
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

  /** Rebuild the per-condition previous state from one raw sample. `null` restarts edge
   * and analog continuity (a condition edit or transport gap). */
  private restorePrevious(sample: Uint8Array | null): void {
    if (sample === null) {
      this.previous.fill(null);
      this.previousAnalog.fill(-1);
      return;
    }
    const prev = this.previous;
    for (let channel = 0; channel < this.channels; channel++) {
      prev[channel] = (sample[channel >>> 3]! >>> (channel & 7)) & 1;
    }
    const analog = this.previousAnalog;
    for (let byte = 0; byte < this.bytesPerSample; byte++) {
      analog[byte] = REVERSED_BYTE[sample[byte]!]!;
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
    const analogConds = this.analogCompiled;
    if (conds.length === 1 && analogConds.length === 1) {
      // The natural mixed case - a digital gate plus an ADC crossing - gets its own
      // tight loop; the general path's per-condition string switch cannot keep up with
      // a 32-channel stream.
      const d = conds[0]!;
      const a = analogConds[0]!;
      const mask = 1 << d.bit;
      const rise = a.kind === 'rising';
      let digital = prev[d.channel];
      let analog = this.previousAnalog[a.byte]!;
      for (let off = from; off < to; off += bps) {
        const bit = (bytes[off + d.byte]! & mask) === 0 ? 0 : 1;
        const code = REVERSED_BYTE[bytes[off + a.byte]!]!;
        const digitalMatch = d.kind === 'level' ? bit === d.level
          : d.kind === 'rising' ? digital === 0 && bit === 1
            : d.kind === 'falling' ? digital === 1 && bit === 0
              : digital !== null && digital !== bit;
        const analogMatch = analog >= 0 && (rise
          ? analog < a.level && code >= a.level
          : analog > a.level && code <= a.level);
        digital = bit;
        analog = code;
        if (digitalMatch && analogMatch) {
          prev[d.channel] = bit;
          this.previousAnalog[a.byte] = code;
          return off;
        }
      }
      prev[d.channel] = digital;
      this.previousAnalog[a.byte] = analog;
      return -1;
    }
    if (conds.length === 0 && analogConds.length === 1) {
      const a = analogConds[0]!;
      const rise = a.kind === 'rising';
      let previous = this.previousAnalog[a.byte]!;
      for (let off = from; off < to; off += bps) {
        const code = REVERSED_BYTE[bytes[off + a.byte]!]!;
        const matched = previous >= 0 && (rise
          ? previous < a.level && code >= a.level
          : previous > a.level && code <= a.level);
        previous = code;
        if (matched) {
          this.previousAnalog[a.byte] = code;
          return off;
        }
      }
      this.previousAnalog[a.byte] = previous;
      return -1;
    }
    const values = this.values;
    const analogValues = this.analogValues;
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
      for (let i = 0; i < analogConds.length; i++) {
        const a = analogConds[i]!;
        const code = REVERSED_BYTE[bytes[off + a.byte]!]!;
        analogValues[i] = code;
        const old = this.previousAnalog[a.byte]!;
        const analogMatched = a.kind === 'rising'
          ? old >= 0 && old < a.level && code >= a.level
          : old >= 0 && old > a.level && code <= a.level;
        if (!analogMatched) matched = false;
      }
      for (let i = 0; i < conds.length; i++) prev[conds[i]!.channel] = values[i]!;
      for (let i = 0; i < analogConds.length; i++) {
        this.previousAnalog[analogConds[i]!.byte] = analogValues[i]!;
      }
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
    const capacity = this.preTriggerSamples;
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

  private emitRing(): void {
    if (this.ringCount === 0) return;
    // At most two copies: the ring's two contiguous spans. Per-sample copies would
    // create avoidable allocation pressure for a large pre-trigger window.
    const first = Math.min(this.ringCount, this.preTriggerSamples - this.ringStart);
    this.emit(this.ring.slice(
      this.ringStart * this.bytesPerSample,
      (this.ringStart + first) * this.bytesPerSample,
    ));
    if (first < this.ringCount) {
      this.emit(this.ring.slice(0, (this.ringCount - first) * this.bytesPerSample));
    }
    this.statsValue.emittedSamples += this.ringCount;
    this.ringStart = 0;
    this.ringCount = 0;
  }
}
