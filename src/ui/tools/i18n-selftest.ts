// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the i18n core suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/i18n-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/i18n-selftest.mjs && node /tmp/i18n-selftest.mjs
 *
 * Run from the repository root (later checks read index.html and vite.config.ts from
 * the CWD).
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 *
 * What is pinned here:
 *
 *   - formatMessage interpolates exactly, and leaves an unknown `{var}` literal in
 *     the output instead of swallowing it (the visible-failure contract);
 *   - pickLocale prefers a stored supported locale, then the browser preference list
 *     in declaration order, then 'en' (an unusable stored value does not short-circuit
 *     the match - it counts as absent);
 *   - matchLocale maps a BCP-47 tag to a supported locale - exact form first, then
 *     the primary subtag - and never prefix-matches ('e', 'english', 'zhx' stay null);
 *   - the boot path is observed rather than inferred: readBrowserLanguages() follows
 *     navigator.languages -> navigator.language -> nothing, and initLocale() adopts a
 *     matched browser language without writing storage while a stored locale still
 *     wins. navigator/localStorage are replaced per case and restored from their
 *     saved property descriptors in `finally` - these cases cover the wiring, they
 *     are not a real browser;
 *   - translate() falls back to the English string when a dict lacks the key - the
 *     incomplete dict is a Partial<Messages> cast, so the Messages type itself stays
 *     intact;
 *   - the English catalog itself is sane: non-empty, no empty values, balanced
 *     braces, well-formed placeholder names, and every other catalog repeats that
 *     sanity with the same `{var}` name set per key (a typoed placeholder fails);
 *   - catalog key parity across locales holds at runtime, and each locale really
 *     translates the salient probe keys;
 *   - the Vite chunk-size warning policy: exactly 2048 KB for standard builds and
 *     20_000 KB for portable builds (static config check, no asset evaluation);
 *   - the async catalog path: every locale loads through loadCatalog() to the very
 *     same catalog object as the static import (identity, not just key parity),
 *     setLocale() round-trips, a superseded pick resolves 'superseded' without
 *     notifying, picking the currently-active locale still cancels an
 *     in-flight pick (the last-pick-wins race guard), and a failed catalog
 *     load resolves 'failed' while keeping the previous locale.
 *
 * Parity and the placeholder-set check are meaningful only now that a second
 * locale ships: with a single catalog they could never fail, and a tautological
 * check is worse than none (.trellis/spec/frontend/quality-guidelines.md §3).
 */

import { en, type Messages } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';
import {
  formatMessage, getLocale, initLocale, loadCatalog, LOCALE_LABELS, LOCALES, matchLocale,
  onLocaleChange, pickLocale, readBrowserLanguages, setLocale, t, translate, type Locale,
} from '../i18n.js';
import {
  formatAnalyzerNote, formatCaptureLabel, formatDiagnostic, formatMountedAnalyzerNote,
  formatStatusDetail, formatStatusError, formatStatusErrorDebug, formatTriggerSummary, statusDetailOf,
} from '../format.js';
import {
  DIAGNOSTIC_CODES, DiagnosticError, fromWireDiagnostic, wireDiagnostic,
} from '../../diagnostics.js';
import type { AnalyzerNote, AnalyzerStatus, CaptureLabel, CaptureSettings, StatusError } from '../state.js';

/** Same structural-typing trick as sr-selftest.ts: node access without @types/node. */
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: {
      exit(code: number): never;
      getBuiltinModule?(name: string): unknown;
    };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(p: string, enc: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

// ------------------------------------------------------------------ interpolation

{
  const got = formatMessage('{count} samples @ {rate}', { count: 2048, rate: '100 MHz' });
  check('formatMessage interpolates every named var',
    got === '2048 samples @ 100 MHz', got);
}

{
  const got = formatMessage('{count} samples @ {rate}', { count: 7 });
  check('formatMessage leaves an unknown {var} literal (visible failure)',
    got === '7 samples @ {rate}', got);
}

{
  const got = formatMessage('plain text, no vars', { unused: 1 });
  check('formatMessage leaves a var-less template untouched',
    got === 'plain text, no vars', got);
}

// ------------------------------------------------------------------ locale pick

{
  const absent = pickLocale(null);
  const unknown = pickLocale('xx-YY');
  const knownEn = pickLocale('en');
  const knownFr = pickLocale('fr');
  check('pickLocale falls back to en for absent/unknown, keeps known locales',
    absent === 'en' && unknown === 'en' && knownEn === 'en' && knownFr === 'fr',
    `null→${absent}, xx-YY→${unknown}, en→${knownEn}, fr→${knownFr}`);
}

{
  const table: [string, readonly string[], Locale][] = [
    ['ru', ['fr-FR'], 'ru'], ['en', ['fr-FR'], 'en'], ['fr', ['de-DE'], 'fr'],
  ];
  const bad = table.find(([stored, preferred, want]) => pickLocale(stored, preferred) !== want);
  check('pickLocale keeps a stored locale ahead of the browser preference list',
    bad === undefined,
    bad ? `stored ${bad[0]} + ${JSON.stringify(bad[1])}→${pickLocale(bad[0], bad[1])}, want ${bad[2]}`
      : table.map(([stored, preferred, want]) =>
        `${stored}+${JSON.stringify(preferred)}→${pickLocale(stored, preferred)}=${want}`).join(', '));
}

{
  const table: [string | null, readonly string[], Locale][] = [
    [null, ['de-DE', 'ru'], 'ru'],
    [null, ['fr-FR', 'ru'], 'fr'],
    [null, ['de-DE', 'zh-Hans-CN'], 'zh-CN'],
    [null, ['de-DE', 'it-IT'], 'en'],
  ];
  const bad = table.find(([stored, preferred, want]) => pickLocale(stored, preferred) !== want);
  check('pickLocale takes the first supported tag in browser preference order',
    bad === undefined,
    bad ? `${JSON.stringify(bad[1])}→${pickLocale(bad[0], bad[1])}, want ${bad[2]}`
      : table.map(([stored, preferred, want]) =>
        `${JSON.stringify(preferred)}→${pickLocale(stored, preferred)}=${want}`).join(', '));
}

{
  const table: [string | null, readonly string[], Locale][] = [
    ['xx-YY', ['de-DE', 'ru'], 'ru'],
    ['fr-DE', ['de-DE', 'ru'], 'ru'],
    ['xx-YY', ['fr-FR'], 'fr'],
    ['xx-YY', [], 'en'],
    ['', ['fr-FR'], 'fr'],
    [null, [], 'en'],
  ];
  const bad = table.find(([stored, preferred, want]) => pickLocale(stored, preferred) !== want);
  check('pickLocale treats an unusable stored value as absent and keeps matching',
    bad === undefined,
    bad ? `stored ${JSON.stringify(bad[0])} + ${JSON.stringify(bad[1])}→`
      + `${pickLocale(bad[0], bad[1])}, want ${bad[2]}`
      : table.map(([stored, preferred, want]) =>
        `${JSON.stringify(stored)}+${JSON.stringify(preferred)}→${pickLocale(stored, preferred)}`
        + `=${want}`).join(', '));
}

// -------------------------------------------------------- language tag matching

{
  const table: [string, Locale | null][] = [
    ['fr', 'fr'], ['FR', 'fr'], [' fr-FR ', 'fr'], ['fr_FR', 'fr'], ['fr-FR', 'fr'], ['ru-RU', 'ru'],
  ];
  const bad = table.find(([tag, want]) => matchLocale(tag) !== want);
  check('matchLocale accepts the exact tag form regardless of case, padding and `_`',
    bad === undefined,
    bad ? `${JSON.stringify(bad[0])}→${matchLocale(bad[0])}, want ${bad[1]}`
      : table.map(([tag, want]) => `${JSON.stringify(tag)}→${matchLocale(tag)}=${want}`).join(', '));
}

{
  const table: [string, Locale | null][] = [
    ['en-GB', 'en'], ['zh', 'zh-CN'], ['zh-Hans-CN', 'zh-CN'], ['zh-TW', 'zh-CN'], ['zh-cn', 'zh-CN'],
  ];
  const bad = table.find(([tag, want]) => matchLocale(tag) !== want);
  check('matchLocale falls back to the primary subtag (region and script variants)',
    bad === undefined,
    bad ? `${JSON.stringify(bad[0])}→${matchLocale(bad[0])}, want ${bad[1]}`
      : table.map(([tag, want]) => `${JSON.stringify(tag)}→${matchLocale(tag)}=${want}`).join(', '));
}

{
  const table = ['de', 'de-DE', '', '  ', 'e', 'english', 'zhx', 'enx']; // loose-prefix traps included
  const bad = table.find((tag) => matchLocale(tag) !== null);
  check('matchLocale rejects unsupported tags instead of prefix-matching a locale',
    bad === undefined,
    bad ? `${JSON.stringify(bad)}→${matchLocale(bad)}, want null`
      : table.map((tag) => `${JSON.stringify(tag)}→null`).join(', '));
}

// ------------------------------------------------------------------ translation

{
  const got = translate(undefined, 'toolbar.start');
  check('translate with no dict falls back to English',
    got === 'Capture', got);
}

{
  const partial = { 'toolbar.start': 'Démarrer' } as Partial<Messages>;
  const hit = translate(partial, 'toolbar.start');
  const miss = translate(partial, 'toolbar.save');
  check('translate prefers the dict and falls back per missing key',
    hit === 'Démarrer' && miss === 'Save', `dict→${hit}, missing→${miss}`);
}

{
  // Under node there is no stored locale, so the module must boot to English and
  // t() must serve it - this is the fresh-visitor default the PRD mandates.
  const got = getLocale();
  const rendered = t('toolbar.fit');
  check('default locale is en and t() serves it without any setup',
    got === 'en' && rendered === 'Fit', `locale=${got}, t(toolbar.fit)=${rendered}`);
}

// ---------------------------------------------------------- catalog sanity (en)

{
  const keys = Object.keys(en);
  check('the English catalog is non-empty',
    keys.length > 0, `${keys.length} keys`);
}

{
  const railKeys = Object.keys(en).filter((k) => k.startsWith('rail.'));
  check('the retired rail catalog keys are removed from the English catalog',
    railKeys.length === 0,
    railKeys.length === 0 ? 'no rail.* keys' : railKeys.join(', '));
}

{
  const empty = Object.entries(en).filter(([, v]) => v.trim() === '').map(([k]) => k);
  check('no empty message values',
    empty.length === 0, empty.length === 0 ? 'all values non-empty' : empty.join(', '));
}

{
  const bad = Object.entries(en).filter(([, v]) => {
    const opens = (v.match(/\{/g) ?? []).length;
    const closes = (v.match(/\}/g) ?? []).length;
    if (opens !== closes) return true;
    // Every placeholder must be a well-formed {name}.
    const stripped = v.replace(/\{\w+\}/g, '');
    return stripped.includes('{') || stripped.includes('}');
  }).map(([k]) => k);
  check('every template has balanced, well-formed {placeholders}',
    bad.length === 0, bad.length === 0 ? 'all templates well-formed' : bad.join(', '));
}

{
  // The same sanity for every shipping catalog: a translated template with a typoed
  // {var} would pass tsc and key parity, then render the literal braces at the user.
  const dicts: [string, Messages][] = [['zh-CN', zhCN], ['ru', ru], ['fr', fr]];
  const enVars = (k: keyof Messages): string =>
    [...en[k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',');
  const bad: string[] = [];
  for (const [locale, dict] of dicts) {
    for (const k of Object.keys(en) as (keyof Messages)[]) {
      // A catalog that cheated with `as Messages` can be key-incomplete at runtime;
      // report that as this check's failure instead of throwing out of the loop and
      // losing every earlier result (the parity check below catches the same cheat).
      const v: string | undefined = dict[k];
      if (v === undefined) { bad.push(`${locale}:${k} missing`); continue; }
      const opens = (v.match(/\{/g) ?? []).length;
      const closes = (v.match(/\}/g) ?? []).length;
      if (opens !== closes) { bad.push(`${locale}:${k} unbalanced`); continue; }
      const stripped = v.replace(/\{\w+\}/g, '');
      if (stripped.includes('{') || stripped.includes('}')) {
        bad.push(`${locale}:${k} malformed placeholder`);
        continue;
      }
      const vars = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',');
      if (vars !== enVars(k)) bad.push(`${locale}:${k} vars {${vars}} != en {${enVars(k)}}`);
    }
  }
  check('every catalog keeps balanced braces and the en placeholder set per key',
    bad.length === 0,
    bad.length === 0 ? 'all 3 catalogs well-formed with matching {vars}' : bad.join('; '));
}

{
  const missing = LOCALES.filter((l) => !(l in LOCALE_LABELS) || LOCALE_LABELS[l] === '');
  check('LOCALE_LABELS names every registered locale',
    missing.length === 0,
    missing.length === 0 ? LOCALES.map((l) => `${l}=${LOCALE_LABELS[l]}`).join(', ') : missing.join(','));
}

// ------------------------------------------- index.html static chrome (check 5)
// The HTML attribute keys cannot be type-checked by tsc, so pin them here instead:
// every data-i18n / data-i18n-title value must name a real catalog key, and the
// element's literal fallback text must equal the English catalog value - the
// "English rendering unchanged" control (PRD §8), not just key existence.

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const html = fs.readFileSync('index.html', 'utf8');
  const catalog = en as Record<string, string>;

  // Elements whose textContent is translated: pure-text inner content only.
  const textFound = new Map<string, string>();
  for (const m of html.matchAll(/<\w+[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\//g)) {
    textFound.set(m[1]!, m[2]!);
  }
  // Elements whose title attribute is translated.
  const titleFound = new Map<string, string>();
  for (const m of html.matchAll(/<[^>]*\sdata-i18n-title="[^"]+"[^>]*>/g)) {
    const tag = m[0];
    const key = /data-i18n-title="([^"]+)"/.exec(tag)?.[1];
    const title = /\stitle="([^"]*)"/.exec(tag)?.[1];
    if (key !== undefined && title !== undefined) titleFound.set(key, title);
  }
  const ariaLabelFound = new Map<string, string>();
  for (const m of html.matchAll(/<[^>]*\sdata-i18n-aria-label="[^"]+"[^>]*>/g)) {
    const tag = m[0];
    const key = /data-i18n-aria-label="([^"]+)"/.exec(tag)?.[1];
    const label = /\saria-label="([^"]*)"/.exec(tag)?.[1];
    if (key !== undefined && label !== undefined) ariaLabelFound.set(key, label);
  }

  const expectedText = [
    'app.title', 'connectHelp.retry',
    'emptyHint.line1', 'emptyHint.line2', 'emptyHint.example', 'drop.overlay',
    'toolbar.shortDevice', 'toolbar.shortStart', 'toolbar.shortOpen', 'toolbar.shortSave',
    'toolbar.shortFullscreen', 'toolbar.shortSettings', 'toolbar.shortLanguage',
    'toolbar.shortTheme', 'error.details',
  ];
  const expectedTitles = [
    'toolbar.startTitle', 'toolbar.openTitle', 'toolbar.saveTitle',
    'toolbar.enterFullscreenTitle',
    'toolbar.themeTitle', 'toolbar.languageTitle',
    'settings.titleHint', 'panel.resizeTitle',
  ];
  const expectedAriaLabels = [
    'panel.resizeLabel', 'toolbar.switchGroup', 'toolbar.viewGroup', 'shortcuts.close',
    'hints.barLabel', 'notice.dismiss',
  ];

  const missingTextKeys = expectedText.filter((k) => !textFound.has(k));
  const unknownTextKeys = [...textFound.keys()].filter((k) => !(k in catalog));
  check('index.html data-i18n keys are exactly the expected set and all exist',
    missingTextKeys.length === 0 && unknownTextKeys.length === 0 &&
    textFound.size === expectedText.length,
    `found ${textFound.size}: ${[...textFound.keys()].join(', ') || '(none)'}`);

  const missingTitleKeys = expectedTitles.filter((k) => !titleFound.has(k));
  const unknownTitleKeys = [...titleFound.keys()].filter((k) => !(k in catalog));
  check('index.html data-i18n-title keys are exactly the expected set and all exist',
    missingTitleKeys.length === 0 && unknownTitleKeys.length === 0 &&
    titleFound.size === expectedTitles.length,
    `found ${titleFound.size}: ${[...titleFound.keys()].join(', ') || '(none)'}`);

  const textDrift = [...textFound.entries()].filter(([k, text]) => catalog[k] !== text);
  check('data-i18n element fallback text equals the English catalog value',
    textDrift.length === 0,
    textDrift.length === 0 ? 'all match' :
      textDrift.map(([k, text]) => `${k}: html=${JSON.stringify(text)} en=${JSON.stringify(catalog[k])}`).join('; '));

  const titleDrift = [...titleFound.entries()].filter(([k, title]) => catalog[k] !== title);
  check('data-i18n-title attribute text equals the English catalog value',
    titleDrift.length === 0,
    titleDrift.length === 0 ? 'all match' :
      titleDrift.map(([k, title]) => `${k}: html=${JSON.stringify(title)} en=${JSON.stringify(catalog[k])}`).join('; '));

  const missingAriaLabelKeys = expectedAriaLabels.filter((k) => !ariaLabelFound.has(k));
  const unknownAriaLabelKeys = [...ariaLabelFound.keys()].filter((k) => !(k in catalog));
  check('index.html data-i18n-aria-label keys are exactly the expected set and all exist',
    missingAriaLabelKeys.length === 0 && unknownAriaLabelKeys.length === 0 &&
    ariaLabelFound.size === expectedAriaLabels.length,
    `found ${ariaLabelFound.size}: ${[...ariaLabelFound.keys()].join(', ') || '(none)'}`);

  const ariaLabelDrift = [...ariaLabelFound.entries()].filter(([k, label]) => catalog[k] !== label);
  check('data-i18n-aria-label attribute text equals the English catalog value',
    ariaLabelDrift.length === 0,
    ariaLabelDrift.length === 0 ? 'all match' :
      ariaLabelDrift.map(([k, label]) => `${k}: html=${JSON.stringify(label)} en=${JSON.stringify(catalog[k])}`).join('; '));

  const toolbarNameKeys: [string, string][] = [
    ['btn-connect', 'toolbar.device'],
    ['transport', 'toolbar.start'],
    ['btn-open', 'toolbar.open'],
    ['btn-save', 'toolbar.save'],
    ['btn-fullscreen', 'toolbar.fullscreen'],
    ['btn-settings', 'settings.title'],
    ['btn-language', 'toolbar.languageTitle'],
    ['btn-theme', 'toolbar.themeTitle'],
  ];
  const nameDrift = toolbarNameKeys.filter(([id, key]) => {
    const button = new RegExp(`<button[^>]*\\bid="${id}"[^>]*>`).exec(html)?.[0] ?? '';
    const ariaLabel = /\saria-label="([^"]*)"/.exec(button)?.[1];
    return ariaLabel === undefined || ariaLabel !== catalog[key];
  });
  check('every toolbar button aria-label fallback equals the English catalog value',
    nameDrift.length === 0,
    nameDrift.length === 0 ? `${toolbarNameKeys.length} toolbar names match`
      : nameDrift.map(([id, key]) => `${id}:${key}`).join(', '));
}

// ------------------------------------------- Vite chunk warning configuration
// Evaluating the portable branch reads vendored runtime assets. Keep this suite
// asset-independent by pinning the one conditional and both numeric branches.
{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const config = fs.readFileSync('vite.config.ts', 'utf8');
  const occurrences = config.match(/chunkSizeWarningLimit\s*:/g) ?? [];
  const setting =
    /chunkSizeWarningLimit:\s*portable\s*\?\s*([\d_]+)\s*:\s*([\d_]+)/.exec(config);
  const portableKb = Number(setting?.[1]?.replace(/_/g, ''));
  const standardKb = Number(setting?.[2]?.replace(/_/g, ''));
  check('vite.config.ts chunk warning limits are 2048 KB standard / 20000 KB portable',
    occurrences.length === 1 && standardKb === 2048 && portableKb === 20_000,
    `occurrences=${occurrences.length}, standard=${standardKb} KB, portable=${portableKb} KB`);
}

// ------------------------------------- structured-state formatters (render-time)
// The capture title and status error stopped being pre-formatted strings; pin every
// CaptureLabel variant and the StatusError join against the exact English the shell
// rendered before externalization.

{
  const cases: [CaptureLabel, string][] = [
    [{ kind: 'none' }, 'no capture'],
    [{ kind: 'capturing', channels: 8, rate: 100e6 }, 'capturing 8 ch @ 100 MS/s'],
    [{ kind: 'loaded', source: 'uart.sr @ 16 MS/s, 16 CH', ms: 12 },
      'uart.sr @ 16 MS/s, 16 CH · loaded in 12 ms'],
    [{ kind: 'stoppedNoTrigger', samples: 12345 }, 'no trigger · 12,345 samples retained'],
    [{ kind: 'live', samples: 12345, rate: 100e6, seconds: 0.5 },
      'device capture · 12,345 samples @ 100 MS/s · 500.0 ms'],
  ];
  const bad = cases.filter(([label, want]) => formatCaptureLabel(label) !== want);
  check('formatCaptureLabel renders all five variants byte-identical to before',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/5 variants match`
      : bad.map(([l, want]) => `${l.kind}: got ${JSON.stringify(formatCaptureLabel(l))} want ${JSON.stringify(want)}`).join('; '));
}

{
  const thirdParty = formatStatusError({
    what: 'error.openCapture', detail: { kind: 'text', text: 'zip: bad' },
  });
  const withVars = formatStatusError({
    what: 'error.decode', vars: { id: 'uart' }, detail: { kind: 'text', text: 'boom' },
  });
  const translated = formatStatusError({
    what: 'error.save', detail: { kind: 'diagnostic', diag: { code: 'io.nothingToSave' } },
  });
  const framed = formatStatusError({
    what: 'error.localeLoad',
    detail: { kind: 'diagnostic', diag: { code: 'ui.localeLoad', vars: { locale: 'fr' } } },
  });
  const payload = formatStatusDetail({
    kind: 'diagnostic',
    diag: { code: 'ui.localeLoad', vars: { locale: 'fr' }, payload: 'TypeError: boom' },
  });
  const direct = formatDiagnostic({ code: 'io.nothingToSave' });
  const directPayload = formatDiagnostic({
    code: 'ui.localeLoad', vars: { locale: 'ru' }, payload: 'TypeError: boom',
  });
  const debug = formatStatusErrorDebug({
    what: 'error.decode', vars: { id: 'uart' },
    detail: {
      kind: 'diagnostic',
      diag: { code: 'ui.localeLoad', vars: { locale: 'fr' }, payload: 'TypeError: boom' },
    },
  });
  const debugText = formatStatusErrorDebug({
    what: 'error.openCapture', detail: { kind: 'text', text: 'zip: bad' },
  });
  const cases: [string, string, string][] = [
    ['third-party detail', thirdParty, 'open capture: zip: bad'],
    ['detail vars', withVars, 'decode uart: boom'],
    ['translated detail', translated, 'save: nothing to save'],
    ['translated detail with vars', framed,
      'Could not load the language catalog: "fr" failed to load'],
    ['payload tail', payload,
      '"fr" failed to load: TypeError: boom'],
    ['formatDiagnostic', direct, 'nothing to save'],
    ['formatDiagnostic with vars and payload', directPayload,
      '"ru" failed to load: TypeError: boom'],
    ['debug form', debug,
      'error.decode {"id":"uart"}: diagnostic.ui.localeLoad {"locale":"fr"}: TypeError: boom'],
    ['debug form of raw text', debugText, 'error.openCapture: zip: bad'],
  ];
  const bad = cases.filter(([, got, want]) => got !== want);
  check('formatStatusError joins the translated prefix with a translated or raw detail',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/${cases.length} cases match`
      : bad.map(([n, got, want]) => `${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`).join('; '));
}

{
  const expected: Partial<Record<keyof Messages, string>> = {
    'diagnostic.device.noData': 'channels,deadline,device,rate',
    'diagnostic.device.underrunStalled':
      'atMs,avg,bytes,channels,count,coverMs,device,limitMs,minimum,offered,rate,runMs,stalls,thread,transferMs,worstMs',
    'diagnostic.device.underrunClean':
      'avg,bytes,channels,count,device,limitMs,minimum,offered,rate,runMs,thread,thresholdMs,transferMs',
  };
  const bad = Object.entries(expected).filter(([key, vars]) => {
    const template = en[key as keyof Messages] ?? '';
    return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',') !== vars;
  }).map(([key]) => key);
  check('the capture-failure templates keep every measured placeholder',
    bad.length === 0, bad.length === 0 ? `${Object.keys(expected).length} templates pinned` : bad.join(', '));
}

{
  const expected: Partial<Record<keyof Messages, string>> = {
    'diagnostic.device.controlReadTimeout': 'addr,ms',
    'diagnostic.device.controlWriteTimeout': 'addr,ms',
    'diagnostic.device.controlRequestTimeout': 'ms,request',
    'diagnostic.device.controlWriteStatus': 'addr,status',
    'diagnostic.device.controlWriteLength': 'addr,bytes',
    'diagnostic.device.controlReadStatus': 'addr,status',
    'diagnostic.device.controlReadLength': 'addr,bytes',
    'diagnostic.device.registerStuck': 'cycles,readBack,wanted,where,wrote',
    'diagnostic.device.sampleLengthRejected': 'advertised,readBack,value',
    'diagnostic.device.auxReadyTimeout': 'reads,selector',
    'diagnostic.device.auxEcho': 'echoed,selector',
    'diagnostic.device.auxZeroLength': 'selector',
    'diagnostic.device.auxValueTooWide': 'advertised,selector,value,word',
    'diagnostic.device.auxWordOutside': 'bytes,selector,word',
    'diagnostic.device.auxFieldOutside': 'accepted,endByte,selector',
    'diagnostic.device.channelMaskRejected': 'advertised,mask,readBack',
    'diagnostic.device.channelMaskRejectedPadded': 'mask,readBack',
    'diagnostic.device.sampleratePayload': 'bytes',
    'diagnostic.device.samplerateStuck': 'base,before,cycles,index,rate,readBack,wrote',
    'diagnostic.device.samplerateBaseChanged': 'after,before,cycles,divider,index,rate',
    'diagnostic.device.samplerateAnswered': 'after,before,cycles,index,rate,readBack,wrote',
    'diagnostic.device.samplerateNotDivided': 'baseMHz,count,index,maxIndex,rate',
    'diagnostic.device.samplerateNotExpressible':
      'baseMHz,count,divider,index,maxDivider,maxIndex,rate',
    'diagnostic.device.samplerateUnwalked': 'passes,rate',
    'diagnostic.device.thresholdRejected': 'advertised,code,readBack',
    'diagnostic.device.testModeRejected': 'advertised,mode,readBack',
  };
  const bad = Object.entries(expected).filter(([key, vars]) => {
    const template = en[key as keyof Messages] ?? '';
    return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',') !== vars;
  }).map(([key]) => key);
  check('the register-transfer templates keep every measured placeholder',
    bad.length === 0,
    bad.length === 0 ? `${Object.keys(expected).length} templates pinned` : bad.join(', '));
}

{
  const expected: Partial<Record<keyof Messages, string>> = {
    'diagnostic.decode.channelOutOfRange': 'channel,channels',
    'diagnostic.decode.tooLong': 'max,samples,window',
    'diagnostic.decode.tooLongLoop': 'max,samples,window',
    'diagnostic.decode.edgeBudget': 'budget,edges',
    'diagnostic.decode.edgeBudgetLoop': 'budget,edges',
  };
  const bad = Object.entries(expected).filter(([key, vars]) => {
    const template = en[key as keyof Messages] ?? '';
    return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort().join(',') !== vars;
  }).map(([key]) => key);
  check('the decode templates keep every measured placeholder',
    bad.length === 0,
    bad.length === 0 ? `${Object.keys(expected).length} templates pinned` : bad.join(', '));
}

{
  const dicts: [string, Messages][] = [['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr]];
  const bad: string[] = [];
  for (const code of DIAGNOSTIC_CODES) {
    const key = `diagnostic.${code}` as keyof Messages;
    const template = en[key];
    const names = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    if (names.length === 0) continue;
    const vars = Object.fromEntries(names.map((n) => [n, `<<${n}>>`]));
    for (const [locale, dict] of dicts) {
      const rendered = translate(dict, key, vars);
      const missing = names.filter((n) => !rendered.includes(`<<${n}>>`));
      if (missing.length > 0) bad.push(`${locale}:${key} drops ${missing.join('/')}`);
      if (/[{}]/.test(rendered)) bad.push(`${locale}:${key} leaves a placeholder`);
    }
  }
  const withVars = DIAGNOSTIC_CODES.filter((code) =>
    /\{\w+\}/.test(en[`diagnostic.${code}` as keyof Messages]));
  check('every diagnostic template substitutes each of its vars in every locale',
    bad.length === 0 && withVars.length > 0,
    bad.length === 0 ? `${withVars.length} var-bearing templates x ${dicts.length} locales render clean`
      : bad.join('; '));
}

{
  const samples = '2.15 G';
  const max = '2.14 G';
  const window = '10.74 s';
  const edges = '51.2 M';
  const budget = '48 M';
  const cases: [keyof Messages, string, Record<string, string | number>][] = [
    ['diagnostic.decode.tooLong', 'the sub-range sentence', { samples, max, window }],
    ['diagnostic.decode.tooLongLoop', 'the loop-window sentence', { samples, max, window }],
    ['diagnostic.decode.edgeBudget', 'the zoom sentence', { edges, budget }],
    ['diagnostic.decode.edgeBudgetLoop', 'the edge loop-window sentence', { edges, budget }],
  ];
  const dicts: [string, Messages][] = [['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr]];
  const bad: string[] = [];
  for (const [code, label, vars] of cases) {
    for (const [locale, dict] of dicts) {
      const rendered = translate(dict, code, vars);
      const missing = Object.entries(vars)
        .filter(([, value]) => !rendered.includes(String(value)))
        .map(([name]) => name);
      if (missing.length > 0) bad.push(`${locale}:${label} drops ${missing.join('/')}`);
      if (/[{}]/.test(rendered)) bad.push(`${locale}:${label} leaves a placeholder`);
    }
  }
  for (const [locale, dict] of dicts) {
    if (dict['diagnostic.decode.tooLong'] === dict['diagnostic.decode.tooLongLoop']) {
      bad.push(`${locale}: the two sample-limit sentences are identical`);
    }
    if (dict['diagnostic.decode.edgeBudget'] === dict['diagnostic.decode.edgeBudgetLoop']) {
      bad.push(`${locale}: the two edge-budget sentences are identical`);
    }
  }
  check('a rendered decode-limit failure shows every measured value in every locale',
    bad.length === 0, bad.length === 0 ? `${cases.length * dicts.length} renderings complete` : bad.join('; '));
}

{
  const dicts: [string, Messages][] = [['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr]];
  const bad = dicts.filter(([, dict]) => (
    !dict['diagnostic.decode.tooLong'].includes('200 MS/s') ||
    !dict['diagnostic.decode.tooLongLoop'].includes('200 MS/s')
  )).map(([locale]) => locale);
  check('the decode-limit duration parenthetical keeps its rate notation in every locale',
    bad.length === 0,
    bad.length === 0 ? `${dicts.length} locales carry 200 MS/s` : bad.join(', '));
}

{
  const noDataVars = { device: 'Slogic32 U3', deadline: 720, channels: 32, rate: 100 };
  const stalledVars = {
    device: 'Slogic32 U3', channels: 32, rate: 200, offered: 800, count: 5,
    transferMs: '18.00', bytes: 786432, limitMs: '9.75', avg: 731, runMs: 1180,
    minimum: 760, thread: 'worker', stalls: 2, worstMs: '46.8', atMs: 415, coverMs: '19.6',
  };
  const cleanVars = {
    device: 'Slogic32 U3', channels: 16, rate: 16, offered: 32, count: 4,
    transferMs: '380.00', bytes: 1024, limitMs: '1.75', avg: 30, runMs: 360,
    minimum: 30.4, thread: 'page', thresholdMs: 8,
  };
  const cases: [keyof Messages, string, Record<string, string | number>][] = [
    ['diagnostic.device.noData', 'the wedged-board sentence', noDataVars],
    ['diagnostic.device.underrunStalled', 'the stalled-thread sentence', stalledVars],
    ['diagnostic.device.underrunClean', 'the clean-thread sentence', cleanVars],
  ];
  const dicts: [string, Messages][] = [['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr]];
  const bad: string[] = [];
  for (const [code, label, vars] of cases) {
    for (const [locale, dict] of dicts) {
      const rendered = translate(dict, code, vars);
      const missing = Object.entries(vars)
        .filter(([, value]) => !rendered.includes(String(value)))
        .map(([name]) => name);
      if (missing.length > 0) bad.push(`${locale}:${label} drops ${missing.join('/')}`);
      if (/[{}]/.test(rendered)) bad.push(`${locale}:${label} leaves a placeholder`);
      if (!/FIFO/i.test(rendered) && code.startsWith('diagnostic.device.underrun')) {
        bad.push(`${locale}:${label} loses the FIFO-overflow meaning`);
      }
    }
  }
  check('a rendered capture failure shows every measured value in every locale',
    bad.length === 0, bad.length === 0 ? `${cases.length * dicts.length} renderings complete` : bad.join('; '));
}

{
  const diag = statusDetailOf(new DiagnosticError('io.nothingToSave'));
  const rebuilt = statusDetailOf(fromWireDiagnostic({ message: 'io.nothingToSave', code: 'io.nothingToSave' }));
  const unknownCode = fromWireDiagnostic({ message: 'skewed worker text', code: 'device.fromTheFuture' });
  const skew = statusDetailOf(unknownCode);
  const plain = statusDetailOf(new Error('zip: bad'));
  const thrown = statusDetailOf('not an error');
  const wire = wireDiagnostic(new DiagnosticError('ui.localeLoad', { locale: 'ru' }, 'TypeError: boom'));
  const wirePlain = wireDiagnostic(new Error('zip: bad'));
  check('statusDetailOf keeps authored errors structured and third-party text verbatim',
    diag.kind === 'diagnostic' && diag.diag.code === 'io.nothingToSave' &&
    rebuilt.kind === 'diagnostic' && rebuilt.diag.code === 'io.nothingToSave' &&
    skew.kind === 'text' && skew.text === 'skewed worker text' &&
    plain.kind === 'text' && plain.text === 'zip: bad' &&
    thrown.kind === 'text' && thrown.text === 'not an error' &&
    wire?.code === 'ui.localeLoad' && wire.vars?.locale === 'ru' && wire.payload === 'TypeError: boom' &&
    wirePlain === null,
    JSON.stringify({ diag, rebuilt, skew, plain, thrown, wire, wirePlain }));
}

{
  const diagnosticKeys = Object.keys(en).filter((k) => k.startsWith('diagnostic.'));
  const codes = new Set<string>(DIAGNOSTIC_CODES);
  const stale = diagnosticKeys.filter((k) => !codes.has(k.slice('diagnostic.'.length)));
  const uncovered = DIAGNOSTIC_CODES.filter((c) => !diagnosticKeys.includes(`diagnostic.${c}`));
  const duplicates = diagnosticKeys.filter((k) => DIAGNOSTIC_CODES.filter((c) => `diagnostic.${c}` === k).length > 1);
  const pass = stale.length === 0 && uncovered.length === 0 && duplicates.length === 0 &&
    diagnosticKeys.length === DIAGNOSTIC_CODES.length;
  check('every diagnostic.* catalog key matches one DIAGNOSTIC_CODES entry and vice versa',
    pass,
    pass ? `${diagnosticKeys.length} keys cover ${DIAGNOSTIC_CODES.length} codes`
      : [
        ...stale.map((k) => `stale ${k}`),
        ...uncovered.map((c) => `uncovered ${c}`),
        ...duplicates.map((k) => `duplicate ${k}`),
        `codes=${DIAGNOSTIC_CODES.length} keys=${diagnosticKeys.length}`,
      ].join('; '));
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const renderer = fs.readFileSync('src/render/waveformRenderer.ts', 'utf8');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const throwSite = renderer.includes("new DiagnosticError('render.contextLost')") &&
    !renderer.includes('WebGL context was lost; the renderer is dead');
  const route = /catch \(e\) \{\s*this\.fail\('error\.render', e\);\s*\}/.test(app);
  check('render.contextLost is thrown by the renderer and reaches the error banner',
    throwSite && route, `throw=${throwSite} route=${route}`);
}

{
  const traceback = 'Traceback (most recent call last):\n  File "/decoders/uart.py", line 118\n' +
    'srdengine.SigrokDecodeError: bad parity';
  const limitSentence =
    '51.2 M edges on the mapped channels exceed the 48 M decode budget. ' +
    'Disable a channel or zoom the capture down.';
  const cases: [AnalyzerNote, string][] = [
    [{ kind: 'pending' }, 'not decoded'],
    [{ kind: 'edges', count: 2048 }, '2,048 edges'],
    [{ kind: 'stats', anns: 512, decodeMs: 41.6, wallMs: 87.4 }, '512 anns, 42 ms (87 ms wall)'],
    [{ kind: 'stats', anns: 1, decodeMs: 2, wallMs: 3, firstError: 'uart: bad frame' },
      '1 anns, 2 ms (3 ms wall) · uart: bad frame'],
    [{ kind: 'stats', anns: 3, decodeMs: 1, wallMs: 2, snapshot: true },
      '3 anns, 1 ms (2 ms wall) · snapshot of a running loop - does not track the capture'],
    [{ kind: 'timeout' }, 'timed out'],
    [{ kind: 'cancelled' }, 'cancelled'],
    [{ kind: 'error', detail: 'worker exploded' }, 'worker exploded'],
    [{ kind: 'error', detail: traceback, diag: { code: 'decode.workerFailed', payload: traceback } },
      `the decoder failed: ${traceback}`],
    [{
      kind: 'error', detail: 'decode.edgeBudget',
      diag: { code: 'decode.edgeBudget', vars: { edges: '51.2 M', budget: '48 M' } },
    }, limitSentence],
  ];
  const bad = cases.filter(([note, want]) => formatAnalyzerNote(note) !== want);
  check('formatAnalyzerNote renders every variant, a diagnostic through its translated sentence',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/10 variants match`
      : bad.map(([n, want]) => `${n.kind}: got ${JSON.stringify(formatAnalyzerNote(n))} want ${JSON.stringify(want)}`).join('; '));
}

{
  const rendered = formatAnalyzerNote({
    kind: 'error', detail: 'decode.edgeBudget',
    diag: { code: 'decode.edgeBudget', vars: { edges: '51.2 M', budget: '48 M' } },
  });
  check('a payload-free diagnostic note never leaks its message key',
    !rendered.includes('decode.edgeBudget') && !rendered.includes('diagnostic.') &&
      rendered.includes('51.2 M') && rendered.includes('48 M'),
    JSON.stringify(rendered));
}

{
  const cases: [AnalyzerNote, AnalyzerStatus, string][] = [
    [{ kind: 'stats', anns: 512, decodeMs: 41.6, wallMs: 87.4 }, 'done', ''],
    [{ kind: 'stats', anns: 1, decodeMs: 2, wallMs: 3, firstError: 'uart: bad frame' },
      'done', 'uart: bad frame'],
    [{ kind: 'stats', anns: 3, decodeMs: 1, wallMs: 2, snapshot: true },
      'done', 'snapshot of a running loop - does not track the capture'],
    // A snapshot that also reported a decoder error keeps both: the tag is a warning,
    // and hiding it behind the diagnostic would claim the result tracks the capture.
    [{ kind: 'stats', anns: 1, decodeMs: 2, wallMs: 3, firstError: 'uart: bad frame', snapshot: true },
      'done', 'snapshot of a running loop - does not track the capture · uart: bad frame'],
    [{ kind: 'stats', anns: 0, decodeMs: 1, wallMs: 2 }, 'done', 'no annotations'],
    [{ kind: 'stats', anns: 512, decodeMs: 41.6, wallMs: 87.4 }, 'decoding', 'decoding…'],
    [{ kind: 'pending' }, 'decoding', 'decoding…'],
    [{ kind: 'pending' }, 'idle', 'not decoded'],
    [{ kind: 'edges', count: 2048 }, 'done', '2,048 edges'],
    [{ kind: 'timeout' }, 'error', 'timed out'],
    [{ kind: 'cancelled' }, 'idle', 'cancelled'],
    [{ kind: 'error', detail: 'worker exploded' }, 'error', 'worker exploded'],
    [{
      kind: 'error', detail: 'decode.edgeBudget',
      diag: { code: 'decode.edgeBudget', vars: { edges: '51.2 M', budget: '48 M' } },
    }, 'error',
    '51.2 M edges on the mapped channels exceed the 48 M decode budget. ' +
      'Disable a channel or zoom the capture down.'],
  ];
  const bad = cases.filter(([note, status, want]) => formatMountedAnalyzerNote(note, status) !== want);
  check('formatMountedAnalyzerNote hides statistics, keeps diagnostics, delegates the rest',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/13 cases match`
      : bad.map(([n, s, want]) => `${n.kind}/${s}: got ` +
        `${JSON.stringify(formatMountedAnalyzerNote(n, s))} want ${JSON.stringify(want)}`).join('; '));
}

// -------------------------------------------------------- trigger summary

const baseSettings: CaptureSettings = {
  channels: 16, samplerate: 16e6, thresholdVolts: 1.2, mode: 'single', seconds: 1,
  singleUnlimited: false, repeatIntervalSeconds: 1, loopSamples: 16_000_000, analogTriggers: {}, triggerSource: 'digital',
  testMode: 0, triggerEnableMask: true, softwareTrigger: true, triggerModes: {},
  triggerConditions: [], triggerChannel: 0,
  triggerKind: 'rising', triggerLevel: 1, preTriggerPercent: 10,
};

{
  const cases: [CaptureSettings, number, string][] = [
    [{ ...baseSettings }, 0, 'Rising edge · 10% pre-trigger'],
    [{ ...baseSettings, triggerKind: 'level', triggerLevel: 0 }, 0, 'Level 0 · 10% pre-trigger'],
    [{ ...baseSettings, triggerKind: 'edge' }, 3, 'Any edge · 10% pre-trigger'],
    [{ ...baseSettings, triggerConditions: [
      { channel: 2, kind: 'falling', level: 1 }, { channel: 3, kind: 'level', level: 1 }] }, 2,
      'Falling edge · 10% pre-trigger · AND 2 conditions'],
    [{ ...baseSettings, triggerConditions: [
      { channel: 2, kind: 'falling', level: 1 }, { channel: 3, kind: 'level', level: 1 }] }, 3,
      'Level 1 · 10% pre-trigger · AND 2 conditions'],
  ];
  const bad = cases.filter(([s, ch, want]) => formatTriggerSummary(s, ch) !== want);
  check('formatTriggerSummary renders conditions and the AND suffix exactly',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/5 cases match`
      : bad.map(([s, ch, want]) => `ch${ch}: got ${JSON.stringify(formatTriggerSummary(s, ch))} want ${JSON.stringify(want)}`).join('; '));
}

// ------------------------------------------- catalog parity across locales
// tsc already proves it structurally (each catalog is `: Messages`); this runtime
// mirror catches a catalog that cheated with `as Messages`, and a locale that ships
// untranslated English values wholesale.

{
  const enKeys = Object.keys(en).sort().join('\n');
  const others: [string, Messages][] = [['zh-CN', zhCN], ['ru', ru], ['fr', fr]];
  const bad = others.filter(([, dict]) => Object.keys(dict).sort().join('\n') !== enKeys);
  check('every locale catalog has exactly the English key set at runtime',
    bad.length === 0,
    bad.length === 0 ? `${others.length} catalogs in parity (${Object.keys(en).length} keys)`
      : bad.map(([l]) => l).join(', '));
}

{
  const retired = [
    'channels.dialogDescription', 'channels.moreColors', 'bus.fixedBits', 'bus.dragToOrder',
    'bus.bankEnabledNote', 'bus.bankDisableNote', 'bus.bankDisabledNote',
    'bus.bankDialogTitle', 'bus.enableBank', 'bus.channelOrder',
    'capturePanel.oscilloscopeConfig', 'capturePanel.oscilloscopeEnabled',
    'capturePanel.oscilloscopeDisabled', 'capturePanel.channelLocked',
    'capturePanel.oscilloscopeActive', 'capturePanel.oscilloscopeTakeover',
    'capturePanel.loop', 'capturePanel.retentionSamples', 'capturePanel.retentionNote',
    'capturePanel.loopRetention', 'capturePanel.timeUnit',
    'capturePanel.loopCeilingNote',
    'capturePanel.freeRun', 'capturePanel.timer', 'capturePanel.durationS',
    'capturePanel.repeatIntervalS', 'capturePanel.loopSamples',
    'capturePanel.repeatPending', 'capturePanel.ceilingNote',
    'capturePanel.all', 'capturePanel.clear', 'capturePanel.enabledCount',
    'capturePanel.bankToggle', 'capturePanel.bankLocked',
    'bus.loopWindow', 'bus.globalCapture', 'bus.loopUnit', 'bus.loopMax', 'bus.loopEffective',
    'bus.loopInvalid', 'bus.loopUnavailable', 'bus.advanced',
    'toolbar.demo', 'toolbar.shortDemo', 'toolbar.demoTitle', 'toolbar.demoLoading', 'error.demo',
    'capture.demo',
    'status.previousWave', 'status.summary', 'status.total', 'status.loop', 'status.view',
  ];
  const dicts: Record<string, Messages> = { en, 'zh-CN': zhCN, ru, fr };
  const present = Object.entries(dicts).filter(([, dict]) =>
    retired.some((key) => Object.keys(dict).includes(key)));
  check('the retired channel, bank, capture, capture-panel and toolbar keys stay absent from every catalog',
    present.length === 0,
    present.length === 0 ? `4 catalogs omit ${retired.length} keys` : present.map(([locale]) => locale).join(', '));
}

{
  const names = [en['bus.defaultName'], zhCN['bus.defaultName'], ru['bus.defaultName'], fr['bus.defaultName']];
  check('the bank default waveform name is localized in all four catalogs',
    names.join('|') === 'Analog waveform|模拟波形|Аналоговая форма волны|Forme d’onde analogique',
    names.join(' | '));
}

{
  // A catalog that silently shipped the English text would pass parity and fail users.
  // Assert the PROPERTY (translated ≠ English) on salient keys, not exact wording, so a
  // legitimate rewording does not break the check. A locale missing from `dicts` is a
  // clean FAIL, not a crash.
  const probes: (keyof Messages)[] = [
    'toolbar.start', 'settings.language', 'settings.theme',
    'settings.detailedLabels', 'toolbar.shortDevice', 'toolbar.shortStart', 'toolbar.shortStop',
    'toolbar.shortStopping', 'toolbar.shortOpen', 'toolbar.shortSave',
    'toolbar.shortFullscreen', 'toolbar.shortSettings', 'toolbar.shortLanguage', 'toolbar.shortTheme',
    'toolbar.fullscreen', 'toolbar.enterFullscreenTitle',
    'toolbar.exitFullscreenTitle', 'toolbar.fullscreenUnavailable',
    'trigger.anyEdge',
    'channels.settings', 'channels.name', 'channels.color', 'channels.customColor',
    'channels.colorField', 'channels.hue',
    'channels.resetName',
    'channels.triggerMode', 'channels.cancel',
    'sidebar.pageCapture', 'sidebar.pageCursors', 'sidebar.pageDecoders',
    'sidebar.pagesLabel',
    'sidebar.collapse', 'sidebar.expand',
    'analyzerPanel.decoderSearchLabel',
    'bus.defaultName',
    'capturePanel.channelWidth', 'capturePanel.analog', 'capturePanel.analogCellLabel',
    'capturePanel.analogGainReadout', 'bus.removeNamed',
    'capturePanel.analogEnable', 'capturePanel.analogRateNote',
    'capturePanel.statusReady', 'capturePanel.statusCapturing',
    'capturePanel.statusStopping', 'capturePanel.statusWaiting', 'capturePanel.statusCompleted',
    'capturePanel.statusWaitingDetail', 'capturePanel.statusCompletedDetail',
    'capturePanel.singleFiniteNote', 'capturePanel.singleUnlimitedNote',
    'capturePanel.repeatFiniteNote',
    'capturePanel.cursorEdges', 'capturePanel.cursorEdgesEmpty', 'capturePanel.cursorEdgesChannel',
    'diagnostic.ui.localeLoad', 'diagnostic.io.nothingToSave',
    'diagnostic.file.unsupported', 'diagnostic.file.lwcap.magic',
    'diagnostic.file.lwcap.channels', 'diagnostic.file.lwcap.gapSpan',
    'diagnostic.file.lwcap.samplerate', 'diagnostic.file.lwcap.edgeOrder',
    'diagnostic.file.sr.notZip', 'diagnostic.file.sr.compression',
    'diagnostic.file.sr.noSamplerate',
    'diagnostic.device.transportDead', 'diagnostic.device.workerTimeout',
    'diagnostic.device.loopUnsettledClosed', 'diagnostic.device.noData',
    'diagnostic.device.underrunStalled', 'diagnostic.usb.blocked',
    'diagnostic.usb.unavailable', 'diagnostic.usb.notVisible',
    'diagnostic.device.controlReadTimeout', 'diagnostic.device.registerStuck',
    'diagnostic.device.samplerateNotExpressible',
    'diagnostic.decode.workerFailed', 'diagnostic.decode.timeout',
    'diagnostic.decode.edgeBudget',
    'diagnostic.ui.axisContext', 'diagnostic.ui.captureLocked',
    'diagnostic.device.disconnected', 'diagnostic.device.notConnected',
    'diagnostic.device.noConsole', 'diagnostic.device.unknownWidth',
    'diagnostic.device.thresholdClips', 'diagnostic.device.sampleAccounting',
    'diagnostic.decode.noCapture',
    'diagnostic.decode.channelOutOfRange',
    'diagnostic.render.contextLost',
    'hints.barLabel', 'hints.plot.scroll', 'hints.overview.center', 'hints.noCapture',
  ];
  const dicts: Record<string, Messages | undefined> = { 'zh-CN': zhCN, ru, fr };
  const enSpellings: readonly { locale: string; key: keyof Messages }[] = [
    { locale: 'fr', key: 'sidebar.pageCapture' },
  ];
  const bad: string[] = [];
  for (const l of LOCALES) {
    if (l === 'en') continue;
    const dict = dicts[l];
    if (!dict) { bad.push(`${l}: no catalog`); continue; }
    for (const k of probes) {
      const allowed = enSpellings.some((entry) => entry.locale === l && entry.key === k);
      if (dict[k] === en[k] && !allowed) bad.push(`${l}:${k} is still English`);
    }
  }
  check('each locale actually translates the salient probe keys',
    bad.length === 0,
    bad.length === 0 ? LOCALES.map((l) => `${l}=${dicts[l]?.['toolbar.start'] ?? 'English'}`).join(', ')
      : bad.join('; '));
}

{
  const shortKeys = (Object.keys(en) as (keyof Messages)[]).filter((key) => key.startsWith('toolbar.short'));
  const bad = shortKeys.filter((key) => {
    const hanCount = zhCN[key].match(/\p{Script=Han}/gu)?.length ?? 0;
    return hanCount === 0 || hanCount > 4;
  });
  check('every Chinese toolbar shorthand contains one to four Han characters',
    shortKeys.length >= 11 && bad.length === 0,
    bad.length === 0 ? `${shortKeys.length} concise labels` : bad.join(', '));
}

{
  const namePairs: [keyof Messages, keyof Messages][] = [
    ['toolbar.shortDevice', 'toolbar.device'], ['toolbar.shortStart', 'toolbar.start'],
    ['toolbar.shortStop', 'toolbar.stop'], ['toolbar.shortStopping', 'toolbar.stopping'],
    ['toolbar.shortOpen', 'toolbar.open'],
    ['toolbar.shortSave', 'toolbar.save'],
    ['toolbar.shortFullscreen', 'toolbar.fullscreen'],
    ['toolbar.shortSettings', 'settings.title'], ['toolbar.shortAssistant', 'toolbar.assistantTitle'],
    ['toolbar.shortLanguage', 'toolbar.languageTitle'], ['toolbar.shortTheme', 'toolbar.themeTitle'],
  ];
  const catalogs: Record<Locale, Messages> = { en, 'zh-CN': zhCN, ru, fr };
  const bad: string[] = [];
  for (const locale of LOCALES) {
    for (const [shortKey, nameKey] of namePairs) {
      const short = catalogs[locale][shortKey].toLocaleLowerCase();
      const name = catalogs[locale][nameKey].toLocaleLowerCase();
      if (!name.includes(short)) bad.push(`${locale}:${shortKey} is absent from ${nameKey}`);
    }
  }
  check('every visual toolbar shorthand is contained in its full accessible name',
    bad.length === 0, bad.join('; ') || `${LOCALES.length} locales × ${namePairs.length} commands`);
}

// ------------------------------------------- async catalog loader + switch path
// The registry/async design is exercised through the public API: the loaders really
// load (identity AND parity are re-checked through the async path, not via the test's
// own static imports), switches round-trip, a superseded pick loses WITHOUT notifying,
// and a pick of the active locale still cancels an in-flight pick.

{
  const enKeys = Object.keys(en).sort().join('\n');
  const staticById: Record<Locale, Messages> = { en, 'zh-CN': zhCN, ru, fr };
  const bad: string[] = [];
  for (const l of LOCALES) {
    try {
      const dict = await loadCatalog(l);
      // A loader that resolved the wrong same-keyed catalog would still pass the
      // key-parity check; identity pins it to the catalog file it names.
      if (dict !== staticById[l]) bad.push(`${l}: loader returned a different object`);
      if (Object.keys(dict).sort().join('\n') !== enKeys) bad.push(`${l}: key set differs from en`);
    } catch (err) {
      bad.push(`${l}: load failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  check('every LOCALES entry loads through the async loader to its own catalog, key parity holds',
    bad.length === 0,
    bad.length === 0 ? `${LOCALES.length} locales loaded, identity + key parity hold` : bad.join('; '));
}

{
  // Async round-trip: fr really becomes active (t() serves the French value), then
  // en restores. This leaves the module on 'en' so the checks below are real
  // switches rather than no-ops.
  const on = await setLocale('fr');
  const frText = t('toolbar.start');
  const off = await setLocale('en');
  const enText = t('toolbar.start');
  check('async setLocale round-trips fr and back to en',
    on === 'committed' && getLocale() === 'en' && off === 'committed' &&
    frText === fr['toolbar.start'] && frText !== en['toolbar.start'] &&
    enText === en['toolbar.start'],
    `fr→${JSON.stringify(frText)}, en→${JSON.stringify(enText)}`);
}

{
  const stored: StatusError = {
    what: 'error.device',
    detail: {
      kind: 'diagnostic',
      diag: { code: 'device.disconnected', vars: { device: 'SLogic16 U3' } },
    },
  };
  const before = formatStatusError(stored);
  const switched = await setLocale('fr');
  const after = formatStatusError(stored);
  await setLocale('en');
  const back = formatStatusError(stored);
  check('an on-screen status error retranslates on a locale switch without being rebuilt',
    switched === 'committed' &&
      before === 'device: SLogic16 U3 was disconnected' &&
      after === 'appareil: SLogic16 U3 a été déconnecté' &&
      back === before,
    `en=${JSON.stringify(before)} fr=${JSON.stringify(after)} back=${JSON.stringify(back)}`);
}

{
  // Fix-1 guard: picking the currently-active locale must STILL cancel an in-flight
  // pick. The token bump precedes the no-op fast return, so the later 'en' pick wins
  // and the 'ru' load commits nothing. Without the token-first ordering the 'ru' load
  // would commit and notify -> `fired` would be 1 and getLocale() 'ru' -> FAIL.
  await setLocale('en'); // settle on en before asserting
  let fired = 0;
  const unsubscribe = onLocaleChange(() => { fired += 1; });
  const p1 = setLocale('ru');
  const p2 = setLocale('en');
  const [r1, r2] = await Promise.all([p1, p2]);
  unsubscribe();
  check('picking the active locale cancels an in-flight pick (last pick wins)',
    r1 === 'superseded' && r2 === 'committed' && getLocale() === 'en' && fired === 0,
    `p1=${r1}, p2=${r2}, locale=${getLocale()}, listener fired ${fired}×`);
}

{
  // Rapid double-pick: the first is superseded and must resolve 'superseded' without
  // notifying; only the last commits, so exactly one re-render is queued. Without
  // the requestToken guard both would notify and `fired` would be 2 -> FAIL.
  let fired = 0;
  const unsubscribe = onLocaleChange(() => { fired += 1; });
  const p1 = setLocale('ru');
  const p2 = setLocale('fr');
  const [r1, r2] = await Promise.all([p1, p2]);
  unsubscribe();
  check('a superseded pick resolves superseded and notifies exactly once',
    r1 === 'superseded' && r2 === 'committed' && getLocale() === 'fr' && fired === 1,
    `p1=${r1}, p2=${r2}, locale=${getLocale()}, listener fired ${fired}×`);
  await setLocale('en'); // leave the suite settled on en
}

{
  // Load-failure path: an out-of-contract locale name makes LOADERS[locale]() throw
  // synchronously (not a function), and setLocale's catch must turn that into
  // 'failed' while keeping the previous locale. The `as Locale` cast simulates a bad
  // caller so the catch branch is exercised without a test-only loader seam (the same
  // structural-typing trick as the Partial<Messages> fallback pin above). Without the
  // catch the throw escapes and crashes the suite red; a commit despite the failure
  // flips getLocale() -> FAIL.
  const before = getLocale();
  const r = await setLocale('xx' as Locale);
  check('a failed catalog load keeps the previous locale',
    r === 'failed' && getLocale() === before,
    `result=${r}, locale=${getLocale()}`);
}

// ------------------------------------------- browser language detection
// node 22 exposes a getter-only `navigator` (language 'en-HK') and no `localStorage`,
// so both globals are replaced per case from saved property descriptors and restored
// in `finally`; the boot path is observed here, the real browser is not.

{
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  const useNavigator = (value: unknown): void => {
    if (value === undefined) {
      Reflect.deleteProperty(globalThis, 'navigator');
      return;
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value });
  };
  const useStorage = (value: Storage): void => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value });
  };
  const restoreGlobals = (): void => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  };

  interface FakeStorage {
    readonly api: Storage;
    readonly store: Map<string, string>;
    writes(): number;
  }

  const fakeStorage = (seed?: readonly [string, string]): FakeStorage => {
    const store = new Map<string, string>(seed ? [seed] : []);
    let count = 0;
    const api = {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        count += 1;
        store.set(key, value);
      },
      removeItem: (key: string): void => { store.delete(key); },
      clear: (): void => { store.clear(); },
      key: (): string | null => null,
      get length(): number { return store.size; },
    } as unknown as Storage;
    return { api, store, writes: () => count };
  };

  {
    const table: [unknown, readonly string[]][] = [
      [{ languages: ['fr-FR', 'fr'], language: 'en-US' }, ['fr-FR', 'fr']],
      [{ language: 'ru-RU' }, ['ru-RU']],
      [{ languages: [] }, []],
      [{ languages: ['', '  '], language: 'de-DE' }, ['de-DE']],
      [{ languages: [7, 'zu-ZA'], language: 'ru' }, ['zu-ZA']],
      [undefined, []],
    ];
    const bad: string[] = [];
    try {
      for (const [nav, want] of table) {
        useNavigator(nav);
        const got = readBrowserLanguages();
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          bad.push(`${JSON.stringify(nav)}→${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
      }
    } finally {
      restoreGlobals();
    }
    check('readBrowserLanguages follows languages -> language -> nothing, skipping unusable tags',
      bad.length === 0,
      bad.length === 0 ? `${table.length} navigator shapes` : bad.join('; '));
  }

  {
    const fake = fakeStorage();
    let locale: Locale = 'en';
    let text = '';
    let writes = -1;
    let persisted: string | null = null;
    try {
      await setLocale('en');
      useNavigator({ languages: ['fr-FR', 'fr'], language: 'fr-FR' });
      useStorage(fake.api);
      locale = await initLocale();
      text = t('toolbar.start');
      writes = fake.writes();
      persisted = fake.store.get('logicweb.lang') ?? null;
    } finally {
      restoreGlobals();
      await setLocale('en');
    }
    check('initLocale adopts the browser language on a fresh profile without persisting',
      locale === 'fr' && text === fr['toolbar.start'] && text !== en['toolbar.start'] &&
        writes === 0 && persisted === null,
      `locale=${locale}, t=${JSON.stringify(text)}, writes=${writes}, `
      + `stored=${JSON.stringify(persisted)}`);
  }

  {
    const fake = fakeStorage();
    let locale: Locale = 'fr';
    try {
      await setLocale('en');
      useNavigator({ languages: ['de-DE', 'it-IT'], language: 'de-DE' });
      useStorage(fake.api);
      locale = await initLocale();
    } finally {
      restoreGlobals();
      await setLocale('en');
    }
    check('initLocale stays on en when no browser language is supported',
      locale === 'en' && fake.writes() === 0 && fake.store.size === 0,
      `locale=${locale}, writes=${fake.writes()}, stored=${JSON.stringify([...fake.store])}`);
  }

  {
    const fake = fakeStorage(['logicweb.lang', 'ru']);
    let locale: Locale = 'en';
    let text = '';
    let writes = -1;
    try {
      await setLocale('en');
      useNavigator({ languages: ['fr-FR'], language: 'fr-FR' });
      useStorage(fake.api);
      locale = await initLocale();
      text = t('toolbar.start');
      writes = fake.writes();
    } finally {
      restoreGlobals();
      await setLocale('en');
    }
    check('initLocale keeps a stored locale over the browser language and writes nothing',
      locale === 'ru' && text === ru['toolbar.start'] && writes === 0,
      `locale=${locale}, t=${JSON.stringify(text)}, writes=${writes}`);
  }

  {
    const fake = fakeStorage();
    let result = '';
    try {
      await setLocale('en');
      useStorage(fake.api);
      result = await setLocale('fr');
    } finally {
      restoreGlobals();
      await setLocale('en');
    }
    const persisted = fake.store.get('logicweb.lang') ?? null;
    check('an explicit pick still persists exactly once',
      result === 'committed' && fake.writes() === 1 && persisted === 'fr',
      `result=${result}, writes=${fake.writes()}, stored=${JSON.stringify(persisted)}`);
  }
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
