// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the Repeat-display region-surface suite.
 *
 * Run from the repository root (the aggregate runner does it automatically):
 *   npm test -- --filter repeat-region
 *
 * What is pinned here:
 *
 *   - the pure `regionTintRects` helper, which the App will use to turn two x spans and
 *     the row boxes into fills: x is clamped to the plot, empty/reversed spans are
 *     dropped, one fill is produced per trace band (the separator is left alone), every
 *     edge is snapped to a device pixel, and each fill carries its region's colour;
 *   - `Overlay.drawRegionTint` exists and paints on the GRID canvas, not the annotation
 *     canvas - the grid canvas is the layer that composites `lighten` (dark theme) /
 *     `darken` (light theme) so a surface reads as a background behind the traces;
 *   - the tint contains no vertical rule (no stroke/moveTo/lineTo in its body);
 *   - the palette carries two distinct Repeat surfaces in both themes, placed on the
 *     correct side of the plot background for the blend mode to show them: lighter than
 *     the dark plot, darker than the white one;
 *   - the documented call order is beginFrame -> drawRegionTint -> drawGrid, and the
 *     method is defined before `drawGrid` in the class.
 */

import { Overlay, regionTintRects } from '../overlay.js';
import { canvasPalette, type CanvasPalette } from '../canvasPalette.js';

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

function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** WCAG relative luminance, used to compare surfaces against their plot background. */
function luminance(hex: string): number {
  const linear = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

const oneRow = [{ top: 0, band: 48 }];

// ---------------------------------------------------------------- pure layout

{
  const rects = regionTintRects([
    { startCss: -50, endCss: 10, color: '#111111' },
    { startCss: 10, endCss: 10, color: '#222222' },
    { startCss: 1000, endCss: 2000, color: '#333333' },
  ], oneRow, 100, 1);
  check('region x is clamped to the plot and empty/reversed regions are dropped',
    rects.length === 1 && rects[0]!.x === 0 && rects[0]!.w === 10,
    JSON.stringify(rects));
}

{
  const rects = regionTintRects([{ startCss: 0, endCss: 100, color: '#123456' }],
    [{ top: 0, band: 50 }, { top: 52, band: 48 }], 100, 1);
  check('one fill per trace band, with the 2 px row separator left uncovered',
    rects.length === 2 &&
    rects[0]!.y === 0 && rects[0]!.h === 50 &&
    rects[1]!.y === 52 && rects[1]!.h === 48 &&
    rects[0]!.x === 0 && rects[0]!.w === 100,
    JSON.stringify(rects));
}

{
  const rects = regionTintRects([{ startCss: 10.3, endCss: 20.7, color: '#abcdef' }],
    [{ top: 3.3, band: 20.3 }], 100, 2);
  check('region and row edges snap to whole device pixels at a fractional DPR',
    rects.length === 1 &&
    rects[0]!.x === 10.5 && rects[0]!.w === 10 &&
    rects[0]!.y === 3.5 && rects[0]!.h === 20,
    JSON.stringify(rects));
}

{
  const rects = regionTintRects([
    { startCss: 0, endCss: 40, color: '#111111' },
    { startCss: 40, endCss: 100, color: '#222222' },
  ], oneRow, 100, 1);
  check('adjacent old/new regions keep their own surface colours and share the boundary',
    rects.length === 2 &&
    rects[0]!.color === '#111111' && rects[1]!.color === '#222222' &&
    rects[0]!.x + rects[0]!.w === rects[1]!.x,
    JSON.stringify(rects));
}

{
  const rects = regionTintRects(
    [
      { startCss: Number.NaN, endCss: 10, color: '#111111' },
      { startCss: 0, endCss: Number.POSITIVE_INFINITY, color: '#222222' },
    ],
    [{ top: Number.NaN, band: 10 }, { top: 0, band: Number.NaN }],
    100, 1,
  );
  check('non-finite region and row geometry is ignored rather than painted',
    rects.length === 0, JSON.stringify(rects));
}

{
  const rects = regionTintRects([{ startCss: 0, endCss: 10, color: '#111111' }],
    [{ top: 0, band: 10 }], 0, 1);
  check('a zero-width plot produces no fills', rects.length === 0, JSON.stringify(rects));
}

// ------------------------------------------------------------------- palette

function paletteChecks(id: 'dark' | 'light', p: CanvasPalette, label: string): void {
  const prev = p.repeatPreviousSurface;
  const curr = p.repeatCurrentSurface;
  const hex = /^#[0-9a-f]{6}$/i;
  const bg = p.bg;
  const darkerThanBg = id === 'light'
    ? luminance(prev) < luminance(bg) && luminance(curr) < luminance(bg)
    : false;
  const lighterThanBg = id === 'dark'
    ? luminance(prev) > luminance(bg) && luminance(curr) > luminance(bg)
    : false;
  const blendSide = id === 'light' ? darkerThanBg : lighterThanBg;
  const separated =
    Math.abs(luminance(prev) - luminance(curr)) / Math.max(luminance(prev), luminance(curr)) > 0.2 ||
    Math.abs(rgb(prev)[0] - rgb(curr)[0]) + Math.abs(rgb(prev)[1] - rgb(curr)[1]) +
      Math.abs(rgb(prev)[2] - rgb(curr)[2]) >= 24;
  check(`the ${label} palette carries two distinct, blend-correct Repeat surfaces`,
    hex.test(prev) && hex.test(curr) && prev.toLowerCase() !== curr.toLowerCase() &&
    blendSide && separated,
    `bg=${bg} prev=${prev} (${luminance(prev).toFixed(4)}) ` +
    `curr=${curr} (${luminance(curr).toFixed(4)}) separated=${separated}`);
}

paletteChecks('dark', canvasPalette('dark'), 'dark');
paletteChecks('light', canvasPalette('light'), 'light');

// -------------------------------------------------------------------- source

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const overlaySrc = fs.readFileSync('src/ui/overlay.ts', 'utf8');
const paletteSrc = fs.readFileSync('src/ui/canvasPalette.ts', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');

{
  const method = overlaySrc.split('drawRegionTint(regions: readonly')[1]?.split('drawGrid(')[0] ?? '';
  check('Overlay exposes drawRegionTint',
    typeof (Overlay.prototype as { drawRegionTint?: unknown }).drawRegionTint === 'function' &&
    method.length > 0,
    `type=${typeof (Overlay.prototype as { drawRegionTint?: unknown }).drawRegionTint}`);
  check('the tint paints on the grid canvas, not the annotation canvas',
    method.includes('this.gridCtx') && !method.includes('this.ctx.') &&
    !method.includes('const c = this.ctx'),
    `grid=${method.includes('this.gridCtx')}, top=${method.includes('this.ctx.')}`);
  const overlayMethod = overlaySrc.split('drawRegionTintOverlay(')[1]?.split('private paintRegionTint')[0] ?? '';
  check('lane and blank rows can carry the same tint on the annotation canvas',
    overlaySrc.includes('drawRegionTintOverlay(') &&
    overlayMethod.includes('this.paintRegionTint(this.ctx'),
    `overlay=${overlayMethod.replace(/\s+/g, ' ').slice(0, 100)}`);
  check('the tint draws no vertical rule',
    !/\bstroke\s*\(/.test(method) && !/\b(moveTo|lineTo|beginPath)\s*\(/.test(method),
    method.replace(/\s+/g, ' ').slice(0, 160));
}

{
  const begin = overlaySrc.indexOf('beginFrame(clear: ClearedCanvases)');
  const tint = overlaySrc.indexOf('drawRegionTint(regions: readonly');
  const grid = overlaySrc.indexOf('drawGrid(ticks: TickSet');
  const order = begin >= 0 && begin < tint && tint < grid;
  const documented = overlaySrc.includes('overlay.beginFrame(clearedCanvases(plan));') &&
    overlaySrc.includes('overlay.drawRegionTint(regions, boxes);') &&
    overlaySrc.includes('overlay.drawGrid(ticks);') &&
    overlaySrc.indexOf('overlay.beginFrame(clearedCanvases(plan));') <
      overlaySrc.indexOf('overlay.drawRegionTint(regions, boxes);') &&
    overlaySrc.indexOf('overlay.drawRegionTint(regions, boxes);') <
      overlaySrc.indexOf('overlay.drawGrid(ticks);');
  check('the documented and source order is beginFrame -> drawRegionTint -> drawGrid',
    order && documented, `begin=${begin}, tint=${tint}, grid=${grid}, documented=${documented}`);
}

{
  const gridRule = css.split('.grid-canvas {')[1]?.split('}')[0] ?? '';
  const lightRule = css.split('html[data-theme="light"] .grid-canvas')[1]?.split('}')[0] ?? '';
  check('the grid canvas composites the tint behind the traces in both themes',
    /mix-blend-mode:\s*lighten/.test(gridRule) && /mix-blend-mode:\s*darken/.test(lightRule),
    `dark=${gridRule.trim()}, light=${lightRule.trim()}`);
  const constructor = overlaySrc.split('constructor(container')[1]?.split('setPalette')[0] ?? '';
  check('the grid canvas is created and appended below the annotation canvas',
    constructor.indexOf('appendChild(this.grid)') >= 0 &&
    constructor.indexOf('appendChild(this.grid)') < constructor.indexOf('appendChild(this.top)'),
    `grid=${constructor.indexOf('appendChild(this.grid)')}, ` +
    `top=${constructor.indexOf('appendChild(this.top)')}`);
}

{
  const fields = paletteSrc.includes('repeatPreviousSurface:') &&
    paletteSrc.includes('repeatCurrentSurface:') &&
    (paletteSrc.match(/repeatPreviousSurface:/g) ?? []).length === 3 &&
    (paletteSrc.match(/repeatCurrentSurface:/g) ?? []).length === 3;
  check('both theme palettes define the two Repeat surfaces', fields,
    `previous=${(paletteSrc.match(/repeatPreviousSurface:/g) ?? []).length}, ` +
    `current=${(paletteSrc.match(/repeatCurrentSurface:/g) ?? []).length}`);
}

{
  // App integration is owned elsewhere; when it lands, the tint must be requested
  // before the gridlines of the same frame.
  const appCall = (() => {
    try {
      return fs.readFileSync('src/ui/app.ts', 'utf8');
    } catch {
      return '';
    }
  })();
  const tintAt = appCall.indexOf('drawRegionTint');
  const gridAt = appCall.indexOf('drawGrid(');
  check('if the App is wired, it requests the tint before drawGrid',
    tintAt < 0 || (gridAt >= 0 && tintAt < gridAt),
    `tintAt=${tintAt}, gridAt=${gridAt}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
