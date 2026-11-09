// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Build side of the PWA shell (docs/ARCHITECTURE.md section 7.2). Run by vite.config.ts
 * after every other closeBundle step of a HOSTED build - the portable single-file build
 * never calls it, so it has no manifest, no icons beside it and no service worker.
 *
 * Plain JS (not TS) because it runs inside the Vite config with node:fs and the project's
 * tsconfig carries no Node types; src/pwa/pwa-selftest.mjs exercises it on a synthetic
 * dist/ tree.
 *
 * It writes manifest.webmanifest and icons/ into dist/, enumerates what the page loads,
 * stamps index.html with the build version, and writes sw.js from src/pwa/sw.js with the
 * enumerated list in place of its __SLOGICWEB_SHELL__ token.
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Background and theme colour: --bg10, the plot/toolbar surface of the default theme. */
export const THEME_COLOR = '#1B1B1C';

export const ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];

export function webManifest() {
  return `${JSON.stringify({
    name: 'SLogic Logic Analyzer',
    short_name: 'SLogic',
    id: './',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: THEME_COLOR,
    theme_color: THEME_COLOR,
    icons: [
      { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)}\n`;
}

/** Vite's `[name]-[hash]` file names (an 8-character base64url hash). */
const HASHED = /-[A-Za-z0-9_-]{8}\.(?:js|css)$/;

/** Published but never fetched by the page: licences, deploy notes, host config, maps. */
const NOT_LOADED = (rel) =>
  rel.endsWith('.map') || rel === 'sw.js' || rel === 'CNAME' || rel === '.nojekyll' ||
  (!rel.includes('/') && rel.endsWith('.txt'));

function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

/**
 * Classify every dist/ file the page can request.
 * @param {string} dist
 * @param {readonly string[]} inlined files whose content index.html already carries
 *   (the entry JS and CSS) - emitted for their source maps, never requested.
 */
export function collectShell(dist, inlined = []) {
  const skip = new Set(inlined);
  const shell = { index: 'index.html', hashed: [], plain: [], runtime: [] };
  for (const rel of walk(dist)) {
    if (rel === 'index.html' || skip.has(rel) || NOT_LOADED(rel)) continue;
    if (rel.startsWith('pyodide/') || rel.startsWith('decoders/')) shell.runtime.push(rel);
    else if (HASHED.test(rel)) shell.hashed.push(rel);
    else shell.plain.push(rel);
  }
  if (!existsSync(join(dist, 'index.html'))) throw new Error('pwa shell: dist/index.html missing');
  return shell;
}

/**
 * Version = hash of every listed file's name and bytes (index.html before stamping) and
 * of the worker template, so a policy-only change still rotates the shell cache.
 */
export function shellVersion(dist, shell, template = '') {
  const h = createHash('sha256');
  h.update(template);
  for (const rel of [shell.index, ...shell.hashed, ...shell.plain, ...shell.runtime]) {
    h.update(`${rel}\0`);
    h.update(readFileSync(join(dist, rel)));
  }
  return h.digest('hex').slice(0, 12);
}

/** The head tags a hosted index.html gains. `slogicweb-build` is what sw.js verifies. */
export function headTags(version) {
  return [
    `<meta name="slogicweb-build" content="${version}">`,
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="apple-touch-icon" href="icons/icon-192.png">',
  ].join('\n  ');
}

export function stampIndex(html, version) {
  if (html.includes('name="slogicweb-build"')) throw new Error('pwa shell: index.html already stamped');
  const at = html.indexOf('</title>');
  if (at < 0) throw new Error('pwa shell: index.html has no </title> to anchor the head tags');
  const end = at + '</title>'.length;
  return `${html.slice(0, end)}\n  ${headTags(version)}${html.slice(end)}`;
}

export const SHELL_TOKEN = '__SLOGICWEB_SHELL__';

export function renderServiceWorker(template, shell, version) {
  const parts = template.split(SHELL_TOKEN);
  if (parts.length !== 2) throw new Error(`pwa shell: sw template must hold ${SHELL_TOKEN} exactly once`);
  return parts.join(JSON.stringify({ version, ...shell }));
}

/**
 * Write manifest, icons and sw.js into a finished hosted dist/, and stamp index.html.
 * @param {string} dist
 * @param {{ inlined?: readonly string[], template?: string, iconDir?: string }} [options]
 */
export function buildPwaShell(dist, options = {}) {
  const iconDir = options.iconDir ?? join(HERE, 'icons');
  const template = options.template ?? readFileSync(join(HERE, 'sw.js'), 'utf8');
  writeFileSync(join(dist, 'manifest.webmanifest'), webManifest());
  mkdirSync(join(dist, 'icons'), { recursive: true });
  for (const icon of ICONS) copyFileSync(join(iconDir, icon), join(dist, 'icons', icon));
  const shell = collectShell(dist, options.inlined ?? []);
  const version = shellVersion(dist, shell, template);
  const indexPath = join(dist, 'index.html');
  // Render both before writing either, so a failure never leaves a half-stamped dist/.
  const sw = renderServiceWorker(template, shell, version);
  const html = stampIndex(readFileSync(indexPath, 'utf8'), version);
  writeFileSync(indexPath, html);
  writeFileSync(join(dist, 'sw.js'), sw);
  return { version, shell };
}
