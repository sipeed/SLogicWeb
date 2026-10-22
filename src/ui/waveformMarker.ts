// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { clampMarkerSample, isMarkerGrab } from './markerGeometry.js';

export interface MarkerPaintTarget {
  drawCursor(x: number, color: string, label: string): void;
}

export interface MarkerGrabRequest {
  pointerId: number;
  clientX: number;
  clientY: number;
  pointerCssX: number;
  markerCssX: number;
  channel: number | null;
  captureLength: number;
}

export interface MarkerMoveRequest {
  pointerId: number;
  clientX: number;
  clientY: number;
  sample: number;
  captureLength: number;
}

interface MarkerDragSession {
  pointerId: number;
  pressX: number;
  pressY: number;
  started: boolean;
  channel: number | null;
}

export class WaveformMarker {
  readonly label: string;
  readonly color: string;
  private value: number | null = null;
  private drag: MarkerDragSession | null = null;

  constructor(label: string, color: string) {
    this.label = label;
    this.color = color;
  }

  get sample(): number | null {
    return this.value;
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  get pointerId(): number | null {
    return this.drag?.pointerId ?? null;
  }

  get channel(): number | null {
    return this.drag?.channel ?? null;
  }

  get started(): boolean {
    return this.drag?.started ?? false;
  }

  setSample(sample: number | null, captureLength: number): void {
    this.drag = null;
    this.value = sample === null ? null : clampMarkerSample(sample, captureLength);
  }

  clear(): void {
    this.drag = null;
    this.value = null;
  }

  draw(target: MarkerPaintTarget, toPx: (sample: number) => number): void {
    if (this.value === null) return;
    target.drawCursor(toPx(this.value), this.color, this.label);
  }

  tryGrab(request: MarkerGrabRequest): boolean {
    if (this.value === null || this.drag !== null) return false;
    if (!Number.isFinite(request.captureLength) || request.captureLength < 1) return false;
    if (!Number.isFinite(request.pointerId) || !Number.isFinite(request.clientX) ||
      !Number.isFinite(request.clientY)) return false;
    if (request.channel !== null && !Number.isInteger(request.channel)) return false;
    if (!isMarkerGrab(request.pointerCssX, request.markerCssX)) return false;
    this.drag = {
      pointerId: request.pointerId,
      pressX: request.clientX,
      pressY: request.clientY,
      started: false,
      channel: request.channel,
    };
    return true;
  }

  move(request: MarkerMoveRequest): boolean {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== request.pointerId) return false;
    if (!drag.started) {
      if (request.clientX === drag.pressX && request.clientY === drag.pressY) return true;
      drag.started = true;
    }
    const next = clampMarkerSample(request.sample, request.captureLength);
    if (next !== null) this.value = next;
    return true;
  }

  endDrag(pointerId: number): boolean {
    const drag = this.drag;
    if (drag === null || drag.pointerId !== pointerId) return false;
    this.drag = null;
    return true;
  }

  cancelDrag(): void {
    this.drag = null;
  }
}
