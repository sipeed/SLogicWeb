import { isChannelCount, type ChannelCount } from '../types.js';
import { SAMPLERATES_HZ } from '../device/index.js';
import { validateBusSpec } from '../data/index.js';
import {
  ANALOG_MAX_HALF_RANGE_V, analogGainOf, analogSpan, busChannelBank, isAnalogGain,
} from './channelBanks.js';

/**
 * The span every analog bus was saved with before the explicit `analogGroup` marker and
 * before the scale became profile data: the old ±15 V over /255 model. Only used to
 * recognise those saves; it is not the current scale (`analogSpan`).
 */
const LEGACY_ANALOG_FULL_SCALE_V = 30;
const LEGACY_ANALOG_OFFSET_V = -15;
import { cloneBusConfig, defaultBusConfig, normalizeBankBusConfig } from './busPanel.js';
import { ANALOG_HEIGHTS, BUS_HEIGHTS, type BusBitOrder, type BusViewConfig } from './busView.js';
import {
  analyzerColor, analyzerLaneChannel, defaultCaptureSettings, defaultChannelName, defaultChannels,
  type AnalyzerState, type CaptureSettings, type TriggerMode,
} from './state.js';
import { parseSidebarPage, type SidebarPage } from './sidebar.js';
import { isRestorableThreshold } from './thresholdOptions.js';

export const WORKSPACE_STORAGE_KEY = 'slogicweb.workspace';
export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const MAX_PERSISTED_ANALYZERS = 64;

const MAX_DECODER_CHANNELS = 64;
const MAX_ANALYZER_LABEL_LENGTH = 64;
const ANALYZER_TOKEN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ANALYZER_ID = /^[a-z0-9_-]+-\d+$/;
const CANONICAL_INDEX_KEY = /^(0|[1-9]\d*)$/;

export interface PersistedChannel {
  name: string;
  color: string;
  enabled: boolean;
}

export interface PersistedCaptureSettings {
  channels?: ChannelCount;
  widthExplicit?: boolean;
  samplerate: number;
  samplerateExplicit?: boolean;
  thresholdVolts: number;
  mode: CaptureSettings['mode'];
  seconds: number;
  repeatIntervalSeconds?: number;
  loopSamples: number;
  testMode: 0 | 1 | 2;
  triggerEnableMask: boolean;
  triggerModes: Record<number, TriggerMode>;
  analogTriggers?: Record<string, { kind: 'rising' | 'falling'; volts: number }>;
  triggerSource?: 'digital' | 'analog';
  preTriggerPercent: number;
}

export interface PersistedAnalyzer {
  id: string;
  decoderId: string;
  label: string;
  color: string;
  channels: Record<number, number>;
  options: Record<string, string | number>;
  laneChannel: number;
}

export interface PersistedSidebar {
  page?: SidebarPage;
  visible?: boolean;
}

export interface WorkspaceSnapshotV1 {
  version: typeof WORKSPACE_SCHEMA_VERSION;
  detailedLabels: boolean;
  /** "Wheel zooms without Ctrl"; absent means off (the HSync/DSView default). */
  wheelZooms?: boolean;
  /** Developer tools (raw USB register console); absent means off. */
  developerTools?: boolean;
  /** "Compact rows": digital rows may shrink to 24 px (DESIGN §5.4); absent means off. */
  compactRows?: boolean;
  /** "Hide idle channels": rows with no edge in the capture are hidden; absent means off. */
  hideIdleChannels?: boolean;
  channels?: PersistedChannel[];
  order?: number[];
  capture?: PersistedCaptureSettings;
  busViews?: BusViewConfig[];
  bankBusDrafts?: Record<string, BusViewConfig>;
  analyzers?: PersistedAnalyzer[];
  sidebar?: PersistedSidebar;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreSidebar(value: unknown): PersistedSidebar | null {
  if (!isRecord(value)) return null;
  const section: PersistedSidebar = {};
  const page = parseSidebarPage(value.page);
  if (page !== null) section.page = page;
  if (value.visible === false) section.visible = false;
  return section.page === undefined && section.visible === undefined ? null : section;
}

function restoreChannels(value: unknown, fallbackChannelCount: ChannelCount): PersistedChannel[] {
  const validSource = Array.isArray(value) && isChannelCount(value.length);
  const capacity = validSource ? value.length : fallbackChannelCount;
  const channels = defaultChannels(capacity).map(({ name, color, enabled }) => ({ name, color, enabled }));
  if (validSource) {
    for (let i = 0; i < channels.length; i++) {
      const candidate = value[i];
      if (!isRecord(candidate)) continue;
      const channel = channels[i]!;
      if (typeof candidate.name === 'string') channel.name = candidate.name.trim() || defaultChannelName(i);
      if (typeof candidate.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate.color)) {
        channel.color = candidate.color;
      }
      if (typeof candidate.enabled === 'boolean') channel.enabled = candidate.enabled;
    }
  }
  if (channels.every((channel) => !channel.enabled)) channels[0]!.enabled = true;
  return channels;
}

export function restoreOrder(value: unknown, capacity: number): number[] {
  const order: number[] = [];
  if (Array.isArray(value)) {
    for (const index of value) {
      if (Number.isInteger(index) && index >= 0 && index < capacity && !order.includes(index)) order.push(index);
    }
  }
  for (let i = 0; i < capacity; i++) if (!order.includes(i)) order.push(i);
  return order;
}

function isTriggerMode(value: unknown): value is TriggerMode {
  return value === 'low' || value === 'high' || value === 'rising' ||
    value === 'falling' || value === 'edge' || value === 'dont-care';
}

function restoreTriggerModes(value: unknown, capacity: number): Record<number, TriggerMode> {
  const modes: Record<number, TriggerMode> = {};
  if (!isRecord(value)) return modes;
  for (const [key, mode] of Object.entries(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) continue;
    const channel = Number(key);
    if (!Number.isSafeInteger(channel) || channel < 0 || channel >= capacity || !isTriggerMode(mode)) continue;
    modes[channel] = mode;
  }
  return modes;
}

function restoreCapture(value: unknown, capacity: number): PersistedCaptureSettings {
  const defaults = defaultCaptureSettings();
  const capture: PersistedCaptureSettings = {
    samplerate: defaults.samplerate,
    thresholdVolts: defaults.thresholdVolts,
    mode: defaults.mode,
    seconds: defaults.seconds,
    repeatIntervalSeconds: defaults.repeatIntervalSeconds,
    loopSamples: defaults.loopSamples,
    testMode: defaults.testMode,
    triggerEnableMask: defaults.triggerEnableMask,
    triggerModes: {},
    analogTriggers: {},
    triggerSource: defaults.triggerSource,
    preTriggerPercent: defaults.preTriggerPercent,
  };
  if (!isRecord(value)) return capture;
  if (typeof value.channels === 'number' && isChannelCount(value.channels) && value.channels <= capacity) {
    capture.channels = value.channels;
  }
  if (value.widthExplicit === true) capture.widthExplicit = true;
  if (typeof value.samplerate === 'number' && SAMPLERATES_HZ.includes(value.samplerate)) {
    capture.samplerate = value.samplerate;
  }
  if (value.samplerateExplicit === true) capture.samplerateExplicit = true;
  // A preset, or a custom value on the vref DAC grid (thresholdOptions.ts).
  if (typeof value.thresholdVolts === 'number' && isRestorableThreshold(value.thresholdVolts)) {
    capture.thresholdVolts = value.thresholdVolts;
  }
  if (value.mode === 'free' || value.mode === 'timer') {
    capture.mode = 'single';
  } else if (value.mode === 'single' || value.mode === 'repeat' || value.mode === 'loop') {
    capture.mode = value.mode;
  }
  if (typeof value.seconds === 'number' && Number.isFinite(value.seconds)) capture.seconds = value.seconds;
  if (typeof value.repeatIntervalSeconds === 'number' && Number.isFinite(value.repeatIntervalSeconds)) {
    capture.repeatIntervalSeconds = value.repeatIntervalSeconds;
  }
  if (typeof value.loopSamples === 'number' && Number.isFinite(value.loopSamples)) {
    capture.loopSamples = value.loopSamples;
  }
  if (value.testMode === 0 || value.testMode === 1 || value.testMode === 2) capture.testMode = value.testMode;
  if (typeof value.triggerEnableMask === 'boolean') capture.triggerEnableMask = value.triggerEnableMask;
  capture.triggerModes = restoreTriggerModes(value.triggerModes, capacity);
  if (isRecord(value.analogTriggers)) {
    const restored: Record<string, { kind: 'rising' | 'falling'; volts: number }> = {};
    for (const [key, raw] of Object.entries(value.analogTriggers)) {
      const start = Number(key);
      if (!Number.isInteger(start) || start < 0 || start % 8 !== 0 || start + 8 > capacity) continue;
      if (!isRecord(raw)) continue;
      const kind = raw.kind === 'rising' || raw.kind === 'falling' ? raw.kind : null;
      const volts = typeof raw.volts === 'number' && Number.isFinite(raw.volts) ? raw.volts : null;
      if (kind === null || volts === null) continue;
      // The group's declared gain is restored with its bus view; the app re-snaps the
      // level to that gain's range (`clampCaptureSettings`). Here only the widest range
      // any declarable gain reads is enforced.
      restored[String(start)] = {
        kind, volts: Math.max(-ANALOG_MAX_HALF_RANGE_V, Math.min(ANALOG_MAX_HALF_RANGE_V, volts)),
      };
    }
    capture.analogTriggers = restored;
  }
  if (value.triggerSource === 'digital' || value.triggerSource === 'analog') {
    capture.triggerSource = value.triggerSource;
  }
  if (typeof value.preTriggerPercent === 'number' && Number.isFinite(value.preTriggerPercent)) {
    capture.preTriggerPercent = value.preTriggerPercent;
  }
  return capture;
}

function restoreBusConfig(value: unknown, capacity: number): BusViewConfig | null {
  if (!isRecord(value) || !isRecord(value.spec) || !Array.isArray(value.spec.bits)) return null;
  const defaults = defaultBusConfig(capacity);
  const bits = value.spec.bits;
  if (bits.some((channel) => !Number.isInteger(channel)) ||
      (value.spec.encoding !== undefined &&
        value.spec.encoding !== 'unsigned' && value.spec.encoding !== 'twos' && value.spec.encoding !== 'offset')) {
    return null;
  }
  let clock: BusViewConfig['spec']['clock'] = null;
  if (value.spec.clock !== undefined && value.spec.clock !== null) {
    if (!isRecord(value.spec.clock) || !Number.isInteger(value.spec.clock.channel) ||
        (value.spec.clock.edge !== 'rising' && value.spec.clock.edge !== 'falling')) return null;
    clock = { channel: value.spec.clock.channel as number, edge: value.spec.clock.edge };
  }
  if (value.fullScaleV !== undefined && value.fullScaleV !== null &&
      (typeof value.fullScaleV !== 'number' || !Number.isFinite(value.fullScaleV))) return null;
  if (value.offsetV !== undefined &&
      (typeof value.offsetV !== 'number' || !Number.isFinite(value.offsetV))) return null;
  if (value.style !== undefined && value.style !== 'line' && value.style !== 'step') return null;
  const analogGroup = value.analogGroup;
  // An analog row snaps to `ANALOG_HEIGHTS` (80..480 px); a generic bus keeps the Bus
  // panel's `BUS_HEIGHTS`. Both include every height older workspaces saved.
  const heights: readonly number[] = analogGroup !== undefined ? ANALOG_HEIGHTS : BUS_HEIGHTS;
  if (value.heightCss !== undefined &&
      (typeof value.heightCss !== 'number' || !heights.includes(value.heightCss))) {
    return null;
  }
  if (analogGroup !== undefined &&
      (typeof analogGroup !== 'number' || !Number.isInteger(analogGroup) ||
        analogGroup < 0 || analogGroup > 3)) {
    return null;
  }
  // A saved gain must be a declarable ratio; a missing one (older workspaces) is 1x.
  if (value.analogGain !== undefined && !isAnalogGain(value.analogGain)) return null;
  if (value.voltsPerDiv !== undefined && value.voltsPerDiv !== null &&
      (typeof value.voltsPerDiv !== 'number' || !Number.isFinite(value.voltsPerDiv) || value.voltsPerDiv <= 0)) {
    return null;
  }
  if (value.zeroPosition !== undefined &&
      (typeof value.zeroPosition !== 'number' || !Number.isFinite(value.zeroPosition) ||
        value.zeroPosition < 0 || value.zeroPosition > 1)) {
    return null;
  }
  const spec: BusViewConfig['spec'] = {
    bits: [...bits] as number[],
    clock,
    encoding: value.spec.encoding ?? 'unsigned',
  };
  if (validateBusSpec(spec, capacity).length > 0) return null;
  const color = typeof value.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.color)
    ? value.color : defaults.color;
  const fullScaleV = value.fullScaleV === undefined ? defaults.fullScaleV
    : value.fullScaleV === null || value.fullScaleV === 0 ? null : value.fullScaleV;
  // Snapshots written before the A/D switch have no order: treat them as Auto, which is
  // what their bus would mean under the current device rules.
  const bitOrder: BusBitOrder = value.bitOrder === 'msb' || value.bitOrder === 'lsb'
    ? value.bitOrder : 'auto';
  const config: BusViewConfig = {
    name: typeof value.name === 'string' ? value.name.trim() : defaults.name,
    bitOrder,
    color,
    fullScaleV,
    offsetV: value.offsetV ?? defaults.offsetV,
    style: value.style ?? defaults.style,
    heightCss: value.heightCss ?? defaults.heightCss,
    hideSources: typeof value.hideSources === 'boolean' ? value.hideSources : defaults.hideSources,
    spec,
    ...(value.voltsPerDiv !== undefined ? { voltsPerDiv: value.voltsPerDiv as number | null } : {}),
    ...(value.zeroPosition !== undefined ? { zeroPosition: value.zeroPosition as number } : {}),
  };
  const bank = busChannelBank(spec);
  if (bank === null) return config;
  if (typeof analogGroup === 'number') {
    // The marker is only valid on the bank it names; a mismatched one is ignored.
    if (analogGroup === bank / 8) {
      config.analogGroup = analogGroup;
      if (value.analogGain !== undefined) config.analogGain = value.analogGain as number;
      // The span is derived from the gain (1x when absent, as in older saves); a saved or
      // hand-edited span cannot disagree with the current scale.
      Object.assign(config, analogSpan(analogGainOf(config)));
    }
  } else if (/^A[0-3]$/.test(config.name) &&
             config.fullScaleV === LEGACY_ANALOG_FULL_SCALE_V &&
             config.offsetV === LEGACY_ANALOG_OFFSET_V) {
    // Legacy workspace: a full-bank bus predating the explicit marker used an A0-A3 name
    // and the ADC's old ±15 V span. Either alone is only a coincidence - a user may name an
    // ordinary bus "A0" or enter ±15 V as its scale - so both must agree before migrating.
    config.analogGroup = bank / 8;
    Object.assign(config, analogSpan());
  }
  if (value.usesDefaultName === true) config.usesDefaultName = true;
  return normalizeBankBusConfig(config, capacity, bank);
}

function restoreBusViews(value: unknown, capacity: number): BusViewConfig[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const config = restoreBusConfig(candidate, capacity);
    return config ? [config] : [];
  });
}

function restoreBankBusDrafts(value: unknown, capacity: number): Record<string, BusViewConfig> {
  const drafts: Record<string, BusViewConfig> = {};
  if (!isRecord(value)) return drafts;
  for (const [key, candidate] of Object.entries(value)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) continue;
    const start = Number(key);
    if (!Number.isSafeInteger(start) || start < 0 || start % 8 !== 0) continue;
    const config = restoreBusConfig(candidate, capacity);
    if (!config || busChannelBank(config.spec) !== start) continue;
    drafts[String(start)] = normalizeBankBusConfig(config, capacity, start);
  }
  return drafts;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value < max;
}

function restoreAnalyzerChannels(value: unknown, capacity: number): Record<number, number> | null {
  if (!isRecord(value)) return null;
  const channels: Record<number, number> = {};
  for (const [key, target] of Object.entries(value)) {
    if (!CANONICAL_INDEX_KEY.test(key)) return null;
    const channel = Number(key);
    if (!Number.isSafeInteger(channel) || channel >= MAX_DECODER_CHANNELS) return null;
    if (!isIntegerInRange(target, -1, capacity)) return null;
    channels[channel] = target;
  }
  return channels;
}

function restoreAnalyzerOptions(value: unknown): Record<string, string | number> {
  const options: Record<string, string | number> = {};
  if (!isRecord(value)) return options;
  for (const [key, option] of Object.entries(value)) {
    if (!ANALYZER_TOKEN.test(key)) continue;
    if (typeof option === 'string' || (typeof option === 'number' && Number.isFinite(option))) {
      options[key] = option;
    }
  }
  return options;
}

function restoreAnalyzerLabel(value: unknown, decoderId: string): string {
  if (typeof value !== 'string') return decoderId;
  return value.trim().slice(0, MAX_ANALYZER_LABEL_LENGTH) || decoderId;
}

function restoredLaneChannel(
  value: unknown, channels: Record<number, number>, capacity: number,
): number {
  if (isIntegerInRange(value, 0, capacity)) return value;
  return analyzerLaneChannel(channels);
}

function restoredAnalyzerId(value: unknown, decoderId: string, ids: ReadonlySet<string>): string {
  if (typeof value === 'string' && ANALYZER_ID.test(value) && !ids.has(value)) return value;
  let sequence = 0;
  while (ids.has(`${decoderId}-${sequence}`)) sequence++;
  return `${decoderId}-${sequence}`;
}

function restoreAnalyzers(value: unknown, capacity: number): PersistedAnalyzer[] {
  if (!Array.isArray(value)) return [];
  const analyzers: PersistedAnalyzer[] = [];
  const ids = new Set<string>();
  for (const candidate of value) {
    if (analyzers.length >= MAX_PERSISTED_ANALYZERS) break;
    if (!isRecord(candidate)) continue;
    const decoderId = candidate.decoderId;
    if (typeof decoderId !== 'string' || !ANALYZER_TOKEN.test(decoderId)) continue;
    const channels = restoreAnalyzerChannels(candidate.channels, capacity);
    if (channels === null) continue;
    const id = restoredAnalyzerId(candidate.id, decoderId, ids);
    ids.add(id);
    analyzers.push({
      id,
      decoderId,
      label: restoreAnalyzerLabel(candidate.label, decoderId),
      color: typeof candidate.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(candidate.color)
        ? candidate.color : analyzerColor(analyzers.length),
      channels,
      options: restoreAnalyzerOptions(candidate.options),
      laneChannel: restoredLaneChannel(candidate.laneChannel, channels, capacity),
    });
  }
  return analyzers;
}

export function parseWorkspaceSnapshot(
  raw: string | null, fallbackChannelCount: ChannelCount = 16,
): WorkspaceSnapshotV1 | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== WORKSPACE_SCHEMA_VERSION) return null;
  const channels = restoreChannels(parsed.channels, fallbackChannelCount);
  const busViews = restoreBusViews(parsed.busViews, channels.length);
  const bankBusDrafts = restoreBankBusDrafts(parsed.bankBusDrafts, channels.length);
  for (const bus of busViews) {
    const bank = busChannelBank(bus.spec);
    if (bank !== null) bankBusDrafts[String(bank)] = cloneBusConfig(bus);
  }
  const sidebar = restoreSidebar(parsed.sidebar);
  return {
    version: WORKSPACE_SCHEMA_VERSION,
    detailedLabels: typeof parsed.detailedLabels === 'boolean' ? parsed.detailedLabels : true,
    ...(parsed.wheelZooms === true ? { wheelZooms: true } : {}),
    ...(parsed.developerTools === true ? { developerTools: true } : {}),
    ...(parsed.compactRows === true ? { compactRows: true } : {}),
    ...(parsed.hideIdleChannels === true ? { hideIdleChannels: true } : {}),
    channels,
    order: restoreOrder(parsed.order, channels.length),
    capture: restoreCapture(parsed.capture, channels.length),
    busViews,
    bankBusDrafts,
    analyzers: restoreAnalyzers(parsed.analyzers, channels.length),
    ...(sidebar ? { sidebar } : {}),
  };
}

export function readWorkspaceSnapshot(fallbackChannelCount: ChannelCount = 16): WorkspaceSnapshotV1 | null {
  try {
    return parseWorkspaceSnapshot(storage()?.getItem(WORKSPACE_STORAGE_KEY) ?? null, fallbackChannelCount);
  } catch {
    return null;
  }
}

function serializeBusConfig(config: BusViewConfig): BusViewConfig {
  return cloneBusConfig(config);
}

function serializeSidebar(section: PersistedSidebar): PersistedSidebar | null {
  const page = parseSidebarPage(section.page) ?? 'capture';
  const hidden = section.visible === false;
  if (page === 'capture' && !hidden) return null;
  return { page, ...(hidden ? { visible: false } : {}) };
}

export function serializeWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): string {
  const serialized: WorkspaceSnapshotV1 = {
    version: WORKSPACE_SCHEMA_VERSION,
    detailedLabels: snapshot.detailedLabels,
  };
  if (snapshot.wheelZooms === true) serialized.wheelZooms = true;
  if (snapshot.developerTools === true) serialized.developerTools = true;
  if (snapshot.compactRows === true) serialized.compactRows = true;
  if (snapshot.hideIdleChannels === true) serialized.hideIdleChannels = true;
  if (snapshot.channels) {
    serialized.channels = snapshot.channels.map(({ name, color, enabled }) => ({ name, color, enabled }));
  }
  if (snapshot.order) serialized.order = [...snapshot.order];
  if (snapshot.capture) {
    const capture = snapshot.capture;
    serialized.capture = {
      samplerate: capture.samplerate,
      ...(capture.samplerateExplicit === true ? { samplerateExplicit: true } : {}),
      ...(capture.channels !== undefined ? { channels: capture.channels } : {}),
      ...(capture.widthExplicit === true ? { widthExplicit: true } : {}),
      thresholdVolts: capture.thresholdVolts,
      mode: capture.mode,
      seconds: capture.seconds,
      repeatIntervalSeconds: capture.repeatIntervalSeconds ?? defaultCaptureSettings().repeatIntervalSeconds,
      loopSamples: capture.loopSamples,
      analogTriggers: { ...(capture.analogTriggers ?? {}) },
      triggerSource: capture.triggerSource ?? 'digital',
      testMode: capture.testMode,
      triggerEnableMask: capture.triggerEnableMask,
      triggerModes: Object.fromEntries(Object.entries(capture.triggerModes)
        .sort(([a], [b]) => Number(a) - Number(b))),
      preTriggerPercent: capture.preTriggerPercent,
    };
  }
  if (snapshot.busViews) serialized.busViews = snapshot.busViews.map(serializeBusConfig);
  if (snapshot.bankBusDrafts) {
    serialized.bankBusDrafts = Object.fromEntries(Object.entries(snapshot.bankBusDrafts)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([start, config]) => [start, serializeBusConfig(config)]));
  }
  serialized.analyzers = (snapshot.analyzers ?? []).map((analyzer) => ({
    id: analyzer.id,
    decoderId: analyzer.decoderId,
    label: analyzer.label,
    color: analyzer.color,
    channels: Object.fromEntries(Object.entries(analyzer.channels)
      .sort(([a], [b]) => Number(a) - Number(b))),
    options: Object.fromEntries(Object.entries(analyzer.options)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    laneChannel: analyzer.laneChannel,
  }));
  const sidebar = snapshot.sidebar ? serializeSidebar(snapshot.sidebar) : null;
  if (sidebar) serialized.sidebar = sidebar;
  return JSON.stringify(serialized);
}

export function writeWorkspaceSnapshot(snapshot: WorkspaceSnapshotV1): boolean {
  try {
    const store = storage();
    if (store === null) return false;
    store.setItem(WORKSPACE_STORAGE_KEY, serializeWorkspaceSnapshot(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function analyzerStatesFrom(persisted: readonly PersistedAnalyzer[]): AnalyzerState[] {
  return persisted.map((analyzer) => ({
    id: analyzer.id,
    decoderId: analyzer.decoderId,
    label: analyzer.label,
    color: analyzer.color,
    channels: { ...analyzer.channels },
    options: { ...analyzer.options },
    laneChannel: analyzer.laneChannel,
    result: null,
    index: null,
    status: 'idle',
    note: { kind: 'pending' },
  }));
}

export function nextAnalyzerSequence(analyzers: readonly { id: string }[]): number {
  let next = 0;
  for (const { id } of analyzers) {
    const suffix = id.slice(id.lastIndexOf('-') + 1);
    if (!CANONICAL_INDEX_KEY.test(suffix)) continue;
    const sequence = Number(suffix);
    if (!Number.isSafeInteger(sequence)) continue;
    next = Math.max(next, sequence + 1);
  }
  return next;
}
