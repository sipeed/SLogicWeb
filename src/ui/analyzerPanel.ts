// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Attaching a protocol decoder to channels.
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
 */

import {
  DecoderNotHydratedError, decoderCount, getDecoder, hydrateDecoders, isLogicDecoder,
  listDecoders, validateStack,
} from '../decode/index.js';
import type { DecoderInfo } from '../decode/index.js';
import { button, div, labelled, section } from './capturePanel.js';
import {
  decoderDescriptionText, decoderLongNameText, decoderOptionLabel, decoderOptionValueTuples,
  decoderPickerLabel,
} from './decoderI18n.js';
import { formatMountedAnalyzerNote } from './format.js';
import { t } from './i18n.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import { defaultChannelName, type AnalyzerState, type ChannelState } from './state.js';

export interface AnalyzerPanelCallbacks {
  onAttach(decoderId: string, channels: Record<number, number>, options: Record<string, string | number>): void;
  onRemove(id: string): void;
  onRedecode(id: string): void;
  onCancel(): void;
}

export interface AnalyzerPanelView {
  channels: readonly ChannelState[];
  analyzers: readonly AnalyzerState[];
  captureChannels: number;
  hasCapture: boolean;
  warm: boolean;
  busy: boolean;
}

export class AnalyzerPanel {
  private chosen = 'i2c';
  private draftChannels: Record<number, number> = {};
  private draftOptions: Record<string, string | number> = {};

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: AnalyzerPanelCallbacks,
  ) {}

  render(v: AnalyzerPanelView): void {
    this.root.replaceChildren();

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

    // ---------------------------------------------------------------- attached
    if (v.analyzers.length) {
      const s = section(t('analyzerPanel.attached'));
      for (const a of v.analyzers) {
        const row = div('analyzer-row');
        const sq = document.createElement('span');
        sq.className = 'ch-analyzer-sq';
        sq.style.background = a.color;
        row.appendChild(sq);
        const name = document.createElement('span');
        name.className = 'analyzer-name';
        name.textContent = a.label;
        row.appendChild(name);
        const st = document.createElement('span');
        st.className = 'analyzer-status';
        st.textContent = formatMountedAnalyzerNote(a.note, a.status);
        st.classList.toggle('error', a.status === 'error');
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

    // ---------------------------------------------------------------- add
    const add = section(t('analyzerPanel.add'));
    const logic = listDecoders()
      .filter((d) => d.inputs.length === 1 && d.inputs[0] === 'logic')
      .sort((a, b) => a.id.localeCompare(b.id));
    const pickOptions: SelectOptionTuple[] = logic.map(
      (d) => [d.id, decoderPickerLabel(d)] as SelectOptionTuple,
    );
    const pick = selectControl('analyzer.decoder', t('analyzerPanel.decoder'), pickOptions, this.chosen, {
      search: {
        label: t('analyzerPanel.decoderSearchLabel'),
        placeholder: t('analyzerPanel.decoderSearchPlaceholder'),
        empty: t('analyzerPanel.decoderNoMatch'),
      },
    });
    pick.addEventListener('change', () => {
      this.chosen = pick.value;
      this.draftChannels = {};
      this.draftOptions = {};
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
    const chanOpts = (required: boolean): [string, string][] => [
      ...(required ? [] : [['-1', '—'] as [string, string]]),
      ...enabled.map((c) =>
        [String(c.index),
          c.name && c.name !== defaultChannelName(c.index) ? `D${c.index} ${c.name}` : `D${c.index}`,
        ] as [string, string]),
    ];

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
      });
      add.body.appendChild(sel.el);
    });

    for (const opt of info.options) {
      const cur = this.draftOptions[opt.id] ?? opt.default ?? '';
      if (opt.values.length) {
        const optionValues: SelectOptionTuple[] = decoderOptionValueTuples(opt.values);
        const sel = selectControl(
          `analyzer.option.${opt.id}`, decoderOptionLabel(info.id, opt), optionValues, String(cur));
        sel.addEventListener('change', () => { this.draftOptions[opt.id] = coerce(opt.type, sel.value); });
        add.body.appendChild(sel.el);
      } else {
        const inp = document.createElement('input');
        inp.type = opt.type === 'str' ? 'text' : 'number';
        inp.value = String(cur);
        inp.addEventListener('change', () => { this.draftOptions[opt.id] = coerce(opt.type, inp.value); });
        add.body.appendChild(labelled(decoderOptionLabel(info.id, opt), inp));
      }
    }

    const problems = validateStack(
      [{ id: this.chosen, channels: this.draftChannels, options: this.draftOptions }],
      Math.max(1, v.captureChannels),
    );
    if (problems.length) {
      const p = div('panel-note error');
      p.textContent = problems.join('\n');
      add.body.appendChild(p);
    }

    const attach = button(t('analyzerPanel.attach'), 'primary');
    attach.disabled = problems.length > 0;
    attach.addEventListener('click', () =>
      this.cb.onAttach(this.chosen, { ...this.draftChannels }, { ...this.draftOptions }));
    add.body.appendChild(attach);

    if (!v.hasCapture) {
      const p = div('panel-note');
      p.textContent = t('analyzerPanel.loadFirst');
      add.body.appendChild(p);
    }
    this.root.appendChild(add.el);
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
