import { MARKER_GRAB_RADIUS_CSS } from './markerGeometry.js';
import { MEASURE_COLORS } from './metrics.js';

const CHIP_GAP = 1;

export function cursorColor(index: number): string {
  const slot = Number.isFinite(index) && index >= 0 ? Math.floor(index) % 4 : 0;
  return MEASURE_COLORS[slot];
}

export function cursorLabels(count: number): string[] {
  if (!Number.isFinite(count) || count < 1) return [];
  const total = Math.floor(count);
  const labels: string[] = [];
  for (let index = 1; index <= total; index++) labels.push(String(index));
  return labels;
}

export interface CursorGrabCandidate {
  id: number;
  cssX: number;
}

export function nearestCursorGrab(
  candidates: readonly CursorGrabCandidate[], pointerCssX: number,
): CursorGrabCandidate | null {
  if (!Number.isFinite(pointerCssX)) return null;
  let best: CursorGrabCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.cssX)) continue;
    const distance = Math.abs(pointerCssX - candidate.cssX);
    if (distance > MARKER_GRAB_RADIUS_CSS) continue;
    if (distance <= bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export interface CursorChip {
  id: number;
  label: string;
  cssX: number;
}

interface PlacedChip {
  chip: CursorChip;
  left: number;
  right: number;
  order: number;
}

export function layoutCursorChips(
  chips: readonly CursorChip[], chipWidth: (label: string) => number,
): CursorChip[] {
  const placed: PlacedChip[] = [];
  for (let order = chips.length - 1; order >= 0; order--) {
    const chip = chips[order];
    if (!Number.isFinite(chip.cssX)) continue;
    const width = chipWidth(chip.label);
    if (!Number.isFinite(width) || width <= 0) continue;
    const left = chip.cssX - width / 2 - CHIP_GAP;
    const right = chip.cssX + width / 2 + CHIP_GAP;
    if (placed.some((box) => left < box.right && box.left < right)) continue;
    placed.push({ chip, left, right, order });
  }
  placed.sort((a, b) => a.chip.cssX - b.chip.cssX || a.order - b.order);
  return placed.map((box) => box.chip);
}
