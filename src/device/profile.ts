// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * DeviceProfile lookup, validation and capability helpers.
 *
 * The profile table itself is data (`profiles.ts`); this file contains the only
 * behaviour it is allowed to have: structural validation, a VID/PID lookup, the
 * offered-rate query and typed capability refusals. Nothing here branches on a
 * profile id or a product name - callers ask about capabilities.
 *
 * Source of truth for the shape: docs/ARCHITECTURE.md §3.2.
 */

import { isChannelCount, type ChannelCount } from '../types.js';
import { SAMPLERATES_HZ } from './protocol.js';
import { PROFILES } from './profiles.js';
import type { DeviceProfile, LinkRate } from './profileTypes.js';

export type {
  AnalogGroup,
  AnalogTriggerKind,
  CalibrationRef,
  DeviceProfile,
  DigitalGroup,
  LinkRate,
  ProfileQuirk,
  RateTier,
  TestMode,
  TriggerKind,
} from './profileTypes.js';
export type { ChannelCount } from '../types.js';
export {
  PROFILES,
  SLOGIC16U3_PROFILE,
  SLOGIC32U3_PROFILE,
} from './profiles.js';

/** Link classes in ascending wire capacity; a slower link can never offer more. */
const LINK_RATES: readonly LinkRate[] = ['fs', 'hs', 'ss5', 'ss10'];
const LINK_RATE_SET: ReadonlySet<string> = new Set<string>(LINK_RATES);
const TRIGGER_KINDS: ReadonlySet<string> = new Set([
  'level', 'rising', 'falling', 'edge', 'high', 'low',
]);
const ANALOG_TRIGGER_KINDS: ReadonlySet<string> = new Set(['rising', 'falling']);
const MODE_KEYS = ['single', 'repeat', 'loop', 'record'] as const;

/** Typed refusal/acceptance result from `validateProfile`. */
export type ProfileValidation =
  | { ok: true }
  | { ok: false; reason: string; detail: string };

function fail(reason: string, detail: string): ProfileValidation {
  return { ok: false, reason, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isByte(value: unknown): value is number {
  return isInteger(value) && value >= 0 && value <= 0xff;
}

function isUint16(value: unknown): value is number {
  return isInteger(value) && value >= 0 && value <= 0xffff;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkLinkRateMap(
  owner: string,
  map: unknown,
  declared: ReadonlySet<string>,
): ProfileValidation | null {
  if (!isRecord(map)) return fail(`${owner}.invalid`, `${owner} must be an object`);
  const keys = Object.keys(map);
  if (keys.length === 0) return fail(`${owner}.empty`, `${owner} has no link rates`);
  for (const key of keys) {
    if (!LINK_RATE_SET.has(key)) {
      return fail(`${owner}.key`, `${owner} has unknown link rate ${JSON.stringify(key)}`);
    }
    if (!declared.has(key)) {
      return fail(
        `${owner}.undeclared`,
        `${owner} uses link rate ${JSON.stringify(key)} that link.rates does not declare`,
      );
    }
    const value = map[key];
    if (!isFiniteNumber(value) || value <= 0) {
      return fail(
        `${owner}.value`,
        `${owner}[${JSON.stringify(key)}] must be a positive finite number, got ${String(value)}`,
      );
    }
  }
  // A slower link cannot sustain more than a faster one. Compare the present
  // keys in wire-capacity order so an hs ceiling above its ss5 ceiling, or an
  // ss5 ceiling above its ss10 ceiling, is refused rather than offered.
  let previousLink: LinkRate | undefined;
  let previousHz = 0;
  for (const link of LINK_RATES) {
    if (!declared.has(link) || !Object.hasOwn(map, link)) continue;
    const value = map[link];
    if (typeof value !== 'number') continue; // rejected above
    if (previousLink !== undefined && value < previousHz) {
      return fail(
        `${owner}.ordering`,
        `${owner}[${link}] is ${value} Hz, below the slower ${previousLink} ceiling of ` +
          `${previousHz} Hz`,
      );
    }
    previousLink = link;
    previousHz = value;
  }
  return null;
}

/**
 * Validate one profile.
 *
 * "Unique" checks compare against `PROFILES`: a candidate that is not one of the
 * table entries must have an id and a VID/PID pair that no table entry already
 * uses. Clone-with-a-new-id candidates therefore pass, while a duplicate row is
 * refused before it can shadow an existing device.
 *
 * Structural checks are deliberately stricter than the type: a profile assembled
 * at runtime (a test fixture, a future profile file) can lie about its arrays, so
 * every group, width, rate and trigger entry is checked for shape and for
 * consistency with the rest of the same profile.
 */
export function validateProfile(p: DeviceProfile): ProfileValidation {
  if (!isRecord(p)) return fail('profile-shape', 'profile must be an object');

  const id: unknown = p.id;
  if (typeof id !== 'string' || id.length === 0) {
    return fail('id-empty', 'profile id must be a non-empty string');
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    return fail(
      'id-format',
      `profile id ${JSON.stringify(id)} must match ^[a-z0-9][a-z0-9._-]*$`,
    );
  }
  if (typeof p.name !== 'string' || p.name.trim().length === 0) {
    return fail('name-empty', 'profile name must be a non-empty string');
  }
  if (!isUint16(p.vid)) return fail('vid-invalid', `vid ${String(p.vid)} is not a 16-bit value`);
  if (!isUint16(p.pid)) return fail('pid-invalid', `pid ${String(p.pid)} is not a 16-bit value`);
  for (const other of PROFILES) {
    if (other !== p && other.id === id) {
      return fail('id-duplicate', `profile id ${JSON.stringify(id)} is already used by ${other.id}`);
    }
  }
  for (const other of PROFILES) {
    if (other !== p && other.vid === p.vid && other.pid === p.pid) {
      return fail(
        'vid-pid-duplicate',
        `VID/PID ${p.vid.toString(16)}:${p.pid.toString(16)} is already used by ${other.id}`,
      );
    }
  }
  if (p.serial !== undefined) {
    if (!isRecord(p.serial) || typeof p.serial.required !== 'boolean') {
      return fail('serial-invalid', 'serial, when present, must be { required: boolean }');
    }
  }

  // ---- link ---------------------------------------------------------------
  const link: unknown = p.link;
  if (!isRecord(link)) return fail('link-missing', 'link must be an object');
  if (link.interfaceClass !== 0xff) {
    return fail(
      'link-interface-class',
      `link.interfaceClass must be 0xff, got ${String(link.interfaceClass)}`,
    );
  }
  const endpoints: unknown = link.endpoints;
  if (!isRecord(endpoints)) return fail('link-endpoints', 'link.endpoints must be an object');
  if (!isByte(endpoints.in)) {
    return fail(
      'link-endpoints',
      `link.endpoints.in must be a byte, got ${String(endpoints.in)}`,
    );
  }
  // `out: null` is the honest "no OUT endpoint" value; a number is a real OUT
  // endpoint. `undefined` (a missing field) is not accepted as either.
  if (endpoints.out !== null && !isByte(endpoints.out)) {
    return fail(
      'link-endpoints',
      `link.endpoints.out must be null (no OUT endpoint) or a byte, got ` +
        `${String(endpoints.out)}`,
    );
  }
  if (endpoints.out !== null && endpoints.out === endpoints.in) {
    return fail(
      'link-endpoints',
      `link.endpoints.in and .out must differ when an OUT endpoint exists, both are ` +
        `${endpoints.in}`,
    );
  }
  const maxTransferBytes: unknown = link.maxTransferBytes;
  if (!isPositiveInteger(maxTransferBytes) || maxTransferBytes % 1024 !== 0) {
    return fail(
      'link-max-transfer',
      `link.maxTransferBytes must be a positive multiple of 1024, got ${String(maxTransferBytes)}`,
    );
  }
  const rates: unknown = link.rates;
  if (!Array.isArray(rates) || rates.length === 0) {
    return fail('link-rates', 'link.rates must be a non-empty array');
  }
  const declaredRates = new Set<string>();
  for (const rate of rates) {
    if (typeof rate !== 'string' || !LINK_RATE_SET.has(rate)) {
      return fail('link-rates', `link.rates contains unknown value ${JSON.stringify(rate)}`);
    }
    if (declaredRates.has(rate)) {
      return fail('link-rates', `link.rates contains ${rate} more than once`);
    }
    declaredRates.add(rate);
  }
  const probe: unknown = link.probe;
  if (!isRecord(probe) || !isPositiveInteger(probe.bytes) || !isPositiveInteger(probe.bursts)) {
    return fail(
      'link-probe',
      'link.probe must be { bytes: positive integer, bursts: positive integer }',
    );
  }

  // ---- digital ------------------------------------------------------------
  const digital: unknown = p.digital;
  if (!isRecord(digital)) return fail('digital-missing', 'digital must be an object');
  const maxChannels: unknown = digital.maxChannels;
  if (!isChannelCount(maxChannels as number)) {
    return fail(
      'digital-max-channels',
      `digital.maxChannels must be one of 4, 8, 16, 32, 64, 128, got ${String(maxChannels)}`,
    );
  }
  const max = maxChannels as ChannelCount;

  const widths: unknown = digital.widths;
  if (!Array.isArray(widths) || widths.length === 0) {
    return fail('digital-widths', 'digital.widths must be a non-empty array');
  }
  const widthSet = new Set<number>();
  let previousWidth = 0;
  for (const width of widths) {
    if (!isChannelCount(width as number)) {
      return fail('digital-widths', `digital.widths contains invalid width ${String(width)}`);
    }
    if ((width as number) <= previousWidth) {
      return fail(
        'digital-widths-order',
        `digital.widths must be strictly ascending, got ${widths.join(', ')}`,
      );
    }
    if ((width as number) > max) {
      return fail(
        'digital-widths-range',
        `digital.widths offers ${String(width)} channels but maxChannels is ${max}`,
      );
    }
    previousWidth = width as number;
    widthSet.add(width as number);
  }
  if (!widthSet.has(max)) {
    return fail(
      'digital-widths-max',
      `digital.widths must include maxChannels (${max}), got ${widths.join(', ')}`,
    );
  }

  const groups: unknown = digital.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return fail('digital-groups', 'digital.groups must be a non-empty array');
  }
  let expectedStart = 0;
  for (const group of groups) {
    if (!isRecord(group)) return fail('digital-groups', 'every digital group must be an object');
    const start: unknown = group.start;
    const channels: unknown = group.channels;
    if (!isNonNegativeInteger(start) || !isPositiveInteger(channels)) {
      return fail(
        'digital-groups-shape',
        `digital group needs integer start >= 0 and channels > 0, got start=${String(start)} ` +
          `channels=${String(channels)}`,
      );
    }
    if (start !== expectedStart) {
      return fail(
        'digital-groups-coverage',
        `digital groups must tile 0..${max} contiguously; expected start ${expectedStart}, ` +
          `got ${start}`,
      );
    }
    expectedStart = start + channels;
    if (expectedStart > max) {
      return fail(
        'digital-groups-range',
        `digital groups cover through channel ${expectedStart - 1}, beyond maxChannels ${max}`,
      );
    }
  }
  if (expectedStart !== max) {
    return fail(
      'digital-groups-coverage',
      `digital groups cover 0..${expectedStart - 1}, expected 0..${max - 1}`,
    );
  }

  const tiers: unknown = digital.rates;
  if (!Array.isArray(tiers) || tiers.length !== widths.length) {
    return fail(
      'digital-rates-coverage',
      `digital.rates must have one tier per width (${widths.length}), got ` +
        `${Array.isArray(tiers) ? tiers.length : String(tiers)}`,
    );
  }
  const tierWidths = new Set<number>();
  const tierMaps: { channels: ChannelCount; hz: Record<string, unknown> }[] = [];
  for (const tier of tiers) {
    if (!isRecord(tier)) return fail('digital-rates', 'every rate tier must be an object');
    const channels: unknown = tier.channels;
    if (!isChannelCount(channels as number) || !widthSet.has(channels as number)) {
      return fail(
        'digital-rates-width',
        `rate tier channels ${String(channels)} is not an offered width`,
      );
    }
    if (tierWidths.has(channels as number)) {
      return fail('digital-rates-duplicate', `duplicate rate tier for ${String(channels)} channels`);
    }
    tierWidths.add(channels as number);
    const problem = checkLinkRateMap(
      `digital.rates[${String(channels)}ch].hz`,
      tier.hz,
      declaredRates,
    );
    if (problem) return problem;
    if (tier.recommendedHz !== undefined) {
      const owner = `digital.rates[${String(channels)}ch].recommendedHz`;
      const advice = checkLinkRateMap(owner, tier.recommendedHz, declaredRates);
      if (advice) return advice;
      const hz = tier.hz as Record<string, unknown>;
      for (const [link, value] of Object.entries(tier.recommendedHz as Record<string, number>)) {
        const ceiling = hz[link];
        if (typeof ceiling !== 'number' || value > ceiling) {
          return fail(
            `${owner}.ceiling`,
            `${owner}[${JSON.stringify(link)}] is ${value} Hz, above the ${link} ceiling of ` +
              `${String(ceiling)} Hz`,
          );
        }
      }
    }
    tierMaps.push({ channels: channels as ChannelCount, hz: tier.hz as Record<string, unknown> });
  }
  for (const width of widthSet) {
    if (!tierWidths.has(width)) {
      return fail('digital-rates-coverage', `no rate tier for ${width} channels`);
    }
  }

  // A wider capture samples the same wire, so its per-channel ceiling can only
  // stay or fall. Check each link class independently, ascending by width.
  const ascendingTiers = [...tierMaps].sort((a, b) => a.channels - b.channels);
  for (const link of LINK_RATES) {
    let previous: { channels: ChannelCount; hz: number } | undefined;
    for (const tier of ascendingTiers) {
      const value = tier.hz[link];
      if (typeof value !== 'number') continue;
      if (previous !== undefined && value > previous.hz) {
        return fail(
          'digital-rates-width-ordering',
          `${link} ceiling for ${tier.channels} channels (${value} Hz) is above the ` +
            `${previous.channels}-channel ceiling (${previous.hz} Hz)`,
        );
      }
      previous = { channels: tier.channels, hz: value };
    }
  }

  const threshold: unknown = digital.thresholdVolts;
  if (threshold !== null) {
    if (!Array.isArray(threshold) || threshold.length === 0) {
      return fail(
        'digital-threshold',
        'digital.thresholdVolts must be null or a non-empty array',
      );
    }
    for (const volts of threshold) {
      if (!isFiniteNumber(volts)) {
        return fail('digital-threshold', `threshold ${String(volts)} is not a finite number`);
      }
    }
  }

  if (digital.sampleratesHz !== undefined) {
    const offered: unknown = digital.sampleratesHz;
    if (!Array.isArray(offered) || offered.length === 0) {
      return fail('digital-samplerates', 'digital.sampleratesHz must be a non-empty array when present');
    }
    let previous = 0;
    for (const hz of offered) {
      if (!isFiniteNumber(hz) || hz <= 0) {
        return fail('digital-samplerates', `samplerate ${String(hz)} is not a positive finite number`);
      }
      if (hz <= previous) {
        return fail('digital-samplerates-order', 'digital.sampleratesHz must be strictly ascending');
      }
      previous = hz;
    }
  }

  const testModes: unknown = digital.testModes;
  if (!Array.isArray(testModes) || testModes.length === 0) {
    return fail('digital-test-modes', 'digital.testModes must be a non-empty array');
  }
  const seenTestModes = new Set<number>();
  for (const mode of testModes) {
    if (mode !== 0 && mode !== 1 && mode !== 2) {
      return fail('digital-test-modes', `test mode ${String(mode)} is not 0, 1 or 2`);
    }
    if (seenTestModes.has(mode)) {
      return fail('digital-test-modes', `test mode ${String(mode)} appears more than once`);
    }
    seenTestModes.add(mode);
  }
  if (seenTestModes.has(2) &&
      digital.emulationPattern !== 'slogic16u3' &&
      digital.emulationPattern !== 'slogic32u3') {
    return fail(
      'digital-emulation-pattern',
      'digital.emulationPattern must name the test-mode-2 table when that mode is offered',
    );
  }

  // ---- analog -------------------------------------------------------------
  const analog: unknown = p.analog;
  if (!isRecord(analog)) return fail('analog-missing', 'analog must be an object');
  const analogGroups: unknown = analog.groups;
  if (!Array.isArray(analogGroups)) {
    return fail('analog-groups', 'analog.groups must be an array (possibly empty)');
  }
  let analogEnd = 0;
  for (const group of analogGroups) {
    if (!isRecord(group)) return fail('analog-groups', 'every analog group must be an object');
    const start: unknown = group.start;
    const channels: unknown = group.channels;
    if (!isNonNegativeInteger(start) || !isPositiveInteger(channels)) {
      return fail(
        'analog-groups-shape',
        `analog group needs integer start >= 0 and channels > 0, got start=${String(start)} ` +
          `channels=${String(channels)}`,
      );
    }
    if (start < analogEnd) {
      return fail(
        'analog-groups-order',
        `analog groups must be sorted and non-overlapping; ${start} starts inside the previous group`,
      );
    }
    analogEnd = start + channels;
    if (analogEnd > max) {
      return fail(
        'analog-groups-range',
        `analog group ${start}..${analogEnd - 1} exceeds maxChannels ${max}`,
      );
    }
    const ranges: unknown = group.ranges;
    if (!Array.isArray(ranges) || ranges.length === 0) {
      return fail(
        'analog-ranges',
        `analog group at ${start} must declare at least one full-scale range`,
      );
    }
    let previousRange = 0;
    for (const range of ranges) {
      if (!isFiniteNumber(range) || range <= 0) {
        return fail(
          'analog-ranges',
          `analog range ${String(range)} at group ${start} must be a positive finite number`,
        );
      }
      if (range <= previousRange) {
        return fail(
          'analog-ranges-order',
          `analog ranges at group ${start} must be strictly ascending, got ${ranges.join(', ')}`,
        );
      }
      previousRange = range;
    }
    const bits: unknown = group.resolutionBits;
    if (!isInteger(bits) || bits < 1 || bits > 32) {
      return fail(
        'analog-resolution',
        `analog group at ${start} needs resolutionBits in 1..32, got ${String(bits)}`,
      );
    }
    const problem = checkLinkRateMap(
      `analog.groups[${start}].maxHz`,
      group.maxHz,
      declaredRates,
    );
    if (problem) return problem;
  }
  const calibration: unknown = analog.calibration;
  if (!isRecord(calibration)) {
    return fail('analog-calibration', 'analog.calibration must be an object');
  }
  if (typeof calibration.id !== 'string' || calibration.id.trim().length === 0) {
    return fail('analog-calibration', 'analog.calibration.id must be a non-empty string');
  }
  if (!isNonNegativeInteger(calibration.version)) {
    return fail(
      'analog-calibration',
      `analog.calibration.version must be a non-negative integer, got ${String(calibration.version)}`,
    );
  }

  // ---- trigger ------------------------------------------------------------
  const trigger: unknown = p.trigger;
  if (!isRecord(trigger)) return fail('trigger-missing', 'trigger must be an object');
  if (trigger.execution !== 'device' && trigger.execution !== 'host') {
    return fail(
      'trigger-execution',
      `trigger.execution must be 'device' or 'host', got ${String(trigger.execution)}`,
    );
  }
  const digitalKinds: unknown = trigger.digital;
  if (!Array.isArray(digitalKinds)) {
    return fail('trigger-digital', 'trigger.digital must be an array');
  }
  const seenDigital = new Set<string>();
  for (const kind of digitalKinds) {
    if (typeof kind !== 'string' || !TRIGGER_KINDS.has(kind)) {
      return fail('trigger-digital', `unknown digital trigger kind ${JSON.stringify(kind)}`);
    }
    if (seenDigital.has(kind)) {
      return fail('trigger-digital', `digital trigger kind ${kind} appears more than once`);
    }
    seenDigital.add(kind);
  }
  const analogKinds: unknown = trigger.analog;
  if (!Array.isArray(analogKinds)) {
    return fail('trigger-analog', 'trigger.analog must be an array');
  }
  const seenAnalog = new Set<string>();
  for (const kind of analogKinds) {
    if (typeof kind !== 'string' || !ANALOG_TRIGGER_KINDS.has(kind)) {
      return fail('trigger-analog', `unknown analog trigger kind ${JSON.stringify(kind)}`);
    }
    if (seenAnalog.has(kind)) {
      return fail('trigger-analog', `analog trigger kind ${kind} appears more than once`);
    }
    seenAnalog.add(kind);
  }
  if (analogKinds.length > 0 && analogGroups.length === 0) {
    return fail(
      'trigger-analog-without-analog',
      'trigger.analog lists crossing kinds but the profile has no analog groups',
    );
  }
  if (typeof trigger.mixed !== 'boolean') {
    return fail('trigger-mixed', `trigger.mixed must be boolean, got ${String(trigger.mixed)}`);
  }
  if (trigger.mixed && (digitalKinds.length === 0 || analogKinds.length === 0)) {
    return fail(
      'trigger-mixed',
      'trigger.mixed requires at least one digital and one analog condition kind',
    );
  }
  const preTriggerPercent: unknown = trigger.preTriggerMaxPercent;
  if (!isFiniteNumber(preTriggerPercent) || preTriggerPercent < 0 || preTriggerPercent > 100) {
    return fail(
      'trigger-pre-trigger-percent',
      `trigger.preTriggerMaxPercent must be in 0..100, got ${String(preTriggerPercent)}`,
    );
  }
  const preTriggerBytes: unknown = trigger.preTriggerMaxBytes;
  if (!isPositiveInteger(preTriggerBytes)) {
    return fail(
      'trigger-pre-trigger-bytes',
      `trigger.preTriggerMaxBytes must be a positive integer, got ${String(preTriggerBytes)}`,
    );
  }

  // ---- modes, firmware, quirks -------------------------------------------
  const modes: unknown = p.modes;
  if (!isRecord(modes)) return fail('modes-missing', 'modes must be an object');
  for (const key of MODE_KEYS) {
    if (typeof modes[key] !== 'boolean') {
      return fail('modes-value', `modes.${key} must be boolean, got ${String(modes[key])}`);
    }
  }
  if (!modes.single && !modes.repeat && !modes.loop && !modes.record) {
    return fail('modes-none', 'a profile must enable at least one capture mode');
  }

  const firmware: unknown = p.firmware;
  if (!isRecord(firmware) || typeof firmware.min !== 'string' || firmware.min.trim().length === 0) {
    return fail('firmware-min', 'firmware.min must be a non-empty string');
  }

  if (p.quirks !== undefined) {
    const quirks: unknown = p.quirks;
    if (!Array.isArray(quirks)) return fail('quirks', 'quirks must be an array when present');
    const seenQuirks = new Set<string>();
    for (const quirk of quirks) {
      if (!isRecord(quirk)) return fail('quirks', 'every quirk must be an object');
      if (typeof quirk.id !== 'string' || quirk.id.trim().length === 0) {
        return fail('quirks', 'quirk.id must be a non-empty string');
      }
      if (typeof quirk.note !== 'string' || quirk.note.trim().length === 0) {
        return fail('quirks', `quirk ${quirk.id} must have a non-empty note`);
      }
      if (seenQuirks.has(quirk.id)) {
        return fail('quirks', `quirk id ${quirk.id} appears more than once`);
      }
      seenQuirks.add(quirk.id);
    }
  }

  return { ok: true };
}

/** Look up the profile for a USB VID/PID pair, or null when it is not ours. */
export function profileForVidPid(vid: number, pid: number): DeviceProfile | null {
  for (const profile of PROFILES) {
    if (profile.vid === vid && profile.pid === pid) return profile;
  }
  return null;
}

/**
 * The discrete samplerates this profile offers for a capture width on a link
 * class, ascending. An absent tier or an absent link-rate ceiling yields no
 * offer: the profile never guesses a rate for a link it has no evidence for
 * (FS and, on the 16U3, SS10 are the expected empty answers).
 */
export function sampleRatesFor(
  profile: DeviceProfile,
  channels: ChannelCount,
  linkRate: LinkRate,
): readonly number[] {
  if (!profile.digital.widths.includes(channels)) return [];
  const tier = profile.digital.rates.find((candidate) => candidate.channels === channels);
  if (!tier) return [];
  const ceiling = tier.hz[linkRate];
  if (ceiling === undefined) return [];
  const table = profile.digital.sampleratesHz ?? SAMPLERATES_HZ;
  return table.filter((hz) => hz <= ceiling);
}

/** Highest offered rate for a capture width and link, or 0 when none is offered. */
export function maxSamplerateFor(
  profile: DeviceProfile,
  channels: ChannelCount,
  linkRate: LinkRate,
): number {
  const rates = sampleRatesFor(profile, channels, linkRate);
  return rates.length === 0 ? 0 : rates[rates.length - 1]!;
}

/**
 * The rate a capture of this width should default to, per width, or no entry when the
 * profile has no measured reason to default below the ceiling. A known link reads its
 * own recommendation; `null` is a link class WebUSB did not name (it never reports
 * FS/HS/SS), and then the lowest recommendation any link declares is the answer -
 * defaulting to a rate the slower link cannot sustain is the failure this field exists
 * to avoid. Links without a recommendation (HS, whose ceiling is far lower) are not
 * consulted: with no class known the ceiling table is the native one, and the
 * recommendation is only ever a default the user may raise. Each value is an offered
 * rate.
 */
export function recommendedSamplerateHzFor(
  profile: DeviceProfile,
  linkRate: LinkRate | null,
): Readonly<Record<number, number>> {
  const table = profile.digital.sampleratesHz ?? SAMPLERATES_HZ;
  const out: Record<number, number> = {};
  for (const tier of profile.digital.rates) {
    const advice = tier.recommendedHz;
    if (!advice) continue;
    const values = linkRate === null
      ? Object.values(advice).filter((hz): hz is number => typeof hz === 'number')
      : typeof advice[linkRate] === 'number' ? [advice[linkRate]] : [];
    if (values.length === 0) continue;
    const target = Math.min(...values);
    const offered = table.filter((hz) => hz <= target);
    if (offered.length > 0) out[tier.channels] = offered[offered.length - 1]!;
  }
  return out;
}

/** Capability families a caller can ask about before offering a control. */
export type CapabilityFeature =
  | 'digital'
  | 'analog'
  | 'mixed-trigger'
  | 'record'
  | 'loop'
  | 'repeat'
  | 'serial';

/** Narrowing context for a capability question; every field is optional. */
export interface CapabilityContext {
  /** Capture width the caller intends to use. */
  channels?: ChannelCount;
  /** Negotiated link class; FS/HS/SS5/SS10 is invisible to WebUSB and comes from the probe. */
  linkRate?: LinkRate;
  /** Number of analog groups the caller wants active. */
  analogGroups?: number;
}

function supportedWidths(profile: DeviceProfile): string {
  return profile.digital.widths.join(', ');
}

/**
 * Why `feature` is unavailable on this profile, or null when it is available.
 *
 * The reason is user-facing prose, not a diagnostic code: the caller decides how
 * to present it (a disabled control's hint, a panel note, a typed refusal). A
 * non-null answer with no context means the profile lacks the capability
 * entirely; with a context it may instead mean the requested width or link rate
 * is not offered.
 */
export function capabilityReason(
  profile: DeviceProfile,
  feature: CapabilityFeature,
  context: CapabilityContext = {},
): string | null {
  switch (feature) {
    case 'digital': {
      if (profile.digital.groups.length === 0 || profile.digital.widths.length === 0) {
        return `${profile.name} has no digital capture paths.`;
      }
      if (context.channels !== undefined &&
          !profile.digital.widths.includes(context.channels)) {
        return `${profile.name} does not offer ${context.channels} digital channels; ` +
          `offered widths are ${supportedWidths(profile)}.`;
      }
      if (context.linkRate !== undefined &&
          !profile.digital.rates.some((tier) => tier.hz[context.linkRate!] !== undefined)) {
        return `${profile.name} offers no digital sample rate on a ${context.linkRate} link.`;
      }
      return null;
    }
    case 'analog': {
      if (profile.analog.groups.length === 0) {
        return `${profile.name} has no analog converter inputs.`;
      }
      if (context.channels !== undefined) {
        const fits = profile.analog.groups.some(
          (group) => group.start + group.channels <= context.channels!,
        );
        if (!fits) {
          const ranges = profile.analog.groups
            .map((group) => `${group.start}..${group.start + group.channels - 1}`)
            .join(', ');
          return `${profile.name} needs a complete analog group inside the capture width; ` +
            `${context.channels} channels fits none of ${ranges}.`;
        }
      }
      if (context.analogGroups !== undefined &&
          (context.analogGroups < 0 || context.analogGroups > profile.analog.groups.length)) {
        return `${profile.name} has ${profile.analog.groups.length} analog group(s); ` +
          `cannot enable ${context.analogGroups}.`;
      }
      if (context.channels !== undefined && context.analogGroups !== undefined) {
        const fitting = profile.analog.groups.filter(
          (group) => group.start + group.channels <= context.channels!,
        ).length;
        if (context.analogGroups > fitting) {
          return `${profile.name} can read ${fitting} complete analog group(s) at ` +
            `${context.channels} channels; cannot enable ${context.analogGroups}.`;
        }
      }
      if (context.linkRate !== undefined &&
          !profile.analog.groups.some(
            (group) => group.maxHz[context.linkRate!] !== undefined,
          )) {
        return `${profile.name} offers no analog sample rate on a ${context.linkRate} link.`;
      }
      return null;
    }
    case 'mixed-trigger': {
      if (profile.trigger.mixed) return null;
      return `${profile.name} executes one trigger family at a time; mixed ` +
        'digital and analog conditions require profile.trigger.mixed.';
    }
    case 'record':
      return profile.modes.record ? null : `${profile.name} does not support recording.`;
    case 'loop':
      return profile.modes.loop ? null : `${profile.name} does not support loop capture.`;
    case 'repeat':
      return profile.modes.repeat ? null : `${profile.name} does not support repeat capture.`;
    case 'serial':
      // Both U3 models expose a WebUSB serial, but the browser scopes it to the
      // origin (and some browsers randomise it), so it cannot be a stable unit
      // identifier. A profile that marks serial.required still gets this answer
      // through the handshake; the capability here is stable serial identity.
      return profile.serial?.required
        ? null
        : `${profile.name} does not require a stable serial number; WebUSB's serial ` +
          'is origin-scoped, so reconnect after a port change needs the device selected again.';
    default:
      return `unknown capability ${String(feature)}`;
  }
}
