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
  const used = usedOrdinals(analyzers, decoderId);
  let ordinal = 1;
  while (used.has(ordinal)) ordinal++;
  return ordinal;
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
