// SPDX-License-Identifier: GPL-3.0-or-later

import { clampRepeatIntervalSeconds } from './captureTime.js';

export type RepeatTimerId = ReturnType<typeof setTimeout>;

export interface RepeatTimerHost {
  set(run: () => void, milliseconds: number): RepeatTimerId;
  clear(id: RepeatTimerId): void;
}

const defaultHost: RepeatTimerHost = {
  set: (run, milliseconds) => globalThis.setTimeout(run, milliseconds),
  clear: (id) => globalThis.clearTimeout(id),
};

export class RepeatCaptureTimer {
  private id: RepeatTimerId | null = null;
  private generation = 0;

  constructor(private readonly host: RepeatTimerHost = defaultHost) {}

  get pending(): boolean {
    return this.id !== null;
  }

  schedule(seconds: number, run: () => void): void {
    this.cancel();
    const generation = this.generation;
    const milliseconds = Math.round(clampRepeatIntervalSeconds(seconds) * 1000);
    this.id = this.host.set(() => {
      if (generation !== this.generation) return;
      this.id = null;
      run();
    }, milliseconds);
  }

  cancel(): void {
    this.generation += 1;
    if (this.id !== null) this.host.clear(this.id);
    this.id = null;
  }
}
