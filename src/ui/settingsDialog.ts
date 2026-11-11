import { t } from './i18n.js';
import type { MessageKey } from './i18n.js';
import { aboutView } from './about.js';
import type { AboutLink } from './about.js';
import { helpTip } from './helpTip.js';
import { formatChord } from './chords.js';
import {
  gestureNotation, referenceGestures, referenceGroups, shortcutActionText,
  shortcutGroupLabel, shortcutsIn,
} from './shortcuts.js';

export const SETTINGS_DIALOG_ID = 'settings-dialog';
export const SETTINGS_DIALOG_WIDTH = 560;
export const SETTINGS_DIALOG_HEIGHT = 360;
export const SETTINGS_NAV_WIDTH = 152;
export const SETTINGS_ROW_LABEL_MIN = 104;
export const SETTINGS_ROW_GAP = 12;
export const SETTINGS_ROW_HEIGHT = 28;
export const SETTINGS_ROW_PADDING_Y = 3;
export const SETTINGS_PANE_GAP = 4;
export const SETTINGS_DIALOG_NARROW_MARGIN = 16;

export const SETTINGS_SECTIONS = ['appearance', 'behaviour', 'shortcuts', 'developer', 'about'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

const SECTION_LABELS: Record<SettingsSectionId, MessageKey> = {
  appearance: 'settings.sections.appearance',
  behaviour: 'settings.sections.behaviour',
  shortcuts: 'settings.sections.shortcuts',
  developer: 'settings.sections.developer',
  about: 'settings.sections.about',
};

export function settingsSectionAfter(key: string, current: SettingsSectionId): SettingsSectionId | null {
  const index = SETTINGS_SECTIONS.indexOf(current);
  const last = SETTINGS_SECTIONS.length - 1;
  let next: SettingsSectionId | null = null;
  if (key === 'ArrowUp') next = SETTINGS_SECTIONS[index > 0 ? index - 1 : last];
  else if (key === 'ArrowDown') next = SETTINGS_SECTIONS[index < last ? index + 1 : 0];
  else if (key === 'Home') next = SETTINGS_SECTIONS[0];
  else if (key === 'End') next = SETTINGS_SECTIONS[last];
  return next === current ? null : next;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SettingsDialogHost {
  detailedLabels(): boolean;
  setDetailedLabels(on: boolean): void;
  wheelZooms(): boolean;
  setWheelZooms(on: boolean): void;
  compactRows(): boolean;
  setCompactRows(on: boolean): void;
  hideIdle(): boolean;
  setHideIdle(on: boolean): void;
  developerTools(): boolean;
  setDeveloperTools(on: boolean): void;
  clearCache(): void;
}

function camelKey(kebab: string): string {
  return kebab.replace(/-([a-z0-9])/g, (_match: string, letter: string) => letter.toUpperCase());
}

function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M18 6 6 18', 'm6 6 12 12']) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }
  return svg;
}

export class SettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly body: HTMLDivElement;
  private section: SettingsSectionId = SETTINGS_SECTIONS[0];
  private invoker: HTMLElement | null = null;

  constructor(private readonly host: SettingsDialogHost) {
    this.dialog = document.createElement('dialog');
    this.dialog.id = SETTINGS_DIALOG_ID;
    this.dialog.className = 'settings-dialog';
    this.dialog.setAttribute('aria-labelledby', 'settings-dialog-title');

    const header = document.createElement('header');
    header.className = 'settings-dialog-header';
    this.title = document.createElement('h2');
    this.title.id = 'settings-dialog-title';
    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'settings-dialog-close';
    this.closeButton.appendChild(closeIcon());
    header.append(this.title, this.closeButton);

    this.body = document.createElement('div');
    this.body.className = 'settings-dialog-body';

    this.dialog.append(header, this.body);
    document.body.appendChild(this.dialog);

    this.closeButton.addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener('pointerdown', (event) => {
      if (event.target !== this.dialog) return;
      event.preventDefault();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(invoker: HTMLElement | null): void {
    if (this.dialog.open) return;
    this.invoker = invoker;
    this.renderStrings();
    this.dialog.showModal();
    this.focusKeyed(null);
  }

  close(): void {
    const invoker = this.invoker;
    this.invoker = null;
    if (this.dialog.open) this.dialog.close();
    if (invoker?.isConnected) invoker.focus();
  }

  renderStrings(): void {
    const active = document.activeElement;
    const restore = this.dialog.open && active instanceof HTMLElement && this.body.contains(active)
      ? active.closest<HTMLElement>('[data-settings-key]')?.dataset.settingsKey ?? null
      : undefined;
    this.title.textContent = t('settings.title');
    this.closeButton.setAttribute('aria-label', t('settings.close'));
    this.renderBody();
    if (restore !== undefined) this.focusKeyed(restore);
  }

  private renderBody(): void {
    this.body.replaceChildren(this.nav(), this.pane());
  }

  private nav(): HTMLElement {
    const nav = document.createElement('nav');
    nav.className = 'settings-nav';
    nav.setAttribute('role', 'tablist');
    nav.setAttribute('aria-orientation', 'vertical');
    nav.setAttribute('aria-label', t('settings.title'));
    nav.addEventListener('keydown', (event) => this.onNavKey(event));
    for (const section of SETTINGS_SECTIONS) nav.appendChild(this.navItem(section));
    return nav;
  }

  private navItem(section: SettingsSectionId): HTMLButtonElement {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'settings-nav-item';
    tab.id = `settings-tab-${section}`;
    tab.dataset.settingsKey = `tab:${section}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `settings-panel-${section}`);
    const selected = section === this.section;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.textContent = t(SECTION_LABELS[section]);
    tab.addEventListener('click', () => this.selectSection(section));
    return tab;
  }

  private pane(): HTMLElement {
    const pane = document.createElement('section');
    pane.className = 'settings-pane';
    pane.id = `settings-panel-${this.section}`;
    pane.tabIndex = 0;
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', `settings-tab-${this.section}`);
    pane.append(...this.paneContent(this.section));
    return pane;
  }

  private paneContent(section: SettingsSectionId): HTMLElement[] {
    switch (section) {
      case 'appearance':
        return [this.labelsRow(), this.compactRowsRow(), this.hideIdleRow()];
      case 'behaviour':
        return [this.wheelZoomsRow()];
      case 'shortcuts':
        return this.shortcutBlocks();
      case 'developer':
        return [this.developerToolsRow(), this.clearCacheRow()];
      case 'about':
        return [this.aboutBlock()];
    }
  }

  private shortcutBlocks(): HTMLElement[] {
    const blocks: HTMLElement[] = [];
    for (const group of referenceGroups()) {
      blocks.push(this.groupTitle(shortcutGroupLabel(group)));
      blocks.push(this.shortcutList(shortcutsIn(group).map((entry) => this.keyRow(
        shortcutActionText(entry),
        entry.chords.map((chord) => formatChord(chord)).join(' / '),
        `shortcut:${entry.id}`))));
    }
    blocks.push(this.groupTitle(t('shortcuts.mouse')));
    blocks.push(this.shortcutList(referenceGestures(this.host.wheelZooms()).map((entry, index) =>
      this.keyRow(shortcutActionText(entry), gestureNotation(entry), `gesture:${index}`))));
    return blocks;
  }

  private groupTitle(text: string): HTMLHeadingElement {
    const heading = document.createElement('h3');
    heading.className = 'shortcuts-section';
    heading.textContent = text;
    return heading;
  }

  private shortcutList(rows: readonly HTMLLIElement[]): HTMLUListElement {
    const list = document.createElement('ul');
    list.className = 'shortcuts-list';
    list.append(...rows);
    return list;
  }

  private keyRow(actionText: string, notation: string, key: string): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'shortcuts-row';
    row.dataset.settingsKey = key;
    row.tabIndex = -1;
    const action = document.createElement('span');
    action.className = 'shortcuts-action';
    action.textContent = actionText;
    const chord = document.createElement('kbd');
    chord.className = 'shortcuts-key';
    chord.textContent = notation;
    row.append(action, chord);
    return row;
  }

  private onNavKey(event: KeyboardEvent): void {
    const target = settingsSectionAfter(event.key, this.section);
    if (target === null) return;
    event.preventDefault();
    this.selectSection(target);
  }

  private selectSection(section: SettingsSectionId): void {
    if (section === this.section) return;
    this.section = section;
    this.renderBody();
    this.focusKeyed(`tab:${section}`);
  }

  private focusKeyed(key: string | null): void {
    const keyed = key === null
      ? undefined
      : [...this.body.querySelectorAll<HTMLElement>('[data-settings-key]')]
        .find((candidate) => candidate.dataset.settingsKey === key);
    (keyed ?? this.activeTab() ?? this.closeButton).focus({ preventScroll: true });
  }

  private activeTab(): HTMLElement | null {
    return this.body.querySelector<HTMLElement>(`#settings-tab-${this.section}`);
  }

  private rowLabel(key: MessageKey, controlId?: string): HTMLElement {
    const text = t(key);
    if (controlId === undefined) {
      const span = document.createElement('span');
      span.className = 'settings-row-label';
      span.textContent = text;
      return span;
    }
    const label = document.createElement('label');
    label.className = 'settings-row-label';
    label.textContent = text;
    label.htmlFor = controlId;
    return label;
  }

  private toggleRow(
    key: string,
    label: MessageKey,
    checked: boolean,
    onChange: (on: boolean) => void,
    hint?: MessageKey,
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const toggle = document.createElement('label');
    toggle.className = 'settings-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `settings-${key}`;
    input.dataset.settingsKey = camelKey(key);
    const text = this.rowLabel(label, input.id);
    text.id = `settings-row-${key}`;
    input.setAttribute('aria-labelledby', text.id);
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    toggle.appendChild(input);
    if (hint === undefined) {
      row.append(text, toggle);
    } else {
      const cell = document.createElement('div');
      cell.className = 'settings-row-label-cell';
      cell.append(text, helpTip(t(hint)));
      row.append(cell, toggle);
    }
    return row;
  }

  private labelsRow(): HTMLDivElement {
    return this.toggleRow('detailed-labels', 'settings.detailedLabels', this.host.detailedLabels(),
      (on) => this.host.setDetailedLabels(on), 'settings.detailedLabelsHelp');
  }

  private wheelZoomsRow(): HTMLDivElement {
    return this.toggleRow('wheel-zooms', 'settings.wheelZooms', this.host.wheelZooms(),
      (on) => this.host.setWheelZooms(on), 'settings.wheelZoomsHelp');
  }

  private compactRowsRow(): HTMLDivElement {
    return this.toggleRow('compact-rows', 'settings.compactRows', this.host.compactRows(),
      (on) => this.host.setCompactRows(on), 'settings.compactRowsHelp');
  }

  private hideIdleRow(): HTMLDivElement {
    return this.toggleRow('hide-idle', 'settings.hideIdle', this.host.hideIdle(),
      (on) => this.host.setHideIdle(on), 'settings.hideIdleHelp');
  }

  private developerToolsRow(): HTMLDivElement {
    return this.toggleRow('developer-tools', 'settings.developerTools', this.host.developerTools(),
      (on) => this.host.setDeveloperTools(on), 'settings.developerToolsWhere');
  }

  private clearCacheRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const cell = document.createElement('div');
    cell.className = 'settings-row-label-cell';
    cell.append(this.rowLabel('settings.savedData'), helpTip(t('settings.savedDataHelp')));
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'settings-action danger';
    action.dataset.settingsKey = 'clear-cache';
    action.textContent = t('settings.clearCache');
    action.addEventListener('click', () => this.host.clearCache());
    row.append(cell, action);
    return row;
  }

  private aboutBlock(): HTMLElement {
    const view = aboutView();
    const block = document.createElement('div');
    block.className = 'settings-about';
    block.dataset.settingsKey = 'about';
    block.tabIndex = -1;
    block.append(
      this.aboutLine('about-name', `${view.name} — ${view.subtitle}`, false),
      this.aboutLine('about-meta', view.version, false),
      this.aboutLine('about-meta', view.license),
      this.aboutLine('about-meta', view.copyright, false),
      this.aboutLinks(view.links),
    );
    return block;
  }

  private aboutLine(className: string, text: string, translated = true): HTMLParagraphElement {
    const line = document.createElement('p');
    line.className = className;
    line.textContent = text;
    if (!translated) line.translate = false;
    return line;
  }

  private aboutLinks(links: readonly AboutLink[]): HTMLUListElement {
    const list = document.createElement('ul');
    list.className = 'about-links';
    list.append(...links.map((link) => {
      const item = document.createElement('li');
      const anchor = document.createElement('a');
      anchor.href = link.href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = link.label;
      item.appendChild(anchor);
      return item;
    }));
    return list;
  }
}
