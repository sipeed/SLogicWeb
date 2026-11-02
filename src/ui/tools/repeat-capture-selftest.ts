// SPDX-License-Identifier: GPL-3.0-or-later

import { RepeatCaptureTimer, type RepeatTimerHost } from '../repeatCapture.js';

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

interface Scheduled { id: number; milliseconds: number; run: () => void }
function fakeHost() {
  let nextId = 1;
  const scheduled: Scheduled[] = [];
  const cleared: number[] = [];
  const host: RepeatTimerHost = {
    set: (run, milliseconds) => {
      const id = nextId++;
      scheduled.push({ id, milliseconds, run });
      return id;
    },
    clear: (id) => { cleared.push(id); },
  };
  const fire = (id: number): void => {
    const item = scheduled.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`unknown fake timer ${id}`);
    item.run();
  };
  return { host, scheduled, cleared, fire };
}

{
  const { host, scheduled, fire } = fakeHost();
  const timer = new RepeatCaptureTimer(host);
  let runs = 0;
  let pendingAtRun: boolean | null = null;
  timer.schedule(0.01, () => { runs++; pendingAtRun = timer.pending; });
  const first = scheduled[0]!;
  check('a one-shot repeat timer clamps its interval and clears pending before running',
    first.milliseconds === 100 && timer.pending && (fire(first.id), runs === 1) &&
    pendingAtRun === false && !timer.pending,
    `ms=${first.milliseconds}, runs=${runs}, pendingAtRun=${pendingAtRun}, pending=${timer.pending}`);
}

{
  const { host, scheduled, cleared, fire } = fakeHost();
  const timer = new RepeatCaptureTimer(host);
  const runs: string[] = [];
  timer.schedule(0.1, () => runs.push('old'));
  timer.schedule(1, () => runs.push('new'));
  fire(scheduled[0]!.id);
  const staleSafe = runs.length === 0 && timer.pending;
  fire(scheduled[1]!.id);
  check('rescheduling invalidates the old generation without losing the new pending timer',
    cleared.join(',') === '1' && staleSafe && runs.join(',') === 'new' && !timer.pending,
    `cleared=${cleared.join(',')}, runs=${runs.join(',')}, staleSafe=${staleSafe}`);
}

{
  const { host, scheduled, cleared, fire } = fakeHost();
  const timer = new RepeatCaptureTimer(host);
  let runs = 0;
  timer.schedule(1, () => { runs++; });
  timer.cancel();
  fire(scheduled[0]!.id);
  check('cancel clears the browser timer and invalidates an already queued stale callback',
    cleared.join(',') === '1' && runs === 0 && !timer.pending,
    `cleared=${cleared.join(',')}, runs=${runs}, pending=${timer.pending}`);
}

{
  const { host, scheduled } = fakeHost();
  const timer = new RepeatCaptureTimer(host);
  const values = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5];
  for (const value of values) timer.schedule(value, () => {});
  const milliseconds = scheduled.map((item) => item.milliseconds);
  check('Repeat timer delays use the shared 0.1–10 s policy',
    milliseconds.join(',') === '1000,10000,100,500', `milliseconds=${milliseconds.join(',')}`);
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const assistant = fs.readFileSync('src/assistant/tools.ts', 'utf8');

{
  const completions = (app.match(/stopCapture\('completed'\)/g) ?? []).length;
  const finish = app.split('private finishCapture(')[1]?.split('private discardDecodeState')[0] ?? '';
  const pendingStop = app.split('private async stopCapture(')[1]?.split('private async teardownDevice')[0] ?? '';
  const discard = app.split('private discardDevice()')[1]?.split('private detachDevice()')[0] ?? '';
  const adopt = app.split('private adoptCapture(')[1]?.split('private save()')[0] ?? '';
  const start = app.split('private async startCapture(')[1]?.split('private enforceLoopRetention')[0] ?? '';
  const wired = completions === 5 && finish.includes("reason === 'completed' && this.settings.mode === 'repeat'") &&
    finish.includes('this.device !== null') && finish.includes('this.repeatTimer.schedule(') &&
    pendingStop.includes('this.repeatTimer.pending) {\n      this.repeatTimer.cancel();') &&
    /if \(reason === 'manual'\) \{\s+this\.repeatTimer\.cancel\(\);/.test(pendingStop) &&
    discard.includes('this.repeatTimer.cancel()') && adopt.includes('this.repeatTimer.cancel()') &&
    start.includes('this.running || this.stopping || this.repeatTimer.pending') &&
    start.includes('this.repeatTimer.cancel()');
  check('App schedules only natural Repeat completion and cancels every manual or failed path',
    wired, `completions=${completions}, finish=${finish.length}, pendingStop=${pendingStop.length}, wired=${wired}`);
}

{
  const primary = app.split('private primaryAction()')[1]?.split('private renderToolbarState()')[0] ?? '';
  const toolbar = app.split('private renderToolbarState()')[1]?.split('private renderStatus()')[0] ?? '';
  const pendingUi = primary.includes('this.running || this.repeatTimer.pending') &&
    toolbar.includes('const showStop = this.running || repeatPending') &&
    toolbar.includes('this.device === null && !showStop') &&
    panel.includes("waiting: 'capturePanel.statusWaiting'") &&
    panel.includes("t('capturePanel.statusWaitingDetail'") &&
    panel.includes('status.dataset.captureState = v.captureState') &&
    !panel.includes('capturePanel.repeatPending') &&
    panel.includes('b.disabled = modeLocked') &&
    (panel.match(/disabled: modeLocked/g) ?? []).length === 3 &&
    !panel.includes('secs.disabled') && !panel.includes('unlimited.disabled') &&
    !panel.includes('interval.disabled') && !panel.includes('win.disabled') &&
    assistant.includes('repeat_pending: st.repeatPending') &&
    (assistant.match(/st\.repeatPending/g) ?? []).length >= 3;
  check('pending Repeat remains stoppable and visible while settings and start reject re-entry',
    pendingUi, `primary=${primary.length}, toolbar=${toolbar.length}, pendingUi=${pendingUi}`);
}

{
  const progress = app.split('private progressView()')[1]?.split('private capturePanelState()')[0] ?? '';
  const state = app.split('private capturePanelState()')[1]?.split('private renderPanels()')[0] ?? '';
  const view = app.split('this.capturePanel.render({')[1]?.split('});')[0] ?? '';
  const fill = panel.split('private fillProgress(')[1]?.split('private setStatusProgress(')[0] ?? '';
  const setter = panel.split('private setStatusProgress(')[1]?.split('render(v: CapturePanelView)')[0] ?? '';
  const status = panel.split('const badgeKeys =')[1]?.split('const maxSeconds =')[0] ?? '';
  const oneLifecycle = state.includes("if (this.stopping) return 'stopping';") &&
    state.includes("if (this.repeatTimer.pending) return 'waiting';") &&
    state.includes("if (this.running) return 'capturing';") &&
    state.includes("return this.store.length > 0 ? 'completed' : 'ready';") &&
    !state.includes('setTimeout') && !state.includes('setInterval') &&
    view.includes('captureState: this.capturePanelState(),') &&
    view.includes('progress: this.running ? this.progressView() : null,') &&
    progress.includes('targetSamples: loop || unlimited ? null : this.captureLimitSamples') &&
    !progress.includes('setTimeout') && !progress.includes('setInterval');
  const oneProgress = fill.includes("t('capturePanel.statusFiniteDetail')") &&
    fill.includes("t('capturePanel.statusLoopDetail')") &&
    fill.includes("t('capturePanel.statusUnlimitedDetail')") &&
    fill.includes('this.setStatusProgress(target !== null && target > 0 ? progress.samples / target * 100 : null)') &&
    setter.includes("this.progressEl.dataset.indeterminate = String(indeterminate)") &&
    setter.includes("this.progressEl.removeAttribute('aria-valuenow')") &&
    setter.includes("this.progressEl.setAttribute('aria-valuenow', String(rounded))") &&
    setter.includes('this.progressBar.style.width = `${rounded}%`') &&
    status.includes("progress.setAttribute('role', 'progressbar')") &&
    status.includes("progress.setAttribute('aria-label', t('capturePanel.progress'))") &&
    status.includes("v.captureState === 'waiting'") &&
    status.includes("v.captureState === 'completed'") &&
    !panel.includes('setInterval') && !panel.includes('setTimeout');
  check('one App-owned lifecycle drives badges, determinate progress, and indeterminate states',
    oneLifecycle && oneProgress,
    `state=${state.length}, progress=${progress.length}, fill=${fill.length}, setter=${setter.length}, status=${status.length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
