// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the PWA shell suite (src/pwa/, src/ui/pwaUpdate.ts).
 *
 *   node_modules/.bin/esbuild src/ui/tools/pwa-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/pwa-selftest.mjs && node /tmp/pwa-selftest.mjs
 *
 * Run from the repository root. What is pinned:
 *   - buildPwaShell on a synthetic hosted dist/ emits manifest.webmanifest, icons/ and
 *     sw.js; the precache list holds exactly the files the page requests (hashed chunks,
 *     plain shell files), never source maps, licences, host files, the inlined entry or
 *     sw.js itself; Pyodide and the decoders zip are runtime (lazy) entries;
 *   - index.html is stamped once with the build version and the manifest link;
 *   - the version is deterministic and changes when any listed byte changes;
 *   - the worker template's cache discipline (versioned names, scoped rotation, no
 *     automatic skipWaiting, same-origin only, network copies of index.html never stored);
 *   - registration is refused for dev, portable, file:// and insecure contexts, and is
 *     wired after App in main.ts; the boot "Starting…" line exists and is removed.
 */

import {
  ICONS, SHELL_TOKEN, THEME_COLOR, buildPwaShell, shellVersion, stampIndex,
  type ShellList,
} from '../../pwa/shell.mjs';
import { en } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';
import { shouldRegister, type RegisterEnv } from '../pwaUpdate.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(path: string, encoding?: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: true }): void;
  mkdtempSync(prefix: string): string;
  existsSync(path: string): boolean;
  rmSync(path: string, options: { recursive: true; force: true }): void;
}
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
const os = nodeProcess.getBuiltinModule?.('os') as { tmpdir(): string } | undefined;
if (!fs || !os) throw new Error('node fs/os modules unavailable');

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

// ------------------------------------------------------------ synthetic dist/

const SYNTHETIC: Record<string, string> = {
  'index.html': '<!doctype html><html><head><meta charset="utf-8" />\n' +
    '  <title data-i18n="app.title">SLogic Logic Analyzer</title>\n</head><body></body></html>',
  'assets/index-AAAAAAAA.js': 'entry',
  'assets/index-AAAAAAAA.js.map': '{}',
  'assets/index-BBBBBBBB.css': 'css',
  'assets/worker-__CcCcCc.js': 'worker',
  'assets/worker-__CcCcCc.js.map': '{}',
  'assets/usbWorker-DDDDDDDD.js': 'usb',
  'fr-EEEEEEEE.js': 'fr',
  'fr-EEEEEEEE.js.map': '{}',
  'favicon.svg': '<svg/>',
  'pyodide/0123456789/pyodide.asm.wasm': 'wasm',
  'pyodide/0123456789/python_stdlib.zip': 'zip',
  'decoders/decoders-abcdef0123.zip': 'decoders',
  'LICENSE.txt': 'gpl',
  'THIRD_PARTY_LICENSES.txt': 'mpl',
  'DEPLOY.txt': 'deploy',
  'CNAME': 'slogic.example',
  '.nojekyll': '',
};
const INLINED = ['assets/index-AAAAAAAA.js', 'assets/index-BBBBBBBB.css'];

function makeDist(overrides: Record<string, string> = {}): string {
  const dir = fs!.mkdtempSync(`${os!.tmpdir()}/slogicweb-pwa-`);
  for (const [rel, body] of Object.entries({ ...SYNTHETIC, ...overrides })) {
    const at = rel.lastIndexOf('/');
    if (at > 0) fs!.mkdirSync(`${dir}/${rel.slice(0, at)}`, { recursive: true });
    fs!.writeFileSync(`${dir}/${rel}`, body);
  }
  return dir;
}

const template = fs.readFileSync('src/pwa/sw.js', 'utf8');
const build = (dir: string) =>
  buildPwaShell(dir, { inlined: INLINED, template, iconDir: 'src/pwa/icons' });

const dirs: string[] = [];
try {
  const dist = makeDist();
  dirs.push(dist);
  const { version, shell } = build(dist);

  const manifest = JSON.parse(fs.readFileSync(`${dist}/manifest.webmanifest`, 'utf8')) as {
    name: string; short_name: string; start_url: string; scope: string; display: string;
    theme_color: string; background_color: string;
    icons: { src: string; purpose: string; sizes: string }[];
  };
  check('manifest: name, start_url, standalone, app colours',
    manifest.name === 'SLogic Logic Analyzer' && manifest.short_name === 'SLogic' &&
      manifest.start_url === './' && manifest.scope === './' && manifest.display === 'standalone' &&
      manifest.theme_color === THEME_COLOR && manifest.background_color === THEME_COLOR &&
      THEME_COLOR === '#1B1B1C',
    JSON.stringify({ ...manifest, icons: manifest.icons.length }));
  check('manifest: any + maskable icons, every one emitted',
    manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512') &&
      manifest.icons.some((i) => i.purpose === 'any' && i.sizes === '192x192') &&
      manifest.icons.every((i) => fs.existsSync(`${dist}/${i.src}`)) &&
      ICONS.every((i) => fs.existsSync(`${dist}/icons/${i}`)),
    manifest.icons.map((i) => `${i.src}:${i.purpose}`).join(', '));

  const sw = fs.readFileSync(`${dist}/sw.js`, 'utf8');
  const m = /const SHELL = (\{.*\});/.exec(sw);
  const emitted = m ? JSON.parse(m[1]!) as ShellList & { version: string } : null;
  check('sw.js: token replaced by the enumerated list carrying the version',
    !sw.includes(SHELL_TOKEN) && emitted !== null && emitted.version === version &&
      /^[0-9a-f]{12}$/.test(version),
    `version ${version}`);

  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  check('precache: hashed chunks and workers, not the inlined entry or any map',
    same(shell.hashed, ['assets/usbWorker-DDDDDDDD.js', 'assets/worker-__CcCcCc.js', 'fr-EEEEEEEE.js']),
    shell.hashed.join(', '));
  check('precache: plain shell files (favicon, icons, manifest), no licences/host files/sw.js',
    same(shell.plain, ['favicon.svg', ...ICONS.map((i) => `icons/${i}`), 'manifest.webmanifest']),
    shell.plain.join(', '));
  check('runtime (cached on first use): every Pyodide file and the decoders zip',
    same(shell.runtime, ['decoders/decoders-abcdef0123.zip',
      'pyodide/0123456789/pyodide.asm.wasm', 'pyodide/0123456789/python_stdlib.zip']) &&
      shell.index === 'index.html',
    shell.runtime.join(', '));

  const html = fs.readFileSync(`${dist}/index.html`, 'utf8');
  let restampThrows = false;
  try { stampIndex(html, version); } catch { restampThrows = true; }
  check('index.html: stamped once with the build version and the manifest link',
    html.includes(`<meta name="slogicweb-build" content="${version}">`) &&
      html.includes('<link rel="manifest" href="manifest.webmanifest">') &&
      html.indexOf('slogicweb-build') > html.indexOf('</title>') && restampThrows &&
      template.includes('<meta name="slogicweb-build" content="${VERSION}">'),
    'sw.js verifies the same meta at install');

  const again = makeDist();
  const changed = makeDist({ 'pyodide/0123456789/pyodide.asm.wasm': 'wasm2' });
  dirs.push(again, changed);
  const v2 = build(again).version;
  const v3 = build(changed).version;
  const base = makeDist();
  dirs.push(base);
  const baseShell = build(base).shell;
  const vTemplate = shellVersion(base, baseShell, `${template}\n// policy change`);
  check('version: deterministic, changes with any listed byte or the worker template',
    v2 === version && v3 !== version && vTemplate !== shellVersion(base, baseShell, template),
    `${version} / ${v2} / ${v3}`);
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

// ------------------------------------------------------ worker cache discipline

{
  const s = template;
  const installBody = s.slice(s.indexOf("addEventListener('install'"), s.indexOf("addEventListener('activate'"));
  const navigateBody = s.slice(s.indexOf('async function navigate'), s.indexOf('async function cacheFirst'));
  check('sw: cache names are scoped and versioned; activation deletes other versions',
    s.includes('const PREFIX = `slogicweb:${SCOPE}:`;') &&
      s.includes('const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;') &&
      /name\.startsWith\(PREFIX\) && name !== SHELL_CACHE && name !== RUNTIME_CACHE/.test(s) &&
      s.includes('caches.delete(name)') && s.includes('if (!RUNTIME_URLS.has(request.url)) await runtime.delete(request);'),
    'shell-<version> rotated, runtime pruned to the current build');
  check('sw: no automatic takeover; SKIP_WAITING only on a page message',
    !installBody.includes('skipWaiting') && (s.match(/skipWaiting\(\)/g) ?? []).length === 1 &&
      /event\.data\.type === 'SKIP_WAITING'\) self\.skipWaiting\(\)/.test(s),
    'install only precaches');
  check('sw: the runtime fill is best effort and can never fail the shell install',
    installBody.includes('precache().then(() => fillRuntime().catch(() => {}))') &&
      s.includes('if (await cache.match(url)) return;'),
    'an unchanged runtime is not downloaded again');
  check('sw: same-origin GETs only, and only stored when a complete basic response',
    s.includes("if (request.method !== 'GET') return;") &&
      s.includes('if (url.origin !== self.location.origin) return;') &&
      s.includes("response.type === 'basic'") && s.includes('!response.redirected'),
    'cross-origin and non-GET pass through');
  check('sw: index.html is network-first with timeout and never stores the network copy',
    navigateBody.includes('Promise.race([network, timeout])') && !navigateBody.includes('.put(') &&
      navigateBody.includes('first.status < 500') && s.includes("cache: 'reload'") &&
      s.includes('if (bare === SCOPE || bare === INDEX_URL) event.respondWith(navigate(request));'),
    'only the install-time copy (checked against VERSION) serves offline');
}

// ------------------------------------------------------------- registration

{
  const ok: RegisterEnv = { pwaBuild: true, hasServiceWorker: true, secureContext: true, protocol: 'https:' };
  const cases: [string, RegisterEnv, boolean][] = [
    ['hosted https', ok, true],
    ['localhost http', { ...ok, protocol: 'http:' }, true],
    ['dev or portable build', { ...ok, pwaBuild: false }, false],
    ['file://', { ...ok, protocol: 'file:' }, false],
    ['insecure LAN http', { ...ok, protocol: 'http:', secureContext: false }, false],
    ['no serviceWorker', { ...ok, hasServiceWorker: false }, false],
  ];
  const wrong = cases.filter(([, env, want]) => shouldRegister(env) !== want);
  check('shouldRegister: hosted secure http(s) only', wrong.length === 0,
    wrong.length ? wrong.map(([n]) => n).join(', ') : cases.map(([n, , w]) => `${n}→${w}`).join(', '));

  const config = fs.readFileSync('vite.config.ts', 'utf8');
  const update = fs.readFileSync('src/ui/pwaUpdate.ts', 'utf8');
  check('build flag: __SLOGICWEB_PWA__ is false for dev and portable, and gates registration',
    config.includes("enabled = env.command === 'build' && !portable;") &&
      config.includes('__SLOGICWEB_PWA__: JSON.stringify(enabled)') &&
      /inlineEntryForFileOpen\(\), hostedWorkerFiles\(\), pwaShell\(\),/.test(config) &&
      update.includes('if (!__SLOGICWEB_PWA__) return;') &&
      update.includes("navigator.serviceWorker.register('./sw.js')"),
    'pwaShell runs after the inline step');

  const main = fs.readFileSync('src/ui/main.ts', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  const afterApp = main.indexOf('window.slogicweb = new App();');
  const hint = html.slice(html.indexOf('<div id="empty-hint"'), html.indexOf('</div>', html.indexOf('<div id="empty-hint"')));
  check('boot: "Starting…" sits in #empty-hint and main.ts removes it, then registers',
    hint.includes('id="empty-hint-starting"') && hint.includes('Starting…') &&
      hint.includes('正在启动…') && hint.includes('Démarrage…') && hint.includes('Запуск…') &&
      afterApp > 0 && main.indexOf("getElementById('empty-hint-starting')?.remove()") > afterApp &&
      main.indexOf('initServiceWorker();') > afterApp,
    'four locales, removed once App constructs');

  const catalogs = { en, zhCN, fr, ru };
  const missing = Object.entries(catalogs).flatMap(([name, c]) =>
    (['update.ready', 'update.reload', 'update.later'] as const).filter((k) => !c[k]).map((k) => `${name}:${k}`));
  check('update notice: localized in four locales',
    missing.length === 0 && zhCN['update.ready'] === '新版本已就绪，刷新启用。',
    missing.join(', ') || en['update.ready']);
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
