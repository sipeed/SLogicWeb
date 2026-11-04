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
  BUS_HEIGHTS, DEFAULT_BUS_HEIGHT, applyBusBitOrder, busSummary, resolveBusBitOrder, runBits, runStart,
  swapBusOrder, type BusBitOrder, type BusDrawStyle, type BusViewConfig, type BusViewState,
} from './busView.js';
import { button, div, labelled, section } from './capturePanel.js';
import { CHANNEL_BANK_SIZE, channelBankIndices } from './channelBanks.js';
import { t, type MessageKey } from './i18n.js';
import { selectControl, type SelectOptionTuple } from './select.js';

export interface BusPanelView {
  buses: readonly BusViewState[];
  /** Channels a bus may use: the current capture's, or the device's when there is none. */
  channelCount: number;
  /** The capture's test mode: `auto` bit order resolves against it. */
  testMode: number;
  captureLocked: boolean;
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
    ...(c.bitOrder !== undefined ? { bitOrder: c.bitOrder } : {}),
    ...(c.analogGroup !== undefined ? { analogGroup: c.analogGroup } : {}),
    ...(c.voltsPerDiv !== undefined ? { voltsPerDiv: c.voltsPerDiv } : {}),
    ...(c.zeroPosition !== undefined ? { zeroPosition: c.zeroPosition } : {}),
    ...(c.usesDefaultName ? { usesDefaultName: true } : {}),
    spec: { bits: [...c.spec.bits], clock: c.spec.clock ? { ...c.spec.clock } : null, encoding: c.spec.encoding },
  };
}

export function defaultBusConfig(channelCount: number, testMode = 0): BusViewConfig {
  const n = Math.min(8, channelCount);
  const msbFirst = resolveBusBitOrder('auto', testMode) === 'msb';
  return {
    name: 'ADC',
    spec: { bits: runBits(0, n, channelCount, msbFirst), clock: null, encoding: 'unsigned' },
    bitOrder: 'auto',
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

type BusDraftUpdate = (patch: Partial<BusViewConfig>, spec?: Partial<BusSpec>) => void;

interface BusFields {
  el: HTMLElement;
  read(): BusViewConfig;
}

interface BusAdvancedFieldsOptions {
  channelCount: number;
  disabled?: boolean;
  update: BusDraftUpdate;
}

function busAdvancedFields(d: BusViewConfig, options: BusAdvancedFieldsOptions): BusFields {
  const body = div('bus-config-fields');
  const cc = options.channelCount;
  const disabled = options.disabled === true;
  const chOptions: SelectOptionTuple[] = Array.from({ length: cc }, (_, i) => [String(i), `D${i}`]);
  const clockOptions = chOptions;

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
  /** The capture's test mode: `auto` bit order resolves against it. */
  testMode: number;
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
  // Width, the LSB channel and the bit order describe a contiguous run, the common wiring.
  // Regenerating the run uses the declared order rather than the bits' current direction,
  // so a draft that has not been committed yet (or was just switched to Auto) still lands
  // on the orientation the settings ask for.
  const msbFirst = resolveBusBitOrder(d.bitOrder ?? 'auto', options.testMode) === 'msb';
  const row = div('field-row');
  const n = document.createElement('input');
  n.type = 'number';
  n.min = '1';
  n.max = String(Math.min(MAX_BUS_BITS, cc));
  n.value = String(d.spec.bits.length);
  n.addEventListener('change', () => {
    const width = Math.max(1, Math.min(MAX_BUS_BITS, cc, Math.round(Number(n.value)) || 1));
    update({}, { bits: runBits(run.start, width, cc, msbFirst) });
  });
  row.appendChild(labelled(t('bus.bits'), n));
  const start = selectControl('bus.start', t('bus.start'), chOptions, String(run.start));
  start.addEventListener('change', () => update({}, { bits: runBits(Number(start.value), d.spec.bits.length, cc, msbFirst) }));
  row.appendChild(start.el);
  body.appendChild(row);

  const order = selectControl('bus.bitOrder', t('bus.bitOrder'),
    [['auto', t('bus.bitOrderAuto')], ['msb', t('bus.bitOrderMsb')], ['lsb', t('bus.bitOrderLsb')]],
    d.bitOrder ?? 'auto');
  order.disabled = d.spec.bits.length < 2;
  order.addEventListener('change', () => {
    const bitOrder = order.value as BusBitOrder;
    const msb = resolveBusBitOrder(bitOrder, options.testMode) === 'msb';
    update({ bitOrder }, { bits: runBits(run.start, d.spec.bits.length, cc, msb) });
  });
  body.appendChild(order.el);

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

  const advanced = busAdvancedFields(d, { channelCount: cc, update });
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
    // The draft keeps Auto in step with the capture mode, even while the editor is open.
    if (this.draft) this.draft = applyBusBitOrder(this.draft, v.testMode);
    const draft = this.draft ??= defaultBusConfig(v.channelCount, v.testMode);

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
        if (b.analogGroup === undefined) {
          const swap = button(t('bus.swapShort'), 'bus-btn');
          swap.title = t('bus.swap');
          swap.addEventListener('click', () => {
            // Reversing is an explicit choice: pin the order so Auto does not undo it at
            // the next test-mode change.
            const flipped: BusBitOrder = resolveBusBitOrder(b.bitOrder ?? 'auto', v.testMode) === 'msb' ? 'lsb' : 'msb';
            this.cb.onUpdate(b.id, { ...cloneBusConfig(b), bitOrder: flipped, spec: swapBusOrder(b.spec) });
          });
          row.appendChild(swap);
        }
        // An analog bank has one control, the Analog button in the Device panel; its
        // wiring and name are the ADC module's, so it is not editable here.
        if (b.analogGroup === undefined) {
          const edit = button(t('bus.editButton'), 'bus-btn');
          edit.addEventListener('click', () => this.cb.onEdit(b.id));
          row.appendChild(edit);
        }
        const remove = button(t('bus.remove'), 'bus-btn bus-btn--remove');
        remove.disabled = v.captureLocked && b.analogGroup !== undefined;
        remove.addEventListener('click', () => this.cb.onRemove(b.id));
        row.appendChild(remove);
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
      testMode: v.testMode,
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

    const actions = div('bus-actions');
    const go = button(t(this.editing ? 'bus.save' : 'bus.addButton'), 'pill primary');
    const editingBank = this.editing !== null && v.buses
      .some((bus) => bus.id === this.editing && bus.analogGroup !== undefined);
    go.disabled = problems.length > 0 ||
      (v.captureLocked && (editingBank || current.analogGroup !== undefined));
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
