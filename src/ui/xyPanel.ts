// SPDX-License-Identifier: GPL-3.0-or-later

import { formatCount } from './format.js';
import { t, type MessageKey } from './i18n.js';
import type { MeasurementSource } from './measurementState.js';
import {
  XY_REASON_KEYS,
  type XyAxes, type XyDensity, type XyPlan, type XyRefusal, type XySummary,
} from './xyView.js';
import type { AnalysisViewMode } from './fftView.js';

export type XyAxis = 'x' | 'y';

export type XyStatus =
  | 'idle'
  | 'ok'
  | 'no-source'
  | 'no-window'
  | 'previous-wave-displayed'
  | XyRefusal;

export interface XyConfig {
  sourceX: number | null;
  sourceY: number | null;
  fit: boolean;
}

export const XY_DEFAULT_CONFIG: XyConfig = { sourceX: null, sourceY: null, fit: false };

export interface XyAnalysis {
  status: XyStatus;
  sourceX: MeasurementSource | null;
  sourceY: MeasurementSource | null;
  windowStart: number;
  windowEnd: number;
  requestedSamples: number;
  analyzedSamples: number;
  clipped: boolean;
  truncated: boolean;
  fit: boolean;
  plan: XyPlan | null;
  axes: XyAxes | null;
  density: XyDensity | null;
  summary: XySummary | null;
}

export interface XySectionView {
  mode: AnalysisViewMode;
  sources: readonly MeasurementSource[];
  sourceX: number | null;
  sourceY: number | null;
  fit: boolean;
  analysis: XyAnalysis | null;
}

function present(sources: readonly MeasurementSource[], start: number | null): boolean {
  return start !== null && sources.some((source) => source.start === start);
}

export function defaultXySource(
  sources: readonly MeasurementSource[], preferred: number | null,
): number | null {
  if (preferred !== null) {
    const match = sources.find((source) => source.start === preferred);
    if (match !== undefined) return match.start;
  }
  return sources[0]?.start ?? null;
}

export function reconcileXyConfig(
  config: XyConfig, sources: readonly MeasurementSource[], preferredX: number | null,
): XyConfig {
  const sourceX = present(sources, config.sourceX)
    ? config.sourceX
    : defaultXySource(sources, preferredX);
  const others = sources.filter((source) => source.start !== sourceX);
  let sourceY = present(sources, config.sourceY) && config.sourceY !== sourceX
    ? config.sourceY
    : defaultXySource(others, preferredX);
  if (sourceY === sourceX) sourceY = null;
  if (sourceX === config.sourceX && sourceY === config.sourceY) return config;
  return { sourceX, sourceY, fit: config.fit };
}

export function selectXySource(config: XyConfig, axis: XyAxis, start: number | null): XyConfig {
  if (axis === 'x') {
    if (start === config.sourceX) return config;
    if (start !== null && start === config.sourceY) {
      return { sourceX: config.sourceY, sourceY: config.sourceX, fit: config.fit };
    }
    return { ...config, sourceX: start };
  }
  if (start === config.sourceY) return config;
  if (start !== null && start === config.sourceX) {
    return { sourceX: config.sourceY, sourceY: config.sourceX, fit: config.fit };
  }
  return { ...config, sourceY: start };
}

export function setXyFit(config: XyConfig, fit: boolean): XyConfig {
  if (config.fit === fit) return config;
  return { ...config, fit };
}

function formatVolts(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${Number(value.toPrecision(3))} V`;
}

function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '-';
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatGain(gain: number): string {
  return `${Number(gain.toPrecision(3))}\u00d7`;
}

export function xySourceLabel(source: MeasurementSource | null): string {
  if (source === null) return '-';
  return `${source.name} ${formatGain(source.gain)}`;
}

export function xyStatusReason(analysis: XyAnalysis): string {
  switch (analysis.status) {
    case 'same-source':
    case 'unavailable':
    case 'too-few':
    case 'gap':
      return t(XY_REASON_KEYS[analysis.status] as MessageKey, {
        requested: formatCount(analysis.requestedSamples),
        paired: formatCount(analysis.summary?.paired ?? 0),
        gap: formatCount(analysis.summary?.gapExcluded ?? 0),
      });
    case 'no-source': return t('capturePanel.xyNoSource');
    case 'no-window': return t('capturePanel.xyNoWindow');
    case 'previous-wave-displayed': return t('capturePanel.xyPreviousWave');
    case 'idle': return t('capturePanel.xyIdle');
    case 'ok': return '';
  }
}

export function xySummaryLines(view: XySectionView): string[] {
  if (view.mode !== 'xy') return [t('capturePanel.xyIdle')];
  const analysis = view.analysis;
  if (analysis === null) return [t('capturePanel.xyNoSource')];
  const summary = analysis.summary;
  if (analysis.status !== 'ok' || summary === null) {
    const lines = [xyStatusReason(analysis)];
    if (analysis.requestedSamples > 0) {
      lines.push(t('capturePanel.xyLineCounts', {
        requested: formatCount(summary?.requested ?? analysis.requestedSamples),
        plotted: formatCount(summary?.plotted ?? 0),
        gap: formatCount(summary?.gapExcluded ?? 0),
      }));
    }
    if (analysis.clipped) lines.push(t('capturePanel.xyCropped'));
    return lines;
  }
  const sourceX = analysis.sourceX;
  const sourceY = analysis.sourceY;
  const lines = [
    t('capturePanel.xyLineSources', {
      x: sourceX?.name ?? '-',
      y: sourceY?.name ?? '-',
      gainX: formatGain(sourceX?.gain ?? 0),
      gainY: formatGain(sourceY?.gain ?? 0),
    }),
    t('capturePanel.xyLineWindow', {
      start: formatCount(analysis.windowStart),
      end: formatCount(analysis.windowEnd),
      count: formatCount(analysis.requestedSamples),
    }),
    t('capturePanel.xyLineCounts', {
      requested: formatCount(summary.requested),
      plotted: formatCount(summary.plotted),
      gap: formatCount(summary.gapExcluded),
    }),
  ];
  if (summary.stride > 1) {
    lines.push(t('capturePanel.xyLineStride', { stride: formatCount(summary.stride) }));
  }
  if (summary.density !== null) {
    lines.push(t('capturePanel.xyLineDensity', {
      ceiling: formatCount(summary.density.maxPerPixel),
      saturated: formatCount(summary.density.saturatedPixels),
    }));
  }
  if (summary.rangeX !== null && summary.rangeY !== null) {
    lines.push(t('capturePanel.xyLineAxes', {
      xmin: formatVolts(summary.rangeX.min),
      xmax: formatVolts(summary.rangeX.max),
      ymin: formatVolts(summary.rangeY.min),
      ymax: formatVolts(summary.rangeY.max),
    }));
    lines.push(summary.fit
      ? t('capturePanel.xyLineRangeFit')
      : t('capturePanel.xyLineRangeFull'));
    lines.push(summary.zeroFractionX !== null && summary.zeroFractionY !== null
      ? t('capturePanel.xyLineZero', {
        x: formatPercent(summary.zeroFractionX),
        y: formatPercent(summary.zeroFractionY),
      })
      : t('capturePanel.xyZeroOutside'));
  }
  lines.push(t('capturePanel.xyLineQuantum', {
    x: formatVolts(analysis.plan?.status === 'ok' ? analysis.plan.voltsPerCodeX : 0),
    y: formatVolts(analysis.plan?.status === 'ok' ? analysis.plan.voltsPerCodeY : 0),
  }));
  if (analysis.clipped) lines.push(t('capturePanel.xyCropped'));
  if (analysis.truncated) {
    lines.push(t('capturePanel.xyTruncated', {
      analyzed: formatCount(analysis.analyzedSamples),
      requested: formatCount(analysis.requestedSamples),
    }));
  }
  return lines;
}

export function xyAccessibleText(view: XySectionView): string {
  return xySummaryLines(view).join(' \u00b7 ');
}
