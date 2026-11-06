// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Default file names for Save / Export.
 *
 *   device capture  <model>_<N>ch_<rate>_<local YYYYMMDD-HHMMSS>.<ext>
 *                   e.g. SLogic32U3_16ch_100MHz_20261106-110050.lwcap
 *   opened file     <original base name>.<ext>        e.g. uart.sr -> uart.lwcap
 *
 * `model` is whatever the device reported as its name (USB product string), stripped of
 * whitespace and characters file systems refuse; there is no per-model table here.
 * Without one the stem is `capture`. The timestamp is LOCAL wall time - the caller
 * resolves the parts (`localDateParts`) so tests stay timezone-independent.
 */

import type { LocalDateParts } from './srSave.js';

/** Save formats, in Save-menu order: ours, sigrok, then the text exports (textExport.ts). */
export type CaptureFileFormat = 'lwcap' | 'sr' | 'vcd' | 'csv';
export const CAPTURE_FILE_FORMATS: readonly CaptureFileFormat[] = ['lwcap', 'sr', 'vcd', 'csv'];

export interface CaptureFileNameInput {
  /** Device name at capture time (e.g. "SLogic32 U3"); null when unknown. */
  model: string | null;
  /** Channels written to the file. */
  channels: number;
  samplerateHz: number;
  /** Local wall time the name is stamped with. */
  when: LocalDateParts;
  /** Name of the file the capture was opened from, if any. */
  sourceFileName?: string | null;
}

export function localDateParts(d: Date): LocalDateParts {
  return {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
  };
}

/** "100MHz", "1.5MHz", "250kHz", "1GHz", "500Hz". */
export function rateToken(hz: number): string {
  const units: Array<[number, string]> = [[1e9, 'GHz'], [1e6, 'MHz'], [1e3, 'kHz']];
  for (const [scale, unit] of units) {
    if (hz >= scale) return `${trimNumber(hz / scale)}${unit}`;
  }
  return `${trimNumber(hz)}Hz`;
}

function trimNumber(v: number): string {
  return String(Number(v.toFixed(3)));
}

const pad = (v: number, n = 2): string => String(v).padStart(n, '0');

export function localStamp(d: LocalDateParts): string {
  return `${pad(d.year, 4)}${pad(d.month)}${pad(d.day)}-${pad(d.hour)}${pad(d.minute)}${pad(d.second)}`;
}

/** Drop characters Windows/macOS/Linux refuse in a file name, and all whitespace. */
function safeToken(s: string): string {
  return s.replace(/[\s<>:"/\\|?*\u0000-\u001f\u007f]+/g, '').replace(/^\.+/, '');
}

/** "dir/uart.sr" -> "uart"; "capture.v2.lwcap" -> "capture.v2". */
export function fileBaseName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? name;
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

export function captureFileName(input: CaptureFileNameInput, format: CaptureFileFormat): string {
  if (input.sourceFileName) {
    const base = fileBaseName(input.sourceFileName).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, '_').trim();
    if (base.length > 0) return `${base}.${format}`;
  }
  const model = input.model ? safeToken(input.model) : '';
  const stem = model.length > 0 ? model : 'capture';
  return `${stem}_${input.channels}ch_${rateToken(input.samplerateHz)}_${localStamp(input.when)}.${format}`;
}

export interface SaveFileType {
  description: string;
  accept: Record<string, string[]>;
}

/**
 * File System Access picker types: every format, the chosen one first (the picker's
 * default), the rest in menu order. `descriptions` are already translated.
 */
export function saveFilePickerTypes(
  first: CaptureFileFormat, descriptions: Readonly<Record<CaptureFileFormat, string>>,
): SaveFileType[] {
  const all: Record<CaptureFileFormat, SaveFileType> = {
    lwcap: { description: descriptions.lwcap, accept: { 'application/octet-stream': ['.lwcap'] } },
    sr: { description: descriptions.sr, accept: { 'application/zip': ['.sr'] } },
    vcd: { description: descriptions.vcd, accept: { 'text/plain': ['.vcd'] } },
    csv: { description: descriptions.csv, accept: { 'text/csv': ['.csv'] } },
  };
  return [first, ...CAPTURE_FILE_FORMATS.filter((f) => f !== first)].map((f) => all[f]);
}

/** The format a picked name asks for; an unrecognised extension keeps `fallback`. */
export function formatForFileName(name: string, fallback: CaptureFileFormat): CaptureFileFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.sr')) return 'sr';
  if (lower.endsWith('.lwcap')) return 'lwcap';
  if (lower.endsWith('.vcd')) return 'vcd';
  if (lower.endsWith('.csv')) return 'csv';
  return fallback;
}
