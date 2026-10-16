export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export type SelectOptionTuple = readonly [value: string, label: string];

export const TYPEAHEAD_RESET_MS = 800;

const SVG_NS = 'http://www.w3.org/2000/svg';

export function moveActiveIndex(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta >= 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

export function matchPrefix(options: readonly SelectOption[], prefix: string, from: number): number {
  if (prefix.length === 0 || options.length === 0) return -1;
  const needle = prefix.toLowerCase();
  for (let step = 1; step <= options.length; step++) {
    const index = (((from + step) % options.length) + options.length) % options.length;
    const option = options[index];
    if (option !== undefined && option.label.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

export function nextTypeaheadPrefix(prefix: string, key: string): string {
  const next = key.toLowerCase();
  if (next.length === 1 && prefix.length > 0 && [...prefix].every((char) => char === next)) {
    return next;
  }
  return `${prefix}${next}`;
}

export function resolveLabel(options: readonly SelectOption[], value: string): string {
  for (const option of options) {
    if (option.value === value) return option.label;
  }
  return '';
}

function normalizeOptions(options: readonly SelectOptionTuple[]): readonly SelectOption[] {
  return options.map(([value, label]) => ({ value, label }));
}

function buildChevron(): SVGSVGElement {
  const chevron = document.createElementNS(SVG_NS, 'svg');
  chevron.setAttribute('class', 'select-trigger-icon');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('aria-hidden', 'true');
  chevron.setAttribute('focusable', 'false');
  chevron.setAttribute('data-icon', 'inline-end');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'm6 9 6 6 6-6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  chevron.appendChild(path);
  return chevron;
}

let nextId = 0;

export class SelectControl extends EventTarget {
  readonly el: HTMLDivElement;
  private readonly key: string;
  private readonly options: readonly SelectOption[];
  private readonly trigger: HTMLButtonElement;
  private readonly valueEl: HTMLSpanElement;
  private readonly popover: HTMLDivElement;
  private readonly items: HTMLDivElement[] = [];
  private readonly checks: HTMLSpanElement[] = [];
  private readonly labelId: string;
  private readonly listboxId: string;
  private current: string;
  private active = -1;
  private disabledState = false;
  private prefix = '';
  private prefixAt = 0;

  constructor(
    key: string,
    label: string,
    options: readonly SelectOptionTuple[],
    value: string,
  ) {
    super();
    this.key = key;
    this.options = normalizeOptions(options);
    this.current = this.options.some((option) => option.value === value) ? value : '';

    const uid = ++nextId;
    const anchor = `--select-anchor-${uid}`;
    this.labelId = `select-${uid}-label`;
    this.listboxId = `select-${uid}-listbox`;
    const triggerId = `select-${uid}-trigger`;

    const el = document.createElement('div');
    el.className = 'field select-field';

    const labelEl = document.createElement('label');
    labelEl.id = this.labelId;
    labelEl.htmlFor = triggerId;
    labelEl.textContent = label;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = triggerId;
    trigger.className = 'select-trigger';
    trigger.dataset.selectKey = key;
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', this.listboxId);
    trigger.setAttribute('popovertarget', this.listboxId);
    trigger.style.setProperty('--select-anchor', anchor);

    const valueEl = document.createElement('span');
    valueEl.className = 'select-value';

    trigger.append(valueEl, buildChevron());

    const popover = document.createElement('div');
    popover.id = this.listboxId;
    popover.className = 'select-popover';
    popover.setAttribute('popover', 'auto');
    popover.setAttribute('role', 'listbox');
    popover.setAttribute('aria-labelledby', this.labelId);
    popover.style.setProperty('--select-anchor', anchor);

    const group = document.createElement('div');
    group.className = 'select-group';
    group.setAttribute('role', 'group');

    this.options.forEach((option, index) => {
      const item = document.createElement('div');
      item.id = `select-${uid}-option-${index}`;
      item.className = 'select-item';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', option.value === this.current ? 'true' : 'false');

      const check = document.createElement('span');
      check.className = 'select-item-check';
      check.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'select-item-label';
      text.textContent = option.label;

      item.append(check, text);
      item.addEventListener('pointerdown', (event) => event.preventDefault());
      item.addEventListener('click', () => this.commit(index));

      group.appendChild(item);
      this.items.push(item);
      this.checks.push(check);
    });

    popover.appendChild(group);
    el.append(labelEl, trigger, popover);

    this.el = el;
    this.trigger = trigger;
    this.valueEl = valueEl;
    this.popover = popover;

    popover.addEventListener('toggle', (event) => this.onToggle((event as ToggleEvent).newState));
    trigger.addEventListener('keydown', (event) => this.onTriggerKeyDown(event));

    this.syncPresentation();
  }

  get value(): string {
    return this.current;
  }

  set value(next: string) {
    this.current = this.options.some((option) => option.value === next) ? next : '';
    this.syncPresentation();
  }

  get disabled(): boolean {
    return this.disabledState;
  }

  set disabled(next: boolean) {
    this.disabledState = next;
    this.trigger.disabled = next;
    if (next) this.close();
  }

  open(): void {
    if (this.disabledState || !this.popover.isConnected || this.isOpen()) return;
    this.popover.showPopover();
  }

  close(): void {
    if (!this.popover.isConnected || !this.isOpen()) return;
    this.popover.hidePopover();
  }

  private isOpen(): boolean {
    return this.popover.matches(':popover-open');
  }

  private selectedIndex(): number {
    return this.options.findIndex((option) => option.value === this.current);
  }

  private setActive(index: number): void {
    if (index < 0 || index >= this.options.length) return;
    this.active = index;
    this.items.forEach((item, i) => item.classList.toggle('active', i === index));
    if (this.isOpen()) {
      this.trigger.setAttribute('aria-activedescendant', this.items[index].id);
      this.items[index].scrollIntoView({ block: 'nearest' });
    }
  }

  private moveActive(delta: number): void {
    this.setActive(moveActiveIndex(this.active, delta, this.options.length));
  }

  private onToggle(state: string): void {
    const open = state === 'open';
    this.trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const selected = this.selectedIndex();
      const active = this.active >= 0 ? this.active : selected >= 0 ? selected : 0;
      this.setActive(active);
    } else {
      this.active = -1;
      this.items.forEach((item) => item.classList.remove('active'));
      this.trigger.removeAttribute('aria-activedescendant');
      this.prefix = '';
    }
  }

  private onTriggerKeyDown(event: KeyboardEvent): void {
    if (this.disabledState) return;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      if (this.isOpen()) this.moveActive(key === 'ArrowDown' ? 1 : -1);
      else this.open();
      return;
    }
    if (key === 'Home' || key === 'End') {
      if (!this.isOpen()) return;
      event.preventDefault();
      this.setActive(key === 'Home' ? 0 : this.options.length - 1);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (this.isOpen()) this.commit(this.active >= 0 ? this.active : this.selectedIndex());
      else this.open();
      return;
    }
    if (key === 'Tab') {
      this.close();
      return;
    }
    if (key === 'Escape') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (key.length !== 1) return;
    const now = Date.now();
    if (now - this.prefixAt > TYPEAHEAD_RESET_MS) this.prefix = '';
    this.prefix = nextTypeaheadPrefix(this.prefix, key);
    this.prefixAt = now;
    if (!this.isOpen()) this.open();
    const from = this.active >= 0 ? this.active : this.selectedIndex();
    const match = matchPrefix(this.options, this.prefix, from);
    if (match >= 0) this.setActive(match);
  }

  private commit(index: number): void {
    if (this.disabledState) return;
    const option = this.options[index];
    if (option === undefined) return;
    const changed = option.value !== this.current;
    if (changed) {
      this.current = option.value;
      this.syncPresentation();
    }
    this.close();
    if (this.el.isConnected) this.trigger.focus();
    if (!changed) return;
    const scope = this.el.closest('.panel-host');
    this.dispatchEvent(new Event('change', { bubbles: true }));
    if (!this.trigger.isConnected) {
      const replacement = scope?.querySelector<HTMLElement>(
        `.select-trigger[data-select-key="${CSS.escape(this.key)}"]`,
      );
      if (replacement !== undefined && replacement !== null && replacement.isConnected) {
        replacement.focus();
      }
    }
  }

  private syncPresentation(): void {
    this.valueEl.textContent = resolveLabel(this.options, this.current);
    this.options.forEach((option, index) => {
      const selected = option.value === this.current;
      this.items[index].setAttribute('aria-selected', selected ? 'true' : 'false');
      this.checks[index].textContent = selected ? '✓' : '';
    });
  }
}

export function selectControl(
  key: string,
  label: string,
  options: readonly SelectOptionTuple[],
  value: string,
): SelectControl {
  return new SelectControl(key, label, options, value);
}
