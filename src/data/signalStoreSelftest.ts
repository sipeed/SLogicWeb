// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Deterministic self-test for the M1 multi-group SignalStore.
 *
 *   node_modules/.bin/esbuild src/data/signalStoreSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/signalstore-selftest.mjs --log-level=error
 *   node /tmp/signalstore-selftest.mjs
 *
 * It runs as a node entry point (the aggregate runner imports it this way). Every
 * fixture is synthetic. Digital fixtures use 4 channels unless a case exists to
 * exercise another underlying store path; analog fixtures use calibrated Float32 values
 * encoded exactly as the device adapter delivers them.
 */

import {
  DigitalSignalStore,
  SignalStoreError,
  UnsupportedRecordController,
  UnsupportedRecordError,
  UnsupportedSignalGroupError,
  createDigitalSignalStore,
} from './signalStore.js';
import { OpfsRecordController } from './recordController.js';
import type { RecordProfile, RecordStorage } from './opfsRecord.js';
import type { GapReason } from './signalTypes.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import { nodeProcess } from './bench/nodeglobals.js';

export interface SignalStoreTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

function makeStore(channels: ChannelCount = 4, rateHz = 1_000_000): DigitalSignalStore {
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

/** Interleaved little-endian Float32 frames, the analog `append()` chunk format. */
function encodeAnalog(frames: readonly (readonly number[])[]): Uint8Array {
  const channels = frames[0]?.length ?? 1;
  const out = new Uint8Array(frames.length * channels * 4);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const frame of frames) {
    for (let ch = 0; ch < channels; ch++) {
      view.setFloat32(offset, frame[ch] ?? 0, true);
      offset += 4;
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

/**
 * Storage stub for construction-only checks. Building the controller must not perform
 * any I/O; only `arm()` does, and these synchronous tests never arm.
 */
const unopenedRecordStorage: RecordStorage = {
  open: async () => {
    throw new Error('record storage was opened during a construction-only test');
  },
  list: async () => [],
  remove: async () => {},
  rename: async () => {},
};

function digitalRecordProfile(channels: number, rateHz = 1_000_000): RecordProfile {
  return {
    profileId: 'selftest',
    calibrationId: null,
    channels,
    sampleRateHz: rateHz,
    bytesPerSample: bytesPerSampleForChannels(channels),
  };
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
    'edges never report a transition at or inside a gap boundary',
    gapStore.edges('d0', 0, 10),
    [1, 7, 8, 9],
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
    [1, 7, 8, 9],
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

  gapStore.noteGap({ group: 'digital', start: 8, end: 30, reason: 'overrun' });
  const watermark = gapStore.gaps();
  check(
    'a gap may extend past newest as a pending watermark',
    watermark.length === 1 && watermark[0]!.start === 2 && watermark[0]!.end === 30 &&
      watermark[0]!.reason === 'dropout',
    JSON.stringify(watermark),
  );
  checkNumbers(
    'a pending watermark reports GAP where data is not yet known',
    gapStore.query('d0', 10, 30, 2).status,
    [2, 2],
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

  let zeroGroupsError: unknown;
  try {
    createDigitalSignalStore({ groups: [] });
  } catch (error) {
    zeroGroupsError = error;
  }
  check(
    'zero groups are refused with a typed error',
    zeroGroupsError instanceof UnsupportedSignalGroupError &&
      zeroGroupsError.code === 'group-limit',
    zeroGroupsError instanceof Error ? zeroGroupsError.message : 'no error',
  );
  check(
    'duplicate group ids are refused',
    errorCode(() => {
      createDigitalSignalStore({
        groups: [
          { id: 'same', channels: 4, rateHz: 1_000_000 },
          { id: 'same', channels: 4, rateHz: 2_000_000, start: 4 },
        ],
      });
    }) === 'invalid-group',
    'same id twice',
  );
  check(
    'overlapping same-kind channel ranges are refused instead of remapping ids',
    errorCode(() => {
      createDigitalSignalStore({
        groups: [
          { id: 'a', channels: 4, rateHz: 1_000_000 },
          { id: 'b', channels: 4, rateHz: 2_000_000 },
        ],
      });
    }) === 'invalid-group',
    'both groups emit d0..d3',
  );

  // ---------------------------------------------------------------- multiple digital groups
  //
  // slow: d0..d3 at 1 MHz starting at position 0
  // fast: d8..d15 at 2 MHz starting at position 40 (its own origin)
  const multi = createDigitalSignalStore({
    groups: [
      { id: 'slow', channels: 4, rateHz: 1_000_000 },
      { id: 'fast', channels: 8, rateHz: 2_000_000, start: 8 },
    ],
  });
  // Append the higher-rate group first, at a nonzero position: nothing may assume the
  // two groups' indices line up.
  multi.append('fast', encode([1, 0, 1, 0, 1], 8), 40);
  multi.append('slow', encode([0, 1, 1, 1], 4), 0);
  check(
    'multiple groups expose independent channel ranges and signal ids',
    multi.groups.length === 2 && multi.signals.length === 12 &&
      multi.signals.some((signal) => signal.id === 'd0') &&
      multi.signals.some((signal) => signal.id === 'd15') &&
      multi.signals.every((signal) => signal.kind === 'digital'),
    `${multi.groups.length} groups, ${multi.signals.length} signals`,
  );
  check(
    'per-group origins and newest positions are independent',
    multi.originOf('slow') === 0 && multi.originOf('fast') === 40 &&
      multi.newest['slow'] === 4 && multi.newest['fast'] === 45 &&
      multi.origin === 0,
    `origins=${multi.originOf('slow')},${multi.originOf('fast')} ` +
    `newest=${String(multi.newest['slow'])},${String(multi.newest['fast'])}`,
  );
  check(
    'retainedFrom is the latest per-group left edge',
    multi.retainedFromOf('slow') === 0 &&
      multi.retainedFromOf('fast') === 40 / 2_000_000 &&
      multi.retainedFrom === 40 / 2_000_000,
    `slow=${multi.retainedFromOf('slow')} fast=${multi.retainedFromOf('fast')}`,
  );
  checkNumbers(
    'a group is queried in its own position space',
    [0, 1, 2, 3].map((position) => multi.sample('d0', position) ?? -1),
    [0, 1, 1, 1],
  );
  checkNumbers(
    'the second group samples at its own positions',
    [40, 41, 42, 43, 44].map((position) => multi.sample('d8', position) ?? -1),
    [1, 0, 1, 0, 1],
  );
  check(
    'the second group maps its top channel',
    multi.sample('d15', 40) === 0 && multi.sample('d9', 40) === 0,
    `d15=${String(multi.sample('d15', 40))}`,
  );
  checkNumbers(
    'positions before a group origin are GAP without affecting the other group',
    multi.query('d8', 0, 45, 9).status,
    [2, 2, 2, 2, 2, 2, 2, 2, 0],
  );
  checkNumbers(
    'the first group is entirely known where appended',
    multi.query('d0', 0, 4, 4).status,
    [0, 0, 0, 0],
  );

  multi.noteGap({ group: 'slow', start: 1, end: 3, reason: 'dropout' });
  checkNumbers(
    'a gap belongs to one group only',
    multi.query('d0', 0, 4, 4).status,
    [0, 2, 2, 0],
  );
  checkNumbers(
    'another group is unaffected by that gap',
    multi.query('d8', 40, 45, 5).status,
    [0, 0, 0, 0, 0],
  );
  check(
    'gaps() carries the owning group id',
    multi.gaps().length === 1 && multi.gaps()[0]!.group === 'slow',
    JSON.stringify(multi.gaps()),
  );
  check(
    'a signal from another group cannot be used to scope a gap',
    errorCode(() => {
      multi.noteGap({ group: 'slow', signal: 'd8', start: 0, end: 1, reason: 'dropout' });
    }) === 'unknown-signal',
    'd8 belongs to fast',
  );

  // Retention and maxSamples are per group: filling one group must not consume the
  // other's budget, and "full" is reported by the offending group only.
  const boundedGroups = createDigitalSignalStore({
    groups: [
      { id: 'a', channels: 4, rateHz: 1_000_000, maxSamples: 4 },
      { id: 'b', channels: 4, rateHz: 2_000_000, start: 4, maxSamples: 8 },
    ],
  });
  boundedGroups.append('a', encode([0, 0, 0, 0], 4), 0);
  boundedGroups.append('b', encode([0, 0, 0, 0], 4), 0);
  check(
    'maxSamples is enforced per group',
    errorCode(() => { boundedGroups.append('a', encode([0], 4), 4); }) === 'store-full',
    'group a at 4/4',
  );
  boundedGroups.append('b', encode([0, 0, 0, 0], 4), 4);
  check(
    'a full group does not consume another group\'s retention budget',
    boundedGroups.newest['b'] === 8 &&
      errorCode(() => { boundedGroups.append('b', encode([0], 4), 8); }) === 'store-full',
    `b newest=${String(boundedGroups.newest['b'])}`,
  );

  // A single-group store keeps the M0 surface exactly: one group, origin 0, one newest.
  const regression = makeStore();
  regression.append('digital', encode([0, 1], 4), 0);
  check(
    'single-group behavior survives the multi-group refactor',
    regression.groups.length === 1 && regression.origin === 0 &&
      regression.retainedFrom === 0 && regression.retainedFromOf('digital') === 0 &&
      Object.keys(regression.newest).length === 1 && regression.newest['digital'] === 2,
    JSON.stringify(regression.newest),
  );

  // ---------------------------------------------------------------- analog groups
  const analog = createDigitalSignalStore({
    groups: [{ kind: 'analog', id: 'analog', channels: 2, rateHz: 1_000_000 }],
  });
  // a0: 0..7   a1: 10..17
  analog.append('analog', encodeAnalog([
    [0, 10], [1, 11], [2, 12], [3, 13], [4, 14], [5, 15], [6, 16], [7, 17],
  ]), 0);
  check(
    'analog groups expose a-signals with calibrated kind',
    analog.signals.length === 2 && analog.signals[0]!.id === 'a0' &&
      analog.signals[1]!.id === 'a1' && analog.signals[0]!.kind === 'analog' &&
      analog.signals[0]!.name === 'A0',
    JSON.stringify(analog.signals),
  );
  check(
    'analog append decodes interleaved Float32 volts',
    analog.newest['analog'] === 8 &&
      analog.sample('a0', 5) === 5 && analog.sample('a1', 5) === 15,
    `newest=${String(analog.newest['analog'])} a0=${String(analog.sample('a0', 5))} ` +
    `a1=${String(analog.sample('a1', 5))}`,
  );
  const analogColumns = analog.query('a0', 0, 8, 2);
  check(
    'an analog query returns min/max/mean and no digital columns',
    analogColumns.start === 0 && analogColumns.end === 8 && analogColumns.bins === 2 &&
      analogColumns.analog !== undefined && analogColumns.digital === undefined &&
      analogColumns.analog.min.length === 2 && analogColumns.analog.max.length === 2 &&
      analogColumns.analog.mean.length === 2,
    `start=${analogColumns.start} end=${analogColumns.end}`,
  );
  checkNumbers('a0 status per bin', analogColumns.status, [0, 0]);
  checkNumbers('a0 analog min per bin', analogColumns.analog!.min, [0, 4]);
  checkNumbers('a0 analog max per bin', analogColumns.analog!.max, [3, 7]);
  checkNumbers('a0 analog mean per bin', analogColumns.analog!.mean, [1.5, 5.5]);
  const analogSecond = analog.query('a1', 0, 8, 2).analog!;
  checkNumbers('a1 analog min per bin', analogSecond.min, [10, 14]);
  checkNumbers('a1 analog max per bin', analogSecond.max, [13, 17]);
  checkNumbers('a1 analog mean per bin', analogSecond.mean, [11.5, 15.5]);

  // Multi-channel ring: grow, wrap, drop and grow again. The second channel is offset
  // by a large constant so a channel-stride bug cannot hide behind channel 0.
  const analogRing = createDigitalSignalStore({
    groups: [{ kind: 'analog', id: 'ana', channels: 2, rateHz: 1_000_000 }],
  });
  const ringFrames = Array.from({ length: 4000 }, (_, i) => [i, i + 100_000]);
  analogRing.append('ana', encodeAnalog(ringFrames.slice(0, 2000)), 0);
  analogRing.dropBefore(512 / 1_000_000);
  analogRing.append('ana', encodeAnalog(ringFrames.slice(2000, 2048)), 2000);
  analogRing.append('ana', encodeAnalog(ringFrames.slice(2048, 2148)), 2048);
  analogRing.append('ana', encodeAnalog(ringFrames.slice(2148)), 2148);
  check(
    'multi-channel analog survives ring growth, wrap and a drop',
    analogRing.newest['ana'] === 4000 &&
      analogRing.sample('a0', 512) === 512 &&
      analogRing.sample('a1', 512) === 100_512 &&
      analogRing.sample('a0', 2047) === 2047 &&
      analogRing.sample('a1', 2047) === 102_047 &&
      analogRing.sample('a0', 2048) === 2048 &&
      analogRing.sample('a1', 3999) === 103_999,
    `newest=${String(analogRing.newest['ana'])} ` +
    `a0@512=${String(analogRing.sample('a0', 512))} ` +
    `a1@3999=${String(analogRing.sample('a1', 3999))}`,
  );
  const ringColumn = analogRing.query('a1', 512, 4000, 1).analog!;
  checkNumbers('a multi-channel analog summary keeps its channel values', ringColumn.min, [100_512]);
  checkNumbers('a multi-channel analog summary keeps its maxima', ringColumn.max, [103_999]);
  checkNumbers('a multi-channel analog summary keeps its mean', ringColumn.mean, [102_255.5]);

  // The pyramid's top levels only matter for ranges wider than their blocks; use a
  // 20k-sample arithmetic ramp so min/max/mean are known in closed form.
  const analogWide = createDigitalSignalStore({
    groups: [{ kind: 'analog', id: 'ana', channels: 1, rateHz: 1_000_000 }],
  });
  analogWide.append('ana', encodeAnalog(
    Array.from({ length: 20_000 }, (_, i) => [i - 10_000]),
  ), 0);
  const wideWhole = analogWide.query('a0', 0, 20_000, 1).analog!;
  checkNumbers('analog summaries cover ranges wider than a top-level block (min)', wideWhole.min, [-10_000]);
  checkNumbers('analog summaries cover ranges wider than a top-level block (max)', wideWhole.max, [9_999]);
  checkNumbers('analog summaries cover ranges wider than a top-level block (mean)', wideWhole.mean, [-0.5]);
  const wideHalves = analogWide.query('a0', 0, 20_000, 2).analog!;
  checkNumbers('a wide analog range splits correctly (min)', wideHalves.min, [-10_000, 0]);
  checkNumbers('a wide analog range splits correctly (max)', wideHalves.max, [-1, 9_999]);
  checkNumbers('a wide analog range splits correctly (mean)', wideHalves.mean, [-5_000.5, 4_999.5]);

  const analogPending = analog.query('a0', 8, 12, 2);
  checkNumbers('analog positions past newest are pending', analogPending.status, [1, 1]);
  check(
    'pending analog bins report NaN, not zero volts',
    analogPending.analog!.min.every((value) => Number.isNaN(value)) &&
      analogPending.analog!.max.every((value) => Number.isNaN(value)) &&
      analogPending.analog!.mean.every((value) => Number.isNaN(value)),
    `min=[${Array.from(analogPending.analog!.min)}]`,
  );

  analog.noteGap({ group: 'analog', signal: 'a1', start: 2, end: 6, reason: 'overrun' });
  checkNumbers(
    'an analog signal-specific gap leaves the other analog signal known',
    analog.query('a0', 0, 8, 4).status,
    [0, 0, 0, 0],
  );
  checkNumbers(
    'an analog signal-specific gap marks only that signal',
    analog.query('a1', 0, 8, 4).status,
    [0, 2, 2, 0],
  );
  check(
    'analog sample honors a per-signal gap',
    analog.sample('a0', 3) === 3 && analog.sample('a1', 3) === null,
    `a0=${String(analog.sample('a0', 3))} a1=${String(analog.sample('a1', 3))}`,
  );
  check(
    'analog edges are empty; analog signals have no digital transitions',
    analog.edges('a0', 0, 8).length === 0,
    'edges a0',
  );

  analog.noteGap({ group: 'analog', start: 8, end: 12, reason: 'dropout' });
  const analogWatermark = analog.query('a0', 8, 12, 2);
  checkNumbers('an analog pending watermark reports GAP', analogWatermark.status, [2, 2]);
  check(
    'an analog gap bin reports NaN when it has no known samples',
    analogWatermark.analog!.min.every((value) => Number.isNaN(value)),
    `min=[${Array.from(analogWatermark.analog!.min)}]`,
  );
  check(
    'known analog bins are unchanged by later gaps',
    analog.query('a0', 0, 8, 2).analog!.mean[0] === 1.5,
    `mean0=${analog.query('a0', 0, 8, 2).analog!.mean[0]}`,
  );

  const analogOrigin = createDigitalSignalStore({
    groups: [{ kind: 'analog', id: 'ana', channels: 1, rateHz: 1_000_000 }],
  });
  analogOrigin.append('ana', encodeAnalog([[1], [2], [3], [4]]), 10);
  check(
    'an analog group fixes its origin at the first append',
    analogOrigin.originOf('ana') === 10 && analogOrigin.newest['ana'] === 14 &&
      analogOrigin.retainedFromOf('ana') === 10 / 1_000_000 &&
      analogOrigin.sample('a0', 9) === null && analogOrigin.sample('a0', 10) === 1 &&
      analogOrigin.sample('a0', 13) === 4,
    `origin=${analogOrigin.originOf('ana')} newest=${String(analogOrigin.newest['ana'])}`,
  );
  checkNumbers(
    'analog positions before the origin are GAP',
    analogOrigin.query('a0', 0, 14, 7).status,
    [2, 2, 2, 2, 2, 0, 0],
  );

  // Analog filler for a gap-covered skip stays unknown and still costs budget.
  const analogFiller = createDigitalSignalStore({
    groups: [{ kind: 'analog', id: 'ana', channels: 1, rateHz: 1_000_000 }],
  });
  analogFiller.append('ana', encodeAnalog([[0], [1]]), 0);
  analogFiller.noteGap({ group: 'ana', start: 2, end: 4, reason: 'overrun' });
  analogFiller.append('ana', encodeAnalog([[2], [3]]), 4);
  check(
    'an analog append after a covered skip pads the gap without inventing data',
    analogFiller.newest['ana'] === 6 && analogFiller.sample('a0', 2) === null &&
      analogFiller.sample('a0', 3) === null && analogFiller.sample('a0', 4) === 2,
    `newest=${String(analogFiller.newest['ana'])} ` +
    `2=${String(analogFiller.sample('a0', 2))} 4=${String(analogFiller.sample('a0', 4))}`,
  );
  checkNumbers(
    'analog filler positions remain GAP in a query',
    analogFiller.query('a0', 0, 6, 6).status,
    [0, 0, 2, 2, 0, 0],
  );
  check(
    'analog filler sample values never leak as known volts',
    analogFiller.query('a0', 2, 4, 1).analog!.min.every((value) => Number.isNaN(value)),
    `min=[${Array.from(analogFiller.query('a0', 2, 4, 1).analog!.min)}]`,
  );

  const smallAnalog = createDigitalSignalStore({
    groups: [{ kind: 'analog', id: 'ana', channels: 1, rateHz: 1_000_000, maxSamples: 4 }],
  });
  smallAnalog.append('ana', encodeAnalog([[0], [1], [2], [3]]), 0);
  check(
    'analog retention is bounded by maxSamples',
    errorCode(() => { smallAnalog.append('ana', encodeAnalog([[4]]), 4); }) === 'store-full',
    '4 retained + 1',
  );
  const smallAnalogGap = createDigitalSignalStore({
    groups: [{ kind: 'analog', id: 'ana', channels: 1, rateHz: 1_000_000, maxSamples: 4 }],
  });
  smallAnalogGap.append('ana', encodeAnalog([[0], [1]]), 0);
  smallAnalogGap.noteGap({ group: 'ana', start: 2, end: 4, reason: 'dropout' });
  check(
    'analog filler counts against maxSamples',
    errorCode(() => { smallAnalogGap.append('ana', encodeAnalog([[2]]), 4); }) === 'store-full',
    '2 retained + 2 filler + 1',
  );
  check(
    'an analog chunk that splits a Float32 sample is rejected',
    errorCode(() => {
      createDigitalSignalStore({
        groups: [{ kind: 'analog', id: 'ana', channels: 2, rateHz: 1_000_000 }],
      }).append('ana', new Uint8Array(6), 0);
    }) === 'invalid-chunk',
    '6 bytes for 8-byte frames',
  );
  check(
    'analog append still enforces overlap and contiguity',
    errorCode(() => { analogOrigin.append('ana', encodeAnalog([[0]]), 12); }) === 'overlap' &&
      errorCode(() => { analogOrigin.append('ana', encodeAnalog([[0]]), 20); }) === 'non-contiguous',
    'overlap at 12, skip to 20',
  );
  check(
    'analog sample rejects a non-integer position',
    errorCode(() => { analog.sample('a0', 1.5); }) === 'invalid-position',
    '1.5',
  );

  // ---------------------------------------------------------------- multi-rate drop
  //
  // The same canonical time maps to different sample counts. dropBefore must convert
  // per group rather than dropping one index count across both.
  const mixed = createDigitalSignalStore({
    groups: [
      { id: 'dig', channels: 4, rateHz: 1_000_000 },
      { kind: 'analog', id: 'ana', channels: 1, rateHz: 2_000_000 },
    ],
  });
  mixed.append('dig', encode(new Array<number>(256).fill(0), 4), 0);
  mixed.append('ana', encodeAnalog(Array.from({ length: 256 }, (_, i) => [i])), 0);
  mixed.dropBefore(10 / 1_000_000);
  check(
    'dropBefore converts seconds to each group rate and rounds up per group',
    mixed.retainedFromOf('dig') === 64 / 1_000_000 &&
      mixed.retainedFromOf('ana') === 64 / 2_000_000 &&
      mixed.retainedFrom === 64 / 1_000_000 &&
      mixed.newest['dig'] === 256 && mixed.newest['ana'] === 256,
    `dig=${mixed.retainedFromOf('dig')} ana=${mixed.retainedFromOf('ana')}`,
  );
  check(
    'multi-rate drops never renumber absolute positions',
    mixed.sample('d0', 63) === null && mixed.sample('d0', 64) === 0 &&
      mixed.sample('a0', 63) === null && mixed.sample('a0', 64) === 64,
    `d63=${String(mixed.sample('d0', 63))} a63=${String(mixed.sample('a0', 63))} ` +
    `a64=${String(mixed.sample('a0', 64))}`,
  );
  const mixedAnalog = mixed.query('a0', 64, 256, 3).analog!;
  checkNumbers('analog summaries survive a drop', mixedAnalog.min, [64, 128, 192]);
  checkNumbers('analog summary maxima survive a drop', mixedAnalog.max, [127, 191, 255]);
  checkNumbers('analog summary means survive a drop', mixedAnalog.mean, [95.5, 159.5, 223.5]);
  checkNumbers(
    'evicted analog positions are GAP and the rest are known',
    mixed.query('a0', 0, 256, 4).status,
    [2, 0, 0, 0],
  );

  // Per-group gaps trim at each group's own new left edge.
  const perGroupDrop = createDigitalSignalStore({
    groups: [
      { id: 'a', channels: 4, rateHz: 1_000_000 },
      { id: 'b', channels: 4, rateHz: 2_000_000, start: 4 },
    ],
  });
  perGroupDrop.append('a', encode(new Array<number>(256).fill(0), 4), 0);
  perGroupDrop.append('b', encode(new Array<number>(256).fill(0), 4), 0);
  perGroupDrop.noteGap({ group: 'a', start: 60, end: 70, reason: 'suspend' });
  perGroupDrop.noteGap({ group: 'b', start: 30, end: 140, reason: 'overrun' });
  perGroupDrop.dropBefore(30 / 1_000_000);
  const droppedGaps = perGroupDrop.gaps();
  check(
    'dropBefore trims every group\'s gaps by time',
    perGroupDrop.retainedFromOf('a') === 64 / 1_000_000 &&
      perGroupDrop.retainedFromOf('b') === 64 / 2_000_000 &&
      droppedGaps.length === 2 &&
      droppedGaps[0]!.group === 'a' && droppedGaps[0]!.start === 64 &&
      droppedGaps[0]!.end === 70 &&
      droppedGaps[1]!.group === 'b' && droppedGaps[1]!.start === 64 &&
      droppedGaps[1]!.end === 140,
    JSON.stringify(droppedGaps),
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

  // ---------------------------------------------------------------- stream origin
  const originStore = makeStore();
  const originWords = Array.from({ length: 128 }, (_, i) => i & 1);
  originStore.append('digital', encode(originWords.slice(0, 64), 4), 8);
  originStore.append('digital', encode(originWords.slice(64), 4), 72);
  check(
    'the first append fixes the stream origin at a nonzero position',
    originStore.origin === 8 && originStore.retainedFrom === 8 / 1_000_000 &&
      originStore.newest['digital'] === 136,
    `origin=${originStore.origin} retainedFrom=${originStore.retainedFrom} ` +
    `newest=${String(originStore.newest['digital'])}`,
  );
  checkNumbers(
    'positions before the origin are GAP, never pending',
    originStore.query('d0', 0, 16, 4).status,
    [2, 2, 0, 0],
  );
  check(
    'sample is null before the origin and known at it',
    originStore.sample('d0', 7) === null && originStore.sample('d0', 8) === 0 &&
      originStore.sample('d0', 9) === 1,
    `7=${String(originStore.sample('d0', 7))} 8=${String(originStore.sample('d0', 8))} ` +
    `9=${String(originStore.sample('d0', 9))}`,
  );

  originStore.dropBefore(72 / 1_000_000);
  check(
    'dropBefore keeps the origin and absolute positions stable',
    originStore.origin === 8 && originStore.retainedFrom === 72 / 1_000_000 &&
      originStore.newest['digital'] === 136 &&
      originStore.sample('d0', 71) === null && originStore.sample('d0', 72) === 0,
    `origin=${originStore.origin} retainedFrom=${originStore.retainedFrom} ` +
    `newest=${String(originStore.newest['digital'])}`,
  );
  checkNumbers(
    'query after a drop with an origin marks evicted bins GAP',
    originStore.query('d0', 0, 136, 8).status,
    [2, 2, 2, 2, 2, 0, 0, 0],
  );

  const originEdges = makeStore();
  originEdges.append('digital', encode([0, 0, 1, 1, 0, 0, 1, 1], 4), 8);
  checkNumbers(
    'edges start after the origin because it has no known predecessor',
    originEdges.edges('d0', 0, 16),
    [10, 12, 14],
  );
  checkNumbers(
    'a query wholly before the origin is all GAP',
    originEdges.query('d0', 0, 8, 2).status,
    [2, 2],
  );

  // ---------------------------------------------------------------- pending gaps
  const preGap = makeStore();
  preGap.noteGap({ group: 'digital', start: 0, end: 4, reason: 'dropout' });
  check(
    'a gap may be noted before the first append',
    preGap.gaps().length === 1 && preGap.newest['digital'] === 0,
    JSON.stringify(preGap.gaps()),
  );
  checkNumbers(
    'a pending gap with no data is GAP, not PENDING',
    preGap.query('d0', 0, 4, 1).status,
    [2],
  );
  preGap.append('digital', encode([0, 1, 0, 1], 4), 4);
  check(
    'the first append past a pre-noted gap fixes the origin there',
    preGap.origin === 4 && preGap.newest['digital'] === 8 &&
      preGap.sample('d0', 4) === 0 && preGap.sample('d0', 7) === 1,
    `origin=${preGap.origin} newest=${String(preGap.newest['digital'])}`,
  );
  checkNumbers(
    'a pre-window gap remains GAP after the origin is fixed',
    preGap.query('d0', 0, 8, 2).status,
    [2, 0],
  );
  check(
    'a gap wholly before the origin is discarded on the first append',
    preGap.gaps().length === 0,
    JSON.stringify(preGap.gaps()),
  );

  const clampedGap = makeStore();
  clampedGap.append('digital', encode([0, 1, 0, 1, 0, 1, 0, 1], 4), 4);
  clampedGap.noteGap({ group: 'digital', start: 0, end: 2, reason: 'suspend' });
  check(
    'a gap wholly before the origin is ignored',
    clampedGap.gaps().length === 0,
    JSON.stringify(clampedGap.gaps()),
  );
  clampedGap.noteGap({ group: 'digital', start: 0, end: 6, reason: 'suspend' });
  check(
    'a gap starting before the origin is clamped to it',
    clampedGap.gaps().length === 1 && clampedGap.gaps()[0]!.start === 4 &&
      clampedGap.gaps()[0]!.end === 6,
    JSON.stringify(clampedGap.gaps()),
  );

  const filled = makeStore();
  filled.append('digital', encode([0, 0, 0, 0], 4), 0);
  filled.noteGap({ group: 'digital', start: 4, end: 8, reason: 'overrun' });
  checkNumbers(
    'a future watermark is GAP before the data arrives',
    filled.query('d0', 4, 8, 2).status,
    [2, 2],
  );
  filled.append('digital', encode([1, 1, 1, 1], 4), 8);
  check(
    'an append after a fully covered skip is accepted with zero filler',
    filled.origin === 0 && filled.newest['digital'] === 12 &&
      filled.sample('d0', 4) === null && filled.sample('d0', 7) === null &&
      filled.sample('d0', 8) === 1,
    `newest=${String(filled.newest['digital'])} ` +
    `7=${String(filled.sample('d0', 7))} 8=${String(filled.sample('d0', 8))}`,
  );
  check(
    'the watermark survives the filler append',
    filled.gaps().length === 1 && filled.gaps()[0]!.start === 4 &&
      filled.gaps()[0]!.end === 8,
    JSON.stringify(filled.gaps()),
  );
  checkNumbers(
    'edges suppress the unprovable transition after a filled gap',
    filled.edges('d0', 0, 12),
    [],
  );

  const skipStore = makeStore();
  skipStore.append('digital', encode([0, 0, 0, 0], 4), 0);
  check(
    'a skip not covered by any gap is still refused',
    errorCode(() => { skipStore.append('digital', encode([0], 4), 8); }) === 'non-contiguous',
    'start=8, newest=4, no gap',
  );
  skipStore.noteGap({ group: 'digital', signal: 'd0', start: 4, end: 8, reason: 'overrun' });
  check(
    'a signal-specific gap does not authorize a group-wide skip',
    errorCode(() => { skipStore.append('digital', encode([0], 4), 8); }) === 'non-contiguous',
    'only d0 is covered',
  );

  const mergedPending = makeStore();
  mergedPending.noteGap({ group: 'digital', start: 0, end: 4, reason: 'dropout' });
  mergedPending.noteGap({ group: 'digital', start: 4, end: 8, reason: 'dropout' });
  mergedPending.noteGap({ group: 'digital', start: 20, end: 24, reason: 'dropout' });
  mergedPending.noteGap({ group: 'digital', start: 8, end: 20, reason: 'dropout' });
  check(
    'touching pending watermarks merge into one bounded span',
    mergedPending.gaps().length === 1 && mergedPending.gaps()[0]!.start === 0 &&
      mergedPending.gaps()[0]!.end === 24,
    JSON.stringify(mergedPending.gaps()),
  );

  const trimPending = makeStore();
  trimPending.append('digital', encode(new Array<number>(128).fill(0), 4), 0);
  trimPending.noteGap({ group: 'digital', start: 100, end: 200, reason: 'store-full' });
  trimPending.dropBefore(128 / 1_000_000);
  check(
    'dropBefore trims a pending gap at the new retained edge',
    trimPending.retainedFrom === 128 / 1_000_000 && trimPending.gaps().length === 1 &&
      trimPending.gaps()[0]!.start === 128 && trimPending.gaps()[0]!.end === 200,
    JSON.stringify(trimPending.gaps()),
  );

  // ---------------------------------------------------------------- status precedence
  const precedence = makeStore();
  precedence.append('digital', encode(new Array<number>(128).fill(0), 4), 0);
  precedence.dropBefore(64 / 1_000_000);
  checkNumbers(
    'eviction beats pending in a bin spanning retained and future data',
    precedence.query('d0', 0, 256, 1).status,
    [2],
  );
  checkNumbers(
    'a wholly pending range is still pending',
    precedence.query('d0', 128, 256, 2).status,
    [1, 1],
  );
  precedence.noteGap({ group: 'digital', start: 128, end: 200, reason: 'dropout' });
  checkNumbers(
    'an explicit pending gap beats pending',
    precedence.query('d0', 128, 256, 2).status,
    [2, 2],
  );

  // ---------------------------------------------------------------- store-full
  const small = createDigitalSignalStore({
    groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000, maxSamples: 8 }],
  });
  small.append('digital', encode([0, 0, 0, 0], 4), 0);
  small.append('digital', encode([0, 0, 0, 0], 4), 4);
  check(
    'an append beyond maxSamples throws store-full',
    errorCode(() => { small.append('digital', encode([0], 4), 8); }) === 'store-full',
    '8 retained + 1',
  );
  const smallGap = createDigitalSignalStore({
    groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000, maxSamples: 8 }],
  });
  smallGap.append('digital', encode([0, 0, 0, 0], 4), 0);
  smallGap.noteGap({ group: 'digital', start: 4, end: 12, reason: 'dropout' });
  check(
    'filler for a covered skip counts against maxSamples',
    errorCode(() => { smallGap.append('digital', encode([0], 4), 12); }) === 'store-full',
    '4 retained + 8 filler + 1',
  );
  check(
    'maxSamples must be a positive safe integer',
    errorCode(() => {
      createDigitalSignalStore({
        groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000, maxSamples: 0 }],
      });
    }) === 'invalid-group',
    'maxSamples=0',
  );

  // ---------------------------------------------------------------- store widths
  for (const channels of [4, 8, 16, 32, 64, 128] as ChannelCount[]) {
    const widthStore = makeStore(channels);
    const top = channels - 1;
    const topBit = 2 ** top;
    const widthWords = [topBit, 0, topBit, 0, 0, topBit];
    widthStore.append('digital', encode(widthWords.slice(0, 3), channels), 3);
    widthStore.append('digital', encode(widthWords.slice(3), channels), 6);
    const topColumns = widthStore.query(`d${top}`, 3, 9, 6).digital!;
    const lowColumns = widthStore.query('d0', 3, 9, 6).digital!;
    const positions = [3, 4, 5, 6, 7, 8];
    const topSamples = positions.map((position) => widthStore.sample(`d${top}`, position) ?? -1);
    const lowSamples = positions.map((position) => widthStore.sample('d0', position) ?? -1);
    check(
      `${channels}-channel store maps and queries the top channel`,
      widthStore.origin === 3 && widthStore.newest['digital'] === 9 &&
        Array.from(topColumns.high).join(',') === '1,0,1,0,0,1' &&
        Array.from(topColumns.low).join(',') === '1,0,1,0,0,1' &&
        topSamples.join(',') === '1,0,1,0,0,1',
      `high=[${Array.from(topColumns.high)}] samples=[${topSamples}]`,
    );
    check(
      `${channels}-channel store leaves channel 0 low`,
      Array.from(lowColumns.high).join(',') === '0,0,0,0,0,0' &&
        lowSamples.join(',') === '0,0,0,0,0,0',
      `high=[${Array.from(lowColumns.high)}] samples=[${lowSamples}]`,
    );
  }

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
  check(
    'a store without a record backend keeps the unsupported controller',
    recordStore.record instanceof UnsupportedRecordController,
    recordStore.record.constructor.name,
  );

  // A record backend is installed but not armed: construction is pure, and appends are
  // not queued until the UI arms the record.
  const recordBacked = createDigitalSignalStore({
    groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000 }],
    record: { storage: unopenedRecordStorage, profile: digitalRecordProfile(4) },
  });
  check(
    'a record backend installs an off OPFS controller',
    recordBacked.record instanceof OpfsRecordController &&
      recordBacked.record.state === 'off' &&
      recordBacked.record.bytes === 0,
    `state=${recordBacked.record.state} bytes=${recordBacked.record.bytes}`,
  );
  recordBacked.append('digital', encode([1, 2, 3, 4], 4), 0);
  const installed = recordBacked.record;
  check(
    'an append while the record is off queues nothing and still stores samples',
    installed instanceof OpfsRecordController &&
      installed.queuedBytes === 0 &&
      recordBacked.query('d0', 0, 4, 4).digital!.high.join(',') === '1,0,1,0',
    installed instanceof OpfsRecordController
      ? `queued=${installed.queuedBytes}`
      : 'controller is not an OpfsRecordController',
  );
  check(
    'an unknown record group is a typed invalid-record refusal',
    errorCode(() => createDigitalSignalStore({
      groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000 }],
      record: {
        storage: unopenedRecordStorage,
        profile: digitalRecordProfile(4),
        groupId: 'missing',
      },
    })) === 'invalid-record',
    'groupId=missing',
  );
  check(
    'a record profile must match the recorded group layout',
    errorCode(() => createDigitalSignalStore({
      groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000 }],
      record: { storage: unopenedRecordStorage, profile: digitalRecordProfile(8) },
    })) === 'invalid-record' &&
      errorCode(() => createDigitalSignalStore({
        groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000 }],
        record: {
          storage: unopenedRecordStorage,
          profile: { ...digitalRecordProfile(4), sampleRateHz: 2_000_000 },
        },
      })) === 'invalid-record' &&
      errorCode(() => createDigitalSignalStore({
        groups: [{ id: 'digital', channels: 4, rateHz: 1_000_000 }],
        record: {
          storage: unopenedRecordStorage,
          profile: { ...digitalRecordProfile(4), bytesPerSample: 2 },
        },
      })) === 'invalid-record',
    'channels, rate and bytes/frame are all checked',
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
