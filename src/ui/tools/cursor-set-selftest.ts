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
    [chip(2, 200), chip(1, 20), chip(3, 300)], width20, PLOT_WIDTH);
  check('every placement carries its own anchor and box, and a sparse layout stays on row 0',
    mixed.length === 3 && mixed.every((c) => c.boxX === c.anchorX && c.row === 0) &&
    mixed.map((c) => c.anchorX).join(',') === '20,200,300' &&
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
  check('two chips at the same x both place, one per row, each above its own anchor',
    ids(sameX) === '1,2' && sameX.map((c) => c.row).join(',') === '0,1' &&
    sameX.every((c) => c.boxX === 50 && c.anchorX === 50),
    `placed=${sameX.map((c) => `${c.id}:${c.boxX}/${c.row}`).join(',')}`);

  const tenApart = layoutCursorChips([chip(1, 50), chip(2, 60)], width20, PLOT_WIDTH);
  check('two 20 px chips 10 px apart place both, older on row 0 and newer on row 1',
    ids(tenApart) === '1,2' && tenApart.map((c) => c.row).join(',') === '0,1' &&
    tenApart[0].boxX === 50 && tenApart[1].boxX === 60,
    `placed=${tenApart.map((c) => `${c.id}:${c.boxX}/${c.row}`).join(',')}`);
}

{
  const far = layoutCursorChips([chip(2, 220), chip(1, 20)], width20, PLOT_WIDTH);
  check('distant chips all place in ascending cssX order even when input is right-to-left',
    ids(far) === '1,2' && far[0].boxX === 20 && far[1].boxX === 220,
    `placed=${ids(far)}, xs=${far.map((c) => c.boxX).join(',')}`);

  const forward = layoutCursorChips([chip(1, 20), chip(2, 220)], width20, PLOT_WIDTH);
  check('distant chips all place in ascending cssX order when input is left-to-right',
    ids(forward) === '1,2' && forward[0].boxX === 20 && forward[1].boxX === 220,
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
  const touching = layoutCursorChips([chip(1, 50), chip(2, 72)], width20, PLOT_WIDTH);
  const colliding = layoutCursorChips([chip(1, 50), chip(2, 71.999)], width20, PLOT_WIDTH);
  check('boxes separated by exactly 2 px share row 0; 1.999 px moves the older chip to row 1',
    ids(touching) === '1,2' && touching.map((c) => c.row).join(',') === '0,0' &&
    ids(colliding) === '1,2' && colliding.map((c) => c.row).join(',') === '0,1' &&
    colliding.every((c) => c.boxX === c.anchorX),
    `touching=${touching.map((c) => `${c.id}/r${c.row}`).join(',')}, ` +
    `colliding=${colliding.map((c) => `${c.id}/r${c.row}`).join(',')}`);
}

{
  const labelled = (label: string): number => label === '2' ? 100 : 20;
  const wide = layoutCursorChips([chip(1, 50, '1'), chip(2, 90, '2')], labelled, PLOT_WIDTH);
  const narrow = layoutCursorChips([chip(1, 50, '1'), chip(2, 90, '2')], width20, PLOT_WIDTH);
  check('a 100 px chip 40 px from a 20 px chip takes row 1 while two 20 px chips share row 0',
    ids(wide) === '1,2' && wide.map((c) => c.row).join(',') === '0,1' &&
    ids(narrow) === '1,2' && narrow.map((c) => c.row).join(',') === '0,0',
    `wide=${wide.map((c) => `${c.id}/r${c.row}`).join(',')}, ` +
    `narrow=${narrow.map((c) => `${c.id}/r${c.row}`).join(',')}`);

  const seen: string[] = [];
  const recording = (label: string): number => { seen.push(label); return 20; };
  layoutCursorChips([chip(7, 50, 'A'), chip(8, 120, 'B')], recording, PLOT_WIDTH);
  check('the width function is called with the chip label, never its id',
    seen.join(',') === 'A,B', `seen=${seen.join(',')}`);
}

{
  const priority = layoutCursorChips([chip(1, 100), chip(2, 105), chip(3, 140)], width20, PLOT_WIDTH);
  check('newest priority keeps the colliding pair on rows 0 and 1 and the distant chip on row 0',
    ids(priority) === '1,2,3' && priority.map((c) => c.row).join(',') === '0,1,0' &&
    priority.every((c) => c.boxX === c.anchorX),
    `placed=${priority.map((c) => `${c.id}@${c.boxX}/r${c.row}`).join(',')}`);

  const withInvalid =
    layoutCursorChips([chip(1, Number.NaN), chip(2, 50)], width20, PLOT_WIDTH);
  check('a chip with a non-finite cssX is skipped instead of placed',
    ids(withInvalid) === '2', `placed=${ids(withInvalid)}`);
}

{
  const four = layoutCursorChips(
    [chip(1, 100), chip(2, 110), chip(3, 125), chip(4, 145)], width20, PLOT_WIDTH);
  check('four 20 px chips at 100/110/125/145 place as rows 0/1/0/1 with no displacement',
    ids(four) === '1,2,3,4' && four.map((c) => c.row).join(',') === '0,1,0,1' &&
    four.every((c) => c.boxX === c.anchorX) &&
    four.map((c) => c.boxX).join(',') === '100,110,125,145',
    `placed=${four.map((c) => `${c.id}@${c.boxX}/r${c.row}`).join(',')}`);

  const three = layoutCursorChips([chip(1, 100), chip(2, 105), chip(3, 110)], width20, PLOT_WIDTH);
  check('three chips two rows cannot hold fall back to the single-row drop, newest kept',
    three.length === 1 && three[0].id === 3 && three[0].row === 0 &&
    three[0].boxX === 110 && three[0].anchorX === 110,
    `placed=${three.map((c) => `${c.id}@${c.boxX}/r${c.row}`).join(',')}`);
}

{
  const left = layoutCursorChips([chip(1, 1)], width20, 320);
  const right = layoutCursorChips([chip(1, 319)], width20, 320);
  check('a box that would cross the 2 px edge margin is clamped but keeps its anchor',
    left.length === 1 && left[0].boxX === 12 && left[0].anchorX === 1 &&
    right.length === 1 && right[0].boxX === 308 && right[0].anchorX === 319,
    `left=${left[0]?.boxX}/${left[0]?.anchorX}, right=${right[0]?.boxX}/${right[0]?.anchorX}`);

  const huge = layoutCursorChips([chip(1, 100)], () => 400, 320);
  check('a chip wider than the plot centres on the plot instead of crossing an edge',
    huge.length === 1 && huge[0].boxX === 160, `box=${huge[0]?.boxX}`);

  const stillDrops = layoutCursorChips([chip(1, 1), chip(2, 5), chip(3, 9)], width20, 320);
  check('the drop fallback leaves an untouched anchor and no clamp on the surviving chip',
    stillDrops.length === 1 && stillDrops[0].id === 3 &&
    stillDrops[0].boxX === 9 && stillDrops[0].anchorX === 9,
    `placed=${stillDrops.map((c) => `${c.id}@${c.boxX}`).join(',')}`);
}

{
  const rightmost = layoutCursorChips(
    [chip(1, 505), chip(2, 500), chip(3, 503)], width20, PLOT_WIDTH);
  const leftmost = layoutCursorChips(
    [chip(1, 503), chip(2, 505), chip(3, 500)], width20, PLOT_WIDTH);
  check('the drop fallback keeps the newest chip of an over-dense cluster, not an edge one',
    ids(rightmost) === '3' && rightmost[0].boxX === 503 &&
    ids(leftmost) === '3' && leftmost[0].boxX === 500,
    `rightmost=${rightmost.map((c) => `${c.id}@${c.boxX}`).join(',')}, ` +
    `leftmost=${leftmost.map((c) => `${c.id}@${c.boxX}`).join(',')}`);
}

{
  const failures: string[] = [];
  for (const base of [0, 150, 400]) {
    for (let spacing = 0; spacing <= 40; spacing += 0.5) {
      for (let count = 1; count <= 8; count++) {
        const chips = Array.from(
          { length: count }, (_, index) => chip(index + 1, base + index * spacing));
        const layout = layoutCursorChips(chips, width20, PLOT_WIDTH);
        const seen = new Set<number>();
        const rows: PlacedCursorChip[][] = [[], []];
        for (const placed of layout) {
          if (placed.row !== 0 && placed.row !== 1) failures.push(`row ${placed.row}`);
          if (seen.has(placed.id)) failures.push(`duplicate ${placed.id}`);
          seen.add(placed.id);
          if (placed.anchorX !== chips[placed.id - 1].cssX) failures.push(`anchor ${placed.id}`);
          rows[placed.row].push(placed);
        }
        for (const row of rows) {
          for (let index = 1; index < row.length; index++) {
            const gap = row[index].boxX - 10 - (row[index - 1].boxX + 10);
            if (gap < 2 - 1e-9) {
              failures.push(`overlap base=${base} spacing=${spacing} count=${count}`);
            }
          }
        }
        if (layout.some((placed, index) => index > 0 && placed.boxX < layout[index - 1].boxX)) {
          failures.push(`order base=${base} spacing=${spacing} count=${count}`);
        }
      }
    }
  }
  check('a dense sweep never overlaps two boxes in one row and keeps anchors and order stable',
    failures.length === 0, `failures=${failures.slice(0, 6).join(';')} (${failures.length})`);

  const escaped: string[] = [];
  for (let x = -20; x <= PLOT_WIDTH + 20; x += 0.5) {
    for (const placed of layoutCursorChips([chip(1, x)], width20, PLOT_WIDTH)) {
      if (placed.boxX - 10 < CURSOR_CHIP_EDGE - 1e-9 ||
        placed.boxX + 10 > PLOT_WIDTH - CURSOR_CHIP_EDGE + 1e-9) {
        escaped.push(`single ${x} -> ${placed.boxX}`);
      }
    }
    const pair = layoutCursorChips([chip(1, x), chip(2, x + 5)], width20, PLOT_WIDTH);
    if (pair.length !== 2 || pair.map((c) => c.row).join(',') !== '0,1') {
      escaped.push(`pair ${x} placed=${pair.length}`);
    }
    for (const placed of pair) {
      if (placed.boxX - 10 < CURSOR_CHIP_EDGE - 1e-9 ||
        placed.boxX + 10 > PLOT_WIDTH - CURSOR_CHIP_EDGE + 1e-9) {
        escaped.push(`pair ${x} -> ${placed.boxX}`);
      }
    }
  }
  check('no row-placed box ever crosses the 2 px edge margin, at any anchor from -20 to width+20',
    escaped.length === 0, `failures=${escaped.slice(0, 6).join(';')} (${escaped.length})`);
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
