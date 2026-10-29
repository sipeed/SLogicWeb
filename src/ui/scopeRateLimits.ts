// SPDX-License-Identifier: GPL-3.0-or-later

import { channelWidthForProbes } from '../types.js';
import { CHANNEL_BANK_SIZE } from './channelBanks.js';

export const SCOPE_MIN_SAMPLERATE_HZ = 100e6;

export function maxWidthAtRate(rate: number, ceilings: Readonly<Record<number, number>>): number {
  let width = 0;
  for (const [channels, ceiling] of Object.entries(ceilings)) {
    if (ceiling >= rate) {
      const w = Number(channels);
      if (w > width) width = w;
    }
  }
  return width;
}

export function maxScopesAtRate(
  rate: number, ceilings: Readonly<Record<number, number>>, deviceChannels: number,
): number {
  const width = Math.min(maxWidthAtRate(rate, ceilings), Math.max(0, deviceChannels));
  return Math.floor(width / CHANNEL_BANK_SIZE);
}

export interface ScopeEnableVerdict {
  readonly ok: boolean;
  readonly effectiveRate: number;
  readonly requiredWidth: number;
  readonly bankWidth: number;
  readonly maxRate: number;
  readonly maxScopes: number;
}

export function scopeEnableVerdict(args: {
  start: number;
  clockChannel: number | null;
  currentWidth: number;
  rate: number;
  ceilings: Readonly<Record<number, number>>;
  deviceChannels: number;
}): ScopeEnableVerdict {
  const bankWidth = Math.max(
    channelWidthForProbes(args.start + CHANNEL_BANK_SIZE),
    args.clockChannel === null ? 0 : channelWidthForProbes(args.clockChannel + 1),
  );
  const requiredWidth = Math.max(Math.max(0, args.currentWidth), bankWidth);
  const effectiveRate = Math.max(args.rate, SCOPE_MIN_SAMPLERATE_HZ);
  const maxRate = args.ceilings[requiredWidth] ?? 0;
  return {
    ok: maxRate >= effectiveRate,
    effectiveRate,
    requiredWidth,
    bankWidth,
    maxRate,
    maxScopes: maxScopesAtRate(effectiveRate, args.ceilings, args.deviceChannels),
  };
}

export type ScopeRateBlock =
  | { readonly kind: 'floor' }
  | { readonly kind: 'ceiling'; readonly width: number; readonly maxRate: number };

export function scopeRateBlockAt(
  rate: number, width: number, ceilings: Readonly<Record<number, number>>, scopeActive: boolean,
): ScopeRateBlock | null {
  if (!scopeActive) return null;
  if (rate < SCOPE_MIN_SAMPLERATE_HZ) return { kind: 'floor' };
  const maxRate = ceilings[width] ?? 0;
  if (rate > maxRate) return { kind: 'ceiling', width, maxRate };
  return null;
}

export interface ScopeRateOption {
  readonly rate: number;
  readonly block: ScopeRateBlock | null;
}

export function scopeRateOptions(
  rates: readonly number[], width: number, ceilings: Readonly<Record<number, number>>,
  scopeActive: boolean,
): ScopeRateOption[] {
  if (!scopeActive) {
    const ceiling = ceilings[width] ?? 200e6;
    return rates.filter((rate) => rate <= ceiling).map((rate) => ({ rate, block: null }));
  }
  const deviceMax = Math.max(0, ...Object.values(ceilings));
  return rates
    .filter((rate) => rate <= deviceMax)
    .map((rate) => ({ rate, block: scopeRateBlockAt(rate, width, ceilings, true) }));
}
