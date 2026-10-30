// SPDX-License-Identifier: GPL-3.0-or-later

import { selectControl, type SelectOptionTuple } from './select.js';
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
  const min = minTimeValue(minSeconds, unit);
  const finiteMax = maxTimeValue(maxSeconds, unit);
  return {
    min,
    finiteMax,
    max: finiteMax + (unlimited ? 1 : 0),
    unlimitedValue: unlimited ? finiteMax + 1 : null,
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
  const bounds = timeSliderBounds(
    options.minSeconds, options.maxSeconds, unit, options.unlimited !== undefined,
  );
  const finiteValue = timeValueFromSeconds(options.seconds, unit, options.minSeconds, options.maxSeconds);
  const unavailable = finiteValue === null || bounds.finiteMax < bounds.min;
  const root = document.createElement('div');
  root.className = 'acquisition-time';
  root.dataset.timeControl = options.key;

  const head = document.createElement('div');
  head.className = 'acquisition-time-head';
  const label = document.createElement('span');
  label.className = 'acquisition-time-label';
  label.textContent = options.label;
  const unitOptions: SelectOptionTuple[] = TIME_UNITS.map((candidate) => [candidate, candidate]);
  const unitControl = selectControl(`${options.key}.unit`, options.unitLabel, unitOptions, unit);
  unitControl.el.classList.add('acquisition-time-unit');
  unitControl.disabled = options.disabled || unavailable;
  head.append(label, unitControl.el);

  const body = document.createElement('div');
  body.className = 'acquisition-time-body' + (options.unlimited ? ' has-unlimited' : '');
  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'acquisition-time-slider';
  range.dataset.timeSlider = options.key;
  range.min = String(bounds.min);
  range.max = String(bounds.max);
  range.step = '1';
  range.value = String(options.unlimited?.active
    ? bounds.unlimitedValue ?? bounds.finiteMax
    : finiteValue ?? bounds.min);
  range.disabled = options.disabled || unavailable;
  range.setAttribute('aria-label', options.label);
  if (bounds.unlimitedValue !== null) range.dataset.unlimitedValue = String(bounds.unlimitedValue);
  body.appendChild(range);

  let number: HTMLInputElement | null = null;
  if (!options.unlimited?.active) {
    number = document.createElement('input');
    number.type = 'number';
    number.className = 'acquisition-time-value';
    number.dataset.timeInput = options.key;
    number.min = String(bounds.min);
    number.max = String(bounds.finiteMax);
    number.step = '1';
    number.value = String(finiteValue ?? 0);
    number.disabled = options.disabled || unavailable;
    number.autocomplete = 'off';
    number.inputMode = 'numeric';
    number.setAttribute('aria-label', options.label);
    body.appendChild(number);
  }

  if (options.unlimited) {
    const marker = document.createElement('span');
    marker.className = 'acquisition-time-unlimited';
    marker.dataset.timeUnlimited = options.key;
    marker.textContent = '∞';
    marker.title = options.unlimited.label;
    body.appendChild(marker);
  }
  root.append(head, body);

  const syncRange = (): void => {
    const unlimited = bounds.unlimitedValue !== null && Number(range.value) === bounds.unlimitedValue;
    range.setAttribute('aria-valuetext', unlimited ? options.unlimited!.label : `${range.value} ${unit}`);
    if (number) {
      number.hidden = unlimited;
      if (!unlimited) number.value = range.value;
    }
  };
  const commitValue = (value: number): void => {
    const clamped = Math.min(bounds.finiteMax, Math.max(bounds.min, value));
    range.value = String(clamped);
    if (number) number.value = String(clamped);
    syncRange();
    options.onValue(clamped, unit);
  };
  range.addEventListener('input', syncRange);
  range.addEventListener('change', () => {
    if (bounds.unlimitedValue !== null && Number(range.value) === bounds.unlimitedValue) {
      options.unlimited?.onSelect();
      return;
    }
    commitValue(Number(range.value));
  });

  if (number) {
    number.addEventListener('input', () => {
      const value = Number(number.value);
      if (!isPositiveInteger(value)) {
        number.setAttribute('aria-invalid', 'true');
        return;
      }
      number.removeAttribute('aria-invalid');
      range.value = String(Math.min(bounds.finiteMax, Math.max(bounds.min, value)));
      range.setAttribute('aria-valuetext', `${range.value} ${unit}`);
    });
    number.addEventListener('change', () => {
      const value = Number(number.value);
      if (!isPositiveInteger(value)) {
        number.setAttribute('aria-invalid', 'true');
        number.reportValidity();
        return;
      }
      commitValue(value);
    });
  }

  unitControl.addEventListener('change', () => {
    if (!isTimeUnit(unitControl.value)) return;
    const nextUnit = timeUnitForRange(unitControl.value, options.minSeconds, options.maxSeconds) ?? unit;
    const nextValue = options.unlimited?.active
      ? null
      : timeValueFromSeconds(options.seconds, nextUnit, options.minSeconds, options.maxSeconds);
    options.onUnit(nextUnit, nextValue);
  });
  syncRange();
  return { el: root };
}
