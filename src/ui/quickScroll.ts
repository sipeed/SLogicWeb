// SPDX-License-Identifier: GPL-3.0-or-later

export interface QuickScrollSample {
  readonly x: number;
  readonly timeStamp: number;
}

export const QUICK_SCROLL_RECENT_MS = 100;
export const QUICK_SCROLL_MIN_SPEED = 0.5;
export const QUICK_SCROLL_DECAY_MS = 325;
export const QUICK_SCROLL_STOP_SPEED = 0.02;
export const QUICK_SCROLL_CLICK_SLOP = 3;

export function releaseVelocity(samples: readonly QuickScrollSample[], now: number): number {
  const recent: QuickScrollSample[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.timeStamp)) continue;
    if (!(now - sample.timeStamp <= QUICK_SCROLL_RECENT_MS)) continue;
    recent.push(sample);
  }
  if (recent.length < 2) return 0;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const dt = last.timeStamp - first.timeStamp;
  if (!(dt > 0)) return 0;
  const velocity = (last.x - first.x) / dt;
  return Number.isFinite(velocity) ? velocity : 0;
}

export function startsFling(travelCss: number, velocity: number): boolean {
  if (!Number.isFinite(travelCss) || !Number.isFinite(velocity)) return false;
  return travelCss > QUICK_SCROLL_CLICK_SLOP && Math.abs(velocity) >= QUICK_SCROLL_MIN_SPEED;
}

export interface FlingStep {
  readonly panCss: number;
  readonly velocity: number;
  readonly done: boolean;
}

export function flingStep(velocity: number, dtMs: number): FlingStep {
  if (!Number.isFinite(velocity) || velocity === 0) {
    return { panCss: 0, velocity: 0, done: true };
  }
  const dt = dtMs > 0 && Number.isFinite(dtMs) ? dtMs : 0;
  const kept = Math.exp(-dt / QUICK_SCROLL_DECAY_MS);
  const next = velocity * kept;
  const done = Math.abs(next) < QUICK_SCROLL_STOP_SPEED;
  const panCss = dt === 0 ? 0 : -velocity * QUICK_SCROLL_DECAY_MS * (1 - kept);
  return { panCss, velocity: done ? 0 : next, done };
}
