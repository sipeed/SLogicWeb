// SPDX-License-Identifier: GPL-3.0-or-later

export const PANEL_MIN_FLOOR = 200;
export const DIGITAL_SECTION_SELECTOR = '.digital-section';

let measured: number | null = null;
const listeners = new Set<(minWidth: number) => void>();

export function currentPanelMinWidth(): number {
  return Math.max(PANEL_MIN_FLOOR, measured ?? PANEL_MIN_FLOOR);
}

export function onPanelMinWidthChange(cb: (minWidth: number) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function publishPanelMinWidth(px: number | null): number {
  const next = px === null || !Number.isFinite(px) || px <= 0
    ? measured
    : Math.max(PANEL_MIN_FLOOR, Math.ceil(px));
  if (next !== measured) {
    measured = next;
    for (const cb of listeners) cb(currentPanelMinWidth());
  }
  return currentPanelMinWidth();
}

export function refreshPanelMinWidth(panel: HTMLElement): number {
  return publishPanelMinWidth(measurePanelMinWidth(panel));
}

export function resetPanelMinWidthForTest(): void {
  measured = null;
}

export function measurePanelMinWidth(panel: HTMLElement): number | null {
  if (typeof getComputedStyle !== 'function') return null;
  if (panel.getClientRects().length === 0) return null;
  const section = panel.querySelector<HTMLElement>(DIGITAL_SECTION_SELECTOR);
  if (section === null || section.getClientRects().length === 0) return null;
  const chrome = panel.getBoundingClientRect().width - section.getBoundingClientRect().width;
  const value = Math.ceil(digitalSectionMinWidth(section) + Math.max(0, chrome));
  return value > 0 ? value : null;
}

export function digitalSectionMinWidth(section: HTMLElement): number {
  const style = getComputedStyle(section);
  const padding = lengthPx(style.paddingLeft) + lengthPx(style.paddingRight);
  const borders = section.offsetWidth - section.clientWidth;
  let content = 0;
  for (const bank of section.querySelectorAll<HTMLElement>('.channel-bank')) {
    content = Math.max(content, bankMinWidth(bank));
  }
  const head = section.querySelector<HTMLElement>('.panel-section-head');
  if (head !== null) {
    for (const child of head.children) {
      if (child instanceof HTMLElement) content = Math.max(content, maxContentWidth(child));
    }
  }
  return content + padding + borders;
}

export function bankMinWidth(bank: HTMLElement): number {
  const grid = bank.querySelector<HTMLElement>('.channel-bank-grid');
  const analog = bank.querySelector<HTMLElement>('.analog-button');
  if (grid === null || analog === null) return 0;
  const form = grid.dataset.chipForm;
  const chipWidth = grid.style.getPropertyValue('--chip-min-w');
  const rowStyle = snapshotStyle(bank);
  const gridStyle = snapshotStyle(grid);
  grid.dataset.chipForm = 'short';
  grid.style.setProperty('--chip-min-w', '0px');
  stretch(bank);
  stretch(grid);
  const width = bank.getBoundingClientRect().width;
  restoreStyle(grid, gridStyle);
  restoreStyle(bank, rowStyle);
  if (form === undefined) delete grid.dataset.chipForm;
  else grid.dataset.chipForm = form;
  if (chipWidth === '') grid.style.removeProperty('--chip-min-w');
  else grid.style.setProperty('--chip-min-w', chipWidth);
  return Number.isFinite(width) ? width : 0;
}

export function maxContentWidth(element: HTMLElement): number {
  const saved = snapshotStyle(element);
  stretch(element);
  const width = element.getBoundingClientRect().width;
  restoreStyle(element, saved);
  return Number.isFinite(width) ? width : 0;
}

interface StyleSnapshot {
  width: string;
  minWidth: string;
  maxWidth: string;
  flex: string;
}

function snapshotStyle(element: HTMLElement): StyleSnapshot {
  return {
    width: element.style.width,
    minWidth: element.style.minWidth,
    maxWidth: element.style.maxWidth,
    flex: element.style.flex,
  };
}

function restoreStyle(element: HTMLElement, saved: StyleSnapshot): void {
  element.style.width = saved.width;
  element.style.minWidth = saved.minWidth;
  element.style.maxWidth = saved.maxWidth;
  element.style.flex = saved.flex;
}

function stretch(element: HTMLElement): void {
  element.style.minWidth = '0';
  element.style.maxWidth = 'none';
  element.style.flex = '0 0 auto';
  element.style.width = 'max-content';
}

function lengthPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
