// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Runs `cursorChipsProbeHarness.ts` in the app page and prints one line per scene.
 *
 * The harness drives the real App with the scripted device, so it needs a browser and a
 * dev server; this attaches to an already-running Chromium that has the app open:
 *
 *   npm run dev
 *   chromium --headless=new --remote-debugging-port=9237 --user-data-dir=/tmp/lw-chips \
 *            --use-angle=gl --enable-gpu --ignore-gpu-blocklist http://127.0.0.1:5173/
 *   node src/device/tools/cursor-chips-probe.mjs 9237
 *
 * Usage: node cursor-chips-probe.mjs [port]
 */

const port = process.argv[2] ?? '9237';

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
if (!page) {
  console.error(`no 127.0.0.1:5173 page on port ${port}; open the app there first`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  entry.ok(message);
};

function send(method, params = {}, timeoutMs = 180_000) {
  const id = nextId++;
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error(`${method} timed out`)), timeoutMs);
    pending.set(id, { ok, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  return reply.result?.result?.value;
}

async function runProbe(set) {
  const expression = `(async () => {
    const m = await import('/src/device/tools/cursorChipsProbeHarness.ts');
    return await m.runCursorChipsProbe(${JSON.stringify(set)});
  })()`;
  const reply = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  const report = reply.result?.result?.value;
  if (!report || !Array.isArray(report.scenes) || report.scenes.length === 0) {
    console.error(JSON.stringify(reply, null, 2));
    process.exit(1);
  }
  return report;
}

const VIEWPORT = `({ innerWidth: window.innerWidth, innerHeight: window.innerHeight,
  devicePixelRatio: window.devicePixelRatio })`;
const show = (view) => view
  ? `innerWidth=${view.innerWidth} innerHeight=${view.innerHeight} dpr=${view.devicePixelRatio}`
  : 'unavailable';

async function waitForBoot(previous, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(`({ origin: performance.timeOrigin,
      ready: document.readyState === 'complete' && !!window.slogicweb &&
        (document.getElementById('plot')?.clientWidth ?? 0) > 0 })`);
    if (state && state.ready && state.origin !== previous) return state.origin;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return null;
}

const scenes = [];
await send('Page.enable');
const firstOrigin = await evaluate('performance.timeOrigin');
await send('Page.navigate', { url: page.url });
let origin = await waitForBoot(firstOrigin);
if (origin === null) {
  console.error('the app did not boot after reloading the page');
  process.exit(1);
}
const start = await evaluate(VIEWPORT);
if (!start || !(start.innerWidth > 0)) {
  console.error(`cannot read the page viewport: ${show(start)}`);
  process.exit(1);
}
const dpr = Number.isFinite(start.devicePixelRatio) ? Math.max(2, start.devicePixelRatio) : 2;
console.log(`viewport before: ${show(start)} override dpr=${dpr}`);

const wide = await runProbe('default');
scenes.push(...wide.scenes);

const chrome = wide.windowWidth - wide.plotWidth;
let windowWidth = 320 + chrome;
let narrow = null;
for (let attempt = 0; attempt < 3; attempt++) {
  if (windowWidth < 240) break;
  await send('Emulation.setDeviceMetricsOverride', {
    width: windowWidth, height: start.innerHeight, deviceScaleFactor: dpr, mobile: false,
  });
  narrow = await runProbe('narrow');
  if (Math.abs(narrow.plotWidth - 320) <= 2) break;
  windowWidth += 320 - narrow.plotWidth;
}

await send('Emulation.clearDeviceMetricsOverride');
await send('Page.reload', {});
const booted = await waitForBoot(origin);
if (booted !== null) origin = booted;
const now = booted !== null ? await evaluate(VIEWPORT) : null;
const restored = Boolean(now) && now.innerWidth === start.innerWidth &&
  now.innerHeight === start.innerHeight &&
  Math.abs(now.devicePixelRatio - start.devicePixelRatio) < 1e-9;
const again = restored ? await runProbe('default') : null;
const drift = again !== null && Math.abs(again.plotWidth - wide.plotWidth) <= 1;

if (narrow) scenes.push(...narrow.scenes);
else {
  scenes.push({
    name: 'narrow',
    pass: false,
    detail: `the window cannot shrink to a 320 px plot (chrome=${chrome})`,
  });
}

console.log(`viewport after:  ${show(now)}`);
console.log(`plotWidth wide:  before narrow=${wide.plotWidth}, after reload=${again?.plotWidth}`);
scenes.push({
  name: 'viewport',
  pass: restored && drift,
  detail: `before: ${show(start)} | after: ${show(now)} | ` +
    `plotWidth before narrow=${wide.plotWidth}, after reload=${again ? again.plotWidth : 'n/a'}`,
});

ws.close();

for (const scene of scenes) {
  console.log(`${scene.pass ? 'PASS' : 'FAIL'}  ${scene.name}\n        ${scene.detail}`);
}

const failed = scenes.filter((scene) => !scene.pass).length;
console.log(`\n${scenes.length - failed}/${scenes.length} scenes passed`);
process.exit(failed === 0 ? 0 : 1);
