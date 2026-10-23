// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The loop-window question, asked without a board: at each 8-channel rate, how large a
 * retained window can the page keep while it appends, drops, rebuilds the bus pyramid
 * and builds the live frame? Same transport arms as windowHarness.ts; the sink mirrors
 * the app's loop path (append, dropFront, builder reset, cache invalidation), and the
 * pump does the app's per-frame work (builder setLength + 4 ms slices + analogFrame)
 * for the heaviest view: a user zoomed out to the full retained window.
 *
 * Loaded as a module by the CDP driver (`loop-window-bench.mjs`); not imported by the app.
 */

import { Slogic16U3, type Stats } from '../slogic16u3.js';
import { WorkerSlogicDevice, type WorkerStats } from '../workerTransport.js';
import { ClockStreamDevice } from '../fakeUsb.js';
import {
  BusBuilder, DROP_FRONT_QUANTUM, createSampleStore,
  type BusSpec, type SampleStore,
} from '../../data/index.js';
import { analogFrame, type BusViewState } from '../../ui/busView.js';
import FakeUsbWorker from './fakeUsbWorker.js?worker&inline';

export interface LoopArmReport {
  transport: 'page' | 'worker';
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
  frames: number;
  /** Frames whose rightmost column was empty: the live edge was not covered. */
  liveEdgeBlankFrames: number;
  /** Mean filled fraction of the drawn window over all frames. */
  filledColumns: number;
  drops: number;
  /** Per-drop cost of dropFront + builder reset + cache invalidation, never amortized. */
  dropMsP95: number;
  dropMsMax: number;
  /** Drops whose rebuild had not re-covered the store when the next drop arrived. */
  rebuildMissedDrops: number;
  /** Longest completed drop-to-covered stretch; only finished rebuilds count. */
  rebuildMsMax: number;
  /** True when the last drop's rebuild was still open at stop (rebuildMsMax censored). */
  rebuildOpenAtStop: boolean;
  /** store.length point-in-time at stop, and the peak the hysteresis reached. */
  storeMB: number;
  peakStoreMB: number;
}

export interface LoopHarnessOptions {
  transport: 'page' | 'worker';
  /** 8-channel sample rate; the scripted device offers samplerate/1000 bytes per ms. */
  samplerate: number;
  retentionSamples: number;
  seconds: number;
  widthPx?: number;
  fifoBytes?: number;
  /** False isolates the append + dropFront path: no builder, no per-frame display work. */
  display?: boolean;
}

const CHANNELS = 8;

interface ConsumerState {
  store: SampleStore;
  sink: (chunk: Uint8Array) => void;
  stop: () => void;
  dropMs: number[];
  drops: number;
  frames: number;
  liveEdgeBlankFrames: number;
  filledSum: number;
  rebuildMissedDrops: number;
  rebuildMsMax: number;
  rebuildOpenAtStop: boolean;
  peakLength: number;
}

function startConsumer(options: LoopHarnessOptions): ConsumerState {
  const retention = options.retentionSamples;
  const widthPx = options.widthPx ?? 1600;
  const store = createSampleStore(CHANNELS, options.samplerate);
  const display = options.display !== false;
  const spec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
  const builder = new BusBuilder(store, spec, 0, undefined, retention * 2);
  const bv: BusViewState = {
    id: 'bench', name: 'bench', spec, color: '#fff', fullScaleV: null, offsetV: 0,
    style: 'line', heightCss: 120, hideSources: false, builder, builtFor: store, cache: null,
  };
  let lastDropAt = 0;
  let caughtUp = true;
  let pumping = true;

  const state: ConsumerState = {
    store,
    dropMs: [], drops: 0, frames: 0, liveEdgeBlankFrames: 0,
    filledSum: 0, rebuildMissedDrops: 0, rebuildMsMax: 0, rebuildOpenAtStop: false,
    peakLength: 0,
    sink(chunk: Uint8Array): void {
      store.append(chunk);
      state.peakLength = Math.max(state.peakLength, store.length);
      if (!(retention > 0) || store.length < retention * 2) return;
      const drop = Math.floor((store.length - retention) / DROP_FRONT_QUANTUM) * DROP_FRONT_QUANTUM;
      if (drop <= 0) return;
      const t = performance.now();
      store.dropFront(drop);
      if (display) {
        builder.reset(store.length);
        bv.cache = null;
      }
      state.dropMs.push(performance.now() - t);
      state.drops++;
      if (display) {
        if (!caughtUp) state.rebuildMissedDrops++;
        caughtUp = false;
      }
      lastDropAt = performance.now();
    },
    stop(): void {
      pumping = false;
      if (display && !caughtUp) state.rebuildOpenAtStop = true;
    },
  };

  const pump = (): void => {
    if (!pumping || !display) return;
    builder.setLength(store.length);
    builder.step(4);
    if (!caughtUp && builder.pyramid.doneUpTo >= store.length) {
      caughtUp = true;
      state.rebuildMsMax = Math.max(state.rebuildMsMax, performance.now() - lastDropAt);
    }
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
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
  return state;
}

function finish(
  transport: 'page' | 'worker', options: LoopHarnessOptions, consumer: ConsumerState,
  stats: Stats, pageStallMaxMs: number, droppedBytes: number, error: string | undefined,
): LoopArmReport {
  const sorted = [...consumer.dropMs].sort((a, b) => a - b);
  const retention = options.retentionSamples;
  const widthPx = options.widthPx ?? 1600;
  return {
    transport,
    display: options.display !== false,
    channels: CHANNELS,
    samplerate: options.samplerate,
    retentionSamples: retention,
    seconds: options.seconds,
    widthPx,
    path: retention / widthPx > 256 || retention > 4_000_000 ? 'pyramid' : 'exact',
    ...(error === undefined ? {} : { error }),
    expectedMBps: options.samplerate / 1e6,
    sustainedMBps: stats.steadyMBps,
    droppedBytes,
    threadStallMaxMs: stats.threadStallMaxMs,
    pageStallMaxMs,
    transfers: stats.transfers,
    frames: consumer.frames,
    liveEdgeBlankFrames: consumer.liveEdgeBlankFrames,
    filledColumns: consumer.frames ? consumer.filledSum / consumer.frames : 0,
    drops: consumer.drops,
    dropMsP95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : 0,
    dropMsMax: sorted.length ? sorted[sorted.length - 1]! : 0,
    rebuildMissedDrops: consumer.rebuildMissedDrops,
    rebuildMsMax: consumer.rebuildMsMax,
    rebuildOpenAtStop: consumer.rebuildOpenAtStop,
    storeMB: consumer.store.length / 1e6,
    peakStoreMB: consumer.peakLength / 1e6,
  };
}

export async function runLoopArm(options: LoopHarnessOptions): Promise<LoopArmReport> {
  const bytesPerMs = options.samplerate / 1000;
  const cfg = { channels: CHANNELS, samplerate: options.samplerate, thresholdVolts: 1.6 } as const;
  const consumer = startConsumer(options);
  let error: string | undefined;

  if (options.transport === 'page') {
    const device = new ClockStreamDevice(bytesPerMs, options.fifoBytes ?? 262_144);
    const dev = new Slogic16U3(device as unknown as USBDevice);
    try {
      await dev.open();
      await dev.start(cfg, consumer.sink);
      await new Promise((r) => setTimeout(r, options.seconds * 1000));
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
    await dev.start(cfg, consumer.sink);
    await new Promise((r) => setTimeout(r, options.seconds * 1000));
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
