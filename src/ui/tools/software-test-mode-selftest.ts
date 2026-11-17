// SPDX-License-Identifier: GPL-3.0-or-later
/** Proves the software test mode's stream feeds the measurement scan, the FFT and the XY view. */

import { createSampleStore, type SampleStore } from '../../data/index.js';
import { SoftwareTestStream, type SoftwareTestSchedule } from '../../device/index.js';
import { scanAnalogCodes } from '../../dsp/analogScan.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../../types.js';
import {
  ADC_ZERO_CODE, analogGroupCount, analogTriggerArtifactSamples, analogTriggerCode,
  analogVoltsPerCode,
} from '../channelBanks.js';
import { analyzeFft } from '../fftView.js';
import { en, type Messages } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';
import { readMeasureSamples } from '../measureSamples.js';
import { XY_MAX_ANALYZED, planXy } from '../xyView.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult { name: string; pass: boolean; detail: string }

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

const CHANNELS = 32 as const;
const SAMPLES = 65536;
const CHUNK_BYTES = 4096;
const AMPLITUDE_CODES = 96;
const SIGNAL_PERIOD_SAMPLES = 256;
const RATES = [100e6, 200e6] as const;

const A0_BITS = [7, 6, 5, 4, 3, 2, 1, 0] as const;
const A1_BITS = [15, 14, 13, 12, 11, 10, 9, 8] as const;

const readSource = (path: string): string => fs.readFileSync(path, 'utf8');

const panel = readSource('src/ui/capturePanel.ts');
const app = readSource('src/ui/app.ts');
const tools = readSource('src/assistant/tools.ts');

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
}

function needlesPass(source: string, needles: readonly string[]): boolean {
  return needles.every((needle) => source.includes(needle));
}

interface TickQueue {
  readonly schedule: SoftwareTestSchedule;
  readonly pending: number;
  runAll(limit: number): number;
}

function tickQueue(): TickQueue {
  const queued: { handle: number; run: () => void }[] = [];
  let nextHandle = 0;
  return {
    schedule: {
      set(run) {
        const handle = nextHandle++;
        queued.push({ handle, run });
        return handle;
      },
      clear(handle) {
        const at = queued.findIndex((entry) => entry.handle === handle);
        if (at >= 0) queued.splice(at, 1);
      },
    },
    get pending() {
      return queued.length;
    },
    runAll(limit) {
      let ticks = 0;
      while (queued.length > 0 && ticks < limit) {
        queued.shift()!.run();
        ticks += 1;
      }
      return ticks;
    },
  };
}

interface FeedResult { finished: boolean; emitted: number; pending: number; ticks: number }

function fillStore(
  store: SampleStore,
  samplerate: number,
  channels: ChannelCount,
  rewrite?: (chunk: Uint8Array, startSample: number) => void,
): FeedResult {
  const bytesPerSample = bytesPerSampleForChannels(channels);
  const queue = tickQueue();
  let fed = 0;
  const stream = new SoftwareTestStream({
    channels,
    samplerate,
    analogGroups: analogGroupCount(channels),
    zeroCode: ADC_ZERO_CODE,
    chunkBytes: CHUNK_BYTES,
    samples: SAMPLES,
    schedule: queue.schedule,
    sink: (chunk) => {
      const copy = chunk.slice();
      rewrite?.(copy, fed);
      fed += copy.length / bytesPerSample;
      store.append(copy);
    },
  });
  stream.start();
  const ticks = queue.runAll(Math.ceil(SAMPLES / (CHUNK_BYTES / bytesPerSample)) + 8);
  return {
    finished: stream.finished,
    emitted: stream.emittedSamples,
    pending: queue.pending,
    ticks,
  };
}

function readBank(store: SampleStore, bits: readonly number[], group: number) {
  return readMeasureSamples(store, { bits, group, gain: 1 }, { start: 0, end: SAMPLES });
}

function scanBank(store: SampleStore, bits: readonly number[], group: number) {
  const read = readBank(store, bits, group);
  const scan = scanAnalogCodes({
    codes: read.codes,
    unknown: read.unknown,
    samplerate: store.samplerate,
    zeroCode: ADC_ZERO_CODE,
    voltsPerCode: analogVoltsPerCode(1),
    rising: true,
    level: analogTriggerCode('rising', 0, 1),
    hysteresis: 4,
    window: analogTriggerArtifactSamples(store.samplerate),
  });
  return { read, scan };
}

const stores = new Map<number, SampleStore>();
const feeds = new Map<number, FeedResult>();
const scans = new Map<number, ReturnType<typeof scanBank>>();
for (const rate of RATES) {
  const store = createSampleStore(CHANNELS, rate);
  feeds.set(rate, fillStore(store, rate, CHANNELS));
  stores.set(rate, store);
  scans.set(rate, scanBank(store, A0_BITS, 0));
}

{
  const feed = feeds.get(RATES[0]!)!;
  const store = stores.get(RATES[0]!)!;
  check('the software test stream fills the shipping store with exactly its sample budget',
    feed.finished && feed.emitted === SAMPLES && store.length === SAMPLES &&
      feed.ticks === Math.ceil(SAMPLES / (CHUNK_BYTES / bytesPerSampleForChannels(CHANNELS))) &&
      feed.pending === 0,
    `finished=${feed.finished}, emitted=${feed.emitted}, stored=${store.length}, ` +
      `ticks=${feed.ticks}, pending=${feed.pending}`);
}

{
  const vpc = analogVoltsPerCode(1);
  const mismatches: string[] = [];
  for (const rate of RATES) {
    const { read, scan } = scans.get(rate)!;
    const wantHz = rate / SIGNAL_PERIOD_SAMPLES;
    const okHz = Math.abs(scan.frequencyHz - wantHz) <= 0.01 * wantHz;
    const okPeriod = scan.periodSamples >= 252 && scan.periodSamples <= 260;
    const okVpp = Math.abs(scan.vppVolts - 2 * AMPLITUDE_CODES * vpc) <= vpc;
    const wantRms = (AMPLITUDE_CODES / Math.SQRT2) * vpc;
    const okRms = Math.abs(scan.rmsVolts - wantRms) <= 0.02 * wantRms;
    if (scan.status !== 'ok' || read.analyzed !== SAMPLES || read.unknownSamples !== 0 ||
      !okHz || !okPeriod || !okVpp || !okRms) {
      mismatches.push(
        `${rate}: status=${scan.status}, analyzed=${read.analyzed}, unknown=${read.unknownSamples}, ` +
        `hz=${scan.frequencyHz} (want ${wantHz}), period=${scan.periodSamples}, ` +
        `vpp=${scan.vppVolts} (want ${2 * AMPLITUDE_CODES * vpc}), ` +
        `rms=${scan.rmsVolts} (want ${wantRms})`);
    }
  }
  const [low, high] = RATES;
  const lowHz = scans.get(low)!.scan.frequencyHz;
  const highHz = scans.get(high)!.scan.frequencyHz;
  const ratio = highHz / lowHz;
  const sameData = scans.get(low)!.read.codes.every(
    (code, index) => code === scans.get(high)!.read.codes[index]);
  check('automatic measurements read A0 at rate/256 with the documented amplitude at both rates',
    mismatches.length === 0, mismatches.join(' | ') || `measured ${lowHz} Hz and ${highHz} Hz`);
  check('the signal adapts to the sample rate while the samples per period stay fixed',
    Math.abs(ratio - high / low) <= 0.01 * (high / low) && sameData &&
      Math.abs(scans.get(low)!.scan.periodSamples - SIGNAL_PERIOD_SAMPLES) <= 4 &&
      Math.abs(scans.get(high)!.scan.periodSamples - SIGNAL_PERIOD_SAMPLES) <= 4,
    `ratio=${ratio}, periods=${scans.get(low)!.scan.periodSamples}/` +
      `${scans.get(high)!.scan.periodSamples}, identical data=${sameData}`);
}

{
  const rate = RATES[0]!;
  const wantHz = rate / SIGNAL_PERIOD_SAMPLES;
  const wideStore = stores.get(rate)!;
  const wideA0 = readBank(wideStore, A0_BITS, 0).codes;
  const wideA1 = readBank(wideStore, A1_BITS, 1).codes;
  const sameCodes = (a: Uint8Array, b: Uint8Array, offset: number): boolean =>
    a.length === b.length - offset && a.every((code, index) => code === b[index + offset]);
  const rows: string[] = [];
  for (const channels of [8, 16] as const) {
    const store = createSampleStore(channels, rate);
    const feed = fillStore(store, rate, channels);
    const bank0 = readBank(store, A0_BITS, 0);
    const bank1 = channels === 16 ? readBank(store, A1_BITS, 1) : null;
    const { scan } = scanBank(store, A0_BITS, 0);
    const ok = feed.finished && store.length === SAMPLES &&
      bank0.analyzed === SAMPLES && bank0.unknownSamples === 0 &&
      sameCodes(bank0.codes, wideA0, 0) &&
      (bank1 === null || (bank1.unknownSamples === 0 && sameCodes(bank1.codes, wideA1, 0))) &&
      scan.status === 'ok' && Math.abs(scan.frequencyHz - wantHz) <= 0.01 * wantHz &&
      Math.abs(scan.periodSamples - SIGNAL_PERIOD_SAMPLES) <= 4;
    if (!ok) {
      rows.push(`${channels}ch: finished=${feed.finished}, stored=${store.length}, ` +
        `hz=${scan.frequencyHz}, period=${scan.periodSamples}, ` +
        `unknown=${bank0.unknownSamples}/${bank1?.unknownSamples ?? 0}`);
    }
  }
  const shiftControl = sameCodes(wideA0.subarray(0, SAMPLES - 1), wideA0, 1);
  check('every complete ADC bank inside an 8 or 16 channel width streams the same codes',
    rows.length === 0 && !shiftControl,
    rows.join(' | ') ||
      `8/16ch banks match the 32-channel codes, one-sample shift control=${shiftControl}`);
}

{
  const rate = RATES[0]!;
  const read = scans.get(rate)!.read;
  const analysis = analyzeFft({
    source: { group: 0, start: 0, gain: 1, name: 'A0' },
    codes: read.codes,
    unknown: read.unknown,
    samplerate: rate,
    zeroCode: ADC_ZERO_CODE,
    voltsPerCode: analogVoltsPerCode(1),
    window: 'hann',
    windowStart: 0,
    requestedSamples: SAMPLES,
    clipped: false,
    minHz: null,
    maxHz: null,
  });
  const spectrum = analysis.spectrum;
  const peak = spectrum?.peak ?? null;
  const wantHz = rate / SIGNAL_PERIOD_SAMPLES;
  const loud: string[] = [];
  if (spectrum !== null && peak !== null) {
    for (let bin = 1; bin < spectrum.dbfs.length; bin += 1) {
      if (Math.abs(bin - peak.bin) <= 2) continue;
      if (spectrum.dbfs[bin]! > peak.dbfs - 20) {
        loud.push(`bin ${bin} at ${spectrum.dbfs[bin]!.toFixed(1)} dBFS`);
      }
    }
  }
  check('the FFT peak sits on rate/256 and dominates every other non-DC bin by 20 dB',
    analysis.status === 'ok' && spectrum !== null && peak !== null &&
      Math.abs(peak.interpolatedHz - wantHz) <= 0.002 * wantHz &&
      peak.bin === SAMPLES / SIGNAL_PERIOD_SAMPLES && peak.dbfs > -10 && loud.length === 0,
    `status=${analysis.status}, peak=${peak?.interpolatedHz} (want ${wantHz}), ` +
      `bin=${peak?.bin}, dBFS=${peak?.dbfs.toFixed(2)}, loud=${loud.slice(0, 3).join(', ') || 'none'}`);
}

{
  const vpc = analogVoltsPerCode(1);
  const rate = RATES[0]!;
  const store = stores.get(rate)!;
  const readX = readBank(store, A0_BITS, 0);
  const readY = readBank(store, A1_BITS, 1);
  const plan = planXy({
    sourceX: 0,
    sourceY: 8,
    codesX: readX.codes,
    codesY: readY.codes,
    zeroX: ADC_ZERO_CODE,
    zeroY: ADC_ZERO_CODE,
    voltsPerCodeX: analogVoltsPerCode(1),
    voltsPerCodeY: analogVoltsPerCode(1),
    maxAnalyzed: XY_MAX_ANALYZED,
  });
  if (plan.status !== 'ok') {
    check('the XY view pairs A0 with A1 into a closed circle', false, `status=${plan.status}`);
  } else {
    const radius = AMPLITUDE_CODES * vpc;
    let worstRadius = 0;
    for (let at = 0; at < plan.points.length; at += 2) {
      const error = Math.abs(Math.hypot(plan.points[at]!, plan.points[at + 1]!) - radius);
      if (error > worstRadius) worstRadius = error;
    }
    const extrema = [plan.observedX.min, plan.observedX.max, plan.observedY.min, plan.observedY.max];
    const onExtrema = extrema.every((value, index) =>
      Math.abs(value - (index % 2 === 0 ? -radius : radius)) <= vpc);
    check('the XY view pairs A0 with A1 into a closed circle',
      plan.paired === plan.analyzed && plan.analyzed === SAMPLES && plan.gapExcluded === 0 &&
        plan.sourceX !== plan.sourceY && onExtrema && worstRadius <= 1.5 * vpc,
      `paired=${plan.paired}/${plan.analyzed}, gaps=${plan.gapExcluded}, ` +
        `X=${plan.observedX.min.toFixed(3)}..${plan.observedX.max.toFixed(3)}, ` +
        `Y=${plan.observedY.min.toFixed(3)}..${plan.observedY.max.toFixed(3)}, ` +
        `radius=${radius.toFixed(3)}±${worstRadius.toFixed(3)}`);
  }
}

{
  const store = createSampleStore(CHANNELS, RATES[0]!);
  const bytesPerSample = bytesPerSampleForChannels(CHANNELS);
  const feed = fillStore(store, RATES[0]!, CHANNELS, (chunk, startSample) => {
    for (let at = 0; at < chunk.length; at += bytesPerSample) {
      chunk[at] = (startSample + at / bytesPerSample) & 0xff;
    }
  });
  const { scan } = scanBank(store, A0_BITS, 0);
  const wantHz = RATES[0]! / SIGNAL_PERIOD_SAMPLES;
  const matches = Math.abs(scan.frequencyHz - wantHz) <= 0.01 * wantHz;
  check('control: a counter instead of the sine fails the same frequency criterion',
    feed.finished && store.length === SAMPLES && scan.status === 'ok' && !matches,
    `status=${scan.status}, hz=${scan.frequencyHz}, stored=${store.length}`);
}

function offersSoftwareTestOnSchedule(block: string): boolean {
  const guarded = /\.\.\.\(v\.softwareTestOffered\s*\?\s*\[\['3',\s*t\('capturePanel\.testSoftware'\)\]\s*as SelectOptionTuple\]\s*:\s*\[\]\)/;
  const mentions = (block.match(/'3'/g) ?? []).length;
  const order = ["['0'", "['2'", 'v.softwareTestOffered', "['1'"]
    .map((needle) => block.indexOf(needle));
  return guarded.test(block) && mentions === 1 &&
    order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!));
}

{
  const block = slice(panel, 'const testModeOptions: SelectOptionTuple[] = [', '];');
  const hoisted = "const testModeOptions: SelectOptionTuple[] = [\n" +
    "  ['0', t('capturePanel.testNormal')],\n" +
    "  ['2', t('capturePanel.testSimulator')],\n" +
    "  ['3', t('capturePanel.testSoftware')],\n" +
    "  ['1', t('capturePanel.testUsbMax')],\n];";
  check('the Software test option sits only inside the softwareTestOffered guard',
    block.length > 0 && offersSoftwareTestOnSchedule(block) &&
      !offersSoftwareTestOnSchedule(hoisted),
    `block=${block.length} bytes, hoisted guarded=${offersSoftwareTestOnSchedule(hoisted)}`);
}

{
  const note = /t\(v\.softwareTestAvailable\s*\?\s*'capturePanel\.testSoftwareNote'\s*:\s*'capturePanel\.testSoftwareNeedsAdc'\)/;
  const body = slice(panel, 'if (s.testMode === SOFTWARE_TEST_MODE) {', '} else if (s.testMode !== 0) {');
  const swapped = body.replace("'capturePanel.testSoftwareNote'", "'capturePanel.testSoftwareNeedsAdc'");
  check('the software note branches on the ADC capability and carries both keys',
    panel.includes('testMode: Number(source.value) as CaptureTestMode') &&
      body.includes("softwareNote.dataset.softwareTestNote = ''") &&
      note.test(body) && !note.test(swapped),
    `cast=${panel.includes('as CaptureTestMode')}, branch=${note.test(body)}`);
}

{
  const start = app.indexOf('private async startCapture(');
  const capture = start < 0 ? '' : app.slice(start, app.indexOf('private async stopCapture(', start));
  const teardown = slice(app, 'private async teardownDevice(', '\n  }\n');
  const discard = slice(app, 'private discardDevice(): number {', '\n  }\n');
  const install = slice(app, 'private installDevice(d: Device, epoch: number): boolean {', '\n  }\n');
  const adopt = slice(app, 'private adoptDeviceChannels(', '\n  }\n');
  const startNeedles = [
    'testMode: deviceTestMode(this.settings.testMode)',
    'softwareTestDevice(device, { analogGroups',
    '!softwareTest && this.settings.triggerEnableMask',
    'this.captureSource = sourceDevice',
    'await sourceDevice.start(',
  ];
  const guardNeedles = [
    'const analogGroups = softwareTest ? analogGroupCount(cfg.channels) : 0;',
    'if (softwareTest && analogGroups === 0) {',
    "throw new Error('Software test requires the 32-channel board');",
  ];
  const view = slice(app, 'softwareTestAvailable:', 'deviceName:');
  const viewNeedles = [
    'softwareTestAvailable: this.deviceHasAnalogModule(),',
    'softwareTestOffered: this.deviceHasAnalogModule() ||',
    'this.settings.testMode === SOFTWARE_TEST_MODE,',
  ];
  const teardownNeedles = ['const source = this.captureSource;', 'await source.stop();'];
  const discardNeedles = ['const source = this.captureSource;', 'void source.stop();'];
  const clampAt = adopt.indexOf('softwareTestClamp');
  const settingsAt = adopt.indexOf('const adopted = this.clampSettings(');
  const adoptNeedles = ['SOFTWARE_TEST_MODE', '{ testMode: 0 as const }'];
  check('App maps mode 3 to the device mode and captures from the host source untriggered',
    capture.length > 0 && needlesPass(capture, startNeedles) &&
      !needlesPass(capture.replace('deviceTestMode(this.settings.testMode)', 'this.settings.testMode'),
        startNeedles),
    startNeedles.filter((needle) => !capture.includes(needle)).join(', ') || 'all present');
  check('App refuses to arm a digital-only software source',
    capture.length > 0 && needlesPass(capture, guardNeedles) &&
      !needlesPass(capture.replace('softwareTest && analogGroups === 0',
        'softwareTest && analogGroups > 0'), guardNeedles),
    guardNeedles.filter((needle) => !capture.includes(needle)).join(', ') || 'all present');
  check('the panel view keeps a stored mode 3 visible without the ADC module',
    view.length > 0 && needlesPass(view, viewNeedles) &&
      !needlesPass(view.replace('this.deviceHasAnalogModule() ||', ''), viewNeedles),
    view.replace(/\s+/g, ' ').trim());
  check('App clamps a stored mode 3 before adopting a board without the ADC module',
    needlesPass(adopt, adoptNeedles) && clampAt >= 0 && settingsAt > clampAt &&
      !needlesPass(adopt.replace('{ testMode: 0 as const }', '{}'), adoptNeedles),
    `clamp=${clampAt}, settings=${settingsAt}`);
  check('App stops the host source on teardown, discard and device replacement',
    needlesPass(teardown, teardownNeedles) && needlesPass(discard, discardNeedles) &&
      needlesPass(install, discardNeedles) &&
      !needlesPass(teardown.replace('await source.stop();', 'await device?.stop();'), teardownNeedles),
    `teardown=${needlesPass(teardown, teardownNeedles)}, ` +
      `discard=${needlesPass(discard, discardNeedles)}, install=${needlesPass(install, discardNeedles)}`);
}

{
  const enumNeedle = "test_mode: { type: 'integer', enum: [0, 1, 2, 3]";
  const gate = 'if (!st.widthTiers.includes(32)) {';
  const replaced = tools.replace(gate, 'if (!st.widthTiers.includes(16)) {');
  check('the assistant lists mode 3 and gates it on the 32-channel tier',
    tools.includes(enumNeedle) && tools.includes(gate) &&
      !tools.includes("enum: [0, 1, 2]") && !replaced.includes(gate),
    `enum=${tools.includes(enumNeedle)}, gate=${tools.includes(gate)}`);
}

{
  const keys = [
    'capturePanel.testSoftware',
    'capturePanel.testSoftwareNote',
    'capturePanel.testSoftwareNeedsAdc',
  ] as const;
  const catalogList: Array<[string, Messages]> =
    [['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr]];
  const missing = (dicts: ReadonlyArray<readonly [string, Messages]>): string[] => {
    const failures: string[] = [];
    for (const [locale, dict] of dicts) {
      for (const key of keys) {
        const text = dict[key];
        if (typeof text !== 'string' || text.length === 0) failures.push(`${locale}:${key}:missing`);
        else if (locale !== 'en' && text === en[key]) failures.push(`${locale}:${key}:english`);
      }
    }
    return failures;
  };
  check('all four catalogs carry the software test copy and translate it',
    missing(catalogList).length === 0 && missing([['zh-CN', en]]).length === keys.length,
    missing(catalogList).join(', ') || 'all translated');
}

const failed = results.filter((result) => !result.pass).length;

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
