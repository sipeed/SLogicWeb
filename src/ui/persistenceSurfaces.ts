// SPDX-License-Identifier: GPL-3.0-or-later

import type { AnalogLayout } from './analogBands.js';
import {
  clearReason, persistenceOf, trailClearKey, trailDecay,
  type PersistenceClearEvent, type PersistenceClearReason, type PersistenceFrames,
  type PersistenceSourceKey, type PersistenceSurfaceView,
} from './persistenceTrail.js';

export interface PersistenceTrailView {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly decay: number;
  readonly commit: boolean;
}

export interface PersistenceBandSpec {
  readonly id: string;
  readonly top: number;
  readonly height: number;
  readonly sources: readonly PersistenceSourceKey[];
}

export interface PersistenceSurface {
  readonly id: string;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  top: number;
  height: number;
  width: number;
  generation: number;
  commits: number;
  key: string | null;
}

export interface PersistenceSurfaceFactory {
  (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };
}

export interface PersistenceSyncInput {
  readonly frames: PersistenceFrames;
  readonly width: number;
  readonly dpr: number;
  readonly viewportStart: number;
  readonly viewportEnd: number;
  readonly analogLayout: AnalogLayout;
  readonly samplerate: number;
  readonly event: PersistenceClearEvent;
  readonly bands: readonly PersistenceBandSpec[];
}

export interface PersistenceSyncResult {
  readonly reallocated: boolean;
  readonly removed: readonly string[];
  readonly reasons: readonly PersistenceClearReason[];
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function optionalFinite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function documentSurface(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('persistence surface: a 2D canvas context is required');
  return { canvas, ctx };
}

function clearCanvas(surface: PersistenceSurface): void {
  const ctx = surface.ctx;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  ctx.restore();
}

export class PersistenceTrail {
  private readonly surfaces = new Map<string, PersistenceSurface>();
  private readonly factory: PersistenceSurfaceFactory;

  constructor(factory: PersistenceSurfaceFactory = documentSurface) {
    this.factory = factory;
  }

  sync(input: PersistenceSyncInput): PersistenceSyncResult {
    const reasons: PersistenceClearReason[] = [];
    const removed: string[] = [];
    let reallocated = false;
    const active = persistenceOf(input.frames) > 0;
    const width = finite(input.width);
    const dpr = Math.max(1, finite(input.dpr, 1));
    const wanted = new Set(input.bands.map((band) => band.id));
    for (const [id, surface] of [...this.surfaces]) {
      if (active && wanted.has(id)) continue;
      this.surfaces.delete(id);
      removed.push(id);
      if (!active) continue;
      const reason = clearReason(surface.key, null,
        input.event === 'none' ? 'band-removed' : input.event);
      if (reason !== null) reasons.push(reason);
    }
    if (!active) return { reallocated, removed, reasons };
    for (const band of input.bands) {
      const key = trailClearKey({
        viewportSpan: finite(input.viewportEnd) - finite(input.viewportStart),
        widthCss: width,
        heightCss: finite(band.height),
        dpr,
        analogLayout: input.analogLayout,
        bandTop: finite(band.top),
        bandHeight: finite(band.height),
        samplerate: finite(input.samplerate),
        sources: band.sources.map((source) => ({
          busId: source.busId,
          gain: finite(source.gain, 1),
          fullScaleV: optionalFinite(source.fullScaleV),
          voltsPerDiv: optionalFinite(source.voltsPerDiv),
          zeroPosition: finite(source.zeroPosition),
          offsetV: finite(source.offsetV),
          color: source.color,
          visible: source.visible === true,
        })),
      });
      const existing = this.surfaces.get(band.id);
      if (!existing) {
        const created = this.factory();
        const surface: PersistenceSurface = {
          id: band.id,
          canvas: created.canvas,
          ctx: created.ctx,
          top: finite(band.top),
          height: finite(band.height),
          width,
          generation: 1,
          commits: 0,
          key,
        };
        this.resize(surface, width, band.height, dpr);
        clearCanvas(surface);
        this.surfaces.set(band.id, surface);
        continue;
      }
      const reason = clearReason(existing.key, key, input.event);
      const resized = this.resize(existing, width, band.height, dpr);
      existing.top = finite(band.top);
      existing.key = key;
      if (!resized && reason === null) continue;
      if (resized) reallocated = true;
      existing.generation += 1;
      existing.commits = 0;
      clearCanvas(existing);
      if (reason !== null) reasons.push(reason);
    }
    return { reallocated, removed, reasons };
  }

  surface(id: string): PersistenceSurface | undefined {
    return this.surfaces.get(id);
  }

  trailOf(id: string, frames: PersistenceFrames, commit: boolean): PersistenceTrailView | undefined {
    const surface = this.surfaces.get(id);
    if (!surface) return undefined;
    return {
      canvas: surface.canvas,
      ctx: surface.ctx,
      decay: trailDecay(frames),
      commit,
    };
  }

  commit(id: string): void {
    const surface = this.surfaces.get(id);
    if (surface) surface.commits += 1;
  }

  views(): PersistenceSurfaceView[] {
    return [...this.surfaces.values()].map((surface) => ({
      id: surface.id,
      top: surface.top,
      height: surface.height,
      width: surface.width,
      generation: surface.generation,
      commits: surface.commits,
    }));
  }

  releaseAll(): void {
    this.surfaces.clear();
  }

  private resize(
    surface: PersistenceSurface, width: number, height: number, dpr: number,
  ): boolean {
    const cssHeight = finite(height);
    const wPx = Math.max(1, Math.round(width * dpr));
    const hPx = Math.max(1, Math.round(cssHeight * dpr));
    const changed = surface.canvas.width !== wPx || surface.canvas.height !== hPx;
    surface.width = width;
    surface.height = cssHeight;
    if (changed) {
      surface.canvas.width = wPx;
      surface.canvas.height = hPx;
    }
    surface.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return changed;
  }
}
