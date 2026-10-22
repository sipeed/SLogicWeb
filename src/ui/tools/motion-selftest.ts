export {};

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(p: string, enc: 'utf8'): string;
}

const fs = (() => {
  const get = nodeProcess.getBuiltinModule;
  return (typeof get === 'function' ? get.call(nodeProcess, 'node:fs') : undefined) as FsLike | undefined;
})();

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

interface SourceRange {
  start: number;
  end: number;
}

interface FlatRule {
  selector: string;
  body: string;
  start: number;
}

function mediaRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf('@media', from);
    if (start === -1) break;
    const brace = source.indexOf('{', start);
    const end = brace === -1 ? -1 : source.indexOf('\n}', brace);
    if (brace === -1 || end === -1) break;
    ranges.push({ start, end });
    from = end + 1;
  }
  return ranges;
}

function flatRules(code: string): FlatRule[] {
  const rules: FlatRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    rules.push({ selector: (m[1] ?? '').trim(), body: m[2] ?? '', start: m.index });
  }
  return rules;
}

const css = (() => {
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  return fs.readFileSync('src/ui/style.css', 'utf8');
})();
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
const media = mediaRanges(code);
const rules = flatRules(code);

const MOTION_CONSUMERS: readonly string[] = [
  '.tooltip',
  '.tooltip.open',
  '#toolbar button.toolbar-item',
  '.pill, .mini, .primary, .danger, .seg',
  '.chip',
  '.ch-settings',
  ':is(html[data-theme="dark"], html[data-theme="light"]) .ch-card',
  '.channel-name-reset',
  '.channel-color-swatch',
  '.channel-trigger-option',
  '.channel-settings-cancel',
  '.analyzer-act',
  '.ch-analyzer-x',
];

const BUTTON_CONSUMERS: readonly string[] = [
  '#toolbar button.toolbar-item',
  '.pill, .mini, .primary, .danger, .seg',
  '.chip',
  '.ch-settings',
  '.channel-name-reset',
  '.channel-color-swatch',
  '.channel-settings-cancel',
  '.analyzer-act',
  '.ch-analyzer-x',
];

const NON_BUTTON_CONSUMERS: readonly string[] = [
  '.tooltip',
  '.tooltip.open',
  ':is(html[data-theme="dark"], html[data-theme="light"]) .ch-card',
  '.channel-trigger-option',
];

{
  const declarers = rules.filter((r) => r.body.includes('--motion-fast: 120ms'));
  const decl = declarers.length === 1 ? declarers[0]! : null;
  const topLevel = decl !== null && !media.some((range) => decl.start > range.start && decl.start < range.end);
  check('the motion tokens are declared once on a top-level :root',
    decl !== null && decl.selector === ':root' && decl.body.includes('--motion-ease: ease;') && topLevel,
    `declarers=${declarers.length}, selector=${decl?.selector ?? '(none)'}, ease=${decl?.body.includes('--motion-ease: ease;') ?? false}, topLevel=${topLevel}`);
}

{
  const fastDecls = rules.filter((r) => /(^|;)\s*--motion-fast\s*:/.test(r.body)).length;
  const easeDecls = rules.filter((r) => /(^|;)\s*--motion-ease\s*:/.test(r.body)).length;
  check('motion token declarations exist exactly at the two pinned sites (declaration + override)',
    fastDecls === 2 && easeDecls === 1,
    `fastDecls=${fastDecls}, easeDecls=${easeDecls}`);
}

{
  const literal = '@media (prefers-reduced-motion: reduce) {\n  :root { --motion-fast: 1ms; }\n}';
  const occurrences = code.split('prefers-reduced-motion').length - 1;
  check('exactly one reduced-motion block, in the sheet multi-line idiom, retiming only --motion-fast',
    occurrences === 1 && code.includes(literal),
    `occurrences=${occurrences}, exactForm=${code.includes(literal)}`);
}

{
  const tokenAt = code.indexOf('--motion-fast: 120ms');
  const mediaAt = code.indexOf('@media (prefers-reduced-motion: reduce)');
  check('the reduced-motion override follows the token declaration in source order',
    tokenAt >= 0 && mediaAt > tokenAt,
    `tokenAt=${tokenAt}, mediaAt=${mediaAt}`);
}

{
  const offenders = rules.filter((r) => r.selector.includes('data-theme')
    && /(^|;)\s*--motion-(fast|ease)\s*:/.test(r.body));
  check('no themed block redeclares a motion token',
    offenders.length === 0,
    `offenders=[${offenders.map((r) => r.selector.slice(0, 48)).join(' | ')}]`);
}

{
  const tip = rules.find((r) => r.selector === '.tooltip');
  const tipOpen = rules.find((r) => r.selector === '.tooltip.open');
  const tipBlock = css.slice(css.indexOf('.tooltip {'), css.indexOf('.tooltip.open'));
  const baseOk = tip !== undefined
    && tip.body.includes('transition: opacity var(--motion-fast) var(--motion-ease), visibility 0s linear var(--motion-fast);');
  const openOk = tipOpen !== undefined
    && tipOpen.body.includes('transition: opacity var(--motion-fast) var(--motion-ease);');
  check('the tooltip fade consumes the motion tokens with the visibility delay tokenized',
    baseOk && openOk && !tipBlock.includes('120ms'),
    `baseOk=${baseOk}, openOk=${openOk}, literalSurvives=${tipBlock.includes('120ms')}`);
}

{
  const keyframes = (code.match(/@keyframes/g) ?? []).length;
  const animations = rules.filter((r) => /(^|;)\s*(-webkit-)?animation(-[\w]+)?\s*:/.test(r.body));
  const stateOffenders = rules.filter((r) => /:(hover|active|focus-visible)\b/.test(r.selector)
    && /(^|;)\s*(-webkit-)?transition(-[\w]+)?\s*:/.test(r.body));
  check('transitions-only contract: no keyframes, no animation, no transition inside state rules',
    keyframes === 0 && animations.length === 0 && stateOffenders.length === 0,
    `keyframes=${keyframes}, animationRules=[${animations.map((r) => r.selector.slice(0, 40)).join(' | ')}], ` +
    `stateOffenders=[${stateOffenders.map((r) => r.selector.slice(0, 40)).join(' | ')}]`);
}

{
  const consumers = rules.filter((r) => r.body.includes('var(--motion-fast)')).map((r) => r.selector).sort();
  const want = [...MOTION_CONSUMERS].sort();
  check('the motion-token consumer set is exactly the pinned adopter whitelist',
    consumers.length === want.length && consumers.every((s, i) => s === want[i]),
    `consumers=${JSON.stringify(consumers)}, want=${JSON.stringify(want)}`);
}

{
  const topLevel = rules.filter((r) => !media.some((range) => r.start > range.start && r.start < range.end));
  const counts = MOTION_CONSUMERS.map((s) => topLevel.filter((r) => r.selector === s).length);
  check('the adopted selectors stay in-place: exactly one top-level rule per consumer selector',
    counts.every((c) => c === 1),
    `counts=${JSON.stringify(Object.fromEntries(MOTION_CONSUMERS.map((s, i) => [s, counts[i]])))}`);
}

{
  const topLevel = rules.filter((r) => !media.some((range) => r.start > range.start && r.start < range.end));
  const transitionOf = (s: string): string =>
    topLevel.find((r) => r.selector === s)?.body.match(/(?:^|;)\s*transition\s*:\s*([^;]+)/)?.[1] ?? '';
  const missingVeil = BUTTON_CONSUMERS.filter((s) => !transitionOf(s).includes('box-shadow'));
  const strayVeil = NON_BUTTON_CONSUMERS.filter((s) => transitionOf(s).includes('box-shadow'));
  check('button-family transition lists carry box-shadow for the press veil; non-button lists omit it',
    missingVeil.length === 0 && strayVeil.length === 0,
    `missingVeil=${JSON.stringify(missingVeil)}, strayVeil=${JSON.stringify(strayVeil)}`);
}

{
  const easeConsumers = rules.filter((r) => r.body.includes('var(--motion-ease)')).map((r) => r.selector).sort();
  const fastConsumers = rules.filter((r) => r.body.includes('var(--motion-fast) var(--motion-ease)')).map((r) => r.selector).sort();
  check('every easing consumer pairs it with the fast duration token',
    easeConsumers.length === fastConsumers.length && easeConsumers.every((s, i) => s === fastConsumers[i]),
    `easeConsumers=${JSON.stringify(easeConsumers)}, paired=${JSON.stringify(fastConsumers)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
