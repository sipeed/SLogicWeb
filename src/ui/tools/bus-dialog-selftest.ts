// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Bus views (DESIGN §5.3): a section whose header carries one Add; Add and Edit open the
 * bus editor in a dialog; each bus row has exactly Edit and Remove (an analog bank,
 * Remove only); bit-order swap lives in the editor; the draft survives re-renders while
 * the dialog is open and the dialog closes when its bus disappears. Built on the fake DOM
 * (`fakeDom.ts`) and driven through clicks, `change` and the dialog's `cancel`.
 */

import { fakeEvent, installFakeDom, type FakeElement } from './fakeDom.js';
import { BusPanel, cloneBusConfig, defaultBusConfig, type BusPanelView } from '../busPanel.js';
import { analogBusConfig } from '../channelBanks.js';
import type { BusViewConfig, BusViewState } from '../busView.js';

interface FsLike { readFileSync(path: string, encoding: 'utf8'): string }
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
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

function state(id: string, cfg: BusViewConfig): BusViewState {
  return { ...cloneBusConfig(cfg), id, builder: null, builtFor: null, cache: null };
}

const plain = state('bus-1', { ...defaultBusConfig(16, 0), name: 'Data' });
const bank = state('bus-2', { ...analogBusConfig(8, 32, '#48C860'), name: 'A1' } as BusViewConfig);

interface Calls {
  add: BusViewConfig[];
  update: [string, BusViewConfig][];
  edit: string[];
  remove: string[];
  opened: number;
}

function setup(): { panel: BusPanel; root: FakeElement; calls: Calls } {
  doc.body.replaceChildren();
  const root = doc.createElement('div');
  root.className = 'side-page';
  doc.body.appendChild(root);
  const calls: Calls = { add: [], update: [], edit: [], remove: [], opened: 0 };
  const panel = new BusPanel(root as unknown as HTMLElement, {
    onAdd: (cfg) => calls.add.push(cfg),
    onUpdate: (id, cfg) => calls.update.push([id, cfg]),
    onEdit: (id) => calls.edit.push(id),
    onRemove: (id) => calls.remove.push(id),
    onOpenDialog: () => { calls.opened++; },
  });
  return { panel, root, calls };
}

const view = (buses: BusViewState[], patch: Partial<BusPanelView> = {}): BusPanelView =>
  ({ buses, channelCount: 32, testMode: 0, captureLocked: false, ...patch });
const dialog = (): FakeElement | null => doc.body.querySelector('dialog[data-bus-dialog]');
const nameInput = (): FakeElement | null =>
  dialog()?.querySelector('.bus-config-fields > .field > input') ?? null;
const buttonsOf = (row: FakeElement | null): string[] =>
  row ? row.children.filter((el) => el.localName === 'button').map((el) => el.textContent) : [];

// The section: one header Add, rows with exactly Edit + Remove, no inline editor.
{
  const { panel, root, calls } = setup();
  panel.render(view([plain, bank]));
  const head = root.querySelector('.panel-section-head');
  const headButtons = head?.children.filter((el) => el.localName === 'button') ?? [];
  const rowPlain = root.querySelector('[data-bus-row="bus-1"]');
  const rowBank = root.querySelector('[data-bus-row="bus-2"]');
  check('the Bus views header carries one Add at its right; there is no inline editor',
    head?.children[0]?.textContent === 'Bus views' && headButtons.length === 1 &&
      headButtons[0]?.dataset.busAdd === '' && head?.children.at(-1) === headButtons[0] &&
      headButtons[0]?.getAttribute('aria-haspopup') === 'dialog' &&
      root.querySelector('.bus-config-fields') === null && dialog() === null,
    `head=${head?.textContent}, buttons=${headButtons.length}`);
  check('a bus row has exactly Edit and Remove; an analog bank row has Remove only',
    JSON.stringify(buttonsOf(rowPlain)) === '["Edit","Remove"]' &&
      JSON.stringify(buttonsOf(rowBank)) === '["Remove"]' &&
      rowPlain?.querySelector('[data-bus-edit="bus-1"]')?.getAttribute('aria-label') === 'Edit Data' &&
      rowBank?.querySelector('[data-bus-remove="bus-2"]')?.getAttribute('aria-label') === 'Remove A1',
    `plain=${buttonsOf(rowPlain)}, bank=${buttonsOf(rowBank)}`);
  rowPlain?.querySelector('[data-bus-edit]')?.click();
  rowBank?.querySelector('[data-bus-remove]')?.click();
  check('row Edit asks the owner to edit (which opens the dialog); Remove removes',
    JSON.stringify(calls.edit) === '["bus-1"]' && JSON.stringify(calls.remove) === '["bus-2"]',
    `edit=${calls.edit}, remove=${calls.remove}`);
}

// Header Add opens the editor dialog.
{
  const { panel, root, calls } = setup();
  panel.render(view([plain]));
  const add = root.querySelector('[data-bus-add]')!;
  add.focus();
  add.click();
  const d = dialog();
  const fields = d?.querySelector('.bus-config-fields');
  const save = d?.querySelector('[data-bus-save]');
  check('Add opens a modal dialog with the bus editor, titled "Add a bus view"; menus close first',
    d !== null && d.open && panel.isOpen && calls.opened === 1 && fields !== null && fields !== undefined &&
      d.querySelector('h2')?.textContent === 'Add a bus view' && save?.textContent === 'Add' &&
      d.querySelector('[data-bus-cancel]') !== null && doc.activeElement === nameInput() &&
      d.querySelector('h2')?.id === d.getAttribute('aria-labelledby'),
    `open=${d?.open}, title=${d?.querySelector('h2')?.textContent}, opened=${calls.opened}`);

  // Type a name, then re-render (a capture finishing): the form is not rebuilt.
  const input = nameInput()!;
  input.value = 'Mine';
  input.dispatchEvent(fakeEvent('change'));
  panel.render(view([plain]));
  const same = nameInput() === input && input.value === 'Mine' && doc.activeElement === input;
  // A test-mode change rebuilds the form, but from the typed draft.
  panel.render(view([plain], { testMode: 1 }));
  const rebuilt = nameInput() !== input && nameInput()?.value === 'Mine' && panel.isOpen;
  check('the draft survives a re-render while the dialog is open (and a rebuild for a new test mode)',
    same && rebuilt, `same=${same}, rebuilt=${rebuilt}`);

  d!.querySelector('[data-bus-save]')!.click();
  // The opener was rebuilt by the re-renders: its successor takes the focus.
  check('Add applies the draft and closes the dialog, focus back on the header Add',
    calls.add.length === 1 && calls.add[0]?.name === 'Mine' && !panel.isOpen && !d!.open &&
      !add.isConnected && doc.activeElement === root.querySelector('[data-bus-add]'),
    `add=${calls.add.map((c) => c.name)}, open=${d?.open}`);
}

// Esc (the dialog's cancel) and Cancel close without applying.
{
  const { panel, root, calls } = setup();
  panel.render(view([plain]));
  const add = root.querySelector('[data-bus-add]')!;
  add.focus();
  add.click();
  const cancel = fakeEvent('cancel');
  dialog()!.dispatchEvent(cancel);
  const escClosed = !panel.isOpen && cancel.defaultPrevented && doc.activeElement === add;
  add.click();
  dialog()!.querySelector('[data-bus-cancel]')!.click();
  check('Esc/back and Cancel close the dialog without applying, focus back on the opener',
    escClosed && !panel.isOpen && calls.add.length === 0, `esc=${escClosed}`);
}

// Edit from the channel list opens the same dialog, prefilled; Save updates that bus.
{
  const { panel, root, calls } = setup();
  panel.render(view([plain, bank]));
  panel.edit(plain, view([plain, bank]));
  const d = dialog();
  const prefilled = d?.open === true && d.querySelector('h2')?.textContent === 'Edit Data' &&
    nameInput()?.value === 'Data' && d.querySelector('[data-bus-save]')?.textContent === 'Save' &&
    panel.editingId === 'bus-1';
  panel.edit(bank, view([plain, bank]));
  const bankRefused = panel.editingId === 'bus-1';

  // The explicit swap reverses the wiring and pins the order.
  const before = [...plain.spec.bits];
  d!.querySelector('[data-bus-swap]')!.click();
  d!.querySelector('[data-bus-save]')!.click();
  const [id, cfg] = calls.update[0] ?? [];
  check('edit() opens the dialog prefilled and titled by the bus; a bank is never offered the editor',
    prefilled && bankRefused, `prefilled=${prefilled}, bankRefused=${bankRefused}`);
  check('the editor\'s Swap MSB/LSB reverses the bits and pins the order; Save updates that bus',
    id === 'bus-1' && cfg !== undefined &&
      JSON.stringify(cfg.spec.bits) === JSON.stringify([...before].reverse()) &&
      cfg.bitOrder === 'lsb' && !panel.isOpen &&
      root.querySelector('[data-bus-edit="bus-1"]') !== null,
    `id=${id}, bits=${cfg?.spec.bits}, order=${cfg?.bitOrder}`);
}

// The dialog closes when its bus disappears.
{
  const { panel } = setup();
  panel.render(view([plain]));
  panel.edit(plain, view([plain]));
  const opened = panel.isOpen;
  panel.render(view([]));
  check('the editor closes when the bus it edits goes away', opened && !panel.isOpen && dialog()?.open === false,
    `opened=${opened}, open=${panel.isOpen}`);
}

// Stopping locks a bank's Remove, as before.
{
  const { panel, root } = setup();
  panel.render(view([plain, bank], { captureLocked: true }));
  const bankRemove = root.querySelector('[data-bus-remove="bus-2"]');
  const plainRemove = root.querySelector('[data-bus-remove="bus-1"]');
  check('while stopping, an analog bank cannot be removed; a plain bus view can',
    bankRemove?.disabled === true && plainRemove?.disabled === false, '');
}

// App wiring: the channel-list edit opens the dialog over any page.
{
  const fs = (nodeProcess.getBuiltinModule?.('node:fs') ?? null) as FsLike | null;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = app.indexOf('  private editBus(');
  const body = app.slice(start, app.indexOf('\n  }\n', start));
  const wired = body.includes('this.busPanel.edit(bus, this.busPanelView());') &&
    !body.includes("this.selectPanel('analyzers')") &&
    app.includes('onEdit: (id) => this.editBus(id),') &&
    app.includes('onEditBus: (id) => this.editBus(id),') &&
    app.includes('this.channelList.closeDialog();\n        },\n      });') &&
    app.includes("if (this.busPanel?.isOpen && !(this.sidebar.visible && this.sidebar.page === 'decoders')) {");
  check('App opens the editor from the channel list and the row, closes other overlays, and keeps it in sync off-page',
    wired, `wired=${wired}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed === 0 ? 'all' : results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
