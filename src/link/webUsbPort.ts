// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Real WebUSB adapter for the `LinkPort` boundary of `LinkSession`.
 *
 * This module is the only place in `src/link` that touches WebUSB. It has no
 * DOM/UI imports and no `window`/`document` access, so the same class runs in a
 * window, a dedicated worker or a service worker. WebUSB itself is exposed only
 * as a structural subset (`WebUsbDeviceLike`): a real `USBDevice` satisfies it
 * field for field, and the self-test uses a plain object/class with no casts.
 *
 * Scope and honest limits:
 *
 * - `open`/`claim`/`release`/`close` wrap `USBDevice.open()`,
 *   `selectConfiguration()` (only when no configuration is active yet),
 *   `claimInterface()` and `releaseInterface()`. Claim targets exactly one
 *   vendor interface, detected as interface class 0xff, or as the sole
 *   interface of a device that declares itself vendor-specific at device level
 *   (a common USB convention for these boards). An adapter with a
 *   multi-vendor-interface device must pass `interfaceNumber`; ambiguity is a
 *   typed `profile` refusal, never a guess.
 * - `describe()` is descriptor-only: VID/PID and the origin-scoped serial come
 *   from the USB device descriptor.
 * - WebUSB exposes no negotiated link speed, so `linkClass` is a required
 *   constructor option. The platform adapter that selected the device owns it
 *   (from the host USB stack / a platform-specific speed report). This module
 *   cannot verify it; `LinkSession` still validates it against the profile, so
 *   a wrong class is refused, but a host reporting the wrong class would still
 *   be attributed to the adapter, not discovered here.
 * - There is NO `control()` implementation. The stock U3 protocol exposes only
 *   vendor requests 0x00/0x01, which are 4-byte register read/write, not the
 *   proposed `LW` identity record or a link probe. Answering the session's
 *   `identity`/`probe` requests from those registers would fabricate a
 *   protocol; omitting `control` makes `LinkSession` stay on descriptor
 *   identity with `probe: null`, which is what the stock device supports. A
 *   future firmware that defines the LW identity request gets a new control
 *   implementation here; nothing in this adapter changes.
 * - `USBDevice.reset()` is never called. A reset would re-enumerate the device
 *   mid-capture and invalidate the session's claim; teardown is release ->
 *   close only. The self-test keeps a `reset()` counter at zero to prove it.
 *
 * Error mapping: every WebUSB/DOMException is translated to a typed `LinkError`
 * before it leaves the adapter. `LinkSession` therefore never has to interpret
 * a browser-specific exception name, and callers cannot accidentally depend on
 * `DOMException`. Transfer-level helpers (bulk transfers) are out of scope for
 * this port; they live with the future streaming adapter, which should reuse
 * the same reason mapping.
 */

import { LinkError, type LinkClass, type LinkPort, type LinkPortDescriptor } from './linkSession.js';

/**
 * The subset of `USBDevice` this adapter uses. A real `USBDevice` is assignable
 * to it structurally (`createWebUsbPort` takes a `USBDevice` and proves that at
 * compile time); the self-test implements it with a plain fake.
 */
export interface WebUsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly serialNumber: string | null;
  /** Device-level class; 0xff means the vendor owns the whole device. */
  readonly deviceClass: number;
  readonly configuration: WebUsbConfigurationLike | null;
  readonly configurations: readonly WebUsbConfigurationLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
}

/** The subset of `USBConfiguration` this adapter reads. */
export interface WebUsbConfigurationLike {
  readonly configurationValue: number;
  readonly interfaces: readonly WebUsbInterfaceLike[];
}

/** The subset of `USBInterface` this adapter reads. */
export interface WebUsbInterfaceLike {
  readonly interfaceNumber: number;
  readonly alternate: WebUsbAlternateLike;
  readonly alternates: readonly WebUsbAlternateLike[];
}

/** The subset of `USBAlternateInterface` used for vendor-interface detection. */
export interface WebUsbAlternateLike {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
}

/** Payload of a WebUSB `disconnect` event (`USBConnectionEvent`). */
export interface WebUsbDisconnectEvent {
  readonly device: WebUsbDeviceLike;
}

/**
 * The subset of the WebUSB `USB` object (`navigator.usb`) needed for
 * disconnect notification. `navigator.usb` is assignable to it.
 */
export interface WebUsbEventSource {
  addEventListener(
    type: 'disconnect',
    listener: (event: WebUsbDisconnectEvent) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: 'disconnect',
    listener: (event: WebUsbDisconnectEvent) => void,
    options?: boolean | EventListenerOptions | boolean,
  ): void;
}

export interface WebUsbPortOptions {
  /**
   * Negotiated USB link class, required because WebUSB has no speed API. The
   * platform adapter that picked the device must report it; see the module
   * header. It is trusted here and cross-checked by `LinkSession` against the
   * profile.
   */
  readonly linkClass: LinkClass;
  /**
   * Interface number to claim when the active configuration exposes more than
   * one vendor interface. When omitted, the single interface class 0xff
   * interface is claimed and zero/multiple matches are `profile` refusals.
   */
  readonly interfaceNumber?: number;
  /**
   * Source of WebUSB `disconnect` events. Defaults to `navigator.usb` when the
   * runtime exposes it; `null` disables notification (the session then notices
   * loss on the next operation). Tests pass a fake.
   */
  readonly eventSource?: WebUsbEventSource | null;
}

const VENDOR_INTERFACE_CLASS = 0xff;

/**
 * `LinkPort` over one granted `USBDevice`.
 *
 * Lifecycle: `open()` opens the device; `claim()` (auto-)selects a
 * configuration if needed and claims the vendor interface; `release()` releases
 * that claim at most once; `close()` closes the device. The class is not
 * re-entrant: `LinkSession` serialises calls. `release()` and `close()` are
 * idempotent so a failed attempt and an explicit disconnect cannot double-free
 * the interface. `open()` may be called again after `close()` (reconnect).
 */
export class WebUsbPort implements LinkPort {
  private readonly device: WebUsbDeviceLike;
  private readonly linkClass: LinkClass;
  private readonly interfaceNumber: number | null;
  private readonly eventSourceOption: WebUsbEventSource | null | undefined;

  private opened = false;
  private claimed = false;
  /** Interface whose claim is currently held, or null. */
  private claimedInterface: number | null = null;

  private disconnectCallback: (() => void) | null = null;
  private disconnectListener: ((event: WebUsbDisconnectEvent) => void) | null = null;
  private disconnectSource: WebUsbEventSource | null = null;

  constructor(device: WebUsbDeviceLike, options: WebUsbPortOptions) {
    if (!isLinkClass(options.linkClass)) {
      throw new LinkError(
        'profile',
        `unknown link class '${String(options.linkClass)}'; expected fs, hs, ss5 or ss10`,
      );
    }
    const interfaceNumber = options.interfaceNumber;
    if (interfaceNumber !== undefined && (!Number.isInteger(interfaceNumber) ||
      interfaceNumber < 0 || interfaceNumber > 255)) {
      throw new LinkError('profile', `interface number ${String(interfaceNumber)} is not an 8-bit USB interface number`);
    }

    this.device = device;
    this.linkClass = options.linkClass;
    this.interfaceNumber = interfaceNumber ?? null;
    this.eventSourceOption = options.eventSource;
  }

  /**
   * Open the granted device. A failure is `lost` when the device vanished,
   * `denied` when permission was withdrawn, `busy` when it is in a state that
   * cannot be opened, `unsupported` when WebUSB cannot open this device at all,
   * and `transfer` otherwise.
   */
  async open(): Promise<void> {
    try {
      await this.device.open();
    } catch (error) {
      throw mapOpenError(error);
    }
    this.opened = true;
    this.claimed = false;
    this.claimedInterface = null;
    // Device is open now, so a pending disconnect registration can attach.
    // A subscription failure is a transfer error; LinkSession then tears down
    // the device it just opened.
    this.attachDisconnect();
  }

  /**
   * Claim exactly one vendor interface. Selects the first configuration when
   * the device has none active (WebUSB does not guarantee one after `open()`),
   * then claims the single class-0xff interface, or `interfaceNumber` when
   * configured. Idempotent while claimed.
   */
  async claim(): Promise<void> {
    if (this.claimed) return;
    if (!this.opened) {
      throw new LinkError('busy', 'cannot claim a USB interface before the device is open');
    }

    const configuration = await this.ensureConfiguration();
    const interfaceNumber = this.chooseVendorInterface(configuration);
    try {
      await this.device.claimInterface(interfaceNumber);
    } catch (error) {
      throw mapClaimError(error, interfaceNumber);
    }
    this.claimed = true;
    this.claimedInterface = interfaceNumber;
  }

  /**
   * Release the claimed interface. Safe to call twice and safe after a failed
   * claim; the device call is made at most once per successful claim. The flag
   * is cleared before the call so a rejection cannot cause a second release.
   */
  async release(): Promise<void> {
    const interfaceNumber = this.claimedInterface;
    if (!this.claimed || interfaceNumber === null) return;
    this.claimed = false;
    this.claimedInterface = null;
    try {
      await this.device.releaseInterface(interfaceNumber);
    } catch (error) {
      throw mapReleaseError(error, interfaceNumber);
    }
  }

  /**
   * Descriptor identity. The serial is WebUSB's origin-scoped string and is
   * empty when the browser withholds it; `null` is normalized to `''` so the
   * session's "field exists" check is consistent across browsers.
   */
  async describe(): Promise<LinkPortDescriptor> {
    return {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      serialNumber: this.device.serialNumber ?? '',
      linkClass: this.linkClass,
    };
  }

  /**
   * Register the one disconnect callback. It is stored even when the device is
   * closed and attached on the next `open()`, so a session that registers once
   * before connecting keeps receiving events across reconnects. `close()`
   * detaches the listener; the callback is kept for the next open.
   */
  onDisconnect(callback: () => void): void {
    this.disconnectCallback = callback;
    if (this.opened) this.attachDisconnect();
  }

  /**
   * Close the device. Idempotent and never calls `reset()`. Release is the
   * session's responsibility (and runs first); if a caller closes with a claim
   * still recorded, closing the USB device drops the claim, so the interface is
   * not leaked.
   */
  async close(): Promise<void> {
    const wasOpened = this.opened;
    this.opened = false;
    this.claimed = false;
    this.claimedInterface = null;

    let closeError: LinkError | null = null;
    if (wasOpened) {
      try {
        await this.device.close();
      } catch (error) {
        closeError = mapCloseError(error);
      }
    }
    const detachError = this.detachDisconnect();
    if (closeError !== null) throw closeError;
    if (detachError !== null) throw detachError;
  }

  private async ensureConfiguration(): Promise<WebUsbConfigurationLike> {
    const active = this.device.configuration;
    if (active !== null) return active;

    const first = this.device.configurations[0];
    if (first === undefined) {
      throw new LinkError('profile', 'the USB device exposes no configuration');
    }
    try {
      await this.device.selectConfiguration(first.configurationValue);
    } catch (error) {
      throw mapConfigurationError(error, first.configurationValue);
    }
    // Chrome updates `configuration` on success; fall back to the descriptor we
    // just selected so a host that updates lazily is still usable.
    return this.device.configuration ?? first;
  }

  private chooseVendorInterface(configuration: WebUsbConfigurationLike): number {
    const interfaces = configuration.interfaces;
    if (this.interfaceNumber !== null) {
      const match = interfaces.find((entry) => entry.interfaceNumber === this.interfaceNumber);
      if (match === undefined) {
        throw new LinkError(
          'profile',
          `the USB device has no interface ${this.interfaceNumber} in configuration ${configuration.configurationValue}`,
        );
      }
      if (!isVendorInterface(match)) {
        throw new LinkError(
          'profile',
          `USB interface ${this.interfaceNumber} is not vendor class 0xff`,
        );
      }
      return match.interfaceNumber;
    }

    const vendor = interfaces.filter(isVendorInterface);
    if (vendor.length === 1) return vendor[0].interfaceNumber;
    if (vendor.length === 0) {
      // USB convention: when bDeviceClass is 0xff the class is defined at
      // device level and the interface descriptors may carry 0x00. A device
      // that says "vendor owns the whole device" and exposes one interface has
      // exactly one vendor interface; with several, no honest choice exists.
      if (this.device.deviceClass === VENDOR_INTERFACE_CLASS && interfaces.length === 1) {
        return interfaces[0].interfaceNumber;
      }
      throw new LinkError('profile', 'the USB device exposes no vendor (class 0xff) interface');
    }
    throw new LinkError(
      'profile',
      `the USB device exposes ${vendor.length} vendor interfaces ` +
      `(${vendor.map((entry) => entry.interfaceNumber).join(', ')}); pass interfaceNumber to choose one`,
    );
  }

  private attachDisconnect(): void {
    if (this.disconnectListener !== null || this.disconnectCallback === null) return;
    const source = this.resolveEventSource();
    if (source === null) return;

    const listener = (event: WebUsbDisconnectEvent): void => {
      // A removed listener can still be queued in some runtimes; a late event
      // after close must not move a closed session.
      if (!this.opened) return;
      if (!isSameDevice(this.device, event.device)) return;
      this.disconnectCallback?.();
    };
    try {
      source.addEventListener('disconnect', listener);
    } catch (error) {
      throw new LinkError(
        'transfer',
        `could not subscribe to USB disconnect events: ${errorMessage(error)}`,
        error,
      );
    }
    this.disconnectListener = listener;
    this.disconnectSource = source;
  }

  /** Returns a typed error instead of throwing so `close()` always completes. */
  private detachDisconnect(): LinkError | null {
    const listener = this.disconnectListener;
    const source = this.disconnectSource;
    this.disconnectListener = null;
    this.disconnectSource = null;
    if (listener === null || source === null) return null;
    try {
      source.removeEventListener('disconnect', listener);
      return null;
    } catch (error) {
      return new LinkError(
        'transfer',
        `could not unsubscribe from USB disconnect events: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private resolveEventSource(): WebUsbEventSource | null {
    if (this.eventSourceOption !== undefined) return this.eventSourceOption;
    // `navigator.usb` exists in windows and workers when WebUSB is available.
    // Read it through globalThis so importing this module never touches DOM.
    const navigatorLike = (globalThis as { navigator?: { usb?: WebUsbEventSource } }).navigator;
    return navigatorLike?.usb ?? null;
  }
}

/**
 * Create a port from a granted `USBDevice`. A missing device is a typed
 * `unsupported` error rather than a later `TypeError`, for platform adapters
 * that construct the port before permission/selection succeeds.
 *
 * Passing `USBDevice` here is also the compile-time proof that the real WebUSB
 * type satisfies `WebUsbDeviceLike`.
 */
export function createWebUsbPort(
  device: USBDevice | null | undefined,
  options: WebUsbPortOptions,
): WebUsbPort {
  if (device === null || device === undefined) {
    throw new LinkError('unsupported', 'no granted WebUSB device is available');
  }
  return new WebUsbPort(device, options);
}

function isVendorInterface(iface: WebUsbInterfaceLike): boolean {
  const alternates = iface.alternates.length > 0 ? iface.alternates : [iface.alternate];
  return alternates.some((alternate) => alternate.interfaceClass === VENDOR_INTERFACE_CLASS);
}

function isSameDevice(device: WebUsbDeviceLike, candidate: WebUsbDeviceLike): boolean {
  if (device === candidate) return true;
  // A disconnect event carries the same granted device object in practice; the
  // descriptor comparison covers adapters that hand out a fresh wrapper. An
  // empty origin-scoped serial cannot identify anything, so it never matches.
  const serial = device.serialNumber;
  return serial !== null && serial.length > 0 &&
    candidate.vendorId === device.vendorId &&
    candidate.productId === device.productId &&
    candidate.serialNumber === serial;
}

function isLinkClass(value: unknown): value is LinkClass {
  return value === 'fs' || value === 'hs' || value === 'ss5' || value === 'ss10';
}

function mapOpenError(error: unknown): LinkError {
  if (error instanceof LinkError) return error;
  const name = errorName(error);
  switch (name) {
    case 'NetworkError':
    case 'NotFoundError':
      return new LinkError('lost', `USB device open failed: ${errorMessage(error)}`, error);
    case 'SecurityError':
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new LinkError('denied', `USB device open was denied: ${errorMessage(error)}`, error);
    case 'NotSupportedError':
      return new LinkError('unsupported', `WebUSB cannot open this device: ${errorMessage(error)}`, error);
    case 'InvalidStateError':
      return new LinkError('busy', `USB device is not openable in its current state: ${errorMessage(error)}`, error);
    default:
      return new LinkError('lost', `USB device open failed: ${errorMessage(error)}`, error);
  }
}

function mapClaimError(error: unknown, interfaceNumber: number): LinkError {
  if (error instanceof LinkError) return error;
  const name = errorName(error);
  switch (name) {
    case 'NetworkError':
      return new LinkError('lost', `interface ${interfaceNumber} claim failed: ${errorMessage(error)}`, error);
    case 'NotFoundError':
      return new LinkError('profile', `interface ${interfaceNumber} disappeared before claim: ${errorMessage(error)}`, error);
    case 'InvalidStateError':
    case 'SecurityError':
    case 'NotAllowedError':
      // Another owner holds the interface, or the device is not open. WebUSB
      // does not name the owner (P7: report busy with the owner if known).
      return new LinkError('busy', `interface ${interfaceNumber} is unavailable: ${errorMessage(error)}`, error);
    default:
      return new LinkError('busy', `interface ${interfaceNumber} claim was refused: ${errorMessage(error)}`, error);
  }
}

function mapConfigurationError(error: unknown, configurationValue: number): LinkError {
  if (error instanceof LinkError) return error;
  const name = errorName(error);
  switch (name) {
    case 'NetworkError':
    case 'NotFoundError':
      return new LinkError('lost', `USB configuration ${configurationValue} could not be selected: ${errorMessage(error)}`, error);
    case 'InvalidStateError':
      return new LinkError('busy', 'USB device closed before its configuration was selected', error);
    case 'SecurityError':
    case 'NotAllowedError':
      return new LinkError('denied', `USB configuration selection was denied: ${errorMessage(error)}`, error);
    default:
      return new LinkError('profile', `USB configuration ${configurationValue} is unusable: ${errorMessage(error)}`, error);
  }
}

function mapReleaseError(error: unknown, interfaceNumber: number): LinkError {
  if (error instanceof LinkError) return error;
  const name = errorName(error);
  if (name === 'NetworkError' || name === 'NotFoundError') {
    return new LinkError('lost', `interface ${interfaceNumber} release failed: ${errorMessage(error)}`, error);
  }
  return new LinkError('transfer', `interface ${interfaceNumber} release failed: ${errorMessage(error)}`, error);
}

function mapCloseError(error: unknown): LinkError {
  if (error instanceof LinkError) return error;
  const name = errorName(error);
  if (name === 'NetworkError' || name === 'NotFoundError') {
    return new LinkError('lost', `USB device close failed: ${errorMessage(error)}`, error);
  }
  return new LinkError('transfer', `USB device close failed: ${errorMessage(error)}`, error);
}

function errorName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) return null;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  if (typeof error === 'string') return error;
  try {
    return String(error);
  } catch {
    return 'unprintable error';
  }
}
