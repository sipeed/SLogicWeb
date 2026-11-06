import { SETTINGS_DIALOG_HEIGHT, SETTINGS_DIALOG_ID, SETTINGS_DIALOG_WIDTH, SETTINGS_NAV_WIDTH } from '../settingsDialog.js';
import type { MessageKey } from '../i18n.js';
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

const dialogSource = fs.readFileSync('src/ui/settingsDialog.ts', 'utf8');
const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');

const DIALOG_NEEDLES: readonly string[] = [
  "document.createElement('dialog')",
  'this.dialog.id = SETTINGS_DIALOG_ID;',
  "'settings-dialog'",
  "this.dialog.setAttribute('aria-labelledby', 'settings-dialog-title')",
  'showModal()',
  "addEventListener('cancel'",
  'event.target !== this.dialog',
  'preventDefault()',
  'this.invoker = invoker;',
  'if (invoker?.isConnected) invoker.focus();',
  '[data-settings-key]',
  "focus({ preventScroll: true })",
  'this.body.replaceChildren(',
  "'settings-item'",
  "t('settings.detailedLabels')",
  "t('settings.shortcuts')",
  "this.closeButton.setAttribute('aria-label', t('settings.close'));",
  'this.host.setDetailedLabels(',
  'this.host.openShortcuts(row)',
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

function commentsIn(source: string): string[] {
  const stripped = source.replace("const SVG_NS = 'http://www.w3.org/2000/svg';", '');
  return ['//', '/*'].filter((token) => stripped.includes(token));
}

function rendersBeforeModal(source: string): boolean {
  const renderAt = source.indexOf('this.renderStrings();\n    this.dialog.showModal();');
  return renderAt >= 0 && source.indexOf('this.dialog.showModal();') > renderAt;
}

function backdropGuard(source: string): boolean {
  const start = source.indexOf("this.dialog.addEventListener('pointerdown'");
  const end = start >= 0 ? source.indexOf('\n    });', start) : -1;
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  return body.includes('if (event.target !== this.dialog) return;') &&
    body.indexOf('if (event.target !== this.dialog) return;') < body.indexOf('this.close();') &&
    body.includes('event.preventDefault();');
}

function focusRestoreByKey(source: string): boolean {
  const start = source.indexOf('  renderStrings(): void {');
  const end = start >= 0 ? source.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  return body.includes("active.closest<HTMLElement>('[data-settings-key]')") &&
    body.includes('?.dataset.settingsKey') &&
    body.indexOf('this.body.replaceChildren(') < body.indexOf('this.focusRow(restore)');
}

{
  const missing = missingDialogNeedles(dialogSource);
  const forbidden = forbiddenDialogTokens(dialogSource);
  const comments = commentsIn(dialogSource);
  check('the settings dialog is one persistent native modal with its listeners bound in the constructor',
    missing.length === 0 && forbidden.length === 0 && comments.length === 0,
    `missing=${JSON.stringify(missing)}, forbidden=${JSON.stringify(forbidden)}, ` +
    `comments=${JSON.stringify(comments)}`);
}

{
  const mutated = `${dialogSource}\ndocument.addEventListener('keydown', () => {});\n`;
  check('control: a document-level listener is detected by the same negative predicate',
    mutated !== dialogSource && forbiddenDialogTokens(mutated).length === 1 &&
    forbiddenDialogTokens(dialogSource).length === 0,
    `mutated=${forbiddenDialogTokens(mutated).length}, real=${forbiddenDialogTokens(dialogSource).length}`);
}

{
  const mutated = dialogSource.replace('showModal()', 'show()');
  check('control: dropping showModal() is detected by the same needle predicate',
    mutated !== dialogSource && missingDialogNeedles(mutated).includes('showModal()') &&
    missingDialogNeedles(dialogSource).length === 0,
    `mutatedMissing=${missingDialogNeedles(mutated).length}, realMissing=${missingDialogNeedles(dialogSource).length}`);
}

{
  check('the dialog renders its strings before entering the top layer',
    rendersBeforeModal(dialogSource),
    `renderBeforeModal=${rendersBeforeModal(dialogSource)}, ` +
    `showModalAt=${dialogSource.indexOf('this.dialog.showModal();')}`);
}

{
  const mutated = dialogSource.replace('showModal()', 'show()');
  check('control: a dialog that enters the top layer before rendering fails the same order predicate',
    mutated !== dialogSource && !rendersBeforeModal(mutated) && rendersBeforeModal(dialogSource),
    `mutated=${rendersBeforeModal(mutated)}, real=${rendersBeforeModal(dialogSource)}`);
}

{
  check('the backdrop press dismisses only when the dialog itself is the target',
    backdropGuard(dialogSource),
    `guard=${backdropGuard(dialogSource)}`);
}

{
  const mutated = dialogSource.replace('      if (event.target !== this.dialog) return;\n', '');
  check('control: dropping the backdrop target guard is detected by the same predicate',
    mutated !== dialogSource && !backdropGuard(mutated) && backdropGuard(dialogSource),
    `mutated=${backdropGuard(mutated)}, real=${backdropGuard(dialogSource)}`);
}

{
  check('a locale rebuild redraws the pane and returns focus to the same keyed control',
    focusRestoreByKey(dialogSource),
    `restore=${focusRestoreByKey(dialogSource)}`);
}

{
  const mutated = dialogSource.replace("active.closest<HTMLElement>('[data-settings-key]')?.dataset.settingsKey ?? null", 'null');
  check('control: dropping the keyed focus lookup is detected by the same restore predicate',
    mutated !== dialogSource && !focusRestoreByKey(mutated) && focusRestoreByKey(dialogSource),
    `mutated=${focusRestoreByKey(mutated)}, real=${focusRestoreByKey(dialogSource)}`);
}

{
  const constructions = appSource.match(/new SettingsDialog\(/g)?.length ?? 0;
  check('App constructs exactly one settings dialog and keeps it in one field',
    constructions === 1 && appSource.includes('private readonly settingsDialog: SettingsDialog;'),
    `constructions=${constructions}, ` +
    `field=${appSource.includes('private readonly settingsDialog: SettingsDialog;')}`);
}

{
  const mutated = `${appSource}\nconst extra = new SettingsDialog({ detailedLabels: () => true });\n`;
  check('control: a second construction is detected by the same count predicate',
    mutated !== appSource && (mutated.match(/new SettingsDialog\(/g)?.length ?? 0) === 2 && constructions(appSource) === 1,
    `mutated=${(mutated.match(/new SettingsDialog\(/g)?.length ?? 0)}, real=${constructions(appSource)}`);
}

function constructions(source: string): number {
  return source.match(/new SettingsDialog\(/g)?.length ?? 0;
}

function handlerBody(source: string, needle: string): string {
  const start = source.indexOf(needle);
  const end = start >= 0 ? source.indexOf('\n    });', start) : -1;
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function settingsHandlerOpensDialog(source: string): boolean {
  const body = handlerBody(source, "must<HTMLButtonElement>('btn-settings').addEventListener('click'");
  const closeAt = body.indexOf('this.channelList.closeDialog()');
  const menusAt = body.indexOf("this.menuStack.closeOthers(null, 'outside')");
  const openAt = body.indexOf('this.settingsDialog.open(this.el.settings)');
  return closeAt >= 0 && menusAt > closeAt && openAt > menusAt &&
    !body.includes('settingsMenu') && !body.includes('settingsItems');
}

{
  check('the settings button closes the competing overlays, then opens the modal window',
    settingsHandlerOpensDialog(appSource),
    `ok=${settingsHandlerOpensDialog(appSource)}, ` +
    `body=${JSON.stringify(handlerBody(appSource, "must<HTMLButtonElement>('btn-settings').addEventListener('click'").replace(/\s+/g, ' '))}`);
}

{
  const mutated = appSource.replace(
    "      this.menuStack.closeOthers(null, 'outside');\n      this.settingsDialog.open(this.el.settings);\n",
    "      this.settingsDialog.open(this.el.settings);\n      this.menuStack.closeOthers(null, 'outside');\n");
  check('control: opening the window before closing the other overlays is detected by the same order predicate',
    mutated !== appSource && !settingsHandlerOpensDialog(mutated) && settingsHandlerOpensDialog(appSource),
    `mutated=${settingsHandlerOpensDialog(mutated)}, real=${settingsHandlerOpensDialog(appSource)}`);
}

{
  const retired = ['settingsItems', 'this.settingsMenu']
    .filter((needle) => appSource.includes(needle));
  check('the retired dropdown settings path is gone from the app',
    retired.length === 0,
    `hits=${JSON.stringify(retired)}`);
}

{
  const registrations = appSource.match(/this\.menuStack\.register\(this\.(\w+)\);/g) ?? [];
  check('the exclusion owner holds only the language and theme menus',
    registrations.length === 2 &&
    registrations.join(' ') === 'this.menuStack.register(this.languageMenu); this.menuStack.register(this.themeMenu);',
    `registrations=${JSON.stringify(registrations)}`);
}

{
  const start = appSource.indexOf('  private retranslate(): void {');
  const end = start >= 0 ? appSource.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? appSource.slice(start, end) : '';
  const guard = 'if (this.settingsDialog.isOpen) this.settingsDialog.renderStrings();';
  check('retranslate refreshes the window strings only while the window is open',
    body.includes(guard) &&
    body.includes('if (this.shortcutsDialog.isOpen) this.shortcutsDialog.renderStrings();') &&
    body.indexOf('this.shortcutsDialog.renderStrings();') < body.indexOf(guard),
    `guard=${body.includes(guard)}, body=${body.length}`);
}

{
  const start = appSource.indexOf('  private retranslate(): void {');
  const end = start >= 0 ? appSource.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? appSource.slice(start, end) : '';
  const mutated = body.replace('if (this.settingsDialog.isOpen) this.settingsDialog.renderStrings();',
    'this.settingsDialog.renderStrings();');
  check('control: dropping the isOpen guard is detected by the same needle',
    mutated !== body && !mutated.includes('if (this.settingsDialog.isOpen)') &&
    body.includes('if (this.settingsDialog.isOpen)'),
    `mutated=${mutated.includes('if (this.settingsDialog.isOpen)')}`);
}

function openShortcutsBody(source: string): string {
  const start = source.indexOf('openShortcuts: (invoker) => {');
  const end = start >= 0 ? source.indexOf('\n      },', start) : -1;
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function shortcutsOpenOrder(body: string): boolean {
  const closeAt = body.indexOf('this.channelList.closeDialog();');
  const openAt = body.indexOf('this.shortcutsDialog.open(invoker);');
  return closeAt >= 0 && openAt > closeAt && !body.includes('this.el.settings');
}

{
  const body = openShortcutsBody(appSource);
  check('the shortcuts row hands its own frame to the existing dialog through the host bridge',
    shortcutsOpenOrder(body),
    `body=${JSON.stringify(body.replace(/\s+/g, ' '))}`);
}

{
  const body = openShortcutsBody(appSource);
  const mutated = body.replace(
    '        this.channelList.closeDialog();\n        this.shortcutsDialog.open(invoker);',
    '        this.shortcutsDialog.open(invoker);\n        this.channelList.closeDialog();');
  check('control: reversing the close-then-open order is detected by the same predicate',
    mutated !== body && !shortcutsOpenOrder(mutated) && shortcutsOpenOrder(body),
    `mutated=${shortcutsOpenOrder(mutated)}, real=${shortcutsOpenOrder(body)}`);
}

{
  const start = appSource.indexOf('  private setDetailedLabels(on: boolean): void {');
  const end = start >= 0 ? appSource.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? appSource.slice(start, end) : '';
  const order = [
    'const { start, end } = this.stack.view;',
    'const follow = this.stack.followLatest;',
    'this.pendingToolbarViewport = { start, end, follow };',
    'this.detailedLabels = on;',
    'this.reflectDetailedLabels();',
    'this.persistWorkspace();',
    'this.relayout();',
  ].map((needle) => body.indexOf(needle));
  const writingSites = appSource.match(/this\.detailedLabels = /g)?.length ?? 0;
  check('the display toggle keeps the viewport-preserving flip, persist and relayout sequence in one place',
    order.every((index) => index >= 0) &&
    order.every((index, i) => i === 0 || index > order[i - 1]!) &&
    writingSites === 2 &&
    appSource.includes('private detailedLabels = true;'),
    `order=${JSON.stringify(order)}, writes=${writingSites}, body=${body.length}`);
}

{
  const start = appSource.indexOf('  private setDetailedLabels(on: boolean): void {');
  const end = start >= 0 ? appSource.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? appSource.slice(start, end) : '';
  const mutated = body.replace('    this.persistWorkspace();\n', '');
  check('control: dropping the workspace write is detected by the same order predicate',
    mutated !== body && !mutated.includes('this.persistWorkspace();'),
    `mutated=${mutated.includes('this.persistWorkspace();')}`);
}

{
  const tag = /<button[^>]*\bid="btn-settings"[^>]*>/.exec(html)?.[0] ?? '';
  const controls = /\saria-controls="([^"]*)"/.exec(tag)?.[1];
  const hasPopup = /\saria-haspopup="([^"]*)"/.exec(tag)?.[1];
  const titleKey = /data-i18n-title="([^"]*)"/.exec(tag)?.[1];
  const title = /\stitle="([^"]*)"/.exec(tag)?.[1];
  const label = /\saria-label="([^"]*)"/.exec(tag)?.[1];
  check('the settings button announces a dialog and points at the window id',
    controls === SETTINGS_DIALOG_ID && hasPopup === 'dialog' &&
    !tag.includes('aria-expanded') && tag.length > 0,
    `tag=${JSON.stringify(tag)}`);
  check('the settings button keeps its static title and accessible name',
    titleKey === 'settings.titleHint' && title === en['settings.titleHint'] &&
    label === en['settings.title'],
    `titleKey=${titleKey}, title=${JSON.stringify(title)}, label=${JSON.stringify(label)}`);
}

{
  const anchor = 'aria-controls="settings-dialog"';
  const mutated = html.replace(anchor, 'aria-controls="settings-menu"');
  const controlsOf = (source: string): string | undefined =>
    /\saria-controls="([^"]*)"/.exec(/<button[^>]*\bid="btn-settings"[^>]*>/.exec(source)?.[0] ?? '')?.[1];
  check('control: pointing aria-controls back at the retired menu id fails the same predicate',
    mutated !== html && controlsOf(mutated) === 'settings-menu' && controlsOf(html) === SETTINGS_DIALOG_ID,
    `mutated=${controlsOf(mutated)}, real=${controlsOf(html)}`);
}

const cssStart = css.indexOf('/* -------------------------------------------------------- settings dialog */');
const cssEnd = css.indexOf('.select-popover, .settings-menu, .settings-flyout {');
const dialogCss = cssStart >= 0 && cssEnd > cssStart ? css.slice(cssStart, cssEnd) : '';

{
  const needles = [
    '.settings-dialog {',
    '.settings-dialog::backdrop {',
    '.settings-dialog-header {',
    '.settings-dialog-close {',
    '.settings-dialog-close:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }',
    '.settings-dialog-body {',
    '.settings-pane {',
    `min(${SETTINGS_DIALOG_WIDTH}px, calc(100vw - 32px))`,
    `min(${SETTINGS_DIALOG_HEIGHT}px, calc(100dvh - 32px))`,
    'background: var(--card)',
    'border: 1px solid var(--border)',
    'border-radius: var(--radius)',
    'background: rgb(0 0 0 / 60%)',
    'html[data-theme="light"] .settings-dialog::backdrop { background: var(--backdrop); }',
    'animation: motion-pop var(--motion-fast) var(--motion-ease);',
    'animation: motion-fade var(--motion-fast) var(--motion-ease);',
  ];
  const missing = needles.filter((needle) => !dialogCss.includes(needle));
  check('the window is styled from the existing dialog family and the mirrored metrics',
    dialogCss.length > 0 && missing.length === 0,
    `missing=${JSON.stringify(missing)}, block=${dialogCss.length}`);
}

{
  const twin = ':is(html[data-theme="dark"], html[data-theme="light"]) .settings-dialog { box-shadow: 0 8px 24px var(--shadow); }';
  check('the window takes the themed shadow twin of the two existing dialogs',
    css.includes(twin),
    `twin=${css.includes(twin)}`);
}

function forcedOrRawHex(block: string): boolean {
  return /#[0-9a-fA-F]{3,8}/.test(block) || block.includes('!important');
}

{
  check('the window block adds no !important and no raw hex colour',
    dialogCss.length > 0 && !forcedOrRawHex(dialogCss),
    `hex=${/#[0-9a-fA-F]{3,8}/.test(dialogCss)}, important=${dialogCss.includes('!important')}, ` +
    `block=${dialogCss.length}`);
}

{
  const injectedHex = `${dialogCss}\n.settings-pane { color: #fefefe; }\n`;
  const injectedImportant = `${dialogCss}\n.settings-pane { color: var(--card) !important; }\n`;
  check('control: an injected raw hex colour and an injected !important are detected by the same predicate',
    injectedHex !== dialogCss && /#[0-9a-fA-F]{3,8}/.test(injectedHex) &&
    /#[0-9a-fA-F]{3,8}/.test(dialogCss) === false &&
    injectedImportant.includes('!important') && dialogCss.includes('!important') === false &&
    forcedOrRawHex(injectedHex) && forcedOrRawHex(injectedImportant) && !forcedOrRawHex(dialogCss),
    `hex=${forcedOrRawHex(injectedHex)}, important=${forcedOrRawHex(injectedImportant)}, ` +
    `real=${forcedOrRawHex(dialogCss)}`);
}

{
  const shipped = [
    SETTINGS_DIALOG_ID === 'settings-dialog',
    SETTINGS_DIALOG_WIDTH === 560,
    SETTINGS_DIALOG_HEIGHT === 360,
    SETTINGS_NAV_WIDTH === 152,
  ];
  const drifted = shipped.filter((value) => !value).length;
  check('the exported window constants keep the shipped values the sheet mirrors',
    drifted === 0 && dialogCss.includes(`min(${SETTINGS_DIALOG_WIDTH}px`) &&
    dialogCss.includes(`min(${SETTINGS_DIALOG_HEIGHT}px`),
    `id=${SETTINGS_DIALOG_ID}, width=${SETTINGS_DIALOG_WIDTH}, height=${SETTINGS_DIALOG_HEIGHT}, ` +
    `nav=${SETTINGS_NAV_WIDTH}, drifted=${drifted}`);
}

const CATALOGS: ReadonlyArray<readonly [string, (key: MessageKey) => string, Record<string, string>]> = [
  ['en', (key) => en[key], en],
  ['zh-CN', (key) => zhCN[key], zhCN],
  ['ru', (key) => ru[key], ru],
  ['fr', (key) => fr[key], fr],
];

const EN_SETTINGS_KEYS = Object.keys(en).filter((key) => key.startsWith('settings.')).sort();

{
  const want = ['Close', '关闭', 'Закрыть', 'Fermer'];
  const drift = CATALOGS
    .map(([locale, lookup], index) => ({ locale, actual: lookup('settings.close'), want: want[index]! }))
    .filter((row) => row.actual !== row.want);
  check('all four catalogs carry the window close label with its pinned value',
    drift.length === 0,
    drift.length === 0 ? want.join(' | ') : drift.map((row) => `${row.locale}=${JSON.stringify(row.actual)}`).join('; '));
}

{
  const drift = CATALOGS
    .map(([locale, , dict]) => ({
      locale,
      keys: Object.keys(dict).filter((key) => key.startsWith('settings.')).sort().join(','),
    }))
    .filter((row) => row.keys !== EN_SETTINGS_KEYS.join(','));
  check('every catalog carries the same settings key set, including the new close label',
    drift.length === 0 && EN_SETTINGS_KEYS.includes('settings.close'),
    drift.length === 0 ? `${EN_SETTINGS_KEYS.length} keys x ${CATALOGS.length} catalogs`
      : drift.map((row) => `${row.locale}:${row.keys}`).join('; '));
}

{
  const mutated = { ...en } as Record<string, string>;
  const parity = (keys: string[]): boolean => keys.join(',') === EN_SETTINGS_KEYS.join(',');
  delete mutated['settings.close'];
  const missingKeys = Object.keys(mutated).filter((key) => key.startsWith('settings.')).sort();
  check('control: a catalog missing the close label fails the same key-set predicate',
    !parity(missingKeys) && parity(EN_SETTINGS_KEYS),
    `mutatedKeys=${missingKeys.length}, realKeys=${EN_SETTINGS_KEYS.length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
