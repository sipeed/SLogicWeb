// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the tooltip layer suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/tooltip-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/tooltip-selftest.mjs && node /tmp/tooltip-selftest.mjs
 *
 * Run from the repository root. Prints PASS/FAIL per check and exits non-zero on any
 * failure.
 *
 * What is pinned here:
 *
 *   - placeTooltip: below-center happy path, flip above at the bottom edge, no flip
 *     when above lacks room too, left/right viewport clamps, margin honored, and the
 *     degenerate narrow viewport where the lower clamp bound must win;
 *   - tipTransition: the full event table — enter/leave, retarget restores the
 *     previous anchor before stashing the next, pending timer show, visible-anchor
 *     instant re-anchor (tooltip tour), down/escape/scroll suppression while parked,
 *     suppressed anchors do not re-show on re-entry, suppression clears on leave,
 *     focus shows immediately WITHOUT stashing, blur cleanup, pointer+focus
 *     ownership hand-off both directions, external title rewrite, anchorDied;
 *   - titledAncestor: titled parent found, empty/blank titles skipped, null-safe;
 *   - tooltip.ts module shape: pointer events (never mouse events), touch filter,
 *     elementFromPoint fallback, popover top layer, guarded MutationObserver,
 *     :focus-visible gate, isConnected revalidation, AbortController teardown;
 *   - index.html keeps its title/data-i18n-title attributes (source of truth
 *     unmigrated) — guards against accidental call-site migration.
 */

import {
  placeTooltip, titledAncestor, tipTransition, TIP_HIDDEN, TOOLTIP,
  type TipActions, type TipEvent, type TipState,
} from '../tooltip.js';

/** Same structural-typing trick as i18n-selftest.ts: node access without @types/node. */
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(p: string, enc: 'utf8'): string;
}

const fs = (() => {
  const get = nodeProcess.getBuiltinModule;
  return (typeof get === 'function' ? get.call(nodeProcess, 'node:fs') : undefined) as FsLike | undefined;
})();

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

// ------------------------------------------------------------------ placement

{
  const viewport = { width: 1000, height: 700 };
  const tip = { width: 120, height: 28 };
  const anchor = { left: 100, right: 140, top: 100, bottom: 128 };
  const p = placeTooltip(anchor, tip, viewport);
  const wantLeft = 120 - 60; // anchor center 120, half tip 60
  check('placeTooltip centers below the anchor with the configured gap',
    p.side === 'below' && p.top === 128 + TOOLTIP.anchorGap && p.left === wantLeft,
    `side=${p.side}, top=${p.top}, left=${p.left}, wantTop=${128 + TOOLTIP.anchorGap}, wantLeft=${wantLeft}`);
}

{
  const viewport = { width: 1000, height: 700 };
  const tip = { width: 120, height: 28 };
  const anchor = { left: 100, right: 140, top: 640, bottom: 668 };
  const p = placeTooltip(anchor, tip, viewport);
  const wantTop = 640 - TOOLTIP.anchorGap - 28;
  check('placeTooltip flips above when below overflows and above has room',
    p.side === 'above' && p.top === wantTop,
    `side=${p.side}, top=${p.top}, wantTop=${wantTop}`);
}

{
  const viewport = { width: 1000, height: 60 };
  const tip = { width: 120, height: 28 };
  const anchor = { left: 100, right: 140, top: 16, bottom: 30 };
  const p = placeTooltip(anchor, tip, viewport);
  check('placeTooltip stays below (clamped) when neither side has room',
    p.side === 'below' && p.top >= TOOLTIP.viewportMargin
      && p.top + tip.height <= viewport.height - TOOLTIP.viewportMargin + tip.height
      && p.top === Math.max(TOOLTIP.viewportMargin,
        Math.min(30 + TOOLTIP.anchorGap, viewport.height - TOOLTIP.viewportMargin - tip.height)),
    `side=${p.side}, top=${p.top}`);
}

{
  const viewport = { width: 1000, height: 700 };
  const tip = { width: 120, height: 28 };
  const leftAnchor = { left: 0, right: 30, top: 100, bottom: 128 };
  const rightAnchor = { left: 970, right: 1000, top: 100, bottom: 128 };
  const pl = placeTooltip(leftAnchor, tip, viewport);
  const pr = placeTooltip(rightAnchor, tip, viewport);
  check('placeTooltip clamps horizontally to the viewport margins',
    pl.left === TOOLTIP.viewportMargin
      && pr.left === viewport.width - TOOLTIP.viewportMargin - tip.width,
    `left=${pl.left}, right=${pr.left}, wantL=${TOOLTIP.viewportMargin}, wantR=${viewport.width - TOOLTIP.viewportMargin - tip.width}`);
}

{
  const viewport = { width: 100, height: 40 };
  const tip = { width: 320, height: 28 };
  const anchor = { left: 0, right: 40, top: 0, bottom: 10 };
  const p = placeTooltip(anchor, tip, viewport);
  check('placeTooltip degenerate viewport: the lower clamp bound wins',
    p.left === TOOLTIP.viewportMargin && p.top === TOOLTIP.viewportMargin,
    `left=${p.left}, top=${p.top}`);
}

// ------------------------------------------------------------- state machine

/** Run an event sequence, collecting the union of action flags per step. */
function run(seq: readonly TipEvent[]): { states: TipState[]; acts: TipActions[] } {
  const states: TipState[] = [];
  const acts: TipActions[] = [];
  let s: TipState = TIP_HIDDEN;
  for (const e of seq) {
    const next = tipTransition(s, e);
    s = next.state;
    states.push(s);
    acts.push(next.act);
  }
  return { states, acts };
}

const A = { name: 'A' };
const B = { name: 'B' };

{
  const { states, acts } = run([
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'leave' },
  ]);
  const enter = acts[0]!; const show = acts[1]!; const leave = acts[2]!;
  check('enter → timer → leave: stash+delay, show, then unstash+hide+cleanup',
    states[0]!.phase === 'pending' && enter.stash && enter.startTimer
      && states[1]!.phase === 'visible' && show.show
      && states[2] === TIP_HIDDEN && leave.unstash && leave.hide && leave.cancelTimer,
    `phases=${states.map((s) => s.phase).join(',')}, enter=${JSON.stringify(enter)}, leave=${JSON.stringify(leave)}`);
}

{
  const { states, acts } = run([
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'enter', anchor: B },
  ]);
  const retarget = acts[2]!;
  check('visible retarget: unstash previous BEFORE stashing next, instant re-show (tour)',
    states[2]!.phase === 'visible' && states[2]!.anchor === B
      && retarget.unstash && retarget.stash && retarget.show && !retarget.startTimer,
    `state=${JSON.stringify(states[2])}, act=${JSON.stringify(retarget)}`);
}

{
  const { acts } = run([
    { type: 'enter', anchor: A }, { type: 'enter', anchor: B },
  ]);
  const retarget = acts[1]!;
  check('pending retarget: unstash first, fresh timer for the new anchor',
    retarget.unstash && retarget.stash && retarget.cancelTimer && retarget.startTimer
      && !retarget.show,
    `act=${JSON.stringify(retarget)}`);
}

{
  const { states, acts } = run([
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'down' },
    { type: 'enter', anchor: A }, { type: 'leave' },
  ]);
  const down = acts[2]!; const reenter = acts[3]!; const leave = acts[4]!;
  check('down while parked: hide+suppress+stay stashed; re-entry does NOT re-show; leave restores',
    states[2]!.phase === 'hidden' && states[2]!.suppressed && states[2]!.stashed
      && down.hide && !down.unstash
      && states[3]!.suppressed && states[3]!.phase === 'hidden' && !reenter.show && !reenter.startTimer
      && states[4] === TIP_HIDDEN && leave.unstash,
    `down=${JSON.stringify(down)}, reenter=${JSON.stringify(reenter)}, suppressed=${states[3]!.suppressed}`);
}

for (const hard of ['escape', 'scroll'] as const) {
  const { states, acts } = run([{ type: 'enter', anchor: A }, { type: 'timer' }, { type: hard }]);
  check(`${hard} while parked behaves like down (hide+suppress, keep stash)`,
    states[2]!.phase === 'hidden' && states[2]!.suppressed && states[2]!.stashed
      && acts[2]!.hide && !acts[2]!.unstash,
    `state=${JSON.stringify(states[2])}, act=${JSON.stringify(acts[2])}`);
}

{
  const { states, acts } = run([{ type: 'focus', anchor: A }]);
  check('focus shows immediately WITHOUT stashing (title stays as AT description)',
    states[0]!.phase === 'visible' && states[0]!.focusInside && !states[0]!.stashed
      && acts[0]!.show && !acts[0]!.stash && !acts[0]!.startTimer,
    `state=${JSON.stringify(states[0])}, act=${JSON.stringify(acts[0])}`);
}

{
  const { states, acts } = run([{ type: 'focus', anchor: A }, { type: 'blur' }]);
  check('focus then blur: full cleanup, nothing to unstash',
    states[1] === TIP_HIDDEN && acts[1]!.hide && !acts[1]!.unstash,
    `act=${JSON.stringify(acts[1])}`);
}

{
  const { states, acts } = run([
    { type: 'focus', anchor: A }, { type: 'enter', anchor: A }, { type: 'leave' },
  ]);
  const enter = acts[1]!; const leave = acts[2]!;
  check('focus-owned anchor + pointer enter/leave: stash on hover, keep showing on leave, unstash',
    states[1]!.stashed && enter.stash && !enter.show
      && states[2]!.phase === 'visible' && states[2]!.focusInside && !states[2]!.stashed
      && leave.unstash && !leave.hide,
    `enter=${JSON.stringify(enter)}, leave=${JSON.stringify(leave)}, state2=${JSON.stringify(states[2])}`);
}

{
  const { states, acts } = run([
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'focus', anchor: A }, { type: 'blur' },
  ]);
  check('pointer-owned anchor + focus/blur: blur hands ownership back to the pointer',
    states[2]!.focusInside && !acts[2]!.show
      && states[3]!.phase === 'visible' && !states[3]!.focusInside && !acts[3]!.hide,
    `state3=${JSON.stringify(states[3])}, blurAct=${JSON.stringify(acts[3])}`);
}

{
  const { states, acts } = run([
    { type: 'focus', anchor: A }, { type: 'enter', anchor: B },
  ]);
  const enter = acts[1]!;
  check('pointer enter elsewhere dismisses a focus-owned anchor (single-anchor model)',
    states[1]!.anchor === B && !states[1]!.focusInside && enter.stash,
    `state=${JSON.stringify(states[1])}, act=${JSON.stringify(enter)}`);
}

{
  const { states, acts } = run([
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'rewrite' },
  ]);
  const rewrite = acts[2]!;
  check('external title rewrite while visible: re-stash + update text, state untouched',
    states[2]!.phase === 'visible' && states[2]!.stashed
      && rewrite.stash && rewrite.updateText && !rewrite.show && !rewrite.hide,
    `state=${JSON.stringify(states[2])}, act=${JSON.stringify(rewrite)}`);
}

{
  const { acts } = run([
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'anchorDied' },
  ]);
  const died = acts[2]!;
  check('anchorDied: hide + cleanup WITHOUT unstash (detached element)',
    died.hide && died.cancelTimer && !died.unstash,
    `act=${JSON.stringify(died)}`);
}

{
  const stray = tipTransition(TIP_HIDDEN, { type: 'timer' });
  const strayLeave = tipTransition(TIP_HIDDEN, { type: 'leave' });
  const strayEscape = tipTransition(TIP_HIDDEN, { type: 'escape' });
  const idle = !stray.act.show && !stray.act.hide && stray.state === TIP_HIDDEN
    && strayLeave.state === TIP_HIDDEN && strayEscape.state === TIP_HIDDEN;
  check('stray events on the hidden state are total no-ops', idle,
    `timer=${JSON.stringify(stray.act)}, leave=${JSON.stringify(strayLeave.act)}`);
}

// ------------------------------------------------------------ anchor resolver

{
  const titled = { getAttribute: (n: string) => (n === 'title' ? 'hint' : null) } as Element;
  const empty = { getAttribute: (n: string) => (n === 'title' ? '  ' : null) } as Element;
  const child = { closest: () => titled } as Pick<Element, 'closest'>;
  const blankChild = { closest: () => empty } as Pick<Element, 'closest'>;
  const orphan = { closest: () => null } as Pick<Element, 'closest'>;
  check('titledAncestor finds titled parents, skips blank titles, tolerates null',
    titledAncestor(child) === titled && titledAncestor(blankChild) === null
      && titledAncestor(orphan) === null && titledAncestor(null) === null,
    `titled=${titledAncestor(child) === titled}, blank=${titledAncestor(blankChild)}, orphan=${titledAncestor(orphan)}`);
}

// -------------------------------------------------------------- module shape

{
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const src = fs.readFileSync('src/ui/tooltip.ts', 'utf8');
  const needles: readonly string[] = [
    "addEventListener('pointerover'",
    "addEventListener('pointerout'",
    "addEventListener('pointermove'",
    "addEventListener('focusin'",
    "addEventListener('focusout'",
    "e.pointerType === 'touch'",
    'document.elementFromPoint(',
    "tip.setAttribute('popover', 'manual')",
    'showPopover()',
    'hidePopover()',
    'new MutationObserver(',
    "attributeFilter: ['title']",
    "anchorEl.getAttribute('title') === null",
    "removeAttribute('title')",
    "anchor.matches(':focus-visible')",
    'anchorEl.isConnected',
    'new AbortController()',
    'requestAnimationFrame(',
    'TOOLTIP.showDelayMs',
  ];
  const missing = needles.filter((n) => !src.includes(n));
  const noMouse = !src.includes("'mouseover'") && !src.includes("'mousemove'");
  check('tooltip.ts wires the designed event model (pointer events, top layer, guarded observer)',
    missing.length === 0 && noMouse,
    `missing=[${missing.join(' | ')}], noMouseEvents=${noMouse}`);
}

{
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const html = fs.readFileSync('index.html', 'utf8');
  const titles = (html.match(/\stitle="/g) ?? []).length;
  const i18nTitles = (html.match(/data-i18n-title="/g) ?? []).length;
  check('index.html keeps title/data-i18n-title as the unmigrated source of truth',
    titles >= 7 && i18nTitles >= 6,
    `title attrs=${titles}, data-i18n-title attrs=${i18nTitles}`);
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
