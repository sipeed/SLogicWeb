// SPDX-License-Identifier: GPL-3.0-or-later

import {
  AGENT_APPROVAL_TIMEOUT_MS,
  AGENT_MODE_KEY,
  AGENT_STALE_MS,
  AgentSession,
} from '../agentSession.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult { name: string; pass: boolean; detail: string }

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

async function rejects(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

// ------------------------------------------------ mode persistence and connection

{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>();
  let writes = 0;
  const fake = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      writes += 1;
      store.set(key, value);
    },
    removeItem: (key: string): void => { store.delete(key); },
    clear: (): void => { store.clear(); },
    key: (): string | null => null,
    get length(): number { return store.size; },
  } as unknown as Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true, value: fake,
  });
  try {
    const fresh = new AgentSession();
    const defaultAsk = fresh.snapshot().mode === 'ask';
    fresh.setMode('allow');
    const persisted = store.get(AGENT_MODE_KEY) === 'allow' && writes === 1;
    const reloaded = new AgentSession().snapshot().mode === 'allow';
    store.set(AGENT_MODE_KEY, 'loud');
    const ignoresUnknown = new AgentSession().snapshot().mode === 'ask';
    const sameModeIsQuiet = (() => {
      const quiet = new AgentSession();
      let notified = 0;
      quiet.subscribe(() => { notified += 1; });
      quiet.setMode('ask');
      return notified === 0;
    })();
    check('agent mode defaults to ask, persists a valid pick and ignores a damaged stored value',
      defaultAsk && persisted && reloaded && ignoresUnknown && sameModeIsQuiet,
      `default=${defaultAsk}, persisted=${persisted}, reloaded=${reloaded}, ` +
      `unknown=${ignoresUnknown}, quiet=${sameModeIsQuiet}`);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage blocked'); },
  });
  try {
    const blocked = new AgentSession();
    let threw = false;
    try {
      blocked.setMode('read-only');
    } catch {
      threw = true;
    }
    check('a blocked storage surface neither breaks construction nor mode changes',
      !threw && blocked.snapshot().mode === 'read-only',
      `threw=${threw}, mode=${blocked.snapshot().mode}`);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

{
  const realNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const session = new AgentSession();
    const absent = !session.connected() && session.snapshot().name === null;
    let notified = 0;
    session.subscribe(() => { notified += 1; });
    session.hello('  Scout  ');
    const announced = session.connected() && session.snapshot().name === 'Scout' &&
      notified === 1;
    now += AGENT_STALE_MS + 1;
    const stale = !session.connected();
    session.ping();
    const revived = session.connected();
    session.hello('   ');
    const fallbackName = session.snapshot().name === 'Agent';
    session.hello('x'.repeat(120));
    const cappedName = session.snapshot().name?.length === 80;
    check('a hello names and connects the agent, the heartbeat revives it after the stale window, and names are bounded',
      absent && announced && stale && revived && fallbackName && cappedName,
      `absent=${absent}, announced=${announced}, stale=${stale}, revived=${revived}, ` +
      `fallback=${fallbackName}, capped=${cappedName}`);
  } finally {
    Date.now = realNow;
  }
}

// ------------------------------------------------------------ action gating

{
  const session = new AgentSession();
  let ran = 0;
  session.setMode('read-only');
  const asyncDenied = await rejects(session.guardAsync('startAndWait', 'Start', async () => {
    ran += 1;
    return 'ran';
  }));
  let syncThrew = false;
  try {
    session.guardSync('applySettings', () => { ran += 1; });
  } catch {
    syncThrew = true;
  }
  const log = session.snapshot().log;
  check('read-only refuses both async and sync actions before they run and logs the denial',
    asyncDenied && syncThrew && ran === 0 && log.length === 2 &&
    log.every((entry) => entry.decision === 'denied'),
    `async=${asyncDenied}, sync=${syncThrew}, ran=${ran}, log=${JSON.stringify(log)}`);
}

{
  const session = new AgentSession();
  session.setMode('allow');
  const value = await session.guardAsync('startAndWait', 'Start', async () => 'ok');
  const syncValue = session.guardSync('applySettings', () => 7);
  const log = session.snapshot().log;
  check('allow runs capture and edit actions and records each as allowed',
    value === 'ok' && syncValue === 7 && log.length === 2 &&
    log[0]!.tool === 'applySettings' && log[0]!.decision === 'allowed' &&
    log[1]!.tool === 'startAndWait' && log[1]!.decision === 'allowed',
    `value=${value}, sync=${syncValue}, log=${JSON.stringify(log)}`);
}

{
  const session = new AgentSession();
  const notified: string[] = [];
  session.subscribe(() => notified.push('tick'));
  const syncValue = session.guardSync('updateBus', () => 3);
  const log = session.snapshot().log;
  check('ask mode lets a synchronous edit through as automatic and says so in the log',
    syncValue === 3 && log.length === 1 && log[0]!.tool === 'updateBus' &&
    log[0]!.decision === 'auto' && notified.length >= 1,
    `value=${syncValue}, log=${JSON.stringify(log)}, notifications=${notified.length}`);
}

{
  const session = new AgentSession();
  const pending = session.guardAsync('startAndWait', 'Start a capture', async () => 'done');
  const asked = session.snapshot().approvals;
  const queued = asked.length === 1 && asked[0]!.tool === 'startAndWait' &&
    asked[0]!.summary === 'Start a capture';
  const approvalId = asked[0]?.id ?? -1;
  session.approve(approvalId);
  const value = await pending;
  const after = session.snapshot();
  check('an ask-mode capture action waits in the approval queue, runs on approve and logs one decision',
    queued && value === 'done' && after.approvals.length === 0 && after.log.length === 1 &&
    after.log[0]!.decision === 'allowed' && after.log[0]!.id !== approvalId,
    `queued=${queued}, value=${value}, approvals=${after.approvals.length}, ` +
    `log=${JSON.stringify(after.log)}`);
}

{
  const session = new AgentSession();
  const pending = session.guardAsync('stop', 'Stop the capture', async () => 'ran');
  const id = session.snapshot().approvals[0]?.id ?? -1;
  session.deny(id);
  const denied = await rejects(pending);
  const after = session.snapshot();
  check('denying an ask-mode action rejects the agent call without running it',
    denied && after.approvals.length === 0 && after.log.length === 1 &&
    after.log[0]!.decision === 'denied',
    `denied=${denied}, log=${JSON.stringify(after.log)}`);
}

{
  const session = new AgentSession();
  const realSetTimeout = globalThis.setTimeout;
  let fire: (() => void) | null = null;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void) => {
    fire = () => fn();
    return realSetTimeout(() => {}, 2_147_483_647);
  }) as unknown as typeof setTimeout;
  const pending = (() => {
    try {
      return session.guardAsync('attach', 'Attach a decoder', async () => 'ran');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  })();
  const queued = session.snapshot().approvals.length === 1;
  fire!();
  const timedOut = await rejects(pending);
  const after = session.snapshot();
  check('an unanswered approval times out as a denial after the documented window',
    AGENT_APPROVAL_TIMEOUT_MS === 60_000 && queued && timedOut &&
    after.approvals.length === 0 && after.log.length === 1 &&
    after.log[0]!.decision === 'timeout',
    `window=${AGENT_APPROVAL_TIMEOUT_MS}, queued=${queued}, timedOut=${timedOut}, ` +
    `log=${JSON.stringify(after.log)}`);
}

{
  const session = new AgentSession();
  session.setMode('allow');
  for (let i = 0; i < 30; i += 1) session.guardSync(`tool${i}`, () => i);
  const log = session.snapshot().log;
  const capped = log.length === 24 && log[0]!.tool === 'tool29' &&
    log[23]!.tool === 'tool6';
  const ids = new Set(log.map((entry) => entry.id));
  session.clearLog();
  const cleared = session.snapshot().log.length === 0;
  check('the activity log keeps the newest twenty-four entries, newest first, with unique ids and clears on demand',
    capped && ids.size === log.length && cleared,
    `length=${log.length}, newest=${log[0]?.tool}, oldest=${log[23]?.tool}, ` +
    `unique=${ids.size === log.length}, cleared=${cleared}`);
}

// ------------------------------------------------------------- shipped wiring

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const settings = fs.readFileSync('src/ui/settingsDialog.ts', 'utf8');
  const menu = fs.readFileSync('src/ui/agentPanel.ts', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  const guarded = [
    "setChannelWidth: (channels) => sync('setChannelWidth'",
    "applySettings: (patch, enabled) => sync('applySettings'",
    "act('startAndWait', t('agent.actionStart'",
    "act('stop', t('agent.actionStop'",
    "act('attach', `${t('agent.actionAttach')} (${id})`",
    "sync('removeAnalyzer'",
    "sync('addBus'",
    "sync('updateBus'",
    "sync('removeBus'",
  ];
  const missingGuards = guarded.filter((needle) => !app.includes(needle));
  const wired = app.includes('agentHost: () => this.gatedAgentHost(),') &&
    app.includes('agentHello: (name: string) => agentSession.hello(name),') &&
    app.includes('agentPing: () => agentSession.ping(),') &&
    app.includes("import { AgentMenu } from './agentPanel.js';") &&
    app.includes("new AgentMenu(this.el.agent, 'agent-menu')") &&
    app.includes('this.menuStack.register(this.agentMenu)') &&
    app.includes("this.menuStack.closeOthers(this.agentMenu, 'outside')") &&
    app.includes('this.agentMenu.toggle()') &&
    app.includes('agentSession.subscribe(() => this.syncAgentBadge())') &&
    !settings.includes('agentPanel') &&
    menu.includes('export class AgentMenu implements ExclusiveMenu') &&
    menu.includes("menu.className = 'settings-menu agent-menu'") &&
    menu.includes('settingsMenuRight(rect.right, menuWidth, window.innerWidth)') &&
    menu.includes('agentSession.subscribe(paint)') &&
    menu.includes('window.setInterval(paint, 1000)') &&
    menu.includes("import skillMarkdown from '../../.claude/skills/slogicweb/SKILL.md?raw';") &&
    menu.includes('agent.setupTitle') &&
    menu.includes('agent.downloadSkill') &&
    menu.includes('settings-agent-steps') &&
    menu.includes('agent.askPrompt') &&
    html.includes('id="btn-agent"') &&
    html.includes('aria-controls="agent-menu"') &&
    html.includes('aria-expanded="false"');
  check('every mutating host action is gated, the debug surface introduces the agent, and the toolbar opens a right-aligned dropdown',
    missingGuards.length === 0 && wired,
    `missing=${JSON.stringify(missingGuards)}, wired=${wired}`);
}

const failed = results.filter((result) => !result.pass).length;
console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}` +
  `${result.pass || !result.detail ? '' : `\n        ${result.detail}`}`,
).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
