export {};

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
const slice = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
};
const tail = (source: string, from: string): string => {
  const start = source.indexOf(from);
  return start < 0 ? '' : source.slice(start);
};

const panel = read('src/ui/capturePanel.ts');
const assistant = read('src/ui/assistantPanel.ts');
const css = read('src/ui/style.css');

const BODY_BASE_RULE = '.panel-section-body { display: flex; flex-direction: column; gap: 8px; }';
const BODY_HIDDEN_RULE = '.panel-section-body[hidden] { display: none; }';
const HEAD_BASE_RULE = '.panel-section-head {';
const HEAD_GAP_SELECTOR = '.panel-section-head:has(+ .panel-section-body[hidden])';
const HEAD_GAP_RULE = `${HEAD_GAP_SELECTOR} { margin-bottom: 0; }`;
const HIDE_SITE = 'triggerSec.body.hidden = !s.triggerEnableMask;';

const hasHiddenBodyRule = (source: string): boolean => source.includes(BODY_HIDDEN_RULE);
const hasHeadGapRule = (source: string): boolean => source.includes(HEAD_GAP_RULE);

const mutateRule = (source: string, rule: string, replacement: string): string => {
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return source.replace(new RegExp(escaped), replacement);
};

const MENTION = '.panel-section-body[hidden]';
const THEME_SCOPE = /:is\(html\[data-theme=|html\[data-theme=/;

interface CssRule {
  selector: string;
  body: string;
}

const collectRules = (source: string): CssRule[] => {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: CssRule[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor);
    if (open < 0) break;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) break;
    const body = text.slice(open + 1, close);
    if (body.includes('{')) {
      out.push(...collectRules(body));
    } else {
      const boundary = Math.max(
        text.lastIndexOf('}', open), text.lastIndexOf('{', open - 1), text.lastIndexOf(';', open));
      out.push({
        selector: text.slice(boundary + 1, open).replace(/\s+/g, ' ').trim(),
        body: body.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim(),
      });
    }
    cursor = close + 1;
  }
  return out;
};

const mentionsBodyHidden = (rule: CssRule): boolean =>
  rule.selector.includes(MENTION) || rule.body.includes(MENTION);

const collapsedRules = (source: string): CssRule[] => collectRules(source).filter(mentionsBodyHidden);

const PAIR: readonly CssRule[] = [
  { selector: MENTION, body: 'display: none' },
  { selector: HEAD_GAP_SELECTOR, body: 'margin-bottom: 0' },
];

interface PairReport {
  count: number;
  exact: boolean;
  selectors: string[];
}

const pairReport = (source: string): PairReport => {
  const found = collapsedRules(source);
  return {
    count: found.length,
    exact: found.length === PAIR.length &&
      PAIR.every((want, i) => found[i].selector === want.selector && found[i].body === want.body),
    selectors: found.map((rule) => rule.selector),
  };
};

const scopeOffences = (source: string): string[] =>
  collapsedRules(source)
    .filter((rule) => THEME_SCOPE.test(rule.selector) || rule.body.includes('!important'))
    .map((rule) => rule.selector);

const looseHeadGaps = (source: string): string[] =>
  collectRules(source)
    .filter((rule) => rule.selector.includes('.panel-section-head') &&
      !rule.selector.includes(':has(') && !rule.selector.includes(MENTION) &&
      /margin-bottom:\s*0/.test(rule.body))
    .map((rule) => rule.selector);

const conditionalGapFails = (source: string): boolean => {
  const gap = collectRules(source).find((rule) => rule.selector === HEAD_GAP_SELECTOR);
  return gap === undefined || looseHeadGaps(source).length > 0;
};

const sectionSource = tail(panel, 'export function section(title: string)');

{
  const needles = [
    "const el = div('panel-section');",
    "const header = div('panel-section-head');",
    "const body = div('panel-section-body');",
    'el.append(header, body);',
    'return { el, header, body };',
  ];
  const missing = needles.filter((needle) => !sectionSource.includes(needle));
  check('section() composes .panel-section with a head and a body, appended head-then-body',
    sectionSource !== '' && missing.length === 0,
    `missing=${JSON.stringify(missing)}, source=${JSON.stringify(sectionSource.replace(/\s+/g, ' ').slice(0, 260))}`);
}

{
  const baseAt = css.indexOf(BODY_BASE_RULE);
  const hiddenAt = css.indexOf(BODY_HIDDEN_RULE);
  check('the sheet still gives .panel-section-body an author display: flex, so a bare [hidden] would lose',
    baseAt >= 0 && css.indexOf('display: flex', baseAt) === baseAt + '.panel-section-body { '.length,
    `baseAt=${baseAt}, rule=${JSON.stringify(baseAt >= 0 ? BODY_BASE_RULE : '')}`);
  check('the sheet lets the hidden attribute win: .panel-section-body[hidden] { display: none; }',
    hasHiddenBodyRule(css) && hiddenAt > baseAt,
    `present=${hasHiddenBodyRule(css)}, hiddenAt=${hiddenAt}, baseAt=${baseAt}`);
}

{
  const weakened = mutateRule(css, BODY_HIDDEN_RULE, '.panel-section-body[hidden] { display: flex; }');
  const stripped = mutateRule(css, BODY_HIDDEN_RULE, '');
  check('control: the hidden-body needle fails on the pre-fix sheet and on a weakened display value',
    !hasHiddenBodyRule(stripped) && !hasHiddenBodyRule(weakened) &&
    stripped !== css && weakened !== css && stripped.includes(BODY_BASE_RULE),
    `stripped=${hasHiddenBodyRule(stripped)}, weakened=${hasHiddenBodyRule(weakened)}, ` +
    `strippedLength=${stripped.length}, sheetLength=${css.length}`);
}

{
  const gapAt = css.indexOf(HEAD_GAP_RULE);
  const gapBlock = slice(css, HEAD_GAP_SELECTOR, '}');
  check('a collapsed section drops the head gap: .panel-section-head:has(+ .panel-section-body[hidden]) { margin-bottom: 0; }',
    hasHeadGapRule(css) && gapAt > css.indexOf(BODY_HIDDEN_RULE) &&
    gapBlock.includes('margin-bottom: 0') && !gapBlock.includes('8px'),
    `present=${hasHeadGapRule(css)}, gapAt=${gapAt}, block=${JSON.stringify(gapBlock.replace(/\s+/g, ' '))}`);
}

{
  const headAt = css.indexOf(HEAD_BASE_RULE);
  const headBlock = headAt < 0 ? '' : slice(css, HEAD_BASE_RULE, '}');
  check('the head-without-body card keeps its own gap: .panel-section-head still carries margin-bottom: 8px',
    headAt >= 0 && headBlock.includes('margin-bottom: 8px'),
    `headAt=${headAt}, block=${JSON.stringify(headBlock.replace(/\s+/g, ' '))}`);
}

{
  const zeroed = mutateRule(css, HEAD_GAP_RULE,
    '.panel-section-head:has(+ .panel-section-body[hidden]) { margin-bottom: 8px; }');
  const unguarded = mutateRule(css, HEAD_GAP_RULE,
    '.panel-section-head:has(+ .panel-section-body) { margin-bottom: 0; }');
  const strippedGap = mutateRule(css, HEAD_GAP_RULE, '');
  check('control: the collapsed-gap needle fails for a deleted rule, an 8px declaration and an unguarded :has()',
    !hasHeadGapRule(strippedGap) && !hasHeadGapRule(zeroed) && !hasHeadGapRule(unguarded) &&
    strippedGap !== css && zeroed !== css && unguarded !== css &&
    strippedGap.includes(HEAD_BASE_RULE) && strippedGap.includes(BODY_HIDDEN_RULE),
    `stripped=${hasHeadGapRule(strippedGap)}, zeroed=${hasHeadGapRule(zeroed)}, ` +
    `unguarded=${hasHeadGapRule(unguarded)}, strippedLength=${strippedGap.length}, sheetLength=${css.length}`);
}

{
  const sites = panel.match(/body\.hidden\s*=/g) ?? [];
  check('capturePanel has exactly one conditional body hide and it is the trigger-enabled mask',
    sites.length === 1 && panel.includes(HIDE_SITE),
    `sites=${sites.length}, needle=${panel.includes(HIDE_SITE)}`);
}

{
  const noticeSource = slice(assistant, 'private notice(): HTMLDivElement {',
    'private emptyState(): HTMLDivElement {');
  const headNoBody = noticeSource.includes("const head = div('panel-section-head');") &&
    !noticeSource.includes('panel-section-body');
  check('the assistant notice card is a head-without-body section, so the head keeps its own gap',
    noticeSource !== '' && headNoBody,
    `source=${JSON.stringify(noticeSource.replace(/\s+/g, ' ').slice(0, 200))}`);
}

{
  const report = pairReport(css);
  check('the collapsed contract is exactly two rules: the hidden display rule and the head-gap rule',
    report.count === PAIR.length && report.exact,
    `count=${report.count}, exact=${report.exact}, selectors=${JSON.stringify(report.selectors)}`);
}

{
  const strippedDisplay = mutateRule(css, BODY_HIDDEN_RULE, '');
  const strippedGap = mutateRule(css, HEAD_GAP_RULE, '');
  const extraMention = pairReport(
    `${css}\n:is(html[data-theme="dark"]) .panel-section-body[hidden] { display: flex; }\n`);
  const noDisplay = pairReport(strippedDisplay);
  const noGap = pairReport(strippedGap);
  check('control: the pair guard fails for either missing rule and for a themed third mention',
    noDisplay.count === 1 && noGap.count === 1 && extraMention.count === 3 &&
    !noDisplay.exact && !noGap.exact && !extraMention.exact &&
    strippedDisplay !== css && strippedGap !== css,
    `noDisplay=${noDisplay.count}, noGap=${noGap.count}, extra=${extraMention.count}, ` +
    `exact=${JSON.stringify([noDisplay.exact, noGap.exact, extraMention.exact])}`);
}

{
  const offences = scopeOffences(css);
  check('neither collapsed rule is theme-scoped or forced: no theme prefix and no !important',
    collapsedRules(css).length === PAIR.length && offences.length === 0,
    `rules=${collapsedRules(css).length}, offences=${JSON.stringify(offences)}`);
}

{
  const themedDisplay = mutateRule(css, BODY_HIDDEN_RULE,
    ':is(html[data-theme="dark"]) .panel-section-body[hidden] { display: none; }');
  const themedGap = mutateRule(css, HEAD_GAP_RULE,
    'html[data-theme="light"] .panel-section-head:has(+ .panel-section-body[hidden]) { margin-bottom: 0; }');
  const forcedGap = mutateRule(css, HEAD_GAP_RULE,
    '.panel-section-head:has(+ .panel-section-body[hidden]) { margin-bottom: 0 !important; }');
  check('control: the scoping guard fails for a themed display rule, a themed gap rule and a forced gap',
    scopeOffences(themedDisplay).length === 1 && scopeOffences(themedGap).length === 1 &&
    scopeOffences(forcedGap).length === 1 && scopeOffences(css).length === 0 &&
    themedDisplay !== css && themedGap !== css && forcedGap !== css,
    `themedDisplay=${JSON.stringify(scopeOffences(themedDisplay))}, ` +
    `themedGap=${JSON.stringify(scopeOffences(themedGap))}, ` +
    `forcedGap=${JSON.stringify(scopeOffences(forcedGap))}`);
}

{
  const gap = collectRules(css).find((rule) => rule.selector === HEAD_GAP_SELECTOR);
  const loose = looseHeadGaps(css);
  check('the head gap is dropped only through the hidden-sibling :has() guard, never unconditionally',
    gap !== undefined && gap.selector.includes(':has(+ .panel-section-body[hidden])') && loose.length === 0,
    `gapSelector=${JSON.stringify(gap ? gap.selector : '')}, loose=${JSON.stringify(loose)}`);
}

{
  const unconditionalHead = `${css}\n.panel-section-head { margin-bottom: 0; }\n`;
  const unguardedHas = mutateRule(css, HEAD_GAP_RULE,
    '.panel-section-head:has(+ .panel-section-body) { margin-bottom: 0; }');
  check('control: the conditional-gap guard fails for an unconditional zeroed head rule and an unguarded :has()',
    conditionalGapFails(unconditionalHead) && conditionalGapFails(unguardedHas) &&
    !conditionalGapFails(css) && unconditionalHead !== css && unguardedHas !== css,
    `unconditionalHead=${conditionalGapFails(unconditionalHead)}, ` +
    `unguardedHas=${conditionalGapFails(unguardedHas)}, ` +
    `loose=${JSON.stringify(looseHeadGaps(unconditionalHead))}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
