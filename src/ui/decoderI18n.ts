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
  return decoder.id;
}

export function decoderPickerSearchText(decoder: DecoderMetadata): string {
  return `${decoder.id} - ${decoderLongNameText(decoder)}`;
}

/**
 * Search-only aliases for common protocols: the names people type ("串口", "IIC",
 * "单总线", "红外") rather than the decoder's id or long name. Deliberately one table
 * for every locale - a Chinese alias still finds UART while the UI is in English - so
 * the entries are vocabulary, not translations, and are not in the message catalogs.
 * Folding (`foldAlias`) makes "I²C", "i2c" and "I 2 C" one alias.
 */
export const DECODER_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  uart: ['串口', '串行口', '串行端口', '异步串口', 'UART', 'USART', 'serial', 'serial port',
    'RS232', 'RS-485', 'TTL', 'COM', 'port série', 'liaison série',
    'последовательный порт', 'COM-порт'],
  i2c: ['IIC', 'I2C', 'I²C', 'TWI', 'SMBus', '两线', 'двухпроводной'],
  onewire_link: ['单总线', '一线', '1-Wire', 'onewire', 'one wire', 'DS18B20', 'однопроводной'],
  spi: ['SPI', '串行外设接口', '四线'],
  can: ['CAN', 'CAN总线', 'CAN bus', 'шина CAN', 'bus CAN'],
  ir_nec: ['红外', '红外遥控', 'IR', 'infrared', 'infrarouge', 'инфракрасный', 'ИК'],
  ir_rc5: ['红外', '红外遥控', 'IR', 'infrared', 'infrarouge', 'инфракрасный', 'ИК'],
  ir_rc6: ['红外', '红外遥控', 'IR', 'infrared', 'infrarouge', 'инфракрасный', 'ИК'],
  ir_sirc: ['红外', '红外遥控', 'IR', 'infrared', 'infrarouge', 'инфракрасный', 'ИК'],
  ir_irmp: ['红外', '红外遥控', 'IR', 'infrared', 'infrarouge', 'инфракрасный', 'ИК'],
  usb_signalling: ['USB', '通用串行总线'],
  usb_power_delivery: ['USB PD', 'PD', '快充'],
  i2s: ['I2S', 'IIS', '音频', 'audio'],
  jtag: ['JTAG'],
  swd: ['SWD', '调试'],
  rgb_led_ws281x: ['WS2812', 'WS2812B', 'NeoPixel', '灯带', 'RGB LED'],
  pwm: ['PWM', '脉宽调制'],
  ps2: ['PS/2', '键盘', '鼠标'],
  am230x: ['DHT11', 'DHT22', '温湿度'],
  sdcard_sd: ['SD', 'SD卡'],
  mdio: ['MDIO', 'SMI', '以太网'],
  lpc: ['LPC'],
  dcf77: ['DCF77'],
  cec: ['CEC', 'HDMI'],
  spdif: ['S/PDIF', 'SPDIF'],
  wiegand: ['韦根', 'Wiegand'],
  morse: ['摩尔斯', '莫尔斯', 'Morse', 'морзе'],
  seven_segment: ['数码管', '七段'],
  stepper_motor: ['步进电机'],
  counter: ['计数'],
};

/** A decoder's search aliases: its own id (exact id hits rank first too) plus the table's. */
export function decoderSearchAliases(decoderId: string): readonly string[] {
  return [decoderId, ...(DECODER_SEARCH_ALIASES[decoderId] ?? [])];
}

export function decoderPickerAliases(decoders: readonly DecoderMetadata[]): (readonly string[])[] {
  return decoders.map((decoder) => decoderSearchAliases(decoder.id));
}

export function decoderPickerOptions(
  decoders: readonly DecoderMetadata[],
): SelectOptionTuple[] {
  return decoders.map((decoder): SelectOptionTuple =>
    [decoder.id, decoderPickerLabel(decoder), decoderPickerSearchText(decoder)]);
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
