import type { CloseReason } from './settingsMenu.js';

export interface ExclusiveMenu {
  readonly id: string;
  close(reason: CloseReason): void;
}

export class MenuStack {
  private readonly menus: ExclusiveMenu[] = [];

  register(menu: ExclusiveMenu): void {
    if (this.menus.includes(menu)) return;
    this.menus.push(menu);
  }

  closeOthers(keep: ExclusiveMenu | null, reason: CloseReason): void {
    for (const menu of this.menus) {
      if (menu !== keep) menu.close(reason);
    }
  }

  closeAll(reason: CloseReason): void {
    for (const menu of this.menus) menu.close(reason);
  }
}
