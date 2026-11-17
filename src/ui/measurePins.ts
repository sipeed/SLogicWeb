// SPDX-License-Identifier: GPL-3.0-or-later

import type { MessageKey } from './i18n.js';
import {
  MEASUREMENT_CATALOG, MEASUREMENT_DEFAULT_PARAMETERS, catalogEntry,
  type MeasurementParameter,
} from './measurementCatalog.js';
import type {
  MeasurementRowView, MeasurementSectionView, MeasurementStatus,
} from './measurementState.js';

export const MAX_PINS_PER_BAND: number = 3;

export interface MeasurePin {
  readonly key: string;
  readonly rowId: number;
  readonly sourceStart: number;
  readonly parameter: MeasurementParameter;
  readonly labelKey: MessageKey;
  readonly value: number;
  readonly status: MeasurementStatus;
}

export interface MeasurePinCluster {
  readonly busId: string;
  readonly sourceStart: number;
  readonly pins: readonly MeasurePin[];
  readonly foldCount: number;
}

export interface MeasureBandRef {
  readonly busId: string;
  readonly sourceStart: number;
}

const DEFAULT_PARAMETERS: ReadonlySet<MeasurementParameter> =
  new Set(MEASUREMENT_DEFAULT_PARAMETERS);

const PIN_ORDER: ReadonlyMap<MeasurementParameter, number> = new Map(
  [
    ...MEASUREMENT_DEFAULT_PARAMETERS,
    ...MEASUREMENT_CATALOG
      .map((entry) => entry.parameter)
      .filter((parameter) => !DEFAULT_PARAMETERS.has(parameter)),
  ].map((parameter, index) => [parameter, index] as const),
);

function pinRank(parameter: MeasurementParameter): number {
  return PIN_ORDER.get(parameter) ?? PIN_ORDER.size;
}

function pinOf(row: MeasurementRowView): MeasurePin {
  return {
    key: `${row.start}:${row.parameter}`,
    rowId: row.id,
    sourceStart: row.start,
    parameter: row.parameter,
    labelKey: catalogEntry(row.parameter).labelKey as MessageKey,
    value: row.value,
    status: row.status,
  };
}

export function measurePinClusters(
  section: MeasurementSectionView,
  bands: readonly MeasureBandRef[],
): MeasurePinCluster[] {
  if (section.fft?.mode === 'fft' || section.xy?.mode === 'xy') return [];
  const viewRows = section.bandRows ?? section.rows;
  const starts = new Set(section.sources.map((source) => source.start));
  const clusters: MeasurePinCluster[] = [];
  for (const band of bands) {
    if (!starts.has(band.sourceStart)) continue;
    const rows = viewRows
      .filter((row) => row.start === band.sourceStart)
      .sort((a, b) => pinRank(a.parameter) - pinRank(b.parameter));
    if (rows.length === 0) continue;
    const pins = rows.slice(0, MAX_PINS_PER_BAND).map(pinOf);
    clusters.push({
      busId: band.busId,
      sourceStart: band.sourceStart,
      pins,
      foldCount: rows.length - pins.length,
    });
  }
  return clusters;
}
