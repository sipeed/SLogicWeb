import { t } from './i18n.js';

export const SETTINGS_DIALOG_ID = 'settings-dialog';
export const SETTINGS_DIALOG_WIDTH = 560;
export const SETTINGS_DIALOG_HEIGHT = 360;
export const SETTINGS_NAV_WIDTH = 152;

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SettingsDialogHost {
  detailedLabels(): boolean;
  setDetailedLabels(on: boolean): void;
  openShortcuts(invoker: HTMLElement): void;
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
    this.focusRow(null);
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
    this.body.replaceChildren(this.appearancePane());
    if (restore !== undefined) this.focusRow(restore);
  }

  private focusRow(key: string | null): void {
    const rows = [...this.body.querySelectorAll<HTMLElement>('[data-settings-key]')];
    const row = key === null
      ? rows[0]
      : rows.find((candidate) => candidate.dataset.settingsKey === key) ?? rows[0];
    (row ?? this.closeButton).focus({ preventScroll: true });
  }

  private appearancePane(): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'settings-pane';
    pane.append(this.labelsRow(), this.shortcutsRow());
    return pane;
  }

  private labelsRow(): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-item';
    row.dataset.settingsKey = 'detailedLabels';
    const check = document.createElement('span');
    check.className = 'settings-check';
    check.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = t('settings.detailedLabels');
    row.append(check, label);
    const paint = (): void => {
      const on = this.host.detailedLabels();
      check.textContent = on ? '✓' : '';
      row.setAttribute('aria-pressed', String(on));
    };
    paint();
    row.addEventListener('click', () => {
      this.host.setDetailedLabels(!this.host.detailedLabels());
      paint();
    });
    return row;
  }

  private shortcutsRow(): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-item';
    row.dataset.settingsKey = 'shortcuts';
    const check = document.createElement('span');
    check.className = 'settings-check';
    check.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = t('settings.shortcuts');
    const hint = document.createElement('span');
    hint.className = 'settings-hint';
    hint.textContent = '▸';
    row.append(check, label, hint);
    row.addEventListener('click', () => this.host.openShortcuts(row));
    return row;
  }
}
