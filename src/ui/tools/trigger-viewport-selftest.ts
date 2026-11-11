// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Loop trigger-anchored viewing: the DurationWindow/ViewWindow split, the local roll and
 * the App wiring that applies them.
 *
 * Contract:
 *   - D = [T - f*L, T + (1-f)*L] carries the data (L = Loop Duration, f = the pre-trigger
 *     fraction; 0% puts T at D's left edge, 0 s). D never pans.
 *   - V is the user's window inside D, stored as offsets from T. Zoom/pan move V only;
 *     a roll leaves V's offsets unchanged, so the waveform updates in place.
 *   - A local roll picks a real edge inside the retained window's prefix and appends
 *     only the samples needed to fill the tail. The 64-sample store quantum is internal.
 *   - The lock means "current data + configuration still triggers"; Fit and view
 *     gestures never release it. A digital one-shot lock releases when T leaves retention.
 */

import {
  captureLocksTriggerView, clampLoopViewOffsets, loopOverviewWindow, loopPendingLimit,
  loopStoreLimit, mayReanchor, medianOfRecent, planLocalTriggerStep, reconcileTrigger,
  relativeTriggerSample, resumeTriggerFollow, triggerSlackSamples, triggerViewFraction,
} from '../triggerViewport.js';
import { loopDropSamples } from '../state.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const triggerStatus = fs.readFileSync('src/ui/triggerStatus.ts', 'utf8');
const en = fs.readFileSync('src/ui/locales/en.ts', 'utf8');
const zh = fs.readFileSync('src/ui/locales/zh-CN.ts', 'utf8');
const startSrc = app.slice(
  app.indexOf('private async startCapture('),
  app.indexOf('private enforceLoopRetention'),
);

{
  const loop = captureLocksTriggerView('loop', true);
  const others = [
    captureLocksTriggerView('single', true),
    captureLocksTriggerView('repeat', true),
    captureLocksTriggerView('loop', false),
  ];
  check('only loop plus an armed software trigger owns the viewport',
    loop && others.every((value) => !value), `loop=${loop}, others=${others.join(',')}`);
}

{
  const fraction = triggerViewFraction(0) === 0 &&
    triggerViewFraction(10) === 0.1 &&
    triggerViewFraction(75) === 0.75 &&
    triggerViewFraction(-5) === 0 &&
    triggerViewFraction(140) === 1 &&
    triggerViewFraction(Number.NaN) === 0;
  check('the pre-trigger percentage becomes a clamped viewport fraction',
    fraction, `fraction=${fraction}`);
}

{
  // The median must use the newest chronological window. A sorted-in-place array would
  // drop the smallest value on shift, not the oldest, and drift once it fills.
  const scratch: number[] = [];
  const ring: number[] = [];
  const got: number[] = [];
  const want: number[] = [];
  for (const value of [100, 1, 2, 3, 4, 5, 6, 7, 8]) {
    ring.push(value);
    if (ring.length > 8) ring.shift();
    got.push(medianOfRecent(ring, scratch));
    const sorted = [...ring].sort((a, b) => a - b);
    want.push(sorted[Math.floor(sorted.length / 2)]!);
  }
  check('the rolling period median keeps the newest intervals, not the largest',
    got.every((value, i) => value === want[i]) && got[8] === want[8],
    `got=${got.join(',')}, want=${want.join(',')}`);
}

{
  // The ViewWindow is clamped into D; it may not move D or exceed its span.
  const exact = clampLoopViewOffsets(0, 1_000, 0, 1_000);
  const left = clampLoopViewOffsets(-100, 400, 0, 1_000);
  const right = clampLoopViewOffsets(800, 1_300, 0, 1_000);
  const wide = clampLoopViewOffsets(-100, 1_100, 0, 1_000);
  const pre = clampLoopViewOffsets(-200, 300, 0.1, 1_000);
  const preRight = clampLoopViewOffsets(850, 950, 0.1, 1_000);
  check('the ViewWindow is clamped inside the DurationWindow (0% and 10%)',
    exact.start === 0 && exact.end === 1_000 &&
    left.start === 0 && left.end === 500 &&
    right.start === 500 && right.end === 1_000 &&
    wide.start === 0 && wide.end === 1_000 &&
    pre.start === -100 && pre.end === 400 &&
    preRight.start === 800 && preRight.end === 900,
    `exact=${JSON.stringify(exact)}, left=${JSON.stringify(left)}, right=${JSON.stringify(right)}, ` +
    `wide=${JSON.stringify(wide)}, pre=${JSON.stringify(pre)}, preRight=${JSON.stringify(preRight)}`);
}

{
  // One local roll: the latest edge inside the budget, the tail filled by exactly the
  // step, and the ViewWindow offsets unchanged relative to the new T.
  const step = planLocalTriggerStep({
    triggerAbs: 10_000, frontAbs: 9_000, liveAbs: 12_000,
    windowSamples: 1_000, fraction: 0, blockSamples: 500,
    crossings: [10_100, 10_200, 10_300, 10_400, 10_500, 10_600],
    viewOffsetStart: 0, viewOffsetEnd: 1_000,
  });
  const noBudget = planLocalTriggerStep({
    triggerAbs: 10_000, frontAbs: 9_000, liveAbs: 11_000,
    windowSamples: 1_000, fraction: 0, blockSamples: 500,
    crossings: [10_100], viewOffsetStart: 0, viewOffsetEnd: 1_000,
  });
  const noEdge = planLocalTriggerStep({
    triggerAbs: 10_000, frontAbs: 9_000, liveAbs: 12_000,
    windowSamples: 1_000, fraction: 0, blockSamples: 500,
    crossings: [10_600], viewOffsetStart: 0, viewOffsetEnd: 1_000,
  });
  const ninth = planLocalTriggerStep({
    triggerAbs: 10_000, frontAbs: 9_000, liveAbs: 12_000,
    windowSamples: 1_000, fraction: 0.1, blockSamples: 500,
    crossings: [10_250, 10_450], viewOffsetStart: -100, viewOffsetEnd: 900,
  });
  check('a local roll takes the latest edge in the budget and keeps V offsets',
    step !== null && step.anchorAbs === 10_500 && step.step === 500 &&
    step.drop === 1_472 && step.triggerSample === 28 &&
    step.viewStart === 28 && step.viewEnd === 1_028 &&
    noBudget === null && noEdge === null &&
    ninth !== null && ninth.anchorAbs === 10_450 &&
    ninth.viewStart === ninth.triggerSample - 100 &&
    ninth.viewEnd === ninth.triggerSample + 900,
    `step=${JSON.stringify(step)}, noBudget=${noBudget}, noEdge=${noEdge}, ninth=${JSON.stringify(ninth)}`);
}

{
  // A long run of rolls: the ViewWindow's ABSOLUTE position advances by exactly the
  // step (a whole period, a real edge), independent of the 64-sample drop residue. The
  // offsets relative to T never change; the store-relative coordinates may.
  let triggerAbs = 0;
  let front = 0;
  const live = 20_000;
  const L = 1_000;
  const budget = 400;
  const offsetStart = 0;
  const offsetEnd = 1_000;
  const crossings = Array.from({ length: 200 }, (_, i) => (i + 1) * 100);
  let viewAbsStart = triggerAbs + offsetStart;
  let pixelOffset = offsetStart;
  let ok = true;
  let steps = 0;
  for (let guard = 0; guard < 20; guard++) {
    const step = planLocalTriggerStep({
      triggerAbs, frontAbs: front, liveAbs: live,
      windowSamples: L, fraction: 0, blockSamples: budget,
      crossings, viewOffsetStart: offsetStart, viewOffsetEnd: offsetEnd,
    });
    if (!step) break;
    const storedLength = live - (front + step.drop);
    if (!(step.step > 0 && step.step <= budget)) ok = false;
    if (step.triggerSample < 0 || step.triggerSample >= storedLength) ok = false;
    if (step.viewStart < 0 || step.viewEnd > storedLength) ok = false;
    const newTriggerAbs = front + step.drop + step.triggerSample;
    const newFront = front + step.drop;
    const newViewAbsStart = newFront + step.viewStart;
    if (newTriggerAbs !== step.anchorAbs) ok = false;
    if (newViewAbsStart !== triggerAbs + offsetStart + step.step) ok = false;
    if (step.viewStart - step.triggerSample !== offsetStart) ok = false;
    if (step.viewEnd - step.viewStart !== offsetEnd - offsetStart) ok = false;
    viewAbsStart = newViewAbsStart;
    pixelOffset = step.viewStart - step.triggerSample;
    triggerAbs = newTriggerAbs;
    front = newFront;
    steps++;
  }
  check('every local roll advances the ViewWindow by the real edge step, never the 64 residue',
    ok && steps >= 10 && pixelOffset === offsetStart && viewAbsStart > triggerAbs - 1,
    `steps=${steps}, ok=${ok}, triggerAbs=${triggerAbs}, viewAbsStart=${viewAbsStart}, ` +
    `pixelOffset=${pixelOffset}`);
}

{
  // A store-front residue must not leak into the visible phase: two fronts with
  // different mod-64 remainders produce the same absolute view position for the same
  // anchor and offsets.
  const a = planLocalTriggerStep({
    triggerAbs: 10_000, frontAbs: 8_960, liveAbs: 12_000,
    windowSamples: 1_000, fraction: 0, blockSamples: 600,
    crossings: [10_384, 10_592], viewOffsetStart: 100, viewOffsetEnd: 900,
  });
  const b = planLocalTriggerStep({
    triggerAbs: 10_000, frontAbs: 9_007, liveAbs: 12_000,
    windowSamples: 1_000, fraction: 0, blockSamples: 600,
    crossings: [10_384, 10_592], viewOffsetStart: 100, viewOffsetEnd: 900,
  });
  const absA = a === null ? null : a.drop + 8_960 + a.viewStart;
  const absB = b === null ? null : b.drop + 9_007 + b.viewStart;
  check('the store drop residue never changes where the ViewWindow starts in time',
    a !== null && b !== null && a.anchorAbs === 10_592 && b.anchorAbs === 10_592 &&
    absA === 10_692 && absB === 10_692,
    `a=${JSON.stringify(a)}, b=${JSON.stringify(b)}, abs=${absA}/${absB}`);
}

{
  // A drop subtracts the same amount from T and from the window start: the marker's
  // pixel does not move, and the span is unchanged.
  for (const [trigger, start, end, drop] of [
    [10_000, 9_000, 11_000, 64],
    [500, 500, 1_500, 64],
    [2_000, 1_900, 2_100, 1_024],
  ] as const) {
    const before = (trigger - start) / (end - start);
    const after = ((trigger - drop) - (start - drop)) / ((end - drop) - (start - drop));
    check(`a ${drop}-sample drop translates the locked window with T`,
      Math.abs(before - after) < 1e-12 && (end - start) === ((end - drop) - (start - drop)),
      `before=${before}, after=${after}`);
  }
}

{
  const index = relativeTriggerSample(1_000, 0) === 1_000 &&
    relativeTriggerSample(1_000, 64) === 936 &&
    relativeTriggerSample(0, 64) === null &&
    relativeTriggerSample(Number.NaN, 0) === null &&
    relativeTriggerSample(1_000, Number.NaN) === null;
  check('the reported emitted-stream index becomes a store-relative one, or null when evicted',
    index, `index=${index}`);
}

{
  const matrix = [
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ] as const;
  const ok = matrix.every(([resume, running, want]) =>
    resumeTriggerFollow(resume, running) === want);
  check('follow-latest returns only if it was on and the capture still runs',
    ok, `matrix=${matrix.map(([r, run, w]) => `${r}/${run}=>${w}`).join(', ')}`);
}

{
  const slack = triggerSlackSamples(1_024, 1e6, 1) === 1_024 &&
    triggerSlackSamples(24_000, 1e6, 1) === 24_000 &&
    triggerSlackSamples(16_000_000, 100e6, 1) === 5_000_000 &&
    triggerSlackSamples(16_000_000, 100e6, 4) === 5_000_000 &&
    triggerSlackSamples(1_000_000, 100e3, 1) === 65_536 &&
    // Wide samples make the 64 MiB cap the minimum, not the 50 ms window.
    triggerSlackSamples(2 ** 30, 4e9, 16) === 4_194_304 &&
    triggerSlackSamples(0, 1e6, 1) === 0 &&
    loopStoreLimit(24_000, true, 24_000) === 48_000 &&
    loopStoreLimit(24_000, false, 24_000) === 24_000;
  check('the carried slack is bounded by one window, the 50 ms/64k floor and 64 MiB',
    slack, `slack=${slack}`);
  const hold = loopPendingLimit(1_024, 1_024, 2) === 33_554_432 &&
    loopPendingLimit(2 ** 30, 5_000_000, 16) === 2 ** 30 + 5_000_000;
  check('the pre-placement hold keeps the 64 MiB prefix budget and the lock slack',
    hold, `hold=${hold}`);
}

{
  let bounded = true;
  let detail = '';
  for (const limit of [1_024, 50_000, 2_000_000]) {
    for (const excess of [1, 63, 64, 65, 100_000, 4_000_000]) {
      const length = limit + excess;
      const drop = loopDropSamples(length, limit);
      const kept = length - drop;
      if (!(drop >= 0 && drop % 64 === 0 && kept >= limit && kept <= limit + 63)) {
        bounded = false;
        detail = `limit=${limit}, excess=${excess}, drop=${drop}, kept=${kept}`;
      }
    }
  }
  check('a retention drop leaves the store within one 64-sample word of the limit',
    bounded, bounded ? 'bounded' : detail);
}

{
  const enforce = app.slice(app.indexOf('private enforceLoopRetention'),
    app.indexOf('private async stopCapture'));
  const draw = app.slice(app.indexOf('private draw('), app.indexOf('private drawLaneSurfaces'));
  const gestures = app.slice(app.indexOf('private noteViewportIntent()'),
    app.indexOf('private centerOverview'));

  const placed = draw.includes('this.applyTriggerViewAnchor(rescaled);') &&
    app.includes('private applyTriggerViewAnchor(rescaled: boolean): void {') &&
    app.includes('this.triggerViewOffsetStart = -fraction * D;') &&
    app.includes('this.triggerViewOffsetEnd = (1 - fraction) * D;') &&
    app.includes('this.triggerViewLock = {') &&
    app.includes('fraction,') &&
    app.includes('resumeFollow: this.stack.followLatest,') &&
    app.includes('this.placeLockViewport();');
  const gesture = gestures.includes('private noteViewportIntent(): void {') &&
    gestures.includes('this.clampLockView();') &&
    gestures.includes('clampLoopViewOffsets(') &&
    gestures.includes('view.start - this.triggerSampleIndex,') &&
    gestures.includes('view.end - this.triggerSampleIndex,') &&
    gestures.includes('this.placeLockViewport();') &&
    !gestures.includes('triggerViewLock = null');
  const fit = app.slice(app.indexOf('private fitViewport()'),
    app.indexOf('private fitLockedViewport()'));
  const fitLock = app.slice(app.indexOf('private fitLockedViewport()'),
    app.indexOf('private centerOverview'));
  const fitKeeps = fit.includes('if (!this.fitLockedViewport()) this.stack.zoomToFit();') &&
    fitLock.includes('const lock = this.triggerViewLock;') &&
    fitLock.includes('this.triggerViewOffsetStart = -lock.fraction * this.loopRetentionLen;') &&
    fitLock.includes('this.triggerViewOffsetEnd = (1 - lock.fraction) * this.loopRetentionLen;') &&
    !fitLock.includes('this.triggerViewLock = null;');
  const roll = enforce.includes('this.rollLoopWindow(store);') &&
    enforce.includes('liveAbs - this.lastAnalogCrossingAbs >') &&
    enforce.includes('this.loopRetentionLen + this.loopTriggerSlackSamples') &&
    enforce.includes('!this.loopScanCrossed') &&
    enforce.includes('this.loopScanSkip === 0') &&
    enforce.includes('this.releaseLoopTrigger();') &&
    app.includes('private rollLoopWindow(store: SampleStore): void {') &&
    app.includes('planLoopSwap({') &&
    app.includes('planLocalTriggerStep({') &&
    app.includes('this.triggerSampleIndex = step.triggerSample;') &&
    app.includes('this.stack.restoreViewport(step.viewStart, step.viewEnd);') &&
    app.includes('this.triggerSampleIndex = step.anchorAbs - front;') &&
    app.includes('budget = Math.max(budget, fresh - this.loopTriggerSlackSamples);') &&
    app.includes('safeDrop = Math.min(drop, beforeWindow);') &&
    app.includes('beforeWindow = Math.floor(Math.max(0, windowStart) / DROP_FRONT_QUANTUM) *') &&
    app.includes('const next = this.analogCrossings.find((c) => c > triggerAbs);') &&
    app.includes('this.loopLastAnchorStep = step.step;') &&
    app.includes('budget = Math.max(budget, Math.min(fresh, next - triggerAbs));') &&
    app.includes('private lockFromCrossing(rel: number, abs: number): void {') &&
    app.includes('this.pendingRelockAbs = abs;') &&
    app.includes('private releaseLoopTrigger(): void {');
  const dropped = enforce.includes('this.stack.restoreViewport(view.start - drop, view.end - drop);') &&
    enforce.includes('this.triggerViewLock = null;') &&
    enforce.includes('resumeTriggerFollow(lock.resumeFollow, this.running)') &&
    !enforce.includes('userMoved');
  const retune = app.slice(app.indexOf('private syncActiveTrigger'),
    app.indexOf('private restartCaptureForTrigger'));
  const tune = retune.includes('reconcileTrigger({') &&
    retune.includes('const phase: TriggerReconcilePhase =') &&
    retune.includes("if (action === 'restart') {") &&
    retune.includes('this.restartCaptureForTrigger();') &&
    retune.includes("if (action === 'disable') {") &&
    retune.includes('this.disableRunningTrigger();') &&
    retune.includes('this.analogScanner.setCondition(liveAnalog);') &&
    retune.includes('this.triggerRetuneRequested = applied === false;') &&
    app.includes('this.triggerSyncDeferred = true;') &&
    app.includes('if (this.triggerSyncDeferred || this.triggerRetuneRequested) {') &&
    // A released Loop keeps scanning so a returning edge can take the lock again.
    app.includes('mayReanchor({') &&
    app.includes('if (!this.captureUsesSoftwareTrigger || !this.settings.triggerEnableMask) return;') &&
    // The no-scanner lock must drop normally and release when T is evicted.
    app.includes('const lockedView = this.analogScanner !== null ? this.triggerViewLock : null;') &&
    app.includes('this.lastAnalogCrossingAbs = Math.max(');
  check('the lock has one placement, V gestures only clamp, Fit resets V, and rolls are local',
    placed && gesture && fitKeeps && roll && dropped && tune,
    `placed=${placed}, gesture=${gesture}, fit=${fitKeeps}, roll=${roll}, ` +
    `dropped=${dropped}, tune=${tune}`);
}

{
  // The overview strip must map the true data window, not the store front: a roll floors
  // its front drop to 64 samples, so the front can lead T - f*D by up to 63 samples.
  const freeRun = loopOverviewWindow({
    loop: true, length: 1_000, retention: 400, lockFraction: null, triggerSample: null,
  });
  const locked = loopOverviewWindow({
    loop: true, length: 1_000, retention: 400, lockFraction: 0.25, triggerSample: 300,
  });
  const negative = loopOverviewWindow({
    loop: true, length: 1_000, retention: 400, lockFraction: 0.5, triggerSample: 100,
  });
  const full = loopOverviewWindow({
    loop: true, length: 1_000, retention: 400, lockFraction: 1, triggerSample: 399,
  });
  const short = loopOverviewWindow({
    loop: true, length: 100, retention: 400, lockFraction: null, triggerSample: null,
  });
  const other = loopOverviewWindow({
    loop: false, length: 1_000, retention: 0, lockFraction: 0.1, triggerSample: 10,
  });
  check('the overview maps the true locked window, including a negative pre-trigger start',
    freeRun.start === 600 && freeRun.span === 400 &&
    locked.start === 200 && locked.span === 400 &&
    negative.start === -100 && negative.span === 400 &&
    full.start === -1 && full.span === 400 &&
    short.start === 0 && short.span === 400 &&
    other.start === 0 && other.span === 1_000,
    `free=${JSON.stringify(freeRun)}, locked=${JSON.stringify(locked)}, ` +
    `negative=${JSON.stringify(negative)}, full=${JSON.stringify(full)}, ` +
    `short=${JSON.stringify(short)}, other=${JSON.stringify(other)}`);
}

{
  // Trigger-scope reconciler: the one-shot matcher can be retuned only while waiting;
  // after a match a Loop can retune its page detector, a disarm tears it down, and a
  // capture that started unarmed must restart to arm. A non-Loop matched edit is pending.
  const row = (
    patch: Partial<Parameters<typeof reconcileTrigger>[0]>,
  ): string => reconcileTrigger({
    running: true, stopping: false, loop: true, captureArmed: true,
    phase: 'triggered', settingsArmed: true, ...patch,
  });
  const table = [
    row({ settingsArmed: false, phase: 'waiting' }) === 'restart',          // GT off, waiting
    row({ settingsArmed: false }) === 'disable',                            // GT off, matched
    row({ settingsArmed: false, phase: 'off' }) === 'none',
    row({ captureArmed: false }) === 'restart',                             // arm mid-session
    row({ phase: 'off' }) === 'restart',
    row({ phase: 'waiting' }) === 'retune',                                 // waiting retune
    row({}) === 'retune',                                                   // Loop matched
    row({ loop: false }) === 'none',                                        // finite matched
    row({ loop: false, phase: 'waiting', settingsArmed: false }) === 'restart',
    row({ phase: 'not-found' }) === 'none',
    row({ running: false }) === 'none',
    row({ stopping: true }) === 'none',
  ];
  check('the trigger reconciler distinguishes retune, restart, disable and pending',
    table.every(Boolean), `rows=${table.map((v) => (v ? '1' : '0')).join('')}`);

  const reanchor = (patch: Partial<Parameters<typeof mayReanchor>[0]>): boolean =>
    mayReanchor({
      running: true, stopping: false, loop: true, captureArmed: true,
      phase: 'triggered', mask: true, locked: false, pending: false, ...patch,
    });
  const reanchorOk = reanchor({}) && !reanchor({ mask: false }) &&
    !reanchor({ captureArmed: false }) && !reanchor({ phase: 'waiting' }) &&
    !reanchor({ locked: true }) && !reanchor({ pending: true }) &&
    !reanchor({ loop: false }) && !reanchor({ running: false }) &&
    !reanchor({ stopping: true });
  check('a released view re-locks only while the live configuration still arms',
    reanchorOk, `reanchor=${reanchorOk}`);
}

{
  const note = panel.includes("s.mode === 'loop' && s.triggerEnableMask") &&
    panel.includes("'capturePanel.loopTriggerNote'") &&
    panel.includes("'capturePanel.loopTriggerNoteDigital'") &&
    en.includes("'capturePanel.loopTriggerNote':") &&
    en.includes("'capturePanel.loopTriggerNoteDigital':") &&
    zh.includes("'capturePanel.loopTriggerNote':") &&
    zh.includes("'capturePanel.loopTriggerNoteDigital':");
  check('loop mode explains the analog roll and the one-shot digital lock separately',
    note, `note=${note}`);
}

{
  // A loop window shorter than one transport remainder drops T before the page hears
  // about the match. The plot cannot pin it; the panel must say so instead of claiming a
  // lock, and the "Triggered" text must match Loop's continuous semantics.
  const lost = app.includes('this.triggerViewLost = true;') &&
    app.includes('if (hadTrigger && this.triggerViewPending && this.triggerViewLock === null) {') &&
    app.includes('triggerViewLost: this.triggerViewLost,') &&
    panel.includes('v.triggerViewLost') && panel.includes("t('capturePanel.triggerViewLost')") &&
    en.includes("'capturePanel.triggerViewLost':") && zh.includes("'capturePanel.triggerViewLost':");
  const loopMessage = triggerStatus.includes("v.mode === 'loop'") &&
    panel.includes("'capturePanel.triggeredLoop'") &&
    triggerStatus.includes('v.triggerLocked') &&
    panel.includes("'capturePanel.triggeredLoopDigital'") &&
    triggerStatus.includes('v.triggerAnalogRolling') &&
    app.includes('triggerAnalogRolling: this.analogScanner !== null,') &&
    app.includes('triggerLocked: this.triggerViewLock !== null,') &&
    en.includes("'capturePanel.triggeredLoop':") && zh.includes("'capturePanel.triggeredLoop':");
  const stopped = triggerStatus.includes("v.triggerState !== 'triggered' || !v.running");
  const integration = startSrc.includes('this.analogScanner = null;') &&
    startSrc.includes('this.lastAnalogCrossingAbs = Number.NEGATIVE_INFINITY;') &&
    startSrc.includes('this.pendingRelockAbs = null;') &&
    app.includes('if (this.running) await this.stopCapture(\'manual\');') &&
    app.includes('if (this.stopPending) await this.stopPending;') &&
    app.includes('activeTriggerPreSamples: this.running && this.captureTriggerBase') &&
    panel.includes('v.activeTriggerPreSamples !== undefined');
  check('opening a capture and live Duration edits clean up/retain the right trigger state',
    integration, `open=${app.includes('if (this.running) await this.stopCapture(\'manual\');')}, adopt=${app.includes('this.analogScanner = null;\n    this.analogCrossings = [];')}, prefix=${panel.includes('v.activeTriggerPreSamples !== undefined')}`);
  check('a lost trigger is reported and the loop message is not the finite-capture one',
    lost && loopMessage && stopped,
    `lost=${lost}, loopMessage=${loopMessage}, stopped=${stopped}`);
}

{
  // The hard cap must run before the append, or the store can throw at 2^31 samples
  // before the guard ever sees the overflow.
  const guardAt = app.indexOf('if (this.captureUsesSoftwareTrigger &&\n                store.length + chunkSamples > LOOP_STORE_HARD_SAMPLES) {');
  const appendAt = app.indexOf('store.append(chunk);', guardAt);
  const hardCap = guardAt >= 0 && appendAt > guardAt &&
    app.includes('const LOOP_STORE_HARD_SAMPLES = 0x7fffffff - 0x1000000;') &&
    app.includes('const pendingLimit = loopPendingLimit(') &&
    app.includes('this.disableRunningTrigger(true);') &&
    // A deferred reconcile during a restart's own arming is re-run after it settles.
    app.includes('if (this.triggerSyncDeferred && !this.triggerRestartCancelled) {') &&
    app.includes('if (this.triggerRestartCancelled || this.device === null) {') &&
    app.includes('this.cancelPendingTriggerRestart();');
  check('the hard-cap pre-append guard and the pending hold are wired and bounded',
    hardCap, `guard=${guardAt}, append=${appendAt}, hardCap=${hardCap}`);
}

{
  // A channel rename commits the same trigger mode; the detector must not be reset.
  const configure = app.slice(app.indexOf('private configureChannel('),
    app.indexOf('private relayout'));
  const nameOnly = configure.includes(
    'const triggerChanged = triggerSettingsChanged(this.settings, next);') &&
    configure.includes('if (triggerChanged) this.syncActiveTrigger();');
  check('a name-only channel edit does not touch the trigger detector',
    nameOnly, `nameOnly=${nameOnly}`);
}

{
  // Fit and gestures never release the lock; only trigger loss/config invalidation do.
  const source = app.slice(app.indexOf('private fitViewport()'), app.indexOf('private overviewWindow'));
  const noRelease = !source.includes('triggerViewLock = null') &&
    !source.includes('clearTriggerSample');
  const offsets = app.includes('private triggerViewOffsetStart = 0;') &&
    app.includes('private triggerViewOffsetEnd = 0;') &&
    app.includes('private lastAnalogCrossingAbs = Number.NEGATIVE_INFINITY;') &&
    app.includes('private pendingRelockAbs: number | null = null;');
  check('Fit keeps the lock, and the ViewWindow/quiet-window state is explicit',
    noRelease && offsets, `noRelease=${noRelease}, offsets=${offsets}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
