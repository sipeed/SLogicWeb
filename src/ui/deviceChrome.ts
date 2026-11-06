// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Device chrome view models: what the toolbar Device command, its connected-device menu,
 * the empty-state hint and the browser-support notice say for one connection state.
 * Pure (t() only), so the self-test pins every state under node.
 *
 * - Disconnected: the Device command reads "Connect device" and is the toolbar's one
 *   highlighted (primary) control - it is the only useful next step, and the Capture
 *   button stays disabled and unhighlighted until a board is connected.
 * - Connected: the command shows the model and "Connected" (the state word drops on
 *   compact widths, CSS), and opens a menu with the identity rows plus Disconnect,
 *   Connect another device and Firmware update.
 * - No WebUSB: the command is disabled, the empty hint offers files only and a
 *   dismissible notice names the cause - an insecure context (HTTP on a LAN address)
 *   is said as such, because Chrome hides WebUSB there too.
 *
 * Link speed: WebUSB reports no negotiated speed (link/webUsbPort.ts), and throughput
 * does not identify the link class, so the menu says "unknown" rather than infer one.
 * Firmware: the descriptors carry no firmware version this app can read reliably; the
 * board's own serial is the only identity shown, with the firmware updater one click away.
 */

import type { PlatformCapabilities } from '../platform/capabilities.js';
import type { MessageKey } from './i18n.js';
import { t } from './i18n.js';
import type { SettingsMenuItem } from './settingsMenu.js';

/** Browser support for device connections. */
export type DeviceSupport = 'ok' | 'unsupported' | 'insecure';

export function deviceSupport(caps: Pick<PlatformCapabilities, 'usb' | 'secureContext'>): DeviceSupport {
  if (caps.usb) return 'ok';
  return caps.secureContext ? 'unsupported' : 'insecure';
}

export interface DeviceToolbarView {
  /** Visible label: model when connected, the generic command name otherwise. */
  readonly label: string;
  /** Secondary state word shown after the model on wide layouts, or null. */
  readonly state: string | null;
  readonly title: string;
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly connected: boolean;
  /** Highlighted as the toolbar's primary call to action (disconnected, WebUSB present). */
  readonly primary: boolean;
}

export function deviceToolbarView(deviceName: string | null, support: DeviceSupport): DeviceToolbarView {
  if (support !== 'ok') {
    return {
      label: t('toolbar.shortDevice'),
      state: null,
      title: t(support === 'insecure' ? 'toolbar.noWebusbInsecure' : 'toolbar.noWebusb'),
      ariaLabel: t('toolbar.device'),
      disabled: true,
      connected: false,
      primary: false,
    };
  }
  if (deviceName === null) {
    return {
      label: t('toolbar.connect'),
      state: null,
      title: t('toolbar.connectHint'),
      ariaLabel: t('toolbar.connect'),
      disabled: false,
      connected: false,
      primary: true,
    };
  }
  return {
    label: deviceName,
    state: t('toolbar.deviceConnected'),
    title: t('toolbar.deviceMenuTitle', { device: deviceName }),
    ariaLabel: `${t('toolbar.device')}: ${deviceName}`,
    disabled: false,
    connected: true,
    primary: false,
  };
}

/** The empty-state second line for the current connection state. */
export function emptyHintKey(connected: boolean, support: DeviceSupport): MessageKey {
  if (support !== 'ok') return 'emptyHint.line2NoUsb';
  return connected ? 'emptyHint.line2Connected' : 'emptyHint.line2';
}

/** The top notice for a browser that cannot connect devices, or null. */
export function platformNoticeKey(support: DeviceSupport): MessageKey | null {
  if (support === 'insecure') return 'notice.noUsbInsecure';
  if (support === 'unsupported') return 'notice.noUsb';
  return null;
}

export interface DeviceMenuView {
  readonly name: string;
  /** The serial the browser reports; may be empty or origin-randomised. */
  readonly serial: string;
}

export interface DeviceMenuActions {
  disconnect(): void;
  connectAnother(): void;
  firmwareUpdate(): void;
}

export function deviceMenuItems(view: DeviceMenuView, actions: DeviceMenuActions): SettingsMenuItem[] {
  return [
    { label: t('deviceMenu.model'), hint: view.name, info: true },
    { label: t('deviceMenu.serial'), hint: view.serial || t('deviceMenu.unknown'), info: true },
    { label: t('deviceMenu.link'), hint: t('deviceMenu.linkUnknown'), info: true },
    { label: t('deviceMenu.disconnect'), onPick: () => actions.disconnect() },
    { label: t('deviceMenu.connectAnother'), hint: '…', onPick: () => actions.connectAnother() },
    { label: t('deviceMenu.firmware'), hint: '↗', onPick: () => actions.firmwareUpdate() },
  ];
}

/**
 * The firmware updater. Only the CI deploy stages it beside the app (docs/DEPLOY.md);
 * dev servers, project-page builds and file:// portable copies have no `ota/` sibling,
 * so the public page is the one link that always resolves. It asks for its own WebUSB
 * grant, and this tab must release the board first (the menu disconnects before opening).
 */
export const FIRMWARE_UPDATE_URL = 'https://slogic.sipeed.com/ota/';
