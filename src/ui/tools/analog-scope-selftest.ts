// SPDX-License-Identifier: GPL-3.0-or-later

import { canvasPalette } from '../canvasPalette.js';
import {
  formatScopeVolts, nextScopeVoltsPerDiv, scopeGeometry, scopeScaleAt, scopeTickIndices, scopeVoltsAtY,
} from '../scopeScale.js';

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

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const overlay = fs.readFileSync('src/ui/overlay.ts', 'utf8');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const list = fs.readFileSync('src/ui/channelList.ts', 'utf8');
const banks = fs.readFileSync('src/ui/channelBanks.ts', 'utf8');
const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

{
  const centred = scopeGeometry(10, 126, 1, 0.5);
  const moved = scopeGeometry(10, 126, 1, 0.25);
  const anchored = scopeTickIndices(centred, 1).join(',') === '-2,-1,0,1,2' &&
    Math.abs(centred.yVolts(0) - 73) < 1e-9 &&
    Math.abs((centred.yVolts(2) - centred.yVolts(0)) -
      (moved.yVolts(2) - moved.yVolts(0))) < 1e-9 &&
    Math.abs(moved.yVolts(0) - 44.5) < 1e-9;
  const scale = nextScopeVoltsPerDiv(1, -1) === 0.5 &&
    nextScopeVoltsPerDiv(0.5, 1) === 1 &&
    formatScopeVolts(-0.5) === '-0.5 V' && formatScopeVolts(0) === '0 V';
  const wide = scopeGeometry(0, 120, 0.5, 0.5);
  const middle = scopeGeometry(0, 120, 0.75, 0.5);
  const narrow = scopeGeometry(0, 120, 1, 0.5);
  const extendsRuler = narrow.yVolts(0) - narrow.yVolts(1) === 27 &&
    middle.yVolts(0) - middle.yVolts(1) === 36 &&
    wide.yVolts(0) - wide.yVolts(1) === 54 &&
    scopeTickIndices(scopeGeometry(0, 120, 20, 0.5), 0.5).length === 0;
  const animated = scopeScaleAt(1, 2, 100, 100);
  let inverse = true;
  for (const band of [80, 120, 160, 240]) {
    for (const perDiv of [0.5, 1, 2, 5, 10, 20]) {
      for (const zero of [0, 0.25, 0.5, 0.75, 1]) {
        for (const volts of [-15, -1, 0, 1, 15]) {
          const y = scopeGeometry(20, band, perDiv, zero).yVolts(volts);
          inverse &&= Math.abs(scopeVoltsAtY(y, 20, band, perDiv, zero) - volts) < 1e-9;
        }
      }
    }
  }
  const midway = scopeScaleAt(1, 2, 100, 170);
  const done = scopeScaleAt(1, 2, 100, 240);
  check('the shared scope ruler stays 0 V-anchored and animates its spatial scale',
    anchored && scale && extendsRuler && inverse && animated.value === 1 && !animated.done &&
      midway.value > 1 && midway.value < 2 && !midway.done && done.value === 2 && done.done,
    `anchored=${anchored}, scale=${scale}, extends=${extendsRuler}, inverse=${inverse}, midway=${midway.value}, done=${done.done}`);
}

{
  const divisions = overlay.includes('scopeGeometry(') &&
    overlay.includes('scopeTickIndices(geometry, tickStep)') &&
    overlay.includes('formatScopeVolts(volts)');
  const grid = overlay.includes('c.globalAlpha = 0.7;') && overlay.includes('c.lineWidth = 2;') &&
    overlay.includes('c.setLineDash([4, 3]);') &&
    overlay.includes('if (geometry.bottomV <= 0 && geometry.topV >= 0)') &&
    overlay.includes('const rulerX = Math.round(this.wCss - 6) + 0.5;') &&
    !overlay.includes('The left scale bar') && !overlay.includes("c.fillText('Trig'");
  check('the analog row has a labelled right ruler, visible divisions, a thick 0 V line and dashed trigger',
    divisions && grid, `divisions=${divisions}, grid=${grid}`);
}

{
  const luminance = (hex: string): number => {
    const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
    const linear = rgb.map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const blendedLuminance = (foreground: string, background: string): number => {
    const rgb = [1, 3, 5].map((at) => Math.round(
      parseInt(foreground.slice(at, at + 2), 16) * 0.7 +
      parseInt(background.slice(at, at + 2), 16) * 0.3,
    ));
    return luminance(`#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  };
  const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const darkPalette = canvasPalette('dark');
  const lightPalette = canvasPalette('light');
  const dark = contrast(blendedLuminance(darkPalette.text50, darkPalette.bg),
    luminance(darkPalette.bg));
  const light = contrast(blendedLuminance(lightPalette.text50, lightPalette.bg),
    luminance(lightPalette.bg));
  check('nonzero graticule divisions remain visible in both themes', dark >= 3 && light >= 3,
    `dark=${dark.toFixed(2)}, light=${light.toFixed(2)}`);
}

{
  const smoothStart = overlay.indexOf("f.kind === 'columns' && o.smooth");
  const smoothEnd = overlay.indexOf("} else if (f.kind === 'columns')", smoothStart);
  const smoothColumns = smoothStart >= 0 && smoothEnd > smoothStart
    ? overlay.slice(smoothStart, smoothEnd) : '';
  const smooth = overlay.includes('function smoothTrace(') &&
    overlay.includes('c.lineTo(px, y(py))') &&
    overlay.includes('function catmullRomWalk(') &&
    overlay.includes('function smoothBandEdges(') &&
    overlay.includes("f.kind === 'points' && o.smooth") &&
    overlay.includes('smoothTrace(c, cx, cy, y)') &&
    // Never hold a trace flat across trailing unknown columns (a gap, or the not-yet-
    // captured right part of a trigger-anchored view).
    overlay.includes('const endsKnown = f.count > 0 && !Number.isNaN(f.v[f.count - 1]!);') &&
    overlay.includes('if (hasLast && endsKnown) c.lineTo(this.wCss, y(lastY));');
  // The columns band is Catmull-Rom through the per-column max and min; the closed path
  // follows those smoothed samples for both edges. The raw per-column staircase must not
  // survive.
  const envelope = smoothColumns.includes('smoothBandEdges(xs, mins, maxs)') &&
    smoothColumns.includes('const last = band.x.length - 1;') &&
    smoothColumns.includes('c.moveTo(band.x[0]!, y(band.upper[0]!));') &&
    smoothColumns.includes('c.lineTo(band.x[i]!, y(band.upper[i]!));') &&
    smoothColumns.includes('c.lineTo(band.x[i]!, y(band.lower[i]!));') &&
    smoothColumns.includes('c.globalAlpha = bandAlpha;') &&
    smoothColumns.includes('c.fill();') &&
    smoothColumns.includes('c.globalAlpha = edgeAlpha;') &&
    smoothColumns.includes('c.stroke();');
  // "No rectangular fill": no device-pixel bars and no straight envelope segments in the
  // smooth branch, and the fill stays translucent through the per-run alpha.
  const noRects = smoothColumns.length > 0 &&
    !smoothColumns.includes('fillRect') &&
    !smoothColumns.includes('setTransform') &&
    !smoothColumns.includes('c.lineTo(i / d, y(f.max[i]!))') &&
    !smoothColumns.includes('c.lineTo(i / d, y(f.min[i]!))');
  check('analog columns are reconstructed from a smooth Catmull-Rom min/max envelope plus centreline, with no bar fill',
    smooth && envelope && noRects, `smooth=${smooth}, envelope=${envelope}, noRects=${noRects}`);
}

{
  const wired = app.includes('const analogBank = bv.analogGroup !== undefined;') &&
    app.includes("style: analogBank ? 'line' :") &&
    app.includes('smooth: analogBank') &&
    app.includes('const scope = analogBank ? {') &&
    app.includes('zeroPosition: Math.min(1, Math.max(0, bv.zeroPosition ?? 0.5))') &&
    banks.includes('voltsPerDiv: 10') && banks.includes('zeroPosition: 0.5');
  check('App hands analog banks the scope scale and smooth flag, with a 10 V/div default',
    wired, `wired=${wired}`);
}

{
  const bar = app.includes("className = 'scope-scale-host'") &&
    app.includes("className = 'scope-scale-bar'") &&
    app.includes('private dragScopeBar(') && app.includes('private wheelScopeBar(') &&
    app.includes("bar.addEventListener('dblclick',") &&
    app.includes('private resetScopeBar(') && app.includes("event.key === 'Home'") &&
    app.includes('{ voltsPerDiv: 10, zeroPosition: 0.5 }, true') &&
    app.includes('private scopeVoltsPerDiv(') && app.includes('scopeScaleAt(') &&
    app.includes('tickVoltsPerDiv: bv.voltsPerDiv ?? 10') &&
    sheet.includes('.scope-scale-bar {') && sheet.includes('position: absolute; right: 0; width: 48px;') &&
    sheet.includes('cursor: ns-resize') && overlay.includes('const rulerX = Math.round(this.wCss - 6) + 0.5;');
  const triggerDrag = app.includes("className = 'scope-trigger-drag'") &&
    app.includes('private dragScopeTrigger(') && app.includes('triggerKind: analogTrigger.kind') &&
    sheet.includes('.scope-trigger-drag {') && sheet.includes('border-right: 7px solid var(--warning)') &&
    list.includes("triggerButton.className = 'bus-trigger'") &&
    overlay.includes('const triggerY = triggerVisible ? geometry.yVolts(scope.triggerVolts!) : 0;') &&
    overlay.includes('const triggerLabel =') && overlay.includes('formatScopeVolts(scope.triggerVolts!)') &&
    !list.includes('bus-trigger-value');
  const vdiv = overlay.includes('`${scope.tickVoltsPerDiv ?? scope.voltsPerDiv} ${scope.voltsPerDivUnit ?? \'V/div\'}`') &&
    overlay.includes('const scaleY = o.top + o.band - 10;') &&
    // Chips are placed before the tick loop and hide a label they would cut in half;
    // a trigger chip in the lowest division slides left rather than covering V/div.
    overlay.includes('const hidesLabel = (yy: number): boolean =>') &&
    overlay.includes('triggerX = vdiv.x0 - 2;') &&
    !list.includes('bus-scope-vdiv') && !list.includes('bus-scope-step') &&
    !list.includes('{ voltsPerDiv: next }');
  const height = list.includes("heightHandle.className = 'bus-height-handle'") &&
    list.includes('BUS_HEIGHTS[heightIndexAt(target)]') &&
    list.includes('this.cb.onBusScope?.(cell.id, { heightCss: height }, commit)') &&
    sheet.includes('.bus-cell:hover .bus-height-handle') && !list.includes('heightValue.textContent');
  const zeroRemoved = !list.includes('bus-zero-handle') && !sheet.includes('.bus-zero-handle') &&
    app.includes("this.configureBusScope(bus.id, { zeroPosition }, true)");
  const cancel = app.includes('const finish = (commit: boolean): void =>') &&
    app.includes('this.configureBusScope(bus.id, { zeroPosition: commit ? last : start }, commit);') &&
    app.includes('bar.focus({ preventScroll: true });') &&
    app.includes('this.settings = originalSettings;');
  check('right-ruler readouts replace left controls and double-click/Home reset scale and offset',
    vdiv && height && zeroRemoved && bar && triggerDrag && cancel,
    `vdiv=${vdiv}, height=${height}, zeroRemoved=${zeroRemoved}, bar=${bar}, trig=${triggerDrag}, cancel=${cancel}`);
}

{
  const noColor = !list.includes('HsvPicker') && !list.includes('CHANNEL_COLOR_PRESETS') &&
    !list.includes('selectedColor');
  check('analog scope controls do not reintroduce colour editing', noColor, `noColor=${noColor}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
