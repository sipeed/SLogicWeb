// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * What the assistant can see and do, and nothing more.
 *
 * Every tool returns a compact JSON summary, never raw sample data: a capture can be
 * hundreds of millions of samples, so a tool hands the model statistics, a capped edge
 * list or decoded annotations and says when it truncated. Tools reach the app only
 * through `AssistantHost`, which App implements by calling the same methods its buttons
 * call - the assistant never gets a parallel path into the device or the store.
 *
 * Times are seconds from the first retained sample (sample 0). When a software trigger
 * fired, the time axis labels that sample T=0; `get_state` reports it as `trigger_s`.
 */

import type { SampleStore } from '../data/types.js';
// registry and types only: decode/client.ts statically imports the Pyodide worker, which
// would make this module (and its node self-test) depend on the worker bundle.
import { getDecoder, hydrateDecoders, listDecoders } from '../decode/registry.js';
import type { DecodeResult } from '../decode/types.js';
import type { CaptureSettings, TriggerMode } from '../ui/state.js';
import {
  BUS_HEIGHTS, DEFAULT_BUS_HEIGHT, busLabel, busSummary, runBits, type BusViewConfig,
} from '../ui/busView.js';
import { busSteps, latchedBefore, validateBusSpec, MAX_BUS_BITS, type BusEncoding } from '../data/busValue.js';
import type { ToolSpec } from './types.js';

export interface HostSnapshot {
  connected: boolean;
  device: string | null;
  running: boolean;
  stopping: boolean;
  /** Formatted status-bar error, '' when none. */
  error: string;
  label: string;
  samples: number;
  dropped: number;
  samplerate: number;
  channelCount: number;
  triggerState: 'off' | 'waiting' | 'triggered' | 'not-found';
  triggerSampleIndex: number | null;
  settings: CaptureSettings;
  /** Highest samplerate per capture width for the connected device. */
  rateCeilings: Readonly<Record<number, number>>;
  enabledChannels: number[];
  channelNames: string[];
  view: { start: number; end: number };
  decoderReady: boolean;
}

export interface HostAnalyzer {
  decoderId: string;
  channels: Record<number, number>;
  options: Record<string, string | number>;
  status: string;
  /** Formatted status note (counts, timings or the error). */
  note: string;
  result: DecodeResult | null;
}

export type CaptureOutcome = 'finished' | 'timeout' | 'not-started';

/** The app as the assistant sees it. Implemented by App. */
export interface AssistantHost {
  snapshot(): HostSnapshot;
  store(): SampleStore;
  analyzers(): readonly HostAnalyzer[];
  applySettings(patch: Partial<CaptureSettings>, enabledChannels?: number[]): void;
  /** Start a capture and resolve when it has stopped (or the timeout passed). */
  startAndWait(timeoutMs: number, signal: AbortSignal): Promise<CaptureOutcome>;
  stop(): Promise<void>;
  loadDemo(): Promise<void>;
  /** Attach a decoder and resolve after its first decode. */
  attach(decoderId: string, channels: Record<number, number>, options: Record<string, string | number>): Promise<void>;
  removeAnalyzer(index: number): boolean;
  setViewportSeconds(startS: number, endS: number): void;
  zoomToAnnotation(analyzer: number, n: number): boolean;
  levelAt(channel: number, sample: number): 0 | 1;
  /** Parallel-bus (ADC) views, in display order. */
  buses(): readonly HostBus[];
  addBus(cfg: BusViewConfig): void;
  updateBus(index: number, cfg: BusViewConfig): void;
  removeBus(index: number): void;
}

export interface HostBus {
  config: BusViewConfig;
  /** The zoomed-out overview is built (it builds in the background after a capture). */
  built: boolean;
}

/** read: runs at once. view: only moves the view, runs at once. act: needs the user's OK. */
export type ToolRisk = 'read' | 'view' | 'act';

export interface AssistantTool extends ToolSpec {
  risk: ToolRisk;
  run(input: Record<string, unknown>, host: AssistantHost, signal: AbortSignal): Promise<unknown>;
}

/** Edges examined per channel by one statistics call; beyond this the window shrinks. */
export const STATS_EDGE_CAP = 2_000_000;
export const EDGE_LIST_MAX = 1000;
export const ANNOTATION_LIST_MAX = 500;
export const BUS_VALUE_MAX = 1000;
/** Values a get_bus_values call reads for its min/max; a narrower range reads all. */
const BUS_STATS_STEPS = 500_000;

const TRIGGER_MODES: TriggerMode[] = ['low', 'high', 'rising', 'falling', 'edge', 'dont-care'];

const NO_DEVICE =
  'No device is connected. Ask the user to click the Connect button in the toolbar: the ' +
  'browser only shows its USB permission prompt after a click, so you cannot connect for them.';

// ---------------------------------------------------------------------- helpers

/** Six significant digits: enough for timing, small enough for the model's context. */
function num(x: number): number {
  return Number.isFinite(x) ? Number(x.toPrecision(6)) : x;
}

function summary(values: number[]): { min: number; median: number; max: number; count: number } | null {
  if (values.length === 0) return null;
  const s = Float64Array.from(values).sort();
  return { min: num(s[0]!), median: num(s[s.length >> 1]!), max: num(s[s.length - 1]!), count: s.length };
}

type CountingStore = SampleStore & { edgeCount?(c: number, s: number, e: number): number };

function edgeCount(store: SampleStore, ch: number, s: number, e: number): number {
  const cs = store as CountingStore;
  return cs.edgeCount ? cs.edgeCount(ch, s, e) : store.edges(ch, s, e).length;
}

/** Clip a seconds range to the capture, in samples. */
function window(host: AssistantHost, startS: unknown, endS: unknown): { s: number; e: number; sr: number } {
  const store = host.store();
  const sr = store.samplerate;
  if (store.length === 0) throw new Error('There is no capture yet. Start one or load the demo first.');
  const s = Math.max(0, Math.min(store.length, Math.floor(typeof startS === 'number' ? startS * sr : 0)));
  const e = Math.max(s, Math.min(store.length, Math.ceil(typeof endS === 'number' ? endS * sr : store.length)));
  if (e <= s) throw new Error('The time range is empty or outside the capture.');
  return { s, e, sr };
}

function checkChannel(host: AssistantHost, ch: number): void {
  const n = host.store().channelCount;
  if (!Number.isInteger(ch) || ch < 0 || ch >= n) throw new Error(`Channel ${ch} does not exist; the capture has D0-D${n - 1}.`);
}

/** Edge statistics for one channel over [s, e). */
export function channelStats(host: AssistantHost, ch: number, s: number, e: number, sr: number): Record<string, unknown> {
  const store = host.store();
  let end = e;
  let truncated = false;
  // Shrink the window rather than materialise more than the cap: a dense channel over a
  // long capture is tens of millions of edges, which is memory the page does not have.
  for (let i = 0; i < 8; i++) {
    const n = edgeCount(store, ch, s, end);
    if (n <= STATS_EDGE_CAP) break;
    truncated = true;
    end = s + Math.max(1, Math.floor((end - s) * (STATS_EDGE_CAP / n) * 0.95));
  }
  const edges = store.edges(ch, s, end);
  const initial = host.levelAt(ch, s);
  const out: Record<string, unknown> = {
    channel: ch,
    name: host.snapshot().channelNames[ch] ?? `D${ch}`,
    start_s: num(s / sr),
    end_s: num(end / sr),
    initial_level: initial,
    edges: edges.length,
  };
  if (truncated) out.truncated = `only the first ${num((end - s) / sr)} s were analysed (edge cap ${STATS_EDGE_CAP})`;
  if (edges.length === 0) {
    out.constant_level = initial;
    return out;
  }
  let level = initial;
  let prev = s;
  let highSamples = 0;
  let rising = 0;
  const high: number[] = [];
  const low: number[] = [];
  const periods: number[] = [];
  let lastRise = -1;
  for (let i = 0; i < edges.length; i++) {
    const at = edges[i]!;
    if (level === 1) highSamples += at - prev;
    // A pulse is complete only when both of its edges are inside the window.
    if (i > 0) (level === 1 ? high : low).push((at - prev) / sr);
    level = level === 1 ? 0 : 1;
    if (level === 1) {
      rising++;
      if (lastRise >= 0) periods.push((at - lastRise) / sr);
      lastRise = at;
    }
    prev = at;
  }
  if (level === 1) highSamples += end - prev;
  out.rising = rising;
  out.falling = edges.length - rising;
  out.final_level = level;
  out.first_edge_s = num(edges[0]! / sr);
  out.last_edge_s = num(edges[edges.length - 1]! / sr);
  out.high_ratio = num(highSamples / (end - s));
  out.high_pulse_s = summary(high);
  out.low_pulse_s = summary(low);
  const period = summary(periods);
  out.period_s = period;
  if (period) out.frequency_hz = num(1 / period.median);
  return out;
}

function settingsView(s: CaptureSettings): Record<string, unknown> {
  return {
    capture_width: s.channels,
    samplerate_hz: s.samplerate,
    threshold_v: s.thresholdVolts,
    mode: s.mode,
    seconds: s.seconds,
    loop_samples: s.loopSamples,
    test_mode: s.testMode,
    trigger: {
      enabled: s.triggerEnableMask,
      armed: s.softwareTrigger,
      pre_trigger_percent: s.preTriggerPercent,
      modes: s.triggerModes,
    },
  };
}

function stateView(host: AssistantHost): Record<string, unknown> {
  const st = host.snapshot();
  const sr = st.samplerate;
  return {
    connected: st.connected,
    device: st.device,
    running: st.running,
    stopping: st.stopping,
    status: st.label,
    ...(st.error ? { error: st.error } : {}),
    capture: {
      samples: st.samples,
      ...(st.dropped > 0 ? { dropped_samples: st.dropped } : {}),
      samplerate_hz: sr,
      duration_s: num(st.samples / sr),
      channels: st.channelCount,
      trigger_state: st.triggerState,
      ...(st.triggerSampleIndex !== null ? { trigger_s: num(st.triggerSampleIndex / sr) } : {}),
    },
    settings: settingsView(st.settings),
    max_samplerate_hz_by_width: st.rateCeilings,
    enabled_channels: st.enabledChannels,
    channel_names: Object.fromEntries(st.enabledChannels.map((c) => [c, st.channelNames[c] ?? `D${c}`])),
    view_s: { start: num(st.view.start / sr), end: num(st.view.end / sr) },
    decoder_runtime_ready: st.decoderReady,
    analyzers: host.analyzers().map((a, i) => ({
      index: i,
      decoder: a.decoderId,
      status: a.status,
      note: a.note,
      channels: a.channels,
      options: a.options,
      annotations: a.result?.annotations.count ?? 0,
    })),
    bus_views: host.buses().map((b, i) => busView(b, i)),
  };
}

function busView(b: HostBus, index: number): Record<string, unknown> {
  const c = b.config;
  return {
    index,
    name: c.name,
    bits_lsb_first: c.spec.bits,
    summary: busSummary(c.spec),
    clock: c.spec.clock ? { channel: c.spec.clock.channel, edge: c.spec.clock.edge } : null,
    encoding: c.spec.encoding,
    full_scale_v: c.fullScaleV,
    offset_v: c.offsetV,
    style: c.style,
    hide_sources: c.hideSources,
    overview_ready: b.built,
  };
}

function visibleChannelCount(host: AssistantHost): number {
  const st = host.snapshot();
  const store = host.store();
  return store.length > 0 ? Math.min(st.settings.channels, store.channelCount) : st.settings.channels;
}

function busAt(host: AssistantHost, index: unknown): HostBus {
  const list = host.buses();
  const i = typeof index === 'number' ? index : -1;
  const b = list[i];
  if (!b) throw new Error(`No bus view ${String(index)}; there are ${list.length} (indices 0-${list.length - 1}).`);
  return b;
}

/**
 * Apply the bus_* tool fields to a configuration. Bits come from an explicit `bits` list
 * (LSB first) or from start_channel + width (+ msb_first), as in the panel.
 */
function busConfigFrom(i: Record<string, unknown>, base: BusViewConfig, channelCount: number): BusViewConfig {
  const c: BusViewConfig = { ...base, spec: { ...base.spec } };
  if (typeof i.name === 'string' && i.name.trim()) c.name = i.name.trim();
  if (Array.isArray(i.bits)) {
    c.spec.bits = i.bits as number[];
  } else if (typeof i.start_channel === 'number' || typeof i.width === 'number' || typeof i.msb_first === 'boolean') {
    const cur = c.spec.bits;
    const start = typeof i.start_channel === 'number' ? i.start_channel : Math.min(...cur);
    const width = typeof i.width === 'number' ? i.width : cur.length;
    const msbFirst = typeof i.msb_first === 'boolean' ? i.msb_first : cur.length > 1 && cur[0]! > cur[1]!;
    if (start + width > channelCount) {
      throw new Error(`D${start}+${width} bits runs past D${channelCount - 1}; this capture has ${channelCount} channels.`);
    }
    c.spec.bits = runBits(start, width, channelCount, msbFirst);
  }
  if ('clock_channel' in i) {
    c.spec.clock = i.clock_channel === null ? null : { channel: i.clock_channel as number, edge: c.spec.clock?.edge ?? 'rising' };
  }
  if ((i.clock_edge === 'rising' || i.clock_edge === 'falling') && c.spec.clock) c.spec.clock = { ...c.spec.clock, edge: i.clock_edge };
  if (typeof i.encoding === 'string') c.spec.encoding = i.encoding as BusEncoding;
  if ('full_scale_v' in i) c.fullScaleV = typeof i.full_scale_v === 'number' && i.full_scale_v !== 0 ? i.full_scale_v : null;
  if (typeof i.offset_v === 'number') c.offsetV = i.offset_v;
  if (i.style === 'line' || i.style === 'step') c.style = i.style;
  if (typeof i.hide_sources === 'boolean') c.hideSources = i.hide_sources;
  if (typeof i.height_px === 'number') c.heightCss = i.height_px;
  const problems = validateBusSpec(c.spec, channelCount);
  if (problems.length) throw new Error(`Invalid bus: ${problems.join('; ')}.`);
  return c;
}

/** The fields add_bus_view and update_bus_view share. */
const BUS_FIELDS: Record<string, unknown> = {
  name: { type: 'string' },
  bits: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: MAX_BUS_BITS,
    description: 'Capture channels as bits, LSB FIRST. Use for arbitrary wiring; otherwise use start_channel + width.' },
  start_channel: { type: 'integer', minimum: 0, description: 'Lowest channel of a run of consecutive channels.' },
  width: { type: 'integer', minimum: 1, maximum: MAX_BUS_BITS, description: 'Number of bits in the run.' },
  msb_first: { type: 'boolean', description: 'The start channel is the MSB (lines wired MSB-first). Default false: it is the LSB.' },
  clock_channel: { type: ['integer', 'null'], minimum: 0,
    description: 'Data clock (e.g. an ADC\'s DCLK): latch on its edge. null: no clock, any bit change is a new value.' },
  clock_edge: { type: 'string', enum: ['rising', 'falling'], description: 'Clock edge that latches the data. Default rising.' },
  encoding: { type: 'string', enum: ['unsigned', 'twos', 'offset'], description: 'unsigned, two\'s complement or offset binary.' },
  full_scale_v: { type: ['number', 'null'], description: 'Volts for the full code range; volts = offset_v + value / 2^n * full_scale_v. null shows raw values.' },
  offset_v: { type: 'number' },
  style: { type: 'string', enum: ['line', 'step'], description: 'Clocked buses: dots joined by lines, or steps. Unclocked buses always draw steps.' },
  hide_sources: { type: 'boolean', description: 'Hide the source bit rows (display only; the channels stay enabled for capture).' },
  height_px: { type: 'integer', enum: [...BUS_HEIGHTS] },
};

function analyzerAt(host: AssistantHost, index: unknown): HostAnalyzer {
  const list = host.analyzers();
  const i = typeof index === 'number' ? index : -1;
  const a = list[i];
  if (!a) throw new Error(`No analyzer ${String(index)}; there are ${list.length} (indices 0-${list.length - 1}).`);
  return a;
}

function decoderChannels(id: string): { id: string; name: string; desc: string; required: boolean }[] {
  const info = getDecoder(id);
  return [
    ...info.channels.map((c) => ({ ...c, required: true })),
    ...info.optional_channels.map((c) => ({ ...c, required: false })),
  ];
}

// ------------------------------------------------------------------------ tools

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false });

const seconds = (desc: string) => ({ type: 'number', minimum: 0, description: desc });

export const TOOLS: AssistantTool[] = [
  {
    name: 'get_state',
    description:
      'Current app state: device connection, whether a capture is running, the capture ' +
      '(samples, samplerate, duration, trigger), capture settings, device samplerate ' +
      'limits per capture width, enabled channels and their names, the visible time ' +
      'range and attached protocol analyzers. Call this first.',
    inputSchema: obj({}),
    risk: 'read',
    run: async (_i, host) => stateView(host),
  },
  {
    name: 'get_channel_stats',
    description:
      'Edge statistics for channels over a time range of the current capture: edge ' +
      'counts, initial/final level, high-time ratio (duty), high and low pulse widths and ' +
      'rising-edge period (min/median/max) and the frequency from the median period. Use ' +
      'this to find active channels and estimate clock rates or baud rates.',
    inputSchema: obj({
      channels: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 32,
        description: 'Capture channel numbers (D0 is 0).' },
      start_s: seconds('Range start in seconds from capture start. Default: 0.'),
      end_s: seconds('Range end in seconds. Default: end of capture.'),
    }, ['channels']),
    risk: 'read',
    run: async (i, host) => {
      const { s, e, sr } = window(host, i.start_s, i.end_s);
      const chans = i.channels as number[];
      for (const c of chans) checkChannel(host, c);
      return { sample_period_s: num(1 / sr), channels: chans.map((c) => channelStats(host, c, s, e, sr)) };
    },
  },
  {
    name: 'get_edges',
    description:
      'The individual transitions of one channel in a time range, as {t_s, to} pairs ' +
      '(to = level after the edge), capped at `limit`. Use a narrow range for detail.',
    inputSchema: obj({
      channel: { type: 'integer', minimum: 0 },
      start_s: seconds('Range start in seconds. Default: 0.'),
      end_s: seconds('Range end in seconds. Default: end of capture.'),
      limit: { type: 'integer', minimum: 1, maximum: EDGE_LIST_MAX, description: `Default 200, max ${EDGE_LIST_MAX}.` },
    }, ['channel']),
    risk: 'read',
    run: async (i, host) => {
      const ch = i.channel as number;
      checkChannel(host, ch);
      const { s, e, sr } = window(host, i.start_s, i.end_s);
      const limit = (i.limit as number | undefined) ?? 200;
      const total = edgeCount(host.store(), ch, s, e);
      // Materialise only about `limit` edges: start from the share of the range that
      // would hold them if edges were even, then double until it does - traffic is
      // bursty, so the even-spread guess alone can land before the first burst.
      let readEnd = e;
      if (total > limit * 4) {
        readEnd = s + Math.max(1, Math.ceil((e - s) * ((limit * 2) / total)));
        while (readEnd < e && edgeCount(host.store(), ch, s, readEnd) < limit) {
          readEnd = Math.min(e, s + (readEnd - s) * 2);
        }
      }
      const edges = host.store().edges(ch, s, readEnd);
      let level = host.levelAt(ch, s);
      const out: { t_s: number; to: number }[] = [];
      for (let k = 0; k < edges.length && out.length < limit; k++) {
        level = level === 1 ? 0 : 1;
        out.push({ t_s: num(edges[k]! / sr), to: level });
      }
      return {
        channel: ch,
        initial_level: host.levelAt(ch, s),
        edges_in_range: total,
        returned: out.length,
        ...(out.length < total ? { truncated: true } : {}),
        edges: out,
      };
    },
  },
  {
    name: 'list_decoders',
    description: 'Search the 131 stock sigrok protocol decoders by id, name or description.',
    inputSchema: obj({
      query: { type: 'string', description: 'Case-insensitive filter, e.g. "uart", "i2c", "can". Empty lists all.' },
    }),
    risk: 'read',
    run: async (i) => {
      const q = String(i.query ?? '').toLowerCase();
      const hits = listDecoders().filter((d) => d.inputs.includes('logic') && (!q ||
        `${d.id} ${d.name} ${d.longname} ${d.desc}`.toLowerCase().includes(q)));
      return {
        total: hits.length,
        decoders: hits.slice(0, 40).map((d) => ({ id: d.id, name: d.name, longname: d.longname, desc: d.desc })),
      };
    },
  },
  {
    name: 'describe_decoder',
    description:
      'Channels (with ids to map to capture channels), options (ids, defaults, allowed ' +
      'values) and annotation classes of one decoder. Call before attach_decoder.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    risk: 'read',
    run: async (i) => {
      await hydrateDecoders();
      const info = getDecoder(String(i.id));
      return {
        id: info.id,
        name: info.name,
        longname: info.longname,
        desc: info.desc,
        channels: decoderChannels(info.id).map(({ id, name, desc, required }) => ({ id, name, desc, required })),
        options: info.options.map((o) => ({ id: o.id, desc: o.desc, default: o.default, type: o.type, ...(o.values.length ? { values: o.values } : {}) })),
        annotation_classes: info.annotations.map((a) => a.id),
      };
    },
  },
  {
    name: 'get_annotations',
    description:
      'Decoded annotations (start/end time, class, text) of an attached analyzer, ' +
      'optionally limited to a time range, capped at `limit`.',
    inputSchema: obj({
      analyzer: { type: 'integer', minimum: 0, description: 'Index from get_state.analyzers.' },
      start_s: seconds('Range start in seconds. Default: 0.'),
      end_s: seconds('Range end in seconds. Default: end of capture.'),
      limit: { type: 'integer', minimum: 1, maximum: ANNOTATION_LIST_MAX, description: `Default 100, max ${ANNOTATION_LIST_MAX}.` },
    }, ['analyzer']),
    risk: 'read',
    run: async (i, host) => {
      const a = analyzerAt(host, i.analyzer);
      if (!a.result) throw new Error(`Analyzer ${String(i.analyzer)} has no result yet (status: ${a.status}${a.note ? `, ${a.note}` : ''}).`);
      const { s, e, sr } = window(host, i.start_s, i.end_s);
      const r = a.result;
      const { count, start, end, inst, textOffset, texts } = r.annotations;
      const hits: number[] = [];
      for (let k = 0; k < count; k++) if (inst[k] === 0 && end[k]! > s && start[k]! < e) hits.push(k);
      const limit = (i.limit as number | undefined) ?? 100;
      const classes = r.instances[0]?.annotations ?? [];
      return {
        decoder: a.decoderId,
        in_range: hits.length,
        returned: Math.min(limit, hits.length),
        ...(hits.length > limit ? { truncated: true } : {}),
        ...(r.errors.length ? { decoder_errors: r.errors.slice(0, 3) } : {}),
        annotations: hits.slice(0, limit).map((k) => ({
          start_s: num(r.annotations.start[k]! / sr),
          end_s: num(r.annotations.end[k]! / sr),
          class: classes[r.annotations.cls[k]!]?.id ?? String(r.annotations.cls[k]),
          // Text variants are stored longest first (DecodeClient's layout).
          text: texts[textOffset[k]!] ?? '',
        })),
      };
    },
  },
  {
    name: 'set_viewport',
    description: 'Show a time range in the waveform view (does not change the capture).',
    inputSchema: obj({ start_s: seconds('Start in seconds.'), end_s: seconds('End in seconds.') }, ['start_s', 'end_s']),
    risk: 'view',
    run: async (i, host) => {
      const { s, e, sr } = window(host, i.start_s, i.end_s);
      host.setViewportSeconds(s / sr, e / sr);
      return { ok: true, view_s: { start: num(s / sr), end: num(e / sr) } };
    },
  },
  {
    name: 'zoom_to_annotation',
    description: 'Centre the waveform view on the nth annotation of an analyzer.',
    inputSchema: obj({ analyzer: { type: 'integer', minimum: 0 }, n: { type: 'integer', minimum: 0 } }, ['analyzer', 'n']),
    risk: 'view',
    run: async (i, host) => {
      analyzerAt(host, i.analyzer);
      if (!host.zoomToAnnotation(i.analyzer as number, i.n as number)) throw new Error('That annotation does not exist.');
      return { ok: true };
    },
  },
  {
    name: 'set_capture_settings',
    description:
      'Change capture settings for the NEXT capture. Only the fields you pass change. ' +
      'Values are clamped to device limits; the result shows what was applied. The ' +
      'capture width is an explicit tier (8CH/16CH/32CH); enabled_channels only masks ' +
      'the display. ' +
      'trigger_modes maps a channel number to low/high/rising/falling/edge/dont-care; ' +
      'all conditions must hold at once (AND), and trigger_enabled gates them all.',
    inputSchema: obj({
      enabled_channels: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1,
        description: 'Exactly these channels are enabled.' },
      samplerate_hz: { type: 'number', exclusiveMinimum: 0 },
      threshold_v: { type: 'number', minimum: 0.1, maximum: 5 },
      mode: { type: 'string', enum: ['timer', 'free', 'loop'],
        description: 'timer: stop after `seconds`. free: run until stopped. loop: run until stopped, keeping only the newest `loop_samples`.' },
      seconds: { type: 'number', minimum: 0.001,
        description: 'Post-trigger capture length in timer mode, from 0.001 s (1 ms) up to the sample-count limit.' },
      loop_samples: { type: 'number', minimum: 1024,
        description: 'Retention window in loop mode, in samples; rounded up to a multiple of 1024 and clamped to the loop memory budget.' },
      test_mode: { type: 'integer', enum: [0, 1, 2], description: '0 real pins, 1 USB max-speed pattern, 2 built-in signal simulator.' },
      trigger_enabled: { type: 'boolean' },
      trigger_modes: { type: 'object', additionalProperties: { type: 'string', enum: TRIGGER_MODES },
        description: 'e.g. {"0": "rising", "3": "high"}. Use dont-care to clear a channel.' },
      pre_trigger_percent: { type: 'number', minimum: 0, maximum: 75 },
    }),
    risk: 'act',
    run: async (i, host) => {
      const st = host.snapshot();
      if (st.running || st.stopping) throw new Error('A capture is running; stop it before changing settings.');
      const patch: Partial<CaptureSettings> = {};
      if (typeof i.samplerate_hz === 'number') patch.samplerate = i.samplerate_hz;
      if (typeof i.threshold_v === 'number') patch.thresholdVolts = i.threshold_v;
      if (i.mode === 'timer' || i.mode === 'free' || i.mode === 'loop') patch.mode = i.mode;
      if (typeof i.seconds === 'number') patch.seconds = i.seconds;
      if (typeof i.loop_samples === 'number') patch.loopSamples = i.loop_samples;
      if (i.test_mode === 0 || i.test_mode === 1 || i.test_mode === 2) patch.testMode = i.test_mode;
      if (typeof i.trigger_enabled === 'boolean') patch.triggerEnableMask = i.trigger_enabled;
      if (typeof i.pre_trigger_percent === 'number') patch.preTriggerPercent = i.pre_trigger_percent;
      if (i.trigger_modes && typeof i.trigger_modes === 'object') {
        const modes: Record<number, TriggerMode> = { ...st.settings.triggerModes };
        for (const [k, v] of Object.entries(i.trigger_modes as Record<string, TriggerMode>)) {
          const ch = Number(k);
          if (!Number.isInteger(ch) || ch < 0) throw new Error(`"${k}" is not a channel number.`);
          if (v === 'dont-care') delete modes[ch]; else modes[ch] = v;
        }
        patch.triggerModes = modes;
        patch.triggerConditions = [];
      }
      const enabled = Array.isArray(i.enabled_channels) ? i.enabled_channels as number[] : undefined;
      if (enabled) {
        const max = st.channelNames.length;
        const bad = enabled.filter((c) => c >= max);
        if (bad.length) throw new Error(`Channels ${bad.join(', ')} do not exist on this device (D0-D${max - 1}).`);
      }
      host.applySettings(patch, enabled);
      const after = host.snapshot();
      if (typeof i.samplerate_hz === 'number' && after.settings.samplerate !== i.samplerate_hz) {
        return { applied: settingsView(after.settings), enabled_channels: after.enabledChannels,
          note: `samplerate was clamped to ${after.settings.samplerate} Hz for a ${after.settings.channels}-channel capture` };
      }
      return { applied: settingsView(after.settings), enabled_channels: after.enabledChannels };
    },
  },
  {
    name: 'start_capture',
    description:
      'Start a capture on the connected device with the current settings and wait until ' +
      'it stops (timer mode or trigger) or `timeout_s` passes. Free-running and loop ' +
      'captures keep running after the timeout; call stop_capture to end them.',
    inputSchema: obj({
      timeout_s: { type: 'number', minimum: 1, maximum: 120, description: 'How long to wait. Default 15.' },
    }),
    risk: 'act',
    run: async (i, host, signal) => {
      const st = host.snapshot();
      if (!st.connected) throw new Error(NO_DEVICE);
      if (st.running || st.stopping) throw new Error('A capture is already running.');
      const outcome = await host.startAndWait(((i.timeout_s as number | undefined) ?? 15) * 1000, signal);
      const after = stateView(host);
      if (outcome === 'not-started') return { started: false, state: after };
      return { started: true, finished: outcome === 'finished', state: after };
    },
  },
  {
    name: 'stop_capture',
    description: 'Stop the running capture. The data captured so far is kept.',
    inputSchema: obj({}),
    risk: 'act',
    run: async (_i, host) => {
      if (!host.snapshot().running) throw new Error('No capture is running.');
      await host.stop();
      return stateView(host);
    },
  },
  {
    name: 'load_demo',
    description:
      'Load the built-in protocol demo capture (I2C, SPI and UART with decoders attached). ' +
      'Only available while no device is connected.',
    inputSchema: obj({}),
    risk: 'act',
    run: async (_i, host) => {
      const st = host.snapshot();
      if (st.connected) throw new Error('The demo is only available without a connected device.');
      await host.loadDemo();
      return stateView(host);
    },
  },
  {
    name: 'attach_decoder',
    description:
      'Attach a protocol decoder to the current capture and decode it. `channels` maps ' +
      'the decoder\'s channel ids (from describe_decoder) to capture channel numbers; ' +
      'every required channel must be mapped. `options` uses the decoder\'s option ids.',
    inputSchema: obj({
      decoder: { type: 'string' },
      channels: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 },
        description: 'e.g. {"rx": 3} for uart, {"scl": 0, "sda": 1} for i2c.' },
      options: { type: 'object', additionalProperties: { type: ['string', 'number'] },
        description: 'e.g. {"baudrate": 115200}.' },
    }, ['decoder', 'channels']),
    risk: 'act',
    run: async (i, host) => {
      if (host.store().length === 0) throw new Error('There is no capture to decode.');
      await hydrateDecoders();
      const id = String(i.decoder);
      const info = getDecoder(id);
      const chans = decoderChannels(id);
      const mapping: Record<number, number> = {};
      for (const [k, v] of Object.entries(i.channels as Record<string, number>)) {
        const idx = chans.findIndex((c) => c.id === k);
        if (idx < 0) throw new Error(`${id} has no channel "${k}"; its channels are ${chans.map((c) => c.id).join(', ')}.`);
        checkChannel(host, v);
        mapping[idx] = v;
      }
      const missing = chans.filter((c, idx) => c.required && !(idx in mapping)).map((c) => c.id);
      if (missing.length) throw new Error(`Required channel(s) not mapped: ${missing.join(', ')}.`);
      const options: Record<string, string | number> = {};
      for (const [k, v] of Object.entries((i.options ?? {}) as Record<string, string | number>)) {
        const o = info.options.find((x) => x.id === k);
        if (!o) throw new Error(`${id} has no option "${k}"; its options are ${info.options.map((x) => x.id).join(', ') || 'none'}.`);
        const value = o.type === 'str' ? String(v) : Number(v);
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`Option "${k}" needs a number.`);
        if (o.values.length && !o.values.some((x) => String(x) === String(value))) {
          throw new Error(`Option "${k}" must be one of ${o.values.join(', ')}.`);
        }
        options[k] = value;
      }
      const before = host.analyzers().length;
      await host.attach(id, mapping, options);
      const list = host.analyzers();
      const a = list[list.length - 1];
      if (!a || list.length === before) throw new Error('The analyzer was not attached.');
      return {
        analyzer: list.length - 1,
        decoder: id,
        status: a.status,
        note: a.note,
        annotations: a.result?.annotations.count ?? 0,
      };
    },
  },
  {
    name: 'remove_decoder',
    description: 'Remove an attached protocol analyzer.',
    inputSchema: obj({ analyzer: { type: 'integer', minimum: 0 } }, ['analyzer']),
    risk: 'act',
    run: async (i, host) => {
      analyzerAt(host, i.analyzer);
      host.removeAnalyzer(i.analyzer as number);
      return { ok: true, remaining: host.analyzers().length };
    },
  },
  {
    name: 'add_bus_view',
    description:
      'Show a parallel bus - typically an ADC\'s data lines - as one analog row: n channels ' +
      'combined into a value (LSB first), optionally latched on a clock channel\'s edge, ' +
      'decoded as unsigned / two\'s complement / offset binary and optionally scaled to ' +
      'volts. Give either start_channel + width (+ msb_first) or an explicit bits list.',
    inputSchema: obj(BUS_FIELDS),
    risk: 'act',
    run: async (i, host) => {
      if (!Array.isArray(i.bits) && typeof i.start_channel !== 'number') {
        throw new Error('Give start_channel and width, or a bits list (LSB first).');
      }
      const channelCount = visibleChannelCount(host);
      const base: BusViewConfig = {
        name: 'ADC', color: '', fullScaleV: null, offsetV: 0, style: 'line', heightCss: DEFAULT_BUS_HEIGHT,
        hideSources: false, spec: { bits: [0], clock: null, encoding: 'unsigned' },
      };
      const cfg = busConfigFrom({ width: 8, ...i }, base, channelCount);
      host.addBus(cfg);
      const list = host.buses();
      return busView(list[list.length - 1]!, list.length - 1);
    },
  },
  {
    name: 'update_bus_view',
    description: 'Change a bus view (fields as in add_bus_view; only those given change).',
    inputSchema: obj({ index: { type: 'integer', minimum: 0 }, ...BUS_FIELDS }, ['index']),
    risk: 'act',
    run: async (i, host) => {
      const b = busAt(host, i.index);
      const channelCount = visibleChannelCount(host);
      host.updateBus(i.index as number, busConfigFrom(i, b.config, channelCount));
      return busView(host.buses()[i.index as number]!, i.index as number);
    },
  },
  {
    name: 'remove_bus_view',
    description: 'Remove a bus view.',
    inputSchema: obj({ index: { type: 'integer', minimum: 0 } }, ['index']),
    risk: 'act',
    run: async (i, host) => {
      busAt(host, i.index);
      host.removeBus(i.index as number);
      return { ok: true, remaining: host.buses().length };
    },
  },
  {
    name: 'get_bus_values',
    description:
      'The values of a bus view over a time range: each change as {t_s, value} (and volts ' +
      'when a full scale is set), capped at `limit`, plus the min and max over the range. ' +
      'In clocked mode each entry is one latched sample. null means unknown (a capture gap, ' +
      'or no clock edge yet).',
    inputSchema: obj({
      bus: { type: 'integer', minimum: 0, description: 'Index from get_state.bus_views.' },
      start_s: seconds('Range start in seconds. Default: 0.'),
      end_s: seconds('Range end in seconds. Default: end of capture.'),
      limit: { type: 'integer', minimum: 1, maximum: BUS_VALUE_MAX, description: `Default 200, max ${BUS_VALUE_MAX}.` },
    }, ['bus']),
    risk: 'read',
    run: async (i, host) => {
      const cfg = busAt(host, i.bus).config;
      const store = host.store();
      const problems = validateBusSpec(cfg.spec, store.channelCount);
      if (problems.length) throw new Error(`This capture cannot show the bus: ${problems.join('; ')}.`);
      const { s, e, sr } = window(host, i.start_s, i.end_s);
      const limit = (i.limit as number | undefined) ?? 200;
      // Statistics read up to BUS_STATS_STEPS values; the list is the first `limit`.
      const st = busSteps(store, cfg.spec, s, e, { carry: latchedBefore(store, cfg.spec, s), maxSteps: BUS_STATS_STEPS });
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let k = 0; k < st.count; k++) {
        const v = st.val[k]!;
        if (Number.isNaN(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const volts = cfg.fullScaleV !== null;
      const values = [];
      for (let k = 0; k < Math.min(limit, st.count); k++) {
        const v = st.val[k]!;
        const known = !Number.isNaN(v);
        values.push({
          t_s: num(st.pos[k]! / sr),
          value: known ? v : null,
          ...(volts ? { volts: known ? busLabel(cfg, v) : null } : {}),
        });
      }
      return {
        bus: cfg.name,
        summary: busSummary(cfg.spec),
        encoding: cfg.spec.encoding,
        range_s: { start: num(s / sr), end: num(e / sr) },
        changes_in_range: st.truncated ? `more than ${BUS_STATS_STEPS}` : st.count,
        returned: values.length,
        ...(values.length < st.count || st.truncated ? { truncated: true } : {}),
        ...(min <= max ? {
          min: volts ? busLabel(cfg, min) : min,
          max: volts ? busLabel(cfg, max) : max,
          ...(st.truncated ? { min_max_over: `the first ${BUS_STATS_STEPS} changes` } : {}),
        } : { min: null, max: null }),
        values,
      };
    },
  },
];

export function toolByName(name: string): AssistantTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

// ------------------------------------------------------------------- validation

/**
 * The subset of JSON Schema the tool specs above use. Inputs are model output and, with
 * eager input streaming, not validated by the API - so every call is checked here before
 * it runs. Returns the problems, empty when valid.
 */
export function validate(value: unknown, schema: Record<string, unknown>, path = 'input'): string[] {
  const errs: string[] = [];
  const type = schema.type as string | string[] | undefined;
  const types = type === undefined ? [] : Array.isArray(type) ? type : [type];
  const is = (t: string): boolean =>
    t === 'integer' ? Number.isInteger(value)
      : t === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : t === 'array' ? Array.isArray(value)
          : t === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value)
            : typeof value === t;
  if (types.length && !types.some(is)) return [`${path} must be ${types.join(' or ')}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`];
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errs.push(`${path} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errs.push(`${path} must be <= ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errs.push(`${path} must be > ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errs.push(`${path} allows at most ${schema.maxItems} item(s)`);
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((v, k) => errs.push(...validate(v, items, `${path}[${k}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in o)) errs.push(`${path}.${r} is required`);
    const extra = schema.additionalProperties;
    for (const [k, v] of Object.entries(o)) {
      if (props[k]) errs.push(...validate(v, props[k], `${path}.${k}`));
      else if (extra === false) errs.push(`${path}.${k} is not a known field`);
      else if (extra && typeof extra === 'object') errs.push(...validate(v, extra as Record<string, unknown>, `${path}.${k}`));
    }
  }
  return errs;
}

/** The specs handed to a provider. */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}
