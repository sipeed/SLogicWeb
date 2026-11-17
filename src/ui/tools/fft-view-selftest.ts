// SPDX-License-Identifier: GPL-3.0-or-later

import { loadAdcTrace } from '../../data/adcTraceFiles.js';
import { WINDOW_KINDS, type WindowKind } from '../../dsp/fft.js';
import {
  FFT_MAX_SAMPLES, aggregateColumns, logAxisHz, logFrequencyAxis,
} from '../../dsp/fftSpectrum.js';
import { ADC_LSB_V, ADC_ZERO_CODE } from '../channelBanks.js';
import { formatCount, formatFreq } from '../format.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';
import type { MeasurementSource } from '../measurementState.js';
import {
  FFT_DEFAULT_CONFIG, FFT_DB_TOP, FFT_MIN_HZ_FLOOR, analyzeFft, defaultFftMinHz,
  fftAccessibleText, fftDbRange, fftDbY, fftStatusReason, fftSummaryLines, fftWindowKind,
  fftWindowLabel, fftWithBounds, panFftBounds, reconcileFftConfig, resetFftBounds,
  resolveFftBounds,
  selectFftMinHz, selectFftSource, selectFftWindow, zoomFftBounds,
  type FftAnalysis, type FftSectionView,
} from '../fftView.js';
import {
  fftCoveredRange, fftDbLabelY, fftNearestBin, fftTickLayout, fftViewportBox,
  type FftViewportBox, type FftViewportInput,
} from '../fftCanvas.js';

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

function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

function closeTo(actual: number, expected: number, tolerance: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

const read = (path: string): string => fs.readFileSync(path, 'utf8');
const slice = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
};

const app = read('src/ui/app.ts');
const panel = read('src/ui/capturePanel.ts');
const css = read('src/ui/style.css');
const viewSource = read('src/ui/fftView.ts');
const canvasSource = read('src/ui/fftCanvas.ts');

const SOURCE_A0: MeasurementSource = { group: 0, start: 0, gain: 1, name: 'A0' };
const SOURCE_A1: MeasurementSource = { group: 1, start: 8, gain: 1, name: 'A1' };

function sine(n: number, bin: number, amplitude: number, zero = 128): Float64Array {
  const codes = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    codes[i] = zero + amplitude * Math.sin((2 * Math.PI * bin * i) / n);
  }
  return codes;
}

function cosAt(n: number, bin: number, amplitude: number, zero = 128): Float64Array {
  const codes = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    codes[i] = zero + amplitude * Math.cos((2 * Math.PI * bin * i) / n);
  }
  return codes;
}

function analysisOf(
  codes: ArrayLike<number>, over: Partial<Parameters<typeof analyzeFft>[0]> = {},
): FftAnalysis {
  return analyzeFft({
    source: SOURCE_A0,
    codes,
    samplerate: 1e6,
    zeroCode: 128,
    voltsPerCode: ADC_LSB_V,
    window: 'hann',
    windowStart: 0,
    requestedSamples: codes.length,
    clipped: false,
    minHz: null,
    maxHz: null,
    ...over,
  });
}

function sectionOf(analysis: FftAnalysis | null, over: Partial<FftSectionView> = {}): FftSectionView {
  return {
    mode: 'fft',
    sources: [SOURCE_A0, SOURCE_A1],
    source: SOURCE_A0.start,
    window: 'hann',
    minHz: null,
    maxHz: null,
    analysis,
    ...over,
  };
}

{
  const bin = 1525.87890625;
  const nyquist = 50e6;
  const auto = defaultFftMinHz(bin, nyquist);
  check('the default display minimum is the first usable bin, never Nyquist/1000',
    closeTo(auto, bin, 1e-9) && auto >= bin && auto < nyquist &&
      closeTo(defaultFftMinHz(1e6, 50e6), 1e6, 1e-9) &&
      !closeTo(defaultFftMinHz(bin, nyquist), 50e3, 1) &&
      defaultFftMinHz(Number.NaN, nyquist) === FFT_MIN_HZ_FLOOR &&
      defaultFftMinHz(0, nyquist) === FFT_MIN_HZ_FLOOR,
    `auto=${auto}, binDominated=${defaultFftMinHz(1e6, 50e6)}`);

  const settled = analysisOf(sine(1024, 10, 127.5, ADC_ZERO_CODE));
  const narrowed = fftWithBounds(settled, 1e3, 1e5);
  check('display bounds are re-derived from the settled transform, never recomputed',
    fftWithBounds(settled, settled.minHz, settled.maxHz) === settled &&
      narrowed !== settled && narrowed.spectrum === settled.spectrum &&
      narrowed.analyzedSamples === settled.analyzedSamples && narrowed.status === settled.status &&
      closeTo(narrowed.minHz!, 1e3, 1e-9) && closeTo(narrowed.maxHz!, 1e5, 1e-9),
    `settled=${settled.minHz}-${settled.maxHz}, narrowed=${narrowed.minHz}-${narrowed.maxHz}`);

  const clampedHigh = resolveFftBounds(null, 80e6, bin, nyquist);
  const clampedLow = resolveFftBounds(1e-9, null, bin, nyquist);
  const ordered = resolveFftBounds(1e6, 1e3, bin, nyquist);
  check('display bounds stay inside the axis floor and Nyquist and keep min below max',
    clampedHigh.maxHz === nyquist && clampedLow.minHz === FFT_MIN_HZ_FLOOR &&
      ordered.minHz < ordered.maxHz && ordered.maxHz <= nyquist,
    `high=${JSON.stringify(clampedHigh)}, low=${JSON.stringify(clampedLow)}, ` +
      `ordered=${JSON.stringify(ordered)}`);

  const explicit = selectFftSource(FFT_DEFAULT_CONFIG, 8);
  const kept = reconcileFftConfig(explicit, [SOURCE_A0, SOURCE_A1], null);
  const preferred = reconcileFftConfig(FFT_DEFAULT_CONFIG, [SOURCE_A0, SOURCE_A1], 8);
  const missing = reconcileFftConfig(selectFftSource(FFT_DEFAULT_CONFIG, 99),
    [SOURCE_A0, SOURCE_A1], null);
  check('one active source follows the selection, the measurement filter, then the first group',
    kept.source === 8 && preferred.source === 8 && missing.source === 0 &&
      reconcileFftConfig(explicit, [], null).source === null,
    `kept=${kept.source}, preferred=${preferred.source}, missing=${missing.source}`);

  check('source, window and minimum-frequency selectors preserve identity and reset clears bounds',
    selectFftSource(explicit, 8) === explicit &&
      selectFftWindow(FFT_DEFAULT_CONFIG, 'hann') === FFT_DEFAULT_CONFIG &&
      selectFftMinHz(FFT_DEFAULT_CONFIG, null) === FFT_DEFAULT_CONFIG &&
      resetFftBounds({ ...FFT_DEFAULT_CONFIG, minHz: 10, maxHz: 20 }).minHz === null &&
      selectFftMinHz({ ...FFT_DEFAULT_CONFIG, minHz: 10, maxHz: 20 }, null).maxHz === null &&
      fftWindowKind('blackman') === 'blackman' && fftWindowKind('nope') === 'hann' &&
      WINDOW_KINDS.every((kind: WindowKind) => fftWindowLabel(kind) !== ''),
    `window=${fftWindowKind('blackman')}, fallback=${fftWindowKind('nope')}`);
}

{
  const bounds = { minHz: 1e3, maxHz: 1e6 };
  const anchor = 1e4;
  const zoomed = zoomFftBounds(bounds, anchor, 0.5, 50e6);
  const span = Math.log(bounds.maxHz / bounds.minHz);
  const zoomedSpan = Math.log(zoomed.maxHz / zoomed.minHz);
  const anchorPos = (value: number): number =>
    Math.log(value / bounds.minHz) / span;
  const zoomedPos = (value: number): number =>
    Math.log(value / zoomed.minHz) / zoomedSpan;
  const widened = zoomFftBounds(bounds, anchor, 2, 50e6);
  check('zooming narrows the log span around the anchor and the anchor keeps its position',
    closeTo(zoomedSpan, span * 0.5, 1e-12) &&
      closeTo(anchorPos(anchor), zoomedPos(anchor), 1e-9) &&
      closeTo(Math.log(widened.maxHz / widened.minHz), span * 2, 1e-12),
    `span=${span}, zoomed=${zoomedSpan}, anchor=${anchorPos(anchor)}/${zoomedPos(anchor)}`);

  const far = zoomFftBounds(bounds, anchor, 1e-9, 50e6);
  const out = zoomFftBounds(bounds, anchor, 1e9, 50e6);
  check('zoom limits keep at least the seconds-declared minimum and never exceed ten decades',
    Math.log(far.maxHz / far.minHz) >= 0.02 * Math.log(10) - 1e-9 &&
      Math.log(out.maxHz / out.minHz) <= 10 * Math.log(10) + 1e-9,
    `far=${Math.log(far.maxHz / far.minHz)}, out=${Math.log(out.maxHz / out.minHz)}`);

  const panned = panFftBounds(bounds, 100, 1000, 50e6);
  const spanKept = Math.log(panned.maxHz / panned.minHz);
  const clamped = panFftBounds({ minHz: 1, maxHz: 10 }, 9000, 1000, 50e6);
  const clampTop = panFftBounds({ minHz: 40e6, maxHz: 50e6 }, -500, 1000, 50e6);
  check('panning shifts the display window in log space without changing the span or Nyquist',
    closeTo(spanKept, span, 1e-9) && panned.minHz < bounds.minHz &&
      clamped.minHz === FFT_MIN_HZ_FLOOR && clampTop.maxHz === 50e6,
    `span=${spanKept}, clamped=${JSON.stringify(clamped)}, top=${JSON.stringify(clampTop)}`);
}

{
  const n = 1024;
  const full = analysisOf(sine(n, 10, 127.5, ADC_ZERO_CODE));
  const half = analysisOf(sine(n, 10, 63.75, ADC_ZERO_CODE));
  const nyquist = analysisOf(cosAt(n, n / 2, 127.5, ADC_ZERO_CODE), { window: 'rectangular' });
  const dc = analysisOf(new Float64Array(n).fill(ADC_ZERO_CODE + 127.5));
  const peak = full.spectrum?.peak ?? null;
  check('full-scale and half-scale exact-bin sines read 0 and -6.02 dBFS with correct bins',
    full.status === 'ok' && peak !== null && peak.bin === 10 &&
      closeTo(peak.dbfs, 0, 0.02) && closeTo(peak.interpolatedHz, peak.hz, 1e-6) &&
      closeTo(half.spectrum!.peak!.dbfs, -6.0206, 0.02) &&
      half.spectrum!.peak!.bin === 10,
    `full=${peak?.dbfs}, half=${half.spectrum?.peak?.dbfs}`);

  check('DC and Nyquist normalization add no factor two and DC is reported separately',
    dc.status === 'ok' && closeTo(dc.spectrum!.dcDbfs, 0, 0.02) &&
      closeTo(dc.spectrum!.dcVolts, 127.5 * ADC_LSB_V, 1e-9) &&
      nyquist.status === 'ok' && closeTo(nyquist.spectrum!.peak!.dbfs, 0, 0.02) &&
      nyquist.spectrum!.peak!.bin === n / 2,
    `dc=${dc.spectrum?.dcDbfs}/${dc.spectrum?.dcVolts}, want=${127.5 * ADC_LSB_V}, ` +
      `nyquist=${nyquist.spectrum?.peak?.dbfs}, bin=${nyquist.spectrum?.peak?.bin}`);

  const scaled = analysisOf(sine(n, 10, 127.5, ADC_ZERO_CODE), { voltsPerCode: ADC_LSB_V * 4 });
  check('a gain change moves the linear voltage but never the dBFS reference',
    closeTo(scaled.spectrum!.peak!.dbfs, full.spectrum!.peak!.dbfs, 1e-9) &&
      closeTo(scaled.spectrum!.peak!.volts / full.spectrum!.peak!.volts, 4, 1e-9),
    `dbfs=${scaled.spectrum?.peak?.dbfs}, ratio=${scaled.spectrum?.peak?.volts}`);

  check('the disclosed resolution matches the plan: N, one bin, ENBW and RBW',
    full.spectrum!.n === n && closeTo(full.spectrum!.binHz, 1e6 / n, 1e-12) &&
      closeTo(full.spectrum!.rbwHz, full.spectrum!.enbwBins * full.spectrum!.binHz, 1e-9) &&
      full.spectrum!.quantizationFloorDbfs < -50 &&
      full.spectrum!.quantizationFloorDbfs > -60,
    `n=${full.spectrum?.n}, bin=${full.spectrum?.binHz}, enbw=${full.spectrum?.enbwBins}`);
}

{
  const n = 1024;
  const gapMask = new Uint8Array(n);
  gapMask[100] = 1;
  const gapped = analysisOf(sine(n, 10, 100, ADC_ZERO_CODE), {
    unknown: gapMask, windowStart: 5000,
  });
  const shortCodes = new Float64Array(1).fill(128);
  const tooShort = analysisOf(shortCodes);
  const clipped = analysisOf(sine(n, 10, 100, ADC_ZERO_CODE), {
    clipped: true, requestedSamples: 300000,
  });
  check('an internal gap refuses the transform and names its absolute sample',
    gapped.status === 'gap' && gapped.spectrum === null && gapped.gapAt === 5100 &&
      fftStatusReason(gapped).includes('5,100'),
    `status=${gapped.status}, at=${gapped.gapAt}, reason=${fftStatusReason(gapped)}`);

  check('a window shorter than two samples produces no fabricated spectrum',
    tooShort.status === 'too-short' && tooShort.spectrum === null &&
      tooShort.analyzedSamples === 0 && fftStatusReason(tooShort) !== '',
    `status=${tooShort.status}, n=${tooShort.analyzedSamples}`);

  check('the analysis carries the requested span, the bound flag and the crop disclosure',
    clipped.status === 'ok' && clipped.truncated === true && clipped.clipped === true &&
      clipped.requestedSamples === 300000 &&
      fftSummaryLines(sectionOf(clipped)).some((line) => line.includes(formatCount(FFT_MAX_SAMPLES))),
    `truncated=${clipped.truncated}, clipped=${clipped.clipped}`);
}

{
  const n = 1024;
  const analysis = analysisOf(sine(n, 10, 127.5, ADC_ZERO_CODE), {
    windowStart: 200, requestedSamples: n,
  });
  const lines = fftSummaryLines(sectionOf(analysis));
  const text = lines.join('\n');
  const required = [
    'Source A0', 'fs 1 MS/s', `N ${formatCount(n)}`, 'Δf',
    'Window Hann', 'ENBW', 'RBW', 'Nyquist', 'display',
    `Analyzed ${formatCount(n)} of ${formatCount(n)} samples`,
    'dBFS reference', 'quantization floor', 'DC ', 'Peak',
    'raw bin', 'parabolic log-magnitude interpolation',
  ];
  const missing = required.filter((needle) => !text.includes(needle));
  check('the textual summary discloses source, fs, N, resolution, window, limits, DC and peak',
    missing.length === 0 && lines.length >= 10 &&
      fftAccessibleText(sectionOf(analysis)) === lines.join(' · '),
    `missing=${JSON.stringify(missing)}, lines=${lines.length}`);

  const idle = fftSummaryLines(sectionOf(null, { mode: 'time' }));
  const reasons = (['no-source', 'no-window', 'previous-wave-displayed'] as const)
    .map((status) => fftStatusReason({ ...analysis, status, spectrum: null }));
  check('the Time mode states it is off and each unavailable reason is its own sentence',
    idle.length === 1 && idle[0] !== '' && reasons.every((reason) => reason !== '') &&
      new Set(reasons).size === reasons.length,
    `idle=${idle.join('|')}, reasons=${JSON.stringify(reasons)}`);

  const rawBinLine = lines.find((line) => line.includes('raw bin')) ?? '';
  check('the peak keeps the raw bin beside the interpolated frequency and labels the method',
    rawBinLine.includes(formatFreq(analysis.spectrum!.peak!.hz)) &&
      lines.some((line) => line.includes(formatFreq(analysis.spectrum!.peak!.interpolatedHz))),
    `raw=${rawBinLine}`);
}

{
  const range = fftDbRange(-52.9);
  const top = fftDbY(0, range.top, range.bottom, 100);
  const bottom = fftDbY(range.bottom, range.top, range.bottom, 100);
  const below = fftDbY(range.bottom - 50, range.top, range.bottom, 100);
  check('the dB scale is 0 dBFS at the top, sits below the 8-bit quantization floor, and clamps',
    range.top === FFT_DB_TOP && range.bottom <= -60 && top === 0 &&
      closeTo(bottom, 100, 1e-9) && below === 100 &&
      fftDbY(Number.NaN, range.top, range.bottom, 100) === 100,
    `range=${JSON.stringify(range)}, top=${top}, bottom=${bottom}, below=${below}`);

  const axis = logFrequencyAxis({ nyquistHz: 1e6, minHz: 1e3, binHz: 1, width: 600, height: 300 });
  const ticks = fftTickLayout(axis);
  const mantissa = (hz: number): number => {
    const decade = 10 ** Math.floor(Math.log10(hz) + 1e-9);
    return hz / decade;
  };
  const mantissas = axis.ticks.every((tick) =>
    [1, 2, 5].some((want) => closeTo(mantissa(tick.hz), want, 1e-9)));
  const spacingOk = ticks.every((tick, index) =>
    tick.major || index === 0 || tick.x - ticks[index - 1]!.x >= 46);
  check('the log axis lays out 1-2-5 ticks with every major tick labelled and no overlap',
    ticks.length > 3 && ticks.filter((tick) => tick.major).length >= 2 && spacingOk &&
      ticks.every((tick) => tick.x >= 0 && tick.x <= 600) && mantissas,
    `ticks=${ticks.length}, majors=${ticks.filter((tick) => tick.major).length}`);

  check('hover converts a column back to hertz and clamps the nearest bin inside the spectrum',
    closeTo(logAxisHz(300, 1e3, 1e6, 600), 1e3 * (1e6 / 1e3) ** 0.5, 1e-6) &&
      fftNearestBin(0, 1000, 100) === 1 && fftNearestBin(1e9, 1000, 100) === 99 &&
      fftNearestBin(-5, 1000, 100) === 1 &&
      fftNearestBin(1000, 1000, 100) === 1 && fftNearestBin(1000, 0, 100) === -1,
    `mid=${logAxisHz(300, 1e3, 1e6, 600)}`);

  check('the 0 dBFS label sits inside the canvas instead of being clipped above the top edge',
    fftDbLabelY(0.5, 300) === 7 && closeTo(fftDbLabelY(120.5, 300), 114.5, 1e-9) &&
      fftDbLabelY(299.5, 300) === 292 && fftDbLabelY(0.5, 12) === 7 &&
      !canvasSource.includes('`${db} dB`, 4, y - 6'),
    `top=${fftDbLabelY(0.5, 300)}, mid=${fftDbLabelY(120.5, 300)}, ` +
      `bottom=${fftDbLabelY(299.5, 300)}`);
}

{
  const axis = logFrequencyAxis({ nyquistHz: 1e3, minHz: 10, binHz: 1, width: 40, height: 100 });
  const values = new Float64Array(501);
  for (let bin = 0; bin <= 500; bin += 1) values[bin] = -100;
  const covered = axis.columns.filter((column) => column.covered);
  const target = covered[Math.floor(covered.length / 2)]!;
  values[target.lastBin] = -10;
  values[target.firstBin] = -90;
  const columns = aggregateColumns(axis.columns, values);
  const maxKept = columns[target.x] === -10;
  const empty = axis.columns.filter((column) => !column.covered);
  const noFakeValue = empty.every((column) => Number.isNaN(columns[column.x]!));
  const noDc = covered.every((column) => column.firstBin >= 1);
  const rangeCover = fftCoveredRange(axis);
  check('every occupied column keeps its maximum and an uncovered column invents no value',
    covered.length > 0 && maxKept && noFakeValue && noDc &&
      rangeCover.first === covered[0]!.x &&
      rangeCover.last === covered[covered.length - 1]!.x,
    `covered=${covered.length}, max=${maxKept}, fake=${!noFakeValue}, dc=${!noDc}, ` +
      `range=${JSON.stringify(rangeCover)}`);

  const baseline = aggregateColumns(axis.columns, values);
  check('dropping the per-column maximum for a mean would change the answer',
    baseline[target.x] !==
      (values[target.firstBin]! + values[target.lastBin]!) / 2,
    `max=${baseline[target.x]}`);
}

{
  const fixture = loadAdcTrace('sine');
  const analysis = analyzeFft({
    source: SOURCE_A0,
    codes: fixture,
    samplerate: 100e6,
    zeroCode: ADC_ZERO_CODE,
    voltsPerCode: ADC_LSB_V,
    window: 'hann',
    windowStart: 0,
    requestedSamples: fixture.length,
    clipped: false,
    minHz: null,
    maxHz: null,
  });
  const peak = analysis.spectrum?.peak ?? null;
  const binHz = analysis.spectrum?.binHz ?? 0;
  check('the real 10 kHz fixture peak is within half a bin of 9999.59 Hz',
    peak !== null && analysis.spectrum!.n === FFT_MAX_SAMPLES &&
      Math.abs(peak.interpolatedHz - 9999.5877) <= 0.5 * binHz,
    `peak=${peak?.interpolatedHz}, limit=${0.5 * binHz}`);

  check('the fixture analysis discloses interpolation, resolution and a bound-limited read',
    fftSummaryLines(sectionOf(analysis)).some((line) =>
      line.includes('bounded to the')) &&
      fftSummaryLines(sectionOf(analysis)).some((line) =>
        line.includes('parabolic log-magnitude interpolation')) &&
      analysis.minHz !== null && analysis.maxHz !== null &&
      closeTo(analysis.minHz, binHz, 1e-9) && analysis.maxHz === 50e6,
    `min=${analysis.minHz}, truncated=${analysis.truncated}`);

  const bounds = analysis.minHz === null || analysis.maxHz === null
    ? null : { minHz: analysis.minHz, maxHz: analysis.maxHz };
  const axis = bounds === null || analysis.spectrum === null ? null : logFrequencyAxis({
    nyquistHz: bounds.maxHz, minHz: bounds.minHz,
    binHz: analysis.spectrum.binHz, width: 600, height: 300,
  });
  const peakColumn = axis === null || peak === null
    ? undefined
    : axis.columns.find((column) =>
      column.covered && peak.bin >= column.firstBin && peak.bin <= column.lastBin);
  const zoomed = bounds === null || peak === null
    ? null : zoomFftBounds(bounds, peak.interpolatedHz, 0.5, bounds.maxHz);
  const zoomSpan = bounds === null || zoomed === null
    ? 0 : Math.log(bounds.maxHz / bounds.minHz);
  const zoomedSpan = bounds === null || zoomed === null
    ? 0 : Math.log(zoomed.maxHz / zoomed.minHz);
  const zoomPosition = (window: { minHz: number; maxHz: number }): number =>
    Math.log(peak!.interpolatedHz / window.minHz) / Math.log(window.maxHz / window.minHz);
  check('the real fixture peak is on the default axis and a zoom keeps it reachable',
    bounds !== null && peak !== null && zoomed !== null && peakColumn !== undefined &&
      peak.interpolatedHz > bounds.minHz && peak.interpolatedHz < bounds.maxHz &&
      zoomPosition(bounds) > 0.05 && zoomPosition(bounds) < 0.95 &&
      closeTo(zoomedSpan, zoomSpan * 0.5, 1e-9) &&
      zoomed.minHz < peak.interpolatedHz && peak.interpolatedHz < zoomed.maxHz &&
      closeTo(zoomPosition(zoomed), zoomPosition(bounds), 1e-9),
    `bounds=${JSON.stringify(bounds)}, position=${bounds === null ? '-' : zoomPosition(bounds)}, ` +
      `column=${peakColumn === undefined ? 'none' : peakColumn.x}`);
}

{
  const modeStart = app.indexOf('  private setViewMode(mode: AnalysisViewMode): void {');
  const modeEnd = app.indexOf('\n  }', modeStart);
  const setter = modeStart < 0 ? '' : app.slice(modeStart, modeEnd);
  const forbidden = [
    'setViewport(', 'clearCursors(', 'startCapture(', 'stopCapture(', 'persistWorkspace(',
    'this.settings =', 'captureStore.replace(', 'renderPanels();\n    this.relayout',
  ];
  const leaked = forbidden.filter((needle) => setter.includes(needle));
  const injected = setter.replace('this.viewMode = mode;',
    'this.viewMode = mode;\n    this.stack.setViewport(0, 1);');
  check('switching the view changes visibility only: acquisition, cursors and viewport stay put',
    setter.includes('this.viewMode = mode;') && setter.includes('this.syncViewMode();') &&
      setter.includes('this.dirty = true;') && leaked.length === 0 &&
      injected.includes('this.stack.setViewport(0, 1);'),
    `leaked=${JSON.stringify(leaked)}, setter=${setter.length}`);

  const syncStart = app.indexOf('  private syncViewMode(): void {');
  const sync = syncStart < 0 ? '' : app.slice(syncStart, app.indexOf('\n  }', syncStart));
  check('the Time stack is hidden, never cleared, and the FFT canvas is the only shown layer',
    sync.includes("classList.toggle('fft-active', fft)") &&
      sync.includes('this.fftCanvas.el.hidden = !fft;') &&
      !sync.includes('remove()') && !sync.includes('innerHTML') &&
      css.includes('#plot:not(.fft-active) > .fft-canvas { display: none; }') &&
      css.includes('#plot.fft-active #wave-stack') &&
      css.includes('#plot-col.fft-active #axis'),
    `sync=${sync.length}`);
}

{
  const oneSwitch = panel.split('measure-view-mode').length - 1;
  check('one Time/FFT/XY switch lives in the measurement section and adds no fifth section',
    oneSwitch === 2 && panel.includes("['time', 'capturePanel.viewTime']") &&
      panel.includes("['fft', 'capturePanel.viewFft']") &&
      panel.includes("['xy', 'capturePanel.viewXy']") &&
      panel.includes('onPickViewMode(mode: AnalysisViewMode): void;') &&
      app.includes('onPickViewMode: (mode) => this.setViewMode(mode)') &&
      !panel.includes("section(t('capturePanel.fft") &&
      !panel.includes("capture.appendChild(viewSwitch)"),
    `switch=${oneSwitch}`);

  const frameStart = app.indexOf('private frame = (): void => {');
  const frameEnd = app.indexOf('\n  };', frameStart);
  const frame = frameStart < 0 ? '' : app.slice(frameStart, frameEnd);
  const at = frame.indexOf('if (now - this.analysisPanelAt > 500) {');
  const block = at < 0 ? '' : frame.slice(at, frame.indexOf('now - this.runningPanelAt > 500'));
  const branch = (source: string): boolean => {
    const start = source.indexOf('if (now - this.analysisPanelAt > 500) {');
    const end = source.indexOf('now - this.runningPanelAt > 500');
    const body = start < 0 || end < 0 ? '' : source.slice(start, end);
    return body.includes('this.analysisPanelAt = now;') &&
      body.includes("if (this.running && this.viewMode === 'fft') {") &&
      body.includes('this.fftPending = true;') && body.includes('this.dirty = true;') &&
      !body.includes('this.runningPanelAt = now;') &&
      !body.includes('requestAnimationFrame') && !body.includes('setTimeout') &&
      !body.includes('setInterval');
  };
  const shared = frame.replace('this.analysisPanelAt = now;', 'this.runningPanelAt = now;');
  const noTick = frame.replace('this.fftPending = true;', '');
  check('the FFT view recomputes on its own 500 ms analysis branch with no new clock',
    at >= 0 && branch(frame) && !branch(shared) && !branch(noTick) &&
      app.split('private analysisPanelAt = 0;').length - 1 === 1,
    `at=${at}, block=${block.length}, shared=${branch(shared)}, noTick=${branch(noTick)}`);

  const drawStart = app.indexOf('  private draw(force = true): void {');
  const drawHead = drawStart < 0 ? '' : app.slice(drawStart, drawStart + 220);
  check('a stopped FFT view is drawn event-driven through the ordinary frame path',
    drawHead.includes("if (this.viewMode === 'fft') {") &&
      drawHead.includes('this.drawFftView();') &&
      !app.includes('fftTimer') && !app.includes('fftInterval') &&
      canvasSource.indexOf('requestAnimationFrame') < 0 &&
      viewSource.indexOf('setInterval') < 0,
    `head=${drawHead.length}`);
}

{
  const view = slice(app, 'private measurementView(): MeasurementSectionView {',
    'private measurementBase(');
  const paused = (source: string): boolean =>
    source.includes("if (this.viewMode !== 'time') {") &&
    source.includes("unavailable: 'paused'") &&
    source.indexOf("if (this.viewMode !== 'time') {") <
      source.indexOf('const results = new Map<number, MeasurementSourceResult>();');
  const ungated = view.replace('if (this.viewMode !== \'time\') {', 'if (false) {');
  check('the automatic time measurements report a paused state instead of scanning in FFT',
    paused(view) && !paused(ungated) && view.includes('const fft = this.fftSectionView();') &&
      view.includes('      fft,') &&
      panel.includes("'paused': 'capturePanel.measureStatusPaused'") &&
      panel.includes('capturePanel.measureStatusPaused'),
    `paused=${paused(view)}, ungated=${paused(ungated)}`);

  const pumpStart = app.indexOf('private pumpMeasurementCapture(): void {');
  const pump = pumpStart < 0 ? '' : app.slice(pumpStart, app.indexOf('\n  }', pumpStart));
  const recordStart = app.indexOf('private recordMeasurementWave(reason: CaptureStopReason): void {');
  const record = recordStart < 0 ? '' : app.slice(recordStart, app.indexOf('\n  }', recordStart));
  const persist = slice(app, 'private submitPersistenceWave(', 'private clearPersistence(');
  check('statistics, the capture job and Persistence all read the real view mode',
    pump.includes("if (this.viewMode !== 'time') return;") &&
      record.includes("this.measurePageShown() && this.viewMode === 'time'") &&
      persist.includes('viewMode: this.viewMode,') &&
      !persist.includes("viewMode: 'time',"),
    `pump=${pump.includes('viewMode')}, record=${record.includes('viewMode')}, ` +
      `persist=${persist.includes('viewMode: this.viewMode,')}`);
}

{
  const setters = ['setFftSource', 'setFftWindow', 'setFftMinHz', 'resetFftView', 'applyFftBounds']
    .map((name) => {
      const start = app.indexOf(`  private ${name}(`);
      return start < 0 ? '' : app.slice(start, app.indexOf('\n  }', start));
    });
  const forbidden = [
    'this.settings', 'startCapture(', 'stopCapture(', 'persistWorkspace(', 'noteViewportIntent(',
    'setViewport(', 'captureStore.replace(', 'addCursor(', 'removeCursor(',
  ];
  const leaked = setters.flatMap((body) => forbidden.filter((needle) => body.includes(needle)));
  const injected = setters.map((body, index) => index === 0
    ? body.replace('this.fftConfig = next;', 'this.fftConfig = next;\n    this.noteViewportIntent();')
    : body);
  check('FFT source, window, bounds and reset are analysis-only and never touch acquisition',
    setters.every((body) => body.length > 0) && leaked.length === 0 &&
      injected[0] !== setters[0],
    `leaked=${JSON.stringify(leaked)}, setters=${setters.length}`);

  const keyStart = app.indexOf('  private fftConfigKey(');
  const keyBody = keyStart < 0 ? '' : app.slice(keyStart, app.indexOf('\n  }', keyStart));
  const boundsOnly = setters[4] ?? '';
  const displayOnly = (body: string): boolean => body.length > 0 &&
    !body.includes('this.fftCache = null') && !body.includes('this.fftPending = true');
  const narrowed = (body: string): boolean =>
    body.includes('config.minHz') || body.includes('config.maxHz');
  check('pan and zoom change display bounds only, never the settled transform',
    keyBody.length > 0 && !narrowed(keyBody) && displayOnly(boundsOnly) &&
      displayOnly(setters[2] ?? '') && displayOnly(setters[3] ?? '') &&
      app.includes('return fftWithBounds(cache.analysis, config.minHz, config.maxHz);') &&
      narrowed(keyBody.replace('config.window,', 'config.window, config.minHz, config.maxHz,')),
    `key=${keyBody.length}, bounds=${boundsOnly.length}`);

  const wireHead = (source: string): string => {
    const start = source.indexOf('  private wireFft(): void {');
    if (start < 0) return '';
    const end = source.indexOf('canvas.addEventListener(', start);
    return end < 0 ? '' : source.slice(start, end);
  };
  const liveBounds = (source: string): boolean => wireHead(source)
    .includes('fftWithBounds(analysis, this.fftConfig.minHz, this.fftConfig.maxHz)');
  const stale = app.replace(
    'fftWithBounds(analysis, this.fftConfig.minHz, this.fftConfig.maxHz)', 'analysis');
  check('pan and zoom re-anchor on the live display bounds, so repeated zoom compounds',
    liveBounds(app) && !liveBounds(stale) && stale !== app,
    `live=${liveBounds(app)}, stale=${liveBounds(stale)}`);

  const sectionStart = app.indexOf('  private fftSectionView(');
  const sectionBody = sectionStart < 0
    ? '' : app.slice(sectionStart, app.indexOf('\n  }', sectionStart));
  const analysisStart = app.indexOf('  private fftAnalysis(');
  const analysisBody = analysisStart < 0
    ? '' : app.slice(analysisStart, app.indexOf('\n  }', analysisStart));
  check('the view mode and the analysis result are reachable through the same debug path buttons use',
    app.includes('setViewMode: (mode: AnalysisViewMode): void => this.setViewMode(mode),') &&
      app.includes('fft: () => {') &&
      app.includes('const view = this.fftSectionView();') &&
      app.includes('summary: fftSummaryLines(view),'),
    `debug=${app.includes('setViewMode: (mode: AnalysisViewMode)')}`);

  check('FFT reads the current acquisition wave through the exact measurement reader only',
    sectionBody.includes('this.captureStore') &&
      analysisBody.includes('readMeasureSamples(store, {') &&
      analysisBody.includes('analyzeFft({') &&
      !analysisBody.includes('sampleAt(') && !analysisBody.includes('this.store.query('),
    `wave=${sectionBody.includes('this.captureStore')}, ` +
      `reader=${analysisBody.includes('readMeasureSamples(store, {')}`);
}

{
  const wireStart = app.indexOf('  private wireFft(): void {');
  const wire = wireStart < 0
    ? '' : app.slice(wireStart, app.indexOf('\n\n  private setMeasurement(', wireStart));
  const release = slice(wire, 'const release = (event: PointerEvent): void => {', '\n    };');
  const listeners = (source: string): number => (source.match(/canvas\.addEventListener\(/g) ?? []).length;
  const listener = (source: string, event: string): string => {
    const at = source.indexOf(`canvas.addEventListener('${event}', `);
    if (at < 0) return '';
    const next = source.indexOf('canvas.addEventListener(', at + 24);
    return source.slice(at, next < 0 ? source.length : next);
  };
  const first = (body: string, needles: readonly string[]): number =>
    needles.reduce((best, needle) => {
      const at = body.indexOf(needle);
      return at >= 0 && (best < 0 || at < best) ? at : best;
    }, -1);
  const stateWrites = [
    'this.applyFftBounds', 'this.fftHoverX =', 'this.fftDrag =', 'this.dirty = true',
    'this.resetFftView', 'canvas.setPointerCapture', 'this.renderPanels',
  ];
  const isolated = (body: string): boolean => {
    const guard = first(body, ['stop(event);', 'steal(event)']);
    if (guard < 0) return false;
    const write = first(body, stateWrites);
    return write < 0 || guard < write;
  };
  const owned = ['pointermove', 'pointerleave', 'pointerdown', 'dblclick', 'wheel', 'keydown'];
  const direct = owned.every((event) => isolated(listener(wire, event)));
  const delayed = (body: string): string => {
    const at = body.indexOf('stop(event);');
    return at < 0
      ? body : `${body.slice(0, at)}${body.slice(at + 'stop(event);'.length)}\n stop(event);`;
  };
  const moved = owned.some((event) => !isolated(delayed(listener(wire, event))));
  const dropped = owned.some((event) =>
    isolated(listener(wire, event).split('stop(event);').join('')
      .split('steal(event)').join('')));
  const stolen = slice(wire, 'const steal = (event: Event): void => {', '\n    };');
  const ownReceiver = (source: string): boolean => {
    const head = source.slice(source.indexOf('private wireFft'),
      source.indexOf("canvas.addEventListener('wheel'"));
    return head.includes('const canvas = this.fftCanvas.el;');
  };
  const rebound = wire.replace('const canvas = this.fftCanvas.el;', 'const canvas = this.el.axis;');
  check('every FFT pointer, wheel and key handler stops the event before the plot or a shortcut sees it',
    wire.length > 0 && listeners(wire) === 8 && direct && isolated(release) && moved && !dropped &&
      wire.includes("canvas.addEventListener('pointerup', release);") &&
      wire.includes("canvas.addEventListener('pointercancel', release);") &&
      stolen.includes('event.preventDefault();') && stolen.includes('event.stopPropagation();') &&
      ownReceiver(wire) && !ownReceiver(rebound),
    `listeners=${listeners(wire)}, direct=${direct}, release=${isolated(release)}, ` +
      `moved=${moved}, dropped=${dropped}, own=${ownReceiver(wire)}/${ownReceiver(rebound)}`);
}

{
  check('the FFT canvas is an accessible image with a live text summary and keyboard zoom',
    canvasSource.includes("canvas.setAttribute('role', 'img');") &&
      canvasSource.includes('canvas.tabIndex = 0;') &&
      app.includes("this.fftCanvas.el.setAttribute('aria-label', fftAccessibleText(view));") &&
      panel.includes("summary.dataset.fftSummary = '';") &&
      !panel.includes("summary.setAttribute('aria-label'") &&
      app.includes("canvas.addEventListener('keydown', (event) => {") &&
      app.includes("event.key === 'ArrowLeft' || event.key === 'ArrowRight'") &&
      app.includes("event.key === '0'"),
    `label=${app.includes('fftAccessibleText(view)')}`);

  const fftRules = ['.fft-canvas {', '.measure-view-mode {', '.measure-view-mode-btn {',
    '.fft-controls {', '.analyzer-act.fft-reset {', '.fft-summary {'];
  const missing = fftRules.filter((rule) => !css.includes(rule));
  check('the sheet carries the analysis-view rules and the controls wrap at a narrow rail',
    missing.length === 0 && css.includes('.measure-view-mode-btn:focus-visible') &&
      slice(css, '.fft-controls {', '}').includes('flex-wrap: wrap;') &&
      slice(css, '.fft-summary {', '}').includes('white-space: pre-line;'),
    `missing=${JSON.stringify(missing)}`);
}

{
  const boxOf = (over: Partial<FftViewportInput>): FftViewportBox => fftViewportBox({
    scrollTop: 0, viewportHeight: 789, stripsHeight: 86, plotHeight: 1352, width: 1006, ...over,
  });
  const desktop = boxOf({});
  const small = boxOf({ viewportHeight: 489, width: 366 });
  const phone = boxOf({ viewportHeight: 671, width: 276 });
  check('the analysis canvas box is the visible plot viewport, never the grown channel content',
    desktop.top === 0 && desktop.height === 703 && desktop.width === 1006 &&
      desktop.height === 789 - 86 &&
      boxOf({ plotHeight: 4096 }).height === 703 && boxOf({ plotHeight: 4096 }).top === 0,
    `desktop=${JSON.stringify(desktop)}, tall=${JSON.stringify(boxOf({ plotHeight: 4096 }))}`);

  const resized = [
    [489, 403] as const,
    [671, 585] as const,
    [989, 903] as const,
  ];
  check('a window, sidebar or strip resize changes the box height with the visible viewport',
    resized.every(([viewportHeight, height]) =>
      boxOf({ viewportHeight }).height === height) &&
      small.height !== desktop.height && phone.height !== desktop.height &&
      phone.width === 276 && small.width === 366 &&
      boxOf({ stripsHeight: 116 }).height === 673,
    `small=${JSON.stringify(small)}, phone=${JSON.stringify(phone)}, ` +
      `tallViewport=${boxOf({ viewportHeight: 989 }).height}`);

  const rowCounts = [1352, 1304, 1208, 452].map((plotHeight) => boxOf({ plotHeight }).height);
  check('adding or removing channel rows never resizes the analysis canvas',
    rowCounts.slice(0, 3).every((height) => height === 703) && rowCounts[3] === 452,
    `heights=${JSON.stringify(rowCounts)}`);

  const scrolled = boxOf({ scrollTop: 240 });
  const past = boxOf({ scrollTop: 1300 });
  check('scrolling the channel stack moves the box to the visible strip and stops at the content end',
    scrolled.top === 240 && scrolled.height === 703 &&
      past.top === 1300 && past.height === 52 &&
      boxOf({ scrollTop: -40 }).top === 0 && boxOf({ scrollTop: 240.6 }).top === 241,
    `scrolled=${JSON.stringify(scrolled)}, past=${JSON.stringify(past)}`);

  const degenerate = [
    boxOf({ viewportHeight: 20 }),
    boxOf({ viewportHeight: 0, plotHeight: 1, scrollTop: 5000 }),
    boxOf({ width: 0, plotHeight: 0 }),
    boxOf({ viewportHeight: Number.NaN, plotHeight: Number.NaN, width: Number.NaN }),
  ];
  check('a viewport shorter than the sticky strips still yields a drawable box',
    degenerate.every((box) => box.height >= 1 && box.width >= 1 && box.top >= 0 &&
      Number.isFinite(box.height) && Number.isFinite(box.top)),
    `boxes=${JSON.stringify(degenerate)}`);
}

{
  const boxMethod = slice(app, '  private fftCanvasBox(): FftViewportBox {', '\n  }');
  const draw = slice(app, '  private drawFftView(): void {', '\n  private emptyFftAxis(');
  const derives = boxMethod.includes('scrollTop: this.el.scroll.scrollTop,') &&
    boxMethod.includes('viewportHeight: this.el.scroll.clientHeight,') &&
    boxMethod.includes('stripsHeight: this.el.overview.offsetHeight + this.el.axis.offsetHeight,') &&
    boxMethod.includes('plotHeight: this.el.plot.clientHeight,') &&
    boxMethod.includes('width: this.el.plot.clientWidth,');
  const contentSized = boxMethod.replace('viewportHeight: this.el.scroll.clientHeight,',
    'viewportHeight: this.el.plot.clientHeight,');
  const byContent = (source: string): boolean =>
    source.includes('viewportHeight: this.el.plot.clientHeight,');
  check('the analysis canvas is sized from the scroll viewport and the sticky strips, not the plot content',
    derives && !byContent(boxMethod) && byContent(contentSized),
    `derives=${derives}, byContent=${byContent(contentSized)}`);

  const synced = draw.includes('const box = this.fftCanvasBox();') &&
    draw.includes('this.fftCanvas.syncSize(box);') &&
    !draw.includes('this.el.plot.clientHeight') &&
    draw.includes('const width = Math.max(1, Math.round(widthCss));') &&
    draw.includes('const height = Math.max(1, Math.round(heightCss));');
  const contentDrawn = draw.replace('this.fftCanvas.syncSize(box);',
    'this.fftCanvas.syncSize({ top: 0, width: box.width, height: this.el.plot.clientHeight });');
  check('every FFT draw re-derives the box, so resize and scroll need no second clock',
    synced && contentDrawn.includes('this.el.plot.clientHeight') &&
      !contentDrawn.includes('this.fftCanvas.syncSize(box);'),
    `synced=${synced}, draw=${draw.length}`);

  const sync = slice(canvasSource, '  syncSize(box: FftViewportBox): boolean {', '\n  }');
  check('the canvas applies the box as its CSS box and buffer size at the current DPR',
    sync.includes('this.el.style.width = `${box.width}px`;') &&
      sync.includes('this.el.style.height = `${box.height}px`;') &&
      sync.includes('this.el.style.top = `${box.top}px`;') &&
      sync.includes('Math.round(box.width * dpr)') &&
      sync.includes('Math.round(box.height * dpr)') &&
      !sync.includes('100%'),
    `sync=${sync.length}`);

  const rule = slice(css, '.fft-canvas {', '}');
  check('the analysis canvas is placed from the box, so it cannot inherit the content height',
    rule.includes('position: absolute;') && rule.includes('left: 0;') &&
      rule.includes('top: 0;') && !rule.includes('inset: 0') &&
      !rule.includes('100%'),
    `rule=${JSON.stringify(rule)}`);

  const wireStart = app.indexOf('  private wireFft(): void {');
  const scrollAt = app.indexOf("this.el.scroll.addEventListener('scroll',", wireStart);
  const scrollEnd = "{ passive: true });";
  const scrollBlock = scrollAt < 0
    ? '' : app.slice(scrollAt, app.indexOf(scrollEnd, scrollAt) + scrollEnd.length);
  const gated = (source: string): boolean =>
    source.includes("if (this.viewMode !== 'fft') return;") &&
      source.includes('this.dirty = true;');
  const ungated = scrollBlock.replace("if (this.viewMode !== 'fft') return;", '');
  check('a scroll of the channel stack repositions the box through the ordinary frame path',
    scrollAt > wireStart && scrollBlock.includes(scrollEnd) &&
      gated(scrollBlock) && !gated(ungated) &&
      !scrollBlock.includes('requestAnimationFrame') &&
      !scrollBlock.includes('this.relayout()'),
    `block=${JSON.stringify(scrollBlock)}`);
}

{
  const catalogKeys = Object.keys(en).filter((key) =>
    key.startsWith('capturePanel.fft') || key.startsWith('capturePanel.viewMode') ||
    key === 'capturePanel.viewTime' || key === 'capturePanel.viewFft' ||
    key === 'capturePanel.measureStatusPaused');
  const catalogs = { zhCN, ru, fr } as Record<string, Record<string, string>>;
  const missing = catalogKeys.filter((key) =>
    !(key in zhCN) || !(key in ru) || !(key in fr));
  const empty = catalogKeys.filter((key) =>
    ![en, zhCN, ru, fr].every((catalog) => (catalog as Record<string, string>)[key]?.trim()));
  const sameCount = Object.values(catalogs)
    .every((catalog) => catalogKeys.every((key) => typeof catalog[key] === 'string'));
  check('every analysis-view string exists in all four catalogs with real text',
    catalogKeys.length >= 30 && missing.length === 0 && empty.length === 0 && sameCount,
    `keys=${catalogKeys.length}, missing=${JSON.stringify(missing)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
