// SPDX-License-Identifier: GPL-3.0-or-later

export const CHIP_GAP_PX = 4;

export type ChipForm = 'full' | 'short';

export interface ChipRowFit {
  readonly form: ChipForm;
  readonly chipCss: number;
}

export function chipLabel(index: number, form: ChipForm): string {
  return form === 'full' ? `D${index}` : String(index);
}

export function chipRowFit(
  available: number,
  count: number,
  full: number,
  short: number,
  gap: number = CHIP_GAP_PX,
): ChipRowFit {
  const widestFull = finiteSize(full);
  const widestShort = finiteSize(short);
  const columns = finiteSize(count);
  if (columns < 1 || !Number.isFinite(available)) {
    return { form: 'full', chipCss: widestFull };
  }
  const needed = columns * widestFull + (columns - 1) * Math.max(0, gap);
  return available >= needed
    ? { form: 'full', chipCss: widestFull }
    : { form: 'short', chipCss: widestShort };
}

export function chipBoxWidth(sample: HTMLElement, text: string): number {
  const context = measureContext();
  if (context === null) return 0;
  context.font = fontOf(sample);
  return context.measureText(text).width + chipBoxExtra(sample);
}

export function widestChipBox(sample: HTMLElement, labels: readonly string[]): number {
  let widest = 0;
  for (const label of labels) widest = Math.max(widest, chipBoxWidth(sample, label));
  return widest;
}

function finiteSize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

let measuring: CanvasRenderingContext2D | null | undefined;

function measureContext(): CanvasRenderingContext2D | null {
  if (measuring !== undefined) return measuring;
  measuring = typeof document === 'undefined'
    ? null
    : document.createElement('canvas').getContext('2d');
  return measuring;
}

function fontOf(element: HTMLElement): string {
  const style = getComputedStyle(element);
  if (style.font !== '') return style.font;
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`;
}

function chipBoxExtra(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return px(style.borderLeftWidth) + px(style.borderRightWidth) +
    px(style.paddingLeft) + px(style.paddingRight);
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
