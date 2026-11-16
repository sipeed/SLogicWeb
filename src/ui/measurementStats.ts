// SPDX-License-Identifier: GPL-3.0-or-later

import {
  acquisitionWaveCompleted, acquisitionWaveKey, type AcquisitionWaveFacts,
} from './acquisitionWave.js';
import type { CaptureStopReason } from './captureViewport.js';
import { isMeasurementParameter, type MeasurementParameter } from './measurementCatalog.js';
import type { MeasurementRangeKind } from './measurementState.js';

export const MEASUREMENT_STATS_CAP = 512;

export interface MeasurementStatsKeyInput {
  sessionId: number;
  source: number;
  parameter: MeasurementParameter;
  rangeKind: MeasurementRangeKind;
  cursorA: number | null;
  cursorB: number | null;
  gain: number;
  level: number;
  rising: boolean;
  hysteresis: number;
  artifactWindow: number;
  samplerate: number;
}

const RANGE_KINDS: readonly MeasurementRangeKind[] = ['viewport', 'cursors', 'capture'];

function indexText(field: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `measurement statistics key ${field} must be a non-negative safe integer: ${value}`);
  }
  return String(value);
}

function numberText(field: string, value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`measurement statistics key ${field} must be finite: ${value}`);
  }
  if (Object.is(value, -0)) return '-0';
  if (Number.isSafeInteger(value)) return String(value);
  return value.toExponential(20);
}

function cursorText(field: string, value: number | null): string {
  return value === null ? '-' : numberText(field, value);
}

export function measurementStatsKey(input: MeasurementStatsKeyInput): string {
  if (!isMeasurementParameter(input.parameter)) {
    throw new RangeError(`unknown measurement parameter: ${String(input.parameter)}`);
  }
  if (!RANGE_KINDS.includes(input.rangeKind)) {
    throw new RangeError(`unknown measurement range kind: ${String(input.rangeKind)}`);
  }
  const cursors = input.rangeKind === 'cursors';
  return [
    indexText('sessionId', input.sessionId),
    indexText('source', input.source),
    input.parameter,
    input.rangeKind,
    cursors ? cursorText('cursorA', input.cursorA) : '-',
    cursors ? cursorText('cursorB', input.cursorB) : '-',
    numberText('gain', input.gain),
    numberText('level', input.level),
    input.rising ? 'rising' : 'falling',
    numberText('hysteresis', input.hysteresis),
    numberText('artifactWindow', input.artifactWindow),
    numberText('samplerate', input.samplerate),
  ].join('|');
}

export interface MeasurementAccumulator {
  key: string;
  count: number;
  mean: number;
  m2: number;
  min: number;
  max: number;
  excluded: number;
  capped: boolean;
}

export interface MeasurementStatsState {
  readonly accumulators: ReadonlyMap<number, MeasurementAccumulator>;
  readonly skipped: number;
  readonly lastWaveKey: string | null;
}

export function emptyMeasurementStats(): MeasurementStatsState {
  return { accumulators: new Map(), skipped: 0, lastWaveKey: null };
}

export function emptyAccumulator(key: string): MeasurementAccumulator {
  return {
    key, count: 0, mean: 0, m2: 0, min: Number.NaN, max: Number.NaN, excluded: 0, capped: false,
  };
}

export function accumulateSample(
  acc: MeasurementAccumulator, value: number,
): MeasurementAccumulator {
  if (!Number.isFinite(value)) {
    throw new RangeError(`measurement sample must be finite: ${value}`);
  }
  if (acc.count >= MEASUREMENT_STATS_CAP) {
    return acc.capped ? acc : { ...acc, capped: true };
  }
  const count = acc.count + 1;
  const delta = value - acc.mean;
  const mean = acc.mean + delta / count;
  return {
    key: acc.key,
    count,
    mean,
    m2: acc.m2 + delta * (value - mean),
    min: Number.isNaN(acc.min) ? value : Math.min(acc.min, value),
    max: Number.isNaN(acc.max) ? value : Math.max(acc.max, value),
    excluded: acc.excluded,
    capped: false,
  };
}

export function excludeSample(acc: MeasurementAccumulator): MeasurementAccumulator {
  return {
    key: acc.key,
    count: acc.count,
    mean: acc.mean,
    m2: acc.m2,
    min: acc.min,
    max: acc.max,
    excluded: acc.excluded + 1,
    capped: acc.capped,
  };
}

export interface MeasurementStatsSummary {
  count: number;
  mean: number;
  min: number;
  max: number;
  stdDev: number | null;
  excluded: number;
  capped: boolean;
}

export function measurementStatsSummary(acc: MeasurementAccumulator): MeasurementStatsSummary {
  return {
    count: acc.count,
    mean: acc.count === 0 ? Number.NaN : acc.mean,
    min: acc.min,
    max: acc.max,
    stdDev: acc.count >= 2 ? Math.sqrt(acc.m2 / (acc.count - 1)) : null,
    excluded: acc.excluded,
    capped: acc.capped,
  };
}

export type MeasurementStatsView = MeasurementStatsSummary;

export function noMeasurementStatsView(): MeasurementStatsView {
  return {
    count: 0,
    mean: Number.NaN,
    min: Number.NaN,
    max: Number.NaN,
    stdDev: null,
    excluded: 0,
    capped: false,
  };
}

export function measurementStatsView(
  state: MeasurementStatsState, rowId: number, key: string,
): MeasurementStatsView {
  const acc = state.accumulators.get(rowId);
  if (acc === undefined || acc.key !== key) return noMeasurementStatsView();
  return measurementStatsSummary(acc);
}

export function resetMeasurementStatsFor(
  state: MeasurementStatsState, rowId: number,
): MeasurementStatsState {
  if (!state.accumulators.has(rowId)) return state;
  const accumulators = new Map(state.accumulators);
  accumulators.delete(rowId);
  return { accumulators, skipped: state.skipped, lastWaveKey: state.lastWaveKey };
}

export function resetAllMeasurementStats(state: MeasurementStatsState): MeasurementStatsState {
  if (state.accumulators.size === 0 && state.skipped === 0) return state;
  return { accumulators: new Map(), skipped: 0, lastWaveKey: state.lastWaveKey };
}

export function retainMeasurementStats(
  state: MeasurementStatsState, rowIds: readonly number[],
): MeasurementStatsState {
  if (state.accumulators.size === 0) return state;
  const live = new Set(rowIds);
  const dropped = [...state.accumulators.keys()].filter((rowId) => !live.has(rowId));
  if (dropped.length === 0) return state;
  const accumulators = new Map(state.accumulators);
  for (const rowId of dropped) accumulators.delete(rowId);
  return { accumulators, skipped: state.skipped, lastWaveKey: state.lastWaveKey };
}

export interface MeasurementWaveRow {
  rowId: number;
  key: string;
  value: number | null;
}

export interface MeasurementWaveSubmission {
  sessionId: number;
  generation: number;
  loop: boolean;
  reason: CaptureStopReason;
  samples: number;
  missed: boolean;
  visible: boolean;
  rows: readonly MeasurementWaveRow[];
}

export interface MeasurementWaveResult {
  state: MeasurementStatsState;
  submitted: number;
  skipped: number;
  duplicate: boolean;
}

export function submitMeasurementWave(
  state: MeasurementStatsState, submission: MeasurementWaveSubmission,
): MeasurementWaveResult {
  const facts: AcquisitionWaveFacts = {
    reason: submission.reason,
    loop: submission.loop,
    samples: submission.samples,
    missed: submission.missed,
  };
  if (!acquisitionWaveCompleted(facts)) {
    return { state, submitted: 0, skipped: 0, duplicate: false };
  }
  const waveKey = acquisitionWaveKey(submission.sessionId, submission.generation);
  if (waveKey === state.lastWaveKey) {
    return { state, submitted: 0, skipped: 0, duplicate: true };
  }
  if (!submission.visible) {
    return {
      state: { accumulators: state.accumulators, skipped: state.skipped + 1, lastWaveKey: waveKey },
      submitted: 0,
      skipped: 1,
      duplicate: false,
    };
  }
  const accumulators = new Map(state.accumulators);
  const seen = new Set<number>();
  let submitted = 0;
  for (const row of submission.rows) {
    if (!Number.isSafeInteger(row.rowId) || row.rowId < 0) {
      throw new RangeError(
        `measurement row id must be a non-negative safe integer: ${row.rowId}`);
    }
    if (seen.has(row.rowId)) {
      throw new RangeError(`measurement row id offered twice in one wave: ${row.rowId}`);
    }
    seen.add(row.rowId);
    const current = accumulators.get(row.rowId);
    const base = current !== undefined && current.key === row.key
      ? current
      : emptyAccumulator(row.key);
    if (row.value === null || !Number.isFinite(row.value)) {
      accumulators.set(row.rowId, excludeSample(base));
      continue;
    }
    accumulators.set(row.rowId, accumulateSample(base, row.value));
    submitted += 1;
  }
  return {
    state: { accumulators, skipped: state.skipped, lastWaveKey: waveKey },
    submitted,
    skipped: 0,
    duplicate: false,
  };
}
