// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The shape of one ADC transition-glitch code (docs/ARCHITECTURE.md, trigger section,
 * "Analog crossings are qualified, never raw"). The ADC module's bus is sampled
 * asynchronously to its code transitions, so a transition x -> x+1 (or back) is read
 * for a few samples as the OR of the two codes, or that OR with bit 0 clear: 143 -> 144
 * reads 159, 127 -> 128 reads 255 or 254, 112 -> 111 reads 126, 96 -> 95 reads 127 or
 * 126. Measured on a 32U3 at 100 MS/s (2026-11-06 and 2026-11-09): of ~520 000 glitch
 * samples on a sine, a multitone and a signal parked on 127/128, every one was such a
 * code, and every one read above the codes around it. Every analog executor judges a
 * short run with this one predicate, so they cannot drift apart.
 */

/**
 * Whether code `g` inside a run is a transition glitch of its neighbours: `a` is the
 * sample before the run, `b` the one after it (a run with no predecessor passes `a = b`),
 * `h` the hysteresis in codes. True when `g` is more than `h` codes above both, and is
 * `x | (x + 1)` or that with bit 0 clear for an adjacent pair the signal may have crossed
 * during the run: min(a, b) - 2 <= x <= max(a, b) + 1 (the code under a glitch can sit
 * one beyond either neighbour: 129 -> [254 255] -> 129 hides 128 -> 127 -> 128).
 *
 * `x | (x + 1)`, where x ends in k one-bits, is the top code of the aligned block of
 * 2^(k+1) codes centred on the pair; so `g | 1` is tested as the top of each block it
 * ends.
 */
export function isAdcTransitionGlitch(g: number, a: number, b: number, h: number): boolean {
  const hi = a > b ? a : b;
  if (g - hi <= h) return false;
  const lo = a < b ? a : b;
  const top = g | 1;
  for (let bits = 1; bits <= 8; bits++) {
    const size = 1 << bits;
    if ((top & (size - 1)) !== size - 1) break;
    const x = (top & ~(size - 1)) + (size >> 1) - 1;
    if (x >= lo - 2 && x <= hi + 1) return true;
  }
  return false;
}

/** Whether every code of `run[start .. start + len)` is a transition glitch of `a` and
 * `b`; `a` < 0 (a run with no predecessor) judges against `b` alone. */
export function isAdcGlitchRun(
  run: ArrayLike<number>, start: number, len: number, a: number, b: number, h: number,
): boolean {
  const before = a < 0 ? b : a;
  for (let k = start; k < start + len; k++) {
    if (!isAdcTransitionGlitch(run[k]!, before, b, h)) return false;
  }
  return true;
}
