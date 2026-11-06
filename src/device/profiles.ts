// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The U3 device profiles. Data only: every value here is either a protocol
 * constant from `protocol.ts`, a measurement recorded in `NOTES.md` /
 * `PROTOCOL-SLOGIC16U3.md`, or a limit that the current transport implements.
 * Behaviour lives in `profile.ts`, `src/link` and `src/dsp`.
 *
 * Rate evidence:
 * - Discrete rates come from `SAMPLERATES_HZ`, which is the vendor driver's table.
 * - Link classes are the driver's `slogic_link` values: Full Speed, High Speed,
 *   SuperSpeed 5 Gbit/s (`SLOGIC_LINK_SUPER`, `ss5`) and SuperSpeedPlus
 *   10 Gbit/s (`SLOGIC_LINK_SUPER_PLUS`, `ss10`).
 * - The 5 Gbit/s link carries 3200 Mbit/s of stream payload (~400 MB/s,
 *   `slogic_data.c` `link_payload_bps`), so `ss5` is
 *   min(native, 3200 Mbit/s / channels). On a 32U3 that gives 4/8/16/32 ch =
 *   800/400/200/100 MHz: its native 32 ch ceiling of 200 MHz needs 800 MB/s and
 *   is only reachable on `ss10`.
 * - On `ss10` the link is not the limit (`link_payload_bps` returns 0 for
 *   SuperSpeedPlus), so the native per-width tables (`MAX_SAMPLERATE_HZ`,
 *   `MAX_SAMPLERATE_HZ_SLOGIC32_U3`) are the ceilings. The 16U3 is a 5 Gbit/s
 *   device and must not declare `ss10`.
 * - NOTES 5, 8.6 and 8.7 record the same boundary: 32ch/200M offers 800 MB/s,
 *   which a 5 Gbit/s link cannot carry; on the measured 10 Gb/s link the
 *   browser delivered roughly half of it and the abort wedged the sampling
 *   path. 32ch/100M is 400 MB/s - exactly the 5 Gbit/s ceiling - and NOTES 5
 *   records five consecutive clean 100M captures.
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
  SAMPLERATES_HZ,
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

/** Payload a USB 2.0 High Speed link sustains for the U3 stream: 320 Mbit/s. */
const USB2_LINK_PAYLOAD_BPS = 320_000_000;

/** Payload a USB 3.0 5 Gbit/s (SuperSpeed) link sustains: 3200 Mbit/s. */
const USB3_5G_LINK_PAYLOAD_BPS = 3_200_000_000;

/** Links the 5 Gbit/s 16U3 negotiates; it has no SuperSpeedPlus tier. */
const SLOGIC16U3_LINK_RATES = ['fs', 'hs', 'ss5'] as const;

/** Links the SuperSpeedPlus-capable 32U3 negotiates. */
const SLOGIC32U3_LINK_RATES = ['fs', 'hs', 'ss5', 'ss10'] as const;

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
 * One rate tier. `ss10` is the native per-width ceiling (the 10 Gbit/s link is
 * not the limit for this device); `ss5` is that ceiling capped by the 5 Gbit/s
 * payload; `hs` is capped by the USB 2.0 payload. Only the links the model
 * declares are populated, which is what keeps `ss10` off the 16U3. Full Speed
 * is deliberately absent; see the file comment.
 */
function rateTier(
  channels: ChannelCount,
  nativeHz: number,
  links: readonly LinkRate[],
): RateTier {
  const hz: Partial<Record<LinkRate, number>> = {};
  for (const link of links) {
    switch (link) {
      case 'ss10':
        hz.ss10 = nativeHz;
        break;
      case 'ss5':
        hz.ss5 = Math.min(nativeHz, USB3_5G_LINK_PAYLOAD_BPS / channels);
        break;
      case 'hs':
        hz.hs = Math.min(nativeHz, USB2_LINK_PAYLOAD_BPS / channels);
        break;
      case 'fs':
        // No offered rate fits Full Speed, so the tier stays absent.
        break;
    }
  }
  return { channels, hz };
}

function analogGroup(start: number): AnalogGroup {
  return {
    start,
    channels: ADC_GROUP_CHANNELS,
    ranges: ADC_RANGES_V,
    resolutionBits: ADC_RESOLUTION_BITS,
    maxHz: {
      // One complete bank is eight inputs. The 800 MHz PLL is the native
      // ceiling; the 5 Gbit/s and USB 2.0 links are capped by the eight-input
      // wire load.
      ss10: ADC_CLOCK_HZ,
      ss5: Math.min(ADC_CLOCK_HZ, USB3_5G_LINK_PAYLOAD_BPS / ADC_GROUP_CHANNELS),
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
    note: 'The U3 register protocol exposes no firmware version register, so firmware.min ' +
      'is documentation the handshake can neither parse nor enforce; the shipped 32U3 ' +
      'value is an opaque vendor hardware S/N, not a dotted version.',
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
    // the sample stream's IN pipe (protocol.c). `out: null` means "no OUT pipe".
    endpoints: { in: EP_IN, out: null },
    maxTransferBytes: MAX_TRANSFER_BYTES,
    rates: SLOGIC16U3_LINK_RATES,
    probe: { bytes: PROBE_BYTES, bursts: PROBE_BURSTS },
  },
  digital: {
    maxChannels: 16,
    // One contiguous bank: every enabled channel is sampled at one rate.
    groups: [{ start: 0, channels: 16 }],
    widths: [4, 8, 16],
    rates: [
      rateTier(4, nativeRate(MAX_SAMPLERATE_HZ, 4), SLOGIC16U3_LINK_RATES),
      rateTier(8, nativeRate(MAX_SAMPLERATE_HZ, 8), SLOGIC16U3_LINK_RATES),
      rateTier(16, nativeRate(MAX_SAMPLERATE_HZ, 16), SLOGIC16U3_LINK_RATES),
    ],
    sampleratesHz: SAMPLERATES_HZ,
    thresholdVolts: THRESHOLD_VOLTS,
    testModes: [TEST_MODE_NORMAL, TEST_MODE_USB_MAX_SPEED, TEST_MODE_EMULATION],
    emulationPattern: 'slogic16u3',
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
    // Same wiring as the 16U3: control transfers only, one bulk IN pipe.
    endpoints: { in: EP_IN, out: null },
    maxTransferBytes: MAX_TRANSFER_BYTES,
    rates: SLOGIC32U3_LINK_RATES,
    probe: { bytes: PROBE_BYTES, bursts: PROBE_BURSTS },
  },
  digital: {
    maxChannels: 32,
    groups: [{ start: 0, channels: 32 }],
    widths: [4, 8, 16, 32],
    rates: [
      rateTier(4, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 4), SLOGIC32U3_LINK_RATES),
      rateTier(8, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 8), SLOGIC32U3_LINK_RATES),
      rateTier(16, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 16), SLOGIC32U3_LINK_RATES),
      rateTier(32, nativeRate(MAX_SAMPLERATE_HZ_SLOGIC32_U3, 32), SLOGIC32U3_LINK_RATES),
    ],
    sampleratesHz: SAMPLERATES_HZ,
    thresholdVolts: THRESHOLD_VOLTS,
    testModes: [TEST_MODE_NORMAL, TEST_MODE_USB_MAX_SPEED, TEST_MODE_EMULATION],
    emulationPattern: 'slogic32u3',
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
  // Documentation only: vendor support floor from the SLogic README
  // ("SLogic32U3 requires firmware S/N 202610150528 or newer"), also recorded in
  // `sub_service/ota/firmware.json`. The value is an opaque hardware S/N, not a
  // dotted version, and the stock register protocol exposes no version register,
  // so nothing parses or enforces it. Whole-word stream gating (the
  // `whole-word-head` quirk below) is documented from the earlier S/N
  // 202610120954 (`slogic32u3.c`, `slogic-protocol.md`); 202610150528 is a later
  // support floor, not the behaviour boundary.
  firmware: { min: '202610150528' },
  quirks: [
    ...U3_COMMON_QUIRKS,
    {
      id: 'whole-word-head',
      note: 'Whole-word gating is documented from firmware S/N 202610120954; supported ' +
        'firmware is newer, so the stream has no partial head bytes to drop.',
    },
    {
      id: 'adc-800mhz-pll',
      note: 'An active analog group takes its sample clock from the ADC 800 MHz PLL: ' +
        'offered rates are that PLL\'s divisors from 100 MHz up (or the slower ' +
        'divisors when the link cannot carry the minimum).',
    },
    {
      id: 'ss5-32ch-payload-edge',
      note: '32 channels at 100 MHz is exactly the 5 Gbit/s payload ceiling ' +
        '(32 x 100 MHz / 8 = 400 MB/s) and triggered an underrun in headless ' +
        'acceptance; a later 80 MHz run also underran, while 50 MHz was clean. ' +
        '100 MHz stays in the capability table because libsigrok declares it. ' +
        'Until a sustained run is clean, the UI should use a conservative 50 MHz ' +
        'default on ss5 when 32 channels are enabled.',
    },
  ],
};

/** Every profile this build can drive. */
export const PROFILES: readonly DeviceProfile[] = [
  SLOGIC16U3_PROFILE,
  SLOGIC32U3_PROFILE,
];
