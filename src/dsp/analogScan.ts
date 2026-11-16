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

function validate(input: AnalogCodeScanInput): void {
  const codes = input.codes;
  const unknown = input.unknown;
  if (!Number.isSafeInteger(codes.length) || codes.length < 0) {
    throw new RangeError(`codes length must be a non-negative safe integer, got ${String(codes.length)}`);
  }
  if (unknown !== undefined && unknown.length !== codes.length) {
    throw new RangeError(
      `unknown length must equal codes length, got ${String(unknown.length)} and ${String(codes.length)}`,
    );
  }
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

export function scanAnalogCodes(input: AnalogCodeScanInput): AnalogCodeScan {
  validate(input);
  const codes = input.codes;
  const unknown = input.unknown;
  const zeroCode = input.zeroCode;
  const voltsPerCode = input.voltsPerCode;
  const maxCrossings = input.maxCrossings ?? ANALOG_SCAN_MAX_CROSSINGS;
  const clipThreshold = Math.max(1, input.window);
  const level = input.level;
  const slotCount = Math.max(1, input.window);
  const slotHigh = new Uint8Array(slotCount);
  const slotUnknown = new Uint8Array(slotCount);
  const slotClip = new Float64Array(slotCount);
  const qualifier = new AnalogRunQualifier({
    rising: input.rising,
    level: input.level,
    hysteresis: input.hysteresis,
    window: input.window,
  });

  const analyzed = codes.length;
  let known = 0;
  let minCode = Number.POSITIVE_INFINITY;
  let maxCode = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let sumCompensation = 0;
  let squareSum = 0;
  let squareCompensation = 0;

  let crossingCount = 0;
  let crossingCap = false;
  let firstCrossing = -1;
  let lastCrossing = -1;

  let lowRun = 0;
  let highRun = 0;
  let clippedLow = false;
  let clippedHigh = false;

  let openHigh = 0;
  let openUnknown = 0;
  let openClip = 0;
  let periodStart = -1;
  let dutyFrozen = false;
  let dutyPeriods = 0;
  let dutyExcludedPeriods = 0;
  let dutyKnownSamples = 0;
  let dutyHighSamples = 0;

  for (let i = 0; i < analyzed; i += 1) {
    const slot = i % slotCount;
    if (unknown !== undefined && unknown[i] !== 0) {
      qualifier.reset();
      lowRun = 0;
      highRun = 0;
      if (!dutyFrozen) {
        slotHigh[slot] = 0;
        slotUnknown[slot] = 1;
        slotClip[slot] = 0;
        openUnknown += 1;
      }
      continue;
    }

    const code = codes[i]!;
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw new RangeError(`codes[${i}] must be an integer in 0..255, got ${String(code)}`);
    }
    known += 1;
    if (code < minCode) minCode = code;
    if (code > maxCode) maxCode = code;

    const centered = code - zeroCode;
    let next = sum + centered;
    sumCompensation += Math.abs(sum) >= Math.abs(centered)
      ? (sum - next) + centered
      : (centered - next) + sum;
    sum = next;

    const square = centered * centered;
    next = squareSum + square;
    squareCompensation += Math.abs(squareSum) >= Math.abs(square)
      ? (squareSum - next) + square
      : (square - next) + squareSum;
    squareSum = next;

    let clipHit = 0;
    if (code === 0) {
      lowRun += 1;
      highRun = 0;
      if (lowRun >= clipThreshold) {
        clippedLow = true;
        clipHit = lowRun === clipThreshold ? clipThreshold : 1;
      }
    } else if (code === 255) {
      highRun += 1;
      lowRun = 0;
      if (highRun >= clipThreshold) {
        clippedHigh = true;
        clipHit = highRun === clipThreshold ? clipThreshold : 1;
      }
    } else {
      lowRun = 0;
      highRun = 0;
    }

    if (!dutyFrozen) {
      const high = code >= level ? 1 : 0;
      slotHigh[slot] = high;
      slotUnknown[slot] = 0;
      slotClip[slot] = clipHit;
      openHigh += high;
      openClip += clipHit;
    }

    const crossing = qualifier.step(code, i);
    if (crossing >= 0) {
      if (crossingCount < maxCrossings) {
        if (crossingCount === 0) firstCrossing = crossing;
        crossingCount += 1;
        lastCrossing = crossing;
        if (!dutyFrozen) {
          let tailHigh = 0;
          let tailUnknown = 0;
          let tailClip = 0;
          for (let j = crossing; j <= i; j += 1) {
            const tailSlot = j % slotCount;
            tailHigh += slotHigh[tailSlot]!;
            tailUnknown += slotUnknown[tailSlot]!;
            tailClip += slotClip[tailSlot]!;
          }
          if (periodStart >= 0) {
            if (openUnknown > tailUnknown || openClip > tailClip) {
              dutyExcludedPeriods += 1;
            } else {
              dutyPeriods += 1;
              dutyKnownSamples += crossing - periodStart;
              dutyHighSamples += openHigh - tailHigh;
            }
          }
          openHigh = tailHigh;
          openUnknown = tailUnknown;
          openClip = tailClip;
          periodStart = crossing;
        }
      } else {
        crossingCap = true;
        dutyFrozen = true;
      }
    }
  }

  const unknownCount = analyzed - known;
  let status: AnalogScanStatus;
  if (known === 0) status = 'no-data';
  else if (crossingCount === 0) status = 'no-crossing';
  else if (crossingCount === 1) status = 'one-crossing';
  else status = 'ok';

  const meanOffsetCodes = known === 0 ? Number.NaN : (sum + sumCompensation) / known;
  const rmsOffsetCodes = known === 0 ? Number.NaN : Math.sqrt((squareSum + squareCompensation) / known);
  const vppCodes = known === 0 ? Number.NaN : maxCode - minCode;
  const periodSamples = status === 'ok'
    ? (lastCrossing - firstCrossing) / (crossingCount - 1)
    : Number.NaN;
  const periodSeconds = status === 'ok' ? periodSamples / input.samplerate : Number.NaN;
  const frequencyHz = status === 'ok' ? input.samplerate / periodSamples : Number.NaN;
  const dutyPercent = dutyPeriods > 0 ? (100 * dutyHighSamples) / dutyKnownSamples : Number.NaN;
  const nearSampleLimit = status === 'ok' && periodSamples < ANALOG_NEAR_LIMIT_PERIOD_SAMPLES;

  return {
    analyzed,
    known,
    unknown: unknownCount,
    minCode: known === 0 ? Number.NaN : minCode,
    maxCode: known === 0 ? Number.NaN : maxCode,
    vppCodes,
    vppVolts: known === 0 ? Number.NaN : vppCodes * voltsPerCode,
    minVolts: known === 0 ? Number.NaN : (minCode - zeroCode) * voltsPerCode,
    maxVolts: known === 0 ? Number.NaN : (maxCode - zeroCode) * voltsPerCode,
    meanOffsetCodes,
    meanVolts: known === 0 ? Number.NaN : meanOffsetCodes * voltsPerCode,
    rmsOffsetCodes,
    rmsVolts: known === 0 ? Number.NaN : rmsOffsetCodes * voltsPerCode,
    crossingCount,
    crossingCap,
    firstCrossing,
    lastCrossing,
    periodSamples,
    periodSeconds,
    frequencyHz,
    dutyPercent,
    dutyPeriods,
    dutyExcludedPeriods,
    dutyKnownSamples,
    dutyHighSamples,
    status,
    clippedLow,
    clippedHigh,
    nearSampleLimit,
  };
}
