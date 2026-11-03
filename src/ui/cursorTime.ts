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

interface Span {
  seconds: number;
  scale: number;
  unit: string;
  cap: number;
  sig: number;
}

interface Entry extends Span {
  sample: number;
  limit: number;
}

function unitFor(seconds: number): { scale: number; unit: string } {
  const magnitude = Math.abs(seconds);
  return UNITS.find((entry) => magnitude >= entry.scale) ?? UNITS[UNITS.length - 1]!;
}

function decimalsCap(period: number, scale: number): number {
  return Math.min(MAX_DECIMALS, Math.max(0, Math.ceil(-Math.log10(period / scale))));
}

function normalizePeriod(samplePeriod: number): number {
  return Number.isFinite(samplePeriod) && samplePeriod > 0 ? samplePeriod : Number.MIN_VALUE;
}

function spanOf(seconds: number, period: number): Span {
  const { scale, unit } = unitFor(seconds);
  return { seconds, scale, unit, cap: decimalsCap(period, scale), sig: BASELINE_SIG };
}

function render(span: Span): string {
  if (!Number.isFinite(span.seconds)) return '-';
  if (span.seconds === 0) return '0 s';
  const value = span.seconds / span.scale;
  const digits = Math.max(0, span.sig - 1 - Math.floor(Math.log10(Math.abs(value))));
  return `${value.toFixed(Math.min(digits, span.cap))} ${span.unit}`;
}

export function formatCursorSpan(seconds: number, samplePeriod: number): string {
  const text = render(spanOf(seconds, normalizePeriod(samplePeriod)));
  return Number.isFinite(seconds) && seconds > 0 ? `+${text}` : text;
}

export function formatCursorTimes(times: readonly CursorTime[], samplePeriod: number): string[] {
  const period = normalizePeriod(samplePeriod);
  const entries: Entry[] = times.map((time) => {
    const span = spanOf(time.seconds, period);
    const measurable = Number.isFinite(time.seconds) && time.seconds !== 0;
    const magnitude = measurable ? Math.floor(Math.log10(Math.abs(time.seconds / span.scale))) : 0;
    return {
      ...span,
      sample: time.sample,
      limit: measurable ? Math.max(BASELINE_SIG, magnitude + 1 + span.cap) : BASELINE_SIG,
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
