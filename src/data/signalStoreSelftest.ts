// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Deterministic self-test for the M0 digital SignalStore.
 *
 *   node_modules/.bin/esbuild src/data/signalStoreSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/signalstore-selftest.mjs --log-level=error
 *   node /tmp/signalstore-selftest.mjs
 *
 * It runs as a node entry point (the aggregate runner imports it this way). Every
 * fixture is synthetic and at 4 channels unless a case exists to exercise another
 * underlying store path.
 */

import {
  DigitalSignalStore,
  SignalStoreError,
  UnsupportedRecordError,
  UnsupportedSignalGroupError,
  createDigitalSignalStore,
} from './signalStore.js';
import type { GapReason, SignalStore } from './signalTypes.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import { nodeProcess } from './bench/nodeglobals.js';

export interface SignalStoreTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

function makeStore(channels: ChannelCount = 4, rateHz = 1_000_000): SignalStore {
  return createDigitalSignalStore({ groups: [{ id: 'digital', channels, rateHz }] });
}

/** Device-order bytes for integer sample words, one bit per channel. */
function encode(words: readonly number[], channels: ChannelCount): Uint8Array {
  const bytesPerSample = bytesPerSampleForChannels(channels);
  const out = new Uint8Array(words.length * bytesPerSample);
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    for (let b = 0; b < bytesPerSample; b++) {
      out[i * bytesPerSample + b] = word & 0xff;
      word = Math.floor(word / 256);
    }
  }
  return out;
}

function errorCode(fn: () => void): string {
  try {
    fn();
    return 'none';
  } catch (error) {
    return error instanceof SignalStoreError ? error.code : 'unexpected';
  }
}

export function runSignalStoreSelftest(): SignalStoreTestResult[] {
  const results: SignalStoreTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };
  const checkNumbers = (
    name: string,
    actual: ArrayLike<number>,
    expected: readonly number[],
  ): void => {
    const values = Array.from(actual);
    const pass = values.length === expected.length &&
      values.every((value, i) => value === expected[i]);
    check(
      name,
      pass,
      pass
        ? `[${values.join(',')}]`
        : `got [${values.join(',')}], want [${expected.join(',')}]`,
    );
  };

  check(
    'createDigitalSignalStore returns a DigitalSignalStore',
    makeStore() instanceof DigitalSignalStore,
    'factory result',
  );

  // ---------------------------------------------------------------- columns
  //
  // d0: 0 0 1 1 0 0 1 0 0 0
  // d1: 1 0 1 0 1 0 1 0 1 0
  // d2: 0 1 0 1 0 1 0 1 0 1
  const words = [2, 4, 3, 5, 2, 4, 3, 4, 2, 4];
  const store = makeStore();
  store.append('digital', encode(words.slice(0, 4), 4), 0);
  store.append('digital', encode(words.slice(4), 4), 4);

  check(
    'group and signal metadata match the contract',
    store.groups.length === 1 &&
      store.groups[0]!.start === 0 &&
      store.groups[0]!.channels === 4 &&
      store.groups[0]!.rateHz === 1_000_000 &&
      store.signals.length === 4 &&
      store.signals[0]!.id === 'd0' &&
      store.signals[0]!.index === 0 &&
      store.signals[3]!.id === 'd3',
    `${store.signals.length} signals in ${store.groups.length} group`,
  );

  const columns = store.query('d0', 0, 10, 5);
  const digital = columns.digital!;
  check(
    'query reports the realized integer range and length',
    columns.start === 0 && columns.end === 10 && columns.bins === 5 &&
      columns.status.length === 5 && digital.low.length === 5 &&
      digital.high.length === 5 && digital.edge.length === 5 && digital.packed.length === 5,
    `start=${columns.start} end=${columns.end} bins=${columns.bins}`,
  );
  checkNumbers('d0 low per bin', digital.low, [0, 1, 0, 0, 0]);
  checkNumbers('d0 high per bin', digital.high, [0, 1, 0, 1, 0]);
  checkNumbers('d0 edge per bin', digital.edge, [0, 1, 1, 1, 0]);
  checkNumbers('d0 status per bin', columns.status, [0, 0, 0, 0, 0]);
  checkNumbers('d0 packed (high | low<<1 | edge<<2)', digital.packed, [0, 7, 4, 5, 0]);

  const d1 = store.query('d1', 0, 10, 5).digital!;
  checkNumbers('d1 low per bin', d1.low, [0, 0, 0, 0, 0]);
  checkNumbers('d1 high per bin', d1.high, [1, 1, 1, 1, 1]);
  checkNumbers('d1 edge per bin', d1.edge, [1, 1, 1, 1, 1]);

  // One bin per sample: column i starts exactly on the transition at i.
  const perSample = store.query('d0', 0, 10, 10).digital!;
  checkNumbers(
    'edge at a column boundary is attributed to the entering column',
    perSample.edge,
    [0, 0, 1, 0, 1, 0, 1, 1, 0, 0],
  );

  // ---------------------------------------------------------------- sample
  checkNumbers(
    'sample returns the digital level',
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => store.sample('d0', i) ?? -1),
    [0, 0, 1, 1, 0, 0, 1, 0, 0, 0],
  );
  checkNumbers(
    'sample on a second channel',
    [0, 1, 2, 3, 4, 5].map((i) => store.sample('d1', i) ?? -1),
    [1, 0, 1, 0, 1, 0],
  );
  check(
    'sample is null outside [retainedFrom, newest)',
    store.sample('d0', 10) === null && store.sample('d0', -1) === null,
    `10=${String(store.sample('d0', 10))} -1=${String(store.sample('d0', -1))}`,
  );
  check(
    'sample rejects a non-integer position',
    errorCode(() => { store.sample('d0', 1.5); }) === 'invalid-position',
    '1.5',
  );
  check(
    'newest and retainedFrom start per contract',
    store.newest['digital'] === 10 && store.retainedFrom === 0,
    `newest=${String(store.newest['digital'])} retainedFrom=${store.retainedFrom}`,
  );

  // A 16-channel word exercises the interleaved underlying store and checks that a
  // group-local index reaches the intended bit (d15 is bit 15 of a 2-byte sample).
  const wideStore = makeStore(16);
  wideStore.append('digital', encode([0x8000, 0], 16), 0);
  const wideColumn = wideStore.query('d15', 0, 2, 1).digital!;
  check(
    '16-channel chunks map signal index to the underlying store channel',
    wideColumn.high[0] === 1 && wideColumn.low[0] === 0 &&
      wideStore.sample('d15', 0) === 1 && wideStore.sample('d14', 0) === 0,
    `d15.high=${wideColumn.high[0]} d15.sample=${String(wideStore.sample('d15', 0))}`,
  );

  // ---------------------------------------------------------------- pending
  const pending = store.query('d0', 0, 20, 10);
  checkNumbers('status is pending beyond newest', pending.status, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
  check(
    'pending columns carry best-effort zero bits and no gap bit',
    pending.digital!.high[9] === 0 && pending.digital!.low[9] === 0 &&
      pending.digital!.edge[9] === 0 && (pending.digital!.packed[9]! & 8) === 0,
    `packed[9]=${pending.digital!.packed[9]}`,
  );
  check(
    'query does not clamp the realized range to newest',
    pending.start === 0 && pending.end === 20,
    `start=${pending.start} end=${pending.end}`,
  );
  checkNumbers(
    'a query wholly beyond newest is all pending',
    store.query('d0', 10, 20, 5).status,
    [1, 1, 1, 1, 1],
  );

  // ---------------------------------------------------------------- gaps
  const gapStore = makeStore();
  const alternating = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
  gapStore.append('digital', encode(alternating, 4), 0);
  gapStore.noteGap({ group: 'digital', start: 2, end: 6, reason: 'dropout' });

  const gapColumns = gapStore.query('d0', 0, 10, 5);
  checkNumbers('status marks columns overlapping a noteGap', gapColumns.status, [0, 2, 2, 0, 0]);
  check(
    'gap columns set packed bit3',
    (gapColumns.digital!.packed[1]! & 8) !== 0 &&
      (gapColumns.digital!.packed[2]! & 8) !== 0 &&
      (gapColumns.digital!.packed[3]! & 8) === 0,
    `packed=${Array.from(gapColumns.digital!.packed).join(',')}`,
  );
  check(
    'sample is null inside a gap and known at its end',
    gapStore.sample('d0', 1) === 1 &&
      gapStore.sample('d0', 2) === null &&
      gapStore.sample('d0', 3) === null &&
      gapStore.sample('d0', 4) === null &&
      gapStore.sample('d0', 5) === null &&
      gapStore.sample('d0', 6) === 0,
    `1=${String(gapStore.sample('d0', 1))} 5=${String(gapStore.sample('d0', 5))} ` +
    `6=${String(gapStore.sample('d0', 6))}`,
  );
  checkNumbers(
    'edges never report a transition strictly inside a gap',
    gapStore.edges('d0', 0, 10),
    [1, 6, 7, 8, 9],
  );
  const noted = gapStore.gaps();
  check(
    'gaps() returns the span and its reason',
    noted.length === 1 && noted[0]!.start === 2 && noted[0]!.end === 6 &&
      noted[0]!.reason === 'dropout' && noted[0]!.group === 'digital',
    JSON.stringify(noted),
  );

  gapStore.noteGap({ group: 'digital', start: 5, end: 8, reason: 'overrun' });
  const merged = gapStore.gaps();
  check(
    'overlapping gap notes merge and keep the leftmost reason',
    merged.length === 1 && merged[0]!.start === 2 && merged[0]!.end === 8 &&
      merged[0]!.reason === 'dropout',
    JSON.stringify(merged),
  );
  gapStore.noteGap({ group: 'digital', start: 8, end: 9, reason: 'suspend' });
  const touching = gapStore.gaps();
  check(
    'touching gap notes merge too',
    touching.length === 1 && touching[0]!.start === 2 && touching[0]!.end === 9,
    JSON.stringify(touching),
  );

  // Signal-specific notes affect only that signal.
  const specific = makeStore();
  const bothLow = alternating.map((value) => value | (value << 1));
  specific.append('digital', encode(bothLow, 4), 0);
  specific.noteGap({ group: 'digital', signal: 'd1', start: 2, end: 6, reason: 'overrun' });
  checkNumbers(
    'a signal-specific gap leaves other signals ok',
    specific.query('d0', 0, 10, 5).status,
    [0, 0, 0, 0, 0],
  );
  checkNumbers(
    'a signal-specific gap marks that signal',
    specific.query('d1', 0, 10, 5).status,
    [0, 2, 2, 0, 0],
  );
  check(
    'sample applies the gap per signal',
    specific.sample('d0', 3) === 1 && specific.sample('d1', 3) === null,
    `d0=${String(specific.sample('d0', 3))} d1=${String(specific.sample('d1', 3))}`,
  );
  checkNumbers(
    'edges filter the gap per signal',
    specific.edges('d1', 0, 10),
    [1, 6, 7, 8, 9],
  );
  check(
    'edges on the unaffected signal are complete',
    specific.edges('d0', 0, 10).length === 9,
    `${specific.edges('d0', 0, 10).length} edges`,
  );
  check(
    'gaps() preserves the signal scope',
    specific.gaps().length === 1 && specific.gaps()[0]!.signal === 'd1',
    JSON.stringify(specific.gaps()),
  );

  check(
    'a gap past newest is rejected',
    errorCode(() => {
      gapStore.noteGap({ group: 'digital', start: 8, end: 30, reason: 'dropout' });
    }) === 'gap-out-of-range',
    'end=30, newest=10',
  );
  check(
    'a gap with unknown group or signal is rejected',
    errorCode(() => {
      gapStore.noteGap({ group: 'other', start: 0, end: 1, reason: 'dropout' });
    }) === 'unknown-group' &&
      errorCode(() => {
        gapStore.noteGap({ group: 'digital', signal: 'd9', start: 0, end: 1, reason: 'dropout' });
      }) === 'unknown-signal',
    'group and signal validation',
  );
  check(
    'a gap with inverted bounds or an unknown reason is rejected',
    errorCode(() => {
      gapStore.noteGap({ group: 'digital', start: 5, end: 2, reason: 'dropout' });
    }) === 'gap-invalid' &&
      errorCode(() => {
        gapStore.noteGap({
          group: 'digital', start: 0, end: 1, reason: 'nonsense' as GapReason,
        });
      }) === 'gap-invalid',
    'bounds and reason validation',
  );

  // ---------------------------------------------------------------- dropBefore
  const rising = Array.from({ length: 256 }, (_, i) => i & 1);
  const dropped = makeStore();
  dropped.append('digital', encode(rising.slice(0, 128), 4), 0);
  dropped.append('digital', encode(rising.slice(128), 4), 128);
  dropped.noteGap({ group: 'digital', start: 60, end: 70, reason: 'suspend' });
  dropped.dropBefore(64 / 1_000_000);
  check(
    'dropBefore advances retainedFrom and keeps newest fixed',
    dropped.retainedFrom === 64 / 1_000_000 && dropped.newest['digital'] === 256,
    `retainedFrom=${dropped.retainedFrom} newest=${String(dropped.newest['digital'])}`,
  );
  check(
    'dropBefore drops samples before the new left edge',
    // 64 is the new left edge but also inside the clamped gap; 70 is the first known
    // sample after that gap.
    dropped.sample('d0', 63) === null &&
      dropped.sample('d0', 64) === null &&
      dropped.sample('d0', 70) === 0,
    `63=${String(dropped.sample('d0', 63))} 64=${String(dropped.sample('d0', 64))} ` +
    `70=${String(dropped.sample('d0', 70))}`,
  );
  check(
    'dropBefore clamps a partially evicted gap',
    dropped.gaps().length === 1 && dropped.gaps()[0]!.start === 64 &&
      dropped.gaps()[0]!.end === 70,
    JSON.stringify(dropped.gaps()),
  );
  checkNumbers(
    'query reports evicted and gap columns as unknown',
    dropped.query('d0', 0, 256, 8).status,
    [2, 2, 2, 0, 0, 0, 0, 0],
  );

  dropped.dropBefore(128 / 1_000_000);
  check(
    'a second dropBefore advances again and evicts the old gap',
    dropped.retainedFrom === 128 / 1_000_000 && dropped.gaps().length === 0 &&
      dropped.sample('d0', 127) === null && dropped.sample('d0', 128) === 0,
    `retainedFrom=${dropped.retainedFrom} gaps=${dropped.gaps().length}`,
  );
  checkNumbers(
    'the eviction boundary moves with retainedFrom',
    dropped.query('d0', 0, 256, 8).status,
    [2, 2, 2, 2, 0, 0, 0, 0],
  );

  dropped.dropBefore(300 / 1_000_000);
  check(
    'dropBefore past newest drains the window without moving newest',
    dropped.retainedFrom === 256 / 1_000_000 && dropped.newest['digital'] === 256 &&
      dropped.sample('d0', 255) === null,
    `retainedFrom=${dropped.retainedFrom} newest=${String(dropped.newest['digital'])}`,
  );
  checkNumbers(
    'query after draining reports evicted columns',
    dropped.query('d0', 0, 256, 8).status,
    [2, 2, 2, 2, 2, 2, 2, 2],
  );
  checkNumbers(
    'positions after the drained window are pending',
    dropped.query('d0', 256, 260, 2).status,
    [1, 1],
  );
  dropped.append('digital', encode([0, 1, 1, 0], 4), 256);
  check(
    'append continues at the unchanged absolute newest after a full drop',
    dropped.newest['digital'] === 260 &&
      dropped.sample('d0', 256) === 0 &&
      dropped.sample('d0', 257) === 1 &&
      dropped.sample('d0', 259) === 0 &&
      dropped.sample('d0', 260) === null,
    `newest=${String(dropped.newest['digital'])}`,
  );

  const partial = makeStore();
  partial.append('digital', encode(new Array<number>(256).fill(0), 4), 0);
  partial.dropBefore(10.5 / 1_000_000);
  check(
    'dropBefore rounds up to the next drop quantum',
    partial.retainedFrom === 64 / 1_000_000 &&
      partial.sample('d0', 63) === null && partial.sample('d0', 64) === 0,
    `retainedFrom=${partial.retainedFrom}`,
  );
  check(
    'dropBefore rejects non-finite seconds',
    errorCode(() => { partial.dropBefore(Number.NaN); }) === 'invalid-position',
    'NaN',
  );

  // ---------------------------------------------------------------- append validation
  const invalid = makeStore();
  invalid.append('digital', encode([0, 0, 0, 0], 4), 0);
  check(
    'an overlapping append is rejected',
    errorCode(() => { invalid.append('digital', encode([0], 4), 2); }) === 'overlap',
    'start=2, newest=4',
  );
  check(
    'a non-contiguous append is rejected',
    errorCode(() => { invalid.append('digital', encode([0], 4), 8); }) === 'non-contiguous',
    'start=8, newest=4',
  );
  check(
    'a fractional or negative append start is rejected',
    errorCode(() => { invalid.append('digital', encode([0], 4), 1.5); }) === 'invalid-position' &&
      errorCode(() => { invalid.append('digital', encode([0], 4), -1); }) === 'invalid-position',
    '1.5 and -1',
  );
  check(
    'an append to an unknown group is rejected',
    errorCode(() => { invalid.append('analog', encode([0], 4), 4); }) === 'unknown-group',
    'group=analog',
  );
  const wide = makeStore(16);
  check(
    'a partial sample at the end of a chunk is rejected',
    errorCode(() => { wide.append('digital', new Uint8Array(3), 0); }) === 'invalid-chunk',
    '3 bytes for 2-byte samples',
  );
  check(
    'unknown signal ids are rejected by every read path',
    errorCode(() => { invalid.query('d9', 0, 4, 2); }) === 'unknown-signal' &&
      errorCode(() => { invalid.sample('d9', 0); }) === 'unknown-signal' &&
      errorCode(() => { invalid.edges('d9', 0, 4); }) === 'unknown-signal',
    'd9 on a 4-channel store',
  );

  let secondGroupError: unknown;
  try {
    createDigitalSignalStore({
      groups: [
        { id: 'a', channels: 4, rateHz: 1_000_000 },
        { id: 'b', channels: 4, rateHz: 2_000_000 },
      ],
    });
  } catch (error) {
    secondGroupError = error;
  }
  check(
    'a second group is refused with a typed error',
    secondGroupError instanceof UnsupportedSignalGroupError &&
      secondGroupError.code === 'group-limit',
    secondGroupError instanceof Error ? secondGroupError.message : 'no error',
  );
  check(
    'zero groups are refused',
    errorCode(() => { createDigitalSignalStore({ groups: [] }); }) === 'group-limit',
    'groups=[]',
  );

  // ---------------------------------------------------------------- boundary edge
  const boundary = makeStore();
  boundary.append('digital', encode([1, 1, 0, 0], 4), 0);
  const boundaryDigital = boundary.query('d0', 0, 4, 2).digital!;
  checkNumbers(
    'a falling edge on a column boundary has edge=1 with low=high=0',
    [boundaryDigital.low[1]!, boundaryDigital.high[1]!, boundaryDigital.edge[1]!],
    [0, 0, 1],
  );
  checkNumbers(
    'edges() includes the column-boundary transition',
    boundary.edges('d0', 0, 4),
    [2],
  );

  // ---------------------------------------------------------------- record
  const recordStore = makeStore();
  check(
    'M0 record controller is off with zero bytes',
    recordStore.record.state === 'off' && recordStore.record.bytes === 0,
    `state=${recordStore.record.state} bytes=${recordStore.record.bytes}`,
  );
  let recordError: unknown;
  try {
    recordStore.record.arm();
  } catch (error) {
    recordError = error;
  }
  check(
    'record.arm() refuses with a typed unsupported error',
    recordError instanceof UnsupportedRecordError && recordError.code === 'record-unsupported',
    recordError instanceof Error ? recordError.message : 'no error',
  );

  return results;
}

// Run as a node entry point, matching src/data/bench/runtests.ts.
const results = runSignalStoreSelftest();
for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`);
}
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess().exit(failed === 0 ? 0 : 1);
