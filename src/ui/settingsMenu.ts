// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * The toolbar settings menu - a transient dropdown anchored to the Settings button.
 *
 * Shape: a disclosure (aria-expanded + aria-controls on the persistent button), not
 * ARIA menu roles - the rows are plain <button>s with ordinary Tab navigation.
 * The Language row carries
 * the current locale's native label as its hint and toggles a flyout that opens LEFT
 * (the menu is right-anchored at the viewport edge, so rightward would clip).
 *
 * Lifecycle rules (events-and-lifecycle.md): the menu exists in the DOM only while
 * open, so it can never hold stale text across a locale switch, and its three
 * document/window listeners (pointerdown capture, keydown capture, resize) are added
 * on open and removed on close, never outliving the element that installed them.
 *
 * Positioning: `position: fixed` anchored with the `right` property derived from the
 * anchor's getBoundingClientRect() at every open (the toolbar wraps on narrow screens,
 * so the rect is never cached), which right-aligns the panel without ever measuring
 * its width. The flyout is an absolutely-positioned CHILD of the menu, so a single
 * `menu.contains(target)` answers the click-outside question for both.
 *
 * Only one overlay may be open at a time: App closes the native channel-settings
 * dialog before opening this menu. The dialog's inert underlay already prevents the
 * reverse pointer path; this guard also covers programmatic entry.
 */

export interface SettingsMenuItem {
  /** Display text, already translated by the caller (t() at build time). */
  label: string;
  /** Right-aligned dim hint - the Language row shows the active locale's name + ▸. */
  hint?: string;
  /** Leaf rows: a checkmark in the reserved column. */
  checked?: boolean;
  /** Leaf rows: the pick action. */
  onPick?: () => void;
  /** Non-leaf rows: flyout content. */
  children?: SettingsMenuItem[];
}

/** Why the menu closed - decides whether focus returns to the anchor. */
export type CloseReason = 'escape' | 'pick' | 'toggle' | 'outside' | 'resize' | 'retranslate' | 'theme' | 'channelLabels';

export class SettingsMenu {
  private menu: HTMLDivElement | null = null;

  constructor(
    private readonly anchor: HTMLButtonElement,
    private readonly menuId: string = 'settings-menu',
  ) {}

  toggle(items: readonly SettingsMenuItem[]): void {
    if (this.menu) this.close('toggle');
    else this.open(items);
  }

  open(items: readonly SettingsMenuItem[]): void {
    if (this.menu) this.close('toggle'); // re-open while open rebuilds, never stacks
    const menu = document.createElement('div');
    menu.className = 'settings-menu';
    menu.id = this.menuId;
    for (const item of items) menu.appendChild(this.buildRow(item));
    document.body.appendChild(menu);

    // Right-align to the anchor's right edge; width stays content-driven.
    const rect = this.anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 4)}px`;
    menu.style.right = `${Math.round(window.innerWidth - rect.right)}px`;

    this.menu = menu;
    this.anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('resize', this.onResize);
    // Keyboard users landing here via Enter need focus inside, not a Tab walk past it.
    (menu.firstElementChild as HTMLElement | null)?.focus();
  }

  close(reason: CloseReason): void {
    const menu = this.menu;
    if (!menu) return;
    this.menu = null;
    document.removeEventListener('pointerdown', this.onOutsidePointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('resize', this.onResize);
    this.anchor.setAttribute('aria-expanded', 'false');
    menu.remove();
    // Focus dies with the node unless we hand it back - but an outside click has its
    // own target, and resize/retranslate are system events; neither is ours to steal.
    if (reason === 'escape' || reason === 'pick') this.anchor.focus();
  }

  private buildRow(item: SettingsMenuItem): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'settings-item';

    // The check column is always reserved so labels stay x-aligned across rows.
    const check = document.createElement('span');
    check.className = 'settings-check';
    check.setAttribute('aria-hidden', 'true');
    check.textContent = item.checked ? '✓' : '';
    row.appendChild(check);

    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);

    if (item.hint !== undefined) {
      const hint = document.createElement('span');
      hint.className = 'settings-hint';
      hint.textContent = item.hint;
      row.appendChild(hint);
    }

    const children = item.children;
    if (children) {
      row.addEventListener('click', () => this.toggleFlyout(row, children));
    } else {
      if (item.checked) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => {
        // Close before picking: a pick that actually changes locale re-enters through
        // onLocaleChange -> App.retranslate() -> close('retranslate'), which removes
        // the menu without restoring focus - so this 'pick' close must run first to
        // hand focus back to the anchor.
        this.close('pick');
        item.onPick?.();
      });
    }
    return row;
  }

  private toggleFlyout(row: HTMLButtonElement, children: SettingsMenuItem[]): void {
    const menu = this.menu;
    if (!menu) return;
    const existing = menu.querySelector('.settings-flyout');
    const wasOpenForThisRow = existing !== null && row.classList.contains('open');
    existing?.remove();
    menu.querySelector('.settings-item.open')?.classList.remove('open');
    if (wasOpenForThisRow) return;

    const flyout = document.createElement('div');
    flyout.className = 'settings-flyout';
    for (const child of children) flyout.appendChild(this.buildRow(child));
    // Child of the menu: one containment root for outside-dismiss, and `right: 100%`
    // parks it left of the menu with no rect math. Top aligns with the row.
    flyout.style.top = `${row.offsetTop}px`;
    menu.appendChild(flyout);
    row.classList.add('open');
  }

  private readonly onOutsidePointerDown = (event: PointerEvent): void => {
    if (this.menu?.contains(event.target as Node) || this.anchor.contains(event.target as Node)) return;
    this.close('outside');
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    this.close('escape');
    // Keep Escape owned by this transient menu rather than leaking to shell shortcuts.
    event.stopPropagation();
  };

  private readonly onResize = (): void => {
    // The anchor moves when the wrapped toolbar reflows; the menu is transient, so
    // closing beats re-anchoring.
    this.close('resize');
  };
}
