// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Exact checks for the channel table's viewport arithmetic.
 *
 *   node_modules/.bin/esbuild src/ui/tools/channel-layout-selftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/channel-layout-selftest.mjs
 *   node /tmp/channel-layout-selftest.mjs
 *
 * Expected heights are literal values rather than a second copy of the clamp formula,
 * so removing a clamp or changing the lane reservation turns a check red. The final
 * source guard proves that App.relayout uses this policy instead of a parallel inline
 * implementation.
 */

import { computeChannelRowHeight } from '../channelLayout.js';
import { ROWS } from '../metrics.js';
import { DEFAULT_TRIGGER_MODE, modesToConditions, triggerModeFromCondition,
  type TriggerCondition, type TriggerMode } from '../state.js';

/** Same node access idiom as the other UI self-tests, without requiring @types/node. */
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(p: string, enc: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function expectHeight(
  name: string,
  plotHeightCss: number,
  channelCount: number,
  laneCount: number,
  expected: number,
): void {
  const actual = computeChannelRowHeight(plotHeightCss, channelCount, laneCount);
  check(name, actual === expected,
    `plot=${plotHeightCss}, channels=${channelCount}, lanes=${laneCount}: ` +
    `expected=${expected}, actual=${actual}`);
}

expectHeight('available height is divided evenly across channel rows', 600, 10, 0, 60);
expectHeight('fractional fitted heights floor to an integral CSS pitch', 609, 10, 0, 60);
expectHeight('a sparse stack stops growing at the 72px maximum', 1000, 1, 0, 72);
expectHeight('annotation lanes are reserved before row division', 600, 10, 5, 50);
expectHeight('a short 32-channel stack clamps to the 48px minimum', 120, 32, 0, 48);
expectHeight('annotation lanes cannot push a channel below the minimum', 200, 32, 3, 48);

{
  const atBoundary = computeChannelRowHeight(1536, 32, 0);
  const belowBoundary = computeChannelRowHeight(1535, 32, 0);
  const stackAtMinimum = 32 * atBoundary;
  const pass = atBoundary === 48 && belowBoundary === 48 && stackAtMinimum === 1536 &&
    stackAtMinimum > 1535;
  check('32 channels cross from exact fit to scroll overflow at 1536px',
    pass, `at1536=${atBoundary}, at1535=${belowBoundary}, stack=${stackAtMinimum}`);
}

{
  const base = computeChannelRowHeight(200, 32, 3);
  const laneTotal = 3 * ROWS.laneHeight;
  const stackTotal = 32 * base + laneTotal;
  const pass = base === 48 && ROWS.laneHeight === 20 && laneTotal === 60 &&
    stackTotal === 1596 && stackTotal - laneTotal === 1536 && stackTotal > 200;
  check('lane heights add to the minimum 32-channel trace stack',
    pass, `base=${base}, lanes=${laneTotal}, total=${stackTotal}, viewport=200`);
}

{
  const cases: { mode: TriggerMode; conditions: TriggerCondition[] }[] = [
    { mode: 'falling', conditions: [{ channel: 0, kind: 'falling', level: 1 }] },
    { mode: 'rising', conditions: [{ channel: 0, kind: 'rising', level: 1 }] },
    { mode: 'edge', conditions: [{ channel: 0, kind: 'edge', level: 1 }] },
    { mode: 'high', conditions: [{ channel: 0, kind: 'level', level: 1 }] },
    { mode: 'low', conditions: [{ channel: 0, kind: 'level', level: 0 }] },
    { mode: 'dont-care', conditions: [] },
  ];
  const bad = cases.filter(({ mode, conditions }) => {
    const actual = modesToConditions({ 0: mode });
    if (JSON.stringify(actual) !== JSON.stringify(conditions)) return true;
    return conditions.length === 1 && triggerModeFromCondition(conditions[0]!) !== mode;
  });
  check('all six trigger modes map exactly and every condition round-trips',
    bad.length === 0,
    bad.length === 0 ? 'falling/rising/edge/high/low/X mappings and round-trips match'
      : bad.map(({ mode }) => `${mode}: ${JSON.stringify(modesToConditions({ 0: mode }))}`).join('; '));

  const mixed = modesToConditions({ 3: 'falling', 1: 'edge', 0: 'high', 2: 'dont-care' });
  const expectedMixed: TriggerCondition[] = [
    { channel: 0, kind: 'level', level: 1 },
    { channel: 1, kind: 'edge', level: 1 },
    { channel: 3, kind: 'falling', level: 1 },
  ];
  check('mixed trigger modes stay sorted and any-value adds no condition',
    JSON.stringify(mixed) === JSON.stringify(expectedMixed),
    `actual=${JSON.stringify(mixed)}`);

  check('the shared unconfigured trigger default is any value',
    DEFAULT_TRIGGER_MODE === 'dont-care' && modesToConditions({ 0: DEFAULT_TRIGGER_MODE }).length === 0,
    `default=${DEFAULT_TRIGGER_MODE}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const importsPolicy = app.includes("import { computeChannelRowHeight } from './channelLayout.js';");
  const delegates = app.includes(
    'const base = computeChannelRowHeight(plotH, enabled.length, this.lanes.length);',
  );
  const duplicateClamp = app.includes('Math.max(ROWS.minRowHeight');
  check('App.relayout delegates to the tested policy without a duplicate clamp',
    importsPolicy && delegates && !duplicateClamp,
    `import=${importsPolicy}, delegates=${delegates}, duplicateClamp=${duplicateClamp}`);

  const channelList = fs.readFileSync('src/ui/channelList.ts', 'utf8');
  const rowStart = channelList.indexOf('export class ChannelList');
  const rowSource = channelList.slice(rowStart, channelList.indexOf('function triggerModeName'));
  const dialogSource = channelList.slice(0, rowStart);
  const rowSimplified = !rowSource.includes('ch-enable') && !rowSource.includes('ch-trigger') &&
    !rowSource.includes("const name = document.createElement('input')");
  const readOnlyEntry = rowSource.includes("const name = document.createElement('span')") &&
    rowSource.includes("name.textContent = cell.channel.name") &&
    rowSource.includes("settings.className = 'ch-settings'") &&
    rowSource.includes('this.settingsDialog.open(settings, cell)');
  check('channel rows keep only a read-only name and gear settings entry',
    rowStart >= 0 && rowSimplified && readOnlyEntry,
    `rowStart=${rowStart}, simplified=${rowSimplified}, readOnlyEntry=${readOnlyEntry}`);

  const exactModes = "const TRIGGER_MODES: readonly TriggerMode[] = ['falling', 'rising', 'edge', 'high', 'low', 'dont-care'];";
  const nativeModal = dialogSource.includes("document.createElement('dialog')") &&
    dialogSource.includes('this.dialog.showModal();') &&
    dialogSource.includes("this.dialog.setAttribute('aria-labelledby', 'channel-settings-title')");
  const oneSavePath = dialogSource.includes("form.addEventListener('submit', this.onSubmit)") &&
    dialogSource.includes('this.onConfigure(channel, config);') &&
    dialogSource.includes('this.onSaved(channel);');
  check('channel dialog uses one native-modal save path with all six modes',
    dialogSource.includes(exactModes) && nativeModal && oneSavePath,
    `modes=${dialogSource.includes(exactModes)}, native=${nativeModal}, save=${oneSavePath}`);

  const kvRows = (dialogSource.match(/channel-settings-field channel-settings-kv/g) ?? []).length === 2 &&
    dialogSource.includes("this.triggerFieldset.setAttribute('aria-labelledby', this.triggerLabel.id)") &&
    dialogSource.includes("div('channel-settings-field channel-settings-color-field')") &&
    dialogSource.includes('fields.append(nameField, triggerField, colorField);');
  check('name and trigger use KV rows while color stays vertical and last',
    kvRows,
    `nameTriggerRows=${(dialogSource.match(/channel-settings-field channel-settings-kv/g) ?? []).length}, colorLast=${dialogSource.includes('fields.append(nameField, triggerField, colorField);')}`);

  const colorGrid = dialogSource.includes('for (const color of CHANNEL_COLOR_PRESETS)') &&
    dialogSource.includes('colorGrid.appendChild(this.customColorButton);') &&
    dialogSource.includes("this.colorPalette.setAttribute('popover', 'auto');") &&
    dialogSource.includes("this.customColorButton.setAttribute('popovertarget', this.colorPalette.id);") &&
    dialogSource.includes('colorField.append(this.colorLabel, colorGrid, this.colorPalette);') &&
    dialogSource.includes('this.selectedColor = cell.channel.color;') &&
    dialogSource.includes('color: this.selectedColor,');
  check('15 presets plus one custom Popover keep the existing atomic color payload',
    colorGrid,
    `presetGridAndCustomPopover=${colorGrid}`);

  const descriptionRemoved = !dialogSource.includes('aria-describedby') &&
    !dialogSource.includes('channel-settings-description') &&
    !dialogSource.includes('channels.dialogDescription') &&
    dialogSource.includes("this.dialog.setAttribute('aria-labelledby', 'channel-settings-title')");
  check('channel dialog removes its description but keeps its visible title relationship',
    descriptionRemoved,
    `descriptionRemoved=${descriptionRemoved}`);

  const dualEdgeGlyph = channelList.includes("mode === 'edge' ? t('trigger.anyEdge')") &&
    channelList.includes("mode === 'edge' ? 'M1 12H5V4H10M14 4H19V12H23'") &&
    channelList.includes("path.setAttribute('stroke-linejoin', 'round')");
  check('dual-edge has a translated accessible name and a redesigned stepped glyph',
    dualEdgeGlyph,
    `dualEdgeGlyph=${dualEdgeGlyph}`);

  const noGlobalListeners = !channelList.includes('document.addEventListener') &&
    !channelList.includes('window.addEventListener');
  const discardPaths = dialogSource.includes("this.dialog.addEventListener('cancel'") &&
    dialogSource.includes('if (event.target === this.dialog) {') &&
    dialogSource.includes("this.cancelButton.addEventListener('click', () => this.dismiss(true))");
  check('dialog dismissal paths need no document or window listeners',
    noGlobalListeners && discardPaths,
    `noGlobalListeners=${noGlobalListeners}, discardPaths=${discardPaths}`);

  const backdropFocus = dialogSource.includes('event.preventDefault();\n        this.dismiss(true);');
  check('backdrop pointerdown cannot retarget focus after dismissal',
    backdropFocus,
    `preventDefaultBeforeDismiss=${backdropFocus}`);

  const capturePanel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const waveformStack = fs.readFileSync('src/ui/waveformStack.ts', 'utf8');
  const cardColors = rowSource.includes('strip.style.background = cell.channel.color') &&
    rowSource.includes('tag.style.color = cell.channel.color');
  const chipColors = capturePanel.includes('chip.style.background = c.color') &&
    capturePanel.includes('chip.style.color = c.color') &&
    !capturePanel.includes('channelColor(c.index)');
  const appPalette = app.includes('const channelColors = this.channels.map((channel) => channel.color)') &&
    app.includes('this.stack.setRows(rows, channelColors);') &&
    app.includes('color: this.channels[ch]?.color ?? channelColor(ch)');
  const rendererPalette = waveformStack.includes(
    'const theme = { ...DARK_THEME, channelColors: this.channelColors };') &&
    waveformStack.includes('r.setTheme(theme);');
  check('custom color flows from channel state through cards, chips, hover, and renderers',
    cardColors && chipColors && appPalette && rendererPalette,
    `card=${cardColors}, chips=${chipColors}, app=${appPalette}, renderers=${rendererPalette}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
