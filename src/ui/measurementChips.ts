// SPDX-License-Identifier: GPL-3.0-or-later

import { measurementParameterText, measurementValueText } from './capturePanel.js';
import type { MeasurementSectionView } from './measurementState.js';
import type { AnalogMeasurementChipView } from './overlay.js';

/**
 * The scope-style readout chips for the analog rows, keyed by the ADC group's first
 * channel (`MeasurementRowView.start`). One chip per visible measurement row, in panel
 * order, carrying the same label, value text and source colour so a chip and its
 * measurement row can never disagree. `colorOf` returns undefined for a source that has
 * no trace on screen (unknown group, or hidden), which drops its chips.
 */
export function measurementChipsByStart(
  view: MeasurementSectionView | null,
  colorOf: (start: number) => string | undefined,
): ReadonlyMap<number, readonly AnalogMeasurementChipView[]> {
  const byStart = new Map<number, AnalogMeasurementChipView[]>();
  if (view === null) return byStart;
  for (const row of view.rows) {
    const color = colorOf(row.start);
    if (color === undefined) continue;
    const chips = byStart.get(row.start) ?? [];
    chips.push({
      label: measurementParameterText(row.parameter),
      value: measurementValueText(row),
      color,
    });
    byStart.set(row.start, chips);
  }
  return byStart;
}
