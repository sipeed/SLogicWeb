// SPDX-License-Identifier: GPL-3.0-or-later

import type { CaptureStopReason } from './captureViewport.js';

export interface AcquisitionWaveFacts {
  reason: CaptureStopReason;
  loop: boolean;
  samples: number;
  missed: boolean;
}

export function acquisitionWaveCompleted(facts: AcquisitionWaveFacts): boolean {
  return facts.reason === 'completed' &&
    !facts.loop &&
    Number.isSafeInteger(facts.samples) &&
    facts.samples > 0 &&
    !facts.missed;
}

function isIndex(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function acquisitionWaveKey(sessionId: number, generation: number): string {
  if (!isIndex(sessionId)) {
    throw new RangeError(`acquisition session id must be a non-negative safe integer: ${sessionId}`);
  }
  if (!isIndex(generation)) {
    throw new RangeError(`acquisition generation must be a non-negative safe integer: ${generation}`);
  }
  return `${sessionId}:${generation}`;
}
