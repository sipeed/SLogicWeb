// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The staged acquisition-time control: a slider whose unit changes as it moves right
 * (microseconds, milliseconds, seconds, minutes), plus a numeric field and a read-only
 * unit badge. The scale itself lives in `timeScale.ts`.
 *
 * The slider commits on `change`, not on every `input`, so dragging does not spam the
 * settings path; the number and ARIA text follow the thumb while dragging. The numeric
 * field accepts fractional values in the current unit, which keeps the exact editor
 * available where the slider's stage step is coarse (for example 7.5 s between the
 * one-second steps, or the exact device maximum above the last whole minute).
 */

import { selectControl, type SelectOptionTuple } from './select.js';
import {
  buildTimeScale, positionForSeconds, secondsInUnit, timeAtPosition,
  unitValueText, type ScaleUnit,
} from './timeScale.js';

// The value stays the ASCII unit id ('us'); the label is the written unit, µs (search: "us").
const SCALE_UNIT_OPTIONS: SelectOptionTuple[] = [['us', '\u00b5s', 'us'], ['ms', 'ms'], ['s', 's'], ['min', 'min']];
const unitLabel = (unit: ScaleUnit): string => (unit === 'us' ? '\u00b5s' : unit);

export interface AcquisitionTimeControlOptions {
  key: string;
  label: string;
  seconds: number;
  minSeconds: number;
  maxSeconds: number;
  disabled: boolean;
  onValue(seconds: number): void;
}

export function acquisitionTimeControl(options: AcquisitionTimeControlOptions): { el: HTMLDivElement } {
  const scale = buildTimeScale(options.minSeconds, options.maxSeconds);
  const initial = positionForSeconds(scale, options.seconds);
  const unavailable = scale.stages.length === 0 || scale.finiteMax === 0;
  const root = document.createElement('div');
  root.className = 'acquisition-time';
  root.dataset.timeControl = options.key;
  root.dataset.disabled = String(options.disabled || unavailable);

  const head = document.createElement('div');
  head.className = 'acquisition-time-head';
  const label = document.createElement('span');
  label.className = 'acquisition-time-label';
  label.textContent = options.label;
  head.appendChild(label);

  const body = document.createElement('div');
  body.className = 'acquisition-time-body';
  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'acquisition-time-slider-wrap';
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'acquisition-time-slider';
  range.dataset.timeSlider = options.key;
  range.min = '0';
  range.max = String(scale.sliderMax);
  range.step = '1';
  range.value = String(initial?.position ?? 0);
  range.disabled = options.disabled || unavailable;
  range.setAttribute('aria-label', options.label);
  sliderWrap.appendChild(range);

  const inputGroup = document.createElement('div');
  inputGroup.className = 'acquisition-time-input-group';
  const number = document.createElement('input');
  number.type = 'number';
  number.className = 'acquisition-time-value';
  number.dataset.timeInput = options.key;
  number.step = 'any';
  number.autocomplete = 'off';
  number.inputMode = 'decimal';
  number.disabled = options.disabled || unavailable;
  number.setAttribute('aria-label', options.label);

  const unitControl = selectControl(
    `${options.key}.unit`, options.label, SCALE_UNIT_OPTIONS, 'ms',
  );
  unitControl.el.classList.add('acquisition-time-unit');
  unitControl.disabled = options.disabled || unavailable;
  inputGroup.append(number, unitControl.el);
  body.append(sliderWrap, inputGroup);
  root.append(head, body);

  let unit: ScaleUnit = initial?.value.unit ?? scale.stages[0]?.unit ?? 'ms';

  const setFieldInvalid = (invalid: boolean): void => {
    if (invalid) root.dataset.invalid = 'true';
    else delete root.dataset.invalid;
    if (invalid) number.setAttribute('aria-invalid', 'true');
    else number.removeAttribute('aria-invalid');
  };
  const setUnit = (next: ScaleUnit): void => {
    unit = next;
    unitControl.value = next;
    number.min = unitValueText(options.minSeconds, next);
    number.max = unitValueText(options.maxSeconds, next);
  };
  const setFill = (position: number): void => {
    const fraction = scale.sliderMax > 0 ? position / scale.sliderMax : 0;
    range.style.setProperty('--acquisition-fill', `${Math.min(100, Math.max(0, fraction * 100))}%`);
  };
  const showValue = (seconds: number): void => {
    const value = timeAtPosition(scale, positionForSeconds(scale, seconds)?.position ?? 0);
    if (value) setUnit(value.unit);
    number.value = unitValueText(seconds, unit);
    range.setAttribute('aria-valuetext', `${unitValueText(seconds, unit)} ${unitLabel(unit)}`);
  };
  const syncFromPosition = (position: number): void => {
    setFill(position);
    const value = timeAtPosition(scale, position);
    if (!value) return;
    showValue(value.seconds);
  };
  const commitSeconds = (seconds: number): void => {
    const clamped = Math.min(options.maxSeconds, Math.max(options.minSeconds, seconds));
    setFieldInvalid(false);
    options.onValue(clamped);
  };

  const initialSeconds = options.seconds;
  setUnit(unit);
  if (initial) {
    number.value = unitValueText(initialSeconds, unit);
    range.setAttribute('aria-valuetext', `${unitValueText(initialSeconds, unit)} ${unitLabel(unit)}`);
  }
  setFill(Number(range.value));
  setFieldInvalid(false);

  range.addEventListener('input', () => {
    setFieldInvalid(false);
    syncFromPosition(Number(range.value));
  });
  range.addEventListener('change', () => {
    const value = timeAtPosition(scale, Number(range.value));
    if (value) commitSeconds(value.seconds);
  });

  number.addEventListener('input', () => {
    const typed = Number(number.value);
    if (!Number.isFinite(typed) || typed <= 0) {
      setFieldInvalid(true);
      return;
    }
    const seconds = secondsInUnit(typed, unit);
    setFieldInvalid(seconds < options.minSeconds || seconds > options.maxSeconds);
    const placed = positionForSeconds(scale, seconds);
    if (placed) {
      range.value = String(placed.position);
      setFill(placed.position);
      range.setAttribute('aria-valuetext', `${unitValueText(seconds, unit)} ${unitLabel(unit)}`);
    }
  });
  number.addEventListener('change', () => {
    const typed = Number(number.value);
    if (!Number.isFinite(typed) || typed <= 0) {
      setFieldInvalid(true);
      number.reportValidity();
      return;
    }
    const seconds = secondsInUnit(typed, unit);
    if (seconds < options.minSeconds || seconds > options.maxSeconds) {
      setFieldInvalid(true);
      number.reportValidity();
      return;
    }
    commitSeconds(seconds);
  });

  unitControl.addEventListener('change', () => {
    const next = unitControl.value;
    if (next !== 'us' && next !== 'ms' && next !== 's' && next !== 'min') {
      unitControl.value = unit;
      return;
    }
    setUnit(next);
    const position = Math.min(scale.finiteMax, Number(range.value));
    const value = timeAtPosition(scale, position);
    if (value) number.value = unitValueText(value.seconds, next);
  });

  return { el: root };
}
