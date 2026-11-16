// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../../data/adcTraceFiles.js';
import { scanAnalogCodes, type AnalogCodeScan } from '../../dsp/analogScan.js';
import { ADC_ZERO_CODE, analogVoltsPerCode } from '../channelBanks.js';
import {
  CaptureRangeJob, MEASURE_CAPTURE_BUDGET_MS, MEASURE_CAPTURE_CHUNK, captureJobKey,
  captureRangeUnavailable,
  type CaptureJobChunk, type CaptureJobKeyInput, type CaptureJobKeySource,
  type CaptureJobReader, type CaptureJobSource,
} from '../measureCaptureJob.js';
import { MEASURE_READ_CHUNK, MEASURE_SCAN_SAMPLES } from '../measureSamples.js';
import type { MeasurementSource } from '../measurementState.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
}

const TRACE = loadAdcTrace('sine');
const LSB = analogVoltsPerCode(1);
const BUS = { bits: [7, 6, 5, 4, 3, 2, 1, 0], group: 0, gain: 1 };
const SOURCE: MeasurementSource = { group: 0, start: 0, gain: 1, name: 'A0' };
const SCAN = {
  samplerate: 100e6,
  zeroCode: ADC_ZERO_CODE,
  voltsPerCode: LSB,
  rising: true,
  level: 128,
  hysteresis: 4,
  window: 50,
};

function jobSource(over: Partial<CaptureJobSource['scan']> = {}): CaptureJobSource {
  return { source: SOURCE, bus: BUS, scan: { ...SCAN, ...over } };
}

interface Call { from: number; to: number }

function readerFor(
  codes: Uint8Array, unknown: Uint8Array, calls: Call[] = [],
): CaptureJobReader {
  return (_source, from, to) => {
    calls.push({ from, to });
    return { codes: codes.slice(from, to), unknown: unknown.slice(from, to) };
  };
}

function noUnknown(length: number): Uint8Array {
  return new Uint8Array(length);
}

function runChunked(
  codes: Uint8Array, unknown: Uint8Array, chunk: number,
  over: Partial<CaptureJobSource['scan']> = {},
): { scan: AnalogCodeScan; calls: Call[]; total: number } {
  const calls: Call[] = [];
  const job = new CaptureRangeJob('c', 0, codes.length, [jobSource(over)], codes.length, chunk);
  const read = readerFor(codes, unknown, calls);
  for (let guard = 0; !job.done; guard += 1) {
    if (guard > codes.length + 2) throw new Error('the job stopped advancing');
    job.step(read, 0);
  }
  const result = job.results()?.get(0);
  if (result === undefined) throw new Error('the chunked run published nothing');
  return { scan: result.scan, calls, total: job.total };
}

function scanKey(scan: AnalogCodeScan): string {
  return [
    scan.analyzed, scan.known, scan.unknown, scan.minCode, scan.maxCode, scan.vppCodes,
    scan.vppVolts, scan.minVolts, scan.maxVolts, scan.meanOffsetCodes, scan.meanVolts,
    scan.rmsOffsetCodes, scan.rmsVolts, scan.crossingCount, scan.crossingCap,
    scan.firstCrossing, scan.lastCrossing, scan.periodSamples, scan.periodSeconds,
    scan.frequencyHz, scan.dutyPercent, scan.dutyPeriods, scan.dutyExcludedPeriods,
    scan.status, scan.clippedLow, scan.clippedHigh, scan.nearSampleLimit,
  ].join('|');
}

{
  check('the chunk and budget are the documented code-selected constants',
    MEASURE_CAPTURE_CHUNK === 16384 && MEASURE_CAPTURE_BUDGET_MS === 8 &&
      MEASURE_CAPTURE_CHUNK % MEASURE_READ_CHUNK === 0 &&
      MEASURE_CAPTURE_CHUNK <= MEASURE_SCAN_SAMPLES,
    `chunk=${MEASURE_CAPTURE_CHUNK}, budget=${MEASURE_CAPTURE_BUDGET_MS}, ` +
      `readChunk=${MEASURE_READ_CHUNK}, scanBound=${MEASURE_SCAN_SAMPLES}`);
}

{
  const whole = scanAnalogCodes({ ...SCAN, codes: TRACE });
  const calls: Call[] = [];
  const read = readerFor(TRACE, noUnknown(TRACE.length), calls);
  const job = new CaptureRangeJob('k', 0, TRACE.length, [jobSource()], TRACE.length);
  job.step(read, 0);
  const firstChunk = calls.length === 1 && calls[0]!.from === 0 &&
    calls[0]!.to === MEASURE_CAPTURE_CHUNK && job.scanned === MEASURE_CAPTURE_CHUNK &&
    !job.done && job.status === 'running';
  while (!job.done) job.step(read, 0);
  const last = calls[calls.length - 1]!;
  const finished = job.results();
  const a0 = finished === null ? undefined : finished.get(0);
  const sameScan = a0 !== undefined && scanKey(a0.scan) === scanKey(whole);
  check('a budgeted step covers exactly one chunk and the whole job equals the full-array scan',
    firstChunk && sameScan && calls.length === Math.ceil(TRACE.length / MEASURE_CAPTURE_CHUNK) &&
      last.to === TRACE.length && last.from === Math.floor(TRACE.length / MEASURE_CAPTURE_CHUNK) *
        MEASURE_CAPTURE_CHUNK &&
      job.scanned === job.total && job.total === TRACE.length,
    `calls=${calls.length}, last=${JSON.stringify(last)}, scanned=${job.scanned}, ` +
    `same=${sameScan}, a0=${a0 === undefined ? 'missing' : scanKey(a0.scan)}`);
  check('the completed summary reports the exact requested length and no truncation',
    a0 !== undefined &&
      a0.read.analyzed === TRACE.length && a0.read.requestedSamples === TRACE.length &&
      !a0.read.truncated && !a0.read.rangeClipped &&
      a0.read.unknownSamples === a0.scan.unknown,
    `read=${JSON.stringify(a0?.read)}`);
  check('a finished job returns the same result map twice without rescanning',
    finished !== null && job.results() === finished,
    `identity=${job.results() === finished}`);
}

{
  const chunk = MEASURE_CAPTURE_CHUNK;
  const full = Math.floor(TRACE.length / chunk);
  const partial = TRACE.length - full * chunk;
  const calls: Call[] = [];
  const steps: number[] = [];
  const job = new CaptureRangeJob('p', 0, TRACE.length, [jobSource()], TRACE.length);
  const read = readerFor(TRACE, noUnknown(TRACE.length), calls);
  while (!job.done) {
    job.step(read, 0);
    steps.push(job.scanned);
  }
  const whole = scanAnalogCodes({ ...SCAN, codes: TRACE });
  const a0 = job.results()?.get(0);
  check('the production chunk walks to a partial final chunk that matches the whole scan',
    chunk === 16384 && full === 18 && partial === 5088 &&
      steps.length === 19 && steps[0] === chunk && steps[steps.length - 1] === TRACE.length &&
      steps.every((value, index) => value === Math.min(TRACE.length, (index + 1) * chunk)) &&
      calls.every((call, index) => call.from === index * chunk &&
        call.to === Math.min(TRACE.length, (index + 1) * chunk)) &&
      a0 !== undefined && scanKey(a0.scan) === scanKey(whole) &&
      a0.read.analyzed === TRACE.length && a0.scan.analyzed === TRACE.length,
    `steps=${steps.length}, full=${full}, partial=${partial}, ` +
      `first=${steps[0]}, last=${steps[steps.length - 1]}, ` +
      `same=${a0 !== undefined && scanKey(a0.scan) === scanKey(whole)}`);

  const square = new Uint8Array(TRACE.length);
  for (let i = 0; i < square.length; i += 1) square[i] = i % 200 < 100 ? 40 : 216;
  const capped = scanAnalogCodes({ ...SCAN, codes: square });
  const capRun = runChunked(square, noUnknown(square.length), chunk);
  check('a crossing cap reached inside the first chunks still equals the whole-array scan',
    capped.crossingCap && capped.crossingCount === 512 &&
      scanKey(capRun.scan) === scanKey(capped) &&
      capRun.calls.length === 19 && capRun.total === square.length,
    `cap=${capped.crossingCount}/${capped.crossingCap}, ` +
      `same=${scanKey(capRun.scan) === scanKey(capped)}, calls=${capRun.calls.length}`);
}

{
  const whole = scanAnalogCodes({ ...SCAN, codes: TRACE });
  const lagChunks = [...new Set([whole.firstCrossing, whole.lastCrossing].flatMap((crossing) =>
    [crossing + 1, crossing + SCAN.window, crossing + SCAN.window + 1]
      .filter((chunk) => chunk >= 1 && chunk <= TRACE.length)))].sort((a, b) => a - b);
  const runs = lagChunks.map((chunk) =>
    ({ chunk, ...runChunked(TRACE, noUnknown(TRACE.length), chunk) }));
  const mismatched = runs.filter((run) => scanKey(run.scan) !== scanKey(whole));
  check('a chunk boundary inside the qualifier decision lag reproduces the whole-array scan',
    lagChunks.length === 6 && mismatched.length === 0 &&
      runs.every((run) => run.calls.length === Math.ceil(TRACE.length / run.chunk)) &&
      runs.filter((run) => run.chunk < TRACE.length / 2).every((run) => run.calls.length > 1),
    `chunks=${JSON.stringify(lagChunks)}, bad=${JSON.stringify(mismatched.map((run) => run.chunk))}, ` +
    `crossings=${whole.firstCrossing}/${whole.lastCrossing}`);
}

{
  const codes = new Uint8Array(200);
  for (let i = 0; i < codes.length; i += 1) codes[i] = i % 7 < 3 ? 100 : 200;
  codes.fill(255, 13, 16);
  codes.fill(0, 34, 37);
  const unknown = noUnknown(codes.length);
  unknown.fill(1, 20, 23);
  const sweep = (window: number): { bad: number[]; broken: number[]; whole: AnalogCodeScan } => {
    const whole = scanAnalogCodes({ ...SCAN, window, codes, unknown });
    const bad: number[] = [];
    const broken: number[] = [];
    for (let chunk = 1; chunk <= codes.length + 5; chunk += 1) {
      const run = runChunked(codes, unknown, chunk, { window });
      if (scanKey(run.scan) !== scanKey(whole)) bad.push(chunk);
      const contiguous = run.calls.every((call, index) =>
        call.from === (index === 0 ? 0 : run.calls[index - 1]!.to));
      const covered = run.calls.reduce((sum, call) => sum + (call.to - call.from), 0);
      if (!contiguous || covered !== run.total || run.total !== codes.length) broken.push(chunk);
    }
    return { bad, broken, whole };
  };
  const small = sweep(3);
  const large = sweep(50);
  check('every chunk size, including one that does not divide the range, matches the whole scan',
    small.bad.length === 0 && large.bad.length === 0 &&
      small.broken.length === 0 && large.broken.length === 0 &&
      small.whole.status === 'ok' && small.whole.crossingCount > 20 &&
      small.whole.clippedLow && small.whole.clippedHigh && small.whole.unknown === 3 &&
      large.whole.status === 'ok' && large.whole.dutyPeriods > 0,
    `smallBad=${JSON.stringify(small.bad)}, largeBad=${JSON.stringify(large.bad)}, ` +
    `broken=${JSON.stringify([...small.broken, ...large.broken])}, ` +
    `crossings=${small.whole.crossingCount}/${large.whole.crossingCount}, ` +
    `periods=${large.whole.dutyPeriods}`);
}

{
  const length = 40;
  const span = 5 + length;
  const codes = TRACE.slice(0, span);
  const calls: Call[] = [];
  const job = new CaptureRangeJob('t', 5, span, [jobSource()], 100, 7);
  const read = readerFor(codes, noUnknown(span), calls);
  const steps: number[] = [];
  while (!job.done) {
    job.step(read, 0);
    steps.push(job.scanned);
  }
  check('scanned advances in whole chunks to exactly the requested length',
    job.total === length && steps.join(',') === '7,14,21,28,35,40' &&
      steps.every((value) => value <= job.total) &&
      calls.every((call) => call.to - call.from <= 7) &&
      calls[0]!.from === 5 && calls[calls.length - 1]!.to === span,
    `steps=${steps.join(',')}, total=${job.total}, calls=${JSON.stringify(calls)}`);

  const afterDone: Call[] = [];
  job.step(readerFor(codes, noUnknown(span), afterDone), 0);
  check('a step after completion reads nothing and keeps the published totals',
    afterDone.length === 0 && job.scanned === length && job.done &&
      job.status === 'done',
    `calls=${afterDone.length}, scanned=${job.scanned}`);

  const cancelled = new CaptureRangeJob('c', 0, 21, [jobSource()], 40, 7);
  const cancelledCalls = readerFor(TRACE.slice(0, 21), noUnknown(21));
  cancelled.step(cancelledCalls, 0);
  const coveredBefore = cancelled.scanned;
  cancelled.cancel();
  const afterCancel: Call[] = [];
  cancelled.step(readerFor(TRACE.slice(0, 21), noUnknown(21), afterCancel), 0);
  check('cancel stops progress, discards the partial scan and never publishes it',
    coveredBefore === 7 && cancelled.status === 'cancelled' && !cancelled.done &&
      afterCancel.length === 0 && cancelled.scanned === coveredBefore &&
      cancelled.results() === null,
    `covered=${coveredBefore}, status=${cancelled.status}, ` +
    `calls=${afterCancel.length}, results=${cancelled.results() === null}`);
  cancelled.cancel();
  check('a second cancel is inert', cancelled.status === 'cancelled',
    `status=${cancelled.status}`);
}

{
  const job = new CaptureRangeJob('f', 0, 21, [jobSource()], 21, 7);
  const calls: Call[] = [];
  const flaky = (_source: CaptureJobSource, from: number, to: number): CaptureJobChunk => {
    calls.push({ from, to });
    if (calls.length === 2) throw new Error('reader failed');
    return { codes: TRACE.slice(from, to), unknown: noUnknown(to - from) };
  };
  let threw = false;
  try {
    while (!job.done) job.step(flaky, 0);
  } catch {
    threw = true;
  }
  check('a failing read leaves no partial aggregate publishable and no double count',
    threw && calls.length === 2 && job.status === 'cancelled' &&
      job.scanned === 7 && job.results() === null,
    `threw=${threw}, calls=${calls.length}, status=${job.status}, scanned=${job.scanned}`);
}

{
  const source2: MeasurementSource = { group: 1, start: 8, gain: 3, name: 'A1' };
  const second: CaptureJobSource = {
    source: source2,
    bus: { bits: BUS.bits, group: 1, gain: 3 },
    scan: { ...SCAN, voltsPerCode: analogVoltsPerCode(3) },
  };
  const job = new CaptureRangeJob('m', 0, 200, [jobSource(), second], 200, 7);
  const read = readerFor(TRACE.slice(0, 200), noUnknown(200));
  while (!job.done) job.step(read, 0);
  const finished = job.results();
  const first = finished?.get(0);
  const other = finished?.get(8);
  check('one accumulator per source is published under that source start',
    finished !== null && finished.size === 2 && first !== undefined && other !== undefined &&
      first.read.analyzed === 200 && other.read.analyzed === 200 &&
      first.scan.known === 200 && other.scan.known === 200 &&
      first.scan.vppCodes === other.scan.vppCodes &&
      other.scan.vppVolts === first.scan.vppCodes * analogVoltsPerCode(3),
    `keys=${finished === null ? 'null' : [...finished.keys()].join(',')}, ` +
    `vpp=${first?.scan.vppVolts}/${other?.scan.vppVolts}`);
}

{
  const codes = new Uint8Array(200);
  for (let i = 0; i < codes.length; i += 1) codes[i] = i % 2 === 0 ? 100 : 200;
  codes.fill(255, 13, 16);
  codes.fill(0, 34, 37);
  const unknown = noUnknown(codes.length);
  unknown.fill(1, 20, 23);
  const whole = scanAnalogCodes({ ...SCAN, window: 3, codes, unknown });
  const job = new CaptureRangeJob(
    'g', 0, codes.length, [jobSource({ window: 3 })], codes.length, 7);
  const calls: Call[] = [];
  const logged = readerFor(codes, unknown, calls);
  while (!job.done) job.step(logged, 0);
  const a0 = job.results()?.get(0);
  check('clipping and gaps that straddle chunk boundaries match the whole-array scan',
    a0 !== undefined && scanKey(a0.scan) === scanKey(whole) &&
      a0.scan.clippedLow && a0.scan.clippedHigh && a0.scan.unknown === 3 &&
      calls.length === Math.ceil(codes.length / 7) &&
      calls.some((call) => call.from <= 13 && call.to > 13) &&
      calls.some((call) => call.from <= 20 && call.to > 20),
    `same=${a0 !== undefined && scanKey(a0.scan) === scanKey(whole)}, ` +
    `clipped=${a0?.scan.clippedLow}/${a0?.scan.clippedHigh}, unknown=${a0?.scan.unknown}, ` +
    `calls=${calls.length}`);
}

{
  const base: CaptureJobKeyInput = {
    store: {},
    storeLength: 300000,
    droppedSamples: 0,
    samplerate: 100e6,
    windowStart: 0,
    windowEnd: 300000,
    sources: [{
      start: 0, group: 0, gain: 1, rising: true, level: 128, hysteresis: 4, window: 50,
    }],
  };
  const keyOf = (patch: Partial<CaptureJobKeyInput> = {}, source: Partial<CaptureJobKeySource> = {}): string =>
    captureJobKey({ ...base, ...patch, sources: [{ ...base.sources[0]!, ...source }] });
  const identity = keyOf();
  const variants: [string, string][] = [
    ['store identity', keyOf({ store: {} })],
    ['store length', keyOf({ storeLength: 299999 })],
    ['dropped samples', keyOf({ droppedSamples: 1024 })],
    ['sample rate', keyOf({ samplerate: 50e6 })],
    ['window start', keyOf({ windowStart: 1 })],
    ['window end', keyOf({ windowEnd: 299999 })],
    ['source start', keyOf({}, { start: 8 })],
    ['source group', keyOf({}, { group: 1 })],
    ['gain', keyOf({}, { gain: 3 })],
    ['slope', keyOf({}, { rising: false })],
    ['level', keyOf({}, { level: 129 })],
    ['hysteresis', keyOf({}, { hysteresis: 6 })],
    ['artifact window', keyOf({}, { window: 80 })],
    ['source set', captureJobKey({ ...base, sources: [] })],
  ];
  const shared = variants.filter(([, key]) => key === identity).map(([name]) => name);
  check('every key field separates its population and an empty source set is its own key',
    shared.length === 0 && keyOf({ sources: base.sources }) === identity,
    `shared=${JSON.stringify(shared)}, variants=${variants.length}`);

  const reversed = captureJobKey({
    ...base,
    sources: [
      { start: 8, group: 1, gain: 3, rising: true, level: 128, hysteresis: 4, window: 50 },
      base.sources[0]!,
    ],
  });
  const forward = captureJobKey({
    ...base,
    sources: [
      base.sources[0]!,
      { start: 8, group: 1, gain: 3, rising: true, level: 128, hysteresis: 4, window: 50 },
    ],
  });
  check('the key is the source SET, so row order cannot fork the job',
    reversed === forward && reversed !== identity,
    `reversed=${reversed === forward}, distinct=${reversed !== identity}`);
}

{
  const matrix: [string, Parameters<typeof captureRangeUnavailable>[0], string | null][] = [
    ['running loop', { running: true, loop: true, storeLength: 1000 }, 'loop'],
    ['stopped loop', { running: false, loop: true, storeLength: 1000 }, 'loop'],
    ['running single', { running: true, loop: false, storeLength: 1000 }, 'stable-capture-required'],
    ['running repeat wave', { running: true, loop: false, storeLength: 300000 }, 'stable-capture-required'],
    ['empty store', { running: false, loop: false, storeLength: 0 }, 'no-data'],
    ['fractional length', { running: false, loop: false, storeLength: 1.5 }, 'no-data'],
    ['stopped repeat wave', { running: false, loop: false, storeLength: 300000 }, null],
  ];
  const wrong = matrix.filter(([, input, expected]) =>
    captureRangeUnavailable(input) !== expected);
  check('only a completed non-Loop capture with data offers the analysis',
    wrong.length === 0 && matrix.length === 7, `wrong=${JSON.stringify(wrong)}`);
}

{
  const bad: [string, () => void][] = [
    ['fractional start', () => new CaptureRangeJob('k', 0.5, 10, [jobSource()])],
    ['negative start', () => new CaptureRangeJob('k', -1, 10, [jobSource()])],
    ['empty range', () => new CaptureRangeJob('k', 10, 10, [jobSource()])],
    ['reversed range', () => new CaptureRangeJob('k', 10, 5, [jobSource()])],
    ['beyond the store', () => new CaptureRangeJob('k', 0, 11, [jobSource()], 10)],
    ['fractional store length', () => new CaptureRangeJob('k', 0, 5, [jobSource()], 5.5)],
    ['zero chunk', () => new CaptureRangeJob('k', 0, 5, [jobSource()], 5, 0)],
    ['fractional chunk', () => new CaptureRangeJob('k', 0, 5, [jobSource()], 5, 2.5)],
    ['negative budget', () => {
      const job = new CaptureRangeJob('k', 0, 5, [jobSource()], 5);
      job.step(readerFor(TRACE.slice(0, 5), noUnknown(5)), -1);
    }],
    ['non-finite budget', () => {
      const job = new CaptureRangeJob('k', 0, 5, [jobSource()], 5);
      job.step(readerFor(TRACE.slice(0, 5), noUnknown(5)), Number.NaN);
    }],
    ['short source read', () => {
      const job = new CaptureRangeJob('k', 0, 5, [jobSource()], 5);
      job.step((_source, from, to) => ({
        codes: TRACE.slice(from, to - 1),
        unknown: noUnknown(to - from - 1),
      } as CaptureJobChunk), 0);
    }],
  ];
  const missed = bad.filter(([, run]) => {
    try {
      run();
      return true;
    } catch (error) {
      return !(error instanceof RangeError);
    }
  }).map(([name]) => name);
  check('an out-of-contract range, chunk, budget or short read throws RangeError',
    missed.length === 0 && bad.length === 11, `missed=${JSON.stringify(missed)}`);
}

{
  const frame = slice(appSource, 'private frame = (): void => {', '\n  };');
  const pump = slice(appSource,
    'private pumpMeasurementCapture(): void {', 'private withMeasurementRows(');
  const view = slice(appSource,
    'private measurementView(): MeasurementSectionView {', 'private measurementBase(');
  const section = slice(appSource,
    'private captureMeasurementSection(', 'private pumpMeasurementCapture(): void {');
  const ordered = (source: string): boolean => {
    const callAt = source.indexOf('this.pumpMeasurementCapture();');
    const idleAt = source.indexOf('if (!this.dirty && !liveDue) return;');
    return callAt >= 0 && idleAt > callAt;
  };
  const latePump = frame.replace('this.pumpMeasurementCapture();\n    ', '')
    .replace('if (!this.dirty && !liveDue) return;',
      'if (!this.dirty && !liveDue) return;\n    this.pumpMeasurementCapture();');
  check('the capture job is pumped before the idle early return, from the one frame callback',
    ordered(frame) && !ordered(latePump) &&
      appSource.split('this.pumpMeasurementCapture();').length - 1 === 1 &&
      pump.includes('if (!this.cursorsPageShown()) return;') &&
      pump.includes("entry.job.status !== 'running'") &&
      pump.includes('entry.job.step(') &&
      pump.includes('MEASURE_CAPTURE_BUDGET_MS') &&
      pump.includes('readMeasureSamples(store, source.bus, {') &&
      !pump.includes('requestAnimationFrame') && !pump.includes('setTimeout') &&
      !pump.includes('setInterval'),
    `ordered=${ordered(frame)}, late=${ordered(latePump)}, ` +
    `calls=${appSource.split('this.pumpMeasurementCapture();').length - 1}`);

  const visibleGated = (source: string): boolean =>
    source.includes('if (entry === null || entry.job.status !== \'running\') return;') &&
    source.includes('if (!this.cursorsPageShown()) return;') &&
    !source.includes('setTimeout') && !source.includes('setInterval') &&
    !source.includes('requestAnimationFrame');
  const unguarded = pump.replace('if (!this.cursorsPageShown()) return;', '');
  check('a hidden cursors page cannot advance the job and no new clock is created',
    visibleGated(pump) && !visibleGated(unguarded) && !visibleGated('') &&
      !frame.includes('setInterval') && !frame.includes('setTimeout') &&
      !section.includes('setInterval') && !section.includes('setTimeout'),
    `guarded=${visibleGated(pump)}, unguarded=${visibleGated(unguarded)}, ` +
    `empty=${visibleGated('')}`);

  const reconcile = (source: string): boolean =>
    source.includes('captureJobKey({') &&
    source.includes('new CaptureRangeJob(key, start, end, jobSources, store.length)') &&
    source.includes('entry.job.cancel()') &&
    source.includes('const done = entry.job.results();') &&
    source.includes('droppedSamples: store.droppedSamples,') &&
    source.includes('window: { start, end },');
  const noKey = section.replace('captureJobKey({', '(() => (\'k\'))({');
  check('the section reconciles one keyed job, cancels the old one and reads only its results',
    reconcile(section) && !reconcile(noKey) &&
      view.includes('captureRangeUnavailable({') &&
      view.includes("config.range.kind === 'capture'") &&
      view.includes('return this.captureMeasurementSection(') &&
      !section.includes('runMeasurement(') &&
      section.indexOf('entry.job.cancel()') <
        section.indexOf('new CaptureRangeJob(key, start, end, jobSources, store.length)'),
    `reconcile=${reconcile(section)}, key=${reconcile(noKey)}, ` +
    `scans=${section.includes('runMeasurement(')}`);

  const recovered = (source: string): boolean => {
    const stepAt = source.indexOf('entry.job.step(');
    const tryAt = source.indexOf('try {');
    const catchAt = source.indexOf('} catch (e) {');
    if (stepAt < 0 || tryAt < 0 || catchAt < stepAt) return false;
    const handler = source.slice(catchAt, source.indexOf('\n    }', catchAt));
    return tryAt < stepAt && handler.includes("this.fail('error.render', e);") &&
      handler.includes('return;') && !handler.includes('this.measurementCapture') &&
      !handler.includes('this.dirty');
  };
  const retrying = pump.replace("this.fail('error.render', e);",
    "this.fail('error.render', e);\n      this.measurementCapture = null;");
  check('a short read cancels the job and reports it instead of escaping the frame callback',
    recovered(pump) && !recovered(pump.replace("this.fail('error.render', e);", '')) &&
      !recovered(retrying) && !recovered(''),
    `guarded=${recovered(pump)}, silent=${recovered(pump.replace("this.fail('error.render', e);", ''))}, ` +
    `retrying=${recovered(retrying)}`);
}

{
  const reset = slice(appSource, 'private resetMeasurement(): void {',
    'private applyMeasurementConfig(');
  const channelChange = slice(appSource, 'private afterChannelChange(): void {',
    'private reorder(');
  const applyConfig = slice(appSource, 'private applyMeasurementConfig(',
    'private pickMeasurementFilter(');
  const pump = slice(appSource,
    'private pumpMeasurementCapture(): void {', 'private withMeasurementRows(');
  const drops = (source: string): boolean => source.includes('this.dropMeasurementCapture();');
  const viaView = (source: string): boolean =>
    source.includes('this.renderPanels();') &&
    !source.includes('this.measurementCapture') && !source.includes('dropMeasurementCapture');
  const noResetDrop = reset.replace('this.dropMeasurementCapture();', '');
  const noRebuild = applyConfig.replace('this.renderPanels();', '');
  check('reset, an analog channel change and a row edit drop or rewrite the keyed job',
    drops(reset) && drops(channelChange) && viaView(applyConfig) &&
      !drops(noResetDrop) && !drops(channelChange.replace('this.dropMeasurementCapture();', '')) &&
      !viaView(noRebuild) && !viaView(reset) && !viaView(channelChange) && !viaView('') &&
      pump.includes('if (store !== this.captureStore) {') &&
      pump.indexOf('entry.job.cancel();') < pump.indexOf('entry.job.step('),
    `reset=${drops(reset)}, channelChange=${drops(channelChange)}, ` +
    `rebuilt=${viaView(applyConfig)}, noReset=${drops(noResetDrop)}, noRebuild=${viaView(noRebuild)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
