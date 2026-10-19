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
 * Names are read-only in the row. One gear button opens a native modal whose shadcn-style
 * header / field group / footer owns name, trigger and color editing, so the card no
 * longer carries three independent editing controls.
 */

import { button, div } from './capturePanel.js';
import { formatAnalyzerNote } from './format.js';
import { t } from './i18n.js';
import { CHANNEL_COLOR_PRESETS, COLORS } from './metrics.js';
import { DEFAULT_TRIGGER_MODE, defaultChannelName,
  type AnalyzerState, type ChannelState, type TriggerMode } from './state.js';

export interface ChannelConfiguration {
  name: string;
  mode: TriggerMode;
  color: string;
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
  analyzers: AnalyzerState[];
  trigger: {
    mode: TriggerMode;
    /** Capture state locks trigger edits, not unrelated channel metadata. */
    disabled: boolean;
  };
}

export interface ChannelListCallbacks {
  /** Commit one dialog draft; App owns every resulting session mutation. */
  onConfigure(index: number, config: ChannelConfiguration): void;
  /** Move the channel at `from` in display order to `to`. */
  onReorder(from: number, to: number): void;
  onRemoveAnalyzer(id: string): void;
}

const TRIGGER_MODES: readonly TriggerMode[] = ['falling', 'rising', 'edge', 'high', 'low', 'dont-care'];

interface TriggerOption {
  label: HTMLLabelElement;
  input: HTMLInputElement;
}

/**
 * One persistent native dialog per ChannelList. Unlike the retired inline picker, this
 * adds no document/window listeners: showModal owns focus and inertness, while the
 * dialog's own cancel event covers Escape. All non-submit paths discard their draft.
 */
class ChannelSettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly nameLabel: HTMLLabelElement;
  private readonly nameInput: HTMLInputElement;
  private readonly resetNameButton: HTMLButtonElement;
  private readonly colorLabel: HTMLSpanElement;
  private readonly colorInput: HTMLInputElement;
  private readonly paletteLabel: HTMLLabelElement;
  private readonly colorPalette: HTMLDivElement;
  private readonly customColorButton: HTMLButtonElement;
  private readonly presetColorButtons = new Map<string, HTMLButtonElement>();
  private selectedColor = '#000000';
  private readonly triggerLabel: HTMLSpanElement;
  private readonly triggerFieldset: HTMLFieldSetElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly triggerOptions = new Map<TriggerMode, TriggerOption>();
  private channel = -1;
  private anchor: HTMLButtonElement | null = null;

  constructor(
    private readonly onConfigure: ChannelListCallbacks['onConfigure'],
    private readonly onSaved: (channel: number) => void,
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
      label.append(input, triggerIcon(mode));
      this.triggerFieldset.appendChild(label);
      this.triggerOptions.set(mode, { label, input });
    }
    triggerField.append(this.triggerLabel, this.triggerFieldset);

    const colorField = div('channel-settings-field channel-settings-color-field');
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

    this.colorPalette = document.createElement('div');
    this.colorPalette.className = 'channel-color-palette';
    this.colorPalette.id = 'channel-color-palette';
    this.colorPalette.setAttribute('popover', 'auto');
    this.colorPalette.setAttribute('role', 'group');
    this.customColorButton.setAttribute('popovertarget', this.colorPalette.id);
    this.paletteLabel = document.createElement('label');
    this.paletteLabel.className = 'channel-color-palette-label';
    this.paletteLabel.id = 'channel-custom-color-label';
    this.paletteLabel.htmlFor = 'channel-settings-color';
    this.colorPalette.setAttribute('aria-labelledby', this.paletteLabel.id);
    this.colorInput = document.createElement('input');
    this.colorInput.id = 'channel-settings-color';
    this.colorInput.className = 'channel-settings-color';
    this.colorInput.type = 'color';
    this.colorInput.addEventListener('input', () => {
      this.selectedColor = this.colorInput.value;
      this.syncColorSelection();
    });
    this.colorInput.addEventListener('change', () => {
      this.selectedColor = this.colorInput.value;
      this.syncColorSelection();
      this.hideColorPalette();
      this.customColorButton.focus();
    });
    this.colorPalette.addEventListener('toggle', () => {
      if (this.colorPalette.matches(':popover-open')) this.colorInput.focus();
    });
    this.colorPalette.append(this.paletteLabel, this.colorInput);
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
      // Keep cleanup and focus restoration identical to the Cancel button rather than
      // relying on the browser's post-close active-element state.
      event.preventDefault();
      this.dismiss(true);
    });
    this.dialog.addEventListener('pointerdown', (event) => {
      // With a zero-padding dialog, only the backdrop targets the dialog itself; the
      // form and every child keep their ordinary pointer behavior.
      if (event.target === this.dialog) {
        // Do not let the completed click retarget focus to the underlying document after
        // the pointerdown handler has restored it to the channel's settings button.
        event.preventDefault();
        this.dismiss(true);
      }
    });
  }

  open(anchor: HTMLButtonElement, cell: ChannelCell): void {
    if (this.dialog.open) this.dismiss(false);
    this.channel = cell.channel.index;
    this.anchor = anchor;
    this.renderStrings(cell.channel.index);
    this.nameInput.value = cell.channel.name;
    this.selectedColor = cell.channel.color;
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

  private renderStrings(channel: number): void {
    this.title.textContent = t('channels.settings', { index: channel });
    this.nameLabel.textContent = t('channels.name');
    const resetTitle = t('channels.resetName', { index: channel });
    this.resetNameButton.title = resetTitle;
    this.resetNameButton.setAttribute('aria-label', resetTitle);
    this.colorLabel.textContent = t('channels.color');
    this.paletteLabel.textContent = t('channels.customColor');
    this.customColorButton.title = t('channels.customColor');
    this.customColorButton.setAttribute('aria-label', t('channels.customColor'));
    this.triggerLabel.textContent = t('channels.triggerMode');
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
    this.customColorButton.style.background = this.selectedColor;
    this.colorInput.value = this.selectedColor;
  }

  private hideColorPalette(): void {
    if (this.colorPalette.matches(':popover-open')) this.colorPalette.hidePopover();
  }

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.channel < 0) return;
    const channel = this.channel;
    const mode = TRIGGER_MODES.find((candidate) =>
      this.triggerOptions.get(candidate)?.input.checked) ?? DEFAULT_TRIGGER_MODE;
    const config: ChannelConfiguration = {
      name: this.nameInput.value.trim(), mode, color: this.selectedColor,
    };

    // Close before App re-renders and replaces the anchor. Clear our references first so
    // the subsequent render cannot mistake this commit for a draft dismissal.
    this.hideColorPalette();
    this.channel = -1;
    this.anchor = null;
    this.dialog.close();
    this.onConfigure(channel, config);
    this.onSaved(channel);
  };

  private dismiss(restoreFocus: boolean): void {
    this.hideColorPalette();
    const anchor = this.anchor;
    this.channel = -1;
    this.anchor = null;
    if (this.dialog.open) this.dialog.close();
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }
}

export class ChannelList {
  private dragFrom = -1;
  private readonly settingsDialog: ChannelSettingsDialog;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: ChannelListCallbacks,
  ) {
    this.settingsDialog = new ChannelSettingsDialog(this.cb.onConfigure, (channel) => {
      const selector = `.ch-settings[data-channel="${channel}"]`;
      this.root.querySelector<HTMLButtonElement>(selector)?.focus();
    });
  }

  render(cells: readonly ChannelCell[]): void {
    this.settingsDialog.close();
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

      const tag = document.createElement('span');
      tag.className = 'ch-tag ch-tag--name';
      tag.textContent = cell.channel.name;
      tag.style.color = cell.channel.color;
      head.appendChild(tag);

      const settings = document.createElement('button');
      settings.type = 'button';
      settings.className = 'ch-settings';
      settings.dataset['channel'] = String(cell.channel.index);
      settings.title = t('channels.settings', { index: cell.channel.index });
      settings.setAttribute('aria-label', settings.title);
      settings.appendChild(settingsIcon());
      settings.addEventListener('click', (event) => {
        event.stopPropagation();
        this.settingsDialog.open(settings, cell);
      });
      settings.addEventListener('mousedown', () => { el.draggable = false; });
      settings.addEventListener('mouseup', () => { el.draggable = true; });
      head.appendChild(settings);
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
        txt.style.color = a.status === 'error' ? COLORS.negative : COLORS.text50;
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
  }

  /** Close before the toolbar opens its separate transient overlay. */
  closeDialog(): void {
    this.settingsDialog.close();
  }
}

function triggerModeName(mode: TriggerMode): string {
  return mode === 'falling' ? t('trigger.falling')
    : mode === 'rising' ? t('trigger.rising')
      : mode === 'edge' ? t('trigger.anyEdge')
        : mode === 'high' ? t('channels.triggerHigh')
          : mode === 'low' ? t('channels.triggerLow') : t('channels.triggerAny');
}

function triggerIcon(mode: TriggerMode): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const d = mode === 'falling' ? 'M1 4H8V12H23'
    : mode === 'rising' ? 'M1 12H8V4H23'
      : mode === 'edge' ? 'M1 12H5V4H10M14 4H19V12H23'
        : mode === 'high' ? 'M1 4H23'
          : mode === 'low' ? 'M1 12H23' : 'M6 4L18 12M18 4L6 12';
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
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
