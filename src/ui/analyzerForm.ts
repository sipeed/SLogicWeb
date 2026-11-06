// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure helpers behind the analyzer form: the default channel mapping, which options are
 * shown up front, and what happens to attached analyzers when new data arrives.
 *
 * Kept out of analyzerPanel.ts so they run under node in analyzer-form-selftest.ts.
 */

import type { DecoderChannelInfo, DecoderOptionInfo } from '../decode/index.js';

export interface FormDecoder {
  readonly id: string;
  readonly channels: readonly DecoderChannelInfo[];
  readonly optional_channels: readonly DecoderChannelInfo[];
  readonly options: readonly DecoderOptionInfo[];
}

export interface FormChannel {
  readonly index: number;
  readonly name: string;
}

/** Letters and digits only, lower case: "CS#" -> "cs", "CAN RX" -> "canrx". */
const alnum = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Other names a wire commonly carries, per decoder channel id. [CHOICE] Only names that
 * mean one thing: "SDO"/"SDI" are left out (device- vs host-relative), as are a bare
 * "D", "IO" or "DATA".
 */
export const CHANNEL_NAME_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  clk: ['sck', 'sclk', 'clock'],
  cs: ['ss', 'nss', 'csn', 'ncs'],
  mosi: ['copi'],
  miso: ['cipo'],
  rx: ['rxd'],
  tx: ['txd'],
  owr: ['dq', 'ow', '1wire', 'onewire'],
  can_rx: ['can', 'canrx'],
};

/**
 * The words of a capture channel name for matching: the whole name folded
 * ("CAN_RX" -> "canrx"), then each run of letters and digits, also without its
 * trailing digits ("MOSI0" -> "mosi0", "mosi"). A protocol prefix or suffix therefore
 * just becomes another word ("UART_TX" -> uart, tx; "I2C_SDA" -> i2c, sda).
 */
export function channelNameWords(name: string): Set<string> {
  const out = new Set<string>();
  const whole = alnum(name);
  if (whole === '') return out;
  out.add(whole);
  for (const word of name.normalize('NFKC').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word === '') continue;
    out.add(word);
    const bare = word.replace(/[0-9]+$/, '');
    if (bare !== '') out.add(bare);
  }
  return out;
}

/** The names that select a decoder channel: its id, its name and their synonyms. */
function channelWants(ch: DecoderChannelInfo): Set<string> {
  const want = new Set<string>();
  for (const s of [ch.id, ch.name, ...(CHANNEL_NAME_SYNONYMS[ch.id] ?? [])]) {
    const a = alnum(s);
    if (a !== '') want.add(a);
  }
  return want;
}

export interface SeededMapping {
  /** Decoder channel index (required first, then optional) -> capture channel index. */
  readonly mapping: Record<number, number>;
  /** Decoder channel indices whose capture channel was found by the channel's name. */
  readonly nameMatched: readonly number[];
}

/**
 * The mapping a picked decoder starts with, keeping what the user chose by hand.
 *
 * `fixed` holds the decoder channels the user set explicitly (a value < 0 is an explicit
 * "none"); they are copied as they are and their capture channels are taken first.
 *
 * 1. Name match, whole name: a decoder channel whose id, name or synonym equals a
 *    capture channel's whole name ("SDA" on a row named "sda", "CAN RX" on "can_rx").
 * 2. Name match, by word: a capture name with the decoder channel's id, name or a
 *    synonym as one of its words ("UART_TX" -> TX, "I2C_SDA" -> SDA, "MOSI0" -> MOSI,
 *    "SCK" -> CLK). Each capture channel is used once, the lowest index first.
 * 3. Unassigned required channels take the lowest unused enabled channels in order.
 * 4. A decoder with no required channels (UART: RX and TX are both optional) and
 *    nothing set by hand still gets its first channel assigned, so the form never
 *    starts as a decoder that reads nothing - the user then moves it to the real wire.
 *
 * Generic names ("D0", or an empty name) never match: the caller passes '' for them.
 */
export function seedChannelMapping(
  info: FormDecoder, enabled: readonly FormChannel[],
  fixed: Readonly<Record<number, number>> = {},
): SeededMapping {
  const all = [...info.channels, ...info.optional_channels];
  const out: Record<number, number> = {};
  const used = new Set<number>();
  const isFixed = (i: number): boolean => Object.prototype.hasOwnProperty.call(fixed, i);
  all.forEach((_, i) => {
    if (!isFixed(i)) return;
    const v = fixed[i]!;
    if (v >= 0) { out[i] = v; used.add(v); }
  });
  const nameMatched: number[] = [];
  const named = enabled.filter((c) => c.name.trim() !== '');
  const wants = all.map(channelWants);
  const byName = (hit: (c: FormChannel, i: number) => boolean): void => {
    all.forEach((_, i) => {
      if (isFixed(i) || out[i] !== undefined) return;
      const c = named.find((ch) => !used.has(ch.index) && hit(ch, i));
      if (c) { out[i] = c.index; used.add(c.index); nameMatched.push(i); }
    });
  };
  byName((c, i) => wants[i]!.has(alnum(c.name)));
  byName((c, i) => [...channelNameWords(c.name)].some((w) => wants[i]!.has(w)));
  const nextFree = (): number | undefined => enabled.find((c) => !used.has(c.index))?.index;
  info.channels.forEach((_, i) => {
    if (out[i] !== undefined || isFixed(i)) return;
    const free = nextFree() ?? enabled[0]?.index;
    if (free === undefined) return;
    out[i] = free;
    used.add(free);
  });
  if (all.length > 0 && Object.keys(out).length === 0 && Object.keys(fixed).length === 0) {
    const free = nextFree();
    if (free !== undefined) out[0] = free;
  }
  nameMatched.sort((a, b) => a - b);
  return { mapping: out, nameMatched };
}

/** `seedChannelMapping` with nothing set by hand; the mapping only. */
export function defaultChannelMapping(
  info: FormDecoder, enabled: readonly FormChannel[],
): Record<number, number> {
  return seedChannelMapping(info, enabled).mapping;
}

/**
 * sigrok's "-1 = off" convention for a free integer option (UART `rx_packet_delim`,
 * `tx_packet_len`, ...): default -1 and no constrained values. The form shows it as
 * "off" with an empty field; the stored value stays -1. [ASSUMPTION] A free int option
 * defaulting to -1 means "disabled" - true for every stock decoder the picker lists. A
 * constrained list that contains -1 (ook_vis `syncoffset`, a real offset) is not affected.
 */
export const OPTION_OFF_SENTINEL = -1;

export function isOffSentinelOption(opt: DecoderOptionInfo): boolean {
  return opt.type === 'int' && opt.values.length === 0 && opt.default === OPTION_OFF_SENTINEL;
}

/** The field text for an option value: empty (the "off" placeholder shows) for the sentinel. */
export function optionFieldText(opt: DecoderOptionInfo, value: string | number): string {
  return isOffSentinelOption(opt) && Number(value) === OPTION_OFF_SENTINEL ? '' : String(value);
}

/** The raw text a field stores: an emptied off-sentinel field is the sentinel again. */
export function optionFieldRaw(opt: DecoderOptionInfo, text: string): string {
  return isOffSentinelOption(opt) && text.trim() === '' ? String(OPTION_OFF_SENTINEL) : text;
}

/** True when the mapping reads no channel at all (only possible with all-optional channels). */
export function mapsNoChannel(info: FormDecoder, channels: Readonly<Record<number, number>>): boolean {
  const total = info.channels.length + info.optional_channels.length;
  return total > 0 && !Object.values(channels).some((v) => v >= 0);
}

/**
 * Options that matter for most captures, per decoder; the rest sit behind an
 * "Advanced options" disclosure. [CHOICE] sigrok has no notion of a required option, so
 * this is curated for the decoders people attach most and otherwise falls back to the
 * decoder's first `FALLBACK_PRIMARY` options (decoders list their important options first).
 */
export const PRIMARY_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  uart: ['baudrate', 'data_bits', 'parity', 'stop_bits', 'format'],
  can: ['nominal_bitrate', 'fast_bitrate'],
};
export const FALLBACK_PRIMARY = 5;

export function splitDecoderOptions<T extends { readonly id: string }>(
  decoderId: string, options: readonly T[],
): { primary: T[]; advanced: T[] } {
  const curated = PRIMARY_OPTIONS[decoderId];
  if (curated) {
    return {
      primary: options.filter((o) => curated.includes(o.id)),
      advanced: options.filter((o) => !curated.includes(o.id)),
    };
  }
  return { primary: options.slice(0, FALLBACK_PRIMARY), advanced: options.slice(FALLBACK_PRIMARY) };
}

/** The options worth storing: values that differ from the decoder default. */
export function changedOptions(
  info: FormDecoder, options: Readonly<Record<string, string | number>>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const opt of info.options) {
    const v = options[opt.id];
    if (v === undefined) continue;
    if (opt.default !== null && String(opt.default) === String(v)) continue;
    out[opt.id] = v;
  }
  return out;
}

export interface MappedAnalyzer {
  readonly id: string;
  readonly channels: Readonly<Record<number, number>>;
}

/**
 * What a newly opened file does to the attached analyzers. [CHOICE] An analyzer is kept
 * when every channel it maps exists in the new capture (it is then re-decoded); one that
 * maps a channel the file does not have is dropped, and the caller states which ones in
 * the analyzer panel. Channel names are not compared: sigrok files usually carry the
 * generic "D0..Dn" names, so a name mismatch says nothing about the wiring.
 */
export function reconcileAnalyzers<T extends MappedAnalyzer>(
  analyzers: readonly T[], channelCount: number,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const a of analyzers) {
    const fits = Object.values(a.channels).every((v) => v < 0 || v < channelCount);
    (fits ? kept : dropped).push(a);
  }
  return { kept, dropped };
}
