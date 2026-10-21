// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { translateDecoder } from './i18n.js';
import type { SelectOptionTuple } from './select.js';

export interface DecoderMetadata {
  readonly id: string;
  readonly longname: string;
  readonly desc: string;
}

export interface DecoderOptionMetadata {
  readonly id: string;
  readonly desc: string;
}

export function decoderDescriptionKey(decoderId: string): string {
  return `decoder.${decoderId}.desc`;
}

export function decoderLongNameKey(decoderId: string): string {
  return `decoder.${decoderId}.longname`;
}

export function decoderOptionKey(decoderId: string, optionId: string): string {
  return `decoder.${decoderId}.opt.${optionId}`;
}

export function decoderOptionValueKey(rawValue: string | number): string {
  return `decoder.optval.${String(rawValue)}`;
}

export function decoderDescriptionText(decoder: DecoderMetadata): string {
  return translateDecoder(decoderDescriptionKey(decoder.id), decoder.desc);
}

export const PRESERVED_LONGNAME_DECODER_IDS: ReadonlySet<string> = new Set([
  'am230x', 'cec', 'em4100', 'em4305', 'flexray', 'ieee488', 'ir_irmp',
  'ir_nec', 'ir_rc5', 'ir_rc6', 'ir_sirc', 'mcs48', 'microwire', 'ps2',
  'sae_j1850_vpw', 'sda2506', 'sdq', 'st7735', 't55xx', 'tlc5620', 'usb_power_delivery',
  'z80',
]);

export function decoderLongNameText(decoder: DecoderMetadata): string {
  if (PRESERVED_LONGNAME_DECODER_IDS.has(decoder.id)) return decoder.longname;
  return translateDecoder(decoderLongNameKey(decoder.id), decoder.longname);
}

export function decoderPickerLabel(decoder: DecoderMetadata): string {
  return `${decoder.id} - ${decoderLongNameText(decoder)}`;
}

export function decoderOptionLabel(decoderId: string, option: DecoderOptionMetadata): string {
  return translateDecoder(decoderOptionKey(decoderId, option.id), option.desc);
}

export const PRESERVED_OPTION_VALUES: ReadonlySet<string> = new Set([
  '-', '0', '0.5', '1', '1.5', '10', '10000000', '1010', '1111', '16', '2', '2500000',
  '3', '32', '4', '5000000', '5', '6', '64', '7', '8', '9', 'A', 'B', 'BGR', 'BRG',
  'Diff Manchester', 'GBR', 'GRB', 'Manchester', 'NRZ', 'RBG', 'RGB', 'RGB[W]', 'RGBW',
  'RGWB', 'RWBG', 'SC52x2/HX22x2', 'am230x/rht', 'ascii', 'big', 'bin', 'dec', 'dht11',
  'enum', 'eol', 'fixpoint', 'fixsigned', 'full-speed', 'hex', 'ieee754', 'inch', 'little',
  'low-speed', 'lsb-first', 'maplin_l95ar', 'mm', 'msb-first', 'oct', 'terse-auto',
  'terse-ms', 'terse-ns', 'terse-ps', 'terse-s', 'terse-us', 'xx1527',
]);

export function decoderOptionValueLabel(rawValue: string | number): string {
  const raw = String(rawValue);
  if (PRESERVED_OPTION_VALUES.has(raw)) return raw;
  return translateDecoder(decoderOptionValueKey(raw), raw);
}

export function decoderOptionValueTuples(
  rawValues: readonly (string | number)[],
): SelectOptionTuple[] {
  return rawValues.map((rawValue): SelectOptionTuple =>
    [String(rawValue), decoderOptionValueLabel(rawValue)]);
}
