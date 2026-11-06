// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Time-axis labels: the pure text scheme (`axisLabels.ts`) and the collision-free layout
 * (`computeTicks` in `timeAxis.ts`), over spans from nanoseconds to tens of seconds,
 * negative and trigger-relative origins, and far-from-origin windows that need a base.
 *
 *   node_modules/.bin/esbuild src/ui/tools/axis-labels-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/axis-labels-selftest.mjs && node /tmp/axis-labels-selftest.mjs
 */

import {
  axisLabel, chooseUnit, formatAxisTime, formatStandaloneTime, planAxisLabels, stepDecimals,
} from '../axisLabels.js';
import { LABEL_GAP, computeTicks, type TickLabelMetrics, type TickSet } from '../timeAxis.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail = ''): void => {
  results.push({ name, pass, detail });
};

const MS = 1e9;
const US = 1e6;
const NS = 1e3;
const S = 1e12;

/** A deterministic stand-in for measureText: 7 px per character. */
const metrics: TickLabelMetrics = { measure: (text) => text.length * 7, offset: 1 };

const labelled = (set: TickSet): string[] => set.ticks.filter((t) => t.label !== '').map((t) => t.label);
const labelsOf = (startPs: number, endPs: number, width = 1000, rate?: number): TickSet =>
  computeTicks(startPs, endPs, width, rate, 45, metrics);

// --- formatting primitives -------------------------------------------------------------

check('the micro sign is used, never "us"',
  formatAxisTime(400 * US, 2, 0) === '400 µs', formatAxisTime(400 * US, 2, 0));
check('fixed decimals, sign only for negatives, "+" only when asked',
  formatAxisTime(1.4 * MS, 1, 3) === '1.400 ms' &&
  formatAxisTime(-20 * MS, 1, 0) === '-20 ms' &&
  formatAxisTime(2.4 * MS, 1, 1, true) === '+2.4 ms',
  `${formatAxisTime(1.4 * MS, 1, 3)} | ${formatAxisTime(-20 * MS, 1, 0)} | ${formatAxisTime(2.4 * MS, 1, 1, true)}`);
check('an absolute zero (or negative zero) is unsigned; a zero offset reads "+0"',
  formatAxisTime(0, 1, 1) === '0.0 ms' && formatAxisTime(-0.00001, 1, 1) === '0.0 ms' &&
  formatAxisTime(0, 1, 0, true) === '+0 ms');
check('a standalone time uses its own unit and the resolution\'s decimals',
  formatStandaloneTime(4.97 * S, 10 * MS) === '4.97 s' &&
  formatStandaloneTime(4.9724 * S, 100 * US) === '4.9724 s' &&
  formatStandaloneTime(-449.48 * MS, 10 * US) === '-449.48 ms' &&
  formatStandaloneTime(0, US) === '0 µs',
  `${formatStandaloneTime(4.9724 * S, 100 * US)} ${formatStandaloneTime(-449.48 * MS, 10 * US)}`);
check('step decimals: decades, 2.5 ns, the 833.3 ps sample period, and too-fine steps',
  stepDecimals(100 * US, 2) === 0 && stepDecimals(100 * US, 1) === 1 &&
  stepDecimals(2500, 3) === 1 && stepDecimals(1e12 / 1.2e9, 3) === 3 &&
  stepDecimals(1e12 / 1.2e9, 4) === 0 && stepDecimals(100 * US, 0) === Infinity,
  `${stepDecimals(100 * US, 2)} ${stepDecimals(100 * US, 1)} ${stepDecimals(2500, 3)} ` +
  `${stepDecimals(1e12 / 1.2e9, 3)} ${stepDecimals(100 * US, 0)}`);
check('the unit is promoted when the integer part would exceed three digits',
  (() => {
    const a = chooseUnit(100 * US, 900 * US); // 900 µs
    const b = chooseUnit(100 * US, 1400 * US); // 1400 µs -> 1.4 ms
    const c = chooseUnit(100 * US, 4.9724 * S); // 4972.4 ms: still too long
    return a.unitIndex === 2 && a.decimals === 0 && a.fits &&
      b.unitIndex === 1 && b.decimals === 1 && b.fits &&
      c.unitIndex === 1 && !c.fits;
  })());

// --- plans for representative label sets ----------------------------------------------

{
  const steps = (from: number, step: number, n: number): number[] =>
    Array.from({ length: n }, (_, i) => from + i * step);
  const show = (times: number[], step: number): string[] => {
    const plan = planAxisLabels(times, step);
    return [plan.baseLabel ?? '', ...times.map((t) => axisLabel(t, plan))];
  };
  const cases: { name: string; times: number[]; step: number; want: string[] }[] = [
    { name: '1 ms decade from 0', times: steps(0, MS, 4), step: MS, want: ['', '0 ms', '1 ms', '2 ms', '3 ms'] },
    { name: '100 µs steps across 1 ms read as decimal milliseconds',
      times: steps(1.2 * MS, 100 * US, 4), step: 100 * US,
      want: ['', '1.2 ms', '1.3 ms', '1.4 ms', '1.5 ms'] },
    { name: '100 µs steps below 1 ms stay in µs', times: steps(500 * US, 100 * US, 4), step: 100 * US,
      want: ['', '500 µs', '600 µs', '700 µs', '800 µs'] },
    { name: 'a pre-trigger view keeps its sign', times: steps(-100 * MS, 50 * MS, 4), step: 50 * MS,
      want: ['', '-100 ms', '-50 ms', '0 ms', '50 ms'] },
    { name: 'fine steps at 4.9724 s need a single base', times: steps(4.9724 * S, 400 * US, 4), step: 400 * US,
      want: ['4.97 s', '+2.4 ms', '+2.8 ms', '+3.2 ms', '+3.6 ms'] },
    { name: 'the same far from T before the trigger: base and offsets both negative',
      times: steps(-4.9736 * S, 400 * US, 4), step: 400 * US,
      want: ['-4.97 s', '-3.6 ms', '-3.2 ms', '-2.8 ms', '-2.4 ms'] },
    { name: 'tens of seconds at a 1 s step', times: steps(10 * S, S, 3), step: S, want: ['', '10 s', '11 s', '12 s'] },
    { name: 'a coarse step at 4.97 s needs no base', times: steps(4.9 * S, 20 * MS, 3), step: 20 * MS,
      want: ['', '4.90 s', '4.92 s', '4.94 s'] },
    { name: '2.5 ns sample period', times: steps(0, 2500, 4), step: 2500,
      want: ['', '0.0 ns', '2.5 ns', '5.0 ns', '7.5 ns'] },
    { name: '833.3 ps sample period, written in ns once ps would need four digits',
      times: steps(0, 1e12 / 1.2e9, 11), step: 1e12 / 1.2e9,
      want: ['', '0.000 ns', '0.833 ns', '1.667 ns', '2.500 ns', '3.333 ns', '4.167 ns',
        '5.000 ns', '5.833 ns', '6.667 ns', '7.500 ns', '8.333 ns'] },
    { name: '10 ns ticks', times: steps(0, 10 * NS, 3), step: 10 * NS, want: ['', '0 ns', '10 ns', '20 ns'] },
  ];
  for (const c of cases) {
    const got = show(c.times, c.step);
    check(`plan: ${c.name}`, JSON.stringify(got) === JSON.stringify(c.want), got.join(' | '));
  }
}

// --- layout over whole views ----------------------------------------------------------

/** Every labelled tick, in its row, starts after the previous one's end plus the gap. */
function noOverlap(set: TickSet, width: number): string {
  const rows: number[] = [
    set.pinned ? 6 + metrics.measure(set.pinned.label) + LABEL_GAP : -Infinity, -Infinity,
  ];
  for (const t of set.ticks) {
    if (t.label === '') continue;
    const row = t.major ? 0 : 1;
    const left = Math.round(t.x) + 1;
    const right = left + metrics.measure(t.label);
    if (left < rows[row]!) return `"${t.label}" at ${left} overlaps (row ${row} ends ${rows[row]})`;
    if (right > width) return `"${t.label}" runs past ${width}`;
    rows[row] = right + LABEL_GAP;
  }
  return '';
}

/** One unit and one decimal count across every label (offsets included). */
function consistent(set: TickSet): string {
  const shapes = new Set(labelled(set).map((l) => {
    const m = /^[+-]?\d+(?:\.(\d+))? (\S+)$/.exec(l);
    return m ? `${m[1]?.length ?? 0}:${m[2]}` : `bad:${l}`;
  }));
  return shapes.size <= 1 ? '' : [...shapes].join(',');
}

{
  const views: { name: string; start: number; end: number; width?: number; rate?: number }[] = [
    { name: '20 ns at 1 GS/s', start: 0, end: 20 * NS, rate: 1e9 },
    { name: '1 µs', start: 0, end: US },
    { name: '37 µs, odd start', start: 13.7 * US, end: 50.7 * US },
    { name: '4 ms', start: 0, end: 4 * MS },
    { name: '1 ms to 5 ms', start: MS, end: 5 * MS },
    { name: '-100 ms .. 900 ms around T', start: -100 * MS, end: 900 * MS },
    { name: 'all before T', start: -40 * MS, end: -1 * MS },
    { name: '4 ms at 4.9724 s (absolute: 4.973 s fits)', start: 4.9724 * S, end: 4.9764 * S },
    { name: '1 ms at 4.9724 s (base)', start: 4.9724 * S, end: 4.9734 * S },
    { name: '1 ms at -4.9724 s (base)', start: -4.9734 * S, end: -4.9724 * S },
    { name: '449 ms + 40 µs', start: 449.48 * MS, end: 449.52 * MS },
    { name: '30 s', start: 0, end: 30 * S },
    { name: '30 s narrow plot', start: 0, end: 30 * S, width: 300 },
    { name: 'narrow 4 ms plot', start: 0, end: 4 * MS, width: 240 },
    { name: '10 samples at 400 MS/s', start: 0, end: 25 * NS, rate: 400e6 },
    { name: '10 samples at 1.2 GS/s', start: 0, end: 10 * 1e12 / 1.2e9, rate: 1.2e9 },
  ];
  for (const v of views) {
    const width = v.width ?? 1000;
    const set = labelsOf(v.start, v.end, width, v.rate);
    const overlap = noOverlap(set, width);
    const shape = consistent(set);
    const shown = labelled(set);
    const tooLong = shown.filter((l) => /\d{4}/.test(l.split('.')[0]!));
    check(`layout: ${v.name}`,
      shown.length >= 2 && overlap === '' && shape === '' && tooLong.length === 0 &&
      shown.every((l) => !l.includes('us') && !l.includes(' : ')),
      `${set.pinned ? `[${set.pinned.label}] ` : ''}${shown.join(' ')}${overlap ? ` ! ${overlap}` : ''}` +
      `${shape ? ` ! mixed ${shape}` : ''}${tooLong.length ? ` ! long ${tooLong.join(',')}` : ''}`);
  }
}

{
  // Exhaustive sweep: 10 ns .. 50 s spans, five origins each, three plot widths. Every
  // label must parse back (with the base) to its tick's time within half a resolution
  // step, and the layout invariants above must hold everywhere.
  const UNIT_PS: Record<string, number> = { s: S, ms: MS, 'µs': US, ns: NS, ps: 1 };
  const parse = (label: string): { ps: number; res: number } | null => {
    const m = /^([+-]?)(\d+)(?:\.(\d+))? (\S+)$/.exec(label);
    const unit = m ? UNIT_PS[m[4]!] : undefined;
    if (!m || unit === undefined) return null;
    const value = Number(`${m[2]}.${m[3] ?? '0'}`) * (m[1] === '-' ? -1 : 1);
    return { ps: value * unit, res: unit * 10 ** -(m[3]?.length ?? 0) };
  };
  let cases = 0;
  const failures: string[] = [];
  for (let e = 4; e <= 13.7; e += 0.1) {
    const span = 10 ** e;
    for (const origin of [0, -span, -span / 2, 4.9724 * S, -4.9724 * S, 0.4494 * S]) {
      for (const width of [320, 1000, 2400]) {
        cases++;
        const set = labelsOf(origin, origin + span, width);
        const where = `span=${span.toExponential(2)} origin=${origin} w=${width}`;
        const overlap = noOverlap(set, width);
        const shape = consistent(set);
        if (overlap) { failures.push(`${where}: ${overlap}`); continue; }
        if (shape) { failures.push(`${where}: mixed ${shape}`); continue; }
        const base = set.pinned ? parse(set.pinned.label) : null;
        if (set.pinned && !base) { failures.push(`${where}: bad base ${set.pinned.label}`); continue; }
        // A narrow plot may hold no labellable tick; the left edge is labelled instead.
        if (labelled(set).length === 0 && !set.pinned) { failures.push(`${where}: no labels`); continue; }
        for (const t of set.ticks) {
          if (t.label === '') continue;
          const p = parse(t.label);
          const back = p ? p.ps + (base?.ps ?? 0) : NaN;
          const tolerance = (p?.res ?? 0) / 2 + (base ? base.res / 2 : 0) + 1e-3;
          const intPart = t.label.replace(/^[+-]/, '').split(/[. ]/)[0]!;
          if (!p || !(Math.abs(back - t.ps) <= tolerance) || intPart.length > 3 ||
              t.label.includes('us') || (set.pinned && !/^[+-]/.test(t.label))) {
            failures.push(`${where}: "${t.label}" for ${t.ps} ps (base ${set.pinned?.label ?? '-'})`);
            break;
          }
        }
      }
    }
  }
  check(`sweep: ${cases} views parse back, never overlap, keep one unit/decimals, <= 3 integer digits`,
    failures.length === 0, failures.slice(0, 5).join('; '));
}

{
  // The observed defect: a view starting at -100 ms must not label itself "-1 s".
  const set = labelsOf(-100 * MS, 900 * MS);
  const zero = set.ticks.find((t) => t.ps === 0);
  check('a -100 ms start reads -100 ms, with no base and an exact "0 ms" at T',
    set.pinned === null && labelled(set)[0] === '-100 ms' && zero?.label === '0 ms' && zero.major,
    labelled(set).join(' '));
}

{
  // Two base labels side by side was the other observed defect: there is at most one, and
  // only when absolute labels would need four or more integer digits.
  const far = labelsOf(4.9724 * S, 4.9734 * S);
  const near = labelsOf(1.2 * MS, 5.2 * MS);
  check('at most one base, only for far-from-origin fine steps',
    far.pinned?.label === '4.972 s' && labelled(far)[0] === '+0.4 ms' && labelled(far).every((l) => l.startsWith('+')) &&
    near.pinned === null,
    `far=[${far.pinned?.label}] ${labelled(far).join(' ')}; near=${labelled(near).join(' ')}`);
}

{
  // Measured widths matter: a wide font drops labels instead of overprinting them, and
  // majors keep priority over minors.
  const wide: TickLabelMetrics = { measure: (text) => text.length * 20, offset: 1 };
  const set = computeTicks(0, MS, 1000, undefined, 45, wide);
  const shown = set.ticks.filter((t) => t.label !== '');
  const minorsShown = shown.filter((t) => !t.major).length;
  let ok = true;
  let last = -Infinity;
  for (const t of shown.filter((x) => !x.major)) {
    const left = Math.round(t.x) + 1;
    if (left < last) ok = false;
    last = left + wide.measure(t.label) + LABEL_GAP;
  }
  check('a wider measured font thins the labels rather than overlapping them',
    ok && minorsShown < labelsOf(0, MS).ticks.filter((t) => t.label !== '' && !t.major).length &&
    shown.some((t) => t.major),
    shown.map((t) => t.label).join(' '));
}

{
  // Ticks themselves are unchanged by labelling: positions and majors are as before.
  const set = labelsOf(-20 * MS, 20 * MS);
  const zero = set.ticks.find((t) => t.ps === 0);
  check('trigger-relative ticks keep negative labels and the zero tick at the centre',
    set.ticks.some((t) => t.ps < 0 && t.label.startsWith('-')) &&
    zero?.major === true && zero.label === '0 ms' && Math.abs(zero.x - 500) < 1e-9,
    `${zero?.label}@${zero?.x}`);
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `\n        ${r.detail}` : ''}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
