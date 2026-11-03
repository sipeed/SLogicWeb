// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The capture panel - the right-hand device panel, modelled on
 * a conventional capture-settings panel.
 *
 * Layout: a device header with the product name, a "Digital"
 * section with a channel-width selector and rows of eight channel chips filled with the
 * channel colour when enabled, each full row preceded by its oscilloscope button, a
 * sample-rate dropdown and a voltage dropdown side by side, then a segmented capture-mode
 * control.
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
  formatCount, formatDuration, formatRate, formatStatusDetail, statusDetailOf,
} from './format.js';
import {
  CHANNEL_BANK_SIZE, channelBankIndices, channelBankRange, channelBankStarts, lockedChannelBanks,
} from './channelBanks.js';
import { t } from './i18n.js';
import { chipForeground } from './metrics.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import type { BusViewState } from './busView.js';
import type { CaptureSettings, ChannelState } from './state.js';
import {
  clampLoopSamples, LOOP_WINDOW_QUANTUM, maxLoopSamples, THRESHOLD_VOLT_OPTIONS,
} from './state.js';
import { captureSecondsFromTime, maxCaptureSeconds, MIN_CAPTURE_SECONDS,
  REPEAT_INTERVAL_SECONDS, repeatIntervalSecondsFromTime,
} from './captureTime.js';
import { capturePostTriggerSamples } from './capturePolicy.js';
import { MAX_CURSOR_DISTANCE_ROWS, type DistanceSide } from './cursorDistance.js';
import { acquisitionTimeControl } from './timeControl.js';
import { DEFAULT_TIME_UNIT, maxTimeValue, timeUnitForRange, type TimeUnit } from './timeUnits.js';
import {
  DEFAULT_LOOP_TIME_UNIT, loopSamplesFromTime, type LoopTimeUnit,
} from './loopTime.js';

export interface CapturePanelCallbacks {
  onSettings(next: CaptureSettings): void;
  onToggleChannel(index: number, enabled: boolean): void;
  onOpenBank(start: number): void;
  onChannelWidth(channels: number): void;
  onUsbControl(command: string): Promise<string>;
  onRemoveCursor(id: number): void;
  onFocusCursor(id: number): void;
  onAddCursorDistance(): void;
  onRemoveCursorDistance(rowId: number): void;
  onPickCursorDistance(rowId: number, side: DistanceSide, cursorId: number): void;
}

export type CapturePanelState = 'ready' | 'capturing' | 'stopping' | 'waiting' | 'completed';

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

export interface CapturePanelView {
  settings: CaptureSettings;
  channels: readonly ChannelState[];
  widthOptions: readonly number[];
  buses: readonly BusViewState[];
  deviceName: string | null;
  running: boolean;
  stopping: boolean;
  repeatPending: boolean;
  captureState: CapturePanelState;
  result: { samples: number; seconds: number } | null;
  /** Non-null while a capture is streaming. */
  progress: { seconds: number; samples: number; bytes: number; lost: number; dropped: number;
    /** Retained length (`store.length`) and the loop limit; the limit is 0 outside loop mode. */
    kept: number; limit: number;
    /** Finite sample target; null for Unlimited and Loop captures. */
    targetSamples: number | null } | null;
  maxSamplerateHz: Readonly<Record<number, number>>;
  triggerState: 'off' | 'waiting' | 'triggered' | 'not-found';
  cursors: readonly CursorRowView[];
  cursorDistances: readonly CursorDistanceRowView[];
}

export class CapturePanel {
  private advancedOpen = false;
  private consoleLines: string[] = [];
  private liveNote: HTMLElement | null = null;
  private lostNote: HTMLElement | null = null;
  private droppedNote: HTMLElement | null = null;
  private statusDetail: HTMLElement | null = null;
  private progressEl: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressValue: HTMLElement | null = null;
  private captureTimeUnit: TimeUnit = DEFAULT_TIME_UNIT;
  private repeatIntervalUnit: TimeUnit = DEFAULT_TIME_UNIT;
  private loopTimeUnit: LoopTimeUnit = DEFAULT_LOOP_TIME_UNIT;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: CapturePanelCallbacks,
  ) {}

  updateProgress(progress: NonNullable<CapturePanelView['progress']>): void {
    if (!this.liveNote) return;
    this.fillProgress(progress);
  }

  updateCursorDistances(rows: readonly CursorDistanceRowView[]): void {
    const byId = new Map<number, CursorDistanceRowView>();
    for (const row of rows) byId.set(row.id, row);
    for (const item of this.root.querySelectorAll<HTMLElement>('.cursor-dist-row')) {
      const row = byId.get(Number(item.dataset.distanceId));
      if (row === undefined) continue;
      const delta = item.querySelector<HTMLElement>('.cursor-dist-delta');
      if (delta === null) continue;
      delta.textContent = row.delta;
    }
  }

  updateCursors(rows: readonly CursorRowView[]): void {
    const byId = new Map<number, CursorRowView>();
    for (const row of rows) byId.set(row.id, row);
    for (const item of this.root.querySelectorAll<HTMLElement>('.cursor-row')) {
      const row = byId.get(Number(item.dataset.cursorId));
      if (row === undefined) continue;
      const pos = item.querySelector<HTMLElement>('.cursor-pos');
      if (pos === null) continue;
      pos.textContent = cursorCellText(row);
    }
  }

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

  render(v: CapturePanelView): void {
    const s = v.settings;
    this.root.replaceChildren();
    this.statusDetail = null;
    this.progressEl = null;
    this.progressBar = null;
    this.progressValue = null;

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
        b.disabled = v.running || v.stopping;
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
    for (const start of channelBankStarts(v.channels.length)) {
      const indices = channelBankIndices(start, v.channels.length);
      const range = channelBankRange(start, v.channels.length);
      const locked = activeBanks.has(start);
      const bank = div('channel-bank');
      bank.dataset.bankStart = String(start);
      if (indices.length === CHANNEL_BANK_SIZE) {
        bank.appendChild(oscilloscopeButton(start, activeBanks.has(start), range,
          () => this.cb.onOpenBank(start)));
        bank.appendChild(div('channel-bank-sep'));
      }

      const grid = div('chip-grid channel-bank-grid');
      grid.dataset.bankGrid = String(start);
      grid.dataset.adcLocked = String(locked);
      grid.setAttribute('role', 'group');
      grid.setAttribute('aria-label', range);
      for (const index of indices) {
        const c = v.channels[index]!;
        const chip = document.createElement('button');
        chip.className = 'chip' + (c.enabled ? ' on' : '') + (locked ? ' adc-locked' : '');
        chip.textContent = `D${c.index}`;
        chip.title = locked ? t('capturePanel.channelLocked', { name: c.name, range }) : c.name;
        chip.dataset.channel = String(c.index);
        chip.dataset.adcLocked = String(locked);
        chip.disabled = locked;
        chip.setAttribute('aria-pressed', String(c.enabled));
        if (locked) chip.setAttribute('aria-label', chip.title);
        if (c.enabled) {
          chip.style.background = c.color;
          chip.style.color = chipForeground(c.color);
        } else {
          chip.style.borderColor = c.color;
        }
        chip.addEventListener('click', () => this.cb.onToggleChannel(c.index, !c.enabled));
        grid.appendChild(chip);
      }
      if (locked) {
        const overlay = document.createElement('span');
        overlay.className = 'adc-channel-overlay';
        overlay.dataset.adcOverlay = String(start);
        const label = document.createElement('span');
        label.className = 'adc-channel-overlay-label';
        label.textContent = t('capturePanel.oscilloscopeActive');
        overlay.appendChild(label);
        grid.appendChild(overlay);
      }
      bank.append(grid);
      banks.appendChild(bank);
    }
    chSec.body.appendChild(banks);

    // ---- rate + threshold
    const rowRT = div('field-row');
    const ceiling = v.maxSamplerateHz[s.channels] ?? 200e6;
    const rateOptions: SelectOptionTuple[] = SAMPLERATES_HZ
      .filter((r) => r <= ceiling)
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

    const code = vrefCode(s.thresholdVolts);
    const note = div('panel-note');
    note.textContent = t('capturePanel.dacNote', {
      code,
      volts: vrefVolts(code).toFixed(3),
      channels: s.channels,
      rate: formatRate(ceiling),
    });
    chSec.body.appendChild(note);
    this.root.appendChild(chSec.el);

    // ---- mode
    const modeSec = section(t('capturePanel.capture'));
    const modeLocked = v.running || v.stopping || v.repeatPending;
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

    const badgeKeys = {
      ready: 'capturePanel.statusReady',
      capturing: 'capturePanel.statusCapturing',
      stopping: 'capturePanel.statusStopping',
      waiting: 'capturePanel.statusWaiting',
      completed: 'capturePanel.statusCompleted',
    } as const;
    const badge = document.createElement('span');
    badge.className = 'capture-badge'
      + (v.captureState === 'capturing' ? ' live' : '')
      + (v.captureState === 'waiting' ? ' waiting' : '')
      + (v.captureState === 'stopping' ? ' stopping' : '');
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
      this.captureTimeUnit = timeUnitForRange(this.captureTimeUnit, MIN_CAPTURE_SECONDS, maxSeconds) ?? 'us';
      const duration = acquisitionTimeControl({
        key: 'capture.duration',
        label: t('capturePanel.duration'),
        unitLabel: t('capturePanel.timeUnit'),
        unit: this.captureTimeUnit,
        seconds: s.seconds,
        minSeconds: MIN_CAPTURE_SECONDS,
        maxSeconds,
        disabled: modeLocked,
        ...(s.mode === 'single' ? {
          unlimited: {
            active: s.singleUnlimited,
            label: t('capturePanel.unlimited'),
            onSelect: () => this.cb.onSettings({ ...s, singleUnlimited: true }),
          },
        } : {}),
        onValue: (value, unit) => {
          const seconds = captureSecondsFromTime(value, unit, s.samplerate);
          if (seconds !== null) this.cb.onSettings({ ...s, seconds, singleUnlimited: false });
        },
        onUnit: (unit, value) => {
          this.captureTimeUnit = unit;
          if (s.mode === 'single' && s.singleUnlimited) {
            this.cb.onSettings({ ...s });
            return;
          }
          if (value === null) return;
          const seconds = captureSecondsFromTime(value, unit, s.samplerate);
          if (seconds !== null) this.cb.onSettings({ ...s, seconds });
        },
      });
      modeSec.body.appendChild(duration.el);
      if (s.mode === 'repeat') {
        this.repeatIntervalUnit = timeUnitForRange(
          this.repeatIntervalUnit, REPEAT_INTERVAL_SECONDS.min, REPEAT_INTERVAL_SECONDS.max,
        ) ?? 'us';
        const interval = acquisitionTimeControl({
          key: 'capture.repeatInterval',
          label: t('capturePanel.repeatInterval'),
          unitLabel: t('capturePanel.timeUnit'),
          unit: this.repeatIntervalUnit,
          seconds: s.repeatIntervalSeconds,
          minSeconds: REPEAT_INTERVAL_SECONDS.min,
          maxSeconds: REPEAT_INTERVAL_SECONDS.max,
          disabled: modeLocked,
          onValue: (value, unit) => {
            const seconds = repeatIntervalSecondsFromTime(value, unit);
            if (seconds !== null) this.cb.onSettings({ ...s, repeatIntervalSeconds: seconds });
          },
          onUnit: (unit, value) => {
            this.repeatIntervalUnit = unit;
            if (value === null) return;
            const seconds = repeatIntervalSecondsFromTime(value, unit);
            if (seconds !== null) this.cb.onSettings({ ...s, repeatIntervalSeconds: seconds });
          },
        });
        modeSec.body.appendChild(interval.el);
      }
    } else {
      const maxSamples = maxLoopSamples(s.channels);
      const minSeconds = LOOP_WINDOW_QUANTUM / s.samplerate;
      const maxWindowSeconds = maxSamples / s.samplerate;
      this.loopTimeUnit = timeUnitForRange(this.loopTimeUnit, minSeconds, maxWindowSeconds) ?? 'us';
      const windowControl = acquisitionTimeControl({
        key: 'capture.loopWindow',
        label: t('capturePanel.loopRetention'),
        unitLabel: t('capturePanel.timeUnit'),
        unit: this.loopTimeUnit,
        seconds: clampLoopSamples(s.loopSamples, s.channels) / s.samplerate,
        minSeconds,
        maxSeconds: maxWindowSeconds,
        disabled: modeLocked,
        onValue: (value, unit) => {
          const samples = loopSamplesFromTime(value, unit, s.samplerate, s.channels);
          if (samples !== null) this.cb.onSettings({ ...s, loopSamples: samples });
        },
        onUnit: (unit, value) => {
          this.loopTimeUnit = unit;
          if (value === null) return;
          const samples = loopSamplesFromTime(value, unit, s.samplerate, s.channels);
          if (samples !== null) this.cb.onSettings({ ...s, loopSamples: samples });
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
      const finiteMax = maxTimeValue(maxSeconds, this.captureTimeUnit);
      if (s.mode === 'single' && s.singleUnlimited) {
        limit.textContent = t('capturePanel.singleUnlimitedNote');
      } else if (s.mode === 'single') {
        limit.textContent = t('capturePanel.singleFiniteNote', {
          max: finiteMax, unit: this.captureTimeUnit,
        });
      } else {
        limit.textContent = t('capturePanel.repeatFiniteNote', {
          max: finiteMax, unit: this.captureTimeUnit,
        });
      }
    }
    modeSec.body.appendChild(limit);

    const triggerSec = section(t('capturePanel.softwareTrigger'));
    const mask = document.createElement('input');
    mask.type = 'checkbox'; mask.checked = s.triggerEnableMask; mask.disabled = v.running || v.stopping;
    mask.title = t('capturePanel.enableTrigger');
    mask.setAttribute('aria-label', mask.title);
    triggerSec.header.appendChild(mask);
    mask.addEventListener('change', () => this.cb.onSettings({ ...s, triggerEnableMask: mask.checked }));
    triggerSec.body.hidden = !s.triggerEnableMask;
    if (s.triggerEnableMask) {
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

      // The one mistake this section invites: enabling the trigger and never picking a
      // condition, which silently arms nothing. Say what is armed, or what is missing.
      const armed = div('panel-note');
      if (s.triggerConditions.length === 0) {
        armed.classList.add('error');
        armed.textContent = t('capturePanel.noCondition');
      } else {
        const what = s.triggerConditions
          .map((c) => `D${c.channel} ${c.kind === 'level'
            ? t(c.level ? 'capturePanel.condHigh' : 'capturePanel.condLow')
            : t(c.kind === 'rising' ? 'capturePanel.condRising'
              : c.kind === 'falling' ? 'capturePanel.condFalling' : 'capturePanel.condEdge')}`)
          .join(t('capturePanel.condJoiner'));
        // The *effective* pre-trigger window, with the same clamps startCapture
        // applies: percent of the post-trigger budget (of the loop window in loop
        // mode), capped by the 64 MiB retained prefix. Promising the raw percentage
        // would overstate it exactly when the cap bites (e.g. 50% of 1 s at
        // 16ch/200M is capped at ~167 ms).
        const post = capturePostTriggerSamples(s);
        const pre = Math.min(
          Math.max(0, post - 1),
          Math.max(0, Math.floor(post * s.preTriggerPercent / 100)),
          Math.floor(MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / bytesPerSampleForChannels(s.channels)),
        );
        const capped = pre < Math.floor(post * s.preTriggerPercent / 100);
        armed.textContent = capped
          ? t('capturePanel.armedCapped', {
            what,
            duration: formatDuration(pre / s.samplerate),
            megabytes: MAX_SOFTWARE_TRIGGER_PREFIX_BYTES / 1048576,
          })
          : t('capturePanel.armed', {
            what,
            duration: formatDuration(pre / s.samplerate),
          });
      }
      triggerSec.body.appendChild(armed);

      if (v.triggerState === 'waiting') {
        const wait = div('panel-note live');
        wait.textContent = t('capturePanel.waitingTrigger');
        triggerSec.body.appendChild(wait);
      } else if (v.triggerState === 'triggered') {
        const hit = div('panel-note live');
        hit.textContent = t('capturePanel.triggered');
        triggerSec.body.appendChild(hit);
      } else if (v.triggerState === 'not-found') {
        const miss = div('panel-note error');
        // finish() discards the rolling search prefix - nothing was recorded.
        miss.textContent = t('capturePanel.triggerNotFound');
        triggerSec.body.appendChild(miss);
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
    this.root.appendChild(modeSec.el);
    this.root.appendChild(triggerSec.el);

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
        pos.textContent = cursorCellText(row);
        const remove = cursorRemoveButton(t('capturePanel.removeCursor', { label: row.label }),
          () => this.cb.onRemoveCursor(row.id));
        item.append(order, pos, remove);
        list.appendChild(item);
      }
      cursorSec.body.appendChild(list);
    }
    this.root.appendChild(cursorSec.el);

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
    this.root.appendChild(distanceSec.el);

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

    const consoleLabel = document.createElement('label');
    consoleLabel.className = 'advanced-console-label';
    consoleLabel.textContent = t('capturePanel.usbConsole');
    const output = document.createElement('pre');
    output.className = 'usb-console-output';
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
    this.root.appendChild(advanced);
  }
}

function oscilloscopeButton(
  start: number, active: boolean, range: string, onOpen: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'adc-button' + (active ? ' on' : '');
  b.dataset.adcOpen = String(start);
  b.dataset.adcActive = String(active);
  b.setAttribute('aria-haspopup', 'dialog');
  const state = t(active ? 'capturePanel.oscilloscopeEnabled' : 'capturePanel.oscilloscopeDisabled');
  b.setAttribute('aria-label', t('capturePanel.oscilloscopeConfig', { range, state }));
  b.title = b.getAttribute('aria-label')!;
  const namespace = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(namespace, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.8');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  const screen = document.createElementNS(namespace, 'rect');
  screen.setAttribute('x', '3');
  screen.setAttribute('y', '4');
  screen.setAttribute('width', '18');
  screen.setAttribute('height', '16');
  screen.setAttribute('rx', '2');
  const waveform = document.createElementNS(namespace, 'path');
  waveform.setAttribute('d', 'M6 14h3l2-5 3 7 2-4h2');
  icon.append(screen, waveform);
  b.appendChild(icon);
  b.addEventListener('click', onOpen);
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
