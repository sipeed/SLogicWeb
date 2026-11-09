// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Settings > About: app name, version and build id, the licence line and links to the
 * source, the licence text and the third-party notices (the bundled sigrok decoders).
 *
 * The same modal pattern as the shortcuts dialog: a native <dialog> opened with
 * showModal() (the browser traps focus and makes the page inert), Esc and a backdrop
 * click close it, and focus returns to the invoker. The links are plain anchors to the
 * public repository, so the portable single-file build (file://) needs no sibling files.
 */

import { t } from './i18n.js';

export const SOURCE_URL = 'https://github.com/sipeed/slogicweb';
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
export const NOTICE_URL = `${SOURCE_URL}/blob/main/NOTICE.md`;
export const APP_NAME = 'slogicweb';
/** Not translated: a legal notice reads the same in every locale. */
export const COPYRIGHT = '© 2026 Daniel Tralamazza';

export interface BuildIdentity {
  readonly version: string;
  readonly hash: string;
}

/** The injected build identity, or 'dev' where a value was not defined (self-tests, odd builds). */
export function buildIdentity(): BuildIdentity {
  const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';
  const hash = typeof __GIT_HASH__ === 'string' && __GIT_HASH__ ? __GIT_HASH__ : 'dev';
  return { version, hash };
}

export interface AboutLink {
  readonly label: string;
  readonly href: string;
}

export interface AboutView {
  readonly title: string;
  readonly name: string;
  readonly subtitle: string;
  readonly version: string;
  readonly license: string;
  readonly copyright: string;
  readonly links: readonly AboutLink[];
  readonly close: string;
}

/** Pure (t() only) so the self-test pins it under node. */
export function aboutView(id: BuildIdentity = buildIdentity()): AboutView {
  return {
    title: t('about.title'),
    name: APP_NAME,
    subtitle: t('app.title'),
    version: t('about.version', { version: id.version, build: id.hash }),
    license: t('about.license'),
    copyright: COPYRIGHT,
    links: [
      { label: t('about.source'), href: SOURCE_URL },
      { label: t('about.licenseLink'), href: LICENSE_URL },
      { label: t('about.notice'), href: NOTICE_URL },
    ],
    close: t('shortcuts.close'),
  };
}

export class AboutDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly title: HTMLHeadingElement;
  private readonly name: HTMLParagraphElement;
  private readonly version: HTMLParagraphElement;
  private readonly license: HTMLParagraphElement;
  private readonly copyright: HTMLParagraphElement;
  private readonly links: HTMLUListElement;
  private readonly closeButton: HTMLButtonElement;
  private invoker: HTMLElement | null = null;

  constructor() {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'shortcuts-dialog about-dialog';
    this.dialog.setAttribute('aria-labelledby', 'about-title');

    const form = document.createElement('div');
    form.className = 'shortcuts-form';
    const header = document.createElement('header');
    header.className = 'shortcuts-header';
    this.title = document.createElement('h2');
    this.title.id = 'about-title';
    header.appendChild(this.title);

    const para = (cls: string, translate = true): HTMLParagraphElement => {
      const p = document.createElement('p');
      p.className = cls;
      if (!translate) p.translate = false;
      return p;
    };
    this.name = para('about-name', false);
    this.version = para('about-meta', false);
    this.license = para('about-meta');
    this.copyright = para('about-meta', false);
    this.links = document.createElement('ul');
    this.links.className = 'about-links';

    const actions = document.createElement('footer');
    actions.className = 'shortcuts-actions';
    this.closeButton = document.createElement('button');
    this.closeButton.className = 'shortcuts-close';
    this.closeButton.type = 'button';
    actions.appendChild(this.closeButton);

    form.append(header, this.name, this.version, this.license, this.copyright, this.links, actions);
    this.dialog.appendChild(form);
    document.body.appendChild(this.dialog);

    this.closeButton.addEventListener('click', () => this.close());
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener('pointerdown', (event) => {
      if (event.target !== this.dialog) return;
      event.preventDefault();
      this.close();
    });
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  open(anchor: HTMLElement | null): void {
    this.invoker = anchor;
    this.renderStrings();
    this.dialog.showModal();
    this.closeButton.focus({ preventScroll: true });
  }

  close(): void {
    const invoker = this.invoker;
    this.invoker = null;
    if (this.dialog.open) this.dialog.close();
    if (invoker?.isConnected) invoker.focus();
  }

  renderStrings(): void {
    const view = aboutView();
    this.title.textContent = view.title;
    this.name.textContent = `${view.name} — ${view.subtitle}`;
    this.version.textContent = view.version;
    this.license.textContent = view.license;
    this.copyright.textContent = view.copyright;
    this.closeButton.textContent = view.close;
    this.links.replaceChildren(...view.links.map((link) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label;
      li.appendChild(a);
      return li;
    }));
  }
}
