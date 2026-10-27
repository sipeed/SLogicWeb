// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The "Parallel bus / ADC" section of the analyzers sidebar: a list of bus views and an
 * editor for adding or changing one.
 *
 * It has a host of its own under the analyzers sidebar (AnalyzerPanel clears its host
 * whenever it re-renders), and keeps its draft across re-renders, so a capture finishing
 * mid-edit does not lose what was typed. Only the shared helpers are reused; the class names are its own.
 */

import { MAX_BUS_BITS, validateBusSpec, type BusEncoding, type BusSpec } from '../data/busValue.js';
import {
  BUS_HEIGHTS, DEFAULT_BUS_HEIGHT, busSummary, runBits, runStart, swapBusOrder,
  type BusDrawStyle, type BusViewConfig, type BusViewState,
} from './busView.js';
import { button, div, labelled, section } from './capturePanel.js';
import { CHANNEL_BANK_SIZE, busChannelBank, channelBankRange } from './channelBanks.js';
import { t, type MessageKey } from './i18n.js';
import { selectControl, type SelectOptionTuple } from './select.js';

export interface BusPanelView {
  buses: readonly BusViewState[];
  /** Channels a bus may use: the current capture's, or the device's when there is none. */
  channelCount: number;
}

export interface BusPanelCallbacks {
  onAdd(cfg: BusViewConfig): void;
  onUpdate(id: string, cfg: BusViewConfig): void;
  onRemove(id: string): void;
}

const ENCODINGS: [BusEncoding, MessageKey][] = [
  ['unsigned', 'bus.encUnsigned'], ['twos', 'bus.encTwos'], ['offset', 'bus.encOffset'],
];

export function cloneBusConfig(c: BusViewConfig): BusViewConfig {
  return {
    name: c.name, color: c.color, fullScaleV: c.fullScaleV, offsetV: c.offsetV, style: c.style,
    heightCss: c.heightCss, hideSources: c.hideSources,
    spec: { bits: [...c.spec.bits], clock: c.spec.clock ? { ...c.spec.clock } : null, encoding: c.spec.encoding },
  };
}

export function defaultBusConfig(channelCount: number): BusViewConfig {
  const n = Math.min(8, channelCount);
  return {
    name: 'ADC',
    spec: { bits: Array.from({ length: n }, (_, i) => i), clock: null, encoding: 'unsigned' },
    color: '#4C9AFF',
    fullScaleV: null,
    offsetV: 0,
    style: 'line',
    heightCss: DEFAULT_BUS_HEIGHT,
    hideSources: false,
  };
}

function assertChannelBank(start: number, channelCount: number): void {
  if (!Number.isInteger(start) || start < 0 || start % CHANNEL_BANK_SIZE !== 0 ||
    start + CHANNEL_BANK_SIZE > channelCount) {
    throw new RangeError(`invalid channel bank ${start} for ${channelCount} channels`);
  }
}

export function normalizeBankBusConfig(
  config: BusViewConfig, channelCount: number, start: number,
): BusViewConfig {
  assertChannelBank(start, channelCount);
  const msbFirst = busChannelBank(config.spec) === start && runStart(config.spec.bits).msbFirst;
  const bits = runBits(start, CHANNEL_BANK_SIZE, channelCount, msbFirst);
  const clock = config.spec.clock && !bits.includes(config.spec.clock.channel) &&
    config.spec.clock.channel >= 0 && config.spec.clock.channel < channelCount
    ? { ...config.spec.clock } : null;
  return {
    ...cloneBusConfig(config),
    spec: { bits, clock, encoding: config.spec.encoding },
  };
}

export function defaultBankBusConfig(channelCount: number, start: number): BusViewConfig {
  return normalizeBankBusConfig(defaultBusConfig(channelCount), channelCount, start);
}

interface BusConfigFieldsOptions {
  channelCount: number;
  fixedBankStart: number | null;
  onRebuild(next: BusViewConfig, keepPerBitOpen: boolean): void;
}

interface BusConfigFields {
  el: HTMLElement;
  read(): BusViewConfig;
}

function busConfigFields(d: BusViewConfig, options: BusConfigFieldsOptions): BusConfigFields {
  const body = div('bus-config-fields');
  const cc = options.channelCount;
  const update = (patch: Partial<BusViewConfig>, spec?: Partial<BusSpec>) => {
    const next = { ...d, ...patch, spec: { ...d.spec, ...spec } };
    if (options.fixedBankStart === null) options.onRebuild(next, false);
    else {
      Object.assign(d, patch);
      d.spec = next.spec;
    }
  };
  const chOptions: SelectOptionTuple[] = Array.from({ length: cc }, (_, i) => [String(i), `D${i}`]);

  const name = document.createElement('input');
  name.type = 'text';
  name.value = d.name;
  name.addEventListener('change', () => { d.name = name.value.trim() || 'ADC'; });
  body.appendChild(labelled(t('bus.name'), name));

  const run = runStart(d.spec.bits);
  if (options.fixedBankStart !== null) {
    const fixed = document.createElement('input');
    fixed.type = 'text';
    fixed.readOnly = true;
    fixed.value = `${CHANNEL_BANK_SIZE} · ${channelBankRange(options.fixedBankStart, cc)}`;
    fixed.dataset.bankBits = String(options.fixedBankStart);
    body.appendChild(labelled(t('bus.fixedBits'), fixed));
  } else {
    // Width and the LSB channel fill the bits as a contiguous run, the common wiring.
    const row = div('field-row');
    const n = document.createElement('input');
    n.type = 'number';
    n.min = '1';
    n.max = String(Math.min(MAX_BUS_BITS, cc));
    n.value = String(d.spec.bits.length);
    n.addEventListener('change', () => {
      const width = Math.max(1, Math.min(MAX_BUS_BITS, cc, Math.round(Number(n.value)) || 1));
      update({}, { bits: runBits(run.start, width, cc, run.msbFirst) });
    });
    row.appendChild(labelled(t('bus.bits'), n));
    const start = selectControl('bus.start', t('bus.start'), chOptions, String(run.start));
    start.addEventListener('change', () => update({}, { bits: runBits(Number(start.value), d.spec.bits.length, cc, run.msbFirst) }));
    row.appendChild(start.el);
    body.appendChild(row);
  }

  const msb = document.createElement('label');
  msb.className = 'bus-check';
  const msbBox = document.createElement('input');
  msbBox.type = 'checkbox';
  msbBox.checked = run.msbFirst;
  msbBox.disabled = d.spec.bits.length < 2;
  msbBox.addEventListener('change', () => update({}, { bits: runBits(run.start, d.spec.bits.length, cc, msbBox.checked) }));
  msb.append(msbBox, document.createTextNode(t('bus.msbFirst')));
  body.appendChild(msb);

  if (options.fixedBankStart === null) {
    // Any wiring: one channel per bit.
    const per = document.createElement('details');
    per.className = 'bus-perbit';
    const summary = document.createElement('summary');
    summary.textContent = `${t('bus.perBit')} (${busSummary({ ...d.spec, clock: null })})`;
    per.appendChild(summary);
    const grid = div('bus-perbit-grid');
    d.spec.bits.forEach((ch, k) => {
      const label = k === 0 ? t('bus.bitLsb', { k }) : k === d.spec.bits.length - 1 ? t('bus.bitMsb', { k }) : t('bus.bit', { k });
      const sel = selectControl(`bus.bit.${k}`, label, chOptions, String(ch));
      sel.addEventListener('change', () => {
        const bits = [...d.spec.bits];
        bits[k] = Number(sel.value);
        options.onRebuild({ ...d, spec: { ...d.spec, bits } }, true);
      });
      grid.appendChild(sel.el);
    });
    per.appendChild(grid);
    body.appendChild(per);
  }

  const bankBits = new Set(options.fixedBankStart === null ? [] :
    runBits(options.fixedBankStart, CHANNEL_BANK_SIZE, cc, false));
  const clockOptions = options.fixedBankStart === null ? chOptions :
    chOptions.filter(([ch]) => !bankBits.has(Number(ch)));
  // Clock: none (any bit change makes a new value) or a channel and its active edge.
  const clockRow = div('field-row');
  const clock = selectControl('bus.clock', t('bus.clock'),
    [['-1', t('bus.clockNone')], ...clockOptions], String(d.spec.clock?.channel ?? -1));
  clock.addEventListener('change', () => {
    const ch = Number(clock.value);
    update({}, { clock: ch < 0 ? null : { channel: ch, edge: d.spec.clock?.edge ?? 'rising' } });
    edge.disabled = ch < 0;
  });
  clockRow.appendChild(clock.el);
  const edge = selectControl('bus.edge', t('bus.edge'),
    [['rising', t('bus.edgeRising')], ['falling', t('bus.edgeFalling')]], d.spec.clock?.edge ?? 'rising');
  edge.disabled = !d.spec.clock;
  edge.addEventListener('change', () => {
    if (d.spec.clock) update({}, { clock: { channel: d.spec.clock.channel, edge: edge.value as 'rising' | 'falling' } });
  });
  clockRow.appendChild(edge.el);
  body.appendChild(clockRow);

  const enc = selectControl('bus.encoding', t('bus.encoding'),
    ENCODINGS.map(([e, k]) => [e, t(k)]), d.spec.encoding);
  enc.addEventListener('change', () => update({}, { encoding: enc.value as BusEncoding }));
  body.appendChild(enc.el);

  const scale = div('field-row');
  const fs = document.createElement('input');
  fs.type = 'number';
  fs.step = 'any';
  fs.placeholder = '—';
  fs.value = d.fullScaleV === null ? '' : String(d.fullScaleV);
  fs.addEventListener('change', () => {
    const x = Number(fs.value);
    d.fullScaleV = fs.value.trim() === '' || !Number.isFinite(x) || x === 0 ? null : x;
  });
  scale.appendChild(labelled(t('bus.fullScale'), fs));
  const off = document.createElement('input');
  off.type = 'number';
  off.step = 'any';
  off.value = String(d.offsetV);
  off.addEventListener('change', () => { d.offsetV = Number.isFinite(Number(off.value)) ? Number(off.value) : 0; });
  scale.appendChild(labelled(t('bus.offset'), off));
  body.appendChild(scale);
  const scaleHint = div('panel-note');
  scaleHint.textContent = t('bus.scaleHint');
  body.appendChild(scaleHint);

  const look = div('field-row');
  const style = selectControl('bus.style', t('bus.style'),
    [['line', t('bus.styleLine')], ['step', t('bus.styleStep')]], d.style);
  style.addEventListener('change', () => { d.style = style.value as BusDrawStyle; });
  look.appendChild(style.el);
  const height = selectControl('bus.height', t('bus.height'),
    BUS_HEIGHTS.map((h): SelectOptionTuple => [String(h), `${h} px`]), String(d.heightCss));
  height.addEventListener('change', () => { d.heightCss = Number(height.value); });
  look.appendChild(height.el);
  body.appendChild(look);

  const hide = document.createElement('label');
  hide.className = 'bus-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = d.hideSources;
  box.addEventListener('change', () => { d.hideSources = box.checked; });
  hide.append(box, document.createTextNode(t('bus.hideSources')));
  body.appendChild(hide);

  return {
    el: body,
    read: () => {
      const fullText = fs.value.trim();
      const fullNumber = Number(fullText);
      const offsetNumber = Number(off.value);
      const clockChannel = Number(clock.value);
      const bits = options.fixedBankStart === null ? [...d.spec.bits] :
        runBits(options.fixedBankStart, CHANNEL_BANK_SIZE, cc, msbBox.checked);
      return cloneBusConfig({
        ...d,
        name: name.value.trim() || 'ADC',
        spec: {
          bits,
          clock: clockChannel < 0 ? null : {
            channel: clockChannel, edge: edge.value as 'rising' | 'falling',
          },
          encoding: enc.value as BusEncoding,
        },
        fullScaleV: fullText === '' || !Number.isFinite(fullNumber) || fullNumber === 0 ? null : fullNumber,
        offsetV: Number.isFinite(offsetNumber) ? offsetNumber : 0,
        style: style.value as BusDrawStyle,
        heightCss: Number(height.value),
        hideSources: box.checked,
      });
    },
  };
}

export class BusPanel {
  /** The bus being edited, or null when the editor adds a new one. */
  private editing: string | null = null;
  private draft: BusViewConfig | null = null;

  constructor(private readonly root: HTMLElement, private readonly cb: BusPanelCallbacks) {}

  set hidden(on: boolean) {
    this.root.hidden = on;
  }

  /** Open the editor on an existing bus (from its channel-list cell). */
  edit(bus: BusViewState): void {
    this.editing = bus.id;
    this.draft = cloneBusConfig(bus);
  }

  render(v: BusPanelView): void {
    this.root.replaceChildren();
    if (this.editing && !v.buses.some((b) => b.id === this.editing)) { this.editing = null; this.draft = null; }
    const draft = this.draft ??= defaultBusConfig(v.channelCount);

    const wrap = div('bus-panel');
    const head = div('panel-head');
    const title = div('panel-title');
    title.textContent = t('bus.title');
    const sub = div('panel-sub');
    sub.textContent = t('bus.sub');
    head.append(title, sub);
    wrap.appendChild(head);

    if (v.buses.length) {
      const s = section(t('bus.attached'));
      for (const b of v.buses) {
        const row = div('bus-row');
        const sq = document.createElement('span');
        sq.className = 'bus-sq';
        sq.style.background = b.color;
        const name = document.createElement('span');
        name.className = 'bus-name';
        name.textContent = b.name;
        const info = document.createElement('span');
        info.className = 'bus-info';
        const progress = b.builder && !b.builder.done
          ? ` · ${t('bus.building', { pct: Math.floor(b.builder.progress * 100) })}` : '';
        info.textContent = `${busSummary(b.spec)} · ${t(ENCODINGS.find(([e]) => e === b.spec.encoding)![1])}${progress}`;
        info.title = info.textContent;
        // One click, applied at once: ADC data lines are often wired MSB-first.
        const swap = button(t('bus.swapShort'), 'bus-btn');
        swap.title = t('bus.swap');
        swap.addEventListener('click', () => this.cb.onUpdate(b.id, { ...cloneBusConfig(b), spec: swapBusOrder(b.spec) }));
        const edit = button(t('bus.editButton'), 'bus-btn');
        edit.addEventListener('click', () => { this.edit(b); this.rerender(v); });
        const remove = button(t('bus.remove'), 'bus-btn bus-btn--remove');
        remove.addEventListener('click', () => this.cb.onRemove(b.id));
        row.append(sq, name, info, swap, edit, remove);
        s.body.appendChild(row);
      }
      wrap.appendChild(s.el);
    }

    wrap.appendChild(this.editor(draft, v));
    this.root.appendChild(wrap);
  }

  /** Re-render after a draft change. */
  private rerender(v: BusPanelView): void {
    this.render(v);
  }

  private editor(d: BusViewConfig, v: BusPanelView): HTMLElement {
    const s = section(t(this.editing ? 'bus.edit' : 'bus.add'));
    const fields = busConfigFields(d, {
      channelCount: v.channelCount,
      fixedBankStart: null,
      onRebuild: (next, keepPerBitOpen) => {
        this.draft = next;
        this.rerender(v);
        if (keepPerBitOpen) this.root.querySelector<HTMLDetailsElement>('.bus-perbit')?.setAttribute('open', '');
      },
    });
    s.body.appendChild(fields.el);
    const problems = validateBusSpec(fields.read().spec, v.channelCount);
    if (problems.length) {
      const err = div('panel-note error');
      err.textContent = problems.join('\n');
      s.body.appendChild(err);
    }

    const actions = div('bus-actions');
    const go = button(t(this.editing ? 'bus.save' : 'bus.addButton'), 'pill primary');
    go.disabled = problems.length > 0;
    go.addEventListener('click', () => {
      const cfg = fields.read();
      if (this.editing) this.cb.onUpdate(this.editing, cfg);
      else this.cb.onAdd(cfg);
      this.editing = null;
      this.draft = null;
    });
    actions.appendChild(go);
    if (this.editing) {
      const cancel = button(t('bus.cancel'), 'pill');
      cancel.addEventListener('click', () => { this.editing = null; this.draft = null; this.rerender(v); });
      actions.appendChild(cancel);
    }
    s.body.appendChild(actions);
    return s.el;
  }
}

export interface BankBusDialogCallbacks {
  onConfirm(start: number, config: BusViewConfig, enabled: boolean): void;
}

export class BankBusDialog {
  private readonly dialog = document.createElement('dialog');
  private start = 0;
  private active = false;
  private channelCount = 0;

  constructor(private readonly cb: BankBusDialogCallbacks) {
    this.dialog.className = 'channel-settings-dialog bank-bus-dialog';
    this.dialog.setAttribute('aria-labelledby', 'bank-bus-dialog-title');
    document.body.appendChild(this.dialog);
    this.dialog.addEventListener('close', () => {
      document.querySelector<HTMLButtonElement>(`[data-adc-open="${this.start}"]`)?.focus({ preventScroll: true });
    });
    this.dialog.addEventListener('pointerdown', (event) => {
      if (event.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right &&
        event.clientY >= rect.top && event.clientY <= rect.bottom) return;
      event.preventDefault();
      this.dialog.close('cancel');
    });
  }

  open(start: number, config: BusViewConfig, active: boolean, channelCount: number): void {
    this.start = start;
    this.active = active;
    this.channelCount = channelCount;
    this.render(normalizeBankBusConfig(config, channelCount, start));
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector<HTMLInputElement>('[data-adc-enable]')?.focus({ preventScroll: true });
  }

  close(): void {
    if (this.dialog.open) this.dialog.close('cancel');
  }

  private render(config: BusViewConfig): void {
    const range = channelBankRange(this.start, this.channelCount);
    const form = document.createElement('form');
    form.className = 'channel-settings-form bank-bus-form';
    const header = div('channel-settings-header');
    const title = document.createElement('h2');
    title.id = 'bank-bus-dialog-title';
    title.textContent = t('bus.bankDialogTitle', { range });
    header.appendChild(title);

    const enableLabel = document.createElement('label');
    enableLabel.className = 'bus-check bank-bus-enable';
    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.checked = this.active;
    enable.dataset.adcEnable = '';
    enableLabel.append(enable, document.createTextNode(t('bus.enableBank')));
    const note = div('channel-settings-copy');
    const updateNote = (): void => {
      note.textContent = enable.checked ? t('bus.bankEnabledNote', { range })
        : this.active ? t('bus.bankDisableNote', { range }) : t('bus.bankDisabledNote', { range });
    };
    enable.addEventListener('change', updateNote);
    updateNote();

    const fields = busConfigFields(config, {
      channelCount: this.channelCount,
      fixedBankStart: this.start,
      onRebuild: () => {},
    });
    const fieldWrap = div('channel-settings-fields bank-bus-fields');
    fieldWrap.appendChild(fields.el);

    const actions = div('channel-settings-actions');
    const cancel = button(t('bus.cancel'), 'pill');
    cancel.type = 'button';
    cancel.dataset.adcCancel = '';
    cancel.addEventListener('click', () => this.dialog.close('cancel'));
    const confirm = button(t('bus.confirm'), 'pill primary');
    confirm.type = 'submit';
    confirm.dataset.adcConfirm = '';
    actions.append(cancel, confirm);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const next = normalizeBankBusConfig(fields.read(), this.channelCount, this.start);
      if (validateBusSpec(next.spec, this.channelCount).length > 0) return;
      const enabled = enable.checked;
      this.dialog.close('applied');
      this.cb.onConfirm(this.start, next, enabled);
    });
    form.append(header, enableLabel, note, fieldWrap, actions);
    this.dialog.replaceChildren(form);
  }
}
