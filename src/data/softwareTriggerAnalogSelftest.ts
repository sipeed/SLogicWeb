// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Qualified analog crossings (hysteresis + persistence) in SoftwareTrigger, on the
 * measured ADC carry-boundary artifact (`adcArtifactFixture.ts`): Single-style one-shot,
 * Repeat-style finite search limits, continuous (Loop) mode at several strides, no
 * trigger, transfer/sample boundaries, gaps, holdoff, mixed digital gates, tiny budgets
 * and every wire width that can hold an ADC group.
 */

import {
  MAX_ANALOG_PERSIST_SAMPLES,
  SoftwareTrigger,
  reverseAdcByte,
  type SoftwareTriggerConfig,
} from './softwareTrigger.js';
import {
  adcArtifactTrace, checkCrossings, cleanCrossings, cleanSlope, fixtureRng, rawCrossings,
  type AdcArtifactTrace,
} from './adcArtifactFixture.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import type { SoftwareTriggerTestResult } from './softwareTriggerSelftest.js';

/** 240 ns at 100 MS/s, and the ADC module's code hysteresis. */
const P = 24;
const H = 4;
const LEVELS = [100, 112, 128, 144, 160] as const;
const KINDS = ['rising', 'falling'] as const;

/** Interleave a code trace into raw samples: the group byte carries the code, every
 * other byte seeded noise (so a wrong byte offset cannot pass). */
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

interface OneShot {
  matched: boolean;
  noTrigger: boolean;
  complete: boolean;
  /** Emitted index of T. */
  t: number | null;
  /** Input index of T: the confirmation is the last inspected sample. */
  tAbs: number;
  output: Uint8Array;
  emitted: number;
}

function oneShot(
  raw: Uint8Array, config: SoftwareTriggerConfig, seed: number, maxBytes = 9000,
): OneShot {
  const chunks: Uint8Array[] = [];
  const trigger = new SoftwareTrigger({ config, emit: (c) => chunks.push(c.slice()) });
  feedRandom(trigger, raw, seed, maxBytes);
  trigger.finish();
  const s = trigger.stats;
  const persist = config.analogPersistSamples ?? 1;
  return {
    matched: s.matched, noTrigger: s.noTrigger, complete: s.complete,
    t: s.triggerSampleIndex, tAbs: s.inspectedSamples - persist,
    output: concat(chunks), emitted: s.emittedSamples,
  };
}

/** The first clean crossing at or after `from`. */
function firstCleanAfter(trace: AdcArtifactTrace, kind: 'rising' | 'falling', level: number, from: number): number {
  return cleanCrossings(trace, kind, level).find((c) => c >= from) ?? -1;
}

export function runQualifiedAnalogSuite(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };
  const base = (channels: ChannelCount, start: number, kind: 'rising' | 'falling', level: number) => ({
    channels,
    analog: [{ start, kind, level }],
    analogHysteresis: H,
    analogPersistSamples: P,
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
          const r = oneShot(raw, { ...base(32, 16, kind, level), preTriggerSamples: pre, maxSamples: max,
            searchLimitSamples: Number.POSITIVE_INFINITY }, phaseStep * 31 + level);
          const bps = 4;
          const first = firstCleanAfter(trace, kind, level, pre + 200);
          const crossing = checkCrossings(trace, kind, level, [r.tAbs]);
          const want = raw.subarray((r.tAbs - pre) * bps, (r.tAbs - pre + max) * bps);
          if (!r.matched || r.t !== pre || !r.complete || r.emitted !== max) {
            bad = `${kind} ${level} phase ${phaseStep}: matched=${r.matched} T=${r.t} emitted=${r.emitted}`;
          } else if (crossing) {
            bad = `${kind} ${level} phase ${phaseStep}: ${crossing}`;
          } else if (first >= 0 && r.tAbs > first + 120) {
            bad = `${kind} ${level} phase ${phaseStep}: skipped the clean crossing at ${first} (T=${r.tAbs})`;
          } else if (!sameBytes(r.output, want)) {
            bad = `${kind} ${level} phase ${phaseStep}: emitted bytes are not the input stream at T - pre`;
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
        const pre = 300;
        const max = 2000;
        const r = oneShot(raw, { ...base(channels, start, kind, level), preTriggerSamples: pre, maxSamples: max,
          searchLimitSamples: Number.POSITIVE_INFINITY }, channels + start, bps * 700 + 3);
        const crossing = checkCrossings(trace, kind, level, [r.tAbs]);
        const want = raw.subarray((r.tAbs - pre) * bps, (r.tAbs - pre + max) * bps);
        if (!r.matched || r.t !== pre || crossing || !sameBytes(r.output, want)) {
          bad = `${channels}ch group ${start} ${kind}: matched=${r.matched} T=${r.t} ${crossing}`;
          break;
        }
      }
    }
    check('qualified analog: 8/16/32/64/128-channel layouts read their own group byte',
      bad === '', bad || `${layouts.length} layouts x rising/falling`);
  }

  // Levels outside the signal never trigger, although the OR artifact reaches 255 (from
  // 127 -> 128): Rising 200 sees short candidates, Falling 190 short faked arms.
  {
    let bad = '';
    const trace = adcArtifactTrace({ length: 40_000, period: 10_000, seed: 31, ditherNear: LEVELS });
    const raw = encode(trace.codes, 16, 8, 5);
    const outside: Array<['rising' | 'falling', number]> = [
      ['rising', 200], ['rising', 80], ['falling', 60], ['falling', 190],
    ];
    let rawFalse = 0;
    for (const [kind, level] of outside) {
      rawFalse += rawCrossings(trace.codes, kind, level).length;
      const r = oneShot(raw, { ...base(16, 8, kind, level), preTriggerSamples: 100, maxSamples: 1000,
        searchLimitSamples: Number.POSITIVE_INFINITY }, level);
      if (r.matched || !r.noTrigger || r.output.length !== 0) bad = `${kind} ${level} triggered at ${r.tAbs}`;
    }
    check('qualified analog: no trigger when the level is outside the signal',
      bad === '' && rawFalse > 0, bad || `none of 4 out-of-range levels fired (raw test: ${rawFalse})`);
  }

  // The artifact only raises codes, so on the rising slope it fakes a *falling* arm:
  // 111 -> 112 reads 127 >= 112 + h, then the genuine 112s persist at/past the level.
  // Arming persists too, so this never triggers; with P = 1 it would.
  {
    const codes: number[] = [];
    const push = (code: number, n: number) => { for (let i = 0; i < n; i++) codes.push(code); };
    push(100, 40); push(111, 30); push(127, 6); push(112, 60); push(113, 60);
    const raw = encode(Uint8Array.from(codes), 8, 0, 12);
    const cfg = { ...base(8, 0, 'falling', 112), preTriggerSamples: 10, maxSamples: 50,
      searchLimitSamples: Number.POSITIVE_INFINITY };
    const qualified = oneShot(raw, cfg, 1, 5);
    const singleSampleArm = oneShot(raw, { ...cfg, analogPersistSamples: 1 }, 2, 5);
    check('qualified analog: a faked falling arm on the rising slope does not trigger',
      !qualified.matched && qualified.noTrigger && singleSampleArm.matched,
      `qualified matched=${qualified.matched}, one-sample arm matched=${singleSampleArm.matched}`);
  }

  // Repeat: a finite search limit. The persistence samples count toward it: a limit that
  // ends one sample before the confirmation finds nothing, one that includes it matches.
  {
    const trace = adcArtifactTrace({ length: 20_000, period: 10_000, seed: 41, phase: 2, ditherNear: LEVELS });
    const raw = encode(trace.codes, 16, 0, 9);
    const cfg = { ...base(16, 0, 'rising', 128), preTriggerSamples: 200, maxSamples: 800 };
    const free = oneShot(raw, { ...cfg, searchLimitSamples: Number.POSITIVE_INFINITY }, 1);
    const confirm = free.tAbs + P - 1;
    const exact = oneShot(raw, { ...cfg, searchLimitSamples: confirm + 1 }, 2);
    const short = oneShot(raw, { ...cfg, searchLimitSamples: confirm }, 3);
    check('qualified analog: Repeat search limit includes the persistence samples',
      free.matched && exact.matched && exact.tAbs === free.tAbs && short.noTrigger && !short.matched,
      `T=${free.tAbs}, limit ${confirm + 1}: ${exact.matched}, limit ${confirm}: noTrigger=${short.noTrigger}`);

    // Consecutive Repeat sweeps, each a fresh one-shot matcher on the next stretch.
    const long = adcArtifactTrace({ length: 120_000, period: 10_000, seed: 43, ditherNear: LEVELS });
    let bad = '';
    let sweeps = 0;
    for (const kind of KINDS) {
      const rawLong = encode(long.codes, 32, 8, 13);
      let pos = 0;
      while (pos < long.codes.length - 15_000 && !bad) {
        const r = oneShot(rawLong.subarray(pos * 4), {
          ...base(32, 8, kind, 160), preTriggerSamples: 500, maxSamples: 2500,
          searchLimitSamples: 500 + 12_000,
        }, pos + 1);
        if (!r.matched) { bad = `${kind} sweep at ${pos}: no trigger`; break; }
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
  // T is on the right slope, and every clean crossing after the first is reported.
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
            let firstInspected = -1;
            const trigger = new SoftwareTrigger({
              config: {
                ...base(32, 24, kind, level), mode: 'continuous', preTriggerSamples: pre,
                maxSamples, searchLimitSamples: Number.POSITIVE_INFINITY,
                scan: { minStride: stride, maxStride: stride, initialStride: stride },
              },
              emit: () => {},
              onMatch: (m) => {
                if (m.count === 1) firstInspected = trigger.stats.inspectedSamples;
                matches.push(m.index);
              },
            });
            feedRandom(trigger, raw, stride * 1000 + level, 20_000);
            const t0 = firstInspected - P;
            const origin = t0 - pre; // input index of emitted sample 0
            const abs = matches.map((m) => m + origin);
            const end = finite ? origin + maxSamples : trace.codes.length;
            const err = checkCrossings(trace, kind, level, abs);
            const expected = cleanCrossings(trace, kind, level)
              .filter((c) => c > t0 + 200 && c < end - 200).length;
            const later = abs.filter((a) => a > t0 + 200 && a < end - 200).length;
            const name = `stride ${stride} ${kind} ${level}${finite ? ' finite' : ''}`;
            if (firstInspected < 0) bad = `${name}: no first match`;
            else if (err) bad = `${name}: ${err}`;
            else if (later !== expected) bad = `${name}: ${later} later crossings reported, ${expected} clean`;
            else if (trigger.stats.matchCount !== matches.length) bad = `${name}: matchCount mismatch`;
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

  // Confirmation in a later transfer than T, with a sample split across transfers.
  {
    const codes = new Uint8Array(200);
    for (let i = 0; i < codes.length; i++) codes[i] = i < 60 ? 90 : 140;
    const raw = encode(codes, 16, 8, 21);
    const pre = 20;
    const t = 60;
    const results2: string[] = [];
    let pass = true;
    // Split inside T's run, and inside a sample (odd byte offsets).
    for (const cut of [(t + 3) * 2 + 1, (t + P - 1) * 2 + 1, t * 2 + 1]) {
      const chunks: Uint8Array[] = [];
      const trigger = new SoftwareTrigger({
        config: { ...base(16, 8, 'rising', 128), preTriggerSamples: pre, maxSamples: 100 },
        emit: (c) => chunks.push(c.slice()),
      });
      trigger.feed(raw.subarray(0, cut));
      const waitingAfterFirst = trigger.waiting;
      trigger.feed(raw.subarray(cut));
      const out = concat(chunks);
      const ok = (cut < (t + P - 1) * 2 + 2 ? waitingAfterFirst : true) &&
        trigger.stats.triggerSampleIndex === pre &&
        sameBytes(out, raw.subarray((t - pre) * 2, (t - pre + 100) * 2));
      if (!ok) pass = false;
      results2.push(`cut ${cut}: T=${trigger.stats.triggerSampleIndex}`);
    }
    check('qualified analog: confirmation in a later transfer, across a split sample', pass,
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
      trigger.feed(mk([[90, 40], [140, 10]])); // armed, candidate pending (10 < P)
      if (how === 'noteGap') trigger.noteGap(5); else trigger.resetContinuity();
      trigger.feed(mk([[140, 40]])); // continues past the level: not armed after the gap
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
  // even when its confirmation lands after the holdoff; the next crossing triggers.
  {
    const codes: number[] = [];
    const push = (code: number, n: number) => { for (let i = 0; i < n; i++) codes.push(code); };
    push(90, 30); push(140, 40); push(90, 30); push(140, 40);
    const raw = encode(Uint8Array.from(codes), 8, 0, 4);
    const r = oneShot(raw, { ...base(8, 0, 'rising', 128), preTriggerSamples: 50, maxSamples: 80,
      searchLimitSamples: Number.POSITIVE_INFINITY }, 5, 7);
    check('qualified analog: a candidate inside the holdoff is consumed, the next one triggers',
      r.matched && r.t === 50 && r.tAbs === 100 && sameBytes(r.output, raw.subarray(50, 130)),
      `T=${r.t}, input T=${r.tAbs}`);
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
    const around = oneShot(gate(second - 300, second + 300), cfg, 1);
    // Open only from inside the persistence window: T itself is gated off.
    const late = oneShot(gate(around.tAbs + 5, around.tAbs + 300), cfg, 2);
    const err = checkCrossings(trace, 'rising', 128, [around.tAbs]);
    check('qualified analog: a digital gate must hold on T, not only during persistence',
      around.matched && Math.abs(around.tAbs - second) < 120 && err === '' && !late.matched,
      `gated T=${around.tAbs} (clean ${second}), late gate matched=${late.matched} ${err}`);
  }

  // A capture budget smaller than pre + P: the output still stops at maxSamples.
  {
    const codes = new Uint8Array(200);
    for (let i = 0; i < codes.length; i++) codes[i] = i < 60 ? 90 : 140;
    const raw = encode(codes, 8, 0, 8);
    const r = oneShot(raw, { ...base(8, 0, 'rising', 128), preTriggerSamples: 5, maxSamples: 10,
      searchLimitSamples: Number.POSITIVE_INFINITY }, 9, 3);
    check('qualified analog: a budget below pre + P is never exceeded',
      r.matched && r.complete && r.emitted === 10 && r.t === 5 &&
      sameBytes(r.output, raw.subarray(55, 65)),
      `emitted=${r.emitted}, T=${r.t}, bytes=${r.output.length}`);
  }

  // Configuration: strict validation; the persistence window is fixed for a matcher.
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
      invalid({ analogHysteresis: 1.5 }), invalid({ analogPersistSamples: 0 }),
      invalid({ analogPersistSamples: MAX_ANALOG_PERSIST_SAMPLES + 1 }),
      invalid({ analogPersistSamples: 2.5 }),
    ];
    const trigger = new SoftwareTrigger({
      config: { ...base(8, 0, 'rising', 128), preTriggerSamples: 0, maxSamples: 10 },
      emit: () => {},
    });
    const cfg = { ...base(8, 0, 'rising', 130), preTriggerSamples: 0, maxSamples: 10 };
    const otherP = trigger.reconfigure({ ...cfg, analogPersistSamples: P + 1 });
    const sameP = trigger.reconfigure(cfg);
    const { analogPersistSamples: _omit, ...omitted } = cfg;
    const omittedP = trigger.reconfigure({ ...omitted, analogHysteresis: 6 });
    check('qualified analog: strict validation, and a retune keeps the persistence window',
      refused.every(Boolean) && !otherP && sameP && omittedP && trigger.analogHysteresis === 6 &&
      trigger.analogPersistSamples === P,
      `refused=${refused.join(',')}, otherP=${otherP}, sameP=${sameP}, omitted=${omittedP}`);
  }

  // Defaults keep the old raw behaviour reachable: h = 1 and P = 1 is the raw test.
  {
    const trace = adcArtifactTrace({ length: 20_000, period: 10_000, seed: 71, ditherNear: LEVELS });
    const raw = encode(trace.codes, 8, 0, 2);
    const firstRaw = rawCrossings(trace.codes, 'rising', 144).find((i) => i >= 50)!;
    const r = oneShot(raw, { channels: 8, analog: [{ start: 0, kind: 'rising', level: 144 }],
      analogHysteresis: 1, analogPersistSamples: 1, preTriggerSamples: 50, maxSamples: 100,
      searchLimitSamples: Number.POSITIVE_INFINITY }, 4);
    check('qualified analog: hysteresis 1 with persistence 1 is the raw crossing test',
      r.matched && r.tAbs === firstRaw && r.t === 50,
      `T=${r.tAbs}, raw first=${firstRaw}`);
  }

  return results;
}
