// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A destructive confirmation (DESIGN §12, presenters' `destructive-confirmation`): a
 * native modal `<dialog>` with the shortcuts dialog's anatomy - title, one sentence, and
 * Cancel / confirm in the footer. `ask` resolves true only for the confirm button; Esc,
 * the platform back gesture (`cancel`), a backdrop click and Cancel all resolve false.
 * Focus starts on Cancel (the safe choice) and returns to the invoker on close.
 */

export interface ConfirmText {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
}

export class ConfirmDialog {
  private dialog: HTMLDialogElement | null = null;
  private title: HTMLHeadingElement | null = null;
  private body: HTMLParagraphElement | null = null;
  private confirmButton: HTMLButtonElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private resolve: ((ok: boolean) => void) | null = null;
  private invoker: HTMLElement | null = null;

  get isOpen(): boolean {
    return this.dialog?.open === true;
  }

  ask(text: ConfirmText, invoker: HTMLElement | null = null): Promise<boolean> {
    // A second request while one is open answers the first with "no".
    this.finish(false);
    const dialog = this.ensure();
    this.title!.textContent = text.title;
    this.body!.textContent = text.body;
    this.confirmButton!.textContent = text.confirm;
    this.cancelButton!.textContent = text.cancel;
    this.invoker = invoker ?? (document.activeElement as HTMLElement | null);
    const answer = new Promise<boolean>((resolve) => { this.resolve = resolve; });
    if (!dialog.open) dialog.showModal();
    this.cancelButton!.focus({ preventScroll: true });
    return answer;
  }

  private finish(ok: boolean): void {
    const resolve = this.resolve;
    if (!resolve) return;
    this.resolve = null;
    const invoker = this.invoker;
    this.invoker = null;
    if (this.dialog?.open) this.dialog.close();
    if (invoker?.isConnected) invoker.focus();
    resolve(ok);
  }

  private ensure(): HTMLDialogElement {
    if (this.dialog) return this.dialog;
    const dialog = document.createElement('dialog');
    dialog.className = 'shortcuts-dialog confirm-dialog';
    dialog.dataset.confirmDialog = '';
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
    dialog.setAttribute('aria-describedby', 'confirm-dialog-body');

    const form = document.createElement('div');
    form.className = 'shortcuts-form';
    const header = document.createElement('header');
    header.className = 'shortcuts-header';
    const title = document.createElement('h2');
    title.id = 'confirm-dialog-title';
    header.appendChild(title);
    const body = document.createElement('p');
    body.id = 'confirm-dialog-body';
    body.className = 'confirm-dialog-body';

    const actions = document.createElement('footer');
    actions.className = 'shortcuts-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'shortcuts-close';
    cancel.dataset.confirmCancel = '';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'shortcuts-close confirm-dialog-confirm';
    confirm.dataset.confirmAccept = '';
    actions.append(cancel, confirm);

    form.append(header, body, actions);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    cancel.addEventListener('click', () => this.finish(false));
    confirm.addEventListener('click', () => this.finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.finish(false);
    });
    dialog.addEventListener('pointerdown', (event) => {
      if (event.target !== dialog) return;
      event.preventDefault();
      this.finish(false);
    });

    this.dialog = dialog;
    this.title = title;
    this.body = body;
    this.confirmButton = confirm;
    this.cancelButton = cancel;
    return dialog;
  }
}
