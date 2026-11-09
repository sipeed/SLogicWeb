// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Checks a capture stream against Sipeed's Emulation test pattern.
 *
 * The source of truth is `build/bench/emulation.json` of Sipeed's SLogic tree
 * (rev af106af699ce41602fdda24e16a69f9d62e1387c), which is also reproduced in
 * HSync `crates/hsync-slogic/examples/slogic_capture.rs`. The generator is a
 * 16-bit counter `c` that starts at `counter.start` (0) when the capture starts
 * and adds one per sample; every channel is one bit of `c`, optionally
 * inverted. D0 is the first channel and the first bit of the sample word.
 *
 * This module consumes the *sink* stream, not the USB wire: one sample is
 * little-endian in ceil(channels / 8) bytes, sample-major. Channels below 8
 * have already been expanded by `expandPacked` to one byte per sample. A
 * capture need not start at a 64-sample block boundary, and a triggered
 * capture starts at an arbitrary counter value, so the first complete sample
 * anchors the counter unless the caller knows the capture was started
 * immediately (see `expectedStartCounter`).
 *
 * There is no rule for the SLogic16U3 at 32 channels; `emulationRules` returns
 * null and the check reports "not checked" rather than guessing.
 */

export type EmulationModel = 'slogic16u3' | 'slogic32u3';

export interface EmulationRule {
  /** Counter bit this channel carries. */
  bit: number;
  /** True when the channel carries the inverse of the counter bit. */
  inverted: boolean;
}

/** D16..D31 of the SLogic32U3: the low counter byte, plain and inverted. */
const SLOGIC32_U3_HIGH: readonly EmulationRule[] = [
  { bit: 0, inverted: false },
  { bit: 0, inverted: true },
  { bit: 1, inverted: false },
  { bit: 1, inverted: true },
  { bit: 2, inverted: false },
  { bit: 2, inverted: true },
  { bit: 3, inverted: true },
  { bit: 3, inverted: false },
  { bit: 4, inverted: true },
  { bit: 4, inverted: false },
  { bit: 5, inverted: true },
  { bit: 5, inverted: false },
  { bit: 6, inverted: true },
  { bit: 6, inverted: false },
  { bit: 7, inverted: true },
  { bit: 7, inverted: false },
];

const COUNTER_MASK = (1 << 16) - 1;

/**
 * The channel rules for one model and width, D0 first, or null when Sipeed's
 * table has no entry for the combination. Every supported width is 4, 8, 16 or
 * 32 channels; other widths are refused rather than extrapolated.
 */
export function emulationRules(
  model: EmulationModel,
  channels: number,
): EmulationRule[] | null {
  if (channels !== 4 && channels !== 8 && channels !== 16 && channels !== 32) return null;
  // Both U3 models share the 4/8/16-channel rules; the counter is the same and
  // only the 32-channel high half is model-specific.
  if (channels <= 16) {
    return Array.from({ length: channels }, (_, bit) => ({ bit, inverted: bit < 3 }));
  }
  if (model !== 'slogic32u3') return null;
  const low = Array.from({ length: 16 }, (_, bit) => ({ bit, inverted: bit < 3 }));
  // Copy the high half so a caller mutating the returned array cannot rewrite
  // the table for the next capture.
  return low.concat(SLOGIC32_U3_HIGH.map((rule) => ({ ...rule })));
}

/**
 * Incrementally verifies a sink stream against the Emulation pattern.
 *
 * The partial sample is carried in `pending`, so a chunk boundary may fall
 * anywhere inside a sample. Everything is allocated in the constructor: this
 * runs in self-tests, not in the capture path, but a per-sample allocation
 * would still make a multi-megabyte check needlessly slow.
 */
export class EmulationPatternCheck {
  private readonly model: EmulationModel;
  private readonly channels: number;
  private readonly rules: EmulationRule[] | null;
  private readonly sampleBytes: number;
  private readonly pending: Uint8Array;
  private pendingBytes = 0;
  private readonly expectedStart: number | null;
  private start: number | null;
  private checked = 0;
  private wrongCount = 0;
  private mismatch: { channel: number; sample: number } | null = null;

  /**
   * `expectedStartCounter` pins the counter value of the first sample. Leave it
   * out for a triggered capture, whose counter is read from that first sample.
   * Pass 0 for an immediately started capture: without a pinned start a
   * missing prefix is indistinguishable from a trigger that fired later, so
   * the old unconditional 4-byte head drop would check clean (HSync does the
   * same: it pins 0 only when no trigger was armed).
   */
  constructor(model: EmulationModel, channels: number, expectedStartCounter?: number) {
    this.model = model;
    this.channels = channels;
    this.rules = emulationRules(model, channels);
    this.sampleBytes = Math.max(1, Math.ceil(channels / 8));
    this.pending = new Uint8Array(this.sampleBytes);
    this.expectedStart = expectedStartCounter === undefined
      ? null
      : expectedStartCounter & COUNTER_MASK;
    this.start = this.expectedStart;
  }

  /** False when Sipeed's table has no rule for this model and width. */
  get enabled(): boolean { return this.rules !== null; }

  get checkedSamples(): number { return this.checked; }

  /** Number of channel bits that disagreed, not the number of samples. */
  get wrong(): number { return this.wrongCount; }

  get firstWrong(): { channel: number; sample: number } | null { return this.mismatch; }

  /** Counter at the first sample: pinned, decoded, or null when not checked. */
  get startCounter(): number | null { return this.start; }

  /** Consume sink bytes; a sample may straddle any number of chunks. */
  push(chunk: Uint8Array): void {
    if (this.rules === null) return;
    for (let i = 0; i < chunk.length; i++) {
      this.pending[this.pendingBytes++] = chunk[i]!;
      if (this.pendingBytes === this.sampleBytes) {
        this.pendingBytes = 0;
        this.checkSample();
      }
    }
  }

  private checkSample(): void {
    // Little-endian, since D0 is the least significant bit of the sample word.
    let word = 0;
    for (let byte = 0; byte < this.sampleBytes; byte++) {
      word |= this.pending[byte]! << (8 * byte);
    }
    word >>>= 0;

    let start = this.start;
    if (start === null) {
      // Decode the counter from the channels that are present. Widths below 16
      // leave the absent high bits at zero; the low bits are all the following
      // additions need, so the stream still checks correctly.
      let decoded = 0;
      for (let channel = 0; channel < this.rules!.length; channel++) {
        const rule = this.rules![channel]!;
        // The channel's bit, not the counter bit: the 32-channel high half
        // carries counter bits it also carries in the low half.
        let bit = (word >>> channel) & 1;
        if (rule.inverted) bit ^= 1;
        decoded |= bit << rule.bit;
      }
      start = decoded & COUNTER_MASK;
      this.start = start;
    }

    // The sample index is the position in the stream, independent of any block
    // alignment the transport happens to use.
    const counter = (start + this.checked) & COUNTER_MASK;
    const sample = this.checked;
    for (let channel = 0; channel < this.rules!.length; channel++) {
      const rule = this.rules![channel]!;
      const got = (word >>> channel) & 1;
      let want = (counter >>> rule.bit) & 1;
      if (rule.inverted) want ^= 1;
      if (got !== want) {
        this.wrongCount += 1;
        // Keep the first disagreement; the report names that channel and sample.
        if (this.mismatch === null) this.mismatch = { channel, sample };
      }
    }
    this.checked += 1;
  }

  /** Human-readable result, suitable for a self-test line. */
  verdict(): string {
    if (this.rules === null) {
      return `not checked: no Emulation pattern is known for ${this.model} at ` +
        `${this.channels} channels`;
    }
    if (this.mismatch === null) {
      return `all ${this.checked} samples of ${this.channels} channels match from ` +
        `counter ${this.start ?? 0}`;
    }
    return `${this.wrongCount} of ${this.checked * this.channels} channel samples differ, ` +
      `the first at D${this.mismatch.channel} sample ${this.mismatch.sample}`;
  }
}
