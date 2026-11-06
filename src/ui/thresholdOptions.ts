/**
 * Readable labels for the digital threshold choices (`THRESHOLD_VOLT_OPTIONS`).
 *
 * A logic input is read reliably when the threshold sits near the middle of its swing,
 * i.e. about half the logic supply. Each option is annotated with the family whose
 * mid-swing it matches:
 *
 *   0.6 V  -> 1.2 V logic     (0.5 x 1.2)
 *   0.9 V  -> 1.8 V logic     (0.5 x 1.8)
 *   1.2 V  -> 2.5 V logic     (0.5 x 2.5 = 1.25)
 *   1.5 V  -> 5 V TTL         (TTL VIL 0.8 V / VIH 2.0 V; switching point ~1.4 V)
 *   1.65 V -> 3.3 V logic     (0.5 x 3.3; LVCMOS/LVTTL 3.3 V)
 *   2.5 V  -> 5 V CMOS        (0.5 x 5)
 *
 * 1.8 V and 3.3 V are not the mid-swing of a common family, so they keep the bare value
 * (they suit noisy 3.3 V / 5 V signals that need a higher switching point). The table is
 * advisory text only; the device still receives the plain voltage.
 */
import { vrefCode, vrefVolts } from '../device/index.js';
import { t } from './i18n.js';
import { THRESHOLD_VOLT_OPTIONS } from './state.js';

export type ThresholdFamily = { kind: 'logic'; supplyVolts: number } | { kind: 'ttl' } | null;

const FAMILIES: ReadonlyMap<number, ThresholdFamily> = new Map<number, ThresholdFamily>([
  [0.6, { kind: 'logic', supplyVolts: 1.2 }],
  [0.9, { kind: 'logic', supplyVolts: 1.8 }],
  [1.2, { kind: 'logic', supplyVolts: 2.5 }],
  [1.5, { kind: 'ttl' }],
  [1.65, { kind: 'logic', supplyVolts: 3.3 }],
  [2.5, { kind: 'logic', supplyVolts: 5 }],
]);

export function thresholdFamily(volts: number): ThresholdFamily {
  return FAMILIES.get(volts) ?? null;
}

export function thresholdOptionLabel(volts: number): string {
  const family = thresholdFamily(volts);
  if (family === null) return t('capturePanel.thresholdVolts', { volts });
  if (family.kind === 'ttl') return t('capturePanel.thresholdTtl', { volts });
  return t('capturePanel.thresholdLogic', { volts, logic: family.supplyVolts });
}

/**
 * The custom threshold range, derived from the vref DAC itself rather than hard-coded:
 * codes 1 .. top-1, because the two end codes clip (`device.thresholdClips`). `step` is
 * one DAC code (about 5.2 mV). With the current SLogic calibration this is about
 * 0.437-5.711 V.
 */
export interface ThresholdRange { min: number; max: number; step: number }

export function thresholdRange(): ThresholdRange {
  const top = vrefCode(Number.POSITIVE_INFINITY);
  return { min: vrefVolts(1), max: vrefVolts(top - 1), step: vrefVolts(1) - vrefVolts(0) };
}

/** True for one of the offered presets (the select's own values). */
export function isThresholdPreset(volts: number): boolean {
  return (THRESHOLD_VOLT_OPTIONS as readonly number[]).includes(volts);
}

/**
 * A number snapped only to the DAC grid (never to the nearest preset): a preset stays
 * itself, a value inside `thresholdRange()` becomes its code's voltage (four decimals,
 * which still maps back to the same code), anything else is null.
 */
export function snapThreshold(volts: number): number | null {
  if (!Number.isFinite(volts)) return null;
  if (isThresholdPreset(volts)) return volts;
  const { min, max, step } = thresholdRange();
  if (volts < min - step / 2 || volts > max + step / 2) return null;
  const top = vrefCode(Number.POSITIVE_INFINITY);
  const code = Math.min(top - 1, Math.max(1, vrefCode(volts)));
  return Number(vrefVolts(code).toFixed(4));
}

/** A typed custom threshold ("1.0", "1,0", "1.0 V"), snapped as `snapThreshold`. */
export function parseCustomThreshold(text: string): number | null {
  const trimmed = text.trim().replace(/\s*v$/i, '').replace(',', '.');
  if (!/^\+?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  return snapThreshold(Number(trimmed));
}

/**
 * A stored threshold that may be restored: a preset, or a custom value already on the
 * DAC grid (what `snapThreshold` produces). Anything else falls back to the default.
 */
export function isRestorableThreshold(volts: number): boolean {
  return snapThreshold(volts) === volts;
}

/** The select value for a threshold: a preset's own value, else `custom`. */
export function thresholdChoice(volts: number): string {
  return isThresholdPreset(volts) ? String(volts) : 'custom';
}
