// SPDX-License-Identifier: GPL-3.0-or-later

const port = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '9236';
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const pageFragment = arg('page', '');
const mode = arg('mode', 'single');
const seconds = Number(arg('seconds', 6));
const channels = Number(arg('channels', 32));
const samplerate = Number(arg('rate', 80e6));
const loopSamples = Number(arg('loop-samples', 2_000_000));
const primeSeconds = process.argv.includes('--start-flash') ? Number(arg('prime', 2)) : 0;
const composite = process.argv.includes('--composite');
const minDrawnHz = Number(arg('min-drawn-hz', 0));
const START_FLASH_WINDOW_MS = 500;
const enforce = !process.argv.includes('--no-enforce');
if (!['single', 'loop'].includes(mode)) throw new Error('--mode must be single or loop');
if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('invalid --seconds');
if (![8, 16, 32].includes(channels)) throw new Error('invalid --channels');
if (!(samplerate > 0) || !Number.isFinite(samplerate)) throw new Error('invalid --rate');
if (!(primeSeconds >= 0) || !Number.isFinite(primeSeconds)) throw new Error('invalid --prime');
if (!(minDrawnHz >= 0) || !Number.isFinite(minDrawnHz)) throw new Error('invalid --min-drawn-hz');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pages = targets.filter(t => t.type === 'page');
const page = pageFragment ? pages.find(t => t.url.includes(pageFragment)) : pages[0];
if (!page) {
  console.error(pageFragment
    ? `no page whose URL contains "${pageFragment}" on port ${port}; open the app there first`
    : `no page target on port ${port}; open the app there first`);
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let msgId = 0;
const pending = new Map();
const handlers = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
    return;
  }
  handlers.get(message.method)?.(message.params ?? {});
};
function send(method, params = {}, timeoutMs = 60_000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function on(method, handler) {
  handlers.set(method, handler);
}
async function evalInPage(expression, timeoutMs = 120_000) {
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Page.bringToFront').catch(() => {});

const rect = await evalInPage(`(() => {
  const r = document.getElementById('plot').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
if (!rect || !(rect.width > 0 && rect.height > 0)) {
  console.error('the plot is not laid out; open the app and let it settle first');
  ws.close();
  process.exit(2);
}

const probeOptions = {
  mode, seconds, channels, samplerate, loopSamples, primeSeconds,
};
await evalInPage(`(async () => {
  const m = await import('/src/device/tools/flickerHarness.ts');
  window.__flickerRect = ${JSON.stringify(rect)};
  window.__flickerDecode = data => m.decodeCompositedFrame(data, window.__flickerRect);
  window.__flickerReport = null;
  window.__flickerError = null;
  window.__flickerProbe = m.runFlickerProbe(${JSON.stringify(probeOptions)})
    .then(r => { window.__flickerReport = r; return r; },
      e => { window.__flickerError = String(e); throw e; })
    .catch(() => null);
  return true;
})()`);

const screencastFrames = [];
let screencastDropped = 0;
let decoding = true;
const decodeQueue = [];
if (composite) {
  on('Page.screencastFrame', params => {
    send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    if (screencastFrames.length >= 4 * 120 * Math.ceil(seconds + primeSeconds + 2)) {
      screencastDropped += 1;
      return;
    }
    screencastFrames.push({ atMs: Math.round(params.metadata.timestamp * 1000), data: params.data });
    if (decodeQueue.length < 240) decodeQueue.push(screencastFrames.length - 1);
  });
  await send('Page.startScreencast', {
    format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: 1920, maxHeight: 1200,
  });
}
const decoded = [];
const decodePump = (async () => {
  while (decoding || decodeQueue.length > 0) {
    const index = decodeQueue.shift();
    if (index === undefined) {
      await sleep(50);
      continue;
    }
    const frame = screencastFrames[index];
    try {
      const reading = await evalInPage(
        `window.__flickerDecode(${JSON.stringify(frame.data)})`, 30_000);
      decoded.push({ atMs: frame.atMs, ...reading });
    } catch (error) {
      decoded.push({ atMs: frame.atMs, error: String(error) });
    }
  }
})();

let report = null;
let probeError = null;
const deadline = Date.now() + (seconds + primeSeconds + 90) * 1000;
while (Date.now() < deadline) {
  const state = await evalInPage(
    '({ report: window.__flickerReport, error: window.__flickerError })');
  if (state.error) { probeError = state.error; break; }
  if (state.report) { report = state.report; break; }
  await sleep(200);
}
if (composite) await send('Page.stopScreencast').catch(() => {});
decoding = false;
await decodePump;

if (probeError || !report) {
  ws.close();
  console.error(`the flicker probe failed: ${probeError ?? 'no report before the deadline'}`);
  process.exit(2);
}

const layers = Object.fromEntries(Object.entries(report.layers).map(([name, counts]) => [
  name, { draws: counts.draws, skips: counts.skips },
]));

let compositeReport = null;
if (composite) {
  const usable = decoded.filter(f => f.mean !== undefined).sort((a, b) => a.atMs - b.atMs);
  const series = usable
    .filter(f => f.atMs >= report.wallStartMs)
    .map(f => ({ atMs: f.atMs - report.wallStartMs, mean: f.mean, bright: f.bright }));
  const startFrame = Math.max(0, series.findIndex(f => f.atMs >= report.captureStartedAtMs));
  const startMs = report.captureStartedAtMs;
  const startWindowFrames = series.filter(
    f => f.atMs >= startMs && f.atMs <= startMs + START_FLASH_WINDOW_MS).length;
  const derived = await evalInPage(`(async () => {
    const m = await import('/src/ui/frameFlicker.ts');
    const means = ${JSON.stringify(series.map(f => f.mean))};
    const start = ${startFrame};
    const window = ${startWindowFrames};
    return {
      outliers: m.brightnessOutliers(means),
      start: m.analyzeCaptureStart(means, start, { windowFrames: window }),
      late: m.analyzeCaptureStart(means, start + window),
    };
  })()`).catch(error => ({ error: String(error) }));
  compositeReport = {
    rect,
    frames: series.length,
    dropped: screencastDropped,
    failedDecodes: decoded.filter(f => f.mean === undefined).length,
    error: derived.error ?? null,
    startFrame,
    startWindowMs: START_FLASH_WINDOW_MS,
    startWindowFrames,
    startFlashFrames: derived.start ? derived.start.outliers.length : null,
    settledMean: derived.start ? derived.start.settledMean : null,
    startFlash: derived.start ? derived.start.outliers.map(o => ({
      atMs: series[o.frame]?.atMs ?? null, mean: o.mean, ratio: o.ratio,
    })) : [],
    lateOutlierFrames: derived.late ? derived.late.outliers.length : null,
    lateOutliers: derived.late ? derived.late.outliers.map(o => ({
      atMs: series[o.frame]?.atMs ?? null, mean: o.mean, ratio: o.ratio,
    })) : [],
    outlierFrames: derived.outliers ? derived.outliers.outliers.length : null,
    median: derived.outliers ? derived.outliers.median : null,
    means: series.map(f => ({ atMs: f.atMs, mean: Number(f.mean.toFixed(2)), bright: f.bright })),
  };
}

const startFlashFrames = compositeReport?.startFlashFrames ?? null;
const gates = [];
const gate = (name, measured, limit, ok) => gates.push({ name, measured, limit, ok });
gate('blankFrames', report.blankFrames, '= 0', report.blankFrames === 0);
gate('live', report.live, true, report.live === true);
gate('pageErrors', report.pageErrors.length, 0, report.pageErrors.length === 0);
gate('deviceLeak', report.deviceLeak, false, report.deviceLeak === false);
gate('samples', report.samples, '> 0', report.samples > 0);
if (report.primeSeconds > 0) {
  gate('noDataRendersAfterStart', report.noDataRendersAfterStart, '= 0',
    report.noDataRendersAfterStart === 0);
}
if (startFlashFrames !== null) {
  gate('startFlashFrames', startFlashFrames,
    `= 0 within ${START_FLASH_WINDOW_MS} ms`, startFlashFrames === 0);
}
if (compositeReport !== null) {
  gate('compositeFrames', compositeReport.frames, '> 0', compositeReport.frames > 0);
  gate('startWindowFrames', compositeReport.startWindowFrames, '> 0',
    compositeReport.startWindowFrames > 0);
  gate('compositeAnalysis', compositeReport.error ?? 'ok', 'ok', compositeReport.error === null);
}
if (minDrawnHz > 0) {
  gate('drawnHz', Number(report.drawnHz.toFixed(2)), `>= ${minDrawnHz}`, report.drawnHz >= minDrawnHz);
}

const head = `${report.channels}ch/${(report.samplerate / 1e6).toFixed(0)} MHz ${report.mode} ` +
  `${(report.elapsedMs / 1000).toFixed(2)} s${report.primeSeconds > 0 ? ` after ${report.primeSeconds} s prime` : ''}`;
const summary = `${head} drawn ${report.drawn} (${report.drawnHz.toFixed(1)} Hz) ` +
  `skipped ${report.skipped} ` +
  `wave ${layers.wave.draws}/${layers.wave.skips} ` +
  `axis ${layers.axis.draws}/${layers.axis.skips} ` +
  `overlay ${layers.overlay.draws}/${layers.overlay.skips} ` +
  `bus ${layers.bus.draws}/${layers.bus.skips} ` +
  `overview ${layers.overview.draws}/${layers.overview.skips} ` +
  `frames ${report.canvasFrames.length} ` +
  `blank ${report.blankFrames} ` +
  `noData ${report.noDataRenders}/${report.noDataRendersAfterStart} ` +
  `hint ${report.hintToggles}/${report.hintVisibleMs} ms ` +
  `${compositeReport
    ? `flash ${compositeReport.startFlashFrames}/${compositeReport.startWindowFrames}` +
      ` late ${compositeReport.lateOutlierFrames} ` +
      `median ${compositeReport.median === null ? '-' : compositeReport.median.toFixed(1)} `
    : 'flash n/a '}` +
  `${gates.every(g => g.ok) ? 'PASS' : 'FAIL'}`;

console.log(JSON.stringify({
  page: page.url,
  mode: report.mode,
  channels: report.channels,
  samplerate: report.samplerate,
  seconds: report.seconds,
  primeSeconds: report.primeSeconds,
  elapsedMs: report.elapsedMs,
  live: report.live,
  drawn: report.drawn,
  drawnHz: report.drawnHz,
  skipped: report.skipped,
  samples: report.samples,
  storeLength: report.storeLength,
  layers,
  blankFrames: report.blankFrames,
  blankHits: report.blankHits.slice(0, 20),
  paintedCanvases: report.paintedCanvases,
  noDataRenders: report.noDataRenders,
  noDataRendersAfterStart: report.noDataRendersAfterStart,
  hintToggles: report.hintToggles,
  hintVisibleMs: report.hintVisibleMs,
  canvasNames: report.canvasNames,
  canvasFrames: report.canvasFrames.length,
  renders: report.renders.length,
  frameCostMs: report.frameStatsAfter.drawMs,
  pageErrors: report.pageErrors,
  deviceLeak: report.deviceLeak,
  composite: compositeReport,
  gates,
}, null, 2));
console.log(summary);
for (const g of enforce ? gates.filter(g => !g.ok) : gates) {
  console.log(`      ${g.ok ? 'PASS' : 'FAIL'} ${g.name} = ${g.measured} requires ${g.limit}`);
}
ws.close();
if (enforce && gates.some(g => !g.ok)) process.exitCode = 1;
