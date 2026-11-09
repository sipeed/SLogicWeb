import { SHORTCUTS, referenceGestures, shortcutIdFor, type ShortcutEntry, type ShortcutId } from '../shortcuts.js';
import { gestureNotation, shortcutActionText } from '../shortcutsDialog.js';
import { t, type MessageKey } from '../i18n.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';

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
  const typeImport = "import type { MessageKey } from './i18n.js';";
  const bodySource = source.replace(typeImport, '');
  check('the catalogue touches no DOM or browser state and carries no comments',
    hits.length === 0 && source.startsWith(typeImport) &&
    bodySource.trimStart().startsWith('export type ShortcutId'),
    `hits=${JSON.stringify(hits)}, typeOnlyImport=${source.startsWith(typeImport)}`);
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
    off.startsWith('shortcuts.input.wheel=shortcuts.scrollRowsOrZoom;Ctrl+shortcuts.input.wheel=shortcuts.zoomTime;') &&
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
  ['settings.shortcuts', ['Shortcuts and gestures', '快捷键与鼠标操作', 'Клавиши и жесты', 'Raccourcis et gestes']],
  ['shortcuts.title', ['Shortcuts and gestures', '快捷键与鼠标操作', 'Клавиши и жесты', 'Raccourcis et gestes']],
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
  check('all four catalogs carry the four reference keys with their pinned values',
    drift.length === 0 && SHORTCUT_KEY_VALUES.every(([key]) => en[key] !== undefined),
    drift.length === 0 ? `${CATALOGS.length} catalogs x ${SHORTCUT_KEY_VALUES.length} keys match`
      : drift.join('; '));
}

{
  const texts = SHORTCUTS.map((entry) => shortcutActionText(entry));
  check('the dialog action text joins the labeled catalog keys with the two-label separator',
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

const DIALOG_NEEDLES: readonly string[] = [
  "document.createElement('dialog')",
  "'shortcuts-dialog'",
  "'aria-labelledby'",
  "'shortcuts-title'",
  'showModal()',
  "addEventListener('cancel'",
  'event.target !== this.dialog',
  'preventDefault()',
  'focus({ preventScroll: true })',
  'this.invoker',
  "t('shortcuts.title')",
  "t('shortcuts.close')",
  'shortcutActionText(entry)',
  "createElement('kbd')",
  "createElement('li')",
];

const DIALOG_FORBIDDEN: readonly string[] = [
  'document.addEventListener',
  'window.addEventListener',
  'innerHTML',
];

function missingDialogNeedles(source: string): string[] {
  return DIALOG_NEEDLES.filter((needle) => !source.includes(needle));
}

function forbiddenDialogTokens(source: string): string[] {
  return DIALOG_FORBIDDEN.filter((needle) => source.includes(needle));
}

{
  const source = fs.readFileSync('src/ui/shortcutsDialog.ts', 'utf8');
  const missing = missingDialogNeedles(source);
  const forbidden = forbiddenDialogTokens(source);
  const comments = ['//', '/*'].filter((token) => source.includes(token));
  check('the dialog is one persistent native modal with its listeners bound in the constructor',
    missing.length === 0 && forbidden.length === 0 && comments.length === 0,
    `missing=${JSON.stringify(missing)}, forbidden=${JSON.stringify(forbidden)}, ` +
    `comments=${JSON.stringify(comments)}`);
}

{
  const source = fs.readFileSync('src/ui/shortcutsDialog.ts', 'utf8');
  const mutated = `${source}\ndocument.addEventListener('keydown', () => {});\n`;
  check('control: a document-level listener is detected by the same negative predicate',
    mutated !== source && forbiddenDialogTokens(mutated).length === 1 &&
    forbiddenDialogTokens(source).length === 0,
    `mutated=${forbiddenDialogTokens(mutated).length}, real=${forbiddenDialogTokens(source).length}`);
}

{
  const source = fs.readFileSync('src/ui/shortcutsDialog.ts', 'utf8');
  const mutated = source.replace('showModal()', 'show()');
  check('control: dropping showModal() is detected by the same needle predicate',
    mutated !== source && missingDialogNeedles(mutated).includes('showModal()') &&
    missingDialogNeedles(source).length === 0,
    `mutatedMissing=${missingDialogNeedles(mutated).length}, realMissing=${missingDialogNeedles(source).length}`);
}

function methodBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const end = source.indexOf('\n  }', start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

function dialogConstructions(source: string): number {
  return source.match(/new ShortcutsDialog\(/g)?.length ?? 0;
}

{
  check('App constructs exactly one reference dialog and keeps it in one field',
    dialogConstructions(appSource) === 1 &&
    appSource.includes('private readonly shortcutsDialog: ShortcutsDialog;') &&
    methodBody(appSource, 'constructor() {').includes('this.shortcutsDialog = new ShortcutsDialog();'),
    `constructions=${dialogConstructions(appSource)}, ` +
    `field=${appSource.includes('private readonly shortcutsDialog: ShortcutsDialog;')}`);
}

{
  const mutated = `${appSource}\nconst extra = new ShortcutsDialog();\n`;
  check('control: a second construction is detected by the same count predicate',
    mutated !== appSource && dialogConstructions(mutated) === 2 && dialogConstructions(appSource) === 1,
    `mutated=${dialogConstructions(mutated)}, real=${dialogConstructions(appSource)}`);
}

{
  const settingsDialogSource = fs.readFileSync('src/ui/settingsDialog.ts', 'utf8');
  const pane = methodBody(settingsDialogSource, 'private paneContent(section: SettingsSectionId): HTMLElement[] {');
  const paneLists = pane.includes('this.labelsRow()') && pane.includes('this.shortcutsRow()');
  const displayToggleCheck = (source: string): boolean => {
    const body = methodBody(source, 'private labelsRow(): HTMLDivElement {');
    return body.includes(
      "this.toggleRow('detailed-labels', 'settings.detailedLabels', this.host.detailedLabels(),") &&
      body.includes('(on) => this.host.setDetailedLabels(on)');
  };
  const shortcutsCheck = (source: string): boolean => {
    const body = methodBody(source, 'private shortcutsRow(): HTMLButtonElement {');
    return body.includes("this.rowLabel('settings.shortcuts')") &&
      body.includes("hint.textContent = '▸';") &&
      body.includes('this.host.openShortcuts(row)');
  };
  check('the settings window keeps the display toggle and hands the shortcuts row to the dialog through the host',
    displayToggleCheck(settingsDialogSource) && shortcutsCheck(settingsDialogSource) && paneLists,
    `displayToggle=${displayToggleCheck(settingsDialogSource)}, ` +
    `shortcutsEntry=${shortcutsCheck(settingsDialogSource)}, paneLists=${paneLists}`);
  const inlined = settingsDialogSource.replace(
    '      (on) => this.host.setDetailedLabels(on));',
    '      () => {});');
  const strayHandOff = settingsDialogSource.replace(
    '    row.addEventListener(\'click\', () => this.host.openShortcuts(row));',
    '    row.addEventListener(\'click\', () => this.host.openShortcuts(this.closeButton));');
  check('control: an inlined display toggle without its host write or a shortcuts row handing off another element fails the same needles',
    inlined !== settingsDialogSource && !displayToggleCheck(inlined) &&
    displayToggleCheck(settingsDialogSource) &&
    strayHandOff !== settingsDialogSource && !shortcutsCheck(strayHandOff) &&
    shortcutsCheck(settingsDialogSource),
    `inlined=${displayToggleCheck(inlined)}, strayHandOff=${shortcutsCheck(strayHandOff)}, ` +
    `real=${displayToggleCheck(settingsDialogSource)}/${shortcutsCheck(settingsDialogSource)}`);
}

function openShortcutsBridge(source: string): string {
  const start = source.indexOf('openShortcuts: (invoker) => {');
  const end = start >= 0 ? source.indexOf('\n      },', start) : -1;
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function openShortcutsCarriesWheelZooms(source: string): boolean {
  const body = openShortcutsBridge(source);
  return body.includes('this.shortcutsDialog.open(invoker, this.wheelZooms);') &&
    !body.includes('this.shortcutsDialog.open(invoker);');
}

{
  const bridge = openShortcutsBridge(appSource);
  const openAt = bridge.indexOf('this.shortcutsDialog.open(invoker, this.wheelZooms);');
  const closeAt = bridge.indexOf('this.channelList.closeDialog();');
  check('the settings window opens the reference dialog with the current wheel-zoom state',
    openShortcutsCarriesWheelZooms(appSource) && closeAt >= 0 && openAt > closeAt,
    `body=${JSON.stringify(bridge.replace(/\s+/g, ' '))}`);
}

{
  const mutated = appSource.replace(
    'this.shortcutsDialog.open(invoker, this.wheelZooms);',
    'this.shortcutsDialog.open(invoker);');
  check('control: dropping the wheel-zoom argument is detected by the same predicate',
    mutated !== appSource && !openShortcutsCarriesWheelZooms(mutated) &&
    openShortcutsCarriesWheelZooms(appSource),
    `mutated=${openShortcutsCarriesWheelZooms(mutated)}, real=${openShortcutsCarriesWheelZooms(appSource)}`);
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
  const guard = 'if (this.shortcutsDialog.isOpen) this.shortcutsDialog.renderStrings(this.wheelZooms);';
  const renderBody = methodBody(appSource, 'private renderPanels(');
  check('retranslate refreshes the reference strings only while the dialog is open',
    body.includes(guard) && !body.includes('this.shortcutsDialog.open(') &&
    renderBody.length > 0 && !renderBody.includes('shortcutsDialog'),
    `guard=${body.includes(guard)}, retranslate=${body.length}, renderPanels=${renderBody.length}`);
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
