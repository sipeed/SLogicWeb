// SPDX-License-Identifier: GPL-3.0-or-later

import { createSampleStore } from '../../data/index.js';
import {
  OVERVIEW_MIN_MS, overviewDensity, overviewDue, overviewSampleFromPointer,
  overviewSignature, overviewViewportBox,
} from '../overviewStrip.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

{
  const at = (x: number) => overviewSampleFromPointer(x, 100, 200, 1000);
  const values = [at(100), at(200), at(150), at(0), at(400), at(Number.NaN)];
  const invalid = overviewSampleFromPointer(150, 0, 0, 1000) === 0 &&
    overviewSampleFromPointer(150, 0, 200, 0) === 0;
  const windowed = overviewSampleFromPointer(200, 100, 200, 1000, 500) === 1000 &&
    overviewSampleFromPointer(100, 100, 200, 1000, 500) === 500;
  check('the pointer maps proportionally into the shown window and clamps outside it',
    values[0] === 0 && values[1] === 500 && values[2] === 250 && values[3] === 0 &&
    values[4] === 1000 && Number.isFinite(values[5]) && invalid && windowed,
    values.join(','));
}

{
  const box = (start: number, end: number, length = 1000, width = 500) =>
    overviewViewportBox(start, end, length, width);
  const wide = box(100, 300);
  const narrow = box(500, 501);
  const left = box(-100, 100);
  const right = box(900, 1200);
  const all = box(0, 1000);
  check('the viewport frame clips to the strip and keeps a 3 px minimum width',
    wide.left === 50 && wide.width === 100 &&
    narrow.width === 3 && narrow.left <= 497 &&
    left.left === 0 && left.width === 50 &&
    right.left === 450 && right.width === 50 &&
    all.left === 0 && all.width === 500,
    `${JSON.stringify([wide, narrow, left, right, all])}`);
}

{
  const store = createSampleStore(4, 1e6);
  // 8 samples, bit 0 = channel 0 (always 1), bit 1 = channel 1 (alternating).
  store.append(new Uint8Array([0b0001, 0b0011, 0b0001, 0b0011, 0b0001, 0b0011, 0b0001, 0b0011]));
  const data = overviewDensity(store, [0, 1], 4);
  const allHigh = overviewDensity(store, [0], 4);
  const empty = overviewDensity(store, [], 4);
  const bad = overviewDensity(store, [99], 4);
  const values = [...data.density];
  const highs = [...data.high];
  check('density counts channels with an edge per column and keeps a separate high share',
    data.density.length === 4 &&
    values.every((v) => Math.abs(v - 0.5) < 1e-6) &&
    highs.every((v) => Math.abs(v - 1) < 1e-6) &&
    [...allHigh.density].every((v) => v === 0) &&
    [...allHigh.high].every((v) => Math.abs(v - 1) < 1e-6) &&
    [...empty.density].every((v) => v === 0) && [...empty.high].every((v) => v === 0) &&
    [...bad.density].every((v) => v === 0) && [...bad.high].every((v) => v === 0),
    `edges=${values.join(',')}, highs=${highs.join(',')}, highOnly=${[...allHigh.density].join(',')}`);
}

{
  // A fixed window (the loop window) is summarized on its own, and a window reaching
  // past the retained data leaves the missing columns empty rather than stretching.
  const store = createSampleStore(4, 1e6);
  store.append(Uint8Array.from([1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1]));
  const moving = overviewDensity(store, [0], 4, 0, 8);
  const quiet = overviewDensity(store, [0], 4, 8, 16);
  const partial = overviewDensity(store, [0], 4, 0, 32);
  check('density follows the strip window and leaves uncovered columns empty',
    [...moving.density].every((v) => Math.abs(v - 1) < 1e-6) &&
    quiet.density[0] === 1 && quiet.density.slice(1).every((v) => v === 0) &&
    [...quiet.high].every((v) => Math.abs(v - 1) < 1e-6) &&
    partial.high[0] === 1 && partial.high[1] === 1 && partial.high[3] === 0,
    `moving=${[...moving.density].join(',')}, quiet=${[...quiet.density].join(',')}, ` +
    `partial=${[...partial.high].join(',')}`);
}

{
  const store = createSampleStore(4, 1e6);
  store.append(new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]));
  store.noteGap(0, 4);
  const data = overviewDensity(store, [0], 4);
  const marked = [...data.gaps].filter((v) => v === 1).length;
  const fresh = overviewDensity(store, [0], 4);
  data.density[0] = 99;
  check('gaps are marked separately and the density is a copy, not store scratch',
    marked === 2 && fresh.high[0] === 1,
    `marked=${marked}, fresh=${fresh.density[0]}`);
}

{
  const store = createSampleStore(4, 1e6);
  store.append(new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0]));
  const base = {
    store, channels: [0], viewport: { start: 0, end: 8 }, triggerSample: null,
    originLabel: 'Start', viewportTitle: 'all', dataEnd: 8,
    palette: {
      text: '#fff', text50: '#888', selection: '#0af', warning: '#fa0',
      noDataColor: '#333', gridMinor: '#222', axisTickMajor: '#444',
    },
  } as unknown as Parameters<typeof overviewSignature>[0];
  const sig = overviewSignature(base, 200, 56);
  const same = overviewSignature(base, 200, 56);
  const moved = overviewSignature({ ...base, viewport: { start: 1, end: 9 } }, 200, 56);
  const wider = overviewSignature(base, 201, 56);
  const grown = overviewSignature({ ...base, dataEnd: 9 }, 200, 56);
  check('the strip signature changes only with its inputs',
    sig === same && sig !== moved && sig !== wider && sig !== grown,
    `same=${sig === same}, moved=${sig !== moved}, wider=${sig !== wider}, grown=${sig !== grown}`);
  const first = overviewDue('', Number.NEGATIVE_INFINITY, sig, 0);
  const early = overviewDue(sig, 0, moved, OVERVIEW_MIN_MS - 1);
  const changed = overviewDue(sig, 0, moved, OVERVIEW_MIN_MS);
  const unchanged = overviewDue(sig, 0, sig, OVERVIEW_MIN_MS * 5);
  const forced = overviewDue(sig, 0, moved, 1, true);
  const forcedUnchanged = overviewDue(sig, 0, sig, 1, true);
  check('the overview redraws on a changed signature at most once per 100 ms',
    OVERVIEW_MIN_MS === 100 && first && !early && changed && !unchanged &&
    forced && !forcedUnchanged,
    `first=${first}, early=${early}, changed=${changed}, unchanged=${unchanged}, ` +
    `forced=${forced}, forcedUnchanged=${forcedUnchanged}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const html = fs.readFileSync('index.html', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const overviewAt = html.indexOf('id="overview"');
  const axisAt = html.indexOf('id="axis"');
  const plotColAt = html.indexOf('<div id="plot-col">');
  const panelSplitAt = html.indexOf('id="panel-resizer"');
  const placed = plotColAt >= 0 && overviewAt > plotColAt && axisAt > overviewAt &&
    panelSplitAt > axisAt;
  const styled = sheet.includes('--overview-h: 56px') &&
    sheet.includes('#overview {') && sheet.includes('height: var(--overview-h)') &&
    sheet.includes('top: var(--overview-h);') &&
    sheet.includes('height: calc(var(--axis-h) + var(--overview-h))');
  const wired = app.includes("overview: must<HTMLCanvasElement>('overview')") &&
    app.includes('this.overview = new OverviewStrip(this.el.overview, {') &&
    app.includes('onIntent: () => { this.beginViewportGesture(); }') &&
    app.includes('this.overview.syncSize();') &&
    app.includes('const overviewH = this.el.overview.offsetHeight || 56;') &&
    app.includes('this.el.scroll.clientHeight || 630) - axisH - overviewH - analogH') &&
    app.includes('this.overview.render(state)') &&
    app.includes('this.overview.due(state, performance.now(), force)') &&
    app.includes('private overviewWindow()') &&
    app.includes('windowStart: overviewWindow.start') &&
    app.includes('windowSpan: overviewWindow.span') &&
    app.includes('private centerOverview(sample: number): void') &&
    app.includes('private panOverview(samples: number): void') &&
    app.includes('private zoomOverview(anchor: number, factor: number): void');
  check('the canvas sits above the axis, the sticky geometry accounts for it, and App owns the viewport',
    placed && styled && wired, `placed=${placed}, styled=${styled}, wired=${wired}`);
}


{
  const fs2 = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs2) throw new Error('node fs module unavailable');
  const strip = fs2.readFileSync('src/ui/overviewStrip.ts', 'utf8');
  const scale = strip.includes('computeTicks(') &&
    strip.includes('width, samplerate, 12') &&
    strip.includes('const densityBottom = Math.max(8, height - 16)') &&
    strip.includes('state.windowStart ?? 0') && strip.includes('state.windowSpan ?? length') &&
    strip.includes('ctx.fillText(label') && strip.includes('ticks.pinned');
  const wheelStart = strip.indexOf('private wheelEvent(event: WheelEvent): void {');
  const wheelBody = wheelStart >= 0 ? strip.slice(wheelStart, strip.indexOf('\n  }', wheelStart)) : '';
  const preventAt = wheelBody.indexOf('event.preventDefault();');
  const nativeAt = wheelBody.indexOf("if (action === 'native') return;");
  const blockAt = wheelBody.indexOf("if (action === 'block') return;");
  const dataAt = wheelBody.indexOf('if (!state || state.store.length <= 0) return;');
  // Page zoom is stopped before the data check; the default (no app callback) is the
  // overflowing-rows grammar: plain wheel native, Ctrl zooms, Shift pans.
  const wheel = nativeAt >= 0 && preventAt > nativeAt && blockAt > preventAt && dataAt > blockAt &&
    wheelBody.includes('wheelZooms: false, rowsOverflow: true') &&
    wheelBody.includes("if (action === 'zoom')") && strip.includes('this.cb.onZoom(') &&
    strip.includes('this.cb.onPan(');
  check('the strip carries a fixed trigger-relative time scale and the shared wheel contract',
    scale && wheel, `scale=${scale}, wheel=${wheel}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
