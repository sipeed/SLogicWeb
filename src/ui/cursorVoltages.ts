// SPDX-License-Identifier: GPL-3.0-or-later

import type { SampleStore } from '../data/types.js';
import { analogVoltsFromCode } from './channelBanks.js';
import { t } from './i18n.js';
import { measureBitsProblem, readMeasureSamples } from './measureSamples.js';
import { formatScopeVolts } from './scopeScale.js';

export type CursorVoltageStatus =
  'value' | 'unknown' | 'outside' | 'no-cursor' | 'previous-wave' | 'no-source';

export interface CursorVoltageSource {
  busId: string;
  name: string;
  color: string;
  bits: readonly number[];
  group: number;
  gain: number;
}

export interface CursorVoltagePoint {
  busId: string;
  name: string;
  color: string;
  code: number | null;
  volts: number | null;
  status: CursorVoltageStatus;
}

export interface CursorVoltageRequest {
  sample: number | null;
  previousWave: boolean;
}

export const CURSOR_VOLTS_PLACEHOLDER = '--';

function sourceReadable(source: CursorVoltageSource, channelCount: number): boolean {
  return measureBitsProblem(source.bits, channelCount) === null;
}

export function projectCursorVoltages(
  store: SampleStore | null,
  sources: readonly CursorVoltageSource[],
  request: CursorVoltageRequest,
): CursorVoltagePoint[] {
  const points: CursorVoltagePoint[] = [];
  for (const source of sources) {
    const base = { busId: source.busId, name: source.name, color: source.color };
    if (request.sample === null || !Number.isInteger(request.sample) || request.sample < 0) {
      points.push({ ...base, code: null, volts: null, status: 'no-cursor' });
      continue;
    }
    if (request.previousWave) {
      points.push({ ...base, code: null, volts: null, status: 'previous-wave' });
      continue;
    }
    if (store === null || !sourceReadable(source, store.channelCount)) {
      points.push({ ...base, code: null, volts: null, status: 'no-source' });
      continue;
    }
    const read = readMeasureSamples(store, source, {
      start: request.sample, end: request.sample + 1,
    });
    if (read.analyzed !== 1) {
      points.push({ ...base, code: null, volts: null, status: 'outside' });
      continue;
    }
    const code = read.codes[0]!;
    if (read.unknown[0] !== 0) {
      points.push({ ...base, code, volts: null, status: 'unknown' });
      continue;
    }
    points.push({ ...base, code, volts: analogVoltsFromCode(code, source.gain), status: 'value' });
  }
  return points;
}

export function cursorVoltageValue(point: CursorVoltagePoint): string {
  return point.status === 'value' && point.volts !== null
    ? formatScopeVolts(point.volts) : CURSOR_VOLTS_PLACEHOLDER;
}

export function cursorVoltageDetail(point: CursorVoltagePoint, cursorLabel: string): string {
  switch (point.status) {
    case 'value':
      return t('bus.voltsAtCursor', { volts: cursorVoltageValue(point), cursor: cursorLabel });
    case 'unknown': return t('bus.voltsUnknown');
    case 'outside': return t('bus.voltsOutside');
    case 'previous-wave': return t('bus.voltsPreviousWave');
    case 'no-source': return t('bus.voltsNoSource');
    case 'no-cursor': return t('bus.voltsNoCursor');
  }
}

export class CursorVoltageProjection {
  private last: {
    store: SampleStore | null;
    key: string;
    points: readonly CursorVoltagePoint[];
  } | null = null;

  project(
    store: SampleStore | null,
    sources: readonly CursorVoltageSource[],
    request: CursorVoltageRequest,
  ): readonly CursorVoltagePoint[] {
    const key = [
      request.sample ?? 'none', request.previousWave ? 1 : 0,
      store?.length ?? -1, store?.droppedSamples ?? -1,
      store === null ? '' : store.gaps().map((gap) => `${gap.startSample}-${gap.endSample}`).join(','),
      ...sources.map((source) =>
        `${source.busId}:${source.name}:${source.color}:${source.bits.join(',')}:${source.gain}`),
    ].join('|');
    if (this.last !== null && this.last.store === store && this.last.key === key) {
      return this.last.points;
    }
    const points = projectCursorVoltages(store, sources, request);
    this.last = { store, key, points };
    return points;
  }
}
