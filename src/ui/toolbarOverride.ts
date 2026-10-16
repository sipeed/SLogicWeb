export interface ToolbarOverride {
  height: number | null;
  minHeight: number | null;
  minRatio: number | null;
}

export const TOOLBAR_OVERRIDE_STORAGE_KEY = 'logicweb.toolbar';

export const TOOLBAR_OVERRIDE_LIMITS = {
  height: { min: 24, max: 240 },
  minHeight: { min: 0, max: 240 },
  minRatio: { min: 0, max: 50 },
} as const;

const HEIGHT_PROPERTY = '--toolbar-height';
const MIN_HEIGHT_PROPERTY = '--toolbar-min-height';
const MIN_RATIO_PROPERTY = '--toolbar-min-ratio';

const EMPTY: ToolbarOverride = { height: null, minHeight: null, minRatio: null };

let current: ToolbarOverride = { ...EMPTY };
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
    return storage()?.getItem(TOOLBAR_OVERRIDE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function normalizeField(value: unknown, limits: { min: number; max: number }): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(limits.max, Math.max(limits.min, Math.round(value)));
}

function normalize(raw: { height?: unknown; minHeight?: unknown; minRatio?: unknown }): ToolbarOverride {
  return {
    height: normalizeField(raw.height, TOOLBAR_OVERRIDE_LIMITS.height),
    minHeight: normalizeField(raw.minHeight, TOOLBAR_OVERRIDE_LIMITS.minHeight),
    minRatio: normalizeField(raw.minRatio, TOOLBAR_OVERRIDE_LIMITS.minRatio),
  };
}

function isAllNull(o: ToolbarOverride): boolean {
  return o.height === null && o.minHeight === null && o.minRatio === null;
}

function equal(a: ToolbarOverride, b: ToolbarOverride): boolean {
  return a.height === b.height && a.minHeight === b.minHeight && a.minRatio === b.minRatio;
}

function persist(o: ToolbarOverride): void {
  try {
    const store = storage();
    if (store === null) return;
    if (isAllNull(o)) {
      store.removeItem(TOOLBAR_OVERRIDE_STORAGE_KEY);
      return;
    }
    const payload: Record<string, number> = {};
    if (o.height !== null) payload.height = o.height;
    if (o.minHeight !== null) payload.minHeight = o.minHeight;
    if (o.minRatio !== null) payload.minRatio = o.minRatio;
    store.setItem(TOOLBAR_OVERRIDE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
  }
}

function setProperty(style: CSSStyleDeclaration, name: string, value: string | null): void {
  if (value === null) style.removeProperty(name);
  else style.setProperty(name, value);
}

function notify(): void {
  for (const cb of listeners) cb();
}

export function sanitizeToolbarOverride(raw: string | null): ToolbarOverride {
  if (raw === null) return { ...EMPTY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...EMPTY };
  return normalize(parsed as Record<string, unknown>);
}

export function getToolbarOverride(): ToolbarOverride {
  return { ...current };
}

export function applyToolbarOverride(o: ToolbarOverride): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement.style;
  setProperty(style, HEIGHT_PROPERTY, o.height === null ? null : `${o.height}px`);
  setProperty(style, MIN_HEIGHT_PROPERTY, o.minHeight === null ? null : `${o.minHeight}px`);
  setProperty(style, MIN_RATIO_PROPERTY, o.minRatio === null ? null : `${o.minRatio}vh`);
}

export function setToolbarOverride(next: ToolbarOverride): void {
  const clamped = normalize(next);
  if (equal(clamped, current)) return;
  current = clamped;
  persist(clamped);
  applyToolbarOverride(clamped);
  notify();
}

export function clearToolbarOverride(): void {
  const changed = !isAllNull(current);
  current = { ...EMPTY };
  persist(current);
  applyToolbarOverride(current);
  if (changed) notify();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== TOOLBAR_OVERRIDE_STORAGE_KEY && event.key !== null) return;
  const restored = sanitizeToolbarOverride(readStored());
  if (equal(restored, current)) return;
  current = restored;
  applyToolbarOverride(restored);
  notify();
}

export function initToolbarOverride(): ToolbarOverride {
  const restored = sanitizeToolbarOverride(readStored());
  current = restored;
  applyToolbarOverride(restored);
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
    listening = true;
  }
  return { ...current };
}

export function onToolbarOverrideChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
