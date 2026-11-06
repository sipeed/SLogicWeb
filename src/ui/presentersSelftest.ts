// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Deterministic checks for the M1 presenter/window-class contract.
 *
 * No DOM, no device and no ambient viewport is consulted: every viewport and pointer
 * class is a literal, so the suite is identical on every machine.
 *
 * Run:
 *   node_modules/.bin/esbuild src/ui/presentersSelftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/presenters-selftest.mjs --log-level=error
 *   node /tmp/presenters-selftest.mjs
 */

import {
  LAYOUT_BREAKPOINTS,
  PANEL_IDS,
  TOUCH_TARGET_PX,
  closePresenter,
  createPanelViewModel,
  createPresenterLayout,
  decidePresenter,
  openPresenter,
  presenterInstanceCount,
  sheetMaxHeightPx,
  windowClassForWidth,
} from './presenters.js';
import type {
  PanelViewModel,
  PointerClass,
  PresenterChoice,
  PresenterInput,
  PresenterKind,
  PresenterReason,
  WindowClass,
} from './presenters.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const nodeProcess = (() => {
  const processLike = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!processLike || typeof processLike.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return processLike;
})();

function approx(actual: number, expected: number): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9;
}

function numberOrNaN(value: number | null): number {
  return value ?? Number.NaN;
}

function throws(run: () => unknown): boolean {
  try {
    run();
    return false;
  } catch {
    return true;
  }
}

/** A valid input must produce a choice; a refusal fails loudly in the test. */
function choice(input: PresenterInput): PresenterChoice {
  const decision = decidePresenter(input);
  if (decision.kind !== 'present') {
    throw new Error(`expected a presenter choice, got ${decision.reason}: ${decision.detail}`);
  }
  return decision;
}

// ---- DESIGN numbers are data, not magic numbers --------------------------

check(
  'DESIGN §3.1 breakpoints and target sizes are declared as data',
  LAYOUT_BREAKPOINTS.wideMinWidthPx === 1000 &&
    LAYOUT_BREAKPOINTS.mediumMinWidthPx === 760 &&
    LAYOUT_BREAKPOINTS.plotMinWidthPx.wide === 480 &&
    LAYOUT_BREAKPOINTS.plotMinWidthPx.medium === 480 &&
    LAYOUT_BREAKPOINTS.plotMinWidthPx.compact === 240 &&
    LAYOUT_BREAKPOINTS.dockedPresenterMinWidthPx === 280 &&
    LAYOUT_BREAKPOINTS.compactLabelColumnPx === 104 &&
    TOUCH_TARGET_PX === 48,
  `wide>=${LAYOUT_BREAKPOINTS.wideMinWidthPx}, medium>=${LAYOUT_BREAKPOINTS.mediumMinWidthPx}, ` +
    `plot=${LAYOUT_BREAKPOINTS.plotMinWidthPx.wide}/` +
    `${LAYOUT_BREAKPOINTS.plotMinWidthPx.medium}/` +
    `${LAYOUT_BREAKPOINTS.plotMinWidthPx.compact}, touch=${TOUCH_TARGET_PX}`,
);

check(
  'the sheet cap constants match min(72dvh, viewport - 96px)',
  LAYOUT_BREAKPOINTS.sheetMaxHeightRatio === 0.72 &&
    LAYOUT_BREAKPOINTS.sheetMaxHeightInsetPx === 96,
  `ratio=${LAYOUT_BREAKPOINTS.sheetMaxHeightRatio}, inset=${LAYOUT_BREAKPOINTS.sheetMaxHeightInsetPx}`,
);

check(
  'the eight ARCHITECTURE §6 panels are declared once',
  PANEL_IDS.length === 8 &&
    new Set(PANEL_IDS).size === PANEL_IDS.length &&
    PANEL_IDS[0] === 'device' &&
    PANEL_IDS[7] === 'diagnostics',
  PANEL_IDS.join(','),
);

// ---- window class boundaries --------------------------------------------

interface WidthCase {
  readonly widthPx: number;
  readonly windowClass: WindowClass;
  readonly presenter: PresenterKind;
  readonly reason: PresenterReason;
  readonly plotMinWidthPx: number;
}

const WIDTH_CASES: readonly WidthCase[] = [
  { widthPx: 5000, windowClass: 'wide', presenter: 'docked', reason: 'wide-docked', plotMinWidthPx: 480 },
  { widthPx: 1000, windowClass: 'wide', presenter: 'docked', reason: 'wide-docked', plotMinWidthPx: 480 },
  { widthPx: 999.999, windowClass: 'medium', presenter: 'docked', reason: 'medium-docked', plotMinWidthPx: 480 },
  { widthPx: 760, windowClass: 'medium', presenter: 'docked', reason: 'medium-docked', plotMinWidthPx: 480 },
  { widthPx: 759.999, windowClass: 'compact', presenter: 'sheet', reason: 'compact-sheet', plotMinWidthPx: 240 },
  { widthPx: 1, windowClass: 'compact', presenter: 'sheet', reason: 'compact-sheet', plotMinWidthPx: 240 },
];

for (const widthCase of WIDTH_CASES) {
  const decision = choice({
    viewport: { widthPx: widthCase.widthPx, heightPx: 900 },
    pointer: 'mouse',
  });
  check(
    `width ${widthCase.widthPx}px selects ${widthCase.windowClass}/${widthCase.presenter}`,
    decision.windowClass === widthCase.windowClass &&
      decision.presenter === widthCase.presenter &&
      decision.reason === widthCase.reason &&
      decision.plotMinWidthPx === widthCase.plotMinWidthPx,
    `got ${decision.windowClass}/${decision.presenter}/${decision.reason}, plot ${decision.plotMinWidthPx}px`,
  );
}

check(
  'windowClassForWidth has the same exact boundaries',
  windowClassForWidth(1000) === 'wide' &&
    windowClassForWidth(999.999) === 'medium' &&
    windowClassForWidth(760) === 'medium' &&
    windowClassForWidth(759.999) === 'compact',
  `1000=${windowClassForWidth(1000)}, 999.999=${windowClassForWidth(999.999)}, ` +
    `760=${windowClassForWidth(760)}, 759.999=${windowClassForWidth(759.999)}`,
);

const invalidWidthRefused =
  throws(() => windowClassForWidth(0)) &&
  throws(() => windowClassForWidth(-1)) &&
  throws(() => windowClassForWidth(Number.NaN)) &&
  throws(() => windowClassForWidth(Number.POSITIVE_INFINITY));
check(
  'windowClassForWidth refuses non-positive, NaN and infinite widths',
  invalidWidthRefused,
  `0/-1/NaN/Infinity rejected=${invalidWidthRefused}`,
);

// ---- pointer grammar: touch versus mouse/pen/keyboard -------------------

interface PointerCase {
  readonly label: string;
  readonly widthPx: number;
  readonly pointer: PointerClass;
  readonly presenter: PresenterKind;
  readonly reason: PresenterReason;
  readonly minimumTargetPx: number | null;
}

const POINTER_CASES: readonly PointerCase[] = [
  { label: 'medium mouse', widthPx: 800, pointer: 'mouse', presenter: 'docked', reason: 'medium-docked', minimumTargetPx: null },
  { label: 'medium pen', widthPx: 800, pointer: 'pen', presenter: 'docked', reason: 'medium-docked', minimumTargetPx: null },
  { label: 'medium keyboard', widthPx: 800, pointer: 'keyboard', presenter: 'docked', reason: 'medium-docked', minimumTargetPx: null },
  { label: 'medium touch', widthPx: 800, pointer: 'touch', presenter: 'sheet', reason: 'medium-touch-sheet', minimumTargetPx: 48 },
  { label: 'wide touch', widthPx: 1200, pointer: 'touch', presenter: 'docked', reason: 'wide-docked', minimumTargetPx: 48 },
  { label: 'compact mouse', widthPx: 600, pointer: 'mouse', presenter: 'sheet', reason: 'compact-sheet', minimumTargetPx: null },
];

for (const pointerCase of POINTER_CASES) {
  const decision = choice({
    viewport: { widthPx: pointerCase.widthPx, heightPx: 900 },
    pointer: pointerCase.pointer,
  });
  check(
    `${pointerCase.label} selects ${pointerCase.presenter}`,
    decision.presenter === pointerCase.presenter &&
      decision.reason === pointerCase.reason &&
      decision.minimumTargetPx === pointerCase.minimumTargetPx,
    `got ${decision.presenter}/${decision.reason}, target ${String(decision.minimumTargetPx)}`,
  );
}

// ---- height caps the sheet but never selects the class -------------------

const tall = choice({ viewport: { widthPx: 800, heightPx: 900 }, pointer: 'touch' });
const short = choice({ viewport: { widthPx: 800, heightPx: 400 }, pointer: 'touch' });
const shortViewport = choice({ viewport: { widthPx: 800, heightPx: 120 }, pointer: 'touch' });

check(
  'height does not change the window class or presenter',
  tall.windowClass === short.windowClass &&
    tall.presenter === short.presenter &&
    tall.windowClass === 'medium' &&
    tall.presenter === 'sheet',
  `900px=${tall.windowClass}/${tall.presenter}, 400px=${short.windowClass}/${short.presenter}`,
);

check(
  'sheet height follows min(72dvh, viewport - 96px)',
  approx(numberOrNaN(tall.sheetMaxHeightPx), 648) &&
    approx(numberOrNaN(short.sheetMaxHeightPx), 288) &&
    approx(numberOrNaN(shortViewport.sheetMaxHeightPx), 24),
  `900px=${String(tall.sheetMaxHeightPx)}, 400px=${String(short.sheetMaxHeightPx)}, ` +
    `120px=${String(shortViewport.sheetMaxHeightPx)}`,
);

check(
  'sheetMaxHeightPx clamps at zero for very short or invalid heights',
  sheetMaxHeightPx(90) === 0 && sheetMaxHeightPx(0) === 0 && sheetMaxHeightPx(Number.NaN) === 0,
  `90=${sheetMaxHeightPx(90)}, 0=${sheetMaxHeightPx(0)}, NaN=${sheetMaxHeightPx(Number.NaN)}`,
);

const wideDocked = choice({ viewport: { widthPx: 1200, heightPx: 900 }, pointer: 'mouse' });
const wideDialog = choice({
  viewport: { widthPx: 1200, heightPx: 900 },
  pointer: 'mouse',
  modal: 'blocking-panel',
});
check(
  'docked and dialog decisions carry no sheet height',
  wideDocked.presenter === 'docked' &&
    wideDocked.sheetMaxHeightPx === null &&
    wideDialog.presenter === 'dialog' &&
    wideDialog.sheetMaxHeightPx === null,
  `docked=${String(wideDocked.sheetMaxHeightPx)}, dialog=${String(wideDialog.sheetMaxHeightPx)}`,
);

// ---- explicit modal presenters ------------------------------------------

const destructive = choice({
  viewport: { widthPx: 800, heightPx: 900 },
  pointer: 'mouse',
  modal: 'destructive-confirmation',
});
const blocking = choice({
  viewport: { widthPx: 600, heightPx: 900 },
  pointer: 'touch',
  modal: 'blocking-panel',
});

check(
  'a destructive confirmation is a dialog on any window class',
  destructive.presenter === 'dialog' &&
    destructive.reason === 'modal-destructive-confirmation' &&
    destructive.windowClass === 'medium' &&
    destructive.sheetMaxHeightPx === null &&
    destructive.minimumTargetPx === null,
  `got ${destructive.windowClass}/${destructive.presenter}/${destructive.reason}`,
);

check(
  'a blocking panel is a dialog and overrides the compact sheet',
  blocking.presenter === 'dialog' &&
    blocking.reason === 'modal-blocking-panel' &&
    blocking.windowClass === 'compact' &&
    blocking.plotMinWidthPx === 240 &&
    blocking.minimumTargetPx === 48 &&
    blocking.sheetMaxHeightPx === null,
  `got ${blocking.windowClass}/${blocking.presenter}/${blocking.reason}, ` +
    `target ${String(blocking.minimumTargetPx)}`,
);

check(
  'every decision is frozen',
  Object.isFrozen(tall) && Object.isFrozen(wideDocked) && Object.isFrozen(destructive),
  `tall=${Object.isFrozen(tall)}, docked=${Object.isFrozen(wideDocked)}, ` +
    `dialog=${Object.isFrozen(destructive)}`,
);

// ---- invalid viewports are refused, not guessed --------------------------

const INVALID_INPUTS: readonly { readonly label: string; readonly input: PresenterInput }[] = [
  { label: 'zero width', input: { viewport: { widthPx: 0, heightPx: 900 }, pointer: 'mouse' } },
  { label: 'negative width', input: { viewport: { widthPx: -1, heightPx: 900 }, pointer: 'mouse' } },
  { label: 'NaN width', input: { viewport: { widthPx: Number.NaN, heightPx: 900 }, pointer: 'touch' } },
  { label: 'infinite width', input: { viewport: { widthPx: Number.POSITIVE_INFINITY, heightPx: 900 }, pointer: 'mouse' } },
  { label: 'zero height', input: { viewport: { widthPx: 800, heightPx: 0 }, pointer: 'mouse' } },
  { label: 'negative height', input: { viewport: { widthPx: 800, heightPx: -1 }, pointer: 'touch' } },
  { label: 'NaN height', input: { viewport: { widthPx: 800, heightPx: Number.NaN }, pointer: 'mouse' } },
];

for (const invalid of INVALID_INPUTS) {
  const decision = decidePresenter(invalid.input);
  check(
    `invalid viewport refused: ${invalid.label}`,
    decision.kind === 'refuse' &&
      decision.reason === 'invalid-viewport' &&
      decision.detail.length > 0,
    decision.kind === 'refuse' ? decision.detail : `accepted as ${decision.reason}`,
  );
}

// ---- immutable panel view models ----------------------------------------

const triggerView = createPanelViewModel('trigger', 'Trigger', {
  armed: true,
  conditions: [{ signal: 'D0', mode: 'rising' }],
});

check(
  'createPanelViewModel deeply freezes the model',
  Object.isFrozen(triggerView) &&
    Object.isFrozen(triggerView.data) &&
    Object.isFrozen(triggerView.data.conditions) &&
    Object.isFrozen(triggerView.data.conditions[0]),
  `model=${Object.isFrozen(triggerView)}, data=${Object.isFrozen(triggerView.data)}, ` +
    `conditions=${Object.isFrozen(triggerView.data.conditions)}`,
);

const blankTitleRefused = throws(() => createPanelViewModel('device', '   ', {}));
check(
  'a panel view model requires one non-empty header',
  blankTitleRefused,
  `blank header rejected=${blankTitleRefused}`,
);

/**
 * Type-level probes. `@ts-expect-error` fails `tsc` when the model stops being deeply
 * readonly, so the type half of the invariant is checked by the type-checker; the
 * runtime half is checked by the frozen mutations below.
 */
function mutateHeader<Data extends object>(view: PanelViewModel<Data>): void {
  // @ts-expect-error - a panel view model's header is readonly.
  view.title = 'mutated';
}

function mutateNestedArray(
  view: PanelViewModel<{ counts: number[]; meta: { label: string } }>,
): void {
  // @ts-expect-error - DeepReadonly makes array elements readonly.
  view.data.counts[0] = 99;
}

function mutateNestedObject(
  view: PanelViewModel<{ counts: number[]; meta: { label: string } }>,
): void {
  // @ts-expect-error - DeepReadonly makes nested object fields readonly.
  view.data.meta.label = 'mutated';
}

const nestedView = createPanelViewModel('measure', 'Measure', {
  counts: [3, 4],
  meta: { label: 'cursor' },
});

let headerThrew = false;
let arrayThrew = false;
let objectThrew = false;
try {
  mutateHeader(triggerView);
} catch {
  headerThrew = true;
}
try {
  mutateNestedArray(nestedView);
} catch {
  arrayThrew = true;
}
try {
  mutateNestedObject(nestedView);
} catch {
  objectThrew = true;
}

check(
  'frozen view models reject mutation at every depth at runtime',
  headerThrew && arrayThrew && objectThrew &&
    Object.isFrozen(nestedView.data.counts) &&
    Object.isFrozen(nestedView.data.meta),
  `header=${headerThrew}, array=${arrayThrew}, object=${objectThrew}`,
);

// ---- one presenter instance per layout ----------------------------------

const layout0 = createPresenterLayout();
check(
  'a fresh layout has exactly one empty presenter slot',
  layout0.active === null &&
    presenterInstanceCount(layout0) === 0 &&
    layout0.nextInstanceId === 1,
  `active=${String(layout0.active)}, count=${presenterInstanceCount(layout0)}`,
);

const wide = choice({ viewport: { widthPx: 1200, heightPx: 900 }, pointer: 'mouse' });
const compact = choice({ viewport: { widthPx: 600, heightPx: 900 }, pointer: 'touch' });
const modal = choice({
  viewport: { widthPx: 900, heightPx: 900 },
  pointer: 'mouse',
  modal: 'blocking-panel',
});

const viewA = createPanelViewModel('trigger', 'Trigger', { armed: true });
const viewB = createPanelViewModel('analyze', 'Analyze', { rows: [{ id: 1 }] });

const openedA = openPresenter(layout0, wide, viewA);
check(
  'opening a presenter mounts exactly one instance',
  openedA.kind === 'opened' &&
    openedA.replaced === null &&
    presenterInstanceCount(openedA.layout) === 1 &&
    openedA.layout.active === openedA.instance &&
    openedA.instance.id === 1 &&
    openedA.instance.presenter === 'docked',
  `count=${presenterInstanceCount(openedA.layout)}, id=${openedA.instance.id}`,
);

check(
  'opening does not mutate the previous layout state',
  layout0.active === null && layout0.nextInstanceId === 1 &&
    openedA.layout.active === openedA.instance,
  `layout0.active=${String(layout0.active)}`,
);

const openedB = openPresenter(openedA.layout, compact, viewB);
check(
  'opening a second presenter replaces the first instead of stacking it',
  openedB.replaced === openedA.instance &&
    openedB.layout.active === openedB.instance &&
    presenterInstanceCount(openedB.layout) === 1 &&
    openedA.layout.active === openedA.instance &&
    openedB.instance.id === 2,
  `replaced=${String(openedB.replaced?.id)}, count=${presenterInstanceCount(openedB.layout)}`,
);

check(
  'the instance carries the decision and the view model',
  openedB.instance.presenter === 'sheet' &&
    openedB.instance.windowClass === 'compact' &&
    openedB.instance.reason === 'compact-sheet' &&
    openedB.instance.view === viewB,
  `got ${openedB.instance.windowClass}/${openedB.instance.presenter}/${openedB.instance.reason}`,
);

const openedDialog = openPresenter(openedB.layout, modal, viewB);
check(
  'a dialog takes the same single presenter slot',
  openedDialog.replaced === openedB.instance &&
    openedDialog.layout.active === openedDialog.instance &&
    presenterInstanceCount(openedDialog.layout) === 1 &&
    openedDialog.instance.presenter === 'dialog' &&
    openedDialog.instance.id === 3,
  `replaced=${String(openedDialog.replaced?.id)}, count=${presenterInstanceCount(openedDialog.layout)}`,
);

const sharedDocked = openPresenter(layout0, wide, viewA);
const sharedSheet = openPresenter(sharedDocked.layout, compact, viewA);
check(
  'one immutable view model feeds docked and sheet presenters',
  sharedSheet.instance.view === sharedDocked.instance.view &&
    Object.isFrozen(sharedSheet.instance.view),
  `same object=${sharedSheet.instance.view === sharedDocked.instance.view}, ` +
    `frozen=${Object.isFrozen(sharedSheet.instance.view)}`,
);

const rawView = {
  panel: 'analyze' as const,
  title: 'Analyze',
  data: { rows: [{ id: 1 }] },
};
const rawOpen = openPresenter(layout0, wide, rawView);
check(
  'openPresenter deep-freezes a view model it is handed',
  Object.isFrozen(rawView) &&
    Object.isFrozen(rawView.data.rows) &&
    Object.isFrozen(rawView.data.rows[0]) &&
    rawOpen.instance.view === rawView,
  `rows=${Object.isFrozen(rawView.data.rows)}`,
);

// ---- close and stale-close behaviour ------------------------------------

const staleClose = closePresenter(openedDialog.layout, openedA.instance.id);
check(
  'a stale close leaves the current presenter mounted',
  staleClose.kind === 'unchanged' &&
    staleClose.closed === null &&
    staleClose.layout === openedDialog.layout &&
    staleClose.layout.active === openedDialog.instance,
  `kind=${staleClose.kind}, active=${String(staleClose.layout.active?.id)}`,
);

const closed = closePresenter(openedDialog.layout, openedDialog.instance.id);
check(
  'closing the current instance empties the slot and keeps ids monotonic',
  closed.kind === 'closed' &&
    closed.closed === openedDialog.instance &&
    closed.layout.active === null &&
    presenterInstanceCount(closed.layout) === 0 &&
    closed.layout.nextInstanceId === 4,
  `kind=${closed.kind}, nextId=${closed.layout.nextInstanceId}`,
);

const emptyClose = closePresenter(closed.layout);
check(
  'closing an empty layout is unchanged',
  emptyClose.kind === 'unchanged' &&
    emptyClose.closed === null &&
    emptyClose.layout === closed.layout,
  `kind=${emptyClose.kind}`,
);

const reopened = openPresenter(closed.layout, wide, viewA);
const backClose = closePresenter(reopened.layout);
check(
  'close without an id closes the active presenter (back/close path)',
  backClose.kind === 'closed' &&
    backClose.closed === reopened.instance &&
    backClose.layout.active === null,
  `kind=${backClose.kind}, closed=${String(backClose.closed?.id)}`,
);

// ---- report -------------------------------------------------------------

console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
