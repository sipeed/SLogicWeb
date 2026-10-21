// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the analyzer panel row-action suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/analyzer-panel-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/analyzer-panel-selftest.mjs && node /tmp/analyzer-panel-selftest.mjs
 *
 * Run from the repository root (checks read sources from the CWD).
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 */

import { formatMessage } from '../i18n.js';
import { en } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const process = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!process || typeof process.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return process;
})();

const fs = (() => {
  const get = nodeProcess.getBuiltinModule;
  return (typeof get === 'function'
    ? get.call(nodeProcess, 'node:fs')
    : undefined) as FsLike | undefined;
})();
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const TEXT_MINI_COUNT = 1;
const ANALYZER_ACT_NEEDLES = 3;

const panel = fs.readFileSync('src/ui/analyzerPanel.ts', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const count = (haystack: string, re: RegExp): number => (haystack.match(re) ?? []).length;

check(
  'the decode action is no longer a text button',
  !panel.includes("button(t('analyzerPanel.decode'"),
  `needle present=${panel.includes("button(t('analyzerPanel.decode'")}`,
);

check(
  'the remove action is no longer a text button',
  !panel.includes("button(t('analyzerPanel.remove'"),
  `needle present=${panel.includes("button(t('analyzerPanel.remove'")}`,
);

check(
  'no icon library import and no shared icons module crept in',
  !/from 'lucide/.test(panel) && !fs.readdirSync('src/ui').includes('icons.ts'),
  `lucide=${/from 'lucide/.test(panel)}, icons.ts=${fs.readdirSync('src/ui').includes('icons.ts')}`,
);

const DECODE_ARC = 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8';
const DECODE_ARROW = 'M21 3v5h-5';
check(
  'the decode glyph keeps its rotate-cw geometry',
  panel.includes(DECODE_ARC) && panel.includes(DECODE_ARROW),
  `arc=${panel.includes(DECODE_ARC)}, arrow=${panel.includes(DECODE_ARROW)}`,
);

const builderNeedles = [
  "document.createElementNS(SVG_NS, 'svg')",
  "document.createElementNS(SVG_NS, 'path')",
  "svg.setAttribute('viewBox', '0 0 24 24')",
  "svg.setAttribute('aria-hidden', 'true')",
  "path.setAttribute('fill', 'none')",
  "path.setAttribute('stroke', 'currentColor')",
  "path.setAttribute('stroke-width', '2')",
  "path.setAttribute('stroke-linecap', 'round')",
  "path.setAttribute('stroke-linejoin', 'round')",
];
const builderCounts = builderNeedles.map((n) => count(panel, new RegExp(n.replace(/[.*+?^${}()[\]\\|]/g, '\\$&'), 'g')));
check(
  'both glyphs share one inline-SVG builder with the house stroke attributes',
  builderCounts.every((c) => c === 1),
  `counts=${JSON.stringify(builderCounts)}`,
);

check(
  'title and aria-label come from one string on the action button',
  panel.includes('b.title = label;') &&
    panel.includes("b.setAttribute('aria-label', label);") &&
    !/aria-label',\s*t\(/.test(panel),
  `title=${panel.includes('b.title = label;')}, aria=${panel.includes("b.setAttribute('aria-label', label);")}, divergent=${/aria-label',\s*t\(/.test(panel)}`,
);

check(
  'the decode action names its decoder',
  panel.includes("t('analyzerPanel.decodeAction', { label: a.label })"),
  `callsite=${panel.includes("t('analyzerPanel.decodeAction', { label: a.label })")}`,
);

check(
  'the decode action string interpolates the decoder label',
  formatMessage(en['analyzerPanel.decodeAction'], { label: 'UART' }) === 'Decode UART',
  `got=${formatMessage(en['analyzerPanel.decodeAction'], { label: 'UART' })}`,
);

check(
  'the remove action string interpolates the decoder label',
  formatMessage(en['analyzerPanel.removeAction'], { label: 'UART' }) === 'Remove UART',
  `got=${formatMessage(en['analyzerPanel.removeAction'], { label: 'UART' })}`,
);

const catalogs: Record<string, Record<string, string>> = { en, fr, ru, zhCN };
const coverage = Object.entries(catalogs).map(([locale, dict]) => {
  const d = dict['analyzerPanel.decodeAction'];
  const r = dict['analyzerPanel.removeAction'];
  const translated = locale === 'en' || (d !== en['analyzerPanel.decodeAction'] && r !== en['analyzerPanel.removeAction']);
  return `${locale}:${d && r && d.includes('{label}') && r.includes('{label}') && translated ? 'ok' : 'bad'}`;
});
check(
  'both action keys exist, carry {label}, and are translated in every catalog',
  coverage.every((c) => c.endsWith(':ok')),
  coverage.join(', '),
);

check(
  'the decode disabled condition is preserved verbatim',
  panel.includes("re.disabled = !v.hasCapture || a.status === 'decoding';"),
  `needle=${panel.includes("re.disabled = !v.hasCapture || a.status === 'decoding';")}`,
);

check(
  'the decode click wiring still reaches onRedecode exactly once',
  count(panel, /this\.cb\.onRedecode\(a\.id\)/g) === 1,
  `count=${count(panel, /this\.cb\.onRedecode\(a\.id\)/g)}`,
);

const REMOVE_ARM_A = 'M18 6 6 18';
const REMOVE_ARM_B = 'm6 6 12 12';
check(
  'the remove glyph keeps its cross geometry',
  panel.includes(REMOVE_ARM_A) && panel.includes(REMOVE_ARM_B),
  `armA=${panel.includes(REMOVE_ARM_A)}, armB=${panel.includes(REMOVE_ARM_B)}`,
);

check(
  'the remove action names its decoder and carries the destructive variant',
  panel.includes("t('analyzerPanel.removeAction', { label: a.label })") &&
    panel.includes("actionButton('analyzer-act analyzer-act--remove',") &&
    count(panel, /this\.cb\.onRemove\(a\.id\)/g) === 1,
  `callsite=${panel.includes("t('analyzerPanel.removeAction', { label: a.label })")}, variant=${panel.includes("actionButton('analyzer-act analyzer-act--remove',")}, onRemove=${count(panel, /this\.cb\.onRemove\(a\.id\)/g)}`,
);

const actNeedles = count(panel, /analyzer-act/g);
check(
  'the row actions carry the analyzer-act class the expected number of times',
  actNeedles === ANALYZER_ACT_NEEDLES,
  `count=${actNeedles}, expected=${ANALYZER_ACT_NEEDLES}`,
);

const miniNeedles = count(panel, /'mini'/g);
check(
  'only the not-yet-swapped actions remain text .mini buttons',
  miniNeedles === TEXT_MINI_COUNT,
  `count=${miniNeedles}, expected=${TEXT_MINI_COUNT}`,
);

const actRule = css.match(/\.analyzer-act\s*\{([^}]*)\}/)?.[1] ?? '';
const actDeclarations = [
  'flex: none',
  'display: flex',
  'align-items: center',
  'justify-content: center',
  'width: 22px',
  'height: 18px',
  'padding: 0',
  'border: 1px solid var(--border-low)',
  'background: var(--bg20)',
  'color: var(--text50)',
  'cursor: pointer',
];
const missingDeclarations = actDeclarations.filter((d) => !actRule.includes(d));
check(
  'the analyzer-act rule pins the chip geometry and quiet-chrome colors',
  actRule.length > 0 && missingDeclarations.length === 0,
  `missing=${JSON.stringify(missingDeclarations)}`,
);

check(
  'the svg sizing gate keeps the glyph at 13px (no 300x150 default box)',
  /\.analyzer-act svg\s*\{[^}]*display:\s*block[^}]*width:\s*13px[^}]*height:\s*13px[^}]*\}/.test(css),
  `match=${/\.analyzer-act svg\s*\{[^}]*display:\s*block[^}]*width:\s*13px[^}]*height:\s*13px[^}]*\}/.test(css)}`,
);

check(
  'the base hovers use the accent pair and the remove hover the negative pair',
  /\.analyzer-act:hover\s*\{[^}]*var\(--accent\)[^}]*var\(--text80\)[^}]*\}/.test(css) &&
    /\.analyzer-act--remove:hover\s*\{[^}]*var\(--negative\)[^}]*var\(--negative\)[^}]*\}/.test(css),
  `accent=${/\.analyzer-act:hover\s*\{[^}]*var\(--accent\)[^}]*var\(--text80\)[^}]*\}/.test(css)}, negative=${/\.analyzer-act--remove:hover\s*\{[^}]*var\(--negative\)[^}]*var\(--negative\)[^}]*\}/.test(css)}`,
);

const themed = /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act\s*\{([^}]*)\}/.test(css) &&
  /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act:hover\s*\{[^}]*var\(--primary\)[^}]*var\(--foreground\)[^}]*\}/.test(css) &&
  /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act--remove:hover\s*\{[^}]*var\(--destructive\)[^}]*var\(--destructive\)[^}]*\}/.test(css);
const themedBase = css.match(/:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act\s*\{([^}]*)\}/)?.[1] ?? '';
const themedTokens = ['var(--background)', 'var(--input)', 'var(--muted-foreground)', 'border-radius: calc(var(--radius) - 4px)'];
check(
  'the dark/light twins map the chip onto theme tokens',
  themed && themedTokens.every((tok) => themedBase.includes(tok)),
  `themed=${themed}, missing=${JSON.stringify(themedTokens.filter((tok) => !themedBase.includes(tok)))}`,
);

const actRules = [...css.matchAll(/[^{}]*\.analyzer-act[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
check(
  'no raw hex inside the analyzer-act rules (tokens only)',
  actRules.length === 7 && actRules.every((rule) => !/#[0-9a-fA-F]{3,8}/.test(rule)),
  `rules=${actRules.length}, hex=${actRules.filter((rule) => /#[0-9a-fA-F]{3,8}/.test(rule)).length}`,
);

console.log(results.map((result) => (
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`
)).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
