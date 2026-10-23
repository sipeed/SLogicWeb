// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Standalone hardware self test for the SLogic16 U3 WebUSB transport.
 *
 * Serve with `npx vite` from the project root and open
 *   http://127.0.0.1:5173/src/device/selftest.html
 *
 * One human click is needed the first time, to pick the device in the WebUSB
 * chooser. After that the grant is remembered for this origin and the page
 * runs on load with no click at all.
 *
 * Results are also POSTed to the collector in result-server.mjs when it is
 * running, so a run can be read back from the terminal.
 */

import {
  TEST_MODE_EMULATION,
  TEST_MODE_NORMAL,
  vrefCode,
  vrefVolts,
  type TraceEntry,
} from './protocol.js';
import {
  deviceLabel,
  emulationAnchor,
  emulationWidths,
  liveWidths,
  modelForMaxChannels,
  modelForProductId,
  parseScenario,
  emulationProbeWidths,
  refusalCases,
  scenarioTiming,
  sawtoothOk,
  throughputPlan,
  traceWindow,
  type ScenarioRequest,
  type SelftestModel,
  type StopScenario,
} from './selftestPlan.js';
import {
  Slogic16U3,
  expandPacked,
} from './slogic16u3.js';
import { USB_FILTERS } from './usbCore.js';
import { WorkerSlogicDevice } from './workerTransport.js';
import './usbWorkerSpawn.js';
import type { CaptureConfig, Device } from './types.js';
import { bytesPerSampleForChannels } from '../types.js';

const RESULT_SINK = 'http://127.0.0.1:5177/result';

const logEl = document.getElementById('log') as HTMLDivElement;
const connectEl = document.getElementById('connect') as HTMLButtonElement;
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), checks: [] };
const checks = report.checks as Record<string, unknown>[];

function line(text: string, cls = ''): void {
  const d = document.createElement('div');
  if (cls) d.className = cls;
  d.textContent = text;
  logEl.appendChild(d);
  // eslint-disable-next-line no-console
  console.log(text);
}

function head(text: string): void {
  line('', '');
  line(text, 'hd');
}

function hexdump(bytes: Uint8Array, count: number): string {
  const n = Math.min(count, bytes.length);
  const rows: string[] = [];
  for (let i = 0; i < n; i += 16) {
    const row = bytes.subarray(i, Math.min(i + 16, n));
    const h = Array.from(row, (v) => v.toString(16).padStart(2, '0')).join(' ');
    rows.push(`  ${i.toString(16).padStart(8, '0')}  ${h}`);
  }
  return rows.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function stopWithBudget(dev: Device, budgetMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      dev.stop(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`stop did not finish within ${budgetMs} ms`)), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function bytesEqual(a: Uint8Array, b: number[]): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Collect a fixed duration of streaming and keep the head of the stream. */
async function capture(
  dev: Slogic16U3,
  cfg: CaptureConfig,
  ms: number,
  testMode: number,
): Promise<{ head: Uint8Array; stats: ReturnType<Slogic16U3['getStats']> }> {
  const keep = new Uint8Array(256);
  let kept = 0;
  let total = 0;

  await dev.start(
    cfg,
    (chunk) => {
      total += chunk.length;
      if (kept < keep.length) {
        const take = Math.min(keep.length - kept, chunk.length);
        keep.set(chunk.subarray(0, take), kept);
        kept += take;
      }
    },
    undefined,
    { testMode },
  );

  await sleep(ms);
  await dev.stop();

  const stats = dev.getStats();
  if (total !== stats.sinkBytes) {
    throw new Error(`sink accounting mismatch: sink saw ${total}, device counted ${stats.sinkBytes}`);
  }
  return { head: keep.subarray(0, kept), stats };
}

function record(name: string, pass: boolean, detail: Record<string, unknown>): void {
  checks.push({ name, pass, ...detail });
  line(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`, pass ? 'ok' : 'bad');
}

async function run(dev: Slogic16U3): Promise<void> {
  connectEl.hidden = true;
  report.device = { name: dev.name, serial: dev.serial };
  line(`device: ${dev.name}  serial ${dev.serial}`, 'ok');
  const model = modelForMaxChannels(dev.maxChannels);
  report.model = model;
  line(`self-test plan: ${deviceLabel(model)}`, 'dim');

  dev.onError = (e) => line(`  device error: ${e}`, 'bad');

  // ---------------------------------------------------------------- pure math
  head('0. threshold mapping (pure, no hardware)');
  {
    const c = vrefCode(1.6);
    const v = vrefVolts(c);
    // libsigrok api.c:1447: (1.6 - 0.4318) / 0.005166 = 226.13 -> code 226,
    // which reads back as 0.005166 * 226 + 0.4318 = 1.599316 V.
    const pass = c === 226 && Math.abs(v - 1.599316) < 1e-6;
    line(`  1.600 V -> code ${c} -> ${v.toFixed(4)} V`);
    record('vref mapping matches api.c:1447', pass, { code: c, volts: v });
  }

  head('0b. sub-8-channel expansion (pure, no hardware)');
  {
    // The emulation counter descends 7,6,5,4,3,2,1,0 then 15..8. At 4 channels
    // the device packs two samples per byte, low nibble first, so the wire
    // bytes for that sequence are 0x67 0x45 0x23 0x01 0xef 0xcd 0xab 0x89.
    const raw = Uint8Array.of(0x67, 0x45, 0x23, 0x01, 0xef, 0xcd, 0xab, 0x89);
    const got = expandPacked(raw, 4);
    const want = [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8];
    line(`  4ch: ${Array.from(got).join(',')}`);
    record('expandPacked(4ch) matches api.c:880', bytesEqual(got, want), {
      got: Array.from(got),
    });
    const raw2 = Uint8Array.of(0x1b, 0x1b);
    const got2 = expandPacked(raw2, 2);
    record('expandPacked(2ch) packs 4 samples per byte', bytesEqual(got2, [3, 2, 1, 0, 3, 2, 1, 0]), {
      got: Array.from(got2),
    });
    const raw3 = Uint8Array.of(1, 2, 3);
    record('expandPacked(8ch) is a pass-through', expandPacked(raw3, 8) === raw3, {});
  }

  const widths = liveWidths(model);
  for (let w = 0; w < widths.length; w++) {
    const ch = widths[w];
    head(`${w === 0 ? '1' : '1b'}. ${ch} ch @ 16 MHz, 1.6 V threshold, 2 s of live capture`);
    const cfg: CaptureConfig = { channels: ch, samplerate: 16e6, thresholdVolts: 1.6 };
    const { head: h, stats } = await capture(dev, cfg, 2000, TEST_MODE_NORMAL);
    line(`  bytes received : ${stats.rawBytes.toLocaleString()} raw / ${stats.sinkBytes.toLocaleString()} to sink`);
    line(`  transfers      : ${stats.transfers} (${stats.shortTransfers} short)`);
    line(`  elapsed        : ${stats.elapsedMs.toFixed(1)} ms, first byte at ${stats.firstByteMs?.toFixed(1)} ms`);
    line(`  sustained      : ${stats.rawMBps.toFixed(2)} MB/s incl. start-up, ${stats.steadyMBps.toFixed(2)} MB/s steady`);
    line(`  first 64 bytes after the head drop:`);
    line(hexdump(h, 64), 'dim');
    report[`capture${ch}`] = { ...stats, headHex: Array.from(h.subarray(0, 32)) };

    const bytesPerSample = bytesPerSampleForChannels(ch);
    const expected = (16e6 * bytesPerSample) / 1e6;
    const pass = stats.steadyMBps > expected * 0.97 && stats.steadyMBps < expected * 1.03;
    record(`${ch}ch@16MHz delivers ${expected} MB/s (+-3%)`, pass, {
      steadyMBps: stats.steadyMBps,
    });
    record(
      `${ch}ch drops exactly 4 head bytes across the whole acquisition`,
      stats.rawBytes - stats.sinkBytes === 4,
      { raw: stats.rawBytes, sink: stats.sinkBytes, diff: stats.rawBytes - stats.sinkBytes },
    );
    record(`${ch}ch sink data is a whole number of samples`, stats.sinkBytes % bytesPerSample === 0, {
      sinkBytes: stats.sinkBytes,
    });
  }

  // ------------------------------------- byte-exact control vs the native path
  head('2. emulation pattern - byte-exact control against sigrok-cli');
  {
    const cfg: CaptureConfig = { channels: 16, samplerate: 16e6, thresholdVolts: 1.6 };
    const { head: h, stats } = await capture(dev, cfg, 250, TEST_MODE_EMULATION);
    line(hexdump(h, 32), 'dim');
    // sigrok-cli -d sipeed-slogic-analyzer --config pattern=Emulation --samples 32
    // gives 0700 0600 0500 0400 0300 0200 0100 0000 0f00 0e00 ... deterministically.
    const want = [0x07, 0x00, 0x06, 0x00, 0x05, 0x00, 0x04, 0x00, 0x03, 0x00, 0x02, 0x00,
                  0x01, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x0e, 0x00];
    if (emulationAnchor(model) === 'native') {
      record('16ch emulation head matches the native driver byte for byte', bytesEqual(h, want), {
        got: Array.from(h.subarray(0, 20)),
        want,
      });
    } else {
      const words: number[] = [];
      for (let i = 0; i + 1 < h.length && words.length < 12; i += 2) {
        words.push(h[i] | (h[i + 1] << 8));
      }
      report.emu16Sawtooth = sawtoothOk(words, 12);
      record('16ch emulation delivers data at 16 MHz', stats.rawBytes > 1_000_000, {
        rawBytes: stats.rawBytes,
        transfers: stats.transfers,
      });
      record('16ch emulation sustains 32 MB/s (+-3%)',
        stats.steadyMBps > 32 * 0.97 && stats.steadyMBps < 32 * 1.03,
        { steadyMBps: stats.steadyMBps });
      report.emu16Stats = stats;
    }
    report.emu16Hex = Array.from(h.subarray(0, 32));
  }

  if (emulationWidths(model).includes(8)) {
    head('3. emulation pattern at 8 channels (1 byte per sample on the wire)');
    const cfg: CaptureConfig = { channels: 8, samplerate: 16e6, thresholdVolts: 1.6 };
    const { head: h, stats } = await capture(dev, cfg, 250, TEST_MODE_EMULATION);
    line(hexdump(h, 32), 'dim');
    const want = [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8];
    record('8ch emulation head is the descending counter', bytesEqual(h, want), {
      got: Array.from(h.subarray(0, 16)),
    });
    // 8 channels at 16 MHz is half the wire rate of 16 channels.
    const pass = stats.steadyMBps > 15.5 && stats.steadyMBps < 16.5;
    record('8ch@16MHz delivers 16 MB/s', pass, { steadyMBps: stats.steadyMBps });
    report.emu8Hex = Array.from(h.subarray(0, 32));
    report.emu8Stats = stats;
  }

  if (emulationWidths(model).includes(4)) {
    head('4. emulation pattern at 4 channels (2 samples per byte, expanded here)');
    const cfg: CaptureConfig = { channels: 4, samplerate: 16e6, thresholdVolts: 1.6 };
    const { head: h, stats } = await capture(dev, cfg, 250, TEST_MODE_EMULATION);
    line(hexdump(h, 32), 'dim');
    const want = [7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10, 9, 8];
    record('4ch emulation head expands to the descending counter', bytesEqual(h, want), {
      got: Array.from(h.subarray(0, 16)),
    });
    // 4 channels at 16 MHz is 8 MB/s on the wire, 16 MB/s after expansion.
    const pass = stats.steadyMBps > 7.5 && stats.steadyMBps < 8.5;
    record('4ch@16MHz delivers 8 MB/s on the wire', pass, { steadyMBps: stats.steadyMBps });
    record('4ch expands 2x', stats.sinkBytes >= (stats.rawBytes - 4) * 2 - 8, {
      raw: stats.rawBytes,
      sink: stats.sinkBytes,
    });
    report.emu4Hex = Array.from(h.subarray(0, 32));
    report.emu4Stats = stats;
  }

  for (const ch of emulationProbeWidths(model)) {
    head(`4p. emulation probe at ${ch} channels (measurement only)`);
    const cfg: CaptureConfig = { channels: ch, samplerate: 16e6, thresholdVolts: 1.6 };
    const { head: h, stats } = await capture(dev, cfg, 250, TEST_MODE_EMULATION);
    line(hexdump(h, 32), 'dim');
    line(
      `  ${ch}ch emulation delivered ${stats.rawBytes.toLocaleString()} B in ` +
        `${stats.transfers} transfer(s), steady ${stats.steadyMBps.toFixed(1)} MB/s`,
      'warn',
    );
    report[`emu${ch}Hex`] = Array.from(h.subarray(0, 32));
    report[`emu${ch}Stats`] = stats;
  }

  if (emulationWidths(model).includes(32)) {
    head('4b. emulation pattern at 32 channels (4 bytes per sample on the wire)');
    const cfg: CaptureConfig = { channels: 32, samplerate: 16e6, thresholdVolts: 1.6 };
    const { head: h, stats } = await capture(dev, cfg, 250, TEST_MODE_EMULATION);
    line(hexdump(h, 32), 'dim');
    const lows: number[] = [];
    for (let i = 0; i + 3 < h.length && lows.length < 8; i += 4) {
      lows.push(h[i] | (h[i + 1] << 8));
    }
    report.emu32Sawtooth = sawtoothOk(lows, 8);
    const pass = stats.steadyMBps > 62 && stats.steadyMBps < 66;
    record('32ch@16MHz delivers 64 MB/s', pass, { steadyMBps: stats.steadyMBps });
    record('32ch sink data is a whole number of samples', stats.sinkBytes % 4 === 0, {
      sinkBytes: stats.sinkBytes,
    });
    report.emu32Hex = Array.from(h.subarray(0, 32));
    report.emu32Stats = stats;
  }

  // ------------------------------------------------------- throughput ceiling
  head('5. sustained throughput at every capture width');
  {
    const results: Record<string, unknown>[] = [];
    for (const p of throughputPlan(model)) {
      const cfg: CaptureConfig = { channels: p.channels, samplerate: p.samplerate, thresholdVolts: 1.6 };
      const wire = (p.samplerate * p.channels) / 8 / 1e6;  // MB/s the device emits
      const toSink = p.channels < 8 ? wire * (8 / p.channels) : wire; // MB/s after expandPacked
      const label = `${(p.samplerate / 1e6).toString().padStart(3)} MHz x${String(p.channels).padStart(2)}`;
      try {
        const { stats } = await capture(dev, cfg, 3000, TEST_MODE_NORMAL);
        const loss = 100 * (1 - stats.steadyMBps / wire);
        line(
          `  ${label} : wire ${wire.toFixed(0)} MB/s (sink ${toSink.toFixed(0)}), ` +
            `sustained ${stats.steadyMBps.toFixed(1)} MB/s (${loss.toFixed(1)}% short), ` +
            `${stats.transfers} transfers, ${stats.shortTransfers} short  [${p.note}]`,
          loss > 3 || stats.shortTransfers > 0 ? 'bad' : 'ok',
        );
        results.push({ channels: p.channels, rate: p.samplerate, wireMBps: wire, sinkMBps: toSink, ...stats });
        if (p.assert) {
          record(
            `${p.channels}ch@${p.samplerate / 1e6}MHz sustains ${wire.toFixed(0)} MB/s (+-3%, no short transfers)`,
            loss < 3 && stats.shortTransfers === 0,
            { channels: p.channels, rate: p.samplerate, wireMBps: wire, steadyMBps: stats.steadyMBps, short: stats.shortTransfers },
          );
        }
      } catch (e) {
        line(`  ${label} : FAILED - ${e}`, 'bad');
        results.push({ channels: p.channels, rate: p.samplerate, wireMBps: wire, error: String(e) });
        if (p.assert) {
          record(`${p.channels}ch@${p.samplerate / 1e6}MHz sustains ${wire.toFixed(0)} MB/s`, false,
            { channels: p.channels, rate: p.samplerate, error: String(e) });
        }
      }
    }
    report.throughput = results;
    const best = results
      .map((r) => (typeof r.steadyMBps === 'number' ? r.steadyMBps : 0))
      .reduce((a, b) => Math.max(a, b), 0);
    line(`  peak sustained over WebUSB: ${best.toFixed(1)} MB/s`, 'warn');
    report.peakMBps = best;
  }

  // ------------------------------------------------------------ error surface
  head('6. bad configuration is rejected, not silently clamped');
  {
    for (const rc of refusalCases(model)) {
      let threw = '';
      try {
        await dev.start({ channels: rc.channels, samplerate: rc.samplerate, thresholdVolts: 1.6 }, () => {});
        await dev.stop();
      } catch (e) {
        threw = String(e);
      }
      record(rc.label, threw.includes(rc.reason), { threw });
    }
  }

  await finish(() => dev.close());
}

function formatTrace(e: TraceEntry): string {
  const where = e.addr === undefined ? '' : ` 0x${e.addr.toString(16).padStart(4, '0')}`;
  const bytes = e.bytes === undefined ? '' : ` ${e.bytes}`;
  return `${e.dir}${where}${bytes}${e.note ? ` ${e.note}` : ''}`;
}

interface ScenarioHooks {
  subscribeTrace: (push: (text: string) => void) => void;
  close: () => void | Promise<void>;
}

async function runStopScenario(
  dev: Device, scenario: StopScenario, model: SelftestModel, hooks: ScenarioHooks,
): Promise<void> {
  connectEl.hidden = true;
  report.device = { name: dev.name, serial: dev.serial };
  report.model = model;
  report.scenario = `stop-${scenario.channels}`;
  report.layer = scenario.layer;
  line(`device: ${dev.name}  serial ${dev.serial}`, 'ok');
  dev.onError = (e) => line(`  device error: ${e}`, 'bad');

  const trace: string[] = [];
  let traceShifted = 0;
  hooks.subscribeTrace((text) => {
    trace.push(text);
    if (trace.length > 400) {
      trace.shift();
      traceShifted++;
    }
  });

  const cfg: CaptureConfig = {
    channels: scenario.channels,
    samplerate: scenario.mhz * 1e6,
    thresholdVolts: 1.6,
  };
  let bytes = 0;
  const sink = (chunk: Uint8Array): void => {
    bytes += chunk.length;
  };

  const timing = scenarioTiming(scenario.channels, scenario.mhz);
  head(`stop scenario: ${scenario.channels} ch @ ${scenario.mhz} MHz, ${scenario.ms} ms of capture, then stop`);
  await dev.start(cfg, sink);
  await sleep(scenario.ms);
  const bytesAtStop = bytes;
  let bytesAtStopResolve = bytes;
  const traceAtStop = trace.length + traceShifted;
  line(`  captured ${bytesAtStop.toLocaleString()} B before stop`);
  record('the capture delivered data before stop', bytesAtStop > 0, { bytes: bytesAtStop });

  const STOP_BUDGET_MS = 5000;
  const stopStarted = performance.now();
  let stopMs = NaN;
  let stopError = '';
  try {
    await stopWithBudget(dev, STOP_BUDGET_MS);
    stopMs = performance.now() - stopStarted;
  } catch (e) {
    stopError = String(e);
  }
  if (stopError === '') bytesAtStopResolve = bytes;
  record('stop() completes within the budget', stopError === '', {
    stopMs: Number.isNaN(stopMs) ? 'timeout' : Math.round(stopMs),
    stopError,
  });

  await sleep(250);
  record('the stream is silent after stop', bytes === bytesAtStopResolve, {
    bytesAtStop,
    bytesAtStopResolve,
    bytesAfter: bytes,
  });

  report.trace = trace.slice(...traceWindow(trace.length, traceShifted, traceAtStop, 20));

  let reuseError = '';
  const bytesBeforeReuse = bytes;
  let reuseStats: unknown;
  try {
    await dev.start(cfg, sink);
    const deadline = performance.now() + timing.reuseDeadlineMs;
    while (bytes === bytesBeforeReuse && performance.now() < deadline) await sleep(50);
    await stopWithBudget(dev, STOP_BUDGET_MS);
  } catch (e) {
    reuseError = String(e);
  }
  const readStats = (dev as { getStats?: () => unknown }).getStats;
  if (readStats) reuseStats = await Promise.resolve(readStats.call(dev)).catch(() => undefined);
  record('the device starts a new capture after stop', reuseError === '' && bytes > bytesBeforeReuse, {
    reuseError,
    reuseBytes: bytes - bytesBeforeReuse,
    reuseDeadlineMs: timing.reuseDeadlineMs,
    reuseStats,
  });

  await finish(hooks.close);
}

async function finish(close: () => void | Promise<void>): Promise<void> {
  head('done');
  const failed = checks.filter((c) => !c.pass);
  report.failed = failed.length;
  line(
    `${checks.length - failed.length}/${checks.length} checks passed`,
    failed.length ? 'bad' : 'ok',
  );
  for (const f of failed) line(`  FAILED: ${f.name}`, 'bad');

  await close();

  try {
    await fetch(RESULT_SINK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report, null, 2),
    });
    line('results posted to the collector', 'dim');
  } catch {
    line('result collector not running; results are on this page only', 'dim');
  }
}

async function main(): Promise<void> {
  if (!navigator.usb) {
    line('WebUSB is not available. Use Brave or another Chromium browser.', 'bad');
    return;
  }

  let scenario: ScenarioRequest;
  try {
    scenario = parseScenario(location.search);
  } catch (e) {
    line(`bad scenario parameters: ${e}`, 'bad');
    throw e;
  }
  if (scenario.kind !== 'full') {
    line(
      `scenario: stop-${scenario.channels}, ${scenario.ms} ms @ ${scenario.mhz} MHz, ${scenario.layer} layer`,
      'warn',
    );
  }

  const granted = (await navigator.usb.getDevices())
    .filter((d) => USB_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
  if (granted.length > 0) {
    line(`permission already granted for ${granted.length} device(s); no click needed`, 'dim');
    await dispatch(granted[0], scenario);
    return;
  }

  line('No device permission yet for this origin.', 'warn');
  line('Click the button once and pick your SLogic U3 in the chooser.', 'warn');
  connectEl.hidden = false;
  connectEl.addEventListener('click', () => {
    // Errors here must not be swallowed: an empty chooser or a cancelled pick
    // has to be visible.
    navigator.usb.requestDevice({ filters: USB_FILTERS })
      .then((usb) => dispatch(usb, scenario))
      .catch((e) => {
        line(`connect failed: ${e}`, 'bad');
        console.error(e);
        connectEl.hidden = false;
      });
  });
}

async function dispatch(usb: USBDevice, scenario: ScenarioRequest): Promise<void> {
  if (scenario.kind === 'full') {
    const dev = new Slogic16U3(usb);
    await dev.open();
    await run(dev);
    return;
  }
  const model = modelForProductId(usb.productId);
  if (scenario.layer === 'page') {
    const dev = new Slogic16U3(usb);
    await dev.open();
    await runStopScenario(dev, scenario, model, {
      subscribeTrace: (push) => {
        dev.onTrace = (e) => push(formatTrace(e));
      },
      close: () => dev.close(),
    });
    return;
  }
  let worker: WorkerSlogicDevice;
  try {
    worker = await WorkerSlogicDevice.open({ vendorId: usb.vendorId, productId: usb.productId });
  } catch (e) {
    connectEl.hidden = true;
    report.device = { name: usb.productName, serial: usb.serialNumber };
    report.model = model;
    report.scenario = `stop-${scenario.channels}`;
    report.layer = scenario.layer;
    record('worker transport opens the granted device', false, { error: String(e) });
    await finish(() => {});
    return;
  }
  await runStopScenario(worker, scenario, model, {
    subscribeTrace: (push) => {
      worker.onTrace = (message) => push(formatTrace(message.entry));
    },
    close: () => worker.terminate(),
  });
}

main().catch((e) => {
  line(`self test aborted: ${e}`, 'bad');
  console.error(e);
  report.aborted = String(e);
  void fetch(RESULT_SINK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report, null, 2),
  }).catch(() => {});
});
