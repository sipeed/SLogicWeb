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

  const anatomyNeedles = [
    'export class SelectControl extends EventTarget',
    "popover.setAttribute('popover', 'auto')",
    "trigger.setAttribute('popovertarget', this.listboxId)",
    "trigger.setAttribute('role', 'combobox')",
    "trigger.setAttribute('aria-haspopup', 'listbox')",
    "trigger.setAttribute('aria-expanded'",
    "trigger.setAttribute('aria-controls', this.listboxId)",
    "popover.setAttribute('role', 'listbox')",
    "popover.setAttribute('aria-labelledby', this.labelId)",
    "group.setAttribute('role', 'group')",
    "item.setAttribute('role', 'option')",
    "item.setAttribute('aria-selected'",
    "this.trigger.setAttribute('aria-activedescendant'",
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

  const baseShadow =
    /\.select-popover\s*\{[^}]*box-shadow:\s*0 8px 24px rgb\(0 0 0 \/ 40%\)/.test(css);
  const darkShadow =
    /html\[data-theme="dark"\]\s*\.select-popover\s*\{[^}]*box-shadow:\s*0 8px 24px var\(--shadow\)/.test(css);
  check(
    'the popover carries a literal base shadow and the token shadow only in dark',
    baseShadow && darkShadow,
    `baseShadow=${baseShadow}, darkShadow=${darkShadow}`,
  );

  const rootFont = Number(/html,\s*body\s*\{[^}]*font:\s*([\d.]+)px/.exec(css)?.[1]);
  const defaultRadius = Number(/--radius:\s*([\d.]+)px/.exec(css)?.[1]);
  const darkRadiusRem = Number(
    /html\[data-theme="dark"\]\s*\{[\s\S]*?--radius:\s*([\d.]+)rem/.exec(css)?.[1],
  );
  const darkRadius = darkRadiusRem * rootFont;
  const outerRadius =
    /\.select-trigger\s*\{[^}]*border-radius:\s*var\(--radius\)/.test(css) &&
    /\.select-popover\s*\{[^}]*border-radius:\s*var\(--radius\)/.test(css);
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
  const darkInputRule = /html\[data-theme="dark"\]\s*\.field input,\s*html\[data-theme="dark"\]\s*\.usb-console-command input\s*\{[^}]*background:\s*var\(--background\)[^}]*border-color:\s*var\(--input\)[^}]*border-radius:\s*calc\(var\(--radius\) - 4px\)/.test(css);
  check(
    'the native select selector is removed while every input declaration survives in both themes',
    noNativeSelectSelector && baseInputRule && darkInputRule,
    `noSelectSelector=${noNativeSelectSelector}, baseInput=${baseInputRule}, darkInput=${darkInputRule}`,
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
