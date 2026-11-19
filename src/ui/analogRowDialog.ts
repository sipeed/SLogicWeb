// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.

import { button, div } from './capturePanel.js';
import {
  analogHalfRangeV, analogVoltsPerCode,
} from './channelBanks.js';
import { t } from './i18n.js';
import { triggerIcon } from './triggerGlyph.js';

export interface AnalogRowView {
  id: string;
  name: string;
  kind: 'rising' | 'falling' | null;
  volts: number;
  gain: number;
  overlay: boolean;
}

export interface AnalogRowConfiguration {
  name: string;
  kind: 'rising' | 'falling' | null;
  volts: number;
  overlay: boolean;
}

export interface AnalogRowDialogCallbacks {
  configure(id: string, config: AnalogRowConfiguration): void;
  dismiss(id: string, opener: HTMLButtonElement | null): void;
}

const KINDS = ['none', 'rising', 'falling'] as const;
type Kind = (typeof KINDS)[number];

const KIND_LABEL_KEYS = {
  none: 'trigger.none',
  rising: 'trigger.rising',
  falling: 'trigger.falling',
} as const;

interface KindOption {
  label: HTMLLabelElement;
  input: HTMLInputElement;
}

export class AnalogRowSettingsDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly nameLabel: HTMLLabelElement;
  private readonly nameInput: HTMLInputElement;
  private readonly triggerLabel: HTMLSpanElement;
  private readonly triggerFieldset: HTMLFieldSetElement;
  private readonly triggerOptions = new Map<Kind, KindOption>();
  private readonly levelLabel: HTMLLabelElement;
  private readonly levelInput: HTMLInputElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private id: string | null = null;
  private overlay = false;
  private opener: HTMLButtonElement | null = null;

  constructor(private readonly cb: AnalogRowDialogCallbacks) {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'channel-settings-dialog';
    this.dialog.setAttribute('aria-labelledby', 'analog-row-settings-title');

    const form = document.createElement('form');
    form.className = 'channel-settings-form';

    const header = div('channel-settings-header');
    this.title = document.createElement('h2');
    this.title.id = 'analog-row-settings-title';
    header.appendChild(this.title);

    const fields = div('channel-settings-fields');

    const nameField = div('channel-settings-field channel-settings-kv');
    this.nameLabel = document.createElement('label');
    this.nameLabel.className = 'channel-settings-copy';
    this.nameLabel.htmlFor = 'analog-row-settings-name';
    this.nameInput = document.createElement('input');
    this.nameInput.id = 'analog-row-settings-name';
    this.nameInput.className = 'channel-settings-name';
    this.nameInput.type = 'text';
    this.nameInput.spellcheck = false;
    this.nameInput.autocomplete = 'off';
    nameField.append(this.nameLabel, this.nameInput);

    const triggerField = div('channel-settings-field channel-settings-kv');
    this.triggerLabel = document.createElement('span');
    this.triggerLabel.className = 'channel-settings-copy';
    this.triggerLabel.id = 'analog-row-settings-trigger-label';
    this.triggerFieldset = document.createElement('fieldset');
    this.triggerFieldset.className = 'channel-trigger-options';
    this.triggerFieldset.setAttribute('aria-labelledby', this.triggerLabel.id);
    for (const kind of KINDS) {
      const label = document.createElement('label');
      label.className = 'channel-trigger-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'analog-row-trigger-mode';
      input.value = kind;
      label.append(input, triggerIcon(kind === 'none' ? 'dont-care' : kind, 'menu'));
      this.triggerFieldset.appendChild(label);
      this.triggerOptions.set(kind, { label, input });
    }
    this.triggerFieldset.addEventListener('change', () => this.syncLevel());
    triggerField.append(this.triggerLabel, this.triggerFieldset);

    const levelField = div('channel-settings-field channel-settings-kv');
    this.levelLabel = document.createElement('label');
    this.levelLabel.className = 'channel-settings-copy';
    this.levelLabel.htmlFor = 'analog-row-settings-level';
    this.levelInput = document.createElement('input');
    this.levelInput.id = 'analog-row-settings-level';
    this.levelInput.className = 'channel-settings-name';
    this.levelInput.type = 'number';
    const unit = document.createElement('span');
    unit.className = 'channel-settings-copy';
    unit.textContent = 'V';
    const levelControl = div('channel-settings-name-control');
    levelControl.append(this.levelInput, unit);
    levelField.append(this.levelLabel, levelControl);

    fields.append(nameField, triggerField, levelField);

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

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(opener: HTMLButtonElement, view: AnalogRowView): void {
    if (this.dialog.open) this.close();
    this.id = view.id;
    this.opener = opener;
    this.overlay = view.overlay;
    this.renderStrings(view.name);
    this.nameInput.value = view.name;
    const half = analogHalfRangeV(view.gain);
    this.levelInput.min = String(-half);
    this.levelInput.max = String(half);
    this.levelInput.step = String(Number(Math.max(0.001, analogVoltsPerCode(view.gain)).toPrecision(1)));
    this.levelInput.value = String(view.volts);
    const kind: Kind = view.kind ?? 'none';
    for (const [candidate, option] of this.triggerOptions) {
      option.input.checked = candidate === kind;
    }
    this.syncLevel();
    this.dialog.showModal();
    this.nameInput.focus();
    this.nameInput.select();
  }

  close(): void {
    this.dismiss(false);
  }

  closeUnless(present: readonly string[]): void {
    if (this.id === null || present.includes(this.id)) return;
    this.dismiss(false);
  }

  private renderStrings(name: string): void {
    this.title.textContent = t('analogRow.settings', { name });
    this.nameLabel.textContent = t('bus.name');
    this.triggerLabel.textContent = t('channels.triggerMode');
    this.levelLabel.textContent = t('channels.triggerLevel');
    this.cancelButton.textContent = t('channels.cancel');
    this.saveButton.textContent = t('toolbar.save');
    for (const [kind, option] of this.triggerOptions) {
      const label = t(KIND_LABEL_KEYS[kind]);
      option.label.title = label;
      option.input.setAttribute('aria-label', label);
    }
  }

  private checkedKind(): Kind {
    return KINDS.find((kind) => this.triggerOptions.get(kind)?.input.checked) ?? 'none';
  }

  private syncLevel(): void {
    this.levelInput.disabled = this.checkedKind() === 'none';
  }

  private readonly onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (this.id === null) return;
    const id = this.id;
    const opener = this.opener;
    const kind = this.checkedKind();
    const config: AnalogRowConfiguration = {
      name: this.nameInput.value.trim(),
      kind: kind === 'none' ? null : kind,
      volts: Number(this.levelInput.value) || 0,
      overlay: this.overlay,
    };
    this.reset();
    this.cb.configure(id, config);
    this.cb.dismiss(id, opener);
  };

  private dismiss(restoreFocus: boolean): void {
    const id = this.id;
    const opener = this.opener;
    this.reset();
    if (restoreFocus && id !== null) this.cb.dismiss(id, opener);
  }

  private reset(): void {
    this.id = null;
    this.opener = null;
    this.nameInput.value = '';
    if (this.dialog.open) this.dialog.close();
  }
}
