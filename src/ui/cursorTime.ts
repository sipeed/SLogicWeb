const UNITS = [
  { scale: 1, unit: 's' },
  { scale: 1e-3, unit: 'ms' },
  { scale: 1e-6, unit: 'us' },
  { scale: 1e-9, unit: 'ns' },
  { scale: 1e-12, unit: 'ps' },
] as const;

const BASELINE_SIG = 4;
const MAX_DECIMALS = 9;

export interface CursorTime {
  sample: number;
  seconds: number;
}

interface Entry {
  sample: number;
  seconds: number;
  scale: number;
  unit: string;
  cap: number;
  sig: number;
  limit: number;
}

function unitFor(seconds: number): { scale: number; unit: string } {
  const magnitude = Math.abs(seconds);
  return UNITS.find((entry) => magnitude >= entry.scale) ?? UNITS[UNITS.length - 1]!;
}

function decimalsCap(period: number, scale: number): number {
  return Math.min(MAX_DECIMALS, Math.max(0, Math.ceil(-Math.log10(period / scale))));
}

function render(entry: Entry): string {
  if (!Number.isFinite(entry.seconds)) return '-';
  if (entry.seconds === 0) return '0 s';
  const value = entry.seconds / entry.scale;
  const digits = Math.max(0, entry.sig - 1 - Math.floor(Math.log10(Math.abs(value))));
  return `${value.toFixed(Math.min(digits, entry.cap))} ${entry.unit}`;
}

export function formatCursorTimes(times: readonly CursorTime[], samplePeriod: number): string[] {
  const period = Number.isFinite(samplePeriod) && samplePeriod > 0
    ? samplePeriod
    : Number.MIN_VALUE;
  const entries: Entry[] = times.map((time) => {
    const { scale, unit } = unitFor(time.seconds);
    const cap = decimalsCap(period, scale);
    const measurable = Number.isFinite(time.seconds) && time.seconds !== 0;
    const magnitude = measurable ? Math.floor(Math.log10(Math.abs(time.seconds / scale))) : 0;
    return {
      sample: time.sample,
      seconds: time.seconds,
      scale,
      unit,
      cap,
      sig: BASELINE_SIG,
      limit: measurable ? Math.max(BASELINE_SIG, magnitude + 1 + cap) : BASELINE_SIG,
    };
  });

  for (;;) {
    const texts = entries.map(render);
    const colliding = new Set<number>();
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (entries[i]!.sample === entries[j]!.sample) continue;
        if (texts[i] !== texts[j]) continue;
        colliding.add(i);
        colliding.add(j);
      }
    }
    if (colliding.size === 0) return texts;
    let raised = false;
    for (const index of colliding) {
      const entry = entries[index]!;
      if (entry.sig >= entry.limit) continue;
      entry.sig += 1;
      raised = true;
    }
    if (!raised) return texts;
  }
}
