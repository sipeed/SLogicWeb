// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../../data/adcTraceFiles.js';
import { createSampleStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import { scanAnalogCodes } from '../../dsp/analogScan.js';
import { ADC_ZERO_CODE, analogBusConfig, analogVoltsPerCode } from '../channelBanks.js';
import { readMeasureSamples } from '../measureSamples.js';
import {
  MAX_REFERENCE_SAMPLES, MAX_REFERENCE_TRACES, addReference, planReferenceSave, projectReference,
  pruneReferences, referenceGaps, referencePosition, referenceSampleIndex, referenceSignature,
  referenceSpanAt, referenceTrace, referenceVisible, referenceVolts, referenceY, removeReference,
  toggleReferenceVisible, visibleReferences,
  type ReferenceTrace, type ReferenceTraceInput,
} from '../referenceTraces.js';

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

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

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

const CHANNELS = 32;
const FIXTURE = loadAdcTrace('sine');
const GAP_SPANS: readonly (readonly [number, number])[] = [[1000, 1010], [70000, 70005]];

function fixtureWord(code: number): number {
  let word = 0;
  for (let k = 0; k < 8; k++) if ((code >> k) & 1) word |= 1 << (7 - k);
  return word;
}

function fixtureStore(): SampleStore {
  const store = createSampleStore(CHANNELS, 100e6);
  const words = new Uint8Array(FIXTURE.length * 4);
  for (let i = 0; i < FIXTURE.length; i++) words[i * 4] = fixtureWord(FIXTURE[i]!);
  store.append(words);
  for (const [from, to] of GAP_SPANS) store.noteGap(from, to);
  return store;
}

const config = analogBusConfig(0, CHANNELS, '#123456');
const bus = {
  bits: config.spec.bits, group: config.analogGroup ?? 0, gain: config.analogGain ?? 1,
};

function makeTrace(overrides: Partial<ReferenceTraceInput> = {}): ReferenceTrace {
  const codes = overrides.codes ?? Uint8Array.from([130, 128, 126, 0, 255]);
  return referenceTrace({
    id: 1,
    busId: 'bus-a0',
    group: 0,
    start: 1000,
    samplePeriod: 1e-8,
    originSample: 100,
    gain: 1,
    zeroCode: ADC_ZERO_CODE,
    voltsPerCode: analogVoltsPerCode(1),
    codes,
    unknown: new Uint8Array(codes.length),
    color: '#CD427E',
    label: 'A0',
    ...overrides,
  });
}

const EMPTY_HIDDEN: ReadonlySet<number> = new Set<number>();
const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));

{
  check('the reference budget is four traces of one mebibyte of codes and one of masks',
    MAX_REFERENCE_TRACES === 4 && MAX_REFERENCE_SAMPLES === 1 << 20 &&
      MAX_REFERENCE_SAMPLES * 2 * MAX_REFERENCE_TRACES === 8 * 1024 * 1024,
    `traces=${MAX_REFERENCE_TRACES}, samples=${MAX_REFERENCE_SAMPLES}`);
}

{
  const exact = planReferenceSave({ start: 100, end: 200, storeLength: 1000, droppedSamples: 5000 });
  check('a save plan copies the requested window and reports its absolute captured range',
    exact.kind === 'save' && exact.start === 100 && exact.end === 200 &&
      exact.absoluteStart === 5100 && exact.absoluteEnd === 5200,
    JSON.stringify(exact));

  const cropped = planReferenceSave({
    start: -250, end: 200_000, storeLength: 150_000, droppedSamples: 5000,
  });
  check('a window wider than the retained store is cropped to it, not refused, and discloses both edges',
    cropped.kind === 'save' && cropped.start === 0 && cropped.end === 150_000 &&
      cropped.absoluteStart === 5000 && cropped.absoluteEnd === 155_000,
    JSON.stringify(cropped));

  const limit = planReferenceSave({
    start: 0, end: MAX_REFERENCE_SAMPLES, storeLength: MAX_REFERENCE_SAMPLES, droppedSamples: 0,
  });
  const over = planReferenceSave({
    start: 0, end: MAX_REFERENCE_SAMPLES + 1, storeLength: MAX_REFERENCE_SAMPLES + 1, droppedSamples: 0,
  });
  check('the sample cap is accepted exactly at the limit and refused one sample above it',
    limit.kind === 'save' && limit.end === MAX_REFERENCE_SAMPLES &&
      over.kind === 'refuse' && over.reason === 'too-wide' &&
      Object.keys(over).join(',') === 'kind,reason',
    `limit=${limit.kind}, over=${JSON.stringify(over)}, keys=${Object.keys(over).join(',')}`);

  const wideAfterCrop = planReferenceSave({
    start: 0, end: 3 * MAX_REFERENCE_SAMPLES, storeLength: 3 * MAX_REFERENCE_SAMPLES, droppedSamples: 0,
  });
  check('the cap is judged on the retained window that would actually be captured',
    wideAfterCrop.kind === 'refuse' && wideAfterCrop.reason === 'too-wide',
    JSON.stringify(wideAfterCrop));

  const zero = planReferenceSave({ start: 400, end: 400, storeLength: 1000, droppedSamples: 0 });
  const inverted = planReferenceSave({ start: 500, end: 400, storeLength: 1000, droppedSamples: 0 });
  const noData = planReferenceSave({ start: 0, end: 10, storeLength: 0, droppedSamples: 0 });
  check('an empty span, an inverted span and an empty store are refused as empty',
    zero.kind === 'refuse' && zero.reason === 'empty' &&
      inverted.kind === 'refuse' && inverted.reason === 'empty' &&
      noData.kind === 'refuse' && noData.reason === 'empty',
    `zero=${zero.kind}/${'reason' in zero ? zero.reason : ''}, inverted=${inverted.kind}/${'reason' in inverted ? inverted.reason : ''}, empty-store=${noData.kind}/${'reason' in noData ? noData.reason : ''}`);

  const past = planReferenceSave({ start: 2000, end: 3000, storeLength: 1000, droppedSamples: 0 });
  const atEdge = planReferenceSave({ start: 1000, end: 2000, storeLength: 1000, droppedSamples: 0 });
  const before = planReferenceSave({ start: -500, end: -100, storeLength: 1000, droppedSamples: 0 });
  check('a window with no retained sample is refused as outside, including both far edges',
    past.kind === 'refuse' && past.reason === 'outside' &&
      atEdge.kind === 'refuse' && atEdge.reason === 'outside' &&
      before.kind === 'refuse' && before.reason === 'outside',
    `past=${past.kind}, at-edge=${atEdge.kind}, before=${before.kind}`);

  const throws: string[] = [];
  for (const input of [
    { start: 1.5, end: 10, storeLength: 100, droppedSamples: 0 },
    { start: 0, end: 10, storeLength: -1, droppedSamples: 0 },
    { start: 0, end: 10, storeLength: 100, droppedSamples: 2.5 },
    { start: 0, end: Number.NaN, storeLength: 100, droppedSamples: 0 },
  ]) {
    try {
      planReferenceSave(input);
    } catch (error) {
      throws.push(error instanceof RangeError ? 'RangeError' : String(error));
    }
  }
  check('a non-integer window, length or offset throws a RangeError instead of planning a snapshot',
    throws.length === 4 && throws.every((kind) => kind === 'RangeError'), throws.join(','));
}

{
  const store = fixtureStore();
  const read = readMeasureSamples(store, bus, { start: 500, end: 80_000, maxSamples: 100_000 });
  const plan = planReferenceSave({
    start: read.start, end: read.end, storeLength: store.length, droppedSamples: store.droppedSamples,
  });
  const saveOrigin = 400;
  const trace = plan.kind === 'save'
    ? referenceTrace({
      id: 7,
      busId: 'bus-a0',
      group: bus.group,
      start: plan.absoluteStart,
      samplePeriod: 1 / store.samplerate,
      originSample: plan.absoluteStart - saveOrigin,
      gain: analogBusConfig(0, CHANNELS, '#123456').analogGain ?? 1,
      zeroCode: ADC_ZERO_CODE,
      voltsPerCode: analogVoltsPerCode(1),
      codes: read.codes,
      unknown: read.unknown,
      color: '#CD427E',
      label: 'A0',
    })
    : null;

  let firstMismatch = -1;
  let codeMismatches = 0;
  let unknownMismatches = 0;
  let expectedUnknown = 0;
  if (trace !== null) {
    const offset = read.start;
    for (let i = 0; i < trace.codes.length; i++) {
      if (trace.codes[i] !== FIXTURE[offset + i]) {
        codeMismatches += 1;
        if (firstMismatch < 0) firstMismatch = i;
      }
      const wantGap = GAP_SPANS.some(([from, to]) => offset + i >= from && offset + i < to) ? 1 : 0;
      if (wantGap) expectedUnknown += 1;
      if (trace.unknown[i] !== wantGap) unknownMismatches += 1;
    }
  }

  check('a real ADC window snapshots every code sample-for-sample with its unknown spans preserved',
    trace !== null && read.analyzed === 79_500 && trace.codes.length === 79_500 &&
      trace.unknown.length === 79_500 && codeMismatches === 0 && firstMismatch < 0 &&
      unknownMismatches === 0 && expectedUnknown === GAP_SPANS.reduce((n, [a, b]) => n + b - a, 0),
    `codes=${trace?.codes.length}, analyzed=${read.analyzed}, mismatches=${codeMismatches} (first ${firstMismatch}), unknown-mismatches=${unknownMismatches}, unknown=${expectedUnknown}`);

  check('the snapshot carries the absolute start, the saved period and the origin-relative start',
    trace !== null && trace.start === 500 && trace.samplePeriod === 1e-8 &&
      trace.originSample === 100 && trace.start - trace.originSample === saveOrigin,
    trace === null ? 'no snapshot' : `start=${trace.start}, period=${trace.samplePeriod}, origin=${trace.originSample}`);

  const gaps = trace === null ? [] : referenceGaps(trace);
  check('gap spans are reported in trace coordinates, trailing and interior alike',
    gaps.length === 2 && gaps[0]!.start === 500 && gaps[0]!.end === 510 &&
      gaps[1]!.start === 69_500 && gaps[1]!.end === 69_505,
    JSON.stringify(gaps));

  const unknownVolts = trace === null ? 0 : referenceVolts(trace, 502);
  const knownVolts = trace === null ? 0 : referenceVolts(trace, 600);
  check('an unknown sample has no voltage while its neighbours keep the saved calibration',
    Number.isNaN(unknownVolts) && knownVolts === (FIXTURE[1100]! - ADC_ZERO_CODE) * analogVoltsPerCode(1),
    `unknown=${unknownVolts}, known=${knownVolts}`);

  const aliased = trace !== null && (trace.codes === read.codes || trace.unknown === read.unknown);
  if (trace !== null) {
    const held = trace.codes[600]!;
    const heldUnknown = trace.unknown[600]!;
    read.codes[600] = 0;
    read.unknown[600] = 1;
    check('the snapshot owns its bytes: overwriting the reader afterwards cannot change it',
      !aliased && trace.codes[600] === held && trace.unknown[600] === heldUnknown,
      `aliased=${aliased}, code=${trace.codes[600]}/${held}, unknown=${trace.unknown[600]}/${heldUnknown}`);
  } else {
    check('the snapshot owns its bytes: overwriting the reader afterwards cannot change it', false,
      'no snapshot');
  }

  const source = Uint8Array.from([1, 2, 3, 4]);
  const sourceUnknown = Uint8Array.from([0, 1, 0, 0]);
  const guarded = makeTrace({ codes: source, unknown: sourceUnknown });
  source[1] = 9;
  sourceUnknown[1] = 0;
  check('the constructor copies the caller\'s arrays instead of retaining them',
    guarded.codes !== source && guarded.unknown !== sourceUnknown &&
      guarded.codes[1] === 2 && guarded.unknown[1] === 1,
    `codes=${guarded.codes.join(',')}, unknown=${guarded.unknown.join(',')}`);

  const mismatchThrows: string[] = [];
  try {
    makeTrace({ codes: new Uint8Array(3), unknown: new Uint8Array(4) });
  } catch (error) {
    mismatchThrows.push(error instanceof RangeError ? 'RangeError' : String(error));
  }
  try {
    makeTrace({ codes: new Uint8Array(0), unknown: new Uint8Array(0) });
  } catch (error) {
    mismatchThrows.push(error instanceof RangeError ? 'RangeError' : String(error));
  }
  try {
    makeTrace({ codes: new Uint8Array(MAX_REFERENCE_SAMPLES + 1), unknown: new Uint8Array(MAX_REFERENCE_SAMPLES + 1) });
  } catch (error) {
    mismatchThrows.push(error instanceof RangeError ? 'RangeError' : String(error));
  }
  try {
    makeTrace({ samplePeriod: 0 });
  } catch (error) {
    mismatchThrows.push(error instanceof RangeError ? 'RangeError' : String(error));
  }
  check('unequal arrays, an empty snapshot, an oversized snapshot and a zero period are all rejected',
    mismatchThrows.length === 4 && mismatchThrows.every((kind) => kind === 'RangeError'),
    mismatchThrows.join(','));
}

{
  const A = makeTrace({ id: 1, busId: 'bus-a0', group: 0, label: 'A0' });
  const B = makeTrace({ id: 2, busId: 'bus-a1', group: 1, label: 'A1', start: 2000 });
  const C = makeTrace({ id: 3, busId: 'bus-a2', group: 2, label: 'A2', start: 3000 });
  const D = makeTrace({ id: 4, busId: 'bus-a3', group: 3, label: 'A3', start: 4000 });

  let list: ReferenceTrace[] = [];
  for (const trace of [A, B, C, D]) {
    const added = addReference(list, trace);
    if (added.kind !== 'added') throw new Error(`unexpected refusal ${added.reason}`);
    list = added.list;
  }
  const order = list.map((trace) => trace.busId).join(',');
  const before = referenceSignature(pruneReferences(list, new Set(['bus-a0'])), EMPTY_HIDDEN);

  const fifth = addReference(list, makeTrace({ id: 5, busId: 'bus-a4', group: 0, label: 'B0' }));
  const after = referenceSignature(pruneReferences(list, new Set(['bus-a0'])), EMPTY_HIDDEN);
  check('a fifth reference is refused with a reason and leaves the existing four untouched',
    list.length === MAX_REFERENCE_TRACES &&
      order === 'bus-a0,bus-a1,bus-a2,bus-a3' &&
      fifth.kind === 'refuse' && fifth.reason === 'limit' &&
      after === before,
    `count=${list.length}, order=${order}, fifth=${JSON.stringify(fifth)}, unchanged=${after === before}`);

  const replaced = addReference(list, makeTrace({
    id: 9, busId: 'bus-a1', group: 1, label: 'A1 relabelled', start: 2100, gain: 3,
  }));
  const replacedList = replaced.kind === 'added' ? replaced.list : list;
  check('a second save for the same bus replaces that reference in place, keeping the order',
    replaced.kind === 'added' && replaced.replaced && replacedList.length === 4 &&
      replacedList.map((trace) => trace.busId).join(',') === order &&
      replacedList[1]!.id === 9 && replacedList[1]!.label === 'A1 relabelled' &&
      replacedList[1]!.gain === 3 && replacedList[0] === list[0]! && replacedList[2] === list[2]!,
    `kind=${replaced.kind}, ids=${replacedList.map((trace) => trace.id).join(',')}`);

  const idClash = addReference(replacedList, makeTrace({
    id: 9, busId: 'bus-a3', group: 3, label: 'clash',
  }));
  check('a replacement that reuses another trace\'s id is refused without touching the list',
    idClash.kind === 'refuse' && idClash.reason === 'id-taken',
    JSON.stringify(idClash));

  const sameIdSameBus = addReference(list, makeTrace({ id: 1, busId: 'bus-a0', label: 'A0 again' }));
  const sameIdList = sameIdSameBus.kind === 'added' ? sameIdSameBus.list : list;
  check('re-saving a bus with its own id replaces rather than refusing',
    sameIdSameBus.kind === 'added' && sameIdSameBus.replaced &&
      sameIdList[0]!.label === 'A0 again' && sameIdList.length === 4,
    `kind=${sameIdSameBus.kind}, label=${sameIdList[0]?.label}`);

  const removed = removeReference(list, 2);
  const missing = removeReference(list, 99);
  check('removal drops exactly the requested id and an absent id changes nothing',
    removed.length === 3 && removed.map((trace) => trace.id).join(',') === '1,3,4' &&
      missing.length === 4 && missing.every((trace, i) => trace === list[i]),
    `removed=${removed.map((trace) => trace.id).join(',')}, missing=${missing.length}`);

  const hiddenOnce = toggleReferenceVisible(EMPTY_HIDDEN, 3);
  const hiddenTwice = toggleReferenceVisible(hiddenOnce, 3);
  check('visibility toggles without mutating the set it was given',
    EMPTY_HIDDEN.size === 0 && hiddenOnce.has(3) && hiddenOnce.size === 1 &&
      hiddenTwice.size === 0 && hiddenTwice !== hiddenOnce,
    `original=${EMPTY_HIDDEN.size}, once=${[...hiddenOnce].join(',')}, twice=${hiddenTwice.size}`);
}

{
  const A = makeTrace({ id: 1, busId: 'bus-a0', group: 0, label: 'A0' });
  const B = makeTrace({ id: 2, busId: 'bus-a1', group: 1, label: 'A1', start: 2000 });
  const C = makeTrace({ id: 3, busId: 'bus-a2', group: 2, label: 'A2', start: 3000 });
  const list = [A, B, C];

  const pruned = pruneReferences(list, new Set(['bus-a0', 'bus-a2']));
  check('pruning keeps every reference listed and marks the unavailable ones instead of deleting them',
    pruned.length === 3 && pruned[0]!.available && !pruned[1]!.available && pruned[2]!.available &&
      pruned.map((entry) => entry.trace.id).join(',') === '1,2,3' &&
      list.length === 3,
    pruned.map((entry) => `${entry.trace.id}:${entry.available}`).join(','));

  const hidden = new Set([2]);
  const shown = visibleReferences(pruned, hidden);
  check('a hidden reference and an unavailable one are both absent from the drawable list',
    shown.length === 2 && shown.map((entry) => entry.trace.id).join(',') === '1,3' &&
      referenceVisible(pruned[0]!, hidden) &&
      !referenceVisible(pruned[1]!, EMPTY_HIDDEN) &&
      referenceVisible(pruned[2]!, hidden),
    `shown=${shown.map((entry) => entry.trace.id).join(',')}, unavailable=${referenceVisible(pruned[1]!, EMPTY_HIDDEN)}`);

  const allHidden = visibleReferences(pruned, new Set([1, 2, 3]));
  check('hiding every source empties the drawable list without deleting any reference',
    allHidden.length === 0 && pruned.length === 3 &&
      referenceSignature(pruned, new Set([1, 2, 3])) !== referenceSignature(pruned, EMPTY_HIDDEN),
    `drawable=${allHidden.length}, listed=${pruned.length}`);
}

{
  const trace = makeTrace({
    originSample: 1000, samplePeriod: 1e-8, codes: new Uint8Array(2000), unknown: new Uint8Array(2000),
  });
  const span = (viewStart: number, viewEnd: number, samplePeriod = 1e-8) =>
    referenceSpanAt(trace, { viewStart, viewEnd, samplePeriod });
  const show = (value: unknown): string => (value === null ? 'null' : JSON.stringify(value));

  const inside = span(500, 1500);
  const leading = span(2000, 3000);
  const overshoot = span(-1000, 5000);
  check('the projected span is the intersection of the viewport and the saved window',
    show(inside) === show({ start: 0, end: 500 }) &&
      show(leading) === show({ start: 1000, end: 2000 }) &&
      show(overshoot) === show({ start: 0, end: 2000 }),
    `inside=${show(inside)}, leading=${show(leading)}, overshoot=${show(overshoot)}`);

  const beforeSpan = span(0, 1000);
  const afterSpan = span(3000, 4000);
  const degenerate = span(1000, 1000);
  check('a viewport that only touches or misses the saved window projects nothing',
    beforeSpan === null && afterSpan === null && degenerate === null,
    `before=${show(beforeSpan)}, after=${show(afterSpan)}, degenerate=${show(degenerate)}`);

  const slower = span(500, 1500, 4e-8);
  check('a live sample-rate change re-aligns by time, using the saved period for the trace',
    show(slower) === show({ start: 1000, end: 2000 }),
    show(slower));

  const secondsToPx = (samplePeriod: number, viewStart: number, viewEnd: number) => {
    const fromSeconds = viewStart * samplePeriod;
    const windowSeconds = (viewEnd - viewStart) * samplePeriod;
    return (sample: number): number =>
      ((sample * samplePeriod - fromSeconds) / windowSeconds) * 200;
  };
  const paint = (viewStart: number, viewEnd: number, samplePeriod: number): number[] =>
    [...projectReference(trace, { viewStart, viewEnd, samplePeriod },
      secondsToPx(samplePeriod, viewStart, viewEnd), 200).xs];
  const quarterRate = paint(500, 700, 4e-8);
  const sameSeconds = paint(2000, 2800, 1e-8);
  const rateAligned = quarterRate.length > 0 && quarterRate.length === sameSeconds.length &&
    quarterRate.every((x, i) => near(x, sameSeconds[i]!));
  const oneToColumn = [...projectReference(
    trace, { viewStart: 1200, viewEnd: 1400, samplePeriod: 1e-8 }, (sample) => sample, 200).xs];
  check('the same wall-clock window paints identical reference pixels at two live sample rates',
    rateAligned && oneToColumn.length === 200 && oneToColumn[0] === 1200 &&
      oneToColumn[199] === 1399,
    `quarter=${quarterRate.length}/${quarterRate[0]}..${quarterRate[quarterRate.length - 1]}, ` +
    `full=${sameSeconds.length}/${sameSeconds[0]}..${sameSeconds[sameSeconds.length - 1]}, ` +
    `one-to-column=${oneToColumn.length}`);

  const fractional = (() => {
    try {
      return { value: span(500.4, 1500.75), error: '' };
    } catch (error) {
      return { value: null, error: String(error) };
    }
  })();
  check('a panned or zoomed fractional viewport projects whole trace samples at both edges',
    fractional.error === '' && show(fractional.value) === show({ start: 0, end: 501 }),
    fractional.error === '' ? show(fractional.value) : fractional.error);

  const finiteThrows: string[] = [];
  for (const [from, to] of [[Number.NaN, 1000], [0, Number.POSITIVE_INFINITY]]) {
    try {
      referenceSpanAt(trace, { viewStart: from!, viewEnd: to!, samplePeriod: 1e-8 });
    } catch (error) {
      finiteThrows.push(error instanceof RangeError ? 'RangeError' : String(error));
    }
  }
  check('a non-finite viewport bound throws instead of projecting',
    finiteThrows.length === 2 && finiteThrows.every((kind) => kind === 'RangeError'),
    finiteThrows.join(','));

  const periodThrows: string[] = [];
  for (const period of [0, -1e-8, Number.NaN, Number.POSITIVE_INFINITY]) {
    try {
      span(0, 1000, period);
    } catch (error) {
      periodThrows.push(error instanceof RangeError ? 'RangeError' : String(error));
    }
  }
  check('a non-positive or non-finite live period throws rather than projecting',
    periodThrows.length === 4 && periodThrows.every((kind) => kind === 'RangeError'),
    periodThrows.join(','));

  const at = (sample: number, samplePeriod?: number) => referenceSampleIndex(trace, sample, samplePeriod);
  const points = [
    at(1000), at(1500), at(2999), at(3000), at(999), at(500),
  ];
  check('an origin-relative sample maps to its trace index and out-of-range maps to null',
    points[0] === 0 && points[1] === 500 && points[2] === 1999 &&
      points[3] === null && points[4] === null && points[5] === null,
    points.map((p) => String(p)).join(','));

  const slowerPoints = [at(250, 4e-8), at(249, 4e-8), at(749, 4e-8), at(750, 4e-8)];
  check('the same mapping holds when the live rate differs from the saved rate',
    slowerPoints[0] === 0 && slowerPoints[1] === null &&
      slowerPoints[2] === 1996 && slowerPoints[3] === null,
    slowerPoints.map((p) => String(p)).join(','));

  check('a non-finite sample is treated as out of range',
    at(Number.NaN) === null && at(Number.POSITIVE_INFINITY) === null,
    `${at(Number.NaN)}, ${at(Number.POSITIVE_INFINITY)}`);

  const inverse: string[] = [];
  for (const period of [1e-8, 4e-8]) {
    for (const index of [0, 1, 999, 1000, 1999]) {
      const position = referencePosition(trace, index, period);
      if (at(position, period) !== index) inverse.push(`${period}:${index}@${position}`);
    }
  }
  check('projecting a trace index out and back returns the same index at both rates',
    inverse.length === 0, inverse.join(','));

  check('the projected position of the first sample follows the saved origin and both periods',
    near(referencePosition(trace, 0, 1e-8), 1000) && near(referencePosition(trace, 0, 4e-8), 250) &&
      near(referencePosition(trace, 2000, 1e-8), 3000),
    `${referencePosition(trace, 0, 1e-8)}, ${referencePosition(trace, 0, 4e-8)}, ${referencePosition(trace, 2000, 1e-8)}`);
}

{
  const trace = makeTrace({
    codes: Uint8Array.from([130, 128, 126, 0, 255]),
    unknown: Uint8Array.from([0, 0, 1, 0, 0]),
    zeroCode: ADC_ZERO_CODE,
    voltsPerCode: analogVoltsPerCode(1),
    gain: 1,
  });
  const perCode = analogVoltsPerCode(1);
  const values = [referenceVolts(trace, 0), referenceVolts(trace, 1), referenceVolts(trace, 2),
    referenceVolts(trace, 3), referenceVolts(trace, 4)];
  check('volts are the saved code offset times the saved volts-per-code, unknown is none',
    near(values[0]!, (130 - ADC_ZERO_CODE) * perCode) && near(values[1]!, 0) &&
      Number.isNaN(values[2]!) && near(values[3]!, (0 - ADC_ZERO_CODE) * perCode) &&
      near(values[4]!, (255 - ADC_ZERO_CODE) * perCode),
    values.map((v) => String(v)).join(','));

  check('an index outside the snapshot has no voltage',
    Number.isNaN(referenceVolts(trace, -1)) && Number.isNaN(referenceVolts(trace, 5)) &&
      Number.isNaN(referenceVolts(trace, 1.5)),
    `${referenceVolts(trace, -1)}, ${referenceVolts(trace, 5)}, ${referenceVolts(trace, 1.5)}`);

  let liveGain = 1;
  const savedVolts = referenceVolts(trace, 0);
  const savedSignature = referenceSignature(pruneReferences([trace], new Set([trace.busId])), EMPTY_HIDDEN);
  liveGain = 10;
  const laterVolts = referenceVolts(trace, 0);
  const laterSignature = referenceSignature(pruneReferences([trace], new Set([trace.busId])), EMPTY_HIDDEN);
  const liveVolts = (130 - ADC_ZERO_CODE) * analogVoltsPerCode(liveGain);
  check('a later live gain change leaves the reference calibrated to its save-time gain',
    near(savedVolts, (130 - ADC_ZERO_CODE) * perCode) && laterVolts === savedVolts &&
      laterSignature === savedSignature && !near(liveVolts, savedVolts) &&
      near(liveVolts * 10, savedVolts),
    `saved=${savedVolts}, later=${laterVolts}, live@${liveGain}=${liveVolts}, signature=${laterSignature === savedSignature}`);

  const scope = { yVolts: (volts: number) => 100 - volts * 10 };
  check('the vertical helper routes volts through the row geometry and keeps unknown as NaN',
    near(referenceY(trace, 0, scope), 100 - (130 - ADC_ZERO_CODE) * perCode * 10) &&
      Number.isNaN(referenceY(trace, 2, scope)),
    `${referenceY(trace, 0, scope)}, ${referenceY(trace, 2, scope)}`);
}

{
  const A = makeTrace({ id: 1, busId: 'bus-a0', group: 0, label: 'A0', start: 1000 });
  const base = pruneReferences([A], new Set(['bus-a0']));
  const baseSignature = referenceSignature(base, EMPTY_HIDDEN);
  const same = referenceSignature(pruneReferences([makeTrace({ ...A })], new Set(['bus-a0'])), EMPTY_HIDDEN);
  check('the signature is deterministic and content-derived, not identity-derived',
    baseSignature === referenceSignature(base, EMPTY_HIDDEN) && same === baseSignature &&
      baseSignature.split(':').length >= 14,
    `fields=${baseSignature.split(':').length}, stable=${same === baseSignature}`);

  const variants: readonly [string, () => string][] = [
    ['id', () => referenceSignature(pruneReferences([makeTrace({ id: 2 })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['start', () => referenceSignature(pruneReferences([makeTrace({ start: 1001 })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['samplePeriod', () => referenceSignature(pruneReferences([makeTrace({ samplePeriod: 2e-8 })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['gain', () => referenceSignature(pruneReferences([makeTrace({ gain: 3, voltsPerCode: analogVoltsPerCode(3) })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['zeroCode', () => referenceSignature(pruneReferences([makeTrace({ zeroCode: 127 })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['voltsPerCode', () => referenceSignature(pruneReferences([makeTrace({ voltsPerCode: 0.25 })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['color', () => referenceSignature(pruneReferences([makeTrace({ color: '#00994D' })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['label', () => referenceSignature(pruneReferences([makeTrace({ label: 'A0 saved' })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['length', () => referenceSignature(pruneReferences([makeTrace({
      codes: Uint8Array.from([130, 128, 126, 0, 255, 12]),
      unknown: new Uint8Array(6),
    })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['interior code', () => referenceSignature(pruneReferences([makeTrace({
      codes: Uint8Array.from([130, 128, 127, 0, 255]),
    })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['unknown bit', () => referenceSignature(pruneReferences([makeTrace({
      unknown: Uint8Array.from([0, 0, 1, 0, 0]),
    })], new Set(['bus-a0'])), EMPTY_HIDDEN)],
    ['availability', () => referenceSignature(pruneReferences([A], new Set<string>()), EMPTY_HIDDEN)],
    ['visibility', () => referenceSignature(base, new Set([1]))],
  ];
  const unchanged: string[] = [];
  for (const [name, compute] of variants) {
    if (compute() === baseSignature) unchanged.push(name);
  }
  check('every declared signature input changes the signature, including an interior code and unknown byte',
    unchanged.length === 0,
    unchanged.length === 0 ? `changed=${variants.length}` : `unchanged=${unchanged.join(',')}`);

  const withSecond = pruneReferences([A, makeTrace({ id: 2, busId: 'bus-a1', group: 1 })], new Set(['bus-a0']));
  check('adding a listed reference changes the signature without changing the first entry',
    withSecond.length === 2 &&
      referenceSignature(withSecond, EMPTY_HIDDEN) !== baseSignature &&
      referenceSignature(withSecond, EMPTY_HIDDEN).startsWith(baseSignature + '|'),
    `entries=${withSecond.length}`);
}

{
  const count = 4096;
  const codes = Uint8Array.from({ length: count }, (_, i) => 60 + ((i * 13) % 120));
  const unknown = new Uint8Array(count);
  const trace = makeTrace({
    originSample: 0, samplePeriod: 1e-8, codes, unknown,
  });
  const columns = 512;
  const projection = projectReference(trace, { viewStart: 0, viewEnd: count, samplePeriod: 1e-8 },
    (sample) => sample / (count / columns), columns);
  const perColumn = count / columns;
  const worst: string[] = [];
  for (let column = 0; column < columns; column++) {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let i = column * perColumn; i < (column + 1) * perColumn; i++) {
      low = Math.min(low, codes[i]!);
      high = Math.max(high, codes[i]!);
    }
    const want = [low, high].map((code) => (code - ADC_ZERO_CODE) * analogVoltsPerCode(1));
    const got: number[] = [];
    for (let i = 0; i < projection.xs.length; i++) {
      if (Math.floor(projection.xs[i]!) === column) got.push(projection.volts[i]!);
    }
    const covered = want.every((value) => got.some((v) => Math.abs(v - value) <= 1e-12)) &&
      got.every((value) => value >= want[0]! - 1e-12 && value <= want[1]! + 1e-12);
    if (!covered) worst.push(`${column}:${got.join(',')} vs ${want.join(',')}`);
  }
  check('a dense projection covers every column with that column\'s exact code extremes, nothing wider',
    worst.length === 0 && projection.xs.length > 0 && projection.xs.length <= columns * 2 + 2,
    worst.length === 0 ? `vertices=${projection.xs.length}` : worst.slice(0, 3).join(' | '));

  const sparse = makeTrace({
    originSample: 0, samplePeriod: 1e-8,
    codes: Uint8Array.from([130, 128, 126, 124]), unknown: new Uint8Array(4),
  });
  const points = projectReference(sparse, { viewStart: 0, viewEnd: 8, samplePeriod: 1e-8 },
    (sample) => sample, 8);
  const xs = [...points.xs];
  const volts = [...points.volts];
  check('a sparse projection is one vertex per sample on its own pixel, from the saved calibration',
    xs.join(',') === '0,1,2,3' &&
      volts.join(',') === [130, 128, 126, 124]
        .map((code) => (code - ADC_ZERO_CODE) * analogVoltsPerCode(1)).join(','),
    `xs=${xs.join(',')}, volts=${volts.join(',')}`);

  const live = projectReference(sparse, { viewStart: 0, viewEnd: 8, samplePeriod: 1e-8 },
    (sample) => sample, 8);
  const rescaled = makeTrace({
    originSample: 0, samplePeriod: 1e-8,
    codes: Uint8Array.from([130, 128, 126, 124]), unknown: new Uint8Array(4),
    gain: 10, voltsPerCode: analogVoltsPerCode(10),
  });
  const saved = projectReference(rescaled, { viewStart: 0, viewEnd: 8, samplePeriod: 1e-8 },
    (sample) => sample, 8);
  check('a later live gain is not consulted: the projection keeps the saved volts-per-code',
    [...live.volts].join(',') !== [...saved.volts].join(',') &&
      Math.abs(saved.volts[0]! - (130 - ADC_ZERO_CODE) * analogVoltsPerCode(10)) <= 1e-12 &&
      Math.abs(saved.volts[0]! * 10 - live.volts[0]!) <= 1e-12,
    `live=${live.volts[0]}, saved=${saved.volts[0]}`);

  const gapCodes = Uint8Array.from([128, 130, 126, 124, 128, 130, 126, 124]);
  const gapUnknown = Uint8Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
  const gapTrace = makeTrace({
    originSample: 0, samplePeriod: 1e-8, codes: gapCodes, unknown: gapUnknown,
  });
  const gapProjection = projectReference(
    gapTrace, { viewStart: 0, viewEnd: 8, samplePeriod: 1e-8 }, (sample) => sample, 8);
  const breakAt = [...gapProjection.xs].findIndex((x) => Number.isNaN(x));
  const knownAfter = [...gapProjection.volts].slice(breakAt + 1).filter((v) => !Number.isNaN(v));
  const knownOnly = projectReference(
    makeTrace({
      originSample: 0, samplePeriod: 1e-8, codes: gapCodes, unknown: new Uint8Array(8),
    }), { viewStart: 0, viewEnd: 8, samplePeriod: 1e-8 }, (sample) => sample, 8);
  check('an unknown span becomes one NaN break and only the known samples stay drawable',
    breakAt > 0 && Number.isNaN(gapProjection.volts[breakAt]!) && knownAfter.length === 0 &&
      ![...knownOnly.xs].some((x) => Number.isNaN(x)) && knownOnly.volts.length === 8,
    `break=${breakAt}, after=${knownAfter.length}, without-mask=${knownOnly.volts.length}`);

  const clipped = makeTrace({
    originSample: 1000, samplePeriod: 1e-8,
    codes: new Uint8Array(2000), unknown: new Uint8Array(2000),
  });
  const windowed = projectReference(
    clipped, { viewStart: 1500, viewEnd: 1600, samplePeriod: 1e-8 }, (sample) => sample, 100);
  const inside = [...windowed.xs].every((x) => x >= 1500 && x <= 1600);
  check('the projection never leaves the saved window it intersects',
    windowed.xs.length > 0 && inside &&
      Math.min(...windowed.xs) === 1500 && Math.max(...windowed.xs) <= 1600,
    `from=${Math.min(...windowed.xs)}, to=${Math.max(...windowed.xs)}, inside=${inside}`);

  const empty = projectReference(clipped, { viewStart: 0, viewEnd: 100, samplePeriod: 1e-8 },
    (sample) => sample, 100);
  let thrown = '';
  try {
    projectReference(clipped, { viewStart: Number.NaN, viewEnd: 100, samplePeriod: 1e-8 },
      (sample) => sample, 100);
  } catch (error) {
    thrown = error instanceof RangeError ? 'RangeError' : String(error);
  }
  check('a viewport that misses the window projects nothing and a non-finite one throws',
    empty.xs.length === 0 && empty.volts.length === 0 && thrown === 'RangeError',
    `empty=${empty.xs.length}, thrown=${thrown}`);
}

{
  const overlay = fs.readFileSync('src/ui/overlay.ts', 'utf8');
  const dash = /const REFERENCE_DASH: readonly number\[\] = \[4, 3\];/.test(overlay);
  const alpha = /const REFERENCE_ALPHA = 0\.55;/.test(overlay);
  const field = overlay.includes('references?: readonly AnalogReferenceView[];') &&
    overlay.includes('export interface AnalogReferenceView {');
  const scopeOfReference = overlay.includes(
    'o.top, o.band, reference.scope.voltsPerDiv, reference.scope.zeroPosition);');
  const breaks = overlay.includes('if (Number.isNaN(x) || Number.isNaN(value)) {') &&
    overlay.includes('c.setLineDash([...REFERENCE_DASH]);');
  const painted = overlay.includes('c.strokeStyle = reference.color;') &&
    overlay.includes('const y = geometryForReference.yVolts(value);');
  const referenceAt = overlay.indexOf('for (const reference of o.references ?? []) {');
  const traceAt = overlay.indexOf('for (const t of o.traces) {');
  const block = referenceAt >= 0 && traceAt > referenceAt ? overlay.slice(referenceAt, traceAt) : '';
  const chromeFree = block.length > 0 && !block.includes('fillText') &&
    !block.includes('setLineDash([4, 3])') && !block.includes('triggerVolts') &&
    !block.includes('scopeTickIndices');
  check('an analog band draws references as dashed, dimmed saved-calibration lines above the grid and below the live traces',
    dash && alpha && field && scopeOfReference && breaks && painted && chromeFree &&
      referenceAt >= 0 && traceAt > referenceAt &&
      /c\.globalAlpha = REFERENCE_ALPHA;/.test(block),
    `dash=${dash}, alpha=${alpha}, field=${field}, scope=${scopeOfReference}, ` +
    `breaks=${breaks}, painted=${painted}, chromeFree=${chromeFree}`);

  const referencePass = (source: string): boolean => {
    const at = source.indexOf('for (const reference of o.references ?? []) {');
    const traces = source.indexOf('for (const t of o.traces) {');
    const body = at >= 0 && traces > at ? source.slice(at, traces) : '';
    return body.length > 0 && !body.includes('fillText') &&
      /c\.globalAlpha = REFERENCE_ALPHA;/.test(body) &&
      /const REFERENCE_DASH: readonly number\[\] = \[4, 3\];/.test(source) &&
      /const REFERENCE_ALPHA = 0\.55;/.test(source);
  };
  const undashed = overlay.replace('const REFERENCE_DASH: readonly number[] = [4, 3];',
    'const REFERENCE_DASH: readonly number[] = [];');
  const opaque = overlay.replace('const REFERENCE_ALPHA = 0.55;', 'const REFERENCE_ALPHA = 1;');
  const withChrome = overlay.replace(
    '      c.strokeStyle = reference.color;',
    "      c.fillText('ref', 0, 0);\n      c.strokeStyle = reference.color;");
  check('control: a solid, opaque or chrome-painting reference pass fails the same predicate',
    referencePass(overlay) && !referencePass(undashed) && !referencePass(opaque) &&
      !referencePass(withChrome),
    `plain=${referencePass(overlay)}, undashed=${referencePass(undashed)}, ` +
    `opaque=${referencePass(opaque)}, chrome=${referencePass(withChrome)}`);
}

const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const saveBody = methodBody(app, 'private saveReference(bus: BusViewState): void {');
const removeBody = methodBody(app, 'private removeReference(id: number): void {');
const syncBody = methodBody(app, 'private syncReferences(): void {');
const validityBody = methodBody(app, 'private referenceValidity(): ReadonlySet<string> {');
const hiddenBody = methodBody(app, 'private referenceHiddenIds(): ReadonlySet<number> {');
const viewsBody = methodBody(app, 'private referenceViews(');
const projectionBody = methodBody(app, 'private referenceProjection(trace: ReferenceTrace): ReferenceProjection {');

function savePath(source: string): boolean {
  const body = methodBody(source, 'private saveReference(bus: BusViewState): void {');
  const planAt = body.indexOf('const plan = planReferenceSave({');
  const readAt = body.indexOf('readMeasureSamples(');
  const addAt = body.indexOf('addReference(this.references, referenceTrace({');
  return body.includes('const store = this.captureStore;') &&
    body.includes('storeLength: store.length, droppedSamples: store.droppedSamples,') &&
    planAt > 0 && readAt > planAt && addAt > readAt &&
    body.includes('maxSamples: MAX_REFERENCE_SAMPLES') &&
    body.includes('store, { bits: bus.spec.bits, group, gain },') &&
    body.includes('originSample: plan.start - (this.triggerSampleIndex ?? 0),') &&
    body.includes('samplePeriod: 1 / store.samplerate,') &&
    body.includes('voltsPerCode: analogVoltsPerCode(gain),') &&
    body.includes('zeroCode: ADC_ZERO_CODE,') &&
    body.includes('this.references = added.list;') &&
    !body.includes('persistWorkspace') && !body.includes('this.settings') &&
    !body.includes('this.cursors') && !body.includes('setViewport');
}

function refusalInert(source: string): boolean {
  const body = methodBody(source, 'private saveReference(bus: BusViewState): void {');
  const refusalAt = body.indexOf("if (plan.kind === 'refuse') {");
  const addedAt = body.indexOf("if (added.kind === 'refuse') {");
  if (refusalAt < 0 || addedAt < refusalAt) return false;
  const block = body.slice(refusalAt, addedAt);
  return block.includes('this.setFileNotice({ key: REFERENCE_SAVE_REFUSALS[plan.reason] });') &&
    block.includes('return;') && !block.includes('this.references =') &&
    !block.includes('this.dirty = true;');
}

{
  check('a save plans the window, reads the current wave through the shared exact reader and snapshots one trace with its saved calibration',
    savePath(app),
    `save=${savePath(app)}, length=${saveBody.length}`);
  const noPlanner = app.replace('const plan = planReferenceSave({',
    'const plan = { kind: \'save\' as const, start: 0, end: 0, absoluteStart: 0, absoluteEnd: 0 }; void ({');
  const noLimit = app.replace('maxSamples: MAX_REFERENCE_SAMPLES', 'maxSamples: undefined');
  const fromDisplay = app.replace(
    '    const store = this.captureStore;\n    const view = this.stack.view;',
    '    const store = this.store;\n    const view = this.stack.view;');
  const persisted = app.replace(
    '    this.syncReferences();\n    this.setFileNotice(this.referenceSaveNotice(',
    '    this.persistWorkspace();\n    this.syncReferences();\n    this.setFileNotice(this.referenceSaveNotice(');
  check('control: dropping the planner, the cap or the current-wave reader fails the same predicate',
    !savePath(noPlanner) && !savePath(noLimit) && !savePath(fromDisplay) && !savePath(persisted),
    `planner=${savePath(noPlanner)}, limit=${savePath(noLimit)}, display=${savePath(fromDisplay)}, ` +
    `persist=${savePath(persisted)}`);

  const silentRefusal = app.replace(
    "    if (plan.kind === 'refuse') {\n      this.setFileNotice({ key: REFERENCE_SAVE_REFUSALS[plan.reason] });\n      return;\n    }\n",
    "    if (plan.kind === 'refuse') {\n      this.setFileNotice({ key: 'references.save' });\n      return;\n    }\n");
  const guard = "    if (plan.kind === 'refuse') {\n" +
    "      this.setFileNotice({ key: REFERENCE_SAVE_REFUSALS[plan.reason] });\n" +
    "      return;\n    }\n";
  const fallthrough = app.replace(guard, '');
  const frontGuard = saveBody.indexOf('if (this.repeatShowingFront) {');
  const planAt = saveBody.indexOf('const plan = planReferenceSave({');
  const refusesFront = (source: string): boolean => {
    const body = methodBody(source, 'private saveReference(bus: BusViewState): void {');
    const guard = body.indexOf('if (this.repeatShowingFront) {');
    const plan = body.indexOf('const plan = planReferenceSave({');
    if (guard < 0 || plan < 0 || guard > plan) return false;
    const block = body.slice(guard, plan);
    return block.includes("this.setFileNotice({ key: 'references.refusedPreviousWave' });") &&
      block.includes('return;') && !block.includes('readMeasureSamples(') &&
      !block.includes('this.references =');
  };
  const frontUnchecked = app.replace(
    "    if (this.repeatShowingFront) {\n      this.setFileNotice({ key: 'references.refusedPreviousWave' });\n      return;\n    }\n", '');
  check('a previously captured wave on screen refuses the save instead of reading another wave\'s coordinates',
    frontGuard > 0 && frontGuard < planAt && refusesFront(app) && !refusesFront(frontUnchecked),
    `guard=${frontGuard}, plan=${planAt}, unchecked=${refusesFront(frontUnchecked)}`);

  check('every refusal leaves the reference list, the cache and the acquisition untouched and names its reason',
    refusalInert(app) && !refusalInert(silentRefusal) && !refusalInert(fallthrough) &&
      saveBody.includes("key: added.reason === 'limit' ? 'references.refusedLimit' : 'references.refusedId',"),
    `inert=${refusalInert(app)}, silent=${refusalInert(silentRefusal)}, ` +
    `fallthrough=${refusalInert(fallthrough)}`);
}

{
  const removed = removeBody.includes('const next = removeReference(this.references, id);') &&
    removeBody.includes('this.references = next;') &&
    removeBody.includes('this.syncReferences();') &&
    removeBody.includes('this.dirty = true;') &&
    !removeBody.includes('persistWorkspace') &&
    !removeBody.includes('.slice(') && !removeBody.includes('.splice(');
  const inPlace = app.replace(
    '    this.references = next;', '    this.references.splice(0, 0);\n    this.references = next;');
  const persisted = app.replace(
    'private removeReference(id: number): void {',
    'private removeReference(id: number): void {\n    this.persistWorkspace();');
  const removesOf = (source: string): boolean => {
    const body = methodBody(source, 'private removeReference(id: number): void {');
    return body.includes('this.references = next;') && body.includes('this.syncReferences();') &&
      !body.includes('persistWorkspace') && !body.includes('.splice(');
  };
  check('removal drops the trace from session state, re-signs and frees its cached projection',
    removed && syncBody.includes('this.referenceCache.clear();'),
    `removed=${removed}, cached=${syncBody.includes('this.referenceCache.clear();')}`);
  check('control: removing in place or persisting a removal fails the same predicate',
    !removesOf(inPlace) && !removesOf(persisted) && removesOf(app),
    `inPlace=${removesOf(inPlace)}, persisted=${removesOf(persisted)}`);
}

{
  const signature = syncBody.includes('this.referenceEntries = pruneReferences(this.references, this.referenceValidity());') &&
    syncBody.includes('const hidden = this.referenceHiddenIds();') &&
    syncBody.includes('if (key === this.referenceSigKey) return;') &&
    syncBody.includes('this.referenceSig = referenceSignature(this.referenceEntries, hidden);') &&
    hiddenBody.includes('if (hiddenBuses.has(trace.busId)) ids.add(trace.id);') &&
    hiddenBody.includes('this.hiddenAnalogSources()') &&
    !hiddenBody.includes('this.analogHidden =') &&
    !app.includes('this.referenceHidden =') &&
    validityBody.includes('groups.get(trace.busId) === trace.group') &&
    validityBody.includes('for (const band of this.analogRowBands)');
  const relayout = methodBody(app, 'private relayout(): void {');
  const busSig = methodBody(app, 'private busSignature(viewStart: number, viewEnd: number): number {');
  check('the reference signature is cached once per mutation, keyed on ids, availability and hidden sources',
    signature && !app.includes('this.persistWorkspace();\n    this.syncReferences();'),
    `signature=${signature}`);
  check('the bus frame signature carries the cached reference signature and relayout re-derives availability',
    busSig.includes('this.referenceSig,') && relayout.includes('this.syncReferences();') &&
      saveBody.includes('this.syncReferences();') && removeBody.includes('this.syncReferences();'),
    `bus=${busSig.includes('this.referenceSig,')}, relayout=${relayout.includes('this.syncReferences();')}`);
  const unsigned = app.replace('      this.referenceSig,\n', '');
  const perFrame = app.replace('this.referenceSig = referenceSignature(', 'this.referenceSig = String(referenceSignature(');
  const uncached = app.replace('    if (key === this.referenceSigKey) return;\n', '');
  const signedOf = (source: string): boolean => methodBody(
    source, 'private busSignature(viewStart: number, viewEnd: number): number {')
    .includes('this.referenceSig,');
  const cachedOf = (source: string): boolean => methodBody(
    source, 'private syncReferences(): void {')
    .includes('if (key === this.referenceSigKey) return;');
  check('control: an unsigned bus layer, a per-frame or uncached signature fails the same predicate',
    unsigned !== app && !signedOf(unsigned) && perFrame !== app && uncached !== app &&
      !cachedOf(uncached) && cachedOf(app),
    `unsigned=${signedOf(unsigned)}, uncached=${cachedOf(uncached)}`);
}

{
  const drawBody = methodBody(app, 'private drawBusRows(');
  const calibrationFromTrace = viewsBody.includes(
    'visibleReferences(this.referenceEntries, this.referenceHiddenIds())') &&
    viewsBody.includes('color: entry.trace.color') &&
    viewsBody.includes('this.analogScopeView(bus)') &&
    !viewsBody.includes('analogVoltsPerCode');
  check('references reach the band pass only for available, shown sources of that band',
    drawBody.includes('const references = this.referenceViews(visible);') &&
      drawBody.includes('...(references.length > 0 ? { references } : {}),') &&
      calibrationFromTrace,
    `draw=${drawBody.includes('this.referenceViews(visible)')}, calibration=${calibrationFromTrace}`);
  const drawAll = app.replace(
    'const references = this.referenceViews(visible);',
    'const references = this.referenceViews(band.sources);');
  const liveCalibration = app.replace(
    'color: entry.trace.color', 'color: entry.trace.color, gain: analogVoltsPerCode(1)');
  check('control: projecting hidden sources or re-deriving live calibration fails the same predicate',
    drawAll !== app && !drawAll.includes('this.referenceViews(visible)') &&
    liveCalibration !== app && liveCalibration.includes('analogVoltsPerCode(1)'),
    `hidden=${drawAll.includes('this.referenceViews(visible)')}`);
  const cached = projectionBody.includes('if (cached !== undefined && cached.key === key) return cached;') &&
    projectionBody.includes('${view.start}:${view.end}:${this.stack.widthDevicePx}:${dpr}:${origin}:${period}') &&
    projectionBody.includes('viewStart: view.start - origin, viewEnd: view.end - origin, samplePeriod: period,') &&
    projectionBody.includes('(sample) => this.toPx(origin + sample)');
  check('the per-trace projection is cached by viewport, size, pixel ratio, origin and live period',
    cached, `cached=${cached}`);
}

{
  const menuWired = (source: string): boolean => {
    const body = methodBody(source, 'private scopeMenuItems(bus: BusViewState): ScopeMenuItem[] {');
    const pointerBody = methodBody(source, 'private scopeBarMenu(event: MouseEvent, bar: HTMLDivElement): void {');
    const keyboardBody = methodBody(source, 'private openScopeMenuAt(bar: HTMLDivElement): void {');
    const keyBody = methodBody(source, 'private keyScopeBar(event: KeyboardEvent, bar: HTMLDivElement): void {');
    return body.includes("label: t('references.save'), hint: '',") &&
      body.includes("label: t('references.remove'),") &&
      body.includes("hint: hiddenBuses.has(trace.busId) ? t('references.hidden') : trace.label,") &&
      body.includes("label: t('references.removeNamed', { label: entry.trace.label }),") &&
      body.includes("hint: t('references.unavailable'),") &&
      body.includes('this.saveReference(b)') &&
      body.includes('onPick: () => this.removeReference(trace.id)') &&
      pointerBody.includes('openScopeMenu(event.clientX, event.clientY, bar, this.scopeMenuItems(bus));') &&
      keyboardBody.includes(
        'openScopeMenu(rect.right, rect.top + rect.height / 2, bar, this.scopeMenuItems(bus));') &&
      keyBody.includes("if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {") &&
      keyBody.includes('this.openScopeMenuAt(bar);');
  };
  const scopeMenu = fs.readFileSync('src/ui/scopeMenu.ts', 'utf8');
  const focus = scopeMenu.includes('if (refocus) anchor.focus({ preventScroll: true });') &&
    scopeMenu.includes('close(true);\n      item.onPick();');
  check('save and remove live in the one per-source scope menu and are reachable by pointer and keyboard',
    menuWired(app) && focus, `wired=${menuWired(app)}, focus=${focus}`);
  const noKeyboard = app.replace(
    "    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {",
    '    if (event.key === \'GoBack\') {');
  const noRemove = app.replace('onPick: () => this.removeReference(trace.id),', '');
  const noSave = app.replace("label: t('references.save'), hint: '',", "label: '', hint: '',");
  check('control: dropping the keyboard entry, the save or the remove command fails the same predicate',
    !menuWired(noKeyboard) && !menuWired(noRemove) && !menuWired(noSave),
    `keyboard=${menuWired(noKeyboard)}, remove=${menuWired(noRemove)}, save=${menuWired(noSave)}`);
}

{
  const validEvery = pruneReferences(
    [makeTrace({ id: 1, busId: 'bus-a0', group: 0 }), makeTrace({ id: 2, busId: 'bus-a1', group: 1 })],
    new Set(['bus-a0', 'bus-a1']));
  const replaced = pruneReferences(
    [makeTrace({ id: 1, busId: 'bus-a0', group: 0 }), makeTrace({ id: 2, busId: 'bus-a1', group: 1 })],
    new Set(['bus-a0', 'bus-a1']));
  const removedGroup = pruneReferences(
    [makeTrace({ id: 1, busId: 'bus-a0', group: 0 }), makeTrace({ id: 2, busId: 'bus-a1', group: 1 })],
    new Set(['bus-a1']));
  const regrouped = pruneReferences(
    [makeTrace({ id: 1, busId: 'bus-a0', group: 0 })], new Set(['bus-a0']));
  const hiddenAll = new Set([1, 2]);
  check('a capture replacement keeps both references available and drawable',
    validEvery.every((entry) => entry.available) &&
      visibleReferences(replaced, EMPTY_HIDDEN).length === 2,
    `available=${validEvery.map((entry) => entry.available).join(',')}`);
  check('a removed group keeps its reference listed but unavailable and undrawable, and stays removable',
    removedGroup.length === 2 && !removedGroup[0]!.available && removedGroup[1]!.available &&
      visibleReferences(removedGroup, EMPTY_HIDDEN).length === 1 &&
      removeReference([makeTrace({ id: 2, busId: 'bus-a1', group: 1 })], 2).length === 0,
    `available=${removedGroup.map((entry) => entry.available).join(',')}`);
  check('a regrouped bus makes the old reference unavailable, and all-hidden empties the drawable list only',
    referenceSignature(regrouped, EMPTY_HIDDEN) !== referenceSignature(
      pruneReferences([makeTrace({ id: 1, busId: 'bus-a0', group: 0 })], new Set<string>()), EMPTY_HIDDEN) &&
      visibleReferences(replaced, hiddenAll).length === 0 && replaced.length === 2,
    `regrouped=${regrouped.length}, drawable=${visibleReferences(replaced, hiddenAll).length}`);
}

{
  const store = fixtureStore();
  const windowSpec = { start: 1_000, end: 90_000 };
  const measure = (): string => {
    const read = readMeasureSamples(store, bus, { start: windowSpec.start, end: windowSpec.end, maxSamples: 100_000 });
    const scan = scanAnalogCodes({
      codes: read.codes, unknown: read.unknown, samplerate: store.samplerate,
      zeroCode: ADC_ZERO_CODE, voltsPerCode: analogVoltsPerCode(bus.gain),
      rising: true, level: ADC_ZERO_CODE, hysteresis: 2, window: 8,
    });
    return JSON.stringify({ codes: Array.from(read.codes), unknown: Array.from(read.unknown), scan });
  };
  const before = measure();
  const saved = readMeasureSamples(store, bus, { start: windowSpec.start, end: windowSpec.end, maxSamples: MAX_REFERENCE_SAMPLES });
  let list: readonly ReferenceTrace[] = [];
  const added = addReference(list, referenceTrace({
    id: 1, busId: 'bus-a0', group: bus.group, start: windowSpec.start, samplePeriod: 1 / store.samplerate,
    originSample: windowSpec.start, gain: bus.gain, zeroCode: ADC_ZERO_CODE,
    voltsPerCode: analogVoltsPerCode(bus.gain), codes: saved.codes, unknown: saved.unknown,
    color: '#CD427E', label: 'A0',
  }));
  if (added.kind === 'added') list = added.list;
  const withReference = measure();
  list = removeReference(list, 1);
  const after = measure();
  const modules = [
    'src/ui/measureSamples.ts', 'src/ui/measurementState.ts', 'src/ui/measurementStats.ts',
    'src/ui/measurementRows.ts', 'src/ui/measurementCatalog.ts', 'src/dsp/analogScan.ts',
  ];
  const leaks = modules.filter((path) => fs.readFileSync(path, 'utf8').includes('referenceTraces'));
  const measurementBody = methodBody(app, 'private measurementView(): MeasurementSectionView {');
  const waveBody = methodBody(app, 'private recordMeasurementWave(reason: CaptureStopReason): void {');
  check('a reference save and remove leave the measurement read and scan byte-identical',
    before === withReference && before === after && before.length > 1000,
    `equal=${before === withReference && before === after}, bytes=${before.length}`);
  check('no measurement, statistics, FFT or XY module reads references and no measurement body touches them',
    leaks.length === 0 && !measurementBody.includes('reference') && !waveBody.includes('reference'),
    `leaks=${leaks.join(',')}, view=${measurementBody.includes('reference')}, wave=${waveBody.includes('reference')}`);
}

{
  const catalog = (locale: string): string[] => {
    const text = fs.readFileSync(`src/ui/locales/${locale}.ts`, 'utf8');
    const keys: string[] = [];
    for (const line of text.split('\n')) {
      const match = /^\s*'(references\.[a-zA-Z]+)':\s*'(.*)',$/.exec(line);
      if (match) keys.push(`${match[1]}=${match[2]}`);
    }
    return keys;
  };
  const en = catalog('en');
  const names = (rows: string[]): string => rows.map((row) => row.split('=')[0]!).join(',');
  const others = ['zh-CN', 'ru', 'fr'].map((locale) => catalog(locale));
  const sameKeys = others.every((rows) => names(rows) === names(en));
  const translated = others.every((rows) => rows.every((row, i) => row.split('=')[1] !== en[i]!.split('=')[1]));
  check('all four catalogs carry the same twelve reference strings with real translations',
    en.length === 12 && sameKeys && translated,
    `en=${en.length}, keys=${sameKeys}, translated=${translated}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
