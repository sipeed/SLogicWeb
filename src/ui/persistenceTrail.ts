// SPDX-License-Identifier: GPL-3.0-or-later

import type { AnalogLayout } from './analogBands.js';
import { acquisitionWaveCompleted } from './acquisitionWave.js';
import type { CaptureStopReason } from './captureViewport.js';

export type PersistenceFrames = 0 | 8 | 16 | 32;

export const PERSISTENCE_FRAMES: readonly PersistenceFrames[] = [0, 8, 16, 32];

export type PersistenceViewMode = 'time' | 'fft' | 'xy';

export function persistenceOf(raw: unknown): PersistenceFrames {
  if (raw === 8) return 8;
  if (raw === 16) return 16;
  if (raw === 32) return 32;
  return 0;
}

export function effectivePersistence(
  frames: PersistenceFrames, loop: boolean,
): PersistenceFrames {
  return loop ? 0 : persistenceOf(frames);
}

export function trailDecay(frames: PersistenceFrames): number {
  const n = persistenceOf(frames);
  return n === 0 ? 0 : 1 - 1 / n;
}

export interface PersistenceSourceKey {
  busId: string;
  gain: number;
  fullScaleV: number | null;
  voltsPerDiv: number | null;
  zeroPosition: number;
  offsetV: number;
  color: string;
  visible: boolean;
}

export interface PersistenceClearKeyInput {
  viewportSpan: number;
  widthCss: number;
  heightCss: number;
  dpr: number;
  analogLayout: AnalogLayout;
  bandTop: number;
  bandHeight: number;
  samplerate: number;
  sources: readonly PersistenceSourceKey[];
}

function numberText(field: string, value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`persistence clear key ${field} must be finite: ${value}`);
  }
  if (Object.is(value, -0)) return '-0';
  if (Number.isSafeInteger(value)) return String(value);
  return value.toExponential(20);
}

function optionalNumberText(field: string, value: number | null): string {
  return value === null ? '-' : numberText(field, value);
}

function byBusId(a: PersistenceSourceKey, b: PersistenceSourceKey): number {
  if (a.busId < b.busId) return -1;
  return a.busId > b.busId ? 1 : 0;
}

function sourceText(source: PersistenceSourceKey): string {
  return [
    source.busId,
    numberText('gain', source.gain),
    optionalNumberText('fullScaleV', source.fullScaleV),
    optionalNumberText('voltsPerDiv', source.voltsPerDiv),
    numberText('zeroPosition', source.zeroPosition),
    numberText('offsetV', source.offsetV),
    source.color,
    source.visible ? 'visible' : 'hidden',
  ].join(',');
}

export function trailClearKey(input: PersistenceClearKeyInput): string {
  if (input.analogLayout !== 'stacked' && input.analogLayout !== 'merged') {
    throw new RangeError(`unknown analog layout: ${String(input.analogLayout)}`);
  }
  return [
    numberText('viewportSpan', input.viewportSpan),
    numberText('widthCss', input.widthCss),
    numberText('heightCss', input.heightCss),
    numberText('dpr', input.dpr),
    input.analogLayout,
    numberText('bandTop', input.bandTop),
    numberText('bandHeight', input.bandHeight),
    numberText('samplerate', input.samplerate),
    ...[...input.sources].sort(byBusId).map(sourceText),
  ].join('|');
}

export interface PersistenceCommitInput {
  enabled: boolean;
  loop: boolean;
  reason: CaptureStopReason;
  samples: number;
  missed: boolean;
  viewMode: PersistenceViewMode;
  visible: boolean;
  waveKey: string;
  lastWaveKey: string | null;
}

export function shouldCommitPersistence(input: PersistenceCommitInput): boolean {
  if (!input.enabled || input.loop) return false;
  if (!input.visible) return false;
  if (input.viewMode !== 'time') return false;
  if (input.waveKey === input.lastWaveKey) return false;
  return acquisitionWaveCompleted({
    reason: input.reason,
    loop: input.loop,
    samples: input.samples,
    missed: input.missed,
  });
}

export type PersistenceClearEvent =
  | 'capture-session'
  | 'capture-replacement'
  | 'clear'
  | 'band-removed'
  | 'display-change'
  | 'none';

export type PersistenceClearReason =
  | 'capture-session'
  | 'capture-replacement'
  | 'clear'
  | 'band-removed'
  | 'display-change'
  | null;

export function clearReason(
  prevKey: string | null, nextKey: string | null, event: PersistenceClearEvent,
): PersistenceClearReason {
  if (event !== 'none') return event;
  if (prevKey === null || nextKey === null) return null;
  return prevKey === nextKey ? null : 'display-change';
}

export interface PersistenceSurfaceView {
  id: string;
  top: number;
  height: number;
  width: number;
  generation: number;
  commits: number;
}

function bySurfaceId(a: PersistenceSurfaceView, b: PersistenceSurfaceView): number {
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

export function persistenceSignature(
  frames: PersistenceFrames, surfaces: readonly PersistenceSurfaceView[],
): string {
  return [
    String(persistenceOf(frames)),
    ...[...surfaces].sort(bySurfaceId).map((surface) => [
      surface.id,
      numberText('top', surface.top),
      numberText('height', surface.height),
      numberText('width', surface.width),
      numberText('generation', surface.generation),
      numberText('commits', surface.commits),
    ].join(',')),
  ].join('|');
}
