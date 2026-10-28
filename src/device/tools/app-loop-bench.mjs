// SPDX-License-Identifier: GPL-3.0-or-later

const port = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '9236';
const secondsArg = process.argv.find(a => a.startsWith('--seconds='));
const seconds = secondsArg ? Number(secondsArg.split('=')[1]) : 30;
const rateArg = process.argv.find(a => a.startsWith('--rate='));
const selectedRate = rateArg ? Number(rateArg.split('=')[1]) : 0;
if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('invalid --seconds');
if (!Number.isFinite(selectedRate) || selectedRate < 0) throw new Error('invalid --rate');

const cells = [
  { rate: 16e6, minSustainedMBps: 20, minDrawHz: 5 },
  { rate: 80e6, minSustainedMBps: 150, maxDrawHz: 0 },
  { rate: 100e6, minSustainedMBps: 150, maxDrawHz: 0 },
  { rate: 200e6, minSustainedMBps: 150, maxDrawHz: 0 },
].filter(cell => !selectedRate || cell.rate === selectedRate);
if (cells.length === 0) throw new Error('no App loop cells selected');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes('5173'));
if (!page) {
  console.error(`no 127.0.0.1:5173 page on port ${port}; open the app there first`);
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let msgId = 0;
async function evalInPage(expression, timeoutMs) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cell timed out after ${timeoutMs} ms`)), timeoutMs);
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      if (message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message.result.exceptionDetails)));
        return;
      }
      resolve(message.result?.result?.value);
    };
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

const results = [];
for (const cell of cells) {
  const options = {
    samplerate: cell.rate,
    retentionSamples: 16_000_000,
    seconds,
    minSustainedMBps: cell.minSustainedMBps,
    ...(cell.minDrawHz === undefined ? {} : { minDrawHz: cell.minDrawHz }),
    ...(cell.maxDrawHz === undefined ? {} : { maxDrawHz: cell.maxDrawHz }),
  };
  const expression = `(async () => {
    const m = await import('/src/device/tools/appLoopHarness.ts');
    return m.runAppLoopProbe(${JSON.stringify(options)});
  })()`;
  try {
    const report = await evalInPage(expression, (seconds + 90) * 1000);
    results.push(report);
    console.error(`done: ${cell.rate / 1e6} MHz, ${report.pass ? 'PASS' : 'FAIL'}`);
  } catch (error) {
    results.push({ samplerate: cell.rate, error: String(error), pass: false });
    console.error(`done: ${cell.rate / 1e6} MHz, ERROR ${String(error)}`);
  }
}
ws.close();
console.log(JSON.stringify({ cells: results }, null, 2));
for (const r of results) {
  const head = `${(r.samplerate / 1e6).toFixed(0).padStart(3)} MHz`;
  if (r.error) {
    console.log(`${head} ERROR ${r.error}`);
    continue;
  }
  console.log(`${head} sustained ${r.sustainedMBps.toFixed(1).padStart(6)} MB/s ` +
    `quiet ${(r.maxQuietMs / 1000).toFixed(2).padStart(5)} s ` +
    `draw ${r.drawHz.toFixed(1).padStart(4)} Hz ` +
    `queued ${String(r.peakQueuedTransfers).padStart(2)} ` +
    `exact ${r.postStopExact ? 'yes' : 'no'} ` +
    `drop ${r.droppedConsistent ? 'ok' : 'BAD'} ` +
    `retained ${r.retentionBounded ? 'ok' : 'BAD'} ` +
    `errors ${r.pageErrors.length} ` +
    `${r.live ? 'LIVE' : 'STALL'} ${r.pass ? 'PASS' : 'FAIL'}`);
}
if (results.some(r => !r.pass)) process.exitCode = 1;
