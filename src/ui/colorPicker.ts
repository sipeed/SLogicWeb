import { div } from './capturePanel.js';
import {
  hexFromHsv, hsvFromHex, hueFromPoint, stepHsv, stepHue, svFromPoint, type Hsv,
} from './colorMath.js';
import { t } from './i18n.js';

type PickerWidget = 'field' | 'hue';

export class HsvPicker {
  readonly element: HTMLDivElement;
  private readonly field: HTMLDivElement;
  private readonly hueStrip: HTMLDivElement;
  private readonly previewSwatch: HTMLDivElement;
  private readonly hexText: HTMLSpanElement;
  private hsv: Hsv = { h: 0, s: 0, v: 0 };
  private dragId: number | null = null;

  constructor(private readonly onChange: (hex: string) => void) {
    this.field = div('channel-color-field');
    this.field.tabIndex = 0;
    this.field.setAttribute('role', 'slider');
    this.field.setAttribute('aria-valuemin', '0');
    this.field.setAttribute('aria-valuemax', '100');
    this.field.appendChild(div('channel-color-field-thumb'));
    this.wireDrag(this.field, 'field');
    this.field.addEventListener('keydown', (event) => {
      const next = stepHsv(this.hsv, event.key, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.hsv = next;
      this.commit();
    });

    this.hueStrip = div('channel-color-hue');
    this.hueStrip.tabIndex = 0;
    this.hueStrip.setAttribute('role', 'slider');
    this.hueStrip.setAttribute('aria-orientation', 'horizontal');
    this.hueStrip.setAttribute('aria-valuemin', '0');
    this.hueStrip.setAttribute('aria-valuemax', '359');
    this.hueStrip.appendChild(div('channel-color-hue-thumb'));
    this.wireDrag(this.hueStrip, 'hue');
    this.hueStrip.addEventListener('keydown', (event) => {
      const h = stepHue(this.hsv.h, event.key, event.shiftKey);
      if (h === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.hsv = { ...this.hsv, h };
      this.commit();
    });

    const preview = div('channel-color-preview');
    this.previewSwatch = div('channel-color-preview-swatch');
    this.hexText = document.createElement('span');
    this.hexText.className = 'channel-color-hex';
    preview.append(this.previewSwatch, this.hexText);

    this.element = div('channel-color-picker');
    this.element.append(this.field, this.hueStrip, preview);
    this.renderStrings();
    this.render();
  }

  setColor(hex: string): void {
    this.hsv = hsvFromHex(hex);
    this.render();
  }

  endDrag(): void {
    this.dragId = null;
  }

  focus(): void {
    this.field.focus({ preventScroll: true });
  }

  renderStrings(): void {
    this.field.setAttribute('aria-label', t('channels.colorField'));
    this.hueStrip.setAttribute('aria-label', t('channels.hue'));
  }

  private wireDrag(widget: HTMLDivElement, kind: PickerWidget): void {
    widget.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (this.dragId !== null) return;
      event.preventDefault();
      widget.focus({ preventScroll: true });
      widget.setPointerCapture(event.pointerId);
      this.dragId = event.pointerId;
      this.applyPointer(kind, widget, event);
    });
    widget.addEventListener('pointermove', (event) => {
      if (this.dragId === null || this.dragId !== event.pointerId) return;
      this.applyPointer(kind, widget, event);
    });
    const release = (event: PointerEvent): void => {
      if (this.dragId === null || this.dragId !== event.pointerId) return;
      this.endDrag();
    };
    widget.addEventListener('pointerup', release);
    widget.addEventListener('pointercancel', release);
    widget.addEventListener('lostpointercapture', release);
  }

  private applyPointer(kind: PickerWidget, widget: HTMLDivElement, event: PointerEvent): void {
    const rect = widget.getBoundingClientRect();
    if (kind === 'field') {
      const { s, v } = svFromPoint(rect, event.clientX, event.clientY);
      this.hsv = { ...this.hsv, s, v };
    } else {
      this.hsv = { ...this.hsv, h: hueFromPoint(rect, event.clientX) };
    }
    this.commit();
  }

  private commit(): void {
    this.onChange(this.render());
  }

  private render(): string {
    const { h, s, v } = this.hsv;
    this.field.style.setProperty('--channel-hue-color', `hsl(${h} 100% 50%)`);
    this.field.style.setProperty('--channel-s', String(s));
    this.field.style.setProperty('--channel-v', String(v));
    this.hueStrip.style.setProperty('--channel-h', String(h));
    const hex = hexFromHsv(this.hsv);
    this.previewSwatch.style.background = hex;
    this.hexText.textContent = hex;
    this.field.setAttribute('aria-valuenow', String(Math.round(s * 100)));
    this.field.setAttribute('aria-valuetext', `${Math.round(s * 100)}% / ${Math.round(v * 100)}%`);
    this.hueStrip.setAttribute('aria-valuenow', String(Math.round(h)));
    this.hueStrip.setAttribute('aria-valuetext', `${Math.round(h)}°`);
    return hex;
  }
}
