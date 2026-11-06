// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Integration selftest: HostTrigger -> SignalStore.
 *
 * The host executor emits only the retained stream, which may start at
 * `T - preTriggerSamples > 0`. This suite feeds a synthetic device stream through the
 * real adapter, buffers its emitted chunks, and then appends them to a real
 * DigitalSignalStore at that origin. It pins the coordinate contract the M1 capture
 * wiring depends on: T is in emitted-stream samples, the store origin is
 * `absoluteT - emittedT`, and the emitted byte ranges are whole samples.
 *
 * Deterministic and offline: no timers, no USB, no DOM.
 */

import { DigitalSignalStore } from '../data/signalStore.js';
import { COLUMN_GAP, COLUMN_OK, type SamplePos } from '../data/signalStore.js';
import { compileTriggerPlan, type TriggerPlan } from './triggerPlan.js';
import { HostTrigger } from './hostTrigger.js';
import { SLOGIC16U3_PROFILE } from '../device/profiles.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';

const GROUP = 'digital';
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`);
  }
}

function planFor(channels: ChannelCount, prePercent: number, postSamples: number): TriggerPlan {
  const result = compileTriggerPlan({
    profile: SLOGIC16U3_PROFILE,
    enableMask: true,
    source: 'digital',
    digital: [{ signal: 'd0', kind: 'rising' }],
    analog: [],
    preTriggerPercent: prePercent,
    postTrigger: { kind: 'samples', value: postSamples },
    capture: { samplerate: 5e6, channels },
    compiledAt: 0,
  });
  if (!result.ok) throw new Error(`plan refused: ${result.reason}: ${result.detail}`);
  return result.plan;
}

function packWords(channels: ChannelCount, words: readonly number[]): Uint8Array {
  const bps = bytesPerSampleForChannels(channels);
  const out = new Uint8Array(words.length * bps);
  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    for (let byte = 0; byte < bps; byte++) {
      out[i * bps + byte] = word & 0xff;
      word = Math.floor(word / 256);
    }
  }
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function statusAt(store: DigitalSignalStore, position: SamplePos): number {
  return store.query('d0', position, position + 1, 1).status[0]!;
}

function main(): void {
  const channels: ChannelCount = 8;
  const bps = bytesPerSampleForChannels(channels);
  const prePercent = 25;
  const post = 6;
  const plan = planFor(channels, prePercent, post);
  const pre = plan.preTrigger.samples!;
  const words = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const raw = packWords(channels, words);

  const emitted: Uint8Array[] = [];
  let emittedT = -1;
  const trigger = new HostTrigger({
    plan,
    channels,
    samplerate: 5e6,
    emit: (chunk) => emitted.push(chunk.slice()),
    onMatch: (match) => {
      emittedT = match.index;
    },
  });

  // Feed one byte at a time, so both the stream and the matching sample cross chunk
  // boundaries.
  for (let offset = 0; offset < raw.length; offset += 1) {
    trigger.feed(raw.subarray(offset, offset + 1));
  }

  check('host trigger matched the synthetic rising edge',
    trigger.stats.matched && trigger.triggerSampleIndex === emittedT,
    `matched=${trigger.stats.matched} T=${String(trigger.triggerSampleIndex)}`);
  check('host trigger retired the full pre + post budget',
    trigger.stats.emittedSamples === pre + post,
    `emitted=${trigger.stats.emittedSamples} expected=${pre + post}`);
  check('host trigger emitted whole samples only',
    emitted.every((chunk) => chunk.length % bps === 0),
    emitted.map((chunk) => chunk.length).join(','));

  // inspectedSamples is one past the absolute trigger sample in the fed stream.
  const absoluteT = trigger.stats.inspectedSamples - 1;
  const origin = absoluteT - emittedT;
  check('emitted T and absolute T differ by the emitted-stream origin',
    origin === Math.max(0, absoluteT - pre),
    `origin=${origin} absoluteT=${absoluteT} emittedT=${emittedT} pre=${pre}`);

  const bytes = concat(emitted);
  const store = new DigitalSignalStore({
    groups: [{ id: GROUP, channels, rateHz: 5e6, maxSamples: 1_000_000 }],
  });
  store.append(GROUP, bytes, origin);

  check('store origin is the first emitted sample', store.origin === origin,
    `store=${store.origin} expected=${origin}`);
  check('store newest is origin + pre + post',
    store.newest[GROUP] === origin + pre + post,
    `newest=${store.newest[GROUP]} expected=${origin + pre + post}`);
  check('absolute T is known data', statusAt(store, absoluteT) === COLUMN_OK,
    `status=${statusAt(store, absoluteT)} T=${absoluteT}`);
  check('the retained prefix before T is known data',
    statusAt(store, absoluteT - 1) === COLUMN_OK,
    `status=${statusAt(store, absoluteT - 1)}`);
  check('a position before the emitted origin is gap, not pending',
    absoluteT > pre && statusAt(store, origin - 1) === COLUMN_GAP,
    `status=${statusAt(store, origin - 1)} origin=${origin}`);
  check('store decodes the trigger sample as level 1',
    store.sample('d0', absoluteT) === 1,
    `sample=${String(store.sample('d0', absoluteT))}`);

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} hostTrigger→SignalStore integration: ` +
    `${passed} passed, ${failed} failed`);
  if (failed !== 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc !== undefined) proc.exitCode = 1;
  }
}

main();
