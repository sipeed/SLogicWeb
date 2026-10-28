// SPDX-License-Identifier: GPL-3.0-or-later

import { WorkerSlogicDevice } from '../workerTransport.js';
import type { Device } from '../types.js';
import { bytesPerSampleForChannels } from '../../types.js';
import type { App } from '../../ui/app.js';
import { fillCounter16 } from './loopWindowHarness.js';
import FakeUsbWorker from './fakeUsbWorker.js?worker&inline';

interface ProbeProgress {
  samples: number;
  dropped: number;
  kept: number;
  limit: number;
}

interface ProbeBuilder {
  progress: number;
  done: boolean;
  pyramid: { doneUpTo: number };
}

interface AppProbe {
  device: Device | null;
  deviceEpoch: number;
  running: boolean;
  stopping: boolean;
  statusError: { what: string; detail: string } | null;
  droppedTotal: number;
  store: { channelCount: number; length: number; droppedSamples: number; append(chunk: Uint8Array): void };
  channels: readonly { enabled: boolean }[];
  busViews: { builder: ProbeBuilder | null }[];
  debug: App['debug'];
  draw(): void;
  installDevice(device: Device, epoch: number): void;
  discardDevice(): number;
  progressView(): ProbeProgress;
}

export interface AppLoopProbeOptions {
  samplerate: number;
  retentionSamples: number;
  seconds: number;
  stallMs?: number;
  minSustainedMBps?: number;
  minDrawHz?: number;
  maxDrawHz?: number;
  stopBuildTimeoutMs?: number;
}

export interface AppLoopSample {
  atMs: number;
  samples: number;
  rawBytes: number;
  dropped: number;
  kept: number;
  queued: number;
  steadyMBps: number;
  draws: number;
  running: boolean;
}

export interface AppLoopProbeReport {
  samplerate: number;
  seconds: number;
  elapsedMs: number;
  samples: number;
  rawBytes: number;
  transfers: number;
  dropped: number;
  kept: number;
  sustainedMBps: number;
  peakQueuedTransfers: number;
  slowTransfers: number;
  maxQuietMs: number;
  draws: number;
  drawHz: number;
  maxKept: number;
  maxChunkSamples: number;
  droppedConsistent: boolean;
  retentionBounded: boolean;
  pageErrors: string[];
  live: boolean;
  stopBuildMs: number;
  postStopExact: boolean;
  pass: boolean;
  timeline: AppLoopSample[];
}

export async function runAppLoopProbe(options: AppLoopProbeOptions): Promise<AppLoopProbeReport> {
  const app = window.logicweb as unknown as AppProbe | undefined;
  if (!app) throw new Error('the App is not ready');
  app.discardDevice();
  const bytesPerMs = options.samplerate * bytesPerSampleForChannels(16) / 1000;
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
    maxChunkSamples = Math.max(maxChunkSamples, chunk.byteLength / bytesPerSampleForChannels(16));
    await sink(chunk);
    maxKept = Math.max(maxKept, app.store.length);
  }, onDropout, startOptions);

  const originalDraw = app.draw;
  const drawTimes: number[] = [];
  let countDraws = false;
  const timeline: AppLoopSample[] = [];
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
      queued: stats.peakQueuedTransfers,
      steadyMBps: stats.steadyMBps,
      draws: drawTimes.length,
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
    for (let i = 16; i < app.channels.length; i++) app.debug.toggleChannel(i, false);
    if (app.busViews.length === 0) {
      app.debug.addBus({
        name: 'loop-probe',
        spec: { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' },
        hideSources: true,
      });
    }
    app.debug.setSettings({
      channels: 16,
      samplerate: options.samplerate,
      testMode: 2,
      loopSamples: options.retentionSamples,
      softwareTrigger: false,
    });
    app.draw = function(): void {
      if (countDraws) drawTimes.push(performance.now());
      originalDraw.call(this);
    };

    await app.debug.start();
    countDraws = true;
    const captureStore = app.store;
    const originalAppend = captureStore.append;
    captureStore.append = function(chunk: Uint8Array): void {
      originalAppend.call(this, chunk);
      maxKept = Math.max(maxKept, this.length);
    };
    restoreAppend = () => { captureStore.append = originalAppend; };
    const initial = app.progressView();
    if (initial.limit !== options.retentionSamples || app.store.channelCount !== 16) {
      throw new Error(`unexpected capture shape: channels=${app.store.channelCount} limit=${initial.limit}`);
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
    const drawHz = drawTimes.length * 1000 / elapsedMs;
    const droppedConsistent = appDroppedAtStop === storeDroppedAtStop;
    const retentionBounded = maxKept <= beforeStop.limit + maxChunkSamples + 63;
    const live = app.running && app.statusError === null && beforeStop.samples > 0 &&
      maxQuietMs < (options.stallMs ?? 5000);
    countDraws = false;
    await app.debug.stop();
    const stopStarted = performance.now();
    let postStopExact = false;
    while (performance.now() - stopStarted < (options.stopBuildTimeoutMs ?? 10_000)) {
      const stopped = app.progressView();
      postStopExact = app.busViews.length > 0 && app.busViews.every(b =>
        b.builder?.done === true && b.builder.pyramid.doneUpTo === stopped.kept);
      if (postStopExact) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const stopBuildMs = performance.now() - stopStarted;
    const sustainedMBps = stats.steadyMBps;
    const pass = live && postStopExact && droppedConsistent && retentionBounded && pageErrors.length === 0 &&
      sustainedMBps >= (options.minSustainedMBps ?? 0) &&
      (options.minDrawHz === undefined || drawHz >= options.minDrawHz) &&
      (options.maxDrawHz === undefined || drawHz <= options.maxDrawHz);
    return {
      samplerate: options.samplerate,
      seconds: options.seconds,
      elapsedMs,
      samples: beforeStop.samples,
      rawBytes: stats.rawBytes,
      transfers: stats.transfers,
      dropped: beforeStop.dropped,
      kept: beforeStop.kept,
      sustainedMBps,
      peakQueuedTransfers: stats.peakQueuedTransfers,
      slowTransfers: stats.slowTransfers,
      maxQuietMs,
      draws: drawTimes.length,
      drawHz,
      maxKept,
      maxChunkSamples,
      droppedConsistent,
      retentionBounded,
      pageErrors,
      live,
      stopBuildMs,
      postStopExact,
      pass,
      timeline,
    };
  } finally {
    countDraws = false;
    try {
      if (timer !== null) clearInterval(timer);
      await pending;
      if (app.running || app.stopping) await app.debug.stop();
    } finally {
      restoreAppend?.();
      app.draw = originalDraw;
      window.removeEventListener('error', onPageError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      app.discardDevice();
    }
  }
}
