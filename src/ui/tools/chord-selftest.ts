import { APPLE, CHORD_ALIASES, MAX_KEYS, chordOf, formatChord, type ChordPress } from '../chords.js';
import { SHORTCUTS, WORK_ANYWHERE, actionOf, shortcutsIn } from '../shortcuts.js';

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

interface PressInit {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
}

function press(init: PressInit): ChordPress {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey === true,
    altKey: init.altKey === true,
    shiftKey: init.shiftKey === true,
    metaKey: init.metaKey === true,
    ...(init.isComposing === undefined ? {} : { isComposing: init.isComposing }),
  };
}

function pressRows(apple: boolean, rows: readonly (readonly [PressInit, string | null])[]): string {
  return rows
    .map(([init, want]) => `${JSON.stringify(init)}=>${String(chordOf(press(init), apple))}/${String(want)}`)
    .join(' ');
}

function allMatch(apple: boolean, rows: readonly (readonly [PressInit, string | null])[]): boolean {
  return rows.every(([init, want]) => chordOf(press(init), apple) === want);
}

// ---------------------------------------------------------------- chordOf

const KEY_ROWS: readonly (readonly [PressInit, string | null])[] = [
  [{ key: 'f' }, 'F'],
  [{ key: 'f', shiftKey: true }, 'Shift+F'],
  [{ key: 'o', metaKey: true }, 'Mod+O'],
  [{ key: ' ' }, 'Space'],
  [{ key: ' ', shiftKey: true }, 'Shift+Space'],
  [{ key: 'Escape' }, 'Escape'],
  [{ key: 'ArrowLeft' }, 'ArrowLeft'],
  [{ key: 'Home' }, 'Home'],
  [{ key: '+', shiftKey: true }, '+'],
  [{ key: '=' }, '='],
  [{ key: '_', shiftKey: true }, '_'],
  [{ key: '-' }, '-'],
  [{ key: ',' }, ','],
  [{ key: '\\' }, '\\'],
];

{
  const rows = KEY_ROWS.filter(([init]) => init.metaKey !== true);
  check('a press becomes its upper-cased key, named key or symbol without a Shift part',
    allMatch(true, rows) && allMatch(false, rows),
    pressRows(true, rows));
}

{
  const lower = KEY_ROWS.map(([init, want]) => [init, want] as const);
  const mutated = KEY_ROWS.map(([init, want]) => [init, want === null ? null : want.toLowerCase()] as const);
  check('control: a lower-cased expectation fails the same predicate',
    !allMatch(true, mutated) && allMatch(true, lower),
    `mutated=${allMatch(true, mutated)}, real=${allMatch(true, lower)}`);
}

{
  const rows: readonly (readonly [PressInit, string | null])[] = [
    [{ key: 'o', metaKey: true }, 'Mod+O'],
    [{ key: 'k', metaKey: true, shiftKey: true }, 'Mod+Shift+K'],
    [{ key: 'ArrowLeft', metaKey: true, shiftKey: true }, 'Mod+Shift+ArrowLeft'],
    [{ key: '+', metaKey: true, shiftKey: true }, 'Mod++'],
    [{ key: 'o', metaKey: true, altKey: true, shiftKey: true }, 'Mod+Alt+Shift+O'],
  ];
  const withoutMeta = rows.map(() => null);
  check('on Apple, Meta is Mod and keeps the fixed modifier order',
    allMatch(true, rows),
    pressRows(true, rows));
  check('control: the same presses do not answer the same chords without the Apple flag',
    rows.every(([init], index) => chordOf(press(init), false) === withoutMeta[index]) &&
    !allMatch(false, rows),
    pressRows(false, rows));
}

{
  const rows: readonly (readonly [PressInit, string | null])[] = [
    [{ key: 'o', ctrlKey: true }, 'Mod+O'],
    [{ key: 'o', ctrlKey: true, altKey: true }, 'Mod+Alt+O'],
    [{ key: 'o', ctrlKey: true, altKey: true, shiftKey: true }, 'Mod+Alt+Shift+O'],
    [{ key: 'z', ctrlKey: true, shiftKey: true }, 'Mod+Shift+Z'],
    [{ key: 'o', altKey: true }, 'Alt+O'],
  ];
  check('off Apple, Ctrl is Mod and Alt keeps its own part',
    allMatch(false, rows),
    pressRows(false, rows));
  check('control: on Apple the same Ctrl press stays Ctrl, not Mod',
    chordOf(press({ key: 'o', ctrlKey: true }), true) === 'Ctrl+O' &&
    chordOf(press({ key: 'o', ctrlKey: true }), false) === 'Mod+O',
    `apple=${String(chordOf(press({ key: 'o', ctrlKey: true }), true))}, ` +
    `text=${String(chordOf(press({ key: 'o', ctrlKey: true }), false))}`);
}

{
  check('on Apple, Ctrl and Meta together keep both parts in order',
    chordOf(press({ key: 'k', ctrlKey: true, metaKey: true }), true) === 'Mod+Ctrl+K',
    `got=${String(chordOf(press({ key: 'k', ctrlKey: true, metaKey: true }), true))}`);
}

{
  const rows: readonly (readonly [PressInit, string | null])[] = [
    [{ key: 'o', metaKey: true }, null],
    [{ key: 'o', metaKey: true, ctrlKey: true }, null],
    [{ key: 'ArrowLeft', metaKey: true, altKey: true }, null],
  ];
  check('off Apple, Meta is the OS key and never reaches the catalogue',
    allMatch(false, rows) && actionOf('Mod+O') === null,
    pressRows(false, rows));
}

{
  check('the modifier parts stop at MAX_KEYS and the bound is four',
    MAX_KEYS === 4 &&
    chordOf(press({ key: 'k', ctrlKey: true, altKey: true, shiftKey: true }), false) ===
      'Mod+Alt+Shift+K' &&
    chordOf(press({ key: 'k', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }), true) ===
      null,
    `over=${String(chordOf(press({ key: 'k', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }), true))}`);
}

{
  const rows: readonly (readonly [PressInit, string | null])[] = [
    [{ key: 'Shift' }, null],
    [{ key: 'Control' }, null],
    [{ key: 'Meta' }, null],
    [{ key: 'Alt' }, null],
    [{ key: 'AltGraph' }, null],
    [{ key: 'Dead' }, null],
    [{ key: 'Unidentified' }, null],
    [{ key: 'Process' }, null],
    [{ key: '' }, null],
    [{ key: 'f', isComposing: true }, null],
    [{ key: 'Shift', isComposing: true }, null],
  ];
  check('modifier-only keys, dead keys and composing presses answer null',
    allMatch(true, rows) && allMatch(false, rows),
    pressRows(true, rows));
}

{
  const rows: readonly (readonly [PressInit, string | null])[] = [
    [{ key: 'Shift' }, null],
    [{ key: 'Dead' }, null],
    [{ key: 'f', isComposing: true }, null],
  ];
  const relaxed = rows.map(([init]) => [init, 'X'] as const);
  check('control: a predicate that accepts every press fails the null rows',
    !allMatch(true, relaxed) && allMatch(true, rows),
    `relaxed=${allMatch(true, relaxed)}, real=${allMatch(true, rows)}`);
}

// ---------------------------------------------------------------- catalog

{
  const chords = SHORTCUTS.flatMap((entry) => entry.chords);
  const ids = SHORTCUTS.map((entry) => entry.id);
  check('every id appears once and every chord is claimed once across the catalogue',
    new Set(ids).size === ids.length && new Set(chords).size === chords.length &&
    SHORTCUTS.length === 7 && chords.length === 9,
    `ids=${ids.join(',')}, chords=${chords.join(',')}`);
}

{
  const chords = SHORTCUTS.flatMap((entry) => entry.chords);
  const ids = SHORTCUTS.map((entry) => entry.id);
  const duplicatedChord = [...chords, chords[0]!];
  const duplicatedId = [...ids, ids[0]!];
  const unique = (list: readonly string[]): boolean => new Set(list).size === list.length;
  check('control: a duplicated chord or id fails the same uniqueness predicate',
    !unique(duplicatedChord) && !unique(duplicatedId) && unique(chords) && unique(ids) &&
    duplicatedChord.length === chords.length + 1,
    `realChords=${unique(chords)}, dupChord=${unique(duplicatedChord)}, ` +
    `realIds=${unique(ids)}, dupId=${unique(duplicatedId)}`);
}

{
  const every = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => actionOf(chord) === entry.id).join(',')).join(';');
  check('actionOf resolves every catalogued chord to its own row',
    every === 'true;true;true;true,true;true,true;true;true',
    `every=${every}`);
}

{
  const alias = (chord: string): string => CHORD_ALIASES[chord] ?? '';
  check('the shift-free aliases resolve to the canonical chord\'s action',
    alias('=') === '+' && alias('_') === '-' &&
    actionOf('=') === 'view.zoomIn' && actionOf('+') === 'view.zoomIn' &&
    actionOf('_') === 'view.zoomOut' && actionOf('-') === 'view.zoomOut' &&
    actionOf('Mod+=') === null && actionOf('Alt+_') === null,
    `dict=${JSON.stringify(CHORD_ALIASES)}`);
}

{
  const rows = SHORTCUTS.map((entry) => ({ ...entry, chords: [...entry.chords] }));
  const direct = (catalog: readonly { id: string; chords: readonly string[] }[], chord: string):
    string | null => catalog.find((entry) => entry.chords.includes(chord))?.id ?? null;
  const aliased = (catalog: readonly { id: string; chords: readonly string[] }[], chord: string):
    string | null => {
    const hit = direct(catalog, chord);
    if (hit !== null) return hit;
    if (!Object.hasOwn(CHORD_ALIASES, chord)) return null;
    return direct(catalog, CHORD_ALIASES[chord]);
  };
  const canonicalOnly = rows.map((entry) => ({
    ...entry, chords: entry.chords.filter((chord) => chord !== '=' && chord !== '_'),
  }));
  check('the alias stage resolves = and _ once the literal chord is not claimed',
    direct(canonicalOnly, '=') === null && direct(canonicalOnly, '_') === null &&
    aliased(canonicalOnly, '=') === 'view.zoomIn' &&
    aliased(canonicalOnly, '_') === 'view.zoomOut' &&
    actionOf('=') === 'view.zoomIn' && actionOf('_') === 'view.zoomOut',
    `direct=${String(direct(canonicalOnly, '='))}, aliased=${String(aliased(canonicalOnly, '='))}`);
}

{
  const unmapped = ['', 'F ', 'Enter', 'Return', 'Add', 'Shift+F', 'Shift+ArrowLeft', 'Mod+O',
    'Ctrl+O', 'Unknown+Key'];
  const answers = unmapped.map((chord) => actionOf(chord));
  check('actionOf answers null for chords the catalogue does not own yet',
    answers.every((answer) => answer === null) && actionOf('Space') === 'capture.toggle',
    `answers=${answers.map((answer) => String(answer)).join(',')}`);
}

{
  const groups = ['file', 'view', 'navigation'] as const;
  const counts = groups.map((group) => shortcutsIn(group).length).join(',');
  const ids = groups.flatMap((group) => shortcutsIn(group).map((entry) => entry.id));
  check('the three groups partition the catalogue without losing or repeating a row',
    counts === '0,7,0' && new Set(ids).size === ids.length &&
    ids.length === SHORTCUTS.length,
    `counts=${counts}, ids=${ids.join(',')}`);
}

{
  const anywhere = (rows: readonly { readonly id: string; readonly anywhere?: boolean }[]): Set<string> =>
    new Set(rows.filter((row) => row.anywhere === true).map((row) => row.id));
  check('nothing runs while a window or menu is open in this catalogue',
    WORK_ANYWHERE.size === 0 && [...WORK_ANYWHERE].length === 0 &&
    SHORTCUTS.every((entry) => entry.anywhere !== true) &&
    anywhere(SHORTCUTS).size === 0,
    `workAnywhere=${[...WORK_ANYWHERE].join(',')}`);
}

{
  const anywhere = (rows: readonly { readonly id: string; readonly anywhere?: boolean }[]): Set<string> =>
    new Set(rows.filter((row) => row.anywhere === true).map((row) => row.id));
  check('control: an anywhere row would land in the same derived set',
    anywhere([{ id: 'file.open', anywhere: true }, { id: 'view.fit' }]).size === 1 &&
    anywhere(SHORTCUTS).size === 0,
    `synthetic=${anywhere([{ id: 'file.open', anywhere: true }]).size}`);
}

// ---------------------------------------------------------------- formatChord

{
  const rows: readonly (readonly [string, boolean, string])[] = [
    ['Mod+O', true, '⌘O'],
    ['Mod+O', false, 'Ctrl+O'],
    ['Mod+,', true, '⌘,'],
    ['Mod+,', false, 'Ctrl+,'],
    ['Shift+ArrowRight', true, '⇧→'],
    ['Shift+ArrowRight', false, 'Shift+→'],
    ['Shift+ArrowLeft', true, '⇧←'],
    ['ArrowLeft', true, '←'],
    ['ArrowLeft', false, '←'],
    ['Escape', false, 'Esc'],
    ['Space', false, 'Space'],
    ['F', false, 'F'],
    ['Home', false, 'Home'],
    ['+', true, '+'],
    ['+', false, '+'],
    ['-', true, '-'],
    ['Mod++', true, '⌘+'],
    ['Mod++', false, 'Ctrl++'],
    ['', false, ''],
  ];
  const wrong = rows.filter(([chord, apple, want]) => formatChord(chord, apple) !== want);
  check('formatChord prints the modifiers and keys of both platforms, plus a bare + key',
    wrong.length === 0,
    wrong.length === 0 ? `${rows.length} rows match`
      : wrong.map(([chord, apple]) => `${chord}/${String(apple)}=${formatChord(chord, apple)}`).join(' '));
}

{
  const rows: readonly (readonly [string, boolean, string])[] = [
    ['Mod+O', false, 'Ctrl+O'],
    ['Shift+ArrowRight', false, 'Shift+→'],
  ];
  const wrong = rows.filter(([chord, apple, want]) => formatChord(chord, apple) !== want);
  const render = (apple: boolean): string =>
    rows.map(([chord]) => formatChord(chord, apple)).join('|');
  check('control: the Apple form differs, so the platform flag is load-bearing',
    wrong.length === 0 && render(true) === '⌘O|⇧→' && render(false) === 'Ctrl+O|Shift+→' &&
    render(true) !== render(false),
    `apple=${render(true)}, text=${render(false)}`);
}

{
  const naiveKey = (chord: string): string => chord.split('+').filter(Boolean).pop() ?? '';
  check('control: splitting a chord on + loses the bare + key',
    formatChord('+', false) === '+' && naiveKey('+') === '' && naiveKey('Mod+O') === 'O',
    `real=${formatChord('+', false)}, naive=${JSON.stringify(naiveKey('+'))}`);
}

{
  const rendered = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => formatChord(chord, false)).join(' / ')).join('|');
  const apple = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => formatChord(chord, true)).join(' / ')).join('|');
  check('every catalogued chord prints a non-empty distinct notation on both platforms',
    rendered === 'Space|F|Esc|+ / =|- / _|←|→' && apple === rendered,
    `text=${rendered}, apple=${apple}`);
}

// ---------------------------------------------------------------- module shape

{
  const source = fs.readFileSync('src/ui/chords.ts', 'utf8');
  const forbidden = ['document', 'window', 'addEventListener', 'innerHTML', '//', '/*'];
  const hits = forbidden.filter((token) => source.includes(token));
  const imports = [...source.matchAll(/^import .*$/gm)].map((match) => match[0]);
  check('the chord model imports nothing and reads the navigator only through the guarded sniff',
    hits.length === 0 && imports.length === 0 && source.includes('globalThis') &&
    source.includes('navigator') && source.includes('export const APPLE: boolean'),
    `hits=${JSON.stringify(hits)}, imports=${imports.length}, apple=${String(APPLE)}`);
}

{
  const source = fs.readFileSync('src/ui/chords.ts', 'utf8');
  const mutated = source.replace('export const MAX_KEYS = 4;', 'export const MAX_KEYS = 4;\ndocument.title;');
  const forbidden = ['document', 'window', 'addEventListener', 'innerHTML', '//', '/*'];
  const hits = (text: string): string[] => forbidden.filter((token) => text.includes(token));
  check('control: a DOM read in the chord model fails the same predicate',
    mutated !== source && hits(mutated).length === 1 && hits(source).length === 0,
    `mutated=${JSON.stringify(hits(mutated))}, real=${JSON.stringify(hits(source))}`);
}

{
  const source = fs.readFileSync('src/ui/app.ts', 'utf8');
  const listener = source.slice(source.indexOf("window.addEventListener('keydown'"));
  const body = listener.slice(0, listener.indexOf('\n    });'));
  check('the keydown listener hands the resolved chord to the catalogue and one handler',
    body.includes('const chord = chordOf(e);') &&
    body.includes('if (chord === null) return;') &&
    body.includes('actionOf(chord)') &&
    body.includes('this.runShortcut(id, e.shiftKey)') &&
    !body.includes('shortcutIdFor') &&
    !body.includes('e.key ==='),
    `body=${body.length}`);
}

{
  const source = fs.readFileSync('src/ui/app.ts', 'utf8');
  const listener = source.slice(source.indexOf("window.addEventListener('keydown'"));
  const body = listener.slice(0, listener.indexOf('\n    }'));
  const mutated = body.replace(
    'if (chord === null) return;',
    "if (chord === null && e.key === 'f') return;");
  check('control: a literal key comparison beside chordOf fails the same predicate',
    mutated !== body && mutated.includes('e.key ===') && !body.includes('e.key ==='),
    `mutated=${mutated.includes('e.key ===')}, real=${body.includes('e.key ===')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
