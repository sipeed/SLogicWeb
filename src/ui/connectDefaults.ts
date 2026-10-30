export const CONNECT_SAMPLERATE_32CH_HZ = 100e6;

export interface ConnectRateInput {
  current: number;
  explicit: boolean;
  channels: number;
  ceilings: Readonly<Record<number, number>>;
}

export function connectSamplerate(input: ConnectRateInput): number {
  if (input.channels !== 32) return input.current;
  const ceiling = input.ceilings[input.channels] ?? CONNECT_SAMPLERATE_32CH_HZ;
  if (!input.explicit) return Math.min(CONNECT_SAMPLERATE_32CH_HZ, ceiling);
  return Math.min(input.current, CONNECT_SAMPLERATE_32CH_HZ, ceiling);
}
