import {
  SETTINGS_DIALOG_HEIGHT,
  SETTINGS_DIALOG_ID,
  SETTINGS_DIALOG_NARROW_MARGIN,
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
const capturePanelSource = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const helpTipSource = fs.readFileSync('src/ui/helpTip.ts', 'utf8');

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
  'private toggleRow(',
  'const text = this.rowLabel(label, input.id);',
  'input.dataset.settingsKey = camelKey(key);',
  "block.dataset.settingsKey = 'about';",
  'this.shortcutBlocks()',
  "this.closeButton.setAttribute('aria-label', t('settings.close'));",
  'this.host.setDetailedLabels(',
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

const SHIPPED_SECTION_ORDER: readonly string[] = ['appearance', 'behaviour', 'shortcuts', 'developer', 'about'];

function shippedSectionOrder(sections: readonly string[]): boolean {
  return sections.length === SHIPPED_SECTION_ORDER.length &&
    sections.every((section, index) => section === SHIPPED_SECTION_ORDER[index]) &&
    !sections.includes('general');
}

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
  const roving: ReadonlyArray<readonly [string, string | null]> = [
    ['ArrowUp', 'about'], ['ArrowDown', 'behaviour'], ['Home', null], ['End', 'about'],
  ];
  const resolved = rows.filter((row) => row.next !== null).map((row) => row.key);
  check('the shipped section table is appearance, behaviour, shortcuts, developer, about and the first section roves into that ring',
    shippedSectionOrder(SETTINGS_SECTIONS) && SECTION === 'appearance' &&
    roving.every(([key, next]) => settingsSectionAfter(key, SECTION) === next) &&
    resolved.join(',') === 'ArrowUp,ArrowDown,End',
    `sections=${JSON.stringify(SETTINGS_SECTIONS)}, resolved=${JSON.stringify(resolved)}`);
}

{
  const forward = SETTINGS_SECTIONS.map((section) => settingsSectionAfter('ArrowDown', section));
  const backward = SETTINGS_SECTIONS.map((section) => settingsSectionAfter('ArrowUp', section));
  check('every roving key lands on another shipped section, wraps at either end and never throws',
    forward.join(',') === 'behaviour,shortcuts,developer,about,appearance' &&
    backward.join(',') === 'about,appearance,behaviour,shortcuts,developer' &&
    settingsSectionAfter('Home', 'appearance') === null &&
    settingsSectionAfter('End', 'about') === null &&
    settingsSectionAfter('', 'about') === null &&
    [...forward, ...backward].every((next) => next !== null && SETTINGS_SECTIONS.includes(next)),
    `forward=${JSON.stringify(forward)}, backward=${JSON.stringify(backward)}`);
}

{
  const renested = ['appearance', 'general'];
  const swapped = ['appearance', 'developer', 'behaviour', 'shortcuts', 'about'];
  check('control: a re-nested general section or two sections out of order fails the same order predicate',
    !shippedSectionOrder(renested) && !shippedSectionOrder(swapped) && shippedSectionOrder(SETTINGS_SECTIONS),
    `renested=${shippedSectionOrder(renested)}, swapped=${shippedSectionOrder(swapped)}, ` +
    `real=${shippedSectionOrder(SETTINGS_SECTIONS)}`);
}

{
  const dropped = [...SHIPPED_SECTION_ORDER].filter((section) => section !== 'behaviour');
  const renamed = ['appearance', 'behaviour', 'shortcuts', 'developer', 'general'];
  check('control: a dropped section or a renamed last section fails the same order predicate',
    !shippedSectionOrder(dropped) && !shippedSectionOrder(renamed) && shippedSectionOrder(SETTINGS_SECTIONS),
    `dropped=${shippedSectionOrder(dropped)}, renamed=${shippedSectionOrder(renamed)}`);
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
  'private toggleRow(',
  'key: string,',
  'label: MessageKey,',
  'checked: boolean,',
  'onChange: (on: boolean) => void,',
  "row.className = 'settings-row';",
  "toggle.className = 'settings-toggle';",
  "input.type = 'checkbox';",
  'input.id = `settings-${key}`;',
  'input.dataset.settingsKey = camelKey(key);',
  'const text = this.rowLabel(label, input.id);',
  'text.id = `settings-row-${key}`;',
  "input.setAttribute('aria-labelledby', text.id);",
  'input.checked = checked;',
  "input.addEventListener('change', () => onChange(input.checked));",
  'toggle.appendChild(input);',
  'row.append(text, toggle);',
];

interface ToggleRow {
  row: string;
  kebab: string;
  label: MessageKey;
  getter: string;
  field: string;
  setter: string;
}

const TOGGLE_ROWS: readonly ToggleRow[] = [
  { row: 'labelsRow', kebab: 'detailed-labels', label: 'settings.detailedLabels', getter: 'detailedLabels', field: 'detailedLabels', setter: 'setDetailedLabels' },
  { row: 'compactRowsRow', kebab: 'compact-rows', label: 'settings.compactRows', getter: 'compactRows', field: 'compactRows', setter: 'setCompactRows' },
  { row: 'hideIdleRow', kebab: 'hide-idle', label: 'settings.hideIdle', getter: 'hideIdle', field: 'hideIdleChannels', setter: 'setHideIdle' },
  { row: 'wheelZoomsRow', kebab: 'wheel-zooms', label: 'settings.wheelZooms', getter: 'wheelZooms', field: 'wheelZooms', setter: 'setWheelZooms' },
  { row: 'developerToolsRow', kebab: 'developer-tools', label: 'settings.developerTools', getter: 'developerTools', field: 'developerTools', setter: 'setDeveloperTools' },
];

const REFERENCE_NEEDLES: readonly string[] = [
  'for (const group of referenceGroups()) {',
  'this.groupTitle(shortcutGroupLabel(group))',
  "this.groupTitle(t('shortcuts.mouse'))",
  'this.shortcutList(shortcutsIn(group).map((entry) => this.keyRow(',
  'shortcutActionText(entry),',
  "entry.chords.map((chord) => formatChord(chord)).join(' / '),",
  '`shortcut:${entry.id}`',
  'this.shortcutList(referenceGestures(this.host.wheelZooms()).map((entry, index) =>',
  'this.keyRow(shortcutActionText(entry), gestureNotation(entry), `gesture:${index}`)',
  "list.className = 'shortcuts-list';",
  "row.className = 'shortcuts-row';",
  "action.className = 'shortcuts-action';",
  "chord.className = 'shortcuts-key';",
  'row.dataset.settingsKey = key;',
  'row.tabIndex = -1;',
];

const PANE_CASES: ReadonlyArray<readonly [string, string]> = [
  ['appearance', 'return [this.labelsRow(), this.compactRowsRow(), this.hideIdleRow()];'],
  ['behaviour', 'return [this.wheelZoomsRow()];'],
  ['shortcuts', 'return this.shortcutBlocks();'],
  ['developer', 'return [this.developerToolsRow(), this.clearCacheRow()];'],
  ['about', 'return [this.aboutBlock()];'],
];

function paneComposition(source: string): boolean {
  const body = methodBody(source, 'private paneContent(section: SettingsSectionId): HTMLElement[] {');
  if (!body.includes('    switch (section) {')) return false;
  const cases = body.match(/case '/g)?.length ?? 0;
  let cursor = 0;
  const ordered = PANE_CASES.every(([section, rows]) => {
    const caseAt = body.indexOf(`case '${section}':`, cursor);
    const rowsAt = caseAt >= 0 ? body.indexOf(rows, caseAt) : -1;
    if (caseAt >= 0) cursor = rowsAt >= 0 ? rowsAt + rows.length : caseAt;
    return caseAt >= 0 && rowsAt > caseAt;
  });
  return ordered && cases === PANE_CASES.length &&
    !body.includes('settings-item') && !body.includes('new SettingsMenu');
}

{
  check('the appearance pane is the three display toggles in order, the behaviour pane is the wheel row, the shortcuts pane is the reference, the developer pane is the console toggle then the saved-data action and About holds its own block',
    SETTINGS_SECTIONS.join(',') === PANE_CASES.map(([section]) => section).join(',') &&
    paneComposition(dialogSource),
    `ok=${paneComposition(dialogSource)}, ` +
    `body=${JSON.stringify(methodBody(dialogSource, 'private paneContent(section: SettingsSectionId): HTMLElement[] {').replace(/\s+/g, ' '))}`);
}

{
  const appearanceRows = '        return [this.labelsRow(), this.compactRowsRow(), this.hideIdleRow()];';
  const dropped = dialogSource.replace(appearanceRows,
    '        return [this.labelsRow(), this.hideIdleRow()];');
  const swapped = dialogSource.replace(appearanceRows,
    '        return [this.labelsRow(), this.hideIdleRow(), this.compactRowsRow()];');
  const wheelLeft = dialogSource.replace(appearanceRows,
    '        return [this.labelsRow(), this.wheelZoomsRow(), this.compactRowsRow(), this.hideIdleRow()];');
  const duplicated = dialogSource.replace(appearanceRows,
    '        return [this.labelsRow(), this.compactRowsRow(), this.compactRowsRow(), this.hideIdleRow()];');
  const behaviourDropped = dialogSource.replace(
    "      case 'behaviour':\n        return [this.wheelZoomsRow()];\n",
    '');
  const merged = dialogSource.replace(
    "      case 'developer':\n        return [this.developerToolsRow(), this.clearCacheRow()];\n      case 'about':\n        return [this.aboutBlock()];",
    "      case 'developer':\n        return [this.aboutBlock()];\n      case 'about':\n        return [this.aboutBlock()];");
  const missingCase = dialogSource.replace(
    "      case 'about':\n        return [this.aboutBlock()];\n",
    '');
  const generalAgain = dialogSource.replace(
    "      case 'shortcuts':\n        return this.shortcutBlocks();",
    "      case 'shortcuts':\n        return this.shortcutBlocks();\n      case 'general':\n        return [this.developerToolsRow(), this.clearCacheRow(), this.aboutBlock()];");
  const actionDropped = dialogSource.replace(
    '        return [this.developerToolsRow(), this.clearCacheRow()];',
    '        return [this.developerToolsRow()];');
  const actionFirst = dialogSource.replace(
    '        return [this.developerToolsRow(), this.clearCacheRow()];',
    '        return [this.clearCacheRow(), this.developerToolsRow()];');
  check('control: dropping or reordering an appearance row, leaving the wheel row in Appearance, duplicating a pane row, dropping the behaviour case, merging two sections, dropping a case, re-nesting a general case, dropping the saved-data action or leading the developer pane with it fails the same composition predicate',
    dropped !== dialogSource && !paneComposition(dropped) &&
    swapped !== dialogSource && !paneComposition(swapped) &&
    wheelLeft !== dialogSource && !paneComposition(wheelLeft) &&
    duplicated !== dialogSource && !paneComposition(duplicated) &&
    behaviourDropped !== dialogSource && !paneComposition(behaviourDropped) &&
    merged !== dialogSource && !paneComposition(merged) &&
    missingCase !== dialogSource && !paneComposition(missingCase) &&
    generalAgain !== dialogSource && !paneComposition(generalAgain) &&
    actionDropped !== dialogSource && !paneComposition(actionDropped) &&
    actionFirst !== dialogSource && !paneComposition(actionFirst) &&
    paneComposition(dialogSource),
    `dropped=${paneComposition(dropped)}, swapped=${paneComposition(swapped)}, ` +
    `wheelLeft=${paneComposition(wheelLeft)}, duplicated=${paneComposition(duplicated)}, ` +
    `behaviourDropped=${paneComposition(behaviourDropped)}, ` +
    `merged=${paneComposition(merged)}, missing=${paneComposition(missingCase)}, ` +
    `general=${paneComposition(generalAgain)}, actionDropped=${paneComposition(actionDropped)}, ` +
    `actionFirst=${paneComposition(actionFirst)}, real=${paneComposition(dialogSource)}`);
}

{
  const missing = TOGGLE_NEEDLES.filter((needle) => !dialogSource.includes(needle));
  check('the shared toggle builder is a row-level checkbox labelled by its row label and writing only through its change callback',
    missing.length === 0,
    `missing=${JSON.stringify(missing)}`);
}

function rowLabelBody(source: string): string {
  return methodBody(source, 'private rowLabel(key: MessageKey, controlId?: string): HTMLElement {');
}

function toggleRowBody(source: string): string {
  return methodBody(source, 'private toggleRow(');
}

function rowLabelBindsControl(source: string): boolean {
  const body = rowLabelBody(source);
  const labelAt = body.indexOf("const label = document.createElement('label');");
  const forAt = body.indexOf('label.htmlFor = controlId;');
  const toggleBody = toggleRowBody(source);
  const idAt = toggleBody.indexOf('input.id = `settings-${key}`;');
  const callAt = toggleBody.indexOf('const text = this.rowLabel(label, input.id);');
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
    '    const text = this.rowLabel(label, input.id);\n',
    '    const text = this.rowLabel(label);\n');
  const lateId = dialogSource.replace(
    '    input.id = `settings-${key}`;\n    input.dataset.settingsKey = camelKey(key);\n    const text = this.rowLabel(label, input.id);\n',
    '    input.dataset.settingsKey = camelKey(key);\n    const text = this.rowLabel(label, input.id);\n    input.id = `settings-${key}`;\n');
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
  const noState = dialogSource.replace('    input.checked = checked;\n', '');
  const noName = dialogSource.replace("    input.setAttribute('aria-labelledby', text.id);\n", '');
  const noKey = dialogSource.replace('    input.dataset.settingsKey = camelKey(key);\n', '    input.dataset.settingsKey = key;\n');
  const noWrap = dialogSource.replace('    toggle.appendChild(input);\n', '    row.append(input);\n');
  const cachedWrite = dialogSource.replace(
    '    input.addEventListener(\'change\', () => onChange(input.checked));\n',
    '    input.addEventListener(\'change\', () => {});\n');
  check('control: a cached toggle state, an unnamed checkbox, a kebab-only key, an unlabelled row or a change handler that skips the callback is detected by the same predicate',
    noState !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noState.includes(needle)) &&
    noName !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noName.includes(needle)) &&
    noKey !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noKey.includes(needle)) &&
    noWrap !== dialogSource && !TOGGLE_NEEDLES.every((needle) => noWrap.includes(needle)) &&
    cachedWrite !== dialogSource && !TOGGLE_NEEDLES.every((needle) => cachedWrite.includes(needle)) &&
    TOGGLE_NEEDLES.every((needle) => dialogSource.includes(needle)),
    `noState=${TOGGLE_NEEDLES.filter((n) => !noState.includes(n)).length}, ` +
    `noName=${TOGGLE_NEEDLES.filter((n) => !noName.includes(n)).length}, ` +
    `noKey=${TOGGLE_NEEDLES.filter((n) => !noKey.includes(n)).length}, ` +
    `noWrap=${TOGGLE_NEEDLES.filter((n) => !noWrap.includes(n)).length}, ` +
    `cachedWrite=${TOGGLE_NEEDLES.filter((n) => !cachedWrite.includes(n)).length}, ` +
    `real=${TOGGLE_NEEDLES.filter((n) => !dialogSource.includes(n)).length}`);
}

{
  const body = shortcutBlocksBody(dialogSource);
  const missing = REFERENCE_NEEDLES.filter((needle) => !dialogSource.includes(needle));
  check('the shortcuts pane builds the keyboard list and the gesture list, every row keyed for the locale rebuild',
    body.length > 0 && missing.length === 0,
    `missing=${JSON.stringify(missing)}, body=${body.length}`);
}

const MOUSE_BLOCK = [
  "    blocks.push(this.groupTitle(t('shortcuts.mouse')));\n",
  '    blocks.push(this.shortcutList(referenceGestures(this.host.wheelZooms()).map((entry, index) =>\n',
  '      this.keyRow(shortcutActionText(entry), gestureNotation(entry), `gesture:${index}`))));\n',
].join('');

function shortcutGroupBlocks(source: string): boolean {
  const body = shortcutBlocksBody(source);
  if (body.length === 0) return false;
  const loopAt = body.indexOf('for (const group of referenceGroups()) {');
  const labelAt = body.indexOf('this.groupTitle(shortcutGroupLabel(group))', loopAt);
  const rowsAt = body.indexOf('this.shortcutList(shortcutsIn(group).map((entry) => this.keyRow(', loopAt);
  const mouseAt = body.indexOf("this.groupTitle(t('shortcuts.mouse'))", loopAt);
  const gesturesAt = body.indexOf('referenceGestures(this.host.wheelZooms())', mouseAt);
  const headings = body.match(/this\.groupTitle\(/g)?.length ?? 0;
  return loopAt >= 0 && labelAt > loopAt && rowsAt > labelAt && mouseAt > rowsAt &&
    gesturesAt > mouseAt && headings === 2 &&
    !body.includes('SHORTCUTS.map(') && !body.includes("shortcutsIn('");
}

{
  check('the keyboard reference is one heading plus one list per catalog group, and the gesture block follows them',
    shortcutGroupBlocks(dialogSource), `body=${JSON.stringify(shortcutBlocksBody(dialogSource).replace(/\s+/g, ' '))}`);
}

{
  const hardCoded = dialogSource.replace(
    'for (const group of referenceGroups()) {',
    "for (const group of ['view', 'file', 'navigation']) {");
  const unfiltered = dialogSource.replace(
    'for (const group of referenceGroups()) {',
    'for (const group of SHORTCUT_GROUPS) {');
  const duplicated = dialogSource.replace(MOUSE_BLOCK,
    `${MOUSE_BLOCK}    blocks.push(this.groupTitle(shortcutGroupLabel('view')));\n`);
  const mouseFirst = dialogSource.replace(MOUSE_BLOCK, '').replace(
    '    const blocks: HTMLElement[] = [];\n',
    `    const blocks: HTMLElement[] = [];\n${MOUSE_BLOCK}`);
  check('control: a hard-coded group order, an unfiltered group list, a second copy of a group or a gesture block ahead of the keyboard list fails the same predicate',
    hardCoded !== dialogSource && !shortcutGroupBlocks(hardCoded) &&
    unfiltered !== dialogSource && !shortcutGroupBlocks(unfiltered) &&
    duplicated !== dialogSource && !shortcutGroupBlocks(duplicated) &&
    mouseFirst !== dialogSource && !shortcutGroupBlocks(mouseFirst) &&
    shortcutGroupBlocks(dialogSource),
    `hardCoded=${shortcutGroupBlocks(hardCoded)}, unfiltered=${shortcutGroupBlocks(unfiltered)}, ` +
    `duplicated=${shortcutGroupBlocks(duplicated)}, mouseFirst=${shortcutGroupBlocks(mouseFirst)}, ` +
    `real=${shortcutGroupBlocks(dialogSource)}`);
}

{
  const handWritten = dialogSource.replace(
    'this.shortcutList(shortcutsIn(group).map((entry) => this.keyRow(',
    "this.shortcutList([{ labels: [], notation: 'F' }].map((entry) => this.keyRow(");
  const frozenZooms = dialogSource.replace(
    'referenceGestures(this.host.wheelZooms())',
    'referenceGestures(false)');
  const unkeyed = dialogSource.replace('    row.dataset.settingsKey = key;\n', '');
  const parallelClass = dialogSource.replace(
    "row.className = 'shortcuts-row';",
    "row.className = 'settings-key-row';");
  const intact = (source: string): boolean =>
    shortcutBlocksBody(source).length > 0 &&
    REFERENCE_NEEDLES.every((needle) => source.includes(needle));
  check('control: a hand-written key list, a frozen wheel-zoom capture, an unkeyed row or a parallel row class fails the same predicate',
    handWritten !== dialogSource && !intact(handWritten) &&
    frozenZooms !== dialogSource && !intact(frozenZooms) &&
    unkeyed !== dialogSource && !intact(unkeyed) &&
    parallelClass !== dialogSource && !intact(parallelClass) && intact(dialogSource),
    `handWritten=${intact(handWritten)}, frozen=${intact(frozenZooms)}, ` +
    `unkeyed=${intact(unkeyed)}, parallel=${intact(parallelClass)}, real=${intact(dialogSource)}`);
}

function paneOpensNoDialog(source: string): boolean {
  const pane = methodBody(source, 'private paneContent(section: SettingsSectionId): HTMLElement[] {');
  const blocks = shortcutBlocksBody(source);
  const build = `${pane}${blocks}`;
  return pane.length > 0 && blocks.length > 0 &&
    !build.includes('showModal') && !build.includes("createElement('dialog')") &&
    (source.match(/showModal\(\)/g)?.length ?? 0) === 1;
}

{
  const extraModal = dialogSource.replace(
    '  private shortcutBlocks(): HTMLElement[] {',
    '  private shortcutBlocks(): HTMLElement[] {\n    this.dialog.showModal();');
  const secondDialog = dialogSource.replace(
    '  private shortcutBlocks(): HTMLElement[] {',
    "  private shortcutBlocks(): HTMLElement[] {\n    document.body.appendChild(document.createElement('dialog'));");
  check('the reference pane builds elements only, so the window remains the one dialog the settings reference can open',
    paneOpensNoDialog(dialogSource) &&
    extraModal !== dialogSource && !paneOpensNoDialog(extraModal) &&
    secondDialog !== dialogSource && !paneOpensNoDialog(secondDialog),
    `real=${paneOpensNoDialog(dialogSource)}, modal=${paneOpensNoDialog(extraModal)}, ` +
    `dialog=${paneOpensNoDialog(secondDialog)}`);
}

const ABOUT_BLOCK_NEEDLES: readonly string[] = [
  "block.className = 'settings-about';",
  "block.dataset.settingsKey = 'about';",
  'const view = aboutView();',
  "this.aboutLine('about-name', `${view.name} — ${view.subtitle}`, false),",
  "this.aboutLine('about-meta', view.version, false),",
  "this.aboutLine('about-meta', view.license),",
  "this.aboutLine('about-meta', view.copyright, false),",
  'this.aboutLinks(view.links),',
];

const ABOUT_LINK_NEEDLES: readonly string[] = [
  "list.className = 'about-links';",
  "anchor.target = '_blank';",
  "anchor.rel = 'noopener noreferrer';",
  'anchor.textContent = link.label;',
];

function aboutBlockBody(source: string): string {
  return methodBody(source, 'private aboutBlock(): HTMLElement {');
}

function aboutLinksBody(source: string): string {
  return methodBody(source, 'private aboutLinks(links: readonly AboutLink[]): HTMLUListElement {');
}

function shortcutBlocksBody(source: string): string {
  return methodBody(source, 'private shortcutBlocks(): HTMLElement[] {');
}

function aboutPaneIntact(source: string): boolean {
  return ABOUT_BLOCK_NEEDLES.every((needle) => aboutBlockBody(source).includes(needle)) &&
    ABOUT_LINK_NEEDLES.every((needle) => aboutLinksBody(source).includes(needle)) &&
    !aboutLinksBody(source).includes('innerHTML') &&
    !source.includes('openAbout') && !source.includes('settings-row--action');
}

{
  const body = aboutBlockBody(dialogSource);
  const links = aboutLinksBody(dialogSource);
  const missing = ABOUT_BLOCK_NEEDLES.filter((needle) => !body.includes(needle));
  check('the About pane block prints the name line, version, licence and copyright from the view, appends the link list and is keyed about',
    body.length > 0 && missing.length === 0 && aboutPaneIntact(dialogSource) &&
    links.length > 0,
    `missing=${JSON.stringify(missing)}, body=${JSON.stringify(body.replace(/\s+/g, ' '))}`);
}

{
  const plainName = dialogSource.replace("      this.aboutLine('about-name',", "      this.aboutLine('about-meta',");
  const noLinks = dialogSource.replace('      this.aboutLinks(view.links),\n', '');
  const bare = dialogSource.replace("      anchor.rel = 'noopener noreferrer';\n", '');
  const unlabelled = dialogSource.replace('      anchor.textContent = link.label;\n', '');
  const opened = dialogSource.replace(
    '  clearCache(): void;\n}',
    '  clearCache(): void;\n  openAbout(invoker: HTMLElement): void;\n}');
  check('control: a mislabelled name line, a dropped link list, a bare anchor, a link without text or a reintroduced opener bridge fails the same pane predicate',
    plainName !== dialogSource && !aboutPaneIntact(plainName) &&
    noLinks !== dialogSource && !aboutPaneIntact(noLinks) &&
    bare !== dialogSource && !aboutPaneIntact(bare) &&
    unlabelled !== dialogSource && !aboutPaneIntact(unlabelled) &&
    opened !== dialogSource && !aboutPaneIntact(opened) &&
    aboutPaneIntact(dialogSource),
    `plain=${aboutPaneIntact(plainName)}, links=${aboutPaneIntact(noLinks)}, ` +
    `bare=${aboutPaneIntact(bare)}, unlabelled=${aboutPaneIntact(unlabelled)}, ` +
    `opened=${aboutPaneIntact(opened)}, real=${aboutPaneIntact(dialogSource)}`);
}

const camelOf = (kebab: string): string => kebab
  .split('-')
  .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
  .join('');

{
  const wrong = TOGGLE_ROWS.filter((entry) => camelOf(entry.kebab) !== entry.getter);
  check('every toggle row spells one key twice: a kebab id and its camelCase settings key',
    TOGGLE_ROWS.length === 5 && wrong.length === 0 &&
    dialogSource.includes('function camelKey(kebab: string): string {') &&
    dialogSource.includes('return kebab.replace(/-([a-z0-9])/g, (_match: string, letter: string) => letter.toUpperCase());'),
    `rows=${TOGGLE_ROWS.length}, wrong=${JSON.stringify(wrong.map((entry) => entry.kebab))}`);
}

function rowWiredToHost(source: string, entry: ToggleRow): boolean {
  const body = methodBody(source, `private ${entry.row}(): HTMLDivElement {`);
  return body.includes(
    `this.toggleRow('${entry.kebab}', '${entry.label}', this.host.${entry.getter}(),`) &&
    body.includes(`this.host.${entry.setter}(on)`);
}

{
  const broken = TOGGLE_ROWS.filter((entry) => !rowWiredToHost(dialogSource, entry))
    .map((entry) => entry.row);
  check('each toggle row renders from its own host state and writes back through its own host pair',
    broken.length === 0 && TOGGLE_ROWS.length === 5,
    `broken=${JSON.stringify(broken)}`);
}

{
  const swappedGetter = dialogSource.replace(
    "this.toggleRow('wheel-zooms', 'settings.wheelZooms', this.host.wheelZooms(),",
    "this.toggleRow('wheel-zooms', 'settings.wheelZooms', this.host.compactRows(),");
  const droppedSetter = dialogSource.replace(
    "      (on) => this.host.setDeveloperTools(on), 'settings.developerToolsWhere');",
    "      (on) => void on, 'settings.developerToolsWhere');");
  const wrongLabel = dialogSource.replace(
    "this.toggleRow('hide-idle', 'settings.hideIdle', this.host.hideIdle(),",
    "this.toggleRow('hide-idle', 'settings.compactRows', this.host.hideIdle(),");
  const wired = (source: string): boolean => TOGGLE_ROWS.every((entry) => rowWiredToHost(source, entry));
  check('control: reading another row\'s state, dropping the write-back or reusing another row\'s label fails the same wiring predicate',
    swappedGetter !== dialogSource && !wired(swappedGetter) &&
    droppedSetter !== dialogSource && !wired(droppedSetter) &&
    wrongLabel !== dialogSource && !wired(wrongLabel) &&
    wired(dialogSource),
    `getter=${wired(swappedGetter)}, setter=${wired(droppedSetter)}, ` +
    `label=${wired(wrongLabel)}, real=${wired(dialogSource)}`);
}

{
  const missing = TOGGLE_ROWS.flatMap((entry) => [
    ...(dialogSource.includes(`${entry.getter}(): boolean;`) ? [] : [`host:${entry.getter}`]),
    ...(dialogSource.includes(`${entry.setter}(on: boolean): void;`) ? [] : [`host:${entry.setter}`]),
    ...(appSource.includes(`${entry.getter}: () => this.${entry.field},`) ? [] : [`app:${entry.getter}`]),
    ...(appSource.includes(`${entry.setter}: (on) => this.${entry.setter}(on),`) ? [] : [`app:${entry.setter}`]),
  ]);
  check('the host contract and the App host literal carry one read/write pair per toggle',
    missing.length === 0,
    `missing=${JSON.stringify(missing)}`);
}

{
  const droppedPair = dialogSource.replace('  setWheelZooms(on: boolean): void;\n', '');
  const wrongField = appSource.replace('      hideIdle: () => this.hideIdleChannels,', '      hideIdle: () => this.developerTools,');
  const pairs = (source: string): boolean => TOGGLE_ROWS.every((entry) =>
    source.includes(`${entry.getter}(): boolean;`) &&
    source.includes(`${entry.setter}(on: boolean): void;`));
  const appPairs = (source: string): boolean => TOGGLE_ROWS.every((entry) =>
    source.includes(`${entry.getter}: () => this.${entry.field},`) &&
    source.includes(`${entry.setter}: (on) => this.${entry.setter}(on),`));
  check('control: dropping a host pair or pointing a getter at another field fails the same pair predicate',
    droppedPair !== dialogSource && !pairs(droppedPair) && pairs(dialogSource) &&
    wrongField !== appSource && !appPairs(wrongField) && appPairs(appSource),
    `dropped=${pairs(droppedPair)}, wrongField=${appPairs(wrongField)}, ` +
    `realHost=${pairs(dialogSource)}, realApp=${appPairs(appSource)}`);
}

const toggleRowCalls = (source: string): number => source.match(/this\.toggleRow\(/g)?.length ?? 0;
const aboutKeyedBlocks = (source: string): number =>
  source.match(/block\.dataset\.settingsKey = /g)?.length ?? 0;
const referenceKeyedRows = (source: string): number =>
  source.match(/row\.dataset\.settingsKey = key;/g)?.length ?? 0;
const actionKeyedControls = (source: string): number =>
  source.match(/action\.dataset\.settingsKey = /g)?.length ?? 0;

function keyedControls(source: string): number {
  return SETTINGS_SECTIONS.length + toggleRowCalls(source) + aboutKeyedBlocks(source) +
    referenceKeyedRows(source) + actionKeyedControls(source);
}

{
  const keyed = keyedControls(dialogSource);
  check('the window keys one control per tab, five toggles, the clear-cache action, the About block and the shared reference row: thirteen today',
    keyed === 13 && SETTINGS_SECTIONS.length === 5 && toggleRowCalls(dialogSource) === 5 &&
    aboutKeyedBlocks(dialogSource) === 1 && referenceKeyedRows(dialogSource) === 1 &&
    actionKeyedControls(dialogSource) === 1,
    `keyed=${keyed}, tabs=${SETTINGS_SECTIONS.length}, toggles=${toggleRowCalls(dialogSource)}, ` +
    `actions=${actionKeyedControls(dialogSource)}, about=${aboutKeyedBlocks(dialogSource)}, ` +
    `reference=${referenceKeyedRows(dialogSource)}`);
}

{
  const extraToggle = dialogSource.replace(
    "      case 'developer':\n        return [this.developerToolsRow(), this.clearCacheRow()];",
    "      case 'developer':\n        return [this.toggleRow('extra', 'settings.detailedLabels', false, () => {}), this.developerToolsRow(), this.clearCacheRow()];");
  const droppedReference = dialogSource.replace('    row.dataset.settingsKey = key;\n', '');
  const droppedAction = dialogSource.replace("    action.dataset.settingsKey = 'clear-cache';\n", '');
  check('control: a sixth toggle, a reference row without its settings key or an action without its key moves the keyed-control count',
    extraToggle !== dialogSource && keyedControls(extraToggle) === 14 &&
    droppedReference !== dialogSource && keyedControls(droppedReference) === 12 &&
    droppedAction !== dialogSource && keyedControls(droppedAction) === 12 &&
    keyedControls(dialogSource) === 13,
    `extra=${keyedControls(extraToggle)}, reference=${keyedControls(droppedReference)}, ` +
    `action=${keyedControls(droppedAction)}, real=${keyedControls(dialogSource)}`);
}

function appSetterFollows(source: string, name: string, order: readonly string[]): boolean {
  const body = methodBody(source, `private ${name}(on: boolean): void {`);
  const at = order.map((needle) => body.indexOf(needle));
  return body.length > 0 && at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1]!));
}

const SETTER_EFFECTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['setWheelZooms', ['this.wheelZooms = on;', 'this.persistWorkspace();', 'this.renderInteractionBar(true);']],
  ['setCompactRows', ['this.compactRows = on;', 'this.persistWorkspace();', 'this.relayout();']],
  ['setHideIdle', ['this.hideIdleChannels = on;', 'this.persistWorkspace();', 'this.relayout();', 'this.renderPanels();']],
  ['setDeveloperTools', ['this.developerTools = on;', 'this.persistWorkspace();', 'this.renderPanels();']],
];

const SETTER_REFRESH_CALLS: readonly string[] = [
  'this.relayout();',
  'this.renderPanels();',
  'this.renderInteractionBar();',
  'this.renderInteractionBar(true);',
  'this.renderSidebarContent();',
  'this.reflectDetailedLabels();',
];

function occurrences(body: string, needle: string): number {
  return body.split(needle).length - 1;
}

function setterEffectBound(source: string, name: string, order: readonly string[]): boolean {
  const body = methodBody(source, `private ${name}(on: boolean): void {`);
  return body.length > 0 && occurrences(body, 'this.persistWorkspace();') === 1 &&
    SETTER_REFRESH_CALLS.every((needle) =>
      occurrences(body, needle) === (order.some((entry) => entry.includes(needle)) ? 1 : 0));
}

{
  const broken = SETTER_EFFECTS.filter(([name, order]) => !appSetterFollows(appSource, name, order))
    .map(([name]) => name);
  const unbounded = SETTER_EFFECTS.filter(([name, order]) => !setterEffectBound(appSource, name, order))
    .map(([name]) => name);
  check('each App setter keeps the workspace write and the refresh upstream ran for its menu entry',
    broken.length === 0 && unbounded.length === 0 && SETTER_EFFECTS.length === 4,
    `broken=${JSON.stringify(broken)}, unbounded=${JSON.stringify(unbounded)}`);
}

{
  const noPersist = appSource.replace(
    '    this.compactRows = on;\n    this.persistWorkspace();\n',
    '    this.compactRows = on;\n');
  const swappedPanels = appSource.replace(
    '    this.relayout();\n    this.renderPanels();\n  }\n\n  private setDeveloperTools',
    '    this.renderPanels();\n    this.relayout();\n  }\n\n  private setDeveloperTools');
  const noHintRefresh = appSource.replace(
    '    this.renderInteractionBar(true);\n',
    '');
  const intact = (source: string): boolean =>
    SETTER_EFFECTS.every(([name, order]) => appSetterFollows(source, name, order));
  check('control: a setter without its workspace write, with the refresh pair reversed or without the interaction-bar refresh fails the same predicate',
    noPersist !== appSource && !intact(noPersist) &&
    swappedPanels !== appSource && !intact(swappedPanels) &&
    noHintRefresh !== appSource && !intact(noHintRefresh) &&
    intact(appSource),
    `persist=${intact(noPersist)}, panels=${intact(swappedPanels)}, ` +
    `hint=${intact(noHintRefresh)}, real=${intact(appSource)}`);
}

{
  const doubleWrite = appSource.replace(
    '    this.compactRows = on;\n    this.persistWorkspace();\n',
    '    this.compactRows = on;\n    this.persistWorkspace();\n    this.persistWorkspace();\n');
  const strayPanels = appSource.replace(
    '    this.persistWorkspace();\n    this.relayout();\n  }\n\n  private setHideIdle',
    '    this.persistWorkspace();\n    this.relayout();\n    this.renderPanels();\n  }\n\n  private setHideIdle');
  const strayHint = appSource.replace(
    '    this.persistWorkspace();\n    this.renderPanels();\n  }\n\n  private async clearCache',
    '    this.persistWorkspace();\n    this.renderInteractionBar(true);\n    this.renderPanels();\n  }\n\n  private async clearCache');
  const bound = (source: string): boolean =>
    SETTER_EFFECTS.every(([name, order]) => setterEffectBound(source, name, order));
  check('control: a duplicated workspace write or an undeclared refresh call in a setter fails the same bound',
    doubleWrite !== appSource && !bound(doubleWrite) &&
    strayPanels !== appSource && !bound(strayPanels) &&
    strayHint !== appSource && !bound(strayHint) &&
    bound(appSource),
    `double=${bound(doubleWrite)}, panels=${bound(strayPanels)}, ` +
    `hint=${bound(strayHint)}, real=${bound(appSource)}`);
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

function shortcutTogglesWindow(source: string): boolean {
  const body = methodBody(source, 'private runShortcut(');
  const at = body.indexOf("      case 'settings.open':");
  const windowCase = at < 0 ? '' : body.slice(at);
  const isOpenAt = windowCase.indexOf('if (this.settingsDialog.isOpen) {');
  const closeAt = windowCase.indexOf('this.settingsDialog.close();');
  const openAt = windowCase.indexOf('this.settingsDialog.open(this.el.settings);');
  return isOpenAt >= 0 && closeAt > isOpenAt && openAt > closeAt &&
    windowCase.includes("this.menuStack.closeOthers(null, 'outside')") &&
    windowCase.indexOf('this.channelList.closeDialog()') < openAt;
}

{
  check('the settings shortcut toggles the same window closed and open through the toolbar invoker',
    shortcutTogglesWindow(appSource),
    `ok=${shortcutTogglesWindow(appSource)}`);
}

{
  const invokerless = appSource.replace(
    '        this.settingsDialog.open(this.el.settings);',
    '        this.settingsDialog.open(null);');
  const openFirst = appSource.replace(
    "        if (this.settingsDialog.isOpen) {\n          this.settingsDialog.close();\n          return true;\n        }\n",
    '');
  check('control: a null invoker or a case that never closes is detected by the same toggle predicate',
    invokerless !== appSource && !shortcutTogglesWindow(invokerless) &&
    openFirst !== appSource && !shortcutTogglesWindow(openFirst) &&
    shortcutTogglesWindow(appSource),
    `invokerless=${shortcutTogglesWindow(invokerless)}, openFirst=${shortcutTogglesWindow(openFirst)}, ` +
    `real=${shortcutTogglesWindow(appSource)}`);
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
  const want = [
    'this.menuStack.register(this.deviceMenu);',
    'this.menuStack.register(this.languageMenu);',
    'this.menuStack.register(this.themeMenu);',
    'this.menuStack.register(this.saveMenu);',
    'this.menuStack.register(this.openMenu);',
  ];
  check('the exclusion owner holds only the five transient menus and never the settings window',
    registrations.length === want.length && registrations.join(' ') === want.join(' ') &&
    !appSource.includes('menuStack.register(this.settings'),
    `registrations=${JSON.stringify(registrations)}`);
}

{
  const start = appSource.indexOf('  private retranslate(): void {');
  const end = start >= 0 ? appSource.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? appSource.slice(start, end) : '';
  const guard = 'if (this.settingsDialog.isOpen) this.settingsDialog.renderStrings();';
  check('retranslate refreshes the window strings, which now carry the reference, only while the window is open',
    body.includes(guard) && !body.includes('shortcutsDialog'),
    `guard=${body.includes(guard)}, dialog=${body.includes('shortcutsDialog')}, body=${body.length}`);
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

const RETIRED_REFERENCE_TOKENS: readonly string[] = [
  'openShortcuts', 'shortcutsDialog', 'ShortcutsDialog', 'openAbout', 'aboutDialog',
];

function referenceInPane(settings: string, app: string): boolean {
  const pane = methodBody(settings, 'private paneContent(section: SettingsSectionId): HTMLElement[] {');
  return /case 'shortcuts':\r?\n\s*return this\.shortcutBlocks\(\);/.test(pane) &&
    RETIRED_REFERENCE_TOKENS.every((token) => !`${settings}\n${app}`.includes(token));
}

{
  check('the reference and About open inside the pane, so neither host bridge nor a second dialog survives',
    referenceInPane(dialogSource, appSource),
    `retired=${JSON.stringify(RETIRED_REFERENCE_TOKENS
      .filter((token) => `${dialogSource}\n${appSource}`.includes(token)))}, ` +
    `pane=${referenceInPane(dialogSource, appSource)}`);
}

{
  const bridge = appSource.replace(
    '      setDeveloperTools: (on) => this.setDeveloperTools(on),',
    '      setDeveloperTools: (on) => this.setDeveloperTools(on),\n      openShortcuts: (invoker) => this.settingsDialog.open(invoker),');
  const paneless = dialogSource.replace('        return this.shortcutBlocks();', '        return [];');
  check('control: a restored host bridge or a pane that no longer returns the reference blocks fails the same predicate',
    bridge !== appSource && !referenceInPane(dialogSource, bridge) &&
    paneless !== dialogSource && !referenceInPane(paneless, appSource) &&
    referenceInPane(dialogSource, appSource),
    `bridge=${referenceInPane(dialogSource, bridge)}, paneless=${referenceInPane(paneless, appSource)}, ` +
    `real=${referenceInPane(dialogSource, appSource)}`);
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

const SHORTCUT_CLASSES: readonly string[] = [
  'shortcuts-dialog', 'shortcuts-form', 'shortcuts-header', 'shortcuts-actions', 'shortcuts-close',
  'shortcuts-section', 'shortcuts-list', 'shortcuts-row', 'shortcuts-action', 'shortcuts-key',
];

const shortcutConsumers: string = ['confirmDialog', 'settingsDialog']
  .map((name) => fs.readFileSync(`src/ui/${name}.ts`, 'utf8')).join('\n');

function classRuleIn(sheet: string, name: string): boolean {
  return new RegExp(`\\.${name}(?![\\w-])`).test(sheet);
}

function shortcutClassesIntact(sheet: string, consumers: string): boolean {
  const margin = /\n\.shortcuts-section \{\n  margin: ([^;]+);/.exec(sheet)?.[1];
  return SHORTCUT_CLASSES.every((name) => classRuleIn(sheet, name) && consumers.includes(name)) &&
    margin === '4px 0';
}

{
  check('every shortcuts-* rule still has a consumer and the reference headings follow the pane gap',
    shortcutClassesIntact(css, shortcutConsumers) &&
    effectiveGaps(paneBlock(dialogCss)).row === SETTINGS_PANE_GAP,
    `orphaned=${JSON.stringify(SHORTCUT_CLASSES.filter((name) =>
      !classRuleIn(css, name) || !shortcutConsumers.includes(name)))}, ` +
    `margin=${/\n\.shortcuts-section \{\n  margin: ([^;]+);/.exec(css)?.[1]}, ` +
    `paneGap=${effectiveGaps(paneBlock(dialogCss)).row}`);
}

{
  const widened = css.replace('.shortcuts-section {\n  margin: 4px 0;', '.shortcuts-section {\n  margin: 0 0 -8px;');
  const renamed = css.replaceAll('.shortcuts-close', '.shortcuts-close-retired');
  check('control: the dialog-era margin or a rule retired while a consumer still asks for it fails the same predicate',
    widened !== css && !shortcutClassesIntact(widened, shortcutConsumers) &&
    renamed !== css && !shortcutClassesIntact(renamed, shortcutConsumers) &&
    shortcutClassesIntact(css, shortcutConsumers),
    `widened=${shortcutClassesIntact(widened, shortcutConsumers)}, ` +
    `renamed=${shortcutClassesIntact(renamed, shortcutConsumers)}, ` +
    `real=${shortcutClassesIntact(css, shortcutConsumers)}`);
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
  walk(sheet.replace(/\/\*[\s\S]*?\*\//g, ' '));
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
const ROW_CSS_NEEDLES: readonly string[] = [
  `grid-template-columns: ${ROW_COLUMNS};`,
  `gap: ${SETTINGS_ROW_GAP}px;`,
  'align-items: center;',
  `min-height: ${SETTINGS_ROW_HEIGHT}px;`,
  `padding: ${SETTINGS_ROW_PADDING_Y}px 8px;`,
  'border-radius: calc(var(--radius) - 2px);',
  'justify-self: start;',
  '.settings-toggle input { margin: 0; accent-color: var(--primary); }',
];

function rowGridMirrors(block: string): boolean {
  const rule = ruleBlock(block, '.settings-row {');
  return rule.includes(`grid-template-columns: ${ROW_COLUMNS};`) &&
    effectiveGaps(rule).column === SETTINGS_ROW_GAP &&
    rule.includes('align-items: center;');
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

{
  const missing = ROW_CSS_NEEDLES.filter((needle) => !dialogCss.includes(needle));
  check('the sheet lays out the appearance rows with the mirrored grid and toggle chrome',
    dialogCss.length > 0 && missing.length === 0,
    `missing=${JSON.stringify(missing)}, block=${dialogCss.length}`);
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
  check('control: a checkbox without the brand accent is detected by the same predicate',
    noAccent !== dialogCss && !ROW_CSS_NEEDLES.every((needle) => noAccent.includes(needle)) &&
    ROW_CSS_NEEDLES.every((needle) => dialogCss.includes(needle)),
    `accent=${ROW_CSS_NEEDLES.filter((n) => !noAccent.includes(n)).length}, ` +
    `real=${ROW_CSS_NEEDLES.filter((n) => !dialogCss.includes(n)).length}`);
}

const PANE_RING = '.settings-dialog .settings-pane:focus-visible';

function paneRingIsInset(block: string): boolean {
  const rule = ruleBlock(block, `${PANE_RING} {`);
  return rule.includes('outline: 2px solid var(--ring);') &&
    rule.includes('outline-offset: -2px;') &&
    specificityAtLeast(selectorSpecificity(PANE_RING), selectorSpecificity(GENERIC_FOCUS_RING));
}

{
  check('the focusable tabpanel carries an inset themed ring, so the window edge cannot clip it',
    paneRingIsInset(dialogCss),
    `rule=${JSON.stringify(ruleBlock(dialogCss, `${PANE_RING} {`))}`);
}

{
  const ringRule = ruleBlock(dialogCss, `${PANE_RING} {`);
  const missing = dialogCss.replace(ringRule, '');
  const outward = dialogCss.replace(
    `${PANE_RING} { outline: 2px solid var(--ring); outline-offset: -2px; }`,
    `${PANE_RING} { outline: 2px solid var(--ring); outline-offset: 0px; }`);
  check('control: a tabpanel without its ring rule or with the ring pushed onto the window edge fails the same predicate',
    ringRule.length > 0 && missing !== dialogCss && !paneRingIsInset(missing) &&
    outward !== dialogCss && !paneRingIsInset(outward) && paneRingIsInset(dialogCss),
    `missing=${paneRingIsInset(missing)}, outward=${paneRingIsInset(outward)}, ` +
    `real=${paneRingIsInset(dialogCss)}`);
}

const NARROW_QUERY = '(max-width: 760px)';
const STACK_QUERY = '(max-width: 400px)';
const STACK_ROW_GAP = 2;

function mediaBlock(block: string, query: string): string {
  const start = block.indexOf(`@media ${query} {`);
  if (start < 0) return '';
  const open = block.indexOf('{', start);
  const end = open >= 0 ? matchingBrace(block, open) : -1;
  return end > open ? block.slice(start, end + 1) : '';
}

function mediaRule(block: string, selector: string): string {
  const start = block.indexOf(selector);
  if (start < 0) return '';
  const open = block.indexOf('{', start);
  const end = open >= 0 ? matchingBrace(block, open) : -1;
  return end > open ? block.slice(start, end + 1) : '';
}

const narrowCss = mediaBlock(dialogCss, NARROW_QUERY);
const stackCss = mediaBlock(dialogCss, STACK_QUERY);

function narrowWindowSized(narrow: string): boolean {
  const rule = mediaRule(narrow, '.settings-dialog {');
  const margin = SETTINGS_DIALOG_NARROW_MARGIN;
  return rule.includes(`width: calc(100vw - ${margin}px);`) &&
    rule.includes(`max-width: calc(100vw - ${margin}px);`) &&
    rule.includes(`min-height: min(${SETTINGS_DIALOG_HEIGHT}px, calc(100dvh - ${margin}px));`) &&
    rule.includes(`max-height: calc(100dvh - ${margin}px);`);
}

function narrowRailIsATabRow(narrow: string): boolean {
  const rail = mediaRule(narrow, '.settings-nav {');
  const item = mediaRule(narrow, '.settings-nav-item {');
  return rail.includes('flex-direction: row;') &&
    !rail.includes('flex-direction: column;') &&
    rail.includes('flex-wrap: nowrap;') &&
    rail.includes('overflow-x: auto;') &&
    rail.includes('overflow-y: hidden;') &&
    rail.includes('border-right: 0;') &&
    rail.includes('border-bottom: 1px solid var(--border);') &&
    item.includes('width: auto;');
}

function narrowBodyStacks(narrow: string): boolean {
  const body = mediaRule(narrow, '.settings-dialog-body {');
  return body.includes('grid-template-columns: minmax(0, 1fr);') &&
    body.includes('grid-template-rows: auto minmax(0, 1fr);');
}

function narrowRowsStack(stack: string): boolean {
  const row = mediaRule(stack, '.settings-row {');
  const gaps = effectiveGaps(row);
  return row.includes('grid-template-columns: minmax(0, 1fr);') &&
    gaps.row === STACK_ROW_GAP &&
    gaps.row < SETTINGS_PANE_GAP;
}

function narrowKeepsInsetRings(narrow: string, stack: string): boolean {
  const blocks = `${narrow}\n${stack}`;
  return narrow.length > 0 && stack.length > 0 && !blocks.includes(':focus-visible') &&
    css.includes(`${SCOPED_RING} { outline: 2px solid var(--ring); outline-offset: -2px; }`);
}

function narrowBlocksInSection(section: string): boolean {
  const narrow = mediaBlock(section, NARROW_QUERY);
  const stack = mediaBlock(section, STACK_QUERY);
  const base = section.indexOf('.settings-toggle input { margin: 0; accent-color: var(--primary); }');
  return narrow.length > 0 && stack.length > 0 && base >= 0 &&
    section.indexOf(narrow) > base && section.indexOf(stack) > section.indexOf(narrow);
}

{
  check('the narrow window keeps the 16 px viewport margin and the shipped height cap from the exported constants',
    narrowCss.length > 0 && narrowWindowSized(narrowCss),
    `margin=${SETTINGS_DIALOG_NARROW_MARGIN}, height=${SETTINGS_DIALOG_HEIGHT}, ` +
    `rule=${JSON.stringify(mediaRule(narrowCss, '.settings-dialog {'))}`);
}

{
  const drifted = narrowCss.replaceAll(`calc(100vw - ${SETTINGS_DIALOG_NARROW_MARGIN}px)`, 'calc(100vw - 12px)');
  const droppedCap = narrowCss.replace(` max-width: calc(100vw - ${SETTINGS_DIALOG_NARROW_MARGIN}px);`, '');
  const wideTail = narrowCss.replaceAll('calc(100dvh - 16px)', 'calc(100dvh - 32px)');
  check('control: a drifted margin, a dropped max-width or the wide-pair height tail fails the same predicate',
    drifted !== narrowCss && !narrowWindowSized(drifted) &&
    droppedCap !== narrowCss && !narrowWindowSized(droppedCap) &&
    wideTail !== narrowCss && !narrowWindowSized(wideTail) &&
    narrowWindowSized(narrowCss),
    `drifted=${narrowWindowSized(drifted)}, dropped=${narrowWindowSized(droppedCap)}, ` +
    `wideTail=${narrowWindowSized(wideTail)}, real=${narrowWindowSized(narrowCss)}`);
}

{
  check('the section rail becomes a horizontally scrolling tab row and moves its divider to the bottom edge',
    narrowRailIsATabRow(narrowCss),
    `rail=${JSON.stringify(mediaRule(narrowCss, '.settings-nav {'))}, ` +
    `item=${JSON.stringify(mediaRule(narrowCss, '.settings-nav-item {'))}`);
}

{
  const stillColumn = narrowCss.replace('flex-direction: row;', 'flex-direction: column;');
  const clipping = narrowCss.replace('overflow-x: auto; ', '');
  const wrapped = narrowCss.replace('flex-wrap: nowrap; ', 'flex-wrap: wrap; ');
  const sideDivider = narrowCss.replace('border-right: 0; ', 'border-right: 1px solid var(--border); ');
  check('control: a rail restored to a column, a wrapping rail, a rail without horizontal scrolling or one keeping its side divider fails the same predicate',
    stillColumn !== narrowCss && !narrowRailIsATabRow(stillColumn) &&
    wrapped !== narrowCss && !narrowRailIsATabRow(wrapped) &&
    clipping !== narrowCss && !narrowRailIsATabRow(clipping) &&
    sideDivider !== narrowCss && !narrowRailIsATabRow(sideDivider) &&
    narrowRailIsATabRow(narrowCss),
    `column=${narrowRailIsATabRow(stillColumn)}, wrapped=${narrowRailIsATabRow(wrapped)}, ` +
    `clipped=${narrowRailIsATabRow(clipping)}, divider=${narrowRailIsATabRow(sideDivider)}, ` +
    `real=${narrowRailIsATabRow(narrowCss)}`);
}

{
  check('the narrow body stacks the rail above a pane that keeps the remaining height',
    narrowBodyStacks(narrowCss),
    `body=${JSON.stringify(mediaRule(narrowCss, '.settings-dialog-body {'))}`);
}

{
  const looseRows = narrowCss.replace(' grid-template-rows: auto minmax(0, 1fr);', '');
  const autoRows = narrowCss.replace('auto minmax(0, 1fr)', 'auto auto');
  check('control: a body without the constrained second row, or one whose pane row is auto, fails the same predicate',
    looseRows !== narrowCss && !narrowBodyStacks(looseRows) &&
    autoRows !== narrowCss && !narrowBodyStacks(autoRows) && narrowBodyStacks(narrowCss),
    `loose=${narrowBodyStacks(looseRows)}, auto=${narrowBodyStacks(autoRows)}, real=${narrowBodyStacks(narrowCss)}`);
}

{
  check('the narrow rows stack their label above the control without squeezing it',
    stackCss.length > 0 && narrowRowsStack(stackCss),
    `row=${JSON.stringify(mediaRule(stackCss, '.settings-row {'))}`);
}

{
  const twoColumns = stackCss.replace(
    'grid-template-columns: minmax(0, 1fr); row-gap',
    `grid-template-columns: minmax(${SETTINGS_ROW_LABEL_MIN}px, max-content) minmax(0, 1fr); row-gap`);
  const rhythmGap = stackCss.replace('row-gap: 2px;', `row-gap: ${SETTINGS_PANE_GAP}px;`);
  const looseGap = stackCss.replace('row-gap: 2px;', 'row-gap: 12px;');
  check('control: a label column kept beside the control, or a stacked pair split as wide as the row rhythm, fails the same predicate',
    twoColumns !== stackCss && !narrowRowsStack(twoColumns) &&
    rhythmGap !== stackCss && !narrowRowsStack(rhythmGap) &&
    looseGap !== stackCss && !narrowRowsStack(looseGap) &&
    narrowRowsStack(stackCss),
    `twoColumns=${narrowRowsStack(twoColumns)}, rhythmGap=${narrowRowsStack(rhythmGap)}, ` +
    `looseGap=${narrowRowsStack(looseGap)}, real=${narrowRowsStack(stackCss)}`);
}

{
  check('the responsive layers add no focus rule of their own, so the inset rail and row rings survive the clipping rail',
    narrowKeepsInsetRings(narrowCss, stackCss),
    `outward=${JSON.stringify(`${narrowCss}\n${stackCss}`.includes(':focus-visible'))}`);
}

{
  const outward = narrowCss.replace(
    '  .settings-nav-item { width: auto; }',
    '  .settings-nav-item { width: auto; }\n  .settings-nav-item:focus-visible { outline-offset: 1px; }');
  const stackOutward = stackCss.replace(
    '  .settings-row { grid-template-columns: minmax(0, 1fr); row-gap: 2px; }',
    '  .settings-row { grid-template-columns: minmax(0, 1fr); row-gap: 2px; }\n  .settings-row:focus-visible { outline-offset: 1px; }');
  check('control: an outward focus offset added by either responsive layer fails the same predicate',
    outward !== narrowCss && !narrowKeepsInsetRings(outward, stackCss) &&
    stackOutward !== stackCss && !narrowKeepsInsetRings(narrowCss, stackOutward) &&
    narrowKeepsInsetRings(narrowCss, stackCss),
    `narrow=${narrowKeepsInsetRings(outward, stackCss)}, stack=${narrowKeepsInsetRings(narrowCss, stackOutward)}, ` +
    `real=${narrowKeepsInsetRings(narrowCss, stackCss)}`);
}

{
  check('both responsive blocks sit in the settings section after the base declarations they override',
    narrowCss.length > 0 && stackCss.length > 0 && narrowBlocksInSection(dialogCss),
    `narrow=${narrowCss.length}, stack=${stackCss.length}, ok=${narrowBlocksInSection(dialogCss)}`);
}

{
  const movedAhead = `${narrowCss}\n${stackCss}\n${dialogCss}`;
  const swapped = dialogCss.replace(narrowCss, '@@NARROW@@').replace(stackCss, narrowCss).replace('@@NARROW@@', stackCss);
  check('control: a narrow block moved ahead of the wide declarations, or the stack block placed before the narrow one, fails the same predicate',
    !narrowBlocksInSection(movedAhead) &&
    swapped !== dialogCss && !narrowBlocksInSection(swapped) &&
    narrowBlocksInSection(dialogCss),
    `ahead=${narrowBlocksInSection(movedAhead)}, swapped=${narrowBlocksInSection(swapped)}, ` +
    `real=${narrowBlocksInSection(dialogCss)}`);
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

const DEVELOPER_ROW_LABELS_WANT: readonly string[] = [
  'USB register console',
  'USB 寄存器控制台',
  'Консоль регистров USB',
  'Console de registres USB',
];

interface DeveloperRowLabel { locale: string; label: string; console: string; want: string }

function developerRowLabels(
  lookups: ReadonlyArray<readonly [string, (key: MessageKey) => string]>,
): DeveloperRowLabel[] {
  return lookups.map(([locale, lookup], index) => ({
    locale,
    label: lookup('settings.developerTools'),
    console: lookup('capturePanel.usbConsole'),
    want: DEVELOPER_ROW_LABELS_WANT[index]!,
  }));
}

function developerRowLabelDrift(rows: readonly DeveloperRowLabel[]): string[] {
  return rows
    .filter((row) => row.label !== row.console || row.label !== row.want)
    .map((row) => `${row.locale}=${JSON.stringify(row.label)}`);
}

{
  const rows = developerRowLabels(CATALOGS.map(([locale, lookup]) => [locale, lookup] as const));
  const drift = developerRowLabelDrift(rows);
  check('the developer-tools row prints the console name in every catalog',
    drift.length === 0 && rows.length === CATALOGS.length,
    drift.length === 0 ? rows.map((row) => `${row.locale}=${row.label}`).join('; ') : drift.join('; '));
}

{
  const withParenthetical = developerRowLabels(CATALOGS.map(([locale, lookup]) => [locale, lookup] as const))
    .map((row, index) => (index === 0 ? { ...row, label: 'Developer tools (USB register console)' } : row));
  const relocated = developerRowLabels(CATALOGS.map(([locale, lookup]) => [locale, lookup] as const))
    .map((row, index) => (index === 2 ? { ...row, label: 'Инструменты разработчика (консоль регистров USB)' } : row));
  check('control: a re-added parenthetical, or a row label that no longer matches the console, fails the same predicate',
    developerRowLabelDrift(withParenthetical).length === 1 &&
    developerRowLabelDrift(relocated).length === 1 &&
    developerRowLabelDrift(developerRowLabels(CATALOGS.map(([locale, lookup]) => [locale, lookup] as const))).length === 0,
    `parenthetical=${developerRowLabelDrift(withParenthetical).length}, relocated=${developerRowLabelDrift(relocated).length}`);
}

function developerCase(source: string): string {
  const pane = methodBody(source, 'private paneContent(section: SettingsSectionId): HTMLElement[] {');
  const start = pane.indexOf("case 'developer':");
  const end = start >= 0 ? pane.indexOf("case 'about':", start) : -1;
  return start >= 0 && end > start ? pane.slice(start, end) : '';
}

const DEVELOPER_PANE_ROW = 'return [this.developerToolsRow(), this.clearCacheRow()];';

function developerPaneRows(source: string): boolean {
  const body = developerCase(source);
  return body.includes(`        ${DEVELOPER_PANE_ROW}`) &&
    !body.includes('developerNote') &&
    !body.includes('this.host.developerTools()') &&
    !source.includes('developerNote(') &&
    !source.includes('settings-note');
}

{
  check('the developer pane is the console switch then the clear-cache action in both states, with no note to gate',
    developerPaneRows(dialogSource),
    `case=${JSON.stringify(developerCase(dialogSource).replace(/\s+/g, ' '))}`);
}

{
  const gated = dialogSource.replace(
    `        ${DEVELOPER_PANE_ROW}`,
    '        return this.host.developerTools()\n' +
    '          ? [this.developerToolsRow(), this.clearCacheRow(), this.developerNote()]\n' +
    '          : [this.developerToolsRow(), this.clearCacheRow()];');
  const appended = dialogSource.replace(
    `        ${DEVELOPER_PANE_ROW}`,
    '        return [this.developerToolsRow(), this.clearCacheRow(), this.developerNote()];');
  const removed = dialogSource.replace(
    `        ${DEVELOPER_PANE_ROW}`,
    '        return [this.developerToolsRow()];');
  check('control: a re-added note, gated or not, or a pane that drops the clear-cache action fails the same predicate',
    gated !== dialogSource && !developerPaneRows(gated) &&
    appended !== dialogSource && !developerPaneRows(appended) &&
    removed !== dialogSource && !developerPaneRows(removed) &&
    developerPaneRows(dialogSource),
    `gated=${developerPaneRows(gated)}, appended=${developerPaneRows(appended)}, ` +
    `removed=${developerPaneRows(removed)}, real=${developerPaneRows(dialogSource)}`);
}

function developerToggleWritesOnly(source: string): boolean {
  const body = methodBody(source, 'private developerToolsRow(): HTMLDivElement {');
  return body.includes("(on) => this.host.setDeveloperTools(on), 'settings.developerToolsWhere');") &&
    !body.includes('renderStrings');
}

{
  check('flipping the developer switch writes through the host and names the hint key, with no rebuild of its own',
    developerToggleWritesOnly(dialogSource),
    `body=${JSON.stringify(methodBody(dialogSource, 'private developerToolsRow(): HTMLDivElement {').replace(/\s+/g, ' '))}`);
}

{
  const rebuilt = dialogSource.replace(
    '      (on) => this.host.setDeveloperTools(on), \'settings.developerToolsWhere\');',
    '      (on) => {\n        this.host.setDeveloperTools(on);\n        this.renderStrings();\n      });');
  const keyless = dialogSource.replace(
    ", 'settings.developerToolsWhere');", ');');
  check('control: a toggle that rebuilds the pane, or one that drops the hint key, fails the same predicate',
    rebuilt !== dialogSource && !developerToggleWritesOnly(rebuilt) &&
    keyless !== dialogSource && !developerToggleWritesOnly(keyless) &&
    developerToggleWritesOnly(dialogSource),
    `rebuilt=${developerToggleWritesOnly(rebuilt)}, keyless=${developerToggleWritesOnly(keyless)}, ` +
    `real=${developerToggleWritesOnly(dialogSource)}`);
}

const CLEAR_CACHE_ROW_NEEDLES: readonly string[] = [
  "    row.className = 'settings-row';",
  "    cell.className = 'settings-row-label-cell';",
  "    cell.append(this.rowLabel('settings.savedData'), helpTip(t('settings.savedDataHelp')));",
  "    action.type = 'button';",
  "    action.className = 'settings-action danger';",
  "    action.dataset.settingsKey = 'clear-cache';",
  "    action.textContent = t('settings.clearCache');",
  "    action.addEventListener('click', () => this.host.clearCache());",
  '    row.append(cell, action);',
];

function clearCacheRowBody(source: string): string {
  return methodBody(source, 'private clearCacheRow(): HTMLDivElement {');
}

function clearCacheRowIntact(source: string): boolean {
  const body = clearCacheRowBody(source);
  return body.length > 0 && CLEAR_CACHE_ROW_NEEDLES.every((needle) => body.includes(needle)) &&
    (body.match(/addEventListener\(/g)?.length ?? 0) === 1 &&
    !body.includes('persistWorkspace') && !body.includes('localStorage') &&
    !body.includes('confirmDialog') && !body.includes('showModal') &&
    !body.includes("dataset.settingsKey = 'developer");
}

{
  const missing = CLEAR_CACHE_ROW_NEEDLES.filter((needle) => !clearCacheRowBody(dialogSource).includes(needle));
  check('the saved-data row is the settings grid label cell with its help tip and one destructive action keyed clear-cache',
    clearCacheRowIntact(dialogSource) &&
    dialogSource.includes('  clearCache(): void;\n}'),
    `missing=${JSON.stringify(missing)}, ` +
    `body=${JSON.stringify(clearCacheRowBody(dialogSource).replace(/\s+/g, ' '))}`);
}

{
  const unkeyed = dialogSource.replace("    action.dataset.settingsKey = 'clear-cache';\n", '');
  const undanger = dialogSource.replace(
    "    action.className = 'settings-action danger';",
    "    action.className = 'settings-action';");
  const direct = dialogSource.replace(
    "    action.addEventListener('click', () => this.host.clearCache());",
    "    action.addEventListener('click', () => this.host.clearCache());\n    action.addEventListener('click', () => this.renderStrings());");
  const note = dialogSource.replace(
    "    row.append(cell, action);",
    "    const note = document.createElement('p');\n    row.append(cell, action, note);");
  const toggle = dialogSource.replace(
    "    action.className = 'settings-action danger';",
    "    action.className = 'settings-action danger';\n    action.dataset.settingsKey = 'developer-tools';");
  check('control: an unkeyed or undecorated action, a second listener, an appended note or a reused developer key fails the same row predicate',
    unkeyed !== dialogSource && !clearCacheRowIntact(unkeyed) &&
    undanger !== dialogSource && !clearCacheRowIntact(undanger) &&
    direct !== dialogSource && !clearCacheRowIntact(direct) &&
    note !== dialogSource && !clearCacheRowIntact(note) &&
    toggle !== dialogSource && !clearCacheRowIntact(toggle) &&
    clearCacheRowIntact(dialogSource),
    `unkeyed=${clearCacheRowIntact(unkeyed)}, undanger=${clearCacheRowIntact(undanger)}, ` +
    `direct=${clearCacheRowIntact(direct)}, note=${clearCacheRowIntact(note)}, ` +
    `toggle=${clearCacheRowIntact(toggle)}, real=${clearCacheRowIntact(dialogSource)}`);
}

{
  const hostPair = dialogSource.includes('  clearCache(): void;\n}') &&
    appSource.includes('      clearCache: () => void this.clearCache(),') &&
    appSource.includes('  private async clearCache(): Promise<void> {');
  const bridgeless = dialogSource.replace('  clearCache(): void;\n}', '}');
  const unwired = appSource.replace('      clearCache: () => void this.clearCache(),\n', '');
  check('the host contract and the App host literal carry the one clear-cache action, wired to the async App method',
    hostPair &&
    bridgeless !== dialogSource && !bridgeless.includes('clearCache(): void;') &&
    unwired !== appSource && !unwired.includes('clearCache: () => void this.clearCache(),'),
    `host=${hostPair}, bridgeless=${bridgeless.includes('clearCache(): void;')}, ` +
    `unwired=${unwired.includes('clearCache: () => void this.clearCache(),')}`);
}

const ACTION_RULE = '.settings-action {';
const ACTION_LABEL_RULE = '.settings-row-label:not(label) {';

function sheetRuleWith(sheet: string, selector: string, from: string, to: string): string {
  const rule = ruleBlock(sheet, selector);
  return rule.length > 0 ? sheet.replace(rule, rule.replace(from, to)) : sheet;
}

function actionRuleOnlyAligns(sheet: string): boolean {
  const action = declarationsIn(ruleBlock(sheet, ACTION_RULE));
  const label = declarationsIn(ruleBlock(sheet, ACTION_LABEL_RULE));
  return action.size === 1 && action.get('justify-self') === 'start' &&
    label.size === 1 && label.get('cursor') === 'default' && !label.has('pointer-events');
}

{
  const danger = declarationsIn(ruleBlock(css, '.danger {'));
  check('the action sits left-aligned in its grid cell, its label stops promising the row is clickable, and the destructive colour stays on the shared .danger token rule',
    actionRuleOnlyAligns(dialogCss) && danger.get('background') === 'var(--stop)' &&
    danger.get('color') === '#fff' && !css.includes('settings-action--danger'),
    `action=${JSON.stringify([...declarationsIn(ruleBlock(dialogCss, ACTION_RULE))])}, ` +
    `label=${JSON.stringify([...declarationsIn(ruleBlock(dialogCss, ACTION_LABEL_RULE))])}, ` +
    `danger=${JSON.stringify([...danger])}`);
}

{
  const stretched = sheetRuleWith(dialogCss, ACTION_RULE, 'justify-self: start;', 'justify-self: stretch;');
  const pointerLabel = sheetRuleWith(dialogCss, ACTION_LABEL_RULE, 'cursor: default;', 'cursor: pointer;');
  const ownColour = sheetRuleWith(dialogCss, ACTION_RULE, 'justify-self: start;',
    'justify-self: start;\n  background: #c00;');
  check('control: a stretched action, a pointer-cursor action label or a private action colour fails the same sheet predicate',
    stretched !== dialogCss && !actionRuleOnlyAligns(stretched) &&
    pointerLabel !== dialogCss && !actionRuleOnlyAligns(pointerLabel) &&
    ownColour !== dialogCss && !actionRuleOnlyAligns(ownColour) &&
    actionRuleOnlyAligns(dialogCss),
    `stretch=${actionRuleOnlyAligns(stretched)}, pointer=${actionRuleOnlyAligns(pointerLabel)}, ` +
    `colour=${actionRuleOnlyAligns(ownColour)}, real=${actionRuleOnlyAligns(dialogCss)}`);
}

function hintOutsideLabel(source: string): boolean {
  const body = toggleRowBody(source);
  return body.includes('    hint?: MessageKey,\n') &&
    body.includes('    if (hint === undefined) {\n') &&
    body.includes("      const cell = document.createElement('div');\n") &&
    body.includes("      cell.className = 'settings-row-label-cell';\n") &&
    body.includes('      cell.append(text, helpTip(t(hint)));\n') &&
    body.includes('      row.append(cell, toggle);\n') &&
    !body.includes('text.append(');
}

{
  check('the hint rides in a label cell beside the label, so the tip is its own control outside the toggle target',
    hintOutsideLabel(dialogSource),
    `body=${JSON.stringify(toggleRowBody(dialogSource).replace(/\s+/g, ' '))}`);
}

{
  const insideLabel = dialogSource.replace(
    '      cell.append(text, helpTip(t(hint)));',
    '      text.append(helpTip(t(hint)));');
  const noCell = dialogSource.replace(
    "      cell.className = 'settings-row-label-cell';\n", '');
  const unpassed = dialogSource.replace('    hint?: MessageKey,\n', '');
  check('control: a tip appended to the label, a cell with no class or a builder that cannot take a hint fails the same predicate',
    insideLabel !== dialogSource && !hintOutsideLabel(insideLabel) &&
    noCell !== dialogSource && !hintOutsideLabel(noCell) &&
    unpassed !== dialogSource && !hintOutsideLabel(unpassed) &&
    hintOutsideLabel(dialogSource),
    `inside=${hintOutsideLabel(insideLabel)}, noCell=${hintOutsideLabel(noCell)}, ` +
    `unpassed=${hintOutsideLabel(unpassed)}, real=${hintOutsideLabel(dialogSource)}`);
}

interface HintedToggleRow {
  row: string;
  label: MessageKey;
  hint: MessageKey;
}

const HINTED_TOGGLE_ROWS: readonly HintedToggleRow[] = [
  { row: 'labelsRow', label: 'settings.detailedLabels', hint: 'settings.detailedLabelsHelp' },
  { row: 'compactRowsRow', label: 'settings.compactRows', hint: 'settings.compactRowsHelp' },
  { row: 'hideIdleRow', label: 'settings.hideIdle', hint: 'settings.hideIdleHelp' },
  { row: 'wheelZoomsRow', label: 'settings.wheelZooms', hint: 'settings.wheelZoomsHelp' },
];

function hintedRowBodies(source: string): string[] {
  return HINTED_TOGGLE_ROWS.map((entry) =>
    methodBody(source, `private ${entry.row}(): HTMLDivElement {`));
}

function hintedHelpWiring(source: string): boolean {
  const hints = HINTED_TOGGLE_ROWS.map((entry) => entry.hint);
  const bodies = hintedRowBodies(source);
  return HINTED_TOGGLE_ROWS.length === 4 && new Set(hints).size === hints.length &&
    HINTED_TOGGLE_ROWS.every((entry, index) => {
      const body = bodies[index] ?? '';
      const own = `'${entry.hint}'`;
      return occurrences(body, 'this.toggleRow(') === 1 &&
        occurrences(body, own) === 1 &&
        occurrences(source, own) === 1 &&
        HINTED_TOGGLE_ROWS.every((other) => other === entry || !body.includes(`'${other.hint}'`));
    });
}

{
  const bodies = hintedRowBodies(dialogSource);
  const missing = HINTED_TOGGLE_ROWS.flatMap((entry, index) => {
    const body = bodies[index] ?? '';
    return occurrences(body, 'this.toggleRow(') === 1 && occurrences(body, `'${entry.hint}'`) === 1
      ? []
      : [`${entry.row}:${entry.hint}`];
  });
  check('each hinted toggle row passes its own help key to the shared toggle row and no other row\'s',
    hintedHelpWiring(dialogSource) && missing.length === 0,
    `missing=${JSON.stringify(missing)}, ok=${hintedHelpWiring(dialogSource)}`);
}

{
  const droppedHint = dialogSource.replace(
    "      (on) => this.host.setCompactRows(on), 'settings.compactRowsHelp');",
    '      (on) => this.host.setCompactRows(on));');
  const swappedHints = dialogSource
    .replace("this.host.setWheelZooms(on), 'settings.wheelZoomsHelp'",
      "this.host.setWheelZooms(on), 'settings.compactRowsHelp'")
    .replace("this.host.setCompactRows(on), 'settings.compactRowsHelp'",
      "this.host.setCompactRows(on), 'settings.wheelZoomsHelp'");
  const reusedHint = dialogSource.replace(
    "      (on) => this.host.setHideIdle(on), 'settings.hideIdleHelp');",
    "      (on) => this.host.setHideIdle(on), 'settings.compactRowsHelp');");
  check('control: dropping one help argument, swapping two rows\' help keys or reusing one help key twice fails the same wiring predicate',
    droppedHint !== dialogSource && !hintedHelpWiring(droppedHint) &&
    swappedHints !== dialogSource && !hintedHelpWiring(swappedHints) &&
    reusedHint !== dialogSource && !hintedHelpWiring(reusedHint) &&
    hintedHelpWiring(dialogSource),
    `dropped=${hintedHelpWiring(droppedHint)}, swapped=${hintedHelpWiring(swappedHints)}, ` +
    `reused=${hintedHelpWiring(reusedHint)}, real=${hintedHelpWiring(dialogSource)}`);
}

interface HintedHelpCopy {
  locale: string;
  key: MessageKey;
  label: string;
  help: string;
}

function hintedHelpCopyRows(): HintedHelpCopy[] {
  return CATALOGS.flatMap(([locale, lookup]) => HINTED_TOGGLE_ROWS.map((entry) => ({
    locale,
    key: entry.hint,
    label: lookup(entry.label),
    help: lookup(entry.hint),
  })));
}

function hintedHelpCopyProblems(rows: readonly HintedHelpCopy[]): string[] {
  return rows
    .filter((row) => row.help.trim().length === 0)
    .map((row) => `${row.locale}:${row.key}=blank`)
    .concat(rows
      .filter((row) => row.help === row.label)
      .map((row) => `${row.locale}:${row.key}=label`));
}

{
  const rows = hintedHelpCopyRows();
  const problems = hintedHelpCopyProblems(rows);
  check('every hinted settings help key carries non-empty prose that is not its own label in all four catalogs',
    rows.length === HINTED_TOGGLE_ROWS.length * CATALOGS.length && problems.length === 0,
    problems.length === 0
      ? `${HINTED_TOGGLE_ROWS.length} options × ${CATALOGS.length} catalogs`
      : problems.join('; '));
}

{
  const rows = hintedHelpCopyRows();
  const copied = rows.map((row, index) => (index === 0 ? { ...row, help: row.label } : row));
  const blanked = rows.map((row, index) =>
    (index === rows.length - 1 ? { ...row, help: '   ' } : row));
  check('control: help prose copied from its own label or blanked out fails the same copy predicate',
    hintedHelpCopyProblems(copied).length > 0 &&
    hintedHelpCopyProblems(blanked).length > 0 &&
    hintedHelpCopyProblems(rows).length === 0,
    `copied=${JSON.stringify(hintedHelpCopyProblems(copied).slice(0, 2))}, ` +
    `blanked=${JSON.stringify(hintedHelpCopyProblems(blanked).slice(0, 2))}, ` +
    `real=${hintedHelpCopyProblems(rows).length}`);
}

interface WhereRow { locale: string; actual: string; want: string }

const DEVELOPER_WHERE_WANT: readonly string[] = [
  'right sidebar › Capture › Advanced',
  '右侧栏 › 采集 › 高级',
  'Боковая панель › Захват › Расширенные',
  'Panneau latéral › Capture › Avancé',
];

function whereDrift(rows: readonly WhereRow[]): string[] {
  return rows
    .filter((row) => row.actual.trim() === '')
    .map((row) => `${row.locale}:blank`)
    .concat(rows
      .filter((row) => row.actual !== row.want)
      .map((row) => `${row.locale}=${JSON.stringify(row.actual)}`));
}

{
  const rows: WhereRow[] = CATALOGS.map(([locale, lookup], index) => ({
    locale,
    actual: lookup('settings.developerToolsWhere'),
    want: DEVELOPER_WHERE_WANT[index]!,
  }));
  const drift = whereDrift(rows);
  check('the hint names the console location in every catalog with its own words',
    rows.length === CATALOGS.length && drift.length === 0,
    drift.length === 0 ? rows.map((row) => `${row.locale}=${row.actual}`).join('; ') : drift.join('; '));
}

{
  const rows: WhereRow[] = CATALOGS.map(([locale, lookup], index) => ({
    locale,
    actual: lookup('settings.developerToolsWhere'),
    want: DEVELOPER_WHERE_WANT[index]!,
  }));
  const englishCopy = rows.map((row, index) => (index === 0 ? row : { ...row, actual: rows[0]!.actual }));
  const emptied = rows.map((row, index) => (index === 3 ? { ...row, actual: '  ' } : row));
  check('control: a copied English hint or an emptied one fails the same locale predicate',
    whereDrift(englishCopy).length > 0 && whereDrift(emptied).length > 0 &&
    whereDrift(rows).length === 0,
    `english=${JSON.stringify(whereDrift(englishCopy).slice(0, 2))}, ` +
    `emptied=${JSON.stringify(whereDrift(emptied).slice(0, 2))}, real=${whereDrift(rows).length}`);
}

const HELP_TIP_NEEDLES: readonly string[] = [
  'export function helpTip(text: string): HTMLButtonElement {',
  "b.className = 'help-tip';",
  "b.textContent = '?';",
  'b.title = text;',
  "b.setAttribute('aria-label', `${t('capturePanel.moreInfo')}: ${text}`);",
];

function oneHelpTipBuilder(sources: {
  module: string; panel: string; dialog: string;
}): boolean {
  return (sources.module.match(/function helpTip\(/g)?.length ?? 0) === 1 &&
    HELP_TIP_NEEDLES.every((needle) => sources.module.includes(needle)) &&
    !sources.panel.includes('function helpTip(') &&
    !sources.dialog.includes('function helpTip(') &&
    sources.panel.includes("import { helpTip } from './helpTip.js';") &&
    sources.dialog.includes("import { helpTip } from './helpTip.js';");
}

const REAL_HELP_TIP = { module: helpTipSource, panel: capturePanelSource, dialog: dialogSource };

{
  check('the settings window and the capture panel share one "?" builder module instead of a copy',
    oneHelpTipBuilder(REAL_HELP_TIP),
    `definitions=${helpTipSource.match(/function helpTip\(/g)?.length ?? 0}, ` +
    `panelImport=${capturePanelSource.includes("from './helpTip.js'")}, ` +
    `dialogImport=${dialogSource.includes("from './helpTip.js'")}`);
}

{
  const copied = {
    ...REAL_HELP_TIP,
    dialog: dialogSource.replace(
      "import { helpTip } from './helpTip.js';",
      "import { helpTip } from './helpTip.js';\n\nfunction helpTip(text: string): HTMLButtonElement { return helpTip(text); }"),
  };
  const unimported = {
    ...REAL_HELP_TIP,
    panel: capturePanelSource.replace("import { helpTip } from './helpTip.js';\n", ''),
  };
  const duplicate = { ...REAL_HELP_TIP, module: `${helpTipSource}\nfunction helpTip(): void {}\n` };
  check('control: a local copy, a dropped import or a second definition fails the same single-builder predicate',
    !oneHelpTipBuilder(copied) && !oneHelpTipBuilder(unimported) && !oneHelpTipBuilder(duplicate) &&
    oneHelpTipBuilder(REAL_HELP_TIP),
    `copied=${oneHelpTipBuilder(copied)}, unimported=${oneHelpTipBuilder(unimported)}, ` +
    `duplicate=${oneHelpTipBuilder(duplicate)}, real=${oneHelpTipBuilder(REAL_HELP_TIP)}`);
}

const DEAD_CODE_NEEDLES: readonly string[] = [
  'revealDeveloperTools', 'revealDeveloperConsole', 'setAdvancedOpen', 'focusAdvanced',
  'advancedSummary', 'advancedEl', 'developerNote', 'settings-note',
];

function developerRevealRetired(sources: {
  app: string; panel: string; dialog: string;
}): string[] {
  return DEAD_CODE_NEEDLES.filter((needle) =>
    sources.app.includes(needle) || sources.panel.includes(needle) || sources.dialog.includes(needle));
}

{
  const leftovers = developerRevealRetired({ app: appSource, panel: capturePanelSource, dialog: dialogSource });
  check('nothing built only for the note survives, and the rebuild keeps its own state line',
    leftovers.length === 0 && capturePanelSource.includes('advanced.open = this.advancedOpen;'),
    leftovers.length === 0 ? 'no reveal chain left' : JSON.stringify(leftovers));
}

{
  const leftovers = developerRevealRetired({ app: appSource, panel: capturePanelSource, dialog: dialogSource });
  const reintroduced = {
    app: `${appSource}\n// setAdvancedOpen\n`,
    panel: capturePanelSource,
    dialog: dialogSource,
  };
  check('control: a reintroduced reveal helper or note class is caught by the same retirement predicate',
    developerRevealRetired(reintroduced).length === 1 && leftovers.length === 0,
    `reintroduced=${JSON.stringify(developerRevealRetired(reintroduced))}, real=${JSON.stringify(leftovers)}`);
}

function labelCellCss(source: string): boolean {
  const rule = source.match(/\.settings-row-label-cell \{[\s\S]*?\n\}/)?.[0] ?? '';
  return rule.includes('min-width: 0;') && rule.includes('align-self: stretch;') &&
    rule.includes('display: flex;') && rule.includes('align-items: center;') &&
    source.includes('.settings-row-label-cell .settings-row-label { flex: 1 1 auto; }');
}

{
  check('the label cell is a stretching flex box and the label fills it, so the whole-row target survives the tip',
    labelCellCss(css) && !/\.settings-note\b/.test(css),
    `ok=${labelCellCss(css)}, note=${/\.settings-note\b/.test(css)}`);
}

{
  const collapsed = css.replace(
    '.settings-row-label-cell {\n  min-width: 0;\n  align-self: stretch;\n  display: flex;',
    '.settings-row-label-cell {\n  min-width: 0;\n  align-self: stretch;\n  display: block;');
  const unfilled = css.replace('.settings-row-label-cell .settings-row-label { flex: 1 1 auto; }', '');
  const noteBack = `${css}\n.settings-note-text { margin: 0; }\n`;
  check('control: a cell that stops being flex, a label that stops filling it or a restored note rule fails the same CSS predicate',
    collapsed !== css && !labelCellCss(collapsed) &&
    unfilled !== css && !labelCellCss(unfilled) &&
    noteBack !== css && /\.settings-note\b/.test(noteBack) &&
    labelCellCss(css) && !/\.settings-note\b/.test(css),
    `collapsed=${labelCellCss(collapsed)}, unfilled=${labelCellCss(unfilled)}, ` +
    `real=${labelCellCss(css)}, note=${/\.settings-note\b/.test(css)}`);
}

const SECTION_LABELS_WANT: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['appearance', ['Appearance', '外观', 'Внешний вид', 'Apparence']],
  ['behaviour', ['Behaviour', '行为', 'Поведение', 'Comportement']],
  ['shortcuts', ['Shortcuts and gestures', '快捷键与鼠标操作', 'Клавиши и жесты', 'Raccourcis et gestes']],
  ['developer', ['Developer tools', '开发者工具', 'Для разработчиков', 'Outils développeur']],
  ['about', ['About', '关于', 'О программе', 'À propos']],
];

function sectionLabelMap(source: string): boolean {
  const start = source.indexOf('const SECTION_LABELS: Record<SettingsSectionId, MessageKey> = {');
  const end = start >= 0 ? source.indexOf('\n};', start) : -1;
  const body = start >= 0 && end > start ? source.slice(start, end) : '';
  const entries = [...body.matchAll(/^ {2}(\w+): 'settings\.sections\.(\w+)',$/gm)];
  return entries.length === SETTINGS_SECTIONS.length &&
    entries.every(([, section, label], index) => section === SETTINGS_SECTIONS[index] && label === section);
}

function sectionLabelDrift(
  lookups: ReadonlyArray<readonly [string, (key: MessageKey) => string]>,
): string[] {
  return SECTION_LABELS_WANT.flatMap(([section, labels]) => lookups
    .map(([locale, lookup], index) => ({
      locale, section, actual: lookup(`settings.sections.${section}` as MessageKey), want: labels[index]!,
    }))
    .filter((row) => row.actual !== row.want)
    .map((row) => `${row.locale}:${row.section}=${JSON.stringify(row.actual)}`));
}

{
  check('each shipped section reads the catalog key that carries its own id',
    sectionLabelMap(dialogSource),
    `ok=${sectionLabelMap(dialogSource)}`);
}

{
  const duplicated = dialogSource.replace("  developer: 'settings.sections.developer',",
    "  developer: 'settings.sections.about',");
  const swapped = dialogSource.replace("  shortcuts: 'settings.sections.shortcuts',",
    "  shortcuts: 'settings.sections.appearance',");
  check('control: a section label key duplicated from another section or swapped with one fails the same map predicate',
    duplicated !== dialogSource && !sectionLabelMap(duplicated) &&
    swapped !== dialogSource && !sectionLabelMap(swapped) &&
    sectionLabelMap(dialogSource),
    `duplicated=${sectionLabelMap(duplicated)}, swapped=${sectionLabelMap(swapped)}, ` +
    `real=${sectionLabelMap(dialogSource)}`);
}

{
  const lookups = CATALOGS.map(([locale, lookup]) => [locale, lookup] as const);
  const drift = sectionLabelDrift(lookups);
  check('all four catalogs carry the five section labels with their pinned values',
    drift.length === 0 && SECTION_LABELS_WANT.length === SETTINGS_SECTIONS.length &&
    SECTION_LABELS_WANT.every(([section], index) => SETTINGS_SECTIONS[index] === section),
    drift.length === 0 ? `${SECTION_LABELS_WANT.length} sections × ${CATALOGS.length} catalogs` : drift.join('; '));
}

{
  const lookups = CATALOGS.map(([locale, lookup]) => [locale, lookup] as const);
  const renamed = lookups.map(([locale, lookup]) => [locale, (key: MessageKey): string =>
    (key === 'settings.sections.developer' ? 'General' : lookup(key))] as const);
  const removed = lookups.map(([locale, lookup]) => [locale, (key: MessageKey): string =>
    (key === 'settings.sections.about' ? '' : lookup(key))] as const);
  check('control: a section label copied from another section or an emptied one fails the same drift predicate',
    sectionLabelDrift(lookups).length === 0 &&
    sectionLabelDrift(renamed).length > 0 && sectionLabelDrift(removed).length > 0,
    `renamed=${JSON.stringify(sectionLabelDrift(renamed).slice(0, 2))}, ` +
    `removed=${JSON.stringify(sectionLabelDrift(removed).slice(0, 2))}, ` +
    `real=${sectionLabelDrift(lookups).length}`);
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
