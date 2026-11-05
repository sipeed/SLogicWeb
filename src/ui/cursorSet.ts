import { MARKER_GRAB_RADIUS_CSS } from './markerGeometry.js';
import { MEASURE_COLORS } from './metrics.js';

const CHIP_GAP = 1;

export const CURSOR_CHIP_ROWS = 2;
export const CURSOR_CHIP_EDGE = 2;

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

export interface PlacedCursorChip {
  id: number;
  label: string;
  anchorX: number;
  boxX: number;
  row: 0 | 1;
}

interface LayoutItem {
  chip: CursorChip;
  width: number;
  boxX: number;
  left: number;
  right: number;
  order: number;
}

interface LayoutEntry {
  chip: PlacedCursorChip;
  order: number;
}

function clampBoxX(x: number, boxWidth: number, width: number): number {
  const low = CURSOR_CHIP_EDGE + boxWidth / 2;
  const high = width - CURSOR_CHIP_EDGE - boxWidth / 2;
  if (low > high) return width / 2;
  return Math.min(high, Math.max(low, x));
}

function measureItems(
  chips: readonly CursorChip[], chipWidth: (label: string) => number, width: number,
): LayoutItem[] {
  const items: LayoutItem[] = [];
  for (let order = 0; order < chips.length; order++) {
    const chip = chips[order];
    if (!Number.isFinite(chip.cssX)) continue;
    const boxWidth = chipWidth(chip.label);
    if (!Number.isFinite(boxWidth) || boxWidth <= 0) continue;
    const boxX = clampBoxX(chip.cssX, boxWidth, width);
    items.push({
      chip,
      width: boxWidth,
      boxX,
      left: boxX - boxWidth / 2,
      right: boxX + boxWidth / 2,
      order,
    });
  }
  items.sort((a, b) => a.chip.cssX - b.chip.cssX || a.order - b.order);
  return items;
}

function clusterize(items: readonly LayoutItem[]): LayoutItem[][] {
  const clusters: LayoutItem[][] = [];
  let cluster: LayoutItem[] = [];
  let clusterRight = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (cluster.length > 0 && item.left - 2 * CHIP_GAP > clusterRight) {
      clusters.push(cluster);
      cluster = [];
      clusterRight = Number.NEGATIVE_INFINITY;
    }
    cluster.push(item);
    clusterRight = Math.max(clusterRight, item.right);
  }
  if (cluster.length > 0) clusters.push(cluster);
  return clusters;
}

function placeRows(cluster: readonly LayoutItem[]): (0 | 1)[] | null {
  const rows: (0 | 1)[] = [];
  const lastRight: number[] = [];
  for (let row = 0; row < CURSOR_CHIP_ROWS; row++) lastRight.push(Number.NEGATIVE_INFINITY);
  for (const item of cluster) {
    let slot = -1;
    for (let row = 0; row < CURSOR_CHIP_ROWS; row++) {
      if (item.left - 2 * CHIP_GAP >= lastRight[row]) {
        slot = row;
        break;
      }
    }
    if (slot < 0) return null;
    lastRight[slot] = item.right;
    rows.push(slot === 0 ? 0 : 1);
  }
  return rows;
}

function placeDropping(cluster: readonly LayoutItem[]): LayoutItem[] {
  const kept: LayoutItem[] = [];
  const newestFirst = [...cluster].sort((a, b) => b.order - a.order);
  for (const item of newestFirst) {
    const left = item.chip.cssX - item.width / 2 - CHIP_GAP;
    const right = item.chip.cssX + item.width / 2 + CHIP_GAP;
    if (kept.some((box) =>
      left < box.chip.cssX + box.width / 2 + CHIP_GAP &&
      box.chip.cssX - box.width / 2 - CHIP_GAP < right)) continue;
    kept.push(item);
  }
  return kept;
}

export function layoutCursorChips(
  chips: readonly CursorChip[], chipWidth: (label: string) => number, width: number,
): PlacedCursorChip[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  const placed: LayoutEntry[] = [];
  for (const cluster of clusterize(measureItems(chips, chipWidth, width))) {
    const rows = placeRows(cluster);
    if (rows === null) {
      for (const item of placeDropping(cluster)) {
        placed.push({
          chip: {
            id: item.chip.id,
            label: item.chip.label,
            anchorX: item.chip.cssX,
            boxX: item.chip.cssX,
            row: 0,
          },
          order: item.order,
        });
      }
      continue;
    }
    for (let index = 0; index < cluster.length; index++) {
      const item = cluster[index];
      placed.push({
        chip: {
          id: item.chip.id,
          label: item.chip.label,
          anchorX: item.chip.cssX,
          boxX: item.boxX,
          row: rows[index],
        },
        order: item.order,
      });
    }
  }
  placed.sort((a, b) => a.chip.boxX - b.chip.boxX || a.order - b.order);
  return placed.map((entry) => entry.chip);
}
