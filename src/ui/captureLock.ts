// SPDX-License-Identifier: GPL-3.0-or-later

export interface CaptureLockState {
  running: boolean;
  stopping: boolean;
  repeatPending: boolean;
}

export function captureOptionsLocked(state: CaptureLockState): boolean {
  return state.running || state.stopping || state.repeatPending;
}

export function applyCaptureLock<T extends HTMLElement>(el: T, locked: boolean): T {
  el.classList.add('capture-lockable');
  el.dataset.captureLock = String(locked);
  return el;
}
