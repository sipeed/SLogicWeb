// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test fixture access (not shipped behaviour): the real ADC traces in `fixtures/`
 * (fixtures/ADC-TRACES.md), one ADC code per byte, read under node from the repo root,
 * plus the checks every analog-trigger self-test applies to a reported crossing.
 */

import { qualifiedCrossings } from './analogRunQualifier.js';

export const ADC_TRACE_FILES = {
  sine: 'fixtures/adc-sine-carry-glitches-100MSps.bin',
  am3: 'fixtures/adc-am-3MHz-carrier-100MSps.bin',
  am33: 'fixtures/adc-am-33MHz-carrier-100MSps.bin',
} as const;

export type AdcTraceName = keyof typeof ADC_TRACE_FILES;

/** The measured qualification at 100 MS/s: h = 4 codes, W = ceil(240 ns * rate) = 24. */
export const TRACE_HYSTERESIS = 4;
export const TRACE_WINDOW = 24;

/** Levels inside each trace's code range (per ADC-TRACES.md). */
export const ADC_TRACE_LEVELS: Readonly<Record<AdcTraceName, readonly number[]>> = {
  sine: [100, 112, 128, 144, 160],
  am3: [110, 128, 145],
  am33: [120, 128, 136],
};

interface FsLike { readFileSync(path: string): Uint8Array }

const cache = new Map<AdcTraceName, Uint8Array>();

/** The trace's codes (cached). Throws outside node. */
export function loadAdcTrace(name: AdcTraceName): Uint8Array {
  const hit = cache.get(name);
  if (hit) return hit;
  const proc = (globalThis as { process?: { getBuiltinModule?(id: string): unknown } }).process;
  const fs = proc?.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const buf = fs.readFileSync(ADC_TRACE_FILES[name]);
  const codes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  cache.set(name, codes);
  return codes;
}

/** Median of the 31 codes centred on `i` (clamped to the trace). */
export function medianCode(codes: Uint8Array, i: number): number {
  const window: number[] = [];
  for (let k = i - 15; k <= i + 15; k++) if (k >= 0 && k < codes.length) window.push(codes[k]!);
  window.sort((x, y) => x - y);
  return window[window.length >> 1]!;
}

/** The slow trend's slope at `i`: median-of-31 at i + 300 minus at i - 300. */
export function traceSlope(codes: Uint8Array, i: number): number {
  return medianCode(codes, i + 300) - medianCode(codes, i - 300);
}

/**
 * Why `t` is not a real crossing of `level` on `codes`, or '' when it is: the sample
 * before it is on the other side, T is at/past the level, and the run starting at T is
 * not an OR artifact (at most `window` samples, ends, every code the OR-shape of both
 * neighbours).
 */
export function crossingProblem(
  codes: Uint8Array, t: number, rising: boolean, level: number, window = TRACE_WINDOW,
): string {
  const past = (c: number): boolean => rising ? c >= level : c <= level;
  if (!(t >= 1 && t < codes.length)) return `T=${t} outside the trace`;
  if (!past(codes[t]!)) return `T=${t} code ${codes[t]} is not past ${level}`;
  if (past(codes[t - 1]!)) return `T=${t} predecessor ${codes[t - 1]} is already past ${level}`;
  let j = t;
  while (j < codes.length && past(codes[j]!) && j - t <= window) j++;
  if (j - t <= window && j < codes.length) {
    const a = codes[t - 1]!;
    const b = codes[j]!;
    let artifact = true;
    for (let k = t; k < j && artifact; k++) {
      const g = codes[k]!;
      if ((g & a) !== a || (g & b) !== b || g <= Math.max(a, b)) artifact = false;
    }
    if (artifact) return `T=${t} starts an OR-artifact run ${a} [${Array.from(codes.subarray(t, j)).join(',')}] ${b}`;
  }
  return '';
}

/** Oracle crossings of a whole trace from sample `from` (a continuous stream). */
export function traceCrossings(
  codes: Uint8Array, rising: boolean, level: number, from = 0,
  hysteresis = TRACE_HYSTERESIS, window = TRACE_WINDOW,
): number[] {
  return qualifiedCrossings(codes.subarray(from), rising, level, hysteresis, window)
    .map((t) => t + from);
}
