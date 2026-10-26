// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

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
