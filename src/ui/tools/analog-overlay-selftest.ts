// SPDX-License-Identifier: GPL-3.0-or-later

import { installFakeDom, fakeEvent, type FakeElement } from './fakeDom.js';
import {
  AnalogSourceStrip, type AnalogSourceStripItem, type AnalogSourceStripView,
} from '../analogSourceStrip.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function methodBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start < 0) return '';
  const open = text.indexOf('{', start + signature.length - 1);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return '';
}

const doc = installFakeDom();
const host = doc.createElement('div') as unknown as FakeElement;
doc.body.appendChild(host as never);
const focused: string[] = [];
const toggled: string[] = [];
const strip = new AnalogSourceStrip(host as unknown as HTMLElement, {
  onFocus: (busId) => focused.push(busId),
  onToggleVisibility: (busId) => toggled.push(busId),
});

function sourceItem(overrides: Partial<AnalogSourceStripItem> = {}): AnalogSourceStripItem {
  return {
    busId: 'bus-0', name: 'A0', color: '#CD427E',
    focused: false, visible: true, volts: '', voltsDetail: '',
    ...overrides,
  };
}

const TWO: AnalogSourceStripItem[] = [
  sourceItem({ volts: '1.23 V', voltsDetail: '1.23 V at cursor 1' }),
  sourceItem({
    busId: 'bus-1', name: 'A1', color: '#00994D', focused: true,
    volts: '--', voltsDetail: 'sample unknown',
  }),
];
strip.render({ items: TWO, note: '' });

const root = host.querySelector('.analog-source-strip');
const chips = host.querySelectorAll('.analog-source-chip');

{
  const pressed = chips.map((chip) => chip.getAttribute('aria-pressed'));
  const names = chips.map((chip) => chip.querySelector('.analog-source-name')?.textContent);
  const busses = chips.map((chip) => chip.dataset.busId);
  const volts = host.querySelectorAll('.analog-source-volts').map((span) => span.textContent);
  check('the strip is one labelled group of source chips in row order with pressed state, voltage text and the focus',
    root !== null && root.getAttribute('role') === 'group' &&
    root.getAttribute('aria-label') === 'Analog sources' && root.hidden === false &&
    chips.length === 2 && busses.join(',') === 'bus-0,bus-1' &&
    names.join(',') === 'A0,A1' && pressed.join(',') === 'false,true' &&
    volts.join('|') === '1.23 V|--' &&
    chips[1]!.className.includes('focused') && !chips[0]!.className.includes('focused'),
    `role=${root?.getAttribute('role')}, label=${root?.getAttribute('aria-label')}, ` +
    `buses=${busses.join(',')}, names=${names.join(',')}, pressed=${pressed.join(',')}, ` +
    `volts=${volts.join('|')}`);
}

{
  const labels = chips.map((chip) => chip.getAttribute('aria-label'));
  const swatches = chips.map((chip) => chip.querySelector('.analog-source-swatch')?.style.background);
  check('each chip is a keyboard-reachable button named by the focus action plus its readable voltage, with the source colour on its swatch',
    chips.every((chip) => chip.localName === 'button' && chip.type === 'button') &&
    labels.join('|') === 'Focus A0. 1.23 V at cursor 1|Focus A1. sample unknown' &&
    swatches.join('|') === '#CD427E|#00994D',
    `labels=${labels.join('|')}, swatches=${swatches.join('|')}`);
}

{
  const stuck = chips[0]!;
  const pointer = fakeEvent('pointerdown');
  stuck.dispatchEvent(pointer);
  const double = fakeEvent('dblclick');
  stuck.dispatchEvent(double);
  chips[1]!.click();
  check('a pointer press never reaches the plot pan, a double-click never reaches the time-cursor placement and a click focuses that source only',
    pointer.propagationStopped && double.propagationStopped && focused.join(',') === 'bus-1',
    `press=${pointer.propagationStopped}, dblclick=${double.propagationStopped}, ` +
    `focused=${focused.join(',')}`);
}

{
  const visibility = host.querySelectorAll('.analog-source-visibility');
  const pressed = visibility.map((button) => button.getAttribute('aria-pressed'));
  const labels = visibility.map((button) => button.getAttribute('aria-label'));
  const eyes = visibility.map((button) => button.querySelector('.analog-source-eye') !== null);
  check('every source carries its own keyboard-reachable visibility button whose pressed state is its display state',
    visibility.length === 2 &&
    visibility.every((button) => button.localName === 'button' && button.type === 'button') &&
    pressed.join(',') === 'true,true' && labels.join('|') === 'Hide A0|Hide A1' &&
    eyes.join(',') === 'true,true',
    `buttons=${visibility.length}, pressed=${pressed.join(',')}, labels=${labels.join('|')}, eyes=${eyes.join(',')}`);

  const stuck = visibility[1]!;
  const pointer = fakeEvent('pointerdown');
  stuck.dispatchEvent(pointer);
  visibility[0]!.click();
  check('the visibility action is a separate button that never pans the plot and never focuses a source',
    pointer.propagationStopped && toggled.join(',') === 'bus-0' &&
    focused.join(',') === 'bus-1',
    `press=${pointer.propagationStopped}, toggled=${toggled.join(',')}, ` +
    `focused=${focused.join(',')}`);

  const hiddenView: AnalogSourceStripView = {
    items: [
      sourceItem({ visible: false }),
      sourceItem({
        busId: 'bus-1', name: 'A1', color: '#00994D', focused: true,
        volts: '2.00 V', voltsDetail: '2.00 V at cursor 1',
      }),
    ],
    note: 'All sources are hidden. Use the source chips to show one.',
  };
  strip.render(hiddenView);
  const after = host.querySelectorAll('.analog-source-visibility');
  const shown = host.querySelectorAll('.analog-source-chip');
  const note = host.querySelector('.analog-source-note');
  check('a hidden source stays listed with its name, its icon slashed, its chip dimmed and a localized show action',
    shown.length === 2 && shown[0]!.className.includes('is-hidden') &&
    !shown[1]!.className.includes('is-hidden') &&
    after[0]!.getAttribute('aria-pressed') === 'false' &&
    after[0]!.getAttribute('aria-label') === 'Show A0' &&
    after[1]!.getAttribute('aria-pressed') === 'true' &&
    note !== null && note.textContent === 'All sources are hidden. Use the source chips to show one.',
    `hidden=${shown[0]?.className}, pressed=${after.map((b) => b.getAttribute('aria-pressed')).join(',')}, ` +
    `labels=${after.map((b) => b.getAttribute('aria-label')).join('|')}, note=${note?.textContent}`);
}

{
  strip.render({
    items: [sourceItem({ volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' })],
    note: '',
  });
  const before = host.querySelector('.analog-source-chip');
  const beforeVolts = host.querySelector('.analog-source-volts');
  strip.updateVoltages({
    items: [sourceItem({ volts: '2.50 V', voltsDetail: '2.50 V at cursor 1' })],
    note: '',
  });
  const after = host.querySelector('.analog-source-chip');
  const afterVolts = host.querySelector('.analog-source-volts');
  check('a voltage refresh rewrites only the existing chip text and label, never rebuilding the strip',
    before !== null && before === after && beforeVolts === afterVolts &&
    afterVolts?.textContent === '2.50 V' &&
    after?.getAttribute('aria-label') === 'Focus A0. 2.50 V at cursor 1',
    `sameChip=${before === after}, sameSpan=${beforeVolts === afterVolts}, ` +
    `volts=${afterVolts?.textContent}, label=${after?.getAttribute('aria-label')}`);

  const noteView: AnalogSourceStripView = {
    items: [sourceItem({ volts: '--', voltsDetail: 'previous wave shown' })],
    note: 'Previous wave shown: cursor voltages wait for the current wave.',
  };
  strip.updateVoltages(noteView);
  const note = host.querySelector('.analog-source-note');
  check('a refresh that has to add or drop the strip note re-renders the same chip set instead of leaving it stale',
    note?.textContent === noteView.note &&
    host.querySelectorAll('.analog-source-chip').length === 1 &&
    host.querySelectorAll('.analog-source-volts')[0]?.textContent === '--',
    `note=${note?.textContent}`);

  strip.updateVoltages({ items: [], note: '' });
  const empty = host.querySelector('.analog-source-strip');
  check('a refresh with no source rebuilds an empty, hidden host with no note left behind',
    empty?.hidden === true && empty.childNodes.length === 0,
    `hidden=${empty?.hidden}, children=${empty?.childNodes.length}`);
}

{
  strip.render({
    items: [
      sourceItem({ volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' }),
      sourceItem({
        busId: 'bus-1', name: 'A1', color: '#00994D', focused: true,
        volts: '2.00 V', voltsDetail: '2.00 V at cursor 1',
      }),
    ],
    note: '',
  });
  const second = host.querySelectorAll('.analog-source-chip')[1]!;
  second.focus();
  strip.render({
    items: [
      sourceItem({ volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' }),
      sourceItem({
        busId: 'bus-1', name: 'A1', color: '#00994D', focused: true,
        volts: '2.00 V', voltsDetail: '2.00 V at cursor 1',
      }),
    ],
    note: '',
  });
  const swapped = host.querySelectorAll('.analog-source-chip');
  const swappedState = swapped.map((chip) =>
    `${chip.dataset.busId}:${chip.getAttribute('aria-pressed')}`);
  strip.render({
    items: [
      sourceItem({
        busId: 'bus-1', name: 'A1', color: '#00994D', focused: true,
        volts: '2.00 V', voltsDetail: '2.00 V at cursor 1',
      }),
      sourceItem({ volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' }),
    ],
    note: '',
  });
  const reordered = host.querySelectorAll('.analog-source-chip');
  check('a rebuilt strip follows the band order and keeps the pressed state with its own source',
    swappedState.join(',') === 'bus-0:false,bus-1:true' &&
    reordered.map((chip) => chip.dataset.busId).join(',') === 'bus-1,bus-0' &&
    reordered[0]!.getAttribute('aria-pressed') === 'true',
    `swapped=${swappedState.join(',')}, order=${reordered.map((chip) => chip.dataset.busId).join(',')}`);
}

{
  strip.render({ items: [], note: '' });
  const hidden = host.querySelector('.analog-source-strip');
  check('an empty source list hides the host and leaves no children behind',
    hidden !== null && hidden.hidden === true && hidden.childNodes.length === 0,
    `hidden=${hidden?.hidden}, children=${hidden?.childNodes.length}`);
}

{
  strip.render({
    items: [sourceItem({ name: 'Shunt', volts: '0.50 V', voltsDetail: '0.50 V at cursor 1' })],
    note: '',
  });
  const single = host.querySelectorAll('.analog-source-chip');
  check('a single source still renders its chip, its voltage and its visibility button under the same group label',
    single.length === 1 && single[0]!.getAttribute('aria-pressed') === 'false' &&
    host.querySelectorAll('.analog-source-volts')[0]?.textContent === '0.50 V' &&
    host.querySelectorAll('.analog-source-visibility').length === 1 &&
    host.querySelector('.analog-source-strip')?.getAttribute('aria-label') === 'Analog sources' &&
    host.querySelector('.analog-source-strip')?.hidden === false,
    `chips=${single.length}, volts=${host.querySelectorAll('.analog-source-volts')[0]?.textContent}`);
}

{
  strip.render({
    items: [
      sourceItem({ volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' }),
      sourceItem({
        busId: 'bus-1', name: 'A1', color: '#00994D', focused: true,
        volts: '2.00 V', voltsDetail: '2.00 V at cursor 1',
      }),
    ],
    note: '',
  });
  const chip = host.querySelectorAll('.analog-source-chip')[1]!;
  chip.focus();
  const focusedBefore = doc.activeElement === chip;
  strip.render({
    items: [
      sourceItem({ volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' }),
      sourceItem({
        busId: 'bus-1', name: 'A1', color: '#00994D', focused: true,
        volts: '2.00 V', voltsDetail: '2.00 V at cursor 1',
      }),
    ],
    note: '',
  });
  const after = doc.activeElement as unknown as FakeElement;
  const outside = doc.createElement('button') as unknown as FakeElement;
  doc.body.appendChild(outside as never);
  outside.focus();
  strip.render({
    items: [sourceItem({ focused: true, volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' })],
    note: '',
  });
  check('a re-rendered strip keeps keyboard focus on the same source chip and never steals it from outside',
    focusedBefore && after.dataset.busId === 'bus-1' && after.dataset.action === 'focus' &&
    (doc.activeElement as unknown as FakeElement) === outside,
    `before=${focusedBefore}, after=${after?.dataset.busId}, ` +
    `outside=${(doc.activeElement as unknown as FakeElement) === outside}`);

  const visibility = host.querySelectorAll('.analog-source-visibility')[0]!;
  visibility.focus();
  const actionBefore = doc.activeElement === visibility;
  strip.render({
    items: [sourceItem({ focused: true, volts: '1.00 V', voltsDetail: '1.00 V at cursor 1' })],
    note: '',
  });
  const restored = doc.activeElement as unknown as FakeElement;
  check('the visibility button keeps its own focus across a rebuild instead of handing it to the chip',
    actionBefore && restored.dataset.action === 'visibility' &&
    restored.dataset.busId === 'bus-0',
    `before=${actionBefore}, action=${restored?.dataset.action}, bus=${restored?.dataset.busId}`);
}

const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const list = fs.readFileSync('src/ui/channelList.ts', 'utf8');
const dialog = fs.readFileSync('src/ui/settingsDialog.ts', 'utf8');
const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

function stripSibling(source: string): boolean {
  return source.includes('this.sourceStrip = new AnalogSourceStrip(this.el.plot, {') &&
    !source.includes('new AnalogSourceStrip(this.scopeHost') &&
    source.includes('onFocus: (busId) => this.setAnalogFocus(busId),');
}

{
  check('the chip strip is a plot-corner sibling of the scope surface, never a left-column cell',
    stripSibling(app),
    `sibling=${stripSibling(app)}`);
  const inScopeHost = app.replace('new AnalogSourceStrip(this.el.plot', 'new AnalogSourceStrip(this.scopeHost');
  const noFocus = app.replace('onFocus: (busId) => this.setAnalogFocus(busId),', '');
  check('control: mounting the strip in the scope host or dropping its focus callback fails the same predicate',
    inScopeHost !== app && !stripSibling(inScopeHost) &&
    noFocus !== app && !stripSibling(noFocus),
    `scopeHost=${stripSibling(inScopeHost)}, noFocus=${stripSibling(noFocus)}`);
}

const focusBody = methodBody(app, 'private setAnalogFocus(busId: string): void {');
const layoutBody = methodBody(app, 'private setAnalogLayout(layout: AnalogLayout): void {');

{
  const sessionOnly = focusBody.length > 0 && !focusBody.includes('persistWorkspace') &&
    focusBody.includes('this.analogFocusId = busId;') &&
    focusBody.includes('this.relayout();') && focusBody.includes('this.renderPanels();') &&
    focusBody.includes('this.dirty = true;');
  const layoutOrder = [
    'this.analogLayout = layout;',
    'this.persistWorkspace();',
    'this.relayout();',
    'this.renderPanels();',
    'this.dirty = true;',
  ].map((needle) => layoutBody.indexOf(needle));
  const persisted = layoutOrder.every((index, i) => index >= 0 && (i === 0 || index > layoutOrder[i - 1]!)) &&
    layoutBody.split('this.persistWorkspace();').length === 2;
  check('focus is session-only while the layout setter assigns, persists once, relayouts and renders',
    sessionOnly && persisted,
    `focus=${sessionOnly}, layoutOrder=${JSON.stringify(layoutOrder)}, persisted=${persisted}`);
  const leakingFocus = app.replace(
    'private setAnalogFocus(busId: string): void {',
    'private setAnalogFocus(busId: string): void {\n    this.persistWorkspace();');
  const noWrite = app.replace(
    '    this.analogLayout = layout;\n    this.persistWorkspace();',
    '    this.analogLayout = layout;');
  const sessionOnlyOf = (source: string): boolean =>
    !methodBody(source, 'private setAnalogFocus(busId: string): void {').includes('persistWorkspace');
  const persistedOf = (source: string): boolean =>
    methodBody(source, 'private setAnalogLayout(layout: AnalogLayout): void {')
      .includes('this.analogLayout = layout;\n    this.persistWorkspace();');
  check('control: a persisted focus or a layout setter without its workspace write fails the same predicate',
    leakingFocus !== app && !sessionOnlyOf(leakingFocus) &&
    noWrite !== app && !persistedOf(noWrite) &&
    sessionOnlyOf(app) && persistedOf(app),
    `leaking=${sessionOnlyOf(leakingFocus)}, noWrite=${persistedOf(noWrite)}`);
}

{
  const relayout = methodBody(app, 'private relayout(): void');
  check('both relayout exits re-render the source strip',
    (relayout.match(/this\.renderAnalogSources\(\);/g) ?? []).length === 2 &&
    relayout.includes('this.pruneAnalogFocus();'),
    `renders=${(relayout.match(/this\.renderAnalogSources\(\);/g) ?? []).length}`);
  const gatedOf = (source: string): boolean => {
    const body = methodBody(source, 'private renderAnalogSources(): void {');
    const merged = methodBody(source, 'private mergedAnalogSources(): readonly AnalogBandSource[] {');
    return body.includes('const sources = this.mergedAnalogSources();') &&
      body.includes("sources.length === 0 ? { items: [], note: '' } : this.analogStripView(sources)") &&
      merged.includes("if (this.analogLayout !== 'merged') return [];") &&
      merged.includes('band.id === MERGED_ANALOG_BAND_ID');
  };
  const ungated = app.replace(
    "    if (this.analogLayout !== 'merged') return [];\n", '');
  const allBands = app.replace(
    'band.id === MERGED_ANALOG_BAND_ID)?.sources ?? []',
    'true)?.sources ?? []');
  check('the strip lists only the Overlay band\'s participants, so Stacked shows no chips',
    gatedOf(app), `mergedOnly=${gatedOf(app)}`);
  check('control: dropping the Overlay gate either way lists Stacked sources and their dead focus chips',
    ungated !== app && !gatedOf(ungated) && allBands !== app && !gatedOf(allBands) && gatedOf(app),
    `ungated=${gatedOf(ungated)}, allBands=${gatedOf(allBands)}`);
  const bandsBody = methodBody(
    app, 'private analogBandsFor(entries: readonly AnalogRowEntry[]): AnalogBand[]');
  const partition = bandsBody.includes('entry.source.group >= 0') &&
    bandsBody.includes("bands.push(...analogBands('stacked', [entry.source], null));") &&
    bandsBody.includes('entries.filter((entry) => entry.source.group >= 0).map((entry) => entry.source),');
  const mergeAll = app.replace(
    'entries.filter((entry) => entry.source.group >= 0).map((entry) => entry.source),',
    'entries.map((entry) => entry.source),');
  check('Overlay merges the ADC groups and leaves every other bus row its own row',
    partition, `partition=${partition}`);
  check('control: merging every bus row into the ADC band fails the same partition predicate',
    mergeAll !== app && !mergeAll.includes(
      'entries.filter((entry) => entry.source.group >= 0).map((entry) => entry.source),') &&
    partition,
    `mergeAll=${mergeAll.includes('entries.filter((entry) => entry.source.group >= 0)')}`);
  const focusBody = methodBody(app, 'private setAnalogFocus(busId: string): void {');
  check('a focus is accepted only for an ADC group, so the band always keeps a ruler owner',
    focusBody.includes('if (!entry || entry.source.group < 0) return;'),
    `group=${focusBody.includes('entry.source.group < 0')}`);
  const anySourceFocus = app.replace(
    'if (!entry || entry.source.group < 0) return;',
    'if (!entry) return;');
  check('control: accepting any bus as the focus fails the same predicate',
    anySourceFocus !== app &&
    !methodBody(anySourceFocus, 'private setAnalogFocus(busId: string): void {')
      .includes('entry.source.group < 0'),
    `any=${anySourceFocus.includes('entry.source.group < 0')}`);
  const cellBody = methodBody(app, 'private busCells(): BusCell[] {');
  const bandHeight = 'const cell = this.busCell(bus, band.heightCss, band.sources.length <= 1);';
  check('one cell per band shows the focused source at the band height, and only a merged band drops the height grip',
    cellBody.includes('for (const band of this.analogRowBands) {') &&
    cellBody.includes('const source = focusedAnalogSource(band);') &&
    cellBody.includes(bandHeight) &&
    list.includes('if (cell.analog && cell.showHeight !== false) {'),
    `merged=${cellBody.includes('band.sources.length <= 1')}`);
  const gripControl = list.replace(
    'if (cell.analog && cell.showHeight !== false) {', 'if (cell.analog) {');
  const heightControl = app.replace(
    bandHeight,
    'const cell = this.busCell(bus, this.rowHeightOf(bus), true);');
  const gripAlways = app.replace(
    bandHeight,
    'const cell = this.busCell(bus, band.heightCss, true);');
  check('control: an ungated height grip, a per-source height or a grip on a merged band fails the same predicate',
    gripControl !== list && !gripControl.includes('cell.showHeight !== false') &&
    heightControl !== app && !heightControl.includes(bandHeight) &&
    gripAlways !== app && !gripAlways.includes('band.sources.length <= 1'),
    `grip=${gripControl.includes('cell.showHeight !== false')}, ` +
    `height=${heightControl.includes('band.heightCss')}, gripAlways=${gripAlways.includes('band.sources.length <= 1')}`);
}

const drawBody = methodBody(app, 'private drawBusRows(');

function mergedTracePasses(source: string): boolean {
  const body = methodBody(source, 'private drawBusRows(');
  return body.includes('const band = this.analogRowBands[analogIndex];') &&
    body.includes('const hidden = this.hiddenAnalogSources();') &&
    body.includes('? band.sources : band.sources.filter((source) => !hidden.has(source.busId));') &&
    body.includes('for (const source of visible) {') &&
    body.includes('traces.push(this.analogTrace(bus, scopeOf(bus)));') &&
    body.includes('const focused = focusedAnalogSource(band);') &&
    body.includes('const scope = focusedBus ? scopeOf(focusedBus) : undefined;') &&
    body.includes('top: box.top, band: box.band, traces,') &&
    body.includes('this.overlay.drawAnalog(view);');
}

{
  check('one band draws every source trace with its own calibration and one focused chrome scope',
    drawBody.length > 0 && mergedTracePasses(app),
    `draw=${mergedTracePasses(app)}`);
  const firstSourceOnly = app.replace(
    'for (const source of visible) {', 'for (const source of band.sources.slice(0, 1)) {');
  const perSourceChrome = app.replace(
    'const scope = focusedBus ? scopeOf(focusedBus) : undefined;',
    'const scope = traces[0] ? scopeOf(busesById.get(band.sources[0]!.busId)!) : undefined;');
  const noBandHeight = app.replace(
    'band: box.band, traces,', 'band: box.band / traces.length, traces,');
  check('control: only the first source, a per-source ruler target or a split band fails the same predicate',
    firstSourceOnly !== app && !mergedTracePasses(firstSourceOnly) &&
    perSourceChrome !== app && !mergedTracePasses(perSourceChrome) &&
    noBandHeight !== app && !mergedTracePasses(noBandHeight),
    `first=${mergedTracePasses(firstSourceOnly)}, chrome=${mergedTracePasses(perSourceChrome)}, ` +
    `height=${mergedTracePasses(noBandHeight)}`);
}

{
  const busSig = methodBody(app, 'private busSignature(viewStart: number, viewEnd: number): number {');
  const signed = busSig.includes('this.analogLayout, this.analogFocusId ?? \'\',');
  check('the bus frame signature carries the layout and the focused source',
    signed && busSig.includes('busFrameSignatureParts(bus)'),
    `signed=${signed}`);
  const unsigned = app.replace("      this.analogLayout, this.analogFocusId ?? '',\n", '');
  const checkSigned = (source: string): boolean => methodBody(
    source, 'private busSignature(viewStart: number, viewEnd: number): number {')
    .includes('this.analogLayout, this.analogFocusId');
  check('control: dropping the layout or focus input from the bus signature fails the same predicate',
    unsigned !== app && !checkSigned(unsigned) && checkSigned(app),
    `unsigned=${checkSigned(unsigned)}`);
}

{
  const defaultBody = methodBody(
    app, 'private scopeDefaultVoltsPerDiv(bus: BusViewConfig, gain = analogGainOf(bus)): number {');
  const fromBand = defaultBody.includes('scopeRowDivisions(this.scopeBandHeight(bus))');
  const ownHeight = app.replace(
    'scopeRowDivisions(this.scopeBandHeight(bus))', 'scopeRowDivisions(this.rowHeightOf(bus))');
  const fromBandOf = (source: string): boolean => methodBody(
    source, 'private scopeDefaultVoltsPerDiv(bus: BusViewConfig, gain = analogGainOf(bus)): number {')
    .includes('scopeRowDivisions(this.scopeBandHeight(bus))');
  check('the gain default scale counts the drawn band\'s divisions, so a reset in Overlay fits the merged height',
    fromBand, `band=${fromBand}`);
  check('control: deriving the default from the source\'s own row height fails the same predicate',
    ownHeight !== app && !fromBandOf(ownHeight) && fromBandOf(app),
    `own=${fromBandOf(ownHeight)}`);
  const bandBody = methodBody(
    app, 'private scopeBandHeight(bus: BusViewConfig & { id?: string }): number {');
  check('the band height lookup keeps the row height for a view that is in no band',
    bandBody.includes('return band ? band.heightCss : this.rowHeightOf(bus);') &&
    bandBody.includes('candidate.sources.some((source) => source.busId === id)'),
    `fallback=${bandBody.includes('return band ? band.heightCss : this.rowHeightOf(bus);')}`);
}

{
  const menu = methodBody(app, 'private scopeMenuItems(');
  const body = menu.length > 0 ? menu : app.slice(app.indexOf('private scopeMenuItems('));
  const layoutItem = body.includes(
    "label: t(this.analogLayout === 'merged' ? 'bus.layoutStacked' : 'bus.layoutMerged'),") &&
    body.includes("onPick: () => this.setAnalogLayout(this.analogLayout === 'merged' ? 'stacked' : 'merged'),");
  check('the ruler menu picks the same layout setter as Appearance',
    layoutItem && app.includes('this.scopeMenuItems(bus)'),
    `menu=${layoutItem}, items=${app.split('this.scopeMenuItems(bus)').length - 1}`);
}

{
  const layoutRow = methodBody(dialog, 'private analogLayoutRow(): HTMLDivElement {');
  const row = layoutRow.length > 0 ? layoutRow : dialog;
  const wired = row.includes("selectControl('analogLayout', t('settings.analogLayout'), [") &&
    row.includes("['stacked', t('bus.layoutStacked')],") &&
    row.includes("['merged', t('bus.layoutMerged')],") &&
    row.includes('this.host.analogLayout()') &&
    row.includes('this.host.setAnalogLayout(analogLayoutOf(select.value))') &&
    dialog.includes('analogLayout(): AnalogLayout;') &&
    dialog.includes('setAnalogLayout(layout: AnalogLayout): void;') &&
    app.includes('analogLayout: () => this.analogLayout,') &&
    app.includes('setAnalogLayout: (layout) => this.setAnalogLayout(layout),');
  check('Appearance reads and writes the one App layout setter through both layout names',
    wired, `wired=${wired}`);
  const literal = dialog.replace("['merged', t('bus.layoutMerged')],", '');
  const direct = dialog.replace('this.host.setAnalogLayout(analogLayoutOf(select.value))', '');
  check('control: dropping a layout option or the host write-back fails the same predicate',
    literal !== dialog && !literal.includes("t('bus.layoutMerged')") &&
    direct !== dialog && !direct.includes('this.host.setAnalogLayout('),
    `literal=${literal !== dialog}, direct=${direct !== dialog}`);
}

{
  const body = methodBody(app, 'private toggleAnalogVisibility(busId: string): void {');
  const toggled = body.includes('toggleSourceVisibility(') &&
    body.includes('{ focusedId: resolveAnalogFocus(sources, this.analogFocusId), hidden: this.analogHidden },') &&
    body.includes('this.analogHidden = next.hidden;') &&
    body.includes('this.analogFocusId = next.focusedId;') &&
    !body.includes('persistWorkspace') &&
    !body.split('\n').some((line) => line.includes('this.analogHidden.add(') ||
      line.includes('this.analogHidden.delete('));
  const order = ['this.analogHidden = next.hidden;', 'this.relayout();', 'this.renderPanels();', 'this.dirty = true;']
    .map((needle) => body.indexOf(needle));
  const sequential = order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!));
  check('one visibility setter keeps the App-owned hidden set, retargets focus through the pure reducer and re-renders without persisting',
    toggled && sequential,
    `reducer=${body.includes('toggleSourceVisibility(')}, order=${JSON.stringify(order)}, ` +
    `persists=${body.includes('persistWorkspace')}`);
  const direct = app.replace(
    '    this.analogHidden = next.hidden;\n    this.analogFocusId = next.focusedId;',
    '    const hidden = new Set(this.analogHidden);\n    hidden.add(busId);\n    this.analogHidden = hidden;');
  const persisted = app.replace(
    'private toggleAnalogVisibility(busId: string): void {',
    'private toggleAnalogVisibility(busId: string): void {\n    this.persistWorkspace();');
  const toggles = (source: string): boolean => {
    const inner = methodBody(source, 'private toggleAnalogVisibility(busId: string): void {');
    return inner.includes('this.analogHidden = next.hidden;') &&
      inner.includes('this.analogFocusId = next.focusedId;') && !inner.includes('persistWorkspace');
  };
  check('control: a hand-rolled hidden set or a persisted visibility fails the same predicate',
    direct !== app && !toggles(direct) && persisted !== app && !toggles(persisted) && toggles(app),
    `direct=${toggles(direct)}, persisted=${toggles(persisted)}`);

  const focusBody = methodBody(app, 'private setAnalogFocus(busId: string): void {');
  const focusGuard = 'if (busId === this.analogFocusId && !hiddenBus) return;';
  const focusShowsHidden = (source: string): boolean => {
    const body = methodBody(source, 'private setAnalogFocus(busId: string): void {');
    const guardAt = body.indexOf(focusGuard);
    const deleteAt = body.indexOf('hidden.delete(busId);');
    return body.includes('const hiddenBus = this.analogHidden.has(busId);') &&
      guardAt > 0 && deleteAt > guardAt &&
      deleteAt < body.indexOf('this.relayout();') &&
      body.includes('this.analogHidden = hidden;');
  };
  check('focusing a hidden Overlay source shows it, even when that source already owns the focus',
    focusShowsHidden(app) && focusBody.includes(focusGuard),
    `guard=${focusBody.indexOf(focusGuard)}, unhide=${focusBody.indexOf('hidden.delete(busId);')}`);
  const focusedShortCircuit = app.replace(focusGuard, 'if (busId === this.analogFocusId) return;');
  const keepsHidden = app.replace(
    '    if (hiddenBus) {\n      const hidden = new Set(this.analogHidden);\n      hidden.delete(busId);\n      this.analogHidden = hidden;\n    }\n', '');
  check('control: a plain focus short-circuit or a dropped unhide fails the same predicate',
    focusedShortCircuit !== app && !focusShowsHidden(focusedShortCircuit) &&
    keepsHidden !== app && !focusShowsHidden(keepsHidden),
    `short-circuit=${focusShowsHidden(focusedShortCircuit)}, dropped=${focusShowsHidden(keepsHidden)}`);

  const pruneBody = methodBody(app, 'private pruneAnalogFocus(): void {');
  check('capture replacement prunes focus and visibility together without touching source configuration',
    pruneBody.includes('{ focusedId: this.analogFocusId, hidden: this.analogHidden }, valid') &&
    pruneBody.includes('this.analogHidden = pruned.hidden;') &&
    !pruneBody.includes('busViews =') && !pruneBody.includes('heightCss'),
    `hidden=${pruneBody.includes('hidden: this.analogHidden')}`);
  const pruneFocusOnly = app.replace(
    '{ focusedId: this.analogFocusId, hidden: this.analogHidden }, valid',
    '{ focusedId: this.analogFocusId, hidden: new Set<string>() }, valid');
  check('control: pruning with an empty hidden set drops a valid visibility state',
    pruneFocusOnly !== app && !pruneFocusOnly.includes('hidden: this.analogHidden }, valid'),
    `keeps=${pruneFocusOnly.includes('hidden: this.analogHidden }, valid')}`);
}

{
  const signed = methodBody(app, 'private busSignature(viewStart: number, viewEnd: number): number {');
  const hiddenLine = "this.analogLayout === 'merged' ? [...this.analogHidden].sort().join(',') : '',";
  check('the bus frame signature carries the Overlay visibility of the band it draws',
    signed.includes(hiddenLine) && signed.includes('this.analogLayout, this.analogFocusId'),
    `hidden=${signed.includes(hiddenLine)}`);
  const unsigned = app.replace(`      ${hiddenLine}\n`, '');
  const ungated = app.replace(hiddenLine, "[...this.analogHidden].sort().join(','),");
  const signedOf = (source: string): boolean => methodBody(
    source, 'private busSignature(viewStart: number, viewEnd: number): number {')
    .includes('this.analogHidden');
  check('control: dropping the visibility input from the bus signature fails the same predicate',
    unsigned !== app && signedOf(unsigned) === false && signedOf(app) === true &&
    ungated !== app,
    `unsigned=${signedOf(unsigned)}, ungated=${signedOf(ungated)}`);

  const drawBody = methodBody(app, 'private drawBusRows(');
  check('the merged band draws only visible sources and states the all-hidden case in the band itself',
    drawBody.includes('const hidden = this.hiddenAnalogSources();') &&
    drawBody.includes('const allHidden = band.sources.length > 0 && visible.length === 0;') &&
    drawBody.includes("const note = allHidden ? t('bus.allHiddenNote')") &&
    drawBody.includes('for (const source of visible) {'),
    `allHidden=${drawBody.includes('allHidden')}`);
  const drawnAll = app.replace(
    '? band.sources : band.sources.filter((source) => !hidden.has(source.busId));',
    '? band.sources : band.sources;');
  const noteDropped = app.replace("const note = allHidden ? t('bus.allHiddenNote')", 'const note = allHidden ? \'\'');
  check('control: drawing hidden sources or dropping the in-band note fails the same predicate',
    drawnAll !== app && !drawnAll.includes('band.sources.filter((source) => !hidden.has(source.busId));') &&
    noteDropped !== app && !noteDropped.includes("t('bus.allHiddenNote')"),
    `drawn=${drawnAll.includes('!hidden.has(source.busId)')}, note=${noteDropped.includes('allHiddenNote')}`);
}

{
  const panels = methodBody(app, 'private renderPanels(): void {');
  const refresh = methodBody(app, 'private refreshAnalogVoltages(): void {');
  const transitions = [
    'private releaseRepeatHold(): void {',
    'private clearRepeatLayers(): void {',
    'private settleHeldRepeatWave(): void {',
  ].filter((signature) => methodBody(app, signature).includes('this.refreshAnalogVoltages();'));
  const dragSites = app.split('this.refreshAnalogVoltages();').length - 1;
  check('the voltage readout refreshes on the existing cursor drag path, on every panel render and on each wave hand-over, never from a frame',
    panels.includes('this.refreshAnalogVoltages();') &&
    dragSites >= 7 && transitions.length === 3 &&
    refresh.includes('this.mergedAnalogSources()') &&
    refresh.includes('this.sourceStrip.updateVoltages(this.analogStripView(sources));') &&
    !refresh.includes('projectCursorVoltages(') &&
    !methodBody(app, 'private frame = (): void => {').includes('refreshAnalogVoltages'),
    `panels=${panels.includes('this.refreshAnalogVoltages();')}, sites=${dragSites}, ` +
    `transitions=${transitions.length}, ` +
    `frames=${methodBody(app, 'private frame = (): void => {').includes('refreshAnalogVoltages')}`);
  const unrefreshed = app.replace(
    "    this.renderSidebarContent();\n    this.refreshAnalogVoltages();",
    '    this.renderSidebarContent();');
  check('control: dropping the panel-render refresh leaves the strip text stale',
    unrefreshed !== app &&
    !methodBody(unrefreshed, 'private renderPanels(): void {').includes('this.refreshAnalogVoltages();'),
    `sites=${unrefreshed.split('this.refreshAnalogVoltages();').length - 1}`);
  const framed = app.replace(
    'private frame = (): void => {',
    'private frame = (): void => {\n    this.refreshAnalogVoltages();');
  check('control: moving the refresh into the frame loop fails the same predicate',
    framed !== app &&
    methodBody(framed, 'private frame = (): void => {').includes('this.refreshAnalogVoltages();'),
    `frames=${methodBody(framed, 'private frame = (): void => {').includes('refreshAnalogVoltages')}`);
}

{
  const layoutNames = [
    'bus.layoutStacked', 'bus.layoutMerged', 'bus.sourceStrip', 'bus.focusSource',
    'bus.hideSource', 'bus.showSource', 'bus.allHiddenNote', 'bus.allHiddenHint',
    'bus.voltsAtCursor', 'bus.voltsUnknown', 'bus.voltsOutside', 'bus.voltsPreviousWave',
    'bus.voltsPreviousWaveNote', 'bus.voltsNoSource', 'bus.voltsNoCursor',
  ];
  const settingsRows = ['settings.analogLayout'];
  const files = ['en', 'zh-CN', 'fr', 'ru'].map((locale) =>
    fs.readFileSync(`src/ui/locales/${locale}.ts`, 'utf8'));
  const missing = files.flatMap((text, index) => [
    ...layoutNames.filter((key) => !text.includes(`'${key}':`)).map((key) => `${index}:${key}`),
    ...settingsRows.filter((key) => !text.includes(`'${key}':`)).map((key) => `${index}:${key}`),
  ]);
  check('all four catalogs carry the layout names, the strip label, the focus action and the settings row',
    missing.length === 0, `missing=${JSON.stringify(missing)}`);
  check('the strip and chip styles use the shared tokens and keep the plot corner free of the axis',
    sheet.includes('.analog-source-strip {') &&
    sheet.includes('.analog-source-strip[hidden] { display: none; }') &&
    sheet.includes('.analog-source-chip[aria-pressed="true"]') &&
    sheet.includes('display: flex; align-items: center; gap: 4px; flex-wrap: wrap;') &&
    sheet.includes('max-width: calc(100% - 60px);') &&
    sheet.includes('.settings-row-select { grid-template-columns: minmax(0, 1fr); }') &&
    ['.analog-source-item {', '.analog-source-volts {', '.analog-source-volts:empty {',
      '.analog-source-chip.is-hidden {', '.analog-source-visibility {', '.analog-source-note {']
      .every((rule) => sheet.includes(rule)) &&
    !/analog-source[^{]*\{[^}]*(position:\s*fixed|width:\s*\d+px;\s*width:)/.test(sheet),
    `sheet=${sheet.includes('.analog-source-strip {')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
