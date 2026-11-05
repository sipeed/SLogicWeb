// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The U3 device profiles. Data only: every value here is either a protocol
 * constant from `protocol.ts`, a measurement recorded in `NOTES.md` /
 * `PROTOCOL-SLOGIC16U3.md`, or a limit that the current transport implements.
 * Behaviour lives in `profile.ts`, `src/link` and `src/dsp`.
 *
 * Rate evidence:
 * - Discrete rates come from `SAMPLERATES_HZ`, which is the vendor driver's table.
 * - SuperSpeed ceilings are the model's native channel-count limits
 *   (`MAX_SAMPLERATE_HZ`, `MAX_SAMPLERATE_HZ_SLOGIC32_U3`). The 16U3 link is
 *   5 Gbit/s and every offered width uses the same 400 MB/s wire budget; the
 *   32U3 link is SuperSpeed Plus and the native table is what the current
 *   transport has been measured against (NOTES 8.7/8.26).
 * - High Speed is capped at 320 Mbit/s of payload (40 MB/s), the same figure
 *   libsigrok uses for `SLOGIC_LINK_HIGH` (`slogic_data.c`, `link_payload_bps`).
 * - Full Speed is declared as a possible link rate but carries no tier: no
 *   offered rate fits a 12 Mbit/s link, and there is no measurement in this
 *   repository to justify inventing one. `sampleRatesFor` therefore returns []
 *   on 'fs' instead of guessing.
 */

import type { ChannelCount } from '../types.js';
import {
  EP_IN,
  MAX_SAMPLERATE_HZ,
  MAX_SAMPLERATE_HZ_SLOGIC32_U3,
  PID_SLOGIC16_U3,
  PID_SLOGIC32_U3,
  TEST_MODE_EMULATION,
  TEST_MODE_NORMAL,
  TEST_MODE_USB_MAX_SPEED,
  USB_VID_SIPEED,
} from './protocol.js';
import type { AnalogGroup, DeviceProfile, LinkRate, RateTier } from './profileTypes.js';

/**
 * Chromium's per-call WebUSB transfer ceiling. The transport's private
 * `MAX_WEBUSB_TRANSFER_BYTES` and `PROTOCOL-SLOGIC16U3.md` both fix it at
 * 32 MiB; the profile records the ceiling, not the smaller geometry the
 * transport picks for a given line rate.
 */
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;

/**
 * One burst of the link/allocation probe: libsigrok's trained geometry
 * (`LIBSIGROK_TRANSFER_BYTES` x `LIBSIGROK_TRANSFER_DEPTH` in `slogic16u3.ts`,
 * which mirrors protocol.c). It is one short burst at stream rates and fits
 * inside the 16 MiB usbfs budget.
 */
const PROBE_BYTES = 3_129_344;
const PROBE_BURSTS = 5;

/** Payload a USB 2.0 High Speed link sustains for the U3 stream. */
const USB2_LINK_PAYLOAD_BPS = 320_000_000;

/** Pre-trigger history the host matcher may retain (`SoftwareTrigger` cap). */
const PRE_TRIGGER_MAX_PERCENT = 75;
const PRE_TRIGGER_MAX_BYTES = 64 * 1024 * 1024;

/** The ADC module's sample clock (HSync `adc.rs`); rates are its divisors. */
const ADC_CLOCK_HZ = 800e6;
/** One analog group is a complete eight-input bank of the digital pins. */
const ADC_GROUP_CHANNELS = 8;
/** Four groups cover D0-D7, D8-D15, D16-D23 and D24-D31. */
const ADC_GROUP_STARTS = [0, 8, 16, 24] as const;
/**
 * The converter has one fixed bipolar range: ±15 V over codes 0..255
 * (`channelBanks.ts`, HSync `adc.rs`). The value is the magnitude, matching
 * the `AnalogGroup.ranges` contract ("bipolar range in volts, e.g. 1, 5, 15").
 */
const ADC_RANGES_V = [15] as const;
const ADC_RESOLUTION_BITS = 8;

/**
 * Threshold choices the current UI offers (`THRESHOLD_VOLT_OPTIONS`). The vref
 * DAC itself spans roughly 0.43-5.7 V; only measured/offered points belong in
 * a profile.
 */
const THRESHOLD_VOLTS = [0.6, 0.9, 1.2, 1.5, 1.65, 1.8, 2.5, 3.3] as const;

/** Digital trigger kinds the host matcher expresses (high/low alias level). */
const DIGITAL_TRIGGER_KINDS = ['level', 'rising', 'falling', 'edge', 'high', 'low'] as const;

function nativeRate(
  table: Readonly<Record<number, number>>,
  channels: ChannelCount,
): number {
  const hz: number | undefined = table[channels];
  if (hz === undefined) {
    throw new Error(`protocol table has no samplerate ceiling for ${channels} channels`);
  }
  return hz;
}

/**
 * One rate tier: the native ceiling on SuperSpeed and the USB 2.0 link cap on
 * High Speed. Full Speed is deliberately absent; see the file comment.
 */
function rateTier(channels: ChannelCount, nativeHz: number): RateTier {
  const hz: Partial<Record<LinkRate, number>> = { ss: nativeHz };
  hz.hs = Math.min(nativeHz, USB2_LINK_PAYLOAD_BPS / channels);
  return { channels, hz };
}

function analogGroup(start: number): AnalogGroup {
  return {
    start,
    channels: ADC_GROUP_CHANNELS,
    ranges: ADC_RANGES_V,
    resolutionBits: ADC_RESOLUTION_BITS,
    maxHz: {
      // One complete bank is eight inputs, so the 800 MHz PLL's own clock is the
      // SuperSpeed ceiling; High Speed is capped by the eight-input wire load.
      ss: ADC_CLOCK_HZ,
      hs: Math.min(ADC_CLOCK_HZ, USB2_LINK_PAYLOAD_BPS / ADC_GROUP_CHANNELS),
    },
  };
}

/** Quirks true of both U3 models. */
const U3_COMMON_QUIRKS = [
  {
    id: 'browser-serial',
    note: 'WebUSB reports an origin-scoped serial number (some browsers randomise it); ' +
      'it is a session handle, not a stable unit identity.',
  },
  {
    id: 'firmware-version-unreadable',
    note: 'The U3 register protocol exposes no firmware version register; ' +
      'firmware.min is a documentation floor the handshake cannot enforce.',
  },
] as const;

export const SLOGIC16U3_PROFILE: DeviceProfile = {
  id: 'slogic16u3',
  name: 'SLogic16 U3',
  vid: USB_VID_SIPEED,
  pid: PID_SLOGIC16_U3,
  // The browser's serial is not stable, so reconnect must tolerate it missing.
  serial: { required: false },
  link: {
    interfaceClass: 0xff,
    // All writes are vendor control transfers on EP0; the only bulk endpoint is
    // the sample stream's IN pipe (protocol.c). `out: 0` names that fact.
    endpoints: { in: EP_IN, out: 0 },
    maxTransferBytes: MAX_TRANSFER_BYTES,
    rates: ['fs', 'hs', 'ss'],
    probe: { bytes: PROBE_BYTES, bursts: PROBE_BURSTS },
  },
  digital: {
    maxChannels: 16,
    // One contiguous bank: every enabled channel is sampled at one rate.
    groups: [{ start: 0, channels: 16 }],
    widths: [4, 8, 16],
    rates: [
      rateTier(4, nativeRate(MAX_SAMPLERATE_HZ, 4)),
      rateTier(8, nativeRate(MAX_SAMPLERATE_HZ, 8)),
      rateTier(16, nativeRate(MAX_SAMPLERATE_HZ, 16)),
    ],
    thresholdVolts: THRESHOLD_VOLTS,
    testModes: [TEST_MODE_NORMAL, TEST_MODE_USB_MAX_SPEED, TEST_MODE_EMULATION],
  },
  analog: {
    // The 16U3 has no ADC module.
    groups: [],
    calibration: { id: 'no-analog', version: 0 },
  },
  trigger: {
    // The current implementation is the host-side matcher; P0 keeps one family.
    execution: 'host',
    digital: DIGITAL_TRIGGER_KINDS,
    analog: [],
    mixed: false,
    preTriggerMaxPercent: PRE_TRIGGER_MAX_PERCENT,
    preTriggerMaxBytes: PRE_TRIGGER_MAX_BYTES,
  },
  modes: { single: true, repeat: true, loop: true, record: true },
  // No documented minimum: the vendor requirement applies to 32U3 firmware.
  firmware: { min: '0' },
  quirks: [
    ...U3_COMMON_QUIRKS,
    {
      id: 'partial-head-drop',
      note: 'The first 4 stream bytes are not a sample; the transport drops them once ' +
        'per acquisition, carrying the drop across a short transfer.',
    },
  ],
};

export const SLOGIC32U3_PROFILE: DeviceProfile = {
  id: 'slogic32u3',
  name: 'SLogic32 U3',
  vid: USB_VID_SIPEED,
  pid: PID_SLOGIC32_U3,
  serial: { required: false },
  link: {
    interfaceClass: 0xff,
    endpoints: { in: EP_IN, out: 0 },
    maxTransferBytes: MAX_TRANSFER_BYTES,
    rates: ['fs', 'hs', 'ss'],
    probe: { bytes: PROBE_BYTES, bursts: PROBE_BURSTS },
  },
  digital: {
    maxChannels: 32,
    groups: [{ start: 0, channels: 32 }],
    widths: [4, 8, 16, 32],
    rates: [
      rateTier(4, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 4)),
      rateTier(8, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 8)),
      rateTier(16, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 16)),
      rateTier(32, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 32)),
    ],
    thresholdVolts: THRESHOLD_VOLTS,
    testModes: [TEST_MODE_NORMAL, TEST_MODE_USB_MAX_SPEED, TEST_MODE_EMULATION],
  },
  analog: {
    groups: ADC_GROUP_STARTS.map(analogGroup),
    // No per-unit ADC calibration data exists yet. The fixed code-to-volt
    // mapping is the reference (`channelBanks.ts`, ±15 V over 0..255).
    calibration: { id: 'slogic32u3-adc-fixed', version: 1 },
  },
  trigger: {
    execution: 'host',
    digital: DIGITAL_TRIGGER_KINDS,
    analog: ['rising', 'falling'],
    mixed: false,
    preTriggerMaxPercent: PRE_TRIGGER_MAX_PERCENT,
    preTriggerMaxBytes: PRE_TRIGGER_MAX_BYTES,
  },
  modes: { single: true, repeat: true, loop: true, record: true },
  // Vendor requirement quoted by `slogic16u3.ts` (README): firmware S/N
  // 202610150528 or newer, i.e. the build that gates on whole sample words.
  firmware: { min: '202610150528' },
  quirks: [
    ...U3_COMMON_QUIRKS,
    {
      id: 'whole-word-head',
      note: 'Supported firmware gates on whole sample words, so the stream has no ' +
        'partial head bytes to drop.',
    },
    {
      id: 'adc-800mhz-pll',
      note: 'An active analog group takes its sample clock from the ADC 800 MHz PLL: ' +
        'offered rates are that PLL\'s divisors from 100 MHz up (or the slower ' +
        'divisors when the link cannot carry the minimum).',
    },
  ],
};

/** Every profile this build can drive. */
export const PROFILES: readonly DeviceProfile[] = [
  SLOGIC16U3_PROFILE,
  SLOGIC32U3_PROFILE,
];
