import {
  placeTooltip, titledAncestor, tipTransition, TIP_HIDDEN, TOOLTIP,
  type TipActions, type TipEvent, type TipState,
} from '../tooltip.js';

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

{
  const viewport = { width: 1000, height: 700 };
  const tip = { width: 120, height: 28 };
  const anchor = { left: 100, right: 140, top: 100, bottom: 128 };
  const p = placeTooltip(anchor, tip, viewport);
  const wantLeft = 120 - 60;
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
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'focus', anchor: B },
  ]);
  check('focus elsewhere while the pointer owns an anchor is a no-op (anchor stays A)',
    states[2]!.anchor === A && states[2]!.pointerInside && states[2]!.phase === 'visible'
      && !acts[2]!.show && !acts[2]!.hide && !acts[2]!.unstash && !acts[2]!.stash,
    `state=${JSON.stringify(states[2])}, act=${JSON.stringify(acts[2])}`);
}

{
  const { states, acts } = run([
    { type: 'enter', anchor: A }, { type: 'timer' }, { type: 'down' }, { type: 'timer' },
  ]);
  check('a stray timer after a parked press does not re-show the suppressed chip',
    states[3]!.phase === 'hidden' && states[3]!.suppressed && !acts[3]!.show,
    `state=${JSON.stringify(states[3])}, act=${JSON.stringify(acts[3])}`);
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
    'next.state.anchor === e.anchor',
    'new AbortController()',
    'requestAnimationFrame(',
    'TOOLTIP.showDelayMs',
  ];
  const missing = needles.filter((n) => !src.includes(n));
  const noMouse = !src.includes("'mouseover'") && !src.includes("'mousemove'");
  const noComments = !src.includes('//') && !src.includes('/*');
  check('tooltip.ts wires the designed event model (pointer events, top layer, guarded observer)',
    missing.length === 0 && noMouse && noComments,
    `missing=[${missing.join(' | ')}], noMouseEvents=${noMouse}, noComments=${noComments}`);
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

{
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const main = fs.readFileSync('src/ui/main.ts', 'utf8');
  const wired = main.includes("from './tooltip.js'") && main.includes('initTooltip();');
  const appAt = main.indexOf('new App()');
  const initAt = main.indexOf('initTooltip();');
  const guarded = appAt >= 0 && initAt > appAt && main.includes('tooltip layer failed to start');
  const capture = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const aria = capture.includes("mask.setAttribute('aria-label', mask.title)");
  check('main.ts wires initTooltip() guarded after App; the trigger mask has an accessible name',
    wired && guarded && aria,
    `wired=${wired}, guarded=${guarded}, appAt=${appAt}, initAt=${initAt}, aria=${aria}`);
}

{
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const css = fs.readFileSync('src/ui/style.css', 'utf8');
  const blockStart = css.indexOf('.tooltip {');
  const openStart = css.indexOf('.tooltip.open');
  const block = blockStart >= 0 && openStart > blockStart
    ? css.slice(blockStart, css.indexOf('}', openStart) + 1)
    : '';
  const needles: readonly string[] = [
    'inset: auto; margin: 0',
    'max-width: min(320px, calc(100vw - 16px))',
    'background: var(--popover)',
    'color: var(--popover-foreground)',
    'border: 1px solid var(--border)',
    'border-radius: var(--radius)',
    'box-shadow: 0 4px 12px rgb(0 0 0 / 40%)',
    'pointer-events: none',
    '.tooltip.open',
  ];
  const missing = needles.filter((n) => !block.includes(n));
  const noZIndex = !block.includes('z-index');
  const rawColors = (block.match(/#[0-9a-fA-F]{3,8}\b|oklch\(/g) ?? []).length;
  const darkOverride = css.includes('html[data-theme="dark"] .tooltip')
    && css.includes('box-shadow: 0 4px 12px var(--shadow)');
  check('style.css styles the tooltip with popover tokens, theme radius, sanctioned shadows',
    missing.length === 0 && noZIndex && rawColors === 0 && darkOverride,
    `missing=[${missing.join(' | ')}], noZIndex=${noZIndex}, rawColors=${rawColors}, darkOverride=${darkOverride}`);
}

{
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const src = fs.readFileSync('src/ui/tooltip.ts', 'utf8');
  const stashAt = src.indexOf('if (a.stash) doStash();');
  const stateAt = src.indexOf('state = next.state;', stashAt);
  const showAt = src.indexOf('if (a.show) doShow();', stateAt);
  const anchorGuardAt = src.indexOf('next.state.anchor === e.anchor');
  check('emit() orders stash → state adoption → show, with the anchor-adoption guard',
    stashAt >= 0 && stateAt > stashAt && showAt > stateAt && anchorGuardAt >= 0,
    `stashAt=${stashAt}, stateAt=${stateAt}, showAt=${showAt}, anchorGuardAt=${anchorGuardAt}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
