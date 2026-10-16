import {
  clearToolbarOverride,
  getToolbarOverride,
  initToolbarOverride,
  onToolbarOverrideChange,
  setToolbarOverride,
  type ToolbarOverride,
} from '../src/ui/toolbarOverride.js';

const FIELD_KEYS = ['height', 'minHeight', 'minRatio'] as const;

type FieldKey = (typeof FIELD_KEYS)[number];

const FIELD_IDS: Record<FieldKey, string> = {
  height: 'uictrl-toolbar-height',
  minHeight: 'uictrl-toolbar-min-height',
  minRatio: 'uictrl-toolbar-min-ratio',
};

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`uictrl/index.html is missing #${id}`);
  return el as T;
}

function formatValue(value: number | null): string {
  return value === null ? '' : String(value);
}

function readField(input: HTMLInputElement): number | null {
  if (input.value.trim() === '') return null;
  const value = input.valueAsNumber;
  return Number.isFinite(value) ? value : null;
}

const inputs: Record<FieldKey, HTMLInputElement> = {
  height: must<HTMLInputElement>(FIELD_IDS.height),
  minHeight: must<HTMLInputElement>(FIELD_IDS.minHeight),
  minRatio: must<HTMLInputElement>(FIELD_IDS.minRatio),
};

function fillAll(): void {
  const state = getToolbarOverride();
  for (const key of FIELD_KEYS) inputs[key].value = formatValue(state[key]);
}

function commit(key: FieldKey): void {
  const next: ToolbarOverride = getToolbarOverride();
  next[key] = readField(inputs[key]);
  setToolbarOverride(next);
  inputs[key].value = formatValue(getToolbarOverride()[key]);
}

for (const key of FIELD_KEYS) {
  inputs[key].addEventListener('change', () => { commit(key); });
}

must<HTMLButtonElement>('uictrl-toolbar-reset').addEventListener('click', () => {
  clearToolbarOverride();
  fillAll();
});

onToolbarOverrideChange(() => {
  const state = getToolbarOverride();
  for (const key of FIELD_KEYS) {
    const input = inputs[key];
    if (input === document.activeElement) continue;
    input.value = formatValue(state[key]);
  }
});

initToolbarOverride();
fillAll();
