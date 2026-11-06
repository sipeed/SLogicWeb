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
import { t } from './i18n.js';

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
