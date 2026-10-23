import type { ChannelCount } from '../types.js';
import {
  MAX_SAMPLERATE_HZ,
  MAX_SAMPLERATE_HZ_SLOGIC32_U3,
  SUPPORTED_CHANNELS,
} from './protocol.js';

export type SelftestModel = 'slogic16u3' | 'slogic32u3';

export function modelForMaxChannels(maxChannels: number): SelftestModel {
  return maxChannels > 16 ? 'slogic32u3' : 'slogic16u3';
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
      { channels: 32, samplerate: 100e6, note: 'half its ceiling', assert: true },
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
  return model === 'slogic32u3' ? [16, 8, 4, 32] : [16, 8, 4];
}

export function emulationAnchor(model: SelftestModel): 'native' | 'counter' {
  return model === 'slogic32u3' ? 'counter' : 'native';
}

export interface StopScenario {
  kind: 'stop';
  channels: ChannelCount;
  ms: number;
  mhz: number;
  layer: 'page';
}

export type ScenarioRequest = { kind: 'full' } | StopScenario;

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
  const allowed = new Set(['scenario', 'ms', 'mhz', 'layer']);
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`unknown scenario parameter "${key}"`);
  }
  const scenario = params.get('scenario');
  if (scenario === null) throw new Error('scenario parameters require a "scenario" key');
  const match = /^stop-(\d+)(?:ch)?$/.exec(scenario);
  if (!match) throw new Error(`unknown scenario "${scenario}"`);
  const parsed = Number(match[1]);
  if (!(SUPPORTED_CHANNELS as readonly number[]).includes(parsed)) {
    throw new Error(`unsupported channel count ${match[1]}`);
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
  const layer = params.get('layer') ?? 'page';
  if (layer !== 'page') throw new Error(`layer "${layer}" is not available in this build`);
  return { kind: 'stop', channels, ms, mhz, layer: 'page' };
}
