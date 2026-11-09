// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Auto sweep (`autoAfterSamples`) in SoftwareTrigger: an analog trigger that sees no
 * qualified crossing within one window forces the capture at F, exactly as if T were F,
 * and reports `forced` instead of a match (docs/ARCHITECTURE.md, "Analog triggers sweep
 * in Auto, digital ones in Normal").
 *
 * Every check is byte-exact against the fed stream: a forced capture must emit
 * `[F - pre, F - pre + maxSamples)` of the input, whatever the transfer chunking (whole
 * buffers, 1-byte feeds, random fragments unrelated to the sample size) and the wire
 * width. F is `pre + autoAfterSamples - 1` (the holdoff, then the count's last sample).
 */

import { SoftwareTrigger, reverseAdcByte, type SoftwareTriggerConfig } from './softwareTrigger.js';
import { fixtureRng } from './adcArtifactFixture.js';
import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import type { SoftwareTriggerTestResult } from './softwareTriggerSelftest.js';

const W = 24;
const H = 4;

/** ADC group layouts: 16 channels with A0 in byte 0, wider captures elsewhere. */
const LAYOUTS: ReadonlyArray<readonly [ChannelCount, number]> = [
  [16, 0], [32, 16], [64, 40], [128, 120],
];

/** Interleave codes into raw samples; every other byte is seeded noise. */
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

/** Random codes in [lo, hi]: varied bytes, so a misplaced prefix cannot pass. */
function noisyCodes(length: number, lo: number, hi: number, seed: number): Uint8Array {
  const rng = fixtureRng(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = lo + Math.floor(rng() * (hi - lo + 1));
  return out;
}

type Chunking = 'whole' | 'byte' | 'random7' | 'random4k';
const CHUNKINGS: readonly Chunking[] = ['whole', 'byte', 'random7', 'random4k'];

function feedAll(trigger: SoftwareTrigger, raw: Uint8Array, chunking: Chunking, seed: number): void {
  if (chunking === 'whole') { trigger.feed(raw); return; }
  if (chunking === 'byte') {
    for (let i = 0; i < raw.length; i++) trigger.feed(raw.subarray(i, i + 1));
    return;
  }
  const max = chunking === 'random7' ? 7 : 4096;
  const rng = fixtureRng(seed);
  for (let p = 0; p < raw.length;) {
    const n = 1 + Math.floor(rng() * max);
    trigger.feed(raw.subarray(p, Math.min(raw.length, p + n)));
    p += n;
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Run {
  trigger: SoftwareTrigger;
  out: Uint8Array;
  matches: number[];
}

function run(config: SoftwareTriggerConfig, raw: Uint8Array, chunking: Chunking, seed = 1): Run {
  const chunks: Uint8Array[] = [];
  const matches: number[] = [];
  const trigger = new SoftwareTrigger({
    config,
    // The emitted range may alias the fed buffer; copy, like the store does.
    emit: (c) => chunks.push(c.slice()),
    onMatch: (m) => matches.push(m.index),
  });
  feedAll(trigger, raw, chunking, seed);
  return { trigger, out: concat(chunks), matches };
}

/** '' when `r` forced at F with a byte-exact window of `raw`, else what differs. */
function forcedError(r: Run, raw: Uint8Array, bps: number, f: number, pre: number, max: number): string {
  const s = r.trigger.stats;
  if (!s.forced) return `not forced (matched=${s.matched}, noTrigger=${s.noTrigger}, inspected=${s.inspectedSamples})`;
  if (s.matched || s.triggerSampleIndex !== null || r.matches.length !== 0) {
    return `forced but also matched (T=${s.triggerSampleIndex}, onMatch ${r.matches.length})`;
  }
  if (s.noTrigger) return 'forced and noTrigger';
  if (s.inspectedSamples !== f + 1) return `inspected ${s.inspectedSamples}, want F+1 = ${f + 1}`;
  const avail = Math.floor(raw.length / bps) - (f - pre);
  const want = Math.min(max, avail);
  if (s.emittedSamples !== want) return `emitted ${s.emittedSamples}, want ${want}`;
  if (s.complete !== (want >= max)) return `complete=${s.complete} with ${want}/${max}`;
  if (r.trigger.waiting) return 'still waiting after a force';
  if (!sameBytes(r.out, raw.subarray((f - pre) * bps, (f - pre + want) * bps))) {
    return 'emitted bytes are not [F - pre, F - pre + budget) of the input';
  }
  return '';
}

function analogConfig(
  channels: ChannelCount, start: number, kind: 'rising' | 'falling', level: number,
  pre: number, post: number, extra: Partial<SoftwareTriggerConfig> = {},
): SoftwareTriggerConfig {
  return {
    channels,
    analog: [{ start, kind, level }],
    analogHysteresis: H,
    analogArtifactSamples: W,
    preTriggerSamples: pre,
    maxSamples: pre + post,
    autoAfterSamples: pre + post,
    ...extra,
  };
}

/** Real AM trace, or null without a filesystem (browser run). */
function loadAm3(): Uint8Array | null {
  const proc = (globalThis as {
    process?: { getBuiltinModule?(name: string): unknown };
  }).process;
  const fs = proc?.getBuiltinModule?.('fs') as
    { readFileSync(path: string): Uint8Array } | undefined;
  if (!fs) return null;
  return new Uint8Array(fs.readFileSync('fixtures/adc-am-3MHz-carrier-100MSps.bin'));
}

export function runAutoSweepSuite(): SoftwareTriggerTestResult[] {
  const results: SoftwareTriggerTestResult[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    results.push({ name, pass, detail });
  };

  // 1. A flat (never crossing) signal forces exactly at F = pre + auto - 1, byte-exact,
  //    at every width and chunking, with W = 24 (look-ahead ring) and W = 1.
  {
    const pre = 100;
    const post = 300;
    const codes = noisyCodes(2_000, 40, 150, 11);
    const errors: string[] = [];
    let cases = 0;
    for (const [channels, start] of LAYOUTS) {
      const bps = bytesPerSampleForChannels(channels);
      const raw = encode(codes, channels, start, 3 + channels);
      for (const w of [W, 1]) {
        for (const chunking of CHUNKINGS) {
          if (chunking === 'byte' && channels === 128 && w === 1) continue; // cost only
          const cfg = analogConfig(channels, start, 'rising', 200, pre, post, { analogArtifactSamples: w });
          const r = run(cfg, raw, chunking, 7 + cases);
          const e = forcedError(r, raw, bps, pre + (pre + post) - 1, pre, pre + post);
          if (e) errors.push(`${channels}ch W=${w} ${chunking}: ${e}`);
          cases++;
        }
      }
    }
    check('auto sweep: a flat analog signal forces exactly at F = pre + auto - 1, byte-exact',
      errors.length === 0, errors.slice(0, 3).join('; ') || `${cases} cases`);
  }

  // 2. Deadline arithmetic is independent of the window: auto shorter and longer than
  //    the budget, a zero prefix, and a falling condition.
  {
    const codes = noisyCodes(3_000, 120, 200, 21);
    const raw = encode(codes, 16, 0, 5);
    const errors: string[] = [];
    for (const [pre, post, auto, kind, level] of [
      [0, 50, 50, 'rising', 250], [10, 40, 7, 'falling', 50], [64, 64, 1000, 'rising', 230],
      [1, 1, 1, 'falling', 10], [200, 1, 201, 'rising', 255],
    ] as const) {
      const cfg = analogConfig(16, 0, kind, level, pre, post, {
        autoAfterSamples: auto, searchLimitSamples: Number.POSITIVE_INFINITY,
      });
      for (const chunking of CHUNKINGS) {
        const e = forcedError(run(cfg, raw, chunking, auto), raw, 2, pre + auto - 1, pre, pre + post);
        if (e) errors.push(`pre ${pre} post ${post} auto ${auto} ${chunking}: ${e}`);
      }
    }
    // A search limit shorter than the deadline still ends the search first (noTrigger):
    // the caller sizes the two (the app uses limit = pre + auto).
    const short = run(analogConfig(16, 0, 'rising', 230, 64, 64, {
      autoAfterSamples: 1000, searchLimitSamples: 192,
    }), raw, 'random7').trigger.stats;
    if (short.forced || !short.noTrigger || short.inspectedSamples !== 192) {
      errors.push(`limit 192 < deadline: forced=${short.forced} noTrigger=${short.noTrigger}`);
    }
    check('auto sweep: F tracks pre + auto - 1 for any prefix, budget and slope',
      errors.length === 0, errors.slice(0, 3).join('; ') || 'ok');
  }

  // 3. A qualified fire decided before the deadline wins; one decided on F wins too; one
  //    that would be decided one sample after F loses to the force. The step is held
  //    past the level, so it is real at its W-th sample: decided at c + W - 1.
  {
    const pre = 50;
    const post = 200;
    const f = pre + (pre + post) - 1;
    const errors: string[] = [];
    for (const [label, c, wantMatch] of [
      ['well before F', f - 100, true],
      ['decided on F', f - (W - 1), true],
      ['decided at F + 1', f - (W - 1) + 1, false],
    ] as const) {
      const codes = noisyCodes(1_500, 60, 120, 31);
      codes.fill(220, c);
      for (const [channels, start] of LAYOUTS) {
        const bps = bytesPerSampleForChannels(channels);
        const raw = encode(codes, channels, start, 9);
        for (const chunking of CHUNKINGS) {
          const r = run(analogConfig(channels, start, 'rising', 200, pre, post), raw, chunking, c);
          const s = r.trigger.stats;
          if (wantMatch) {
            const ok = s.matched && !s.forced && s.triggerSampleIndex === pre &&
              r.matches.length === 1 && s.inspectedSamples === c + W &&
              sameBytes(r.out, raw.subarray((c - pre) * bps, (c - pre + pre + post) * bps));
            if (!ok) {
              errors.push(`${label} ${channels}ch ${chunking}: matched=${s.matched} forced=${s.forced} ` +
                `T=${s.triggerSampleIndex} inspected=${s.inspectedSamples}`);
            }
          } else {
            const e = forcedError(r, raw, bps, f, pre, pre + post);
            if (e) errors.push(`${label} ${channels}ch ${chunking}: ${e}`);
          }
        }
      }
    }
    check('auto sweep: a fire decided before or on F wins, one after F loses to the force',
      errors.length === 0, errors.slice(0, 3).join('; ') || 'ok');
  }

  // 4. Digital conditions take the same deadline rule (the app passes it for analog only).
  {
    const pre = 20;
    const post = 30;
    const f = pre + (pre + post) - 1;
    const errors: string[] = [];
    for (const [label, at, wantMatch] of [['on F', f, true], ['at F + 1', f + 1, false]] as const) {
      const raw = new Uint8Array(200 * 2);
      for (let i = 0; i < 200; i++) raw[i * 2] = (i * 37) & 0xfe; // bit 0 low
      for (let i = at; i < 200; i++) raw[i * 2] = raw[i * 2]! | 1;
      for (const chunking of CHUNKINGS) {
        const r = run({
          channels: 16, conditions: [{ channel: 0, kind: 'rising' }],
          preTriggerSamples: pre, maxSamples: pre + post, autoAfterSamples: pre + post,
        }, raw, chunking, at);
        const s = r.trigger.stats;
        if (wantMatch) {
          if (!(s.matched && !s.forced && s.triggerSampleIndex === pre &&
              sameBytes(r.out, raw.subarray((at - pre) * 2, (at + post) * 2)))) {
            errors.push(`${label} ${chunking}: matched=${s.matched} forced=${s.forced}`);
          }
        } else {
          const e = forcedError(r, raw, 2, f, pre, pre + post);
          if (e) errors.push(`${label} ${chunking}: ${e}`);
        }
      }
    }
    check('auto sweep: a digital rising edge on F wins, one on F + 1 is forced past',
      errors.length === 0, errors.join('; ') || 'ok');
  }

  // 5. Infinity (and omission) never forces: the old Normal behaviour, with an unbounded
  //    and with a finite search limit.
  {
    const codes = noisyCodes(20_000, 40, 150, 41);
    const raw = encode(codes, 16, 0, 2);
    const errors: string[] = [];
    for (const auto of [undefined, Number.POSITIVE_INFINITY]) {
      const { autoAfterSamples: _omit, ...normal } = analogConfig(16, 0, 'rising', 200, 100, 300);
      const cfg: SoftwareTriggerConfig = auto === undefined
        ? { ...normal, searchLimitSamples: Number.POSITIVE_INFINITY }
        : { ...normal, searchLimitSamples: Number.POSITIVE_INFINITY, autoAfterSamples: auto };
      for (const chunking of ['whole', 'random4k'] as const) {
        const r = run(cfg, raw, chunking);
        const s = r.trigger.stats;
        if (s.forced || s.matched || s.noTrigger || s.emittedSamples !== 0 || !r.trigger.waiting ||
            s.inspectedSamples !== 20_000) {
          errors.push(`auto=${auto} ${chunking}: forced=${s.forced} emitted=${s.emittedSamples}`);
        }
        const limited = run({ ...cfg, searchLimitSamples: 500 }, raw, chunking).trigger.stats;
        if (limited.forced || !limited.noTrigger || limited.emittedSamples !== 0 ||
            limited.inspectedSamples !== 500) {
          errors.push(`auto=${auto} limit 500 ${chunking}: forced=${limited.forced} noTrigger=${limited.noTrigger}`);
        }
      }
    }
    check('auto sweep: Infinity or no autoAfterSamples never forces (Normal)',
      errors.length === 0, errors.join('; ') || 'ok');
  }

  // 6. Validation: continuous mode rejects a finite value; bad values throw.
  {
    const throws = (cfg: SoftwareTriggerConfig): boolean => {
      try { new SoftwareTrigger({ config: cfg, emit: () => {} }); return false; } catch { return true; }
    };
    const { autoAfterSamples: _omit, ...base } = analogConfig(16, 0, 'rising', 200, 10, 10);
    const bad = [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY, 2 ** 53]
      .filter((v) => !throws({ ...base, autoAfterSamples: v }));
    const loopRejects = throws({ ...base, mode: 'continuous', maxSamples: Number.POSITIVE_INFINITY, autoAfterSamples: 100 }) &&
      throws({ ...base, mode: 'continuous', autoAfterSamples: 1 });
    const loopInfinityOk = !throws({
      ...base, mode: 'continuous', maxSamples: Number.POSITIVE_INFINITY,
      autoAfterSamples: Number.POSITIVE_INFINITY,
    });
    const oneShotOk = !throws({ ...base, autoAfterSamples: 1 }) && !throws({ ...base, mode: 'one-shot' });
    // A continuous retune cannot slip a deadline in either.
    const loop = new SoftwareTrigger({
      config: { ...base, mode: 'continuous', maxSamples: Number.POSITIVE_INFINITY },
      emit: () => {},
    });
    let retuneRejects = false;
    try { loop.reconfigure({ ...base, mode: 'continuous', maxSamples: Number.POSITIVE_INFINITY, autoAfterSamples: 5 }); }
    catch { retuneRejects = true; }
    check('auto sweep: invalid values and continuous (Loop) mode are rejected',
      bad.length === 0 && loopRejects && loopInfinityOk && oneShotOk && retuneRejects,
      `accepted bad ${bad.join(',')}; loop rejects ${loopRejects}; loop Infinity ok ${loopInfinityOk}; ` +
        `one-shot ok ${oneShotOk}; retune rejects ${retuneRejects}`);
  }

  // 7. Repeat's search limit pre + (pre + post) with auto = pre + post: the force lands
  //    on the last inspectable sample, so the search never ends as noTrigger.
  {
    const errors: string[] = [];
    for (const [pre, post] of [[100, 300], [0, 64], [1, 1], [500, 7]] as const) {
      const codes = noisyCodes(4 * (2 * pre + post) + 100, 40, 150, pre + post);
      for (const [channels, start] of LAYOUTS) {
        const bps = bytesPerSampleForChannels(channels);
        const raw = encode(codes, channels, start, post);
        for (const chunking of CHUNKINGS) {
          if (chunking === 'byte' && channels > 32) continue; // cost only
          const limit = pre + (pre + post);
          const r = run(analogConfig(channels, start, 'falling', 10, pre, post, { searchLimitSamples: limit }),
            raw, chunking, limit);
          const e = forcedError(r, raw, bps, limit - 1, pre, pre + post);
          if (e) errors.push(`pre ${pre} post ${post} ${channels}ch ${chunking}: ${e}`);
          else if (r.trigger.stats.inspectedSamples !== limit) errors.push(`inspected != limit`);
        }
      }
    }
    check('auto sweep: Repeat\'s search limit never reaches noTrigger before the force',
      errors.length === 0, errors.slice(0, 3).join('; ') || 'ok');
  }

  // 8. A gap pauses the count (the emptied ring refills the holdoff) without restarting
  //    it, and the forced prefix never spans the gap. A retune keeps the count and adopts
  //    a new deadline.
  {
    const pre = 30;
    const post = 70;
    const codes = noisyCodes(1_000, 40, 150, 51);
    const raw = encode(codes, 16, 0, 8);
    const chunks: Uint8Array[] = [];
    const t = new SoftwareTrigger({
      config: analogConfig(16, 0, 'rising', 200, pre, post, { searchLimitSamples: Number.POSITIVE_INFINITY }),
      emit: (c) => chunks.push(c.slice()),
    });
    // Holdoff 30 + 40 counted, then a gap.
    t.feed(raw.subarray(0, 70 * 2));
    t.resetContinuity();
    // After the gap: 30 holdoff samples, then 100 - 40 = 60 more; F is the 60th.
    const after = 70;
    t.feed(raw.subarray(after * 2));
    const f = after + pre + 60 - 1;
    const s = t.stats;
    const gapOk = s.forced && s.inspectedSamples === f + 1 &&
      sameBytes(concat(chunks), raw.subarray((f - pre) * 2, (f - pre + pre + post) * 2));

    const chunks2: Uint8Array[] = [];
    const t2 = new SoftwareTrigger({
      config: analogConfig(16, 0, 'rising', 200, pre, post, {
        autoAfterSamples: Number.POSITIVE_INFINITY, searchLimitSamples: Number.POSITIVE_INFINITY,
      }),
      emit: (c) => chunks2.push(c.slice()),
    });
    t2.feed(raw.subarray(0, 200 * 2)); // 170 counted, Normal: no force
    const waited = t2.waiting && !t2.stats.forced;
    // A retune that omits the value keeps Normal.
    const { autoAfterSamples: _omit, ...omitted } = analogConfig(16, 0, 'rising', 210, pre, post);
    t2.reconfigure(omitted);
    t2.feed(raw.subarray(200 * 2, 210 * 2));
    const kept = t2.waiting && !t2.stats.forced;
    // Adopting a deadline already passed forces at the next inspected sample (210).
    t2.reconfigure(analogConfig(16, 0, 'rising', 210, pre, post, { autoAfterSamples: 50 }));
    t2.feed(raw.subarray(210 * 2));
    const s2 = t2.stats;
    const retuneOk = waited && kept && s2.forced && s2.inspectedSamples === 211 &&
      sameBytes(concat(chunks2), raw.subarray((210 - pre) * 2, (210 - pre + pre + post) * 2));
    check('auto sweep: a gap pauses the count and a retune keeps it',
      gapOk && retuneOk,
      `gap: forced=${s.forced} inspected=${s.inspectedSamples} want ${f + 1}; retune: waited=${waited} ` +
        `kept=${kept} forced=${s2.forced} inspected=${s2.inspectedSamples}`);
  }

  // 9. A forced capture ignores later crossings and finish(); stop-time finish() must not
  //    turn it into noTrigger.
  {
    const codes = noisyCodes(600, 40, 150, 61);
    codes.fill(230, 300); // a real crossing long after F = 10 + 30 - 1 = 39
    const raw = encode(codes, 16, 0, 4);
    const r = run(analogConfig(16, 0, 'rising', 200, 10, 20), raw, 'random7');
    r.trigger.finish();
    const s = r.trigger.stats;
    check('auto sweep: a completed force stays forced (no later match, finish() is a no-op)',
      s.forced && !s.matched && !s.noTrigger && s.complete && s.emittedSamples === 30 && r.matches.length === 0,
      `forced=${s.forced} matched=${s.matched} noTrigger=${s.noTrigger} emitted=${s.emittedSamples}`);
  }

  // 10. The real AM wave (fixtures/adc-am-3MHz-carrier-100MSps.bin, max code 161) at an
  //     unreachable level forces, byte-exact, from several start offsets and widths.
  {
    const am = loadAm3();
    if (am === null) {
      check('auto sweep: real AM trace skipped (no filesystem)', true, 'browser run');
    } else {
      let max = 0;
      for (const c of am) if (c > max) max = c;
      const pre = 2_000;
      const post = 20_000;
      const errors: string[] = [];
      let cases = 0;
      for (const offset of [0, 12_345, 100_001, 250_000]) {
        const codes = am.subarray(offset, Math.min(am.length, offset + 60_000));
        for (const [channels, start] of LAYOUTS) {
          const bps = bytesPerSampleForChannels(channels);
          const raw = encode(codes, channels, start, offset + channels);
          for (const chunking of ['whole', 'random7', 'random4k'] as const) {
            if (chunking === 'random7' && channels > 16) continue; // cost only
            const r = run(analogConfig(channels, start, 'rising', 250, pre, post), raw, chunking, offset);
            const e = forcedError(r, raw, bps, pre + (pre + post) - 1, pre, pre + post);
            if (e) errors.push(`offset ${offset} ${channels}ch ${chunking}: ${e}`);
            cases++;
          }
        }
      }
      // The same trace at a reachable level triggers instead (the force is not masking it).
      const reach = run(analogConfig(16, 0, 'rising', 128, pre, post), encode(am.subarray(0, 60_000), 16, 0, 1), 'random4k');
      const reachOk = reach.trigger.stats.matched && !reach.trigger.stats.forced;
      check('auto sweep: the real 3.3 MHz AM trace at rising 250 forces byte-exact (and triggers at 128)',
        max < 250 - H && errors.length === 0 && reachOk,
        errors.slice(0, 3).join('; ') || `max code ${max}, ${cases} cases, reachable level matched ${reachOk}`);
    }
  }

  return results;
}
