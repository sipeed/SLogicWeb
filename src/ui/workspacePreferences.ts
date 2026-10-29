import { isChannelCount, type ChannelCount } from '../types.js';
import { defaultChannelName, defaultChannels } from './state.js';

export const WORKSPACE_STORAGE_KEY = 'logicweb.workspace';
export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export interface PersistedChannel {
  name: string;
  color: string;
  enabled: boolean;
}

export interface WorkspaceSnapshotV1 {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  detailedLabels: boolean;
  channels?: PersistedChannel[];
  order?: number[];
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreChannels(value: unknown, fallbackChannelCount: ChannelCount): PersistedChannel[] {
  const validSource = Array.isArray(value) && isChannelCount(value.length);
  const capacity = validSource ? value.length : fallbackChannelCount;
  const channels = defaultChannels(capacity).map(({ name, color, enabled }) => ({ name, color, enabled }));
  if (validSource) {
    for (let i = 0; i < channels.length; i++) {
      const candidate = value[i];
      if (!isRecord(candidate)) continue;
      const channel = channels[i]!;
      if (typeof candidate.name === 'string') channel.name = candidate.name.trim() || defaultChannelName(i);
      if (typeof candidate.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate.color)) {
        channel.color = candidate.color;
      }
      if (typeof candidate.enabled === 'boolean') channel.enabled = candidate.enabled;
    }
  }
  if (channels.every((channel) => !channel.enabled)) channels[0]!.enabled = true;
  return channels;
}

function restoreOrder(value: unknown, capacity: number): number[] {
  const order: number[] = [];
  if (Array.isArray(value)) {
    for (const index of value) {
      if (Number.isInteger(index) && index >= 0 && index < capacity && !order.includes(index)) order.push(index);
    }
  }
  for (let i = 0; i < capacity; i++) if (!order.includes(i)) order.push(i);
  return order;
}

export function parseWorkspaceSnapshot(
  raw: string | null, fallbackChannelCount: ChannelCount = 16,
): WorkspaceSnapshotV1 | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== WORKSPACE_SCHEMA_VERSION) return null;
  const channels = restoreChannels(parsed.channels, fallbackChannelCount);
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    detailedLabels: typeof parsed.detailedLabels === 'boolean' ? parsed.detailedLabels : true,
    channels,
    order: restoreOrder(parsed.order, channels.length),
  };
}

export function readWorkspaceSnapshot(fallbackChannelCount: ChannelCount = 16): WorkspaceSnapshotV1 | null {
  try {
    return parseWorkspaceSnapshot(storage()?.getItem(WORKSPACE_STORAGE_KEY) ?? null, fallbackChannelCount);
  } catch {
    return null;
  }
}

export function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): string {
  const serialized: WorkspaceSnapshotV1 = {
    version: WORKSPACE_SCHEMA_VERSION,
    detailedLabels: snapshot.detailedLabels,
  };
  if (snapshot.channels) {
    serialized.channels = snapshot.channels.map(({ name, color, enabled }) => ({ name, color, enabled }));
  }
  if (snapshot.order) serialized.order = [...snapshot.order];
  return JSON.stringify(serialized);
}

export function writeWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): boolean {
  try {
    const store = storage();
    if (store === null) return false;
    store.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspaceSnapshot(snapshot));
    return true;
  } catch {
    return false;
  }
}
