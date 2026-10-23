// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Session state. Plain data plus a change callback; there is no framework here, per
 * docs/ARCHITECTURE.md ("no UI framework unless a builder makes a case for one"), and this
 * shell never grew a case for one - the whole model is 16 channels and a handful of
 * analyzers.
 */

import type { AnnotationIndex, DecodeResult } from '../decode/index.js';
import { ANALYZER_COLORS, CHANNEL_COLORS } from './metrics.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import { DROP_FRONT_QUANTUM } from '../data/index.js';
import type { MessageKey, MessageVars } from './i18n.js';

export interface ChannelState {
  /** Capture channel index, i.e. D<index>. Never changes; display order does. */
  index: number;
  name: string;
  /** #rrggbb; defaults to channelColor(index), editable for the current capture. */
  color: string;
  enabled: boolean;
}

export type AnalyzerStatus = 'idle' | 'decoding' | 'done' | 'error';

/**
 * An analyzer's status note as structured data, formatted by format.ts's
 * formatAnalyzerNote at render time so a locale switch retranslates it (same rule
 * as CaptureLabel). The `error` variant's detail - and `stats.firstError` - is
 * decoder/worker diagnostic payload and passes through untranslated.
 */
export type AnalyzerNote =
  | { kind: 'pending' }
  | { kind: 'edges'; count: number }
  | { kind: 'stats'; anns: number; decodeMs: number; wallMs: number; firstError?: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'error'; detail: string };

export interface AnalyzerState {
  id: string;
  decoderId: string;
  /** Short display name, e.g. "I2C". */
  label: string;
  color: string;
  /** decoder channel index -> capture channel index */
  channels: Record<number, number>;
  options: Record<string, string | number>;
  /** Capture channel whose row carries this analyzer's lane. */
  laneChannel: number;
  result: DecodeResult | null;
  index: AnnotationIndex | null;
  status: AnalyzerStatus;
  note: AnalyzerNote;
}

export interface CaptureSettings {
  channels: ChannelCount;
  samplerate: number;
  thresholdVolts: number;
  /** 'free' runs until stopped or until the sample ceiling; 'timer' stops after seconds. */
  mode: 'free' | 'timer' | 'loop';
  seconds: number;
  loopSeconds: number;
  /** Hardware data source: normal pins, USB maximum-speed pattern, or simulator. */
  testMode: 0 | 1 | 2;
  /** Global trigger enable mask. Per-channel modes remain stored when this is false. */
  triggerEnableMask: boolean;
  softwareTrigger: boolean;
  /** One of the six per-channel trigger glyphs. Missing means X / any value. */
  triggerModes: Record<number, TriggerMode>;
  /** Confirmed per-channel conditions. They are combined with logical AND. */
  triggerConditions: TriggerCondition[];
  /** Legacy single-condition fields kept for saved/debug settings compatibility. */
  triggerChannel: number;
  triggerKind: 'level' | 'rising' | 'falling' | 'edge';
  triggerLevel: 0 | 1;
  preTriggerPercent: number;
}

export interface TriggerCondition {
  channel: number;
  kind: CaptureSettings['triggerKind'];
  level: 0 | 1;
}

export const LOOP_RETENTION_MAX_BYTES = 2 ** 30;
export const LOOP_RETENTION_MAX_SAMPLES = 2 ** 29;

export function maxLoopSeconds(channels: ChannelCount, samplerate: number): number {
  return Math.min(LOOP_RETENTION_MAX_BYTES / bytesPerSampleForChannels(channels),
    LOOP_RETENTION_MAX_SAMPLES) / samplerate;
}

export function clampLoopSeconds(loopSeconds: number, channels: ChannelCount, samplerate: number): number {
  const max = maxLoopSeconds(channels, samplerate);
  if (Number.isNaN(loopSeconds)) return Math.max(0.001, Math.floor(Math.min(1, max) * 1000) / 1000);
  if (loopSeconds === Number.POSITIVE_INFINITY) return Math.max(0.001, Math.floor(max * 1000) / 1000);
  if (!Number.isFinite(loopSeconds)) return 0.001;
  return Math.max(0.001, Math.floor(Math.min(loopSeconds, max) * 1000) / 1000);
}

export function loopRetentionSamples(loopSeconds: number, channels: ChannelCount, samplerate: number): number {
  const q = DROP_FRONT_QUANTUM;
  return Math.max(q, Math.floor(Math.min(
    clampLoopSeconds(loopSeconds, channels, samplerate) * samplerate,
    LOOP_RETENTION_MAX_SAMPLES,
  ) / q) * q);
}

export function loopDropSamples(length: number, retention: number): number {
  if (!(retention > 0) || length < retention * 2) return 0;
  return Math.floor((length - retention) / DROP_FRONT_QUANTUM) * DROP_FRONT_QUANTUM;
}

export type TriggerMode = 'low' | 'high' | 'rising' | 'falling' | 'edge' | 'dont-care';

/** [CHOSEN] An unconfigured channel imposes no condition and displays X / any value. */
export const DEFAULT_TRIGGER_MODE: TriggerMode = 'dont-care';

/** Preserve every engine-supported condition when normalizing it back to a dialog mode. */
export function triggerModeFromCondition(condition: TriggerCondition): TriggerMode {
  return condition.kind === 'level' ? (condition.level ? 'high' : 'low') : condition.kind;
}

/** Convert the dialog's per-channel modes to the sorted AND-condition list App clamps. */
export function modesToConditions(modes: Record<number, TriggerMode>): TriggerCondition[] {
  return Object.keys(modes).map(Number).sort((a, b) => a - b).flatMap((channel): TriggerCondition[] => {
    const mode = modes[channel];
    if (!mode || mode === 'dont-care') return [];
    if (mode === 'low' || mode === 'high') {
      return [{ channel, kind: 'level', level: mode === 'high' ? 1 : 0 }];
    }
    return [{ channel, kind: mode, level: 1 }];
  });
}

export function isEdgeTriggerMode(mode: TriggerMode): boolean {
  return mode === 'rising' || mode === 'falling' || mode === 'edge';
}

export function edgeTriggerAutoArms(
  previous: TriggerMode,
  committed: TriggerMode,
  maskEnabled: boolean,
): boolean {
  return previous !== committed && isEdgeTriggerMode(committed) && !maskEnabled;
}

export type Source = 'none' | 'file' | 'device';

/**
 * The capture title as structured data, formatted by format.ts's formatCaptureLabel
 * at render time. Stored pre-formatted, a mid-session locale switch could not
 * retranslate it; as data, it can. `loaded.source` is the loader's
 * sourceDescription - user/file data (baked into .lwcap at save time) that passes
 * through untranslated on purpose.
 */
export type CaptureLabel =
  | { kind: 'none' }
  | { kind: 'capturing'; channels: number; rate: number }
  | { kind: 'loaded'; source: string; ms: number }
  | { kind: 'demo' }
  | { kind: 'stoppedNoTrigger'; samples: number }
  | { kind: 'live'; samples: number; rate: number; seconds: number };

/**
 * The status-bar error as structured data: `what` is chrome (a catalog key, translated
 * at render time), `detail` is the diagnostic payload (kept verbatim - parser and
 * device errors are data, not prose). See format.ts's formatStatusError.
 */
export interface StatusError {
  what: MessageKey;
  vars?: MessageVars;
  detail: string;
}

export function defaultChannelName(index: number): string {
  return `D${index}`;
}

export function defaultChannels(n: number): ChannelState[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    name: defaultChannelName(i),
    color: channelColor(i),
    enabled: true,
  }));
}

export function channelColor(index: number): string {
  return CHANNEL_COLORS[index % CHANNEL_COLORS.length]!;
}

export function analyzerColor(n: number): string {
  return ANALYZER_COLORS[n % ANALYZER_COLORS.length]!;
}
