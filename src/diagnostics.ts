// SPDX-License-Identifier: GPL-3.0-or-later

export type DiagnosticVars = Record<string, string | number>;

export const DIAGNOSTIC_CODES = [
  'ui.localeLoad',
  'io.nothingToSave',
  'file.noFiles',
  'file.unsupported',
  'file.lwcap.header',
  'file.lwcap.magic',
  'file.lwcap.channels',
  'file.lwcap.length',
  'file.lwcap.samplerate',
  'file.lwcap.namesTruncated',
  'file.lwcap.namesInvalid',
  'file.lwcap.gapTruncated',
  'file.lwcap.gapSpan',
  'file.lwcap.gapOrder',
  'file.lwcap.channelHeaders',
  'file.lwcap.initial',
  'file.lwcap.edgeBytes',
  'file.lwcap.edgeRange',
  'file.lwcap.edgeOrder',
  'file.sr.notZip',
  'file.sr.multiDisk',
  'file.sr.corruptDirectory',
  'file.sr.directoryBounds',
  'file.sr.zip64',
  'file.sr.entrySignature',
  'file.sr.dataDescriptor',
  'file.sr.memberZip64',
  'file.sr.compression',
  'file.sr.noLocalHeader',
  'file.sr.localHeaderBounds',
  'file.sr.memberPastEnd',
  'file.sr.memberSize',
  'file.sr.inflateFailed',
  'file.sr.inflateSize',
  'file.sr.noMetadata',
  'file.sr.duplicateCapturefile',
  'file.sr.analogCapture',
  'file.sr.noCapturefile',
  'file.sr.noSamplerate',
  'file.sr.probes',
  'file.sr.analogChannels',
  'file.sr.unitsize',
  'file.sr.unitsizeProbes',
  'file.sr.samplerate',
  'file.sr.dataLength',
  'file.sr.tooLong',
  'file.sr.noData',
  'device.transportDead',
  'device.workerUnavailable',
  'device.workerCrashed',
  'device.workerTimeout',
  'device.workerNoDevice',
  'device.workerTerminated',
  'device.workerNoStats',
  'device.workerNoConsole',
  'device.workerUnclaimed',
  'device.stopTimedOut',
  'device.loopUnsettled',
  'device.loopUnsettledClosed',
  'device.reclaimFailed',
  'device.unsupportedChannels',
  'device.unsupportedSamplerate',
  'device.rateCeiling',
  'device.threshold',
  'device.testMode',
  'device.tuningPacket',
  'device.tuningDepth',
  'device.tuningTransfer',
  'device.tuningQueue',
  'device.startRunning',
  'device.startStopping',
  'device.startBeforeOpen',
  'device.triggerLimitConflict',
  'device.coalescePacket',
  'device.triggerWidth',
  'device.bulkStatus',
  'device.bulkEmpty',
  'device.consoleBusy',
  'device.notOpen',
  'device.noData',
  'device.underrunStalled',
  'device.underrunClean',
  'device.openFailed',
  'device.configureFailed',
  'device.claimFailed',
  'usb.unavailable',
  'usb.blocked',
  'usb.notVisible',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly vars?: DiagnosticVars;
  readonly payload?: string;
}

interface DiagnosticLike {
  name: string;
  code?: unknown;
  vars?: unknown;
  payload?: unknown;
}

function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return DIAGNOSTIC_CODES.some((code) => code === value);
}

function isDiagnosticVars(value: unknown): value is DiagnosticVars {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).every(([, v]) => typeof v === 'string' || typeof v === 'number');
}

function diagnosticFrom(fields: DiagnosticLike): Diagnostic | null {
  if (!isDiagnosticCode(fields.code)) return null;
  const vars = isDiagnosticVars(fields.vars) ? fields.vars : undefined;
  return {
    code: fields.code,
    ...(vars ? { vars } : {}),
    ...(typeof fields.payload === 'string' ? { payload: fields.payload } : {}),
  };
}

function isDiagnosticLike(error: unknown): error is DiagnosticLike {
  return error instanceof Error &&
    (error.name === 'DiagnosticError' || error instanceof DiagnosticError);
}

export class DiagnosticError extends Error {
  readonly code: DiagnosticCode;
  readonly vars?: DiagnosticVars;
  readonly payload?: string;

  constructor(code: DiagnosticCode, vars?: DiagnosticVars, payload?: string) {
    super(code);
    this.name = 'DiagnosticError';
    this.code = code;
    if (vars) this.vars = vars;
    if (payload !== undefined) this.payload = payload;
  }
}

export function diagnosticOf(error: unknown): Diagnostic | null {
  return isDiagnosticLike(error) ? diagnosticFrom(error) : null;
}

export function wireDiagnostic(
  error: unknown,
): Pick<Diagnostic, 'code' | 'vars' | 'payload'> | null {
  return diagnosticOf(error);
}

export function fromWireDiagnostic(wire: {
  message: string;
  code?: string;
  vars?: DiagnosticVars;
  payload?: string;
}): Error {
  if (!isDiagnosticCode(wire.code)) return new Error(wire.message);
  return new DiagnosticError(wire.code, wire.vars, wire.payload);
}
