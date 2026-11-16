// SPDX-License-Identifier: GPL-3.0-or-later

import { scanAnalogCodes, type AnalogCodeScan, type AnalogCodeScanInput } from '../dsp/analogScan.js';
import type { SampleStore } from '../data/types.js';
import { CHANNEL_BANK_SIZE, analogGainOf, analogGroupCount } from './channelBanks.js';
import {
  MEASUREMENT_DEFAULT_PARAMETERS, measurementUnit,
  type MeasurementParameter, type MeasurementUnit,
} from './measurementCatalog.js';
import {
  addMeasurementRow, availableMeasurementParameters, emptyMeasurementRows, pruneMeasurementRows,
  setMeasurementFilter, type MeasurementRow, type MeasurementRowState,
} from './measurementRows.js';
import { readMeasureSamples, type MeasureBus, type MeasureRead } from './measureSamples.js';
import { noMeasurementStatsView, type MeasurementStatsView } from './measurementStats.js';
import type { FftSectionView } from './fftView.js';

export type MeasurementRangeKind = 'viewport' | 'cursors' | 'capture';

export type MeasurementStatus =
  | 'ok'
  | 'no-source'
  | 'no-window'
  | 'no-data'
  | 'no-crossing'
  | 'one-crossing'
  | 'no-period'
  | 'previous-wave-displayed'
  | 'analyzing'
  | 'cancelled'
  | 'stable-capture-required'
  | 'loop'
  | 'paused';

export interface MeasurementSource {
  group: number;
  start: number;
  gain: number;
  name: string;
}

export interface MeasurementBusView {
  name: string;
  analogGroup?: number;
  analogGain?: number;
  spec: { bits: readonly number[] };
}

export interface MeasurementRange {
  kind: MeasurementRangeKind;
  a: number | null;
  b: number | null;
}

export interface MeasurementConfig {
  range: MeasurementRange;
  rows: MeasurementRowState;
}

export interface MeasurementWindow {
  start: number;
  end: number;
}

export interface MeasurementCursor {
  id: number;
  sample: number;
}

export interface MeasurementReadSummary {
  analyzed: number;
  requestedSamples: number;
  truncated: boolean;
  rangeClipped: boolean;
  unknownSamples: number;
}

export interface MeasurementSourceResult {
  source: MeasurementSource;
  scan: AnalogCodeScan | null;
  read: MeasurementReadSummary | null;
  unavailable?: MeasurementStatus | null;
}

export type MeasurementResultMap = ReadonlyMap<number, MeasurementSourceResult>;

export interface MeasurementRowView {
  id: number;
  start: number;
  sourceName: string;
  parameter: MeasurementParameter;
  unit: MeasurementUnit;
  value: number;
  status: MeasurementStatus;
  analyzedSamples: number;
  requestedSamples: number;
  truncated: boolean;
  rangeClipped: boolean;
  gaps: boolean;
  clippedLow: boolean;
  clippedHigh: boolean;
  nearSampleLimit: boolean;
  crossingCap: boolean;
  crossingCount: number;
  dutyPeriods: number;
  dutyExcludedPeriods: number;
  stats: MeasurementStatsView;
}

export interface MeasurementCaptureView {
  status: 'running' | 'cancelled' | 'done';
  scanned: number;
  total: number;
  droppedSamples: number;
}

export interface MeasurementSectionView {
  sources: MeasurementSource[];
  filter: number | null;
  range: MeasurementRange;
  cursors: { id: number; label: string; color: string }[];
  rows: MeasurementRowView[];
  allRows: readonly MeasurementRow[];
  rowCount: number;
  undoCount: number | null;
  addStart: number | null;
  window: MeasurementWindow | null;
  unavailable: MeasurementStatus | null;
  capture: MeasurementCaptureView | null;
  fft?: FftSectionView;
  statsSkipped: number;
  statsLoopUnavailable: boolean;
}

export interface MeasurementCacheInput {
  store: object;
  storeLength: number;
  droppedSamples: number;
  samplerate: number;
  windowStart: number;
  windowEnd: number;
  group: number;
  gain: number;
  rising: boolean;
  level: number;
  hysteresis: number;
  window: number;
}

export interface MeasurementRunInput {
  store: SampleStore;
  bus: MeasureBus;
  window: MeasurementWindow;
  scan: Omit<AnalogCodeScanInput, 'codes' | 'unknown'>;
  maxSamples?: number;
}

const ROW_VALUES: Record<MeasurementParameter, (scan: AnalogCodeScan) => number> = {
  vpp: (scan) => scan.vppVolts,
  max: (scan) => scan.maxVolts,
  min: (scan) => scan.minVolts,
  mean: (scan) => scan.meanVolts,
  rms: (scan) => scan.rmsVolts,
  frequency: (scan) => scan.frequencyHz,
  period: (scan) => scan.periodSeconds,
  duty: (scan) => scan.dutyPercent,
};

const ROW_STATUS: Record<MeasurementParameter, (scan: AnalogCodeScan) => MeasurementStatus> = {
  vpp: (scan) => (scan.status === 'no-data' ? 'no-data' : 'ok'),
  max: (scan) => (scan.status === 'no-data' ? 'no-data' : 'ok'),
  min: (scan) => (scan.status === 'no-data' ? 'no-data' : 'ok'),
  mean: (scan) => (scan.status === 'no-data' ? 'no-data' : 'ok'),
  rms: (scan) => (scan.status === 'no-data' ? 'no-data' : 'ok'),
  frequency: (scan) => scan.status,
  period: (scan) => scan.status,
  duty: (scan) => {
    if (scan.status !== 'ok') return scan.status;
    return scan.dutyPeriods > 0 ? 'ok' : 'no-period';
  },
};

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function measurementRangeKind(value: string): MeasurementRangeKind {
  return value === 'cursors' ? 'cursors' : value === 'capture' ? 'capture' : 'viewport';
}

function normalizeRange(range: MeasurementRange): MeasurementRange {
  const kind = measurementRangeKind(range.kind);
  const a = finiteOrNull(range.a);
  const b = finiteOrNull(range.b);
  if (kind === range.kind && a === range.a && b === range.b) return range;
  return { kind, a, b };
}

function sameRange(a: MeasurementRange, b: MeasurementRange): boolean {
  return a.kind === b.kind && a.a === b.a && a.b === b.b;
}

const storeIdentities = new WeakMap<object, number>();
let nextStoreIdentity = 1;

function storeIdentity(store: object): number {
  const known = storeIdentities.get(store);
  if (known !== undefined) return known;
  const identity = nextStoreIdentity;
  nextStoreIdentity += 1;
  storeIdentities.set(store, identity);
  return identity;
}

export function isMeasurementBank(bus: MeasurementBusView, channelCount: number): boolean {
  const group = bus.analogGroup;
  if (group === undefined || !Number.isInteger(group)) return false;
  if (group < 0 || group >= analogGroupCount(channelCount)) return false;
  const bits = bus.spec.bits;
  if (bits.length !== CHANNEL_BANK_SIZE) return false;
  const start = group * CHANNEL_BANK_SIZE;
  for (let k = 0; k < CHANNEL_BANK_SIZE; k += 1) {
    if (bits[k] !== start + CHANNEL_BANK_SIZE - 1 - k) return false;
  }
  return true;
}

export function measurementSources(
  buses: readonly MeasurementBusView[], channelCount: number,
): MeasurementSource[] {
  const groups = new Set<number>();
  const sources: MeasurementSource[] = [];
  for (const bus of buses) {
    const group = bus.analogGroup;
    if (group === undefined || groups.has(group)) continue;
    if (!isMeasurementBank(bus, channelCount)) continue;
    groups.add(group);
    sources.push({
      group,
      start: group * CHANNEL_BANK_SIZE,
      gain: analogGainOf(bus),
      name: bus.name,
    });
  }
  return sources.sort((a, b) => a.group - b.group);
}

export function defaultMeasurementConfig(sources: readonly MeasurementSource[]): MeasurementConfig {
  let first: MeasurementSource | null = null;
  for (const source of sources) {
    if (first === null || source.start < first.start) first = source;
  }
  let rows = emptyMeasurementRows();
  if (first !== null) {
    for (const parameter of MEASUREMENT_DEFAULT_PARAMETERS) {
      rows = addMeasurementRow(rows, first.start, parameter);
    }
  }
  return { range: { kind: 'viewport', a: null, b: null }, rows };
}

export function reconcileMeasurementConfig(
  config: MeasurementConfig, sources: readonly MeasurementSource[],
): MeasurementConfig {
  const rows = pruneMeasurementRows(config.rows, sources.map((source) => source.start));
  const range = normalizeRange(config.range);
  if (rows === config.rows && range === config.range) return config;
  return { range, rows };
}

export function selectMeasurementFilter(
  config: MeasurementConfig, sources: readonly MeasurementSource[], start: number | null,
): MeasurementConfig {
  const target = start !== null && !sources.some((source) => source.start === start)
    ? null : start;
  const rows = setMeasurementFilter(config.rows, target);
  return rows === config.rows ? config : { ...config, rows };
}

export function selectMeasurementRange(
  config: MeasurementConfig, range: MeasurementRange,
): MeasurementConfig {
  const next = normalizeRange(range);
  return sameRange(next, config.range) ? config : { ...config, range: next };
}

export function measurementSectionCounts(
  state: MeasurementRowState,
): { rowCount: number; undoCount: number | null } {
  return {
    rowCount: state.rows.length,
    undoCount: state.undo === null ? null : state.undo.rows.length,
  };
}

export function measurementAddStart(
  sources: readonly MeasurementSource[], state: MeasurementRowState,
): number | null {
  if (state.filter !== null) return state.filter;
  const starts = sources.map((source) => source.start).sort((a, b) => a - b);
  for (const start of starts) {
    if (availableMeasurementParameters(state, start).length > 0) return start;
  }
  return starts[0] ?? null;
}

export function resolveMeasurementWindow(
  config: MeasurementConfig, cursors: readonly MeasurementCursor[], viewport: MeasurementWindow,
  retainedSamples = 0,
): MeasurementWindow | null {
  if (config.range.kind === 'capture') {
    return Number.isSafeInteger(retainedSamples) && retainedSamples > 0
      ? { start: 0, end: retainedSamples } : null;
  }
  if (config.range.kind !== 'cursors') {
    if (!Number.isFinite(viewport.start) || !Number.isFinite(viewport.end)) return null;
    const start = Math.floor(viewport.start);
    const end = Math.ceil(viewport.end);
    return end > start ? { start, end } : null;
  }
  const a = config.range.a;
  const b = config.range.b;
  if (a === null || b === null || a === b) return null;
  const first = cursors.find((cursor) => cursor.id === a);
  const second = cursors.find((cursor) => cursor.id === b);
  if (first === undefined || second === undefined) return null;
  if (!Number.isInteger(first.sample) || !Number.isInteger(second.sample)) return null;
  const start = Math.min(first.sample, second.sample);
  const end = Math.max(first.sample, second.sample);
  return end > start ? { start, end } : null;
}

export function measurementCacheKey(input: MeasurementCacheInput): string {
  return [
    storeIdentity(input.store), input.storeLength, input.droppedSamples, input.samplerate,
    input.windowStart, input.windowEnd, input.group, input.gain,
    input.rising ? 'rising' : 'falling',
    input.level, input.hysteresis, input.window,
  ].join('|');
}

function blankRow(
  row: MeasurementRow, status: MeasurementStatus, stats: MeasurementStatsView,
): MeasurementRowView {
  return {
    id: row.id,
    start: row.start,
    sourceName: '',
    parameter: row.parameter,
    unit: measurementUnit(row.parameter),
    value: Number.NaN,
    status,
    analyzedSamples: 0,
    requestedSamples: 0,
    truncated: false,
    rangeClipped: false,
    gaps: false,
    clippedLow: false,
    clippedHigh: false,
    nearSampleLimit: false,
    crossingCap: false,
    crossingCount: 0,
    dutyPeriods: 0,
    dutyExcludedPeriods: 0,
    stats,
  };
}

export function measurementRowViews(
  rows: readonly MeasurementRow[],
  results: MeasurementResultMap,
  sectionUnavailable: MeasurementStatus | null,
  stats: ReadonlyMap<number, MeasurementStatsView> = new Map(),
): MeasurementRowView[] {
  const statsOf = (id: number): MeasurementStatsView =>
    stats.get(id) ?? noMeasurementStatsView();
  return rows.map((row): MeasurementRowView => {
    if (sectionUnavailable !== null) {
      return blankRow(row, sectionUnavailable, statsOf(row.id));
    }
    const result = results.get(row.start);
    if (result === undefined) return blankRow(row, 'no-source', statsOf(row.id));
    const source = result.source;
    const scan = result.scan;
    const read = result.read;
    if (scan === null || read === null) {
      return {
        ...blankRow(row, result.unavailable ?? 'no-data', statsOf(row.id)),
        sourceName: source.name,
      };
    }
    return {
      id: row.id,
      start: row.start,
      sourceName: source.name,
      parameter: row.parameter,
      unit: measurementUnit(row.parameter),
      value: ROW_VALUES[row.parameter](scan),
      status: ROW_STATUS[row.parameter](scan),
      analyzedSamples: read.analyzed,
      requestedSamples: read.requestedSamples,
      truncated: read.truncated,
      rangeClipped: read.rangeClipped,
      gaps: read.unknownSamples > 0,
      clippedLow: scan.clippedLow,
      clippedHigh: scan.clippedHigh,
      nearSampleLimit: scan.nearSampleLimit,
      crossingCap: scan.crossingCap,
      crossingCount: scan.crossingCount,
      dutyPeriods: scan.dutyPeriods,
      dutyExcludedPeriods: scan.dutyExcludedPeriods,
      stats: statsOf(row.id),
    };
  });
}

export function measurementRowEligible(row: MeasurementRowView): boolean {
  return row.status === 'ok' && Number.isFinite(row.value) &&
    !row.truncated && !row.rangeClipped && !row.gaps && !row.clippedLow && !row.clippedHigh;
}

export function measurementWaveValue(row: MeasurementRowView): number | null {
  return measurementRowEligible(row) ? row.value : null;
}

const SETTLED_ROW_STATUSES: readonly MeasurementStatus[] = [
  'ok', 'no-data', 'no-crossing', 'one-crossing', 'no-period',
];

export function measurementRowSettled(row: MeasurementRowView): boolean {
  return SETTLED_ROW_STATUSES.includes(row.status);
}

export function runMeasurement(input: MeasurementRunInput): {
  read: MeasureRead;
  scan: AnalogCodeScan | null;
} {
  const read = readMeasureSamples(input.store, input.bus, {
    start: input.window.start,
    end: input.window.end,
    ...(input.maxSamples === undefined ? {} : { maxSamples: input.maxSamples }),
  });
  const scan = read.analyzed === 0
    ? null
    : scanAnalogCodes({ ...input.scan, codes: read.codes, unknown: read.unknown });
  return { read, scan };
}
