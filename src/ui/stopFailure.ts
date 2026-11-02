// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { TransportDeadError } from '../device/index.js';
import type { TransportDeadReason } from '../device/types.js';

const SILENT_STOP_FAILURES: ReadonlySet<TransportDeadReason> =
  new Set<TransportDeadReason>(['loop-unsettled']);

export function stopFailureIsSilent(error: unknown): boolean {
  return error instanceof TransportDeadError && SILENT_STOP_FAILURES.has(error.reason);
}
