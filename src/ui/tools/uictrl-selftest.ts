import { TOOLBAR_OVERRIDE_LIMITS } from '../toolbarOverride.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
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

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match ? (match[1] ?? null) : null;
}

function hasClassToken(tag: string, token: string): boolean {
  const classes = attr(tag, 'class') ?? '';
  return classes.split(/\s+/).includes(token);
}

const FIELD_IDS = [
  'uictrl-toolbar-height',
  'uictrl-toolbar-min-height',
  'uictrl-toolbar-min-ratio',
] as const;

const FIELD_LIMITS = [
  TOOLBAR_OVERRIDE_LIMITS.height,
  TOOLBAR_OVERRIDE_LIMITS.minHeight,
  TOOLBAR_OVERRIDE_LIMITS.minRatio,
] as const;

const FIELD_PLACEHOLDERS = ['auto', '57', '0'] as const;

const html = fs.readFileSync('uictrl/index.html', 'utf8');
const mainHtml = fs.readFileSync('index.html', 'utf8');
const mainRuntime = fs.readFileSync('src/ui/main.ts', 'utf8');
const controller = fs.readFileSync('uictrl/main.ts', 'utf8');
const config = fs.readFileSync('vite.config.ts', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');
const tsconfig = JSON.parse(fs.readFileSync('tsconfig.json', 'utf8')) as { include?: unknown };

const documentNeedles = [
  '<html lang="en" data-theme="dark">',
  '<title>logicweb uictrl</title>',
  '<link rel="stylesheet" href="/src/ui/style.css" />',
  '<main id="uictrl" aria-labelledby="uictrl-title">',
  '<h1 id="uictrl-title">UI Controls</h1>',
];
const missingDocumentNeedles = documentNeedles.filter((needle) => !html.includes(needle));
check(
  'console document uses the dark theme, global stylesheet, and dedicated mount',
  missingDocumentNeedles.length === 0,
  `missing=${JSON.stringify(missingDocumentNeedles)}`,
);

const controlsMatch = html.match(/<section\b[^>]*id="uictrl-controls"[^>]*>([\s\S]*?)<\/section>/);
const controls = controlsMatch?.[1] ?? '';
const cardTags = controls.match(
  /<article\b[^>]*\bclass="[^"]*\buictrl-card\b[^"]*"[^>]*>/gi) ?? [];
const cardMatch = controls.match(
  /<article\b[^>]*\bclass="[^"]*\buictrl-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/i);
const card = cardMatch?.[1] ?? '';
const inputTags = card.match(/<input\b[^>]*>/gi) ?? [];
const numberInputs = inputTags.filter((tag) => /\btype="number"/.test(tag));
const inputIds = numberInputs.map((tag) => attr(tag, 'id'));
const expectedIds: readonly (string | null)[] = FIELD_IDS;
const orderOk =
  inputIds.length === expectedIds.length &&
  inputIds.every((id, index) => id === expectedIds[index]);
check(
  'controls hold exactly one toolbar card with the three pinned number inputs in order',
  cardTags.length === 1 && card !== '' && numberInputs.length === 3 && orderOk,
  `cards=${cardTags.length}, numberInputs=${JSON.stringify(inputIds)}`,
);

const limitMismatches = numberInputs
  .map((tag, index) => {
    const id = FIELD_IDS[index] ?? `field-${index}`;
    const limits = FIELD_LIMITS[index];
    if (limits === undefined) return `${id}:no-limit`;
    if (attr(tag, 'step') !== '1') return `${id}:step=${attr(tag, 'step')}`;
    if (Number(attr(tag, 'min')) !== limits.min) return `${id}:min=${attr(tag, 'min')}`;
    if (Number(attr(tag, 'max')) !== limits.max) return `${id}:max=${attr(tag, 'max')}`;
    return null;
  })
  .filter((value): value is string => value !== null);
check(
  'each toolbar input declares step=1 and the exact module min/max limits',
  numberInputs.length === 3 && limitMismatches.length === 0,
  `mismatches=${JSON.stringify(limitMismatches)}`,
);

const placeholderMismatches = numberInputs
  .map((tag, index) => {
    const placeholder = attr(tag, 'placeholder');
    return placeholder === FIELD_PLACEHOLDERS[index]
      ? null
      : `${FIELD_IDS[index] ?? `field-${index}`}:${placeholder}`;
  })
  .filter((value): value is string => value !== null);
const labelMissing = FIELD_IDS.filter(
  (id) => !new RegExp(`<label\\b[^>]*\\bfor="${id}"`).test(card));
const unitTexts = [
  ...card.matchAll(
    /<span\b[^>]*\bclass="[^"]*\buictrl-field-unit\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi),
].map((match) => (match[1] ?? '').trim());
const unitsOk =
  unitTexts.length === 3 && unitTexts[0] === 'px' && unitTexts[1] === 'px' && unitTexts[2] === '%';
check(
  'each toolbar input has a label pairing, an unset placeholder, and a unit suffix',
  placeholderMismatches.length === 0 && labelMissing.length === 0 && unitsOk,
  `placeholders=${JSON.stringify(placeholderMismatches)}, ` +
  `labels=${JSON.stringify(labelMissing)}, units=${JSON.stringify(unitTexts)}`,
);

const noteText = (
  card.match(/<p\b[^>]*\bclass="[^"]*\buictrl-card-note\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ??
  '').trim();
const noteOk =
  noteText.includes('max(') && noteText.includes('min-ratio') && noteText.includes('viewport');
const buttonTags = card.match(/<button\b[^>]*>/gi) ?? [];
const resetTag = buttonTags.find((tag) => attr(tag, 'id') === 'uictrl-toolbar-reset') ?? '';
const resetOk =
  buttonTags.length === 1 &&
  resetTag !== '' &&
  attr(resetTag, 'type') === 'button' &&
  hasClassToken(resetTag, 'mini');
const articleTag = cardMatch?.[0].match(/<article\b[^>]*>/i)?.[0] ?? '';
const labelledBy = attr(articleTag, 'aria-labelledby');
const titleTag =
  card.match(/<[^>]*\bclass="[^"]*\buictrl-card-title\b[^"]*"[^>]*>/i)?.[0] ?? '';
const titleId = attr(titleTag, 'id');
const titleOk = labelledBy !== null && labelledBy === titleId;
check(
  'the card documents the composition rule, exposes one Reset, and names its title',
  noteOk && resetOk && titleOk,
  `note=${noteOk}, reset=${resetOk}(${resetTag}), labelledby=${labelledBy}, titleId=${titleId}`,
);

const moduleScripts = html.match(/<script\b[^>]*type="module"[^>]*>/gi) ?? [];
const controllerScripts = moduleScripts.filter((tag) => tag.includes('src="./main.ts"'));
const runtimeNeedles = ['/src/ui/main.ts', 'new App'];
const presentRuntimeNeedles = runtimeNeedles.filter((needle) => html.includes(needle));
check(
  'console document loads exactly one module script: the console controller',
  moduleScripts.length === 1 && controllerScripts.length === 1 && presentRuntimeNeedles.length === 0,
  `moduleScripts=${JSON.stringify(moduleScripts)}, controller=${controllerScripts.length}, ` +
  `present=${JSON.stringify(presentRuntimeNeedles)}`,
);

const mainNeedles = [mainHtml, mainRuntime].filter((source) => /uictrl/i.test(source));
check(
  'primary HTML and bootstrap contain no console discovery reference',
  mainNeedles.length === 0,
  `primarySourcesWithReference=${mainNeedles.length}`,
);

const routeNeedles = [
  "name: 'logicweb:uictrl-entry'",
  "apply: 'serve'",
  "if (url === '/uictrl') request.url = '/uictrl/';",
];
const pluginList = /plugins: \[([^\]]+)\]/.exec(config)?.[1] ?? '';
const missingRouteNeedles = routeNeedles.filter((needle) => !config.includes(needle));
check(
  'serve-only middleware keeps the exact console path ahead of SPA fallback',
  missingRouteNeedles.length === 0 && pluginList.includes('serveUiControlEntry()') &&
    !config.includes("input: 'uictrl/index.html'"),
  `missing=${JSON.stringify(missingRouteNeedles)} serveInPlugins=${pluginList.includes('serveUiControlEntry()')}`,
);

const styleNeedles = [
  '#uictrl {',
  '#uictrl-header {',
  '#uictrl-title {',
  '#uictrl-controls {',
  '.uictrl-card {',
  '.uictrl-card-title',
  '.uictrl-card-note',
  '.uictrl-field {',
  '.uictrl-field-label',
  '.uictrl-field-input',
  '.uictrl-field-unit',
  '.uictrl-card-actions',
];
const missingStyleNeedles = styleNeedles.filter((needle) => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = needle.endsWith('{') ? '' : '(?![\\w-])';
  return !new RegExp(escaped + boundary).test(css);
});
check(
  'console styles stay rooted at the mount and carry the whole card family',
  missingStyleNeedles.length === 0,
  `missing=${JSON.stringify(missingStyleNeedles)}`,
);

const controllerNeedles = [
  "from '../src/ui/toolbarOverride.js'",
  'initToolbarOverride()',
  'setToolbarOverride(',
  'clearToolbarOverride(',
  'onToolbarOverrideChange(',
  ...FIELD_IDS,
  'uictrl-toolbar-reset',
];
const missingControllerNeedles = controllerNeedles.filter(
  (needle) => !controller.includes(needle));
const controllerIds = [...new Set(controller.match(/uictrl-toolbar-[a-z-]+/g) ?? [])];
const danglingIds = controllerIds.filter((id) => !html.includes(`id="${id}"`));
check(
  'the console controller wires the override module to every card control id',
  missingControllerNeedles.length === 0 && danglingIds.length === 0,
  `missing=${JSON.stringify(missingControllerNeedles)}, dangling=${JSON.stringify(danglingIds)}`,
);

const tsconfigInclude = Array.isArray(tsconfig.include) ? tsconfig.include : [];
check(
  'tsconfig.json includes the uictrl page in the tsc gate',
  tsconfigInclude.includes('uictrl'),
  `include=${JSON.stringify(tsconfigInclude)}`,
);

console.log(results.map((result) => (
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`
)).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
