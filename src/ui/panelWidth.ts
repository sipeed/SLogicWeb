export const PANEL_WIDTH_STORAGE_KEY = 'logicweb.panelWidth';

export const PANEL_WIDTH_DEFAULT = 296;
export const PANEL_WIDTH_MIN = 240;
export const PANEL_WIDTH_MAX = 560;
export const PANEL_WIDTH_RESERVE = 320;
export const PANEL_WIDTH_STEP = 16;

const WIDTH_PROPERTY = '--side-panel-w';

let current: number | null = null;
let listening = false;

const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(): string | null {
  try {
    return storage()?.getItem(PANEL_WIDTH_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function persist(width: number | null): void {
  try {
    const store = storage();
    if (store === null) return;
    if (width === null) {
      store.removeItem(PANEL_WIDTH_STORAGE_KEY);
      return;
    }
    store.setItem(PANEL_WIDTH_STORAGE_KEY, String(width));
  } catch {
  }
}

function notify(): void {
  for (const cb of listeners) cb();
}

function upperBound(maxWidth: number): number {
  if (!Number.isFinite(maxWidth)) return PANEL_WIDTH_MAX;
  const rounded = Math.round(maxWidth);
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, rounded));
}

function clampWidth(value: number, maxWidth: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : PANEL_WIDTH_DEFAULT;
  return Math.min(upperBound(maxWidth), Math.max(PANEL_WIDTH_MIN, rounded));
}

export function clampPanelWidth(width: number): number {
  return clampWidth(width, PANEL_WIDTH_MAX);
}

export function maxPanelWidth(rowWidthPx: number): number {
  if (!Number.isFinite(rowWidthPx)) return PANEL_WIDTH_MIN;
  const available = Math.round(rowWidthPx) - PANEL_WIDTH_RESERVE;
  return Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, available));
}

export function sanitizePanelWidth(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return clampPanelWidth(parsed);
}

export function getPanelWidth(): number | null {
  return current;
}

export function applyPanelWidth(width: number | null): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  if (width === null) style.removeProperty(WIDTH_PROPERTY);
  else style.setProperty(WIDTH_PROPERTY, `${width}px`);
}

export function setPanelWidth(width: number | null): void {
  const clamped = width === null ? null : clampPanelWidth(width);
  const next = clamped === PANEL_WIDTH_DEFAULT ? null : clamped;
  if (next === current) return;
  current = next;
  persist(next);
  applyPanelWidth(next);
  notify();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== PANEL_WIDTH_STORAGE_KEY && event.key !== null) return;
  const restored = sanitizePanelWidth(readStored());
  if (restored === current) return;
  current = restored;
  applyPanelWidth(restored);
  notify();
}

export function initPanelWidth(): number | null {
  current = sanitizePanelWidth(readStored());
  applyPanelWidth(current);
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
    listening = true;
  }
  return current;
}

export function onPanelWidthChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function widthFromPointer(
  startWidth: number,
  startX: number,
  clientX: number,
  maxWidth: number,
): number {
  return clampWidth(startWidth + (startX - clientX), maxWidth);
}

export function widthFromKey(
  currentWidth: number,
  key: string,
  shift: boolean,
  maxWidth: number,
): number | null {
  const step = shift ? PANEL_WIDTH_STEP * 4 : PANEL_WIDTH_STEP;
  switch (key) {
    case 'ArrowLeft': return clampWidth(currentWidth + step, maxWidth);
    case 'ArrowRight': return clampWidth(currentWidth - step, maxWidth);
    case 'Home': return clampWidth(PANEL_WIDTH_MIN, maxWidth);
    case 'End': return clampWidth(upperBound(maxWidth), maxWidth);
    case 'Enter': return clampWidth(PANEL_WIDTH_DEFAULT, maxWidth);
    case ' ': return clampWidth(PANEL_WIDTH_DEFAULT, maxWidth);
    default: return null;
  }
}
