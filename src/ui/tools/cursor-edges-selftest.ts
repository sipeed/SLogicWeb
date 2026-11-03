import {
  MAX_CURSOR_EDGE_ROWS, addEdgeRow, assignEdgeChannel, assignEdgeCursor, clearEdgeCursors,
  pruneEdgeChannels, pruneEdgeCursors, removeEdgeRow, type CursorEdgeRow,
} from '../cursorEdges.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function makeRows(
  specs: readonly (readonly [number, number | null, number | null, number | null])[],
): CursorEdgeRow[] {
  return specs.map(([id, a, b, channel]) => ({ id, a, b, channel }));
}

const ids = (rows: readonly CursorEdgeRow[]): string =>
  rows.map((row) => String(row.id)).join(',');

const cells = (rows: readonly CursorEdgeRow[]): string => rows.map((row) =>
  `${row.id}:${row.a === null ? '-' : row.a}:${row.b === null ? '-' : row.b}:` +
  `${row.channel === null ? '-' : row.channel}`).join(',');

const json = (value: unknown): string => JSON.stringify(value);

check('the edge-row cap is exactly fifteen',
  MAX_CURSOR_EDGE_ROWS === 15, `MAX_CURSOR_EDGE_ROWS=${MAX_CURSOR_EDGE_ROWS}`);

{
  const empty: CursorEdgeRow[] = [];
  const added = addEdgeRow(empty, 7, 4);
  check('an added row keeps the caller id and default channel with both cursor sides unset',
    added !== empty && cells(added) === '7:-:-:4' && empty.length === 0,
    `added=${cells(added)}, inputLength=${empty.length}`);

  const unset = addEdgeRow(empty, 0, null);
  check('a new row may explicitly start without a channel and never invents an id',
    cells(unset) === '0:-:-:-' && empty.length === 0, `rows=${cells(unset)}`);

  const base = makeRows([[1, 2, 3, 0], [4, 5, 6, 8]]);
  const appended = addEdgeRow(base, 9, 12);
  check('adding appends last and reuses every existing row object',
    ids(appended) === '1,4,9' && appended[0] === base[0] && appended[1] === base[1] &&
    cells(base) === '1:2:3:0,4:5:6:8',
    `rows=${cells(appended)}, input=${cells(base)}`);

  const duplicate = addEdgeRow(base, 4, 15);
  check('a duplicate row id is refused by reference without changing the existing selection',
    duplicate === base && cells(base) === '1:2:3:0,4:5:6:8',
    `same=${duplicate === base}, rows=${cells(duplicate)}`);
}

{
  const fourteen = makeRows(Array.from(
    { length: 14 }, (_, index) => [index + 1, null, null, index] as const));
  const fifteen = addEdgeRow(fourteen, 15, 14);
  const sixteen = addEdgeRow(fifteen, 16, 15);
  check('the fifteenth row is accepted and the sixteenth is refused by reference',
    fifteen.length === 15 && cells([fifteen[14]]) === '15:-:-:14' &&
    sixteen === fifteen && fourteen.length === 14,
    `fifteen=${fifteen.length}, sixteenthSame=${sixteen === fifteen}, input=${fourteen.length}`);

  const atCap = makeRows(Array.from(
    { length: MAX_CURSOR_EDGE_ROWS }, (_, index) => [index + 1, null, null, null] as const));
  const refused = addEdgeRow(atCap, 99, 0);
  check('an at-cap list remains unchanged for a fresh id and channel',
    refused === atCap && refused.length === 15,
    `same=${refused === atCap}, length=${refused.length}`);
}

{
  const original = makeRows([[1, 2, 3, 4], [5, 6, 7, 8], [9, null, null, null]]);
  const removed = removeEdgeRow(original, 5);
  check('removing drops only the target and preserves order, identities, selections, and row references',
    ids(removed) === '1,9' && cells(removed) === '1:2:3:4,9:-:-:-' &&
    removed[0] === original[0] && removed[1] === original[2] &&
    cells(original) === '1:2:3:4,5:6:7:8,9:-:-:-',
    `next=${cells(removed)}, input=${cells(original)}`);

  const unknown = removeEdgeRow(original, 99);
  check('removing an unknown row id is a same-reference no-op',
    unknown === original, `same=${unknown === original}`);
}

{
  const base = makeRows([[10, null, null, 3], [20, 1, 2, 4]]);
  const aFirst = assignEdgeCursor(base, 10, 'a', 7);
  const bFirst = assignEdgeCursor(base, 10, 'b', 9);
  const both = assignEdgeCursor(aFirst, 10, 'b', 9);
  check('either cursor side can be assigned first without changing the channel or sibling row',
    cells(aFirst) === '10:7:-:3,20:1:2:4' && cells(bFirst) === '10:-:9:3,20:1:2:4' &&
    cells(both) === '10:7:9:3,20:1:2:4' && both[1] === base[1] && both[0] !== base[0] &&
    cells(base) === '10:-:-:3,20:1:2:4',
    `aFirst=${cells(aFirst)}, bFirst=${cells(bFirst)}, both=${cells(both)}`);

  const sameCursor = assignEdgeCursor(both, 10, 'a', 9);
  check('both sides may reference the same cursor id',
    cells(sameCursor) === '10:9:9:3,20:1:2:4', `rows=${cells(sameCursor)}`);

  const cleared = assignEdgeCursor(both, 10, 'b', null);
  check('null clears only the requested side and preserves the other side and channel',
    cells(cleared) === '10:7:-:3,20:1:2:4', `rows=${cells(cleared)}`);

  const sameValue = assignEdgeCursor(both, 10, 'a', 7);
  const unknown = assignEdgeCursor(both, 999, 'a', 8);
  check('same-value and unknown-row cursor assignments are same-reference no-ops',
    sameValue === both && unknown === both,
    `sameValue=${sameValue === both}, unknown=${unknown === both}`);

  const alreadyNull = assignEdgeCursor(base, 10, 'a', null);
  check('clearing an already unset cursor side is also a same-reference no-op',
    alreadyNull === base, `same=${alreadyNull === base}`);

  const zero = assignEdgeCursor(base, 10, 'a', 0);
  check('cursor id zero is retained as a real identity',
    zero[0].a === 0 && zero[0].b === null, `rows=${cells(zero)}`);
}

{
  const base = makeRows([[1, 4, 5, 3], [2, null, 6, null]]);
  const changed = assignEdgeChannel(base, 1, 12);
  check('channel assignment changes only the absolute channel on the target row',
    cells(changed) === '1:4:5:12,2:-:6:-' && changed[1] === base[1] && changed[0] !== base[0] &&
    cells(base) === '1:4:5:3,2:-:6:-',
    `next=${cells(changed)}, input=${cells(base)}`);

  const cleared = assignEdgeChannel(changed, 1, null);
  check('an explicit null channel selection is preserved without clearing cursor ids',
    cells(cleared) === '1:4:5:-,2:-:6:-', `rows=${cells(cleared)}`);

  const zero = assignEdgeChannel(base, 2, 0);
  check('absolute channel zero is a real selection',
    zero[1].channel === 0 && zero[1].a === null && zero[1].b === 6, `rows=${cells(zero)}`);

  const same = assignEdgeChannel(base, 1, 3);
  const sameNull = assignEdgeChannel(base, 2, null);
  const unknown = assignEdgeChannel(base, 99, 8);
  check('same-value, same-null, and unknown-row channel assignments return the original array',
    same === base && sameNull === base && unknown === base,
    `same=${same === base}, sameNull=${sameNull === base}, unknown=${unknown === base}`);
}

{
  const original = makeRows([
    [1, 5, 6, 0], [2, 9, 7, 4], [3, null, 8, null], [4, null, null, 12],
  ]);
  const pruned = pruneEdgeCursors(original, new Set([5, 7]));
  check('cursor pruning clears exactly the missing sides while preserving rows and channels',
    cells(pruned) === '1:5:-:0,2:-:7:4,3:-:-:-,4:-:-:12' && pruned.length === 4,
    `rows=${cells(pruned)}`);

  check('cursor pruning reuses unaffected rows and replaces only changed rows',
    pruned[2] !== original[2] && pruned[3] === original[3] &&
    pruned[0] !== original[0] && pruned[1] !== original[1],
    `row2Changed=${pruned[2] !== original[2]}, row3Same=${pruned[3] === original[3]}`);

  check('cursor pruning never mutates its input',
    cells(original) === '1:5:6:0,2:9:7:4,3:-:8:-,4:-:-:12', `input=${cells(original)}`);

  const allPresent = makeRows([[1, 5, 6, 0], [2, 7, null, 2]]);
  const nothingMissing = pruneEdgeCursors(allPresent, new Set([5, 6, 7]));
  check('cursor pruning with every id present is a same-reference no-op',
    nothingMissing === allPresent, `same=${nothingMissing === allPresent}`);

  const zero = pruneEdgeCursors(makeRows([[1, 0, 6, 3]]), new Set([0]));
  check('cursor pruning treats id zero as present rather than unset',
    cells(zero) === '1:0:-:3', `rows=${cells(zero)}`);
}

{
  const original = makeRows([[1, 5, 6, 0], [2, null, null, 4], [3, 7, null, null]]);
  const cleared = clearEdgeCursors(original);
  check('clearing cursors preserves every row id and channel while emptying both sides',
    cells(cleared) === '1:-:-:0,2:-:-:4,3:-:-:-' && cleared.length === 3,
    `rows=${cells(cleared)}`);

  check('clearing cursors leaves the input intact and reuses already-empty row objects',
    cells(original) === '1:5:6:0,2:-:-:4,3:7:-:-' && cleared[1] === original[1] &&
    cleared[0] !== original[0] && cleared[2] !== original[2],
    `input=${cells(original)}, emptySame=${cleared[1] === original[1]}`);

  const empty = makeRows([[1, null, null, 8], [2, null, null, null]]);
  const again = clearEdgeCursors(empty);
  check('clearing an already cursor-empty list is a same-reference no-op',
    again === empty, `same=${again === empty}`);
}

{
  const original = makeRows([
    [1, 5, 6, 0], [2, 9, 7, 4], [3, null, 8, null], [4, null, null, 12],
  ]);
  const pruned = pruneEdgeChannels(original, new Set([0, 12]));
  check('channel pruning clears only unavailable selections and never retargets another channel',
    cells(pruned) === '1:5:6:0,2:9:7:-,3:-:8:-,4:-:-:12' && pruned.length === 4,
    `rows=${cells(pruned)}`);

  check('channel pruning preserves cursor identities and reuses rows whose channel remains valid',
    pruned[0] === original[0] && pruned[3] === original[3] && pruned[1] !== original[1] &&
    pruned[2] === original[2] && pruned[1].a === 9 && pruned[1].b === 7,
    `same0=${pruned[0] === original[0]}, same2=${pruned[2] === original[2]}, ` +
    `same3=${pruned[3] === original[3]}`);

  check('channel pruning leaves every input selection untouched',
    cells(original) === '1:5:6:0,2:9:7:4,3:-:8:-,4:-:-:12', `input=${cells(original)}`);

  const available = makeRows([[1, 2, null, 0], [2, null, 3, null]]);
  const unchanged = pruneEdgeChannels(available, new Set([0]));
  check('channel pruning with all set channels available and nulls unset is a no-op by reference',
    unchanged === available, `same=${unchanged === available}`);

  const zero = pruneEdgeChannels(makeRows([[1, null, null, 0]]), new Set([0]));
  check('absolute channel zero survives availability pruning',
    zero[0].channel === 0, `rows=${cells(zero)}`);
}

{
  const frozen: readonly CursorEdgeRow[] = Object.freeze([
    Object.freeze({ id: 1, a: 2, b: 3, channel: 4 }),
    Object.freeze({ id: 2, a: 4, b: null, channel: null }),
  ]);
  let survived = true;
  try {
    addEdgeRow(frozen, 3, 0);
    removeEdgeRow(frozen, 1);
    assignEdgeCursor(frozen, 1, 'b', 9);
    assignEdgeChannel(frozen, 1, 8);
    pruneEdgeCursors(frozen, new Set([2]));
    clearEdgeCursors(frozen);
    pruneEdgeChannels(frozen, new Set());
  } catch {
    survived = false;
  }
  check('all reducers accept frozen inputs without writing to a row or array',
    survived && cells(frozen) === '1:2:3:4,2:4:-:-',
    `survived=${survived}, rows=${cells(frozen)}`);

  const input = makeRows([[1, 5, 6, 0], [2, 7, null, 4]]);
  const before = json(input);
  const run = (): string[] => [
    json(addEdgeRow(input, 3, 8)),
    json(removeEdgeRow(input, 2)),
    json(assignEdgeCursor(input, 1, 'a', 9)),
    json(assignEdgeChannel(input, 1, 12)),
    json(pruneEdgeCursors(input, new Set([5]))),
    json(clearEdgeCursors(input)),
    json(pruneEdgeChannels(input, new Set([4]))),
  ];
  const first = run();
  const second = run();
  check('replaying every reducer yields identical output and leaves the shared input unchanged',
    json(first) === json(second) && json(input) === before,
    `first=${first.join(' | ')}, input=${json(input)}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
