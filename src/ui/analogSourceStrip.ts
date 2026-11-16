import { t } from './i18n.js';

export interface AnalogSourceStripItem {
  busId: string;
  name: string;
  color: string;
  focused: boolean;
}

export interface AnalogSourceStripCallbacks {
  onFocus(busId: string): void;
}

export class AnalogSourceStrip {
  private readonly root: HTMLDivElement;

  constructor(container: HTMLElement, private readonly cb: AnalogSourceStripCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'analog-source-strip';
    this.root.setAttribute('role', 'group');
    this.root.hidden = true;
    container.appendChild(this.root);
  }

  get element(): HTMLDivElement {
    return this.root;
  }

  render(items: readonly AnalogSourceStripItem[]): void {
    const active = document.activeElement as HTMLElement | null;
    const kept = active !== null && this.root.contains(active) ? active.dataset.busId : undefined;
    const label = t('bus.sourceStrip');
    if (this.root.getAttribute('aria-label') !== label) this.root.setAttribute('aria-label', label);
    this.root.hidden = items.length === 0;
    this.root.replaceChildren();
    for (const item of items) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'analog-source-chip';
      chip.dataset.busId = item.busId;
      chip.setAttribute('aria-pressed', item.focused ? 'true' : 'false');
      chip.setAttribute('aria-label', t('bus.focusSource', { name: item.name }));
      if (item.focused) chip.classList.add('focused');
      const swatch = document.createElement('span');
      swatch.className = 'analog-source-swatch';
      swatch.style.background = item.color;
      swatch.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'analog-source-name';
      name.textContent = item.name;
      chip.append(swatch, name);
      chip.addEventListener('pointerdown', (event) => event.stopPropagation());
      chip.addEventListener('dblclick', (event) => event.stopPropagation());
      chip.addEventListener('click', () => this.cb.onFocus(item.busId));
      this.root.appendChild(chip);
    }
    if (kept === undefined) return;
    const again = [...this.root.children].find((child) =>
      (child as HTMLElement).dataset.busId === kept) as HTMLElement | undefined;
    again?.focus({ preventScroll: true });
  }
}
