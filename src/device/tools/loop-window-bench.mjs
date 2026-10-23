// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Sweeps the loop display window across the 8-channel rate table, running
 * `loopWindowHarness.ts` in a browser page: per cell both transport arms capture,
 * retain, drop, rebuild and draw for long enough to fire several drops. Prints the
 * cells as JSON, then a table with the scope bar (sustained >= 99% of offered, worst
 * stall < 100 ms) and the largest passing window per rate.
 *
 * The harness needs a real browser and a dev server for the module graph, so this
 * attaches to an already-running Chromium that has the app open:
 *
 *   npm run dev
 *   chromium --headless=new --remote-debugging-port=9236 --user-data-dir=/tmp/lw-gpu \
 *            --use-angle=gl --enable-gpu --ignore-gpu-blocklist http://127.0.0.1:5173/
 *   node src/device/tools/loop-window-bench.mjs 9236 [--quick]
 */

const port = process.argv[2] ?? '9236';
const quick = process.argv.includes('--quick');

const RATES = quick ? [25e6, 100e6, 400e6] : [25e6, 50e6, 100e6, 200e6, 400e6];
const WINDOWS_S = quick ? [1, 4] : [0.5, 1, 2, 4, 8, 16, 32];

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'));
if (!page) {
  console.error(`no 127.0.0.1:5173 page on port ${port}; open the app there first`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

const cellRows = await new Promise((ok, bad) => {
  const expression = `(() => {
    return import('/src/ui/state.ts').then((m) => ${JSON.stringify(RATES)}.map((rate) => ({
      rate,
      maxSeconds: m.maxLoopSeconds(8, rate),
      windows: ${JSON.stringify(WINDOWS_S)}
        .filter((w) => w <= m.maxLoopSeconds(8, rate))
        .map((w) => m.loopRetentionSamples(w, 8, rate)),
    })));
  })()`;
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    if (message.result?.exceptionDetails) bad(new Error(JSON.stringify(message.result.exceptionDetails)));
    else ok(message.result?.result?.value);
  };
  ws.send(JSON.stringify({
    id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
  }));
});

const cells = [];
for (const row of cellRows ?? []) {
  const swept = row.windows.map((retention) => ({
    rate: row.rate, retention, seconds: Math.ceil((4 * retention) / row.rate + 2), display: true,
  }));
  cells.push(...swept);
  if (swept.length) {
    const retention = swept[swept.length - 1].retention;
    cells.push({ rate: row.rate, retention, seconds: Math.ceil((3 * retention) / row.rate + 2), display: false });
  }
}
if (!cells.length) {
  console.error('the in-page retention helpers returned no cells');
  process.exit(2);
}

let msgId = 1;
function evalInPage(expression, timeoutMs) {
  const id = ++msgId;
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`cell timed out after ${timeoutMs} ms`)), timeoutMs);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.result?.exceptionDetails) {
        bad(new Error(`page evaluation failed: ${JSON.stringify(message.result.exceptionDetails)}`));
        return;
      }
      ok(message.result?.result?.value);
    };
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

const results = [];
for (const cell of cells) {
  const expression = `(async () => {
    const m = await import('/src/device/tools/loopWindowHarness.ts');
    const base = { samplerate: ${cell.rate}, retentionSamples: ${cell.retention}, seconds: ${cell.seconds}, display: ${cell.display} };
    const out = {};
    try { out.page = await m.runLoopArm({ ...base, transport: 'page' }); }
    catch (e) { out.page = { error: String(e) }; }
    try { out.worker = await m.runLoopArm({ ...base, transport: 'worker' }); }
    catch (e) { out.worker = { error: String(e) }; }
    return out;
  })()`;
  const value = await evalInPage(expression, (cell.seconds * 2 + 90) * 1000);
  if (!value) {
    console.error(`no result for ${cell.rate} retention ${cell.retention}`);
    continue;
  }
  results.push({ rate: cell.rate, retention: cell.retention, control: !cell.display, page: value.page, worker: value.worker });
  console.error(`done: ${(cell.rate / 1e6).toFixed(0)} MHz, window ${(cell.retention / cell.rate).toFixed(2)} s${cell.display ? '' : ' (control)'}`);
}
ws.close();

console.log(JSON.stringify({ cells: results }, null, 2));

const pass = (r) => r && !r.error && r.sustainedMBps >= 0.99 * r.expectedMBps &&
  Math.max(r.threadStallMaxMs, r.pageStallMaxMs) < 100 && r.rebuildMissedDrops === 0;
const fmtSamples = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} G` : `${(n / 1e6).toFixed(1)} M`);

console.log('\nloop window sweep - scope bar: sustained >= 99% of offered, worst stall < 100 ms, no drop interval missed its rebuild');
for (const cell of results) {
  for (const armName of ['page', 'worker']) {
    const r = cell[armName];
    if (!r) continue;
    const head = `${(cell.rate / 1e6).toFixed(0).padStart(3)} MHz ${(cell.retention / cell.rate).toFixed(2).padStart(6)} s ` +
      `${fmtSamples(cell.retention).padStart(8)} ${(r.path ?? '?').padEnd(7)} ${armName.padEnd(6)}`;
    if (r.error) {
      console.log(`${head}${cell.control ? ' [control]' : ''} ABORTED after ${r.transfers ?? 0} transfers: ${r.error.split(': ').slice(2).join(': ')}`);
      continue;
    }
    console.log(`${head}${cell.control ? ' [control]' : '          '} ${(100 * r.sustainedMBps / r.expectedMBps).toFixed(1).padStart(6)}% ` +
      `stall ${Math.max(r.threadStallMaxMs, r.pageStallMaxMs).toFixed(1).padStart(6)} ms ` +
      `drops ${String(r.drops).padStart(3)} dropMax ${r.dropMsMax.toFixed(1).padStart(6)} ms ` +
      `miss ${String(r.rebuildMissedDrops).padStart(2)} ` +
      `edgeBlank ${(r.display ? (100 * (r.frames ? r.liveEdgeBlankFrames / r.frames : 1)).toFixed(0).padStart(3) + '%' : '   -')} ` +
      `fill ${(r.display ? (100 * r.filledColumns).toFixed(0).padStart(3) + '%' : '  -')} ` +
      `peak ${(r.peakStoreMB / 1e3).toFixed(2).padStart(5)} GB ` +
      `${pass(r) ? 'PASS' : 'FAIL'}`);
  }
}

console.log('\nmax sustained window per rate (fill = mean window coverage at that cell):');
for (const rate of RATES) {
  const cellsAtRate = results.filter((c) => c.rate === rate && !c.control);
  const both = cellsAtRate.filter((c) => pass(c.page) && pass(c.worker));
  const workerOnly = cellsAtRate.filter((c) => pass(c.worker));
  const bestBoth = both.reduce((m, c) => Math.max(m, c.retention), 0);
  const bestWorker = workerOnly.reduce((m, c) => Math.max(m, c.retention), 0);
  const fillOf = (list, best) => {
    const cell = list.find((c) => c.retention === best);
    return cell ? ` fill ${(100 * cell.worker.filledColumns).toFixed(0)}%` : '';
  };
  console.log(`${(rate / 1e6).toFixed(0).padStart(3)} MHz: both arms ${bestBoth ? `${fmtSamples(bestBoth)} (${(bestBoth / rate).toFixed(2)} s)${fillOf(both, bestBoth)}` : 'none'}` +
    `, worker arm ${bestWorker ? `${fmtSamples(bestWorker)} (${(bestWorker / rate).toFixed(2)} s)${fillOf(workerOnly, bestWorker)}` : 'none'}`);
}
