// SPDX-License-Identifier: GPL-3.0-or-later

import { validateBusSpec, type BusSpec } from '../data/busValue.js';

export const CHANNEL_BANK_SIZE = 8;

export const CHANNEL_WIDTH_OPTIONS = [8, 16, 32] as const;

export function channelBankStart(index: number): number {
  return Math.floor(index / CHANNEL_BANK_SIZE) * CHANNEL_BANK_SIZE;
}

export function channelBankStarts(channelCount: number): number[] {
  const count = Math.max(0, Math.floor(channelCount));
  return Array.from({ length: Math.ceil(count / CHANNEL_BANK_SIZE) }, (_, i) => i * CHANNEL_BANK_SIZE);
}

export function channelBankIndices(start: number, channelCount: number): number[] {
  const count = Math.max(0, Math.floor(channelCount));
  if (!Number.isInteger(start) || start < 0 || start % CHANNEL_BANK_SIZE !== 0 || start >= count) return [];
  const end = Math.min(start + CHANNEL_BANK_SIZE, count);
  return Array.from({ length: end - start }, (_, i) => start + i);
}

export function channelBankRange(start: number, channelCount: number): string {
  const indices = channelBankIndices(start, channelCount);
  if (indices.length === 0) return '';
  return `D${start}–D${indices[indices.length - 1]!}`;
}

export function busChannelBank(spec: BusSpec): number | null {
  if (spec.bits.length !== CHANNEL_BANK_SIZE) return null;
  const sorted = [...spec.bits].sort((a, b) => a - b);
  const start = sorted[0]!;
  if (start % CHANNEL_BANK_SIZE !== 0) return null;
  return sorted.every((channel, i) => channel === start + i) ? start : null;
}

export function channelWidthOptions(channelCount: number): number[] {
  const max = Math.max(0, Math.floor(channelCount));
  return CHANNEL_WIDTH_OPTIONS.filter((n) => n <= max);
}

export function captureWidthTiers(deviceChannels: number | null, loadedCapture: boolean): number[] {
  if (deviceChannels === null || loadedCapture) return [];
  return channelWidthOptions(deviceChannels);
}

export function scopeOutOfWidth(spec: BusSpec, channels: number): boolean {
  if (busChannelBank(spec) === null) return false;
  const used = [...spec.bits, ...(spec.clock ? [spec.clock.channel] : [])];
  return used.some((channel) => channel >= channels);
}

export function lockedChannelBanks(
  buses: readonly { spec: BusSpec }[], channelCount?: number,
): Set<number> {
  const locked = new Set<number>();
  for (const bus of buses) {
    const start = busChannelBank(bus.spec);
    if (start === null || (channelCount !== undefined && validateBusSpec(bus.spec, channelCount).length > 0)) {
      continue;
    }
    locked.add(start);
  }
  return locked;
}
