// SPDX-License-Identifier: GPL-3.0-or-later

export type CaptureStartDisplay = 'swap-now' | 'hold-previous';

export interface CaptureStartDisplayInput {
  displayedSamples: number;
  displayedChannels: number;
  captureChannels: number;
  quietRepeat: boolean;
}

export function planCaptureStartDisplay(input: CaptureStartDisplayInput): CaptureStartDisplay {
  if (input.quietRepeat) return 'swap-now';
  if (!(input.displayedSamples > 0)) return 'swap-now';
  if (input.displayedChannels !== input.captureChannels) return 'swap-now';
  return 'hold-previous';
}

export function captureStartHoldDue(pendingSamples: number): boolean {
  return pendingSamples > 0;
}

export interface EmptyHintInput {
  displayedSamples: number;
  running: boolean;
  holdPending: boolean;
}

export function emptyHintVisible(input: EmptyHintInput): boolean {
  if (input.running) return false;
  if (input.holdPending) return false;
  return input.displayedSamples === 0;
}
