// SPDX-License-Identifier: GPL-3.0-or-later

import { WorkerSlogicDevice } from '../workerTransport.js';
import type { Device } from '../types.js';
import type { App } from '../../ui/app.js';
import type { StatusError } from '../../ui/state.js';
import FakeUsbWorker from './fakeUsbWorker.js?worker&inline';

interface ProbeApp {
  device: Device | null;
  deviceEpoch: number;
  running: boolean;
  stopping: boolean;
  statusError: StatusError | null;
  store: { length: number; samplerate: number; channelCount: number };
  channels: readonly { enabled: boolean }[];
  debug: App['debug'];
  draw(): void;
  toPx(sample: number): number;
  installDevice(device: Device, epoch: number): void;
  discardDevice(): number;
}

export interface CursorChipsScene {
  name: string;
  pass: boolean;
  detail: string;
}

export interface CursorChipsProbeReport {
  scenes: CursorChipsScene[];
}

const SETTLE_MS = 150;

export async function runCursorChipsProbe(): Promise<CursorChipsProbeReport> {
  const app = window.logicweb as unknown as ProbeApp | undefined;
  if (!app) throw new Error('the App is not ready');
  app.discardDevice();
  const worker = new FakeUsbWorker({ name: String(6000) });
  const dev = await WorkerSlogicDevice.open(
    { vendorId: 0x359f, productId: 0x3032, serial: 'clock' },
    { spawn: () => worker, openTimeoutMs: 5000 },
  ).catch((error: unknown) => {
    worker.terminate();
    throw error;
  });
  const scenes: CursorChipsScene[] = [];
  const record = (name: string, pass: boolean, detail: string): void => {
    scenes.push({ name, pass, detail });
  };
  try {
    app.installDevice(dev, app.deviceEpoch);
    for (let i = 8; i < app.channels.length; i++) app.debug.toggleChannel(i, false);
    app.debug.setSettings({
      channels: 8,
      samplerate: 5_000_000,
      testMode: 2,
      seconds: 0.1,
      mode: 'single',
      triggerEnableMask: false,
      softwareTrigger: false,
    });
    await app.debug.start();
    const deadline = performance.now() + 30_000;
    while (app.running || app.stopping) {
      if (performance.now() > deadline) throw new Error('the capture did not stop');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    app.debug.setViewportSeconds(0, 0.1);
    app.draw();

    const cursorIds = (): number[] => app.debug.cursors().map((cursor) => cursor.id);
    const length = app.store.length;
    const perSample = (app.toPx(1000) - app.toPx(0)) / 1000;

    const apart = Math.max(1, Math.round(200 / perSample));
    const first = Math.floor(length / 4);
    const second = first + apart;
    app.debug.setMarker(null);
    app.debug.addCursor(first);
    app.debug.addCursor(second);
    app.draw();
    const farChips = app.debug.cursorChips();
    const farIds = cursorIds();
    const farPass = farChips.length === 2 &&
      farChips.every((chip) => chip.row === 0 && Math.abs(chip.boxX - chip.anchorX) <= 0.5) &&
      farChips[0].boxX < farChips[1].boxX &&
      farChips[0].id === farIds[0] && farChips[1].id === farIds[1] &&
      app.statusError === null;
    record('far-apart', farPass,
      `samples=${first},${second} px=${perSample.toFixed(4)}/${apart} ` +
      `chips=${farChips.map((chip) => `${chip.id}@${chip.boxX.toFixed(1)}/${chip.anchorX.toFixed(1)}/r${chip.row}`).join(',')} ` +
      `ids=${farIds.join(',')} error=${app.statusError ? 'yes' : 'no'}`);

    const point = Math.floor(length / 2);
    app.debug.setMarker(null);
    app.debug.addCursor(point);
    app.debug.addCursor(point);
    app.draw();
    const sameChips = app.debug.cursorChips();
    const sameIds = cursorIds();
    const samePass = sameChips.length === 1 && sameChips[0].id === sameIds[1] &&
      sameChips[0].row === 0 &&
      Math.abs(sameChips[0].boxX - sameChips[0].anchorX) <= 0.5 &&
      app.statusError === null;
    record('same-point', samePass,
      `sample=${point} chips=${sameChips.map((chip) => `${chip.id}@${chip.boxX.toFixed(1)}`).join(',')} ` +
      `ids=${sameIds.join(',')} error=${app.statusError ? 'yes' : 'no'}`);

    return { scenes };
  } finally {
    app.debug.setMarker(null);
    if (app.running || app.stopping) await app.debug.stop();
    app.discardDevice();
  }
}
