// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * File-handling guards (src/ui/fileGuards.ts) and their App/index.html wiring:
 *
 *   - the drag-and-drop overlay: FileDragDepth's nested enter/leave counting, the
 *     overlay element and its locale key, the empty hint's "or drag it here" in every
 *     locale and variant, and the window listeners that toggle `#plot.drop-active`;
 *   - the unsaved-capture guard: the captureUnsaved truth table, the weakly keyed save
 *     record, the destructive ConfirmDialog (fake DOM), its locale keys, and the App
 *     wiring for Open (button before the chooser, drag-drop), saves and beforeunload.
 *
 *   npm test -- --filter file-guards
 */

import { FileDragDepth, SavedCaptures, captureUnsaved, dragHasFiles } from '../fileGuards.js';
import { ConfirmDialog } from '../confirmDialog.js';
import type { SampleStore } from '../../data/types.js';
import { byText, fakeEvent, installFakeDom, type FakeElement } from './fakeDom.js';
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

// ---------------------------------------------------------------- unsaved rule
{
  const base = { labelKind: 'live', length: 100, running: false, savedLength: undefined };
  const cases: Array<[string, Parameters<typeof captureUnsaved>[0], boolean]> = [
    ['a completed device capture', base, true],
    ['an empty capture', { ...base, length: 0 }, false],
    ['an opened file', { ...base, labelKind: 'loaded' }, false],
    ['saved at this length', { ...base, savedLength: 100 }, false],
    ['saved, then grown', { ...base, savedLength: 60 }, true],
    ['saved but still running', { ...base, running: true, savedLength: 100 }, true],
    ['a stopped-without-trigger capture with data', { ...base, labelKind: 'stoppedNoTrigger' }, true],
    ['a running capture with no data yet', { ...base, running: true, length: 0 }, false],
  ];
  const wrong = cases.filter(([, input, want]) => captureUnsaved(input) !== want).map(([n]) => n);
  check('captureUnsaved: device data until saved; files, empty and saved captures are not',
    wrong.length === 0, wrong.join(', '));

  const saved = new SavedCaptures();
  const a = { length: 10 } as SampleStore;
  const b = { length: 10 } as SampleStore;
  saved.mark(a, 10);
  check('a save is remembered per store (a new wave of equal length is unsaved)',
    saved.lengthOf(a) === 10 && saved.lengthOf(b) === undefined);
}

// ---------------------------------------------------------------- confirm dialog
async function confirmDialogChecks(): Promise<void> {
  const doc = installFakeDom();
  const invoker = doc.createElement('button');
  doc.body.appendChild(invoker);
  const text = { title: 'T?', body: 'B.', confirm: 'Discard', cancel: 'Keep' };
  const dialog = new ConfirmDialog();
  const host = (): FakeElement => doc.body.querySelector('dialog')!;

  const yes = dialog.ask(text, invoker as unknown as HTMLElement);
  const opened = host().open && byText(host(), 'T?').some((el) => el.localName === 'h2') &&
    byText(host(), 'B.').some((el) => el.localName === 'p');
  const safeFocus = doc.activeElement === byText(host(), 'Keep')[0];
  byText(host(), 'Discard')[0]!.click();
  const yesAnswer = await yes;
  check('confirm opens a modal with the text, focuses Cancel, and resolves true on confirm',
    opened && safeFocus && yesAnswer && !host().open && doc.activeElement === invoker,
    `opened=${opened}, focus=${safeFocus}, answer=${yesAnswer}, open=${host().open}`);

  const no = dialog.ask(text, invoker as unknown as HTMLElement);
  byText(host(), 'Keep')[0]!.click();
  const escape = dialog.ask(text, invoker as unknown as HTMLElement);
  const cancelEvent = fakeEvent('cancel');
  host().dispatchEvent(cancelEvent);
  const first = dialog.ask(text, invoker as unknown as HTMLElement);
  const second = dialog.ask(text, invoker as unknown as HTMLElement);
  byText(host(), 'Discard')[0]!.click();
  const answers = [await no, await escape, cancelEvent.defaultPrevented, await first, await second];
  check('Cancel, Esc (cancel event) and a superseded request all resolve false',
    answers.join(',') === 'false,false,true,false,true' &&
    doc.body.querySelectorAll('dialog').length === 1,
    answers.join(','));
}

// ---------------------------------------------------------------- unsaved wiring
{
  const keys = ['unsaved.title', 'unsaved.openBody', 'unsaved.discard', 'unsaved.cancel'] as const;
  const untranslated = ([['zh-CN', zhCN], ['fr', fr], ['ru', ru]] as Array<[string, Messages]>)
    .flatMap(([name, m]) => keys.filter((k) => m[k] === en[k]).map((k) => `${name}:${k}`));
  check('the discard confirmation is translated, and zh-CN asks the reviewed sentence',
    untranslated.length === 0 && zhCN['unsaved.openBody'] === '当前采集尚未保存，打开文件将丢弃它？',
    untranslated.join(', '));

  const openBody = app.split('private async openFiles(files: File[], confirmed = false): Promise<void> {')[1]
    ?.split('\n  }\n')[0] ?? '';
  const openGuard = openBody.trimStart().startsWith(
    'if (!confirmed && !(await this.confirmDiscardCapture())) return;');
  // Open is a two-row menu now; its "Open file..." entry routes through pickFiles, which
  // asks before the chooser opens. The example entry is guarded inside openFiles instead.
  const button = app.includes('this.openMenu.toggle(this.openItems());') &&
    app.includes("{ label: t('open.file'), hint: t('open.fileHint'), onPick: () => void this.pickFiles() },") &&
    app.includes('if (files.length) void this.openFiles(files, true);');
  const pickBody = app.split('private async pickFiles(): Promise<void> {')[1]?.split('\n  }\n')[0] ?? '';
  const pick = pickBody.indexOf('this.confirmDiscardCapture()') >= 0 &&
    pickBody.indexOf('this.confirmDiscardCapture()') < pickBody.indexOf('this.el.fileInput.click();');
  const dropOpens = (app.split("window.addEventListener('drop', (e) => {")[1] ?? '')
    .includes('if (files.length) void this.openFiles(files);');
  check('Open (button before the chooser) and drag-drop both ask before replacing the capture',
    openGuard && button && pick && dropOpens,
    `open=${openGuard}, button=${button}, pick=${pick}, drop=${dropOpens}`);

  const saveBody = app.split('private async save(format: CaptureFileFormat): Promise<void> {')[1]
    ?.split('\n  }\n')[0] ?? '';
  const savedMarks = saveBody.split('this.noteCaptureSaved(store, savedLength);').length - 1;
  const guard = app.includes("window.addEventListener('beforeunload', this.unloadGuard);") &&
    app.includes("window.removeEventListener('beforeunload', this.unloadGuard);") &&
    app.includes('event.preventDefault();\n        // Older Chromium/Safari still need returnValue set to show the prompt.\n        event.returnValue = \'\';');
  const synced = app.includes('    this.syncUnloadGuard();\n    const repeatPending = this.repeatTimer.pending;') &&
    app.includes('    this.syncUnloadGuard();\n    const waiters = this.captureWaiters;');
  check('both save paths mark the capture saved; beforeunload is registered only while needed',
    savedMarks === 2 && guard && synced, `marks=${savedMarks}, guard=${guard}, synced=${synced}`);
}

await confirmDialogChecks();

console.log(`\n${passed}/${passed + failures.length} passed`);
nodeProcess.exit(failures.length === 0 ? 0 : 1);
