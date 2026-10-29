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
import type { ChannelCount } from '../types.js';
import {
  BUS_HEIGHTS, DEFAULT_BUS_HEIGHT, busSummary, runBits, runStart, swapBusOrder,
  type BusDrawStyle, type BusViewConfig, type BusViewState,
} from './busView.js';
import { button, div, labelled, section } from './capturePanel.js';
import { CHANNEL_BANK_SIZE, busChannelBank, channelBankIndices, channelBankRange } from './channelBanks.js';
import { formatCount, formatDuration, formatRate } from './format.js';
import { t, type MessageKey } from './i18n.js';
import {
  DEFAULT_LOOP_TIME_UNIT, isLoopTimeUnit, loopSamplesFromTime, loopTimeFromSamples, maxLoopTimeValue,
  type LoopTimeUnit,
} from './loopTime.js';
import { OscilloscopeChannelGrid } from './oscilloscopeChannels.js';
import { scopeEnableVerdict, type ScopeEnableVerdict } from './scopeRateLimits.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import type { ChannelState } from './state.js';

export interface BusPanelView {
  buses: readonly BusViewState[];
  /** Channels a bus may use: the current capture's, or the device's when there is none. */
  channelCount: number;
  captureLocked: boolean;
  samplerate: number;
  captureChannels: ChannelCount;
  rateCeilings: Readonly<Record<number, number>>;
}

export interface BusPanelCallbacks {
  onAdd(cfg: BusViewConfig): void;
  onEdit(id: string): void;
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
    ...(c.usesDefaultName ? { usesDefaultName: true } : {}),
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
  const bank = channelBankIndices(start, channelCount);
  const allowed = new Set(bank);
  const seen = new Set<number>();
  const bits: number[] = [];
  for (const channel of config.spec.bits) {
    if (!allowed.has(channel) || seen.has(channel)) continue;
    bits.push(channel);
    seen.add(channel);
  }
  for (const channel of bank) {
    if (!seen.has(channel)) bits.push(channel);
  }
  const clock = config.spec.clock && !bits.includes(config.spec.clock.channel) &&
    config.spec.clock.channel >= 0 && config.spec.clock.channel < channelCount
    ? { ...config.spec.clock } : null;
  const usesDefaultName = config.usesDefaultName === true || config.name.trim() === '';
  const next = cloneBusConfig(config);
  next.name = usesDefaultName ? t('bus.defaultName') : config.name.trim();
  if (usesDefaultName) next.usesDefaultName = true;
  else delete next.usesDefaultName;
  next.spec = { bits, clock, encoding: config.spec.encoding };
  return next;
}

export function defaultBankBusConfig(channelCount: number, start: number): BusViewConfig {
  return normalizeBankBusConfig({
    ...defaultBusConfig(channelCount), name: t('bus.defaultName'), usesDefaultName: true,
  }, channelCount, start);
}

export function retranslateBankBusConfig<T extends BusViewConfig>(config: T): T {
  return config.usesDefaultName ? { ...config, name: t('bus.defaultName') } : config;
}

type BusDraftUpdate = (patch: Partial<BusViewConfig>, spec?: Partial<BusSpec>) => void;

interface BusFields {
  el: HTMLElement;
  read(): BusViewConfig;
}

interface BusAdvancedFieldsOptions {
  channelCount: number;
  bankStart: number | null;
  disabled?: boolean;
  update: BusDraftUpdate;
}

function busAdvancedFields(d: BusViewConfig, options: BusAdvancedFieldsOptions): BusFields {
  const body = div('bus-config-fields');
  const cc = options.channelCount;
  const disabled = options.disabled === true;
  const chOptions: SelectOptionTuple[] = Array.from({ length: cc }, (_, i) => [String(i), `D${i}`]);
  const bankBits = new Set(options.bankStart === null ? [] : channelBankIndices(options.bankStart, cc));
  const clockOptions = options.bankStart === null ? chOptions :
    chOptions.filter(([ch]) => !bankBits.has(Number(ch)));

  const clockRow = div('field-row');
  const clock = selectControl('bus.clock', t('bus.clock'),
    [['-1', t('bus.clockNone')], ...clockOptions], String(d.spec.clock?.channel ?? -1));
  clock.disabled = disabled;
  clock.addEventListener('change', () => {
    const ch = Number(clock.value);
    options.update({}, { clock: ch < 0 ? null : { channel: ch, edge: d.spec.clock?.edge ?? 'rising' } });
    edge.disabled = disabled || ch < 0;
  });
  clockRow.appendChild(clock.el);
  const edge = selectControl('bus.edge', t('bus.edge'),
    [['rising', t('bus.edgeRising')], ['falling', t('bus.edgeFalling')]], d.spec.clock?.edge ?? 'rising');
  edge.disabled = disabled || !d.spec.clock;
  edge.addEventListener('change', () => {
    if (d.spec.clock) options.update({}, { clock: { channel: d.spec.clock.channel, edge: edge.value as 'rising' | 'falling' } });
  });
  clockRow.appendChild(edge.el);
  body.appendChild(clockRow);

  const enc = selectControl('bus.encoding', t('bus.encoding'),
    ENCODINGS.map(([e, k]) => [e, t(k)]), d.spec.encoding);
  enc.disabled = disabled;
  enc.addEventListener('change', () => options.update({}, { encoding: enc.value as BusEncoding }));
  body.appendChild(enc.el);

  const scale = div('field-row');
  const fs = document.createElement('input');
  fs.type = 'number';
  fs.step = 'any';
  fs.placeholder = '—';
  fs.disabled = disabled;
  fs.value = d.fullScaleV === null ? '' : String(d.fullScaleV);
  fs.addEventListener('change', () => {
    const x = Number(fs.value);
    d.fullScaleV = fs.value.trim() === '' || !Number.isFinite(x) || x === 0 ? null : x;
  });
  scale.appendChild(labelled(t('bus.fullScale'), fs));
  const off = document.createElement('input');
  off.type = 'number';
  off.step = 'any';
  off.disabled = disabled;
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
  style.disabled = disabled;
  style.addEventListener('change', () => { d.style = style.value as BusDrawStyle; });
  look.appendChild(style.el);
  const height = selectControl('bus.height', t('bus.height'),
    BUS_HEIGHTS.map((h): SelectOptionTuple => [String(h), `${h} px`]), String(d.heightCss));
  height.disabled = disabled;
  height.addEventListener('change', () => { d.heightCss = Number(height.value); });
  look.appendChild(height.el);
  body.appendChild(look);

  const hide = document.createElement('label');
  hide.className = 'bus-check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = d.hideSources;
  box.disabled = disabled;
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
      return cloneBusConfig({
        ...d,
        spec: {
          ...d.spec,
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

interface BusConfigFieldsOptions {
  channelCount: number;
  onRebuild(next: BusViewConfig, keepPerBitOpen: boolean): void;
}

function busConfigFields(d: BusViewConfig, options: BusConfigFieldsOptions): BusFields {
  const body = div('bus-config-fields');
  const cc = options.channelCount;
  const update: BusDraftUpdate = (patch, spec) => {
    options.onRebuild({ ...d, ...patch, spec: { ...d.spec, ...spec } }, false);
  };
  const chOptions: SelectOptionTuple[] = Array.from({ length: cc }, (_, i) => [String(i), `D${i}`]);

  const name = document.createElement('input');
  name.type = 'text';
  name.value = d.name;
  name.addEventListener('change', () => { d.name = name.value.trim() || 'ADC'; });
  body.appendChild(labelled(t('bus.name'), name));

  const run = runStart(d.spec.bits);
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

  const msb = document.createElement('label');
  msb.className = 'bus-check';
  const msbBox = document.createElement('input');
  msbBox.type = 'checkbox';
  msbBox.checked = run.msbFirst;
  msbBox.disabled = d.spec.bits.length < 2;
  msbBox.addEventListener('change', () => update({}, { bits: runBits(run.start, d.spec.bits.length, cc, msbBox.checked) }));
  msb.append(msbBox, document.createTextNode(t('bus.msbFirst')));
  body.appendChild(msb);

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

  const advanced = busAdvancedFields(d, { channelCount: cc, bankStart: null, update });
  body.appendChild(advanced.el);
  return {
    el: body,
    read: () => {
      const next = advanced.read();
      next.name = name.value.trim() || 'ADC';
      next.spec = { ...next.spec, bits: [...d.spec.bits] };
      return cloneBusConfig(next);
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
        row.append(sq, name, info);
        if (busChannelBank(b.spec) === null) {
          const swap = button(t('bus.swapShort'), 'bus-btn');
          swap.title = t('bus.swap');
          swap.addEventListener('click', () => this.cb.onUpdate(b.id, { ...cloneBusConfig(b), spec: swapBusOrder(b.spec) }));
          row.appendChild(swap);
        }
        const edit = button(t('bus.editButton'), 'bus-btn');
        edit.addEventListener('click', () => this.cb.onEdit(b.id));
        const remove = button(t('bus.remove'), 'bus-btn bus-btn--remove');
        remove.disabled = v.captureLocked && busChannelBank(b.spec) !== null;
        remove.addEventListener('click', () => this.cb.onRemove(b.id));
        row.append(edit, remove);
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
      onRebuild: (next, keepPerBitOpen) => {
        this.draft = next;
        this.rerender(v);
        if (keepPerBitOpen) this.root.querySelector<HTMLDetailsElement>('.bus-perbit')?.setAttribute('open', '');
      },
    });
    s.body.appendChild(fields.el);
    const current = fields.read();
    const problems = validateBusSpec(current.spec, v.channelCount);
    if (problems.length) {
      const err = div('panel-note error');
      err.textContent = problems.join('\n');
      s.body.appendChild(err);
    }

    const draftBank = busChannelBank(current.spec);
    let scopeBlock: ScopeEnableVerdict | null = null;
    if (problems.length === 0 && draftBank !== null) {
      const verdict = scopeEnableVerdict({
        start: draftBank,
        clockChannel: current.spec.clock?.channel ?? null,
        currentWidth: v.captureChannels,
        rate: v.samplerate,
        ceilings: v.rateCeilings,
        deviceChannels: v.channelCount,
      });
      if (!verdict.ok) scopeBlock = verdict;
    }
    if (scopeBlock !== null) {
      const err = div('panel-note error');
      err.dataset.scopeRateNote = '';
      err.textContent = t('bus.scopeRateLimited', {
        rate: formatRate(scopeBlock.effectiveRate),
        channels: scopeBlock.maxWidth,
        width: scopeBlock.requiredWidth,
        maxRate: formatRate(scopeBlock.maxRate),
      });
      s.body.appendChild(err);
    }

    const actions = div('bus-actions');
    const go = button(t(this.editing ? 'bus.save' : 'bus.addButton'), 'pill primary');
    const editingBank = this.editing !== null && v.buses
      .some((bus) => bus.id === this.editing && busChannelBank(bus.spec) !== null);
    go.disabled = problems.length > 0 || scopeBlock !== null ||
      (v.captureLocked && (editingBank || busChannelBank(current.spec) !== null));
    go.addEventListener('click', () => {
      if (go.disabled) return;
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
  onConfirm(start: number, config: BusViewConfig, enabled: boolean, loopSamples: number): void;
}

export interface BankBusDialogOpenContext {
  channels: readonly ChannelState[];
  loopSamples: number;
  captureChannels: ChannelCount;
  samplerate: number;
  locked: boolean;
  enableBlock: ScopeEnableVerdict | null;
}

interface BankBusDetails {
  el: HTMLElement;
  read(): { config: BusViewConfig; loopSamples: number | null };
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

  open(
    start: number, config: BusViewConfig, active: boolean, channelCount: number,
    context: BankBusDialogOpenContext,
  ): void {
    this.start = start;
    this.active = active;
    this.channelCount = channelCount;
    this.render(normalizeBankBusConfig(config, channelCount, start), context);
    if (!this.dialog.open) this.dialog.showModal();
    this.dialog.querySelector<HTMLInputElement>('[data-adc-enable]')?.focus({ preventScroll: true });
  }

  close(): void {
    if (this.dialog.open) this.dialog.close('cancel');
  }

  private createDetails(config: BusViewConfig, context: BankBusDialogOpenContext): BankBusDetails {
    const body = div('channel-settings-fields bank-bus-fields');
    const name = document.createElement('input');
    name.type = 'text';
    name.value = config.name;
    name.disabled = context.locked;
    name.dataset.oscilloscopeName = '';
    body.appendChild(labelled(t('bus.name'), name));

    const channelField = div('bank-bus-channel-field');
    const channelLabel = div('bank-bus-field-label');
    channelLabel.textContent = t('bus.channelOrder');
    channelField.appendChild(channelLabel);
    const bankChannels = channelBankIndices(this.start, this.channelCount).flatMap((index) => {
      const channel = context.channels.find((candidate) => candidate.index === index);
      return channel ? [channel] : [];
    });
    const grid = new OscilloscopeChannelGrid(bankChannels, config.spec.bits, {
      disabled: context.locked,
      onChange: (bits) => { config.spec = { ...config.spec, bits }; },
    });
    const dragNote = div('panel-note bank-bus-drag-note');
    dragNote.textContent = t('bus.dragToOrder');
    channelField.append(grid.el, dragNote);
    body.appendChild(channelField);

    const loopCard = div('bank-bus-loop');
    const loopTitle = div('bank-bus-loop-title');
    const loopName = document.createElement('span');
    loopName.textContent = t('bus.loopWindow');
    const globalTag = document.createElement('span');
    globalTag.className = 'bank-bus-global';
    globalTag.textContent = t('bus.globalCapture');
    loopTitle.append(loopName, globalTag);
    loopCard.appendChild(loopTitle);

    const loopRow = div('bank-bus-loop-row');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'bank-bus-loop-input';
    input.min = '1';
    input.step = '1';
    input.inputMode = 'numeric';
    input.dataset.loopInput = '';
    input.setAttribute('aria-label', t('bus.loopWindow'));
    let unit: LoopTimeUnit = DEFAULT_LOOP_TIME_UNIT;
    const initialValue = loopTimeFromSamples(context.loopSamples, unit, context.samplerate, context.captureChannels);
    input.value = String(initialValue ?? 1);
    const unitControl = selectControl('bus.loopUnit', t('bus.loopUnit'),
      [['us', 'us'], ['ms', 'ms'], ['s', 's']], unit);
    unitControl.el.dataset.loopUnit = '';
    const inputField = div('field bank-bus-loop-value');
    inputField.appendChild(input);
    loopRow.append(inputField, unitControl.el);
    loopCard.appendChild(loopRow);
    const limit = div('panel-note bank-bus-loop-limit');
    const effective = div('panel-note bank-bus-loop-effective');
    loopCard.append(limit, effective);
    body.appendChild(loopCard);

    let loopDirty = false;
    const currentSamples = (): number | null => loopDirty
      ? loopSamplesFromTime(Number(input.value), unit, context.samplerate, context.captureChannels)
      : context.loopSamples;
    const updateLoop = (): void => {
      const max = maxLoopTimeValue(context.captureChannels, context.samplerate, unit);
      input.max = String(max);
      input.disabled = context.locked || max < 1;
      unitControl.disabled = context.locked || max < 1;
      limit.textContent = max > 0 ? t('bus.loopMax', { value: max, unit }) : '';
      const samples = currentSamples();
      effective.classList.toggle('error', max > 0 && samples === null);
      if (max < 1) effective.textContent = t('bus.loopUnavailable');
      else if (samples === null) effective.textContent = t('bus.loopInvalid');
      else {
        effective.textContent = t('bus.loopEffective', {
          samples: formatCount(samples), duration: formatDuration(samples / context.samplerate),
        });
      }
    };
    input.addEventListener('input', () => {
      loopDirty = true;
      updateLoop();
    });
    unitControl.addEventListener('change', () => {
      const nextUnit = isLoopTimeUnit(unitControl.value) ? unitControl.value : DEFAULT_LOOP_TIME_UNIT;
      const samples = currentSamples();
      if (samples !== null) {
        const nextValue = loopTimeFromSamples(samples, nextUnit, context.samplerate, context.captureChannels);
        if (nextValue !== null) input.value = String(nextValue);
      }
      unit = nextUnit;
      loopDirty = true;
      updateLoop();
    });
    updateLoop();

    const update: BusDraftUpdate = (patch, spec) => {
      const next = { ...config, ...patch, spec: { ...config.spec, ...spec } };
      Object.assign(config, patch);
      config.spec = next.spec;
    };
    const advancedFields = busAdvancedFields(config, {
      channelCount: this.channelCount, bankStart: this.start, disabled: context.locked, update,
    });
    const advanced = document.createElement('details');
    advanced.className = 'bank-bus-advanced';
    advanced.dataset.oscilloscopeAdvanced = '';
    const summary = document.createElement('summary');
    summary.textContent = t('bus.advanced');
    advanced.append(summary, advancedFields.el);
    body.appendChild(advanced);

    return {
      el: body,
      read: () => {
        const next = advancedFields.read();
        const nameText = name.value.trim();
        const usesDefaultName = nameText === '' || (config.usesDefaultName === true && nameText === config.name);
        next.name = usesDefaultName ? t('bus.defaultName') : nameText;
        if (usesDefaultName) next.usesDefaultName = true;
        else delete next.usesDefaultName;
        return { config: next, loopSamples: currentSamples() };
      },
    };
  }

  private render(config: BusViewConfig, context: BankBusDialogOpenContext): void {
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
    enable.disabled = context.locked;
    enable.dataset.adcEnable = '';
    enableLabel.append(enable, document.createTextNode(t('bus.enableBank')));

    const enableBlock = context.enableBlock;
    let blockNote: HTMLDivElement | null = null;
    const showBlockNote = (): void => {
      if (enableBlock === null) return;
      if (blockNote === null) {
        blockNote = div('panel-note error');
        blockNote.dataset.scopeRateNote = '';
        blockNote.textContent = t('bus.scopeRateLimited', {
          rate: formatRate(enableBlock.effectiveRate),
          channels: enableBlock.maxWidth,
          width: enableBlock.requiredWidth,
          maxRate: formatRate(enableBlock.maxRate),
        });
        enableLabel.after(blockNote);
      }
    };

    const actions = div('channel-settings-actions');
    const cancel = button(t('bus.cancel'), 'pill');
    cancel.type = 'button';
    cancel.dataset.adcCancel = '';
    cancel.addEventListener('click', () => this.dialog.close('cancel'));
    const confirm = button(t('bus.confirm'), 'pill primary');
    confirm.type = 'submit';
    confirm.disabled = context.locked;
    confirm.dataset.adcConfirm = '';
    actions.append(cancel, confirm);

    let details: BankBusDetails | null = null;
    const syncDetails = (): void => {
      if (!enable.checked) {
        details?.el.remove();
        return;
      }
      details ??= this.createDetails(config, context);
      if (details.el.parentNode !== form) form.insertBefore(details.el, actions);
    };
    enable.addEventListener('change', () => {
      if (enable.checked && enableBlock !== null) {
        enable.checked = false;
        showBlockNote();
        return;
      }
      syncDetails();
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (context.locked || !form.reportValidity()) return;
      const enabled = enable.checked;
      if (enabled && enableBlock !== null) {
        showBlockNote();
        return;
      }
      const current = enabled
        ? (details ??= this.createDetails(config, context)).read()
        : { config, loopSamples: context.loopSamples };
      const next = normalizeBankBusConfig(current.config, this.channelCount, this.start);
      if (validateBusSpec(next.spec, this.channelCount).length > 0 || current.loopSamples === null) {
        if (current.loopSamples === null) this.dialog.querySelector<HTMLInputElement>('[data-loop-input]')?.focus();
        return;
      }
      this.dialog.close('applied');
      this.cb.onConfirm(this.start, next, enabled, current.loopSamples);
    });
    form.append(header, enableLabel, actions);
    this.dialog.replaceChildren(form);
    syncDetails();
  }
}
