// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Integration selftest: SimDriver -> SignalStore.
 *
 * The driver and store were developed against the same position contract, but their
 * selftests used hand-built spans. This suite wires the real sink to a real store and
 * checks the three boundaries that matter:
 *
 *   - a triggered stream may start at T - preSamples > 0; the first append fixes the
 *     group origin and positions before it are gap, never pending;
 *   - a finite early match still delivers preSamples + postSamples in total;
 *   - a dropout reported before the bytes after it arrive is a pending gap; the store
 *     pads the skipped span and reports it as gap, and no byte is written over it.
 *
 * Deterministic: no timers, no wall clock; the driver is stepped by hand.
 */

import {
  SIM_CH0_PERIOD_SAMPLES,
  SimDriver,
  type SimGapSpan,
  type SimSink,
} from './simDriver.js';
import { SLOGIC16U3_PROFILE } from './profiles.js';
import { bytesPerSampleForChannels } from '../types.js';
import {
  COLUMN_GAP,
  COLUMN_OK,
  DigitalSignalStore,
  type SamplePos,
} from '../data/signalStore.js';
import type { DigitalTriggerInput } from '../dsp/triggerPlan.js';
import { compileTriggerPlan } from '../dsp/triggerPlan.js';

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

/** A sink that assembles byte fragments and appends complete samples to the store. */
class StoreSink implements SimSink {
  readonly store: DigitalSignalStore;
  readonly written: { start: SamplePos; end: SamplePos }[] = [];
  readonly gaps: SimGapSpan[] = [];
  private tail: Uint8Array | null = null;
  private tailStart = 0;
  private readonly bytesPerSample: number;

  constructor(channels: 4 | 8 | 16 | 32 | 64 | 128, rateHz: number) {
    this.bytesPerSample = bytesPerSampleForChannels(channels);
    this.store = new DigitalSignalStore({
      groups: [{ id: GROUP, channels, rateHz, maxSamples: 1_000_000 }],
    });
  }

  write(chunk: Uint8Array, startByte: number): void {
    let data = chunk;
    let byteStart = startByte;
    if (this.tail !== null) {
      if (startByte !== this.tailStart + this.tail.length) {
        throw new Error(
          `fragment continuation expected at byte ${this.tailStart + this.tail.length}, ` +
            `got ${startByte}`,
        );
      }
      const merged = new Uint8Array(this.tail.length + chunk.length);
      merged.set(this.tail, 0);
      merged.set(chunk, this.tail.length);
      data = merged;
      byteStart = this.tailStart;
      this.tail = null;
    }
    if (byteStart % this.bytesPerSample !== 0) {
      throw new Error(`write starts mid-sample at byte ${byteStart}`);
    }
    const whole = data.length - (data.length % this.bytesPerSample);
    if (whole > 0) {
      const position = byteStart / this.bytesPerSample;
      const samples = whole / this.bytesPerSample;
      this.store.append(GROUP, data.subarray(0, whole), position);
      this.written.push({ start: position, end: position + samples });
    }
    if (whole < data.length) {
      this.tail = data.slice(whole);
      this.tailStart = byteStart + whole;
    }
  }

  noteGap(gap: SimGapSpan): void {
    this.gaps.push(gap);
    this.store.noteGap(gap);
  }
}

function planFor(
  conditions: readonly DigitalTriggerInput[],
  channels: 4 | 8 | 16 | 32 | 64 | 128,
  samplerate: number,
  preTriggerPercent: number,
  postSamples: number,
) {
  const result = compileTriggerPlan({
    profile: SLOGIC16U3_PROFILE,
    enableMask: true,
    source: 'digital',
    digital: conditions,
    analog: [],
    preTriggerPercent,
    postTrigger: { kind: 'samples', value: postSamples },
    capture: { samplerate, channels },
    compiledAt: 0,
  });
  if (!result.ok) throw new Error(`plan refused: ${result.reason}: ${result.detail}`);
  return result.plan;
}

function statusAt(sink: StoreSink, position: number): number {
  return sink.store.query('d0', position, position + 1, 1).status[0]!;
}

async function startAndStep(
  driver: SimDriver,
  sink: StoreSink,
  plan: ReturnType<typeof planFor>,
  samples: number,
): Promise<void> {
  await driver.start(
    { channels: 8, samplerate: 5e6 },
    sink,
    { trigger: plan },
  );
  // A match ends the waiting call after the pre-trigger flush; the post budget needs
  // further stepped calls. Drive to completion, with a hard guard so a regression hangs
  // the test as a failure instead of looping forever.
  for (let i = 0; i < 128 && !driver.complete && driver.state !== 'stopped'; i++) {
    await driver.step(samples);
  }
}

async function main(): Promise<void> {
  // 1. T > preSamples: the emitted stream starts at T - preSamples, which becomes the
  // group origin; total delivered is pre + post and T is in that same absolute space.
  {
    const pre = 0;
    const post = 8;
    const plan = planFor([{ signal: 'd0', kind: 'rising' }], 8, 5e6, pre, post);
    const sink = new StoreSink(8, 5e6);
    const driver = new SimDriver(SLOGIC16U3_PROFILE);
    await startAndStep(driver, sink, plan, 64);

    const t = driver.triggeredAt;
    const first = driver.firstSample;
    const expectedT = SIM_CH0_PERIOD_SAMPLES === 4 ? 2 : null;
    check('origin case: trigger matched', t === expectedT, `T=${String(t)}`);
    check('origin case: first emitted sample is T - preSamples',
      first === (t ?? 0) - pre, `first=${String(first)}`);
    check('origin case: store origin equals the first emitted sample',
      sink.store.origin === first, `origin=${sink.store.origin}, first=${String(first)}`);
    check('origin case: total delivered is pre + post',
      sink.store.newest[GROUP] === (first ?? 0) + pre + post,
      `newest=${sink.store.newest[GROUP]}, expected=${(first ?? 0) + pre + post}`);
    check('origin case: T is known data', statusAt(sink, t ?? 0) === COLUMN_OK);
    check('origin case: pre-origin position is gap, not pending',
      statusAt(sink, 0) === COLUMN_GAP);
  }

  // 2. Early match (T < preSamples): the post span extends so the total stays pre+post.
  {
    const prePercent = 75;
    const post = 8;
    const plan = planFor([{ signal: 'd0', kind: 'rising' }], 8, 5e6, prePercent, post);
    const pre = plan.preTrigger.samples!;
    const sink = new StoreSink(8, 5e6);
    const driver = new SimDriver(SLOGIC16U3_PROFILE);
    await startAndStep(driver, sink, plan, 64);

    const t = driver.triggeredAt;
    const first = driver.firstSample;
    check('early match: T is before the pre-trigger window', t !== null && t < pre,
      `T=${String(t)}, pre=${pre}`);
    check('early match: stream starts at 0', first === 0, `first=${String(first)}`);
    check('early match: total delivered is pre + post',
      sink.store.newest[GROUP] === pre + post,
      `newest=${sink.store.newest[GROUP]}, expected=${pre + post}`);
  }

  // 3. Waiting dropout: fill-before-arm moves T past the lost span, so the emitted
  // stream never covers the gap; the store sees a stream whose origin is after it.
  {
    const pre = 6;
    const post = 8;
    const plan = planFor([{ signal: 'd0', kind: 'rising' }], 8, 5e6, 75, post);
    const sink = new StoreSink(8, 5e6);
    const driver = new SimDriver(SLOGIC16U3_PROFILE, {
      faults: [{ kind: 'dropout', atSample: 0, count: 5 }],
    });
    await startAndStep(driver, sink, plan, 128);

    const t = driver.triggeredAt;
    const first = driver.firstSample;
    check('waiting dropout: T is armed after the gap and its pre-window',
      t !== null && t - pre >= 5, `T=${String(t)}, pre=${pre}`);
    check('waiting dropout: no gap is reported before the stream origin',
      sink.gaps.length === 0, JSON.stringify(sink.gaps));
    check('waiting dropout: store origin is after the lost span',
      (first ?? 0) >= 5, `first=${String(first)}`);
    check('waiting dropout: total delivered is pre + post',
      sink.store.newest[GROUP] === (first ?? 0) + pre + post,
      `newest=${sink.store.newest[GROUP]}, expected=${(first ?? 0) + pre + post}`);
  }

  // 4. Running dropout: the gap is reported before the bytes after it, the store pads
  // the skipped span, and no written range overlaps the gap.
  {
    const post = 200;
    const plan = planFor([{ signal: 'd0', kind: 'rising' }], 8, 5e6, 0, post);
    const sink = new StoreSink(8, 5e6);
    const driver = new SimDriver(SLOGIC16U3_PROFILE, {
      faults: [{ kind: 'dropout', atSample: 50, count: 5 }],
    });
    await startAndStep(driver, sink, plan, 4096);

    const t = driver.triggeredAt;
    const gap = sink.store.gaps().find((span) => span.reason === 'dropout');
    check('running dropout: gap is retained', gap !== undefined, JSON.stringify(sink.store.gaps()));
    check('running dropout: gap position is [50,55)',
      gap?.start === 50 && gap?.end === 55,
      `gap=${JSON.stringify(gap)}`);
    check('running dropout: gap status is GAP', statusAt(sink, 52) === COLUMN_GAP);
    check('running dropout: sample before the gap is known',
      statusAt(sink, 49) === COLUMN_OK);
    check('running dropout: sample after the gap is known',
      statusAt(sink, 55) === COLUMN_OK);
    check('running dropout: T is known data', statusAt(sink, t ?? 0) === COLUMN_OK);
    check('running dropout: no write overlaps the gap',
      sink.written.every((range) => range.end <= 50 || range.start >= 55),
      JSON.stringify(sink.written.filter((range) => range.end > 50 && range.start < 55)));
    check('running dropout: store advanced past the gap',
      sink.store.newest[GROUP] === (driver.firstSample ?? 0) + (plan.preTrigger.samples ?? 0) + post,
      `newest=${sink.store.newest[GROUP]}, first=${String(driver.firstSample)}`);
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} simDriver→SignalStore integration: ` +
    `${passed} passed, ${failed} failed`);
  if (failed !== 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc !== undefined) proc.exitCode = 1;
  }
}

void main();
