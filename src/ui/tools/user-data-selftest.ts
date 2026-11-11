// SPDX-License-Identifier: GPL-3.0-or-later

import {
  clearStoredUserData,
  clearUserData,
  USER_CACHE_PREFIXES,
  USER_STORAGE_PREFIXES,
  type UserDataEnvironment,
  type UserDataResetReport,
  type UserDataStores,
} from '../userData.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

type OpKind = 'length' | 'key' | 'remove';

interface StorageOp {
  readonly store: string;
  readonly kind: OpKind;
  readonly key: string | null;
}

interface Op {
  readonly source: string;
  readonly action: string;
  readonly name: string | null;
}

class FakeStorage {
  readonly map = new Map<string, string>();
  readonly ops: StorageOp[];
  throwLengthOnCall: number | null = null;
  readonly throwKeyAt = new Set<number>();
  readonly throwRemoveFor = new Set<string>();
  readonly noopRemoveFor = new Set<string>();
  private lengthCalls = 0;

  constructor(readonly label: string, log: StorageOp[] = [], readonly events: Op[] = []) {
    this.ops = log;
  }

  get length(): number {
    this.lengthCalls += 1;
    this.ops.push({ store: this.label, kind: 'length', key: null });
    this.events.push({ source: this.label, action: 'length', name: null });
    if (this.lengthCalls === this.throwLengthOnCall) throw new Error('length blocked');
    return this.map.size;
  }

  key(index: number): string | null {
    this.ops.push({ store: this.label, kind: 'key', key: null });
    this.events.push({ source: this.label, action: 'key', name: null });
    if (this.throwKeyAt.has(index)) throw new Error('key blocked');
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.ops.push({ store: this.label, kind: 'remove', key });
    this.events.push({ source: this.label, action: 'remove', name: key });
    if (this.throwRemoveFor.has(key)) throw new Error('remove blocked');
    if (this.noopRemoveFor.has(key)) return;
    this.map.delete(key);
  }
}

function seeded(label: string, entries: readonly (readonly [string, string])[]): FakeStorage {
  const store = new FakeStorage(label);
  for (const [key, value] of entries) store.map.set(key, value);
  return store;
}

const LOCAL_APP: readonly (readonly [string, string])[] = [
  ['slogicweb.theme', 'dark'],
  ['slogicweb.workspace', '{"version":1}'],
  ['logicweb.panelWidth', '350'],
];

const LOCAL_FOREIGN: readonly (readonly [string, string])[] = [
  ['other.app', '1'],
  ['theme', '2'],
  ['slogicwebX', '3'],
  ['logicwebx', '4'],
  ['slogicweb', '5'],
  ['myslogicweb.theme', '6'],
];

const SESSION_APP: readonly (readonly [string, string])[] = [
  ['slogicweb.assistant.keys', 'k'],
  ['logicweb.platformNoticeDismissed', '1'],
];

const SESSION_FOREIGN: readonly (readonly [string, string])[] = [
  ['other.tab', '2'],
  ['logicweb', '3'],
];

const LOCAL_FOREIGN_KEYS = LOCAL_FOREIGN.map(([key]) => key);
const SESSION_FOREIGN_KEYS = SESSION_FOREIGN.map(([key]) => key);

function fullFixture(log?: StorageOp[]): { local: FakeStorage; session: FakeStorage } {
  const local = new FakeStorage('localStorage', log);
  for (const [key, value] of [...LOCAL_APP, ...LOCAL_FOREIGN]) local.map.set(key, value);
  const session = new FakeStorage('sessionStorage', log);
  for (const [key, value] of [...SESSION_APP, ...SESSION_FOREIGN]) session.map.set(key, value);
  return { local, session };
}

function keys(store: FakeStorage): string {
  return JSON.stringify([...store.map.keys()]);
}

function attempt(input: UserDataStores): { report: UserDataResetReport | null; thrown: unknown } {
  try {
    return { report: clearStoredUserData(input), thrown: null };
  } catch (error) {
    return { report: null, thrown: error };
  }
}

{
  check('the storage prefix list is exactly the current and legacy prefixes',
    JSON.stringify(USER_STORAGE_PREFIXES) === JSON.stringify(['slogicweb.', 'logicweb.']),
    JSON.stringify(USER_STORAGE_PREFIXES));
}

{
  const { local, session } = fullFixture();
  const report = clearStoredUserData({ local, session });
  check('every current-prefix entry is removed from both storages',
    !local.map.has('slogicweb.theme') && !local.map.has('slogicweb.workspace') &&
    !session.map.has('slogicweb.assistant.keys'),
    `local=${keys(local)} session=${keys(session)}`);
  check('every legacy-prefix entry is removed from both storages',
    !local.map.has('logicweb.panelWidth') &&
    !session.map.has('logicweb.platformNoticeDismissed'),
    `local=${keys(local)} session=${keys(session)}`);
  check('foreign keys survive with the exact prefix boundary',
    keys(local) === JSON.stringify(LOCAL_FOREIGN_KEYS) &&
    keys(session) === JSON.stringify(SESSION_FOREIGN_KEYS),
    `local=${keys(local)} session=${keys(session)}`);
  check('a clean sweep reports ok with no failures and no survivors',
    report.ok && report.failures.length === 0 && report.remaining.length === 0,
    `ok=${report.ok} failures=${JSON.stringify(report.failures.map((f) => f.operation))} ` +
    `remaining=${JSON.stringify(report.remaining)}`);
}

{
  const report = clearStoredUserData({ local: null, session: null });
  check('absent storages are an empty surface, not a failure',
    report.ok && report.failures.length === 0 && report.remaining.length === 0,
    `ok=${report.ok} failures=${report.failures.length} remaining=${report.remaining.length}`);
}

{
  const local = seeded('localStorage', [
    ['slogicweb.theme', 'dark'],
    ['other.app', '1'],
  ]);
  const session = seeded('sessionStorage', [
    ['slogicweb.assistant.keys', 'k'],
    ['other.tab', '1'],
  ]);
  const localOnly = clearStoredUserData({ local, session: null });
  const sessionOnly = clearStoredUserData({ local: null, session });
  check('a present store is swept while the other one is absent',
    localOnly.ok && sessionOnly.ok &&
    !local.map.has('slogicweb.theme') && local.map.has('other.app') &&
    !session.map.has('slogicweb.assistant.keys') && session.map.has('other.tab'),
    `local=${keys(local)} session=${keys(session)}`);
}

{
  const { local, session } = fullFixture();
  local.throwLengthOnCall = 1;
  const { report, thrown } = attempt({ local, session });
  const operations = report?.failures.map((failure) => failure.operation) ?? [];
  check('a throwing length read never escapes and does not stop either store',
    thrown === null && report !== null && !report.ok &&
    operations.includes('localStorage.keys') &&
    report.remaining.includes('localStorage:slogicweb.theme') &&
    !session.map.has('slogicweb.assistant.keys'),
    `thrown=${String(thrown)} ops=${JSON.stringify(operations)} ` +
    `remaining=${JSON.stringify(report?.remaining)}`);
  check('a failure keeps the thrown error for the caller',
    report?.failures[0]?.error instanceof Error,
    `${String(report?.failures[0]?.error)}`);
}

{
  const { local, session } = fullFixture();
  local.throwKeyAt.add(1);
  const { report, thrown } = attempt({ local, session });
  check('a throwing key read is reported, other keys are swept, and the survivor is verified',
    thrown === null && report !== null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'localStorage.keys') &&
    report.remaining.includes('localStorage:slogicweb.workspace') &&
    !local.map.has('slogicweb.theme') && !local.map.has('logicweb.panelWidth') &&
    !session.map.has('slogicweb.assistant.keys'),
    `remaining=${JSON.stringify(report?.remaining)} local=${keys(local)}`);
}

{
  const { local, session } = fullFixture();
  local.throwRemoveFor.add('slogicweb.workspace');
  const { report, thrown } = attempt({ local, session });
  check('a throwing removal is reported and the surviving key is named',
    thrown === null && report !== null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'localStorage.removeItem') &&
    report.remaining.includes('localStorage:slogicweb.workspace') &&
    local.map.has('slogicweb.workspace') && !local.map.has('slogicweb.theme') &&
    !session.map.has('slogicweb.assistant.keys'),
    `remaining=${JSON.stringify(report?.remaining)} local=${keys(local)}`);
}

{
  const { local, session } = fullFixture();
  local.noopRemoveFor.add('slogicweb.workspace');
  const report = clearStoredUserData({ local, session });
  check('a deletion that silently does nothing is a failure, not a clean report',
    !report.ok && report.failures.length === 0 &&
    report.remaining.join(',') === 'localStorage:slogicweb.workspace',
    `ok=${report.ok} failures=${report.failures.length} remaining=${JSON.stringify(report.remaining)}`);
}

{
  const { local, session } = fullFixture();
  session.noopRemoveFor.add('slogicweb.assistant.keys');
  const report = clearStoredUserData({ local, session });
  check('session verification names its own survivor',
    !report.ok && report.remaining.join(',') === 'sessionStorage:slogicweb.assistant.keys',
    `remaining=${JSON.stringify(report.remaining)}`);
}

{
  const { local, session } = fullFixture();
  local.throwLengthOnCall = 2;
  const { report, thrown } = attempt({ local, session });
  check('a throwing verification pass is reported after a successful deletion pass',
    thrown === null && report !== null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'localStorage.verify') &&
    report.remaining.length === 0 &&
    !local.map.has('slogicweb.theme') && !local.map.has('slogicweb.workspace') &&
    !session.map.has('slogicweb.assistant.keys'),
    `thrown=${String(thrown)} ops=${JSON.stringify(report?.failures.map((f) => f.operation))} ` +
    `local=${keys(local)}`);
}

{
  const { local, session } = fullFixture();
  const first = clearStoredUserData({ local, session });
  const second = clearStoredUserData({ local, session });
  check('a second sweep over already-clean storages is still ok',
    first.ok && second.ok && second.failures.length === 0 && second.remaining.length === 0 &&
    keys(local) === JSON.stringify(LOCAL_FOREIGN_KEYS) &&
    keys(session) === JSON.stringify(SESSION_FOREIGN_KEYS),
    `first=${first.ok} second=${second.ok} local=${keys(local)} session=${keys(session)}`);
}

{
  const log: StorageOp[] = [];
  const { local } = fullFixture(log);
  local.noopRemoveFor.add('slogicweb.workspace');
  clearStoredUserData({ local, session: null });
  const removeAt = log.flatMap((op, index) => (op.kind === 'remove' ? [index] : []));
  const keyAt = log.flatMap((op, index) => (op.kind === 'key' ? [index] : []));
  const lastRemove = removeAt[removeAt.length - 1] ?? -1;
  const lastKey = keyAt[keyAt.length - 1] ?? -1;
  const lengths = log.filter((op) => op.kind === 'length').length;
  check('deletions finish before the verification reads begin',
    lastRemove >= 0 && lastKey > lastRemove && lengths === 2,
    `lastRemove=${lastRemove} lastKey=${lastKey} lengths=${lengths}`);
}

interface ControlSweepOptions {
  readonly prefixes?: readonly string[];
  readonly session?: boolean;
  readonly verify?: boolean;
  readonly backward?: boolean;
}

function degradedSweep(
  local: FakeStorage, session: FakeStorage, options: ControlSweepOptions,
): boolean {
  const prefixes = options.prefixes ?? USER_STORAGE_PREFIXES;
  const stores = options.session === false ? [local] : [local, session];
  const matches = (key: string): boolean => prefixes.some((prefix) => key.startsWith(prefix));
  for (const store of stores) {
    if (options.backward === false) {
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key !== null && matches(key)) store.removeItem(key);
      }
      continue;
    }
    const snapshot: string[] = [];
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const key = store.key(index);
      if (key !== null) snapshot.push(key);
    }
    for (const key of snapshot) if (matches(key)) store.removeItem(key);
  }
  if (options.verify === false) return true;
  for (const store of stores) {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && matches(key)) return false;
    }
  }
  return true;
}

{
  const controls: [string, () => boolean][] = [
    ['a dropped legacy prefix leaves legacy keys behind', () => {
      const { local, session } = fullFixture();
      degradedSweep(local, session, { prefixes: ['slogicweb.'] });
      return local.map.has('logicweb.panelWidth') ||
        session.map.has('logicweb.platformNoticeDismissed');
    }],
    ['a broad prefix match deletes foreign keys', () => {
      const { local, session } = fullFixture();
      degradedSweep(local, session, { prefixes: ['slogicweb', 'logicweb'] });
      return !local.map.has('slogicwebX') || !local.map.has('logicwebx') ||
        !local.map.has('slogicweb');
    }],
    ['ignoring sessionStorage leaves the session entries', () => {
      const { local, session } = fullFixture();
      degradedSweep(local, session, { session: false });
      return session.map.has('slogicweb.assistant.keys') ||
        session.map.has('logicweb.platformNoticeDismissed');
    }],
    ['deleting during a forward walk skips an entry', () => {
      const { local, session } = fullFixture();
      degradedSweep(local, session, { backward: false });
      return local.map.has('slogicweb.workspace');
    }],
    ['skipped verification hides a no-op deletion', () => {
      const { local, session } = fullFixture();
      local.noopRemoveFor.add('slogicweb.workspace');
      const ok = degradedSweep(local, session, { verify: false });
      return ok && local.map.has('slogicweb.workspace');
    }],
  ];
  const survivors = controls.filter(([, run]) => !run()).map(([name]) => name);
  check('each degraded sweep is caught by the same fixtures',
    survivors.length === 0,
    controls.length === 0 ? 'no controls' : `survivors=${JSON.stringify(survivors)}`);
}

const CACHE_NAMES: readonly string[] = [
  'slogicweb:https://app.example/:shell-0.1.0',
  'slogicweb:https://app.example/:runtime',
  'logicweb:https://app.example/:shell-0.0.9',
  'other-app:cache',
  'slogicwebX:cache',
  'logicwebx:cache',
];
const CACHE_USER = CACHE_NAMES.slice(0, 3);
const CACHE_FOREIGN = CACHE_NAMES.slice(3);

class FakeCaches {
  readonly entries: Set<string>;
  readonly rejectKeysOnCall = new Set<number>();
  readonly rejectDeleteFor = new Set<string>();
  readonly falseDeleteFor = new Set<string>();
  readonly noopDeleteFor = new Set<string>();
  private keyCalls = 0;

  constructor(readonly label: string, readonly events: Op[], names: readonly string[] = []) {
    this.entries = new Set(names);
  }

  async keys(): Promise<string[]> {
    this.keyCalls += 1;
    this.events.push({ source: this.label, action: 'keys', name: null });
    if (this.rejectKeysOnCall.has(this.keyCalls)) throw new Error('cache keys blocked');
    return [...this.entries];
  }

  async delete(name: string): Promise<boolean> {
    this.events.push({ source: this.label, action: 'delete', name });
    if (this.rejectDeleteFor.has(name)) throw new Error('cache delete blocked');
    if (this.falseDeleteFor.has(name)) {
      this.entries.delete(name);
      return false;
    }
    if (this.noopDeleteFor.has(name)) return true;
    return this.entries.delete(name);
  }
}

class FakeRegistration {
  calls = 0;
  reject = false;
  answer = true;

  constructor(readonly label: string, readonly events: Op[]) {}

  async unregister(): Promise<boolean> {
    this.calls += 1;
    this.events.push({ source: this.label, action: 'unregister', name: null });
    if (this.reject) throw new Error('unregister blocked');
    return this.answer;
  }
}

class FakeServiceWorker {
  calls = 0;
  reject = false;

  constructor(
    readonly label: string,
    readonly events: Op[],
    readonly registration: FakeRegistration | null,
  ) {}

  async getRegistration(): Promise<FakeRegistration | undefined> {
    this.calls += 1;
    this.events.push({ source: this.label, action: 'getRegistration', name: null });
    if (this.reject) throw new Error('registration lookup blocked');
    return this.registration ?? undefined;
  }
}

class ResetProbe {
  reloads = 0;
  beforeReloads = 0;
  reloadAt: number | null = null;
  beforeReloadAt: number | null = null;
  reloadError: Error | null = null;
  beforeReloadError: Error | null = null;

  constructor(readonly events: Op[]) {}

  readonly beforeReload = (): void => {
    this.beforeReloads += 1;
    this.beforeReloadAt = this.events.length;
    if (this.beforeReloadError) throw this.beforeReloadError;
  };

  readonly reload = (): void => {
    this.reloads += 1;
    this.reloadAt = this.events.length;
    if (this.reloadError) throw this.reloadError;
  };
}

interface Scenario {
  readonly events: Op[];
  readonly caches: FakeCaches | null;
  readonly worker: FakeServiceWorker | null;
  readonly registration: FakeRegistration | null;
  readonly local: FakeStorage;
  readonly session: FakeStorage;
  readonly probe: ResetProbe;
  readonly env: UserDataEnvironment;
}

function scenario(withRegistration = true): Scenario {
  const events: Op[] = [];
  const caches = new FakeCaches('caches', events, CACHE_NAMES);
  const registration = withRegistration
    ? new FakeRegistration('serviceWorker.registration', events)
    : null;
  const worker = new FakeServiceWorker('serviceWorker', events, registration);
  const local = new FakeStorage('localStorage', [], events);
  for (const [key, value] of [...LOCAL_APP, ...LOCAL_FOREIGN]) local.map.set(key, value);
  const session = new FakeStorage('sessionStorage', [], events);
  for (const [key, value] of [...SESSION_APP, ...SESSION_FOREIGN]) session.map.set(key, value);
  const probe = new ResetProbe(events);
  const env: UserDataEnvironment = {
    local,
    session,
    caches,
    serviceWorker: worker,
    beforeReload: probe.beforeReload,
    reload: probe.reload,
  };
  return { events, caches, worker, registration, local, session, probe, env };
}

async function attemptReset(
  input: UserDataEnvironment,
): Promise<{ report: UserDataResetReport; thrown: unknown }> {
  try {
    return { report: await clearUserData(input), thrown: null };
  } catch (error) {
    return { report: { ok: false, failures: [], remaining: ['threw'] }, thrown: error };
  }
}

function firstEvent(events: readonly Op[], source: string, action: string): number {
  return events.findIndex((event) => event.source === source && event.action === action);
}

function lastEvent(events: readonly Op[], source: string): number {
  let found = -1;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].source === source) found = index;
  }
  return found;
}

function firstStorage(events: readonly Op[]): number {
  return events.findIndex((event) =>
    event.source === 'localStorage' || event.source === 'sessionStorage');
}

function survivingCaches(s: Scenario): string[] {
  return s.caches === null ? [] : [...s.caches.entries];
}

function unregisterFirst(events: readonly Op[]): boolean {
  const lookup = firstEvent(events, 'serviceWorker', 'getRegistration');
  const unregister = firstEvent(events, 'serviceWorker.registration', 'unregister');
  const caches = firstEvent(events, 'caches', 'keys');
  const storage = firstStorage(events);
  return lookup >= 0 && unregister > lookup && caches > unregister && storage > caches;
}

function cachesVerifiedBeforeStorage(events: readonly Op[]): boolean {
  const listings = events.filter((event) =>
    event.source === 'caches' && event.action === 'keys').length;
  const caches = lastEvent(events, 'caches');
  const storage = firstStorage(events);
  return listings === 2 && caches >= 0 && storage > caches;
}

function reloadsOnlyAfterSuccess(ok: boolean, probe: ResetProbe): boolean {
  return ok
    ? probe.reloads === 1 && probe.beforeReloads === 1
    : probe.reloads === 0 && probe.beforeReloads === 0;
}

function storageTailBeforeReload(events: readonly Op[], probe: ResetProbe): boolean {
  const storage = lastEvent(events, 'sessionStorage');
  const last = events[events.length - 1];
  return probe.beforeReloads === 1 && probe.reloads === 1 &&
    (probe.beforeReloadAt ?? -1) > storage && probe.reloadAt === events.length &&
    last !== undefined && last.source === 'sessionStorage';
}

type GlobalName = 'caches' | 'navigator' | 'localStorage' | 'sessionStorage' | 'location';

const GLOBAL_NAMES: readonly GlobalName[] = [
  'caches', 'navigator', 'localStorage', 'sessionStorage', 'location',
];

interface GlobalGuard {
  restore(): void;
  restored(): boolean;
}

function installGlobals(accessors: Partial<Record<GlobalName, () => unknown>>): GlobalGuard {
  const scope = globalThis as unknown as Record<GlobalName, unknown>;
  const saved = GLOBAL_NAMES.map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      get: accessors[name] ?? (() => undefined),
    });
  }
  return {
    restore(): void {
      for (const [name, descriptor] of saved) {
        if (descriptor === undefined) delete scope[name];
        else Object.defineProperty(globalThis, name, descriptor);
      }
    },
    restored(): boolean {
      return saved.every(([name, descriptor]) => {
        const current = Object.getOwnPropertyDescriptor(globalThis, name);
        if (descriptor === undefined) return current === undefined;
        return current !== undefined && current.get === descriptor.get &&
          current.value === descriptor.value &&
          current.configurable === descriptor.configurable &&
          current.enumerable === descriptor.enumerable;
      });
    },
  };
}

interface GlobalResetState {
  readonly caches: FakeCaches;
  readonly registrationCalls: number;
  readonly local: FakeStorage;
  readonly session: FakeStorage;
  readonly beforeReloads: number;
  readonly reloads: number;
}

function fullyCleared(state: GlobalResetState): boolean {
  return state.registrationCalls === 1 &&
    CACHE_USER.every((name) => ![...state.caches.entries].includes(name)) &&
    CACHE_FOREIGN.every((name) => [...state.caches.entries].includes(name)) &&
    keys(state.local) === JSON.stringify(LOCAL_FOREIGN_KEYS) &&
    keys(state.session) === JSON.stringify(SESSION_FOREIGN_KEYS) &&
    state.beforeReloads === 1 && state.reloads === 1;
}

{
  check('the cache prefix list is exactly the current and legacy prefixes',
    JSON.stringify(USER_CACHE_PREFIXES) === JSON.stringify(['slogicweb:', 'logicweb:']),
    JSON.stringify(USER_CACHE_PREFIXES));
}

{
  const s = scenario();
  const { report, thrown } = await attemptReset(s.env);
  check('a clean reset unregisters the worker, clears current and legacy caches and sweeps both storages',
    thrown === null && report.ok && report.failures.length === 0 &&
    report.remaining.length === 0 &&
    s.registration?.calls === 1 && s.worker?.calls === 1 &&
    CACHE_USER.every((name) => !survivingCaches(s).includes(name)) &&
    CACHE_FOREIGN.every((name) => survivingCaches(s).includes(name)) &&
    !s.local.map.has('slogicweb.theme') && !s.local.map.has('logicweb.panelWidth') &&
    !s.session.map.has('slogicweb.assistant.keys') &&
    !s.session.map.has('logicweb.platformNoticeDismissed') &&
    keys(s.local) === JSON.stringify(LOCAL_FOREIGN_KEYS) &&
    keys(s.session) === JSON.stringify(SESSION_FOREIGN_KEYS),
    `thrown=${String(thrown)} ok=${report.ok} remaining=${JSON.stringify(report.remaining)} ` +
    `caches=${JSON.stringify(survivingCaches(s))} local=${keys(s.local)}`);
  check('the worker is unregistered before any cache or storage access',
    unregisterFirst(s.events), JSON.stringify(s.events));
  check('both cache listings finish before the storage sweep starts',
    cachesVerifiedBeforeStorage(s.events), JSON.stringify(s.events));
  check('the reset reloads exactly once after verification with no later access',
    storageTailBeforeReload(s.events, s.probe),
    `before=${s.probe.beforeReloadAt} reload=${s.probe.reloadAt} events=${s.events.length}`);
}

{
  const s = scenario();
  const { report, thrown } = await attemptReset({
    local: null,
    session: null,
    caches: null,
    serviceWorker: null,
    beforeReload: s.probe.beforeReload,
    reload: s.probe.reload,
  });
  check('absent cache, worker and storage APIs are an empty surface that still reloads once',
    thrown === null && report.ok && report.failures.length === 0 &&
    report.remaining.length === 0 && s.events.length === 0 &&
    s.probe.beforeReloads === 1 && s.probe.reloads === 1,
    `thrown=${String(thrown)} ok=${report.ok} events=${JSON.stringify(s.events)} ` +
    `reloads=${s.probe.reloads}`);
}

{
  const s = scenario(false);
  const { report, thrown } = await attemptReset(s.env);
  check('a page with no cached registration skips unregistration and still clears everything',
    thrown === null && report.ok && s.worker?.calls === 1 &&
    firstEvent(s.events, 'serviceWorker.registration', 'unregister') === -1 &&
    CACHE_USER.every((name) => !survivingCaches(s).includes(name)) &&
    !s.local.map.has('slogicweb.theme') && s.probe.reloads === 1,
    `thrown=${String(thrown)} ok=${report.ok} events=${JSON.stringify(s.events)}`);
}

{
  const s = scenario();
  if (s.worker !== null) s.worker.reject = true;
  const { report, thrown } = await attemptReset(s.env);
  check('a rejected registration lookup stops before caches, storage and reload',
    thrown === null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'serviceWorker.getRegistration') &&
    firstEvent(s.events, 'caches', 'keys') === -1 &&
    s.local.ops.length === 0 && s.session.ops.length === 0 &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `thrown=${String(thrown)} ok=${report.ok} events=${JSON.stringify(s.events)} ` +
    `local=${s.local.ops.length}`);
}

{
  const s = scenario();
  if (s.registration !== null) s.registration.reject = true;
  const { report, thrown } = await attemptReset(s.env);
  check('a rejected unregistration stops before caches, storage and reload',
    thrown === null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'serviceWorker.unregister') &&
    firstEvent(s.events, 'caches', 'keys') === -1 &&
    s.local.ops.length === 0 && s.session.ops.length === 0 &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `thrown=${String(thrown)} ok=${report.ok} events=${JSON.stringify(s.events)}`);
}

{
  const s = scenario();
  if (s.registration !== null) s.registration.answer = false;
  const { report, thrown } = await attemptReset(s.env);
  check('an unregistration answering false is a failure with no cache, storage or reload access',
    thrown === null && !report.ok &&
    report.failures.some((failure) =>
      failure.operation === 'serviceWorker.unregister' && failure.error === false) &&
    firstEvent(s.events, 'caches', 'keys') === -1 &&
    s.local.ops.length === 0 && s.session.ops.length === 0 &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `ok=${report.ok} failures=${JSON.stringify(report.failures.map((f) => f.operation))}`);
}

{
  const s = scenario();
  if (s.caches !== null) s.caches.rejectKeysOnCall.add(1);
  const { report, thrown } = await attemptReset(s.env);
  check('a rejected cache listing stops before storage and reload',
    thrown === null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'caches.keys') &&
    firstStorage(s.events) === -1 && s.local.ops.length === 0 && s.session.ops.length === 0 &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `ok=${report.ok} events=${JSON.stringify(s.events)}`);
}

{
  const s = scenario();
  if (s.caches !== null) s.caches.rejectDeleteFor.add(CACHE_USER[0]);
  const { report, thrown } = await attemptReset(s.env);
  check('a rejected cache deletion names the survivor and skips storage and reload',
    thrown === null && !report.ok &&
    report.failures.some((failure) =>
      failure.operation === 'caches.delete' && failure.error instanceof Error) &&
    report.remaining.join(',') === `cache:${CACHE_USER[0]}` &&
    firstStorage(s.events) === -1 && s.local.ops.length === 0 &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `ok=${report.ok} remaining=${JSON.stringify(report.remaining)}`);
}

{
  const s = scenario();
  if (s.caches !== null) s.caches.falseDeleteFor.add(CACHE_USER[0]);
  const { report, thrown } = await attemptReset(s.env);
  check('a cache deletion answering false is a failure even when verification finds it gone',
    thrown === null && !report.ok &&
    report.failures.some((failure) =>
      failure.operation === 'caches.delete' && failure.error === false) &&
    report.remaining.length === 0 && !survivingCaches(s).includes(CACHE_USER[0]) &&
    firstStorage(s.events) === -1 && s.probe.reloads === 0,
    `ok=${report.ok} failures=${JSON.stringify(report.failures.map((f) => f.operation))} ` +
    `remaining=${JSON.stringify(report.remaining)}`);
}

{
  const s = scenario();
  if (s.caches !== null) s.caches.noopDeleteFor.add(CACHE_USER[1]);
  const { report, thrown } = await attemptReset(s.env);
  check('a cache deletion that silently does nothing is caught by verification',
    thrown === null && !report.ok && report.failures.length === 0 &&
    report.remaining.join(',') === `cache:${CACHE_USER[1]}` &&
    firstStorage(s.events) === -1 && s.local.ops.length === 0 &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `ok=${report.ok} remaining=${JSON.stringify(report.remaining)}`);
}

{
  const s = scenario();
  if (s.caches !== null) s.caches.rejectKeysOnCall.add(2);
  const { report, thrown } = await attemptReset(s.env);
  check('a throwing cache verification pass is reported after the deletions',
    thrown === null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'caches.verify') &&
    CACHE_USER.every((name) => !survivingCaches(s).includes(name)) &&
    firstStorage(s.events) === -1 && s.probe.reloads === 0,
    `ok=${report.ok} failures=${JSON.stringify(report.failures.map((f) => f.operation))}`);
}

{
  const s = scenario();
  s.local.noopRemoveFor.add('slogicweb.workspace');
  const { report, thrown } = await attemptReset(s.env);
  check('a storage survivor after a clean async phase reports non-ok and never reloads',
    thrown === null && !report.ok &&
    report.remaining.includes('localStorage:slogicweb.workspace') &&
    s.registration?.calls === 1 &&
    CACHE_USER.every((name) => !survivingCaches(s).includes(name)) &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `ok=${report.ok} remaining=${JSON.stringify(report.remaining)} ` +
    `reloads=${s.probe.reloads}`);
}

{
  const s = scenario();
  s.probe.beforeReloadError = new Error('unload guard blocked');
  const { report, thrown } = await attemptReset(s.env);
  check('a throwing unload callback blocks the reload and is reported',
    thrown === null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'beforeReload') &&
    s.probe.beforeReloads === 1 && s.probe.reloads === 0,
    `ok=${report.ok} reloads=${s.probe.reloads}`);
}

{
  const s = scenario();
  s.probe.reloadError = new Error('navigation blocked');
  const { report, thrown } = await attemptReset(s.env);
  check('a throwing reload is reported once with no retry',
    thrown === null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'reload') &&
    s.probe.reloads === 1,
    `ok=${report.ok} reloads=${s.probe.reloads}`);
}

{
  const s = scenario();
  const { report, thrown } = await attemptReset({
    local: s.local,
    session: s.session,
    caches: s.caches,
    serviceWorker: s.worker,
    beforeReload: s.probe.beforeReload,
  });
  check('an unresolvable reload is a failure that never runs the unload callback or navigates',
    thrown === null && !report.ok &&
    report.failures.some((failure) =>
      failure.operation === 'reload.unavailable' && failure.error === null) &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0 &&
    !s.local.map.has('slogicweb.theme') &&
    !s.session.map.has('slogicweb.assistant.keys'),
    `thrown=${String(thrown)} ok=${report.ok} ` +
    `failures=${JSON.stringify(report.failures.map((f) => f.operation))} ` +
    `before=${s.probe.beforeReloads} reloads=${s.probe.reloads}`);
}

{
  const s = scenario();
  const { report, thrown } = await attemptReset({
    local: s.local,
    session: s.session,
    caches: s.caches,
    serviceWorker: s.worker,
    reload: null,
    beforeReload: s.probe.beforeReload,
  });
  check('an explicitly null reload is the same failure before the unload callback',
    thrown === null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'reload.unavailable') &&
    s.probe.beforeReloads === 0 && s.probe.reloads === 0,
    `ok=${report.ok} before=${s.probe.beforeReloads} reloads=${s.probe.reloads}`);
}

{
  const s = scenario();
  const { report, thrown } = await attemptReset({ ...s.env, caches: null });
  check('an explicitly absent CacheStorage is skipped without stopping the reset',
    thrown === null && report.ok && report.failures.length === 0 &&
    report.remaining.length === 0 &&
    firstEvent(s.events, 'caches', 'keys') === -1 &&
    CACHE_USER.every((name) => survivingCaches(s).includes(name)) &&
    !s.local.map.has('slogicweb.theme') &&
    !s.session.map.has('slogicweb.assistant.keys') &&
    s.probe.beforeReloads === 1 && s.probe.reloads === 1,
    `thrown=${String(thrown)} ok=${report.ok} events=${JSON.stringify(s.events)}`);
}

{
  const s = scenario();
  const { report, thrown } = await attemptReset({ ...s.env, serviceWorker: null });
  check('an explicitly absent service worker container is skipped without stopping the reset',
    thrown === null && report.ok && report.failures.length === 0 &&
    firstEvent(s.events, 'serviceWorker', 'getRegistration') === -1 &&
    CACHE_USER.every((name) => !survivingCaches(s).includes(name)) &&
    !s.local.map.has('slogicweb.theme') && s.probe.reloads === 1,
    `thrown=${String(thrown)} ok=${report.ok} events=${JSON.stringify(s.events)}`);
}

{
  const s = scenario();
  const first = await attemptReset(s.env);
  const second = await attemptReset(s.env);
  check('a second reset over an already-clean origin is ok and reloads again',
    first.thrown === null && second.thrown === null &&
    first.report.ok && second.report.ok &&
    CACHE_FOREIGN.every((name) => survivingCaches(s).includes(name)) &&
    keys(s.local) === JSON.stringify(LOCAL_FOREIGN_KEYS) &&
    keys(s.session) === JSON.stringify(SESSION_FOREIGN_KEYS) &&
    s.probe.beforeReloads === 2 && s.probe.reloads === 2,
    `first=${first.report.ok} second=${second.report.ok} reloads=${s.probe.reloads}`);
}

{
  const events: Op[] = [];
  const caches = new FakeCaches('caches', events, CACHE_NAMES);
  const registration = new FakeRegistration('serviceWorker.registration', events);
  const worker = new FakeServiceWorker('serviceWorker', events, registration);
  const local = new FakeStorage('localStorage', [], events);
  for (const [key, value] of [...LOCAL_APP, ...LOCAL_FOREIGN]) local.map.set(key, value);
  const session = new FakeStorage('sessionStorage', [], events);
  for (const [key, value] of [...SESSION_APP, ...SESSION_FOREIGN]) session.map.set(key, value);
  let reloadThis: unknown = null;
  let reloads = 0;
  let beforeReloads = 0;
  const location = {
    reload(this: unknown): void {
      reloadThis = this;
      reloads += 1;
    },
  };
  const guard = installGlobals({
    caches: () => caches,
    navigator: () => ({ serviceWorker: worker }),
    localStorage: () => local,
    sessionStorage: () => session,
    location: () => location,
  });
  let report: UserDataResetReport | null = null;
  let thrown: unknown = null;
  try {
    const result = await attemptReset({ beforeReload: () => { beforeReloads += 1; } });
    report = result.report;
    thrown = result.thrown;
  } finally {
    guard.restore();
  }
  check('the guarded global descriptors drive the whole reset with no other injection',
    thrown === null && report !== null && report.ok &&
    report.failures.length === 0 && report.remaining.length === 0 &&
    fullyCleared({
      caches, registrationCalls: registration.calls, local, session, beforeReloads, reloads,
    }),
    `thrown=${String(thrown)} ok=${report?.ok} caches=${JSON.stringify([...caches.entries])} ` +
    `local=${keys(local)} before=${beforeReloads} reloads=${reloads}`);
  check('the global location reload runs with the location object as its receiver',
    reloadThis === location && reloads === 1,
    `sameReceiver=${reloadThis === location} reloads=${reloads}`);
  check('the guarded global fixtures restore every descriptor they replaced',
    guard.restored(), JSON.stringify(GLOBAL_NAMES));
}

{
  const local = new FakeStorage('localStorage', [], []);
  local.map.set('slogicweb.theme', 'dark');
  const session = new FakeStorage('sessionStorage', [], []);
  session.map.set('slogicweb.assistant.keys', 'k');
  let reloads = 0;
  let beforeReloads = 0;
  const guard = installGlobals({
    caches: () => null,
    navigator: () => ({ serviceWorker: null }),
    localStorage: () => { throw new Error('storage blocked'); },
    sessionStorage: () => session,
    location: () => ({ reload: () => { reloads += 1; } }),
  });
  let report: UserDataResetReport | null = null;
  let thrown: unknown = null;
  try {
    const result = await attemptReset({ beforeReload: () => { beforeReloads += 1; } });
    report = result.report;
    thrown = result.thrown;
  } finally {
    guard.restore();
  }
  check('a throwing global localStorage getter stops before any deletion or navigation',
    thrown === null && report !== null && !report.ok &&
    report.failures.some((failure) => failure.operation === 'localStorage.storage') &&
    local.map.has('slogicweb.theme') && session.map.has('slogicweb.assistant.keys') &&
    beforeReloads === 0 && reloads === 0 && guard.restored(),
    `thrown=${String(thrown)} ok=${report?.ok} ` +
    `failures=${JSON.stringify(report?.failures.map((f) => f.operation))} ` +
    `local=${keys(local)} before=${beforeReloads} reloads=${reloads}`);
}

{
  const local = new FakeStorage('localStorage', [], []);
  local.map.set('slogicweb.theme', 'dark');
  const session = new FakeStorage('sessionStorage', [], []);
  session.map.set('slogicweb.assistant.keys', 'k');
  let beforeReloads = 0;
  const guard = installGlobals({
    caches: () => null,
    navigator: () => ({ serviceWorker: null }),
    localStorage: () => local,
    sessionStorage: () => session,
    location: () => { throw new Error('location blocked'); },
  });
  let report: UserDataResetReport | null = null;
  let thrown: unknown = null;
  try {
    const result = await attemptReset({ beforeReload: () => { beforeReloads += 1; } });
    report = result.report;
    thrown = result.thrown;
  } finally {
    guard.restore();
  }
  check('a throwing global location getter fails after the sweep and before the unload callback',
    thrown === null && report !== null && !report.ok &&
    report.failures.some((failure) =>
      failure.operation === 'reload' && failure.error instanceof Error) &&
    !local.map.has('slogicweb.theme') && !session.map.has('slogicweb.assistant.keys') &&
    beforeReloads === 0 && guard.restored(),
    `thrown=${String(thrown)} ok=${report?.ok} ` +
    `failures=${JSON.stringify(report?.failures.map((f) => f.operation))} ` +
    `local=${keys(local)} before=${beforeReloads}`);
}

{
  const events: Op[] = [];
  const caches = new FakeCaches('caches', events, CACHE_NAMES);
  const local = new FakeStorage('localStorage', [], events);
  local.map.set('slogicweb.theme', 'dark');
  const session = new FakeStorage('sessionStorage', [], events);
  session.map.set('slogicweb.assistant.keys', 'k');
  let reloads = 0;
  const guard = installGlobals({
    caches: () => undefined,
    navigator: () => ({ serviceWorker: undefined }),
    localStorage: () => undefined,
    sessionStorage: () => undefined,
    location: () => ({ reload: () => { reloads += 1; } }),
  });
  let report: UserDataResetReport | null = null;
  try {
    report = (await attemptReset({})).report;
  } finally {
    guard.restore();
  }
  check('a null global fallback is caught by the same predicate, leaving every artifact behind',
    report !== null && report.ok &&
    !fullyCleared({
      caches, registrationCalls: 0, local, session, beforeReloads: 0, reloads,
    }) &&
    CACHE_USER.every((name) => [...caches.entries].includes(name)) &&
    local.map.has('slogicweb.theme') &&
    session.map.has('slogicweb.assistant.keys') && guard.restored(),
    `ok=${report?.ok} caches=${JSON.stringify([...caches.entries])} local=${keys(local)}`);
}

interface DegradedOptions {
  readonly unregister?: boolean;
  readonly cacheFirst?: boolean;
  readonly verify?: boolean;
  readonly continueAfterFailure?: boolean;
  readonly reloadOnFailure?: boolean;
  readonly storageFirst?: boolean;
}

async function degradedReset(s: Scenario, options: DegradedOptions = {}): Promise<boolean> {
  const runCaches = async (): Promise<boolean> => {
    if (s.caches === null) return true;
    let ok = true;
    for (const name of await s.caches.keys()) {
      if (!USER_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      if (!(await s.caches.delete(name))) ok = false;
    }
    if (options.verify === false) return ok;
    for (const name of await s.caches.keys()) {
      if (USER_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))) ok = false;
    }
    return ok;
  };
  const runWorker = async (): Promise<boolean> => {
    if (s.worker === null) return true;
    const registration = await s.worker.getRegistration();
    if (!registration) return true;
    return registration.unregister();
  };
  const runStorage = (): boolean =>
    clearStoredUserData({ local: s.local, session: s.session }).ok;

  let ok = options.storageFirst === true ? runStorage() : true;
  const phases: ReadonlyArray<() => Promise<boolean>> = options.unregister === false
    ? [runCaches]
    : options.cacheFirst === true ? [runCaches, runWorker] : [runWorker, runCaches];
  for (const phase of phases) {
    const phaseOk = await phase().catch(() => false);
    ok = ok && phaseOk;
    if (!phaseOk && options.continueAfterFailure !== true) break;
  }
  if (options.storageFirst !== true) ok = runStorage() && ok;
  if (ok || options.reloadOnFailure === true) s.probe.reload();
  return ok;
}

{
  const controls: [string, () => Promise<boolean>][] = [
    ['skipping the unregistration is observable', async () => {
      const s = scenario();
      const ok = await degradedReset(s, { unregister: false });
      return ok && s.registration?.calls === 0 &&
        CACHE_USER.every((name) => !survivingCaches(s).includes(name));
    }],
    ['deleting caches before unregistration is observable', async () => {
      const s = scenario();
      await degradedReset(s, { cacheFirst: true });
      return !unregisterFirst(s.events);
    }],
    ['continuing after a failed unregistration is observable', async () => {
      const s = scenario();
      if (s.worker !== null) s.worker.reject = true;
      await degradedReset(s, { continueAfterFailure: true });
      return firstEvent(s.events, 'caches', 'keys') >= 0;
    }],
    ['reloading after a cache failure is observable', async () => {
      const s = scenario();
      if (s.caches !== null) s.caches.noopDeleteFor.add(CACHE_USER[0]);
      const ok = await degradedReset(s, { reloadOnFailure: true });
      return !ok && !reloadsOnlyAfterSuccess(ok, s.probe);
    }],
    ['skipping cache verification is observable', async () => {
      const s = scenario();
      await degradedReset(s, { verify: false });
      return !cachesVerifiedBeforeStorage(s.events);
    }],
    ['sweeping storage before the cache phase is observable', async () => {
      const s = scenario();
      await degradedReset(s, { storageFirst: true });
      return !unregisterFirst(s.events);
    }],
  ];
  const survivors: string[] = [];
  for (const [name, run] of controls) {
    if (!(await run())) survivors.push(name);
  }
  check('each degraded reset is caught by the same fixtures',
    survivors.length === 0,
    controls.length === 0 ? 'no controls' : `survivors=${JSON.stringify(survivors)}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as
    { readFileSync(path: string, encoding: 'utf8'): string } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const source = fs.readFileSync('src/ui/userData.ts', 'utf8');
  check('the helper reads only the two exact prefixes',
    source.includes("['slogicweb.', 'logicweb.']") &&
    source.includes("['slogicweb:', 'logicweb:']") &&
    source.includes('.startsWith(prefix)') && !source.includes('.includes('),
    'prefix-match shape');
  check('the helper re-enumerates to verify and keeps every failure reported',
    source.includes('.verify') && source.includes('remaining.push(') &&
    !/catch\s*\{\s*\}/.test(source),
    'verification and failure shape');
  check('the reset module owns no DOM, markup, network or module import',
    !['document', 'window', 'innerHTML', 'fetch(', 'import '].some((token) => source.includes(token)),
    JSON.stringify(['document', 'window', 'innerHTML', 'fetch(', 'import ']
      .filter((token) => source.includes(token))));
  const unregisterAt = source.indexOf('await unregisterServiceWorker(');
  const cachesAt = source.indexOf('await deleteUserCaches(');
  const storageAt = source.indexOf('clearStoredUserData({ local, session })');
  const reloadResolveAt = source.indexOf("resolve('reload'");
  const beforeAt = source.indexOf("resolve('beforeReload'");
  const reloadCallAt = source.indexOf('\n    reload();');
  check(
    'the helper orders unregistration, caches, storage, reload resolution, the unload callback and the reload',
    unregisterAt > 0 && cachesAt > unregisterAt && storageAt > cachesAt &&
    reloadResolveAt > storageAt && beforeAt > reloadResolveAt && reloadCallAt > beforeAt,
    `at=${JSON.stringify([unregisterAt, cachesAt, storageAt, reloadResolveAt, beforeAt, reloadCallAt])}`);
  const storageResolveAt = source.indexOf("'localStorage.storage'");
  const storageGuardAt = source.indexOf('if (failures.length > 0) return report();', storageResolveAt);
  check('a storage resolution failure returns before the sweep and the reload tail',
    storageResolveAt > 0 && storageGuardAt > storageResolveAt && storageGuardAt < storageAt,
    `resolve=${storageResolveAt} guard=${storageGuardAt} sweep=${storageAt}`);
  const tail = source.slice(storageAt);
  const awaitsIn = (text: string): boolean => text.includes('await');
  const mutatedTail = tail.replace('const beforeReload', 'await Promise.resolve();\n  const beforeReload');
  check('the storage sweep, the unload callback and the reload form one synchronous tail',
    storageAt > 0 && !awaitsIn(tail) && awaitsIn(mutatedTail) && mutatedTail !== tail,
    `tail=${JSON.stringify(tail.slice(0, 40))}`);
}

const failed = results.filter((result) => !result.pass).length;
console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.pass || !result.detail ? '' : `\n        ${result.detail}`}`,
).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
