// SPDX-License-Identifier: GPL-3.0-or-later

import {
  MEASUREMENT_CATALOG, isMeasurementParameter, type MeasurementParameter,
} from './measurementCatalog.js';

export interface MeasurementRow {
  readonly id: number;
  readonly start: number;
  readonly parameter: MeasurementParameter;
}

export interface MeasurementRowState {
  readonly rows: readonly MeasurementRow[];
  readonly nextId: number;
  readonly filter: number | null;
  readonly undo: { readonly rows: readonly MeasurementRow[]; readonly nextId: number } | null;
}

export const MEASUREMENT_MAX_ROWS: number = 64;

export function emptyMeasurementRows(): MeasurementRowState {
  return { rows: [], nextId: 1, filter: null, undo: null };
}

function isValidStart(start: number): boolean {
  return Number.isSafeInteger(start) && start >= 0;
}

function rowIndex(
  state: MeasurementRowState, start: number, parameter: MeasurementParameter,
): number {
  return state.rows.findIndex((row) => row.start === start && row.parameter === parameter);
}

export function addMeasurementRow(
  state: MeasurementRowState, start: number, parameter: MeasurementParameter,
): MeasurementRowState {
  if (!isValidStart(start) || !isMeasurementParameter(parameter)) return state;
  if (state.rows.length >= MEASUREMENT_MAX_ROWS) return state;
  if (rowIndex(state, start, parameter) >= 0) return state;
  return {
    rows: [...state.rows, { id: state.nextId, start, parameter }],
    nextId: state.nextId + 1,
    filter: state.filter,
    undo: null,
  };
}

export function toggleMeasurementRow(
  state: MeasurementRowState, start: number, parameter: MeasurementParameter,
): MeasurementRowState {
  const index = rowIndex(state, start, parameter);
  if (index < 0) return addMeasurementRow(state, start, parameter);
  return removeMeasurementRow(state, state.rows[index].id);
}

export function removeMeasurementRow(
  state: MeasurementRowState, id: number,
): MeasurementRowState {
  const index = state.rows.findIndex((row) => row.id === id);
  if (index < 0) return state;
  const removed = state.rows[index];
  const rows = state.rows.filter((_, at) => at !== index);
  const startGone = !rows.some((row) => row.start === removed.start);
  return {
    rows,
    nextId: state.nextId,
    filter: state.filter === removed.start && startGone ? null : state.filter,
    undo: null,
  };
}

export function clearMeasurementRows(state: MeasurementRowState): MeasurementRowState {
  if (state.rows.length === 0) return state;
  return {
    rows: [],
    nextId: state.nextId,
    filter: null,
    undo: { rows: state.rows, nextId: state.nextId },
  };
}

export function undoClearMeasurementRows(state: MeasurementRowState): MeasurementRowState {
  if (state.undo === null) return state;
  return {
    rows: state.undo.rows,
    nextId: state.undo.nextId,
    filter: state.filter,
    undo: null,
  };
}

export function pruneMeasurementRows(
  state: MeasurementRowState, validStarts: readonly number[],
): MeasurementRowState {
  const valid = new Set(validStarts);
  const rows = state.rows.filter((row) => valid.has(row.start));
  const staleUndo = state.undo !== null &&
    state.undo.rows.some((row) => !valid.has(row.start));
  const filterGone = state.filter !== null && !valid.has(state.filter);
  if (rows.length === state.rows.length && !staleUndo && !filterGone) return state;
  return {
    rows,
    nextId: state.nextId,
    filter: filterGone ? null : state.filter,
    undo: staleUndo ? null : state.undo,
  };
}

export function setMeasurementFilter(
  state: MeasurementRowState, start: number | null,
): MeasurementRowState {
  if (start !== null && !isValidStart(start)) return state;
  if (state.filter === start) return state;
  return { rows: state.rows, nextId: state.nextId, filter: start, undo: state.undo };
}

export function visibleMeasurementRows(state: MeasurementRowState): readonly MeasurementRow[] {
  if (state.filter === null) return state.rows;
  return state.rows.filter((row) => row.start === state.filter);
}

export function availableMeasurementParameters(
  state: MeasurementRowState, start: number,
): readonly MeasurementParameter[] {
  const taken = new Set(
    state.rows.filter((row) => row.start === start).map((row) => row.parameter));
  return MEASUREMENT_CATALOG
    .map((entry) => entry.parameter)
    .filter((parameter) => !taken.has(parameter));
}

export function measurementRowKey(row: MeasurementRow): string {
  return `${row.start}:${row.parameter}`;
}
