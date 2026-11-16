// SPDX-License-Identifier: GPL-3.0-or-later

import { scanAnalogCodes, type AnalogCodeScan, type AnalogCodeScanInput } from '../dsp/analogScan.js';
import type { SampleStore } from '../data/types.js';
import { CHANNEL_BANK_SIZE, analogGainOf, analogGroupCount } from './channelBanks.js';
import { readMeasureSamples, type MeasureBus, type MeasureRead } from './measureSamples.js';

export const MEASUREMENT_PARAMETERS = ['frequency', 'vpp', 'rms'] as const;
export type MeasurementParameter = (typeof MEASUREMENT_PARAMETERS)[number];
export const MEASUREMENT_MAX_ROWS: number = MEASUREMENT_PARAMETERS.length;

export type MeasurementRangeKind = 'viewport' | 'cursors';

export type MeasurementStatus =
  | 'ok'
  | 'no-source'
  | 'no-window'
  | 'no-data'
  | 'no-crossing'
  | 'one-crossing'
  | 'previous-wave-displayed';

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
  source: number | null;
  range: MeasurementRange;
  rows: MeasurementParameter[];
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

export interface MeasurementRowView {
  parameter: MeasurementParameter;
  value: number;
  unit: 'hz' | 'v';
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
}

export interface MeasurementSectionView {
  sources: MeasurementSource[];
  source: number | null;
  range: MeasurementRange;
  cursors: { id: number; label: string; color: string }[];
  rows: MeasurementRowView[];
  availableParameters: MeasurementParameter[];
  window: MeasurementWindow | null;
  unavailable: MeasurementStatus | null;
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

function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function catalogRows(parameters: readonly MeasurementParameter[]): MeasurementParameter[] {
  const rows: MeasurementParameter[] = [];
  for (const parameter of MEASUREMENT_PARAMETERS) {
    if (parameters.includes(parameter)) rows.push(parameter);
  }
  return rows;
}

function sameRows(a: readonly MeasurementParameter[], b: readonly MeasurementParameter[]): boolean {
  return a.length === b.length && a.every((parameter, index) => parameter === b[index]);
}

function normalizeRange(range: MeasurementRange): MeasurementRange {
  const kind: MeasurementRangeKind = range.kind === 'cursors' ? 'cursors' : 'viewport';
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
  const first = sources[0];
  return {
    source: first === undefined ? null : first.group,
    range: { kind: 'viewport', a: null, b: null },
    rows: [...MEASUREMENT_PARAMETERS],
  };
}

export function reconcileMeasurementConfig(
  config: MeasurementConfig, sources: readonly MeasurementSource[],
): MeasurementConfig {
  const source = config.source === null ||
    sources.some((candidate) => candidate.group === config.source)
    ? config.source : null;
  const rows = catalogRows(config.rows);
  const rowsSame = sameRows(rows, config.rows);
  const range = normalizeRange(config.range);
  if (source === config.source && rowsSame && range === config.range) return config;
  return { source, range, rows: rowsSame ? config.rows : rows };
}

export function selectMeasurementSource(
  config: MeasurementConfig, sources: readonly MeasurementSource[], group: number | null,
): MeasurementConfig {
  if (group === null) return config.source === null ? config : { ...config, source: null };
  if (!sources.some((candidate) => candidate.group === group)) return config;
  return config.source === group ? config : { ...config, source: group };
}

export function selectMeasurementRange(
  config: MeasurementConfig, range: MeasurementRange,
): MeasurementConfig {
  const next = normalizeRange(range);
  return sameRange(next, config.range) ? config : { ...config, range: next };
}

export function addMeasurementRow(
  config: MeasurementConfig, parameter: MeasurementParameter,
): MeasurementConfig {
  if (config.rows.includes(parameter) || config.rows.length >= MEASUREMENT_MAX_ROWS) return config;
  const rows = catalogRows([...config.rows, parameter]);
  return sameRows(rows, config.rows) ? config : { ...config, rows };
}

export function removeMeasurementRow(
  config: MeasurementConfig, parameter: MeasurementParameter,
): MeasurementConfig {
  if (!config.rows.includes(parameter)) return config;
  return { ...config, rows: config.rows.filter((candidate) => candidate !== parameter) };
}

export function resolveMeasurementWindow(
  config: MeasurementConfig, cursors: readonly MeasurementCursor[], viewport: MeasurementWindow,
): MeasurementWindow | null {
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

export function measurementRowViews(
  parameters: readonly MeasurementParameter[],
  scan: AnalogCodeScan | null,
  read: MeasurementReadSummary | null,
  unavailable: MeasurementStatus | null,
): MeasurementRowView[] {
  return parameters.map((parameter): MeasurementRowView => {
    const unit = parameter === 'frequency' ? 'hz' : 'v';
    if (unavailable !== null || scan === null || read === null) {
      return {
        parameter,
        value: Number.NaN,
        unit,
        status: unavailable ?? 'no-data',
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
      };
    }
    const amplitude: MeasurementStatus = scan.status === 'no-data' ? 'no-data' : 'ok';
    return {
      parameter,
      value: parameter === 'frequency'
        ? scan.frequencyHz : parameter === 'vpp' ? scan.vppVolts : scan.rmsVolts,
      unit,
      status: parameter === 'frequency' ? scan.status : amplitude,
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
    };
  });
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
