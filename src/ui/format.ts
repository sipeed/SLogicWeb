// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Display formatting for the shell: time/frequency/rate/count formatting for the
 * axis and readouts, plus the render-time formatters for structured UI state
 * (CaptureLabel, StatusError, AnalyzerNote, and the trigger summary) - state is
 * stored as data so a locale switch can retranslate it, and these functions turn it
 * into the current locale's strings with t().
 *
 * Time-axis tick labels live in `axisLabels.ts`. Durations here use "µs" for microseconds
 * (docs/DESIGN.md units); the debug/bench strings elsewhere keep ASCII "us".
 */

import { diagnosticOf } from '../diagnostics.js';
import type { Diagnostic, DiagnosticCode } from '../diagnostics.js';
import { t } from './i18n.js';
import type { MessageKey } from './i18n.js';
import type {
  AnalyzerNote, AnalyzerStatus, CaptureLabel, CaptureSettings, StatusDetail, StatusError,
} from './state.js';

const ENG = [
  { s: 1, u: 's' },
  { s: 1e-3, u: 'ms' },
  { s: 1e-6, u: '\u00b5s' },
  { s: 1e-9, u: 'ns' },
  { s: 1e-12, u: 'ps' },
];

/** "1.234 ms". `sig` significant figures, trailing zeros kept so the width is stable. */
export function formatDuration(seconds: number, sig = 4): string {
  if (!Number.isFinite(seconds)) return '-';
  const a = Math.abs(seconds);
  if (a === 0) return '0 s';
  const e = ENG.find((x) => a >= x.s) ?? ENG[ENG.length - 1]!;
  const v = seconds / e.s;
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(v))));
  return `${v.toFixed(Math.min(6, digits))} ${e.u}`;
}

/** "3 sig figs", which is what we specify for the hover readout. */
export function formatFreq(hz: number, sig = 3): string {
  if (!Number.isFinite(hz) || hz === 0) return '-';
  const a = Math.abs(hz);
  const units: [number, string][] = [[1e9, 'GHz'], [1e6, 'MHz'], [1e3, 'kHz'], [1, 'Hz']];
  const [div, u] = units.find(([d]) => a >= d) ?? [1, 'Hz'];
  const v = hz / div;
  const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.abs(v))));
  return `${v.toFixed(Math.min(6, digits))} ${u}`;
}

/** "10 MS/s", the way the capture panel writes a sample rate. */
export function formatRate(hz: number): string {
  if (hz >= 1e6) return `${trim(hz / 1e6)} MS/s`;
  if (hz >= 1e3) return `${trim(hz / 1e3)} kS/s`;
  return `${trim(hz)} S/s`;
}

function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

/** "1,234,567". Sample counts get long. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

/**
 * The capture title, formatted at render time from structured state so a locale
 * switch retranslates it (state.ts explains why it is data, not a string).
 * `loaded.source` passes through untranslated: it is file/user data.
 */
export function formatCaptureLabel(label: CaptureLabel): string {
  switch (label.kind) {
    case 'none': return t('capture.none');
    case 'capturing':
      return t('capture.capturing', { channels: label.channels, rate: formatRate(label.rate) });
    case 'loaded': return t('capture.loaded', { source: label.source, ms: label.ms });
    case 'stoppedNoTrigger':
      return t('capture.stoppedNoTrigger', { samples: formatCount(label.samples) });
    case 'live':
      return t('capture.live', {
        samples: formatCount(label.samples),
        rate: formatRate(label.rate),
        duration: formatDuration(label.seconds),
      });
  }
}

/** "open capture: <diagnostic>" - the prefix is chrome (translated). */
export function formatStatusError(err: StatusError): string {
  return `${t(err.what, err.vars)}: ${formatStatusDetail(err.detail)}`;
}

type DiagnosticKey = Extract<MessageKey, `diagnostic.${DiagnosticCode}`>;
type UncoveredDiagnosticCode =
  Exclude<DiagnosticCode, DiagnosticKey extends `diagnostic.${infer C}` ? C : never>;

const DIAGNOSTIC_KEYS_COMPLETE: Record<UncoveredDiagnosticCode, never> = {};

function diagnosticKey(code: DiagnosticCode): DiagnosticKey {
  void DIAGNOSTIC_KEYS_COMPLETE;
  return `diagnostic.${code}`;
}

export function formatDiagnostic(d: Diagnostic): string {
  const sentence = t(diagnosticKey(d.code), d.vars);
  return d.payload ? `${sentence}: ${d.payload}` : sentence;
}

export function formatStatusDetail(detail: StatusDetail): string {
  return detail.kind === 'diagnostic' ? formatDiagnostic(detail.diag) : detail.text;
}

function formatStatusDetailDebug(detail: StatusDetail): string {
  if (detail.kind === 'text') return detail.text;
  const head = diagnosticKey(detail.diag.code);
  const vars = detail.diag.vars ? ` ${JSON.stringify(detail.diag.vars)}` : '';
  return detail.diag.payload === undefined
    ? `${head}${vars}`
    : `${head}${vars}: ${detail.diag.payload}`;
}

export function formatStatusErrorDebug(err: StatusError): string {
  const head = err.vars ? `${err.what} ${JSON.stringify(err.vars)}` : err.what;
  return `${head}: ${formatStatusDetailDebug(err.detail)}`;
}

export function statusDetailOf(error: unknown): StatusDetail {
  const diag = diagnosticOf(error);
  if (diag) return { kind: 'diagnostic', diag };
  return { kind: 'text', text: error instanceof Error ? error.message : String(error) };
}

/**
 * The channel-row trigger summary ("Rising edge · 10% pre-trigger · AND 2 conditions").
 * Lives here, not in app.ts, so the i18n self-test can pin it under node (app.ts is
 * not node-importable) and so a locale switch retranslates it like every other
 * render-time string.
 */
export function formatTriggerSummary(s: CaptureSettings, channel: number): string {
  const c = s.triggerConditions.find((x) => x.channel === channel);
  const kind = c?.kind ?? s.triggerKind;
  const level = c?.level ?? s.triggerLevel;
  const condition = kind === 'level'
    ? t('trigger.level', { level })
    : kind === 'rising' ? t('trigger.rising')
      : kind === 'falling' ? t('trigger.falling')
        : t('trigger.anyEdge');
  const total = s.triggerConditions.length;
  return total > 1
    ? t('trigger.summaryAnd', { condition, pct: s.preTriggerPercent, count: total })
    : t('trigger.summary', { condition, pct: s.preTriggerPercent });
}

/**
 * An analyzer's status note, formatted at render time (state.ts explains why it is
 * data). Diagnostics (`stats.firstError`) pass through untranslated.
 */
export function formatAnalyzerNote(note: AnalyzerNote): string {
  switch (note.kind) {
    case 'pending': return t('analyzerNote.pending');
    case 'edges': return t('analyzerNote.edges', { count: formatCount(note.count) });
    case 'stats': {
      const base = t('analyzerNote.stats', {
        anns: formatCount(note.anns),
        decodeMs: Math.round(note.decodeMs),
        wallMs: Math.round(note.wallMs),
      });
      const tagged = note.snapshot ? `${base} · ${t('analyzerNote.snapshot')}` : base;
      return note.firstError ? `${tagged} · ${note.firstError}` : tagged;
    }
    case 'timeout': return t('analyzerNote.timeout');
    case 'cancelled': return t('analyzerNote.cancelled');
    case 'error': return note.diag ? formatDiagnostic(note.diag) : note.detail;
  }
}

export function formatMountedAnalyzerNote(note: AnalyzerNote, status: AnalyzerStatus): string {
  if (status === 'decoding') return t('analyzerPanel.decoding');
  // Statistics are hidden here, diagnostics are not - and neither is the snapshot tag:
  // a result that does not track the capture is a warning, not a statistic.
  if (note.kind === 'stats') {
    // A decode that produced nothing is worth saying: the decoder ran on the wrong wire
    // or the capture holds no traffic for it (an analyzer carried over to a new file).
    const tag = note.snapshot ? t('analyzerNote.snapshot') : '';
    if (note.anns === 0) return [t('analyzerNote.noAnnotations'), tag, note.firstError].filter(Boolean).join(' · ');
    return [tag, note.firstError].filter(Boolean).join(' · ');
  }
  return formatAnalyzerNote(note);
}
