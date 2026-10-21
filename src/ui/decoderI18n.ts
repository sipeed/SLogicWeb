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

export function decoderLongNameText(decoder: DecoderMetadata): string {
  return translateDecoder(decoderLongNameKey(decoder.id), decoder.longname);
}

export function decoderPickerLabel(decoder: DecoderMetadata): string {
  return `${decoder.id} - ${decoderLongNameText(decoder)}`;
}

export function decoderOptionLabel(decoderId: string, option: DecoderOptionMetadata): string {
  return translateDecoder(decoderOptionKey(decoderId, option.id), option.desc);
}

export function decoderOptionValueLabel(rawValue: string | number): string {
  return translateDecoder(decoderOptionValueKey(rawValue), String(rawValue));
}

export function decoderOptionValueTuples(
  rawValues: readonly (string | number)[],
): SelectOptionTuple[] {
  return rawValues.map((rawValue): SelectOptionTuple =>
    [String(rawValue), decoderOptionValueLabel(rawValue)]);
}
