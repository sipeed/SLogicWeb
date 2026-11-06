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
  EP_IN,
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

const LINK_RATES: readonly LinkRate[] = ['fs', 'hs', 'ss5', 'ss10'];

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

check(
  'shipped profiles declare the IN endpoint and no OUT endpoint (null, not 0)',
  PROFILES.every((profile) =>
    profile.link.endpoints.in === EP_IN && profile.link.endpoints.out === null),
  PROFILES
    .map((profile) =>
      `${profile.id}: in=${profile.link.endpoints.in} out=${String(profile.link.endpoints.out)}`)
    .join('; '),
);

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
  'an OUT endpoint that is neither null nor a byte',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.link = { ...p.link, endpoints: { in: EP_IN, out: 0x100 } };
  }),
  'link-endpoints',
);
expectInvalid(
  'an omitted OUT endpoint',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.link = {
      ...p.link,
      endpoints: { in: EP_IN } as unknown as DeviceProfile['link']['endpoints'],
    };
  }),
  'link-endpoints',
);
expectInvalid(
  'an OUT endpoint equal to the IN endpoint',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.link = { ...p.link, endpoints: { in: EP_IN, out: EP_IN } };
  }),
  'link-endpoints',
);
{
  const withOut = variant(SLOGIC32U3_PROFILE, (p) => {
    p.link = { ...p.link, endpoints: { in: EP_IN, out: 1 } };
  });
  const result = validateProfile(withOut);
  check(
    'validation accepts a real OUT endpoint distinct from IN',
    result.ok,
    result.ok ? 'accepted in=2 out=1' : `${result.reason}: ${result.detail}`,
  );
}
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
  'an SS10 tier on a 5 Gbit/s-only profile',
  variant(SLOGIC16U3_PROFILE, (p) => {
    p.digital = {
      ...p.digital,
      rates: p.digital.rates.map((tier) => ({
        ...tier,
        hz: { ...tier.hz, ss10: 1e9 },
      })) as DeviceProfile['digital']['rates'],
    };
  }),
  'digital.rates[4ch].hz.undeclared',
);
expectInvalid(
  'an SS5 ceiling above the SS10 ceiling',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = {
      ...p.digital,
      rates: p.digital.rates.map((tier) => ({
        ...tier,
        hz: tier.channels === 4 ? { ...tier.hz, ss5: 2e9 } : tier.hz,
      })) as DeviceProfile['digital']['rates'],
    };
  }),
  'digital.rates[4ch].hz.ordering',
);
expectInvalid(
  'a wider capture offering a higher ceiling than a narrower one',
  variant(SLOGIC32U3_PROFILE, (p) => {
    p.digital = {
      ...p.digital,
      rates: p.digital.rates.map((tier) => ({
        ...tier,
        hz: tier.channels === 32 ? { ...tier.hz, ss10: 800e6 } : tier.hz,
      })) as DeviceProfile['digital']['rates'],
    };
  }),
  'digital-rates-width-ordering',
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
          maxHz: { ss5: first.maxHz.ss5!, usb4: 1 } as DeviceProfile['analog']['groups'][number]['maxHz'],
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
  '32U3 gates analog capability by capture width and link class',
  capabilityReason(SLOGIC32U3_PROFILE, 'analog') === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 8 }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 32 }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 4 }) !== null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 16, analogGroups: 4 }) !== null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 16, analogGroups: 2 }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 8, analogGroups: 2 }) !== null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { channels: 32, analogGroups: 4 }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { linkRate: 'hs' }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { linkRate: 'ss5' }) === null &&
    capabilityReason(SLOGIC32U3_PROFILE, 'analog', { linkRate: 'ss10' }) === null &&
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

{
  const floor = SLOGIC32U3_PROFILE.firmware.min;
  const noVersionRegister = SLOGIC32U3_PROFILE.quirks
    ?.find((quirk) => quirk.id === 'firmware-version-unreadable')?.note ?? '';
  check(
    '32U3 documents the vendor hardware-S/N floor and the absent version register',
    floor === '202610150528' &&
      /^\d{12}$/.test(floor) &&
      floor > '202610120954' &&
      SLOGIC16U3_PROFILE.firmware.min === '0' &&
      noVersionRegister.includes('no firmware version register') &&
      noVersionRegister.includes('documentation') &&
      noVersionRegister.includes('hardware S/N'),
    `32U3 floor=${floor}, 16U3 floor=${SLOGIC16U3_PROFILE.firmware.min}, ` +
      `quirk=${JSON.stringify(noVersionRegister)}`,
  );
}

{
  // The field is an opaque documentation string, not a parsed version: any
  // non-empty string validates and nothing compares it. This pins "no runtime
  // enforcement" without depending on a handshake implementation.
  const documented = variant(SLOGIC32U3_PROFILE, (p) => {
    p.firmware = { min: '1.0.0' };
  });
  const result = validateProfile(documented);
  check(
    'firmware.min is documentation, not a parsed version',
    result.ok,
    result.ok ? 'accepted a dotted documentation string' : `${result.reason}: ${result.detail}`,
  );
}

{
  const edge = SLOGIC32U3_PROFILE.quirks
    ?.find((quirk) => quirk.id === 'ss5-32ch-payload-edge');
  const note = edge?.note ?? '';
  check(
    '32U3 documents the 5G 32ch/100MHz payload edge and keeps 100 MHz offered',
    edge !== undefined &&
      note.includes('400 MB/s') &&
      note.includes('underrun') &&
      note.includes('100 MHz') &&
      note.includes('80 MHz') &&
      note.includes('50 MHz') &&
      note.includes('libsigrok') &&
      /default/i.test(note) &&
      sampleRatesFor(SLOGIC32U3_PROFILE, 32, 'ss5').includes(100e6) &&
      maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'ss5') === 100e6,
    `quirk=${edge === undefined ? 'missing' : JSON.stringify(note)}, ` +
      `32ch/ss5=[${sampleRatesFor(SLOGIC32U3_PROFILE, 32, 'ss5').join(',')}]`,
  );
}

// ---- offered rates ------------------------------------------------------

{
  // libsigrok's link_payload_bps(): 3200 Mbit/s on SuperSpeed (5G), 320 Mbit/s
  // on High Speed. SuperSpeedPlus is device-limited, so SS10 uses the native
  // per-width table.
  const USB2_PAYLOAD_BPS = 320_000_000;
  const USB3_5G_PAYLOAD_BPS = 3_200_000_000;
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
        if (!profile.link.rates.includes(link)) {
          if (rates.length !== 0 || max !== 0) {
            problems.push(`${label} offers a rate on a link the profile does not declare`);
          }
          continue;
        }
        if (rates.length === 0) {
          problems.push(`${label} offers no rate`);
          continue;
        }
        const native = nativeTable[channels]!;
        const ceiling = link === 'hs'
          ? Math.min(native, USB2_PAYLOAD_BPS / channels)
          : link === 'ss5'
            ? Math.min(native, USB3_5G_PAYLOAD_BPS / channels)
            : native;
        for (let i = 0; i < rates.length; i++) {
          const rate = rates[i]!;
          if (!SAMPLERATES_HZ.includes(rate)) problems.push(`${label} invents ${rate} Hz`);
          if (i > 0 && rate <= rates[i - 1]!) problems.push(`${label} is not ascending`);
          if (rate > ceiling) problems.push(`${label} ${rate} exceeds ceiling ${ceiling}`);
        }
        if (max !== rates[rates.length - 1]!) {
          problems.push(`${label} max ${max} is not the last offered rate`);
        }
      }
    }
    for (const link of LINK_RATES) {
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
    'offered rate lists are ascending, within native/link ceilings, and shrink with width',
    problems.length === 0,
    problems.length === 0 ? 'all profiles/widths/links within bounds' : problems.join('; '),
  );
}

check(
  '32U3 declares SS5 and SS10; the 5 Gbit/s 16U3 declares no SS10',
  SLOGIC16U3_PROFILE.link.rates.join(',') === 'fs,hs,ss5' &&
    SLOGIC32U3_PROFILE.link.rates.join(',') === 'fs,hs,ss5,ss10' &&
    !SLOGIC16U3_PROFILE.link.rates.includes('ss10') &&
    sampleRatesFor(SLOGIC16U3_PROFILE, 4, 'ss10').length === 0 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 4, 'ss10') === 0,
  `16U3=[${SLOGIC16U3_PROFILE.link.rates.join(',')}], ` +
    `32U3=[${SLOGIC32U3_PROFILE.link.rates.join(',')}], ` +
    `16U3/4ch/ss10=[${sampleRatesFor(SLOGIC16U3_PROFILE, 4, 'ss10').join(',')}]`,
);

check(
  'sampleRatesFor filters tiers by the negotiated link class',
  maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss5') === 800e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss10') === 1.4e9 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 4, 'ss5') === 800e6 &&
    sampleRatesFor(SLOGIC16U3_PROFILE, 4, 'ss10').length === 0,
  `32U3 4ch ss5=${maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss5')}, ` +
    `32U3 4ch ss10=${maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss10')}, ` +
    `16U3 4ch ss5=${maxSamplerateFor(SLOGIC16U3_PROFILE, 4, 'ss5')}`,
);

check(
  '16U3 keeps its native SS5 tiers and never offers the 32U3-only 1400 MHz rate',
  maxSamplerateFor(SLOGIC16U3_PROFILE, 4, 'ss5') === 800e6 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 8, 'ss5') === 400e6 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 16, 'ss5') === 200e6 &&
    sampleRatesFor(SLOGIC16U3_PROFILE, 4, 'ss5').every((rate) => rate <= 800e6) &&
    !sampleRatesFor(SLOGIC16U3_PROFILE, 16, 'ss5').includes(1.4e9),
  `4/8/16ch/ss5=${[4, 8, 16]
    .map((channels) => maxSamplerateFor(SLOGIC16U3_PROFILE, channels as ChannelCount, 'ss5'))
    .join('/')}, 16ch/ss5=[${sampleRatesFor(SLOGIC16U3_PROFILE, 16, 'ss5').join(',')}]`,
);

check(
  '32U3 uses native ceilings on SS10 and the 5 Gbit/s cap on SS5',
  maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss10') === 1.4e9 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 8, 'ss10') === 800e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 16, 'ss10') === 400e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'ss10') === 200e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 4, 'ss5') === 800e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 8, 'ss5') === 400e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 16, 'ss5') === 200e6 &&
    maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'ss5') === 100e6,
  `ss10 4/8/16/32ch=${[4, 8, 16, 32]
    .map((channels) => maxSamplerateFor(SLOGIC32U3_PROFILE, channels as ChannelCount, 'ss10'))
    .join('/')}, ss5 4/8/16/32ch=${[4, 8, 16, 32]
    .map((channels) => maxSamplerateFor(SLOGIC32U3_PROFILE, channels as ChannelCount, 'ss5'))
    .join('/')}`,
);

check(
  '32U3 32ch on SS5 is capped at 100 MHz, not the 200 MHz native rate',
  maxSamplerateFor(SLOGIC32U3_PROFILE, 32, 'ss5') === 100e6 &&
    sampleRatesFor(SLOGIC32U3_PROFILE, 32, 'ss5').every((rate) => rate <= 100e6) &&
    !sampleRatesFor(SLOGIC32U3_PROFILE, 32, 'ss5').includes(200e6),
  `32ch/ss5=[${sampleRatesFor(SLOGIC32U3_PROFILE, 32, 'ss5').join(',')}]`,
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
    sampleRatesFor(SLOGIC16U3_PROFILE, 64 as ChannelCount, 'ss5').length === 0 &&
    maxSamplerateFor(SLOGIC16U3_PROFILE, 64 as ChannelCount, 'ss5') === 0,
  `fs=[${sampleRatesFor(SLOGIC16U3_PROFILE, 16, 'fs').join(',')}], ` +
    `64ch=[${sampleRatesFor(SLOGIC16U3_PROFILE, 64 as ChannelCount, 'ss5').join(',')}]`,
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
