// SPDX-License-Identifier: GPL-3.0-or-later

import { GAP_BIT, type GapSpan, type SampleStore } from '../data/types.js';

export const MEASURE_SCAN_SAMPLES = 65536;
/**
 * The hard cap for the adaptive full-window re-read. The interactive measurements start
 * at `MEASURE_SCAN_SAMPLES`; when that prefix holds fewer than two qualified crossings
 * (a low-frequency signal whose prefix is shorter than a period), `runMeasurement`
 * re-reads the requested window up to this bound. 2^20 samples covers a 1 kHz period at
 * the 800 MS/s analog ceiling; past it the scan is still an exact prefix.
 */
export const MEASURE_SCAN_MAX_SAMPLES = 1_048_576;
export const MEASURE_READ_CHUNK = 4096;
export const MEASURE_MAX_BITS = 8;

export interface MeasureBus {
  bits: readonly number[];
  group: number;
  gain: number;
}

export interface MeasureReadRequest {
  start: number;
  end: number;
  maxSamples?: number;
  chunkSamples?: number;
}

export interface MeasureRead {
  codes: Uint8Array;
  unknown: Uint8Array;
  start: number;
  end: number;
  requestedStart: number;
  requestedEnd: number;
  analyzed: number;
  requestedSamples: number;
  availableSamples: number;
  limit: number;
  truncated: boolean;
  rangeClipped: boolean;
  unknownSamples: number;
  gapsAbsolute: GapSpan[];
  droppedSamples: number;
}

function sampleIndex(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer sample index, got ${value}`);
  }
  return value;
}

function countLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export function measureBitsProblem(
  bits: readonly number[], channelCount: number,
): string | null {
  if (bits.length < 1 || bits.length > MEASURE_MAX_BITS) {
    return `an analog group reads 1 to ${MEASURE_MAX_BITS} channels, got ${bits.length}`;
  }
  const seen = new Set<number>();
  for (const bit of bits) {
    if (!Number.isInteger(bit) || bit < 0 || bit >= channelCount) {
      return `channel ${bit} is not in D0-D${channelCount - 1}`;
    }
    if (seen.has(bit)) return `channel ${bit} is used twice`;
    seen.add(bit);
  }
  return null;
}

function checkedBits(bits: readonly number[], channelCount: number): number[] {
  const problem = measureBitsProblem(bits, channelCount);
  if (problem !== null) throw new RangeError(problem);
  return [...bits];
}

export function readMeasureSamples(
  store: SampleStore, bus: MeasureBus, request: MeasureReadRequest,
): MeasureRead {
  const requestedStart = sampleIndex('start', request.start);
  const requestedEnd = sampleIndex('end', request.end);
  if (requestedStart < 0) throw new RangeError(`start must not be negative, got ${requestedStart}`);
  if (requestedEnd < requestedStart) {
    throw new RangeError(`end ${requestedEnd} is before start ${requestedStart}`);
  }
  const bits = checkedBits(bus.bits, store.channelCount);
  const limit = countLimit('maxSamples', request.maxSamples, MEASURE_SCAN_SAMPLES);
  const chunkSamples = countLimit('chunkSamples', request.chunkSamples, MEASURE_READ_CHUNK);

  const droppedSamples = store.droppedSamples;
  const length = store.length;
  const start = Math.min(requestedStart, length);
  const clampedEnd = Math.min(requestedEnd, length);
  const availableSamples = clampedEnd - start;
  const analyzed = Math.min(availableSamples, limit);
  const end = start + analyzed;

  const codes = new Uint8Array(analyzed);
  const unknown = new Uint8Array(analyzed);

  for (let base = 0; base < analyzed; base += chunkSamples) {
    const n = Math.min(chunkSamples, analyzed - base);
    const chunkStart = start + base;
    for (let k = 0; k < bits.length; k++) {
      const view = store.query(bits[k]!, chunkStart, chunkStart + n, n);
      const low = view.low;
      const packed = view.packed;
      const weight = 1 << k;
      for (let i = 0; i < n; i++) {
        if (low[i] !== 0) codes[base + i]! += weight;
        if ((packed[i]! & GAP_BIT) !== 0) unknown[base + i] = 1;
      }
    }
  }

  let unknownSamples = 0;
  for (let i = 0; i < analyzed; i++) unknownSamples += unknown[i]!;

  const gapsAbsolute: GapSpan[] = [];
  for (const gap of store.gaps()) {
    const from = Math.max(gap.startSample, start);
    const to = Math.min(gap.endSample, end);
    if (to > from) {
      gapsAbsolute.push({ startSample: from + droppedSamples, endSample: to + droppedSamples });
    }
  }

  return {
    codes,
    unknown,
    start,
    end,
    requestedStart,
    requestedEnd,
    analyzed,
    requestedSamples: requestedEnd - requestedStart,
    availableSamples,
    limit,
    truncated: analyzed < availableSamples,
    rangeClipped: start !== requestedStart || clampedEnd !== requestedEnd,
    unknownSamples,
    gapsAbsolute,
    droppedSamples,
  };
}
