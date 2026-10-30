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
import { formatDuration, formatRate } from './format.js';
import {
  CHANNEL_BANK_SIZE, channelBankIndices, channelBankRange, channelBankStarts, lockedChannelBanks,
} from './channelBanks.js';
import { t } from './i18n.js';
import { chipForeground } from './metrics.js';
import { selectControl, type SelectOptionTuple } from './select.js';
import type { BusViewState } from './busView.js';
import type { CaptureSettings, ChannelState } from './state.js';
import { clampLoopSamples, THRESHOLD_VOLT_OPTIONS } from './state.js';
import { MAX_SAMPLES } from './captureIO.js';

export interface CapturePanelCallbacks {
  onSettings(next: CaptureSettings): void;
  onToggleChannel(index: number, enabled: boolean): void;
  onOpenBank(start: number): void;
  onChannelWidth(channels: number): void;
  onUsbControl(command: string): Promise<string>;
}

export interface CapturePanelView {
  settings: CaptureSettings;
  effectiveMode: CaptureSettings['mode'];
  oscilloscopeActive: boolean;
  channels: readonly ChannelState[];
  widthOptions: readonly number[];
  buses: readonly BusViewState[];
  deviceName: string | null;
  running: boolean;
  stopping: boolean;
  /** Non-null while a capture is streaming. */
  progress: { seconds: number; samples: number; bytes: number; lost: number; dropped: number;
    /** Retained length (`store.length`) and the loop limit; the limit is 0 outside loop mode. */
    kept: number; limit: number } | null;
  maxSamplerateHz: Readonly<Record<number, number>>;
  triggerState: 'off' | 'waiting' | 'triggered' | 'not-found';
}

export class CapturePanel {
  private advancedOpen = false;
  private consoleLines: string[] = [];
  private liveNote: HTMLElement | null = null;
  private lostNote: HTMLElement | null = null;
  private droppedNote: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly cb: CapturePanelCallbacks,
  ) {}

  updateProgress(progress: NonNullable<CapturePanelView['progress']>): void {
    if (!this.liveNote) return;
    this.fillProgress(progress);
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
  }

  render(v: CapturePanelView): void {
    const s = v.settings;
    this.root.replaceChildren();

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
    const seg = div('segmented');
    for (const [id, text] of [
      ['free', t('capturePanel.freeRun')], ['timer', t('capturePanel.timer')],
    ] as const) {
      const b = document.createElement('button');
      b.className = 'seg' + (v.effectiveMode === id ? ' on' : '');
      b.textContent = text;
      b.dataset.captureMode = id;
      b.disabled = v.oscilloscopeActive;
      b.addEventListener('click', () => this.cb.onSettings({ ...s, mode: id }));
      seg.appendChild(b);
    }
    modeSec.body.appendChild(seg);

    const maxSeconds = MAX_SAMPLES / s.samplerate;
    if (!v.oscilloscopeActive && v.effectiveMode === 'timer') {
      const secs = document.createElement('input');
      secs.type = 'number';
      secs.min = '0.001';
      // A 1 ms step, aligned with the 1 ms minimum: every whole-millisecond duration is
      // valid. With 0.1 the valid values were 0.001, 0.101, 0.201... - 0.002 or even 0.5
      // were flagged invalid and the spinner jumped from 0.005 straight to 0.001.
      secs.step = '0.001';
      secs.max = String(maxSeconds);
      secs.value = String(s.seconds);
      secs.addEventListener('change', () =>
        this.cb.onSettings({ ...s, seconds: Math.min(Number(secs.value), maxSeconds) }));
      modeSec.body.appendChild(labelled(t('capturePanel.durationS'), secs));
    }
    if (v.oscilloscopeActive) {
      const takeover = div('panel-note oscilloscope-takeover');
      takeover.dataset.oscilloscopeTakeover = '';
      takeover.textContent = t('capturePanel.oscilloscopeTakeover');
      modeSec.body.appendChild(takeover);
    } else {
      const limit = div('panel-note');
      limit.textContent = t('capturePanel.ceilingNote', {
        samples: MAX_SAMPLES.toLocaleString(),
        duration: formatDuration(maxSeconds),
        rate: formatRate(s.samplerate),
      });
      modeSec.body.appendChild(limit);
    }

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
        const post = v.effectiveMode === 'timer'
          ? Math.min(MAX_SAMPLES - 1, Math.round(s.seconds * s.samplerate))
          : v.effectiveMode === 'loop'
            ? clampLoopSamples(s.loopSamples, s.channels)
            : MAX_SAMPLES - 1;
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
        this.consoleLines.push(t('capturePanel.consoleError', { detail: e instanceof Error ? e.message : String(e) }));
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
