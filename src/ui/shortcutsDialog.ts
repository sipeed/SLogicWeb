import { t } from './i18n.js';
import { SHORTCUTS, referenceGestures, type GestureEntry, type ShortcutEntry } from './shortcuts.js';

export function shortcutActionText(entry: ShortcutEntry | GestureEntry): string {
  return entry.labels.map((key) => t(key)).join(' / ');
}

export function gestureNotation(entry: GestureEntry): string {
  return [...entry.modifiers, t(entry.input)].join(' + ');
}

export class ShortcutsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly list: HTMLUListElement;
  private readonly keysHeading: HTMLHeadingElement;
  private readonly mouseHeading: HTMLHeadingElement;
  private readonly mouseList: HTMLUListElement;
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

    this.keysHeading = document.createElement('h3');
    this.keysHeading.className = 'shortcuts-section';
    this.list = document.createElement('ul');
    this.list.className = 'shortcuts-list';
    this.mouseHeading = document.createElement('h3');
    this.mouseHeading.className = 'shortcuts-section';
    this.mouseList = document.createElement('ul');
    this.mouseList.className = 'shortcuts-list';

    const actions = document.createElement('footer');
    actions.className = 'shortcuts-actions';
    this.closeButton = document.createElement('button');
    this.closeButton.className = 'shortcuts-close';
    this.closeButton.type = 'button';
    actions.appendChild(this.closeButton);

    form.append(header, this.keysHeading, this.list, this.mouseHeading, this.mouseList, actions);
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

  open(anchor: HTMLElement | null, wheelZooms = false): void {
    this.invoker = anchor;
    this.renderStrings(wheelZooms);
    this.dialog.showModal();
    this.closeButton.focus({ preventScroll: true });
  }

  close(): void {
    const invoker = this.invoker;
    this.invoker = null;
    if (this.dialog.open) this.dialog.close();
    if (invoker?.isConnected) invoker.focus();
  }

  renderStrings(wheelZooms = false): void {
    this.title.textContent = t('shortcuts.title');
    this.closeButton.textContent = t('shortcuts.close');
    this.keysHeading.textContent = t('shortcuts.keyboard');
    this.mouseHeading.textContent = t('shortcuts.mouse');
    const rows = SHORTCUTS.map((entry) => this.row(shortcutActionText(entry), entry.notation));
    this.list.replaceChildren(...rows);
    const gestures = referenceGestures(wheelZooms)
      .map((entry) => this.row(shortcutActionText(entry), gestureNotation(entry)));
    this.mouseList.replaceChildren(...gestures);
  }

  private row(actionText: string, notation: string): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'shortcuts-row';
    const action = document.createElement('span');
    action.className = 'shortcuts-action';
    action.textContent = actionText;
    const key = document.createElement('kbd');
    key.className = 'shortcuts-key';
    key.textContent = notation;
    row.append(action, key);
    return row;
  }
}
