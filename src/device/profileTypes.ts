// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Device capability data shared by the profile table, the link handshake and the
 * trigger compiler. This file contains types only: behaviour lives in `profile.ts`,
 * `src/link` and `src/dsp`.
 *
 * Source of truth: docs/ARCHITECTURE.md §3.2. Keep this type in step with that section.
 */

import type { ChannelCount } from '../types.js';

export type LinkRate = 'fs' | 'hs' | 'ss';
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
}

export interface AnalogGroup {
  start: number;
  channels: number;
  /** Bipolar range in volts, e.g. 1, 5, 15 (±1 V, ±5 V, ±15 V). */
  ranges: readonly number[];
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
    endpoints: { in: number; out: number };
    maxTransferBytes: number;
    rates: readonly LinkRate[];
    probe: { bytes: number; bursts: number };
  };
  digital: {
    maxChannels: ChannelCount;
    groups: readonly DigitalGroup[];
    widths: readonly ChannelCount[];
    rates: readonly RateTier[];
    thresholdVolts: readonly number[] | null;
    testModes: readonly TestMode[];
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
  firmware: { min: string };
  quirks?: readonly ProfileQuirk[];
}
