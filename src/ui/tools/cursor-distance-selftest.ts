import {
  MAX_CURSOR_DISTANCE_ROWS, addDistanceRow, assignDistanceCursor, clearDistancePairs,
  cursorDistance, distanceCell, pruneDistancePairs, removeDistanceRow, seedDistanceRow,
  type CursorDistanceRow,
} from '../cursorDistance.js';
import { formatCursorSpan } from '../cursorTime.js';

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

function makeRows(
  specs: readonly (readonly [number, number | null, number | null])[],
): CursorDistanceRow[] {
  return specs.map(([id, a, b]) => ({ id, a, b }));
}

const ids = (rows: readonly CursorDistanceRow[]): string =>
  rows.map((row) => String(row.id)).join(',');

const sides = (rows: readonly CursorDistanceRow[]): string => rows.map((row) =>
  `${row.id}:${row.a === null ? '-' : row.a}:${row.b === null ? '-' : row.b}`).join(',');

const json = (value: unknown): string => JSON.stringify(value);

check('the row cap is the DSView Max_Measure_Limits literal',
  MAX_CURSOR_DISTANCE_ROWS === 15,
  `MAX_CURSOR_DISTANCE_ROWS=${MAX_CURSOR_DISTANCE_ROWS}`);

{
  const empty: CursorDistanceRow[] = [];
  const added = addDistanceRow(empty, 7);
  check('an added row carries the caller id and two unset sides on a fresh array',
    added !== empty && added.length === 1 && added[0].id === 7 &&
    added[0].a === null && added[0].b === null && empty.length === 0,
    `added=${sides(added)}, inputLength=${empty.length}`);

  const filled = addDistanceRow(empty, 8, [3, 5]);
  check('a row added with a default pair is filled with it, start first',
    filled.length === 1 && filled[0].id === 8 && filled[0].a === 3 && filled[0].b === 5,
    `filled=${sides(filled)}`);

  const base = makeRows([[1, 2, 3], [4, 5, 6]]);
  const full = addDistanceRow(base, 2);
  check('adding keeps the existing rows by reference and appends last',
    full.length === 3 && full[0] === base[0] && full[1] === base[1] &&
    full[0].id === 1 && full[0].a === 2 && full[2].id === 2 &&
    full[2].a === null && full[2].b === null && base.length === 2,
    `rows=${sides(full)}, same0=${full[0] === base[0]}, same1=${full[1] === base[1]}, ` +
    `inputLength=${base.length}`);

  const duplicate = makeRows([[1, 2, 3]]);
  const refused = addDistanceRow(duplicate, 1);
  check('a duplicate row id is refused and returns the same array',
    refused === duplicate && duplicate.length === 1,
    `same=${refused === duplicate}, length=${refused.length}`);
}

{
  const fourteen = makeRows(Array.from(
    { length: 14 }, (_, index) => [index + 1, null, null] as const));
  const fifteen = addDistanceRow(fourteen, 15);
  const sixteen = addDistanceRow(fifteen, 16);
  check('the fifteenth row is accepted and the sixteenth is refused by reference',
    fifteen.length === 15 && fifteen[14].id === 15 &&
    sixteen === fifteen && sixteen.length === 15 && fourteen.length === 14,
    `fifteen=${fifteen.length}, sixteen=${sixteen.length}, same=${sixteen === fifteen}`);

  const atCap = makeRows(Array.from(
    { length: MAX_CURSOR_DISTANCE_ROWS }, (_, index) => [index + 1, null, null] as const));
  const refusedAtCap = addDistanceRow(atCap, 99);
  check('a list already at the cap is returned unchanged even for a new id',
    refusedAtCap === atCap && refusedAtCap.length === MAX_CURSOR_DISTANCE_ROWS,
    `length=${refusedAtCap.length}, same=${refusedAtCap === atCap}`);
}

{
  const three = makeRows([[1, 2, 3], [4, 5, 6], [7, null, null]]);
  const withoutMiddle = removeDistanceRow(three, 4);
  check('removing drops exactly its target, keeps order, and leaves the input intact',
    ids(withoutMiddle) === '1,7' && sides(withoutMiddle) === '1:2:3,7:-:-' &&
    withoutMiddle[0] === three[0] && withoutMiddle[1] === three[2] &&
    withoutMiddle.length === 2 &&
    ids(three) === '1,4,7' && three[1].a === 5,
    `next=${sides(withoutMiddle)}, input=${sides(three)}, ` +
    `same0=${withoutMiddle[0] === three[0]}, same2=${withoutMiddle[1] === three[2]}`);

  const unknown = removeDistanceRow(three, 99);
  check('removing an unknown row id returns the same array',
    unknown === three && unknown.length === 3,
    `same=${unknown === three}, length=${unknown.length}`);

  const cleared = removeDistanceRow(three, 7);
  check('removing a row with unset sides still removes it',
    ids(cleared) === '1,4', `rows=${sides(cleared)}`);
}

{
  const base = makeRows([[10, null, null], [20, null, null]]);
  const aFirst = assignDistanceCursor(base, 10, 'a', 7);
  const bFirst = assignDistanceCursor(base, 10, 'b', 9);
  const both = assignDistanceCursor(aFirst, 10, 'b', 9);
  check('either side is assignable in any order and the input row is untouched',
    sides(aFirst) === '10:7:-,20:-:-' && sides(bFirst) === '10:-:9,20:-:-' &&
    sides(both) === '10:7:9,20:-:-' && base[0].a === null && base[0].b === null,
    `aFirst=${sides(aFirst)}, bFirst=${sides(bFirst)}, both=${sides(both)}`);

  check('assigning to a row keeps the sibling row object by reference',
    both[1] === base[1] && both[0] !== base[0],
    `siblingSame=${both[1] === base[1]}, targetSame=${both[0] === base[0]}`);

  const sameValue = assignDistanceCursor(both, 10, 'a', 7);
  check('assigning the cursor a side already holds returns the same array',
    sameValue === both, `same=${sameValue === both}`);

  const unknownRow = assignDistanceCursor(both, 999, 'a', 3);
  check('assigning to an unknown row id returns the same array',
    unknownRow === both, `same=${unknownRow === both}`);

  const sameCursor = assignDistanceCursor(both, 10, 'a', 9);
  check('the same cursor id may fill both sides',
    sides(sameCursor) === '10:9:9,20:-:-', `rows=${sides(sameCursor)}`);

  const clearedSide = assignDistanceCursor(both, 10, 'b', null);
  check('assigning null clears one side and keeps the other',
    sides(clearedSide) === '10:7:-,20:-:-', `rows=${sides(clearedSide)}`);

  const zeroSide = assignDistanceCursor(base, 20, 'a', 0);
  check('cursor id 0 is a real assignment, not an unset side',
    zeroSide[1].a === 0 && zeroSide[1].b === null, `rows=${sides(zeroSide)}`);

  const clearedBoth =
    assignDistanceCursor(assignDistanceCursor(both, 10, 'a', null), 10, 'b', null);
  const again = assignDistanceCursor(clearedBoth, 10, 'a', null);
  check('clearing an already empty side returns the same array',
    again === clearedBoth && sides(clearedBoth) === '10:-:-,20:-:-',
    `same=${again === clearedBoth}`);
}

{
  const seeded = seedDistanceRow([], 42, [5, 7, 9]);
  check('seeding on an empty list pairs the first two cursors under the caller id',
    seeded !== null && seeded.length === 1 && seeded[0].id === 42 &&
    seeded[0].a === 5 && seeded[0].b === 7,
    `rows=${seeded === null ? 'null' : sides(seeded)}`);

  const zeroId = seedDistanceRow([], 0, [5, 7]);
  check('seeding never invents a row id: a caller id of 0 is kept verbatim',
    zeroId !== null && zeroId[0].id === 0, `row=${zeroId === null ? 'null' : sides(zeroId)}`);

  const oneCursor = seedDistanceRow([], 1, [5]);
  const noCursor = seedDistanceRow([], 1, []);
  const nonEmpty = seedDistanceRow(makeRows([[1, null, null]]), 2, [5, 7]);
  check('seeding refuses one cursor, no cursors, and a non-empty row list',
    oneCursor === null && noCursor === null && nonEmpty === null,
    `one=${String(oneCursor)}, none=${String(noCursor)}, nonEmpty=${String(nonEmpty)}`);

  const exactlyTwo = seedDistanceRow([], 11, [5, 7]);
  const exactlyOne = seedDistanceRow([], 11, [5]);
  check('the seed threshold is exactly two cursors: two seed, one refuses',
    exactlyTwo !== null && exactlyTwo.length === 1 && exactlyTwo[0].id === 11 &&
    exactlyTwo[0].a === 5 && exactlyTwo[0].b === 7 && exactlyOne === null,
    `two=${exactlyTwo === null ? 'null' : sides(exactlyTwo)}, one=${String(exactlyOne)}`);

  const input = makeRows([]);
  const first = seedDistanceRow(input, 3, [1, 2]);
  const second = seedDistanceRow(input, 3, [1, 2]);
  check('seeding leaves its input empty and returns a fresh array per call',
    input.length === 0 && first !== null && second !== null && first !== second &&
    json(first) === json(second),
    `input=${input.length}, fresh=${first !== second}`);
}

{
  const original = makeRows([[1, 5, 6], [2, 9, 7], [3, null, 8], [4, null, null]]);
  const pruned = pruneDistancePairs(original, new Set([5, 7]));
  check('pruning clears exactly the missing sides and keeps every row in place',
    sides(pruned) === '1:5:-,2:-:7,3:-:-,4:-:-' && pruned.length === 4,
    `rows=${sides(pruned)}`);

  check('pruning leaves the input rows untouched',
    sides(original) === '1:5:6,2:9:7,3:-:8,4:-:-',
    `input=${sides(original)}`);

  check('an unaffected row object is reused while a changed row is new',
    pruned[3] === original[3] && pruned[0] !== original[0],
    `untouchedSame=${pruned[3] === original[3]}, changedSame=${pruned[0] === original[0]}`);

  const allPresent = makeRows([[1, 5, 6], [2, 7, null]]);
  const nothingMissing = pruneDistancePairs(allPresent, new Set([5, 6, 7]));
  check('pruning with every id present returns the same array',
    nothingMissing === allPresent, `same=${nothingMissing === allPresent}`);

  const zeroId = pruneDistancePairs(makeRows([[1, 0, 6]]), new Set([0]));
  check('cursor id 0 counts as present instead of an unset side',
    zeroId[0].a === 0, `rows=${sides(zeroId)}`);
}

{
  const original = makeRows([[1, 5, 6], [2, null, null], [3, 7, null]]);
  const cleared = clearDistancePairs(original);
  check('clearing empties every side and keeps every row',
    sides(cleared) === '1:-:-,2:-:-,3:-:-' && cleared.length === 3,
    `rows=${sides(cleared)}`);

  check('clearing leaves the input pairs untouched and reuses already-empty rows',
    sides(original) === '1:5:6,2:-:-,3:7:-' && cleared[1] === original[1] &&
    cleared[0] !== original[0],
    `input=${sides(original)}, emptySame=${cleared[1] === original[1]}`);

  const emptyRows = makeRows([[1, null, null]]);
  const again = clearDistancePairs(emptyRows);
  check('clearing an already empty list returns the same array',
    again === emptyRows, `same=${again === emptyRows}`);
}

{
  const frozen: readonly CursorDistanceRow[] = Object.freeze([
    Object.freeze({ id: 1, a: 2, b: 3 }),
    Object.freeze({ id: 2, a: 4, b: null }),
  ]);
  let survived = true;
  try {
    addDistanceRow(frozen, 3);
    removeDistanceRow(frozen, 1);
    assignDistanceCursor(frozen, 1, 'b', 9);
    pruneDistancePairs(frozen, new Set([2]));
    clearDistancePairs(frozen);
  } catch {
    survived = false;
  }
  check('no reducer writes to a frozen input row or array',
    survived && frozen.length === 2 && frozen[0].a === 2 && frozen[1].b === null,
    `survived=${survived}, rows=${sides(frozen)}`);

  const input = makeRows([[1, 5, 6], [2, 7, null]]);
  const before = json(input);
  const runs = [
    json(addDistanceRow(input, 3)),
    json(removeDistanceRow(input, 2)),
    json(assignDistanceCursor(input, 1, 'a', 9)),
    json(pruneDistancePairs(input, new Set([5]))),
    json(clearDistancePairs(input)),
  ];
  const replays = [
    json(addDistanceRow(input, 3)),
    json(removeDistanceRow(input, 2)),
    json(assignDistanceCursor(input, 1, 'a', 9)),
    json(pruneDistancePairs(input, new Set([5]))),
    json(clearDistancePairs(input)),
  ];
  check('every reducer survives a second call with the same input and result',
    runs.every((run, index) => run === replays[index]) && json(input) === before,
    `runs=${runs.join(' | ')}`);
}

{
  const samples = new Map<number, number>([[1, 250000], [2, 0], [3, 1000000]]);
  const pair: CursorDistanceRow = { id: 1, a: 1, b: 2 };
  const reading = distanceCell(pair, samples, 1e-8);
  // A row reads end minus start (B - A), so 1 -> 2 with 2 to the right is positive, and
  // it carries the 1/|dt| frequency the period would have.
  check('control: a complete pair reads B minus A with its 1/|dt| frequency',
    reading === '-2.500 ms/-250,000 · 400 Hz' &&
    distanceCell({ id: 1, a: 2, b: 1 }, samples, 1e-8) === '+2.500 ms/250,000 · 400 Hz' &&
    distanceCell({ id: 1, a: 2, b: 2 }, samples, 1e-8) === '0 s/0',
    `cell=${JSON.stringify(reading)}`);

  check('an unset side produces an empty cell, never a fabricated zero',
    distanceCell({ id: 1, a: null, b: 2 }, samples, 1e-8) === '' &&
    distanceCell({ id: 1, a: 1, b: null }, samples, 1e-8) === '' &&
    distanceCell({ id: 1, a: null, b: null }, samples, 1e-8) === '',
    `a=${JSON.stringify(distanceCell({ id: 1, a: null, b: 2 }, samples, 1e-8))}, ` +
    `b=${JSON.stringify(distanceCell({ id: 1, a: 1, b: null }, samples, 1e-8))}`);

  check('an id missing from the sample map produces an empty cell',
    distanceCell({ id: 1, a: 1, b: 99 }, samples, 1e-8) === '' &&
    distanceCell({ id: 1, a: 99, b: 2 }, samples, 1e-8) === '',
    `bMissing=${JSON.stringify(distanceCell({ id: 1, a: 1, b: 99 }, samples, 1e-8))}, ` +
    `aMissing=${JSON.stringify(distanceCell({ id: 1, a: 99, b: 2 }, samples, 1e-8))}`);

  const periods = [0, -0, -1e-8, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  check('a zero, negative, or non-finite sample period produces an empty cell',
    periods.every((period) => distanceCell(pair, samples, period) === ''),
    `periods=${periods.map((p) => JSON.stringify(distanceCell(pair, samples, p))).join(',')}`);

  const brokenSamples = new Map<number, number>([[1, Number.NaN], [2, 0]]);
  const infiniteSamples = new Map<number, number>([[1, Number.POSITIVE_INFINITY], [2, 0]]);
  check('a non-finite sample value produces an empty cell instead of NaN text',
    distanceCell(pair, brokenSamples, 1e-8) === '' &&
    distanceCell(pair, infiniteSamples, 1e-8) === '',
    `nan=${JSON.stringify(distanceCell(pair, brokenSamples, 1e-8))}, ` +
    `infinite=${JSON.stringify(distanceCell(pair, infiniteSamples, 1e-8))}`);

  const zeroIdSamples = new Map<number, number>([[0, 250000], [1, 0]]);
  const zeroIdCell = distanceCell({ id: 1, a: 0, b: 1 }, zeroIdSamples, 1e-8);
  check('cursor id 0 resolves through the sample map like any other id',
    zeroIdCell === '-2.500 ms/-250,000 · 400 Hz', `cell=${JSON.stringify(zeroIdCell)}`);

  check('the cell matches the composer it delegates to',
    distanceCell(pair, samples, 1e-8) ===
      `${cursorDistance(0, 250000, 1e-8).cell} · ${cursorDistance(0, 250000, 1e-8).frequency}`,
    `cell=${JSON.stringify(distanceCell(pair, samples, 1e-8))}`);
}

{
  const period = 1e-8;
  const positive = cursorDistance(250000, 0, period);
  check('the composer measures A minus B with an explicit time sign and separators',
    positive.samples === 250000 && positive.seconds === 250000 * period &&
    positive.time === '+2.500 ms' && positive.count === '250,000' &&
    positive.cell === '+2.500 ms/250,000',
    `samples=${positive.samples}, seconds=${positive.seconds}, cell=${positive.cell}`);

  const negative = cursorDistance(0, 250000, period);
  check('swapping the sides flips the sign of every field',
    negative.samples === -250000 && negative.seconds === -250000 * period &&
    negative.time === '-2.500 ms' && negative.count === '-250,000' &&
    negative.cell === '-2.500 ms/-250,000',
    `samples=${negative.samples}, cell=${negative.cell}`);

  check('the composer derives the frequency from |dt| in both directions',
    positive.frequency === '400 Hz' && cursorDistance(0, 250000, period).frequency === '400 Hz' &&
    cursorDistance(1234, 1234, period).frequency === '' &&
    cursorDistance(100, 0, period).frequency === '1.00 MHz',
    `positive=${positive.frequency}`);

  const zero = cursorDistance(1234, 1234, period);
  check('a zero delta reads 0 s/0 with no sign',
    zero.samples === 0 && zero.seconds === 0 && zero.time === '0 s' &&
    zero.count === '0' && zero.cell === '0 s/0',
    `cell=${zero.cell}`);

  const nanSamples = cursorDistance(Number.NaN, 0, period);
  const infiniteSamples = cursorDistance(Number.POSITIVE_INFINITY, 0, period);
  check('a non-finite sample difference yields an empty count and cell, never a bare slash',
    nanSamples.cell === '' && nanSamples.count === '' && nanSamples.time === '-' &&
    Number.isNaN(nanSamples.seconds) &&
    infiniteSamples.cell === '' && infiniteSamples.count === '' &&
    infiniteSamples.time === '-' && Number.isNaN(infiniteSamples.seconds),
    `nan=${json(nanSamples.cell)}/${json(nanSamples.count)}/${json(nanSamples.time)}, ` +
    `nanSeconds=${String(nanSamples.seconds)}, ` +
    `infinite=${json(infiniteSamples.cell)}/${json(infiniteSamples.time)}`);

  const negativeZero = cursorDistance(-0, 0, period);
  check('a negative zero delta also reads 0 s/0',
    negativeZero.count === '0' && negativeZero.time === '0 s' &&
    negativeZero.cell === '0 s/0',
    `cell=${negativeZero.cell}`);

  const big = cursorDistance(2500000, 0, period);
  const bigBack = cursorDistance(0, 2500000, period);
  check('sample counts keep thousands separators in both directions and inside the cell',
    big.count === '2,500,000' && bigBack.count === '-2,500,000' &&
    big.cell === '+25.00 ms/2,500,000' && bigBack.cell === '-25.00 ms/-2,500,000',
    `positive=${big.cell}, negative=${bigBack.cell}`);

  check('one sign rule: the count takes a minus but never a plus and the cell is time/count',
    !positive.count.includes('+') && !big.count.includes('+') &&
    positive.count === '250,000' && negative.count === '-250,000' && zero.count === '0' &&
    positive.cell === `${positive.time}/${positive.count}` &&
    negative.cell === `${negative.time}/${negative.count}` &&
    zero.cell === `${zero.time}/${zero.count}`,
    `count=${positive.count}, cell=${positive.cell}, back=${negative.cell}`);

  const periodCap = cursorDistance(1, 0, 1e-8);
  check('the period cap outranks the width convention at the period scale',
    periodCap.time === '+10 ns', `time=${periodCap.time}`);

  const ladder: readonly (readonly [number, string])[] = [
    [1, '+10 ns'],
    [250, '+2.50 µs'],
    [250000, '+2.500 ms'],
    [999999, '+10.000 ms'],
    [100000000, '+1.000 s'],
    [-1, '-10 ns'],
    [-250, '-2.50 µs'],
  ];
  check('the delta time reuses the cursor unit ladder verbatim',
    ladder.every(([samples, text]) => cursorDistance(samples, 0, period).time === text),
    ladder.map(([samples, text]) => {
      const actual = cursorDistance(samples, 0, period).time;
      return `${samples}:${actual === text ? 'ok' : actual}`;
    }).join(','));

  const sweep = [0, 1, 2, 7, 250, 999, 1000, 250000, 999999, 1000000, 123456789,
    -1, -7, -250000, -123456789];
  check('the delta time is byte-identical to formatCursorSpan for every swept sample',
    sweep.every((samples) =>
      cursorDistance(samples, 0, period).time === formatCursorSpan(samples * period, period)),
    `mismatches=${sweep.filter((samples) =>
      cursorDistance(samples, 0, period).time !== formatCursorSpan(samples * period, period))
      .join(',')}`);
}

{
  const source = fs.readFileSync('src/ui/cursorDistance.ts', 'utf8');
  const imports = source.match(/^import .*$/gm) ?? [];
  check('the model composes from the shared time and count formatters',
    imports.length === 2 &&
    source.includes("import { formatCursorSpan } from './cursorTime.js';") &&
    source.includes("import { formatCount, formatFreq } from './format.js';") &&
    !source.includes('UNITS') && !source.includes('toLocaleString'),
    `imports=${imports.length}, ownLadder=${source.includes('UNITS')}, ` +
    `ownSeparator=${source.includes('toLocaleString')}`);

  const forbidden = ['document', 'window', 'addEventListener', 'requestAnimationFrame',
    'SampleStore', 'storeRef', "from './app.js'", "from './state.js'", "from './i18n.js'"];
  const hits = forbidden.filter((token) => source.includes(token));
  check('the model touches no DOM, App, i18n, or store state',
    hits.length === 0, `hits=${json(hits)}`);

  const readonlyReturns = source.split('): readonly CursorDistanceRow[] {').length - 1;
  const seedReturns = source.split('): readonly CursorDistanceRow[] | null {').length - 1;
  check('the reducers hand back a read-only row list with no mutable cast',
    readonlyReturns === 5 && seedReturns === 1 &&
    !source.includes('as CursorDistanceRow'),
    `readonlyReturns=${readonlyReturns}, seedReturns=${seedReturns}, ` +
    `cast=${source.includes('as CursorDistanceRow')}`);

  check('the cap carries the single evidence tag and the module carries no other comment',
    (source.match(/\/\//g) ?? []).length === 1 && (source.match(/\/\*/g) ?? []).length === 0 &&
    source.includes('// [SOURCE] DSView Max_Measure_Limits = 15 (measuredock.h:91).'),
    `lineComments=${(source.match(/\/\//g) ?? []).length}, ` +
    `blockComments=${(source.match(/\/\*/g) ?? []).length}`);

  check('the module declares no any-typed escape hatch',
    !/\bany\b/.test(source) && !source.includes('as any'),
    `any=${/\bany\b/.test(source)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
