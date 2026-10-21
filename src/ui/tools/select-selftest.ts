import {
  FUZZY_BOUNDARY,
  FUZZY_CAMEL,
  FUZZY_CONSECUTIVE,
  FUZZY_DIGIT,
  FUZZY_EXACT_CASE,
  FUZZY_GAP_EXTEND,
  FUZZY_GAP_START,
  FUZZY_MAX_NEEDLE,
  FUZZY_START,
  FUZZY_SUBSTRING,
  fuzzyMatch,
  fuzzyRank,
  highlightRuns,
  type FuzzyRun,
} from '../fuzzy.js';
import {
  TYPEAHEAD_RESET_MS,
  matchPrefix,
  moveActiveIndex,
  nextTypeaheadPrefix,
  resolveLabel,
  type SelectOption,
} from '../select.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
}

interface DirentLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
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

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const navigation: readonly (readonly [number, number, number, number])[] = [
  [-1, 1, 5, 0],
  [-1, -1, 5, 4],
  [4, 1, 5, 0],
  [0, -1, 5, 4],
  [2, 3, 5, 0],
  [7, 1, 1, 0],
  [-1, 1, 0, -1],
  [0, -1, 0, -1],
];
const navigationFailures = navigation.filter(
  ([current, delta, count, expected]) => moveActiveIndex(current, delta, count) !== expected,
);
check(
  'active-index movement wraps in both directions and rejects empty lists',
  navigationFailures.length === 0,
  navigationFailures.length === 0
    ? `all ${navigation.length} literal cases matched`
    : navigationFailures
      .map(([current, delta, count]) => `${current}+${delta}/${count}=${moveActiveIndex(current, delta, count)}`)
      .join('; '),
);

const prefixOptions: readonly SelectOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'ap', label: 'Apricot' },
  { value: 'b', label: 'Banana' },
];
const prefixCases: readonly (readonly [string, number, number])[] = [
  ['apr', 0, 1],
  ['ap', 2, 0],
  ['BAN', 0, 2],
  ['zz', 0, -1],
  ['', 0, -1],
];
const prefixFailures = prefixCases.filter(
  ([prefix, from, expected]) => matchPrefix(prefixOptions, prefix, from) !== expected,
);
check(
  'typeahead matches case-insensitively, wraps forward, and rejects empty/absent prefixes',
  prefixFailures.length === 0,
  prefixFailures.length === 0
    ? `all ${prefixCases.length} literal cases matched`
    : prefixFailures
      .map(([prefix, from]) => `'${prefix}'@${from}=${matchPrefix(prefixOptions, prefix, from)}`)
      .join('; '),
);

const repeated: readonly SelectOption[] = [
  { value: '1', label: 'Alpha' },
  { value: '2', label: 'Axe' },
  { value: '3', label: 'Beta' },
];
check(
  'repeated single-character typeahead keeps a cycling prefix while other keys extend it',
  nextTypeaheadPrefix('', 'A') === 'a' &&
    nextTypeaheadPrefix('a', 'a') === 'a' &&
    nextTypeaheadPrefix('ab', 'C') === 'abc' &&
    matchPrefix(repeated, 'a', 0) === 1 && matchPrefix(repeated, 'a', 1) === 0,
  `single=${nextTypeaheadPrefix('a', 'a')}, extended=${nextTypeaheadPrefix('ab', 'C')}, ` +
    `from0=${matchPrefix(repeated, 'a', 0)}, from1=${matchPrefix(repeated, 'a', 1)}`,
);

check(
  'label resolution returns the exact label or an empty string',
  resolveLabel(prefixOptions, 'ap') === 'Apricot' &&
    resolveLabel(prefixOptions, 'b') === 'Banana' &&
    resolveLabel(prefixOptions, 'x') === '',
  `ap=${JSON.stringify(resolveLabel(prefixOptions, 'ap'))}, x=${JSON.stringify(resolveLabel(prefixOptions, 'x'))}`,
);

check(
  'the typeahead prefix window is the pinned 800ms literal',
  TYPEAHEAD_RESET_MS === 800,
  `TYPEAHEAD_RESET_MS=${TYPEAHEAD_RESET_MS}`,
);

const fuzzyConstants: readonly (readonly [string, number, number])[] = [
  ['FUZZY_START', FUZZY_START, 10],
  ['FUZZY_BOUNDARY', FUZZY_BOUNDARY, 8],
  ['FUZZY_CAMEL', FUZZY_CAMEL, 6],
  ['FUZZY_DIGIT', FUZZY_DIGIT, 4],
  ['FUZZY_CONSECUTIVE', FUZZY_CONSECUTIVE, 6],
  ['FUZZY_SUBSTRING', FUZZY_SUBSTRING, 6],
  ['FUZZY_EXACT_CASE', FUZZY_EXACT_CASE, 2],
  ['FUZZY_GAP_START', FUZZY_GAP_START, -3],
  ['FUZZY_GAP_EXTEND', FUZZY_GAP_EXTEND, -1],
  ['FUZZY_MAX_NEEDLE', FUZZY_MAX_NEEDLE, 32],
];
const fuzzyConstantFailures = fuzzyConstants.filter(([, actual, expected]) => actual !== expected);
check(
  'fuzzy scoring constants match the pinned literal table',
  fuzzyConstantFailures.length === 0,
  fuzzyConstantFailures.length === 0
    ? `all ${fuzzyConstants.length} constants pinned`
    : fuzzyConstantFailures
      .map(([name, actual, expected]) => `${name}=${actual}, want ${expected}`)
      .join('; '),
);

interface FuzzyMatchCase {
  readonly needle: string;
  readonly haystack: string;
  readonly score: number | null;
  readonly positions: readonly number[];
}
const fuzzyMatchCases: readonly FuzzyMatchCase[] = [
  { needle: 'i2c', haystack: 'i2c - Inter-Integrated Circuit', score: 50, positions: [0, 1, 2] },
  { needle: 'ir nec', haystack: 'ir_nec - IR NEC', score: 72, positions: [0, 1, 2, 3, 4, 5] },
  { needle: 'rc6', haystack: 'ir_rc6 - IR RC-6', score: 36, positions: [3, 4, 5] },
  { needle: 'USB', haystack: 'usb_signalling - USB signalling', score: 36, positions: [0, 1, 2] },
  { needle: 'ir6', haystack: 'ir_rc6 - IR RC-6', score: 29, positions: [0, 3, 5] },
  {
    needle: 'circuit',
    haystack: 'i2c - Inter-Integrated Circuit',
    score: 62,
    positions: [23, 24, 25, 26, 27, 28, 29],
  },
  { needle: 'xy2100', haystack: 'xy2-100', score: 63, positions: [0, 1, 2, 4, 5, 6] },
  { needle: 'zzz', haystack: 'i2c - Inter-Integrated Circuit', score: null, positions: [] },
  { needle: '', haystack: 'i2c - Inter-Integrated Circuit', score: 0, positions: [] },
  {
    needle: 'a'.repeat(FUZZY_MAX_NEEDLE),
    haystack: 'a'.repeat(FUZZY_MAX_NEEDLE + 8),
    score: 274,
    positions: Array.from({ length: FUZZY_MAX_NEEDLE }, (_, i) => i),
  },
  {
    needle: 'a'.repeat(FUZZY_MAX_NEEDLE + 1),
    haystack: 'a'.repeat(FUZZY_MAX_NEEDLE + 8),
    score: null,
    positions: [],
  },
];
const fuzzyMatchFailures = fuzzyMatchFailures0();
function fuzzyMatchFailures0(): string[] {
  const failures: string[] = [];
  for (const { needle, haystack, score, positions } of fuzzyMatchCases) {
    const match = fuzzyMatch(needle, haystack);
    if (score === null) {
      if (match !== null) failures.push(`'${needle}' should miss, got ${match.score}`);
      continue;
    }
    if (match === null) {
      failures.push(`'${needle}' missed, want ${score}`);
    } else if (match.score !== score ||
      JSON.stringify(match.positions) !== JSON.stringify(positions)) {
      failures.push(
        `'${needle}' = ${match.score}@${JSON.stringify(match.positions)}, ` +
        `want ${score}@${JSON.stringify(positions)}`,
      );
    }
  }
  return failures;
}
check(
  'fuzzyMatch returns exact scores and offsets across contiguous, separator-equivalent, digit, case-bonus, and rejection cases',
  fuzzyMatchFailures.length === 0,
  fuzzyMatchFailures.length === 0
    ? `all ${fuzzyMatchCases.length} literal cases matched`
    : fuzzyMatchFailures.join('; '),
);

const fuzzyRankCases: readonly (readonly [string, readonly string[], readonly number[]])[] = [
  [
    'uart',
    ['quadrature_encoder - Quadrature encoder', 'uart - Universal Asynchronous Rx/Tx'],
    [1, 0],
  ],
  ['x', ['x a', 'x b'], [0, 1]],
  ['ab', ['x1 - AB', 'x1 - ab'], [1, 0]],
];
const fuzzyRankFailures = fuzzyRankCases.filter(([needle, haystacks, expected]) => {
  const order = fuzzyRank(needle, haystacks).map((rank) => rank.index);
  return JSON.stringify(order) !== JSON.stringify(expected);
});
check(
  'fuzzyRank orders by score, keeps equal scores in original order, and rewards exact case',
  fuzzyRankFailures.length === 0,
  fuzzyRankFailures.length === 0
    ? `all ${fuzzyRankCases.length} literal cases matched`
    : fuzzyRankFailures
      .map(([needle, haystacks]) =>
        `'${needle}' -> ${JSON.stringify(fuzzyRank(needle, haystacks).map((rank) => rank.index))}`)
      .join('; '),
);

const fuzzyRunCases: readonly (readonly [readonly number[], number, readonly FuzzyRun[]])[] = [
  [[1, 4, 5], 10, [
    { start: 0, length: 1, hit: false },
    { start: 1, length: 1, hit: true },
    { start: 2, length: 2, hit: false },
    { start: 4, length: 2, hit: true },
    { start: 6, length: 4, hit: false },
  ]],
  [[], 5, [{ start: 0, length: 5, hit: false }]],
  [[0, 1, 2], 3, [{ start: 0, length: 3, hit: true }]],
  [[], 0, []],
];
const fuzzyRunFailures = fuzzyRunCases.filter(([positions, length, expected]) => {
  const runs = highlightRuns(positions, length);
  return JSON.stringify(runs) !== JSON.stringify(expected);
});
check(
  'highlightRuns merges match offsets into alternating plain and hit runs',
  fuzzyRunFailures.length === 0,
  fuzzyRunFailures.length === 0
    ? `all ${fuzzyRunCases.length} literal cases matched`
    : fuzzyRunFailures
      .map(([positions, length]) =>
        `${JSON.stringify(positions)}/${length} -> ${JSON.stringify(highlightRuns(positions, length))}`)
      .join('; '),
);

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });

  const src = fs.readFileSync('src/ui/select.ts', 'utf8');
  const css = fs.readFileSync('src/ui/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  const fuzzySrc = fs.readFileSync('src/ui/fuzzy.ts', 'utf8');
  const fuzzyDomToken = fuzzySrc.includes('document.') || fuzzySrc.includes('window.');
  const fuzzyMarkupToken = fuzzySrc.includes(['inner', 'HTML'].join(''));
  check(
    'the fuzzy matcher module performs no DOM access and no string-built markup',
    !fuzzyDomToken && !fuzzyMarkupToken,
    `fuzzyDomToken=${fuzzyDomToken}, fuzzyMarkupToken=${fuzzyMarkupToken}`,
  );

  const ruleBody = (selector: string): string | null => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
    return body === undefined ? null : body.replace(/\s+/g, ' ').trim();
  };

  const anatomyNeedles = [
    'export class SelectControl extends EventTarget',
    "popover.setAttribute('popover', 'auto')",
    "trigger.setAttribute('popovertarget', this.surfaceId)",
    "trigger.setAttribute('role', 'combobox')",
    "trigger.setAttribute('aria-haspopup', 'listbox')",
    "trigger.setAttribute('aria-expanded'",
    "trigger.setAttribute('aria-controls', this.listboxId)",
    "group.setAttribute('role', 'listbox')",
    "group.setAttribute('aria-labelledby', this.labelId)",
    'group.id = this.listboxId',
    "item.setAttribute('role', 'option')",
    "item.setAttribute('aria-selected'",
    ".setAttribute('aria-activedescendant', this.items[index].id)",
    'this.items[index].scrollIntoView({ block: \'nearest\' })',
    'trigger.dataset.selectKey = key',
    "this.popover.showPopover()",
    'this.popover.hidePopover()',
  ];
  const missingAnatomy = anatomyNeedles.filter((needle) => !src.includes(needle));
  check(
    'the control realizes the combobox/listbox/option anatomy over a native popover',
    missingAnatomy.length === 0,
    `missing=${JSON.stringify(missingAnatomy)}`,
  );

  const searchNeedles = [
    "import { fuzzyRank, highlightRuns } from './fuzzy.js';",
    "if (this.search === null) trigger.setAttribute('role', 'combobox');",
    "popover.classList.add('select-searchable')",
    "searchRow.className = 'select-search'",
    "input.setAttribute('role', 'combobox')",
    "input.setAttribute('aria-autocomplete', 'list')",
    "input.setAttribute('aria-controls', this.listboxId)",
    "input.setAttribute('aria-label', search.label)",
    "input.addEventListener('input'",
    "input.addEventListener('keydown'",
    "empty.className = 'select-empty'",
    "empty.setAttribute('role', 'status')",
    'item.hidden = !hit.has(index)',
    'this.group.appendChild(this.items[rank.index])',
    "span.className = 'select-item-hit'",
    'labelEl.replaceChildren()',
    "split('{query}')",
    'moveActiveIndex(position, delta, visible.length)',
    'this.searchInput?.focus()',
    'const owner = this.searchInput ?? this.trigger;',
  ];
  const missingSearch = searchNeedles.filter((needle) => !src.includes(needle));
  check(
    'the opt-in search mode wires a combobox input, filtered hidden items, and hit painting',
    missingSearch.length === 0,
    `missing=${JSON.stringify(missingSearch)}`,
  );

  const seedBranchIndex = src.indexOf('if (this.search !== null && this.searchInput !== null) {');
  const seedBranch = seedBranchIndex >= 0
    ? src.slice(seedBranchIndex, src.indexOf('this.open();', seedBranchIndex))
    : '';
  check(
    'the closed-trigger character seed prevents the default text insertion that would double it',
    seedBranchIndex >= 0 && seedBranch.includes('event.preventDefault()'),
    `seed@${seedBranchIndex}, preventDefault=${seedBranch.includes('event.preventDefault()')}`,
  );

  const visibleIndicesIndex = src.indexOf('private visibleIndices()');
  const visibleIndicesBody = visibleIndicesIndex >= 0
    ? src.slice(visibleIndicesIndex, src.indexOf('private setActive', visibleIndicesIndex))
    : '';
  check(
    'visible rows are enumerated in display (DOM) order so filtered navigation follows the ranking',
    visibleIndicesBody.includes('this.group.children') &&
      !visibleIndicesBody.includes('this.items.forEach'),
    `body@${visibleIndicesIndex}, domOrder=${visibleIndicesBody.includes('this.group.children')}, ` +
    `arrayOrder=${visibleIndicesBody.includes('this.items.forEach')}`,
  );

  const searchHandlerIndex = src.indexOf('private onSearchKeyDown');
  const escapeBranchIndex = src.indexOf("if (key === 'Escape') {", searchHandlerIndex);
  const escapeBranch = escapeBranchIndex >= 0
    ? src.slice(escapeBranchIndex, src.indexOf('return;', escapeBranchIndex))
    : '';
  const tabBranchIndex = src.indexOf("if (key === 'Tab') {", searchHandlerIndex);
  const tabBranch = tabBranchIndex >= 0
    ? src.slice(tabBranchIndex, src.indexOf('return;', tabBranchIndex))
    : '';
  check(
    'the search field owns a two-stage Escape and a Tab close that never prevents default',
    searchHandlerIndex >= 0 &&
      escapeBranch.includes('event.preventDefault()') && escapeBranch.includes("input.value !== '')") &&
      tabBranch.includes('this.close()') && tabBranch.includes('this.trigger.focus()') &&
      !tabBranch.includes('preventDefault'),
    `handler@${searchHandlerIndex}, escapePrevent=${escapeBranch.includes('event.preventDefault()')}, ` +
    `escapeGuard=${escapeBranch.includes("input.value !== '')")}, ` +
    `tabClose=${tabBranch.includes('this.close()')}, tabFocus=${tabBranch.includes('this.trigger.focus()')}, ` +
    `tabNoPrevent=${!tabBranch.includes('preventDefault')}`,
  );

  const interactionNeedles = [
    "item.addEventListener('pointerdown'",
    "item.addEventListener('click'",
    'nextTypeaheadPrefix',
    "trigger.addEventListener('keydown'",
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
    'Enter',
    "'Tab'",
    "'Escape'",
    'moveActiveIndex',
    'matchPrefix',
    'TYPEAHEAD_RESET_MS',
    "new Event('change', { bubbles: true })",
  ];
  const missingInteraction = interactionNeedles.filter((needle) => !src.includes(needle));
  check(
    'pointer, keyboard, typeahead, and change contracts are all present',
    missingInteraction.length === 0,
    `missing=${JSON.stringify(missingInteraction)}`,
  );

  const noGlobalListeners = !src.includes('document.addEventListener') &&
    !src.includes('window.addEventListener');
  const innerHtmlToken = ['inner', 'HTML'].join('');
  const noInnerHtml = !src.includes(innerHtmlToken);
  check(
    'the control installs no document/window listener and never uses string-built markup',
    noGlobalListeners && noInnerHtml,
    `noGlobalListeners=${noGlobalListeners}, noInnerHtml=${noInnerHtml}`,
  );

  const classIndex = src.indexOf('export class SelectControl');
  const topLevelDom = /^(document|window)\./m.test(src);
  check(
    'the module top level performs no DOM access so node self-tests can import it',
    classIndex >= 0 && !topLevelDom,
    `class@${classIndex}, topLevelDom=${topLevelDom}`,
  );

  const focusLookup = '`.select-trigger[data-select-key="${CSS.escape(this.key)}"]`';
  const dispatchIndex = src.indexOf("this.dispatchEvent(new Event('change'");
  const escapeIndex = src.indexOf('CSS.escape(this.key)');
  const scopedFocus = src.includes("this.el.closest('.panel-host')") &&
    src.includes(focusLookup) &&
    dispatchIndex >= 0 && escapeIndex > dispatchIndex;
  check(
    'change is emitted before a scoped, CSS.escape-quoted stable-key focus lookup',
    scopedFocus,
    `panelScope=${src.includes("this.el.closest('.panel-host')")}, lookup=${src.includes(focusLookup)}, ` +
    `dispatch@${dispatchIndex}, escape@${escapeIndex}`,
  );

  const pointerHoverStaysDistinct = !src.includes("item.addEventListener('pointermove'");
  check(
    'pointer hover does not synthesize the keyboard-active ring',
    pointerHoverStaysDistinct,
    `pointerHoverStaysDistinct=${pointerHoverStaysDistinct}`,
  );

  const hoverToken = css.includes(
    '--popover-hover: color-mix(in oklab, var(--popover) 92%, var(--popover-foreground))',
  );
  const hoverRule = /\.select-item:hover\s*\{\s*background:\s*var\(--popover-hover\)/.test(css);
  const activeRule =
    /\.select-item\.active\s*\{[^}]*background:\s*var\(--popover-hover\)[^}]*outline:\s*2px solid var\(--ring\)/.test(css);
  const noDarkHoverOverride = !/html\[data-theme="dark"\]\s*\{[^}]*--popover-hover/.test(css) &&
    !/html\[data-theme="dark"\]\s*\.select-item(?![\w-])/.test(css);
  check(
    'hover and keyboard-active are token-derived, distinct, and not re-sourced per theme',
    hoverToken && hoverRule && activeRule && noDarkHoverOverride,
    `hoverToken=${hoverToken}, hoverRule=${hoverRule}, activeRule=${activeRule}, noDarkOverride=${noDarkHoverOverride}`,
  );

  const sharedSurfaceBody = ruleBody('.select-popover, .settings-menu, .settings-flyout');
  const sharedSurfaceNeedles = [
    'background: var(--popover)',
    'color: var(--popover-foreground)',
    'border: 1px solid var(--border)',
    'border-radius: var(--radius)',
    'box-shadow: 0 8px 24px rgb(0 0 0 / 40%)',
  ];
  const sharedSurface = sharedSurfaceBody !== null &&
    sharedSurfaceNeedles.every((needle) => sharedSurfaceBody.includes(needle));
  check(
    'the select popover, settings menu, and flyout share one token-only surface rule',
    sharedSurface,
    `body=${JSON.stringify(sharedSurfaceBody)}`,
  );

  const themedShadow =
    /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.select-popover,\s*:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.settings-menu,\s*:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.settings-flyout\s*\{\s*box-shadow:\s*0 8px 24px var\(--shadow\);\s*\}/.test(css);
  const noDarkSurfaceRedefinition =
    !/html\[data-theme="dark"\]\s*\.select-popover\s*\{/.test(css) &&
    !/html\[data-theme="dark"\]\s*\.settings-(menu|flyout)\s*\{[^}]*border-radius:/.test(css);
  check(
    'the popover family takes the literal base shadow and the token shadow in both theme overrides',
    sharedSurface && themedShadow && noDarkSurfaceRedefinition,
    `shared=${sharedSurface}, themedShadow=${themedShadow}, ` +
    `noDarkSurfaceRedefinition=${noDarkSurfaceRedefinition}`,
  );

  const settingsItemBody = ruleBody('.settings-item');
  const settingsState = settingsItemBody !== null &&
    settingsItemBody.includes('border-radius: calc(var(--radius) - 2px)') &&
    settingsItemBody.includes('color: var(--popover-foreground)') &&
    (ruleBody('.settings-item:hover, .settings-item.open') ?? '') === 'background: var(--popover-hover);' &&
    (ruleBody('.settings-check') ?? '').includes('color: var(--primary)') &&
    (ruleBody('.settings-hint') ?? '').includes('color: var(--muted-foreground)');
  const darkRules: { selectors: string; body: string }[] = [];
  for (let from = 0; ; ) {
    const open = css.indexOf('html[data-theme="dark"]', from);
    if (open === -1) break;
    const brace = css.indexOf('{', open);
    const close = brace === -1 ? -1 : css.indexOf('}', brace);
    if (brace === -1 || close === -1) break;
    darkRules.push({ selectors: css.slice(open, brace), body: css.slice(brace + 1, close) });
    from = close + 1;
  }
  const darkSettingsState = darkRules.filter((rule) =>
    /\.settings-(item|check|hint)\b/.test(rule.selectors));
  const darkSettingsSurface = darkRules.filter((rule) =>
    /\.settings-(menu|flyout)\b/.test(rule.selectors) &&
    /(?:^|;)\s*(?:background|color|border|border-radius)\s*:/.test(rule.body));
  check(
    'the settings and sidebar rows reuse the select hover, check, radius, and foreground roles',
    settingsState && darkSettingsState.length === 0 && darkSettingsSurface.length === 0,
    `settingsState=${settingsState}, darkStateRules=${darkSettingsState.length}, ` +
    `darkSurfaceRules=${darkSettingsSurface.length}`,
  );

  const deadSelectFocus = /:is\([^)]*\bselect\b[^)]*\)/.test(css);
  const scopedFocusRule =
    css.includes(':is(html[data-theme="dark"], html[data-theme="light"]) :is(button, input, summary):focus-visible');
  check(
    'the retired native select element no longer appears in the shared focus rule',
    !deadSelectFocus && scopedFocusRule,
    `deadSelectFocus=${deadSelectFocus}, scopedFocusRule=${scopedFocusRule}`,
  );

  const rootFont = Number(/html,\s*body\s*\{[^}]*font:\s*([\d.]+)px/.exec(css)?.[1]);
  const defaultRadius = Number(/--radius:\s*([\d.]+)px/.exec(css)?.[1]);
  const darkRadiusRem = Number(
    /html\[data-theme="dark"\]\s*\{[\s\S]*?--radius:\s*([\d.]+)rem/.exec(css)?.[1],
  );
  const darkRadius = darkRadiusRem * rootFont;
  const outerRadius =
    /\.select-trigger\s*\{[^}]*border-radius:\s*var\(--radius\)/.test(css) &&
    (sharedSurfaceBody ?? '').includes('border-radius: var(--radius)');
  const innerRadius = /\.select-item\s*\{[^}]*border-radius:\s*calc\(var\(--radius\) - 2px\)/.test(css);
  check(
    'outer radius is the theme radius and the inner radius stays non-negative in both themes',
    rootFont === 12 && defaultRadius === 3 && darkRadiusRem === 0.625 && darkRadius === 7.5 &&
      defaultRadius - 2 === 1 && darkRadius - 2 === 5.5 &&
      outerRadius && innerRadius,
    `root=${rootFont}px, default=${defaultRadius}px, dark=${darkRadiusRem}rem->${darkRadius}px, ` +
    `outer=${outerRadius}, inner=${innerRadius}`,
  );

  const positionNeedles = [
    'anchor-name: var(--select-anchor, none)',
    'position-anchor: var(--select-anchor, none)',
    'position-area: bottom center',
    'position-try-fallbacks: flip-block, --select-flip-inline',
    '@position-try --select-flip-inline { position-area: bottom span-left; }',
    'min-width: min(anchor-size(width), calc(100vw - 16px))',
    'max-width: min(320px, calc(100vw - 16px))',
    'max-height: min(320px, calc(100vh - 32px))',
    'max-height: min(320px, calc(100dvh - 32px))',
    'margin: 4px 8px',
    'overflow-y: auto',
  ];
  const missingPosition = positionNeedles.filter((needle) => !css.includes(needle));
  check(
    'the popover is anchor-positioned, clamped to the viewport, and scroll-bounded',
    missingPosition.length === 0,
    `missing=${JSON.stringify(missingPosition)}`,
  );

  const scrollbarToken =
    css.includes('scrollbar-color: var(--border-high) transparent') &&
    /\.select-popover::-webkit-scrollbar-thumb\s*\{\s*background:\s*var\(--border-high\)/.test(css) &&
    /\.select-popover::-webkit-scrollbar-thumb:hover\s*\{\s*background:\s*var\(--muted-foreground\)/.test(css);
  check(
    'long-list scrollbars use the shared border/muted-foreground token roles',
    scrollbarToken,
    `tokenScrollbars=${scrollbarToken}`,
  );

  const searchRowBody = ruleBody('.select-search');
  const searchRow = searchRowBody !== null &&
    searchRowBody.includes('position: sticky') &&
    searchRowBody.includes('top: 0') &&
    searchRowBody.includes('padding: 4px 0') &&
    searchRowBody.includes('background: var(--popover)') &&
    searchRowBody.includes('border-bottom: 1px solid var(--border)');
  const searchableBody = ruleBody('.select-popover.select-searchable') ?? '';
  const searchableWidth = searchableBody.includes('max-width: min(420px, calc(100vw - 16px))') &&
    searchableBody.includes('padding-top: 0');
  const scrollMargin = /\.select-searchable \.select-item\s*\{[^}]*scroll-margin-top:\s*36px/.test(css);
  const hiddenRule = /\.select-item\[hidden\]\s*\{\s*display:\s*none/.test(css);
  const hitBody = ruleBody('.select-item-hit');
  const hitRule = hitBody !== null &&
    hitBody.includes('color: var(--primary)') &&
    hitBody.includes('text-decoration: underline') &&
    !hitBody.includes('font-weight');
  const emptyRule = (ruleBody('.select-empty') ?? '').includes('color: var(--muted-foreground)');
  const noSearchInputRule = !/\.select-search(?:able)?\s+input/.test(css) && !css.includes('.select-search-input');
  check(
    'the search surface CSS is additive and token-only, and the input inherits the shared .field rule',
    searchRow && searchableWidth && scrollMargin && hiddenRule && hitRule && emptyRule && noSearchInputRule,
    `searchRow=${searchRow}, width=${searchableWidth}, scrollMargin=${scrollMargin}, ` +
    `hidden=${hiddenRule}, hit=${hitRule}, empty=${emptyRule}, noInputRule=${noSearchInputRule}`,
  );

  const tokenSurfaceNeedles = [
    'background: var(--background)',
    'color: var(--foreground)',
    'border: 1px solid var(--border)',
    'background: var(--popover)',
    'color: var(--popover-foreground)',
    'color: var(--primary)',
    'outline: 2px solid var(--ring)',
  ];
  const missingTokens = tokenSurfaceNeedles.filter((needle) => !css.includes(needle));
  const noDefaultScope = !css.includes('[data-theme="default"]');
  const noBaseTriggerRing = !css.includes('.select-trigger:focus-visible');
  check(
    'trigger, popover, check, hover, and focus read semantic tokens with no default-scope rule',
    missingTokens.length === 0 && noDefaultScope && noBaseTriggerRing,
    `missing=${JSON.stringify(missingTokens)}, noDefaultScope=${noDefaultScope}, ` +
    `noBaseTriggerRing=${noBaseTriggerRing}`,
  );

  const capture = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const analyzer = fs.readFileSync('src/ui/analyzerPanel.ts', 'utf8');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');

  const controlKeys = [
    'capture.sampleRate',
    'capture.threshold',
    'capture.preTrigger',
    'capture.testMode',
  ];
  const controlCalls = capture.match(/selectControl\(/g)?.length ?? 0;
  const missingKeys = controlKeys.filter((key) => !capture.includes(`'${key}'`));
  const oldNativeSites = [
    'const rate = select(',
    'const th = select(',
    'const pre = select(',
    'const source = select(',
  ].filter((needle) => capture.includes(needle));
  const oldLabelled = [
    "labelled(t('capturePanel.sampleRate')",
    "labelled(t('capturePanel.threshold')",
    "labelled(t('capturePanel.preTriggerBuffer')",
    "labelled(t('capturePanel.testMode')",
  ].filter((needle) => capture.includes(needle));
  check(
    'all four capture selects are migrated to selectControl with stable keys',
    missingKeys.length === 0 && controlCalls === 4 && oldNativeSites.length === 0 &&
      oldLabelled.length === 0,
    `missingKeys=${JSON.stringify(missingKeys)}, controlCalls=${controlCalls}, ` +
    `oldNativeSites=${JSON.stringify(oldNativeSites)}, oldLabelled=${JSON.stringify(oldLabelled)}`,
  );

  const appendedRoots = [
    'rowRT.appendChild(rate.el)',
    'rowRT.appendChild(th.el)',
    'triggerSec.body.appendChild(pre.el)',
    'body.appendChild(source.el)',
  ].filter((needle) => capture.includes(needle));
  check(
    'each migrated control appends its own .field.select-field root instead of labelled()',
    appendedRoots.length === 4,
    `appended=${JSON.stringify(appendedRoots)}`,
  );

  const payloadNeedles = [
    'samplerate: Number(rate.value)',
    'thresholdVolts: Number(th.value)',
    'preTriggerPercent: Number(pre.value)',
    'testMode: Number(source.value) as 0 | 1 | 2',
  ];
  const missingPayload = payloadNeedles.filter((needle) => !capture.includes(needle));
  check(
    'every onSettings payload and value coercion is preserved verbatim',
    missingPayload.length === 0,
    `missing=${JSON.stringify(missingPayload)}`,
  );

  check(
    'the pre-trigger and test-mode disabled conditions are unchanged',
    capture.includes('pre.disabled = v.running || v.stopping;') &&
      capture.includes('source.disabled = v.running;'),
    `pre=${capture.includes('pre.disabled = v.running || v.stopping;')}, ` +
    `source=${capture.includes('source.disabled = v.running;')}`,
  );

  const analyzerMigrated =
    analyzer.includes("import { selectControl, type SelectOptionTuple } from './select.js';") &&
    !analyzer.includes("select } from './capturePanel.js'") &&
    (analyzer.match(/selectControl\(/g)?.length ?? 0) === 3;
  const analyzerKeys = [
    "'analyzer.decoder'",
    '`analyzer.channel.${i}`',
    '`analyzer.option.${opt.id}`',
  ];
  const missingAnalyzerKeys = analyzerKeys.filter((needle) => !analyzer.includes(needle));
  const pickRoot = analyzer.includes('add.body.appendChild(pick.el)');
  const selRoots = analyzer.match(/add\.body\.appendChild\(sel\.el\)/g)?.length ?? 0;
  check(
    'the decoder picker, channel maps, and enumerated options all use selectControl with stable keys',
    analyzerMigrated && missingAnalyzerKeys.length === 0 && pickRoot && selRoots === 2,
    `migrated=${analyzerMigrated}, missingKeys=${JSON.stringify(missingAnalyzerKeys)}, ` +
    `pickRoot=${pickRoot}, selRoots=${selRoots}`,
  );

  const draftNeedles = [
    'this.chosen = pick.value;',
    'this.draftChannels = {};',
    'this.draftOptions = {};',
    'if (val < 0) delete this.draftChannels[i];',
    'else this.draftChannels[i] = val;',
    'this.draftOptions[opt.id] = coerce(opt.type, sel.value);',
  ];
  const missingDraft = draftNeedles.filter((needle) => !analyzer.includes(needle));
  check(
    'decoder selection still resets drafts and every channel/option draft update is preserved',
    missingDraft.length === 0,
    `missing=${JSON.stringify(missingDraft)}`,
  );

  const searchConfigNeedles = [
    'search: {',
    "label: t('analyzerPanel.decoderSearchLabel')",
    "placeholder: t('analyzerPanel.decoderSearchPlaceholder')",
    "empty: t('analyzerPanel.decoderNoMatch')",
  ];
  const missingSearchConfig = searchConfigNeedles.filter((needle) => !analyzer.includes(needle));
  const enCatalog = fs.readFileSync('src/ui/locales/en.ts', 'utf8');
  const enNeedles = [
    "'analyzerPanel.decoderSearchLabel': 'Search protocols'",
    "'analyzerPanel.decoderSearchPlaceholder': 'Type to filter protocols'",
    "'analyzerPanel.decoderNoMatch': 'No protocol matches \"{query}\"'",
  ];
  const missingEn = enNeedles.filter((needle) => !enCatalog.includes(needle));
  check(
    'the decoder picker opts into the search mode with translated, caller-owned strings',
    missingSearchConfig.length === 0 && missingEn.length === 0,
    `missingConfig=${JSON.stringify(missingSearchConfig)}, missingEn=${JSON.stringify(missingEn)}`,
  );

  const nativeFactoryNeedle = ['export function ', 'select('].join('');
  const nativeCtorNeedle = ['createElement(', "'select'", ')'].join('');
  const sourceFiles = walk('src');
  const nativeFactoryFiles = sourceFiles.filter((path) =>
    fs.readFileSync(path, 'utf8').includes(nativeFactoryNeedle));
  const nativeCtorFiles = sourceFiles.filter((path) =>
    fs.readFileSync(path, 'utf8').includes(nativeCtorNeedle));
  check(
    'the native select factory and every native <select> construction are gone from src',
    nativeFactoryFiles.length === 0 && nativeCtorFiles.length === 0,
    `factory=${JSON.stringify(nativeFactoryFiles)}, constructors=${JSON.stringify(nativeCtorFiles)}`,
  );

  const noNativeSelectSelector = !/\.field\s+select\b/.test(css);
  const baseInputRule = /\.field input\s*\{[^}]*background:\s*var\(--bg10\)[^}]*color:\s*var\(--text80\)[^}]*border:\s*1px solid var\(--border-low\)[^}]*border-radius:\s*3px[^}]*padding:\s*4px 6px;[^}]*font:\s*inherit[^}]*width:\s*100%/.test(css);
  const themedInputRule = /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\)\s*\.field input,\s*:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\)\s*\.usb-console-command input\s*\{[^}]*background:\s*var\(--background\)[^}]*border-color:\s*var\(--input\)[^}]*border-radius:\s*calc\(var\(--radius\) - 4px\)/.test(css);
  check(
    'the native select selector is removed while every input declaration survives in both themes',
    noNativeSelectSelector && baseInputRule && themedInputRule,
    `noSelectSelector=${noNativeSelectSelector}, baseInput=${baseInputRule}, themedInput=${themedInputRule}`,
  );

  const guardIndex = app.indexOf("closest('.select-field') !== null");
  const fitIndex = app.indexOf("e.key === 'f'");
  const inputGuard = app.indexOf('e.target instanceof HTMLInputElement');
  const shortcutGuard = guardIndex >= 0 && fitIndex >= 0 &&
    inputGuard >= 0 && inputGuard < guardIndex && guardIndex < fitIndex;
  check(
    'application shortcuts ignore key events from .select-field before f/Space/Escape handling',
    shortcutGuard,
    `inputGuard@${inputGuard}, selectFieldGuard@${guardIndex}, fHandler@${fitIndex}`,
  );
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
