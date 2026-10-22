// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Assistant preferences: which provider, where to reach it, and the user's own API key.
 *
 * Same shape as theme.ts / panelWidth.ts - guarded storage, module state, a listener set,
 * an init*() called from main.ts. The API key is the one value that is not simply
 * persisted: unless the user ticks "remember", it lives in sessionStorage only, so it
 * survives a reload but not closing the tab. It is never written anywhere else - not into
 * a capture file, a log line or an error message (see redactKey).
 */

export type ProviderId = 'claude' | 'openai';

export interface ProviderSettings {
  /** Empty means the provider's official endpoint. */
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface AssistantSettings {
  provider: ProviderId;
  claude: ProviderSettings;
  openai: ProviderSettings;
  /** Persist API keys in localStorage instead of sessionStorage. */
  rememberKey: boolean;
  /** The user has read the "your data goes to the provider" notice. */
  noticeAccepted: boolean;
}

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export const CLAUDE_OFFICIAL_URL = 'https://api.anthropic.com';
export const OPENAI_OFFICIAL_URL = 'https://api.openai.com/v1';

/**
 * Base URL starting points for OpenAI-compatible providers. Only the endpoint is
 * prefilled: model names change too often to hard-code, so the field stays the user's.
 */
export const OPENAI_PRESETS: readonly { id: string; label: string; baseURL: string }[] = [
  { id: 'openai', label: 'OpenAI', baseURL: OPENAI_OFFICIAL_URL },
  { id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1' },
  { id: 'qwen', label: 'Qwen (DashScope)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'moonshot', label: 'Kimi (Moonshot)', baseURL: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', label: 'GLM (Zhipu)', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
];

export const DEFAULT_SETTINGS: AssistantSettings = {
  provider: 'claude',
  claude: { baseURL: '', apiKey: '', model: CLAUDE_MODELS[0] },
  openai: { baseURL: '', apiKey: '', model: '' },
  rememberKey: false,
  noticeAccepted: false,
};

export const SETTINGS_KEY = 'logicweb.assistant';
export const KEYS_KEY = 'logicweb.assistant.keys';

let current: AssistantSettings = clone(DEFAULT_SETTINGS);
const listeners = new Set<() => void>();

function clone(s: AssistantSettings): AssistantSettings {
  return { ...s, claude: { ...s.claude }, openai: { ...s.openai } };
}

function store(kind: 'local' | 'session'): Storage | null {
  try {
    if (kind === 'local') return typeof localStorage === 'undefined' ? null : localStorage;
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(kind: 'local' | 'session', key: string): unknown {
  try {
    const raw = store(kind)?.getItem(key);
    return raw ? JSON.parse(raw) as unknown : null;
  } catch {
    return null;
  }
}

function write(kind: 'local' | 'session', key: string, value: unknown): void {
  try {
    if (value === null) store(kind)?.removeItem(key);
    else store(kind)?.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private mode): the settings still apply to this page.
  }
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function provider(v: unknown, fallback: ProviderSettings): ProviderSettings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    baseURL: str(o.baseURL, fallback.baseURL),
    apiKey: '',
    model: str(o.model, fallback.model),
  };
}

/** Restore saved settings. Unknown or malformed fields fall back to the defaults. */
export function initAssistantSettings(): void {
  const saved = (read('local', SETTINGS_KEY) ?? {}) as Record<string, unknown>;
  const next: AssistantSettings = {
    provider: saved.provider === 'openai' ? 'openai' : 'claude',
    claude: provider(saved.claude, DEFAULT_SETTINGS.claude),
    openai: provider(saved.openai, DEFAULT_SETTINGS.openai),
    rememberKey: saved.rememberKey === true,
    noticeAccepted: saved.noticeAccepted === true,
  };
  const keys = (read(next.rememberKey ? 'local' : 'session', KEYS_KEY) ?? {}) as Record<string, unknown>;
  next.claude.apiKey = str(keys.claude, '');
  next.openai.apiKey = str(keys.openai, '');
  current = next;
}

export function getAssistantSettings(): AssistantSettings {
  return clone(current);
}

export function setAssistantSettings(next: AssistantSettings): void {
  current = clone(next);
  const { claude, openai, ...rest } = current;
  write('local', SETTINGS_KEY, {
    ...rest,
    claude: { baseURL: claude.baseURL, model: claude.model },
    openai: { baseURL: openai.baseURL, model: openai.model },
  });
  const keys = { claude: claude.apiKey, openai: openai.apiKey };
  // Keys live in exactly one place; switching "remember" moves them and clears the other.
  write(current.rememberKey ? 'local' : 'session', KEYS_KEY, keys);
  write(current.rememberKey ? 'session' : 'local', KEYS_KEY, null);
  for (const l of listeners) l();
}

export function onAssistantSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The settings of the active provider, with the official URL filled in. */
export function activeProvider(s: AssistantSettings): ProviderSettings & { id: ProviderId; official: boolean } {
  const p = s[s.provider];
  const official = s.provider === 'claude' ? CLAUDE_OFFICIAL_URL : OPENAI_OFFICIAL_URL;
  const baseURL = p.baseURL.trim().replace(/\/+$/, '') || official;
  return { ...p, id: s.provider, baseURL, official: baseURL === official };
}

/** Remove every occurrence of the key from text that may end up on screen. */
export function redactKey(text: string, key: string): string {
  return key.length >= 8 ? text.split(key).join('[api key]') : text;
}
