export interface CursorZoomRequest {
  readonly cursorId: number;
  readonly sample: number | null;
}

export type CursorZoomRefusal = 'needs-pair' | 'degenerate' | 'missing';

export interface CursorZoomSpan {
  readonly kind: 'zoom';
  readonly start: number;
  readonly end: number;
  readonly a: number;
  readonly b: number;
}

export interface CursorZoomRefused {
  readonly kind: 'refuse';
  readonly reason: CursorZoomRefusal;
}

export type CursorZoomPlan = CursorZoomSpan | CursorZoomRefused;

function placedSample(sample: number | null): number | null {
  return sample !== null && Number.isFinite(sample) ? Math.round(sample) : null;
}

function placedPair(cursors: readonly CursorZoomRequest[]): [number, number] | null {
  const placed: number[] = [];
  for (const cursor of cursors) {
    if (placedSample(cursor.sample) === null) continue;
    placed.push(cursor.cursorId);
    if (placed.length === 2) return [placed[0], placed[1]];
  }
  return null;
}

function sampleOf(cursors: readonly CursorZoomRequest[], cursorId: number): number | null {
  for (const cursor of cursors) {
    if (cursor.cursorId !== cursorId) continue;
    return placedSample(cursor.sample);
  }
  return null;
}

function spanFor(
  cursors: readonly CursorZoomRequest[], first: number, second: number,
): CursorZoomPlan {
  const firstSample = sampleOf(cursors, first);
  const secondSample = sampleOf(cursors, second);
  if (firstSample === null || secondSample === null) {
    return { kind: 'refuse', reason: 'missing' };
  }
  if (firstSample === secondSample) return { kind: 'refuse', reason: 'degenerate' };
  return firstSample < secondSample
    ? { kind: 'zoom', start: firstSample, end: secondSample, a: first, b: second }
    : { kind: 'zoom', start: secondSample, end: firstSample, a: second, b: first };
}

export function planCursorZoom(
  cursors: readonly CursorZoomRequest[], pair?: readonly [number, number],
): CursorZoomPlan {
  if (pair !== undefined) return spanFor(cursors, pair[0], pair[1]);
  const fallback = placedPair(cursors);
  if (fallback === null) return { kind: 'refuse', reason: 'needs-pair' };
  return spanFor(cursors, fallback[0], fallback[1]);
}
