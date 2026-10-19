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
  decoderCount, getDecoder, isLogicDecoder, listDecoders, validateStack,
} from '../decode/index.js';
import type { DecoderInfo } from '../decode/index.js';
import { button, div, labelled, section } from './capturePanel.js';
import { formatAnalyzerNote } from './format.js';
import { t } from './i18n.js';
import { COLORS } from './metrics.js';
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
        st.textContent = a.status === 'decoding' ? t('analyzerPanel.decoding') : formatAnalyzerNote(a.note);
        st.style.color = a.status === 'error' ? COLORS.negative : COLORS.text50;
        row.appendChild(st);
        const re = button(t('analyzerPanel.decode'), 'mini');
        re.disabled = !v.hasCapture || a.status === 'decoding';
        re.addEventListener('click', () => this.cb.onRedecode(a.id));
        row.appendChild(re);
        const rm = button(t('analyzerPanel.remove'), 'mini');
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
      (d) => [d.id, `${d.id} - ${d.longname}`] as SelectOptionTuple,
    );
    const pick = selectControl('analyzer.decoder', t('analyzerPanel.decoder'), pickOptions, this.chosen);
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
    } catch {
      this.chosen = logic[0]?.id ?? 'i2c';
      info = getDecoder(this.chosen);
    }
    if (!isLogicDecoder(info)) {
      const warn = div('panel-note');
      warn.textContent = t('analyzerPanel.stacked', { id: info.id, inputs: info.inputs.join(', ') });
      add.body.appendChild(warn);
    }

    const desc = div('panel-note');
    desc.textContent = info.desc;
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
        const optionValues: SelectOptionTuple[] = opt.values.map(
          (x) => [String(x), String(x)] as SelectOptionTuple,
        );
        const sel = selectControl(`analyzer.option.${opt.id}`, opt.desc, optionValues, String(cur));
        sel.addEventListener('change', () => { this.draftOptions[opt.id] = coerce(opt.type, sel.value); });
        add.body.appendChild(sel.el);
      } else {
        const inp = document.createElement('input');
        inp.type = opt.type === 'str' ? 'text' : 'number';
        inp.value = String(cur);
        inp.addEventListener('change', () => { this.draftOptions[opt.id] = coerce(opt.type, inp.value); });
        add.body.appendChild(labelled(opt.desc, inp));
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
