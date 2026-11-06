// SPDX-License-Identifier: GPL-3.0-or-later

export const FRAME_COST_RING = 240;

export type FrameLayer = 'wave' | 'axis' | 'overlay' | 'bus' | 'overview';

export const FRAME_LAYERS: readonly FrameLayer[] = ['wave', 'axis', 'overlay', 'bus', 'overview'];

export interface FrameLayerCounts {
  draws: number;
  skips: number;
}

export interface FrameStatsSnapshot {
  permitted: number;
  drawn: number;
  skipped: number;
  statusRenders: number;
  lastCostMs: number;
  drawMs: { p50: number; p95: number; max: number };
  layers: Record<FrameLayer, FrameLayerCounts>;
  ingest: { blocks: number; p50Ms: number; p95Ms: number; maxMs: number };
}

export class FrameCostRing {
  private readonly values = new Float64Array(FRAME_COST_RING);
  private readonly scratch = new Float64Array(FRAME_COST_RING);
  private next = 0;
  private filled = 0;

  push(ms: number): void {
    this.values[this.next] = ms;
    this.next = (this.next + 1) % FRAME_COST_RING;
    if (this.filled < FRAME_COST_RING) this.filled += 1;
  }

  get count(): number {
    return this.filled;
  }

  percentile(p: number): number {
    if (this.filled === 0) return 0;
    const sorted = this.scratch.subarray(0, this.filled);
    sorted.set(this.values.subarray(0, this.filled));
    sorted.sort();
    const pct = Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
    const rank = Math.ceil(pct / 100 * this.filled);
    return sorted[Math.min(this.filled, Math.max(1, rank)) - 1]!;
  }

  get max(): number {
    let top = 0;
    for (let i = 0; i < this.filled; i++) {
      const value = this.values[i]!;
      if (value > top) top = value;
    }
    return top;
  }

  reset(): void {
    this.values.fill(0);
    this.next = 0;
    this.filled = 0;
  }
}

export function framesPerSecond(count: number, elapsedMs: number): number {
  if (!(elapsedMs > 0)) return 0;
  return count * 1000 / elapsedMs;
}
