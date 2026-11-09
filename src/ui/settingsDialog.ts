import { t } from './i18n.js';
import type { MessageKey } from './i18n.js';

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

export const SETTINGS_SECTIONS = ['appearance', 'general'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

const SECTION_LABELS: Record<SettingsSectionId, MessageKey> = {
  appearance: 'settings.sections.appearance',
  general: 'settings.sections.general',
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
  openShortcuts(invoker: HTMLElement): void;
  openAbout(invoker: HTMLElement): void;
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
    if (section === 'appearance') {
      return [this.labelsRow(), this.wheelZoomsRow(), this.compactRowsRow(), this.hideIdleRow()];
    }
    return [this.developerToolsRow(), this.shortcutsRow(), this.aboutRow()];
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
    row.append(text, toggle);
    return row;
  }

  private labelsRow(): HTMLDivElement {
    return this.toggleRow('detailed-labels', 'settings.detailedLabels', this.host.detailedLabels(),
      (on) => this.host.setDetailedLabels(on));
  }

  private wheelZoomsRow(): HTMLDivElement {
    return this.toggleRow('wheel-zooms', 'settings.wheelZooms', this.host.wheelZooms(),
      (on) => this.host.setWheelZooms(on));
  }

  private compactRowsRow(): HTMLDivElement {
    return this.toggleRow('compact-rows', 'settings.compactRows', this.host.compactRows(),
      (on) => this.host.setCompactRows(on));
  }

  private hideIdleRow(): HTMLDivElement {
    return this.toggleRow('hide-idle', 'settings.hideIdle', this.host.hideIdle(),
      (on) => this.host.setHideIdle(on));
  }

  private developerToolsRow(): HTMLDivElement {
    return this.toggleRow('developer-tools', 'settings.developerTools', this.host.developerTools(),
      (on) => this.host.setDeveloperTools(on));
  }

  private shortcutsRow(): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-row settings-row--action';
    row.dataset.settingsKey = 'shortcuts';
    const hint = document.createElement('span');
    hint.className = 'settings-row-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '▸';
    row.append(this.rowLabel('settings.shortcuts'), hint);
    row.addEventListener('click', () => this.host.openShortcuts(row));
    return row;
  }

  private aboutRow(): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-row settings-row--action';
    row.dataset.settingsKey = 'about';
    const hint = document.createElement('span');
    hint.className = 'settings-row-hint';
    hint.setAttribute('aria-hidden', 'true');
    hint.textContent = '▸';
    row.append(this.rowLabel('settings.about'), hint);
    row.addEventListener('click', () => this.host.openAbout(row));
    return row;
  }
}
