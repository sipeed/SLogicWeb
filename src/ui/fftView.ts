// SPDX-License-Identifier: GPL-3.0-or-later

import {
  WINDOW_KINDS, type WindowKind,
} from '../dsp/fft.js';
import {
  FFT_DBFS_FLOOR, FFT_MAX_SAMPLES, computeSpectrum, type Spectrum,
} from '../dsp/fftSpectrum.js';
import { formatCount, formatFreq, formatRate } from './format.js';
import { t } from './i18n.js';
import type { MeasurementSource } from './measurementState.js';

export type AnalysisViewMode = 'time' | 'fft';

export type FftStatus =
  | 'idle'
  | 'ok'
  | 'no-source'
  | 'no-window'
  | 'previous-wave-displayed'
  | 'gap'
  | 'too-short';

export interface FftConfig {
  source: number | null;
  window: WindowKind;
  minHz: number | null;
  maxHz: number | null;
}

export interface FftBounds {
  minHz: number;
  maxHz: number;
}

export const FFT_MIN_HZ_PRESETS: readonly number[] = [
  1, 10, 100, 1e3, 10e3, 100e3, 1e6, 10e6, 100e6,
];

export const FFT_MIN_HZ_FLOOR = 1e-3;

export const FFT_DB_TOP = 0;

export const FFT_DB_FLOOR_MARGIN = 20;

export const FFT_MIN_DECADES = 0.02;

export const FFT_MAX_DECADES = 10;

export interface FftRequest {
  source: MeasurementSource;
  codes: ArrayLike<number>;
  unknown?: ArrayLike<number>;
  samplerate: number;
  zeroCode: number;
  voltsPerCode: number;
  window: WindowKind;
  windowStart: number;
  requestedSamples: number;
  clipped: boolean;
  minHz: number | null;
  maxHz: number | null;
}

export interface FftAnalysis {
  status: FftStatus;
  source: MeasurementSource | null;
  spectrum: Spectrum | null;
  samplerateHz: number;
  voltsPerCode: number;
  windowStart: number;
  requestedSamples: number;
  analyzedSamples: number;
  truncated: boolean;
  clipped: boolean;
  gapAt: number | null;
  minHz: number | null;
  maxHz: number | null;
}

export interface FftSectionView {
  mode: AnalysisViewMode;
  sources: readonly MeasurementSource[];
  source: number | null;
  window: WindowKind;
  minHz: number | null;
  maxHz: number | null;
  analysis: FftAnalysis | null;
}

export const FFT_DEFAULT_CONFIG: FftConfig = {
  source: null, window: 'hann', minHz: null, maxHz: null,
};

export function fftWindowKind(raw: unknown): WindowKind {
  return typeof raw === 'string' && (WINDOW_KINDS as readonly string[]).includes(raw)
    ? raw as WindowKind : 'hann';
}

export function fftWindowLabel(kind: WindowKind): string {
  switch (kind) {
    case 'rectangular': return t('capturePanel.fftWindowRectangular');
    case 'hamming': return t('capturePanel.fftWindowHamming');
    case 'blackman': return t('capturePanel.fftWindowBlackman');
    case 'hann': return t('capturePanel.fftWindowHann');
  }
}

export function defaultFftMinHz(binHz: number, upperHz: number): number {
  if (!Number.isFinite(binHz) || binHz <= 0) return FFT_MIN_HZ_FLOOR;
  if (!Number.isFinite(upperHz) || upperHz <= 0) return binHz;
  return Math.min(binHz, upperHz / 2);
}

export function resolveFftBounds(
  minHz: number | null, maxHz: number | null, binHz: number, nyquistHz: number,
): FftBounds {
  const upper = Math.min(
    Math.max(Number.isFinite(maxHz ?? Number.NaN) ? maxHz! : nyquistHz, FFT_MIN_HZ_FLOOR),
    nyquistHz,
  );
  const lower = Math.min(
    Math.max(
      Number.isFinite(minHz ?? Number.NaN) ? minHz! : defaultFftMinHz(binHz, upper),
      FFT_MIN_HZ_FLOOR,
    ),
    upper / (10 ** FFT_MIN_DECADES),
  );
  return { minHz: lower, maxHz: upper };
}

export function defaultFftSource(
  sources: readonly MeasurementSource[], preferred: number | null,
): number | null {
  if (preferred !== null && sources.some((source) => source.start === preferred)) {
    return preferred;
  }
  return sources[0]?.start ?? null;
}

export function reconcileFftConfig(
  config: FftConfig, sources: readonly MeasurementSource[], preferred: number | null,
): FftConfig {
  const present = config.source !== null &&
    sources.some((source) => source.start === config.source);
  const source = present ? config.source : defaultFftSource(sources, preferred);
  const window = fftWindowKind(config.window);
  const minHz = Number.isFinite(config.minHz ?? Number.NaN) ? config.minHz : null;
  const maxHz = Number.isFinite(config.maxHz ?? Number.NaN) ? config.maxHz : null;
  if (source === config.source && window === config.window &&
    minHz === config.minHz && maxHz === config.maxHz) return config;
  return { source, window, minHz, maxHz };
}

export function selectFftSource(config: FftConfig, source: number | null): FftConfig {
  return source === config.source ? config : { ...config, source };
}

export function selectFftWindow(config: FftConfig, window: WindowKind): FftConfig {
  return window === config.window ? config : { ...config, window };
}

export function selectFftMinHz(config: FftConfig, minHz: number | null): FftConfig {
  return minHz === config.minHz && config.maxHz === null
    ? config : { ...config, minHz, maxHz: null };
}

export function resetFftBounds(config: FftConfig): FftConfig {
  return config.minHz === null && config.maxHz === null
    ? config : { ...config, minHz: null, maxHz: null };
}

export function zoomFftBounds(
  bounds: FftBounds, anchorHz: number, factor: number, nyquistHz: number,
): FftBounds {
  const floor = FFT_MIN_HZ_FLOOR;
  const anchor = Math.min(Math.max(anchorHz, floor), nyquistHz);
  const minLog = Math.log(bounds.minHz);
  const maxLog = Math.log(bounds.maxHz);
  const anchorLog = Math.log(anchor);
  const span = maxLog - minLog;
  const nextSpan = Math.min(
    Math.max(span * factor, Math.log(10) * FFT_MIN_DECADES),
    Math.log(10) * FFT_MAX_DECADES,
  );
  let lo = anchorLog - (anchorLog - minLog) * (nextSpan / span);
  let hi = lo + nextSpan;
  if (lo < Math.log(floor)) {
    lo = Math.log(floor);
    hi = lo + nextSpan;
  }
  if (hi > Math.log(nyquistHz)) {
    hi = Math.log(nyquistHz);
    lo = hi - nextSpan;
  }
  return { minHz: Math.exp(lo), maxHz: Math.exp(hi) };
}

export function panFftBounds(
  bounds: FftBounds, deltaCss: number, width: number, nyquistHz: number,
): FftBounds {
  if (!Number.isFinite(deltaCss) || width <= 0) return bounds;
  const span = Math.log(bounds.maxHz / bounds.minHz);
  const shift = (deltaCss / width) * span;
  const lo = Math.log(bounds.minHz) - shift;
  const hi = lo + span;
  const floorLog = Math.log(FFT_MIN_HZ_FLOOR);
  const topLog = Math.log(nyquistHz);
  if (lo < floorLog) {
    return { minHz: FFT_MIN_HZ_FLOOR, maxHz: Math.exp(floorLog + span) };
  }
  if (hi > topLog) {
    return { minHz: Math.exp(topLog - span), maxHz: nyquistHz };
  }
  return { minHz: Math.exp(lo), maxHz: Math.exp(hi) };
}

export function analyzeFft(input: FftRequest): FftAnalysis {
  const spectrum = computeSpectrum({
    codes: input.codes,
    ...(input.unknown === undefined ? {} : { unknown: input.unknown }),
    samplerate: input.samplerate,
    zeroCode: input.zeroCode,
    voltsPerCode: input.voltsPerCode,
    window: input.window,
  });
  const ok = spectrum.status === 'ok';
  const bounds = ok
    ? resolveFftBounds(input.minHz, input.maxHz, spectrum.binHz, spectrum.nyquistHz)
    : null;
  return {
    status: spectrum.status,
    source: input.source,
    spectrum: ok ? spectrum : null,
    samplerateHz: input.samplerate,
    voltsPerCode: input.voltsPerCode,
    windowStart: input.windowStart,
    requestedSamples: input.requestedSamples,
    analyzedSamples: spectrum.n,
    truncated: input.requestedSamples > FFT_MAX_SAMPLES,
    clipped: input.clipped,
    gapAt: spectrum.gapAt === null ? null : input.windowStart + spectrum.gapAt,
    minHz: bounds === null ? null : bounds.minHz,
    maxHz: bounds === null ? null : bounds.maxHz,
  };
}

export function fftWithBounds(
  analysis: FftAnalysis, minHz: number | null, maxHz: number | null,
): FftAnalysis {
  const spectrum = analysis.spectrum;
  if (spectrum === null) return analysis;
  const bounds = resolveFftBounds(minHz, maxHz, spectrum.binHz, spectrum.nyquistHz);
  if (analysis.minHz === bounds.minHz && analysis.maxHz === bounds.maxHz) return analysis;
  return { ...analysis, minHz: bounds.minHz, maxHz: bounds.maxHz };
}

export function fftStatusReason(analysis: FftAnalysis): string {
  switch (analysis.status) {
    case 'no-source': return t('capturePanel.fftNoSource');
    case 'no-window': return t('capturePanel.fftNoWindow');
    case 'previous-wave-displayed': return t('capturePanel.fftPreviousWave');
    case 'gap': return t('capturePanel.fftGap', {
      sample: formatCount(analysis.gapAt ?? 0),
    });
    case 'too-short': return t('capturePanel.fftTooShort');
    case 'idle': return t('capturePanel.fftIdle');
    case 'ok': return '';
  }
}

function formatDbfs(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(1)} dBFS`;
}

function formatVolts(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${Number(value.toPrecision(3))} V`;
}

function formatBins(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return String(Number(value.toPrecision(4)));
}

export function fftSummaryLines(view: FftSectionView): string[] {
  const analysis = view.analysis;
  if (view.mode !== 'fft') return [t('capturePanel.fftIdle')];
  if (analysis === null) return [t('capturePanel.fftNoSource')];
  if (analysis.status !== 'ok' || analysis.spectrum === null) {
    return [fftStatusReason(analysis)];
  }
  const spectrum = analysis.spectrum;
  const sourceName = analysis.source?.name ?? '';
  const lines = [
    t('capturePanel.fftLineSource', { name: sourceName }),
    t('capturePanel.fftLineResolution', {
      rate: formatRate(analysis.samplerateHz),
      n: formatCount(spectrum.n),
      delta: formatFreq(spectrum.binHz),
    }),
    t('capturePanel.fftLineWindow', {
      window: fftWindowLabel(view.window),
      enbw: formatBins(spectrum.enbwBins),
      rbw: formatFreq(spectrum.rbwHz),
    }),
    t('capturePanel.fftLineAxis', {
      nyquist: formatFreq(spectrum.nyquistHz),
      min: formatFreq(analysis.minHz ?? spectrum.binHz),
      max: formatFreq(analysis.maxHz ?? spectrum.nyquistHz),
    }),
    t('capturePanel.fftLineSamples', {
      analyzed: formatCount(spectrum.n),
      requested: formatCount(analysis.requestedSamples),
    }),
  ];
  if (analysis.truncated) {
    lines.push(t('capturePanel.fftLineBound', {
      count: formatCount(FFT_MAX_SAMPLES),
    }));
  }
  if (analysis.clipped) lines.push(t('capturePanel.fftCropped'));
  lines.push(t('capturePanel.fftLineReference', {
    floor: formatDbfs(spectrum.quantizationFloorDbfs),
  }));
  lines.push(t('capturePanel.fftLineDc', { dc: formatDbfs(spectrum.dcDbfs) }));
  const peak = spectrum.peak;
  if (peak !== null) {
    lines.push(t('capturePanel.fftLinePeak', {
      frequency: formatFreq(peak.interpolatedHz),
      dbfs: formatDbfs(peak.dbfs),
      volts: formatVolts(peak.volts),
    }));
    lines.push(t('capturePanel.fftLinePeakRaw', {
      bin: formatFreq(peak.hz),
    }));
    lines.push(t('capturePanel.fftPeakMethod'));
  }
  return lines;
}

export function fftAccessibleText(view: FftSectionView): string {
  return fftSummaryLines(view).join(' · ');
}

export function fftDbRange(quantizationFloorDbfs: number): { top: number; bottom: number } {
  const bottom = Number.isFinite(quantizationFloorDbfs)
    ? Math.max(FFT_DBFS_FLOOR + 10, Math.min(-10,
      Math.floor((quantizationFloorDbfs - FFT_DB_FLOOR_MARGIN) / 10) * 10))
    : -100;
  return { top: FFT_DB_TOP, bottom };
}

export function fftDbY(dbfs: number, top: number, bottom: number, height: number): number {
  if (!Number.isFinite(dbfs)) return height;
  const span = top - bottom;
  if (span <= 0) return height;
  const clamped = Math.min(top, Math.max(bottom, dbfs));
  return ((top - clamped) / span) * height;
}
