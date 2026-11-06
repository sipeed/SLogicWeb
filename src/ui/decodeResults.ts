// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The decode results list as data: which annotations are listed, the concatenated text
 * view, the virtual window and the copy/export formats. No DOM; the panel
 * (decodeResultsPanel.ts) renders it and decode-results-selftest.ts checks it under node.
 *
 * Every function works on index arrays over the decoder's typed annotation arrays, so a
 * million-annotation result is never turned into a million objects: a row's object is
 * built only when the virtual window shows it or an export writes it.
 */

/** The fields of one decode result the list reads (a `DecodeResult`'s annotations, one instance). */
export interface ResultSource {
  readonly start: ArrayLike<number>;
  readonly end: ArrayLike<number>;
  readonly cls: ArrayLike<number>;
  /** Annotation class -> display row (`rowForClass`); -1 lists under row 0 like the lanes. */
  readonly rowOfClass: ArrayLike<number>;
  /** The annotation's text forms, longest first (sigrok order). */
  textsOf(i: number): readonly string[];
  /** Annotation class ids (`rx-start`, `data-read`), for the text view's framing rule. */
  readonly classIds?: readonly string[];
}

/**
 * Framing classes the text view leaves out: UART's start/stop/parity-OK bits share the
 * data row with the characters, and I²C's start/stop share it with the bytes. [HEURISTIC]
 * a name match, like the lanes' `/bits$/`; anything it does not match is kept.
 */
export const FRAMING_CLASS = /(^|-)(start|repeat-start|stop|parity-ok)$/;

/** One listed line: an annotation, or (text view) a run of annotations joined. */
export interface ResultLine {
  readonly start: number;
  readonly end: number;
  readonly row: number;
  /** Annotation class, or -1 for a joined text line. */
  readonly cls: number;
  /** The first annotation index of the line, for "pan to it". */
  readonly ann: number;
  readonly text: string;
}

export interface ResultFilter {
  /** Display rows to list; null lists every row. */
  readonly rows: ReadonlySet<number> | null;
  /** Case-insensitive substring over the text forms and the row name. */
  readonly query: string;
  /** Sample window [start, end) an annotation must overlap; null is the whole result. */
  readonly range: readonly [number, number] | null;
}

export const RESULT_ROW_HEIGHT = 20;
export const RESULT_OVERSCAN = 8;
/** Copying to the clipboard stops here; Export writes everything. */
export const CLIPBOARD_LINE_CAP = 100_000;
/** A joined text line wraps at this many characters. */
export const TEXT_LINE_CAP = 4096;
/** A gap longer than this many annotation widths starts a new joined text line. */
export const TEXT_GAP_FACTOR = 10;

export function rowOf(src: ResultSource, i: number): number {
  const r = src.rowOfClass[src.cls[i]!] ?? -1;
  return r < 0 ? 0 : r;
}

export function primaryText(src: ResultSource, i: number): string {
  return src.textsOf(i)[0] ?? '';
}

/** Rows that hold at least one annotation, ascending. */
export function usedRows(src: ResultSource, order: ArrayLike<number>): number[] {
  const used = new Set<number>();
  for (let k = 0; k < order.length; k++) used.add(rowOf(src, order[k]!));
  return [...used].sort((a, b) => a - b);
}

/**
 * The rows listed until the user picks: every used row except the per-bit ones (the same
 * `/bits$/` heuristic the lanes use), or all used rows when a decoder has nothing else.
 */
export function defaultResultRows(rowIds: readonly string[], used: readonly number[]): Set<number> {
  const kept = used.filter((r) => !/bits$/.test(rowIds[r] ?? ''));
  return new Set(kept.length ? kept : used);
}

/**
 * Indices of `order[from..to)` that pass `filter`, in order. Callers slice a large result
 * into several calls so filtering never holds the main thread for long.
 */
export function filterResults(
  src: ResultSource, order: ArrayLike<number>, filter: ResultFilter,
  rowNames: readonly string[], from = 0, to = order.length,
): number[] {
  const q = filter.query.trim().toLowerCase();
  const out: number[] = [];
  const end = Math.min(to, order.length);
  for (let k = Math.max(0, from); k < end; k++) {
    const i = order[k]!;
    const row = rowOf(src, i);
    if (filter.rows && !filter.rows.has(row)) continue;
    if (filter.range && (src.end[i]! <= filter.range[0] || src.start[i]! >= filter.range[1])) continue;
    if (q && !matches(src, i, q, rowNames[row] ?? '')) continue;
    out.push(i);
  }
  return out;
}

function matches(src: ResultSource, i: number, q: string, rowName: string): boolean {
  if (rowName.toLowerCase().includes(q)) return true;
  for (const text of src.textsOf(i)) if (text.toLowerCase().includes(q)) return true;
  return false;
}

export function annotationLine(src: ResultSource, i: number): ResultLine {
  return {
    start: src.start[i]!, end: src.end[i]!, row: rowOf(src, i), cls: src.cls[i]!,
    ann: i, text: primaryText(src, i),
  };
}

const CHAR_TOKEN = /^(?:[\s\S]|\[[0-9A-F]{2}\])$/u;

/** A row is character-like when each annotation is one character or a `[XX]` escape (UART ascii). */
function charRows(src: ResultSource, indices: ArrayLike<number>): Set<number> {
  const notChar = new Set<number>();
  const seen = new Set<number>();
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    const r = rowOf(src, i);
    seen.add(r);
    if (!notChar.has(r) && !CHAR_TOKEN.test(primaryText(src, i))) notChar.add(r);
  }
  return new Set([...seen].filter((r) => !notChar.has(r)));
}

interface OpenLine { start: number; end: number; lastStart: number; ann: number; parts: string[]; len: number }

/**
 * Join consecutive annotations of each row into text lines, so UART "H" "e" "l" "l" "o"
 * reads "Hello". Character rows join without a separator, with `[0A]` ending the line and
 * `[0D]` dropped; other rows (hex bytes, I²C frames) join with a space. A line also ends at
 * an idle gap longer than `TEXT_GAP_FACTOR` annotation widths and wraps at `TEXT_LINE_CAP`
 * characters. Framing annotations (`FRAMING_CLASS`) are not part of the text. `indices` must be ordered by start; the lines come back ordered by start.
 */
export function joinTextLines(src: ResultSource, indices: ArrayLike<number>): ResultLine[] {
  const framing = (i: number): boolean => FRAMING_CLASS.test(src.classIds?.[src.cls[i]!] ?? '');
  const kept: number[] = [];
  for (let k = 0; k < indices.length; k++) if (!framing(indices[k]!)) kept.push(indices[k]!);
  indices = kept;
  const chars = charRows(src, indices);
  const open = new Map<number, OpenLine>();
  const out: ResultLine[] = [];
  const flush = (row: number): void => {
    const line = open.get(row);
    if (!line) return;
    open.delete(row);
    if (line.parts.length === 0) return;
    out.push({
      start: line.start, end: line.end, row, cls: -1, ann: line.ann,
      text: line.parts.join(chars.has(row) ? '' : ' '),
    });
  };
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]!;
    const row = rowOf(src, i);
    const s = src.start[i]!;
    const e = src.end[i]!;
    const text = primaryText(src, i);
    let line = open.get(row);
    if (line) {
      const width = Math.max(1, line.end - line.lastStart);
      if (s - line.end > TEXT_GAP_FACTOR * width || line.len >= TEXT_LINE_CAP) {
        flush(row);
        line = undefined;
      }
    }
    if (chars.has(row) && text === '[0A]') {
      if (line) line.end = Math.max(line.end, e);
      flush(row);
      continue;
    }
    if (chars.has(row) && text === '[0D]') {
      if (line) line.end = Math.max(line.end, e);
      continue;
    }
    if (!line) {
      line = { start: s, end: e, lastStart: s, ann: i, parts: [], len: 0 };
      open.set(row, line);
    }
    line.parts.push(text);
    line.len += text.length;
    line.end = Math.max(line.end, e);
    line.lastStart = s;
  }
  for (const row of [...open.keys()]) flush(row);
  out.sort((a, b) => (a.start - b.start) || (a.row - b.row));
  return out;
}

/** The rows of a virtual list to build: [first, end) with `overscan` either side. */
export function virtualWindow(
  scrollTop: number, viewportHeight: number, rowHeight: number, count: number,
  overscan = RESULT_OVERSCAN,
): { first: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { first: 0, end: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + Math.max(0, viewportHeight)) / rowHeight) + overscan);
  return { first: Math.min(first, end), end };
}

/** Seconds from the displayed origin (T, or the capture start), as the time axis reads. */
export function resultSeconds(sample: number, originSample: number, samplerate: number): number {
  return samplerate > 0 ? (sample - originSample) / samplerate : 0;
}

export interface ExportNames {
  timeOf(sample: number): string;
  rowName(row: number): string;
  className(cls: number): string;
  secondsOf(sample: number): number;
}

function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Spreadsheet-friendly: raw seconds and sample numbers, quoted text. */
export function resultsCsv(lines: Iterable<ResultLine>, names: ExportNames): string {
  const out = ['time_s,sample,row,class,text'];
  for (const l of lines) {
    out.push([
      String(names.secondsOf(l.start)), String(l.start), csvField(names.rowName(l.row)),
      csvField(l.cls < 0 ? '' : names.className(l.cls)), csvField(l.text),
    ].join(','));
  }
  return `${out.join('\r\n')}\r\n`;
}

/** What Copy and the TXT export write: the time as the list shows it, the row, the text. */
export function resultsText(lines: Iterable<ResultLine>, names: ExportNames): string {
  const out: string[] = [];
  for (const l of lines) {
    out.push(`${names.timeOf(l.start)}\t${names.rowName(l.row)}\t${l.text.replace(/[\r\n]+/g, ' ')}`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
