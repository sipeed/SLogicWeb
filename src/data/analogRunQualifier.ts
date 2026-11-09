// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One qualified ADC crossing, streamed one complete sample at a time: hysteresis plus
 * OR-artifact rejection (docs/ARCHITECTURE.md, trigger section, "Analog crossings are
 * qualified, never raw"). Used by the Loop page scanner (`AnalogCrossingScanner`) and the
 * SimDriver's analog matcher; `SoftwareTrigger` implements the same rule on its own.
 *
 * Thresholds, for a Rising condition (Falling mirrors them):
 *  - `far`  : code <= level - h (clamped to 0) - the arming side;
 *  - `past` : code >= level - the candidate side.
 *
 * A *run* is a maximal stretch of consecutive samples on one side of a threshold. While
 * unarmed the machine watches for an arm run (a `far` sample whose predecessor is not
 * `far`); while armed, for a candidate run (a `past` sample whose predecessor is not
 * `past`). Each run is judged once, from its first sample, with `a` = the sample before it
 * and `b` = the sample after it. It is an ARTIFACT - neither arms nor fires - when
 *   - it is shorter than W samples and it ends (`b` is back on the other side), and
 *   - every code g in it has `(g & a) === a`, `(g & b) === b` and `g > max(a, b)`.
 * Any other run is real: an arm run arms, a candidate run fires with T = its first sample
 * and disarms (one fire per arm).
 *
 * No codes are buffered: the run keeps the AND and the minimum of its codes, which is all
 * the `b` test needs ((AND & b) === b, min > b). The decision lands at the latest on the
 * W-th sample of the run (it is then W long, so real) or on `b`, i.e. at most W - 1
 * samples after T; a run that fails the `a` test is decided real on the sample that fails
 * it.
 *
 * Streaming definitions (assumptions the oracle over a flat array leaves open):
 *  - The first sample after `reset()` (or a hand-off with no predecessor) has no `a`. If
 *    it is `far` while unarmed it starts an arm run judged against `b` alone (every code
 *    carries b's bits and exceeds it, and the run is shorter than W, then it is an
 *    artifact): a stream that begins below a Rising level arms at once, but one that
 *    begins on a carry glitch (111→112 reads 127) does not arm Falling 112. A candidate run
 *    needs a predecessor on the other side, so the first sample never fires. This is the
 *    same start rule `SoftwareTrigger` applies.
 *  - `enter(armed, prev)` resumes at a known state with a known predecessor (the Loop
 *    scanner's hand-off from its strided scan); `prev` < 0 means "no predecessor".
 *  - Degenerate W: W = 0 and W = 1 make every run real (hysteresis only, no artifact
 *    rejection, decisions are immediate); W = 2 rejects single-sample OR runs only.
 */

export const ANALOG_RUN_NONE = 0;
export const ANALOG_RUN_ARM = 1;
export const ANALOG_RUN_CANDIDATE = 2;

export interface AnalogRunQualifierConfig {
  rising: boolean;
  /** ADC code 0..255. */
  level: number;
  /** Hysteresis h in codes (>= 1). */
  hysteresis: number;
  /** Artifact window W in samples (>= 0). */
  window: number;
}

export class AnalogRunQualifier {
  readonly rising: boolean;
  readonly level: number;
  /** Arming threshold: Rising arms on code <= arm, Falling on code >= arm. */
  readonly arm: number;
  readonly window: number;
  /** Armed: the next real candidate run fires. */
  armed = false;
  /** Previous code, -1 when there is none (start, gap, reset). */
  private prev = -1;
  /** The run being judged: ANALOG_RUN_NONE / _ARM / _CANDIDATE. */
  pending = ANALOG_RUN_NONE;
  /** Absolute index of the pending run's first sample (T for a candidate). */
  pendingStart = 0;
  private runLen = 0;
  private runA = 0;
  private runAnd = 0;
  private runMin = 0;

  constructor(cfg: AnalogRunQualifierConfig) {
    this.rising = cfg.rising;
    this.level = cfg.level;
    this.arm = cfg.rising
      ? Math.max(0, cfg.level - cfg.hysteresis)
      : Math.min(255, cfg.level + cfg.hysteresis);
    this.window = cfg.window;
  }

  /** Forget the arm, any pending run and the predecessor (a gap or a restart). */
  reset(): void {
    this.armed = false;
    this.prev = -1;
    this.pending = ANALOG_RUN_NONE;
  }

  /** Resume with a given arm and predecessor code (-1: none), nothing pending. */
  enter(armed: boolean, prev: number): void {
    this.armed = armed;
    this.prev = prev;
    this.pending = ANALOG_RUN_NONE;
  }

  isFar(code: number): boolean {
    return this.rising ? code <= this.arm : code >= this.arm;
  }

  isPast(code: number): boolean {
    return this.rising ? code >= this.level : code <= this.level;
  }

  /**
   * One complete sample at absolute index `abs`. Returns T (the first sample of a real
   * candidate run, at most `window` samples before `abs`) when a crossing is decided on
   * this sample, otherwise -1.
   */
  step(code: number, abs: number): number {
    let fired = -1;
    const pending = this.pending;
    if (pending !== ANALOG_RUN_NONE) {
      const onSide = pending === ANALOG_RUN_ARM ? this.isFar(code) : this.isPast(code);
      if (onSide) {
        this.runLen++;
        this.runAnd &= code;
        if (code < this.runMin) this.runMin = code;
        if (this.runLen >= this.window || (code & this.runA) !== this.runA || code <= this.runA) {
          fired = this.decideReal();
        }
      } else if ((this.runAnd & code) === code && this.runMin > code) {
        // `code` is b: every code of the run carries b's bits and exceeds it (the `a`
        // half held on every sample), and the run ended within W: an OR artifact.
        this.pending = ANALOG_RUN_NONE;
      } else {
        fired = this.decideReal();
      }
    }
    if (this.pending === ANALOG_RUN_NONE) {
      const prev = this.prev;
      if (!this.armed) {
        if (this.isFar(code) && (prev < 0 || !this.isFar(prev))) {
          this.begin(ANALOG_RUN_ARM, code, abs, prev);
        }
      } else if (prev >= 0 && this.isPast(code) && !this.isPast(prev)) {
        const t = this.begin(ANALOG_RUN_CANDIDATE, code, abs, prev);
        if (t >= 0) fired = t;
      }
    }
    this.prev = code;
    return fired;
  }

  private begin(kind: number, code: number, abs: number, a: number): number {
    this.pending = kind;
    this.pendingStart = abs;
    this.runLen = 1;
    // No predecessor: judge the run against `b` only (an `a` of 0 makes the `a` half pass
    // for every code above 0).
    const before = a < 0 ? 0 : a;
    this.runA = before;
    this.runAnd = code;
    this.runMin = code;
    if (this.window <= 1 || (code & before) !== before || code <= before) return this.decideReal();
    return -1;
  }

  private decideReal(): number {
    const kind = this.pending;
    this.pending = ANALOG_RUN_NONE;
    if (kind === ANALOG_RUN_ARM) {
      this.armed = true;
      return -1;
    }
    this.armed = false;
    return this.pendingStart;
  }
}

/**
 * Reference rule over a flat code array (tests and fixtures): every T a continuous
 * stream from index 0 reports, with the streaming definitions above.
 */
export function qualifiedCrossings(
  codes: ArrayLike<number>, rising: boolean, level: number, hysteresis: number, window: number,
): number[] {
  const q = new AnalogRunQualifier({ rising, level, hysteresis, window });
  const far = (c: number): boolean => q.isFar(c);
  const past = (c: number): boolean => q.isPast(c);
  const artifact = (i: number, side: (c: number) => boolean): boolean => {
    let j = i;
    while (j < codes.length && side(codes[j]!) && j - i < window) j++;
    if (j - i >= window) return false;
    // Cut off by the end of the array before reaching W: undecided, so it neither arms nor
    // fires (a stream would still be waiting for its next sample).
    if (j >= codes.length) return true;
    // The first sample has no predecessor: judge it against `b` alone.
    const a = i === 0 ? 0 : codes[i - 1]!;
    const b = codes[j]!;
    for (let k = i; k < j; k++) {
      const g = codes[k]!;
      if ((g & a) !== a || (g & b) !== b || g <= Math.max(a, b)) return false;
    }
    return true;
  };
  const out: number[] = [];
  let armed = false;
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (!armed) {
      if (far(c) && (i === 0 || !far(codes[i - 1]!)) && !artifact(i, far)) armed = true;
      continue;
    }
    if (past(c) && !past(codes[i - 1]!) && !artifact(i, past)) {
      out.push(i);
      armed = false;
    }
  }
  return out;
}
