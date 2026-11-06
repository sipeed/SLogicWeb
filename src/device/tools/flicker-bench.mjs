// SPDX-License-Identifier: GPL-3.0-or-later

const port = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '9236';
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const pageFragment = arg('page', '');
const mode = arg('mode', 'single');
const seconds = Number(arg('seconds', 6));
const idleSeconds = Number(arg('idle', 0));
const channels = Number(arg('channels', 32));
const samplerate = Number(arg('rate', 80e6));
const loopSamples = Number(arg('loop-samples', 2_000_000));
const idleMode = idleSeconds > 0;
const primeSeconds = idleMode
  ? Number(arg('prime', 2))
  : (process.argv.includes('--start-flash') ? Number(arg('prime', 2)) : 0);
const composite = process.argv.includes('--composite');
const minDrawnHz = Number(arg('min-drawn-hz', 0));
const START_FLASH_WINDOW_MS = 500;
const IDLE_MIN_FRAMES = 60;
const enforce = !process.argv.includes('--no-enforce');
if (!['single', 'loop'].includes(mode)) throw new Error('--mode must be single or loop');
if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('invalid --seconds');
if (!(idleSeconds >= 0) || !Number.isFinite(idleSeconds)) throw new Error('invalid --idle');
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
const idleForcePrime = process.argv.some(a => a === '--prime' || a.startsWith('--prime='));
const idleOptions = {
  seconds: idleSeconds,
  primeSeconds,
  ...(idleForcePrime ? { forcePrime: true } : {}),
  channels,
  samplerate,
};
await evalInPage(`(async () => {
  const m = await import('/src/device/tools/flickerHarness.ts');
  window.__flickerRect = ${JSON.stringify(rect)};
  window.__flickerDecode = data => m.decodeCompositedFrame(data, window.__flickerRect);
  window.__flickerIdlePush = (mean, atMs) => m.pushIdlePresentedFrame(mean, atMs);
  window.__flickerIdleWindow = () => m.idleMeasurementWindow();
  window.__flickerIdleFrame = async (data, atMs) => {
    const r = await m.decodeCompositedFrame(data, window.__flickerRect);
    return m.pushIdlePresentedFrame(r.mean, atMs);
  };
  window.__flickerReport = null;
  window.__flickerError = null;
  window.__flickerProbe = ${idleMode
    ? `m.runIdleFlickerProbe(${JSON.stringify(idleOptions)})`
    : `m.runFlickerProbe(${JSON.stringify(probeOptions)})`}
    .then(r => { window.__flickerReport = r; return r; },
      e => { window.__flickerError = String(e); throw e; })
    .catch(() => null);
  return true;
})()`);

const screencastFrames = [];
let screencastDropped = 0;
let decoding = true;
const decodeQueue = [];
const decoded = [];
const screencastBudget = idleMode
  ? Math.ceil((idleSeconds + primeSeconds + 8) * 120)
  : 4 * 120 * Math.ceil(seconds + primeSeconds + 2);
if (composite || idleMode) {
  on('Page.screencastFrame', params => {
    send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    if (screencastFrames.length >= screencastBudget) {
      screencastDropped += 1;
      return;
    }
    screencastFrames.push({ atMs: Math.round(params.metadata.timestamp * 1000), data: params.data });
    if (decodeQueue.length < (idleMode ? screencastBudget : 240)) {
      decodeQueue.push(screencastFrames.length - 1);
    }
  });
  await send('Page.startScreencast', {
    format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: 1920, maxHeight: 1200,
  });
}
let decodeFailures = 0;
let firstDecodeError = null;
let prerollSkipped = 0;
let idleWindow = null;
const prerollCutoff = () => idleWindow === null ? -Infinity : idleWindow.startMs - 1000;
const decodePump = (async () => {
  while (decoding || decodeQueue.length > 0) {
    if (idleMode && idleWindow === null) {
      await sleep(50);
      continue;
    }
    const index = decodeQueue.shift();
    if (index === undefined) {
      await sleep(50);
      continue;
    }
    const frame = screencastFrames[index];
    if (idleMode && frame.atMs < prerollCutoff()) {
      prerollSkipped += 1;
      continue;
    }
    try {
      if (idleMode) {
        const pushed = await evalInPage(
          `window.__flickerIdleFrame(${JSON.stringify(frame.data)}, ${frame.atMs})`, 30_000);
        if (pushed !== true) prerollSkipped += 1;
      } else {
        const reading = await evalInPage(
          `window.__flickerDecode(${JSON.stringify(frame.data)})`, 30_000);
        decoded.push({ atMs: frame.atMs, ...reading });
      }
    } catch (error) {
      decodeFailures += 1;
      if (firstDecodeError === null) firstDecodeError = String(error);
      if (!idleMode) decoded.push({ atMs: frame.atMs, error: String(error) });
    }
  }
})();

let report = null;
let probeError = null;
const deadline = Date.now() +
  ((idleMode ? idleSeconds : seconds) + primeSeconds + (idleMode ? 120 : 90)) * 1000;
while (Date.now() < deadline) {
  const state = await evalInPage(
    '({ report: window.__flickerReport, error: window.__flickerError, ' +
    'idleWindow: window.__flickerIdleWindow ? window.__flickerIdleWindow() : null })');
  if (state.idleWindow) idleWindow = state.idleWindow;
  if (state.error) { probeError = state.error; break; }
  if (state.report) { report = state.report; break; }
  await sleep(200);
}
if (composite || idleMode) await send('Page.stopScreencast').catch(() => {});
decoding = false;
await decodePump;

if (probeError || !report) {
  ws.close();
  console.error(`the flicker probe failed: ${probeError ?? 'no report before the deadline'}`);
  process.exit(2);
}

if (idleMode) {
  const gates = [];
  const gate = (name, measured, limit, ok) => gates.push({ name, measured, limit, ok });
  gate('idleOutliers', report.outliers.length, '= 0', report.outliers.length === 0);
  gate('drawnDuringIdle', report.drawnDuringIdle, '= 0', report.drawnDuringIdle === 0);
  gate('paintsDuringIdle', report.paintsDuringIdle, '= 0', report.paintsDuringIdle === 0);
  gate('waveHashChanges', report.waveChangeCount, '= 0', report.waveChangeCount === 0);
  gate('canvasHashChanges', report.canvasChangeCount, '= 0', report.canvasChangeCount === 0);
  gate('idleFrames', report.frames, `>= ${IDLE_MIN_FRAMES}`, report.frames >= IDLE_MIN_FRAMES);
  gate('decodeFailures', decodeFailures, '= 0', decodeFailures === 0);
  gate('idleStimulus', report.pumpTicks, '> 0', report.pumpTicks > 0);
  gate('idleNotRunning', report.running, false, report.running === false);
  gate('idleVisible', report.visibility, 'visible', report.visibility === 'visible');
  gate('pageErrors', report.pageErrors.length, 0, report.pageErrors.length === 0);
  gate('deviceLeak', report.deviceLeak, false, report.deviceLeak === false);
  if (report.primed && report.previousDeviceSerial !== null) {
    gate('deviceRestored', report.deviceRestored, true, report.deviceRestored === true);
  }
  const context = frames => frames.map(frame => ({
    atMs: frame.atMs - report.wallStartMs,
    mean: Number(frame.mean.toFixed(2)),
  }));
  const readings = report.readings;
  const window = report.outliers.map(hit => {
    const index = readings.findIndex(frame => frame.atMs === hit.atMs);
    return {
      atMs: hit.atMs - report.wallStartMs,
      mean: hit.mean,
      ratio: hit.ratio,
      before: index > 0 ? context(readings.slice(Math.max(0, index - 2), index)) : [],
      after: context(readings.slice(index + 1, index + 3)),
    };
  });
  console.log(JSON.stringify({
    page: page.url,
    kind: 'idle',
    seconds: report.seconds,
    primed: report.primed,
    primeSeconds: report.primeSeconds,
    storeLength: report.storeLength,
    frames: report.frames,
    pumpTicks: report.pumpTicks,
    stimulus: report.stimulus,
    visibility: report.visibility,
    screencastFrames: screencastFrames.length,
    screencastDropped,
    decodeFailures,
    firstDecodeError,
    prerollSkipped,
    median: report.median,
    outliers: window,
    drawnDuringIdle: report.drawnDuringIdle,
    skippedDuringIdle: report.skippedDuringIdle,
    statusRendersDuringIdle: report.statusRendersDuringIdle,
    paintsDuringIdle: report.paintsDuringIdle,
    layersDuringIdle: report.layersDuringIdle,
    settleMs: report.settleMs,
    canvasChangeCount: report.canvasChangeCount,
    waveChangeCount: report.waveChangeCount,
    waveReadableSamples: report.waveReadableSamples,
    canvasChanges: report.canvasChanges,
    canvasNames: report.canvasNames,
    waveCanvasNames: report.waveCanvasNames,
    frameCostMs: report.frameStatsAfter.drawMs,
    pageErrors: report.pageErrors,
    deviceLeak: report.deviceLeak,
    deviceRestored: report.deviceRestored,
    previousDeviceSerial: report.previousDeviceSerial,
    gates,
  }, null, 2));
  console.log(`idle ${report.seconds} s frames ${report.frames}/${report.pumpTicks} ticks ` +
    `median ${report.median.toFixed(2)} outliers ${report.outliers.length} ` +
    `drawn ${report.drawnDuringIdle} paints ${report.paintsDuringIdle} ` +
    `status ${report.statusRendersDuringIdle} ` +
    `canvasChanges ${report.canvasChangeCount} waveChanges ${report.waveChangeCount} ` +
    `waveReadable ${report.waveReadableSamples} ` +
    `p50 ${report.frameStatsAfter.drawMs.p50.toFixed(1)} ms ` +
    `p95 ${report.frameStatsAfter.drawMs.p95.toFixed(1)} ms ` +
    `${gates.every(g => g.ok) ? 'PASS' : 'FAIL'}`);
  for (const g of enforce ? gates.filter(g => !g.ok) : gates) {
    console.log(`      ${g.ok ? 'PASS' : 'FAIL'} ${g.name} = ${g.measured} requires ${g.limit}`);
  }
  ws.close();
  process.exitCode = enforce && gates.some(g => !g.ok) ? 1 : 0;
} else {
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
  if (report.previousDeviceSerial !== null) {
    gate('deviceRestored', report.deviceRestored, true, report.deviceRestored === true);
  }
  gate('samples', report.samples, '> 0', report.samples > 0);
  const startKeptPrevious = report.startDisplayedSamples > 0;
  if (startKeptPrevious) {
    gate('noDataEmptyRendersAfterStart', report.noDataEmptyRendersAfterStart, '= 0',
      report.noDataEmptyRendersAfterStart === 0);
  }
  if (startFlashFrames !== null && startKeptPrevious) {
    gate('startFlashFrames', startFlashFrames,
      `= 0 within ${START_FLASH_WINDOW_MS} ms`, startFlashFrames === 0);
  }
  if (compositeReport !== null) {
    gate('compositeFrames', compositeReport.frames, '> 0', compositeReport.frames > 0);
    gate('startWindowFrames', compositeReport.startWindowFrames, '> 0',
      compositeReport.startWindowFrames > 0);
    gate('compositeAnalysis', compositeReport.error ?? 'ok', 'ok', compositeReport.error === null);
    if (startKeptPrevious && compositeReport.lateOutlierFrames !== null) {
      gate('lateOutlierFrames', compositeReport.lateOutlierFrames, '= 0',
        compositeReport.lateOutlierFrames === 0);
    }
  }
  if (minDrawnHz > 0) {
    gate('drawnHz', Number(report.drawnHz.toFixed(2)), `>= ${minDrawnHz}`, report.drawnHz >= minDrawnHz);
  }

  const head = `${report.channels}ch/${(report.samplerate / 1e6).toFixed(0)} MHz ${report.mode} ` +
    `${report.mode === 'loop' ? `win ${report.loopWindowSamples} ` : ''}` +
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
    `noDataEmpty ${report.noDataEmptyRenders}/${report.noDataEmptyRendersAfterStart} ` +
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
    loopWindowSamples: report.loopWindowSamples,
    startDisplayedSamples: report.startDisplayedSamples,
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
    noDataEmptyRenders: report.noDataEmptyRenders,
    noDataEmptyRendersAfterStart: report.noDataEmptyRendersAfterStart,
    hintToggles: report.hintToggles,
    hintVisibleMs: report.hintVisibleMs,
    canvasNames: report.canvasNames,
    canvasFrames: report.canvasFrames.length,
    renders: report.renders.length,
    frameCostMs: report.frameStatsAfter.drawMs,
    pageErrors: report.pageErrors,
    deviceLeak: report.deviceLeak,
    deviceRestored: report.deviceRestored,
    previousDeviceSerial: report.previousDeviceSerial,
    composite: compositeReport,
    gates,
  }, null, 2));
  console.log(summary);
  for (const g of enforce ? gates.filter(g => !g.ok) : gates) {
    console.log(`      ${g.ok ? 'PASS' : 'FAIL'} ${g.name} = ${g.measured} requires ${g.limit}`);
  }
  ws.close();
  if (enforce && gates.some(g => !g.ok)) process.exitCode = 1;
}
