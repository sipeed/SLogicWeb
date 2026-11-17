// SPDX-License-Identifier: GPL-3.0-or-later
/** 512-sample repeating byte tile of the host-generated software test signal. */

import { bytesPerSampleForChannels, isChannelCount, type ChannelCount } from '../types.js';
import { reverseAdcByte } from '../data/softwareTrigger.js';

export const SOFTWARE_TEST_ZERO_CODE = 128;
export const SOFTWARE_TEST_AMPLITUDE_CODES = 96;
export const SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES = 256;
export const SOFTWARE_TEST_TILE_SAMPLES = 512;

const MAX_ANALOG_GROUPS = 4;

export interface SoftwareTestPatternConfig {
  channels: ChannelCount;
  analogGroups: number;
  zeroCode?: number;
  amplitudeCodes?: number;
}

export function softwareTestSignalHz(samplerate: number): number {
  return signalHz(samplerate, SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES);
}

export function softwareTestHalfSignalHz(samplerate: number): number {
  return signalHz(samplerate, SOFTWARE_TEST_TILE_SAMPLES);
}

export class SoftwareTestPattern {
  readonly channels: ChannelCount;
  readonly bytesPerSample: number;
  readonly analogGroups: number;
  readonly tile: Uint8Array;

  constructor(config: SoftwareTestPatternConfig) {
    const channels = config.channels;
    if (!isChannelCount(channels)) {
      throw new RangeError(`channels must be a supported width, got ${String(channels)}`);
    }
    const maxGroups = Math.min(MAX_ANALOG_GROUPS, Math.floor(channels / 8));
    const analogGroups = config.analogGroups;
    if (!Number.isInteger(analogGroups) || analogGroups < 0 || analogGroups > maxGroups) {
      throw new RangeError(
        `analogGroups must be an integer in [0, ${maxGroups}], got ${String(analogGroups)}`,
      );
    }
    const zeroCode = config.zeroCode ?? SOFTWARE_TEST_ZERO_CODE;
    if (!Number.isInteger(zeroCode) || zeroCode < 0 || zeroCode > 255) {
      throw new RangeError(`zeroCode must be an integer in [0, 255], got ${String(zeroCode)}`);
    }
    const amplitudeCodes = config.amplitudeCodes ?? SOFTWARE_TEST_AMPLITUDE_CODES;
    if (!Number.isInteger(amplitudeCodes) || amplitudeCodes < 1) {
      throw new RangeError(
        `amplitudeCodes must be a positive integer, got ${String(amplitudeCodes)}`,
      );
    }
    if (zeroCode - amplitudeCodes < 0 || zeroCode + amplitudeCodes > 255) {
      throw new RangeError(`zeroCode ${zeroCode} ± ${amplitudeCodes} leaves the 0..255 range`);
    }
    const bytesPerSample = bytesPerSampleForChannels(channels);
    const partialByteMask = channels % 8 === 0 ? 0 : (1 << (channels % 8)) - 1;
    const tile = new Uint8Array(SOFTWARE_TEST_TILE_SAMPLES * bytesPerSample);
    for (let sample = 0; sample < SOFTWARE_TEST_TILE_SAMPLES; sample++) {
      const base = sample * bytesPerSample;
      for (let byte = 0; byte < bytesPerSample; byte++) {
        tile[base + byte] = byte < analogGroups
          ? reverseAdcByte(clampCode(zeroCode + amplitudeCodes * analogShape(byte, sample)))
          : counterByte(sample, byte, bytesPerSample, partialByteMask);
      }
    }
    this.channels = channels;
    this.bytesPerSample = bytesPerSample;
    this.analogGroups = analogGroups;
    this.tile = tile;
  }

  fill(target: Uint8Array, startSample: number): void {
    if (!Number.isSafeInteger(startSample) || startSample < 0) {
      throw new RangeError(
        `startSample must be a non-negative safe integer, got ${String(startSample)}`,
      );
    }
    const { bytesPerSample, tile } = this;
    if (target.length === 0 || target.length % bytesPerSample !== 0) {
      throw new RangeError(
        `target must hold whole samples of ${bytesPerSample} bytes, got ${target.length} bytes`,
      );
    }
    const tileBytes = tile.length;
    let offset = (startSample % SOFTWARE_TEST_TILE_SAMPLES) * bytesPerSample;
    let written = 0;
    while (written < target.length) {
      const run = Math.min(target.length - written, tileBytes - offset);
      target.set(tile.subarray(offset, offset + run), written);
      written += run;
      offset = (offset + run) % tileBytes;
    }
  }
}

function signalHz(samplerate: number, periodSamples: number): number {
  if (!Number.isFinite(samplerate) || samplerate <= 0) {
    throw new RangeError(`sample rate must be positive and finite, got ${String(samplerate)}`);
  }
  return samplerate / periodSamples;
}

function analogShape(group: number, sample: number): number {
  switch (group % MAX_ANALOG_GROUPS) {
    case 0:
      return Math.sin(2 * Math.PI * sample / SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES);
    case 1:
      return Math.cos(2 * Math.PI * sample / SOFTWARE_TEST_SIGNAL_PERIOD_SAMPLES);
    case 2:
      return Math.sin(2 * Math.PI * sample / SOFTWARE_TEST_TILE_SAMPLES);
    default:
      return Math.cos(2 * Math.PI * sample / SOFTWARE_TEST_TILE_SAMPLES);
  }
}

function clampCode(code: number): number {
  return Math.min(255, Math.max(0, Math.round(code)));
}

function counterByte(
  sample: number,
  byte: number,
  bytesPerSample: number,
  partialByteMask: number,
): number {
  const shift = 8 * byte;
  if (shift >= 32) return 0;
  const value = (sample >>> shift) & 0xff;
  return byte === bytesPerSample - 1 && partialByteMask !== 0
    ? value & partialByteMask
    : value;
}
