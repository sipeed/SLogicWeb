import { isChannelCount, type ChannelCount } from '../types.js';
import { SAMPLERATES_HZ } from '../device/index.js';
import {
  defaultCaptureSettings, defaultChannelName, defaultChannels, THRESHOLD_VOLT_OPTIONS,
  type CaptureSettings, type TriggerMode,
} from './state.js';

export const WORKSPACE_STORAGE_KEY = 'logicweb.workspace';
export const WORKSPACE_SCHEMA_VERSION = 1 as const;

export interface PersistedChannel {
  name: string;
  color: string;
  enabled: boolean;
}

export interface PersistedCaptureSettings {
  samplerate: number;
  thresholdVolts: number;
  mode: CaptureSettings['mode'];
  seconds: number;
  loopSamples: number;
  testMode: 0 | 1 | 2;
  triggerEnableMask: boolean;
  triggerModes: Record<number, TriggerMode>;
  preTriggerPercent: number;
}

export interface WorkspaceSnapshotV1 {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  detailedLabels: boolean;
  channels?: PersistedChannel[];
  order?: number[];
  capture?: PersistedCaptureSettings;
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

function isTriggerMode(value: unknown): value is TriggerMode {
  return value === 'low' || value === 'high' || value === 'rising' ||
    value === 'falling' || value === 'edge' || value === 'dont-care';
}

function restoreTriggerModes(value: unknown, capacity: number): Record<number, TriggerMode> {
  const modes: Record<number, TriggerMode> = {};
  if (!isRecord(value)) return modes;
  for (const [key, mode] of Object.entries(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) continue;
    const channel = Number(key);
    if (!Number.isSafeInteger(channel) || channel < 0 || channel >= capacity || !isTriggerMode(mode)) continue;
    modes[channel] = mode;
  }
  return modes;
}

function restoreCapture(value: unknown, capacity: number): PersistedCaptureSettings {
  const defaults = defaultCaptureSettings();
  const capture: PersistedCaptureSettings = {
    samplerate: defaults.samplerate,
    thresholdVolts: defaults.thresholdVolts,
    mode: defaults.mode,
    seconds: defaults.seconds,
    loopSamples: defaults.loopSamples,
    testMode: defaults.testMode,
    triggerEnableMask: defaults.triggerEnableMask,
    triggerModes: {},
    preTriggerPercent: defaults.preTriggerPercent,
  };
  if (!isRecord(value)) return capture;
  if (typeof value.samplerate === 'number' && SAMPLERATES_HZ.includes(value.samplerate)) {
    capture.samplerate = value.samplerate;
  }
  if (typeof value.thresholdVolts === 'number' &&
      (THRESHOLD_VOLT_OPTIONS as readonly number[]).includes(value.thresholdVolts)) {
    capture.thresholdVolts = value.thresholdVolts;
  }
  if (value.mode === 'free' || value.mode === 'timer' || value.mode === 'loop') capture.mode = value.mode;
  if (typeof value.seconds === 'number' && Number.isFinite(value.seconds)) capture.seconds = value.seconds;
  if (typeof value.loopSamples === 'number' && Number.isFinite(value.loopSamples)) {
    capture.loopSamples = value.loopSamples;
  }
  if (value.testMode === 0 || value.testMode === 1 || value.testMode === 2) capture.testMode = value.testMode;
  if (typeof value.triggerEnableMask === 'boolean') capture.triggerEnableMask = value.triggerEnableMask;
  capture.triggerModes = restoreTriggerModes(value.triggerModes, capacity);
  if (typeof value.preTriggerPercent === 'number' && Number.isFinite(value.preTriggerPercent)) {
    capture.preTriggerPercent = value.preTriggerPercent;
  }
  return capture;
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
    capture: restoreCapture(parsed.capture, channels.length),
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
  if (snapshot.capture) {
    const capture = snapshot.capture;
    serialized.capture = {
      samplerate: capture.samplerate,
      thresholdVolts: capture.thresholdVolts,
      mode: capture.mode,
      seconds: capture.seconds,
      loopSamples: capture.loopSamples,
      testMode: capture.testMode,
      triggerEnableMask: capture.triggerEnableMask,
      triggerModes: Object.fromEntries(Object.entries(capture.triggerModes)
        .sort(([a], [b]) => Number(a) - Number(b))),
      preTriggerPercent: capture.preTriggerPercent,
    };
  }
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
