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
import { t, type MessageKey } from '../i18n.js';
import type {
  MeasurementRowView, MeasurementSectionView, MeasurementSource, MeasurementStatus, MeasureTier,
} from '../measurementState.js';
import { noMeasurementStatsView } from '../measurementStats.js';
import {
  ChannelList, measurePinChipText, type BusCell, type BusCellMeasurePin,
  type BusCellMeasures, type BusMeasurePins,
} from '../channelList.js';
import { installFakeDom, type FakeElement } from './fakeDom.js';

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

function labelOf(parameter: MeasurementParameter): string {
  return t(catalogEntry(parameter).labelKey as MessageKey);
}

function pinOf(
  start: number, parameter: MeasurementParameter, value: string, status = '',
): BusCellMeasurePin {
  return { key: `${start}:${parameter}`, label: labelOf(parameter), value, status };
}

function measuresOf(
  pins: readonly BusCellMeasurePin[], foldCount = 0, summary = 'A0 summary',
): BusCellMeasures {
  return { sourceStart: 0, pins, foldCount, summary };
}

function analogCellOf(id: string, measures?: BusCellMeasures): BusCell {
  return {
    id, name: 'A0', summary: 'D0-D7', color: '#3366cc', heightCss: 160,
    analog: true, showHeight: true, gain: 1,
    ...(measures === undefined ? {} : { measures }),
  };
}

const directText = (el: FakeElement): string => el.childNodes
  .filter((node) => typeof (node as FakeElement).matches !== 'function')
  .map((node) => node.textContent).join('');

const shapeOf = (el: FakeElement): string =>
  `${el.localName}.${el.className}[${el.style['height'] ?? ''}](${el.children
    .filter((child) => !child.matches('[data-measure-pins]'))
    .map((child) => shapeOf(child)).join(',')})${directText(el)}`;

{
  const doc = installFakeDom();
  (globalThis as Record<string, unknown>)['window'] = { innerWidth: 1200, innerHeight: 800 };
  const root = doc.createElement('div');
  doc.body.appendChild(root);
  const folds: [string, number][] = [];
  const list = new ChannelList(root as unknown as HTMLElement, {
    onConfigure: () => {},
    onReorder: () => {},
    onMeasurePinFold: (id, start) => folds.push([id, start]),
  });
  const THREE = [
    pinOf(0, 'frequency', '9.9996 kHz'),
    pinOf(0, 'vpp', '171 mV'),
    pinOf(0, 'rms', '32.7 mV'),
  ];
  const cluster = (): FakeElement | null =>
    root.querySelector('[data-bus-id="bus-0"] [data-measure-pins]');
  const chips = (): FakeElement[] =>
    root.querySelectorAll('[data-measure-pin-key]');

  list.renderBuses([analogCellOf('bus-0', measuresOf(THREE, 0, 'A0 measurements'))]);
  const three = cluster();
  const threeChips = chips();
  check('an analog card draws one text chip per pin under one accessible group summary',
    three !== null && three.getAttribute('role') === 'group' &&
      three.getAttribute('aria-label') === 'A0 measurements' &&
      threeChips.length === 3 &&
      threeChips.map((chip) => chip.getAttribute('data-measure-pin-key')).join(',') ===
        '0:frequency,0:vpp,0:rms' &&
      threeChips.map((chip) => chip.textContent).join('|') ===
        THREE.map(measurePinChipText).join('|') &&
      threeChips.every((chip) => chip.localName === 'span') &&
      threeChips.every((chip) => chip.getAttribute('tabindex') === null) &&
      threeChips.every((chip) => chip.getAttribute('role') === null) &&
      three.getAttribute('tabindex') === null &&
      three.querySelector('.bus-measure-fold') === null,
    `chips=${threeChips.map((chip) => `${chip.localName}:${chip.textContent}`).join(',')}, ` +
      `summary=${three?.getAttribute('aria-label') ?? 'none'}`);

  list.renderBuses([analogCellOf('bus-0', measuresOf(THREE, 2, 'A0 folded'))]);
  const fold = cluster()?.querySelector('.bus-measure-fold') ?? null;
  const foldName = t('channels.measureFold', { count: 2 });
  const beforeFold = folds.length;
  fold?.click();
  check('the fourth and later parameters fold into one named button',
    fold !== null && fold.textContent === '+2' && fold.localName === 'button' &&
      fold.getAttribute('data-measure-fold') === '0' &&
      fold.getAttribute('aria-label') === foldName && fold.title === foldName &&
      folds.length === beforeFold + 1 && folds[beforeFold]![0] === 'bus-0' &&
      folds[beforeFold]![1] === 0,
    `fold=${fold?.textContent ?? 'none'}, name=${foldName}, folds=${JSON.stringify(folds)}`);

  list.renderBuses([analogCellOf('bus-0', measuresOf([pinOf(0, 'vpp', '171 mV')]))]);
  const oneChip = chips().length;
  const noFold = cluster()?.querySelector('.bus-measure-fold') ?? null;
  list.renderBuses([analogCellOf('bus-0')]);
  const absent = root.querySelector('[data-measure-pins]');
  list.renderBuses([analogCellOf('bus-0', measuresOf(THREE))]);
  const cardShapeWithPins = shapeOf(root.querySelector('.bus-cell[data-bus-id="bus-0"]')!);
  list.renderBuses([analogCellOf('bus-0')]);
  const cardShapeWithout = shapeOf(root.querySelector('.bus-cell[data-bus-id="bus-0"]')!);
  const cellWithPins = (() => {
    list.renderBuses([analogCellOf('bus-0', measuresOf(THREE))]);
    return root.querySelector('.bus-cell[data-bus-id="bus-0"]')!;
  })();
  const clusterNode = cellWithPins.querySelector('[data-measure-pins]');
  check('the cluster is absent, not hidden, when no pin may be drawn and never enters the card',
    oneChip === 1 && noFold === null && absent === null &&
      cardShapeWithPins === cardShapeWithout &&
      clusterNode !== null && clusterNode.parentNode === cellWithPins &&
      cellWithPins.querySelector('.ch-card')?.querySelector('[data-measure-pins]') === null &&
      cellWithPins.style['height'] === '160px',
    `one=${oneChip}, noFold=${noFold === null}, absent=${absent === null}, ` +
      `equal=${cardShapeWithPins === cardShapeWithout}, pinned=${clusterNode !== null}`);

  const update = (pins: readonly BusCellMeasurePin[], foldCount = 0): BusMeasurePins => ({
    busId: 'bus-0', sourceStart: 0, pins, foldCount, summary: 'A0 updated',
  });
  list.renderBuses([analogCellOf('bus-0', measuresOf(THREE))]);
  const nodeBefore = chips()[1]!;
  const nextPin = pinOf(0, 'vpp', '1.20 V', 'partial: 2 of 4 samples');
  const next = [THREE[0]!, nextPin, THREE[2]!];
  list.updateMeasurePins([update(next)]);
  const nodeAfter = chips()[1]!;
  const rewritten = nodeAfter.textContent;
  list.updateMeasurePins([update([THREE[0]!, pinOf(0, 'duty', '50 %'), THREE[2]!])]);
  const keptOnKeyChange = chips()[1]!.textContent === rewritten;
  list.updateMeasurePins([update(next, 2)]);
  const foldNotCreated = cluster()?.querySelector('.bus-measure-fold') === null;
  list.updateMeasurePins([{ ...update(next), busId: 'bus-404' }]);
  const untouchedOther = chips().length === 3 && chips()[1]!.textContent === rewritten;
  list.updateMeasurePins([update(next)]);
  check('the text refresh rewrites existing chips in place and leaves any other shape alone',
    nodeAfter === nodeBefore && rewritten === measurePinChipText(nextPin) &&
      rewritten.includes('partial: 2 of 4 samples') &&
      cluster()?.getAttribute('aria-label') === 'A0 updated' &&
      keptOnKeyChange && foldNotCreated && untouchedOther &&
      chips().length === 3,
    `same=${nodeAfter === nodeBefore}, text=${rewritten}, kept=${keptOnKeyChange}, ` +
      `fold=${foldNotCreated}, other=${untouchedOther}`);
}

{
  const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = appSource.indexOf('private measurePinCells(): BusMeasurePins[] {');
  const end = appSource.indexOf('private configureAnalogTrigger(');
  const pinCells = start < 0 || end <= start ? '' : appSource.slice(start, end);
  const gate = "!this.measurePageShown() || !this.analogScopeActive() || this.viewMode !== 'time'";
  const gates = (text: string): boolean => text.includes(gate);
  const calls = appSource.split('this.channelList.updateMeasurePins(this.measurePinCells());').length - 1;
  const clusters = appSource.split('measurePinClusters(section, this.measureBandRefs())').length - 1;
  const paired = appSource.split(
    'this.capturePanel.updateMeasurements(this.measurementView());\n        ' +
      'this.channelList.updateMeasurePins(this.measurePinCells());').length - 1;
  const pairedStopped = appSource.split(
    'this.capturePanel.updateMeasurements(this.measurementView());\n      ' +
      'this.channelList.updateMeasurePins(this.measurePinCells());').length - 1;
  check('App derives the pins once per pass behind the page, gate and Time-view predicate',
    pinCells.length > 0 && gates(pinCells) &&
      !gates(pinCells.split('this.viewMode !== \'time\'').join('true')) &&
      !gates(pinCells.replace(" || this.viewMode !== 'time'", '')) &&
      !gates(pinCells.replace('!this.measurePageShown() || ', '')) &&
      !gates(pinCells.replace('!this.analogScopeActive() || ', '')) &&
      clusters === 1 &&
      appSource.includes('pins.get(bus.id)') &&
      appSource.includes('cells.push(measures === undefined ? cell : { ...cell, measures });') &&
      calls === 2 && paired === 1 && pairedStopped === 1,
    `gate=${gates(pinCells)}, clusters=${clusters}, calls=${calls}, ` +
      `clock=${paired}, stopped=${pairedStopped}`);

  const valueRule = "value: row === undefined\n            ? t('capturePanel.measureValueNone') : measurementValueText(row),";
  const statusRule =
    "status: row !== undefined && row.status !== 'ok' ? measurementStatusText(row) : '',";
  const composes = pinCells.includes(valueRule) && pinCells.includes(statusRule) &&
    pinCells.split('measurementValueText(').length - 1 === 1 &&
    pinCells.split('measurementStatusText(').length - 1 === 1;
  const valueControl = composes && !pinCells.replace(valueRule,
    "value: measurementRowEligible(row) ? measurementValueText(row) : '-',").includes(valueRule);
  const statusControl = composes &&
    !pinCells.replace(statusRule, "status: '',").includes(statusRule);
  check('a pin prints the section value text and the status word only when the row is not ok',
    composes && valueControl && statusControl && !pinCells.includes('measurementRowEligible'),
    `value=${pinCells.includes(valueRule)}, status=${pinCells.includes(statusRule)}, ` +
      `controls=${[valueControl, statusControl].join('/')}`);

  const payload = 'measure-plot-pins';
  const files = ['src/ui/app.ts', 'src/ui/channelList.ts', 'src/ui/capturePanel.ts',
    'src/ui/style.css', 'src/ui/measurePins.ts'];
  const carriesPayload = (text: string): boolean => text.includes(payload);
  const leftover = files.filter((path) => carriesPayload(fs.readFileSync(path, 'utf8')));
  const synthetic = `// TO${'DO'}(${payload}): draw later`;
  check('no placeholder marker for this task survives in the pin surfaces',
    leftover.length === 0 && carriesPayload(synthetic) && !carriesPayload('measured output'),
    `leftover=${leftover.join(',') || 'none'}, control=${carriesPayload(synthetic)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
