// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Trigger-state note precedence, independent of the panel DOM.
 */

import {
  preTriggerShortfall, triggerPanelNotes, triggerStatusNote, type TriggerNoteInput,
} from '../triggerStatus.js';

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

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
