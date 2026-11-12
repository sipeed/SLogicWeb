// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
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

import {
  columnHasEdge, computeChannelRowHeight, filterIdleRows, isCompactRow,
} from '../channelLayout.js';
import { ROWS } from '../metrics.js';
import { analogFrame, type BusViewState } from '../busView.js';
import { BusBuilder, PlanarSampleStore, type BusSpec } from '../../data/index.js';
import { DEFAULT_TRIGGER_MODE, edgeTriggerAutoArms, isEdgeTriggerMode, modesToConditions,
  clampLoopSamples, DEFAULT_LOOP_SAMPLES, LOOP_WINDOW_QUANTUM, loopDropSamples,
  maxLoopSamples, triggerModeFromCondition,
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

// "Compact rows" (DESIGN §5.4): only the floor moves; fit and the upper clamp do not.
{
  const compact32 = computeChannelRowHeight(400, 32, 0, true);
  const compactFloor = computeChannelRowHeight(120, 32, 0, true);
  const compactLanes = computeChannelRowHeight(200, 32, 3, true);
  const fitSame = computeChannelRowHeight(600, 10, 0, true) === computeChannelRowHeight(600, 10, 0);
  const capSame = computeChannelRowHeight(1000, 1, 0, true) === 72;
  const offDefault = computeChannelRowHeight(400, 32, 0) === 48 &&
    computeChannelRowHeight(400, 32, 0, false) === 48;
  check('compact rows drop the 32-channel floor to 24px and leave fit, cap and the default alone',
    ROWS.compactMinRowHeight === 24 && compact32 === 24 && compactFloor === 24 &&
      compactLanes === 24 && fitSame && capSame && offDefault,
    `compact32=${compact32}, floor=${compactFloor}, lanes=${compactLanes}, fit=${fitSame}, ` +
    `cap=${capSame}, off=${offDefault}`);
  // 32 rows at 24 px = 768 px: a 1080p window's plot fits every channel without scrolling.
  const fits = computeChannelRowHeight(32 * 24, 32, 0, true);
  check('32 compact rows fit a 768px plot exactly, and 26 px when there is room',
    fits === 24 && computeChannelRowHeight(32 * 26, 32, 0, true) === 26 &&
      isCompactRow(24) && isCompactRow(47) && !isCompactRow(48),
    `fits=${fits}`);
}

{
  const fitting = (plot: number, channels: number, lanes: number, compact: boolean): number => {
    const available = plot - lanes * ROWS.laneHeight;
    const fit = Math.floor(available / channels);
    const floor = compact ? ROWS.compactMinRowHeight : ROWS.minRowHeight;
    return Math.max(floor, Math.min(ROWS.maxRowHeight, fit));
  };
  const floorOf = (compact: boolean): number =>
    compact ? ROWS.compactMinRowHeight : ROWS.minRowHeight;
  const rows: Array<{
    label: string; plot: number; channels: number; lanes: number; compact: boolean; on: number;
  }> = [
    { label: 'tall 10-row plot', plot: 600, channels: 10, lanes: 0, compact: false, on: 60 },
    { label: '8 channels in a tall plot', plot: 600, channels: 8, lanes: 0, compact: false, on: 72 },
    { label: 'one sparse row stops growing', plot: 1000, channels: 1, lanes: 0, compact: false, on: 72 },
    { label: 'four rows left after hiding idle channels', plot: 2000, channels: 4, lanes: 0, compact: false, on: 72 },
    { label: 'two lanes split the divisible height', plot: 900, channels: 10, lanes: 2, compact: false, on: 72 },
    { label: 'short 32-row plot', plot: 120, channels: 32, lanes: 0, compact: false, on: 48 },
    { label: 'lanes cannot push rows below the floor', plot: 200, channels: 32, lanes: 3, compact: false, on: 48 },
    { label: 'zero-height plot', plot: 0, channels: 8, lanes: 0, compact: false, on: 48 },
    { label: 'tall compact 10-row plot', plot: 600, channels: 10, lanes: 0, compact: true, on: 60 },
    { label: 'one compact row stops growing', plot: 1000, channels: 1, lanes: 0, compact: true, on: 72 },
    { label: 'compact 32 rows exactly fitting 768px', plot: 768, channels: 32, lanes: 0, compact: true, on: 24 },
    { label: 'compact lanes cannot drop below 24', plot: 200, channels: 32, lanes: 3, compact: true, on: 24 },
    { label: 'compact lanes on a tall plot', plot: 900, channels: 10, lanes: 2, compact: true, on: 72 },
  ];
  const describe = (label: string, expected: number, actual: number): string =>
    `${label}: expected=${expected}, actual=${actual}`;

  const offBad = rows
    .filter((r) => computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact, false) !== floorOf(r.compact))
    .map((r) => describe(r.label,
      floorOf(r.compact), computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact, false)));
  check('fit off floors every row at 48px, or 24px with compact rows, whatever the lanes and height',
    offBad.length === 0 && floorOf(false) === 48 && floorOf(true) === 24,
    offBad.length === 0
      ? `${rows.length} literal cases: ${rows.map((r) => `${r.label}=${floorOf(r.compact)}`).join(', ')}`
      : offBad.join('; '));

  const onBad = rows
    .filter((r) => computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact, true) !== r.on ||
      computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact, true) !==
        fitting(r.plot, r.channels, r.lanes, r.compact))
    .map((r) => describe(r.label, r.on,
      computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact, true)));
  const defaultBad = rows
    .filter((r) => computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact) !== r.on)
    .map((r) => describe(r.label, r.on, computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact)));
  check('fit on keeps the pre-flag fitting arithmetic literal for literal, and is the default',
    onBad.length === 0 && defaultBad.length === 0,
    onBad.length === 0 && defaultBad.length === 0
      ? `${rows.length} cases match both literals and the pre-flag formula; 4-arg calls equal fit on`
      : [...onBad, ...defaultBad].join('; '));

  const distinguishing = rows.filter((r) => r.on !== floorOf(r.compact));
  const coinciding = rows.filter((r) => r.on === floorOf(r.compact));
  const offMutantCaught = distinguishing.every((r) =>
    computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact, false) !==
      fitting(r.plot, r.channels, r.lanes, r.compact));
  const onMutantCaught = distinguishing.every((r) =>
    computeChannelRowHeight(r.plot, r.channels, r.lanes, r.compact, true) !== floorOf(r.compact));
  check('the fit flag is falsifiable: dropping either branch disagrees on every distinguishing case',
    distinguishing.length >= 8 && coinciding.length > 0 && offMutantCaught && onMutantCaught,
    `distinguishing=${distinguishing.length}, coinciding=${coinciding.length}, ` +
    `alwaysFit=${offMutantCaught}, alwaysFloor=${onMutantCaught}`);
}

// "Hide idle channels": a whole-capture column per channel decides idle exactly.
{
  const store = new PlanarSampleStore({ channelCount: 8, samplerate: 1e6 });
  const n = 4096;
  const chunk = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // D0 toggles every sample, D1 has one edge at 3000, D2 is stuck high, the rest low.
    chunk[i] = (i & 1) | (i >= 3000 ? 2 : 0) | 4;
  }
  store.append(chunk);
  const idle: number[] = [];
  for (let channel = 0; channel < 8; channel++) {
    const view = store.query(channel, 0, store.length, 1);
    if (!columnHasEdge(view.low[0]!, view.high[0]!)) idle.push(channel);
  }
  check('a whole-capture column finds every channel with no edge (stuck high or low) and only those',
    idle.join(',') === '2,3,4,5,6,7', `idle=${idle.join(',')}`);
}

{
  const rows = [0, 1, 2, 3, 4].map((index) => ({ index }));
  const some = filterIdleRows(rows, new Set([1, 3, 4]), new Set([4]));
  const none = filterIdleRows(rows, new Set(), new Set());
  const all = filterIdleRows(rows, new Set([0, 1, 2, 3, 4]), new Set());
  check('the idle filter hides idle rows in order, keeps decoder-lane channels, and never empties the plot',
    some.shown.map((r) => r.index).join(',') === '0,2,4' && some.hidden === 2 &&
      none.hidden === 0 && none.shown.length === 5 &&
      all.hidden === 0 && all.shown.length === 5,
    `some=${some.shown.map((r) => r.index).join(',')}/${some.hidden}, all=${all.hidden}`);
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
  const importsPolicy = /import {[^}]*\bcomputeChannelRowHeight\b[^}]*} from '.\/channelLayout.js';/.test(app);
  const delegates = (source: string): boolean => source.includes(
    'const base = computeChannelRowHeight(\n' +
    '      plotH, shown.length, this.lanes.length, this.compactRows, this.fitRows);');
  const fourArgument = app.replace(
    '      plotH, shown.length, this.lanes.length, this.compactRows, this.fitRows);',
    '      plotH, shown.length, this.lanes.length, this.compactRows);');
  const droppedFit = app.replace(
    'this.lanes.length, this.compactRows, this.fitRows);',
    'this.lanes.length, this.compactRows, true);');
  const duplicateClamp = app.includes('Math.max(ROWS.minRowHeight');
  check('App.relayout delegates to the tested policy with the app state and without a duplicate clamp',
    importsPolicy && delegates(app) && fourArgument !== app && !delegates(fourArgument) &&
    droppedFit !== app && !delegates(droppedFit) && !duplicateClamp,
    `import=${importsPolicy}, delegates=${delegates(app)}, ` +
    `fourArgument=${delegates(fourArgument)}, droppedFit=${delegates(droppedFit)}, ` +
    `duplicateClamp=${duplicateClamp}`);

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

  const clampStart = app.indexOf('function clampCaptureSettings(');
  const clampEnd = clampStart >= 0 ? app.indexOf('\n}\n', clampStart) : -1;
  const clampSource = clampEnd > clampStart ? app.slice(clampStart, clampEnd) : '';
  const clampAutoArm = clampSource.includes('edgeTriggerAutoArms');
  check('clampCaptureSettings stays a pure clamp with no auto-arm invariant',
    clampSource.length > 0 && !clampAutoArm,
    `slice=${clampSource.length}, autoArmInClamp=${clampAutoArm}`);

  const shortcutStart = app.indexOf("window.addEventListener('keydown', (e) => {");
  const shortcutEnd = shortcutStart >= 0 ? app.indexOf('\n    });', shortcutStart) : -1;
  const shortcutBody = shortcutEnd > shortcutStart
    ? app.slice(shortcutStart, shortcutEnd) : '';
  const dialogGuardIndex = shortcutBody.indexOf("closest('dialog[open]') !== null");
  const plotDispatch = shortcutBody.indexOf('this.runShortcut(id)', dialogGuardIndex);
  const anywhereIndex = shortcutBody.indexOf('if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {');
  const resolveIndex = shortcutBody.indexOf('const id = actionOf(chord)');
  const dialogGuard = dialogGuardIndex >= 0 && anywhereIndex > resolveIndex &&
    dialogGuardIndex > anywhereIndex && plotDispatch > dialogGuardIndex;
  const anywhereBlock = '      if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {\n' +
    '        if (this.runShortcut(id)) e.preventDefault();\n' +
    '        return;\n      }\n';
  const movedBelowGuard = app.replace(anywhereBlock, '').replace(
    "      if (target instanceof HTMLElement && target.closest('dialog[open]') !== null) return;\n",
    "      if (target instanceof HTMLElement && target.closest('dialog[open]') !== null) return;\n" +
      anywhereBlock);
  const movesOrder = (source: string): boolean => {
    const start = source.indexOf("window.addEventListener('keydown', (e) => {");
    const body = start < 0 ? '' : source.slice(start, source.indexOf('\n    });', start));
    const anywhere = body.indexOf('if (WORK_ANYWHERE.has(id) && !this.shortcutBlockedByOverlay(e.target)) {');
    const dialog = body.indexOf("closest('dialog[open]')");
    return anywhere >= 0 && dialog > anywhere;
  };
  check('app-level shortcuts stay out of an open dialog while the anywhere set still runs',
    dialogGuard && movedBelowGuard !== app && movesOrder(app) && !movesOrder(movedBelowGuard),
    `guard@${dialogGuardIndex}, anywhere@${anywhereIndex}, resolve@${resolveIndex}, ` +
    `dispatch@${plotDispatch}, body=${shortcutBody.length}`);

  const channelList = fs.readFileSync('src/ui/channelList.ts', 'utf8');
  const rowStart = channelList.indexOf('export class ChannelList');
  const rowSource = channelList.slice(rowStart, channelList.indexOf('function triggerModeName'));
  const readOnlyName = rowSource.includes("tag.className = 'ch-tag ch-tag--name'") &&
    rowSource.includes('tag.textContent = cell.channel.name') &&
    rowSource.includes('triggerIcon(cell.trigger.mode)') &&
    !rowSource.includes('ch-tag--editable') &&
    !rowSource.includes('tag.addEventListener') &&
    !rowSource.includes("tag.setAttribute('role', 'button')") &&
    !rowSource.includes('tag.tabIndex') &&
    !rowSource.includes('tag.title') &&
    !rowSource.includes('contentEditable') &&
    !rowSource.includes("this.openEditor(trigger, cell, 'name')");
  check('the channel row head renders a read-only name with no name-editing entry',
    rowStart >= 0 && readOnlyName,
    `rowStart=${rowStart}, text=${rowSource.includes('tag.textContent = cell.channel.name')}, ` +
    `listener=${rowSource.includes('tag.addEventListener')}, ` +
    `role=${rowSource.includes("tag.setAttribute('role', 'button')")}, ` +
    `tabIndex=${rowSource.includes('tag.tabIndex')}, ` +
    `title=${rowSource.includes('tag.title')}, ` +
    `contentEditable=${rowSource.includes('contentEditable')}, ` +
    `nameBranch=${rowSource.includes("this.openEditor(trigger, cell, 'name')")}, ` +
    `editableClass=${rowSource.includes('ch-tag--editable')}`);

  const dialogStart = channelList.indexOf('class ChannelSettingsDialog');
  const dialogSource = dialogStart >= 0 && rowStart > dialogStart
    ? channelList.slice(dialogStart, rowStart) : '';
  const gearEntry = rowSource.includes("settings.className = 'ch-settings'") &&
    rowSource.includes("settings.setAttribute('aria-haspopup', 'dialog')") &&
    rowSource.includes("settings.title = t('channels.settings', { index: cell.channel.index })") &&
    rowSource.includes('settings.appendChild(settingsIcon())') &&
    rowSource.includes('this.settingsDialog.open(settings, cell)') &&
    rowSource.includes("cell.trigger.mode !== 'dont-care'") &&
    rowSource.includes("preview.className = 'ch-trigger-preview'") &&
    rowSource.includes("preview.setAttribute('role', 'img')") &&
    !rowSource.includes('preview.addEventListener') &&
    !rowSource.includes("'ch-trigger'") &&
    rowSource.includes('head.append(tag, original)') &&
    rowSource.includes('if (preview !== null) head.append(preview)') &&
    rowSource.includes("const main = div('ch-main')") &&
    rowSource.includes('main.appendChild(head)') &&
    rowSource.includes('main.appendChild(chips)') &&
    rowSource.includes("const actions = div('ch-actions')") &&
    rowSource.includes('actions.appendChild(settings)') &&
    rowSource.includes('body.append(main, actions)') &&
    rowSource.includes("settings.addEventListener('mousedown', () => { el.draggable = false; })") &&
    rowSource.includes('this.settingsDialog.closeUnless(cells.map((cell) => cell.channel.index))') &&
    !rowSource.includes('nameInput') &&
    rowSource.includes("this.editor.className = 'ch-editor-popover'");
  check('the row head shows the read-only trigger preview and the gear sits in the body actions column',
    rowStart >= 0 && dialogSource.length > 0 && gearEntry,
    `rowStart=${rowStart}, dialog=${dialogSource.length}, gear=${gearEntry}`);

  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const block = (selector: string): string => {
    const at = sheet.indexOf(`\n${selector} {`);
    if (at < 0) return '';
    const end = sheet.indexOf('}', at);
    return end < 0 ? '' : sheet.slice(at, end);
  };
  const settingsBlock = block('.ch-settings');
  const trailingSlot = block('.ch-actions').includes('flex: none') &&
    !settingsBlock.includes('margin-left: auto') &&
    !block('.ch-trigger-preview').includes('margin-left: auto');
  check('the actions column owns the trailing slot so the head cannot slide with its children',
    trailingSlot, `actions=${block('.ch-actions').includes('flex: none')}, ` +
    `settings=${settingsBlock.includes('margin-left: auto')}, ` +
    `trigger=${block('.ch-trigger-preview').includes('margin-left: auto')}`);

  const dialogFields = dialogSource.includes("this.dialog.className = 'channel-settings-dialog'") &&
    dialogSource.includes("form.className = 'channel-settings-form'") &&
    dialogSource.includes("'channel-settings-fields'") &&
    (dialogSource.match(/'channel-settings-field channel-settings-kv'/g) ?? []).length === 3 &&
    dialogSource.includes("this.nameInput.className = 'channel-settings-name'") &&
    dialogSource.includes("button('', 'channel-name-reset')") &&
    dialogSource.includes('this.nameInput.value = defaultChannelName(this.channel)') &&
    dialogSource.includes('this.triggerFieldset.disabled = cell.trigger.disabled') &&
    dialogSource.includes('this.dialog.showModal()');
  const triggerChoices = channelList.includes(
    "['dont-care', 'rising', 'falling', 'edge', 'high', 'low']") &&
    dialogSource.includes("this.triggerFieldset.className = 'channel-trigger-options'") &&
    dialogSource.includes("label.className = 'channel-trigger-option'") &&
    dialogSource.includes("input.type = 'radio'") &&
    dialogSource.includes("triggerIcon(mode, 'menu')") &&
    dialogSource.includes('option.input.setAttribute(\'aria-label\', name)');
  check('the settings dialog owns the name, trigger and colour fields in one form',
    dialogFields && triggerChoices,
    `fields=${dialogFields}, triggers=${triggerChoices}`);

  const colorDraft = dialogSource.includes('for (const color of CHANNEL_COLOR_PRESETS)') &&
    dialogSource.includes("'channel-color-swatch channel-color-preset'") &&
    dialogSource.includes("'channel-color-swatch channel-color-custom'") &&
    dialogSource.includes("this.colorPalette.setAttribute('popover', 'auto')") &&
    dialogSource.includes('new HsvPicker(') &&
    dialogSource.includes('this.colorPicker.setColor(this.selectedColor)') &&
    dialogSource.includes('channelColor(this.channel)') &&
    dialogSource.includes("t('channels.resetColor', { index: channel })") &&
    dialogSource.includes('private syncColorSelection(): void') &&
    !channelList.includes('pendingColor') &&
    !channelList.includes('requestAnimationFrame(flushColor)') &&
    !channelList.includes("type = 'color'");
  check('colour is a draft of presets plus a custom HSV swatch, never applied live',
    colorDraft, `colorDraft=${colorDraft}`);

  const commits = (dialogSource.match(/this\.onConfigure\(/g) ?? []).length === 1 &&
    dialogSource.includes("form.addEventListener('submit', this.onSubmit)") &&
    dialogSource.includes('this.onConfigure(channel, config)') &&
    dialogSource.includes("this.dialog.addEventListener('cancel'") &&
    dialogSource.includes('if (event.target === this.dialog)') &&
    dialogSource.includes('if (restoreFocus) this.onDismiss(channel, opener)') &&
    dialogSource.includes('if (this.dialog.open) this.dialog.close()');
  check('the dialog commits once on submit while Escape, the backdrop and Cancel discard',
    commits, `commits=${commits}`);

  const anyEdgeGlyph = channelList.includes("mode === 'edge' ? t('trigger.anyEdge')") &&
    channelList.includes("mode === 'edge' ? 'M1 4H6L18 12H23M1 12H6L18 4H23'") &&
    channelList.includes("mode === 'dont-care'") &&
    channelList.includes("'M6 8H18'") &&
    channelList.includes("path.setAttribute('stroke-linejoin', 'round')");
  check('any-edge has a translated name and an X glyph; None is a dash',
    anyEdgeGlyph, `anyEdgeGlyph=${anyEdgeGlyph}`);

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

  const watermarkAbsent = !app.includes('drawDemoWatermark') &&
    !overlay.includes('drawDemoWatermark') &&
    !app.includes("captureLabel.kind === 'demo'") &&
    !overlay.includes("fillText('DEMO'");
  check('the demo provenance watermark is retired',
    watermarkAbsent,
    `app=${app.includes('drawDemoWatermark')}, overlay=${overlay.includes('drawDemoWatermark')}, ` +
    `gate=${app.includes("captureLabel.kind === 'demo'")}`);

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
    !bubbleSource.includes('fillLane');
  check('lane surface filling is a separate pass from bubble painting',
    surfacePass && bubblePass && !app.includes('this.drawLanes('),
    `surface=${surfacePass}, bubbles=${bubblePass}, oldPass=${app.includes('this.drawLanes(')}`);

  const drawStart = app.indexOf('private draw(');
  const drawEnd = app.indexOf('private drawAxisCanvas(');
  const drawSource = drawStart >= 0 && drawEnd > drawStart
    ? app.slice(drawStart, drawEnd) : '';
  const paintOrder = [
    'this.overlay.beginFrame(clearedCanvases(plan));',
    'this.overlay.drawGrid(ticks);',
    'this.drawLaneSurfaces(boxes, repeatTints);',
    'this.overlay.drawLevels(',
    'this.drawLaneBubbles(boxes, wCss);',
    'this.overlay.drawTrigger(',
    'this.overlay.drawLiveEdge(',
    'for (const cursor of this.cursors) cursor.marker.draw(this.overlay,',
    'this.overlay.drawHover(this.hover);',
  ];
  const positions = paintOrder.map((needle) => drawSource.indexOf(needle));
  const ordered = positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!));
  check('paint order is grid, lane surfaces, levels, overlays',
    drawSource.length > 0 && ordered,
    `positions=${positions.join(',')}`);
}

{
  const samplesTable: Array<[number, number, number]> = [
    [16_000_000, 16, 16_000_000],
    [1, 16, LOOP_WINDOW_QUANTUM],
    [Number.NaN, 16, DEFAULT_LOOP_SAMPLES],
    [Number.POSITIVE_INFINITY, 16, maxLoopSamples(16)],
    [Number.NEGATIVE_INFINITY, 16, LOOP_WINDOW_QUANTUM],
    [-5, 16, LOOP_WINDOW_QUANTUM],
    [0, 16, LOOP_WINDOW_QUANTUM],
    // Rounds up to the quantum, like HSync's (limit + 1023) & !1023: a window never
    // silently keeps less than was asked.
    [1025, 16, 2048],
    [2048, 16, 2048],
    [2 ** 30, 16, maxLoopSamples(16)],
    [2 ** 30, 32, maxLoopSamples(32)],
    [16_000_000, 32, 16_000_000],
  ];
  const samplesBad = samplesTable
    .filter(([v, ch, want]) => clampLoopSamples(v, ch as 16 | 32) !== want)
    .map(([v, ch, want]) => `${v}@${ch}ch: want ${want}, got ${clampLoopSamples(v, ch as 16 | 32)}`);
  check('clampLoopSamples floors at the quantum, rounds up, clamps to the memory budget',
    samplesBad.length === 0,
    samplesBad.length === 0 ? `${samplesTable.length} exact cases` : samplesBad.join('; '));

  const ceilingBad = ([4, 8, 16, 32] as const)
    .filter((ch) => maxLoopSamples(ch) + (1 << 25) >= 2 ** 31);
  check('the advertised loop maxima stay below the 2^31 store ceiling with one-chunk headroom',
    ceilingBad.length === 0,
    ceilingBad.length === 0
      ? 'limit plus a sink chunk < 2^31 at every width'
      : `violates: ${ceilingBad.join(', ')}ch`);

  // Design §4.2 (confirmed 2026-10-26): 2 GiB of packed bytes and 2^30 samples per
  // capture. Literals, not a second copy of the clamp formula, so moving a budget
  // constant turns this red. Packed bytes = samples * channels / 8 (one bit per sample).
  const budgetTable: Array<[4 | 8 | 16 | 32, number, number]> = [
    [4, 2 ** 30, 512],
    [8, 2 ** 30, 1_024],
    [16, 2 ** 30, 2_048],
    [32, 2 ** 29, 2_048],
  ];
  const budgetBad = budgetTable
    .filter(([ch, samples, mib]) => maxLoopSamples(ch) !== samples
      || Math.round((maxLoopSamples(ch) * ch) / 8 / 2 ** 20) !== mib)
    .map(([ch, samples, mib]) => `${ch}ch: want ${samples} samples / ${mib} MiB, got `
      + `${maxLoopSamples(ch)} / ${Math.round((maxLoopSamples(ch) * ch) / 8 / 2 ** 20)} MiB`);
  check('every width maxes out at the confirmed 2 GiB / 2^30 loop budget (design §4.2)',
    budgetBad.length === 0,
    budgetBad.length === 0
      ? budgetTable.map(([ch, samples, mib]) => `${ch}ch ${samples} (${mib} MiB)`).join(', ')
      : budgetBad.join('; '));

  const sweepBad: string[] = [];
  for (const v of [0, 1, 1024, 16_000_000, 536_870_911, 536_870_912, 1e12]) {
    for (const ch of [4, 8, 16, 32] as const) {
      const got = clampLoopSamples(v, ch);
      const max = maxLoopSamples(ch);
      if (!(got <= max)) sweepBad.push(`${v}@${ch}ch: ${got} > ${max}`);
      if (got % LOOP_WINDOW_QUANTUM !== 0) sweepBad.push(`${v}@${ch}ch: ${got} not a multiple of ${LOOP_WINDOW_QUANTUM}`);
    }
  }
  check('clampLoopSamples never exceeds the budget ceiling and stays on the quantum',
    sweepBad.length === 0,
    sweepBad.length === 0 ? '7 values x 4 widths all clamped and quantised' : sweepBad.join('; '));

  const dropTable: Array<[number, number, number]> = [
    [159_744, 159_744, 0],      // at the limit: nothing to drop
    [159_745, 159_744, 0],      // 1 over, floored to the 64 quantum
    [159_808, 159_744, 64],     // 64 over: dropped immediately, no hysteresis
    [319_488, 159_744, 159_744],
    [319_999, 159_744, 160_192],
    [100, 0, 0],
    [-50, 159_744, 0],
  ];
  const dropBad = dropTable
    .filter(([len, ret, want]) => loopDropSamples(len, ret) !== want)
    .map(([len, ret, want]) => `(${len}, ${ret}): want ${want}, got ${loopDropSamples(len, ret)}`);
  const quantumOk = dropTable.every(([len, ret]) => loopDropSamples(len, ret) % 64 === 0);
  check('loopDropSamples drops the moment the window passes the limit, floored to the quantum',
    dropBad.length === 0 && quantumOk,
    dropBad.length === 0
      ? `${dropTable.length} exact cases, every result a multiple of 64`
      : dropBad.join('; '));

  const loopFs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!loopFs || typeof loopFs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const stateSrc = loopFs.readFileSync('src/ui/state.ts', 'utf8');
  check('capture mode stays a closed stored union with no oscilloscope transform',
    !stateSrc.includes('effectiveCaptureMode') && stateSrc.includes("mode: 'single' | 'repeat' | 'loop';") &&
    !stateSrc.includes('singleUnlimited') && stateSrc.includes('repeatIntervalSeconds: number;'),
    `transform=${stateSrc.includes('effectiveCaptureMode')}, ` +
    `union=${stateSrc.includes("mode: 'single' | 'repeat' | 'loop';")}`);
  const panel = loopFs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const modeBlock = panel.split('const modeSec = section(')[1]?.split('modeSec.body.appendChild(seg)')[0] ?? '';
  const panelModes = !panel.includes('capturePanel.freeRun') && !panel.includes('capturePanel.timer') &&
    !panel.includes('capturePanel.retentionSamples') && !panel.includes('capturePanel.retentionNote') &&
    !panel.includes('capturePanel.loopCeilingNote') &&
    panel.includes("['single', t('capturePanel.modeSingle')]") &&
    panel.includes("['repeat', t('capturePanel.modeRepeat')]") &&
    panel.includes("['loop', t('capturePanel.modeLoop')]") &&
    panel.includes("key: 'capture.duration'") && panel.includes("key: 'capture.repeatInterval'") &&
    panel.includes("key: 'capture.loopWindow'") &&
    (panel.match(/acquisitionTimeControl\(\{/g) ?? []).length === 3 &&
    !panel.includes('secs.dataset.captureSeconds') && !panel.includes('interval.dataset.repeatInterval') &&
    !panel.includes('unlimited.dataset.singleUnlimited') && !panel.includes('win.dataset.loopSamples') &&
    !panel.includes('singleUnlimited') &&
    panel.includes('capturePanel.singleFiniteNote') && panel.includes('capturePanel.repeatFiniteNote') &&
    panel.includes('capturePanel.loopWindowLimit') &&
    modeBlock.includes('b.disabled = modeLocked') && modeBlock.includes('s.mode === id') &&
    modeBlock.includes('const modeLocked = v.running || v.stopping || v.repeatPending') &&
    !modeBlock.includes('oscilloscope') && !panel.includes('v.effectiveMode') &&
    !panel.includes('v.oscilloscopeActive') && !panel.includes('oscilloscopeTakeover');
  check('the capture panel offers Single, Repeat and Loop with unified time controls',
    panelModes,
    `free=${panel.includes('capturePanel.freeRun')}, timer=${panel.includes('capturePanel.timer')}, ` +
    `takeover=${panel.includes('oscilloscopeTakeover')}, stored=${modeBlock.includes('s.mode === id')}, ` +
    `lock=${modeBlock.includes('b.disabled = modeLocked')}`);

  const appSrc = loopFs.readFileSync('src/ui/app.ts', 'utf8');
  const startStart = appSrc.indexOf('private async startCapture(');
  const startEnd = startStart >= 0 ? appSrc.indexOf('private enforceLoopRetention', startStart) : -1;
  const startSrc = startEnd > startStart ? appSrc.slice(startStart, startEnd) : '';
  const flagReset = startSrc.indexOf('startMutatedCapture = false');
  const firstRefusal = startSrc.indexOf('device.thresholdClips');
  const flagSet = startSrc.indexOf('startMutatedCapture = true');
  check('startCapture resets its mutation flag before the early refusals and sets it after them',
    startSrc.length > 0 && flagReset >= 0 && firstRefusal > flagReset && flagSet > firstRefusal,
    `slice=${startSrc.length}, reset=${flagReset}, refusal=${firstRefusal}, set=${flagSet}`);

  const directMode = panel.includes('capturePostTriggerSamples(s)') && !panel.includes('s.channels === 32') &&
    startSrc.includes('const mode = this.settings.mode;') &&
    startSrc.includes("const isLoop = mode === 'loop'") &&
    startSrc.includes('const postTriggerSamples = capturePostTriggerSamples(this.settings)') &&
    startSrc.includes('this.captureLimitSamples = isLoop ? MAX_SAMPLES - 1 : postTriggerSamples;') &&
    startSrc.includes('this.captureRequestedSeconds = isLoop ? null : postTriggerSamples / cfg.samplerate;') &&
    !appSrc.includes('singleUnlimited') &&
    appSrc.includes('repeatIntervalSeconds: clampRepeatIntervalSeconds(') &&
    !appSrc.includes('effectiveCaptureMode') && !appSrc.includes('effectiveMode:') &&
    !appSrc.includes('private oscilloscopeActive()');
  // W6: the loop decode ban is gone - a running loop decodes as a labelled snapshot,
  // and the note carries the tag. The flag is read before the worker round trip, so a
  // decode that outlives the running capture keeps its label.
  const snapshotDecl = appSrc.indexOf(
    'const snapshotDecode = this.captureIsLoop && (this.running || this.stopping)');
  const snapshotAwait = appSrc.indexOf('await this.decodeClient.decode');
  const snapshotDecode = !appSrc.includes('decoders cannot run during a loop capture') &&
    snapshotDecl > 0 && snapshotAwait > snapshotDecl &&
    appSrc.includes('...(snapshotDecode ? { snapshot: true as const } : {})') &&
    !appSrc.includes('this.captureIsLoop && (this.running || this.stopping) ? { snapshot: true as const }');
  check('a running loop decodes as a labelled snapshot',
    snapshotDecode,
    `throwGone=${!appSrc.includes('decoders cannot run during a loop capture')}, ` +
    `declaredBeforeAwait=${snapshotDecl > 0 && snapshotAwait > snapshotDecl}, ` +
    `snapshotTag=${appSrc.includes('...(snapshotDecode ? { snapshot: true as const } : {})')}, ` +
    `lateFlagGone=${!appSrc.includes('this.captureIsLoop && (this.running || this.stopping) ? { snapshot: true as const }')}`);
  const progressSplit =
    appSrc.includes('const loop = this.captureIsLoop;') &&
    appSrc.includes('samples: loop ? captured.length + this.droppedTotal : captured.length') &&
    appSrc.includes('bytesPerSampleForChannels(captured.channelCount)');
  check('progressView splits loop totals from retained bytes',
    progressSplit,
    `total=${appSrc.includes('samples: loop ? captured.length + this.droppedTotal : captured.length')}, ` +
    `retained=${appSrc.includes('bytesPerSampleForChannels(captured.channelCount)')}`);
  check('the panel, trigger budget and real start path share stored mode without scope ownership',
    directMode,
    `panel=${panel.includes('capturePostTriggerSamples(s)')}, ` +
    `start=${startSrc.includes('const mode = this.settings.mode;')}, ` +
    `scopeTransform=${appSrc.includes('effectiveCaptureMode')}`);

  const busPanel = loopFs.readFileSync('src/ui/busPanel.ts', 'utf8');
  const addBus = appSrc.split('private addBus(')[1]?.split('private updateBus(')[0] ?? '';
  const updateBus = appSrc.split('private updateBus(')[1]?.split('private removeBus(')[0] ?? '';
  const removeBus = appSrc.split('private removeBus(')[1]?.split('private toggleAnalog(')[0] ?? '';
  const scopeLocks = addBus.includes('(this.running || this.stopping) && cfg.analogGroup !== undefined') &&
    updateBus.includes('(this.running || this.stopping) &&') &&
    updateBus.includes('(current.analogGroup !== undefined || cfg.analogGroup !== undefined)') &&
    removeBus.includes('if (this.stopping && current.analogGroup !== undefined) return false;') &&
    busPanel.includes('remove.disabled = v.captureLocked && b.analogGroup !== undefined') &&
    busPanel.includes('(v.captureLocked && (editingBank || current?.analogGroup !== undefined))') &&
    appSrc.includes("if (this.addBus(cfg) === null) throw new DiagnosticError('ui.captureLocked')") &&
    appSrc.includes("if (b && !this.updateBus(b.id, cfg)) throw new DiagnosticError('ui.captureLocked')") &&
    appSrc.includes("if (b && !this.removeBus(b.id)) throw new DiagnosticError('ui.captureLocked')");
  check('stopping locks bank add/edit/remove; a running capture permits the live analog retune',
    scopeLocks, `add=${addBus.includes('cfg.analogGroup !== undefined')}, ` +
    `update=${updateBus.includes('current.analogGroup !== undefined || cfg.analogGroup !== undefined')}, ` +
    `remove=${removeBus.includes('this.stopping && current.analogGroup !== undefined')}, ` +
    `panel=${busPanel.includes('v.captureLocked')}`);

  const loopOpts = startSrc.includes(
    'isLoop ? { loop: true } : { deviceSampleLimit: this.captureLimitSamples }');
  check('a loop capture opts out of the device length limit and of the transport watchdogs',
    loopOpts, `loopOption=${loopOpts}`);
  // The transport side of that contract: the option must actually gate both watchdogs and
  // be cleared on both stop paths, or a later capture inherits a loop capture's silence.
  const devSrc = loopFs.readFileSync('src/device/slogic16u3.ts', 'utf8');
  const gateFirstByte = devSrc.includes('if (!this.loopMode) this.armNoDataWatchdog(cfg)');
  const gateUnderrun = devSrc.includes('slowCount >= depth && !this.underrun && !this.loopMode');
  const gateSet = devSrc.includes('this.loopMode = opts.loop ?? false');
  const gateResets = (devSrc.match(/this\.loopMode = false;/g) ?? []).length;
  check('loop mode gates both watchdogs and is cleared on both stop paths',
    gateFirstByte && gateUnderrun && gateSet && gateResets === 2,
    `firstByte=${gateFirstByte}, underrun=${gateUnderrun}, set=${gateSet}, resets=${gateResets}`);

  // The loop + software-trigger combination: the trigger branch must carry the loop
  // flag too, the trigger budget must be unbounded (the store windows downstream),
  // and the panel must not claim the trigger is ignored in loop mode.
  const loopTrigger = startSrc.includes('...(isLoop ? { loop: true } : {})') &&
    startSrc.includes('maxSamples: isLoop ? Number.POSITIVE_INFINITY : this.captureLimitSamples');
  check('a loop capture arms the software trigger with an unbounded budget',
    loopTrigger, `triggerBranch=${loopTrigger}`);
  check('the panel no longer calls the loop trigger ignored',
    !panel.includes('loopTriggerIgnored') &&
    !appSrc.includes('const softwareTrigger = this.settings.softwareTrigger && !isLoop'),
    `panelNote=${!panel.includes('loopTriggerIgnored')}, gateGone=${!appSrc.includes('const softwareTrigger = this.settings.softwareTrigger && !isLoop')}`);

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

  const frameStart = appSrc.indexOf('private frame =');
  const frameEnd = frameStart >= 0 ? appSrc.indexOf('private draw(', frameStart) : -1;
  const frameSrc = frameEnd > frameStart ? appSrc.slice(frameStart, frameEnd) : '';
  const highRateGuard = frameSrc.includes('this.running && this.captureIsLoop &&') &&
    frameSrc.includes('this.store.samplerate * bytesPerSampleForChannels(this.store.channelCount) >= LOOP_BUILD_SUSPEND_BYTES_PER_SEC');
  const throttledLive = /liveDrawDue\(\s*now,\s*this\.liveDrawAt,\s*this\.lastFrameCostMs,\s*this\.livePending,\s*this\.running\)/.test(frameSrc) &&
    frameSrc.includes('this.liveDrawAt = now;') &&
    frameSrc.includes('now - this.runningPanelAt > 500') &&
    !frameSrc.includes('if (highRateLoop) return;');
  const buildersOff = frameSrc.includes('if (!highRateLoop) this.pumpBusBuilders();');
  check('high-rate loop skips background bus builds but keeps a throttled live view',
    highRateGuard && throttledLive && buildersOff &&
    appSrc.includes('const LOOP_BUILD_SUSPEND_BYTES_PER_SEC = 160e6;') &&
    !frameSrc.includes('loopDrawAfter'),
    `guard=${highRateGuard}, live=${throttledLive}, builders=${buildersOff}`);
  const startDrawAt = startSrc.indexOf('this.draw();');
  const startHintAt = startSrc.indexOf("this.el.hint.style.display = 'none';");
  check('a new capture clears the previous frame before device streaming starts',
    startDrawAt >= 0 && startSrc.indexOf('this.storeRef.set(store)') < startDrawAt &&
    startDrawAt < startHintAt && startHintAt < startSrc.indexOf('await device.start'),
    `draw=${startDrawAt >= 0}, hint=${startHintAt >= 0}, ordered=${startSrc.indexOf('this.storeRef.set(store)') < startDrawAt && startDrawAt < startHintAt && startHintAt < startSrc.indexOf('await device.start')}`);

  const enforceStart = appSrc.indexOf('private enforceLoopRetention');
  const enforceEnd = enforceStart >= 0 ? appSrc.indexOf('private async stopCapture', enforceStart) : -1;
  const enforceSrc = enforceEnd > enforceStart ? appSrc.slice(enforceStart, enforceEnd) : '';
  check('a retention drop leaves bus builders on their absolute frontier (no reset)',
    !enforceSrc.includes('b.builder?.reset') && !enforceSrc.includes('b.cache = null;'),
    `resetGone=${!enforceSrc.includes('b.builder?.reset')}, cacheGone=${!enforceSrc.includes('b.cache = null;')}`);
  // The trigger position is store-relative session state: a front drop translates it
  // left and clears it once the trigger sample itself leaves retention. The ViewWindow
  // is stored as offsets from T, so it translates by the same amount and keeps its
  // pixels. The 64-sample drop quantum is internal and never changes the phase.
  const triggerShift =
    enforceSrc.includes('const next = this.triggerSampleIndex! - drop;') &&
    enforceSrc.includes('this.triggerSampleIndex = next >= 0 && next < store.length ? next : null;') &&
    enforceSrc.includes('this.stack.restoreViewport(view.start - drop, view.end - drop);') &&
    !enforceSrc.includes('heldTriggerSample');
  check('a retention drop shifts the trigger marker and clears it once it leaves the window',
    triggerShift, `checkedSub=${triggerShift}`);

  const adcStore = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
  // 4000 samples per column: above the two-leaf limit of the exact envelope, so these
  // checks exercise the pyramid and the provisional sampler they are about.
  const adcWords = new Uint16Array(400_000);
  for (let i = 0; i < adcWords.length; i++) adcWords[i] = Math.floor(i / 2500) & 0xff;
  adcStore.append(new Uint8Array(adcWords.buffer));
  const adcSpec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
  const adcView = (): BusViewState => ({
    id: 'bus-0', name: 'bus', spec: adcSpec, color: '#fff', fullScaleV: null, offsetV: 0, bitOrder: 'lsb',
    style: 'line', heightCss: 120, hideSources: false, builder: null, builtFor: null, cache: null,
  });
  const adcAt = (i: number): number => Math.floor(i / 2500) & 0xff;

  const adcNoBuilder = analogFrame(adcStore, adcView(), 0, 400_000, 100, true);
  const noBuilderFinite = adcNoBuilder.kind === 'columns' &&
    Array.from({ length: 100 }, (_, c) => adcNoBuilder.min[c]! <= adcNoBuilder.max[c]!).every(Boolean);
  check('analogFrame samples a coarse envelope when no pyramid exists (fast loop)',
    adcNoBuilder.kind === 'columns' && adcNoBuilder.provisional === true && noBuilderFinite &&
    adcNoBuilder.min[0]! <= 1 && adcNoBuilder.max[0]! >= 0 &&
    adcNoBuilder.min[99]! >= 158 && adcNoBuilder.max[99]! <= 160,
    adcNoBuilder.kind === 'columns'
      ? `c0=${adcNoBuilder.min[0]}..${adcNoBuilder.max[0]} c99=${adcNoBuilder.min[99]}..${adcNoBuilder.max[99]} provisional=${adcNoBuilder.provisional}`
      : `kind=${adcNoBuilder.kind}`);

  const adcBuilt = adcView();
  adcBuilt.builder = new BusBuilder(adcStore, adcSpec);
  while (!adcBuilt.builder.step(10)) { /* build */ }
  const adcLiveFull = analogFrame(adcStore, adcBuilt, 0, 400_000, 100, true);
  check('analogFrame live draws pyramid columns once built',
    adcLiveFull.kind === 'columns' &&
    adcLiveFull.min[0] === adcAt(0) && adcLiveFull.max[0] === adcAt(4_095) &&
    adcLiveFull.min[99] === adcAt(395_264) && adcLiveFull.max[99] === adcAt(399_999) &&
    adcLiveFull.provisional !== true,
    adcLiveFull.kind === 'columns'
      ? `c0=${adcLiveFull.min[0]}..${adcLiveFull.max[0]} c99=${adcLiveFull.min[99]}..${adcLiveFull.max[99]}`
      : `kind=${adcLiveFull.kind}`);

  const adcPartial = adcView();
  adcPartial.builder = new BusBuilder(adcStore, adcSpec, adcStore.length, 40_960);
  adcPartial.builder.step(0);
  const adcLivePart = analogFrame(adcStore, adcPartial, 0, 400_000, 100, true);
  const builtMatch = adcLivePart.kind === 'columns' && adcLiveFull.kind === 'columns' &&
    Array.from({ length: 10 }, (_, c) =>
      adcLivePart.min[c] === adcLiveFull.min[c] && adcLivePart.max[c] === adcLiveFull.max[c]).every(Boolean);
  const tailFinite = adcLivePart.kind === 'columns' &&
    Array.from({ length: 89 }, (_, i) => {
      const c = i + 11;
      return adcLivePart.min[c]! <= adcLivePart.max[c]!;
    }).every(Boolean);
  check('analogFrame keeps built columns exact and samples the unbuilt tail',
    builtMatch && tailFinite && adcLivePart.kind === 'columns' && adcLivePart.provisional === true,
    adcLivePart.kind === 'columns'
      ? `doneUpTo=${adcPartial.builder.pyramid.doneUpTo} built=${builtMatch} tail=${tailFinite} provisional=${adcLivePart.provisional}`
      : `kind=${adcLivePart.kind}`);

  // A drop can reach the store after the pump last called setLength: the one-bus-per-frame
  // pump has not reached this bus yet, or the capture is in its stop drain (the pump
  // returns early while stopping). analogFrame must draw the window the store NOW holds,
  // not the bins the stale origin still points at.
  {
    const loopStore = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
    const words = new Uint16Array(400_000);
    for (let i = 0; i < words.length; i++) words[i] = Math.floor(i / 2500) & 0xff;
    loopStore.append(new Uint8Array(words.buffer));
    const stale = adcView();
    stale.builder = new BusBuilder(loopStore, adcSpec, loopStore.length, undefined, 800_000);
    while (!stale.builder.step(10)) { /* build */ }
    stale.builder.setLength(loopStore.length);
    loopStore.dropFront(81_920); // leaf-aligned; the 32-column window slides 80 leaves
    const noRefresh = analogFrame(loopStore, stale, 0, loopStore.length, 32, true);
    const reference = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
    reference.append(new Uint8Array(words.buffer, 81_920 * 2));
    const fresh = adcView();
    fresh.builder = new BusBuilder(reference, adcSpec, reference.length, undefined, 800_000);
    while (!fresh.builder.step(10)) { /* build */ }
    fresh.builder.setLength(reference.length);
    const want = analogFrame(reference, fresh, 0, reference.length, 32, true);
    const mismatches: string[] = [];
    if (noRefresh.kind !== 'columns' || want.kind !== 'columns') {
      mismatches.push(`kinds ${noRefresh.kind}/${want.kind}`);
    } else {
      for (let c = 0; c < 32; c++) {
        if (noRefresh.min[c] !== want.min[c] || noRefresh.max[c] !== want.max[c]) {
          mismatches.push(`c${c}: ${noRefresh.min[c]}..${noRefresh.max[c]} vs ${want.min[c]}..${want.max[c]}`);
          break;
        }
      }
    }
    check('a frame drawn before the pump refreshes still reads the dropped window',
      mismatches.length === 0,
      mismatches.length === 0
        ? `dropped 81920 with the origin stale: 32 columns match a fresh store (c0=${want.kind === 'columns' ? want.min[0] : '?'})`
        : mismatches.join('; '));
  }
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
