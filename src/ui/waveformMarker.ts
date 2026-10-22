// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

export interface MarkerPaintTarget {
  drawCursor(x: number, color: string, label: string): void;
}

export class WaveformMarker {
  readonly label: string;
  readonly color: string;
  private value: number | null = null;

  constructor(label: string, color: string) {
    this.label = label;
    this.color = color;
  }

  get sample(): number | null {
    return this.value;
  }

  set sample(sample: number | null) {
    this.value = sample;
  }

  clear(): void {
    this.value = null;
  }

  draw(target: MarkerPaintTarget, toPx: (sample: number) => number): void {
    if (this.value === null) return;
    target.drawCursor(toPx(this.value), this.color, this.label);
  }
}
