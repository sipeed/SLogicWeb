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
  signature: string;
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
  hidden: ReadonlySet<string>;
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
): ReadonlySet<string> {
  const next = new Set(hidden);
  if (next.has(busId)) next.delete(busId);
  else next.add(busId);
  return next;
}

export function toggleSourceVisibility(
  sources: readonly AnalogBandSource[], state: AnalogSessionState, busId: string,
): PrunedAnalogState {
  const hidden = toggleAnalogVisibility(state.hidden, busId);
  if (!hidden.has(busId) || state.focusedId !== busId) return { focusedId: state.focusedId, hidden };
  const next = visibleAnalogSources(sources, hidden)[0];
  return { focusedId: next ? next.busId : state.focusedId, hidden };
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
  return [{
    id: MERGED_ANALOG_BAND_ID,
    sources: [...sources],
    focusedId: resolveAnalogFocus(sources, focusedId)!,
    heightCss: mergedHeight(sources),
  }];
}

function mergedHeight(sources: readonly AnalogBandSource[]): number {
  let height = 0;
  for (const source of sources) {
    if (Number.isFinite(source.heightCss)) height = Math.max(height, source.heightCss);
  }
  return height;
}

export interface AnalogRowSlot {
  channel: number;
  bus: number;
}

export interface AnalogRowRef extends AnalogRowSlot {
  heightCss: number;
}

export function analogRowProjection(
  bands: readonly AnalogBand[], rowOf: (busId: string) => AnalogRowSlot | null,
): AnalogRowRef[] {
  const rows: AnalogRowRef[] = [];
  for (const band of bands) {
    const source = focusedAnalogSource(band);
    const row = source ? rowOf(source.busId) : null;
    if (row) rows.push({ channel: row.channel, bus: row.bus, heightCss: band.heightCss });
  }
  return rows;
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
        source.signature,
      ]),
    ]),
  ]);
}
