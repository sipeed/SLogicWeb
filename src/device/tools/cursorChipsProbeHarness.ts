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
  const app = window.slogicweb as unknown as ProbeApp | undefined;
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
    await settleWidth(set === 'narrow');
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
    const originX = app.toPx(middle);
    const sampleAt = (cssX: number): number => Math.round(middle + (cssX - originX) / perSample);
    const placeAt = (positions: readonly number[]): void => {
      app.debug.setMarker(null);
      app.debug.setViewportSeconds(0, 0.1);
      for (const cssX of positions) app.debug.addCursor(sampleAt(cssX));
      app.draw();
    };
    const displaced = (chips: ReturnType<App['debug']['cursorChips']>): number =>
      chips.filter((chip) => Math.abs(chip.boxX - chip.anchorX) > 0.5).length;
    const allInside = (chips: ReturnType<App['debug']['cursorChips']>, plot: number): boolean =>
      chips.every((chip) => chip.boxX - chip.width / 2 >= 2 - 1e-6 &&
        chip.boxX + chip.width / 2 <= plot - 2 + 1e-6);
    const rowsOf = (chips: ReturnType<App['debug']['cursorChips']>): string =>
      chips.map((chip) => chip.row).join(',');
    const overlaps = (chips: ReturnType<App['debug']['cursorChips']>): string => {
      const rows: Array<Array<{ id: number; left: number; right: number }>> = [[], []];
      for (const chip of chips) {
        rows[chip.row].push({
          id: chip.id, left: chip.boxX - chip.width / 2, right: chip.boxX + chip.width / 2,
        });
      }
      const hits: string[] = [];
      for (const row of rows) {
        for (let index = 1; index < row.length; index++) {
          const gap = row[index].left - row[index - 1].right;
          if (gap < 2 - 1e-6) hits.push(`${row[index - 1].id}/${row[index].id}=${gap.toFixed(2)}`);
        }
      }
      return hits.join(',');
    };

    if (set === 'narrow') {
      const at = (cssX: number): number => {
        const origin = app.toPx(middle);
        const scale = (app.toPx(middle + 1000) - origin) / 1000;
        return Math.round(middle + (cssX - origin) / scale);
      };
      app.debug.setMarker(null);
      app.debug.setViewportSeconds(0.02, 0.08);
      app.debug.addCursor(at(300));
      app.debug.addCursor(at(304));
      app.draw();
      const settled = await settleWidth(true);
      const width = plotWidth();
      const scale = (app.toPx(middle + 1000) - app.toPx(middle)) / 1000;
      const chips = app.debug.cursorChips();
      record('narrow', chips.length === 2 && rowsOf(chips) === '0,1' &&
        allInside(chips, width) && overlaps(chips) === '' &&
        width >= 300 && width <= 340 && app.statusError === null,
        `plotWidth=${width} settled=${settled} windowWidth=${window.innerWidth} ` +
        `scale=${scale.toFixed(4)} ` +
        `anchors=${chips.map((chip) => chip.anchorX.toFixed(1)).join(',')} ` +
        `chips=${describe(chips)} error=${app.statusError ? 'yes' : 'no'}`);

      app.debug.setMarker(null);
      app.debug.setViewportSeconds(0.02, 0.08);
      app.draw();
      const denseBase = plotWidth();
      for (let index = 0; index < 11; index++) {
        app.debug.addCursor(at(denseBase / 2 - 50 + index * 10));
      }
      app.draw();
      await settleWidth(true);
      const denseWidth = plotWidth();
      const dense = app.debug.cursorChips();
      const denseLabels = app.debug.cursors().map((cursor) => cursor.label);
      record('narrow-two-digit', dense.length === 11 && allInside(dense, denseWidth) &&
        overlaps(dense) === '' && denseLabels.includes('8') && denseLabels.includes('10') &&
        denseWidth >= 300 && denseWidth <= 340 && app.statusError === null,
        `plotWidth=${denseWidth} placedWith=${denseBase} windowWidth=${window.innerWidth} ` +
        `chips=${dense.length} ` +
        `left=${(dense[0]?.boxX - dense[0]?.width / 2).toFixed(1)} ` +
        `right=${(dense[10]?.boxX + dense[10]?.width / 2).toFixed(1)} ` +
        `labels=${denseLabels.slice(7).join(',')} error=${app.statusError ? 'yes' : 'no'}`);
      return { scenes, plotWidth: denseWidth, windowWidth: window.innerWidth };
    }

    place([0, 200]);
    const farChips = app.debug.cursorChips();
    const farIds = app.debug.cursors().map((cursor) => cursor.id);
    record('far-apart', farChips.length === 2 &&
      farChips.every((chip) => chip.row === 0 && Math.abs(chip.boxX - chip.anchorX) <= 0.5) &&
      farChips[0].boxX < farChips[1].boxX &&
      farChips[0].id === farIds[0] && farChips[1].id === farIds[1] &&
      app.statusError === null,
      `plotWidth=${plotWidth()} px=${perSample.toFixed(4)}/${steps(200)} chips=${describe(farChips)} ` +
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

    place([-0.5, 0, 0.5]);
    const triple = app.debug.cursorChips();
    record('triple', triple.length === 3 && rowsOf(triple) === '0,0,0' &&
      displaced(triple) >= 2 &&
      triple[0].boxX < triple[1].boxX && triple[1].boxX < triple[2].boxX &&
      app.statusError === null,
      `px=${perSample.toFixed(4)}/${steps(0.5)} displaced=${displaced(triple)} ` +
      `chips=${describe(triple)} error=${app.statusError ? 'yes' : 'no'}`);

    place(Array.from({ length: 8 }, (_, index) => -10 + index * 2.8));
    const crowd = app.debug.cursorChips();
    const crowdGaps = crowd.slice(1).map((chip, index) =>
      chip.boxX - chip.width / 2 - (crowd[index].boxX + crowd[index].width / 2));
    record('crowd', crowd.length === 8 && rowsOf(crowd) === '0,0,0,0,0,0,0,0' &&
      crowdGaps.every((gap) => gap >= -1e-6) && displaced(crowd) >= 1 &&
      app.statusError === null,
      `gaps=${crowdGaps.map((gap) => gap.toFixed(2)).join(',')} ` +
      `displaced=${displaced(crowd)} chips=${describe(crowd)} ` +
      `error=${app.statusError ? 'yes' : 'no'}`);

    placeAt([3, 4, 5]);
    const edge = app.debug.cursorChips();
    record('edge', edge.length === 3 && rowsOf(edge) === '0,0,0' &&
      edge[0].boxX - edge[0].width / 2 >= 2 - 1e-6 &&
      edge.every((chip) => chip.anchorX < 6) &&
      edge[0].boxX < edge[1].boxX && edge[1].boxX < edge[2].boxX &&
      app.statusError === null,
      `anchors=${edge.map((chip) => chip.anchorX.toFixed(1)).join(',')} ` +
      `left=${(edge[0]?.boxX - edge[0]?.width / 2).toFixed(2)} chips=${describe(edge)} ` +
      `error=${app.statusError ? 'yes' : 'no'}`);

    placeAt([1, 2, 3, 30]);
    const neighbour = app.debug.cursorChips();
    record('neighbour', neighbour.length === 4 && overlaps(neighbour) === '' &&
      allInside(neighbour, plotWidth()) &&
      neighbour.every((chip) => chip.row === 0) &&
      neighbour.map((chip) => chip.id).join(',') ===
        app.debug.cursors().map((cursor) => cursor.id).join(',') &&
      app.statusError === null,
      `plotWidth=${plotWidth()} overlaps=${overlaps(neighbour) || 'none'} ` +
      `chips=${describe(neighbour)} error=${app.statusError ? 'yes' : 'no'}`);

    place(Array.from({ length: 11 }, (_, index) => -50 + index * 10));
    const twoDigit = app.debug.cursorChips();
    const twoDigitWidth = plotWidth();
    const labels = app.debug.cursors().map((cursor) => cursor.label);
    record('two-digit', twoDigit.length === 11 && allInside(twoDigit, twoDigitWidth) &&
      overlaps(twoDigit) === '' &&
      labels.includes('10') && labels.includes('11') && app.statusError === null,
      `plotWidth=${twoDigitWidth} chips=${twoDigit.length} ` +
      `left=${(twoDigit[0]?.boxX - twoDigit[0]?.width / 2).toFixed(1)} ` +
      `right=${(twoDigit[10]?.boxX + twoDigit[10]?.width / 2).toFixed(1)} ` +
      `labels=${labels.slice(-2).join(',')} error=${app.statusError ? 'yes' : 'no'}`);

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

    return { scenes, plotWidth: plotWidth(), windowWidth: window.innerWidth };
  } finally {
    app.debug.setMarker(null);
    if (app.running || app.stopping) await app.debug.stop();
    app.discardDevice();
  }
}
