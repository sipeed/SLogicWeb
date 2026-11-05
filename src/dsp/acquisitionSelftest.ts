// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic checks for the M0 composite acquisition state machine and `mayEdit`
 * capability table. Self-contained: no store, DOM or hardware.
 *
 * Run:
 *   node_modules/.bin/esbuild src/dsp/acquisitionSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/acquisition-selftest.mjs --log-level=error
 *   node /tmp/acquisition-selftest.mjs
 */

import {
  ACQUISITION_STATES,
  EDIT_FEATURES,
  createAcquisitionContext,
  mayEdit,
  transition,
  type AcquisitionContext,
  type AcquisitionEvent,
  type AcquisitionState,
  type EditDecision,
  type EditFeature,
  type Effect,
  type RecordingState,
} from './acquisition.js';

let failures = 0;

/** This file runs under node, but tsconfig only pulls in the DOM types. */
function failExit(): void {
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (proc) proc.exitCode = 1;
}

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`);
  }
}

function context(overrides: Partial<AcquisitionContext> = {}): AcquisitionContext {
  return createAcquisitionContext(overrides);
}

// ---------------------------------------------------------------------------
// Transition table (successful transitions)
// ---------------------------------------------------------------------------

interface TransitionCase {
  readonly name: string;
  readonly from: Partial<AcquisitionContext>;
  readonly event: AcquisitionEvent;
  readonly to: Partial<AcquisitionContext>;
  readonly effects: readonly Effect[];
}

const transitionCases: readonly TransitionCase[] = [
  // Connection chain. `completed` is the generic asynchronous-step event.
  {
    name: 'connection idle + connect -> selecting',
    from: { connection: 'idle' },
    event: 'connect',
    to: { connection: 'selecting', acquisition: 'idle' },
    effects: ['request-device'],
  },
  {
    name: 'connection closed + connect -> selecting',
    from: { connection: 'closed' },
    event: 'connect',
    to: { connection: 'selecting' },
    effects: ['request-device'],
  },
  {
    name: 'connect from lost resets the dead acquisition to idle',
    from: { connection: 'lost', acquisition: 'lost', triggerMatched: true },
    event: 'connect',
    to: {
      connection: 'selecting',
      acquisition: 'idle',
      triggerMatched: false,
      acquisitionBeforeSuspend: null,
    },
    effects: ['request-device'],
  },
  {
    name: 'selecting + completed -> opening',
    from: { connection: 'selecting' },
    event: 'completed',
    to: { connection: 'opening' },
    effects: ['open-device'],
  },
  {
    name: 'opening + completed -> claiming',
    from: { connection: 'opening' },
    event: 'completed',
    to: { connection: 'claiming' },
    effects: ['claim-interface'],
  },
  {
    name: 'claiming + completed -> handshaking',
    from: { connection: 'claiming' },
    event: 'completed',
    to: { connection: 'handshaking' },
    effects: ['handshake-device'],
  },
  {
    name: 'handshaking + completed -> ready',
    from: { connection: 'handshaking' },
    event: 'completed',
    to: { connection: 'ready' },
    effects: ['connection-ready'],
  },
  {
    name: 'disconnect from ready closes the link',
    from: { connection: 'ready' },
    event: 'disconnect',
    to: { connection: 'closed', acquisition: 'idle' },
    effects: ['close-device'],
  },
  {
    name: 'disconnect while running stops the device and pauses the record',
    from: { connection: 'ready', acquisition: 'running', recording: 'recording', triggerMatched: true },
    event: 'disconnect',
    to: {
      connection: 'closed',
      acquisition: 'idle',
      recording: 'paused',
      triggerMatched: false,
    },
    effects: ['stop-device', 'pause-record', 'close-device'],
  },
  {
    name: 'disconnect disarms a record that never started',
    from: { connection: 'ready', recording: 'armed' },
    event: 'disconnect',
    to: { connection: 'closed', recording: 'off' },
    effects: ['disarm-record', 'close-device'],
  },

  // Start: idle -> arming.
  {
    name: 'acquisition idle + start -> arming',
    from: { connection: 'ready' },
    event: 'start',
    to: { acquisition: 'arming' },
    effects: ['start-device'],
  },
  {
    name: 'a new session resets a Fixed view to FollowLive',
    from: { connection: 'ready', view: 'fixed' },
    event: 'start',
    to: { acquisition: 'arming', view: 'follow', viewBeforeLock: 'follow' },
    effects: ['start-device', 'relayout'],
  },
  {
    name: 'an armed record starts with the acquisition',
    from: { connection: 'ready', recording: 'armed' },
    event: 'start',
    to: { acquisition: 'arming', recording: 'recording' },
    effects: ['start-device', 'start-record'],
  },
  {
    name: 'start with record:arm only arms the record',
    from: { connection: 'ready', recording: 'off' },
    event: { type: 'start', record: 'arm' },
    to: { acquisition: 'idle', recording: 'armed' },
    effects: ['arm-record'],
  },
  {
    name: 'start with record:record records independently of the acquisition',
    from: { connection: 'ready', recording: 'off', acquisition: 'idle' },
    event: { type: 'start', record: 'record' },
    to: { acquisition: 'idle', recording: 'recording' },
    effects: ['start-record'],
  },

  // Device ready: arming -> waiting/running.
  {
    name: 'arming + device ready with a waiting plan -> waiting',
    from: { connection: 'ready', acquisition: 'arming', planWaits: true },
    event: 'completed',
    to: { acquisition: 'waiting' },
    effects: ['capture-ready'],
  },
  {
    name: 'arming + device ready on a free run -> running',
    from: { connection: 'ready', acquisition: 'arming', planWaits: false },
    event: 'completed',
    to: { acquisition: 'running' },
    effects: ['capture-ready'],
  },

  // Trigger match and retune.
  {
    name: 'waiting + match -> running (Single/Repeat do not lock the view)',
    from: { connection: 'ready', acquisition: 'waiting', mode: 'single' },
    event: 'trigger',
    to: { acquisition: 'running', triggerMatched: true, view: 'follow' },
    effects: ['mark-trigger', 'relayout'],
  },
  {
    name: 'a Loop match locks a Follow view on T',
    from: { connection: 'ready', acquisition: 'waiting', mode: 'loop', view: 'follow' },
    event: 'trigger',
    to: {
      acquisition: 'running',
      triggerMatched: true,
      view: 'triggerLocked',
      viewBeforeLock: 'follow',
    },
    effects: ['mark-trigger', 'relayout'],
  },
  {
    name: 'a Fixed view wins over a later Loop match',
    from: { connection: 'ready', acquisition: 'waiting', mode: 'loop', view: 'fixed' },
    event: 'trigger',
    to: { acquisition: 'running', triggerMatched: true, view: 'fixed' },
    effects: ['mark-trigger', 'relayout'],
  },
  {
    name: 'retune while waiting recompiles the trigger and stays waiting',
    from: { connection: 'ready', acquisition: 'waiting' },
    event: 'retune',
    to: { acquisition: 'waiting', triggerMatched: false },
    effects: ['recompile-trigger'],
  },
  {
    name: 'a Loop live detector retunes after a match',
    from: {
      connection: 'ready',
      acquisition: 'running',
      mode: 'loop',
      triggerMatched: true,
      liveTriggerRetune: true,
    },
    event: 'retune',
    to: { acquisition: 'running', triggerMatched: true },
    effects: ['recompile-trigger'],
  },

  // Stop and drain.
  {
    name: 'running + stop -> stopping',
    from: { connection: 'ready', acquisition: 'running', triggerMatched: true },
    event: 'stop',
    to: { acquisition: 'stopping', triggerMatched: false },
    effects: ['stop-device'],
  },
  {
    name: 'stop with a running record ends the record into exporting',
    from: { connection: 'ready', acquisition: 'waiting', recording: 'recording' },
    event: 'stop',
    to: { acquisition: 'stopping', recording: 'exporting' },
    effects: ['stop-device', 'stop-record', 'flush-record'],
  },
  {
    name: 'stopping + drained -> idle',
    from: { connection: 'ready', acquisition: 'stopping' },
    event: 'completed',
    to: { acquisition: 'idle' },
    effects: ['drain-capture'],
  },
  {
    name: 'a completed capture ends at idle and exports its record',
    from: { connection: 'ready', acquisition: 'running', recording: 'recording' },
    event: 'completed',
    to: { acquisition: 'idle', recording: 'exporting' },
    effects: ['drain-capture', 'stop-record', 'flush-record'],
  },
  {
    name: 'a drained stop finalises an exporting record',
    from: { connection: 'ready', acquisition: 'stopping', recording: 'exporting' },
    event: 'completed',
    to: { acquisition: 'idle', recording: 'off' },
    effects: ['drain-capture', 'finalize-record'],
  },

  // Restart is its own named phase.
  {
    name: 'waiting + restart -> restarting',
    from: { connection: 'ready', acquisition: 'waiting' },
    event: 'restart',
    to: { acquisition: 'restarting', triggerMatched: false },
    effects: ['restart-device'],
  },
  {
    name: 'running + restart -> restarting without resetting the view',
    from: { connection: 'ready', acquisition: 'running', view: 'fixed', triggerMatched: true },
    event: 'restart',
    to: { acquisition: 'restarting', view: 'fixed', triggerMatched: false },
    effects: ['restart-device'],
  },
  {
    name: 'restarting + re-armed -> arming',
    from: { connection: 'ready', acquisition: 'restarting' },
    event: 'completed',
    to: { acquisition: 'arming' },
    effects: ['start-device'],
  },

  // Repeat retry inferred from the partial key-transition table.
  {
    name: 'a Repeat miss (waiting + completed) -> retrying',
    from: { connection: 'ready', acquisition: 'waiting', mode: 'repeat' },
    event: 'completed',
    to: { acquisition: 'retrying' },
    effects: ['schedule-retry'],
  },
  {
    name: 'a triggered Repeat sweep also returns to retrying at its boundary',
    from: { connection: 'ready', acquisition: 'running', mode: 'repeat', triggerMatched: true },
    event: 'completed',
    to: { acquisition: 'retrying', triggerMatched: false },
    effects: ['schedule-retry'],
  },
  {
    name: 'a Repeat boundary keeps an independent recording running',
    from: { connection: 'ready', acquisition: 'running', mode: 'repeat', recording: 'recording' },
    event: 'completed',
    to: { acquisition: 'retrying', recording: 'recording' },
    effects: ['schedule-retry'],
  },
  {
    name: 'retrying + interval elapsed -> arming the next attempt',
    from: { connection: 'ready', acquisition: 'retrying', mode: 'repeat' },
    event: 'completed',
    to: { acquisition: 'arming' },
    effects: ['start-device'],
  },
  {
    name: 'a Single miss (waiting + completed) ends the acquisition',
    from: { connection: 'ready', acquisition: 'waiting', mode: 'single' },
    event: 'completed',
    to: { acquisition: 'idle' },
    effects: ['drain-capture'],
  },

  // Suspend / resume / lost.
  {
    name: 'suspend freezes the link, acquisition and running record',
    from: {
      connection: 'ready',
      acquisition: 'running',
      recording: 'recording',
      mode: 'loop',
      triggerMatched: true,
    },
    event: 'suspend',
    to: {
      connection: 'suspended',
      acquisition: 'suspended',
      recording: 'paused',
      acquisitionBeforeSuspend: 'running',
    },
    effects: ['suspend-device', 'pause-record'],
  },
  {
    name: 'suspend with an idle acquisition still suspends the link',
    from: { connection: 'ready' },
    event: 'suspend',
    to: { connection: 'suspended', acquisition: 'idle' },
    effects: ['suspend-device'],
  },
  {
    name: 'a repeated suspend is an idempotent no-op',
    from: { connection: 'suspended', acquisition: 'suspended' },
    event: 'suspend',
    to: { connection: 'suspended', acquisition: 'suspended' },
    effects: [],
  },
  {
    name: 'resume re-handshakes, restores the acquisition and resumes the record',
    from: {
      connection: 'suspended',
      acquisition: 'suspended',
      acquisitionBeforeSuspend: 'running',
      recording: 'paused',
      mode: 'loop',
      triggerMatched: true,
    },
    event: 'resume',
    to: {
      connection: 'handshaking',
      acquisition: 'running',
      recording: 'recording',
      acquisitionBeforeSuspend: null,
    },
    effects: ['resume-device', 'handshake-device', 'resume-record'],
  },
  {
    name: 'resume only resumes a paused record when nothing is suspended',
    from: { connection: 'ready', acquisition: 'running', recording: 'paused' },
    event: 'resume',
    to: { recording: 'recording' },
    effects: ['resume-record'],
  },
  {
    name: 'loss marks the link and acquisition lost and pauses the record',
    from: { connection: 'ready', acquisition: 'running', recording: 'recording', triggerMatched: true },
    event: 'lost',
    to: {
      connection: 'lost',
      acquisition: 'lost',
      recording: 'paused',
      triggerMatched: false,
      acquisitionBeforeSuspend: null,
    },
    effects: ['mark-lost', 'pause-record'],
  },
  {
    name: 'loss with an idle acquisition only marks the link lost',
    from: { connection: 'ready' },
    event: 'lost',
    to: { connection: 'lost', acquisition: 'idle' },
    effects: ['mark-lost'],
  },
  {
    name: 'a repeated loss notification is an idempotent no-op',
    from: { connection: 'lost', acquisition: 'lost', recording: 'paused' },
    event: 'lost',
    to: { connection: 'lost', acquisition: 'lost', recording: 'paused' },
    effects: [],
  },

  // Recording lifecycle.
  {
    name: 'recording + pause -> paused',
    from: { connection: 'ready', acquisition: 'running', recording: 'recording' },
    event: 'pause',
    to: { recording: 'paused', acquisition: 'running' },
    effects: ['pause-record'],
  },
  {
    name: 'export stops a running record and flushes it',
    from: { connection: 'ready', acquisition: 'running', recording: 'recording' },
    event: 'export',
    to: { recording: 'exporting', acquisition: 'running' },
    effects: ['stop-record', 'flush-record'],
  },
  {
    name: 'export flushes an already paused record',
    from: { connection: 'ready', acquisition: 'running', recording: 'paused' },
    event: 'export',
    to: { recording: 'exporting' },
    effects: ['flush-record'],
  },
  {
    name: 'export is the recovery path for a full record',
    from: { connection: 'ready', recording: 'full' },
    event: 'export',
    to: { recording: 'exporting' },
    effects: ['flush-record'],
  },
  {
    name: 'exporting + completed -> off',
    from: { connection: 'ready', acquisition: 'idle', recording: 'exporting' },
    event: 'completed',
    to: { recording: 'off' },
    effects: ['finalize-record'],
  },

  // View policy transitions.
  {
    name: 'a gesture replaces Follow with Fixed',
    from: { view: 'follow' },
    event: 'gesture',
    to: { view: 'fixed', viewBeforeLock: 'follow' },
    effects: ['relayout'],
  },
  {
    name: 'a gesture takes over a Loop trigger lock',
    from: { view: 'triggerLocked', viewBeforeLock: 'follow' },
    event: 'gesture',
    to: { view: 'fixed', viewBeforeLock: 'follow' },
    effects: ['relayout'],
  },
  {
    name: 'Fit replaces Fixed with Follow',
    from: { view: 'fixed' },
    event: 'fit',
    to: { view: 'follow', viewBeforeLock: 'follow' },
    effects: ['relayout'],
  },
  {
    name: 'Fit on Follow is accepted as a relayout',
    from: { view: 'follow' },
    event: 'fit',
    to: { view: 'follow', viewBeforeLock: 'follow' },
    effects: ['relayout'],
  },
  {
    name: 'Fit releases a Loop trigger lock',
    from: { view: 'triggerLocked', viewBeforeLock: 'fixed' },
    event: 'fit',
    to: { view: 'follow', viewBeforeLock: 'follow' },
    effects: ['relayout'],
  },
  {
    name: 'lock release restores the policy that preceded the lock',
    from: { view: 'triggerLocked', viewBeforeLock: 'fixed', acquisition: 'running' },
    event: 'release',
    to: { view: 'fixed', viewBeforeLock: 'follow', acquisition: 'running' },
    effects: ['relayout'],
  },
];

for (const testCase of transitionCases) {
  const result = transition(context(testCase.from), testCase.event);
  if ('refused' in result) {
    check(testCase.name, false, `refused: ${result.refused}`);
    continue;
  }
  const actual = result.context as unknown as Record<string, unknown>;
  const wanted = testCase.to as unknown as Record<string, unknown>;
  const mismatches: string[] = [];
  for (const key of Object.keys(wanted)) {
    if (actual[key] !== wanted[key]) {
      mismatches.push(
        `${key}=${JSON.stringify(actual[key])} want ${JSON.stringify(wanted[key])}`,
      );
    }
  }
  if (JSON.stringify(result.effects) !== JSON.stringify(testCase.effects)) {
    mismatches.push(
      `effects=${JSON.stringify(result.effects)} want ${JSON.stringify(testCase.effects)}`,
    );
  }
  check(testCase.name, mismatches.length === 0, mismatches.join('; '));
}

// ---------------------------------------------------------------------------
// Refusals: invalid events are typed values, never exceptions
// ---------------------------------------------------------------------------

interface RefusalCase {
  readonly name: string;
  readonly from: Partial<AcquisitionContext>;
  readonly event: AcquisitionEvent;
}

const refusalCases: readonly RefusalCase[] = [
  {
    name: 'start while running is refused',
    from: { connection: 'ready', acquisition: 'running' },
    event: 'start',
  },
  {
    name: 'start without a ready link is refused',
    from: { connection: 'idle' },
    event: 'start',
  },
  {
    name: 'start with an invalid record target is refused',
    from: { connection: 'ready' },
    event: { type: 'start', record: 'bogus' } as unknown as AcquisitionEvent,
  },
  {
    name: 'stop with no acquisition is refused',
    from: { connection: 'ready', acquisition: 'idle' },
    event: 'stop',
  },
  {
    name: 'stop while already stopping is refused',
    from: { connection: 'ready', acquisition: 'stopping' },
    event: 'stop',
  },
  {
    name: 'stop while suspended is refused',
    from: { connection: 'suspended', acquisition: 'suspended' },
    event: 'stop',
  },
  {
    name: 'restart with no acquisition is refused',
    from: { connection: 'ready', acquisition: 'idle' },
    event: 'restart',
  },
  {
    name: 'restart while retrying is refused',
    from: { connection: 'ready', acquisition: 'retrying' },
    event: 'restart',
  },
  {
    name: 'retune after a non-live match is refused as pending',
    from: { connection: 'ready', acquisition: 'running', mode: 'single', triggerMatched: true },
    event: 'retune',
  },
  {
    name: 'retune while stopping is refused',
    from: { connection: 'ready', acquisition: 'stopping' },
    event: 'retune',
  },
  {
    name: 'trigger with no waiting acquisition is refused',
    from: { connection: 'ready', acquisition: 'idle' },
    event: 'trigger',
  },
  {
    name: 'a second trigger match without a live detector is refused',
    from: { connection: 'ready', acquisition: 'running', mode: 'single', triggerMatched: true },
    event: 'trigger',
  },
  {
    name: 'a free-running acquisition cannot report a trigger match',
    from: { connection: 'ready', acquisition: 'running', mode: 'single' },
    event: 'trigger',
  },
  {
    name: 'release without a trigger lock is refused',
    from: { view: 'follow' },
    event: 'release',
  },
  {
    name: 'pause without a running record is refused',
    from: { connection: 'ready', acquisition: 'running', recording: 'off' },
    event: 'pause',
  },
  {
    name: 'pause while stopping is refused',
    from: { connection: 'ready', acquisition: 'stopping', recording: 'recording' },
    event: 'pause',
  },
  {
    name: 'resume with nothing suspended or paused is refused',
    from: { connection: 'ready', acquisition: 'running', recording: 'off' },
    event: 'resume',
  },
  {
    name: 'resume after loss is refused',
    from: { connection: 'lost', acquisition: 'lost', recording: 'paused' },
    event: 'resume',
  },
  {
    name: 'export with no record is refused',
    from: { connection: 'ready', recording: 'off' },
    event: 'export',
  },
  {
    name: 'export of an armed but unstarted record is refused',
    from: { connection: 'ready', recording: 'armed' },
    event: 'export',
  },
  {
    name: 'completed with no pending step is refused',
    from: { connection: 'ready', acquisition: 'idle', recording: 'off' },
    event: 'completed',
  },
  {
    name: 'connect while already ready is refused',
    from: { connection: 'ready' },
    event: 'connect',
  },
  {
    name: 'connect while already selecting is refused',
    from: { connection: 'selecting' },
    event: 'connect',
  },
  {
    name: 'disconnect while idle is refused',
    from: { connection: 'idle' },
    event: 'disconnect',
  },
  {
    name: 'disconnect when already closed is refused',
    from: { connection: 'closed' },
    event: 'disconnect',
  },
  {
    name: 'a loss notification without a live session is refused',
    from: { connection: 'idle', acquisition: 'idle', recording: 'off' },
    event: 'lost',
  },
  {
    name: 'a suspend notification without a live session is refused',
    from: { connection: 'idle', acquisition: 'idle', recording: 'off' },
    event: 'suspend',
  },
  {
    name: 'unknown event names are refused',
    from: { connection: 'ready' },
    event: 'bogus' as unknown as AcquisitionEvent,
  },
  {
    name: 'an object with an unknown type is refused',
    from: { connection: 'ready' },
    event: { type: 'bogus' } as unknown as AcquisitionEvent,
  },
  {
    name: 'a non-event value is refused',
    from: { connection: 'ready' },
    event: null as unknown as AcquisitionEvent,
  },
  {
    name: 'an object without a type is refused',
    from: { connection: 'ready' },
    event: {} as unknown as AcquisitionEvent,
  },
];

for (const testCase of refusalCases) {
  const result = transition(context(testCase.from), testCase.event);
  const refused = 'refused' in result && typeof result.refused === 'string' &&
    result.refused.length > 0;
  check(
    testCase.name,
    refused,
    'refused' in result ? result.refused : 'transition was accepted',
  );
}

// Purity: the input tuple is never mutated.
{
  const before = context({ connection: 'ready', acquisition: 'running', recording: 'recording' });
  const snapshot = JSON.stringify(before);
  transition(before, 'suspend');
  transition(before, 'lost');
  transition(before, 'gesture');
  check('transition never mutates its input context', JSON.stringify(before) === snapshot);
}

// ---------------------------------------------------------------------------
// mayEdit capability table
// ---------------------------------------------------------------------------

type EditGroup = 'view' | 'trigger' | 'device' | 'host' | 'recordStart' | 'recordPause';

/**
 * This partition is part of the expected contract, not a copy of the implementation:
 * a feature moving between groups must update these tests deliberately.
 */
const EDIT_GROUPS: Record<EditGroup, readonly EditFeature[]> = {
  view: ['cursor', 'bus', 'theme'],
  trigger: [
    'triggerMask',
    'triggerSource',
    'digitalConditions',
    'analogCondition',
    'preTrigger',
  ],
  device: ['mode', 'width', 'rate', 'threshold', 'testMode'],
  host: ['duration', 'repeatInterval', 'loopWindow'],
  recordStart: ['recordStart'],
  recordPause: ['recordPause'],
};

const grouped = new Set<EditFeature>();
for (const group of Object.keys(EDIT_GROUPS) as EditGroup[]) {
  for (const feature of EDIT_GROUPS[group]) grouped.add(feature);
}
const ungrouped = EDIT_FEATURES.filter((feature) => !grouped.has(feature));
check(
  'every declared edit feature has a mayEdit expectation',
  ungrouped.length === 0,
  ungrouped.join(', '),
);

type EditKind = EditDecision['kind'];

/**
 * Expected decisions with a ready link and `triggerMatched` false except while running.
 * `recordStart` is evaluated with the record off; `recordPause` with it recording.
 */
const EXPECTED: Record<EditGroup, Record<AcquisitionState, EditKind>> = {
  view: {
    idle: 'allow',
    arming: 'allow',
    waiting: 'allow',
    running: 'allow',
    stopping: 'allow',
    restarting: 'allow',
    retrying: 'allow',
    suspended: 'allow',
    lost: 'allow',
  },
  trigger: {
    idle: 'allow',
    arming: 'next',
    waiting: 'allow',
    running: 'next',
    stopping: 'refuse',
    restarting: 'next',
    retrying: 'next',
    suspended: 'refuse',
    lost: 'refuse',
  },
  device: {
    idle: 'allow',
    arming: 'next',
    waiting: 'restart',
    running: 'restart',
    stopping: 'refuse',
    restarting: 'next',
    retrying: 'next',
    suspended: 'refuse',
    lost: 'refuse',
  },
  host: {
    idle: 'allow',
    arming: 'next',
    waiting: 'next',
    running: 'next',
    stopping: 'refuse',
    restarting: 'next',
    retrying: 'next',
    suspended: 'refuse',
    lost: 'refuse',
  },
  recordStart: {
    idle: 'allow',
    arming: 'allow',
    waiting: 'allow',
    running: 'allow',
    stopping: 'refuse',
    restarting: 'allow',
    retrying: 'allow',
    suspended: 'refuse',
    lost: 'refuse',
  },
  recordPause: {
    idle: 'allow',
    arming: 'allow',
    waiting: 'allow',
    running: 'allow',
    stopping: 'refuse',
    restarting: 'allow',
    retrying: 'allow',
    suspended: 'refuse',
    lost: 'refuse',
  },
};

function editContext(
  group: EditGroup,
  state: AcquisitionState,
  overrides: Partial<AcquisitionContext> = {},
): AcquisitionContext {
  return context({
    connection: 'ready',
    acquisition: state,
    mode: 'single',
    triggerMatched: state === 'running',
    liveTriggerRetune: false,
    recording: group === 'recordPause' ? 'recording' : 'off',
    ...overrides,
  });
}

for (const group of Object.keys(EDIT_GROUPS) as EditGroup[]) {
  for (const feature of EDIT_GROUPS[group]) {
    for (const state of ACQUISITION_STATES) {
      const wanted = EXPECTED[group][state];
      const decision = mayEdit(feature, editContext(group, state));
      const detail = 'reason' in decision && decision.reason
        ? `got ${decision.kind}: ${decision.reason}`
        : `got ${decision.kind}`;
      check(
        `mayEdit(${feature}) while ${state} is ${wanted}`,
        decision.kind === wanted,
        detail,
      );
      if (decision.kind !== 'allow') {
        check(
          `mayEdit(${feature}) while ${state} explains '${decision.kind}'`,
          'reason' in decision && typeof decision.reason === 'string' &&
            decision.reason.length > 0,
          detail,
        );
      }
    }
  }
}

// Suspended and lost links freeze every non-view edit, even when the acquisition is idle.
for (const group of Object.keys(EDIT_GROUPS) as EditGroup[]) {
  for (const feature of EDIT_GROUPS[group]) {
    for (const linkState of ['suspended', 'lost'] as const) {
      const wanted: EditKind = group === 'view' ? 'allow' : 'refuse';
      const decision = mayEdit(
        feature,
        editContext(group, 'idle', { connection: linkState }),
      );
      check(
        `mayEdit(${feature}) with a ${linkState} link is ${wanted}`,
        decision.kind === wanted,
        `got ${decision.kind}`,
      );
    }
  }
}

// Trigger retune vs pending: the rule the UI depends on.
{
  const waiting = mayEdit(
    'digitalConditions',
    editContext('trigger', 'waiting'),
  );
  check('a trigger edit retunes while waiting', waiting.kind === 'allow');

  const matched = mayEdit(
    'digitalConditions',
    editContext('trigger', 'running', { triggerMatched: true }),
  );
  check(
    'a trigger edit after a match is pending for the next acquisition',
    matched.kind === 'next' && 'reason' in matched &&
      (matched.reason ?? '').includes('pending'),
    `got ${matched.kind}`,
  );

  const liveLoop = mayEdit(
    'digitalConditions',
    editContext('trigger', 'running', {
      mode: 'loop',
      triggerMatched: true,
      liveTriggerRetune: true,
    }),
  );
  check(
    'a Loop live detector may retune after a match',
    liveLoop.kind === 'allow',
    `got ${liveLoop.kind}`,
  );

  const liveSingle = mayEdit(
    'digitalConditions',
    editContext('trigger', 'running', {
      mode: 'single',
      triggerMatched: true,
      liveTriggerRetune: true,
    }),
  );
  check(
    'live retune is Loop-only; Single stays pending',
    liveSingle.kind === 'next',
    `got ${liveSingle.kind}`,
  );

  const stopped = mayEdit(
    'digitalConditions',
    editContext('trigger', 'stopping'),
  );
  check(
    'no trigger edit is accepted while stopping',
    stopped.kind === 'refuse' && stopped.reason.includes('stopping'),
    `got ${stopped.kind}`,
  );
}

// Device changes expose the named restart while the plan runs.
for (const feature of EDIT_GROUPS.device) {
  for (const state of ['waiting', 'running'] as const) {
    const decision = mayEdit(feature, editContext('device', state));
    check(
      `mayEdit(${feature}) while ${state} requires a visible restart`,
      decision.kind === 'restart' && typeof decision.reason === 'string' &&
        decision.reason.length > 0,
      `got ${decision.kind}`,
    );
  }
}

// Host-side budget/scheduling edits stage for the next acquisition.
for (const feature of EDIT_GROUPS.host) {
  for (const state of ['arming', 'waiting', 'running', 'retrying', 'restarting'] as const) {
    const decision = mayEdit(feature, editContext('host', state));
    check(
      `mayEdit(${feature}) while ${state} is pending for the next acquisition`,
      decision.kind === 'next',
      `got ${decision.kind}`,
    );
  }
}

// Record toggles are governed by the recording state, not only the acquisition state.
{
  const recordStates: readonly RecordingState[] = [
    'off',
    'armed',
    'recording',
    'paused',
    'exporting',
    'error',
    'full',
  ];
  const startExpected: Readonly<Record<RecordingState, EditKind>> = {
    off: 'allow',
    armed: 'allow',
    recording: 'refuse',
    paused: 'refuse',
    exporting: 'refuse',
    error: 'refuse',
    full: 'refuse',
  };
  const pauseExpected: Readonly<Record<RecordingState, EditKind>> = {
    off: 'refuse',
    armed: 'refuse',
    recording: 'allow',
    paused: 'allow',
    exporting: 'refuse',
    error: 'refuse',
    full: 'refuse',
  };
  for (const recording of recordStates) {
    const start = mayEdit(
      'recordStart',
      editContext('recordStart', 'idle', { recording }),
    );
    check(
      `mayEdit(recordStart) with record ${recording} is ${startExpected[recording]}`,
      start.kind === startExpected[recording],
      `got ${start.kind}`,
    );
    const pause = mayEdit(
      'recordPause',
      editContext('recordPause', 'idle', { recording }),
    );
    check(
      `mayEdit(recordPause) with record ${recording} is ${pauseExpected[recording]}`,
      pause.kind === pauseExpected[recording],
      `got ${pause.kind}`,
    );
  }
}

check(
  'an unknown edit feature is a typed refusal',
  mayEdit('bogus' as EditFeature, context()).kind === 'refuse',
);

console.log(
  `\n${failures === 0
    ? 'all acquisition state-machine checks passed'
    : `${failures} acquisition check(s) FAILED`}`,
);
if (failures > 0) failExit();
