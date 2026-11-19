// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The scope-style measurement chips painted at the bottom-left of each analog row:
 * one chip per measurement row, in panel order, coloured by the source trace; chips
 * stop at the V/div readout instead of overlapping it; and the frame never re-composes
 * the measurement section.
 *
 *   node src/tools/run-all-tests.mjs --filter measurement-chips-selftest
 */

import { measurementChipsByStart } from '../measurementChips.js';
import { measurementValueText } from '../capturePanel.js';
import type { MeasurementRowView, MeasurementSectionView } from '../measurementState.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

const rowView = (over: Partial<MeasurementRowView> = {}): MeasurementRowView => ({
  id: 1,
  start: 0,
  sourceName: 'A0',
  parameter: 'vpp',
  unit: 'v',
  value: 3.3,
  status: 'ok',
  analyzedSamples: 1024,
  requestedSamples: 1024,
  truncated: false,
  rangeClipped: false,
  gaps: false,
  clippedLow: false,
  clippedHigh: false,
  nearSampleLimit: false,
  crossingCap: false,
  crossingCount: 0,
  dutyPeriods: 0,
  dutyExcludedPeriods: 0,
  stats: {
    mean: 0, min: 0, max: 0, stdDev: null, count: 0, excluded: 0,
  } as MeasurementRowView['stats'],
  ...over,
});

const section = (rows: MeasurementRowView[]): MeasurementSectionView =>
  ({ rows } as unknown as MeasurementSectionView);

const read = (path: string): string => fs.readFileSync(path, 'utf8');
const overlay = read('src/ui/overlay.ts');
const app = read('src/ui/app.ts');
const chipsModule = read('src/ui/measurementChips.ts');

{
  const rows = [
    rowView({ id: 1, start: 0, parameter: 'frequency', unit: 'hz', value: 1000, crossingCount: 12 }),
    rowView({ id: 2, start: 0, parameter: 'vpp', unit: 'v', value: 3.3 }),
    rowView({ id: 3, start: 0, parameter: 'rms', unit: 'v', value: 1.16 }),
    rowView({ id: 4, start: 16, parameter: 'vpp', unit: 'v', value: 8 }),
  ];
  const colors = new Map<number, string>([[0, '#CD427E']]);
  const chips = measurementChipsByStart(section(rows), (start) => colors.get(start));
  const list = chips.get(0) ?? [];
  check('chips follow the panel rows in order for a traced group and drop a group with no trace',
    list.length === 3 && chips.has(16) === false &&
      list.map((chip) => chip.label).join(',') === 'Frequency,Vpp,RMS' &&
      list.every((chip) => chip.color === '#CD427E') &&
      list.map((chip) => chip.value).join('|') === rows.slice(0, 3)
        .map((row) => measurementValueText(row)).join('|'),
    `groups=${[...chips.keys()].join(',')}, chips=${list.map((c) => `${c.label}=${c.value}`).join(' ')}`);
}

{
  const chips = measurementChipsByStart(null, () => '#CD427E');
  const broken = measurementChipsByStart(
    section([rowView({ status: 'no-data', value: Number.NaN })]), () => '#CD427E');
  const values = broken.get(0)?.map((chip) => chip.value) ?? [];
  check('a missing measurement section makes no chips and an unavailable row shows the panel dash',
    chips.size === 0 && values.length === 1 && values[0] === measurementValueText(
      rowView({ status: 'no-data', value: Number.NaN })) && !values[0]!.includes('NaN'),
    `size=${chips.size}, value=${values.join(',')}`);
}

{
  const declared = overlay.includes('measurements?: readonly AnalogMeasurementChipView[];') &&
    overlay.includes('export interface AnalogMeasurementChipView {') &&
    overlay.includes('if (o.measurements !== undefined && o.measurements.length > 0) {') &&
    overlay.includes('this.paintAnalogMeasurements(c, o, chipMaxX);') &&
    overlay.includes('private paintAnalogMeasurements(') &&
    // Bottom-left origin, fixed 14 px boxes, one row.
    overlay.includes('const height = 14;') &&
    overlay.includes('const y = o.top + o.band - 4 - height;') &&
    overlay.includes('let x = 4;') &&
    overlay.includes('c.fillText(text, x + 4, y + height / 2);') &&
    // The V/div chip owns the right corner: the chips stop at its left edge.
    overlay.includes('let chipMaxX = this.wCss - 4;') &&
    overlay.includes('chipMaxX = Math.min(chipMaxX, vdiv.x0 - 4);') &&
    overlay.includes('chipMaxX = Math.min(chipMaxX, triggerX - triggerWidth - 4);') &&
    overlay.includes('if (x + width > maxX) break;') &&
    // Trace colour identifies the chip; the box is opaque so the trace never shows through.
    overlay.includes('c.strokeStyle = chip.color;') &&
    overlay.includes('c.fillStyle = chip.color;') &&
    overlay.includes('c.fillStyle = this.palette.bg;');
  check('the overlay paints one opaque trace-coloured chip per row on the bottom-left, stopping at V/div',
    declared, `declared=${declared}`);
}

{
  const wired = app.includes("import { measurementChipsByStart } from './measurementChips.js';") &&
    app.includes('private measurementChips: ReadonlyMap<number, readonly AnalogMeasurementChipView[]> =') &&
    app.includes('this.measurementChips = measurementChipsByStart(view, (start) => colorByStart.get(start));') &&
    app.includes('if (bus.analogGroup === undefined || hidden.has(bus.id)) continue;') &&
    app.includes('colorByStart.set(bus.analogGroup * CHANNEL_BANK_SIZE, bus.color);') &&
    app.includes('private measurementChipsWanted(): boolean') &&
    app.includes('if (this.viewMode !== \'time\') return false;') &&
    app.includes('const measurements = this.measurementChipsWanted()') &&
    app.includes('this.measurePageShown() || this.measurementChipsWanted()') &&
    app.includes('band.sources.flatMap((source) => this.measurementChips.get(source.start) ?? [])') &&
    app.includes('...(measurements.length > 0 ? { measurements } : {}),');
  check('App keys chips by group start, keeps them in the time view on every panel page and paints them from the cached measurement view',
    wired, `wired=${wired}`);
  check('the chip builder reuses the panel\'s parameter and value text instead of a second formatter',
    chipsModule.includes('measurementParameterText(row.parameter)') &&
    chipsModule.includes('measurementValueText(row)') &&
    !chipsModule.includes('toFixed(') && !chipsModule.includes('formatMeasureValue'),
    chipsModule.slice(0, 120));
}

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
