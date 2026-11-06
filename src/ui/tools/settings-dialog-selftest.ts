import {
  SETTINGS_DIALOG_HEIGHT,
  SETTINGS_DIALOG_ID,
  SETTINGS_DIALOG_WIDTH,
  SETTINGS_NAV_WIDTH,
  SETTINGS_PANE_GAP,
  SETTINGS_ROW_GAP,
  SETTINGS_ROW_HEIGHT,
  SETTINGS_ROW_LABEL_MIN,
  SETTINGS_ROW_PADDING_Y,
  SETTINGS_SECTIONS,
  settingsSectionAfter,
} from '../settingsDialog.js';
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
  "this.rowLabel('settings.detailedLabels', input.id)",
  "this.rowLabel('settings.shortcuts')",
  "this.closeButton.setAttribute('aria-label', t('settings.close'));",
  'this.host.setDetailedLabels(',
  'this.host.openShortcuts(row)',
];

const DIALOG_FORBIDDEN: readonly string[] = [
  'document.addEventListener',
  'window.addEventListener',
  'innerHTML',
  'settings-item',
  'settings-check',
  'settings-hint',
  'localStorage',
  'persistWorkspace',
  'reflectDetailedLabels',
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
    body.indexOf('this.renderBody();') < body.indexOf('this.focusKeyed(restore)');
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
  const mutated = dialogSource.replace(
    "    row.className = 'settings-row';\n",
    "    row.className = 'settings-row settings-item';\n");
  check('control: reusing the retired menu-row class is detected by the same forbidden-token predicate',
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

function methodBody(source: string, needle: string): string {
  const start = source.indexOf(needle);
  const end = start >= 0 ? source.indexOf('\n  }', start) : -1;
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function sectionAfterSource(source: string): boolean {
  const start = source.indexOf('export function settingsSectionAfter(');
  const end = start >= 0 ? source.indexOf('\n}', start) : -1;
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  return body.includes("if (key === 'ArrowUp') next = SETTINGS_SECTIONS[index > 0 ? index - 1 : last];") &&
    body.includes("else if (key === 'ArrowDown') next = SETTINGS_SECTIONS[index < last ? index + 1 : 0];") &&
    body.includes("else if (key === 'Home') next = SETTINGS_SECTIONS[0];") &&
    body.includes("else if (key === 'End') next = SETTINGS_SECTIONS[last];") &&
    body.includes('return next === current ? null : next;');
}

function navKeyCommitted(source: string): boolean {
  const body = methodBody(source, 'private onNavKey(event: KeyboardEvent): void {');
  const resolveAt = body.indexOf('const target = settingsSectionAfter(event.key, this.section);');
  const bailAt = body.indexOf('if (target === null) return;');
  const preventAt = body.indexOf('event.preventDefault();');
  const selectAt = body.indexOf('this.selectSection(target);');
  return resolveAt >= 0 && bailAt > resolveAt && preventAt > bailAt && selectAt > preventAt;
}

function openFocusesActiveTab(source: string): boolean {
  const body = methodBody(source, '  open(invoker: HTMLElement | null): void {');
  return body.includes('this.dialog.showModal();') &&
    body.indexOf('this.focusKeyed(null);') > body.indexOf('this.dialog.showModal();');
}

function focusFallsBackToActiveTab(source: string): boolean {
  const body = methodBody(source, 'private focusKeyed(key: string | null): void {');
  return body.includes('(keyed ?? this.activeTab() ?? this.closeButton).focus({ preventScroll: true });');
}

const SECTION = SETTINGS_SECTIONS[0];
const SECTION_LABEL_KEY = `settings.sections.${SECTION}`;

const NAV_NEEDLES: readonly string[] = [
  "nav.className = 'settings-nav';",
  "nav.setAttribute('role', 'tablist');",
  "nav.setAttribute('aria-orientation', 'vertical');",
  "nav.setAttribute('aria-label', t('settings.title'));",
  'tab.id = `settings-tab-${section}`;',
  "tab.setAttribute('role', 'tab');",
  "tab.setAttribute('aria-controls', `settings-panel-${section}`);",
  "tab.classList.toggle('selected', selected);",
  "tab.setAttribute('aria-selected', String(selected));",
  'tab.tabIndex = selected ? 0 : -1;',
  "pane.setAttribute('role', 'tabpanel');",
  "pane.setAttribute('aria-labelledby', `settings-tab-${this.section}`);",
  'pane.tabIndex = 0;',
  'this.body.replaceChildren(this.nav(), this.pane());',
];

{
  const keys = ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Tab', ' ', 'a', 'Escape'];
  const rows = keys.map((key) => ({ key, next: settingsSectionAfter(key, SECTION) }));
  const changed = rows.filter((row) => row.next !== null);
  check('the shipped section table is a single section and no key resolves to a different one',
    SETTINGS_SECTIONS.length === 1 && SECTION === 'appearance' && changed.length === 0,
    `sections=${JSON.stringify(SETTINGS_SECTIONS)}, changed=${JSON.stringify(changed)}`);
}

{
  const inert = ['ArrowUp', 'ArrowDown', 'Home', 'End']
    .every((key) => settingsSectionAfter(key, SECTION) === null);
  check('every roving key is inert on the shipped single-section table without throwing',
    inert && settingsSectionAfter('ArrowDown', SECTION) === null &&
    settingsSectionAfter('', SECTION) === null,
    `inert=${inert}`);
}

{
  check('the section walker resolves wrap, Home and End before rejecting an unchanged target',
    sectionAfterSource(dialogSource),
    `ok=${sectionAfterSource(dialogSource)}`);
}

{
  const mutated = dialogSource.replace('  return next === current ? null : next;', '  return next;');
  check('control: dropping the unchanged-target guard is detected by the same walker predicate',
    mutated !== dialogSource && !sectionAfterSource(mutated) && sectionAfterSource(dialogSource),
    `mutated=${sectionAfterSource(mutated)}, real=${sectionAfterSource(dialogSource)}`);
}

{
  check('the navigation list and its panel are paired tabs of one section table',
    NAV_NEEDLES.every((needle) => dialogSource.includes(needle)),
    `missing=${JSON.stringify(NAV_NEEDLES.filter((needle) => !dialogSource.includes(needle)))}`);
}

{
  const tabIds = dialogSource.match(/settings-tab-/g)?.length ?? 0;
  const panelIds = dialogSource.match(/settings-panel-/g)?.length ?? 0;
  const literalIds = [`settings-tab-${SECTION}`, `settings-panel-${SECTION}`]
    .filter((id) => dialogSource.includes(`'${id}'`) || dialogSource.includes(`"${id}"`));
  check('tab and panel ids are composed from the section table, never written as literals',
    tabIds === 3 && panelIds === 2 && literalIds.length === 0,
    `tabs=${tabIds}, panels=${panelIds}, literal=${JSON.stringify(literalIds)}`);
}

{
  const mutated = dialogSource.replace('tab.tabIndex = selected ? 0 : -1;', 'tab.tabIndex = 0;');
  check('control: dropping the roving tabindex is detected by the same needle predicate',
    mutated !== dialogSource && !NAV_NEEDLES.every((needle) => mutated.includes(needle)) &&
    NAV_NEEDLES.every((needle) => dialogSource.includes(needle)),
    `mutatedMissing=${NAV_NEEDLES.filter((needle) => !mutated.includes(needle)).length}`);
}

{
  const mutated = dialogSource.replace("  nav.setAttribute('role', 'tablist');", '');
  check('control: dropping the tablist role is detected by the same needle predicate',
    mutated !== dialogSource && !NAV_NEEDLES.every((needle) => mutated.includes(needle)) &&
    NAV_NEEDLES.every((needle) => dialogSource.includes(needle)),
    `mutatedMissing=${NAV_NEEDLES.filter((needle) => !mutated.includes(needle)).length}`);
}

{
  check('navigation keys move only when the resolved section actually changes',
    navKeyCommitted(dialogSource),
    `body=${JSON.stringify(methodBody(dialogSource, 'private onNavKey(event: KeyboardEvent): void {').replace(/\s+/g, ' '))}`);
}

{
  const unconditional = dialogSource.replace('    if (target === null) return;\n', '');
  const early = dialogSource.replace(
    '    const target = settingsSectionAfter(event.key, this.section);\n    if (target === null) return;\n    event.preventDefault();',
    '    event.preventDefault();\n    const target = settingsSectionAfter(event.key, this.section);\n    if (target === null) return;');
  check('control: an unconditional or premature preventDefault is detected by the same predicate',
    unconditional !== dialogSource && !navKeyCommitted(unconditional) &&
    early !== dialogSource && !navKeyCommitted(early) && navKeyCommitted(dialogSource),
    `unconditional=${navKeyCommitted(unconditional)}, early=${navKeyCommitted(early)}, ` +
    `real=${navKeyCommitted(dialogSource)}`);
}

{
  check('the window opens with focus on the active section tab',
    openFocusesActiveTab(dialogSource),
    `ok=${openFocusesActiveTab(dialogSource)}`);
}

{
  const mutated = dialogSource.replace('    this.focusKeyed(null);\n', '');
  check('control: dropping the open-time focus move is detected by the same predicate',
    mutated !== dialogSource && !openFocusesActiveTab(mutated) && openFocusesActiveTab(dialogSource),
    `mutated=${openFocusesActiveTab(mutated)}, real=${openFocusesActiveTab(dialogSource)}`);
}

{
  check('a keyed rebuild falls back to the active tab when that key is gone',
    focusFallsBackToActiveTab(dialogSource),
    `ok=${focusFallsBackToActiveTab(dialogSource)}`);
}

{
  const mutated = dialogSource.replace('(keyed ?? this.activeTab() ?? this.closeButton)', '(keyed ?? this.closeButton)');
  check('control: dropping the active-tab fallback is detected by the same predicate',
    mutated !== dialogSource && !focusFallsBackToActiveTab(mutated) && focusFallsBackToActiveTab(dialogSource),
    `mutated=${focusFallsBackToActiveTab(mutated)}, real=${focusFallsBackToActiveTab(dialogSource)}`);
}

{
  const mutated = dialogSource.replace("active.closest<HTMLElement>('[data-settings-key]')?.dataset.settingsKey ?? null", 'null');
  check('control: dropping the keyed focus lookup is detected by the same restore predicate',
    mutated !== dialogSource && !focusRestoreByKey(mutated) && focusRestoreByKey(dialogSource),
    `mutated=${focusRestoreByKey(mutated)}, real=${focusRestoreByKey(dialogSource)}`);
}

const TOGGLE_NEEDLES: readonly string[] = [
  "row.className = 'settings-row';",
  "input.id = 'settings-detailed-labels';",
  "const label = this.rowLabel('settings.detailedLabels', input.id);",
  "label.id = 'settings-row-detailed-labels';",
  "toggle.className = 'settings-toggle';",
  "input.type = 'checkbox';",
  "input.dataset.settingsKey = 'detailedLabels';",
  "input.setAttribute('aria-labelledby', label.id);",
  'input.checked = this.host.detailedLabels();',
  "input.addEventListener('change', () => this.host.setDetailedLabels(input.checked));",
  'toggle.appendChild(input);',
];

const ACTION_ROW_NEEDLES: readonly string[] = [
  "row.className = 'settings-row settings-row--action';",
  "row.dataset.settingsKey = 'shortcuts';",
  "hint.className = 'settings-row-hint';",
  "hint.setAttribute('aria-hidden', 'true');",
  "hint.textContent = '▸';",
  "row.append(this.rowLabel('settings.shortcuts'), hint);",
  'this.host.openShortcuts(row)',
];

function paneComposition(source: string): boolean {
  const body = methodBody(source, 'private paneContent(section: SettingsSectionId): HTMLElement[] {');
  return body.includes("return section === 'appearance' ? [this.labelsRow(), this.shortcutsRow()] : [];") &&
    !body.includes('settings-item') && !body.includes('new SettingsMenu');
}

{
  check('the appearance pane is exactly the display toggle row and the shortcuts row',
    paneComposition(dialogSource),
    `ok=${paneComposition(dialogSource)}, ` +
    `body=${JSON.stringify(methodBody(dialogSource, 'private paneContent(section: SettingsSectionId): HTMLElement[] {').replace(/\s+/g, ' '))}`);
}

{
  const mutated = dialogSource.replace(
    "return section === 'appearance' ? [this.labelsRow(), this.shortcutsRow()] : [];",
    "return section === 'appearance' ? [this.shortcutsRow()] : [];");
  check('control: dropping a row from the appearance pane is detected by the same composition predicate',
    mutated !== dialogSource && !paneComposition(mutated) && paneComposition(dialogSource),
    `mutated=${paneComposition(mutated)}, real=${paneComposition(dialogSource)}`);
}

{
  const missing = TOGGLE_NEEDLES.filter((needle) => !dialogSource.includes(needle));
  check('the display toggle is a row-level checkbox labelled by its row label and writing only through the host',
    missing.length === 0,
    `missing=${JSON.stringify(missing)}`);
}

function rowLabelBody(source: string): string {
  return methodBody(source, 'private rowLabel(key: MessageKey, controlId?: string): HTMLElement {');
}

function rowLabelBindsControl(source: string): boolean {
  const body = rowLabelBody(source);
  const labelAt = body.indexOf("const label = document.createElement('label');");
  const forAt = body.indexOf('label.htmlFor = controlId;');
  const rowBody = methodBody(source, 'private labelsRow(): HTMLDivElement {');
  const idAt = rowBody.indexOf("input.id = 'settings-detailed-labels';");
  const callAt = rowBody.indexOf("const label = this.rowLabel('settings.detailedLabels', input.id);");
  return labelAt >= 0 && forAt > labelAt &&
    body.includes("const span = document.createElement('span');") &&
    !body.includes('instanceof HTMLLabelElement') &&
    !body.includes('if (controlId !== undefined') &&
    idAt >= 0 && callAt > idAt;
}

{
  check('the row label is a real label bound to the checkbox, so the row text is part of the toggle target',
    rowLabelBindsControl(dialogSource),
    `body=${JSON.stringify(rowLabelBody(dialogSource).replace(/\s+/g, ' '))}`);
}

{
  const spanLabel = dialogSource.replace(
    "    const label = document.createElement('label');\n",
    "    const label = document.createElement('span');\n");
  const noFor = dialogSource.replace('    label.htmlFor = controlId;\n', '');
  const guardedFor = dialogSource.replace(
    '    label.htmlFor = controlId;\n',
    '    if (controlId !== undefined) label.htmlFor = controlId;\n');
  const unkeyed = dialogSource.replace(
    "    const label = this.rowLabel('settings.detailedLabels', input.id);\n",
    "    const label = this.rowLabel('settings.detailedLabels');\n");
  const lateId = dialogSource.replace(
    "    input.id = 'settings-detailed-labels';\n    input.dataset.settingsKey = 'detailedLabels';\n    const label = this.rowLabel('settings.detailedLabels', input.id);\n",
    "    input.dataset.settingsKey = 'detailedLabels';\n    const label = this.rowLabel('settings.detailedLabels', input.id);\n    input.id = 'settings-detailed-labels';\n");
  check('control: reverting the row label to a plain span, dropping the for binding, guarding it behind a conditional, not handing over the control id or assigning that id after the binding fails the same predicate',
    spanLabel !== dialogSource && !rowLabelBindsControl(spanLabel) &&
    noFor !== dialogSource && !rowLabelBindsControl(noFor) &&
    guardedFor !== dialogSource && !rowLabelBindsControl(guardedFor) &&
    unkeyed !== dialogSource && !rowLabelBindsControl(unkeyed) &&
    lateId !== dialogSource && !rowLabelBindsControl(lateId) &&
    rowLabelBindsControl(dialogSource),
    `span=${rowLabelBindsControl(spanLabel)}, noFor=${rowLabelBindsControl(noFor)}, ` +
    `guarded=${rowLabelBindsControl(guardedFor)}, unkeyed=${rowLabelBindsControl(unkeyed)}, ` +
    `lateId=${rowLabelBindsControl(lateId)}, real=${rowLabelBindsControl(dialogSource)}`);
}

{
  const noState = dialogSource.replace('    input.checked = this.host.detailedLabels();\n', '');
  const noName = dialogSource.replace("    input.setAttribute('aria-labelledby', label.id);\n", '');
  const noLabel = dialogSource.replace(
    "    const label = this.rowLabel('settings.detailedLabels', input.id);\n",
    "    const label = this.rowLabel('settings.detailedLabels');\n");
  const noWrap = dialogSource.replace('    toggle.appendChild(input);\n', '    row.append(input);\n');
  check('control: a cached toggle state, an unnamed checkbox, an unbound row label or an unlabelled row is detected by the same predicate',
    noState !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noState.includes(needle)) &&
    noName !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noName.includes(needle)) &&
    noLabel !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noLabel.includes(needle)) &&
    noWrap !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noWrap.includes(needle)) &&
    TOGGLE_NEEDLES.every((needle) => dialogSource.includes(needle)),
    `noState=${TOGGLE_NEEDLES.filter((n) => !noState.includes(n)).length}, ` +
    `noName=${TOGGLE_NEEDLES.filter((n) => !noName.includes(n)).length}, ` +
    `noLabel=${TOGGLE_NEEDLES.filter((n) => !noLabel.includes(n)).length}, ` +
    `noWrap=${TOGGLE_NEEDLES.filter((n) => !noWrap.includes(n)).length}, ` +
    `real=${TOGGLE_NEEDLES.filter((n) => !dialogSource.includes(n)).length}`);
}

{
  const missing = ACTION_ROW_NEEDLES.filter((needle) => !dialogSource.includes(needle));
  check('the shortcuts row is a row-level button that hands its own frame to the host bridge',
    missing.length === 0,
    `missing=${JSON.stringify(missing)}`);
}

{
  const plainButton = dialogSource.replace(
    "    row.className = 'settings-row settings-row--action';\n",
    "    row.className = 'settings-row';\n");
  const foreignInvoker = dialogSource.replace('this.host.openShortcuts(row)', 'this.host.openShortcuts(this.closeButton)');
  const namedHint = dialogSource.replace("    hint.setAttribute('aria-hidden', 'true');\n", '');
  check('control: a shortcuts row without the action variant, a foreign frame, or a hint inside the accessible name is detected by the same predicate',
    plainButton !== dialogSource && !ACTION_ROW_NEEDLES.every((needle) => plainButton.includes(needle)) &&
    foreignInvoker !== dialogSource && !ACTION_ROW_NEEDLES.every((needle) => foreignInvoker.includes(needle)) &&
    namedHint !== dialogSource && !ACTION_ROW_NEEDLES.every((needle) => namedHint.includes(needle)) &&
    ACTION_ROW_NEEDLES.every((needle) => dialogSource.includes(needle)),
    `plain=${ACTION_ROW_NEEDLES.filter((n) => !plainButton.includes(n)).length}, ` +
    `foreign=${ACTION_ROW_NEEDLES.filter((n) => !foreignInvoker.includes(n)).length}, ` +
    `namedHint=${ACTION_ROW_NEEDLES.filter((n) => !namedHint.includes(n)).length}, ` +
    `real=${ACTION_ROW_NEEDLES.filter((n) => !dialogSource.includes(n)).length}`);
}

{
  const leftovers = ['settings-item', 'settings-check', 'settings-hint']
    .filter((needle) => dialogSource.includes(needle));
  check('the temporary menu-row markup is gone from the window',
    leftovers.length === 0,
    `leftovers=${JSON.stringify(leftovers)}`);
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

function toggleSequenceHolds(body: string): boolean {
  const order = [
    'const { start, end } = this.stack.view;',
    'const follow = this.stack.followLatest;',
    'this.pendingToolbarViewport = { start, end, follow };',
    'this.detailedLabels = on;',
    'this.reflectDetailedLabels();',
    'this.persistWorkspace();',
    'this.relayout();',
  ].map((needle) => body.indexOf(needle));
  return order.every((index) => index >= 0) &&
    order.every((index, i) => i === 0 || index > order[i - 1]!);
}

{
  const body = methodBody(appSource, 'private setDetailedLabels(on: boolean): void {');
  const writingSites = appSource.match(/this\.detailedLabels = /g)?.length ?? 0;
  check('the display toggle keeps the viewport-preserving flip, persist and relayout sequence in one place',
    toggleSequenceHolds(body) &&
    writingSites === 2 &&
    appSource.includes('private detailedLabels = true;'),
    `writes=${writingSites}, body=${body.length}`);
}

{
  const body = methodBody(appSource, 'private setDetailedLabels(on: boolean): void {');
  const mutated = body.replace('    this.persistWorkspace();\n', '');
  check('control: dropping the workspace write is detected by the same order predicate',
    mutated !== body && !mutated.includes('this.persistWorkspace();') &&
    !toggleSequenceHolds(mutated) && toggleSequenceHolds(body),
    `kept=${mutated.includes('this.persistWorkspace();')}, ` +
    `mutated=${toggleSequenceHolds(mutated)}, real=${toggleSequenceHolds(body)}`);
}

function detailWriter(source: string): string {
  return methodBody(source, 'private setDetailedLabels(on: boolean): void {');
}

function reflectThenPersist(source: string): boolean {
  const body = detailWriter(source);
  return body.includes('    this.reflectDetailedLabels();\n    this.persistWorkspace();\n') &&
    !body.includes('localStorage') && !body.includes('data-toolbar-labels');
}

{
  const bridge = 'setDetailedLabels: (on) => this.setDetailedLabels(on),';
  const callSites = appSource.match(/this\.setDetailedLabels\(/g)?.length ?? 0;
  check('the display toggle keeps one writer whose reflect step sits immediately before the workspace write',
    reflectThenPersist(appSource) && appSource.includes(bridge) && callSites === 1 &&
    (appSource.match(/data-toolbar-labels/g)?.length ?? 0) === 2,
    `adjacent=${reflectThenPersist(appSource)}, bridge=${appSource.includes(bridge)}, ` +
    `callSites=${callSites}, ` +
    `attributeWrites=${appSource.match(/data-toolbar-labels/g)?.length ?? 0}`);
}

{
  const swapped = appSource.replace(
    '    this.reflectDetailedLabels();\n    this.persistWorkspace();\n',
    '    this.persistWorkspace();\n    this.reflectDetailedLabels();\n');
  const writesIn = (source: string): number => source.match(/this\.detailedLabels = /g)?.length ?? 0;
  const bypass = appSource.replace(
    'setDetailedLabels: (on) => this.setDetailedLabels(on),',
    'setDetailedLabels: (on) => { this.detailedLabels = on; },');
  check('control: a persist before the reflect, or a host that writes the field directly, is detected by the same predicate',
    swapped !== appSource && !reflectThenPersist(swapped) &&
    bypass !== appSource && writesIn(bypass) === writesIn(appSource) + 1 &&
    reflectThenPersist(appSource) && writesIn(appSource) === 2,
    `swapped=${reflectThenPersist(swapped)}, writes=${writesIn(appSource)}/${writesIn(bypass)}, ` +
    `real=${reflectThenPersist(appSource)}`);
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

function ruleBlock(block: string, selector: string): string {
  const start = block.indexOf(selector);
  const end = start >= 0 ? block.indexOf('\n}', start) : -1;
  return start >= 0 && end > start ? block.slice(start, end) : '';
}

function effectiveGaps(rule: string): { row: number | null; column: number | null } {
  const gaps: { row: number | null; column: number | null } = { row: null, column: null };
  const lengths = (value: string): number[] => (value.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  for (const declaration of rule.matchAll(/(?:^|[\n;{])\s*(row-gap|column-gap|gap)\s*:\s*([^;]+);/g)) {
    const values = lengths(declaration[2]);
    const [first = null, second = null] = values;
    if (declaration[1] === 'row-gap') gaps.row = first;
    else if (declaration[1] === 'column-gap') gaps.column = first;
    else {
      gaps.row = first;
      gaps.column = values.length > 1 ? second : first;
    }
  }
  return gaps;
}

function paneScrollsNotWindow(block: string): boolean {
  const dialogRule = ruleBlock(block, '.settings-dialog {');
  const paneRule = ruleBlock(block, '.settings-pane {');
  return dialogRule.includes('overflow: hidden;') &&
    !dialogRule.includes('overflow-y: auto;') &&
    paneRule.includes('overflow-y: auto;') &&
    paneRule.includes('min-height: 0;');
}

const NAV_CSS_NEEDLES: readonly string[] = [
  `--settings-nav-w: ${SETTINGS_NAV_WIDTH}px;`,
  'grid-template-columns: var(--settings-nav-w) minmax(0, 1fr);',
  '.settings-dialog[open] { display: flex; flex-direction: column; }',
  '.settings-nav {',
  '.settings-nav-item {',
  `height: ${SETTINGS_ROW_HEIGHT}px;`,
  'background: var(--background);',
  'border-right: 1px solid var(--border);',
  'border-radius: calc(var(--radius) - 2px);',
  '.settings-nav-item:hover { background: var(--muted); color: var(--foreground); }',
  '.settings-nav-item.selected { background: var(--muted); color: var(--foreground); }',
  '.settings-dialog .settings-nav-item:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }',
  '.settings-pane {',
];

{
  const missing = NAV_CSS_NEEDLES.filter((needle) => !dialogCss.includes(needle));
  check('the sheet gives the window its two-column navigation column from the mirrored metrics',
    dialogCss.length > 0 && missing.length === 0,
    `missing=${JSON.stringify(missing)}, block=${dialogCss.length}`);
}

{
  check('the section pane owns the scrolling while the window itself clips',
    dialogCss.length > 0 && paneScrollsNotWindow(dialogCss),
    `dialog=${JSON.stringify(ruleBlock(dialogCss, '.settings-dialog {'))}, ` +
    `pane=${JSON.stringify(ruleBlock(dialogCss, '.settings-pane {'))}`);
}

{
  const mutated = dialogCss.replace('  overflow: hidden;\n', '  overflow-y: auto;\n');
  check('control: a window that scrolls its own header is detected by the same predicate',
    mutated !== dialogCss && !paneScrollsNotWindow(mutated) && paneScrollsNotWindow(dialogCss),
    `mutated=${paneScrollsNotWindow(mutated)}, real=${paneScrollsNotWindow(dialogCss)}`);
}

function railScrollsInsteadOfCompressing(block: string): boolean {
  const rail = ruleBlock(block, '.settings-nav {');
  const item = ruleBlock(block, '.settings-nav-item {');
  return rail.includes('display: flex;') && rail.includes('flex-direction: column;') &&
    rail.includes('overflow-y: auto;') && item.includes('flex: none;');
}

{
  check('the navigation rail scrolls its items instead of compressing them',
    dialogCss.length > 0 && railScrollsInsteadOfCompressing(dialogCss),
    `rail=${JSON.stringify(ruleBlock(dialogCss, '.settings-nav {'))}, ` +
    `item=${JSON.stringify(ruleBlock(dialogCss, '.settings-nav-item {'))}`);
}

{
  const shrinkable = dialogCss.replace(
    '.settings-nav-item {\n  flex: none;\n  display: flex;\n  align-items: center;',
    '.settings-nav-item {\n  display: flex;\n  align-items: center;');
  const blockRail = dialogCss.replace(
    '.settings-nav {\n  display: flex;\n  flex-direction: column;',
    '.settings-nav {\n  flex-direction: column;');
  check('control: a rail that is not a column flex, or an item free to shrink, is detected by the same predicate',
    shrinkable !== dialogCss && blockRail !== dialogCss &&
    !railScrollsInsteadOfCompressing(shrinkable) && !railScrollsInsteadOfCompressing(blockRail) &&
    railScrollsInsteadOfCompressing(dialogCss),
    `shrinkable=${railScrollsInsteadOfCompressing(shrinkable)}, ` +
    `blockRail=${railScrollsInsteadOfCompressing(blockRail)}, real=${railScrollsInsteadOfCompressing(dialogCss)}`);
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function matchingBrace(text: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface CssRule {
  selectors: readonly string[];
  body: string;
}

function cssRules(sheet: string): CssRule[] {
  const rules: CssRule[] = [];
  const walk = (text: string): void => {
    let headerStart = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '}' || ch === ';') headerStart = i + 1;
      else if (ch === '{') {
        const header = text.slice(headerStart, i).trim();
        const end = matchingBrace(text, i);
        if (end < 0) return;
        const body = text.slice(i + 1, end);
        if (header.startsWith('@')) walk(body);
        else if (header.length > 0) rules.push({ selectors: splitTopLevel(header, ','), body });
        i = end;
        headerStart = end + 1;
      }
    }
  };
  walk(sheet);
  return rules;
}

function rightmostCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) start = i + 1;
  }
  return selector.slice(start).trim();
}

function expandMatches(compound: string): string[] {
  const match = /:(?:is|where)\(([^()]*)\)/.exec(compound);
  if (match === null) return [compound];
  const head = compound.slice(0, match.index);
  const tail = compound.slice(match.index + match[0].length);
  return splitTopLevel(match[1], ',').flatMap((member) => expandMatches(`${head}${member}${tail}`));
}

const NAV_ITEM_CLASSES: readonly string[] = ['settings-nav-item', 'selected'];
const NAV_ITEM_TYPES: readonly string[] = ['button'];
const NAV_ITEM_IDS: readonly string[] = SETTINGS_SECTIONS.map((section) => `settings-tab-${section}`);

function couldFocusSettingsNavItem(selector: string): boolean {
  return expandMatches(rightmostCompound(selector)).some((compound) => {
    const rest = compound.replace(/:focus-visible/g, '').replace(/:focus(?![\-\w])/g, '');
    if (rest.length === 0) return true;
    const ids = [...rest.matchAll(/#([a-z0-9-]+)/g)].map((match) => match[1]);
    const classes = [...rest.matchAll(/\.([a-z0-9-]+)/g)].map((match) => match[1]);
    const types = [...rest.matchAll(/(?:^|[\s>+~])([a-z][a-z0-9-]*)/g)].map((match) => match[1]);
    return ids.every((name) => NAV_ITEM_IDS.includes(name)) &&
      classes.every((name) => NAV_ITEM_CLASSES.includes(name)) &&
      types.every((name) => NAV_ITEM_TYPES.includes(name));
  });
}

interface NavRingVerdict {
  ring: string;
  inset: boolean;
  rivals: readonly string[];
  losing: readonly string[];
}

function navRingVerdict(sheet: string): NavRingVerdict | null {
  const rules = cssRules(sheet);
  const describesNavItem = (selector: string): boolean =>
    rightmostCompound(selector).includes('.settings-nav-item');
  const ringRule = rules.find((rule) =>
    rule.selectors.some(describesNavItem) && rule.body.includes('outline-offset: -2px'));
  if (ringRule === undefined) return null;
  const own = ringRule.selectors.filter(describesNavItem);
  const rivals = [...new Set(rules
    .filter((rule) => rule !== ringRule)
    .flatMap((rule) => rule.selectors)
    .filter((selector) => selector.includes(':focus-visible') && couldFocusSettingsNavItem(selector)))];
  const losing = rivals.filter((rival) => own.every((selector) =>
    !specificityAtLeast(selectorSpecificity(selector), selectorSpecificity(rival))));
  return {
    ring: own.join(', '),
    inset: ringRule.body.includes('outline: 2px solid var(--ring);') &&
      ringRule.body.includes('outline-offset: -2px;'),
    rivals,
    losing,
  };
}

function selectorSpecificity(selector: string): [number, number, number] {
  const acc: [number, number, number] = [0, 0, 0];
  const heaviest = (group: string): [number, number, number] => splitTopLevel(group, ',')
    .map((part) => selectorSpecificity(part))
    .reduce((best, next) => (specificityAtLeast(next, best) ? next : best), [0, 0, 0]);
  const rest = selector.replace(/:is\(([^()]*)\)/g, (_whole, group: string) => {
    const best = heaviest(group);
    acc[0] += best[0];
    acc[1] += best[1];
    acc[2] += best[2];
    return ' ';
  });
  const count = (re: RegExp): number => rest.match(re)?.length ?? 0;
  return [
    acc[0] + count(/#/g),
    acc[1] + count(/\./g) + count(/\[[^\]]*\]/g) + count(/:(?!:)[a-z-]+(?!\()/g),
    acc[2] + count(/(?:^|[\s>+~])[a-z][a-z0-9-]*(?![\w(-])/g) + count(/::[a-z-]+/g),
  ];
}

function specificityAtLeast(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
}

const GENERIC_FOCUS_RING =
  ':is(html[data-theme="dark"], html[data-theme="light"]) :is(button, input, summary):focus-visible';
const HEAVIER_THEMED_RING =
  ':is(html[data-theme="dark"], html[data-theme="light"]) .settings-dialog :is(button, input):focus-visible';

{
  const table: ReadonlyArray<readonly [string, [number, number, number]]> = [
    ['button:active', [0, 1, 1]],
    ['#panel-resizer:focus-visible', [1, 1, 0]],
    ['.settings-nav-item:focus-visible', [0, 2, 0]],
    ['.settings-dialog .settings-nav-item:focus-visible', [0, 3, 0]],
    [GENERIC_FOCUS_RING, [0, 2, 2]],
    [HEAVIER_THEMED_RING, [0, 3, 2]],
  ];
  const wrong = table.filter(([selector, want]) =>
    selectorSpecificity(selector).join(',') !== want.join(','));
  check('the specificity counter reproduces the exact weights of the sheet selectors it compares',
    wrong.length === 0 && table.length === 6,
    `wrong=${JSON.stringify(wrong.map(([s]) => [s, selectorSpecificity(s)]))}`);
}

const SCOPED_RING = '.settings-dialog .settings-nav-item:focus-visible';
const UNSCOPED_RING = '.settings-nav-item:focus-visible';

{
  const verdict = navRingVerdict(css);
  check('the rail focus ring is inset and outranks every themed focus rule that can match a rail tab',
    verdict !== null && verdict.inset && verdict.rivals.length > 0 && verdict.losing.length === 0 &&
    dialogCss.includes(verdict.ring),
    `ring=${JSON.stringify(verdict?.ring ?? null)}, inset=${verdict?.inset}, ` +
    `rivals=${JSON.stringify(verdict?.rivals ?? [])}, losing=${JSON.stringify(verdict?.losing ?? [])}`);
}

{
  const unscoped = css.replaceAll(SCOPED_RING, UNSCOPED_RING);
  const mutated = navRingVerdict(unscoped);
  const real = navRingVerdict(css);
  check('control: the unscoped rail ring loses the cascade, so the ancestor scope is load-bearing',
    unscoped !== css && mutated !== null && mutated.losing.length > 0 &&
    real !== null && real.losing.length === 0,
    `losing=${JSON.stringify(mutated?.losing ?? [])}, realLosing=${JSON.stringify(real?.losing ?? [])}`);
}

{
  const injected = `${css}\n${HEAVIER_THEMED_RING} { outline: 2px solid var(--ring); outline-offset: 1px; }\n`;
  const verdict = navRingVerdict(injected);
  const real = navRingVerdict(css);
  check('control: a heavier themed ring added to the sheet is found to outrank the rail ring',
    verdict !== null && verdict.losing.includes(HEAVIER_THEMED_RING) &&
    real !== null && real.losing.length === 0,
    `losing=${JSON.stringify(verdict?.losing ?? [])}`);
}

{
  const idRing = `#${NAV_ITEM_IDS[0]}:focus-visible`;
  const verdict = navRingVerdict(`${css}\n${idRing} { outline: 2px solid var(--ring); outline-offset: 1px; }\n`);
  const real = navRingVerdict(css);
  check('control: an id ring on a nav tab is found to outrank the rail rule while other ids stay out',
    NAV_ITEM_IDS.length === SETTINGS_SECTIONS.length && verdict !== null &&
    verdict.losing.includes(idRing) && real !== null && !real.rivals.includes('#panel-resizer:focus-visible'),
    `losing=${JSON.stringify(verdict?.losing ?? [])}, ids=${JSON.stringify(NAV_ITEM_IDS)}`);
}

{
  const navWidthMirrored = (block: string): boolean => block.includes(`--settings-nav-w: ${SETTINGS_NAV_WIDTH}px;`);
  const mutated = dialogCss.replace(`--settings-nav-w: ${SETTINGS_NAV_WIDTH}px;`, '--settings-nav-w: 160px;');
  check('control: a nav width the sheet does not mirror from the constant fails the same predicate',
    mutated !== dialogCss && SETTINGS_NAV_WIDTH === 152 &&
    !navWidthMirrored(mutated) && navWidthMirrored(dialogCss),
    `constant=${SETTINGS_NAV_WIDTH}, mutated=${navWidthMirrored(mutated)}, real=${navWidthMirrored(dialogCss)}`);
}

const ROW_COLUMNS = `minmax(${SETTINGS_ROW_LABEL_MIN}px, max-content) minmax(0, 1fr)`;
const ROW_TRANSITION =
  'transition: background-color var(--motion-fast) var(--motion-ease), ' +
  'color var(--motion-fast) var(--motion-ease), box-shadow var(--motion-fast) var(--motion-ease);';
const ROW_ACTION_RING = '.settings-dialog .settings-row--action:focus-visible';
const UNSCOPED_ROW_ACTION_RING = '.settings-row--action:focus-visible';

const ROW_CSS_NEEDLES: readonly string[] = [
  `grid-template-columns: ${ROW_COLUMNS};`,
  `gap: ${SETTINGS_ROW_GAP}px;`,
  'align-items: center;',
  `min-height: ${SETTINGS_ROW_HEIGHT}px;`,
  `padding: ${SETTINGS_ROW_PADDING_Y}px 8px;`,
  'border-radius: calc(var(--radius) - 2px);',
  'width: 100%;',
  'font: inherit;',
  'text-align: left;',
  'background: var(--muted); color: var(--foreground);',
  '.settings-row--action:hover { background: var(--muted); color: var(--foreground); }',
  `${ROW_ACTION_RING} { outline: 2px solid var(--ring); outline-offset: -2px; }`,
  '.settings-row-hint { justify-self: end; color: var(--muted-foreground); }',
  'justify-self: start;',
  '.settings-toggle input { margin: 0; accent-color: var(--primary); }',
];

function rowGridMirrors(block: string): boolean {
  const rule = ruleBlock(block, '.settings-row {');
  return rule.includes(`grid-template-columns: ${ROW_COLUMNS};`) &&
    effectiveGaps(rule).column === SETTINGS_ROW_GAP &&
    rule.includes('align-items: center;');
}

function actionRowRule(block: string): string {
  return ruleBlock(block, '.settings-row--action {');
}

const ROW_LABEL_RULE = '.settings-row-label {';

function declarationsIn(rule: string): Map<string, string> {
  const declarations = new Map<string, string>();
  const open = rule.indexOf('{');
  const close = rule.lastIndexOf('}');
  const body = open >= 0 ? rule.slice(open + 1, close > open ? close : undefined) : '';
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return declarations;
}

function labelRuleWith(block: string, from: string, to: string): string {
  const rule = ruleBlock(block, ROW_LABEL_RULE);
  return rule.length > 0 ? block.replace(rule, rule.replace(from, to)) : block;
}

function labelAffordsRowClick(block: string): boolean {
  const label = declarationsIn(ruleBlock(block, ROW_LABEL_RULE));
  const row = declarationsIn(ruleBlock(block, '.settings-row {'));
  return label.get('align-self') === 'stretch' &&
    label.get('cursor') === 'pointer' &&
    label.get('display') === 'flex' &&
    label.get('align-items') === 'center' &&
    label.get('min-width') === '0' &&
    !row.has('height');
}

{
  check('the row label stretches over the whole 28 px row as a pointer target, and the row box stays min-height-owned',
    labelAffordsRowClick(dialogCss),
    `label=${JSON.stringify([...declarationsIn(ruleBlock(dialogCss, ROW_LABEL_RULE))])}, ` +
    `rowHeight=${declarationsIn(ruleBlock(dialogCss, '.settings-row {')).has('height')}`);
}

{
  const noCursor = labelRuleWith(dialogCss, '  cursor: pointer;', '');
  const noStretch = labelRuleWith(dialogCss, '  align-self: stretch;', '  align-self: start;');
  const fixedRow = dialogCss.replace(
    `  min-height: ${SETTINGS_ROW_HEIGHT}px;`,
    `  height: ${SETTINGS_ROW_HEIGHT}px;\n  min-height: ${SETTINGS_ROW_HEIGHT}px;`);
  check('control: a row label without the pointer cursor or the row stretch, or a row box pinned by height, fails the same predicate',
    noCursor !== dialogCss && !labelAffordsRowClick(noCursor) &&
    noStretch !== dialogCss && !labelAffordsRowClick(noStretch) &&
    fixedRow !== dialogCss && !labelAffordsRowClick(fixedRow) &&
    labelAffordsRowClick(dialogCss),
    `cursor=${labelAffordsRowClick(noCursor)}, stretch=${labelAffordsRowClick(noStretch)}, ` +
    `fixed=${labelAffordsRowClick(fixedRow)}, real=${labelAffordsRowClick(dialogCss)}`);
}

function rowActionRingWins(sheet: string): boolean {
  return sheet.includes(`${ROW_ACTION_RING} { outline: 2px solid var(--ring); outline-offset: -2px; }`) &&
    specificityAtLeast(selectorSpecificity(ROW_ACTION_RING), selectorSpecificity(GENERIC_FOCUS_RING)) &&
    !specificityAtLeast(selectorSpecificity(UNSCOPED_ROW_ACTION_RING), selectorSpecificity(GENERIC_FOCUS_RING));
}

{
  const missing = ROW_CSS_NEEDLES.filter((needle) => !dialogCss.includes(needle));
  check('the sheet lays out the appearance rows with the mirrored grid, toggle and action chrome',
    dialogCss.length > 0 && missing.length === 0 &&
    actionRowRule(dialogCss).includes(ROW_TRANSITION),
    `missing=${JSON.stringify(missing)}, transition=${actionRowRule(dialogCss).includes(ROW_TRANSITION)}, ` +
    `block=${dialogCss.length}`);
}

{
  const shipped = SETTINGS_ROW_LABEL_MIN === 104 && SETTINGS_ROW_GAP === 12;
  check('the row grid is mirrored from the exported label-column and gap constants',
    shipped && rowGridMirrors(dialogCss),
    `labelMin=${SETTINGS_ROW_LABEL_MIN}, gap=${SETTINGS_ROW_GAP}, ` +
    `rule=${JSON.stringify(ruleBlock(dialogCss, '.settings-row {'))}`);
}

{
  const driftedColumns = dialogCss.replace(ROW_COLUMNS, 'minmax(96px, max-content) minmax(0, 1fr)');
  const driftedGap = dialogCss.replace(
    `  gap: ${SETTINGS_ROW_GAP}px;\n  min-height: ${SETTINGS_ROW_HEIGHT}px;`,
    `  gap: 10px;\n  min-height: ${SETTINGS_ROW_HEIGHT}px;`);
  const columnGapOverride = dialogCss.replace(
    `  gap: ${SETTINGS_ROW_GAP}px;\n  min-height: ${SETTINGS_ROW_HEIGHT}px;`,
    `  gap: ${SETTINGS_ROW_GAP}px;\n  column-gap: 4px;\n  min-height: ${SETTINGS_ROW_HEIGHT}px;`);
  check('control: a row track list or gap the constants do not mirror, or a later column-gap override, fails the same predicate',
    driftedColumns !== dialogCss && !rowGridMirrors(driftedColumns) &&
    driftedGap !== dialogCss && !rowGridMirrors(driftedGap) &&
    columnGapOverride !== dialogCss && !rowGridMirrors(columnGapOverride) &&
    rowGridMirrors(dialogCss),
    `columns=${rowGridMirrors(driftedColumns)}, gap=${rowGridMirrors(driftedGap)}, ` +
    `columnGap=${rowGridMirrors(columnGapOverride)}, real=${rowGridMirrors(dialogCss)}`);
}

function paneBlock(block: string): string {
  return ruleBlock(block, '.settings-pane {');
}

function paneGapRebased(block: string, gap: number): string {
  const pane = paneBlock(block);
  return pane.length > 0 ? block.replace(pane, pane.replace(`gap: ${SETTINGS_PANE_GAP}px;`, `gap: ${gap}px;`)) : block;
}

function paneMatchesRowRhythm(block: string): boolean {
  const pane = paneBlock(block);
  const row = ruleBlock(block, '.settings-row {');
  return effectiveGaps(pane).row === SETTINGS_PANE_GAP &&
    row.includes(`min-height: ${SETTINGS_ROW_HEIGHT}px;`) &&
    row.includes(`padding: ${SETTINGS_ROW_PADDING_Y}px 8px;`);
}

{
  const shipped = SETTINGS_PANE_GAP === 4 && SETTINGS_ROW_HEIGHT === 28 && SETTINGS_ROW_PADDING_Y === 3;
  check('the pane gap keeps its shipped value and the sheet holds it beside the row rhythm it separates',
    shipped && paneMatchesRowRhythm(dialogCss),
    `paneGap=${SETTINGS_PANE_GAP}, rowHeight=${SETTINGS_ROW_HEIGHT}, ` +
    `rowPaddingY=${SETTINGS_ROW_PADDING_Y}, matches=${paneMatchesRowRhythm(dialogCss)}, ` +
    `pane=${JSON.stringify(paneBlock(dialogCss))}`);
}

{
  const tighter = paneGapRebased(dialogCss, 1);
  const wider = paneGapRebased(dialogCss, 8);
  const driftedRhythm = dialogCss.replace(
    `  padding: ${SETTINGS_ROW_PADDING_Y}px 8px;`,
    `  padding: ${SETTINGS_ROW_PADDING_Y + 2}px 8px;`);
  const rowGapOverride = dialogCss.replace(
    paneBlock(dialogCss),
    paneBlock(dialogCss).replace(
      `  gap: ${SETTINGS_PANE_GAP}px;`,
      `  gap: ${SETTINGS_PANE_GAP}px;\n  row-gap: 1px;`));
  const shorthandThenOverride = dialogCss.replace(
    paneBlock(dialogCss),
    paneBlock(dialogCss).replace(
      `  gap: ${SETTINGS_PANE_GAP}px;`,
      `  gap: ${SETTINGS_PANE_GAP}px 0;\n  row-gap: ${SETTINGS_PANE_GAP}px;`));
  check('control: a pane gap moved away from the row rhythm, overridden by a later row-gap, or a row whose padding moved under it, fails the same predicate',
    tighter !== dialogCss && !paneMatchesRowRhythm(tighter) &&
    wider !== dialogCss && !paneMatchesRowRhythm(wider) &&
    driftedRhythm !== dialogCss && !paneMatchesRowRhythm(driftedRhythm) &&
    rowGapOverride !== dialogCss && !paneMatchesRowRhythm(rowGapOverride) &&
    shorthandThenOverride !== dialogCss && paneMatchesRowRhythm(shorthandThenOverride) &&
    paneMatchesRowRhythm(dialogCss),
    `tighter=${paneMatchesRowRhythm(tighter)}, wider=${paneMatchesRowRhythm(wider)}, ` +
    `rhythm=${paneMatchesRowRhythm(driftedRhythm)}, override=${paneMatchesRowRhythm(rowGapOverride)}, ` +
    `shorthandThenOverride=${paneMatchesRowRhythm(shorthandThenOverride)}, real=${paneMatchesRowRhythm(dialogCss)}`);
}

{
  const noAccent = dialogCss.replace(
    '.settings-toggle input { margin: 0; accent-color: var(--primary); }', '.settings-toggle input { margin: 0; }');
  const actionRule = actionRowRule(dialogCss);
  const noTransition = dialogCss.replace(actionRule, actionRule.replace(ROW_TRANSITION, ''));
  check('control: a checkbox without the brand accent, or an action row without the motion pair, is detected by the same predicate',
    noAccent !== dialogCss && !ROW_CSS_NEEDLES.every((needle) => noAccent.includes(needle)) &&
    noTransition !== dialogCss && !actionRowRule(noTransition).includes(ROW_TRANSITION) &&
    ROW_CSS_NEEDLES.every((needle) => dialogCss.includes(needle)) &&
    actionRowRule(dialogCss).includes(ROW_TRANSITION),
    `accent=${ROW_CSS_NEEDLES.filter((n) => !noAccent.includes(n)).length}, ` +
    `transition=${actionRowRule(noTransition).includes(ROW_TRANSITION)}, ` +
    `real=${ROW_CSS_NEEDLES.filter((n) => !dialogCss.includes(n)).length}`);
}

{
  check('the row action ring is inset and outranks the generic themed button ring',
    rowActionRingWins(css),
    `ring=${selectorSpecificity(ROW_ACTION_RING).join(',')}, ` +
    `generic=${selectorSpecificity(GENERIC_FOCUS_RING).join(',')}, ` +
    `unscoped=${selectorSpecificity(UNSCOPED_ROW_ACTION_RING).join(',')}`);
}

{
  const mutated = css.replaceAll(ROW_ACTION_RING, UNSCOPED_ROW_ACTION_RING);
  check('control: the unscoped row-action ring loses the cascade, so the dialog scope is load-bearing',
    mutated !== css && !rowActionRingWins(mutated) && rowActionRingWins(css),
    `mutated=${rowActionRingWins(mutated)}, real=${rowActionRingWins(css)}`);
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

{
  const want = ['Appearance', '外观', 'Внешний вид', 'Apparence'];
  const drift = CATALOGS
    .map(([locale, lookup], index) => ({ locale, actual: lookup(SECTION_LABEL_KEY as MessageKey), want: want[index]! }))
    .filter((row) => row.actual !== row.want);
  check('all four catalogs carry the appearance section label with its pinned value',
    drift.length === 0,
    drift.length === 0 ? want.join(' | ')
      : drift.map((row) => `${row.locale}=${JSON.stringify(row.actual)}`).join('; '));
}

{
  const sectionKeys = SETTINGS_SECTIONS.map((section) => `settings.sections.${section}` as MessageKey);
  const missing = CATALOGS
    .flatMap(([locale, , dict]) => sectionKeys
      .filter((key) => !(key in dict))
      .map((key) => `${locale}:${key}`));
  check('every shipped section id has a label in every catalog',
    sectionKeys.length === SETTINGS_SECTIONS.length && missing.length === 0,
    missing.length === 0 ? `${CATALOGS.length} catalogs × ${sectionKeys.length} sections` : missing.join(', '));
}

{
  const mutated = { ...en } as Record<string, string>;
  const parity = (keys: string[]): boolean => keys.join(',') === EN_SETTINGS_KEYS.join(',');
  delete mutated[SECTION_LABEL_KEY];
  const missingKeys = Object.keys(mutated).filter((key) => key.startsWith('settings.')).sort();
  check('control: a catalog missing the appearance section label fails the same key-set predicate',
    !parity(missingKeys) && parity(EN_SETTINGS_KEYS),
    `mutatedKeys=${missingKeys.length}, realKeys=${EN_SETTINGS_KEYS.length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
