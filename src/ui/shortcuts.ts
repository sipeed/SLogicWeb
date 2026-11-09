import type { MessageKey } from './i18n.js';

export type ShortcutId =
  | 'capture.toggle' | 'view.fit' | 'cursors.clear'
  | 'view.zoomIn' | 'view.zoomOut' | 'view.panLeft' | 'view.panRight';

export interface ShortcutEntry {
  readonly id: ShortcutId;
  readonly key: string;
  readonly aliases?: readonly string[];
  readonly notation: string;
  readonly labels: readonly MessageKey[];
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { id: 'capture.toggle', key: ' ', notation: 'Space', labels: ['toolbar.start', 'toolbar.stop'] },
  { id: 'view.fit', key: 'f', notation: 'F', labels: ['toolbar.fit'] },
  { id: 'cursors.clear', key: 'Escape', notation: 'Esc', labels: ['shortcuts.clearCursors'] },
  { id: 'view.zoomIn', key: '+', aliases: ['='], notation: '+ / =', labels: ['shortcuts.zoomIn'] },
  { id: 'view.zoomOut', key: '-', aliases: ['_'], notation: '-', labels: ['shortcuts.zoomOut'] },
  { id: 'view.panLeft', key: 'ArrowLeft', notation: '←', labels: ['shortcuts.panLeft'] },
  { id: 'view.panRight', key: 'ArrowRight', notation: '→', labels: ['shortcuts.panRight'] },
];

export interface GestureEntry {
  readonly modifiers: readonly string[];
  readonly input: MessageKey;
  readonly labels: readonly MessageKey[];
}

export function referenceGestures(wheelZooms: boolean): readonly GestureEntry[] {
  const wheel: GestureEntry[] = wheelZooms
    ? [
      { modifiers: [], input: 'shortcuts.input.wheel', labels: ['shortcuts.zoomTime'] },
      { modifiers: ['Ctrl'], input: 'shortcuts.input.wheel', labels: ['shortcuts.scrollRows'] },
    ]
    : [
      { modifiers: [], input: 'shortcuts.input.wheel', labels: ['shortcuts.scrollRows'] },
      { modifiers: ['Ctrl'], input: 'shortcuts.input.wheel', labels: ['shortcuts.zoomTime'] },
    ];
  return [
    ...wheel,
    { modifiers: ['Shift'], input: 'shortcuts.input.wheel', labels: ['shortcuts.panTime'] },
    { modifiers: ['Shift'], input: 'shortcuts.input.arrows', labels: ['shortcuts.panPage'] },
    { modifiers: [], input: 'shortcuts.input.drag', labels: ['shortcuts.panTime'] },
    { modifiers: [], input: 'shortcuts.input.doubleClick', labels: ['shortcuts.addCursor'] },
    { modifiers: [], input: 'shortcuts.input.pinch', labels: ['shortcuts.zoomTime'] },
  ];
}

export function shortcutIdFor(key: string): ShortcutId | null {
  for (const entry of SHORTCUTS) {
    if (entry.key === key || entry.aliases?.includes(key) === true) return entry.id;
  }
  return null;
}
