import { capturePanelNoteHidden, hiddenCapturePanelNotes } from '../panelNoteVisibility.js';
import { en, type Messages } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const read = (path: string): string => fs.readFileSync(path, 'utf8');

const HIDDEN_KEYS: readonly (keyof Messages)[] = [
  'capturePanel.analogRateNote',
  'capturePanel.dacNote',
  'capturePanel.dacNoteAdvised',
  'capturePanel.singleFiniteNote',
  'capturePanel.repeatFiniteNote',
  'capturePanel.repeatLayersNote',
  'capturePanel.loopWindowLimit',
];

const NEGATIVE_KEYS: readonly string[] = [
  'capturePanel.repeatSearchNote',
  'capturePanel.dacNotes',
  '',
];

const catalogs: Array<[string, Messages]> = [['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr]];

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

const placeholders = (text: string): string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) found.add(match[1]!);
  return [...found].sort();
};

interface CatalogReport {
  missing: string[];
  empty: string[];
  drift: string[];
}

const catalogReport = (list: Array<[string, Messages]>): CatalogReport => {
  const missing: string[] = [];
  const empty: string[] = [];
  const drift: string[] = [];
  for (const key of HIDDEN_KEYS) {
    const sets = list.map(([locale, dict]) => {
      const text = dict[key];
      if (typeof text !== 'string' || text === '') missing.push(`${locale}:${key}`);
      else if (text.trim() === '') empty.push(`${locale}:${key}`);
      return typeof text === 'string' ? placeholders(text).join(',') : '<absent>';
    });
    if (sets.some((set) => set !== sets[0])) drift.push(`${key}[${sets.join(' | ')}]`);
  }
  return { missing, empty, drift };
};

const catalogMatches = (report: CatalogReport): boolean =>
  report.missing.length === 0 && report.empty.length === 0 && report.drift.length === 0;

const catalogDetail = (report: CatalogReport): string =>
  `missing=${JSON.stringify(report.missing)}, empty=${JSON.stringify(report.empty)}, ` +
  `drift=${JSON.stringify(report.drift)}`;

const withZhValue = (key: keyof Messages, value: string): Array<[string, Messages]> =>
  catalogs.map(([locale, dict]) =>
    locale === 'zh-CN' ? [locale, { ...dict, [key]: value }] : [locale, dict]);

const CSS_RULE = '.panel-note[hidden] { display: none; }';
const CSS_BASE = '.panel-note {';
const css = read('src/ui/style.css');

const hasNoteHiddenRule = (source: string): boolean => source.includes(CSS_RULE);

const followsNoteBaseRule = (source: string): boolean => {
  const lines = source.split('\n');
  const baseIndex = lines.findIndex((line) => line.startsWith(CSS_BASE));
  if (baseIndex < 0) return false;
  let next = baseIndex + 1;
  while (next < lines.length && lines[next]!.trim() === '') next += 1;
  return next < lines.length && lines[next]!.trim() === CSS_RULE;
};

{
  const actual = [...hiddenCapturePanelNotes];
  const extras = actual.filter((key) => !(HIDDEN_KEYS as readonly string[]).includes(key));
  const missing = HIDDEN_KEYS.filter((key) => !hiddenCapturePanelNotes.has(key));
  check('the registry lists exactly the seven retired capture panel keys',
    extras.length === 0 && missing.length === 0 && actual.length === HIDDEN_KEYS.length &&
    HIDDEN_KEYS.length === 7,
    `extras=${JSON.stringify(extras)}, missing=${JSON.stringify(missing)}, ` +
    `size=${hiddenCapturePanelNotes.size}, expected=7, listed=${HIDDEN_KEYS.length}`);
}

{
  const registered = HIDDEN_KEYS.filter((key) => capturePanelNoteHidden(key));
  const unregistered = NEGATIVE_KEYS.filter((key) => capturePanelNoteHidden(key));
  check('capturePanelNoteHidden answers only for registered keys',
    registered.length === HIDDEN_KEYS.length && unregistered.length === 0,
    `registered=${registered.length}/${HIDDEN_KEYS.length}, ` +
    `unregistered=${JSON.stringify(unregistered)}, negatives=${JSON.stringify(NEGATIVE_KEYS)}`);
}

{
  const report = catalogReport(catalogs);
  check('all seven keys stay non-empty in en/zh-CN/fr/ru with identical placeholder sets',
    catalogMatches(report), `${catalogDetail(report)}, locales=${catalogs.map(([l]) => l).join(',')}`);
}

{
  const source = zhCN['capturePanel.singleFiniteNote'];
  const strippedText = source.replace('{max}', '');
  const stripped = withZhValue('capturePanel.singleFiniteNote', strippedText);
  const emptied = withZhValue('capturePanel.repeatLayersNote', '');
  const strippedReport = catalogReport(stripped);
  const emptiedReport = catalogReport(emptied);
  check('control: the catalogue predicate fails on a stripped placeholder and on an empty value',
    strippedText !== source && !catalogMatches(strippedReport) && !catalogMatches(emptiedReport) &&
    strippedReport.drift.length > 0 && emptiedReport.missing.length > 0 &&
    catalogMatches(catalogReport(catalogs)),
    `stripped=${JSON.stringify(strippedReport.drift)}, ` +
    `emptied=${JSON.stringify(emptiedReport.missing)}, ` +
    `baseline=${catalogMatches(catalogReport(catalogs))}`);
}

{
  check('the sheet keeps a hidden panel note unpainted, immediately after the .panel-note rule',
    hasNoteHiddenRule(css) && followsNoteBaseRule(css),
    `present=${hasNoteHiddenRule(css)}, followsBase=${followsNoteBaseRule(css)}, rule=${JSON.stringify(CSS_RULE)}`);
}

{
  const stripped = css.split(CSS_RULE).join('');
  const weakened = css.split(CSS_RULE).join('.panel-note[hidden] { display: block; }');
  const moved = [...css.split('\n').filter((line) => line.trim() !== CSS_RULE), CSS_RULE].join('\n');
  check('control: the stylesheet predicate fails for a deleted, a weakened and a relocated rule',
    !hasNoteHiddenRule(stripped) && !hasNoteHiddenRule(weakened) &&
    stripped !== css && weakened !== css && stripped.includes(CSS_BASE) &&
    hasNoteHiddenRule(moved) && !followsNoteBaseRule(moved) && followsNoteBaseRule(css),
    `stripped=${hasNoteHiddenRule(stripped)}, weakened=${hasNoteHiddenRule(weakened)}, ` +
    `movedPresent=${hasNoteHiddenRule(moved)}, movedFollowsBase=${followsNoteBaseRule(moved)}, ` +
    `strippedLength=${stripped.length}, sheetLength=${css.length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
