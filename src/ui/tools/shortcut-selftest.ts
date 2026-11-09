import {
  SHORTCUTS, SHORTCUT_GROUPS, WORK_ANYWHERE, actionOf, gestureNotation, referenceGestures,
  referenceGroups, shortcutActionText, shortcutGroupLabel, shortcutsIn,
  type ShortcutEntry, type ShortcutGroup, type ShortcutId,
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
  ['capture.toggle', 'this.primaryAction();'],
  ['view.fit', 'this.stack.zoomToFit();'],
  ['cursors.clear', 'this.clearCursors();'],
];

function branchBody(source: string, id: string): string {
  const anchor = `      case '${id}':\n`;
  const start = source.indexOf(anchor);
  if (start < 0) return '';
  const rest = source.slice(start + anchor.length);
  const next = rest.search(/^ {6}(?:case |default:)/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function branchesKeepTheirOwnAction(source: string): boolean {
  return BRANCH_ACTIONS.every(([id, action]) => branchBody(source, id).includes(action));
}

const SWITCH_OPEN = '    switch (id) {\n';
const SWITCH_NEVER =
  '      default: {\n        const unreachable: never = id;\n        return unreachable;\n      }\n';

function exhaustiveSwitch(source: string): boolean {
  const body = runShortcutBody(source);
  const open = body.indexOf(SWITCH_OPEN);
  const never = body.indexOf(SWITCH_NEVER, open);
  const close = body.lastIndexOf('\n    }');
  return body.length > 0 && open > 0 && never > open && close > never &&
    !body.slice(never).includes('this.keyPan(');
}

const ANYWHERE_BLOCK = '      if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {\n' +
  '        if (this.runShortcut(id, e.shiftKey)) e.preventDefault();\n' +
  '        return;\n      }\n';

const OVERLAY_SCOPE = [
  'if (document.querySelector(`dialog[open]:not(#${SETTINGS_DIALOG_ID})`) !== null) return true;',
  "return target instanceof Element && target.closest('[role=\"dialog\"]') !== null;",
];

function anywhereOverlaysOnly(source: string): boolean {
  const listener = keydownBody(source);
  const method = methodBody(source, 'private shortcutBlockedByOverlay(');
  return listener.includes(ANYWHERE_BLOCK) &&
    OVERLAY_SCOPE.every((needle) => method.includes(needle)) &&
    source.includes('import { SETTINGS_DIALOG_ID, SettingsDialog }');
}

function anywhereBeforeGuards(source: string): boolean {
  const listener = keydownBody(source);
  const anywhere = listener.indexOf(ANYWHERE_BLOCK);
  const inputGuard = listener.indexOf('target instanceof HTMLInputElement');
  const dialogGuard = listener.indexOf("closest('dialog[open]')");
  const dispatch = listener.lastIndexOf(
    'if (this.runShortcut(id, e.shiftKey)) e.preventDefault();');
  return listener.length > 0 && anywhere >= 0 && inputGuard > anywhere &&
    dialogGuard > anywhere && dispatch > dialogGuard &&
    listener.indexOf('const id = actionOf(chord)') < anywhere;
}

const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const body = keydownBody(appSource);

{
  const rows = SHORTCUTS.map((entry) =>
    `${entry.id}|${entry.group}|${entry.chords.join(',')}`).join(';');
  check('the catalogue is exactly ten rows in dispatch order with pinned groups and chords',
    SHORTCUTS.length === 10 &&
    rows === 'file.open|file|Mod+O;file.save|file|Mod+S;settings.open|file|Mod+,;' +
      'capture.toggle|view|Space;view.fit|view|F;cursors.clear|view|Escape;' +
      'view.zoomIn|view|+,=;view.zoomOut|view|-,_;view.panLeft|view|ArrowLeft;' +
      'view.panRight|view|ArrowRight' &&
    shortcutsIn('view').length === 7 && shortcutsIn('file').length === 3 &&
    shortcutsIn('navigation').length === 0,
    `rows=${rows}`);
}

{
  const shown = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => formatChord(chord, false)).join(' / ')).join('|');
  check('every reference row prints its chords through formatChord, aliases included',
    shown === 'Ctrl+O|Ctrl+S|Ctrl+,|Space|F|Esc|+ / =|- / _|←|→',
    `shown=${shown}`);
}

function groupListProblem(
  listed: readonly ShortcutGroup[],
  entries: readonly ShortcutEntry[] = SHORTCUTS,
): string | null {
  const empty = listed.filter((group) => !entries.some((entry) => entry.group === group));
  if (empty.length > 0) return `empty:${empty.join(',')}`;
  const repeated = listed.filter((group, index) => listed.indexOf(group) !== index);
  if (repeated.length > 0) return `repeated:${repeated.join(',')}`;
  const printed = listed
    .flatMap((group) => entries.filter((entry) => entry.group === group).map((entry) => entry.id))
    .join(',');
  const dispatch = entries.map((entry) => entry.id).join(',');
  return printed === dispatch ? null : `order:${printed}`;
}

{
  const listed = referenceGroups();
  const ascending = listed.every((group, index) => index === 0 ||
    SHORTCUT_GROUPS.indexOf(listed[index - 1]!) < SHORTCUT_GROUPS.indexOf(group));
  const unreachable = SHORTCUTS.filter((entry) => !SHORTCUT_GROUPS.includes(entry.group));
  check('the reference prints one block per non-empty group in file/view/navigation order and every catalog entry stays reachable',
    SHORTCUT_GROUPS.join(',') === 'file,view,navigation' && listed.length > 0 &&
    ascending && groupListProblem(listed) === null && unreachable.length === 0,
    `groups=${SHORTCUT_GROUPS.join(',')}, listed=${listed.join(',')}, ` +
    `problem=${String(groupListProblem(listed))}, unreachable=${unreachable.length}`);
}

{
  const synthetic: readonly ShortcutEntry[] = [
    { ...SHORTCUTS[0]!, group: 'file' },
    { ...SHORTCUTS[1]!, group: 'navigation' },
  ];
  const contradicted = `order:${synthetic[1]!.id},${synthetic[0]!.id}`;
  check('control: an empty, repeated or catalog-contradicting group list fails the same predicate',
    groupListProblem(['file', 'view'], synthetic) === 'empty:view' &&
    groupListProblem(['file', 'file'], synthetic) === 'repeated:file' &&
    groupListProblem(['navigation', 'file'], synthetic) === contradicted &&
    groupListProblem(['file', 'navigation'], synthetic) === null &&
    groupListProblem(referenceGroups()) === null,
    `empty=${String(groupListProblem(['file', 'view'], synthetic))}, ` +
    `repeated=${String(groupListProblem(['file', 'file'], synthetic))}, ` +
    `contradicted=${String(groupListProblem(['navigation', 'file'], synthetic))}, ` +
    `real=${String(groupListProblem(referenceGroups()))}`);
}

{
  const labels = SHORTCUT_GROUPS.map((group) => shortcutGroupLabel(group)).join('|');
  check('each group heading reads its own catalog key',
    labels === 'File|View|Navigation' &&
    labels === [en['shortcuts.group.file'], en['shortcuts.group.view'],
      en['shortcuts.group.navigation']].join('|'),
    `labels=${labels}`);
}

{
  const single = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => formatChord(chord, true)).join(' / ')).join('|');
  const mutated = SHORTCUTS.map((entry) => ({ ...entry, chords: [...entry.chords].reverse() }))
    .map((entry) => entry.chords.map((chord) => formatChord(chord, true)).join(' / ')).join('|');
  check('control: a reordered chord list changes the rendered notation',
    mutated !== single && single === '⌘O|⌘S|⌘,|Space|F|Esc|+ / =|- / _|←|→' &&
    mutated === '⌘O|⌘S|⌘,|Space|F|Esc|= / +|_ / -|←|→',
    `real=${single}, mutated=${mutated}`);
}

{
  const mapped: Array<[string, ShortcutId | null]> = [
    ['Mod+O', actionOf('Mod+O')],
    ['Mod+S', actionOf('Mod+S')],
    ['Mod+,', actionOf('Mod+,')],
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
  const want = ['file.open', 'file.save', 'settings.open', 'capture.toggle', 'view.fit',
    'cursors.clear', 'view.zoomIn', 'view.zoomIn', 'view.zoomOut', 'view.zoomOut',
    'view.panLeft', 'view.panRight'];
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
    ['WORK_ANYWHERE', body.includes('if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {')],
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
  const branches = BRANCH_ACTIONS.map(([id, action]) => {
    const slice = branchBody(runShortcutBody(appSource), id);
    return `${action}@${slice.length}`;
  });
  check('each dispatched branch keeps its own action inside its own body',
    branchesKeepTheirOwnAction(runShortcutBody(appSource)),
    `branches=${JSON.stringify(branches)}`);
}

{
  const source = runShortcutBody(appSource);
  const moved = source
    .replace('        this.primaryAction();\n', '')
    .replace('        if (!this.fitLockedViewport()) this.stack.zoomToFit();\n',
      '        if (!this.fitLockedViewport()) this.stack.zoomToFit();\n        this.primaryAction();\n');
  check('control: an action moved into another branch still fails the branch predicate',
    moved !== source && !branchesKeepTheirOwnAction(moved) &&
    branchesKeepTheirOwnAction(source),
    `moved=${moved !== source}, movedHit=${branchesKeepTheirOwnAction(moved)}, ` +
    `realHit=${branchesKeepTheirOwnAction(source)}`);
}

{
  check('runShortcut is one exhaustive switch whose default returns the never-typed id',
    exhaustiveSwitch(appSource) && runShortcutBody(appSource).includes("      case 'settings.open':\n"),
    `exhaustive=${exhaustiveSwitch(appSource)}, body=${runShortcutBody(appSource).length}`);
}

{
  const source = runShortcutBody(appSource);
  const silentFallthrough = source.replace(SWITCH_NEVER,
    '      default:\n        this.keyPan(1, shiftKey);\n        return true;\n');
  check('control: a silent keyPan fallthrough replacing the never-typed default fails the same predicate',
    silentFallthrough !== source && !exhaustiveSwitch(silentFallthrough) &&
    exhaustiveSwitch(appSource),
    `fallthrough=${exhaustiveSwitch(silentFallthrough)}, real=${exhaustiveSwitch(appSource)}`);
}

{
  const fileBeforeGuards = anywhereBeforeGuards(appSource);
  const movedBelowGuards = appSource.replace(ANYWHERE_BLOCK, '').replace(
    "      if (target instanceof HTMLElement && target.closest('dialog[open]') !== null) return;\n",
    "      if (target instanceof HTMLElement && target.closest('dialog[open]') !== null) return;\n" +
      ANYWHERE_BLOCK);
  check('the anywhere set runs before the field, button and open-dialog guards and everything else stays behind them',
    fileBeforeGuards && movedBelowGuards !== appSource && !anywhereBeforeGuards(movedBelowGuards),
    `real=${fileBeforeGuards}, moved=${anywhereBeforeGuards(movedBelowGuards)}`);
}

{
  const unscoped = appSource.replace(
    'if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {',
    'if (WORK_ANYWHERE.has(id)) {');
  const settingsIsAModal = appSource.replace(':not(#${SETTINGS_DIALOG_ID})', '');
  const editorDraftLoss = appSource.replace(
    "    return target instanceof Element && target.closest('[role=\"dialog\"]') !== null;",
    '    return false;');
  check('the anywhere set reaches only the settings window and a transient menu',
    anywhereOverlaysOnly(appSource) && unscoped !== appSource &&
    settingsIsAModal !== appSource && editorDraftLoss !== appSource &&
    !anywhereOverlaysOnly(unscoped) && !anywhereOverlaysOnly(settingsIsAModal) &&
    !anywhereOverlaysOnly(editorDraftLoss),
    `real=${anywhereOverlaysOnly(appSource)}, unscoped=${anywhereOverlaysOnly(unscoped)}, ` +
    `modal=${anywhereOverlaysOnly(settingsIsAModal)}, editor=${anywhereOverlaysOnly(editorDraftLoss)}`);
}

{
  const runsWithWindowOpen = (id: ShortcutId): boolean => WORK_ANYWHERE.has(id);
  const locked = [...WORK_ANYWHERE].sort().join(',');
  check('exactly the file and window commands run while the settings window is open',
    locked === 'file.open,file.save,settings.open' &&
    SHORTCUTS.filter((entry) => entry.anywhere === true).length === 3 &&
    runsWithWindowOpen('file.open') && runsWithWindowOpen('file.save') &&
    runsWithWindowOpen('settings.open') && !runsWithWindowOpen('capture.toggle') &&
    !runsWithWindowOpen('view.fit') && !runsWithWindowOpen('cursors.clear') &&
    actionOf('Mod+,') === 'settings.open' && actionOf('Space') === 'capture.toggle' &&
    anywhereBeforeGuards(appSource) &&
    runShortcutBody(appSource).includes(
      '        if (this.settingsDialog.isOpen) {\n          this.settingsDialog.close();\n          return true;\n        }'),
    `anywhere=${locked}, space=${String(actionOf('Space'))}, close=${String(actionOf('Mod+,'))}`);
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
    rows === 'file.open|shortcuts.open;file.save|shortcuts.save;' +
      'settings.open|shortcuts.settings;' +
      'capture.toggle|toolbar.start,toolbar.stop;view.fit|toolbar.fit;' +
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
    shortcuts.includes("      case 'view.zoomIn':\n        this.keyZoom(1);\n        return true;") &&
    shortcuts.includes("      case 'view.zoomOut':\n        this.keyZoom(-1);\n        return true;") &&
    shortcuts.includes("      case 'view.panLeft':\n        this.keyPan(-1, shiftKey);\n        return true;") &&
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
    '      case \'view.zoomIn\':\n        this.keyZoom(1);\n        return true;',
    '      case \'view.zoomIn\':\n        if (ctrlKey) return false;\n        this.keyZoom(1);\n        return true;');
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
  ['shortcuts.group.file', ['File', '文件', 'Файл', 'Fichier']],
  ['shortcuts.group.view', ['View', '视图', 'Вид', 'Affichage']],
  ['shortcuts.group.navigation', ['Navigation', '导航', 'Навигация', 'Navigation']],
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
  check('all four catalogs carry the reference keys with their pinned values',
    drift.length === 0 && SHORTCUT_KEY_VALUES.every(([key]) => en[key] !== undefined),
    drift.length === 0 ? `${CATALOGS.length} catalogs x ${SHORTCUT_KEY_VALUES.length} keys match`
      : drift.join('; '));
}

{
  const texts = SHORTCUTS.map((entry) => shortcutActionText(entry));
  const capture = SHORTCUTS.find((entry) => entry.id === 'capture.toggle')!;
  check('the reference action text joins the labeled catalog keys with the two-label separator',
    texts.join(' | ') === 'Open… | Save… | Settings | Capture / Stop | Fit | Clear cursors | ' +
      'Zoom in | Zoom out | Pan left (earlier) | Pan right (later)' &&
    capture.labels.length === 2 && t('toolbar.start') === 'Capture',
    `texts=${texts.join(' | ')}`);
}

{
  const capture = SHORTCUTS.find((entry) => entry.id === 'capture.toggle')!;
  const swapped: ShortcutEntry = { ...capture, labels: ['toolbar.stop', 'toolbar.start'] };
  check('control: a swapped label pair does not reproduce the pinned action text',
    shortcutActionText(swapped) === 'Stop / Capture' &&
    shortcutActionText(swapped) !== shortcutActionText(capture),
    `swapped=${shortcutActionText(swapped)}, real=${shortcutActionText(capture)}`);
}

function methodBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const end = source.indexOf('\n  }', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

const REFERENCE_NEEDLES: readonly string[] = [
  "      case 'shortcuts':\n        return this.shortcutBlocks();",
  'for (const group of referenceGroups()) {',
  'this.groupTitle(shortcutGroupLabel(group))',
  'this.shortcutList(shortcutsIn(group).map((entry) => this.keyRow(',
  'shortcutActionText(entry),',
  "entry.chords.map((chord) => formatChord(chord)).join(' / '),",
  '`shortcut:${entry.id}`',
  "this.groupTitle(t('shortcuts.mouse'))",
  'referenceGestures(this.host.wheelZooms())',
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
    'this.shortcutList(shortcutsIn(group).map((entry) => this.keyRow(',
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
