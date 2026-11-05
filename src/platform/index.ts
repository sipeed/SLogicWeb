// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Public API of the platform capability layer.
 *
 * Only this module is a module boundary for the rest of the app; `capabilities.ts` is the
 * implementation and its probes are intentionally not reachable without the exports
 * below.
 */

export { CAPABILITY_NAMES, capabilityReason, detectCapabilities } from './capabilities.js';
export type {
  CapabilityName,
  PlatformCapabilities,
  PlatformDocumentLike,
  PlatformEnv,
  PlatformNavigatorLike,
  PlatformWindowLike,
} from './capabilities.js';
