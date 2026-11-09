// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trigger-state note precedence, independent of the panel DOM.
 */

import {
  autoArmDefersToNextCapture, preTriggerFill, preTriggerShortfall, triggerPanelNotes,
  triggerStatusNote, type TriggerNoteInput,
} from '../triggerStatus.js';
import { reconcileTrigger } from '../triggerViewport.js';
import { analogTriggerAutoArms, edgeTriggerAutoArms } from '../state.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });
const note = (patch: Partial<TriggerNoteInput> = {}) => triggerStatusNote({
  mode: 'single',
  running: true,
  triggerState: 'triggered',
  triggerViewLost: false,
  triggerViewPending: false,
  triggerLocked: false,
  triggerAnalogRolling: false,
  ...patch,
});

check('waiting and not-found win over every running/armed detail',
  note({ triggerState: 'waiting', triggerViewLost: true, triggerLocked: true }) === 'waiting' &&
  note({ triggerState: 'not-found', triggerViewLost: true }) === 'notFound' &&
  note({ triggerState: 'off' }) === null,
  `${note({ triggerState: 'waiting' })}, ${note({ triggerState: 'not-found' })}, ${note({ triggerState: 'off' })}`);

check('a forced (Auto) sweep is its own note, never not-found, also after the capture ends',
  note({ triggerState: 'forced' }) === 'autoForced' &&
  note({ triggerState: 'forced', running: false }) === 'autoForced' &&
  note({ triggerState: 'forced', mode: 'repeat' }) === 'autoForced',
  `${note({ triggerState: 'forced' })}, ${note({ triggerState: 'forced', running: false })}`);

check('a trigger match outside a running capture has no note',
  note({ running: false }) === null && note({ running: false, mode: 'loop' }) === null,
  `${note({ running: false })}, ${note({ running: false, mode: 'loop' })}`);

check('loop notes prefer lost, then describe the lock or the released state',
  note({ mode: 'loop', triggerViewLost: true, triggerLocked: true }) === 'viewLost' &&
  note({ mode: 'loop', triggerLocked: true, triggerAnalogRolling: true }) === 'loopAnalog' &&
  note({ mode: 'loop', triggerLocked: true }) === 'loopDigital' &&
  note({ mode: 'loop', triggerViewPending: true }) === null &&
  note({ mode: 'loop', triggerAnalogRolling: true }) === 'loopReleased' &&
  note({ mode: 'loop' }) === 'loopReleasedDigital',
  `${note({ mode: 'loop', triggerViewLost: true })}, ` +
  `${note({ mode: 'loop', triggerLocked: true, triggerAnalogRolling: true })}, ` +
  `${note({ mode: 'loop', triggerLocked: true })}, ` +
  `${note({ mode: 'loop', triggerViewPending: true })}, ` +
  `${note({ mode: 'loop', triggerAnalogRolling: true })}, ${note({ mode: 'loop' })}`);

check('single and repeat show the plain triggered note',
  note({ mode: 'single' }) === 'triggered' && note({ mode: 'repeat' }) === 'triggered',
  `${note({ mode: 'single' })}, ${note({ mode: 'repeat' })}`);

{
  const panel = (patch: Partial<Parameters<typeof triggerPanelNotes>[0]> = {}) =>
    triggerPanelNotes({
      running: true, stopping: false, mode: 'loop', triggerState: 'triggered',
      settingsArmed: true, triggerArmed: true, triggerLocked: true,
      triggerAnalogRolling: true, triggerViewPending: false, triggerAutoDisarmed: false,
      ...patch,
    });
  const p = panel();
  const waiting = panel({ triggerState: 'waiting', triggerLocked: false });
  const releasedDigital = panel({
    triggerLocked: false, triggerAnalogRolling: false,
  });
  const stopped = panel({ stopping: true });
  const freeRun = panel({
    triggerState: 'off', triggerArmed: false, triggerLocked: false,
    triggerAnalogRolling: false,
  });
  const noCondition = panel({
    triggerState: 'off', triggerArmed: false, settingsArmed: false,
    triggerLocked: false, triggerAnalogRolling: false,
  });
  const memory = panel({ triggerState: 'off', triggerArmed: false, triggerAutoDisarmed: true });
  const single = panel({ mode: 'single' });
  const repeat = panel({ mode: 'repeat' });
  const digitalLocked = panel({ triggerAnalogRolling: false, triggerLocked: true });
  const analogReleased = panel({ triggerLocked: false, triggerAnalogRolling: true });
  check('the panel shows pending/arming/armed-summary only in the states that mean them',
    !p.pending && !p.arming && !p.armedSummary && !p.memoryReleased &&
    !waiting.pending && waiting.armedSummary &&
    !releasedDigital.pending && !releasedDigital.armedSummary &&
    !stopped.pending &&
    freeRun.arming && !freeRun.armedSummary &&
    !noCondition.arming && !noCondition.armedSummary &&
    memory.memoryReleased && !memory.arming && !memory.armedSummary &&
    // A matched finite capture and a matched Loop-digital one-shot keep the edit-pending
    // note; a released analog Loop is still live via its scanner.
    single.pending && repeat.pending && digitalLocked.pending && !analogReleased.pending,
    `locked=${JSON.stringify(p)}, waiting=${JSON.stringify(waiting)}, ` +
    `releasedDigital=${JSON.stringify(releasedDigital)}, stopped=${JSON.stringify(stopped)}, ` +
    `freeRun=${JSON.stringify(freeRun)}, noCondition=${JSON.stringify(noCondition)}, ` +
    `memory=${JSON.stringify(memory)}, single=${single.pending}, repeat=${repeat.pending}, ` +
    `digitalLocked=${digitalLocked.pending}, analogReleased=${analogReleased.pending}`);
}

{
  // Actual pre-trigger readout: shown only when a triggered Single/Repeat capture holds
  // less than its configured window. The holdoff normally makes T == configured.
  const base = {
    mode: 'single' as const, triggerState: 'triggered' as const,
    configuredSamples: 100, triggerSampleIndex: 100,
  };
  const full = preTriggerShortfall(base);
  const short = preTriggerShortfall({ ...base, triggerSampleIndex: 25 });
  const repeatShort = preTriggerShortfall({ ...base, mode: 'repeat', triggerSampleIndex: 0 });
  const loop = preTriggerShortfall({ ...base, mode: 'loop', triggerSampleIndex: 3 });
  const waiting = preTriggerShortfall({ ...base, triggerState: 'waiting', triggerSampleIndex: null });
  const disabled = preTriggerShortfall({ ...base, configuredSamples: null, triggerSampleIndex: 5 });
  const noPre = preTriggerShortfall({ ...base, configuredSamples: 0, triggerSampleIndex: 0 });
  check('actual pre-trigger is reported only when a triggered capture is short of its window',
    full === null && short === 25 && repeatShort === 0 && loop === null &&
      waiting === null && disabled === null && noPre === null,
    `full=${full}, short=${short}, repeat=${repeatShort}, loop=${loop}, ` +
      `waiting=${waiting}, disabled=${disabled}, noPre=${noPre}`);
}

{
  // Pre-fill holdoff readout: shown only while an armed matcher waits and its effective
  // window has not been observed yet; it then gives way to the plain waiting note.
  const base = {
    triggerState: 'waiting' as const, triggerArmed: true,
    preTriggerSamples: 3_000_000, samplerate: 1e6, streamMs: 1250,
  };
  const filling = preTriggerFill(base);
  const start = preTriggerFill({ ...base, streamMs: 0 });
  const done = preTriggerFill({ ...base, streamMs: 3000 });
  const notArmedYet = preTriggerFill({ ...base, streamMs: null });
  const freeRun = preTriggerFill({ ...base, triggerArmed: false });
  const triggered = preTriggerFill({ ...base, triggerState: 'triggered' });
  const notFound = preTriggerFill({ ...base, triggerState: 'not-found' });
  const noPre = preTriggerFill({ ...base, preTriggerSamples: 0 });
  const noRate = preTriggerFill({ ...base, samplerate: 0 });
  const clockSkew = preTriggerFill({ ...base, streamMs: -5 });
  check('pre-fill readout spans [0, total) of the effective window and only while waiting',
    filling?.elapsedSec === 1.25 && filling.totalSec === 3 &&
      start?.elapsedSec === 0 && start.totalSec === 3 &&
      done === null && notArmedYet === null && freeRun === null && triggered === null &&
      notFound === null && noPre === null && noRate === null && clockSkew?.elapsedSec === 0,
    `filling=${JSON.stringify(filling)}, start=${JSON.stringify(start)}, done=${done}, ` +
      `notArmed=${notArmedYet}, free=${freeRun}, triggered=${triggered}, ` +
      `notFound=${notFound}, noPre=${noPre}, noRate=${noRate}, skew=${JSON.stringify(clockSkew)}`);

  const fill = { elapsedSec: 1, totalSec: 3 };
  const filled = note({ triggerState: 'waiting', triggerPreFill: fill });
  const loopFilled = note({ mode: 'loop', triggerState: 'waiting', triggerPreFill: fill });
  const afterFill = note({ triggerState: 'waiting', triggerPreFill: null });
  // A stale fill must never mask a match or a miss.
  const matched = note({ triggerState: 'triggered', triggerPreFill: fill });
  const missed = note({ triggerState: 'not-found', triggerPreFill: fill });
  check('the pre-fill note replaces "waiting" during the holdoff, then waiting resumes',
    filled === 'preFilling' && loopFilled === 'preFilling' && afterFill === 'waiting' &&
      matched === 'triggered' && missed === 'notFound',
    `filled=${filled}, loop=${loopFilled}, after=${afterFill}, matched=${matched}, missed=${missed}`);
}

{
  // Auto-arm during a running free-run capture: the first condition turns the mask on,
  // the running capture is not restarted, and the panel says the trigger arms the next
  // capture. An explicit enable (no deferral) keeps the documented restart-to-arm rule.
  const running = { running: true, stopping: false, captureArmed: false };
  const autoDigital = edgeTriggerAutoArms('dont-care', 'rising', false);
  const autoAnalog = analogTriggerAutoArms('rising', false);
  const deferDigital = autoArmDefersToNextCapture({ autoArms: autoDigital, ...running });
  const deferAnalog = autoArmDefersToNextCapture({ autoArms: autoAnalog, ...running });
  const idle = autoArmDefersToNextCapture({
    autoArms: true, running: false, stopping: false, captureArmed: false,
  });
  const stopping = autoArmDefersToNextCapture({ autoArms: true, ...running, stopping: true });
  const notAuto = autoArmDefersToNextCapture({ autoArms: false, ...running });
  const reconcile = (armDeferred: boolean) => reconcileTrigger({
    running: true, stopping: false, loop: false, captureArmed: false, phase: 'off',
    settingsArmed: true, armDeferred,
  });
  const deferredAction = reconcile(deferDigital);
  const explicitAction = reconcile(false);
  const loopDeferred = reconcileTrigger({
    running: true, stopping: false, loop: true, captureArmed: false, phase: 'off',
    settingsArmed: true, armDeferred: true,
  });
  // The deferral never blocks the armed-capture paths.
  const waitingRetune = reconcileTrigger({
    running: true, stopping: false, loop: false, captureArmed: true, phase: 'waiting',
    settingsArmed: true, armDeferred: true,
  });
  const panel = (deferred: boolean, patch: Partial<Parameters<typeof triggerPanelNotes>[0]> = {}) =>
    triggerPanelNotes({
      running: true, stopping: false, mode: 'single', triggerState: 'off',
      settingsArmed: true, triggerArmed: false, triggerLocked: false,
      triggerAnalogRolling: false, triggerViewPending: false, triggerAutoDisarmed: false,
      triggerArmDeferred: deferred, ...patch,
    });
  const deferredNotes = panel(true);
  const explicitNotes = panel(false);
  const nextCapture = panel(true, { running: false });
  const armedNow = panel(true, { triggerArmed: true, triggerState: 'waiting' });
  check('auto-arm during a running free-run capture defers to the next capture, visibly',
    autoDigital && autoAnalog && deferDigital && deferAnalog && !idle && !stopping &&
      !notAuto && deferredAction === 'none' && explicitAction === 'restart' &&
      loopDeferred === 'none' && waitingRetune === 'retune' &&
      deferredNotes.armNext && !deferredNotes.arming &&
      !explicitNotes.armNext && explicitNotes.arming &&
      !nextCapture.armNext && !nextCapture.arming && nextCapture.armedSummary &&
      !armedNow.armNext && armedNow.armedSummary,
    `defer=${deferDigital}/${deferAnalog} idle=${idle} stopping=${stopping} ` +
      `notAuto=${notAuto} actions=${deferredAction}/${explicitAction}/${loopDeferred}/` +
      `${waitingRetune} deferred=${JSON.stringify(deferredNotes)} ` +
      `explicit=${JSON.stringify(explicitNotes)} next=${JSON.stringify(nextCapture)} ` +
      `armed=${JSON.stringify(armedNow)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
