import type { MessageKey } from './i18n.js';

export type ShortcutId = 'capture.toggle' | 'view.fit' | 'cursors.clear';

export interface ShortcutEntry {
  readonly id: ShortcutId;
  readonly key: string;
  readonly notation: string;
  readonly labels: readonly MessageKey[];
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: 'capture.toggle', key: ' ', notation: 'Space', labels: ['toolbar.start', 'toolbar.stop'] },
  { id: 'view.fit', key: 'f', notation: 'F', labels: ['toolbar.fit'] },
  { id: 'cursors.clear', key: 'Escape', notation: 'Esc', labels: ['shortcuts.clearCursors'] },
];

export function shortcutIdFor(key: string): ShortcutId | null {
  for (const entry of SHORTCUTS) {
    if (entry.key === key) return entry.id;
  }
  return null;
}
