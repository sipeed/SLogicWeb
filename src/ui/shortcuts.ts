export type ShortcutId = 'capture.toggle' | 'view.fit' | 'cursors.clear';

export interface ShortcutEntry {
  readonly id: ShortcutId;
  readonly key: string;
  readonly notation: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: 'capture.toggle', key: ' ', notation: 'Space' },
  { id: 'view.fit', key: 'f', notation: 'F' },
  { id: 'cursors.clear', key: 'Escape', notation: 'Esc' },
];

export function shortcutIdFor(key: string): ShortcutId | null {
  for (const entry of SHORTCUTS) {
    if (entry.key === key) return entry.id;
  }
  return null;
}
