// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Qualified analog crossings (hysteresis + transition-glitch rejection) in SoftwareTrigger.
 *
 * Every capture here is checked against `qualifiedFires`, the whole-array reference model
 * of the rule (adcArtifactFixture.ts): the matcher must report the same T, inspect
 * exactly through the deciding sample, and emit the input bytes from T - pre. Two kinds
 * of input:
 *
 *  - synthetic sines with the measured carry-boundary artifact (`adcArtifactTrace`):
 *    Single-style one-shot, Repeat-style finite search limits, continuous (Loop) mode at
 *    several strides, no trigger, transfer/sample boundaries, gaps, holdoff, mixed digital
 *    gates, tiny budgets and every wire width that can hold an ADC group;
 *  - the real 32U3 traces in `fixtures/` (fixtures/ADC-TRACES.md): a glitchy 10 kHz sine
 *    and two AM waves (3.3 MHz and 33 MHz carriers), fed one-shot from many start offsets
 *    and continuously, at 16/32/64/128 channels with random transfer chunking.
 */

import {
  MAX_ANALOG_ARTIFACT_SAMPLES,
  SoftwareTrigger,
  reverseAdcByte,
  type SoftwareTriggerConfig,
} from './softwareTrigger.js';
import {
  adcArtifactTrace, checkCrossings, cleanCrossings, cleanSlope, fixtureRng, qualifiedFires,
  rawCrossings, type AdcArtifactTrace,
} from './adcArtifactFixture.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import type { SoftwareTriggerTestResult } from './softwareTriggerSelftest.js';

/** A window for the hand-built cases (any W exercises the rule; the app's is
 * ceil(500 ns * 100 MS/s) = 50, used for the real traces), and the ADC module's code
 * hysteresis. */
const W = 24;
const H = 4;
const LEVELS = [100, 112, 128, 144, 160] as const;
const KINDS = ['rising', 'falling'] as const;
type Kind = typeof KINDS[number];

/** Interleave a code trace into raw samples: the group byte carries the code with the
 * module's MSB-first wiring, every other byte seeded noise (so a wrong byte offset
 * cannot pass). */
function encode(codes: Uint8Array, channels: ChannelCount, start: number, seed: number): Uint8Array {
  const bps = bytesPerSampleForChannels(channels);
  const rng = fixtureRng(seed);
  const out = new Uint8Array(codes.length * bps);
  const byte = start >>> 3;
  for (let i = 0; i < codes.length; i++) {
    for (let b = 0; b < bps; b++) out[i * bps + b] = Math.floor(rng() * 256);
    out[i * bps + byte] = reverseAdcByte(codes[i]!);
  }
  return out;
}

/** Feed in seeded fragments of 1..maxBytes bytes, unrelated to the sample size. */
function feedRandom(trigger: SoftwareTrigger, raw: Uint8Array, seed: number, maxBytes: number): void {
  const rng = fixtureRng(seed);
  let p = 0;
  while (p < raw.length) {
    const n = 1 + Math.floor(rng() * maxBytes);
    trigger.feed(raw.subarray(p, Math.min(raw.length, p + n)));
    p += n;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** What the reference model says a one-shot capture over `codes` must do. */
interface Expected {
  matched: boolean;
  /** Input index of T, or -1. */
  t: number;
  /** Input index of the sample that decided T, or -1. */
  decide: number;
  inspected: number;
  pre: number;
}

function expectOneShot(
  codes: Uint8Array, kind: Kind, level: number,
  opts: { pre: number; max: number; limit: number; w?: number; h?: number;
    gate?: (i: number) => boolean },
): Expected {
  const pre = Math.min(opts.pre, Math.max(0, opts.max - 1));
  const fires = qualifiedFires(codes, kind, level, opts.h ?? H, opts.w ?? W);
  // Fires are in decision order. One inside the holdoff (T < pre) or with its digital
  // gate closed is consumed; one decided past the search limit is never seen.
  for (const f of fires) {
    if (f.decide >= opts.limit) break;
    if (f.t < pre || (opts.gate !== undefined && !opts.gate(f.t))) continue;
    return { matched: true, t: f.t, decide: f.decide, inspected: f.decide + 1, pre };
  }
  return { matched: false, t: -1, decide: -1, inspected: Math.min(codes.length, opts.limit), pre };
}

interface OneShot {
  matched: boolean;
  noTrigger: boolean;
  complete: boolean;
  /** Emitted index of T. */
  t: number | null;
  /** Input index of T (from the reference model, which the capture was checked against). */
  tAbs: number;
  decide: number;
  output: Uint8Array;
  emitted: number;
  /** '' when the capture equals the reference model's, else the first difference. */
  err: string;
}

/** Run one Single/Repeat-style capture and compare it with the reference model. */
function oneShot(
  raw: Uint8Array, codes: Uint8Array, config: SoftwareTriggerConfig, seed: number,
  maxBytes = 9000, gate?: (i: number) => boolean,
): OneShot {
  const chunks: Uint8Array[] = [];
  const trigger = new SoftwareTrigger({ config, emit: (c) => chunks.push(c.slice()) });
  feedRandom(trigger, raw, seed, maxBytes);
  trigger.finish();
  const s = trigger.stats;
  const a = config.analog![0]!;
  const limit = config.searchLimitSamples ??
    config.maxSamples + Math.min(config.preTriggerSamples, Math.max(0, config.maxSamples - 1));
  const want = expectOneShot(codes, a.kind, a.level, {
    pre: config.preTriggerSamples, max: config.maxSamples, limit,
    w: config.analogArtifactSamples ?? 1, h: config.analogHysteresis ?? 4,
    ...(gate ? { gate } : {}),
  });
  const output = concat(chunks);
  const bps = bytesPerSampleForChannels(config.channels);
  let err = '';
  if (s.matched !== want.matched) {
    err = `matched=${s.matched}, reference ${want.matched} (T=${want.t})`;
  } else if (s.inspectedSamples !== want.inspected) {
    err = `inspected ${s.inspectedSamples}, reference ${want.inspected}`;
  } else if (want.matched) {
    const start = want.t - want.pre;
    const end = Math.min(codes.length, start + config.maxSamples);
    if (s.triggerSampleIndex !== want.pre) err = `T emitted at ${s.triggerSampleIndex}, not ${want.pre}`;
    else if (s.emittedSamples !== end - start) err = `emitted ${s.emittedSamples}, want ${end - start}`;
    else if (s.complete !== (end - start >= config.maxSamples)) err = `complete=${s.complete}`;
    else if (!sameBytes(output, raw.subarray(start * bps, end * bps))) {
      err = `emitted bytes are not the input stream [T - pre, T - pre + max)`;
    }
  } else if (output.length !== 0 || !s.noTrigger) {
    err = `no match but ${output.length} bytes emitted, noTrigger=${s.noTrigger}`;
  }
  return {
    matched: s.matched, noTrigger: s.noTrigger, complete: s.complete,
    t: s.triggerSampleIndex, tAbs: want.t, decide: want.decide,
    output, emitted: s.emittedSamples, err,
  };
}

/** The first clean crossing at or after `from`. */
function firstCleanAfter(trace: AdcArtifactTrace, kind: Kind, level: number, from: number): number {
  return cleanCrossings(trace, kind, level).find((c) => c >= from) ?? -1;
}

/* -----------------------------------------------------------------------------------
 * Real traces (fixtures/ADC-TRACES.md)
 * --------------------------------------------------------------------------------- */

interface RealTrace {
  name: string;
  codes: Uint8Array;
  levels: readonly number[];
  /** Levels the wave never reaches (only glitches do): they must stay silent. */
  silent: readonly number[];
  /** A slow wave's slope is judged from its median this many samples either side of T
   * (0: not judged - an AM carrier crosses on both slopes every period). */
  slopeSpan: number;
}

/** Read the fixtures from the repo root (self-tests run there under node). null when no
 * filesystem is available (a browser run), in which case the real-trace checks skip. */
function loadRealTraces(): RealTrace[] | null {
  const proc = (globalThis as {
    process?: { getBuiltinModule?(name: string): unknown };
  }).process;
  const fs = proc?.getBuiltinModule?.('fs') as
    { readFileSync(path: string): Uint8Array } | undefined;
  if (!fs) return null;
  const read = (file: string): Uint8Array => new Uint8Array(fs.readFileSync(`fixtures/${file}`));
  return [
    { name: 'sine', codes: read('adc-sine-carry-glitches-100MSps.bin'), levels: LEVELS, silent: [],
      slopeSpan: 300 },
    { name: 'AM 3.3 MHz', codes: read('adc-am-3MHz-carrier-100MSps.bin'), levels: [100, 112, 128, 144, 160],
      silent: [165], slopeSpan: 0 },
    { name: 'AM 33 MHz', codes: read('adc-am-33MHz-carrier-100MSps.bin'), levels: [116, 120, 128, 136, 140],
      // No silent level: at ~3 samples per carrier period it reads isolated 160-211 codes
      // (138 -> 163 -> 130) that are no mix of the codes crossed, so they may fire.
      silent: [], slopeSpan: 0 },
    // 127 -> 128 reads 255 / 254 here, far beyond the wave: Rising 200 / 230 must stay silent.
    { name: 'multitone 100 kHz', codes: read('adc-multitone-100kHz-100MSps.bin'),
      levels: [110, 120, 128, 136, 145], silent: [200, 230], slopeSpan: 30 },
  ];
}

function median31(codes: Uint8Array, at: number): number {
  const xs = Array.from(codes.subarray(at - 15, at + 16)).sort((a, b) => a - b);
  return xs[15]!;
}

/**
 * Whether a reported T is a legitimate crossing of `level` on the configured slope, in
 * the trace's own codes: the sample before T is on the other side and T is past the
 * level (a touch at an AM carrier's peak is legitimate), and for a slow wave the
 * median-of-31 `slopeSpan` samples after T is beyond the one `slopeSpan` before.
 */
function slopeError(trace: RealTrace, kind: Kind, level: number, t: number): string {
  const c = trace.codes;
  const past = (g: number): boolean => (kind === 'rising' ? g >= level : g <= level);
  if (t < 1 || t >= c.length) return `T=${t} outside the trace`;
  if (!past(c[t]!) || past(c[t - 1]!)) return `T=${t} (${c[t - 1]} -> ${c[t]}) does not cross ${level}`;
  const span = trace.slopeSpan;
  if (span > 0 && t >= span + 15 && t + span + 16 <= c.length) {
    const d = median31(c, t + span) - median31(c, t - span);
    if (kind === 'rising' ? d <= 0 : d >= 0) return `T=${t} is on the wrong slope (median step ${d})`;
  }
  return '';
}

/** Wire layouts with the ADC group: 16 channels with A0 in byte 0, and wider captures
 * with the group in another byte. */
const REAL_LAYOUTS: ReadonlyArray<readonly [ChannelCount, number]> = [
  [16, 0], [32, 16], [64, 40], [128, 120],
];

function realTraceTests(check: (name: string, pass: boolean, detail: string) => void): void {
  // The app's window at the traces' 100 MS/s (analogTriggerArtifactSamples).
  const W = 50;
  const traces = loadRealTraces();
  if (traces === null) {
    check('real ADC traces: skipped (no filesystem)', true, 'browser run');
    return;
  }

  // The reference model itself on the measured data: the sine fires once per period on
  // the configured slope at every level, where the raw rule (W <= 1, h = 1) fires on
  // the wrong slope; both AM waves fire.
  {
    const sine = traces[0]!;
    let bad = '';
    let qualified = 0;
    let rawWrong = 0;
    for (const kind of KINDS) {
      for (const level of sine.levels) {
        const fires = qualifiedFires(sine.codes, kind, level, H, W);
        qualified += fires.length;
        if (fires.length < 28 || fires.length > 31) bad ||= `${kind} ${level}: ${fires.length} fires`;
        for (const f of fires) bad ||= slopeError(sine, kind, level, f.t);
        for (const f of qualifiedFires(sine.codes, kind, level, 1, 1)) {
          if (f.t >= 315 && f.t + 316 <= sine.codes.length) {
            const d = median31(sine.codes, f.t + 300) - median31(sine.codes, f.t - 300);
            if (kind === 'rising' ? d <= 0 : d >= 0) rawWrong++;
          }
        }
      }
    }
    const others = traces.slice(1).map((t) => {
      let n = 0;
      for (const kind of KINDS) {
        for (const level of t.levels) {
          const fires = qualifiedFires(t.codes, kind, level, H, W);
          n += fires.length;
          for (const f of fires) {
            const e = slopeError(t, kind, level, f.t);
            if (e) bad ||= `${t.name} ${kind} ${level}: ${e}`;
          }
        }
        for (const level of t.silent) {
          const fires = qualifiedFires(t.codes, kind, level, H, W);
          if (fires.length > 0) bad ||= `${t.name} ${kind} ${level} (never reached): fires at ${fires[0]!.t}`;
        }
      }
      return `${t.name} ${n}`;
    });
    check('real ADC traces: the rule fires once per sine period on the right slope; AM and multitone fire, never on unreached levels',
      bad === '' && rawWrong > 1000 && others.every((x) => Number(x.split(' ').pop()) > 1000),
      bad || `sine ${qualified} fires over 10 conditions (raw rule: ${rawWrong} on the wrong ` +
        `slope); ${others.join(', ')} fires`);
  }

  // Continuous (Loop) mode, stride 1: every fire after the first match is reported at the
  // exact T, the emitted stream is the input from T0 - pre, at 16/32/64/128 channels and
  // random chunking. The AM levels that the wave never reaches stay silent.
  {
    let bad = '';
    let combos = 0;
    let silent = 0;
    const counts: string[] = [];
    for (let ti = 0; ti < traces.length && !bad; ti++) {
      const trace = traces[ti]!;
      let total = 0;
      for (const kind of KINDS) {
        for (const level of [...trace.levels, ...trace.silent]) {
          if (bad) break;
          const [channels, start] = REAL_LAYOUTS[combos % REAL_LAYOUTS.length]!;
          combos++;
          const bps = bytesPerSampleForChannels(channels);
          const raw = encode(trace.codes, channels, start, combos);
          const pre = 64 + (combos * 97) % 900;
          const fires = qualifiedFires(trace.codes, kind, level, H, W);
          const first = fires.findIndex((f) => f.t >= pre);
          const matches: number[] = [];
          let emittedAt = 0;
          const origin = first >= 0 ? fires[first]!.t - pre : 0;
          let streamErr = '';
          const trigger = new SoftwareTrigger({
            config: {
              channels, analog: [{ start, kind, level }], analogHysteresis: H,
              analogArtifactSamples: W, mode: 'continuous', preTriggerSamples: pre,
              maxSamples: Number.POSITIVE_INFINITY, searchLimitSamples: Number.POSITIVE_INFINITY,
            },
            emit: (chunk) => {
              if (streamErr) return;
              const at = (origin + emittedAt) * bps;
              if (!sameBytes(chunk, raw.subarray(at, at + chunk.length))) {
                streamErr = `emitted bytes at stream sample ${emittedAt} differ from the input`;
              }
              emittedAt += chunk.length / bps;
            },
            onMatch: (m) => { matches.push(m.index + origin); },
          });
          // Mostly large transfers, with stretches of 1-byte feeds and sample splits.
          const rng = fixtureRng(combos * 7919);
          let p = 0;
          while (p < raw.length) {
            const r = rng();
            const n = r < 0.1 ? 1 : r < 0.3 ? 1 + Math.floor(rng() * (bps * 3 + 2)) : 1 + Math.floor(rng() * 40_000);
            trigger.feed(raw.subarray(p, Math.min(raw.length, p + n)));
            p += n;
          }
          const want = first >= 0 ? fires.slice(first).map((f) => f.t) : [];
          const name = `${trace.name} ${kind} ${level} (${channels}ch)`;
          const stats = trigger.stats;
          if (first < 0) {
            if (stats.matched || matches.length > 0) bad = `${name}: matched without a reference fire`;
            silent++;
          } else if (streamErr) {
            bad = `${name}: ${streamErr}`;
          } else if (emittedAt !== trace.codes.length - origin) {
            bad = `${name}: emitted ${emittedAt} samples, want ${trace.codes.length - origin}`;
          } else if (matches.length !== want.length || matches.some((m, i) => m !== want[i])) {
            const i = matches.findIndex((m, k) => m !== want[k]);
            bad = `${name}: ${matches.length} matches, reference ${want.length}; first difference ` +
              `#${i}: ${matches[i]} vs ${want[i]}`;
          } else if (stats.matchCount !== want.length) {
            bad = `${name}: matchCount ${stats.matchCount}, reference ${want.length}`;
          } else {
            for (const t of matches) {
              const e = slopeError(trace, kind, level, t);
              if (e) { bad = `${name}: ${e}`; break; }
            }
          }
          total += matches.length;
        }
      }
      counts.push(`${trace.name} ${total}`);
    }
    check('real ADC traces: Loop reports every qualified crossing at its exact T, 16-128 channels',
      bad === '' && silent >= 2, bad || `${combos} scans, matches: ${counts.join(', ')}; ` +
        `${silent} unreachable levels silent`);
  }

  // One-shot (Single/Repeat) from many start offsets, random budgets, finite and
  // unbounded search limits, and three chunking styles including 1-byte feeds and
  // fragments that split samples. Each start is a fresh stream: its first sample has no
  // predecessor. Offsets include T - 1 and T itself of reference fires (the crossing then
  // begins with, or before, the first sample) and the samples just before the holdoff
  // boundary.
  {
    let bad = '';
    let cases = 0;
    let matched = 0;
    const rng = fixtureRng(20261109);
    for (let ti = 0; ti < traces.length && !bad; ti++) {
      const trace = traces[ti]!;
      const n = trace.codes.length;
      for (const kind of KINDS) {
        for (const level of trace.levels) {
          if (bad) break;
          const fires = qualifiedFires(trace.codes, kind, level, H, W);
          const offsets: number[] = [0];
          for (let k = 0; k < 4; k++) offsets.push(Math.floor(rng() * (n - 1000)));
          for (let k = 0; k < 3 && fires.length > 0; k++) {
            const f = fires[Math.floor(rng() * fires.length)]!;
            offsets.push(Math.max(0, f.t - 1), f.t, Math.max(0, f.t - 1 - Math.floor(rng() * 40)));
          }
          for (const offset of offsets) {
            const [channels, start] = REAL_LAYOUTS[cases % REAL_LAYOUTS.length]!;
            const style = cases % 3;
            cases++;
            const bps = bytesPerSampleForChannels(channels);
            // 1-byte feeds walk a shorter stretch; the others the rest of the trace.
            const length = Math.min(n - offset, style === 0 ? 30_000 : n);
            const codes = trace.codes.subarray(offset, offset + length);
            const raw = encode(codes, channels, start, cases);
            const pre = Math.floor(rng() * 3000);
            const max = 1 + Math.floor(rng() * 5000);
            const pick = rng();
            const limit = pick < 0.5 ? Number.POSITIVE_INFINITY : pre + 1 + Math.floor(rng() * 40_000);
            const r = oneShot(raw, codes, {
              channels, analog: [{ start, kind, level }], analogHysteresis: H,
              analogArtifactSamples: W, preTriggerSamples: pre, maxSamples: max,
              searchLimitSamples: limit,
            }, cases, style === 0 ? 1 : style === 1 ? bps * 3 + 2 : 20_000);
            const name = `${trace.name} ${kind} ${level} from ${offset} (${channels}ch, style ${style})`;
            if (r.err) { bad = `${name}: ${r.err}`; break; }
            if (r.matched) {
              matched++;
              const e = slopeError(trace, kind, level, offset + r.tAbs);
              if (e) { bad = `${name}: ${e}`; break; }
            }
          }
        }
      }
    }
    check('real ADC traces: Single from many start offsets matches the reference, any chunking',
      bad === '' && matched > cases / 2, bad || `${cases} captures, ${matched} triggered`);
  }

  // Search-limit accounting and ring size on the real AM traces: the look-ahead samples
  // count toward the limit, and the waiting ring holds pre + W - 1 samples.
  {
    let bad = '';
    for (const trace of traces) {
      for (const kind of KINDS) {
        const level = trace.levels[2]!;
        const fires = qualifiedFires(trace.codes, kind, level, H, W);
        const f = fires.find((x) => x.t >= 500 && x.decide > x.t);
        if (!f) { bad = `${trace.name} ${kind}: no fire with look-ahead`; break; }
        // pre = T: every earlier fire lies inside the holdoff, so `f` is the first match.
        const pre = f.t;
        const raw = encode(trace.codes, 16, 0, 5);
        const cfg = {
          channels: 16 as const, analog: [{ start: 0, kind, level }], analogHysteresis: H,
          analogArtifactSamples: W, preTriggerSamples: pre, maxSamples: pre + 1000,
        };
        const at = oneShot(raw, trace.codes, { ...cfg, searchLimitSamples: f.decide + 1 }, 1);
        const before = oneShot(raw, trace.codes, { ...cfg, searchLimitSamples: f.decide }, 2);
        const ring = (new SoftwareTrigger({ config: { ...cfg }, emit: () => {} }) as unknown as
          { ringCapacity: number }).ringCapacity;
        const name = `${trace.name} ${kind} ${level}`;
        if (at.err || before.err) bad = `${name}: ${at.err || before.err}`;
        else if (!at.matched || at.tAbs !== f.t || before.matched || !before.noTrigger) {
          bad = `${name}: limit ${f.decide + 1} matched=${at.matched}, limit ${f.decide} matched=${before.matched}`;
        } else if (ring !== pre + W - 1) bad = `${name}: ring holds ${ring} samples, want ${pre + W - 1}`;
        if (bad) break;
      }
      if (bad) break;
    }
    check('real ADC traces: look-ahead samples count toward the search limit; ring = pre + W - 1',
      bad === '', bad || 'limit at the deciding sample matches, one less does not');
  }
}

export function runQualifiedAnalogSuite(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };
  const base = (channels: ChannelCount, start: number, kind: Kind, level: number) => ({
    channels,
    analog: [{ start, kind, level }],
    analogHysteresis: H,
    analogArtifactSamples: W,
  });

  // The fixture must actually be adversarial, or the checks below prove nothing: a raw
  // crossing test fires on the wrong slope (a Rising level on the falling slope, and a
  // Falling level on the rising slope through a faked arm).
  {
    const trace = adcArtifactTrace({ length: 40_000, period: 10_000, seed: 7, ditherNear: LEVELS });
    let wrong = 0;
    for (const kind of KINDS) {
      for (const level of LEVELS) {
        const want = kind === 'rising' ? 1 : -1;
        wrong += rawCrossings(trace.codes, kind, level).filter((i) => cleanSlope(trace, i) !== want).length;
      }
    }
    check('qualified analog: the artifact fixture fools a raw crossing test',
      trace.artifactSamples > 100 && wrong > 20,
      `${trace.artifactSamples} artifact samples, ${wrong} raw wrong-slope crossings`);
  }

  // Single: one-shot, prefix exact, bytes are the original stream [T - pre, T - pre + max).
  {
    let bad = '';
    let cases = 0;
    for (let phaseStep = 0; phaseStep < 3 && !bad; phaseStep++) {
      const trace = adcArtifactTrace({
        length: 30_000, period: 10_000, seed: 11 + phaseStep,
        phase: phaseStep * 2.1, ditherNear: LEVELS,
      });
      const raw = encode(trace.codes, 32, 16, 100 + phaseStep);
      for (const kind of KINDS) {
        for (const level of LEVELS) {
          const pre = 1000;
          const max = 5000;
          const r = oneShot(raw, trace.codes, { ...base(32, 16, kind, level), preTriggerSamples: pre,
            maxSamples: max, searchLimitSamples: Number.POSITIVE_INFINITY }, phaseStep * 31 + level);
          const first = firstCleanAfter(trace, kind, level, pre + 200);
          const crossing = checkCrossings(trace, kind, level, [r.tAbs]);
          if (r.err || !r.matched || !r.complete) {
            bad = `${kind} ${level} phase ${phaseStep}: matched=${r.matched} ${r.err}`;
          } else if (crossing) {
            bad = `${kind} ${level} phase ${phaseStep}: ${crossing}`;
          } else if (first >= 0 && r.tAbs > first + 120) {
            bad = `${kind} ${level} phase ${phaseStep}: skipped the clean crossing at ${first} (T=${r.tAbs})`;
          }
          cases++;
        }
      }
    }
    check('qualified analog: Single triggers on the right slope with the exact prefix and bytes',
      bad === '', bad || `${cases} captures, rising and falling at ${LEVELS.join('/')}`);
  }

  // Every wire width that carries an ADC group, with the group in different bytes.
  {
    let bad = '';
    const layouts: Array<[ChannelCount, number]> = [[8, 0], [16, 8], [32, 24], [64, 40], [128, 120]];
    const trace = adcArtifactTrace({ length: 25_000, period: 10_000, seed: 23, phase: 1, ditherNear: LEVELS });
    for (const [channels, start] of layouts) {
      for (const kind of KINDS) {
        const level = kind === 'rising' ? 144 : 112;
        const raw = encode(trace.codes, channels, start, channels);
        const bps = bytesPerSampleForChannels(channels);
        const r = oneShot(raw, trace.codes, { ...base(channels, start, kind, level), preTriggerSamples: 300,
          maxSamples: 2000, searchLimitSamples: Number.POSITIVE_INFINITY }, channels + start, bps * 700 + 3);
        const crossing = checkCrossings(trace, kind, level, [r.tAbs]);
        if (!r.matched || r.err || crossing) {
          bad = `${channels}ch group ${start} ${kind}: matched=${r.matched} ${r.err} ${crossing}`;
          break;
        }
      }
    }
    check('qualified analog: 8/16/32/64/128-channel layouts read their own group byte',
      bad === '', bad || `${layouts.length} layouts x rising/falling`);
  }

  // Levels outside the signal never trigger, although the glitch reaches 255 (from
  // 127 -> 128): Rising 200 sees short candidates, Falling 190 short faked arms.
  {
    let bad = '';
    const trace = adcArtifactTrace({ length: 40_000, period: 10_000, seed: 31, ditherNear: LEVELS });
    const raw = encode(trace.codes, 16, 8, 5);
    const outside: Array<[Kind, number]> = [
      ['rising', 200], ['rising', 80], ['falling', 60], ['falling', 190],
    ];
    let rawFalse = 0;
    for (const [kind, level] of outside) {
      rawFalse += rawCrossings(trace.codes, kind, level).length;
      const r = oneShot(raw, trace.codes, { ...base(16, 8, kind, level), preTriggerSamples: 100,
        maxSamples: 1000, searchLimitSamples: Number.POSITIVE_INFINITY }, level);
      if (r.matched || r.err || !r.noTrigger) bad = `${kind} ${level} triggered at ${r.tAbs} ${r.err}`;
    }
    check('qualified analog: no trigger when the level is outside the signal',
      bad === '' && rawFalse > 0, bad || `none of 4 out-of-range levels fired (raw test: ${rawFalse})`);
  }

  // The artifact only raises codes, so on the rising slope it fakes a *falling* arm:
  // 111 -> 112 reads 127 >= 112 + h, then the genuine 112s are past the level. The 127
  // run is a transition glitch (127 = 111 | 112, more than h above both), so it never arms;
  // with W = 1 (no artifact rejection) it would. A genuine arm of the same length - 130,
  // which is no such OR - arms and fires.
  {
    const codes: number[] = [];
    const push = (code: number, n: number) => { for (let i = 0; i < n; i++) codes.push(code); };
    push(100, 40); push(111, 30); push(127, 6); push(112, 60); push(113, 60);
    const c = Uint8Array.from(codes);
    const raw = encode(c, 8, 0, 12);
    const cfg = { ...base(8, 0, 'falling', 112), preTriggerSamples: 10, maxSamples: 50,
      searchLimitSamples: Number.POSITIVE_INFINITY };
    const qualified = oneShot(raw, c, cfg, 1, 5);
    const noRejection = oneShot(raw, c, { ...cfg, analogArtifactSamples: 1 }, 2, 5);
    const genuine = Uint8Array.from(codes.map((g) => (g === 127 ? 130 : g)));
    const real = oneShot(encode(genuine, 8, 0, 13), genuine, cfg, 3, 5);
    check('qualified analog: a faked falling arm on the rising slope does not trigger',
      !qualified.matched && qualified.noTrigger && !qualified.err && noRejection.matched &&
        !noRejection.err && real.matched && real.tAbs === 76 && !real.err,
      `qualified matched=${qualified.matched}, W=1 matched=${noRejection.matched}, ` +
        `genuine arm T=${real.tAbs} ${qualified.err}${noRejection.err}${real.err}`);
  }

  // Short real runs are not artifacts: a 3-sample crossing (the shape of a 33 MHz carrier)
  // fires, while a 3-sample glitch run (127 -> 128 reads 255) does not.
  {
    const mk = (mid: readonly number[]): Uint8Array => {
      const codes: number[] = [];
      for (let k = 0; k < 4; k++) codes.push(...[118, 119, 120, 121, 122], ...mid, 125, 124, 120);
      return Uint8Array.from(codes);
    };
    const realRun = mk([128, 130, 129]);
    const orRun = mk([127, 255, 255, 255]);
    const cfg = { ...base(8, 0, 'rising', 128), preTriggerSamples: 3, maxSamples: 6,
      searchLimitSamples: Number.POSITIVE_INFINITY };
    const r1 = oneShot(encode(realRun, 8, 0, 1), realRun, cfg, 1, 3);
    const r2 = oneShot(encode(orRun, 8, 0, 2), orRun, cfg, 2, 3);
    check('qualified analog: a short genuine crossing fires, a short glitch run does not',
      r1.matched && r1.tAbs === 5 && !r1.err && !r2.matched && !r2.err,
      `genuine T=${r1.tAbs} ${r1.err}, OR run matched=${r2.matched} ${r2.err}`);
  }

  // The first sample has no predecessor. An arm run that begins there is judged from the
  // first sample seen, without `a`: a stream that starts on the 111 -> 112 glitch (127)
  // does not arm Falling 112, while a genuine arm run in progress at the start (140s, or
  // a short 120 run) does - for the plain loop and for the mixed and general loops.
  {
    let bad = '';
    const cases: Array<[string, number[], number]> = [
      ['glitch', [127, ...Array<number>(60).fill(112), 113, 113], -1],
      ['long arm', [...Array<number>(30).fill(140), ...Array<number>(40).fill(112)], 30],
      // 130 is no mix of 111 and its neighbours, so this short run is no glitch.
      ['short arm', [130, 130, 111, ...Array<number>(40).fill(112)], 2],
    ];
    for (const [name, list, wantT] of cases) {
      const c = Uint8Array.from(list);
      for (const gated of [false, true]) {
        // 16 channels: D0..D7 in byte 0 (held high), the group in byte 1.
        const raw = encode(c, 16, 8, 31);
        for (let i = 0; i < c.length; i++) raw[i * 2] = 0xff;
        const conditions = gated
          ? [{ channel: 0, kind: 'level' as const, level: 1 as const },
            { channel: 1, kind: 'level' as const, level: 1 as const }]
          : [];
        const r = oneShot(raw, c, { ...base(16, 8, 'falling', 112), conditions, preTriggerSamples: 0,
          maxSamples: 5, searchLimitSamples: Number.POSITIVE_INFINITY }, 3, 3);
        if (r.err || r.matched !== (wantT >= 0) || (wantT >= 0 && r.tAbs !== wantT)) {
          bad ||= `${name}${gated ? ' gated' : ''}: matched=${r.matched} T=${r.tAbs} ${r.err}`;
        }
      }
    }
    check('qualified analog: the first sample after a reset is judged without a predecessor',
      bad === '', bad || 'a leading glitch does not arm, a leading genuine arm run does');
  }

  // Degenerate windows: W = 0 and W = 1 decide every run at its first sample (no
  // look-ahead, ring = pre) and agree with each other; W = 2 rejects one-sample artifacts.
  {
    const trace = adcArtifactTrace({ length: 30_000, period: 10_000, seed: 77, ditherNear: LEVELS });
    let bad = '';
    for (const w of [0, 1, 2]) {
      for (const kind of KINDS) {
        for (const level of LEVELS) {
          const raw = encode(trace.codes, 16, 8, w + level);
          const r = oneShot(raw, trace.codes, { ...base(16, 8, kind, level), analogArtifactSamples: w,
            preTriggerSamples: 200, maxSamples: 400, searchLimitSamples: Number.POSITIVE_INFINITY },
          w * 1000 + level, 7);
          if (r.err) bad ||= `W=${w} ${kind} ${level}: ${r.err}`;
          if (w <= 1 && r.matched && r.decide !== r.tAbs) bad ||= `W=${w}: decided after T`;
        }
      }
      const ring = (new SoftwareTrigger({ config: { ...base(8, 0, 'rising', 128),
        analogArtifactSamples: w, preTriggerSamples: 50, maxSamples: 100 }, emit: () => {} }) as
        unknown as { ringCapacity: number }).ringCapacity;
      if (ring !== 50 + Math.max(0, w - 1)) bad ||= `W=${w}: ring ${ring}`;
    }
    check('qualified analog: degenerate windows W = 0/1/2 follow the reference', bad === '',
      bad || 'W = 0 and 1 reject nothing, W = 2 one-sample artifacts');
  }

  // Repeat: a finite search limit. The look-ahead samples count toward it: a limit that
  // ends one sample before the deciding sample finds nothing, one that includes it
  // matches.
  {
    const trace = adcArtifactTrace({ length: 20_000, period: 10_000, seed: 41, phase: 2, ditherNear: LEVELS });
    const raw = encode(trace.codes, 16, 0, 9);
    const cfg = { ...base(16, 0, 'rising', 128), preTriggerSamples: 200, maxSamples: 800 };
    const free = oneShot(raw, trace.codes, { ...cfg, searchLimitSamples: Number.POSITIVE_INFINITY }, 1);
    const exact = oneShot(raw, trace.codes, { ...cfg, searchLimitSamples: free.decide + 1 }, 2);
    const short = oneShot(raw, trace.codes, { ...cfg, searchLimitSamples: free.decide }, 3);
    check('qualified analog: Repeat search limit includes the look-ahead samples',
      free.matched && free.decide > free.tAbs && exact.matched && exact.tAbs === free.tAbs &&
        short.noTrigger && !short.matched && !free.err && !exact.err && !short.err,
      `T=${free.tAbs}, decided at ${free.decide}; limit ${free.decide + 1}: ${exact.matched}, ` +
        `limit ${free.decide}: noTrigger=${short.noTrigger} ${free.err}${exact.err}${short.err}`);

    // Consecutive Repeat sweeps, each a fresh one-shot matcher on the next stretch.
    const long = adcArtifactTrace({ length: 120_000, period: 10_000, seed: 43, ditherNear: LEVELS });
    let bad = '';
    let sweeps = 0;
    for (const kind of KINDS) {
      const rawLong = encode(long.codes, 32, 8, 13);
      let pos = 0;
      while (pos < long.codes.length - 15_000 && !bad) {
        const r = oneShot(rawLong.subarray(pos * 4), long.codes.subarray(pos), {
          ...base(32, 8, kind, 160), preTriggerSamples: 500, maxSamples: 2500,
          searchLimitSamples: 500 + 12_000,
        }, pos + 1);
        if (!r.matched || r.err) { bad = `${kind} sweep at ${pos}: matched=${r.matched} ${r.err}`; break; }
        const err = checkCrossings(long, kind, 160, [pos + r.tAbs]);
        if (err) bad = `${kind} sweep at ${pos}: ${err}`;
        pos += r.tAbs + 2000;
        sweeps++;
      }
    }
    check('qualified analog: consecutive Repeat sweeps all land on the right slope',
      bad === '' && sweeps > 10, bad || `${sweeps} sweeps`);
  }

  // Loop: continuous mode at strides 1/4/16/64 (fixed), random fragments. Every reported
  // T is on the right slope, and every clean crossing after the first is reported; at
  // stride 1 the list is exactly the reference model's.
  {
    let bad = '';
    let total = 0;
    const trace = adcArtifactTrace({ length: 100_000, period: 10_000, seed: 53, phase: 0.4, ditherNear: LEVELS });
    const raw = encode(trace.codes, 32, 24, 17);
    for (const stride of [1, 4, 16, 64]) {
      for (const kind of KINDS) {
        for (const level of LEVELS) {
          for (const finite of [false, true]) {
            const pre = 500;
            const maxSamples = finite ? 60_000 : Number.POSITIVE_INFINITY;
            const matches: number[] = [];
            const trigger = new SoftwareTrigger({
              config: {
                ...base(32, 24, kind, level), mode: 'continuous', preTriggerSamples: pre,
                maxSamples, searchLimitSamples: Number.POSITIVE_INFINITY,
                scan: { minStride: stride, maxStride: stride, initialStride: stride },
              },
              emit: () => {},
              onMatch: (m) => { matches.push(m.index); },
            });
            feedRandom(trigger, raw, stride * 1000 + level, 20_000);
            const fires = qualifiedFires(trace.codes, kind, level, H, W);
            const firstFire = fires.find((f) => f.t >= pre);
            const t0 = firstFire?.t ?? -1;
            const origin = t0 - pre; // input index of emitted sample 0
            const abs = matches.map((m) => m + origin);
            const end = finite ? origin + maxSamples : trace.codes.length;
            const err = checkCrossings(trace, kind, level, abs);
            const expected = cleanCrossings(trace, kind, level)
              .filter((c) => c > t0 + 200 && c < end - 200).length;
            const later = abs.filter((a) => a > t0 + 200 && a < end - 200).length;
            const exact = fires.filter((f) => f.t >= t0 && f.decide < end).map((f) => f.t);
            const name = `stride ${stride} ${kind} ${level}${finite ? ' finite' : ''}`;
            if (t0 < 0 || matches[0] !== pre) bad = `${name}: first match ${matches[0]}, reference T ${t0}`;
            else if (err) bad = `${name}: ${err}`;
            else if (later !== expected) bad = `${name}: ${later} later crossings reported, ${expected} clean`;
            else if (trigger.stats.matchCount !== matches.length) bad = `${name}: matchCount mismatch`;
            else if (stride === 1 && abs.join() !== exact.join()) bad = `${name}: not the reference list`;
            total += matches.length;
            if (bad) break;
          }
          if (bad) break;
        }
        if (bad) break;
      }
      if (bad) break;
    }
    check('qualified analog: Loop reports every crossing on the right slope at strides 1/4/16/64',
      bad === '' && total > 0, bad || `${total} matches`);
  }

  // The deciding sample in a later transfer than T, with a sample split across transfers.
  {
    const codes = new Uint8Array(200);
    for (let i = 0; i < codes.length; i++) codes[i] = i < 60 ? 90 : 140;
    const raw = encode(codes, 16, 8, 21);
    const pre = 20;
    const t = 60;
    const decide = t + W - 1; // a long run is real on its W-th sample
    const results2: string[] = [];
    let pass = true;
    // Split inside T's run, and inside a sample (odd byte offsets).
    for (const cut of [(t + 3) * 2 + 1, decide * 2 + 1, t * 2 + 1]) {
      const chunks: Uint8Array[] = [];
      const trigger = new SoftwareTrigger({
        config: { ...base(16, 8, 'rising', 128), preTriggerSamples: pre, maxSamples: 100 },
        emit: (c) => chunks.push(c.slice()),
      });
      trigger.feed(raw.subarray(0, cut));
      const waitingAfterFirst = trigger.waiting;
      trigger.feed(raw.subarray(cut));
      const out = concat(chunks);
      const ok = waitingAfterFirst &&
        trigger.stats.triggerSampleIndex === pre &&
        sameBytes(out, raw.subarray((t - pre) * 2, (t - pre + 100) * 2));
      if (!ok) pass = false;
      results2.push(`cut ${cut}: T=${trigger.stats.triggerSampleIndex}`);
    }
    check('qualified analog: decision in a later transfer, across a split sample', pass,
      results2.join(', '));
  }

  // A gap mid-candidate resets the candidate and the arm; the holdoff restarts.
  {
    const mk = (parts: Array<[number, number]>): Uint8Array => {
      const codes: number[] = [];
      for (const [code, n] of parts) for (let i = 0; i < n; i++) codes.push(code);
      return encode(Uint8Array.from(codes), 8, 0, 3);
    };
    for (const how of ['resetContinuity', 'noteGap'] as const) {
      const chunks: Uint8Array[] = [];
      const trigger = new SoftwareTrigger({
        config: { ...base(8, 0, 'rising', 128), preTriggerSamples: 10, maxSamples: 60,
          searchLimitSamples: Number.POSITIVE_INFINITY },
        emit: (c) => chunks.push(c.slice()),
      });
      trigger.feed(mk([[90, 40], [140, 10]])); // armed, candidate pending (10 < W)
      if (how === 'noteGap') trigger.noteGap(5); else trigger.resetContinuity();
      trigger.feed(mk([[140, 40]])); // continues past the level: no crossing seen after the gap
      const afterGap = trigger.waiting;
      const second = mk([[90, 40], [140, 40]]);
      trigger.feed(second);
      // T is the first 140 of `second`; its prefix comes from the post-gap stream only.
      const out = concat(chunks);
      const ok = afterGap && trigger.stats.matched && trigger.stats.triggerSampleIndex === 10 &&
        sameBytes(out.subarray(0, 60), second.subarray(30, 90));
      check(`qualified analog: ${how} mid-candidate restarts the arm and the holdoff`, ok,
        `waitingAfterGap=${afterGap}, T=${trigger.stats.triggerSampleIndex}`);
    }
  }

  // Holdoff: a crossing whose T is inside the pre-fill holdoff is consumed (it disarms)
  // even when its deciding sample lands after the holdoff; the next crossing triggers.
  {
    const codes: number[] = [];
    const push = (code: number, n: number) => { for (let i = 0; i < n; i++) codes.push(code); };
    push(90, 30); push(140, 40); push(90, 30); push(140, 40);
    const c = Uint8Array.from(codes);
    const raw = encode(c, 8, 0, 4);
    const r = oneShot(raw, c, { ...base(8, 0, 'rising', 128), preTriggerSamples: 50, maxSamples: 80,
      searchLimitSamples: Number.POSITIVE_INFINITY }, 5, 7);
    check('qualified analog: a candidate inside the holdoff is consumed, the next one triggers',
      r.matched && r.t === 50 && r.tAbs === 100 && !r.err && sameBytes(r.output, raw.subarray(50, 130)),
      `T=${r.t}, input T=${r.tAbs} ${r.err}`);
  }

  // Mixed digital + analog: the digital gate must hold on T itself.
  {
    const n = 30_000;
    const trace = adcArtifactTrace({ length: n, period: 10_000, seed: 61, ditherNear: LEVELS });
    const crossings = cleanCrossings(trace, 'rising', 128);
    const second = crossings[1]!;
    const gate = (from: number, to: number): Uint8Array => {
      const raw = encode(trace.codes, 16, 8, 6);
      for (let i = 0; i < n; i++) {
        raw[i * 2] = i >= from && i < to ? 1 : 0; // D0 is the gate, the group is byte 1
      }
      return raw;
    };
    const cfg = {
      ...base(16, 8, 'rising', 128), conditions: [{ channel: 0, kind: 'level' as const, level: 1 as const }],
      preTriggerSamples: 100, maxSamples: 400, searchLimitSamples: Number.POSITIVE_INFINITY,
    };
    const open = (from: number, to: number) => (i: number) => i >= from && i < to;
    const around = oneShot(gate(second - 300, second + 300), trace.codes, cfg, 1, 9000,
      open(second - 300, second + 300));
    // Open only after T: T itself is gated off, so that crossing does not match.
    const late = oneShot(gate(around.tAbs + 1, around.tAbs + 300), trace.codes, cfg, 2, 9000,
      open(around.tAbs + 1, around.tAbs + 300));
    const err = checkCrossings(trace, 'rising', 128, [around.tAbs]);
    check('qualified analog: a digital gate must hold on T, not only before the decision',
      around.matched && Math.abs(around.tAbs - second) < 120 && err === '' && !late.matched &&
        !around.err && !late.err,
      `gated T=${around.tAbs} (clean ${second}), late gate matched=${late.matched} ${err}` +
        `${around.err}${late.err}`);
  }

  // A capture budget smaller than pre + lag: the output still stops at maxSamples.
  {
    const codes = new Uint8Array(200);
    for (let i = 0; i < codes.length; i++) codes[i] = i < 60 ? 90 : 140;
    const raw = encode(codes, 8, 0, 8);
    const r = oneShot(raw, codes, { ...base(8, 0, 'rising', 128), preTriggerSamples: 5, maxSamples: 10,
      searchLimitSamples: Number.POSITIVE_INFINITY }, 9, 3);
    check('qualified analog: a budget below pre + lag is never exceeded',
      r.matched && r.complete && r.emitted === 10 && r.t === 5 && !r.err &&
      sameBytes(r.output, raw.subarray(55, 65)),
      `emitted=${r.emitted}, T=${r.t}, bytes=${r.output.length} ${r.err}`);
  }

  // Configuration: strict validation; the artifact window is fixed for a matcher.
  {
    const invalid = (extra: Partial<SoftwareTriggerConfig>): boolean => {
      try {
        new SoftwareTrigger({
          config: { ...base(8, 0, 'rising', 128), preTriggerSamples: 0, maxSamples: 10, ...extra },
          emit: () => {},
        });
        return false;
      } catch { return true; }
    };
    const refused = [
      invalid({ analogHysteresis: 0 }), invalid({ analogHysteresis: 256 }),
      invalid({ analogHysteresis: 1.5 }), invalid({ analogArtifactSamples: -1 }),
      invalid({ analogArtifactSamples: MAX_ANALOG_ARTIFACT_SAMPLES + 1 }),
      invalid({ analogArtifactSamples: 2.5 }),
    ];
    const accepted = !invalid({ analogArtifactSamples: 0 }) && !invalid({ analogArtifactSamples: 1 });
    const trigger = new SoftwareTrigger({
      config: { ...base(8, 0, 'rising', 128), preTriggerSamples: 0, maxSamples: 10 },
      emit: () => {},
    });
    const cfg = { ...base(8, 0, 'rising', 130), preTriggerSamples: 0, maxSamples: 10 };
    const otherW = trigger.reconfigure({ ...cfg, analogArtifactSamples: W + 1 });
    const sameW = trigger.reconfigure(cfg);
    const { analogArtifactSamples: _omit, ...omitted } = cfg;
    const omittedW = trigger.reconfigure({ ...omitted, analogHysteresis: 6 });
    check('qualified analog: strict validation, and a retune keeps the artifact window',
      refused.every(Boolean) && accepted && !otherW && sameW && omittedW &&
        trigger.analogHysteresis === 6 && trigger.analogArtifactSamples === W,
      `refused=${refused.join(',')}, W=0/1 accepted=${accepted}, otherW=${otherW}, ` +
        `sameW=${sameW}, omitted=${omittedW}`);
  }

  // Defaults keep the raw behaviour reachable: h = 1 and W = 1 is the raw crossing test.
  {
    const trace = adcArtifactTrace({ length: 20_000, period: 10_000, seed: 71, ditherNear: LEVELS });
    const raw = encode(trace.codes, 8, 0, 2);
    const firstRaw = rawCrossings(trace.codes, 'rising', 144).find((i) => i >= 50)!;
    const r = oneShot(raw, trace.codes, { channels: 8, analog: [{ start: 0, kind: 'rising', level: 144 }],
      analogHysteresis: 1, analogArtifactSamples: 1, preTriggerSamples: 50, maxSamples: 100,
      searchLimitSamples: Number.POSITIVE_INFINITY }, 4);
    check('qualified analog: hysteresis 1 with W = 1 is the raw crossing test',
      r.matched && r.tAbs === firstRaw && r.t === 50 && !r.err,
      `T=${r.tAbs}, raw first=${firstRaw} ${r.err}`);
  }

  realTraceTests(check);
  return results;
}
