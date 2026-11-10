// SPDX-License-Identifier: GPL-3.0-or-later

import { Canvas2dRenderer, WaveformRenderer } from '../../render/index.js';
import type { FrameStats } from '../../render/index.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../../types.js';
import type { FrameStatsSnapshot, FrameLayer } from '../../ui/frameStats.js';
import {
  blankCanvasFrames, brightnessOutliers, type BlankCanvasHit, type CanvasSample,
} from '../../ui/frameFlicker.js';
import type { App } from '../../ui/app.js';
import { maxCaptureSeconds } from '../../ui/captureTime.js';
import type { CaptureSettings } from '../../ui/state.js';
import { WorkerSlogicDevice } from '../workerTransport.js';
import type { Device } from '../types.js';
import { getGrantedDevicesOnBestThread } from '../index.js';
import { fillCounter16 } from './loopWindowHarness.js';
import FakeUsbWorker from './fakeUsbWorker.js?worker&inline';

const CANVAS_SELECTORS: readonly string[] = [
  '.wave-canvas', '.grid-canvas', '.overlay-canvas', '#axis', '#overview',
];

const CANVAS_LAYERS: Record<string, readonly FrameLayer[]> = {
  '.wave-canvas': ['wave'],
  '.grid-canvas': ['overlay'],
  '.overlay-canvas': ['overlay', 'bus'],
  '#axis': ['axis'],
  '#overview': ['overview'],
};

const SNAPSHOT_SCALE = 0.1;
const COMPOSITE_SAMPLE_WIDTH = 256;
const COMPOSITE_BRIGHT_LUMA = 160;
const PRIME_SETTLE_MS = 250;
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 30_000;
const HASH_STRIDE = 4;
const IDLE_CANVAS_SAMPLE_MS = 50;
const IDLE_CHANGE_LIMIT = 20;
const IDLE_DRAIN_MS = 15_000;
const IDLE_QUIET_MS = 600;
const IDLE_READING_LIMIT = 20_000;
const IDLE_QUIESCE_MS = 400;
const IDLE_QUIESCE_LIMIT_MS = 30_000;
const IDLE_STIMULUS_MS = 66;
const IDLE_STIMULUS_SIZE = 2;
const IDLE_STIMULUS_COLORS: readonly string[] = ['#101010', '#e6e6e6'];

export interface FlickerCanvasFrame {
  atMs: number;
  canvases: Record<string, CanvasSample>;
}

export interface FlickerRenderRecord {
  atMs: number;
  dataBins: number;
  storeLength: number;
  viewStart: number;
  viewEnd: number;
  follow: boolean;
}

export interface FlickerLayerDelta {
  draws: number;
  skips: number;
}

export interface FlickerProbeOptions {
  mode: 'single' | 'loop';
  seconds: number;
  channels?: ChannelCount;
  samplerate?: number;
  loopSamples?: number;
  primeSeconds?: number;
  maxFrames?: number;
}

export interface FlickerProbeReport {
  mode: 'single' | 'loop';
  channels: ChannelCount;
  samplerate: number;
  loopWindowSamples: number;
  startDisplayedSamples: number;
  seconds: number;
  primeSeconds: number;
  elapsedMs: number;
  wallStartMs: number;
  captureStartedAtMs: number;
  captureStoppedAtMs: number;
  live: boolean;
  samples: number;
  storeLength: number;
  drawn: number;
  skipped: number;
  drawnHz: number;
  layers: Record<string, FlickerLayerDelta>;
  frameStatsBefore: FrameStatsSnapshot;
  frameStatsAfter: FrameStatsSnapshot;
  blankFrames: number;
  blankHits: BlankCanvasHit[];
  paintedCanvases: string[];
  noDataRenders: number;
  noDataRendersAfterStart: number;
  noDataEmptyRenders: number;
  noDataEmptyRendersAfterStart: number;
  hintToggles: number;
  hintVisibleMs: number;
  canvasNames: string[];
  canvasFrames: FlickerCanvasFrame[];
  renders: FlickerRenderRecord[];
  pageErrors: string[];
  deviceLeak: boolean;
  deviceRestored: boolean;
  previousDeviceSerial: string | null;
}

export interface CompositeFrameReading {
  mean: number;
  bright: number;
  width: number;
  height: number;
}

export interface IdleFlickerProbeOptions {
  seconds: number;
  primeSeconds?: number;
  forcePrime?: boolean;
  channels?: ChannelCount;
  samplerate?: number;
}

export interface IdlePresentedFrame {
  atMs: number;
  mean: number;
}

export interface IdlePresentedOutlier {
  atMs: number;
  mean: number;
  ratio: number;
  index: number;
}

export interface IdleCanvasChange {
  atMs: number;
  canvas: string;
  from: string;
  to: string;
  fromMean: number;
  toMean: number;
  drawn: number;
  skipped: number;
}

export interface IdleFlickerProbeReport {
  seconds: number;
  primeSeconds: number;
  primed: boolean;
  wallStartMs: number;
  wallEndMs: number;
  frames: number;
  median: number;
  outliers: IdlePresentedOutlier[];
  drawnDuringIdle: number;
  skippedDuringIdle: number;
  statusRendersDuringIdle: number;
  paintsDuringIdle: number;
  layersDuringIdle: Record<string, FlickerLayerDelta>;
  settleMs: number;
  canvasChangeCount: number;
  waveChangeCount: number;
  waveReadableSamples: number;
  canvasChanges: IdleCanvasChange[];
  canvasNames: string[];
  waveCanvasNames: string[];
  readings: IdlePresentedFrame[];
  pumpTicks: number;
  stimulus: string;
  visibility: string;
  storeLength: number;
  running: boolean;
  live: boolean;
  frameStatsBefore: FrameStatsSnapshot;
  frameStatsAfter: FrameStatsSnapshot;
  pageErrors: string[];
  deviceLeak: boolean;
  deviceRestored: boolean;
  previousDeviceSerial: string | null;
}

interface RenderLike {
  store: { length: number };
  view: { start: number; end: number };
  follow: boolean;
  render(): FrameStats;
}

type RenderTarget = { render(this: RenderLike): FrameStats };

interface FlickerAppProbe {
  device: Device | null;
  deviceEpoch: number;
  running: boolean;
  stopping: boolean;
  statusError: unknown;
  store: { channelCount: number; samplerate: number; length: number };
  channels: readonly { enabled: boolean }[];
  debug: App['debug'];
  settings: CaptureSettings;
  installDevice(device: Device, epoch: number): boolean;
  discardDevice(): number;
  progressView(): { samples: number; dropped: number; kept: number; limit: number };
}

let renderRecorder: ((record: FlickerRenderRecord) => void) | null = null;
let restoreRenderPatch: (() => void) | null = null;

function installRenderRecorder(): void {
  if (restoreRenderPatch !== null) return;
  const undos: Array<() => void> = [];
  for (const proto of [WaveformRenderer.prototype, Canvas2dRenderer.prototype]) {
    const target = proto as unknown as RenderTarget;
    const original = target.render;
    target.render = function (this: RenderLike): FrameStats {
      const stats = original.call(this);
      renderRecorder?.({
        atMs: Date.now(),
        dataBins: stats.dataBins,
        storeLength: this.store.length,
        viewStart: this.view.start,
        viewEnd: this.view.end,
        follow: this.follow,
      });
      return stats;
    };
    undos.push(() => { target.render = original; });
  }
  const restore = (): void => {
    for (const undo of undos) undo();
    renderRecorder = null;
    restoreRenderPatch = null;
  };
  restoreRenderPatch = restore;
}

function canvasGrabber(scale: number): (canvas: HTMLCanvasElement) => CanvasSample | null {
  const surface = document.createElement('canvas');
  const ctx = surface.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('the flicker probe needs a 2d context');
  return (canvas: HTMLCanvasElement): CanvasSample | null => {
    if (canvas.width === 0 || canvas.height === 0) return null;
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    if (surface.width !== width || surface.height !== height) {
      surface.width = width;
      surface.height = height;
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    ctx.drawImage(canvas, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let luma = 0;
    let alpha = 0;
    let hash = 2166136261;
    const count = width * height;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      luma += (red + green + blue) / 3;
      alpha += pixels[index + 3]!;
      if ((index & (HASH_STRIDE - 1)) === 0) {
        hash = Math.imul(hash ^ (red | (green << 8) | (blue << 16) | (pixels[index + 3]! << 24)), 16777619);
      }
    }
    return {
      mean: luma / count,
      alpha: alpha / count / 255,
      hash: (hash >>> 0).toString(16),
    };
  };
}

async function restorePreviousDevice(
  app: FlickerAppProbe, serial: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const devices = await getGrantedDevicesOnBestThread();
      const match = devices.find((device) => device.serial === serial) ?? null;
      for (const device of devices) if (device !== match) device.terminate();
      if (match !== null) return app.installDevice(match, app.deviceEpoch);
    } catch {
      console.warn('[flicker] the previous device could not be re-opened yet');
    }
    await wait(300);
  }
  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

function layerDelta(
  before: FrameStatsSnapshot, after: FrameStatsSnapshot,
): Record<string, FlickerLayerDelta> {
  const out: Record<string, FlickerLayerDelta> = {};
  for (const name of Object.keys(after.layers) as Array<keyof typeof after.layers>) {
    out[name] = {
      draws: after.layers[name].draws - before.layers[name].draws,
      skips: after.layers[name].skips - before.layers[name].skips,
    };
  }
  return out;
}

function paintTally(stats: FrameStatsSnapshot): number {
  let total = stats.drawn + stats.skipped + stats.statusRenders;
  for (const name of Object.keys(stats.layers) as Array<keyof typeof stats.layers>) {
    total += stats.layers[name].draws + stats.layers[name].skips;
  }
  return total;
}

async function openScriptedDevice(channels: ChannelCount, samplerate: number): Promise<Device> {
  const bytesPerMs = samplerate * bytesPerSampleForChannels(channels) / 1000;
  const worker = new FakeUsbWorker({ name: String(bytesPerMs) });
  const dev = await WorkerSlogicDevice.open(
    { vendorId: 0x359f, productId: 0x3032, serial: 'clock' },
    { spawn: () => worker, openTimeoutMs: 5000 },
  ).catch((error: unknown) => {
    worker.terminate();
    throw error;
  });
  const originalStart = dev.start.bind(dev);
  dev.start = (cfg, sink, onDropout, startOptions) => originalStart(cfg, async (chunk) => {
    fillCounter16(chunk);
    await sink(chunk);
  }, onDropout, startOptions);
  return dev;
}

export async function runFlickerProbe(options: FlickerProbeOptions): Promise<FlickerProbeReport> {
  const app = window.slogicweb as unknown as FlickerAppProbe | undefined;
  if (!app) throw new Error('the App is not ready');
  const mode = options.mode;
  const channels = options.channels ?? 32;
  const samplerate = options.samplerate ?? 80e6;
  const seconds = options.seconds;
  const primeSeconds = Math.max(0, options.primeSeconds ?? 0);
  if (!(seconds > 0)) throw new Error('the flicker probe needs a positive --seconds');
  const wantedLoopSamples = options.loopSamples ?? 2_000_000;
  const maxFrames = options.maxFrames ?? Math.ceil((seconds + primeSeconds + 2) * 120);
  const hint = document.getElementById('empty-hint');

  const previousDevice = app.device;
  const previousSerial = previousDevice === null ? null : previousDevice.serial;
  const previousSettings: CaptureSettings = { ...app.settings };
  const previousEnabled = app.channels.map((channel) => channel.enabled);
  app.discardDevice();
  const dev = await openScriptedDevice(channels, samplerate);

  const pageErrors: string[] = [];
  const onPageError = (event: ErrorEvent): void => { pageErrors.push(event.message); };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    pageErrors.push(String(event.reason));
  };
  window.addEventListener('error', onPageError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  const canvasFrames: FlickerCanvasFrame[] = [];
  const renders: FlickerRenderRecord[] = [];
  let frameLoop = false;
  let captureStartedAtMs = 0;
  let captureStoppedAtMs = 0;
  let startedAt = Date.now();
  let hintToggles = 0;
  let hintVisibleMs = 0;
  let report: FlickerProbeReport | null = null;
  let deviceRestored = false;

  try {
    app.installDevice(dev, app.deviceEpoch);
    for (let index = channels; index < app.channels.length; index++) {
      app.debug.toggleChannel(index, false);
    }
    app.debug.setSettings({
      mode,
      channels,
      samplerate,
      testMode: 2,
      softwareTrigger: false,
      ...(mode === 'loop' ? { loopSamples: wantedLoopSamples } : {}),
    });
    if (mode === 'loop' && app.settings.loopSamples !== wantedLoopSamples) {
      app.debug.setSettings({ loopSamples: wantedLoopSamples });
    }
    if (mode === 'single') app.debug.setSettings({ seconds: maxCaptureSeconds(samplerate) });

    if (primeSeconds > 0) {
      await withTimeout(app.debug.start(), START_TIMEOUT_MS, 'the prime capture did not start');
      await wait(primeSeconds * 1000);
      await withTimeout(app.debug.stop(), STOP_TIMEOUT_MS, 'the prime capture did not stop');
      await wait(PRIME_SETTLE_MS);
    }

    startedAt = Date.now();
    const grab = canvasGrabber(SNAPSHOT_SCALE);
    const names: string[] = [];
    let lastSampleAt = startedAt;
    let lastDraws: Record<FrameLayer, number> | null = null;
    let hintShown = hint !== null && hint.style.display !== 'none';
    let sawLive = false;
    frameLoop = true;
    const sampleFrame = (): void => {
      if (!frameLoop) return;
      const now = Date.now();
      if (app.running) sawLive = true;
      const frame: FlickerCanvasFrame = { atMs: now - startedAt, canvases: {} };
      const stats = app.debug.frameStats();
      const drew = new Set<string>();
      for (const selector of CANVAS_SELECTORS) {
        const owners = CANVAS_LAYERS[selector] ?? [];
        if (owners.some((layer) => lastDraws === null || lastDraws[layer] !== stats.layers[layer].draws)) {
          drew.add(selector);
        }
      }
      for (const selector of CANVAS_SELECTORS) {
        const list = document.querySelectorAll<HTMLCanvasElement>(selector);
        for (let index = 0; index < list.length; index++) {
          const canvas = list[index]!;
          const sample = grab(canvas);
          if (sample === null) continue;
          if (!drew.has(selector)) sample.stale = true;
          const name = `${selector}[${index}]`;
          if (!names.includes(name)) names.push(name);
          frame.canvases[name] = sample;
        }
      }
      lastDraws = {
        wave: stats.layers.wave.draws,
        axis: stats.layers.axis.draws,
        overlay: stats.layers.overlay.draws,
        bus: stats.layers.bus.draws,
        overview: stats.layers.overview.draws,
      };
      if (canvasFrames.length < maxFrames) canvasFrames.push(frame);
      const shown = hint !== null && hint.style.display !== 'none';
      if (shown !== hintShown) {
        hintToggles += 1;
        hintShown = shown;
      }
      if (hintShown) hintVisibleMs += now - lastSampleAt;
      lastSampleAt = now;
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
    installRenderRecorder();
    renderRecorder = (record: FlickerRenderRecord): void => {
      if (renders.length >= maxFrames * 4) return;
      renders.push({ ...record, atMs: record.atMs - startedAt });
    };

    app.debug.resetFrameStats();
    const frameStatsBefore = app.debug.frameStats();
    const startDisplayedSamples = app.store.length;
    captureStartedAtMs = Date.now() - startedAt;
    await withTimeout(app.debug.start(), START_TIMEOUT_MS, 'the measured capture did not start');
    await wait(seconds * 1000);
    captureStoppedAtMs = Date.now() - startedAt;
    const live = sawLive && app.statusError === null;
    const frameStatsAfter = app.debug.frameStats();
    const progress = app.progressView();
    const storeLength = app.store.length;
    frameLoop = false;
    restoreRenderPatch?.();
    await withTimeout(app.debug.stop(), STOP_TIMEOUT_MS, 'the measured capture did not stop');

    const elapsedMs = captureStoppedAtMs - captureStartedAtMs;
    const blank = blankCanvasFrames(canvasFrames);
    const noData = renders.filter((record) => record.dataBins === 0);
    const noDataEmpty = noData.filter((record) => record.storeLength === 0);
    const loopWindowSamples = app.settings.loopSamples;
    report = {
      mode,
      channels,
      samplerate,
      loopWindowSamples,
      startDisplayedSamples,
      seconds,
      primeSeconds,
      elapsedMs,
      wallStartMs: startedAt,
      captureStartedAtMs,
      captureStoppedAtMs,
      live,
      samples: progress.samples,
      storeLength,
      drawn: frameStatsAfter.drawn - frameStatsBefore.drawn,
      skipped: frameStatsAfter.skipped - frameStatsBefore.skipped,
      drawnHz: elapsedMs > 0
        ? (frameStatsAfter.drawn - frameStatsBefore.drawn) * 1000 / elapsedMs : 0,
      layers: layerDelta(frameStatsBefore, frameStatsAfter),
      frameStatsBefore,
      frameStatsAfter,
      blankFrames: blank.hits.length,
      blankHits: blank.hits,
      paintedCanvases: blank.painted,
      noDataRenders: noData.length,
      noDataRendersAfterStart:
        noData.filter((record) => record.atMs >= captureStartedAtMs).length,
      noDataEmptyRenders: noDataEmpty.length,
      noDataEmptyRendersAfterStart:
        noDataEmpty.filter((record) => record.atMs >= captureStartedAtMs).length,
      hintToggles,
      hintVisibleMs,
      canvasNames: names,
      canvasFrames,
      renders,
      pageErrors,
      deviceLeak: false,
      deviceRestored: false,
      previousDeviceSerial: previousSerial,
    };
    return report;
  } finally {
    frameLoop = false;
    restoreRenderPatch?.();
    try {
      if (app.running || app.stopping) {
        await withTimeout(app.debug.stop(), STOP_TIMEOUT_MS, 'the capture did not stop');
      }
    } finally {
      window.removeEventListener('error', onPageError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      app.discardDevice();
      if (report !== null) report.deviceLeak = app.device !== null;
      app.debug.setSettings(previousSettings);
      const enabled = app.channels.map((channel) => channel.enabled);
      for (let index = 0; index < enabled.length; index++) {
        if (enabled[index] !== previousEnabled[index]) {
          app.debug.toggleChannel(index, previousEnabled[index] === true);
        }
      }
      deviceRestored = previousSerial === null
        ? false
        : await restorePreviousDevice(app, previousSerial);
      if (report !== null) report.deviceRestored = deviceRestored;
    }
  }
}

let idleSink: ((mean: number, atMs: number) => void) | null = null;

const IDLE_STIMULUS_ID = '__flicker-idle-stimulus';

function idleStimulusSpot(): { left: number; top: number } | null {
  const plot = document.getElementById('plot');
  const rect = plot === null ? null : plot.getBoundingClientRect();
  const size = IDLE_STIMULUS_SIZE;
  const candidates = [
    { left: 0, top: 0 },
    { left: Math.max(0, window.innerWidth - size), top: 0 },
    { left: 0, top: Math.max(0, window.innerHeight - size) },
    {
      left: Math.max(0, window.innerWidth - size),
      top: Math.max(0, window.innerHeight - size),
    },
  ];
  const free = candidates.find((spot) => rect === null
    || spot.left + size <= rect.left || spot.left >= rect.right
    || spot.top + size <= rect.top || spot.top >= rect.bottom);
  return free ?? null;
}

interface IdleStimulus {
  remove(): void;
  ticks(): number;
  spot: string;
}

function installIdleStimulus(): IdleStimulus | null {
  const spot = idleStimulusSpot();
  if (spot === null) return null;
  const el = document.createElement('div');
  el.id = IDLE_STIMULUS_ID;
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText = 'position:fixed;width:2px;height:2px;margin:0;padding:0;' +
    'pointer-events:none;z-index:2147483647';
  el.style.left = `${spot.left}px`;
  el.style.top = `${spot.top}px`;
  el.style.background = IDLE_STIMULUS_COLORS[0]!;
  document.body.appendChild(el);
  let running = true;
  let ticks = 0;
  let lastTickAt = 0;
  const tick = (): void => {
    if (!running) return;
    const now = Date.now();
    if (now - lastTickAt >= IDLE_STIMULUS_MS) {
      lastTickAt = now;
      ticks += 1;
      el.style.background = IDLE_STIMULUS_COLORS[ticks % 2]!;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    remove: () => { running = false; el.remove(); },
    ticks: () => ticks,
    spot: `${spot.left},${spot.top}`,
  };
}

async function quiescePaints(app: FlickerAppProbe): Promise<number> {
  const startedAt = Date.now();
  const limit = startedAt + IDLE_QUIESCE_LIMIT_MS;
  const first = paintTally(app.debug.frameStats());
  let last = first;
  let quietSince = startedAt;
  for (;;) {
    await wait(100);
    const now = paintTally(app.debug.frameStats());
    if (now !== last) {
      last = now;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= IDLE_QUIESCE_MS) {
      return Date.now() - startedAt;
    }
    if (Date.now() >= limit) {
      throw new Error(`the app never stopped painting before the idle window: ` +
        `${now - first} paints in ${Date.now() - startedAt} ms`);
    }
  }
}

let idleWindowState: { startMs: number; endMs: number | null } | null = null;

export function idleMeasurementWindow(): { startMs: number; endMs: number | null } | null {
  return idleWindowState === null ? null : { ...idleWindowState };
}

export function pushIdlePresentedFrame(mean: number, atMs: number): boolean {
  if (idleSink === null || !Number.isFinite(mean)) return false;
  idleSink(mean, atMs);
  return true;
}

async function drainIdlePresentations(readings: readonly IdlePresentedFrame[]): Promise<void> {
  let seen = readings.length;
  let quietSince = Date.now();
  const deadline = Date.now() + IDLE_DRAIN_MS;
  for (;;) {
    await wait(200);
    if (readings.length !== seen) {
      seen = readings.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= IDLE_QUIET_MS) {
      return;
    }
    if (Date.now() >= deadline) return;
  }
}

export async function runIdleFlickerProbe(
  options: IdleFlickerProbeOptions,
): Promise<IdleFlickerProbeReport> {
  const app = window.slogicweb as unknown as FlickerAppProbe | undefined;
  if (!app) throw new Error('the App is not ready');
  const seconds = options.seconds;
  if (!(seconds > 0)) throw new Error('the idle flicker probe needs a positive --idle');
  const channels = options.channels ?? 32;
  const samplerate = options.samplerate ?? 80e6;
  const primeSeconds = Math.max(0, options.primeSeconds ?? 2);

  const previousSerial = app.device === null ? null : app.device.serial;
  const previousSettings: CaptureSettings = { ...app.settings };
  const previousEnabled = app.channels.map((channel) => channel.enabled);
  idleWindowState = null;

  const pageErrors: string[] = [];
  const onPageError = (event: ErrorEvent): void => { pageErrors.push(event.message); };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    pageErrors.push(String(event.reason));
  };
  window.addEventListener('error', onPageError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);

  const readings: IdlePresentedFrame[] = [];
  const canvasChanges: IdleCanvasChange[] = [];
  const canvasNames: string[] = [];
  let canvasChangeCount = 0;
  let waveChangeCount = 0;
  let waveReadableSamples = 0;
  let sampling = false;
  let primed = false;
  let stimulus: IdleStimulus | null = null;
  let report: IdleFlickerProbeReport | null = null;

  try {
    if (app.running || app.stopping) {
      await withTimeout(app.debug.stop(), STOP_TIMEOUT_MS, 'the running capture did not stop');
      await wait(PRIME_SETTLE_MS);
    }
    if (app.store.length === 0 || options.forcePrime === true) {
      primed = true;
      app.discardDevice();
      const dev = await openScriptedDevice(channels, samplerate);
      app.installDevice(dev, app.deviceEpoch);
      for (let index = channels; index < app.channels.length; index++) {
        app.debug.toggleChannel(index, false);
      }
      app.debug.setSettings({
        mode: 'single',
        channels,
        samplerate,
        testMode: 2,
        softwareTrigger: false,
      });
      app.debug.setSettings({ seconds: maxCaptureSeconds(samplerate) });
      await withTimeout(app.debug.start(), START_TIMEOUT_MS, 'the idle prime capture did not start');
      await wait(primeSeconds * 1000);
      await withTimeout(app.debug.stop(), STOP_TIMEOUT_MS, 'the idle prime capture did not stop');
      await wait(PRIME_SETTLE_MS);
    }

    app.debug.resetFrameStats();
    const settleMs = await quiescePaints(app);
    const frameStatsBefore = app.debug.frameStats();
    const storeLength = app.store.length;

    const grab = canvasGrabber(SNAPSHOT_SCALE);
    const hashes: Record<string, CanvasSample> = {};
    const waveCanvasNames: string[] = [];
    const sampleCanvases = (atMs: number): void => {
      for (const selector of CANVAS_SELECTORS) {
        const list = document.querySelectorAll<HTMLCanvasElement>(selector);
        for (let index = 0; index < list.length; index++) {
          const sample = grab(list[index]!);
          if (sample === null) continue;
          const name = `${selector}[${index}]`;
          if (!canvasNames.includes(name)) canvasNames.push(name);
          if (selector === '.wave-canvas' && !waveCanvasNames.includes(name)) {
            waveCanvasNames.push(name);
          }
          const previous = hashes[name];
          hashes[name] = sample;
          if (selector === '.wave-canvas' && sample.mean > 0) waveReadableSamples += 1;
          if (previous === undefined || previous.hash === sample.hash) continue;
          canvasChangeCount += 1;
          if (selector === '.wave-canvas') waveChangeCount += 1;
          if (canvasChanges.length < IDLE_CHANGE_LIMIT) {
            const stats = app.debug.frameStats();
            canvasChanges.push({
              atMs,
              canvas: name,
              from: previous.hash,
              to: sample.hash,
              fromMean: previous.mean,
              toMean: sample.mean,
              drawn: stats.drawn,
              skipped: stats.skipped,
            });
          }
        }
      }
    };

    const stimulusProbe = installIdleStimulus();
    if (stimulusProbe === null) {
      throw new Error('the idle probe found no viewport corner outside the measured plot');
    }
    stimulus = stimulusProbe;
    sampleCanvases(Date.now());
    const wallStartMs = Date.now();
    idleWindowState = { startMs: wallStartMs, endMs: null };
    idleSink = (mean, atMs) => {
      if (readings.length >= IDLE_READING_LIMIT) return;
      readings.push({ atMs, mean });
    };
    sampling = true;
    let lastSampleAt = wallStartMs;
    const sampleFrame = (): void => {
      if (!sampling) return;
      const now = Date.now();
      if (now - lastSampleAt >= IDLE_CANVAS_SAMPLE_MS) {
        lastSampleAt = now;
        sampleCanvases(now);
      }
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);

    await wait(seconds * 1000);
    const wallEndMs = Date.now();
    idleWindowState = { startMs: wallStartMs, endMs: wallEndMs };
    sampling = false;
    const pumpTicks = stimulusProbe.ticks();
    stimulusProbe.remove();
    await drainIdlePresentations(readings);
    idleSink = null;

    const inWindow = readings.filter(
      (frame) => frame.atMs >= wallStartMs && frame.atMs <= wallEndMs,
    );
    const analysis = brightnessOutliers(inWindow.map((frame) => frame.mean));
    const frameStatsAfter = app.debug.frameStats();
    report = {
      seconds,
      primeSeconds,
      primed,
      wallStartMs,
      wallEndMs,
      frames: inWindow.length,
      median: analysis.median,
      outliers: analysis.outliers.map((hit) => ({
        atMs: inWindow[hit.frame]!.atMs,
        mean: hit.mean,
        ratio: hit.ratio,
        index: hit.frame,
      })),
      drawnDuringIdle: frameStatsAfter.drawn - frameStatsBefore.drawn,
      skippedDuringIdle: frameStatsAfter.skipped - frameStatsBefore.skipped,
      statusRendersDuringIdle: frameStatsAfter.statusRenders - frameStatsBefore.statusRenders,
      paintsDuringIdle: paintTally(frameStatsAfter) - paintTally(frameStatsBefore),
      layersDuringIdle: layerDelta(frameStatsBefore, frameStatsAfter),
      settleMs,
      canvasChangeCount,
      waveChangeCount,
      waveReadableSamples,
      canvasChanges,
      canvasNames,
      waveCanvasNames,
      readings: inWindow,
      pumpTicks,
      stimulus: stimulusProbe.spot,
      visibility: document.visibilityState,
      storeLength,
      running: app.running || app.stopping,
      live: app.statusError === null,
      frameStatsBefore,
      frameStatsAfter,
      pageErrors,
      deviceLeak: false,
      deviceRestored: false,
      previousDeviceSerial: previousSerial,
    };
    return report;
  } finally {
    sampling = false;
    idleSink = null;
    stimulus?.remove();
    stimulus = null;
    try {
      if (app.running || app.stopping) {
        await withTimeout(app.debug.stop(), STOP_TIMEOUT_MS, 'the capture did not stop');
      }
    } finally {
      window.removeEventListener('error', onPageError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      if (primed) {
        app.discardDevice();
        if (report !== null) report.deviceLeak = app.device !== null;
        app.debug.setSettings(previousSettings);
        const enabled = app.channels.map((channel) => channel.enabled);
        for (let index = 0; index < enabled.length; index++) {
          if (enabled[index] !== previousEnabled[index]) {
            app.debug.toggleChannel(index, previousEnabled[index] === true);
          }
        }
        const deviceRestored = previousSerial === null
          ? false
          : await restorePreviousDevice(app, previousSerial);
        if (report !== null) report.deviceRestored = deviceRestored;
      }
    }
  }
}

export async function decodeCompositedFrame(
  dataBase64: string, rect: { x: number; y: number; width: number; height: number },
): Promise<CompositeFrameReading> {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const imageScale = bitmap.width / Math.max(1, window.innerWidth);
  const sourceWidth = Math.max(1, Math.round(rect.width * imageScale));
  const sourceHeight = Math.max(1, Math.round(rect.height * imageScale));
  const sourceX = Math.min(Math.max(0, Math.round(rect.x * imageScale)), bitmap.width - 1);
  const sourceY = Math.min(Math.max(0, Math.round(rect.y * imageScale)), bitmap.height - 1);
  const width = Math.max(1, Math.min(sourceWidth, COMPOSITE_SAMPLE_WIDTH));
  const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  const ctx = surface.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('the flicker probe needs a 2d context');
  ctx.drawImage(bitmap, sourceX, sourceY,
    Math.min(sourceWidth, bitmap.width - sourceX), Math.min(sourceHeight, bitmap.height - sourceY),
    0, 0, width, height);
  bitmap.close();
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let luma = 0;
  let bright = 0;
  const count = width * height;
  for (let index = 0; index < pixels.length; index += 4) {
    const value = (pixels[index]! * 3 + pixels[index + 1]! * 6 + pixels[index + 2]!) / 10;
    luma += value;
    if (value > COMPOSITE_BRIGHT_LUMA) bright += 1;
  }
  return { mean: luma / count, bright: bright / count, width, height };
}
