// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Settings > About: the view model (name, version/build, licence, copyright, links), the
 * build-identity fallback, the four catalogs, the About pane's inline render and the vite
 * `define` that injects the identity.
 */

import {
  aboutView, buildIdentity, COPYRIGHT, LICENSE_URL, NOTICE_URL, SOURCE_URL,
} from '../about.js';
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

function aboutPane(settingsWindow: string, app: string, about: string): boolean {
  const pane = sourceSlice(settingsWindow, 'private paneContent(section: SettingsSectionId)', 'private shortcutBlocks(');
  const block = sourceSlice(settingsWindow, 'private aboutBlock()', '  private aboutLine(');
  const linksAt = settingsWindow.indexOf('private aboutLinks(');
  const links = linksAt < 0 ? '' : settingsWindow.slice(linksAt);
  const shortcutsAt = pane.indexOf("case 'shortcuts':");
  const aboutAt = pane.indexOf("case 'about':");
  return block.includes("block.className = 'settings-about';") &&
    block.includes("block.dataset.settingsKey = 'about';") &&
    block.includes('const view = aboutView();') &&
    block.includes("this.aboutLine('about-name', `${view.name} — ${view.subtitle}`, false),") &&
    block.includes("this.aboutLine('about-meta', view.version, false),") &&
    block.includes("this.aboutLine('about-meta', view.license),") &&
    block.includes("this.aboutLine('about-meta', view.copyright, false),") &&
    block.includes('this.aboutLinks(view.links),') &&
    links.includes('list.className = \'about-links\';') &&
    links.includes("anchor.target = '_blank';") &&
    links.includes("anchor.rel = 'noopener noreferrer';") &&
    links.includes('anchor.textContent = link.label;') &&
    !links.includes('innerHTML') &&
    shortcutsAt >= 0 && aboutAt > shortcutsAt &&
    pane.includes('return this.shortcutBlocks();') &&
    pane.includes('return [this.aboutBlock()];') &&
    !settingsWindow.includes('openAbout') &&
    !app.includes('aboutDialog') &&
    !about.includes('class AboutDialog') && !about.includes('showModal') &&
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
    view.name === 'slogicweb' && view.subtitle === en['app.title'] &&
      view.version === 'Version 1.2.3 · build abc1234' &&
      view.license === 'GPL-3.0-or-later · no warranty' &&
      view.copyright === '© 2026 Sipeed Co., Ltd.' && COPYRIGHT === view.copyright &&
      !('title' in view) && !('close' in view),
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
    'about.version', 'about.license', 'about.source', 'about.licenseLink', 'about.notice',
  ];
  const retired = ['settings.about', 'about.title'] as const;
  const catalogs = { 'zh-CN': zhCN, fr, ru } as const;
  const problems: string[] = [];
  for (const [locale, m] of Object.entries(catalogs)) {
    for (const key of keys) {
      const v = m[key];
      if (!v) problems.push(`${locale}:${key} missing`);
      else if (key !== 'about.license' && v === en[key] && !/^Version/.test(v)) problems.push(`${locale}:${key} untranslated`);
    }
    for (const key of retired) {
      if (Object.prototype.hasOwnProperty.call(m, key)) problems.push(`${locale}:${key} still present`);
    }
    if (!m['about.version'].includes('{version}') || !m['about.version'].includes('{build}')) {
      problems.push(`${locale}:about.version placeholders`);
    }
    if (!m['about.license'].startsWith('GPL-3.0-or-later · ') || m['about.license'] === en['about.license']) {
      problems.push(`${locale}:about.license`);
    }
  }
  check('every locale translates the About strings, keeps the version placeholders and SPDX id, and drops the retired dialog keys',
    problems.length === 0, JSON.stringify(problems));
}

{
  const app = read('src/ui/app.ts');
  const settingsWindow = read('src/ui/settingsDialog.ts');
  const about = read('src/ui/about.ts');
  const inline = aboutPane(settingsWindow, app, about);
  check('Settings renders About inline after Shortcuts: the name line, version, licence, copyright and the link list, with no dialog left to open',
    inline, `pane=${inline}`);

  const movedFirst = settingsWindow.replace(
    "      case 'shortcuts':\n        return this.shortcutBlocks();\n      case 'developer':\n        return [this.developerToolsRow()];\n      case 'about':\n        return [this.aboutBlock()];",
    "      case 'about':\n        return [this.aboutBlock()];\n      case 'shortcuts':\n        return this.shortcutBlocks();\n      case 'developer':\n        return [this.developerToolsRow()];");
  const shortcutsPaneDropped = settingsWindow.replace(
    "        return this.shortcutBlocks();",
    "        return [];");
  const noRel = settingsWindow.replace("      anchor.rel = 'noopener noreferrer';\n", '');
  const noTarget = settingsWindow.replace("      anchor.target = '_blank';\n", '');
  const unlabelled = settingsWindow.replace("      anchor.textContent = link.label;\n", '');
  const reopened = settingsWindow.replace(
    '  setDeveloperTools(on: boolean): void;\n}',
    '  setDeveloperTools(on: boolean): void;\n  openAbout(invoker: HTMLElement): void;\n}');
  const dialogBack = `${about}\nexport class AboutDialog {\n  open(anchor: HTMLElement): void { this.dialog.showModal(); }\n}\n`;
  check('control: About listed before Shortcuts, an emptied shortcuts pane, a bare link, an unlabelled anchor, an opener bridge or a reintroduced dialog class fails the same inline predicate',
    movedFirst !== settingsWindow && !aboutPane(movedFirst, app, about) &&
    shortcutsPaneDropped !== settingsWindow && !aboutPane(shortcutsPaneDropped, app, about) &&
    noRel !== settingsWindow && !aboutPane(noRel, app, about) &&
    noTarget !== settingsWindow && !aboutPane(noTarget, app, about) &&
    unlabelled !== settingsWindow && !aboutPane(unlabelled, app, about) &&
    reopened !== settingsWindow && !aboutPane(reopened, app, about) &&
    dialogBack !== about && !aboutPane(settingsWindow, app, dialogBack) &&
    aboutPane(settingsWindow, app, about),
    `moved=${aboutPane(movedFirst, app, about)}, dropped=${aboutPane(shortcutsPaneDropped, app, about)}, ` +
    `rel=${aboutPane(noRel, app, about)}, target=${aboutPane(noTarget, app, about)}, ` +
    `label=${aboutPane(unlabelled, app, about)}, ` +
    `reopened=${aboutPane(reopened, app, about)}, dialog=${aboutPane(settingsWindow, app, dialogBack)}, ` +
    `real=${aboutPane(settingsWindow, app, about)}`);
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
