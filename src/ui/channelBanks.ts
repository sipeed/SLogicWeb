// SPDX-License-Identifier: GPL-3.0-or-later

import { validateBusSpec, type BusSpec } from '../data/busValue.js';
import { DEFAULT_BUS_HEIGHT, runBits, type BusViewConfig } from './busView.js';

export const CHANNEL_BANK_SIZE = 8;

/**
 * The SLogic32U3's ADC module (HSync `adc.rs` / `model.rs`): a group of eight inputs
 * carries one 8-bit converter's output, and only groups wholly inside the capture width
 * are read (`analog_within`). Four groups exist, A0–A3; the 16U3 has none.
 *
 * The converter's data bus is wired MSB first - input 0 of the group is the code's MSB -
 * and its fixed range is ±15 V over codes 0–255. The module is host-side interpretation
 * of the captured digital bytes; nothing about it changes the device protocol, except
 * that its sample clock must come from the 800 MHz PLL, which is why enabling a group
 * restricts the sample rates.
 */
export const ANALOG_GROUP_COUNT = 4;
export const ADC_CLOCK_HZ = 800e6;
export const ADC_MIN_SAMPLERATE_HZ = 100e6;
export const ADC_OFFSET_V = -15;
export const ADC_FULL_SCALE_V = 30;
/** Bits per converter code: the group's eight inputs, one bit each. */
export const ADC_RESOLUTION_BITS = CHANNEL_BANK_SIZE;

/** The converter code a voltage selects, clamped to the module's 0..255 range. */
export function analogCodeFromVolts(volts: number): number {
  if (!Number.isFinite(volts)) return 128;
  const code = Math.round((volts - ADC_OFFSET_V) / ADC_FULL_SCALE_V * 255);
  return Math.max(0, Math.min(255, code));
}

/** The voltage a converter code represents. */
export function analogVoltsFromCode(code: number): number {
  return ADC_OFFSET_V + Math.max(0, Math.min(255, code)) / 255 * ADC_FULL_SCALE_V;
}

/**
 * The selectable trigger level for a slope, snapped to the converter's code grid. Code 0
 * can never be crossed rising and code 255 can never be crossed falling, so the endpoints
 * are moved one code inward. The returned value is the *actual* level, not the request.
 */
export function analogTriggerVolts(kind: 'rising' | 'falling', volts: number): number {
  let code = analogCodeFromVolts(volts);
  code = kind === 'rising' ? Math.max(1, code) : Math.min(254, code);
  return Number(analogVoltsFromCode(code).toFixed(4));
}

/**
 * Capture widths offered by the width selector. 4 CH is the wire mode the U3 models
 * reach their fastest rates in (800 MHz on the 16U3, 1400 MHz on the 32U3); dropping it
 * made those rates unreachable from the panel.
 */
export const CHANNEL_WIDTH_OPTIONS = [4, 8, 16, 32] as const;

export function channelBankStart(index: number): number {
  return Math.floor(index / CHANNEL_BANK_SIZE) * CHANNEL_BANK_SIZE;
}

export function channelBankStarts(channelCount: number): number[] {
  const count = Math.max(0, Math.floor(channelCount));
  return Array.from({ length: Math.ceil(count / CHANNEL_BANK_SIZE) }, (_, i) => i * CHANNEL_BANK_SIZE);
}

export function channelBankIndices(start: number, channelCount: number): number[] {
  const count = Math.max(0, Math.floor(channelCount));
  if (!Number.isInteger(start) || start < 0 || start % CHANNEL_BANK_SIZE !== 0 || start >= count) return [];
  const end = Math.min(start + CHANNEL_BANK_SIZE, count);
  return Array.from({ length: end - start }, (_, i) => start + i);
}

export function channelBankRange(start: number, channelCount: number): string {
  const indices = channelBankIndices(start, channelCount);
  if (indices.length === 0) return '';
  return `D${start}–D${indices[indices.length - 1]!}`;
}

export function busChannelBank(spec: BusSpec): number | null {
  if (spec.bits.length !== CHANNEL_BANK_SIZE) return null;
  const sorted = [...spec.bits].sort((a, b) => a - b);
  const start = sorted[0]!;
  if (start % CHANNEL_BANK_SIZE !== 0) return null;
  return sorted.every((channel, i) => channel === start + i) ? start : null;
}

/** Analog groups (A0–A3) wholly inside a capture width: one per eight inputs. */
export function analogGroupCount(channelCount: number): number {
  return Math.min(ANALOG_GROUP_COUNT, Math.max(0, Math.floor(channelCount / CHANNEL_BANK_SIZE)));
}

/**
 * The rates the ADC module allows: those its 800 MHz PLL divides down to, from its
 * 100 MHz minimum up; only the slower divisors where the link cannot carry the minimum
 * (HSync `adc.rs`, `samplerates`). Order is preserved.
 */
export function analogSamplerates(rates: readonly number[]): number[] {
  const divides = rates.filter((r) => Number.isFinite(r) && r > 0 && ADC_CLOCK_HZ % r === 0);
  const fast = divides.filter((r) => r >= ADC_MIN_SAMPLERATE_HZ);
  return fast.length > 0 ? fast : divides;
}

/** True when a bus view reads a complete bank as an analog channel at this width. */
export function analogBankActive(
  buses: readonly { spec: BusSpec; analogGroup?: number }[], channelCount: number,
): boolean {
  return buses.some((bus) => bus.analogGroup !== undefined &&
    bus.analogGroup * CHANNEL_BANK_SIZE + CHANNEL_BANK_SIZE <= channelCount);
}

/**
 * The fixed view the Analog button creates. The bank's eight inputs become one MSB-first
 * code (the converter wires input 0 to the code's MSB), displayed as ±15 V and named after
 * its group. The source inputs are hidden: they are the converter's data bus, and while
 * the module reads the group they are no longer logic channels (HSync excludes them from
 * triggers, `Settings::logic`). The app drops digital trigger conditions on those inputs
 * while the group is analog; the panel says so.
 */
export function analogBusConfig(
  start: number, channelCount: number, color: string,
): BusViewConfig {
  if (start % CHANNEL_BANK_SIZE !== 0 || start + CHANNEL_BANK_SIZE > channelCount) {
    throw new RangeError(`invalid analog bank ${start} for ${channelCount} channels`);
  }
  return {
    name: `A${start / CHANNEL_BANK_SIZE}`,
    spec: {
      bits: runBits(start, CHANNEL_BANK_SIZE, channelCount, true),
      clock: null,
      encoding: 'unsigned',
    },
    // The analog label is an explicit choice, not Auto: a test pattern must not flip the
    // converter's MSB-first wiring.
    bitOrder: 'msb',
    analogGroup: start / CHANNEL_BANK_SIZE,
    color,
    fullScaleV: ADC_FULL_SCALE_V,
    offsetV: ADC_OFFSET_V,
    voltsPerDiv: 10,
    zeroPosition: 0.5,
    style: 'line',
    heightCss: DEFAULT_BUS_HEIGHT,
    hideSources: true,
  };
}

export function channelWidthOptions(channelCount: number): number[] {
  const max = Math.max(0, Math.floor(channelCount));
  return CHANNEL_WIDTH_OPTIONS.filter((n) => n <= max);
}

export function captureWidthTiers(deviceChannels: number | null, loadedCapture: boolean): number[] {
  if (deviceChannels === null || loadedCapture) return [];
  return channelWidthOptions(deviceChannels);
}

export function busOutOfWidth(spec: BusSpec, channels: number): boolean {
  const used = [...spec.bits, ...(spec.clock ? [spec.clock.channel] : [])];
  return used.some((channel) => channel >= channels);
}

export function lockedChannelBanks(
  buses: readonly { spec: BusSpec; analogGroup?: number }[], channelCount?: number,
): Set<number> {
  const locked = new Set<number>();
  for (const bus of buses) {
    if (bus.analogGroup === undefined) continue;
    const start = bus.analogGroup * CHANNEL_BANK_SIZE;
    if (busChannelBank(bus.spec) !== start ||
        (channelCount !== undefined && validateBusSpec(bus.spec, channelCount).length > 0)) {
      continue;
    }
    locked.add(start);
  }
  return locked;
}
