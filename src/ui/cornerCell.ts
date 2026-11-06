// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The corner cell's readouts (DESIGN §3.4): the cell where the label column meets the
 * overview strip and the ruler (`#labels-spacer`).
 *
 *   - Overview half: the displayed capture's summary (`100 MS/s · 20.0 ms`, sample count
 *     and channel width in its tooltip; "No capture" when empty) - a button that opens
 *     the Capture (Acquire) panel - and Fit with the current view span (`1.30 ms`).
 *   - Ruler half: `+ Decoder` (opens the Decoders panel, picker focused; enabled without
 *     a capture) and the `T` caption heading the per-row trigger slots.
 *
 * This module is DOM-free: it turns plain numbers into the strings the App writes, so the
 * self-test pins the formatting and the empty state without a browser. App compares the
 * result with what it last wrote and touches the DOM only when a string changed.
 *
 * Assumptions:
 *   - A capture "exists" when it has at least one sample and a positive sample rate; a
 *     running capture whose first samples have not arrived reads as "No capture".
 *   - The summary reads the current acquisition's own store (a Repeat wave, not the
 *     composite); the span and Fit read the displayed store, which is what Fit acts on.
 *     Fit is disabled whenever that store is empty, because zoomToFit has nothing to fit.
 *   - Durations use three significant figures (`20.0 ms`, `1.30 ms`) so the text width
 *     stays steady while a capture grows or the view zooms.
 */

import { formatCount, formatDuration, formatRate } from './format.js';
import { t } from './i18n.js';

export interface CornerCapture {
  /** Samples in the displayed capture. */
  readonly samples: number;
  /** Samples per second. */
  readonly samplerate: number;
  /** Channel width of the capture (4/8/16/32/...). */
  readonly channels: number;
}

/** The displayed store's ViewWindow: the store Fit acts on (a Repeat composite included). */
export interface CornerSpan {
  /** Samples in the displayed store; Fit has nothing to fit at 0. */
  readonly storeSamples: number;
  /** ViewWindow width in samples. */
  readonly spanSamples: number;
  readonly samplerate: number;
}

export interface CornerView {
  /** The displayed store has samples, so Fit can act. */
  readonly hasCapture: boolean;
  /** Line 1: `100 MS/s · 20.0 ms`, or the localized "No capture". */
  readonly summary: string;
  readonly summaryTitle: string;
  /** Line 2: the view span without the icon (`1.30 ms`); empty without a capture. */
  readonly span: string;
  readonly fitTitle: string;
  readonly fitLabel: string;
  readonly fitDisabled: boolean;
  readonly addDecoder: string;
  readonly addDecoderLabel: string;
  readonly addDecoderTitle: string;
  readonly triggerTitle: string;
  /** The cell's group name for assistive technology. */
  readonly groupLabel: string;
}

const DURATION_SIG = 3;

function captureExists(capture: CornerCapture | null): capture is CornerCapture {
  return capture !== null && capture.samples > 0 && capture.samplerate > 0 &&
    Number.isFinite(capture.samplerate);
}

/** `100 MS/s · 20.0 ms`, or null when there is no capture to summarize. */
export function captureSummaryText(capture: CornerCapture | null): string | null {
  if (!captureExists(capture)) return null;
  return `${formatRate(capture.samplerate)} · ${formatDuration(capture.samples / capture.samplerate, DURATION_SIG)}`;
}

/** `1.30 ms` for a view span in samples, or null when nothing is shown. */
export function viewSpanText(spanSamples: number, samplerate: number): string | null {
  if (!(spanSamples > 0) || !(samplerate > 0) || !Number.isFinite(spanSamples / samplerate)) return null;
  return formatDuration(spanSamples / samplerate, DURATION_SIG);
}

/** Every string the corner shows, in the current locale. */
export function cornerView(capture: CornerCapture | null, view: CornerSpan | null): CornerView {
  const summary = captureSummaryText(capture);
  const span = view !== null && view.storeSamples > 0
    ? viewSpanText(view.spanSamples, view.samplerate) : null;
  const hasCapture = span !== null;
  return {
    hasCapture,
    summary: summary ?? t('corner.noCapture'),
    summaryTitle: summary !== null && capture !== null
      ? t('corner.summaryTitle', { samples: formatCount(capture.samples), channels: capture.channels })
      : t('corner.summaryEmptyTitle'),
    span: span ?? '',
    fitTitle: hasCapture ? t('corner.fitTitle') : t('corner.fitDisabledTitle'),
    fitLabel: span !== null ? t('corner.fitLabel', { span }) : t('toolbar.fit'),
    fitDisabled: !hasCapture,
    addDecoder: t('corner.addDecoder'),
    addDecoderLabel: t('corner.addDecoderLabel'),
    addDecoderTitle: t('corner.addDecoderTitle'),
    triggerTitle: t('corner.triggerTitle'),
    groupLabel: t('corner.label'),
  };
}

/** Field-wise equality, so App can skip a frame whose corner strings did not change. */
export function cornerViewEqual(a: CornerView, b: CornerView): boolean {
  for (const key of Object.keys(a) as (keyof CornerView)[]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
