// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The "Bus views" section of the Decoders page: a list of bus views under a header Add
 * button, and the editor dialog Add and Edit open (DESIGN §5.3).
 *
 * It has a host of its own under the analyzers sidebar (AnalyzerPanel clears its host
 * whenever it re-renders); the dialog lives in the document body, outside that host, and
 * keeps its draft across re-renders, so a capture finishing mid-edit does not lose what
 * was typed. Only the shared helpers are reused; the class names are its own.
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
  /** The editor dialog is about to open: close menus and other dialogs (one overlay). */
  onOpenDialog?(): void;
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
    ...(c.analogGain !== undefined ? { analogGain: c.analogGain } : {}),
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
  // The explicit swap reverses whatever wiring the bits have (a per-bit mapping too, which
  // the order select would regenerate as a run), and pins the order so Auto does not
  // undo it at the next test-mode change.
  const swap = button(t('bus.swap'), 'bus-btn bus-swap');
  swap.type = 'button';
  swap.dataset.busSwap = '';
  swap.disabled = d.spec.bits.length < 2;
  swap.addEventListener('click', () => {
    const flipped: BusBitOrder =
      resolveBusBitOrder(d.bitOrder ?? 'auto', options.testMode) === 'msb' ? 'lsb' : 'msb';
    options.onRebuild({ ...d, bitOrder: flipped, spec: swapBusOrder(d.spec) }, false);
  });
  const orderRow = div('field-row bus-order-row');
  orderRow.append(order.el, swap);
  body.appendChild(orderRow);

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

/** Inputs, buttons and summaries in tree order: where focus goes back after a rebuild. */
function focusables(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: Element): void => {
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'input' || tag === 'button' || tag === 'summary' || tag === 'select') {
        out.push(child as HTMLElement);
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

/**
 * The Bus views section and its editor dialog (DESIGN §5.3 "Bus views").
 *
 * The section header carries the one `Add` button; each listed bus has exactly `Edit` and
 * `Remove` (an analog bank, managed by its Analog button, has `Remove` only). Add and
 * Edit open one native modal dialog with the editor: Esc/back and Cancel close it, the
 * primary action applies, and a re-render of the section (a capture finishing, a bus
 * builder's progress) never rebuilds the open form, so the draft and the focus survive.
 * The form is rebuilt only when its own draft changes, or when the channel count, the
 * test mode or the locale it was built for changes (the typed values are read back into
 * the draft first). The dialog closes when the bus it edits disappears.
 */
export class BusPanel {
  /** The bus being edited, or null when the editor adds a new one. */
  private editing: string | null = null;
  private draft: BusViewConfig | null = null;
  private view: BusPanelView | null = null;
  private dialog: HTMLDialogElement | null = null;
  private dialogTitle: HTMLHeadingElement | null = null;
  private dialogBody: HTMLDivElement | null = null;
  private fields: BusFields | null = null;
  private go: HTMLButtonElement | null = null;
  /** The channel count, test mode and locale the open form was built for. */
  private formKey = '';
  private invoker: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement, private readonly cb: BusPanelCallbacks) {}

  /** True while the editor dialog is open. */
  get isOpen(): boolean {
    return this.dialog?.open === true;
  }

  /** The id of the bus the open dialog edits; null when adding or closed. */
  get editingId(): string | null {
    return this.isOpen ? this.editing : null;
  }

  /** Open the editor on an existing bus (its row's Edit, or its channel-list cell). */
  edit(bus: BusViewState, view: BusPanelView | null = null, invoker: HTMLElement | null = null): void {
    if (bus.analogGroup !== undefined) return;
    if (view) this.view = view;
    this.editing = bus.id;
    this.draft = cloneBusConfig(bus);
    this.openDialog(invoker);
  }

  /** Open the editor on a new bus (the section header's Add). */
  add(invoker: HTMLElement | null = null): void {
    if (!this.view) return;
    this.editing = null;
    this.draft = defaultBusConfig(this.view.channelCount, this.view.testMode);
    this.openDialog(invoker);
  }

  /** Close the editor without applying it. */
  close(): void {
    const invoker = this.invoker;
    const editing = this.editing;
    this.invoker = null;
    this.editing = null;
    this.draft = null;
    this.fields = null;
    this.go = null;
    this.formKey = '';
    if (this.dialog?.open) this.dialog.close();
    if (invoker?.isConnected) {
      invoker.focus();
      return;
    }
    // The opener was rebuilt while the dialog was open: its successor takes the focus.
    const successor = editing !== null
      ? this.root.querySelector<HTMLElement>(`[data-bus-edit="${CSS.escape(editing)}"]`)
      : this.root.querySelector<HTMLElement>('[data-bus-add]');
    if (successor?.isConnected) successor.focus();
  }

  render(v: BusPanelView): void {
    this.view = v;
    this.root.replaceChildren();

    const wrap = div('bus-panel');
    const s = section(t('bus.attached'));
    s.el.dataset.busViews = '';
    const add = button(t('bus.addButton'), 'bus-btn bus-add');
    add.type = 'button';
    add.dataset.busAdd = '';
    add.setAttribute('aria-label', t('bus.add'));
    add.setAttribute('aria-haspopup', 'dialog');
    add.addEventListener('click', () => this.add(add));
    s.header.appendChild(add);

    if (v.buses.length === 0) {
      const empty = div('panel-note');
      empty.dataset.busEmpty = '';
      empty.textContent = t('bus.sub');
      s.body.appendChild(empty);
    }
    for (const b of v.buses) s.body.appendChild(this.row(b, v));
    wrap.appendChild(s.el);
    this.root.appendChild(wrap);

    if (!this.isOpen) return;
    if (this.editing !== null && !v.buses.some((b) => b.id === this.editing)) {
      // The bus went away under the dialog (a capture load, a channel-width change).
      this.close();
      return;
    }
    if (this.formKey !== this.keyFor(v)) {
      // Keep what was typed, then follow the new channel count / test mode / locale.
      if (this.fields) this.draft = this.fields.read();
      this.renderForm();
    } else {
      this.syncGo();
    }
  }

  private row(b: BusViewState, v: BusPanelView): HTMLElement {
    const row = div('bus-row');
    row.dataset.busRow = b.id;
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
    // An analog bank has one control, the Analog button in the Acquire panel; its wiring
    // and name are the ADC module's, so it is not editable here.
    if (b.analogGroup === undefined) {
      const edit = button(t('bus.editButton'), 'bus-btn');
      edit.type = 'button';
      edit.dataset.busEdit = b.id;
      edit.setAttribute('aria-label', t('bus.edit', { name: b.name }));
      edit.setAttribute('aria-haspopup', 'dialog');
      edit.addEventListener('click', () => this.cb.onEdit(b.id));
      row.appendChild(edit);
    }
    const remove = button(t('bus.remove'), 'bus-btn bus-btn--remove');
    remove.type = 'button';
    remove.dataset.busRemove = b.id;
    remove.setAttribute('aria-label', t('bus.removeNamed', { name: b.name }));
    remove.disabled = v.captureLocked && b.analogGroup !== undefined;
    remove.addEventListener('click', () => this.cb.onRemove(b.id));
    row.appendChild(remove);
    return row;
  }

  private keyFor(v: BusPanelView): string {
    return `${v.channelCount}|${v.testMode}|${t('bus.addButton')}|${t('bus.name')}`;
  }

  private ensureDialog(): HTMLDialogElement {
    if (this.dialog) return this.dialog;
    const dialog = document.createElement('dialog');
    dialog.className = 'bus-dialog';
    dialog.dataset.busDialog = '';
    const titleId = 'bus-dialog-title';
    dialog.setAttribute('aria-labelledby', titleId);
    const title = document.createElement('h2');
    title.id = titleId;
    const header = document.createElement('header');
    header.className = 'bus-dialog-header';
    header.appendChild(title);
    const body = div('bus-dialog-body');
    const form = div('bus-dialog-form');
    form.append(header, body);
    dialog.appendChild(form);
    // Esc and the platform's back gesture arrive as `cancel`: close through one path so
    // the draft is dropped and focus returns to the control that opened the dialog.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    document.body.appendChild(dialog);
    this.dialog = dialog;
    this.dialogTitle = title;
    this.dialogBody = body;
    return dialog;
  }

  private openDialog(invoker: HTMLElement | null): void {
    if (!this.view) return;
    const dialog = this.ensureDialog();
    if (!dialog.open) {
      this.invoker = invoker ?? (document.activeElement as HTMLElement | null);
      // One overlay at a time: the owner closes menus and other dialogs first.
      this.cb.onOpenDialog?.();
    }
    this.renderForm();
    if (!dialog.open) dialog.showModal();
    this.dialogBody?.querySelector<HTMLInputElement>('input')?.focus();
  }

  /** Build the form from the draft, keeping the focused control and the per-bit list. */
  private renderForm(): void {
    const v = this.view;
    const body = this.dialogBody;
    const title = this.dialogTitle;
    if (!v || !body || !title) return;
    const before = focusables(body);
    const active = document.activeElement as HTMLElement | null;
    const focusAt = active ? before.indexOf(active) : -1;
    const perBitOpen = body.querySelector<HTMLDetailsElement>('.bus-perbit')?.open === true;

    // The draft keeps Auto in step with the capture mode, even while the editor is open.
    const draft = this.draft = applyBusBitOrder(
      this.draft ?? defaultBusConfig(v.channelCount, v.testMode), v.testMode);
    const editingName = this.editing !== null
      ? v.buses.find((b) => b.id === this.editing)?.name ?? draft.name : null;
    title.textContent = editingName !== null ? t('bus.edit', { name: editingName }) : t('bus.add');

    const fields = busConfigFields(draft, {
      channelCount: v.channelCount,
      testMode: v.testMode,
      onRebuild: (next, keepPerBitOpen) => {
        this.draft = next;
        this.renderForm();
        if (keepPerBitOpen) body.querySelector<HTMLDetailsElement>('.bus-perbit')?.setAttribute('open', '');
      },
    });
    this.fields = fields;
    const nodes: HTMLElement[] = [fields.el];
    const problems = validateBusSpec(fields.read().spec, v.channelCount);
    if (problems.length) {
      const err = div('panel-note error');
      err.dataset.busProblems = '';
      err.setAttribute('role', 'alert');
      err.textContent = problems.join('\n');
      nodes.push(err);
    }

    const actions = document.createElement('footer');
    actions.className = 'bus-actions bus-dialog-actions';
    const cancel = button(t('bus.cancel'), 'pill');
    cancel.type = 'button';
    cancel.dataset.busCancel = '';
    cancel.addEventListener('click', () => this.close());
    const go = button(t(this.editing ? 'bus.save' : 'bus.addButton'), 'pill primary');
    go.type = 'button';
    go.dataset.busSave = '';
    go.dataset.busProblems = String(problems.length);
    go.addEventListener('click', () => {
      if (go.disabled || !this.fields) return;
      const cfg = this.fields.read();
      const editing = this.editing;
      if (editing) this.cb.onUpdate(editing, cfg);
      else this.cb.onAdd(cfg);
      this.close();
    });
    actions.append(cancel, go);
    nodes.push(actions);
    this.go = go;
    body.replaceChildren(...nodes);
    if (perBitOpen) body.querySelector<HTMLDetailsElement>('.bus-perbit')?.setAttribute('open', '');
    this.formKey = this.keyFor(v);
    this.syncGo();

    if (focusAt >= 0) {
      const after = focusables(body);
      after[Math.min(focusAt, after.length - 1)]?.focus();
    }
  }

  /** The primary action follows the draft's validity and the capture lock. */
  private syncGo(): void {
    const v = this.view;
    const go = this.go;
    if (!v || !go) return;
    const editingBank = this.editing !== null && v.buses
      .some((bus) => bus.id === this.editing && bus.analogGroup !== undefined);
    const current = this.draft;
    go.disabled = Number(go.dataset.busProblems) > 0 ||
      (v.captureLocked && (editingBank || current?.analogGroup !== undefined));
  }
}
