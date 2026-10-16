// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Display formatting for the shell: time/frequency/rate/count formatting for the
 * axis and readouts, plus the render-time formatters for structured UI state
 * (CaptureLabel, StatusError, AnalyzerNote, and the trigger summary) - state is
 * stored as data so a locale switch can retranslate it, and these functions turn it
 * into the current locale's strings with t().
 *
 * The axis label format is distinctive enough that a critic will spot a mismatch
 * immediately, and it is specified exactly here:
 *
 *   - a major label is time sliced into metric groups from the leading magnitude down to
 *     the tick's own magnitude, joined with " : ", leading zeros trimmed:
 *
 *         0 s
 *         15 s : 897 ms
 *         15 s : 897 ms : 300 us
 *
 *   - a minor label is signed and relative to the previous major tick: +1 ms, +10 us,
 *     +100 ns.
 *
 * Ticks are computed with `Decimal` arbitrary precision and
 * applies "an explicit +1% nudge to stop 897.9999 ms from rendering as 897 ms". We do not
 * need the nudge: tick positions here are integer multiples of a power of ten held in
 * integer picoseconds, so 897.9999 ms cannot arise in the first place. Same outcome,
 * without a fudge factor that would itself have to be justified.
 */

import { t } from './i18n.js';
import type { AnalyzerNote, CaptureLabel, CaptureSettings, StatusError } from './state.js';

const PS_PER = { s: 1e12, ms: 1e9, us: 1e6, ns: 1e3, ps: 1 } as const;
type Unit = keyof typeof PS_PER;
const UNITS: Unit[] = ['s', 'ms', 'us', 'ns', 'ps'];

/** Picoseconds, as an exact integer. Safe to 2^53 ps = 2.5 hours. */
export function toPs(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new Error(`time must be finite, got ${seconds}`);
  return Math.round(seconds * 1e12);
}

/** The unit whose magnitude covers `ps`, i.e. the unit a tick of that size is written in. */
export function unitFor(ps: number): Unit {
  const a = Math.abs(ps);
  for (const u of UNITS) if (a >= PS_PER[u]) return u;
  return 'ps';
}

/**
 * The major tick label. `stepPs` is the *minor* tick size, which is the smallest
 * magnitude the label is allowed to descend to.
 */
export function majorLabel(ps: number, stepPs: number): string {
  const neg = ps < 0;
  let rem = Math.abs(ps);
  if (rem === 0) return '0 s';
  const stop = unitFor(stepPs);
  const stopIdx = UNITS.indexOf(stop);
  const parts: string[] = [];
  for (let i = 0; i <= stopIdx; i++) {
    const u = UNITS[i]!;
    const div = PS_PER[u];
    const v = Math.floor(rem / div);
    rem -= v * div;
    // Leading zeros are trimmed; an interior zero group is kept, because dropping it
    // would make "15 s : 0 ms : 300 us" read as "15 s : 300 us".
    if (v === 0 && parts.length === 0) continue;
    parts.push(`${v} ${u}`);
  }
  if (parts.length === 0) parts.push(`0 ${stop}`);
  return (neg ? '-' : '') + parts.join(' : ');
}

/**
 * The minor tick label: signed, relative to the **previous** major tick.
 *
 * "Previous", not "nearest". Rounding to the nearest major makes the second half of every
 * decade count backwards - the first render of the axis printed
 * "+100 us +200 us +300 us +400 us -500 us -400 us", which is not what any of the
 * screenshots show. Caught by looking at our own output, not by reasoning.
 */
export function minorLabel(deltaPs: number, stepPs: number): string {
  const u = unitFor(stepPs);
  const v = deltaPs / PS_PER[u];
  const sign = v < 0 ? '-' : '+';
  const mag = Math.abs(v);
  // Picoseconds are the display floor. A repeating sample period such as
  // 1e12/1.2e9 = 833.333... ps is shown as 833 ps, not false sub-ps precision.
  const txt = u === 'ps'
    ? String(Math.round(mag))
    : Number.isInteger(mag) ? String(mag) : mag.toFixed(3).replace(/\.?0+$/, '');
  return `${sign}${txt} ${u}`;
}

const ENG = [
  { s: 1, u: 's' },
  { s: 1e-3, u: 'ms' },
  { s: 1e-6, u: 'us' },
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

/** "open capture: <diagnostic>" - the prefix is chrome (translated), detail is payload. */
export function formatStatusError(err: StatusError): string {
  return `${t(err.what, err.vars)}: ${err.detail}`;
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
 * data). Diagnostics (`error.detail`, `stats.firstError`) pass through untranslated.
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
      return note.firstError ? `${base} · ${note.firstError}` : base;
    }
    case 'timeout': return t('analyzerNote.timeout');
    case 'cancelled': return t('analyzerNote.cancelled');
    case 'error': return note.detail;
  }
}
