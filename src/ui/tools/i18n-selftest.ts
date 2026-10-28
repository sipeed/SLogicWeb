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
 *   - pickLocale falls back to 'en' for absent and for unknown stored values;
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
  formatMessage, getLocale, loadCatalog, LOCALE_LABELS, LOCALES, onLocaleChange,
  pickLocale, setLocale, t, translate, type Locale,
} from '../i18n.js';
import {
  formatAnalyzerNote, formatCaptureLabel, formatMountedAnalyzerNote, formatStatusError,
  formatTriggerSummary,
} from '../format.js';
import type { AnalyzerNote, AnalyzerStatus, CaptureLabel, CaptureSettings } from '../state.js';

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

// ------------------------------------------------------------------ translation

{
  const got = translate(undefined, 'toolbar.start');
  check('translate with no dict falls back to English',
    got === 'Start', got);
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
    'emptyHint.line1', 'emptyHint.line2',
  ];
  const expectedTitles = [
    'toolbar.startTitle', 'toolbar.openTitle', 'toolbar.saveTitle', 'toolbar.fitTitle',
    'toolbar.sidebarTitle', 'toolbar.themeTitle', 'toolbar.assistantTitle', 'settings.titleHint',
    'panel.resizeTitle',
  ];
  const expectedAriaLabels = [
    'panel.resizeLabel',
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
    ['btn-fit', 'toolbar.fit'],
    ['btn-settings', 'settings.title'],
    ['btn-assistant', 'toolbar.assistantTitle'],
    ['btn-theme', 'toolbar.themeTitle'],
    ['btn-sidebar', 'toolbar.sidebarTitle'],
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
    [{ kind: 'loaded', source: 'uart.sr @ 16 MSa/s, 16 probes', ms: 12 },
      'uart.sr @ 16 MSa/s, 16 probes · loaded in 12 ms'],
    [{ kind: 'demo' }, 'protocol demo'],
    [{ kind: 'stoppedNoTrigger', samples: 12345 }, 'no trigger · 12,345 samples retained'],
    [{ kind: 'live', samples: 12345, rate: 100e6, seconds: 0.5 },
      'live capture · 12,345 samples @ 100 MS/s · 500.0 ms'],
  ];
  const bad = cases.filter(([label, want]) => formatCaptureLabel(label) !== want);
  check('formatCaptureLabel renders all six variants byte-identical to before',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/6 variants match`
      : bad.map(([l, want]) => `${l.kind}: got ${JSON.stringify(formatCaptureLabel(l))} want ${JSON.stringify(want)}`).join('; '));
}

{
  const plain = formatStatusError({ what: 'error.openCapture', detail: 'zip: bad' });
  const withVars = formatStatusError({ what: 'error.decode', vars: { id: 'uart' }, detail: 'boom' });
  const demo = formatStatusError({ what: 'error.demo', detail: 'boom' });
  check('formatStatusError joins translated prefix with raw diagnostic detail',
    plain === 'open capture: zip: bad' && withVars === 'decode uart: boom' &&
    demo === 'demo: boom',
    `${JSON.stringify(plain)}, ${JSON.stringify(withVars)}, ${JSON.stringify(demo)}`);
}

{
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
  ];
  const bad = cases.filter(([note, want]) => formatAnalyzerNote(note) !== want);
  check('formatAnalyzerNote renders every variant, diagnostics passing through raw',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/8 variants match`
      : bad.map(([n, want]) => `${n.kind}: got ${JSON.stringify(formatAnalyzerNote(n))} want ${JSON.stringify(want)}`).join('; '));
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
    [{ kind: 'stats', anns: 512, decodeMs: 41.6, wallMs: 87.4 }, 'decoding', 'decoding…'],
    [{ kind: 'pending' }, 'decoding', 'decoding…'],
    [{ kind: 'pending' }, 'idle', 'not decoded'],
    [{ kind: 'edges', count: 2048 }, 'done', '2,048 edges'],
    [{ kind: 'timeout' }, 'error', 'timed out'],
    [{ kind: 'cancelled' }, 'idle', 'cancelled'],
    [{ kind: 'error', detail: 'worker exploded' }, 'error', 'worker exploded'],
  ];
  const bad = cases.filter(([note, status, want]) => formatMountedAnalyzerNote(note, status) !== want);
  check('formatMountedAnalyzerNote hides statistics, keeps diagnostics, delegates the rest',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/11 cases match`
      : bad.map(([n, s, want]) => `${n.kind}/${s}: got ` +
        `${JSON.stringify(formatMountedAnalyzerNote(n, s))} want ${JSON.stringify(want)}`).join('; '));
}

// -------------------------------------------------------- trigger summary

const baseSettings: CaptureSettings = {
  channels: 16, samplerate: 16e6, thresholdVolts: 1.2, mode: 'timer', seconds: 1, loopSamples: 16_000_000,
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
    'channels.dialogDescription', 'channels.moreColors', 'bus.fixedBits',
    'bus.bankEnabledNote', 'bus.bankDisableNote', 'bus.bankDisabledNote',
    'capturePanel.loop', 'capturePanel.retentionSamples', 'capturePanel.retentionNote',
    'capturePanel.loopCeilingNote',
  ];
  const dicts: Record<string, Messages> = { en, 'zh-CN': zhCN, ru, fr };
  const present = Object.entries(dicts).filter(([, dict]) =>
    retired.some((key) => Object.keys(dict).includes(key)));
  check('the retired channel, bank and capture-panel keys stay absent from every catalog',
    present.length === 0,
    present.length === 0 ? `4 catalogs omit ${retired.length} keys` : present.map(([locale]) => locale).join(', '));
}

{
  const names = [en['bus.defaultName'], zhCN['bus.defaultName'], ru['bus.defaultName'], fr['bus.defaultName']];
  check('the bank default waveform name is localized in all four catalogs',
    names.join('|') === 'Analog waveform|模拟波形|Аналоговая форма волны|Forme d’onde analogique' &&
    zhCN['bus.dragToOrder'] === '拖动即可调整解码顺序',
    names.join(' | '));
}

{
  // A catalog that silently shipped the English text would pass parity and fail users.
  // Assert the PROPERTY (translated ≠ English) on salient keys, not exact wording, so a
  // legitimate rewording does not break the check. A locale missing from `dicts` is a
  // clean FAIL, not a crash.
  const probes: (keyof Messages)[] = [
    'toolbar.start', 'toolbar.demo', 'capture.demo', 'settings.language', 'settings.theme',
    'trigger.anyEdge',
    'channels.settings', 'channels.name', 'channels.color', 'channels.customColor',
    'channels.colorField', 'channels.hue',
    'channels.resetName',
    'channels.triggerMode', 'channels.cancel',
    'toolbar.sidebarTitle', 'toolbar.sidebarDevice', 'toolbar.sidebarAnalyzers', 'toolbar.sidebarNone',
    'analyzerPanel.decoderSearchLabel',
    'bus.defaultName', 'bus.enableBank', 'bus.dragToOrder', 'bus.globalCapture', 'bus.advanced',
  ];
  const dicts: Record<string, Messages | undefined> = { 'zh-CN': zhCN, ru, fr };
  const bad: string[] = [];
  for (const l of LOCALES) {
    if (l === 'en') continue;
    const dict = dicts[l];
    if (!dict) { bad.push(`${l}: no catalog`); continue; }
    for (const k of probes) {
      if (dict[k] === en[k]) bad.push(`${l}:${k} is still English`);
    }
  }
  check('each locale actually translates the salient probe keys',
    bad.length === 0,
    bad.length === 0 ? LOCALES.map((l) => `${l}=${dicts[l]?.['toolbar.start'] ?? 'English'}`).join(', ')
      : bad.join('; '));
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

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
