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
 * Crossings are qualified by the shared rule (`AnalogRunQualifier`, docs/ARCHITECTURE.md
 * "Analog crossings are qualified, never raw"): hysteresis h (a Rising condition arms only
 * on a code <= level - h) and OR-artifact rejection (a run past a threshold that is at most
 * W samples long, ends, and whose every code is the OR-shape of both neighbours - the ADC
 * bus's carry-boundary artifact - neither arms nor fires). The reported crossing is T, the
 * first sample of a real candidate run: its predecessor is on the other side of the level
 * and T is at/past it. Without this the artifact re-anchors a Rising view on the falling
 * slope, and arms a Falling one on the rising slope.
 *
 * The strided scan only reads every `stride`-th sample coarsely and never arms by itself.
 * An unarmed code past the arming threshold, or a code at/past the level while armed,
 * hands the interval since the previous strided sample to the exact, sample-resolution
 * machine (from a short kept tail of the previous chunk when the interval starts there),
 * entered with the strided scan's arm and the previous strided sample as predecessor. The
 * exact machine runs until it has passed that sample with no run pending - a pending run
 * carries across chunk boundaries as O(1) state (first sample, `a`, length, AND and
 * minimum of its codes), so no codes beyond the tail are kept - and then hands back with
 * its arm state. Its cost is bounded by `stride + W` samples per strided sample.
 *
 * Cross-chunk: a run that straddles a chunk boundary is decided in the later chunk, so T
 * can lie up to W samples before the chunk that reports it. A gap (`resetContinuity`), a
 * retune or a chunk that does not continue the previous one drops the pending run, the
 * arm and the predecessor; the first sample after it can arm (it is judged with no `a`)
 * but never fire.
 *
 * A strided scan can miss a crossing whose whole candidate run lies between two strided
 * samples (shorter than the stride: e.g. a ~33 MHz carrier at 100 MS/s), and an arm run
 * shorter than the stride; whatever it reports is a real, phase-exact crossing.
 */

import { DEFAULT_ANALOG_HYSTERESIS_CODES, MAX_ANALOG_ARTIFACT_SAMPLES, reverseAdcByte } from '../data/softwareTrigger.js';
import { ANALOG_RUN_NONE, AnalogRunQualifier } from '../data/analogRunQualifier.js';
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
  /** OR-artifact window W in samples, 0..MAX_ANALOG_ARTIFACT_SAMPLES: a run at most W
   * samples long with the OR shape neither arms nor fires. Default 0 (no artifact
   * rejection, hysteresis only); 1 rejects single-sample OR runs only. The app passes
   * `ceil(240 ns * samplerate)` (`analogTriggerQualification`). */
  analogArtifactSamples?: number;
}

export class AnalogCrossingScanner {
  readonly channels: ChannelCount;
  readonly bytesPerSample: number;
  private condition: AnalogCrossingCondition;
  readonly stride: number;
  readonly hysteresis: number;
  /** The artifact window W. */
  readonly artifactSamples: number;
  private rising = true;
  /** The exact, sample-resolution machine (arm, pending run, predecessor). */
  private q!: AnalogRunQualifier;
  /** Last crossing handed to a caller, for the minimum-reporting-gap filter. */
  private lastReported = Number.NEGATIVE_INFINITY;
  /** Scan-grid phase, advanced by one sample per chunk. Without this a signal whose
   *  period divides the stride lands on the same phase at every scanned sample and is
   *  never seen as a crossing; shifting the grid guarantees every phase is sampled. */
  private phase = 0;
  /** The exact machine is running (always at stride 1). */
  private exact = false;
  /** The exact machine may hand back only at or after this absolute sample. */
  private exactUntilAbs = 0;
  /** The strided scan's arm. */
  private coarseArmed = false;
  /** Absolute index of the last sample the strided scan (or a hand-back) stopped at;
   *  -1 when there is none since continuity started. */
  private previousAbs = -1;
  /** First sample of the current continuity. */
  private continuityAbs = 0;
  /** Where the next contiguous chunk starts; another base restarts continuity. */
  private nextAbs = Number.NaN;
  /**
   * The newest codes before the current chunk (contiguous, ending at `tailEndAbs`), so a
   * crossing between the previous chunk's last scanned sample and this chunk's first one
   * is refined at sample resolution too, with that sample's predecessor. Bounded: at most
   * `2 * stride + 2` codes (a pending run needs none: its state is O(1)).
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
    const w = opts.analogArtifactSamples ?? 0;
    if (!Number.isInteger(w) || w < 0 || w > MAX_ANALOG_ARTIFACT_SAMPLES) {
      throw new Error(`analog scan artifact window must be an integer 0..${MAX_ANALOG_ARTIFACT_SAMPLES}, got ${w}`);
    }
    this.channels = opts.channels;
    this.bytesPerSample = bytesPerSampleForChannels(opts.channels);
    this.stride = opts.stride;
    this.hysteresis = h;
    this.artifactSamples = w;
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

  /** A transport gap invalidates a crossing (and a pending run) across it. */
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
   * crossing T (the first sample of a real candidate run; it can lie up to W samples
   * before this chunk when the run straddles the boundary); `minGap` suppresses reports
   * closer than that many samples, so a dense signal cannot flood the caller with one
   * entry per period. A chunk that does not start where the previous one ended restarts
   * continuity.
   */
  scan(
    bytes: Uint8Array, baseAbs: number,
    onCrossing: (absolute: number) => void, minGap = 1,
  ): void {
    const bps = this.bytesPerSample;
    const whole = bytes.length - (bytes.length % bps);
    const samples = whole / bps;
    const byte = this.condition.start >>> 3;
    if (baseAbs !== this.nextAbs) {
      this.restart();
      this.continuityAbs = baseAbs;
    }
    const report = (at: number): void => {
      if (at - this.lastReported >= minGap) {
        this.lastReported = at;
        onCrossing(at);
      }
    };
    const stride = this.stride;
    const q = this.q;
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
      const hit = this.coarseArmed && q.isPast(code);
      const arming = !this.coarseArmed && q.isFar(code);
      if (hit || arming) {
        // Hand the interval since the previous strided sample to the exact machine, with
        // that sample as the predecessor; it runs past this one until nothing is pending.
        this.exact = true;
        this.exactUntilAbs = baseAbs + k;
        // The codes we have: the kept tail (when it ends where this chunk starts) and
        // this chunk, never before the continuity start. Never bridge what is not kept.
        const keptFrom = Math.max(this.continuityAbs,
          this.tailEndAbs === baseAbs ? baseAbs - this.tailCount : baseAbs);
        let startAbs = this.previousAbs >= 0 ? this.previousAbs + 1 : this.continuityAbs;
        if (startAbs < keptFrom) startAbs = keptFrom;
        const p = startAbs - 1;
        const prev = p < keptFrom ? -1
          : p < baseAbs ? this.tail[this.tailCount - (baseAbs - p)]!
          : reverseAdcByte(bytes[(p - baseAbs) * bps + byte]!);
        q.enter(this.coarseArmed, prev);
        if (startAbs < baseAbs) {
          for (let t = startAbs; t < baseAbs && this.exact; t++) {
            this.stepExact(this.tail[this.tailCount - (baseAbs - t)]!, t, report);
          }
          if (!this.exact) {
            // Handed back inside the tail: re-read this strided sample with that state.
            i = 0;
            continue;
          }
          startAbs = baseAbs;
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
    const t = this.q.step(code, abs);
    if (t >= 0) report(t);
    if (this.stride > 1 && this.q.pending === ANALOG_RUN_NONE && abs >= this.exactUntilAbs) {
      this.exact = false;
      this.coarseArmed = this.q.armed;
      this.previousAbs = abs;
    }
  }

  private compile(): void {
    this.rising = this.condition.kind === 'rising';
    // A level within `h` of the range's end arms at the end code itself.
    this.q = new AnalogRunQualifier({
      rising: this.rising, level: this.condition.level,
      hysteresis: this.hysteresis, window: this.artifactSamples,
    });
  }

  /** Forget the arm, any pending run and the strided continuity. At stride 1 the exact
   *  machine is the scan and always runs. */
  private restart(): void {
    this.q.reset();
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
