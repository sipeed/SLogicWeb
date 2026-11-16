// SPDX-License-Identifier: GPL-3.0-or-later

import { fakeEvent, installFakeDom, type FakeElement } from './fakeDom.js';
import { t, type MessageKey } from '../i18n.js';
import { MEASUREMENT_CATALOG } from '../measurementCatalog.js';
import {
  MeasurementCatalogDialog, measurementCatalogView,
} from '../measurementCatalogDialog.js';
import type { MeasurementRow } from '../measurementRows.js';
import type { MeasurementSectionView, MeasurementSource } from '../measurementState.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const doc = installFakeDom();

const A0: MeasurementSource = { group: 0, start: 0, gain: 1, name: 'A0' };
const A2: MeasurementSource = { group: 2, start: 16, gain: 3, name: 'A2' };

function catalogRow(
  over: Partial<MeasurementRow> = {},
): MeasurementRow {
  return { id: 1, start: 16, parameter: 'vpp', ...over };
}

function sectionView(over: Partial<MeasurementSectionView> = {}): MeasurementSectionView {
  return {
    sources: [],
    filter: null,
    range: { kind: 'viewport', a: null, b: null },
    cursors: [],
    rows: [],
    allRows: [],
    rowCount: 0,
    undoCount: null,
    addStart: null,
    window: null,
    unavailable: null,
    ...over,
  };
}

interface Calls {
  toggles: [number, string][];
  picks: number[];
}

interface Harness {
  dialog: MeasurementCatalogDialog;
  invoker: FakeElement;
  calls: Calls;
  open: FakeElement;
  done: () => FakeElement | null;
  rows: () => FakeElement[];
  checks: () => FakeElement[];
  headings: () => string[];
  trigger: () => FakeElement | null;
  params: () => string[];
}

function setup(): Harness {
  doc.body.replaceChildren();
  const invoker = doc.createElement('button');
  invoker.dataset.measureOpen = '';
  doc.body.appendChild(invoker);
  const calls: Calls = { toggles: [], picks: [] };
  const dialog = new MeasurementCatalogDialog({
    onToggle: (start, parameter) => calls.toggles.push([start, parameter]),
    onPickSource: (start) => calls.picks.push(start),
  });
  const open = doc.body.querySelector('dialog[data-measure-catalog]')!;
  return {
    dialog,
    invoker,
    calls,
    open,
    done: () => open.querySelector('[data-measure-catalog-done]'),
    rows: () => open.querySelectorAll('.measure-catalog-row'),
    checks: () => open.querySelectorAll('.measure-catalog-check'),
    headings: () => open.querySelectorAll('.shortcuts-section').map((el) => el.textContent),
    trigger: () => open.querySelector('.select-trigger'),
    params: () => open.querySelectorAll('.measure-catalog-param').map((el) => el.textContent),
  };
}

const view = (over: Partial<{
  sources: readonly MeasurementSource[];
  start: number | null;
  rows: readonly MeasurementRow[];
}> = {}) => ({
  sources: [A0, A2] as readonly MeasurementSource[],
  start: 16,
  rows: [] as readonly MeasurementRow[],
  ...over,
});

{
  const h = setup();
  h.dialog.open(view({ rows: [catalogRow({ start: 16, parameter: 'vpp' })] }), h.invoker as unknown as HTMLElement);
  const title = h.open.querySelector('h2');
  const body = h.open.querySelector('.measure-catalog-body');
  check('the catalog is one modal dialog with the approved anatomy and title',
    h.open.open === true && h.dialog.isOpen &&
      h.open.className === 'shortcuts-dialog measure-catalog-dialog' &&
      title?.textContent === 'Add measurements' &&
      title?.id === h.open.getAttribute('aria-labelledby') &&
      h.done()?.textContent === 'Done' &&
      h.open.querySelector('.shortcuts-form') !== null &&
      h.open.querySelector('.shortcuts-actions') !== null &&
      body !== null && body.children[0]?.className === 'measure-catalog-source' &&
      body.children[1]?.className === 'measure-catalog-list',
    `open=${h.open.open}, title=${title?.textContent}, done=${h.done()?.textContent}`);

  const present = h.checks().length;
  const groups = h.headings();
  check('eight catalog parameters in two groups, in catalog order, each with its own method sentence',
    present === 8 && groups.length === 2 &&
      groups[0] === 'Vertical' && groups[1] === 'Horizontal' &&
      JSON.stringify(h.params()) === JSON.stringify([
        'Vpp', 'Max', 'Min', 'Mean', 'RMS', 'Frequency', 'Period', 'Duty',
      ]) &&
      MEASUREMENT_CATALOG.length === 8 &&
      h.open.querySelectorAll('.measure-catalog-method').length === 8 &&
      h.open.querySelectorAll('.measure-catalog-method')
        .every((el) => el.textContent !== '' && !el.textContent.includes('{')),
    `checks=${present}, groups=${JSON.stringify(groups)}, params=${JSON.stringify(h.params())}`);

  check('one group block per heading, holding that group\'s parameters only',
    h.open.querySelectorAll('.measure-catalog-group').length === 2 &&
      h.open.querySelectorAll('.measure-catalog-group')[0]?.querySelectorAll('.measure-catalog-row').length === 5 &&
      h.open.querySelectorAll('.measure-catalog-group')[1]?.querySelectorAll('.measure-catalog-row').length === 3,
    `blocks=${h.open.querySelectorAll('.measure-catalog-group').length}`);
}

{
  const h = setup();
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  const method = (parameter: string): string =>
    h.checks()
      .find((input) => input.dataset.measureParameter === parameter)
      ?.closest('.measure-catalog-row')
      ?.querySelector('.measure-catalog-method')?.textContent ?? '';
  const methods = h.open.querySelectorAll('.measure-catalog-method').map((el) => el.textContent);
  const liveMethod = t('capturePanel.measureMethodFrequency', { count: 0 });
  check('no catalog sentence renders a live count, so no "0 qualified" text can appear',
    methods.length === 8 &&
      methods.every((text) => text !== '' && !text.includes('{') && !text.includes('0 ')),
    `methods=${JSON.stringify(methods)}, live=${liveMethod}`);
  check('the dialog states each horizontal method without the crossing and period counts',
    method('frequency') === 'mean period of qualified crossings' &&
      method('period') === 'mean qualified-crossing interval, in seconds' &&
      method('duty') === 'known samples at or above the level over complete qualified periods' &&
      !methods.includes(liveMethod),
    `frequency=${method('frequency')}, period=${method('period')}, duty=${method('duty')}`);
  const overridden = MEASUREMENT_CATALOG
    .filter((entry) => entry.descriptionKey !== entry.methodKey)
    .map((entry) => entry.parameter);
  check('the dialog copy is a separate catalog key from the counted row status text',
    overridden.join(',') === 'frequency,period,duty' &&
      MEASUREMENT_CATALOG.every((entry) => !t(entry.descriptionKey as MessageKey).includes('{')) &&
      t('capturePanel.measureMethodFrequency', { count: 6 }) ===
        'mean period of 6 qualified crossings' &&
      method('vpp') === t('capturePanel.measureMethodVpp'),
    `overridden=${JSON.stringify(overridden)}, ` +
      `counted=${t('capturePanel.measureMethodFrequency', { count: 6 })}`);
}

{
  const h = setup();
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  const trigger = h.trigger();
  const options = h.open.querySelectorAll('.select-item-label').map((el) => el.textContent);
  check('the source select lists every measurement source and starts selected on the dialog source',
    trigger !== null && trigger.dataset.selectKey === 'measure.catalogSource' &&
      trigger.querySelector('.select-value')?.textContent === 'A2' &&
      JSON.stringify(options) === JSON.stringify(['A0', 'A2']) &&
      h.open.querySelector('.measure-catalog-source > .field > label')?.textContent === 'Source' &&
      doc.activeElement === trigger,
    `value=${trigger?.querySelector('.select-value')?.textContent}, options=${JSON.stringify(options)}`);

  const invokerOnly = measurementCatalogView(sectionView({
    sources: [A0, A2], addStart: null, allRows: [catalogRow()],
  }));
  const noSources = measurementCatalogView(sectionView());
  check('the view projection prefers the add target, then the first source, and names no source when empty',
    measurementCatalogView(sectionView({ sources: [A0, A2], addStart: 0 })).start === 0 &&
      invokerOnly.start === 0 && invokerOnly.rows.length === 1 &&
      noSources.start === null && noSources.rows.length === 0,
    `addTarget=${measurementCatalogView(sectionView({ sources: [A0, A2], addStart: 0 })).start}, ` +
      `first=${invokerOnly.start}, empty=${String(noSources.start)}`);
}

{
  const h = setup();
  h.dialog.open(view({
    rows: [catalogRow({ start: 0, parameter: 'frequency' }), catalogRow({ start: 16, parameter: 'vpp' })],
  }), h.invoker as unknown as HTMLElement);
  const checked = h.checks().map((input) => input.checked);
  const byParam = (parameter: string): FakeElement | undefined =>
    h.checks().find((input) => input.dataset.measureParameter === parameter);
  check('the checkboxes read the rows of the dialog source only, never another source',
    byParam('vpp')?.checked === true && byParam('frequency')?.checked === false &&
      byParam('duty')?.checked === false &&
      checked.filter(Boolean).length === 1,
    `checked=${JSON.stringify(checked)}`);

  const input = byParam('duty')!;
  input.focus();
  input.checked = true;
  input.dispatchEvent(fakeEvent('change'));
  check('toggling a parameter emits exactly its source and parameter and keeps the dialog open',
    h.calls.toggles.length === 1 &&
      JSON.stringify(h.calls.toggles[0]) === '[16,"duty"]' &&
      h.open.open === true && doc.activeElement === input && h.calls.picks.length === 0,
    `toggles=${JSON.stringify(h.calls.toggles)}, open=${h.open.open}`);

  const before = h.calls.toggles.length;
  h.dialog.update(view({
    rows: [catalogRow({ start: 16, parameter: 'vpp' }), catalogRow({ start: 16, parameter: 'duty' })],
  }));
  check('a state refresh re-reads the rows without emitting anything or rebuilding the controls',
    h.calls.toggles.length === before && byParam('duty')?.checked === true &&
      h.checks().length === 8 && h.open.querySelector('.measure-catalog-check') === byParam('vpp'),
    `toggles=${h.calls.toggles.length}, checked=${byParam('duty')?.checked}`);
}

{
  const h = setup();
  h.dialog.open(view({
    rows: [catalogRow({ start: 0, parameter: 'frequency' }), catalogRow({ start: 16, parameter: 'vpp' })],
  }), h.invoker as unknown as HTMLElement);
  const byParam = (parameter: string): FakeElement | undefined =>
    h.checks().find((input) => input.dataset.measureParameter === parameter);
  const item = h.open.querySelectorAll('.select-item')
    .find((el) => el.querySelector('.select-item-label')?.textContent === 'A0');
  item?.click();
  check('picking another source asks App for that source and re-reads the checkboxes for it',
    JSON.stringify(h.calls.picks) === '[0]' &&
      h.open.open === true && h.trigger()?.querySelector('.select-value')?.textContent === 'A0' &&
      byParam('frequency')?.checked === true && byParam('vpp')?.checked === false &&
      h.calls.toggles.length === 0,
    `picks=${JSON.stringify(h.calls.picks)}, ` +
      `frequency=${byParam('frequency')?.checked}, vpp=${byParam('vpp')?.checked}`);

  const picked = h.open.querySelectorAll('.select-item')
    .find((el) => el.querySelector('.select-item-label')?.textContent === 'A0');
  picked?.click();
  check('re-picking the shown source is a no-op for App',
    JSON.stringify(h.calls.picks) === '[0]', `picks=${JSON.stringify(h.calls.picks)}`);
}

{
  const h = setup();
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  const other = doc.createElement('dialog');
  other.dataset.otherDialog = '';
  doc.body.appendChild(other);
  other.showModal();
  const cancel = fakeEvent('cancel');
  h.open.dispatchEvent(cancel);
  const escClosed = h.open.open === false && cancel.defaultPrevented &&
    doc.activeElement === h.invoker;
  const scoped = other.open === true;
  other.remove();
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  h.done()?.click();
  check('Escape and Done close the dialog and return focus to the Add button',
    escClosed && scoped && h.open.open === false && !h.dialog.isOpen &&
      doc.activeElement === h.invoker && h.calls.toggles.length === 0 &&
      h.calls.picks.length === 0,
    `esc=${escClosed}, otherOpen=${scoped}, doneFocus=${doc.activeElement === h.invoker}, ` +
      `open=${h.open.open}`);

  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  const backdrop = fakeEvent('pointerdown');
  backdrop.target = h.open;
  h.open.dispatchEvent(backdrop);
  const backdropClosed = h.open.open === false && backdrop.defaultPrevented;
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  const inside = fakeEvent('pointerdown');
  inside.target = h.rows()[0] ?? null;
  h.open.dispatchEvent(inside);
  check('the backdrop closes, a press inside the dialog does not',
    backdropClosed && h.open.open === true && !inside.defaultPrevented,
    `backdrop=${backdropClosed}, insideOpen=${h.open.open}`);
}

{
  const h = setup();
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  h.invoker.remove();
  const rebuilt = doc.createElement('button');
  rebuilt.dataset.measureOpen = '';
  doc.body.appendChild(rebuilt);
  h.dialog.close();
  check('a rebuilt panel cannot lose the focus target: close falls back to the current Add button',
    doc.activeElement === rebuilt, `focus=${doc.activeElement?.className || doc.activeElement?.localName}`);

  const second = setup();
  second.dialog.open(view(), second.invoker as unknown as HTMLElement);
  const opened = second.open;
  second.invoker.remove();
  const fresh = doc.createElement('button');
  fresh.dataset.measureOpen = '';
  doc.body.appendChild(fresh);
  second.dialog.update(view({
    rows: [catalogRow({ start: 16, parameter: 'vpp' }),
      catalogRow({ start: 16, parameter: 'duty' })],
  }));
  const survived = second.open.open === true && second.open === opened &&
    doc.body.querySelectorAll('dialog').length === 1 &&
    second.open.contains(doc.activeElement);
  const refreshed = second.checks().filter((input) => input.checked)
    .map((input) => input.dataset.measureParameter);
  second.dialog.close();
  check('a panel rebuild keeps the same open dialog, refreshes its checks and focuses the rebuilt opener',
    survived && refreshed.join(',') === 'vpp,duty' && doc.activeElement === fresh,
    `survived=${survived}, same=${second.open === opened}, ` +
      `dialogs=${doc.body.querySelectorAll('dialog').length}, ` +
      `checked=${JSON.stringify(refreshed)}, focusRebuilt=${doc.activeElement === fresh}`);
}

{
  const h = setup();
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  const vpp = h.checks().find((input) => input.dataset.measureParameter === 'vpp')!;
  vpp.focus();
  h.dialog.update(view({ sources: [A0] }));
  const rebuilt = h.checks().find((input) => input.dataset.measureParameter === 'vpp');
  check('a source-set rebuild keeps the dialog open and restores focus to the same parameter',
    h.open.open === true && rebuilt !== undefined && rebuilt !== vpp &&
      doc.activeElement === rebuilt &&
      h.trigger()?.querySelector('.select-value')?.textContent === 'A0',
    `open=${h.open.open}, focus=${doc.activeElement === rebuilt}, ` +
      `source=${h.trigger()?.querySelector('.select-value')?.textContent}`);

  const title = h.open.querySelector('h2')!;
  title.textContent = 'stale copy';
  h.dialog.update(view({ sources: [A0] }));
  check('a locale change retranslates the open dialog instead of leaving the old copy up',
    title.textContent === 'Add measurements' && h.open.open === true &&
      h.done()?.textContent === 'Done' && h.checks().length === 8,
    `title=${title.textContent}, open=${h.open.open}`);

  const space = h.open.querySelector('.measure-catalog-check')!;
  const stop = fakeEvent('keydown', { key: ' ' });
  space.dispatchEvent(stop);
  const passthrough = fakeEvent('keydown', { key: 'Tab' });
  space.dispatchEvent(passthrough);
  check('Space on a checkbox never reaches the plot shortcut handler',
    stop.propagationStopped && !passthrough.propagationStopped,
    `space=${stop.propagationStopped}, tab=${passthrough.propagationStopped}`);
}

{
  const h = setup();
  const closed = h.open.contains(doc.activeElement);
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  const entry = h.open.contains(doc.activeElement) && doc.activeElement === h.trigger();
  const escapeKey = fakeEvent('keydown', { key: 'Escape' });
  h.open.dispatchEvent(escapeKey);
  const keyInert = h.open.open === true && !escapeKey.propagationStopped;
  h.dialog.close();
  const closedAgain = h.open.open === false && doc.activeElement === h.invoker;
  h.dialog.close();
  const idleClose = h.open.open === false && doc.activeElement === h.invoker;
  h.dialog.open(view(), h.invoker as unknown as HTMLElement);
  check('focus starts inside the modal, only the dialog\'s own cancel closes it, reopening re-enters it',
    !closed && entry && keyInert && closedAgain && idleClose &&
      doc.activeElement === h.trigger() && h.open.contains(doc.activeElement),
    `entry=${entry}, keyDownCloses=${!keyInert}, afterClose=${closedAgain}, ` +
      `idleClose=${idleClose}, reopened=${doc.activeElement === h.trigger()}`);
}

{
  const h = setup();
  h.dialog.open(view({ sources: [] }), h.invoker as unknown as HTMLElement);
  check('a session with no analog group opens with no options and disabled controls',
    h.checks().length === 8 && h.checks().every((input) => input.disabled) &&
      h.open.querySelectorAll('.select-item').length === 0 && h.open.open === true &&
      h.trigger()?.disabled === true &&
      h.open.contains(doc.activeElement) && doc.activeElement === h.done(),
    `disabled=${h.checks().filter((input) => input.disabled).length}, ` +
      `trigger=${h.trigger()?.disabled}, focusInside=${h.open.contains(doc.activeElement)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
