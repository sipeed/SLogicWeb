import {
  CURSOR_CHIP_EDGE, CURSOR_CHIP_ROWS, cursorColor, cursorLabels, layoutCursorChips, nearestCursorGrab,
  type CursorChip, type PlacedCursorChip,
} from '../cursorSet.js';

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

const chip = (id: number, cssX: number, label = String(id)): CursorChip => ({ id, label, cssX });
const width20 = (): number => 20;
const PLOT_WIDTH = 400;
const ids = (chips: readonly PlacedCursorChip[]): string => chips.map((c) => String(c.id)).join(',');

{
  const slots = [0, 1, 2, 3].map((index) => cursorColor(index));
  check('positions 0..3 return the four palette literals in order',
    slots[0] === '#CD427E' && slots[1] === '#00994D' &&
    slots[2] === '#2683D9' && slots[3] === '#DB4C39' && new Set(slots).size === 4,
    `slots=${slots.join(',')}`);

  const wrapped = {
    four: cursorColor(4),
    seven: cursorColor(7),
    large: cursorColor(1_000_001),
  };
  check('the colour cycle has period 4 and wraps at 4, 7, and a large index',
    wrapped.four === '#CD427E' && wrapped.seven === '#DB4C39' &&
    wrapped.large === '#00994D',
    `four=${wrapped.four}, seven=${wrapped.seven}, large=${wrapped.large}`);
}

{
  const fallbacks = [-1, -4, -3.5, Number.NaN, Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY].map((index) => cursorColor(index));
  check('negative and non-finite indices fall back to slot 0 without throwing',
    fallbacks.every((color) => color === '#CD427E'),
    `fallbacks=${fallbacks.join(',')}`);

  const fractional = { below: cursorColor(3.7), above: cursorColor(4.9) };
  check('a fractional index floors before the modulo (3.7 -> slot 3, 4.9 -> slot 0)',
    fractional.below === '#DB4C39' && fractional.above === '#CD427E',
    `3.7=${fractional.below}, 4.9=${fractional.above}`);
}

{
  const empty = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    .map((count) => cursorLabels(count));
  check('zero, negative, and non-finite counts produce no labels',
    empty.every((labels) => labels.length === 0),
    `lengths=${empty.map((labels) => labels.length).join(',')}`);

  const exact = {
    one: cursorLabels(1).join(','),
    three: cursorLabels(3).join(','),
    five: cursorLabels(5).join(','),
  };
  check('positive counts produce exactly 1..count',
    exact.one === '1' && exact.three === '1,2,3' && exact.five === '1,2,3,4,5',
    `one=${exact.one}, three=${exact.three}, five=${exact.five}`);

  check('a fractional count floors to the whole labels it can represent',
    cursorLabels(2.9).join(',') === '1,2',
    `2.9=${cursorLabels(2.9).join(',')}`);
}

{
  const atRight = nearestCursorGrab([{ id: 1, cssX: 404 }], 400);
  const pastRight = nearestCursorGrab([{ id: 1, cssX: 404.0001 }], 400);
  const atLeft = nearestCursorGrab([{ id: 1, cssX: 396 }], 400);
  const pastLeft = nearestCursorGrab([{ id: 1, cssX: 395.9999 }], 400);
  check('the grab band is inclusive at exactly 4 CSS px and rejects 4.0001 on both sides',
    atRight?.id === 1 && pastRight === null && atLeft?.id === 1 && pastLeft === null,
    `atRight=${String(atRight?.id)}, pastRight=${String(pastRight)}, ` +
    `atLeft=${String(atLeft?.id)}, pastLeft=${String(pastLeft)}`);

  const exactHit = nearestCursorGrab([{ id: 5, cssX: 250 }], 250);
  check('control: a pointer exactly on a cursor still selects it',
    exactHit?.id === 5, `id=${String(exactHit?.id)}`);
}

{
  const nearFirst = nearestCursorGrab([{ id: 7, cssX: 403.9 }, { id: 8, cssX: 404 }], 400);
  const farFirst = nearestCursorGrab([{ id: 8, cssX: 404 }, { id: 7, cssX: 403.9 }], 400);
  check('3.9 px beats 4 px in either array order',
    nearFirst?.id === 7 && farFirst?.id === 7,
    `nearFirst=${String(nearFirst?.id)}, farFirst=${String(farFirst?.id)}`);
}

{
  const leftFirst = nearestCursorGrab([{ id: 1, cssX: 401 }, { id: 2, cssX: 403 }], 400);
  const rightFirst = nearestCursorGrab([{ id: 2, cssX: 403 }, { id: 1, cssX: 401 }], 400);
  check('the nearest candidate wins regardless of array order',
    leftFirst?.id === 1 && rightFirst?.id === 1,
    `leftFirst=${String(leftFirst?.id)}, rightFirst=${String(rightFirst?.id)}`);
}

{
  const ab = nearestCursorGrab([{ id: 1, cssX: 398 }, { id: 2, cssX: 402 }], 400);
  const ba = nearestCursorGrab([{ id: 2, cssX: 402 }, { id: 1, cssX: 398 }], 400);
  const sameSpot = nearestCursorGrab([{ id: 3, cssX: 400 }, { id: 4, cssX: 400 }], 400);
  check('an exact distance tie returns the candidate later in the array',
    ab?.id === 2 && ba?.id === 1 && sameSpot?.id === 4,
    `ab=${String(ab?.id)}, ba=${String(ba?.id)}, sameSpot=${String(sameSpot?.id)}`);
}

{
  const nanPointer = nearestCursorGrab([{ id: 1, cssX: 400 }], Number.NaN);
  const infinitePointer =
    nearestCursorGrab([{ id: 1, cssX: 400 }], Number.POSITIVE_INFINITY);
  const empty = nearestCursorGrab([], 400);
  check('a non-finite pointer or an empty candidate list selects nothing',
    nanPointer === null && infinitePointer === null && empty === null,
    `nan=${String(nanPointer)}, infinite=${String(infinitePointer)}, ` +
    `empty=${String(empty)}`);

  const withNaN = nearestCursorGrab([{ id: 1, cssX: Number.NaN }, { id: 2, cssX: 401 }], 400);
  const withInfinity = nearestCursorGrab(
    [{ id: 1, cssX: Number.POSITIVE_INFINITY }, { id: 2, cssX: 401 }], 400);
  const onlyInvalid = nearestCursorGrab(
    [{ id: 1, cssX: Number.NaN }, { id: 2, cssX: Number.NEGATIVE_INFINITY }], 400);
  check('a non-finite cssX candidate is skipped while a valid neighbour still wins',
    withNaN?.id === 2 && withInfinity?.id === 2 && onlyInvalid === null,
    `nanCssX=${String(withNaN?.id)}, infiniteCssX=${String(withInfinity?.id)}, ` +
    `onlyInvalid=${String(onlyInvalid)}`);
}

{
  const empty = layoutCursorChips([], width20, PLOT_WIDTH);
  const single = chip(1, 50);
  const singleLayout = layoutCursorChips([single], width20, PLOT_WIDTH);
  check('an empty input places nothing and a single chip keeps its id and label at its anchor',
    empty.length === 0 && singleLayout.length === 1 &&
    singleLayout[0].id === 1 && singleLayout[0].label === '1' &&
    singleLayout[0].anchorX === 50 && singleLayout[0].boxX === 50 && singleLayout[0].row === 0,
    `empty=${empty.length}, single=${ids(singleLayout)}, ` +
    `anchor=${singleLayout[0]?.anchorX}, box=${singleLayout[0]?.boxX}, row=${singleLayout[0]?.row}`);
}

{
  const mixed = layoutCursorChips(
    [chip(2, 200), chip(1, 0), chip(3, 300)], width20, PLOT_WIDTH);
  check('every placement carries its own anchor and box, and the untouched layout is row 0',
    mixed.length === 3 && mixed.every((c) => c.boxX === c.anchorX && c.row === 0) &&
    mixed.map((c) => c.anchorX).join(',') === '0,200,300' &&
    mixed.map((c) => c.label).join(',') === '1,2,3' &&
    CURSOR_CHIP_ROWS === 2 && CURSOR_CHIP_EDGE === 2,
    `placed=${mixed.map((c) => `${c.id}:${c.anchorX}/${c.boxX}/${c.row}`).join(',')}, ` +
    `rows=${CURSOR_CHIP_ROWS}, edge=${CURSOR_CHIP_EDGE}`);

  const noPlot = layoutCursorChips([chip(1, 50)], width20, 0);
  const badPlot = layoutCursorChips([chip(1, 50)], width20, Number.NaN);
  check('a plot with no usable width places nothing',
    noPlot.length === 0 && badPlot.length === 0,
    `zero=${noPlot.length}, nan=${badPlot.length}`);
}

{
  const sameX = layoutCursorChips([chip(1, 50), chip(2, 50)], width20, PLOT_WIDTH);
  check('two chips at the same x place only the later one',
    ids(sameX) === '2', `placed=${ids(sameX)}`);

  const tenApart = layoutCursorChips([chip(1, 50), chip(2, 60)], width20, PLOT_WIDTH);
  check('two 20 px chips 10 px apart place only the later one',
    ids(tenApart) === '2', `placed=${ids(tenApart)}`);
}

{
  const far = layoutCursorChips([chip(2, 200), chip(1, 0)], width20, PLOT_WIDTH);
  check('distant chips all place in ascending cssX order even when input is right-to-left',
    ids(far) === '1,2' && far[0].boxX === 0 && far[1].boxX === 200,
    `placed=${ids(far)}, xs=${far.map((c) => c.boxX).join(',')}`);

  const forward = layoutCursorChips([chip(1, 0), chip(2, 200)], width20, PLOT_WIDTH);
  check('distant chips all place in ascending cssX order when input is left-to-right',
    ids(forward) === '1,2' && forward[0].boxX === 0 && forward[1].boxX === 200,
    `placed=${ids(forward)}, xs=${forward.map((c) => c.boxX).join(',')}`);
}

{
  const zeroWidth = (label: string): number => label === '2' ? 0 : 20;
  const withZero = layoutCursorChips([chip(1, 0), chip(2, 100)], zeroWidth, PLOT_WIDTH);
  const onlyZero = layoutCursorChips([chip(2, 100)], zeroWidth, PLOT_WIDTH);
  const nanWidth = (label: string): number => label === '1' ? Number.NaN : 20;
  const withNaN = layoutCursorChips([chip(1, 0), chip(2, 100)], nanWidth, PLOT_WIDTH);
  check('a zero or NaN chip width is skipped while a valid sibling still places',
    ids(withZero) === '1' && onlyZero.length === 0 && ids(withNaN) === '2',
    `withZero=${ids(withZero)}, onlyZero=${onlyZero.length}, withNaN=${ids(withNaN)}`);
}

{
  const touching = layoutCursorChips([chip(1, 0), chip(2, 22)], width20, PLOT_WIDTH);
  const colliding = layoutCursorChips([chip(1, 0), chip(2, 21.999)], width20, PLOT_WIDTH);
  check('boxes separated by exactly 2 px keep their 1 px gap; 1.999 px collides',
    ids(touching) === '1,2' && ids(colliding) === '2',
    `touching=${ids(touching)}, colliding=${ids(colliding)}`);
}

{
  const labelled = (label: string): number => label === '2' ? 100 : 20;
  const wide = layoutCursorChips([chip(1, 0, '1'), chip(2, 40, '2')], labelled, PLOT_WIDTH);
  check('the caller-supplied width decides the box: a 100 px chip at 40 collides with a 20 px chip at 0',
    ids(wide) === '2', `placed=${ids(wide)}`);
}

{
  const labelWidth = (label: string): number => label === '2' ? 200 : 20;
  const newest = chip(1, 60, '1');
  const placed = layoutCursorChips([chip(3, 0, '2'), newest], labelWidth, PLOT_WIDTH);
  const alone = chip(3, 0, '2');
  const single = layoutCursorChips([alone], labelWidth, PLOT_WIDTH);
  check('the width is keyed by the label, not the id: label 2 at 0 loses to label 1 at 60',
    placed.length === 1 && placed[0].id === newest.id &&
    single.length === 1 && single[0].id === alone.id,
    `placed=${placed.map((c) => `${c.id}:${c.label}`).join(',')}, single=${single.length}`);
}

{
  const priority = layoutCursorChips([chip(1, 0), chip(2, 5), chip(3, 40)], width20, PLOT_WIDTH);
  check('newest priority drops the oldest of a colliding pair, not the middle one',
    ids(priority) === '2,3', `placed=${ids(priority)}`);

  const withInvalid =
    layoutCursorChips([chip(1, Number.NaN), chip(2, 0)], width20, PLOT_WIDTH);
  check('a chip with a non-finite cssX is skipped instead of placed',
    ids(withInvalid) === '2', `placed=${ids(withInvalid)}`);
}

{
  const source = fs.readFileSync('src/ui/cursorSet.ts', 'utf8');
  const imports = source.match(/^import .*$/gm) ?? [];
  const paletteLeaked = ['#CD427E', '#00994D', '#2683D9', '#DB4C39']
    .some((hex) => source.includes(hex));
  check('the model imports the shared grab radius and palette instead of restating them',
    imports.length === 2 &&
    source.includes("import { MARKER_GRAB_RADIUS_CSS } from './markerGeometry.js';") &&
    source.includes("import { MEASURE_COLORS } from './metrics.js';") &&
    !source.includes('MARKER_GRAB_RADIUS_CSS =') && !paletteLeaked,
    `imports=${imports.length}, radiusConst=${source.includes('MARKER_GRAB_RADIUS_CSS =')}, ` +
    `palette=${paletteLeaked}`);

  const forbidden = ['document', 'window', 'addEventListener', 'requestAnimationFrame',
    'SampleStore', 'storeRef', '//', '/*'];
  const hits = forbidden.filter((token) => source.includes(token));
  check('the model touches no DOM, store, or browser state and carries no comments',
    hits.length === 0, `hits=${JSON.stringify(hits)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
