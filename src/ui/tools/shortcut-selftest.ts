import {
  SHORTCUTS, actionOf, gestureNotation, referenceGestures, shortcutActionText, shortcutsIn,
  type ShortcutEntry, type ShortcutId,
} from '../shortcuts.js';
import { formatChord } from '../chords.js';
import { t, type MessageKey } from '../i18n.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
  existsSync(path: string): boolean;
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

function runShortcutBody(source: string): string {
  const start = source.indexOf('private runShortcut(');
  if (start < 0) return '';
  const end = source.indexOf('\n  }', start);
  return end < 0 ? '' : source.slice(start, end);
}

const BRANCH_ACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["if (id === 'capture.toggle') {", 'this.primaryAction();'],
  ["if (id === 'view.fit') {", 'this.stack.zoomToFit();'],
  ["if (id === 'cursors.clear') {", 'this.clearCursors();'],
];

function branchBody(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  if (start < 0) return '';
  const end = source.indexOf('\n    }', start);
  return end < 0 ? '' : source.slice(start, end);
}

function branchesKeepTheirOwnAction(source: string): boolean {
  return BRANCH_ACTIONS.every(([anchor, action]) => branchBody(source, anchor).includes(action));
}

const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const body = keydownBody(appSource);

{
  const rows = SHORTCUTS.map((entry) =>
    `${entry.id}|${entry.group}|${entry.chords.join(',')}`).join(';');
  check('the catalogue is exactly seven rows in dispatch order with pinned groups and chords',
    SHORTCUTS.length === 7 &&
    rows === 'capture.toggle|view|Space;view.fit|view|F;cursors.clear|view|Escape;' +
      'view.zoomIn|view|+,=;view.zoomOut|view|-,_;view.panLeft|view|ArrowLeft;' +
      'view.panRight|view|ArrowRight' &&
    shortcutsIn('view').length === 7 && shortcutsIn('file').length === 0 &&
    shortcutsIn('navigation').length === 0,
    `rows=${rows}`);
}

{
  const shown = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => formatChord(chord, false)).join(' / ')).join('|');
  check('every reference row prints its chords through formatChord, aliases included',
    shown === 'Space|F|Esc|+ / =|- / _|←|→',
    `shown=${shown}`);
}

{
  const single = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => formatChord(chord, true)).join(' / ')).join('|');
  const mutated = SHORTCUTS.map((entry) => ({ ...entry, chords: [...entry.chords].reverse() }))
    .map((entry) => entry.chords.map((chord) => formatChord(chord, true)).join(' / ')).join('|');
  check('control: a reordered chord list changes the rendered notation',
    mutated !== single && single === 'Space|F|Esc|+ / =|- / _|←|→' &&
    mutated === 'Space|F|Esc|= / +|_ / -|←|→',
    `real=${single}, mutated=${mutated}`);
}

{
  const mapped: Array<[string, ShortcutId | null]> = [
    ['Space', actionOf('Space')],
    ['F', actionOf('F')],
    ['Escape', actionOf('Escape')],
    ['+', actionOf('+')],
    ['=', actionOf('=')],
    ['-', actionOf('-')],
    ['_', actionOf('_')],
    ['ArrowLeft', actionOf('ArrowLeft')],
    ['ArrowRight', actionOf('ArrowRight')],
  ];
  const want = ['capture.toggle', 'view.fit', 'cursors.clear', 'view.zoomIn', 'view.zoomIn',
    'view.zoomOut', 'view.zoomOut', 'view.panLeft', 'view.panRight'];
  check('actionOf maps every live chord and alias to its id',
    mapped.every(([, id], index) => id === want[index]),
    `mapped=${mapped.map(([key, id]) => `${JSON.stringify(key)}:${String(id)}`).join(',')}`);
}

{
  const misses = ['', 'F ', 'Enter', 'Return', 'f ', 'ArrowUp', 'ArrowDown', 'Add',
    'Shift+ArrowLeft', 'Mod++', 'Mod+=', 'Mod+Space', 'Mod+F', 'Alt+Escape'];
  const answers = misses.map((key) => actionOf(key));
  check('actionOf answers null for unmatched and modifier-held chords',
    answers.every((answer) => answer === null) && actionOf('+') === 'view.zoomIn',
    `answers=${answers.map((answer) => String(answer)).join(',')}`);
}

{
  const needles: Array<[string, boolean]> = [
    ['chordOf(e)', body.includes('const chord = chordOf(e);')],
    ['chord === null', body.includes('if (chord === null) return;')],
    ['actionOf(chord)', body.includes('const id = actionOf(chord)')],
    ['runShortcut(shift)', body.includes('this.runShortcut(id, e.shiftKey)')],
    ['HTMLInputElement', body.includes('HTMLInputElement')],
    ['.select-field', body.includes('.select-field')],
    ['dialog[open]', body.includes('dialog[open]')],
  ];
  const missing = needles.filter(([, hit]) => !hit).map(([name]) => name);
  check('the keydown listener resolves a chord, then an id, then one handler, and keeps every guard',
    missing.length === 0 && body.length > 0 && !body.includes('shortcutIdFor'),
    `missing=${JSON.stringify(missing)}, bodyLength=${body.length}`);
}

{
  const branches = BRANCH_ACTIONS.map(([anchor, action]) => {
    const slice = branchBody(runShortcutBody(appSource), anchor);
    return `${action}@${slice.length}`;
  });
  check('each dispatched branch keeps its own action inside its own body',
    branchesKeepTheirOwnAction(runShortcutBody(appSource)),
    `branches=${JSON.stringify(branches)}`);
}

{
  const source = runShortcutBody(appSource);
  const moved = source
    .replace('      this.primaryAction();\n', '')
    .replace('      this.stack.zoomToFit();\n', '      this.stack.zoomToFit();\n      this.primaryAction();\n');
  check('control: an action moved into another branch still fails the branch predicate',
    moved !== source && !branchesKeepTheirOwnAction(moved) &&
    branchesKeepTheirOwnAction(source),
    `moved=${moved !== source}, movedHit=${branchesKeepTheirOwnAction(moved)}, ` +
    `realHit=${branchesKeepTheirOwnAction(source)}`);
}

{
  const leaked = RETIRED_KEY_LITERALS.filter((needle) => body.includes(needle));
  check('the three literal key comparisons are gone from the listener',
    body.length > 0 && leaked.length === 0,
    `leaked=${JSON.stringify(leaked)}`);
}

{
  const mutated = appSource.replace(
    'const chord = chordOf(e);',
    "const chord = chordOf(e);\n      if (e.key === 'f') return;");
  check('control: a re-inserted e.key === \'f\' literal is detected by the same predicate',
    mutated !== appSource && hasRetiredKeyLiteral(mutated) && !hasRetiredKeyLiteral(appSource),
    `mutated=${mutated !== appSource}, mutatedHit=${hasRetiredKeyLiteral(mutated)}, ` +
    `realHit=${hasRetiredKeyLiteral(appSource)}`);
}

{
  const source = fs.readFileSync('src/ui/shortcuts.ts', 'utf8');
  const forbidden = ['document', 'window', 'addEventListener', '//', '/*'];
  const hits = forbidden.filter((token) => source.includes(token));
  const imports = [...source.matchAll(/^import .*$/gm)].map((match) => match[0]);
  const bodySource = source.replace(/^import .*$/gm, '');
  check('the catalogue imports only the message catalog and the chord model, and touches no DOM',
    hits.length === 0 && imports.length === 3 &&
    imports.filter((line) => line.endsWith("from './i18n.js';")).length === 2 &&
    imports.filter((line) => line.endsWith("from './chords.js';")).length === 1 &&
    bodySource.trimStart().startsWith('export type ShortcutId'),
    `hits=${JSON.stringify(hits)}, imports=${JSON.stringify(imports)}`);
}

{
  const source = fs.readFileSync('src/ui/shortcuts.ts', 'utf8');
  const mutated = source.replace(
    "import { CHORD_ALIASES } from './chords.js';",
    "import { CHORD_ALIASES } from './chords.js';\nimport { zoomToFit } from './view.js';");
  const imports = (text: string): string[] => [...text.matchAll(/^import .*$/gm)].map((match) => match[0]);
  const allowed = (lines: readonly string[]): boolean => lines.every((line) =>
    line.endsWith("from './i18n.js';") || line.endsWith("from './chords.js';"));
  check('control: a third module import is detected by the same predicate',
    mutated !== source && imports(mutated).length === 4 && !allowed(imports(mutated)) &&
    allowed(imports(source)),
    `mutated=${imports(mutated).length}, real=${imports(source).length}`);
}

{
  const rows = SHORTCUTS.map((entry) => `${entry.id}|${entry.labels.join(',')}`).join(';');
  check('every row names its command through catalog keys, in dispatch order',
    rows === 'capture.toggle|toolbar.start,toolbar.stop;view.fit|toolbar.fit;' +
      'cursors.clear|shortcuts.clearCursors;view.zoomIn|shortcuts.zoomIn;' +
      'view.zoomOut|shortcuts.zoomOut;view.panLeft|shortcuts.panLeft;view.panRight|shortcuts.panRight',
    `rows=${rows}`);
}

{
  // The mouse half of the reference follows the "wheel zooms" setting the same way the
  // wheel handlers do, and every row names catalog keys present in all four locales.
  const describe = (zooms: boolean): string => referenceGestures(zooms)
    .map((entry) => `${entry.modifiers.join('+')}${entry.modifiers.length > 0 ? '+' : ''}${entry.input}=` +
      entry.labels.join(','))
    .join(';');
  const off = describe(false);
  const on = describe(true);
  const keys = [false, true].flatMap((zooms) => referenceGestures(zooms)
    .flatMap((entry) => [entry.input, ...entry.labels]));
  const missing = keys.filter((key) => [en, zhCN, ru, fr].some((dict) => !dict[key]));
  check('the mouse reference lists the wheel, Shift+wheel, Shift+arrows, drag, double-click and pinch',
    off.startsWith('shortcuts.input.wheel=shortcuts.scrollRows;Ctrl+shortcuts.input.wheel=shortcuts.zoomTime;') &&
    on.startsWith('shortcuts.input.wheel=shortcuts.zoomTime;Ctrl+shortcuts.input.wheel=shortcuts.scrollRows;') &&
    off.endsWith('Shift+shortcuts.input.wheel=shortcuts.panTime;Shift+shortcuts.input.arrows=shortcuts.panPage;' +
      'shortcuts.input.drag=shortcuts.panTime;shortcuts.input.doubleClick=shortcuts.addCursor;' +
      'shortcuts.input.pinch=shortcuts.zoomTime') &&
    gestureNotation(referenceGestures(false)[1]!) === 'Ctrl + Wheel' && missing.length === 0,
    `off=${off}; on=${on}; missing=${missing.join(',')}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const listener = body;
  check('the zoom and pan keys dispatch to keyZoom/keyPan and never see a modifier flag',
    shortcuts.includes("if (id === 'view.zoomIn') { this.keyZoom(1); return true; }") &&
    shortcuts.includes("if (id === 'view.zoomOut') { this.keyZoom(-1); return true; }") &&
    shortcuts.includes("if (id === 'view.panLeft') { this.keyPan(-1, shiftKey); return true; }") &&
    shortcuts.includes('this.keyPan(1, shiftKey);') &&
    shortcuts.includes('return true;') &&
    !shortcuts.includes('ctrlKey') && !shortcuts.includes('metaKey') &&
    !shortcuts.includes('altKey') &&
    !listener.includes('ctrlKey') && !listener.includes('metaKey') &&
    !listener.includes('altKey') &&
    appSource.includes('this.stack.zoomAt(this.stack.widthDevicePx / 2, direction > 0 ? Math.SQRT1_2 : Math.SQRT2);') &&
    appSource.includes('this.stack.panPixels(direction * this.stack.widthDevicePx * (big ? 0.5 : 0.1));'),
    `shortcuts=${shortcuts.length}, listener=${listener.length}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const gated = shortcuts.replace(
    "if (id === 'view.zoomIn') { this.keyZoom(1); return true; }",
    "if (id === 'view.zoomIn') { if (ctrlKey) return false; this.keyZoom(1); return true; }");
  const modifierFree = (source: string): boolean =>
    source.length > 0 && !source.includes('ctrlKey') && !source.includes('metaKey') &&
    !source.includes('altKey');
  check('control: a reintroduced per-branch modifier gate fails the same predicate',
    gated !== shortcuts && !modifierFree(gated) && modifierFree(shortcuts),
    `gated=${modifierFree(gated)}, real=${modifierFree(shortcuts)}`);
}

{
  const resolve = (chord: string, guardLetters: boolean): ShortcutId | null => {
    const direct = actionOf(chord);
    if (direct !== null) return direct;
    const unshifted = chord.startsWith('Shift+') ? chord.slice('Shift+'.length) : '';
    return guardLetters && /^[A-Z]$/.test(unshifted) ? null : actionOf(unshifted);
  };
  const fallback = body.includes("const unshifted = chord.startsWith('Shift+') ? " +
    "chord.slice('Shift+'.length) : '';") &&
    body.includes('actionOf(chord) ?? (/^[A-Z]$/.test(unshifted) ? null : actionOf(unshifted))') &&
    actionOf('F') === 'view.fit' && actionOf('ArrowLeft') === 'view.panLeft';
  const broadened = body
    .replace('(/^[A-Z]$/.test(unshifted) ? null : actionOf(unshifted))', 'actionOf(unshifted)');
  check('a shifted non-letter keeps its unmodified chord while a shifted letter resolves nothing',
    fallback && broadened !== body &&
    resolve('Shift+F', false) === 'view.fit' && resolve('Shift+F', true) === null &&
    resolve('Shift+ArrowLeft', true) === 'view.panLeft' &&
    resolve('Shift+Escape', true) === 'cursors.clear',
    `fallback=${fallback}, widened=${String(resolve('Shift+F', false))}, ` +
    `narrowed=${String(resolve('Shift+F', true))}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const premature = shortcuts.replace(
    '      if (document.querySelector(\'.cursor-dist-popover:popover-open\') !== null) return false;\n', '');
  check('the cursor clearing branch keeps its open-picker bail before touching the cursors',
    shortcuts.includes(".cursor-dist-popover:popover-open") &&
    shortcuts.includes('this.releaseMarkerPointer();') &&
    shortcuts.includes('this.clearCursors();') &&
    shortcuts.indexOf('.cursor-dist-popover:popover-open') <
      shortcuts.indexOf('this.clearCursors();') &&
    premature !== shortcuts && !premature.includes('.cursor-dist-popover:popover-open'),
    `bailAt=${shortcuts.indexOf('.cursor-dist-popover:popover-open')}, ` +
    `clearAt=${shortcuts.indexOf('this.clearCursors();')}`);
}

const SHORTCUT_KEY_VALUES: ReadonlyArray<readonly [MessageKey, readonly [string, string, string, string]]> = [
  ['shortcuts.keyboard', ['Keyboard', '键盘', 'Клавиатура', 'Clavier']],
  ['shortcuts.mouse', ['Mouse and touch', '鼠标与触控', 'Мышь и касание', 'Souris et tactile']],
  ['settings.wheelZooms', ['Wheel zooms (no Ctrl needed)', '滚轮直接缩放', 'Колесо масштабирует (без Ctrl)',
    'La molette zoome (sans Ctrl)']],
  ['shortcuts.close', ['Close', '关闭', 'Закрыть', 'Fermer']],
  ['shortcuts.clearCursors', ['Clear cursors', '清除光标', 'Сбросить курсоры', 'Effacer les curseurs']],
];

const CATALOGS: ReadonlyArray<readonly [string, (key: MessageKey) => string]> = [
  ['en', (key) => en[key]],
  ['zh-CN', (key) => zhCN[key]],
  ['ru', (key) => ru[key]],
  ['fr', (key) => fr[key]],
];

{
  const drift: string[] = [];
  for (let index = 0; index < CATALOGS.length; index += 1) {
    const locale = CATALOGS[index]![0];
    const lookup = CATALOGS[index]![1];
    for (const [key, values] of SHORTCUT_KEY_VALUES) {
      const actual = lookup(key);
      if (actual !== values[index]) drift.push(`${locale}:${key}=${JSON.stringify(actual)}`);
    }
  }
  check('all four catalogs carry the five reference keys with their pinned values',
    drift.length === 0 && SHORTCUT_KEY_VALUES.every(([key]) => en[key] !== undefined),
    drift.length === 0 ? `${CATALOGS.length} catalogs x ${SHORTCUT_KEY_VALUES.length} keys match`
      : drift.join('; '));
}

{
  const texts = SHORTCUTS.map((entry) => shortcutActionText(entry));
  check('the reference action text joins the labeled catalog keys with the two-label separator',
    texts.join(' | ') === 'Capture / Stop | Fit | Clear cursors | Zoom in | Zoom out | ' +
      'Pan left (earlier) | Pan right (later)' &&
    SHORTCUTS[0]!.labels.length === 2 && t('toolbar.start') === 'Capture',
    `texts=${texts.join(' | ')}`);
}

{
  const swapped: ShortcutEntry = { ...SHORTCUTS[0]!, labels: ['toolbar.stop', 'toolbar.start'] };
  check('control: a swapped label pair does not reproduce the pinned action text',
    shortcutActionText(swapped) === 'Stop / Capture' &&
    shortcutActionText(swapped) !== shortcutActionText(SHORTCUTS[0]!),
    `swapped=${shortcutActionText(swapped)}, real=${shortcutActionText(SHORTCUTS[0]!)}`);
}

function methodBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const end = source.indexOf('\n  }', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

const REFERENCE_NEEDLES: readonly string[] = [
  "      case 'shortcuts':\n        return this.shortcutBlocks();",
  "this.groupTitle('shortcuts.keyboard'),",
  "this.groupTitle('shortcuts.mouse'),",
  'this.shortcutList(SHORTCUTS.map((entry) => this.keyRow(',
  'shortcutActionText(entry),',
  "entry.chords.map((chord) => formatChord(chord)).join(' / '),",
  '`shortcut:${entry.id}`',
  'this.shortcutList(referenceGestures(this.host.wheelZooms()).map((entry, index) => this.keyRow(',
  'shortcutActionText(entry), gestureNotation(entry), `gesture:${index}`',
  "list.className = 'shortcuts-list';",
  "row.className = 'shortcuts-row';",
  "action.className = 'shortcuts-action';",
  "chord.className = 'shortcuts-key';",
  'row.tabIndex = -1;',
];

const REFERENCE_RETIRED: readonly string[] = [
  'ShortcutsDialog', 'shortcutsDialog', 'openShortcuts', 'shortcuts-dialog', 'settings.shortcuts',
];

const REFERENCE_DIALOG_GONE = !fs.existsSync('src/ui/shortcutsDialog.ts');

function referenceInPane(settings: string, app: string): boolean {
  const joined = `${settings}\n${app}`;
  return REFERENCE_NEEDLES.every((needle) => settings.includes(needle)) &&
    REFERENCE_RETIRED.every((token) => !joined.includes(token)) &&
    REFERENCE_DIALOG_GONE;
}

{
  const settings = fs.readFileSync('src/ui/settingsDialog.ts', 'utf8');
  check('the settings pane renders both reference lists from the model module and no dialog owns them',
    referenceInPane(settings, appSource) && settings.includes("} from './shortcuts.js';"),
    `missing=${JSON.stringify(REFERENCE_NEEDLES.filter((needle) => !settings.includes(needle)))}, ` +
    `retired=${JSON.stringify(REFERENCE_RETIRED.filter((token) => `${settings}\n${appSource}`.includes(token)))}`);
}

{
  const settings = fs.readFileSync('src/ui/settingsDialog.ts', 'utf8');
  const staleDialog = `${appSource}\n  private readonly shortcutsDialog = new ShortcutsDialog();\n`;
  const staleBridge = appSource.replace(
    '      openAbout: (invoker) => {',
    '      openShortcuts: (invoker) => this.shortcutsDialog.open(invoker),\n      openAbout: (invoker) => {');
  const handWritten = settings.replace(
    'this.shortcutList(SHORTCUTS.map((entry) => this.keyRow(',
    'this.shortcutList([{ labels: [], notation: \'F\' }].map((entry) => this.keyRow(');
  const frozenZooms = settings.replace(
    'referenceGestures(this.host.wheelZooms())',
    'referenceGestures(false)');
  check('control: a second dialog, a restored host bridge, a hand-written key list or a frozen wheel-zoom capture fails the same predicate',
    !referenceInPane(settings, staleDialog) &&
    !referenceInPane(settings, staleBridge) &&
    !referenceInPane(handWritten, appSource) &&
    !referenceInPane(frozenZooms, appSource) &&
    referenceInPane(settings, appSource),
    `dialog=${referenceInPane(settings, staleDialog)}, bridge=${referenceInPane(settings, staleBridge)}, ` +
    `handWritten=${referenceInPane(handWritten, appSource)}, frozen=${referenceInPane(frozenZooms, appSource)}, ` +
    `real=${referenceInPane(settings, appSource)}`);
}

{
  const start = appSource.indexOf("must<HTMLButtonElement>('btn-settings').addEventListener('click'");
  const end = start >= 0 ? appSource.indexOf('\n    });', start) : -1;
  const handler = start >= 0 && end > start ? appSource.slice(start, end) : '';
  const closeAt = handler.indexOf("this.menuStack.closeOthers(null, 'outside')");
  const openAt = handler.indexOf('this.settingsDialog.open(this.el.settings)');
  const closes = handler.includes('this.channelList.closeDialog()') &&
    closeAt >= 0 && openAt > closeAt &&
    ['languageMenu', 'themeMenu'].every((menu) => !handler.includes(`this.${menu}.close(`));
  check('the settings handler keeps closing the channel dialog and the other menus before its own open',
    closes && openAt >= 0,
    `closes=${closes}, closeAt=${closeAt}, openAt=${openAt}, length=${handler.length}`);
}

{
  const body = methodBody(appSource, 'private retranslate(): void {');
  const guard = 'if (this.settingsDialog.isOpen) this.settingsDialog.renderStrings();';
  check('retranslate refreshes the window strings, which now carry the reference, and no second dialog',
    body.includes(guard) && !body.includes('shortcutsDialog') && body.includes('this.relayout();'),
    `guard=${body.includes(guard)}, dialog=${body.includes('shortcutsDialog')}, body=${body.length}`);
}

{
  const body = methodBody(appSource, 'private retranslate(): void {');
  const mutated = body.replace(
    '    applyStaticI18n(document);\n',
    '    applyStaticI18n(document);\n    if (this.shortcutsDialog.isOpen) this.shortcutsDialog.renderStrings();\n');
  check('control: a re-inserted reference-dialog refresh is detected by the same predicate',
    mutated !== body && mutated.includes('shortcutsDialog') && !body.includes('shortcutsDialog'),
    `mutated=${mutated.includes('shortcutsDialog')}, real=${body.includes('shortcutsDialog')}`);
}

{
  const windowKeydowns = appSource.match(/window\.addEventListener\('keydown'/g)?.length ?? 0;
  const documentKeydowns = appSource.match(/document\.addEventListener\('keydown'/g)?.length ?? 0;
  const keydowns = appSource.match(/addEventListener\('keydown'/g)?.length ?? 0;
  check('app.ts adds no markup strings, one window keydown, and no document-level keydown',
    !appSource.includes('innerHTML') && windowKeydowns === 1 && documentKeydowns === 0 &&
    keydowns >= 1 && appSource.includes("window.addEventListener('keydown'"),
    `innerHTML=${appSource.includes('innerHTML')}, window=${windowKeydowns}, ` +
    `document=${documentKeydowns}, scoped=${keydowns - windowKeydowns - documentKeydowns}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
