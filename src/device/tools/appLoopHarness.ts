// SPDX-License-Identifier: GPL-3.0-or-later

import { WorkerSlogicDevice } from '../workerTransport.js';
import type { Device } from '../types.js';
import { bytesPerSampleForChannels } from '../../types.js';
import { maxCaptureSeconds } from '../../ui/captureTime.js';
import { FrameCostRing, framesPerSecond } from '../../ui/frameStats.js';
import type { FrameStatsSnapshot } from '../../ui/frameStats.js';
import type { App } from '../../ui/app.js';
import type { StatusError } from '../../ui/state.js';
import { fillCounter16 } from './loopWindowHarness.js';
import FakeUsbWorker from './fakeUsbWorker.js?worker&inline';

interface ProbeProgress {
  samples: number;
  dropped: number;
  kept: number;
  limit: number;
}

export interface LiveFrameSnapshot {
  atMs: number;
  permitted: number;
  drawn: number;
  skipped: number;
  statusRenders: number;
  layers: FrameStatsSnapshot['layers'];
  drawMs: FrameStatsSnapshot['drawMs'];
  samples: number;
  dropped: number;
  kept: number;
  storeLength: number;
  storeDropped: number;
  follow: boolean;
  view: { start: number; end: number };
}

function liveFrameSnapshot(app: AppProbe, startedAt: number): LiveFrameSnapshot {
  const stats = app.debug.frameStats();
  const progress = app.progressView();
  return {
    atMs: performance.now() - startedAt,
    permitted: stats.permitted,
    drawn: stats.drawn,
    skipped: stats.skipped,
    statusRenders: stats.statusRenders,
    layers: stats.layers,
    drawMs: stats.drawMs,
    samples: progress.samples,
    dropped: progress.dropped,
    kept: progress.kept,
    storeLength: app.store.length,
    storeDropped: app.store.droppedSamples,
    follow: app.stack.followLatest,
    view: { start: app.stack.view.start, end: app.stack.view.end },
  };
}

interface ProbeBuilder {
  progress: number;
  done: boolean;
  pyramid: { doneUpTo: number };
}

interface AppProbe {
  stack: { followLatest: boolean; view: { start: number; end: number } };
  device: Device | null;
  deviceEpoch: number;
  running: boolean;
  stopping: boolean;
  statusError: StatusError | null;
  droppedTotal: number;
  store: { channelCount: number; samplerate: number; length: number; droppedSamples: number; append(chunk: Uint8Array): void };
  channels: readonly { enabled: boolean }[];
  busViews: { builder: ProbeBuilder | null }[];
  debug: App['debug'];
  installDevice(device: Device, epoch: number): void;
  discardDevice(): number;
  progressView(): ProbeProgress;
}

export interface AppLoopProbeEnvironment {
  dpr: number;
  gpu: string;
  rafCeilingMs: number;
  envCapped: boolean;
}

const ENV_RAF_FRAMES = 90;
const ENV_RAF_UNCAPPED_MS = 1000 / 45;

export async function measureAppLoopEnvironment(): Promise<AppLoopProbeEnvironment> {
  const dpr = globalThis.devicePixelRatio || 1;
  const gl = document.createElement('canvas').getContext('webgl2');
  let gpu = 'no-webgl2';
  if (gl) {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gpu = typeof name === 'string' ? name : String(name);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  if (document.visibilityState !== 'visible') {
    throw new Error(`the page is ${document.visibilityState}; requestAnimationFrame needs a visible tab`);
  }
  const gaps: number[] = [];
  let previous = 0;
  while (gaps.length < ENV_RAF_FRAMES) {
    const at = await new Promise<number>((resolve) => {
      requestAnimationFrame((stamp) => resolve(stamp));
    });
    if (previous > 0) gaps.push(at - previous);
    previous = at;
  }
  gaps.sort((a, b) => a - b);
  const rafCeilingMs = gaps[Math.floor(gaps.length / 2)]!;
  return { dpr, gpu, rafCeilingMs, envCapped: rafCeilingMs > ENV_RAF_UNCAPPED_MS };
}

export interface AppLoopProbeOptions {
  channels?: 8 | 16 | 32;
  samplerate: number;
  retentionSamples: number;
  seconds: number;
  stallMs?: number;
  minSustainedMBps?: number;
  requireFullRate?: boolean;
  minDrawHz?: number;
  maxDrawHz?: number;
  env?: AppLoopProbeEnvironment;
  stopBuildTimeoutMs?: number;
}

export interface AppLoopSample {
  atMs: number;
  samples: number;
  rawBytes: number;
  dropped: number;
  kept: number;
  peakQueued: number;
  steadyMBps: number;
  draws: number;
  running: boolean;
}

export interface AppLoopProbeReport {
  channels: 8 | 16 | 32;
  samplerate: number;
  expectedMBps: number;
  seconds: number;
  elapsedMs: number;
  samples: number;
  rawBytes: number;
  transfers: number;
  dropped: number;
  kept: number;
  sustainedMBps: number;
  fullRate: boolean;
  requiresFullRate: boolean;
  peakQueuedTransfers: number;
  slowTransfers: number;
  sinkMsP95: number;
  maxIdleGapMs: number;
  maxQuietMs: number;
  limit: number;
  draws: number;
  drawHz: number;
  scheduledHz: number;
  skipped: number;
  statusRenders: number;
  layers: FrameStatsSnapshot['layers'];
  frameCostMs: { p50: number; p95: number; max: number };
  envCapped: boolean;
  rafCeilingMs: number;
  rafIdleMs: number;
  dpr: number;
  gpu: string;
  maxKept: number;
  maxChunkSamples: number;
  droppedConsistent: boolean;
  retentionBounded: boolean;
  pageErrors: string[];
  live: boolean;
  stopBuildMs: number;
  postStopExact: boolean;
  deviceLeak: boolean;
  pass: boolean;
  timeline: AppLoopSample[];
}

export async function runAppLoopProbe(options: AppLoopProbeOptions): Promise<AppLoopProbeReport> {
  const app = window.slogicweb as unknown as AppProbe | undefined;
  if (!app) throw new Error('the App is not ready');
  const channels = options.channels ?? 16;
  app.discardDevice();
  const env = options.env ?? await measureAppLoopEnvironment();
  const bytesPerMs = options.samplerate * bytesPerSampleForChannels(channels) / 1000;
  const expectedMBps = options.samplerate * bytesPerSampleForChannels(channels) / 1e6;
  const worker = new FakeUsbWorker({ name: String(bytesPerMs) });
  const dev = await WorkerSlogicDevice.open(
    { vendorId: 0x359f, productId: 0x3032, serial: 'clock' },
    { spawn: () => worker, openTimeoutMs: 5000 },
  ).catch((error: unknown) => {
    worker.terminate();
    throw error;
  });
  let maxChunkSamples = 0;
  let maxKept = 0;
  const originalStart = dev.start.bind(dev);
  dev.start = (cfg, sink, onDropout, startOptions) => originalStart(cfg, async chunk => {
    fillCounter16(chunk);
    maxChunkSamples = Math.max(maxChunkSamples, chunk.byteLength / bytesPerSampleForChannels(channels));
    await sink(chunk);
    maxKept = Math.max(maxKept, app.store.length);
  }, onDropout, startOptions);

  const timeline: AppLoopSample[] = [];
  let report: AppLoopProbeReport | null = null;
  const pageErrors: string[] = [];
  const onPageError = (event: ErrorEvent): void => { pageErrors.push(event.message); };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    pageErrors.push(String(event.reason));
  };
  const startedAt = performance.now();
  let lastSamples = 0;
  let lastAdvanceAt = startedAt;
  let maxQuietMs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pending: Promise<void> | null = null;
  let pollError: unknown = null;
  let restoreAppend: (() => void) | null = null;
  const runRaf = new FrameCostRing();
  let rafStop = true;
  let rafPrevious = 0;
  const sampleRaf = (stamp: number): void => {
    if (rafStop) return;
    if (rafPrevious > 0) runRaf.push(stamp - rafPrevious);
    rafPrevious = stamp;
    requestAnimationFrame(sampleRaf);
  };
  const sample = async (): Promise<void> => {
    const progress = app.progressView();
    const now = performance.now();
    if (progress.samples !== lastSamples) {
      lastSamples = progress.samples;
      lastAdvanceAt = now;
    }
    maxQuietMs = Math.max(maxQuietMs, now - lastAdvanceAt);
    const stats = await dev.getStats();
    timeline.push({
      atMs: now - startedAt,
      samples: progress.samples,
      rawBytes: stats.rawBytes,
      dropped: progress.dropped,
      kept: progress.kept,
      peakQueued: stats.peakQueuedTransfers,
      steadyMBps: stats.steadyMBps,
      draws: app.debug.frameStats().drawn,
      running: app.running,
    });
  };
  const throwPollError = (): void => {
    if (pollError !== null) throw pollError;
  };
  const poll = (): void => {
    if (pending !== null || pollError !== null) return;
    pending = sample().catch((error: unknown) => {
      pollError = error;
      if (timer !== null) clearInterval(timer);
      timer = null;
    }).finally(() => { pending = null; });
  };

  try {
    window.addEventListener('error', onPageError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    app.installDevice(dev, app.deviceEpoch);
    for (let i = channels; i < app.channels.length; i++) app.debug.toggleChannel(i, false);
    if (app.busViews.length === 0) {
      app.debug.addBus({
        name: 'loop-probe',
        spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' },
        hideSources: true,
      });
    }
    app.debug.setSettings({
      mode: 'loop',
      channels,
      samplerate: options.samplerate,
      testMode: 2,
      softwareTrigger: false,
    });
    app.debug.setSettings({ loopSamples: options.retentionSamples });

    rafStop = false;
    requestAnimationFrame(sampleRaf);
    await app.debug.start();
    app.debug.resetFrameStats();
    const captureStore = app.store;
    const originalAppend = captureStore.append;
    captureStore.append = function(chunk: Uint8Array): void {
      originalAppend.call(this, chunk);
      maxKept = Math.max(maxKept, this.length);
    };
    restoreAppend = () => { captureStore.append = originalAppend; };
    const initial = app.progressView();
    const limit = initial.limit;
    if (app.store.channelCount !== channels || app.store.samplerate !== options.samplerate ||
        limit <= 0) {
      throw new Error(`unexpected capture shape: channels=${app.store.channelCount} ` +
        `rate=${app.store.samplerate} limit=${limit} requested=${options.retentionSamples}`);
    }
    await sample();
    timer = setInterval(poll, 1000);
    try {
      await new Promise(resolve => setTimeout(resolve, options.seconds * 1000));
    } finally {
      clearInterval(timer);
      timer = null;
      await pending;
      throwPollError();
    }
    await sample();
    const elapsedMs = performance.now() - startedAt;
    const beforeStop = app.progressView();
    const appDroppedAtStop = app.droppedTotal;
    const storeDroppedAtStop = app.store.droppedSamples;
    const stats = await dev.getStats();
    const frameStats = app.debug.frameStats();
    const draws = frameStats.drawn;
    const drawHz = framesPerSecond(draws, elapsedMs);
    const scheduledHz = framesPerSecond(frameStats.permitted, elapsedMs);
    const frameCostMs = frameStats.drawMs;
    const droppedConsistent = appDroppedAtStop === storeDroppedAtStop;
    const retentionBounded = maxKept <= beforeStop.limit + maxChunkSamples + 63;
    const live = app.running && app.statusError === null && beforeStop.samples > 0 &&
      maxQuietMs < (options.stallMs ?? 5000);
    rafStop = true;
    const rafIdleMs = env.rafCeilingMs;
    const rafCeilingMs = Math.max(rafIdleMs, runRaf.percentile(50));
    const envCapped = rafCeilingMs > ENV_RAF_UNCAPPED_MS;
    await app.debug.stop();
    const stopStarted = performance.now();
    let postStopExact = false;
    while (performance.now() - stopStarted < (options.stopBuildTimeoutMs ?? 20_000)) {
      const stopped = app.progressView();
      postStopExact = app.busViews.length > 0 && app.busViews.every(b =>
        b.builder?.done === true && b.builder.pyramid.doneUpTo === stopped.kept);
      if (postStopExact) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const stopBuildMs = performance.now() - stopStarted;
    const sustainedMBps = stats.steadyMBps;
    const fullRate = sustainedMBps >= expectedMBps * 0.99;
    const pass = live && postStopExact && droppedConsistent && retentionBounded && pageErrors.length === 0 &&
      (options.requireFullRate !== true || fullRate) &&
      sustainedMBps >= (options.minSustainedMBps ?? 0) && sustainedMBps <= expectedMBps * 1.02 &&
      (options.minDrawHz === undefined || drawHz >= options.minDrawHz) &&
      (options.maxDrawHz === undefined || drawHz <= options.maxDrawHz);
    report = {
      channels,
      samplerate: options.samplerate,
      expectedMBps,
      seconds: options.seconds,
      elapsedMs,
      samples: beforeStop.samples,
      rawBytes: stats.rawBytes,
      transfers: stats.transfers,
      dropped: beforeStop.dropped,
      kept: beforeStop.kept,
      sustainedMBps,
      fullRate,
      requiresFullRate: options.requireFullRate === true,
      peakQueuedTransfers: stats.peakQueuedTransfers,
      slowTransfers: stats.slowTransfers,
      sinkMsP95: stats.sinkMsP95,
      maxIdleGapMs: stats.maxIdleGapMs,
      maxQuietMs,
      limit,
      draws,
      drawHz,
      scheduledHz,
      skipped: frameStats.skipped,
      statusRenders: frameStats.statusRenders,
      layers: frameStats.layers,
      frameCostMs,
      envCapped,
      rafCeilingMs,
      rafIdleMs,
      dpr: env.dpr,
      gpu: env.gpu,
      maxKept,
      maxChunkSamples,
      droppedConsistent,
      retentionBounded,
      pageErrors,
      live,
      stopBuildMs,
      postStopExact,
      deviceLeak: false,
      pass,
      timeline,
    };
    return report;
  } finally {
    rafStop = true;
    try {
      if (timer !== null) clearInterval(timer);
      await pending;
      if (app.running || app.stopping) await app.debug.stop();
    } finally {
      restoreAppend?.();
      window.removeEventListener('error', onPageError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      app.discardDevice();
      if (report !== null) report.deviceLeak = app.device !== null;
    }
  }
}

export interface FixedWindowProbeOptions {
  channels: 8 | 16 | 32;
  samplerate: number;
  viewStartSeconds: number;
  viewEndSeconds: number;
  settleMs?: number;
}

export interface FixedWindowProbeResult {
  pageErrors: string[];
  deviceLeak: boolean;
  live: boolean;
  final: LiveFrameSnapshot;
}

export interface FixedWindowProbe {
  snapshot(): LiveFrameSnapshot;
  finish(): Promise<FixedWindowProbeResult>;
}

export async function startFixedWindowProbe(
  options: FixedWindowProbeOptions,
): Promise<FixedWindowProbe> {
  const app = window.slogicweb as unknown as AppProbe | undefined;
  if (!app) throw new Error('the App is not ready');
  app.discardDevice();
  const channels = options.channels;
  const bytesPerMs = options.samplerate * bytesPerSampleForChannels(channels) / 1000;
  const worker = new FakeUsbWorker({ name: String(bytesPerMs) });
  const dev = await WorkerSlogicDevice.open(
    { vendorId: 0x359f, productId: 0x3032, serial: 'clock' },
    { spawn: () => worker, openTimeoutMs: 5000 },
  ).catch((error: unknown) => {
    worker.terminate();
    throw error;
  });
  const pageErrors: string[] = [];
  const onPageError = (event: ErrorEvent): void => { pageErrors.push(event.message); };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    pageErrors.push(String(event.reason));
  };
  window.addEventListener('error', onPageError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  const startedAt = performance.now();
  let finished = false;
  try {
    app.installDevice(dev, app.deviceEpoch);
    for (let i = channels; i < app.channels.length; i++) app.debug.toggleChannel(i, false);
    if (app.busViews.length === 0) {
      app.debug.addBus({
        name: 'loop-probe',
        spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' },
        hideSources: true,
      });
    }
    app.debug.setSettings({
      mode: 'single',
      seconds: maxCaptureSeconds(options.samplerate),
      channels,
      samplerate: options.samplerate,
      testMode: 2,
      softwareTrigger: false,
    });
    await app.debug.start();
    await new Promise(resolve => setTimeout(resolve, options.settleMs ?? 400));
    app.debug.setViewportSeconds(options.viewStartSeconds, options.viewEndSeconds);
    await new Promise(resolve => setTimeout(resolve, 250));
    app.debug.resetFrameStats();
  } catch (error) {
    window.removeEventListener('error', onPageError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    app.discardDevice();
    throw error;
  }
  return {
    snapshot: () => liveFrameSnapshot(app, startedAt),
    finish: async () => {
      if (finished) throw new Error('the fixed-window probe was already finished');
      finished = true;
      const final = liveFrameSnapshot(app, startedAt);
      const live = app.running && app.statusError === null;
      try {
        await app.debug.stop();
      } finally {
        window.removeEventListener('error', onPageError);
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
        app.discardDevice();
      }
      return { pageErrors, deviceLeak: app.device !== null, live, final };
    },
  };
}
