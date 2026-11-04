// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Loop software-trigger retention, simulated against the real planning helpers.
 *
 * Two invariants this file exists to pin:
 *
 *   - A lock with no page-side analog roll (a digital one-shot, or any lock without a
 *     scanner) must drop the store front normally and release when T is evicted. The
 *     analog local-roll clamp (never drop past the window start) is only valid when a
 *     scanner can advance T; applying it to a one-shot lock pins the front forever.
 *   - An analog lock's post-enforce length is bounded: the local step consumes the
 *     waiting new data up to `fresh - slack`, the quiet-window release bounds how long
 *     an unconsumed tail can wait, and the 64-sample drop quantum keeps T inside the
 *     store. No interaction may evict T during a roll.
 *
 * The App is not instantiated (it owns the DOM); the retention arithmetic below mirrors
 * `enforceLoopRetention`/`rollLoopWindow`/`dropLoopFront` line for line, using the real
 * `planLoopSwap`, `planLocalTriggerStep`, `triggerSlackSamples`, `loopStoreLimit` and
 * `loopDropSamples`. A source-wiring check in trigger-viewport-selftest.ts keeps the
 * mirror honest.
 */

import { planLoopSwap } from '../displaySwap.js';
import { loopDropSamples } from '../state.js';
import {
  loopStoreLimit, planLocalTriggerStep, triggerSlackSamples,
} from '../triggerViewport.js';
import { DROP_FRONT_QUANTUM } from '../../data/types.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const SAMPLERATE = 100e6;
const CHANNELS = 16 as const;
const BYTES_PER_SAMPLE = 2;
const SLACK = (D: number): number =>
  triggerSlackSamples(D, SAMPLERATE, BYTES_PER_SAMPLE);

interface SimInput {
  D: number;
  fraction: number;
  chunk: number;
  chunks: number;
  scanner: boolean;
  /** Crossing spacing in samples; null means the signal never crosses again. */
  period: number | null;
  /** Keep the scanner-gated clamp (fixed) or force the old unconditional clamp. */
  gateSafeDrop: boolean;
  /** Resume crossings after this many quiet chunks (for release/re-lock). */
  resumeAfter?: number;
  /** Simulate the App's pre-append hard cap (samples); disarms instead of overflowing. */
  hardCap?: number;
}

interface SimResult {
  finalLength: number;
  maxLength: number;
  releasedAt: number | null;
  relockedAt: number | null;
  evictedOnRoll: number;
  hardCapDisarmed: boolean;
}

function simulate(input: SimInput): SimResult {
  const D = input.D;
  const f = input.fraction;
  const slack = SLACK(D);
  const gap = Math.max(1, Math.floor(D / 64));
  let front = 0;
  let length = 0;
  let T: number | null = Math.max(0, Math.min(D - 1, Math.floor(f * D)));
  let lock = true;
  let pending: number | null = null;
  let scannerOn = input.scanner;
  const crossingList: number[] = [];
  let lastCrossing = T;
  let lastReported = Number.NEGATIVE_INFINITY;
  let maxLength = 0;
  let releasedAt: number | null = null;
  let relockedAt: number | null = null;
  let evictedOnRoll = 0;
  let hardCapDisarmed = false;

  // The device's pre-trigger ring places T inside the store before streaming starts.
  length = Math.min(D, T + 1024);

  const release = (): void => {
    if (!lock) return;
    lock = false;
    T = null;
    pending = null;
    if (releasedAt === null) releasedAt = -1;
  };

  const dropFront = (drop: number): void => {
    front += drop;
    length -= drop;
    if (T !== null) {
      const next = T - drop;
      T = next >= 0 && next < length ? next : null;
    }
    if (T === null && lock) release();
  };

  const scan = (base: number, size: number, index: number): void => {
    if (!scannerOn || input.period === null) return;
    // A fixture may keep the signal quiet for a while, then resume it, to exercise the
    // quiet-window release followed by an automatic re-lock.
    if (input.resumeAfter !== undefined && index < input.resumeAfter) return;
    let c = Math.ceil(base / input.period) * input.period;
    if (c <= base) c += input.period;
    while (c < base + size) {
      if (c > lastReported + gap) {
        crossingList.push(c);
        if (crossingList.length > 128) crossingList.shift();
        lastCrossing = c;
        lastReported = c;
        if (!lock && !pending) pending = c;
      }
      c += input.period;
    }
  };

  const enforce = (): void => {
    // Re-lock on an edge seen while the view was free.
    if (!lock && pending !== null) {
      const rel = pending - front;
      if (rel >= 0 && rel < length) {
        T = rel;
        lock = true;
        lastCrossing = Math.max(lastCrossing, pending);
        if (releasedAt !== null && relockedAt === null) relockedAt = rel;
      }
      pending = null;
    }
    const liveAbs = front + length;
    if (lock && scannerOn && T !== null) {
      const triggerAbs = front + T;
      const fresh = liveAbs - (triggerAbs + (1 - f) * D);
      if (fresh > 0) {
        const plan = planLoopSwap({
          samplerate: SAMPLERATE,
          channels: CHANNELS,
          availableSamples: fresh,
          windowSamples: D,
          maxWindowFraction: 0.25,
          ...(input.period !== null ? { periodSamples: input.period } : {}),
        });
        let budget = Math.max(plan.blockSamples, fresh - slack);
        if (budget > 0) {
          const next = crossingList.find((c) => c > triggerAbs);
          if (next !== undefined) {
            budget = Math.max(budget, Math.min(fresh, next - triggerAbs));
          }
          budget = Math.min(budget, fresh);
          const step = planLocalTriggerStep({
            triggerAbs,
            frontAbs: front,
            liveAbs,
            windowSamples: D,
            fraction: f,
            blockSamples: budget,
            crossings: crossingList,
            viewOffsetStart: 0,
            viewOffsetEnd: D,
          });
          if (step) {
            T = step.anchorAbs - front;
            if (step.drop > 0) dropFront(step.drop);
            T = step.triggerSample;
            if (T === null || T < 0 || T >= length) evictedOnRoll++;
            while (crossingList.length > 0 && crossingList[0]! <= step.anchorAbs) {
              crossingList.shift();
            }
          }
        }
      }
      const afterRoll = front + length;
      if (lock && afterRoll - lastCrossing > D) release();
    }
    const limit = loopStoreLimit(
      D,
      (lock || pending !== null) && scannerOn,
      slack,
    );
    let drop = loopDropSamples(length, limit);
    // The fixed code gates the clamp on the scanner; the old code applied it always.
    if (drop > 0 && lock && T !== null && (input.gateSafeDrop ? scannerOn : true)) {
      const windowStart = T - f * D;
      const beforeWindow = Math.floor(Math.max(0, windowStart) / DROP_FRONT_QUANTUM) *
        DROP_FRONT_QUANTUM;
      drop = Math.min(drop, beforeWindow);
    }
    if (drop > 0) dropFront(drop);
    if (T === null && lock) release();
    // Only the post-enforce length matters for the retention bound; an append may carry
    // one delivery chunk before this function runs.
    maxLength = Math.max(maxLength, length);
  };

  for (let i = 0; i < input.chunks; i++) {
    scan(front + length, input.chunk, i);
    // The App checks the hard cap before append and disarms in place, then trims to D.
    if (input.hardCap !== undefined && length + input.chunk > input.hardCap) {
      lock = false;
      scannerOn = false;
      T = null;
      pending = null;
      hardCapDisarmed = true;
      const trim = loopDropSamples(length, D);
      if (trim > 0) dropFront(trim);
    }
    length += input.chunk;
    enforce();
  }
  return {
    finalLength: length,
    maxLength,
    releasedAt,
    relockedAt,
    evictedOnRoll,
    hardCapDisarmed,
  };
}

// ---------------------------------------------------------------------------
// Digital (no page-side roll): the clamp must be gated, or the store never drops.
// ---------------------------------------------------------------------------
{
  let fixedOk = true;
  let oldGrows = true;
  const details: string[] = [];
  for (const D of [1_024, 200_704]) {
    for (const f of [0, 0.1, 0.5, 1]) {
      for (const chunk of [16, 4_096, 2_097_152]) {
        // Fill the window and then let the front advance past T: small chunks need many
        // appends because the store drops on a 64-sample quantum.
        const chunks = Math.max(40, Math.ceil(D / chunk) + Math.ceil(D / 64) + 2);
        const fixed = simulate({
          D, fraction: f, chunk, chunks, scanner: false, period: null,
          gateSafeDrop: true,
        });
        const old = simulate({
          D, fraction: f, chunk, chunks, scanner: false, period: null,
          gateSafeDrop: false,
        });
        const fixedBounded = fixed.finalLength <= D + 63 && fixed.maxLength <= D + 63 &&
          fixed.releasedAt !== null && fixed.evictedOnRoll === 0;
        if (!fixedBounded) {
          fixedOk = false;
          details.push(`D=${D} f=${f} chunk=${chunk}: fixed len=${fixed.finalLength} max=${fixed.maxLength}`);
        }
        // The old unconditional clamp pins the front once T is a <64 residue: every
        // appended chunk is retained forever.
        const initial = Math.min(D, Math.floor(f * D) + 1024);
        const oldExpected = old.finalLength >= initial + chunks * chunk - 63;
        if (!oldExpected) {
          oldGrows = false;
          details.push(`D=${D} f=${f} chunk=${chunk}: old len=${old.finalLength} ` +
            `expected >=${initial + chunks * chunk}`);
        }
      }
    }
  }
  check('a no-scanner (digital) lock drops normally, releases, and stays bounded',
    fixedOk, fixedOk ? 'all digital fixtures bounded' : details.slice(0, 2).join('; '));
  check('the unconditional clamp reproduces the unbounded-growth regression',
    oldGrows, oldGrows ? 'old behavior grows in every fixture' : details.slice(0, 2).join('; '));
}

// ---------------------------------------------------------------------------
// Analog roll: dense, slow and quiet signals. T must never be evicted by a roll.
// ---------------------------------------------------------------------------
{
  let analogOk = true;
  let detail = '';
  for (const D of [1_024, 200_704]) {
    const slack = SLACK(D);
    const gap = Math.max(1, Math.floor(D / 64));
    for (const f of [0, 0.5, 0.75]) {
      for (const period of [64, Math.floor(D / 8), Math.floor(D / 2), 2 * D, null]) {
        const sim = simulate({
          D, fraction: f, chunk: 65_536, chunks: 200, scanner: true,
          period, gateSafeDrop: true,
        });
        // Post-enforce bound: the window, the carried slack, and the larger of one
        // crossing gap and the quiet-window tail (f*D); the 64-sample quantum covers the
        // front residue. No term grows with the number of chunks.
        const bound = D + slack + Math.max(f * D, period ?? 0, gap) + 64;
        if (sim.evictedOnRoll !== 0 || sim.maxLength > bound) {
          analogOk = false;
          detail = `D=${D} f=${f} P=${period}: max=${sim.maxLength} bound=${bound} ` +
            `evicted=${sim.evictedOnRoll}`;
          break;
        }
        if (period === null && sim.releasedAt === null) {
          analogOk = false;
          detail = `D=${D} f=${f} quiet never released`;
          break;
        }
      }
      if (!analogOk) break;
    }
    if (!analogOk) break;
  }
  check('an analog roll stays bounded and never evicts T during a step',
    analogOk, analogOk ? 'all analog fixtures within bound' : detail);
}

// ---------------------------------------------------------------------------
// Quiet-window release then automatic re-lock, and the initial baseline.
// ---------------------------------------------------------------------------
{
  const D = 1_024;
  // Quiet for the first 40 chunks, then the signal returns. The lock must release and
  // then re-lock on the returning edge, without a roll ever evicting T.
  const quietThenLive = simulate({
    D, fraction: 0.1, chunk: 65_536, chunks: 160, scanner: true,
    period: 64, gateSafeDrop: true, resumeAfter: 40,
  });
  check('a quiet window releases the lock and a returning edge re-locks it',
    quietThenLive.releasedAt !== null && quietThenLive.relockedAt !== null &&
    quietThenLive.evictedOnRoll === 0,
    `released=${quietThenLive.releasedAt}, relocked=${quietThenLive.relockedAt}, ` +
    `max=${quietThenLive.maxLength}, final=${quietThenLive.finalLength}`);

  // The app records the latest scanned crossing, not T, as the quiet baseline. A crossing
  // already seen after T must delay the release by roughly its distance past T.
  const T = 102;
  const scannedAfterT = T + 420;
  const ageWithT = T + D - T;
  const ageWithMax = T + D - scannedAfterT;
  check('the initial quiet baseline keeps crossings scanned after T',
    ageWithMax < ageWithT && ageWithMax === D - (scannedAfterT - T),
    `withT=${ageWithT}, withMax=${ageWithMax}`);
}

// ---------------------------------------------------------------------------
// The hard cap must disarm before the append ceiling and leave the store at D.
// ---------------------------------------------------------------------------
{
  const D = 200_704;
  const capped = simulate({
    D, fraction: 0.75, chunk: 65_536, chunks: 200, scanner: true,
    period: Math.floor(D * 0.98), gateSafeDrop: true, hardCap: D + 100_000,
  });
  check('the hard cap disarms before the append ceiling and trims to D',
    capped.hardCapDisarmed && capped.finalLength <= D + 64 && capped.evictedOnRoll === 0,
    `disarmed=${capped.hardCapDisarmed}, final=${capped.finalLength}, max=${capped.maxLength}`);
}

// ---------------------------------------------------------------------------
// Slack sanity across the supported width/rate matrix.
// ---------------------------------------------------------------------------
{
  let slackOk = true;
  for (const D of [1_024, 200_704, 2 ** 30]) {
    for (const rate of [100e6, 200e6, 400e6, 800e6, 1.2e9, 1.4e9]) {
      for (const channels of [4, 8, 16, 32, 64, 128] as const) {
        const bps = channels <= 8 ? 1 : channels === 16 ? 2 : channels === 32 ? 4 : channels === 64 ? 8 : 16;
        const slack = triggerSlackSamples(D, rate, bps);
        if (!(slack >= 0 && slack <= D) || loopStoreLimit(D, false, slack) !== D) slackOk = false;
      }
    }
  }
  check('slack never exceeds the window and never raises the unlocked limit',
    slackOk, `slackOk=${slackOk}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
