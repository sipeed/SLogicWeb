// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Theme core: the active shell theme, its persistence, and its subscribers.
 *
 * Shaped after i18n.ts (module state + subscriber set + guarded storage), but
 * synchronous: a theme has no catalog to fetch, so there is no Promise, no request
 * token, and no `superseded` outcome - a pick either commits or is a same-id no-op.
 *
 * Design:
 * - The theme is applied as a `data-theme` attribute on <html>, and the value is
 *   always written - including the `default` theme - so the live state is
 *   inspectable. Every dark rule is scoped to `html[data-theme="dark"]`, so writing
 *   `default` cannot change the default rendering (the pixel-identity contract).
 * - Persistence is localStorage['logicweb.theme'] [CHOSEN], the same shape as the
 *   locale key (logicweb.lang). Absent or unknown stored values fall back to dark
 *   (DEFAULT_THEME) [CHOSEN], and a stored 'default' migrates there too: the legacy
 *   light pick predates dark-by-default and the retired settings picker, so honoring
 *   it would strand the user on a theme they can no longer change. The stored theme
 *   is read by initTheme() at boot, never at module evaluation.
 * - Storage access is guarded twice: the localStorage reference itself (undefined
 *   under node, throwing in some privacy modes) and the read/write calls (quota and
 *   security failures). A failed read falls back to 'default'; a failed write leaves
 *   the in-memory switch intact - persistence is best-effort, never load-bearing.
 * - The module is node-safe at top level (the tools/ self-test bundles it with
 *   --platform=node): module evaluation touches neither storage nor the DOM; every
 *   document/localStorage touch point sits inside a function.
 */

import type { MessageKey } from './i18n.js';

/** The shipping themes. Registry order only - the fallback is DEFAULT_THEME. */
export const THEMES = ['default', 'dark'] as const;
export type ThemeId = (typeof THEMES)[number];

/**
 * [CHOSEN] The boot theme for every visitor without a live stored pick. Absent or
 * unknown storage lands here, and so does the migrated legacy 'default' pick (see
 * pickTheme). With today's registry every pickTheme() path resolves to this value;
 * the validation stays so a future added id is honored automatically.
 */
export const DEFAULT_THEME: ThemeId = 'dark';

/**
 * Display-label key per theme. Typed `Record<ThemeId, MessageKey>` so a new theme id
 * without a label key - or a label key that left the English catalog - is a tsc
 * error, and the self-test re-checks the catalog membership at runtime.
 */
export const THEME_LABEL_KEYS: Record<ThemeId, MessageKey> = {
  default: 'theme.default',
  dark: 'theme.dark',
};

/** [CHOSEN] localStorage key holding the persisted theme. */
export const THEME_STORAGE_KEY = 'logicweb.theme';

/** The active theme. Module evaluation keeps the fallback; initTheme() promotes storage. */
let current: ThemeId = DEFAULT_THEME;

const listeners = new Set<() => void>();

/** Guarded storage access: undefined under node, throwing in some privacy modes. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Read the persisted theme, tolerating a storage that is absent AND a getItem that
 * throws (i18n's storage() helper only guards the reference, which is not enough for
 * this suite's throwing-storage contract). Anything unreadable means "no stored pick".
 */
function readStored(): string | null {
  try {
    return storage()?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a stored value to the boot theme. A stored 'default' is NOT a live pick:
 * the legacy light choice predates dark-by-default and the retired picker, so it
 * migrates to the fallback exactly like an absent or unknown value [CHOSEN].
 */
export function pickTheme(stored: string | null): ThemeId {
  if (stored === 'default') return DEFAULT_THEME; // legacy migration
  return (THEMES as readonly string[]).includes(stored ?? '') ? stored as ThemeId : DEFAULT_THEME;
}

export function getTheme(): ThemeId {
  return current;
}

/**
 * Reflect the theme on <html>. Owns the DOM side effect, the way setLocale owns
 * <html lang>; guarded so the module stays node-safe.
 */
export function applyTheme(id: ThemeId): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = id;
}

/**
 * Switch the active theme, persist it, and notify subscribers. Picking the
 * currently-active theme is a no-op: no storage write, no attribute write, no
 * notification (nothing changed, so nothing should re-render).
 */
export function setTheme(id: ThemeId): void {
  if (id === current) return;
  current = id;
  try {
    storage()?.setItem(THEME_STORAGE_KEY, id);
  } catch {
    // Quota/security failures must not break the switch itself - the in-memory
    // theme already changed; persistence is best-effort.
  }
  applyTheme(id);
  for (const cb of listeners) cb();
}

/**
 * Boot hook: restore the persisted theme and reflect it before the first paint.
 * Synchronous (there is no catalog to load) and read-only: a fresh visitor keeps
 * the fallback (dark) and does not create a storage entry.
 */
export function initTheme(): ThemeId {
  const picked = pickTheme(readStored());
  current = picked;
  applyTheme(picked);
  return picked;
}

/** Subscribe to theme changes; returns the unsubscribe. */
export function onThemeChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
