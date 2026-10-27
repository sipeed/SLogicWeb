// SPDX-License-Identifier: GPL-3.0-or-later

import type { ChannelState } from './state.js';
import { chipForeground } from './metrics.js';

export interface OscilloscopeChannelGridOptions {
  disabled: boolean;
  onChange(bits: number[]): void;
}

export function orderOscilloscopeChannels(
  channels: readonly ChannelState[], bits: readonly number[],
): ChannelState[] {
  const byIndex = new Map(channels.map((channel) => [channel.index, channel]));
  const seen = new Set<number>();
  const ordered: ChannelState[] = [];
  for (const index of bits) {
    const channel = byIndex.get(index);
    if (channel && !seen.has(index)) {
      ordered.push(channel);
      seen.add(index);
    }
  }
  for (const channel of channels) {
    if (!seen.has(channel.index)) {
      ordered.push(channel);
      seen.add(channel.index);
    }
  }
  return ordered;
}

export function moveOscilloscopeChannel(
  channels: readonly ChannelState[], from: number, to: number,
): ChannelState[] {
  const next = [...channels];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 ||
    from >= channels.length || to >= channels.length || from === to) return next;
  const [channel] = next.splice(from, 1);
  next.splice(to, 0, channel!);
  return next;
}

export function oscilloscopeChannelLabel(channel: ChannelState): string {
  return channel.name.trim() || `D${channel.index}`;
}

export function oscilloscopeBitLabel(position: number, count: number): string {
  if (position === 0) return 'LSB';
  if (position === count - 1) return 'MSB';
  return `B${position}`;
}

export class OscilloscopeChannelGrid {
  readonly el: HTMLDivElement;
  private channels: ChannelState[];
  private dragFrom: number | null = null;
  private readonly disabled: boolean;
  private readonly onChange: (bits: number[]) => void;

  constructor(
    channels: readonly ChannelState[], bits: readonly number[], options: OscilloscopeChannelGridOptions,
  ) {
    this.channels = orderOscilloscopeChannels(channels, bits);
    this.disabled = options.disabled;
    this.onChange = options.onChange;
    this.el = document.createElement('div');
    this.el.className = 'oscilloscope-channel-grid';
    this.el.setAttribute('role', 'list');
    this.el.classList.toggle('disabled', this.disabled);
    this.el.setAttribute('aria-disabled', String(this.disabled));
    this.render();
  }

  private render(): void {
    this.el.replaceChildren();
    this.channels.forEach((channel, position) => {
      const item = document.createElement('div');
      item.className = 'oscilloscope-channel-item';
      item.setAttribute('role', 'listitem');

      const slot = document.createElement('div');
      slot.className = 'oscilloscope-channel-slot';
      slot.dataset['position'] = String(position);

      const chip = document.createElement('div');
      chip.className = 'oscilloscope-channel-chip';
      chip.draggable = !this.disabled;
      chip.tabIndex = this.disabled ? -1 : 0;
      chip.style.background = channel.color;
      chip.style.color = chipForeground(channel.color);
      chip.setAttribute('aria-label', oscilloscopeChannelLabel(channel));

      const grip = document.createElement('span');
      grip.className = 'oscilloscope-channel-grip';
      grip.setAttribute('aria-hidden', 'true');
      for (const _ of Array.from({ length: 6 })) {
        const dot = document.createElement('span');
        dot.className = 'oscilloscope-channel-grip-dot';
        grip.appendChild(dot);
      }

      const name = document.createElement('span');
      name.className = 'oscilloscope-channel-name';
      name.textContent = oscilloscopeChannelLabel(channel);
      chip.append(grip, name);
      slot.appendChild(chip);

      const bit = document.createElement('span');
      bit.className = 'oscilloscope-channel-bit';
      bit.textContent = oscilloscopeBitLabel(position, this.channels.length);
      item.append(slot, bit);

      chip.addEventListener('dragstart', (event) => {
        if (this.disabled) {
          event.preventDefault();
          return;
        }
        this.dragFrom = position;
        item.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(position));
        }
      });
      chip.addEventListener('dragend', () => {
        this.dragFrom = null;
        this.render();
      });
      slot.addEventListener('dragover', (event) => {
        if (this.disabled || this.dragFrom === null) return;
        event.preventDefault();
        this.el.querySelectorAll('.drop-target').forEach((target) => target.classList.remove('drop-target'));
        slot.classList.add('drop-target');
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      });
      slot.addEventListener('dragleave', () => slot.classList.remove('drop-target'));
      slot.addEventListener('drop', (event) => {
        event.preventDefault();
        const from = this.dragFrom;
        this.dragFrom = null;
        if (from === null) return;
        const next = moveOscilloscopeChannel(this.channels, from, position);
        const changed = next.some((entry, index) => entry !== this.channels[index]);
        this.channels = next;
        this.render();
        if (changed) this.onChange(this.channels.map((entry) => entry.index));
      });

      this.el.appendChild(item);
    });
  }
}
