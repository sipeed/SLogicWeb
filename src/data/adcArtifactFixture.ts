// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test fixture (not shipped behaviour): a synthetic ADC trace carrying the carry-boundary
 * artifact measured on a 32U3 on 2026-11-06, for the analog-trigger self-tests.
 *
 * The module's 8-bit bus is sampled asynchronously to its code transitions, so at a
 * transition whose old and new codes differ in more than the rising bits (a carry or
 * borrow: 143 -> 144, 127 -> 128, 112 -> 111, ...) the host reads `old | new` for 1-14
 * samples at 100 MS/s. This generator reproduces that on a clean sine, seeded, plus +-1
 * code dither while the clean code is near one of the given levels.
 */

export interface AdcArtifactOptions {
  /** Samples in the trace. */
  length: number;
  /** Sine period in samples. */
  period: number;
  /** Code range of the clean sine; default 84..175. */
  min?: number;
  max?: number;
  /** Phase of sample 0, in radians. */
  phase?: number;
  seed: number;
  /** Levels near which (+-1.5 codes) the clean code is dithered by +-1. */
  ditherNear?: readonly number[];
  /** Per-sample dither probability near a level; default 0.15. */
  ditherProbability?: number;
  /** Longest artifact run; default 14 (the measured worst case at 100 MS/s). A run never
   * covers the whole dwell of a code: its last sample reads the settled code. */
  maxArtifactSamples?: number;
}

export interface AdcArtifactTrace {
  /** What the host reads: dithered codes with OR-of-codes artifacts. */
  codes: Uint8Array;
  /** The rounded clean sine, no dither and no artifact. */
  clean: Uint8Array;
  /** Samples that read an artifact. */
  artifactSamples: number;
  period: number;
  phase: number;
}

/** Deterministic PRNG (mulberry32). */
export function fixtureRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function adcArtifactTrace(opts: AdcArtifactOptions): AdcArtifactTrace {
  const min = opts.min ?? 84;
  const max = opts.max ?? 175;
  const phase = opts.phase ?? 0;
  const near = opts.ditherNear ?? [];
  const p = opts.ditherProbability ?? 0.15;
  const longest = opts.maxArtifactSamples ?? 14;
  const rng = fixtureRng(opts.seed);
  const mid = (min + max) / 2;
  const amp = (max - min) / 2;
  const clean = new Uint8Array(opts.length);
  const dithered = new Uint8Array(opts.length);
  for (let i = 0; i < opts.length; i++) {
    const v = mid + amp * Math.sin((2 * Math.PI * i) / opts.period + phase);
    const c = Math.round(v);
    clean[i] = c;
    let d = c;
    if (near.some((level) => Math.abs(v - level) <= 1.5) && rng() < p) d += rng() < 0.5 ? -1 : 1;
    dithered[i] = Math.max(0, Math.min(255, d));
  }
  const codes = dithered.slice();
  const isArtifact = new Uint8Array(opts.length);
  let artifactSamples = 0;
  for (let i = 1; i < opts.length; i++) {
    const old = dithered[i - 1]!;
    const next = dithered[i]!;
    if (old === next) continue;
    const or = old | next;
    if (or === old || or === next) continue;
    // The first 1..longest samples of the new code read as the OR. The host always sees
    // the settled code before the next transition (the measured artifact is shorter than
    // one code's dwell), so the last sample of a dwell keeps the true code and an artifact
    // never chains into the next one.
    const want = 1 + Math.floor(rng() * longest);
    for (let k = 0; k < want && i + k + 1 < opts.length && dithered[i + k] === next &&
        dithered[i + k + 1] === next; k++) {
      codes[i + k] = or;
      isArtifact[i + k] = 1;
      artifactSamples++;
    }
  }
  return { codes, clean, artifactSamples, period: opts.period, phase };
}

/** Clean crossings of `level`: the first clean sample at/past it on each matching slope. */
export function cleanCrossings(
  trace: AdcArtifactTrace, kind: 'rising' | 'falling', level: number,
): number[] {
  const out: number[] = [];
  const c = trace.clean;
  for (let i = 1; i < c.length; i++) {
    if (kind === 'rising' ? c[i - 1]! < level && c[i]! >= level
      : c[i - 1]! > level && c[i]! <= level) out.push(i);
  }
  return out;
}

/** Whether the clean sine rises (+1) or falls (-1) at sample `i`. */
export function cleanSlope(trace: AdcArtifactTrace, i: number): 1 | -1 {
  return Math.cos((2 * Math.PI * i) / trace.period + trace.phase) >= 0 ? 1 : -1;
}

/**
 * Check reported crossings against the clean sine: each on the right slope and within
 * `[-early, +late]` samples of a clean crossing. Returns '' or the first problem.
 */
export function checkCrossings(
  trace: AdcArtifactTrace, kind: 'rising' | 'falling', level: number,
  reported: readonly number[], early = 60, late = 120,
): string {
  const clean = cleanCrossings(trace, kind, level);
  const want = kind === 'rising' ? 1 : -1;
  for (const t of reported) {
    if (cleanSlope(trace, t) !== want) {
      return `T=${t} (code ${trace.codes[t]}, clean ${trace.clean[t]}) is on the wrong slope`;
    }
    let best = Number.POSITIVE_INFINITY;
    for (const c of clean) if (Math.abs(t - c) < Math.abs(best)) best = t - c;
    if (!(best >= -early && best <= late)) {
      return `T=${t} is ${best} samples from the nearest clean ${kind} crossing of ${level}`;
    }
  }
  return '';
}

/** One qualified analog fire: T and the sample whose arrival decided it. */
export interface QualifiedFire {
  t: number;
  decide: number;
}

/**
 * Reference model of the qualified analog crossing (docs/ARCHITECTURE.md, "Analog
 * crossings are qualified, never raw"; SoftwareTrigger module comment), written over a
 * whole code array with unlimited look-ahead, as the oracle the streaming matchers are
 * compared against. A run is real when it reaches `w` samples or ends without the
 * OR-artifact shape. Index 0 is the first sample after a reset: it may start an arm run
 * (judged without `a`), never a candidate. A run whose judgement needs samples past the
 * end is undecided and does not fire. `w` <= 1 rejects nothing.
 */
export function qualifiedFires(
  codes: ArrayLike<number>, kind: 'rising' | 'falling', level: number, h: number, w: number,
): QualifiedFire[] {
  const rise = kind === 'rising';
  const arm = rise ? Math.max(0, level - h) : Math.min(255, level + h);
  const past = (g: number): boolean => (rise ? g >= level : g <= level);
  const far = (g: number): boolean => (rise ? g <= arm : g >= arm);
  const n = codes.length;
  /** [real, decide] for the run starting at i, or null when undecided at the end. */
  const judge = (i: number, inRun: (g: number) => boolean): [boolean, number] | null => {
    if (w <= 1) return [true, i];
    let j = i;
    while (j < n && inRun(codes[j]!) && j - i < w) j++;
    if (j - i >= w) return [true, i + w - 1];
    if (j >= n) return null;
    const a = i > 0 ? codes[i - 1]! : -1;
    const b = codes[j]!;
    for (let k = i; k < j; k++) {
      const g = codes[k]!;
      if ((g & b) !== b || g <= b || (a >= 0 && ((g & a) !== a || g <= a))) return [true, j];
    }
    return [false, j];
  };
  const fires: QualifiedFire[] = [];
  let armed = false;
  for (let i = 0; i < n; i++) {
    const g = codes[i]!;
    if (!armed) {
      if (far(g) && (i === 0 || !far(codes[i - 1]!))) {
        const r = judge(i, far);
        if (r === null) break;
        if (r[0]) armed = true;
      }
      continue;
    }
    if (i > 0 && past(g) && !past(codes[i - 1]!)) {
      const r = judge(i, past);
      if (r === null) break;
      if (r[0]) {
        fires.push({ t: i, decide: r[1] });
        armed = false;
      }
    }
  }
  return fires;
}

/** A raw `previous < level <= current` scan, for showing that a trace is adversarial. */
export function rawCrossings(codes: Uint8Array, kind: 'rising' | 'falling', level: number): number[] {
  const out: number[] = [];
  for (let i = 1; i < codes.length; i++) {
    if (kind === 'rising' ? codes[i - 1]! < level && codes[i]! >= level
      : codes[i - 1]! > level && codes[i]! <= level) out.push(i);
  }
  return out;
}
