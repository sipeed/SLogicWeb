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

export type CursorChipsProbeSet = 'default' | 'narrow';

export interface CursorChipsProbeReport {
  scenes: CursorChipsScene[];
  plotWidth: number;
  windowWidth: number;
}

const SETTLE_MS = 150;
const CURSOR_INK = [0xcd, 0x42, 0x7e];

function plotWidth(): number {
  return document.getElementById('plot')?.clientWidth ?? 0;
}

function countInk(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return -1;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] === CURSOR_INK[0] && data[index + 1] === CURSOR_INK[1] &&
      data[index + 2] === CURSOR_INK[2]) count++;
  }
  return count;
}

async function settleWidth(narrow: boolean): Promise<number> {
  const deadline = performance.now() + 5000;
  let last = -1;
  let stable = 0;
  while (performance.now() < deadline) {
    const current = plotWidth();
    if (narrow && current > 360) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    stable = current === last ? stable + 1 : 0;
    last = current;
    if (stable >= 3) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return plotWidth();
}

function describe(chips: ReturnType<App['debug']['cursorChips']>): string {
  return chips
    .map((chip) => `${chip.id}@${chip.boxX.toFixed(1)}/${chip.anchorX.toFixed(1)}/r${chip.row}/w${chip.width.toFixed(1)}`)
    .join(',');
}

export async function runCursorChipsProbe(
  set: CursorChipsProbeSet = 'default',
): Promise<CursorChipsProbeReport> {
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
    const width = await settleWidth(set === 'narrow');
    app.debug.setViewportSeconds(0, 0.1);
    app.draw();

    const perSample = (app.toPx(1000) - app.toPx(0)) / 1000;
    const samples = (cssPx: number): number => Math.round(cssPx / perSample);
    const steps = (cssPx: number): number => Math.max(1, samples(cssPx));
    const length = app.store.length;
    const middle = Math.floor(length / 2);
    const place = (offsets: readonly number[]): void => {
      app.debug.setMarker(null);
      app.debug.setViewportSeconds(0, 0.1);
      for (const offset of offsets) app.debug.addCursor(middle + samples(offset));
      app.draw();
    };
    const rowsOf = (chips: ReturnType<App['debug']['cursorChips']>): string =>
      chips.map((chip) => chip.row).join(',');

    if (set === 'narrow') {
      app.debug.setMarker(null);
      app.debug.setViewportSeconds(0.02, 0.08);
      app.draw();
      const scale = (app.toPx(middle + 1000) - app.toPx(middle)) / 1000;
      const origin = app.toPx(middle);
      const at = (cssX: number): number => Math.round(middle + (cssX - origin) / scale);
      app.debug.addCursor(at(width - 3));
      app.debug.addCursor(at(width + 1));
      app.draw();
      const chips = app.debug.cursorChips();
      const inside = chips.every((chip) =>
        chip.boxX - chip.width / 2 >= 2 - 1e-6 && chip.boxX + chip.width / 2 <= width - 2 + 1e-6);
      record('narrow', chips.length === 2 && rowsOf(chips) === '0,1' && inside &&
        width >= 300 && width <= 340 && app.statusError === null,
        `plotWidth=${width} scale=${scale.toFixed(4)} ` +
        `anchors=${chips.map((chip) => chip.anchorX.toFixed(1)).join(',')} ` +
        `chips=${describe(chips)} error=${app.statusError ? 'yes' : 'no'}`);
      return { scenes, plotWidth: width, windowWidth: window.innerWidth };
    }

    place([0, 200]);
    const farChips = app.debug.cursorChips();
    const farIds = app.debug.cursors().map((cursor) => cursor.id);
    record('far-apart', farChips.length === 2 &&
      farChips.every((chip) => chip.row === 0 && Math.abs(chip.boxX - chip.anchorX) <= 0.5) &&
      farChips[0].boxX < farChips[1].boxX &&
      farChips[0].id === farIds[0] && farChips[1].id === farIds[1] &&
      app.statusError === null,
      `plotWidth=${width} px=${perSample.toFixed(4)}/${steps(200)} chips=${describe(farChips)} ` +
      `ids=${farIds.join(',')} error=${app.statusError ? 'yes' : 'no'}`);

    place([0, 0.8]);
    const pairChips = app.debug.cursorChips();
    record('pair', pairChips.length === 2 && rowsOf(pairChips) === '0,1' &&
      pairChips.every((chip) => Math.abs(chip.boxX - chip.anchorX) <= 0.5) &&
      app.statusError === null,
      `px=${perSample.toFixed(4)}/${steps(0.8)} chips=${describe(pairChips)} ` +
      `error=${app.statusError ? 'yes' : 'no'}`);

    place([-13.5, -4.5, 4.5, 13.5]);
    const zigzag = app.debug.cursorChips();
    record('zigzag', zigzag.length === 4 && rowsOf(zigzag) === '0,1,0,1' &&
      zigzag.every((chip) => Math.abs(chip.boxX - chip.anchorX) <= 0.5) &&
      app.statusError === null,
      `px=${perSample.toFixed(4)}/${steps(9)} chips=${describe(zigzag)} ` +
      `error=${app.statusError ? 'yes' : 'no'}`);

    place([-27, -9, 9, 27]);
    const singleRow = app.debug.cursorChips();
    record('single-row', singleRow.length === 4 && rowsOf(singleRow) === '0,0,0,0' &&
      singleRow.every((chip) => Math.abs(chip.boxX - chip.anchorX) <= 0.5) &&
      app.statusError === null,
      `px=${perSample.toFixed(4)}/${steps(18)} chips=${describe(singleRow)} ` +
      `error=${app.statusError ? 'yes' : 'no'}`);

    const axis = document.getElementById('axis') as HTMLCanvasElement | null;
    if (axis === null) throw new Error('the axis canvas is missing');
    app.debug.setMarker(null);
    app.debug.setViewportSeconds(0, 0.1);
    app.debug.addCursor(Math.round(app.store.samplerate * 0.0002));
    app.draw();
    const visibleInk = countInk(axis);
    const visibleChips = app.debug.cursorChips();
    app.debug.setViewportSeconds(0.06, 0.1);
    app.draw();
    const awayChips = app.debug.cursorChips();
    const hiddenInk = countInk(axis);
    app.debug.setViewportSeconds(0, 0.1);
    app.draw();
    const restoredInk = countInk(axis);
    record('guard', awayChips.length === 1 && awayChips[0].anchorX < -20 &&
      visibleInk > 0 && hiddenInk === 0 && restoredInk > 0 && app.statusError === null,
      `anchor=${awayChips[0]?.anchorX.toFixed(1)} visibleAnchor=${visibleChips[0]?.anchorX.toFixed(1)} ` +
      `ink=${visibleInk}/${hiddenInk}/${restoredInk} error=${app.statusError ? 'yes' : 'no'}`);

    return { scenes, plotWidth: width, windowWidth: window.innerWidth };
  } finally {
    app.debug.setMarker(null);
    if (app.running || app.stopping) await app.debug.stop();
    app.discardDevice();
  }
}
