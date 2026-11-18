// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A capture that ended because the device or the link failed, not because it was
 * stopped or reached its length. The banner reads it to lead with a plain conclusion
 * and the one remedy, with the diagnostic collapsed.
 *
 * Pure: no DOM, no device. The cause comes from the error's diagnostic code; the
 * remedy's rate comes from the offered-rate table and the board's recommendation.
 */

import { diagnosticOf } from '../diagnostics.js';

/**
 * `hostOverload` is the transport's own abort (`device.underrunStalled`/`Clean`): the
 * host fell behind the device and the capture was stopped before the FIFO overflowed.
 * Lowering the rate is the remedy. `disconnected` is the board going away; `device` is
 * every other transport failure, which has no rate remedy. `memory` is the host's own
 * stop: the store reached its byte ceiling (`maxCaptureSamples`) or an allocation for
 * it failed; what was recorded up to there is kept.
 */
export type CaptureAbortCause = 'hostOverload' | 'disconnected' | 'device' | 'memory';

/**
 * An out-of-memory failure, as V8/Blink report it: `RangeError: Array buffer allocation
 * failed` (or "Invalid array buffer length"), or a DOMException/Error saying so. The
 * store's own sample-ceiling error is a plain Error and is not one.
 */
export function isAllocationFailure(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  const message = error instanceof Error || error instanceof DOMException
    ? error.message : typeof error === 'string' ? error : '';
  return /allocation failed|out of memory|array buffer length/i.test(message);
}

export interface CaptureAbort {
  cause: CaptureAbortCause;
  channels: number;
  samplerate: number;
}

export function captureAbortCause(error: unknown): CaptureAbortCause {
  const code = diagnosticOf(error)?.code;
  if (code === 'device.underrunStalled' || code === 'device.underrunClean') return 'hostOverload';
  if (code === 'device.disconnected') return 'disconnected';
  return 'device';
}

/**
 * The rate the banner's remedy moves to: the board's recommendation when the capture ran
 * above it (one click to the rate that was measured clean), else the next offered rate
 * down. Null when nothing lower is offered or the cause has no rate remedy.
 */
export function lowerSamplerate(
  abort: CaptureAbort, offered: readonly number[], recommended?: number,
): number | null {
  if (abort.cause !== 'hostOverload') return null;
  if (recommended !== undefined && abort.samplerate > recommended &&
      offered.includes(recommended)) {
    return recommended;
  }
  const below = offered.filter((hz) => hz < abort.samplerate);
  return below.length > 0 ? below[below.length - 1]! : null;
}

/**
 * The banner's plain conclusion for a failed save: an allocation failure reads "Save
 * failed: out of memory..." (the raw "Array buffer allocation failed" stays under
 * Technical details); any other failure keeps the ordinary diagnostic.
 */
export function saveFailureNotice(
  error: unknown,
): { notice: { key: 'error.saveOutOfMemory' } } | undefined {
  return isAllocationFailure(error) ? { notice: { key: 'error.saveOutOfMemory' } } : undefined;
}
