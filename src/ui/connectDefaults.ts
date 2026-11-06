export interface ConnectRateInput {
  current: number;
  explicit: boolean;
  channels: number;
  ceilings: Readonly<Record<number, number>>;
  recommended: Readonly<Record<number, number>>;
}

export function connectSamplerate(input: ConnectRateInput): number {
  const recommended = input.recommended[input.channels];
  if (recommended === undefined) return input.current;
  const ceiling = input.ceilings[input.channels] ?? recommended;
  if (!input.explicit) return Math.min(recommended, ceiling);
  return Math.min(input.current, ceiling);
}
