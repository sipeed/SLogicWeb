// SPDX-License-Identifier: GPL-3.0-or-later

import { installFakeDom } from './fakeDom.js';
import { applyCaptureLock, captureOptionsLocked, type CaptureLockState } from '../captureLock.js';

interface FsLike { readFileSync(path: string, encoding: 'utf8'): string }
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const doc = installFakeDom();

const state = (overrides: Partial<CaptureLockState> = {}): CaptureLockState => ({
  running: false, stopping: false, repeatPending: false, ...overrides,
});

{
  const idle = state();
  check('idle (no capture, no stop, no repeat wait) releases the capture options',
    captureOptionsLocked(idle) === false, `locked=${captureOptionsLocked(idle)}`);

  const running = state({ running: true });
  check('a running capture locks the capture options',
    captureOptionsLocked(running) === true, `locked=${captureOptionsLocked(running)}`);

  const stopping = state({ stopping: true });
  check('a stopping capture locks the capture options',
    captureOptionsLocked(stopping) === true, `locked=${captureOptionsLocked(stopping)}`);

  const pending = state({ repeatPending: true });
  check('a Repeat pending for its next wave keeps the capture options locked',
    captureOptionsLocked(pending) === true, `locked=${captureOptionsLocked(pending)}`);

  const owned = state({ running: true, stopping: true, repeatPending: true });
  check('all three owners at once still locks (the disjuncts combine)',
    captureOptionsLocked(owned) === true, `locked=${captureOptionsLocked(owned)}`);

  const released = state();
  check('the app does not own the capture (ready, completed or aborted) releases the capture options',
    captureOptionsLocked(released) === false, `locked=${captureOptionsLocked(released)}`);
}

{
  const el = doc.createElement('div') as unknown as HTMLElement;
  const classes = (node: HTMLElement): string[] => node.className.split(/\s+/).filter(Boolean);
  const returned = applyCaptureLock(el, true);
  const firstClass = classes(el);
  check('applyCaptureLock returns the node it marked and adds capture-lockable once',
    returned === el && firstClass.length === 1 && firstClass[0] === 'capture-lockable',
    `same=${returned === el}, class=${el.className}`);

  const lockedAttr = el.getAttribute('data-capture-lock');
  applyCaptureLock(el, true);
  const stillLocked = el.getAttribute('data-capture-lock');
  check('a locked node carries data-capture-lock="true" and stays at exactly one class entry when re-applied',
    lockedAttr === 'true' && stillLocked === 'true' && classes(el).length === 1 &&
      el.className.split('capture-lockable').length - 1 === 1,
    `attr=${lockedAttr}, again=${stillLocked}, class=${el.className}`);

  applyCaptureLock(el, false);
  const unlockedAttr = el.getAttribute('data-capture-lock');
  check('re-applying with false writes the string "false" and keeps the lockable marker',
    unlockedAttr === 'false' && el.classList.contains('capture-lockable') && classes(el).length === 1,
    `attr=${unlockedAttr}, class=${el.className}`);

  applyCaptureLock(el, false);
  applyCaptureLock(el, true);
  check('repeated toggling leaves one capture-lockable entry and the last value wins',
    el.getAttribute('data-capture-lock') === 'true' &&
      el.className.split('capture-lockable').length - 1 === 1,
    `attr=${el.getAttribute('data-capture-lock')}, class=${el.className}`);
}

interface CssRule { selector: string; decls: string }

function lockRules(source: string): CssRule[] {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: CssRule[] = [];
  const re = /([^{}]*\.capture-lockable[^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) out.push({ selector: (m[1] ?? '').trim(), decls: (m[2] ?? '').trim() });
  return out;
}

function decl(rule: CssRule | undefined, prop: string): string | null {
  if (!rule) return null;
  for (const part of rule.decls.split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === prop) return part.slice(at + 1).trim();
  }
  return null;
}

{
  const fs = (nodeProcess.getBuiltinModule?.('node:fs') ?? null) as FsLike | null;
  if (!fs) throw new Error('node fs module unavailable');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

  const predicateCalls = panel.split('captureOptionsLocked(').length - 1;
  check('the panel derives the lock from one captureOptionsLocked(v) call',
    predicateCalls === 1 && panel.includes('const captureLocked = captureOptionsLocked(v);'),
    `calls=${predicateCalls}`);

  const applied = panel.split('applyCaptureLock(').length - 1;
  const appended = panel.split('modeSec.body.appendChild(applyCaptureLock(').length - 1;
  const surfaces = ['applyCaptureLock(seg, captureLocked)',
    'applyCaptureLock(duration.el, captureLocked)',
    'applyCaptureLock(interval.el, captureLocked)',
    'applyCaptureLock(windowControl.el, captureLocked)'];
  check('the segmented group and each of the three time-control roots are appended through applyCaptureLock',
    applied === surfaces.length && appended === surfaces.length && surfaces.every((s) => panel.includes(s)),
    `calls=${applied}, appended=${appended}, missing=${surfaces.filter((s) => !panel.includes(s)).join('|') || 'none'}`);

  const timeControlBlocks = panel.split('acquisitionTimeControl({').slice(1);
  const disabledBlocks = timeControlBlocks.filter((block) => block.includes('disabled: captureLocked,'));
  check('all three acquisitionTimeControl blocks take disabled: captureLocked',
    timeControlBlocks.length === 3 && disabledBlocks.length === 3,
    `blocks=${timeControlBlocks.length}, disabled=${disabledBlocks.length}`);

  check('the mode buttons keep their own disabled write on the shared predicate',
    panel.includes('b.disabled = captureLocked;'), `present=${panel.includes('b.disabled = captureLocked;')}`);

  check('the retired modeLocked / timeLocked locals are gone',
    !panel.includes('modeLocked') && !panel.includes('timeLocked'),
    `modeLocked=${panel.includes('modeLocked')}, timeLocked=${panel.includes('timeLocked')}`);

  check('the lock stays inside the Capture section: channel width and analog still follow v.stopping, the pre-trigger select still follows v.running || v.stopping',
    panel.includes('b.disabled = v.stopping;') && panel.includes('const analogBusy = v.stopping;') &&
      panel.includes('pre.disabled = v.running || v.stopping;'),
    `width=${panel.includes('b.disabled = v.stopping;')}, analog=${panel.includes('const analogBusy = v.stopping;')}, pre=${panel.includes('pre.disabled = v.running || v.stopping;')}`);

  const rules = lockRules(sheet);
  const base = rules.find((r) => r.selector === '.capture-lockable');
  const veil = rules.find((r) => r.selector === '.capture-lockable[data-capture-lock="true"]::after');
  const area = rules.find((r) => r.selector === '.capture-lockable[data-capture-lock="true"]');
  const inner = rules.find((r) => r.selector === '.capture-lockable[data-capture-lock="true"] :disabled');
  check('the lockable surfaces are positioned relative so the veil can cover them',
    decl(base, 'position') === 'relative', `base=${base?.decls ?? 'missing'}`);

  const veilContent = decl(veil, 'content');
  const veilBackground = decl(veil, 'background');
  check('the veil is an absolute over-covering pseudo-element that paints a color-mix wash and owns the pointer as not-allowed',
    decl(veil, 'position') === 'absolute' && decl(veil, 'inset') === '-1px' &&
      veilContent === '""' && (veilBackground?.startsWith('color-mix(') ?? false) &&
      decl(veil, 'pointer-events') === 'auto' && decl(veil, 'cursor') === 'not-allowed',
    `veil=${veil?.decls ?? 'missing'}`);

  check('the locked block and its disabled children both paint cursor: not-allowed',
    decl(area, 'cursor') === 'not-allowed' && decl(inner, 'cursor') === 'not-allowed',
    `area=${decl(area, 'cursor')}, disabled=${decl(inner, 'cursor')}`);

  const block = rules.map((r) => `${r.selector}{${r.decls}}`).join('\n');
  const hex = block.match(/#[0-9a-fA-F]{3,8}\b/);
  const functional = block.match(/(?:^|[^-a-zA-Z])(?:rgb|rgba|hsl|hsla|oklch|lab|lch)\(/);
  check('the lock block uses tokens (--muted, --radius) only, with no literal or functional colour and no !important',
    rules.length === 4 && block.includes('var(--muted)') && block.includes('var(--radius)') &&
      hex === null && functional === null && !block.includes('!important'),
    `rules=${rules.length}, hex=${hex?.[0] ?? 'none'}, functional=${functional?.[0]?.trim() ?? 'none'}, important=${block.includes('!important')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
