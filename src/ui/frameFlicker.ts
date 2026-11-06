// SPDX-License-Identifier: GPL-3.0-or-later

export interface CanvasSample {
  mean: number;
  alpha: number;
  hash: string;
  stale?: boolean;
}

export interface FlickerFrame {
  canvases: Record<string, CanvasSample>;
}

export const BLANK_PAINTED_MIN_MEAN = 8;
export const BLANK_COLLAPSE_RATIO = 0.25;
export const OUTLIER_RATIO = 1.12;
export const CAPTURE_START_SETTLE_FRAMES = 12;

export interface BlankCanvasHit {
  frame: number;
  canvas: string;
  from: number;
  to: number;
}

export interface BlankCanvasReport {
  hits: BlankCanvasHit[];
  painted: string[];
}

export interface BrightnessOutlier {
  frame: number;
  mean: number;
  ratio: number;
}

export interface BrightnessOutlierOptions {
  ratio?: number;
}

export interface BrightnessOutlierReport {
  median: number;
  outliers: BrightnessOutlier[];
}

export interface CaptureStartOptions {
  ratio?: number;
  settleFrames?: number;
  windowFrames?: number;
}

export interface CaptureStartReport {
  settledMean: number;
  outliers: BrightnessOutlier[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function seriesOf(frames: readonly FlickerFrame[], canvas: string): number[] {
  const out: number[] = [];
  for (const frame of frames) {
    const sample = frame.canvases[canvas];
    if (sample !== undefined && sample.stale !== true) out.push(finite(sample.mean));
  }
  return out;
}

export function blankCanvasFrames(frames: readonly FlickerFrame[]): BlankCanvasReport {
  const names: string[] = [];
  for (const frame of frames) {
    for (const name of Object.keys(frame.canvases)) {
      if (!names.includes(name)) names.push(name);
    }
  }
  const hits: BlankCanvasHit[] = [];
  const painted: string[] = [];
  for (const canvas of names) {
    const level = median(seriesOf(frames, canvas));
    if (!(level > BLANK_PAINTED_MIN_MEAN)) continue;
    painted.push(canvas);
    let seen = false;
    for (let index = 0; index < frames.length; index++) {
      const sample = frames[index]!.canvases[canvas];
      if (sample === undefined || sample.stale === true) continue;
      const mean = finite(sample.mean);
      if (!seen) {
        if (mean > BLANK_PAINTED_MIN_MEAN) seen = true;
        continue;
      }
      if (mean <= level * BLANK_COLLAPSE_RATIO) {
        hits.push({ frame: index, canvas, from: level, to: mean });
      }
    }
  }
  return { hits, painted };
}

export function brightnessOutliers(
  plotMeans: readonly number[], opts: BrightnessOutlierOptions = {},
): BrightnessOutlierReport {
  const ratio = opts.ratio ?? OUTLIER_RATIO;
  const series = plotMeans.map(finite);
  const level = median(series);
  const outliers: BrightnessOutlier[] = [];
  if (!(level > 0)) return { median: level, outliers };
  for (let frame = 0; frame < series.length; frame++) {
    const mean = series[frame]!;
    if (mean > level * ratio) outliers.push({ frame, mean, ratio: mean / level });
  }
  return { median: level, outliers };
}

export function analyzeCaptureStart(
  plotMeans: readonly number[], startFrame: number, opts: CaptureStartOptions = {},
): CaptureStartReport {
  const ratio = opts.ratio ?? OUTLIER_RATIO;
  const settle = Math.max(0, Math.floor(opts.settleFrames ?? CAPTURE_START_SETTLE_FRAMES));
  const series = plotMeans.map(finite);
  const settledMean = median(series.slice(settle));
  const outliers: BrightnessOutlier[] = [];
  if (!(settledMean > 0)) return { settledMean, outliers };
  const from = Math.max(0, Math.min(Math.floor(startFrame), series.length));
  const until = opts.windowFrames === undefined
    ? series.length
    : Math.min(series.length, from + Math.max(0, Math.floor(opts.windowFrames)));
  for (let frame = from; frame < until; frame++) {
    const mean = series[frame]!;
    if (mean > settledMean * ratio) outliers.push({ frame, mean, ratio: mean / settledMean });
  }
  return { settledMean, outliers };
}
