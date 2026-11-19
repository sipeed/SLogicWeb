// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The external-AI-agent session behind the Agent connection panel.
 *
 * The app never holds a provider key. An agent reaches the page over CDP (the repository
 * `slogicweb` Skill) and calls `window.slogicweb.debug.agentHello()` / `agentPing()` and
 * the `agentHost()` methods. This module records that connection, asks the user before
 * capture/decoder actions, and keeps a short audit log for the Settings > Developer panel.
 *
 * The gate is a UX safety rail, not a security boundary: a CDP client can already run
 * JavaScript in the page. Read-only mode is therefore honest about what it can enforce
 * inside the app, and the log makes every action visible.
 */

export type AgentMode = 'ask' | 'allow' | 'read-only';
export type AgentDecision = 'allowed' | 'denied' | 'auto' | 'timeout';

export interface AgentApprovalView {
  readonly id: number;
  readonly tool: string;
  readonly summary: string;
}

export interface AgentLogView {
  readonly id: number;
  readonly at: number;
  readonly tool: string;
  readonly decision: AgentDecision;
}

export interface AgentSnapshot {
  readonly name: string | null;
  readonly connected: boolean;
  readonly lastSeen: number;
  readonly mode: AgentMode;
  readonly approvals: readonly AgentApprovalView[];
  readonly log: readonly AgentLogView[];
}

type Listener = () => void;

interface Approval {
  readonly view: AgentApprovalView;
  readonly settle: (allowed: boolean, decision: AgentDecision) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export const AGENT_MODE_KEY = 'slogicweb.agent.mode';
export const AGENT_APPROVAL_TIMEOUT_MS = 60_000;
export const AGENT_STALE_MS = 20_000;
const LOG_CAP = 24;

/** A tiny storage helper: private mode and node tests must not throw. */
function storedMode(): AgentMode | null {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(AGENT_MODE_KEY);
    return value === 'ask' || value === 'allow' || value === 'read-only' ? value : null;
  } catch {
    return null;
  }
}

function persistMode(mode: AgentMode): void {
  try {
    localStorage.setItem(AGENT_MODE_KEY, mode);
  } catch {
    // Storage blocked: the mode still applies to this page.
  }
}

export class AgentSession {
  private name: string | null = null;
  private lastSeen = 0;
  private mode: AgentMode = storedMode() ?? 'ask';
  private nextId = 1;
  private readonly approvals = new Map<number, Approval>();
  private entries: AgentLogView[] = [];
  private readonly listeners = new Set<Listener>();

  /** The agent introduces itself. Calling this is the reliable "connected" signal. */
  hello(name: string): void {
    const trimmed = name.trim().slice(0, 80);
    this.name = trimmed === '' ? 'Agent' : trimmed;
    this.lastSeen = Date.now();
    this.notify();
  }

  /** A cheap heartbeat; a tool call also touches the session. */
  ping(): void {
    const was = this.connected();
    this.lastSeen = Date.now();
    if (!was) this.notify();
  }

  /** Any tool call, including a read, proves the agent is still there. */
  touch(): void {
    this.lastSeen = Date.now();
  }

  connected(): boolean {
    return this.lastSeen > 0 && Date.now() - this.lastSeen < AGENT_STALE_MS;
  }

  setMode(mode: AgentMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    persistMode(mode);
    // Switching to read-only or allow resolves nothing already asked for: an explicit
    // decision is still the user's, and the queue is visible in the panel.
    this.notify();
  }

  /**
   * Gate a long-running action (start/stop/attach). In `ask` mode the caller waits for
   * the panel's Approve/Deny; a 60 s silence is a deny, so an abandoned request cannot
   * hang the agent forever.
   */
  async guardAsync<T>(tool: string, summary: string, run: () => Promise<T>): Promise<T> {
    this.touch();
    if (this.mode === 'read-only') {
      this.record(tool, 'denied');
      throw new Error(`Agent action denied (read-only): ${tool}`);
    }
    if (this.mode === 'allow') {
      this.record(tool, 'allowed');
      return run();
    }
    const allowed = await this.ask(tool, summary);
    if (!allowed) throw new Error(`Agent action denied: ${tool}`);
    return run();
  }

  /**
   * Gate a synchronous action (a settings/bus/decoder edit). `ask` cannot pause a sync
   * call, so those edits run and are logged as automatic; read-only refuses them and
   * allow lets them through. The panel says which actions get a prompt.
   */
  guardSync<T>(tool: string, run: () => T): T {
    this.touch();
    if (this.mode === 'read-only') {
      this.record(tool, 'denied');
      throw new Error(`Agent action denied (read-only): ${tool}`);
    }
    this.record(tool, this.mode === 'allow' ? 'allowed' : 'auto');
    return run();
  }

  approve(id: number): void {
    this.settle(id, true, 'allowed');
  }

  deny(id: number): void {
    this.settle(id, false, 'denied');
  }

  clearLog(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.notify();
  }

  snapshot(): AgentSnapshot {
    return {
      name: this.name,
      connected: this.connected(),
      lastSeen: this.lastSeen,
      mode: this.mode,
      approvals: [...this.approvals.values()].map((entry) => entry.view),
      log: [...this.entries],
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private ask(tool: string, summary: string): Promise<boolean> {
    const id = this.nextId++;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false, 'timeout'),
        AGENT_APPROVAL_TIMEOUT_MS);
      // Node self-tests own the timer; do not keep their event loop alive.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.approvals.set(id, {
        view: { id, tool, summary },
        settle: (allowed, decision) => {
          resolve(allowed);
          this.record(tool, decision);
        },
        timer,
      });
      this.notify();
    });
  }

  private settle(id: number, allowed: boolean, decision: AgentDecision): void {
    const entry = this.approvals.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.approvals.delete(id);
    entry.settle(allowed, decision);
    this.notify();
  }

  private record(tool: string, decision: AgentDecision): void {
    const entry: AgentLogView = { id: this.nextId++, at: Date.now(), tool, decision };
    this.entries = [entry, ...this.entries].slice(0, LOG_CAP);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The one session for the page; the debug surface and the panel share it. */
export const agentSession = new AgentSession();
