// SPDX-License-Identifier: GPL-3.0-or-later

import type { AnalysisViewMode } from '../fftView.js';
import {
  MEASUREMENT_DEFAULT_PARAMETERS, MEASUREMENT_PARAMETERS, catalogEntry, measurementUnit,
  type MeasurementParameter,
} from '../measurementCatalog.js';
import {
  MAX_PINS_PER_BAND, measurePinClusters, type MeasureBandRef, type MeasurePinCluster,
} from '../measurePins.js';
import type { MeasurementRow } from '../measurementRows.js';
import type {
  MeasurementRowView, MeasurementSectionView, MeasurementSource, MeasurementStatus, MeasureTier,
} from '../measurementState.js';
import { noMeasurementStatsView } from '../measurementStats.js';

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
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const VALUES: Record<MeasurementParameter, number> = {
  vpp: 1.5, max: 2, min: -0.5, mean: 0.75, rms: 0.5,
  frequency: 1000, period: 0.001, duty: 40,
};

function source(start: number): MeasurementSource {
  return { group: start / 8, start, gain: 1, name: `A${start / 8}`, color: '', focused: false };
}

function rowView(
  start: number, parameter: MeasurementParameter,
  value: number = VALUES[parameter], status: MeasurementStatus = 'ok',
): MeasurementRowView {
  return {
    id: start * 10 + MEASUREMENT_PARAMETERS.indexOf(parameter) + 1,
    start,
    sourceName: `A${start / 8}`,
    parameter,
    unit: measurementUnit(parameter),
    value,
    status,
    analyzedSamples: 1024,
    requestedSamples: 1024,
    truncated: false,
    rangeClipped: false,
    gaps: false,
    clippedLow: false,
    clippedHigh: false,
    nearSampleLimit: false,
    crossingCap: false,
    crossingCount: 8,
    dutyPeriods: 8,
    dutyExcludedPeriods: 0,
    stats: noMeasurementStatsView(),
  };
}

function rowsOf(start: number, parameters: readonly MeasurementParameter[]): MeasurementRowView[] {
  return parameters.map((parameter) => rowView(start, parameter));
}

interface SectionOptions {
  readonly fft?: AnalysisViewMode | null;
  readonly xy?: AnalysisViewMode | null;
  readonly tier?: MeasureTier;
}

function sectionView(
  sources: readonly MeasurementSource[], rows: readonly MeasurementRowView[],
  options: SectionOptions = {},
): MeasurementSectionView {
  const allRows: MeasurementRow[] = rows.map((row) => ({
    id: row.id, start: row.start, parameter: row.parameter,
  }));
  const section: MeasurementSectionView = {
    sources: [...sources],
    filter: null,
    range: { kind: 'capture', a: null, b: null },
    tier: options.tier ?? 'basic',
    cursors: [],
    rows: [...rows],
    allRows,
    rowCount: allRows.length,
    undoCount: null,
    addStart: null,
    window: null,
    unavailable: null,
    capture: null,
    statsSkipped: 0,
    statsLoopUnavailable: false,
  };
  const fftMode = options.fft === undefined ? 'time' : options.fft;
  const xyMode = options.xy === undefined ? 'time' : options.xy;
  if (fftMode !== null) {
    section.fft = {
      mode: fftMode,
      sources: [...sources],
      source: sources[0]?.start ?? null,
      window: 'hann',
      minHz: null,
      maxHz: null,
      analysis: null,
    };
  }
  if (xyMode !== null) {
    section.xy = {
      mode: xyMode,
      sources: [...sources],
      sourceX: sources[0]?.start ?? null,
      sourceY: sources[1]?.start ?? null,
      fit: true,
      analysis: null,
    };
  }
  return section;
}

function band(start: number): MeasureBandRef {
  return { busId: `bus-${start / 8}`, sourceStart: start };
}

const number = (value: number): string => (Number.isFinite(value) ? String(value) : 'NaN');

const shape = (clusters: readonly MeasurePinCluster[]): string => clusters
  .map((cluster) => `${cluster.busId}@${cluster.sourceStart}[${cluster.pins
    .map((pin) => `${pin.parameter}=${number(pin.value)}`).join(',')}]+${cluster.foldCount}`)
  .join(';');

const orderOf = (clusters: readonly MeasurePinCluster[]): string =>
  clusters[0]?.pins.map((pin) => pin.parameter).join(',') ?? '';

{
  const defaults: readonly MeasurementParameter[] = ['frequency', 'vpp', 'rms'];
  const one = measurePinClusters(sectionView([source(0)], rowsOf(0, ['vpp'])), [band(0)]);
  const three = measurePinClusters(sectionView([source(0)], rowsOf(0, defaults)), [band(0)]);
  const five = measurePinClusters(
    sectionView([source(0)], rowsOf(0, [...defaults, 'max', 'duty'])), [band(0)]);
  const advanced = measurePinClusters(
    sectionView([source(0)], rowsOf(0, [...defaults, 'max', 'duty']), { tier: 'advanced' }),
    [band(0)]);
  const expectedOne = 'bus-0@0[vpp=1.5]+0';
  const expectedThree = 'bus-0@0[frequency=1000,vpp=1.5,rms=0.5]+0';
  const expectedFive = 'bus-0@0[frequency=1000,vpp=1.5,rms=0.5]+2';
  const cluster = five[0]!;
  const uncapped: MeasurePinCluster = { ...cluster, foldCount: 0 };
  const overCap: MeasurePinCluster = {
    ...cluster, pins: [...cluster.pins, ...cluster.pins], foldCount: 0,
  };
  const droppedFold: MeasurePinCluster = { ...cluster, foldCount: 1 };
  check('one, three and five enabled parameters produce one pin, three pins and three pins plus a two-pin fold',
    MAX_PINS_PER_BAND === 3 &&
      shape(one) === expectedOne && shape(three) === expectedThree &&
      shape(five) === expectedFive && shape(advanced) === expectedFive &&
      shape([uncapped]) !== expectedFive && shape([overCap]) !== expectedFive &&
      shape([droppedFold]) !== expectedFive,
    `max=${MAX_PINS_PER_BAND}, one=${shape(one)}, three=${shape(three)}, five=${shape(five)}, ` +
      `advanced=${shape(advanced)}, controls=${[uncapped, overCap, droppedFold]
        .map((mutant) => shape([mutant]) !== expectedFive).join('/')}`);
}

{
  const shuffledRows = rowsOf(0, ['duty', 'rms', 'max', 'frequency', 'vpp']);
  const shuffled = measurePinClusters(sectionView([source(0)], shuffledRows), [band(0)]);
  const tailRows = rowsOf(0, ['duty', 'mean', 'min', 'max']);
  const tail = measurePinClusters(sectionView([source(0)], tailRows), [band(0)]);
  const arrivalHead = shuffledRows.slice(0, 3).map((row) => row.parameter).join(',');
  const tailArrival = tailRows.slice(0, 3).map((row) => row.parameter).join(',');
  const expectedTail = 'max,min,mean';
  check('the projection leads with MEASUREMENT_DEFAULT_PARAMETERS and then follows catalog order',
    shape(shuffled) === 'bus-0@0[frequency=1000,vpp=1.5,rms=0.5]+2' &&
      shape(tail) === 'bus-0@0[max=2,min=-0.5,mean=0.75]+1' &&
      orderOf(shuffled) === MEASUREMENT_DEFAULT_PARAMETERS.join(',') &&
      orderOf(tail) === expectedTail &&
      orderOf(shuffled) !== arrivalHead && orderOf(tail) !== tailArrival,
    `shuffled=${shape(shuffled)}, tail=${shape(tail)}, expected=${expectedTail}, ` +
      `arrival=${arrivalHead}/${tailArrival}`);
}

{
  const rows = [
    rowView(0, 'frequency', Number.NaN, 'no-crossing'),
    rowView(0, 'vpp'),
    rowView(8, 'frequency'),
  ];
  const clusters = measurePinClusters(sectionView([source(0), source(8)], rows), [band(0), band(8)]);
  const pins = clusters.flatMap((cluster) => cluster.pins);
  const keys = pins.map((pin) => pin.key);
  const collided = pins.map((pin, index) => ({
    ...pin, key: index === 0 ? pins[1]!.key : pin.key,
  }));
  const uniqueKeys = (entries: readonly { key: string }[]): boolean =>
    new Set(entries.map((entry) => entry.key)).size === entries.length;
  const nanPin = pins.find((pin) => pin.sourceStart === 0 && pin.parameter === 'frequency');
  check('each pin carries the section row identity behind a unique source:parameter key',
    keys.join(',') === '0:frequency,0:vpp,8:frequency' &&
      uniqueKeys(pins) && !uniqueKeys(collided) && collided.length === pins.length &&
      pins.every((pin) => pin.key === `${pin.sourceStart}:${pin.parameter}`) &&
      pins.every((pin) => pin.labelKey === catalogEntry(pin.parameter).labelKey) &&
      pins.every((pin) => rows.some((row) => row.id === pin.rowId &&
        row.start === pin.sourceStart && row.parameter === pin.parameter &&
        Object.is(row.value, pin.value) && row.status === pin.status)) &&
      nanPin !== undefined && Number.isNaN(nanPin.value) && nanPin.status === 'no-crossing',
    `keys=${keys.join(',')}, unique=${uniqueKeys(pins)}/${!uniqueKeys(collided)}, ` +
      `labels=${pins.map((pin) => pin.labelKey).join(',')}`);
}

{
  const rows = rowsOf(0, ['vpp']);
  const unknown = measurePinClusters(sectionView([source(0)], rows), [band(8)]);
  const orphanRows = measurePinClusters(
    sectionView([source(0)], [...rows, ...rowsOf(16, ['vpp'])]), [band(16)]);
  const mixed = measurePinClusters(sectionView([source(0)], rows), [band(0), band(8)]);
  const known = new Set([0]);
  const fabricated: MeasurePinCluster[] = [{ ...mixed[0]!, sourceStart: 8 }];
  check('a band without a matching source produces no cluster',
    unknown.length === 0 && orphanRows.length === 0 &&
      mixed.length === 1 && mixed[0]!.sourceStart === 0 &&
      mixed[0]!.busId === 'bus-0' && mixed.every((cluster) => known.has(cluster.sourceStart)) &&
      !fabricated.every((cluster) => known.has(cluster.sourceStart)),
    `unknown=${unknown.length}, orphanRows=${orphanRows.length}, mixed=${shape(mixed)}, ` +
      `fabricated=${shape(fabricated)}`);
}

{
  const rows = rowsOf(0, ['frequency', 'vpp', 'rms']);
  const time = measurePinClusters(
    sectionView([source(0)], rows, { fft: 'time', xy: 'time' }), [band(0)]);
  const absent = measurePinClusters(
    sectionView([source(0)], rows, { fft: null, xy: null }), [band(0)]);
  const fft = measurePinClusters(sectionView([source(0)], rows, { fft: 'fft' }), [band(0)]);
  const xy = measurePinClusters(sectionView([source(0)], rows, { fft: 'time', xy: 'xy' }), [band(0)]);
  const both = measurePinClusters(sectionView([source(0)], rows, { fft: 'fft', xy: 'xy' }), [band(0)]);
  check('pins exist in Time and in a section without analysis views and vanish in FFT and XY',
    shape(time) === 'bus-0@0[frequency=1000,vpp=1.5,rms=0.5]+0' &&
      shape(absent) === shape(time) && fft.length === 0 && xy.length === 0 && both.length === 0,
    `time=${shape(time)}, absent=${shape(absent)}, fft=${fft.length}, xy=${xy.length}, ` +
      `both=${both.length}`);
}

{
  const empty = measurePinClusters(sectionView([source(0)], []), [band(0)]);
  const noBands = measurePinClusters(sectionView([source(0)], rowsOf(0, ['vpp'])), []);
  const otherSource = measurePinClusters(
    sectionView([source(0), source(8)], rowsOf(0, ['vpp'])), [band(8)]);
  const fabricated: MeasurePinCluster[] = [{ busId: 'bus-0', sourceStart: 0, pins: [], foldCount: 0 }];
  check('no rows, no bands or a source with no rows produce no cluster',
    empty.length === 0 && noBands.length === 0 && otherSource.length === 0 &&
      !fabricated.every((cluster) => cluster.pins.length > 0),
    `empty=${empty.length}, noBands=${noBands.length}, otherSource=${otherSource.length}, ` +
      `fabricated=${shape(fabricated)}`);
}

{
  {
    const both = sectionView([source(0), source(8)],
      rowsOf(8, ['frequency', 'vpp', 'rms']));
    both.bandRows = [...rowsOf(0, ['frequency', 'vpp', 'rms']), ...rowsOf(8, ['frequency', 'vpp', 'rms'])];
    const clusters = measurePinClusters(both,
      [{ busId: 'b0', sourceStart: 0 }, { busId: 'b8', sourceStart: 8 }]);
    const withoutField = measurePinClusters({ ...both, bandRows: undefined },
      [{ busId: 'b0', sourceStart: 0 }, { busId: 'b8', sourceStart: 8 }]);
    check('a source filter narrows the rows but not the pins of the other bands',
      clusters.length === 2 && clusters[0]!.pins.length === 3 && clusters[1]!.pins.length === 3 &&
        withoutField.length === 1 && withoutField[0]!.sourceStart === 8,
      `clusters=${clusters.length}/${clusters.map((c) => c.pins.length).join(',')} ` +
        `filteredOnly=${withoutField.length}`);
  }
  const sourceText = fs.readFileSync('src/ui/measurePins.ts', 'utf8');
  const readsProducedRows = (text: string): boolean =>
    text.includes('section.rows') && text.includes('section.sources') &&
      !text.includes('section.allRows') && !text.includes('captureStore') &&
      !text.includes('readMeasureSamples') && !text.includes('scanAnalogCodes') &&
      !text.includes('measurementStats');
  const injected = (needle: string): boolean => readsProducedRows(`${sourceText}\n${needle}`);
  const usesDefaultConstant = (text: string): boolean =>
    text.includes('MEASUREMENT_DEFAULT_PARAMETERS') &&
      !text.includes("['frequency', 'vpp', 'rms']");
  check('the projection reads only the section rows and the shared default-parameter constant',
    sourceText.length > 0 && readsProducedRows(sourceText) &&
      usesDefaultConstant(sourceText) &&
      !usesDefaultConstant(sourceText.split('MEASUREMENT_DEFAULT_PARAMETERS').join('DEFAULTS')) &&
      !usesDefaultConstant(`${sourceText}\nconst DEFAULTS = ['frequency', 'vpp', 'rms'];`) &&
      !injected('captureStore') && !injected('readMeasureSamples') &&
      !injected('scanAnalogCodes') && !injected('measurementStats') &&
      !injected('section.allRows'),
    `bytes=${sourceText.length}, forbidden needles rejected=4/4, constant=${usesDefaultConstant(sourceText)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
