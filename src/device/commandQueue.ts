// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.

import { wireDiagnostic } from '../diagnostics.js';
import type { DiagnosticVars } from '../diagnostics.js';
import { TransportDeadError, type TransportDeadReason } from './types.js';

export interface CommandQueue<T> {
  push(message: T): Promise<void>;
}

export function createCommandQueue<T>(
  handle: (message: T) => Promise<void>,
  onFailure: (error: unknown) => void,
): CommandQueue<T> {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(message: T): Promise<void> {
      tail = tail
        .then(() => handle(message))
        .catch(onFailure)
        .catch((error: unknown) => {
          console.error('[slogic] the worker could not report a command failure:', error);
        });
      return tail;
    },
  };
}

export function describeFailure(
  error: unknown,
): {
  message: string;
  dead?: boolean;
  reason?: TransportDeadReason;
  code?: string;
  vars?: DiagnosticVars;
  payload?: string;
} {
  const wire = wireDiagnostic(error);
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof TransportDeadError ? { dead: true, reason: error.reason } : {}),
    ...(wire ?? {}),
  };
}
