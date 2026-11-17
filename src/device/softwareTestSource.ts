// SPDX-License-Identifier: GPL-3.0-or-later
/** Host-generated capture pump that streams the software test pattern into a sample sink. */

import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import type { CaptureConfig, CaptureStartOptions, Device, SampleSink } from './types.js';
import { SoftwareTestPattern } from './softwareTestPattern.js';

export interface SoftwareTestSchedule {
  set(fn: () => void): unknown;
  clear(handle: unknown): void;
}

export const REAL_SOFTWARE_TEST_SCHEDULE: SoftwareTestSchedule = {
  set: (fn) => setTimeout(fn, 0),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const SOFTWARE_TEST_CHUNK_BYTES = 4 << 20;

export interface SoftwareTestStreamOptions {
  channels: ChannelCount;
  samplerate: number;
  analogGroups: number;
  zeroCode: number;
  sink: SampleSink;
  samples?: number;
  onEnd?: () => void;
  schedule?: SoftwareTestSchedule;
  chunkBytes?: number;
}

export class SoftwareTestStream {
  private readonly pattern: SoftwareTestPattern;
  private readonly bytesPerSample: number;
  private readonly sink: SampleSink;
  private readonly schedule: SoftwareTestSchedule;
  private readonly chunkSamples: number;
  private readonly budget: number | null;
  private readonly endCallback: (() => void) | null;
  private handle: unknown = null;
  private scheduled = false;
  private ticking = false;
  private started = false;
  private stopped = false;
  private done = false;
  private emitted = 0;
  private waiters: (() => void)[] = [];

  constructor(options: SoftwareTestStreamOptions) {
    const { channels, analogGroups, zeroCode, sink } = options;
    this.pattern = new SoftwareTestPattern({ channels, analogGroups, zeroCode });
    if (!Number.isFinite(options.samplerate) || options.samplerate <= 0) {
      throw new RangeError(
        `samplerate must be positive and finite, got ${String(options.samplerate)}`,
      );
    }
    if (typeof sink !== 'function') {
      throw new TypeError(`sink must be a function, got ${typeof sink}`);
    }
    this.bytesPerSample = bytesPerSampleForChannels(channels);
    const samples = options.samples;
    if (samples !== undefined && (!Number.isSafeInteger(samples) || samples <= 0)) {
      throw new RangeError(`samples must be a positive safe integer, got ${String(samples)}`);
    }
    const chunkBytes = options.chunkBytes ?? SOFTWARE_TEST_CHUNK_BYTES;
    if (!Number.isInteger(chunkBytes) || chunkBytes < this.bytesPerSample) {
      throw new RangeError(
        `chunkBytes must be an integer of at least ${this.bytesPerSample} bytes, ` +
          `got ${String(chunkBytes)}`,
      );
    }
    this.budget = samples ?? null;
    this.sink = sink;
    this.schedule = options.schedule ?? REAL_SOFTWARE_TEST_SCHEDULE;
    this.endCallback = options.onEnd ?? null;
    this.chunkSamples = Math.floor(chunkBytes / this.bytesPerSample);
  }

  get emittedSamples(): number {
    return this.emitted;
  }

  get finished(): boolean {
    return this.done;
  }

  start(): void {
    if (this.started) throw new Error('the software test stream is already started');
    if (this.stopped) throw new Error('the software test stream is already stopped');
    this.started = true;
    this.scheduleTick();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.cancelTick();
    if (!this.ticking) return Promise.resolve();
    return new Promise((resolve) => { this.waiters.push(resolve); });
  }

  private scheduleTick(): void {
    this.scheduled = true;
    this.handle = this.schedule.set(() => { this.tick(); });
  }

  private cancelTick(): void {
    if (!this.scheduled) return;
    this.schedule.clear(this.handle);
    this.scheduled = false;
    this.handle = null;
  }

  private tick(): void {
    this.scheduled = false;
    this.handle = null;
    if (this.stopped) return;
    this.ticking = true;
    try {
      const room = this.budget === null ? this.chunkSamples : this.budget - this.emitted;
      const chunkSamples = Math.min(this.chunkSamples, room);
      const buffer = new Uint8Array(chunkSamples * this.bytesPerSample);
      this.pattern.fill(buffer, this.emitted);
      this.emitted += chunkSamples;
      this.sink(buffer);
      if (this.budget !== null && this.emitted >= this.budget) {
        this.done = true;
        const announce = !this.stopped;
        this.stopped = true;
        if (announce) this.endCallback?.();
        return;
      }
      if (!this.stopped) this.scheduleTick();
    } finally {
      this.ticking = false;
      this.release();
    }
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

export interface SoftwareTestSourceOptions {
  analogGroups: number;
  zeroCode: number;
  schedule?: SoftwareTestSchedule;
}

export function softwareTestDevice(base: Device, options: SoftwareTestSourceOptions): Device {
  const schedule = options.schedule ?? REAL_SOFTWARE_TEST_SCHEDULE;
  let stream: SoftwareTestStream | null = null;
  let armed = false;
  const device: Device = {
    name: base.name,
    serial: base.serial,
    async start(
      cfg: CaptureConfig,
      sink: SampleSink,
      _onDropout,
      startOptions: CaptureStartOptions | undefined,
    ): Promise<void> {
      if (startOptions?.softwareTrigger) {
        throw new Error('the software test source cannot match a software trigger');
      }
      if (armed) throw new Error('the software test source is already started');
      const limit = startOptions?.deviceSampleLimit;
      const onEnd = startOptions?.onEnd;
      const next = new SoftwareTestStream({
        channels: cfg.channels,
        samplerate: cfg.samplerate,
        analogGroups: options.analogGroups,
        zeroCode: options.zeroCode,
        sink,
        schedule,
        ...(limit !== undefined && limit > 0 ? { samples: limit } : {}),
        ...(onEnd !== undefined ? { onEnd } : {}),
      });
      armed = true;
      stream = next;
      next.start();
    },
    async stop(): Promise<void> {
      const active = stream;
      stream = null;
      if (active !== null) await active.stop();
    },
    terminate(): void {
      const active = stream;
      stream = null;
      if (active !== null) void active.stop();
    },
  };
  return device;
}
