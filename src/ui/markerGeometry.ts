// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

export const MARKER_GRAB_RADIUS_CSS = 4;
export const MARKER_SNAP_RADIUS_CSS = 6;

export interface MarkerSnapRadii {
  exactRadiusSamples: number;
  queryRadiusSamples: number;
}

export interface MarkerEdgeWindow {
  lo: number;
  hi: number;
}

export function isMarkerGrab(pointerCssX: number, markerCssX: number): boolean {
  if (!Number.isFinite(pointerCssX) || !Number.isFinite(markerCssX)) return false;
  return Math.abs(pointerCssX - markerCssX) <= MARKER_GRAB_RADIUS_CSS;
}

export function clampMarkerSample(sample: number, captureLength: number): number | null {
  if (!Number.isFinite(sample) || !Number.isFinite(captureLength)) return null;
  if (captureLength < 1) return null;
  const rounded = Math.round(sample);
  return Math.min(Math.max(rounded, 0), captureLength - 1);
}

export function markerSnapRadii(
  dpr: number, samplesPerPixel: number,
): MarkerSnapRadii | null {
  if (!Number.isFinite(dpr) || dpr <= 0) return null;
  if (!Number.isFinite(samplesPerPixel) || samplesPerPixel <= 0) return null;
  const exactRadiusSamples = MARKER_SNAP_RADIUS_CSS * dpr * samplesPerPixel;
  if (!Number.isFinite(exactRadiusSamples)) return null;
  return { exactRadiusSamples, queryRadiusSamples: Math.max(1, Math.ceil(exactRadiusSamples)) };
}

export function markerEdgeWindow(
  center: number, queryRadiusSamples: number, captureLength: number,
): MarkerEdgeWindow | null {
  if (!Number.isFinite(center)) return null;
  if (!Number.isFinite(queryRadiusSamples) || queryRadiusSamples < 0) return null;
  if (!Number.isFinite(captureLength) || captureLength < 1) return null;
  if (center < 0 || center > captureLength - 1) return null;
  const lo = Math.max(0, Math.floor(center - queryRadiusSamples));
  const hi = Math.min(captureLength, Math.floor(center + queryRadiusSamples) + 1);
  return lo < hi ? { lo, hi } : null;
}

export function nearestMarkerEdge(
  edges: ArrayLike<number>, center: number, exactRadiusSamples: number,
): number | null {
  if (!Number.isFinite(center)) return null;
  if (!Number.isFinite(exactRadiusSamples) || exactRadiusSamples < 0) return null;
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    if (!Number.isFinite(edge)) continue;
    const distance = Math.abs(edge - center);
    if (distance > exactRadiusSamples) continue;
    if (distance < bestDistance || (distance === bestDistance && best !== null && edge < best)) {
      best = edge;
      bestDistance = distance;
    }
  }
  return best;
}
