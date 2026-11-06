// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Attaching a protocol decoder to channels, and editing one that is attached.
 *
 * `src/decode` ships 125 stock sigrok decoders verified byte-identical to native, against
 * The picker lists the sample-driven analyzers (`inputs ==
 * ['logic']`); stacked decoders like `eeprom24xx` need a producer and are out of this
 * panel's scope, which is stated rather than hidden.
 *
 * Everything the panel builds goes through `validateStack()` before it is offered, so an
 * unassigned required channel is a specific complaint in the panel rather than a Python
 * traceback a second later. That self-describing-error behaviour is explicitly part of the
 * bar [DRIVEN].
 *
 * The form is one editor with two modes. Adding: the picker chooses a decoder and the
 * mapping starts from `defaultChannelMapping`. Editing: clicking an attached analyzer's
 * name loads its decoder, mapping and current options into the same form (the picker is
 * locked - an attached analyzer keeps its decoder), and Apply hands the new mapping and
 * options to the app, which replaces the old result by re-decoding. The form never shows
 * values that the attached analyzer does not use without saying it is the Add form.
 */

import {
  DecoderNotHydratedError, decoderCount, getDecoder, hydrateDecoders, isLogicDecoder,
  listDecoders, validateStack,
} from '../decode/index.js';
import type { DecoderInfo, DecoderOptionInfo } from '../decode/index.js';
import {
  changedOptions, defaultChannelMapping, mapsNoChannel, splitDecoderOptions,
} from './analyzerForm.js';
import { button, div, labelled, section } from './capturePanel.js';
import {
  decoderDescriptionText, decoderLongNameText, decoderOptionLabel, decoderOptionValueTuples,
  decoderPickerAliases, decoderPickerOptions,
} from './decoderI18n.js';
import { formatMountedAnalyzerNote } from './format.js';
import { t } from './i18n.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import { defaultChannelName, type AnalyzerState, type ChannelState } from './state.js';

export interface AnalyzerPanelCallbacks {
  onAttach(decoderId: string, channels: Record<number, number>, options: Record<string, string | number>): void;
  /** Apply an edited mapping/options to an attached analyzer; the app re-decodes it. */
  onUpdate(id: string, channels: Record<number, number>, options: Record<string, string | number>): void;
  /** The analyzer whose results the list shows (clicking its name). */
  onSelect(id: string): void;
  onRemove(id: string): void;
  onRedecode(id: string): void;
  onCancel(): void;
  onAutoDecode(on: boolean): void;
  onDismissNote(): void;
}

export interface AnalyzerPanelView {
  channels: readonly ChannelState[];
  analyzers: readonly AnalyzerState[];
  captureChannels: number;
  hasCapture: boolean;
  warm: boolean;
  busy: boolean;
  /** The analyzer the results list shows. */
  selectedId: string | null;
  /** Re-run every attached decoder when a capture completes or a file opens. */
  autoDecode: boolean;
  /** Analyzers dropped by the last file open, already listed ("UART (D9)"); null when none. */
  droppedNote: string | null;
}

export class AnalyzerPanel {
  private chosen = 'i2c';
  private draftChannels: Record<number, number> = {};
  private draftOptions: Record<string, string | number> = {};
  /** False until the draft mapping got its defaults for `chosen`. */
  private mappingSeeded = false;
  /** The attached analyzer the form edits, or null when it adds a new one. */
  private editing: string | null = null;
  private advancedOpen = false;
  /** The corner's + Decoder asked for the picker; honoured by the next render that has it. */
  private pickerFocusPending = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: AnalyzerPanelCallbacks,
  ) {}

  /** Load an attached analyzer into the form: its decoder, mapping and current options. */
  edit(a: AnalyzerState): void {
    this.editing = a.id;
    this.chosen = a.decoderId;
    this.draftChannels = { ...a.channels };
    this.draftOptions = { ...a.options };
    this.mappingSeeded = true;
    try {
      const info = getDecoder(a.decoderId);
      const { advanced } = splitDecoderOptions(info.id, info.options);
      this.advancedOpen = advanced.some((o) => a.options[o.id] !== undefined);
    } catch {
      this.advancedOpen = false;
    }
  }

  /**
   * Leave edit mode and focus the decoder picker (the corner's + Decoder). The picker is
   * focused now if it is on screen, otherwise by the render that builds it - including
   * the one after the decoder catalog hydrates.
   */
  requestPickerFocus(): void {
    if (this.editing !== null) this.stopEditing();
    this.pickerFocusPending = true;
    this.focusPicker();
  }

  private focusPicker(): void {
    const trigger = this.root.querySelector<HTMLElement>(
      '.select-trigger[data-select-key="analyzer.decoder"]');
    if (trigger === null || !trigger.isConnected || trigger.getClientRects().length === 0) return;
    this.pickerFocusPending = false;
    trigger.focus();
  }

  get editingId(): string | null {
    return this.editing;
  }

  private stopEditing(): void {
    this.editing = null;
    this.draftChannels = {};
    this.draftOptions = {};
    this.mappingSeeded = false;
    this.advancedOpen = false;
  }

  render(v: AnalyzerPanelView): void {
    this.root.replaceChildren();
    if (this.editing !== null && !v.analyzers.some((a) => a.id === this.editing)) this.stopEditing();

    const head = div('panel-head');
    const title = div('panel-title');
    title.textContent = t('analyzerPanel.title');
    head.appendChild(title);
    const sub = div('panel-sub');
    sub.textContent = v.warm
      ? t('analyzerPanel.subWarm', { count: decoderCount })
      : t('analyzerPanel.subCold', { count: decoderCount });
    head.appendChild(sub);
    this.root.appendChild(head);

    if (v.droppedNote !== null) {
      const note = div('panel-note analyzer-dropped');
      note.setAttribute('role', 'status');
      const text = document.createElement('span');
      text.textContent = t('analyzerPanel.dropped', { list: v.droppedNote });
      const dismiss = button(t('analyzerPanel.dismiss'), 'pill');
      dismiss.addEventListener('click', () => this.cb.onDismissNote());
      note.append(text, dismiss);
      this.root.appendChild(note);
    }

    // ---------------------------------------------------------------- attached
    if (v.analyzers.length) {
      const s = section(t('analyzerPanel.attached'));
      const autoLabel = document.createElement('label');
      autoLabel.className = 'analyzer-auto';
      autoLabel.title = t('analyzerPanel.autoDecode');
      const auto = document.createElement('input');
      auto.type = 'checkbox';
      auto.checked = v.autoDecode;
      auto.addEventListener('change', () => this.cb.onAutoDecode(auto.checked));
      autoLabel.append(auto, document.createTextNode(t('analyzerPanel.autoDecodeShort')));
      s.header.appendChild(autoLabel);
      for (const a of v.analyzers) {
        const row = div('analyzer-row');
        row.classList.toggle('editing', a.id === this.editing);
        row.classList.toggle('selected', a.id === v.selectedId);
        const sq = document.createElement('span');
        sq.className = 'ch-analyzer-sq';
        sq.style.background = a.color;
        row.appendChild(sq);
        // The name is the row's edit entry: it selects the analyzer for the results list
        // and loads its mapping and options into the form below (again: back to Add).
        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'analyzer-name';
        name.textContent = a.label;
        name.title = t('analyzerPanel.editAction', { label: a.label });
        name.setAttribute('aria-pressed', String(a.id === this.editing));
        name.addEventListener('click', () => {
          if (this.editing === a.id) this.stopEditing();
          else this.edit(a);
          this.cb.onSelect(a.id);
        });
        row.appendChild(name);
        const st = document.createElement('span');
        st.className = 'analyzer-status';
        st.textContent = formatMountedAnalyzerNote(a.note, a.status);
        st.classList.toggle('error', a.status === 'error');
        st.title = st.textContent;
        row.appendChild(st);
        const re = actionButton('analyzer-act',
          t('analyzerPanel.decodeAction', { label: a.label }), decodeIcon());
        re.disabled = !v.hasCapture || a.status === 'decoding';
        re.addEventListener('click', () => this.cb.onRedecode(a.id));
        row.appendChild(re);
        const rm = actionButton('analyzer-act analyzer-act--remove',
          t('analyzerPanel.removeAction', { label: a.label }), removeIcon());
        rm.addEventListener('click', () => this.cb.onRemove(a.id));
        row.appendChild(rm);
        s.body.appendChild(row);
      }
      if (v.busy) {
        const cancel = button(t('analyzerPanel.cancelDecode'), 'mini');
        cancel.addEventListener('click', () => this.cb.onCancel());
        s.body.appendChild(cancel);
      }
      this.root.appendChild(s.el);
    }

    // ---------------------------------------------------------------- add / edit
    const editing = this.editing !== null
      ? v.analyzers.find((a) => a.id === this.editing) ?? null : null;
    const add = section(editing
      ? t('analyzerPanel.editTitle', { label: editing.label }) : t('analyzerPanel.add'));
    add.el.classList.toggle('analyzer-editing', editing !== null);
    const logic = listDecoders()
      .filter((d) => d.inputs.length === 1 && d.inputs[0] === 'logic')
      .sort((a, b) => a.id.localeCompare(b.id));
    const pickOptions = decoderPickerOptions(logic);
    const pick = selectControl('analyzer.decoder', t('analyzerPanel.decoder'), pickOptions, this.chosen, {
      search: {
        label: t('analyzerPanel.decoderSearchLabel'),
        placeholder: t('analyzerPanel.decoderSearchPlaceholder'),
        empty: t('analyzerPanel.decoderNoMatch'),
        aliases: decoderPickerAliases(logic),
      },
    });
    // An attached analyzer keeps its decoder; editing changes its wiring and options.
    pick.disabled = editing !== null;
    pick.addEventListener('change', () => {
      this.chosen = pick.value;
      this.draftChannels = {};
      this.draftOptions = {};
      this.mappingSeeded = false;
      this.advancedOpen = false;
      this.render(v);
    });
    add.body.appendChild(pick.el);

    let info: DecoderInfo;
    try {
      info = getDecoder(this.chosen);
    } catch (e) {
      if (e instanceof DecoderNotHydratedError) {
        void hydrateDecoders().then(
          () => this.render(v),
          (err: unknown) => {
            const p = div('panel-note error');
            p.textContent = String(err);
            add.body.appendChild(p);
            this.root.appendChild(add.el);
          });
        return;
      }
      this.chosen = logic[0]?.id ?? 'i2c';
      info = getDecoder(this.chosen);
    }
    if (!isLogicDecoder(info)) {
      const warn = div('panel-note');
      warn.textContent = t('analyzerPanel.stacked', { id: info.id, inputs: info.inputs.join(', ') });
      add.body.appendChild(warn);
    }

    const longName = div('decoder-detail');
    longName.textContent = decoderLongNameText(info);
    add.body.appendChild(longName);

    const desc = div('panel-note');
    desc.textContent = decoderDescriptionText(info);
    add.body.appendChild(desc);

    const enabled = v.channels.filter((c) => c.index < v.captureChannels);
    const realName = (c: ChannelState): string =>
      c.name && c.name !== defaultChannelName(c.index) ? c.name : '';
    if (!this.mappingSeeded) {
      this.draftChannels = defaultChannelMapping(info,
        enabled.map((c) => ({ index: c.index, name: realName(c) })));
      this.mappingSeeded = true;
    }
    const chanOpts = (required: boolean): [string, string][] => [
      ...(required ? [] : [['-1', '—'] as [string, string]]),
      ...enabled.map((c) =>
        [String(c.index), realName(c) ? `D${c.index} ${c.name}` : `D${c.index}`] as [string, string]),
    ];

    // Channel mapping first, then the options that matter, then the action; the long tail
    // of options sits in a collapsed disclosure under the action, so it never pushes the
    // Attach/Apply button out of view.
    const allChans = [...info.channels, ...info.optional_channels];
    allChans.forEach((ch, i) => {
      const required = i < info.channels.length;
      const cur = this.draftChannels[i];
      const def = cur !== undefined ? String(cur) : required ? String(enabled[i]?.index ?? 0) : '-1';
      if (cur === undefined && required) this.draftChannels[i] = Number(def);
      const sel = selectControl(
        `analyzer.channel.${i}`,
        `${ch.name}${required ? '' : t('analyzerPanel.optionalSuffix')}`,
        chanOpts(required),
        def,
      );
      sel.addEventListener('change', () => {
        const val = Number(sel.value);
        if (val < 0) delete this.draftChannels[i];
        else this.draftChannels[i] = val;
        // The "reads no channel" complaint and the action's enabled state follow the mapping.
        this.render(v);
      });
      add.body.appendChild(sel.el);
    });

    const { primary, advanced } = splitDecoderOptions(info.id, info.options);
    for (const opt of primary) add.body.appendChild(this.optionControl(info, opt));

    const problems = validateStack(
      [{ id: this.chosen, channels: this.draftChannels, options: this.draftOptions }],
      Math.max(1, v.captureChannels),
    );
    if (mapsNoChannel(info, this.draftChannels)) problems.push(t('analyzerPanel.needChannel'));
    if (problems.length) {
      const p = div('panel-note error');
      p.textContent = problems.join('\n');
      add.body.appendChild(p);
    }

    const actions = div('analyzer-form-actions');
    if (editing) {
      const apply = button(t('analyzerPanel.apply'), 'primary');
      apply.disabled = problems.length > 0;
      apply.addEventListener('click', () => {
        const id = editing.id;
        const channels = { ...this.draftChannels };
        const options = changedOptions(info, this.draftOptions);
        this.stopEditing();
        this.cb.onUpdate(id, channels, options);
      });
      const cancel = button(t('analyzerPanel.cancelEdit'), 'pill');
      cancel.addEventListener('click', () => { this.stopEditing(); this.render(v); });
      actions.append(apply, cancel);
    } else {
      const attach = button(t('analyzerPanel.attach'), 'primary');
      attach.disabled = problems.length > 0;
      attach.addEventListener('click', () =>
        this.cb.onAttach(this.chosen, { ...this.draftChannels }, changedOptions(info, this.draftOptions)));
      actions.appendChild(attach);
    }
    add.body.appendChild(actions);

    if (advanced.length) {
      const more = document.createElement('details');
      more.className = 'analyzer-advanced';
      more.open = this.advancedOpen;
      more.addEventListener('toggle', () => { this.advancedOpen = more.open; });
      const summary = document.createElement('summary');
      summary.textContent = t('analyzerPanel.advancedOptions', { count: advanced.length });
      more.appendChild(summary);
      const body = div('analyzer-advanced-body');
      for (const opt of advanced) body.appendChild(this.optionControl(info, opt));
      more.appendChild(body);
      add.body.appendChild(more);
    }

    if (!v.hasCapture) {
      const p = div('panel-note');
      p.textContent = t('analyzerPanel.loadFirst');
      add.body.appendChild(p);
    }
    this.root.appendChild(add.el);
    if (this.pickerFocusPending) {
      this.focusPicker();
      // One render only: a later unrelated re-render must not steal focus.
      this.pickerFocusPending = false;
    }
  }

  private optionControl(info: DecoderInfo, opt: DecoderOptionInfo): HTMLElement {
    const cur = this.draftOptions[opt.id] ?? opt.default ?? '';
    if (opt.values.length) {
      const optionValues: SelectOptionTuple[] = decoderOptionValueTuples(opt.values);
      const sel = selectControl(
        `analyzer.option.${opt.id}`, decoderOptionLabel(info.id, opt), optionValues, String(cur));
      sel.addEventListener('change', () => { this.draftOptions[opt.id] = coerce(opt.type, sel.value); });
      return sel.el;
    }
    const inp = document.createElement('input');
    inp.type = opt.type === 'str' ? 'text' : 'number';
    inp.value = String(cur);
    inp.addEventListener('change', () => { this.draftOptions[opt.id] = coerce(opt.type, inp.value); });
    return labelled(decoderOptionLabel(info.id, opt), inp);
  }
}

function coerce(type: 'int' | 'float' | 'str', v: string): string | number {
  if (type === 'str') return v;
  const n = Number(v);
  return Number.isFinite(n) ? (type === 'int' ? Math.round(n) : n) : v;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function icon(...ds: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ds) {
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

function decodeIcon(): SVGSVGElement {
  return icon('M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8', 'M21 3v5h-5');
}

function removeIcon(): SVGSVGElement {
  return icon('M18 6 6 18', 'm6 6 12 12');
}

function actionButton(cls: string, label: string, glyph: SVGSVGElement): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(glyph);
  return b;
}
