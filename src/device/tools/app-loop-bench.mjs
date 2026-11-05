// SPDX-License-Identifier: GPL-3.0-or-later

const port = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '9236';
const secondsArg = process.argv.find(a => a.startsWith('--seconds='));
const seconds = secondsArg ? Number(secondsArg.split('=')[1]) : 30;
const rateArg = process.argv.find(a => a.startsWith('--rate='));
const selectedRate = rateArg ? Number(rateArg.split('=')[1]) : 0;
const channelsArg = process.argv.find(a => a.startsWith('--channels='));
const selectedChannels = channelsArg ? Number(channelsArg.split('=')[1]) : 0;
const pageArg = process.argv.find(a => a.startsWith('--page='));
const pageFragment = pageArg ? pageArg.split('=')[1] : '5173';
const enforce = !process.argv.includes('--no-enforce');
if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('invalid --seconds');
if (!Number.isFinite(selectedRate) || selectedRate < 0) throw new Error('invalid --rate');
if (![0, 8, 16, 32].includes(selectedChannels)) throw new Error('invalid --channels');
if (!pageFragment) throw new Error('invalid --page');

const cells = [
  { channels: 16, rate: 16e6, minSustainedMBps: 20, minDrawHz: 15 },
  { channels: 16, rate: 80e6, minSustainedMBps: 150, maxDrawHz: 0 },
  { channels: 16, rate: 100e6, minSustainedMBps: 150, maxDrawHz: 0 },
  {
    channels: 16, rate: 160e6, minSustainedMBps: 150, maxDrawHz: 0, livenessOnly: true,
    minScheduledHz: 30, maxFrameP50Ms: 12, maxFrameP95Ms: 20,
  },
  { channels: 16, rate: 200e6, minSustainedMBps: 150, maxDrawHz: 0, livenessOnly: true },
  { channels: 8, rate: 100e6, minSustainedMBps: 80, minDrawHz: 15 },
  { channels: 32, rate: 50e6, minSustainedMBps: 150, maxDrawHz: 0, stopBuildTimeoutMs: 15_000 },
  {
    channels: 32, rate: 80e6, minSustainedMBps: 150, maxDrawHz: 0, stopBuildTimeoutMs: 15_000,
    minScheduledHz: 30, maxFrameP50Ms: 12, maxFrameP95Ms: 20,
  },
].filter(cell => (!selectedRate || cell.rate === selectedRate) &&
  (!selectedChannels || cell.channels === selectedChannels));
if (cells.length === 0) throw new Error('no App loop cells selected');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes(pageFragment));
if (!page) {
  console.error(`no page whose URL contains "${pageFragment}" on port ${port}; open the app there first`);
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

let env;
try {
  env = await evalInPage(`(async () => {
    const m = await import('/src/device/tools/appLoopHarness.ts');
    return m.measureAppLoopEnvironment();
  })()`, 240_000);
} catch (error) {
  console.error(`environment measurement failed: ${String(error)}`);
  ws.close();
  process.exit(2);
}
console.error(`env: dpr ${env.dpr}, raf idle ${env.rafCeilingMs.toFixed(1)} ms` +
  `${env.envCapped ? ' (ENV-CAPPED)' : ''}, gpu ${env.gpu}`);

function cellGates(cell, report) {
  const gates = [];
  const gate = (name, measured, limit, ok) => gates.push({ name, measured, limit, ok });
  gate('live', report.live, true, report.live === true);
  gate('postStopExact', report.postStopExact, true, report.postStopExact === true);
  gate('droppedConsistent', report.droppedConsistent, true, report.droppedConsistent === true);
  gate('retentionBounded', report.retentionBounded, true, report.retentionBounded === true);
  gate('pageErrors', report.pageErrors.length, 0, report.pageErrors.length === 0);
  gate('deviceLeak', report.deviceLeak, false, report.deviceLeak === false);
  const minMBps = cell.minSustainedMBps ?? 0;
  const maxMBps = report.expectedMBps * 1.02;
  gate('sustainedMBps', report.sustainedMBps, `${minMBps}..${maxMBps.toFixed(1)}`,
    report.sustainedMBps >= minMBps && report.sustainedMBps <= maxMBps);
  if (cell.livenessOnly !== true) gate('fullRate', report.fullRate, true, report.fullRate === true);
  if (cell.minScheduledHz !== undefined) {
    gate('minScheduledHz', report.scheduledHz, `>= ${cell.minScheduledHz}`,
      report.scheduledHz >= cell.minScheduledHz);
  }
  if (cell.maxFrameP50Ms !== undefined) {
    gate('maxFrameP50Ms', report.frameCostMs.p50, `<= ${cell.maxFrameP50Ms}`,
      report.frameCostMs.p50 <= cell.maxFrameP50Ms);
  }
  if (cell.maxFrameP95Ms !== undefined) {
    gate('maxFrameP95Ms', report.frameCostMs.p95, `<= ${cell.maxFrameP95Ms}`,
      report.frameCostMs.p95 <= cell.maxFrameP95Ms);
  }
  const capped = report.envCapped;
  if (cell.minDrawHz > 0) {
    gate('minDrawHz', report.drawHz, `>= ${cell.minDrawHz}${capped ? ' (env-capped)' : ''}`,
      capped || report.drawHz >= cell.minDrawHz);
  }
  if (cell.maxDrawHz > 0) {
    gate('maxDrawHz', report.drawHz, `<= ${cell.maxDrawHz}${capped ? ' (env-capped)' : ''}`,
      capped || report.drawHz <= cell.maxDrawHz);
  }
  return gates;
}

const results = [];
for (const cell of cells) {
  const options = {
    channels: cell.channels,
    samplerate: cell.rate,
    retentionSamples: 16_000_000,
    seconds,
    minSustainedMBps: cell.minSustainedMBps,
    requireFullRate: cell.livenessOnly !== true,
    env,
    ...(cell.stopBuildTimeoutMs === undefined ? {} : { stopBuildTimeoutMs: cell.stopBuildTimeoutMs }),
  };
  const expression = `(async () => {
    const m = await import('/src/device/tools/appLoopHarness.ts');
    return m.runAppLoopProbe(${JSON.stringify(options)});
  })()`;
  try {
    const report = await evalInPage(expression, (seconds + 90) * 1000);
    const gates = cellGates(cell, report);
    const pass = gates.every(gate => gate.ok);
    results.push({ ...report, gates, pass });
    console.error(`done: ${cell.channels}ch ${cell.rate / 1e6} MHz, ${pass ? 'PASS' : 'FAIL'}`);
  } catch (error) {
    results.push({ channels: cell.channels, samplerate: cell.rate, error: String(error), gates: [], pass: false });
    console.error(`done: ${cell.channels}ch ${cell.rate / 1e6} MHz, ERROR ${String(error)}`);
  }
}
ws.close();
console.log(JSON.stringify({ env, cells: results }, null, 2));
for (const r of results) {
  const head = `${r.channels}ch/${(r.samplerate / 1e6).toFixed(0).padStart(3)} MHz`;
  if (r.error) {
    console.log(`${head} ERROR ${r.error}`);
    continue;
  }
  console.log(`${head} sustained ${r.sustainedMBps.toFixed(1).padStart(6)}/${r.expectedMBps.toFixed(0)} MB/s ` +
    `quiet ${(r.maxQuietMs / 1000).toFixed(2).padStart(5)} s ` +
    `sched ${r.scheduledHz.toFixed(1).padStart(5)} Hz ` +
    `draw ${r.drawHz.toFixed(1).padStart(5)} Hz ` +
    `frame ${r.frameCostMs.p50.toFixed(1).padStart(5)}/${r.frameCostMs.p95.toFixed(1).padStart(5)}/` +
    `${r.frameCostMs.max.toFixed(1).padStart(5)} ms ` +
    `limit ${String(r.limit).padStart(9)} ` +
    `queued ${String(r.peakQueuedTransfers).padStart(2)} ` +
    `exact ${r.postStopExact ? 'yes' : 'no'} ` +
    `drop ${r.droppedConsistent ? 'ok' : 'BAD'} ` +
    `retained ${r.retentionBounded ? 'ok' : 'BAD'} ` +
    `errors ${r.pageErrors.length} ` +
    `leak ${r.deviceLeak ? 'YES' : 'no'} ` +
    `slow ${r.slowTransfers} ` +
    `raf ${r.rafCeilingMs.toFixed(1)}/${r.rafIdleMs.toFixed(1)} ms${r.envCapped ? ' CAPPED' : ''} ` +
    `dpr ${r.dpr} ` +
    `gpu ${r.gpu} ` +
    `${r.live ? 'LIVE' : 'STALL'} ${r.requiresFullRate && r.fullRate ? 'FULL-RATE' : 'LIVENESS-ONLY'} ` +
    `${r.pass ? 'PASS' : 'FAIL'}`);
  for (const gate of enforce ? r.gates.filter(g => !g.ok) : r.gates) {
    console.log(`      ${gate.ok ? 'PASS' : 'FAIL'} ${gate.name} = ${gate.measured} requires ${gate.limit}`);
  }
}
if (enforce && results.some(r => !r.pass)) process.exitCode = 1;
