// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Settings > About: app name, version and build id, the licence line and links to the
 * source, the licence text and the third-party notices (the bundled sigrok decoders).
 *
 * The view is pure data rendered inline by the settings window. The links are plain
 * anchors to the public repository, so the portable single-file build (file://) needs
 * no sibling files.
 */

import { t } from './i18n.js';

export const SOURCE_URL = 'https://github.com/sipeed/slogicweb';
export const LICENSE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
export const NOTICE_URL = `${SOURCE_URL}/blob/main/NOTICE.md`;
export const APP_NAME = 'slogicweb';
/** Not translated: a legal notice reads the same in every locale. */
export const COPYRIGHT = '© 2026 Sipeed Co., Ltd.';

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
  readonly name: string;
  readonly subtitle: string;
  readonly version: string;
  readonly license: string;
  readonly copyright: string;
  readonly links: readonly AboutLink[];
}

/** Pure (t() only) so the self-test pins it under node. */
export function aboutView(id: BuildIdentity = buildIdentity()): AboutView {
  return {
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
  };
}
