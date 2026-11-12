// SPDX-License-Identifier: GPL-3.0-or-later

import { installFakeDom, type FakeElement } from './fakeDom.js';
import { TOOLBAR_HINT_ATTRIBUTE, applyToolbarHints } from '../toolbarHints.js';

interface TestResult { name: string; pass: boolean; detail: string }

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const doc = installFakeDom();
const root = doc as unknown as ParentNode;

type Hint = readonly [string, string];

const STATIC_HINTS: readonly Hint[] = [
  ['btn-open', 'Open capture'],
  ['btn-save', 'Save capture'],
  ['btn-settings', 'Settings'],
  ['btn-language', 'Language'],
  ['btn-theme', 'Theme'],
];

const OUTSIDE_TITLES: readonly Hint[] = [
  ['corner-summary', 'Summary'],
  ['help-tip', 'Help'],
];

const OUTSIDE_STASH = 'Sidebar summary';

interface HintView { title: string | null; hint: string | null }

const view = (el: FakeElement): HintView => ({
  title: el.getAttribute('title'),
  hint: el.getAttribute(TOOLBAR_HINT_ATTRIBUTE),
});

const isStashed = (v: HintView, text: string): boolean => v.title === null && v.hint === text;
const isRestored = (v: HintView, text: string): boolean => v.title === text && v.hint === null;

const snapshot = (els: readonly FakeElement[]): string => els
  .map((el) => `${el.id}|${el.getAttribute('title') ?? '-'}|${el.getAttribute(TOOLBAR_HINT_ATTRIBUTE) ?? '-'}`)
  .join(';');

function carrier(id: string, text: string): FakeElement {
  const el = doc.createElement('button');
  el.id = id;
  el.setAttribute('title', text);
  return el;
}

interface Fixture { toolbar: FakeElement; carriers: FakeElement[]; outside: FakeElement[] }

function buildToolbar(hints: readonly Hint[] = STATIC_HINTS): Fixture {
  doc.body.replaceChildren();
  const toolbar = doc.createElement('div');
  toolbar.id = 'toolbar';
  const carriers = hints.map(([id, text]) => {
    const el = carrier(id, text);
    toolbar.append(el);
    return el;
  });
  const outside = OUTSIDE_TITLES.map(([id, text]) => {
    const el = carrier(id, text);
    if (id === 'help-tip') el.className = 'help-tip';
    return el;
  });
  doc.body.append(toolbar, ...outside);
  return { toolbar, carriers, outside };
}

function buildScopedToolbar(hints: readonly Hint[] = STATIC_HINTS): Fixture {
  const f = buildToolbar(hints);
  const stashed = doc.createElement('button');
  stashed.id = 'sidebar-summary';
  stashed.setAttribute(TOOLBAR_HINT_ATTRIBUTE, OUTSIDE_STASH);
  doc.body.append(stashed);
  return { toolbar: f.toolbar, carriers: f.carriers, outside: [...f.outside, stashed] };
}

function outsideIntact(f: Fixture): boolean {
  const [corner, help, stashed] = f.outside;
  return isRestored(view(corner!), OUTSIDE_TITLES[0]![1]) &&
    isRestored(view(help!), OUTSIDE_TITLES[1]![1]) &&
    isStashed(view(stashed!), OUTSIDE_STASH);
}

{
  const f = buildToolbar();
  const claim = (): boolean => f.carriers.every((el, i) => isStashed(view(el), STATIC_HINTS[i]![1]));
  const moved = applyToolbarHints(root, true);
  check('stash: every toolbar title moves into data-hint-title and the title is gone',
    moved === 5 && claim(),
    `moved=${moved}, views=${f.carriers.map((el) => JSON.stringify(view(el))).join(' ')}`);

  f.carriers[0]!.setAttribute('title', STATIC_HINTS[0]![1]);
  check('control: the stash claim fails when a title is written back onto a carrier',
    !claim(), `view=${JSON.stringify(view(f.carriers[0]!))}`);
}

{
  const f = buildToolbar();
  applyToolbarHints(root, true);
  const claim = (): boolean => f.carriers.every((el, i) => isRestored(view(el), STATIC_HINTS[i]![1]));
  const moved = applyToolbarHints(root, false);
  check('restore: every stashed hint returns as the identical title and the stash is gone',
    moved === 5 && claim(),
    `moved=${moved}, views=${f.carriers.map((el) => JSON.stringify(view(el))).join(' ')}`);

  f.carriers[2]!.setAttribute(TOOLBAR_HINT_ATTRIBUTE, STATIC_HINTS[2]![1]);
  check('control: the restore claim fails when a stash survives next to the restored title',
    !claim(), `view=${JSON.stringify(view(f.carriers[2]!))}`);
}

{
  const f = buildToolbar();
  applyToolbarHints(root, true);
  const before = snapshot(f.carriers);
  const second = applyToolbarHints(root, true);
  const after = snapshot(f.carriers);
  check('idempotency: a second pass with the same mode moves nothing and changes no attribute',
    second === 0 && before === after,
    `second=${second}, before=${before}, after=${after}`);

  f.carriers[1]!.setAttribute('title', STATIC_HINTS[1]![1]);
  const mutated = snapshot(f.carriers);
  const third = applyToolbarHints(root, true);
  check('control: the idempotency claim fails once a fresh title lands on a carrier',
    mutated !== before && third === 1,
    `mutatedDifferent=${mutated !== before}, third=${third}`);
}

{
  const f = buildScopedToolbar();
  const onMoved = applyToolbarHints(root, true);
  const onClaim = outsideIntact(f);
  const offMoved = applyToolbarHints(root, false);
  const offClaim = outsideIntact(f);
  applyToolbarHints(root, true);
  check('scoping: titles outside #toolbar keep their title and an outside stash keeps its hint, in both modes',
    onMoved === 5 && offMoved === 5 && onClaim && offClaim,
    `onMoved=${onMoved}, offMoved=${offMoved}, onClaim=${onClaim}, offClaim=${offClaim}, ` +
    `views=${f.outside.map((el) => JSON.stringify(view(el))).join(' ')}`);

  f.toolbar.append(f.outside[0]!);
  const movedInside = applyToolbarHints(root, true);
  const hiddenInside = !outsideIntact(f);
  applyToolbarHints(root, false);
  const backOutside = outsideIntact(f);
  check('control: the scoping claim fails while the outside title carrier sits inside #toolbar',
    movedInside === 1 && hiddenInside && backOutside,
    `movedInside=${movedInside}, hidden=${hiddenInside}, back=${backOutside}, ` +
    `view=${JSON.stringify(view(f.outside[0]!))}, ` +
    `stash=${JSON.stringify(view(f.outside[2]!))}`);

  const g = buildScopedToolbar();
  g.toolbar.append(g.outside[2]!);
  const restoredInside = applyToolbarHints(root, false);
  const restoredBad = !outsideIntact(g);
  applyToolbarHints(root, true);
  const backStashed = outsideIntact(g);
  check('control: the scoping claim fails while the outside stash carrier sits inside #toolbar',
    restoredInside === 1 && restoredBad && backStashed,
    `restoredInside=${restoredInside}, bad=${restoredBad}, back=${backStashed}, ` +
    `view=${JSON.stringify(view(g.outside[2]!))}`);
}

{
  const f = buildToolbar([['btn-empty', '']]);
  const bare = doc.createElement('button');
  bare.id = 'btn-bare';
  f.toolbar.append(bare);
  const moved = applyToolbarHints(root, true);
  const claim = (): boolean => view(f.carriers[0]!).title === '' &&
    view(f.carriers[0]!).hint === null && view(bare).title === null && view(bare).hint === null;
  check('an empty title and an attribute-less command are skipped: neither is stashed nor counted',
    moved === 0 && claim(), `moved=${moved}, views=${JSON.stringify(view(f.carriers[0]!))} ${JSON.stringify(view(bare))}`);

  f.carriers[0]!.setAttribute('title', 'Open capture');
  const mutated = applyToolbarHints(root, true);
  check('control: the skip claim fails once the empty title carries text',
    mutated === 1 && !claim(), `mutated=${mutated}, view=${JSON.stringify(view(f.carriers[0]!))}`);
}

{
  doc.body.replaceChildren();
  const empty = applyToolbarHints(root, true);
  const emptyOff = applyToolbarHints(root, false);
  const detached = doc.createElement('div');
  const orphan = carrier('btn-open', 'Open capture');
  detached.append(orphan);
  const orphanRoot = detached as unknown as ParentNode;
  const noToolbar = applyToolbarHints(orphanRoot, true);
  check('an empty root and a root without #toolbar move nothing and touch no title',
    empty === 0 && emptyOff === 0 && noToolbar === 0 &&
    orphan.getAttribute('title') === 'Open capture' && orphan.getAttribute(TOOLBAR_HINT_ATTRIBUTE) === null,
    `empty=${empty}, emptyOff=${emptyOff}, noToolbar=${noToolbar}, view=${JSON.stringify(view(orphan))}`);

  const wrapped = doc.createElement('div');
  wrapped.id = 'toolbar';
  wrapped.append(orphan);
  detached.append(wrapped);
  const wrappedMoved = applyToolbarHints(orphanRoot, true);
  check('control: the no-toolbar claim fails once the same carrier sits under a #toolbar ancestor',
    wrappedMoved === 1 && orphan.getAttribute('title') === null, `wrappedMoved=${wrappedMoved}`);
}

{
  const hints: readonly Hint[] = [...STATIC_HINTS, ['btn-connect', 'Connect device']];
  const f = buildToolbar(hints);
  const pre = f.carriers[hints.length - 1]!;
  pre.removeAttribute('title');
  pre.setAttribute(TOOLBAR_HINT_ATTRIBUTE, 'Connect device');
  const stashClaim = (): boolean => f.carriers.every((el, i) => isStashed(view(el), hints[i]![1]));
  const moved = applyToolbarHints(root, true);
  const stashOk = stashClaim();
  const restored = applyToolbarHints(root, false);
  const restoreOk = f.carriers.every((el, i) => isRestored(view(el), hints[i]![1]));
  check('mixed: a pre-stashed carrier keeps its stash while five fresh titles move, then all six restore',
    moved === 5 && stashOk && restored === 6 && restoreOk,
    `moved=${moved}, stashOk=${stashOk}, restored=${restored}, restoreOk=${restoreOk}`);

  const g = buildToolbar(hints);
  g.carriers[hints.length - 1]!.setAttribute(TOOLBAR_HINT_ATTRIBUTE, 'Connect device');
  const mutated = applyToolbarHints(root, true);
  check('control: the mixed claim fails when the pre-stashed carrier also carries a fresh title',
    mutated === 6 && mutated !== moved, `mutated=${mutated}, moved=${moved}`);
}

{
  const hints: readonly Hint[] = [...STATIC_HINTS, ['btn-connect', 'Connect device']];
  const f = buildToolbar(hints);
  const pre = f.carriers[hints.length - 1]!;
  pre.setAttribute(TOOLBAR_HINT_ATTRIBUTE, 'Old connect');
  const claim = (): boolean => isStashed(view(pre), 'Connect device');
  const moved = applyToolbarHints(root, true);
  const stashOk = claim();
  check('stale stash: a fresh title overwrites the stale stash and drops the title',
    moved === 6 && stashOk,
    `moved=${moved}, view=${JSON.stringify(view(pre))}`);

  pre.setAttribute(TOOLBAR_HINT_ATTRIBUTE, 'Old connect');
  check('control: the stale-stash claim fails once the carrier carries a different stale stash',
    stashOk && !claim(),
    `view=${JSON.stringify(view(pre))}, stashOk=${stashOk}`);
}

{
  const padded = '  Connect device  ';
  const trimmed = padded.trim();
  const hints: readonly Hint[] = [...STATIC_HINTS, ['btn-connect', padded]];
  const f = buildToolbar(hints);
  const last = f.carriers[hints.length - 1]!;
  const stashText = (): string | null => last.getAttribute(TOOLBAR_HINT_ATTRIBUTE);
  const titleText = (): string | null => last.getAttribute('title');
  const claim = (): boolean => titleText() === padded && stashText() === null;
  const stashed = applyToolbarHints(root, true);
  const stashSeen = stashText();
  const stashedOk = stashSeen === padded;
  const restored = applyToolbarHints(root, false);
  const restoredOk = claim();
  check('byte-exact: a padded hint is stashed and restored with its padding intact',
    stashed === 6 && stashedOk && restored === 6 && restoredOk,
    `stashed=${stashed}, stash=${JSON.stringify(stashSeen)}, restored=${restored}, ` +
    `title=${JSON.stringify(titleText())}`);

  last.setAttribute(TOOLBAR_HINT_ATTRIBUTE, trimmed);
  check('control: the byte-exact claim fails once the stash carries the trimmed text',
    stashedOk && restoredOk && !claim(),
    `stash=${JSON.stringify(stashText())}, title=${JSON.stringify(titleText())}, ` +
    `trimmed=${JSON.stringify(trimmed)}`);
}

{
  const hints: readonly Hint[] = [...STATIC_HINTS, ['btn-connect', 'Connect device']];
  const f = buildToolbar(hints);
  const last = f.carriers[hints.length - 1]!;
  last.setAttribute('title', 'Live connect');
  last.setAttribute(TOOLBAR_HINT_ATTRIBUTE, 'Connect device');
  const claim = (): boolean => isRestored(view(last), 'Connect device');
  const moved = applyToolbarHints(root, false);
  const stashOk = claim();
  check('restore resolution: the stash replaces a live title instead of deferring to it',
    moved === 1 && stashOk,
    `moved=${moved}, view=${JSON.stringify(view(last))}`);

  last.setAttribute('title', 'Live connect');
  check('control: the restore-resolution claim fails once the live title is written back',
    stashOk && !claim(),
    `view=${JSON.stringify(view(last))}, stashOk=${stashOk}`);
}

{
  const namesAttribute = (name: string): boolean => TOOLBAR_HINT_ATTRIBUTE === name;
  const pinnedOk = namesAttribute('data-hint-title');
  check('attribute pin: TOOLBAR_HINT_ATTRIBUTE is the data-hint-title literal',
    pinnedOk, `attribute=${JSON.stringify(TOOLBAR_HINT_ATTRIBUTE)}`);

  check('control: the attribute pin fails for a different literal',
    pinnedOk && !namesAttribute('data-hint-stash'),
    `attribute=${JSON.stringify(TOOLBAR_HINT_ATTRIBUTE)}, pinnedOk=${pinnedOk}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
