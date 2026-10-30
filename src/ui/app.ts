// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The application: state, wiring and the frame loop.
 *
 * This is the only file that knows about all four modules at once. It talks to them
 * through their published interfaces and nothing else - no WebUSB call, no GL call, no
 * Pyodide, no direct access to another module's internals - which is what
 * docs/ARCHITECTURE.md asks of `src/ui`.
 */

import {
  appendLostSamples, createSampleStore, MAX_SOFTWARE_TRIGGER_PREFIX_BYTES,
} from '../data/index.js';
import type { SampleStore } from '../data/types.js';
import { bytesPerSampleForChannels, channelWidthForProbes, isChannelCount, type ChannelCount } from '../types.js';
import {
  MAX_SAMPLERATE_HZ, TransportDeadError, getGrantedDevicesOnBestThread, requestDeviceOnBestThread,
  vrefCode, type CaptureConfig, type Device,
} from '../device/index.js';
import { WorkerSlogicDevice, workerTransport } from '../device/workerTransport.js';
import { WheelIntent, wheelSpanFactor } from '../render/index.js';
import {
  AnnotationIndex, DecodeCancelledError, DecodeTimeoutError, EDGE_BUDGET, MAX_SAMPLE,
  annotationTexts, displayRows, getDecoder, hydrateDecoders, rowForClass, sharedDecodeClient,
} from '../decode/index.js';
import type { ChannelEdges, DecodeRequest, DecodeResult } from '../decode/index.js';

import type { AssistantHost, CaptureOutcome } from '../assistant/tools.js';

import { AnalyzerPanel } from './analyzerPanel.js';
import { AssistantPanel } from './assistantPanel.js';
import { BusBuilder, validateBusSpec } from '../data/busValue.js';
import {
  BankBusDialog, BusPanel, cloneBusConfig, defaultBankBusConfig, defaultBusConfig, normalizeBankBusConfig,
  retranslateBankBusConfig,
} from './busPanel.js';
import {
  analogFrame, busColor, busLabel, busSummary, busValueAt, busYRange, type AnalogFrame, type BusViewConfig,
  type BusViewState,
} from './busView.js';
import { layoutBubbles, type AnnotationSpan, type Bubble } from './annotationLayout.js';
import { CapturePanel, type CapturePanelView } from './capturePanel.js';
import {
  CHANNEL_BANK_SIZE, busChannelBank, captureWidthTiers, channelBankIndices, channelBankStart,
  busOutOfWidth, lockedChannelBanks,
} from './channelBanks.js';
import { ChannelList, type BusCell, type ChannelCell, type ChannelConfiguration } from './channelList.js';
import { computeChannelRowHeight } from './channelLayout.js';
import {
  MAX_SAMPLES, createProtocolDemoCapture, levelAt, loadFiles, loadLwcap, saveLwcap,
} from './captureIO.js';
import { connectSamplerate } from './connectDefaults.js';
import { formatCount, formatDuration, formatFreq, formatRate,
  formatAnalyzerNote, formatCaptureLabel, formatStatusError } from './format.js';
import { applyStaticI18n, getLocale, LOCALE_LABELS, LOCALES, onLocaleChange, setLocale, t,
  type Locale, type MessageKey, type MessageVars } from './i18n.js';
import { getMode, getTheme, onThemeChange, setMode, THEME_MODES, THEME_MODE_LABEL_KEYS,
  type ThemeId } from './theme.js';
import {
  readWorkspaceSnapshot, serializeWorkspaceSnapshot, WORKSPACE_SCHEMA_VERSION, writeWorkspaceSnapshot,
  type WorkspaceSnapshotV1,
} from './workspacePreferences.js';
import { baseTheme, canvasPalette, type CanvasPalette } from './canvasPalette.js';
import { SettingsMenu, type SettingsMenuItem } from './settingsMenu.js';
import { COLORS, MEASURE_COLORS, ROWS } from './metrics.js';
import { Overlay, paintMarkerChip, type HoverMeasurement } from './overlay.js';
import { PanelResizer } from './panelResizer.js';
import { StoreRef } from './storeRef.js';
import {
  analyzerColor, defaultCaptureSettings, defaultChannels, defaultChannelName, channelColor, DEFAULT_TRIGGER_MODE,
  edgeTriggerAutoArms, clampLoopSamples, DEFAULT_LOOP_SAMPLES, effectiveCaptureMode, loopDropSamples,
  modesToConditions, triggerModeFromCondition,
  type AnalyzerState, type CaptureSettings, type ChannelState, type TriggerMode,
  type CaptureLabel, type StatusError,
} from './state.js';
import { computeTicks, drawAxis, type TickSet } from './timeAxis.js';
import { markerPointerCursor, markerSnapRadii, type MarkerCursor } from './markerGeometry.js';
import { WaveformMarker, type MarkerSnapContext } from './waveformMarker.js';
import { WaveformStack, type RowBox, type RowSpec } from './waveformStack.js';

/** Where Pyodide and the decoder zip live; content-hashed in hosted builds (vite.config.ts). */
declare const __LOGICWEB_RUNTIME_PATHS__: { pyodide: string; decoders: string };

/** A store that can also count edges without materialising them (native live stores do). */
type CountingStore = SampleStore & { edgeCount?(c: number, s: number, e: number): number };

const BUS_CAPTURE_LOCK_ERROR = 'bank oscilloscope settings are locked while capture is running or stopping';
const LOOP_SUSPEND_MIN_BYTES_PER_SEC = 160e6;

interface Lane {
  analyzer: AnalyzerState;
  /** Index into displayRows(decoder). */
  displayRow: number;
  laneChannel: number;
}

export class App {
  private readonly storeRef: StoreRef;
  private readonly stack: WaveformStack;
  private readonly overlay: Overlay;
  private readonly channelList: ChannelList;
  private readonly capturePanel: CapturePanel;
  private readonly analyzerPanel: AnalyzerPanel;
  /** Holds the device and analyzer panels, which re-render by clearing it. */
  private readonly panelHost: HTMLDivElement;
  /** Built on first open and never cleared: it owns a conversation and a draft. */
  private assistantPanel: AssistantPanel | null = null;
  /** Resolved when the running capture stops (the assistant waits on a capture). */
  private captureWaiters: (() => void)[] = [];
  private readonly busPanel: BusPanel;
  private readonly bankBusDialog: BankBusDialog;
  /** Parallel-bus (ADC) views, drawn as analog rows above the channels. */
  private busViews: BusViewState[] = [];
  private readonly bankBusDrafts = new Map<number, BusViewConfig>();
  private nextBus = 0;
  /** When the analyzers panel last re-rendered for a bus build's progress. */
  private busPanelAt = 0;
  private runningPanelAt = 0;
  private readonly settingsMenu: SettingsMenu;
  private readonly sidebarMenu: SettingsMenu;
  private readonly languageMenu: SettingsMenu;
  private readonly themeMenu: SettingsMenu;
  private detailedLabels = true;
  private lastWorkspaceSnapshot: string | null = null;
  private pendingToolbarViewport: { start: number; end: number; follow: boolean } | null = null;
  private readonly resizer: PanelResizer;
  private readonly decodeClient = sharedDecodeClient({
    // Resolve from the document, not from the worker script. This supports static sites
    // hosted below a subdirectory and keeps all runtime files together in dist/. Hosted
    // builds put a content hash in both paths (versionRuntimeAssets in vite.config.ts).
    pyodideIndexURL: new URL(`./${__LOGICWEB_RUNTIME_PATHS__.pyodide}`, document.baseURI).href,
    decodersURL: new URL(`./${__LOGICWEB_RUNTIME_PATHS__.decoders}`, document.baseURI).href,
  });

  private channels: ChannelState[] = defaultChannels(16);
  /** Display order, holding capture channel indices. */
  private order: number[] = Array.from({ length: 16 }, (_, i) => i);
  private analyzers: AnalyzerState[] = [];
  private lanes: Lane[] = [];
  private nextAnalyzer = 0;

  private settings: CaptureSettings = defaultCaptureSettings();
  private samplerateExplicit = false;
  private widthExplicit = false;

  private device: Device | null = null;
  private deviceEpoch = 0;
  private stopPending: Promise<void> | null = null;
  private rateCeilings: Readonly<Record<number, number>> = MAX_SAMPLERATE_HZ;
  private running = false;
  /** True while WebUSB transfers from the previous run are being cancelled and drained. */
  private stopping = false;
  private captureStart = 0;
  private captureBytes = 0;
  /** Samples the device could not deliver, appended as filler and marked as gaps. */
  private lostSamples = 0;
  private loopRetentionLen = 0;
  private droppedTotal = 0;
  private captureIsLoop = false;
  private startMutatedCapture = false;
  private captureLimitSamples = 0;
  private triggerState: 'off' | 'waiting' | 'triggered' | 'not-found' = 'off';
  /** Trigger sample position in SampleStore; the time axis labels this sample T=0. */
  private triggerSampleIndex: number | null = null;

  private captureLabel: CaptureLabel = { kind: 'none' };
  private statusError: StatusError | null = null;
  private decodeBusy = false;
  private decodeWarm = false;
  private demoBusy = false;
  private readonly demoAnalyzers = new Set<string>();
  private abort: AbortController | null = null;

  private readonly markerA = new WaveformMarker('A', MEASURE_COLORS[0]!);
  private releaseMarkerPointer: () => void = () => {};
  private hover: HoverMeasurement | null = null;
  private markerCursor: MarkerCursor = null;

  private dirty = true;
  private panel: 'device' | 'analyzers' | 'assistant' | null = 'device';
  /** What the toolbar's assistant button returns to when it closes the assistant. */
  private panelBeforeAssistant: 'device' | 'analyzers' | null = 'device';
  private paintedTheme: ThemeId;
  private palette: CanvasPalette;
  private readonly wheelIntent = new WheelIntent();

  // DOM
  private readonly el: {
    plot: HTMLDivElement; waveStack: HTMLDivElement; axis: HTMLCanvasElement;
    scroll: HTMLDivElement; main: HTMLDivElement; resizer: HTMLDivElement;
    channelList: HTMLDivElement; side: HTMLDivElement; status: HTMLDivElement;
    hint: HTMLDivElement; transport: HTMLButtonElement;
    connect: HTMLButtonElement; open: HTMLButtonElement; save: HTMLButtonElement;
    fit: HTMLButtonElement; settings: HTMLButtonElement; sidebar: HTMLButtonElement;
    language: HTMLButtonElement; theme: HTMLButtonElement; assistant: HTMLButtonElement;
    fileInput: HTMLInputElement;
  };

  constructor() {
    this.el = {
      plot: must<HTMLDivElement>('plot'),
      scroll: must<HTMLDivElement>('scroll-area'),
      main: must<HTMLDivElement>('main'),
      resizer: must<HTMLDivElement>('panel-resizer'),
      waveStack: must<HTMLDivElement>('wave-stack'),
      axis: must<HTMLCanvasElement>('axis'),
      channelList: must<HTMLDivElement>('channel-list'),
      side: must<HTMLDivElement>('side-panel'),
      status: must<HTMLDivElement>('status'),
      hint: must<HTMLDivElement>('empty-hint'),
      transport: must<HTMLButtonElement>('transport'),
      connect: must<HTMLButtonElement>('btn-connect'),
      open: must<HTMLButtonElement>('btn-open'),
      save: must<HTMLButtonElement>('btn-save'),
      fit: must<HTMLButtonElement>('btn-fit'),
      settings: must<HTMLButtonElement>('btn-settings'),
      sidebar: must<HTMLButtonElement>('btn-sidebar'),
      language: must<HTMLButtonElement>('btn-language'),
      theme: must<HTMLButtonElement>('btn-theme'),
      assistant: must<HTMLButtonElement>('btn-assistant'),
      fileInput: must<HTMLInputElement>('file-input'),
    };

    // Static chrome (toolbar buttons, empty hint) translates in place,
    // and <html lang> follows the stored locale - both before the first paint.
    document.documentElement.lang = getLocale();
    applyStaticI18n(document);
    const workspace = readWorkspaceSnapshot();
    if (workspace) {
      this.detailedLabels = workspace.detailedLabels;
      this.channels = (workspace.channels ?? defaultChannels(16)).map((channel, index) => ({ ...channel, index }));
      this.order = workspace.order ?? this.channels.map((channel) => channel.index);
      this.busViews = (workspace.busViews ?? []).map((config, id) => ({
        ...cloneBusConfig(config), id: `bus-${id}`, builder: null, builtFor: null, cache: null,
      }));
      this.nextBus = this.busViews.length;
      this.bankBusDrafts = new Map(Object.entries(workspace.bankBusDrafts ?? {})
        .map(([start, config]) => [Number(start), cloneBusConfig(config)]));
      for (const bus of this.busViews) {
        const bank = busChannelBank(bus.spec);
        if (bank !== null) this.bankBusDrafts.set(bank, cloneBusConfig(bus));
      }
      this.syncBankChannels();
    }
    this.samplerateExplicit = workspace?.capture?.samplerateExplicit === true;
    this.widthExplicit = workspace?.capture?.widthExplicit === true;
    const initialWidth = workspace?.capture?.channels ?? channelWidthForProbes(this.channels.length);
    const triggerModes = workspace?.capture?.triggerModes ?? {};
    const triggerConditions = modesToConditions(triggerModes);
    const first = triggerConditions[0];
    this.settings = clampSettings({
      ...defaultCaptureSettings(),
      ...(workspace?.capture ?? {}),
      channels: initialWidth,
      triggerModes,
      triggerConditions,
      triggerChannel: first?.channel ?? 0,
      triggerKind: first?.kind ?? 'rising',
      triggerLevel: first?.level ?? 1,
    }, this.rateCeilings);
    this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));
    this.lastWorkspaceSnapshot = serializeWorkspaceSnapshot(this.workspaceSnapshot());
    this.reflectDetailedLabels();

    this.settingsMenu = new SettingsMenu(must<HTMLButtonElement>('btn-settings'));
    this.sidebarMenu = new SettingsMenu(this.el.sidebar, 'sidebar-menu');
    this.languageMenu = new SettingsMenu(this.el.language, 'language-menu');
    this.themeMenu = new SettingsMenu(this.el.theme, 'theme-menu');
    this.el.theme.dataset.mode = getMode();
    this.resizer = new PanelResizer(this.el.resizer, this.el.side, this.el.main);

    this.storeRef = new StoreRef(createSampleStore(channelWidthForProbes(this.channels.length), this.settings.samplerate));
    this.stack = new WaveformStack(this.el.waveStack, this.storeRef);
    this.overlay = new Overlay(this.el.plot);
    this.paintedTheme = getTheme();
    this.palette = canvasPalette(this.paintedTheme);
    this.overlay.setPalette(this.palette);
    this.stack.setBaseTheme(baseTheme(this.paintedTheme));
    this.channelList = new ChannelList(this.el.channelList, {
      onConfigure: (channel, config) => this.configureChannel(channel, config),
      onReorder: (from, to) => this.reorder(from, to),
      onRemoveAnalyzer: (id) => this.removeAnalyzer(id),
      onEditBus: (id) => this.editBus(id),
    });

    const panelHost = document.createElement('div');
    // The class hooks the dark theme's card stack (style.css): a flex column with a gap,
    // so the cards space without margins. Under the default theme it styles nothing.
    panelHost.className = 'panel-host';
    this.el.side.appendChild(panelHost);
    this.panelHost = panelHost;
    this.capturePanel = new CapturePanel(panelHost, {
      onSettings: (s) => this.applySettings(s),
      onToggleChannel: (i, on) => this.setChannelEnabled(i, on),
      onOpenBank: (start) => this.openBankBus(start),
      onChannelWidth: (n) => this.setChannelWidth(n),
      onUsbControl: (command) => this.usbControl(command),
    });
    this.analyzerPanel = new AnalyzerPanel(panelHost, {
      onAttach: (id, ch, opts) => void this.attachAnalyzer(id, ch, opts),
      onRemove: (id) => this.removeAnalyzer(id),
      onRedecode: (id) => void this.runDecode(id),
      onCancel: () => this.abort?.abort(),
    });
    // Its own host: AnalyzerPanel clears panelHost whenever it re-renders itself (on
    // decoder hydration, for one), which would wipe a section appended after it.
    const busHost = document.createElement('div');
    busHost.className = 'panel-host bus-host';
    busHost.hidden = true;
    this.el.side.appendChild(busHost);
    this.busPanel = new BusPanel(busHost, {
      onAdd: (cfg) => this.addBus(cfg),
      onEdit: (id) => this.editBus(id),
      onUpdate: (id, cfg) => this.updateBus(id, cfg),
      onRemove: (id) => this.removeBus(id),
    });
    this.bankBusDialog = new BankBusDialog({
      onConfirm: (start, cfg, enabled) => this.configureBankBus(start, cfg, enabled),
    });

    this.wireToolbar();
    this.wirePlot();

    // A locale switch is a full re-render pass: every render path is clear-and-rebuild,
    // so re-running them swaps the language with no stale strings anywhere.
    onLocaleChange(() => this.retranslate());

    // A theme switch is chrome-only CSS: no strings or layout depend on it, so nothing
    // re-renders (a loaded/running capture is untouched). The transient settings menu
    // would keep a stale checkmark, though, so it closes - same class as 'retranslate':
    // no focus hand-off for a programmatic switch.
    onThemeChange(() => {
      const next = getTheme();
      if (next !== this.paintedTheme) {
        this.paintedTheme = next;
        this.palette = canvasPalette(next);
        this.overlay.setPalette(this.palette);
        this.stack.setBaseTheme(baseTheme(next));
        this.dirty = true;
      }
      this.el.theme.dataset.mode = getMode();
      this.settingsMenu.close('theme');
      this.sidebarMenu.close('theme');
      this.languageMenu.close('theme');
      this.themeMenu.close('theme');
    });

    // Observe the scroll viewport, not the plot: the plot's height is now an *output*
    // of relayout (its canvases stack in normal flow so the rows can scroll), and
    // observing it would loop layout -> resize -> layout.
    new ResizeObserver(() => { this.relayout(); }).observe(this.el.scroll);
    window.addEventListener('resize', () => this.relayout());

    this.relayout();
    this.renderPanels();
    this.frame();

    // Pay the Pyodide cold start once. The portable build uses only embedded bytes,
    // including on file://; dev uses the staged files served by Vite.
    this.decodeClient.warmup().then(
      () => { this.decodeWarm = true; this.renderPanels(); },
      (e: unknown) => this.fail('error.decodeWorkerWarmup', e),
    );
    void this.reconnectGranted();
  }

  // ------------------------------------------------------------------ layout

  private get store(): SampleStore { return this.storeRef.target; }

  private enabledChannels(): ChannelState[] {
    return this.order.map((i) => this.channels[i]!).filter((c) => this.channelAvailable(c.index) && c.enabled);
  }

  /**
   * The channels the plot shows: enabled ones, minus the source bits of a bus view that
   * hides them. Display only.
   */
  private visibleChannels(): ChannelState[] {
    const hidden = new Set(this.busViews.filter((b) => b.hideSources).flatMap((b) => b.spec.bits));
    return this.enabledChannels().filter((c) => !hidden.has(c.index));
  }

  private loadedCapture(): boolean {
    return this.captureLabel.kind === 'loaded' || this.captureLabel.kind === 'demo';
  }

  private widthTiers(): number[] {
    const capacity = this.channels.length;
    const deviceMax = this.device?.maxChannels ?? null;
    return captureWidthTiers(deviceMax === null ? null : Math.min(deviceMax, capacity), this.loadedCapture());
  }

  private displayChannelCount(): number {
    return this.loadedCapture() ? this.channels.length : this.settings.channels;
  }

  private channelAvailable(index: number): boolean {
    return index < Math.min(this.displayChannelCount(), this.store.channelCount);
  }

  // ------------------------------------------------------------------ bus views

  private busCells(): BusCell[] {
    return this.busViews.map((b) => ({
      id: b.id, name: b.name, summary: busSummary(b.spec), color: b.color, heightCss: b.heightCss,
    }));
  }

  private syncBankChannels(): void {
    for (const bus of this.busViews) {
      if (busChannelBank(bus.spec) === null) continue;
      for (const channel of bus.spec.bits) {
        const c = this.channels[channel];
        if (c) c.enabled = true;
      }
    }
  }

  private editBus(id: string): void {
    const bus = this.busViews.find((candidate) => candidate.id === id);
    if (!bus) return;
    const bank = busChannelBank(bus.spec);
    if (bank !== null && this.openBankBus(bank)) return;
    this.busPanel.edit(bus);
    this.selectPanel('analyzers');
  }

  private oscilloscopeActive(): boolean {
    return lockedChannelBanks(this.busViews, this.displayChannelCount()).size > 0;
  }

  private addBus(cfg: BusViewConfig): string | null {
    if (busOutOfWidth(cfg.spec, this.displayChannelCount())) return null;
    if ((this.running || this.stopping) && busChannelBank(cfg.spec) !== null) return null;
    const color = busColor(this.nextBus);
    const id = `bus-${this.nextBus++}`;
    this.busViews.push({ ...cfg, color, id, builder: null, builtFor: null, cache: null });
    this.syncBankChannels();
    this.afterChannelChange();
    return id;
  }

  private updateBus(id: string, cfg: BusViewConfig, preserveDefaultName = false): boolean {
    const i = this.busViews.findIndex((b) => b.id === id);
    if (i < 0) return false;
    if (busOutOfWidth(cfg.spec, this.displayChannelCount())) return false;
    const current = this.busViews[i]!;
    if ((this.running || this.stopping) &&
      (busChannelBank(current.spec) !== null || busChannelBank(cfg.spec) !== null)) return false;
    const next = cloneBusConfig(cfg);
    if (!preserveDefaultName && next.name !== current.name) delete next.usesDefaultName;
    this.busViews[i] = { ...next, color: current.color, id, builder: null, builtFor: null, cache: null };
    this.syncBankChannels();
    this.afterChannelChange();
    return true;
  }

  private removeBus(id: string): boolean {
    const current = this.busViews.find((bus) => bus.id === id);
    if (!current) return false;
    if ((this.running || this.stopping) && busChannelBank(current.spec) !== null) return false;
    this.busViews = this.busViews.filter((b) => b.id !== id);
    this.afterChannelChange();
    return true;
  }

  private bankCaptureSettings(start: number, config: BusViewConfig): CaptureSettings {
    const bankWidth = channelWidthForProbes(start + CHANNEL_BANK_SIZE);
    const clockWidth = config.spec.clock ? channelWidthForProbes(config.spec.clock.channel + 1) : bankWidth;
    let channels: ChannelCount = bankWidth;
    if (clockWidth > channels) channels = clockWidth;
    if (this.settings.channels > channels) channels = this.settings.channels;
    return clampSettings({ ...this.settings, channels }, this.rateCeilings);
  }

  private openBankBus(start: number): boolean {
    if (channelBankIndices(start, this.channels.length).length !== CHANNEL_BANK_SIZE) return false;
    const active = this.busViews.find((b) => busChannelBank(b.spec) === start);
    const config = normalizeBankBusConfig(
      active ?? this.bankBusDrafts.get(start) ?? defaultBankBusConfig(this.channels.length, start),
      this.channels.length, start,
    );
    this.bankBusDialog.open(start, config, active !== undefined, this.channels.length, {
      locked: this.running || this.stopping,
    });
    return true;
  }

  private configureBankBus(start: number, config: BusViewConfig, enabled: boolean): void {
    if (this.running || this.stopping ||
      channelBankIndices(start, this.channels.length).length !== CHANNEL_BANK_SIZE) return;
    const next = normalizeBankBusConfig(config, this.channels.length, start);
    this.bankBusDrafts.set(start, cloneBusConfig(next));
    if (enabled) {
      this.settings = this.bankCaptureSettings(start, next);
      const active = this.busViews.find((b) => busChannelBank(b.spec) === start);
      if (active) this.updateBus(active.id, next, true);
      else this.addBus(next);
      return;
    }
    this.settings = clampSettings({ ...this.settings }, this.rateCeilings);
    const remaining = this.busViews.filter((b) => busChannelBank(b.spec) !== start);
    if (remaining.length !== this.busViews.length) {
      this.busViews = remaining;
      this.afterChannelChange();
    }
    this.persistWorkspace();
  }

  /** A new capture (or a growing one) invalidates every bus's overview and cache. */
  private resetBusBuilds(): void {
    for (const b of this.busViews) { b.builder = null; b.builtFor = null; b.cache = null; }
  }

  /**
   * Build bus overviews a slice per frame, following a growing capture, so a
   * 2^31-sample capture never blocks the page. One bus at a time; the panel shows progress.
   */
  private pumpBusBuilders(): void {
    if (this.stopping || this.store.length === 0) return;
    const store = this.store;
    for (const b of this.busViews) {
      if (b.builtFor !== store) {
        b.builtFor = store;
        b.cache = null;
        b.builder = validateBusSpec(b.spec, store.channelCount).length ? null
          : new BusBuilder(store, b.spec, store.length, undefined,
            this.captureIsLoop ? this.loopRetentionLen * 2 : store.length);
      }
      if (!b.builder) continue;
      b.builder.setLength(store.length);
      if (b.builder.done) continue;
      const done = b.builder.step(this.running ? 4 : 6);
      this.dirty = true;
      const now = performance.now();
      if (this.panel === 'analyzers' && (done || now - this.busPanelAt > 300)) {
        this.busPanelAt = now;
        this.renderPanels();
      }
      return;
    }
  }

  private drawBusRows(boxes: readonly RowBox[]): void {
    const view = this.stack.view;
    const store = this.store;
    for (const box of boxes) {
      if (box.spec.kind !== 'analog') continue;
      const bv = this.busViews[box.spec.bus ?? -1];
      if (!bv) continue;
      // The analog row is a renderer row with a trace in it; cover it first.
      this.overlay.fillLane(box.top, box.height);
      const valid = store.length > 0 && validateBusSpec(bv.spec, store.channelCount).length === 0;
      const frame: AnalogFrame = valid
        ? analogFrame(store, bv, view.start, view.end, view.widthPx, this.running)
        : { kind: 'empty', reason: 'no-capture' };
      const note = frame.kind !== 'empty' ? ''
        : frame.reason === 'live' ? t('bus.liveNote')
          : store.length > 0 ? t('bus.badChannels') : '';
      const r = busYRange(bv);
      this.overlay.drawAnalog({
        top: box.top, band: box.band, frame, yMin: r.min, yMax: r.max, color: bv.color,
        // A combinational bus holds its value between bit changes: steps are the truth.
        style: bv.spec.clock ? bv.style : 'step',
        labels: { top: busLabel(bv, r.max), bottom: busLabel(bv, r.min) },
        note,
      });
    }
  }

  private applySettings(s: CaptureSettings): void {
    if (s.samplerate !== this.settings.samplerate) this.samplerateExplicit = true;
    const next = clampSettings(s, this.rateCeilings);
    if (triggerSettingsChanged(this.settings, next)) {
      this.triggerState = 'off';
      this.triggerSampleIndex = null;
      this.dirty = true;
    }
    this.settings = next;
    this.persistWorkspace();
    this.relayout();
    this.renderPanels();
  }

  /** Commit one channel-dialog draft. Name and color metadata stay editable during
   * capture, while trigger modes retain the existing running/stopping lock. */
  private configureChannel(channel: number, config: ChannelConfiguration): void {
    const current = this.channels[channel];
    if (!current) return;
    const name = config.name.trim() || defaultChannelName(channel);
    this.channels[channel] = { ...current, name, color: config.color };

    if (!this.running && !this.stopping) {
      const previous = this.settings.triggerModes[channel] ?? DEFAULT_TRIGGER_MODE;
      const triggerModes = { ...this.settings.triggerModes, [channel]: config.mode };
      const triggerConditions = modesToConditions(triggerModes);
      const first = triggerConditions[0] ?? {
        channel, kind: 'level' as const, level: 1 as const,
      };
      const next = clampSettings({
        ...this.settings, triggerModes, triggerConditions,
        triggerChannel: first.channel, triggerKind: first.kind, triggerLevel: first.level,
        ...(edgeTriggerAutoArms(previous, config.mode, this.settings.triggerEnableMask)
          ? { triggerEnableMask: true } : {}),
      }, this.rateCeilings);
      if (triggerSettingsChanged(this.settings, next)) {
        this.triggerState = 'off';
        this.triggerSampleIndex = null;
      }
      this.settings = next;
    }

    this.persistWorkspace();
    this.relayout();
    this.renderPanels();
    this.dirty = true;
  }

  /**
   * Rebuild the row model.
   *
   * Rows auto-fit the plot: the stack fills the available height, so the base row height
   * is derived rather than a constant, and annotation lanes are subtracted first.
   */
  private relayout(): void {
    // Rows auto-fit the *visible* plot height (the scroll viewport minus the sticky
    // axis). When even minimum-height rows do not fit, the stack overflows and the
    // scroll area scrolls - phones get every channel instead of the first six.
    // Analog (parallel-bus) rows sit above the channels and take their height first.
    const analogRows: RowSpec[] = [];
    this.busViews.forEach((b, i) => {
      if (busOutOfWidth(b.spec, this.displayChannelCount())) return;
      analogRows.push({
        kind: 'analog', channel: Math.min(b.spec.bits[0] ?? 0, Math.max(0, this.store.channelCount - 1)),
        heightCss: b.heightCss, bus: i,
      });
    });
    const analogH = analogRows.reduce((sum, r) => sum + r.heightCss, 0);
    const axisH = this.el.axis.offsetHeight || 30;
    const plotH = Math.max(120, (this.el.scroll.clientHeight || 630) - axisH - analogH);
    const enabled = this.visibleChannels();
    this.lanes = this.computeLanes(enabled);
    const channelColors = this.channels.map((channel) => channel.color);

    if (enabled.length === 0) {
      this.stack.setRows(analogRows, channelColors);
      this.channelList.render([]);
      this.channelList.renderBuses(this.busCells());
      this.overlay.syncSize(this.el.plot.clientWidth, this.el.plot.clientHeight);
      this.dirty = true;
      return;
    }

    const base = computeChannelRowHeight(plotH, enabled.length, this.lanes.length);

    const rows: RowSpec[] = [...analogRows];
    const cells: ChannelCell[] = [];
    for (const c of enabled) {
      const mine = this.lanes.filter((l) => l.laneChannel === c.index);
      for (const l of mine) {
        rows.push({
          kind: 'lane', channel: c.index, heightCss: ROWS.laneHeight,
          analyzer: this.analyzers.indexOf(l.analyzer),
        });
      }
      rows.push({ kind: 'channel', channel: c.index, heightCss: base });
      cells.push({
        channel: c,
        heightCss: base + mine.length * ROWS.laneHeight,
        laneCss: mine.length * ROWS.laneHeight,
        analyzers: this.analyzers.filter((a) => this.chipChannels(a).includes(c.index)),
        trigger: {
          mode: this.settings.triggerModes[c.index] ?? DEFAULT_TRIGGER_MODE,
          disabled: this.running || this.stopping,
        },
      });
    }

    this.stack.setRows(rows, channelColors);
    this.channelList.render(cells);
    this.channelList.renderBuses(this.busCells());
    this.overlay.syncSize(this.el.plot.clientWidth, this.el.plot.clientHeight);
    this.dirty = true;
  }

  /**
   * One lane per annotation row a decoder actually produced output in - with two rules.
   *
   * **Bit-level rows are dropped.** [CHOICE, with a reason] sigrok's decoders declare a
   * row per *bit* alongside the byte-level rows: i2c has `bits`, uart `rx-data-bits` and
   * `tx-data-bits`, spi `miso-bits` and `mosi-bits`. Those are one annotation per clock
   * and are unreadable at any zoom where a byte fits on screen, so we draw no
   * equivalent - `05-analyzer-annotations.png` shows I2C as a single lane of
   * "Setup Read to [0x20] + ACK" frames. Dropping them is a name match on `/bits$/`,
   * which is a heuristic and is called out as one; if a decoder has nothing else, its bit
   * rows are shown rather than showing nothing.
   *
   * **Capped at 3 lanes per analyzer.** Each lane costs 20 CSS px off every channel row,
   * and `uart` alone declares ten rows.
   */
  private computeLanes(enabled: readonly ChannelState[]): Lane[] {
    const out: Lane[] = [];
    const visible = new Set(enabled.map((c) => c.index));
    for (const a of this.analyzers) {
      if (!a.result || a.result.annotations.count === 0) continue;
      if (!visible.has(a.laneChannel)) continue;
      const info = getDecoder(a.decoderId);
      const rows = displayRows(info);
      const map = rowForClass(info);
      const used = new Set<number>();
      const cls = a.result.annotations.cls;
      for (let i = 0; i < a.result.annotations.count; i++) {
        const r = map[cls[i]!] ?? -1;
        used.add(r < 0 ? 0 : r);
      }
      const candidates = [...used].sort((x, y) => x - y);
      const isBitRow = (r: number) => /bits$/.test(rows[r]?.id ?? '');
      const kept = candidates.filter((r) => !isBitRow(r));
      const chosen = (kept.length ? kept : candidates).slice(0, 3);
      for (const r of chosen) {
        out.push({ analyzer: a, displayRow: r, laneChannel: a.laneChannel });
      }
    }
    return out;
  }

  /** Capture channels this analyzer should show a chip on: every channel it reads. */
  private chipChannels(a: AnalyzerState): number[] {
    return Object.values(a.channels).filter((v) => v >= 0);
  }

  private setChannelEnabled(index: number, enabled: boolean): void {
    if (index >= this.displayChannelCount()) return;
    const c = this.channels[index];
    if (!c) return;
    if (!enabled && lockedChannelBanks(this.busViews, this.displayChannelCount()).has(channelBankStart(index))) return;
    if (!enabled && this.enabledChannels().length <= 1) return;   // never zero rows
    c.enabled = enabled;
    this.afterChannelChange();
  }

  private setChannelWidth(channels: number): void {
    if (this.running || this.stopping) return;
    if (!this.widthTiers().includes(channels)) return;
    if (!isChannelCount(channels) || channels > this.channels.length) return;
    this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, channels));
    if (channels !== this.settings.channels) this.widthExplicit = true;
    this.applySettings({ ...this.settings, channels });
  }

  private afterChannelChange(): void {
    this.settings = clampSettings({ ...this.settings }, this.rateCeilings);
    this.persistWorkspace();
    this.relayout();
    this.renderPanels();
  }

  private reorder(from: number, to: number): void {
    const enabled = this.visibleChannels();
    const moving = enabled[from];
    const target = enabled[to];
    if (!moving || !target) return;
    const src = this.order.indexOf(moving.index);
    const dst = this.order.indexOf(target.index);
    this.order.splice(src, 1);
    this.order.splice(dst, 0, moving.index);
    this.persistWorkspace();
    this.relayout();
  }

  // ------------------------------------------------------------------ frame

  private frame = (): void => {
    requestAnimationFrame(this.frame);
    const now = performance.now();
    const highRateLoop = this.running && this.captureIsLoop &&
      this.store.samplerate * bytesPerSampleForChannels(this.store.channelCount) >= LOOP_SUSPEND_MIN_BYTES_PER_SEC;
    if (!highRateLoop) this.pumpBusBuilders();
    if (this.running && now - this.runningPanelAt > 500) {
      this.runningPanelAt = now;
      if (this.panel === 'device') this.capturePanel.updateProgress(this.progressView());
      if (highRateLoop) this.renderStatus();
    }
    if (!this.dirty && !this.running) return;
    if (highRateLoop) return;
    this.dirty = false;
    try {
      this.draw();
    } catch (e) {
      this.fail('error.render', e);
    }
  };

  private draw(): void {
    const pendingViewport = this.pendingToolbarViewport;
    this.pendingToolbarViewport = null;
    const restorePending = pendingViewport !== null &&
      this.stack.view.start === pendingViewport.start && this.stack.view.end === pendingViewport.end;
    this.stack.syncSize();
    if (restorePending && pendingViewport) {
      this.stack.setViewport(pendingViewport.start, pendingViewport.end);
      this.stack.setFollowLatest(pendingViewport.follow);
    }
    const wCss = this.el.plot.clientWidth;
    const hCss = this.el.plot.clientHeight;
    this.overlay.syncSize(wCss, hCss);
    this.el.hint.style.display = this.store.length > 0 ? 'none' : 'flex';

    this.stack.render();
    const view = this.stack.view;
    const sr = this.store.samplerate;
    const timeOrigin = this.triggerSampleIndex ?? 0;
    const ticks = computeTicks(
      ((view.start - timeOrigin) / sr) * 1e12,
      ((view.end - timeOrigin) / sr) * 1e12,
      wCss, sr,
    );

    this.drawAxisCanvas(ticks, wCss);

    this.overlay.beginFrame();
    this.overlay.drawGrid(ticks);
    const boxes = this.stack.boxes();
    this.drawLaneSurfaces(boxes);
    if (this.captureLabel.kind === 'demo') {
      const channelRow = boxes.find((b) => b.spec.kind === 'channel');
      if (channelRow) this.overlay.drawDemoWatermark(channelRow.height);
    }
    this.overlay.drawLevels(boxes.map((b) => ({
      top: b.top, band: b.band, isChannel: b.spec.kind === 'channel',
    })));
    this.drawLaneBubbles(boxes, wCss);
    this.drawBusRows(boxes);

    if (this.triggerSampleIndex !== null) {
      this.overlay.drawTrigger(this.toPx(this.triggerSampleIndex));
    }

    if (this.running && this.store.length > 0) {
      this.overlay.drawLiveEdge(this.toPx(this.store.length));
    }
    this.markerA.draw(this.overlay, (sample) => this.toPx(sample));
    if (this.hover) this.overlay.drawHover(this.hover);

    this.renderStatus();
  }

  private drawAxisCanvas(ticks: TickSet, wCss: number): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const c = this.el.axis;
    const hCss = c.clientHeight || 29;
    const w = Math.max(1, Math.round(wCss * dpr));
    const h = Math.max(1, Math.round(hCss * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('axis 2D context unavailable');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAxis(ctx, ticks, wCss, hCss, this.palette);
    this.markerA.drawChip({
      drawChip: (x, color, label) => {
        paintMarkerChip(ctx, x, wCss, hCss, color, label, this.palette);
      },
    }, (sample) => this.toPx(sample));
  }

  private drawLaneSurfaces(boxes: readonly RowBox[]): void {
    for (const box of boxes) {
      if (box.spec.kind !== 'lane') continue;
      // The lane is a renderer row, so it currently holds a trace and a separator. Cover
      // it before drawing into it - NOTES.md section 2.
      this.overlay.fillLane(box.top, box.height);
    }
  }

  private drawLaneBubbles(boxes: readonly RowBox[], wCss: number): void {
    const view = this.stack.view;
    const measure = this.overlay.measureCtx;
    for (const box of boxes) {
      if (box.spec.kind !== 'lane') continue;
      const lane = this.laneFor(box);
      if (!lane || !lane.analyzer.result || !lane.analyzer.index) continue;
      const spans = this.spansFor(lane, view.start, view.end);
      if (spans.length === 0) continue;
      const bubbles: Bubble[] = layoutBubbles({
        spans, widthCss: wCss, measure, toPx: (s) => this.toPx(s),
      });
      this.overlay.drawBubbles(bubbles, box.top, lane.analyzer.color);
    }
  }

  private laneFor(box: { spec: RowSpec; top: number }): Lane | null {
    // Lanes are emitted in the same order they appear in `this.lanes` for a channel, so
    // matching on (channel, ordinal) is exact.
    let ordinal = 0;
    for (const b of this.stack.boxes()) {
      if (b.top === box.top) break;
      if (b.spec.kind === 'lane' && b.spec.channel === box.spec.channel) ordinal++;
    }
    const mine = this.lanes.filter((l) => l.laneChannel === box.spec.channel);
    return mine[ordinal] ?? null;
  }

  private spansFor(lane: Lane, startSample: number, endSample: number): AnnotationSpan[] {
    const a = lane.analyzer;
    if (!a.result || !a.index) return [];
    const info = getDecoder(a.decoderId);
    const map = rowForClass(info);
    const idx = a.index.query(0, Math.floor(startSample), Math.ceil(endSample));
    const { start, end, cls } = a.result.annotations;
    const out: AnnotationSpan[] = [];
    for (const i of idx) {
      const r = map[cls[i]!] ?? -1;
      if ((r < 0 ? 0 : r) !== lane.displayRow) continue;
      out.push({ start: start[i]!, end: end[i]!, texts: annotationTexts(a.result, i) });
    }
    return out;
  }

  /** Sample -> CSS px inside the plot. The renderer's transform is in device px. */
  private toPx(sample: number): number {
    const dpr = globalThis.devicePixelRatio || 1;
    return this.stack.view.sampleToPixel(sample) / dpr;
  }

  private toSample(cssX: number): number {
    const dpr = globalThis.devicePixelRatio || 1;
    return this.stack.view.pixelToSample(cssX * dpr);
  }

  // ------------------------------------------------------------------ input

  private wirePlot(): void {
    const plot = this.el.plot;

    plot.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.store.length === 0) return;
      const dpr = globalThis.devicePixelRatio || 1;
      const rect = plot.getBoundingClientRect();
      const x = (e.clientX - rect.left) * dpr;
      const intent = this.wheelIntent.classify(e.deltaX, e.deltaY, performance.now());
      if (intent === 'zoom') {
        // [SOURCE] zoomFactor = 2 ^ ((isPhysicalWheel ? 0.5 : 1) * scale * -deltaY / 120),
        // so one 120-unit notch is exactly sqrt(2) and Shift makes it 10x finer.
        // [UNVERIFIED] telling a physical wheel from a trackpad: the spec does not say how
        // A browser does not report it directly. A large, quantised deltaY with
        // no deltaX is the usual signature.
        const physical = e.deltaX === 0 && Math.abs(e.deltaY) >= 100 && Number.isInteger(e.deltaY);
        const f = wheelSpanFactor(e.deltaY, { isPhysicalWheel: physical, shift: e.shiftKey });
        this.stack.zoomAt(x, f);
      } else {
        this.stack.panPixels(e.deltaX * dpr);
      }
      this.syncMarkerCursor(e.clientX - rect.left);
      this.setFollow(false);
      this.dirty = true;
    }, { passive: false });

    // One pointer drags (pan) or clicks (cursor); two pointers pinch-zoom around their
    // midpoint. Touch is pointer events here too - #plot carries `touch-action: pan-y`,
    // so the browser keeps vertical scrolling and hands everything else to this code.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; midX: number } | null = null;
    let dragging = false;
    let lastX = 0;
    let downX = 0;
    let moved = 0;
    this.releaseMarkerPointer = () => {
      const id = this.markerA.pointerId;
      this.syncMarkerCursor(null);
      if (id === null) return;
      this.markerA.cancelDrag();
      pointers.delete(id);
      if (plot.hasPointerCapture(id)) plot.releasePointerCapture(id);
    };
    plot.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      plot.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        this.markerA.cancelDrag();
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2 };
        dragging = false;
        moved = 1000;   // a pinch never ends in a cursor placement
      } else if (pointers.size === 1) {
        this.stack.syncSize();
        const rect = plot.getBoundingClientRect();
        const grabbed = this.tryGrabMarker(e, rect);
        dragging = !grabbed;
        lastX = e.clientX;
        downX = e.clientX;
        moved = 0;
        if (grabbed) {
          this.hover = null;
          this.syncMarkerCursor(e.clientX - rect.left);
          this.dirty = true;
        }
      }
    });
    plot.addEventListener('pointermove', (e) => {
      const rect = plot.getBoundingClientRect();
      this.syncMarkerCursor(e.clientX - rect.left);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.markerA.isDragging) {
        this.stack.syncSize();
        const sample = this.toSample(e.clientX - rect.left);
        const consumed = this.markerA.move({
          pointerId: e.pointerId,
          clientX: e.clientX,
          clientY: e.clientY,
          sample,
          captureLength: this.store.length,
          snap: this.markerSnap(sample),
        });
        if (consumed) { this.dirty = true; return; }
      }
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        if (this.store.length > 0 && dist > 0 && pinch.dist > 0) {
          const dpr = globalThis.devicePixelRatio || 1;
          // Fingers spreading = zoom in = a smaller sample span, anchored between them.
          this.stack.zoomAt((midX - rect.left) * dpr, pinch.dist / dist);
          this.stack.panPixels(-(midX - pinch.midX) * dpr);
          this.setFollow(false);
          this.dirty = true;
        }
        pinch = { dist, midX };
        return;
      }
      if (dragging) {
        const dpr = globalThis.devicePixelRatio || 1;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        moved += Math.abs(dx);
        this.stack.panPixels(-dx * dpr);
        this.setFollow(false);
        this.dirty = true;
        return;
      }
      this.updateHover(e.clientX - rect.left, e.clientY - rect.top);
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      const markerEnded = this.markerA.endDrag(e.pointerId);
      if (plot.hasPointerCapture(e.pointerId)) plot.releasePointerCapture(e.pointerId);
      this.syncMarkerCursor(e.clientX - plot.getBoundingClientRect().left);
      if (markerEnded) { this.dirty = true; return; }
      if (pinch && pointers.size >= 2) {
        // Three fingers down and one lifted: the pinch pair changed identity, so the
        // baseline must be re-measured or the next move zooms by the pair difference.
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2 };
      } else if (pinch) {
        pinch = null;
        // The finger that stays down keeps panning; it must not read as a click.
        const rest = [...pointers.values()][0];
        if (rest) { dragging = true; lastX = rest.x; moved = 1000; }
      }
      if (!dragging || pointers.size > 0) return;
      dragging = false;
      // A pointercancel is the browser taking the gesture for itself - with
      // `touch-action: pan-y` that is every vertical scroll of the channel stack,
      // which has near-zero horizontal displacement and must not read as a click.
      if (e.type === 'pointercancel') return;
      // A click, not a drag: place a cursor.
      if (moved < 3 && Math.abs(e.clientX - downX) < 3 && this.store.length > 0) {
        const rect = plot.getBoundingClientRect();
        const s = Math.round(this.toSample(e.clientX - rect.left));
        this.markerA.setSample(s, this.store.length);
        this.syncMarkerCursor(e.clientX - rect.left);
        this.dirty = true;
      }
    };
    plot.addEventListener('pointerup', end);
    plot.addEventListener('pointercancel', end);
    plot.addEventListener('lostpointercapture', (e) => {
      if (this.markerA.pointerId !== e.pointerId) return;
      pointers.delete(e.pointerId);
      this.markerA.cancelDrag();
      this.syncMarkerCursor(null);
      this.dirty = true;
    });
    plot.addEventListener('pointerleave', () => {
      this.hover = null;
      this.syncMarkerCursor(null);
      this.dirty = true;
    });
    plot.addEventListener('dblclick', () => { this.stack.zoomToFit(); this.dirty = true; });

    // Dragging the axis pans, which is what a time ruler is for.
    let axisDrag = false;
    let axisLast = 0;
    this.el.axis.addEventListener('pointerdown', (e) => {
      axisDrag = true; axisLast = e.clientX;
      this.el.axis.setPointerCapture(e.pointerId);
    });
    this.el.axis.addEventListener('pointermove', (e) => {
      if (!axisDrag) return;
      const dpr = globalThis.devicePixelRatio || 1;
      this.stack.panPixels(-(e.clientX - axisLast) * dpr);
      axisLast = e.clientX;
      this.setFollow(false);
      this.dirty = true;
    });
    const axisEnd = (e: PointerEvent) => {
      axisDrag = false;
      if (this.el.axis.hasPointerCapture(e.pointerId)) {
        this.el.axis.releasePointerCapture(e.pointerId);
      }
    };
    this.el.axis.addEventListener('pointerup', axisEnd);
    // Without this, a cancelled drag (tab switch, system gesture) leaves axisDrag
    // stuck on and every later hover over the ruler pans with no button held.
    this.el.axis.addEventListener('pointercancel', axisEnd);

    window.addEventListener('keydown', (e) => {
      // Shortcuts belong to the plot. Typing anywhere else - a text field, the chat box,
      // a contenteditable, anything inside the assistant (whose buttons keep focus
      // after a click) or an open dialog - must not leak: Space would start a capture.
      const target = e.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement ||
          target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest('.select-field, .assistant-panel') !== null)) return;
      if (target instanceof HTMLElement && target.closest('dialog[open]') !== null) return;
      if (e.key === 'f') { this.stack.zoomToFit(); this.dirty = true; }
      if (e.key === ' ') {
        e.preventDefault();
        this.primaryAction();
      }
      if (e.key === 'Escape') {
        this.releaseMarkerPointer();
        this.markerA.clear();
        this.dirty = true;
      }
    });

    // Drag and drop a capture file straight onto the window.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void this.openFiles(files);
    });
  }

  private rowAt(cssY: number): RowBox | null {
    for (const box of this.stack.boxes()) {
      if (cssY >= box.top && cssY < box.top + box.height) return box;
    }
    return null;
  }

  private tryGrabMarker(e: PointerEvent, rect: DOMRect): boolean {
    const sample = this.markerA.sample;
    if (sample === null) return false;
    const row = this.rowAt(e.clientY - rect.top);
    return this.markerA.tryGrab({
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerCssX: e.clientX - rect.left,
      markerCssX: this.toPx(sample),
      channel: row?.spec.channel ?? null,
      captureLength: this.store.length,
    });
  }

  private markerSnap(center: number): MarkerSnapContext | null {
    const channel = this.markerA.channel;
    const store = this.store;
    if (channel === null) return null;
    if (!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount) return null;
    if (this.channels[channel]?.enabled !== true) return null;
    if (!Number.isFinite(center) || center < 0 || center > store.length - 1) return null;
    const radii = markerSnapRadii(
      globalThis.devicePixelRatio || 1, this.stack.view.samplesPerPixel,
    );
    if (radii === null) return null;
    return {
      exactRadiusSamples: radii.exactRadiusSamples,
      queryRadiusSamples: radii.queryRadiusSamples,
      readEdges: (lo, hi) => store.edges(channel, lo, hi),
    };
  }

  /**
   * [CHOSEN] : hovering a digital pulse produces measurements with no
   * clicking at all - width and period brackets plus a readout of duty, frequency and
   * 1/width. Matching it is explicitly "not optional".
   */
  private updateHover(cssX: number, cssY: number): void {
    this.hover = null;
    const store = this.store;
    if (store.length === 0) { this.dirty = true; return; }

    const box = this.rowAt(cssY);
    if (!box || box.spec.kind === 'lane') { this.dirty = true; return; }
    if (box.spec.kind === 'analog') {
      const bv = this.busViews[box.spec.bus ?? -1];
      const s = Math.round(this.toSample(cssX));
      if (bv && s >= 0 && s < store.length && validateBusSpec(bv.spec, store.channelCount).length === 0) {
        const v = busValueAt(store, bv.spec, s);
        const raw = Number.isNaN(v) ? t('bus.unknown') : busLabel(bv, v);
        this.hover = {
          pointerX: cssX, rowTop: box.top, rowBand: box.band, color: bv.color,
          widthX0: null, widthX1: null, periodX0: null, periodX1: null,
          lines: [`${bv.name} = ${raw}`, ...(bv.fullScaleV !== null && !Number.isNaN(v) ? [`${t('bus.code')} ${v}`] : [])],
        };
      }
      this.dirty = true;
      return;
    }

    const ch = box.spec.channel;
    const s = Math.round(this.toSample(cssX));
    if (s < 0 || s >= store.length) { this.dirty = true; return; }

    // Look outward in widening windows rather than scanning the whole capture: edges() is
    // a linear scan, and on a dense channel over 100M samples that is a 200 MB answer.
    const spp = Math.max(1, this.stack.view.samplesPerPixel);
    let win = Math.max(64, Math.ceil(spp * 200));
    let prev = -1;
    let next = -1;
    let next2 = -1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const lo = Math.max(0, s - win);
      const hi = Math.min(store.length, s + win * 2);
      const e = store.edges(ch, lo, hi);
      prev = -1; next = -1; next2 = -1;
      for (let i = 0; i < e.length; i++) {
        if (e[i]! <= s) prev = e[i]!;
        else if (next < 0) next = e[i]!;
        else if (next2 < 0) { next2 = e[i]!; break; }
      }
      if (prev >= 0 && next >= 0 && next2 >= 0) break;
      if (lo === 0 && hi === store.length) break;
      win *= 4;
    }

    const sr = store.samplerate;
    const lines: string[] = [];
    let widthX0: number | null = null;
    let widthX1: number | null = null;
    let periodX0: number | null = null;
    let periodX1: number | null = null;

    if (prev >= 0 && next >= 0) {
      const width = (next - prev) / sr;
      widthX0 = this.toPx(prev);
      widthX1 = this.toPx(next);
      lines.push(t('hover.width', { duration: formatDuration(width) }));
      lines.push(t('hover.widthInv', { freq: formatFreq(1 / width) }));
      if (next2 >= 0) {
        const period = (next2 - prev) / sr;
        periodX0 = this.toPx(prev);
        periodX1 = this.toPx(next2);
        lines.unshift(t('hover.freq', { freq: formatFreq(1 / period) }));
        lines.unshift(t('hover.duty', { pct: ((width / period) * 100).toFixed(2) }));
      }
    } else {
      lines.push(t('hover.noTransition'));
    }

    this.hover = {
      pointerX: cssX,
      rowTop: box.top,
      rowBand: box.band,
      color: this.channels[ch]?.color ?? channelColor(ch),
      widthX0, widthX1, periodX0, periodX1,
      lines,
    };
    this.dirty = true;
  }

  private setFollow(on: boolean): void {
    this.stack.setFollowLatest(on);
  }

  private syncMarkerCursor(pointerCssX: number | null): void {
    const sample = this.markerA.sample;
    const next = markerPointerCursor(
      pointerCssX, sample === null ? null : this.toPx(sample), this.markerA.isDragging,
    );
    if (next === this.markerCursor) return;
    this.markerCursor = next;
    this.el.plot.classList.toggle('marker-grab', next === 'grab');
    this.el.plot.classList.toggle('marker-grabbing', next === 'grabbing');
  }

  // ------------------------------------------------------------------ toolbar

  private wireToolbar(): void {
    this.el.connect.addEventListener('click', () => void this.connect());
    this.el.transport.addEventListener('click', () => this.primaryAction());
    must<HTMLButtonElement>('btn-open').addEventListener('click', () => {
      this.el.fileInput.value = '';
      this.el.fileInput.click();
    });
    this.el.fileInput.addEventListener('change', () => {
      const files = [...(this.el.fileInput.files ?? [])];
      if (files.length) void this.openFiles(files);
    });
    must<HTMLButtonElement>('btn-save').addEventListener('click', () => this.save());
    must<HTMLButtonElement>('btn-fit').addEventListener('click', () => {
      this.stack.zoomToFit();
      this.dirty = true;
    });
    must<HTMLButtonElement>('btn-settings').addEventListener('click', () => {
      // Keep the channel dialog and this transient menu from competing for focus.
      this.channelList.closeDialog();
      this.sidebarMenu.close('outside');
      this.languageMenu.close('outside');
      this.themeMenu.close('outside');
      this.settingsMenu.toggle(this.settingsItems());
    });
    this.el.sidebar.addEventListener('click', () => {
      this.channelList.closeDialog();
      this.settingsMenu.close('outside');
      this.languageMenu.close('outside');
      this.themeMenu.close('outside');
      this.sidebarMenu.toggle(this.sidebarItems());
    });
    this.el.language.addEventListener('click', () => {
      this.channelList.closeDialog();
      this.settingsMenu.close('outside');
      this.sidebarMenu.close('outside');
      this.themeMenu.close('outside');
      this.languageMenu.toggle(this.languageItems());
    });
    this.el.theme.addEventListener('click', () => {
      this.channelList.closeDialog();
      this.settingsMenu.close('outside');
      this.sidebarMenu.close('outside');
      this.languageMenu.close('outside');
      this.themeMenu.toggle(this.themeItems());
    });
    this.el.assistant.addEventListener('click', () => {
      this.channelList.closeDialog();
      this.settingsMenu.close('outside');
      this.sidebarMenu.close('outside');
      this.languageMenu.close('outside');
      this.themeMenu.close('outside');
      this.toggleAssistant();
    });
  }

  /**
   * The toolbar shortcut to the assistant: open it, or put back the sidebar it replaced.
   * Same selectPanel path as the sidebar menu, so the two can never disagree.
   */
  private toggleAssistant(): void {
    if (this.panel === 'assistant') {
      this.selectPanel(this.panelBeforeAssistant);
      return;
    }
    this.panelBeforeAssistant = this.panel;
    this.selectPanel('assistant');
    this.assistantPanel?.focusInput();
  }

  private settingsItems(): SettingsMenuItem[] {
    return [
      {
        label: t('settings.detailedLabels'),
        checked: this.detailedLabels,
        onPick: () => {
          const { start, end } = this.stack.view;
          const follow = this.stack.followLatest;
          this.pendingToolbarViewport = { start, end, follow };
          this.detailedLabels = !this.detailedLabels;
          this.reflectDetailedLabels();
          this.persistWorkspace();
          this.relayout();
        },
      },
    ];
  }

  private languageItems(): SettingsMenuItem[] {
    return LOCALES.map((l) => ({
      label: LOCALE_LABELS[l],
      checked: l === getLocale(),
      onPick: () => { void setLocale(l).then((r) => { if (r === 'failed') this.fail('error.localeLoad', l); }); },
    }));
  }

  private reflectDetailedLabels(): void {
    if (this.detailedLabels) document.documentElement.removeAttribute('data-toolbar-labels');
    else document.documentElement.setAttribute('data-toolbar-labels', 'off');
  }

  private workspaceSnapshot(): WorkspaceSnapshotV1 {
    return {
      version: WORKSPACE_SCHEMA_VERSION,
      detailedLabels: this.detailedLabels,
      channels: this.channels.map(({ name, color, enabled }) => ({ name, color, enabled })),
      order: [...this.order],
      capture: {
        channels: this.settings.channels,
        widthExplicit: this.widthExplicit,
        samplerate: this.settings.samplerate,
        samplerateExplicit: this.samplerateExplicit,
        thresholdVolts: this.settings.thresholdVolts,
        mode: this.settings.mode,
        seconds: this.settings.seconds,
        loopSamples: this.settings.loopSamples,
        testMode: this.settings.testMode,
        triggerEnableMask: this.settings.triggerEnableMask,
        triggerModes: { ...this.settings.triggerModes },
        preTriggerPercent: this.settings.preTriggerPercent,
      },
      busViews: this.busViews.map((bus) => cloneBusConfig(bus)),
      bankBusDrafts: Object.fromEntries([...this.bankBusDrafts]
        .map(([start, config]) => [start, cloneBusConfig(config)])),
    };
  }

  private persistWorkspace(): void {
    const snapshot = this.workspaceSnapshot();
    const serialized = serializeWorkspaceSnapshot(snapshot);
    if (serialized === this.lastWorkspaceSnapshot) return;
    if (writeWorkspaceSnapshot(snapshot)) this.lastWorkspaceSnapshot = serialized;
  }

  private themeItems(): SettingsMenuItem[] {
    return THEME_MODES.map((m) => ({
      label: t(THEME_MODE_LABEL_KEYS[m]),
      checked: m === getMode(),
      onPick: () => setMode(m),
    }));
  }

  private sidebarItems(): SettingsMenuItem[] {
    return [
      {
        label: t('toolbar.sidebarDevice'),
        checked: this.panel === 'device',
        onPick: () => this.selectPanel('device'),
      },
      {
        label: t('toolbar.sidebarAnalyzers'),
        checked: this.panel === 'analyzers',
        onPick: () => this.selectPanel('analyzers'),
      },
      {
        label: t('toolbar.sidebarAssistant'),
        checked: this.panel === 'assistant',
        onPick: () => this.selectPanel('assistant'),
      },
      {
        label: t('toolbar.sidebarNone'),
        checked: this.panel === null,
        onPick: () => this.selectPanel(null),
      },
    ];
  }

  private selectPanel(p: 'device' | 'analyzers' | 'assistant' | null): void {
    this.sidebarMenu.close('outside');
    this.panel = p;
    this.renderPanels();
    this.relayout();
  }

  /** Re-render every string in the shell after a locale change. */
  private retranslate(): void {
    this.settingsMenu.close('retranslate');
    this.bankBusDialog.close();
    this.sidebarMenu.close('retranslate');
    this.languageMenu.close('retranslate');
    this.themeMenu.close('retranslate');
    this.busViews = this.busViews.map((bus) => retranslateBankBusConfig(bus));
    for (const [start, draft] of this.bankBusDrafts) {
      this.bankBusDrafts.set(start, retranslateBankBusConfig(draft));
    }
    applyStaticI18n(document);
    this.relayout();       // channel cells rebuild; an open channel dialog closes here
    this.renderPanels();   // side panels + toolbar chrome
    this.assistantPanel?.render();  // its chrome only; the conversation is history
    this.renderStatus();   // status line
  }

  private progressView(): NonNullable<CapturePanelView['progress']> {
    return {
      seconds: this.captureStart > 0 ? (performance.now() - this.captureStart) / 1000 : 0,
      samples: this.captureIsLoop ? this.store.length + this.droppedTotal : this.store.length,
      bytes: this.captureIsLoop
        ? this.store.length * bytesPerSampleForChannels(this.store.channelCount)
        : this.captureBytes,
      lost: this.lostSamples,
      dropped: this.droppedTotal,
      kept: this.store.length,
      limit: this.captureIsLoop ? this.loopRetentionLen : 0,
    };
  }

  private renderPanels(): void {
    this.el.side.classList.toggle('hidden', this.panel === null);
    this.resizer.setHidden(this.panel === null);

    // Toolbar chrome is updated before the early return below, not after it. It used to be
    // after, which meant that with no side panel open - the default - starting a capture
    // left the button reading "Start" and the title reading "no capture".
    this.renderToolbarState();
    if (this.panel === null) return;

    // The assistant is mounted once and only shown or hidden: re-rendering it on every
    // state change would drop a streaming answer, a pending approval and the draft.
    const assistant = this.panel === 'assistant';
    this.el.side.classList.toggle('assistant-mode', assistant);
    this.panelHost.hidden = assistant;
    this.busPanel.hidden = this.panel !== 'analyzers';
    if (assistant && !this.assistantPanel) {
      this.assistantPanel = new AssistantPanel(this.assistantHost());
      this.el.side.appendChild(this.assistantPanel.el);
      this.assistantPanel.render();
    }
    if (this.assistantPanel) this.assistantPanel.el.hidden = !assistant;
    if (assistant) return;

    const host = this.panelHost;
    host.replaceChildren();
    if (this.panel === 'device') {
      const oscilloscopeActive = this.oscilloscopeActive();
      this.capturePanel.render({
        settings: this.settings,
        effectiveMode: effectiveCaptureMode(this.settings.mode, oscilloscopeActive),
        oscilloscopeActive,
        channels: this.channels.slice(0, this.displayChannelCount()),
        widthOptions: this.widthTiers(),
        buses: this.busViews,
        deviceName: this.device?.name ?? null,
        running: this.running,
        stopping: this.stopping,
        progress: this.running ? this.progressView() : null,
        maxSamplerateHz: this.rateCeilings,
        triggerState: this.triggerState,
      });
    } else {
      this.analyzerPanel.render({
        channels: this.channels.slice(0, this.displayChannelCount()),
        analyzers: this.analyzers,
        captureChannels: this.store.channelCount,
        hasCapture: this.store.length > 0,
        warm: this.decodeWarm,
        busy: this.decodeBusy,
      });
      this.busPanel.render({
        buses: this.busViews, channelCount: this.displayChannelCount(), captureLocked: this.running || this.stopping,
      });
    }
  }

  private primaryAction(): void {
    if (this.stopping || this.demoBusy) return;
    if (this.running) void this.stopCapture();
    else if (this.device) void this.startCapture();
    else void this.loadDemo();
  }

  /**
   * The toolbar transport is the only Start/Stop in the shell - the capture panel used to
   * carry a second pair wired to the same two methods, and the two disagreed about when a
   * capture may start.
   *
   * Always clickable while running, so a capture can be stopped even if the device
   * vanished mid-run.
   */
  private renderToolbarState(): void {
    const webusbAvailable = typeof navigator !== 'undefined' && !!navigator.usb;
    const deviceName = this.device?.name ?? null;
    this.el.connect.setAttribute('aria-label',
      deviceName ? `${t('toolbar.device')}: ${deviceName}` : t('toolbar.device'));
    this.el.connect.disabled = !webusbAvailable;
    this.el.connect.title = !webusbAvailable ? t('toolbar.noWebusb')
      : deviceName ? t('toolbar.reconnect') : t('toolbar.connectHint');
    this.el.connect.classList.toggle('connected', deviceName !== null);
    this.el.open.setAttribute('aria-label', t('toolbar.open'));
    this.el.save.setAttribute('aria-label', t('toolbar.save'));
    this.el.fit.setAttribute('aria-label', t('toolbar.fit'));
    this.el.settings.setAttribute('aria-label', t('settings.title'));
    this.el.language.setAttribute('aria-label', t('toolbar.languageTitle'));
    this.el.theme.setAttribute('aria-label', t('toolbar.themeTitle'));
    this.el.sidebar.setAttribute('aria-label', t('toolbar.sidebarTitle'));
    this.el.assistant.setAttribute('aria-label', t('toolbar.assistantTitle'));
    this.el.assistant.setAttribute('aria-pressed', String(this.panel === 'assistant'));

    const btn = this.el.transport;
    btn.setAttribute('aria-label', this.stopping ? t('toolbar.stopping')
      : this.running ? t('toolbar.stop')
        : this.device ? t('toolbar.start') : t('toolbar.demo'));
    const label = btn.querySelector<HTMLElement>('.toolbar-item-label');
    if (label) {
      label.textContent = this.stopping ? t('toolbar.shortStopping')
        : this.running ? t('toolbar.shortStop')
          : this.device ? t('toolbar.shortStart') : t('toolbar.shortDemo');
    }
    btn.classList.toggle('primary', !this.running);
    btn.classList.toggle('danger', this.running);
    btn.disabled = this.stopping || this.demoBusy;
    btn.title = this.stopping ? t('toolbar.stoppingTitle')
      : this.demoBusy ? t('toolbar.demoLoading')
        : this.running ? t('toolbar.stopTitle')
          : this.device ? t('toolbar.startTitle') : t('toolbar.demoTitle');
  }

  private renderStatus(): void {
    const store = this.store;
    const view = this.stack.view;
    const sr = store.samplerate;
    const parts: string[] = [];
    parts.push(formatCaptureLabel(this.captureLabel));
    if (store.length > 0) {
      if (this.captureIsLoop && (this.running || this.droppedTotal > 0)) {
        parts.push(t('status.loop', {
          kept: formatCount(store.length), total: formatCount(store.length + this.droppedTotal),
        }));
      } else {
        parts.push(t('status.summary', { samples: formatCount(store.length), rate: formatRate(sr) }));
        parts.push(t('status.total', { duration: formatDuration(store.length / sr) }));
      }
      parts.push(t('status.view', { duration: formatDuration((view.end - view.start) / sr) }));
    }
    // Cursor positions share the axis's origin: T=0 is the trigger sample when there
    // is one, so a pre-trigger cursor reads as the negative time the axis shows.
    const origin = this.triggerSampleIndex ?? 0;
    const markerSample = this.markerA.sample;
    if (markerSample !== null) parts.push(`A ${formatDuration((markerSample - origin) / sr)}`);

    this.el.status.replaceChildren();
    parts.forEach((p, i) => {
      if (i) {
        const s = document.createElement('span');
        s.className = 'sep';
        s.textContent = '·';
        this.el.status.appendChild(s);
      }
      const s = document.createElement('span');
      s.textContent = p;
      this.el.status.appendChild(s);
    });
    if (this.statusError) {
      const s = document.createElement('span');
      s.className = 'right err';
      s.textContent = formatStatusError(this.statusError);
      this.el.status.appendChild(s);
    }
  }

  private fail(what: MessageKey, e: unknown, vars?: MessageVars): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.statusError = { what, ...(vars ? { vars } : {}), detail: msg };
    // The console prefix is the stable message KEY, not the translated text -
    // greppable in every locale.
    console.error(`[ui] ${what}`, e);
    this.dirty = true;
  }

  /**
   * A fatal error from the device's read loop. The stream is already dead at this
   * point, so a capture still marked as running would sit there displaying samples
   * that can never grow - the 32U3 underrun abort (device layer) is the common case.
   * stop() re-throws the same error, which fail() reports once more, so the message
   * the user reads is the read loop's, not a teardown artefact.
   */
  private deviceFailed(e: unknown): void {
    this.fail('error.device', e);
    if (this.running && !this.stopping) void this.stopCapture();
  }

  // ------------------------------------------------------------------ captures

  private async openFiles(files: File[]): Promise<void> {
    try {
      this.statusError = null;
      const t0 = performance.now();
      const cap = await loadFiles(files);
      this.adoptCapture(cap.store, cap.channelNames,
        { kind: 'loaded', source: cap.sourceDescription, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      this.fail('error.openCapture', e);
    }
  }

  private async loadDemo(): Promise<void> {
    if (this.running || this.stopping || this.demoBusy || this.device) return;
    this.demoBusy = true;
    this.renderPanels();
    try {
      this.statusError = null;
      const demo = createProtocolDemoCapture();
      this.adoptCapture(demo.store, demo.channelNames, { kind: 'demo' });
      this.settings = clampSettings(
        { ...this.settings, samplerate: demo.store.samplerate },
        this.rateCeilings,
      );
      this.persistWorkspace();
      this.relayout();
      this.renderPanels();
      for (const spec of demo.analyzers) {
        if (this.store !== demo.store) break;
        await this.attachAnalyzer(spec.id, spec.channels, spec.options ?? {}, true);
      }
    } catch (e) {
      this.fail('error.demo', e);
    } finally {
      this.demoBusy = false;
      this.renderPanels();
    }
  }

  private adoptCapture(store: SampleStore, names: string[], label: CaptureLabel): void {
    this.discardDecodeState();
    this.releaseMarkerPointer();
    this.storeRef.set(store);
    this.channels = defaultChannels(store.channelCount);
    for (let i = 0; i < this.channels.length; i++) {
      // Keep real names ("SDA"); drop auto-generated ones that would just repeat the
      // D-tag next to them ("D3", "Channel 3", "3").
      const n = (names[i] ?? '').trim();
      if (n && n !== defaultChannelName(i) && n !== `Channel ${i}` && n !== String(i)) {
        this.channels[i]!.name = n;
      }
    }
    this.order = this.channels.map((c) => c.index);
    // Annotations belong to a capture; a new one invalidates them.
    for (const a of this.analyzers) {
      a.result = null; a.index = null; a.status = 'idle'; a.note = { kind: 'pending' };
    }
    this.resetBusBuilds();
    this.markerA.clear();
    this.triggerState = 'off';
    this.triggerSampleIndex = null;
    this.droppedTotal = 0;
    this.captureIsLoop = false;
    this.captureLabel = label;
    this.widthExplicit = false;
    this.settings = clampSettings(
      { ...this.settings, channels: channelWidthForProbes(store.channelCount) }, this.rateCeilings,
    );
    this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));
    this.persistWorkspace();
    this.relayout();
    this.stack.zoomToFit();
    this.renderPanels();
    this.dirty = true;
  }

  private save(): void {
    try {
      if (this.store.length === 0) throw new Error('nothing to save');
      const blob = saveLwcap(this.store, this.channels.map((c) => c.name));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.lwcap`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch (e) {
      this.fail('error.save', e);
    }
  }

  // ------------------------------------------------------------------ device

  private discardDevice(): number {
    const device = this.device;
    this.deviceEpoch += 1;
    if (device) {
      this.device = null;
      device.onError = null;
      device.terminate();
    }
    return this.deviceEpoch;
  }

  private detachDevice(): number {
    const epoch = this.discardDevice();
    if (this.running || this.stopping) {
      this.running = false;
      this.stopping = false;
      this.finishCapture();
    }
    return epoch;
  }

  private installDevice(d: Device, epoch: number): boolean {
    if (epoch !== this.deviceEpoch && this.device !== null) {
      d.terminate();
      return false;
    }
    const previous = this.device;
    this.deviceEpoch += 1;
    if (previous && previous !== d) {
      this.device = null;
      previous.onError = null;
      previous.terminate();
      if (this.running || this.stopping) {
        this.running = false;
        this.stopping = false;
        this.finishCapture();
      }
    }
    d.onError = (e) => this.deviceFailed(e);
    this.device = d;
    this.noteTransport();
    this.adoptDeviceChannels(d);
    this.renderPanels();
    return true;
  }

  private async reconnectGranted(): Promise<void> {
    try {
      if (!navigator.usb) return;
      let epoch = this.deviceEpoch;
      let d = await acquireGranted();
      if (!d) {
        if (this.device !== null) epoch = this.detachDevice();
        d = await acquireGranted();
      }
      if (d) this.installDevice(d, epoch);
    } catch (e) {
      // Not fatal: the device may be claimed by sigrok-cli, or unplugged.
      this.fail('error.reconnect', e);
    }
  }

  private async connect(): Promise<void> {
    try {
      this.statusError = null;
      let epoch = this.deviceEpoch;
      let d: Device;
      try {
        d = await requestDeviceOnBestThread();
      } catch (error) {
        if (cancelledByUser(error)) return;
        if (this.device === null) throw error;
        epoch = this.detachDevice();
        try {
          d = await requestDeviceOnBestThread();
        } catch (retry) {
          if (cancelledByUser(retry)) return;
          throw retry;
        }
      }
      this.installDevice(d, epoch);
    } catch (e) {
      this.fail('error.connect', e);
    }
  }

  /**
   * The worker is the transport that keeps a re-arm from waiting on this thread, so a
   * silent fall back to the page is worth saying out loud - it is the difference between
   * a capture that survives a 30 ms garbage collection at 800 MB/s and one that does not.
   */
  private noteTransport(): void {
    if (!(this.device instanceof WorkerSlogicDevice) && workerTransport.lastFallbackReason) {
      console.warn(
        '[slogic] capturing on the page thread: the worker transport could not open the ' +
        `device (${workerTransport.lastFallbackReason})`,
      );
    }
  }

  private async usbControl(command: string): Promise<string> {
    if (!this.device) throw new Error('no device connected');
    if (!this.device.usbControl) throw new Error('this device does not expose a USB console');
    return this.device.usbControl(command);
  }

  /** Grow the channel model when a wider SLogic board is connected. */
  private adoptDeviceChannels(device: Device): void {
    this.rateCeilings = device.maxSamplerateHz ?? MAX_SAMPLERATE_HZ;
    const max = device.maxChannels ?? this.channels.length;
    if (!isChannelCount(max)) {
      throw new Error(`device reported unsupported channel count ${max}`);
    }
    const width = this.widthExplicit && this.settings.channels < max ? this.settings.channels : max;
    const samplerate = connectSamplerate({
      current: this.settings.samplerate,
      explicit: this.samplerateExplicit,
      channels: width,
      ceilings: this.rateCeilings,
    });
    if (this.store.length === 0 && max !== this.store.channelCount) {
      // The empty store is still rendered before Start is pressed. Grow it together with
      // the channel rows; otherwise row 16 of a newly-connected 32U3 is queried against
      // the initial 16-channel placeholder and WaveformRenderer rejects it as out of range.
      this.releaseMarkerPointer();
      this.storeRef.set(createSampleStore(max, samplerate));
    }
    if (this.store.length === 0 && max !== this.channels.length) {
      this.channels = defaultChannels(max);
      this.order = this.channels.map((c) => c.index);
    }
    this.settings = clampSettings(
      { ...this.settings, channels: width, samplerate }, this.rateCeilings,
    );
    this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));
    this.persistWorkspace();
    this.relayout();
  }

  private async startCapture(): Promise<void> {
    if (this.running || this.stopping) return;
    if (!this.device) { this.fail('error.start', new Error('no device connected')); return; }
    const device = this.device;
    try {
      this.statusError = null;
      this.startMutatedCapture = false;
      const cfg: CaptureConfig = {
        channels: this.settings.channels,
        samplerate: this.settings.samplerate,
        thresholdVolts: this.settings.thresholdVolts,
        testMode: this.settings.testMode,
      };
      // The device layer maps volts to a DAC code; check it lands somewhere sane before
      // the capture rather than discovering a clipped threshold in the data.
      const code = vrefCode(cfg.thresholdVolts);
      if (code === 0 || code === 1023) {
        throw new Error(`threshold ${cfg.thresholdVolts} V clips the DAC (code ${code})`);
      }
      const mode = effectiveCaptureMode(this.settings.mode, this.oscilloscopeActive());
      const isLoop = mode === 'loop';
      const store = createSampleStore(cfg.channels, cfg.samplerate);
      this.discardDecodeState();
      this.releaseMarkerPointer();
      this.storeRef.set(store);
      this.resetBusBuilds();
      const masks = this.channels.map((c) => c.enabled);
      const model = Math.max(cfg.channels, this.device?.maxChannels ?? this.channels.length);
      this.channels = defaultChannels(model).map((c) => ({ ...c, enabled: masks[c.index] ?? true }));
      this.order = this.channels.map((c) => c.index);
      this.persistWorkspace();
      for (const a of this.analyzers) {
        a.result = null; a.index = null; a.status = 'idle'; a.note = { kind: 'pending' };
      }
      this.captureBytes = 0;
      this.lostSamples = 0;
      this.droppedTotal = 0;
      this.captureIsLoop = isLoop;
      this.triggerSampleIndex = null;
      const softwareTrigger = this.settings.softwareTrigger;
      this.captureStart = softwareTrigger ? 0 : performance.now();
      const postTriggerSamples = mode === 'timer'
        ? Math.min(MAX_SAMPLES - 1, Math.round(this.settings.seconds * cfg.samplerate))
        : MAX_SAMPLES - 1;
      this.captureLimitSamples = postTriggerSamples;
      this.startMutatedCapture = true;
      this.triggerState = softwareTrigger ? 'waiting' : 'off';
      this.captureLabel = { kind: 'capturing', channels: cfg.channels, rate: cfg.samplerate };
      this.running = true;
      this.runningPanelAt = 0;
      this.relayout();
      // Show a window rather than the whole (empty) capture, and follow the live edge.
      const span = Math.max(1000, Math.round(cfg.samplerate * 0.05));
      this.stack.setViewport(0, span);
      this.setFollow(true);
      this.renderPanels();

      const bytesPerSample = bytesPerSampleForChannels(cfg.channels);
      this.loopRetentionLen = isLoop
        ? clampLoopSamples(this.settings.loopSamples, cfg.channels)
        : 0;
      this.draw();
      this.el.hint.style.display = 'none';
      const triggerConditions = this.settings.triggerConditions.length
        ? this.settings.triggerConditions
        : [{ channel: this.settings.triggerChannel, kind: this.settings.triggerKind,
          level: this.settings.triggerLevel }];
      // The pre-trigger ring is a percent of the capture's own budget: the timer/free
      // post-trigger length, or the loop window (the trigger's position inside it).
      const preTriggerBase = isLoop ? this.loopRetentionLen : postTriggerSamples;
      const preTriggerSamples = softwareTrigger ? Math.min(
        Math.max(0, preTriggerBase - 1),
        Math.max(0, Math.floor(preTriggerBase * this.settings.preTriggerPercent / 100)),
        Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSampleForChannels(cfg.channels)),
      ) : 0;
      if (softwareTrigger && !isLoop) {
        // Timer duration starts at the trigger sample. The store budget therefore
        // includes the retained prefix plus the requested post-trigger duration.
        // In free-run mode `post` is already the store ceiling, so this clamp trims
        // the post-trigger window, not the prefix - the trigger keeps its full ring.
        this.captureLimitSamples = Math.min(MAX_SAMPLES - 1, postTriggerSamples + preTriggerSamples);
      }
      await device.start(cfg, (chunk) => {
        // Chunks arriving while `stopping` are the drained tail of this capture - the
        // reads that had already completed when stop began, plus the flushed coalescing
        // block. Dropping them truncated every manually stopped capture by up to one
        // sink block (~10 ms at 32ch/200M).
        if (!this.running && !this.stopping) return;
        if (isLoop) {
          this.captureBytes += chunk.length;
          store.append(chunk);
          this.enforceLoopRetention(this.storeRef);
          this.dirty = true;
          return;
        }
        const room = (this.captureLimitSamples - store.length) * bytesPerSample;
        if (room <= 0) { void this.stopCapture(); return; }
        // Count what is actually kept: a truncated tail chunk must not inflate the
        // progress readout past the capture.
        this.captureBytes += Math.min(room, chunk.length);
        store.append(room < chunk.length ? chunk.subarray(0, room) : chunk);
        this.dirty = true;
        if (store.length >= this.captureLimitSamples) void this.stopCapture();
      }, (pos, missing) => {
        // A transfer the device could not fill. Append filler for the lost samples so
        // store time keeps tracking device time, then mark that span untrusted.
        //
        // The anchor is `store.length`, not `pos`. They are the same number by
        // construction - onDropout fires after deliver(), which has already handed the
        // short transfer's payload to the sink above - but the store's own length is the
        // invariant that has to hold, and the two cases where they can diverge are both
        // already handled: the sink returns early when !running (checked here too) and
        // when the capture is full (appendLostSamples then finds no room and returns 0).
        if (!this.running && !this.stopping) return;
        // `pos` is not the anchor, but it is a free cross-check on the invariant, and a
        // silent divergence here would misplace every gap in the capture. Reported once.
        if (pos !== store.length + this.droppedTotal && this.lostSamples === 0) {
          this.fail('error.dropoutAccounting',
            new Error(`device counted ${pos} samples delivered, store holds ${store.length + this.droppedTotal}`));
        }
        const n = appendLostSamples(store, missing, this.captureLimitSamples);
        if (n === 0) return;
        this.lostSamples += n;
        if (isLoop) { this.enforceLoopRetention(this.storeRef); return; }
        if (store.length >= this.captureLimitSamples) void this.stopCapture();
      }, softwareTrigger ? {
        // A loop capture windows the triggered stream downstream of the trigger: the
        // trigger's budget is unbounded (maxSamples Infinity), the store drops the
        // front, and the trigger marker shifts with each drop until it falls off.
        ...(isLoop ? { loop: true } : {}),
        // The transport says when bounded delivery is complete (trigger budget emitted,
        // or finite host budget delivered). This is the stop signal that does not depend
        // on this side's sample arithmetic agreeing with the transport's to the sample.
        onEnd: () => { if (this.running) void this.stopCapture(); },
        softwareTrigger: {
          channels: cfg.channels,
          conditions: triggerConditions.map((c) => ({
            channel: Math.min(c.channel, cfg.channels - 1), kind: c.kind, level: c.level,
          })),
          channel: Math.min(triggerConditions[0]!.channel, cfg.channels - 1),
          kind: triggerConditions[0]!.kind,
          level: triggerConditions[0]!.level,
          preTriggerSamples,
          maxSamples: isLoop ? Number.POSITIVE_INFINITY : this.captureLimitSamples,
          searchLimitSamples: Number.POSITIVE_INFINITY,
        },
        onTriggerState: (state, triggerSampleIndex) => {
          this.triggerState = state;
          if (state === 'triggered' && triggerSampleIndex !== undefined) {
            this.triggerSampleIndex = triggerSampleIndex;
            this.captureStart = performance.now();
          }
          this.dirty = true;
          this.relayout();
          this.renderPanels();
          if (state === 'not-found') void this.stopCapture();
        },
      } : {
        // Timer and non-loop free captures use a host-side sample budget known before
        // RUN. Software-trigger mode cannot use it: where the trigger will land is not
        // known when the device is armed, and a finite budget could end the capture
        // before the trigger arrives. A loop capture is unbounded too - and opts out
        // of the first-byte and underrun watchdogs, ending only on a manual stop or a
        // device error (HSync semantics).
        ...(isLoop ? { loop: true } : { deviceSampleLimit: this.captureLimitSamples }),
        onEnd: () => { if (this.running) void this.stopCapture(); },
      });
      if (!this.running) {
        if (this.stopPending) await this.stopPending;
        else if (this.device === device) await this.teardownDevice(device);
      }
    } catch (e) {
      this.running = false;
      if (this.startMutatedCapture) {
        this.startMutatedCapture = false;
        this.triggerState = 'off';
        this.triggerSampleIndex = null;
      }
      this.relayout();
      this.fail('error.startCapture', e);
      if (e instanceof TransportDeadError && this.device === device) {
        this.discardDevice();
        void this.reconnectGranted();
      }
      this.renderPanels();
    }
  }

  private enforceLoopRetention(store: SampleStore): void {
    const drop = loopDropSamples(store.length, this.loopRetentionLen);
    if (drop <= 0) return;
    store.dropFront(drop);
    this.droppedTotal += drop;
    // Bus builders need no reset: their frontier is absolute (BusBuilder skips ahead past
    // the drop), and analogFrame's cache key carries store.droppedSamples, so a stale
    // frame can never alias a new generation at the same length.
    const markerSample = this.markerA.sample;
    if (markerSample !== null && !this.markerA.isDragging) {
      this.markerA.setSample(markerSample - drop >= 0 ? markerSample - drop : null, store.length);
    }
    if (this.triggerSampleIndex !== null) {
      this.triggerSampleIndex = this.triggerSampleIndex - drop >= 0 ? this.triggerSampleIndex - drop : null;
    }
    this.hover = null;
  }

  private async stopCapture(): Promise<void> {
    if (!this.running || this.stopping) return;
    this.running = false;
    this.stopping = true;
    this.renderPanels();
    const pending = this.teardownDevice(this.device);
    this.stopPending = pending;
    try {
      await pending;
    } finally {
      this.stopping = false;
      this.stopPending = null;
    }
    this.finishCapture();
  }

  private async teardownDevice(device: Device | null): Promise<void> {
    try {
      await device?.stop();
    } catch (e) {
      this.fail('error.stopCapture', e);
      if (this.device === device) {
        this.discardDevice();
        void this.reconnectGranted();
      }
    }
  }

  private finishCapture(): void {
    this.setFollow(false);
    const sr = this.store.samplerate;
    this.captureLabel = this.triggerState === 'not-found'
      ? { kind: 'stoppedNoTrigger', samples: this.store.length }
      : { kind: 'live', samples: this.store.length, rate: sr, seconds: this.store.length / sr };
    this.stack.zoomToFit();
    this.relayout();
    this.renderPanels();
    this.dirty = true;
    const waiters = this.captureWaiters;
    this.captureWaiters = [];
    for (const w of waiters) w();
  }

  // ------------------------------------------------------------------ analyzers

  private discardDecodeState(): void {
    this.abort?.abort();
    this.abort = null;
    this.decodeBusy = false;
    if (this.demoAnalyzers.size === 0) return;
    const owned = new Set(this.demoAnalyzers);
    this.analyzers = this.analyzers.filter((a) => !owned.has(a.id));
    this.demoAnalyzers.clear();
  }

  private async attachAnalyzer(
    decoderId: string, channels: Record<number, number>, options: Record<string, string | number>,
    demoOwned = false,
  ): Promise<void> {
    await hydrateDecoders();
    const info = getDecoder(decoderId);
    const mapped = Object.keys(channels).map(Number).sort((a, b) => a - b);
    const laneChannel = mapped.length ? channels[mapped[mapped.length - 1]!]! : 0;
    const a: AnalyzerState = {
      id: `${decoderId}-${this.nextAnalyzer++}`,
      decoderId,
      label: info.name,
      color: analyzerColor(this.analyzers.length),
      channels,
      options,
      laneChannel,
      result: null,
      index: null,
      status: 'idle',
      note: { kind: 'pending' },
    };
    this.analyzers.push(a);
    if (demoOwned) this.demoAnalyzers.add(a.id);
    this.renderPanels();
    await this.runDecode(a.id);
  }

  private removeAnalyzer(id: string): void {
    this.demoAnalyzers.delete(id);
    this.analyzers = this.analyzers.filter((a) => a.id !== id);
    this.relayout();
    this.renderPanels();
  }

  private async runDecode(id: string): Promise<void> {
    const a = this.analyzers.find((x) => x.id === id);
    if (!a) return;
    const store = this.store as CountingStore;
    const controller = new AbortController();
    const stale = (): boolean => this.store !== store || !this.analyzers.includes(a);
    try {
      this.statusError = null;
      if (store.length === 0) throw new Error('no capture to decode');
      // A loop capture decodes as a snapshot: the edge extraction below is one
      // synchronous pass on this thread, so no append or drop can interleave, and
      // the result is labelled as not tracking the still-running capture. The flag is
      // read here, not when the note is built: a decode that starts against a running
      // window and finishes after the user stops is still a snapshot of an older window
      // (`running`/`stopping` are both false by then, and the window slid meanwhile).
      const snapshotDecode = this.captureIsLoop && (this.running || this.stopping);
      // [src/decode/limits.ts] annotation spans are Int32Array, so 2^31-1 is a hard
      // ceiling - 10.7 s at 200 MSa/s, which this bench can actually reach.
      if (store.length > MAX_SAMPLE) {
        throw new Error(
          `capture is ${formatCount(store.length)} samples; decode is limited to ` +
          `${formatCount(MAX_SAMPLE)} (10.7 s at 200 MSa/s).` +
          (this.captureIsLoop ? ' Shrink the loop window instead.' : ' Decode a sub-range instead.'));
      }
      const used = [...new Set(Object.values(a.channels).filter((v) => v >= 0))];
      let edgeTotal = 0;
      for (const c of used) {
        edgeTotal += store.edgeCount
          ? store.edgeCount(c, 0, store.length)
          : store.edges(c, 0, store.length).length;
      }
      // [src/decode/limits.ts] past ~80 M edges Pyodide corrupts rather than failing, so
      // the budget stops at 48 M where refusing is still possible.
      if (edgeTotal > EDGE_BUDGET) {
        throw new Error(
          `${formatCount(edgeTotal)} edges on the mapped channels exceeds the ` +
          `${formatCount(EDGE_BUDGET)} decode budget. Disable a channel or ` +
          (this.captureIsLoop ? 'shrink the loop window.' : 'zoom the capture down.'));
      }

      a.status = 'decoding';
      a.note = { kind: 'edges', count: edgeTotal };
      this.decodeBusy = true;
      this.abort = controller;
      this.renderPanels();

      // [src/decode] only channels the stack maps are read; supplying real edge lists for
      // the rest was 34% of wall time on a 16-channel 2 M-edge capture.
      const empty: ChannelEdges = { edges: new Int32Array(0), initial: 0 };
      const chans: ChannelEdges[] = Array.from({ length: store.channelCount }, () => empty);
      for (const c of used) {
        chans[c] = { edges: store.edges(c, 0, store.length), initial: levelAt(store, c, 0) };
      }
      const req: DecodeRequest = {
        samplerate: store.samplerate,
        length: store.length,
        channels: chans,
        stack: [{ id: a.decoderId, instanceId: a.id, channels: a.channels, options: a.options }],
      };
      const t0 = performance.now();
      const result: DecodeResult = await this.decodeClient.decode(
        req, { timeoutMs: 120_000, signal: controller.signal });
      if (stale()) return;
      a.result = result;
      a.index = new AnnotationIndex(result);
      a.status = 'done';
      a.note = {
        kind: 'stats',
        anns: result.annotations.count,
        decodeMs: result.decodeMs,
        wallMs: performance.now() - t0,
        ...(snapshotDecode ? { snapshot: true as const } : {}),
        // The decoder's own first error is diagnostic payload: appended raw.
        ...(result.errors.length ? { firstError: result.errors[0]! } : {}),
      };
    } catch (e) {
      if (stale()) return;
      a.status = 'error';
      a.note = e instanceof DecodeTimeoutError ? { kind: 'timeout' as const }
        : e instanceof DecodeCancelledError ? { kind: 'cancelled' as const }
          : { kind: 'error' as const, detail: e instanceof Error ? e.message : String(e) };
      this.fail('error.decode', e, { id: a.decoderId });
    } finally {
      if (this.abort === controller) {
        this.decodeBusy = false;
        this.abort = null;
      }
      this.relayout();
      this.renderPanels();
      this.dirty = true;
    }
  }

  // ------------------------------------------------------------------ assistant

  /** Enable exactly `list`, ignoring channels the device lacks. */
  private setEnabledChannels(list: number[]): void {
    const want = new Set(list.filter((i) => i >= 0 && i < this.displayChannelCount()));
    if (want.size === 0) return;   // never zero rows
    const locked = lockedChannelBanks(this.busViews, this.displayChannelCount());
    for (const c of this.channels) {
      if (c.index >= this.displayChannelCount()) continue;
      c.enabled = want.has(c.index) || locked.has(channelBankStart(c.index));
    }
    this.afterChannelChange();
  }

  /**
   * The app as the assistant sees it (src/assistant/tools.ts). Every method routes through
   * the path a button or `debug` already uses, so a tool cannot reach a state the UI
   * could not.
   */
  private assistantHost(): AssistantHost {
    return {
      snapshot: () => ({
        connected: this.device !== null,
        device: this.device?.name ?? null,
        running: this.running,
        stopping: this.stopping,
        error: this.statusError ? formatStatusError(this.statusError) : '',
        label: formatCaptureLabel(this.captureLabel),
        samples: this.running && this.captureIsLoop ? this.store.length + this.droppedTotal : this.store.length,
        dropped: this.droppedTotal,
        samplerate: this.store.samplerate,
        channelCount: this.store.channelCount,
        triggerState: this.triggerState,
        triggerSampleIndex: this.triggerSampleIndex,
        settings: this.settings,
        rateCeilings: this.rateCeilings,
        enabledChannels: this.enabledChannels().map((c) => c.index),
        channelNames: this.channels.map((c) => c.name),
        view: { start: this.stack.view.start, end: this.stack.view.end },
        decoderReady: this.decodeWarm,
      }),
      store: () => this.store,
      analyzers: () => this.analyzers.map((a) => ({
        decoderId: a.decoderId,
        channels: a.channels,
        options: a.options,
        status: a.status,
        note: formatAnalyzerNote(a.note),
        result: a.result,
      })),
      applySettings: (patch, enabled) => {
        if (enabled) this.setEnabledChannels(enabled);
        this.debug.setSettings(patch);
      },
      startAndWait: async (timeoutMs, signal): Promise<CaptureOutcome> => {
        const finished = new Promise<void>((r) => this.captureWaiters.push(r));
        await this.startCapture();
        if (!this.running) {
          this.captureWaiters = [];
          return 'not-started';
        }
        let timer = 0;
        const outcome = await Promise.race([
          finished.then(() => 'finished' as const),
          new Promise<'timeout'>((r) => { timer = window.setTimeout(() => r('timeout'), timeoutMs); }),
          new Promise<'timeout'>((r) => signal.addEventListener('abort', () => r('timeout'), { once: true })),
        ]);
        window.clearTimeout(timer);
        return outcome;
      },
      stop: () => this.stopCapture(),
      loadDemo: () => this.loadDemo(),
      attach: (id, channels, options) => this.attachAnalyzer(id, channels, options),
      removeAnalyzer: (index) => {
        const a = this.analyzers[index];
        if (!a) return false;
        this.removeAnalyzer(a.id);
        return true;
      },
      setViewportSeconds: (a, b) => this.debug.setViewportSeconds(a, b),
      zoomToAnnotation: (analyzer, n) => this.debug.zoomToAnnotation(analyzer, n),
      levelAt: (channel, sample) => levelAt(this.store, channel, sample),
      // The same paths the bus panel uses.
      buses: () => this.busViews.map((b) => ({ config: b, built: b.builder?.done ?? false })),
      addBus: (cfg) => {
        if (this.addBus(cfg) === null) throw new Error(BUS_CAPTURE_LOCK_ERROR);
      },
      updateBus: (index, cfg) => {
        const b = this.busViews[index];
        if (b && !this.updateBus(b.id, cfg)) throw new Error(BUS_CAPTURE_LOCK_ERROR);
      },
      removeBus: (index) => {
        const b = this.busViews[index];
        if (b && !this.removeBus(b.id)) throw new Error(BUS_CAPTURE_LOCK_ERROR);
      },
    };
  }

  // ------------------------------------------------------------------ test surface

  /**
   * What `src/ui/tools/run-ui.mjs` drives. It exists so the evidence in NOTES.md is
   * produced by a re-runnable script rather than by a screenshot somebody took once, and
   * so that script does not have to reach into private fields.
   *
   * Every method here is one a button also calls, so driving it exercises the shipping
   * path rather than a parallel one built for the test.
   */
  readonly debug = {
    connect: () => this.connect(),
    setLocale: (l: Locale) => setLocale(l),
    getLocale: () => getLocale(),
    setTheme: (id: ThemeId) => setMode(id === 'default' ? 'dark' : id),
    getTheme: () => getTheme(),
    getMode: () => getMode(),
    start: () => this.startCapture(),
    stop: () => this.stopCapture(),
    demo: () => this.loadDemo(),
    attach: (id: string, ch: Record<number, number>, opts: Record<string, string | number> = {}) =>
      this.attachAnalyzer(id, ch, opts),
    setSettings: (s: Partial<CaptureSettings>) => {
      this.applySettings({ ...this.settings, ...s });
    },
    /** Add a parallel-bus view; missing fields take the panel's defaults. */
    addBus: (cfg: Partial<BusViewConfig> & { spec: BusViewConfig['spec'] }) =>
      this.addBus({ ...defaultBusConfig(this.displayChannelCount()), ...cfg }),
    removeBus: (id: string) => this.removeBus(id),
    buses: () => this.busViews.map((b) => ({
      id: b.id, name: b.name, color: b.color, summary: busSummary(b.spec), hideSources: b.hideSources,
      built: b.builder?.done ?? false, progress: b.builder?.progress ?? 0,
    })),
    setPanel: (p: 'device' | 'analyzers' | 'assistant' | null) => {
      this.selectPanel(p);
    },
    setViewportSeconds: (a: number, b: number) => {
      const sr = this.store.samplerate;
      this.stack.setViewport(a * sr, b * sr);
      this.dirty = true;
    },
    setMarker: (sample: number | null) => {
      this.releaseMarkerPointer();
      this.markerA.setSample(sample, this.store.length);
      this.dirty = true;
    },
    marker: () => ({
      label: this.markerA.label,
      color: this.markerA.color,
      sample: this.markerA.sample,
      dragging: this.markerA.isDragging,
      started: this.markerA.started,
      pointerId: this.markerA.pointerId,
      channel: this.markerA.channel,
      cursor: this.markerCursor,
    }),
    edges: (channel: number, lo: number, hi: number) => {
      const store = this.store;
      if (!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount) return [];
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return [];
      const start = Math.max(0, lo);
      const end = Math.min(store.length, hi);
      if (start >= end) return [];
      return Array.from(store.edges(channel, start, end));
    },
    hoverAt: (cssX: number, cssY: number) => this.updateHover(cssX, cssY),
    toggleChannel: (i: number, on: boolean) => this.setChannelEnabled(i, on),
    rename: (i: number, name: string) => {
      const current = this.channels[i];
      if (current) {
        this.configureChannel(i, {
          name, mode: this.settings.triggerModes[i] ?? DEFAULT_TRIGGER_MODE, color: current.color,
        });
      }
    },
    setTriggerMode: (channel: number, mode: TriggerMode) => {
      const current = this.channels[channel];
      if (current) {
        this.configureChannel(channel, { name: current.name, mode, color: current.color });
      }
    },
    reorder: (from: number, to: number) => this.reorder(from, to),
    /**
     * Save this capture as `.lwcap` and load it straight back, comparing every channel's
     * edge list. The format stores transitions rather than samples, so a round trip is
     * the only thing that proves the replay reconstructs the stream - a file that writes
     * and reads consistently but reconstructs wrongly would otherwise look fine.
     */
    roundTripLwcap: async () => {
      const store = this.store;
      const before = { n: store.channelCount, sr: store.samplerate, len: store.length };
      const blob = saveLwcap(store, this.channels.map((c) => c.name));
      const back = loadLwcap(await blob.arrayBuffer(), 'round-trip');
      const problems: string[] = [];
      if (back.store.channelCount !== before.n) problems.push('channelCount');
      if (back.store.samplerate !== before.sr) problems.push('samplerate');
      if (back.store.length !== before.len) problems.push(`length ${back.store.length} != ${before.len}`);
      let edges = 0;
      for (let c = 0; c < before.n && problems.length === 0; c++) {
        const a = store.edges(c, 0, before.len);
        const b = back.store.edges(c, 0, before.len);
        edges += a.length;
        if (a.length !== b.length) { problems.push(`ch${c} edge count ${a.length} != ${b.length}`); break; }
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) { problems.push(`ch${c} edge ${i}: ${a[i]} != ${b[i]}`); break; }
        }
      }
      return { bytes: blob.size, edges, ok: problems.length === 0, problems };
    },
    /** Centre the view on the nth annotation of an analyzer, with `pad` spans either side.
     *  Used by the screenshot driver so a shot lands on real traffic instead of on luck. */
    zoomToAnnotation: (analyzerIndex: number, n: number, pad = 3) => {
      // -1 means "the last analyzer that actually has a result", which is what a driver
      // wants after a new capture cleared the earlier ones.
      const a = analyzerIndex >= 0
        ? this.analyzers[analyzerIndex]
        : [...this.analyzers].reverse().find((x) => x.result);
      if (!a?.result || a.result.annotations.count <= n) return false;
      const { start, end } = a.result.annotations;
      const s = start[n]!;
      const e = Math.max(end[n]!, s + 1);
      const w = (e - s) * (1 + 2 * pad);
      this.stack.setViewport(s - (e - s) * pad, s - (e - s) * pad + w);
      this.dirty = true;
      return true;
    },
    snapshot: () => ({
      label: formatCaptureLabel(this.captureLabel),
      theme: getTheme(),
      error: this.statusError ? formatStatusError(this.statusError) : '',
      running: this.running,
      stopping: this.stopping,
      device: this.device?.name ?? null,
      transport: this.device instanceof WorkerSlogicDevice ? 'worker' : 'page',
      transportFallback: workerTransport.lastFallbackReason,
      warm: this.decodeWarm,
      samples: this.running && this.captureIsLoop ? this.store.length + this.droppedTotal : this.store.length,
      dropped: this.droppedTotal,
      samplerate: this.store.samplerate,
      channels: this.store.channelCount,
      triggerState: this.triggerState,
      triggerSampleIndex: this.triggerSampleIndex,
      trigger: {
        enabled: this.settings.softwareTrigger,
        enableMask: this.settings.triggerEnableMask,
        preTriggerPercent: this.settings.preTriggerPercent,
        modes: { ...this.settings.triggerModes },
        conditions: this.settings.triggerConditions,
      },
      enabled: this.enabledChannels().map((c) => c.index),
      rows: this.stack.rowSpecs.map((r) => `${r.kind}:${r.channel}:${r.heightCss}`),
      lanes: this.lanes.length,
      view: { start: this.stack.view.start, end: this.stack.view.end },
      analyzers: this.analyzers.map((a) => ({
        id: a.id,
        decoder: a.decoderId,
        status: a.status,
        message: formatAnalyzerNote(a.note),
        annotations: a.result?.annotations.count ?? 0,
        laneChannel: a.laneChannel,
      })),
    }),
  };
}

/**
 * Settings are clamped, not rejected: every field here has a hard limit the device or the
 * store enforces anyway, and a value the user cannot reach is better than an error at
 * Start.
 *
 * The samplerate clamp matters because the capture width is derived, not chosen. Narrow to
 * 4 channels, pick the 800 MS/s the panel then offers, re-enable a high channel, and the
 * width jumps to 16 whose ceiling is 200 MS/s. Without this the stale 800 MS/s survived,
 * the rate dropdown - which lists only rates at or under the ceiling - rendered with no
 * selection at all, and Start threw "800 MHz exceeds the 16-channel ceiling of 200 MHz"
 * from the device layer with no visible control to fix it. Every MAX_SAMPLERATE_HZ value
 * is itself in SAMPLERATES_HZ, so the clamp always lands on a rate the device supports.
 */
function clampSettings(
  s: CaptureSettings, ceilings: Readonly<Record<number, number>> = MAX_SAMPLERATE_HZ,
): CaptureSettings {
  const samplerate = Math.min(s.samplerate, ceilings[s.channels] ?? 200e6);
  const max = MAX_SAMPLES / samplerate;
  const savedModes = s.triggerModes ?? {};
  const configuredConditions = Object.keys(savedModes).length ? modesToConditions(savedModes)
    : s.triggerConditions.length ? s.triggerConditions : s.softwareTrigger
      ? [{ channel: s.triggerChannel, kind: s.triggerKind, level: s.triggerLevel }]
      : [];
  const triggerConditions = configuredConditions
    .filter((c) => c.channel >= 0 && c.channel < s.channels)
    .map((c) => ({ ...c }));
  const triggerModes: Record<number, TriggerMode> = { ...savedModes };
  for (const c of triggerConditions) {
    triggerModes[c.channel] = triggerModeFromCondition(c);
  }
  return {
    ...s, samplerate, seconds: Math.max(0.001, Math.min(s.seconds, max)),
    loopSamples: clampLoopSamples(s.loopSamples ?? DEFAULT_LOOP_SAMPLES, s.channels),
    triggerEnableMask: s.triggerEnableMask ?? true,
    // Enable Mask is the sole global gate. Turning it off must not erase the
    // per-channel modes; turning it back on must restore the same conditions.
    softwareTrigger: s.triggerEnableMask !== false && triggerConditions.length > 0,
    triggerModes,
    triggerChannel: Math.max(0, Math.min(s.triggerChannel, s.channels - 1)),
    triggerConditions,
    preTriggerPercent: Math.max(0, Math.min(75, s.preTriggerPercent)),
  };
}

/** Configuration edits describe a future capture; they must not leave the previous
 * capture's T origin and relative axis attached to a newly selected trigger. */
function triggerSettingsChanged(a: CaptureSettings, b: CaptureSettings): boolean {
  if (a.softwareTrigger !== b.softwareTrigger || a.triggerEnableMask !== b.triggerEnableMask ||
      a.triggerChannel !== b.triggerChannel || a.triggerKind !== b.triggerKind ||
      a.triggerLevel !== b.triggerLevel || a.preTriggerPercent !== b.preTriggerPercent ||
      a.triggerConditions.length !== b.triggerConditions.length) return true;
  const am = a.triggerModes ?? {};
  const bm = b.triggerModes ?? {};
  const modeKeys = new Set([...Object.keys(am), ...Object.keys(bm)]);
  for (const key of modeKeys) if (am[Number(key)] !== bm[Number(key)]) return true;
  return a.triggerConditions.some((x, i) => {
    const y = b.triggerConditions[i];
    return !y || x.channel !== y.channel || x.kind !== y.kind || x.level !== y.level;
  });
}

async function acquireGranted(): Promise<Device | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const found = (await getGrantedDevicesOnBestThread())[0];
      if (found) return found;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return undefined;
}

function cancelledByUser(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError';
}

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html is missing #${id}`);
  return el as T;
}

export { COLORS };
