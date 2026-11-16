// SPDX-License-Identifier: GPL-3.0-or-later

import { AnalogRunQualifier } from '../data/analogRunQualifier.js';

export const ANALOG_SCAN_MAX_CROSSINGS = 512;
export const ANALOG_NEAR_LIMIT_PERIOD_SAMPLES = 4;

export type AnalogScanStatus = 'ok' | 'no-data' | 'no-crossing' | 'one-crossing';

export interface AnalogCodeScanInput {
  codes: ArrayLike<number>;
  unknown?: ArrayLike<number>;
  samplerate: number;
  zeroCode: number;
  voltsPerCode: number;
  rising: boolean;
  level: number;
  hysteresis: number;
  window: number;
  maxCrossings?: number;
}

export type AnalogCodeScanConfig = Omit<AnalogCodeScanInput, 'codes' | 'unknown'>;

export interface AnalogCodeScan {
  analyzed: number;
  known: number;
  unknown: number;
  minCode: number;
  maxCode: number;
  vppCodes: number;
  vppVolts: number;
  minVolts: number;
  maxVolts: number;
  meanOffsetCodes: number;
  meanVolts: number;
  rmsOffsetCodes: number;
  rmsVolts: number;
  crossingCount: number;
  crossingCap: boolean;
  firstCrossing: number;
  lastCrossing: number;
  periodSamples: number;
  periodSeconds: number;
  frequencyHz: number;
  dutyPercent: number;
  dutyPeriods: number;
  dutyExcludedPeriods: number;
  dutyKnownSamples: number;
  dutyHighSamples: number;
  status: AnalogScanStatus;
  clippedLow: boolean;
  clippedHigh: boolean;
  nearSampleLimit: boolean;
}

function validate(input: AnalogCodeScanConfig): void {
  if (!Number.isFinite(input.samplerate) || input.samplerate <= 0) {
    throw new RangeError(`samplerate must be finite and positive, got ${String(input.samplerate)}`);
  }
  if (!Number.isFinite(input.zeroCode)) {
    throw new RangeError(`zeroCode must be finite, got ${String(input.zeroCode)}`);
  }
  if (!Number.isFinite(input.voltsPerCode) || input.voltsPerCode <= 0) {
    throw new RangeError(`voltsPerCode must be finite and positive, got ${String(input.voltsPerCode)}`);
  }
  if (!Number.isSafeInteger(input.level) || input.level < 0 || input.level > 255) {
    throw new RangeError(`level must be an integer in 0..255, got ${String(input.level)}`);
  }
  if (!Number.isSafeInteger(input.hysteresis) || input.hysteresis < 0) {
    throw new RangeError(`hysteresis must be a non-negative integer, got ${String(input.hysteresis)}`);
  }
  if (!Number.isSafeInteger(input.window) || input.window < 0) {
    throw new RangeError(`window must be a non-negative integer, got ${String(input.window)}`);
  }
  const maxCrossings = input.maxCrossings ?? ANALOG_SCAN_MAX_CROSSINGS;
  if (!Number.isSafeInteger(maxCrossings) || maxCrossings <= 0) {
    throw new RangeError(`maxCrossings must be a positive integer, got ${String(maxCrossings)}`);
  }
}

export class AnalogCodeScanAccumulator {
  private readonly samplerate: number;
  private readonly zeroCode: number;
  private readonly voltsPerCode: number;
  private readonly maxCrossings: number;
  private readonly clipThreshold: number;
  private readonly level: number;
  private readonly qualifier: AnalogRunQualifier;
  private readonly slotHigh: Uint8Array;
  private readonly slotUnknown: Uint8Array;
  private readonly slotClip: Float64Array;

  private index = 0;
  private known = 0;
  private minCode = Number.POSITIVE_INFINITY;
  private maxCode = Number.NEGATIVE_INFINITY;
  private sum = 0;
  private sumCompensation = 0;
  private squareSum = 0;
  private squareCompensation = 0;

  private crossingCount = 0;
  private crossingCap = false;
  private firstCrossing = -1;
  private lastCrossing = -1;

  private lowRun = 0;
  private highRun = 0;
  private clippedLow = false;
  private clippedHigh = false;

  private openHigh = 0;
  private openUnknown = 0;
  private openClip = 0;
  private periodStart = -1;
  private dutyFrozen = false;
  private dutyPeriods = 0;
  private dutyExcludedPeriods = 0;
  private dutyKnownSamples = 0;
  private dutyHighSamples = 0;

  private result: AnalogCodeScan | null = null;
  private rejected = false;

  constructor(input: AnalogCodeScanConfig) {
    validate(input);
    this.samplerate = input.samplerate;
    this.zeroCode = input.zeroCode;
    this.voltsPerCode = input.voltsPerCode;
    this.maxCrossings = input.maxCrossings ?? ANALOG_SCAN_MAX_CROSSINGS;
    this.clipThreshold = Math.max(1, input.window);
    this.level = input.level;
    const slotCount = Math.max(1, input.window);
    this.slotHigh = new Uint8Array(slotCount);
    this.slotUnknown = new Uint8Array(slotCount);
    this.slotClip = new Float64Array(slotCount);
    this.qualifier = new AnalogRunQualifier({
      rising: input.rising,
      level: input.level,
      hysteresis: input.hysteresis,
      window: input.window,
    });
  }

  push(codes: ArrayLike<number>, unknown?: ArrayLike<number>): void {
    if (this.result !== null) {
      throw new RangeError(`push after finish is not allowed (${String(this.index)} samples analyzed)`);
    }
    if (this.rejected) {
      throw new RangeError(`push after a rejected sample is not allowed (${String(this.index)} samples analyzed)`);
    }
    const length = codes.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`codes length must be a non-negative safe integer, got ${String(length)}`);
    }
    if (unknown !== undefined && unknown.length !== length) {
      throw new RangeError(
        `unknown length must equal codes length, got ${String(unknown.length)} and ${String(length)}`,
      );
    }

    const { qualifier, level, zeroCode, clipThreshold, maxCrossings } = this;
    const slotCount = this.slotHigh.length;

    for (let offset = 0; offset < length; offset += 1) {
      const i = this.index;
      this.index = i + 1;
      const slot = i % slotCount;

      if (unknown !== undefined && unknown[offset] !== 0) {
        qualifier.reset();
        this.lowRun = 0;
        this.highRun = 0;
        if (!this.dutyFrozen) {
          this.slotHigh[slot] = 0;
          this.slotUnknown[slot] = 1;
          this.slotClip[slot] = 0;
          this.openUnknown += 1;
        }
        continue;
      }

      const code = codes[offset]!;
      if (!Number.isInteger(code) || code < 0 || code > 255) {
        this.rejected = true;
        throw new RangeError(`codes[${i}] must be an integer in 0..255, got ${String(code)}`);
      }
      this.known += 1;
      if (code < this.minCode) this.minCode = code;
      if (code > this.maxCode) this.maxCode = code;

      const centered = code - zeroCode;
      let next = this.sum + centered;
      this.sumCompensation += Math.abs(this.sum) >= Math.abs(centered)
        ? (this.sum - next) + centered
        : (centered - next) + this.sum;
      this.sum = next;

      const square = centered * centered;
      next = this.squareSum + square;
      this.squareCompensation += Math.abs(this.squareSum) >= Math.abs(square)
        ? (this.squareSum - next) + square
        : (square - next) + this.squareSum;
      this.squareSum = next;

      let clipHit = 0;
      if (code === 0) {
        this.lowRun += 1;
        this.highRun = 0;
        if (this.lowRun >= clipThreshold) {
          this.clippedLow = true;
          clipHit = this.lowRun === clipThreshold ? clipThreshold : 1;
        }
      } else if (code === 255) {
        this.highRun += 1;
        this.lowRun = 0;
        if (this.highRun >= clipThreshold) {
          this.clippedHigh = true;
          clipHit = this.highRun === clipThreshold ? clipThreshold : 1;
        }
      } else {
        this.lowRun = 0;
        this.highRun = 0;
      }

      if (!this.dutyFrozen) {
        const high = code >= level ? 1 : 0;
        this.slotHigh[slot] = high;
        this.slotUnknown[slot] = 0;
        this.slotClip[slot] = clipHit;
        this.openHigh += high;
        this.openClip += clipHit;
      }

      const crossing = qualifier.step(code, i);
      if (crossing >= 0) {
        if (this.crossingCount < maxCrossings) {
          if (this.crossingCount === 0) this.firstCrossing = crossing;
          this.crossingCount += 1;
          this.lastCrossing = crossing;
          if (!this.dutyFrozen) {
            let tailHigh = 0;
            let tailUnknown = 0;
            let tailClip = 0;
            for (let j = crossing; j <= i; j += 1) {
              const tailSlot = j % slotCount;
              tailHigh += this.slotHigh[tailSlot]!;
              tailUnknown += this.slotUnknown[tailSlot]!;
              tailClip += this.slotClip[tailSlot]!;
            }
            if (this.periodStart >= 0) {
              if (this.openUnknown > tailUnknown || this.openClip > tailClip) {
                this.dutyExcludedPeriods += 1;
              } else {
                this.dutyPeriods += 1;
                this.dutyKnownSamples += crossing - this.periodStart;
                this.dutyHighSamples += this.openHigh - tailHigh;
              }
            }
            this.openHigh = tailHigh;
            this.openUnknown = tailUnknown;
            this.openClip = tailClip;
            this.periodStart = crossing;
          }
        } else {
          this.crossingCap = true;
          this.dutyFrozen = true;
        }
      }
    }
  }

  finish(): AnalogCodeScan {
    if (this.result !== null) return this.result;
    if (this.rejected) {
      throw new RangeError(`finish after a rejected sample is not allowed (${String(this.index)} samples analyzed)`);
    }

    const analyzed = this.index;
    const known = this.known;
    const unknownCount = analyzed - known;
    let status: AnalogScanStatus;
    if (known === 0) status = 'no-data';
    else if (this.crossingCount === 0) status = 'no-crossing';
    else if (this.crossingCount === 1) status = 'one-crossing';
    else status = 'ok';

    const meanOffsetCodes = known === 0 ? Number.NaN : (this.sum + this.sumCompensation) / known;
    const rmsOffsetCodes = known === 0
      ? Number.NaN
      : Math.sqrt((this.squareSum + this.squareCompensation) / known);
    const vppCodes = known === 0 ? Number.NaN : this.maxCode - this.minCode;
    const periodSamples = status === 'ok'
      ? (this.lastCrossing - this.firstCrossing) / (this.crossingCount - 1)
      : Number.NaN;
    const periodSeconds = status === 'ok' ? periodSamples / this.samplerate : Number.NaN;
    const frequencyHz = status === 'ok' ? this.samplerate / periodSamples : Number.NaN;
    const dutyPercent = this.dutyPeriods > 0
      ? (100 * this.dutyHighSamples) / this.dutyKnownSamples
      : Number.NaN;
    const nearSampleLimit = status === 'ok' && periodSamples < ANALOG_NEAR_LIMIT_PERIOD_SAMPLES;

    this.result = {
      analyzed,
      known,
      unknown: unknownCount,
      minCode: known === 0 ? Number.NaN : this.minCode,
      maxCode: known === 0 ? Number.NaN : this.maxCode,
      vppCodes,
      vppVolts: known === 0 ? Number.NaN : vppCodes * this.voltsPerCode,
      minVolts: known === 0 ? Number.NaN : (this.minCode - this.zeroCode) * this.voltsPerCode,
      maxVolts: known === 0 ? Number.NaN : (this.maxCode - this.zeroCode) * this.voltsPerCode,
      meanOffsetCodes,
      meanVolts: known === 0 ? Number.NaN : meanOffsetCodes * this.voltsPerCode,
      rmsOffsetCodes,
      rmsVolts: known === 0 ? Number.NaN : rmsOffsetCodes * this.voltsPerCode,
      crossingCount: this.crossingCount,
      crossingCap: this.crossingCap,
      firstCrossing: this.firstCrossing,
      lastCrossing: this.lastCrossing,
      periodSamples,
      periodSeconds,
      frequencyHz,
      dutyPercent,
      dutyPeriods: this.dutyPeriods,
      dutyExcludedPeriods: this.dutyExcludedPeriods,
      dutyKnownSamples: this.dutyKnownSamples,
      dutyHighSamples: this.dutyHighSamples,
      status,
      clippedLow: this.clippedLow,
      clippedHigh: this.clippedHigh,
      nearSampleLimit,
    };
    return this.result;
  }
}

export function scanAnalogCodes(input: AnalogCodeScanInput): AnalogCodeScan {
  const scan = new AnalogCodeScanAccumulator(input);
  scan.push(input.codes, input.unknown);
  return scan.finish();
}
