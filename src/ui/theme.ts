// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import type { MessageKey } from './i18n.js';

export const THEMES = ['default', 'dark', 'light'] as const;
export type ThemeId = (typeof THEMES)[number];

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const DEFAULT_MODE: ThemeMode = 'dark';

export const THEME_LABEL_KEYS: Record<ThemeId, MessageKey> = {
  default: 'theme.default',
  dark: 'theme.dark',
  light: 'theme.light',
};

export const THEME_MODE_LABEL_KEYS: Record<ThemeMode, MessageKey> = {
  light: 'theme.light',
  dark: 'theme.dark',
  system: 'theme.system',
};

export const THEME_STORAGE_KEY = 'logicweb.theme';

let mode: ThemeMode = DEFAULT_MODE;
let systemDark = true;
let current: ThemeId = 'dark';
let listening = false;

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  try {
    return storage()?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function pickMode(stored: string | null): ThemeMode {
  return (THEME_MODES as readonly string[]).includes(stored ?? '') ? stored as ThemeMode : DEFAULT_MODE;
}

export function resolveMode(picked: ThemeMode, prefersDark: boolean): ThemeId {
  return picked === 'system' ? (prefersDark ? 'dark' : 'light') : picked;
}

export function getMode(): ThemeMode {
  return mode;
}

export function getTheme(): ThemeId {
  return current;
}

export function applyTheme(id: ThemeId): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = id;
}

function notify(): void {
  for (const cb of listeners) cb();
}

export function setMode(next: ThemeMode): void {
  if (next === mode) return;
  mode = next;
  try {
    storage()?.setItem(THEME_STORAGE_KEY, next);
  } catch {
  }
  const resolved = resolveMode(mode, systemDark);
  if (resolved !== current) {
    current = resolved;
    applyTheme(resolved);
  }
  notify();
}

function systemMql(): MediaQueryList | null {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  } catch {
    return null;
  }
}

function onSystemChange(event: MediaQueryListEvent): void {
  systemDark = event.matches;
  if (mode !== 'system') return;
  const resolved = resolveMode(mode, systemDark);
  if (resolved === current) return;
  current = resolved;
  applyTheme(resolved);
  notify();
}

function onStorage(event: Pick<StorageEvent, 'key' | 'newValue'>): void {
  if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
  const next = pickMode(event.key === null ? null : event.newValue);
  if (next === mode) return;
  mode = next;
  const resolved = resolveMode(mode, systemDark);
  if (resolved !== current) {
    current = resolved;
    applyTheme(resolved);
  }
  notify();
}

export function initTheme(): ThemeMode {
  mode = pickMode(readStored());
  const mql = systemMql();
  systemDark = mql ? mql.matches : true;
  current = resolveMode(mode, systemDark);
  applyTheme(current);
  if (!listening) {
    listening = true;
    if (mql) {
      if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSystemChange);
      else mql.addListener?.(onSystemChange);
    }
    try {
      if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
    } catch {
    }
  }
  return mode;
}

export function onThemeChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
