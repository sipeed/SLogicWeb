import { t } from './i18n.js';
import type { MessageKey } from './i18n.js';
import { CHORD_ALIASES } from './chords.js';

export type ShortcutId =
  | 'file.open' | 'file.save' | 'settings.open'
  | 'capture.toggle' | 'view.fit' | 'cursors.clear'
  | 'view.zoomIn' | 'view.zoomOut' | 'view.panLeft' | 'view.panRight';

export type ShortcutGroup = 'file' | 'view' | 'navigation';

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['file', 'view', 'navigation'];

const GROUP_LABELS: Record<ShortcutGroup, MessageKey> = {
  file: 'shortcuts.group.file',
  view: 'shortcuts.group.view',
  navigation: 'shortcuts.group.navigation',
};

export interface ShortcutEntry {
  readonly id: ShortcutId;
  readonly group: ShortcutGroup;
  readonly chords: readonly string[];
  readonly labels: readonly MessageKey[];
  readonly anywhere?: boolean;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: 'file.open', group: 'file', chords: ['Mod+O'], labels: ['shortcuts.open'], anywhere: true,
  },
  {
    id: 'file.save', group: 'file', chords: ['Mod+S'], labels: ['shortcuts.save'], anywhere: true,
  },
  {
    id: 'settings.open', group: 'file', chords: ['Mod+,'], labels: ['shortcuts.settings'],
    anywhere: true,
  },
  {
    id: 'capture.toggle', group: 'view', chords: ['Space'],
    labels: ['toolbar.start', 'toolbar.stop'],
  },
  { id: 'view.fit', group: 'view', chords: ['F'], labels: ['toolbar.fit'] },
  { id: 'cursors.clear', group: 'view', chords: ['Escape'], labels: ['shortcuts.clearCursors'] },
  { id: 'view.zoomIn', group: 'view', chords: ['+', '='], labels: ['shortcuts.zoomIn'] },
  { id: 'view.zoomOut', group: 'view', chords: ['-', '_'], labels: ['shortcuts.zoomOut'] },
  { id: 'view.panLeft', group: 'view', chords: ['ArrowLeft'], labels: ['shortcuts.panLeft'] },
  { id: 'view.panRight', group: 'view', chords: ['ArrowRight'], labels: ['shortcuts.panRight'] },
];

export const WORK_ANYWHERE: ReadonlySet<ShortcutId> = new Set(
  SHORTCUTS.filter((entry) => entry.anywhere === true).map((entry) => entry.id),
);

export function actionOf(chord: string): ShortcutId | null {
  const direct = SHORTCUTS.find((entry) => entry.chords.includes(chord));
  if (direct !== undefined) return direct.id;
  if (!Object.hasOwn(CHORD_ALIASES, chord)) return null;
  const alias = CHORD_ALIASES[chord];
  return SHORTCUTS.find((entry) => entry.chords.includes(alias))?.id ?? null;
}

export function shortcutsIn(group: ShortcutGroup): readonly ShortcutEntry[] {
  return SHORTCUTS.filter((entry) => entry.group === group);
}

export function shortcutGroupLabel(group: ShortcutGroup): string {
  return t(GROUP_LABELS[group]);
}

export function referenceGroups(): readonly ShortcutGroup[] {
  return SHORTCUT_GROUPS.filter((group) => shortcutsIn(group).length > 0);
}

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

export function shortcutActionText(entry: ShortcutEntry | GestureEntry): string {
  return entry.labels.map((key) => t(key)).join(' / ');
}

export function gestureNotation(entry: GestureEntry): string {
  return [...entry.modifiers, t(entry.input)].join(' + ');
}
