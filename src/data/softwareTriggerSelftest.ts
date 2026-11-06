// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic checks for SoftwareTrigger. Kept separate from the large storage suite
 * so trigger tests can also be run by a capture/UI self-test without building a store.
 */

import {
  MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
  SoftwareTrigger,
  type SoftwareTriggerAnalogCondition,
  type SoftwareTriggerConfig,
  type SoftwareTriggerCondition,
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

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ReferenceResult {
  output: number[];
  matched: boolean;
  noTrigger: boolean;
  complete: boolean;
  emittedSamples: number;
  triggerSampleIndex: number | null;
  inspectedSamples: number;
}

/**
 * A deliberately naive, per-sample model of the documented trigger semantics: walk the
 * stream one sample at a time, evaluate every condition against the previous sample,
 * ignore matches until `pre` samples have been seen (pre-fill holdoff), keep the last
 * `pre` samples, and emit from there. It allocates and copies per sample
 * precisely because it is not the hot path — it is the oracle the block scanner's
 * output is compared against.
 */
function referenceRun(
  samples: readonly number[],
  channels: ChannelCount,
  config: Omit<SoftwareTriggerConfig, 'channels'>,
): ReferenceResult {
  const analog = config.analog ?? [];
  const bps = bytesPerSampleForChannels(channels);
  const maxSamples = config.maxSamples;
  const pre = Math.min(
    config.preTriggerSamples,
    Math.max(0, maxSamples - 1),
    Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bps),
  );
  const limit = config.searchLimitSamples ?? maxSamples + pre;
  const conditions = config.conditions?.length
    ? config.conditions
    : config.channel !== undefined && config.kind !== undefined
      ? [{ channel: config.channel, kind: config.kind, level: config.level }]
      : [];
  const previous: Array<number | null> = Array.from({ length: channels }, () => null);
  const previousAnalog = new Int16Array(bps).fill(-1);
  let inspected = 0;
  let trigger = -1;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    let matched = true;
    for (const c of conditions) {
      const value = (sample >>> c.channel) & 1;
      const old = previous[c.channel]!;
      const ok = c.kind === 'level' ? value === c.level
        : c.kind === 'rising' ? old === 0 && value === 1
          : c.kind === 'falling' ? old === 1 && value === 0
            : old !== null && old !== value;
      if (!ok) matched = false;
    }
    for (const c of conditions) previous[c.channel] = (sample >>> c.channel) & 1;
    const analogCodes: number[] = [];
    for (const a of analog) {
      const byte = a.start >>> 3;
      const code = analogRaw((sample >>> (byte * 8)) & 0xff);
      analogCodes.push(code);
      const old = previousAnalog[byte]!;
      const ok = a.kind === 'rising'
        ? old >= 0 && old < a.level && code >= a.level
        : old >= 0 && old > a.level && code <= a.level;
      if (!ok) matched = false;
    }
    for (let i = 0; i < analog.length; i++) {
      previousAnalog[analog[i]!.start >>> 3] = analogCodes[i]!;
    }
    inspected++;
    // Pre-fill holdoff: a match counts only once `pre` samples precede it.
    if (matched && i >= pre) {
      trigger = i;
      break;
    }
    if (inspected >= limit) break;
  }
  if (trigger < 0) {
    return {
      output: [],
      matched: false,
      noTrigger: inspected >= limit,
      complete: false,
      emittedSamples: 0,
      triggerSampleIndex: null,
      inspectedSamples: Math.min(samples.length, limit),
    };
  }
  const start = Math.max(0, trigger - pre);
  const end = Number.isFinite(maxSamples) ? Math.min(samples.length, start + maxSamples) : samples.length;
  const emitted = samples.slice(start, end);
  return {
    output: expectedBytes(channels, emitted),
    matched: true,
    noTrigger: false,
    complete: emitted.length >= maxSamples,
    emittedSamples: emitted.length,
    triggerSampleIndex: trigger - start,
    inspectedSamples: trigger + 1,
  };
}

function referenceComparison(): SoftwareTriggerTestResult[] {
  const widths: ChannelCount[] = [4, 8, 16, 32, 64, 128];
  const kinds: SoftwareTriggerKind[] = ['level', 'rising', 'falling', 'edge'];
  const groups = [
    { name: 'block scanner matches the per-sample reference (finite budgets)', kind: 'finite', cases: 90 },
    { name: 'block scanner matches the per-sample reference (unbounded loop)', kind: 'loop', cases: 45 },
    { name: 'block scanner matches the per-sample reference (streams that never match)', kind: 'none', cases: 45 },
  ] as const;
  const results: SoftwareTriggerTestResult[] = [];
  for (const group of groups) {
    let checked = 0;
    let firstFail = '';
    for (let seed = 1; seed <= group.cases && firstFail === ''; seed++) {
      const rng = mulberry32(Math.imul(seed, 0x9e3779b1) ^ 0x5f356495);
      const channels = widths[Math.floor(rng() * widths.length)]!;
      const bps = bytesPerSampleForChannels(channels);
      const sampleCount = 1 + Math.floor(rng() * 90);
      // Keep this at most 32: `referenceRun` extracts a channel with `sample >>> channel`,
      // and JS shift counts are modulo 32, so a higher bit would silently read channel 0.
      // Wide samples are covered by the byte-level high-channel tests below instead.
      const meaningfulBits = Math.min(channels, 32);
      const samples: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        let word = 0;
        for (let b = 0; b < meaningfulBits; b++) if (rng() < 0.5) word |= 1 << b;
        samples.push(word >>> 0);
      }
      let conditions: SoftwareTriggerCondition[];
      if (group.kind === 'none') {
        // Rising and falling on one channel cannot hold for the same sample (the AND
        // evaluates both against the same previous value), so this stream never matches.
        conditions = [
          { channel: 0, kind: 'rising' as const },
          { channel: 0, kind: 'falling' as const },
        ];
      } else {
        conditions = [];
        const count = 1 + Math.floor(rng() * 3);
        for (let i = 0; i < count; i++) {
          const kind = kinds[Math.floor(rng() * kinds.length)]!;
          const channel = Math.floor(rng() * Math.min(channels, 32));
          conditions.push(kind === 'level'
            ? { channel, kind, level: (rng() < 0.5 ? 0 : 1) as 0 | 1 }
            : { channel, kind });
        }
      }
      const maxSamples = group.kind === 'loop' || rng() < 0.2
        ? Number.POSITIVE_INFINITY
        : 1 + Math.floor(rng() * 12);
      const preTriggerSamples = Math.floor(rng() * 10);
      const pick = rng();
      const searchLimitSamples = group.kind === 'loop'
        ? (pick < 0.5 ? Number.POSITIVE_INFINITY : undefined)
        : pick < 0.45 ? undefined
          : pick < 0.85 ? 1 + Math.floor(rng() * sampleCount)
            : Number.POSITIVE_INFINITY;
      const analog: SoftwareTriggerAnalogCondition[] = [];
      if (channels >= 8 && channels <= 32 && group.kind !== 'none' && rng() < 0.4) {
        const count = 1 + Math.floor(rng() * 2);
        for (let i = 0; i < count; i++) {
          analog.push({
            start: 8 * Math.floor(rng() * (channels / 8)),
            kind: rng() < 0.5 ? 'rising' : 'falling',
            // 1..254 keeps the unreachable endpoints out of the oracle.
            level: 1 + Math.floor(rng() * 254),
          });
        }
      }
      const optionalLimit = searchLimitSamples === undefined
        ? {}
        : { searchLimitSamples };
      const config: SoftwareTriggerConfig = {
        channels,
        conditions,
        ...(analog.length > 0 ? { analog } : {}),
        preTriggerSamples,
        maxSamples,
        ...optionalLimit,
      };
      const bps2 = bps;
      const raw = new Uint8Array(expectedBytes(channels, samples));
      const output: number[] = [];
      const trigger = new SoftwareTrigger({ config, emit: (chunk) => output.push(...chunk) });
      // Four chunking styles: one call, every byte separately, small fragments, and
      // fragments whose length is unrelated to bytesPerSample (mid-sample carries).
      const style = Math.floor(rng() * 4);
      let p = 0;
      while (p < raw.length) {
        const n = style === 0 ? raw.length
          : style === 1 ? 1
            : style === 2 ? 1 + Math.floor(rng() * 4)
              : 1 + Math.floor(rng() * (bps2 * 3 + 2));
        trigger.feed(raw.subarray(p, Math.min(raw.length, p + n)));
        p += n;
      }
      const got = trigger.stats;
      const want = referenceRun(samples, channels, {
        conditions, ...(analog.length > 0 ? { analog } : {}),
        preTriggerSamples, maxSamples, ...optionalLimit,
      });
      const same = output.length === want.output.length &&
        output.every((v, i) => v === want.output[i]) &&
        got.matched === want.matched && got.noTrigger === want.noTrigger &&
        got.complete === want.complete && got.emittedSamples === want.emittedSamples &&
        got.triggerSampleIndex === want.triggerSampleIndex &&
        got.inspectedSamples === want.inspectedSamples;
      if (!same) {
        firstFail = `seed ${seed}: ${channels}ch, ${sampleCount} samples, style ${style}, ` +
          `matched=${got.matched}/${want.matched}, noTrigger=${got.noTrigger}/${want.noTrigger}, ` +
          `complete=${got.complete}/${want.complete}, emitted=${got.emittedSamples}/${want.emittedSamples}, ` +
          `T=${got.triggerSampleIndex}/${want.triggerSampleIndex}, ` +
          `inspected=${got.inspectedSamples}/${want.inspectedSamples}, ` +
          `bytes=${output.length}/${want.output.length}`;
        break;
      }
      checked++;
    }
    results.push({
      name: group.name,
      pass: firstFail === '',
      detail: firstFail === '' ? `${checked} randomized cases` : firstFail,
    });
  }
  return results;
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

/** Bit-reverse a code into the raw input byte the ADC group carries. */
function analogRaw(code: number): number {
  let value = code;
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) {
    reversed = (reversed << 1) | (value & 1);
    value >>>= 1;
  }
  return reversed;
}

function analogResults(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };

  {
    // Codes ascend through 128; the sample that reaches it is the trigger.
    const codes = [100, 120, 128, 140];
    const raw = codes.map(analogRaw);
    const { output, trigger } = collect(8, raw, {
      conditions: [], analog: [{ start: 0, kind: 'rising', level: 128 }],
      preTriggerSamples: 1, maxSamples: 2, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [1, 1, 1, 1]);
    const want = expectedBytes(8, [raw[1]!, raw[2]!]);
    check('a rising ADC crossing fires on the first code at the level, across 1-byte feeds',
      trigger.matched && trigger.complete && trigger.triggerSampleIndex === 1 &&
      output.length === want.length && output.every((v, i) => v === want[i]),
      `T=${trigger.triggerSampleIndex}, bytes=${output.length}/${want.length}`);
  }

  {
    const codes = [140, 130, 129, 120];
    const raw = codes.map(analogRaw);
    const { output, trigger } = collect(8, raw, {
      conditions: [], analog: [{ start: 0, kind: 'falling', level: 128 }],
      preTriggerSamples: 1, maxSamples: 2, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [3, 1]);
    const want = expectedBytes(8, [raw[2]!, raw[3]!]);
    check('a falling ADC crossing fires on the first code at the level',
      trigger.matched && trigger.triggerSampleIndex === 1 &&
      output.length === want.length && output.every((v, i) => v === want[i]),
      `T=${trigger.triggerSampleIndex}, bytes=${output.length}/${want.length}`);
  }

  {
    // A1 (group start 8) lives in byte 1 of a 16-channel sample.
    const codes = [90, 95, 100, 130];
    const words = codes.map((code) => (analogRaw(code) << 8) | 0x01);
    const { output, trigger } = collect(16, words, {
      conditions: [], analog: [{ start: 8, kind: 'rising', level: 100 }],
      preTriggerSamples: 0, maxSamples: 1, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [2, 2]);
    const want = expectedBytes(16, [words[2]!]);
    check('an analog group in the high byte of a wide sample triggers on its own code',
      trigger.matched && trigger.triggerSampleIndex === 0 &&
      output.length === want.length && output.every((v, i) => v === want[i]),
      `T=${trigger.triggerSampleIndex}, bytes=${output.length}/${want.length}`);
  }

  {
    // The digital edge and the ADC crossing must happen on the same sample.
    const noMatch = [80, 90, 100, 110, 120];
    const d0 =      [0,  0,  0,   1,   1];
    const wordsNo = noMatch.map((code, i) => analogRaw(code) | ((d0[i] ? 1 : 0) << 8));
    const missed = collect(16, wordsNo, {
      conditions: [{ channel: 8, kind: 'rising' }],
      analog: [{ start: 0, kind: 'rising', level: 100 }],
      preTriggerSamples: 0, maxSamples: 2, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [4, 4]);
    const yes = [80, 90, 95, 100];
    const dy =  [0,  0,  0,  1];
    const wordsYes = yes.map((code, i) => analogRaw(code) | ((dy[i] ? 1 : 0) << 8));
    const { output, trigger } = collect(16, wordsYes, {
      conditions: [{ channel: 8, kind: 'rising' }],
      analog: [{ start: 0, kind: 'rising', level: 100 }],
      preTriggerSamples: 1, maxSamples: 2, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [3, 1]);
    const want = expectedBytes(16, [wordsYes[2]!, wordsYes[3]!]);
    check('digital and analog conditions are ANDed on the same sample',
      missed.trigger.noTrigger && !missed.trigger.matched &&
      trigger.matched && trigger.triggerSampleIndex === 1 &&
      output.length === want.length && output.every((v, i) => v === want[i]),
      `missed=${missed.trigger.noTrigger}, matched=${trigger.matched}, T=${trigger.triggerSampleIndex}`);
  }

  {
    // Two groups must cross together; crossing one sample apart must not match.
    const a0 = [80, 90, 100, 110, 120];
    const apartA1 = [70, 80, 90, 100, 110];
    const wordsApart = a0.map((code, i) =>
      analogRaw(code) | (analogRaw(apartA1[i]!) << 8));
    const apart = collect(16, wordsApart, {
      conditions: [], analog: [
        { start: 0, kind: 'rising', level: 100 },
        { start: 8, kind: 'rising', level: 100 },
      ],
      preTriggerSamples: 0, maxSamples: 2, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [5]);
    const sameA1 = [80, 90, 100, 110, 120];
    const wordsSame = a0.map((code, i) =>
      analogRaw(code) | (analogRaw(sameA1[i]!) << 8));
    const same = collect(16, wordsSame, {
      conditions: [], analog: [
        { start: 0, kind: 'rising', level: 100 },
        { start: 8, kind: 'rising', level: 100 },
      ],
      preTriggerSamples: 0, maxSamples: 1, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [5]);
    check('multiple ADC groups are ANDed together',
      apart.trigger.noTrigger && same.trigger.matched &&
      same.trigger.triggerSampleIndex === 0,
      `apart=${apart.trigger.noTrigger}, same=${same.trigger.matched}@${same.trigger.triggerSampleIndex}`);
  }

  {
    // A gap resets the crossing state: a code above the level after the gap is not an edge.
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, conditions: [], analog: [{ start: 0, kind: 'rising', level: 100 }],
        preTriggerSamples: 0, maxSamples: 1, searchLimitSamples: Number.POSITIVE_INFINITY,
      },
      emit: (chunk) => emitted.push(...chunk),
    });
    trigger.feed(Uint8Array.from([analogRaw(90)]));
    trigger.resetContinuity();
    trigger.feed(Uint8Array.from([analogRaw(120)]));
    trigger.finish();
    check('resetContinuity forgets the previous analog code',
      trigger.stats.noTrigger && !trigger.stats.matched && emitted.length === 0,
      `noTrigger=${trigger.stats.noTrigger}`);
  }

  {
    const raw = [90, 100, 120].map(analogRaw);
    const one = collect(8, raw, {
      conditions: [], analog: [{ start: 0, kind: 'rising', level: 100 }],
      preTriggerSamples: 0, maxSamples: 1, searchLimitSamples: 1,
    }, [3]);
    const two = collect(8, raw, {
      conditions: [], analog: [{ start: 0, kind: 'rising', level: 100 }],
      preTriggerSamples: 0, maxSamples: 1, searchLimitSamples: 2,
    }, [3]);
    check('the analog search budget is inclusive of its last sample',
      one.trigger.noTrigger && one.trigger.inspectedSamples === 1 &&
      two.trigger.matched && two.trigger.triggerSampleIndex === 0,
      `one=${one.trigger.noTrigger}/${one.trigger.inspectedSamples}, two=${two.trigger.matched}`);
  }

  {
    // A group in byte 3 of a 32-channel sample must address previousAnalog[3].
    const codes = [90, 95, 100, 130];
    const words = codes.map((code) => analogRaw(code) * 0x1000000);
    const { output, trigger } = collect(32, words, {
      conditions: [], analog: [{ start: 24, kind: 'rising', level: 100 }],
      preTriggerSamples: 0, maxSamples: 1, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [1, 1, 1, 1]);
    const want = expectedBytes(32, [words[2]!]);
    check('an analog group in byte 3 of a 32-channel sample triggers on its own code',
      trigger.matched && trigger.triggerSampleIndex === 0 &&
      output.length === want.length && output.every((v, i) => v === want[i]),
      `T=${trigger.triggerSampleIndex}, bytes=${output.length}/${want.length}`);
  }

  {
    // The analog byte itself is the carried byte when every feed is one byte.
    const codes = [90, 95, 100, 130];
    const words = codes.map((code) => (analogRaw(code) << 8) | 0x01);
    const { output, trigger } = collect(16, words, {
      conditions: [], analog: [{ start: 8, kind: 'rising', level: 100 }],
      preTriggerSamples: 0, maxSamples: 1, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [1, 1, 1, 1, 1, 1, 1, 1]);
    const want = expectedBytes(16, [words[2]!]);
    check('an analog condition across one-byte feeds sees only complete samples',
      trigger.matched && trigger.triggerSampleIndex === 0 &&
      output.length === want.length && output.every((v, i) => v === want[i]),
      `T=${trigger.triggerSampleIndex}, bytes=${output.length}/${want.length}`);
  }

  {
    // noteGap resets the crossing state and advances the budget without matching.
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, conditions: [], analog: [{ start: 0, kind: 'rising', level: 100 }],
        preTriggerSamples: 0, maxSamples: 10, searchLimitSamples: Number.POSITIVE_INFINITY,
      },
      emit: (chunk) => emitted.push(...chunk),
    });
    trigger.feed(Uint8Array.from([analogRaw(90)]));
    trigger.noteGap(1);
    trigger.feed(Uint8Array.from([analogRaw(120)]));
    trigger.finish();
    check('noteGap forgets the previous analog code', trigger.stats.noTrigger && emitted.length === 0,
      `noTrigger=${trigger.stats.noTrigger}`);
  }

  {
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, conditions: [], analog: [{ start: 0, kind: 'rising', level: 100 }],
        preTriggerSamples: 0, maxSamples: 10, searchLimitSamples: 2,
      },
      emit: () => undefined,
    });
    trigger.feed(Uint8Array.from([analogRaw(90)]));
    trigger.noteGap(1);
    check('a gap that exhausts the search budget ends the waiting state immediately',
      trigger.stats.noTrigger && !trigger.waiting,
      `noTrigger=${trigger.stats.noTrigger}, waiting=${trigger.waiting}`);
  }

  {
    const invalid = (config: SoftwareTriggerConfig): boolean => {
      try {
        new SoftwareTrigger({ config, emit: () => undefined });
        return false;
      } catch {
        return true;
      }
    };
    const base: SoftwareTriggerConfig = {
      channels: 8, conditions: [], analog: [{ start: 0, kind: 'rising', level: 128 }],
      preTriggerSamples: 0, maxSamples: 1,
    };
    const risingZero = invalid({ ...base, analog: [{ start: 0, kind: 'rising', level: 0 }] });
    const fallingFull = invalid({ ...base, analog: [{ start: 0, kind: 'falling', level: 255 }] });
    const bogusKind = invalid({
      ...base,
      conditions: [{ channel: 0, kind: 'bogus' as unknown as SoftwareTriggerKind }],
    });
    const unaligned = invalid({ ...base, analog: [{ start: 4, kind: 'rising', level: 128 }] });
    const pastWidth = invalid({ ...base, channels: 16, analog: [{ start: 16, kind: 'rising', level: 128 }] });
    const badLevel = invalid({ ...base, analog: [{ start: 0, kind: 'rising', level: 256 }] });
    const badAnalogKind = invalid({
      ...base, analog: [{ start: 0, kind: 'both' as unknown as 'rising', level: 128 }],
    });
    check('unreachable analog endpoints, bad groups, levels and kinds fail closed',
      risingZero && fallingFull && bogusKind && unaligned && pastWidth && badLevel && badAnalogKind,
      `rising0=${risingZero}, falling255=${fallingFull}, kind=${bogusKind}, ` +
      `unaligned=${unaligned}, past=${pastWidth}, level=${badLevel}, analogKind=${badAnalogKind}`);
  }

  {
    const codes = [90, 100, 110, 120];
    const raw = codes.map(analogRaw);
    const { output, trigger } = collect(8, raw, {
      conditions: [], analog: [{ start: 0, kind: 'rising', level: 100 }],
      preTriggerSamples: 0, maxSamples: Number.POSITIVE_INFINITY,
      searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [2, 2]);
    const want = expectedBytes(8, [raw[1]!, raw[2]!, raw[3]!]);
    check('an unbounded analog loop trigger keeps emitting after the crossing',
      trigger.matched && !trigger.complete && trigger.triggerSampleIndex === 0 &&
      output.length === want.length && output.every((v, i) => v === want[i]),
      `T=${trigger.triggerSampleIndex}, complete=${trigger.complete}, bytes=${output.length}/${want.length}`);
  }

  return results;
}

/**
 * Editing the trigger while the matcher waits must retune the active search in place:
 * same ring, same emitted-stream accounting, same inspected budget. Once it matches, the
 * capture's trigger is frozen and a retune is refused (the edit belongs to the next run).
 */
function reconfigureResults(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };
  const bytesFor = (channels: ChannelCount, samples: readonly number[]): Uint8Array =>
    Uint8Array.from(expectedBytes(channels, samples));
  const digital = (channels: ChannelCount, pre = 0): SoftwareTriggerConfig => ({
    channels,
    conditions: [{ channel: 7, kind: 'rising' }],
    preTriggerSamples: pre,
    maxSamples: Number.POSITIVE_INFINITY,
    searchLimitSamples: Number.POSITIVE_INFINITY,
  });

  {
    // Swap the digital condition while waiting. No sample is emitted before the match.
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: digital(8), emit: (chunk) => emitted.push(...chunk),
    });
    const raw = bytesFor(8, [0, 0, 0, 2]);
    trigger.feed(raw.subarray(0, 2));
    const waiting = !trigger.stats.matched && trigger.stats.emittedSamples === 0;
    const applied = trigger.reconfigure({
      ...digital(8), conditions: [{ channel: 1, kind: 'rising' }],
    });
    trigger.feed(raw.subarray(2));
    const stats = trigger.stats;
    check('a waiting digital matcher retunes to a new condition in place',
      waiting && applied && stats.matched && stats.triggerSampleIndex === 0 &&
      stats.emittedSamples === 1 && emitted.length === 1 && emitted[0] === 2,
      `waiting=${waiting}, applied=${applied}, matched=${stats.matched}, T=${stats.triggerSampleIndex}, bytes=${emitted.length}`);
  }

  {
    // Swap to an ADC crossing while the search is waiting (analog triggers are host-side).
    const channels: ChannelCount = 32;
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: digital(channels), emit: (chunk) => emitted.push(...chunk),
    });
    const raw = bytesFor(channels, [analogRaw(120), analogRaw(120), analogRaw(140)]);
    trigger.feed(raw.subarray(0, 4));
    const applied = trigger.reconfigure({
      channels,
      analog: [{ start: 0, kind: 'rising', level: 128 }],
      preTriggerSamples: 0,
      maxSamples: Number.POSITIVE_INFINITY,
      searchLimitSamples: Number.POSITIVE_INFINITY,
    });
    trigger.feed(raw.subarray(4));
    const stats = trigger.stats;
    check('a waiting matcher retunes from digital to an analog crossing',
      applied && stats.matched && stats.triggerSampleIndex === 0 && emitted.length === 4,
      `applied=${applied}, matched=${stats.matched}, T=${stats.triggerSampleIndex}, bytes=${emitted.length}`);
  }

  {
    // The retained prefix is history: changing the condition does not discard it.
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: { ...digital(8, 2), maxSamples: 4 }, emit: (chunk) => emitted.push(...chunk),
    });
    const raw = bytesFor(8, [0, 0, 0, 2]);
    trigger.feed(raw.subarray(0, 2));  // samples 0,1 are retained as the pre-trigger ring
    trigger.reconfigure({ ...digital(8, 2), maxSamples: 4, conditions: [{ channel: 1, kind: 'rising' }] });
    trigger.feed(raw.subarray(2));
    const stats = trigger.stats;
    check('a retune keeps the pre-trigger ring and its emitted-stream accounting',
      stats.matched && stats.triggerSampleIndex === 2 && emitted.length === 3 &&
      emitted[0] === 0 && emitted[1] === 0 && emitted[2] === 2,
      `T=${stats.triggerSampleIndex}, bytes=${JSON.stringify(emitted)}`);
  }

  {
    // Edge continuity restarts at the edit: a high sample right after the retune is not a
    // rising edge invented from the old condition's last sample.
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: { ...digital(8), conditions: [{ channel: 1, kind: 'rising' }] },
      emit: (chunk) => emitted.push(...chunk),
    });
    const raw = bytesFor(8, [0, 2, 0, 2]);
    trigger.feed(raw.subarray(0, 1));
    trigger.reconfigure({ ...digital(8), conditions: [{ channel: 1, kind: 'rising' }] });
    trigger.feed(raw.subarray(1, 2));
    const notYet = !trigger.stats.matched;
    trigger.feed(raw.subarray(2));
    const stats = trigger.stats;
    check('a retune resets edge continuity instead of inventing a crossing',
      notYet && stats.matched && stats.triggerSampleIndex === 0 && emitted[0] === 2,
      `notYet=${notYet}, matched=${stats.matched}, T=${stats.triggerSampleIndex}`);
  }

  {
    // The capture fixes the width, ring size and output budget; and a matched matcher is
    // frozen for the rest of its acquisition.
    const matchedBase: SoftwareTriggerConfig = {
      ...digital(8, 2), conditions: [{ channel: 1, kind: 'rising' }],
    };
    const trigger = new SoftwareTrigger({ config: matchedBase, emit: () => {} });
    const wrongWidth = trigger.reconfigure({
      ...digital(16, 2), conditions: [{ channel: 1, kind: 'rising' }],
    });
    const wrongRing = trigger.reconfigure({
      ...digital(8, 4), conditions: [{ channel: 1, kind: 'rising' }],
    });
    // Two holdoff samples fill the ring first, then the rising edge on D1 matches.
    const raw = bytesFor(8, [0, 0, 0, 2]);
    trigger.feed(raw);
    const afterMatch = trigger.reconfigure(matchedBase);
    const finished = new SoftwareTrigger({ config: digital(8, 0), emit: () => {} });
    finished.finish();
    const afterFinish = finished.reconfigure({
      ...digital(8, 0), conditions: [{ channel: 1, kind: 'rising' }],
    });
    check('a retune is refused for a different capture shape or after the match',
      !wrongWidth && !wrongRing && trigger.stats.matched && !afterMatch && !afterFinish,
      `width=${wrongWidth}, ring=${wrongRing}, matched=${trigger.stats.matched}, ` +
      `afterMatch=${afterMatch}, finished=${afterFinish}`);
  }

  return results;
}

/**
 * Continuous (Loop) mode is one matcher on the same emitted stream: after the first
 * match it re-arms, reports every later match by absolute emitted-stream index, and may
 * stride its scan for CPU. A strided candidate is refined at stride 1, so reported
 * indices must still be the exact crossing sample. These checks are deterministic and
 * cover the byte layouts and chunk boundaries the block scanner already supports.
 */
function continuousResults(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };
  const rawFor = (channels: ChannelCount, samples: readonly number[]): Uint8Array =>
    Uint8Array.from(expectedBytes(channels, samples));

  interface ContinuousRun {
    output: number[];
    stats: SoftwareTriggerStats;
    matches: number[];
  }

  /**
   * Feed `samples` in the given chunk sizes (empty = one block), collect emitted bytes and
   * match indices, and finish as a stopped capture would.
   */
  const run = (
    channels: ChannelCount,
    samples: readonly number[],
    config: Omit<SoftwareTriggerConfig, 'channels'>,
    chunks: readonly number[] = [],
    now?: () => number,
  ): ContinuousRun => {
    const raw = rawFor(channels, samples);
    const output: number[] = [];
    const matches: number[] = [];
    const trigger = new SoftwareTrigger({
      config: { ...config, channels },
      emit: (chunk) => { for (const byte of chunk) output.push(byte); },
      onMatch: (match) => matches.push(match.index),
      ...(now ? { now } : {}),
    });
    let p = 0;
    if (chunks.length === 0) {
      trigger.feed(raw);
    } else {
      let k = 0;
      while (p < raw.length) {
        const n = chunks[k++ % chunks.length]!;
        trigger.feed(raw.subarray(p, Math.min(raw.length, p + n)));
        p += n;
      }
    }
    trigger.finish();
    return { output, stats: trigger.stats, matches };
  };

  const base = (
    pre = 0,
  ): Omit<SoftwareTriggerConfig, 'channels'> => ({
    mode: 'continuous',
    conditions: [{ channel: 0, kind: 'rising' }],
    preTriggerSamples: pre,
    maxSamples: Number.POSITIVE_INFINITY,
    searchLimitSamples: Number.POSITIVE_INFINITY,
  });

  {
    const samples = [0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1];
    const got = run(8, samples, base(0));
    const want = expectedBytes(8, samples.slice(2));
    check('continuous mode re-arms and reports every rising edge',
      got.stats.matched && got.stats.matchCount === 4 &&
      got.stats.triggerSampleIndex === 0 && got.stats.lastTriggerSampleIndex === 9 &&
      got.matches.join(',') === '0,4,7,9' &&
      got.output.length === want.length && got.output.every((v, i) => v === want[i]),
      `matches=${got.matches.join(',')}, count=${got.stats.matchCount}, ` +
      `first=${got.stats.triggerSampleIndex}, last=${got.stats.lastTriggerSampleIndex}`);
  }

  {
    // The first trigger is still the ring's T; later indices are absolute positions in the
    // emitted stream, which starts at the retained prefix, not at device sample 0.
    const samples = [0, 0, 0, 1, 1, 0, 1];
    const got = run(8, samples, base(2));
    const want = expectedBytes(8, samples.slice(1));
    check('continuous matches keep the emitted-stream index after the pre-trigger shift',
      got.stats.triggerSampleIndex === 2 && got.matches.join(',') === '2,5' &&
      got.stats.matchCount === 2 && got.stats.lastTriggerSampleIndex === 5 &&
      got.output.length === want.length && got.output.every((v, i) => v === want[i]),
      `matches=${got.matches.join(',')}, T=${got.stats.triggerSampleIndex}, ` +
      `last=${got.stats.lastTriggerSampleIndex}`);
  }

  {
    // A live retune is part of Loop support: after the first match the matcher keeps
    // scanning, and the edit applies at the next sample with edge continuity reset.
    const emitted: number[] = [];
    const matches: number[] = [];
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, ...base(0),
      },
      emit: (chunk) => { for (const byte of chunk) emitted.push(byte); },
      onMatch: (match) => matches.push(match.index),
    });
    trigger.feed(rawFor(8, [0, 1]));
    const first = trigger.stats;
    const applied = trigger.reconfigure({
      channels: 8, ...base(0), conditions: [{ channel: 1, kind: 'rising' }],
    });
    const wrongWidth = trigger.reconfigure({
      channels: 16, ...base(0), conditions: [{ channel: 1, kind: 'rising' }],
    });
    const wrongMode = trigger.reconfigure({
      channels: 8, ...base(0), mode: 'one-shot', conditions: [{ channel: 1, kind: 'rising' }],
    });
    trigger.feed(rawFor(8, [0, 2, 0, 2]));
    const stats = trigger.stats;
    check('a continuous matcher retunes in place after its first match',
      first.matched && applied && !wrongWidth && !wrongMode && stats.matchCount === 3 &&
      matches.join(',') === '0,2,4' && stats.lastTriggerSampleIndex === 4,
      `applied=${applied}, width=${wrongWidth}, mode=${wrongMode}, ` +
      `matches=${matches.join(',')}, count=${stats.matchCount}`);
  }

  {
    // A retune that only changes `reportGapSamples` is tuning, not a new condition. The
    // matcher keeps edge continuity, so a rising edge straddling the edit (channel 0 is
    // low at the edit and high in the next feed) is still reported. Reinstalling the same
    // conditions or restarting the scan here would invent a null previous value and drop
    // that edge.
    const emitted: number[] = [];
    const matches: number[] = [];
    const trigger = new SoftwareTrigger({
      config: { channels: 8, ...base(0) },
      emit: (chunk) => { for (const byte of chunk) emitted.push(byte); },
      onMatch: (match) => matches.push(match.index),
    });
    trigger.feed(rawFor(8, [0, 1])); // first match at emitted 0
    trigger.feed(rawFor(8, [1, 0])); // emitted 1..2 stay high then fall
    const applied = trigger.reconfigure({
      channels: 8, ...base(0), reportGapSamples: 1,
    });
    trigger.feed(rawFor(8, [1])); // emitted 3: rising from the pre-edit low
    check('a reportGap-only retune preserves edge continuity across the edit',
      applied && trigger.stats.matchCount === 2 && matches.join(',') === '0,3' &&
      trigger.stats.lastTriggerSampleIndex === 3,
      `applied=${applied}, matches=${matches.join(',')}, ` +
      `count=${trigger.stats.matchCount}, emitted=${emitted.length}`);
  }

  {
    // The constructor clamps a prefix larger than the capture budget. A caller repeating
    // the original request on a live retune must compare against the clamped value, not
    // be refused because 10 != 4.
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, ...base(10), maxSamples: 5,
      },
      emit: () => {},
    });
    const applied = trigger.reconfigure({
      channels: 8, ...base(10), maxSamples: 5,
      conditions: [{ channel: 1, kind: 'rising' }],
    });
    check('a live retune accepts the prefix request the constructor clamped',
      applied && trigger.stats.emittedSamples === 0 && !trigger.stats.matched,
      `applied=${applied}, emitted=${trigger.stats.emittedSamples}`);
  }

  {
    // The bounded history ring and refinement scratch share the prefix byte cap. A
    // maximum stride that would allocate more is refused at construction, and a live
    // retune that requests it returns false without disturbing the running matcher.
    let rejected = false;
    const matches: number[] = [];
    try {
      new SoftwareTrigger({
        config: {
          channels: 128,
          conditions: [{ channel: 0, kind: 'rising' }],
          mode: 'continuous',
          preTriggerSamples: 0,
          maxSamples: Number.POSITIVE_INFINITY,
          searchLimitSamples: Number.POSITIVE_INFINITY,
          scan: { maxStride: 3_000_000 },
        },
        emit: () => {},
      });
    } catch {
      rejected = true;
    }
    const trigger = new SoftwareTrigger({
      config: {
        channels: 128,
        conditions: [{ channel: 0, kind: 'rising' }],
        mode: 'continuous',
        preTriggerSamples: 0,
        maxSamples: Number.POSITIVE_INFINITY,
        searchLimitSamples: Number.POSITIVE_INFINITY,
        scan: { initialStride: 1, minStride: 1, maxStride: 4 },
      },
      emit: () => {},
      onMatch: (match) => matches.push(match.index),
    });
    const bytes = (value: number): Uint8Array => {
      const raw = new Uint8Array(16);
      raw[0] = value;
      return raw;
    };
    trigger.feed(bytes(0));
    trigger.feed(bytes(1)); // first match at emitted 0
    const refused = trigger.reconfigure({
      channels: 128,
      conditions: [{ channel: 0, kind: 'rising' }],
      mode: 'continuous',
      preTriggerSamples: 0,
      maxSamples: Number.POSITIVE_INFINITY,
      reportGapSamples: 1000,
      scan: { initialStride: 1, minStride: 1, maxStride: 3_000_000 },
    });
    trigger.feed(bytes(0));
    trigger.feed(bytes(1)); // emitted 2
    trigger.feed(bytes(0));
    trigger.feed(bytes(1)); // emitted 4
    // The refused retune leaves stride 1 in force, so both edges are reported. It must
    // also leave reportGapSamples at 0: a refused retune may not partially apply, or the
    // second callback would be throttled by the rejected 1000-sample gap.
    check('an oversized scan stride is refused at construction and on retune',
      rejected && !refused && trigger.stats.matchCount === 3 &&
      trigger.stats.lastTriggerSampleIndex === 4 && matches.join(',') === '0,2,4',
      `constructor=${rejected}, retune=${refused}, ` +
      `count=${trigger.stats.matchCount}, last=${trigger.stats.lastTriggerSampleIndex}, ` +
      `matches=${matches.join(',')}`);
  }

  {
    // Stride 4 skips samples, but a candidate hit is refined at stride 1: the reported
    // index is the exact rising sample, not the candidate that noticed it.
    const samples: number[] = new Array(40).fill(0);
    samples[1] = 1;
    for (let i = 8; i < 14; i++) samples[i] = 1;
    for (let i = 24; i < 30; i++) samples[i] = 1;
    const config = {
      ...base(0),
      scan: { initialStride: 4, minStride: 4, maxStride: 4 },
    };
    const whole = run(8, samples, config);
    const split = run(8, samples, config, [3, 5, 1, 7]);
    // Same expected indices across 16-bit samples split into odd byte fragments: stride
    // refinement must not see a half sample or lose the one carried between feeds.
    const wide = run(16, samples, config, [1, 1, 3, 2, 5]);
    const pass = whole.matches.join(',') === '0,7,23' &&
      split.matches.join(',') === '0,7,23' &&
      wide.matches.join(',') === '0,7,23' &&
      whole.stats.scanStride === 4 && split.stats.scanStride === 4 &&
      wide.stats.scanStride === 4 &&
      whole.stats.matchCount === 3 && split.stats.matchCount === 3 &&
      wide.stats.matchCount === 3;
    check('a strided continuous scan refines every match to its exact sample',
      pass,
      `whole=${whole.matches.join(',')} split=${split.matches.join(',')} ` +
      `wide=${wide.matches.join(',')} ` +
      `stride=${whole.stats.scanStride}/${split.stats.scanStride}/${wide.stats.scanStride}`);
  }

  {
    // Square wave, period 16 (8 low, 8 high). With stride 4 every rising edge is seen, so
    // the reported spacing must be exactly 16 emitted samples.
    const samples = Array.from({ length: 128 }, (_, i) => (((i >> 3) & 1) ? 1 : 0));
    const got = run(8, samples, {
      ...base(0), scan: { initialStride: 4, minStride: 4, maxStride: 4 },
    });
    const want = [0, 16, 32, 48, 64, 80, 96, 112];
    check('a strided square wave reports exact, evenly spaced rising edges',
      got.matches.join(',') === want.join(',') && got.stats.matchCount === want.length,
      `matches=${got.matches.join(',')}`);
  }

  {
    // ADC "sine" (a triangle, same crossings): every code that first reaches the level is
    // the reported sample. strided cross-check of the bit-reversed byte path.
    const triangle = [64, 96, 128, 160, 192, 160, 128, 96];
    const count = 80;
    const samples = Array.from({ length: count }, (_, i) => analogRaw(triangle[i % 8]!));
    const got = run(32, samples, {
      conditions: [],
      analog: [{ start: 0, kind: 'rising', level: 128 }],
      mode: 'continuous',
      preTriggerSamples: 0,
      maxSamples: Number.POSITIVE_INFINITY,
      searchLimitSamples: Number.POSITIVE_INFINITY,
      scan: { initialStride: 4, minStride: 4, maxStride: 4 },
    });
    // With preTriggerSamples 0 the first match is emitted index 0; every later rising
    // edge is 8 emitted samples after the previous one.
    const want: number[] = [];
    for (let i = 0; i < 10; i++) want.push(i * 8);
    check('a strided analog crossing reports the exact first code at the level',
      got.matches.join(',') === want.join(',') && got.stats.matchCount === want.length,
      `matches=${got.matches.join(',')} want=${want.join(',')}`);
  }

  {
    // Reporting throttle: the first match always fires, later ones only when they are at
    // least reportGapSamples apart. Statistics still count every match.
    const samples = [0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1];
    const got = run(8, samples, { ...base(0), reportGapSamples: 3 });
    check('reportGapSamples throttles callbacks but not match statistics',
      got.matches.join(',') === '0,4,7' && got.stats.matchCount === 4 &&
      got.stats.lastTriggerSampleIndex === 9 &&
      got.stats.lastTriggerSampleIndex !== null &&
      got.stats.triggerSampleIndex === 0,
      `reported=${got.matches.join(',')}, count=${got.stats.matchCount}, ` +
      `last=${got.stats.lastTriggerSampleIndex}`);
  }

  {
    // One shot is untouched: the same matcher stops at the first match and reports once.
    const samples = [0, 0, 1, 0, 1, 1];
    const explicit = run(8, samples, {
      conditions: [{ channel: 0, kind: 'rising' }],
      mode: 'one-shot', preTriggerSamples: 0,
      maxSamples: Number.POSITIVE_INFINITY,
      searchLimitSamples: Number.POSITIVE_INFINITY,
    });
    const implied = run(8, samples, {
      conditions: [{ channel: 0, kind: 'rising' }],
      preTriggerSamples: 0, maxSamples: Number.POSITIVE_INFINITY,
      searchLimitSamples: Number.POSITIVE_INFINITY,
    });
    check('one-shot mode (explicit or default) still reports exactly one match',
      explicit.matches.join(',') === '0' && explicit.stats.matchCount === 1 &&
      explicit.stats.lastTriggerSampleIndex === 0 &&
      implied.matches.join(',') === '0' && implied.stats.matchCount === 1,
      `explicit=${explicit.matches.join(',')} implied=${implied.matches.join(',')}`);
  }

  {
    // Level is not a one-shot latch in continuous mode: every emitted sample that still
    // holds the level is its own match. Callers that want once-per-pulse semantics use a
    // rising/falling condition (or reportGapSamples to throttle the callbacks).
    const level = run(8, [0, 1, 1, 0, 1], {
      ...base(0), conditions: [{ channel: 0, kind: 'level', level: 1 }],
    });
    const falling = run(8, [1, 0, 0, 1, 0, 1, 0], {
      ...base(0), conditions: [{ channel: 0, kind: 'falling' }],
    });
    const edge = run(8, [0, 1, 0, 0, 1], {
      ...base(0), conditions: [{ channel: 0, kind: 'edge' }],
    });
    check('continuous level, falling and edge conditions match every later transition',
      level.matches.join(',') === '0,1,3' && level.stats.matchCount === 3 &&
      falling.matches.join(',') === '0,3,5' && falling.stats.matchCount === 3 &&
      edge.matches.join(',') === '0,1,3' && edge.stats.matchCount === 3,
      `level=${level.matches.join(',')} falling=${falling.matches.join(',')} ` +
      `edge=${edge.matches.join(',')}`);
  }

  {
    // Two conditions are ANDed against the same sample: a rising edge on channel 0 only
    // counts while channel 1 is already high. Channel 1 falls between the two edges.
    const and = run(8, [0, 2, 3, 1, 2, 3], {
      ...base(0),
      conditions: [
        { channel: 0, kind: 'rising' },
        { channel: 1, kind: 'level', level: 1 },
      ],
    });
    check('continuous AND conditions match only when every condition holds',
      and.matches.join(',') === '0,3' && and.stats.matchCount === 2 &&
      and.stats.lastTriggerSampleIndex === 3,
      `matches=${and.matches.join(',')} count=${and.stats.matchCount}`);
  }

  {
    // A strided candidate is evaluated against the state left at the PREVIOUS candidate.
    // Here channel 0 falls while channel 1 is low (index 6), and channel 1 only goes high
    // one sample later. The candidate at index 8 therefore looks like a simultaneous
    // falling edge and level, but no single sample satisfies both. Refinement at stride 1
    // must reject it instead of reporting the candidate.
    const samples = [3, 2, 0, 1, 3, 3, 0, 2, 2];
    const conditions = [
      { channel: 0, kind: 'falling' as const },
      { channel: 1, kind: 'level' as const, level: 1 as const },
    ];
    const exact = run(8, samples, { ...base(0), conditions });
    const strided = run(8, samples, {
      ...base(0), conditions,
      scan: { initialStride: 2, minStride: 2, maxStride: 2 },
    });
    check('a strided AND candidate that only matched stale state is not reported',
      exact.matches.join(',') === '0' && exact.stats.matchCount === 1 &&
      strided.matches.join(',') === exact.matches.join(',') &&
      strided.stats.matchCount === exact.stats.matchCount &&
      strided.output.join(',') === exact.output.join(','),
      `exact=${exact.matches.join(',')}/${exact.stats.matchCount}, ` +
      `strided=${strided.matches.join(',')}/${strided.stats.matchCount}`);
  }

  {
    // The same stale-state trap for a mixed digital+analog AND: channel 0 rises at index
    // 10 and the ADC crosses its level at index 9, but each happens while the other
    // condition is false. A strided candidate later sees both previous states and would
    // report the candidate; stride-1 refinement must return no match. 16 channels puts
    // the ADC group in the second byte of the little-endian sample.
    const words = [
      // index: digital bit 0 in byte 0; ADC code in byte 1.
      64 * 256 + 0, // 0: both low
      140 * 256 + 1, // 1: both rise together - the genuine first match
      64 * 256 + 0, // 2: both reset
      140 * 256 + 0, // 3: ADC alone crosses up
      64 * 256 + 1, // 4: digital alone rises as the ADC falls
      140 * 256 + 1, // 5: both already high - no crossing here
    ].map((word) => (analogRaw(word >>> 8) << 8) | (word & 0xff));
    const conditions = [{ channel: 0, kind: 'rising' as const }];
    const analog = [{ start: 8, kind: 'rising' as const, level: 128 }];
    const exact = run(16, words, { ...base(0), conditions, analog });
    const strided = run(16, words, {
      ...base(0), conditions, analog,
      scan: { initialStride: 2, minStride: 2, maxStride: 2 },
    });
    check('a strided mixed digital/analog candidate is verified at stride 1',
      exact.matches.join(',') === '0' && exact.stats.matchCount === 1 &&
      strided.matches.join(',') === exact.matches.join(',') &&
      strided.stats.matchCount === exact.stats.matchCount &&
      strided.output.join(',') === exact.output.join(','),
      `exact=${exact.matches.join(',')}/${exact.stats.matchCount}, ` +
      `strided=${strided.matches.join(',')}/${strided.stats.matchCount}`);
  }

  {
    // Positive form of the two checks above: a later crossing that both AND conditions
    // genuinely share is still found by a strided scan and reported at its exact sample,
    // not at the candidate that noticed it.
    const samples = [3, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 2];
    const conditions = [
      { channel: 0, kind: 'falling' as const },
      { channel: 1, kind: 'level' as const, level: 1 as const },
    ];
    const exact = run(8, samples, { ...base(0), conditions });
    const strided = run(8, samples, {
      ...base(0), conditions,
      scan: { initialStride: 2, minStride: 2, maxStride: 2 },
    });
    check('a strided AND scan reports a later shared crossing at its exact sample',
      exact.matches.join(',') === '0,10' && exact.stats.matchCount === 2 &&
      strided.matches.join(',') === exact.matches.join(',') &&
      strided.stats.matchCount === exact.stats.matchCount &&
      strided.stats.lastTriggerSampleIndex === 10,
      `exact=${exact.matches.join(',')}/${exact.stats.matchCount}, ` +
      `strided=${strided.matches.join(',')}/${strided.stats.matchCount}`);
  }

  {
    // Same positive check for a mixed digital+analog AND at 16 channels: channel 0 and
    // the ADC group both rise together at emitted sample 4.
    const words = [
      64 * 256 + 0, // 0: both low
      140 * 256 + 1, // 1: both rise together - trigger
      64 * 256 + 0, // 2: reset
      64 * 256 + 0, // 3: still low
      64 * 256 + 0, // 4: still low
      140 * 256 + 1, // 5: both rise together - the later shared crossing
    ].map((word) => (analogRaw(word >>> 8) << 8) | (word & 0xff));
    const conditions = [{ channel: 0, kind: 'rising' as const }];
    const analog = [{ start: 8, kind: 'rising' as const, level: 128 }];
    const exact = run(16, words, { ...base(0), conditions, analog });
    const strided = run(16, words, {
      ...base(0), conditions, analog,
      scan: { initialStride: 2, minStride: 2, maxStride: 2 },
    });
    check('a strided mixed scan reports a later shared crossing at its exact sample',
      exact.matches.join(',') === '0,4' && exact.stats.matchCount === 2 &&
      strided.matches.join(',') === exact.matches.join(',') &&
      strided.stats.matchCount === exact.stats.matchCount &&
      strided.stats.lastTriggerSampleIndex === 4,
      `exact=${exact.matches.join(',')}/${exact.stats.matchCount}, ` +
      `strided=${strided.matches.join(',')}/${strided.stats.matchCount}`);
  }

  {
    // A continuous stream that never matches still ends as `not-found`, with the same
    // zero output and null trigger positions as one-shot.
    const none = run(8, [0, 0, 0, 0], base(0));
    check('a continuous stream with no match reports not-found and emits nothing',
      none.stats.noTrigger && !none.stats.matched && none.stats.matchCount === 0 &&
      none.stats.triggerSampleIndex === null && none.stats.lastTriggerSampleIndex === null &&
      none.output.length === 0 && none.stats.scanStride === 1,
      `noTrigger=${none.stats.noTrigger}, matches=${none.stats.matchCount}, ` +
      `output=${none.output.length}`);
  }

  {
    // The scan cannot be reconfigured once a finite continuous stream has emitted its
    // whole budget; the edit belongs to the next acquisition.
    const trigger = new SoftwareTrigger({
      config: { channels: 8, ...base(0), maxSamples: 1 },
      emit: () => {},
    });
    trigger.feed(rawFor(8, [0, 1]));
    const applied = trigger.reconfigure({
      channels: 8, ...base(0), maxSamples: 1,
      conditions: [{ channel: 1, kind: 'rising' }],
    });
    check('a completed continuous stream refuses a live retune',
      trigger.stats.complete && !applied && trigger.stats.matchCount === 1,
      `complete=${trigger.stats.complete}, applied=${applied}`);
  }

  {
    // A live retune may shrink maxStride after a long run has rotated the history ring.
    // The ring restarts at the next sample, and a candidate that spans the following
    // transfer still refines to the exact crossing sample from the bounded history.
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, ...base(0),
        scan: { initialStride: 5, minStride: 1, maxStride: 1024 },
      },
      emit: () => {},
    });
    trigger.feed(rawFor(8, [0, 1])); // first match; emitted index 0
    for (let i = 0; i < 300; i++) trigger.feed(new Uint8Array(6)); // rotate the ring
    const applied = trigger.reconfigure({
      channels: 8, ...base(0),
      scan: { initialStride: 5, minStride: 1, maxStride: 5 },
    });
    trigger.feed(new Uint8Array(6));
    trigger.feed(rawFor(8, [0, 0, 0, 0, 0, 1]));
    trigger.feed(rawFor(8, [1]));
    check('a live stride shrink restarts the history ring and still refines exactly',
      applied && trigger.stats.matchCount === 2 &&
      trigger.stats.scanStride === 5 &&
      trigger.stats.lastTriggerSampleIndex === 1812,
      `applied=${applied}, count=${trigger.stats.matchCount}, ` +
      `stride=${trigger.stats.scanStride}, last=${trigger.stats.lastTriggerSampleIndex}`);
  }

  {
    // Every wire width, with the trigger on the highest channel of the sample. Samples
    // arrive in fragments unrelated to the sample size, so the high byte and the carried
    // partial sample are both exercised. Widths above 32 need raw bytes: a JS word shift
    // is modulo 32 and cannot express those channels.
    let allWidths = true;
    const detail: string[] = [];
    for (const channels of [4, 8, 16, 32, 64, 128] as const) {
      const channel = channels - 1;
      const bps = bytesPerSampleForChannels(channels);
      const sample = (on: boolean): Uint8Array => {
        const bytes = new Uint8Array(bps);
        if (on) bytes[channel >>> 3] = 1 << (channel & 7);
        return bytes;
      };
      // 0, 0, high, high, 0, high: rising edges at device samples 2 and 5.
      const stream = [sample(false), sample(false), sample(true), sample(true),
        sample(false), sample(true)];
      const raw = new Uint8Array(stream.length * bps);
      stream.forEach((s, i) => raw.set(s, i * bps));
      const expectedRaw = new Uint8Array(4 * bps);
      expectedRaw.set(raw.subarray(2 * bps));
      const output: number[] = [];
      const matches: number[] = [];
      const trigger = new SoftwareTrigger({
        config: {
          channels, mode: 'continuous',
          conditions: [{ channel, kind: 'rising' }],
          preTriggerSamples: 0,
          maxSamples: Number.POSITIVE_INFINITY,
          searchLimitSamples: Number.POSITIVE_INFINITY,
        },
        emit: (chunk) => { for (const byte of chunk) output.push(byte); },
        onMatch: (match) => matches.push(match.index),
      });
      const sizes = [1, bps - 1, 3, 1, 5];
      let p = 0;
      let k = 0;
      while (p < raw.length) {
        const n = Math.min(sizes[k++ % sizes.length]!, raw.length - p);
        trigger.feed(raw.subarray(p, p + n));
        p += n;
      }
      const ok = matches.join(',') === '0,3' && trigger.stats.matchCount === 2 &&
        trigger.stats.lastTriggerSampleIndex === 3 &&
        output.length === expectedRaw.length &&
        output.every((v, i) => v === expectedRaw[i]);
      if (!ok) allWidths = false;
      detail.push(`${channels}ch:${ok ? 'ok' : `matches=${matches.join(',')}`}`);
    }
    check('continuous matching reaches the high channel at 4/8/16/32/64/128 channels',
      allWidths, detail.join(' '));
  }

  {
    // Strided exactness on the wide layouts too: 64/128-channel samples are 8/16 bytes,
    // and the crossing sits in byte 3 rather than the first. The rising edge is at emitted
    // sample 6, between candidates 4 and 7; the candidate at 7 sees it and refinement must
    // report the earlier exact sample.
    const detail: string[] = [];
    let pass = true;
    const high = 1 << 24; // channel 24 lives in byte 3 of every wide sample
    for (const channels of [64, 128] as const) {
      const samples = [0, 0, high, 0, 0, 0, 0, 0, high, high];
      const got = run(channels, samples, {
        ...base(0),
        conditions: [{ channel: 24, kind: 'rising' }],
        scan: { initialStride: 2, minStride: 2, maxStride: 2 },
      });
      const ok = got.matches.join(',') === '0,6' && got.stats.matchCount === 2 &&
        got.stats.lastTriggerSampleIndex === 6 && got.stats.scanStride === 2;
      if (!ok) pass = false;
      detail.push(`${channels}ch:${ok ? 'ok' : `matches=${got.matches.join(',')}`}`);
    }
    check('a strided wide-sample scan refines a crossing after byte 0',
      pass, detail.join(' '));
  }

  {
    // Whole-sample matching across fragmented transfers: 16-bit samples delivered one
    // byte at a time, with a match whose sample spans a boundary.
    const samples = [0, 0, 1, 0, 0, 1, 0, 1];
    const got = run(16, samples, base(1), [1]);
    const want = expectedBytes(16, samples.slice(1));
    check('continuous matching carries whole samples across byte-sized transfers',
      got.matches.join(',') === '1,4,6' && got.stats.matchCount === 3 &&
      got.output.length === want.length && got.output.every((v, i) => v === want[i]),
      `matches=${got.matches.join(',')} bytes=${got.output.length}/${want.length}`);
  }

  {
    // The emitted budget still bounds a continuous stream. The second match lands in the
    // post-trigger part and the third sample completes the capture.
    const samples = [0, 1, 0, 1, 0, 1];
    const got = run(8, samples, { ...base(0), maxSamples: 3 });
    check('a finite continuous budget stops emission at maxSamples',
      got.stats.complete && got.stats.emittedSamples === 3 &&
      got.stats.matchCount === 2 && got.matches.join(',') === '0,2' &&
      got.output.length === 3,
      `complete=${got.stats.complete}, emitted=${got.stats.emittedSamples}, ` +
      `matches=${got.matches.join(',')}`);
  }

  {
    // A finite budget can end between strided candidates. Stride 4 advances by 5, so after
    // candidates at emitted 1 and 6 the last samples (7..9) are never candidates. The
    // genuine rising edge at emitted 9 is in that tail and must still be refined at
    // stride 1 before the capture reports `complete`.
    const samples = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1];
    const got = run(8, samples, {
      ...base(0), maxSamples: 10,
      scan: { initialStride: 4, minStride: 4, maxStride: 4 },
    });
    const exact = run(8, samples, { ...base(0), maxSamples: 10 });
    check('a finite budget refines the samples after the final strided candidate',
      got.stats.complete && got.stats.emittedSamples === 10 &&
      got.matches.join(',') === '0,9' && got.stats.matchCount === 2 &&
      exact.matches.join(',') === got.matches.join(',') &&
      exact.stats.matchCount === got.stats.matchCount &&
      got.output.length === 10,
      `complete=${got.stats.complete}, emitted=${got.stats.emittedSamples}, ` +
      `matches=${got.matches.join(',')}/${got.stats.matchCount}, ` +
      `exact=${exact.matches.join(',')}/${exact.stats.matchCount}`);
  }

  {
    // Adaptive stride: the injected clock makes each scanned block deliberately slow, then
    // fast. The controller must grow the stride (bounded) and then walk it back to 1
    // without any change inside the hysteresis band.
    let clock = 0;
    let tickMs = 0;
    const now = (): number => {
      clock += tickMs;
      return clock;
    };
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8,
        conditions: [{ channel: 0, kind: 'rising' }],
        mode: 'continuous',
        preTriggerSamples: 0,
        maxSamples: Number.POSITIVE_INFINITY,
        searchLimitSamples: Number.POSITIVE_INFINITY,
        scan: {
          initialStride: 1, minStride: 1, maxStride: 16,
          nsPerStreamSample: 1, cpuFraction: 1, updateEverySamples: 4,
          step: 2, highWater: 1.25, lowWater: 0.5,
        },
      },
      emit: () => {},
      now,
    });
    trigger.feed(rawFor(8, [0, 1])); // first match at sample 1
    const zeroBlock = new Uint8Array(4);
    tickMs = 100; // 25 ms per stream sample against a 1e-6 ms budget
    for (let i = 0; i < 5; i++) trigger.feed(zeroBlock);
    const grown = trigger.stats.scanStride;
    tickMs = 0.000001; // 2.5e-7 ms per sample
    for (let i = 0; i < 5; i++) trigger.feed(zeroBlock);
    const shrunk = trigger.stats.scanStride;
    check('the stride controller grows under cost and shrinks back to the floor',
      grown > 1 && grown <= 16 && shrunk === 1,
      `grown=${grown}, shrunk=${shrunk}`);
  }

  {
    // Regression: the controller can shrink the stride between two blocks, so the last
    // candidate scheduled with the larger `scanStep()` can be reached while a match is
    // refined from the history ring at an index before the current block. Re-anchoring
    // with the new, smaller step must never schedule a candidate before `baseAbs`; a
    // negative offset would read past the block, wrap `lastScannedSample`, and invent a
    // later edge. The stream here grows the stride to 16, shrinks it to 8 after a block
    // that leaves the next candidate for the following block, and places the only pulses
    // in the skipped history samples.
    let clock = 0;
    let tickMs = 0;
    const now = (): number => {
      clock += tickMs;
      return clock;
    };
    const matches: number[] = [];
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8,
        conditions: [{ channel: 0, kind: 'edge' }],
        mode: 'continuous',
        preTriggerSamples: 0,
        maxSamples: Number.POSITIVE_INFINITY,
        searchLimitSamples: Number.POSITIVE_INFINITY,
        scan: {
          initialStride: 1, minStride: 1, maxStride: 16,
          nsPerStreamSample: 1, cpuFraction: 1, updateEverySamples: 4,
          step: 2, highWater: 1.25, lowWater: 0.5,
        },
      },
      emit: () => {},
      onMatch: (match) => matches.push(match.index),
      now,
    });
    // Emitted stream, index 0 is the trigger sample; the 0 that follows begins a pulse in
    // the samples skipped between the last stride-16 candidate and the next block.
    const stream = [1, ...new Array(16).fill(1), ...new Array(8).fill(1),
      0, ...new Array(16).fill(1), 1, 0, 1, 1, 1, 1, 1, 1];
    trigger.feed(Uint8Array.from([0, 1]));
    tickMs = 1000;
    for (let i = 0; i < 4; i++) trigger.feed(new Uint8Array(4).fill(1));
    const grown = trigger.stats.scanStride;
    trigger.feed(new Uint8Array(8).fill(1));
    tickMs = 0.000001;
    trigger.feed(Uint8Array.from([0, ...new Array(16).fill(1)]));
    const shrunk = trigger.stats.scanStride;
    tickMs = 1000;
    trigger.feed(Uint8Array.from([1, 0, 1, 1, 1, 1, 1, 1]));
    // Every reported index must be the trigger or a real edge of the emitted stream.
    const genuine = new Set<number>([0]);
    for (let i = 1; i < stream.length; i++) {
      if (stream[i] !== stream[i - 1]) genuine.add(i);
    }
    const sound = matches.every((index) => genuine.has(index));
    check('a stride shrink cannot re-anchor a candidate before the current block',
      grown === 16 && shrunk === 8 && sound && matches.length > 1 &&
      matches.length === trigger.stats.matchCount,
      `grown=${grown}, shrunk=${shrunk}, matches=${matches.join(',')}, ` +
      `genuine=${[...genuine].join(',')}`);
  }

  {
    // The controller never exceeds maxStride, and invalid policy values are refused
    // before a matcher starts rather than producing a nonsensical stride.
    let clock = 0;
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8,
        conditions: [{ channel: 0, kind: 'rising' }],
        mode: 'continuous',
        preTriggerSamples: 0,
        maxSamples: Number.POSITIVE_INFINITY,
        searchLimitSamples: Number.POSITIVE_INFINITY,
        scan: {
          initialStride: 3, minStride: 1, maxStride: 3,
          nsPerStreamSample: 1, cpuFraction: 1, updateEverySamples: 2, step: 2,
        },
      },
      emit: () => {},
      now: () => {
        clock += 1000;
        return clock;
      },
    });
    trigger.feed(rawFor(8, [0, 1]));
    for (let i = 0; i < 6; i++) trigger.feed(new Uint8Array(4));
    const capped = trigger.stats.scanStride;
    let bad = 0;
    const invalid: Omit<SoftwareTriggerConfig, 'channels'>[] = [
      { ...base(0), scan: { minStride: 0 } },
      { ...base(0), scan: { minStride: 4, maxStride: 2 } },
      { ...base(0), scan: { initialStride: 2, maxStride: 1 } },
      { ...base(0), reportGapSamples: -1 },
      { ...base(0), mode: 'looping' as never },
    ];
    for (const config of invalid) {
      try {
        new SoftwareTrigger({ config: { ...config, channels: 8 }, emit: () => {} });
      } catch {
        bad++;
      }
    }
    check('continuous-stride bounds and policy validation are enforced',
      capped === 3 && bad === invalid.length,
      `stride=${capped}, rejected=${bad}/${invalid.length}`);
  }

  {
    // Naive per-sample oracle for continuous mode at stride 1: after the first match the
    // whole stream is emitted and every later matching sample is reported at its
    // emitted-stream index. Randomized widths, condition sets, budgets, pre-trigger
    // windows, search limits and fragment styles exercise the carry and re-arm paths.
    const widths: ChannelCount[] = [4, 8, 16, 32];
    const kinds: SoftwareTriggerKind[] = ['level', 'rising', 'falling', 'edge'];
    let checked = 0;
    let firstFail = '';
    for (let seed = 1; seed <= 60 && firstFail === ''; seed++) {
      const rng = mulberry32(Math.imul(seed, 0x85ebca6b) ^ 0x27d4eb2f);
      const channels = widths[Math.floor(rng() * widths.length)]!;
      const bps = bytesPerSampleForChannels(channels);
      const sampleCount = 1 + Math.floor(rng() * 80);
      const samples: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        let word = 0;
        for (let b = 0; b < channels; b++) if (rng() < 0.5) word |= 1 << b;
        samples.push(word >>> 0);
      }
      const conditionCount = 1 + Math.floor(rng() * 3);
      const conditions: SoftwareTriggerCondition[] = [];
      for (let i = 0; i < conditionCount; i++) {
        const kind = kinds[Math.floor(rng() * kinds.length)]!;
        const channel = Math.floor(rng() * channels);
        conditions.push(kind === 'level'
          ? { channel, kind, level: (rng() < 0.5 ? 0 : 1) as 0 | 1 }
          : { channel, kind });
      }
      const maxSamples = rng() < 0.4 ? Number.POSITIVE_INFINITY : 1 + Math.floor(rng() * 15);
      const preTriggerSamples = Math.floor(rng() * 10);
      const searchLimitSamples = rng() < 0.5
        ? Number.POSITIVE_INFINITY
        : 1 + Math.floor(rng() * (sampleCount + 2));
      const config: Omit<SoftwareTriggerConfig, 'channels'> = {
        mode: 'continuous', conditions, preTriggerSamples, maxSamples, searchLimitSamples,
      };
      const raw = new Uint8Array(expectedBytes(channels, samples));
      const output: number[] = [];
      const matches: number[] = [];
      const trigger = new SoftwareTrigger({
        config: { ...config, channels },
        emit: (chunk) => { for (const byte of chunk) output.push(byte); },
        onMatch: (match) => matches.push(match.index),
      });
      const style = Math.floor(rng() * 4);
      let p = 0;
      while (p < raw.length) {
        const n = style === 0 ? raw.length
          : style === 1 ? 1
            : style === 2 ? 1 + Math.floor(rng() * 4)
              : 1 + Math.floor(rng() * (bps * 3 + 2));
        trigger.feed(raw.subarray(p, Math.min(raw.length, p + n)));
        p += n;
      }
      trigger.finish();
      const got = trigger.stats;

      // Oracle: walk the stream once at stride 1, exactly as the waiting scan does.
      const previous: Array<number | null> = Array.from({ length: channels }, () => null);
      const evaluate = (sample: number): boolean => {
        let matched = true;
        for (const c of conditions) {
          const value = (sample >>> c.channel) & 1;
          const old = previous[c.channel]!;
          const ok = c.kind === 'level' ? value === c.level
            : c.kind === 'rising' ? old === 0 && value === 1
              : c.kind === 'falling' ? old === 1 && value === 0
                : old !== null && old !== value;
          if (!ok) matched = false;
        }
        for (const c of conditions) previous[c.channel] = (sample >>> c.channel) & 1;
        return matched;
      };
      const pre = Math.min(
        preTriggerSamples,
        Math.max(0, maxSamples - 1),
        Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bps),
      );
      let first = -1;
      let inspected = 0;
      for (let i = 0; i < sampleCount; i++) {
        inspected++;
        // Pre-fill holdoff: the first match needs `pre` earlier samples.
        if (evaluate(samples[i]!) && i >= pre) { first = i; break; }
        if (inspected >= searchLimitSamples) break;
      }
      let wantMatches: number[] = [];
      let wantOutput: number[] = [];
      let wantComplete = false;
      let wantEmitted = 0;
      let wantFirst: number | null = null;
      let wantLast: number | null = null;
      let wantNoTrigger = false;
      if (first < 0) {
        // The caller finishes a stopped capture, which is not a match.
        wantNoTrigger = true;
      } else {
        const start = Math.max(0, first - pre);
        const end = Number.isFinite(maxSamples)
          ? Math.min(sampleCount, start + maxSamples)
          : sampleCount;
        const firstIndex = first - start;
        wantFirst = firstIndex;
        wantMatches = [firstIndex];
        for (let i = first + 1; i < end; i++) {
          if (evaluate(samples[i]!)) wantMatches.push(i - start);
        }
        wantLast = wantMatches[wantMatches.length - 1]!;
        wantEmitted = end - start;
        wantComplete = Number.isFinite(maxSamples) && wantEmitted >= maxSamples;
        wantOutput = expectedBytes(channels, samples.slice(start, end));
      }
      const same = output.length === wantOutput.length &&
        output.every((v, i) => v === wantOutput[i]) &&
        matches.join(',') === wantMatches.join(',') &&
        got.matchCount === wantMatches.length &&
        got.lastTriggerSampleIndex === wantLast &&
        got.triggerSampleIndex === wantFirst &&
        got.emittedSamples === wantEmitted &&
        got.complete === wantComplete &&
        got.noTrigger === wantNoTrigger &&
        got.matched === (first >= 0) &&
        got.inspectedSamples === (first >= 0 ? first + 1 : inspected) &&
        got.scanStride === 1;
      if (!same) {
        firstFail = `seed ${seed}: ${channels}ch ${sampleCount} samples style ${style} ` +
          `matches=${matches.join(',')}/${wantMatches.join(',')} ` +
          `first=${got.triggerSampleIndex}/${wantFirst} last=${got.lastTriggerSampleIndex}/${wantLast} ` +
          `emitted=${got.emittedSamples}/${wantEmitted} complete=${got.complete}/${wantComplete} ` +
          `noTrigger=${got.noTrigger}/${wantNoTrigger} ` +
          `inspected=${got.inspectedSamples}/${first >= 0 ? first + 1 : inspected}`;
        break;
      }
      checked++;
    }
    check('continuous mode matches a naive per-sample reference on random streams',
      firstFail === '', firstFail === '' ? `${checked} randomized cases` : firstFail);
  }

  return results;
}

/**
 * Pre-fill holdoff: after arming (and after a continuity reset) no match is accepted
 * until `preTriggerSamples` complete samples have been observed, so a dense trigger
 * signal still delivers the full configured prefix. Bit-level helpers here build raw
 * samples for any width, so the trigger channel can sit in the last byte of a wide
 * (64/128-channel) sample.
 */
function holdoffResults(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };
  /** Raw stream where `channel` follows `levels` and every other bit carries a
   * position tag (so a retained prefix is identifiable) without touching `channel`. */
  const rawStream = (
    channels: ChannelCount, channel: number, levels: readonly number[],
  ): Uint8Array => {
    const bps = bytesPerSampleForChannels(channels);
    const raw = new Uint8Array(levels.length * bps);
    for (let i = 0; i < levels.length; i++) {
      for (let b = 0; b < bps; b++) raw[i * bps + b] = (i * 37 + b * 11) & 0xff;
      const byte = i * bps + (channel >>> 3);
      const mask = 1 << (channel & 7);
      raw[byte] = levels[i] ? raw[byte]! | mask : raw[byte]! & ~mask;
    }
    return raw;
  };
  const runRaw = (
    raw: Uint8Array,
    config: SoftwareTriggerConfig,
    cuts: readonly number[] = [],
  ): { out: Uint8Array; stats: SoftwareTriggerStats; matches: number[] } => {
    const out: number[] = [];
    const matches: number[] = [];
    const trigger = new SoftwareTrigger({
      config,
      emit: (chunk) => { for (const v of chunk) out.push(v); },
      onMatch: (m) => matches.push(m.index),
    });
    let p = 0;
    for (const cut of cuts) {
      trigger.feed(raw.subarray(p, cut));
      p = cut;
    }
    trigger.feed(raw.subarray(p));
    return { out: Uint8Array.from(out), stats: trigger.stats, matches };
  };
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const widths: ChannelCount[] = [4, 8, 16, 32, 64, 128];

  {
    // Dense edges (a rise every 2 samples, the hardware's 50 us square wave in miniature)
    // at every width: T is the first edge at or after `pre`, the emitted stream is exactly
    // [T - pre, T - pre + max), and the prefix is the full configured window.
    let fail = '';
    for (const channels of widths) {
      const bps = bytesPerSampleForChannels(channels);
      const channel = channels - 1;
      const levels = Array.from({ length: 64 }, (_, i) => i & 1);
      for (const pre of [4, 5]) {
        const raw = rawStream(channels, channel, levels);
        const max = pre + 8;
        const got = runRaw(raw, {
          channels, conditions: [{ channel, kind: 'rising' }],
          preTriggerSamples: pre, maxSamples: max,
        });
        // Rises are at odd indices; the first one at or after `pre`.
        const deviceT = pre % 2 === 1 ? pre : pre + 1;
        const start = deviceT - pre;
        const want = raw.subarray(start * bps, (start + max) * bps);
        if (!(got.stats.matched && got.stats.triggerSampleIndex === pre &&
            got.stats.complete && got.stats.inspectedSamples === deviceT + 1 &&
            sameBytes(got.out, want))) {
          fail = `${channels}ch pre=${pre}: T=${got.stats.triggerSampleIndex} ` +
            `inspected=${got.stats.inspectedSamples} bytes=${got.out.length}/${want.length}`;
          break;
        }
      }
      if (fail) break;
    }
    check('holdoff: dense edges deliver the full pre-trigger window at every width',
      fail === '', fail || `${widths.length} widths, pre 4 and 5`);
  }

  {
    // Sparse edge: one rise long after the ring filled behaves as before.
    const levels = new Array<number>(80).fill(0);
    for (let i = 50; i < 80; i++) levels[i] = 1;
    const raw = rawStream(16, 9, levels);
    const got = runRaw(raw, {
      channels: 16, conditions: [{ channel: 9, kind: 'rising' }],
      preTriggerSamples: 10, maxSamples: 20, searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [7, 33, 61]);
    check('holdoff: a sparse edge keeps its full prefix (T = pre)',
      got.stats.triggerSampleIndex === 10 && got.stats.inspectedSamples === 51 &&
        sameBytes(got.out, raw.subarray(40 * 2, 60 * 2)),
      `T=${got.stats.triggerSampleIndex} inspected=${got.stats.inspectedSamples}`);
  }

  {
    // An edge whose new value is the first post-holdoff sample is valid: its predecessor
    // is the newest ring sample. Checked for every byte split of the stream (including
    // splits inside the boundary sample and inside the last holdoff sample) at every
    // width; all must agree with the unsplit run.
    let fail = '';
    let cases = 0;
    for (const channels of widths) {
      const bps = bytesPerSampleForChannels(channels);
      const channel = channels - 1;
      const pre = 3;
      const levels = [0, 0, 0, 1, 1, 0, 1, 1];
      const raw = rawStream(channels, channel, levels);
      const config: SoftwareTriggerConfig = {
        channels, conditions: [{ channel, kind: 'rising' }],
        preTriggerSamples: pre, maxSamples: 5,
      };
      const whole = runRaw(raw, config);
      if (!(whole.stats.triggerSampleIndex === pre && whole.stats.inspectedSamples === 4 &&
          sameBytes(whole.out, raw.subarray(0, 5 * bps)))) {
        fail = `${channels}ch whole: T=${whole.stats.triggerSampleIndex}`;
        break;
      }
      for (let cut = 1; cut < raw.length; cut++) {
        const split = runRaw(raw, config, [cut]);
        cases++;
        if (!(split.stats.triggerSampleIndex === pre &&
            split.stats.inspectedSamples === whole.stats.inspectedSamples &&
            sameBytes(split.out, whole.out))) {
          fail = `${channels}ch cut=${cut}: T=${split.stats.triggerSampleIndex}`;
          break;
        }
      }
      // Byte-by-byte delivery: every sample, including the boundary one, is carried.
      const bytewise = runRaw(raw, config, Array.from({ length: raw.length - 1 }, (_, i) => i + 1));
      cases++;
      if (!sameBytes(bytewise.out, whole.out) || bytewise.stats.triggerSampleIndex !== pre) {
        fail = `${channels}ch bytewise`;
      }
      if (fail) break;
    }
    check('holdoff: an edge exactly at the holdoff boundary matches across any transfer split',
      fail === '', fail || `${cases} split cases`);
  }

  {
    // The holdoff never invents an edge: a value that was already high when the window
    // filled is not a rising edge on the first post-holdoff sample.
    const raw = rawStream(8, 0, [0, 0, 1, 1, 1, 0, 1, 1]);
    const got = runRaw(raw, {
      channels: 8, conditions: [{ channel: 0, kind: 'rising' }],
      preTriggerSamples: 3, maxSamples: 5,
    }, [3]);
    check('holdoff: a level already high at the boundary is not a rising edge',
      got.stats.triggerSampleIndex === 3 && got.stats.inspectedSamples === 7 &&
        sameBytes(got.out, raw.subarray(3, 8)),
      `T=${got.stats.triggerSampleIndex} inspected=${got.stats.inspectedSamples}`);
  }

  {
    // Falling and edge kinds across the boundary use the same true predecessor.
    const falling = runRaw(rawStream(32, 20, [1, 1, 1, 0, 0, 0]), {
      channels: 32, conditions: [{ channel: 20, kind: 'falling' }],
      preTriggerSamples: 3, maxSamples: 4,
    }, [11]);
    const edge = runRaw(rawStream(32, 20, [0, 1, 0, 1, 0, 1]), {
      channels: 32, conditions: [{ channel: 20, kind: 'edge' }],
      preTriggerSamples: 3, maxSamples: 4,
    }, [5, 13]);
    check('holdoff: falling and edge triggers match on the first eligible transition',
      falling.stats.triggerSampleIndex === 3 && falling.stats.inspectedSamples === 4 &&
        edge.stats.triggerSampleIndex === 3 && edge.stats.inspectedSamples === 4,
      `falling T=${falling.stats.triggerSampleIndex}/${falling.stats.inspectedSamples} ` +
        `edge T=${edge.stats.triggerSampleIndex}/${edge.stats.inspectedSamples}`);
  }

  {
    // Level high / low true from sample 0 wait for the ring to fill (T == pre), with one
    // block and with a per-sample feed.
    let fail = '';
    for (const level of [0, 1] as const) {
      for (const cuts of [[], [1, 2, 3, 4, 5, 6]]) {
        const raw = rawStream(64, 63, new Array<number>(12).fill(level));
        const got = runRaw(raw, {
          channels: 64, conditions: [{ channel: 63, kind: 'level', level }],
          preTriggerSamples: 6, maxSamples: 9,
        }, cuts.map((c) => c * 8));
        if (!(got.stats.triggerSampleIndex === 6 && got.stats.inspectedSamples === 7 &&
            got.stats.complete && sameBytes(got.out, raw.subarray(0, 9 * 8)))) {
          fail = `level ${level} cuts=${cuts.length}: T=${got.stats.triggerSampleIndex}`;
        }
      }
    }
    check('holdoff: high/low level true from sample 0 waits for pre-fill', fail === '',
      fail || 'level 0 and 1, block and per-sample feeds');
  }

  {
    // pre = 0 has no holdoff: a level true at sample 0 is the trigger.
    const raw = rawStream(8, 2, [1, 1, 1]);
    const got = runRaw(raw, {
      channels: 8, conditions: [{ channel: 2, kind: 'level', level: 1 }],
      preTriggerSamples: 0, maxSamples: 2,
    });
    check('holdoff: pre-trigger 0 matches on the first sample',
      got.stats.triggerSampleIndex === 0 && got.stats.inspectedSamples === 1 &&
        sameBytes(got.out, raw.subarray(0, 2)),
      `T=${got.stats.triggerSampleIndex} inspected=${got.stats.inspectedSamples}`);
  }

  {
    // No trigger: a stream that only matches inside the holdoff never triggers; nothing is
    // emitted and the inspected count is the search budget.
    const raw = rawStream(16, 3, [0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    const got = runRaw(raw, {
      channels: 16, conditions: [{ channel: 3, kind: 'rising' }],
      preTriggerSamples: 4, maxSamples: 6,
    });
    check('holdoff: an edge only inside the holdoff is no trigger',
      got.stats.noTrigger && !got.stats.matched && got.out.length === 0 &&
        got.stats.inspectedSamples === 10 && got.matches.length === 0,
      `noTrigger=${got.stats.noTrigger} inspected=${got.stats.inspectedSamples}`);
  }

  {
    // Holdoff samples count toward the search limit: limit == pre can never match,
    // limit == pre + 1 allows exactly the first eligible sample.
    const raw = rawStream(8, 0, new Array<number>(10).fill(1));
    const config = (limit: number): SoftwareTriggerConfig => ({
      channels: 8, conditions: [{ channel: 0, kind: 'level', level: 1 }],
      preTriggerSamples: 4, maxSamples: 6, searchLimitSamples: limit,
    });
    const tooShort = runRaw(raw, config(4));
    const exact = runRaw(raw, config(5));
    check('holdoff: pre-fill samples are inspected and count toward the search limit',
      tooShort.stats.noTrigger && tooShort.stats.inspectedSamples === 4 &&
        exact.stats.matched && exact.stats.triggerSampleIndex === 4 &&
        exact.stats.inspectedSamples === 5,
      `short=${tooShort.stats.noTrigger}/${tooShort.stats.inspectedSamples} ` +
        `exact=${exact.stats.triggerSampleIndex}/${exact.stats.inspectedSamples}`);
  }

  {
    // A continuity reset mid-holdoff empties the ring and restarts the holdoff: the
    // prefix never spans the gap, and an edge cannot be formed across it.
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, conditions: [{ channel: 0, kind: 'rising' }],
        preTriggerSamples: 4, maxSamples: 6,
      },
      emit: (chunk) => emitted.push(...chunk),
    });
    trigger.feed(Uint8Array.from([0x10, 0x20])); // two of four holdoff samples, D0 low
    trigger.resetContinuity();
    // After the gap: D0 high at once (no edge across the gap), a rise at post-gap 2 that
    // is still inside the restarted holdoff, then a rise at post-gap 5.
    trigger.feed(Uint8Array.from([0x31, 0x40, 0x51, 0x60, 0x70, 0x81, 0x90]));
    const stats = trigger.stats;
    check('holdoff: a continuity reset mid-holdoff restarts the pre-fill',
      stats.matched && stats.triggerSampleIndex === 4 &&
        emitted.join(',') === [0x40, 0x51, 0x60, 0x70, 0x81, 0x90].join(','),
      `T=${stats.triggerSampleIndex} emitted=${emitted.map((v) => v.toString(16)).join(',')}`);
  }

  {
    // noteGap mid-holdoff: the lost samples advance the search budget but are not ring
    // samples, so the holdoff restarts after the gap.
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, conditions: [{ channel: 0, kind: 'level', level: 1 }],
        preTriggerSamples: 3, maxSamples: 5, searchLimitSamples: 100,
      },
      emit: () => {},
    });
    trigger.feed(Uint8Array.from([1, 1]));
    trigger.noteGap(10);
    trigger.feed(Uint8Array.from([1, 1, 1, 1]));
    const stats = trigger.stats;
    check('holdoff: noteGap mid-holdoff restarts the pre-fill and keeps budget accounting',
      stats.matched && stats.triggerSampleIndex === 3 &&
        stats.inspectedSamples === 2 + 10 + 4,
      `T=${stats.triggerSampleIndex} inspected=${stats.inspectedSamples}`);
  }

  {
    // A condition edit keeps the ring, so it does not restart the holdoff.
    const emitted: number[] = [];
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, conditions: [{ channel: 1, kind: 'rising' }],
        preTriggerSamples: 4, maxSamples: 6,
      },
      emit: (chunk) => emitted.push(...chunk),
    });
    trigger.feed(Uint8Array.from([0, 0]));
    const applied = trigger.reconfigure({
      channels: 8, conditions: [{ channel: 0, kind: 'level', level: 1 }],
      preTriggerSamples: 4, maxSamples: 6,
    });
    trigger.feed(Uint8Array.from([1, 1, 1, 1, 1]));
    const stats = trigger.stats;
    check('holdoff: a retune mid-holdoff keeps the ring and the remaining holdoff',
      applied && stats.triggerSampleIndex === 4 && stats.inspectedSamples === 5 &&
        emitted.join(',') === '0,0,1,1,1,1',
      `applied=${applied} T=${stats.triggerSampleIndex} emitted=${emitted.join(',')}`);
  }

  {
    // No trigger: level, falling and any-edge conditions that are true only inside the
    // holdoff never fire, under one block and under per-sample feeds. Nothing is emitted
    // and the whole default search budget (max + pre) is inspected.
    let fail = '';
    const cases: { kind: 'level' | 'falling' | 'edge'; levels: number[] }[] = [
      { kind: 'level', levels: [1, 1, 1, 1, 0, 0, 0, 0, 0, 0] },
      { kind: 'falling', levels: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { kind: 'edge', levels: [0, 1, 0, 1, 1, 1, 1, 1, 1, 1] },
    ];
    for (const { kind, levels } of cases) {
      for (const cuts of [[], [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
        const raw = rawStream(16, 3, levels);
        const got = runRaw(raw, {
          channels: 16,
          conditions: [{ channel: 3, kind, ...(kind === 'level' ? { level: 1 as const } : {}) }],
          preTriggerSamples: 4, maxSamples: 6,
        }, cuts.map((c) => c * 2));
        if (!(got.stats.noTrigger && !got.stats.matched && got.out.length === 0 &&
            got.stats.inspectedSamples === 10 && got.matches.length === 0)) {
          fail = `${kind} cuts=${cuts.length}: noTrigger=${got.stats.noTrigger} ` +
            `T=${got.stats.triggerSampleIndex} inspected=${got.stats.inspectedSamples}`;
        }
      }
    }
    check('holdoff: level/falling/any-edge true only inside the holdoff is no trigger',
      fail === '', fail || 'level, falling, edge; block and per-sample feeds');
  }

  {
    // An edge-condition retune mid-holdoff keeps the remaining holdoff: an edge inside
    // the rest of the holdoff is still ignored, and the predecessor of the first eligible
    // sample is the last holdoff sample observed after the retune.
    const run = (tail: number[]) => {
      const emitted: number[] = [];
      const trigger = new SoftwareTrigger({
        config: {
          channels: 8, conditions: [{ channel: 1, kind: 'rising' }],
          preTriggerSamples: 4, maxSamples: 6,
        },
        emit: (chunk) => emitted.push(...chunk),
      });
      trigger.feed(Uint8Array.from([0x10, 0x20])); // two holdoff samples, D0 low
      const applied = trigger.reconfigure({
        channels: 8, conditions: [{ channel: 0, kind: 'edge' }],
        preTriggerSamples: 4, maxSamples: 6,
      });
      trigger.feed(Uint8Array.from(tail));
      return {
        applied, stats: trigger.stats, emitted: emitted.map((v) => v.toString(16)).join(','),
      };
    };
    // Edge at 2 (held off); 3 -> 4 is a falling edge on the first eligible sample.
    const atBoundary = run([0x31, 0x41, 0x50, 0x60, 0x70, 0x80]);
    // Edge at 2 (held off); 4 keeps the level, so the next edge is 4 -> 5.
    const later = run([0x31, 0x41, 0x51, 0x60, 0x70, 0x80, 0x90]);
    check('holdoff: an edge retune mid-holdoff ignores held-off edges and keeps the boundary',
      atBoundary.applied && atBoundary.stats.triggerSampleIndex === 4 &&
        atBoundary.stats.inspectedSamples === 5 && atBoundary.emitted === '10,20,31,41,50,60' &&
        later.applied && later.stats.triggerSampleIndex === 4 &&
        later.stats.inspectedSamples === 6 && later.emitted === '20,31,41,51,60,70',
      `boundary T=${atBoundary.stats.triggerSampleIndex} emitted=${atBoundary.emitted}; ` +
        `later T=${later.stats.triggerSampleIndex} emitted=${later.emitted}`);
  }

  {
    // Repeat-style finite search: limit = pre + (pre + post), i.e. the holdoff plus one
    // sweep's sample budget (see `triggerSearchSamples`). An edge only in the first `pre`
    // samples is no trigger; an edge on the last inspectable sample (pre + post - 1 after
    // the holdoff) still matches; one sample later it is out of the budget.
    const pre = 4;
    const post = 6;
    const sweep = pre + post;
    const limit = pre + sweep;
    const config: SoftwareTriggerConfig = {
      channels: 32, conditions: [{ channel: 17, kind: 'rising' }],
      preTriggerSamples: pre, maxSamples: sweep, searchLimitSamples: limit,
    };
    const riseAt = (index: number): number[] =>
      Array.from({ length: limit + sweep }, (_, i) => (i >= index ? 1 : 0));
    const lastIndex = pre + (pre + post - 1);
    const early = runRaw(rawStream(32, 17, riseAt(1)), config, [12, 40]);
    const lastRaw = rawStream(32, 17, riseAt(lastIndex));
    const last = runRaw(lastRaw, config, [24]);
    const beyond = runRaw(rawStream(32, 17, riseAt(limit)), config);
    const start = lastIndex - pre;
    check('holdoff: a Repeat search limit pre + (pre + post) ignores holdoff edges, keeps the last sample',
      early.stats.noTrigger && early.out.length === 0 && early.stats.inspectedSamples === limit &&
        last.stats.matched && last.stats.triggerSampleIndex === pre &&
        last.stats.inspectedSamples === limit && last.stats.complete &&
        sameBytes(last.out, lastRaw.subarray(start * 4, (start + sweep) * 4)) &&
        beyond.stats.noTrigger && beyond.out.length === 0,
      `early=${early.stats.noTrigger}/${early.stats.inspectedSamples}, ` +
        `last T=${last.stats.triggerSampleIndex}/${last.stats.inspectedSamples}, ` +
        `beyond=${beyond.stats.noTrigger}`);
  }

  {
    // Continuous (Loop) mode: the holdoff applies to the first match only; later dense
    // matches are reported on the emitted stream as before.
    const raw = rawStream(8, 0, Array.from({ length: 16 }, (_, i) => i & 1));
    const got = runRaw(raw, {
      channels: 8, conditions: [{ channel: 0, kind: 'rising' }], mode: 'continuous',
      preTriggerSamples: 4, maxSamples: Number.POSITIVE_INFINITY,
      searchLimitSamples: Number.POSITIVE_INFINITY,
    }, [3, 6]);
    // Rises at 1,3,5,...; first eligible is 5, emitted from 1, so stream indices 4,6,...
    check('holdoff: continuous mode holds off only the first match',
      got.matches.join(',') === '4,6,8,10,12,14' && got.stats.matchCount === 6 &&
        sameBytes(got.out, raw.subarray(1)),
      `matches=${got.matches.join(',')} bytes=${got.out.length}`);
  }

  {
    // Analog crossing: the predecessor code comes from the last holdoff sample.
    const codes = [100, 100, 200, 100, 140, 150];
    const raw = Uint8Array.from(codes.map((c) => analogRaw(c)));
    const got = runRaw(raw, {
      channels: 8, analog: [{ start: 0, kind: 'rising', level: 128 }],
      preTriggerSamples: 3, maxSamples: 5,
    }, [3]);
    // The 100->200 crossing at index 2 is held off; 100->140 at index 4 triggers.
    check('holdoff: an analog crossing uses the true predecessor across the boundary',
      got.stats.triggerSampleIndex === 3 && got.stats.inspectedSamples === 5 &&
        sameBytes(got.out, raw.subarray(1, 6)),
      `T=${got.stats.triggerSampleIndex} inspected=${got.stats.inspectedSamples}`);
  }

  return results;
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

  // Pre-fill holdoff: a level already true at RUN does not fire before the pre-trigger
  // ring is full. The first eligible sample is index `pre`, so T == pre and the capture
  // carries the full configured prefix plus the post budget.
  const early = collect(8, [1, 1, 1, 1, 1, 1], {
    kind: 'level', level: 1, channel: 0, preTriggerSamples: 2, maxSamples: 4,
  }, [1]);
  results.push({
    name: 'a level true from sample 0 waits for the pre-trigger ring to fill',
    pass: early.trigger.matched && early.trigger.triggerSampleIndex === 2 &&
      early.trigger.emittedSamples === 4 && early.output.length === 4 &&
      early.trigger.inspectedSamples === 3,
    detail: `matched=${early.trigger.matched}, T=${early.trigger.triggerSampleIndex}, ` +
      `emitted=${early.trigger.emittedSamples}, bytes=${early.output.length}, ` +
      `inspected=${early.trigger.inspectedSamples}`,
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

  // Exact search-budget boundary: the limit-th sample may match, the next one must
  // never be looked at. This is where a block-scan off-by-one would live.
  {
    const hit = new SoftwareTrigger({
      config: {
        channels: 8, kind: 'level', channel: 0, level: 1,
        preTriggerSamples: 0, maxSamples: 10, searchLimitSamples: 3,
      },
      emit: () => {},
    });
    hit.feed(new Uint8Array([0, 0, 1, 0]));
    const miss = new SoftwareTrigger({
      config: {
        channels: 8, kind: 'level', channel: 0, level: 1,
        preTriggerSamples: 0, maxSamples: 10, searchLimitSamples: 3,
      },
      emit: () => {},
    });
    miss.feed(new Uint8Array([0, 0, 0, 1]));
    results.push({
      name: 'the search limit is inclusive and the next sample is never inspected',
      pass: hit.stats.matched && hit.stats.inspectedSamples === 3 &&
        miss.stats.noTrigger && !miss.stats.matched && miss.stats.inspectedSamples === 3,
      detail: `hit matched=${hit.stats.matched}/inspected=${hit.stats.inspectedSamples}, ` +
        `miss noTrigger=${miss.stats.noTrigger}/inspected=${miss.stats.inspectedSamples}`,
    });
  }

  // A transport gap must break the transition: the sample before the gap is not a
  // valid `previous` for the sample after it (the dropout rule).
  {
    const gap = new SoftwareTrigger({
      config: {
        channels: 8, kind: 'rising', channel: 0, preTriggerSamples: 1, maxSamples: 4,
        searchLimitSamples: Number.POSITIVE_INFINITY,
      },
      emit: () => {},
    });
    gap.feed(new Uint8Array([0]));
    gap.noteGap(5);
    gap.feed(new Uint8Array([1]));
    results.push({
      name: 'a gap suppresses the transition across it and advances the search budget',
      pass: !gap.stats.matched && !gap.stats.noTrigger && gap.stats.emittedSamples === 0 &&
        gap.stats.inspectedSamples === 7,
      detail: `matched=${gap.stats.matched}, inspected=${gap.stats.inspectedSamples}`,
    });
  }

  // resetContinuity() must drop a carried half-sample: afterwards the next bytes pair
  // from the start, so 0xBB is the low byte of the first new sample (level 1 on D0).
  {
    const reset = new SoftwareTrigger({
      config: {
        channels: 16, kind: 'level', channel: 0, level: 1, preTriggerSamples: 0,
        maxSamples: 2,
      },
      emit: () => {},
    });
    reset.feed(new Uint8Array([0xaa]));
    reset.resetContinuity();
    reset.feed(new Uint8Array([0xbb, 0xcc]));
    results.push({
      name: 'resetContinuity drops a carried half-sample instead of pairing it with new bytes',
      pass: reset.stats.matched && reset.stats.inspectedSamples === 1 &&
        reset.stats.emittedSamples === 1 && reset.stats.triggerSampleIndex === 0,
      detail: `matched=${reset.stats.matched}, inspected=${reset.stats.inspectedSamples}, ` +
        `emitted=${reset.stats.emittedSamples}, T=${reset.stats.triggerSampleIndex}`,
    });
  }

  // Terminal states are idempotent: extra finish() calls and feeds after a complete or
  // no-trigger capture must not change stats or emit anything.
  {
    const out: number[] = [];
    const done = new SoftwareTrigger({
      config: { channels: 8, kind: 'level', channel: 0, level: 1, preTriggerSamples: 0, maxSamples: 2 },
      emit: (chunk) => out.push(...chunk),
    });
    done.feed(new Uint8Array([1, 1, 1, 1]));
    const before = done.stats;
    done.finish();
    done.finish();
    done.feed(new Uint8Array([0, 0, 0, 0]));
    const after = done.stats;
    const stable = out.length === 2 && before.complete && after.complete &&
      JSON.stringify(before) === JSON.stringify(after);
    const waitingDone = new SoftwareTrigger({
      config: { channels: 8, kind: 'rising', channel: 0, preTriggerSamples: 1, maxSamples: 4 },
      emit: () => {},
    });
    waitingDone.feed(new Uint8Array(2));
    waitingDone.finish();
    const finished = waitingDone.stats;
    waitingDone.finish();
    waitingDone.feed(new Uint8Array([1]));
    results.push({
      name: 'finish() and feeds after a terminal state are no-ops',
      pass: stable && waitingDone.stats.noTrigger &&
        JSON.stringify(finished) === JSON.stringify(waitingDone.stats),
      detail: `complete=${stable}, output=${out.length}, ` +
        `noTrigger=${waitingDone.stats.noTrigger}`,
    });
  }

  // preTriggerSamples=0 with maxSamples=1: the trigger sample is the whole capture.
  {
    const out: number[] = [];
    const one = new SoftwareTrigger({
      config: {
        channels: 16, kind: 'rising', channel: 0, preTriggerSamples: 0, maxSamples: 1,
        // The default limit would be maxSamples + pre = 1 sample, shorter than this
        // fixture; the UI always passes Infinity.
        searchLimitSamples: Number.POSITIVE_INFINITY,
      },
      emit: (chunk) => out.push(...chunk),
    });
    one.feed(new Uint8Array([0, 0, 1, 0, 1, 0]));
    results.push({
      name: 'a one-sample capture starts at the trigger with no prefix',
      pass: one.stats.matched && one.stats.complete && one.stats.emittedSamples === 1 &&
        one.stats.triggerSampleIndex === 0 && out.join(',') === '1,0',
      detail: `emitted=${one.stats.emittedSamples}, T=${one.stats.triggerSampleIndex}, out=${out.join(',')}`,
    });
  }

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

  // Channels at or above 32 live in sample bytes 4..15, which the word-based fixtures
  // above cannot express: a JS number shifts by 8 per byte and has 32 meaningful bits.
  // Drive raw bytes instead, with fragment lengths that force mid-sample joins, and
  // check that the compiled byte/bit mapping reaches the high bytes. Level, rising and
  // a two-condition AND are all checked at the top channel of each wide sample, plus
  // sign bit 31 of a 32-channel sample.
  const highChannelCases: { channels: ChannelCount; channel: number; partner: number }[] = [
    { channels: 32, channel: 31, partner: 7 },
    { channels: 64, channel: 63, partner: 32 },
    { channels: 128, channel: 127, partner: 100 },
    { channels: 128, channel: 64, partner: 33 },
  ];
  for (const { channels, channel, partner } of highChannelCases) {
    const bps = bytesPerSampleForChannels(channels);
    const sample = (set: ReadonlySet<number>): Uint8Array => {
      const bytes = new Uint8Array(bps);
      for (const ch of set) bytes[ch >>> 3] = (bytes[ch >>> 3]! | (1 << (ch & 7)));
      return bytes;
    };
    const none = new Set<number>();
    const both = new Set<number>([channel, partner]);
    // 0, 0, both, both, 0: rising (and level 1) first hold at index 2 for both channels.
    const stream = [sample(none), sample(none), sample(both), sample(both), sample(none)];
    const raw = new Uint8Array(stream.length * bps);
    stream.forEach((s, i) => raw.set(s, i * bps));
    const fragmentSizes = [1, 3, bps - 1, 5];
    const expected = new Uint8Array(3 * bps);
    expected.set(stream[0]!, 0);
    expected.set(stream[1]!, bps);
    expected.set(stream[2]!, 2 * bps);
    const configs: { name: string; conditions: SoftwareTriggerCondition[] }[] = [
      { name: 'level', conditions: [{ channel, kind: 'level', level: 1 }] },
      { name: 'rising', conditions: [{ channel, kind: 'rising' }] },
      {
        name: 'AND with a second high channel',
        conditions: [
          { channel: partner, kind: 'level', level: 1 },
          { channel, kind: 'rising' },
        ],
      },
    ];
    for (const config of configs) {
      const emitted: number[] = [];
      const trigger = new SoftwareTrigger({
        config: {
          channels,
          conditions: config.conditions,
          preTriggerSamples: 2,
          maxSamples: 3,
        },
        emit: (chunk) => emitted.push(...chunk),
      });
      let p = 0;
      let k = 0;
      while (p < raw.length) {
        const n = Math.min(fragmentSizes[k++ % fragmentSizes.length]!, raw.length - p);
        trigger.feed(raw.subarray(p, p + n));
        p += n;
      }
      const pass = trigger.stats.matched && trigger.stats.complete &&
        trigger.stats.triggerSampleIndex === 2 && trigger.stats.emittedSamples === 3 &&
        emitted.length === expected.length && emitted.every((v, i) => v === expected[i]);
      results.push({
        name: `channel ${channel} ${config.name} triggers in a ${bps}-byte sample split across fragments`,
        pass,
        detail: pass ? `${emitted.length} bytes emitted`
          : `matched=${trigger.stats.matched}, T=${trigger.stats.triggerSampleIndex}, ` +
            `emitted=${trigger.stats.emittedSamples}, bytes=${emitted.length}/${expected.length}`,
      });
    }
  }
  // The block scanner is an optimization over the per-sample reference above, so its
  // every observable must agree with the naive path on randomized input.
  results.push(...referenceComparison());
  results.push(...analogResults());
  results.push(...reconfigureResults());
  results.push(...continuousResults());
  results.push(...holdoffResults());
  return results;
}
