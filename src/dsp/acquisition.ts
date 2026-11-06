// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * M0 composite acquisition state machine and edit-capability table
 * (docs/ARCHITECTURE.md §5.2–§5.3).
 *
 * The runtime tracks four independent zones and renders their tuple. One command is one
 * pure `transition(context, event)`: it returns the next tuple plus a declared, stable
 * side-effect list, or a typed refusal. Invalid events are values, never exceptions.
 *
 * ## What the contract leaves open (and the choices here)
 *
 * The key-transition table in §5.2 is partial. These transitions are inferred and are
 * deliberately explicit so the runtime and the UI can agree on them:
 *
 *   - `completed` is the generic "the pending asynchronous step finished" event. It
 *     advances the connection chain selecting → opening → claiming → handshaking →
 *     ready, moves `arming` to `waiting`/`running` (per `planWaits`), drains `stopping`
 *     to `idle`, re-arms `restarting` to `arming`, and finalises a record `exporting` to
 *     `off`. A sweep boundary that ends the acquisition (`waiting`/`running` +
 *     `completed`) enters `retrying` in Repeat and ends at `idle` in Single/Loop.
 *   - `retrying` has no listed entry/exit rule. In Repeat, a sweep that ends before a
 *     trigger match enters `retrying`; the next `completed` (the interval elapsed)
 *     starts the next attempt by returning to `arming`.
 *   - `suspend` freezes the active acquisition and a running record. `resume` starts the
 *     link re-handshake and restores the acquisition phase saved by `suspend`; the
 *     runtime must emit `lost` if the re-handshake cannot reattach the stream. A record
 *     `paused` by a user or by `suspend` resumes to `recording` (§5.2's table).
 *     `stopping` is suspendable as well: its phase is restored so the pending drain can
 *     still complete, rather than stranding the acquisition in `suspended`.
 *   - A `suspended` link is not live, but a transport loss still applies to it: `lost`
 *     moves `suspended` to `lost` (only `unsupported`/`idle`/`lost`/`closed` are
 *     unaffected). A suspended acquisition is lost with it.
 *   - A running record pauses when the acquisition is stopped (DESIGN §4: "stopping the
 *     acquisition pauses the record and offers Finish record"); exporting is explicit,
 *     never an implicit consequence of `stop`.
 *   - `record-error` and `record-full` are host/storage failure notifications. From
 *     `recording` or `paused` they move the record to `error`/`full` and flush it; only
 *     the explicit `export` command (Finish record) leaves those states.
 *   - Only a Loop trigger match changes the view to `triggerLocked`. Single/Repeat still
 *     move their axis origin to T, but never lock the viewport. `fixed` wins over a
 *     later Loop match, and `release` restores the policy that was current when the lock
 *     was taken.
 *   - `disconnect` is a user teardown: an active capture stops, a running record becomes
 *     `paused` (recoverable), an armed record is disarmed, and acquisition returns to
 *     `idle`. It is not the same as `stop`/`restart`. A `restart` keeps the session and
 *     its displayed capture; it only clears the live trigger match and re-arms.
 *   - `start` is overloaded through the command payload: with `record: 'arm'` it only
 *     arms the record, with `record: 'record'` it starts recording independently of the
 *     acquisition, and without a `record` field it starts the acquisition itself.
 *
 * An event is applied to every zone that accepts it (the zones are independent). It is
 * refused only when no zone changes and no zone already held the requested terminal
 * state (repeated `suspend`/`lost` notifications are idempotent).
 *
 * ## Refusal codes
 *
 * A refusal carries the diagnostic prose in `refused` and a stable `code` beside it, so
 * callers and i18n never parse English. The code names the blocking condition: the event
 * itself (`invalid-event`), the connection/acquisition/record/trigger state, a frozen
 * `lost`/`suspended`/`stopping` session, an already-satisfied request (`no-op`), or a
 * defensive `unknown-state` fallback for a value outside the model.
 *
 * ## Edit policy
 *
 * `mayEdit` is the only capability decision. It follows §5.3's `live`/`next`/`view`/
 * `preference` classification:
 *
 *   - view and preference features (`cursor`, `bus`, `theme`) stay editable in every
 *     state because they never touch the device or the capture session;
 *   - `stopping`, `suspended` and `lost` freeze every acquisition, trigger and record
 *     edit (a drain or a dead link cannot accept one);
 *   - a trigger edit retunes only while the sweep is `waiting` (or a Loop live detector
 *     is re-locking); after a match, or while free-running, it is pending (`next`);
 *   - device geometry (`mode`, `width`, `rate`, `threshold`, `testMode`) needs a named
 *     `restart` while `waiting`/`running`, never a silent reconfiguration;
 *   - host-side capture budget/scheduling (`duration`, `repeatInterval`, `loopWindow`)
 *     stages for the next acquisition (`next`).
 *
 * A known trigger limitation is encoded, not hidden: a digital Loop lock is one-shot,
 * so `trigger` is refused while `running` unless `liveTriggerRetune` says the profile
 * runs a live (analog) detector. There is no second scanner and no re-lock of a
 * released digital trigger.
 *
 * The module is pure: no DOM, store, UI or device imports.
 */

export const CONNECTION_STATES = [
  'unsupported',
  'idle',
  'selecting',
  'opening',
  'claiming',
  'handshaking',
  'ready',
  'busy',
  'suspended',
  'lost',
  'closed',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const ACQUISITION_STATES = [
  'idle',
  'arming',
  'waiting',
  'running',
  'stopping',
  'restarting',
  'retrying',
  'suspended',
  'lost',
] as const;
export type AcquisitionState = (typeof ACQUISITION_STATES)[number];

export const RECORDING_STATES = [
  'off',
  'armed',
  'recording',
  'paused',
  'exporting',
  'error',
  'full',
] as const;
export type RecordingState = (typeof RECORDING_STATES)[number];

export const VIEW_STATES = ['follow', 'fixed', 'triggerLocked'] as const;
export type ViewState = (typeof VIEW_STATES)[number];

export type AcquisitionMode = 'single' | 'repeat' | 'loop';

/** A view policy that can be restored after a Loop trigger lock releases. */
export type UnlockedViewState = Exclude<ViewState, 'triggerLocked'>;

/**
 * An acquisition phase that can be frozen and later resumed. `stopping` is included so a
 * drain interrupted by a page/device suspend is restored and can finish.
 */
export type SuspendableAcquisitionState = Exclude<AcquisitionState, 'suspended' | 'lost'>;

/** The four zones the UI renders. */
export interface AcquisitionTuple {
  readonly connection: ConnectionState;
  readonly acquisition: AcquisitionState;
  readonly recording: RecordingState;
  readonly view: ViewState;
}

/**
 * The tuple plus the facts the transition function cannot derive from the four states.
 * Callers update `planWaits`/`liveTriggerRetune` when they compile a plan; the machine
 * owns the rest.
 */
export interface AcquisitionContext extends AcquisitionTuple {
  readonly mode: AcquisitionMode;
  /**
   * The armed plan waits for a trigger before streaming. On device-ready, `arming`
   * becomes `waiting` when true and `running` (free run) when false.
   */
  readonly planWaits: boolean;
  /**
   * The active profile/plan can retune its trigger after a match without a restart
   * (an analog Loop live detector). Digital one-shot locks are always pending.
   */
  readonly liveTriggerRetune: boolean;
  /** The current acquisition has already matched its trigger. */
  readonly triggerMatched: boolean;
  /** Policy restored by `release`; never `triggerLocked`. */
  readonly viewBeforeLock: UnlockedViewState;
  /** Acquisition phase frozen by `suspend`; restored by `resume`. */
  readonly acquisitionBeforeSuspend: SuspendableAcquisitionState | null;
}

export const ACQUISITION_EVENT_TYPES = [
  'connect',
  'disconnect',
  'start',
  'stop',
  'retune',
  'restart',
  'completed',
  'pause',
  'resume',
  'export',
  'record-error',
  'record-full',
  'lost',
  'suspend',
  'fit',
  'gesture',
  'trigger',
  'release',
] as const;
export type AcquisitionEventType = (typeof ACQUISITION_EVENT_TYPES)[number];

/**
 * A typed command. Plain event names are accepted as well; the object form is required
 * only to disambiguate the overloaded `start` command.
 */
export interface AcquisitionCommand {
  readonly type: AcquisitionEventType;
  /**
   * `start` only:
   *   - `'arm'` arms the record for the next acquisition;
   *   - `'record'` starts recording independently of the acquisition;
   *   - omitted starts the acquisition.
   */
  readonly record?: 'arm' | 'record';
}

export type AcquisitionEvent = AcquisitionEventType | AcquisitionCommand;

/** Stable side-effect identifiers; the runtime maps each one to one concrete action. */
export const ACQUISITION_EFFECTS = [
  'request-device',
  'open-device',
  'claim-interface',
  'handshake-device',
  'connection-ready',
  'close-device',
  'start-device',
  'stop-device',
  'restart-device',
  'capture-ready',
  'recompile-trigger',
  'mark-trigger',
  'drain-capture',
  'schedule-retry',
  'arm-record',
  'disarm-record',
  'start-record',
  'pause-record',
  'resume-record',
  'stop-record',
  'flush-record',
  'finalize-record',
  'suspend-device',
  'resume-device',
  'mark-lost',
  'relayout',
] as const;
export type Effect = (typeof ACQUISITION_EFFECTS)[number];

export interface TransitionSuccess {
  readonly context: AcquisitionContext;
  readonly effects: readonly Effect[];
}

/** Stable refusal identifiers; the prose in `refused` stays diagnostic, never a key. */
export const TRANSITION_REFUSAL_CODES = [
  'invalid-event',
  'link-state',
  'acquisition-state',
  'record-state',
  'trigger-state',
  'no-op',
  'lost',
  'suspended',
  'stopping',
  'unknown-state',
] as const;
export type TransitionRefusalCode = (typeof TRANSITION_REFUSAL_CODES)[number];

export interface TransitionRefusal {
  /** Stable code for callers and i18n; `refused` is diagnostic prose, not a key. */
  readonly code: TransitionRefusalCode;
  readonly refused: string;
}

export type TransitionResult = TransitionSuccess | TransitionRefusal;

export const EDIT_FEATURES = [
  'mode',
  'width',
  'rate',
  'threshold',
  'duration',
  'repeatInterval',
  'loopWindow',
  'triggerMask',
  'triggerSource',
  'digitalConditions',
  'analogCondition',
  'preTrigger',
  'recordStart',
  'recordPause',
  'cursor',
  'bus',
  'theme',
  'testMode',
] as const;
export type EditFeature = (typeof EDIT_FEATURES)[number];

export interface EditAllow {
  readonly kind: 'allow' | 'next' | 'restart';
  readonly reason?: string;
}

export type EditRefusalCode =
  | 'acquisition-frozen'
  | 'trigger-frozen'
  | 'device-frozen'
  | 'capture-frozen'
  | 'link-not-ready'
  | 'record-active'
  | 'record-state'
  | 'unknown-feature';

export interface EditRefuse {
  readonly kind: 'refuse';
  /** Stable code for callers and i18n; `reason` is diagnostic prose, not a key. */
  readonly code: EditRefusalCode;
  readonly reason: string;
}

export type EditDecision = EditAllow | EditRefuse;

/** State the machine starts from before any device work. */
export function createAcquisitionContext(
  overrides: Partial<AcquisitionContext> = {},
): AcquisitionContext {
  return {
    connection: 'idle',
    acquisition: 'idle',
    recording: 'off',
    view: 'follow',
    mode: 'single',
    planWaits: false,
    liveTriggerRetune: false,
    triggerMatched: false,
    viewBeforeLock: 'follow',
    acquisitionBeforeSuspend: null,
    ...overrides,
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const VIEW_EDIT_FEATURES: ReadonlySet<EditFeature> = new Set<EditFeature>(
  ['cursor', 'bus', 'theme'],
);
const TRIGGER_EDIT_FEATURES: ReadonlySet<EditFeature> = new Set<EditFeature>([
  'triggerMask',
  'triggerSource',
  'digitalConditions',
  'analogCondition',
  'preTrigger',
]);
const DEVICE_EDIT_FEATURES: ReadonlySet<EditFeature> = new Set<EditFeature>([
  'mode',
  'width',
  'rate',
  'threshold',
  'testMode',
]);
const HOST_EDIT_FEATURES: ReadonlySet<EditFeature> = new Set<EditFeature>([
  'duration',
  'repeatInterval',
  'loopWindow',
]);

function refuseEdit(code: EditRefusalCode, reason: string): EditRefuse {
  return { kind: 'refuse', code, reason };
}

function nextEdit(reason: string): EditAllow {
  return { kind: 'next', reason };
}

function restartEdit(reason: string): EditAllow {
  return { kind: 'restart', reason };
}

function allowEdit(): EditAllow {
  return { kind: 'allow' };
}

interface FrozenRefusal {
  readonly code: TransitionRefusalCode;
  readonly reason: string;
}

function frozenRefusal(context: AcquisitionContext): FrozenRefusal | null {
  if (context.connection === 'suspended') {
    return {
      code: 'suspended',
      reason: 'the link is suspended; resume it before editing acquisition settings',
    };
  }
  if (context.connection === 'lost') {
    return {
      code: 'lost',
      reason: 'the link is lost; reconnect before editing acquisition settings',
    };
  }
  if (context.acquisition === 'suspended') {
    return {
      code: 'suspended',
      reason: 'the acquisition is suspended; resume it before editing acquisition settings',
    };
  }
  if (context.acquisition === 'lost') {
    return {
      code: 'lost',
      reason: 'the acquisition is lost; reconnect before editing acquisition settings',
    };
  }
  if (context.acquisition === 'stopping') {
    return {
      code: 'stopping',
      reason: 'the acquisition is stopping; settings are frozen until it drains',
    };
  }
  return null;
}

/**
 * The single edit decision for a settings feature. See the module header for the policy
 * table; this function is the only place that decides `allow`, `next`, `restart` or a
 * typed refusal.
 */
export function mayEdit(feature: EditFeature, context: AcquisitionContext): EditDecision {
  // View and preference settings never touch the device or the capture session.
  if (VIEW_EDIT_FEATURES.has(feature)) return allowEdit();

  const frozen = frozenRefusal(context);
  if (frozen !== null) return refuseEdit('acquisition-frozen', frozen.reason);

  if (TRIGGER_EDIT_FEATURES.has(feature)) {
    switch (context.acquisition) {
      case 'idle':
        return allowEdit();
      case 'waiting':
        // §5.1: while waiting a new plan is recompiled and sent; edge continuity restarts.
        return allowEdit();
      case 'running':
        if (context.mode === 'loop' && context.liveTriggerRetune && context.triggerMatched) {
          return allowEdit();
        }
        return nextEdit(
          context.triggerMatched
            ? 'the trigger already matched; the edit is pending for the next acquisition'
            : 'the acquisition is running; the edit is pending for the next acquisition',
        );
      case 'arming':
        return nextEdit('the trigger plan is still arming; the edit is pending for the next acquisition');
      case 'retrying':
        return nextEdit('the acquisition is between sweeps; the edit is pending for the next sweep');
      case 'restarting':
        return nextEdit('the edit is pending after the restart in progress');
      default:
        // stopping/suspended/lost are handled by frozenRefusal above.
        return refuseEdit('trigger-frozen', `the acquisition is ${context.acquisition}; trigger edits are frozen`);
    }
  }

  if (DEVICE_EDIT_FEATURES.has(feature)) {
    switch (context.acquisition) {
      case 'idle':
        return allowEdit();
      case 'arming':
        return nextEdit('the device is arming; the edit applies to the next acquisition');
      case 'waiting':
      case 'running':
        return restartEdit('the device configuration requires a named restart to apply');
      case 'retrying':
        return nextEdit('the acquisition is between sweeps; the edit applies to the next sweep');
      case 'restarting':
        return nextEdit('the edit is pending after the restart in progress');
      default:
        return refuseEdit('device-frozen', `the acquisition is ${context.acquisition}; device edits are frozen`);
    }
  }

  if (HOST_EDIT_FEATURES.has(feature)) {
    switch (context.acquisition) {
      case 'idle':
        return allowEdit();
      case 'arming':
      case 'waiting':
      case 'running':
      case 'retrying':
      case 'restarting':
        return nextEdit('the change applies to the next acquisition');
      default:
        return refuseEdit('capture-frozen', `the acquisition is ${context.acquisition}; capture edits are frozen`);
    }
  }

  if (feature === 'recordStart') {
    // A record needs a live, ready link; idle/closed/suspended/lost/busy cannot record.
    if (context.connection !== 'ready') {
      return refuseEdit(
        'link-not-ready',
        `the link is ${context.connection}; a record can start only while the link is ready`,
      );
    }
    switch (context.recording) {
      case 'off':
      case 'armed':
        return allowEdit();
      case 'recording':
        return refuseEdit('record-active', 'a record is already running');
      case 'paused':
        return refuseEdit('record-state', 'the record is paused; resume or export it instead');
      case 'exporting':
        return refuseEdit('record-state', 'the record is exporting');
      case 'error':
        return refuseEdit('record-state', 'the record failed; export or recover it');
      case 'full':
        return refuseEdit('record-state', 'the record is full; export it');
    }
  }

  if (feature === 'recordPause') {
    switch (context.recording) {
      case 'recording':
      case 'paused':
        return allowEdit();
      default:
        return refuseEdit('record-state', `there is no record to pause or resume (record is ${context.recording})`);
    }
  }

  return refuseEdit('unknown-feature', `unknown edit feature: ${String(feature)}`);
}

function refusal(code: TransitionRefusalCode, reason: string): TransitionRefusal {
  return { code, refused: reason };
}

/**
 * The code for a connection-state refusal. `lost` and `suspended` keep their own codes;
 * every other link state is an ordinary `link-state` mismatch.
 */
function connectionRefusalCode(state: ConnectionState): TransitionRefusalCode {
  switch (state) {
    case 'suspended':
      return 'suspended';
    case 'lost':
      return 'lost';
    default:
      return 'link-state';
  }
}

/**
 * The code for an acquisition-phase refusal. `lost`/`suspended`/`stopping` keep their own
 * codes so callers can tell a frozen session from an ordinary phase mismatch.
 */
function acquisitionRefusalCode(state: AcquisitionState): TransitionRefusalCode {
  switch (state) {
    case 'suspended':
      return 'suspended';
    case 'lost':
      return 'lost';
    case 'stopping':
      return 'stopping';
    case 'idle':
    case 'arming':
    case 'waiting':
    case 'running':
    case 'restarting':
    case 'retrying':
      return 'acquisition-state';
    default:
      // Defensive: a value outside the model still yields a stable code.
      return 'unknown-state';
  }
}

function success(context: AcquisitionContext, effects: readonly Effect[]): TransitionSuccess {
  return { context, effects };
}

function eventTypeOf(event: AcquisitionEvent): string | null {
  const raw: unknown = event;
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object' && 'type' in raw) {
    const type = (raw as { type?: unknown }).type;
    if (typeof type === 'string') return type;
  }
  return null;
}

type StartTarget = 'acquisition' | 'record-arm' | 'record-start' | 'invalid';

function startTargetOf(event: AcquisitionEvent): StartTarget {
  const raw: unknown = event;
  if (raw === null || typeof raw !== 'object' || !('record' in raw)) return 'acquisition';
  const record = (raw as { record?: unknown }).record;
  if (record === undefined) return 'acquisition';
  if (record === 'arm') return 'record-arm';
  if (record === 'record') return 'record-start';
  return 'invalid';
}

function isLiveConnection(state: ConnectionState): boolean {
  switch (state) {
    case 'selecting':
    case 'opening':
    case 'claiming':
    case 'handshaking':
    case 'ready':
    case 'busy':
      return true;
    case 'unsupported':
    case 'idle':
    case 'suspended':
    case 'lost':
    case 'closed':
      return false;
  }
}

function isSuspendableAcquisition(state: AcquisitionState): state is SuspendableAcquisitionState {
  switch (state) {
    case 'arming':
    case 'waiting':
    case 'running':
    case 'stopping':
    case 'restarting':
    case 'retrying':
      return true;
    case 'idle':
    case 'suspended':
    case 'lost':
      return false;
  }
}

/**
 * A transport loss can end a live link or a suspended one (the stream died while the page
 * was hidden). `unsupported`/`idle`/`lost`/`closed` have no stream to lose.
 */
function canBeLostConnection(state: ConnectionState): boolean {
  switch (state) {
    case 'selecting':
    case 'opening':
    case 'claiming':
    case 'handshaking':
    case 'ready':
    case 'busy':
    case 'suspended':
      return true;
    case 'unsupported':
    case 'idle':
    case 'lost':
    case 'closed':
      return false;
  }
}

function isLiveAcquisition(state: AcquisitionState): boolean {
  switch (state) {
    case 'arming':
    case 'waiting':
    case 'running':
    case 'stopping':
    case 'restarting':
    case 'retrying':
    case 'suspended':
      return true;
    case 'idle':
    case 'lost':
      return false;
  }
}

function connect(context: AcquisitionContext): TransitionResult {
  switch (context.connection) {
    case 'idle':
    case 'lost':
    case 'closed':
      return success(
        {
          ...context,
          connection: 'selecting',
          acquisition: 'idle',
          triggerMatched: false,
          acquisitionBeforeSuspend: null,
        },
        ['request-device'],
      );
    case 'selecting':
    case 'opening':
    case 'claiming':
    case 'handshaking':
      return refusal(
        'link-state',
        `a connection attempt is already in progress (${context.connection})`,
      );
    case 'ready':
      return refusal('no-op', 'the device is already connected');
    case 'busy':
      return refusal('link-state', 'the device is busy with another owner');
    case 'suspended':
      return refusal('suspended', 'the link is suspended; resume it before connecting again');
    case 'unsupported':
      return refusal('link-state', 'WebUSB is unavailable in this browser or context');
  }
}

function disconnect(context: AcquisitionContext): TransitionResult {
  switch (context.connection) {
    case 'unsupported':
      return refusal('link-state', 'WebUSB is unavailable; there is no device to disconnect');
    case 'idle':
      return refusal('no-op', 'no device is connected');
    case 'closed':
      return refusal('no-op', 'the device is already disconnected');
    case 'selecting':
    case 'opening':
    case 'claiming':
    case 'handshaking':
    case 'ready':
    case 'busy':
    case 'suspended':
    case 'lost':
      break;
  }

  const effects: Effect[] = [];
  if (isLiveAcquisition(context.acquisition)) effects.push('stop-device');
  let recording = context.recording;
  if (recording === 'recording') {
    recording = 'paused';
    effects.push('pause-record');
  } else if (recording === 'armed') {
    recording = 'off';
    effects.push('disarm-record');
  }
  effects.push('close-device');

  return success(
    {
      ...context,
      connection: 'closed',
      acquisition: 'idle',
      recording,
      triggerMatched: false,
      acquisitionBeforeSuspend: null,
    },
    effects,
  );
}

function armRecord(context: AcquisitionContext): TransitionResult {
  const frozen = frozenRefusal(context);
  if (frozen !== null) return refusal(frozen.code, `${frozen.reason}; the record cannot be armed`);
  if (context.connection !== 'ready') {
    return refusal(
      'link-state',
      `the link is ${context.connection}; a record can be armed only while the link is ready`,
    );
  }
  if (context.recording !== 'off') {
    return refusal('record-state', `cannot arm the record while it is ${context.recording}`);
  }
  return success({ ...context, recording: 'armed' }, ['arm-record']);
}

function startRecordNow(context: AcquisitionContext): TransitionResult {
  const frozen = frozenRefusal(context);
  if (frozen !== null) return refusal(frozen.code, `${frozen.reason}; the record cannot start`);
  if (context.connection !== 'ready') {
    return refusal(
      'link-state',
      `the link is ${context.connection}; a record can start only while the link is ready`,
    );
  }
  if (context.recording !== 'off' && context.recording !== 'armed') {
    return refusal('record-state', `cannot start a record while it is ${context.recording}`);
  }
  return success({ ...context, recording: 'recording' }, ['start-record']);
}

function startAcquisition(context: AcquisitionContext): TransitionResult {
  if (context.connection !== 'ready') {
    return refusal(
      connectionRefusalCode(context.connection),
      `the link is ${context.connection}; a capture can start only when it is ready`,
    );
  }
  if (context.acquisition !== 'idle') {
    return refusal(
      acquisitionRefusalCode(context.acquisition),
      `the acquisition is ${context.acquisition}; stop it before starting another`,
    );
  }

  const effects: Effect[] = ['start-device'];
  let recording = context.recording;
  if (recording === 'armed') {
    recording = 'recording';
    effects.push('start-record');
  }
  // A new session always starts FollowLive (§5.4).
  if (context.view !== 'follow') effects.push('relayout');

  return success(
    {
      ...context,
      acquisition: 'arming',
      recording,
      view: 'follow',
      viewBeforeLock: 'follow',
      triggerMatched: false,
      acquisitionBeforeSuspend: null,
    },
    effects,
  );
}

function stopAcquisition(context: AcquisitionContext): TransitionResult {
  switch (context.acquisition) {
    case 'idle':
      return refusal('acquisition-state', 'there is no acquisition to stop');
    case 'stopping':
      return refusal('stopping', 'the acquisition is already stopping');
    case 'suspended':
      return refusal('suspended', 'the acquisition is suspended; resume it before stopping');
    case 'lost':
      return refusal('lost', 'the acquisition is lost; reconnect and start a new capture');
    case 'arming':
    case 'waiting':
    case 'running':
    case 'restarting':
    case 'retrying':
      break;
  }

  const effects: Effect[] = ['stop-device'];
  let recording = context.recording;
  if (recording === 'recording') {
    // DESIGN §4: stopping the acquisition pauses the record and offers "Finish record".
    // Export is an explicit command, never an implicit consequence of stop.
    recording = 'paused';
    effects.push('pause-record');
  }

  return success(
    {
      ...context,
      acquisition: 'stopping',
      recording,
      triggerMatched: false,
      acquisitionBeforeSuspend: null,
    },
    effects,
  );
}

function retuneTrigger(context: AcquisitionContext): TransitionResult {
  switch (context.acquisition) {
    case 'waiting':
      return success({ ...context, triggerMatched: false }, ['recompile-trigger']);
    case 'running':
      if (context.mode === 'loop' && context.liveTriggerRetune && context.triggerMatched) {
        return success(context, ['recompile-trigger']);
      }
      return refusal(
        'trigger-state',
        'trigger edits are pending for the next acquisition; restart to apply them now',
      );
    case 'idle':
      return refusal(
        'trigger-state',
        'no trigger plan is armed; configure the trigger before starting',
      );
    case 'arming':
      return refusal(
        'trigger-state',
        'the trigger plan is still arming; the edit is pending for the next acquisition',
      );
    case 'retrying':
      return refusal(
        'trigger-state',
        'the acquisition is between sweeps; the edit is pending for the next sweep',
      );
    case 'restarting':
      return refusal('trigger-state', 'the acquisition is restarting; the edit is pending');
    case 'stopping':
      return refusal('stopping', 'the acquisition is stopping; the trigger cannot be retuned');
    case 'suspended':
      return refusal(
        'suspended',
        'the acquisition is suspended; resume it before retuning the trigger',
      );
    case 'lost':
      return refusal('lost', 'the acquisition is lost; reconnect before retuning the trigger');
  }
}

function restartAcquisition(context: AcquisitionContext): TransitionResult {
  switch (context.acquisition) {
    case 'waiting':
    case 'running':
      break;
    case 'idle':
      return refusal('acquisition-state', 'there is no acquisition to restart');
    case 'arming':
      return refusal(
        'acquisition-state',
        'the acquisition is still arming; stop it instead of restarting',
      );
    case 'stopping':
      return refusal('stopping', 'the acquisition is stopping; wait for it to drain');
    case 'restarting':
      return refusal('no-op', 'the acquisition is already restarting');
    case 'retrying':
      return refusal(
        'acquisition-state',
        'the acquisition is between sweeps; wait for the next attempt or stop it',
      );
    case 'suspended':
      return refusal('suspended', 'the acquisition is suspended; resume it before restarting');
    case 'lost':
      return refusal('lost', 'the acquisition is lost; reconnect and start a new capture');
  }

  // A restart keeps the session, the recording and the displayed capture. It only clears
  // the live trigger match while the device re-arms.
  return success(
    {
      ...context,
      acquisition: 'restarting',
      triggerMatched: false,
      acquisitionBeforeSuspend: null,
    },
    ['restart-device'],
  );
}

function pauseRecord(context: AcquisitionContext): TransitionResult {
  const frozen = frozenRefusal(context);
  if (frozen !== null) return refusal(frozen.code, `${frozen.reason}; record controls are frozen`);
  if (context.recording !== 'recording') {
    return refusal(
      'record-state',
      `there is no recording to pause (record is ${context.recording})`,
    );
  }
  return success({ ...context, recording: 'paused' }, ['pause-record']);
}

function resume(context: AcquisitionContext): TransitionResult {
  if (context.connection === 'lost' || context.acquisition === 'lost') {
    return refusal('lost', 'the link or acquisition is lost; reconnect instead of resuming');
  }
  if (context.acquisition === 'stopping') {
    return refusal('stopping', 'the acquisition is stopping; wait for it to drain');
  }

  const effects: Effect[] = [];
  let connection = context.connection;
  // Explicitly widen: the early `stopping` refusal narrows the initializer, but restore
  // may legitimately bring back any suspendable phase (including `stopping`).
  let acquisition: AcquisitionState = context.acquisition;
  let acquisitionBeforeSuspend = context.acquisitionBeforeSuspend;
  let recording = context.recording;
  let changed = false;

  if (connection === 'suspended') {
    connection = 'handshaking';
    effects.push('resume-device', 'handshake-device');
    changed = true;
  }
  if (acquisition === 'suspended') {
    acquisition = acquisitionBeforeSuspend ?? 'idle';
    acquisitionBeforeSuspend = null;
    if (!effects.includes('resume-device')) effects.push('resume-device');
    changed = true;
  }
  if (recording === 'paused') {
    recording = 'recording';
    effects.push('resume-record');
    changed = true;
  }

  if (!changed) return refusal('no-op', 'nothing is suspended or paused');
  return success(
    { ...context, connection, acquisition, recording, acquisitionBeforeSuspend },
    effects,
  );
}

/**
 * A host/storage failure notification. Only an active or paused record can fail; a
 * terminal failure state ignores a repeat of its own event and refuses a different one.
 */
function recordFailure(
  context: AcquisitionContext,
  target: 'error' | 'full',
): TransitionResult {
  switch (context.recording) {
    case 'recording':
    case 'paused':
      break;
    case 'error':
    case 'full':
      if (context.recording === target) return success(context, []);
      return refusal('record-state', `the record is already ${context.recording}`);
    case 'off':
    case 'armed':
      return refusal(
        'record-state',
        `there is no active record to fail (record is ${context.recording})`,
      );
    case 'exporting':
      return refusal('record-state', 'the record is exporting; its failure cannot be recorded');
  }

  const effects: Effect[] = [];
  // A running record must be stopped; a paused one is already stopped. Either way the
  // buffered data is flushed so the record stays recoverable/exportable.
  if (context.recording === 'recording' && target === 'error') effects.push('stop-record');
  effects.push('flush-record');
  return success({ ...context, recording: target }, effects);
}

function exportRecord(context: AcquisitionContext): TransitionResult {
  const effects: Effect[] = [];
  switch (context.recording) {
    case 'recording':
      effects.push('stop-record', 'flush-record');
      break;
    case 'paused':
    case 'error':
    case 'full':
      // A paused/failed/full record keeps its data; exporting is the recovery path.
      effects.push('flush-record');
      break;
    case 'off':
      return refusal('record-state', 'there is no record to export');
    case 'armed':
      return refusal(
        'record-state',
        'the record has not started, so there is nothing to export',
      );
    case 'exporting':
      return refusal('no-op', 'the record is already exporting');
  }
  return success({ ...context, recording: 'exporting' }, effects);
}

function lose(context: AcquisitionContext): TransitionResult {
  const next: Mutable<AcquisitionContext> = { ...context };
  const effects: Effect[] = [];
  let changed = false;
  let linkLost = false;

  if (canBeLostConnection(context.connection)) {
    next.connection = 'lost';
    linkLost = true;
    changed = true;
  }
  if (isLiveAcquisition(context.acquisition)) {
    next.acquisition = 'lost';
    next.triggerMatched = false;
    next.acquisitionBeforeSuspend = null;
    linkLost = true;
    changed = true;
  }
  if (context.recording === 'recording') {
    // DESIGN §9: an interrupted record is paused and recoverable, never silently lost.
    next.recording = 'paused';
    effects.push('pause-record');
    changed = true;
  }

  if (!changed) {
    if (context.connection === 'lost' || context.acquisition === 'lost') {
      return success(context, []);
    }
    return refusal('no-op', 'there is no live session to lose');
  }
  if (linkLost) effects.unshift('mark-lost');
  return success(next, effects);
}

function suspend(context: AcquisitionContext): TransitionResult {
  const next: Mutable<AcquisitionContext> = { ...context };
  const effects: Effect[] = [];
  let changed = false;
  let deviceSuspended = false;

  if (isLiveConnection(context.connection)) {
    next.connection = 'suspended';
    deviceSuspended = true;
    changed = true;
  }
  if (isSuspendableAcquisition(context.acquisition)) {
    next.acquisitionBeforeSuspend = context.acquisition;
    next.acquisition = 'suspended';
    deviceSuspended = true;
    changed = true;
  }
  if (context.recording === 'recording') {
    next.recording = 'paused';
    effects.push('pause-record');
    changed = true;
  }

  if (!changed) {
    if (context.connection === 'suspended' || context.acquisition === 'suspended') {
      return success(context, []);
    }
    return refusal('no-op', 'there is no live session to suspend');
  }
  if (deviceSuspended) effects.unshift('suspend-device');
  return success(next, effects);
}

function complete(context: AcquisitionContext): TransitionResult {
  const next: Mutable<AcquisitionContext> = { ...context };
  const effects: Effect[] = [];
  let changed = false;

  switch (context.connection) {
    case 'selecting':
      next.connection = 'opening';
      effects.push('open-device');
      changed = true;
      break;
    case 'opening':
      next.connection = 'claiming';
      effects.push('claim-interface');
      changed = true;
      break;
    case 'claiming':
      next.connection = 'handshaking';
      effects.push('handshake-device');
      changed = true;
      break;
    case 'handshaking':
      next.connection = 'ready';
      effects.push('connection-ready');
      changed = true;
      break;
    default:
      break;
  }

  let acquisitionEnded = false;
  switch (context.acquisition) {
    case 'arming':
      next.acquisition = context.planWaits ? 'waiting' : 'running';
      next.triggerMatched = false;
      effects.push('capture-ready');
      changed = true;
      break;
    case 'restarting':
      next.acquisition = 'arming';
      next.triggerMatched = false;
      effects.push('start-device');
      changed = true;
      break;
    case 'stopping':
      next.acquisition = 'idle';
      next.triggerMatched = false;
      acquisitionEnded = true;
      effects.push('drain-capture');
      changed = true;
      break;
    case 'waiting':
      // A sweep ending while still waiting is a miss: Repeat schedules the next attempt;
      // Single/Loop end the acquisition. A matched sweep has already moved to `running`.
      if (context.mode === 'repeat') {
        next.acquisition = 'retrying';
        next.triggerMatched = false;
        effects.push('schedule-retry');
      } else {
        next.acquisition = 'idle';
        next.triggerMatched = false;
        acquisitionEnded = true;
        effects.push('drain-capture');
      }
      changed = true;
      break;
    case 'running':
      if (context.mode === 'repeat') {
        // Every RUN->STOP boundary starts the next Repeat sweep (§5.4). Recording is
        // independent and keeps running across waves.
        next.acquisition = 'retrying';
        next.triggerMatched = false;
        effects.push('schedule-retry');
      } else {
        next.acquisition = 'idle';
        next.triggerMatched = false;
        acquisitionEnded = true;
        effects.push('drain-capture');
      }
      changed = true;
      break;
    case 'retrying':
      // The Repeat interval elapsed; re-arm the next attempt (free-run progress then
      // follows from the next `completed` as usual).
      next.acquisition = 'arming';
      next.triggerMatched = false;
      effects.push('start-device');
      changed = true;
      break;
    case 'idle':
    case 'suspended':
    case 'lost':
      break;
  }

  if (context.recording === 'exporting') {
    next.recording = 'off';
    effects.push('finalize-record');
    changed = true;
  } else if (acquisitionEnded && context.recording === 'recording') {
    // A finite capture ending is still an acquisition stop (DESIGN §4): pause the
    // independent record and let the user choose Finish record, rather than exporting
    // it silently.
    next.recording = 'paused';
    effects.push('pause-record');
    changed = true;
  }

  if (!changed) {
    return refusal(
      'no-op',
      'no pending connection, acquisition or record step to complete',
    );
  }
  if (acquisitionEnded) next.acquisitionBeforeSuspend = null;
  return success(next, effects);
}

function matchTrigger(context: AcquisitionContext): TransitionResult {
  switch (context.acquisition) {
    case 'waiting':
    case 'running':
      break;
    case 'idle':
      return refusal('acquisition-state', 'there is no acquisition waiting for a trigger');
    case 'arming':
      return refusal('acquisition-state', 'the acquisition is still arming');
    case 'stopping':
      return refusal('stopping', 'the acquisition is stopping');
    case 'restarting':
      return refusal('acquisition-state', 'the acquisition is restarting');
    case 'retrying':
      return refusal('acquisition-state', 'the acquisition is between sweeps');
    case 'suspended':
      return refusal('suspended', 'the acquisition is suspended');
    case 'lost':
      return refusal('lost', 'the acquisition is lost');
  }

  if (context.acquisition === 'running' &&
      !(context.mode === 'loop' && context.liveTriggerRetune)) {
    return context.triggerMatched
      ? refusal('trigger-state', 'the trigger already matched for this acquisition')
      : refusal('trigger-state', 'the acquisition is free-running; restart it to arm a trigger');
  }

  const acquisition: AcquisitionState =
    context.acquisition === 'waiting' ? 'running' : context.acquisition;
  let view = context.view;
  let viewBeforeLock = context.viewBeforeLock;
  // Only a Loop locks the viewport on T (§5.3/captureSession). A user Fixed policy wins
  // over a later match.
  if (context.mode === 'loop' && view === 'follow') {
    view = 'triggerLocked';
    viewBeforeLock = 'follow';
  }

  return success(
    { ...context, acquisition, view, viewBeforeLock, triggerMatched: true },
    ['mark-trigger', 'relayout'],
  );
}

function releaseTriggerLock(context: AcquisitionContext): TransitionResult {
  if (context.view !== 'triggerLocked') {
    return refusal('trigger-state', 'there is no trigger lock to release');
  }
  return success(
    { ...context, view: context.viewBeforeLock, viewBeforeLock: 'follow' },
    ['relayout'],
  );
}

/**
 * Apply one command to the composite state. Never throws: an unknown event, a malformed
 * command or a state that does not accept the event yields `{ refused }`.
 */
export function transition(
  context: AcquisitionContext,
  event: AcquisitionEvent,
): TransitionResult {
  const type = eventTypeOf(event);
  if (type === null) return refusal('invalid-event', 'invalid acquisition event');

  switch (type) {
    case 'connect':
      return connect(context);
    case 'disconnect':
      return disconnect(context);
    case 'start': {
      const target = startTargetOf(event);
      if (target === 'invalid') {
        return refusal('invalid-event', 'start.record must be "arm" or "record"');
      }
      if (target === 'record-arm') return armRecord(context);
      if (target === 'record-start') return startRecordNow(context);
      return startAcquisition(context);
    }
    case 'stop':
      return stopAcquisition(context);
    case 'retune':
      return retuneTrigger(context);
    case 'restart':
      return restartAcquisition(context);
    case 'completed':
      return complete(context);
    case 'pause':
      return pauseRecord(context);
    case 'resume':
      return resume(context);
    case 'export':
      return exportRecord(context);
    case 'record-error':
      return recordFailure(context, 'error');
    case 'record-full':
      return recordFailure(context, 'full');
    case 'lost':
      return lose(context);
    case 'suspend':
      return suspend(context);
    case 'fit':
      // Fit always returns to FollowLive, even if the view already follows.
      return success(
        { ...context, view: 'follow', viewBeforeLock: 'follow' },
        ['relayout'],
      );
    case 'gesture':
      // A manual pan/zoom replaces any policy, including a Loop trigger lock.
      return success(
        { ...context, view: 'fixed', viewBeforeLock: 'follow' },
        ['relayout'],
      );
    case 'trigger':
      return matchTrigger(context);
    case 'release':
      return releaseTriggerLock(context);
    default:
      return refusal('invalid-event', `unknown acquisition event: ${type}`);
  }
}
