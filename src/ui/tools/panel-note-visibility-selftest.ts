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

const slice = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start);
  return end < 0 ? '' : source.slice(start, end);
};

const ANALOG_FROM = 'if (activeBanks.size > 0) {';
const ANALOG_TO = 'const code = vrefCode(s.thresholdVolts);';
const ANALOG_CONSTRUCTION = "const analogNote = div('panel-note');";
const ANALOG_TEXT = "t('capturePanel.analogRateNote')";
const ANALOG_HIDDEN =
  "analogNote.hidden = capturePanelNoteHidden('capturePanel.analogRateNote');";
const ANALOG_APPEND = 'chSec.body.appendChild(analogNote);';
const ANALOG_REMOVE = 'analogNote.remove';

const analogNoteHidden = (source: string): boolean =>
  source.includes(ANALOG_CONSTRUCTION) && source.includes(ANALOG_TEXT) &&
  source.includes(ANALOG_HIDDEN) && source.includes(ANALOG_APPEND) &&
  !source.includes(ANALOG_REMOVE);

{
  const panel = read('src/ui/capturePanel.ts');
  const block = slice(panel, ANALOG_FROM, ANALOG_TO);
  check('the analog rate note is built, appended and hidden by the registry',
    block !== '' && analogNoteHidden(block),
    `length=${block.length}, construction=${block.includes(ANALOG_CONSTRUCTION)}, ` +
    `text=${block.includes(ANALOG_TEXT)}, hidden=${block.includes(ANALOG_HIDDEN)}, ` +
    `append=${block.includes(ANALOG_APPEND)}, remove=${block.includes(ANALOG_REMOVE)}`);
}

{
  const panel = read('src/ui/capturePanel.ts');
  const block = slice(panel, ANALOG_FROM, ANALOG_TO);
  const stripped = block.split(`${ANALOG_HIDDEN}\n`).join('');
  const unappended = block.split(`${ANALOG_APPEND}\n`).join('');
  const strippedPass = analogNoteHidden(stripped);
  const unappendedPass = analogNoteHidden(unappended);
  check('control: the analog note predicate fails without the hidden line or without the append',
    block !== '' && analogNoteHidden(block) && stripped !== block && unappended !== block &&
    !strippedPass && !unappendedPass,
    `baseline=${analogNoteHidden(block)}, stripped=${strippedPass}, ` +
    `unappended=${unappendedPass}, strippedLength=${stripped.length}, ` +
    `unappendedLength=${unappended.length}, blockLength=${block.length}`);
}

const DAC_FROM = 'const code = vrefCode(s.thresholdVolts);';
const DAC_TO = 'capture.appendChild(chSec.el);';
const DAC_CONSTRUCTION = "const note = div('panel-note');";
const DAC_ADVISED_TEXT = "t('capturePanel.dacNoteAdvised'";
const DAC_TEXT = "t('capturePanel.dacNote'";
const DAC_HIDDEN_OPEN = 'note.hidden = capturePanelNoteHidden(';
const DAC_APPEND_CALL = 'chSec.body.appendChild(note';
const DAC_APPEND = `${DAC_APPEND_CALL});`;
const DAC_REMOVE = 'note.remove';
const DAC_PREDICATE = 'advised !== undefined && advised < ceiling';
const DAC_ADVISED_KEY = "'capturePanel.dacNoteAdvised'";
const DAC_KEY = "'capturePanel.dacNote'";

const dacHiddenArgument = (source: string): string => {
  const start = source.indexOf(DAC_HIDDEN_OPEN);
  if (start < 0) return '';
  const end = source.indexOf(');', start + DAC_HIDDEN_OPEN.length);
  return end < 0 ? '' : source.slice(start + DAC_HIDDEN_OPEN.length, end);
};

const dacAdvisesFirst = (argument: string): boolean => {
  const advisedAt = argument.indexOf(DAC_ADVISED_KEY);
  const plainAt = argument.indexOf(DAC_KEY);
  return advisedAt >= 0 && plainAt > advisedAt;
};

const dacNoteHidden = (source: string): boolean => {
  const argument = dacHiddenArgument(source);
  return source.includes(DAC_CONSTRUCTION) && source.includes(DAC_ADVISED_TEXT) &&
    source.includes(DAC_TEXT) && source.includes(DAC_HIDDEN_OPEN) && source.includes(DAC_APPEND) &&
    !source.includes(DAC_REMOVE) && argument.includes(DAC_PREDICATE) &&
    argument.includes(DAC_ADVISED_KEY) && argument.includes(DAC_KEY) &&
    dacAdvisesFirst(argument) && !argument.includes(DAC_APPEND_CALL);
};

{
  const panel = read('src/ui/capturePanel.ts');
  const block = slice(panel, DAC_FROM, DAC_TO);
  const argument = dacHiddenArgument(block);
  check('the DAC threshold note is built, appended and hidden per rendered variant',
    block !== '' && dacNoteHidden(block),
    `length=${block.length}, construction=${block.includes(DAC_CONSTRUCTION)}, ` +
    `advisedText=${block.includes(DAC_ADVISED_TEXT)}, text=${block.includes(DAC_TEXT)}, ` +
    `hidden=${block.includes(DAC_HIDDEN_OPEN)}, append=${block.includes(DAC_APPEND)}, ` +
    `remove=${block.includes(DAC_REMOVE)}, predicate=${argument.includes(DAC_PREDICATE)}, ` +
    `advisedKey=${argument.includes(DAC_ADVISED_KEY)}, key=${argument.includes(DAC_KEY)}, ` +
    `advisesFirst=${dacAdvisesFirst(argument)}, ` +
    `bleed=${argument.includes(DAC_APPEND_CALL)}, ` +
    `argumentLength=${argument.length}`);
}

{
  const panel = read('src/ui/capturePanel.ts');
  const block = slice(panel, DAC_FROM, DAC_TO);
  const start = block.indexOf(DAC_HIDDEN_OPEN);
  const end = start < 0 ? -1 : block.indexOf(');', start + DAC_HIDDEN_OPEN.length);
  const stripped = start < 0 || end < 0 ? block : block.slice(0, start) + block.slice(end + 2);
  const weakened = start < 0 || end < 0 ? block
    : block.slice(0, start) + `${DAC_HIDDEN_OPEN}'capturePanel.dacNote');` + block.slice(end + 2);
  const invertedSpan = start < 0 || end < 0 ? ''
    : block.slice(start, end + 2).replace(DAC_ADVISED_KEY, '\u0001')
      .replace(DAC_KEY, DAC_ADVISED_KEY).replace('\u0001', DAC_KEY);
  const inverted = start < 0 || end < 0 ? block
    : block.slice(0, start) + invertedSpan + block.slice(end + 2);
  const bleeding = start < 0 || end < 0 ? block
    : block.slice(0, start) + block.slice(start, end) + '\n    ;' + block.slice(end + 2);
  const strippedPass = dacNoteHidden(stripped);
  const weakenedPass = dacNoteHidden(weakened);
  const invertedPass = dacNoteHidden(inverted);
  const bleedingPass = dacNoteHidden(bleeding);
  check('control: the DAC note predicate fails without the hidden line, with a single-variant ' +
    'hide, with inverted variants or with an unterminated statement',
    block !== '' && dacNoteHidden(block) && stripped !== block && weakened !== block &&
    inverted !== block && bleeding !== block &&
    !strippedPass && !weakenedPass && !invertedPass && !bleedingPass,
    `baseline=${dacNoteHidden(block)}, stripped=${strippedPass}, weakened=${weakenedPass}, ` +
    `inverted=${invertedPass}, bleeding=${bleedingPass}, ` +
    `argumentLength=${dacHiddenArgument(block).length}, ` +
    `strippedArgumentLength=${dacHiddenArgument(stripped).length}, ` +
    `weakenedArgumentLength=${dacHiddenArgument(weakened).length}, ` +
    `invertedArgumentLength=${dacHiddenArgument(inverted).length}, ` +
    `bleedingArgumentLength=${dacHiddenArgument(bleeding).length}`);
}

const REPEAT_FROM = "if (s.mode === 'repeat') {";
const REPEAT_TO = 'const badgeKeys = {';
const REPEAT_CONSTRUCTION = "const layers = div('panel-note');";
const REPEAT_TEXT = "t('capturePanel.repeatLayersNote')";
const REPEAT_HIDDEN =
  "layers.hidden = capturePanelNoteHidden('capturePanel.repeatLayersNote');";
const REPEAT_APPEND = 'modeSec.body.appendChild(layers);';
const REPEAT_REMOVE = 'layers.remove';
const REPEAT_SEARCH_APPEND = 'modeSec.body.appendChild(search);';
const REPEAT_SEARCH_HIDDEN = 'search.hidden';
const REPEAT_HIDDEN_DEPTH = 1;

const braceDepthAt = (source: string, needle: string): number => {
  const at = source.indexOf(needle);
  if (at < 0) return -1;
  let depth = 0;
  for (const ch of source.slice(0, at)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
};

const repeatLegendHidden = (source: string): boolean =>
  source.includes(REPEAT_CONSTRUCTION) && source.includes(REPEAT_TEXT) &&
  source.includes(REPEAT_HIDDEN) && source.includes(REPEAT_APPEND) &&
  source.includes(REPEAT_SEARCH_APPEND) && !source.includes(REPEAT_REMOVE) &&
  !source.includes(REPEAT_SEARCH_HIDDEN) &&
  braceDepthAt(source, REPEAT_HIDDEN) === REPEAT_HIDDEN_DEPTH;

{
  const panel = read('src/ui/capturePanel.ts');
  const block = slice(panel, REPEAT_FROM, REPEAT_TO);
  check('the repeat layer legend is built, appended and hidden while the search note stays visible',
    block !== '' && repeatLegendHidden(block),
    `length=${block.length}, construction=${block.includes(REPEAT_CONSTRUCTION)}, ` +
    `text=${block.includes(REPEAT_TEXT)}, hidden=${block.includes(REPEAT_HIDDEN)}, ` +
    `append=${block.includes(REPEAT_APPEND)}, remove=${block.includes(REPEAT_REMOVE)}, ` +
    `searchHidden=${block.includes(REPEAT_SEARCH_HIDDEN)}, ` +
    `searchAppend=${block.includes(REPEAT_SEARCH_APPEND)}, ` +
    `depth=${braceDepthAt(block, REPEAT_HIDDEN)}`);
}

{
  const panel = read('src/ui/capturePanel.ts');
  const block = slice(panel, REPEAT_FROM, REPEAT_TO);
  const stripped = block.split(`${REPEAT_HIDDEN}\n`).join('');
  const unappended = block.split(`${REPEAT_APPEND}\n`).join('');
  const searchHid = block.split(REPEAT_SEARCH_APPEND)
    .join(`${REPEAT_SEARCH_APPEND}\n        search.hidden = true;`);
  const unsearched = block.split(`${REPEAT_SEARCH_APPEND}\n`).join('');
  const nested = stripped.split(REPEAT_SEARCH_APPEND)
    .join(`${REPEAT_SEARCH_APPEND}\n        ${REPEAT_HIDDEN}`);
  const strippedPass = repeatLegendHidden(stripped);
  const unappendedPass = repeatLegendHidden(unappended);
  const searchHidPass = repeatLegendHidden(searchHid);
  const unsearchedPass = repeatLegendHidden(unsearched);
  const nestedPass = repeatLegendHidden(nested);
  check('control: the repeat legend predicate fails without the hidden line, the append, ' +
    'the search append, with the hidden line in the nested trigger block, ' +
    'or with a hidden search note',
    block !== '' && repeatLegendHidden(block) && stripped !== block && unappended !== block &&
    searchHid !== block && unsearched !== block && nested !== block &&
    !strippedPass && !unappendedPass && !searchHidPass && !unsearchedPass && !nestedPass,
    `baseline=${repeatLegendHidden(block)}, stripped=${strippedPass}, ` +
    `unappended=${unappendedPass}, searchHidden=${searchHidPass}, ` +
    `unsearched=${unsearchedPass}, nested=${nestedPass}, ` +
    `blockLength=${block.length}, strippedLength=${stripped.length}, ` +
    `unappendedLength=${unappended.length}, searchHiddenLength=${searchHid.length}, ` +
    `unsearchedLength=${unsearched.length}, nestedLength=${nested.length}, ` +
    `depth=${braceDepthAt(block, REPEAT_HIDDEN)}, nestedDepth=${braceDepthAt(nested, REPEAT_HIDDEN)}`);
}

const LIMIT_FROM = "const limit = div('panel-note');";
const LIMIT_TO = 'const triggerSec = section(';
const LIMIT_CONSTRUCTION = "const limit = div('panel-note');";
const LIMIT_LOOP_TEXT = "t('capturePanel.loopWindowLimit'";
const LIMIT_SINGLE_KEY = "'capturePanel.singleFiniteNote'";
const LIMIT_REPEAT_KEY = "'capturePanel.repeatFiniteNote'";
const LIMIT_LOOP_HIDDEN =
  "limit.hidden = capturePanelNoteHidden('capturePanel.loopWindowLimit');";
const LIMIT_KEY_HIDDEN = 'limit.hidden = capturePanelNoteHidden(noteKey);';
const LIMIT_HIDDEN_OPEN = 'limit.hidden = capturePanelNoteHidden(';
const LIMIT_APPEND = 'modeSec.body.appendChild(limit);';
const LIMIT_REMOVE = 'limit.remove';
const LIMIT_LOOP_BRANCH = "if (s.mode === 'loop') {";
const LIMIT_ELSE = '} else {';
const LIMIT_HIDDEN_COUNT = 2;

const countOf = (source: string, needle: string): number => source.split(needle).length - 1;

const limitNoteHidden = (source: string): boolean =>
  source !== '' && source.includes(LIMIT_CONSTRUCTION) && source.includes(LIMIT_LOOP_TEXT) &&
  source.includes(LIMIT_SINGLE_KEY) && source.includes(LIMIT_REPEAT_KEY) &&
  source.includes(LIMIT_LOOP_HIDDEN) && source.includes(LIMIT_KEY_HIDDEN) &&
  source.includes(LIMIT_APPEND) && !source.includes(LIMIT_REMOVE) &&
  countOf(source, LIMIT_HIDDEN_OPEN) === LIMIT_HIDDEN_COUNT;

interface LimitBranches {
  loopSide: string;
  keySide: string;
}

const limitBranches = (source: string): LimitBranches => {
  const loopAt = source.indexOf(LIMIT_LOOP_BRANCH);
  if (loopAt < 0) return { loopSide: '', keySide: '' };
  const elseAt = source.indexOf(LIMIT_ELSE, loopAt);
  if (elseAt < 0) return { loopSide: '', keySide: '' };
  return {
    loopSide: source.slice(loopAt, elseAt),
    keySide: source.slice(elseAt + LIMIT_ELSE.length),
  };
};

const loopSideHidden = (branches: LimitBranches): boolean =>
  countOf(branches.loopSide, LIMIT_LOOP_HIDDEN) === 1 &&
  countOf(branches.keySide, LIMIT_LOOP_HIDDEN) === 0;

const keySideHidden = (branches: LimitBranches): boolean =>
  countOf(branches.keySide, LIMIT_KEY_HIDDEN) === 1 &&
  countOf(branches.loopSide, LIMIT_KEY_HIDDEN) === 0;

const branchScopedLimit = (source: string): boolean => {
  const branches = limitBranches(source);
  return loopSideHidden(branches) && keySideHidden(branches);
};

const moveKeyHiddenIntoLoop = (source: string): string => {
  const branches = limitBranches(source);
  if (branches.loopSide === '' || !branches.keySide.includes(LIMIT_KEY_HIDDEN)) return source;
  const loopAt = source.indexOf(LIMIT_LOOP_BRANCH);
  const loopWithKey = branches.loopSide.split(`${LIMIT_LOOP_HIDDEN}\n`)
    .join(`${LIMIT_LOOP_HIDDEN}\n      ${LIMIT_KEY_HIDDEN}\n`);
  return source.slice(0, loopAt) + loopWithKey + LIMIT_ELSE +
    branches.keySide.split(`${LIMIT_KEY_HIDDEN}\n`).join('');
};

const swapHiddenSides = (source: string): string => {
  const branches = limitBranches(source);
  if (branches.loopSide === '' || !branches.loopSide.includes(LIMIT_LOOP_HIDDEN) ||
    !branches.keySide.includes(LIMIT_KEY_HIDDEN)) return source;
  const loopAt = source.indexOf(LIMIT_LOOP_BRANCH);
  const loopSwapped = branches.loopSide.split(`${LIMIT_LOOP_HIDDEN}\n`)
    .join(`${LIMIT_KEY_HIDDEN}\n`);
  const keySwapped = branches.keySide.split(`${LIMIT_KEY_HIDDEN}\n`)
    .join(`${LIMIT_LOOP_HIDDEN}\n`);
  return source.slice(0, loopAt) + loopSwapped + LIMIT_ELSE + keySwapped;
};

{
  const block = slice(read('src/ui/capturePanel.ts'), LIMIT_FROM, LIMIT_TO);
  const branches = limitBranches(block);
  const loopOk = loopSideHidden(branches);
  const keyOk = keySideHidden(branches);
  check('the Single, Repeat and Loop limit note is built, appended and hidden on both branches',
    limitNoteHidden(block) && branchScopedLimit(block) && loopOk && keyOk,
    `length=${block.length}, construction=${block.includes(LIMIT_CONSTRUCTION)}, ` +
    `loopText=${block.includes(LIMIT_LOOP_TEXT)}, singleKey=${block.includes(LIMIT_SINGLE_KEY)}, ` +
    `repeatKey=${block.includes(LIMIT_REPEAT_KEY)}, ` +
    `loopHidden=${block.includes(LIMIT_LOOP_HIDDEN)}, ` +
    `keyHidden=${block.includes(LIMIT_KEY_HIDDEN)}, append=${block.includes(LIMIT_APPEND)}, ` +
    `remove=${block.includes(LIMIT_REMOVE)}, ` +
    `hiddenAssignments=${countOf(block, LIMIT_HIDDEN_OPEN)}, expected=${LIMIT_HIDDEN_COUNT}, ` +
    `loopSideHidden=${loopOk}, keySideHidden=${keyOk}, ` +
    `loopSideLength=${branches.loopSide.length}, keySideLength=${branches.keySide.length}`);
}

{
  const block = slice(read('src/ui/capturePanel.ts'), LIMIT_FROM, LIMIT_TO);
  const start = block.indexOf(LIMIT_LOOP_BRANCH);
  const elseAt = start < 0 ? -1 : block.indexOf(LIMIT_ELSE, start);
  const withoutLoopHidden = block.split(`${LIMIT_LOOP_HIDDEN}\n`).join('');
  const withoutKeyHidden = block.split(`${LIMIT_KEY_HIDDEN}\n`).join('');
  const withoutAppend = block.split(`${LIMIT_APPEND}\n`).join('');
  const withoutLoopBranch = start < 0 || elseAt < 0 ? ''
    : block.slice(0, start) + `${LIMIT_LOOP_BRANCH}` + block.slice(elseAt);
  const withExtraHidden = withoutLoopHidden === block ? ''
    : block.split(`${LIMIT_LOOP_HIDDEN}\n`)
      .join(`${LIMIT_LOOP_HIDDEN}\n      ${LIMIT_HIDDEN_OPEN}'capturePanel.loopWindowLimit');\n`);
  const bothInLoop = moveKeyHiddenIntoLoop(block);
  const swapped = swapHiddenSides(block);
  const loopHiddenPass = limitNoteHidden(withoutLoopHidden);
  const keyHiddenPass = limitNoteHidden(withoutKeyHidden);
  const appendPass = limitNoteHidden(withoutAppend);
  const branchPass = limitNoteHidden(withoutLoopBranch);
  const extraPass = limitNoteHidden(withExtraHidden);
  const bothInLoopPass = branchScopedLimit(bothInLoop);
  const swappedPass = branchScopedLimit(swapped);
  const blockScoped = branchScopedLimit(block);
  check('control: the limit note predicate fails on a missing branch hide, a missing append, ' +
    'an extra hide, both hides on the loop side or the hides swapped between branches',
    block !== '' && limitNoteHidden(block) && blockScoped && withoutLoopHidden !== block &&
    withoutKeyHidden !== block && withoutAppend !== block && withoutLoopBranch !== '' &&
    withExtraHidden !== '' && bothInLoop !== block && swapped !== block &&
    !loopHiddenPass && !keyHiddenPass && !appendPass &&
    !branchPass && !extraPass && !bothInLoopPass && !swappedPass,
    `baseline=${limitNoteHidden(block)}, loopHiddenStripped=${loopHiddenPass}, ` +
    `keyHiddenStripped=${keyHiddenPass}, appendStripped=${appendPass}, ` +
    `loopBranchStripped=${branchPass}, extraHidden=${extraPass}, ` +
    `branchScopedBaseline=${blockScoped}, bothInLoop=${bothInLoopPass}, ` +
    `swapped=${swappedPass}, ` +
    `loopHiddenAssignments=${countOf(withoutLoopHidden, LIMIT_HIDDEN_OPEN)}, ` +
    `keyHiddenAssignments=${countOf(withoutKeyHidden, LIMIT_HIDDEN_OPEN)}, ` +
    `branchAssignments=${countOf(withoutLoopBranch, LIMIT_HIDDEN_OPEN)}, ` +
    `extraAssignments=${countOf(withExtraHidden, LIMIT_HIDDEN_OPEN)}, ` +
    `bothInLoopLength=${bothInLoop.length}, swappedLength=${swapped.length}, ` +
    `blockLength=${block.length}, loopHiddenLength=${withoutLoopHidden.length}, ` +
    `keyHiddenLength=${withoutKeyHidden.length}, appendLength=${withoutAppend.length}, ` +
    `branchLength=${withoutLoopBranch.length}, extraLength=${withExtraHidden.length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
