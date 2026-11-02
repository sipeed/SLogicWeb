// SPDX-License-Identifier: GPL-3.0-or-later

export type DiagnosticVars = Record<string, string | number>;

export const DIAGNOSTIC_CODES = ['ui.localeLoad', 'io.nothingToSave'] as const;

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
