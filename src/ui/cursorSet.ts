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

interface PlacedItem {
  item: LayoutItem;
  boxX: number;
  row: 0 | 1;
}

interface RowEntry {
  left: number;
  right: number;
  cluster: number;
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

function placeCascade(cluster: readonly LayoutItem[], separation: number): number[] {
  const boxX = cluster.map((item) => item.boxX);
  for (let index = cluster.length - 2; index >= 0; index--) {
    const next = cluster[index + 1];
    const item = cluster[index];
    boxX[index] = Math.min(
      boxX[index], boxX[index + 1] - next.width / 2 - separation - item.width / 2);
  }
  if (boxX[0] - cluster[0].width / 2 < CURSOR_CHIP_EDGE) {
    for (let index = 0; index < cluster.length; index++) boxX[index] = cluster[index].boxX;
    for (let index = 1; index < cluster.length; index++) {
      const prev = cluster[index - 1];
      const item = cluster[index];
      boxX[index] = Math.max(
        boxX[index], boxX[index - 1] + prev.width / 2 + separation + item.width / 2);
    }
  }
  return boxX;
}

function placeCluster(cluster: readonly LayoutItem[], width: number): PlacedItem[] {
  const rows = placeRows(cluster);
  if (rows !== null) {
    return cluster.map((item, index) => ({ item, boxX: item.boxX, row: rows[index] }));
  }
  const boxes = placeCascading(cluster, width);
  return cluster.map((item, index) => ({ item, boxX: boxes[index], row: 0 }));
}

function findClusterConflict(placed: readonly PlacedItem[][]): [number, number] | null {
  for (let row = 0; row < CURSOR_CHIP_ROWS; row++) {
    const entries: RowEntry[] = [];
    for (let cluster = 0; cluster < placed.length; cluster++) {
      for (const entry of placed[cluster]) {
        if (entry.row !== row) continue;
        entries.push({
          left: entry.boxX - entry.item.width / 2,
          right: entry.boxX + entry.item.width / 2,
          cluster,
        });
      }
    }
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.left - b.left || a.cluster - b.cluster);
    let best: RowEntry | null = null;
    let second: RowEntry | null = null;
    for (const entry of entries) {
      const other = best !== null && best.cluster !== entry.cluster ? best : second;
      if (other !== null && other.cluster !== entry.cluster &&
        entry.left - other.right < 2 * CHIP_GAP - 1e-9) {
        return [Math.min(entry.cluster, other.cluster), Math.max(entry.cluster, other.cluster)];
      }
      if (best === null || entry.right > best.right) {
        if (best !== null && best.cluster !== entry.cluster) second = best;
        best = entry;
      } else if (entry.cluster !== best.cluster &&
        (second === null || entry.right > second.right)) {
        second = entry;
      }
    }
  }
  return null;
}

function mergeClusters(
  clusters: readonly LayoutItem[][], a: number, b: number,
): LayoutItem[][] {
  const merged = [...clusters[a], ...clusters[b]]
    .sort((x, y) => x.chip.cssX - y.chip.cssX || x.order - y.order);
  const next: LayoutItem[][] = [];
  for (let index = 0; index < clusters.length; index++) {
    if (index !== a && index !== b) next.push(clusters[index]);
  }
  next.push(merged);
  next.sort((x, y) => x[0].chip.cssX - y[0].chip.cssX || x[0].order - y[0].order);
  return next;
}

function placeCascading(cluster: readonly LayoutItem[], width: number): number[] {
  const last = cluster.length - 1;
  let boxX = placeCascade(cluster, 2 * CHIP_GAP);
  const overflow = boxX[last] + cluster[last].width / 2 - (width - CURSOR_CHIP_EDGE);
  if (overflow <= 0) return boxX;
  const room = boxX[0] - cluster[0].width / 2 - CURSOR_CHIP_EDGE;
  if (room >= overflow) return boxX.map((x) => x - overflow);
  boxX = placeCascade(cluster, 0);
  const left = CURSOR_CHIP_EDGE - (boxX[0] - cluster[0].width / 2);
  if (left <= 0) return boxX;
  boxX[0] += left;
  for (let index = 1; index < cluster.length; index++) {
    const prev = cluster[index - 1];
    const item = cluster[index];
    boxX[index] = Math.max(
      boxX[index], boxX[index - 1] + prev.width / 2 + item.width / 2);
  }
  return boxX;
}

export function layoutCursorChips(
  chips: readonly CursorChip[], chipWidth: (label: string) => number, width: number,
): PlacedCursorChip[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  let clusters = clusterize(measureItems(chips, chipWidth, width));
  let placed = clusters.map((cluster) => placeCluster(cluster, width));
  for (;;) {
    if (clusters.length < 2) break;
    const conflict = findClusterConflict(placed);
    if (conflict === null) break;
    clusters = mergeClusters(clusters, conflict[0], conflict[1]);
    placed = clusters.map((cluster) => placeCluster(cluster, width));
  }
  const entries: LayoutEntry[] = [];
  for (const cluster of placed) {
    for (const item of cluster) {
      entries.push({
        chip: {
          id: item.item.chip.id,
          label: item.item.chip.label,
          anchorX: item.item.chip.cssX,
          boxX: item.boxX,
          row: item.row,
        },
        order: item.item.order,
      });
    }
  }
  entries.sort((a, b) => a.chip.boxX - b.chip.boxX || a.order - b.order);
  return entries.map((entry) => entry.chip);
}
