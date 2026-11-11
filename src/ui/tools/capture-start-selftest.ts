// SPDX-License-Identifier: GPL-3.0-or-later

import {
  captureStartHoldDue, emptyHintVisible, planCaptureStartDisplay,
  type CaptureStartDisplay, type CaptureStartDisplayInput, type EmptyHintInput,
} from '../captureStart.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const HOLD: CaptureStartDisplayInput = {
  displayedSamples: 160_000_000, displayedChannels: 32, captureChannels: 32, quietRepeat: false,
};

{
  const cases: [string, CaptureStartDisplayInput, CaptureStartDisplay][] = [
    ['cold start', { ...HOLD, displayedSamples: 0 }, 'swap-now'],
    ['a previous capture on screen', HOLD, 'hold-previous'],
    ['a one-sample previous capture', { ...HOLD, displayedSamples: 1 }, 'hold-previous'],
    ['a quiet Repeat wave', { ...HOLD, quietRepeat: true }, 'swap-now'],
    ['a narrower displayed store', { ...HOLD, displayedChannels: 8 }, 'swap-now'],
    ['a wider displayed store', {
      ...HOLD, displayedSamples: 1000, displayedChannels: 16, captureChannels: 8,
    }, 'swap-now'],
    ['a cold start with a width change', {
      ...HOLD, displayedSamples: 0, displayedChannels: 8, captureChannels: 32,
    }, 'swap-now'],
  ];
  const wrong = cases.filter(([, input, want]) => planCaptureStartDisplay(input) !== want);
  check('a start holds the previous capture only when there is one of the same width',
    wrong.length === 0,
    wrong.length === 0
      ? cases.map(([name, input]) => `${name}→${planCaptureStartDisplay(input)}`).join(', ')
      : wrong.map(([name, input, want]) => `${name} want ${want} got ${planCaptureStartDisplay(input)}`).join('; '));

  const mutants: [string, (input: CaptureStartDisplayInput) => CaptureStartDisplay][] = [
    ['an empty store is held too', (input) => (input.quietRepeat || input.displayedChannels !==
      input.captureChannels ? 'swap-now' : 'hold-previous')],
    ['the width guard was dropped', (input) => (input.quietRepeat || !(input.displayedSamples > 0)
      ? 'swap-now' : 'hold-previous')],
    ['a quiet Repeat wave is held', (input) => (!(input.displayedSamples > 0) ||
      input.displayedChannels !== input.captureChannels ? 'swap-now' : 'hold-previous')],
  ];
  const survivors: string[] = [];
  for (const [name, mutant] of mutants) {
    const caught = cases.filter(([, input, want]) => mutant(input) !== want);
    if (caught.length === 0) survivors.push(`${name} (never disagrees)`);
  }
  check('every guard of the hold decision is load-bearing',
    survivors.length === 0,
    survivors.length === 0
      ? mutants.map(([name]) => `${name}→caught`).join(', ')
      : survivors.join('; '));
}

{
  const cases: [number, boolean][] = [[0, false], [1, true], [1_000_000, true], [-1, false]];
  const wrong = cases.filter(([samples, want]) => captureStartHoldDue(samples) !== want);
  check('the hold releases on the first sample the new capture receives',
    wrong.length === 0,
    wrong.length === 0
      ? cases.map(([samples]) => `${samples}→${captureStartHoldDue(samples)}`).join(', ')
      : wrong.map(([samples, want]) => `${samples} want ${want}`).join('; '));

  const always = (): boolean => true;
  const never = (): boolean => false;
  const caught = cases.filter(([samples]) => always() !== captureStartHoldDue(samples)).length;
  const caughtNever = cases.filter(([samples]) => never() !== captureStartHoldDue(samples)).length;
  check('the release predicate is neither always nor never',
    caught > 0 && caughtNever > 0,
    `always-disagrees=${caught}, never-disagrees=${caughtNever}`);
}

{
  const cases: [string, EmptyHintInput, boolean][] = [
    ['nothing loaded', { displayedSamples: 0, running: false, holdPending: false }, true],
    ['the first samples are on the way', {
      displayedSamples: 0, running: true, holdPending: false,
    }, false],
    ['the previous capture is being held', {
      displayedSamples: 0, running: false, holdPending: true,
    }, false],
    ['a completed capture', {
      displayedSamples: 160_000_000, running: false, holdPending: false,
    }, false],
    ['a running capture that already has data', {
      displayedSamples: 1000, running: true, holdPending: false,
    }, false],
    ['a hold while running', { displayedSamples: 0, running: true, holdPending: true }, false],
  ];
  const wrong = cases.filter(([, input, want]) => emptyHintVisible(input) !== want);
  check('the empty hint never shows while a capture owns the plot',
    wrong.length === 0,
    wrong.length === 0
      ? cases.map(([name, input]) => `${name}→${emptyHintVisible(input)}`).join(', ')
      : wrong.map(([name, input, want]) => `${name} want ${want} got ${emptyHintVisible(input)}`).join('; '));

  const mutants: [string, (input: EmptyHintInput) => boolean][] = [
    ['running was ignored', (input) => !input.holdPending && input.displayedSamples === 0],
    ['the hold was ignored', (input) => !input.running && input.displayedSamples === 0],
    ['any sample counts as empty', (input) => !input.running && !input.holdPending],
  ];
  const survivors: string[] = [];
  for (const [name, mutant] of mutants) {
    if (cases.every(([, input, want]) => mutant(input) === want)) survivors.push(name);
  }
  check('each empty-hint input is load-bearing',
    survivors.length === 0,
    survivors.length === 0
      ? mutants.map(([name]) => `${name}→caught`).join(', ')
      : survivors.join('; '));
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const count = (needle: string): number => app.split(needle).length - 1;
  const bodyBetween = (start: string, end: string): string => {
    if (count(start) !== 1 || count(end) !== 1) return '';
    return app.split(start)[1]!.split(end)[0]!;
  };

  const startBody = bodyBetween('private async startCapture(', 'private enforceLoopRetention(');
  const frameBody = bodyBetween('private frame = (): void => {', 'private recordFrameCost(');
  const drawBody = bodyBetween('private draw(force = true): void {', 'private frameFingerprint(');

  const needlesPresent = [
    'planCaptureStartDisplay(',
    'captureStartHoldDue(',
    'settleHeldCaptureStart(',
    'emptyHintVisible(',
    'private pendingCaptureStore: SampleStore | null = null;',
  ].filter((needle) => count(needle) === 0);
  check('the hold is wired through the module instead of an inline predicate',
    needlesPresent.length === 0 && count('this.el.hint.style.display = this.store.length > 0') === 0,
    needlesPresent.length === 0
      ? `hold-plan ${count('planCaptureStartDisplay(')}x, release ${count('captureStartHoldDue(')}x, ` +
        `settle ${count('settleHeldCaptureStart(')}x, hint ${count('emptyHintVisible(')}x`
      : `missing ${needlesPresent.join(', ')}`);

  check('the start holds only when the plan says so and settles it at the boundary',
    startBody.includes('}) === \'hold-previous\';') &&
    startBody.includes('if (hold) this.pendingCaptureStore = store;') &&
    startBody.includes('this.settleHeldCaptureStart();') &&
    startBody.includes('this.pendingCaptureStore = null;'),
    `start body ${startBody.length} chars, settle ${count('this.settleHeldCaptureStart();')}x`);

  check('the hold is released in the frame callback, before the live decision, not in draw',
    frameBody.includes('captureStartHoldDue(') &&
    frameBody.indexOf('captureStartHoldDue(') < frameBody.indexOf('liveDrawDue(') &&
    frameBody.includes('this.dirty = true;') &&
    !drawBody.includes('captureStartHoldDue(') &&
    !drawBody.includes('pendingCaptureStore = null'),
    `frame ${frameBody.length} chars, draw ${drawBody.length} chars`);

  const settleCallers = [
    ['App.startCapture', bodyBetween('private async startCapture(', 'private enforceLoopRetention(')],
    ['App.adoptCapture', bodyBetween('private adoptCapture(', 'private saveItems(')],
    ['App.discardDevice', bodyBetween('private discardDevice(', 'private detachDevice(')],
    ['App.finishCapture', bodyBetween('private finishCapture(', 'private discardDecodeState(')],
  ].filter(([, body]) => body.length === 0 || !body.includes('this.settleHeldCaptureStart();'));
  check('every capture boundary settles a still-pending start',
    settleCallers.length === 0,
    settleCallers.length === 0
      ? `settle call sites: ${count('this.settleHeldCaptureStart();')}`
      : `missing or unreadable in ${settleCallers.map(([name]) => name).join(', ')}`);

  const retentionCalls = count('this.enforceLoopRetention(');
  check('the loop retention trims the capture store, never the held display store',
    retentionCalls === 3 &&
    count('this.enforceLoopRetention(this.storeRef)') === 0 &&
    count('this.enforceLoopRetention(store)') === 2 &&
    count('this.enforceLoopRetention(capture)') === 1,
    `retention calls ${retentionCalls}, display-store calls ` +
      `${count('this.enforceLoopRetention(this.storeRef)')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
