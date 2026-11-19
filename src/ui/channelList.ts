// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
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
 * Names are read-only in the row. One gear button opens a native modal whose shadcn-style
 * header / field group / footer owns name, trigger and color editing, so the card no
 * longer carries three independent editing controls. The trigger glyph stays as a
 * read-only armed/configured preview; an analog bus row's gear opens its own dialog.
 */

import {
  AnalogRowSettingsDialog, type AnalogRowConfiguration, type AnalogRowView,
} from './analogRowDialog.js';
import { ANALOG_HEIGHTS, analogHeightIndex, stepAnalogHeight } from './busView.js';
import { button, div } from './capturePanel.js';
import { ANALOG_GAIN_DEFAULT, analogHalfRangeV } from './channelBanks.js';
import { formatAnalyzerNote } from './format.js';
import { t } from './i18n.js';
import { CHANNEL_COLOR_PRESETS } from './metrics.js';
import { isCompactRow } from './channelLayout.js';
import { HsvPicker } from './colorPicker.js';
import { channelColor, defaultChannelName, DEFAULT_TRIGGER_MODE,
  type AnalyzerState, type ChannelState, type TriggerMode } from './state.js';
import { triggerIcon } from './triggerGlyph.js';

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
  /** Open the editor for a parallel-bus view (its cell's gear). */
  onEditBus?(id: string): void;
  /** Analog scope controls: preview while dragging (`commit` false), then persist. */
  onBusScope?(id: string, patch: BusScopePatch, commit: boolean): void;
  /** Commit the analog row dialog: name, trigger and shared layout in one action. */
  onBusConfigure?(id: string, config: AnalogRowConfiguration): void;
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
  showHeight?: boolean;
  /** An ADC group's declared hardware gain (1 when absent); its range is ±16 V / gain. */
  gain?: number;
  /** The analog trigger configured on this group, if any. */
  trigger?: { kind: 'rising' | 'falling'; volts: number };
  overlay?: boolean;
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

const TRIGGER_MODES: readonly TriggerMode[] = ['dont-care', 'rising', 'falling', 'edge', 'high', 'low'];

interface TriggerOption {
  label: HTMLLabelElement;
  input: HTMLInputElement;
}

class ChannelSettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly nameLabel: HTMLLabelElement;
  private readonly nameInput: HTMLInputElement;
  private readonly resetNameButton: HTMLButtonElement;
  private readonly triggerLabel: HTMLSpanElement;
  private readonly triggerFieldset: HTMLFieldSetElement;
  private readonly triggerOptions = new Map<TriggerMode, TriggerOption>();
  private readonly colorLabel: HTMLSpanElement;
  private readonly colorPalette: HTMLDivElement;
  private readonly customColorButton: HTMLButtonElement;
  private readonly colorResetButton: HTMLButtonElement;
  private readonly colorPicker: HsvPicker;
  private readonly presetColorButtons = new Map<string, HTMLButtonElement>();
  private readonly cancelButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private selectedColor = '#000000';
  private channel = -1;
  private opener: HTMLButtonElement | null = null;

  constructor(
    private readonly onConfigure: ChannelListCallbacks['onConfigure'],
    private readonly onDismiss: (
      channel: number, opener: HTMLButtonElement | null,
    ) => void,
  ) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'channel-settings-dialog';
    this.dialog.setAttribute('aria-labelledby', 'channel-settings-title');

    const form = document.createElement('form');
    form.className = 'channel-settings-form';

    const header = div('channel-settings-header');
    this.title = document.createElement('h2');
    this.title.id = 'channel-settings-title';
    header.appendChild(this.title);

    const fields = div('channel-settings-fields');

    const nameField = div('channel-settings-field channel-settings-kv');
    this.nameLabel = document.createElement('label');
    this.nameLabel.className = 'channel-settings-copy';
    this.nameLabel.htmlFor = 'channel-settings-name';
    this.nameInput = document.createElement('input');
    this.nameInput.id = 'channel-settings-name';
    this.nameInput.className = 'channel-settings-name';
    this.nameInput.type = 'text';
    this.nameInput.spellcheck = false;
    this.nameInput.autocomplete = 'off';
    const nameControl = div('channel-settings-name-control');
    this.resetNameButton = button('', 'channel-name-reset');
    this.resetNameButton.type = 'button';
    this.resetNameButton.appendChild(resetNameIcon());
    this.resetNameButton.addEventListener('click', () => {
      if (this.channel < 0) return;
      this.nameInput.value = defaultChannelName(this.channel);
      this.nameInput.focus();
      this.nameInput.select();
    });
    nameControl.append(this.nameInput, this.resetNameButton);
    nameField.append(this.nameLabel, nameControl);

    const triggerField = div('channel-settings-field channel-settings-kv');
    this.triggerLabel = document.createElement('span');
    this.triggerLabel.className = 'channel-settings-copy';
    this.triggerLabel.id = 'channel-settings-trigger-label';
    this.triggerFieldset = document.createElement('fieldset');
    this.triggerFieldset.className = 'channel-trigger-options';
    this.triggerFieldset.setAttribute('aria-labelledby', this.triggerLabel.id);
    for (const mode of TRIGGER_MODES) {
      const label = document.createElement('label');
      label.className = 'channel-trigger-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'channel-trigger-mode';
      input.value = mode;
      label.append(input, triggerIcon(mode, 'menu'));
      this.triggerFieldset.appendChild(label);
      this.triggerOptions.set(mode, { label, input });
    }
    triggerField.append(this.triggerLabel, this.triggerFieldset);

    const colorField = div('channel-settings-field channel-settings-kv');
    this.colorLabel = document.createElement('span');
    this.colorLabel.className = 'channel-settings-copy';
    this.colorLabel.id = 'channel-settings-color-label';
    const colorGrid = div('channel-color-grid');
    colorGrid.setAttribute('role', 'group');
    colorGrid.setAttribute('aria-labelledby', this.colorLabel.id);
    for (const color of CHANNEL_COLOR_PRESETS) {
      const preset = button('', 'channel-color-swatch channel-color-preset');
      preset.type = 'button';
      preset.title = color;
      preset.setAttribute('aria-label', color);
      preset.setAttribute('aria-pressed', 'false');
      preset.style.background = color;
      preset.addEventListener('click', () => {
        this.selectedColor = color;
        this.syncColorSelection();
        this.hideColorPalette();
      });
      colorGrid.appendChild(preset);
      this.presetColorButtons.set(color, preset);
    }

    this.customColorButton = button('', 'channel-color-swatch channel-color-custom');
    this.customColorButton.type = 'button';
    this.customColorButton.setAttribute('aria-pressed', 'false');
    const customMark = document.createElement('span');
    customMark.className = 'channel-color-custom-mark';
    customMark.setAttribute('aria-hidden', 'true');
    customMark.textContent = '+';
    this.customColorButton.appendChild(customMark);
    colorGrid.appendChild(this.customColorButton);

    this.colorPalette = div('channel-color-palette');
    this.colorPalette.id = 'channel-color-palette';
    this.colorPalette.setAttribute('popover', 'auto');
    this.colorPalette.setAttribute('role', 'group');
    this.customColorButton.setAttribute('popovertarget', this.colorPalette.id);
    this.colorPicker = new HsvPicker((hex) => {
      this.selectedColor = hex;
      this.syncColorSelection();
    });
    this.colorPalette.addEventListener('toggle', () => {
      if (this.colorPalette.matches(':popover-open')) {
        this.colorPicker.setColor(this.selectedColor);
        this.colorPicker.focus();
      } else {
        this.colorPicker.endDrag();
      }
    });
    this.colorPalette.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (next instanceof Node && this.colorPalette.contains(next)) return;
      this.hideColorPalette();
    });
    this.colorResetButton = button('', 'channel-name-reset');
    this.colorResetButton.type = 'button';
    this.colorResetButton.appendChild(resetNameIcon());
    this.colorResetButton.addEventListener('click', () => {
      if (this.channel < 0) return;
      this.selectedColor = channelColor(this.channel);
      this.colorPicker.setColor(this.selectedColor);
      this.syncColorSelection();
    });
    this.colorPalette.append(this.colorPicker.element, this.colorResetButton);
    colorField.append(this.colorLabel, colorGrid, this.colorPalette);

    fields.append(nameField, triggerField, colorField);

    const footer = div('channel-settings-actions');
    this.cancelButton = button('', 'channel-settings-cancel');
    this.cancelButton.type = 'button';
    this.saveButton = button('', 'primary');
    this.saveButton.type = 'submit';
    footer.append(this.cancelButton, this.saveButton);

    form.append(header, fields, footer);
    this.dialog.appendChild(form);
    document.body.appendChild(this.dialog);

    form.addEventListener('submit', this.onSubmit);
    this.cancelButton.addEventListener('click', () => this.dismiss(true));
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.dismiss(true);
    });
    this.dialog.addEventListener('pointerdown', (event) => {
      if (event.target === this.dialog) {
        event.preventDefault();
        this.dismiss(true);
      }
    });
  }

  open(opener: HTMLButtonElement, cell: ChannelCell): void {
    if (this.dialog.open) this.close();
    this.channel = cell.channel.index;
    this.opener = opener;
    this.renderStrings(cell.channel.index);
    this.nameInput.value = cell.channel.name;
    this.selectedColor = cell.channel.color;
    this.colorPicker.setColor(cell.channel.color);
    this.syncColorSelection();
    this.triggerFieldset.disabled = cell.trigger.disabled;
    for (const [mode, option] of this.triggerOptions) {
      option.input.checked = mode === cell.trigger.mode;
    }
    this.dialog.showModal();
    this.nameInput.focus();
    this.nameInput.select();
  }

  close(): void {
    this.dismiss(false);
  }

  closeUnless(present: readonly number[]): void {
    if (this.channel < 0 || present.includes(this.channel)) return;
    this.dismiss(false);
  }

  private renderStrings(channel: number): void {
    this.title.textContent = t('channels.settings', { index: channel });
    this.nameLabel.textContent = t('channels.name');
    const resetNameTitle = t('channels.resetName', { index: channel });
    this.resetNameButton.title = resetNameTitle;
    this.resetNameButton.setAttribute('aria-label', resetNameTitle);
    this.triggerLabel.textContent = t('channels.triggerMode');
    this.colorLabel.textContent = t('channels.color');
    this.colorPalette.setAttribute('aria-label', t('channels.customColor'));
    this.colorPicker.renderStrings();
    this.customColorButton.title = t('channels.customColor');
    this.customColorButton.setAttribute('aria-label', t('channels.customColor'));
    const resetColorTitle = t('channels.resetColor', { index: channel });
    this.colorResetButton.title = resetColorTitle;
    this.colorResetButton.setAttribute('aria-label', resetColorTitle);
    this.cancelButton.textContent = t('channels.cancel');
    this.saveButton.textContent = t('toolbar.save');
    for (const [mode, option] of this.triggerOptions) {
      const name = triggerModeName(mode);
      option.label.title = name;
      option.input.setAttribute('aria-label', name);
    }
  }

  private syncColorSelection(): void {
    const selected = this.selectedColor.toLowerCase();
    let presetSelected = false;
    for (const [color, preset] of this.presetColorButtons) {
      const active = color.toLowerCase() === selected;
      presetSelected ||= active;
      preset.classList.toggle('selected', active);
      preset.setAttribute('aria-pressed', String(active));
    }
    this.customColorButton.classList.toggle('selected', !presetSelected);
    this.customColorButton.setAttribute('aria-pressed', String(!presetSelected));
  }

  private hideColorPalette(): void {
    if (this.colorPalette.matches(':popover-open')) this.colorPalette.hidePopover();
  }

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.channel < 0) return;
    const channel = this.channel;
    const opener = this.opener;
    const mode = TRIGGER_MODES.find((candidate) =>
      this.triggerOptions.get(candidate)?.input.checked) ?? DEFAULT_TRIGGER_MODE;
    const config: ChannelConfiguration = {
      name: this.nameInput.value.trim(), mode, color: this.selectedColor,
    };

    this.hideColorPalette();
    this.channel = -1;
    this.opener = null;
    this.nameInput.value = '';
    if (this.dialog.open) this.dialog.close();
    this.onConfigure(channel, config);
    this.onDismiss(channel, opener);
  };

  private dismiss(restoreFocus: boolean): void {
    const channel = this.channel;
    const opener = this.opener;
    this.hideColorPalette();
    this.channel = -1;
    this.opener = null;
    this.nameInput.value = '';
    if (this.dialog.open) this.dialog.close();
    if (restoreFocus) this.onDismiss(channel, opener);
  }
}

export class ChannelList {
  private dragFrom = -1;
  private readonly settingsDialog: ChannelSettingsDialog;
  private readonly analogDialog: AnalogRowSettingsDialog;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ChannelListCallbacks,
  ) {
    this.settingsDialog = new ChannelSettingsDialog(this.cb.onConfigure,
      (channel, opener) => {
        const target = opener?.isConnected === true ? opener
          : this.root.querySelector<HTMLButtonElement>(
            `.ch-settings[data-channel="${channel}"]`);
        target?.focus({ preventScroll: true });
      });
    this.analogDialog = new AnalogRowSettingsDialog({
      configure: (id, config) => this.cb.onBusConfigure?.(id, config),
      dismiss: (id, opener) => {
        const target = opener?.isConnected === true ? opener
          : this.root.querySelector<HTMLButtonElement>(`.bus-cell-edit[data-bus-id="${id}"]`);
        target?.focus({ preventScroll: true });
      },
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
      if (cell.analog) {
        const preview = document.createElement('span');
        preview.className = 'bus-trigger-preview' +
          (cell.trigger ? (cell.triggerActive === true ? ' armed' : ' configured') : '');
        const tip = t('channels.triggerPreview', {
          mode: triggerModeName(cell.trigger?.kind ?? 'dont-care'),
        });
        preview.title = tip;
        preview.setAttribute('role', 'img');
        preview.setAttribute('aria-label', tip);
        preview.appendChild(triggerIcon(cell.trigger?.kind ?? 'dont-care'));
        head.appendChild(preview);
        const gear = document.createElement('button');
        gear.type = 'button';
        gear.className = 'bus-cell-edit';
        gear.dataset.busId = cell.id;
        gear.title = t('analogRow.settings', { name: cell.name });
        gear.setAttribute('aria-label', gear.title);
        gear.setAttribute('aria-haspopup', 'dialog');
        gear.appendChild(settingsIcon());
        gear.addEventListener('click', (event) => {
          event.stopPropagation();
          this.analogDialog.open(gear, analogRowView(cell));
        });
        head.appendChild(gear);
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
      // An analog row names its range directly ("±16 V"); the gain ratio lives in the
      // capture panel's help tip.
      const gain = cell.gain ?? ANALOG_GAIN_DEFAULT;
      sub.textContent = cell.analog === true
        ? t('channels.analogGainSub', {
          range: String(Number(analogHalfRangeV(gain).toPrecision(3))),
        })
        : cell.summary;
      if (cell.analog === true) sub.dataset.analogGain = String(gain);
      const main = div('ch-main');
      main.append(head, sub);
      body.appendChild(main);
      if (cell.analog && cell.showHeight !== false) {
        // Scale, zero and trigger readouts live on the plot's right ruler. The left
        // column keeps only the row settings gear and the row-height handle, which snaps
        // to the `ANALOG_HEIGHTS` stops (80..480 px; the graticule follows the height).
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
    this.analogDialog.closeUnless(cells.map((cell) => cell.id));
  }

  render(cells: readonly ChannelCell[]): void {
    this.settingsDialog.closeUnless(cells.map((cell) => cell.channel.index));
    this.root.replaceChildren();
    cells.forEach((cell, pos) => {
      const el = document.createElement('div');
      el.className = 'ch-cell';
      el.style.height = `${cell.heightCss}px`;
      el.draggable = true;
      el.dataset['pos'] = String(pos);
      if (!cell.channel.enabled) el.classList.add('disabled');
      // "Compact rows": a band below the full card's floor shows the head line only.
      if (isCompactRow(cell.heightCss - cell.laneCss)) el.classList.add('compact');
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

      let preview: HTMLSpanElement | null = null;
      if (cell.trigger.mode !== 'dont-care') {
        preview = document.createElement('span');
        preview.className = 'ch-trigger-preview' +
          (cell.trigger.armed ? ' armed' : ' configured');
        const label = t('channels.triggerPreview', { mode: triggerModeName(cell.trigger.mode) });
        preview.title = label;
        preview.setAttribute('role', 'img');
        preview.setAttribute('aria-label', label);
        preview.appendChild(triggerIcon(cell.trigger.mode));
      }

      const tag = document.createElement('span');
      tag.className = 'ch-tag ch-tag--name';
      tag.textContent = cell.channel.name;
      const original = document.createElement('span');
      original.className = 'ch-original-id';
      original.textContent = `D${cell.channel.index}`;
      original.hidden = cell.channel.name === defaultChannelName(cell.channel.index);

      const settings = document.createElement('button');
      settings.type = 'button';
      settings.className = 'ch-settings';
      settings.dataset['channel'] = String(cell.channel.index);
      settings.title = t('channels.settings', { index: cell.channel.index });
      settings.setAttribute('aria-label', settings.title);
      settings.setAttribute('aria-haspopup', 'dialog');
      settings.appendChild(settingsIcon());
      settings.addEventListener('click', (event) => {
        event.stopPropagation();
        this.settingsDialog.open(settings, cell);
      });
      settings.addEventListener('mousedown', () => { el.draggable = false; });
      settings.addEventListener('mouseup', () => { el.draggable = true; });
      head.append(tag, original);
      const main = div('ch-main');
      main.appendChild(head);

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
        chip.title = formatAnalyzerNote(a.note) || a.label;
        chips.appendChild(chip);
      }
      main.appendChild(chips);

      const actions = div('ch-actions');
      actions.appendChild(settings);
      if (preview !== null) actions.appendChild(preview);
      body.append(main, actions);

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
  }

  /** Close before the toolbar opens its separate transient overlay. */
  closeDialog(): void {
    this.settingsDialog.close();
    this.analogDialog.close();
  }

  private idleNote: HTMLButtonElement | null = null;

  /**
   * "Hide idle channels" (DESIGN §5.4): one note row after the channel cells saying how
   * many rows the filter removed; clicking it shows them again (`onShow`). It sits after
   * the last row, so no channel label moves relative to its trace, and is sticky to the
   * bottom of the scroll view so a long stack still shows it. `count` 0 removes it.
   */
  renderIdleNote(count: number, onShow: () => void): void {
    if (count <= 0) {
      this.idleNote?.remove();
      this.idleNote = null;
      return;
    }
    if (this.idleNote === null) {
      this.idleNote = document.createElement('button');
      this.idleNote.type = 'button';
      this.idleNote.className = 'ch-idle-note';
      this.idleNote.setAttribute('translate', 'yes');
    }
    const note = this.idleNote;
    note.onclick = () => onShow();
    note.textContent = t('channels.idleHidden', { count });
    note.title = t('channels.idleHiddenTip');
    note.setAttribute('aria-label', `${note.textContent}. ${note.title}`);
    if (note.previousElementSibling !== this.root) this.root.after(note);
  }
}

function triggerModeName(mode: TriggerMode): string {
  return mode === 'falling' ? t('trigger.falling')
    : mode === 'rising' ? t('trigger.rising')
      : mode === 'edge' ? t('trigger.anyEdge')
        : mode === 'high' ? t('channels.triggerHigh')
          : mode === 'low' ? t('channels.triggerLow') : t('trigger.none');
}

function analogRowView(cell: BusCell): AnalogRowView {
  return {
    id: cell.id,
    name: cell.name,
    kind: cell.trigger?.kind ?? null,
    volts: cell.trigger?.volts ?? 0,
    gain: cell.gain ?? ANALOG_GAIN_DEFAULT,
    overlay: cell.overlay === true,
  };
}

function resetNameIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arc.setAttribute('d', 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M3 3v5h5');
  for (const path of [arc, arrow]) {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
  }
  svg.append(arc, arrow);
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
