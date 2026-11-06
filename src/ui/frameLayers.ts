// SPDX-License-Identifier: GPL-3.0-or-later

export interface FrameFingerprint {
  viewStart: number;
  viewEnd: number;
  widthPx: number;
  heightPx: number;
  dataLen: number;
  dropped: number;
  frontier: number;
  triggerSample: number | null;
  rowSig: number;
  themeSig: string;
  tickSig: number;
  busSig: number;
  tintSig: number;
}

export interface FrameLayerPlan {
  wave: boolean;
  axis: boolean;
  overlay: boolean;
  bus: boolean;
}

const DRAW_ALL: FrameLayerPlan = { wave: true, axis: true, overlay: true, bus: true };

/** FNV-1a over the parts, so equal input lists collapse to one comparable number. */
export function fingerprintOf(
  parts: readonly (number | string | boolean | null | undefined)[],
): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = part === null || part === undefined ? '' : String(part);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function planLayers(
  prev: FrameFingerprint | null, next: FrameFingerprint, force: boolean,
): FrameLayerPlan {
  if (force || prev === null) return { ...DRAW_ALL };
  const view = prev.viewStart !== next.viewStart || prev.viewEnd !== next.viewEnd;
  const size = prev.widthPx !== next.widthPx || prev.heightPx !== next.heightPx;
  const rows = prev.rowSig !== next.rowSig;
  const theme = prev.themeSig !== next.themeSig;
  const data = prev.dataLen !== next.dataLen || prev.dropped !== next.dropped;
  const overlay = view || size || rows || theme || data ||
    prev.frontier !== next.frontier || prev.triggerSample !== next.triggerSample ||
    prev.tintSig !== next.tintSig;
  return {
    wave: view || size || rows || theme || data,
    axis: size || prev.tickSig !== next.tickSig,
    overlay,
    // The bus rows share the overlay canvas, which beginFrame() clears.
    bus: overlay || prev.busSig !== next.busSig,
  };
}
