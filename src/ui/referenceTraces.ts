// SPDX-License-Identifier: GPL-3.0-or-later

export const MAX_REFERENCE_TRACES = 4;
export const MAX_REFERENCE_SAMPLES = 1 << 20;

const INDEX_EPSILON = 1e-9;

export interface ReferenceTrace {
  readonly id: number;
  readonly busId: string;
  readonly group: number;
  readonly start: number;
  readonly samplePeriod: number;
  readonly originSample: number;
  readonly gain: number;
  readonly zeroCode: number;
  readonly voltsPerCode: number;
  readonly codes: Uint8Array;
  readonly unknown: Uint8Array;
  readonly color: string;
  readonly label: string;
}

export interface ReferenceTraceInput {
  id: number;
  busId: string;
  group: number;
  start: number;
  samplePeriod: number;
  originSample: number;
  gain: number;
  zeroCode: number;
  voltsPerCode: number;
  codes: Uint8Array;
  unknown: Uint8Array;
  color: string;
  label: string;
}

export type ReferenceSaveRefusal = 'empty' | 'too-wide' | 'outside';

export interface ReferenceSaveInput {
  start: number;
  end: number;
  storeLength: number;
  droppedSamples: number;
}

export interface ReferenceSaveSpan {
  readonly kind: 'save';
  readonly start: number;
  readonly end: number;
  readonly absoluteStart: number;
  readonly absoluteEnd: number;
}

export interface ReferenceSaveRefused {
  readonly kind: 'refuse';
  readonly reason: ReferenceSaveRefusal;
}

export type ReferenceSavePlan = ReferenceSaveSpan | ReferenceSaveRefused;

export type ReferenceAddRefusal = 'limit' | 'id-taken';

export interface ReferenceAdded {
  readonly kind: 'added';
  readonly list: ReferenceTrace[];
  readonly replaced: boolean;
}

export interface ReferenceAddRefused {
  readonly kind: 'refuse';
  readonly reason: ReferenceAddRefusal;
}

export type ReferenceAddResult = ReferenceAdded | ReferenceAddRefused;

export interface ReferenceEntry {
  readonly trace: ReferenceTrace;
  readonly available: boolean;
}

export interface ReferenceViewport {
  readonly viewStart: number;
  readonly viewEnd: number;
  readonly samplePeriod: number;
}

export interface ReferenceSpan {
  readonly start: number;
  readonly end: number;
}

export interface ReferenceProjection {
  readonly xs: Float64Array;
  readonly volts: Float64Array;
}

export interface ReferenceScope {
  yVolts(volts: number): number;
}

function integer(name: string, value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer, got ${value}`);
  }
  return value;
}

function finite(name: string, value: number): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite, got ${value}`);
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  const n = integer(name, value);
  if (n < 0) throw new RangeError(`${name} must not be negative, got ${n}`);
  return n;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
  }
  return value;
}

function text(name: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
  return value;
}

function copied(name: string, data: Uint8Array): Uint8Array {
  if (!(data instanceof Uint8Array)) throw new RangeError(`${name} must be a Uint8Array`);
  return Uint8Array.from(data);
}

export function planReferenceSave(input: ReferenceSaveInput): ReferenceSavePlan {
  const start = integer('start', input.start);
  const end = integer('end', input.end);
  const storeLength = nonNegativeInteger('storeLength', input.storeLength);
  const droppedSamples = nonNegativeInteger('droppedSamples', input.droppedSamples);
  if (storeLength === 0) return { kind: 'refuse', reason: 'empty' };
  if (end <= start) return { kind: 'refuse', reason: 'empty' };
  const from = Math.max(0, start);
  const to = Math.min(storeLength, end);
  if (to <= from) return { kind: 'refuse', reason: 'outside' };
  if (to - from > MAX_REFERENCE_SAMPLES) return { kind: 'refuse', reason: 'too-wide' };
  return {
    kind: 'save',
    start: from,
    end: to,
    absoluteStart: from + droppedSamples,
    absoluteEnd: to + droppedSamples,
  };
}

export function referenceTrace(input: ReferenceTraceInput): ReferenceTrace {
  if (input.codes.length !== input.unknown.length) {
    throw new RangeError(
      `codes (${input.codes.length}) and unknown (${input.unknown.length}) must be the same length`);
  }
  if (input.codes.length === 0) throw new RangeError('a reference snapshot holds at least one sample');
  if (input.codes.length > MAX_REFERENCE_SAMPLES) {
    throw new RangeError(
      `a reference snapshot holds at most ${MAX_REFERENCE_SAMPLES} samples, got ${input.codes.length}`);
  }
  const codes = copied('codes', input.codes);
  const unknown = copied('unknown', input.unknown);
  return {
    id: nonNegativeInteger('id', input.id),
    busId: text('busId', input.busId),
    group: nonNegativeInteger('group', input.group),
    start: nonNegativeInteger('start', input.start),
    samplePeriod: positive('samplePeriod', input.samplePeriod),
    originSample: integer('originSample', input.originSample),
    gain: positive('gain', input.gain),
    zeroCode: integer('zeroCode', input.zeroCode),
    voltsPerCode: positive('voltsPerCode', input.voltsPerCode),
    codes,
    unknown,
    color: text('color', input.color),
    label: text('label', input.label),
  };
}

export function addReference(
  existing: readonly ReferenceTrace[], trace: ReferenceTrace,
): ReferenceAddResult {
  const sameBus = existing.findIndex((entry) => entry.busId === trace.busId);
  const idClash = existing.some((entry, index) => index !== sameBus && entry.id === trace.id);
  if (idClash) return { kind: 'refuse', reason: 'id-taken' };
  if (sameBus >= 0) {
    return {
      kind: 'added',
      replaced: true,
      list: existing.map((entry, index) => (index === sameBus ? trace : entry)),
    };
  }
  if (existing.length >= MAX_REFERENCE_TRACES) return { kind: 'refuse', reason: 'limit' };
  return { kind: 'added', replaced: false, list: [...existing, trace] };
}

export function removeReference(
  list: readonly ReferenceTrace[], id: number,
): ReferenceTrace[] {
  return list.filter((entry) => entry.id !== id);
}

export function toggleReferenceVisible(
  hidden: ReadonlySet<number>, id: number,
): ReadonlySet<number> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function pruneReferences(
  list: readonly ReferenceTrace[], validBusIds: ReadonlySet<string>,
): ReferenceEntry[] {
  return list.map((trace) => ({ trace, available: validBusIds.has(trace.busId) }));
}

export function referenceVisible(entry: ReferenceEntry, hidden: ReadonlySet<number>): boolean {
  return entry.available && !hidden.has(entry.trace.id);
}

export function visibleReferences(
  entries: readonly ReferenceEntry[], hidden: ReadonlySet<number>,
): ReferenceEntry[] {
  return entries.filter((entry) => referenceVisible(entry, hidden));
}

export function referenceSpanAt(
  trace: ReferenceTrace, viewport: ReferenceViewport,
): ReferenceSpan | null {
  const period = positive('samplePeriod', viewport.samplePeriod);
  const viewStart = finite('viewStart', viewport.viewStart);
  const viewEnd = finite('viewEnd', viewport.viewEnd);
  const spanStart = trace.originSample * trace.samplePeriod;
  const spanEnd = spanStart + trace.codes.length * trace.samplePeriod;
  const fromSeconds = viewStart * period;
  const toSeconds = viewEnd * period;
  if (!(toSeconds > fromSeconds)) return null;
  if (!(spanEnd > spanStart)) return null;
  if (toSeconds <= spanStart || fromSeconds >= spanEnd) return null;
  const first = Math.ceil((fromSeconds - spanStart) / trace.samplePeriod - INDEX_EPSILON);
  const last = Math.ceil((toSeconds - spanStart) / trace.samplePeriod - INDEX_EPSILON);
  const start = Math.max(0, first);
  const end = Math.min(trace.codes.length, last);
  return end > start ? { start, end } : null;
}

function periodOf(trace: ReferenceTrace, samplePeriod: number | undefined): number {
  return positive('samplePeriod', samplePeriod ?? trace.samplePeriod);
}

export function referenceSampleIndex(
  trace: ReferenceTrace, sample: number, samplePeriod?: number,
): number | null {
  if (!Number.isFinite(sample)) return null;
  const period = periodOf(trace, samplePeriod);
  const offset = sample * period - trace.originSample * trace.samplePeriod;
  const index = Math.floor(offset / trace.samplePeriod + INDEX_EPSILON);
  return index >= 0 && index < trace.codes.length ? index : null;
}

export function referencePosition(
  trace: ReferenceTrace, index: number, samplePeriod?: number,
): number {
  const period = periodOf(trace, samplePeriod);
  const position = integer('index', index);
  return (trace.originSample + position) * (trace.samplePeriod / period);
}

export function projectReference(
  trace: ReferenceTrace,
  viewport: ReferenceViewport,
  toX: (samplePosition: number) => number,
  columns: number,
): ReferenceProjection {
  const width = Math.max(1, Math.floor(columns));
  const empty = new Float64Array(0);
  const span = referenceSpanAt(trace, viewport);
  if (span === null) return { xs: empty, volts: empty };
  const xs = new Float64Array(width * 2 + 3);
  const volts = new Float64Array(width * 2 + 3);
  let count = 0;
  let column = Number.NaN;
  let anchor = 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let first = 0;
  let known = false;
  const flush = (): void => {
    if (!known) {
      if (count > 0 && !Number.isNaN(xs[count - 1]!)) {
        xs[count] = Number.NaN;
        volts[count] = Number.NaN;
        count += 1;
      }
      return;
    }
    const order = first === low ? [low, high] : [high, low];
    for (const value of order) {
      xs[count] = anchor;
      volts[count] = value;
      count += 1;
      if (low === high) break;
    }
  };
  for (let index = span.start; index < span.end; index++) {
    const x = toX(referencePosition(trace, index, viewport.samplePeriod));
    if (!Number.isFinite(x)) continue;
    const next = Math.floor(x);
    if (next !== column) {
      flush();
      column = next;
      anchor = x;
      low = Number.POSITIVE_INFINITY;
      high = Number.NEGATIVE_INFINITY;
      known = false;
    }
    const value = referenceVolts(trace, index);
    if (Number.isNaN(value)) continue;
    if (!known) {
      first = value;
      known = true;
    }
    if (value < low) low = value;
    if (value > high) high = value;
  }
  flush();
  return { xs: xs.slice(0, count), volts: volts.slice(0, count) };
}

export function referenceVolts(trace: ReferenceTrace, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= trace.codes.length) return Number.NaN;
  if (trace.unknown[index] !== 0) return Number.NaN;
  return (trace.codes[index]! - trace.zeroCode) * trace.voltsPerCode;
}

export function referenceY(trace: ReferenceTrace, index: number, scope: ReferenceScope): number {
  return scope.yVolts(referenceVolts(trace, index));
}

export function referenceGaps(trace: ReferenceTrace): ReferenceSpan[] {
  const spans: ReferenceSpan[] = [];
  let open = -1;
  for (let i = 0; i < trace.unknown.length; i++) {
    if (trace.unknown[i] !== 0) {
      if (open < 0) open = i;
    } else if (open >= 0) {
      spans.push({ start: open, end: i });
      open = -1;
    }
  }
  if (open >= 0) spans.push({ start: open, end: trace.unknown.length });
  return spans;
}

function contentHash(codes: Uint8Array, unknown: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < codes.length; i++) {
    hash = Math.imul(hash ^ codes[i]!, 0x01000193);
  }
  for (let i = 0; i < unknown.length; i++) {
    hash = Math.imul(hash ^ (unknown[i] === 0 ? 0 : 1), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function referenceSignature(
  entries: readonly ReferenceEntry[], hidden: ReadonlySet<number>,
): string {
  return entries.map((entry) => {
    const trace = entry.trace;
    return [
      trace.id, trace.busId, trace.group, trace.start, trace.samplePeriod, trace.originSample,
      trace.gain, trace.zeroCode, trace.voltsPerCode, trace.color, trace.label,
      entry.available ? 1 : 0, hidden.has(trace.id) ? 1 : 0,
      trace.codes.length, trace.unknown.length, contentHash(trace.codes, trace.unknown),
    ].join(':');
  }).join('|');
}
