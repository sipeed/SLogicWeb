export interface ChordPress {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing?: boolean;
}

export const MAX_KEYS = 4;

export const CHORD_ALIASES: Readonly<Record<string, string>> = { '=': '+', '_': '-' };

export const APPLE: boolean = (() => {
  const scope = globalThis as { navigator?: { platform?: string; userAgent?: string } };
  const nav = scope.navigator;
  if (nav === undefined) return false;
  return /mac|iphone|ipad|ipod/i.test(`${nav.platform ?? ''} ${nav.userAgent ?? ''}`);
})();

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

const KNOWN_MODIFIERS: readonly string[] = MODIFIER_ORDER;

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Alt', 'AltGraph', 'CapsLock', 'Control', 'Fn', 'FnLock', 'Hyper', 'Meta', 'NumLock',
  'OS', 'ScrollLock', 'Shift', 'Super', 'Symbol', 'SymbolLock',
]);

const DEAD_KEYS: ReadonlySet<string> = new Set(['Dead', 'Unidentified', 'Process']);

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Escape: 'Esc',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
};

const APPLE_MODIFIERS: Readonly<Record<string, string>> = {
  Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧',
};

const TEXT_MODIFIERS: Readonly<Record<string, string>> = { Mod: 'Ctrl' };

export function chordOf(press: ChordPress, apple = APPLE): string | null {
  if (press.isComposing === true) return null;
  if (!apple && press.metaKey) return null;
  const key = keyToken(press.key);
  if (key === null) return null;
  const modifiers = modifierParts(press, apple)
    .filter((name) => name !== 'Shift' || !isSymbolKey(key));
  if (modifiers.length + 1 > MAX_KEYS) return null;
  return [...modifiers, key].join('+');
}

export function formatChord(chord: string, apple = APPLE): string {
  const { modifiers, key } = splitChord(chord);
  if (key === '') return '';
  const label = KEY_LABELS[key] ?? key;
  if (apple) {
    return modifiers.map((name) => APPLE_MODIFIERS[name] ?? name).join('') + label;
  }
  return [...modifiers.map((name) => TEXT_MODIFIERS[name] ?? name), label].join('+');
}

function modifierParts(press: ChordPress, apple: boolean): readonly string[] {
  const held: Readonly<Record<string, boolean>> = {
    Mod: apple ? press.metaKey : press.ctrlKey,
    Ctrl: apple && press.ctrlKey,
    Alt: press.altKey,
    Shift: press.shiftKey,
  };
  return MODIFIER_ORDER.filter((name) => held[name] === true);
}

function keyToken(raw: string): string | null {
  if (raw === '' || MODIFIER_KEYS.has(raw) || DEAD_KEYS.has(raw)) return null;
  if (raw === ' ') return 'Space';
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

function isSymbolKey(key: string): boolean {
  return key.length === 1 && /[^A-Za-z0-9]/.test(key);
}

function splitChord(chord: string): { modifiers: string[]; key: string } {
  const modifiers: string[] = [];
  let rest = chord;
  for (;;) {
    const at = rest.indexOf('+');
    if (at <= 0) break;
    const head = rest.slice(0, at);
    if (!KNOWN_MODIFIERS.includes(head)) break;
    modifiers.push(head);
    rest = rest.slice(at + 1);
  }
  return { modifiers, key: rest };
}
