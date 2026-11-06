// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Vertical autoset on an analog row (DESIGN.md §5.2): from the visible window's drawn
 * frame (`analogFrameRange`) to a V/div and zero position (`scopeAutoset`), at the 4, 6
 * and 8 divisions a row's height gives. View state only; deterministic synthetic signals.
 */

import { type BusSpec } from '../../data/busValue.js';
import { PlanarSampleStore } from '../../data/planarStore.js';
import {
  ADC_ZERO_CODE, analogCodeFromVolts, analogDefaultVoltsPerDiv, analogVoltsFromCode,
  analogVoltsPerDivValues,
} from '../channelBanks.js';
import { analogFrame, analogFrameRange, type BusViewState } from '../busView.js';
import { SCOPE_AUTOSET_FILL, scopeAutoset, scopeGeometry } from '../scopeScale.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  results.push({ name, pass, detail });
};

const spec: BusSpec = { bits: [0, 1, 2, 3, 4, 5, 6, 7], clock: null, encoding: 'unsigned' };
const view = (): BusViewState => ({
  id: 'adc', name: 'A0', spec, color: '#fff', fullScaleV: null, offsetV: 0, bitOrder: 'lsb',
  style: 'line', heightCss: 160, hideSources: true, builder: null, builtFor: null, cache: null,
});

function storeOf(codes: readonly number[]): PlanarSampleStore {
  const words = new Uint16Array(codes.length);
  for (let i = 0; i < codes.length; i++) words[i] = codes[i]!;
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 1e6 });
  store.append(new Uint8Array(words.buffer));
  return store;
}

const LEN = 20_000;
/** A row band that shows each division count (`scopeDivisions`). */
const BAND = { 4: 160, 6: 240, 8: 320 } as const;
const sine = (gain: number, amplitudeV: number, offsetV = 0): number[] =>
  Array.from({ length: LEN }, (_, i) =>
    analogCodeFromVolts(offsetV + amplitudeV * Math.sin((2 * Math.PI * i) / 500), gain));

interface Case {
  name: string;
  gain: number;
  codes: number[];
  /** Expected V/div at 4, 6, 8 divisions; `default` = the gain's default there. */
  expect: Record<4 | 6 | 8, number | 'default'>;
}

const cases: Case[] = [
  { name: 'small ±1 V sine at 1x', gain: 1, codes: sine(1, 1), expect: { 4: 1, 6: 0.5, 8: 0.5 } },
  {
    name: 'full-range triangle at 3x', gain: 3,
    codes: Array.from({ length: LEN }, (_, i) => { const p = i % 510; return p < 256 ? p : 510 - p; }),
    expect: { 4: 5, 6: 5, 8: 2 },
  },
  { name: 'flat line at 1x', gain: 1, codes: new Array<number>(LEN).fill(ADC_ZERO_CODE + 20),
    expect: { 4: 'default', 6: 'default', 8: 'default' } },
  // Centring would put 0 V below the row: the clamp keeps zero at the bottom edge, and the
  // finer steps that would then cut the signal off are skipped.
  { name: '10..12 V offset sine at 1x', gain: 1, codes: sine(1, 1, 11), expect: { 4: 5, 6: 5, 8: 2 } },
];

for (const c of cases) {
  const store = storeOf(c.codes);
  // The whole capture on 800 px: a columns frame; a 300-sample window: a points frame.
  for (const [start, end] of [[0, LEN], [4000, 4300]] as const) {
    const frame = analogFrame(store, view(), start, end, 800, false);
    const range = analogFrameRange(frame);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) { lo = Math.min(lo, c.codes[i]!); hi = Math.max(hi, c.codes[i]!); }
    check(`${c.name} [${start}, ${end}) ${frame.kind}: the frame range is the window's code min..max`,
      range !== null && range.min === lo && range.max === hi,
      `frame ${range?.min}..${range?.max}, truth ${lo}..${hi}`);
    if (start !== 0 || !range) continue;
    const minV = analogVoltsFromCode(range.min, c.gain);
    const maxV = analogVoltsFromCode(range.max, c.gain);
    for (const divisions of [4, 6, 8] as const) {
      const fallback = analogDefaultVoltsPerDiv(c.gain, divisions);
      const got = scopeAutoset(minV, maxV, divisions, analogVoltsPerDivValues(c.gain), fallback);
      const want = c.expect[divisions] === 'default' ? fallback : c.expect[divisions] as number;
      const span = got.voltsPerDiv * divisions;
      const flat = c.expect[divisions] === 'default';
      const wantZero = flat ? 0.5 : Math.min(1, Math.max(0, 0.5 + (minV + maxV) / 2 / span));
      const g = scopeGeometry(0, BAND[divisions], got.voltsPerDiv, got.zeroPosition);
      const inside = flat || (minV >= g.bottomV - 1e-9 && maxV <= g.topV + 1e-9);
      const fits = flat || maxV - minV <= SCOPE_AUTOSET_FILL * span + 1e-9;
      check(`${c.name}, ${divisions} divisions: ${want} V/div, zero ${wantZero.toFixed(4)}, signal on the row`,
        got.voltsPerDiv === want && Math.abs(got.zeroPosition - wantZero) < 1e-9 && inside && fits &&
          got.zeroPosition >= 0 && got.zeroPosition <= 1 && g.divisions === divisions,
        `got ${got.voltsPerDiv} V/div zero ${got.zeroPosition.toFixed(4)}; signal ${minV.toFixed(3)}..` +
          `${maxV.toFixed(3)} V, row ${g.bottomV.toFixed(3)}..${g.topV.toFixed(3)} V`);
    }
  }
}

{
  // Nothing visible (an empty frame) falls back to the default.
  const empty = analogFrameRange({ kind: 'empty', reason: 'no-capture' });
  const fallback = scopeAutoset(Number.NaN, Number.NaN, 6, analogVoltsPerDivValues(1), 10);
  check('an empty window has no range and autoset keeps the default, 0 V centred',
    empty === null && fallback.voltsPerDiv === 10 && fallback.zeroPosition === 0.5,
    JSON.stringify(fallback));
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
