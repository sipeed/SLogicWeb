// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

export const MARKER_GRAB_RADIUS_CSS = 4;

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
