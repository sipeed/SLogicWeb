// SPDX-License-Identifier: GPL-3.0-or-later

export const CHANNEL_BANK_SIZE = 8;

export interface ChannelEnableState {
  readonly index: number;
  readonly enabled: boolean;
}

export interface ChannelBankStatus {
  readonly enabled: number;
  readonly total: number;
  readonly state: 'none' | 'mixed' | 'all';
}

const NO_LOCKED_BANKS: ReadonlySet<number> = new Set();

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

export function channelBankStatus(
  channels: readonly ChannelEnableState[], start: number,
): ChannelBankStatus {
  if (!Number.isInteger(start) || start < 0 || start % CHANNEL_BANK_SIZE !== 0) {
    return { enabled: 0, total: 0, state: 'none' };
  }
  const bank = channels.filter((c) => channelBankStart(c.index) === start);
  const enabled = bank.filter((c) => c.enabled).length;
  return {
    enabled,
    total: bank.length,
    state: enabled === 0 ? 'none' : enabled === bank.length ? 'all' : 'mixed',
  };
}

export function toggleChannelBank(
  channels: readonly ChannelEnableState[], start: number,
  lockedBanks: ReadonlySet<number> = NO_LOCKED_BANKS,
): boolean[] | null {
  if (!Number.isInteger(start) || start < 0 || start % CHANNEL_BANK_SIZE !== 0 || lockedBanks.has(start)) {
    return null;
  }
  const status = channelBankStatus(channels, start);
  if (status.total === 0) return null;
  const enabled = status.state !== 'all';
  const next = channels.map((c) => channelBankStart(c.index) === start ? enabled : c.enabled);
  return next.some(Boolean) ? next : null;
}

export function clearChannelBanks(
  channels: readonly ChannelEnableState[],
  lockedBanks: ReadonlySet<number> = NO_LOCKED_BANKS,
): boolean[] {
  return channels.map((c) => c.index === 0 || lockedBanks.has(channelBankStart(c.index)));
}
