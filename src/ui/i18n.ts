// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * i18n core: message lookup, `{var}` interpolation, locale state, persistence.
 *
 * House-built on purpose - the project carries no runtime dependencies beyond
 * pyodide, and a four-locale string switch does not make the case for one
 * (docs/ARCHITECTURE.md: "no UI framework unless a builder makes a case for one").
 *
 * Design:
 * - The English catalog (locales/en.ts) is the source of truth for the key set;
 *   `Messages` derives from it and tsc proves every other catalog complete. `en`
 *   is also the synchronous fallback and stays resident in the registry.
 * - Non-English catalogs live behind LOADERS and are fetched through loadCatalog();
 *   DICTS holds every catalog that has actually loaded. Switching locale is
 *   therefore asynchronous (setLocale resolves a LocaleSwitchResult) while the
 *   render path stays synchronous: t()/applyStaticI18n only ever read DICTS, and `current`
 *   never names a locale whose catalog is absent (the load-before-commit invariant).
 * - Locale state is module-level with a subscriber set; panels do NOT subscribe -
 *   they call t() while rebuilding in render(), and App runs one re-render pass on
 *   change (re-render = clear and rebuild, so nothing stale survives).
 * - Persistence is localStorage['logicweb.lang'] [CHOSEN]; unknown or absent stored
 *   values fall back to 'en' (the mandated default - no browser auto-detection).
 *   The stored locale is read by initLocale() at boot, never at module evaluation.
 * - The module is node-safe at top level (the tools/ self-test bundles it with
 *   --platform=node): module evaluation touches neither storage nor the DOM;
 *   every document/localStorage touch point sits inside a function.
 */

import { en, type Messages } from './locales/en.js';

/** The shipping locales. `en` first: it is the default and the fallback. */
export const LOCALES = ['en', 'zh-CN', 'ru', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];
export type MessageKey = keyof Messages;
export type MessageVars = Record<string, string | number>;

/**
 * Native display names for the settings menu's language list - they are registry
 * data, not message keys, so the menu reads the same labels in every locale [CHOSEN].
 */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  ru: 'Русский',
  fr: 'Français',
};

/**
 * Loaded catalogs, keyed by locale. `en` is always present, which is what lets
 * t()/applyStaticI18n stay synchronous and fall back to English by construction.
 * Non-English entries appear once loadCatalog() resolves.
 */
const DICTS: Partial<Record<Locale, Messages>> = { en };

/**
 * One loader per non-default locale. The literal `import()` specifiers are what
 * make rollup emit one JS chunk per locale, fetched only when that language is
 * selected - the English catalog stays in the entry as the synchronous fallback.
 * (The portable single-file build folds these chunks back into the entry via
 * `inlineDynamicImports` - see vite.config.ts - so `file://` performs no sibling
 * import.)
 */
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<Messages>> = {
  'zh-CN': () => import('./locales/zh-CN.js').then((m) => m.zhCN),
  ru: () => import('./locales/ru.js').then((m) => m.ru),
  fr: () => import('./locales/fr.js').then((m) => m.fr),
};

/** In-flight load promises, so a repeated pick issues one load per locale. */
const INFLIGHT = new Map<Locale, Promise<Messages>>();

/**
 * Resolve a locale's catalog, loading it on first use. Repeat calls share the
 * settled dict (or the in-flight promise); a rejection is not memoized.
 */
export function loadCatalog(locale: Locale): Promise<Messages> {
  const cached = DICTS[locale];
  if (cached) return Promise.resolve(cached);
  const pending = INFLIGHT.get(locale);
  if (pending) return pending;
  const load = locale === 'en' ? Promise.resolve(en) : LOADERS[locale]();
  const promise = load.then(
    (dict) => {
      DICTS[locale] = dict;
      INFLIGHT.delete(locale);
      return dict;
    },
    (err: unknown) => {
      INFLIGHT.delete(locale);
      throw err;
    },
  );
  INFLIGHT.set(locale, promise);
  return promise;
}

/** [CHOSEN] localStorage key holding the persisted locale. */
const STORAGE_KEY = 'logicweb.lang';

/**
 * Replace `{name}` placeholders with `String(vars[name])`. An unknown name keeps
 * its literal `{name}` in the output - a visible mistake beats a swallowed one, and
 * the self-test asserts both directions.
 */
export function formatMessage(template: string, vars?: MessageVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (literal, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : literal);
}

/** Validate a stored value against the known locales; anything else means 'en'. */
export function pickLocale(stored: string | null): Locale {
  return (LOCALES as readonly string[]).includes(stored ?? '') ? stored as Locale : 'en';
}

/**
 * Pure lookup + format against an explicit dict, with fallback to English. t()
 * binds the current locale's dict; the self-test drives this directly with a
 * deliberately incomplete Partial<Messages> to prove the fallback fires.
 */
export function translate(
  dict: Partial<Messages> | undefined,
  key: MessageKey,
  vars?: MessageVars,
): string {
  return formatMessage(dict?.[key] ?? en[key], vars);
}

/** Guarded storage access: undefined under node, throwing in some privacy modes. */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The active locale. Always a locale whose catalog is in DICTS (the
 * load-before-commit invariant); module evaluation keeps the mandated `en`
 * default and initLocale() promotes the persisted choice once it has loaded.
 */
let current: Locale = 'en';

/** Monotonic id of the newest setLocale(); older picks see a mismatch and lose. */
let requestToken = 0;

/**
 * Outcome of setLocale(): `committed` = the pick is now active; `superseded` = a
 * newer pick won the race (a normal outcome, not a failure); `failed` = the
 * catalog could not be loaded, so the previous locale was kept.
 */
export type LocaleSwitchResult = 'committed' | 'superseded' | 'failed';

const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

/**
 * Switch the active locale: load the catalog, persist, sync `<html lang>`, notify
 * subscribers. Asynchronous by necessity - the catalog may need to be fetched.
 * It never rejects; the resolved LocaleSwitchResult distinguishes a committed
 * switch, a pick superseded by a newer one, and a catalog load failure, so
 * callers only surface `failed` through the ordinary status-error path.
 *
 * Picking the currently-active locale is a committed no-op (no load, no
 * notification, no pointless full re-render) BUT still bumps the request token
 * first, so it cancels any in-flight pick: the last pick always wins. A rapid
 * double-pick settles on the LAST pick with exactly one notification (one
 * re-render) because only the winner passes the requestToken check. On failure
 * `current` is left untouched and the persisted value is kept, so a transient
 * error retries next session.
 */
export async function setLocale(locale: Locale): Promise<LocaleSwitchResult> {
  const token = ++requestToken;
  if (locale === current) return 'committed';
  try {
    await loadCatalog(locale);
  } catch (err) {
    // A failure on a pick the user has already moved past is history, not an error.
    if (token !== requestToken) return 'superseded';
    console.warn(`[i18n] catalog load failed for ${locale}`, err);
    return 'failed';
  }
  if (token !== requestToken) return 'superseded';
  current = locale;
  try {
    storage()?.setItem(STORAGE_KEY, locale);
  } catch {
    // Quota/security failures must not break the switch itself - the in-memory
    // locale already changed; persistence is best-effort.
  }
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  for (const cb of listeners) cb();
  return 'committed';
}

/**
 * Boot hook: preload the persisted locale so the first App render paints in it.
 * Never rejects - a stored locale that fails to load leaves the module on `en`
 * with a warning, keeping boot off the loud-failure overlay path.
 */
export async function initLocale(): Promise<Locale> {
  const stored = pickLocale(storage()?.getItem(STORAGE_KEY) ?? null);
  if (stored !== current && (await setLocale(stored)) === 'failed') {
    console.warn(`[i18n] staying on ${current}; stored ${stored} did not load`);
  }
  return current;
}

/** Subscribe to locale changes; returns the unsubscribe. */
export function onLocaleChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Translate a message key in the current locale, English as fallback. */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(DICTS[current], key, vars);
}

/**
 * Apply the catalog to static HTML chrome: `[data-i18n]` sets textContent,
 * `[data-i18n-title]` sets the title attribute. Unknown keys warn and keep the
 * element's existing (English) text - the self-test separately asserts that every
 * attribute in index.html names a real key, so a typo fails there, not silently.
 */
export function applyStaticI18n(root: ParentNode): void {
  const dict = (DICTS[current] ?? en) as Record<string, string>;
  const fallback = en as Record<string, string>;
  const lookup = (key: string): string | null => {
    const v = dict[key] ?? fallback[key];
    if (v === undefined) {
      console.warn(`[i18n] unknown data-i18n key: ${key}`);
      return null;
    }
    return v;
  };
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const v = lookup(el.getAttribute('data-i18n') ?? '');
    if (v !== null) el.textContent = v;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const v = lookup(el.getAttribute('data-i18n-title') ?? '');
    if (v !== null) el.title = v;
  }
}
