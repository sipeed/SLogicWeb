// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
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
  formatBytes, formatCount, formatDuration, formatRate, formatStatusDetail, statusDetailOf,
} from './format.js';
import {
  CHANNEL_BANK_SIZE, analogSamplerates, analogTriggerVolts, channelBankIndices, channelBankRange, channelBankStarts,
  lockedChannelBanks,
} from './channelBanks.js';
import { t } from './i18n.js';
import { chipForeground } from './metrics.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import type { BusViewState } from './busView.js';
import type { CaptureSettings, ChannelState } from './state.js';
import {
  clampLoopSamples, LOOP_WINDOW_QUANTUM, maxLoopSamples, THRESHOLD_VOLT_OPTIONS,
} from './state.js';
import {
  maxCaptureSeconds, MIN_CAPTURE_SECONDS, REPEAT_INTERVAL_SECONDS,
} from './captureTime.js';
import { captureAbortDetail, type CaptureAbortCause } from './captureAbort.js';
import { capturePostTriggerSamples } from './capturePolicy.js';
import { MAX_CURSOR_DISTANCE_ROWS, type DistanceSide } from './cursorDistance.js';
import { MAX_CURSOR_EDGE_ROWS } from './cursorEdges.js';
import { acquisitionTimeControl } from './timeControl.js';
import { triggerPanelNotes, triggerStatusNote } from './triggerStatus.js';

export interface CapturePanelCallbacks {
  onSettings(next: CaptureSettings): void;
  onToggleChannel(index: number, enabled: boolean): void;
  /** Turn the bank's ADC-analog reading on or off; the button is its only control. */
  onToggleAnalog(start: number): void;
  onChannelWidth(channels: number): void;
  onUsbControl(command: string): Promise<string>;
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
  /** Analog groups (A0–A3) the current device and width expose; 0 disables the buttons. */
  analogGroups: number;
  deviceName: string | null;
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
    /** Finite sample target; null for Unlimited and Loop captures. */
    targetSamples: number | null } | null;
  maxSamplerateHz: Readonly<Record<number, number>>;
  /** Per-width rate the board sustains below that ceiling (`Device.recommendedSamplerateHz`). */
  recommendedSamplerateHz?: Readonly<Record<number, number>>;
  triggerState: 'off' | 'waiting' | 'triggered' | 'not-found';
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
  'settingsArmed' | 'repeatMissed' | 'triggerPreObtainedSec'> & { mode: CaptureSettings['mode'] };

export class CapturePanel {
  private advancedOpen = false;
  private consoleLines: string[] = [];
  private liveNote: HTMLElement | null = null;
  private lostNote: HTMLElement | null = null;
  /** The dynamic arming/pending/memory notes, refreshed without a panel rebuild. */
  private triggerNotesEl: HTMLElement | null = null;
  /** The "Armed: ..." summary, hidden once the acquisition no longer just waits. */
  private triggerArmedEl: HTMLElement | null = null;
  private droppedNote: HTMLElement | null = null;
  private statusDetail: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressValue: HTMLElement | null = null;
  private triggerStatusEl: HTMLElement | null = null;
  private loopMatcherEl: HTMLElement | null = null;
  private loopSwapEl: HTMLElement | null = null;

  constructor(
    private readonly host: CapturePanelHost,
    private readonly cb: CapturePanelCallbacks,
  ) {}

  private *roots(): Generator<HTMLElement, void, undefined> {
    yield this.host.capture;
    yield this.host.cursors;
  }

  updateProgress(progress: NonNullable<CapturePanelView['progress']>): void {
    if (!this.liveNote) return;
    this.fillProgress(progress);
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
      this.droppedNote!.textContent = t('capturePanel.loopWindow', {
        kept: progress.kept.toLocaleString(),
        limit: progress.limit.toLocaleString(),
        dropped: progress.dropped.toLocaleString(),
      });
    }
    const target = progress.targetSamples;
    if (this.statusDetail) {
      this.statusDetail.textContent = target !== null
        ? t('capturePanel.statusFiniteDetail')
        : progress.limit > 0
          ? t('capturePanel.statusLoopDetail')
          : t('capturePanel.statusUnlimitedDetail');
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
    });
    if (notes.arming) {
      const arming = div('panel-note live');
      arming.textContent = t('capturePanel.armingTrigger');
      host.appendChild(arming);
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
    };
  }

  private fillTriggerStatus(v: TriggerStatusView): void {
    const host = this.triggerStatusEl;
    if (!host) return;
    host.replaceChildren();
    const note = triggerStatusNote(v);
    if (note === 'waiting') {
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
      swap.textContent = t('capturePanel.loopSwap', {
        step: formatCount(metrics.anchorStepSamples),
        block: formatCount(metrics.blockSamples),
        refresh: formatRate(metrics.refreshHz),
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
    capture.replaceChildren();
    cursorPage.replaceChildren();
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
        }
        b.addEventListener('click', () => this.cb.onChannelWidth(n));
        widths.appendChild(b);
      }
      chSec.header.appendChild(widths);
    }

    const banks = div('channel-banks');
    const activeBanks = lockedChannelBanks(v.buses, v.channels.length);
    const analogBusy = v.stopping;
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
        const cell = div('analog-cell');
        cell.dataset.analogCell = String(start);
        cell.textContent = t('capturePanel.analogCell', { name });
        cell.title = t('capturePanel.analogEnable', { range, name });
        bank.appendChild(cell);
      } else {
        const grid = div('chip-grid channel-bank-grid');
        grid.dataset.bankGrid = String(start);
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', range);
        for (const index of indices) {
          const c = v.channels[index]!;
          const chip = document.createElement('button');
          chip.className = 'chip' + (c.enabled ? ' on' : '');
          chip.textContent = `D${c.index}`;
          chip.title = c.name;
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
        }
        bank.appendChild(grid);
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
            : t('capturePanel.analogEnable', { range, name });
      bank.appendChild(analogButton(start, active, usable && !analogBusy, hint,
        () => this.cb.onToggleAnalog(start)));
      banks.appendChild(bank);
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
    const rateOptions: SelectOptionTuple[] = selectable
      .map((r) => [String(r), formatRate(r)]);
    const rate = selectControl(
      'capture.sampleRate',
      t('capturePanel.sampleRate'),
      rateOptions,
      String(s.samplerate),
    );
    rate.addEventListener('change', () =>
      this.cb.onSettings({ ...s, samplerate: Number(rate.value) }));
    rowRT.appendChild(rate.el);

    const thresholdOptions: SelectOptionTuple[] = THRESHOLD_VOLT_OPTIONS.map((t) => [String(t), `${t} V`]);
    const th = selectControl(
      'capture.threshold',
      t('capturePanel.threshold'),
      thresholdOptions,
      String(nearest(THRESHOLD_VOLT_OPTIONS, s.thresholdVolts)),
    );
    th.addEventListener('change', () =>
      this.cb.onSettings({ ...s, thresholdVolts: Number(th.value) }));
    rowRT.appendChild(th.el);
    chSec.body.appendChild(rowRT);

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
              ? v.progress.limit > 0
                ? t('capturePanel.statusLoopDetail')
                : t('capturePanel.statusUnlimitedDetail')
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
        ...(s.mode === 'single' ? {
          unlimited: {
            active: s.singleUnlimited,
            label: t('capturePanel.unlimited'),
            onSelect: () => this.cb.onSettings({ ...s, singleUnlimited: true }),
          },
        } : {}),
        onValue: (seconds) => {
          this.cb.onSettings({ ...s, seconds, singleUnlimited: false });
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
      if (s.mode === 'single' && s.singleUnlimited) {
        limit.textContent = t('capturePanel.singleUnlimitedNote');
      } else if (s.mode === 'single') {
        limit.textContent = t('capturePanel.singleFiniteNote', {
          max: formatDuration(maxSeconds),
        });
      } else {
        limit.textContent = t('capturePanel.repeatFiniteNote', {
          max: formatDuration(maxSeconds),
        });
      }
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
    // Always visible, even while the section body is collapsed: this is the note that
    // tells a first-time user what the checkbox does, why conditions can be stored
    // without being armed, and why configuring a condition turns it on by itself.
    const enableHelp = div('panel-note');
    enableHelp.textContent = t('capturePanel.triggerEnableHelp');
    enableHelp.style.marginTop = '8px';
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
            ? t('capturePanel.analogEnable', {
              range: channelBankRange(0, v.channels.length),
              name: 'A0',
            })
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
      triggerSec.body.appendChild(sourceSeg);
      // What the source choice means and how Single/Repeat differ from Loop; the enable
      // note above stays visible while this body is collapsed.
      const sourceHelp = div('panel-note');
      sourceHelp.textContent = t('capturePanel.triggerSourceHelp');
      triggerSec.body.appendChild(sourceHelp);
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
              `${analogTriggerVolts(setting.kind, setting.volts).toFixed(4)} V`;
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
      triggerSec.body.appendChild(pre.el);
      if (s.mode === 'loop' && s.triggerEnableMask) {
        // In a loop the percentage is the trigger's horizontal position, not only how
        // much history is kept. The analog note describes the local roll; the digital
        // note must not claim re-anchoring, because a digital lock is one-shot. A running
        // capture whose scanner was torn down still follows its configured source for
        // this explanation.
        const analogConfigured = s.triggerSource === 'analog' &&
          analogBanks.some((start) => s.analogTriggers?.[start] !== undefined);
        const analog = v.triggerAnalogRolling || analogConfigured;
        const loopNote = div('panel-note');
        loopNote.textContent = t(analog
          ? 'capturePanel.loopTriggerNote' : 'capturePanel.loopTriggerNoteDigital');
        triggerSec.body.appendChild(loopNote);
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
              ` ${analogTriggerVolts(setting.kind, setting.volts).toFixed(4)} V`;
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
      this.fillProgress(v.progress);
    } else {
      this.liveNote = null;
      this.lostNote = null;
      this.droppedNote = null;
    }
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
        const mark = document.createElement('span');
        mark.className = 'cursor-dist-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '−';
        const b = distanceSideControl(row, 'b', v.cursors,
          (cursorId) => this.cb.onPickCursorDistance(row.id, 'b', cursorId));
        const delta = document.createElement('span');
        delta.className = 'cursor-dist-delta';
        delta.translate = false;
        delta.textContent = row.delta;
        const remove = cursorRemoveButton(
          t('capturePanel.cursorDistanceRemove', { row: row.row }),
          () => this.cb.onRemoveCursorDistance(row.id),
        );
        const tail = div('cursor-dist-tail');
        tail.append(delta, remove);
        item.append(a.el, mark, b.el, tail, a.popover, b.popover);
        list.appendChild(item);
      }
      distanceSec.body.appendChild(list);
    }
    const addRow = div('cursor-dist-add-row');
    addRow.appendChild(distanceAddButton(
      v.cursorDistances.length >= MAX_CURSOR_DISTANCE_ROWS,
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
        const mark = document.createElement('span');
        mark.className = 'cursor-dist-mark cursor-edge-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = '−';
        const b = edgeSideControl(row, 'b', v.cursors,
          (cursorId) => this.cb.onPickCursorEdge(row.id, 'b', cursorId));
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
        const tail = div('cursor-edge-tail');
        tail.append(result, remove);
        item.append(a.el, mark, b.el, at, channel.el, tail, a.popover, b.popover);
        list.appendChild(item);
      }
      edgeSec.body.appendChild(list);
    }
    const edgeAddRow = div('cursor-edge-add-row');
    edgeAddRow.appendChild(edgeAddButton(
      v.cursorEdges.length >= MAX_CURSOR_EDGE_ROWS,
      () => this.cb.onAddCursorEdge(),
    ));
    edgeSec.body.appendChild(edgeAddRow);
    cursorPage.appendChild(edgeSec.el);

    // ---- advanced test mode + raw USB console
    const advanced = document.createElement('details');
    advanced.className = 'advanced';
    advanced.open = this.advancedOpen;
    advanced.addEventListener('toggle', () => { this.advancedOpen = advanced.open; });
    const summary = document.createElement('summary');
    summary.textContent = t('capturePanel.advanced');
    advanced.appendChild(summary);
    const body = div('advanced-body');

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
    body.appendChild(source.el);
    // What the test modes are for (and are not) before the user selects one.
    const testModeHelp = div('panel-note');
    testModeHelp.textContent = t('capturePanel.testModeHelp');
    body.appendChild(testModeHelp);
    if (s.testMode !== 0) {
      const analogNote = div('panel-note');
      analogNote.textContent = t('capturePanel.testModeAnalog');
      body.appendChild(analogNote);
    }

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
    body.appendChild(help);
    advanced.appendChild(body);
    capture.appendChild(advanced);
  }
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

function nearest(list: readonly number[], v: number): number {
  return list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), list[0]!);
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
