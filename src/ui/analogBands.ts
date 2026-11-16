// SPDX-License-Identifier: GPL-3.0-or-later

export type AnalogLayout = 'stacked' | 'merged';

export interface AnalogBandSource {
  busId: string;
  group: number;
  start: number;
  name: string;
  color: string;
  heightCss: number;
  gain: number;
}

export interface AnalogBand {
  id: string;
  sources: readonly AnalogBandSource[];
  focusedId: string;
  heightCss: number;
  top?: number;
}

export interface AnalogSessionState {
  focusedId: string | null;
  hidden: ReadonlySet<string>;
}

export interface PrunedAnalogState {
  focusedId: string | null;
  hidden: Set<string>;
}

export const MERGED_ANALOG_BAND_ID = 'analog-merged';

export function analogLayoutOf(raw: unknown): AnalogLayout {
  return raw === 'merged' ? 'merged' : 'stacked';
}

export function resolveAnalogFocus(
  sources: readonly AnalogBandSource[], focusedId: string | null | undefined,
): string | null {
  if (sources.length === 0) return null;
  if (typeof focusedId === 'string' && sources.some((source) => source.busId === focusedId)) {
    return focusedId;
  }
  return sources[0]!.busId;
}

export function focusedAnalogSource(band: AnalogBand): AnalogBandSource | null {
  return band.sources.find((source) => source.busId === band.focusedId) ??
    band.sources[0] ?? null;
}

export function visibleAnalogSources(
  sources: readonly AnalogBandSource[], hidden: ReadonlySet<string>,
): AnalogBandSource[] {
  return sources.filter((source) => !hidden.has(source.busId));
}

export function toggleAnalogVisibility(
  hidden: ReadonlySet<string>, busId: string,
): Set<string> {
  const next = new Set(hidden);
  if (next.has(busId)) next.delete(busId);
  else next.add(busId);
  return next;
}

export function pruneAnalogState(
  state: AnalogSessionState, validBusIds: ReadonlySet<string>,
): PrunedAnalogState {
  const focusedId = typeof state.focusedId === 'string' && validBusIds.has(state.focusedId)
    ? state.focusedId : null;
  const hidden = new Set<string>();
  for (const busId of state.hidden) {
    if (validBusIds.has(busId)) hidden.add(busId);
  }
  return { focusedId, hidden };
}

export function analogBands(
  layout: AnalogLayout, sources: readonly AnalogBandSource[], focusedId: string | null = null,
): AnalogBand[] {
  if (layout === 'stacked') {
    return sources.map((source) => ({
      id: source.busId,
      sources: [source],
      focusedId: source.busId,
      heightCss: source.heightCss,
    }));
  }
  if (sources.length === 0) return [];
  let heightCss = 0;
  for (const source of sources) {
    if (Number.isFinite(source.heightCss)) heightCss = Math.max(heightCss, source.heightCss);
  }
  return [{
    id: MERGED_ANALOG_BAND_ID,
    sources: [...sources],
    focusedId: resolveAnalogFocus(sources, focusedId)!,
    heightCss,
  }];
}

export function analogBandSignature(
  bands: readonly AnalogBand[], layout: AnalogLayout, hidden: ReadonlySet<string>,
): string {
  const visibility = layout === 'merged' ? [...hidden].sort() : [];
  return JSON.stringify([
    layout,
    visibility,
    bands.map((band) => [
      band.id,
      band.focusedId,
      band.heightCss,
      band.top ?? null,
      band.sources.map((source) => [
        source.busId,
        source.group,
        source.start,
        source.name,
        source.color,
        source.heightCss,
        source.gain,
      ]),
    ]),
  ]);
}
