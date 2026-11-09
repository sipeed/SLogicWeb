// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Classify a device-acquisition failure (Connect, the silent re-acquire at boot or after a
 * replug, and the banner's Retry) into the typed error kinds DESIGN.md §11 names, so the
 * banner can say what to do instead of only echoing the browser's English text.
 *
 * Evidence, in order: the diagnostic code the device layer attached to the stage that
 * failed (`device.openFailed` / `configureFailed` / `claimFailed`), the DOMException name
 * the browser used (carried as the `dom` var - see `usbRejection` in slogic16u3.ts), and
 * only then the browser's message text. There is no user-agent or OS sniffing: the
 * guidance sentences name the per-platform remedies together instead.
 *
 * Assumptions (Chromium WebUSB):
 * - `claimInterface` rejecting means another holder has interface 0 - another tab, the
 *   firmware updater, or a libusb program such as PulseView/DSView/sigrok-cli -> `busy`.
 * - `SecurityError` / "Access denied" from `open()` is an OS permission refusal (no udev
 *   rule on Linux; on Windows an exclusive WinUSB holder looks the same) -> `permission`.
 * - `NotFoundError` / "disconnected" means the device went away mid-open -> `lost`.
 * Anything else is left unclassified (null): the banner then shows the raw diagnostic
 * only, which is still honest.
 */

import { diagnosticOf } from '../diagnostics.js';
import type { MessageKey } from './i18n.js';

export type ConnectFailureKind = 'busy' | 'busy-tab' | 'permission' | 'lost' | 'unsupported';

export function classifyConnectFailure(error: unknown): ConnectFailureKind | null {
  const diag = diagnosticOf(error);
  const code = diag?.code ?? null;
  if (code === 'usb.unavailable') return 'unsupported';
  if (code === 'device.disconnected') return 'lost';
  const domVar = diag?.vars?.['dom'];
  const dom = typeof domVar === 'string' ? domVar
    : error instanceof DOMException ? error.name : '';
  const text = diag?.payload ?? (diag === null && error instanceof Error ? error.message : '');
  if (dom === 'SecurityError' || /access denied/i.test(text)) return 'permission';
  if (dom === 'NotFoundError' || /disconnected/i.test(text)) return 'lost';
  if (code === 'device.claimFailed' || code === 'device.reclaimFailed') return 'busy';
  if (/claim interface/i.test(text)) return 'busy';
  return null;
}

/**
 * A `busy` failure is narrowed to `busy-tab` when another slogicweb tab answered that it
 * holds a device (deviceTabPresence.ts); every other kind is kept.
 */
export function refineWithPeerTabs(kind: ConnectFailureKind | null, peerHolds: boolean): ConnectFailureKind | null {
  return kind === 'busy' && peerHolds ? 'busy-tab' : kind;
}

const GUIDANCE: Readonly<Record<ConnectFailureKind, MessageKey>> = {
  busy: 'connectHelp.busy',
  'busy-tab': 'connectHelp.busyTab',
  permission: 'connectHelp.permission',
  lost: 'connectHelp.lost',
  unsupported: 'connectHelp.unsupported',
};

/** The banner's second line for a classified failure. */
export function connectGuidanceKey(kind: ConnectFailureKind): MessageKey {
  return GUIDANCE[kind];
}

/** Whether Retry can help: an absent WebUSB will not appear by retrying. */
export function connectFailureRetryable(kind: ConnectFailureKind | null): boolean {
  return kind !== 'unsupported';
}
