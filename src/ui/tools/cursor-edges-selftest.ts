import {
  CURSOR_EDGE_DEFERRED_RESULT, CURSOR_EDGE_EMPTY_RESULT, CURSOR_EDGE_QUERY_WINDOW,
  MAX_CURSOR_EDGE_ROWS, addEdgeRow,
  assignEdgeChannel, assignEdgeCursor, clearEdgeCursors, countCursorEdges, pruneEdgeChannels,
  pruneEdgeCursors, removeEdgeRow, type CursorEdgeRow, type EdgeCounts, type EdgeSampleSource,
} from '../cursorEdges.js';

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

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

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

interface EdgeRequest {
  readonly channel: number;
  readonly start: number;
  readonly end: number;
}

class WaveformSource implements EdgeSampleSource {
  readonly length: number;
  readonly requests: EdgeRequest[] = [];

  constructor(
    private readonly levels: ArrayLike<number>,
    private readonly maxRequestWidth = Number.POSITIVE_INFINITY,
  ) {
    this.length = levels.length;
  }

  edges(channel: number, startSample: number, endSample: number): Int32Array {
    if (!Number.isInteger(startSample) || !Number.isInteger(endSample) ||
        startSample < 1 || endSample > this.length || startSample > endSample) {
      throw new Error(`invalid reference query [${startSample}, ${endSample})`);
    }
    if (endSample - startSample > this.maxRequestWidth) {
      throw new Error(`query width ${endSample - startSample} exceeds ${this.maxRequestWidth}`);
    }
    this.requests.push({ channel, start: startSample, end: endSample });
    const positions: number[] = [];
    for (let p = startSample; p < endSample; p += 1) {
      if (this.levels[p] !== this.levels[p - 1]) positions.push(p);
    }
    return Int32Array.from(positions);
  }

  sampleAt(channel: number, index: number): number {
    if (channel !== 0 || !Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new Error(`invalid reference sample ${channel}@${index}`);
    }
    return this.levels[index];
  }
}

function togglingWaveform(length: number, positions: readonly number[], initial = 0): Uint8Array {
  const levels = new Uint8Array(length);
  const transitions = new Set(positions);
  let level = initial;
  for (let p = 0; p < length; p += 1) {
    if (transitions.has(p)) level = level === 0 ? 1 : 0;
    levels[p] = level;
  }
  return levels;
}

function referenceCounts(
  levels: ArrayLike<number>, aSample: number, bSample: number,
): Omit<EdgeCounts, 'cell'> {
  const lo = Math.min(aSample, bSample);
  const hi = Math.min(Math.max(aSample, bSample), levels.length - 1);
  let rising = 0;
  let falling = 0;
  for (let p = lo + 1; p <= hi; p += 1) {
    if (levels[p] === levels[p - 1]) continue;
    if (levels[p] === 1) rising += 1;
    else falling += 1;
  }
  return { rising, falling, total: rising + falling };
}

function countsText(counts: Omit<EdgeCounts, 'cell'>): string {
  return `${counts.rising}/${counts.falling}/${counts.total}`;
}

function requestText(requests: readonly EdgeRequest[]): string {
  return requests.map((request) =>
    `${request.channel}:[${request.start},${request.end})`).join(',');
}

function throws(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

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

check('the production edge query window is exactly 262144 sample positions',
  CURSOR_EDGE_QUERY_WINDOW === 262_144, `window=${CURSOR_EDGE_QUERY_WINDOW}`);

check('an incomplete measurement has a distinct placeholder rather than a fabricated zero',
  CURSOR_EDGE_EMPTY_RESULT === '-/-/-' && CURSOR_EDGE_EMPTY_RESULT !== ['0', '0', '0'].join('/'),
  `placeholder=${CURSOR_EDGE_EMPTY_RESULT}`);

{
  const deferred: string = CURSOR_EDGE_DEFERRED_RESULT;
  const empty: string = CURSOR_EDGE_EMPTY_RESULT;
  check('a deferred measurement has its own cell, distinct from both incomplete and zero',
    deferred === '\u2026' && deferred.length === 1 && deferred !== empty &&
    deferred !== ['0', '0', '0'].join('/'),
    `deferred=${json(deferred)}, empty=${empty}`);
}

{
  const levels = togglingWaveform(31, [10, 20, 30]);
  const source = new WaveformSource(levels);
  const cases: readonly [number, number, string][] = [
    [0, 30, '2/1/3'],
    [10, 30, '1/1/2'],
    [30, 10, '1/1/2'],
    [0, 10, '1/0/1'],
    [10, 20, '0/1/1'],
    [0, 20, '1/1/2'],
    [20, 30, '1/0/1'],
  ];
  for (const [a, b, expected] of cases) {
    const got = countCursorEdges(source, 0, a, b);
    const reference = referenceCounts(levels, a, b);
    check(`directed counts for cursors ${a} and ${b} follow (left, right]`,
      countsText(got) === expected && countsText(reference) === expected && got.cell === expected,
      `got=${got.cell}, reference=${countsText(reference)}, expected=${expected}`);
  }

  const beforeEqual = source.requests.length;
  const equal = countCursorEdges(source, 0, 10, 10);
  check('equal cursor positions are a valid empty interval and issue no store query',
    equal.rising === 0 && equal.falling === 0 && equal.total === 0 && equal.cell === '0/0/0' &&
    source.requests.length === beforeEqual,
    `counts=${equal.cell}, queries=${source.requests.length - beforeEqual}`);

  const constant = new WaveformSource(new Uint8Array(12));
  const zero = countCursorEdges(constant, 0, 0, 11);
  check('a valid constant interval reports exact zero rather than the incomplete placeholder',
    zero.cell === '0/0/0' && constant.requests.length === 1,
    `counts=${zero.cell}, queries=${constant.requests.length}`);

  const leftInclusive: EdgeCounts = {
    rising: 1,
    falling: 1,
    total: 2,
    cell: '1/1/2',
  };
  check('the independent boundary control can reject an inclusive-left/exclusive-right result',
    countsText(referenceCounts(levels, 0, 30)) !== countsText(leftInclusive),
    `reference=${countsText(referenceCounts(levels, 0, 30))}, wrong=${countsText(leftInclusive)}`);
}

{
  const positions = Array.from({ length: 2000 }, (_, index) => index + 1);
  const levels = togglingWaveform(2001, positions);
  const got = countCursorEdges(new WaveformSource(levels), 0, 0, 2000);
  const reference = referenceCounts(levels, 0, 2000);
  check('result composition groups thousands for rising, falling, and total independently',
    got.rising === 1000 && got.falling === 1000 && got.total === 2000 &&
    got.cell === '1,000/1,000/2,000' && countsText(reference) === '1000/1000/2000',
    `got=${got.cell}, reference=${countsText(reference)}`);
}

{
  const levels = togglingWaveform(31, Array.from({ length: 29 }, (_, index) => index + 1));
  const source = new WaveformSource(levels, 4);
  const got = countCursorEdges(source, 0, 2, 29, 4);
  const reference = referenceCounts(levels, 2, 29);
  const expectedRequests = '0:[3,7),0:[7,11),0:[11,15),0:[15,19),0:[19,23),0:[23,27),0:[27,30)';
  check('small forced windows scan every chunk exactly once with contiguous half-open requests',
    requestText(source.requests) === expectedRequests &&
    source.requests.every((request) => request.end - request.start <= 4),
    `requests=${requestText(source.requests)}`);
  check('chunk boundaries preserve exact entered-level counts without omissions or duplicates',
    got.rising === 14 && got.falling === 13 && got.total === 27 && got.cell === '14/13/27' &&
    countsText(reference) === countsText(got),
    `got=${got.cell}, reference=${countsText(reference)}`);
}

{
  const levels = togglingWaveform(262_146, [1, 262_144, 262_145]);
  const source = new WaveformSource(levels, CURSOR_EDGE_QUERY_WINDOW);
  const got = countCursorEdges(source, 0, 0, 262_145);
  check('the default counter never requests more than the production window and scans the tail',
    requestText(source.requests) === '0:[1,262145),0:[262145,262146)' &&
    source.requests.every((request) => request.end - request.start <= CURSOR_EDGE_QUERY_WINDOW),
    `requests=${requestText(source.requests)}`);
  check('production-width chunking matches the independent full-waveform reference',
    got.cell === '2/1/3' && countsText(referenceCounts(levels, 0, 262_145)) === countsText(got),
    `got=${got.cell}, reference=${countsText(referenceCounts(levels, 0, 262_145))}`);
}

{
  const source = new WaveformSource(togglingWaveform(8, [2, 5]));
  const invalidPositions: readonly [string, number, number][] = [
    ['NaN A', Number.NaN, 1],
    ['infinite A', Number.POSITIVE_INFINITY, 1],
    ['negative-infinity B', 1, Number.NEGATIVE_INFINITY],
    ['fractional A', 1.5, 3],
    ['fractional B', 1, 3.5],
    ['negative A', -1, 3],
    ['A beyond capture', 9, 3],
    ['B beyond capture', 1, 9],
    ['unsafe integer A', Number.MAX_SAFE_INTEGER + 1, 1],
  ];
  for (const [name, a, b] of invalidPositions) {
    check(`invalid cursor input fails loudly: ${name}`,
      throws(() => countCursorEdges(source, 0, a, b)), `a=${a}, b=${b}`);
  }

  const invalidChannels = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
  check('negative, fractional, and non-finite channels fail before any store query',
    invalidChannels.every((channel) => throws(() => countCursorEdges(source, channel, 0, 5))) &&
    source.requests.length === 0,
    `channels=${invalidChannels.join(',')}, queries=${source.requests.length}`);

  const invalidWindows = [0, -1, 1.5, Number.NaN, CURSOR_EDGE_QUERY_WINDOW + 1];
  check('invalid or over-limit test windows fail rather than weakening the allocation bound',
    invalidWindows.every((window) => throws(() => countCursorEdges(source, 0, 0, 5, window))) &&
    source.requests.length === 0,
    `windows=${invalidWindows.join(',')}, queries=${source.requests.length}`);

  const invalidLengths = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
  check('invalid source lengths fail loudly instead of producing NaN or clipped guesses',
    invalidLengths.every((length) => throws(() => countCursorEdges({
      length,
      edges: () => new Int32Array(0),
      sampleAt: () => 0,
    }, 0, 0, 0))),
    `lengths=${invalidLengths.join(',')}`);

  const invalidLevel = new WaveformSource(Uint8Array.from([0, 2]));
  check('an entered level other than zero or one fails loudly instead of guessing direction',
    throws(() => countCursorEdges(invalidLevel, 0, 0, 1)),
    `requests=${requestText(invalidLevel.requests)}`);
}

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const guard = 'if (this.cursorReadOnly()) return;';
  const methodBody = (source: string, signature: string): string => {
    const start = source.indexOf(signature);
    return start < 0 ? '' : source.slice(start + signature.length);
  };
  const guardFirst = (source: string, signature: string, texts: readonly string[]): boolean => {
    const body = methodBody(source, signature);
    const at = body.indexOf(guard);
    if (body === '' || at < 0 || body.slice(0, at).trim() !== '') return false;
    return texts.every((text) => body.indexOf(text) > at);
  };
  const withoutGuard = (source: string, signature: string): string => {
    const body = methodBody(source, signature);
    if (body === '' || !body.includes(guard)) return source;
    return source.slice(0, source.indexOf(signature) + signature.length) +
      body.replace(guard, '');
  };
  const signatures: readonly (readonly [string, readonly string[]])[] = [
    ['private addEdgeRow(): void {',
      ['this.edgeRows = rows;', 'this.nextEdgeRowId++;']],
    ['private removeEdgeRow(rowId: number): void {', ['this.edgeRows = dropEdgeRow(']],
    ['private pickEdgeCursor(rowId: number, side: DistanceSide, cursorId: number): void {',
      ['this.edgeRows = assignEdgeCursor(']],
    ['private pickEdgeChannel(rowId: number, channel: number | null): void {',
      ['this.edgeRows = assignEdgeChannel(']],
  ];

  check('every edge-row action refuses before touching rows, the channel, or the row id counter',
    signatures.every(([signature, texts]) => guardFirst(app, signature, texts)),
    signatures.map(([signature]) => `${signature.split('(')[0]}:` +
      `${guardFirst(app, signature, [])}`).join(', '));

  check('the edge-row lock is load-bearing: dropping the guard reopens every row action',
    signatures.every(([signature, texts]) =>
      !guardFirst(withoutGuard(app, signature), signature, texts)) &&
    app.includes('return cursorsLocked({ running: this.running, stopping: this.stopping });') &&
    (app.match(/private cursorReadOnly\(\): boolean \{/g) ?? []).length === 1,
    `removed=${signatures.filter(([signature, texts]) =>
      guardFirst(withoutGuard(app, signature), signature, texts)).length}, ` +
    `shared=${app.includes('return cursorsLocked({ running: this.running, stopping: this.stopping });')}, ` +
    `derivations=${(app.match(/private cursorReadOnly\(\): boolean \{/g) ?? []).length}`);
}

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const slice = (source: string, from: string, to: string): string => {
    const start = source.indexOf(from);
    if (start < 0) return '';
    const end = source.indexOf(to, start + from.length);
    return end < 0 ? '' : source.slice(start, end);
  };
  const body = slice(app, 'private cursorEdgeRows(): CursorEdgeRowView[] {',
    'private focusCursor(id: number): void {');
  const defersWhileLocked = (source: string): boolean => {
    const lockedAt = source.indexOf('if (locked) {');
    const deferredAt = source.indexOf('result = CURSOR_EDGE_DEFERRED_RESULT;');
    const elseAt = source.indexOf('} else if (');
    const countAt = source.indexOf('countCursorEdges(');
    return source !== '' &&
      source.includes('const locked = this.cursorReadOnly();') &&
      lockedAt >= 0 && deferredAt > lockedAt && elseAt > deferredAt && countAt > elseAt &&
      (source.split('countCursorEdges(').length - 1) === 1;
  };
  check('a locked cursor set defers every edge cell and reaches the counter only when unlocked',
    defersWhileLocked(body),
    `source=${body.length} chars, locked=${body.indexOf('if (locked) {')}, ` +
    `count=${body.indexOf('countCursorEdges(')}, ` +
    `sites=${body.split('countCursorEdges(').length - 1}`);

  const countingWhileLocked = body.replace('result = CURSOR_EDGE_DEFERRED_RESULT;',
    'result = countCursorEdges(this.store, row.channel!, aSample!, bSample!).cell;');
  const armDropped = body.replace(
    'if (locked) {\n        result = CURSOR_EDGE_DEFERRED_RESULT;\n      } else if (', 'if (');
  check('the deferral branch is load-bearing: counting while locked or dropping the arm fails',
    countingWhileLocked !== body && armDropped !== body &&
    !defersWhileLocked(countingWhileLocked) && !defersWhileLocked(armDropped),
    `countingWhileLocked=${defersWhileLocked(countingWhileLocked)}, ` +
    `armDropped=${defersWhileLocked(armDropped)}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
