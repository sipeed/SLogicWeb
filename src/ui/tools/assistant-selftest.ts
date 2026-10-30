// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The AI assistant without a network, a browser or a model.
 *
 *   node_modules/.bin/esbuild src/ui/tools/assistant-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/assistant-selftest.mjs && node /tmp/assistant-selftest.mjs
 *
 * Covers: settings persistence (where the API key is and is not stored); the input
 * validator; every tool against the protocol fixture through a fake host; the loop's
 * approval, abort, refusal and truncation rules with a scripted provider; and both real
 * providers replaying recorded server-sent-event streams through an injected fetch.
 * When a hosted build is present in dist/, it also checks that no lazily loaded chunk
 * imports the entry asset (which would start a second App).
 */

import type { SampleStore } from '../../data/types.js';
import type { DecodeResult, DecoderInfo } from '../../decode/types.js';
import { Conversation, type LoopEvent } from '../../assistant/loop.js';
import { createClaudeProvider } from '../../assistant/providers/claude.js';
import { createOpenAIProvider } from '../../assistant/providers/openai.js';
import {
  activeProvider, getAssistantSettings, initAssistantSettings, KEYS_KEY, redactKey,
  setAssistantSettings, SETTINGS_KEY,
} from '../../assistant/settings.js';
import { SYSTEM_PROMPT } from '../../assistant/systemPrompt.js';
import {
  TOOLS, toolByName, toolSpecs, validate, type AssistantHost, type HostAnalyzer, type HostBus, type HostSnapshot,
} from '../../assistant/tools.js';
import { busSteps } from '../../data/busValue.js';
import type { BusViewConfig } from '../busView.js';
import type { Provider, ProviderConfig, ToolResult, TurnResult } from '../../assistant/types.js';
import { levelAt } from '../captureIO.js';
import { createProtocolFixture } from './protocolFixture.js';
import type { CaptureSettings } from '../state.js';

interface FsLike {
  readFileSync(path: string, enc: 'utf8'): string;
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike;

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

// ------------------------------------------------------------------ storage stubs

class MemStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}
const local = new MemStorage();
const session = new MemStorage();
Object.assign(globalThis, { localStorage: local, sessionStorage: session });

// ------------------------------------------------------------------ 1. settings
{
  initAssistantSettings();
  const s0 = getAssistantSettings();
  check('defaults: Claude, Opus 5.5, no key, notice not accepted',
    s0.provider === 'claude' && s0.claude.model === 'claude-opus-5-5' && s0.claude.apiKey === '' && !s0.noticeAccepted,
    JSON.stringify(s0));

  const KEY = 'sk-ant-test-0123456789';
  setAssistantSettings({ ...s0, claude: { ...s0.claude, apiKey: KEY } });
  check('without "remember" the key goes to sessionStorage only',
    (session.getItem(KEYS_KEY) ?? '').includes(KEY) && !(local.getItem(KEYS_KEY) ?? '').includes(KEY),
    `session=${session.getItem(KEYS_KEY)} local=${local.getItem(KEYS_KEY)}`);
  check('the settings record never holds a key',
    !(local.getItem(SETTINGS_KEY) ?? '').includes(KEY), local.getItem(SETTINGS_KEY) ?? '');

  setAssistantSettings({ ...getAssistantSettings(), rememberKey: true });
  check('"remember" moves the key to localStorage and clears the session copy',
    (local.getItem(KEYS_KEY) ?? '').includes(KEY) && session.getItem(KEYS_KEY) === null,
    `session=${session.getItem(KEYS_KEY)} local=${local.getItem(KEYS_KEY)}`);

  initAssistantSettings();
  check('a reload restores the remembered key', getAssistantSettings().claude.apiKey === KEY);

  setAssistantSettings({ ...getAssistantSettings(), rememberKey: false });
  session.map.clear();   // closing the tab
  initAssistantSettings();
  check('a forgotten key is gone after the session ends',
    getAssistantSettings().claude.apiKey === '' && !(local.getItem(KEYS_KEY) ?? '').includes(KEY));

  local.setItem(SETTINGS_KEY, '{"provider":42,"claude":"x","rememberKey":"yes"}');
  initAssistantSettings();
  const bad = getAssistantSettings();
  check('malformed saved settings fall back to defaults',
    bad.provider === 'claude' && bad.claude.model === 'claude-opus-5-5' && bad.rememberKey === false);

  const off = activeProvider({ ...bad, provider: 'openai', openai: { baseURL: 'https://api.deepseek.com/v1/', apiKey: 'k', model: 'm' } });
  check('custom Base URL loses its trailing slash and is not "official"',
    off.baseURL === 'https://api.deepseek.com/v1' && !off.official, JSON.stringify(off));
  check('empty Base URL means the official endpoint',
    activeProvider(bad).baseURL === 'https://api.anthropic.com' && activeProvider(bad).official);
  check('redactKey removes the key from error text',
    redactKey(`401: invalid x-api-key ${KEY}`, KEY) === '401: invalid x-api-key [api key]');
}

// ------------------------------------------------------------------ 2. validator
{
  const schema = toolByName('get_channel_stats')!.inputSchema;
  check('valid input passes', validate({ channels: [0, 6], start_s: 0 }, schema).length === 0);
  check('missing required field is reported', validate({}, schema).some((e) => e.includes('channels is required')));
  check('unknown field is reported', validate({ channels: [0], foo: 1 }, schema).some((e) => e.includes('foo')));
  check('wrong item type is reported', validate({ channels: ['D0'] }, schema).some((e) => e.includes('channels[0]')));
  check('minimum is enforced', validate({ channels: [0], start_s: -1 }, schema).length > 0);
  const set = toolByName('set_capture_settings')!.inputSchema;
  check('additionalProperties schemas validate map values',
    validate({ trigger_modes: { 0: 'rising' } }, set).length === 0 &&
    validate({ trigger_modes: { 0: 'sideways' } }, set).length > 0);
  check('enum is enforced', validate({ mode: 'single' }, set).length > 0);
  check('loop mode is accepted by the settings schema',
    validate({ mode: 'loop', loop_samples: 2048 }, set).length === 0);
  const attach = toolByName('attach_decoder')!.inputSchema;
  check('type unions accept either type',
    validate({ decoder: 'uart', channels: { rx: 6 }, options: { baudrate: 115200, parity: 'none' } }, attach).length === 0);
  check('every tool schema is a strict object',
    TOOLS.every((t) => t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false));
  check('act tools are exactly the ones that change the capture',
    TOOLS.filter((t) => t.risk === 'act').map((t) => t.name).sort().join(',') ===
    'add_bus_view,attach_decoder,remove_bus_view,remove_decoder,set_capture_settings,start_capture,stop_capture,update_bus_view');
}

// ------------------------------------------------------------------ 3. tools
const fixture = createProtocolFixture();
const UART = fixture.channelNames.findIndex((n) => /uart/i.test(n) && /rx/i.test(n));

function settings(): CaptureSettings {
  return {
    channels: 16, samplerate: 16e6, thresholdVolts: 1.2, mode: 'timer', seconds: 1, loopSamples: 16_000_000,
    testMode: 0,
    triggerEnableMask: false, softwareTrigger: false, triggerModes: { 2: 'high' }, triggerConditions: [],
    triggerChannel: 0, triggerKind: 'rising', triggerLevel: 1, preTriggerPercent: 10,
  };
}

class FakeHost implements AssistantHost {
  store_: SampleStore = fixture.store;
  connected = false;
  running = false;
  analyzers_: HostAnalyzer[] = [];
  applied: { patch: Partial<CaptureSettings>; enabled?: number[] }[] = [];
  attached: { id: string; channels: Record<number, number>; options: Record<string, string | number> }[] = [];
  view = { start: 0, end: 0 };
  s = settings();
  snapshot(): HostSnapshot {
    return {
      connected: this.connected, device: this.connected ? 'SLogic32 U3' : null, running: this.running,
      stopping: false, error: '', label: 'fixture', samples: this.store_.length, dropped: 0,
      samplerate: this.store_.samplerate, channelCount: this.store_.channelCount, triggerState: 'off',
      triggerSampleIndex: null, settings: this.s, rateCeilings: { 16: 400e6, 32: 200e6 },
      enabledChannels: [0, 1, 2], channelNames: Array.from({ length: 32 }, (_, i) => fixture.channelNames[i] ?? `D${i}`),
      view: this.view, decoderReady: true,
    };
  }
  store(): SampleStore { return this.store_; }
  analyzers(): readonly HostAnalyzer[] { return this.analyzers_; }
  applySettings(patch: Partial<CaptureSettings>, enabled?: number[]): void {
    this.applied.push({ patch, ...(enabled ? { enabled } : {}) });
    this.s = { ...this.s, ...patch, samplerate: Math.min(patch.samplerate ?? this.s.samplerate, 400e6) };
  }
  async startAndWait(): Promise<'finished'> { return 'finished'; }
  async stop(): Promise<void> { this.running = false; }
  async attach(id: string, channels: Record<number, number>, options: Record<string, string | number>): Promise<void> {
    this.attached.push({ id, channels, options });
    this.analyzers_.push({ decoderId: id, channels, options, status: 'done', note: '', result: null });
  }
  removeAnalyzer(i: number): boolean { this.analyzers_.splice(i, 1); return true; }
  setViewportSeconds(a: number, b: number): void { this.view = { start: a * 16e6, end: b * 16e6 }; }
  zoomToAnnotation(): boolean { return true; }
  levelAt(ch: number, sample: number): 0 | 1 { return levelAt(this.store_, ch, sample); }
  buses_: HostBus[] = [];
  buses(): readonly HostBus[] { return this.buses_; }
  addBus(cfg: BusViewConfig): void { this.buses_.push({ config: cfg, built: true }); }
  updateBus(i: number, cfg: BusViewConfig): void { this.buses_[i] = { config: cfg, built: true }; }
  removeBus(i: number): void { this.buses_.splice(i, 1); }
}

async function run(name: string, input: Record<string, unknown>, host: AssistantHost): Promise<{ ok: boolean; out: unknown; err: string }> {
  try {
    return { ok: true, out: await toolByName(name)!.run(input, host, new AbortController().signal), err: '' };
  } catch (e) {
    return { ok: false, out: null, err: e instanceof Error ? e.message : String(e) };
  }
}

{
  const host = new FakeHost();
  check('the fixture has a UART RX channel', UART >= 0, fixture.channelNames.join(', '));

  const st = await run('get_state', {}, host);
  const state = st.out as Record<string, unknown>;
  check('get_state reports the capture and limits',
    st.ok && (state.capture as { samplerate_hz: number }).samplerate_hz === 16e6 &&
    JSON.stringify(state.max_samplerate_hz_by_width) === '{"16":400000000,"32":200000000}', JSON.stringify(state).slice(0, 300));

  const stats = await run('get_channel_stats', { channels: [UART] }, host);
  const ch = ((stats.out as { channels: Record<string, unknown>[] }).channels)[0]!;
  const low = ch.low_pulse_s as { min: number };
  const baud = 1 / low.min;
  check('UART stats: shortest low pulse is one 115200-baud bit',
    stats.ok && Math.abs(baud - 115200) / 115200 < 0.02, `min low ${low?.min} s -> ${baud.toFixed(0)} baud`);
  check('UART line idles high', ch.initial_level === 1 && ch.final_level === 1, JSON.stringify(ch));

  // SPI CS# (5) sits high until the SPI burst at sample 7000 (0.4375 ms).
  const quiet = await run('get_channel_stats', { channels: [5], end_s: 0.0004 }, host);
  const q = quiet.ok ? (quiet.out as { channels: Record<string, unknown>[] }).channels[0]! : {};
  check('a quiet window reports a constant level and no pulses',
    q.edges === 0 && q.constant_level === 1, `${quiet.err} ${JSON.stringify(q)}`);

  const edges = await run('get_edges', { channel: UART, limit: 5 }, host);
  const e = edges.out as { returned: number; truncated?: boolean; edges: { t_s: number; to: number }[]; edges_in_range: number };
  check('get_edges caps at limit and says so',
    edges.ok && e.returned === 5 && e.truncated === true && e.edges_in_range > 5, JSON.stringify(e).slice(0, 200));
  check('first UART edge is the falling start bit at 0.5 ms',
    e.edges[0]?.to === 0 && Math.abs(e.edges[0].t_s - 8000 / 16e6) < 1e-9, JSON.stringify(e.edges[0]));

  const outside = await run('get_edges', { channel: UART, start_s: 5, end_s: 6 }, host);
  check('a range past the end of the capture is an error', !outside.ok && /empty|outside/.test(outside.err), outside.err);
  const noCh = await run('get_channel_stats', { channels: [99] }, host);
  check('an out-of-range channel is an error', !noCh.ok && noCh.err.includes('D0-D'), noCh.err);

  const empty = new FakeHost();
  empty.store_ = { ...fixture.store, length: 0 } as SampleStore;
  const none = await run('get_channel_stats', { channels: [0] }, empty);
  check('no capture yet is explained', !none.ok && /no capture/i.test(none.err), none.err);

  const dec = await run('list_decoders', { query: 'uart' }, host);
  check('list_decoders finds uart', dec.ok && (dec.out as { decoders: { id: string }[] }).decoders.some((d) => d.id === 'uart'));
  const desc = await run('describe_decoder', { id: 'uart' }, host);
  const d = desc.out as { channels: { id: string; required: boolean }[]; options: { id: string }[] };
  check('describe_decoder lists channel ids and options',
    desc.ok && d.channels.some((c) => c.id === 'rx') && d.options.some((o) => o.id === 'baudrate'), JSON.stringify(d).slice(0, 200));

  const att = await run('attach_decoder', { decoder: 'uart', channels: { rx: UART }, options: { baudrate: 115200 } }, host);
  const rxIndex = d.channels.findIndex((c) => c.id === 'rx');
  check('attach_decoder maps channel ids to decoder indices',
    att.ok && host.attached[0]?.channels[rxIndex] === UART && host.attached[0]?.options.baudrate === 115200,
    `${att.err} ${JSON.stringify(host.attached)}`);
  const badCh = await run('attach_decoder', { decoder: 'uart', channels: { data: 1 } }, host);
  check('attach_decoder names the real channel ids on a typo', !badCh.ok && badCh.err.includes('rx'), badCh.err);
  const badOpt = await run('attach_decoder', { decoder: 'uart', channels: { rx: UART }, options: { parity: 'purple' } }, host);
  check('attach_decoder rejects a value outside the option list', !badOpt.ok && /one of/.test(badOpt.err), badOpt.err);
  const i2c = await run('attach_decoder', { decoder: 'i2c', channels: { scl: 0 } }, host);
  check('attach_decoder requires every required channel', !i2c.ok && i2c.err.includes('sda'), i2c.err);

  const set = await run('set_capture_settings', {
    samplerate_hz: 800e6, mode: 'free', trigger_enabled: true, trigger_modes: { 0: 'rising', 2: 'dont-care' },
    enabled_channels: [0, 1, 2, 3],
  }, host);
  const last = host.applied[host.applied.length - 1]!;
  const setLoop = await run('set_capture_settings', { mode: 'loop', loop_samples: 2_000_000 }, host);
  const lastLoop = host.applied[host.applied.length - 1]!;
  check('set_capture_settings maps loop fields',
    setLoop.ok && lastLoop.patch.mode === 'loop' && lastLoop.patch.loopSamples === 2_000_000,
    JSON.stringify(lastLoop.patch));
  check('set_capture_settings maps fields and clears dont-care channels',
    set.ok && last.patch.mode === 'free' && last.patch.triggerEnableMask === true &&
    JSON.stringify(last.patch.triggerModes) === '{"0":"rising"}' && last.enabled?.length === 4,
    JSON.stringify(last));
  check('set_capture_settings reports a clamped samplerate',
    /clamped to 400000000/.test(String((set.out as { note?: string }).note)), JSON.stringify(set.out));
  const badChan = await run('set_capture_settings', { enabled_channels: [40] }, host);
  check('set_capture_settings rejects channels the device lacks', !badChan.ok, badChan.err);
  const setDescription = toolByName('set_capture_settings')?.description ?? '';
  check('the assistant describes an explicit width tier and a display-only mask',
    SYSTEM_PROMPT.includes('8CH, 16CH or 32CH') && setDescription.includes('8CH/16CH/32CH') &&
    setDescription.includes('only masks the display') &&
    !SYSTEM_PROMPT.includes('highest enabled channel') && !setDescription.includes('highest enabled channel'),
    `promptTier=${SYSTEM_PROMPT.includes('8CH, 16CH or 32CH')}, ` +
    `toolTier=${setDescription.includes('8CH/16CH/32CH')}`);
  host.running = true;
  const busy = await run('set_capture_settings', { mode: 'timer' }, host);
  check('settings cannot change mid-capture', !busy.ok && /running/.test(busy.err), busy.err);
  host.running = false;

  const start = await run('start_capture', {}, host);
  check('start_capture without a device tells the model the user must click Connect',
    !start.ok && /click the Connect button/.test(start.err), start.err);
  host.connected = true;
  const started = await run('start_capture', { timeout_s: 1 }, host);
  check('start_capture with a device waits and reports', started.ok && (started.out as { finished: boolean }).finished === true);

  // A two-annotation result, laid out like DecodeClient's.
  const result: DecodeResult = {
    annotations: {
      count: 2, start: Int32Array.from([8000, 9500]), end: Int32Array.from([9400, 10900]),
      inst: Uint16Array.from([0, 0]), cls: Uint16Array.from([0, 0]),
      textOffset: Int32Array.from([0, 2, 4]), texts: ['O', '4F', 'K', '4B'],
    },
    instances: [{ annotations: [{ id: 'rx-data', desc: 'RX data' }] } as unknown as DecoderInfo],
    errors: [], decodeMs: 1,
  };
  host.analyzers_ = [{ decoderId: 'uart', channels: {}, options: {}, status: 'done', note: '', result }];
  const anns = await run('get_annotations', { analyzer: 0, limit: 1 }, host);
  const a = anns.out as { in_range: number; truncated?: boolean; annotations: { class: string; text: string; start_s: number }[] };
  check('get_annotations returns class, text and times, capped',
    anns.ok && a.in_range === 2 && a.truncated === true && a.annotations[0]?.class === 'rx-data' &&
    a.annotations[0]?.text === 'O' && a.annotations[0]?.start_s === 0.0005, JSON.stringify(a));
  const missing = await run('get_annotations', { analyzer: 3 }, host);
  check('a missing analyzer index is explained', !missing.ok && /no analyzer 3/i.test(missing.err), missing.err);

  const view = await run('set_viewport', { start_s: 0.0005, end_s: 0.001 }, host);
  check('set_viewport moves the view', view.ok && host.view.start === 8000 && host.view.end === 16000, JSON.stringify(host.view));
}

// ------------------------------------------------------------------ 3b. bus views and durations
{
  const set = toolByName('set_capture_settings')!.inputSchema;
  check('a 1 ms timer capture is accepted, below that is not',
    validate({ seconds: 0.001 }, set).length === 0 && validate({ seconds: 0.0005 }, set).length > 0);
  check('the duration description tells the model the 1 ms minimum',
    String((set.properties as Record<string, { description?: string }>).seconds?.description).includes('0.001 s'));

  const host = new FakeHost();   // the 8-channel protocol fixture
  const added = await run('add_bus_view', { name: 'ADC', start_channel: 2, width: 4, msb_first: true, clock_channel: 7, encoding: 'twos' }, host);
  const b0 = host.buses_[0]?.config;
  check('add_bus_view: start + width + msb_first become bits LSB first',
    added.ok && JSON.stringify(b0?.spec.bits) === '[5,4,3,2]' && b0?.spec.clock?.channel === 7 &&
    b0?.spec.clock?.edge === 'rising' && b0?.spec.encoding === 'twos', `${added.err} ${JSON.stringify(b0?.spec)}`);
  const past = await run('add_bus_view', { start_channel: 6, width: 4 }, host);
  check('add_bus_view refuses a run past the last channel', !past.ok && /runs past D7/.test(past.err), past.err);
  const narrow = new FakeHost();
  narrow.s = { ...narrow.s, channels: 4 };
  const narrowBus = await run('add_bus_view', { start_channel: 5, width: 3 }, narrow);
  check('add_bus_view follows the selected width, not just the capture data',
    !narrowBus.ok && /runs past D3/.test(narrowBus.err), narrowBus.err);
  const narrowBase = await run('add_bus_view', { start_channel: 0, width: 4 }, narrow);
  const narrowClock = await run('update_bus_view', { index: 0, clock_channel: 5 }, narrow);
  check('update_bus_view cannot reach past the selected width either',
    narrowBase.ok && !narrowClock.ok && /channel 5 is not in D0-D3/.test(narrowClock.err),
    `${narrowBase.err} ${narrowClock.err}`);
  const none = await run('add_bus_view', { name: 'x' }, host);
  check('add_bus_view needs channels', !none.ok && /start_channel/.test(none.err), none.err);
  const clash = await run('add_bus_view', { bits: [0, 1], clock_channel: 1 }, host);
  check('add_bus_view refuses a channel used twice', !clash.ok && /twice/.test(clash.err), clash.err);

  const upd = await run('update_bus_view', { index: 0, clock_channel: null, encoding: 'unsigned', full_scale_v: 3.3 }, host);
  const b1 = host.buses_[0]?.config;
  check('update_bus_view changes only the fields given',
    upd.ok && b1?.spec.clock === null && b1.spec.encoding === 'unsigned' && b1.fullScaleV === 3.3 &&
    JSON.stringify(b1.spec.bits) === '[5,4,3,2]' && b1.name === 'ADC', `${upd.err} ${JSON.stringify(b1)}`);
  const flip = await run('update_bus_view', { index: 0, msb_first: false }, host);
  check('update_bus_view: msb_first flips the order over the same channels',
    flip.ok && JSON.stringify(host.buses_[0]?.config.spec.bits) === '[2,3,4,5]', JSON.stringify(host.buses_[0]?.config.spec.bits));

  const st = await run('get_state', {}, host);
  const views = (st.out as { bus_views: { summary: string; full_scale_v: number }[] }).bus_views;
  check('get_state lists the bus views', views.length === 1 && views[0]!.summary === 'D2–D5' && views[0]!.full_scale_v === 3.3, JSON.stringify(views));

  await run('add_bus_view', { name: 'UART pair', bits: [6, 7] }, host);
  const vals = await run('get_bus_values', { bus: 1, limit: 5 }, host);
  const v = vals.out as { values: { t_s: number; value: number | null }[]; min: number; max: number; truncated?: boolean; changes_in_range: number };
  const ref = busSteps(fixture.store, { bits: [6, 7], clock: null, encoding: 'unsigned' }, 0, fixture.store.length);
  let mn = Infinity; let mx = -Infinity;
  for (let k = 0; k < ref.count; k++) { mn = Math.min(mn, ref.val[k]!); mx = Math.max(mx, ref.val[k]!); }
  check('get_bus_values matches busSteps, capped, with min and max',
    vals.ok && v.values.length === 5 && v.truncated === true && v.changes_in_range === ref.count &&
    v.values.every((x, k) => x.value === ref.val[k] && x.t_s === Number((ref.pos[k]! / fixture.store.samplerate).toPrecision(6))) &&
    v.min === mn && v.max === mx, `${vals.err} ${JSON.stringify(v).slice(0, 300)}`);
  const volt = await run('get_bus_values', { bus: 0, limit: 3 }, host);
  const vv = volt.out as { values: { volts?: string }[]; max: string };
  check('get_bus_values reports volts when a full scale is set',
    volt.ok && typeof vv.max === 'string' && / V$|mV$/.test(vv.max) && typeof vv.values[0]?.volts === 'string', JSON.stringify(vv).slice(0, 200));
  const gone = await run('remove_bus_view', { index: 0 }, host);
  check('remove_bus_view removes it', gone.ok && host.buses_.length === 1 && host.buses_[0]!.config.name === 'UART pair');
  const missing = await run('get_bus_values', { bus: 9 }, host);
  check('an unknown bus index is explained', !missing.ok && /No bus view 9/.test(missing.err), missing.err);
}

// ------------------------------------------------------------------ 4. loop

class ScriptedProvider implements Provider {
  turns: TurnResult[];
  user: string[] = [];
  answered: ToolResult[][] = [];
  constructor(turns: TurnResult[]) { this.turns = turns; }
  addUserText(t: string): void { this.user.push(t); }
  async runTurn(h: { onText(d: string): void }): Promise<TurnResult> {
    const t = this.turns.shift();
    if (!t) throw new Error('script exhausted');
    if (t.text) h.onText(t.text);
    return t;
  }
  addToolResults(r: ToolResult[]): void { this.answered.push(r); }
  describeError(e: unknown) { return { kind: 'other' as const, message: String(e) }; }
}

async function converse(provider: Provider, approve: boolean | 'abort', host = new FakeHost()) {
  const events: LoopEvent[] = [];
  const abort = new AbortController();
  let asked = 0;
  const conv = new Conversation(provider, host, async () => {
    asked++;
    if (approve === 'abort') { abort.abort(); return false; }
    return approve;
  }, (e) => events.push(e));
  await conv.send('hello', abort.signal);
  return { events, asked, host };
}

{
  const p = new ScriptedProvider([
    { stop: 'tool_use', text: 'Looking.', toolCalls: [
      { id: 'a', name: 'get_state', input: {} },
      { id: 'b', name: 'set_capture_settings', input: { mode: 'free' } },
      { id: 'c', name: 'get_edges', input: { channel: 'zero' } },
      { id: 'd', name: 'no_such_tool', input: {} },
    ] },
    { stop: 'end', text: 'Done.', toolCalls: [] },
  ]);
  const { events, asked, host } = await converse(p, false);
  const batch = p.answered[0] ?? [];
  check('every tool call of a turn is answered, in one batch, in order',
    p.answered.length === 1 && batch.map((r) => r.id).join('') === 'abcd', JSON.stringify(batch.map((r) => r.id)));
  check('read tools run without asking', !batch[0]!.isError && asked === 1);
  check('a declined act tool does not run and tells the model',
    batch[1]!.isError && /declined/.test(batch[1]!.content) && host.applied.length === 0, batch[1]!.content);
  check('invalid input is rejected before the tool runs', batch[2]!.isError && /Invalid input/.test(batch[2]!.content), batch[2]!.content);
  check('an unknown tool lists the real ones', batch[3]!.isError && batch[3]!.content.includes('get_state'));
  check('the loop ends on the final answer',
    events[events.length - 1]?.type === 'stopped' && (events[events.length - 1] as { reason: string }).reason === 'end');
  check('declined is distinguished from failed in the events',
    events.some((e) => e.type === 'tool-result' && e.id === 'b' && e.declined) &&
    events.some((e) => e.type === 'tool-result' && e.id === 'c' && !e.declined && e.isError));
}
{
  const p = new ScriptedProvider([
    { stop: 'tool_use', text: '', toolCalls: [{ id: 'x', name: 'set_capture_settings', input: { mode: 'free' } }] },
    { stop: 'end', text: 'ok', toolCalls: [] },
  ]);
  const { host } = await converse(p, true);
  check('an approved act tool runs', host.applied.length === 1 && host.applied[0]!.patch.mode === 'free');
}
{
  const p = new ScriptedProvider([
    { stop: 'tool_use', text: '', toolCalls: [
      { id: 'x', name: 'set_capture_settings', input: { mode: 'free' } },
      { id: 'y', name: 'get_state', input: {} },
    ] },
    { stop: 'end', text: 'never', toolCalls: [] },
  ]);
  const { events, host } = await converse(p, 'abort');
  check('aborting during an approval answers every call as cancelled and stops',
    p.answered[0]?.length === 2 && p.answered[0].every((r) => r.isError && /Cancelled/.test(r.content)) &&
    host.applied.length === 0 && p.turns.length === 1 &&
    events.some((e) => e.type === 'stopped' && e.reason === 'aborted'), JSON.stringify(p.answered));
}
{
  const p = new ScriptedProvider([
    { stop: 'refusal', text: '', toolCalls: [], detail: 'cyber' },
  ]);
  const { events } = await converse(p, true);
  check('a refusal stops with its detail and no tool runs',
    events.some((e) => e.type === 'stopped' && e.reason === 'refusal' && e.detail === 'cyber') && p.answered.length === 0);
}
{
  const p = new ScriptedProvider([{ stop: 'max_tokens', text: 'cut', toolCalls: [] }]);
  const { events } = await converse(p, true);
  check('max_tokens stops the loop', events.some((e) => e.type === 'stopped' && e.reason === 'max_tokens'));
}
{
  const forever = Array.from({ length: 30 }, (_, i): TurnResult =>
    ({ stop: 'tool_use', text: '', toolCalls: [{ id: `t${i}`, name: 'get_state', input: {} }] }));
  const p = new ScriptedProvider(forever);
  const { events } = await converse(p, true);
  check('the loop gives up after MAX_TURNS', events.some((e) => e.type === 'stopped' && e.reason === 'max_turns'));
}
{
  const p = new ScriptedProvider([]);
  const { events } = await converse(p, true);
  check('a provider error becomes an error event, not a throw', events.some((e) => e.type === 'error'));
}

// ------------------------------------------------------------------ 5. providers over recorded streams

function sse(lines: string[]): Response {
  const body = lines.map((l) => `${l}\n\n`).join('');
  return new Response(new ReadableStream({
    start(c) {
      // Split mid-line to exercise the parser's buffering.
      const bytes = new TextEncoder().encode(body);
      for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37));
      c.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  apiKey: 'sk-test-key-123456', baseURL: 'https://relay.example.com', model: 'claude-opus-5-5', official: false,
  system: SYSTEM_PROMPT, tools: toolSpecs(), ...over,
});
const handlers = (sink: { text: string; thinking: string }) => ({
  onText: (d: string) => { sink.text += d; }, onThinking: (d: string) => { sink.thinking += d; },
});

{
  // OpenAI-compatible: reasoning, text and one tool call whose arguments arrive in pieces.
  const requests: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const replies: Response[] = [
    sse([
      'data: {"choices":[{"delta":{"reasoning_content":"Check state."}}]}',
      'data: {"choices":[{"delta":{"content":"Let me look."}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_channel_stats","arguments":"{\\"chan"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nels\\":[6]}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ]),
    sse(['data: {"choices":[{"delta":{"content":"115200 baud."},"finish_reason":"stop"}]}', 'data: [DONE]']),
    new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }),
  ];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, auth: String((init.headers as Record<string, string>).Authorization) });
    return replies.shift()!;
  }) as unknown as typeof fetch;
  const p = createOpenAIProvider(cfg({ baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }), fakeFetch);
  const sink = { text: '', thinking: '' };
  p.addUserText('baud?');
  const t1 = await p.runTurn(handlers(sink), new AbortController().signal);
  check('openai: tool call reassembled from fragments',
    t1.stop === 'tool_use' && t1.toolCalls[0]?.id === 'call_1' && JSON.stringify(t1.toolCalls[0]?.input) === '{"channels":[6]}',
    JSON.stringify(t1));
  check('openai: text and reasoning stream to their handlers', sink.text === 'Let me look.' && sink.thinking === 'Check state.');
  check('openai: request shape (endpoint, bearer key, tools, stream)',
    requests[0]!.url === 'https://api.deepseek.com/v1/chat/completions' && requests[0]!.auth === 'Bearer sk-test-key-123456' &&
    requests[0]!.body.stream === true && (requests[0]!.body.tools as unknown[]).length === TOOLS.length &&
    (requests[0]!.body.messages as { role: string }[])[0]!.role === 'system');
  p.addToolResults([{ id: 'call_1', content: '{"ok":1}', isError: false }]);
  const t2 = await p.runTurn(handlers(sink), new AbortController().signal);
  const msgs = requests[1]!.body.messages as { role: string; tool_calls?: unknown[]; tool_call_id?: string }[];
  check('openai: history carries the assistant tool call and its tool result',
    msgs.map((m) => m.role).join(',') === 'system,user,assistant,tool' && msgs[2]!.tool_calls?.length === 1 &&
    msgs[3]!.tool_call_id === 'call_1' && t2.stop === 'end', msgs.map((m) => m.role).join(','));
  let err: unknown = null;
  try { await p.runTurn(handlers(sink), new AbortController().signal); } catch (e) { err = e; }
  const de = p.describeError(err);
  check('openai: 401 is an auth error with the server message', de.kind === 'auth' && de.status === 401 && /Incorrect API key/.test(de.message), JSON.stringify(de));
  check('openai: a fetch TypeError (DNS/TLS/CORS) is a network error', p.describeError(new TypeError('Failed to fetch')).kind === 'network');

  const filtered = createOpenAIProvider(cfg(), (async () => sse([
    'data: {"choices":[{"delta":{"content":"no"},"finish_reason":"content_filter"}]}',
  ])) as unknown as typeof fetch);
  filtered.addUserText('x');
  const tf = await filtered.runTurn(handlers({ text: '', thinking: '' }), new AbortController().signal);
  check('openai: content_filter is a refusal', tf.stop === 'refusal');
}

{
  // Claude through the real SDK, with fetch injected via a patched global.
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const replies: Response[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) as Record<string, unknown> });
    return replies.shift() ?? new Response('{}', { status: 500 });
  }) as typeof fetch;

  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;
  const message = (stop: string, blocks: string[]) => sse([
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    ...blocks,
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }),
    ev('message_stop', {}),
  ]);
  const textBlock = (i: number, text: string) => [
    ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } }),
    ev('content_block_delta', { index: i, delta: { type: 'text_delta', text } }),
    ev('content_block_stop', { index: i }),
  ];
  const toolBlock = (i: number, id: string, name: string, json: string) => [
    ev('content_block_start', { index: i, content_block: { type: 'tool_use', id, name, input: {} } }),
    ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: json } }),
    ev('content_block_stop', { index: i }),
  ];

  try {
    replies.push(message('tool_use', [...textBlock(0, 'Checking.'), ...toolBlock(1, 'toolu_1', 'get_channel_stats', '{"channels":[6]}')]));
    replies.push(message('refusal', [...textBlock(0, 'I can')]));
    replies.push(message('end_turn', [...textBlock(0, 'Fine.')]));
    const p = createClaudeProvider(cfg({ official: false }));
    const sink = { text: '', thinking: '' };
    p.addUserText('baud?');
    const t1 = await p.runTurn(handlers(sink), new AbortController().signal);
    const body = seen[0]!.body;
    check('claude: tool_use parsed into a tool call',
      t1.stop === 'tool_use' && t1.toolCalls[0]?.id === 'toolu_1' && JSON.stringify(t1.toolCalls[0]?.input) === '{"channels":[6]}',
      JSON.stringify(t1));
    check('claude: request uses the relay URL, the key and the chosen model',
      seen[0]!.url.startsWith('https://relay.example.com/v1/messages') &&
      // SDK 1.x sends the API key as a bearer token (client.js apiKeyAuth), not x-api-key.
      seen[0]!.headers.get('authorization') === 'Bearer sk-test-key-123456' &&
      body.model === 'claude-opus-5-5', `${seen[0]!.url} key=${seen[0]!.headers.get('x-api-key')} auth=${seen[0]!.headers.get('authorization')} model=${String(body.model)}`);
    check('claude: adaptive thinking with summaries, explicit effort, prompt caching',
      JSON.stringify(body.thinking) === '{"type":"adaptive","display":"summarized"}' &&
      JSON.stringify(body.output_config) === '{"effort":"medium"}' &&
      JSON.stringify(body.cache_control) === '{"type":"ephemeral"}', JSON.stringify({ t: body.thinking, o: body.output_config, c: body.cache_control }));
    check('claude: every tool streams its input eagerly',
      (body.tools as { eager_input_streaming?: boolean }[]).every((t) => t.eager_input_streaming === true));
    check('claude: no fallback parameter or beta header on a relay',
      !('fallbacks' in body) && !(seen[0]!.headers.get('anthropic-beta') ?? '').includes('server-side-fallback'));
    check('claude: the browser opt-in header is sent',
      seen[0]!.headers.get('anthropic-dangerous-direct-browser-access') === 'true');

    p.addToolResults([{ id: 'toolu_1', content: '{"x":1}', isError: false }]);
    const t2 = await p.runTurn(handlers(sink), new AbortController().signal);
    check('claude: a refusal is reported and not appended', t2.stop === 'refusal');
    p.addUserText('again');
    await p.runTurn(handlers(sink), new AbortController().signal);
    const history = seen[2]!.body.messages as { role: string; content: unknown }[];
    check('claude: history is user, assistant(tool_use), user(tool_result), user - the refused turn left out',
      history.map((m) => m.role).join(',') === 'user,assistant,user,user' &&
      JSON.stringify(history[2]!.content).includes('"tool_use_id":"toolu_1"'), history.map((m) => m.role).join(','));

    replies.push(message('end_turn', [...textBlock(0, 'ok')]));
    const official = createClaudeProvider(cfg({ official: true, baseURL: 'https://api.anthropic.com' }));
    official.addUserText('hi');
    await official.runTurn(handlers(sink), new AbortController().signal);
    const ob = seen[3]!;
    check('claude: the official endpoint opts into server-side fallbacks',
      ob.body.fallbacks === 'default' && (ob.headers.get('anthropic-beta') ?? '').includes('server-side-fallback-2026-07-01'),
      `${String(ob.body.fallbacks)} ${ob.headers.get('anthropic-beta')}`);

    replies.push(new Response('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', { status: 401, headers: { 'content-type': 'application/json' } }));
    let err: unknown = null;
    const bad = createClaudeProvider(cfg());
    bad.addUserText('hi');
    try { await bad.runTurn(handlers(sink), new AbortController().signal); } catch (e) { err = e; }
    check('claude: 401 is an auth error', bad.describeError(err).kind === 'auth', JSON.stringify(bad.describeError(err)));
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ------------------------------------------------------------------ 6. wiring and the built chunks
{
  const main = fs.readFileSync('src/ui/main.ts', 'utf8');
  const init = main.indexOf('initAssistantSettings();');
  check('main.ts restores assistant settings before constructing App',
    init !== -1 && init < main.indexOf('new App()'));
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  check('the assistant opens from both the sidebar menu and its own toolbar button',
    app.includes("t('toolbar.sidebarAssistant')") && fs.readFileSync('index.html', 'utf8').includes('id="btn-assistant"'));
  const claude = fs.readFileSync('src/assistant/providers/claude.ts', 'utf8');
  const runtimeImports = [...claude.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  check('the lazy Claude provider imports nothing at runtime but the SDK',
    runtimeImports.join(',') === '@anthropic-ai/sdk', runtimeImports.join(','));

  const root = fs.existsSync('dist') ? fs.readdirSync('dist') : [];
  const lazy = root.filter((f) => /^(claude|node\.browser|preload-helper)-.*\.js$/.test(f));
  if (lazy.length === 0) {
    console.log('SKIP  built-chunk check: no hosted build in dist/ (run `npx vite build --base=/` first)');
  } else {
    const offenders = lazy.filter((f) => /["']\.\/assets\/index-[^"']+\.js["']/.test(fs.readFileSync(`dist/${f}`, 'utf8')));
    check('no lazily loaded chunk imports the entry asset (a second App would start)',
      offenders.length === 0, `checked ${lazy.join(', ')}; offenders: ${offenders.join(', ') || 'none'}`);
    const helper = lazy.find((f) => f.startsWith('preload-helper-'));
    check('the preload helper chunk imports nothing',
      !!helper && !/\bimport\b|\bfrom\s*["']/.test(fs.readFileSync(`dist/${helper}`, 'utf8').replace(/\/\/# sourceMappingURL.*$/m, '')), helper ?? 'missing');
  }
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `\n        ${r.detail}`}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
