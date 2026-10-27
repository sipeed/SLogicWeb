// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic checks for SoftwareTrigger. Kept separate from the large storage suite
 * so trigger tests can also be run by a capture/UI self-test without building a store.
 */

import {
  MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
  SoftwareTrigger,
  type SoftwareTriggerConfig,
  type SoftwareTriggerKind,
  type SoftwareTriggerStats,
} from './softwareTrigger.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';

export interface SoftwareTriggerTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

function collect(
  channels: ChannelCount,
  samples: readonly number[],
  config: Omit<SoftwareTriggerConfig, 'channels'>,
  chunks: readonly number[],
): { output: number[]; trigger: SoftwareTriggerStats } {
  const bps = bytesPerSampleForChannels(channels);
  const raw = new Uint8Array(samples.length * bps);
  for (let i = 0; i < samples.length; i++) {
    let word = samples[i]!;
    for (let b = 0; b < bps; b++) {
      raw[i * bps + b] = word & 0xff;
      word >>>= 8;
    }
  }
  const output: number[] = [];
  const trigger = new SoftwareTrigger({
    config: { ...config, channels },
    emit: (chunk) => output.push(...chunk),
  });
  let p = 0;
  for (const n of chunks) {
    trigger.feed(raw.subarray(p, Math.min(raw.length, p + n)));
    p += n;
    if (p >= raw.length) break;
  }
  if (p < raw.length) trigger.feed(raw.subarray(p));
  trigger.finish();
  return { output, trigger: trigger.stats };
}

function expectedBytes(channels: ChannelCount, samples: readonly number[]): number[] {
  const bps = bytesPerSampleForChannels(channels);
  const out: number[] = [];
  for (const sample of samples) {
    let word = sample;
    for (let b = 0; b < bps; b++) {
      out.push(word & 0xff);
      word >>>= 8;
    }
  }
  return out;
}

function checkMode(kind: SoftwareTriggerKind): SoftwareTriggerTestResult {
  const samples = [0, 0, 1, 1, 0, 0];
  const at = kind === 'level' ? 2 : kind === 'rising' ? 2 : kind === 'falling' ? 4 : 2;
  const { output, trigger } = collect(16, samples, {
    kind,
    ...(kind === 'level' ? { level: 1 } : {}),
    channel: 0,
    preTriggerSamples: 2,
    maxSamples: 4,
  }, [3, 1, 5]);
  const want = samples.slice(Math.max(0, at - 2), at + 2);
  const gotSamples: number[] = [];
  for (let i = 0; i < output.length; i += 2) gotSamples.push(output[i]! | (output[i + 1]! << 8));
  const pass = trigger.matched && !trigger.noTrigger &&
    trigger.triggerSampleIndex === Math.min(2, at) &&
    gotSamples.join(',') === want.join(',') && gotSamples.length === 4;
  return {
    name: `${kind} trigger across a transfer/sample boundary`,
    pass,
    detail: pass ? `${gotSamples.length} samples emitted` :
      `got ${gotSamples.join(',')} want ${want.join(',')} T=${trigger.triggerSampleIndex}`,
  };
}

export function runSoftwareTriggerSuite(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  for (const kind of ['level', 'rising', 'falling', 'edge'] as const) results.push(checkMode(kind));

  const no = collect(4, [0, 0, 0, 0], {
    kind: 'rising', channel: 3, preTriggerSamples: 100, maxSamples: 8,
  }, [1, 1, 1, 1, 1]);
  results.push({
    name: 'no trigger discards bounded search prefix',
    pass: no.trigger.noTrigger && !no.trigger.matched && no.output.length === 0 &&
      no.trigger.inspectedSamples === 4,
    detail: `matched=${no.trigger.matched}, output=${no.output.length}, inspected=${no.trigger.inspectedSamples}`,
  });

  // The trigger may land exactly at the nominal output budget. The matcher must
  // inspect the retained-prefix allowance as well, otherwise a final falling
  // edge is incorrectly reported as absent before its post-trigger sample arrives.
  const boundary = collect(16, [0, 0, 1, 1, 0, 0], {
    kind: 'falling', channel: 0, preTriggerSamples: 2, maxSamples: 4,
  }, [3, 1, 5]);
  const boundaryWords: number[] = [];
  for (let i = 0; i < boundary.output.length; i += 2) {
    boundaryWords.push(boundary.output[i]! | (boundary.output[i + 1]! << 8));
  }
  results.push({
    name: 'trigger at output-budget boundary retains post-trigger sample',
    pass: boundary.trigger.matched && boundary.trigger.complete &&
      boundaryWords.join(',') === '1,1,0,0',
    detail: `got ${boundaryWords.join(',')}, inspected=${boundary.trigger.inspectedSamples}`,
  });

  const autoNo = new SoftwareTrigger({
    config: { channels: 8, kind: 'rising', channel: 0, preTriggerSamples: 2, maxSamples: 4 },
    emit: () => {},
  });
  autoNo.feed(new Uint8Array(8));
  results.push({
    name: 'automatic no-trigger stop is bounded by output plus prefix budget',
    pass: autoNo.stats.noTrigger && autoNo.stats.inspectedSamples === 6,
    detail: `noTrigger=${autoNo.stats.noTrigger}, inspected=${autoNo.stats.inspectedSamples}`,
  });

  const waiting = new SoftwareTrigger({
    config: {
      channels: 8, kind: 'rising', channel: 0, preTriggerSamples: 2, maxSamples: 8,
      searchLimitSamples: Number.POSITIVE_INFINITY,
    },
    emit: () => {},
  });
  waiting.feed(new Uint8Array(80));
  results.push({
    name: 'infinite trigger wait keeps rolling without timer-style timeout',
    pass: waiting.waiting && !waiting.stats.noTrigger && waiting.stats.emittedSamples === 0 &&
      waiting.stats.inspectedSamples === 80,
    detail: `waiting=${waiting.waiting}, inspected=${waiting.stats.inspectedSamples}`,
  });

  // The loop-capture form: maxSamples Infinity turns the match into an unbounded
  // stream - `complete` never sets, and the windowing is the store's dropFront,
  // downstream of the trigger.
  const loopOut: number[] = [];
  const loopTrigger = new SoftwareTrigger({
    config: {
      channels: 8, kind: 'rising', channel: 0, preTriggerSamples: 2,
      maxSamples: Number.POSITIVE_INFINITY,
    },
    emit: (chunk) => loopOut.push(...chunk),
  });
  // Waiting phase: 10 idle samples, then the edge, then a long tail.
  loopTrigger.feed(new Uint8Array(10).fill(0));
  const loopWaiting = loopTrigger.waiting && loopTrigger.stats.emittedSamples === 0;
  loopTrigger.feed(new Uint8Array([0, 1]));
  const loopMatched = loopTrigger.stats.matched && loopTrigger.stats.triggerSampleIndex === 2;
  loopTrigger.feed(new Uint8Array(97).fill(1));
  loopTrigger.feed(new Uint8Array(300).fill(0));
  results.push({
    name: 'an unbounded (loop) trigger emits forever after the match and never completes',
    pass: loopWaiting && loopMatched && !loopTrigger.stats.complete &&
      loopTrigger.stats.emittedSamples === 2 + 1 + 97 + 300 &&
      loopOut.length === 2 + 1 + 97 + 300 &&
      loopOut[0] === 0 && loopOut[1] === 0 && loopOut[2] === 1,
    detail: `waitingEmits=${loopWaiting}, T=${loopTrigger.stats.triggerSampleIndex}, ` +
      `emitted=${loopTrigger.stats.emittedSamples}, complete=${loopTrigger.stats.complete}`,
  });
  results.push({
    name: 'an unbounded trigger still honours finish() with no match',
    pass: (() => {
      const t = new SoftwareTrigger({
        config: {
          channels: 8, kind: 'rising', channel: 0, preTriggerSamples: 2,
          maxSamples: Number.POSITIVE_INFINITY,
        },
        emit: () => {},
      });
      t.feed(new Uint8Array(64));
      t.finish();
      return t.stats.noTrigger && !t.waiting;
    })(),
    detail: 'finish() on a waiting loop trigger reports not-found',
  });
  {
    let threw = '';
    try {
      new SoftwareTrigger({
        config: { channels: 8, kind: 'rising', channel: 0, preTriggerSamples: 2, maxSamples: 0 },
        emit: () => {},
      });
    } catch (e) { threw = String(e); }
    results.push({
      name: 'maxSamples still rejects zero (Infinity is the only non-integer allowed)',
      pass: threw.includes('maxSamples'),
      detail: threw || '<no throw>',
    });
  }
  {
    // The unbounded budget must not unbind the waiting prefix: `maxSamples - 1` is
    // Infinity there, so the 64 MiB byte cap is the only term left in the min chain.
    const capped = new SoftwareTrigger({
      config: {
        channels: 16, kind: 'rising', channel: 0, preTriggerSamples: 1e9,
        maxSamples: Number.POSITIVE_INFINITY,
      },
      emit: () => {},
    });
    const want = Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSampleForChannels(16));
    results.push({
      name: 'an unbounded trigger still bounds its waiting prefix to 64 MiB',
      pass: capped.preTriggerSamples === want && capped.searchLimitSamples === Infinity,
      detail: `pre=${capped.preTriggerSamples}, want=${want}, search=${capped.searchLimitSamples}`,
    });
  }
  {
    // Infinity arithmetic in emitPost: `remaining` never runs out, so the only bound is
    // the fragment's whole-sample count and the sub-sample carry must still survive
    // across feeds (1-byte fragments at 16ch). Emitted samples: the match at index 1 of
    // [0,1,1,0,1] plus the three after it.
    const out: number[] = [];
    const t = new SoftwareTrigger({
      config: {
        channels: 16, kind: 'rising', channel: 0, preTriggerSamples: 0,
        maxSamples: Number.POSITIVE_INFINITY,
      },
      emit: (chunk) => out.push(...chunk),
    });
    const raw = new Uint8Array([0, 0, 1, 0, 1, 0, 0, 0, 1, 0]);
    t.feed(raw.subarray(0, 3));
    t.feed(raw.subarray(3, 7));
    // This fragment leaves the post-match range 1 byte short of a whole sample, which is
    // emitPost()'s `available === 0` branch: under Infinity it must stash, not complete.
    t.feed(raw.subarray(7, 9));
    t.feed(raw.subarray(9, 10));
    const words: number[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) words.push(out[i]! | (out[i + 1]! << 8));
    results.push({
      name: 'an unbounded trigger carries a sub-sample remainder across feeds',
      pass: words.join(',') === '1,1,0,1' && t.stats.emittedSamples === 4 &&
        t.stats.triggerSampleIndex === 0 && !t.stats.complete,
      detail: `words=${words.join(',')}, emitted=${t.stats.emittedSamples}, ` +
        `T=${t.stats.triggerSampleIndex}, complete=${t.stats.complete}`,
    });
  }

  const andRaw = new Uint8Array([0, 0, 2, 3, 2, 0, 2]);
  const andOutput: number[] = [];
  const andTrigger = new SoftwareTrigger({
    config: {
      channels: 8,
      conditions: [
        { channel: 0, kind: 'rising' },
        { channel: 1, kind: 'level', level: 1 },
      ],
      preTriggerSamples: 1,
      maxSamples: 3,
    },
    emit: (chunk) => andOutput.push(...chunk),
  });
  andTrigger.feed(andRaw.subarray(0, 5));
  andTrigger.feed(andRaw.subarray(5));
  results.push({
    name: 'multiple channel conditions use logical AND with one shared ring',
    pass: andTrigger.stats.matched && andTrigger.stats.complete &&
      andTrigger.stats.triggerSampleIndex === 1 && andOutput.join(',') === '2,3,2',
    detail: `matched=${andTrigger.stats.matched}, T=${andTrigger.stats.triggerSampleIndex}, output=${andOutput.join(',')}`,
  });

  const widths: ChannelCount[] = [4, 8, 16, 32, 64, 128];
  for (const channels of widths) {
    // Channel zero keeps the fixture representable as a JS number while still
    // exercising every wire width (the upper bytes must remain zero).
    const sample = 1;
    const got = collect(channels, [0, sample, sample, 0], {
      kind: 'rising', channel: 0, preTriggerSamples: 1, maxSamples: 2,
    }, [1, 1, 1, 1, 1]);
    const want = expectedBytes(channels, [0, sample]);
    const pass = got.trigger.matched && got.trigger.complete &&
      got.output.length === want.length && got.output.every((v, i) => v === want[i]);
    results.push({
      name: `${channels}-channel multi-byte sample path`,
      pass,
      detail: pass ? `${got.output.length} bytes emitted` : `output byte mismatch`,
    });
  }
  return results;
}
