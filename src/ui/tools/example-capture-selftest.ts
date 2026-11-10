// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Open example" (exampleCapture.ts): the bundled fixtures/uart.sr, handed over as the
 * data: URL Vite's `?url&inline` produces, decodes to a File that the ordinary open path
 * (`loadFiles` -> srLoad) loads like any .sr; app.ts reaches it from the Open menu; the
 * copy exists in all four locales. No DOM, no device.
 */

import { dataUrlBytes, EXAMPLE_CAPTURE_NAME, exampleCaptureFile } from '../exampleCapture.js';
import { loadFiles } from '../captureIO.js';
import { en } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, e: 'utf8'): string;
};

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const raw = fs.readFileSync('fixtures/uart.sr');
let binary = '';
for (const byte of raw) binary += String.fromCharCode(byte);
const dataUrl = `data:application/octet-stream;base64,${btoa(binary)}`;

{
  const bytes = dataUrlBytes(dataUrl);
  check('a base64 data: URL decodes to the fixture bytes',
    bytes !== null && bytes.length === raw.length && bytes.every((b, i) => b === raw[i]),
    `${bytes?.length} of ${raw.length} bytes`);
  check('a plain URL is not mistaken for inline data', dataUrlBytes('/fixtures/uart.sr') === null, 'null');
}

{
  const file = await exampleCaptureFile(dataUrl);
  const cap = await loadFiles([file]);
  // A UART line toggles: some channel carries edges.
  let highs = 0;
  for (let ch = 0; ch < cap.store.channelCount; ch++) highs += cap.store.edges(ch, 0, cap.store.length).length;
  check('the example opens through loadFiles like any .sr, under its own name',
    file.name === EXAMPLE_CAPTURE_NAME && cap.fileName === EXAMPLE_CAPTURE_NAME &&
      cap.store.length > 0 && cap.store.samplerate > 0 && cap.channelNames.length > 0 && highs > 0,
    `${cap.store.length} samples @ ${cap.store.samplerate} Hz, ${cap.channelNames.join('/')}`);
}

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const html = fs.readFileSync('index.html', 'utf8');
  const css = fs.readFileSync('src/ui/style.css', 'utf8');
  const wired = app.includes("import exampleCaptureUrl from '../../fixtures/uart.sr?url&inline';") &&
    app.includes("new SettingsMenu(this.el.open, 'open-menu')") &&
    app.includes('this.openMenu.toggle(this.openItems())') &&
    app.includes("{ label: t('open.example'), hint: t('open.exampleHint'), onPick: () => void this.openExample() }") &&
    app.includes('file = await exampleCaptureFile(exampleCaptureUrl);') &&
    app.includes('await this.openFiles([file]);') &&
    html.includes('aria-controls="open-menu"');
  check('Open is a two-row menu carrying the only example entry', wired, String(wired));

  interface Sources { html: string; app: string; css: string }
  const emptyHintActions = (src: Sources): string[] =>
    ([['index.html', src.html, 'empty-hint-example'],
      ['index.html', src.html, 'emptyHint.example'],
      ['src/ui/app.ts', src.app, 'hintExample'],
      ['src/ui/style.css', src.css, 'empty-hint-example']] as const)
      .filter(([, text, needle]) => text.includes(needle))
      .map(([file, , needle]) => `${file}:${needle}`);
  const leftovers = emptyHintActions({ html, app, css });
  const mutatedHtml = html.replace('<div id="wave-stack"></div>',
    '<div id="wave-stack"></div><button id="empty-hint-example" data-i18n="emptyHint.example"></button>');
  const mutatedApp = app.replace("hintDetail: must<HTMLSpanElement>('empty-hint-detail'),",
    "hintExample: must<HTMLButtonElement>('empty-hint-example'), hintDetail: must<HTMLSpanElement>('empty-hint-detail'),");
  const mutatedCss = `${css}\n.empty-hint-example { display: block; }\n`;
  const detected = emptyHintActions({ html: mutatedHtml, app: mutatedApp, css: mutatedCss });
  check('the empty-state hint carries no example action in markup, wiring or styles',
    leftovers.length === 0 && mutatedHtml !== html && mutatedApp !== app && detected.length === 4,
    `${leftovers.join(', ') || 'none'}; control detected ${detected.length}/4`);

  const keys = ['open.file', 'open.fileHint', 'open.example', 'open.exampleHint'] as const;
  const missing = keys.flatMap((key) => ([['zh-CN', zhCN], ['fr', fr], ['ru', ru]] as const)
    .filter(([, dict]) => !dict[key] || (dict[key] === en[key] && !/^[.\w ()]+$/.test(en[key])))
    .map(([locale]) => `${locale}:${key}`));
  const lingering = ([['en', en], ['zh-CN', zhCN], ['fr', fr], ['ru', ru]] as const)
    .filter(([, dict]) => 'emptyHint.example' in dict).map(([locale]) => locale);
  check('the example entries are translated and the empty-state copy is retired',
    missing.length === 0 && lingering.length === 0 && zhCN['open.example'] === '打开示例',
    `${missing.join(', ') || zhCN['open.example']}; lingering=${lingering.join(', ') || 'none'}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
