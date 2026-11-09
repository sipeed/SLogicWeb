import {
  SHORTCUTS, gestureNotation, referenceGestures, shortcutActionText, shortcutIdFor,
  type ShortcutEntry, type ShortcutId,
} from '../shortcuts.js';
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

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

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

function entriesAreUnique(rows: readonly { id: string; key: string }[]): boolean {
  return new Set(rows.map((row) => row.id)).size === rows.length &&
    new Set(rows.map((row) => row.key)).size === rows.length;
}

const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const body = keydownBody(appSource);

{
  const rows = SHORTCUTS.map((entry) => `${entry.id}|${entry.key}|${entry.notation}`).join(',');
  check('the catalogue is exactly seven rows in dispatch order with pinned keys and notation',
    SHORTCUTS.length === 7 &&
    rows === "capture.toggle| |Space,view.fit|f|F,cursors.clear|Escape|Esc," +
      'view.zoomIn|+|+ / =,view.zoomOut|-|-,view.panLeft|ArrowLeft|←,view.panRight|ArrowRight|→',
    `rows=${rows}`);
}

{
  const ids = SHORTCUTS.map((entry) => entry.id);
  const keys = SHORTCUTS.map((entry) => entry.key);
  check('ids and KeyboardEvent.key values are both unique',
    entriesAreUnique(SHORTCUTS) && SHORTCUTS.length === 7 &&
    new Set(SHORTCUTS.flatMap((entry) => [entry.key, ...(entry.aliases ?? [])])).size ===
      SHORTCUTS.reduce((n, entry) => n + 1 + (entry.aliases?.length ?? 0), 0),
    `ids=${ids.join(',')}, keys=${JSON.stringify(keys)}`);
}

{
  const duplicatedKey = SHORTCUTS.map((entry, index) =>
    index === 1 ? { ...entry, key: SHORTCUTS[0]!.key } : { ...entry });
  const duplicatedId = SHORTCUTS.map((entry, index) =>
    index === 1 ? { ...entry, id: SHORTCUTS[0]!.id } : { ...entry });
  check('control: a duplicated key or id fails the same uniqueness predicate',
    entriesAreUnique(SHORTCUTS) && !entriesAreUnique(duplicatedKey) &&
    !entriesAreUnique(duplicatedId) &&
    duplicatedKey[1]!.key === duplicatedKey[0]!.key &&
    duplicatedKey[1]!.id !== duplicatedKey[0]!.id &&
    duplicatedId[1]!.id === duplicatedId[0]!.id,
    `real=${entriesAreUnique(SHORTCUTS)}, dupKey=${entriesAreUnique(duplicatedKey)}, ` +
    `dupId=${entriesAreUnique(duplicatedId)}, ` +
    `keys=${JSON.stringify(duplicatedKey.map((entry) => entry.key))}`);
}

{
  const mapped: Array<[string, ShortcutId | null]> = [
    [' ', shortcutIdFor(' ')],
    ['f', shortcutIdFor('f')],
    ['Escape', shortcutIdFor('Escape')],
    ['+', shortcutIdFor('+')],
    ['=', shortcutIdFor('=')],
    ['-', shortcutIdFor('-')],
    ['_', shortcutIdFor('_')],
    ['ArrowLeft', shortcutIdFor('ArrowLeft')],
    ['ArrowRight', shortcutIdFor('ArrowRight')],
  ];
  const want = ['capture.toggle', 'view.fit', 'cursors.clear', 'view.zoomIn', 'view.zoomIn',
    'view.zoomOut', 'view.zoomOut', 'view.panLeft', 'view.panRight'];
  check('shortcutIdFor maps every live key and alias to its id',
    mapped.every(([, id], index) => id === want[index]),
    `mapped=${mapped.map(([key, id]) => `${JSON.stringify(key)}:${String(id)}`).join(',')}`);
}

{
  const misses = ['', 'F', 'Enter', 'Return', 'f ', 'ArrowUp', 'ArrowDown', 'Add'];
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
  const imports = [...source.matchAll(/^import .*$/gm)].map((match) => match[0]);
  const bodySource = source.replace(/^import .*$/gm, '');
  check('the catalogue imports only the message catalog and touches no DOM or browser state',
    hits.length === 0 && imports.length === 2 &&
    imports.every((line) => line.endsWith("from './i18n.js';")) &&
    bodySource.trimStart().startsWith('export type ShortcutId'),
    `hits=${JSON.stringify(hits)}, imports=${JSON.stringify(imports)}`);
}

{
  const source = fs.readFileSync('src/ui/shortcuts.ts', 'utf8');
  const mutated = source.replace(
    "import { t } from './i18n.js';",
    "import { t } from './i18n.js';\nimport { zoomToFit } from './view.js';");
  const imports = (text: string): string[] => [...text.matchAll(/^import .*$/gm)].map((match) => match[0]);
  check('control: a third import from another module is detected by the same predicate',
    mutated !== source && imports(mutated).length === 3 &&
    !imports(mutated).every((line) => line.endsWith("from './i18n.js';")) &&
    imports(source).every((line) => line.endsWith("from './i18n.js';")),
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
  // The new view keys share the Space/F/Esc guard, leave Ctrl/Cmd/Alt chords to the
  // browser (Ctrl+= / Ctrl+- are page zoom), and step from the view centre.
  const branch = between(appSource, "} else if (shortcut !== null && !e.ctrlKey && !e.metaKey && !e.altKey) {", '\n      }');
  check('the zoom and pan keys skip modifier chords and dispatch to keyZoom/keyPan',
    branch.includes('e.preventDefault();') &&
    branch.includes("if (shortcut === 'view.zoomIn') this.keyZoom(1);") &&
    branch.includes("else if (shortcut === 'view.zoomOut') this.keyZoom(-1);") &&
    branch.includes("else if (shortcut === 'view.panLeft') this.keyPan(-1, e.shiftKey);") &&
    branch.includes('else this.keyPan(1, e.shiftKey);') &&
    appSource.includes('this.stack.zoomAt(this.stack.widthDevicePx / 2, direction > 0 ? Math.SQRT1_2 : Math.SQRT2);') &&
    appSource.includes('this.stack.panPixels(direction * this.stack.widthDevicePx * (big ? 0.5 : 0.1));'),
    `branch=${branch.length}`);
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
  'shortcutActionText(entry), entry.notation, `shortcut:${entry.id}`',
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
