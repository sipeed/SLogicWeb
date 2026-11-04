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
 * - Persistence is localStorage['logicweb.lang'] [CHOSEN]. An explicit pick owns that
 *   record and a stored shipping locale wins; without one the browser's language
 *   preferences are matched (exactly equal tag, then primary subtag) and 'en' is the
 *   last resort. initLocale() reads the record at boot (never at module evaluation)
 *   and its own switch does not persist.
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

export type DecoderMessages = Readonly<Record<string, string>>;

interface LocaleCatalogPair {
  readonly messages: Messages;
  readonly decoder: DecoderMessages;
}

type NonDefaultLocale = Exclude<Locale, 'en'>;

const DECODER_DICTS: Partial<Record<Locale, DecoderMessages>> = {};

/**
 * One loader per non-default locale. The literal `import()` specifiers are what
 * make rollup emit one JS chunk per locale, fetched only when that language is
 * selected - the English catalog stays in the entry as the synchronous fallback.
 * (The portable single-file build folds these chunks back into the entry via
 * `inlineDynamicImports` - see vite.config.ts - so `file://` performs no sibling
 * import.)
 */
const LOADERS: Record<NonDefaultLocale, () => Promise<LocaleCatalogPair>> = {
  'zh-CN': () => import('./locales/zh-CN.js').then(
    (m) => ({ messages: m.zhCN, decoder: m.zhCNDecoder })),
  ru: () => import('./locales/ru.js').then((m) => ({ messages: m.ru, decoder: m.ruDecoder })),
  fr: () => import('./locales/fr.js').then((m) => ({ messages: m.fr, decoder: m.frDecoder })),
};

const LOADER_OVERRIDES = new Map<NonDefaultLocale, () => Promise<unknown>>();

export function setLocaleLoaderForTest(
  locale: NonDefaultLocale,
  loader: (() => Promise<unknown>) | null,
): void {
  if (loader) {
    LOADER_OVERRIDES.set(locale, loader);
    delete DICTS[locale];
    delete DECODER_DICTS[locale];
    INFLIGHT.delete(locale);
  } else {
    LOADER_OVERRIDES.delete(locale);
  }
}

function assertMessageRecord(value: unknown, label: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[i18n] ${label} is not a message catalog`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== 'string') {
      throw new Error(`[i18n] ${label} value for ${key} is not a string`);
    }
  }
  return record as Record<string, string>;
}

function registerCatalogPair(locale: Locale, raw: unknown): Messages {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`[i18n] ${locale} catalog pair is missing`);
  }
  const pair = raw as { messages?: unknown; decoder?: unknown };
  const messages = assertMessageRecord(pair.messages, `${locale} messages`) as Messages;
  const decoder = assertMessageRecord(pair.decoder, `${locale} decoder messages`);
  DICTS[locale] = messages;
  DECODER_DICTS[locale] = decoder;
  return messages;
}

function loadCatalogPair(locale: NonDefaultLocale): Promise<Messages> {
  const load = LOADER_OVERRIDES.get(locale) ?? LOADERS[locale];
  return load().then((raw) => registerCatalogPair(locale, raw));
}

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
  const load = locale === 'en' ? Promise.resolve(en) : loadCatalogPair(locale);
  const promise = load.then(
    (dict) => {
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

function normalizeTag(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase();
}

function primarySubtag(tag: string): string {
  return tag.split('-')[0];
}

/**
 * Map one BCP-47 language tag to a supported locale: the exact tag form wins,
 * otherwise the first LOCALES entry sharing the primary subtag.
 */
export function matchLocale(tag: string): Locale | null {
  const normalized = normalizeTag(tag);
  if (normalized === '') return null;
  for (const locale of LOCALES) {
    if (locale.toLowerCase() === normalized) return locale;
  }
  const primary = primarySubtag(normalized);
  for (const locale of LOCALES) {
    const lower = locale.toLowerCase();
    if (lower === primary || primarySubtag(lower) === primary) return locale;
  }
  return null;
}

function isSupportedLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve the active locale: a stored supported locale wins, else the first
 * matchable `preferred` entry, else 'en'. An unusable stored value counts as absent.
 */
export function pickLocale(stored: string | null, preferred: readonly string[] = []): Locale {
  if (stored !== null && isSupportedLocale(stored)) return stored;
  for (const tag of preferred) {
    const matched = matchLocale(tag);
    if (matched !== null) return matched;
  }
  return 'en';
}

/**
 * The browser's language preference chain: `navigator.languages` when it carries a
 * usable tag, else `navigator.language`, else nothing (node, or a stripped navigator).
 */
export function readBrowserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  const raw: readonly unknown[] = Array.isArray(navigator.languages) ? navigator.languages : [];
  const usable = raw.filter(
    (tag): tag is string => typeof tag === 'string' && tag.trim() !== '',
  );
  if (usable.length > 0) return usable;
  const only: unknown = navigator.language;
  return typeof only === 'string' && only.trim() !== '' ? [only] : [];
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
 * load-before-commit invariant); module evaluation keeps the `en` default and
 * initLocale() promotes the stored or browser-detected choice once it has loaded.
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
export function setLocale(locale: Locale): Promise<LocaleSwitchResult> {
  return switchLocale(locale, true);
}

async function switchLocale(locale: Locale, persist: boolean): Promise<LocaleSwitchResult> {
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
  if (persist) {
    try {
      storage()?.setItem(STORAGE_KEY, locale);
    } catch {
      // Quota/security failures must not break the switch itself - the in-memory
      // locale already changed; persistence is best-effort.
    }
  }
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  for (const cb of listeners) cb();
  return 'committed';
}

/**
 * Boot hook: commit the stored locale, else the browser language, so the first App
 * render paints in it. Never persists and never rejects - a target that fails to
 * load leaves the module on the current locale with a warning, keeping boot off the
 * loud-failure overlay path.
 */
export async function initLocale(): Promise<Locale> {
  const stored = storage()?.getItem(STORAGE_KEY) ?? null;
  const target = pickLocale(stored, readBrowserLanguages());
  if (target !== current && (await switchLocale(target, false)) === 'failed') {
    console.warn(`[i18n] staying on ${current}; ${target} did not load`);
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

export function translateDecoder(key: string, fallback: string): string {
  const dict = DECODER_DICTS[current];
  return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : fallback;
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
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) {
    const v = lookup(el.getAttribute('data-i18n-aria-label') ?? '');
    if (v !== null) el.setAttribute('aria-label', v);
  }
}
