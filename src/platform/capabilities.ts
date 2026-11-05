// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Platform capability probes for the M0 layer.
 *
 * Contract: docs/ARCHITECTURE.md §1.2-1.4 and rule P1.
 *
 * - Detection is feature-based only. There is no user-agent or version parsing here.
 * - Every probe is total: an absent API, a throwing getter or a throwing canvas probe
 *   produces `false`, never an exception that escapes `detectCapabilities`.
 * - `detectCapabilities()` with no argument probes the ambient global environment.
 *   Passing a `PlatformEnv` - including `{}` - restricts detection to the supplied
 *   objects and never falls through to the host globals, which keeps tests deterministic.
 * - `missing` lists the false capability bits in `CAPABILITY_NAMES` order.
 *
 * `opfsSync` is the `FileSystemSyncAccessHandle` constructor-presence probe. Obtaining a
 * sync handle also requires OPFS, so a consumer that needs sync access must check both
 * `opfs` and `opfsSync`.
 */

/** Capability identifiers. The array order is also the `missing` array order. */
export const CAPABILITY_NAMES = [
  'usb',
  'secureContext',
  'crossOriginIsolated',
  'offscreenCanvas',
  'webgl2',
  'opfs',
  'opfsSync',
  'webLocks',
  'wakeLock',
  'share',
  'saveFilePicker',
  'persistStorage',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/** The result of probing one environment. All fields are immutable. */
export interface PlatformCapabilities {
  /** WebUSB API presence; usable only together with `secureContext` (rule P1). */
  readonly usb: boolean;
  readonly secureContext: boolean;
  readonly crossOriginIsolated: boolean;
  readonly offscreenCanvas: boolean;
  readonly webgl2: boolean;
  readonly opfs: boolean;
  /** `FileSystemSyncAccessHandle` constructor presence; usable only together with `opfs`. */
  readonly opfsSync: boolean;
  readonly webLocks: boolean;
  readonly wakeLock: boolean;
  readonly share: boolean;
  readonly saveFilePicker: boolean;
  readonly persistStorage: boolean;
  /** Shorthand for `crossOriginIsolated`; the engine selects isolated strategies from it. */
  readonly isolated: boolean;
  /** False capability bits, in `CAPABILITY_NAMES` order. */
  readonly missing: readonly CapabilityName[];
}

/** The navigator-like surface the probes read. */
export interface PlatformNavigatorLike {
  readonly usb?: { readonly requestDevice?: unknown } | undefined;
  readonly locks?: { readonly request?: unknown } | undefined;
  readonly storage?: {
    readonly getDirectory?: unknown;
    readonly persist?: unknown;
  } | undefined;
  readonly wakeLock?: { readonly request?: unknown } | undefined;
  readonly share?: unknown;
}

/** The document-like surface the WebGL2 probe reads. */
export interface PlatformDocumentLike {
  readonly createElement?: ((tagName: string) => unknown) | undefined;
}

/**
 * The global-object surface the probes read. In a browser this is `window`; in a worker
 * an injected `self`-like object can stand in. `navigator` and `document` are accepted
 * here as a convenience so one object can describe a whole fake environment.
 */
export interface PlatformWindowLike {
  readonly navigator?: PlatformNavigatorLike | undefined;
  readonly document?: PlatformDocumentLike | undefined;
  readonly isSecureContext?: unknown;
  readonly crossOriginIsolated?: unknown;
  readonly OffscreenCanvas?: unknown;
  readonly FileSystemSyncAccessHandle?: unknown;
  readonly showSaveFilePicker?: unknown;
}

/** Injectable environment for deterministic probes. Omitted fields are absent. */
export interface PlatformEnv {
  readonly navigator?: PlatformNavigatorLike | undefined;
  readonly document?: PlatformDocumentLike | undefined;
  readonly window?: PlatformWindowLike | undefined;
}

type UnknownFunction = (...args: unknown[]) => unknown;

function isFunction(value: unknown): value is UnknownFunction {
  return typeof value === 'function';
}

/** Run a probe; any throw means the capability is unavailable. */
function safeProbe<T>(probe: () => T, fallback: T): T {
  try {
    return probe();
  } catch {
    return fallback;
  }
}

/**
 * Probe WebGL2 with a canvas context. A document canvas is preferred; when there is no
 * usable document, an OffscreenCanvas is tried, which also covers worker-like hosts.
 */
function probeWebgl2(
  documentLike: PlatformDocumentLike | undefined,
  root: PlatformWindowLike,
): boolean {
  if (documentLike !== undefined) {
    const createElement = documentLike.createElement;
    if (isFunction(createElement)) {
      const documentHasWebgl2 = safeProbe(
        () => hasWebgl2Context(createElement.call(documentLike, 'canvas')),
        false,
      );
      if (documentHasWebgl2) return true;
    }
  }
  if (isFunction(root.OffscreenCanvas)) {
    const OffscreenCanvasConstructor = root.OffscreenCanvas as unknown as new () => unknown;
    return safeProbe(() => hasWebgl2Context(new OffscreenCanvasConstructor()), false);
  }
  return false;
}

function hasWebgl2Context(canvas: unknown): boolean {
  if (canvas === null || canvas === undefined) return false;
  const getContext = (canvas as { readonly getContext?: unknown }).getContext;
  if (!isFunction(getContext)) return false;
  return Boolean(getContext.call(canvas, 'webgl2'));
}

/**
 * Probe one environment.
 *
 * @param env optional injected environment. When omitted, the ambient globals are read.
 *   When supplied, only the supplied objects are read (an empty object is an empty
 *   platform), except that `env.window.navigator` and `env.window.document` stand in for
 *   omitted top-level fields.
 */
export function detectCapabilities(env?: PlatformEnv): PlatformCapabilities {
  const root = safeProbe<PlatformWindowLike>(
    () => (env === undefined
      ? (globalThis as unknown as PlatformWindowLike)
      : env?.window ?? {}),
    {},
  );
  const navigatorLike = safeProbe<PlatformNavigatorLike | undefined>(
    () => env?.navigator ?? root.navigator,
    undefined,
  );
  const documentLike = safeProbe<PlatformDocumentLike | undefined>(
    () => env?.document ?? root.document,
    undefined,
  );

  const values: Record<CapabilityName, boolean> = {
    usb: safeProbe(() => isFunction(navigatorLike?.usb?.requestDevice), false),
    secureContext: safeProbe(() => root.isSecureContext === true, false),
    crossOriginIsolated: safeProbe(() => root.crossOriginIsolated === true, false),
    offscreenCanvas: safeProbe(() => isFunction(root.OffscreenCanvas), false),
    webgl2: safeProbe(() => probeWebgl2(documentLike, root), false),
    opfs: safeProbe(() => isFunction(navigatorLike?.storage?.getDirectory), false),
    opfsSync: safeProbe(() => isFunction(root.FileSystemSyncAccessHandle), false),
    webLocks: safeProbe(() => isFunction(navigatorLike?.locks?.request), false),
    wakeLock: safeProbe(() => isFunction(navigatorLike?.wakeLock?.request), false),
    share: safeProbe(() => isFunction(navigatorLike?.share), false),
    saveFilePicker: safeProbe(() => isFunction(root.showSaveFilePicker), false),
    persistStorage: safeProbe(() => isFunction(navigatorLike?.storage?.persist), false),
  };
  const missing = Object.freeze(CAPABILITY_NAMES.filter((name) => !values[name]));

  return Object.freeze({
    usb: values.usb,
    secureContext: values.secureContext,
    crossOriginIsolated: values.crossOriginIsolated,
    offscreenCanvas: values.offscreenCanvas,
    webgl2: values.webgl2,
    opfs: values.opfs,
    opfsSync: values.opfsSync,
    webLocks: values.webLocks,
    wakeLock: values.wakeLock,
    share: values.share,
    saveFilePicker: values.saveFilePicker,
    persistStorage: values.persistStorage,
    isolated: values.crossOriginIsolated,
    missing,
  });
}

/**
 * Stable diagnostic reason codes, one per capability. These are keys for the UI and the
 * diagnostics panel, never localized copy.
 */
const CAPABILITY_REASONS: Readonly<Record<CapabilityName, string>> = Object.freeze({
  usb: 'unsupported-platform',
  secureContext: 'insecure-context',
  crossOriginIsolated: 'not-cross-origin-isolated',
  offscreenCanvas: 'unsupported-platform',
  webgl2: 'unsupported-platform',
  opfs: 'unsupported-platform',
  opfsSync: 'unsupported-platform',
  webLocks: 'unsupported-platform',
  wakeLock: 'unsupported-platform',
  share: 'unsupported-platform',
  saveFilePicker: 'unsupported-platform',
  persistStorage: 'unsupported-platform',
});

/**
 * Stable diagnostic reason key for a capability, or `null` when it is available.
 *
 * Pure and deterministic: the function never probes the environment and never reads the
 * user agent. The one-argument form assumes the caller already knows the capability is
 * missing (for example, a name taken from `PlatformCapabilities.missing`) and returns its
 * code. Pass the detected capabilities as the second argument for availability-aware
 * behavior; an available capability then returns `null`.
 *
 * The codes are diagnostic, not localized copy:
 * - `unsupported-platform` - the API or constructor is absent or unusable;
 * - `insecure-context` - WebUSB requires HTTPS or localhost;
 * - `not-cross-origin-isolated` - COOP/COEP are absent, so `SharedArrayBuffer` is out.
 */
export function capabilityReason(name: CapabilityName): string | null;
export function capabilityReason(
  name: CapabilityName,
  capabilities: PlatformCapabilities,
): string | null;
export function capabilityReason(
  name: CapabilityName,
  capabilities?: PlatformCapabilities,
): string | null {
  if (capabilities !== undefined && capabilities[name]) return null;
  return CAPABILITY_REASONS[name];
}
