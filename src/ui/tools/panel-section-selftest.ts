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
const HIDE_SITE = 'triggerSec.body.hidden = !s.triggerEnableMask;';

const hasHiddenBodyRule = (source: string): boolean => source.includes(BODY_HIDDEN_RULE);

const mutateRule = (source: string, rule: string, replacement: string): string => {
  const escaped = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return source.replace(new RegExp(escaped), replacement);
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

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
