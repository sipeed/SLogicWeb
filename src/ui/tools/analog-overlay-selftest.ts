// SPDX-License-Identifier: GPL-3.0-or-later

import { installFakeDom, fakeEvent, type FakeElement } from './fakeDom.js';
import { AnalogSourceStrip, type AnalogSourceStripItem } from '../analogSourceStrip.js';

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
const strip = new AnalogSourceStrip(host as unknown as HTMLElement, {
  onFocus: (busId) => focused.push(busId),
});

const items: AnalogSourceStripItem[] = [
  { busId: 'bus-0', name: 'A0', color: '#CD427E', focused: false },
  { busId: 'bus-1', name: 'A1', color: '#00994D', focused: true },
];
strip.render(items);

const root = host.querySelector('.analog-source-strip');
const chips = host.querySelectorAll('.analog-source-chip');

{
  const pressed = chips.map((chip) => chip.getAttribute('aria-pressed'));
  const names = chips.map((chip) => chip.querySelector('.analog-source-name')?.textContent);
  const busses = chips.map((chip) => chip.dataset.busId);
  check('the strip is one labelled group of source chips in row order with pressed state on the focus',
    root !== null && root.getAttribute('role') === 'group' &&
    root.getAttribute('aria-label') === 'Analog sources' && root.hidden === false &&
    chips.length === 2 && busses.join(',') === 'bus-0,bus-1' &&
    names.join(',') === 'A0,A1' && pressed.join(',') === 'false,true' &&
    chips[1]!.className.includes('focused') && !chips[0]!.className.includes('focused'),
    `role=${root?.getAttribute('role')}, label=${root?.getAttribute('aria-label')}, ` +
    `buses=${busses.join(',')}, names=${names.join(',')}, pressed=${pressed.join(',')}`);
}

{
  const labels = chips.map((chip) => chip.getAttribute('aria-label'));
  const swatches = chips.map((chip) => chip.querySelector('.analog-source-swatch')?.style.background);
  check('each chip is a keyboard-reachable button whose accessible name is the focus action and whose swatch carries the source colour',
    chips.every((chip) => chip.localName === 'button' && chip.type === 'button') &&
    labels.join('|') === 'Focus A0|Focus A1' &&
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
  strip.render([
    { busId: 'bus-1', name: 'A1', color: '#00994D', focused: true },
    { busId: 'bus-0', name: 'A0', color: '#CD427E', focused: false },
  ]);
  const second = host.querySelectorAll('.analog-source-chip');
  const swapped = second.map((chip) => `${chip.dataset.busId}:${chip.getAttribute('aria-pressed')}`);
  strip.render([]);
  const hidden = host.querySelector('.analog-source-strip');
  check('a rebuilt strip follows the band order and an empty source list hides the host',
    swapped.join(',') === 'bus-1:true,bus-0:false' &&
    hidden !== null && hidden.hidden === true && hidden.childNodes.length === 0,
    `swapped=${swapped.join(',')}, hidden=${hidden?.hidden}, children=${hidden?.childNodes.length}`);
}

{
  const replayed = host.querySelector('.analog-source-strip');
  const before = replayed?.getAttribute('aria-label');
  strip.render([
    { busId: 'bus-0', name: 'A0', color: '#CD427E', focused: true },
  ]);
  const single = host.querySelectorAll('.analog-source-chip');
  check('a single visible source still renders its chip with the same group label',
    single.length === 1 && single[0]!.getAttribute('aria-pressed') === 'true' &&
    host.querySelector('.analog-source-strip')?.getAttribute('aria-label') === before &&
    host.querySelector('.analog-source-strip')?.hidden === false,
    `chips=${single.length}, label=${before}`);
}

{
  strip.render([
    { busId: 'bus-0', name: 'A0', color: '#CD427E', focused: false },
    { busId: 'bus-1', name: 'A1', color: '#00994D', focused: true },
  ]);
  const chip = host.querySelectorAll('.analog-source-chip')[1]!;
  chip.focus();
  const focusedBefore = doc.activeElement === chip;
  strip.render([
    { busId: 'bus-0', name: 'A0', color: '#CD427E', focused: false },
    { busId: 'bus-1', name: 'A1', color: '#00994D', focused: true },
  ]);
  const after = doc.activeElement as unknown as FakeElement;
  const outside = doc.createElement('button') as unknown as FakeElement;
  doc.body.appendChild(outside as never);
  outside.focus();
  strip.render([
    { busId: 'bus-0', name: 'A0', color: '#CD427E', focused: true },
    { busId: 'bus-1', name: 'A1', color: '#00994D', focused: false },
  ]);
  check('a re-rendered strip keeps keyboard focus on the same source chip and never steals it from outside',
    focusedBefore && after.dataset.busId === 'bus-1' &&
    (doc.activeElement as unknown as FakeElement) === outside,
    `before=${focusedBefore}, after=${after?.dataset.busId}, ` +
    `outside=${(doc.activeElement as unknown as FakeElement) === outside}`);
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
  const sourcesBody = methodBody(app, 'private renderAnalogSources(): void {');
  const stripGate = "this.analogLayout === 'merged'";
  const mergedOnly = sourcesBody.includes(stripGate) &&
    sourcesBody.includes("band.id === MERGED_ANALOG_BAND_ID") &&
    sourcesBody.includes('const sources = merged.sources;');
  const ungated = app.replace(
    stripGate + '\n      ? this.analogRowBands.find((band) => band.id === MERGED_ANALOG_BAND_ID) : undefined;',
    'true ? { sources: this.analogRowBands.flatMap((band) => band.sources) } : undefined;');
  const gatedOf = (source: string): boolean => {
    const body = methodBody(source, 'private renderAnalogSources(): void {');
    return body.includes(stripGate) && body.includes('band.id === MERGED_ANALOG_BAND_ID') &&
      body.includes('const sources = merged.sources;');
  };
  check('the strip lists only the Overlay band\'s participants, so Stacked shows no chips',
    mergedOnly, `mergedOnly=${mergedOnly}`);
  check('control: dropping the Overlay gate lists every band source and its dead focus chips',
    ungated !== app && !gatedOf(ungated) && gatedOf(app),
    `ungated=${gatedOf(ungated)}`);
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
    focusBody.includes('if (!entry || entry.source.group < 0 || busId === this.analogFocusId) return;'),
    `group=${focusBody.includes('entry.source.group < 0')}`);
  const anySourceFocus = app.replace(
    'if (!entry || entry.source.group < 0 || busId === this.analogFocusId) return;',
    'if (!entry || busId === this.analogFocusId) return;');
  check('control: accepting any bus as the focus fails the same predicate',
    anySourceFocus !== app &&
    !methodBody(anySourceFocus, 'private setAnalogFocus(busId: string): void {')
      .includes('entry.source.group < 0'),
    `any=${anySourceFocus.includes('entry.source.group < 0')}`);
  const cellBody = methodBody(app, 'private busCells(): BusCell[] {');
  check('one cell per band shows the focused source at the band height, and only a merged band drops the height grip',
    cellBody.includes('for (const band of this.analogRowBands) {') &&
    cellBody.includes('const source = focusedAnalogSource(band);') &&
    cellBody.includes('cells.push(this.busCell(bus, band.heightCss, band.sources.length <= 1));') &&
    list.includes('if (cell.analog && cell.showHeight !== false) {'),
    `merged=${cellBody.includes('band.sources.length <= 1')}`);
  const gripControl = list.replace(
    'if (cell.analog && cell.showHeight !== false) {', 'if (cell.analog) {');
  const heightControl = app.replace(
    'cells.push(this.busCell(bus, band.heightCss, band.sources.length <= 1));',
    'cells.push(this.busCell(bus, this.rowHeightOf(bus), true));');
  const gripAlways = app.replace(
    'cells.push(this.busCell(bus, band.heightCss, band.sources.length <= 1));',
    'cells.push(this.busCell(bus, band.heightCss, true));');
  check('control: an ungated height grip, a per-source height or a grip on a merged band fails the same predicate',
    gripControl !== list && !gripControl.includes('cell.showHeight !== false') &&
    heightControl !== app && !heightControl.includes('this.busCell(bus, band.heightCss, band.sources.length <= 1)') &&
    gripAlways !== app && !gripAlways.includes('band.sources.length <= 1'),
    `grip=${gripControl.includes('cell.showHeight !== false')}, ` +
    `height=${heightControl.includes('band.heightCss')}, gripAlways=${gripAlways.includes('band.sources.length <= 1')}`);
}

const drawBody = methodBody(app, 'private drawBusRows(');

function mergedTracePasses(source: string): boolean {
  const body = methodBody(source, 'private drawBusRows(');
  return body.includes('const band = this.analogRowBands[analogIndex];') &&
    body.includes('for (const source of band.sources) {') &&
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
    'for (const source of band.sources) {', 'for (const source of band.sources.slice(0, 1)) {');
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
  const menu = methodBody(app, 'private scopeBarMenu(event: MouseEvent, bar: HTMLDivElement): void {');
  const body = menu.length > 0 ? menu : app.slice(app.indexOf('private scopeBarMenu('));
  const layoutItem = body.includes(
    "label: t(this.analogLayout === 'merged' ? 'bus.layoutStacked' : 'bus.layoutMerged'),") &&
    body.includes("onPick: () => this.setAnalogLayout(this.analogLayout === 'merged' ? 'stacked' : 'merged'),");
  check('the ruler menu picks the same layout setter as Appearance',
    layoutItem, `menu=${layoutItem}`);
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
  const layoutNames = ['bus.layoutStacked', 'bus.layoutMerged', 'bus.sourceStrip', 'bus.focusSource'];
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
    sheet.includes('.settings-row-select { grid-template-columns: minmax(0, 1fr); }'),
    `sheet=${sheet.includes('.analog-source-strip {')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
