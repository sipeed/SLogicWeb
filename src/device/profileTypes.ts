// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Device capability data shared by the profile table, the link handshake and the
 * trigger compiler. This file contains types only: behaviour lives in `profile.ts`,
 * `src/link` and `src/dsp`.
 *
 * Source of truth: docs/ARCHITECTURE.md §3.2. Keep this type in step with that section.
 */

import type { ChannelCount } from '../types.js';

/**
 * Negotiated USB link class.
 *
 * - `fs`  - Full Speed (12 Mbit/s), no U3 rate fits.
 * - `hs`  - High Speed (480 Mbit/s, ~40 MB/s of stream payload).
 * - `ss5` - SuperSpeed 5 Gbit/s, ~400 MB/s of stream payload (`SLOGIC_LINK_SUPER`).
 * - `ss10` - SuperSpeedPlus 10 Gbit/s; the device, not the link, is the limit
 *   (`SLOGIC_LINK_SUPER_PLUS`, `link_payload_bps` returns 0 for it).
 */
export type LinkRate = 'fs' | 'hs' | 'ss5' | 'ss10';
export type TestMode = 0 | 1 | 2;
export type TriggerKind = 'level' | 'rising' | 'falling' | 'edge' | 'high' | 'low';
export type AnalogTriggerKind = 'rising' | 'falling';

export interface DigitalGroup {
  start: number;
  channels: number;
}

export interface RateTier {
  channels: ChannelCount;
  hz: Readonly<Partial<Record<LinkRate, number>>>;
  /**
   * The rate a capture should default to on a link, when a measurement shows the
   * ceiling in `hz` is offered but not sustained. Each value is at or below that
   * link's ceiling; an absent link means "no reason to default below the ceiling".
   */
  recommendedHz?: Readonly<Partial<Record<LinkRate, number>>>;
}

export interface AnalogGroup {
  start: number;
  channels: number;
  /** Bipolar range in volts, e.g. 1, 5, 16 (±1 V, ±5 V, ±16 V). */
  ranges: readonly number[];
  /**
   * The converter's own input span in volts, before the front end. With the other three
   * scale fields it fixes the 1x code-to-volt mapping:
   * LSB = adcSpanV * frontEndAttenuation / codeDenominator, volts = (code - zeroCode) * LSB.
   */
  adcSpanV: number;
  /** Fixed attenuation of the input front end at its default hardware setting (e.g. 20). */
  frontEndAttenuation: number;
  /** The code steps the span divides into (255 for the 32U3 module). */
  codeDenominator: number;
  /** The code that reads 0 V (128 for the 32U3 module). */
  zeroCode: number;
  /**
   * Gain ratios a front-end stage before the converter may be set to, on the hardware
   * side (the host never programs it). With gain G every code reads as its 1x volts
   * divided by G. The user declares the setting; it must include 1 (no gain),
   * ascending. Empty when the group has no gain stage.
   */
  gains: readonly number[];
  /** Bounds of a custom declared gain ratio, when the stage is continuously adjustable. */
  customGain?: { min: number; max: number };
  resolutionBits: number;
  maxHz: Readonly<Partial<Record<LinkRate, number>>>;
}

export interface CalibrationRef {
  id: string;
  version: number;
}

export interface ProfileQuirk {
  id: string;
  note: string;
}

export interface DeviceProfile {
  /** Stable profile id. Behaviour must branch on capabilities, never on this string. */
  id: string;
  name: string;
  vid: number;
  pid: number;
  serial?: { required: boolean };
  link: {
    interfaceClass: 0xff;
    /**
     * Bulk endpoint numbers (WebUSB `endpointNumber`, not the wire address).
     * `out: null` means the profile has no OUT endpoint at all; every write is a
     * vendor control transfer on EP0. A number is a real OUT endpoint and must
     * differ from `in`.
     */
    endpoints: { in: number; out: number | null };
    maxTransferBytes: number;
    rates: readonly LinkRate[];
    probe: { bytes: number; bursts: number };
  };
  digital: {
    maxChannels: ChannelCount;
    groups: readonly DigitalGroup[];
    widths: readonly ChannelCount[];
    rates: readonly RateTier[];
    /**
     * The discrete rates the device accepts at all, before the per-width/link ceiling.
     * Optional so hand-built test profiles can omit it; shipped profiles declare it.
     */
    sampleratesHz?: readonly number[];
    thresholdVolts: readonly number[] | null;
    testModes: readonly TestMode[];
    /** Emulation-pattern table for test mode 2; required when that mode is offered. */
    emulationPattern?: 'slogic16u3' | 'slogic32u3';
  };
  analog: {
    groups: readonly AnalogGroup[];
    calibration: CalibrationRef;
  };
  trigger: {
    execution: 'device' | 'host';
    digital: readonly TriggerKind[];
    analog: readonly AnalogTriggerKind[];
    /** False in P0; true only when this profile can execute mixed conditions. */
    mixed: boolean;
    preTriggerMaxPercent: number;
    preTriggerMaxBytes: number;
  };
  modes: {
    single: boolean;
    repeat: boolean;
    loop: boolean;
    record: boolean;
  };
  /**
   * Documentation floor, never parsed or enforced: the stock U3 register
   * protocol has no firmware-version register. The value is an opaque string;
   * the shipped 32U3 profile uses the vendor hardware S/N, not a dotted version.
   */
  firmware: { min: string };
  quirks?: readonly ProfileQuirk[];
}
