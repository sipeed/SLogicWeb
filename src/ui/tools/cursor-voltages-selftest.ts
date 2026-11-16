// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../../data/adcTraceFiles.js';
import { createSampleStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import { analogBusConfig, analogVoltsFromCode } from '../channelBanks.js';
import {
  CURSOR_VOLTS_PLACEHOLDER, CursorVoltageProjection, cursorVoltageDetail, cursorVoltageValue,
  projectCursorVoltages, type CursorVoltageSource,
} from '../cursorVoltages.js';

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
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function methodBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start < 0) return '';
  const open = text.indexOf('{', start + signature.length - 1);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return '';
}

const trace = loadAdcTrace('sine');
const CHANNELS = 32;

function fixtureWord(code: number): number {
  let word = 0;
  for (let k = 0; k < 8; k++) if ((code >> k) & 1) word |= 1 << (7 - k);
  return word;
}

function fixtureStore(): SampleStore {
  const store = createSampleStore(CHANNELS, 100e6);
  const words = new Uint8Array(trace.length * 4);
  for (let i = 0; i < trace.length; i++) words[i * 4] = fixtureWord(trace[i]!);
  store.append(words);
  return store;
}

function sourceOf(start: number, gain = 1): CursorVoltageSource {
  const config = analogBusConfig(start, CHANNELS, '#123456');
  return {
    busId: `bus-${start}`,
    name: `A${start / 8}`,
    color: '#CD427E',
    bits: config.spec.bits,
    group: config.analogGroup ?? 0,
    gain,
  };
}

const A0 = sourceOf(0);
const A1 = sourceOf(8);
const store = fixtureStore();

{
  const sample = 1234;
  const points = projectCursorVoltages(store, [A0], { sample, previousWave: false });
  const expected = analogVoltsFromCode(trace[sample]!, 1);
  check('a placed cursor reads the exact current-wave code of each source and converts it with that source gain',
    points.length === 1 && points[0]!.status === 'value' &&
    points[0]!.code === trace[sample]! && points[0]!.volts === expected &&
    points[0]!.name === 'A0' && points[0]!.busId === 'bus-0',
    `status=${points[0]?.status}, code=${points[0]?.code}, trace=${trace[sample]}, ` +
    `volts=${points[0]?.volts}`);
}

{
  const sample = 4321;
  const one = projectCursorVoltages(store, [A0], { sample, previousWave: false })[0]!;
  const three = projectCursorVoltages(store, [sourceOf(0, 3)], { sample, previousWave: false })[0]!;
  check('each source keeps its own calibration: the same code reads three times smaller at 3x',
    one.code === three.code && one.volts !== null && three.volts !== null &&
    Math.abs(one.volts / three.volts - 3) < 1e-9,
    `1x=${one.volts}, 3x=${three.volts}`);
}

{
  const points = projectCursorVoltages(store, [A0, A1], { sample: 777, previousWave: false });
  check('every visible source answers at the one cursor sample, in source order',
    points.length === 2 && points[0]!.busId === 'bus-0' && points[1]!.busId === 'bus-8' &&
    points.every((point) => point.status === 'value'),
    `points=${points.map((point) => `${point.busId}:${point.status}`).join(',')}`);
}

{
  const gapped = fixtureStore();
  gapped.noteGap(2000, 2100);
  const inside = projectCursorVoltages(gapped, [A0], { sample: 2050, previousWave: false })[0]!;
  const before = projectCursorVoltages(gapped, [A0], { sample: 1999, previousWave: false })[0]!;
  check('a gap marks only its own sample unknown: the value is withheld and the code is disclosed',
    inside.status === 'unknown' && inside.volts === null && inside.code === trace[2050]! &&
    before.status === 'value' && before.volts !== null,
    `inside=${inside.status}/${inside.volts}, before=${before.status}`);
}

{
  const last = store.length - 1;
  const end = projectCursorVoltages(store, [A0], { sample: last, previousWave: false })[0]!;
  const beyond = projectCursorVoltages(store, [A0], { sample: store.length, previousWave: false })[0]!;
  const far = projectCursorVoltages(
    store, [A0], { sample: store.length + 5000, previousWave: false })[0]!;
  check('the last captured sample reads and anything past it is outside the wave, never clamped onto a neighbour',
    end.status === 'value' && end.code === trace[last]! &&
    beyond.status === 'outside' && beyond.volts === null && beyond.code === null &&
    far.status === 'outside',
    `end=${end.status}, beyond=${beyond.status}, far=${far.status}`);
}

{
  const none = projectCursorVoltages(null, [A0], { sample: null, previousWave: false })[0]!;
  const held = projectCursorVoltages(store, [A0], { sample: 100, previousWave: true })[0]!;
  const live = projectCursorVoltages(store, [A0], { sample: 100, previousWave: false })[0]!;
  check('no cursor and a held previous wave both withhold the value and say why; the same request without the hold reads the current wave',
    none.status === 'no-cursor' && none.volts === null &&
    held.status === 'previous-wave' && held.volts === null && held.code === null &&
    live.status === 'value' && live.code === trace[100]!,
    `none=${none.status}, held=${held.status}, live=${live.status}`);
}

{
  const short = createSampleStore(8, 100e6);
  short.append(new Uint8Array(8 * 4));
  const points = projectCursorVoltages(short, [sourceOf(24)], { sample: 0, previousWave: false })[0]!;
  const noStore = projectCursorVoltages(null, [A0], { sample: 0, previousWave: false })[0]!;
  const twice = projectCursorVoltages(
    store, [{ ...A0, bits: [0, 0, 1, 2] }], { sample: 0, previousWave: false })[0]!;
  const huge = projectCursorVoltages(
    store, [{ ...A0, bits: [0, 1, 2, 99] }], { sample: 0, previousWave: false })[0]!;
  check('a source whose bits do not fit the loaded capture or repeat a channel reports no source instead of throwing',
    points.status === 'no-source' && points.volts === null && noStore.status === 'no-source' &&
    twice.status === 'no-source' && huge.status === 'no-source',
    `short=${points.status}, empty=${noStore.status}, twice=${twice.status}, huge=${huge.status}`);
}

{
  const compositeLength = store.length * 3;
  const outside = projectCursorVoltages(store, [A0], {
    sample: compositeLength - 1, previousWave: false,
  })[0]!;
  check('an old Repeat composite position beyond the current wave is never sampled as current data',
    outside.status === 'outside' && outside.volts === null,
    `status=${outside.status}`);
}

{
  const point = projectCursorVoltages(store, [A0], { sample: 1234, previousWave: false })[0]!;
  const values = [
    cursorVoltageValue(point),
    cursorVoltageValue({ ...point, status: 'unknown', volts: null }),
    cursorVoltageValue({ ...point, status: 'previous-wave', volts: null }),
  ];
  check('a measured value renders with the ruler formatter and every withheld state renders the shared placeholder',
    values[0] !== CURSOR_VOLTS_PLACEHOLDER && values[0]!.endsWith(' V') &&
    values[1] === CURSOR_VOLTS_PLACEHOLDER && values[2] === CURSOR_VOLTS_PLACEHOLDER &&
    CURSOR_VOLTS_PLACEHOLDER === '--',
    `values=${values.join('|')}`);

  const details = [
    cursorVoltageDetail(point, '1'),
    cursorVoltageDetail({ ...point, status: 'unknown', volts: null }, '2'),
    cursorVoltageDetail({ ...point, status: 'outside', volts: null }, '2'),
    cursorVoltageDetail({ ...point, status: 'previous-wave', volts: null }, '2'),
    cursorVoltageDetail({ ...point, status: 'no-source', volts: null }, '2'),
    cursorVoltageDetail({ ...point, status: 'no-cursor', volts: null }, '2'),
  ];
  check('every withheld state has its own localized disclosure, and the value names its cursor',
    details[0]!.includes(values[0]!) && details[0]!.includes('1') &&
    details.slice(1).every((text, index) => text.length > 0 && text !== details[index]) &&
    new Set(details).size === details.length,
    `details=${details.join(' | ')}`);
}

{
  let queries = 0;
  const counted = fixtureStore();
  const counter = {
    get length() { return counted.length; },
    get droppedSamples() { return counted.droppedSamples; },
    get channelCount() { return counted.channelCount; },
    get samplerate() { return counted.samplerate; },
    query: (...args: Parameters<SampleStore['query']>) => {
      queries += 1;
      return counted.query(...args);
    },
    gaps: () => counted.gaps(),
    sampleAt: (channel: number, index: number) => counted.sampleAt(channel, index),
    edges: (channel: number, lo: number, hi: number) => counted.edges(channel, lo, hi),
  } as SampleStore;
  const projection = new CursorVoltageProjection();
  const sources = [A0, A1];
  const first = projection.project(counter, sources, { sample: 600, previousWave: false });
  const afterFirst = queries;
  const again = projection.project(counter, sources, { sample: 600, previousWave: false });
  const afterAgain = queries;
  const moved = projection.project(counter, sources, { sample: 601, previousWave: false });
  const afterMoved = queries;
  const held = projection.project(counter, sources, { sample: 601, previousWave: true });
  const afterHeld = queries;
  const replaced = projection.project(fixtureStore(), sources, { sample: 601, previousWave: true });
  const afterReplaced = queries;
  check('the projection is cached on its own inputs: an unchanged refresh reads nothing, a moved cursor reads once more',
    afterFirst === 16 && afterAgain === afterFirst &&
    afterMoved === afterFirst + 16 && afterHeld === afterMoved + 0 &&
    afterReplaced === afterHeld &&
    again === first && moved[0]!.code === trace[601]! &&
    held.every((point) => point.status === 'previous-wave') &&
    replaced.every((point) => point.status === 'previous-wave'),
    `queries=${afterFirst},${afterAgain},${afterMoved},${afterHeld},${afterReplaced}`);

  const oneSource = [A0];
  projection.project(counter, oneSource, { sample: 700, previousWave: false });
  const afterOne = queries;
  const both = projection.project(counter, sources, { sample: 700, previousWave: false });
  const afterBoth = queries;
  check('a visibility change re-reads only the sources that are now visible',
    afterOne === afterReplaced + 8 && afterBoth === afterOne + 16 && both.length === 2,
    `one=${afterOne}, both=${afterBoth}`);
}

{
  const body = methodBody(fs.readFileSync('src/ui/cursorVoltages.ts', 'utf8'), 'export function projectCursorVoltages(');
  check('one single-sample read per source, through the exact measurement reader',
    body.includes('start: request.sample, end: request.sample + 1,') &&
    body.includes('readMeasureSamples(store, source,') &&
    !body.includes('sampleAt(') && !body.includes('for (let'),
    `start=${body.includes('request.sample + 1')}, reader=${body.includes('readMeasureSamples(')}`);

  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const projection = methodBody(app, 'private analogCursorVoltages(');
  const strip = methodBody(app, 'private analogStripView(sources: readonly AnalogBandSource[]): AnalogSourceStripView {');
  const drawPaths = ['private drawBusRows(', 'private draw(', 'private frame(']
    .map((signature) => methodBody(app, signature));
  check('App projects from the current acquisition wave only, excludes hidden sources and never queries inside a drawing path',
    projection.includes('this.captureStore.length > 0 ? this.captureStore : null') &&
    projection.includes('previousWave: this.repeatShowingFront') &&
    projection.includes('visibleAnalogSources(sources, this.hiddenAnalogSources())') &&
    !projection.includes('this.store') && !projection.includes('repeatComposite') &&
    drawPaths.every((body) => !body.includes('analogCursorVoltages(') &&
      !body.includes('projectCursorVoltages(')) &&
    strip.includes('const read = cursor !== null && visible ? point : undefined;') &&
    strip.includes('volts: read === undefined ? \'\' : cursorVoltageValue(read),') &&
    strip.includes('voltsDetail: read === undefined ? \'\' : cursorVoltageDetail(read, label),'),
    `wave=${projection.includes('this.captureStore.length > 0')}, ` +
    `held=${projection.includes('repeatShowingFront')}, ` +
    `hidden=${projection.includes('visibleAnalogSources(')}, ` +
    `draw=${drawPaths.map((body) => body.includes('analogCursorVoltages(')).join(',')}`);

  const composite = projection.replace(
    'this.captureStore.length > 0 ? this.captureStore : null', 'this.store');
  const unfiltered = projection.replace(
    'visibleAnalogSources(sources, this.hiddenAnalogSources())', 'sources');
  const reader = methodBody(app, 'private refreshAnalogVoltages(): void');
  check('control: reading the display store or the unfiltered band fails the same predicate',
    projection !== composite && !composite.includes('this.captureStore.length > 0') &&
    projection !== unfiltered && !unfiltered.includes('visibleAnalogSources(') &&
    reader.includes('this.sourceStrip.updateVoltages(this.analogStripView(sources));'),
    `composite=${composite.includes('this.captureStore.length > 0')}, ` +
    `unfiltered=${unfiltered.includes('visibleAnalogSources(')}`);
}

{
  const projection = new CursorVoltageProjection();
  const live = fixtureStore();
  const sample = 900;
  const before = projection.project(live, [A0], { sample, previousWave: false });
  live.noteGap(sample, sample + 1);
  const after = projection.project(live, [A0], { sample, previousWave: false });
  check('a gap noted after a cached read re-reads instead of serving the known code it replaced',
    before[0]!.status === 'value' && after[0]!.status === 'unknown' && after[0]!.volts === null,
    `before=${before[0]?.status}, after=${after[0]?.status}`);
  const renamed = projection.project(
    live, [{ ...A0, name: 'Shunt' }], { sample, previousWave: false });
  check('a cached read never survives a renamed source',
    renamed[0]!.name === 'Shunt', `name=${renamed[0]!.name}`);

  let queries = 0;
  const counted = fixtureStore();
  const counter = {
    get length() { return counted.length; },
    get droppedSamples() { return counted.droppedSamples; },
    get channelCount() { return counted.channelCount; },
    get samplerate() { return counted.samplerate; },
    query: (...args: Parameters<SampleStore['query']>) => {
      queries += 1;
      return counted.query(...args);
    },
    gaps: () => counted.gaps(),
    sampleAt: (channel: number, index: number) => counted.sampleAt(channel, index),
    edges: (channel: number, lo: number, hi: number) => counted.edges(channel, lo, hi),
  } as SampleStore;
  const remapped = new CursorVoltageProjection();
  const plain = remapped.project(counter, [A0], { sample, previousWave: false });
  const afterPlain = queries;
  const same = remapped.project(counter, [A0], { sample, previousWave: false });
  const afterSame = queries;
  const reversed = remapped.project(
    counter, [{ ...A0, bits: [...A0.bits].reverse() }], { sample, previousWave: false });
  const afterReversed = queries;
  const reversedCode = (code: number): number => {
    let out = 0;
    for (let k = 0; k < 8; k++) if ((code >> k) & 1) out |= 1 << (7 - k);
    return out;
  };
  check('a re-mapped source bit set re-reads and answers the source it was asked for',
    afterPlain === 8 && afterSame === afterPlain && afterReversed === afterPlain + 8 &&
    same[0]!.code === plain[0]!.code &&
    reversed[0]!.code === reversedCode(plain[0]!.code!),
    `queries=${afterPlain},${afterSame},${afterReversed}, ` +
    `plain=${plain[0]!.code}, reversed=${reversed[0]!.code}`);
}

{
  const classBody = fs.readFileSync('src/ui/cursorVoltages.ts', 'utf8');
  const keyed = (source: string): boolean => {
    const body = methodBody(source, 'export class CursorVoltageProjection');
    return body.includes('store?.droppedSamples ?? -1') &&
      body.includes('store.gaps().map((gap) =>') &&
      body.includes('${source.name}:${source.color}') &&
      body.includes('request.sample ??') && body.includes('request.previousWave ? 1 : 0');
  };
  const noGaps = classBody.replace(
    'store === null ? \'\' : store.gaps().map((gap) => `${gap.startSample}-${gap.endSample}`).join(\',\'),',
    "'' ,");
  const noNames = classBody.replace('${source.name}:${source.color}', '');
  check('the projection cache key covers the store identity and its coverage, the sample and every printed source field',
    keyed(classBody), `keyed=${keyed(classBody)}`);
  check('control: dropping the gap coverage or a printed source field from the key fails the same predicate',
    noGaps !== classBody && !keyed(noGaps) && noNames !== classBody && !keyed(noNames),
    `gaps=${keyed(noGaps)}, names=${keyed(noNames)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
