// SPDX-License-Identifier: GPL-3.0-or-later

export type MeasurementParameter =
  | 'vpp' | 'max' | 'min' | 'mean' | 'rms'
  | 'frequency' | 'period' | 'duty';

export type MeasurementUnit = 'v' | 'hz' | 's' | '%';

export type MeasurementGroup = 'vertical' | 'horizontal';

export interface MeasurementCatalogEntry {
  readonly parameter: MeasurementParameter;
  readonly group: MeasurementGroup;
  readonly unit: MeasurementUnit;
  readonly labelKey: string;
  readonly methodKey: string;
  readonly descriptionKey: string;
}

export const MEASUREMENT_CATALOG: readonly MeasurementCatalogEntry[] = [
  {
    parameter: 'vpp', group: 'vertical', unit: 'v',
    labelKey: 'capturePanel.measureVpp', methodKey: 'capturePanel.measureMethodVpp',
    descriptionKey: 'capturePanel.measureMethodVpp',
  },
  {
    parameter: 'max', group: 'vertical', unit: 'v',
    labelKey: 'capturePanel.measureMax', methodKey: 'capturePanel.measureMethodMax',
    descriptionKey: 'capturePanel.measureMethodMax',
  },
  {
    parameter: 'min', group: 'vertical', unit: 'v',
    labelKey: 'capturePanel.measureMin', methodKey: 'capturePanel.measureMethodMin',
    descriptionKey: 'capturePanel.measureMethodMin',
  },
  {
    parameter: 'mean', group: 'vertical', unit: 'v',
    labelKey: 'capturePanel.measureMean', methodKey: 'capturePanel.measureMethodMean',
    descriptionKey: 'capturePanel.measureMethodMean',
  },
  {
    parameter: 'rms', group: 'vertical', unit: 'v',
    labelKey: 'capturePanel.measureRms', methodKey: 'capturePanel.measureMethodRms',
    descriptionKey: 'capturePanel.measureMethodRms',
  },
  {
    parameter: 'frequency', group: 'horizontal', unit: 'hz',
    labelKey: 'capturePanel.measureFrequency', methodKey: 'capturePanel.measureMethodFrequency',
    descriptionKey: 'capturePanel.measureCatalogMethodFrequency',
  },
  {
    parameter: 'period', group: 'horizontal', unit: 's',
    labelKey: 'capturePanel.measurePeriod', methodKey: 'capturePanel.measureMethodPeriod',
    descriptionKey: 'capturePanel.measureCatalogMethodPeriod',
  },
  {
    parameter: 'duty', group: 'horizontal', unit: '%',
    labelKey: 'capturePanel.measureDuty', methodKey: 'capturePanel.measureMethodDuty',
    descriptionKey: 'capturePanel.measureCatalogMethodDuty',
  },
];

export const MEASUREMENT_PARAMETERS: readonly MeasurementParameter[] =
  MEASUREMENT_CATALOG.map((entry) => entry.parameter);

export const MEASUREMENT_DEFAULT_PARAMETERS = ['frequency', 'vpp', 'rms'] as const;

const CATALOG_BY_PARAMETER: ReadonlyMap<MeasurementParameter, MeasurementCatalogEntry> = new Map(
  MEASUREMENT_CATALOG.map((entry) => [entry.parameter, entry] as const));

export function isMeasurementParameter(value: string): value is MeasurementParameter {
  return CATALOG_BY_PARAMETER.has(value as MeasurementParameter);
}

export function catalogEntry(parameter: MeasurementParameter): MeasurementCatalogEntry {
  const entry = CATALOG_BY_PARAMETER.get(parameter);
  if (entry === undefined) throw new RangeError(`unknown measurement parameter: ${String(parameter)}`);
  return entry;
}

export function measurementUnit(parameter: MeasurementParameter): MeasurementUnit {
  return catalogEntry(parameter).unit;
}

export function measurementGroup(parameter: MeasurementParameter): MeasurementGroup {
  return catalogEntry(parameter).group;
}
