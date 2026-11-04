// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The staged acquisition-time control: a slider whose unit changes as it moves right
 * (microseconds, milliseconds, seconds, minutes, then Unlimited), plus a numeric field
 * and a read-only unit badge. The scale itself lives in `timeScale.ts`.
 *
 * The slider commits on `change`, not on every `input`, so dragging does not spam the
 * settings path; the number and ARIA text follow the thumb while dragging. The numeric
 * field accepts fractional values in the current unit, which keeps the exact editor
 * available where the slider's stage step is coarse (for example 7.5 s between the
 * one-second steps, or the exact device maximum above the last whole minute).
 */

import { selectControl, type SelectOptionTuple } from './select.js';
import {
  buildTimeScale, finiteMaxValue, positionForSeconds, secondsInUnit, timeAtPosition,
  unitValueText, type ScaleUnit,
} from './timeScale.js';

const SCALE_UNIT_OPTIONS: SelectOptionTuple[] = [['us', 'us'], ['ms', 'ms'], ['s', 's'], ['min', 'min']];

export interface AcquisitionTimeUnlimited {
  active: boolean;
  label: string;
  onSelect(): void;
}

export interface AcquisitionTimeControlOptions {
  key: string;
  label: string;
  seconds: number;
  minSeconds: number;
  maxSeconds: number;
  disabled: boolean;
  unlimited?: AcquisitionTimeUnlimited;
  onValue(seconds: number): void;
}

export function acquisitionTimeControl(options: AcquisitionTimeControlOptions): { el: HTMLDivElement } {
  const hasUnlimited = options.unlimited !== undefined;
  const scale = buildTimeScale(options.minSeconds, options.maxSeconds, hasUnlimited);
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
  range.className = 'acquisition-time-slider' + (hasUnlimited ? ' has-unlimited' : '');
  range.dataset.timeSlider = options.key;
  range.min = '0';
  range.max = String(scale.sliderMax);
  range.step = '1';
  const startPosition = options.unlimited?.active
    ? scale.unlimited ?? scale.finiteMax
    : initial?.position ?? 0;
  range.value = String(startPosition);
  range.disabled = options.disabled || unavailable;
  range.setAttribute('aria-label', options.label);
  if (scale.unlimited !== null) range.dataset.unlimitedValue = String(scale.unlimited);
  sliderWrap.appendChild(range);

  if (options.unlimited) {
    const labels = document.createElement('div');
    labels.className = 'acquisition-time-slider-labels';
    const finite = document.createElement('span');
    const finiteTop = finiteMaxValue(scale);
    finite.textContent = finiteTop ? `${finiteTop.value} ${finiteTop.unit}` : '';
    finite.title = finite.textContent;
    const unlimited = document.createElement('span');
    unlimited.textContent = '∞';
    unlimited.title = options.unlimited.label;
    unlimited.setAttribute('aria-label', options.unlimited.label);
    labels.append(finite, unlimited);
    sliderWrap.appendChild(labels);
  }

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

  const unlimitedValue = document.createElement('span');
  unlimitedValue.className = 'acquisition-time-unlimited';
  unlimitedValue.dataset.timeUnlimited = options.key;
  unlimitedValue.textContent = '∞';
  unlimitedValue.title = options.unlimited?.label ?? '';
  unlimitedValue.setAttribute('aria-label', options.unlimited?.label ?? '');

  const unitControl = selectControl(
    `${options.key}.unit`, options.label, SCALE_UNIT_OPTIONS, 'ms',
  );
  unitControl.el.classList.add('acquisition-time-unit');
  unitControl.disabled = options.disabled || unavailable;
  inputGroup.append(number, unlimitedValue, unitControl.el);
  body.append(sliderWrap, inputGroup);
  root.append(head, body);

  let unlimitedDraft = options.unlimited?.active === true;
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
  const showFinite = (seconds: number, updateNumber = true): void => {
    unlimitedDraft = false;
    number.hidden = false;
    unlimitedValue.hidden = true;
    range.classList.remove('is-unlimited');
    const value = timeAtPosition(scale, positionForSeconds(scale, seconds)?.position ?? 0);
    if (value) setUnit(value.unit);
    if (updateNumber) number.value = unitValueText(seconds, unit);
    range.setAttribute('aria-valuetext', `${unitValueText(seconds, unit)} ${unit}`);
  };
  const syncFromPosition = (position: number): void => {
    setFill(position);
    if (scale.unlimited !== null && position === scale.unlimited) {
      unlimitedDraft = true;
      range.classList.add('is-unlimited');
      number.hidden = true;
      unlimitedValue.hidden = false;
      range.setAttribute('aria-valuetext', options.unlimited?.label ?? '');
      return;
    }
    const value = timeAtPosition(scale, position);
    if (!value) return;
    showFinite(value.seconds);
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
    range.setAttribute('aria-valuetext', `${unitValueText(initialSeconds, unit)} ${unit}`);
  }
  if (unlimitedDraft) {
    number.hidden = true;
    unlimitedValue.hidden = false;
    range.classList.add('is-unlimited');
    range.setAttribute('aria-valuetext', options.unlimited?.label ?? '');
  } else {
    number.hidden = false;
    unlimitedValue.hidden = true;
  }
  setFill(Number(range.value));
  setFieldInvalid(false);

  range.addEventListener('input', () => {
    setFieldInvalid(false);
    syncFromPosition(Number(range.value));
  });
  range.addEventListener('change', () => {
    const position = Number(range.value);
    if (scale.unlimited !== null && position === scale.unlimited) {
      options.unlimited?.onSelect();
      return;
    }
    const value = timeAtPosition(scale, position);
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
      range.setAttribute('aria-valuetext', `${unitValueText(seconds, unit)} ${unit}`);
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
