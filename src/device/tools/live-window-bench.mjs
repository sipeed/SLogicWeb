// SPDX-License-Identifier: GPL-3.0-or-later

const port = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '9236';
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const pageFragment = arg('page', '5173');
const seconds = Number(arg('seconds', 1));
const channels = Number(arg('channels', 16));
const samplerate = Number(arg('rate', 16e6));
const viewStartSeconds = Number(arg('start', 0.05));
const viewEndSeconds = Number(arg('end', 0.1));
const enforce = !process.argv.includes('--no-enforce');
if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('invalid --seconds');
if (!(viewEndSeconds > viewStartSeconds)) throw new Error('--end must be after --start');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && t.url.includes(pageFragment));
if (!page) {
  console.error(`no page whose URL contains "${pageFragment}" on port ${port}; open the app there first`);
  process.exit(2);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let msgId = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
};
function send(method, params = {}, timeoutMs = 60_000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalInPage(expression, timeoutMs = 120_000) {
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, timeoutMs);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.bringToFront').catch(() => {});

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
const setup = await evalInPage(`(async () => {
  const m = await import('/src/device/tools/appLoopHarness.ts');
  const probe = await m.startFixedWindowProbe(${JSON.stringify({
    channels, samplerate, viewStartSeconds, viewEndSeconds,
  })});
  window.__lwFixedWindowProbe = probe;
  const rect = document.getElementById('plot').getBoundingClientRect();
  return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
})()`);
if (!setup?.rect) {
  console.error('the fixed-window probe could not be started');
  process.exit(2);
}
const clip = { ...setup.rect, scale: 1 };
const shot = async () => (await send('Page.captureScreenshot', { format: 'png', clip })).data;

const before = await evalInPage('window.__lwFixedWindowProbe.snapshot()');
const shotBefore = await shot();
await new Promise(resolve => setTimeout(resolve, seconds * 1000));
const after = await evalInPage('window.__lwFixedWindowProbe.snapshot()');
const shotAfter = await shot();
await evalInPage(`window.logicweb.debug.setViewportSeconds(${viewStartSeconds + 0.02}, ${viewEndSeconds + 0.02})`);
await new Promise(resolve => setTimeout(resolve, 300));
const shotPanned = await shot();
const finished = await evalInPage(
  'window.__lwFixedWindowProbe.finish().then((r) => { delete window.__lwFixedWindowProbe; return r; })',
);
ws.close();

const delta = (a, b) => b - a;
const layers = Object.fromEntries(Object.entries(after.layers).map(([name, counts]) => [
  name, {
    draws: delta(before.layers[name].draws, counts.draws),
    skips: delta(before.layers[name].skips, counts.skips),
  },
]));
const window = {
  elapsedMs: delta(before.atMs, after.atMs),
  permitted: delta(before.permitted, after.permitted),
  drawn: delta(before.drawn, after.drawn),
  skipped: delta(before.skipped, after.skipped),
  statusRenders: delta(before.statusRenders, after.statusRenders),
  samples: delta(before.samples, after.samples),
  storeLength: delta(before.storeLength, after.storeLength),
  layers,
};
const identical = shotBefore === shotAfter;
const panDiffers = shotAfter !== shotPanned;
const gates = [];
const gate = (name, measured, limit, ok) => gates.push({ name, measured, limit, ok });
gate('live', finished.live, true, finished.live === true);
gate('pageErrors', finished.pageErrors.length, 0, finished.pageErrors.length === 0);
gate('deviceLeak', finished.deviceLeak, false, finished.deviceLeak === false);
gate('follow', after.follow, false, after.follow === false);
gate('captureAdvanced', window.samples, '> 0', window.samples > 0);
gate('statusRenders', window.statusRenders, '>= 1', window.statusRenders >= 1);
gate('wave.draws', window.layers.wave.draws, '= 0', window.layers.wave.draws === 0);
gate('bus.draws', window.layers.bus.draws, '= 0', window.layers.bus.draws === 0);
gate('axis.draws', window.layers.axis.draws, '= 0', window.layers.axis.draws === 0);
gate('overlay.draws', window.layers.overlay.draws, '= 0', window.layers.overlay.draws === 0);
gate('overview.draws', window.layers.overview.draws, '<= 11',
  window.layers.overview.draws <= 11);
if (env.envCapped !== true) {
  gate('wave.skips', window.layers.wave.skips, `>= ${Math.floor(30 * seconds)}`,
    window.layers.wave.skips >= Math.floor(30 * seconds));
}
gate('screenshot.identical', identical, true, identical);
gate('screenshot.afterPanDiffers', panDiffers, true, panDiffers);

const report = {
  page: page.url, env, channels, samplerate, view: after.view, window, gates,
  screenshots: { before: shotBefore.length, after: shotAfter.length, panned: shotPanned.length },
};
console.log(JSON.stringify(report, null, 2));
const head = `${channels}ch/${(samplerate / 1e6).toFixed(0)} MHz fixed [${after.view.start.toFixed(0)}..${after.view.end.toFixed(0)}]`;
console.log(`${head} ` +
  `window ${(window.elapsedMs / 1000).toFixed(2)} s ` +
  `raf ${env.rafCeilingMs.toFixed(1)} ms${env.envCapped ? ' CAPPED' : ''} dpr ${env.dpr} ` +
  `permitted ${window.permitted} drawn ${window.drawn} skipped ${window.skipped} ` +
  `status ${window.statusRenders} ` +
  `wave ${window.layers.wave.draws}/${window.layers.wave.skips} ` +
  `bus ${window.layers.bus.draws}/${window.layers.bus.skips} ` +
  `axis ${window.layers.axis.draws} overlay ${window.layers.overlay.draws} ` +
  `overview ${window.layers.overview.draws}/${window.layers.overview.skips} ` +
  `shot ${identical ? 'identical' : 'DIFFERS'} pan ${panDiffers ? 'differs' : 'SAME'} ` +
  `${gates.every(g => g.ok) ? 'PASS' : 'FAIL'}`);
for (const g of enforce ? gates.filter(g => !g.ok) : gates) {
  console.log(`      ${g.ok ? 'PASS' : 'FAIL'} ${g.name} = ${g.measured} requires ${g.limit}`);
}
if (enforce && gates.some(g => !g.ok)) process.exitCode = 1;
