import { SHORTCUTS, shortcutIdFor, type ShortcutId } from '../shortcuts.js';

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

const RETIRED_KEY_LITERALS = ["e.key === 'f'", "e.key === ' '", "e.key === 'Escape'"];

function keydownBody(source: string): string {
  const start = source.indexOf("window.addEventListener('keydown'");
  if (start < 0) return '';
  const end = source.indexOf('\n    });', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

function hasRetiredKeyLiteral(source: string): boolean {
  const body = keydownBody(source);
  return RETIRED_KEY_LITERALS.some((needle) => body.includes(needle));
}

const BRANCH_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["if (shortcut === 'capture.toggle') {", 'this.primaryAction();'],
  ["} else if (shortcut === 'view.fit') {", 'this.stack.zoomToFit();'],
  ["} else if (shortcut === 'cursors.clear') {", 'this.clearCursors();'],
];

function branchBody(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) return '';
  const end = source.indexOf('\n      }', start);
  return end < 0 ? '' : source.slice(start, end);
}

function branchesKeepTheirOwnAction(source: string): boolean {
  return BRANCH_ACTIONS.every(([anchor, action]) => branchBody(source, anchor).includes(action));
}

const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const body = keydownBody(appSource);

{
  const rows = SHORTCUTS.map((entry) => `${entry.id}|${entry.key}|${entry.notation}`).join(',');
  check('the catalogue is exactly three rows in dispatch order with pinned keys and notation',
    SHORTCUTS.length === 3 &&
    rows === "capture.toggle| |Space,view.fit|f|F,cursors.clear|Escape|Esc",
    `rows=${rows}`);
}

{
  const ids = SHORTCUTS.map((entry) => entry.id);
  const keys = SHORTCUTS.map((entry) => entry.key);
  check('ids and KeyboardEvent.key values are both unique',
    new Set(ids).size === 3 && new Set(keys).size === 3,
    `ids=${ids.join(',')}, keys=${JSON.stringify(keys)}`);
}

{
  const mapped: Array<[string, ShortcutId | null]> = [
    [' ', shortcutIdFor(' ')],
    ['f', shortcutIdFor('f')],
    ['Escape', shortcutIdFor('Escape')],
  ];
  check('shortcutIdFor maps the three live keys to their ids',
    mapped[0][1] === 'capture.toggle' && mapped[1][1] === 'view.fit' &&
    mapped[2][1] === 'cursors.clear',
    `mapped=${mapped.map(([key, id]) => `${JSON.stringify(key)}:${String(id)}`).join(',')}`);
}

{
  const misses = ['', 'F', 'Enter', 'Return', 'f '];
  const answers = misses.map((key) => shortcutIdFor(key));
  check('shortcutIdFor answers null for unmatched keys, including Shift+f and a trailing space',
    answers.every((answer) => answer === null),
    `answers=${answers.map((answer) => String(answer)).join(',')}`);
}

{
  const needles: Array<[string, boolean]> = [
    ['shortcutIdFor(e.key)', body.includes('shortcutIdFor(e.key)')],
    ['primaryAction()', body.includes('this.primaryAction()')],
    ['zoomToFit()', body.includes('this.stack.zoomToFit()')],
    ['clearCursors()', body.includes('this.clearCursors()')],
    ['HTMLInputElement', body.includes('HTMLInputElement')],
    ['.select-field', body.includes('.select-field')],
    ['dialog[open]', body.includes('dialog[open]')],
  ];
  const missing = needles.filter(([, hit]) => !hit).map(([name]) => name);
  check('the keydown listener dispatches through the catalogue and keeps every guard',
    missing.length === 0 && body.length > 0,
    `missing=${JSON.stringify(missing)}, bodyLength=${body.length}`);
}

{
  const branches = BRANCH_ACTIONS.map(([anchor, action]) => {
    const slice = branchBody(appSource, anchor);
    return `${action}@${slice.length}`;
  });
  check('each dispatched branch keeps its own action inside its own body',
    branchesKeepTheirOwnAction(appSource),
    `branches=${JSON.stringify(branches)}`);
}

{
  const moved = appSource
    .replace('        this.primaryAction();\n', '')
    .replace('        this.stack.zoomToFit();\n', '        this.stack.zoomToFit();\n        this.primaryAction();\n');
  check('control: an action moved into another branch still fails the branch predicate',
    moved !== appSource && !branchesKeepTheirOwnAction(moved) &&
    branchesKeepTheirOwnAction(appSource),
    `moved=${moved !== appSource}, movedHit=${branchesKeepTheirOwnAction(moved)}, ` +
    `realHit=${branchesKeepTheirOwnAction(appSource)}`);
}

{
  const leaked = RETIRED_KEY_LITERALS.filter((needle) => body.includes(needle));
  check('the three literal key comparisons are gone from the listener',
    body.length > 0 && leaked.length === 0,
    `leaked=${JSON.stringify(leaked)}`);
}

{
  const mutated = appSource.replace(
    'const shortcut = shortcutIdFor(e.key);',
    "const shortcut = shortcutIdFor(e.key);\n      if (e.key === 'f') return;");
  check('control: a re-inserted e.key === \'f\' literal is detected by the same predicate',
    mutated !== appSource && hasRetiredKeyLiteral(mutated) && !hasRetiredKeyLiteral(appSource),
    `mutated=${mutated !== appSource}, mutatedHit=${hasRetiredKeyLiteral(mutated)}, ` +
    `realHit=${hasRetiredKeyLiteral(appSource)}`);
}

{
  const source = fs.readFileSync('src/ui/shortcuts.ts', 'utf8');
  const forbidden = ['document', 'window', 'addEventListener', '//', '/*'];
  const hits = forbidden.filter((token) => source.includes(token));
  check('the catalogue touches no DOM or browser state and carries no comments',
    hits.length === 0 && source.trimStart().startsWith('export type ShortcutId'),
    `hits=${JSON.stringify(hits)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
