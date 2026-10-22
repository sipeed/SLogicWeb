// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The AI assistant sidebar: settings, the privacy notice, the conversation and the
 * approval cards for tools that change the capture.
 *
 * Unlike the device and analyzer panels this one is not clear-and-rebuild. App mounts it
 * once and only toggles `hidden`, because it owns state a rebuild would destroy: the
 * conversation log, a streaming answer, a pending approval and the draft message.
 * `render()` rebuilds only the chrome (header, settings, notice, composer labels) - on a
 * locale change, for instance - and leaves the log alone; past messages are history and
 * do not retranslate, like the USB console's scrollback.
 *
 * Assistant text is shown as plain text (never innerHTML): it is model output.
 */

import { Conversation, type LoopEvent } from '../assistant/loop.js';
import { createOpenAIProvider } from '../assistant/providers/openai.js';
import {
  activeProvider, CLAUDE_MODELS, getAssistantSettings, OPENAI_PRESETS, redactKey,
  setAssistantSettings, type AssistantSettings, type ProviderId,
} from '../assistant/settings.js';
import { SYSTEM_PROMPT } from '../assistant/systemPrompt.js';
import { toolSpecs, type AssistantHost, type AssistantTool } from '../assistant/tools.js';
import type { Provider, ProviderConfig, ToolCall } from '../assistant/types.js';
import { button, div, labelled } from './capturePanel.js';
import { t, type MessageKey } from './i18n.js';
import { renderMarkdown } from './markdown.js';
import { selectControl, type SelectOptionTuple } from './select.js';

interface ToolCard { el: HTMLDivElement; status: HTMLSpanElement; body: HTMLDivElement }

export class AssistantPanel {
  readonly el: HTMLDivElement;
  private readonly chrome: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly composer: HTMLDivElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;

  private settingsOpen = false;
  private conversation: Conversation | null = null;
  /** The provider configuration the current conversation was started with. */
  private conversationKey = '';
  private abort: AbortController | null = null;
  /** "Allow all this session" was chosen. Cleared by New chat. */
  private allowAll = false;

  // The assistant message being streamed. Raw Markdown accumulates here and is
  // re-rendered at most once per frame (paint), not once per token.
  private bubble: HTMLDivElement | null = null;
  private bubbleBody: HTMLDivElement | null = null;
  private bubbleRaw = '';
  private thinkingBody: HTMLDivElement | null = null;
  private thinkingRaw = '';
  private paintQueued = false;
  private readonly cards = new Map<string, ToolCard>();

  constructor(private readonly host: AssistantHost) {
    this.el = div('assistant-panel');
    this.el.hidden = true;
    this.chrome = div('assistant-chrome');
    this.log = div('assistant-log');
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-live', 'polite');
    this.composer = div('assistant-composer');
    this.input = document.createElement('textarea');
    this.input.rows = 3;
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.sendBtn = button('', 'pill primary');
    this.sendBtn.addEventListener('click', () => {
      if (this.abort) this.abort.abort(); else void this.send();
    });
    this.composer.append(this.input, this.sendBtn);
    this.el.append(this.chrome, this.log, this.composer);
  }

  /** Put the caret in the message box, unless the privacy notice still blocks it. */
  focusInput(): void {
    if (!this.input.disabled) this.input.focus({ preventScroll: true });
  }

  /** Rebuild the chrome in the current locale and settings. The log is untouched. */
  render(): void {
    const s = getAssistantSettings();
    this.chrome.replaceChildren(this.header(s));
    if (this.settingsOpen) this.chrome.appendChild(this.settingsForm(s));
    if (!s.noticeAccepted) this.chrome.appendChild(this.notice());
    if (this.log.childElementCount === 0) this.log.appendChild(this.emptyState());
    this.input.placeholder = t('assistant.placeholder');
    this.renderComposer();
  }

  private renderComposer(): void {
    const busy = this.abort !== null;
    this.sendBtn.textContent = busy ? t('assistant.stop') : t('assistant.send');
    this.sendBtn.classList.toggle('danger', busy);
    this.sendBtn.classList.toggle('primary', !busy);
    this.input.disabled = !getAssistantSettings().noticeAccepted;
  }

  // ---------------------------------------------------------------- chrome

  /** One compact row: title, then a gear (settings) and New at its end. */
  private header(s: AssistantSettings): HTMLDivElement {
    const head = div('panel-head assistant-head');
    const row = div('assistant-title-row');
    const title = div('panel-title');
    title.textContent = t('assistant.title');
    const settings = iconButton(`analyzer-act assistant-act${this.settingsOpen ? ' on' : ''}`,
      t('assistant.settings'), GEAR_PATHS);
    settings.setAttribute('aria-expanded', String(this.settingsOpen));
    settings.addEventListener('click', () => { this.settingsOpen = !this.settingsOpen; this.render(); });
    const fresh = button(t('assistant.new'), 'mini assistant-new');
    fresh.title = t('assistant.newChat');
    fresh.addEventListener('click', () => this.newChat());
    row.append(title, settings, fresh);
    const p = activeProvider(s);
    const sub = div('panel-sub');
    sub.textContent = `${s.provider === 'claude' ? t('assistant.providerClaude') : t('assistant.providerOpenai')}` +
      ` · ${p.model || '—'}${p.official ? '' : ` · ${hostOf(p.baseURL)}`}`;
    head.append(row, sub);
    return head;
  }

  private settingsForm(s: AssistantSettings): HTMLDivElement {
    const form = div('panel-section assistant-settings');
    const body = div('panel-section-body');
    const save = (next: AssistantSettings): void => { setAssistantSettings(next); this.render(); };

    const seg = div('segmented');
    for (const id of ['claude', 'openai'] as ProviderId[]) {
      const b = button(id === 'claude' ? t('assistant.providerClaude') : t('assistant.providerOpenai'),
        `seg${s.provider === id ? ' on' : ''}`);
      b.addEventListener('click', () => save({ ...s, provider: id }));
      seg.appendChild(b);
    }
    body.appendChild(labelled(t('assistant.provider'), seg));

    const p = s[s.provider];
    const update = (field: 'baseURL' | 'apiKey' | 'model', value: string): void => {
      const next = getAssistantSettings();
      next[next.provider] = { ...next[next.provider], [field]: value.trim() };
      setAssistantSettings(next);
      // Only the header summary changes; keep focus in the field being typed into.
      this.chrome.firstElementChild?.replaceWith(this.header(next));
    };

    if (s.provider === 'openai') {
      const options: SelectOptionTuple[] = [
        ['', t('assistant.presetCustom')],
        ...OPENAI_PRESETS.map((x): SelectOptionTuple => [x.baseURL, x.label]),
      ];
      const current = OPENAI_PRESETS.some((x) => x.baseURL === p.baseURL) ? p.baseURL : '';
      const preset = selectControl('assistant.preset', t('assistant.preset'), options, current);
      preset.addEventListener('change', () => {
        if (!preset.value) return;
        const next = getAssistantSettings();
        next.openai = { ...next.openai, baseURL: preset.value };
        save(next);
      });
      body.appendChild(preset.el);
    }

    const url = field('url', p.baseURL, s.provider === 'claude' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
    url.addEventListener('change', () => update('baseURL', url.value));
    body.appendChild(labelled(t('assistant.baseUrl'), url));

    const key = field('password', p.apiKey, s.provider === 'claude' ? 'sk-ant-…' : 'sk-…');
    key.autocomplete = 'off';
    key.addEventListener('change', () => update('apiKey', key.value));
    body.appendChild(labelled(t('assistant.apiKey'), key));

    const model = field('text', p.model, s.provider === 'claude' ? CLAUDE_MODELS[0] : t('assistant.modelPlaceholder'));
    if (s.provider === 'claude') {
      const list = document.createElement('datalist');
      list.id = 'assistant-claude-models';
      for (const m of CLAUDE_MODELS) list.appendChild(new Option(m, m));
      model.setAttribute('list', list.id);
      body.appendChild(list);
    }
    model.addEventListener('change', () => update('model', model.value));
    body.appendChild(labelled(t('assistant.model'), model));

    const remember = document.createElement('label');
    remember.className = 'assistant-check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = s.rememberKey;
    box.addEventListener('change', () => save({ ...getAssistantSettings(), rememberKey: box.checked }));
    remember.append(box, document.createTextNode(t('assistant.rememberKey')));
    body.appendChild(remember);

    for (const k of ['assistant.keyHint', 'assistant.baseUrlHint'] as MessageKey[]) {
      const note = div('panel-note');
      note.textContent = t(k);
      body.appendChild(note);
    }
    form.appendChild(body);
    return form;
  }

  private notice(): HTMLDivElement {
    const box = div('panel-section assistant-notice');
    const head = div('panel-section-head');
    head.textContent = t('assistant.noticeTitle');
    const text = div('panel-note');
    text.textContent = t('assistant.notice');
    const ok = button(t('assistant.noticeAccept'), 'pill primary');
    ok.addEventListener('click', () => {
      setAssistantSettings({ ...getAssistantSettings(), noticeAccepted: true });
      this.render();
      this.input.focus();
    });
    box.append(head, text, ok);
    return box;
  }

  private emptyState(): HTMLDivElement {
    const box = div('assistant-empty');
    const p = div('panel-note');
    p.textContent = t('assistant.empty');
    box.appendChild(p);
    for (const k of ['assistant.suggest1', 'assistant.suggest2', 'assistant.suggest3'] as MessageKey[]) {
      const chip = button(t(k), 'assistant-suggestion');
      chip.addEventListener('click', () => { this.input.value = t(k); this.input.focus(); });
      box.appendChild(chip);
    }
    return box;
  }

  // ---------------------------------------------------------------- conversation

  private newChat(): void {
    this.abort?.abort();
    this.conversation = null;
    this.conversationKey = '';
    this.allowAll = false;
    this.cards.clear();
    this.endBubble();
    this.log.replaceChildren();
    this.render();
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.abort) return;
    const s = getAssistantSettings();
    if (!s.noticeAccepted) return;
    const p = activeProvider(s);
    if (!p.apiKey || !p.model) {
      this.settingsOpen = true;
      this.render();
      this.note(t(p.apiKey ? 'assistant.needModel' : 'assistant.needKey'), 'error');
      return;
    }

    const key = JSON.stringify([p.id, p.baseURL, p.model, p.apiKey]);
    if (this.conversation && key !== this.conversationKey) {
      this.note(t('assistant.newConversation'), 'muted');
      this.conversation = null;
    }
    this.log.querySelector('.assistant-empty')?.remove();
    this.input.value = '';
    this.message('user', text);

    const abort = new AbortController();
    this.abort = abort;
    this.renderComposer();
    try {
      if (!this.conversation) {
        const cfg: ProviderConfig = {
          apiKey: p.apiKey, baseURL: p.baseURL, model: p.model, official: p.official,
          system: SYSTEM_PROMPT, tools: toolSpecs(),
        };
        let provider: Provider;
        if (p.id === 'claude') {
          try {
            const { createClaudeProvider } = await import('../assistant/providers/claude.js');
            provider = createClaudeProvider(cfg);
          } catch (e) {
            this.note(`${t('assistant.error.load')} ${e instanceof Error ? e.message : String(e)}`, 'error');
            return;
          }
        } else {
          provider = createOpenAIProvider(cfg);
        }
        this.conversation = new Conversation(
          provider, this.host, (call, tool, signal) => this.approve(call, tool, signal),
          (e) => this.onEvent(e, p.apiKey, p.baseURL));
        this.conversationKey = key;
      }
      await this.conversation.send(text, abort.signal);
    } finally {
      this.endBubble();
      this.abort = null;
      this.renderComposer();
    }
  }

  private onEvent(e: LoopEvent, apiKey: string, baseURL: string): void {
    switch (e.type) {
      case 'turn':
        this.endBubble();
        break;
      case 'text':
        this.ensureBubble();
        this.bubbleRaw += e.delta;
        this.schedulePaint();
        break;
      case 'thinking': {
        this.ensureBubble();
        if (!this.thinkingBody) {
          const details = document.createElement('details');
          details.className = 'assistant-thinking';
          const summary = document.createElement('summary');
          summary.textContent = t('assistant.thinking');
          this.thinkingBody = div('assistant-thinking-text md');
          details.append(summary, this.thinkingBody);
          this.bubble!.insertBefore(details, this.bubble!.firstChild);
        }
        this.thinkingRaw += e.delta;
        this.schedulePaint();
        break;
      }
      case 'tool-call':
        this.endBubble();
        this.toolCard(e.call);
        break;
      case 'tool-result': {
        const card = this.cards.get(e.id);
        if (!card) break;
        const state = e.declined ? 'declined' : e.isError ? 'error' : 'done';
        card.el.dataset.state = state;
        card.status.textContent = t(state === 'declined' ? 'assistant.toolDeclined'
          : state === 'error' ? 'assistant.toolError' : 'assistant.toolDone');
        card.body.querySelector('.assistant-approve')?.remove();
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = t('assistant.result');
        const pre = document.createElement('pre');
        pre.textContent = redactKey(e.content, apiKey);
        details.append(summary, pre);
        if (e.isError && !e.declined) details.open = true;
        card.body.appendChild(details);
        break;
      }
      case 'stopped':
        this.endBubble();
        if (e.reason !== 'end') {
          this.note(t(`assistant.stopped.${e.reason}` as MessageKey,
            { detail: e.detail ? ` (${e.detail})` : '' }), e.reason === 'aborted' ? 'muted' : 'error');
        }
        break;
      case 'error': {
        this.endBubble();
        const { kind, status, message } = e.error;
        if (kind === 'aborted') { this.note(t('assistant.stopped.aborted'), 'muted'); break; }
        const head = t(`assistant.error.${kind}` as MessageKey, { status: status ?? '', url: baseURL });
        this.note(`${head}\n${redactKey(message, apiKey)}`, 'error');
        break;
      }
    }
    this.scroll();
  }

  /** The approval gate for `act` tools: the card grows Allow / Deny / Allow all. */
  private approve(call: ToolCall, _tool: AssistantTool, signal: AbortSignal): Promise<boolean> {
    if (this.allowAll) return Promise.resolve(true);
    const card = this.cards.get(call.id);
    if (!card) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const row = div('assistant-approve');
      const ask = div('panel-note');
      ask.textContent = t('assistant.approveTitle');
      const allow = button(t('assistant.allow'), 'pill primary');
      const deny = button(t('assistant.deny'), 'pill');
      const all = button(t('assistant.allowAlways'), 'pill');
      const finish = (ok: boolean): void => {
        signal.removeEventListener('abort', onAbort);
        row.remove();
        resolve(ok);
      };
      const onAbort = (): void => finish(false);
      allow.addEventListener('click', () => finish(true));
      deny.addEventListener('click', () => finish(false));
      all.addEventListener('click', () => { this.allowAll = true; finish(true); });
      signal.addEventListener('abort', onAbort, { once: true });
      row.append(ask, allow, deny, all);
      card.el.dataset.state = 'pending';
      card.status.textContent = t('assistant.toolPending');
      card.body.appendChild(row);
      this.scroll(true);
      allow.focus({ preventScroll: true });
    });
  }

  // ---------------------------------------------------------------- log nodes

  private message(role: 'user' | 'assistant', text: string): HTMLDivElement {
    const m = div(`assistant-msg ${role}`);
    m.textContent = text;
    this.log.appendChild(m);
    this.scroll(true);
    return m;
  }

  private ensureBubble(): void {
    if (this.bubble) return;
    this.bubble = this.message('assistant', '');
    this.bubbleBody = div('assistant-text md');
    this.bubble.appendChild(this.bubbleBody);
  }

  private schedulePaint(): void {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => this.paint());
  }

  /** Re-render the streaming message from its accumulated Markdown. */
  private paint(): void {
    this.paintQueued = false;
    this.bubbleBody?.replaceChildren(renderMarkdown(this.bubbleRaw));
    this.thinkingBody?.replaceChildren(renderMarkdown(this.thinkingRaw));
    this.scroll();
  }

  private endBubble(): void {
    // Flush now: a frame may still be pending, and the next turn reuses the fields.
    if (this.bubble) this.paint();
    if (this.bubble && !this.bubbleRaw && !this.thinkingRaw) this.bubble.remove();
    this.bubble = null;
    this.bubbleBody = null;
    this.bubbleRaw = '';
    this.thinkingBody = null;
    this.thinkingRaw = '';
  }

  private toolCard(call: ToolCall): void {
    const el = div('assistant-tool');
    el.dataset.state = 'running';
    const head = div('assistant-tool-head');
    const name = document.createElement('code');
    name.textContent = call.name;
    const status = document.createElement('span');
    status.className = 'assistant-tool-status';
    status.textContent = t('assistant.toolRunning');
    head.append(name, status);
    const body = div('assistant-tool-body');
    const args = JSON.stringify(call.input);
    if (args && args !== '{}') {
      const pre = document.createElement('pre');
      pre.className = 'assistant-tool-args';
      pre.textContent = args;
      body.appendChild(pre);
    }
    el.append(head, body);
    this.log.appendChild(el);
    this.cards.set(call.id, { el, status, body });
  }

  private note(text: string, kind: 'error' | 'muted'): void {
    const n = div(`assistant-note ${kind}`);
    n.textContent = text;
    this.log.appendChild(n);
    this.scroll(true);
  }

  /** Follow new content only when the reader is already at the bottom. */
  private scroll(force = false): void {
    const l = this.log;
    if (force || l.scrollHeight - l.scrollTop - l.clientHeight < 80) l.scrollTop = l.scrollHeight;
  }
}

/** The gear the channel cards use (channelList.ts), for the settings toggle. */
const GEAR_PATHS = [
  'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
  'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
];

function iconButton(cls: string, label: string, paths: readonly string[]): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.title = label;
  b.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }
  b.appendChild(svg);
  return b;
}

function field(type: 'url' | 'password' | 'text', value: string, placeholder: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  i.placeholder = placeholder;
  i.spellcheck = false;
  return i;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
