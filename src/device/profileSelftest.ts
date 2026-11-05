// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Self-contained checks for the M0 DeviceProfile layer.
 *
 * Run:
 *   node_modules/.bin/esbuild src/device/profileSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/profile-selftest.mjs --log-level=error
 *   node /tmp/profile-selftest.mjs
 */

import type { ChannelCount } from '../types.js';
import {
  MAX_SAMPLERATE_HZ,
  MAX_SAMPLERATE_HZ_SLOGIC32_U3,
  PID_SLOGIC16_U3,
  PID_SLOGIC32_U3,
  SAMPLERATES_HZ,
  USB_VID_SIPEED,
} from './protocol.js';
import {
  PROFILES,
  SLOGIC16U3_PROFILE,
  SLOGIC32U3_PROFILE,
  capabilityReason,
  maxSamplerateFor,
  profileForVidPid,
  sampleRatesFor,
  validateProfile,
} from './profile.js';
import type { DeviceProfile, LinkRate } from './profileTypes.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const LINK_RATES: readonly LinkRate[] = ['fs', 'hs', 'ss'];

function clone(base: DeviceProfile): DeviceProfile {
  return JSON.parse(JSON.stringify(base)) as DeviceProfile;
}

let variantSeq = 0;
/** A structurally unique candidate, so only the intended field fails validation. */
function variant(
  base: DeviceProfile,
  mutate: (profile: DeviceProfile) => void,
): DeviceProfile {
  const profile = clone(base);
  profile.id = `selftest-${variantSeq}`;
  profile.vid = 0x1200;
  profile.pid = 0x3000 + variantSeq;
  variantSeq += 1;
  mutate(profile);
  return profile;
}

function expectInvalid(label: string, profile: DeviceProfile, reason?: string): void {
  const result = validateProfile(profile);
  const pass = !result.ok && (reason === undefined || result.reason === reason);
  check(
    `validation rejects ${label}`,
    pass,
    result.ok ? 'accepted an invalid profile' : `${result.reason}: ${result.detail}`,
  );
}

// ---- table identity and lookup -------------------------------------------

{
  const ids = PROFILES.map((profile) => profile.id);
  check(
    'profiles have unique, stable ids',
    new Set(ids).size === ids.length &&
      ids.every((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id)),
    `ids=${ids.join(', ')}`,
  );
}

check(
  'VID/PID lookup returns exactly the two U3 profiles and null otherwise',
  profileForVidPid(USB_VID_SIPEED, PID_SLOGIC16_U3) === SLOGIC16U3_PROFILE &&
    profileForVidPid(USB_VID_SIPEED, PID_SLOGIC32_U3) === SLOGIC32U3_PROFILE &&
    profileForVidPid(USB_VID_SIPEED, 0xffff) === null &&
    profileForVidPid(0x0000, PID_SLOGIC16_U3) === null,
  `16U3=${profileForVidPid(USB_VID_SIPEED, PID_SLOGIC16_U3)?.id ?? 'null'}, ` +
    `32U3=${profileForVidPid(USB_VID_SIPEED, PID_SLOGIC32_U3)?.id ?? 'null'}, ` +
    `unknown=${String(profileForVidPid(USB_VID_SIPEED, 0xffff))}`,
);

{
  const outcomes = PROFILES.map((profile) => validateProfile(profile));
  check(
    'the shipped profiles validate',
    outcomes.every((outcome) => outcome.ok),
    outcomes
      .map((outcome, i) => `${PROFILES[i]!.id}=${outcome.ok ? 'ok' : `${outcome.reason}: ${outcome.detail}`}`)
      .join('; '),
  );
}

// ---- validation rejects malformed profiles -------------------------------

expectInvalid('a duplicate profile id', clone(SLOGIC32U3_PROFILE), 'id-duplicate');
expectInvalid(
  'a duplicate VID/PID pair',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.vid = USB_VID_SIPEED;
    p.pid = PID_SLOGIC32_U3;
  }),
  'vid-pid-duplicate',
);
expectInvalid(
  'a negative VID',
  variant(SLOGIC32U3_PROFILE, (p) => { p.vid = -1; }),
  'vid-invalid',
);
expectInvalid(
  'a PID above 16 bits',
  variant(SLOGIC32U3_PROFILE, (p) => { p.pid = 0x10000; }),
  'pid-invalid',
);
expectInvalid(
  'a gap between digital groups',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = {
      ...p.digital,
      groups: [{ start: 0, channels: 8 }, { start: 16, channels: 16 }],
    };
  }),
  'digital-groups-coverage',
);
expectInvalid(
  'a digital group past maxChannels',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = { ...p.digital, groups: [{ start: 0, channels: 40 }] };
  }),
  'digital-groups-range',
);
expectInvalid(
  'widths that omit maxChannels',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = { ...p.digital, widths: [4, 8, 16] };
  }),
  'digital-widths-max',
);
expectInvalid(
  'a missing rate tier',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = { ...p.digital, rates: p.digital.rates.slice(0, 3) };
  }),
  'digital-rates-coverage',
);
expectInvalid(
  'a rate tier keyed by a non-link protocol',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = {
      ...p.digital,
      rates: p.digital.rates.map((tier) => ({
        ...tier,
        hz: { ...tier.hz, ethernet: 1 },
      })) as DeviceProfile['digital']['rates'],
    };
  }),
);
expectInvalid(
  'a zero rate ceiling',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = {
      ...p.digital,
      rates: p.digital.rates.map((tier) => ({
        ...tier,
        hz: { ...tier.hz, hs: 0 },
      })) as DeviceProfile['digital']['rates'],
    };
  }),
);
expectInvalid(
  'a zero analog range',
  variant(SLOGIC32U3_PROFILE, (p) => {
    const first = p.analog.groups[0]!;
    p.analog = { ...p.analog, groups: [{ ...first, ranges: [0] }] };
  }),
  'analog-ranges',
);
expectInvalid(
  'zero ADC resolution',
  variant(SLOGIC32U3_PROFILE, (p) => {
    const first = p.analog.groups[0]!;
    p.analog = { ...p.analog, groups: [{ ...first, resolutionBits: 0 }] };
  }),
  'analog-resolution',
);
expectInvalid(
  'an analog group beyond maxChannels',
  variant(SLOGIC32U3_PROFILE, (p) => {
    const first = p.analog.groups[0]!;
    p.analog = { ...p.analog, groups: [{ ...first, start: 24, channels: 16 }] };
  }),
  'analog-groups-range',
);
expectInvalid(
  'overlapping analog groups',
  variant(SLOGIC32U3_PROFILE, (p) => {
    const first = p.analog.groups[0]!;
    const second = p.analog.groups[1]!;
    p.analog = { ...p.analog, groups: [first, { ...second, start: 4 }] };
  }),
  'analog-groups-order',
);
expectInvalid(
  'an analog rate keyed by a non-link protocol',
  variant(SLOGIC32U3_PROFILE, (p) => {
    const first = p.analog.groups[0]!;
    p.analog = {
      ...p.analog,
      groups: [
        {
          ...first,
          maxHz: { ss: first.maxHz.ss!, usb4: 1 } as DeviceProfile['analog']['groups'][number]['maxHz'],
        },
      ],
    };
  }),
);
expectInvalid(
  'an unknown trigger execution',
  variant(SLOGIC32U3_PROFILE, (p) => {
    (p.trigger as unknown as { execution: string }).execution = 'internet';
  }),
  'trigger-execution',
);
expectInvalid(
  'analog trigger kinds without analog groups',
  variant(SLOGIC16U3_PROFILE, (p) => {
    p.trigger = {
      ...p.trigger,
      analog: ['rising'] as unknown as DeviceProfile['trigger']['analog'],
    };
  }),
  'trigger-analog-without-analog',
);
expectInvalid(
  'mixed triggering without an analog family',
  variant(SLOGIC16U3_PROFILE, (p) => {
    p.trigger = { ...p.trigger, mixed: true };
  }),
  'trigger-mixed',
);
expectInvalid(
  'a pre-trigger percentage above 100',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.trigger = { ...p.trigger, preTriggerMaxPercent: 101 };
  }),
  'trigger-pre-trigger-percent',
);
expectInvalid(
  'zero pre-trigger byte budget',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.trigger = { ...p.trigger, preTriggerMaxBytes: 0 };
  }),
  'trigger-pre-trigger-bytes',
);
expectInvalid(
  'a non-boolean mode flag',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.modes = { ...p.modes, loop: 'yes' as unknown as boolean };
  }),
  'modes-value',
);
expectInvalid(
  'an empty firmware minimum',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.firmware = { min: '' };
  }),
  'firmware-min',
);
expectInvalid(
  'duplicate quirk ids',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.quirks = [{ id: 'x', note: 'first' }, { id: 'x', note: 'second' }];
  }),
  'quirks',
);

// ---- device-specific capability -----------------------------------------

{
  const groups = SLOGIC32U3_PROFILE.analog.groups;
  const starts = groups.map((group) => group.start).join(',');
  const total = groups.reduce((sum, group) => sum + group.channels, 0);
  check(
    '32U3 offers four complete eight-input analog groups over all 32 channels',
    starts === '0,8,16,24' &&
      total === 32 &&
      groups.every((group) => group.channels === 8 &&
        group.ranges.includes(15) && group.resolutionBits === 8),
    `starts=${starts}, total=${total}, ` +
      `ranges=${groups.map((group) => group.ranges.join('/')).join(',')}, ` +
      `resolution=${groups.map((group) => group.resolutionBits).join(',')}`,
  );
}

check(
  '32U3 gates analog capability by capture width and link rate',
  capabilityReason(SLOGIC32U3_PROFILE, 'analog') === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 8 }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 32 }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 4 }) !== null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { linkRate: 'hs' }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { linkRate: 'fs' }) !== null,
  `${capabilityReason(SLOGIC32U3_PROFILE, 'analog') ?? 'analog ok'}; ` +
    `4ch=${capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 4 }) ?? 'ok'}; ` +
    `fs=${capabilityReason(SLOGIC32U3_PROFILE, 'analog', { linkRate: 'fs' }) ?? 'ok'}`,
);

check(
  '16U3 has no analog groups, no analog trigger kinds and rejects analog',
  SLOGIC16U3_PROFILE.analog.groups.length === 0 &&
    SLOGIC16U3_PROFILE.trigger.analog.length === 0 &&
    capabilityReason(SLOGIC16U3_PROFILE, 'analog') !== null,
  `groups=${SLOGIC16U3_PROFILE.analog.groups.length}, ` +
    `triggerKinds=${SLOGIC16U3_PROFILE.trigger.analog.length}`,
);

// ---- offered rates ------------------------------------------------------

{
  // 320 Mbit/s of payload, as libsigrok's link_payload_bps() uses for HS/FS.
  const USB2_PAYLOAD_BPS = 320_000_000;
  const problems: string[] = [];
  for (const profile of PROFILES) {
    const nativeTable = profile === SLOGIC16U3_PROFILE
      ? MAX_SAMPLERATE_HZ
      : MAX_SAMPLERATE_HZ_SLOGIC32_U3;
    for (const channels of profile.digital.widths) {
      for (const link of LINK_RATES) {
        const rates = sampleRatesFor(profile, channels, link);
        const max = maxSamplerateFor(profile, channels, link);
        const label = `${profile.id}/${channels}ch/${link}`;
        if (link === 'fs') {
          if (rates.length !== 0 || max !== 0) problems.push(`${label} guessed an FS rate`);
          continue;
        }
        if (rates.length === 0) {
          problems.push(`${label} offers no rate`);
          continue;
        }
        for (let i = 0; i < rates.length; i++) {
          const rate = rates[i]!;
          if (!SAMPLERATES_HZ.includes(rate)) problems.push(`${label} invents ${rate} Hz`);
          if (i > 0 && rate <= rates[i - 1]!) problems.push(`${label} is not ascending`);
          const native = nativeTable[channels]!;
          if (rate > native) problems.push(`${label} ${rate} exceeds native ${native}`);
          if (link === 'hs' && rate > USB2_PAYLOAD_BPS / channels) {
            problems.push(`${label} ${rate} exceeds the USB 2.0 link cap`);
          }
        }
        if (max !== rates[rates.length - 1]!) {
          problems.push(`${label} max ${max} is not the last offered rate`);
        }
      }
    }
    for (const link of ['hs', 'ss'] as const) {
      const widths = profile.digital.widths;
      for (let i = 1; i < widths.length; i++) {
        const narrower = maxSamplerateFor(profile, widths[i - 1]!, link);
        const wider = maxSamplerateFor(profile, widths[i]!, link);
        if (wider > narrower) {
          problems.push(`${profile.id}/${link}: ${widths[i]}ch exceeds ${widths[i - 1]}ch`);
        }
      }
    }
  }
  check(
    'offered rate lists are ascending, within native and link ceilings, and shrink with width',
    problems.length === 0,
    problems.length === 0 ? 'all profiles/widths/links within bounds' : problems.join('; '),
  );
}

check(
  '16U3 tops out at 800 MHz on 4ch and never offers the 32U3-only 1400 MHz rate',
  maxSamplerateFor(SLOGIC16U3_PROFILE, 4, 'ss') === 800e6 &&
    sampleRatesFor(SLOGIC16U3_PROFILE, 4, 'ss').every((rate) => rate <= 800e6) &&
    !sampleRatesFor(SLOGIC16U3_PROFILE, 16, 'ss').includes(1.4e9),
  `4ch/ss max=${maxSamplerateFor(SLOGIC16U3_PROFILE, 4, 'ss')}, ` +
    `16ch/ss=${sampleRatesFor(SLOGIC16U3_PROFILE, 16, 'ss').join(',')}`,
);

check(
  '32U3 reaches 1400 MHz on 4ch and 200 MHz on 32ch over SuperSpeed',
  maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss') === 1.4e9 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'ss') === 200e6,
  `4ch=${maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss')}, ` +
    `32ch=${maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'ss')}`,
);

check(
  'High Speed follows the 320 Mbit/s payload divided by the capture width',
  maxSamplerateFor(SLOGIC16U3_PROFILE, 4, 'hs') === 80e6 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 8, 'hs') === 40e6 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 16, 'hs') === 20e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'hs') === 10e6,
  `16U3 4/8/16ch=${[4, 8, 16]
    .map((channels) => maxSamplerateFor(SLOGIC16U3_PROFILE, channels as ChannelCount, 'hs'))
    .join('/')}, 32U3 32ch=${maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'hs')}`,
);

check(
  'Full Speed and unsupported widths offer nothing rather than guessing',
  sampleRatesFor(SLOGIC16U3_PROFILE, 16, 'fs').length === 0 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 16, 'fs') === 0 &&
    sampleRatesFor(SLOGIC16U3_PROFILE, 64 as ChannelCount, 'ss').length === 0 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 64 as ChannelCount, 'ss') === 0,
  `fs=[${sampleRatesFor(SLOGIC16U3_PROFILE, 16, 'fs').join(',')}], ` +
    `64ch=[${sampleRatesFor(SLOGIC16U3_PROFILE, 64 as ChannelCount, 'ss').join(',')}]`,
);

{
  const tiles = PROFILES.every((profile) => {
    let expected = 0;
    for (const group of profile.digital.groups) {
      if (group.start !== expected) return false;
      expected += group.channels;
    }
    return expected === profile.digital.maxChannels;
  });
  check(
    'digital groups tile the whole device width with no gaps or overlap',
    tiles,
    PROFILES
      .map((profile) => `${profile.id}: ${profile.digital.groups
        .map((group) => `${group.start}+${group.channels}`).join(' ')}`)
      .join('; '),
  );
}

// ---- capability reasons -------------------------------------------------

check(
  'capability reasons describe P0 trigger, mode, width, link and serial limits',
  capabilityReason(SLOGIC32U3_PROFILE, 'mixed-trigger') !== null &&
    capabilityReason(SLOGIC16U3_PROFILE, 'mixed-trigger') !== null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'record') === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'loop') === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'repeat') === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'digital') === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'serial') !== null &&
    capabilityReason(SLOGIC16U3_PROFILE, 'digital', { channels: 32 }) !== null &&
    capabilityReason(SLOGIC16U3_PROFILE, 'digital', { linkRate: 'fs' }) !== null &&
    capabilityReason(SLOGIC16U3_PROFILE, 'digital', { channels: 16, linkRate: 'hs' }) === null,
  `mixed=${capabilityReason(SLOGIC32U3_PROFILE, 'mixed-trigger')}; ` +
    `serial=${capabilityReason(SLOGIC32U3_PROFILE, 'serial')}; ` +
    `16U3@32ch=${capabilityReason(SLOGIC16U3_PROFILE, 'digital', { channels: 32 })}`,
);

// ---- profiles stay plain data ------------------------------------------

function containsFunction(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (Array.isArray(value)) return value.some(containsFunction);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some(containsFunction);
  }
  return false;
}

check(
  'profiles contain only JSON data (no behaviour or methods)',
  !containsFunction(PROFILES) &&
    JSON.stringify(JSON.parse(JSON.stringify(PROFILES))) === JSON.stringify(PROFILES),
  `functions=${String(containsFunction(PROFILES))}`,
);

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
