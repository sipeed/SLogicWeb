// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * The capture panel - the right-hand device panel, modelled on
 * a conventional capture-settings panel.
 *
 * Layout: a device header with the product name, a "Digital" section with a channel-width
 * selector and rows of eight channel chips filled with the channel colour when enabled,
 * each row followed by its Analog button (at the right end, so a 4 CH row lines up with
 * the rest), a sample-rate dropdown and a voltage dropdown side by side, then a segmented
 * capture-mode control.
 *
 * Two things it has to show that a native tool would not: the WebUSB permission state, and the
 * **sample ceiling**. `src/data`'s `append` throws past 2^31 samples, which at this
 * device's 200 MSa/s is 10.7 seconds, so the panel prints the maximum duration for the
 * selected rate and a free-running capture stops itself there instead of dying mid-stream.
 */

import { SAMPLERATES_HZ, vrefCode, vrefVolts } from '../device/index.js';
import { MAX_SOFTWARE_TRIGGER_PREFIX_BYTES } from '../data/index.js';
import { bytesPerSampleForChannels } from '../types.js';
import {
  formatBytes, formatCount, formatDuration, formatFreq, formatRate, formatStatusDetail, statusDetailOf,
} from './format.js';
import {
  ADC_RESOLUTION_BITS, ANALOG_GAIN_DEFAULT, ANALOG_GAIN_MAX, ANALOG_GAIN_MIN, ANALOG_GAIN_PRESETS,
  CHANNEL_BANK_SIZE, analogGainOf, analogHalfRangeV, analogSamplerates, analogTriggerVolts,
  analogVoltsPerCode, channelBankIndices, channelBankRange, channelBankStarts, formatAnalogGain,
  isAnalogGain, lockedChannelBanks,
} from './channelBanks.js';
import {
  chipLabel, chipRowFit, widestChipBox,
} from './channelChipLayout.js';
import {
  parseCustomThreshold, thresholdChoice, thresholdOptionLabel, thresholdRange,
} from './thresholdOptions.js';
import { t } from './i18n.js';
import { helpTip } from './helpTip.js';
import { chipForeground } from './metrics.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import type { BusViewState } from './busView.js';
import type { CaptureSettings, ChannelState } from './state.js';
import {
  clampLoopSamples, defaultChannelName, LOOP_WINDOW_QUANTUM, maxLoopSamples,
  THRESHOLD_VOLT_OPTIONS,
} from './state.js';
import {
  maxCaptureSeconds, MIN_CAPTURE_SECONDS, REPEAT_INTERVAL_SECONDS,
} from './captureTime.js';
import { captureAbortDetail, type CaptureAbortCause } from './captureAbort.js';
import { capturePostTriggerSamples } from './capturePolicy.js';
import { MAX_CURSOR_DISTANCE_ROWS, type DistanceSide } from './cursorDistance.js';
import { MAX_CURSOR_EDGE_ROWS } from './cursorEdges.js';
import { cursorsLocked } from './cursorSet.js';
import { acquisitionTimeControl } from './timeControl.js';
import {
  triggerPanelNotes, triggerStatusNote, type PreTriggerFill, type TriggerNoteState,
} from './triggerStatus.js';
import { rateAdvice } from './rateAdvice.js';
import type { CaptureMemoryReadout } from './capturePolicy.js';
import { rateChangeMessageKey, type RateChangeNote } from './analogRateMemory.js';

export interface CapturePanelCallbacks {
  onSettings(next: CaptureSettings): void;
  onToggleChannel(index: number, enabled: boolean): void;
  /** Turn the bank's ADC-analog reading on or off; the button is its only control. */
  onToggleAnalog(start: number): void;
  /**
   * Declare the gain ratio set on the ADC module for the group at `start`. Conversion
   * only: the device is not told and a running capture continues.
   */
  onAnalogGain(start: number, gain: number): void;
  onChannelWidth(channels: number): void;
  onUsbControl(command: string): Promise<string>;
  /** The Advanced section opened or closed; the App owns the poll timer. */
  onTemperatureOpen(open: boolean): void;
  /** The user picked 1 Hz (1000) or 10 Hz (100). */
  onTemperatureRate(ms: number): void;
  onRemoveCursor(id: number): void;
  onFocusCursor(id: number): void;
  onAddCursorDistance(): void;
  onRemoveCursorDistance(rowId: number): void;
  onPickCursorDistance(rowId: number, side: DistanceSide, cursorId: number): void;
  onAddCursorEdge(): void;
  onRemoveCursorEdge(rowId: number): void;
  onPickCursorEdge(rowId: number, side: DistanceSide, cursorId: number): void;
  onPickCursorEdgeChannel(rowId: number, channel: number | null): void;
}

/** `aborted`: the last capture was ended by a device/link failure (`CapturePanelView.abort`). */
export type CapturePanelState =
  'ready' | 'capturing' | 'stopping' | 'waiting' | 'completed' | 'aborted';

export interface CursorRowView {
  id: number;
  label: string;
  color: string;
  seconds: number;
  sample: number;
  time: string;
}

export interface CursorDistanceSideView {
  id: number;
  label: string;
  color: string;
}

export interface CursorDistanceRowView {
  id: number;
  row: number;
  a: CursorDistanceSideView | null;
  b: CursorDistanceSideView | null;
  delta: string;
}

export interface CursorEdgeRowView {
  id: number;
  row: number;
  a: CursorDistanceSideView | null;
  b: CursorDistanceSideView | null;
  channel: number | null;
  result: string;
}

export interface CursorEdgeChannelView {
  index: number;
  name: string;
}

export interface CapturePanelHost {
  capture: HTMLElement;
  cursors: HTMLElement;
}

export interface CapturePanelView {
  settings: CaptureSettings;
  channels: readonly ChannelState[];
  widthOptions: readonly number[];
  buses: readonly BusViewState[];
  /**
   * The last gain change moved a group's stored trigger level to the new range's edge
   * (the stored volts no longer fit); shown once under the gain rows.
   */
  analogLevelClamped?: { start: number; from: number; to: number } | null;
  /** Analog groups (A0–A3) the current device and width expose; 0 disables the buttons. */
  analogGroups: number;
  deviceName: string | null;
  /** The App-owned temperature poll's last text; '—' before the first read. */
  temperature?: string;
  /** App-owned poll period, 1000 or 100 ms. */
  tempRateMs?: number;
  /** Settings > Developer tools: shows the raw USB register console. Absent = off. */
  developerTools?: boolean;
  running: boolean;
  stopping: boolean;
  repeatPending: boolean;
  captureState: CapturePanelState;
  result: { samples: number; seconds: number } | null;
  /** Why the last capture ended early; set exactly when `captureState` is 'aborted'. */
  abort?: { cause: CaptureAbortCause; requestedSeconds: number | null } | null;
  /** Non-null while a capture is streaming. */
  progress: { seconds: number; samples: number; bytes: number; lost: number; dropped: number;
    /** Retained length (`store.length`) and the loop limit; the limit is 0 outside loop mode. */
    kept: number; limit: number;
    /** The running capture's rate; the loop line reads kept/limit/dropped as durations. */
    samplerateHz: number;
    /** Finite sample target; null for Loop captures. */
    targetSamples: number | null;
    /**
     * The memory ceiling and the time left at the capture's rate, for a finite request
     * the ceiling cuts; null (or absent) otherwise.
     */
    memory?: CaptureMemoryReadout | null } | null;
  /**
   * The last rate change the app made on the user's behalf (an analog group needs the
   * ADC clock, or turning the last group off restored the earlier rate); null once the
   * user picks a rate.
   */
  rateChange?: RateChangeNote | null;
  /** A streamed save's progress, 0..100; null when no big save is running. */
  savePercent?: number | null;
  maxSamplerateHz: Readonly<Record<number, number>>;
  /** Per-width rate the board sustains below that ceiling (`Device.recommendedSamplerateHz`). */
  recommendedSamplerateHz?: Readonly<Record<number, number>>;
  triggerState: TriggerNoteState;
  cursors: readonly CursorRowView[];
  cursorDistances: readonly CursorDistanceRowView[];
  cursorEdges: readonly CursorEdgeRowView[];
  cursorEdgeChannels: readonly CursorEdgeChannelView[];
  /** A loop trigger matches, but its sample was evicted before the page could lock on it. */
  triggerViewLost: boolean;
  /** The match message is waiting for the block that carries T; not a release. */
  triggerViewPending: boolean;
  /** A loop trigger currently owns the viewport (released when the data stops triggering). */
  triggerLocked: boolean;
  /** The running acquisition actually armed a software trigger. */
  triggerArmed: boolean;
  /** The trigger was released by the Loop store's hard memory cap. */
  triggerAutoDisarmed: boolean;
  /** The live settings request a trigger with at least one effective condition. */
  settingsArmed: boolean;
  /** A live analog edit cannot arm at the active capture's board/rate. */
  triggerRetuneRejected: boolean;
  /** The loop lock is rolling on scanned analog crossings (not the one-shot digital lock). */
  triggerAnalogRolling: boolean;
  /** Samples of pre-trigger history the running matcher actually retained. */
  activeTriggerPreSamples: number | undefined;
  /** Seconds of pre-trigger a triggered capture holds when that is less than configured
   * (see `preTriggerShortfall`); null when the full window was obtained. */
  triggerPreObtainedSec?: number | null;
  /** The armed matcher is still filling its pre-trigger window and cannot fire yet
   * (`preTriggerFill`); null once it can. */
  triggerPreFill?: PreTriggerFill | null;
  /** Configuring a condition turned the trigger on during this free-running capture; it
   * arms the next acquisition (`autoArmDefersToNextCapture`). */
  triggerArmDeferred?: boolean;
  /** Loop display matcher/swap readout; null outside a running analog Loop. */
  loopMetrics?: LoopDisplayMetrics | null;
  /** A previous Repeat Interval missed its trigger; the session is retrying. */
  repeatMissed?: boolean;
}

/**
 * Read-only Loop display instrumentation. `anchorStepSamples` is how far the last
 * auto-roll advanced the anchored window (one scanned crossing, i.e. a whole number of
 * signal periods); `blockSamples` is what the block planner could swap in under the
 * current frame/memory budget. Both are in samples.
 */
export interface LoopDisplayMetrics {
  /** The running capture's rate, so the panel can say durations instead of counts. */
  samplerateHz: number;
  stride: number;
  scanRateHz: number;
  /** Median of adjacent reported crossings; 0 until two have been seen. */
  periodSamples: number;
  anchorStepSamples: number;
  blockSamples: number;
  blockBytes: number;
  refreshHz: number;
  retainedBytes: number;
  fullWindow: boolean;
}

/** The fields needed to refresh the trigger-state notes without rebuilding the panel. */
export type TriggerStatusView = Pick<CapturePanelView,
  'running' | 'stopping' | 'triggerState' | 'triggerViewLost' | 'triggerViewPending' |
  'triggerLocked' | 'triggerAnalogRolling' | 'triggerArmed' | 'triggerAutoDisarmed' |
  'settingsArmed' | 'repeatMissed' | 'triggerPreObtainedSec' | 'triggerPreFill' |
  'triggerArmDeferred'> & { mode: CaptureSettings['mode'] };

export class CapturePanel {
  private advancedOpen = false;
  /** The live temperature span in the Advanced section, if it is mounted. */
  private tempValue: HTMLElement | null = null;
  /** The custom gain ratio being typed, kept across re-renders; null when none is. */
  private gainEdit: { start: number; text: string } | null = null;
  /** The custom threshold being typed, kept across re-renders; null when none is. */
  private thresholdEdit: string | null = null;
  /** True while render() detaches the old tree, so a removed field's blur is inert. */
  private rendering = false;
  private consoleLines: string[] = [];
  private liveNote: HTMLElement | null = null;
  private lostNote: HTMLElement | null = null;
  /** The dynamic arming/pending/memory notes, refreshed without a panel rebuild. */
  private triggerNotesEl: HTMLElement | null = null;
  /** The "Armed: ..." summary, hidden once the acquisition no longer just waits. */
  private triggerArmedEl: HTMLElement | null = null;
  private droppedNote: HTMLElement | null = null;
  private memoryNote: HTMLElement | null = null;
  private saveNote: HTMLElement | null = null;
  private statusDetail: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressValue: HTMLElement | null = null;
  private triggerStatusEl: HTMLElement | null = null;
  private loopMatcherEl: HTMLElement | null = null;
  private loopSwapEl: HTMLElement | null = null;
  private readonly chipRows = new Map<Element, () => void>();
  private chipObserver: ResizeObserver | null = null;
  private chipFallback = false;

  constructor(
    private readonly host: CapturePanelHost,
    private readonly cb: CapturePanelCallbacks,
  ) {}

  dispose(): void {
    this.chipObserver?.disconnect();
    this.chipObserver = null;
    this.chipRows.clear();
  }

  private watchChipRow(
    grid: HTMLElement, chips: readonly HTMLButtonElement[], indices: readonly number[],
  ): void {
    const apply = (): void => {
      const sample = chips[0];
      if (sample === undefined) return;
      const full = widestChipBox(sample, indices.map((index) => chipLabel(index, 'full')));
      const short = widestChipBox(sample, indices.map((index) => chipLabel(index, 'short')));
      const gap = Number.parseFloat(getComputedStyle(grid).columnGap);
      const fit = chipRowFit(grid.clientWidth, CHANNEL_BANK_SIZE, full, short,
        Number.isFinite(gap) ? gap : undefined);
      grid.dataset.chipForm = fit.form;
      grid.style.setProperty('--chip-min-w', `${Math.round(fit.chipCss * 100) / 100}px`);
    };
    this.chipRows.set(grid, apply);
    if (this.chipObserver === null && typeof ResizeObserver !== 'undefined') {
      this.chipObserver = new ResizeObserver((entries) => {
        for (const entry of entries) this.chipRows.get(entry.target)?.();
      });
    }
    if (this.chipObserver !== null) {
      this.chipObserver.observe(grid);
      return;
    }
    if (!this.chipFallback) {
      this.chipFallback = true;
      if (typeof window !== 'undefined') {
        window.addEventListener('resize', () => {
          for (const refresh of this.chipRows.values()) refresh();
        });
      }
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
    else apply();
  }

  private *roots(): Generator<HTMLElement, void, undefined> {
    yield this.host.capture;
    yield this.host.cursors;
  }

  updateProgress(progress: NonNullable<CapturePanelView['progress']>): void {
    if (!this.liveNote) return;
    this.fillProgress(progress);
  }

  /** "Saving… x%" under the capture status, without a panel rebuild; null hides it. */
  updateSaveProgress(percent: number | null): void {
    if (!this.saveNote) return;
    this.saveNote.hidden = percent === null;
    this.saveNote.textContent = percent === null ? ''
      : t('capturePanel.saving', { percent: Math.max(0, Math.min(100, Math.floor(percent))) });
  }

  updateCursorDistances(rows: readonly CursorDistanceRowView[]): void {
    const byId = new Map<number, CursorDistanceRowView>();
    for (const row of rows) byId.set(row.id, row);
    for (const root of this.roots()) {
      for (const item of root.querySelectorAll<HTMLElement>('.cursor-dist-row')) {
        const row = byId.get(Number(item.dataset.distanceId));
        if (row === undefined) continue;
        const delta = item.querySelector<HTMLElement>('.cursor-dist-delta');
        if (delta === null) continue;
        delta.textContent = row.delta;
      }
    }
  }

  updateCursorEdges(rows: readonly CursorEdgeRowView[]): void {
    const byId = new Map<number, CursorEdgeRowView>();
    for (const row of rows) byId.set(row.id, row);
    for (const root of this.roots()) {
      for (const item of root.querySelectorAll<HTMLElement>('.cursor-edge-row')) {
        const row = byId.get(Number(item.dataset.edgeId));
        if (row === undefined) continue;
        const result = item.querySelector<HTMLElement>('.cursor-edge-result');
        if (result === null) continue;
        result.textContent = row.result;
      }
    }
  }

  updateCursors(rows: readonly CursorRowView[]): void {
    const byId = new Map<number, CursorRowView>();
    for (const row of rows) byId.set(row.id, row);
    for (const root of this.roots()) {
      for (const item of root.querySelectorAll<HTMLElement>('.cursor-row')) {
        const row = byId.get(Number(item.dataset.cursorId));
        if (row === undefined) continue;
        const pos = item.querySelector<HTMLElement>('.cursor-pos');
        if (pos === null) continue;
        pos.textContent = cursorCellText(row);
      }
    }
  }

  /**
   * Refresh the trigger-state notes only. Repeat waves do not rebuild the panel, so the
   * waiting/triggered text would otherwise stay stale for the whole sweep.
   */
  private fillProgress(progress: NonNullable<CapturePanelView['progress']>): void {
    this.liveNote!.textContent = t('capturePanel.recording', {
      seconds: progress.seconds.toFixed(2),
      samples: progress.samples.toLocaleString(),
      megabytes: (progress.bytes / 1e6).toFixed(1),
    });
    this.lostNote!.hidden = progress.lost <= 0;
    this.lostNote!.textContent = t('capturePanel.dropped', { samples: progress.lost.toLocaleString() });
    // The loop window line stays up for the whole run, not only once something was
    // dropped: samples/limit/dropped is the loop status (HSync's LiveStatus).
    this.droppedNote!.hidden = progress.limit <= 0;
    if (progress.limit > 0) {
      const rate = progress.samplerateHz > 0 ? progress.samplerateHz : 1;
      this.droppedNote!.textContent = t('capturePanel.loopWindow', {
        kept: formatDuration(progress.kept / rate),
        limit: formatDuration(progress.limit / rate),
        dropped: formatDuration(progress.dropped / rate),
        rate: formatRate(rate),
      });
    }
    const memory = progress.memory ?? null;
    if (this.memoryNote) {
      this.memoryNote.hidden = memory === null;
      if (memory !== null) {
        this.memoryNote.textContent = t('capturePanel.memoryRemaining', {
          size: formatBytes(memory.capBytes),
          samples: memory.capSamples.toLocaleString(),
          duration: formatDuration(memory.remainingSeconds, 2),
        });
        // Within ~10% of the ceiling the readout turns warning: the capture is about to
        // stop on its own as "Memory limit reached".
        this.memoryNote.classList.toggle('warning', memory.warn);
      }
    }
    const target = progress.targetSamples;
    if (this.statusDetail) {
      this.statusDetail.textContent = target !== null
        ? t('capturePanel.statusFiniteDetail')
        : t('capturePanel.statusLoopDetail');
    }
    this.setStatusProgress(target !== null && target > 0 ? progress.samples / target * 100 : null);
  }

  private setStatusProgress(percent: number | null): void {
    if (!this.progressEl || !this.progressBar || !this.progressValue) return;
    const indeterminate = percent === null;
    this.progressEl.dataset.indeterminate = String(indeterminate);
    if (indeterminate) {
      this.progressEl.removeAttribute('aria-valuenow');
      this.progressValue.textContent = '';
      this.progressBar.style.width = '100%';
      return;
    }
    const rounded = Math.max(0, Math.min(100, Math.round(percent)));
    this.progressEl.setAttribute('aria-valuenow', String(rounded));
    this.progressValue.textContent = `${rounded}%`;
    this.progressBar.style.width = `${rounded}%`;
  }

  updateTriggerStatus(status: TriggerStatusView): void {
    this.fillTriggerStatus(status);
    this.fillTriggerNotes(status);
  }

  /**
   * Refresh only the dynamic trigger notes. Repeat waves and the digital-lock eviction
   * path do not rebuild the panel, so the "Armed" summary and pending/arming notes would
   * otherwise stay in the DOM after the state they describe has passed.
   */
  private fillTriggerNotes(v: TriggerStatusView): void {
    const host = this.triggerNotesEl;
    if (!host) return;
    host.replaceChildren();
    const notes = triggerPanelNotes({
      running: v.running,
      stopping: v.stopping,
      mode: v.mode,
      triggerState: v.triggerState,
      settingsArmed: v.settingsArmed,
      triggerArmed: v.triggerArmed,
      triggerLocked: v.triggerLocked,
      triggerAnalogRolling: v.triggerAnalogRolling,
      triggerViewPending: v.triggerViewPending,
      triggerAutoDisarmed: v.triggerAutoDisarmed,
      triggerArmDeferred: v.triggerArmDeferred === true,
    });
    if (notes.arming) {
      const arming = div('panel-note live');
      arming.textContent = t('capturePanel.armingTrigger');
      host.appendChild(arming);
    }
    if (notes.armNext) {
      const next = div('panel-note');
      next.textContent = t(v.mode === 'repeat'
        ? 'capturePanel.triggerArmNextRepeat' : 'capturePanel.triggerArmNext');
      host.appendChild(next);
    }
    if (notes.memoryReleased) {
      const released = div('panel-note error');
      released.textContent = t('capturePanel.triggerMemoryReleased');
      host.appendChild(released);
    }
    if (notes.pending) {
      const pending = div('panel-note');
      pending.textContent = t('capturePanel.pendingTrigger');
      host.appendChild(pending);
    }
    if (this.triggerArmedEl) this.triggerArmedEl.hidden = !notes.armedSummary;
  }

  /** The status-view subset of the full panel view, for the text-only refresh path. */
  private triggerStatusFrom(v: CapturePanelView, mode: CaptureSettings['mode']): TriggerStatusView {
    return {
      mode,
      running: v.running,
      stopping: v.stopping,
      triggerState: v.triggerState,
      triggerViewLost: v.triggerViewLost,
      triggerViewPending: v.triggerViewPending,
      triggerLocked: v.triggerLocked,
      triggerAnalogRolling: v.triggerAnalogRolling,
      triggerArmed: v.triggerArmed,
      triggerAutoDisarmed: v.triggerAutoDisarmed,
      settingsArmed: v.settingsArmed,
      repeatMissed: v.repeatMissed === true,
      triggerPreObtainedSec: v.triggerPreObtainedSec ?? null,
      triggerPreFill: v.triggerPreFill ?? null,
      triggerArmDeferred: v.triggerArmDeferred === true,
    };
  }

  private fillTriggerStatus(v: TriggerStatusView): void {
    const host = this.triggerStatusEl;
    if (!host) return;
    host.replaceChildren();
    const note = triggerStatusNote(v);
    if (note === 'preFilling' && v.triggerPreFill) {
      // The pre-fill holdoff: a match is ignored until the pre-trigger window has filled.
      const fill = div('panel-note live');
      fill.textContent = t('capturePanel.preTriggerFilling', {
        elapsed: formatDuration(v.triggerPreFill.elapsedSec),
        total: formatDuration(v.triggerPreFill.totalSec),
      });
      host.appendChild(fill);
    } else if (note === 'waiting' || note === 'preFilling') {
      const wait = div('panel-note live');
      wait.textContent = t('capturePanel.waitingTrigger');
      host.appendChild(wait);
    } else if (note === 'viewLost') {
      // The loop window is shorter than one transfer: say why the view did not lock
      // instead of leaving the "Triggered" claim contradicting the rolling plot.
      const lost = div('panel-note error');
      lost.textContent = t('capturePanel.triggerViewLost');
      host.appendChild(lost);
    } else if (note === 'loopAnalog' || note === 'loopDigital') {
      // A digital loop lock is one-shot and never rolls, so it must not claim the
      // analog local-step advance.
      const hit = div('panel-note live');
      hit.textContent = t(note === 'loopAnalog'
        ? 'capturePanel.triggeredLoop' : 'capturePanel.triggeredLoopDigital');
      host.appendChild(hit);
    } else if (note === 'loopReleased' || note === 'loopReleasedDigital') {
      const released = div(note === 'loopReleased' ? 'panel-note' : 'panel-note error');
      released.textContent = t(note === 'loopReleased'
        ? 'capturePanel.triggerLoopReleased' : 'capturePanel.triggerLoopReleasedDigital');
      host.appendChild(released);
    } else if (note === 'triggered') {
      const hit = div('panel-note live');
      hit.textContent = t('capturePanel.triggered');
      host.appendChild(hit);
    } else if (note === 'autoForced') {
      // The analog Auto sweep: the data on screen is real but untriggered (no T). This is
      // neither a match nor a miss, so it is neither "live" nor an error.
      const auto = div('panel-note');
      const head = document.createElement('strong');
      head.textContent = t('capturePanel.triggerAutoForced');
      auto.append(head, ' ', t('capturePanel.triggerAutoForcedHint'));
      host.appendChild(auto);
    } else if (note === 'notFound' && !(v.repeatMissed && v.mode === 'repeat')) {
      const miss = div('panel-note error');
      // finish() discards the rolling search prefix - nothing was recorded.
      miss.textContent = t('capturePanel.triggerNotFound');
      host.appendChild(miss);
    }

    if (v.triggerPreObtainedSec !== null && v.triggerPreObtainedSec !== undefined) {
      // The capture holds less negative time than the armed note promised; say how much.
      const short = div('panel-note');
      short.textContent = t('capturePanel.preTriggerObtained', {
        duration: formatDuration(v.triggerPreObtainedSec),
      });
      host.appendChild(short);
    }

    if (v.repeatMissed && v.mode === 'repeat') {
      // B1: the miss belongs to an earlier Interval. Keep it visible while the session
      // retries, rather than letting the next wave's "waiting" note erase the news.
      const miss = div('panel-note error');
      miss.textContent = t('capturePanel.repeatMissRetry');
      host.appendChild(miss);
    }
  }

  /**
   * Refresh only the Loop instrumentation text. Called on the running panel's 500 ms
   * cadence; a full render here would rebuild inputs and drop focus.
   */
  updateLoopMetrics(metrics: LoopDisplayMetrics | null): void {
    const matcher = this.loopMatcherEl;
    const swap = this.loopSwapEl;
    if (!matcher || !swap) return;
    if (!metrics) {
      matcher.hidden = true;
      swap.hidden = true;
      return;
    }
    matcher.hidden = false;
    matcher.textContent = t('capturePanel.loopMatcher', {
      stride: formatCount(metrics.stride),
      rate: formatRate(metrics.scanRateHz),
    });
    if (metrics.blockSamples > 0 && metrics.refreshHz > 0) {
      swap.hidden = false;
      const rate = metrics.samplerateHz > 0 ? metrics.samplerateHz : 1;
      swap.textContent = t('capturePanel.loopSwap', {
        step: formatDuration(metrics.anchorStepSamples / rate),
        block: formatDuration(metrics.blockSamples / rate),
        refresh: formatFreq(metrics.refreshHz),
        retained: formatBytes(metrics.retainedBytes),
      });
    } else {
      // Before the first block there is nothing to swap; a "0 at -" line reads like a
      // defect. The matcher line alone is enough while arming.
      swap.hidden = true;
      swap.textContent = '';
    }
  }

  render(v: CapturePanelView): void {
    const s = v.settings;
    const capture = this.host.capture;
    const cursorPage = this.host.cursors;
    const locked = cursorsLocked(v);
    // A ratio being typed survives a rebuild (a capture finishing mid-entry): its text is
    // kept in gainEdit and its field takes the focus back. The old field's blur, which
    // the removal may fire, must not apply or revert anything.
    const focused = document.activeElement as HTMLElement | null;
    const focusedGain = focused && capture.contains(focused) ? focused.dataset?.analogGainInput : undefined;
    const refocusGain = focusedGain !== undefined ? Number(focusedGain) : null;
    const refocusThreshold = !!focused && capture.contains(focused) &&
      focused.dataset?.thresholdInput !== undefined;
    this.rendering = true;
    this.chipObserver?.disconnect();
    this.chipRows.clear();
    try {
      capture.replaceChildren();
      cursorPage.replaceChildren();
    } finally {
      this.rendering = false;
    }
    this.statusDetail = null;
    this.progressEl = null;
    this.progressBar = null;
    this.progressValue = null;
    this.triggerStatusEl = null;
    this.loopMatcherEl = null;
    this.loopSwapEl = null;

    // ---- channels
    const chSec = section(t('capturePanel.digital'));
    chSec.el.classList.add('digital-section');
    const widthOptions = v.widthOptions;
    if (widthOptions.length > 0) {
      const widths = div('segmented channel-widths');
      widths.setAttribute('role', 'group');
      widths.setAttribute('aria-label', t('capturePanel.channelWidth'));
      for (const n of widthOptions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'seg' + (s.channels === n ? ' on' : '');
        b.textContent = `${n}CH`;
        b.dataset.channelWidth = String(n);
        b.disabled = v.stopping;
        if (b.disabled) {
          b.title = t('capturePanel.channelWidthBusy');
          b.setAttribute('aria-label', b.title);
        } else {
          // One plain sentence per width: the width/max-rate trade-off is the reason to
          // pick fewer channels.
          b.title = t('capturePanel.channelWidthTip', {
            channels: n, rate: formatRate(v.maxSamplerateHz[n] ?? 200e6),
          });
        }
        b.addEventListener('click', () => this.cb.onChannelWidth(n));
        widths.appendChild(b);
      }
      chSec.header.appendChild(widths);
    }

    const banks = div('channel-banks');
    const activeBanks = lockedChannelBanks(v.buses, v.channels.length);
    const analogBusy = v.stopping;
    const bankNotes: HTMLElement[] = [];
    for (const start of channelBankStarts(v.channels.length)) {
      const indices = channelBankIndices(start, v.channels.length);
      const range = channelBankRange(start, v.channels.length);
      const active = activeBanks.has(start);
      const group = start / CHANNEL_BANK_SIZE;
      const name = `A${group}`;
      const bank = div('channel-bank');
      bank.dataset.bankStart = String(start);

      if (active) {
        // The eight inputs are the converter's data bus while it is read, so the row is
        // the analog channel itself, not eight logic chips (HSync's Analog toggle).
        const gain = analogGainOf(v.buses.find((bus) => bus.analogGroup === group));
        const editing = this.gainEdit?.start === start ? this.gainEdit.text : null;
        const gainCell = analogGainCell({
          start, total: v.channels.length, gain, busy: analogBusy, editing,
          live: () => !this.rendering,
          onEditing: (text) => {
            this.gainEdit = text === null ? null : { start, text };
          },
          onGain: (next) => this.cb.onAnalogGain(start, next),
        });
        bank.appendChild(gainCell.cell);
        bankNotes.push(gainCell.note);
        // After this render has attached the tree: a detached field cannot take focus.
        if (editing !== null && refocusGain === start) queueMicrotask(() => gainCell.focusField());
      } else {
        const grid = div('chip-grid channel-bank-grid');
        grid.dataset.bankGrid = String(start);
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', range);
        const chips: HTMLButtonElement[] = [];
        for (const index of indices) {
          const c = v.channels[index]!;
          const chip = document.createElement('button');
          chip.className = 'chip' + (c.enabled ? ' on' : '');
          const prefix = document.createElement('span');
          prefix.className = 'chip-d';
          prefix.textContent = 'D';
          const number = document.createElement('span');
          number.textContent = String(c.index);
          chip.append(prefix, number);
          // The chip shows/hides the row only; what is acquired is the channel width.
          const id = c.name === defaultChannelName(c.index) ? `D${c.index}` : `D${c.index} ${c.name}`;
          chip.title = t('capturePanel.chipToggle', { id });
          chip.setAttribute('aria-label', chip.title);
          chip.dataset.channel = String(c.index);
          chip.setAttribute('aria-pressed', String(c.enabled));
          if (c.enabled) {
            chip.style.background = c.color;
            chip.style.color = chipForeground(c.color);
          } else {
            chip.style.borderColor = c.color;
          }
          chip.addEventListener('click', () => this.cb.onToggleChannel(c.index, !c.enabled));
          grid.appendChild(chip);
          chips.push(chip);
        }
        bank.appendChild(grid);
        this.watchChipRow(grid, chips, indices);
      }

      // One button per row, always in the same place: at the right of the eight slots.
      // A partial row (4 CH) and the 16U3 still show it, disabled, so every row lines up.
      const usable = indices.length === CHANNEL_BANK_SIZE && group < v.analogGroups;
      const hint = analogBusy
        ? t('capturePanel.analogBusy')
        : active
          ? t('capturePanel.analogDisable', { name })
          : !usable
            ? t(indices.length !== CHANNEL_BANK_SIZE ? 'capturePanel.analogNeedsEight'
              : 'capturePanel.analogUnsupported')
            : analogInputHint(start, v.channels.length);
      bank.appendChild(analogButton(start, active, usable && !analogBusy, hint,
        () => this.cb.onToggleAnalog(start)));
      banks.appendChild(bank);
      // A rejected ratio and a clamped trigger level read under the cell they concern.
      for (const note of bankNotes.splice(0)) banks.appendChild(note);
      const clamped = v.analogLevelClamped;
      if (active && clamped && clamped.start === start) {
        const note = div('panel-note');
        note.dataset.analogLevelClamped = '';
        note.textContent = t('capturePanel.analogLevelClamped', {
          name, from: `${clamped.from.toFixed(3)} V`, to: `${clamped.to.toFixed(3)} V`,
        });
        banks.appendChild(note);
      }
    }
    chSec.body.appendChild(banks);


    // ---- rate + threshold
    const rowRT = div('field-row');
    const ceiling = v.maxSamplerateHz[s.channels] ?? 200e6;
    const supported = SAMPLERATES_HZ.filter((r) => r <= ceiling);
    // The ADC module's sample clock must come from its 800 MHz PLL (HSync adc.rs), so an
    // active analog group narrows the list to that PLL's divisors from 100 MHz up.
    const analogRates = activeBanks.size > 0 ? analogSamplerates(supported) : [];
    const selectable = analogRates.length > 0 ? analogRates : supported;
    // Rates above the profile's sustainable one for this width stay selectable, but say
    // so in the list itself, before they are picked (the warning below only follows a
    // choice). A width without a measured recommendation marks nothing.
    const advisedHz = v.recommendedSamplerateHz?.[s.channels];
    const rateOptions = samplerateOptions(selectable, advisedHz);
    const rate = selectControl(
      'capture.sampleRate',
      t('capturePanel.sampleRate'),
      rateOptions,
      String(s.samplerate),
    );
    rate.addEventListener('change', () =>
      this.cb.onSettings({ ...s, samplerate: Number(rate.value) }));
    if (advisedHz !== undefined && selectable.some((r) => r > advisedHz)) {
      rate.el.title = t('capturePanel.rateOptionOverAdvisedHint', {
        channels: s.channels, advised: formatRate(advisedHz),
      });
    }
    rowRT.appendChild(rate.el);

    const thresholdEditing = this.thresholdEdit;
    const th = thresholdField({
      volts: s.thresholdVolts,
      editing: thresholdEditing,
      live: () => !this.rendering,
      onEditing: (text) => { this.thresholdEdit = text; },
      onVolts: (volts) => this.cb.onSettings({ ...s, thresholdVolts: volts }),
    });
    rowRT.appendChild(th.el);
    chSec.body.appendChild(rowRT);
    if (thresholdEditing !== null && refocusThreshold) queueMicrotask(() => th.focusField());

    // The effective rate above the profile's sustainable one for this width, whether the
    // user chose it or an analog group forced it (see rateAdvice.ts): warn, never change
    // the channel selection behind the user's back.
    const overAdvice = rateAdvice({
      channels: s.channels,
      samplerate: s.samplerate,
      recommended: v.recommendedSamplerateHz ?? {},
      analogMinHz: analogRates.length > 0 ? Math.min(...analogRates) : undefined,
    });
    if (overAdvice) {
      const warn = div('panel-note warning');
      warn.dataset.rateAdvice = overAdvice.key;
      warn.textContent = t(overAdvice.key, {
        channels: s.channels,
        rate: formatRate(s.samplerate),
        advised: formatRate(overAdvice.advised),
        min: formatRate(overAdvice.analogMinHz ?? overAdvice.advised),
      });
      chSec.body.appendChild(warn);
    }

    // A rate the app changed for the user is always announced, not only when it lands
    // above the recommendation: "raised from 10 MS/s to 100 MS/s (analog input)".
    if (v.rateChange) {
      const changed = div('panel-note');
      changed.dataset.rateChange = v.rateChange.reason;
      changed.textContent = t(rateChangeMessageKey(v.rateChange), {
        from: formatRate(v.rateChange.from), to: formatRate(v.rateChange.to),
      });
      chSec.body.appendChild(changed);
    }

    if (activeBanks.size > 0) {
      const analogNote = div('panel-note');
      analogNote.textContent = t('capturePanel.analogRateNote');
      chSec.body.appendChild(analogNote);
    }

    const code = vrefCode(s.thresholdVolts);
    const note = div('panel-note');
    // The ceiling is what the board accepts, not what the USB link sustains: where the
    // profile measured a lower sustainable rate, the note leads with that figure.
    const advised = v.recommendedSamplerateHz?.[s.channels];
    note.textContent = advised !== undefined && advised < ceiling
      ? t('capturePanel.dacNoteAdvised', {
        code,
        volts: vrefVolts(code).toFixed(3),
        channels: s.channels,
        advised: formatRate(advised),
        rate: formatRate(ceiling),
      })
      : t('capturePanel.dacNote', {
        code,
        volts: vrefVolts(code).toFixed(3),
        channels: s.channels,
        rate: formatRate(ceiling),
      });
    chSec.body.appendChild(note);
    capture.appendChild(chSec.el);

    // ---- mode
    const modeSec = section(t('capturePanel.capture'));
    const modeLocked = v.running || v.stopping || v.repeatPending;
    const timeLocked = v.stopping;
    const seg = div('segmented');
    for (const [id, text] of [
      ['single', t('capturePanel.modeSingle')], ['repeat', t('capturePanel.modeRepeat')],
      ['loop', t('capturePanel.modeLoop')],
    ] as const) {
      const b = document.createElement('button');
      b.className = 'seg' + (s.mode === id ? ' on' : '');
      b.textContent = text;
      b.dataset.captureMode = id;
      b.title = t(id === 'single' ? 'capturePanel.modeSingleTip'
        : id === 'repeat' ? 'capturePanel.modeRepeatTip' : 'capturePanel.modeLoopTip');
      b.disabled = modeLocked;
      b.addEventListener('click', () => this.cb.onSettings({ ...s, mode: id }));
      seg.appendChild(b);
    }
    modeSec.body.appendChild(seg);

    if (v.running) {
      const pending = div('panel-note');
      pending.textContent = t(s.mode === 'loop'
        ? 'capturePanel.pendingApplyLoop' : 'capturePanel.pendingApply');
      modeSec.body.appendChild(pending);
    }
    if (s.mode === 'repeat') {
      // A text legend for the two Repeat surfaces: the distinction must not rely on
      // colour alone, and the same wording explains the hand-over during a Fixed view.
      const layers = div('panel-note');
      layers.textContent = t('capturePanel.repeatLayersNote');
      modeSec.body.appendChild(layers);
      if (s.triggerEnableMask) {
        const search = div('panel-note');
        search.textContent = t('capturePanel.repeatSearchNote');
        modeSec.body.appendChild(search);
      }
    }

    const badgeKeys = {
      ready: 'capturePanel.statusReady',
      capturing: 'capturePanel.statusCapturing',
      stopping: 'capturePanel.statusStopping',
      waiting: 'capturePanel.statusWaiting',
      completed: 'capturePanel.statusCompleted',
      aborted: 'capturePanel.statusAborted',
    } as const;
    const badge = document.createElement('span');
    badge.className = 'capture-badge'
      + (v.captureState === 'capturing' ? ' live' : '')
      + (v.captureState === 'waiting' ? ' waiting' : '')
      + (v.captureState === 'stopping' ? ' stopping' : '')
      + (v.captureState === 'aborted' ? ' aborted' : '');
    badge.textContent = t(badgeKeys[v.captureState]);
    modeSec.header.appendChild(badge);

    const status = div('capture-status');
    status.dataset.captureState = v.captureState;
    const statusLine = div('capture-status-line');
    const statusDetail = document.createElement('span');
    statusDetail.className = 'capture-status-detail';
    statusDetail.dataset.captureStatusDetail = '';
    const statusValue = document.createElement('strong');
    statusValue.className = 'capture-status-value';
    statusValue.translate = false;
    const progress = div('capture-progress');
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', t('capturePanel.progress'));
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    const progressBar = document.createElement('span');
    statusLine.append(statusDetail, statusValue);
    progress.appendChild(progressBar);
    status.append(statusLine, progress);
    modeSec.body.appendChild(status);
    this.statusDetail = statusDetail;
    this.progressEl = progress;
    this.progressBar = progressBar;
    this.progressValue = statusValue;

    const progressActive = v.captureState === 'capturing'
      || v.captureState === 'stopping' || v.captureState === 'waiting';
    progress.hidden = !progressActive;
    statusDetail.textContent = v.captureState === 'ready'
      ? t('capturePanel.statusReadyDetail')
      : v.captureState === 'waiting'
        ? t('capturePanel.statusWaitingDetail', {
          interval: formatDuration(v.settings.repeatIntervalSeconds),
        })
        : v.captureState === 'stopping'
          ? t('capturePanel.statusStoppingDetail')
          : v.captureState === 'completed'
            ? t('capturePanel.statusCompletedDetail', {
              samples: (v.result?.samples ?? 0).toLocaleString(),
              duration: formatDuration(v.result?.seconds ?? 0),
            })
            : v.captureState === 'aborted'
              ? captureAbortDetail(v.abort ?? { cause: 'device', requestedSeconds: null },
                v.result ?? { samples: 0, seconds: 0 })
            : v.progress && v.progress.targetSamples === null
              ? t('capturePanel.statusLoopDetail')
              : t('capturePanel.statusFiniteDetail');
    if (progressActive) this.setStatusProgress(null);
    else {
      this.progressBar.style.width = '0%';
      this.progressValue.textContent = '';
      progress.removeAttribute('aria-valuenow');
      progress.dataset.indeterminate = 'false';
    }

    const maxSeconds = maxCaptureSeconds(s.samplerate);
    if (s.mode === 'single' || s.mode === 'repeat') {
      const duration = acquisitionTimeControl({
        key: 'capture.duration',
        label: t('capturePanel.duration'),
        seconds: s.seconds,
        minSeconds: MIN_CAPTURE_SECONDS,
        maxSeconds,
        disabled: timeLocked,
        onValue: (seconds) => {
          this.cb.onSettings({ ...s, seconds });
        },
      });
      modeSec.body.appendChild(duration.el);
      if (s.mode === 'repeat') {
        const interval = acquisitionTimeControl({
          key: 'capture.repeatInterval',
          label: t('capturePanel.repeatInterval'),
          seconds: s.repeatIntervalSeconds,
          minSeconds: REPEAT_INTERVAL_SECONDS.min,
          maxSeconds: REPEAT_INTERVAL_SECONDS.max,
          disabled: timeLocked,
          onValue: (seconds) => {
            this.cb.onSettings({ ...s, repeatIntervalSeconds: seconds });
          },
        });
        modeSec.body.appendChild(interval.el);
      }
    } else {
      const maxSamples = maxLoopSamples(s.channels);
      const minSeconds = LOOP_WINDOW_QUANTUM / s.samplerate;
      const maxWindowSeconds = maxSamples / s.samplerate;
      const windowControl = acquisitionTimeControl({
        key: 'capture.loopWindow',
        // Loop is a rolling single capture; its window is the capture's duration, and the
        // panel calls it that in every mode (HSync's acquisition menu does the same).
        label: t('capturePanel.duration'),
        seconds: clampLoopSamples(s.loopSamples, s.channels) / s.samplerate,
        minSeconds,
        maxSeconds: maxWindowSeconds,
        disabled: timeLocked,
        onValue: (seconds) => {
          const samples = clampLoopSamples(Math.round(seconds * s.samplerate), s.channels);
          this.cb.onSettings({ ...s, loopSamples: samples });
        },
      });
      modeSec.body.appendChild(windowControl.el);
    }
    const limit = div('panel-note');
    if (s.mode === 'loop') {
      limit.textContent = t('capturePanel.loopWindowLimit', {
        samples: clampLoopSamples(s.loopSamples, s.channels).toLocaleString(),
        duration: formatDuration(clampLoopSamples(s.loopSamples, s.channels) / s.samplerate),
        rate: formatRate(s.samplerate),
      });
    } else {
      const noteKey = s.mode === 'single'
        ? 'capturePanel.singleFiniteNote' : 'capturePanel.repeatFiniteNote';
      limit.textContent = t(noteKey, { max: formatDuration(maxSeconds) });
    }
    modeSec.body.appendChild(limit);

    const triggerSec = section(t('capturePanel.softwareTrigger'));
    const mask = document.createElement('input');
    mask.type = 'checkbox'; mask.checked = s.triggerEnableMask;
    // Trigger edits are live while the matcher waits and pending after it matches; only
    // a capture that is already tearing down refuses them.
    mask.disabled = v.stopping;
    mask.title = t('capturePanel.enableTrigger');
    mask.setAttribute('aria-label', mask.title);
    triggerSec.header.appendChild(mask);
    mask.addEventListener('change', () => this.cb.onSettings({ ...s, triggerEnableMask: mask.checked }));
    // Always visible, even while the section body is collapsed: one sentence on what the
    // checkbox does, including that "on" with no condition is a free run. Why conditions
    // can be stored unarmed, and why adding one turns this on, live behind the "?".
    const enableHelp = div('panel-note help-note');
    enableHelp.textContent = t('capturePanel.triggerEnableHelp');
    enableHelp.style.marginTop = '8px';
    enableHelp.appendChild(helpTip(t('capturePanel.triggerEnableDetail')));
    triggerSec.el.appendChild(enableHelp);
    triggerSec.body.hidden = !s.triggerEnableMask;
    if (s.triggerEnableMask) {
      // Analog triggering needs an active ADC group, and its preview below only reflects
      // triggers configured on those rows, so resolve the group set before the buttons.
      const analogBanks = [...new Set(v.buses
        .filter((bus) => bus.analogGroup !== undefined)
        .map((bus) => bus.analogGroup! * CHANNEL_BANK_SIZE))]
        .filter((start) => start + CHANNEL_BANK_SIZE <= v.channels.length)
        .sort((a, b) => a - b);
      const analogAvailable = analogBanks.length > 0;
      const gainAt = (start: number): number =>
        analogGainOf(v.buses.find((bus) => bus.analogGroup === start / CHANNEL_BANK_SIZE));
      const hiddenInputs = new Set<number>();
      for (const start of analogBanks) {
        for (let offset = 0; offset < CHANNEL_BANK_SIZE; offset++) hiddenInputs.add(start + offset);
      }
      const digitalConditions = s.triggerConditions
        .filter((condition) => !hiddenInputs.has(condition.channel));
      const settingsArmed = v.settingsArmed;
      // Every trigger control is editable while the capture runs: a waiting matcher is
      // retuned in place, a matched one keeps its matcher and the edit is pending for the
      // next acquisition (the pending note says so). A matched Loop analog detector is
      // the exception: it retunes live.
      const triggerEditable = !v.stopping;

      const sourceSeg = div('segmented trigger-source');
      sourceSeg.setAttribute('role', 'group');
      sourceSeg.setAttribute('aria-label', t('capturePanel.triggerSource'));
      for (const [source, label] of [
        ['digital', t('capturePanel.triggerDigital')],
        ['analog', t('capturePanel.triggerAnalog')],
      ] as const) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'seg' + (s.triggerSource === source ? ' on' : '');
        button.textContent = label;
        button.dataset.triggerSource = source;
        const analogUnavailable = source === 'analog' && !analogAvailable;
        button.disabled = !triggerEditable || analogUnavailable;
        if (analogUnavailable) {
          // There is no ADC group to arm, so say how to make one (or why there cannot be).
          button.title = v.analogGroups > 0
            ? analogInputHint(0, v.channels.length)
            : t(v.channels.length < CHANNEL_BANK_SIZE
              ? 'capturePanel.analogNeedsEight'
              : 'capturePanel.analogUnsupported');
          button.setAttribute('aria-label', button.title);
        }
        button.addEventListener('click', () => {
          if (source === 'analog') {
            // Only one ADC crossing can fix the time base; keep the first stored one.
            const first = Object.entries(s.analogTriggers ?? {})
              .sort(([a], [b]) => Number(a) - Number(b))[0];
            const analogTriggers = first
              ? { [Number(first[0])]: first[1] } : {};
            this.cb.onSettings({ ...s, triggerSource: source, analogTriggers });
          } else {
            this.cb.onSettings({ ...s, triggerSource: source });
          }
        });
        sourceSeg.appendChild(button);
      }
      // What the source choice means and how Single/Repeat differ from Loop is a "?"
      // detail beside the buttons, not a paragraph in the panel.
      const sourceRow = div('help-row');
      sourceRow.append(sourceSeg, helpTip(t('capturePanel.triggerSourceHelp')));
      triggerSec.body.appendChild(sourceRow);
      this.triggerNotesEl = div('trigger-notes');
      this.triggerArmedEl = null;
      triggerSec.body.appendChild(this.triggerNotesEl);
      if (!settingsArmed && !v.stopping) {
        // The one mistake this section invites: enabling the trigger and never picking a
        // condition, which silently arms nothing.
        const empty = div('panel-note error');
        empty.textContent = t('capturePanel.noCondition');
        triggerSec.body.appendChild(empty);
      }

      if (v.triggerRetuneRejected) {
        // The device cannot arm this analog condition at the running rate/board; the
        // edit is pending for the next acquisition, not silently armed.
        const rejected = div('panel-note error');
        rejected.textContent = t('capturePanel.triggerRetuneRejected');
        triggerSec.body.appendChild(rejected);
      }

      if (s.triggerSource === 'digital') {
        if (digitalConditions.length === 0) {
          const empty = div('panel-note error');
          empty.textContent = t('capturePanel.noDigitalTrigger');
          triggerSec.body.appendChild(empty);
        } else {
          const list = div('global-trigger-list');
          for (const condition of digitalConditions) {
            const row = div('global-trigger-row');
            const name = document.createElement('span');
            name.className = 'global-trigger-name';
            name.textContent = `D${condition.channel}`;
            const mode = document.createElement('span');
            mode.className = 'global-trigger-mode';
            mode.textContent = digitalConditionLabel(condition.kind, condition.level);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'global-trigger-remove';
            remove.textContent = '×';
            remove.title = t('capturePanel.removeTrigger', { channel: `D${condition.channel}` });
            remove.setAttribute('aria-label', remove.title);
            remove.disabled = !triggerEditable;
            remove.addEventListener('click', () => {
              const triggerModes = { ...s.triggerModes, [condition.channel]: 'dont-care' as const };
              const triggerConditions = s.triggerConditions
                .filter((candidate) => candidate.channel !== condition.channel);
              this.cb.onSettings({ ...s, triggerModes, triggerConditions });
            });
            row.append(name, mode, remove);
            list.appendChild(row);
          }
          triggerSec.body.appendChild(list);
        }
      } else {
        const note = div('panel-note');
        note.textContent = t('capturePanel.analogSingleNote');
        triggerSec.body.appendChild(note);
        const configured = analogBanks
          .filter((start) => s.analogTriggers?.[start] !== undefined);
        if (configured.length === 0) {
          // While the matcher waits, removing the last condition restarts the capture as
          // a free run; after a match the removal is pending for the next acquisition.
          // Neither is a configuration error.
          const empty = div(v.running || v.stopping ? 'panel-note' : 'panel-note error');
          const firstBank = analogBanks[0];
          if (firstBank !== undefined) {
            // The Trigger control is on the ADC row in the left column; this section only
            // previews and removes what that row configured.
            empty.textContent = t('channels.triggerTip', {
              name: `A${firstBank / CHANNEL_BANK_SIZE}`,
              mode: t('trigger.none'),
            });
          } else {
            // No ADC group to point at; the Analog source button above is disabled too.
            empty.textContent = t('capturePanel.noAnalogTrigger');
          }
          triggerSec.body.appendChild(empty);
        } else {
          const list = div('global-trigger-list');
          for (const start of configured) {
            const setting = s.analogTriggers[start]!;
            const name = `A${start / CHANNEL_BANK_SIZE}`;
            const row = div('global-trigger-row');
            const rowName = document.createElement('span');
            rowName.className = 'global-trigger-name';
            rowName.textContent = name;
            const mode = document.createElement('span');
            mode.className = 'global-trigger-mode';
            mode.textContent =
              `${t(setting.kind === 'rising' ? 'trigger.rising' : 'trigger.falling')} ` +
              `${analogTriggerVolts(setting.kind, setting.volts, gainAt(start)).toFixed(4)} V`;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'global-trigger-remove';
            remove.textContent = '×';
            remove.title = t('capturePanel.removeTrigger', { channel: name });
            remove.setAttribute('aria-label', remove.title);
            // Analog level/slope/removal edits are pending-run settings and remain live.
            remove.addEventListener('click', () => {
              this.cb.onSettings({ ...s, analogTriggers: {} });
            });
            row.append(rowName, mode, remove);
            list.appendChild(row);
          }
          triggerSec.body.appendChild(list);
        }
      }

      const preOptions: SelectOptionTuple[] = [
        // Percent-notation options stay literal: they are notation, not prose.
        ['0', t('capturePanel.noPreTrigger')], ['10', '10%'], ['25', '25%'], ['50', '50%'], ['75', '75%'],
      ];
      const pre = selectControl(
        'capture.preTrigger',
        t('capturePanel.preTriggerBuffer'),
        preOptions,
        String(s.preTriggerPercent),
      );
      pre.disabled = v.running || v.stopping;
      pre.addEventListener('change', () => this.cb.onSettings({ ...s, preTriggerPercent: Number(pre.value) }));
      const preRow = div('help-row');
      preRow.appendChild(pre.el);
      triggerSec.body.appendChild(preRow);
      if (s.mode === 'loop' && s.triggerEnableMask) {
        // In a loop the percentage is the trigger's horizontal position, not only how
        // much history is kept. The analog note describes the local roll; the digital
        // note must not claim re-anchoring, because a digital lock is one-shot. A running
        // capture whose scanner was torn down still follows its configured source for
        // this explanation.
        const analogConfigured = s.triggerSource === 'analog' &&
          analogBanks.some((start) => s.analogTriggers?.[start] !== undefined);
        const analog = v.triggerAnalogRolling || analogConfigured;
        preRow.appendChild(helpTip(t(analog
          ? 'capturePanel.loopTriggerNote' : 'capturePanel.loopTriggerNoteDigital')));
      }

      // The one mistake this section invites: enabling the trigger and never picking a
      // condition, which silently arms nothing. Say what is armed, or what is missing.
      const armed = div('panel-note');
      const digitalWhat = s.triggerSource === 'digital'
        ? digitalConditions.map((c) =>
          `D${c.channel} ${digitalConditionLabel(c.kind, c.level)}`)
        : [];
      const analogWhat = s.triggerSource === 'analog'
        ? analogBanks
          .filter((start) => s.analogTriggers?.[start] !== undefined)
          .map((start) => {
            const setting = s.analogTriggers[start]!;
            return `A${start / CHANNEL_BANK_SIZE} ` +
              t(setting.kind === 'rising' ? 'trigger.rising' : 'trigger.falling') +
              ` ${analogTriggerVolts(setting.kind, setting.volts, gainAt(start)).toFixed(4)} V`;
          })
        : [];
      if (digitalWhat.length > 0 || analogWhat.length > 0) {
        const what = [...digitalWhat, ...analogWhat].join(t('capturePanel.condJoiner'));
        // The *effective* pre-trigger window, with the same clamps startCapture
        // applies: percent of the post-trigger budget (of the loop window in loop
        // mode), capped by the 64 MiB retained prefix. Promising the raw percentage
        // would overstate it exactly when the cap bites (e.g. 50% of 1 s at
        // 16ch/200M is capped at ~167 ms).
        const post = capturePostTriggerSamples(s);
        // A running matcher's retained prefix was sized at start; Duration edits cannot
        // grow or shrink it, so the armed note must not claim the new setting's window.
        const requestedPre = Math.floor(post * s.preTriggerPercent / 100);
        const preSamples = v.running && v.activeTriggerPreSamples !== undefined
          ? v.activeTriggerPreSamples
          : Math.min(
            Math.max(0, post - 1),
            Math.max(0, requestedPre),
            Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSampleForChannels(s.channels)),
          );
        const capped = preSamples < requestedPre;
        armed.textContent = capped
          ? t('capturePanel.armedCapped', {
            what,
            duration: formatDuration(preSamples / s.samplerate),
            megabytes: MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / 1048576,
          })
          : t('capturePanel.armed', {
            what,
            duration: formatDuration(preSamples / s.samplerate),
          });
        this.triggerArmedEl = armed;
        triggerSec.body.appendChild(armed);
      }

      this.triggerStatusEl = div('trigger-status');
      triggerSec.body.appendChild(this.triggerStatusEl);
      this.updateTriggerStatus(this.triggerStatusFrom(v, s.mode));

      if (v.loopMetrics) {
        this.loopMatcherEl = div('panel-note');
        this.loopSwapEl = div('panel-note');
        triggerSec.body.appendChild(this.loopMatcherEl);
        triggerSec.body.appendChild(this.loopSwapEl);
        this.updateLoopMetrics(v.loopMetrics);
      }
    }

    // No Start/Stop here on purpose: the toolbar transport is the only one, so there is
    // no second control that can disagree with it about whether a capture may start.
    if (v.progress) {
      this.liveNote = div('panel-note live');
      modeSec.body.appendChild(this.liveNote);
      this.lostNote = div('panel-note error');
      modeSec.body.appendChild(this.lostNote);
      this.droppedNote = div('panel-note');
      modeSec.body.appendChild(this.droppedNote);
      this.memoryNote = div('panel-note');
      this.memoryNote.dataset.captureMemory = '';
      modeSec.body.appendChild(this.memoryNote);
      this.fillProgress(v.progress);
    } else {
      this.liveNote = null;
      this.lostNote = null;
      this.droppedNote = null;
      this.memoryNote = null;
    }
    this.saveNote = div('panel-note');
    this.saveNote.dataset.savePercent = '';
    modeSec.body.appendChild(this.saveNote);
    this.updateSaveProgress(v.savePercent ?? null);
    capture.appendChild(modeSec.el);
    capture.appendChild(triggerSec.el);

    const cursorSec = section(t('capturePanel.cursors'));
    if (v.cursors.length === 0) {
      const hint = div('panel-note');
      hint.textContent = t('capturePanel.cursorEmpty');
      cursorSec.body.appendChild(hint);
    } else {
      const legend = document.createElement('span');
      legend.className = 'cursor-legend';
      legend.textContent = t('capturePanel.cursorFormat');
      cursorSec.header.appendChild(legend);
      const list = div('cursor-list');
      for (const row of v.cursors) {
        const item = div('cursor-row');
        item.dataset.cursorId = String(row.id);
        const order = document.createElement('button');
        order.type = 'button';
        order.className = 'cursor-idx';
        order.textContent = row.label;
        order.style.background = row.color;
        order.style.color = chipForeground(row.color);
        const focusLabel = t('capturePanel.focusCursor', { label: row.label });
        order.title = focusLabel;
        order.setAttribute('aria-label', focusLabel);
        order.addEventListener('click', () => this.cb.onFocusCursor(row.id));
        order.addEventListener('keydown', (e) => {
          if (e.key === ' ') e.stopPropagation();
        });
        const pos = document.createElement('span');
        pos.className = 'cursor-pos';
        pos.translate = false;
        pos.textContent = cursorCellText(row);
        const remove = cursorRemoveButton(t('capturePanel.removeCursor', { label: row.label }),
          () => this.cb.onRemoveCursor(row.id));
        remove.disabled = locked;
        item.append(order, pos, remove);
        list.appendChild(item);
      }
      cursorSec.body.appendChild(list);
    }
    cursorPage.appendChild(cursorSec.el);

    const distanceSec = section(t('capturePanel.cursorDistance'));
    distanceSec.header.classList.add('cursor-dist-head');
    const distanceLegend = document.createElement('span');
    distanceLegend.className = 'cursor-legend';
    distanceLegend.textContent = t('capturePanel.cursorDistanceFormat');
    distanceSec.header.appendChild(distanceLegend);
    if (v.cursorDistances.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'cursor-dist-hint';
      hint.textContent = t(v.cursors.length < 2
        ? 'capturePanel.cursorDistanceEmpty' : 'capturePanel.cursorDistanceNoRows');
      distanceSec.body.appendChild(hint);
    } else {
      const list = div('cursor-dist-list');
      for (const row of v.cursorDistances) {
        const item = div('cursor-dist-row');
        item.dataset.distanceId = String(row.id);
        const a = distanceSideControl(row, 'a', v.cursors,
          (cursorId) => this.cb.onPickCursorDistance(row.id, 'a', cursorId));
        a.el.disabled = locked;
        const mark = document.createElement('span');
        mark.className = 'cursor-dist-mark';
        mark.setAttribute('aria-hidden', 'true');
        // Start -> end: the reading is end minus start, so the arrow says which way it runs.
        mark.textContent = '→';
        const b = distanceSideControl(row, 'b', v.cursors,
          (cursorId) => this.cb.onPickCursorDistance(row.id, 'b', cursorId));
        b.el.disabled = locked;
        const delta = document.createElement('span');
        delta.className = 'cursor-dist-delta';
        delta.translate = false;
        delta.textContent = row.delta;
        const remove = cursorRemoveButton(
          t('capturePanel.cursorDistanceRemove', { row: row.row }),
          () => this.cb.onRemoveCursorDistance(row.id),
        );
        remove.disabled = locked;
        const tail = div('cursor-dist-tail');
        tail.append(delta, remove);
        item.append(a.el, mark, b.el, tail, a.popover, b.popover);
        list.appendChild(item);
      }
      distanceSec.body.appendChild(list);
    }
    const addRow = div('cursor-dist-add-row');
    addRow.appendChild(distanceAddButton(
      v.cursorDistances.length >= MAX_CURSOR_DISTANCE_ROWS || locked,
      () => this.cb.onAddCursorDistance(),
    ));
    distanceSec.body.appendChild(addRow);
    cursorPage.appendChild(distanceSec.el);

    const edgeSec = section(t('capturePanel.cursorEdges'));
    edgeSec.header.classList.add('cursor-edge-head');
    const edgeLegend = document.createElement('span');
    edgeLegend.className = 'cursor-legend';
    edgeLegend.textContent = t('capturePanel.cursorEdgesFormat');
    edgeSec.header.appendChild(edgeLegend);
    if (v.cursorEdges.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'cursor-edge-hint';
      hint.textContent = t(v.cursors.length < 2
        ? 'capturePanel.cursorEdgesEmpty' : 'capturePanel.cursorEdgesNoRows');
      edgeSec.body.appendChild(hint);
    } else {
      const list = div('cursor-edge-list');
      for (const row of v.cursorEdges) {
        const item = div('cursor-edge-row');
        item.dataset.edgeId = String(row.id);
        const a = edgeSideControl(row, 'a', v.cursors,
          (cursorId) => this.cb.onPickCursorEdge(row.id, 'a', cursorId));
        a.el.disabled = locked;
        const mark = document.createElement('span');
        mark.className = 'cursor-dist-mark cursor-edge-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '−';
        const b = edgeSideControl(row, 'b', v.cursors,
          (cursorId) => this.cb.onPickCursorEdge(row.id, 'b', cursorId));
        b.el.disabled = locked;
        const at = document.createElement('span');
        at.className = 'cursor-dist-mark cursor-edge-mark';
        at.setAttribute('aria-hidden', 'true');
        at.textContent = '@';
        const channelOptions: SelectOptionTuple[] = [
          ['', t('capturePanel.cursorEdgesUnset')],
          ...v.cursorEdgeChannels.map((channel): SelectOptionTuple => [String(channel.index), channel.name]),
        ];
        const channel = selectControl(
          `cursor.edge.channel.${row.id}`,
          t('capturePanel.cursorEdgesChannel', { row: row.row }),
          channelOptions,
          row.channel === null ? '' : String(row.channel),
        );
        channel.el.classList.add('cursor-edge-channel');
        channel.disabled = locked;
        channel.addEventListener('change', () => this.cb.onPickCursorEdgeChannel(
          row.id, channel.value === '' ? null : Number(channel.value),
        ));
        const result = document.createElement('span');
        result.className = 'cursor-edge-result';
        result.translate = false;
        result.textContent = row.result;
        const remove = cursorRemoveButton(
          t('capturePanel.cursorEdgesRemove', { row: row.row }),
          () => this.cb.onRemoveCursorEdge(row.id),
        );
        remove.disabled = locked;
        const tail = div('cursor-edge-tail');
        tail.append(result, remove);
        item.append(a.el, mark, b.el, at, channel.el, tail, a.popover, b.popover);
        list.appendChild(item);
      }
      edgeSec.body.appendChild(list);
    }
    const edgeAddRow = div('cursor-edge-add-row');
    edgeAddRow.appendChild(edgeAddButton(
      v.cursorEdges.length >= MAX_CURSOR_EDGE_ROWS || locked,
      () => this.cb.onAddCursorEdge(),
    ));
    edgeSec.body.appendChild(edgeAddRow);
    cursorPage.appendChild(edgeSec.el);

    // ---- advanced test mode + raw USB console
    const advanced = document.createElement('details');
    advanced.className = 'advanced';
    advanced.open = this.advancedOpen;
    advanced.addEventListener('toggle', () => {
      this.advancedOpen = advanced.open;
      this.cb.onTemperatureOpen(advanced.open);
    });
    const summary = document.createElement('summary');
    summary.textContent = t('capturePanel.advanced');
    advanced.appendChild(summary);
    const body = div('advanced-body');

    // Live die temperature (R32_ADC_TEMP, firmware 202610300413+) and the DDR3
    // recalibration pulse. Both are control-endpoint accesses and work during a capture;
    // the temperature poll runs only while this section is open.
    const tempRow = div('temperature-row');
    const tempLabel = document.createElement('span');
    tempLabel.className = 'temperature-label';
    tempLabel.textContent = t('capturePanel.temperature');
    const tempValue = document.createElement('span');
    tempValue.className = 'temperature-value';
    tempValue.textContent = v.temperature ?? '—';
    this.tempValue = tempValue;
    const tempRateOptions: SelectOptionTuple[] = [
      ['1000', t('capturePanel.tempRate1')],
      ['100', t('capturePanel.tempRate10')],
    ];
    const tempRate = selectControl(
      'capture.tempRate', t('capturePanel.tempRate'), tempRateOptions,
      String(v.tempRateMs ?? 1000),
    );
    tempRate.addEventListener('change', () => this.cb.onTemperatureRate(Number(tempRate.value)));
    tempRow.append(tempLabel, tempValue, tempRate.el);
    body.appendChild(tempRow);

    const testModeOptions: SelectOptionTuple[] = [
      ['0', t('capturePanel.testNormal')],
      ['2', t('capturePanel.testSimulator')],
      ['1', t('capturePanel.testUsbMax')],
    ];
    const source = selectControl(
      'capture.testMode',
      t('capturePanel.testMode'),
      testModeOptions,
      String(s.testMode),
    );
    source.disabled = v.running;
    source.addEventListener('change', () =>
      this.cb.onSettings({ ...s, testMode: Number(source.value) as 0 | 1 | 2 }));
    // What the test modes are for (and are not) before the user selects one.
    const sourceRow = div('help-row');
    sourceRow.append(source.el, helpTip(t('capturePanel.testModeHelp')));
    body.appendChild(sourceRow);
    if (s.testMode !== 0) {
      const analogNote = div('panel-note');
      analogNote.textContent = t('capturePanel.testModeAnalog');
      body.appendChild(analogNote);
    }

    // The raw register console can write device registers, so it is a developer tool:
    // hidden unless Settings > Developer tools is on (persisted, off by default).
    if (v.developerTools === true) this.renderUsbConsole(body, v);
    advanced.appendChild(body);
    capture.appendChild(advanced);
  }

  /** The App's temperature poll updates the mounted value without a render. */
  updateTemperature(text: string): void {
    if (this.tempValue?.isConnected) this.tempValue.textContent = text;
  }

  /** The raw USB register console (developer tools only). */
  private renderUsbConsole(body: HTMLElement, v: CapturePanelView): void {
    const consoleLabel = document.createElement('label');
    consoleLabel.className = 'advanced-console-label';
    consoleLabel.textContent = t('capturePanel.usbConsole');
    const output = document.createElement('pre');
    output.className = 'usb-console-output';
    output.translate = false;
    const renderOutput = (): void => {
      output.textContent = this.consoleLines.join('\n');
      output.scrollTop = output.scrollHeight;
    };
    // The seed line is console chrome in the current locale; scrollback after it
    // (echoed commands, device replies) is history and does not retranslate.
    if (this.consoleLines.length === 0) this.consoleLines.push(t('capturePanel.consoleSeed'));
    renderOutput();
    const commandRow = div('usb-console-command');
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = t('capturePanel.usbPlaceholder');
    input.disabled = !v.deviceName || v.running;
    const send = button(t('capturePanel.usbSend'), 'mini');
    send.disabled = input.disabled;
    const execute = async (): Promise<void> => {
      const command = input.value.trim();
      if (!command || send.disabled) return;
      input.value = '';
      input.disabled = true;
      send.disabled = true;
      this.consoleLines.push(`> ${command}`);
      renderOutput();
      try {
        this.consoleLines.push(await this.cb.onUsbControl(command));
      } catch (e) {
        this.consoleLines.push(t('capturePanel.consoleError', {
          detail: formatStatusDetail(statusDetailOf(e)),
        }));
      } finally {
        this.consoleLines = this.consoleLines.slice(-80);
        input.disabled = !v.deviceName || v.running;
        send.disabled = input.disabled;
        renderOutput();
        input.focus();
      }
    };
    send.addEventListener('click', () => void execute());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void execute(); }
    });
    commandRow.append(input, send);
    body.append(consoleLabel, output, commandRow);
    const help = div('panel-note');
    help.textContent = t('capturePanel.usbHelp');
    const warning = div('panel-note error');
    warning.textContent = t('capturePanel.usbWarning');
    body.append(help, warning);
  }
}

/**
 * What one analog group's button does, and which physical input it reads. Derived from
 * the bank geometry and the ADC constants (`channelBanks.ts`), never from a model name:
 * the group's eight D inputs carry the ADC module's output codes, so the signal itself
 * goes to the module's input, not to those pins.
 */
export function analogInputHint(start: number, total: number, gain = ANALOG_GAIN_DEFAULT): string {
  return t('capturePanel.analogEnable', {
    name: `A${start / CHANNEL_BANK_SIZE}`,
    range: channelBankRange(start, total),
    span: `±${formatVoltsNumber(analogHalfRangeV(gain))} V`,
    bits: ADC_RESOLUTION_BITS,
  });
}

export interface AnalogGainCellOptions {
  start: number;
  /** The capture width, for the input hint. */
  total: number;
  gain: number;
  /** Stopping: the control is shown but cannot change. */
  busy: boolean;
  /** The ratio being typed when the panel was rebuilt mid-entry, else null. */
  editing: string | null;
  /** False while the owner detaches the old tree: a blur then is not a commit. */
  live(): boolean;
  /** The text being typed (null when the field closes), kept by the owner. */
  onEditing(text: string | null): void;
  onGain(gain: number): void;
}

export interface AnalogGainCell {
  /** `A0 [×1 ▾] ±16 V ?`: the row's cell in place of the eight D chips. */
  cell: HTMLDivElement;
  /** Under the bank row: says why a typed ratio was rejected (hidden until it is). */
  note: HTMLDivElement;
  /** Focus the ratio field, caret at the end (after a rebuild mid-entry). */
  focusField(): void;
}


/**
 * The rate list: every offered rate stays selectable, and one above the profile's
 * sustainable rate for the width (`advisedHz`) carries "(may exceed bandwidth)" in its
 * label, so the risk shows before the choice. No recommendation marks nothing.
 */
export function samplerateOptions(
  rates: readonly number[], advisedHz: number | undefined,
): SelectOptionTuple[] {
  return rates.map((r) => [String(r), advisedHz !== undefined && r > advisedHz
    ? t('capturePanel.rateOptionOverAdvised', { rate: formatRate(r) })
    : formatRate(r)]);
}

/**
 * One analog group's cell, and its gain declaration (DESIGN §5.2 "Gain is declared, not
 * set"). The gain stage sits on the module and the host can neither read nor set it, so
 * the select only declares the ratio used to convert codes to volts; changing it never
 * restarts a capture. The select holds the profile presets, the current custom ratio
 * when it is not a preset, and "Custom…", which turns the select into a ratio field in
 * place: Enter or leaving the field applies, Esc reverts. A ratio outside the profile's
 * bounds is refused: Enter keeps the field with the declared ratio and the browser's
 * validity bubble (cleared on the next keystroke, not before it can show); leaving the
 * field reverts to the select. Both say why in the note under the row.
 */
export function analogGainCell(o: AnalogGainCellOptions): AnalogGainCell {
  const { start, gain } = o;
  const name = `A${start / CHANNEL_BANK_SIZE}`;
  const cell = div('analog-cell');
  cell.dataset.analogCell = String(start);
  cell.dataset.analogGain = String(gain);
  cell.setAttribute('role', 'group');
  cell.setAttribute('aria-label', t('capturePanel.analogCellLabel', { name }));

  const label = document.createElement('span');
  label.className = 'analog-cell-name';
  label.textContent = name;
  label.title = analogInputHint(start, o.total, gain);
  label.setAttribute('translate', 'no');

  const slot = document.createElement('span');
  slot.className = 'analog-cell-gain';

  const choice = analogGainChoice(gain);
  const options: SelectOptionTuple[] = [
    ...ANALOG_GAIN_PRESETS.map((preset): SelectOptionTuple =>
      [String(preset), formatAnalogGain(preset)]),
    // A declared custom ratio reads as itself, not as "Custom…".
    ...(choice === 'custom' ? [[String(gain), formatAnalogGain(gain)] as SelectOptionTuple] : []),
    ['custom', t('capturePanel.analogGainCustom')],
  ];
  const select = selectControl(
    `capture.analogGain.${start}`, t('capturePanel.analogGain', { name }), options, String(gain),
  );
  select.disabled = o.busy;

  const rangeText = t('capturePanel.analogGainRange', { min: ANALOG_GAIN_MIN, max: ANALOG_GAIN_MAX });
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.className = 'analog-gain-input';
  input.disabled = o.busy;
  input.dataset.analogGainInput = String(start);
  input.title = rangeText;
  input.setAttribute('aria-label',
    `${t('capturePanel.analogGain', { name })}, ${t('capturePanel.analogGainRatio')}`);

  const range = document.createElement('span');
  range.className = 'analog-cell-range';
  range.setAttribute('translate', 'no');
  range.textContent = t('capturePanel.analogCellRange', { range: formatVoltsNumber(analogHalfRangeV(gain)) });

  const tip = helpTip(`${t('capturePanel.analogGainHelp')} ${analogGainReadout(gain)}`);
  tip.dataset.analogGainTip = String(start);

  const note = div('panel-note error');
  note.dataset.analogGainRejected = String(start);
  note.setAttribute('role', 'alert');
  note.hidden = true;
  const reject = (): void => {
    note.textContent = rangeText;
    note.hidden = false;
  };
  const clearReject = (): void => {
    note.hidden = true;
    note.textContent = '';
  };

  let open = false;
  const showSelect = (focus: boolean): void => {
    open = false;
    o.onEditing(null);
    slot.replaceChildren(select.el);
    if (focus) select.el.querySelector<HTMLElement>('.select-trigger')?.focus();
  };
  const showField = (text: string, focus: boolean): void => {
    open = true;
    input.value = text;
    input.setCustomValidity('');
    o.onEditing(text);
    slot.replaceChildren(input);
    if (focus) focusField();
  };
  const focusField = (): void => {
    if (!open) return;
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
  };
  const apply = (how: 'enter' | 'blur'): void => {
    const next = parseAnalogGain(input.value);
    if (next === null) {
      reject();
      if (how === 'blur') {
        showSelect(false);
        return;
      }
      // Keep the message until the next keystroke: clearing it right after
      // reportValidity() would hide the bubble before it shows.
      input.value = String(gain);
      o.onEditing(input.value);
      input.setCustomValidity(rangeText);
      input.reportValidity();
      return;
    }
    clearReject();
    // The owner rebuilds the panel on a change; find the new select by its key so the
    // keyboard stays on the control.
    const scope = cell.closest('.side-page') ?? cell.parentElement;
    showSelect(how === 'enter' && Math.abs(next - gain) < 1e-12);
    if (Math.abs(next - gain) < 1e-12) return;
    o.onGain(next);
    if (how === 'enter' && !cell.isConnected) {
      scope?.querySelector<HTMLElement>(
        `.select-trigger[data-select-key="capture.analogGain.${start}"]`)?.focus();
    }
  };

  select.addEventListener('change', () => {
    clearReject();
    if (select.value === 'custom') {
      // The select keeps showing the declared gain if the entry is abandoned.
      select.value = String(gain);
      showField(String(gain), true);
      return;
    }
    const next = Number(select.value);
    if (isAnalogGain(next) && Math.abs(next - gain) >= 1e-12) o.onGain(next);
  });
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    o.onEditing(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply('enter');
    } else if (event.key === 'Escape') {
      // Esc belongs to the field: it reverts the entry and closes nothing else.
      event.preventDefault();
      event.stopPropagation();
      clearReject();
      showSelect(true);
    }
  });
  input.addEventListener('blur', () => {
    if (!open || !o.live() || !input.isConnected) return;
    apply('blur');
  });

  if (o.editing !== null && !o.busy) showField(o.editing, false);
  else showSelect(false);
  cell.append(label, slot, range, tip);
  return { cell, note, focusField };
}

export interface ThresholdFieldOptions {
  volts: number;
  /** The custom text being typed when the panel was rebuilt, or null. */
  editing: string | null;
  /** False while the owner detaches the old tree, so a removed field's blur is inert. */
  live(): boolean;
  onEditing(text: string | null): void;
  onVolts(volts: number): void;
}

/**
 * The digital threshold: the family presets, the current custom value when it is not a
 * preset, and "Custom…", which turns the select into a number field in place (the gain
 * cell's pattern): Enter or leaving the field applies, Esc reverts. The range is the
 * vref DAC's own span (`thresholdRange`); the entry is kept as typed except for the snap
 * to the DAC grid, and the note under the row reads back the actual voltage. A value
 * outside the span is refused with the range in the browser's validity bubble.
 */
export function thresholdField(o: ThresholdFieldOptions): { el: HTMLElement; focusField(): void } {
  const { volts } = o;
  const range = thresholdRange();
  const slot = div('threshold-field');
  const options: SelectOptionTuple[] = [
    ...THRESHOLD_VOLT_OPTIONS.map((preset): SelectOptionTuple => [String(preset), thresholdOptionLabel(preset)]),
    ...(thresholdChoice(volts) === 'custom'
      ? [[String(volts), t('capturePanel.thresholdVolts', { volts: volts.toFixed(3) })] as SelectOptionTuple]
      : []),
    ['custom', t('capturePanel.thresholdCustom')],
  ];
  const select = selectControl('capture.threshold', t('capturePanel.threshold'), options, String(volts));

  const rangeText = t('capturePanel.thresholdRange', {
    min: range.min.toFixed(3), max: range.max.toFixed(3),
  });
  const field = div('field threshold-custom');
  const label = document.createElement('label');
  label.textContent = t('capturePanel.threshold');
  const input = document.createElement('input');
  input.type = 'number';
  input.inputMode = 'decimal';
  input.min = range.min.toFixed(4);
  input.max = range.max.toFixed(4);
  input.step = 'any';
  input.autocomplete = 'off';
  input.dataset.thresholdInput = '';
  input.id = 'capture-threshold-custom';
  label.htmlFor = input.id;
  input.title = rangeText;
  input.setAttribute('aria-label', `${t('capturePanel.threshold')} (V), ${rangeText}`);
  field.append(label, input);

  let open = false;
  const showSelect = (focus: boolean): void => {
    open = false;
    o.onEditing(null);
    slot.replaceChildren(select.el);
    if (focus) select.el.querySelector<HTMLElement>('.select-trigger')?.focus();
  };
  const focusField = (): void => {
    if (!open) return;
    input.focus();
  };
  const showField = (text: string, focus: boolean): void => {
    open = true;
    input.value = text;
    input.setCustomValidity('');
    o.onEditing(text);
    slot.replaceChildren(field);
    if (focus) focusField();
  };
  const apply = (how: 'enter' | 'blur'): void => {
    const next = parseCustomThreshold(input.value);
    if (next === null) {
      if (how === 'blur') {
        showSelect(false);
        return;
      }
      // Keep the bubble until the next keystroke (see analogGainCell).
      input.setCustomValidity(rangeText);
      input.reportValidity();
      return;
    }
    const scope = slot.closest('.side-page') ?? slot.parentElement;
    const same = Math.abs(next - volts) < 1e-9;
    showSelect(how === 'enter' && same);
    if (same) return;
    o.onVolts(next);
    if (how === 'enter' && !slot.isConnected) {
      scope?.querySelector<HTMLElement>('.select-trigger[data-select-key="capture.threshold"]')?.focus();
    }
  };

  select.addEventListener('change', () => {
    if (select.value === 'custom') {
      select.value = String(volts);
      showField(volts.toFixed(3), true);
      return;
    }
    const next = Number(select.value);
    if (Number.isFinite(next) && Math.abs(next - volts) >= 1e-9) o.onVolts(next);
  });
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    o.onEditing(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      apply('enter');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      showSelect(true);
    }
  });
  input.addEventListener('blur', () => {
    if (!open || !o.live() || !input.isConnected) return;
    apply('blur');
  });

  if (o.editing !== null) showField(o.editing, false);
  else showSelect(false);
  return { el: slot, focusField };
}

/** Bits and volts per code at a gain: `8-bit · 125.5 mV/code` (four significant digits). */
export function analogGainReadout(gain: number): string {
  return t('capturePanel.analogGainReadout', {
    bits: ADC_RESOLUTION_BITS,
    step: String(Number((analogVoltsPerCode(gain) * 1000).toPrecision(4))),
  });
}

/** A voltage magnitude with at most three significant digits: 15, 5, 1.5, 0.15. */
export function formatVoltsNumber(volts: number): string {
  return String(Number(volts.toPrecision(3)));
}

/** The select value for a gain: a preset's own value, else `custom`. */
export function analogGainChoice(gain: number): string {
  return ANALOG_GAIN_PRESETS.some((preset) => Math.abs(preset - gain) < 1e-9)
    ? String(gain) : 'custom';
}

/** A typed custom ratio, or null when it is not a declarable gain. */
export function parseAnalogGain(text: string): number | null {
  const trimmed = text.trim().replace(/^[x×]/i, '').replace(/[x×]$/i, '').replace(',', '.');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return isAnalogGain(value) ? value : null;
}

function analogButton(
  start: number, active: boolean, enabled: boolean, hint: string, onToggle: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'analog-button' + (active ? ' on' : '');
  b.dataset.analogToggle = String(start);
  b.dataset.analogActive = String(active);
  b.textContent = t('capturePanel.analog');
  b.disabled = !enabled;
  b.title = hint;
  b.setAttribute('aria-label', hint);
  b.setAttribute('aria-pressed', String(active));
  b.addEventListener('click', onToggle);
  return b;
}

function cursorCellText(row: CursorRowView): string {
  return `${row.time}/${formatCount(row.sample)}`;
}

function cursorRemoveButton(label: string, onRemove: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'analyzer-act analyzer-act--remove';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(cursorRemoveIcon());
  b.addEventListener('click', onRemove);
  return b;
}

function cursorRemoveIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of ['M18 6 6 18', 'm6 6 12 12']) appendIconPath(icon, d);
  return icon;
}

export function cursorDistanceSideId(rowId: number, side: DistanceSide): string {
  return `cursor-dist-${rowId}-${side}`;
}

function distanceSideControl(
  row: CursorDistanceRowView, side: DistanceSide, cursors: readonly CursorRowView[],
  onPick: (cursorId: number) => void,
): { el: HTMLButtonElement; popover: HTMLDivElement } {
  const pick = side === 'a' ? row.a : row.b;
  const id = cursorDistanceSideId(row.id, side);
  const menuId = `${id}-menu`;
  const el = document.createElement('button');
  el.type = 'button';
  el.id = id;
  el.className = 'cursor-idx cursor-dist-side' + (pick === null ? ' is-unset' : '');
  el.dataset.distanceId = String(row.id);
  el.dataset.side = side;
  el.textContent = pick === null ? '–' : pick.label;
  if (pick !== null) {
    el.style.background = pick.color;
    el.style.color = chipForeground(pick.color);
  }
  el.style.setProperty('anchor-name', `--${id}`);
  el.setAttribute('popovertarget', menuId);
  const action = t(side === 'a' ? 'capturePanel.cursorDistanceStart' : 'capturePanel.cursorDistanceEnd',
    { row: row.row });
  const name = `${action}: ${pick === null ? t('capturePanel.cursorDistanceUnset') : pick.label}`;
  el.title = name;
  el.setAttribute('aria-label', name);
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ') e.stopPropagation();
  });

  const popover = document.createElement('div');
  popover.id = menuId;
  popover.className = 'cursor-dist-popover';
  popover.setAttribute('popover', 'auto');
  popover.style.setProperty('position-anchor', `--${id}`);
  if (cursors.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'cursor-dist-popover-empty';
    empty.textContent = t('capturePanel.cursorEmpty');
    popover.appendChild(empty);
  } else {
    for (const cursor of cursors) {
      const current = pick !== null && pick.id === cursor.id;
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.className = 'cursor-dist-choice' + (current ? ' is-current' : '');
      choice.dataset.cursorId = String(cursor.id);
      const mark = document.createElement('span');
      mark.className = 'cursor-dist-choice-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = current ? '✓' : '';
      const chip = document.createElement('span');
      chip.className = 'cursor-idx';
      chip.textContent = cursor.label;
      chip.style.background = cursor.color;
      chip.style.color = chipForeground(cursor.color);
      const pos = document.createElement('span');
      pos.className = 'cursor-pos';
      pos.translate = false;
      pos.textContent = cursorCellText(cursor);
      choice.append(mark, chip, pos);
      choice.addEventListener('click', () => onPick(cursor.id));
      popover.appendChild(choice);
    }
  }
  popover.addEventListener('toggle', () => {
    if (popover.matches(':popover-open')) return;
    if (el.isConnected) el.focus();
  });
  return { el, popover };
}

function distanceAddButton(disabled: boolean, onAdd: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'analyzer-act cursor-dist-add';
  b.disabled = disabled;
  const label = t('capturePanel.cursorDistanceAdd');
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(distanceAddIcon());
  b.addEventListener('click', onAdd);
  return b;
}

function distanceAddIcon(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 5v14', 'M5 12h14']) appendIconPath(icon, d);
  return icon;
}

export function cursorEdgeSideId(rowId: number, side: DistanceSide): string {
  return `cursor-edge-${rowId}-${side}`;
}

function edgeSideControl(
  row: CursorEdgeRowView, side: DistanceSide, cursors: readonly CursorRowView[],
  onPick: (cursorId: number) => void,
): { el: HTMLButtonElement; popover: HTMLDivElement } {
  const pick = side === 'a' ? row.a : row.b;
  const id = cursorEdgeSideId(row.id, side);
  const menuId = `${id}-menu`;
  const el = document.createElement('button');
  el.type = 'button';
  el.id = id;
  el.className = 'cursor-idx cursor-dist-side cursor-edge-side' + (pick === null ? ' is-unset' : '');
  el.dataset.edgeId = String(row.id);
  el.dataset.side = side;
  el.textContent = pick === null ? '–' : pick.label;
  if (pick !== null) {
    el.style.background = pick.color;
    el.style.color = chipForeground(pick.color);
  }
  el.style.setProperty('anchor-name', `--${id}`);
  el.setAttribute('popovertarget', menuId);
  const action = t(side === 'a' ? 'capturePanel.cursorEdgesStart' : 'capturePanel.cursorEdgesEnd',
    { row: row.row });
  const name = `${action}: ${pick === null ? t('capturePanel.cursorDistanceUnset') : pick.label}`;
  el.title = name;
  el.setAttribute('aria-label', name);
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ') e.stopPropagation();
  });

  const popover = document.createElement('div');
  popover.id = menuId;
  popover.className = 'cursor-dist-popover cursor-edge-popover';
  popover.setAttribute('popover', 'auto');
  popover.style.setProperty('position-anchor', `--${id}`);
  if (cursors.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'cursor-dist-popover-empty';
    empty.textContent = t('capturePanel.cursorEmpty');
    popover.appendChild(empty);
  } else {
    for (const cursor of cursors) {
      const current = pick !== null && pick.id === cursor.id;
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.className = 'cursor-dist-choice cursor-edge-choice' + (current ? ' is-current' : '');
      choice.dataset.cursorId = String(cursor.id);
      const mark = document.createElement('span');
      mark.className = 'cursor-dist-choice-mark';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = current ? '✓' : '';
      const chip = document.createElement('span');
      chip.className = 'cursor-idx';
      chip.textContent = cursor.label;
      chip.style.background = cursor.color;
      chip.style.color = chipForeground(cursor.color);
      const pos = document.createElement('span');
      pos.className = 'cursor-pos';
      pos.translate = false;
      pos.textContent = cursorCellText(cursor);
      choice.append(mark, chip, pos);
      choice.addEventListener('click', () => onPick(cursor.id));
      popover.appendChild(choice);
    }
  }
  popover.addEventListener('toggle', () => {
    if (popover.matches(':popover-open')) return;
    if (el.isConnected) el.focus();
  });
  return { el, popover };
}

function edgeAddButton(disabled: boolean, onAdd: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'analyzer-act cursor-edge-add';
  b.disabled = disabled;
  const label = t('capturePanel.cursorEdgesAdd');
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(distanceAddIcon());
  b.addEventListener('click', onAdd);
  return b;
}

function appendIconPath(icon: SVGSVGElement, d: string): void {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  icon.appendChild(path);
}

function digitalConditionLabel(kind: 'level' | 'rising' | 'falling' | 'edge', level?: number): string {
  return kind === 'level' ? t(level ? 'channels.triggerHigh' : 'channels.triggerLow')
    : t(kind === 'rising' ? 'trigger.rising'
      : kind === 'falling' ? 'trigger.falling' : 'trigger.anyEdge');
}

export function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

export function button(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  return b;
}

export function labelled(text: string, el: HTMLElement): HTMLDivElement {
  const d = div('field');
  const l = document.createElement('label');
  l.textContent = text;
  d.append(l, el);
  return d;
}

export function section(title: string): { el: HTMLDivElement; header: HTMLDivElement; body: HTMLDivElement } {
  const el = div('panel-section');
  const header = div('panel-section-head');
  const h = document.createElement('span');
  h.textContent = title;
  header.appendChild(h);
  const body = div('panel-section-body');
  el.append(header, body);
  return { el, header, body };
}
