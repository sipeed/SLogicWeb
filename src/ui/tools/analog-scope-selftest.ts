// SPDX-License-Identifier: GPL-3.0-or-later

import { canvasPalette } from '../canvasPalette.js';
import {
  SCOPE_DIVISIONS_MAX, SCOPE_DIVISIONS_MIN, SCOPE_VDIV_VALUES, formatScopeVolts, nextScopeVoltsPerDiv,
  scopeDefaultVoltsPerDiv, scopeDivisions, scopeGeometry, scopeRowDivisions, scopeScaleAt,
  scopeTickIndices, scopeVoltsAtY, scopeVoltsPerDivValues,
} from '../scopeScale.js';
import {
  ANALOG_COMPACT_MIN_HEIGHT, ANALOG_DEFAULT_HEIGHT, ANALOG_HEIGHTS, BUS_HEIGHTS,
  analogDisplayHeight, analogHeightIndex, snapAnalogHeight, stepAnalogHeight,
} from '../busView.js';
import {
  ANALOG_GAIN_PRESETS, analogBusConfig, analogDefaultVoltsPerDiv, analogHalfRangeV,
  analogVoltsPerDivValues, isAnalogGain,
} from '../channelBanks.js';
import { ROWS } from '../metrics.js';

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
const geometry = fs.readFileSync('src/ui/analogGeometry.ts', 'utf8');
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

// ---- The graticule follows the row height (DESIGN.md §5.4) ------------------------
{
  // Every stop, and heights between stops: ~38 px a division, even, 4..8.
  const atStops = ANALOG_HEIGHTS.map((h) => scopeRowDivisions(h));
  const stops = atStops.join(',') === '4,4,4,6,8,8,8';
  const between: Array<[number, number]> = [
    [60, 4], [96, 4], [140, 4], [200, 4], [204, 6], [220, 6], [279, 6], [281, 8], [360, 8], [1000, 8],
  ];
  const mid = between.every(([h, n]) => scopeRowDivisions(h) === n);
  let even = true;
  let monotone = true;
  let previous = 0;
  for (let band = 0; band <= 600; band++) {
    const n = scopeDivisions(band);
    even &&= n % 2 === 0 && n >= SCOPE_DIVISIONS_MIN && n <= SCOPE_DIVISIONS_MAX;
    monotone &&= n >= previous;
    previous = n;
    // The geometry carries the same count, so every consumer agrees.
    even &&= scopeGeometry(0, band, 1, 0.5).divisions === n;
  }
  const corrupt = scopeDivisions(Number.NaN) === 4 && scopeDivisions(-50) === 4 &&
    scopeDivisions(Number.POSITIVE_INFINITY) === 4;
  const pitch = ANALOG_HEIGHTS.filter((h) => h >= 160 && h <= 320).every((h) => {
    const inner = h - ROWS.separator - 12;
    return Math.abs(inner / scopeRowDivisions(h) - 38) < 3;
  });
  check('analog divisions follow the band: 4 up to 160 px, 6 at 240, 8 from 320, even and monotone',
    stops && mid && even && monotone && corrupt && pitch,
    `stops=${atStops.join(',')}, mid=${mid}, even=${even}, monotone=${monotone}, corrupt=${corrupt}, pitch=${pitch}`);
}

{
  // Geometry round trip, top/bottom edges, and ticks at 4/6/8 divisions.
  let inverse = true;
  let edges = true;
  let ticks = true;
  for (const [height, n] of [[160, 4], [240, 6], [320, 8], [480, 8]] as const) {
    const band = height - ROWS.separator;
    for (const perDiv of [0.05, 0.5, 1, 2, 5, 10, 20]) {
      for (const zero of [0, 0.25, 0.5, 0.75, 1]) {
        const g = scopeGeometry(30, band, perDiv, zero);
        edges &&= g.divisions === n &&
          Math.abs(g.topV - g.bottomV - perDiv * n) < 1e-9 &&
          Math.abs(g.yVolts(g.topV) - (30 + 6)) < 1e-9 &&
          Math.abs(g.yVolts(g.bottomV) - (30 + band - 6)) < 1e-9;
        for (const volts of [-40, -15, -1, 0, 0.3, 1, 15, 40]) {
          const y = g.yVolts(volts);
          inverse &&= Math.abs(scopeVoltsAtY(y, 30, band, perDiv, zero) - volts) < 1e-9;
        }
        // Consecutive integer division indices, all in range, about one per division.
        const k = scopeTickIndices(g, perDiv);
        ticks &&= k.length >= n && k.length <= n + 1 &&
          k.every((v, i) => i === 0 || v === k[i - 1]! + 1) &&
          k.every((v) => v * perDiv >= g.bottomV - 1e-9 && v * perDiv <= g.topV + 1e-9);
        // Centred: n + 1 lines with 0 V on the middle one.
        if (zero === 0.5) {
          ticks &&= k.join(',') === Array.from({ length: n + 1 }, (_, i) => i - n / 2).join(',');
        }
      }
    }
  }
  // Resizing keeps V/div and zero: 0 V stays at the same fraction, the range grows.
  const short = scopeGeometry(0, 158, 5, 0.5);
  const tall = scopeGeometry(0, 318, 5, 0.5);
  const resize = short.topV === 10 && tall.topV === 20 && tall.bottomV === -20 &&
    Math.abs((short.yVolts(0) - 6) / short.innerHeight - 0.5) < 1e-9 &&
    Math.abs((tall.yVolts(0) - 6) / tall.innerHeight - 0.5) < 1e-9;
  // The scale animation still drives the geometry mid-step at 8 divisions.
  const frame = scopeScaleAt(5, 2, 0, 70);
  const midTicks = scopeTickIndices(scopeGeometry(0, 318, frame.value, 0.5), 2).length;
  const animated = !frame.done && frame.value < 5 && frame.value > 2 && midTicks >= 9 && midTicks <= 21;
  check('scope geometry round-trips volts and draws one tick per division at 4, 6 and 8 divisions',
    inverse && edges && ticks && resize && animated,
    `inverse=${inverse}, edges=${edges}, ticks=${ticks}, resize=${resize}, animated=${animated}`);
}

{
  // A gain's default V/div is the finest 1-2-5 step showing its whole range on the row's
  // current divisions; the walkable slice does not depend on the height.
  const want: Record<number, Record<string, number>> = {
    4: { 0.1: 100, 0.5: 20, 1: 10, 2: 5, 3: 5, 5: 2, 10: 1, 20: 0.5, 100: 0.1 },
    6: { 0.1: 100, 0.5: 20, 1: 10, 2: 5, 3: 2, 5: 2, 10: 1, 20: 0.5, 100: 0.1 },
    8: { 0.1: 50, 0.5: 10, 1: 5, 2: 2, 3: 2, 5: 1, 10: 0.5, 20: 0.2, 100: 0.05 },
  };
  let ok = true;
  const misses: string[] = [];
  const gains = [...new Set([...ANALOG_GAIN_PRESETS, 0.1, 0.5, 1, 2, 3, 5, 10, 20, 100])]
    .filter((gain) => isAnalogGain(gain));
  for (const n of [4, 6, 8]) {
    for (const gain of gains) {
      const half = analogHalfRangeV(gain);
      const vdiv = analogDefaultVoltsPerDiv(gain, n);
      const finer = SCOPE_VDIV_VALUES.filter((v) => v < vdiv).pop();
      const shows = vdiv * n / 2 >= half - 1e-9 && (finer === undefined || finer * n / 2 < half - 1e-9);
      const expected = want[n]![String(gain)];
      const good = shows && (expected === undefined || expected === vdiv) &&
        analogVoltsPerDivValues(gain).includes(vdiv) && scopeDefaultVoltsPerDiv(half, n) === vdiv;
      if (!good) misses.push(`n${n}/G${gain}=${vdiv}`);
      ok &&= good;
    }
  }
  const covered = gains.includes(1) && gains.includes(10);
  const stableSlice = scopeVoltsPerDivValues(16).join(',') === '0.5,1,2,5,10,20' &&
    analogDefaultVoltsPerDiv(1) === 10;
  // A new row starts at 160 px (4 divisions) with the 4-division default.
  const created = analogBusConfig(0, 32, '#000000', 1);
  const fresh = created.heightCss === 160 && ANALOG_DEFAULT_HEIGHT === 160 && created.voltsPerDiv === 10;
  check('default V/div per gain x divisions shows the whole range at the finest step',
    ok && covered && stableSlice && fresh,
    `misses=${misses.join(' ')}, covered=${covered}, slice=${stableSlice}, fresh=${fresh}`);
}

{
  // Handle snapping and keyboard stops (`channelList` uses these helpers).
  const stops = ANALOG_HEIGHTS.join(',') === '80,120,160,240,320,400,480' &&
    BUS_HEIGHTS.every((h) => (ANALOG_HEIGHTS as readonly number[]).includes(h));
  const snap = snapAnalogHeight(80) === 80 && snapAnalogHeight(99) === 80 &&
    snapAnalogHeight(101) === 120 && snapAnalogHeight(199) === 160 && snapAnalogHeight(201) === 240 &&
    snapAnalogHeight(279) === 240 && snapAnalogHeight(281) === 320 && snapAnalogHeight(441) === 480 &&
    snapAnalogHeight(9999) === 480 && snapAnalogHeight(-10) === 80 &&
    snapAnalogHeight(Number.NaN) === 160 && analogHeightIndex(480) === 6;
  let up = 80;
  const walkedUp: number[] = [up];
  for (let i = 0; i < 8; i++) walkedUp.push(up = stepAnalogHeight(up, 1));
  let down = 480;
  const walkedDown: number[] = [down];
  for (let i = 0; i < 8; i++) walkedDown.push(down = stepAnalogHeight(down, -1));
  const keys = walkedUp.join(',') === '80,120,160,240,320,400,480,480,480' &&
    walkedDown.join(',') === '480,400,320,240,160,120,80,80,80' &&
    stepAnalogHeight(96, 1) === 120;
  const compact = analogDisplayHeight(80, true) === ANALOG_COMPACT_MIN_HEIGHT &&
    analogDisplayHeight(80, false) === 80 && analogDisplayHeight(480, true) === 480 &&
    ANALOG_COMPACT_MIN_HEIGHT === 96;
  // App snaps every scope patch onto the stops, and pins an unset V/div before resizing.
  const wired = app.includes('next.heightCss = snapAnalogHeight(patch.heightCss);') &&
    app.includes('if (heightChanged && next.voltsPerDiv == null) next.voltsPerDiv = this.scopeTargetVoltsPerDiv(bus);') &&
    !app.includes('Math.min(400, Math.round(patch.heightCss))');
  check('the analog height handle snaps drag and arrow keys to 80..480 px stops',
    stops && snap && keys && compact && wired,
    `stops=${stops}, snap=${snap}, keys=${walkedUp.join(',')}|${walkedDown.join(',')}, compact=${compact}, app=${wired}`);
}

{
  // Every consumer reads the division count from the geometry, never a constant.
  const consumers = overlay.includes('(geometry.topV - geometry.bottomV) / geometry.divisions') &&
    !overlay.includes('SCOPE_DIVISIONS') && !app.includes('SCOPE_DIVISIONS') &&
    app.includes('last = clampAnalogVolts(scopeVoltsAtY(atY, top, band, perDiv, zeroPosition), gain);');
  check('overlay, ruler and trigger drag share the band-derived division count', consumers,
    `consumers=${consumers}`);
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
    geometry.includes('export function catmullRomWalk(') &&
    geometry.includes('export function smoothBandEdges(') &&
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
    banks.includes('voltsPerDiv: analogDefaultVoltsPerDiv(analogGain, scopeRowDivisions(ANALOG_DEFAULT_HEIGHT)),') &&
    banks.includes('zeroPosition: 0.5');
  check('App hands analog banks the scope scale and smooth flag, with the gain\'s V/div default (10 V at 1x)',
    wired, `wired=${wired}`);
}

{
  const bar = app.includes("className = 'scope-scale-host'") &&
    app.includes("className = 'scope-scale-bar'") &&
    app.includes('private dragScopeBar(') && app.includes('private wheelScopeBar(') &&
    app.includes("bar.addEventListener('dblclick',") &&
    app.includes('private resetScopeBar(') && app.includes("event.key === 'Home'") &&
    app.includes('voltsPerDiv: this.scopeDefaultVoltsPerDiv(bus), zeroPosition: 0.5,') &&
    app.includes('private scopeVoltsPerDiv(') && app.includes('scopeScaleAt(') &&
    app.includes('tickVoltsPerDiv: this.scopeTargetVoltsPerDiv(bv)') &&
    app.includes('bus.voltsPerDiv ?? this.scopeDefaultVoltsPerDiv(bus)') &&
    app.includes('analogDefaultVoltsPerDiv(gain, scopeRowDivisions(this.rowHeightOf(bus)))') &&
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
    list.includes('ANALOG_HEIGHTS[analogHeightIndex(target)]') &&
    list.includes('stepAnalogHeight(cell.heightCss, direction)') &&
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
  // The digital channel dialog owns the channel colour; the analog bus rows' scope
  // controls must not grow a picker of their own.
  const busRows = list.slice(list.indexOf('  renderBuses('), list.indexOf('  render(cells'));
  const noColor = busRows.length > 0 && !busRows.includes('HsvPicker') &&
    !busRows.includes('CHANNEL_COLOR_PRESETS') && !busRows.includes('selectedColor');
  check('analog scope controls do not reintroduce colour editing', noColor, `noColor=${noColor}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
