// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The analog Auto sweep in the UI (ARCHITECTURE "Analog triggers sweep in Auto, digital
 * ones in Normal"; DESIGN trigger "States").
 *
 * Contract pinned here:
 *   - an analog source in Single/Repeat arms the matcher with autoAfterSamples = the
 *     capture window (pre + post, the store budget); digital sources and Loop pass none;
 *   - a 'forced' state is "Auto (not triggered)": no T, never the not-found/no-capture
 *     text, labelled as untriggered data, completes like an untriggered capture;
 *   - in Repeat a forced wave is a normal wave (hands over, not a miss);
 *   - the four locales carry real translations of the new keys.
 */

import {
  finishedCaptureLabel, preTriggerShortfall, triggerAutoAfterSamples, triggerPanelNotes,
  triggerReconcilePhase, triggerStatusNote, type TriggerNoteInput,
} from '../triggerStatus.js';
import { reconcileTrigger } from '../triggerViewport.js';
import { repeatHoldReleased } from '../repeatDisplay.js';
import { formatCaptureLabel } from '../format.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { setLocale } from '../i18n.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => results.push({ name, pass, detail });

// --- Status note -------------------------------------------------------------------
const note = (patch: Partial<TriggerNoteInput> = {}) => triggerStatusNote({
  mode: 'single', running: true, triggerState: 'forced', triggerViewLost: false,
  triggerViewPending: false, triggerLocked: false, triggerAnalogRolling: false, ...patch,
});
{
  const cases = [
    note(), note({ running: false }), note({ mode: 'repeat' }),
    note({ mode: 'repeat', running: false }), note({ triggerViewLost: true }),
  ];
  check('forced shows the Auto (not triggered) note, running or finished, never notFound',
    cases.every((c) => c === 'autoForced'), cases.join(', '));
  check('the other states keep their notes',
    note({ triggerState: 'not-found' }) === 'notFound' &&
    note({ triggerState: 'triggered' }) === 'triggered' &&
    note({ triggerState: 'waiting' }) === 'waiting' &&
    note({ triggerState: 'off' }) === null,
    `${note({ triggerState: 'not-found' })} ${note({ triggerState: 'triggered' })}`);
}

// --- Panel notes -------------------------------------------------------------------
{
  const panel = (patch: Partial<Parameters<typeof triggerPanelNotes>[0]> = {}) =>
    triggerPanelNotes({
      running: true, stopping: false, mode: 'single', triggerState: 'forced',
      settingsArmed: true, triggerArmed: true, triggerLocked: false,
      triggerAnalogRolling: false, triggerViewPending: false, triggerAutoDisarmed: false,
      ...patch,
    });
  const live = panel();
  const done = panel({ running: false });
  check('a forced sweep is past its search: edits are pending, nothing claims armed',
    live.pending && !live.armedSummary && !live.arming && !done.pending,
    `${JSON.stringify(live)} ${JSON.stringify(done)}`);
}

// --- No T ----------------------------------------------------------------------------
check('a forced sweep has no pre-trigger shortfall readout (no T)',
  preTriggerShortfall({
    mode: 'single', triggerState: 'forced', configuredSamples: 100, triggerSampleIndex: null,
  }) === null &&
  preTriggerShortfall({
    mode: 'single', triggerState: 'forced', configuredSamples: 100, triggerSampleIndex: 3,
  }) === null);

// --- Auto window -------------------------------------------------------------------
{
  const w = 1_000_000 + 250_000;
  const single = triggerAutoAfterSamples({ mode: 'single', analogSource: true, captureWindowSamples: w });
  const repeat = triggerAutoAfterSamples({ mode: 'repeat', analogSource: true, captureWindowSamples: w });
  const loop = triggerAutoAfterSamples({ mode: 'loop', analogSource: true, captureWindowSamples: w });
  const digital = triggerAutoAfterSamples({ mode: 'single', analogSource: false, captureWindowSamples: w });
  const digitalRepeat = triggerAutoAfterSamples({ mode: 'repeat', analogSource: false, captureWindowSamples: w });
  const empty = triggerAutoAfterSamples({ mode: 'single', analogSource: true, captureWindowSamples: 0 });
  const bad = triggerAutoAfterSamples({ mode: 'single', analogSource: true, captureWindowSamples: Number.NaN });
  check('analog Single/Repeat/Loop sweep in Auto after one window; digital stays Normal',
    single === w && repeat === w && loop === w && digital === undefined &&
    digitalRepeat === undefined && empty === undefined && bad === undefined,
    `${single} ${repeat} ${loop} ${digital} ${digitalRepeat} ${empty} ${bad}`);
}

// --- Reconcile -----------------------------------------------------------------------
{
  const phase = triggerReconcilePhase('forced');
  const base = {
    running: true, stopping: false, loop: false, captureArmed: true, phase,
    settingsArmed: true, armDeferred: false,
  } as const;
  const edit = reconcileTrigger(base);
  const off = reconcileTrigger({ ...base, settingsArmed: false });
  check('a forced sweep reconciles like a match (edits wait; turning off disables)',
    phase === 'triggered' && edit === 'none' && off === 'disable' &&
    triggerReconcilePhase('not-found') === 'not-found' &&
    triggerReconcilePhase('waiting') === 'waiting', `${phase} ${edit} ${off}`);
}

// --- Repeat hand-over ------------------------------------------------------------------
check('a forced Repeat wave hands the plot over once it has data (a normal wave)',
  repeatHoldReleased({
    showingFront: true, backLength: 64, softwareTrigger: true, triggerState: 'forced',
    triggerSampleIndex: null,
  }) &&
  !repeatHoldReleased({
    showingFront: true, backLength: 0, softwareTrigger: true, triggerState: 'forced',
    triggerSampleIndex: null,
  }));

// --- Capture label -------------------------------------------------------------------
{
  const forced = finishedCaptureLabel('forced', 2000, 1e6);
  const miss = finishedCaptureLabel('not-found', 0, 1e6);
  const hit = finishedCaptureLabel('triggered', 2000, 1e6);
  const free = finishedCaptureLabel('off', 2000, 1e6);
  void setLocale('en');
  const text = formatCaptureLabel(forced);
  check('a forced capture is labelled Auto (not triggered), never "no trigger"/nothing',
    forced.kind === 'autoForced' && miss.kind === 'stoppedNoTrigger' &&
    hit.kind === 'live' && free.kind === 'live' &&
    text.startsWith('auto (not triggered)') && !/no trigger/.test(text) &&
    text.includes('2,000'), `${forced.kind} "${text}"`);
}

// --- Locales ---------------------------------------------------------------------------
{
  const keys = [
    'capture.autoForced', 'capturePanel.triggerAutoForced', 'capturePanel.triggerAutoForcedHint',
  ] as const;
  const catalogs = { zhCN, fr, ru } as Record<string, Record<string, string>>;
  const bad: string[] = [];
  for (const key of keys) {
    const ref = en[key];
    if (!ref) bad.push(`en:${key}`);
    for (const [loc, cat] of Object.entries(catalogs)) {
      const v = cat[key];
      if (!v || v === ref) bad.push(`${loc}:${key}`);
    }
  }
  const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  for (const [loc, cat] of Object.entries(catalogs)) {
    if (placeholders(cat['capture.autoForced'] ?? '') !== placeholders(en['capture.autoForced'])) {
      bad.push(`${loc}:placeholders`);
    }
  }
  check('the Auto keys are translated in all four locales with the same placeholders',
    bad.length === 0, bad.join(' '));
  check('the zh wording is 自动（未触发） and the en wording Auto (not triggered)',
    zhCN['capturePanel.triggerAutoForced'] === '自动（未触发）' &&
    en['capturePanel.triggerAutoForced'] === 'Auto (not triggered)' &&
    !/nothing was recorded|no capture/i.test(en['capturePanel.triggerAutoForcedHint']),
    `${zhCN['capturePanel.triggerAutoForced']} / ${en['capturePanel.triggerAutoForced']}`);
}

// --- App wiring (source pins) -------------------------------------------------------
{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const start = app.slice(app.indexOf('const autoAfterSamples = softwareTrigger'),
    app.indexOf('this.captureArming = true;', app.indexOf('const autoAfterSamples = softwareTrigger')));
  check('the start config computes Auto from the analog-only source and the capture window',
    start.length > 0 &&
    /analogSource: analogTriggers\.length > 0 && plan\.digital\.length === 0/.test(start) &&
    /captureWindowSamples: isLoop \? this\.loopRetentionLen : this\.captureLimitSamples/.test(start) &&
    /\bmode,/.test(start), start.slice(0, 240));
  // The window must be read after the trigger budget clamp (pre + post).
  const budgetAt = app.indexOf('this.captureLimitSamples = Math.min(MAX_SAMPLES - 1, postTriggerSamples + preTriggerSamples)');
  check('Auto is computed after the store budget becomes pre + post',
    budgetAt > 0 && budgetAt < app.indexOf('const autoAfterSamples = softwareTrigger'));
  const triggerCfg = app.slice(app.indexOf('softwareTrigger: {\n          channels: cfg.channels'),
    app.indexOf('onTriggerState: (state, triggerSampleIndex)'));
  // The matcher config is the one carrier: the device reads it from softwareTrigger,
  // like searchLimitSamples, and nothing reads a start-options copy.
  check('the matcher config carries the Auto option (absent for Normal)',
    (triggerCfg.match(/\.\.\.autoSweepOption\(autoAfterSamples\)/g) ?? []).length === 1 &&
    /return autoAfterSamples === undefined \? \{\} : \{ autoAfterSamples \}/.test(app),
    triggerCfg.slice(-400));
  const retune = app.slice(app.indexOf('const applied = update?.({'),
    app.indexOf('this.triggerRetuneRequested = applied === false;'));
  check('a live retune keeps Auto only for an analog source, with the Loop window in Loop',
    /analogSource: analog\.length > 0 && conditions\.length === 0/.test(retune) &&
    /mode: this\.captureMode/.test(retune) &&
    /autoWindowSamples: isLoop \? this\.loopRetentionLen : this\.captureLimitSamples,/.test(app),
    retune.slice(0, 200));
  const relock = app.slice(app.indexOf('private lockFromCrossing('),
    app.indexOf('private releaseLoopTrigger('));
  check('a Loop Auto sweep that re-locks on a real crossing reads triggered',
    /if \(this\.triggerState === 'forced'\) this\.triggerState = 'triggered';/.test(relock),
    relock.slice(0, 200));
  const handler = app.slice(app.indexOf('onTriggerState: (state, triggerSampleIndex)'),
    app.indexOf('} : {', app.indexOf('onTriggerState: (state, triggerSampleIndex)')));
  const forcedBlock = handler.slice(handler.indexOf("if (state === 'forced') {"),
    handler.indexOf("if (state === 'triggered' && triggerSampleIndex !== undefined)"));
  check("'forced' clears T, starts the clock, releases the Repeat hold and clears a miss",
    forcedBlock.length > 0 && /this\.clearTriggerSample\(\);/.test(forcedBlock) &&
    /this\.repeatWaveHolding = false;/.test(forcedBlock) &&
    /this\.repeatMissed = false;/.test(forcedBlock) &&
    !/this\.repeatMissed = true/.test(forcedBlock) &&
    !/stopCapture/.test(forcedBlock) && !/triggerSampleIndex = /.test(forcedBlock),
    forcedBlock.slice(0, 200));
  const missBlock = handler.slice(handler.indexOf("if (state === 'not-found') {"));
  check('only not-found is a miss/stop; forced completes through onEnd like a free capture',
    /repeatMissed = true/.test(missBlock) && !/'forced'/.test(missBlock));
  check('the finish label and the Repeat front remember a forced sweep',
    /this\.captureLabel = finishedCaptureLabel\(this\.triggerState, captured\.length, sr\);/.test(app) &&
    /forced: this\.triggerState === 'forced',/.test(app) &&
    /front\.hasTrigger \? 'triggered' : front\.forced \? 'forced' : 'off'/.test(app));
  check('the panel renders the Auto note with its explanation, not the not-found text',
    /note === 'autoForced'/.test(panel) &&
    /t\('capturePanel\.triggerAutoForced'\)/.test(panel) &&
    /t\('capturePanel\.triggerAutoForcedHint'\)/.test(panel));
  // A settled held Repeat wave is titled from its own trigger state, so a forced wave's
  // title says Auto like the panel (integration review, 2026-11-09).
  const held = app.slice(app.indexOf('private settleAndLabelHeldWave(): void {'),
    app.indexOf('\n  }\n', app.indexOf('private settleAndLabelHeldWave(): void {')));
  check('a settled held wave takes its title from its trigger state',
    held.includes('finishedCaptureLabel(this.triggerState, captured.length, captured.samplerate)') &&
    !held.includes("kind: 'live'"));
  // A live retune always states the Auto window: omitting it would keep the running
  // analog deadline after a switch to a digital source.
  check('a live retune always passes an explicit Auto window (Infinity for Normal)',
    app.includes('}) ?? Number.POSITIVE_INFINITY,') &&
    app.includes('autoAfterSamples: triggerAutoAfterSamples({'));
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
