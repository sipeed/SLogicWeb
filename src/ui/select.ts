import { fuzzyRank, highlightRuns } from './fuzzy.js';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export type SelectOptionTuple = readonly [value: string, label: string];

export interface SelectSearch {
  readonly label: string;
  readonly placeholder: string;
  readonly empty: string;
}

export interface SelectConfig {
  readonly search?: SelectSearch;
}

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
  private readonly labelTexts: readonly string[];
  private readonly search: SelectSearch | null;
  private readonly trigger: HTMLButtonElement;
  private readonly valueEl: HTMLSpanElement;
  private readonly popover: HTMLDivElement;
  private readonly group: HTMLDivElement;
  private readonly searchInput: HTMLInputElement | null;
  private readonly emptyEl: HTMLDivElement | null;
  private readonly items: HTMLDivElement[] = [];
  private readonly checks: HTMLSpanElement[] = [];
  private readonly labels: HTMLSpanElement[] = [];
  private readonly labelId: string;
  private readonly listboxId: string;
  private readonly surfaceId: string;
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
    config?: SelectConfig,
  ) {
    super();
    this.key = key;
    this.options = normalizeOptions(options);
    this.labelTexts = this.options.map((option) => option.label);
    this.search = config?.search ?? null;
    this.current = this.options.some((option) => option.value === value) ? value : '';

    const uid = ++nextId;
    const anchor = `--select-anchor-${uid}`;
    this.labelId = `select-${uid}-label`;
    this.listboxId = `select-${uid}-listbox`;
    this.surfaceId = `select-${uid}-surface`;
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
    if (this.search === null) trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', this.listboxId);
    trigger.setAttribute('popovertarget', this.surfaceId);
    trigger.style.setProperty('--select-anchor', anchor);

    const valueEl = document.createElement('span');
    valueEl.className = 'select-value';

    trigger.append(valueEl, buildChevron());

    const popover = document.createElement('div');
    popover.id = this.surfaceId;
    popover.className = 'select-popover';
    popover.setAttribute('popover', 'auto');
    popover.style.setProperty('--select-anchor', anchor);

    const search = this.search;
    let searchInput: HTMLInputElement | null = null;
    let emptyEl: HTMLDivElement | null = null;
    if (search !== null) {
      popover.classList.add('select-searchable');
      const searchRow = document.createElement('div');
      searchRow.className = 'select-search';
      const input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-expanded', 'true');
      input.setAttribute('aria-controls', this.listboxId);
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-label', search.label);
      input.placeholder = search.placeholder;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.addEventListener('input', () => this.applyQuery());
      input.addEventListener('keydown', (event) => this.onSearchKeyDown(event));
      searchRow.appendChild(input);
      popover.appendChild(searchRow);
      searchInput = input;
    }

    const group = document.createElement('div');
    group.className = 'select-group';
    group.id = this.listboxId;
    group.setAttribute('role', 'listbox');
    group.setAttribute('aria-labelledby', this.labelId);

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
      this.labels.push(text);
    });

    popover.appendChild(group);

    if (search !== null) {
      const empty = document.createElement('div');
      empty.className = 'select-empty';
      empty.setAttribute('role', 'status');
      empty.hidden = true;
      popover.appendChild(empty);
      emptyEl = empty;
    }

    el.append(labelEl, trigger, popover);

    this.el = el;
    this.trigger = trigger;
    this.valueEl = valueEl;
    this.popover = popover;
    this.group = group;
    this.searchInput = searchInput;
    this.emptyEl = emptyEl;

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

  private visibleIndices(): number[] {
    const visible: number[] = [];
    this.items.forEach((item, index) => {
      if (!item.hidden) visible.push(index);
    });
    return visible;
  }

  private setActive(index: number): void {
    if (index < 0 || index >= this.options.length) return;
    this.active = index;
    this.items.forEach((item, i) => item.classList.toggle('active', i === index));
    if (this.isOpen()) {
      const owner = this.searchInput ?? this.trigger;
      owner.setAttribute('aria-activedescendant', this.items[index].id);
      this.items[index].scrollIntoView({ block: 'nearest' });
    }
  }

  private clearActive(): void {
    this.active = -1;
    this.items.forEach((item) => item.classList.remove('active'));
    this.trigger.removeAttribute('aria-activedescendant');
    this.searchInput?.removeAttribute('aria-activedescendant');
  }

  private moveActive(delta: number): void {
    if (this.search === null) {
      this.setActive(moveActiveIndex(this.active, delta, this.options.length));
      return;
    }
    const visible = this.visibleIndices();
    const position = visible.indexOf(this.active);
    const next = moveActiveIndex(position, delta, visible.length);
    if (next >= 0) this.setActive(visible[next]);
  }

  private paintLabel(index: number, positions: readonly number[] | null): void {
    const labelEl = this.labels[index];
    const label = this.options[index].label;
    if (positions === null || positions.length === 0) {
      labelEl.textContent = label;
      return;
    }
    labelEl.replaceChildren();
    for (const run of highlightRuns(positions, label.length)) {
      if (!run.hit) {
        labelEl.appendChild(document.createTextNode(label.slice(run.start, run.start + run.length)));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'select-item-hit';
      span.textContent = label.slice(run.start, run.start + run.length);
      labelEl.appendChild(span);
    }
  }

  private restoreFullList(): void {
    this.items.forEach((item, index) => {
      item.hidden = false;
      this.group.appendChild(item);
      this.paintLabel(index, null);
    });
    if (this.emptyEl !== null) this.emptyEl.hidden = true;
  }

  private applyQuery(): void {
    const input = this.searchInput;
    const search = this.search;
    if (input === null || search === null) return;
    const query = input.value;
    if (query === '') {
      this.restoreFullList();
      const selected = this.selectedIndex();
      this.setActive(selected >= 0 ? selected : 0);
      return;
    }
    const ranks = fuzzyRank(query, this.labelTexts);
    const hit = new Set(ranks.map((rank) => rank.index));
    this.items.forEach((item, index) => {
      item.hidden = !hit.has(index);
    });
    for (const rank of ranks) {
      this.group.appendChild(this.items[rank.index]);
      this.paintLabel(rank.index, rank.positions);
    }
    if (this.emptyEl !== null) {
      this.emptyEl.hidden = ranks.length > 0;
      if (ranks.length === 0) {
        this.emptyEl.textContent = search.empty.split('{query}').join(query);
      }
    }
    if (ranks.length === 0) this.clearActive();
    else this.setActive(ranks[0].index);
  }

  private onToggle(state: string): void {
    const open = state === 'open';
    this.trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const selected = this.selectedIndex();
      const active = this.active >= 0 ? this.active : selected >= 0 ? selected : 0;
      this.setActive(active);
      this.searchInput?.focus();
    } else {
      this.clearActive();
      this.prefix = '';
      if (this.search !== null) this.restoreFullList();
      if (this.searchInput !== null) this.searchInput.value = '';
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
      const visible = this.visibleIndices();
      if (visible.length === 0) return;
      this.setActive(key === 'Home' ? visible[0] : visible[visible.length - 1]);
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
    if (this.search !== null && this.searchInput !== null) {
      this.open();
      this.searchInput.focus();
      this.searchInput.value = key;
      this.applyQuery();
      return;
    }
    const now = Date.now();
    if (now - this.prefixAt > TYPEAHEAD_RESET_MS) this.prefix = '';
    this.prefix = nextTypeaheadPrefix(this.prefix, key);
    this.prefixAt = now;
    if (!this.isOpen()) this.open();
    const from = this.active >= 0 ? this.active : this.selectedIndex();
    const match = matchPrefix(this.options, this.prefix, from);
    if (match >= 0) this.setActive(match);
  }

  private onSearchKeyDown(event: KeyboardEvent): void {
    if (this.disabledState) return;
    const input = this.searchInput;
    if (input === null) return;
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      this.moveActive(key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (key === 'Home' || key === 'End') {
      const visible = this.visibleIndices();
      if (visible.length === 0) return;
      event.preventDefault();
      this.setActive(key === 'Home' ? visible[0] : visible[visible.length - 1]);
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      if (this.active >= 0 && this.visibleIndices().includes(this.active)) this.commit(this.active);
      return;
    }
    if (key === 'Escape') {
      event.preventDefault();
      if (input.value !== '') {
        input.value = '';
        this.applyQuery();
        return;
      }
      this.close();
      if (this.el.isConnected) this.trigger.focus();
      return;
    }
    if (key === 'Tab') {
      this.close();
      this.trigger.focus();
      return;
    }
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
  config?: SelectConfig,
): SelectControl {
  return new SelectControl(key, label, options, value, config);
}
