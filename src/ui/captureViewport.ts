// SPDX-License-Identifier: GPL-3.0-or-later

import type { CaptureSettings } from './state.js';

export type CaptureStartOrigin = 'manual' | 'repeat';
export type CaptureStopReason = 'manual' | 'completed';
export type CaptureMode = CaptureSettings['mode'];

export interface CaptureViewportAnchor {
  start: number;
  span: number;
  followLatest: boolean;
}

export function captureStartUsesDefaultWindow(origin: CaptureStartOrigin): boolean {
  return origin === 'manual';
}

export function captureFinishFits(mode: CaptureMode, reason: CaptureStopReason): boolean {
  return mode === 'single' && reason === 'completed';
}

export function clampCaptureViewportAnchor(
  anchor: CaptureViewportAnchor,
  length: number,
): { start: number; end: number } {
  const maxStart = Math.max(0, length - 0.5 * anchor.span);
  const start = Math.min(maxStart, Math.max(0, anchor.start));
  return { start, end: start + anchor.span };
}
