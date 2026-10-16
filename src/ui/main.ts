// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Entry point. Nothing here but construction and a loud failure if it does not construct -
 * a shell that silently renders nothing is the worst possible outcome to debug.
 */

import { App } from './app.js';
import { initLocale } from './i18n.js';
import { initTheme } from './theme.js';
import { initToolbarOverride } from './toolbarOverride.js';
// Side effect: hands `workerTransport` the browser's USB worker constructor. Imported
// here, not from `device/index.ts`, so the device layer stays bundlable without Vite.
import '../device/usbWorkerSpawn.js';

declare global {
  interface Window { logicweb?: App }
}

/**
 * Boot. The persisted theme is applied first and synchronously (index.html's inline
 * head script already did it before first paint; this re-establishes the module state).
 * Then the persisted locale's catalog is preloaded before App is constructed, so the
 * first render pass already paints in the stored language. Deliberately an async IIFE
 * rather than top-level await: Vite's default build target rejects TLA.
 */
async function boot(): Promise<void> {
  try {
    initTheme();
    initToolbarOverride();
    await initLocale();
    window.logicweb = new App();
  } catch (e) {
    console.error('[logicweb] failed to start', e);
    const pre = document.createElement('pre');
    pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;background:#1B1B1C;'
      + 'color:#f52a66;font:13px ui-monospace,monospace;white-space:pre-wrap;z-index:99';
    pre.textContent = `logicweb failed to start\n\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`;
    document.body.appendChild(pre);
    throw e;
  }
}

void boot();
