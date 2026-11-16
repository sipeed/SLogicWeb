// SPDX-License-Identifier: GPL-3.0-or-later

import {
  AnalogCodeScanAccumulator, type AnalogCodeScan, type AnalogCodeScanConfig,
} from '../dsp/analogScan.js';
import {
  measurementCacheKey,
  type MeasurementReadSummary, type MeasurementSource,
} from './measurementState.js';
import type { MeasureBus } from './measureSamples.js';

export const MEASURE_CAPTURE_CHUNK = 65536;
export const MEASURE_CAPTURE_BUDGET_MS = 8;

export type CaptureJobStatus = 'running' | 'cancelled' | 'done';

export interface CaptureJobSource {
  source: MeasurementSource;
  bus: MeasureBus;
  scan: AnalogCodeScanConfig;
}

export interface CaptureJobKeySource {
  start: number;
  group: number;
  gain: number;
  rising: boolean;
  level: number;
  hysteresis: number;
  window: number;
}

export interface CaptureJobKeyInput {
  store: object;
  storeLength: number;
  droppedSamples: number;
  samplerate: number;
  windowStart: number;
  windowEnd: number;
  sources: readonly CaptureJobKeySource[];
}

export interface CaptureJobChunk {
  codes: Uint8Array;
  unknown: Uint8Array;
}

export type CaptureJobReader =
  (source: CaptureJobSource, from: number, to: number) => CaptureJobChunk;

export interface CaptureJobResult {
  scan: AnalogCodeScan;
  read: MeasurementReadSummary;
}

export type CaptureJobResults = ReadonlyMap<number, CaptureJobResult>;

function nowMs(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf !== undefined && typeof perf.now === 'function' ? perf.now() : Date.now();
}

export function captureJobKey(input: CaptureJobKeyInput): string {
  const parts = input.sources.map((source) => `${source.start}#${measurementCacheKey({
    store: input.store,
    storeLength: input.storeLength,
    droppedSamples: input.droppedSamples,
    samplerate: input.samplerate,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    group: source.group,
    gain: source.gain,
    rising: source.rising,
    level: source.level,
    hysteresis: source.hysteresis,
    window: source.window,
  })}`);
  return parts.sort().join(';');
}

export function captureRangeUnavailable(input: {
  running: boolean; loop: boolean; storeLength: number;
}): 'loop' | 'stable-capture-required' | 'no-data' | null {
  if (input.loop) return 'loop';
  if (input.running) return 'stable-capture-required';
  if (!Number.isSafeInteger(input.storeLength) || input.storeLength <= 0) return 'no-data';
  return null;
}

function checkedBound(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

function countLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
  return value;
}

export class CaptureRangeJob {
  readonly key: string;
  readonly start: number;
  readonly end: number;

  private readonly sources: readonly CaptureJobSource[];
  private readonly chunk: number;
  private accumulators: AnalogCodeScanAccumulator[];
  private covered = 0;
  private state: CaptureJobStatus = 'running';
  private finished: Map<number, CaptureJobResult> | null = null;

  constructor(
    key: string, start: number, end: number, sources: readonly CaptureJobSource[],
    storeLength?: number, chunkSamples: number = MEASURE_CAPTURE_CHUNK,
  ) {
    const from = checkedBound('start', start);
    const to = checkedBound('end', end);
    if (to <= from) {
      throw new RangeError(`end ${to} must be after start ${from}`);
    }
    if (storeLength !== undefined && to > checkedBound('storeLength', storeLength)) {
      throw new RangeError(`end ${to} is beyond the ${String(storeLength)} retained samples`);
    }
    this.key = key;
    this.start = from;
    this.end = to;
    this.sources = sources;
    this.chunk = countLimit('chunkSamples', chunkSamples);
    this.accumulators = sources.map((source) => new AnalogCodeScanAccumulator(source.scan));
  }

  get total(): number {
    return this.end - this.start;
  }

  get scanned(): number {
    return this.covered;
  }

  get status(): CaptureJobStatus {
    return this.state;
  }

  get done(): boolean {
    return this.state === 'done';
  }

  step(read: CaptureJobReader, budgetMs: number = MEASURE_CAPTURE_BUDGET_MS): void {
    if (this.state !== 'running') return;
    if (!Number.isFinite(budgetMs) || budgetMs < 0) {
      throw new RangeError(`budgetMs must be finite and non-negative, got ${String(budgetMs)}`);
    }
    const startedAt = nowMs();
    try {
      while (this.covered < this.total) {
        const from = this.start + this.covered;
        const to = Math.min(this.end, from + this.chunk);
        const span = to - from;
        for (let index = 0; index < this.sources.length; index += 1) {
          const chunk = read(this.sources[index]!, from, to);
          if (chunk.codes.length !== span || chunk.unknown.length !== span) {
            throw new RangeError(
              `source ${String(this.sources[index]!.source.start)} returned ` +
              `${String(chunk.codes.length)}/${String(chunk.unknown.length)} samples for ${String(span)}`,
            );
          }
          this.accumulators[index]!.push(chunk.codes, chunk.unknown);
        }
        this.covered += span;
        if (nowMs() - startedAt >= budgetMs) break;
      }
    } catch (error) {
      this.cancel();
      throw error;
    }
    if (this.covered >= this.total) this.state = 'done';
  }

  cancel(): void {
    if (this.state !== 'running') return;
    this.state = 'cancelled';
    this.accumulators = [];
    this.finished = null;
  }

  results(): CaptureJobResults | null {
    if (this.state !== 'done') return null;
    if (this.finished === null) {
      const out = new Map<number, CaptureJobResult>();
      for (let index = 0; index < this.sources.length; index += 1) {
        const scan = this.accumulators[index]!.finish();
        out.set(this.sources[index]!.source.start, {
          scan,
          read: {
            analyzed: this.total,
            requestedSamples: this.total,
            truncated: false,
            rangeClipped: false,
            unknownSamples: scan.unknown,
          },
        });
      }
      this.finished = out;
    }
    return this.finished;
  }
}
