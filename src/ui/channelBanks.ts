// SPDX-License-Identifier: GPL-3.0-or-later

import { validateBusSpec, type BusSpec } from '../data/busValue.js';
import { PROFILES } from '../device/profiles.js';
import { DEFAULT_BUS_HEIGHT, runBits, type BusViewConfig } from './busView.js';
import { scopeDefaultVoltsPerDiv, scopeVoltsPerDivValues } from './scopeScale.js';

export const CHANNEL_BANK_SIZE = 8;

/**
 * The SLogic32U3's ADC module (HSync `adc.rs` / `model.rs`): a group of eight inputs
 * carries one 8-bit converter's output, and only groups wholly inside the capture width
 * are read (`analog_within`). Four groups exist, A0–A3; the 16U3 has none.
 *
 * The converter's data bus is wired MSB first - input 0 of the group is the code's MSB.
 * The module is host-side interpretation of the captured digital bytes; nothing about it
 * changes the device protocol, except that its sample clock must come from the 800 MHz
 * PLL, which is why enabling a group restricts the sample rates.
 */
export const ANALOG_GROUP_COUNT = 4;
export const ADC_CLOCK_HZ = 800e6;
export const ADC_MIN_SAMPLERATE_HZ = 100e6;
/** Bits per converter code: the group's eight inputs, one bit each. */
export const ADC_RESOLUTION_BITS = CHANNEL_BANK_SIZE;

/**
 * The code-to-volt scale is profile data (`AnalogGroup.adcSpanV`, `frontEndAttenuation`,
 * `codeDenominator`, `zeroCode`, `gains`, `customGain`); nothing here restates it. The
 * only profile with an analog group is the 32U3, whose groups all share one scale.
 *
 * 1x: LSB = adcSpanV * frontEndAttenuation / codeDenominator (1.6 * 20 / 255 =
 * 0.12549 V), 0 V at code 128: code 0 = -16.063 V, code 255 = +15.937 V. Confirmed by
 * the hardware team on 2026-11-06 (HSync and scopehal used ±15 V with zero at 127.5).
 *
 * Hardware gain (the module's front-end stage, set on the module and only *declared* to
 * the host) divides: volts = (code - 128) * LSB / G, so 3x reads ±5.33 V at 41.8 mV per
 * code. A probe attenuation would multiply; this is a gain.
 */
const PROFILE_ANALOG_GROUP = PROFILES.flatMap((profile) => profile.analog.groups)[0];
if (!PROFILE_ANALOG_GROUP) throw new Error('no device profile declares an analog group');
/** The converter's input span times the front-end attenuation: 32 V at 1x. */
const ADC_INPUT_SPAN_V = PROFILE_ANALOG_GROUP.adcSpanV * PROFILE_ANALOG_GROUP.frontEndAttenuation;
/** Volts per code at 1x. */
export const ADC_LSB_V = ADC_INPUT_SPAN_V / PROFILE_ANALOG_GROUP.codeDenominator;
/** The code that reads 0 V. */
export const ADC_ZERO_CODE = PROFILE_ANALOG_GROUP.zeroCode;
/** The highest code the converter outputs. */
export const ADC_MAX_CODE = 2 ** PROFILE_ANALOG_GROUP.resolutionBits - 1;

export const ANALOG_GAIN_DEFAULT = 1;
export const ANALOG_GAIN_PRESETS: readonly number[] = PROFILE_ANALOG_GROUP.gains.length
  ? PROFILE_ANALOG_GROUP.gains : [ANALOG_GAIN_DEFAULT];
export const ANALOG_GAIN_MIN = PROFILE_ANALOG_GROUP.customGain?.min ?? ANALOG_GAIN_PRESETS[0]!;
export const ANALOG_GAIN_MAX = PROFILE_ANALOG_GROUP.customGain?.max ??
  ANALOG_GAIN_PRESETS[ANALOG_GAIN_PRESETS.length - 1]!;

/** True for a gain ratio the user may declare (finite, inside the profile's bounds). */
export function isAnalogGain(gain: unknown): gain is number {
  return typeof gain === 'number' && Number.isFinite(gain) &&
    gain >= ANALOG_GAIN_MIN - 1e-12 && gain <= ANALOG_GAIN_MAX + 1e-12;
}

/** A stored gain, or 1x when it is missing or not a declarable ratio. */
export function analogGainOf(bus: { analogGain?: number } | undefined): number {
  return isAnalogGain(bus?.analogGain) ? bus.analogGain : ANALOG_GAIN_DEFAULT;
}

/** Volts per converter code at a gain: 0.12549 V at 1x. The one place volts scale. */
export function analogVoltsPerCode(gain = ANALOG_GAIN_DEFAULT): number {
  return ADC_LSB_V / (isAnalogGain(gain) ? gain : ANALOG_GAIN_DEFAULT);
}

/**
 * The same mapping as a bus view's linear span: the code-0 voltage and the volts from
 * code 0 to ADC_MAX_CODE, for the generic `offsetV + code / max * fullScaleV` readers.
 */
export function analogSpan(gain = ANALOG_GAIN_DEFAULT): { offsetV: number; fullScaleV: number } {
  const lsb = analogVoltsPerCode(gain);
  return { offsetV: -ADC_ZERO_CODE * lsb, fullScaleV: ADC_MAX_CODE * lsb };
}

/**
 * The nominal bipolar half-range at a gain, as the UI names it: half the input span,
 * ±16 V at 1x, ±5.33 V at 3x. The exact code endpoints (-16.063 / +15.937 V at 1x) are
 * `analogVoltsFromCode(0 | ADC_MAX_CODE)`; clamping uses those.
 */
export function analogHalfRangeV(gain = ANALOG_GAIN_DEFAULT): number {
  return ADC_INPUT_SPAN_V / 2 / (isAnalogGain(gain) ? gain : ANALOG_GAIN_DEFAULT);
}

/** The widest half-range any declarable gain gives (at ANALOG_GAIN_MIN). */
export const ANALOG_MAX_HALF_RANGE_V = analogHalfRangeV(ANALOG_GAIN_MIN);

/** The voltage a converter code represents at a gain: `(code - zero) * LSB / G`. */
export function analogVoltsFromCode(code: number, gain = ANALOG_GAIN_DEFAULT): number {
  return (Math.max(0, Math.min(ADC_MAX_CODE, code)) - ADC_ZERO_CODE) * analogVoltsPerCode(gain);
}

/** Clamp a voltage into what codes 0..max read at a gain (-16.063 .. +15.937 V at 1x). */
export function clampAnalogVolts(volts: number, gain = ANALOG_GAIN_DEFAULT): number {
  return Math.max(analogVoltsFromCode(0, gain), Math.min(analogVoltsFromCode(ADC_MAX_CODE, gain), volts));
}

/**
 * The converter code a voltage selects at a gain, clamped to 0..max:
 * `round(volts * G / LSB + zero)`.
 */
export function analogCodeFromVolts(volts: number, gain = ANALOG_GAIN_DEFAULT): number {
  if (!Number.isFinite(volts)) return Math.round(ADC_ZERO_CODE);
  const code = Math.round(volts / analogVoltsPerCode(gain) + ADC_ZERO_CODE);
  return Math.max(0, Math.min(ADC_MAX_CODE, code));
}

/**
 * The code a trigger crossing compares against. Code 0 can never be crossed rising and
 * the top code can never be crossed falling, so the endpoints are moved one code inward.
 */
export function analogTriggerCode(
  kind: 'rising' | 'falling', volts: number, gain = ANALOG_GAIN_DEFAULT,
): number {
  const code = analogCodeFromVolts(volts, gain);
  return kind === 'rising' ? Math.max(1, code) : Math.min(ADC_MAX_CODE - 1, code);
}

/**
 * The selectable trigger level for a slope, snapped to the converter's code grid at the
 * group's gain. The returned value is the *actual* level, not the request.
 *
 * Trigger levels are stored in volts. When the declared gain changes the stored volts are
 * kept and re-snapped through this function (so the code is recomputed and clamped into
 * the new range); a level clamped that way stays clamped if the gain is changed back.
 */
export function analogTriggerVolts(
  kind: 'rising' | 'falling', volts: number, gain = ANALOG_GAIN_DEFAULT,
): number {
  return Number(analogVoltsFromCode(analogTriggerCode(kind, volts, gain), gain).toFixed(4));
}

/**
 * The V/div an analog row starts at (and Home/double-click returns to) for a gain: the
 * finest 1-2-5 step whose four divisions still show the whole range (10 V at 1x).
 */
export function analogDefaultVoltsPerDiv(gain = ANALOG_GAIN_DEFAULT): number {
  return scopeDefaultVoltsPerDiv(analogHalfRangeV(gain));
}

/** The V/div steps the wheel and keys walk at a gain (0.5..20 V at 1x, scaled by 1/G). */
export function analogVoltsPerDivValues(gain = ANALOG_GAIN_DEFAULT): number[] {
  return scopeVoltsPerDivValues(analogHalfRangeV(gain));
}

/** "×3", "×0.5": the gain as the UI shows it. */
export function formatAnalogGain(gain: number): string {
  return `×${Number(gain.toPrecision(4))}`;
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
 * code (the converter wires input 0 to the code's MSB), displayed in volts and named after
 * its group, at the declared hardware `gain` (its span is `analogSpan(gain)` and its
 * V/div the gain's default). The source inputs are hidden: they are the converter's data bus, and while
 * the module reads the group they are no longer logic channels (HSync excludes them from
 * triggers, `Settings::logic`). The app drops digital trigger conditions on those inputs
 * while the group is analog; the panel says so.
 */
export function analogBusConfig(
  start: number, channelCount: number, color: string, gain = ANALOG_GAIN_DEFAULT,
): BusViewConfig {
  const analogGain = isAnalogGain(gain) ? gain : ANALOG_GAIN_DEFAULT;
  const span = analogSpan(analogGain);
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
    analogGain,
    // Derived from the gain, never set independently: every generic bus reading
    // (`busLabel`, the overlay, hover) then shows true volts.
    fullScaleV: span.fullScaleV,
    offsetV: span.offsetV,
    voltsPerDiv: analogDefaultVoltsPerDiv(analogGain),
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
