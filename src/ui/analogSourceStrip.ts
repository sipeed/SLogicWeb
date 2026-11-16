// SPDX-License-Identifier: GPL-3.0-or-later

import { t } from './i18n.js';

export interface AnalogSourceStripItem {
  busId: string;
  name: string;
  color: string;
  focused: boolean;
  visible: boolean;
  volts: string;
  voltsDetail: string;
}

export interface AnalogSourceStripView {
  items: readonly AnalogSourceStripItem[];
  note: string;
}

export interface AnalogSourceStripCallbacks {
  onFocus(busId: string): void;
  onToggleVisibility(busId: string): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function eyeIcon(hidden: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'analog-source-eye');
  const outline = document.createElementNS(SVG_NS, 'path');
  outline.setAttribute('d', 'M1.6 8S4 4 8 4s6.4 4 6.4 4S12 12 8 12 1.6 8 1.6 8Z');
  const pupil = document.createElementNS(SVG_NS, 'circle');
  pupil.setAttribute('cx', '8');
  pupil.setAttribute('cy', '8');
  pupil.setAttribute('r', '1.9');
  svg.append(outline, pupil);
  if (hidden) {
    const slash = document.createElementNS(SVG_NS, 'path');
    slash.setAttribute('d', 'M2.4 13.6 13.6 2.4');
    svg.appendChild(slash);
  }
  return svg;
}

export class AnalogSourceStrip {
  private readonly root: HTMLDivElement;

  constructor(container: HTMLElement, private readonly cb: AnalogSourceStripCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'analog-source-strip';
    this.root.setAttribute('role', 'group');
    this.root.hidden = true;
    container.appendChild(this.root);
  }

  get element(): HTMLDivElement {
    return this.root;
  }

  render(view: AnalogSourceStripView): void {
    const active = document.activeElement as HTMLElement | null;
    const inside = active !== null && this.root.contains(active);
    const keptBus = inside ? active.dataset.busId : undefined;
    const keptAction = inside ? active.dataset.action : undefined;
    const label = t('bus.sourceStrip');
    if (this.root.getAttribute('aria-label') !== label) this.root.setAttribute('aria-label', label);
    this.root.hidden = view.items.length === 0;
    this.root.replaceChildren();
    for (const item of view.items) this.root.appendChild(this.itemElement(item));
    if (view.items.length > 0 && view.note !== '') {
      const note = document.createElement('p');
      note.className = 'analog-source-note';
      note.textContent = view.note;
      this.root.appendChild(note);
    }
    if (keptBus === undefined || keptAction === undefined) return;
    const again = [...this.root.querySelectorAll<HTMLElement>('[data-bus-id]')].find((child) =>
      child.dataset.busId === keptBus && child.dataset.action === keptAction);
    again?.focus({ preventScroll: true });
  }

  updateVoltages(view: AnalogSourceStripView): void {
    const wrappers = [...this.root.querySelectorAll<HTMLElement>('.analog-source-item')];
    const shown = this.root.hidden ? 0 : wrappers.length;
    if (shown !== view.items.length || this.noteText() !== view.note) {
      this.render(view);
      return;
    }
    for (const wrapper of wrappers) {
      const item = view.items.find((candidate) => candidate.busId === wrapper.dataset.busId);
      if (item === undefined) {
        this.render(view);
        return;
      }
      this.applyItem(wrapper, item);
    }
  }

  private noteText(): string {
    return this.root.querySelector<HTMLElement>('.analog-source-note')?.textContent ?? '';
  }

  private itemElement(item: AnalogSourceStripItem): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'analog-source-item';
    wrapper.dataset.busId = item.busId;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'analog-source-chip';
    chip.dataset.busId = item.busId;
    chip.dataset.action = 'focus';
    chip.appendChild(this.swatchElement(item));
    const name = document.createElement('span');
    name.className = 'analog-source-name';
    name.textContent = item.name;
    const volts = document.createElement('span');
    volts.className = 'analog-source-volts';
    volts.translate = false;
    chip.append(name, volts);
    chip.addEventListener('pointerdown', (event) => event.stopPropagation());
    chip.addEventListener('dblclick', (event) => event.stopPropagation());
    chip.addEventListener('click', () => this.cb.onFocus(item.busId));
    const visibility = document.createElement('button');
    visibility.type = 'button';
    visibility.className = 'analog-source-visibility';
    visibility.dataset.busId = item.busId;
    visibility.dataset.action = 'visibility';
    visibility.addEventListener('pointerdown', (event) => event.stopPropagation());
    visibility.addEventListener('dblclick', (event) => event.stopPropagation());
    visibility.addEventListener('click', () => this.cb.onToggleVisibility(item.busId));
    wrapper.append(chip, visibility);
    this.applyItem(wrapper, item);
    return wrapper;
  }

  private swatchElement(item: AnalogSourceStripItem): HTMLSpanElement {
    const swatch = document.createElement('span');
    swatch.className = 'analog-source-swatch';
    swatch.style.background = item.color;
    swatch.setAttribute('aria-hidden', 'true');
    return swatch;
  }

  private applyItem(wrapper: HTMLElement, item: AnalogSourceStripItem): void {
    const chip = wrapper.querySelector<HTMLElement>('.analog-source-chip');
    const visibility = wrapper.querySelector<HTMLElement>('.analog-source-visibility');
    const volts = wrapper.querySelector<HTMLElement>('.analog-source-volts');
    if (chip === null || visibility === null || volts === null) return;
    const focusLabel = t('bus.focusSource', { name: item.name });
    const focusText = item.voltsDetail === '' ? focusLabel : `${focusLabel}. ${item.voltsDetail}`;
    const pressed = item.focused ? 'true' : 'false';
    if (chip.getAttribute('aria-pressed') !== pressed) chip.setAttribute('aria-pressed', pressed);
    if (chip.getAttribute('aria-label') !== focusText) chip.setAttribute('aria-label', focusText);
    if (chip.title !== focusText) chip.title = focusText;
    chip.classList.toggle('focused', item.focused);
    chip.classList.toggle('is-hidden', !item.visible);
    const visibilityLabel = t(item.visible ? 'bus.hideSource' : 'bus.showSource', {
      name: item.name,
    });
    const visibilityPressed = item.visible ? 'true' : 'false';
    if (visibility.getAttribute('aria-pressed') !== visibilityPressed) {
      visibility.setAttribute('aria-pressed', visibilityPressed);
    }
    if (visibility.getAttribute('aria-label') !== visibilityLabel) {
      visibility.setAttribute('aria-label', visibilityLabel);
    }
    if (visibility.title !== visibilityLabel) visibility.title = visibilityLabel;
    visibility.classList.toggle('is-hidden', !item.visible);
    if (visibility.dataset.hidden !== String(!item.visible)) {
      visibility.dataset.hidden = String(!item.visible);
      visibility.replaceChildren(eyeIcon(!item.visible));
    }
    if (volts.textContent !== item.volts) volts.textContent = item.volts;
    if (item.voltsDetail !== '') {
      if (volts.title !== item.voltsDetail) volts.title = item.voltsDetail;
    } else if (volts.getAttribute('title') !== null) {
      volts.removeAttribute('title');
    }
  }
}
