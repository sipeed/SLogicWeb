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
    pendingStop.includes("if (reason === 'manual') this.repeatTimer.cancel()") &&
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
    panel.includes('if (v.repeatPending)') && panel.includes('pending.dataset.repeatPending') &&
    panel.includes("t('capturePanel.repeatPending')") && panel.includes('b.disabled = modeLocked') &&
    ['secs', 'unlimited', 'interval', 'win'].every((name) => panel.includes(`${name}.disabled = modeLocked`)) &&
    assistant.includes('repeat_pending: st.repeatPending') &&
    (assistant.match(/st\.repeatPending/g) ?? []).length >= 3;
  check('pending Repeat remains stoppable and visible while settings and start reject re-entry',
    pendingUi, `primary=${primary.length}, toolbar=${toolbar.length}, pendingUi=${pendingUi}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
