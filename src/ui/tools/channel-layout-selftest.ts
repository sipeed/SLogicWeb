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
import { analogFrame, type BusViewState } from '../busView.js';
import { BusBuilder, PlanarSampleStore, type BusSpec } from '../../data/index.js';
import { DEFAULT_TRIGGER_MODE, edgeTriggerAutoArms, isEdgeTriggerMode, modesToConditions,
  clampLoopSeconds, loopDropSamples, loopRetentionSamples, maxLoopSeconds, triggerModeFromCondition,
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
  const expected: { mode: TriggerMode; edge: boolean }[] = [
    { mode: 'falling', edge: true },
    { mode: 'rising', edge: true },
    { mode: 'edge', edge: true },
    { mode: 'high', edge: false },
    { mode: 'low', edge: false },
    { mode: 'dont-care', edge: false },
  ];
  const bad = expected.filter(({ mode, edge }) => isEdgeTriggerMode(mode) !== edge);
  check('only rising, falling, and dual-edge modes are edge trigger modes',
    bad.length === 0,
    bad.length === 0 ? 'rising/falling/edge true; high/low/any-value false'
      : bad.map(({ mode, edge }) => `${mode}: expected=${edge}, ` +
        `actual=${isEdgeTriggerMode(mode)}`).join('; '));

  const degraded = (mode: TriggerMode): boolean => mode !== 'dont-care';
  const disagreements = expected.filter(({ mode }) => degraded(mode) !== isEdgeTriggerMode(mode));
  check('the edge predicate is narrower than a coarse any-non-default control',
    disagreements.length > 0,
    `degraded disagreements=${disagreements.map(({ mode }) => mode).join(',')}`);
}

{
  const rows: { previous: TriggerMode; committed: TriggerMode; mask: boolean; arms: boolean }[] = [
    { previous: 'dont-care', committed: 'rising', mask: false, arms: true },
    { previous: 'dont-care', committed: 'falling', mask: false, arms: true },
    { previous: 'dont-care', committed: 'edge', mask: false, arms: true },
    { previous: 'high', committed: 'rising', mask: false, arms: true },
    { previous: 'low', committed: 'edge', mask: false, arms: true },
    { previous: 'rising', committed: 'falling', mask: false, arms: true },
    { previous: 'rising', committed: 'edge', mask: false, arms: true },
    { previous: 'rising', committed: 'rising', mask: false, arms: false },
    { previous: 'edge', committed: 'edge', mask: false, arms: false },
    { previous: 'rising', committed: 'high', mask: false, arms: false },
    { previous: 'rising', committed: 'dont-care', mask: false, arms: false },
    { previous: 'high', committed: 'low', mask: false, arms: false },
    { previous: 'dont-care', committed: 'rising', mask: true, arms: false },
    { previous: 'rising', committed: 'rising', mask: true, arms: false },
  ];
  const bad = rows.filter(({ previous, committed, mask, arms }) =>
    edgeTriggerAutoArms(previous, committed, mask) !== arms);
  check('auto-arm needs a mode transition into an edge mode with the mask off',
    bad.length === 0,
    bad.length === 0 ? 'transitions into an edge mode with the mask off arm; unchanged modes, level modes, and an armed mask do not'
      : bad.map(({ previous, committed, mask, arms }) => `mask=${mask}, ${previous}->${committed}: ` +
        `expected=${arms}, actual=${edgeTriggerAutoArms(previous, committed, mask)}`).join('; '));
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

  const configureStart = app.indexOf('private configureChannel(');
  const configureEnd = configureStart >= 0
    ? app.indexOf('\n  private ', configureStart + 1) : -1;
  const configureSource = configureEnd > configureStart
    ? app.slice(configureStart, configureEnd) : '';
  const armsOnEdge = configureSource.includes('edgeTriggerAutoArms(previous, config.mode') &&
    configureSource.includes('triggerEnableMask: true');
  const storedPrevious = configureSource.includes('triggerModes[channel] ?? DEFAULT_TRIGGER_MODE');
  const noAutoDisarm = configureSource.length > 0 &&
    !configureSource.includes('triggerEnableMask: false');
  check('the dialog commit path arms the mask when an edge mode is committed',
    armsOnEdge && storedPrevious && noAutoDisarm,
    `slice=${configureSource.length}, armsOnEdge=${armsOnEdge}, ` +
    `storedPrevious=${storedPrevious}, noAutoDisarm=${noAutoDisarm}`);

  const clampStart = app.indexOf('function clampSettings(');
  const clampEnd = clampStart >= 0 ? app.indexOf('\n}\n', clampStart) : -1;
  const clampSource = clampEnd > clampStart ? app.slice(clampStart, clampEnd) : '';
  const clampAutoArm = clampSource.includes('edgeTriggerAutoArms');
  check('clampSettings stays a pure clamp with no auto-arm invariant',
    clampSource.length > 0 && !clampAutoArm,
    `slice=${clampSource.length}, autoArmInClamp=${clampAutoArm}`);

  const shortcutStart = app.indexOf("window.addEventListener('keydown', (e) => {");
  const shortcutEnd = shortcutStart >= 0 ? app.indexOf('\n    });', shortcutStart) : -1;
  const shortcutBody = shortcutEnd > shortcutStart
    ? app.slice(shortcutStart, shortcutEnd) : '';
  const dialogGuardIndex = shortcutBody.indexOf("closest('dialog[open]') !== null");
  const shortcutActions = [
    shortcutBody.indexOf("e.key === 'f'"),
    shortcutBody.indexOf("e.key === ' '"),
    shortcutBody.indexOf("e.key === 'Escape'"),
  ];
  const dialogGuard = dialogGuardIndex >= 0 &&
    shortcutActions.every((index) => index > dialogGuardIndex);
  check('app-level shortcuts stay out of an open dialog',
    dialogGuard,
    `guard@${dialogGuardIndex}, actions=${JSON.stringify(shortcutActions)}, ` +
    `body=${shortcutBody.length}`);

  const channelList = fs.readFileSync('src/ui/channelList.ts', 'utf8');
  const rowStart = channelList.indexOf('export class ChannelList');
  const rowSource = channelList.slice(rowStart, channelList.indexOf('function triggerModeName'));
  const dialogSource = channelList.slice(0, rowStart);
  const rowSimplified = !rowSource.includes('ch-enable') && !rowSource.includes('ch-trigger') &&
    !rowSource.includes("const name = document.createElement('input')");
  const readOnlyEntry = rowSource.includes("const tag = document.createElement('span')") &&
    rowSource.includes('tag.textContent = cell.channel.name') &&
    !rowSource.includes("'ch-name'") &&
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

  const nameReset = dialogSource.includes("const nameControl = div('channel-settings-name-control');") &&
    dialogSource.includes("this.resetNameButton = button('', 'channel-name-reset');") &&
    dialogSource.includes("this.resetNameButton.type = 'button';") &&
    dialogSource.includes('nameControl.append(this.nameInput, this.resetNameButton);') &&
    dialogSource.includes('nameField.append(this.nameLabel, nameControl);') &&
    dialogSource.includes('this.nameInput.value = defaultChannelName(this.channel);') &&
    dialogSource.includes("this.resetNameButton.addEventListener('click', () => {");
  check('the name control pairs the input with an explicit-type draft reset button',
    nameReset,
    `resetControl=${nameReset}`);

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

  const styleSheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const staticFill = !dialogSource.includes('customColorButton.style.background') &&
    /\.channel-color-custom\s*\{[^}]*background:\s*var\(--bg20\)/.test(styleSheet) &&
    /html\[data-theme="light"\]\s+\.channel-color-custom\s*\{[^}]*background:\s*var\(--bg30\)/.test(styleSheet);
  const markBody = styleSheet.match(/\.channel-color-custom-mark\s*\{([^}]*)\}/)?.[1] ?? '';
  const bareMark = markBody.includes('color: var(--foreground)') &&
    !markBody.includes('background') && !markBody.includes('border');
  check('the custom swatch keeps a static brighter fill and a bare foreground plus',
    staticFill && bareMark,
    `staticFill=${staticFill}, bareMark=${bareMark}`);

  const pickerStructure = dialogSource.includes('new HsvPicker(') &&
    dialogSource.includes("this.customColorButton.setAttribute('popovertarget', this.colorPalette.id)") &&
    dialogSource.includes('this.colorPalette.appendChild(this.colorPicker.element)') &&
    dialogSource.includes("this.colorPalette.setAttribute('aria-label', t('channels.customColor'))") &&
    dialogSource.includes('this.colorPicker.renderStrings();') &&
    !dialogSource.includes('CHANNEL_PALETTE_COLORS') &&
    !dialogSource.includes('showPicker') &&
    !dialogSource.includes('moreColorsButton') &&
    !dialogSource.includes('paletteSwatches') &&
    !/\.type\s*=\s*'color'/.test(dialogSource);
  check('the custom swatch opens an in-app HSV picker with no matrix or native input',
    pickerStructure,
    `pickerStructure=${pickerStructure}`);

  const toggleStart = dialogSource.indexOf("this.colorPalette.addEventListener('toggle'");
  const toggleEnd = toggleStart >= 0 ? dialogSource.indexOf('\n    });', toggleStart) : -1;
  const toggleBody = toggleEnd > toggleStart ? dialogSource.slice(toggleStart, toggleEnd) : '';
  const initIndex = toggleBody.indexOf('this.colorPicker.setColor(this.selectedColor)');
  const focusIndex = toggleBody.indexOf('this.colorPicker.focus()');
  const pickerLifecycle = initIndex >= 0 && focusIndex > initIndex &&
    toggleBody.includes(':popover-open') &&
    toggleBody.includes('this.colorPicker.endDrag();') &&
    dialogSource.includes('this.selectedColor = hex;') &&
    dialogSource.includes('this.syncColorSelection();');
  check('the picker initializes before focus on open and ends drags on close',
    pickerLifecycle,
    `init@${initIndex}, focus@${focusIndex}, lifecycle=${pickerLifecycle}`);

  const focusoutClose = dialogSource.includes("this.colorPalette.addEventListener('focusout'") &&
    dialogSource.includes('event.relatedTarget') &&
    dialogSource.includes('this.colorPalette.contains(next)') &&
    dialogSource.includes('this.hideColorPalette();');
  check('the picker closes when keyboard focus leaves it',
    focusoutClose,
    `focusoutClose=${focusoutClose}`);

  const pickerSheet = /\.channel-color-field\s*\{[^}]*width:\s*100%/.test(styleSheet) &&
    /\.channel-color-hue\s*\{[^}]*height:\s*12px/.test(styleSheet) &&
    /\.channel-color-preview\s*\{[^}]*display:\s*grid/.test(styleSheet) &&
    /\.channel-color-palette\s*\{[^}]*width:\s*252px/.test(styleSheet);
  check('the picker keeps the popover geometry and full-width themed widgets',
    pickerSheet,
    `pickerSheet=${pickerSheet}`);

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
    !rowSource.includes('tag.style.color');
  const chipColors = capturePanel.includes('chip.style.background = c.color') &&
    capturePanel.includes('chip.style.borderColor = c.color') &&
    !capturePanel.includes('chip.style.color = c.color') &&
    !capturePanel.includes('channelColor(c.index)');
  const appPalette = app.includes('const channelColors = this.channels.map((channel) => channel.color)') &&
    app.includes('this.stack.setRows(rows, channelColors);') &&
    app.includes('color: this.channels[ch]?.color ?? channelColor(ch)');
  const rendererPalette = waveformStack.includes(
    'const theme = { ...this.baseTheme, channelColors: this.channelColors };') &&
    waveformStack.includes('r.setTheme(theme);');
  check('custom color flows from channel state through cards, chips, hover, and renderers',
    cardColors && chipColors && appPalette && rendererPalette,
    `card=${cardColors}, chips=${chipColors}, app=${appPalette}, renderers=${rendererPalette}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const overlay = fs.readFileSync('src/ui/overlay.ts', 'utf8');
  const noLegacyColorReads = !/\bCOLORS\./.test(overlay);
  const gridReads = overlay.match(/\bGRID\./g) ?? [];
  const gridGeometryOnly = gridReads.length === 2 &&
    overlay.includes('GRID.dash') && overlay.includes('GRID.width');
  check('overlay paints from the injected palette only (GRID limited to dash and width)',
    noLegacyColorReads && gridGeometryOnly,
    `noLegacyColorReads=${noLegacyColorReads}, gridReads=${gridReads.length}, gridGeometryOnly=${gridGeometryOnly}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const overlay = fs.readFileSync('src/ui/overlay.ts', 'utf8');

  const gate = app.includes("if (this.captureLabel.kind === 'demo') {");
  const channelRowLookup = app.includes(
    "const channelRow = boxes.find((b) => b.spec.kind === 'channel');");
  const rowHeightPassed = app.includes(
    'if (channelRow) this.overlay.drawDemoWatermark(channelRow.height);');
  const noMetricSubstitute = !app.includes('drawDemoWatermark(ROWS.');
  const singleCallSite = (app.match(/this\.overlay\.drawDemoWatermark\(/g) ?? []).length === 1;
  check('the demo gate feeds a live channel row height to the watermark',
    gate && channelRowLookup && rowHeightPassed && noMetricSubstitute && singleCallSite,
    `gate=${gate}, channelRow=${channelRowLookup}, rowHeight=${rowHeightPassed}, ` +
    `noMetricSubstitute=${noMetricSubstitute}, singleCallSite=${singleCallSite}`);

  const signature = 'drawDemoWatermark(channelHeightCss: number): void {';
  const methodStart = overlay.indexOf(signature);
  const methodEnd = overlay.indexOf('\n  }\n', methodStart);
  const body = methodStart >= 0 && methodEnd > methodStart
    ? overlay.slice(methodStart, methodEnd) : '';
  const fontScale = body.includes(
    'c.font = `600 ${channelHeightCss * 2}px -apple-system, BlinkMacSystemFont, sans-serif`;');
  const noLaneHeight = !body.includes('laneHeight') && !body.includes('ROWS.');
  check('the watermark font is exactly twice the passed channel-row height',
    methodStart >= 0 && fontScale && noLaneHeight,
    `method=${methodStart >= 0}, fontScale=${fontScale}, noLaneHeight=${noLaneHeight}`);

  const alpha = body.includes('c.globalAlpha = 0.12;');
  const color = body.includes('c.fillStyle = this.palette.text80;');
  const center = body.includes("c.textAlign = 'center';") &&
    body.includes("c.textBaseline = 'middle';");
  const anchor = body.includes("c.fillText('DEMO', this.wCss / 2, this.hCss / 2);");
  check('the watermark is translucent, text80, centered text at the overlay center',
    alpha && color && center && anchor,
    `alpha=${alpha}, color=${color}, center=${center}, anchor=${anchor}`);

  const saves = (body.match(/c\.save\(\);/g) ?? []).length;
  const restores = (body.match(/c\.restore\(\);/g) ?? []).length;
  const savesFirst = body.includes('const c = this.ctx;\n    c.save();');
  const scoped = saves === 1 && restores === 1 && savesFirst &&
    body.trimEnd().endsWith('c.restore();');
  check('the watermark scopes every canvas state change in save/restore',
    scoped, `saves=${saves}, restores=${restores}, savesFirst=${savesFirst}`);

  const surfaceStart = app.indexOf('private drawLaneSurfaces(');
  const bubbleStart = app.indexOf('private drawLaneBubbles(');
  const laneForStart = app.indexOf('private laneFor(');
  const surfaceSource = surfaceStart >= 0 && bubbleStart > surfaceStart
    ? app.slice(surfaceStart, bubbleStart) : '';
  const bubbleSource = bubbleStart >= 0 && laneForStart > bubbleStart
    ? app.slice(bubbleStart, laneForStart) : '';
  const surfacePass = surfaceSource.includes('this.overlay.fillLane(box.top, box.height);') &&
    surfaceSource.includes("if (box.spec.kind !== 'lane') continue;") &&
    !surfaceSource.includes('drawBubbles');
  const bubblePass = bubbleSource.includes(
    'this.overlay.drawBubbles(bubbles, box.top, lane.analyzer.color);') &&
    !bubbleSource.includes('fillLane') && !bubbleSource.includes('drawDemoWatermark');
  check('lane surface filling is a separate pass from bubble painting',
    surfacePass && bubblePass && !app.includes('this.drawLanes('),
    `surface=${surfacePass}, bubbles=${bubblePass}, oldPass=${app.includes('this.drawLanes(')}`);

  const drawStart = app.indexOf('private draw(): void {');
  const drawEnd = app.indexOf('private drawAxisCanvas(');
  const drawSource = drawStart >= 0 && drawEnd > drawStart
    ? app.slice(drawStart, drawEnd) : '';
  const paintOrder = [
    'this.overlay.beginFrame();',
    'this.overlay.drawGrid(ticks);',
    'this.drawLaneSurfaces(boxes);',
    'this.overlay.drawDemoWatermark(channelRow.height);',
    'this.overlay.drawLevels(',
    'this.drawLaneBubbles(boxes, wCss);',
    'this.overlay.drawTrigger(',
    'this.overlay.drawLiveEdge(',
    'this.markerA.draw(this.overlay,',
    'this.overlay.drawHover(this.hover);',
  ];
  const positions = paintOrder.map((needle) => drawSource.indexOf(needle));
  const ordered = positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!));
  check('paint order is grid, lane surfaces, watermark, levels, overlays',
    drawSource.length > 0 && ordered,
    `positions=${positions.join(',')}`);
}

{
  const secondsTable: Array<[number, number, number, number]> = [
    [1, 16, 16e6, 1],
    [0.0005, 16, 16e6, 0.001],
    [Number.NaN, 16, 16e6, 1],
    [Number.POSITIVE_INFINITY, 16, 16e6, 33.554],
    [Number.NEGATIVE_INFINITY, 16, 16e6, 0.001],
    [-5, 16, 16e6, 0.001],
    [0, 16, 16e6, 0.001],
    [1.2346, 16, 16e6, 1.234],
    [100, 16, 16e6, 33.554],
    [100, 8, 400e6, 1.342],
  ];
  const secondsBad = secondsTable
    .filter(([v, ch, sr, want]) => clampLoopSeconds(v, ch as 16 | 8, sr) !== want)
    .map(([v, ch, sr, want]) => `${v}@${ch}ch/${sr}: want ${want}, got ${clampLoopSeconds(v, ch as 16 | 8, sr)}`);
  check('clampLoopSeconds clamps to the 1 ms floor and the memory budget',
    secondsBad.length === 0,
    secondsBad.length === 0 ? `${secondsTable.length} exact cases` : secondsBad.join('; '));

  const samplesTable: Array<[number, number, number, number]> = [
    [1, 16, 16e6, 16_000_000],
    [0.001, 8, 400e6, 399_872],
    [0.000001, 8, 100, 512],
    [100, 16, 16e6, 536_863_744],
    [100, 8, 400e6, 536_799_744],
  ];
  const samplesBad = samplesTable
    .filter(([v, ch, sr, want]) => loopRetentionSamples(v, ch as 16 | 8, sr) !== want)
    .map(([v, ch, sr, want]) => `${v}@${ch}ch/${sr}: want ${want}, got ${loopRetentionSamples(v, ch as 16 | 8, sr)}`);
  check('loopRetentionSamples quantises to the drop quantum with a one-quantum floor',
    samplesBad.length === 0,
    samplesBad.length === 0 ? `${samplesTable.length} exact cases` : samplesBad.join('; '));

  const ceilingBad = ([[4, 800e6], [8, 400e6], [8, 200e6], [16, 200e6], [16, 16e6]] as const)
    .filter(([ch, sr]) =>
      2 * loopRetentionSamples(maxLoopSeconds(ch, sr), ch, sr) + (1 << 25) >= 2 ** 31);
  check('the advertised loop maxima stay below the 2^31 store ceiling with hysteresis headroom',
    ceilingBad.length === 0,
    ceilingBad.length === 0
      ? '2x retention plus a sink chunk < 2^31 at every advertised maximum'
      : `violates: ${ceilingBad.map(([ch, sr]) => `${ch}ch/${sr}`).join(', ')}`);

  const sweepBad: string[] = [];
  for (const v of [0.0001, 0.001, 0.5, 1, 7.3, 33.554, 33.555, 100, 1e6]) {
    for (const [ch, sr] of [[16, 16e6], [8, 400e6], [4, 800e6]] as const) {
      const got = clampLoopSeconds(v, ch, sr);
      const max = maxLoopSeconds(ch, sr);
      if (!(got <= max)) sweepBad.push(`${v}@${ch}ch/${sr}: ${got} > ${max}`);
    }
  }
  check('clampLoopSeconds never exceeds the budget ceiling',
    sweepBad.length === 0,
    sweepBad.length === 0 ? '9 values x 3 geometries all at or under the ceiling' : sweepBad.join('; '));

  const dropTable: Array<[number, number, number]> = [
    [319_487, 159_744, 0],
    [319_488, 159_744, 159_744],
    [319_999, 159_744, 159_744],
    [320_000, 159_744, 160_256],
    [100, 0, 0],
    [-50, 159_744, 0],
  ];
  const dropBad = dropTable
    .filter(([len, ret, want]) => loopDropSamples(len, ret) !== want)
    .map(([len, ret, want]) => `(${len}, ${ret}): want ${want}, got ${loopDropSamples(len, ret)}`);
  const quantumOk = dropTable.every(([len, ret]) => loopDropSamples(len, ret) % 512 === 0);
  check('loopDropSamples drops only past 2x retention, floored to the quantum',
    dropBad.length === 0 && quantumOk,
    dropBad.length === 0
      ? `${dropTable.length} exact cases, every result a multiple of 512`
      : dropBad.join('; '));

  const loopFs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!loopFs || typeof loopFs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const panel = loopFs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const panelLoop = panel.includes("['loop', t('capturePanel.loop')]") &&
    panel.includes('loopRetentionSamples(') &&
    panel.includes('maxLoopSeconds(') &&
    panel.includes('loopRetentionSamples(maxLoop');
  check('the capture panel offers loop mode with the shared retention helpers',
    panelLoop,
    `segment=${panel.includes("['loop', t('capturePanel.loop')]")}, ` +
    `helper=${panel.includes('loopRetentionSamples(')}, max=${panel.includes('maxLoopSeconds(')}, ` +
    `budgetDerived=${panel.includes('loopRetentionSamples(maxLoop')}`);

  const appSrc = loopFs.readFileSync('src/ui/app.ts', 'utf8');
  const startStart = appSrc.indexOf('private async startCapture(');
  const startEnd = startStart >= 0 ? appSrc.indexOf('private enforceLoopRetention', startStart) : -1;
  const startSrc = startEnd > startStart ? appSrc.slice(startStart, startEnd) : '';
  const flagReset = startSrc.indexOf('startMutatedCapture = false');
  const firstRefusal = startSrc.indexOf('clips the DAC');
  const flagSet = startSrc.indexOf('startMutatedCapture = true');
  check('startCapture resets its mutation flag before the early refusals and sets it after them',
    startSrc.length > 0 && flagReset >= 0 && firstRefusal > flagReset && flagSet > firstRefusal,
    `slice=${startSrc.length}, reset=${flagReset}, refusal=${firstRefusal}, set=${flagSet}`);

  const segMatrix =
    panel.includes("id === 'loop' && (v.running || v.stopping || s.channels === 32)") &&
    panel.includes("id !== 'loop' && s.mode === 'loop' && (v.running || v.stopping)");
  const decodeGuard = appSrc.includes('(this.running || this.stopping) && this.captureIsLoop');
  check('the decode guard covers the loop stop drain',
    decodeGuard,
    `guard=${decodeGuard}`);
  const progressSplit =
    appSrc.includes('samples: this.captureIsLoop ? this.store.length + this.droppedTotal : this.store.length') &&
    appSrc.includes('bytesPerSampleForChannels(this.store.channelCount)');
  check('progressView splits loop totals from retained bytes',
    progressSplit,
    `total=${appSrc.includes('samples: this.captureIsLoop ? this.store.length + this.droppedTotal : this.store.length')}, ` +
    `retained=${appSrc.includes('bytesPerSampleForChannels(this.store.channelCount)')}`);
  check('the mode segment disable matrix locks loop while running or at 32ch',
    segMatrix,
    `loopClause=${panel.includes("id === 'loop' && (v.running || v.stopping || s.channels === 32)")}, ` +
    `escapeClause=${panel.includes("id !== 'loop' && s.mode === 'loop' && (v.running || v.stopping)")}`);

  const pumpStart = appSrc.indexOf('private pumpBusBuilders');
  const pumpEnd = pumpStart >= 0 ? appSrc.indexOf('private drawBusRows', pumpStart) : -1;
  const pumpSrc = pumpEnd > pumpStart ? appSrc.slice(pumpStart, pumpEnd) : '';
  check('the bus builder pump follows a running capture',
    pumpSrc.length > 0 &&
    pumpSrc.includes('if (this.stopping || this.store.length === 0) return;') &&
    pumpSrc.includes('b.builder.setLength(store.length);') &&
    !pumpSrc.includes('if (this.running) b.builder.setLength') &&
    pumpSrc.includes('b.builder.step(this.running ? 4 : 6)') &&
    pumpSrc.includes('this.captureIsLoop ? this.loopRetentionLen * 2 : store.length'),
    `guard=${pumpSrc.includes('if (this.stopping || this.store.length === 0) return;')}, ` +
    `setLength=${pumpSrc.includes('b.builder.setLength(store.length);')}, ` +
    `unguarded=${!pumpSrc.includes('if (this.running) b.builder.setLength')}, ` +
    `budget=${pumpSrc.includes('b.builder.step(this.running ? 4 : 6)')}, ` +
    `hint=${pumpSrc.includes('this.captureIsLoop ? this.loopRetentionLen * 2 : store.length')}`);

  const enforceStart = appSrc.indexOf('private enforceLoopRetention');
  const enforceEnd = enforceStart >= 0 ? appSrc.indexOf('private async stopCapture', enforceStart) : -1;
  const enforceSrc = enforceEnd > enforceStart ? appSrc.slice(enforceStart, enforceEnd) : '';
  check('a retention drop resets bus builders and invalidates their frame caches',
    enforceSrc.includes('b.builder?.reset(store.length);') && enforceSrc.includes('b.cache = null;'),
    `reset=${enforceSrc.includes('b.builder?.reset(store.length);')}, cache=${enforceSrc.includes('b.cache = null;')}`);

  const adcStore = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
  const adcWords = new Uint16Array(40_000);
  for (let i = 0; i < adcWords.length; i++) adcWords[i] = Math.floor(i / 250) & 0xff;
  adcStore.append(new Uint8Array(adcWords.buffer));
  const adcSpec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
  const adcView = (): BusViewState => ({
    id: 'bus-0', name: 'bus', spec: adcSpec, color: '#fff', fullScaleV: null, offsetV: 0,
    style: 'line', heightCss: 120, hideSources: false, builder: null, builtFor: null, cache: null,
  });
  const adcAt = (i: number): number => Math.floor(i / 250) & 0xff;

  const adcNoBuilder = analogFrame(adcStore, adcView(), 0, 40_000, 100, true);
  check('analogFrame live without a builder stays the live placeholder',
    adcNoBuilder.kind === 'empty' && adcNoBuilder.reason === 'live',
    `kind=${adcNoBuilder.kind}`);

  const adcBuilt = adcView();
  adcBuilt.builder = new BusBuilder(adcStore, adcSpec);
  while (!adcBuilt.builder.step(10)) { /* build */ }
  const adcLiveFull = analogFrame(adcStore, adcBuilt, 0, 40_000, 100, true);
  check('analogFrame live draws pyramid columns once built',
    adcLiveFull.kind === 'columns' &&
    adcLiveFull.min[0] === adcAt(0) && adcLiveFull.max[0] === adcAt(1_023) &&
    adcLiveFull.min[99] === adcAt(38_912) && adcLiveFull.max[99] === adcAt(39_999),
    adcLiveFull.kind === 'columns'
      ? `c0=${adcLiveFull.min[0]}..${adcLiveFull.max[0]} c99=${adcLiveFull.min[99]}..${adcLiveFull.max[99]}`
      : `kind=${adcLiveFull.kind}`);

  const adcPartial = adcView();
  adcPartial.builder = new BusBuilder(adcStore, adcSpec, adcStore.length, 4096);
  adcPartial.builder.step(0);
  const adcLivePart = analogFrame(adcStore, adcPartial, 0, 40_000, 100, true);
  check('analogFrame live leaves columns past doneUpTo empty',
    adcLivePart.kind === 'columns' &&
    adcLivePart.min[0] === adcAt(0) && adcLivePart.max[10] === adcAt(4095) &&
    Number.isNaN(adcLivePart.min[11]) && Number.isNaN(adcLivePart.max[99]),
    adcLivePart.kind === 'columns'
      ? `doneUpTo=${adcPartial.builder.pyramid.doneUpTo} c10=${adcLivePart.max[10]} c11=${adcLivePart.min[11]}`
      : `kind=${adcLivePart.kind}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
