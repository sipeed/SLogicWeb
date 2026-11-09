// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Service-worker registration and the explicit update prompt (docs/ARCHITECTURE.md
 * section 7.2; the worker itself is src/pwa/sw.js).
 *
 * Registered only by a hosted production build (`__SLOGICWEB_PWA__`, false for the dev
 * server and for the portable single-file build, so both minify this to nothing), only
 * where `navigator.serviceWorker` exists, and only in a secure http(s) context - never
 * from file://.
 *
 * A new version never takes over on its own. When one has installed and is waiting, a
 * small notice offers Reload; only that click tells the waiting worker to activate, and
 * the page reloads once it controls. "Later" hides the notice for this page load; the
 * state stays 'ready' so an About/Settings surface can still offer the update through
 * getUpdateState() / applyUpdate().
 */

import { onLocaleChange, t } from './i18n.js';

declare const __SLOGICWEB_PWA__: boolean;

/** 'off': no service worker here; 'idle': registered, current; 'ready': update waiting. */
export type UpdateState = 'off' | 'idle' | 'ready';

let state: UpdateState = 'off';
let waiting: ServiceWorker | null = null;
const listeners = new Set<(s: UpdateState) => void>();

export function getUpdateState(): UpdateState {
  return state;
}

/** Subscribe to update-state changes; returns the unsubscribe. */
export function onUpdateStateChange(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function setState(next: UpdateState): void {
  if (next === state) return;
  state = next;
  for (const cb of listeners) cb(next);
}

export interface RegisterEnv {
  pwaBuild: boolean;
  hasServiceWorker: boolean;
  secureContext: boolean;
  protocol: string;
}

/** Pure: whether this page may register the shell worker. */
export function shouldRegister(env: RegisterEnv): boolean {
  return env.pwaBuild && env.hasServiceWorker && env.secureContext &&
    (env.protocol === 'https:' || env.protocol === 'http:');
}

let reloading = false;

/** Activate the waiting version and reload into it. A user action, never automatic. */
export function applyUpdate(): void {
  const worker = waiting;
  if (!worker || reloading) return;
  reloading = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  worker.postMessage({ type: 'SKIP_WAITING' });
  // Another tab may already have activated it, and then no controllerchange is coming.
  setTimeout(() => location.reload(), 3000);
}

let notice: HTMLDivElement | null = null;

function renderNotice(): void {
  if (!notice) return;
  notice.replaceChildren();
  const text = document.createElement('span');
  text.className = 'platform-notice-text update-notice-text';
  text.textContent = t('update.ready');
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'update-notice-reload';
  reload.textContent = t('update.reload');
  reload.addEventListener('click', applyUpdate);
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'update-notice-later';
  later.textContent = t('update.later');
  later.addEventListener('click', () => { if (notice) notice.hidden = true; });
  notice.append(text, reload, later);
}

function showNotice(): void {
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'update-notice';
    notice.className = 'platform-notice update-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    // Beside the browser-support notice, inside the shell's column; body as a fallback.
    const platform = document.getElementById('platform-notice');
    if (platform) platform.after(notice);
    else document.body.prepend(notice);
    onLocaleChange(renderNotice);
  }
  renderNotice();
  notice.hidden = false;
}

function markWaiting(worker: ServiceWorker): void {
  waiting = worker;
  setState('ready');
  showNotice();
}

const UPDATE_CHECK_MS = 60 * 60 * 1000;

/** Register the shell worker when this build and page allow it. Never throws. */
export function initServiceWorker(): void {
  if (!__SLOGICWEB_PWA__) return;
  if (!shouldRegister({
    pwaBuild: __SLOGICWEB_PWA__,
    hasServiceWorker: 'serviceWorker' in navigator,
    secureContext: window.isSecureContext,
    protocol: location.protocol,
  })) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    setState('idle');
    // Only an UPDATE waits: with no controller this is the first install, nothing to swap.
    if (reg.waiting && navigator.serviceWorker.controller) markWaiting(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const installing = reg.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) markWaiting(installing);
      });
    });
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_MS) return;
      lastCheck = Date.now();
      reg.update().catch(() => { /* offline: try again next time */ });
    });
  }).catch((e: unknown) => {
    console.warn('[slogicweb] service worker registration failed', e);
  });
}
