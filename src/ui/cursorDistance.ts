import { formatCursorSpan } from './cursorTime.js';
import { formatCount, formatFreq } from './format.js';

export type DistanceSide = 'a' | 'b';

export interface CursorDistanceRow {
  readonly id: number;
  readonly a: number | null;
  readonly b: number | null;
}

// [SOURCE] DSView Max_Measure_Limits = 15 (measuredock.h:91).
export const MAX_CURSOR_DISTANCE_ROWS = 15;

export interface CursorDistance {
  readonly samples: number;
  readonly seconds: number;
  readonly time: string;
  readonly count: string;
  readonly frequency: string;
  readonly cell: string;
}

function withSide(
  row: CursorDistanceRow, side: DistanceSide, cursorId: number | null,
): CursorDistanceRow {
  const a = side === 'a' ? cursorId : row.a;
  const b = side === 'b' ? cursorId : row.b;
  return { id: row.id, a, b };
}

export function addDistanceRow(
  rows: readonly CursorDistanceRow[], id: number,
  pair: readonly [number, number] | null = null,
): readonly CursorDistanceRow[] {
  if (rows.length >= MAX_CURSOR_DISTANCE_ROWS) return rows;
  if (rows.some((row) => row.id === id)) return rows;
  return [...rows, { id, a: pair === null ? null : pair[0], b: pair === null ? null : pair[1] }];
}

export function removeDistanceRow(
  rows: readonly CursorDistanceRow[], rowId: number,
): readonly CursorDistanceRow[] {
  const next = rows.filter((row) => row.id !== rowId);
  return next.length === rows.length ? rows : next;
}

export function assignDistanceCursor(
  rows: readonly CursorDistanceRow[], rowId: number, side: DistanceSide, cursorId: number | null,
): readonly CursorDistanceRow[] {
  const index = rows.findIndex((row) => row.id === rowId);
  if (index < 0) return rows;
  const target = rows[index];
  if (target[side] === cursorId) return rows;
  return rows.map((row) => (row.id === rowId ? withSide(row, side, cursorId) : row));
}

export function seedDistanceRow(
  rows: readonly CursorDistanceRow[], id: number, cursorIds: readonly number[],
): readonly CursorDistanceRow[] | null {
  if (rows.length !== 0 || cursorIds.length < 2) return null;
  return [{ id, a: cursorIds[0], b: cursorIds[1] }];
}

export function pruneDistancePairs(
  rows: readonly CursorDistanceRow[], presentIds: ReadonlySet<number>,
): readonly CursorDistanceRow[] {
  let changed = false;
  const next = rows.map((row) => {
    const a = row.a !== null && !presentIds.has(row.a) ? null : row.a;
    const b = row.b !== null && !presentIds.has(row.b) ? null : row.b;
    if (a === row.a && b === row.b) return row;
    changed = true;
    return { id: row.id, a, b };
  });
  return changed ? next : rows;
}

export function clearDistancePairs(
  rows: readonly CursorDistanceRow[],
): readonly CursorDistanceRow[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.a === null && row.b === null) return row;
    changed = true;
    return { id: row.id, a: null, b: null };
  });
  return changed ? next : rows;
}

function signedCount(samples: number): string {
  return samples < 0 ? `-${formatCount(-samples)}` : formatCount(Math.abs(samples));
}

export function cursorDistance(
  aSample: number, bSample: number, samplePeriod: number,
): CursorDistance {
  const samples = aSample - bSample;
  if (!Number.isFinite(samples)) {
    return { samples, seconds: Number.NaN, time: '-', count: '', frequency: '', cell: '' };
  }
  const seconds = samples * samplePeriod;
  const time = formatCursorSpan(seconds, samplePeriod);
  const count = signedCount(samples);
  const frequency = seconds === 0 ? '' : formatFreq(1 / Math.abs(seconds));
  return { samples, seconds, time, count, frequency, cell: `${time}/${count}` };
}

export function distanceCell(
  row: CursorDistanceRow,
  samples: ReadonlyMap<number, number>,
  samplePeriod: number,
): string {
  if (row.a === null || row.b === null) return '';
  if (!Number.isFinite(samplePeriod) || samplePeriod <= 0) return '';
  const aSample = samples.get(row.a);
  const bSample = samples.get(row.b);
  if (aSample === undefined || bSample === undefined) return '';
  if (!Number.isFinite(aSample) || !Number.isFinite(bSample)) return '';
  const distance = cursorDistance(bSample, aSample, samplePeriod);
  return distance.frequency === '' ? distance.cell : `${distance.cell} · ${distance.frequency}`;
}
