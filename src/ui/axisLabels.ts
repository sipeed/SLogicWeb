// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Time-axis label text: which unit, how many decimals, and whether a base time is needed.
 * Pure, so `axis-labels-selftest.ts` can pin every case without a canvas.
 *
 * The scheme (it replaced the "15 s : 897 ms : 300 us" groups and "+100 us" minor labels,
 * which read badly on a real capture: a view starting at -100 ms printed "-1 s : 0 ms",
 * a 400 us step at 4.97 s printed "4 s : 972 ms : 400 us", and the "+400 us" offsets were
 * relative to a major that might be off-screen):
 *
 *   1. Every label is an absolute time from the display origin (T when triggered), with
 *      its sign: "-20 ms", "0 ms", "1.4 ms". No label is relative to another tick.
 *   2. One unit and one decimal count per axis. The unit starts at the labelled step's
 *      own unit (a 100 us step is written in us) and the decimals are what the step
 *      needs in that unit (0 for 100 us, 1 for 2.5 ns, 3 for the 833.3 ps sample period
 *      written in ns). If the largest label would need more than
 *      {@link MAX_INT_DIGITS} integer digits ("1400 us"), the unit is promoted (to
 *      "1.4 ms") as long as the step still fits in {@link MAX_DECIMALS} decimals.
 *   3. Only when no unit satisfies both limits - a fine step far from the origin, e.g. a
 *      400 us step at 4.9724 s, which would read "4972.4 ms" - is a single base shown at
 *      the left ("4.97 s") and the ticks become signed offsets from it ("+2.4 ms"). The
 *      base is the absolute time rounded toward zero to a power of ten at least as large
 *      as the labelled span, so every offset carries the same sign as the time itself.
 *      A view that crosses the origin never needs one (its labels are at most a few
 *      steps from 0) and never gets one.
 *
 * Units are written "s, ms, µs, ns, ps" (micro sign U+00B5) with one space, as
 * docs/DESIGN.md requires. A negative zero prints as "0".
 */

export const AXIS_UNITS = [
  { unit: 's', ps: 1e12 },
  { unit: 'ms', ps: 1e9 },
  { unit: 'µs', ps: 1e6 },
  { unit: 'ns', ps: 1e3 },
  { unit: 'ps', ps: 1 },
] as const;

/** Integer digits a label may carry before the unit is promoted or a base is used. */
export const MAX_INT_DIGITS = 3;
/** Decimals a label may carry; a step needing more is written in a smaller unit. */
export const MAX_DECIMALS = 3;

export interface AxisLabelPlan {
  /** Index into {@link AXIS_UNITS}. */
  unitIndex: number;
  decimals: number;
  /** The base the labels are offsets from, ps; null when labels are absolute. */
  basePs: number | null;
  /** The base as text ("4.97 s"); null without a base. */
  baseLabel: string | null;
}

/** Index of the largest unit not above `ps` (ps for anything below 1 ps). */
function unitIndexFor(ps: number): number {
  const a = Math.abs(ps);
  for (let i = 0; i < AXIS_UNITS.length; i++) if (a >= AXIS_UNITS[i]!.ps) return i;
  return AXIS_UNITS.length - 1;
}

/**
 * Decimals needed to write multiples of `stepPs` in unit `unitIndex`, or Infinity when
 * more than {@link MAX_DECIMALS} would be needed. A step that is not a terminating
 * decimal in that unit (1e12/1.2e9 = 833.33 ps) gets three significant digits.
 * Picoseconds are the display floor and never carry decimals.
 */
export function stepDecimals(stepPs: number, unitIndex: number): number {
  const unitPs = AXIS_UNITS[unitIndex]!.ps;
  if (unitPs === 1) return 0;
  const v = Math.abs(stepPs) / unitPs;
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  for (let d = 0; d <= MAX_DECIMALS; d++) {
    const scaled = v * 10 ** d;
    if (Math.round(scaled) >= 1 && Math.abs(scaled - Math.round(scaled)) <= 1e-6 * scaled) return d;
  }
  const d = Math.max(0, 2 - Math.floor(Math.log10(v)));
  return d <= MAX_DECIMALS ? d : Number.POSITIVE_INFINITY;
}

function intDigits(absPs: number, unitIndex: number, decimals: number): number {
  return (absPs / AXIS_UNITS[unitIndex]!.ps).toFixed(decimals).split('.')[0]!.length;
}

/**
 * The unit and decimals for labels `stepPs` apart whose largest magnitude is `maxAbsPs`:
 * the step's own unit, promoted while the integer part is too long and the step still
 * fits the decimals. `fits` is false when the result still has too many integer digits.
 */
export function chooseUnit(
  stepPs: number, maxAbsPs: number,
): { unitIndex: number; decimals: number; fits: boolean } {
  let unitIndex = unitIndexFor(stepPs);
  let decimals = stepDecimals(stepPs, unitIndex);
  while (intDigits(maxAbsPs, unitIndex, decimals) > MAX_INT_DIGITS && unitIndex > 0) {
    const next = stepDecimals(stepPs, unitIndex - 1);
    if (!Number.isFinite(next)) break;
    unitIndex -= 1;
    decimals = next;
  }
  return { unitIndex, decimals, fits: intDigits(maxAbsPs, unitIndex, decimals) <= MAX_INT_DIGITS };
}

/** `ps` written in a fixed unit and decimal count; `signed` adds "+" to positive values. */
export function formatAxisTime(
  ps: number, unitIndex: number, decimals: number, signed = false,
): string {
  const { unit, ps: unitPs } = AXIS_UNITS[unitIndex]!;
  const value = ps / unitPs;
  const text = Math.abs(value).toFixed(decimals);
  const zero = Number(text) === 0;
  // An offset of zero still reads as an offset ("+0 µs"); an absolute zero is unsigned.
  const sign = zero ? (signed ? '+' : '') : value < 0 ? '-' : signed ? '+' : '';
  return `${sign}${text} ${unit}`;
}

/**
 * Plan the labels for tick times `timesPs` (sorted, display-origin relative) labelled
 * `stepPs` apart. See the module comment for the rules.
 */
export function planAxisLabels(timesPs: readonly number[], stepPs: number): AxisLabelPlan {
  let maxAbs = 0;
  let minAbs = Number.POSITIVE_INFINITY;
  let neg = false;
  let pos = false;
  for (const t of timesPs) {
    const a = Math.abs(t);
    if (a > maxAbs) maxAbs = a;
    if (a < minAbs) minAbs = a;
    if (t < 0) neg = true;
    if (t > 0) pos = true;
  }
  const plain = chooseUnit(stepPs, maxAbs);
  const absolute: AxisLabelPlan = {
    unitIndex: plain.unitIndex, decimals: plain.decimals, basePs: null, baseLabel: null,
  };
  if (plain.fits || timesPs.length === 0 || (neg && pos)) return absolute;

  const first = timesPs[0]!;
  const last = timesPs[timesPs.length - 1]!;
  const span = Math.abs(last - first) + Math.abs(stepPs);
  const roundPs = 10 ** Math.ceil(Math.log10(span));
  const sign = neg ? -1 : 1;
  const basePs = sign * Math.floor(minAbs / roundPs) * roundPs;
  let maxOffset = 0;
  for (const t of timesPs) maxOffset = Math.max(maxOffset, Math.abs(t - basePs));
  const offset = chooseUnit(stepPs, maxOffset);
  // A base only earns its place when it shortens the labels.
  if (!offset.fits && intDigits(maxOffset, offset.unitIndex, offset.decimals) >=
      intDigits(maxAbs, plain.unitIndex, plain.decimals)) {
    return absolute;
  }
  return {
    unitIndex: offset.unitIndex,
    decimals: offset.decimals,
    basePs,
    baseLabel: formatStandaloneTime(basePs, roundPs),
  };
}

/**
 * One time on its own (a base, or a left-edge label): written in its own magnitude's
 * unit with the decimals `resolutionPs` needs, e.g. "4.9724 s" at 100 µs. A single label
 * has no row to keep short, so the three-digit/three-decimal limits do not apply.
 */
export function formatStandaloneTime(ps: number, resolutionPs: number): string {
  const unitIndex = unitIndexFor(ps === 0 ? resolutionPs : ps);
  const unitPs = AXIS_UNITS[unitIndex]!.ps;
  const decimals = unitPs === 1 ? 0
    : Math.min(12, Math.max(0, Math.ceil(Math.log10(unitPs / resolutionPs) - 1e-9)));
  return formatAxisTime(ps, unitIndex, decimals);
}

/** The text of one tick under `plan`. */
export function axisLabel(ps: number, plan: AxisLabelPlan): string {
  return plan.basePs === null
    ? formatAxisTime(ps, plan.unitIndex, plan.decimals)
    : formatAxisTime(ps - plan.basePs, plan.unitIndex, plan.decimals, true);
}
