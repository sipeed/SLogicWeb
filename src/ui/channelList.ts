// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The channel label column.
 *
 * [MEASURED] on 01-idle-empty-session.png at y=240: a 5 CSS px strip of the channel colour
 * at the far left, the "D0" tag in the *channel colour* starting at x=18, and below it one
 * line per attached analyzer - a filled square in the analyzer's colour then its name in
 * small grey text. The column is 106 CSS px wide including a 1 CSS px `#57575F` right
 * border.
 *
 * Each cell's height is its row's height in the waveform stack, annotation lanes included,
 * so the labels line up with the traces by construction rather than by a shared constant
 * that could drift.
 *
 * Under the dark theme each cell renders as one rounded card (strip + body wrapped in
 * `.ch-card`), all cards exactly the trace-band height thanks to the `--ch-lane-offset`
 * margin and a reserved one-line decoder strip - see src/ui/NOTES.md section 13.
 *
 * The row itself is the editor: double-click the name for a quick rename, or click the
 * trigger glyph for the edge menu, in a small popover rather than a modal. Colour is not
 * editable (it belongs to the channel identity), so there is no colour picker.
 */

import { ANALOG_HEIGHTS, analogHeightIndex, stepAnalogHeight } from './busView.js';
import {
  ANALOG_GAIN_DEFAULT, analogHalfRangeV, analogVoltsPerCode, formatAnalogGain,
} from './channelBanks.js';
import { formatAnalyzerNote } from './format.js';
import { t } from './i18n.js';
import { defaultChannelName,
  type AnalyzerState, type ChannelState, type TriggerMode } from './state.js';

export interface ChannelConfiguration {
  name: string;
  mode: TriggerMode;
  color: string;
}

export interface ChannelLaneLabel {
  /** The row name shown in the lane strip. */
  readonly text: string;
  /** The tooltip: analyzer label and row name. */
  readonly title: string;
  readonly color: string;
}

export interface ChannelCell {
  channel: ChannelState;
  /** Total CSS height, base row plus every lane this channel carries. */
  heightCss: number;
  /**
   * The lane part of `heightCss` (0 when the channel carries no annotations). The
   * dark theme's card reads it as `--ch-lane-offset` to hug the trace band, so
   * cards are one consistent height whether or not a decoder is attached.
   */
  laneCss: number;
  /**
   * One label per annotation lane above the trace, top to bottom: the localized row
   * name ("RX data", "地址/数据") in the analyzer's colour. Absent or empty: no lanes.
   */
  lanes?: readonly ChannelLaneLabel[];
  analyzers: AnalyzerState[];
  trigger: {
    mode: TriggerMode;
    /** Configured icons stay neutral; only the selected, enabled source is bright. */
    armed: boolean;
    /** Capture state locks digital trigger edits, not unrelated channel metadata. */
    disabled: boolean;
  };
}

export interface ChannelListCallbacks {
  /** Commit one dialog draft; App owns every resulting session mutation. */
  onConfigure(index: number, config: ChannelConfiguration): void;
  /** Move the channel at `from` in display order to `to`. */
  onReorder(from: number, to: number): void;
  onRemoveAnalyzer(id: string): void;
  /** Open the editor for a parallel-bus view (its cell's gear). */
  onEditBus?(id: string): void;
  /** Analog scope controls: preview while dragging (`commit` false), then persist. */
  onBusScope?(id: string, patch: BusScopePatch, commit: boolean): void;
  /** Configure/remove the analog trigger from the group's own row. */
  onBusTrigger?(id: string, kind: 'rising' | 'falling' | null, volts: number): void;
}

/** A parallel-bus (ADC) row's cell: a label for the analog row, not a channel. */
export interface BusCell {
  id: string;
  name: string;
  /** e.g. "D0–D11 · ↑D12". */
  summary: string;
  color: string;
  heightCss: number;
  /** An ADC group's scope controls (V/Div, zero position, height). */
  analog?: boolean;
  /** An ADC group's declared hardware gain (1 when absent); its range is ±16 V / gain. */
  gain?: number;
  /** The analog trigger configured on this group, if any. */
  trigger?: { kind: 'rising' | 'falling'; volts: number };
  /**
   * True only when this configured trigger is the live capture source. A configured
   * trigger stays visible as a preview, but only an active one may look armed.
   */
  triggerActive?: boolean;
}

export interface BusScopePatch {
  voltsPerDiv?: number;
  zeroPosition?: number;
  heightCss?: number;
}

const TRIGGER_MODES_MENU: readonly TriggerMode[] = ['dont-care', 'rising', 'falling', 'edge', 'high', 'low'];

export class ChannelList {
  private dragFrom = -1;
  private readonly editor: HTMLDivElement;
  private editorAnchor: HTMLButtonElement | null = null;
  private editorChannel = -1;
  private editorBusId: string | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ChannelListCallbacks,
  ) {
    // One shared quick-edit popover, not a modal per channel: name + trigger edge are
    // the two things edited often, and HSync's channel label exposes them in place.
    this.editor = document.createElement('div');
    this.editor.className = 'ch-editor-popover';
    this.editor.hidden = true;
    document.body.appendChild(this.editor);
    document.addEventListener('pointerdown', (event) => {
      if (this.editor.hidden) return;
      const target = event.target as Node | null;
      if (target && (this.editor.contains(target) || this.editorAnchor?.contains(target))) return;
      this.closeEditor();
    });
    document.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape' && !this.editor.hidden) {
        event.preventDefault();
        this.closeEditor();
      }
    });
  }

  private closeEditor(restoreFocus = true): void {
    if (this.editor.hidden) return;
    const anchor = this.editorAnchor;
    this.editor.hidden = true;
    this.editor.replaceChildren();
    anchor?.setAttribute('aria-expanded', 'false');
    this.editorAnchor = null;
    this.editorChannel = -1;
    this.editorBusId = null;
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
  }

  private positionEditor(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const width = this.editor.offsetWidth;
    const height = this.editor.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    this.editor.style.left = `${left}px`;
    this.editor.style.top = `${below + height <= window.innerHeight - 8
      ? below : Math.max(8, rect.top - height - 6)}px`;
  }

  private openEditor(
    anchor: HTMLButtonElement, cell: ChannelCell, focus: 'name' | 'trigger',
  ): void {
    this.closeEditor(false);
    this.editorAnchor = anchor;
    this.editorChannel = cell.channel.index;
    this.editorBusId = null;
    const index = cell.channel.index;
    const title = document.createElement('div');
    title.className = 'ch-editor-title';
    title.id = 'ch-editor-title';
    title.textContent = t('channels.settings', { index });

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = cell.channel.name;
    nameInput.spellcheck = false;
    nameInput.autocomplete = 'off';
    nameInput.setAttribute('aria-label', t('channels.name'));

    const commitName = (): void => {
      this.commitEditor(index, nameInput.value, cell.trigger.mode, cell.channel.color);
    };

    if (focus === 'name') {
      const nameRow = document.createElement('label');
      nameRow.className = 'ch-editor-name';
      const nameLabel = document.createElement('span');
      nameLabel.textContent = t('channels.name');
      nameRow.append(nameLabel, nameInput);
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'ch-editor-reset';
      reset.textContent = '↺';
      reset.title = t('channels.resetName', { index });
      reset.setAttribute('aria-label', reset.title);
      reset.addEventListener('click', () => {
        // Reset in place: the user still chooses Enter to commit.
        nameInput.value = defaultChannelName(index);
        nameInput.focus();
        nameInput.select();
      });
      nameInput.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') { event.preventDefault(); commitName(); }
      });
      title.textContent = t('channels.name');
      this.editor.replaceChildren(title, nameRow, reset);
      this.editor.setAttribute('role', 'dialog');
    } else {
      // A menu, not a grid: the picture's six options, each with its glyph, the current
      // one checked and tinted (None stays uncoloured), and the AND note at the foot.
      const dot = document.createElement('span');
      dot.className = 'ch-trigger-dot';
      dot.style.background = cell.channel.color;
      title.className = 'ch-trigger-menu-head';
      title.textContent = '';
      title.append(dot, document.createTextNode(t('channels.triggerOn', { name: cell.channel.name })));
      const menu = document.createElement('div');
      menu.className = 'ch-trigger-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-labelledby', title.id);
      for (const mode of TRIGGER_MODES_MENU) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'ch-trigger-item' +
          (mode === cell.trigger.mode ? ' selected' : '') +
          (mode === 'dont-care' ? ' none' : '');
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(mode === cell.trigger.mode));
        item.disabled = cell.trigger.disabled;
        const icon = document.createElement('span');
        icon.className = 'ch-trigger-item-icon';
        icon.appendChild(triggerIcon(mode, 'menu'));
        const label = document.createElement('span');
        label.className = 'ch-trigger-item-label';
        label.textContent = triggerModeName(mode);
        const check = document.createElement('span');
        check.className = 'ch-trigger-item-check';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        item.append(icon, label, check);
        item.addEventListener('click', () => {
          this.commitEditor(index, cell.channel.name, mode, cell.channel.color);
        });
        menu.appendChild(item);
      }
      const note = document.createElement('div');
      note.className = 'ch-trigger-menu-note';
      note.textContent = t('channels.triggerAllNote');
      this.editor.replaceChildren(title, menu, note);
      this.editor.setAttribute('role', 'dialog');
    }
    this.editor.setAttribute('aria-modal', 'false');
    this.editor.setAttribute('aria-labelledby', title.id);
    this.editor.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    this.positionEditor(anchor);
    if (focus === 'name') {
      nameInput.focus();
      nameInput.select();
    } else {
      (this.editor.querySelector<HTMLButtonElement>('.ch-trigger-item[aria-checked="true"]')
        ?? this.editor.querySelector<HTMLButtonElement>('.ch-trigger-item'))?.focus();
    }
  }

  private openAnalogTriggerMenu(anchor: HTMLButtonElement, cell: BusCell): void {
    this.closeEditor(false);
    this.editorAnchor = anchor;
    this.editorChannel = -1;
    this.editorBusId = cell.id;
    const title = document.createElement('div');
    title.className = 'ch-trigger-menu-head';
    title.id = 'ch-editor-title';
    const dot = document.createElement('span');
    dot.className = 'ch-trigger-dot';
    dot.style.background = cell.color;
    title.append(dot, document.createTextNode(t('channels.triggerOn', { name: cell.name })));
    const menu = document.createElement('div');
    menu.className = 'ch-trigger-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', title.id);
    // A slope choice is only a draft: clicking it must keep the popover open so the
    // level below is still editable. `selected` is the one source of truth the commit
    // path reads, so no listener captures a stale `current` value.
    let selected: 'rising' | 'falling' | null = cell.trigger?.kind ?? null;
    const items: { kind: 'rising' | 'falling' | null; button: HTMLButtonElement }[] = [];
    const levelRow = document.createElement('label');
    levelRow.className = 'ch-trigger-level';
    const levelLabel = document.createElement('span');
    levelLabel.textContent = t('channels.triggerLevel');
    const level = document.createElement('input');
    level.type = 'number';
    // The level's range and a sensible step follow the group's declared gain.
    const gain = cell.gain ?? ANALOG_GAIN_DEFAULT;
    const half = analogHalfRangeV(gain);
    level.min = String(-half);
    level.max = String(half);
    level.step = String(Number(Math.max(0.001, analogVoltsPerCode(gain)).toPrecision(1)));
    level.value = String(cell.trigger?.volts ?? 0);
    level.setAttribute('aria-label', `${t('channels.triggerLevel')} ${cell.name}`);
    const unit = document.createElement('span');
    unit.textContent = 'V';
    levelRow.append(levelLabel, level, unit);
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'bus-btn';
    apply.textContent = t('bus.confirm');
    const syncSelected = (): void => {
      level.disabled = selected === null;
      apply.disabled = selected === null;
      for (const item of items) {
        const on = item.kind === selected;
        item.button.classList.toggle('selected', on);
        item.button.setAttribute('aria-checked', String(on));
      }
    };
    const returnFocus = (): void => {
      // The App relayouts synchronously and replaces this button; return focus to the
      // rebuilt trigger so the keyboard user is not dropped on the document.
      queueMicrotask(() => {
        this.root.querySelector<HTMLButtonElement>(`.bus-trigger[data-bus-id="${cell.id}"]`)
          ?.focus({ preventScroll: true });
      });
    };
    const commitSelected = (): void => {
      if (selected === null) return;
      this.closeEditor(false);
      this.cb.onBusTrigger?.(cell.id, selected, Number(level.value) || 0);
      returnFocus();
    };
    for (const [kind, label] of [
      [null, t('trigger.none')],
      ['rising', t('trigger.rising')],
      ['falling', t('trigger.falling')],
    ] as const) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'ch-trigger-item' + (kind === selected ? ' selected' : '') +
        (kind === null ? ' none' : '');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(kind === selected));
      const icon = document.createElement('span');
      icon.className = 'ch-trigger-item-icon';
      icon.appendChild(triggerIcon(kind ?? 'dont-care', 'menu'));
      const text = document.createElement('span');
      text.className = 'ch-trigger-item-label';
      text.textContent = label;
      const check = document.createElement('span');
      check.className = 'ch-trigger-item-check';
      check.textContent = '✓';
      check.setAttribute('aria-hidden', 'true');
      item.append(icon, text, check);
      item.addEventListener('click', () => {
        if (kind === null) {
          // Removing has no level to edit, so it commits and closes immediately.
          this.closeEditor(false);
          this.cb.onBusTrigger?.(cell.id, null, Number(level.value) || 0);
          returnFocus();
          return;
        }
        selected = kind;
        syncSelected();
        level.focus();
        level.select();
      });
      items.push({ kind, button: item });
      menu.appendChild(item);
    }
    apply.addEventListener('click', () => {
      commitSelected();
    });
    level.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitSelected();
      }
    });
    syncSelected();
    const note = document.createElement('div');
    note.className = 'ch-trigger-menu-note';
    note.textContent = t('capturePanel.analogSingleNote');
    this.editor.replaceChildren(title, menu, levelRow, apply, note);
    this.editor.setAttribute('role', 'dialog');
    this.editor.setAttribute('aria-modal', 'false');
    this.editor.setAttribute('aria-labelledby', title.id);
    this.editor.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    this.positionEditor(anchor);
    (menu.querySelector<HTMLButtonElement>('.ch-trigger-item[aria-checked="true"]')
      ?? menu.querySelector<HTMLButtonElement>('.ch-trigger-item'))?.focus();
  }

  private commitEditor(index: number, name: string, mode: TriggerMode, color: string): void {
    this.closeEditor(false);
    this.cb.onConfigure(index, { name, mode, color });
    // The app rebuilds the rows synchronously; return focus to the same row's trigger.
    queueMicrotask(() => {
      this.root.querySelector<HTMLButtonElement>(`.ch-trigger[data-channel="${index}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  /**
   * Put the bus cells above the channel cells, matching the analog rows at the top of
   * the plot. Call after render(). They are not channels: not draggable, no `pos`, so
   * drag reordering still numbers the channel cells alone.
   */
  renderBuses(cells: readonly BusCell[]): void {
    for (const cell of [...cells].reverse()) {
      const el = document.createElement('div');
      el.className = 'ch-cell bus-cell';
      el.style.height = `${cell.heightCss}px`;
      const card = document.createElement('div');
      card.className = 'ch-card';
      const strip = document.createElement('div');
      strip.className = 'ch-strip';
      strip.style.background = cell.color;
      const body = document.createElement('div');
      body.className = 'ch-body';
      const head = document.createElement('div');
      head.className = 'ch-head';
      const label = document.createElement('span');
      label.className = 'ch-tag ch-tag--name';
      label.textContent = cell.name;
      head.appendChild(label);
      let triggerButton: HTMLButtonElement | null = null;
      if (cell.analog) {
        triggerButton = document.createElement('button');
        triggerButton.type = 'button';
        triggerButton.className = 'bus-trigger' +
          (cell.trigger ? (cell.triggerActive === true ? ' armed' : ' configured') : '');
        triggerButton.dataset.busId = cell.id;
        const mode = cell.trigger
          ? (cell.trigger.kind === 'rising' ? t('trigger.rising') : t('trigger.falling'))
          : t('trigger.none');
        triggerButton.title = t('channels.triggerTip', { name: cell.name, mode });
        triggerButton.setAttribute('aria-label', triggerButton.title);
        triggerButton.setAttribute('aria-haspopup', 'dialog');
        triggerButton.setAttribute('aria-expanded', 'false');
        triggerButton.appendChild(triggerIcon(cell.trigger?.kind ?? 'dont-care'));
        triggerButton.addEventListener('click', (event) => {
          event.stopPropagation();
          this.openAnalogTriggerMenu(triggerButton!, cell);
        });
        head.appendChild(triggerButton);
      }
      if (!cell.analog) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'bus-cell-edit';
        edit.title = t('bus.editButton');
        edit.setAttribute('aria-label', `${t('bus.editButton')} ${cell.name}`);
        edit.appendChild(settingsIcon());
        edit.addEventListener('click', () => this.cb.onEditBus?.(cell.id));
        head.appendChild(edit);
      }
      const sub = document.createElement('div');
      sub.className = 'bus-cell-sub';
      // An analog row names its declared gain and the range it gives ("×3 · ±5 V").
      const gain = cell.gain ?? ANALOG_GAIN_DEFAULT;
      sub.textContent = cell.analog === true
        ? t('channels.analogGainSub', {
          gain: formatAnalogGain(gain), range: String(Number(analogHalfRangeV(gain).toPrecision(3))),
        })
        : cell.summary;
      if (cell.analog === true) sub.dataset.analogGain = String(gain);
      body.append(head, sub);
      if (cell.analog) {
        // Scale, zero and trigger readouts live on the plot's right ruler. The left
        // column keeps only the trigger editor and the row-height handle, which snaps to
        // the `ANALOG_HEIGHTS` stops (80..480 px; the graticule follows the height).
        const heightHandle = document.createElement('div');
        heightHandle.className = 'bus-height-handle';
        heightHandle.title = t('bus.height');
        heightHandle.setAttribute('role', 'slider');
        heightHandle.setAttribute('aria-orientation', 'vertical');
        heightHandle.setAttribute('aria-label', `${t('bus.height')} ${cell.name}`);
        heightHandle.setAttribute('aria-valuemin', String(ANALOG_HEIGHTS[0]));
        heightHandle.setAttribute('aria-valuemax',
          String(ANALOG_HEIGHTS[ANALOG_HEIGHTS.length - 1]));
        heightHandle.setAttribute('aria-valuenow', String(cell.heightCss));
        heightHandle.setAttribute('aria-valuetext', `${cell.heightCss} px`);
        heightHandle.tabIndex = 0;
        const setHeight = (height: number, commit: boolean): void => {
          heightHandle.setAttribute('aria-valuenow', String(height));
          heightHandle.setAttribute('aria-valuetext', `${height} px`);
          this.cb.onBusScope?.(cell.id, { heightCss: height }, commit);
        };
        heightHandle.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          // Keyboard follows slider convention: Up increases the value, Down decreases
          // it. Pointer dragging still follows the physical bottom edge.
          const direction = event.key === 'ArrowUp' ? 1 : -1;
          const next = stepAnalogHeight(cell.heightCss, direction);
          if (next !== cell.heightCss) setHeight(next, true);
        });
        heightHandle.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          heightHandle.focus({ preventScroll: true });
          const startY = event.clientY;
          const startHeight = cell.heightCss;
          let last: number = ANALOG_HEIGHTS[analogHeightIndex(startHeight)]!;
          const snap = (clientY: number): number => {
            // The drag delta selects the nearest of the documented stops.
            const target = startHeight + (clientY - startY);
            return ANALOG_HEIGHTS[analogHeightIndex(target)]!;
          };
          const move = (ev: PointerEvent): void => {
            const next = snap(ev.clientY);
            if (next === last) return;
            last = next;
            setHeight(next, false);
          };
          const cleanup = (): void => {
            document.removeEventListener('pointermove', move);
            document.removeEventListener('pointerup', up);
            document.removeEventListener('pointercancel', cancel);
          };
          const up = (): void => {
            cleanup();
            if (last !== startHeight) setHeight(last, true);
          };
          const cancel = (): void => {
            cleanup();
            // A cancelled gesture must not leave the preview applied or persisted.
            if (last !== startHeight) setHeight(startHeight, false);
          };
          document.addEventListener('pointermove', move);
          document.addEventListener('pointerup', up);
          document.addEventListener('pointercancel', cancel);
        });
        card.appendChild(heightHandle);
      }
      card.append(strip, body);
      el.appendChild(card);
      this.root.prepend(el);
    }
    if (this.editorBusId !== null && !this.editor.hidden) {
      // Trigger-state updates rebuild the rows during a capture. Preserve the analog
      // draft and focus, but move its anchor to the replacement button.
      const anchor = this.root.querySelector<HTMLButtonElement>(
        `.bus-trigger[data-bus-id="${this.editorBusId}"]`,
      );
      if (!anchor) this.closeEditor(false);
      else {
        this.editorAnchor?.setAttribute('aria-expanded', 'false');
        this.editorAnchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        this.positionEditor(anchor);
      }
    }
  }

  render(cells: readonly ChannelCell[]): void {
    const keepDigitalDraft = !this.editor.hidden && this.editorChannel >= 0 &&
      cells.some((cell) => cell.channel.index === this.editorChannel) &&
      this.editor.contains(document.activeElement);
    const keepAnalogDraft = !this.editor.hidden && this.editorBusId !== null &&
      this.editor.contains(document.activeElement);
    if (!keepDigitalDraft && !keepAnalogDraft) this.closeEditor();
    this.root.replaceChildren();
    cells.forEach((cell, pos) => {
      const el = document.createElement('div');
      el.className = 'ch-cell';
      el.style.height = `${cell.heightCss}px`;
      el.draggable = true;
      el.dataset['pos'] = String(pos);
      if (!cell.channel.enabled) el.classList.add('disabled');
      /* Per-instance lane offset, set inline (house rule). A custom property, not
         inline padding: a property is inert until a rule reads it, so the default
         theme - where .ch-card is display:contents - stays pixel-identical. */
      if (cell.laneCss > 0) el.style.setProperty('--ch-lane-offset', `${cell.laneCss}px`);
      const lanes = cell.lanes ?? [];
      if (lanes.length > 0 && cell.laneCss > 0) {
        // The lane strip above the card names each plot lane's annotation row.
        const strip = document.createElement('div');
        strip.className = 'ch-lane-labels';
        strip.style.height = `${cell.laneCss}px`;
        for (const lane of lanes) {
          const label = document.createElement('div');
          label.className = 'ch-lane-label';
          label.style.height = `${cell.laneCss / lanes.length}px`;
          label.style.color = lane.color;
          label.textContent = lane.text;
          label.title = lane.title;
          strip.appendChild(label);
        }
        el.appendChild(strip);
      }

      /* The card wrapper groups strip+body so a theme can render the cell as one
         rounded card; the chips container lets a theme reserve the decoder strip.
         Both are `display: contents` in the sheet's base layer, so until a theme
         opts in they are layout-invisible and change nothing. */
      const card = document.createElement('div');
      card.className = 'ch-card';
      el.appendChild(card);

      const strip = document.createElement('div');
      strip.className = 'ch-strip';
      strip.style.background = cell.channel.color;
      card.appendChild(strip);

      const body = document.createElement('div');
      body.className = 'ch-body';

      const head = document.createElement('div');
      head.className = 'ch-head';

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'ch-trigger' + (cell.trigger.mode === 'dont-care' ? ''
        : cell.trigger.armed ? ' armed' : ' configured');
      trigger.dataset['channel'] = String(cell.channel.index);
      trigger.title = t('channels.triggerTip', {
        name: cell.channel.name, mode: triggerModeName(cell.trigger.mode),
      });
      trigger.setAttribute('aria-label', trigger.title);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.appendChild(triggerIcon(cell.trigger.mode));
      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        this.openEditor(trigger, cell, 'trigger');
      });
      trigger.addEventListener('mousedown', () => { el.draggable = false; });
      trigger.addEventListener('mouseup', () => { el.draggable = true; });

      const tag = document.createElement('span');
      tag.className = 'ch-tag ch-tag--name ch-tag--editable';
      tag.textContent = cell.channel.name;
      tag.title = t('channels.renameHint');
      tag.tabIndex = 0;
      tag.setAttribute('role', 'button');
      tag.setAttribute('aria-haspopup', 'dialog');
      tag.setAttribute('aria-expanded', 'false');
      tag.setAttribute('aria-label',
        `${cell.channel.name}: ${t('channels.renameHint')}`);
      tag.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        this.openEditor(trigger, cell, 'name');
      });
      tag.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== 'F2' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        this.openEditor(trigger, cell, 'name');
      });
      const original = document.createElement('span');
      original.className = 'ch-original-id';
      original.textContent = `D${cell.channel.index}`;
      original.hidden = cell.channel.name === defaultChannelName(cell.channel.index);
      head.append(tag, original, trigger);
      body.appendChild(head);

      const chips = document.createElement('div');
      chips.className = 'ch-analyzers';

      for (const a of cell.analyzers) {
        const chip = document.createElement('div');
        chip.className = 'ch-analyzer';
        const sq = document.createElement('span');
        sq.className = 'ch-analyzer-sq';
        sq.style.background = a.color;
        chip.appendChild(sq);
        const txt = document.createElement('span');
        txt.textContent = a.label;
        txt.classList.toggle('error', a.status === 'error');
        chip.appendChild(txt);
        const x = document.createElement('button');
        x.className = 'ch-analyzer-x';
        x.textContent = '×';
        x.title = t('channels.removeAnalyzer', { label: a.label });
        x.addEventListener('click', () => this.cb.onRemoveAnalyzer(a.id));
        chip.appendChild(x);
        chip.title = formatAnalyzerNote(a.note) || a.label;
        chips.appendChild(chip);
      }
      body.appendChild(chips);

      card.appendChild(body);

      el.addEventListener('dragstart', (e) => {
        this.dragFrom = pos;
        e.dataTransfer?.setData('text/plain', String(pos));
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        el.classList.add('drop-target');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drop-target');
        if (this.dragFrom >= 0 && this.dragFrom !== pos) this.cb.onReorder(this.dragFrom, pos);
        this.dragFrom = -1;
      });

      this.root.appendChild(el);
    });
    if (keepDigitalDraft) {
      const anchor = this.root.querySelector<HTMLButtonElement>(
        `.ch-trigger[data-channel="${this.editorChannel}"]`);
      if (anchor) {
        this.editorAnchor = anchor;
        anchor.setAttribute('aria-expanded', 'true');
        this.positionEditor(anchor);
      } else {
        this.closeEditor();
      }
    }
  }

  /** Close before the toolbar opens its separate transient overlay. */
  closeDialog(): void {
    this.closeEditor();
  }
}

function triggerModeName(mode: TriggerMode): string {
  return mode === 'falling' ? t('trigger.falling')
    : mode === 'rising' ? t('trigger.rising')
      : mode === 'edge' ? t('trigger.anyEdge')
        : mode === 'high' ? t('channels.triggerHigh')
          : mode === 'low' ? t('channels.triggerLow') : t('trigger.none');
}

/**
 * The trigger glyph. In a row's trigger slot an unset trigger is a faint dashed rising
 * edge - recognisably "the trigger control" - rather than a bare dash, which read as
 * collapse/delete (UX review L3). Inside the mode menu the "none" item keeps the flat
 * dash, where its label explains it.
 */
function triggerIcon(mode: TriggerMode, place: 'slot' | 'menu' = 'slot'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const unsetSlot = mode === 'dont-care' && place === 'slot';
  const d = mode === 'falling' ? 'M1 4H8V12H23'
    : mode === 'rising' ? 'M1 12H8V4H23'
      : mode === 'edge' ? 'M1 4H6L18 12H23M1 12H6L18 4H23'
        : mode === 'high' ? 'M1 4H23'
          : mode === 'low' ? 'M1 12H23'
            : unsetSlot ? 'M2 12H9V4H22'
              : 'M6 8H18';
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (unsetSlot) {
    path.setAttribute('stroke-dasharray', '2 3');
    svg.dataset['triggerIcon'] = 'unset';
  }
  svg.appendChild(path);
  return svg;
}


/** Lucide's Settings geometry, realized with the existing no-icon-library SVG idiom. */
function settingsIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset['icon'] = 'inline-start';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '3');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke', 'currentColor');
  circle.setAttribute('stroke-width', '2');
  svg.append(path, circle);
  return svg;
}
