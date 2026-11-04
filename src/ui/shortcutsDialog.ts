import { t } from './i18n.js';
import { SHORTCUTS, type ShortcutEntry } from './shortcuts.js';

export function shortcutActionText(entry: ShortcutEntry): string {
  return entry.labels.map((key) => t(key)).join(' / ');
}

export class ShortcutsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly list: HTMLUListElement;
  private readonly closeButton: HTMLButtonElement;
  private invoker: HTMLElement | null = null;

  constructor() {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'shortcuts-dialog';
    this.dialog.setAttribute('aria-labelledby', 'shortcuts-title');

    const form = document.createElement('div');
    form.className = 'shortcuts-form';

    const header = document.createElement('header');
    header.className = 'shortcuts-header';
    this.title = document.createElement('h2');
    this.title.id = 'shortcuts-title';
    header.appendChild(this.title);

    this.list = document.createElement('ul');
    this.list.className = 'shortcuts-list';

    const actions = document.createElement('footer');
    actions.className = 'shortcuts-actions';
    this.closeButton = document.createElement('button');
    this.closeButton.className = 'shortcuts-close';
    this.closeButton.type = 'button';
    actions.appendChild(this.closeButton);

    form.append(header, this.list, actions);
    this.dialog.appendChild(form);
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

  open(anchor: HTMLElement | null): void {
    this.invoker = anchor;
    this.renderStrings();
    this.dialog.showModal();
    this.closeButton.focus({ preventScroll: true });
  }

  close(): void {
    const invoker = this.invoker;
    this.invoker = null;
    if (this.dialog.open) this.dialog.close();
    if (invoker?.isConnected) invoker.focus();
  }

  renderStrings(): void {
    this.title.textContent = t('shortcuts.title');
    this.closeButton.textContent = t('shortcuts.close');
    const rows = SHORTCUTS.map((entry) => {
      const row = document.createElement('li');
      row.className = 'shortcuts-row';
      const action = document.createElement('span');
      action.className = 'shortcuts-action';
      action.textContent = shortcutActionText(entry);
      const key = document.createElement('kbd');
      key.className = 'shortcuts-key';
      key.textContent = entry.notation;
      row.append(action, key);
      return row;
    });
    this.list.replaceChildren(...rows);
  }
}
