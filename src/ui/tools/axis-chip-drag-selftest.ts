// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Dragging a cursor by its numbered chip on the time axis (DESIGN §6.3).
 *
 *   node src/tools/run-all-tests.mjs --filter axis-chip
 *
 * The ruler pans on a drag; a pointerdown on a placed cursor chip must instead grab that
 * cursor through the same WaveformMarker grab/move path as the plot (snapping included),
 * with the 48 px touch target. The pure hit-test decides chip-vs-pan; the source checks
 * pin that the axis handler consults it before it starts a pan.
 */

import { hitCursorChip, layoutCursorChips, type MeasuredCursorChip } from '../cursorSet.js';
import { AXIS } from '../metrics.js';
import { TOUCH_TARGET_PX } from '../presenters.js';
import { WaveformMarker } from '../waveformMarker.js';
import { interactionHints } from '../interactionHints.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
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

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const CHIP_W = 14;
const measure = (): number => CHIP_W;
function placed(xs: readonly number[], width = 800): MeasuredCursorChip[] {
  return layoutCursorChips(xs.map((cssX, i) => ({ id: i + 1, label: String(i + 1), cssX })), measure, width)
    .map((chip) => ({ ...chip, width: CHIP_W }));
}
const { top, height, rowGap } = AXIS.markerChip;
const rowY = (row: 0 | 1): number => top + row * (height + rowGap) + height / 2;

// ------------------------------------------------------------------ hit-test

{
  const chips = placed([100, 400]);
  const onFirst = hitCursorChip(chips, 100, rowY(0));
  const onEdge = hitCursorChip(chips, 100 + CHIP_W / 2, rowY(0));
  const beside = hitCursorChip(chips, 100 + CHIP_W / 2 + 1, rowY(0));
  const below = hitCursorChip(chips, 100, top + height + 1);
  const between = hitCursorChip(chips, 250, rowY(0));
  check('a mouse press inside a chip box hits that chip; beside, below or between chips pans',
    onFirst?.id === 1 && onEdge?.id === 1 && beside === null && below === null && between === null,
    `on=${onFirst?.id}, edge=${onEdge?.id}, beside=${beside?.id}, below=${below?.id}, between=${between?.id}`);
}

{
  const chips = placed([100, 400]);
  const near = hitCursorChip(chips, 100 + 20, 26, TOUCH_TARGET_PX);
  const far = hitCursorChip(chips, 100 + 25, 26, TOUCH_TARGET_PX);
  const mouseNear = hitCursorChip(chips, 100 + 20, 26, null);
  check('touch grows a chip to the 48 px target; the mouse keeps the painted box',
    TOUCH_TARGET_PX === 48 && near?.id === 1 && far === null && mouseNear === null,
    `near=${near?.id}, far=${far?.id}, mouse=${mouseNear?.id}`);
}

{
  // Two cursors 6 px apart: the layout spreads their chips; a touch between them takes
  // the one whose box centre is nearer, never the further one.
  const chips = placed([300, 306]);
  const left = chips.find((c) => c.id === 1)!;
  const right = chips.find((c) => c.id === 2)!;
  const leftHit = hitCursorChip(chips, left.boxX - 1, rowY(left.row), TOUCH_TARGET_PX);
  const rightHit = hitCursorChip(chips, right.boxX + 1, rowY(right.row), TOUCH_TARGET_PX);
  const mouseRight = hitCursorChip(chips, right.boxX, rowY(right.row));
  check('overlapping touch targets resolve to the nearest chip; each painted box hits its own cursor',
    leftHit?.id === 1 && rightHit?.id === 2 && mouseRight?.id === 2,
    `boxes=${left.boxX}/${left.row},${right.boxX}/${right.row}, ` +
    `left=${leftHit?.id}, right=${rightHit?.id}, mouse=${mouseRight?.id}`);
}

{
  const none = hitCursorChip([], 10, 10);
  const nan = hitCursorChip(placed([100]), Number.NaN, 5);
  check('no chips, or a non-finite pointer, is never a hit', none === null && nan === null,
    `none=${none}, nan=${nan}`);
}

// ------------------------------------------------------------------ the grab path

{
  // A chip pushed beside its line (boxX != anchorX) still grabs through tryGrab at the
  // line, and the drag keeps the press offset: no jump on the first move.
  const marker = new WaveformMarker('1', '#fff');
  marker.setSample(500, 10_000);
  const grabbed = marker.tryGrab({
    pointerId: 7, clientX: 120, clientY: 5, pointerCssX: 100, markerCssX: 100,
    channel: null, captureLength: 10_000,
  });
  const offset = 120 - 100;
  // 1 sample per CSS px around the line: the pointer moves 30 px -> the line moves 30 samples.
  const toSample = (cssX: number): number => 500 + (cssX - 100);
  const still = marker.move({ pointerId: 7, clientX: 120, clientY: 5, sample: toSample(120 - offset), captureLength: 10_000 });
  const atRest = marker.sample;
  marker.move({ pointerId: 7, clientX: 150, clientY: 5, sample: toSample(150 - offset), captureLength: 10_000 });
  const moved = marker.sample;
  const ended = marker.endDrag(7);
  check('an axis-chip grab drags the cursor by the pointer delta, not to the pointer',
    grabbed && still && atRest === 500 && moved === 530 && ended && !marker.isDragging,
    `grabbed=${grabbed}, rest=${atRest}, moved=${moved}, ended=${ended}`);
}

// ------------------------------------------------------------------ App wiring

const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
}

{
  const down = between(app, "axis.addEventListener('pointerdown', (e) => {", '    });');
  const grabAt = down.indexOf('this.tryGrabAxisChip(e)');
  const returnAt = down.indexOf('return;', grabAt);
  const panAt = down.indexOf('axisDrag = true');
  check('the axis pointerdown tries the chip grab first and only pans when it misses',
    grabAt >= 0 && returnAt > grabAt && panAt > returnAt &&
      down.includes("if (e.pointerType === 'mouse' && e.button !== 0) return;"),
    `grab=${grabAt}, return=${returnAt}, pan=${panAt}`);
}

{
  const move = between(app, "axis.addEventListener('pointermove', (e) => {", '\n    });');
  const markerAt = move.indexOf('cursor.marker.move({');
  const panAt = move.indexOf('this.stack.panPixels(');
  const snaps = move.includes('snap: this.snapContext(channel, sample),') &&
    move.includes('this.toSample(e.clientX - plotRect.left - this.axisChipOffset)');
  const grab = between(app, '  private tryGrabAxisChip(e: PointerEvent): boolean {', '\n  }\n');
  const viaMarker = grab.includes('cursor.marker.tryGrab({') &&
    grab.includes('pointerCssX: chip.anchorX,') && grab.includes('markerCssX: chip.anchorX,');
  const hit = between(app, '  private axisChipAt(e: PointerEvent): MeasuredCursorChip | null {', '\n  }\n');
  const touch = hit.includes("e.pointerType === 'touch' ? TOUCH_TARGET_PX : null");
  check('an axis-chip drag moves the marker with the plot\'s snapping and the 48 px touch target',
    markerAt >= 0 && panAt > markerAt && snaps && viaMarker && touch,
    `marker=${markerAt}, pan=${panAt}, snaps=${snaps}, viaMarker=${viaMarker}, touch=${touch}`);
}

{
  const end = between(app, 'const axisEnd = (e: PointerEvent) => {', '\n    };');
  const ends = end.includes('cursor.marker.endDrag(e.pointerId)') && end.includes('this.renderPanels();');
  const lost = app.includes("axis.addEventListener('lostpointercapture', (e) => {");
  const grabCss = /#axis\.marker-grab\s*\{\s*cursor:\s*grab;\s*\}/.test(css) &&
    /#axis\.marker-grabbing\s*\{\s*cursor:\s*grabbing;\s*\}/.test(css);
  const painter = app.includes('private measuredAxisChips(): MeasuredCursorChip[] {') &&
    app.includes('return this.cursorChipPlacements(measure, this.el.plot.clientWidth)');
  check('release ends the chip drag, capture loss cancels it, and the ruler shows grab/grabbing over chips',
    ends && lost && grabCss && painter, `ends=${ends}, lost=${lost}, css=${grabCss}, painter=${painter}`);
}

{
  const keys = interactionHints('axis', { hasCapture: true }).map((spec) => spec.key);
  const without = interactionHints('axis', { hasCapture: false }).map((spec) => spec.key);
  const catalogs = [en, zhCN, fr, ru].every((m) => typeof m['hints.axis.dragCursor'] === 'string' &&
    m['hints.axis.dragCursor'].length > 0);
  const distinct = new Set([en, zhCN, fr, ru].map((m) => m['hints.axis.dragCursor'])).size === 4;
  check('the axis hint bar advertises the chip drag after the pan, only with a capture, in every locale',
    keys.indexOf('hints.axis.dragCursor') > keys.indexOf('hints.axis.dragPan') &&
      keys.includes('hints.axis.dragPan') && !without.includes('hints.axis.dragCursor') &&
      catalogs && distinct,
    `keys=${keys.join(',')}, without=${without.join(',')}, catalogs=${catalogs}, distinct=${distinct}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
