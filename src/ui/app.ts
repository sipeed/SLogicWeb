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
import { DROP_FRONT_QUANTUM, type SampleStore } from '../data/types.js';
import { bytesPerSampleForChannels, channelWidthForProbes, isChannelCount } from '../types.js';
import { DiagnosticError, diagnosticOf } from '../diagnostics.js';
import {
  MAX_SAMPLERATE_HZ, SAMPLERATES_HZ, TransportDeadError, getGrantedDevicesOnBestThread,
  requestDeviceOnBestThread, vrefCode, type CaptureConfig, type Device,
} from '../device/index.js';
import { WorkerSlogicDevice, workerTransport } from '../device/workerTransport.js';
import { wheelSpanFactor } from '../render/index.js';
import {
  AnnotationIndex, DecodeCancelledError, DecodeTimeoutError, EDGE_BUDGET, MAX_SAMPLE,
  annotationTexts, displayRows, getDecoder, hydrateDecoders, rowForClass, sharedDecodeClient,
} from '../decode/index.js';
import type { ChannelEdges, DecodeRequest, DecodeResult } from '../decode/index.js';

import type { AssistantHost, CaptureOutcome } from '../assistant/tools.js';

import { AnalyzerPanel } from './analyzerPanel.js';
import { AssistantPanel } from './assistantPanel.js';
import { BusBuilder, validateBusSpec } from '../data/busValue.js';
import { BusPanel, cloneBusConfig, defaultBusConfig } from './busPanel.js';
import {
  analogFrame, applyBusBitOrder, beginAnalogFrameBudget, busColor, busLabel, busSummary,
  busValueAt, busYRange, endAnalogFrameBudget, type AnalogFrame,
  type BusViewConfig, type BusViewState,
} from './busView.js';
import { layoutBubbles, type AnnotationSpan, type Bubble } from './annotationLayout.js';
import { CapturePanel, cursorDistanceSideId, cursorEdgeSideId,
  type CapturePanelState, type CapturePanelView, type CursorDistanceRowView,
  type CursorDistanceSideView, type CursorEdgeChannelView, type CursorEdgeRowView,
  type CursorRowView, type LoopDisplayMetrics, type TriggerStatusView } from './capturePanel.js';
import {
  ANALOG_GROUP_COUNT, ADC_FULL_SCALE_V, ADC_OFFSET_V, CHANNEL_BANK_SIZE, analogBankActive,
  analogBusConfig, analogCodeFromVolts, analogGroupCount, analogSamplerates, analogTriggerVolts,
  busChannelBank,
  captureWidthTiers, channelBankIndices, channelBankStart, busOutOfWidth, lockedChannelBanks,
} from './channelBanks.js';
import { ChannelList, type BusCell, type BusScopePatch, type ChannelCell, type ChannelConfiguration } from './channelList.js';
import { computeChannelRowHeight } from './channelLayout.js';
import {
  MAX_SAMPLES, levelAt, loadFiles, loadLwcap, saveLwcap,
} from './captureIO.js';
import { connectSamplerate } from './connectDefaults.js';
import { formatCursorTimes } from './cursorTime.js';
import { sameUsbDevice } from './deviceIdentity.js';
import { formatCount, formatDuration, formatFreq, formatRate,
  formatAnalyzerNote, formatCaptureLabel, formatStatusError,
  formatStatusErrorDebug, statusDetailOf } from './format.js';
import { applyStaticI18n, getLocale, LOCALE_LABELS, LOCALES, onLocaleChange, setLocale, t,
  type Locale, type MessageKey, type MessageVars } from './i18n.js';
import { getMode, getTheme, onThemeChange, setMode, THEME_MODES, THEME_MODE_LABEL_KEYS,
  type ThemeId } from './theme.js';
import {
  analyzerStatesFrom, nextAnalyzerSequence, readWorkspaceSnapshot, restoreOrder, serializeWorkspaceSnapshot,
  WORKSPACE_SCHEMA_VERSION, writeWorkspaceSnapshot,
  type PersistedAnalyzer, type WorkspaceSnapshotV1,
} from './workspacePreferences.js';
import { baseTheme, canvasPalette, type CanvasPalette } from './canvasPalette.js';
import { SettingsMenu, type SettingsMenuItem } from './settingsMenu.js';
import { MenuStack } from './menuStack.js';
import {
  DEFAULT_SIDEBAR_STATE, hideSidebar, selectSidebarPage, showAssistant,
  toggleAssistant as nextAssistantState, toggleSidebarVisible,
  type SidebarPage, type SidebarState,
} from './sidebar.js';
import { SidebarHost } from './sidebarHost.js';
import { shortcutIdFor } from './shortcuts.js';
import { ShortcutsDialog } from './shortcutsDialog.js';
import { AXIS, COLORS, ROWS } from './metrics.js';
import {
  Overlay, paintMarkerChip, type HoverMeasurement, type RegionTint,
} from './overlay.js';
import { OverviewStrip } from './overviewStrip.js';
import { PanelResizer } from './panelResizer.js';
import { StoreRef } from './storeRef.js';
import {
  analyzerColor, analyzerLaneChannel, defaultCaptureSettings, defaultChannels, defaultChannelName, channelColor,
  carryChannelState,
  DEFAULT_TRIGGER_MODE,
  edgeTriggerAutoArms, clampLoopSamples, DEFAULT_LOOP_SAMPLES, loopDropSamples,
  modesToConditions, triggerModeFromCondition, mappedCaptureChannels,
  type AnalogTriggerSetting, type AnalyzerState, type CaptureSettings, type ChannelState,
  type TriggerMode,
  type CaptureLabel, type StatusError,
} from './state.js';
import { stopFailureIsSilent } from './stopFailure.js';
import { computeTicks, drawAxis, type TickSet } from './timeAxis.js';
import { clampCaptureSeconds, clampRepeatIntervalSeconds } from './captureTime.js';
import { capturePostTriggerSamples, carryCaptureDuration } from './capturePolicy.js';
import { liveDrawDue } from './liveRefresh.js';
import type { CaptureStartOrigin, CaptureStopReason } from './captureViewport.js';
import {
  beginSweep, createSession, resolveSessionView, secondsRangeToSamples,
  sessionAfterTrigger, sessionWithManualView, triggerSearchSamples, type CaptureSession,
} from './captureSession.js';
import { RepeatCaptureTimer } from './repeatCapture.js';
import {
  markerEdgeWindow, markerPointerCursor, markerSnapRadii, nearestMarkerEdge, type MarkerCursor,
} from './markerGeometry.js';
import {
  cursorColor, cursorLabels, layoutCursorChips, nearestCursorGrab,
  type CursorChip, type CursorGrabCandidate, type PlacedCursorChip,
} from './cursorSet.js';
import {
  addDistanceRow as appendDistanceRow, assignDistanceCursor, clearDistancePairs, distanceCell,
  pruneDistancePairs, removeDistanceRow as dropDistanceRow, seedDistanceRow,
  type CursorDistanceRow, type DistanceSide,
} from './cursorDistance.js';
import {
  addEdgeRow as appendEdgeRow, assignEdgeChannel, assignEdgeCursor, clearEdgeCursors, countCursorEdges,
  CURSOR_EDGE_EMPTY_RESULT, pruneEdgeChannels, pruneEdgeCursors, removeEdgeRow as dropEdgeRow,
  type CursorEdgeRow,
} from './cursorEdges.js';
import { WaveformMarker, type MarkerSnapContext } from './waveformMarker.js';
import { WaveformStack, type RowBox, type RowSpec } from './waveformStack.js';
import {
  nextScopeVoltsPerDiv, scopeGeometry, scopeScaleAt, scopeVoltsAtY,
} from './scopeScale.js';
import {
  captureLocksTriggerView, clampLoopViewOffsets, loopOverviewWindow, loopPendingLimit,
  loopStoreLimit, mayReanchor, medianOfRecent, planLocalTriggerStep, reconcileTrigger,
  relativeTriggerSample, resumeTriggerFollow, triggerSlackSamples, triggerViewFraction,
  type TriggerReconcilePhase, type TriggerViewLock,
} from './triggerViewport.js';
import { AnalogCrossingScanner } from './analogCrossingScan.js';
import {
  RepeatCompositeStore, remapRepeatSample, repeatHoldReleased, repeatSurfacePixels,
  type RepeatLayerStore,
} from './repeatDisplay.js';
import { planLoopSwap } from './displaySwap.js';

/** Where Pyodide and the decoder zip live; content-hashed in hosted builds (vite.config.ts). */
declare const __LOGICWEB_RUNTIME_PATHS__: { pyodide: string; decoders: string };

/** A store that can also count edges without materialising them (native live stores do). */
type CountingStore = SampleStore & { edgeCount?(c: number, s: number, e: number): number };
type AcquireOutcome = 'connected' | 'cancelled' | 'failed';

/**
 * Hard ceiling for a rolling Loop store. The sample stores reject an append past
 * 0x7fffffff samples; a trigger lock that would need more than this must release the
 * view rather than risk that throw. The margin holds one 8 MiB delivery block at any
 * channel width (8,388,608 samples at 4 channels).
 */
const LOOP_STORE_HARD_SAMPLES = 0x7fffffff - 0x1000000;
/**
 * Above this byte rate a loop capture skips its background bus-overview builds while it
 * runs; the throttled waveform still draws every 50 ms. The builds finish after the stop.
 */
const LOOP_BUILD_SUSPEND_BYTES_PER_SEC = 160e6;

interface Lane {
  analyzer: AnalyzerState;
  /** Index into displayRows(decoder). */
  displayRow: number;
  laneChannel: number;
}

interface CursorLine {
  id: number;
  marker: WaveformMarker;
}

export class App {
  private readonly storeRef: StoreRef;
  private readonly stack: WaveformStack;
  private readonly overlay: Overlay;
  private readonly overview: OverviewStrip;
  private readonly scopeHost: HTMLDivElement;
  private readonly scopeBars = new Map<string, HTMLDivElement>();
  private readonly scopeTriggers = new Map<string, HTMLDivElement>();
  private readonly scopeScaleAnimations = new Map<string, { from: number; to: number; startedAt: number }>();
  private scopeWheelPersist: number | null = null;
  private readonly channelList: ChannelList;
  private capturePanel!: CapturePanel;
  private analyzerPanel!: AnalyzerPanel;
  private readonly sidebarHost: SidebarHost;
  /** Built on first open and never cleared: it owns a conversation and a draft. */
  private assistantPanel: AssistantPanel | null = null;
  /** Resolved when the running capture stops (the assistant waits on a capture). */
  private captureWaiters: (() => void)[] = [];
  private busPanel!: BusPanel;
  /** Parallel-bus (ADC) views, drawn as analog rows above the channels. */
  private busViews: BusViewState[] = [];
  private nextBus = 0;
  /** When the analyzers panel last re-rendered for a bus build's progress. */
  private busPanelAt = 0;
  private runningPanelAt = 0;
  /** New samples are waiting for the next data-driven redraw (HSync's status cadence). */
  private livePending = false;
  /** When the screen was last drawn for any reason, in `performance.now()` terms. */
  private liveDrawAt = 0;
  private readonly menuStack = new MenuStack();
  private readonly settingsMenu: SettingsMenu;
  private readonly languageMenu: SettingsMenu;
  private readonly themeMenu: SettingsMenu;
  private readonly shortcutsDialog: ShortcutsDialog;
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
  private readonly repeatTimer = new RepeatCaptureTimer();
  /** The current Capture -> Stop session, or null when idle. */
  private session: CaptureSession | null = null;
  /** A user pan/zoom since the last draw; the next draw records it as the fixed view. */
  private viewIntent = false;
  private get repeatSession(): boolean { return this.session?.mode === 'repeat'; }
  /** A repeat wave has started but not delivered data yet: keep the previous frame up. */
  private repeatWaveHolding = false;
  /** The previous completed Repeat wave: it fills the view until the current one reaches it. */
  private repeatFront: RepeatLayerStore | null = null;
  /** The current wave's own store (capture truth; `store` may be a Repeat composite). */
  private waveStore: SampleStore | null = null;
  /** Two-layer display for a Fixed Repeat viewport; null while following or between waves. */
  private repeatComposite: RepeatCompositeStore | null = null;
  /** The previous wave is on screen while the current one waits for its trigger. */
  private repeatShowingFront = false;
  /** The old wave's T while its frame is held, in that store's coordinates. */
  private repeatHeldTrigger: number | null = null;
  /** A Repeat wave missed its trigger; keep the note up until the next successful one. */
  private repeatMissed = false;
  /** The last manual stop adopted the held previous wave; ignore the drain's not-found. */
  private settledHeldCapture = false;
  /** Marker offset to apply once the display layer changes at a Repeat hand-over. */
  private pendingCursorDelta: number | null = null;
  /** Loop display instrumentation: inter-crossing intervals, median period estimate. */
  private loopPeriodEstimates: number[] = [];
  private loopPeriodSamples = 0;
  /** Absolute sample position of the last displayed anchor block. */
  private loopSwapCursorAbs = 0;
  private loopLastAnchorStep = 0;
  /** Capture shape of the last wave, to keep a Repeat session's layout off the wave path. */
  private lastCaptureChannels = 0;
  private lastCaptureRate = 0;
  private lastCaptureTestMode = 0;
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
  /** Pre-trigger percentage as a viewport fraction while a loop trigger is armed. */
  private triggerViewFraction = 0;
  /** A trigger fired but the anchored viewport has not been placed yet (next draw). */
  private triggerViewPending = false;
  /** The user's ViewWindow offsets relative to T, in samples (within the DurationWindow). */
  private triggerViewOffsetStart = 0;
  private triggerViewOffsetEnd = 0;
  /** Latest edge reported by the display scanner; the lock releases after a quiet window. */
  private lastAnalogCrossingAbs = Number.NEGATIVE_INFINITY;
  /** An edge seen while unlocked; the next enforce re-locks the trigger view on it. */
  private pendingRelockAbs: number | null = null;
  /** A loop trigger is anchored to a valid edge in the current data. */
  private triggerViewLock: TriggerViewLock | null = null;
  /** The capture in flight was armed with a host-side matcher. */
  private captureUsesSoftwareTrigger = false;
  /** Fixed per-capture trigger parameters a live retune must not change. */
  private captureTriggerBase: {
    preTriggerSamples: number; maxSamples: number; searchLimitSamples: number;
  } | null = null;
  /** A settings change removed every condition; the capture is restarting free-run. */
  private triggerRestartPending = false;
  /** A user Stop during an automatic trigger restart cancels the pending start. */
  private triggerRestartCancelled = false;
  /**
   * A trigger reconciliation was requested while device.start() was still arming; run it
   * after the promise settles, re-evaluating the then-current settings and trigger state.
   */
  private triggerSyncDeferred = false;
  /** True between calling device.start() and its promise settling. */
  private captureArming = false;
  /** Invalidates callbacks from a superseded acquisition (late worker messages). */
  private captureGeneration = 0;
  /** A retune was requested before the device finished arming; retry once after start. */
  private triggerRetuneRequested = false;
  /** The live analog edit cannot arm at this capture's board/rate; it is pending. */
  private triggerRetuneRejected = false;
  /** A loop trigger matched, but its sample was already dropped before the page heard. */
  private triggerViewLost = false;
  /** The trigger was released because the rolling Loop store hit its hard sample cap. */
  private triggerAutoDisarmed = false;
  /** Continuous ADC crossing detector for a locked loop analog trigger; null otherwise. */
  private analogScanner: AnalogCrossingScanner | null = null;
  /** Absolute emitted-stream positions of recent scanned ADC crossings (ascending). */
  private analogCrossings: number[] = [];
  /** Reused median scratch for the chronological period-estimate window. */
  private loopPeriodScratch: number[] = [];
  /** Extra samples the locked loop store may carry beyond its visible window. */
  private loopTriggerSlackSamples = 0;

  private captureLabel: CaptureLabel = { kind: 'none' };
  private statusError: StatusError | null = null;
  private decodeBusy = false;
  private decodeWarm = false;
  private reacquiring = false;
  private awaitingReconnect = false;
  private lostSerial = '';
  private abort: AbortController | null = null;

  private cursors: CursorLine[] = [];
  private nextCursorId = 1;
  private activeCursorId: number | null = null;
  private distanceRows: readonly CursorDistanceRow[] = [];
  private nextDistanceRowId = 1;
  private edgeRows: readonly CursorEdgeRow[] = [];
  private nextEdgeRowId = 1;
  private releaseMarkerPointer: () => void = () => {};
  private hover: HoverMeasurement | null = null;
  private markerCursor: MarkerCursor = null;

  private dirty = true;
  private sidebar: SidebarState = DEFAULT_SIDEBAR_STATE;
  private paintedTheme: ThemeId;
  private palette: CanvasPalette;

  // DOM
  private readonly el: {
    plot: HTMLDivElement; waveStack: HTMLDivElement; axis: HTMLCanvasElement;
    overview: HTMLCanvasElement;
    scroll: HTMLDivElement; main: HTMLDivElement; resizer: HTMLDivElement;
    channelList: HTMLDivElement; side: HTMLDivElement; status: HTMLDivElement;
    hint: HTMLDivElement; transport: HTMLButtonElement;
    connect: HTMLButtonElement; open: HTMLButtonElement; save: HTMLButtonElement;
    fit: HTMLButtonElement; fullscreen: HTMLButtonElement; settings: HTMLButtonElement;
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
      overview: must<HTMLCanvasElement>('overview'),
      channelList: must<HTMLDivElement>('channel-list'),
      side: must<HTMLDivElement>('side-panel'),
      status: must<HTMLDivElement>('status'),
      hint: must<HTMLDivElement>('empty-hint'),
      transport: must<HTMLButtonElement>('transport'),
      connect: must<HTMLButtonElement>('btn-connect'),
      open: must<HTMLButtonElement>('btn-open'),
      save: must<HTMLButtonElement>('btn-save'),
      fit: must<HTMLButtonElement>('btn-fit'),
      fullscreen: must<HTMLButtonElement>('btn-fullscreen'),
      settings: must<HTMLButtonElement>('btn-settings'),
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
    }
    this.analyzers = analyzerStatesFrom(workspace?.analyzers ?? []);
    this.nextAnalyzer = nextAnalyzerSequence(this.analyzers);
    this.samplerateExplicit = workspace?.capture?.samplerateExplicit === true;
    this.widthExplicit = workspace?.capture?.widthExplicit === true;
    const initialWidth = workspace?.capture?.channels ?? channelWidthForProbes(this.channels.length);
    const triggerModes = workspace?.capture?.triggerModes ?? {};
    const triggerConditions = modesToConditions(triggerModes);
    const first = triggerConditions[0];
    this.settings = this.clampSettings({
      ...defaultCaptureSettings(),
      ...(workspace?.capture ?? {}),
      channels: initialWidth,
      triggerModes,
      triggerConditions,
      triggerChannel: first?.channel ?? 0,
      triggerKind: first?.kind ?? 'rising',
      triggerLevel: first?.level ?? 1,
    });
    this.busViews = this.busViews
      .map((bus) => applyBusBitOrder(bus, this.settings.testMode));
    this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));
    this.syncBankChannels();
    this.sidebar = {
      visible: workspace?.sidebar?.visible !== false,
      page: workspace?.sidebar?.page ?? 'capture',
      assistant: false,
    };
    this.lastWorkspaceSnapshot = serializeWorkspaceSnapshot(this.workspaceSnapshot());
    this.reflectDetailedLabels();

    this.settingsMenu = new SettingsMenu(must<HTMLButtonElement>('btn-settings'));
    this.languageMenu = new SettingsMenu(this.el.language, 'language-menu');
    this.themeMenu = new SettingsMenu(this.el.theme, 'theme-menu');
    this.menuStack.register(this.settingsMenu);
    this.menuStack.register(this.languageMenu);
    this.menuStack.register(this.themeMenu);
    this.shortcutsDialog = new ShortcutsDialog();
    this.el.theme.dataset.mode = getMode();
    this.resizer = new PanelResizer(this.el.resizer, this.el.side, this.el.main);

    this.storeRef = new StoreRef(createSampleStore(channelWidthForProbes(this.channels.length), this.settings.samplerate));
    this.stack = new WaveformStack(this.el.waveStack, this.storeRef);
    this.overlay = new Overlay(this.el.plot);
    this.scopeHost = document.createElement('div');
    this.scopeHost.className = 'scope-scale-host';
    this.el.plot.appendChild(this.scopeHost);
    this.paintedTheme = getTheme();
    this.palette = canvasPalette(this.paintedTheme);
    this.overlay.setPalette(this.palette);
    this.overview = new OverviewStrip(this.el.overview, {
      // Any strip gesture leaves follow mode. The lock is not released: the strip moves
      // only the user's ViewWindow inside D, and V is clamped afterwards.
      onIntent: () => { this.beginViewportGesture(); },
      onCenter: (sample) => this.centerOverview(sample),
      onPan: (samples) => this.panOverview(samples),
      onZoom: (anchor, factor) => this.zoomOverview(anchor, factor),
    });
    this.stack.setBaseTheme(baseTheme(this.paintedTheme));
    this.channelList = new ChannelList(this.el.channelList, {
      onConfigure: (channel, config) => this.configureChannel(channel, config),
      onReorder: (from, to) => this.reorder(from, to),
      onRemoveAnalyzer: (id) => this.removeAnalyzer(id),
      onEditBus: (id) => this.editBus(id),
      onBusScope: (id, patch, commit) => this.configureBusScope(id, patch, commit),
      onBusTrigger: (id, kind, volts) => this.configureAnalogTrigger(id, kind, volts),
    });

    this.sidebarHost = new SidebarHost(this.el.side, {
      mount: (page, container) => this.mountSidebarPage(page, container),
      select: (page) => this.selectPage(page),
      collapse: () => this.handleCollapse(),
      expand: () => this.handleExpand(),
    });
    this.sidebarHost.containerFor('cursors');
    this.sidebarHost.containerFor('capture');
    this.sidebarHost.containerFor('decoders');

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
      this.menuStack.closeAll('theme');
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
    navigator.usb?.addEventListener('disconnect', (e) => this.usbDisconnected(e.device));
    navigator.usb?.addEventListener('connect', (e) => this.usbConnected(e.device));
    void this.reconnectGranted();
  }

  // ------------------------------------------------------------------ layout

  private get store(): SampleStore { return this.storeRef.target; }

  /**
   * The samples this acquisition has actually captured. `store` is the displayed store,
   * which for a Fixed Repeat viewport is a composite of the current and previous wave;
   * progress, labels, saving and the assistant must use the current wave's own store.
   */
  private get captureStore(): SampleStore { return this.waveStore ?? this.store; }

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

  /**
   * The channel rows on screen, in order: the visible channels plus enabled ones inside the
   * selected width that the capture on screen does not have. Widening the width after a
   * narrower capture must still show the new rows (the next capture fills them), and the
   * capture already taken stays as it is rather than being thrown away.
   */
  private rowChannels(): ChannelState[] {
    const hidden = new Set(this.busViews.filter((b) => b.hideSources).flatMap((b) => b.spec.bits));
    const width = this.renderChannelCount();
    return this.order.map((i) => this.channels[i]!).filter((c) =>
      c.enabled && !hidden.has(c.index) && c.index < width &&
      (this.channelAvailable(c.index) || c.index >= this.store.channelCount));
  }

  private captured(index: number): boolean {
    return index < this.store.channelCount;
  }

  private loadedCapture(): boolean {
    return this.captureLabel.kind === 'loaded';
  }

  private widthTiers(): number[] {
    const capacity = this.channels.length;
    const deviceMax = this.device?.maxChannels ?? null;
    return captureWidthTiers(deviceMax === null ? null : Math.min(deviceMax, capacity), this.loadedCapture());
  }

  private displayChannelCount(): number {
    return this.loadedCapture() ? this.channels.length : this.settings.channels;
  }

  /**
   * The width of the data currently on screen: an acquisition keeps the width it was
   * started with, so editing the pending width while it runs must not re-interpret its
   * channels. Outside a run this is the selected (next) width.
   */
  private renderChannelCount(): number {
    return this.running || this.stopping ? this.store.channelCount : this.displayChannelCount();
  }

  /**
   * Clamp with the current device ceilings, and while any bank is read as analog, with
   * the ADC module's rate rule as well. The rule depends on the candidate width, so it is
   * derived from `s`, not from the committed settings.
   */
  private clampSettings(s: CaptureSettings): CaptureSettings {
    // While a capture runs, its trigger configuration stays on the captured width even
    // when the panel's pending width shrinks; the next run re-clamps to the new width.
    const triggerChannels = this.running || this.stopping
      ? this.renderChannelCount() : s.channels;
    const clamped = clampCaptureSettings(
      s, this.rateCeilings, analogBankActive(this.busViews, s.channels), triggerChannels,
    );
    // Analog trigger levels belong to a displayed ADC group. Removing the group drops
    // the level (so re-adding it starts off), and its source inputs are not logic
    // channels, so digital conditions on them are ignored while the group is analog.
    const activeStarts = new Set(this.busViews
      .filter((bus) => bus.analogGroup !== undefined)
      .map((bus) => bus.analogGroup! * CHANNEL_BANK_SIZE));
    const analogTriggers = Object.fromEntries(Object.entries(clamped.analogTriggers)
      .filter(([start]) => activeStarts.has(Number(start)))) as Record<number, AnalogTriggerSetting>;
    // An analog trigger is single-channel in every source: keep the lowest displayed bank
    // and drop the rest, so a stored-but-inactive family can never show several badges.
    const analogStarts = Object.keys(analogTriggers).map(Number).sort((a, b) => a - b);
    if (analogStarts.length > 1) {
      const first = analogStarts[0]!;
      for (const key of Object.keys(analogTriggers)) {
        if (Number(key) !== first) delete analogTriggers[Number(key)];
      }
    }
    const hidden = this.hiddenTriggerChannels(activeStarts);
    const digitalArmed = clamped.triggerSource === 'digital' &&
      clamped.triggerConditions.some((condition) => !hidden.has(condition.channel));
    const analogArmed = clamped.triggerSource === 'analog' &&
      Object.keys(analogTriggers).length > 0;
    return {
      ...clamped, analogTriggers,
      softwareTrigger: clamped.triggerEnableMask && (digitalArmed || analogArmed),
    };
  }

  /** Inputs hidden under active analog groups: they are converter data, not logic. */
  private hiddenTriggerChannels(starts?: Set<number>): Set<number> {
    const hidden = new Set<number>();
    const banks = starts ?? new Set(this.busViews
      .filter((bus) => bus.analogGroup !== undefined)
      .map((bus) => bus.analogGroup! * CHANNEL_BANK_SIZE));
    for (const start of banks) {
      for (let offset = 0; offset < CHANNEL_BANK_SIZE; offset++) hidden.add(start + offset);
    }
    return hidden;
  }

  /** Digital conditions minus inputs hidden under analog groups, plus the analog ones. */
  private triggerPlan(s: CaptureSettings): {
    digital: CaptureSettings['triggerConditions'];
    analog: { start: number; kind: 'rising' | 'falling'; volts: number }[];
  } {
    if (s.triggerSource === 'analog') {
      // An analog source fixes the time base on one crossing; a second group would only
      // make the display jump between two edges.
      return { digital: [], analog: this.activeAnalogTriggers(s).slice(0, 1) };
    }
    const hidden = this.hiddenTriggerChannels();
    return {
      digital: s.triggerConditions.filter((condition) => !hidden.has(condition.channel)),
      analog: [],
    };
  }

  /** Analog trigger entries whose bank is currently displayed as an ADC channel. */
  private activeAnalogTriggers(
    s: Pick<CaptureSettings, 'channels' | 'analogTriggers'>,
  ): { start: number; kind: 'rising' | 'falling'; volts: number }[] {
    const out: { start: number; kind: 'rising' | 'falling'; volts: number }[] = [];
    const mapped = new Set(this.busViews
      .filter((bus) => bus.analogGroup !== undefined)
      .map((bus) => bus.analogGroup! * CHANNEL_BANK_SIZE));
    for (const start of mapped) {
      if (start + CHANNEL_BANK_SIZE > s.channels) continue;
      const trigger = s.analogTriggers?.[start];
      if (trigger) out.push({ start, kind: trigger.kind, volts: trigger.volts });
    }
    return out.sort((a, b) => a.start - b.start);
  }

  private channelAvailable(index: number): boolean {
    return index < Math.min(this.renderChannelCount(), this.store.channelCount);
  }

  // ------------------------------------------------------------------ bus views

  private busCells(): BusCell[] {
    return this.busViews.map((b) => ({
      id: b.id, name: b.name, summary: busSummary(b.spec), color: b.color, heightCss: b.heightCss,
      ...(b.analogGroup !== undefined ? {
        analog: true,
        ...(this.settings.analogTriggers[b.analogGroup * CHANNEL_BANK_SIZE]
          ? {
            trigger: this.settings.analogTriggers[b.analogGroup * CHANNEL_BANK_SIZE]!,
            triggerActive: this.settings.triggerEnableMask &&
              this.settings.triggerSource === 'analog',
          }
          : {}),
      } : {}),
    }));
  }

  /** Configure/remove the analog trigger from the group's own row. */
  /** Edit the analog trigger; while the matcher waits the change is applied live, after
   *  a match it is pending configuration for the next acquisition. */
  private configureAnalogTrigger(
    id: string, kind: 'rising' | 'falling' | null, volts: number,
  ): void {
    const bus = this.busViews.find((candidate) => candidate.id === id);
    if (!bus || bus.analogGroup === undefined) return;
    const start = bus.analogGroup * CHANNEL_BANK_SIZE;
    const analogTriggers = kind
      ? {
        [start]: {
          kind,
          volts: analogTriggerVolts(kind, Math.max(-15, Math.min(15, volts))),
        },
      }
      : {};
    this.applySettings({
      ...this.settings,
      ...(kind ? { triggerSource: 'analog' as const } : {}),
      analogTriggers,
    });
  }

  /**
   * Push the current trigger settings into the matcher of a capture that is still
   * waiting. The capture width, retained prefix and output budget are fixed at start;
   * only the conditions change. Once the matcher has matched (or the capture is not
   * running) this is a no-op: the edit then stays pending for the next acquisition,
   * exactly as the panel says.
   */
  /**
   * Reconcile a live trigger-settings edit with the running acquisition.
   *
   * The device matcher is one-shot: it can be retuned while waiting, but after a match
   * only the page's continuous analog detector can follow new conditions. A loop that
   * was started without a trigger cannot begin matching mid-stream, and turning the
   * trigger off must tear the page detector down so a released view cannot re-lock on a
   * condition the matcher never armed.
   */
  private syncActiveTrigger(): void {
    if (!this.running || this.stopping) return;
    const channels = this.store.channelCount;
    if (!isChannelCount(channels)) return;
    const plan = this.triggerPlan(this.settings);
    const conditions = plan.digital
      .filter((condition) => condition.channel < channels)
      .map((condition) => ({
        channel: condition.channel, kind: condition.kind, level: condition.level,
      }));
    const analog = plan.analog
      .filter((trigger) => trigger.start + CHANNEL_BANK_SIZE <= channels)
      .map((trigger) => ({
        start: trigger.start, kind: trigger.kind, level: analogCodeFromVolts(trigger.volts),
      }));
    const phase: TriggerReconcilePhase =
      this.triggerState === 'waiting' ? 'waiting' :
      this.triggerState === 'triggered' ? 'triggered' :
      this.triggerState === 'not-found' ? 'not-found' : 'off';
    const action = reconcileTrigger({
      running: this.running,
      stopping: this.stopping,
      loop: this.captureIsLoop,
      captureArmed: this.captureUsesSoftwareTrigger,
      phase,
      settingsArmed: this.settings.triggerEnableMask &&
        (conditions.length > 0 || analog.length > 0),
    });
    if (action === 'none') return;
    if (this.captureArming) {
      // No stop/start may overlap device.start(); re-evaluate after it settles.
      this.triggerSyncDeferred = true;
      return;
    }
    if (action === 'restart') {
      // Arming cannot begin mid-stream; start a new acquisition with these settings.
      this.restartCaptureForTrigger();
      return;
    }
    if (action === 'disable') {
      this.disableRunningTrigger();
      return;
    }
    const base = this.captureTriggerBase;
    if (!base) return;
    // Keep the display's continuous re-anchor detector on the same condition as the
    // matcher. A source change to digital drops it: digital locks are one-shot. An
    // analog condition the device would reject (wrong board or ADC rate) is left out of
    // the scanner too, so the page cannot re-anchor on a level the matcher never armed.
    const liveAnalog = analog[0];
    const adcRate = this.store.samplerate;
    const analogAllowed = (this.device?.maxChannels ?? 0) >= 32 &&
      adcRate >= 100e6 && 800e6 % adcRate === 0;
    this.triggerRetuneRejected = liveAnalog !== undefined && !analogAllowed;
    if (liveAnalog && analogAllowed) {
      // A matched Loop may switch from a digital one-shot to an analog page detector
      // live: the device matcher stays the record of the match, while the display can
      // follow the new source. The reverse direction drops the scanner and keeps the
      // current lock as a one-shot digital lock.
      if (this.analogScanner) {
        this.analogScanner.setCondition(liveAnalog);
      } else if (this.captureIsLoop && this.loopRetentionLen > 0) {
        this.analogScanner = new AnalogCrossingScanner({
          channels,
          condition: liveAnalog,
          stride: Math.max(1, Math.ceil(this.store.samplerate / 20e6)),
        });
        this.loopTriggerSlackSamples = triggerSlackSamples(
          this.loopRetentionLen, this.store.samplerate, bytesPerSampleForChannels(channels));
      }
    } else if (!liveAnalog) {
      this.analogScanner = null;
      this.loopTriggerSlackSamples = 0;
    }
    this.analogCrossings = [];
    // The crossing condition changed; the previous inter-crossing median was measured on
    // another level/slope and must not seed the block readout.
    this.loopPeriodEstimates = [];
    this.loopPeriodSamples = 0;
    this.pendingRelockAbs = null;
    if (this.triggerState === 'triggered' && this.triggerViewLock &&
        this.triggerSampleIndex !== null) {
      // Give the new condition one full window to produce an edge; the quiet-window
      // release then applies if it never does. A digital plan has no scanner, so the
      // lock remains one-shot and is released only when its window leaves retention.
      this.lastAnalogCrossingAbs = this.store.droppedSamples + this.triggerSampleIndex;
    }
    if (this.triggerState !== 'waiting') return;
    // A page-side transport can answer synchronously; a worker queues the message. Only a
    // definite refusal (the device is still arming) is retried after start resolves.
    if (this.triggerRetuneRejected) {
      // The device's own guard would refuse this edit; keep the current matcher and say
      // so in the panel instead of leaving it looking armed for this acquisition.
      this.triggerRetuneRequested = false;
      return;
    }
    type Retune = (config: Parameters<NonNullable<Device['updateSoftwareTrigger']>>[0]) => boolean | void;
    const update = this.device?.updateSoftwareTrigger as Retune | undefined;
    const applied = update?.({
      channels,
      conditions,
      analog,
      preTriggerSamples: base.preTriggerSamples,
      maxSamples: base.maxSamples,
      searchLimitSamples: base.searchLimitSamples,
    });
    this.triggerRetuneRequested = applied === false;
  }

  /**
   * The running capture's trigger was turned off (or lost every live condition) after
   * the matcher may already have fired. The device keeps streaming trigger-free; tear
   * down the page detector and the lock too, so a released view cannot re-lock on a
   * condition the matcher never armed.
   */
  private disableRunningTrigger(memory = false): void {
    if (this.triggerViewLock) this.releaseLoopTrigger();
    this.triggerAutoDisarmed = memory;
    this.triggerSampleIndex = null;
    this.triggerViewPending = false;
    this.pendingRelockAbs = null;
    this.triggerViewLost = false;
    this.triggerViewOffsetStart = 0;
    this.triggerViewOffsetEnd = 0;
    this.analogScanner = null;
    this.analogCrossings = [];
    this.lastAnalogCrossingAbs = Number.NEGATIVE_INFINITY;
    this.loopPeriodEstimates = [];
    this.loopPeriodSamples = 0;
    this.loopTriggerSlackSamples = 0;
    this.loopSwapCursorAbs = 0;
    this.loopLastAnchorStep = 0;
    this.triggerRetuneRejected = false;
    this.triggerRetuneRequested = false;
    this.triggerSyncDeferred = false;
    this.captureUsesSoftwareTrigger = false;
    this.captureTriggerBase = null;
    this.triggerState = 'off';
    if (this.session?.policy.kind === 'triggerLocked') {
      this.session = { ...this.session, policy: { kind: 'follow' } };
    }
    this.renderPanels();
    this.dirty = true;
  }

  /** Stop and start the running capture so a new trigger setting owns it from zero. */
  private restartCaptureForTrigger(): void {
    if (this.triggerRestartPending) {
      // A stop/start is already in flight. Re-evaluate after it settles; the in-flight
      // start may already have read the older settings.
      this.triggerSyncDeferred = true;
      return;
    }
    if (this.captureArming) {
      this.triggerSyncDeferred = true;
      return;
    }
    this.triggerRestartPending = true;
    this.triggerRestartCancelled = false;
    void (async () => {
      try {
        await this.stopCapture('manual');
        if (this.triggerRestartCancelled || this.device === null) {
          // The user cancelled, or a transport teardown removed the device. Leave the
          // capture stopped rather than starting an interactive connect behind their back.
          this.triggerRestartCancelled = false;
          this.triggerSyncDeferred = false;
          return;
        }
        await this.startCapture('manual');
      } finally {
        this.triggerRestartPending = false;
        // A settings edit during this restart's own arming deferred its reconcile; the
        // in-flight start may have read the older settings, so run it now (re-evaluating
        // the current state, not a stored action). This also covers the case where the
        // deferred reconcile asked for another restart while this one was in flight.
        if (this.triggerSyncDeferred && !this.triggerRestartCancelled) {
          this.triggerSyncDeferred = false;
          if (this.running && !this.stopping) this.syncActiveTrigger();
        }
      }
    })();
  }

  /** Live scope controls on an analog bank: V/Div, row height and the 0 V position. */
  private configureBusScope(
    id: string, patch: BusScopePatch, commit: boolean,
  ): void {
    const index = this.busViews.findIndex((bus) => bus.id === id);
    if (index < 0) return;
    const bus = this.busViews[index]!;
    if (bus.analogGroup === undefined) return;
    const next = { ...bus };
    if (patch.voltsPerDiv !== undefined &&
        Number.isFinite(patch.voltsPerDiv) && patch.voltsPerDiv > 0) {
      const from = this.scopeVoltsPerDiv(bus);
      const to = patch.voltsPerDiv;
      if (from !== to && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        this.scopeScaleAnimations.set(bus.id, { from, to, startedAt: performance.now() });
      } else {
        this.scopeScaleAnimations.delete(bus.id);
      }
      next.voltsPerDiv = to;
    }
    if (patch.zeroPosition !== undefined && Number.isFinite(patch.zeroPosition)) {
      next.zeroPosition = Math.min(1, Math.max(0, patch.zeroPosition));
    }
    if (patch.heightCss !== undefined && Number.isFinite(patch.heightCss)) {
      next.heightCss = Math.max(60, Math.min(400, Math.round(patch.heightCss)));
    }
    const heightChanged = next.heightCss !== bus.heightCss;
    // Scope geometry is display-only: AnalogFrame contains sample codes, not volts or
    // pixels, so vertical drags must retain the expensive frame cache.
    this.busViews[index] = { ...next };
    // Zero/V-Div previews only need the next canvas frame. Height changes (and the final
    // commit that refreshes the controls) are the only reasons to rebuild row DOM.
    if (heightChanged || commit) this.relayout();
    this.dirty = true;
    if (commit) this.persistWorkspace();
  }

  private syncBankChannels(): void {
    this.normalizeAnalogBanks();
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
    // An analog bank is fixed: MSB-first, A0-A3, ±15 V. Its only control is the Analog
    // button, so the generic editor (bit order included) is not offered for it.
    if (bus.analogGroup !== undefined) return;
    this.busPanel.edit(bus);
    this.selectPanel('analyzers');
  }

  private addBus(raw: BusViewConfig): string | null {
    const cfg = applyBusBitOrder(raw, this.settings.testMode);
    if (busOutOfWidth(cfg.spec, this.renderChannelCount())) return null;
    if ((this.running || this.stopping) && cfg.analogGroup !== undefined) return null;
    const color = busColor(this.nextBus);
    const id = `bus-${this.nextBus++}`;
    this.busViews.push({ ...cfg, color, id, builder: null, builtFor: null, cache: null });
    this.syncBankChannels();
    this.afterChannelChange();
    return id;
  }

  private updateBus(id: string, raw: BusViewConfig, preserveDefaultName = false): boolean {
    const i = this.busViews.findIndex((b) => b.id === id);
    if (i < 0) return false;
    const cfg = applyBusBitOrder(raw, this.settings.testMode);
    if (busOutOfWidth(cfg.spec, this.renderChannelCount())) return false;
    const current = this.busViews[i]!;
    if ((this.running || this.stopping) &&
      (current.analogGroup !== undefined || cfg.analogGroup !== undefined)) return false;
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
    if (this.stopping && current.analogGroup !== undefined) return false;
    this.busViews = this.busViews.filter((b) => b.id !== id);
    this.afterChannelChange();
    return true;
  }

  /**
   * The Analog button: one click turns the bank's eight inputs into the ADC module's
   * analog channel, another turns it back off. There is no dialog - the wiring (MSB
   * first), name (A0-A3), ±15 V range and hidden sources are fixed by the module
   * (HSync adc.rs) - and the sample rates follow from that choice.
   */
  private toggleAnalog(start: number): void {
    // The analog view may change while a capture runs; stopping is the only moment the
    // bus state is left alone. Showing or hiding a bank also changes the trigger plan,
    // which afterChannelChange() retunes or restarts for a waiting matcher.
    if (this.stopping) return;
    if (channelBankIndices(start, this.channels.length).length !== CHANNEL_BANK_SIZE) return;
    if (start / CHANNEL_BANK_SIZE >= this.analogGroups()) return;
    const group = start / CHANNEL_BANK_SIZE;
    const active = this.busViews.some((b) => b.analogGroup === group);
    if (active) {
      // Drop every view claiming this bank: a restored workspace or the assistant may
      // have left more than one, and the button's state is per bank, not per view.
      this.busViews = this.busViews.filter((b) => b.analogGroup !== group);
    } else {
      const color = busColor(this.nextBus);
      const id = `bus-${this.nextBus++}`;
      this.busViews.push({
        ...analogBusConfig(start, this.channels.length, color),
        id, builder: null, builtFor: null, cache: null,
      });
    }
    this.syncBankChannels();
    this.afterChannelChange();
  }

  /**
   * Analog groups available to the view. Only the SLogic32U3 carries the ADC module
   * (four groups, HSync model.rs); a 32-channel capture was necessarily recorded on one.
   * A group exists only while its whole eight-input width is captured.
   *
   * An already active group is always offered, even before a board is connected (the
   * workspace may have restored it) or on a device without the module (adoption drops it
   * on connect), so the Analog button can always turn it back off.
   */
  private analogGroups(): number {
    const width = analogGroupCount(this.renderChannelCount());
    let active = 0;
    for (const bus of this.busViews) {
      if (bus.analogGroup !== undefined) active = Math.max(active, bus.analogGroup + 1);
    }
    return Math.min(width, Math.max(this.deviceAnalogGroups(), active));
  }

  /** Groups the connected device (or a loaded 32-channel capture) can offer. */
  private deviceAnalogGroups(): number {
    if (this.device) return (this.device.maxChannels ?? 0) >= 32 ? ANALOG_GROUP_COUNT : 0;
    return this.loadedCapture() && this.channels.length >= 32 ? ANALOG_GROUP_COUNT : 0;
  }

  /**
   * A full aligned eight-channel bank is the converter's data bus, so every view claiming
   * one is brought to the module's fixed definition: MSB first, A0-A3, ±15 V, sources
   * hidden. Legacy workspaces and the assistant may have stored another order or range;
   * the Analog cell must never describe a different reading than the one drawn.
   */
  private normalizeAnalogBanks(): void {
    this.busViews = this.busViews.map((bus) => {
      if (bus.analogGroup === undefined) return bus;
      const start = bus.analogGroup * CHANNEL_BANK_SIZE;
      if (start + CHANNEL_BANK_SIZE > this.channels.length) return bus;
      const fixed = analogBusConfig(start, this.channels.length, bus.color);
      const same = bus.name === fixed.name && bus.bitOrder === fixed.bitOrder &&
        bus.fullScaleV === fixed.fullScaleV && bus.offsetV === fixed.offsetV &&
        bus.hideSources === fixed.hideSources && bus.spec.encoding === fixed.spec.encoding &&
        bus.spec.clock === null && bus.spec.bits.join(',') === fixed.spec.bits.join(',');
      if (same) return bus;
      return {
        ...fixed, id: bus.id, heightCss: bus.heightCss, style: bus.style,
        builder: null, builtFor: null, cache: null,
      };
    });
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
    // A Repeat composite's length is stable while its contents change behind the frontier;
    // an append-only pyramid would never ingest the replacement and would serve stale
    // analog envelopes. Leave the builders off while the composite is displayed: the
    // bounded live/provisional path in analogFrame reads the composite correctly.
    if (this.repeatComposite && this.storeRef.target === this.repeatComposite) {
      for (const b of this.busViews) {
        if (b.builder || b.builtFor) { b.builder = null; b.builtFor = null; b.cache = null; }
      }
      return;
    }
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
      // While running, this is new data for the throttled live view; after the capture it
      // is background work whose progress still deserves an immediate frame.
      if (this.running) this.livePending = true;
      else this.dirty = true;
      const now = performance.now();
      if (this.decodersPageShown() && (done || now - this.busPanelAt > 300)) {
        this.busPanelAt = now;
        this.renderPanels();
      }
      return;
    }
  }

  /** The displayed V/Div, easing both the trace and its ruler toward the configured value. */
  private scopeVoltsPerDiv(bus: BusViewState): number {
    const target = bus.voltsPerDiv ?? 10;
    const animation = this.scopeScaleAnimations.get(bus.id);
    if (!animation || animation.to !== target) return target;
    const frame = scopeScaleAt(animation.from, animation.to, animation.startedAt, performance.now());
    if (frame.done) this.scopeScaleAnimations.delete(bus.id);
    else this.dirty = true;
    return frame.value;
  }

  /** One transparent drag/wheel ruler on the right edge of every analog row. */
  private syncScopeBars(): void {
    const active = new Set<string>();
    for (const box of this.stack.boxes()) {
      if (box.spec.kind !== 'analog' || box.spec.bus === undefined) continue;
      const bus = this.busViews[box.spec.bus];
      if (!bus || bus.analogGroup === undefined) continue;
      active.add(bus.id);
      let bar = this.scopeBars.get(bus.id);
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'scope-scale-bar';
        bar.dataset.busId = bus.id;
        bar.tabIndex = 0;
        bar.setAttribute('role', 'slider');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-orientation', 'vertical');
        const grip = document.createElement('div');
        grip.className = 'scope-scale-grip';
        grip.setAttribute('aria-hidden', 'true');
        bar.appendChild(grip);
        bar.addEventListener('pointerdown', (event) => this.dragScopeBar(event, bar!));
        bar.addEventListener('wheel', (event) => this.wheelScopeBar(event, bar!), { passive: false });
        bar.addEventListener('dblclick', (event) => this.resetScopeBar(event, bar!));
        bar.addEventListener('keydown', (event) => this.keyScopeBar(event, bar!));
        this.scopeHost.appendChild(bar);
        this.scopeBars.set(bus.id, bar);
      }
      bar.style.top = `${box.top}px`;
      bar.style.height = `${box.band}px`;
      const label = t('bus.scaleBarTip');
      if (bar.title !== label) bar.title = label;
      if (bar.getAttribute('aria-label') !== label) bar.setAttribute('aria-label', label);

      const zeroPosition = Math.min(1, Math.max(0, bus.zeroPosition ?? 0.5));
      if (bar.getAttribute('aria-valuenow') !== String(Math.round(zeroPosition * 100))) {
        bar.setAttribute('aria-valuenow', String(Math.round(zeroPosition * 100)));
      }
      const valueText = `${Math.round(zeroPosition * 100)}%, ${bus.voltsPerDiv ?? 10} ${t('bus.voltsPerDiv')}`;
      if (bar.getAttribute('aria-valuetext') !== valueText) {
        bar.setAttribute('aria-valuetext', valueText);
      }
      const perDiv = this.scopeVoltsPerDiv(bus);
      const geometry = scopeGeometry(box.top, box.band, perDiv, zeroPosition);
      const trigger = this.settings.triggerSource === 'analog' && this.settings.triggerEnableMask
        ? this.settings.analogTriggers?.[bus.analogGroup * CHANNEL_BANK_SIZE] : undefined;
      if (!trigger) {
        const drag = this.scopeTriggers.get(bus.id);
        if (drag) { drag.remove(); this.scopeTriggers.delete(bus.id); }
        continue;
      }
      const y = geometry.yVolts(trigger.volts);
      let drag = this.scopeTriggers.get(bus.id);
      if (!drag) {
        drag = document.createElement('div');
        drag.className = 'scope-trigger-drag';
        drag.dataset.busId = bus.id;
        drag.title = t('bus.triggerDragTip');
        drag.setAttribute('aria-label', drag.title);
        drag.setAttribute('role', 'slider');
        drag.setAttribute('aria-valuemin', '-15');
        drag.setAttribute('aria-valuemax', '15');
        drag.setAttribute('aria-orientation', 'vertical');
        drag.tabIndex = 0;
        drag.addEventListener('pointerdown', (event) => this.dragScopeTrigger(event, drag!));
        drag.addEventListener('wheel', (event) => this.wheelScopeBar(event, drag!), { passive: false });
        drag.addEventListener('keydown', (event) => this.keyScopeTrigger(event, drag!));
        // The marker covers the ruler grip at its level. A double-click there means the
        // same thing as on the ruler, not the plot's time zoom it would otherwise reach.
        drag.addEventListener('dblclick', (event) => {
          const bar = this.scopeBars.get(bus.id);
          if (bar) this.resetScopeBar(event, bar);
        });
        this.scopeHost.appendChild(drag);
        this.scopeTriggers.set(bus.id, drag);
      }
      // Exactly the ruler's own visibility rule (`overlay.drawAnalog`): the triangle,
      // dashed line and R/F chip appear and disappear together.
      const visible = trigger.volts >= geometry.bottomV && trigger.volts <= geometry.topV;
      drag.hidden = !visible;
      drag.style.top = `${Math.round(y) - 6}px`;
      drag.setAttribute('aria-valuenow', trigger.volts.toFixed(2));
      drag.setAttribute('aria-valuetext', `${trigger.volts.toFixed(3)} V`);
    }
    for (const [id, bar] of this.scopeBars) {
      if (active.has(id)) continue;
      bar.remove();
      this.scopeBars.delete(id);
    }
    for (const [id, drag] of this.scopeTriggers) {
      if (active.has(id)) continue;
      drag.remove();
      this.scopeTriggers.delete(id);
    }
    for (const id of this.scopeScaleAnimations.keys()) {
      if (!active.has(id)) this.scopeScaleAnimations.delete(id);
    }
  }

  private dragScopeBar(event: PointerEvent, bar: HTMLDivElement): void {
    const bus = this.busViews.find((candidate) => candidate.id === bar.dataset.busId);
    if (!bus || bus.analogGroup === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    // Home only works on a focused ruler; a drag is the natural way to focus it.
    bar.focus({ preventScroll: true });
    const startY = event.clientY;
    const start = bus.zeroPosition ?? 0.5;
    const height = scopeGeometry(0, bar.offsetHeight, bus.voltsPerDiv ?? 10, start).innerHeight;
    let last = start;
    const move = (ev: PointerEvent): void => {
      last = Math.min(1, Math.max(0, start + (ev.clientY - startY) / height));
      this.configureBusScope(bus.id, { zeroPosition: last }, false);
    };
    const finish = (commit: boolean): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      // A browser-cancelled gesture is not a user edit: put the preview back.
      this.configureBusScope(bus.id, { zeroPosition: commit ? last : start }, commit);
    };
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    document.addEventListener('pointercancel', cancel, { once: true });
  }

  private resetScopeBar(event: MouseEvent | KeyboardEvent, bar: HTMLDivElement): void {
    const bus = this.busViews.find((candidate) => candidate.id === bar.dataset.busId);
    if (!bus || bus.analogGroup === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    // Display-only reset: recenter 0 V and restore the normal 10 V/div scale. The usual
    // writer keeps the spatial zoom animation and one persisted workspace commit.
    this.configureBusScope(bus.id, { voltsPerDiv: 10, zeroPosition: 0.5 }, true);
  }

  private wheelScopeBar(event: WheelEvent, bar: HTMLDivElement): void {
    const bus = this.busViews.find((candidate) => candidate.id === bar.dataset.busId);
    if (!bus || bus.analogGroup === undefined) return;
    // Ctrl zooms time and Shift pans it; those gestures belong to the plot, not V/Div.
    if (event.ctrlKey || event.shiftKey || event.deltaY === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = bus.voltsPerDiv ?? 10;
    const next = nextScopeVoltsPerDiv(current, event.deltaY < 0 ? -1 : 1);
    if (next === current) return;
    this.configureBusScope(bus.id, { voltsPerDiv: next }, false);
    // Trackpad momentum may deliver dozens of events. Animate each target, but rebuild
    // the controls and write the workspace once the wheel gesture settles.
    if (this.scopeWheelPersist !== null) window.clearTimeout(this.scopeWheelPersist);
    this.scopeWheelPersist = window.setTimeout(() => {
      this.scopeWheelPersist = null;
      this.configureBusScope(bus.id, {}, true);
    }, 180);
  }

  private keyScopeBar(event: KeyboardEvent, bar: HTMLDivElement): void {
    const bus = this.busViews.find((candidate) => candidate.id === bar.dataset.busId);
    if (!bus || bus.analogGroup === undefined) return;
    if (event.key === 'Home') {
      this.resetScopeBar(event, bar);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const delta = (event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 0.1 : 0.02);
      const zeroPosition = Math.min(1, Math.max(0, (bus.zeroPosition ?? 0.5) + delta));
      this.configureBusScope(bus.id, { zeroPosition }, true);
      return;
    }
    if (event.key !== '+' && event.key !== '=' && event.key !== '-') return;
    event.preventDefault();
    const current = bus.voltsPerDiv ?? 10;
    const next = nextScopeVoltsPerDiv(current, event.key === '-' ? 1 : -1);
    if (next !== current) this.configureBusScope(bus.id, { voltsPerDiv: next }, true);
  }

  private keyScopeTrigger(event: KeyboardEvent, drag: HTMLDivElement): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const bus = this.busViews.find((candidate) => candidate.id === drag.dataset.busId);
    if (!bus || bus.analogGroup === undefined) return;
    const trigger = this.settings.analogTriggers[bus.analogGroup * CHANNEL_BANK_SIZE];
    if (!trigger) return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : ADC_FULL_SCALE_V / 255;
    const volts = trigger.volts + (event.key === 'ArrowUp' ? step : -step);
    this.configureAnalogTrigger(bus.id, trigger.kind, volts);
  }

  private dragScopeTrigger(event: PointerEvent, drag: HTMLDivElement): void {
    const bus = this.busViews.find((candidate) => candidate.id === drag.dataset.busId);
    if (!bus || bus.analogGroup === undefined) return;
    const start = bus.analogGroup * CHANNEL_BANK_SIZE;
    const trigger = this.settings.analogTriggers[start];
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    drag.focus({ preventScroll: true });
    const startY = event.clientY;
    const startVolts = trigger.volts;
    // A V/div animation may still be easing when the handle is grabbed. Re-read the
    // displayed scale for every move so the drag follows the ruler the user can see,
    // instead of a stale snapshot taken at pointerdown.
    const row = this.scopeBars.get(bus.id);
    const top = row?.offsetTop ?? 0;
    const band = row?.offsetHeight ?? 120;
    const zeroPosition = bus.zeroPosition ?? 0.5;
    const originalSettings = this.settings;
    const originalTriggerState = this.triggerState;
    const originalTriggerSample = this.triggerSampleIndex;
    const wasRunning = this.running;
    let last = startVolts;
    const move = (ev: PointerEvent): void => {
      const perDiv = this.scopeVoltsPerDiv(bus);
      const startTraceY = scopeGeometry(top, band, perDiv, zeroPosition).yVolts(startVolts);
      const atY = startTraceY + (ev.clientY - startY);
      last = Math.max(-15, Math.min(15, scopeVoltsAtY(atY, top, band, perDiv, zeroPosition)));
      // Volts-only preview: bypassing applySettings avoids panel/layout churn. Do not add
      // rate/width/mode/retention edits here; those need its running-capture guards.
      const next = this.clampSettings({
        ...this.settings,
        triggerSource: 'analog',
        analogTriggers: { [start]: { kind: trigger.kind, volts: analogTriggerVolts(trigger.kind, last) } },
      });
      if (!this.running && !this.stopping && triggerSettingsChanged(this.settings, next)) {
        this.triggerState = 'off';
        this.clearTriggerSample();
      }
      const triggerChanged = triggerSettingsChanged(this.settings, next);
      this.settings = next;
      if (triggerChanged) this.syncActiveTrigger();
      this.dirty = true;
    };
    const finish = (commit: boolean): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      if (!commit) {
        // A browser-cancelled gesture is not a user edit: restore the level (and, when
        // idle, the trigger state the preview may have cleared). During a run T and the
        // lock belong to the live matcher and retention may have shifted them under the
        // gesture, so they are never restored here; the matcher is retuned to the level
        // the UI now shows.
        const restored = triggerSettingsChanged(this.settings, originalSettings);
        this.settings = originalSettings;
        if (!wasRunning) {
          this.triggerState = originalTriggerState;
          this.triggerSampleIndex = originalTriggerSample;
        }
        if (restored) this.syncActiveTrigger();
      }
      this.relayout();
      this.renderPanels();
      if (commit) this.persistWorkspace();
    };
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
    document.addEventListener('pointercancel', cancel, { once: true });
  }

  private drawBusRows(
    boxes: readonly RowBox[], tint: readonly RegionTint[] | null,
  ): void {
    const view = this.stack.view;
    const store = this.store;
    for (const box of boxes) {
      if (box.spec.kind !== 'analog') continue;
      const bv = this.busViews[box.spec.bus ?? -1];
      if (!bv) continue;
      // The analog row is a renderer row with a trace in it; cover it first, then carry
      // the Repeat two-wave tint across it like every other row.
      this.overlay.fillLane(box.top, box.height);
      if (tint) this.overlay.drawRegionTintOverlay(tint, [{ top: box.top, band: box.band }]);
      const valid = store.length > 0 && validateBusSpec(bv.spec, store.channelCount).length === 0;
      const frame: AnalogFrame = valid
        ? analogFrame(store, bv, view.start, view.end, view.widthPx, this.running)
        : { kind: 'empty', reason: 'no-capture' };
      const note = frame.kind !== 'empty' ? ''
        : frame.reason === 'live' ? t('bus.liveNote')
          : store.length > 0 ? t('bus.badChannels') : '';
      const r = busYRange(bv);
      const analogBank = bv.analogGroup !== undefined;
      const analogTrigger = analogBank && this.settings.triggerEnableMask &&
        this.settings.triggerSource === 'analog'
        ? this.settings.analogTriggers?.[bv.analogGroup! * CHANNEL_BANK_SIZE] : undefined;
      const scope = analogBank ? {
        voltsPerDiv: this.scopeVoltsPerDiv(bv),
        tickVoltsPerDiv: bv.voltsPerDiv ?? 10,
        voltsPerDivUnit: t('bus.voltsPerDiv'),
        zeroPosition: Math.min(1, Math.max(0, bv.zeroPosition ?? 0.5)),
        offsetV: bv.offsetV,
        fullScaleV: bv.fullScaleV ?? ADC_FULL_SCALE_V,
        ...(analogTrigger ? {
          triggerVolts: analogTrigger.volts,
          triggerKind: analogTrigger.kind,
        } : {}),
      } : undefined;
      this.overlay.drawAnalog({
        top: box.top, band: box.band, frame, yMin: r.min, yMax: r.max, color: bv.color,
        // A combinational bus holds its value between bit changes: steps are the truth.
        // An ADC row is sampled analog data, so it gets a smooth reconstruction instead.
        style: analogBank ? 'line' : bv.spec.clock ? bv.style : 'step',
        smooth: analogBank,
        ...(scope ? { scope } : {}),
        labels: { top: busLabel(bv, r.max), bottom: busLabel(bv, r.min) },
        note,
      });
    }
  }

  private applySettings(s: CaptureSettings): void {
    if (s.samplerate !== this.settings.samplerate) this.samplerateExplicit = true;
    // Clamp first (the rate may hit a ceiling), then carry the duration across a mode or
    // rate change at the rate the capture will actually use.
    const next = carryCaptureDuration(this.settings, this.clampSettings(s));
    const testModeChanged = next.testMode !== this.settings.testMode;
    const triggerChanged = triggerSettingsChanged(this.settings, next);
    if (!this.running && !this.stopping && triggerChanged) {
      this.triggerState = 'off';
      this.clearTriggerSample();
      this.dirty = true;
    }
    // Loop is continuous, so its retention window can follow a Duration edit on the very
    // next frame. Rate and width edits are capture configuration (the running store cannot
    // be reinterpreted); carryCaptureDuration also changes loopSamples when it rescales
    // for a rate, which must not be applied to the old-rate store.
    const liveLoopWindow = this.running && this.captureIsLoop &&
      next.loopSamples !== this.settings.loopSamples &&
      next.samplerate === this.settings.samplerate &&
      next.channels === this.settings.channels;
    if (liveLoopWindow) {
      const storeChannels = isChannelCount(this.store.channelCount)
        ? this.store.channelCount : next.channels;
      this.loopRetentionLen = clampLoopSamples(next.loopSamples, storeChannels);
      // The carried slack is derived from the window; keep the two in step.
      this.loopTriggerSlackSamples = this.analogScanner
        ? triggerSlackSamples(this.loopRetentionLen, this.store.samplerate,
          bytesPerSampleForChannels(storeChannels))
        : 0;
      // The DurationWindow changed size: re-clamp the user's ViewWindow into it. The
      // trigger lock, T and the local roll are untouched.
      if (this.triggerViewLock) this.clampLockView();
      this.enforceLoopRetention(this.storeRef);
      this.resetBusBuilds();
    }
    this.settings = next;
    if (triggerChanged) this.syncActiveTrigger();
    if (testModeChanged) {
      // Auto bit order follows the mode (MSB on live input, LSB on test patterns). A bus
      // whose bits shifted needs its pyramid rebuilt; unchanged buses keep their builder.
      // Analog banks are pinned to msb for real input; built-in LSB-first test patterns
      // are not a supported analog voltage/trigger source (the Advanced panel says so).
      this.busViews = this.busViews.map((bus) => {
        const oriented = applyBusBitOrder(bus, next.testMode);
        return oriented === bus ? bus : { ...oriented, builder: null, builtFor: null, cache: null };
      });
    }
    this.reconcileEdgeChannels();
    this.persistWorkspace();
    this.relayout();
    this.renderPanels();
  }

  /** Commit one inline channel edit. The name stays editable during capture; trigger
   * modes reconcile live with the running acquisition (see `syncActiveTrigger`). Colour
   * is not editable. */
  private configureChannel(channel: number, config: ChannelConfiguration): void {
    const current = this.channels[channel];
    if (!current) return;
    const name = config.name.trim() || defaultChannelName(channel);
    this.channels[channel] = { ...current, name, color: config.color };

    // A name-only edit must not touch the trigger detector: it would reset crossing
    // continuity and can release a held lock for no reason.
    const editable = !this.stopping;
    if (editable) {
      const previous = this.settings.triggerModes[channel] ?? DEFAULT_TRIGGER_MODE;
      const triggerModes = { ...this.settings.triggerModes, [channel]: config.mode };
      const triggerConditions = modesToConditions(triggerModes);
      const first = triggerConditions[0] ?? {
        channel, kind: 'level' as const, level: 1 as const,
      };
      const next = this.clampSettings({
        ...this.settings, triggerModes, triggerConditions,
        triggerChannel: first.channel, triggerKind: first.kind, triggerLevel: first.level,
        ...(edgeTriggerAutoArms(previous, config.mode, this.settings.triggerEnableMask)
          ? { triggerEnableMask: true } : {}),
      });
      const triggerChanged = triggerSettingsChanged(this.settings, next);
      if (!this.running && triggerChanged) {
        this.triggerState = 'off';
        this.clearTriggerSample();
      }
      this.settings = next;
      if (triggerChanged) this.syncActiveTrigger();
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
      if (busOutOfWidth(b.spec, this.renderChannelCount())) return;
      analogRows.push({
        kind: 'analog', channel: Math.min(b.spec.bits[0] ?? 0, Math.max(0, this.store.channelCount - 1)),
        heightCss: b.heightCss, bus: i,
      });
    });
    const analogH = analogRows.reduce((sum, r) => sum + r.heightCss, 0);
    this.overview.syncSize();
    const axisH = this.el.axis.offsetHeight || 30;
    const overviewH = this.el.overview.offsetHeight || 56;
    const plotH = Math.max(120, (this.el.scroll.clientHeight || 630) - axisH - overviewH - analogH);
    const enabled = this.visibleChannels();
    this.lanes = this.computeLanes(enabled);
    const channelColors = this.channels.map((channel) => channel.color);
    const shown = this.rowChannels();

    if (shown.length === 0) {
      this.stack.setRows(analogRows, channelColors);
      this.channelList.render([]);
      this.channelList.renderBuses(this.busCells());
      this.overlay.syncSize(this.el.plot.clientWidth, this.el.plot.clientHeight);
      this.dirty = true;
      return;
    }

    const base = computeChannelRowHeight(plotH, shown.length, this.lanes.length);

    const rows: RowSpec[] = [...analogRows];
    const cells: ChannelCell[] = [];
    for (const c of shown) {
      const mine = this.lanes.filter((l) => l.laneChannel === c.index);
      for (const l of mine) {
        rows.push({
          kind: 'lane', channel: c.index, heightCss: ROWS.laneHeight,
          analyzer: this.analyzers.indexOf(l.analyzer),
        });
      }
      rows.push(this.captured(c.index)
        ? { kind: 'channel', channel: c.index, heightCss: base }
        : { kind: 'blank', channel: 0, shows: c.index, heightCss: base });
      cells.push({
        channel: c,
        heightCss: base + mine.length * ROWS.laneHeight,
        laneCss: mine.length * ROWS.laneHeight,
        analyzers: this.analyzers.filter((a) => this.chipChannels(a).includes(c.index)),
        trigger: {
          mode: this.settings.triggerModes[c.index] ?? DEFAULT_TRIGGER_MODE,
          armed: this.settings.triggerEnableMask && this.settings.triggerSource === 'digital' &&
            (this.settings.triggerModes[c.index] ?? DEFAULT_TRIGGER_MODE) !== 'dont-care',
          // A waiting matcher is retuned in place; a matched one keeps its trigger and
          // the edit is pending for the next acquisition. Only stopping refuses edits.
          disabled: this.stopping,
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
    if (index >= this.renderChannelCount()) return;
    const c = this.channels[index];
    if (!c) return;
    if (!enabled && lockedChannelBanks(this.busViews, this.renderChannelCount()).has(channelBankStart(index))) return;
    if (!enabled && this.enabledChannels().length <= 1) return;   // never zero rows
    c.enabled = enabled;
    this.afterChannelChange();
  }

  private setChannelWidth(channels: number): void {
    // Editable while running: the new width applies to the next capture; the current
    // acquisition keeps the width (and therefore the rows) it started with.
    if (this.stopping) return;
    if (!this.widthTiers().includes(channels)) return;
    if (!isChannelCount(channels) || channels > this.channels.length) return;
    // A running capture keeps its rows; the width change is pending and the out-of-width
    // views are removed when the capture ends (finishCapture).
    if (!this.running) {
      this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, channels));
    }
    if (channels !== this.settings.channels) this.widthExplicit = true;
    this.applySettings({ ...this.settings, channels });
  }

  private afterChannelChange(): void {
    // Enabling an analog bank can clamp the *pending* rate to the ADC clock; carry the
    // duration so the next capture keeps its length.
    const next = carryCaptureDuration(this.settings, this.clampSettings({ ...this.settings }));
    const triggerChanged = triggerSettingsChanged(this.settings, next);
    if (!this.running && !this.stopping && triggerChanged) {
      this.triggerState = 'off';
      this.clearTriggerSample();
      this.dirty = true;
    }
    this.settings = next;
    // Showing or hiding an ADC group drops or restores analog conditions, so it is a
    // trigger-configuration change too: retune a waiting matcher (or restart free-run)
    // instead of leaving the panel and the active matcher disagreeing.
    if (triggerChanged) this.syncActiveTrigger();
    this.reconcileEdgeChannels();
    this.persistWorkspace();
    this.relayout();
    this.renderPanels();
  }

  private reorder(from: number, to: number): void {
    const enabled = this.rowChannels();
    const moving = enabled[from];
    const target = enabled[to];
    if (!moving || !target) return;
    const src = this.order.indexOf(moving.index);
    const dst = this.order.indexOf(target.index);
    this.order.splice(src, 1);
    this.order.splice(dst, 0, moving.index);
    this.persistWorkspace();
    this.relayout();
    this.renderPanels();
  }

  // ------------------------------------------------------------------ frame

  private frame = (): void => {
    requestAnimationFrame(this.frame);
    const now = performance.now();
    const highRateLoop = this.running && this.captureIsLoop &&
      this.store.samplerate * bytesPerSampleForChannels(this.store.channelCount) >= LOOP_BUILD_SUSPEND_BYTES_PER_SEC;
    // Bus overviews are background work: skip them on the fastest loop streams so the
    // ingest path keeps the link, and let them finish after the capture stops.
    if (!highRateLoop) this.pumpBusBuilders();
    if (this.running && !this.repeatWaveHolding && now - this.runningPanelAt > 500) {
      this.runningPanelAt = now;
      if (this.capturePageShown()) {
        this.capturePanel.updateProgress(this.progressView());
        // A Repeat wave does not rebuild the panel; refresh the trigger state (waiting /
        // triggered / miss) as decided text instead of leaving the last wave's note up.
        this.capturePanel.updateTriggerStatus(this.triggerStatusView());
        // The loop's matcher/swap readout changes with arriving samples; update only its
        // text, never rebuild the panel (that would drop focus mid-edit).
        if (this.captureIsLoop) this.capturePanel.updateLoopMetrics(this.computeLoopMetrics());
      }
      // A high-rate loop draws on the live cadence below, so the status line (which the
      // draw pass does not own) still needs its own refresh here.
      if (highRateLoop) this.renderStatus();
    }
    // Interactions (`dirty`) draw in the next frame. New samples (`livePending`) draw on
    // a fixed cadence, like HSync telling the interface of progress every 50 ms instead
    // of on every packet. Even the fastest loop now shows a live view, at that cadence.
    // A Repeat wave that is still waiting for its trigger keeps the previous frame: its
    // pre-trigger samples are arriving, but there is nothing new to show yet. A user
    // gesture (`dirty`) still draws, using the held wave and its own T.
    if (!this.dirty && (this.repeatWaveHolding ||
        !liveDrawDue(now, this.liveDrawAt, this.livePending, this.running))) {
      return;
    }
    this.dirty = false;
    this.livePending = false;
    this.liveDrawAt = now;
    try {
      this.draw();
    } catch (e) {
      this.fail('error.render', e);
    }
  };

  private draw(): void {
    // A quiet Repeat wave keeps the previous frame until its first samples arrive; a
    // blank store would otherwise flash the plot and axis at every wave boundary.
    if (this.repeatWaveHolding && this.store.length === 0) return;
    // A pan/zoom gesture ran after the last draw; record the interval it produced.
    if (this.viewIntent) this.captureFixedView();
    const pendingViewport = this.pendingToolbarViewport;
    this.pendingToolbarViewport = null;
    const restorePending = pendingViewport !== null &&
      this.stack.view.start === pendingViewport.start && this.stack.view.end === pendingViewport.end;
    const rescaled = this.stack.syncSize();
    if (restorePending && pendingViewport) {
      this.stack.setViewport(pendingViewport.start, pendingViewport.end);
      this.stack.setFollowLatest(pendingViewport.follow);
    }
    // A Repeat wave that now has something to show hands the plot over before the view
    // policy is resolved, so the first frame after the hand-over already uses the new
    // wave's origin and policy (no stale fixed/follow frame).
    this.releaseRepeatHold();
    this.applySessionView();
    this.applyTriggerViewAnchor(rescaled);
    // The policy is resolved: only a Fixed Repeat viewport needs the previous wave as a
    // second layer. Doing this after the resolve keeps FollowLive off the composite.
    this.updateRepeatDisplay();
    const wCss = this.el.plot.clientWidth;
    const hCss = this.el.plot.clientHeight;
    this.overlay.syncSize(wCss, hCss);
    this.el.hint.style.display = this.store.length > 0 ? 'none' : 'flex';

    this.stack.render();
    const view = this.stack.view;
    this.syncScopeBars();
    const sr = this.store.samplerate;
    const timeOrigin = this.displayOriginSample();
    const ticks = computeTicks(
      ((view.start - timeOrigin) / sr) * 1e12,
      ((view.end - timeOrigin) / sr) * 1e12,
      wCss, sr,
    );

    this.drawAxisCanvas(ticks, wCss);

    this.overlay.beginFrame();
    const boxes = this.stack.boxes();
    const repeatTints = this.repeatTintRegions();
    if (repeatTints) {
      // On the grid canvas, before its gridlines: the tint is the layer "behind" the
      // opaque waveform canvases. No vertical rule - the two surfaces are the signal.
      this.overlay.drawRegionTint(repeatTints, boxes);
    }
    this.overlay.drawGrid(ticks);
    this.drawLaneSurfaces(boxes, repeatTints);
    for (const b of boxes) {
      if (b.spec.kind === 'blank') {
        this.overlay.drawBlankRow(b.top, b.band, t('plot.notCaptured'), repeatTints);
      }
    }
    this.overlay.drawLevels(boxes.map((b) => ({
      top: b.top, band: b.band, isChannel: b.spec.kind === 'channel',
    })));
    this.drawLaneBubbles(boxes, wCss);
    beginAnalogFrameBudget();
    try {
      this.drawBusRows(boxes, repeatTints);
    } finally {
      endAnalogFrameBudget();
    }

    const triggerAt = this.displayTriggerSample();
    if (triggerAt !== null) {
      this.overlay.drawTrigger(this.toPx(triggerAt));
    }

    // The live edge belongs to the current wave, not to the composite's far end: a Fixed
    // Repeat viewport keeps old data beyond the frontier, and a held previous frame is
    // not live at all.
    const liveAt = this.repeatShowingFront ? null : this.captureStore.length;
    if (this.running && liveAt !== null && liveAt > 0) {
      this.overlay.drawLiveEdge(this.toPx(liveAt));
    }
    for (const cursor of this.cursors) cursor.marker.draw(this.overlay, (sample) => this.toPx(sample));
    if (this.hover) this.overlay.drawHover(this.hover);
    const overviewView = this.stack.viewport;
    const overviewWindow = this.overviewWindow();
    const originSample = this.displayOriginSample();
    const overviewRate = this.store.samplerate;
    const secondsAt = (sample: number): number =>
      overviewRate > 0 ? (sample - originSample) / overviewRate : 0;
    this.overview.render({
      store: this.store,
      channels: this.enabledChannels().map((channel) => channel.index),
      viewport: overviewView,
      windowStart: overviewWindow.start,
      windowSpan: overviewWindow.span,
      triggerSample: triggerAt,
      // A Repeat composite's length includes the old wave; its density still changes as
      // the current wave's frontier advances, so key the cache on that frontier.
      dataEnd: this.captureStore.length,
      originLabel: t(triggerAt !== null
        ? 'overview.originTrigger' : 'overview.originStart'),
      viewportTitle: t('overview.viewport', {
        from: formatDuration(secondsAt(overviewView.start)),
        to: formatDuration(secondsAt(overviewView.end)),
      }),
      palette: this.palette,
    });

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
    if (!ctx) throw new DiagnosticError('ui.axisContext');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawAxis(ctx, ticks, wCss, hCss, this.palette);
    ctx.font = AXIS.markerChip.font;
    const placed = this.cursorChipPlacements(
      (label) => ctx.measureText(label).width + 2 * AXIS.markerChip.padX, wCss,
    );
    for (const chip of placed) {
      const cursor = this.cursorById(chip.id);
      if (cursor === null) continue;
      paintMarkerChip(
        ctx, { ...chip, color: cursor.marker.color }, wCss, hCss, this.palette,
      );
    }
  }

  private cursorChipPlacements(
    measure: (label: string) => number, width: number,
  ): PlacedCursorChip[] {
    const chips: CursorChip[] = [];
    for (const cursor of this.cursors) {
      const sample = cursor.marker.sample;
      if (sample === null) continue;
      chips.push({ id: cursor.id, label: cursor.marker.label, cssX: this.toPx(sample) });
    }
    if (chips.length === 0) return [];
    return layoutCursorChips(chips, measure, width);
  }

  private drawLaneSurfaces(
    boxes: readonly RowBox[], tint: readonly RegionTint[] | null,
  ): void {
    for (const box of boxes) {
      if (box.spec.kind !== 'lane') continue;
      // The lane is a renderer row, so it currently holds a trace and a separator. Cover
      // it before drawing into it - NOTES.md section 2. The Repeat tint is painted on
      // the annotation canvas too, so the two-wave surface does not stop at this row.
      this.overlay.fillLane(box.top, box.height);
      if (tint) this.overlay.drawRegionTintOverlay(tint, [{ top: box.top, band: box.band }]);
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

    // Wheel without a modifier scrolls the channel stack vertically, as it does anywhere
    // else in the page. Ctrl zooms the time axis; Shift pans it horizontally. This is the
    // interaction users know from HSync and DSView; treating every wheel as zoom made the
    // unmodified wheel unable to reach channels below the fold.
    const wheelNavigate = (e: WheelEvent, left: number): void => {
      // The browser's own Ctrl+wheel page zoom must be stopped even before any capture
      // exists; only after that is it safe to treat an empty store as a no-op.
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();
      if (this.store.length === 0) return;
      const dpr = globalThis.devicePixelRatio || 1;
      if (e.ctrlKey) {
        if (e.deltaY === 0) return;
        // [SOURCE] one 120-unit notch is exactly sqrt(2).
        // [UNVERIFIED] telling a physical wheel from a trackpad: a large, quantised
        // deltaY with no deltaX is the usual signature; a browser does not report it.
        const physical = e.deltaX === 0 && Math.abs(e.deltaY) >= 100 && Number.isInteger(e.deltaY);
        this.stack.zoomAt((e.clientX - left) * dpr,
          wheelSpanFactor(e.deltaY, { isPhysicalWheel: physical, shift: false }));
      } else {
        const dx = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        this.stack.panPixels(dx * dpr);
      }
      this.noteViewportIntent();
      this.dirty = true;
    };
    plot.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();
      if (this.store.length === 0) return;
      const left = plot.getBoundingClientRect().left;
      wheelNavigate(e, left);
      this.syncMarkerCursor(e.clientX - left);
    }, { passive: false });
    this.el.axis.addEventListener('wheel', (e) => {
      const left = this.el.axis.getBoundingClientRect().left;
      wheelNavigate(e, left);
    }, { passive: false });

    // One pointer drags (pan) or grabs a cursor; two pointers pinch-zoom around their
    // midpoint. Touch is pointer events here too - #plot carries `touch-action: pan-y`,
    // so the browser keeps vertical scrolling and hands everything else to this code.
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; midX: number } | null = null;
    let dragging = false;
    let lastX = 0;
    this.releaseMarkerPointer = () => {
      const cursor = this.draggingCursor();
      const id = cursor?.marker.pointerId ?? null;
      this.syncMarkerCursor(null);
      if (cursor === null || id === null) return;
      cursor.marker.cancelDrag();
      pointers.delete(id);
      if (plot.hasPointerCapture(id)) plot.releasePointerCapture(id);
    };
    plot.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      plot.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        this.cancelMarkerDrags();
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2 };
        dragging = false;
      } else if (pointers.size === 1) {
        this.syncPlotSize();
        const rect = plot.getBoundingClientRect();
        const grabbed = this.tryGrabMarker(e, rect);
        dragging = !grabbed;
        lastX = e.clientX;
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
      const cursor = this.draggingCursor();
      if (cursor !== null) {
        this.stack.syncSize();
        const sample = this.toSample(e.clientX - rect.left);
        const consumed = cursor.marker.move({
          pointerId: e.pointerId,
          clientX: e.clientX,
          clientY: e.clientY,
          sample,
          captureLength: this.store.length,
          snap: this.snapContext(cursor.marker.channel, sample),
        });
        if (consumed) {
          if (cursor.marker.started) this.activeCursorId = cursor.id;
          if (this.cursorsPageShown()) this.capturePanel.updateCursors(this.cursorRows());
          if (this.cursorsPageShown()) this.capturePanel.updateCursorDistances(this.cursorDistanceRows());
          this.dirty = true; return;
        }
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
          this.noteViewportIntent();
          this.dirty = true;
        }
        pinch = { dist, midX };
        return;
      }
      if (dragging) {
        const dpr = globalThis.devicePixelRatio || 1;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        this.stack.panPixels(-dx * dpr);
        // Any real pan ends a trigger-locked follow window; the lock itself only clamps
        // the user's ViewWindow inside the data window.
        this.noteViewportIntent();
        this.dirty = true;
        return;
      }
      this.updateHover(e.clientX - rect.left, e.clientY - rect.top);
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      let markerEnded = false;
      for (const cursor of this.cursors) {
        if (cursor.marker.endDrag(e.pointerId)) markerEnded = true;
      }
      if (plot.hasPointerCapture(e.pointerId)) plot.releasePointerCapture(e.pointerId);
      this.syncMarkerCursor(e.clientX - plot.getBoundingClientRect().left);
      if (markerEnded) { this.renderPanels(); this.dirty = true; return; }
      if (pinch && pointers.size >= 2) {
        // Three fingers down and one lifted: the pinch pair changed identity, so the
        // baseline must be re-measured or the next move zooms by the pair difference.
        const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2 };
      } else if (pinch) {
        pinch = null;
        const rest = [...pointers.values()][0];
        if (rest) { dragging = true; lastX = rest.x; }
      }
      if (!dragging || pointers.size > 0) return;
      dragging = false;
    };
    plot.addEventListener('pointerup', end);
    plot.addEventListener('pointercancel', end);
    plot.addEventListener('lostpointercapture', (e) => {
      const cursor = this.cursors.find((c) => c.marker.pointerId === e.pointerId);
      if (cursor === undefined) return;
      pointers.delete(e.pointerId);
      cursor.marker.cancelDrag();
      this.syncMarkerCursor(null);
      this.dirty = true;
    });
    plot.addEventListener('pointerleave', () => {
      this.hover = null;
      this.syncMarkerCursor(null);
      this.dirty = true;
    });
    plot.addEventListener('dblclick', (e) => {
      if (this.store.length === 0) return;
      const rect = plot.getBoundingClientRect();
      const raw = Math.round(this.toSample(e.clientX - rect.left));
      this.placeCursorAt(raw, e.clientY - rect.top);
    });

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
      this.noteViewportIntent();
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
          (target.isContentEditable ||
            target.closest('.select-field, .assistant-panel, .cursor-dist-popover') !== null ||
            target.closest('.ch-editor-popover, button, [role="button"], [role="slider"]') !== null)) return;
      if (target instanceof HTMLElement && target.closest('dialog[open]') !== null) return;
      const shortcut = shortcutIdFor(e.key);
      if (shortcut === 'capture.toggle') {
        e.preventDefault();
        this.primaryAction();
      } else if (shortcut === 'view.fit') {
        this.beginViewportGesture();
        if (!this.fitLockedViewport()) this.stack.zoomToFit();
        this.dirty = true;
      } else if (shortcut === 'cursors.clear') {
        if (document.querySelector('.cursor-dist-popover:popover-open') !== null) return;
        this.releaseMarkerPointer();
        this.clearCursors();
        this.renderPanels();
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
    const pointerCssX = e.clientX - rect.left;
    const candidate = nearestCursorGrab(this.grabCandidates(), pointerCssX);
    if (candidate === null) return false;
    const cursor = this.cursorById(candidate.id);
    if (cursor === null) return false;
    const row = this.rowAt(e.clientY - rect.top);
    const grabbed = cursor.marker.tryGrab({
      pointerId: e.pointerId,
      clientX: e.clientX,
      clientY: e.clientY,
      pointerCssX,
      markerCssX: candidate.cssX,
      channel: row && row.spec.kind !== 'blank' ? row.spec.channel : null,
      captureLength: this.store.length,
    });
    return grabbed;
  }

  private snapContext(channel: number | null, center: number): MarkerSnapContext | null {
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

  private placeCursorAt(raw: number, cssY: number): void {
    this.addCursor(this.snapPlacement(raw, cssY) ?? raw);
  }

  private snapPlacement(raw: number, cssY: number): number | null {
    const snap = this.snapContext(this.rowAt(cssY)?.spec.channel ?? null, raw);
    if (snap === null) return null;
    const window = markerEdgeWindow(raw, snap.queryRadiusSamples, this.store.length);
    if (window === null) return null;
    return nearestMarkerEdge(
      snap.readEdges(window.lo, window.hi), raw, snap.exactRadiusSamples,
    );
  }

  private grabCandidates(): CursorGrabCandidate[] {
    const candidates: CursorGrabCandidate[] = [];
    for (const cursor of this.cursors) {
      const sample = cursor.marker.sample;
      if (sample === null) continue;
      candidates.push({ id: cursor.id, cssX: this.toPx(sample) });
    }
    return candidates;
  }

  private cursorById(id: number | null): CursorLine | null {
    if (id === null) return null;
    return this.cursors.find((cursor) => cursor.id === id) ?? null;
  }

  private activeCursor(): CursorLine | null {
    return this.cursorById(this.activeCursorId);
  }

  private draggingCursor(): CursorLine | null {
    return this.cursors.find((cursor) => cursor.marker.isDragging) ?? null;
  }

  private renumberCursors(): void {
    const labels = cursorLabels(this.cursors.length);
    for (let index = 0; index < this.cursors.length; index++) {
      this.cursors[index]!.marker.setLabel(labels[index]!);
      this.cursors[index]!.marker.setColor(cursorColor(index));
    }
  }

  private addCursor(sample: number): void {
    const marker = new WaveformMarker('', cursorColor(this.cursors.length));
    marker.setSample(sample, this.store.length);
    if (marker.sample === null) return;
    const id = this.nextCursorId++;
    this.cursors.push({ id, marker });
    this.renumberCursors();
    this.activeCursorId = id;
    if (this.cursors.length === 2) {
      const seeded = seedDistanceRow(
        this.distanceRows, this.nextDistanceRowId, this.cursors.map((cursor) => cursor.id),
      );
      if (seeded !== null) {
        this.distanceRows = seeded;
        this.nextDistanceRowId++;
      }
    }
    this.renderPanels();
    this.dirty = true;
  }

  private addDistanceRow(): void {
    const rows = appendDistanceRow(this.distanceRows, this.nextDistanceRowId);
    if (rows === this.distanceRows) return;
    this.distanceRows = rows;
    this.nextDistanceRowId++;
    this.renderPanels();
  }

  private removeDistanceRow(rowId: number): void {
    this.distanceRows = dropDistanceRow(this.distanceRows, rowId);
    this.renderPanels();
  }

  private pickDistanceCursor(rowId: number, side: DistanceSide, cursorId: number): void {
    this.distanceRows = assignDistanceCursor(this.distanceRows, rowId, side, cursorId);
    this.renderPanels();
    const invoker = document.getElementById(cursorDistanceSideId(rowId, side));
    if (invoker !== null) invoker.focus();
  }

  private cursorDistanceRows(): CursorDistanceRowView[] {
    const labels = cursorLabels(this.cursors.length);
    const sides = new Map<number, CursorDistanceSideView>();
    for (let index = 0; index < this.cursors.length; index++) {
      const cursor = this.cursors[index]!;
      sides.set(cursor.id, { id: cursor.id, label: labels[index]!, color: cursorColor(index) });
    }
    const samples = new Map<number, number>();
    for (const cursor of this.cursors) {
      const sample = cursor.marker.sample;
      if (sample !== null && Number.isFinite(sample)) samples.set(cursor.id, sample);
    }
    const samplePeriod = 1 / this.store.samplerate;
    return this.distanceRows.map((row, index) => ({
      id: row.id,
      row: index + 1,
      a: row.a === null ? null : sides.get(row.a) ?? null,
      b: row.b === null ? null : sides.get(row.b) ?? null,
      delta: distanceCell(row, samples, samplePeriod),
    }));
  }

  private edgeChannels(): number[] {
    return this.enabledChannels().map((channel) => channel.index);
  }

  private edgeChannelOptions(): CursorEdgeChannelView[] {
    return this.enabledChannels().map((channel) => ({ index: channel.index, name: channel.name }));
  }

  private reconcileEdgeChannels(): void {
    this.edgeRows = pruneEdgeChannels(this.edgeRows, new Set(this.edgeChannels()));
  }

  private addEdgeRow(): void {
    const rows = appendEdgeRow(this.edgeRows, this.nextEdgeRowId, this.edgeChannels()[0] ?? null);
    if (rows === this.edgeRows) return;
    this.edgeRows = rows;
    this.nextEdgeRowId++;
    this.renderPanels();
  }

  private removeEdgeRow(rowId: number): void {
    this.edgeRows = dropEdgeRow(this.edgeRows, rowId);
    this.renderPanels();
  }

  private pickEdgeCursor(rowId: number, side: DistanceSide, cursorId: number): void {
    this.edgeRows = assignEdgeCursor(this.edgeRows, rowId, side, cursorId);
    this.renderPanels();
    const invoker = document.getElementById(cursorEdgeSideId(rowId, side));
    if (invoker !== null) invoker.focus();
  }

  private pickEdgeChannel(rowId: number, channel: number | null): void {
    this.edgeRows = assignEdgeChannel(this.edgeRows, rowId, channel);
    this.renderPanels();
  }

  private cursorRows(): CursorRowView[] {
    const origin = this.triggerSampleIndex ?? 0;
    const rows: Omit<CursorRowView, 'time'>[] = [];
    for (const cursor of this.cursors) {
      const sample = cursor.marker.sample;
      if (sample === null) continue;
      rows.push({
        id: cursor.id,
        label: cursor.marker.label,
        color: cursor.marker.color,
        seconds: (sample - origin) / this.store.samplerate,
        sample,
      });
    }
    const times = formatCursorTimes(rows, 1 / this.store.samplerate);
    return rows.map((row, index) => ({ ...row, time: times[index]! }));
  }

  private cursorEdgeRows(): CursorEdgeRowView[] {
    const labels = cursorLabels(this.cursors.length);
    const sides = new Map<number, CursorDistanceSideView>();
    const samples = new Map<number, number>();
    for (let index = 0; index < this.cursors.length; index++) {
      const cursor = this.cursors[index]!;
      sides.set(cursor.id, { id: cursor.id, label: labels[index]!, color: cursorColor(index) });
      const sample = cursor.marker.sample;
      if (sample !== null && Number.isFinite(sample)) samples.set(cursor.id, sample);
    }
    const channels = new Set(this.edgeChannels());
    return this.edgeRows.map((row, index) => {
      let result = CURSOR_EDGE_EMPTY_RESULT;
      const aSample = row.a === null ? undefined : samples.get(row.a);
      const bSample = row.b === null ? undefined : samples.get(row.b);
      if (this.store.length > 0 && row.channel !== null && channels.has(row.channel) &&
          aSample !== undefined && bSample !== undefined &&
          aSample <= this.store.length && bSample <= this.store.length) {
        result = countCursorEdges(this.store, row.channel, aSample, bSample).cell;
      }
      return {
        id: row.id,
        row: index + 1,
        a: row.a === null ? null : sides.get(row.a) ?? null,
        b: row.b === null ? null : sides.get(row.b) ?? null,
        channel: row.channel !== null && channels.has(row.channel) ? row.channel : null,
        result,
      };
    });
  }

  private focusCursor(id: number): void {
    const cursor = this.cursorById(id);
    const sample = cursor?.marker.sample ?? null;
    if (sample === null) return;
    this.noteViewportIntent();
    const span = this.stack.viewport.end - this.stack.viewport.start;
    this.stack.setViewport(sample - span / 2, sample + span / 2);
    this.activeCursorId = id;
    this.renderPanels();
    this.dirty = true;
  }

  private removeCursor(id: number): void {
    const index = this.cursors.findIndex((cursor) => cursor.id === id);
    if (index < 0) return;
    this.cursors.splice(index, 1);
    if (this.activeCursorId === id) {
      const last = this.cursors[this.cursors.length - 1];
      this.activeCursorId = last === undefined ? null : last.id;
    }
    this.renumberCursors();
    this.distanceRows = pruneDistancePairs(
      this.distanceRows, new Set(this.cursors.map((cursor) => cursor.id)),
    );
    this.edgeRows = pruneEdgeCursors(
      this.edgeRows, new Set(this.cursors.map((cursor) => cursor.id)),
    );
    this.renderPanels();
    this.dirty = true;
  }

  private clearCursors(): void {
    this.cursors = [];
    this.activeCursorId = null;
    this.distanceRows = clearDistancePairs(this.distanceRows);
    this.edgeRows = clearEdgeCursors(this.edgeRows);
  }

  private cancelMarkerDrags(): void {
    for (const cursor of this.cursors) cursor.marker.cancelDrag();
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
    if (!box || box.spec.kind === 'lane' || box.spec.kind === 'blank') { this.dirty = true; return; }
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

  /** Forget the trigger position and any window it owned. Used by every T reset. */
  private clearTriggerSample(): void {
    this.triggerSampleIndex = null;
    this.triggerViewPending = false;
    this.triggerViewOffsetStart = 0;
    this.triggerViewOffsetEnd = 0;
    this.triggerViewLock = null;
    this.triggerViewLost = false;
    this.triggerAutoDisarmed = false;
  }

  /** Bookkeeping shared by every viewport gesture. */
  private beginViewportGesture(): void {
    if (this.session) this.viewIntent = true;
    this.setFollow(false);
  }

  /**
   * A viewport gesture finished. The trigger owns the DurationWindow, not the view: the
   * gesture may pan/zoom the user's ViewWindow anywhere inside D, but it never moves T,
   * never resets V to T, and never releases the lock. Clamping V into D is the only
   * coupling.
   */
  private noteViewportIntent(): void {
    this.beginViewportGesture();
    this.clampLockView();
  }

  /** Keep the ViewWindow inside the DurationWindow; T and the lock are untouched. */
  private clampLockView(): void {
    const lock = this.triggerViewLock;
    if (!lock || this.triggerSampleIndex === null) return;
    const D = this.loopRetentionLen;
    if (!(D > 0)) return;
    const view = this.stack.view;
    const clamped = clampLoopViewOffsets(
      view.start - this.triggerSampleIndex,
      view.end - this.triggerSampleIndex,
      lock.fraction, D,
    );
    this.triggerViewOffsetStart = clamped.start;
    this.triggerViewOffsetEnd = clamped.end;
    this.placeLockViewport();
  }

  /** Place the user's ViewWindow at its stored offsets from the current T. */
  private placeLockViewport(): void {
    if (this.triggerSampleIndex === null) return;
    const start = this.triggerSampleIndex + this.triggerViewOffsetStart;
    const end = this.triggerSampleIndex + this.triggerViewOffsetEnd;
    if (end > start) this.stack.restoreViewport(start, end);
  }

  /** Explicit viewport command (assistant/screenshot driver): clamp like a gesture. */
  private noteExplicitViewport(): void {
    this.beginViewportGesture();
    this.clampLockView();
  }

  /**
   * Fit resets the user's ViewWindow to the whole DurationWindow. It is a view command
   * only: the data window, T and the trigger lock are untouched.
   */
  private fitViewport(): void {
    this.beginViewportGesture();
    if (!this.fitLockedViewport()) this.stack.zoomToFit();
    this.dirty = true;
  }

  /**
   * Fit a held Loop view to its data window. Returns false when no lock owns the view,
   * so the caller can fall back to the ordinary zoom-to-fit.
   */
  private fitLockedViewport(): boolean {
    const lock = this.triggerViewLock;
    if (lock && this.triggerSampleIndex !== null && this.loopRetentionLen > 0) {
      this.triggerViewOffsetStart = -lock.fraction * this.loopRetentionLen;
      this.triggerViewOffsetEnd = (1 - lock.fraction) * this.loopRetentionLen;
      this.placeLockViewport();
      return true;
    }
    return false;
  }

  /**
   * The extent the overview strip represents. A running loop shows its loop window, not
   * the retained length: a locked view maps the true data window [T - f*L, T + (1-f)*L]
   * (a local roll can leave the store front up to 63 samples before that start, so the
   * front is NOT the window origin), and a free run shows the newest window. Keeping the
   * span fixed is what stops the strip's scale and frame from shrinking and scrolling as
   * the store grows and drops.
   */
  private overviewWindow(): { start: number; span: number } {
    return loopOverviewWindow({
      loop: this.captureIsLoop,
      length: this.store.length,
      retention: this.loopRetentionLen,
      lockFraction: this.triggerViewLock?.fraction ?? null,
      triggerSample: this.triggerSampleIndex,
    });
  }

  /** Overview click/drag: put the viewport's center on `sample`, preserving its span. */
  private centerOverview(sample: number): void {
    if (this.store.length <= 0) return;
    const view = this.stack.viewport;
    const span = view.end - view.start;
    this.stack.setViewport(sample - span / 2, sample + span / 2);
    this.clampLockView();
    this.dirty = true;
  }

  /** Overview horizontal wheel: move the viewport by `samples`, preserving its span. */
  private panOverview(samples: number): void {
    if (this.store.length <= 0) return;
    const view = this.stack.viewport;
    this.stack.setViewport(view.start + samples, view.end + samples);
    this.clampLockView();
    this.dirty = true;
  }

  /** Overview wheel zoom: keep `anchor` fixed while the visible span scales by `factor`. */
  private zoomOverview(anchor: number, factor: number): void {
    if (this.store.length <= 0 || !(factor > 0) || !Number.isFinite(factor)) return;
    const view = this.stack.viewport;
    if (!(view.end > view.start)) return;
    const span = view.end - view.start;
    const start = anchor - (anchor - view.start) * factor;
    this.stack.setViewport(start, start + span * factor);
    this.clampLockView();
    this.dirty = true;
  }

  /** The gesture changed the view; store it as this session's fixed T-relative interval. */
  private captureFixedView(): void {
    this.viewIntent = false;
    const session = this.session;
    const sr = this.store.samplerate;
    if (!session || !(sr > 0)) return;
    // The displayed origin, not just the current wave's T: while a Repeat wave waits,
    // the previous wave's T anchors the view the user is actually moving.
    const origin = this.displayOriginSample();
    const view = this.stack.view;
    if (!(view.end > view.start)) return;
    this.session = sessionWithManualView(session,
      (view.start - origin) / sr, (view.end - origin) / sr);
  }

  /**
   * The current sweep's retained range, in seconds relative to T (or to the sweep start
   * when it has no trigger). `triggerActive` is true only once a trigger sample exists.
   * The window is the sweep's configured/expected range, not the live store: a Fixed
   * view that the sweep will cover later is not stale yet.
   */
  private sessionRetainedSeconds(): {
    startSec: number; endSec: number; triggerActive: boolean;
  } {
    const sr = this.store.samplerate;
    if (!(sr > 0)) return { startSec: 0, endSec: 0, triggerActive: false };
    const triggerActive = this.triggerSampleIndex !== null;
    if (this.captureUsesSoftwareTrigger && this.captureTriggerBase) {
      const pre = this.captureTriggerBase.preTriggerSamples / sr;
      const post = Math.max(0,
        this.captureLimitSamples - this.captureTriggerBase.preTriggerSamples) / sr;
      return { startSec: -pre, endSec: post, triggerActive };
    }
    return { startSec: 0, endSec: this.captureLimitSamples / sr, triggerActive };
  }

  /**
   * Resolve and apply the session's view policy for the current sweep.
   *
   * FollowLive keeps the renderer's right-edge pin; Fixed restores the stored T-relative
   * interval; a Fixed interval that no longer fits the sweep's retained range falls back
   * to the mode default (never an automatic Fit). The Loop trigger lock still owns the
   * Loop viewport in this stage, so Loop is skipped here.
   */
  private applySessionView(): void {
    const session = this.session;
    if (!session || this.settings.mode === 'loop') return;
    // While the previous Repeat wave is still on screen, its own T and the previous
    // policy are what the user sees; the new wave's policy applies once it owns the plot.
    if (this.repeatShowingFront) return;
    // While a sweep waits for its trigger, the previous display and view stay valid.
    if (this.captureUsesSoftwareTrigger && this.triggerSampleIndex === null) return;
    const sr = this.store.samplerate;
    if (!(sr > 0)) return;
    const retained = this.sessionRetainedSeconds();
    const resolved = resolveSessionView(session, {
      triggerActive: retained.triggerActive,
      retained: { startSec: retained.startSec, endSec: retained.endSec },
      fraction: this.triggerViewFraction,
    });
    this.session = resolved.session;
    if (resolved.policy.kind === 'fixed') {
      const range = secondsRangeToSamples(resolved.view, sr);
      const origin = this.triggerSampleIndex ?? 0;
      const start = origin + range.start;
      const end = origin + range.end;
      const view = this.stack.view;
      if (Math.abs(view.start - start) > 0.5 || Math.abs(view.end - end) > 0.5) {
        this.stack.restoreViewport(start, end);
      }
      if (this.stack.followLatest) this.setFollow(false);
      return;
    }
    // FollowLive (the default, and the Fixed-out-of-range fallback): keep the current
    // span and pin its right edge to the newest sample.
    if (!this.stack.followLatest) this.setFollow(true);
  }

  /**
   * Choose what the Repeat display shows: the current wave alone (FollowLive, or no old
   * layer), the previous wave while the current one waits for its trigger, or the
   * two-layer composite that keeps a Fixed viewport filled while the new wave advances.
   *
   * Called after the session policy is resolved, because only a Fixed viewport needs the
   * old layer: FollowLive always looks at the newest samples and never past them.
   */
  private updateRepeatDisplay(): void {
    if (!this.repeatSession || this.settings.mode !== 'repeat' || !this.waveStore) return;
    if (this.repeatShowingFront) return;
    const back = this.waveStore;
    const front = this.repeatFront;
    const fixed = this.session?.policy.kind === 'fixed';
    if (fixed && front && front.store !== back &&
        (back.length > 0 || front.store.length > 0)) {
      const origin = this.triggerSampleIndex ?? 0;
      if (!this.repeatComposite ||
          this.repeatComposite.front !== front.store ||
          this.repeatComposite.back !== back ||
          this.repeatComposite.frontOrigin !== front.origin) {
        this.repeatComposite = new RepeatCompositeStore(back, origin, front);
      } else {
        this.repeatComposite.setBackOrigin(origin);
      }
      if (this.storeRef.target !== this.repeatComposite) this.setDisplayStore(this.repeatComposite);
      this.applyPendingCursorDelta();
      return;
    }
    this.repeatComposite = null;
    this.setDisplayStore(back);
    this.applyPendingCursorDelta();
  }

  /**
   * Apply the previous-wave-to-current-wave cursor offset after a display hand-over.
   * A cursor whose old-layer sample has no counterpart in the new store is dropped,
   * with the same policy the tool used before the cursor list replaced marker A.
   */
  private applyPendingCursorDelta(): void {
    const delta = this.pendingCursorDelta;
    if (delta === null) return;
    this.pendingCursorDelta = null;
    let changed = false;
    const survivors: CursorLine[] = [];
    for (const cursor of this.cursors) {
      const sample = cursor.marker.sample;
      if (sample === null || cursor.marker.isDragging) {
        // A live drag's sample comes from the pointer; the next pointermove re-derives
        // it against the new display, so translating it mid-gesture would fight it.
        survivors.push(cursor);
        continue;
      }
      const remapped = remapRepeatSample(sample, delta, this.store.length);
      if (remapped === null) { changed = true; continue; }
      cursor.marker.setSample(remapped, this.store.length);
      changed = true;
      survivors.push(cursor);
    }
    if (!changed) return;
    const before = this.cursors.length;
    this.cursors = survivors;
    if (this.cursors.length !== before) {
      if (this.activeCursorId !== null && this.cursorById(this.activeCursorId) === null) {
        const last = this.cursors[this.cursors.length - 1];
        this.activeCursorId = last === undefined ? null : last.id;
      }
      this.renumberCursors();
      this.distanceRows = pruneDistancePairs(
        this.distanceRows, new Set(this.cursors.map((cursor) => cursor.id)),
      );
      this.edgeRows = pruneEdgeCursors(
        this.edgeRows, new Set(this.cursors.map((cursor) => cursor.id)),
      );
      // A dropped cursor changes the row list; a pure shift only rewrites its cells.
      this.renderPanels();
    } else if (this.capturePageShown()) {
      this.capturePanel.updateCursors(this.cursorRows());
      this.capturePanel.updateCursorDistances(this.cursorDistanceRows());
      this.capturePanel.updateCursorEdges(this.cursorEdgeRows());
    }
    this.dirty = true;
  }

  /**
   * The previous wave stops owning the plot as soon as this one can show something: its
   * first samples when trigger-free, or its trigger's data block. Called before the
   * session view is resolved so the same frame uses the new display origin.
   */
  private releaseRepeatHold(): void {
    if (!this.repeatShowingFront) return;
    const back = this.waveStore;
    if (!back) return;
    if (!repeatHoldReleased({
      showingFront: this.repeatShowingFront,
      backLength: back.length,
      softwareTrigger: this.captureUsesSoftwareTrigger,
      triggerState: this.triggerState,
      triggerSampleIndex: this.triggerSampleIndex,
    })) return;
    const front = this.repeatFront;
    if (front && this.cursors.some((cursor) =>
      cursor.marker.sample !== null && !cursor.marker.isDragging)) {
      // The plot is moving from the old store's coordinates to the current wave's. The
      // offset is the same one the composite uses for the old layer.
      this.pendingCursorDelta = (this.triggerSampleIndex ?? 0) - front.origin;
    }
    this.repeatShowingFront = false;
    this.repeatHeldTrigger = null;
  }

  /** The displayed store's T: the current wave's trigger, or the held old wave's T. */
  private displayTriggerSample(): number | null {
    if (this.repeatShowingFront) return this.repeatHeldTrigger;
    return this.triggerSampleIndex ?? this.repeatHeldTrigger;
  }

  /** The displayed store's T: the current wave's trigger, or the held old wave's T. */
  private displayOriginSample(): number {
    return this.displayTriggerSample() ?? 0;
  }

  /**
   * Repeat background tints: the old span(s) and the current wave's span in the viewport.
   * Only requested while the composite is displayed and an old region is actually
   * visible; the two surfaces are the whole signal (no vertical rule).
   */
  private repeatTintRegions(): RegionTint[] | null {
    const composite = this.repeatComposite;
    if (!composite || this.storeRef.target !== composite) return null;
    const rate = composite.samplerate;
    if (!(rate > 0)) return null;
    const view = this.stack.view;
    const origin = composite.backOrigin;
    const surface = repeatSurfacePixels(composite, {
      startSec: (view.start - origin) / rate,
      endSec: (view.end - origin) / rate,
    }, this.el.plot.clientWidth);
    if (!surface || surface.old.length === 0) return null;
    const tints: RegionTint[] = surface.old.map((span) => ({
      startCss: span.x0, endCss: span.x1, color: this.palette.repeatPreviousSurface,
    }));
    if (surface.current) {
      tints.push({
        startCss: surface.current.x0, endCss: surface.current.x1,
        color: this.palette.repeatCurrentSurface,
      });
    }
    return tints;
  }

  private clearRepeatLayers(): void {
    // A session ended while the two-layer composite was displayed: the previous wave is
    // not part of this capture, so hand the plot back to the current store. (A running
    // wave reaching this path has already been stopped; a partial capture may therefore
    // show blank time beyond its end, which is the truth.)
    if (this.repeatComposite && this.storeRef.target === this.repeatComposite && this.waveStore) {
      this.setDisplayStore(this.waveStore);
    }
    // A cursor placed on old-layer time may sit past a partial current capture. Same
    // policy as a hand-over: drop it rather than pull it to the end of a shorter wave.
    const wave = this.waveStore;
    if (wave) this.settleCursorsForStore(wave.length);
    this.pendingCursorDelta = null;
    this.repeatFront = null;
    this.repeatComposite = null;
    this.repeatShowingFront = false;
    this.repeatHeldTrigger = null;
  }

  /**
   * Drop cursors whose samples do not exist in a store of `length`. A live drag keeps
   * its pointer-derived sample because the next pointermove re-derives it.
   */
  private settleCursorsForStore(length: number): void {
    const before = this.cursors.length;
    this.cursors = this.cursors.filter((cursor) => {
      const sample = cursor.marker.sample;
      return sample === null || cursor.marker.isDragging || (sample >= 0 && sample < length);
    });
    if (this.cursors.length === before) return;
    if (this.activeCursorId !== null && this.cursorById(this.activeCursorId) === null) {
      const last = this.cursors[this.cursors.length - 1];
      this.activeCursorId = last === undefined ? null : last.id;
    }
    this.renumberCursors();
    this.distanceRows = pruneDistancePairs(
      this.distanceRows, new Set(this.cursors.map((cursor) => cursor.id)),
    );
    this.edgeRows = pruneEdgeCursors(
      this.edgeRows, new Set(this.cursors.map((cursor) => cursor.id)),
    );
    this.renderPanels();
  }

  /**
   * A stopped/ended Repeat session whose current wave never showed anything keeps the
   * previous completed wave on screen. Make that wave the capture as well, so the plot,
   * the status, Save and the assistant all describe the same samples. Called before the
   * display layers are cleared.
   */
  private settleHeldRepeatWave(): void {
    if (!this.repeatShowingFront) return;
    const front = this.repeatFront;
    if (!front) return;
    this.waveStore = front.store;
    this.triggerSampleIndex = front.hasTrigger ? front.origin : null;
    this.triggerState = front.hasTrigger ? 'triggered' : 'off';
    this.settledHeldCapture = true;
    this.setDisplayStore(front.store);
    this.repeatShowingFront = false;
    this.repeatHeldTrigger = null;
    this.repeatComposite = null;
    this.pendingCursorDelta = null;
  }

  /**
   * Settle a held previous wave and give it the capture label its samples deserve. The
   * stopped-session paths that do not go through `finishCapture` use this; otherwise a
   * miss's "0 samples / no trigger" label would sit on top of the adopted wave.
   */
  private settleAndLabelHeldWave(): void {
    this.settleHeldRepeatWave();
    if (!this.settledHeldCapture) return;
    const captured = this.captureStore;
    const sr = captured.samplerate;
    this.captureLabel = {
      kind: 'live', samples: captured.length, rate: sr, seconds: captured.length / sr,
    };
  }

  /**
   * Swap what the renderer reads without touching the capture. A Repeat wave boundary
   * moves between the current store, the previous wave and their composite; those are
   * the same samples in the same coordinate space, so the marker and the view survive.
   * Capture replacement still uses `storeRef.set` and releases the marker pointer first.
   */
  private setDisplayStore(store: SampleStore): void {
    if (this.storeRef.target === store) return;
    this.storeRef.set(store);
  }

  /**
   * Place the initial trigger view. After that the lock is never re-applied by a frame:
   * the local roll updates T and the stored ViewWindow offsets keep V in place. A
   * plot-width change only re-clamps V; `syncSize` has already preserved the time scale.
   */
  private applyTriggerViewAnchor(rescaled: boolean): void {
    if (this.triggerViewPending) {
      // A pending placement belongs to an armed acquisition. A disabled trigger (mask
      // off, or a disarmed capture) must never pin a view from a late match message.
      if (!this.captureUsesSoftwareTrigger || !this.settings.triggerEnableMask) {
        this.triggerViewPending = false;
        this.triggerSampleIndex = null;
        return;
      }
      // The trigger message can precede the coalesced transport block that carries the
      // sample (it is posted as soon as the matcher matches). Place the view only once
      // the store actually holds T, so the first locked frame is not a blank future
      // window; the pending flag survives until then.
      if (this.triggerSampleIndex === null || this.triggerSampleIndex >= this.store.length) return;
      this.triggerViewPending = false;
      const D = this.triggerRollSpan();
      const fraction = this.triggerViewFraction;
      this.triggerViewOffsetStart = -fraction * D;
      this.triggerViewOffsetEnd = (1 - fraction) * D;
      this.triggerViewLock = {
        fraction,
        resumeFollow: this.stack.followLatest,
      };
      this.triggerAutoDisarmed = false;
      // The scanner runs before the block is appended, so it may already have reported
      // crossings after T in this same block. Keep the latest real edge; resetting to T
      // would shorten the quiet window and release the lock early.
      this.lastAnalogCrossingAbs = Math.max(
        this.lastAnalogCrossingAbs,
        this.store.droppedSamples + this.triggerSampleIndex,
      );
      this.placeLockViewport();
      return;
    }
    if (!rescaled) return;
    this.clampLockView();
  }

  /**
   * The DurationWindow length in samples. It is the base for the local roll budget and
   * for the initial T fraction; the user's ViewWindow span is independent of it.
   */
  private triggerRollSpan(): number {
    if (this.captureIsLoop && this.loopRetentionLen > 0) return this.loopRetentionLen;
    const view = this.stack.view;
    return Math.max(1, view.end - view.start);
  }

  /**
   * Stack size sync from a pointer handler. A plot-width change rescales the sample range,
   * so a trigger-locked viewport must be re-placed now: the next draw's `syncSize()` would
   * already see the new width and report no rescale.
   */
  private syncPlotSize(): void {
    if (this.stack.syncSize()) this.applyTriggerViewAnchor(true);
  }

  private syncMarkerCursor(pointerCssX: number | null): void {
    const nearest = pointerCssX === null
      ? null : nearestCursorGrab(this.grabCandidates(), pointerCssX);
    const next = markerPointerCursor(
      pointerCssX, nearest?.cssX ?? null, this.draggingCursor() !== null,
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
      this.fitViewport();
    });
    must<HTMLButtonElement>('btn-fullscreen').addEventListener('click', () => void this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.renderToolbarState());
    must<HTMLButtonElement>('btn-settings').addEventListener('click', () => {
      // Keep the channel dialog and this transient menu from competing for focus.
      this.channelList.closeDialog();
      this.menuStack.closeOthers(this.settingsMenu, 'outside');
      this.settingsMenu.toggle(this.settingsItems());
    });
    this.el.language.addEventListener('click', () => {
      this.channelList.closeDialog();
      this.menuStack.closeOthers(this.languageMenu, 'outside');
      this.languageMenu.toggle(this.languageItems());
    });
    this.el.theme.addEventListener('click', () => {
      this.channelList.closeDialog();
      this.menuStack.closeOthers(this.themeMenu, 'outside');
      this.themeMenu.toggle(this.themeItems());
    });
    this.el.assistant.addEventListener('click', () => {
      this.channelList.closeDialog();
      this.menuStack.closeAll('outside');
      this.toggleAssistant();
    });
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch {
    }
  }

  /** The toolbar shortcut to the assistant: open it, or close it and land on the page the user had. */
  private toggleAssistant(): void {
    const showing = this.assistantShown();
    this.applySidebar(showing
      ? nextAssistantState(this.sidebar)
      : showAssistant(this.sidebar));
    if (!showing) this.assistantPanel?.focusInput();
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
      {
        label: t('settings.shortcuts'),
        hint: '▸',
        onPick: () => {
          this.channelList.closeDialog();
          this.shortcutsDialog.open(this.el.settings);
        },
      },
    ];
  }

  private languageItems(): SettingsMenuItem[] {
    return LOCALES.map((l) => ({
      label: LOCALE_LABELS[l],
      checked: l === getLocale(),
      onPick: () => { void setLocale(l).then((r) => {
        if (r === 'failed') this.fail('error.localeLoad', new DiagnosticError('ui.localeLoad', { locale: l }));
      }); },
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
        singleUnlimited: this.settings.singleUnlimited,
        repeatIntervalSeconds: this.settings.repeatIntervalSeconds,
        loopSamples: this.settings.loopSamples,
        testMode: this.settings.testMode,
        triggerEnableMask: this.settings.triggerEnableMask,
        triggerModes: { ...this.settings.triggerModes },
        analogTriggers: { ...this.settings.analogTriggers },
        triggerSource: this.settings.triggerSource,
        preTriggerPercent: this.settings.preTriggerPercent,
      },
      busViews: this.busViews.map((bus) => cloneBusConfig(bus)),
      analyzers: this.analyzers.map((a): PersistedAnalyzer => ({
        id: a.id,
        decoderId: a.decoderId,
        label: a.label,
        color: a.color,
        channels: { ...a.channels },
        options: { ...a.options },
        laneChannel: a.laneChannel,
      })),
      sidebar: { page: this.sidebar.page, visible: this.sidebar.visible },
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

  private capturePageShown(): boolean {
    const s = this.sidebar;
    return s.visible && !s.assistant && s.page === 'capture';
  }

  private cursorsPageShown(): boolean {
    const s = this.sidebar;
    return s.visible && !s.assistant && s.page === 'cursors';
  }

  private decodersPageShown(): boolean {
    const s = this.sidebar;
    return s.visible && !s.assistant && s.page === 'decoders';
  }

  private assistantShown(): boolean {
    const s = this.sidebar;
    return s.visible && s.assistant;
  }

  private applySidebar(next: SidebarState): void {
    this.sidebar = next;
    this.persistWorkspace();
    this.renderPanels();
    this.relayout();
  }

  private selectPanel(p: 'device' | 'analyzers' | 'assistant' | null): void {
    if (p === 'assistant') {
      if (!this.assistantShown()) {
        this.applySidebar(showAssistant(this.sidebar));
        this.assistantPanel?.focusInput();
      }
      return;
    }
    if (p === null) {
      this.applySidebar(hideSidebar(this.sidebar));
      return;
    }
    this.applySidebar(selectSidebarPage(this.sidebar, p === 'device' ? 'capture' : 'decoders'));
  }

  private selectPage(page: SidebarPage): void {
    this.applySidebar(selectSidebarPage(this.sidebar, page));
  }

  private handleCollapse(): void {
    this.applySidebar(toggleSidebarVisible(this.sidebar));
    this.sidebarHost.focusAfterCollapse();
  }

  private handleExpand(): void {
    this.applySidebar(toggleSidebarVisible(this.sidebar));
    if (this.assistantShown()) this.assistantPanel?.focusInput();
    else this.sidebarHost.focusAfterExpand();
  }

  private mountSidebarPage(page: SidebarPage, container: HTMLElement): void {
    if (page === 'capture') {
      this.capturePanel = new CapturePanel({
        capture: container,
        cursors: this.sidebarHost.containerFor('cursors'),
      }, {
        onSettings: (s) => this.applySettings(s),
        onToggleChannel: (i, on) => this.setChannelEnabled(i, on),
        onToggleAnalog: (start) => this.toggleAnalog(start),
        onChannelWidth: (n) => this.setChannelWidth(n),
        onUsbControl: (command) => this.usbControl(command),
        onRemoveCursor: (id) => this.removeCursor(id),
        onFocusCursor: (id) => this.focusCursor(id),
        onAddCursorDistance: () => this.addDistanceRow(),
        onRemoveCursorDistance: (rowId) => this.removeDistanceRow(rowId),
        onPickCursorDistance: (rowId, side, cursorId) =>
          this.pickDistanceCursor(rowId, side, cursorId),
        onAddCursorEdge: () => this.addEdgeRow(),
        onRemoveCursorEdge: (rowId) => this.removeEdgeRow(rowId),
        onPickCursorEdge: (rowId, side, cursorId) => this.pickEdgeCursor(rowId, side, cursorId),
        onPickCursorEdgeChannel: (rowId, channel) => this.pickEdgeChannel(rowId, channel),
      });
      return;
    }
    if (page === 'decoders') {
      const analyzerRoot = document.createElement('div');
      analyzerRoot.className = 'side-body';
      const busRoot = document.createElement('div');
      busRoot.className = 'side-body';
      container.append(analyzerRoot, busRoot);
      this.analyzerPanel = new AnalyzerPanel(analyzerRoot, {
        onAttach: (id, ch, opts) => void this.attachAnalyzer(id, ch, opts),
        onRemove: (id) => this.removeAnalyzer(id),
        onRedecode: (id) => void this.runDecode(id),
        onCancel: () => this.abort?.abort(),
      });
      this.busPanel = new BusPanel(busRoot, {
        onAdd: (cfg) => this.addBus(cfg),
        onEdit: (id) => this.editBus(id),
        onUpdate: (id, cfg) => this.updateBus(id, cfg),
        onRemove: (id) => this.removeBus(id),
      });
    }
  }

  /** Re-render every string in the shell after a locale change. */
  private retranslate(): void {
    this.menuStack.closeAll('retranslate');
    applyStaticI18n(document);
    if (this.shortcutsDialog.isOpen) this.shortcutsDialog.renderStrings();
    this.relayout();       // channel cells rebuild; an open channel dialog closes here
    this.renderPanels();   // side panels + toolbar chrome
    this.assistantPanel?.render();  // its chrome only; the conversation is history
    this.renderStatus();   // status line
    this.dirty = true;     // canvas labels (the overview origin, tick units) re-render
  }

  /**
   * Loop display instrumentation, computed from the same parameters the block planner
   * uses. This is a readout, not a control: the auto-roll advances one scanned crossing
   * at a time, and the block is what the frame budget could carry if a swap were made.
   */
  /** The fields the trigger-state notes need, for their text-only refresh path. */
  private triggerStatusView(): TriggerStatusView {
    return {
      mode: this.settings.mode,
      running: this.running,
      stopping: this.stopping,
      triggerState: this.triggerState,
      triggerViewLost: this.triggerViewLost,
      triggerViewPending: this.triggerViewPending,
      triggerLocked: this.triggerViewLock !== null,
      triggerAnalogRolling: this.analogScanner !== null,
      triggerArmed: this.captureUsesSoftwareTrigger && this.running && !this.stopping,
      triggerAutoDisarmed: this.triggerAutoDisarmed,
      settingsArmed: this.triggerSettingsArmed(),
      repeatMissed: this.repeatMissed,
    };
  }

  /** Whether the current settings request a trigger with at least one in-width condition. */
  private triggerSettingsArmed(): boolean {
    if (!this.settings.triggerEnableMask) return false;
    const channels = this.store.channelCount;
    if (!isChannelCount(channels)) return false;
    const plan = this.triggerPlan(this.settings);
    return plan.digital.some((condition) => condition.channel < channels) ||
      plan.analog.some((trigger) => trigger.start + CHANNEL_BANK_SIZE <= channels);
  }

  private computeLoopMetrics(): LoopDisplayMetrics | null {
    if (!this.captureIsLoop || !this.analogScanner) return null;
    const store = this.store;
    const rate = store.samplerate;
    const channels = store.channelCount;
    if (!(rate > 0) || !isChannelCount(channels)) return null;
    const liveAbs = store.length + store.droppedSamples;
    const D = this.loopRetentionLen > 0 ? this.loopRetentionLen : 1;
    // The local roll's budget is based on the fresh data beyond the DurationWindow's
    // right edge, not on the user's (possibly zoomed) ViewWindow span.
    const triggerAbs = this.triggerSampleIndex === null
      ? null : store.droppedSamples + this.triggerSampleIndex;
    const fraction = this.triggerViewLock?.fraction ?? 0;
    const available = triggerAbs === null
      ? Math.max(0, liveAbs - this.loopSwapCursorAbs)
      : Math.max(0, liveAbs - (triggerAbs + (1 - fraction) * D));
    const plan = planLoopSwap({
      samplerate: rate,
      channels,
      availableSamples: available,
      windowSamples: Math.max(1, D),
      // A local update should not repaint the whole window: at most a quarter of it,
      // unless the frame budget already makes the block smaller.
      maxWindowFraction: 0.25,
      ...(this.loopPeriodSamples >= 1 ? { periodSamples: this.loopPeriodSamples } : {}),
    });
    const bytesPerSample = bytesPerSampleForChannels(channels);
    return {
      stride: this.analogScanner.stride,
      scanRateHz: rate / this.analogScanner.stride,
      periodSamples: this.loopPeriodSamples,
      anchorStepSamples: this.loopLastAnchorStep,
      blockSamples: plan.blockSamples,
      blockBytes: plan.blockBytes,
      refreshHz: plan.estimatedRefreshHz,
      retainedBytes: this.loopRetentionLen * bytesPerSample,
      fullWindow: plan.fullWindow,
    };
  }

  private progressView(): NonNullable<CapturePanelView['progress']> {    const loop = this.captureIsLoop;
    const unlimited = this.settings.mode === 'single' && this.settings.singleUnlimited;
    // Acquisition progress is the current wave's, not the Repeat display composite's.
    const captured = this.captureStore;
    return {
      seconds: this.captureStart > 0 ? (performance.now() - this.captureStart) / 1000 : 0,
      samples: loop ? captured.length + this.droppedTotal : captured.length,
      bytes: loop
        ? captured.length * bytesPerSampleForChannels(captured.channelCount)
        : this.captureBytes,
      lost: this.lostSamples,
      dropped: this.droppedTotal,
      kept: captured.length,
      limit: loop ? loopStoreLimit(
        this.loopRetentionLen,
        (this.triggerViewLock !== null || this.triggerViewPending) && this.analogScanner !== null,
        this.loopTriggerSlackSamples,
      ) : 0,
      targetSamples: loop || unlimited ? null : this.captureLimitSamples,
    };
  }

  private capturePanelState(): CapturePanelState {
    if (this.stopping) return 'stopping';
    if (this.repeatTimer.pending) return this.repeatSession ? 'capturing' : 'waiting';
    if (this.running) return 'capturing';
    return this.captureStore.length > 0 ? 'completed' : 'ready';
  }

  private renderPanels(): void {
    this.syncSidebar();
    this.renderSidebarContent();
  }

  private syncSidebar(): void {
    this.sidebarHost.show(this.sidebar);
    this.resizer.setHidden(!this.sidebar.visible);
    this.renderToolbarState();
  }

  private renderSidebarContent(): void {
    if (!this.sidebar.visible) return;
    if (this.assistantShown()) {
      // The assistant is mounted once and only shown or hidden: re-rendering it on every
      // state change would drop a streaming answer, a pending approval and the draft.
      if (!this.assistantPanel) {
        this.assistantPanel = new AssistantPanel(this.assistantHost());
        this.assistantPanel.el.hidden = false;
        this.sidebarHost.assistantLayer().appendChild(this.assistantPanel.el);
        this.assistantPanel.render();
      }
      return;
    }

    if (this.sidebar.page === 'capture' || this.sidebar.page === 'cursors') {
      this.capturePanel.render(this.capturePanelView());
      return;
    }
    this.analyzerPanel.render({
      channels: this.channels.slice(0, this.displayChannelCount()),
      analyzers: this.analyzers,
      captureChannels: this.captureStore.channelCount,
      hasCapture: this.captureStore.length > 0,
      warm: this.decodeWarm,
      busy: this.decodeBusy,
    });
    this.busPanel.render({
      buses: this.busViews, channelCount: this.displayChannelCount(),
      testMode: this.settings.testMode,
      captureLocked: this.stopping,
    });
  }

  private capturePanelView(): CapturePanelView {
    return {
      settings: this.settings,
      channels: this.channels.slice(0, this.displayChannelCount()),
      widthOptions: this.widthTiers(),
      buses: this.busViews,
      analogGroups: this.analogGroups(),
      deviceName: this.device?.name ?? null,
      running: this.running,
      stopping: this.stopping,
      repeatPending: this.repeatTimer.pending,
      captureState: this.capturePanelState(),
      result: this.captureStore.length > 0
        ? {
          samples: this.captureStore.length,
          seconds: this.captureStore.length / this.captureStore.samplerate,
        }
        : null,
      progress: this.running ? this.progressView() : null,
      maxSamplerateHz: this.rateCeilings,
      triggerState: this.triggerState,
      cursors: this.cursorRows(),
      cursorDistances: this.cursorDistanceRows(),
      cursorEdges: this.cursorEdgeRows(),
      cursorEdgeChannels: this.edgeChannelOptions(),
      triggerViewLost: this.triggerViewLost,
      triggerViewPending: this.triggerViewPending,
      triggerLocked: this.triggerViewLock !== null,
      triggerRetuneRejected: this.triggerRetuneRejected,
      triggerAnalogRolling: this.analogScanner !== null,
      triggerArmed: this.captureUsesSoftwareTrigger && this.running && !this.stopping,
      triggerAutoDisarmed: this.triggerAutoDisarmed,
      settingsArmed: this.triggerSettingsArmed(),
      activeTriggerPreSamples: this.running && this.captureTriggerBase
        ? this.captureTriggerBase.preTriggerSamples : undefined,
      loopMetrics: this.running && this.captureIsLoop ? this.computeLoopMetrics() : null,
      repeatMissed: this.repeatMissed,
    };
  }


  private primaryAction(): void {
    if (this.stopping) {
      // An automatic trigger restart is waiting for this stop; cancel its start so the
      // user's Stop is not overridden by a capture they did not ask for.
      this.cancelPendingTriggerRestart();
      return;
    }
    if (this.running || this.repeatTimer.pending) void this.stopCapture();
    else void this.startCapture();
  }

  /** A Stop during an automatic trigger restart cancels the pending start. */
  private cancelPendingTriggerRestart(): boolean {
    if (!this.stopping || !this.triggerRestartPending) return false;
    this.triggerRestartCancelled = true;
    return true;
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
    const repeatPending = this.repeatTimer.pending;
    const showStop = this.running || repeatPending;
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
    const full = !!document.fullscreenElement;
    const fullscreenUnavailable = document.fullscreenEnabled === false ||
      typeof document.documentElement.requestFullscreen !== 'function';
    this.el.fullscreen.disabled = fullscreenUnavailable;
    this.el.fullscreen.setAttribute('aria-pressed', String(full));
    this.el.fullscreen.setAttribute('aria-label', t('toolbar.fullscreen'));
    this.el.fullscreen.title = fullscreenUnavailable ? t('toolbar.fullscreenUnavailable')
      : full ? t('toolbar.exitFullscreenTitle') : t('toolbar.enterFullscreenTitle');
    this.el.settings.setAttribute('aria-label', t('settings.title'));
    this.el.language.setAttribute('aria-label', t('toolbar.languageTitle'));
    this.el.theme.setAttribute('aria-label', t('toolbar.themeTitle'));
    this.el.assistant.setAttribute('aria-label', t('toolbar.assistantTitle'));
    this.el.assistant.setAttribute('aria-pressed', String(this.assistantShown()));

    const btn = this.el.transport;
    btn.setAttribute('aria-label', this.stopping ? t('toolbar.stopping')
      : showStop ? t('toolbar.stop') : t('toolbar.start'));
    const label = btn.querySelector<HTMLElement>('.toolbar-item-label');
    if (label) {
      label.textContent = this.stopping ? t('toolbar.shortStopping')
        : showStop ? t('toolbar.shortStop') : t('toolbar.shortStart');
    }
    btn.classList.toggle('primary', !showStop);
    btn.classList.toggle('danger', showStop);
    btn.disabled = (this.stopping && !this.triggerRestartPending) ||
      (this.device === null && !showStop);
    btn.title = this.stopping ? t('toolbar.stoppingTitle')
      : showStop ? t('toolbar.stopTitle')
        : this.device ? t('toolbar.startTitle') : t('toolbar.connectHint');
  }

  private renderStatus(): void {
    // Capture statistics describe the current wave. A held previous frame is the only
    // exception: the capture is empty while the old wave is what the user sees, so report
    // that wave and say which one it is.
    const showingPrevious = this.repeatShowingFront;
    const store = showingPrevious ? this.store : this.captureStore;
    const view = this.stack.view;
    const sr = store.samplerate;
    const parts: string[] = [];
    parts.push(formatCaptureLabel(this.captureLabel));
    if (showingPrevious) parts.push(t('status.previousWave'));
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
    const origin = this.displayOriginSample();
    const active = this.activeCursor();
    const markerSample = active?.marker.sample ?? null;
    if (active !== null && markerSample !== null) {
      parts.push(`${active.marker.label} ${formatDuration((markerSample - origin) / sr)}`);
    }

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
    this.statusError = { what, ...(vars ? { vars } : {}), detail: statusDetailOf(e) };
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
    if (this.stopping || this.device === null) { this.fail('error.device', e); return; }
    this.deviceLost(e);
  }

  // ------------------------------------------------------------------ captures

  private async openFiles(files: File[]): Promise<void> {
    try {
      this.statusError = null;
      // An opened capture replaces the store the running sink appends to; stop first so
      // the sink cannot keep dropping/retaining the imported data. A Repeat wave in
      // teardown or between waves can still arm the next interval, so end it before and
      // after the load.
      if (this.running) await this.stopCapture('manual');
      if (this.stopPending) await this.stopPending;
      this.endPendingRepeatSession();
      const t0 = performance.now();
      const cap = await loadFiles(files);
      if (this.running) await this.stopCapture('manual');
      if (this.stopPending) await this.stopPending;
      this.endPendingRepeatSession();
      this.adoptCapture(cap.store, cap.channelNames,
        { kind: 'loaded', source: cap.sourceDescription, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      this.fail('error.openCapture', e);
    }
  }

  /**
   * End a Repeat session that is between waves (or whose teardown is still settling) and
   * adopt a held previous wave if that is what the display shows. Used by the file-open
   * path, which must not let a timer start a device sweep behind an import.
   */
  private endPendingRepeatSession(): void {
    if (this.running) return;
    const betweenWaves = this.repeatTimer.pending ||
      (this.session !== null && this.repeatSession);
    if (!betweenWaves) return;
    this.repeatTimer.cancel();
    this.settleAndLabelHeldWave();
    this.session = null;
    this.repeatWaveHolding = false;
    this.repeatMissed = false;
    this.clearRepeatLayers();
    this.relayout();
    this.renderPanels();
    this.renderStatus();
    this.dirty = true;
  }

  private adoptCapture(store: SampleStore, names: string[], label: CaptureLabel): void {
    this.repeatTimer.cancel();
    this.discardDecodeState();
    this.releaseMarkerPointer();
    this.storeRef.set(store);
    this.waveStore = store;
    this.repeatMissed = false;
    this.settledHeldCapture = false;
    this.clearRepeatLayers();
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
    this.clearCursors();
    this.triggerState = 'off';
    this.clearTriggerSample();
    this.session = null;
    this.analogScanner = null;
    this.analogCrossings = [];
    this.loopTriggerSlackSamples = 0;
    this.triggerRetuneRejected = false;
    this.captureUsesSoftwareTrigger = false;
    this.captureTriggerBase = null;
    this.droppedTotal = 0;
    this.captureIsLoop = false;
    this.captureLabel = label;
    this.widthExplicit = false;
    this.settings = carryCaptureDuration(this.settings, this.clampSettings(
      { ...this.settings, channels: channelWidthForProbes(store.channelCount) },
    ));
    this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));
    this.reconcileEdgeChannels();
    this.persistWorkspace();
    this.relayout();
    this.stack.zoomToFit();
    this.renderPanels();
    this.dirty = true;
  }

  private save(): void {
    try {
      if (this.captureStore.length === 0) throw new DiagnosticError('io.nothingToSave');
      const blob = saveLwcap(this.captureStore, this.channels.map((c) => c.name));
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
    this.repeatTimer.cancel();
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
    } else if (this.session && this.repeatSession) {
      // Lost during a Repeat retry interval: there is no running capture to finish, but
      // the session must still end and a held previous wave must become the capture.
      this.settleAndLabelHeldWave();
      this.session = null;
      this.repeatWaveHolding = false;
      this.repeatMissed = false;
      this.clearRepeatLayers();
      this.relayout();
      this.renderPanels();
      this.renderStatus();
      this.dirty = true;
    }
    return epoch;
  }

  private installDevice(d: Device, epoch: number): boolean {
    this.repeatTimer.cancel();
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
    this.awaitingReconnect = false;
    this.lostSerial = '';
    this.noteTransport();
    this.adoptDeviceChannels(d);
    this.renderPanels();
    return true;
  }

  private usbDisconnected(usb: USBDevice): void {
    const device = this.device;
    if (!device || !sameUsbDevice(device.serial, usb)) return;
    this.deviceLost(new DiagnosticError('device.disconnected', { device: device.name }));
  }

  private deviceLost(error: unknown, report = true): void {
    if (this.device === null) return;
    this.lostSerial = this.device.serial;
    this.awaitingReconnect = true;
    if (report) this.fail('error.device', error);
    this.detachDevice();
    this.renderPanels();
    void this.recoverDevice();
  }

  private userCanPrompt(): boolean {
    return navigator.userActivation?.isActive === true;
  }

  private async recoverDevice(): Promise<void> {
    if (this.reacquiring || this.device !== null) return;
    this.reacquiring = true;
    try {
      await this.reconnectGranted();
      if (this.device === null && this.userCanPrompt()) await this.connect();
    } finally {
      this.reacquiring = false;
    }
  }

  private usbConnected(usb: USBDevice): void {
    if (this.device !== null || !this.awaitingReconnect || this.reacquiring) return;
    if (!sameUsbDevice(this.lostSerial, usb)) return;
    void this.reconnectGranted();
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

  private async connect(): Promise<AcquireOutcome> {
    try {
      this.statusError = null;
      let epoch = this.deviceEpoch;
      let d: Device;
      try {
        d = await requestDeviceOnBestThread();
      } catch (error) {
        if (cancelledByUser(error)) return 'cancelled';
        if (this.device === null) throw error;
        epoch = this.detachDevice();
        try {
          d = await requestDeviceOnBestThread();
        } catch (retry) {
          if (cancelledByUser(retry)) return 'cancelled';
          throw retry;
        }
      }
      return this.installDevice(d, epoch) ? 'connected' : 'failed';
    } catch (e) {
      this.fail('error.connect', e);
      return 'failed';
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
    if (!this.device) throw new DiagnosticError('device.notConnected');
    if (!this.device.usbControl) throw new DiagnosticError('device.noConsole');
    return this.device.usbControl(command);
  }

  /** Grow the channel model when a wider SLogic board is connected. */
  private adoptDeviceChannels(device: Device): void {
    this.rateCeilings = device.maxSamplerateHz ?? MAX_SAMPLERATE_HZ;
    const max = device.maxChannels ?? this.channels.length;
    if (!isChannelCount(max)) {
      throw new DiagnosticError('device.unknownWidth', { channels: max });
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
      this.waveStore = this.storeRef.target;
    }
    if (this.store.length === 0 && max !== this.channels.length) {
      this.channels = carryChannelState(this.channels, max);
      this.order = restoreOrder(this.order, this.channels.length);
    }
    // A device without the ADC module cannot read a restored analog bank; dropping the
    // view keeps the panel from offering a channel this board has no converter for.
    if (this.deviceAnalogGroups() === 0) {
      this.busViews = this.busViews.filter((bus) => bus.analogGroup === undefined);
    }
    // A board change may clamp the rate; keep a loop window's duration across it.
    const adopted = this.clampSettings({ ...this.settings, channels: width, samplerate });
    this.settings = carryCaptureDuration(this.settings, adopted);
    this.busViews = this.busViews.filter((bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));
    this.reconcileEdgeChannels();
    this.persistWorkspace();
    this.relayout();
  }

  private async startCapture(origin: CaptureStartOrigin = 'manual'): Promise<void> {
    if (this.running || this.stopping || this.repeatTimer.pending) return;
    this.settledHeldCapture = false;
    if (!this.device) {
      // Start with no board opens the chooser: the click is the user gesture WebUSB
      // requires, and cancelling simply leaves the app idle. There is no demo fallback.
      if (origin !== 'manual') return;
      if (await this.connect() !== 'connected' || !this.device) return;
    }
    const device = this.device;
    const generation = ++this.captureGeneration;
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
        throw new DiagnosticError('device.thresholdClips', { volts: cfg.thresholdVolts, code });
      }
      const mode = this.settings.mode;
      const isLoop = mode === 'loop';
      // A Repeat session owns one Capture→Stop period: the first (manual) start renders
      // the panel once, and the interval waves that follow keep the same layout, panel and
      // previous frame until their data arrives. Without this the panel/DOM is rebuilt and
      // the screen flashes at every Capture→Stop wave.
      const quietRepeat = origin === 'repeat' && this.repeatSession && mode === 'repeat' &&
        cfg.channels === this.lastCaptureChannels && cfg.samplerate === this.lastCaptureRate &&
        (cfg.testMode ?? 0) === this.lastCaptureTestMode;
      const newSession = origin !== 'repeat' || this.session === null ||
        this.session.mode !== mode;
      const session = newSession || !this.session ? createSession(mode) : this.session;
      // Every device RUN is one sweep; a Repeat session keeps its policy across them.
      this.session = beginSweep(session);
      this.viewIntent = false;
      if (newSession) this.repeatMissed = false;
      this.lastCaptureChannels = cfg.channels;
      this.lastCaptureRate = cfg.samplerate;
      this.lastCaptureTestMode = cfg.testMode ?? 0;
      this.repeatWaveHolding = quietRepeat;
      const store = createSampleStore(cfg.channels, cfg.samplerate);
      this.waveStore = store;
      this.discardDecodeState();
      this.releaseMarkerPointer();
      this.resetBusBuilds();
      if (!quietRepeat) {
        const model = Math.max(cfg.channels, this.device?.maxChannels ?? this.channels.length);
        this.channels = carryChannelState(this.channels, model);
        this.order = restoreOrder(this.order, this.channels.length);
        this.reconcileEdgeChannels();
        this.persistWorkspace();
      }
      for (const a of this.analyzers) {
        a.result = null; a.index = null; a.status = 'idle'; a.note = { kind: 'pending' };
      }
      this.captureBytes = 0;
      this.lostSamples = 0;
      this.droppedTotal = 0;
      this.captureIsLoop = isLoop;
      this.clearTriggerSample();
      this.captureUsesSoftwareTrigger = false;
      this.captureTriggerBase = null;
      this.triggerRetuneRequested = false;
      this.triggerRetuneRejected = false;
      this.triggerSyncDeferred = false;
      this.captureArming = false;
      const plan = this.triggerPlan(this.settings);
      const analogTriggers = plan.analog.filter((trigger) =>
        trigger.start + CHANNEL_BANK_SIZE <= cfg.channels);
      const softwareTrigger = this.settings.triggerEnableMask &&
        (plan.digital.length > 0 || analogTriggers.length > 0);
      this.captureUsesSoftwareTrigger = softwareTrigger;
      // Loop + trigger freezes the viewport on T. The pre-trigger percentage is then the
      // trigger's horizontal position (0% = the 0 s left edge); single/repeat keep using
      // the ordinary live viewport rules.
      this.triggerViewFraction = captureLocksTriggerView(mode, softwareTrigger)
        ? triggerViewFraction(this.settings.preTriggerPercent) : 0;
      this.captureStart = softwareTrigger ? 0 : performance.now();
      const postTriggerSamples = capturePostTriggerSamples(this.settings);
      this.captureLimitSamples = isLoop ? MAX_SAMPLES - 1 : postTriggerSamples;
      this.startMutatedCapture = true;
      this.triggerState = softwareTrigger ? 'waiting' : 'off';
      // A Repeat wave with a trigger waits for its match; meanwhile the previous completed
      // wave stays on screen with its own T, so the view never falls into a vacuum. A
      // trigger-free wave can show the new layer immediately (the composite fills the
      // part it has not reached from the old one).
      const front = quietRepeat && this.repeatFront &&
        this.repeatFront.store.channelCount === cfg.channels &&
        this.repeatFront.store.samplerate === cfg.samplerate ? this.repeatFront : null;
      this.repeatFront = front;
      this.repeatComposite = null;
      this.repeatShowingFront = false;
      this.repeatHeldTrigger = null;
      this.pendingCursorDelta = null;
      if (front) {
        // The previous wave stays the displayed store until this one can show something:
        // its first sample (trigger-free) or its trigger match. That is what removes the
        // vacuum from a Fixed viewport at the wave boundary.
        this.repeatShowingFront = true;
        this.repeatHeldTrigger = front.hasTrigger ? front.origin : null;
      } else {
        this.releaseMarkerPointer();
        this.storeRef.set(store);
      }
      this.captureLabel = { kind: 'capturing', channels: cfg.channels, rate: cfg.samplerate };
      // A quiet wave does not rebuild the panel or plot, but the status line must stop
      // describing the previous wave's completed capture and show the new interval.
      if (quietRepeat) {
        this.renderStatus();
        if (this.capturePageShown()) {
          this.capturePanel.updateTriggerStatus(this.triggerStatusView());
        }
      }
      this.running = true;
      this.runningPanelAt = 0;
      if (!quietRepeat) this.relayout();
      if (origin !== 'repeat' || newSession) {
        // A new session starts in FollowLive with the default live window. Repeat waves
        // keep the view the session policy resolved last time; the next draw applies it.
        const span = Math.max(1000, Math.round(cfg.samplerate * 0.05));
        this.stack.restoreViewport(0, span);
        this.setFollow(true);
      }

      const bytesPerSample = bytesPerSampleForChannels(cfg.channels);
      this.loopRetentionLen = isLoop
        ? clampLoopSamples(this.settings.loopSamples, cfg.channels)
        : 0;
      // A locked loop analog trigger advances its window on later crossings. Detection
      // runs on the page's raw chunks (strided, so its cost follows the rate, not the
      // data volume); the device matcher still owns the first match and every other
      // trigger mode.
      const analogStart = isLoop && softwareTrigger ? analogTriggers[0] : undefined;
      this.analogScanner = null;
      this.analogCrossings = [];
      this.lastAnalogCrossingAbs = Number.NEGATIVE_INFINITY;
      this.pendingRelockAbs = null;
      this.loopTriggerSlackSamples = 0;
      this.loopPeriodEstimates = [];
      this.loopPeriodSamples = 0;
      this.loopSwapCursorAbs = 0;
      this.loopLastAnchorStep = 0;
      if (analogStart) {
        this.analogScanner = new AnalogCrossingScanner({
          channels: cfg.channels,
          condition: {
            start: analogStart.start,
            kind: analogStart.kind,
            level: analogCodeFromVolts(analogStart.volts),
          },
          // About twenty million byte reads per second at any sample rate.
          stride: Math.max(1, Math.ceil(cfg.samplerate / 20e6)),
        });
        this.loopTriggerSlackSamples = triggerSlackSamples(
          this.loopRetentionLen, cfg.samplerate, bytesPerSample);
      }
      // Rendered after the loop scanner exists so the panel's first frame already carries
      // the display-matcher/block readout (arming included, not only after the trigger).
      if (!quietRepeat) this.renderPanels();
      if (!quietRepeat) this.draw();
      this.el.hint.style.display = 'none';
      const triggerConditions = plan.digital;
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
      // A Repeat sweep's search allowance is one sweep's sample budget: a missing trigger
      // then reports not-found, which B1 turns into a miss + next-Interval retry. Single
      // waits indefinitely for its one trigger and Loop is unbounded.
      const triggerSearchLimit = triggerSearchSamples(mode, this.captureLimitSamples);
      // A live retune may change conditions but not these: the ring was sized here and
      // the emitted-stream budget fixes the store's stop point.
      this.captureTriggerBase = softwareTrigger ? {
        preTriggerSamples,
        maxSamples: isLoop ? Number.POSITIVE_INFINITY : this.captureLimitSamples,
        searchLimitSamples: triggerSearchLimit,
      } : null;
      this.captureArming = true;
      await device.start(cfg, (chunk) => {
        // A late message from a superseded acquisition must never touch the new store.
        if (generation !== this.captureGeneration) return;
        // Chunks arriving while `stopping` are the drained tail of this capture - the
        // reads that had already completed when stop began, plus the flushed coalescing
        // block. Dropping them truncated every manually stopped capture by up to one
        // sink block (~10 ms at 32ch/200M).
        if (!this.running && !this.stopping) return;
        if (chunk.length > 0 && !(this.repeatShowingFront &&
            this.captureUsesSoftwareTrigger && this.triggerState === 'waiting')) {
          // A Repeat wave waiting for its trigger has already received pre-trigger
          // samples; those must not end the old-frame hold. Its trigger does.
          this.repeatWaveHolding = false;
        }
        if (isLoop) {
          // Scan before appending: the chunk's first sample has this absolute position in
          // the emitted stream, the same numbering the trigger index uses.
          // Scan while the trigger owns the view (before placement, and while a lock is
          // active) and after a release: new edges are what take the lock again. A
          // disabled trigger never scans, so a stale condition cannot re-lock the view.
          const phase: TriggerReconcilePhase =
            this.triggerState === 'waiting' ? 'waiting' :
            this.triggerState === 'triggered' ? 'triggered' :
            this.triggerState === 'not-found' ? 'not-found' : 'off';
          const waitingForTrigger = this.captureIsLoop && this.captureUsesSoftwareTrigger &&
            this.triggerState === 'waiting';
          const mayRelock = mayReanchor({
            running: this.running,
            stopping: this.stopping,
            loop: this.captureIsLoop,
            captureArmed: this.captureUsesSoftwareTrigger,
            phase,
            mask: this.settings.triggerEnableMask,
            locked: this.triggerViewLock !== null,
            pending: this.triggerViewPending,
          });
          if (this.analogScanner && chunk.length > 0 && this.settings.triggerEnableMask &&
              (this.triggerViewLock !== null || this.triggerViewPending ||
               waitingForTrigger || mayRelock)) {
            const base = store.length + store.droppedSamples;
            const gap = Math.max(1, Math.floor(this.loopRetentionLen / 64));
            this.analogScanner.scan(chunk, base, (abs) => this.recordAnalogCrossing(abs), gap);
          }
          // A trigger lock that would need more than the store's hard sample budget has
          // already lost the retention race: bounded memory wins over an anchor that can
          // no longer be kept. The guard is before append so the store can never throw.
          const chunkSamples = Math.floor(chunk.length /
            bytesPerSampleForChannels(store.channelCount));
          if (this.captureUsesSoftwareTrigger &&
              store.length + chunkSamples > LOOP_STORE_HARD_SAMPLES) {
            this.disableRunningTrigger(true);
            const drop = loopDropSamples(store.length, this.loopRetentionLen);
            if (drop > 0) this.dropLoopFront(store, drop);
          }
          this.captureBytes += chunk.length;
          store.append(chunk);
          this.enforceLoopRetention(this.storeRef);
          this.livePending = true;
          return;
        }
        const room = (this.captureLimitSamples - store.length) * bytesPerSample;
        if (room <= 0) { void this.stopCapture('completed'); return; }
        // Count what is actually kept: a truncated tail chunk must not inflate the
        // progress readout past the capture.
        this.captureBytes += Math.min(room, chunk.length);
        store.append(room < chunk.length ? chunk.subarray(0, room) : chunk);
        this.livePending = true;
        if (store.length >= this.captureLimitSamples) void this.stopCapture('completed');
      }, (pos, missing) => {
        if (generation !== this.captureGeneration) return;
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
            new DiagnosticError('device.sampleAccounting', {
              counted: pos, stored: store.length + this.droppedTotal,
            }));
        }
        // Waiting for a software trigger, the store holds nothing yet; filler would
        // shift every later sample away from the device timeline. (The transport does
        // not report dropouts yet; when it does, its trigger must also noteGap.) Count
        // the loss for the status only.
        if (softwareTrigger && this.triggerState === 'waiting') {
          this.lostSamples += missing;
          this.livePending = true;
          return;
        }
        const n = appendLostSamples(store, missing, this.captureLimitSamples);
        if (n === 0) return;
        this.lostSamples += n;
        this.livePending = true;
        // A crossing across the gap is unknowable; restart the scan from the next chunk.
        this.analogScanner?.resetContinuity();
        if (isLoop) { this.enforceLoopRetention(this.storeRef); return; }
        if (store.length >= this.captureLimitSamples) void this.stopCapture('completed');
      }, softwareTrigger ? {
        // A loop capture windows the triggered stream downstream of the trigger: the
        // trigger's budget is unbounded (maxSamples Infinity), the store drops the
        // front, and the trigger marker shifts with each drop until it falls off.
        ...(isLoop ? { loop: true } : {}),
        // The transport says when bounded delivery is complete (trigger budget emitted,
        // or finite host budget delivered). This is the stop signal that does not depend
        // on this side's sample arithmetic agreeing with the transport's to the sample.
        onEnd: () => {
          if (generation !== this.captureGeneration) return;
          if (this.running) void this.stopCapture('completed');
        },
        softwareTrigger: {
          channels: cfg.channels,
          conditions: triggerConditions.map((c) => ({
            channel: Math.min(c.channel, cfg.channels - 1), kind: c.kind, level: c.level,
          })),
          ...(triggerConditions[0] ? {
            channel: Math.min(triggerConditions[0].channel, cfg.channels - 1),
            kind: triggerConditions[0].kind,
            level: triggerConditions[0].level,
          } : {}),
          analog: analogTriggers.map((a) => ({
            start: a.start, kind: a.kind, level: analogCodeFromVolts(a.volts),
          })),
          preTriggerSamples,
          maxSamples: isLoop ? Number.POSITIVE_INFINITY : this.captureLimitSamples,
          searchLimitSamples: triggerSearchSamples(mode, this.captureLimitSamples),
        },
        onTriggerState: (state, triggerSampleIndex) => {
          // A superseded acquisition or a disarmed trigger must not pin the view.
          if (generation !== this.captureGeneration) return;
          if (!this.captureUsesSoftwareTrigger || !this.settings.triggerEnableMask) return;
          // A manual stop settles the held previous wave, then the device drain reports
          // its still-waiting matcher as not-found. That is teardown noise, not a result
          // for the captured previous wave; overwriting it would label N samples as
          // "nothing recorded".
          if (state === 'not-found' && this.settledHeldCapture &&
              (this.stopping || !this.running)) return;
          this.triggerState = state;
          if (state === 'triggered' && triggerSampleIndex !== undefined) {
            // The device reports the index in the emitted stream, but the sink may have
            // dropped front samples during the same transfer that produced the match.
            // The plot, the marker and the retention shift all speak store-relative
            // positions, so convert once here.
            const sample = relativeTriggerSample(triggerSampleIndex, store.droppedSamples);
            this.triggerSampleIndex = sample;
            this.captureStart = performance.now();
            if (sample !== null && isLoop && softwareTrigger) {
              this.triggerViewPending = true;
              // Session bookkeeping: a matched Loop owns the view by phase lock. This is
              // the same transition the fixed/follow policy uses; the lock itself is
              // still applied by applyTriggerViewAnchor (Loop is not resolved per draw).
              if (this.session) {
                this.session = sessionAfterTrigger(this.session, this.triggerViewFraction);
              }
            } else if (sample === null && isLoop && softwareTrigger) {
              // The post-match remainder of one transfer was longer than the loop window,
              // so the trigger sample was already evicted. Say so: the plot keeps
              // following and cannot pin a sample it no longer has.
              this.triggerViewLost = true;
            }
            if (this.repeatSession && this.settings.mode === 'repeat') {
              // Repeat: let the per-frame hand-over decide when the new wave has data.
              // The trigger message can precede the block that carries T (coalescing), so
              // `store.length` here is not evidence either way; `releaseRepeatHold` and
              // `updateRepeatDisplay` re-check it on every draw.
              this.repeatWaveHolding = false;
              this.dirty = true;
            }
            // A miss note belongs to the previous Interval; this wave found its trigger.
            if (this.repeatMissed) {
              this.repeatMissed = false;
              this.renderPanels();
            }
          }
          this.dirty = true;
          if (!this.repeatSession) {
            this.relayout();
            this.renderPanels();
          } else if (this.capturePageShown()) {
            // The panel stays put during a Repeat session; only the state notes change.
            this.capturePanel.updateTriggerStatus(this.triggerStatusView());
          }
          // B1: a Repeat wave that finds no trigger is one missed sweep, not the end of
          // the session. Ending it as "completed" lets finishCapture schedule the next
          // Interval while the panel reports the miss. Single keeps its own rule.
          if (state === 'not-found') {
            const repeatMiss = this.repeatSession && this.settings.mode === 'repeat';
            if (repeatMiss) {
              // The note must outlive this quiet wave's stop (which does not rebuild the
              // panel): keep it until a later wave actually triggers.
              this.repeatMissed = true;
              this.renderPanels();
            }
            void this.stopCapture(repeatMiss ? 'completed' : 'manual');
          }
        },
      } : {
        // Timer and non-loop free captures use a host-side sample budget known before
        // RUN. Software-trigger mode cannot use it: where the trigger will land is not
        // known when the device is armed, and a finite budget could end the capture
        // before the trigger arrives. A loop capture is unbounded too - and opts out
        // of the first-byte and underrun watchdogs, ending only on a manual stop or a
        // device error (HSync semantics).
        ...(isLoop ? { loop: true } : { deviceSampleLimit: this.captureLimitSamples }),
        onEnd: () => {
          if (generation !== this.captureGeneration) return;
          if (this.running) void this.stopCapture('completed');
        },
      });
      this.captureArming = false;
      // An edit made while the device was still arming could not reach its matcher.
      // Re-evaluate the current settings and trigger state, not a stored action: the
      // user may have changed it back, and the matcher may have fired meanwhile.
      if (this.triggerSyncDeferred || this.triggerRetuneRequested) {
        this.triggerSyncDeferred = false;
        this.triggerRetuneRequested = false;
        if (this.running && !this.stopping) this.syncActiveTrigger();
      }
      if (!this.running) {
        if (this.stopPending) await this.stopPending;
        else if (this.device === device) await this.teardownDevice(device);
      }
    } catch (e) {
      this.captureArming = false;
      this.captureGeneration++;
      this.triggerSyncDeferred = false;
      // No sink of this failed start survives; do not leave a loop detector behind.
      this.analogScanner = null;
      this.analogCrossings = [];
      this.loopTriggerSlackSamples = 0;
      this.loopPeriodEstimates = [];
      this.loopPeriodSamples = 0;
      this.repeatWaveHolding = false;
      this.session = null;
      this.repeatTimer.cancel();
        const armed = this.startMutatedCapture;
      if (armed && this.device === device) this.deviceLost(e, false);
      this.running = false;
      if (this.startMutatedCapture) {
        this.startMutatedCapture = false;
        this.triggerState = 'off';
        this.clearTriggerSample();
      }
      this.relayout();
      this.fail('error.startCapture', e);
      if (!armed && e instanceof TransportDeadError && this.device === device) {
        this.deviceLost(e, false);
      }
      this.renderPanels();
    }
  }

  /** Lock the view on a crossing seen while no lock was active (re-lock). */
  private lockFromCrossing(rel: number, abs: number): void {
    const D = this.loopRetentionLen;
    if (!(D > 0) || rel < 0) return;
    const fraction = this.triggerViewFraction;
    this.triggerSampleIndex = rel;
    // A re-lock starts from the whole data window, like the initial device match: the
    // view was free-running and its span may not fit the new window. Fit/zoom/pan still
    // never release a held lock.
    this.triggerViewOffsetStart = -fraction * D;
    this.triggerViewOffsetEnd = (1 - fraction) * D;
    this.triggerViewLock = { fraction, resumeFollow: this.stack.followLatest };
    this.triggerAutoDisarmed = false;
    this.lastAnalogCrossingAbs = abs;
    this.pendingRelockAbs = null;
    this.triggerViewPending = false;
    this.triggerViewLost = false;
    this.placeLockViewport();
    this.renderPanels();
    this.dirty = true;
  }

  /** The current data + configuration no longer triggers: release the viewport. */
  private releaseLoopTrigger(): void {
    const lock = this.triggerViewLock;
    if (!lock) return;
    this.triggerViewLock = null;
    this.triggerSampleIndex = null;
    this.triggerViewPending = false;
    this.pendingRelockAbs = null;
    if (this.session?.policy.kind === 'triggerLocked') {
      this.session = { ...this.session, policy: { kind: 'follow' } };
    }
    if (resumeTriggerFollow(lock.resumeFollow, this.running)) this.setFollow(true);
    this.renderPanels();
    this.dirty = true;
  }

  /**
   * Loop retention. With a locked analog trigger the store may carry a bounded excess
   * (the slack) so the front can stay put until a new crossing arrives; each local step
   * moves the window to a real edge's phase, which is what makes a periodic waveform
   * stand still instead of sliding. Without such a lock this is the ordinary drop-to-
   * retention rule.
   */
  private enforceLoopRetention(store: SampleStore): void {
    // A loop software trigger emits its first block *before* the worker posts the
    // 'triggered' message (the sink fills the block first). Dropping to the loop window
    // here would evict the trigger sample, which is why a 1 ms window used to come up
    // free-running even though the matcher had fired. Hold that block (bounded) until
    // the message arrives and the lock is placed.
    const awaitingTrigger = this.running && this.captureIsLoop &&
      this.captureUsesSoftwareTrigger && this.triggerState === 'waiting';
    if (awaitingTrigger || this.triggerViewPending) {
      const bytes = bytesPerSampleForChannels(store.channelCount);
      const pendingLimit = loopPendingLimit(
        this.loopRetentionLen, this.loopTriggerSlackSamples, bytes);
      const drop = loopDropSamples(store.length, pendingLimit);
      if (drop > 0) this.dropLoopFront(store, drop);
      else this.hover = null;
      return;
    }
    // Re-lock on an edge seen while the view was free. The scan happens before the chunk
    // is appended, so wait until the data is actually in the store.
    if (!this.triggerViewLock && !this.triggerViewPending && this.pendingRelockAbs !== null) {
      const rel = this.pendingRelockAbs - store.droppedSamples;
      if (rel >= 0 && rel < store.length) {
        this.lockFromCrossing(rel, this.pendingRelockAbs);
      }
    }
    // One local, phase-aligned step per arrival: choose an edge inside the current
    // window's prefix (bounded by the fresh data) instead of replacing the whole window
    // or jumping to the newest available crossing.
    const lock = this.triggerViewLock;
    if (lock && this.analogScanner) {
      this.rollLoopWindow(store);
      const liveAbs = store.droppedSamples + store.length;
      if (this.triggerViewLock && liveAbs - this.lastAnalogCrossingAbs > this.loopRetentionLen) {
        // A whole Duration without a new edge: the current data + trigger configuration
        // no longer triggers, so the lock has nothing to anchor to.
        this.releaseLoopTrigger();
      }
    }
    // While the lock is being placed (the trigger message may still be ahead of the
    // coalesced block carrying T), keep the same slack: a sink block landing before the
    // next draw must not evict the sample the deferred placement is waiting for.
    const limit = loopStoreLimit(
      this.loopRetentionLen,
      (this.triggerViewLock !== null || this.triggerViewPending) && this.analogScanner !== null,
      this.loopTriggerSlackSamples,
    );
    const drop = loopDropSamples(store.length, limit);
    if (drop <= 0) { this.hover = null; return; }
    // The clamp belongs to the analog roll protocol: the roll advances T by dropping
    // exactly up to the new window start. With no scanner there is no roll, and a device
    // match places T at most f*L into the store, so this clamp would reduce every drop
    // to zero and grow the store without bound. Let the excess go; dropLoopFront
    // translates T and releases the view once T is evicted.
    const lockedView = this.analogScanner !== null ? this.triggerViewLock : null;
    let safeDrop = drop;
    if (lockedView && this.triggerSampleIndex !== null) {
      const windowStart = this.triggerSampleIndex - lockedView.fraction * this.loopRetentionLen;
      const beforeWindow = Math.floor(Math.max(0, windowStart) / DROP_FRONT_QUANTUM) *
        DROP_FRONT_QUANTUM;
      safeDrop = Math.min(drop, beforeWindow);
    }
    if (safeDrop <= 0) { this.hover = null; return; }
    this.dropLoopFront(store, safeDrop);
  }

  /**
   * One local roll of the DurationWindow. The budget is a local block (whole periods,
   * at most a quarter of D, at most the fresh data); the chosen edge is the LATEST one
   * in `(T, T + budget]`, searched back from T + budget. The oldest part of the window
   * is dropped and the same number of new samples fills the tail; the rest of the new
   * data waits for the next roll. V's offsets are untouched.
   */
  private rollLoopWindow(store: SampleStore): void {
    const lock = this.triggerViewLock;
    const T = this.triggerSampleIndex;
    if (!lock || T === null) return;
    const D = this.loopRetentionLen;
    const channels = store.channelCount;
    if (!(D > 0) || !isChannelCount(channels)) return;
    const front = store.droppedSamples;
    const live = front + store.length;
    const triggerAbs = front + T;
    const fraction = lock.fraction;
    const fresh = live - (triggerAbs + (1 - fraction) * D);
    if (!(fresh > 0)) return;
    const plan = planLoopSwap({
      samplerate: store.samplerate,
      channels,
      availableSamples: fresh,
      windowSamples: D,
      // A local update should not repaint the whole window.
      maxWindowFraction: 0.25,
      ...(this.loopPeriodSamples >= 1 ? { periodSamples: this.loopPeriodSamples } : {}),
    });
    let budget = plan.blockSamples;
    // If the store carries more waiting new data than the lock's slack, the step must
    // reach further forward: otherwise the backlog could exceed the retention bound and
    // the only way to shrink the store would be to drop past T. The local block remains
    // the normal target; this catch-up grows only when one arrival is larger than slack.
    budget = Math.max(budget, fresh - this.loopTriggerSlackSamples);
    if (!(budget > 0)) return;
    // A long-period signal still deserves one step: let the budget reach the next real
    // edge, never past the fresh data.
    const next = this.analogCrossings.find((c) => c > triggerAbs);
    if (next !== undefined) budget = Math.max(budget, Math.min(fresh, next - triggerAbs));
    budget = Math.min(budget, fresh);
    const step = planLocalTriggerStep({
      triggerAbs,
      frontAbs: front,
      liveAbs: live,
      windowSamples: D,
      fraction,
      blockSamples: Math.min(budget, fresh),
      crossings: this.analogCrossings,
      viewOffsetStart: this.triggerViewOffsetStart,
      viewOffsetEnd: this.triggerViewOffsetEnd,
    });
    if (!step) return;
    // Keep the old T alive across the drop; the final T is assigned from the step.
    this.triggerSampleIndex = step.anchorAbs - front;
    if (step.drop > 0) this.dropLoopFront(store, step.drop);
    this.triggerSampleIndex = step.triggerSample;
    this.stack.restoreViewport(step.viewStart, step.viewEnd);
    while (this.analogCrossings.length > 0 && this.analogCrossings[0]! <= step.anchorAbs) {
      this.analogCrossings.shift();
    }
    this.loopLastAnchorStep = step.step;
    this.loopSwapCursorAbs = step.anchorAbs;
    this.triggerViewPending = false;
    this.triggerViewLost = false;
    this.dirty = true;
  }

  /** Translate the store and every store-relative cursor by `drop`. */
  private dropLoopFront(store: SampleStore, drop: number): void {
    if (drop <= 0) return;
    store.dropFront(drop);
    this.droppedTotal += drop;
    // Bus builders need no reset: their frontier is absolute (BusBuilder skips ahead past
    // the drop), and analogFrame's cache key carries store.droppedSamples, so a stale
    // frame can never alias a new generation at the same length.
    const lock = this.triggerViewLock;
    const hadTrigger = this.triggerSampleIndex !== null;
    if (hadTrigger) {
      // T is a sample cursor in the DurationWindow. It translates with the front drop;
      // the ViewWindow (stored as offsets from T) rides along, so the trigger phase and
      // the user's window keep their pixels.
      const next = this.triggerSampleIndex! - drop;
      this.triggerSampleIndex = next >= 0 && next < store.length ? next : null;
    }
    if (this.triggerSampleIndex === null) {
      // The trigger message can precede the coalesced block that carries T (see
      // applyTriggerViewAnchor). If that block is then evicted before the deferred lock
      // is placed, the view never locked at all: report it rather than clearing the
      // pending flag silently. A lock that already existed takes the release path below.
      if (hadTrigger && this.triggerViewPending && this.triggerViewLock === null) {
        if (!this.triggerViewLost) {
          this.triggerViewLost = true;
          // The data path does not redraw the panel; publish the state change now
          // without a full rebuild (the cursor branch below may do one anyway).
          if (this.capturePageShown()) {
            this.capturePanel.updateTriggerStatus(this.triggerStatusView());
          }
        }
      }
      this.triggerViewPending = false;
      if (hadTrigger) this.pendingRelockAbs = null;
    }
    while (this.analogCrossings.length > 0 && this.analogCrossings[0]! < this.droppedTotal) {
      this.analogCrossings.shift();
    }
    if (lock && hadTrigger) {
      // The ViewWindow's absolute samples do not change when the front drops: shifting
      // by the same amount keeps T's pixel and the user's window exactly where they were.
      const view = this.stack.view;
      this.stack.restoreViewport(view.start - drop, view.end - drop);
      if (this.triggerSampleIndex === null) {
        // T left the retained data: there is no edge left to anchor to.
        this.triggerViewLock = null;
        this.pendingRelockAbs = null;
        if (this.session?.policy.kind === 'triggerLocked') {
          this.session = { ...this.session, policy: { kind: 'follow' } };
        }
        if (resumeTriggerFollow(lock.resumeFollow, this.running)) this.setFollow(true);
        // The one-shot digital lock is now spent; refresh the released status and the
        // notes without waiting for an unrelated full render.
        if (this.capturePageShown()) {
          this.capturePanel.updateTriggerStatus(this.triggerStatusView());
        }
      }
    }
    let shifted = false;
    for (const cursor of this.cursors) {
      const sample = cursor.marker.sample;
      if (sample === null || cursor.marker.isDragging) continue;
      cursor.marker.setSample(sample - drop >= 0 ? sample - drop : null, store.length);
      if (cursor.marker.sample !== sample) shifted = true;
    }
    const beforeDrop = this.cursors.length;
    this.cursors = this.cursors.filter((cursor) => cursor.marker.sample !== null);
    if (this.cursors.length !== beforeDrop) {
      if (this.activeCursorId !== null && this.cursorById(this.activeCursorId) === null) {
        const last = this.cursors[this.cursors.length - 1];
        this.activeCursorId = last === undefined ? null : last.id;
      }
      this.renumberCursors();
      this.distanceRows = pruneDistancePairs(
        this.distanceRows, new Set(this.cursors.map((cursor) => cursor.id)),
      );
      this.edgeRows = pruneEdgeCursors(
        this.edgeRows, new Set(this.cursors.map((cursor) => cursor.id)),
      );
      this.renderPanels();
    } else if (shifted && this.cursorsPageShown()) {
      this.capturePanel.updateCursors(this.cursorRows());
      this.capturePanel.updateCursorDistances(this.cursorDistanceRows());
      this.capturePanel.updateCursorEdges(this.cursorEdgeRows());
    }
    this.hover = null;
  }

  /**
   * Remember one scanned crossing for the display anchor. The scanner already spaces
   * reports by the loop window's 1/64 (a real crossing each), so sixty-four entries cover
   * one window and a periodic signal's phase is unaffected by which one is chosen.
   */
  private recordAnalogCrossing(abs: number): void {
    // Adjacent reported crossings are separated by the scan's minimum gap, which is a
    // whole number of signal periods (a subset of the real crossings). Their median is
    // therefore a phase-aligned block size, not necessarily the signal period itself.
    const last = this.analogCrossings[this.analogCrossings.length - 1];
    if (last !== undefined && abs > last) {
      // Keep the window chronological; the median uses a reused scratch array so the
      // ingest path does not allocate per crossing.
      this.loopPeriodEstimates.push(abs - last);
      if (this.loopPeriodEstimates.length > 8) this.loopPeriodEstimates.shift();
      this.loopPeriodSamples = medianOfRecent(
        this.loopPeriodEstimates, this.loopPeriodScratch);
    }
    this.analogCrossings.push(abs);
    if (this.analogCrossings.length > 128) this.analogCrossings.shift();
    this.lastAnalogCrossingAbs = abs;
    // The current data still produces edges. If the view was released (no edge for a
    // whole window, or a configuration change that stopped triggering), a later edge
    // re-locks automatically; the lock is a data/configuration state, not a user action.
    // A disabled trigger is the exception: it must never re-lock on a stale condition.
    const phase: TriggerReconcilePhase =
      this.triggerState === 'waiting' ? 'waiting' :
      this.triggerState === 'triggered' ? 'triggered' :
      this.triggerState === 'not-found' ? 'not-found' : 'off';
    if (mayReanchor({
      running: this.running,
      stopping: this.stopping,
      loop: this.captureIsLoop,
      captureArmed: this.captureUsesSoftwareTrigger,
      phase,
      mask: this.settings.triggerEnableMask,
      locked: this.triggerViewLock !== null,
      pending: this.triggerViewPending,
    })) {
      this.pendingRelockAbs = abs;
    }
  }

  private async stopCapture(reason: CaptureStopReason = 'manual'): Promise<void> {
    if (!this.running && !this.stopping && this.repeatTimer.pending) {
      this.repeatTimer.cancel();
      // A miss leaves the previous wave held while the retry timer runs; stopping here
      // must adopt it just like stopping a running wave, or the plot would keep showing
      // a wave that the capture no longer represents (and Save would refuse it).
      this.settleAndLabelHeldWave();
      this.session = null;
      this.repeatWaveHolding = false;
      this.repeatMissed = false;
      this.clearRepeatLayers();
      this.setFollow(false);
      this.relayout();
      this.renderPanels();
      this.renderStatus();
      return;
    }
    if (!this.running || this.stopping) return;
    // A Repeat session's interval waves stop and restart internally; the visible session
    // stays "Capturing" with the Stop button. Only a user/manual stop changes the panel.
    const quietRepeatWave = this.repeatSession && this.settings.mode === 'repeat' &&
      reason === 'completed';
    if (reason === 'manual') {
      this.repeatTimer.cancel();
      this.session = null;
      this.repeatWaveHolding = false;
      this.repeatMissed = false;
      this.settleHeldRepeatWave();
      this.clearRepeatLayers();
      this.triggerSyncDeferred = false;
      this.triggerAutoDisarmed = false;
      this.setFollow(false);
    }
    this.running = false;
    this.stopping = true;
    if (!quietRepeatWave) this.renderPanels();
    const pending = this.teardownDevice(this.device);
    this.stopPending = pending;
    try {
      await pending;
    } finally {
      this.stopping = false;
      this.stopPending = null;
    }
    this.finishCapture(reason);
  }

  private async teardownDevice(device: Device | null): Promise<void> {
    try {
      await device?.stop();
    } catch (e) {
      if (stopFailureIsSilent(e)) {
        console.warn('[ui] the capture stop closed the transport; reconnecting:', e);
      } else {
        this.fail('error.stopCapture', e);
      }
      if (this.device === device) {
        this.lostSerial = device?.serial ?? '';
        this.awaitingReconnect = true;
        this.discardDevice();
        void this.recoverDevice();
      }
    }
  }

  private finishCapture(reason: CaptureStopReason = 'manual'): void {
    // No more data will be scanned; the locked frame itself stays on screen.
    this.analogScanner = null;
    this.analogCrossings = [];
    this.lastAnalogCrossingAbs = Number.NEGATIVE_INFINITY;
    this.pendingRelockAbs = null;
    this.loopTriggerSlackSamples = 0;
    this.triggerRetuneRejected = false;
    this.triggerAutoDisarmed = false;
    // A pending width/board change becomes effective now: drop out-of-width buses and
    // their trigger settings, and clamp the capture settings to the new width.
    this.busViews = this.busViews.filter(
      (bus) => !busOutOfWidth(bus.spec, this.displayChannelCount()));
    this.settings = this.clampSettings({ ...this.settings });
    const stickyWave = this.repeatSession && this.settings.mode === 'repeat' &&
      reason === 'completed' && this.device !== null;
    // Direct end paths (transport loss) do not pass through stopCapture; settle the held
    // previous wave before the labels and capture store are read.
    if (!stickyWave) this.settleHeldRepeatWave();
    if (!stickyWave) this.persistWorkspace();
    const captured = this.captureStore;
    const sr = captured.samplerate;
    this.captureLabel = this.triggerState === 'not-found'
      ? { kind: 'stoppedNoTrigger', samples: captured.length }
      : { kind: 'live', samples: captured.length, rate: sr, seconds: captured.length / sr };
    if (this.repeatSession && reason === 'completed' &&
        this.settings.mode === 'repeat' && this.device !== null) {
      this.repeatTimer.schedule(this.settings.repeatIntervalSeconds, () => { void this.startCapture('repeat'); });
    }
    if (stickyWave) {
      // The session stays in its Capturing state; only the waveform data changes.
      if (captured.length > 0 && this.triggerState !== 'not-found') {
        // This wave becomes the old layer for the next one. Displaying it alone is right
        // now: the view policy was resolved against this wave's retained range, so no
        // surviving Fixed viewport needs the previous layer.
        if (this.repeatShowingFront && this.repeatFront &&
            this.cursors.some((cursor) =>
              cursor.marker.sample !== null && !cursor.marker.isDragging)) {
          // A wave can complete before the next draw released the held front; remap the
          // cursors into this wave's coordinates as the hand-over would have.
          this.pendingCursorDelta = (this.triggerSampleIndex ?? 0) - this.repeatFront.origin;
        }
        this.repeatFront = {
          store: captured,
          origin: this.triggerSampleIndex ?? 0,
          hasTrigger: this.triggerSampleIndex !== null,
        };
        this.repeatComposite = null;
        this.repeatShowingFront = false;
        this.repeatHeldTrigger = null;
        this.setDisplayStore(captured);
        this.applyPendingCursorDelta();
        // The composite can be longer than this wave (a shorter budget was selected
        // while it ran), so old-layer-only positions must not survive the swap.
        this.settleCursorsForStore(captured.length);
      }
      // A missed trigger keeps the previous wave (and its T) on screen; the panel
      // reports the miss and the next Interval retries.
      this.repeatWaveHolding = false;
      this.dirty = true;
      if (this.capturePageShown()) {
        // The wave stopped naturally; the text-only state note must not keep saying it
        // is still recording while the Interval runs.
        this.capturePanel.updateTriggerStatus(this.triggerStatusView());
      }
    } else {
      this.session = null;
      this.repeatWaveHolding = false;
      this.repeatMissed = false;
      this.clearRepeatLayers();
      this.relayout();
      this.renderPanels();
      this.dirty = true;
    }
    const waiters = this.captureWaiters;
    this.captureWaiters = [];
    for (const w of waiters) w();
  }

  // ------------------------------------------------------------------ analyzers

  private discardDecodeState(): void {
    this.abort?.abort();
    this.abort = null;
    this.decodeBusy = false;
  }

  private async attachAnalyzer(
    decoderId: string, channels: Record<number, number>, options: Record<string, string | number>,
  ): Promise<void> {
    await hydrateDecoders();
    const info = getDecoder(decoderId);
    const laneChannel = analyzerLaneChannel(channels);
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
    this.persistWorkspace();
    this.renderPanels();
    await this.runDecode(a.id);
  }

  private removeAnalyzer(id: string): void {
    this.analyzers = this.analyzers.filter((a) => a.id !== id);
    this.persistWorkspace();
    this.relayout();
    this.renderPanels();
  }

  private async runDecode(id: string): Promise<void> {
    const a = this.analyzers.find((x) => x.id === id);
    if (!a) return;
    const store = this.captureStore as CountingStore;
    const controller = new AbortController();
    const stale = (): boolean => this.captureStore !== store || !this.analyzers.includes(a);
    try {
      this.statusError = null;
      const { used, outside } = mappedCaptureChannels(a.channels, store.channelCount);
      if (outside !== null) {
        throw new DiagnosticError('decode.channelOutOfRange', {
          channel: outside, channels: store.channelCount,
        });
      }
      if (store.length === 0) throw new DiagnosticError('decode.noCapture');
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
        throw new DiagnosticError(
          this.captureIsLoop ? 'decode.tooLongLoop' : 'decode.tooLong',
          {
            samples: formatCount(store.length),
            max: formatCount(MAX_SAMPLE),
            window: formatDuration(MAX_SAMPLE / 200e6),
          });
      }
      let edgeTotal = 0;
      for (const c of used) {
        edgeTotal += store.edgeCount
          ? store.edgeCount(c, 0, store.length)
          : store.edges(c, 0, store.length).length;
      }
      // [src/decode/limits.ts] past ~80 M edges Pyodide corrupts rather than failing, so
      // the budget stops at 48 M where refusing is still possible.
      if (edgeTotal > EDGE_BUDGET) {
        throw new DiagnosticError(
          this.captureIsLoop ? 'decode.edgeBudgetLoop' : 'decode.edgeBudget',
          { edges: formatCount(edgeTotal), budget: formatCount(EDGE_BUDGET) });
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
      const diag = diagnosticOf(e);
      a.note = e instanceof DecodeTimeoutError ? { kind: 'timeout' as const }
        : e instanceof DecodeCancelledError ? { kind: 'cancelled' as const }
          : {
            kind: 'error' as const,
            detail: diag?.payload ?? (e instanceof Error ? e.message : String(e)),
            ...(diag ? { diag } : {}),
          };
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
    const want = new Set(list.filter((i) => i >= 0 && i < this.renderChannelCount()));
    if (want.size === 0) return;   // never zero rows
    const locked = lockedChannelBanks(this.busViews, this.renderChannelCount());
    for (const c of this.channels) {
      if (c.index >= this.renderChannelCount()) continue;
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
        repeatPending: this.repeatTimer.pending,
        error: this.statusError ? formatStatusError(this.statusError) : '',
        label: formatCaptureLabel(this.captureLabel),
        samples: this.running && this.captureIsLoop
          ? this.captureStore.length + this.droppedTotal : this.captureStore.length,
        dropped: this.droppedTotal,
        samplerate: this.captureStore.samplerate,
        channelCount: this.captureStore.channelCount,
        triggerState: this.triggerState,
        triggerSampleIndex: this.triggerSampleIndex,
        settings: this.settings,
        rateCeilings: this.rateCeilings,
        widthTiers: this.widthTiers(),
        enabledChannels: this.enabledChannels().map((c) => c.index),
        channelNames: this.channels.map((c) => c.name),
        view: { start: this.stack.view.start, end: this.stack.view.end },
        decoderReady: this.decodeWarm,
      }),
      store: () => this.captureStore,
      analyzers: () => this.analyzers.map((a) => ({
        decoderId: a.decoderId,
        channels: a.channels,
        options: a.options,
        status: a.status,
        note: formatAnalyzerNote(a.note),
        result: a.result,
      })),
      setChannelWidth: (channels) => this.setChannelWidth(channels),
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
      stop: () => { this.cancelPendingTriggerRestart(); return this.stopCapture(); },
      attach: (id, channels, options) => this.attachAnalyzer(id, channels, options),
      removeAnalyzer: (index) => {
        const a = this.analyzers[index];
        if (!a) return false;
        this.removeAnalyzer(a.id);
        return true;
      },
      setViewportSeconds: (a, b) => this.debug.setViewportSeconds(a, b),
      zoomToAnnotation: (analyzer, n) => this.debug.zoomToAnnotation(analyzer, n),
      levelAt: (channel, sample) => levelAt(this.captureStore, channel, sample),
      // The same paths the bus panel uses.
      buses: () => this.busViews.map((b) => ({ config: b, built: b.builder?.done ?? false })),
      addBus: (cfg) => {
        if (this.addBus(cfg) === null) throw new DiagnosticError('ui.captureLocked');
      },
      updateBus: (index, cfg) => {
        const b = this.busViews[index];
        if (b && !this.updateBus(b.id, cfg)) throw new DiagnosticError('ui.captureLocked');
      },
      removeBus: (index) => {
        const b = this.busViews[index];
        if (b && !this.removeBus(b.id)) throw new DiagnosticError('ui.captureLocked');
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
    stop: () => { this.cancelPendingTriggerRestart(); return this.stopCapture(); },
    attach: (id: string, ch: Record<number, number>, opts: Record<string, string | number> = {}) =>
      this.attachAnalyzer(id, ch, opts),
    setSettings: (s: Partial<CaptureSettings>) => {
      this.applySettings({ ...this.settings, ...s });
    },
    /** Add a parallel-bus view; missing fields take the panel's defaults. */
    addBus: (cfg: Partial<BusViewConfig> & { spec: BusViewConfig['spec'] }) =>
      this.addBus({ ...defaultBusConfig(this.displayChannelCount(), this.settings.testMode), ...cfg }),
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
      this.noteExplicitViewport();
      this.dirty = true;
    },
    setMarker: (sample: number | null) => {
      this.releaseMarkerPointer();
      this.clearCursors();
      if (sample === null) this.renderPanels();
      else this.addCursor(sample);
      this.dirty = true;
    },
    marker: () => {
      const cursor = this.activeCursor();
      return {
        id: cursor?.id ?? null,
        label: cursor?.marker.label ?? null,
        color: cursor?.marker.color ?? null,
        sample: cursor?.marker.sample ?? null,
        dragging: cursor?.marker.isDragging ?? false,
        started: cursor?.marker.started ?? false,
        pointerId: cursor?.marker.pointerId ?? null,
        channel: cursor?.marker.channel ?? null,
        cursor: this.markerCursor,
      };
    },
    cursors: () => this.cursors.map((cursor) => ({
      id: cursor.id,
      label: cursor.marker.label,
      color: cursor.marker.color,
      sample: cursor.marker.sample,
      active: cursor.id === this.activeCursorId,
    })),
    addCursor: (sample: number) => this.addCursor(sample),
    removeCursor: (id: number) => this.removeCursor(id),
    cursorChips: (): Array<PlacedCursorChip & { width: number }> => {
      const ctx = this.el.axis.getContext('2d');
      if (!ctx) return [];
      ctx.font = AXIS.markerChip.font;
      const measure = (label: string): number =>
        ctx.measureText(label).width + 2 * AXIS.markerChip.padX;
      return this.cursorChipPlacements(measure, this.el.plot.clientWidth)
        .map((chip) => ({ ...chip, width: measure(chip.label) }));
    },
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
          name, mode: this.settings.triggerModes[i] ?? DEFAULT_TRIGGER_MODE,
          color: current.color,
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
      const store = this.captureStore;
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
      this.noteExplicitViewport();
      this.dirty = true;
      return true;
    },
    snapshot: () => ({
      label: formatCaptureLabel(this.captureLabel),
      theme: getTheme(),
      error: this.statusError ? formatStatusErrorDebug(this.statusError) : '',
      running: this.running,
      stopping: this.stopping,
      device: this.device?.name ?? null,
      transport: this.device instanceof WorkerSlogicDevice ? 'worker' : 'page',
      transportFallback: workerTransport.lastFallbackReason,
      warm: this.decodeWarm,
      samples: this.running && this.captureIsLoop
        ? this.captureStore.length + this.droppedTotal : this.captureStore.length,
      dropped: this.droppedTotal,
      samplerate: this.captureStore.samplerate,
      channels: this.captureStore.channelCount,
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
 * Every MAX_SAMPLERATE_HZ value is itself in SAMPLERATES_HZ, so the clamp always lands on
 * a rate the device supports. With an analog bank active the ADC module additionally
 * needs a sample clock divided from its 800 MHz PLL (HSync adc.rs), so the rate moves to
 * the fastest allowed rate at or below the requested one - the same choice HSync's
 * `reconcile_channels` makes.
 */
function clampCaptureSettings(
  s: CaptureSettings, ceilings: Readonly<Record<number, number>> = MAX_SAMPLERATE_HZ,
  analog = false, triggerChannels: number = s.channels,
): CaptureSettings {
  const ceiling = ceilings[s.channels] ?? 200e6;
  let samplerate = Math.min(s.samplerate, ceiling);
  if (analog) {
    const allowed = analogSamplerates(SAMPLERATES_HZ.filter((rate) => rate <= ceiling));
    if (allowed.length > 0 && !allowed.includes(samplerate)) {
      const below = allowed.filter((rate) => rate <= samplerate);
      samplerate = below[below.length - 1] ?? allowed[0]!;
    }
  }
  const savedModes = s.triggerModes ?? {};
  const configuredConditions = Object.keys(savedModes).length ? modesToConditions(savedModes)
    : s.triggerConditions.length ? s.triggerConditions : s.softwareTrigger
      ? [{ channel: s.triggerChannel, kind: s.triggerKind, level: s.triggerLevel }]
      : [];
  const triggerConditions = configuredConditions
    .filter((c) => c.channel >= 0 && c.channel < triggerChannels)
    .map((c) => ({ ...c }));
  const triggerModes: Record<number, TriggerMode> = { ...savedModes };
  for (const c of triggerConditions) {
    triggerModes[c.channel] = triggerModeFromCondition(c);
  }
  const loopSamples = clampLoopSamples(s.loopSamples ?? DEFAULT_LOOP_SAMPLES, s.channels);
  const analogTriggers: Record<number, AnalogTriggerSetting> = {};
  for (const [key, value] of Object.entries(s.analogTriggers ?? {})) {
    const start = Number(key);
    if (!Number.isInteger(start) || start % CHANNEL_BANK_SIZE !== 0 ||
        start + CHANNEL_BANK_SIZE > triggerChannels) continue;
    if (value.kind !== 'rising' && value.kind !== 'falling') continue;
    const volts = Number(value.volts);
    if (!Number.isFinite(volts)) continue;
    analogTriggers[start] = {
      kind: value.kind,
      volts: analogTriggerVolts(value.kind,
        Math.max(ADC_OFFSET_V, Math.min(ADC_OFFSET_V + ADC_FULL_SCALE_V, volts))),
    };
  }
  return {
    ...s, samplerate,
    // One duration concept: in Loop mode it is the window's duration, so switching modes
    // or changing the rate carries the same value (see carryCaptureDuration). The loop
    // window may be shorter than Single's 1 ms minimum, so it is not clamped here.
    seconds: s.mode === 'loop'
      ? loopSamples / samplerate
      : clampCaptureSeconds(s.seconds, samplerate),
    singleUnlimited: s.mode === 'single' && s.singleUnlimited === true,
    repeatIntervalSeconds: clampRepeatIntervalSeconds(s.repeatIntervalSeconds),
    loopSamples,
    triggerEnableMask: s.triggerEnableMask ?? true,
    // Enable Mask is the sole global gate. Turning it off must not erase the
    // per-channel modes; turning it back on must restore the same conditions.
    softwareTrigger: s.triggerEnableMask !== false && (
      s.triggerSource === 'analog'
        ? Object.keys(analogTriggers).length > 0
        : triggerConditions.length > 0),
    analogTriggers,
    triggerModes,
    triggerChannel: Math.max(0, Math.min(s.triggerChannel, triggerChannels - 1)),
    triggerConditions,
    preTriggerPercent: Math.max(0, Math.min(75, s.preTriggerPercent)),
  };
}

/** Configuration edits describe a future capture; they must not leave the previous
 * capture's T origin and relative axis attached to a newly selected trigger. */
function triggerSettingsChanged(a: CaptureSettings, b: CaptureSettings): boolean {
  if (a.triggerSource !== b.triggerSource ||
      a.softwareTrigger !== b.softwareTrigger || a.triggerEnableMask !== b.triggerEnableMask ||
      a.triggerChannel !== b.triggerChannel || a.triggerKind !== b.triggerKind ||
      a.triggerLevel !== b.triggerLevel || a.preTriggerPercent !== b.preTriggerPercent ||
      a.triggerConditions.length !== b.triggerConditions.length) return true;
  const am = a.triggerModes ?? {};
  const bm = b.triggerModes ?? {};
  const modeKeys = new Set([...Object.keys(am), ...Object.keys(bm)]);
  for (const key of modeKeys) if (am[Number(key)] !== bm[Number(key)]) return true;
  const aa = a.analogTriggers ?? {};
  const ba = b.analogTriggers ?? {};
  const analogKeys = new Set([...Object.keys(aa), ...Object.keys(ba)]);
  for (const key of analogKeys) {
    const x = aa[Number(key)];
    const y = ba[Number(key)];
    if (!x || !y || x.kind !== y.kind || x.volts !== y.volts) return true;
  }
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
