// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * App wiring for the session/view-policy model:
 *   - Capture creates a session, every device RUN begins one sweep;
 *   - a new session starts in FollowLive with the default live window;
 *   - a user pan/zoom is recorded as a Fixed T-relative interval on the next draw;
 *   - the session policy is resolved per draw and falls back without any automatic Fit;
 *   - only a completed Single that was still following fits the whole capture;
 *   - Repeat sweeps keep the session (and its policy), every other end clears it.
 *
 * The pure rules live in capture-session-selftest.ts; this file checks that the App
 * actually routes through them.
 */

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

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const overview = fs.readFileSync('src/ui/overviewStrip.ts', 'utf8');
const stack = fs.readFileSync('src/ui/waveformStack.ts', 'utf8');
const model = fs.readFileSync('src/ui/captureSession.ts', 'utf8');

{
  const start = between(app, 'private async startCapture(', 'private enforceLoopRetention');
  check('Capture creates a session and every RUN begins one sweep',
    start.includes('const newSession = origin !== \'repeat\' || this.session === null') &&
    start.includes('const session = newSession || !this.session ? createSession(mode) : this.session;') &&
    start.includes('this.session = beginSweep(session);') &&
    start.includes('this.viewIntent = false;'),
    `start=${start.length}`);
}

{
  const start = between(app, 'private async startCapture(', 'private enforceLoopRetention');
  const view = between(start, 'if (origin !== \'repeat\' || newSession) {', 'this.renderPanels();');
  check('a new session installs the default live window; Repeat waves keep the view',
    view.includes('const span = Math.max(1000, Math.round(cfg.samplerate * 0.05));') &&
    view.includes('this.stack.restoreViewport(0, span);') &&
    view.includes('this.setFollow(true);') &&
    !start.includes('captureStartUsesDefaultWindow') &&
    !start.includes('repeatViewportAnchor') &&
    !start.includes('continuation'),
    `view=${view.length}`);
}

{
  const note = between(app, 'private beginViewportGesture()', 'private fitViewport()');
  const capture = between(app, 'private captureFixedView()', 'private sessionRetainedSeconds()');
  const apply = between(app, 'private applySessionView()', 'private applyTriggerViewAnchor');
  const draw = between(app, 'private draw(', 'private drawLaneSurfaces');
  const wired = app.includes('private viewIntent = false;') &&
    note.includes('if (this.session) this.viewIntent = true;') &&
    note.includes('this.setFollow(false);') &&
    draw.includes('if (this.viewIntent) this.captureFixedView();') &&
    capture.includes('const origin = this.displayOriginSample();') &&
    capture.includes('(view.start - origin) / sr, (view.end - origin) / sr);') &&
    capture.includes('this.session = sessionWithManualView(session,') &&
    apply.includes('resolveSessionView(session, {') &&
    apply.includes('triggerActive: retained.triggerActive,') &&
    apply.includes('retained: { startSec: retained.startSec, endSec: retained.endSec },') &&
    apply.includes('const range = secondsRangeToSamples(resolved.view, sr);') &&
    apply.includes('this.stack.restoreViewport(start, end);') &&
    apply.includes('if (!this.stack.followLatest) this.setFollow(true);') &&
    draw.includes('this.applySessionView();');
  check('a manual gesture becomes a Fixed T-relative interval and the policy is resolved per draw',
    wired, `note=${note.length}, capture=${capture.length}, apply=${apply.length}, wired=${wired}`);
}

{
  const apply = between(app, 'private applySessionView()', 'private applyTriggerViewAnchor');
  const retained = between(app, 'private sessionRetainedSeconds()', 'private applySessionView()');
  const fallback = apply.includes('this.session = resolved.session;') &&
    apply.includes('resolved.policy.kind === \'fixed\'') &&
    apply.includes('this.stack.followLatest') &&
    retained.includes('const triggerActive = this.triggerSampleIndex !== null;') &&
    retained.includes('const pre = this.captureTriggerBase.preTriggerSamples / sr;') &&
    retained.includes('this.captureLimitSamples - this.captureTriggerBase.preTriggerSamples') &&
    retained.includes('startSec: -pre') &&
    retained.includes('startSec: 0, endSec: this.captureLimitSamples / sr');
  check('the resolved policy is adopted (durable fallback) and the retained range is T-relative',
    fallback, `fallback=${fallback}`);
}

{
  const finish = between(app, 'private finishCapture(', 'private discardDecodeState');
  const fit = between(app, 'private fitViewport()', 'private centerOverview');
  // The one end-of-capture fit is the pure rule's answer, applied once outside the
  // Repeat hand-over branch; nothing else in finishCapture moves the view.
  const fitGate = between(finish, 'const fitsCapture =', 'this.captureLabel =');
  const fitApply = between(finish, '} else {\n      this.session = null;', 'this.relayout();');
  const noAutoFit = !finish.includes('captureFinishFits') &&
    (finish.match(/zoomToFit/g) ?? []).length === 1 &&
    fitGate.includes('sweepEndFitsCapture(this.session, reason, this.viewIntent || !this.stack.followLatest)') &&
    fitGate.includes('!this.captureIsLoop && !this.repeatSession') &&
    fitApply.includes('if (fitsCapture) {') && fitApply.includes('this.stack.zoomToFit();') &&
    !finish.includes('restoreRepeatViewport') && !finish.includes('repeatViewportAnchor') &&
    app.includes('private fitViewport()') && fit.includes('this.stack.zoomToFit();') &&
    fit.includes('this.beginViewportGesture();') &&
    // Fit is a view command: the Loop trigger lock and T survive it.
    !fit.includes('this.triggerViewLock = null;') &&
    fit.includes('this.triggerViewOffsetStart = -lock.fraction * this.loopRetentionLen;');
  check('Fit is explicit; a sweep end fits only through the completed-Single rule',
    noAutoFit, `noAutoFit=${noAutoFit}, gate=[${fitGate}], apply=[${fitApply}]`);
}

{
  const finish = between(app, 'private finishCapture(', 'private discardDecodeState');
  const stop = between(app, 'private async stopCapture(', 'private async teardownDevice');
  const adopt = between(app, 'private adoptCapture(', 'private saveItems()');
  const failed = between(app, '} catch (e) {\n      this.captureArming = false;', '      const armed = this.startMutatedCapture;');
  const starts = (app.match(/createSession\(mode\)/g) ?? []).length;
  const ends = [
    finish, stop, adopt, failed,
  ].filter((body) => body.includes('this.session = null;')).length;
  check('Repeat keeps its session; manual stop, single end, adoption and failed start clear it',
    finish.includes('const stickyWave = this.repeatSession && this.settings.mode === \'repeat\'') &&
    finish.includes("() => { void this.startCapture('repeat'); }") &&
    ends === 4 && starts === 1,
    `starts=${starts}, cleared=${ends}/4`);
}

{
  const intentCalls = (app.match(/this\.noteViewportIntent\(\);/g) ?? []).length;
  const explicitCalls = (app.match(/this\.noteExplicitViewport\(\);/g) ?? []).length;
  const fitCalls = (app.match(/this\.fitViewport\(\);/g) ?? []).length;
  const wheelSite = between(app, 'const wheelNavigate = (e: WheelEvent', "plot.addEventListener('wheel'");
  const pinchSite = between(app, 'if (pinch && pointers.size >= 2)', '      if (dragging) {');
  const dragSite = between(app, '      if (dragging) {', 'this.updateHover');
  const axisSite = between(app, "this.el.axis.addEventListener('pointermove'", 'const axisEnd');
  const debugViewport = between(app, 'setViewportSeconds: (a: number', 'setMarker:');
  const debugZoom = between(app, 'zoomToAnnotation: (analyzerIndex', 'snapshot:');
  // A viewport gesture is user intent, but it only clamps V inside D: it never releases
  // the lock and never moves T. The overview strip follows the same rule.
  const gestures = wheelSite.includes('this.noteViewportIntent();') &&
    pinchSite.includes('this.noteViewportIntent();') &&
    dragSite.includes('this.noteViewportIntent();') &&
    axisSite.includes('this.noteViewportIntent();') &&
    debugViewport.includes('this.noteExplicitViewport();') &&
    debugZoom.includes('this.noteExplicitViewport();');
  const overviewIntent = (between(app, 'this.overview = new OverviewStrip(',
    'this.stack.setBaseTheme').match(/onIntent: \(\) => \{ this\.beginViewportGesture\(\); \}/g) ?? []).length === 1 &&
    (between(app, 'private centerOverview', 'private captureFixedView')
      .match(/this\.clampLockView\(\);/g) ?? []).length === 3 &&
    !between(app, 'private centerOverview', 'private captureFixedView').includes('noteLockGesture');
  const fitSites = [
    between(app, "case 'view.fit':", "case 'cursors.clear':"),
    // Fit moved from the top bar to the corner cell (DESIGN §3.4); it is the same action.
    between(app, "this.el.cornerFit.addEventListener('click'", "this.el.cornerSummary.addEventListener('click'"),
  ];
  const fitBody = between(app, 'private fitViewport()', 'private centerOverview');
  check('each explicit viewport action is recorded as user intent',
    app.includes('private noteViewportIntent(): void') &&
    // wheel, pinch, drag, axis drag, cursor focus, and the +/- and arrow-key steps.
    intentCalls === 7 && explicitCalls === 3 && fitCalls === 1 && gestures &&
    between(app, 'private keyZoom(', 'private keyPan(').includes('this.noteViewportIntent();') &&
    between(app, 'private keyPan(', 'private beginViewportGesture(').includes('this.noteViewportIntent();') &&
    overviewIntent &&
    fitSites[0]!.includes('this.fitLockedViewport()') &&
    fitSites[0]!.includes('this.stack.zoomToFit();') &&
    fitSites[1]!.includes('this.fitViewport();') &&
    fitBody.includes('if (!this.fitLockedViewport()) this.stack.zoomToFit();') &&
    fitBody.includes('this.beginViewportGesture();') &&
    fitBody.includes('this.triggerViewOffsetStart = -lock.fraction * this.loopRetentionLen;'),
    `intentCalls=${intentCalls}, explicit=${explicitCalls}, fitCalls=${fitCalls}, ` +
    `gestures=${gestures}, overview=${overviewIntent}`);
}

{
  const draw = between(app, 'private draw(', 'private drawLaneSurfaces');
  const pendingAt = draw.indexOf('this.stack.setViewport(pendingViewport.start, pendingViewport.end);');
  const applyAt = draw.indexOf('this.applySessionView();');
  const triggerAt = draw.indexOf('this.applyTriggerViewAnchor(rescaled);');
  const pendingBody = between(draw, 'if (restorePending && pendingViewport) {', '    }');
  check('draw restores the toolbar viewport, then resolves the session policy, then the loop lock',
    pendingAt >= 0 && applyAt > pendingAt && triggerAt > applyAt &&
    !pendingBody.includes('this.applySessionView();') &&
    !draw.includes('restoreRepeatViewport()'),
    `pending=${pendingAt}, apply=${applyAt}, trigger=${triggerAt}`);
}

{
  const navigate = between(app, 'const wheelNavigate = (e: WheelEvent', "this.el.axis.addEventListener('wheel'");
  const plotWheel = between(app, "plot.addEventListener('wheel'", "this.el.axis.addEventListener('wheel'");
  const axisWheel = between(app, "this.el.axis.addEventListener('wheel'", '// One pointer');
  const stripWheel = between(overview, 'private wheelEvent(event: WheelEvent)', '\n  }\n}');
  const navNative = navigate.indexOf("if (action === 'native') return;");
  const navPrevent = navigate.indexOf('e.preventDefault();');
  const navBlock = navigate.indexOf("if (action === 'block') return;");
  const navStore = navigate.indexOf('if (this.store.length === 0) return;');
  const stripNative = stripWheel.indexOf("if (action === 'native') return;");
  const stripPrevent = stripWheel.indexOf('event.preventDefault();');
  // The decision itself is wheelAction (wheel-gesture-selftest pins its table); here the
  // three handlers must all ask it, let `native` through untouched, and swallow
  // everything else - including Ctrl+wheel before any capture exists.
  check('plot, axis and overview wheels all route through wheelAction before touching the view',
    navNative >= 0 && navPrevent > navNative && navBlock > navPrevent && navStore > navBlock &&
    navigate.includes('const action = this.wheelActionFor(e, target);') &&
    navigate.includes('this.scrollRowsBy(e);') &&
    navigate.includes('this.stack.zoomAt(') && navigate.includes('this.stack.panPixels(') &&
    navigate.includes("wheelSpanFactor(e.deltaY, { isPhysicalWheel: physical, shift: false })") &&
    !navigate.includes('if (!e.ctrlKey && !e.shiftKey) return;') &&
    plotWheel.includes('wheelNavigate(e, left)') &&
    axisWheel.includes('wheelNavigate(e, left)') &&
    app.includes('wheelAction: (event) => this.wheelActionFor(event),') &&
    app.includes('onScrollRows: (event) => this.scrollRowsBy(event),') &&
    stripNative >= 0 && stripPrevent > stripNative &&
    stripWheel.includes('this.cb.wheelAction?.(event)') &&
    stripWheel.includes('this.cb.onScrollRows?.(event)') &&
    stripWheel.includes('this.cb.onZoom(') && stripWheel.includes('this.cb.onPan(') &&
    !app.includes('wheelIntent') && !overview.includes('WheelIntent'),
    `navigate=${navigate.length}, plot=${plotWheel.length}, axis=${axisWheel.length}, strip=${stripWheel.length}`);
}

{
  const start = app.split('private async startCapture(')[1]?.split('private enforceLoopRetention')[0] ?? '';
  const finish = app.split('private finishCapture(')[1]?.split('private discardDecodeState')[0] ?? '';
  check('App threads only the Repeat timer through the repeat start origin',
    app.includes("private async startCapture(origin: CaptureStartOrigin = 'manual')") &&
    finish.includes("() => { void this.startCapture('repeat'); }") &&
    (app.match(/this\.startCapture\('repeat'\)/g) ?? []).length === 1 &&
    !start.includes('captureStartUsesDefaultWindow'),
    `start=${start.length}, finish=${finish.length}`);
}

{
  const wheelSite = between(app, 'const wheelNavigate = (e: WheelEvent', "plot.addEventListener('wheel'");
  const pinchSite = between(app, 'if (pinch && pointers.size >= 2)', '      if (dragging) {');
  const dragSite = between(app, '      if (dragging) {', 'this.updateHover');
  const axisSite = between(app, "this.el.axis.addEventListener('pointermove'", 'const axisEnd');
  const fitShortcut = between(app, "case 'view.fit':", "case 'cursors.clear':");
  const fitButton = between(app, "this.el.cornerFit.addEventListener('click'", "this.el.cornerSummary.addEventListener('click'");
  const debugViewport = between(app, 'setViewportSeconds: (a: number', 'setMarker:');
  const debugZoom = between(app, 'zoomToAnnotation: (analyzerIndex', 'snapshot:');
  const focus = between(app, 'private focusCursor(', 'private removeCursor(');
  check('each explicit viewport action routes through the intent or explicit-clamp helper',
    app.includes('private noteViewportIntent()') && app.includes('private noteExplicitViewport()') &&
    wheelSite.includes('this.noteViewportIntent();') &&
    pinchSite.includes('this.noteViewportIntent();') &&
    dragSite.includes('this.noteViewportIntent();') &&
    axisSite.includes('this.noteViewportIntent();') &&
    fitShortcut.includes('this.beginViewportGesture();') &&
    fitShortcut.includes('this.fitLockedViewport()') &&
    fitButton.includes('this.fitViewport();') &&
    debugViewport.includes('this.noteExplicitViewport();') &&
    debugZoom.includes('this.noteExplicitViewport();') &&
    focus.includes('this.noteViewportIntent();'),
    `wheel=${wheelSite.length}, pinch=${pinchSite.length}, drag=${dragSite.length}, axis=${axisSite.length}`);
  const dbl = between(app, "plot.addEventListener('dblclick'", '// Dragging the axis');
  check('the double-click placement gesture is not a viewport action',
    dbl.length > 0 && !dbl.includes('noteViewportIntent') && !dbl.includes('zoomToFit'),
    `len=${dbl.length}`);
}

{
  const draw = between(app, 'private draw(', 'private drawLaneSurfaces');
  const syncAt = draw.indexOf('this.stack.syncSize().rescaled;');
  const pendingAt = draw.indexOf('this.stack.setViewport(pendingViewport.start, pendingViewport.end);');
  check('draw applies width adaptation before the pending toolbar viewport',
    syncAt >= 0 && pendingAt > syncAt,
    `sync=${syncAt}, pending=${pendingAt}`);
}

check('the session model owns the policy rules the App imports',
  model.includes('export function createSession(') &&
  model.includes('export function beginSweep(') &&
  model.includes('export function resolveSessionView(') &&
  model.includes('export function sessionWithManualView(') &&
  model.includes('export function secondsRangeToSamples(') &&
  app.includes("from './captureSession.js'"),
  'session model present');

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

export {};
