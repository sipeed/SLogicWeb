import {
  SHORTCUTS, SHORTCUT_GROUPS, WORK_ANYWHERE, actionOf, gestureNotation, referenceGestures,
  referenceGroups, shortcutActionText, shortcutGroupLabel, shortcutsIn,
  type ShortcutEntry, type ShortcutGroup, type ShortcutId,
} from '../shortcuts.js';
import { formatChord } from '../chords.js';
import { THEME_MODES } from '../theme.js';
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
  '        if (this.runShortcut(id)) e.preventDefault();\n' +
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
    'if (this.runShortcut(id)) e.preventDefault();');
  return listener.length > 0 && anywhere >= 0 && inputGuard > anywhere &&
    dialogGuard > anywhere && dispatch > dialogGuard &&
    listener.indexOf('const id = actionOf(chord)') < anywhere;
}

const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const body = keydownBody(appSource);

{
  const rows = SHORTCUTS.map((entry) =>
    `${entry.id}|${entry.group}|${entry.chords.join(',')}`).join(';');
  check('the catalogue is exactly eighteen rows in dispatch order with pinned groups and chords',
    SHORTCUTS.length === 18 &&
    rows === 'file.open|file|Mod+O;file.save|file|Mod+S;settings.open|file|Mod+,;' +
      'capture.toggle|view|Space;view.fit|view|F,Home;cursors.clear|view|Escape;' +
      'view.zoomIn|view|+,=;view.zoomOut|view|-,_;view.panLeft|view|ArrowLeft;' +
      'view.panRight|view|ArrowRight;view.panLeftPage|view|Shift+ArrowLeft;' +
      'view.panRightPage|view|Shift+ArrowRight;theme.next|view|T;sidebar.capture|navigation|1;' +
      'sidebar.cursors|navigation|2;sidebar.decoders|navigation|3;sidebar.toggle|navigation|\\;' +
      'decoders.add|navigation|D' &&
    shortcutsIn('view').length === 10 && shortcutsIn('file').length === 3 &&
    shortcutsIn('navigation').length === 5,
    `rows=${rows}`);
}

{
  const shown = SHORTCUTS.map((entry) =>
    entry.chords.map((chord) => formatChord(chord, false)).join(' / ')).join('|');
  check('every reference row prints its chords through formatChord, aliases included',
    shown === 'Ctrl+O|Ctrl+S|Ctrl+,|Space|F / Home|Esc|+ / =|- / _|←|→|Shift+←|Shift+→|T|' +
      '1|2|3|\\|D',
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
    mutated !== single &&
    single === '⌘O|⌘S|⌘,|Space|F / Home|Esc|+ / =|- / _|←|→|⇧←|⇧→|T|1|2|3|\\|D' &&
    mutated === '⌘O|⌘S|⌘,|Space|Home / F|Esc|= / +|_ / -|←|→|⇧←|⇧→|T|1|2|3|\\|D',
    `real=${single}, mutated=${mutated}`);
}

{
  const mapped: Array<[string, ShortcutId | null]> = [
    ['Mod+O', actionOf('Mod+O')],
    ['Mod+S', actionOf('Mod+S')],
    ['Mod+,', actionOf('Mod+,')],
    ['Space', actionOf('Space')],
    ['F', actionOf('F')],
    ['Home', actionOf('Home')],
    ['Escape', actionOf('Escape')],
    ['+', actionOf('+')],
    ['=', actionOf('=')],
    ['-', actionOf('-')],
    ['_', actionOf('_')],
    ['ArrowLeft', actionOf('ArrowLeft')],
    ['ArrowRight', actionOf('ArrowRight')],
    ['Shift+ArrowLeft', actionOf('Shift+ArrowLeft')],
    ['Shift+ArrowRight', actionOf('Shift+ArrowRight')],
    ['T', actionOf('T')],
    ['1', actionOf('1')],
    ['2', actionOf('2')],
    ['3', actionOf('3')],
    ['\\', actionOf('\\')],
    ['D', actionOf('D')],
  ];
  const want = ['file.open', 'file.save', 'settings.open', 'capture.toggle', 'view.fit',
    'view.fit', 'cursors.clear', 'view.zoomIn', 'view.zoomIn', 'view.zoomOut', 'view.zoomOut',
    'view.panLeft', 'view.panRight', 'view.panLeftPage', 'view.panRightPage', 'theme.next',
    'sidebar.capture', 'sidebar.cursors', 'sidebar.decoders', 'sidebar.toggle', 'decoders.add'];
  check('actionOf maps every live chord and alias to its id',
    mapped.every(([, id], index) => id === want[index]),
    `mapped=${mapped.map(([key, id]) => `${JSON.stringify(key)}:${String(id)}`).join(',')}`);
}

{
  const misses = ['', 'F ', 'Enter', 'Return', 'f ', 'ArrowUp', 'ArrowDown', 'Add',
    'Shift+F', 'Shift+D', 'Shift+T', 'Shift+1', 'Mod++', 'Mod+=', 'Mod+Space', 'Mod+F',
    'Alt+Escape'];
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
    ['runShortcut(id)', body.includes('this.runShortcut(id)')],
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
      'view.zoomOut|shortcuts.zoomOut;view.panLeft|shortcuts.panLeft;view.panRight|shortcuts.panRight;' +
      'view.panLeftPage|shortcuts.panPage;view.panRightPage|shortcuts.panPage;' +
      'theme.next|shortcuts.theme;' +
      'sidebar.capture|shortcuts.sidebarCapture;sidebar.cursors|shortcuts.sidebarCursors;' +
      'sidebar.decoders|shortcuts.sidebarDecoders;sidebar.toggle|shortcuts.sidebarToggle;' +
      'decoders.add|shortcuts.addDecoder',
    `rows=${rows}`);
}

type GestureRow = ReturnType<typeof referenceGestures>[number];

const GESTURE_TAIL = 'Shift+shortcuts.input.wheel=shortcuts.panTime;' +
  'shortcuts.input.drag=shortcuts.panTime;shortcuts.input.doubleClick=shortcuts.addCursor;' +
  'shortcuts.input.pinch=shortcuts.zoomTime';

const describeGestures = (rows: readonly GestureRow[]): string => rows
  .map((entry) => `${entry.modifiers.join('+')}${entry.modifiers.length > 0 ? '+' : ''}${entry.input}=` +
    entry.labels.join(','))
  .join(';');

function gestureReferenceMatches(
  off: readonly GestureRow[], on: readonly GestureRow[],
): boolean {
  return describeGestures(off) ===
    `shortcuts.input.wheel=shortcuts.scrollRows;Ctrl+shortcuts.input.wheel=shortcuts.zoomTime;${GESTURE_TAIL}` &&
    describeGestures(on) ===
    `shortcuts.input.wheel=shortcuts.zoomTime;Ctrl+shortcuts.input.wheel=shortcuts.zoomTime;${GESTURE_TAIL}`;
}

{
  // The mouse half of the reference follows the "wheel zooms" setting the same way the
  // wheel handlers do, and every row names catalog keys present in all four locales.
  const off = referenceGestures(false);
  const on = referenceGestures(true);
  const retiredSwap: readonly GestureRow[] = on.map((entry, index) => (index === 1
    ? { ...entry, labels: ['shortcuts.scrollRows'] }
    : entry));
  const keys = [...off, ...on].flatMap((entry) => [entry.input, ...entry.labels]);
  const missing = keys.filter((key) => [en, zhCN, ru, fr].some((dict) => !dict[key]));
  check('the mouse reference keeps Ctrl+wheel on zoom when wheel zoom is on, so both forms zoom',
    gestureReferenceMatches(off, on) && !gestureReferenceMatches(off, retiredSwap) &&
    gestureNotation(off[1]!) === 'Ctrl + Wheel' && missing.length === 0,
    `off=${describeGestures(off)}; on=${describeGestures(on)}; ` +
    `retired=${gestureReferenceMatches(off, retiredSwap)}; missing=${missing.join(',')}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const listener = body;
  check('the zoom and pan keys dispatch to keyZoom/keyPan with a fixed span and never see a modifier flag',
    shortcuts.includes("      case 'view.zoomIn':\n        this.keyZoom(1);\n        return true;") &&
    shortcuts.includes("      case 'view.zoomOut':\n        this.keyZoom(-1);\n        return true;") &&
    shortcuts.includes("      case 'view.panLeft':\n        this.keyPan(-1, false);\n        return true;") &&
    shortcuts.includes("      case 'view.panRight':\n        this.keyPan(1, false);\n        return true;") &&
    shortcuts.includes("      case 'view.panLeftPage':\n        this.keyPan(-1, true);\n        return true;") &&
    shortcuts.includes("      case 'view.panRightPage':\n        this.keyPan(1, true);\n        return true;") &&
    !shortcuts.includes('shiftKey') &&
    !shortcuts.includes('ctrlKey') && !shortcuts.includes('metaKey') &&
    !shortcuts.includes('altKey') &&
    !listener.includes('shiftKey') &&
    !listener.includes('ctrlKey') && !listener.includes('metaKey') &&
    !listener.includes('altKey') &&
    appSource.includes('this.stack.zoomAt(this.stack.widthDevicePx / 2, direction > 0 ? Math.SQRT1_2 : Math.SQRT2);') &&
    appSource.includes('this.stack.panPixels(direction * this.stack.widthDevicePx * (big ? 0.5 : 0.1));'),
    `shortcuts=${shortcuts.length}, listener=${listener.length}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const swapped = shortcuts.replace(
    "      case 'view.panLeftPage':\n        this.keyPan(-1, true);\n        return true;",
    "      case 'view.panLeftPage':\n        this.keyPan(-1, false);\n        return true;");
  const pagePans = (source: string): boolean =>
    source.includes("      case 'view.panLeftPage':\n        this.keyPan(-1, true);\n        return true;") &&
    source.includes("      case 'view.panRightPage':\n        this.keyPan(1, true);\n        return true;") &&
    source.includes("      case 'view.panLeft':\n        this.keyPan(-1, false);\n        return true;");
  check('control: a page pan sharing the one-arrow span fails the same predicate',
    swapped !== shortcuts && !pagePans(swapped) && pagePans(shortcuts),
    `swapped=${pagePans(swapped)}, real=${pagePans(shortcuts)}`);
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
  const fallbackLine = "const unshifted = chord.startsWith('Shift+') ? " +
    "chord.slice('Shift+'.length) : '';";
  const guard = '(/^[A-Z0-9]$/.test(unshifted) ? null : actionOf(unshifted))';
  const modifierFree = (source: string): boolean =>
    source.length > 0 && !source.includes('unshifted') && !source.includes(guard) &&
    source.includes('const id = actionOf(chord);');
  const reinstated = body.replace(
    'const id = actionOf(chord);',
    `${fallbackLine}\n      const id = actionOf(chord) ?? ${guard};`);
  check('a shifted letter, digit or named key resolves nothing and no unmodified chord is retried behind it',
    modifierFree(body) && reinstated !== body && !modifierFree(reinstated) &&
    actionOf('Shift+F') === null && actionOf('Shift+D') === null &&
    actionOf('Shift+T') === null && actionOf('Shift+1') === null &&
    actionOf('Shift+Escape') === null && actionOf('Shift+ArrowLeft') === 'view.panLeftPage' &&
    actionOf('Shift+ArrowRight') === 'view.panRightPage' &&
    actionOf('F') === 'view.fit' && actionOf('ArrowLeft') === 'view.panLeft',
    `real=${modifierFree(body)}, reinstated=${!modifierFree(reinstated)}, ` +
    `pageLeft=${String(actionOf('Shift+ArrowLeft'))}, shifted=${String(actionOf('Shift+F'))}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const page = (id: string, target: string): string =>
    `      case '${id}':\n        this.applySidebar(selectSidebarPage(this.sidebar, '${target}'));\n` +
    '        return true;\n';
  const mapping = ['capture', 'cursors', 'decoders']
    .map((target) => page(`sidebar.${target}`, target)).join('');
  check('each page chord applies the one sidebar side effect the tab strip uses',
    shortcuts.includes(mapping) &&
    shortcuts.includes("      case 'sidebar.toggle':\n" +
      '        if (this.sidebar.visible) this.handleCollapse();\n        else this.handleExpand();\n'),
    `mapping=${mapping.length}, body=${shortcuts.length}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const branch = branchBody(shortcuts, 'decoders.add');
  const mountsBeforeFocus = (text: string): boolean => {
    const page = text.indexOf("this.selectPage('decoders');");
    const picker = text.indexOf('this.openAddDecoder();');
    return page >= 0 && picker > page;
  };
  check('the decoder chord mounts the Decoders page before the picker asks for focus',
    mountsBeforeFocus(branch) &&
    branch.includes("        this.selectPage('decoders');\n        this.openAddDecoder();\n") &&
    actionOf('D') === 'decoders.add',
    `branch=${branch.length}, action=${String(actionOf('D'))}`);
  const reversed = branch.replace(
    "        this.selectPage('decoders');\n        this.openAddDecoder();\n",
    "        this.openAddDecoder();\n        this.selectPage('decoders');\n");
  check('control: focusing the picker before the page is mounted fails the same predicate',
    reversed !== branch && !mountsBeforeFocus(reversed) && mountsBeforeFocus(branch),
    `reversed=${mountsBeforeFocus(reversed)}, real=${mountsBeforeFocus(branch)}`);
}

{
  const fit = SHORTCUTS.find((entry) => entry.id === 'view.fit')!;
  const owners = SHORTCUTS.filter((entry) => entry.chords.includes('Home')).map((entry) => entry.id);
  check('the fit action answers both F and Home, and Home is claimed by nothing else',
    fit.chords.join(',') === 'F,Home' && owners.join(',') === 'view.fit' &&
    actionOf('Home') === 'view.fit' && actionOf('F') === 'view.fit',
    `chords=${fit.chords.join(',')}, owners=${owners.join(',')}`);
  const withoutHome: ShortcutEntry = { ...fit, chords: ['F'] };
  check('control: dropping the Home alias fails the same predicate',
    !SHORTCUTS.map((entry) => (entry.id === 'view.fit' ? withoutHome : entry))
      .some((entry) => entry.chords.includes('Home')) &&
    withoutHome.chords.join(',') !== fit.chords.join(','),
    `real=${fit.chords.join(',')}, without=${withoutHome.chords.join(',')}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const nextMode = (mode: string): string =>
    THEME_MODES[(THEME_MODES.indexOf(mode as (typeof THEME_MODES)[number]) + 1) %
      THEME_MODES.length]!;
  const cycle = THEME_MODES.map(nextMode).join(',');
  const followed = (order: readonly string[], source: string): boolean =>
    source.includes("      case 'theme.next': {\n" +
      '        const index = THEME_MODES.indexOf(getMode());\n' +
      '        setMode(THEME_MODES[(index + 1) % THEME_MODES.length]!);\n' +
      '        return true;\n      }') &&
    order.join(',') === 'light,dark,system';
  check('the theme chord advances one step through THEME_MODES and wraps to the first',
    followed(THEME_MODES, shortcuts) && cycle === 'dark,system,light' &&
    actionOf('T') === 'theme.next' &&
    appSource.includes("import { getMode, getTheme, onThemeChange, setMode, THEME_MODES,"),
    `order=${THEME_MODES.join(',')}, cycle=${cycle}`);
  const hardCoded = shortcuts.replace(
    'setMode(THEME_MODES[(index + 1) % THEME_MODES.length]!);',
    "setMode(THEME_MODES[index] === 'light' ? 'system' : 'dark');");
  check('control: a hand-written theme order fails the same predicate',
    hardCoded !== shortcuts && !followed(THEME_MODES, hardCoded) &&
    followed(THEME_MODES, shortcuts),
    `hardCoded=${followed(THEME_MODES, hardCoded)}, real=${followed(THEME_MODES, shortcuts)}`);
}

{
  const shortcuts = runShortcutBody(appSource);
  const directWrite = shortcuts.replace(
    "        this.applySidebar(selectSidebarPage(this.sidebar, 'capture'));\n",
    "        this.sidebar = { visible: true, page: 'capture', assistant: false };\n        this.renderPanels();\n");
  const noFocus = shortcuts.replace(
    '        if (this.sidebar.visible) this.handleCollapse();\n        else this.handleExpand();\n',
    '        this.applySidebar(toggleSidebarVisible(this.sidebar));\n');
  check('control: a hand-written sidebar transition or a focus-free toggle fails the same predicate',
    directWrite !== shortcuts && noFocus !== shortcuts &&
    !directWrite.includes("selectSidebarPage(this.sidebar, 'capture')") &&
    directWrite.includes("this.sidebar = { visible: true") &&
    !noFocus.includes('this.handleCollapse()') && shortcuts.includes('this.handleCollapse()'),
    `direct=${directWrite !== shortcuts}, noFocus=${noFocus !== shortcuts}`);
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
  ['settings.wheelZooms', ['Wheel zooms', '滚轮直接缩放', 'Колесо масштабирует', 'La molette zoome']],
  ['shortcuts.close', ['Close', '关闭', 'Закрыть', 'Fermer']],
  ['shortcuts.clearCursors', ['Clear cursors', '清除光标', 'Сбросить курсоры', 'Effacer les curseurs']],
  ['shortcuts.addDecoder', ['Add a protocol decoder', '添加解码器',
    'Добавить декодер протокола', 'Ajouter un décodeur de protocole']],
  ['shortcuts.theme', ['Switch theme', '切换主题', 'Сменить тему', 'Changer de thème']],
  ['shortcuts.sidebarCapture', ['Capture panel', '采集面板', 'Панель захвата', 'Panneau Capture']],
  ['shortcuts.sidebarCursors', ['Cursors panel', '光标面板', 'Панель курсоров', 'Panneau Curseurs']],
  ['shortcuts.sidebarDecoders', ['Decoders panel', '解码器面板', 'Панель декодеров',
    'Panneau Décodeurs']],
  ['shortcuts.sidebarToggle', ['Show or hide the sidebar', '显示或隐藏侧栏',
    'Показать или скрыть боковую панель', 'Afficher ou masquer la barre latérale']],
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
      'Zoom in | Zoom out | Pan left (earlier) | Pan right (later) | Pan by half a screen | ' +
      'Pan by half a screen | Switch theme | Capture panel | Cursors panel | Decoders panel | ' +
      'Show or hide the sidebar | Add a protocol decoder' &&
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
    '      setDeveloperTools: (on) => this.setDeveloperTools(on),',
    '      setDeveloperTools: (on) => this.setDeveloperTools(on),\n      openShortcuts: (invoker) => this.shortcutsDialog.open(invoker),');
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
