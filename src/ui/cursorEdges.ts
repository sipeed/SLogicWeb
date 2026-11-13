import type { DistanceSide } from './cursorDistance.js';
import { formatCount } from './format.js';

export interface CursorEdgeRow {
  readonly id: number;
  readonly a: number | null;
  readonly b: number | null;
  readonly channel: number | null;
}

export const MAX_CURSOR_EDGE_ROWS = 15;
export const CURSOR_EDGE_QUERY_WINDOW = 262_144;
export const CURSOR_EDGE_EMPTY_RESULT = '-/-/-';
export const CURSOR_EDGE_DEFERRED_RESULT = '…';

export interface EdgeSampleSource {
  readonly length: number;
  edges(channel: number, startSample: number, endSample: number): Int32Array;
  sampleAt(channel: number, index: number): number;
}

export interface EdgeCounts {
  readonly rising: number;
  readonly falling: number;
  readonly total: number;
  readonly cell: string;
}

function withSide(
  row: CursorEdgeRow, side: DistanceSide, cursorId: number | null,
): CursorEdgeRow {
  const a = side === 'a' ? cursorId : row.a;
  const b = side === 'b' ? cursorId : row.b;
  return { id: row.id, a, b, channel: row.channel };
}

export function addEdgeRow(
  rows: readonly CursorEdgeRow[], id: number, channel: number | null,
  pair: readonly [number, number] | null = null,
): readonly CursorEdgeRow[] {
  if (rows.length >= MAX_CURSOR_EDGE_ROWS) return rows;
  if (rows.some((row) => row.id === id)) return rows;
  return [...rows, { id, a: pair === null ? null : pair[0], b: pair === null ? null : pair[1], channel }];
}

export function removeEdgeRow(
  rows: readonly CursorEdgeRow[], rowId: number,
): readonly CursorEdgeRow[] {
  const next = rows.filter((row) => row.id !== rowId);
  return next.length === rows.length ? rows : next;
}

export function assignEdgeCursor(
  rows: readonly CursorEdgeRow[], rowId: number, side: DistanceSide, cursorId: number | null,
): readonly CursorEdgeRow[] {
  const index = rows.findIndex((row) => row.id === rowId);
  if (index < 0) return rows;
  const target = rows[index];
  if (target[side] === cursorId) return rows;
  return rows.map((row) => (row.id === rowId ? withSide(row, side, cursorId) : row));
}

export function assignEdgeChannel(
  rows: readonly CursorEdgeRow[], rowId: number, channel: number | null,
): readonly CursorEdgeRow[] {
  const index = rows.findIndex((row) => row.id === rowId);
  if (index < 0) return rows;
  const target = rows[index];
  if (target.channel === channel) return rows;
  return rows.map((row) => (row.id === rowId ? { ...row, channel } : row));
}

export function pruneEdgeCursors(
  rows: readonly CursorEdgeRow[], presentCursorIds: ReadonlySet<number>,
): readonly CursorEdgeRow[] {
  let changed = false;
  const next = rows.map((row) => {
    const a = row.a !== null && !presentCursorIds.has(row.a) ? null : row.a;
    const b = row.b !== null && !presentCursorIds.has(row.b) ? null : row.b;
    if (a === row.a && b === row.b) return row;
    changed = true;
    return { id: row.id, a, b, channel: row.channel };
  });
  return changed ? next : rows;
}

export function clearEdgeCursors(
  rows: readonly CursorEdgeRow[],
): readonly CursorEdgeRow[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.a === null && row.b === null) return row;
    changed = true;
    return { id: row.id, a: null, b: null, channel: row.channel };
  });
  return changed ? next : rows;
}

export function pruneEdgeChannels(
  rows: readonly CursorEdgeRow[], availableChannels: ReadonlySet<number>,
): readonly CursorEdgeRow[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.channel === null || availableChannels.has(row.channel)) return row;
    changed = true;
    return { ...row, channel: null };
  });
  return changed ? next : rows;
}

function edgeCounts(rising: number, falling: number): EdgeCounts {
  const total = rising + falling;
  return {
    rising,
    falling,
    total,
    cell: `${formatCount(rising)}/${formatCount(falling)}/${formatCount(total)}`,
  };
}

function requirePosition(value: number, length: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > length) {
    throw new Error(`${name} must be an integer sample position in 0..${length}, got ${value}`);
  }
}

export function countCursorEdges(
  source: EdgeSampleSource,
  channel: number,
  aSample: number,
  bSample: number,
  queryWindow = CURSOR_EDGE_QUERY_WINDOW,
): EdgeCounts {
  const length = source.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`source length must be a non-negative safe integer, got ${length}`);
  }
  if (!Number.isSafeInteger(channel) || channel < 0) {
    throw new Error(`channel must be a non-negative safe integer, got ${channel}`);
  }
  requirePosition(aSample, length, 'aSample');
  requirePosition(bSample, length, 'bSample');
  if (!Number.isSafeInteger(queryWindow) || queryWindow < 1 ||
      queryWindow > CURSOR_EDGE_QUERY_WINDOW) {
    throw new Error(`query window must be an integer in 1..${CURSOR_EDGE_QUERY_WINDOW}`);
  }
  if (aSample === bSample) return edgeCounts(0, 0);

  const lo = Math.min(aSample, bSample);
  const hi = Math.max(aSample, bSample);
  const end = Math.min(hi + 1, length);
  let start = lo + 1;
  let rising = 0;
  let falling = 0;
  while (start < end) {
    const chunkEnd = Math.min(start + queryWindow, end);
    const positions = source.edges(channel, start, chunkEnd);
    for (const position of positions) {
      const level = source.sampleAt(channel, position);
      if (level === 1) rising += 1;
      else if (level === 0) falling += 1;
      else throw new Error(`invalid level ${level} at channel ${channel}, sample ${position}`);
    }
    start = chunkEnd;
  }
  return edgeCounts(rising, falling);
}
