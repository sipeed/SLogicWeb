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
  /** Per-drop cost of dropFront alone, never amortized. */
  dropMsP95: number;
  dropMsMax: number;
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
  /** Sample rate; the scripted device offers samplerate x bytes-per-sample / 1000 bytes per ms. */
  samplerate: number;
  /** Channel count: 8 exercises the planar store, 32 the interleaved store. */
  channels?: 8 | 32;
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
    filledSum: 0, busBehindDrops: 0, busCatchUpMsMax: 0, busBehindAtStop: false,
    peakLength: 0,
    sink(chunk: Uint8Array): void {
      store.append(chunk);
      state.peakLength = Math.max(state.peakLength, store.length);
      // The app's policy, imported rather than mirrored: no hysteresis, every delivery
      // drops the window back to the limit.
      const drop = loopDropSamples(store.length, retention);
      if (drop <= 0) return;
      const t = performance.now();
      store.dropFront(drop);
      // The app no longer resets bus builders on a drop: BusBuilder's frontier is
      // absolute and analogFrame's cache key carries store.droppedSamples.
      state.dropMs.push(performance.now() - t);
      state.drops++;
      if (display) {
        if (!caughtUp) state.busBehindDrops++;
        caughtUp = false;
      }
      lastDropAt = performance.now();
    },
    stop(): void {
      pumping = false;
      if (display && !caughtUp) state.busBehindAtStop = true;
    },
  };

  const pump = (): void => {
    if (!pumping || !display) return;
    builder.setLength(store.length);
    builder.step(4);
    if (!caughtUp && builder.pyramid.doneUpTo >= store.length) {
      caughtUp = true;
      state.busCatchUpMsMax = Math.max(state.busCatchUpMsMax, performance.now() - lastDropAt);
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
    channels: options.channels ?? CHANNELS,
    samplerate: options.samplerate,
    retentionSamples: retention,
    seconds: options.seconds,
    widthPx,
    path: retention / widthPx > 256 || retention > 4_000_000 ? 'pyramid' : 'exact',
    ...(error === undefined ? {} : { error }),
    // Offered wire bytes, not samples: the driver gates on sustainedMBps / expectedMBps,
    // so a 32-channel cell must divide by its 4 bytes per sample or it can never fail.
    expectedMBps: (options.samplerate * ((options.channels ?? CHANNELS) >>> 3)) / 1e6,
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
  const bytesPerMs = (options.samplerate * (channels >>> 3)) / 1000;
  const cfg = { channels, samplerate: options.samplerate, thresholdVolts: 1.6 } as const;
  const consumer = startConsumer(options);
  let error: string | undefined;

  if (options.transport === 'page') {
    const device = new ClockStreamDevice(bytesPerMs, options.fifoBytes ?? 262_144);
    const dev = new Slogic16U3(device as unknown as USBDevice);
    try {
      await dev.open();
      await dev.start(cfg, consumer.sink, undefined, { loop: true });
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
    await dev.start(cfg, consumer.sink, undefined, { loop: true });
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
