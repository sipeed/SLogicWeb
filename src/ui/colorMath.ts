// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

export interface Hsv {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function hsvFromHex(hex: string): Hsv {
  const m = /^#([0-9A-Fa-f]{6})$/.exec(hex);
  if (!m) throw new Error(`colour must be #rrggbb, got "${hex}"`);
  const n = parseInt(m[1]!, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hexFromHsv(hsv: Hsv): string {
  const { h, s, v } = hsv;
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(v)) {
    throw new Error(`hsv channels must be finite, got h=${h} s=${s} v=${v}`);
  }
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(1, Math.max(0, s));
  const val = Math.min(1, Math.max(0, v));
  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) { r = c; g = x; } else if (hue < 120) { r = x; g = c; } else if (hue < 180) {
    g = c; b = x;
  } else if (hue < 240) { g = x; b = c; } else if (hue < 300) { r = x; b = c; } else {
    r = c; b = x;
  }
  const ch = (channel: number): string =>
    Math.round((channel + m) * 255).toString(16).padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`.toUpperCase();
}

export function svFromPoint(rect: RectLike, x: number, y: number): { s: number; v: number } {
  if (!(rect.width > 0) || !(rect.height > 0)) return { s: 0, v: 0 };
  return {
    s: Math.min(1, Math.max(0, (x - rect.left) / rect.width)),
    v: Math.min(1, Math.max(0, 1 - (y - rect.top) / rect.height)),
  };
}

export function hueFromPoint(rect: RectLike, x: number): number {
  if (!(rect.width > 0)) return 0;
  return Math.min(359, Math.max(0, ((x - rect.left) / rect.width) * 360));
}

export function stepHsv(hsv: Hsv, key: string, shift: boolean): Hsv | null {
  const step = shift ? 0.10 : 0.01;
  let { s, v } = hsv;
  switch (key) {
    case 'ArrowLeft': s -= step; break;
    case 'ArrowRight': s += step; break;
    case 'ArrowUp': v += step; break;
    case 'ArrowDown': v -= step; break;
    default: return null;
  }
  return {
    h: hsv.h,
    s: Math.round(Math.min(1, Math.max(0, s)) * 100) / 100,
    v: Math.round(Math.min(1, Math.max(0, v)) * 100) / 100,
  };
}

export function stepHue(h: number, key: string, shift: boolean): number | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case 'ArrowLeft': return (((h - step) % 360) + 360) % 360;
    case 'ArrowRight': return (((h + step) % 360) + 360) % 360;
    case 'Home': return 0;
    case 'End': return 359;
    default: return null;
  }
}
