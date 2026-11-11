// SPDX-License-Identifier: GPL-3.0-or-later

import {
  clearStoredUserData,
  USER_STORAGE_PREFIXES,
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

class FakeStorage {
  readonly map = new Map<string, string>();
  readonly ops: StorageOp[];
  throwLengthOnCall: number | null = null;
  readonly throwKeyAt = new Set<number>();
  readonly throwRemoveFor = new Set<string>();
  readonly noopRemoveFor = new Set<string>();
  private lengthCalls = 0;

  constructor(readonly label: string, log: StorageOp[] = []) {
    this.ops = log;
  }

  get length(): number {
    this.lengthCalls += 1;
    this.ops.push({ store: this.label, kind: 'length', key: null });
    if (this.lengthCalls === this.throwLengthOnCall) throw new Error('length blocked');
    return this.map.size;
  }

  key(index: number): string | null {
    this.ops.push({ store: this.label, kind: 'key', key: null });
    if (this.throwKeyAt.has(index)) throw new Error('key blocked');
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.ops.push({ store: this.label, kind: 'remove', key });
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

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as
    { readFileSync(path: string, encoding: 'utf8'): string } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const source = fs.readFileSync('src/ui/userData.ts', 'utf8');
  check('the helper reads only the two exact prefixes',
    source.includes("['slogicweb.', 'logicweb.']") &&
    source.includes('.startsWith(prefix)') && !source.includes('.includes('),
    'prefix-match shape');
  check('the helper re-enumerates to verify and keeps every failure reported',
    source.includes('.verify') && source.includes('remaining.push(') &&
    !/catch\s*\{\s*\}/.test(source),
    'verification and failure shape');
  check('the storage helper is DOM-, cache-, worker-, and reload-free',
    !['document', 'window', 'caches', 'serviceWorker', 'innerHTML', 'fetch(', 'location.',
      'import '].some((token) => source.includes(token)),
    JSON.stringify(['document', 'window', 'caches', 'serviceWorker', 'innerHTML', 'fetch(',
      'location.', 'import '].filter((token) => source.includes(token))));
}

const failed = results.filter((result) => !result.pass).length;
console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}${result.pass || !result.detail ? '' : `\n        ${result.detail}`}`,
).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
