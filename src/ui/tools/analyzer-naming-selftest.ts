import {
  analyzerLabelFrom, defaultAnalyzerLabel, MAX_ANALYZER_LABEL_LENGTH, nextAnalyzerOrdinal,
  restoredAnalyzerOrdinal, sanitizeAnalyzerLabel, type AnalyzerOrdinal,
} from '../analyzerNaming.js';

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

const entries = (decoderId: string, ordinals: readonly number[]): AnalyzerOrdinal[] =>
  ordinals.map((ordinal) => ({ decoderId, ordinal }));

const twoI2c = entries('i2c', [1, 2]);

{
  const table: { analyzers: readonly AnalyzerOrdinal[]; decoderId: string; want: number }[] = [
    { analyzers: [], decoderId: 'i2c', want: 1 },
    { analyzers: twoI2c, decoderId: 'i2c', want: 3 },
    { analyzers: entries('i2c', [1, 3]), decoderId: 'i2c', want: 2 },
    { analyzers: entries('i2c', [1, 5]), decoderId: 'i2c', want: 2 },
    { analyzers: entries('i2c', [2, 3]), decoderId: 'i2c', want: 1 },
    {
      analyzers: [...entries('spi', [1, 2, 3]), ...entries('i2c', [1])],
      decoderId: 'i2c',
      want: 2,
    },
    { analyzers: entries('i2c', [1, 1, 2]), decoderId: 'i2c', want: 3 },
    { analyzers: entries('i2c', [2, 2, 3]), decoderId: 'i2c', want: 1 },
  ];
  const wrong = table.filter((row) => nextAnalyzerOrdinal(row.analyzers, row.decoderId) !== row.want);
  const controls = [
    nextAnalyzerOrdinal(twoI2c, 'i2c') !== 2,
    nextAnalyzerOrdinal(entries('spi', [1, 2, 3]), 'i2c') === 1,
    nextAnalyzerOrdinal(entries('i2c', [1, 3]), 'i2c') !== 4,
    nextAnalyzerOrdinal(entries('i2c', [2, 2]), 'i2c') !== 4,
  ];
  check('nextAnalyzerOrdinal returns the smallest free positive ordinal for its decoder id',
    wrong.length === 0 && controls.every((pass) => pass),
    `wrong=${JSON.stringify(wrong.map((row) => nextAnalyzerOrdinal(row.analyzers, row.decoderId)))}, ` +
    `controls=${JSON.stringify(controls)}`);
}

{
  const built = defaultAnalyzerLabel('I²C', 2);
  const first = defaultAnalyzerLabel('SPI', 1);
  const controls = [built !== 'I²C', first !== 'SPI', defaultAnalyzerLabel('I²C', 3) !== built];
  check('defaultAnalyzerLabel appends the ordinal to the decoder display name',
    built === 'I²C-2' && first === 'SPI-1' && controls.every((pass) => pass),
    `built=${built}, first=${first}, controls=${JSON.stringify(controls)}`);
}

{
  const trimmed = sanitizeAnalyzerLabel('  My IC  ', 'I²C-1');
  const capped = sanitizeAnalyzerLabel('L'.repeat(80), 'I²C-1');
  const blanks = [
    sanitizeAnalyzerLabel('   ', 'I²C-1'),
    sanitizeAnalyzerLabel('', 'I²C-1'),
    sanitizeAnalyzerLabel(undefined, 'I²C-1'),
    sanitizeAnalyzerLabel(null, 'I²C-1'),
    sanitizeAnalyzerLabel(42, 'I²C-1'),
    sanitizeAnalyzerLabel({ name: 'x' }, 'I²C-1'),
  ];
  const controls = [
    trimmed !== '  My IC  ',
    capped.length !== 80,
    blanks.every((text) => text !== ''),
    sanitizeAnalyzerLabel(' My IC ', 'I²C-1') !== 'My IC ',
  ];
  check('sanitizeAnalyzerLabel trims, caps at the label limit and falls back when blank',
    trimmed === 'My IC' && capped.length === MAX_ANALYZER_LABEL_LENGTH &&
    capped === 'L'.repeat(MAX_ANALYZER_LABEL_LENGTH) && blanks.every((text) => text === 'I²C-1') &&
    controls.every((pass) => pass),
    `trimmed=${trimmed}, capped=${capped.length}, blanks=${JSON.stringify(blanks)}, ` +
    `controls=${JSON.stringify(controls)}`);
}

{
  const custom = analyzerLabelFrom('  MyI2C  ', 'I²C', 2);
  const blank = analyzerLabelFrom('', 'I²C', 2);
  const spaces = analyzerLabelFrom('   ', 'I²C', 3);
  const controls = [
    blank !== 'I²C',
    spaces !== 'I²C',
    custom !== 'I²C-2',
    analyzerLabelFrom('MyI2C', 'I²C', 2) !== 'I²C-2',
  ];
  check('analyzerLabelFrom prefers a custom name and falls back to the ordinal default',
    custom === 'MyI2C' && blank === 'I²C-2' && spaces === 'I²C-3' &&
    controls.every((pass) => pass),
    `custom=${custom}, blank=${blank}, spaces=${spaces}, controls=${JSON.stringify(controls)}`);
}

{
  const table: {
    raw: unknown; label: string; used: readonly number[]; want: number;
  }[] = [
    { raw: 4, label: 'Custom', used: [], want: 4 },
    { raw: 2, label: 'I²C-2', used: [], want: 2 },
    { raw: 2, label: 'I²C-2', used: [2], want: 1 },
    { raw: 2, label: 'I²C-3', used: [2], want: 3 },
    { raw: undefined, label: 'I²C-4', used: [], want: 4 },
    { raw: undefined, label: 'I²C-4', used: [4], want: 1 },
    { raw: undefined, label: 'I²C-4', used: [1, 4], want: 2 },
    { raw: undefined, label: 'MyI2C', used: [], want: 1 },
    { raw: undefined, label: 'MyI2C', used: [1, 2], want: 3 },
    { raw: undefined, label: 'i2c', used: [], want: 1 },
    { raw: 0, label: 'MyI2C', used: [], want: 1 },
    { raw: -2, label: 'MyI2C', used: [], want: 1 },
    { raw: 1.5, label: 'MyI2C', used: [], want: 1 },
    { raw: '2', label: 'MyI2C', used: [], want: 1 },
    { raw: null, label: 'MyI2C', used: [], want: 1 },
    { raw: undefined, label: 'MyI2C', used: [], want: 1 },
    { raw: Number.NaN, label: 'MyI2C', used: [], want: 1 },
    { raw: 0, label: 'I²C-5', used: [], want: 5 },
    { raw: '3' as unknown, label: 'I²C-6', used: [], want: 6 },
    { raw: undefined, label: 'I²C-0', used: [], want: 1 },
    { raw: undefined, label: 'I²C-12345', used: [], want: 1 },
  ];
  const wrong = table.filter((row) =>
    restoredAnalyzerOrdinal(row.raw, row.label, new Set(row.used)) !== row.want);
  const controls = [
    restoredAnalyzerOrdinal(4, 'Custom', new Set()) !== 1,
    restoredAnalyzerOrdinal(2, 'Custom', new Set([2])) !== 2,
    restoredAnalyzerOrdinal(undefined, 'I²C-4', new Set()) !== 1,
    restoredAnalyzerOrdinal(undefined, 'I²C-4', new Set([4])) !== 4,
    restoredAnalyzerOrdinal(0, 'MyI2C', new Set()) !== 0,
    restoredAnalyzerOrdinal('2', 'MyI2C', new Set()) !== 2,
  ];
  check('restoredAnalyzerOrdinal prefers the persisted ordinal, then a label suffix, then the free set',
    wrong.length === 0 && controls.every((pass) => pass),
    `wrong=${JSON.stringify(wrong.map((row) =>
      restoredAnalyzerOrdinal(row.raw, row.label, new Set(row.used))))}, ` +
    `controls=${JSON.stringify(controls)}`);
}

{
  const attached: AnalyzerOrdinal[] = [];
  const attach = (name: string): string => {
    const ordinal = nextAnalyzerOrdinal(attached, 'i2c');
    attached.push({ decoderId: 'i2c', ordinal });
    return analyzerLabelFrom(name, 'I²C', ordinal);
  };
  const first = attach('MyI2C');
  const second = attach('');
  const third = attach('');
  const labelDerivedNext = ((): number => {
    const used = [first].map((label) => /^.*-(\d+)$/.exec(label)?.[1]).map(Number);
    let ordinal = 1;
    while (used.includes(ordinal)) ordinal++;
    return ordinal;
  })();
  const controls = [
    labelDerivedNext === 1,
    analyzerLabelFrom('', 'I²C', labelDerivedNext) !== second,
    attached.length === 3 && attached[2]?.ordinal === 3,
  ];
  check('a custom name keeps its ordinal, so the next attach of that decoder is still -2',
    first === 'MyI2C' && second === 'I²C-2' && third === 'I²C-3' &&
    controls.every((pass) => pass),
    `first=${first}, second=${second}, third=${third}, controls=${JSON.stringify(controls)}`);
}

{
  const source = fs.readFileSync('src/ui/analyzerNaming.ts', 'utf8');
  const forbidden = ['import ', 'document', 'window', '../decode', 'localStorage', '//', '/*'];
  const hits = forbidden.filter((token) => source.includes(token));
  check('the naming module stays pure: no imports, no decode barrel, no DOM, no storage',
    hits.length === 0 && source.includes('export function nextAnalyzerOrdinal(') &&
    source.includes('export const MAX_ANALYZER_LABEL_LENGTH = 64;'),
    `hits=${JSON.stringify(hits)}`);
}

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = app.indexOf('private async attachAnalyzer(');
  const body = start >= 0 ? app.slice(start, start + 1600) : '';
  const needles = [
    'name: string,',
    'const ordinal = nextAnalyzerOrdinal(this.analyzers, decoderId);',
    "label: analyzerLabelFrom(name, info.name, ordinal),",
    'ordinal,',
  ];
  const missing = needles.filter((needle) => !body.includes(needle));
  const order = ['this.analyzers.push(a);', 'this.persistWorkspace();', 'this.renderPanels();',
    'await this.runDecode(a.id);'];
  const orderIndex = order.map((needle) => body.indexOf(needle));
  const orderOk = orderIndex.every((index, i) => index >= 0 && (i === 0 || index > orderIndex[i - 1]));
  check('attachAnalyzer assigns the per-decoder ordinal and keeps the pinned mutation order',
    missing.length === 0 && orderOk && !body.includes('label: info.name,') &&
    !body.includes("analyzerLabelFrom('',"),
    `missing=${JSON.stringify(missing)}, order=${JSON.stringify(orderIndex)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failures = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failures}/${results.length} passed`);
nodeProcess.exit(failures ? 1 : 0);
