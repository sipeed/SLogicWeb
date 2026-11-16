import { defaultCursorPair } from '../cursorSet.js';
import {
  planCursorZoom, type CursorZoomPlan, type CursorZoomRequest,
} from '../cursorZoom.js';

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

type Spec = readonly [number, number | null];

const cursors = (...specs: readonly Spec[]): CursorZoomRequest[] =>
  specs.map(([cursorId, sample]) => ({ cursorId, sample }));

const json = (value: unknown): string => JSON.stringify(value);

const span = (plan: CursorZoomPlan): string =>
  plan.kind === 'zoom'
    ? `${plan.a}:${plan.b}@${plan.start}..${plan.end}`
    : `refuse:${plan.reason}`;

const shape = (plan: CursorZoomPlan): Record<string, unknown> =>
  plan as unknown as Record<string, unknown>;

check('an empty cursor list refuses needs-pair by default and missing for an explicit pair',
  span(planCursorZoom([])) === 'refuse:needs-pair' &&
  span(planCursorZoom([], [1, 2])) === 'refuse:missing',
  `default=${span(planCursorZoom([]))}, explicit=${span(planCursorZoom([], [1, 2]))}`);

{
  const onePlaced = planCursorZoom(cursors([7, 400]));
  const oneUnplaced = planCursorZoom(cursors([7, null]));
  const mixed = planCursorZoom(cursors([7, 400], [8, null]));
  const threeUnplaced = planCursorZoom(cursors([1, null], [2, null], [3, null]));
  check('one placed, one unplaced, one placed plus one unplaced, and three unplaced all refuse needs-pair',
    span(onePlaced) === 'refuse:needs-pair' && span(oneUnplaced) === 'refuse:needs-pair' &&
    span(mixed) === 'refuse:needs-pair' && span(threeUnplaced) === 'refuse:needs-pair',
    `onePlaced=${span(onePlaced)}, oneUnplaced=${span(oneUnplaced)}, ` +
    `mixed=${span(mixed)}, threeUnplaced=${span(threeUnplaced)}`);
}

{
  const forward = planCursorZoom(cursors([1, 100], [2, 900]));
  const reversed = planCursorZoom(cursors([1, 900], [2, 100]));
  check('a pair zooms to min..max with the cursor ids ordered by sample position',
    span(forward) === '1:2@100..900' && span(reversed) === '2:1@100..900' &&
    forward.kind === 'zoom' && reversed.kind === 'zoom' &&
    forward.start === 100 && forward.end === 900 &&
    reversed.start === 100 && reversed.end === 900 &&
    reversed.a === 2 && reversed.b === 1,
    `forward=${span(forward)}, reversed=${span(reversed)}`);

  const equal = planCursorZoom(cursors([1, 500], [2, 500]));
  const equalRounded = planCursorZoom(cursors([1, 10.2], [2, 10.4]));
  const equalFar = planCursorZoom(cursors([3, 299999], [4, 299999]));
  check('equal samples refuse degenerate, including equal-after-rounding and a far coincident pair',
    span(equal) === 'refuse:degenerate' && span(equalRounded) === 'refuse:degenerate' &&
    span(equalFar) === 'refuse:degenerate',
    `equal=${span(equal)}, rounded=${span(equalRounded)}, far=${span(equalFar)}`);

  const adjacent = planCursorZoom(cursors([1, 0], [2, 1]));
  const adjacentHigh = planCursorZoom(cursors([1, 299999], [2, 300000]));
  const oneApartReversed = planCursorZoom(cursors([1, 41], [2, 40]));
  check('adjacent samples are a real span: only equal samples are degenerate',
    span(adjacent) === '1:2@0..1' && span(adjacentHigh) === '1:2@299999..300000' &&
    span(oneApartReversed) === '2:1@40..41',
    `adjacent=${span(adjacent)}, high=${span(adjacentHigh)}, ` +
    `reversed=${span(oneApartReversed)}`);
}

{
  const list = cursors([1, 500], [2, 100], [3, 1000]);
  const forwardPair = planCursorZoom(list, [1, 2]);
  const reversePair = planCursorZoom(list, [2, 1]);
  const reordered = cursors([3, 1000], [2, 100], [1, 500]);
  const reorderedPair = planCursorZoom(reordered, [1, 2]);
  check('an explicit pair resolves its own ids in either tuple order and ignores list order',
    span(forwardPair) === '2:1@100..500' && span(reversePair) === span(forwardPair) &&
    span(reorderedPair) === span(forwardPair) &&
    span(planCursorZoom(list)) === '2:1@100..500',
    `forward=${span(forwardPair)}, reverse=${span(reversePair)}, ` +
    `reordered=${span(reorderedPair)}, default=${span(planCursorZoom(list))}`);

  const outsideDefault = planCursorZoom(list, [2, 3]);
  check('an explicit pair may reach cursors the default pair never considers',
    span(outsideDefault) === '2:3@100..1000',
    `pair=[2,3] -> ${span(outsideDefault)}`);

  const sameTwice = planCursorZoom(list, [2, 2]);
  check('an explicit pair naming one cursor twice refuses degenerate',
    span(sameTwice) === 'refuse:degenerate', `pair=[2,2] -> ${span(sameTwice)}`);
}

{
  const many = cursors([1, 50], [2, 10], [3, 90], [4, 30]);
  const first = planCursorZoom(many);
  const latestTwo = defaultCursorPair([
    { id: 1, sample: 50 }, { id: 2, sample: 10 }, { id: 3, sample: 90 },
  ]);
  check('many cursors default to the first two placed in cursor order',
    span(first) === '2:1@10..50' && first.kind === 'zoom' && first.a === 2 && first.b === 1,
    `plan=${span(first)}`);

  check('control: the default pair is not the latest-two pair a new measurement row gets',
    json(latestTwo) === '[2,3]' && span(first) === '2:1@10..50' &&
    json([first.kind === 'zoom' ? first.a : null, first.kind === 'zoom' ? first.b : null]) !==
      json(latestTwo),
    `latestTwo=${json(latestTwo)}, plan=${span(first)}`);

  const skipped = planCursorZoom(cursors([9, null], [4, 60], [5, 20], [6, 99]));
  check('unplaced cursors are skipped when choosing the default pair, later placed ones never join',
    span(skipped) === '5:4@20..60',
    `plan=${span(skipped)}`);

  const leadingPair = planCursorZoom(cursors([4, 60], [9, null], [5, 20]));
  check('a placed pair before an unplaced cursor still resolves without reaching past it',
    span(leadingPair) === '5:4@20..60', `plan=${span(leadingPair)}`);
}

{
  const list = cursors([1, 100], [2, 200]);
  const unknown = planCursorZoom(list, [1, 99]);
  const bothUnknown = planCursorZoom(list, [98, 99]);
  const unplacedExplicit = planCursorZoom(cursors([1, 100], [2, null]), [1, 2]);
  const unplacedList = cursors([1, Number.NaN], [2, 200]);
  const infiniteList = cursors([1, Number.POSITIVE_INFINITY], [2, 200]);
  const negativeInfiniteList = cursors([1, 100], [2, Number.NEGATIVE_INFINITY]);
  check('a missing or unplaced reference refuses missing instead of falling back to another pair',
    span(unknown) === 'refuse:missing' && span(bothUnknown) === 'refuse:missing' &&
    span(unplacedExplicit) === 'refuse:missing' &&
    span(planCursorZoom(unplacedList, [1, 2])) === 'refuse:missing' &&
    span(planCursorZoom(infiniteList, [1, 2])) === 'refuse:missing' &&
    span(planCursorZoom(negativeInfiniteList, [1, 2])) === 'refuse:missing',
    `unknown=${span(unknown)}, both=${span(bothUnknown)}, ` +
    `unplaced=${span(unplacedExplicit)}, nan=${span(planCursorZoom(unplacedList, [1, 2]))}, ` +
    `inf=${span(planCursorZoom(infiniteList, [1, 2]))}, ` +
    `-inf=${span(planCursorZoom(negativeInfiniteList, [1, 2]))}`);

  const nanDefault = planCursorZoom(unplacedList);
  const infiniteDefault = planCursorZoom(infiniteList);
  check('a non-finite sample counts as unplaced in the default path too',
    span(nanDefault) === 'refuse:needs-pair' && span(infiniteDefault) === 'refuse:needs-pair',
    `nan=${span(nanDefault)}, inf=${span(infiniteDefault)}`);
}

{
  const mixed = cursors([1, 100], [2, null]);
  const viaDefault = planCursorZoom(mixed);
  const viaExplicit = planCursorZoom(mixed, [1, 2]);
  check('refusal precedence: the same list reports needs-pair by default and missing for that pair',
    span(viaDefault) === 'refuse:needs-pair' && span(viaExplicit) === 'refuse:missing',
    `default=${span(viaDefault)}, explicit=${span(viaExplicit)}`);

  const refusals: CursorZoomPlan[] = [
    viaDefault, viaExplicit, planCursorZoom(cursors([1, 5], [2, 5])),
    planCursorZoom([], [1, 2]),
  ];
  check('a refusal carries only kind and reason, never invented bounds',
    refusals.every((plan) => plan.kind === 'refuse' &&
      !('start' in shape(plan)) && !('end' in shape(plan)) &&
      !('a' in shape(plan)) && !('b' in shape(plan))),
    `shapes=${json(refusals.map(shape))}`);
}

{
  const fractional = planCursorZoom(cursors([1, 10.6], [2, 10.4]));
  const halfUp = planCursorZoom(cursors([1, 20.5], [2, 30.4]));
  const quarter = planCursorZoom(cursors([1, 70.25], [2, 70.75]));
  check('fractional samples are rounded before ordering, refusal, and the bounds',
    span(fractional) === '2:1@10..11' && span(halfUp) === '1:2@21..30' &&
    span(quarter) === '1:2@70..71',
    `fractional=${span(fractional)}, halfUp=${span(halfUp)}, quarter=${span(quarter)}`);

  const integerBodies: readonly [number | null, number | null][] = [
    [0, 1], [0, 300000], [100, 100], [10.5, 11.5], [Number.NaN, 4], [-5, 40],
  ];
  const plans = integerBodies.map(([a, b]) =>
    planCursorZoom(cursors([1, a], [2, b])));
  check('every zoom plan hands back integer bounds in increasing order',
    plans.every((plan) => plan.kind === 'refuse' ||
      (Number.isInteger(plan.start) && Number.isInteger(plan.end) && plan.start < plan.end)),
    `plans=${plans.map(span).join(',')}`);

  const zeroSpan = planCursorZoom(cursors([1, 0], [2, 7]));
  check('sample zero is a real bound, not an unset cursor',
    span(zeroSpan) === '1:2@0..7', `plan=${span(zeroSpan)}`);
}

{
  const negative = planCursorZoom(cursors([1, -5], [2, 40]));
  const clampedShape = '1:2@0..40';
  check('a negative sample survives as a negative bound instead of being clamped to zero',
    span(negative) === '1:2@-5..40' && negative.kind === 'zoom' &&
    negative.start === -5 && negative.start !== Math.max(0, -5),
    `plan=${span(negative)}, clampedWouldBe=${clampedShape}`);

  check('control: a zero-clamped planner produces a different span than this one',
    span(negative) !== clampedShape && clampedShape === '1:2@0..40',
    `planned=${span(negative)}`);

  const negativePair = planCursorZoom(cursors([1, 40], [2, -5]));
  check('a negative sample also survives on the far side of the pair',
    span(negativePair) === '2:1@-5..40', `plan=${span(negativePair)}`);
}

{
  const frozen: readonly CursorZoomRequest[] = Object.freeze([
    Object.freeze({ cursorId: 1, sample: 100 }),
    Object.freeze({ cursorId: 2, sample: 700 }),
    Object.freeze({ cursorId: 3, sample: null }),
  ]);
  let survived = true;
  try {
    planCursorZoom(frozen);
    planCursorZoom(frozen, [1, 2]);
    planCursorZoom(frozen, [1, 3]);
  } catch {
    survived = false;
  }
  check('planning never writes to a frozen cursor list or cursor entry',
    survived && frozen.length === 3 && frozen[0].sample === 100 && frozen[2].sample === null,
    `survived=${survived}, lengths=${frozen.length}/${json(frozen.map((c) => c.sample))}`);

  const input = cursors([1, 900], [2, 10], [3, 30]);
  const before = json(input);
  const first = json(planCursorZoom(input));
  const second = json(planCursorZoom(input));
  check('a repeated plan over the same list is identical and leaves the input untouched',
    first === second && json(input) === before && first === json({
      kind: 'zoom', start: 10, end: 900, a: 2, b: 1,
    }),
    `first=${first}, second=${second}, input=${json(input)}`);
}

{
  const table: readonly (readonly [
    string, CursorZoomRequest[], readonly [number, number] | undefined, string,
  ])[] = [
    ['none', [], undefined, 'refuse:needs-pair'],
    ['one', cursors([1, 5]), undefined, 'refuse:needs-pair'],
    ['two in order', cursors([1, 5], [2, 9]), undefined, '1:2@5..9'],
    ['two reversed', cursors([1, 9], [2, 5]), undefined, '2:1@5..9'],
    ['two equal', cursors([1, 5], [2, 5]), undefined, 'refuse:degenerate'],
    ['explicit reversed tuple', cursors([1, 5], [2, 9]), [2, 1], '1:2@5..9'],
    ['explicit unknown id', cursors([1, 5], [2, 9]), [1, 4], 'refuse:missing'],
    ['explicit unplaced id', cursors([1, 5], [2, null]), [1, 2], 'refuse:missing'],
    ['explicit outside default', cursors([1, 5], [2, 9], [3, 2]), [1, 3], '3:1@2..5'],
    ['explicit one cursor twice', cursors([1, 5], [2, 9]), [1, 1], 'refuse:degenerate'],
    ['three cursors first two', cursors([1, 50], [2, 10], [3, 90]), undefined, '2:1@10..50'],
  ];
  const rows = table.map(([label, list, pair, expected]) => {
    const actual = pair === undefined
      ? span(planCursorZoom(list))
      : span(planCursorZoom(list, pair));
    return { label, expected, actual };
  });
  const matches = (candidate: typeof rows): boolean =>
    candidate.every((row) => row.actual === row.expected);
  check('the whole decision table matches its expected span or refusal',
    matches(rows),
    rows.map((row) => `${row.label}:${row.actual === row.expected
      ? 'ok' : `${row.actual}!=${row.expected}`}`).join(' | '));

  const reversedMutation = rows.map((row) =>
    (row.label === 'two reversed' ? { ...row, expected: '1:2@5..9' } : row));
  const defaultMutation = rows.map((row, index) =>
    (index === 0 ? { ...row, expected: 'refuse:missing' } : row));
  check('control: the decision table fails on a swapped span and on a swapped refusal reason',
    matches(rows) && !matches(reversedMutation) && !matches(defaultMutation),
    `clean=${matches(rows)}, reversed=${matches(reversedMutation)}, ` +
    `default=${matches(defaultMutation)}`);
}

{
  const source = fs.readFileSync('src/ui/cursorZoom.ts', 'utf8');
  const imports = source.match(/^import .*$/gm) ?? [];
  check('the planner is a zero-import module',
    imports.length === 0 && !source.includes('from '),
    `imports=${imports.length}, fromClauses=${source.includes('from ')}`);

  const forbidden = ['document', 'window', 'addEventListener', 'requestAnimationFrame',
    'SampleStore', 'storeRef', "from './app.js'", "from './state.js'", '//', '/*', ' as any'];
  const hits = forbidden.filter((token) => source.includes(token));
  check('the planner touches no DOM, App, or store and carries no comment',
    hits.length === 0, `hits=${json(hits)}`);

  const clampNeedle = 'Math.max(0';
  const control = `const start = ${clampNeedle}, sample);`;
  check('the planner never zero-clamps a bound, and the absence needle can match',
    !source.includes(clampNeedle) && control.includes(clampNeedle),
    `planner=${source.includes(clampNeedle)}, controlMatches=${control.includes(clampNeedle)}`);

  const orderNeedle = 'firstSample < secondSample';
  check('the ordered bounds come from one comparison of the two resolved samples',
    source.includes(orderNeedle) &&
    (source.match(/Math\.min|Math\.max/g) ?? []).length === 0 &&
    (source.match(/export function /g) ?? []).length === 1,
    `needle=${source.includes(orderNeedle)}, ` +
    `minMax=${(source.match(/Math\.min|Math\.max/g) ?? []).length}, ` +
    `functions=${(source.match(/export function /g) ?? []).length}`);

  check('the refusal vocabulary is exactly the three reasons the plan can name',
    (source.match(/'needs-pair'|'degenerate'|'missing'/g) ?? []).length >= 3 &&
    !source.includes('no-capture') && !source.includes('locked'),
    `reasons=${(source.match(/'needs-pair'|'degenerate'|'missing'/g) ?? []).length}`);
}

const failed = results.filter((result) => !result.pass).length;
console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
