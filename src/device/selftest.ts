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
} from './protocol.js';
import {
  deviceLabel,
  emulationAnchor,
  emulationWidths,
  liveWidths,
  modelForMaxChannels,
  refusalCases,
  throughputPlan,
} from './selftestPlan.js';
import {
  Slogic16U3,
  getGrantedDevices,
  expandPacked,
  requestDevice,
} from './slogic16u3.js';
import type { CaptureConfig } from './types.js';
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

  await new Promise((r) => setTimeout(r, ms));
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
    const { head: h } = await capture(dev, cfg, 250, TEST_MODE_EMULATION);
    line(hexdump(h, 32), 'dim');
    // sigrok-cli -d sipeed-slogic-analyzer --config pattern=Emulation --samples 32
    // gives 0700 0600 0500 0400 0300 0200 0100 0000 0f00 0e00 ... deterministically.
    const want = [0x07, 0x00, 0x06, 0x00, 0x05, 0x00, 0x04, 0x00, 0x03, 0x00, 0x02, 0x00,
                  0x01, 0x00, 0x00, 0x00, 0x0f, 0x00, 0x0e, 0x00];
    record(
      emulationAnchor(model) === 'native'
        ? '16ch emulation head matches the native driver byte for byte'
        : '16ch emulation head is the descending counter',
      bytesEqual(h, want),
      { got: Array.from(h.subarray(0, 20)), want },
    );
    report.emu16Hex = Array.from(h.subarray(0, 32));
  }

  head('3. emulation pattern at 8 channels (1 byte per sample on the wire)');
  {
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

  head('4. emulation pattern at 4 channels (2 samples per byte, expanded here)');
  {
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

  if (emulationWidths(model).includes(32)) {
    head('4b. emulation pattern at 32 channels (4 bytes per sample on the wire)');
    const cfg: CaptureConfig = { channels: 32, samplerate: 16e6, thresholdVolts: 1.6 };
    const { head: h, stats } = await capture(dev, cfg, 250, TEST_MODE_EMULATION);
    line(hexdump(h, 32), 'dim');
    const want = [0x07, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
                  0x05, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00];
    record('32ch emulation head is the descending counter', bytesEqual(h, want), {
      got: Array.from(h.subarray(0, 16)),
    });
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

  head('done');
  const failed = checks.filter((c) => !c.pass);
  report.failed = failed.length;
  line(
    `${checks.length - failed.length}/${checks.length} checks passed`,
    failed.length ? 'bad' : 'ok',
  );
  for (const f of failed) line(`  FAILED: ${f.name}`, 'bad');

  await dev.close();

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

  const granted = await getGrantedDevices();
  if (granted.length > 0) {
    line(`permission already granted for ${granted.length} device(s); no click needed`, 'dim');
    const dev = granted[0];
    await dev.open();
    await run(dev);
    return;
  }

  line('No device permission yet for this origin.', 'warn');
  line('Click the button once and pick your SLogic U3 in the chooser.', 'warn');
  connectEl.hidden = false;
  connectEl.addEventListener('click', () => {
    // Errors here must not be swallowed: an empty chooser or a cancelled pick
    // has to be visible.
    requestDevice()
      .then((d) => run(d as Slogic16U3))
      .catch((e) => {
        line(`connect failed: ${e}`, 'bad');
        console.error(e);
        connectEl.hidden = false;
      });
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
