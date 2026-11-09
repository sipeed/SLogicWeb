// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Settings > About: the view model (name, version/build, licence, copyright, links), the
 * build-identity fallback, the four catalogs, the Settings entry, the modal pattern
 * shared with the shortcuts dialog, and the vite `define` that injects the identity.
 */

import {
  aboutView, buildIdentity, COPYRIGHT, LICENSE_URL, NOTICE_URL, SOURCE_URL,
} from '../aboutDialog.js';
import type { MessageKey } from '../i18n.js';
import { en } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
const read = (path: string): string => fs.readFileSync(path, 'utf8');

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function sourceSlice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

function aboutEntry(settingsWindow: string, app: string): boolean {
  const pane = sourceSlice(settingsWindow, 'private paneContent(section: SettingsSectionId)', 'private shortcutBlocks(');
  const row = sourceSlice(settingsWindow, 'private aboutRow()', '}\n');
  const shortcutsAt = pane.indexOf("case 'shortcuts':");
  const aboutAt = pane.indexOf("case 'about':");
  return row.includes("this.rowLabel('settings.about')") &&
    row.includes("row.dataset.settingsKey = 'about';") &&
    row.includes('this.host.openAbout(row)') &&
    shortcutsAt >= 0 && aboutAt > shortcutsAt &&
    pane.includes('return this.shortcutBlocks();') &&
    pane.includes('return [this.aboutRow()];') &&
    app.includes('if (this.aboutDialog.isOpen) this.aboutDialog.renderStrings();') &&
    sourceSlice(app, 'openAbout: (invoker) => {', '\n      },').includes('this.aboutDialog.open(invoker);') &&
    !app.includes('settingsItems');
}

{
  const id = buildIdentity();
  check('without a vite define (this bundle) the build identity falls back to dev',
    id.version === 'dev' && id.hash === 'dev', JSON.stringify(id));
}

{
  const view = aboutView({ version: '1.2.3', hash: 'abc1234' });
  check('the About view names the app, version and build, the GPL line and the copyright',
    view.title === en['about.title'] && view.name === 'slogicweb' && view.subtitle === en['app.title'] &&
      view.version === 'Version 1.2.3 · build abc1234' &&
      view.license === 'GPL-3.0-or-later · no warranty' &&
      view.copyright === '© 2026 Sipeed Co., Ltd.' && COPYRIGHT === view.copyright &&
      view.close === en['shortcuts.close'],
    JSON.stringify(view));
  check('the About links are the source repository, its LICENSE and NOTICE.md (third-party decoders)',
    view.links.length === 3 &&
      view.links[0]!.href === 'https://github.com/sipeed/slogicweb' && view.links[0]!.href === SOURCE_URL &&
      view.links[1]!.href === LICENSE_URL && LICENSE_URL.endsWith('/LICENSE') &&
      view.links[2]!.href === NOTICE_URL && NOTICE_URL.endsWith('/NOTICE.md') &&
      view.links.every((l) => l.href.startsWith('https://') && l.label.length > 0),
    JSON.stringify(view.links));
}

{
  const keys: MessageKey[] = [
    'settings.about', 'about.title', 'about.version', 'about.license', 'about.source',
    'about.licenseLink', 'about.notice',
  ];
  const catalogs = { 'zh-CN': zhCN, fr, ru } as const;
  const problems: string[] = [];
  for (const [locale, m] of Object.entries(catalogs)) {
    for (const key of keys) {
      const v = m[key];
      if (!v) problems.push(`${locale}:${key} missing`);
      else if (key !== 'about.license' && v === en[key] && !/^Version/.test(v)) problems.push(`${locale}:${key} untranslated`);
    }
    if (!m['about.version'].includes('{version}') || !m['about.version'].includes('{build}')) {
      problems.push(`${locale}:about.version placeholders`);
    }
    if (!m['about.license'].startsWith('GPL-3.0-or-later · ') || m['about.license'] === en['about.license']) {
      problems.push(`${locale}:about.license`);
    }
  }
  check('every locale translates the About strings and keeps the version placeholders and SPDX id',
    problems.length === 0, JSON.stringify(problems));
}

{
  const app = read('src/ui/app.ts');
  const settingsWindow = read('src/ui/settingsDialog.ts');
  const entry = aboutEntry(settingsWindow, app);
  const dialog = read('src/ui/aboutDialog.ts');
  const modal = dialog.includes('this.dialog.showModal();') &&
    dialog.includes("this.dialog.addEventListener('cancel', (event) => {") &&
    dialog.includes('event.preventDefault();\n      this.close();') &&
    dialog.includes('if (invoker?.isConnected) invoker.focus();') &&
    dialog.includes("this.dialog.setAttribute('aria-labelledby', 'about-title');") &&
    dialog.includes("a.rel = 'noopener noreferrer';") && !dialog.includes('innerHTML');
  check('Settings lists About after Shortcuts; it opens a modal dialog (focus trap, Esc closes, focus returns)',
    entry && modal, `entry=${entry}, modal=${modal}`);

  const movedFirst = settingsWindow.replace(
    "      case 'shortcuts':\n        return this.shortcutBlocks();\n      case 'developer':\n        return [this.developerToolsRow()];\n      case 'about':\n        return [this.aboutRow()];",
    "      case 'about':\n        return [this.aboutRow()];\n      case 'shortcuts':\n        return this.shortcutBlocks();\n      case 'developer':\n        return [this.developerToolsRow()];");
  const shortcutsPaneDropped = settingsWindow.replace(
    "        return this.shortcutBlocks();",
    "        return [];");
  const strayHandOff = settingsWindow.replace('this.host.openAbout(row)', 'this.host.openAbout(this.closeButton)');
  const unlocalized = app.replace(
    'if (this.aboutDialog.isOpen) this.aboutDialog.renderStrings();',
    '');
  check('control: About listed before Shortcuts, an emptied shortcuts pane, a row handing off another frame or a modal left unlocalized fails the same entry predicate',
    movedFirst !== settingsWindow && !aboutEntry(movedFirst, app) &&
    shortcutsPaneDropped !== settingsWindow && !aboutEntry(shortcutsPaneDropped, app) &&
    strayHandOff !== settingsWindow && !aboutEntry(strayHandOff, app) &&
    unlocalized !== app && !aboutEntry(settingsWindow, unlocalized) &&
    aboutEntry(settingsWindow, app),
    `moved=${aboutEntry(movedFirst, app)}, dropped=${aboutEntry(shortcutsPaneDropped, app)}, ` +
    `stray=${aboutEntry(strayHandOff, app)}, ` +
    `unlocalized=${aboutEntry(settingsWindow, unlocalized)}, real=${aboutEntry(settingsWindow, app)}`);
}

{
  const vite = read('vite.config.ts');
  const env = read('src/env.d.ts');
  const define = vite.includes('__APP_VERSION__: JSON.stringify(identity.version),') &&
    vite.includes('__GIT_HASH__: JSON.stringify(identity.hash),') &&
    vite.includes("execSync('git rev-parse --short HEAD',") &&
    env.includes('declare const __APP_VERSION__: string;') && env.includes('declare const __GIT_HASH__: string;');
  check('vite injects the package version and short git hash; env.d.ts declares both',
    define, `define=${define}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
