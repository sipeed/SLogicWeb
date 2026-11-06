// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A plain first sentence for the banner's non-overload failures: a capture file that
 * would not open, a decoder that failed, and a capture the board or the USB path ended
 * (no data, a dead transfer). The raw diagnostic stays available under the banner's
 * collapsed "Technical details" (`StatusError.notice`, DESIGN §11), as for the host
 * overload abort (captureAbort.ts).
 *
 * Pure: no DOM, no device. Evidence is the banner's failure key (`what`) and the error's
 * diagnostic code only - never the English message text. Connect/acquire failures
 * (connectFailure.ts) and the host overload abort keep their own handling, and anything
 * not recognised returns null so the banner shows the diagnostic as before.
 */

import { diagnosticOf, type DiagnosticCode } from '../diagnostics.js';
import type { MessageKey } from './i18n.js';

export type FailureNoticeKind =
  | 'fileType' | 'fileUnsupported' | 'fileTooLong' | 'fileDamaged'
  | 'decodeTooLarge' | 'decodeFailed' | 'decodeUnavailable'
  | 'noData' | 'linkFailed';

/** Not a file logicweb opens at all (wrong type, or nothing chosen). */
const FILE_TYPE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'file.noFiles', 'file.unsupported', 'file.sr.notZip', 'file.lwcap.magic',
]);
/** A well-formed file using something the importer does not support. */
const FILE_UNSUPPORTED: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'file.sr.multiDisk', 'file.sr.compression', 'file.sr.analogCapture', 'file.sr.analogChannels',
  'file.sr.probes', 'file.sr.unitsize', 'file.lwcap.channels',
]);
/** The decode itself was too large for one pass: a shorter range is the remedy. */
const DECODE_TOO_LARGE: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'decode.tooLong', 'decode.tooLongLoop', 'decode.edgeBudget', 'decode.edgeBudgetLoop',
  'decode.timeout',
]);
/** The USB path died under a running capture (other than the host-overload abort). */
const LINK_FAILED: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'device.transportDead', 'device.bulkStatus', 'device.bulkEmpty', 'device.workerCrashed',
  'device.workerTerminated',
]);

export function classifyFailureNotice(what: MessageKey, error: unknown): FailureNoticeKind | null {
  const code = diagnosticOf(error)?.code;
  const is = (set: ReadonlySet<DiagnosticCode>): boolean => code !== undefined && set.has(code);
  switch (what) {
    case 'error.openCapture':
      if (is(FILE_TYPE)) return 'fileType';
      if (is(FILE_UNSUPPORTED)) return 'fileUnsupported';
      if (code === 'file.sr.tooLong') return 'fileTooLong';
      // Any other .sr/.lwcap parse failure, or the browser failing to read the file.
      return 'fileDamaged';
    case 'error.decode':
      if (code === 'decode.cancelled') return null;
      return is(DECODE_TOO_LARGE) ? 'decodeTooLarge' : 'decodeFailed';
    case 'error.decodeWorkerWarmup':
      return 'decodeUnavailable';
    case 'error.device':
      if (code === 'device.noData') return 'noData';
      if (is(LINK_FAILED)) return 'linkFailed';
      return null;
    default:
      return null;
  }
}

const NOTICE_KEYS: Readonly<Record<FailureNoticeKind, MessageKey>> = {
  fileType: 'error.notice.fileType',
  fileUnsupported: 'error.notice.fileUnsupported',
  fileTooLong: 'error.notice.fileTooLong',
  fileDamaged: 'error.notice.fileDamaged',
  decodeTooLarge: 'error.notice.decodeTooLarge',
  decodeFailed: 'error.notice.decodeFailed',
  decodeUnavailable: 'error.notice.decodeUnavailable',
  noData: 'error.notice.noData',
  linkFailed: 'error.notice.linkFailed',
};

export function failureNoticeKey(kind: FailureNoticeKind): MessageKey {
  return NOTICE_KEYS[kind];
}
