// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Decode results": the listed events of the selected analyzer (DESIGN §6.5).
 *
 * It has a host of its own on the decoders page - the analyzer panel clears its root on
 * every render, and a list that rebuilt on each of those would lose its scroll, query
 * and selection. `update()` is cheap when nothing it reads changed.
 *
 * Bounded work, so a huge result never freezes the page:
 * - the list is virtual (fixed row height, only the visible rows plus overscan exist);
 * - filtering runs in slices of `FILTER_SLICE` annotations between macrotasks, and a
 *   newer query abandons an older pass;
 * - nothing here runs during a capture: results are cleared when one starts and only
 *   exist after a decode, which itself runs after the capture stopped.
 * Clipboard copies stop at `CLIPBOARD_LINE_CAP` lines and say so; Export writes all.
 */

import { displayRows, getDecoder, rowForClass } from '../decode/index.js';
import type { DecodeResult } from '../decode/index.js';
import { annotationTexts } from '../decode/index.js';
import { button, div, section } from './capturePanel.js';
import {
  CLIPBOARD_LINE_CAP, RESULT_ROW_HEIGHT, annotationLine, defaultResultRows, filterResults,
  joinTextLines, resultSeconds, resultsCsv, resultsText, usedRows, virtualWindow,
  type ExportNames, type ResultLine, type ResultSource,
} from './decodeResults.js';
import { formatCount, formatDuration } from './format.js';
import { t } from './i18n.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import type { AnalyzerState } from './state.js';

export interface DecodeResultsView {
  analyzers: readonly AnalyzerState[];
  selectedId: string | null;
  /** The displayed time origin (T, or the capture start) and the capture rate. */
  originSample: number;
  samplerate: number;
}

export interface DecodeResultsCallbacks {
  onSelect(id: string): void;
  /** Pan the plot to an annotation of the analyzer. */
  onJump(id: string, ann: number): void;
  /** The visible sample window, for the "visible window" range. */
  viewRange(): readonly [number, number] | null;
}

const FILTER_SLICE = 50_000;
const LIST_HEIGHT = 240;

type RowsChoice = 'default' | 'all' | `r${number}`;

export class DecodeResultsPanel {
  private el: HTMLElement | null = null;
  private analyzerId: string | null = null;
  private result: DecodeResult | null = null;
  private src: ResultSource | null = null;
  private order: ArrayLike<number> = [];
  private rowIds: string[] = [];
  private rowNames: string[] = [];
  private classNames: string[] = [];
  private used: number[] = [];
  private rowsChoice: RowsChoice = 'default';
  private textView = false;
  private rangeVisible = false;
  private query = '';
  private lines: ResultLine[] | null = null;
  /** Annotation indices that passed the filter (event view). */
  private hits: number[] = [];
  private filtering = false;
  private generation = 0;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Selected list positions. */
  private selected = new Set<number>();
  private anchor = -1;
  private origin = 0;
  private rate = 0;
  private message = '';

  private list!: HTMLDivElement;
  private spacer!: HTMLDivElement;
  private countEl!: HTMLDivElement;
  private messageEl!: HTMLSpanElement;

  constructor(private readonly root: HTMLElement, private readonly cb: DecodeResultsCallbacks) {}

  update(v: DecodeResultsView): void {
    const withResult = v.analyzers.filter((a) => a.result);
    const a = withResult.find((x) => x.id === v.selectedId) ?? withResult[0] ?? null;
    const timeChanged = v.originSample !== this.origin || v.samplerate !== this.rate;
    this.origin = v.originSample;
    this.rate = v.samplerate;
    if (!a || !a.result || !a.index) {
      this.analyzerId = null;
      this.result = null;
      this.el = null;
      this.root.replaceChildren();
      return;
    }
    const analyzersKey = withResult.map((x) => x.id).join(' ');
    if (a.id !== this.analyzerId || a.result !== this.result || this.el?.dataset.analyzers !== analyzersKey) {
      const sameAnalyzer = a.id === this.analyzerId;
      this.load(a, a.result, sameAnalyzer);
      this.build(withResult, a, analyzersKey);
      this.refilter();
      return;
    }
    if (timeChanged) this.paint();
  }

  private load(a: AnalyzerState, result: DecodeResult, keepChoices: boolean): void {
    this.analyzerId = a.id;
    this.result = result;
    const info = getDecoder(a.decoderId);
    const rows = displayRows(info);
    this.rowIds = rows.map((r) => r.id);
    this.rowNames = rows.map((r) => r.desc);
    this.classNames = info.annotations.map((x) => x.desc);
    const map = rowForClass(info);
    const ann = result.annotations;
    this.src = {
      start: ann.start, end: ann.end, cls: ann.cls, rowOfClass: map,
      textsOf: (i) => annotationTexts(result, i),
      classIds: info.annotations.map((x) => x.id),
    };
    this.order = a.index!.ordered(0);
    this.used = usedRows(this.src, this.order);
    if (!keepChoices) {
      this.rowsChoice = 'default';
      this.query = '';
      this.rangeVisible = false;
      // A text-like decoder (UART) opens in the joined text view.
      this.textView = a.decoderId === 'uart';
    }
    this.selected.clear();
    this.anchor = -1;
    this.message = '';
  }

  private build(withResult: readonly AnalyzerState[], a: AnalyzerState, key: string): void {
    const s = section(t('decodeResults.title'));
    s.el.classList.add('decode-results');
    s.el.dataset.analyzers = key;
    this.el = s.el;

    const controls = div('decode-results-controls');
    if (withResult.length > 1) {
      const pick = selectControl('decodeResults.analyzer', t('decodeResults.analyzer'),
        withResult.map((x): SelectOptionTuple => [x.id, x.label]), a.id);
      pick.addEventListener('change', () => this.cb.onSelect(pick.value));
      controls.appendChild(pick.el);
    }
    const rowOptions: SelectOptionTuple[] = [
      ['default', t('decodeResults.rowsDefault')],
      ['all', t('decodeResults.rowsAll')],
      ...this.used.map((r): SelectOptionTuple => [`r${r}`, this.rowNames[r] ?? String(r)]),
    ];
    const rows = selectControl('decodeResults.rows', t('decodeResults.rows'), rowOptions, this.rowsChoice);
    rows.addEventListener('change', () => { this.rowsChoice = rows.value as RowsChoice; this.refilter(); });
    controls.appendChild(rows.el);

    const pair = div('field-row');
    const view = selectControl('decodeResults.view', t('decodeResults.view'), [
      ['events', t('decodeResults.viewEvents')], ['text', t('decodeResults.viewText')],
    ], this.textView ? 'text' : 'events');
    view.addEventListener('change', () => { this.textView = view.value === 'text'; this.refilter(); });
    const range = selectControl('decodeResults.range', t('decodeResults.range'), [
      ['all', t('decodeResults.rangeAll')], ['visible', t('decodeResults.rangeVisible')],
    ], this.rangeVisible ? 'visible' : 'all');
    range.addEventListener('change', () => { this.rangeVisible = range.value === 'visible'; this.refilter(); });
    pair.append(view.el, range.el);
    controls.appendChild(pair);

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'decode-results-search';
    search.placeholder = t('decodeResults.searchPlaceholder');
    search.setAttribute('aria-label', t('decodeResults.searchLabel'));
    search.value = this.query;
    search.addEventListener('input', () => {
      if (this.queryTimer !== null) clearTimeout(this.queryTimer);
      this.queryTimer = setTimeout(() => {
        this.queryTimer = null;
        this.query = search.value;
        this.refilter();
      }, 150);
    });
    controls.appendChild(search);
    s.body.appendChild(controls);

    this.countEl = div('decode-results-count');
    this.countEl.setAttribute('aria-live', 'polite');
    s.body.appendChild(this.countEl);

    this.list = div('decode-results-list');
    this.list.tabIndex = 0;
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-multiselectable', 'true');
    this.list.setAttribute('aria-label', t('decodeResults.title'));
    this.list.style.height = `${LIST_HEIGHT}px`;
    this.spacer = div('decode-results-spacer');
    this.list.appendChild(this.spacer);
    this.list.addEventListener('scroll', () => this.paint(), { passive: true });
    this.list.addEventListener('keydown', (e) => this.onKey(e));
    s.body.appendChild(this.list);

    const actions = div('decode-results-actions');
    const copySel = button(t('decodeResults.copySelected'), 'pill');
    copySel.addEventListener('click', () => void this.copy(true));
    const copyAll = button(t('decodeResults.copyAll'), 'pill');
    copyAll.addEventListener('click', () => void this.copy(false));
    const csv = button(t('decodeResults.exportCsv'), 'pill');
    csv.addEventListener('click', () => this.export('csv'));
    const txt = button(t('decodeResults.exportTxt'), 'pill');
    txt.addEventListener('click', () => this.export('txt'));
    actions.append(copySel, copyAll, csv, txt);
    s.body.appendChild(actions);
    this.messageEl = document.createElement('span');
    this.messageEl.className = 'panel-note';
    this.messageEl.setAttribute('role', 'status');
    s.body.appendChild(this.messageEl);

    this.root.replaceChildren(s.el);
  }

  private rowFilter(): ReadonlySet<number> | null {
    if (this.rowsChoice === 'all') return null;
    if (this.rowsChoice === 'default') return defaultResultRows(this.rowIds, this.used);
    return new Set([Number(this.rowsChoice.slice(1))]);
  }

  /** Re-run the filter in slices; the list shows the partial count until it finishes. */
  private refilter(): void {
    const src = this.src;
    if (!src) return;
    const gen = ++this.generation;
    const filter = {
      rows: this.rowFilter(), query: this.query,
      range: this.rangeVisible ? this.cb.viewRange() : null,
    };
    const order = this.order;
    const hits: number[] = [];
    this.selected.clear();
    this.anchor = -1;
    this.filtering = true;
    let from = 0;
    const step = (): void => {
      if (gen !== this.generation) return;
      const part = filterResults(src, order, filter, this.rowNames, from, from + FILTER_SLICE);
      for (const i of part) hits.push(i);
      from += FILTER_SLICE;
      if (from < order.length) {
        this.countEl.textContent = t('decodeResults.filtering', {
          pct: Math.floor((from / order.length) * 100),
        });
        setTimeout(step, 0);
        return;
      }
      this.filtering = false;
      this.hits = hits;
      this.lines = this.textView ? joinTextLines(src, hits) : null;
      this.list.scrollTop = 0;
      this.paint();
    };
    step();
  }

  private count(): number {
    return this.lines ? this.lines.length : this.hits.length;
  }

  private lineAt(k: number): ResultLine {
    return this.lines ? this.lines[k]! : annotationLine(this.src!, this.hits[k]!);
  }

  private names(): ExportNames {
    return {
      secondsOf: (sample) => resultSeconds(sample, this.origin, this.rate),
      timeOf: (sample) => formatDuration(resultSeconds(sample, this.origin, this.rate), 6),
      rowName: (row) => this.rowNames[row] ?? String(row),
      className: (cls) => this.classNames[cls] ?? String(cls),
    };
  }

  private paint(): void {
    if (!this.el || this.filtering) return;
    const n = this.count();
    const total = this.order.length;
    this.countEl.textContent = this.lines
      ? t('decodeResults.countText', { lines: formatCount(n), total: formatCount(total) })
      : t('decodeResults.countEvents', { shown: formatCount(n), total: formatCount(total) });
    this.messageEl.textContent = this.message;
    this.spacer.style.height = `${n * RESULT_ROW_HEIGHT}px`;
    const { first, end } = virtualWindow(this.list.scrollTop, this.list.clientHeight || LIST_HEIGHT,
      RESULT_ROW_HEIGHT, n);
    const names = this.names();
    const frag = document.createDocumentFragment();
    for (let k = first; k < end; k++) {
      const line = this.lineAt(k);
      const row = div('decode-results-row');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(this.selected.has(k)));
      row.classList.toggle('on', this.selected.has(k));
      row.style.top = `${k * RESULT_ROW_HEIGHT}px`;
      row.style.height = `${RESULT_ROW_HEIGHT}px`;
      const time = document.createElement('span');
      time.className = 'decode-results-time';
      time.textContent = names.timeOf(line.start);
      const kind = document.createElement('span');
      kind.className = 'decode-results-kind';
      kind.textContent = line.cls < 0 ? names.rowName(line.row) : names.className(line.cls);
      kind.title = names.rowName(line.row);
      const text = document.createElement('span');
      text.className = 'decode-results-text';
      text.textContent = line.text;
      text.title = line.text;
      row.append(time, kind, text);
      row.addEventListener('click', (e) => this.pick(k, e.shiftKey, e.ctrlKey || e.metaKey));
      frag.appendChild(row);
    }
    // The spacer stays; only the rows of the window are replaced.
    for (const old of [...this.list.querySelectorAll('.decode-results-row')]) old.remove();
    this.list.appendChild(frag);
  }

  private pick(k: number, range: boolean, toggle: boolean): void {
    if (range && this.anchor >= 0) {
      this.selected.clear();
      const [a, b] = this.anchor < k ? [this.anchor, k] : [k, this.anchor];
      for (let j = a; j <= b; j++) this.selected.add(j);
    } else if (toggle) {
      if (this.selected.has(k)) this.selected.delete(k); else this.selected.add(k);
      this.anchor = k;
    } else {
      this.selected = new Set([k]);
      this.anchor = k;
    }
    this.paint();
    if (this.analyzerId !== null) this.cb.onJump(this.analyzerId, this.lineAt(k).ann);
  }

  private onKey(e: KeyboardEvent): void {
    const n = this.count();
    if (n === 0) return;
    let k = this.anchor;
    if (e.key === 'ArrowDown') k = Math.min(n - 1, k + 1);
    else if (e.key === 'ArrowUp') k = Math.max(0, k - 1);
    else if ((e.key === 'c' || e.key === 'C') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void this.copy(this.selected.size > 0);
      return;
    } else return;
    e.preventDefault();
    const top = k * RESULT_ROW_HEIGHT;
    if (top < this.list.scrollTop) this.list.scrollTop = top;
    else if (top + RESULT_ROW_HEIGHT > this.list.scrollTop + this.list.clientHeight) {
      this.list.scrollTop = top + RESULT_ROW_HEIGHT - this.list.clientHeight;
    }
    this.pick(k, e.shiftKey, false);
  }

  private *linesFor(onlySelected: boolean, cap = Infinity): Generator<ResultLine> {
    let emitted = 0;
    if (onlySelected) {
      for (const k of [...this.selected].sort((x, y) => x - y)) {
        if (emitted++ >= cap) return;
        yield this.lineAt(k);
      }
      return;
    }
    const n = this.count();
    for (let k = 0; k < n && k < cap; k++) yield this.lineAt(k);
  }

  private async copy(onlySelected: boolean): Promise<void> {
    const n = onlySelected ? this.selected.size : this.count();
    if (n === 0) {
      this.setMessage(t(onlySelected ? 'decodeResults.nothingSelected' : 'decodeResults.nothingToCopy'));
      return;
    }
    const text = resultsText(this.linesFor(onlySelected, CLIPBOARD_LINE_CAP), this.names());
    try {
      await navigator.clipboard.writeText(text);
      this.setMessage(n > CLIPBOARD_LINE_CAP
        ? t('decodeResults.copiedCapped', { count: formatCount(CLIPBOARD_LINE_CAP), total: formatCount(n) })
        : t('decodeResults.copied', { count: formatCount(n) }));
    } catch (e) {
      console.warn('[ui] decodeResults.copyFailed', e);
      this.setMessage(t('decodeResults.copyFailed'));
    }
  }

  private export(kind: 'csv' | 'txt'): void {
    if (this.count() === 0) { this.setMessage(t('decodeResults.nothingToCopy')); return; }
    const lines = this.linesFor(false);
    const body = kind === 'csv' ? resultsCsv(lines, this.names()) : resultsText(lines, this.names());
    const blob = new Blob([kind === 'csv' ? '﻿' + body : body], {
      type: kind === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const id = this.analyzerId ?? 'decode';
    a.download = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    this.setMessage(t('decodeResults.exported', { count: formatCount(this.count()) }));
  }

  private setMessage(text: string): void {
    this.message = text;
    if (this.messageEl) this.messageEl.textContent = text;
  }
}
