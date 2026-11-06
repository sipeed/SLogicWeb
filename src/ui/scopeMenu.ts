// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The analog ruler's context menu (right-click, or a long press on touch): the row's
 * vertical view actions - Autoset and Reset - at the pointer. DESIGN.md §5.2 keeps the
 * row's actions to the trigger slot and the row entry; the ruler is direct manipulation
 * of the same view values, so its menu adds no row chrome. The same actions are on the
 * focused ruler's keys (`A`, `Home`).
 *
 * Built only while open, styled as the settings menu, closed by a pick, Escape, an
 * outside pointer-down, a resize or scroll.
 */

export interface ScopeMenuItem {
  label: string;
  hint: string;
  onPick: () => void;
}

let open: { menu: HTMLDivElement; close: (refocus: boolean) => void } | null = null;

export function closeScopeMenu(): void {
  open?.close(false);
}

export function openScopeMenu(
  x: number, y: number, anchor: HTMLElement, items: readonly ScopeMenuItem[],
): void {
  closeScopeMenu();
  const menu = document.createElement('div');
  menu.className = 'settings-menu scope-menu';
  const close = (refocus: boolean): void => {
    if (open?.menu !== menu) return;
    open = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', dismiss);
    window.removeEventListener('scroll', dismiss, true);
    menu.remove();
    if (refocus) anchor.focus({ preventScroll: true });
  };
  const outside = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node)) close(false);
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close(true);
  };
  const dismiss = (): void => close(false);
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-item';
    const label = document.createElement('span');
    label.textContent = item.label;
    const hint = document.createElement('span');
    hint.className = 'settings-hint';
    hint.textContent = item.hint;
    row.append(label, hint);
    row.addEventListener('click', () => {
      close(true);
      item.onPick();
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // Open left of the pointer (the ruler sits at the plot's right edge), kept on screen.
  const margin = 6;
  const left = Math.max(margin, Math.min(x - menu.offsetWidth, window.innerWidth - menu.offsetWidth - margin));
  const top = Math.max(margin, Math.min(y, window.innerHeight - menu.offsetHeight - margin));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  open = { menu, close };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', dismiss);
  window.addEventListener('scroll', dismiss, true);
  menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}
