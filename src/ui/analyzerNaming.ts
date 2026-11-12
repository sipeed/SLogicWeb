export const MAX_ANALYZER_LABEL_LENGTH = 64;

export interface AnalyzerOrdinal {
  readonly decoderId: string;
  readonly ordinal: number;
}

function usedOrdinals(analyzers: readonly AnalyzerOrdinal[], decoderId: string): Set<number> {
  const used = new Set<number>();
  for (const analyzer of analyzers) {
    if (analyzer.decoderId === decoderId) used.add(analyzer.ordinal);
  }
  return used;
}

export function nextAnalyzerOrdinal(
  analyzers: readonly AnalyzerOrdinal[], decoderId: string,
): number {
  return smallestFreeOrdinal(usedOrdinals(analyzers, decoderId));
}

export function defaultAnalyzerLabel(displayName: string, ordinal: number): string {
  return `${displayName}-${ordinal}`;
}

export function sanitizeAnalyzerLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  return raw.trim().slice(0, MAX_ANALYZER_LABEL_LENGTH) || fallback;
}

export function analyzerLabelFrom(name: string, displayName: string, ordinal: number): string {
  return sanitizeAnalyzerLabel(name, defaultAnalyzerLabel(displayName, ordinal));
}

const LABEL_ORDINAL_SUFFIX = /^.*-(\d{1,4})$/;

function isPersistedOrdinal(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function smallestFreeOrdinal(used: ReadonlySet<number>): number {
  let ordinal = 1;
  while (used.has(ordinal)) ordinal++;
  return ordinal;
}

export function restoredAnalyzerOrdinal(
  raw: unknown, label: string, used: ReadonlySet<number>,
): number {
  if (isPersistedOrdinal(raw) && !used.has(raw)) return raw;
  const suffix = LABEL_ORDINAL_SUFFIX.exec(label);
  if (suffix !== null) {
    const ordinal = Number(suffix[1]);
    if (ordinal >= 1 && !used.has(ordinal)) return ordinal;
  }
  return smallestFreeOrdinal(used);
}
