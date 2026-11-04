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
 * of keeping this off the ingest path. Every crossing it does report is a real one, and a
 * reported crossing is refined at sample resolution inside the scanned interval (except
 * across a chunk boundary), so a display anchor does not inherit the stride. That is all
 * the display anchor needs.
 */

import { reverseAdcByte } from '../data/softwareTrigger.js';
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
}

export class AnalogCrossingScanner {
  readonly channels: ChannelCount;
  readonly bytesPerSample: number;
  private condition: AnalogCrossingCondition;
  readonly stride: number;
  private previous = -1;
  /** Last crossing handed to a caller, for the minimum-reporting-gap filter. */
  private lastReported = Number.NEGATIVE_INFINITY;
  /** Scan-grid phase, advanced by one sample per chunk. Without this a signal whose
   *  period divides the stride lands on the same phase at every scanned sample and is
   *  never seen as a crossing; shifting the grid guarantees every phase is sampled. */
  private phase = 0;

  constructor(opts: AnalogCrossingScannerOptions) {
    if (!Number.isInteger(opts.stride) || opts.stride < 1) {
      throw new Error(`scan stride must be a positive integer, got ${opts.stride}`);
    }
    this.channels = opts.channels;
    this.bytesPerSample = bytesPerSampleForChannels(opts.channels);
    this.stride = opts.stride;
    this.condition = { ...opts.condition };
    this.assertCondition(this.condition);
  }

  /** A live retune changes the level/slope/group; continuity restarts at the edit. */
  setCondition(condition: AnalogCrossingCondition): void {
    this.assertCondition(condition);
    this.condition = { ...condition };
    this.previous = -1;
    this.lastReported = Number.NEGATIVE_INFINITY;
  }

  /** A transport gap invalidates a crossing across it. */
  resetContinuity(): void {
    this.previous = -1;
    this.lastReported = Number.NEGATIVE_INFINITY;
  }

  get current(): AnalogCrossingCondition {
    return { ...this.condition };
  }

  /**
   * Scan one sample-aligned chunk. `baseAbs` is the absolute index of its first sample
   * (the same numbering as the emitted stream). `onCrossing` is called for each detected
   * crossing (the scanned sample where the code crossed the level); `minGap` suppresses
   * reports closer than that many samples, so a dense signal cannot flood the caller with
   * one entry per period. The scan grid phase advances by one sample per chunk, so a
   * signal whose period divides the stride is still sampled at every phase.
   */
  scan(
    bytes: Uint8Array, baseAbs: number,
    onCrossing: (absolute: number) => void, minGap = 1,
  ): void {
    const bps = this.bytesPerSample;
    const whole = bytes.length - (bytes.length % bps);
    const byte = this.condition.start >>> 3;
    const level = this.condition.level;
    const rising = this.condition.kind === 'rising';
    const step = bps * this.stride;
    const first = this.phase * bps;
    let previousOff = -1;
    for (let off = first; off < whole; off += step) {
      const code = reverseAdcByte(bytes[off + byte]!);
      let at = baseAbs + off / bps;
      if (this.previous >= 0) {
        const crossed = rising
          ? this.previous < level && code >= level
          : this.previous > level && code <= level;
        if (crossed) {
          // A strided scan only says a crossing happened somewhere in (previousOff, off].
          // Refine it at sample resolution inside that interval so a re-anchor is
          // phase-exact even at stride > 1. The interval is at most one stride long.
          if (step > bps && previousOff >= 0) {
            for (let o = previousOff + bps; o <= off; o += bps) {
              const c = reverseAdcByte(bytes[o + byte]!);
              const hit = rising ? c >= level : c <= level;
              if (hit) {
                at = baseAbs + o / bps;
                break;
              }
            }
          }
          if (at - this.lastReported >= minGap) {
            this.lastReported = at;
            onCrossing(at);
          }
        }
      }
      this.previous = code;
      previousOff = off;
    }
    this.phase = (this.phase + 1) % this.stride;
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
