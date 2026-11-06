// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Is another logicweb tab holding a device?" over a same-origin BroadcastChannel.
 *
 * Used only to sharpen a `busy` connect failure into "another logicweb tab has it"
 * (connectFailure.ts). It is a question, not a lock: there is no takeover, no election
 * and no persistent registry - a probe asks, every live tab that holds a device answers
 * within the timeout, and silence means "no logicweb tab here" (the holder may still be
 * PulseView/DSView, the firmware updater or another origin). A crashed tab cannot leave
 * a stale claim behind because nothing is remembered between probes.
 *
 * Unsupported combinations: tabs of a different origin (a different channel scope), and
 * browsers without BroadcastChannel (the probe then resolves to no peers).
 */

export const TAB_PRESENCE_CHANNEL = 'logicweb.device-presence';

export type PresenceMessage =
  | { readonly kind: 'query'; readonly from: string; readonly nonce: string }
  | { readonly kind: 'holding'; readonly to: string; readonly nonce: string; readonly device: string };

/** The answer a tab gives to one message, or null when it says nothing. Pure. */
export function presenceReply(
  message: unknown, selfId: string, holding: string | null,
): PresenceMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as Partial<Record<string, unknown>>;
  if (m['kind'] !== 'query' || typeof m['from'] !== 'string' || typeof m['nonce'] !== 'string') return null;
  if (m['from'] === selfId || holding === null) return null;
  return { kind: 'holding', to: m['from'], nonce: m['nonce'], device: holding };
}

/** The holder a reply names when it answers this tab's probe `nonce`, else null. Pure. */
export function presenceAnswer(message: unknown, selfId: string, nonce: string): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as Partial<Record<string, unknown>>;
  if (m['kind'] !== 'holding' || m['to'] !== selfId || m['nonce'] !== nonce) return null;
  return typeof m['device'] === 'string' ? m['device'] : null;
}

/** The slice of BroadcastChannel this module uses; tests pass an in-memory bus. */
export interface PresenceChannel {
  postMessage(message: PresenceMessage): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class DeviceTabPresence {
  private readonly id = randomId();
  private readonly channel: PresenceChannel | null;

  /**
   * @param holding the name of the device this tab holds, or null; read at answer time.
   * @param channel injected for tests; by default a BroadcastChannel when available.
   */
  constructor(private readonly holding: () => string | null, channel?: PresenceChannel | null) {
    this.channel = channel !== undefined ? channel : defaultChannel();
    this.channel?.addEventListener('message', this.onMessage);
  }

  private readonly onMessage = (event: { data: unknown }): void => {
    const reply = presenceReply(event.data, this.id, this.holding());
    if (reply) this.channel?.postMessage(reply);
  };

  /** Device names other logicweb tabs report holding, collected for `timeoutMs`. */
  probe(timeoutMs = 200): Promise<string[]> {
    const channel = this.channel;
    if (!channel) return Promise.resolve([]);
    const nonce = randomId();
    const found: string[] = [];
    const listener = (event: { data: unknown }): void => {
      const device = presenceAnswer(event.data, this.id, nonce);
      if (device !== null) found.push(device);
    };
    channel.addEventListener('message', listener);
    channel.postMessage({ kind: 'query', from: this.id, nonce });
    return new Promise((resolve) => {
      setTimeout(() => {
        channel.removeEventListener('message', listener);
        resolve(found);
      }, timeoutMs);
    });
  }
}

function defaultChannel(): PresenceChannel | null {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    return new BroadcastChannel(TAB_PRESENCE_CHANNEL) as unknown as PresenceChannel;
  } catch {
    return null;
  }
}
