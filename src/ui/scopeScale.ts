// SPDX-License-Identifier: GPL-3.0-or-later

import { ROWS } from './metrics.js';

/**
 * Shared ADC scope coordinates. The ruler, graticule, trace, trigger line/drag and hit
 * testing must agree, so every one of them derives the division count from the row's
 * band through `scopeGeometry` (DESIGN.md §5.4).
 */
export const SCOPE_PAD_CSS = 6;
/** The fewest/most vertical divisions a row shows: even, so 0 V stays on a line. */
export const SCOPE_DIVISIONS_MIN = 4;
export const SCOPE_DIVISIONS_MAX = 8;
/** [CHOSEN] About this many CSS px per division before a taller row gains two more. */
export const SCOPE_DIVISION_CSS = 38;

/**
 * The divisions a row band (row height minus its separator) shows: about 38 px each,
 * rounded to an even count and clamped to 4..8. The row height stops give 80/120/160 px:
 * 4, 240 px: 6, 320/400/480 px: 8. A pure function of the band, so the trace, graticule,
 * ruler and trigger drag cannot disagree.
 */
export function scopeDivisions(band: number): number {
  const inner = Math.max(1, (Number.isFinite(band) ? band : 0) - 2 * SCOPE_PAD_CSS);
  const even = 2 * Math.round(inner / (2 * SCOPE_DIVISION_CSS));
  return Math.min(SCOPE_DIVISIONS_MAX, Math.max(SCOPE_DIVISIONS_MIN, even));
}

/** `scopeDivisions` for an analog row of `heightCss` (its band excludes the separator). */
export function scopeRowDivisions(heightCss: number): number {
  return scopeDivisions(heightCss - ROWS.separator);
}
/**
 * Every 1-2-5 V/div step any declared analog gain can use: 0.005 V (±0.16 V at 100x)
 * to 200 V (±160 V at 0.1x). A row walks only the slice its range makes useful
 * (`scopeVoltsPerDivValues`); at 1x that slice is the original 0.5..20 V.
 */
export const SCOPE_VDIV_VALUES = [
  0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200,
] as const;
export const SCOPE_SCALE_ANIMATION_MS = 140;

export interface ScopeGeometry {
  readonly centre: number;
  readonly topV: number;
  readonly bottomV: number;
  readonly innerHeight: number;
  /** The row's division count (`scopeDivisions(band)`). */
  readonly divisions: number;
  yVolts(volts: number): number;
}

/**
 * `zeroPosition` is measured in the whole row (0 top, 1 bottom), while the trace and
 * ruler use the row's padded inner band. Every visible division is an integer multiple
 * of V/Div, so moving zero moves the complete voltage ruler without re-anchoring it.
 * The division count follows the band: a taller row keeps V/div and zero and shows a
 * wider range.
 */
export function scopeGeometry(
  top: number, band: number, voltsPerDiv: number, zeroPosition: number,
): ScopeGeometry {
  const perDiv = Math.max(0.001, voltsPerDiv);
  const zero = Math.min(1, Math.max(0, zeroPosition));
  const innerHeight = Math.max(1, band - 2 * SCOPE_PAD_CSS);
  const divisions = scopeDivisions(band);
  const centre = (zero - 0.5) * perDiv * divisions;
  const topV = centre + perDiv * divisions / 2;
  const bottomV = centre - perDiv * divisions / 2;
  return {
    centre, topV, bottomV, innerHeight, divisions,
    yVolts: (volts) => top + SCOPE_PAD_CSS + innerHeight / 2 -
      ((volts - centre) / perDiv) * (innerHeight / divisions),
  };
}

/** Inverse of `scopeGeometry(...).yVolts`, used by the trigger-level drag. */
export function scopeVoltsAtY(
  y: number, top: number, band: number, voltsPerDiv: number, zeroPosition: number,
): number {
  const g = scopeGeometry(top, band, voltsPerDiv, zeroPosition);
  const middleY = top + SCOPE_PAD_CSS + g.innerHeight / 2;
  return g.centre + (middleY - y) * Math.max(0.001, voltsPerDiv) * g.divisions / g.innerHeight;
}

/** The visible integer division indices, including zero when it is in range. */
export function scopeTickIndices(g: Pick<ScopeGeometry, 'topV' | 'bottomV'>, voltsPerDiv: number): number[] {
  if (!Number.isFinite(voltsPerDiv) || voltsPerDiv <= 0) return [];
  const first = Math.ceil(g.bottomV / voltsPerDiv - 1e-9);
  const last = Math.floor(g.topV / voltsPerDiv + 1e-9);
  // Normal scale steps span at most ~21 marks mid-animation (8 divisions, 2.5x). A corrupt restored scale
  // must not turn this render-time loop into an unbounded allocation.
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > 32) return [];
  const ticks: number[] = [];
  for (let k = first; k <= last; k++) ticks.push(k);
  return ticks;
}

export function formatScopeVolts(volts: number): string {
  const rounded = Math.abs(volts) < 1e-9 ? 0 : Number(volts.toFixed(3));
  return `${rounded} V`;
}

/**
 * The default V/div for a bipolar half-range: the finest step whose `divisions` show all
 * of it (half of them each side of a centred 0 V). ±16 V: 10 V on 4 divisions, 10 V on 6
 * (±30 V; 5 V would show only ±15 V), 5 V on 8.
 */
export function scopeDefaultVoltsPerDiv(
  halfRangeV: number, divisions: number = SCOPE_DIVISIONS_MIN,
): number {
  const half = Math.max(1, Math.floor(divisions / 2));
  const need = Math.abs(halfRangeV) / half;
  return SCOPE_VDIV_VALUES.find((value) => value >= need - 1e-9) ??
    SCOPE_VDIV_VALUES[SCOPE_VDIV_VALUES.length - 1]!;
}

/**
 * The steps a row with this half-range walks: from 1/20 of its default V/div (finer than
 * one 8-bit code per division) up to twice the default (the whole range in one
 * division). ±16 V gives 0.5..20 V. The slice is anchored on the 4-division default,
 * never the row's height, so resizing a row cannot drop its current or saved V/div.
 */
export function scopeVoltsPerDivValues(halfRangeV: number): number[] {
  const half = Math.abs(halfRangeV);
  if (!Number.isFinite(half) || half <= 0) return [...SCOPE_VDIV_VALUES];
  const base = scopeDefaultVoltsPerDiv(half, SCOPE_DIVISIONS_MIN);
  return SCOPE_VDIV_VALUES.filter((value) => value >= base / 20 - 1e-9 && value <= base * 2 + 1e-9);
}

/**
 * One wheel/key step through a row's scope scales (`values`, default every step),
 * including a restored value outside them.
 */
export function nextScopeVoltsPerDiv(
  current: number, direction: -1 | 1,
  values: readonly number[] = SCOPE_VDIV_VALUES,
): number {
  values = [...new Set([...values, current])].sort((a, b) => a - b);
  const at = Math.max(0, values.findIndex((value) => value >= current - 1e-9));
  return values[Math.min(values.length - 1, Math.max(0, at + direction))]!;
}

/** Smooth the spatial zoom, not just the ruler's numbers. */
export function scopeScaleAt(
  from: number, to: number, startedAt: number, now: number,
): { value: number; done: boolean } {
  const progress = Math.min(1, Math.max(0, (now - startedAt) / SCOPE_SCALE_ANIMATION_MS));
  const eased = 1 - (1 - progress) ** 3;
  return { value: from + (to - from) * eased, done: progress >= 1 };
}

/** [CHOSEN] Vertical autoset fits the signal's peak-to-peak into this share of the row. */
export const SCOPE_AUTOSET_FILL = 0.8;

/**
 * Vertical autoset for one analog row (DESIGN.md §5.2): view state only.
 *
 * Picks the finest step of `values` whose `divisions` hold the signal's [minV, maxV] in
 * at most SCOPE_AUTOSET_FILL of the row, and the zero position that centres the signal.
 * The zero position is clamped to the row (0..1); when the clamp would push the signal
 * off the row the step is too fine and the next one is tried. With nothing to fit (no
 * finite range, or a flat line) it returns the default: `defaultVoltsPerDiv` with 0 V
 * centred. If no step fits, the coarsest is used.
 */
export function scopeAutoset(
  minV: number, maxV: number, divisions: number,
  values: readonly number[], defaultVoltsPerDiv: number,
): { voltsPerDiv: number; zeroPosition: number } {
  const fallback = { voltsPerDiv: defaultVoltsPerDiv, zeroPosition: 0.5 };
  if (!Number.isFinite(minV) || !Number.isFinite(maxV) || !(maxV > minV) || values.length === 0) {
    return fallback;
  }
  const n = Math.max(1, divisions);
  const mid = (minV + maxV) / 2;
  const sorted = [...values].sort((a, b) => a - b);
  for (const perDiv of sorted) {
    const span = perDiv * n;
    if (maxV - minV > SCOPE_AUTOSET_FILL * span + 1e-12) continue;
    // `scopeGeometry`: the row middle shows (zero - 0.5) * span volts.
    const zeroPosition = Math.min(1, Math.max(0, 0.5 + mid / span));
    const centre = (zeroPosition - 0.5) * span;
    if (minV < centre - span / 2 - 1e-12 || maxV > centre + span / 2 + 1e-12) continue;
    return { voltsPerDiv: perDiv, zeroPosition };
  }
  const perDiv = sorted[sorted.length - 1]!;
  return { voltsPerDiv: perDiv, zeroPosition: Math.min(1, Math.max(0, 0.5 + mid / (perDiv * n))) };
}
