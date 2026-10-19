// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import type { MessageKey } from './i18n.js';

export const CHANNEL_LABEL_MODES = ['name', 'legacy'] as const;
export type ChannelLabelMode = (typeof CHANNEL_LABEL_MODES)[number];

export const DEFAULT_CHANNEL_LABEL_MODE: ChannelLabelMode = 'name';

export const CHANNEL_LABEL_MODE_STORAGE_KEY = 'logicweb.channelLabelMode';

export const CHANNEL_LABEL_MODE_LABEL_KEYS: Record<ChannelLabelMode, MessageKey> = {
  name: 'channelLabels.name',
  legacy: 'channelLabels.legacy',
};

export const CHANNEL_LABEL_MODE_HINT_KEYS: Record<ChannelLabelMode, MessageKey> = {
  name: 'channels.nameHint.name',
  legacy: 'channels.nameHint.legacy',
};

let current: ChannelLabelMode = DEFAULT_CHANNEL_LABEL_MODE;

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  try {
    return storage()?.getItem(CHANNEL_LABEL_MODE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function pickChannelLabelMode(stored: string | null): ChannelLabelMode {
  return (CHANNEL_LABEL_MODES as readonly string[]).includes(stored ?? '')
    ? stored as ChannelLabelMode
    : DEFAULT_CHANNEL_LABEL_MODE;
}

export function getChannelLabelMode(): ChannelLabelMode {
  return current;
}

export function setChannelLabelMode(id: ChannelLabelMode): void {
  if (id === current) return;
  current = id;
  try {
    storage()?.setItem(CHANNEL_LABEL_MODE_STORAGE_KEY, id);
  } catch {
  }
  for (const cb of listeners) cb();
}

export function initChannelLabelMode(): ChannelLabelMode {
  const picked = pickChannelLabelMode(readStored());
  current = picked;
  return picked;
}

export function onChannelLabelModeChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
