// SPDX-License-Identifier: GPL-3.0-or-later

import {
  captureFinishFits,
  captureStartUsesDefaultWindow,
  clampCaptureViewportAnchor,
  type CaptureMode,
  type CaptureStopReason,
} from '../captureViewport.js';

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

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = a >= 0 ? source.indexOf(end, a) : -1;
  return a >= 0 && b > a ? source.slice(a, b) : '';
}

check('only manual capture starts receive the default live window',
  captureStartUsesDefaultWindow('manual') && !captureStartUsesDefaultWindow('repeat'),
  `manual=${captureStartUsesDefaultWindow('manual')}, repeat=${captureStartUsesDefaultWindow('repeat')}`);

{
  const modes: CaptureMode[] = ['single', 'repeat', 'loop'];
  const reasons: CaptureStopReason[] = ['manual', 'completed'];
  const actual = modes.flatMap((mode) => reasons.map((reason) => `${mode}:${reason}=${captureFinishFits(mode, reason)}`));
  const expected = [
    'single:manual=false', 'single:completed=true',
    'repeat:manual=false', 'repeat:completed=false',
    'loop:manual=false', 'loop:completed=false',
  ];
  check('only natural Single completion fits the whole result',
    actual.join('|') === expected.join('|'), actual.join('|'));
}

{
  const anchor = { start: 400, span: 100, followLatest: false };
  const rows = [
    { length: 0, start: 0, end: 100 },
    { length: 250, start: 200, end: 300 },
    { length: 450, start: 400, end: 500 },
    { length: 900, start: 400, end: 500 },
  ];
  const actual = rows.map((row) => {
    const range = clampCaptureViewportAnchor(anchor, row.length);
    return { ...range, span: range.end - range.start };
  });
  const pass = actual.every((range, index) => {
    const expected = rows[index]!;
    return range.start === expected.start && range.end === expected.end && range.span === anchor.span;
  });
  check('manual Repeat anchors clamp from empty to reachable without changing span',
    pass, JSON.stringify(actual));
}

{
  const negative = clampCaptureViewportAnchor({ start: -40, span: 80, followLatest: false }, 500);
  const short = clampCaptureViewportAnchor({ start: 900, span: 200, followLatest: false }, 100);
  check('anchor clamping covers negative origins and captures shorter than the saved view',
    negative.start === 0 && negative.end === 80 && short.start === 0 && short.end === 200,
    `negative=${JSON.stringify(negative)}, short=${JSON.stringify(short)}`);
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const stack = fs.readFileSync('src/ui/waveformStack.ts', 'utf8');

{
  const start = app.split('private async startCapture(')[1]?.split('private enforceLoopRetention')[0] ?? '';
  const finish = app.split('private finishCapture(')[1]?.split('private discardDecodeState')[0] ?? '';
  check('App threads only the Repeat timer through the repeat start origin',
    app.includes("private async startCapture(origin: CaptureStartOrigin = 'manual')") &&
    finish.includes("() => { void this.startCapture('repeat'); }") &&
    start.includes('captureStartUsesDefaultWindow(origin)') &&
    start.includes('Math.round(cfg.samplerate * 0.05)') &&
    start.includes('this.stack.restoreViewport(0, span);') &&
    start.includes('} else if (continuation?.followLatest)') &&
    (app.match(/this\.startCapture\('repeat'\)/g) ?? []).length === 1,
    `start=${start.length}, finish=${finish.length}`);
}

{
  const start = between(app, 'private async startCapture(', 'private enforceLoopRetention');
  const snapshot = between(start, 'const continuation =', 'const store =');
  const manual = between(start, 'if (captureStartUsesDefaultWindow(origin)) {', '} else if (continuation?.followLatest)');
  const follow = between(start, '} else if (continuation?.followLatest) {', '} else {');
  const preserved = between(start, '} else if (continuation?.followLatest) {', 'this.renderPanels();');
  check('Repeat continuation snapshots and restores the exact live viewport intent',
    snapshot.includes('start: this.stack.viewport.start') &&
    snapshot.includes('span: this.stack.viewport.end - this.stack.viewport.start') &&
    snapshot.includes('followLatest: this.stack.followLatest') &&
    snapshot.includes('this.repeatViewportAnchor = continuation;') &&
    follow.includes('this.stack.restoreViewport(0, continuation.span);') &&
    follow.includes('this.setFollow(true);') &&
    preserved.includes('this.repeatViewportAnchor = null;') &&
    preserved.includes('this.restoreRepeatViewport();'),
    `snapshot=${snapshot.length}, follow=${follow.length}`);
  check('manual Start installs the computed window and enables latest-follow',
    manual.includes('this.stack.restoreViewport(0, span);') && manual.includes('this.setFollow(true);'),
    `manual=${manual.length}`);
}

{
  const finish = app.split('private finishCapture(')[1]?.split('private discardDecodeState')[0] ?? '';
  const fitAt = finish.indexOf('this.stack.zoomToFit()');
  const guardAt = finish.indexOf('if (fit)');
  check('finish policy retains Single Fit while Repeat and manual Stop preserve the viewport',
    finish.includes('const fit = captureFinishFits(this.settings.mode, reason)') &&
    guardAt >= 0 && fitAt > guardAt && finish.includes("reason === 'manual' || fit") &&
    finish.includes("this.startCapture('repeat')"),
    `guard=${guardAt}, fit=${fitAt}`);
}

{
  const intentCalls = (app.match(/this\.noteViewportIntent\(\)/g) ?? []).length;
  const sites = [
    between(app, "plot.addEventListener('wheel'", '// One pointer'),
    between(app, 'if (pinch && pointers.size >= 2)', '      if (dragging) {'),
    between(app, '      if (dragging) {', 'this.updateHover'),
    between(app, "this.el.axis.addEventListener('pointermove'", 'const axisEnd'),
    between(app, "if (e.key === 'f')", "if (e.key === ' ')"),
    between(app, "must<HTMLButtonElement>('btn-fit').addEventListener('click'", "must<HTMLButtonElement>('btn-settings').addEventListener('click'"),
    between(app, 'setViewportSeconds: (a: number', 'setMarker:'),
    between(app, 'zoomToAnnotation: (analyzerIndex', 'snapshot:'),
    between(app, 'private focusCursor(', 'private removeCursor('),
  ];
  check('each explicit viewport action invalidates continuation restoration',
    app.includes('private noteViewportIntent()') && intentCalls === 9 &&
    sites.every((site) => site.includes('this.noteViewportIntent();')),
    `intentCalls=${intentCalls}, sites=${sites.map((site) => site.includes('this.noteViewportIntent();')).join(',')}`);
  const dbl = between(app, "plot.addEventListener('dblclick'", '// Dragging the axis');
  check('the double-click placement gesture is not a viewport action',
    dbl.length > 0 && !dbl.includes('noteViewportIntent') && !dbl.includes('zoomToFit'),
    `len=${dbl.length}`);
}

{
  const draw = between(app, 'private draw(): void {', 'private drawLaneSurfaces');
  const syncAt = draw.indexOf('this.stack.syncSize();');
  const restoreAt = draw.indexOf('this.restoreRepeatViewport();');
  const pendingAt = draw.indexOf('this.stack.setViewport(pendingViewport.start, pendingViewport.end);');
  const pendingBody = between(draw, 'if (restorePending && pendingViewport) {', '    } else {');
  check('draw applies width adaptation and toolbar restoration before any live anchor',
    syncAt >= 0 && restoreAt > syncAt && pendingAt > syncAt && pendingAt < restoreAt &&
    !pendingBody.includes('this.restoreRepeatViewport();') &&
    draw.includes('} else {\n      this.restoreRepeatViewport();\n    }'),
    `sync=${syncAt}, pending=${pendingAt}, restore=${restoreAt}, exclusive=${!pendingBody.includes('this.restoreRepeatViewport();')}`);
}

{
  const cases = [
    { body: between(app, 'if (!this.running && !this.stopping && this.repeatTimer.pending) {', 'if (!this.running || this.stopping) return;'), follow: true },
    { body: between(app, "if (reason === 'manual') {", '    this.running = false;'), follow: true },
    { body: between(app, 'private finishCapture(', 'private discardDecodeState'), follow: false },
    { body: between(app, 'private adoptCapture(', 'private save()'), follow: false },
    { body: between(app, 'private discardDevice()', 'private detachDevice()'), follow: false },
    { body: between(app, 'private installDevice(', 'private usbDisconnected('), follow: false },
    { body: between(app, "    } catch (e) {\n      this.repeatTimer.cancel();", '      const armed = this.startMutatedCapture;'), follow: false },
  ];
  const passed = cases.map((entry) => entry.body.includes('this.repeatViewportAnchor = null;') &&
    (!entry.follow || entry.body.includes('this.setFollow(false);')));
  check('each stop, finish, adoption, device and failed-start branch clears its own stale anchor',
    passed.every(Boolean), `controls=${passed.join(',')}`);
}

{
  const note = between(app, 'private noteViewportIntent()', 'private restoreRepeatViewport()');
  const apply = between(app, 'private applySettings(', 'private configureChannel(');
  const restore = between(app, 'private restoreRepeatViewport()', 'private syncMarkerCursor(');
  check('user intent, mode replacement, and anchor restoration own their exact mutations',
    note.includes('this.repeatViewportAnchor = null;') && note.includes('this.setFollow(false);') &&
    apply.includes('if (next.mode !== this.settings.mode) this.repeatViewportAnchor = null;') &&
    restore.includes('if (!anchor || anchor.followLatest) return;') &&
    restore.includes('clampCaptureViewportAnchor(anchor, this.store.length)') &&
    restore.includes('this.stack.restoreViewport(range.start, range.end);') &&
    restore.includes('if (range.start === anchor.start) this.repeatViewportAnchor = null;'),
    `note=${note.length}, apply=${apply.length}, restore=${restore.length}`);
}

check('WaveformStack exposes a master viewport and an App-indirect exact restore path',
  stack.includes('get viewport(): { start: number; end: number }') &&
  stack.includes('return { start: this.view.start, end: this.view.end };') &&
  stack.includes('restoreViewport(start: number, end: number): void') &&
  stack.includes("| 'syncCanvasSize' | 'setViewport' | 'viewport' | 'transform'") &&
  stack.includes('for (const r of this.activeRenderers()) r.transform.set(start, end);') &&
  stack.includes('this.setFollowLatest(false);'),
  'viewport getter, exact restore adapter, and renderer ownership boundary present');

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
