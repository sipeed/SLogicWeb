// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Public contract for src/device, as specified in docs/ARCHITECTURE.md.
 * Nothing outside this file is part of the cross-module interface.
 */

import { DiagnosticError } from '../diagnostics.js';
import type { DiagnosticCode, DiagnosticVars } from '../diagnostics.js';

export interface CaptureConfig {
  channels: import('../types.js').ChannelCount;
  samplerate: number; // Hz, from the table in PROTOCOL-SLOGIC16U3.md
  thresholdVolts: number; // mapped to the DAC code by the device layer
  /** 0 normal input, 1 USB throughput pattern, 2 simulated logic pattern. */
  testMode?: 0 | 1 | 2;
}

export interface CaptureStartOptions {
  /** Optional bounded host-side trigger. Omit to preserve unfiltered streaming. */
  softwareTrigger?: import('../data/softwareTrigger.js').SoftwareTriggerConfig;
  /**
   * DSView-style loop capture: an unbounded stream the host windows by dropping old
   * samples. A loop capture ends only on a manual stop or a device error, so the
   * transport leaves the first-byte watchdog disarmed and never aborts on an underrun
   * (HSync semantics; the watchdogs stay on for every other capture).
   */
  loop?: boolean;
  /**
   * Samples the host should deliver before ending a finite capture when its length
   * is known before RUN. The transport enforces this host-side budget independently
   * of any device length register. Omit it - or pass 0 - for an unbounded capture.
   */
  deviceSampleLimit?: number;
  /**
   * `triggerSampleIndex` is present for `triggered` and refers to the emitted stream.
   * `forced` (reported once, no index) means an Auto sweep (`softwareTrigger.
   * autoAfterSamples`) found no qualified crossing in time and captured untriggered
   * data instead: the capture completes like a triggered one, but has no T.
   */
  onTriggerState?: (
    state: 'waiting' | 'triggered' | 'forced' | 'not-found', triggerSampleIndex?: number,
  ) => void;
  /**
   * A bounded capture completed and all its data has been handed to the sink: the
   * host delivered `deviceSampleLimit` samples, the software trigger emitted its full
   * budget (after a match or an Auto force), or a bounded trigger search ended with no match (nothing was delivered;
   * `onTriggerState` has already said `not-found`). Fired at most once per capture,
   * after the last sink call for it, and never for a capture the caller stopped
   * manually - so the caller can stop() on it without keeping a separate sample count.
   */
  onEnd?: () => void;
}

/**
 * `chunk` is raw device bytes with the model's partial head already removed (4 bytes
 * on the SLogic16U3, none on the SLogic32U3) and sub-8-channel packing already expanded.
 * Samples are little-endian and occupy ceil(channels / 8) bytes (2 at 16 channels, 4 at
 * 32, up to 16 at 128).
 *
 * The buffer handed to the sink is owned by the sink from that point on; the
 * device layer never writes to it again.
 */
export type SampleSink = (chunk: Uint8Array) => void | Promise<void>;

/**
 * Reports a mid-capture dropout: `samplePosition` samples were delivered
 * before the device failed to fill a transfer and `missingSamples` were lost.
 * The stream continues afterwards, so every sample position at or past the
 * gap is shifted relative to device time - mark the span untrusted rather
 * than resuming as if nothing happened.
 */
export type DropoutSink = (samplePosition: number, missingSamples: number) => void;

export type TransportDeadReason =
  | 'loop-unsettled'
  | 'reclaim-failed'
  | 'worker-timeout'
  | 'unknown';

export class TransportDeadError extends DiagnosticError {
  readonly reason: TransportDeadReason;

  constructor(
    code: DiagnosticCode,
    reason: TransportDeadReason,
    vars?: DiagnosticVars,
    payload?: string,
  ) {
    super(code, { ...vars, reason }, payload);
    this.name = 'TransportDeadError';
    this.reason = reason;
  }
}

export interface Device {
  readonly name: string;
  readonly serial: string;
  /** Capability envelope exposed to the UI; absent for third-party devices. */
  readonly maxChannels?: number;
  readonly maxSamplerateHz?: Readonly<Record<number, number>>;
  /**
   * Per-width default rate where the profile has measured the ceiling as offered but not
   * sustained (`RateTier.recommendedHz`, for the link WebUSB cannot name); a width with
   * no entry defaults to the caller's choice.
   */
  readonly recommendedSamplerateHz?: Readonly<Record<number, number>>;
  /** Advanced, idle-only USB/register console. */
  usbControl?(command: string): Promise<string>;
  start(
    cfg: CaptureConfig, sink: SampleSink, onDropout?: DropoutSink,
    options?: CaptureStartOptions,
  ): Promise<void>;
  /**
   * Replace the active software trigger's conditions without restarting the stream. In
   * one-shot mode this is accepted while the matcher is waiting; after its match, edits
   * stay pending for the next acquisition. In continuous mode it is also accepted after
   * the first match, until the stream completes or reports no trigger. A transport may
   * queue the change (the worker does), so this reports nothing: an accepted/rejected
   * result is not observable through this interface.
   */
  updateSoftwareTrigger?(config: import('../data/softwareTrigger.js').SoftwareTriggerConfig): void;
  stop(): Promise<void>;
  terminate(): void;
  /**
   * Fatal errors from the transport's background reader. Optional because a
   * third-party device need not have one; when present it is set by the UI, which is
   * what turns "the capture died in the background" into something the user sees.
   */
  onError?: ((error: unknown) => void) | null;
}
