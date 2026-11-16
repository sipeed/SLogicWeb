// SPDX-License-Identifier: GPL-3.0-or-later

import { t, type MessageKey } from './i18n.js';
import {
  MEASUREMENT_CATALOG, catalogEntry,
  type MeasurementGroup, type MeasurementParameter,
} from './measurementCatalog.js';
import type { MeasurementRow } from './measurementRows.js';
import type {
  MeasurementSectionView, MeasurementSource,
} from './measurementState.js';
import { selectControl, type SelectControl, type SelectOptionTuple } from './select.js';

export const MEASUREMENT_CATALOG_GROUPS: readonly MeasurementGroup[] = ['vertical', 'horizontal'];

const GROUP_LABELS: Record<MeasurementGroup, MessageKey> = {
  vertical: 'capturePanel.measureCatalogVertical',
  horizontal: 'capturePanel.measureCatalogHorizontal',
};

export interface MeasurementCatalogView {
  sources: readonly MeasurementSource[];
  start: number | null;
  rows: readonly MeasurementRow[];
}

export interface MeasurementCatalogCallbacks {
  onToggle(start: number, parameter: MeasurementParameter): void;
  onPickSource(start: number): void;
}

export function measurementCatalogView(view: MeasurementSectionView): MeasurementCatalogView {
  const start = view.addStart ?? view.sources[0]?.start ?? null;
  return { sources: view.sources, start, rows: view.allRows };
}

function sourcesKey(sources: readonly MeasurementSource[]): string {
  return sources.map((source) => `${source.start}:${source.name}`).join('|');
}

function rowKey(start: number, parameter: MeasurementParameter): string {
  return `${start}:${parameter}`;
}

export class MeasurementCatalogDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly body: HTMLDivElement;
  private readonly done: HTMLButtonElement;
  private source: SelectControl | null = null;
  private field: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private view: MeasurementCatalogView | null = null;
  private start: number | null = null;
  private invoker: HTMLElement | null = null;
  private sourceKey = '';

  constructor(private readonly cb: MeasurementCatalogCallbacks) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'shortcuts-dialog measure-catalog-dialog';
    this.dialog.dataset.measureCatalog = '';
    this.dialog.setAttribute('aria-labelledby', 'measure-catalog-title');

    const form = document.createElement('div');
    form.className = 'shortcuts-form';
    const header = document.createElement('header');
    header.className = 'shortcuts-header';
    this.title = document.createElement('h2');
    this.title.id = 'measure-catalog-title';
    header.appendChild(this.title);

    this.body = document.createElement('div');
    this.body.className = 'measure-catalog-body';

    const footer = document.createElement('footer');
    footer.className = 'shortcuts-actions';
    this.done = document.createElement('button');
    this.done.type = 'button';
    this.done.className = 'shortcuts-close';
    this.done.dataset.measureCatalogDone = '';
    this.done.addEventListener('click', () => this.close());
    footer.appendChild(this.done);

    form.append(header, this.body, footer);
    this.dialog.appendChild(form);
    document.body.appendChild(this.dialog);

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

  open(view: MeasurementCatalogView, invoker: HTMLElement | null): void {
    this.view = view;
    this.invoker = invoker;
    this.start = this.validStart(view, view.start);
    const wasOpen = this.dialog.open;
    this.render();
    if (wasOpen) return;
    this.dialog.showModal();
    this.focusEntry();
  }

  update(view: MeasurementCatalogView): void {
    this.view = view;
    if (this.invoker !== null && !this.invoker.isConnected) this.invoker = null;
    this.start = this.validStart(view, this.start);
    if (!this.dialog.open) return;
    const retranslated = this.title.textContent !== t('capturePanel.measureCatalogTitle');
    if (retranslated || sourcesKey(view.sources) !== this.sourceKey) {
      this.render();
      return;
    }
    if (this.source !== null) {
      this.source.value = this.start === null ? '' : String(this.start);
    }
    this.syncChecks();
  }

  close(): void {
    const invoker = this.invoker;
    this.invoker = null;
    if (!this.dialog.open) return;
    this.dialog.close();
    const target = invoker?.isConnected === true
      ? invoker
      : document.querySelector<HTMLElement>('[data-measure-open]');
    target?.focus({ preventScroll: true });
  }

  private validStart(view: MeasurementCatalogView, start: number | null): number | null {
    if (start !== null && view.sources.some((source) => source.start === start)) return start;
    return view.sources[0]?.start ?? null;
  }

  private sourceTrigger(): HTMLElement | null {
    return this.source?.el.querySelector<HTMLElement>('.select-trigger') ?? null;
  }

  private focusEntry(): void {
    this.sourceTrigger()?.focus({ preventScroll: true });
    if (!this.dialog.contains(document.activeElement)) this.done.focus({ preventScroll: true });
  }

  private render(): void {
    const view = this.view;
    if (view === null) return;
    const focused = this.focusedKey();
    this.title.textContent = t('capturePanel.measureCatalogTitle');
    this.done.textContent = t('capturePanel.measureCatalogDone');
    this.renderSource(view);
    this.renderList(view);
    if (this.field !== null && this.list !== null) {
      this.body.replaceChildren(this.field, this.list);
    }
    this.syncChecks();
    if (this.dialog.open) this.restoreFocus(focused);
  }

  private renderSource(view: MeasurementCatalogView): void {
    const options: SelectOptionTuple[] = view.sources.map(
      (source): SelectOptionTuple => [String(source.start), source.name]);
    const source = selectControl(
      'measure.catalogSource',
      t('capturePanel.measureCatalogSource'),
      options,
      this.start === null ? '' : String(this.start),
    );
    source.el.dataset.measureKey = 'source';
    source.disabled = view.sources.length === 0;
    source.addEventListener('change', () => {
      const picked = Number(source.value);
      if (!Number.isSafeInteger(picked)) return;
      this.pickSource(picked);
    });
    this.source = source;
    this.sourceKey = sourcesKey(view.sources);
    const field = document.createElement('div');
    field.className = 'measure-catalog-source';
    field.appendChild(source.el);
    this.field = field;
  }

  private renderList(view: MeasurementCatalogView): void {
    const list = document.createElement('div');
    list.className = 'measure-catalog-list';
    for (const group of MEASUREMENT_CATALOG_GROUPS) {
      const heading = document.createElement('h3');
      heading.className = 'shortcuts-section';
      heading.textContent = t(GROUP_LABELS[group]);
      const block = document.createElement('div');
      block.className = 'measure-catalog-group';
      for (const entry of MEASUREMENT_CATALOG) {
        if (entry.group !== group) continue;
        block.appendChild(this.parameterRow(entry.parameter));
      }
      list.append(heading, block);
    }
    this.list = list;
    this.syncChecks(view);
  }

  private methodText(parameter: MeasurementParameter): string {
    return t(catalogEntry(parameter).descriptionKey as MessageKey);
  }

  private parameterRow(parameter: MeasurementParameter): HTMLElement {
    const row = document.createElement('label');
    row.className = 'measure-catalog-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'measure-catalog-check';
    input.dataset.measureKey = parameter;
    input.dataset.measureParameter = parameter;
    input.addEventListener('keydown', (event) => {
      if (event.key === ' ') event.stopPropagation();
    });
    input.addEventListener('change', () => {
      if (this.start === null) return;
      this.cb.onToggle(this.start, parameter);
    });
    const text = document.createElement('span');
    text.className = 'measure-catalog-text';
    const name = document.createElement('span');
    name.className = 'measure-catalog-param';
    name.textContent = t(catalogEntry(parameter).labelKey as MessageKey);
    const method = document.createElement('span');
    method.className = 'measure-catalog-method';
    method.textContent = this.methodText(parameter);
    text.append(name, method);
    row.append(input, text);
    return row;
  }

  private pickSource(start: number): void {
    const view = this.view;
    if (view === null || !view.sources.some((source) => source.start === start)) return;
    const changed = start !== this.start;
    this.start = start;
    this.syncChecks();
    if (changed) this.cb.onPickSource(start);
  }

  private syncChecks(view: MeasurementCatalogView | null = this.view): void {
    if (view === null || this.list === null) return;
    const taken = new Set(view.rows.map((row) => rowKey(row.start, row.parameter)));
    for (const input of this.list.querySelectorAll<HTMLInputElement>('.measure-catalog-check')) {
      const parameter = input.dataset.measureParameter ?? '';
      const entry = MEASUREMENT_CATALOG.find((candidate) => candidate.parameter === parameter);
      if (entry === undefined) continue;
      input.disabled = this.start === null;
      input.checked = this.start !== null && taken.has(rowKey(this.start, entry.parameter));
    }
  }

  private focusedKey(): string | null {
    const active = document.activeElement as unknown as {
      closest?: (selector: string) => { dataset?: Record<string, string | undefined> } | null;
    } | null;
    if (!active || typeof active.closest !== 'function') return null;
    return active.closest('[data-measure-key]')?.dataset?.measureKey ?? null;
  }

  private restoreFocus(key: string | null): void {
    if (key === null || key === 'source') {
      this.focusEntry();
      return;
    }
    const row = this.list?.querySelector<HTMLElement>(`[data-measure-key="${key}"]`) ?? null;
    if (row === null) this.focusEntry();
    else row.focus({ preventScroll: true });
  }
}
