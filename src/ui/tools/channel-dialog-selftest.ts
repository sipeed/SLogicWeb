// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A channel card's read-only name and its one settings dialog: the gear opens the modal
 * over name, trigger mode and colour, Save emits exactly one `onConfigure`, and Cancel,
 * Escape and a backdrop press emit nothing. Built on the fake DOM (`fakeDom.ts`) and
 * driven the way the card listens: button clicks, the form's `submit`, the dialog's
 * `cancel` and `pointerdown`.
 */

import { fakeEvent, installFakeDom, type FakeElement } from './fakeDom.js';
import {
  ChannelList, type BusCell, type ChannelCell, type ChannelConfiguration,
} from '../channelList.js';
import { setLocale, t } from '../i18n.js';
import { CHANNEL_COLOR_PRESETS } from '../metrics.js';
import {
  channelColor, defaultChannelName, type AnalyzerState, type ChannelState, type TriggerMode,
} from '../state.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const doc = installFakeDom();
(globalThis as Record<string, unknown>)['window'] = { innerWidth: 1200, innerHeight: 800 };

interface CellOptions {
  name?: string;
  mode?: TriggerMode;
  armed?: boolean;
  disabled?: boolean;
  color?: string;
}

function makeCell(index: number, options: CellOptions = {}): ChannelCell {
  const channel: ChannelState = {
    index,
    name: options.name ?? defaultChannelName(index),
    color: options.color ?? channelColor(index),
    enabled: true,
  };
  return {
    channel,
    heightCss: 72,
    laneCss: 0,
    analyzers: [],
    trigger: {
      mode: options.mode ?? 'dont-care',
      armed: options.armed ?? false,
      disabled: options.disabled ?? false,
    },
  };
}

const analyzerState = (id: string, label: string): AnalyzerState => ({
  id,
  decoderId: 'i2c',
  label,
  color: '#9A7B2E',
  channels: { 0: 0, 1: 1 },
  options: {},
  laneChannel: 0,
  result: null,
  index: null,
  status: 'idle',
  note: { kind: 'pending' },
});

interface Calls {
  configure: [number, ChannelConfiguration][];
  reorder: [number, number][];
}

interface Harness {
  list: ChannelList;
  root: FakeElement;
  calls: Calls;
  render(cells: readonly ChannelCell[]): void;
  renderBuses(cells: readonly BusCell[]): void;
}

function setup(cells: readonly ChannelCell[]): Harness {
  doc.body.replaceChildren();
  const root = doc.createElement('div');
  root.className = 'channel-list';
  doc.body.appendChild(root);
  const calls: Calls = { configure: [], reorder: [] };
  let current = [...cells];
  const list: ChannelList = new ChannelList(root as unknown as HTMLElement, {
    onConfigure: (index, config) => {
      calls.configure.push([index, config]);
      current = current.map((cell) => (cell.channel.index === index
        ? {
          ...cell,
          channel: {
            ...cell.channel,
            name: config.name.trim() || defaultChannelName(index),
            color: config.color,
          },
          trigger: { ...cell.trigger, mode: config.mode },
        }
        : cell));
      list.render(current);
    },
    onReorder: (from, to) => calls.reorder.push([from, to]),
  });
  const harness: Harness = {
    list,
    root,
    calls,
    render: (next) => { current = [...next]; list.render(current); },
    renderBuses: (buses) => list.renderBuses(buses),
  };
  harness.render(current);
  return harness;
}

const settingsDialog = (): FakeElement | null =>
  doc.body.querySelector('dialog.channel-settings-dialog');
const form = (): FakeElement | null => settingsDialog()?.querySelector('.channel-settings-form') ?? null;
const titleOf = (): string | null => settingsDialog()?.querySelector('h2')?.textContent ?? null;
const nameInput = (): FakeElement | null => settingsDialog()?.querySelector('.channel-settings-name') ?? null;
const triggerSet = (): FakeElement | null => settingsDialog()?.querySelector('.channel-trigger-options') ?? null;
const radios = (): FakeElement[] =>
  settingsDialog()?.querySelectorAll('.channel-trigger-option input') ?? [];
const checkedMode = (): string => radios().filter((r) => r.checked).map((r) => r.value).join(',');
const save = (): FakeElement | null => settingsDialog()?.querySelector('.channel-settings-actions .primary') ?? null;
const cancel = (): FakeElement | null => settingsDialog()?.querySelector('.channel-settings-cancel') ?? null;
const colorReset = (): FakeElement | null =>
  settingsDialog()?.querySelector('.channel-color-palette .channel-name-reset') ?? null;
const nameReset = (): FakeElement | null =>
  settingsDialog()?.querySelector('.channel-settings-name-control .channel-name-reset') ?? null;
const presets = (): FakeElement[] => settingsDialog()?.querySelectorAll('.channel-color-preset') ?? [];
const presetOf = (color: string): FakeElement | null =>
  presets().find((el) => el.title.toLowerCase() === color.toLowerCase()) ?? null;
const gear = (root: FakeElement, channel: number): FakeElement | null =>
  root.querySelector(`.ch-settings[data-channel="${channel}"]`);
const preview = (root: FakeElement): FakeElement | null =>
  root.querySelector('.ch-trigger-preview');
const actions = (root: FakeElement): FakeElement | null => root.querySelector('.ch-actions');
const popover = (): FakeElement | null => doc.body.querySelector('.ch-editor-popover');

function submit(): void {
  form()?.dispatchEvent(fakeEvent('submit'));
}
function chooseMode(mode: TriggerMode): void {
  for (const radio of radios()) radio.checked = radio.value === mode;
}

// The head is read-only name, D-index and trigger preview, the gear opens the dialog on
// its name field from the body's actions column.
{
  const h = setup([makeCell(0, { name: 'CLK', mode: 'rising' }), makeCell(1)]);
  const head = h.root.querySelector('.ch-head');
  const kids = head?.children ?? [];
  const column = actions(h.root)?.children ?? [];
  const readOnly = kids[0]?.className === 'ch-tag ch-tag--name' && kids[0]?.textContent === 'CLK' &&
    !(kids[0]?.className ?? '').includes('ch-tag--editable') &&
    kids[0]?.getAttribute('role') === null && kids[0]?.getAttribute('contenteditable') === null;
  kids[0]?.dispatchEvent(fakeEvent('dblclick'));
  kids[0]?.dispatchEvent(fakeEvent('keydown', { key: 'F2' }));
  kids[0]?.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }));
  const noInlineEntry = h.root.querySelectorAll('input').length === 0 &&
    settingsDialog()?.open === false;
  const order = kids.length === 2 &&
    kids[1]?.className === 'ch-original-id' && kids[1]?.textContent === 'D0' &&
    kids[1]?.hidden === false &&
    column.length === 2 &&
    column[0]?.localName === 'button' && column[0]?.className === 'ch-settings' &&
    column[1]?.localName === 'span' &&
    column[1]?.className === 'ch-trigger-preview configured';
  check('a channel head renders a read-only name and the D-index; the gear then the trigger preview sit in the actions column',
    readOnly && noInlineEntry && order,
    `readOnly=${readOnly}, inlineEntry=${!noInlineEntry}, order=${order}, ` +
    `kids=${kids.map((k) => k.className).join('|')}, ` +
    `actions=${column.map((k) => k.className).join('|')}`);

  const opener = gear(h.root, 0);
  opener?.click();
  const opened = settingsDialog()?.open === true && titleOf() === 'D0 settings' &&
    nameInput()?.value === 'CLK' && doc.activeElement === nameInput() && nameReset() !== null &&
    opener?.getAttribute('aria-haspopup') === 'dialog' &&
    opener?.getAttribute('aria-label') === 'D0 settings';
  check('the gear opens the dialog focused on the channel name, prefilled and titled by index',
    opened,
    `open=${settingsDialog()?.open}, title=${titleOf()}, value=${nameInput()?.value}, ` +
    `focused=${doc.activeElement === nameInput()}, label=${opener?.getAttribute('aria-label')}`);
}

{
  const h = setup([{ ...makeCell(0), analyzers: [
    analyzerState('i2c-0', 'I2C-1'), analyzerState('i2c-1', 'I2C-2'),
  ] }]);
  const chipShapes = h.root.querySelectorAll('.ch-analyzer').map((chip) =>
    `${chip.children.map((kid) => kid.className || kid.localName).join('+')}:` +
    `${chip.children[1]?.textContent}:${chip.children.length}`);
  const chipButtons = h.root.querySelectorAll('.ch-analyzer button').length;
  check('a decoder chip is a colour square plus its name and offers no removal control',
    chipShapes.length === 2 &&
    chipShapes[0] === 'ch-analyzer-sq+span:I2C-1:2' && chipShapes[1] === 'ch-analyzer-sq+span:I2C-2:2' &&
    chipButtons === 0,
    `chips=${JSON.stringify(chipShapes)}, buttons=${chipButtons}`);
}

// The trigger glyph is a preview, not an entry: clicking it opens nothing, and the gear
// stays the one way into the dialog.
{
  const h = setup([makeCell(0, { name: 'CLK', mode: 'falling' })]);
  const glyph = preview(h.root);
  glyph?.click();
  const inert = glyph !== null && glyph.localName === 'span' &&
    glyph.getAttribute('role') === 'img' &&
    glyph.getAttribute('aria-haspopup') === null &&
    glyph.getAttribute('tabindex') === null &&
    !('tabIndex' in glyph) &&
    glyph.title === 'Trigger: Falling edge' &&
    glyph.getAttribute('aria-label') === 'Trigger: Falling edge' &&
    settingsDialog()?.open === false && h.calls.configure.length === 0;
  gear(h.root, 0)?.click();
  const gearOnly = settingsDialog()?.open === true && doc.activeElement === nameInput() &&
    nameInput()?.value === 'CLK' && checkedMode() === 'falling';
  check('the row trigger is a read-only preview; the gear is the one way into the dialog',
    inert && gearOnly,
    `inert=${inert}, open=${settingsDialog()?.open}, checked=${checkedMode()}, ` +
    `focused=${doc.activeElement === nameInput()}, label=${glyph?.getAttribute('aria-label')}`);
}

// An unset trigger renders no preview element at all, so nothing can be mistaken for a
// control; the actions column keeps the gear alone.
{
  const h = setup([makeCell(0, { mode: 'dont-care' })]);
  const kids = h.root.querySelector('.ch-head')?.children ?? [];
  const column = actions(h.root)?.children ?? [];
  const absent = preview(h.root) === null &&
    h.root.querySelectorAll('.ch-trigger-preview').length === 0 &&
    kids.length === 2 &&
    kids[0]?.className === 'ch-tag ch-tag--name' && kids[0]?.textContent === 'D0' &&
    kids[1]?.className === 'ch-original-id' && kids[1]?.textContent === 'D0' &&
    column.length === 1 && column[0]?.localName === 'button' &&
    column[0]?.className === 'ch-settings';
  check('a dont-care row renders no trigger preview and the actions column still holds the gear',
    absent, `kids=${kids.map((k) => k.className).join('|')}, ` +
    `actions=${column.map((k) => k.className).join('|')}, ` +
    `preview=${preview(h.root) !== null}`);
}

// Every pointer and key path over the preview is inert: no dialog, no callback.
{
  const h = setup([makeCell(0, { name: 'CLK', mode: 'edge' })]);
  const glyph = preview(h.root);
  glyph?.dispatchEvent(fakeEvent('pointerdown'));
  glyph?.dispatchEvent(fakeEvent('mousedown'));
  glyph?.dispatchEvent(fakeEvent('keydown', { key: 'Enter' }));
  glyph?.click();
  const idle = glyph !== null && settingsDialog()?.open === false &&
    doc.activeElement === doc.body &&
    h.calls.configure.length === 0 && h.calls.reorder.length === 0;
  check('the trigger preview ignores pointer and key input and emits nothing',
    idle, `open=${settingsDialog()?.open}, focused=${doc.activeElement?.className}, ` +
    `configure=${h.calls.configure.length}, reorder=${h.calls.reorder.length}`);
}

// The state class follows the cell's armed flag across a re-render, and the accessible
// label is composed from the catalog rather than stored as text.
{
  const h = setup([makeCell(0, { mode: 'high', armed: true })]);
  const armed = preview(h.root);
  const armedState = armed?.className === 'ch-trigger-preview armed';
  h.render([makeCell(0, { mode: 'high' })]);
  const configured = preview(h.root);
  const configuredState = armed !== null && configured !== null && configured !== armed &&
    armed.isConnected === false && configured.isConnected === true &&
    configured.className === 'ch-trigger-preview configured';
  const english = t('channels.triggerPreview', { mode: t('channels.triggerHigh') });
  const labelled = configured?.title === english &&
    configured?.getAttribute('aria-label') === english;
  check('the preview class follows the cell\'s armed flag across a re-render and names the mode',
    armedState && configuredState && labelled,
    `armed=${armed?.className}, configured=${configured?.className}, ` +
    `title=${configured?.title}`);

  const rootLang = { lang: '' };
  (doc as unknown as { documentElement?: typeof rootLang }).documentElement = rootLang;
  await setLocale('zh-CN');
  h.render([makeCell(0, { mode: 'high', armed: true })]);
  const translated = preview(h.root);
  const zh = t('channels.triggerPreview', { mode: t('channels.triggerHigh') });
  const localized = translated !== null && zh !== english &&
    translated.title === zh && translated.getAttribute('aria-label') === zh &&
    translated.className.startsWith('ch-trigger-preview ') && rootLang.lang === 'zh-CN';
  await setLocale('en');
  delete (doc as unknown as { documentElement?: typeof rootLang }).documentElement;
  check('the preview label is translated with the locale, not frozen in English',
    localized, `en=${english}, zh=${translated?.title}`);
}

// Opening and closing the dialog leaves the row's DOM alone - the preview is the same
// node, the head's children are unchanged - and the name field is focused and selected.
{
  const h = setup([makeCell(0, { name: 'CLK', mode: 'rising' })]);
  const glyph = preview(h.root);
  const column = actions(h.root);
  const before = column?.children ?? [];
  const input = nameInput()!;
  let selects = 0;
  input.select = () => { selects += 1; };
  gear(h.root, 0)?.click();
  const untouched = (): boolean => preview(h.root) === glyph && glyph?.isConnected === true &&
    (column?.children ?? []).length === before.length &&
    (column?.children ?? []).every((kid, at) => kid === before[at]) &&
    (column?.children ?? [])[1] === glyph;
  const opened = settingsDialog()?.open === true && doc.activeElement === input &&
    selects === 1 && untouched();
  cancel()?.click();
  const closed = settingsDialog()?.open === false && untouched();
  h.render([makeCell(0, { name: 'CLK', mode: 'rising' })]);
  const rebuilt = preview(h.root) !== glyph && glyph?.isConnected === false;
  check('the gear opens the dialog on the selected name field without re-rendering the row',
    opened && closed && rebuilt,
    `open=${opened}, closed=${closed}, selects=${selects}, rebuilt=${rebuilt}`);
}

// Six modes, the cell's mode checked, and the capture lock confined to the trigger field.
{
  const h = setup([makeCell(0, { mode: 'edge', disabled: true })]);
  gear(h.root, 0)?.click();
  const values = radios().map((r) => r.value);
  const locked = triggerSet()?.disabled === true && nameInput()?.disabled === false &&
    save()?.disabled === false;
  check('all six trigger modes are offered, the cell\'s mode is checked, and only the trigger field locks while stopping',
    JSON.stringify(values) === JSON.stringify(['dont-care', 'rising', 'falling', 'edge', 'high', 'low']) &&
      checkedMode() === 'edge' && locked,
    `values=${values.join(',')}, checked=${checkedMode()}, fieldset=${triggerSet()?.disabled}, ` +
    `name=${nameInput()?.disabled}, save=${save()?.disabled}`);

  const unlocked = setup([makeCell(0, { mode: 'low', disabled: false })]);
  gear(unlocked.root, 0)?.click();
  check('a running matcher keeps the trigger modes enabled',
    triggerSet()?.disabled === false && nameInput()?.disabled === false,
    `fieldset=${triggerSet()?.disabled}`);

  chooseMode('high');
  submit();
  check('Save emits one configuration carrying the chosen trigger mode',
    unlocked.calls.configure.length === 1 && unlocked.calls.configure[0]?.[1].mode === 'high',
    `calls=${JSON.stringify(unlocked.calls.configure.map(([i, c]) => [i, c.mode]))}`);
}

// Save commits once with the trimmed name and hands focus back to the rebuilt gear.
{
  const h = setup([makeCell(0, { name: 'CLK' })]);
  const opener = gear(h.root, 0);
  opener?.click();
  const input = nameInput()!;
  input.value = '  DATA  ';
  submit();
  const committed = h.calls.configure[0]?.[1];
  const restored = gear(h.root, 0);
  check('Save emits exactly one trimmed name, closes the dialog and focuses the rebuilt gear',
    h.calls.configure.length === 1 && h.calls.configure[0]?.[0] === 0 &&
      committed?.name === 'DATA' && committed?.mode === 'dont-care' &&
      settingsDialog()?.open === false && opener?.isConnected === false &&
      restored !== null && restored !== opener && doc.activeElement === restored,
    `calls=${h.calls.configure.length}, name=${committed?.name}, open=${settingsDialog()?.open}, ` +
    `restored=${restored !== null}, focused=${doc.activeElement === restored}`);
}

// App owns the default-name fallback, so a whitespace-only name is emitted as ''.
{
  const h = setup([makeCell(0, { name: 'CLK' })]);
  gear(h.root, 0)?.click();
  nameInput()!.value = '   ';
  submit();
  check('a whitespace-only name is emitted as an empty string, not as the old name',
    h.calls.configure.length === 1 && h.calls.configure[0]?.[1].name === '',
    `name=${JSON.stringify(h.calls.configure[0]?.[1].name)}`);
  check('the column re-renders from the committed values (App supplies the default name)',
    h.root.querySelector('.ch-tag--name')?.textContent === 'D0' &&
      h.root.querySelector('.ch-original-id')?.hidden === true,
    `name=${h.root.querySelector('.ch-tag--name')?.textContent}`);
}

// Cancel, Escape and a backdrop press emit nothing; a press inside the form is not a
// dismissal.
{
  const h = setup([makeCell(0, { name: 'CLK' })]);
  const opener = gear(h.root, 0);
  opener?.click();
  nameInput()!.value = 'typed';
  cancel()?.click();
  const cancelled = h.calls.configure.length === 0 && settingsDialog()?.open === false &&
    doc.activeElement === opener;

  opener?.click();
  nameInput()!.value = 'typed';
  const escape = fakeEvent('cancel');
  settingsDialog()?.dispatchEvent(escape);
  const escaped = h.calls.configure.length === 0 && settingsDialog()?.open === false &&
    escape.defaultPrevented && doc.activeElement === opener;

  opener?.click();
  nameInput()!.value = 'typed';
  settingsDialog()?.dispatchEvent(fakeEvent('pointerdown'));
  const backdrop = h.calls.configure.length === 0 && settingsDialog()?.open === false &&
    doc.activeElement === opener;

  opener?.click();
  nameInput()!.value = 'typed';
  form()?.dispatchEvent(fakeEvent('pointerdown'));
  const inside = h.calls.configure.length === 0 && settingsDialog()?.open === true &&
    nameInput()?.value === 'typed';

  check('Cancel returns focus to the opener; Escape and a backdrop press close without committing',
    cancelled && escaped && backdrop,
    `cancel=${cancelled}, escape=${escaped}, backdrop=${backdrop}`);
  check('a pointerdown inside the dialog form leaves the draft open',
    inside, `open=${settingsDialog()?.open}, value=${nameInput()?.value}`);
}

// Colour is a draft: a preset click changes nothing until Save, and the reset glyph
// selects the channel's default colour.
{
  const h = setup([makeCell(0, { name: 'CLK' })]);
  gear(h.root, 0)?.click();
  const chosen = CHANNEL_COLOR_PRESETS[CHANNEL_COLOR_PRESETS.length - 1]!;
  const swatch = presetOf(chosen);
  swatch?.click();
  const drafted = h.calls.configure.length === 0 && settingsDialog()?.open === true &&
    swatch?.getAttribute('aria-pressed') === 'true' &&
    presetOf(channelColor(0))?.getAttribute('aria-pressed') === 'false';
  submit();
  check('a colour preset is a draft that Save commits, never applied on click',
    drafted && h.calls.configure.length === 1 &&
      h.calls.configure[0]?.[1].color === chosen,
    `drafted=${drafted}, color=${h.calls.configure[0]?.[1].color}`);

  gear(h.root, 0)?.click();
  presetOf(chosen)?.click();
  colorReset()?.click();
  const resetSelected = presetOf(channelColor(0))?.getAttribute('aria-pressed') === 'true' &&
    colorReset()?.title === 'Reset color of D0 to its default';
  submit();
  check('the colour reset glyph drafts the channel\'s default colour',
    resetSelected && h.calls.configure.length === 2 &&
      h.calls.configure[1]?.[1].color.toLowerCase() === channelColor(0).toLowerCase(),
    `selected=${resetSelected}, color=${h.calls.configure[1]?.[1].color}`);

  const custom = setup([makeCell(0, { color: '#123456' })]);
  gear(custom.root, 0)?.click();
  const customSwatch = settingsDialog()?.querySelector('.channel-color-custom');
  const customSelected = customSwatch?.getAttribute('aria-pressed') === 'true' &&
    presets().every((preset) => preset.getAttribute('aria-pressed') === 'false');
  submit();
  check('a colour outside the presets selects the custom swatch and is kept as the draft',
    customSelected && custom.calls.configure[0]?.[1].color === '#123456',
    `custom=${customSwatch?.getAttribute('aria-pressed')}, ` +
    `color=${custom.calls.configure[0]?.[1].color}`);
}

// The dialog outlives a re-render of its own row, and closes when its channel goes away.
{
  const cells = [makeCell(0, { name: 'CLK' }), makeCell(1)];
  const h = setup(cells);
  gear(h.root, 0)?.click();
  nameInput()!.value = 'typed';
  h.render(cells);
  const kept = settingsDialog()?.open === true && nameInput()?.value === 'typed';
  h.render([cells[1]!]);
  const closed = settingsDialog()?.open === false && h.calls.configure.length === 0;
  check('a re-render keeps the open dialog and its name draft; losing the channel closes it uncommitted',
    kept && closed, `kept=${kept}, closed=${closed}, value=${nameInput()?.value}`);

  h.render(cells);
  gear(h.root, 0)?.click();
  const openAgain = settingsDialog()?.open === true;
  h.list.closeDialog();
  check('closeDialog() closes the modal for a competing overlay',
    openAgain && settingsDialog()?.open === false && h.calls.configure.length === 0,
    `openAgain=${openAgain}, open=${settingsDialog()?.open}`);
}

// The analog bus row keeps its own popover trigger menu, not the channel dialog.
{
  const h = setup([makeCell(0)]);
  h.renderBuses([{
    id: 'bus-a1', name: 'A1', summary: 'D0-D7', color: '#48C860', heightCss: 160, analog: true,
  }]);
  h.root.querySelector('.bus-trigger[data-bus-id="bus-a1"]')?.click();
  const menu = popover();
  check('an analog bus trigger opens its own popover menu and never the channel dialog',
    settingsDialog()?.open === false && menu !== null && menu.hidden === false &&
      menu.querySelector('.ch-trigger-menu') !== null && menu.getAttribute('role') === 'dialog',
    `dialogOpen=${settingsDialog()?.open}, hidden=${menu?.hidden}, ` +
    `menu=${menu?.querySelector('.ch-trigger-menu') !== null}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed === 0 ? 'all' : results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
