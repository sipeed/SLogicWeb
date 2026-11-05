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

const expression = `(async () => {
  const m = await import('/src/device/tools/cursorChipsProbeHarness.ts');
  return await m.runCursorChipsProbe();
})()`;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
if (!page) {
  console.error(`no 127.0.0.1:5173 page on port ${port}; open the app there first`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
const reply = await new Promise((ok, bad) => {
  const timer = setTimeout(() => bad(new Error('timed out')), 180_000);
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    ok(message);
  };
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true },
  }));
});
ws.close();

const report = reply.result?.result?.value;
if (!report || !Array.isArray(report.scenes)) {
  console.error(JSON.stringify(reply, null, 2));
  process.exit(1);
}

for (const scene of report.scenes) {
  console.log(`${scene.pass ? 'PASS' : 'FAIL'}  ${scene.name}\n        ${scene.detail}`);
}

const failed = report.scenes.filter((scene) => !scene.pass).length;
console.log(`\n${report.scenes.length - failed}/${report.scenes.length} scenes passed`);
process.exit(failed === 0 ? 0 : 1);
