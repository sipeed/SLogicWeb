// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * The samples <-> pixels transform, and the pan/zoom arithmetic that drives it.
 *
 * Kept free of WebGL and of the DOM so it can be unit tested without a canvas, and so the
 * UI layer can reuse the exact same mapping for cursors, ticks and annotations. If the UI
 * computed its own mapping the two would drift by a pixel and every measurement readout
 * would be subtly wrong.
 *
 * All pixel coordinates in this file are DEVICE pixels measured from the left edge of the
 * waveform area. The viewport is held in floating point samples on purpose: at maximum
 * zoom one sample is ~100 px wide, and an integer-only viewport would make a drag jump in
 * 100 px steps.
 */

/**
 * Maximum zoom keeps ten samples across the full width. At ordinary plot widths this
 * leaves enough room to label every sample period, including non-decimal periods such
 * as 2.5 ns at 400 MS/s and 833 ps at 1.2 GS/s.
 */
export const MIN_SAMPLES_ON_SCREEN = 10;

export interface ViewportRange {
  /** First visible sample position, may be fractional and may be < 0. */
  readonly start: number;
  /** One past the last visible sample position, may be fractional. */
  readonly end: number;
}

export class ViewTransform {
  /** Width of the waveform area in device pixels. */
  widthPx: number;
  start: number;
  end: number;

  constructor(widthPx: number, start: number, end: number) {
    if (!(widthPx > 0)) throw new Error(`widthPx must be positive, got ${widthPx}`);
    if (!(end > start)) throw new Error(`empty viewport [${start}, ${end})`);
    this.widthPx = widthPx;
    this.start = start;
    this.end = end;
  }

  get span(): number {
    return this.end - this.start;
  }

  /** Samples per device pixel. < 1 means zoomed in past one sample per pixel. */
  get samplesPerPixel(): number {
    return this.span / this.widthPx;
  }

  sampleToPixel(sample: number): number {
    return ((sample - this.start) * this.widthPx) / this.span;
  }

  pixelToSample(px: number): number {
    return this.start + (px * this.span) / this.widthPx;
  }

  set(start: number, end: number): void {
    if (!(end > start)) throw new Error(`empty viewport [${start}, ${end})`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`viewport must be finite, got [${start}, ${end})`);
    }
    this.start = start;
    this.end = end;
  }

  /** Move the view by a pixel delta. Positive dx moves the data left (view moves right). */
  panPixels(dx: number): void {
    const ds = dx * this.samplesPerPixel;
    this.start += ds;
    this.end += ds;
  }

  /**
   * Zoom about a fixed device pixel, so the sample under the pointer stays put.
   * `spanFactor` multiplies the visible span: > 1 zooms out, < 1 zooms in.
   */
  zoomAt(pixelX: number, spanFactor: number): void {
    if (!(spanFactor > 0) || !Number.isFinite(spanFactor)) {
      throw new Error(`spanFactor must be finite and positive, got ${spanFactor}`);
    }
    const anchor = this.pixelToSample(pixelX);
    const f = pixelX / this.widthPx;
    const newSpan = this.span * spanFactor;
    this.start = anchor - f * newSpan;
    this.end = this.start + newSpan;
  }

  /**
   * Keep the view inside a capture of `length` samples.
   *
   * - span is clamped below at MIN_SAMPLES_ON_SCREEN.
   * - span is clamped above so that data covers the whole screen: the whole capture is
   *   the furthest zoom-out, so a 10 ms capture cannot be zoomed to 20 ms with half the
   *   screen blank (HSync clamps samplesPerPixel to extent/width for the same reason).
   * - the view cannot pan past either end of the capture, and cannot start before 0.
   *
   * `minVisibleFraction: 0` disables both of those and leaves only the zoom-in clamp.
   * That is what follow-the-live-edge uses, because there the user's chosen time span
   * has to survive a capture that is currently 3 ms long.
   *
   * A live capture shorter than the requested window contracts to its data under the
   * default clamp; only following deliberately keeps the larger span.
   */
  clampTo(
    length: number,
    opts: { minSpan?: number; maxSpan?: number; minVisibleFraction?: number } = {},
  ): void {
    const minVisible = opts.minVisibleFraction ?? 1;
    const lo = opts.minSpan ?? MIN_SAMPLES_ON_SCREEN;
    const hi = opts.maxSpan ?? (minVisible > 0 ? Math.max(lo, length / minVisible) : Infinity);

    let span = this.span;
    const centre = this.start + 0.5 * span;
    if (span < lo) span = lo;
    if (span > hi) span = Math.max(lo, hi);
    let start = span === this.span ? this.start : centre - 0.5 * span;

    const maxStart = minVisible > 0 ? Math.max(0, length - minVisible * span) : Math.max(0, length - span);
    if (start > maxStart) start = maxStart;
    if (start < 0) start = 0;
    this.start = start;
    this.end = start + span;
  }

  snapshot(): ViewportRange {
    return { start: this.start, end: this.end };
  }
}

export interface WheelZoomOptions {
  /**
   * True for a discrete mouse wheel, false for a trackpad. [CHOSEN] We halve the
   * exponent for a physical wheel so one 120-unit notch is exactly sqrt(2).
   */
  isPhysicalWheel: boolean;
  /** [SOURCE] Shift sets scale = 0.1 for a 10x finer zoom. */
  shift: boolean;
}

/**
 * [CHOSEN] The wheel zoom factor:
 *
 *     zoomFactor = 2 ^ ( (isPhysicalWheel ? 0.5 : 1) * scale * (-deltaY) / 120 )
 *
 * Returned as a SPAN factor, i.e. multiply the visible sample span by it. One physical
 * notch of deltaY = +120 gives sqrt(2) = 1.4142, which zooms out.
 *
 * [UNVERIFIED] The sign convention. the spec states the magnitude ("one physical wheel
 * notch is exactly sqrt(2)") but not the sign convention on scroll-down.
 * `invert` flips it without touching the magnitude.
 */
export function wheelSpanFactor(deltaY: number, opts: WheelZoomOptions, invert = false): number {
  const scale = opts.shift ? 0.1 : 1;
  const k = opts.isPhysicalWheel ? 0.5 : 1;
  const exponent = (k * scale * (invert ? -deltaY : deltaY)) / 120;
  return Math.pow(2, exponent);
}
