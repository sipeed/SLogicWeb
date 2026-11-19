// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The Agent connection dropdown, anchored to the toolbar Agent button.
 *
 * This is not a chat: it is the visible half of the external-agent bridge. It shows the
 * last agent that called `debug.agentHello`/`agentHost`, the action-permission mode, the
 * approval queue for capture/decoder actions, and a short audit log. The app never asks
 * for a provider key. Shape and lifecycle mirror the Language/Theme menus: the panel
 * exists only while open, is right-aligned under the anchor, and Escape/outside/resize
 * close it.
 */

import { button, div } from './capturePanel.js';
import { t } from './i18n.js';
import {
  settingsMenuRight, type CloseReason,
} from './settingsMenu.js';
import type { ExclusiveMenu } from './menuStack.js';
import { selectControl } from './select.js';
import {
  agentSession, type AgentDecision, type AgentMode, type AgentSnapshot,
} from './agentSession.js';

const DECISION_LABEL_KEYS: Record<AgentDecision, Parameters<typeof t>[0]> = {
  allowed: 'agent.allowed',
  auto: 'agent.auto',
  denied: 'agent.denied',
  timeout: 'agent.timeout',
};

function modeOf(value: string): AgentMode {
  return value === 'allow' || value === 'read-only' ? value : 'ask';
}

function statusText(view: AgentSnapshot): string {
  if (!view.connected) return t('agent.statusWaiting');
  return t('agent.statusConnected', { name: view.name ?? t('agent.unnamed') });
}

function timeText(at: number): string {
  const date = new Date(at);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function emptyLog(): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'settings-agent-log-empty';
  item.textContent = t('agent.logEmpty');
  return item;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    area.remove();
    return copied;
  }
}

function codeBlock(text: string): HTMLElement {
  const code = document.createElement('code');
  code.className = 'settings-agent-code';
  code.textContent = text;
  return code;
}

function copyButton(label: string, text: string): HTMLButtonElement {
  const action = button(label, 'mini settings-agent-copy-action');
  action.type = 'button';
  action.addEventListener('click', () => {
    void copyText(text).then((copied) => {
      if (!copied) return;
      action.textContent = t('agent.copied');
      setTimeout(() => { action.textContent = label; }, 1500);
    });
  });
  return action;
}

function launchCommand(pageUrl: string): string {
  const platform = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform ?? navigator.platform;
  const name = platform.toLowerCase();
  if (name.includes('mac')) {
    return `open -na "Google Chrome" --args --remote-debugging-port=9222 ${pageUrl}`;
  }
  if (name.includes('win')) {
    return `"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 ${pageUrl}`;
  }
  return `google-chrome --remote-debugging-port=9222 ${pageUrl}`;
}

function setupSection(pageUrl: string): HTMLElement {
  const setup = document.createElement('section');
  setup.className = 'settings-agent-setup';
  const head = div('settings-agent-setup-head');
  const toggle = button(t('agent.setupTitle'), 'settings-agent-toggle');
  toggle.type = 'button';
  const body = div('settings-agent-setup-body');
  body.id = 'agent-setup-body';
  body.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', body.id);
  toggle.addEventListener('click', () => {
    const opening = body.hidden;
    body.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
  });
  const intro = document.createElement('p');
  intro.className = 'settings-agent-help';
  intro.textContent = t('agent.howTo');
  const prompt = t('agent.askPrompt', {
    origin: pageUrl,
    launch: launchCommand(pageUrl),
  });
  const code = codeBlock(prompt);
  code.classList.add('settings-agent-prompt');
  body.append(intro, code);
  head.append(toggle, copyButton(t('agent.copyPrompt'), prompt));
  setup.append(head, body);
  return setup;
}

export class AgentMenu implements ExclusiveMenu {
  private menu: HTMLDivElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer = 0;

  constructor(
    private readonly anchor: HTMLButtonElement,
    private readonly menuId: string,
  ) {}

  get id(): string { return this.menuId; }

  get isOpen(): boolean { return this.menu !== null; }

  toggle(): void {
    if (this.menu) this.close('toggle');
    else this.open();
  }

  open(): void {
    if (this.menu) this.close('toggle');
    const menu = document.createElement('div');
    menu.className = 'settings-menu agent-menu';
    menu.id = this.menuId;
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', t('agent.title'));

    const root = div('settings-agent');
    root.dataset.agentPanel = '';
    const title = document.createElement('h3');
    title.className = 'settings-agent-title';
    title.textContent = t('agent.title');

    const statusRow = div('settings-agent-status-row');
    const dot = document.createElement('span');
    dot.className = 'settings-agent-dot';
    const status = document.createElement('span');
    status.className = 'settings-agent-status';
    statusRow.append(dot, status);

    const mode = selectControl('agent.mode', t('agent.mode'), [
      ['ask', t('agent.modeAsk')],
      ['allow', t('agent.modeAllow')],
      ['read-only', t('agent.modeReadOnly')],
    ], agentSession.snapshot().mode);
    mode.el.classList.add('settings-agent-mode');
    mode.addEventListener('change', () => agentSession.setMode(modeOf(mode.value)));

    const pendingTitle = document.createElement('h4');
    pendingTitle.className = 'settings-agent-subtitle';
    pendingTitle.textContent = t('agent.pending');
    const pending = div('settings-agent-pending');

    const logHead = div('settings-agent-log-head');
    const logTitle = document.createElement('h4');
    logTitle.className = 'settings-agent-subtitle';
    logTitle.textContent = t('agent.log');
    const clear = button(t('agent.clear'), 'mini settings-agent-clear');
    clear.addEventListener('click', () => agentSession.clearLog());
    logHead.append(logTitle, clear);
    const log = document.createElement('ul');
    log.className = 'settings-agent-log';

    const pageUrl = location.href.split('#')[0] ?? location.href;
    const setup = setupSection(pageUrl);

    root.append(title, statusRow, mode.el, pendingTitle, pending, logHead, log, setup);
    menu.appendChild(root);
    document.body.appendChild(menu);

    const rect = this.anchor.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.right = `${Math.round(settingsMenuRight(rect.right, menuWidth, window.innerWidth))}px`;

    const paint = (): void => {
      const view = agentSession.snapshot();
      dot.classList.toggle('on', view.connected);
      status.textContent = statusText(view);
      setup.hidden = view.connected;
      pendingTitle.hidden = view.approvals.length === 0;
      logHead.hidden = view.log.length === 0;
      log.hidden = view.log.length === 0;
      pending.replaceChildren(...view.approvals.map((approval) => {
        const row = div('settings-agent-approval');
        const text = document.createElement('span');
        text.className = 'settings-agent-approval-text';
        text.textContent = `${approval.tool} — ${approval.summary}`;
        const actions = div('settings-agent-approval-actions');
        const yes = button(t('agent.approve'), 'mini settings-agent-approve');
        yes.addEventListener('click', () => agentSession.approve(approval.id));
        const no = button(t('agent.deny'), 'mini settings-agent-deny');
        no.addEventListener('click', () => agentSession.deny(approval.id));
        actions.append(yes, no);
        row.append(text, actions);
        return row;
      }));
      const rows = view.log.map((entry) => {
        const row = document.createElement('li');
        row.className = 'settings-agent-log-row';
        const time = document.createElement('span');
        time.className = 'settings-agent-log-time';
        time.textContent = timeText(entry.at);
        const tool = document.createElement('span');
        tool.className = 'settings-agent-log-tool';
        tool.textContent = entry.tool;
        const decision = document.createElement('span');
        decision.className = `settings-agent-log-decision ${entry.decision}`;
        decision.textContent = t(DECISION_LABEL_KEYS[entry.decision]);
        row.append(time, tool, decision);
        return row;
      });
      log.replaceChildren(...(rows.length > 0 ? rows : [emptyLog()]));
    };

    this.menu = menu;
    this.unsubscribe = agentSession.subscribe(paint);
    this.timer = window.setInterval(paint, 1000);
    paint();
    this.anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    menu.querySelector<HTMLElement>('button')?.focus();
  }

  close(reason: CloseReason): void {
    const menu = this.menu;
    if (!menu) return;
    this.menu = null;
    if (this.timer !== 0) window.clearInterval(this.timer);
    this.timer = 0;
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    this.anchor.setAttribute('aria-expanded', 'false');
    menu.remove();
    if (reason === 'escape' || reason === 'pick') this.anchor.focus();
  }

  private readonly onOutsidePointerDown = (event: PointerEvent): void => {
    if (this.menu?.contains(event.target as Node) || this.anchor.contains(event.target as Node)) return;
    this.close('outside');
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    this.close('escape');
    event.stopPropagation();
  };

  private readonly onResize = (): void => {
    this.close('resize');
  };
}
