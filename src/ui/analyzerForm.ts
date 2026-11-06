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

const fold = (s: string): string => s.trim().toLowerCase().replace(/[\s\-_]+/g, '');

/**
 * The mapping a freshly picked decoder starts with.
 *
 * 1. A decoder channel whose id or name equals a capture channel's name ("SDA" on a row
 *    named "sda") takes that channel.
 * 2. Unassigned required channels take the lowest unused enabled channels in order.
 * 3. A decoder with no required channels (UART: RX and TX are both optional) still gets
 *    its first channel assigned, so the form never starts as a decoder that reads
 *    nothing - the user then moves it to the real wire.
 */
export function defaultChannelMapping(
  info: FormDecoder, enabled: readonly FormChannel[],
): Record<number, number> {
  const all = [...info.channels, ...info.optional_channels];
  const out: Record<number, number> = {};
  const used = new Set<number>();
  all.forEach((ch, i) => {
    const want = new Set([fold(ch.id), fold(ch.name)]);
    const hit = enabled.find((c) => !used.has(c.index) && c.name !== '' && want.has(fold(c.name)));
    if (hit) { out[i] = hit.index; used.add(hit.index); }
  });
  const nextFree = (): number | undefined => enabled.find((c) => !used.has(c.index))?.index;
  info.channels.forEach((_, i) => {
    if (out[i] !== undefined) return;
    const free = nextFree() ?? enabled[0]?.index;
    if (free === undefined) return;
    out[i] = free;
    used.add(free);
  });
  if (all.length > 0 && Object.keys(out).length === 0) {
    const free = nextFree();
    if (free !== undefined) out[0] = free;
  }
  return out;
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
