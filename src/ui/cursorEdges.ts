import type { DistanceSide } from './cursorDistance.js';

export interface CursorEdgeRow {
  readonly id: number;
  readonly a: number | null;
  readonly b: number | null;
  readonly channel: number | null;
}

export const MAX_CURSOR_EDGE_ROWS = 15;

function withSide(
  row: CursorEdgeRow, side: DistanceSide, cursorId: number | null,
): CursorEdgeRow {
  const a = side === 'a' ? cursorId : row.a;
  const b = side === 'b' ? cursorId : row.b;
  return { id: row.id, a, b, channel: row.channel };
}

export function addEdgeRow(
  rows: readonly CursorEdgeRow[], id: number, channel: number | null,
): readonly CursorEdgeRow[] {
  if (rows.length >= MAX_CURSOR_EDGE_ROWS) return rows;
  if (rows.some((row) => row.id === id)) return rows;
  return [...rows, { id, a: null, b: null, channel }];
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
