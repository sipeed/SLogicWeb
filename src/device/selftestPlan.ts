import { bytesPerSampleForChannels, type ChannelCount } from '../types.js';
import {
  MAX_SAMPLERATE_HZ,
  MAX_SAMPLERATE_HZ_SLOGIC32_U3,
  PID_SLOGIC32_U3,
  SUPPORTED_CHANNELS,
} from './protocol.js';
import { deriveStreamTuning } from './slogic16u3.js';

export type SelftestModel = 'slogic16u3' | 'slogic32u3';

export function modelForMaxChannels(maxChannels: number): SelftestModel {
  return maxChannels > 16 ? 'slogic32u3' : 'slogic16u3';
}

export function modelForProductId(productId: number): SelftestModel {
  return productId === PID_SLOGIC32_U3 ? 'slogic32u3' : 'slogic16u3';
}

export function deviceLabel(model: SelftestModel): string {
  return model === 'slogic32u3' ? 'SLogic32 U3' : 'SLogic16 U3';
}

export function throughputCeilings(model: SelftestModel): Readonly<Record<number, number>> {
  return model === 'slogic32u3' ? MAX_SAMPLERATE_HZ_SLOGIC32_U3 : MAX_SAMPLERATE_HZ;
}

export interface ThroughputRow {
  channels: ChannelCount;
  samplerate: number;
  note: string;
  assert: boolean;
}

export function throughputPlan(model: SelftestModel): ThroughputRow[] {
  if (model === 'slogic32u3') {
    return [
      { channels: 16, samplerate: 50e6, note: 'control', assert: false },
      { channels: 16, samplerate: 100e6, note: 'control', assert: false },
      { channels: 16, samplerate: 200e6, note: 'half its ceiling', assert: false },
      { channels: 8, samplerate: 400e6, note: 'half its ceiling', assert: false },
      { channels: 32, samplerate: 100e6, note: 'half its ceiling', assert: false },
      { channels: 32, samplerate: 200e6, note: 'AT ITS CEILING, 800 MB/s on the wire', assert: false },
      { channels: 4, samplerate: 400e6, note: '2x expansion', assert: false },
      { channels: 4, samplerate: 800e6, note: '2x expansion', assert: false },
    ];
  }
  return [
    { channels: 16, samplerate: 50e6, note: 'control', assert: false },
    { channels: 16, samplerate: 100e6, note: 'control', assert: false },
    { channels: 16, samplerate: 200e6, note: 'control, at its ceiling', assert: true },
    { channels: 8, samplerate: 200e6, note: 'half its ceiling', assert: false },
    { channels: 8, samplerate: 400e6, note: 'AT ITS CEILING', assert: true },
    { channels: 4, samplerate: 400e6, note: 'half its ceiling, 2x expansion', assert: false },
    { channels: 4, samplerate: 800e6, note: 'AT ITS CEILING, 2x expansion', assert: true },
  ];
}

export interface RefusalCase {
  channels: ChannelCount;
  samplerate: number;
  reason: string;
  label: string;
}

export function refusalCases(model: SelftestModel): RefusalCase[] {
  const cases: RefusalCase[] = model === 'slogic32u3'
    ? [
      { channels: 16, samplerate: 800e6, reason: 'ceiling', label: '800 MHz at 16 channels is refused' },
      { channels: 32, samplerate: 400e6, reason: 'ceiling', label: '400 MHz at 32 channels is refused' },
    ]
    : [
      { channels: 16, samplerate: 400e6, reason: 'ceiling', label: '400 MHz at 16 channels is refused' },
    ];
  cases.push({
    channels: 16,
    samplerate: 33e6,
    reason: 'unsupported samplerate',
    label: 'an off-table samplerate is refused',
  });
  return cases;
}

export function liveWidths(model: SelftestModel): ChannelCount[] {
  return model === 'slogic32u3' ? [16, 32] : [16];
}

export function emulationWidths(model: SelftestModel): ChannelCount[] {
  return model === 'slogic32u3' ? [16, 32] : [16, 8, 4];
}

export function emulationProbeWidths(model: SelftestModel): ChannelCount[] {
  return model === 'slogic32u3' ? [8, 4] : [];
}

export function emulationAnchor(model: SelftestModel): 'native' | 'shape' {
  return model === 'slogic32u3' ? 'shape' : 'native';
}

export function sawtoothOk(words: readonly number[], count: number): boolean {
  if (words.length < count) return false;
  for (let i = 1; i < count; i++) {
    const prev = words[i - 1];
    const cur = words[i];
    const want = prev % 8 === 0 ? prev + 15 : prev - 1;
    if (cur !== want) return false;
  }
  return true;
}

export interface StopScenario {
  kind: 'stop';
  channels: ChannelCount;
  ms: number;
  mhz: number;
  layer: 'page' | 'worker';
}

export interface FiniteScenario {
  kind: 'finite';
  channels: ChannelCount;
  ms: number;
  mhz: number;
  layer: 'page' | 'worker';
  mode: 'normal' | 'emulation';
}

export type CaptureScenario = StopScenario | FiniteScenario;
export type ScenarioRequest = { kind: 'full' } | CaptureScenario;

export interface ScenarioTiming {
  wireBytesPerSec: number;
  transferFillMs: number;
  minRunMs: number;
  reuseDeadlineMs: number;
}

export function scenarioTiming(channels: ChannelCount, mhz: number): ScenarioTiming {
  const wireBytesPerSec = (mhz * 1e6 * channels) / 8;
  const tuning = deriveStreamTuning({ channels, samplerate: mhz * 1e6, thresholdVolts: 1.6 });
  const transferFillMs = (tuning.transferBytes / wireBytesPerSec) * 1000;
  return {
    wireBytesPerSec,
    transferFillMs,
    minRunMs: Math.ceil(2 * transferFillMs),
    reuseDeadlineMs: Math.min(10000, Math.ceil(3 * transferFillMs + 500)),
  };
}

export function finiteSampleCount(ms: number, mhz: number): number {
  return Math.round((mhz * 1e6 * ms) / 1000);
}

export function finiteExpectedBytes(samples: number, channels: ChannelCount): number {
  return samples * bytesPerSampleForChannels(channels);
}

export function finiteEndBudgetMs(channels: ChannelCount, ms: number, mhz: number): number {
  const fillMs = scenarioTiming(channels, mhz).transferFillMs;
  return Math.ceil(ms + Math.max(5000, 4 * fillMs));
}

export function traceWindow(
  length: number, shifted: number, stopAbs: number, radius: number,
): [number, number] {
  const stopIndex = stopAbs - shifted;
  return [Math.max(0, stopIndex - radius), Math.min(length, Math.max(0, stopIndex + radius))];
}

export function parseScenario(search: string): ScenarioRequest {
  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (keys.length === 0) return { kind: 'full' };
  const allowed = new Set(['scenario', 'ms', 'mhz', 'layer', 'mode']);
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`unknown scenario parameter "${key}"`);
  }
  const scenario = params.get('scenario');
  if (scenario === null) throw new Error('scenario parameters require a "scenario" key');
  const match = /^(stop|finite)-(\d+)(?:ch)?$/.exec(scenario);
  if (!match) throw new Error(`unknown scenario "${scenario}"`);
  const kind = match[1] as 'stop' | 'finite';
  const parsed = Number(match[2]);
  if (!(SUPPORTED_CHANNELS as readonly number[]).includes(parsed)) {
    throw new Error(`unsupported channel count ${match[2]}`);
  }
  const channels = parsed as ChannelCount;
  const msRaw = params.get('ms');
  const ms = msRaw === null ? 1000 : Number(msRaw);
  if (!Number.isInteger(ms) || ms < 50 || ms > 10000) {
    throw new Error(`ms must be an integer in [50, 10000], got "${msRaw}"`);
  }
  const mhzRaw = params.get('mhz');
  const mhz = mhzRaw === null ? 16 : Number(mhzRaw);
  if (!Number.isFinite(mhz) || mhz <= 0) throw new Error(`mhz must be positive, got "${mhzRaw}"`);
  if (kind === 'stop') {
    if (params.has('mode')) throw new Error('unknown scenario parameter "mode"');
    const minRunMs = scenarioTiming(channels, mhz).minRunMs;
    if (ms < minRunMs) {
      throw new Error(`ms ${ms} is shorter than two transfer fills (${minRunMs} ms) at this geometry`);
    }
  } else {
    const samples = finiteSampleCount(ms, mhz);
    if (!Number.isSafeInteger(samples) || samples < 1) {
      throw new Error('finite scenarios must request at least one sample');
    }
    if (!Number.isInteger((samples * channels) / 8)) {
      throw new Error(
        `finite scenario requests ${samples} samples at ${channels}ch, which is not wire-aligned; ` +
        'choose timing with an even integer sample count at 4ch',
      );
    }
  }
  const layer = params.get('layer') ?? 'page';
  if (layer !== 'page' && layer !== 'worker') {
    throw new Error(`layer must be "page" or "worker", got "${layer}"`);
  }
  if (kind === 'stop') return { kind, channels, ms, mhz, layer };
  const mode = params.get('mode') ?? 'normal';
  if (mode !== 'normal' && mode !== 'emulation') {
    throw new Error(`mode must be "normal" or "emulation", got "${mode}"`);
  }
  return { kind, channels, ms, mhz, layer, mode };
}
