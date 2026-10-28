// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The loop-window question, asked without a board: at each 8-channel rate, how large a
 * retained window can the page keep while it appends, drops and builds the live frame?
 * Same transport arms as windowHarness.ts; the sink mirrors the app's loop path
 * (append, loopDropSamples, dropFront - no hysteresis, no builder reset), and the
 * pump does the app's per-frame work (builder setLength + 4 ms slices + analogFrame)
 * for the heaviest view: a user zoomed out to the full retained window.
 *
 * Loaded as a module by the CDP driver (`loop-window-bench.mjs`); not imported by the app.
 */

import { Slogic16U3, type Stats } from '../slogic16u3.js';
import { WorkerSlogicDevice, type WorkerStats } from '../workerTransport.js';
import { ClockStreamDevice } from '../fakeUsb.js';
import {
  BusBuilder, createSampleStore,
  type BusSpec, type SampleStore,
} from '../../data/index.js';
import { loopDropSamples } from '../../ui/state.js';
import { analogFrame, type BusViewState } from '../../ui/busView.js';
import { bytesPerSampleForChannels } from '../../types.js';
import FakeUsbWorker from './fakeUsbWorker.js?worker&inline';

export type LoopConsumerWork = 'store' | 'builder' | 'display';
export type LoopPattern = 'zero' | 'counter16';

export interface LoopProgressSample {
  atMs: number;
  chunks: number;
  appendedBytes: number;
  droppedSamples: number;
  keptSamples: number;
  appendMsMax: number;
  dropMsMax: number;
  rafTicks: number;
  rafGapMs: number;
  ingestionQuietMs: number;
  dropQuietMs: number;
  builderProgress: number | null;
  builderDoneUpTo: number | null;
  rawBytes: number | null;
  sinkBytes: number | null;
  transfers: number | null;
  peakQueuedTransfers: number | null;
  shortTransfers: number | null;
  slowTransfers: number | null;
  maxIdleGapMs: number | null;
  sinkMsP95: number | null;
  rearmMsP95: number | null;
}

export interface LoopArmReport {
  transport: 'page' | 'worker';
  work: LoopConsumerWork;
  pattern: LoopPattern;
  channels: number;
  samplerate: number;
  retentionSamples: number;
  seconds: number;
  widthPx: number;
  /** False on control cells: append + dropFront only, no display work. */
  display: boolean;
  /** The drawn window's read path: exact up to 256 samples/pixel and 4 M samples. */
  path: 'exact' | 'pyramid';
  /** Set when the arm aborted: the watchdog firing is a result, not a harness failure. */
  error?: string;
  expectedMBps: number;
  sustainedMBps: number;
  droppedBytes: number;
  threadStallMaxMs: number;
  pageStallMaxMs: number;
  transfers: number;
  chunks: number;
  appendedBytes: number;
  appendMsP95: number;
  appendMsMax: number;
  ingestionQuietMsMax: number;
  dropQuietMsMax: number;
  stallCandidate: boolean;
  rafGapMaxMs: number;
  timeline: LoopProgressSample[];
  frames: number;
  /** Frames whose rightmost column was empty: the live edge was not covered. */
  liveEdgeBlankFrames: number;
  /** Mean filled fraction of the drawn window over all frames. */
  filledColumns: number;
  drops: number;
  /** Per-drop cost of dropFront alone, never amortized. */
  dropMsP95: number;
  dropMsMax: number;
  builderMsMax: number;
  /**
   * Drops that arrived while the bus builder had not yet covered the previous drop's
   * appended bins. With no drop hysteresis every delivery chunk drops, so at high
   * arrival rates this counts bus-view freshness lag (blank right-edge columns), not
   * a drop pathology - drops themselves carry no rebuild since W1/W3.
   */
  busBehindDrops: number;
  /** Longest completed drop-to-covered stretch; only finished catch-ups count. */
  busCatchUpMsMax: number;
  /** True when the last drop's catch-up was still open at stop. */
  busBehindAtStop: boolean;
  /** store.length point-in-time at stop, and the peak the window reached. */
  storeMB: number;
  peakStoreMB: number;
}

export interface LoopHarnessOptions {
  transport: 'page' | 'worker';
  samplerate: number;
  channels?: 8 | 16 | 32;
  retentionSamples: number;
  seconds: number;
  widthPx?: number;
  fifoBytes?: number;
  /** False isolates the append + dropFront path: no builder, no per-frame display work. */
  display?: boolean;
  work?: LoopConsumerWork;
  pattern?: LoopPattern;
  stallMs?: number;
}

const CHANNELS = 8;
const STALL_CANDIDATE_MS = 5000;
let counter16Block: Uint8Array | null = null;

function workOf(options: LoopHarnessOptions): LoopConsumerWork {
  return options.work ?? (options.display === false ? 'store' : 'display');
}

function fillCounter16(chunk: Uint8Array): void {
  if (counter16Block === null) {
    counter16Block = new Uint8Array(65536 * 2);
    const view = new DataView(counter16Block.buffer);
    for (let i = 0; i < 65536; i++) view.setUint16(i * 2, i, true);
  }
  for (let offset = 0; offset < chunk.length;) {
    const take = Math.min(counter16Block.length, chunk.length - offset);
    chunk.set(counter16Block.subarray(0, take), offset);
    offset += take;
  }
}

interface ConsumerState {
  store: SampleStore;
  sink: (chunk: Uint8Array) => void;
  sample: (stats: Stats | null) => void;
  stop: () => void;
  appendMs: number[];
  dropMs: number[];
  builderMsMax: number;
  drops: number;
  chunks: number;
  appendedBytes: number;
  ingestionQuietMsMax: number;
  dropQuietMsMax: number;
  rafGapMaxMs: number;
  timeline: LoopProgressSample[];
  frames: number;
  liveEdgeBlankFrames: number;
  filledSum: number;
  busBehindDrops: number;
  busCatchUpMsMax: number;
  busBehindAtStop: boolean;
  peakLength: number;
}

function startConsumer(options: LoopHarnessOptions): ConsumerState {
  const retention = options.retentionSamples;
  const widthPx = options.widthPx ?? 1600;
  const channels = options.channels ?? CHANNELS;
  const store = createSampleStore(channels, options.samplerate);
  const work = workOf(options);
  const pattern = options.pattern ?? 'zero';
  const spec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
  const builder = new BusBuilder(store, spec, 0, undefined, retention * 2);
  const bv: BusViewState = {
    id: 'bench', name: 'bench', spec, color: '#fff', fullScaleV: null, offsetV: 0,
    style: 'line', heightCss: 120, hideSources: false, builder, builtFor: store, cache: null,
  };
  const startedAt = performance.now();
  let lastChunkAt = 0;
  let lastDropAt = 0;
  let lastRafAt = startedAt;
  let appendMsMax = 0;
  let dropMsMax = 0;
  let rafTicks = 0;
  let caughtUp = true;
  let pumping = true;

  const state: ConsumerState = {
    store,
    appendMs: [], dropMs: [], builderMsMax: 0, drops: 0, chunks: 0, appendedBytes: 0,
    ingestionQuietMsMax: 0, dropQuietMsMax: 0, rafGapMaxMs: 0, timeline: [],
    frames: 0, liveEdgeBlankFrames: 0, filledSum: 0, busBehindDrops: 0,
    busCatchUpMsMax: 0, busBehindAtStop: false, peakLength: 0,
    sink(chunk: Uint8Array): void {
      if (pattern === 'counter16') fillCounter16(chunk);
      const appendStarted = performance.now();
      store.append(chunk);
      const appendMs = performance.now() - appendStarted;
      state.appendMs.push(appendMs);
      appendMsMax = Math.max(appendMsMax, appendMs);
      state.chunks++;
      state.appendedBytes += chunk.length;
      lastChunkAt = performance.now();
      state.peakLength = Math.max(state.peakLength, store.length);
      // The app's policy, imported rather than mirrored: no hysteresis, every delivery
      // drops the window back to the limit.
      const drop = loopDropSamples(store.length, retention);
      if (drop <= 0) return;
      const t = performance.now();
      store.dropFront(drop);
      const dropMs = performance.now() - t;
      // The app no longer resets bus builders on a drop: BusBuilder's frontier is
      // absolute and analogFrame's cache key carries store.droppedSamples.
      state.dropMs.push(dropMs);
      dropMsMax = Math.max(dropMsMax, dropMs);
      state.drops++;
      if (work !== 'store') {
        if (!caughtUp) state.busBehindDrops++;
        caughtUp = false;
      }
      lastDropAt = performance.now();
    },
    sample(stats: Stats | null): void {
      const now = performance.now();
      const ingestionQuietMs = lastChunkAt > 0 ? now - lastChunkAt : 0;
      const dropQuietMs = lastDropAt > 0 ? now - lastDropAt : 0;
      state.ingestionQuietMsMax = Math.max(state.ingestionQuietMsMax, ingestionQuietMs);
      state.dropQuietMsMax = Math.max(state.dropQuietMsMax, dropQuietMs);
      state.timeline.push({
        atMs: now - startedAt,
        chunks: state.chunks,
        appendedBytes: state.appendedBytes,
        droppedSamples: store.droppedSamples,
        keptSamples: store.length,
        appendMsMax,
        dropMsMax,
        rafTicks,
        rafGapMs: now - lastRafAt,
        ingestionQuietMs,
        dropQuietMs,
        builderProgress: work === 'store' ? null : builder.progress,
        builderDoneUpTo: work === 'store' ? null : builder.pyramid.doneUpTo,
        rawBytes: stats?.rawBytes ?? null,
        sinkBytes: stats?.sinkBytes ?? null,
        transfers: stats?.transfers ?? null,
        peakQueuedTransfers: stats?.peakQueuedTransfers ?? null,
        shortTransfers: stats?.shortTransfers ?? null,
        slowTransfers: stats?.slowTransfers ?? null,
        maxIdleGapMs: stats?.maxIdleGapMs ?? null,
        sinkMsP95: stats?.sinkMsP95 ?? null,
        rearmMsP95: stats?.rearmMsP95 ?? null,
      });
    },
    stop(): void {
      pumping = false;
      if (work !== 'store' && !caughtUp) state.busBehindAtStop = true;
    },
  };

  const pump = (): void => {
    if (!pumping) return;
    const now = performance.now();
    state.rafGapMaxMs = Math.max(state.rafGapMaxMs, now - lastRafAt);
    lastRafAt = now;
    rafTicks++;
    if (work !== 'store') {
      builder.setLength(store.length);
      const builderStarted = performance.now();
      builder.step(4);
      state.builderMsMax = Math.max(state.builderMsMax, performance.now() - builderStarted);
      if (!caughtUp && builder.pyramid.doneUpTo >= store.length) {
        caughtUp = true;
        state.busCatchUpMsMax = Math.max(state.busCatchUpMsMax, performance.now() - lastDropAt);
      }
    }
    if (work === 'display') {
      const end = store.length;
      const frame = analogFrame(store, bv, Math.max(0, end - retention), end, widthPx, true);
      state.frames++;
      if (frame.kind === 'columns') {
        let filled = 0;
        for (let c = 0; c < widthPx; c++) if (!Number.isNaN(frame.min[c]!)) filled++;
        state.filledSum += filled / widthPx;
        if (Number.isNaN(frame.min[widthPx - 1]!)) state.liveEdgeBlankFrames++;
      } else if (frame.kind === 'points') {
        state.filledSum += 1;
      } else {
        state.liveEdgeBlankFrames++;
      }
    }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
  return state;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function finish(
  transport: 'page' | 'worker', options: LoopHarnessOptions, consumer: ConsumerState,
  stats: Stats, pageStallMaxMs: number, droppedBytes: number, error: string | undefined,
): LoopArmReport {
  const retention = options.retentionSamples;
  const widthPx = options.widthPx ?? 1600;
  const channels = options.channels ?? CHANNELS;
  const work = workOf(options);
  return {
    transport,
    work,
    pattern: options.pattern ?? 'zero',
    display: work !== 'store',
    channels,
    samplerate: options.samplerate,
    retentionSamples: retention,
    seconds: options.seconds,
    widthPx,
    path: retention / widthPx > 256 || retention > 4_000_000 ? 'pyramid' : 'exact',
    ...(error === undefined ? {} : { error }),
    // Offered wire bytes, not samples: the driver gates on sustainedMBps / expectedMBps,
    // so a 32-channel cell must divide by its 4 bytes per sample or it can never fail.
    expectedMBps: (options.samplerate * bytesPerSampleForChannels(channels)) / 1e6,
    sustainedMBps: stats.steadyMBps,
    droppedBytes,
    threadStallMaxMs: stats.threadStallMaxMs,
    pageStallMaxMs,
    transfers: stats.transfers,
    chunks: consumer.chunks,
    appendedBytes: consumer.appendedBytes,
    appendMsP95: percentile(consumer.appendMs, 0.95),
    appendMsMax: percentile(consumer.appendMs, 1),
    ingestionQuietMsMax: consumer.ingestionQuietMsMax,
    dropQuietMsMax: consumer.dropQuietMsMax,
    stallCandidate: consumer.ingestionQuietMsMax >= (options.stallMs ?? STALL_CANDIDATE_MS),
    rafGapMaxMs: consumer.rafGapMaxMs,
    timeline: consumer.timeline,
    frames: consumer.frames,
    liveEdgeBlankFrames: consumer.liveEdgeBlankFrames,
    filledColumns: consumer.frames ? consumer.filledSum / consumer.frames : 0,
    drops: consumer.drops,
    dropMsP95: percentile(consumer.dropMs, 0.95),
    dropMsMax: percentile(consumer.dropMs, 1),
    builderMsMax: consumer.builderMsMax,
    busBehindDrops: consumer.busBehindDrops,
    busCatchUpMsMax: consumer.busCatchUpMsMax,
    busBehindAtStop: consumer.busBehindAtStop,
    storeMB: consumer.store.length / 1e6,
    peakStoreMB: consumer.peakLength / 1e6,
  };
}

export async function runLoopArm(options: LoopHarnessOptions): Promise<LoopArmReport> {
  const channels = options.channels ?? CHANNELS;
  // The scripted device offers wire bytes: samples x bytesPerSample per second.
  const bytesPerMs = (options.samplerate * bytesPerSampleForChannels(channels)) / 1000;
  const cfg = { channels, samplerate: options.samplerate, thresholdVolts: 1.6 } as const;
  const consumer = startConsumer(options);
  let error: string | undefined;

  const capture = async (dev: Slogic16U3 | WorkerSlogicDevice): Promise<void> => {
    await dev.start(cfg, consumer.sink, undefined, { loop: true });
    consumer.sample(null);
    let pending: Promise<void> | null = null;
    const poll = (): void => {
      if (pending !== null) return;
      pending = (async () => consumer.sample(await dev.getStats()))()
        .catch((e: unknown) => { error ??= String(e); })
        .finally(() => { pending = null; });
    };
    const timer = setInterval(poll, 1000);
    try {
      await new Promise((r) => setTimeout(r, options.seconds * 1000));
    } finally {
      clearInterval(timer);
      await pending;
    }
    consumer.sample(await dev.getStats());
  };

  if (options.transport === 'page') {
    const device = new ClockStreamDevice(bytesPerMs, options.fifoBytes ?? 262_144);
    const dev = new Slogic16U3(device as unknown as USBDevice);
    try {
      await dev.open();
      await capture(dev);
      await dev.stop();
    } catch (e) {
      error = String(e);
    }
    consumer.stop();
    device.release();
    const stats = dev.getStats();
    return finish('page', options, consumer, stats, stats.threadStallMaxMs, device.droppedBytes, error);
  }

  const worker = new FakeUsbWorker({ name: String(bytesPerMs) });
  const probe = { dropped: 0 };
  worker.addEventListener('message', (event: MessageEvent<{ kind?: string; droppedBytes?: number }>) => {
    if (event.data?.kind !== 'harness-report') return;
    probe.dropped = event.data.droppedBytes ?? 0;
  });
  let dev: WorkerSlogicDevice;
  try {
    dev = await WorkerSlogicDevice.open(
      { vendorId: 0x359f, productId: 0x3032, serial: 'clock' },
      { spawn: () => worker, openTimeoutMs: 5000 },
    );
  } catch (e) {
    consumer.stop();
    worker.terminate();
    throw e;
  }
  try {
    await capture(dev);
    await dev.stop();
  } catch (e) {
    error = String(e);
  }
  consumer.stop();
  worker.postMessage({ kind: 'harness-report' });
  await new Promise((r) => setTimeout(r, 50));
  const stats: WorkerStats = await dev.getStats();
  worker.terminate();
  return finish('worker', options, consumer, stats, stats.pageStallMaxMs, probe.dropped, error);
}
