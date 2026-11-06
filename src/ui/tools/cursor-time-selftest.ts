import { formatCursorSpan, formatCursorTimes, type CursorTime } from '../cursorTime.js';
import { formatDuration } from '../format.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const SCALES: Readonly<Record<string, number>> = {
  s: 1, ms: 1e-3, 'µs': 1e-6, ns: 1e-9, ps: 1e-12,
};

const at = (sample: number, rate: number): CursorTime => ({ sample, seconds: sample / rate });

const format = (samples: readonly number[], rate: number): string[] =>
  formatCursorTimes(samples.map((sample) => at(sample, rate)), 1 / rate);

const same = (observed: readonly string[], expected: readonly string[]): boolean =>
  observed.length === expected.length && observed.every((text, i) => text === expected[i]);

const secondsOf = (text: string): number => {
  const [value, unit] = text.split(' ');
  return Number(value) * (SCALES[unit ?? ''] ?? Number.NaN);
};

const UNIT_SCALES = [1, 1e-3, 1e-6, 1e-9, 1e-12] as const;

const unitScaleOf = (seconds: number): number =>
  UNIT_SCALES.find((scale) => Math.abs(seconds) >= scale) ?? UNIT_SCALES[UNIT_SCALES.length - 1]!;

const baselineDecimals = (seconds: number): number =>
  Math.max(0, 3 - Math.floor(Math.log10(Math.abs(seconds / unitScaleOf(seconds)))));

const periodCap = (period: number, seconds: number): number =>
  Math.min(9, Math.max(0, Math.ceil(-Math.log10(period / unitScaleOf(seconds)))));

{
  const texts = format([123400, 123401, 123402], 100e6);
  check('three cursors one sample apart print three distinct period-resolved times',
    same(texts, ['1.23400 ms', '1.23401 ms', '1.23402 ms']), `texts=${JSON.stringify(texts)}`);

  const separation = Math.abs(secondsOf(texts[0]!) - secondsOf(texts[1]!));
  const nextSeparation = Math.abs(secondsOf(texts[1]!) - secondsOf(texts[2]!));
  check('the printed separation rounds to exactly one sample period, not invented digits',
    Math.abs(separation - 1e-8) < 1e-13 && Math.abs(nextSeparation - 1e-8) < 1e-13,
    `separation=${separation}, next=${nextSeparation}`);
}

{
  const texts = format([98123400, 98123401], 100e6);
  check('a pair near one second still separates, at the period cap in ms',
    same(texts, ['981.23400 ms', '981.23401 ms']), `texts=${JSON.stringify(texts)}`);
}

{
  const fixture = format([123400, 123401, 123402, 98123400, 98123401, 450000000], 100e6);
  check('the approved six-row fixture renders exact neighbour-aware strings',
    same(fixture, ['1.23400 ms', '1.23401 ms', '1.23402 ms',
      '981.23400 ms', '981.23401 ms', '4.500 s']),
    `texts=${JSON.stringify(fixture)}`);
}

{
  const fixture = format([123400, 123401, 123402, 98123400, 98123401, 450000000], 100e6);
  const baselines = ['1.234 ms', '1.234 ms', '1.234 ms', '981.2 ms', '981.2 ms', '4.500 s'];
  check('a mixed list escalates only the colliding rows and leaves the far row at its baseline',
    fixture.slice(0, 5).every((text, index) => text !== baselines[index]) &&
    fixture[5] === baselines[5],
    `escalated rows=0,1,2,3,4 -> ${fixture.slice(0, 5).join(', ')}; ` +
    `untouched row=5 -> ${fixture[5]} (uniform precision would print 4.50000000 s)`);
}

{
  const period = 1e-8;
  const inputs = [
    1e-12, 1e-10, 1e-9, 1e-8, 5e-8, 1e-7, 5e-7, 1e-6, 5e-6, 1.234e-5, 2.5e-5,
    1e-4, 0.000999999, 1.234e-3, 1e-3, 0.981234, 0.25, 0.5, 1, 1.2, 4.5, -4.5,
    10, 100, 1e3,
  ];
  const withinCap = inputs.filter((seconds) =>
    baselineDecimals(seconds) <= periodCap(period, seconds));
  const capped = inputs.filter((seconds) =>
    baselineDecimals(seconds) > periodCap(period, seconds));
  const mismatches = withinCap
    .map((seconds) => ({ seconds, text: formatCursorTimes([{ sample: 0, seconds }], period)[0]! }))
    .filter(({ seconds, text }) => text !== formatDuration(seconds, 4));
  const cappedTexts = capped.map((seconds) =>
    formatCursorTimes([{ sample: 0, seconds }], period)[0] ?? '');
  check('the baseline is byte-identical to formatDuration wherever the period cap does not bite',
    withinCap.length === 16 && mismatches.length === 0,
    `withinCap=${withinCap.length}, mismatches=${JSON.stringify(mismatches)}`);
  check('the period cap outranks the four-figure width convention at the period scale',
    capped.length === 9 &&
    same(cappedTexts, ['1 ps', '100 ps', '1 ns', '10 ns', '50 ns', '100 ns', '500 ns',
      '1.00 µs', '5.00 µs']),
    `capped=${JSON.stringify(cappedTexts)}`);
}

{
  const alone = format([98123400], 100e6);
  const farApart = format([450000000], 100e6);
  check('an isolated cursor keeps the short four-figure form',
    same(alone, ['981.2 ms']) && same(farApart, ['4.500 s']),
    `alone=${JSON.stringify(alone)}, far=${JSON.stringify(farApart)}`);
}

{
  const zero = format([0], 100e6);
  const around = format([0, 1, 2], 100e6);
  check('a cursor at the origin prints 0 s and its neighbours print one period apart',
    same(zero, ['0 s']) && same(around, ['0 s', '10 ns', '20 ns']),
    `zero=${JSON.stringify(zero)}, around=${JSON.stringify(around)}`);
}

{
  const texts = format([-123400, -123401], 100e6);
  check('pre-trigger cursors keep the sign and separate by one period',
    same(texts, ['-1.23400 ms', '-1.23401 ms']), `texts=${JSON.stringify(texts)}`);
}

{
  const rates = [1e3, 1e4, 1e5, 1e6, 1.2e6, 3.3e6, 1e7, 2.5e7, 5e7, 1e8, 2e8];
  const samples = [0, 1, 2, 3, 7, 49, 99, 1234, 123456, 9999999, 24000000];
  const violations: string[] = [];
  for (const rate of rates) {
    for (const sample of samples) {
      const text = format([sample], rate)[0] ?? '';
      const match = /^(-?\d+)(?:\.(\d+))? (ps|ns|µs|ms|s)$/.exec(text);
      if (match === null) {
        violations.push(`${rate}/${sample}:${text}`);
        continue;
      }
      const decimals = (match[2] ?? '').length;
      const cap = Math.min(9, Math.max(0, Math.ceil(-Math.log10((1 / rate) / SCALES[match[3]!]!))));
      if (decimals > cap) violations.push(`${rate}/${sample}:${text} ${decimals}>${cap}`);
    }
  }
  check('no row prints more decimals than the sample period allows',
    violations.length === 0,
    `rows=${rates.length * samples.length}, violations=${JSON.stringify(violations.slice(0, 4))}`);
}

{
  const cases = [
    { rate: 1.2e6, samples: [1], expected: ['833 ns'] },
    { rate: 1.2e6, samples: [2], expected: ['1.7 µs'] },
    { rate: 1.2e6, samples: [1, 2], expected: ['833 ns', '1.7 µs'] },
    { rate: 3.3e6, samples: [1], expected: ['303 ns'] },
    { rate: 3.3e6, samples: [2], expected: ['606 ns'] },
    { rate: 3.3e6, samples: [4], expected: ['1.2 µs'] },
  ];
  const mismatches = cases
    .map((row) => ({ row, texts: format(row.samples, row.rate) }))
    .filter(({ row, texts }) => !same(texts, row.expected))
    .map(({ row, texts }) =>
      `${row.rate}/${row.samples.join(',')}=${JSON.stringify(texts)} ` +
      `want=${JSON.stringify(row.expected)}`);
  check('a non-decimal sample period caps the decimals at the period, not two digits beyond',
    mismatches.length === 0,
    `cases=${cases.length}, mismatches=${JSON.stringify(mismatches)}`);
}

{
  const texts = format([100000000, 100000001], 100e6);
  const decimals = texts.map((text) => (text.split('.')[1] ?? '').replace(' s', '').length);
  check('an s-scale pair separates at exactly the eight-decimal period cap',
    same(texts, ['1.00000000 s', '1.00000001 s']) && decimals.every((n) => n === 8),
    `texts=${JSON.stringify(texts)}, decimals=${decimals.join(',')}`);
}

{
  const forward = format([123400, 123401, 123402], 100e6);
  const reversed = format([123402, 123401, 123400], 100e6);
  const times = [at(123400, 100e6), at(123401, 100e6)];
  const before = times.map((time) => `${time.sample}:${time.seconds}`).join(',');
  formatCursorTimes(times, 1e-8);
  const after = times.map((time) => `${time.sample}:${time.seconds}`).join(',');
  check('the returned array follows the input order and the input is not mutated',
    same(reversed, forward.slice().reverse()) && before === after && times.length === 2,
    `forward=${JSON.stringify(forward)}, reversed=${JSON.stringify(reversed)}, mutated=${before !== after}`);
}

{
  const rates = [1e3, 1e4, 1e5, 1e6, 1e7, 2.5e7, 5e7, 1e8, 2e8];
  const ceiling = 24_000_000;
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const collisions: string[] = [];
  let cases = 0;
  for (const rate of rates) {
    const period = 1 / rate;
    for (let gap = 1; gap <= 5; gap++) {
      for (let n = 0; n < 1100; n++) {
        const base = next() % (ceiling - gap - 1);
        const rows = [base, base + gap].map((sample) => at(sample, rate));
        const texts = formatCursorTimes(rows, period);
        cases++;
        if (new Set(texts).size !== texts.length && collisions.length < 4) {
          collisions.push(`${rate}/${base}+${gap}:${JSON.stringify(texts)}`);
        }
      }
    }
    for (let gap = 1; gap <= 2; gap++) {
      for (let n = 0; n < 200; n++) {
        const base = next() % (ceiling - 2 * gap - 1);
        const rows = [base, base + gap, base + 2 * gap].map((sample) => at(sample, rate));
        const texts = formatCursorTimes(rows, period);
        cases++;
        if (new Set(texts).size !== texts.length && collisions.length < 4) {
          collisions.push(`${rate}/${base}+${gap}x2:${JSON.stringify(texts)}`);
        }
      }
    }
  }
  check('distinct samples print distinct times across rates and spacings',
    collisions.length === 0,
    `cases=${cases}, collisions=${JSON.stringify(collisions)}`);
}

{
  const shared = format([123400, 123400], 100e6);
  const empty = formatCursorTimes([], 1e-8);
  check('two cursors on the same sample may share a time and are not inflated',
    same(shared, ['1.234 ms', '1.234 ms']) && empty.length === 0,
    `shared=${JSON.stringify(shared)}, empty=${JSON.stringify(empty)}`);
}

{
  const periods = [0, Number.NaN, Number.POSITIVE_INFINITY, -1];
  const texts = periods.flatMap((period) =>
    formatCursorTimes([at(1, 100e6), at(123400, 100e6)], period));
  check('a non-positive or non-finite sample period never leaks NaN into a row',
    texts.length === 8 && texts.every((text) => !text.includes('NaN') && !text.includes('Infinity')),
    `texts=${JSON.stringify(texts)}`);
}

{
  const period = 1e-8;
  const cases = [
    { seconds: 10e-9, expected: '+10 ns' },
    { seconds: 2.5e-6, expected: '+2.50 µs' },
    { seconds: 2.5e-3, expected: '+2.500 ms' },
    { seconds: 1.266e-3, expected: '+1.266 ms' },
    { seconds: 999.99999e-3, expected: '+1000.0 ms' },
  ];
  const mismatches = cases
    .map((row) => ({ row, text: formatCursorSpan(row.seconds, period) }))
    .filter(({ row, text }) => text !== row.expected)
    .map(({ row, text }) =>
      `${row.seconds}=${JSON.stringify(text)} want=${JSON.stringify(row.expected)}`);
  check('a positive span carries an explicit plus and the cursor row ladder',
    mismatches.length === 0,
    `cases=${cases.length}, mismatches=${JSON.stringify(mismatches)}`);
}

{
  const plus = formatCursorSpan(2.5e-3, 1e-8);
  const zero = formatCursorSpan(0, 1e-8);
  const negative = formatCursorSpan(-2.5e-3, 1e-8);
  const negativeSmall = formatCursorSpan(-10e-9, 1e-8);
  const nonFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    .map((seconds) => formatCursorSpan(seconds, 1e-8));
  check('a span signs only a finite non-zero delta and never prefixes zero or a failure',
    plus === '+2.500 ms' && zero === '0 s' && negative === '-2.500 ms' &&
    negativeSmall === '-10 ns' && nonFinite.every((text) => text === '-'),
    `plus=${plus}, zero=${zero}, negative=${negative}, negativeSmall=${negativeSmall}, ` +
    `nonFinite=${JSON.stringify(nonFinite)}`);
}

{
  const nsAt1Msps = formatCursorSpan(1.4e-9, 1e-6);
  const msAt1kSps = formatCursorSpan(1.2345e-3, 1e-3);
  check('a coarse sample period caps the span at the period instead of inventing sub-period digits',
    nsAt1Msps === '+1 ns' && msAt1kSps === '+1 ms',
    `1.4 ns @ 1 MS/s -> ${nsAt1Msps} (uncapped '+1.400 ns'); ` +
    `1.2345 ms @ 1 kS/s -> ${msAt1kSps} (uncapped '+1.234 ms')`);
}

{
  const periods = [0, Number.NaN, Number.POSITIVE_INFINITY, -1];
  const texts = periods.map((period) => formatCursorSpan(2.5e-6, period));
  check('an unusable sample period saturates the decimal cap instead of leaking NaN digits',
    texts.every((text) => text === '+2.500 µs'),
    `texts=${JSON.stringify(texts)}`);
}

{
  const isolated = format([123400, 98123400, 450000000], 100e6);
  const escalated = format([123400, 123401], 100e6);
  const shared = format([123400, 123400], 100e6);
  check('the shared span renderer leaves the cursor rows byte-identical to their previous output',
    same(isolated, ['1.234 ms', '981.2 ms', '4.500 s']) &&
    same(escalated, ['1.23400 ms', '1.23401 ms']) &&
    same(shared, ['1.234 ms', '1.234 ms']),
    `isolated=${JSON.stringify(isolated)}, escalated=${JSON.stringify(escalated)}, ` +
    `shared=${JSON.stringify(shared)}`);
}

{
  const source = fs.readFileSync('src/ui/cursorTime.ts', 'utf8');
  const forbidden = ['import ', 'document', 'window', 'addEventListener', '//', '/*', 'as any',
    'as unknown'];
  const hits = forbidden.filter((token) => source.includes(token));
  check('the formatter is pure, import-free, and carries no comments',
    hits.length === 0 &&
    source.includes('export function formatCursorTimes(') &&
    source.includes('export interface CursorTime {'),
    `hits=${JSON.stringify(hits)}`);
}

{
  const source = fs.readFileSync('src/ui/cursorTime.ts', 'utf8');
  const toFixedSites = source.split('.toFixed(').length - 1;
  const capSites = source.split('decimalsCap(').length - 1;
  check('the span and the cursor rows compose their decimals through one shared ladder',
    toFixedSites === 1 && capSites === 2 &&
    source.includes('export function formatCursorSpan('),
    `toFixedSites=${toFixedSites}, decimalsCapSites=${capSites}, ` +
    `spanExported=${source.includes('export function formatCursorSpan(')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
