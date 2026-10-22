// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the channel color picker suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/color-picker-selftest.ts --bundle \
 *     --format=esm --platform=node --outfile=/tmp/color-picker-selftest.mjs && \
 *     node /tmp/color-picker-selftest.mjs
 *
 * Run from the repository root. Prints PASS/FAIL per check and exits non-zero on any
 * failure.
 */

import { hexFromHsv, hsvFromHex, hueFromPoint, stepHsv, stepHue, svFromPoint } from '../colorMath.js';
import { CHANNEL_COLOR_PRESETS } from '../metrics.js';

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

{
  const anchors: readonly [string, number, number, number][] = [
    ['#FF0000', 0, 1, 1],
    ['#FFFF00', 60, 1, 1],
    ['#00FF00', 120, 1, 1],
    ['#00FFFF', 180, 1, 1],
    ['#0000FF', 240, 1, 1],
    ['#FF00FF', 300, 1, 1],
  ];
  const bad = anchors.filter(([hex, h, s, v]) => {
    const hsv = hsvFromHex(hex);
    return hsv.h !== h || hsv.s !== s || hsv.v !== v;
  });
  check('the six primaries land on exact hue anchors',
    bad.length === 0,
    bad.length === 0 ? '6/6 exact' : bad.map(([hex]) => hex).join(','));
}

{
  const grays: readonly [string, number][] = [
    ['#000000', 0],
    ['#FFFFFF', 1],
    ['#808080', 128 / 255],
    ['#7F7F7F', 127 / 255],
  ];
  const bad = grays.filter(([hex, v]) => {
    const hsv = hsvFromHex(hex);
    return hsv.h !== 0 || hsv.s !== 0 || hsv.v !== v;
  });
  check('grays carry zero hue and saturation with exact value',
    bad.length === 0,
    bad.length === 0 ? '4/4 exact' : bad.map(([hex]) => hex).join(','));
}

{
  const sectors: readonly [string, string][] = [
    ['#FF0101', '0.0000'],
    ['#FFFE01', '59.7638'],
    ['#01FF01', '120.0000'],
  ];
  const bad = sectors.filter(([hex, h4]) => hsvFromHex(hex).h.toFixed(4) !== h4);
  check('sector-boundary hues pin to four decimals',
    bad.length === 0,
    bad.length === 0
      ? '3/3 pinned'
      : bad.map(([hex, h4]) => `${hex}: want ${h4}, got ${hsvFromHex(hex).h.toFixed(4)}`).join(', '));
}

{
  const named: readonly [string, string, string, string][] = [
    ['#C81A21', '357.5862', '0.8700', '0.7843'],
    ['#5A7100', '72.2124', '1.0000', '0.4431'],
    ['#007971', '176.0331', '1.0000', '0.4745'],
    ['#E94D95', '332.3077', '0.6695', '0.9137'],
    ['#C084FC', '270.0000', '0.4762', '0.9882'],
  ];
  const bad = named.filter(([hex, h, s, v]) => {
    const hsv = hsvFromHex(hex);
    return hsv.h.toFixed(4) !== h || hsv.s.toFixed(4) !== s || hsv.v.toFixed(4) !== v;
  });
  check('named channel colors pin their full hsv values',
    bad.length === 0,
    bad.length === 0 ? '5/5 pinned' : bad.map(([hex]) => hex).join(','));
}

{
  const bad = CHANNEL_COLOR_PRESETS.filter((c) =>
    hexFromHsv(hsvFromHex(c)) !== c || !/^#[0-9A-F]{6}$/.test(hexFromHsv(hsvFromHex(c))));
  check('every named channel color survives an exact uppercase round trip',
    bad.length === 0 && CHANNEL_COLOR_PRESETS.length === 15,
    `${CHANNEL_COLOR_PRESETS.length - bad.length}/${CHANNEL_COLOR_PRESETS.length} round-tripped`);
}

{
  const stride = 7;
  let samples = 0;
  let mismatches = 0;
  for (let n = 0; n < 0x1000000; n += stride) {
    samples++;
    const hex = `#${n.toString(16).padStart(6, '0')}`.toUpperCase();
    if (hexFromHsv(hsvFromHex(hex)) !== hex) mismatches++;
  }
  check('the hex to hsv to hex round trip is exact for every sampled sRGB color',
    mismatches === 0 && samples === 2396746,
    `stride=${stride}, samples=${samples}, mismatches=${mismatches}`);
}

{
  const wrap = hexFromHsv({ h: 360, s: 1, v: 1 }) === '#FF0000' &&
    hexFromHsv({ h: -30, s: 1, v: 1 }) === '#FF0080' &&
    hexFromHsv({ h: 359, s: 1, v: 1 }) === '#FF0004';
  const clamps = hexFromHsv({ h: 120, s: -0.2, v: 2 }) === '#FFFFFF' &&
    hexFromHsv({ h: 120, s: 1.4, v: 1 }) === '#00FF00' &&
    hexFromHsv({ h: 720.5, s: 1, v: 1 }) === '#FF0200';
  let nanThrew = false;
  let nopeThrew = false;
  try { hexFromHsv({ h: NaN, s: 1, v: 1 }); } catch { nanThrew = true; }
  try { hsvFromHex('nope'); } catch { nopeThrew = true; }
  const lower = hsvFromHex('#c81a21');
  const upper = hsvFromHex('#C81A21');
  const caseTolerant = lower.h === upper.h && lower.s === upper.s && lower.v === upper.v;
  check('hexFromHsv wraps and clamps hostile input while NaN and bad hex throw',
    wrap && clamps && nanThrew && nopeThrew && caseTolerant,
    `wrap=${wrap}, clamps=${clamps}, nanThrew=${nanThrew}, nopeThrew=${nopeThrew}, case=${caseTolerant}`);
}

{
  const rect = { left: 10, top: 10, width: 200, height: 100 };
  const cases: readonly [number, number, number, number][] = [
    [10, 10, 0, 1],
    [210, 110, 1, 0],
    [110, 60, 0.5, 0.5],
    [5, 5, 0, 1],
    [400, 400, 1, 0],
  ];
  const bad = cases.filter(([x, y, s, v]) => {
    const sv = svFromPoint(rect, x, y);
    return sv.s !== s || sv.v !== v;
  });
  const degenerate = svFromPoint({ left: 0, top: 0, width: 0, height: 0 }, 0, 0);
  const finite = Number.isFinite(degenerate.s) && Number.isFinite(degenerate.v) &&
    degenerate.s === 0 && degenerate.v === 0;
  check('svFromPoint maps, inverts y, clamps outside, and survives a zero rect',
    bad.length === 0 && finite,
    `cases=${cases.length - bad.length}/${cases.length}, degenerate=${JSON.stringify(degenerate)}`);
}

{
  const strip = { left: 0, top: 0, width: 360, height: 12 };
  const mid = hueFromPoint(strip, 180) === 180;
  const lo = hueFromPoint(strip, -10) === 0;
  const hi = hueFromPoint(strip, 400);
  const degenerate = hueFromPoint({ left: 0, top: 0, width: 0, height: 0 }, 100) === 0;
  check('hueFromPoint maps degrees and stays below 360 at the right edge',
    mid && lo && hi < 360 && hi >= 0 && degenerate,
    `mid=${mid}, lo=${lo}, hi=${hi}, degenerate=${degenerate}`);
}

{
  const base = { h: 220, s: 0.5, v: 0.5 };
  const rows: readonly [string, boolean, string, string][] = [
    ['ArrowRight', false, 'sv', '0.51/0.50'],
    ['ArrowLeft', true, 'sv', '0.40/0.50'],
    ['ArrowUp', false, 'sv', '0.50/0.51'],
    ['ArrowDown', true, 'sv', '0.50/0.40'],
    ['Home', false, 'null', ''],
    ['End', false, 'null', ''],
    ['PageUp', false, 'null', ''],
    ['PageDown', false, 'null', ''],
    ['Escape', false, 'null', ''],
    ['Tab', false, 'null', ''],
    [' ', false, 'null', ''],
    ['f', false, 'null', ''],
  ];
  const bad = rows.filter(([key, shift, kind, expected]) => {
    const next = stepHsv(base, key, shift);
    if (kind === 'null') return next !== null;
    if (next === null) return true;
    return `${next.s.toFixed(2)}/${next.v.toFixed(2)}` !== expected;
  });
  const clamped = stepHsv({ h: 0, s: 0, v: 0 }, 'ArrowLeft', false);
  check('stepHsv walks saturation and brightness and ignores unmapped keys',
    bad.length === 0 && clamped !== null && clamped.s === 0 && clamped.v === 0 &&
      stepHsv(base, 'ArrowLeft', false)?.h === 220,
    `bad=${bad.map(([k]) => k).join(',') || 'none'}, clamped=${JSON.stringify(clamped)}`);
}

{
  const rows: readonly [number, string, boolean, number | null][] = [
    [180, 'ArrowRight', false, 181],
    [180, 'ArrowLeft', true, 170],
    [359, 'ArrowRight', false, 0],
    [0, 'ArrowLeft', false, 359],
    [42, 'Home', false, 0],
    [42, 'End', false, 359],
    [42, 'ArrowUp', false, null],
    [42, 'ArrowDown', false, null],
    [42, 'Escape', false, null],
    [42, 'Tab', false, null],
    [42, ' ', false, null],
    [42, 'f', false, null],
  ];
  const bad = rows.filter(([h, key, shift, expected]) => stepHue(h, key, shift) !== expected);
  check('stepHue steps, wraps, and homes while ignoring vertical and system keys',
    bad.length === 0,
    bad.length === 0 ? '12/12 rows' : bad.map(([h, k]) => `${h}:${k}`).join(','));
}

{
  const grayA = hexFromHsv({ h: 220, s: 0, v: 0.5 });
  const grayB = hexFromHsv({ h: 0, s: 0, v: 0.5 });
  check('gray is hue-free by construction, so hue survives only as picker state',
    grayA === '#808080' && grayB === '#808080' && hsvFromHex(grayA).h === 0,
    `grayA=${grayA}, grayB=${grayB}, rederivedHue=${hsvFromHex(grayA).h}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const pickerSource = fs.readFileSync('src/ui/colorPicker.ts', 'utf8');
  const ariaSliders = (pickerSource.match(/setAttribute\('role', 'slider'\)/g) ?? []).length === 2 &&
    (pickerSource.match(/\.tabIndex = 0/g) ?? []).length === 2 &&
    pickerSource.includes("setAttribute('aria-valuetext'") &&
    pickerSource.includes("setAttribute('aria-valuenow'") &&
    pickerSource.includes("setAttribute('aria-orientation', 'horizontal'") &&
    pickerSource.includes("t('channels.colorField')") &&
    pickerSource.includes("t('channels.hue')");
  const pointerModel = pickerSource.includes('setPointerCapture(event.pointerId)') &&
    pickerSource.includes("this.wireDrag(this.field, 'field')") &&
    pickerSource.includes("this.wireDrag(this.hueStrip, 'hue')") &&
    pickerSource.includes("addEventListener('pointercancel'") &&
    pickerSource.includes("addEventListener('lostpointercapture'") &&
    pickerSource.includes('event.preventDefault()') &&
    pickerSource.includes('event.stopPropagation()') &&
    pickerSource.includes('.shiftKey') &&
    pickerSource.includes('event.pointerId') &&
    !pickerSource.includes('document.addEventListener') &&
    !pickerSource.includes('window.addEventListener');
  const noComments = !pickerSource.includes('//') && !pickerSource.includes('/*');
  check('the picker widget keeps the pointer, keyboard, and aria contract comment-free',
    ariaSliders && pointerModel && noComments,
    `aria=${ariaSliders}, pointer=${pointerModel}, noComments=${noComments}`);

  const styleSheet = fs.readFileSync('src/ui/style.css', 'utf8');
  const sheet = /\.channel-color-field\s*\{[^}]*touch-action:\s*none/.test(styleSheet) &&
    /\.channel-color-hue\s*\{[^}]*touch-action:\s*none/.test(styleSheet) &&
    /\.channel-color-field\s*\{[^}]*border-radius:\s*calc\(var\(--radius\) - 4px\)/.test(styleSheet) &&
    /\.channel-color-hue\s*\{[^}]*border-radius:\s*calc\(var\(--radius\) - 2px\)/.test(styleSheet) &&
    /\.channel-color-field\s*\{[^}]*linear-gradient\(to top, #000, transparent\)/.test(styleSheet) &&
    /\.channel-color-hue\s*\{[^}]*hsl\(0 100% 50%\) 0%/.test(styleSheet) &&
    !styleSheet.includes('.channel-color-palette-grid') &&
    !styleSheet.includes('.channel-color-palette-swatch') &&
    !styleSheet.includes('.channel-color-palette-more') &&
    !styleSheet.includes('.channel-color-palette-input');
  check('the picker sheet is themed, touch-safe, and retires the matrix rules',
    sheet,
    `sheet=${sheet}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
