// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
import { PID_SLOGIC16_U3, PID_SLOGIC32_U3, USB_VID_SIPEED } from './protocol.js';

export const USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: USB_VID_SIPEED, productId: PID_SLOGIC16_U3 },
  { vendorId: USB_VID_SIPEED, productId: PID_SLOGIC32_U3 },
];

/**
 * Period of the event-loop stall probe.
 *
 * Chrome clamps nested timers to ~4 ms, which is exactly the resolution needed here:
 * the question is whether the thread was blocked for a good fraction of the 19.6 ms a
 * 32ch/200M host has before the device FIFO overruns.
 */
const THREAD_PROBE_MS = 4;
/** A stall this long is reported; below it the probe is measuring scheduler noise. */
export const THREAD_STALL_THRESHOLD_MS = 8;

/**
 * Watch for the JS thread being blocked, from inside the capture.
 *
 * libsigrok never has this problem to measure: it reaps and resubmits URBs on the libusb
 * event thread (protocol.c:325), whose only job is to run that callback. In the page the
 * same callback shares a thread with the store append, the WebGL draw and the garbage
 * collector, so a stall is both invisible (transfers simply arrive late, or not at all)
 * and the most likely reason a capture that is fast enough on average still trips the
 * device's FIFO.
 */
export class LoopStallWatch {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  count = 0;
  maxMs = 0;
  maxAtMs = 0;
  readonly samples: number[] = [];
  /** Called for every stall over the threshold, with its offset from start(). */
  onStall: ((ms: number, atMs: number) => void) | null = null;

  start(): void {
    this.stop();
    this.lastTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const stall = now - this.lastTick - THREAD_PROBE_MS;
      this.lastTick = now;
      if (stall < THREAD_STALL_THRESHOLD_MS) return;
      this.count += 1;
      this.samples.push(stall);
      if (stall > this.maxMs) {
        this.maxMs = stall;
        this.maxAtMs = now;
      }
      this.onStall?.(stall, now);
    }, THREAD_PROBE_MS);
    // The probe measures a capture; it is not a reason for one to exist. Node's offline
    // suite drives this transport without ever stopping some of its scripted captures, and
    // a browser-only timer id has no `unref` to call, so this is a no-op everywhere else.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
