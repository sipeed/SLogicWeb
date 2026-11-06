// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * File-handling guards (src/ui/fileGuards.ts) and their App/index.html wiring:
 *
 *   - the drag-and-drop overlay: FileDragDepth's nested enter/leave counting, the
 *     overlay element and its locale key, the empty hint's "or drag it here" in every
 *     locale and variant, and the window listeners that toggle `#plot.drop-active`.
 *
 *   npm test -- --filter file-guards
 */

import { FileDragDepth, dragHasFiles } from '../fileGuards.js';
import { en, type Messages } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';

const nodeProcess = (globalThis as {
  process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
}).process!;
const fs = nodeProcess.getBuiltinModule?.('fs') as { readFileSync(p: string, enc: 'utf8'): string };

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`PASS  ${name}`); } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');

// ---------------------------------------------------------------- drag depth
{
  const d = new FileDragDepth();
  const steps = [
    d.enter(['Files']),          // window
    d.enter(['Files']),          // a child
    d.leave(),                   // left the child: still over the page
    d.leave(),                   // left the window
  ];
  check('a file drag shows the overlay through nested enters and hides on the last leave',
    steps.join(',') === 'true,true,true,false' && !d.active, steps.join(','));

  const t = new FileDragDepth();
  const text = [t.enter(['text/plain']), t.leave(), t.leave(), t.enter(['Files'])];
  check('a text drag never shows it and extra leaves cannot drive the count negative',
    text.join(',') === 'false,false,false,true', text.join(','));
  check('drop/dragend reset clears it at any depth',
    (t.enter(['Files']), t.reset() === false && !t.active));
  check('only a Files drag counts', dragHasFiles(['text/uri-list', 'Files']) &&
    !dragHasFiles(['text/plain']) && !dragHasFiles(null) && !dragHasFiles(undefined));
}

// ---------------------------------------------------------------- hint copy
{
  const drag: Array<[string, Messages, RegExp]> = [
    ['en', en, /\(or drag it here\)/],
    ['zh-CN', zhCN, /或拖拽文件到此处/],
    ['fr', fr, /\(ou glissez-le ici\)/],
    ['ru', ru, /\(или перетащите его сюда\)/],
  ];
  const keys = ['emptyHint.line2', 'emptyHint.line2Connected', 'emptyHint.line2NoUsb'] as const;
  const missing: string[] = [];
  for (const [name, m, re] of drag) {
    for (const k of keys) if (!re.test(m[k])) missing.push(`${name}:${k}`);
    if (!m['drop.overlay'].includes('.sr') || !m['drop.overlay'].includes('.lwcap')) {
      missing.push(`${name}:drop.overlay`);
    }
    if (name !== 'en' && m['drop.overlay'] === en['drop.overlay']) missing.push(`${name}:untranslated`);
  }
  check('every empty-hint variant says files can be dragged in, in all four locales',
    missing.length === 0, missing.join(', '));
  check('the connected hint still carries {device}; the no-USB hint still never says connect',
    [en, zhCN, fr, ru].every((m) => m['emptyHint.line2Connected'].includes('{device}')) &&
    !/connect/i.test(en['emptyHint.line2NoUsb']));
}

// ---------------------------------------------------------------- wiring
{
  const hint = html.includes(`data-i18n="emptyHint.line2">${en['emptyHint.line2']}</span>`);
  const overlay = /<div id="drop-overlay" class="drop-overlay"[^>]*aria-hidden="true">\s*<span data-i18n="drop\.overlay">/.test(html) &&
    html.includes(`>${en['drop.overlay']}</span>`) &&
    html.indexOf('id="drop-overlay"') > html.indexOf('<div id="plot"');
  check('index.html carries the new hint text and the overlay inside the plot', hint && overlay,
    `hint=${hint}, overlay=${overlay}`);

  const listeners = app.includes("window.addEventListener('dragenter', (e) => {\n      this.showDropOverlay(this.fileDrag.enter(e.dataTransfer?.types));") &&
    app.includes("window.addEventListener('dragleave', () => this.showDropOverlay(this.fileDrag.leave()));") &&
    app.includes("window.addEventListener('dragend', () => this.showDropOverlay(this.fileDrag.reset()));");
  const dropBody = app.split("window.addEventListener('drop', (e) => {")[1]?.split('\n    });')[0] ?? '';
  const dropClears = dropBody.includes('this.showDropOverlay(this.fileDrag.reset());') &&
    dropBody.indexOf('this.fileDrag.reset()') < dropBody.indexOf('this.openFiles(files)');
  const toggle = app.includes("this.el.plot.classList.toggle('drop-active', active);");
  const style = css.includes('#plot.drop-active > .drop-overlay { display: flex; }') &&
    /\.drop-overlay \{[^}]*display: none;[^}]*pointer-events: none;/.test(css);
  check('window drag listeners toggle #plot.drop-active and drop clears it before opening',
    listeners && dropClears && toggle && style,
    `listeners=${listeners}, drop=${dropClears}, toggle=${toggle}, style=${style}`);
}

console.log(`\n${passed}/${passed + failures.length} passed`);
nodeProcess.exit(failures.length === 0 ? 0 : 1);
