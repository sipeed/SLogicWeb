// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Continuous ADC crossing detector for the Loop display.
 *
 * The device matcher reports the trigger event exactly once. A loop capture keeps
 * streaming, and the display wants every later crossing so it can re-anchor the window on
 * it (the oscilloscope "running" behaviour): the trigger stays at the same screen position
 * and the waveform does not slide, whatever the relationship between the loop window and
 * the signal period.
 *
 * Scanning happens on the page, on the raw interleaved chunks before they are appended to
 * the store: one ADC group byte per scanned sample, bit-reversed exactly as the matcher
 * does. The scan is strided so its cost is bounded by the sample rate rather than by the
 * data volume; a strided scan can miss a pulse shorter than the stride, which is the price
 * of keeping this off the ingest path.
 *
 * Crossings are qualified exactly as the device matcher qualifies them (`SoftwareTrigger`,
 * docs/ARCHITECTURE.md "Analog crossings are qualified, never raw"): a rising crossing
 * arms only after `P` consecutive codes <= `level - h`, and its candidate (the first armed
 * sample at/past the level) counts only when `P` samples, the candidate included, stay
 * at/past the level; a sample back across the level drops the candidate and keeps the
 * arm. The reported crossing is the candidate sample. Without this the ADC bus's
 * carry-boundary artifact (the OR of the old and new codes for up to ~140 ns) re-anchors
 * a Rising view on the falling slope, and arms a Falling one on the rising slope.
 *
 * The strided scan only reads every `stride`-th sample coarsely and never arms by itself.
 * An unarmed code past the arming threshold, or a code at/past the level while armed,
 * hands the interval since the previous strided sample to an exact, sample-resolution
 * machine (from a short kept tail of the previous chunk when the interval starts there).
 * The exact machine runs until it has passed that sample (for an arm, P - 1 samples
 * more) with nothing pending - across chunk boundaries when the persistence window spans
 * one - and then hands back with its arm state. Its cost is bounded by `stride + P`
 * samples per strided sample plus the time a candidate or an arm is pending.
 * A crossing whose whole persistence window lies between two strided samples (P < stride)
 * can be missed; every crossing reported is real and phase-exact.
 */

import { DEFAULT_ANALOG_HYSTERESIS_CODES, MAX_ANALOG_PERSIST_SAMPLES, reverseAdcByte } from '../data/softwareTrigger.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';

export interface AnalogCrossingCondition {
  /** First input of the ADC group (bank aligned, e.g. 0 for A0). */
  start: number;
  kind: 'rising' | 'falling';
  /** ADC code 0..255 the signal crosses. */
  level: number;
}

/** Where in a sample the group's byte lives, and which edge to report. */
export interface AnalogCrossingScannerOptions {
  channels: ChannelCount;
  condition: AnalogCrossingCondition;
  /** Scanned every `stride` samples; 1 reports every crossing. */
  stride: number;
  /** Arming hysteresis in codes, 1..255; default DEFAULT_ANALOG_HYSTERESIS_CODES. */
  analogHysteresis?: number;
  /** Samples a candidate must stay at/past the level, 1..MAX_ANALOG_PERSIST_SAMPLES;
   * default 1. The app passes `ceil(240 ns * samplerate)`. */
  analogPersistSamples?: number;
}

export class AnalogCrossingScanner {
  readonly channels: ChannelCount;
  readonly bytesPerSample: number;
  private condition: AnalogCrossingCondition;
  readonly stride: number;
  readonly hysteresis: number;
  readonly persistSamples: number;
  private rising = true;
  private level = 0;
  /** Arming threshold: rising arms at code <= arm, falling at code >= arm. */
  private arm = 0;
  /** Last crossing handed to a caller, for the minimum-reporting-gap filter. */
  private lastReported = Number.NEGATIVE_INFINITY;
  /** Scan-grid phase, advanced by one sample per chunk. Without this a signal whose
   *  period divides the stride lands on the same phase at every scanned sample and is
   *  never seen as a crossing; shifting the grid guarantees every phase is sampled. */
  private phase = 0;
  /** Exact machine: armed, and the candidate's run (0 = no candidate). */
  private armed = false;
  private run = 0;
  /** While unarmed: consecutive samples past the arming threshold. */
  private armRun = 0;
  /** The exact machine is running (always at stride 1). */
  private exact = false;
  /** The exact machine may hand back only at or after this absolute sample. */
  private exactUntilAbs = 0;
  /** The strided scan's arm. */
  private coarseArmed = false;
  /** Absolute index of the last sample the strided scan (or a hand-back) stopped at;
   *  -1 when there is no continuity. */
  private previousAbs = -1;
  /** Where the next contiguous chunk starts; another base restarts continuity. */
  private nextAbs = Number.NaN;
  /**
   * The newest codes before the current chunk (contiguous, ending at `tailEndAbs`), so a
   * crossing between the previous chunk's last scanned sample and this chunk's first one
   * is refined at sample resolution too. Bounded: at most `2 * stride + 2` codes.
   */
  private readonly tail: Uint8Array;
  private tailCount = 0;
  private tailEndAbs = -1;

  constructor(opts: AnalogCrossingScannerOptions) {
    if (!Number.isInteger(opts.stride) || opts.stride < 1) {
      throw new Error(`scan stride must be a positive integer, got ${opts.stride}`);
    }
    const h = opts.analogHysteresis ?? DEFAULT_ANALOG_HYSTERESIS_CODES;
    if (!Number.isInteger(h) || h < 1 || h > 255) {
      throw new Error(`analog scan hysteresis must be an integer code count 1..255, got ${h}`);
    }
    const p = opts.analogPersistSamples ?? 1;
    if (!Number.isInteger(p) || p < 1 || p > MAX_ANALOG_PERSIST_SAMPLES) {
      throw new Error(`analog scan persistence must be an integer 1..${MAX_ANALOG_PERSIST_SAMPLES}, got ${p}`);
    }
    this.channels = opts.channels;
    this.bytesPerSample = bytesPerSampleForChannels(opts.channels);
    this.stride = opts.stride;
    this.hysteresis = h;
    this.persistSamples = p;
    this.tail = new Uint8Array(2 * opts.stride + 2);
    this.condition = { ...opts.condition };
    this.assertCondition(this.condition);
    this.compile();
    this.restart();
  }

  /** A live retune changes the level/slope/group; continuity restarts at the edit. */
  setCondition(condition: AnalogCrossingCondition): void {
    this.assertCondition(condition);
    this.condition = { ...condition };
    this.compile();
    this.restart();
    this.lastReported = Number.NEGATIVE_INFINITY;
  }

  /** A transport gap invalidates a crossing across it. */
  resetContinuity(): void {
    this.restart();
    this.lastReported = Number.NEGATIVE_INFINITY;
  }

  get current(): AnalogCrossingCondition {
    return { ...this.condition };
  }

  /**
   * Scan one sample-aligned chunk. `baseAbs` is the absolute index of its first sample
   * (the same numbering as the emitted stream). `onCrossing` is called for each detected
   * crossing (its candidate sample; it can lie up to `persistSamples - 1` samples before
   * this chunk when the confirmation lands here); `minGap` suppresses reports closer than
   * that many samples, so a dense signal cannot flood the caller with one entry per
   * period. A chunk that does not start where the previous one ended restarts continuity.
   */
  scan(
    bytes: Uint8Array, baseAbs: number,
    onCrossing: (absolute: number) => void, minGap = 1,
  ): void {
    const bps = this.bytesPerSample;
    const whole = bytes.length - (bytes.length % bps);
    const samples = whole / bps;
    const byte = this.condition.start >>> 3;
    if (baseAbs !== this.nextAbs) this.restart();
    const report = (at: number): void => {
      if (at - this.lastReported >= minGap) {
        this.lastReported = at;
        onCrossing(at);
      }
    };
    const stride = this.stride;
    const rising = this.rising;
    let i = 0; // next sample the exact machine would read
    let k = this.phase; // next strided grid position
    for (;;) {
      if (this.exact) {
        i = this.runExact(bytes, baseAbs, i, samples, byte, report);
        if (this.exact) break;
      }
      while (k < i) k += stride;
      if (k >= samples) break;
      const code = reverseAdcByte(bytes[k * bps + byte]!);
      const hit = this.coarseArmed && (rising ? code >= this.level : code <= this.level);
      const arming = !this.coarseArmed && (rising ? code <= this.arm : code >= this.arm);
      if (hit || arming) {
        // Hand the interval since the previous strided sample to the exact machine; an
        // arm must persist P samples, so that run lasts P - 1 samples past this one.
        this.armed = this.coarseArmed;
        this.run = 0;
        this.armRun = 0;
        this.exact = true;
        this.exactUntilAbs = baseAbs + k + (hit ? 0 : this.persistSamples - 1);
        let startAbs = this.previousAbs >= 0 ? this.previousAbs + 1 : baseAbs + k;
        if (startAbs < baseAbs) {
          const tailStart = this.tailEndAbs - this.tailCount;
          if (this.tailEndAbs !== baseAbs || startAbs < tailStart) {
            // Defensive: the codes are not kept; never bridge what we do not have.
            startAbs = baseAbs;
          } else {
            for (let t = startAbs - tailStart; t < this.tailCount && this.exact; t++) {
              this.stepExact(this.tail[t]!, tailStart + t, report);
            }
            if (!this.exact) {
              // Handed back inside the tail: re-read this strided sample with that state.
              i = 0;
              continue;
            }
            startAbs = baseAbs;
          }
        }
        i = startAbs - baseAbs;
        continue;
      }
      this.previousAbs = baseAbs + k;
      k += stride;
    }
    this.keepTail(bytes, whole, baseAbs, byte);
    this.nextAbs = baseAbs + samples;
    this.phase = (this.phase + 1) % stride;
  }

  /** Run the exact machine over chunk samples [from, to). Returns the sample after a
   *  hand-back, or `to` while it is still running. */
  private runExact(
    bytes: Uint8Array, baseAbs: number, from: number, to: number, byte: number,
    report: (at: number) => void,
  ): number {
    const bps = this.bytesPerSample;
    for (let i = from; i < to; i++) {
      this.stepExact(reverseAdcByte(bytes[i * bps + byte]!), baseAbs + i, report);
      if (!this.exact) return i + 1;
    }
    return to;
  }

  /** One sample of the exact machine at absolute index `abs`. */
  private stepExact(code: number, abs: number, report: (at: number) => void): void {
    const past = this.rising ? code >= this.level : code <= this.level;
    if (this.run > 0) this.run = past ? this.run + 1 : 0;
    else if (past) {
      if (this.armed) this.run = 1;
      else this.armRun = 0;
    } else if (!this.armed) {
      this.armRun = (this.rising ? code <= this.arm : code >= this.arm) ? this.armRun + 1 : 0;
      if (this.armRun >= this.persistSamples) {
        this.armed = true;
        this.armRun = 0;
      }
    }
    if (this.run >= this.persistSamples) {
      this.armed = false;
      this.run = 0;
      report(abs - (this.persistSamples - 1));
    }
    if (this.run === 0 && this.armRun === 0 && this.stride > 1 && abs >= this.exactUntilAbs) {
      this.exact = false;
      this.coarseArmed = this.armed;
      this.previousAbs = abs;
    }
  }

  private compile(): void {
    this.rising = this.condition.kind === 'rising';
    this.level = this.condition.level;
    // A level within `h` of the range's end arms at the end code itself.
    this.arm = this.rising
      ? Math.max(0, this.level - this.hysteresis)
      : Math.min(255, this.level + this.hysteresis);
  }

  /** Forget the arm, any candidate and the strided continuity. At stride 1 the exact
   *  machine is the scan and always runs. */
  private restart(): void {
    this.armed = false;
    this.run = 0;
    this.armRun = 0;
    this.coarseArmed = false;
    this.exact = this.stride === 1;
    this.exactUntilAbs = 0;
    this.previousAbs = -1;
    this.tailCount = 0;
    this.tailEndAbs = -1;
    this.nextAbs = Number.NaN;
  }

  /** Keep the newest codes up to this chunk's end (contiguous with the old tail or not). */
  private keepTail(bytes: Uint8Array, whole: number, baseAbs: number, byte: number): void {
    if (this.stride === 1) return;
    const bps = this.bytesPerSample;
    const samples = whole / bps;
    const cap = this.tail.length;
    if (this.tailEndAbs !== baseAbs) this.tailCount = 0;
    const take = Math.min(samples, cap);
    const keepOld = Math.min(this.tailCount, cap - take);
    this.tail.copyWithin(0, this.tailCount - keepOld, this.tailCount);
    for (let i = 0; i < take; i++) {
      this.tail[keepOld + i] = reverseAdcByte(bytes[(samples - take + i) * bps + byte]!);
    }
    this.tailCount = keepOld + take;
    this.tailEndAbs = baseAbs + samples;
  }

  /** Collecting form of `scan`, for tests and small callers. */
  feed(bytes: Uint8Array, baseAbs: number, minGap = 1): number[] {
    const out: number[] = [];
    this.scan(bytes, baseAbs, (absolute) => { out.push(absolute); }, minGap);
    return out;
  }

  private assertCondition(c: AnalogCrossingCondition): void {
    if (!Number.isInteger(c.start) || c.start < 0 || c.start % 8 !== 0 ||
        c.start + 8 > this.channels) {
      throw new Error(`analog scan group ${c.start} is not a bank inside 0..${this.channels - 1}`);
    }
    if (!Number.isInteger(c.level) || c.level < 0 || c.level > 255) {
      throw new Error(`analog scan level must be a code 0..255, got ${c.level}`);
    }
    if (c.kind !== 'rising' && c.kind !== 'falling') {
      throw new Error(`analog scan kind must be rising or falling, got ${String(c.kind)}`);
    }
  }
}
