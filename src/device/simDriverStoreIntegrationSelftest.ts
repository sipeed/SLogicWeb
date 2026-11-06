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
import { SLOGIC16U3_PROFILE, SLOGIC32U3_PROFILE } from './profiles.js';
import { analogVoltsFromCode } from '../ui/channelBanks.js';
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

  // 2. Pre-fill holdoff: the rising edges at 2 and 4k+2 < pre are held off; the edge
  // exactly at the holdoff boundary (T == pre == 6) is the trigger, with the full prefix.
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
    check('holdoff: T lands exactly at the pre-trigger boundary', t !== null && t === pre && pre === 6,
      `T=${String(t)}, pre=${pre}`);
    check('holdoff: stream starts at 0 with the full prefix', first === 0, `first=${String(first)}`);
    check('holdoff: total delivered is pre + post',
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

  // 5. Qualified analog crossing on the 32U3's ADC bank: a carry-boundary artifact
  // (111 -> 112 reads 127) before the genuine crossing is not T; T is the first sample
  // of the persistent run, the stream starts exactly pre samples before it, and the
  // stored inputs read back the code MSB-first.
  {
    const rate = 100e6;
    const level = 120;
    // 0..199: 111; 200..209: the 111|112 artifact; 210..299: 112; 300..: 140.
    const code = (n: number): number => n < 200 ? 111 : n < 210 ? 127 : n < 300 ? 112 : 140;
    const compiled = compileTriggerPlan({
      profile: SLOGIC32U3_PROFILE,
      enableMask: true,
      source: 'analog',
      digital: [],
      analog: [{ signal: 'a0', kind: 'rising', volts: analogVoltsFromCode(level) }],
      preTriggerPercent: 50,
      postTrigger: { kind: 'samples', value: 64 },
      capture: { samplerate: rate, channels: 8 },
      compiledAt: 0,
    });
    if (!compiled.ok) throw new Error(`analog plan refused: ${compiled.reason}`);
    const plan = compiled.plan;
    const pre = plan.preTrigger.samples!;
    const sink = new StoreSink(8, rate);
    const driver = new SimDriver(SLOGIC32U3_PROFILE, {
      transferBytes: 24, analog: { start: 0, code },
    });
    await driver.start({ channels: 8, samplerate: rate }, sink, { trigger: plan });
    for (let i = 0; i < 1024 && !driver.complete && driver.state !== 'stopped'; i++) {
      await driver.step(13);
    }
    const t = driver.triggeredAt;
    check('analog: the artifact is not T; the persistent crossing is', t === 300,
      `T=${String(t)}`);
    check('analog: the stream starts exactly pre samples before T',
      driver.firstSample === 300 - pre && sink.store.origin === 300 - pre,
      `first=${String(driver.firstSample)} origin=${sink.store.origin} pre=${pre}`);
    check('analog: total delivered is pre + post',
      sink.store.newest[GROUP] === 300 - pre + pre + 64,
      `newest=${sink.store.newest[GROUP]}`);
    const readCode = (position: number): number => {
      let value = 0;
      for (let input = 0; input < 8; input++) {
        value |= (sink.store.sample(`d${input}`, position) ?? 0) << (7 - input);
      }
      return value;
    };
    check('analog: the stored inputs read the code MSB-first at T and before it',
      readCode(300) === 140 && readCode(299) === 112,
      `T=${readCode(300)} T-1=${readCode(299)}`);
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} simDriver→SignalStore integration: ` +
    `${passed} passed, ${failed} failed`);
  if (failed !== 0) {
    const proc = (globalThis as { process?: { exitCode?: number } }).process;
    if (proc !== undefined) proc.exitCode = 1;
  }
}

void main();
