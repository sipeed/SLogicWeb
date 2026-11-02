// SPDX-License-Identifier: GPL-3.0-or-later

import { selectControl, type SelectOptionTuple } from './select.js';
import {
  SLIDER_FINITE_MAX,
  isUnlimitedTimeSlider,
  timeSliderAriaValueText,
  timeSliderFiniteMaxLabel,
  timeSliderTrackGeometry,
  timeValueFromSlider,
  timeValueToSlider,
} from './timeSlider.js';
import {
  TIME_UNITS, isPositiveInteger, isTimeUnit, maxTimeValue, minTimeValue,
  timeUnitForRange, timeValueFromSeconds, type TimeUnit,
} from './timeUnits.js';

export interface TimeSliderBounds {
  min: number;
  max: number;
  finiteMax: number;
  unlimitedValue: number | null;
}

export function timeSliderBounds(
  minSeconds: number, maxSeconds: number, unit: TimeUnit, unlimited = false,
): TimeSliderBounds {
  const track = timeSliderTrackGeometry(unlimited);
  return {
    min: minTimeValue(minSeconds, unit),
    finiteMax: maxTimeValue(maxSeconds, unit),
    max: track.max,
    unlimitedValue: unlimited ? track.max : null,
  };
}

export interface AcquisitionTimeUnlimited {
  active: boolean;
  label: string;
  onSelect(): void;
}

export interface AcquisitionTimeControlOptions {
  key: string;
  label: string;
  unitLabel: string;
  unit: TimeUnit;
  seconds: number;
  minSeconds: number;
  maxSeconds: number;
  disabled: boolean;
  unlimited?: AcquisitionTimeUnlimited;
  onValue(value: number, unit: TimeUnit): void;
  onUnit(unit: TimeUnit, value: number | null): void;
}

export function acquisitionTimeControl(options: AcquisitionTimeControlOptions): { el: HTMLDivElement } {
  const unit = timeUnitForRange(options.unit, options.minSeconds, options.maxSeconds) ?? options.unit;
  const hasUnlimited = options.unlimited !== undefined;
  const bounds = timeSliderBounds(options.minSeconds, options.maxSeconds, unit, hasUnlimited);
  const finiteValue = timeValueFromSeconds(options.seconds, unit, options.minSeconds, options.maxSeconds);
  const unavailable = finiteValue === null || bounds.finiteMax < bounds.min;
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
  range.max = String(bounds.max);
  range.step = '1';
  const initialPosition = options.unlimited?.active
    ? bounds.unlimitedValue ?? SLIDER_FINITE_MAX
    : timeValueToSlider(finiteValue ?? bounds.min, bounds.min, bounds.finiteMax) ?? 0;
  range.value = String(initialPosition);
  range.disabled = options.disabled || unavailable;
  range.setAttribute('aria-label', options.label);
  if (bounds.unlimitedValue !== null) range.dataset.unlimitedValue = String(bounds.unlimitedValue);
  sliderWrap.appendChild(range);

  if (options.unlimited) {
    const labels = document.createElement('div');
    labels.className = 'acquisition-time-slider-labels';
    const finite = document.createElement('span');
    finite.textContent = String(bounds.finiteMax);
    finite.title = timeSliderFiniteMaxLabel(bounds.finiteMax, unit);
    const unlimited = document.createElement('span');
    unlimited.textContent = '∞';
    unlimited.title = options.unlimited.label;
    unlimited.setAttribute('aria-label', options.unlimited.label);
    labels.append(finite, unlimited);
    sliderWrap.appendChild(labels);
  }

  const inputGroup = document.createElement('div');
  inputGroup.className = 'acquisition-time-input-group';
  let number: HTMLInputElement | null = null;

  const unlimitedValue = document.createElement('span');
  unlimitedValue.className = 'acquisition-time-unlimited';
  unlimitedValue.dataset.timeUnlimited = options.key;
  unlimitedValue.textContent = '∞';
  unlimitedValue.hidden = options.unlimited?.active !== true;
  unlimitedValue.title = options.unlimited?.label ?? '';
  unlimitedValue.setAttribute('aria-label', options.unlimited?.label ?? '');

  const unitOptions: SelectOptionTuple[] = TIME_UNITS.map((candidate) => [candidate, candidate]);
  const unitControl = selectControl(`${options.key}.unit`, options.unitLabel, unitOptions, unit);
  unitControl.el.classList.add('acquisition-time-unit');
  unitControl.disabled = options.disabled || unavailable;
  inputGroup.append(unlimitedValue, unitControl.el);
  body.append(sliderWrap, inputGroup);
  root.append(head, body);

  let unlimitedDraft = options.unlimited?.active === true;
  let finiteDraft = finiteValue ?? bounds.min;
  const setFieldInvalid = (invalid: boolean): void => {
    if (invalid) root.dataset.invalid = 'true';
    else delete root.dataset.invalid;
    if (number) {
      if (invalid) number.setAttribute('aria-invalid', 'true');
      else number.removeAttribute('aria-invalid');
    }
  };
  const syncRange = (updateNumber = true): void => {
    const position = Number(range.value);
    const unlimited = isUnlimitedTimeSlider(position, hasUnlimited);
    unlimitedDraft = unlimited;
    range.classList.toggle('is-unlimited', unlimited);
    range.style.setProperty('--acquisition-fill', `${Math.min(position, SLIDER_FINITE_MAX) / SLIDER_FINITE_MAX * 100}%`);
    unlimitedValue.hidden = !unlimited;
    if (number) {
      number.hidden = unlimited;
      if (updateNumber && !unlimited) {
        const value = timeValueFromSlider(position, bounds.min, bounds.finiteMax);
        if (value !== null) number.value = String(value);
      }
    }
    const aria = unlimited
      ? options.unlimited?.label ?? ''
      : number
        ? `${number.value} ${unit}`
        : timeSliderAriaValueText(position, bounds.min, bounds.finiteMax, unit);
    range.setAttribute('aria-valuetext', aria);
  };
  const commitValue = (value: number): void => {
    const clamped = Math.min(bounds.finiteMax, Math.max(bounds.min, value));
    finiteDraft = clamped;
    const position = timeValueToSlider(clamped, bounds.min, bounds.finiteMax);
    if (position !== null) range.value = String(position);
    setFieldInvalid(false);
    syncRange(false);
    if (number) number.value = String(clamped);
    range.setAttribute('aria-valuetext', `${clamped} ${unit}`);
    options.onValue(clamped, unit);
  };

  function ensureNumber(): HTMLInputElement {
    if (number) return number;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'acquisition-time-value';
    input.dataset.timeInput = options.key;
    input.min = String(bounds.min);
    input.max = String(bounds.finiteMax);
    input.step = '1';
    input.value = String(finiteDraft);
    input.disabled = options.disabled || unavailable;
    input.autocomplete = 'off';
    input.inputMode = 'numeric';
    input.setAttribute('aria-label', options.label);
    inputGroup.insertBefore(input, unlimitedValue);
    number = input;
    input.addEventListener('input', () => {
      const value = Number(input.value);
      const position = timeValueToSlider(value, bounds.min, bounds.finiteMax);
      if (position === null) {
        setFieldInvalid(true);
        return;
      }
      range.value = String(position);
      finiteDraft = Math.min(bounds.finiteMax, Math.max(bounds.min, value));
      setFieldInvalid(value < bounds.min || value > bounds.finiteMax);
      syncRange(false);
    });
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!isPositiveInteger(value)) {
        setFieldInvalid(true);
        input.reportValidity();
        return;
      }
      if (value < bounds.min || value > bounds.finiteMax) input.reportValidity();
      commitValue(value);
    });
    return input;
  }

  range.addEventListener('input', () => {
    if (!isUnlimitedTimeSlider(Number(range.value), hasUnlimited)) ensureNumber();
    setFieldInvalid(false);
    syncRange(true);
    if (!unlimitedDraft) {
      finiteDraft = timeValueFromSlider(Number(range.value), bounds.min, bounds.finiteMax) ?? finiteDraft;
    }
  });
  range.addEventListener('change', () => {
    if (isUnlimitedTimeSlider(Number(range.value), hasUnlimited)) {
      options.unlimited?.onSelect();
      return;
    }
    const value = timeValueFromSlider(Number(range.value), bounds.min, bounds.finiteMax);
    if (value !== null) commitValue(value);
  });

  unitControl.addEventListener('change', () => {
    if (!isTimeUnit(unitControl.value)) return;
    const nextUnit = timeUnitForRange(unitControl.value, options.minSeconds, options.maxSeconds) ?? unit;
    unitControl.value = nextUnit;
    if (unlimitedDraft && options.unlimited && !options.unlimited.active) {
      options.onUnit(nextUnit, null);
      options.unlimited.onSelect();
      return;
    }
    const nextValue = unlimitedDraft
      ? null
      : timeValueFromSeconds(options.seconds, nextUnit, options.minSeconds, options.maxSeconds);
    options.onUnit(nextUnit, nextValue);
  });
  if (!options.unlimited?.active) ensureNumber();
  setFieldInvalid(false);
  syncRange(false);
  return { el: root };
}
