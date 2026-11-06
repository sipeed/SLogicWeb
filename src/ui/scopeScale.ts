// SPDX-License-Identifier: GPL-3.0-or-later

/** Shared ADC scope coordinates. The ruler, graticule, trace and trigger must agree. */
export const SCOPE_DIVISIONS = 4;
export const SCOPE_PAD_CSS = 6;
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
  yVolts(volts: number): number;
}

/**
 * `zeroPosition` is measured in the whole row (0 top, 1 bottom), while the trace and
 * ruler use the row's padded inner band. Every visible division is an integer multiple
 * of V/Div, so moving zero moves the complete voltage ruler without re-anchoring it.
 */
export function scopeGeometry(
  top: number, band: number, voltsPerDiv: number, zeroPosition: number,
): ScopeGeometry {
  const perDiv = Math.max(0.001, voltsPerDiv);
  const zero = Math.min(1, Math.max(0, zeroPosition));
  const innerHeight = Math.max(1, band - 2 * SCOPE_PAD_CSS);
  const centre = (zero - 0.5) * perDiv * SCOPE_DIVISIONS;
  const topV = centre + perDiv * SCOPE_DIVISIONS / 2;
  const bottomV = centre - perDiv * SCOPE_DIVISIONS / 2;
  return {
    centre, topV, bottomV, innerHeight,
    yVolts: (volts) => top + SCOPE_PAD_CSS + innerHeight / 2 -
      ((volts - centre) / perDiv) * (innerHeight / SCOPE_DIVISIONS),
  };
}

/** Inverse of `scopeGeometry(...).yVolts`, used by the trigger-level drag. */
export function scopeVoltsAtY(
  y: number, top: number, band: number, voltsPerDiv: number, zeroPosition: number,
): number {
  const g = scopeGeometry(top, band, voltsPerDiv, zeroPosition);
  const middleY = top + SCOPE_PAD_CSS + g.innerHeight / 2;
  return g.centre + (middleY - y) * voltsPerDiv * SCOPE_DIVISIONS / g.innerHeight;
}

/** The visible integer division indices, including zero when it is in range. */
export function scopeTickIndices(g: Pick<ScopeGeometry, 'topV' | 'bottomV'>, voltsPerDiv: number): number[] {
  if (!Number.isFinite(voltsPerDiv) || voltsPerDiv <= 0) return [];
  const first = Math.ceil(g.bottomV / voltsPerDiv - 1e-9);
  const last = Math.floor(g.topV / voltsPerDiv + 1e-9);
  // Normal scale steps span at most eleven marks mid-animation. A corrupt restored scale
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
 * The default V/div for a bipolar half-range: the finest step whose four divisions show
 * all of it (two divisions each side of a centred 0 V). 10 V for ±16 V.
 */
export function scopeDefaultVoltsPerDiv(halfRangeV: number): number {
  const need = Math.abs(halfRangeV) / (SCOPE_DIVISIONS / 2);
  return SCOPE_VDIV_VALUES.find((value) => value >= need - 1e-9) ??
    SCOPE_VDIV_VALUES[SCOPE_VDIV_VALUES.length - 1]!;
}

/**
 * The steps a row with this half-range walks: from 1/20 of its default V/div (finer than
 * one 8-bit code per division) up to twice the default (the whole range in one
 * division). ±16 V gives 0.5..20 V.
 */
export function scopeVoltsPerDivValues(halfRangeV: number): number[] {
  const half = Math.abs(halfRangeV);
  if (!Number.isFinite(half) || half <= 0) return [...SCOPE_VDIV_VALUES];
  const base = scopeDefaultVoltsPerDiv(half);
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
