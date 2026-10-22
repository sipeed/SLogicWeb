// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import {
  MARKER_GRAB_RADIUS_CSS, clampMarkerSample, isMarkerGrab,
} from '../markerGeometry.js';
import { WaveformMarker, type MarkerPaintTarget } from '../waveformMarker.js';

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

interface DrawCall {
  x: number;
  color: string;
  label: string;
}

function recordingTarget(calls: DrawCall[]): MarkerPaintTarget {
  return {
    drawCursor: (x: number, color: string, label: string) => { calls.push({ x, color, label }); },
  };
}

interface GrabOptions {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  pointerCssX?: number;
  markerCssX?: number;
  channel?: number | null;
  captureLength?: number;
}

function grab(marker: WaveformMarker, options: GrabOptions = {}): boolean {
  return marker.tryGrab({
    pointerId: options.pointerId ?? 1,
    clientX: options.clientX ?? 100,
    clientY: options.clientY ?? 50,
    pointerCssX: options.pointerCssX ?? 400,
    markerCssX: options.markerCssX ?? 400,
    channel: options.channel === undefined ? 2 : options.channel,
    captureLength: options.captureLength ?? 1000,
  });
}

function moveTo(
  marker: WaveformMarker,
  sample: number,
  clientX = 140,
  clientY = 50,
  pointerId = 1,
  captureLength = 1000,
): boolean {
  return marker.move({ pointerId, clientX, clientY, sample, captureLength });
}

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = a >= 0 ? source.indexOf(end, a) : -1;
  return a >= 0 && b > a ? source.slice(a, b) : '';
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  check('a new marker owns its label, colour, and an absent sample',
    marker.label === 'A' && marker.color === '#CD427E' && marker.sample === null &&
    !marker.isDragging && marker.pointerId === null && marker.channel === null &&
    !marker.started,
    `label=${marker.label}, color=${marker.color}, sample=${String(marker.sample)}, ` +
    `dragging=${marker.isDragging}, pointerId=${String(marker.pointerId)}, ` +
    `channel=${String(marker.channel)}, started=${marker.started}`);
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(42, 1000);
  check('setSample writes the exact in-range sample',
    marker.sample === 42, `actual=${String(marker.sample)}`);

  marker.setSample(7.5, 1000);
  check('setSample rounds a fractional sample before storing it',
    marker.sample === 8, `actual=${String(marker.sample)}`);

  marker.setSample(-5, 1000);
  const low = marker.sample;
  marker.setSample(5000, 1000);
  const high = marker.sample;
  check('setSample clamps both capture endpoints instead of storing an offset',
    low === 0 && high === 999, `low=${String(low)}, high=${String(high)}`);

  marker.setSample(Number.NaN, 1000);
  const nan = marker.sample;
  marker.setSample(Number.POSITIVE_INFINITY, 1000);
  const infinite = marker.sample;
  check('invalid programmatic samples clear instead of storing NaN or Infinity',
    nan === null && infinite === null, `nan=${String(nan)}, infinite=${String(infinite)}`);

  marker.setSample(-1, 0);
  check('a programmatic write into an empty capture clears instead of storing -1',
    marker.sample === null, `actual=${String(marker.sample)}`);

  marker.setSample(12, Number.NaN);
  check('a non-finite capture length also clears the sample',
    marker.sample === null, `actual=${String(marker.sample)}`);

  marker.setSample(12, 1000);
  marker.setSample(null, 1000);
  check('a null programmatic write clears the sample',
    marker.sample === null, `actual=${String(marker.sample)}`);
}

{
  const calls: DrawCall[] = [];
  const target = recordingTarget(calls);
  const marker = new WaveformMarker('A', '#CD427E');
  const toPx = (sample: number) => sample / 2 + 0.25;

  marker.draw(target, toPx);
  check('an absent sample paints nothing',
    calls.length === 0, `draws=${calls.length}`);

  marker.setSample(10, 1000);
  marker.draw(target, toPx);
  const exact = calls.length === 1 && calls[0]!.x === 5.25 &&
    calls[0]!.color === '#CD427E' && calls[0]!.label === 'A';
  check('one present sample produces exactly one draw at the supplied pixel',
    exact, `draws=${calls.length}, calls=${JSON.stringify(calls)}`);

  const controlCalls: DrawCall[] = [];
  const controlTarget = recordingTarget(controlCalls);
  marker.draw(controlTarget, toPx);
  marker.draw(controlTarget, toPx);
  check('control: the recording target counts a second draw instead of hiding it',
    controlCalls.length === 2,
    `draws=${controlCalls.length}, calls=${JSON.stringify(controlCalls)}`);
}

{
  check('the grab band is the literal 4 CSS px',
    MARKER_GRAB_RADIUS_CSS === 4, `radius=${MARKER_GRAB_RADIUS_CSS}`);

  const atBoundary = isMarkerGrab(10, 14);
  const pastBoundary = isMarkerGrab(10, 14.0001);
  const mirrored = isMarkerGrab(14, 10);
  check('the inclusive grab band is exactly 4 CSS px and symmetric',
    atBoundary && !pastBoundary && mirrored,
    `at4=${atBoundary}, at4.0001=${pastBoundary}, mirrored=${mirrored}`);

  check('control: the grab band is not always false',
    isMarkerGrab(10, 6) && isMarkerGrab(10, 10),
    `inside=${isMarkerGrab(10, 6)}, exact=${isMarkerGrab(10, 10)}`);

  check('non-finite grab inputs never start a grab',
    !isMarkerGrab(Number.NaN, 10) && !isMarkerGrab(10, Number.NaN) &&
    !isMarkerGrab(10, Number.POSITIVE_INFINITY),
    `nanX=${isMarkerGrab(Number.NaN, 10)}, nanMarker=${isMarkerGrab(10, Number.NaN)}, ` +
    `infiniteMarker=${isMarkerGrab(10, Number.POSITIVE_INFINITY)}`);
}

{
  check('the clamp helper returns the exact endpoints',
    clampMarkerSample(0, 10) === 0 && clampMarkerSample(9, 10) === 9,
    `low=${String(clampMarkerSample(0, 10))}, high=${String(clampMarkerSample(9, 10))}`);
  check('the clamp helper clamps out-of-domain samples and rounds fractions',
    clampMarkerSample(-1, 10) === 0 && clampMarkerSample(10, 10) === 9 &&
    clampMarkerSample(2.6, 10) === 3,
    `below=${String(clampMarkerSample(-1, 10))}, above=${String(clampMarkerSample(10, 10))}, ` +
    `round=${String(clampMarkerSample(2.6, 10))}`);
  check('the clamp helper reports null for invalid input instead of a sample',
    clampMarkerSample(Number.NaN, 10) === null && clampMarkerSample(5, 0) === null &&
    clampMarkerSample(5, 0.5) === null && clampMarkerSample(5, Number.NaN) === null,
    `nan=${String(clampMarkerSample(Number.NaN, 10))}, zero=${String(clampMarkerSample(5, 0))}, ` +
    `fraction=${String(clampMarkerSample(5, 0.5))}, ` +
    `nanLength=${String(clampMarkerSample(5, Number.NaN))}`);
  check('control: the clamp helper is not always null',
    clampMarkerSample(5, 10) === 5, `actual=${String(clampMarkerSample(5, 10))}`);
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  const noSample = grab(marker);
  check('a marker without a sample refuses a grab even inside the band',
    !noSample, `grabbed=${noSample}`);

  marker.setSample(0, 10);
  const emptyCapture = grab(marker, { captureLength: 0 });
  check('a grab is refused while the capture is empty',
    !emptyCapture, `grabbed=${emptyCapture}`);
  const badLength = grab(marker, { captureLength: Number.NaN });
  check('a grab is refused while the capture length is non-finite',
    !badLength, `grabbed=${badLength}`);
  const badChannel = grab(marker, { channel: 1.5 });
  check('a grab is refused for a non-integral channel',
    !badChannel, `grabbed=${badChannel}`);

  const noRow = new WaveformMarker('A', '#CD427E');
  noRow.setSample(0, 10);
  const noRowGrab = grab(noRow, { channel: null });
  check('a grab over a location with no channel or lane row freezes a null channel',
    noRowGrab && noRow.isDragging && noRow.channel === null,
    `grabbed=${noRowGrab}, dragging=${noRow.isDragging}, ` +
    `channel=${String(noRow.channel)}`);
  const noRowMove = moveTo(noRow, 4, 104, 50);
  check('a null-channel session still follows the pointer',
    noRowMove && noRow.started && noRow.sample === 4,
    `consumed=${noRowMove}, started=${noRow.started}, sample=${String(noRow.sample)}`);
  const noRowEnd = noRow.endDrag(1);
  check('ending a null-channel session clears the frozen channel and keeps the sample',
    noRowEnd && !noRow.isDragging && noRow.channel === null && noRow.sample === 4,
    `ended=${noRowEnd}, dragging=${noRow.isDragging}, ` +
    `channel=${String(noRow.channel)}, sample=${String(noRow.sample)}`);

  const nanX = new WaveformMarker('A', '#CD427E');
  nanX.setSample(0, 10);
  const nanXGrab = grab(nanX, { clientX: Number.NaN });
  const infiniteY = new WaveformMarker('A', '#CD427E');
  infiniteY.setSample(0, 10);
  const infiniteYGrab = grab(infiniteY, { clientY: Number.POSITIVE_INFINITY });
  const nanPointer = new WaveformMarker('A', '#CD427E');
  nanPointer.setSample(0, 10);
  const nanPointerGrab = grab(nanPointer, { pointerId: Number.NaN });
  check('non-finite grab coordinates or a non-finite pointer id never start a session',
    !nanXGrab && !infiniteYGrab && !nanPointerGrab &&
    !nanX.isDragging && !infiniteY.isDragging && !nanPointer.isDragging,
    `nanX=${nanXGrab}, infiniteY=${infiniteYGrab}, nanPointer=${nanPointerGrab}, ` +
    `dragging=${nanX.isDragging},${infiniteY.isDragging},${nanPointer.isDragging}`);

  const inside = grab(marker, { pointerId: 7, pointerCssX: 404, clientX: 120, clientY: 60, channel: 3 });
  check('a grab inside the band freezes the pointer, press coordinates, and channel',
    inside && marker.isDragging && marker.pointerId === 7 && marker.channel === 3 &&
    !marker.started && marker.sample === 0,
    `inside=${inside}, dragging=${marker.isDragging}, pointerId=${String(marker.pointerId)}, ` +
    `channel=${String(marker.channel)}, started=${marker.started}, ` +
    `sample=${String(marker.sample)}`);

  const second = grab(marker, { pointerId: 8 });
  check('a second grab attempt never replaces the live session',
    !second && marker.pointerId === 7, `grabbed=${second}, pointerId=${String(marker.pointerId)}`);

  const control = new WaveformMarker('A', '#CD427E');
  control.setSample(0, 10);
  const controlGrab = grab(control);
  check('control: the same grab on a fresh marker still starts',
    controlGrab, `grabbed=${controlGrab}`);

  const past = new WaveformMarker('A', '#CD427E');
  past.setSample(0, 10);
  const pastBand = grab(past, { pointerCssX: 404.0001 });
  check('a grab past the inclusive band is refused',
    !pastBand, `grabbed=${pastBand}`);
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(500, 1000);
  const beforeGrab = moveTo(marker, 700, 100, 50);
  check('a move before any grab is not consumed and never moves the sample',
    !beforeGrab && marker.sample === 500 && !marker.started,
    `consumed=${beforeGrab}, sample=${String(marker.sample)}, started=${marker.started}`);

  grab(marker, { clientX: 100, clientY: 50 });

  const same = moveTo(marker, 700, 100, 50);
  const sameAgain = moveTo(marker, 700, 100, 50);
  check('repeated same-coordinate moves are consumed without changing the sample or the latch',
    same && sameAgain && marker.sample === 500 && !marker.started,
    `consumed=${same},${sameAgain}, sample=${String(marker.sample)}, started=${marker.started}`);

  const verticalOnly = moveTo(marker, 700, 100, 51);
  check('the first differing clientY starts tracking',
    verticalOnly && marker.started && marker.sample === 700,
    `consumed=${verticalOnly}, started=${marker.started}, sample=${String(marker.sample)}`);

  const sameAfterLatch = moveTo(marker, 700, 100, 51);
  check('a same-coordinate move after tracking keeps the latch and the sample',
    sameAfterLatch && marker.started && marker.sample === 700,
    `consumed=${sameAfterLatch}, started=${marker.started}, sample=${String(marker.sample)}`);

  const horizontal = moveTo(marker, 620, 120, 51);
  check('a later differing clientX follows the absolute pointer sample',
    horizontal && marker.started && marker.sample === 620,
    `consumed=${horizontal}, started=${marker.started}, sample=${String(marker.sample)}`);
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(500, 1000);
  grab(marker, { pointerId: 5, clientX: 100, clientY: 50 });

  const beforeLatch = moveTo(marker, 700, 100, 50, 5);
  const beforeLatchSample = marker.sample;
  const beforeLatchStarted = marker.started;
  const latched = moveTo(marker, 620, 120, 50, 5);
  const back = moveTo(marker, 500, 100, 50, 5);
  check('returning exactly to the press coordinates after the latch updates the sample',
    beforeLatch && beforeLatchSample === 500 && !beforeLatchStarted &&
    latched && back && marker.started && marker.sample === 500,
    `beforeLatch=${beforeLatch}, beforeSample=${String(beforeLatchSample)}, ` +
    `beforeStarted=${beforeLatchStarted}, latched=${latched}, back=${back}, ` +
    `started=${marker.started}, sample=${String(marker.sample)}`);

  const forward = moveTo(marker, 700, 130, 50, 5);
  check('control: the same session still follows a differing move after the return',
    forward && marker.sample === 700,
    `consumed=${forward}, sample=${String(marker.sample)}`);
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(500, 1000);
  grab(marker);

  const first = moveTo(marker, 620, 120, 50);
  check('the first differing move follows the absolute pointer sample',
    first && marker.started && marker.sample === 620,
    `consumed=${first}, started=${marker.started}, sample=${String(marker.sample)}`);

  const control = new WaveformMarker('A', '#CD427E');
  control.setSample(500, 1000);
  grab(control);
  moveTo(control, 555, 120, 50);
  check('control: a differing move does change the sample and set the latch',
    control.sample === 555 && control.started,
    `control=${String(control.sample)}, started=${control.started}`);

  moveTo(marker, -50, 130, 50);
  const low = marker.sample;
  moveTo(marker, 1e9, 140, 50);
  const high = marker.sample;
  check('dragging clamps to both capture endpoints',
    low === 0 && high === 999, `low=${String(low)}, high=${String(high)}`);

  moveTo(marker, 400, 150, 50);
  const before = marker.sample;
  const nanMove = moveTo(marker, Number.NaN, 160, 50);
  const nanSample = marker.sample;
  const infiniteMove = moveTo(marker, Number.POSITIVE_INFINITY, 170, 50);
  const emptyMove = moveTo(marker, 300, 180, 50, 1, 0);
  check('non-finite or empty-capture moves are consumed and keep the last valid sample',
    nanMove && infiniteMove && emptyMove && before === 400 && nanSample === 400 &&
    marker.sample === 400,
    `consumed=${nanMove},${infiniteMove},${emptyMove}, before=${String(before)}, ` +
    `afterNaN=${String(nanSample)}, final=${String(marker.sample)}`);

  const foreign = moveTo(marker, 900, 190, 50, 42);
  check('a foreign pointer id never mutates the marker',
    !foreign && marker.sample === 400 && marker.pointerId === 1,
    `consumed=${foreign}, sample=${String(marker.sample)}, ` +
    `pointerId=${String(marker.pointerId)}`);
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(500, 1000);
  grab(marker, { pointerId: 4 });
  moveTo(marker, 640, 120, 50, 4);

  const foreignEnd = marker.endDrag(9);
  check('control: ending a foreign pointer id leaves the session live',
    !foreignEnd && marker.isDragging, `ended=${foreignEnd}, dragging=${marker.isDragging}`);

  const ended = marker.endDrag(4);
  check('ending the matching pointer clears the session and keeps the last sample',
    ended && !marker.isDragging && marker.pointerId === null && marker.channel === null &&
    marker.sample === 640,
    `ended=${ended}, dragging=${marker.isDragging}, pointerId=${String(marker.pointerId)}, ` +
    `channel=${String(marker.channel)}, sample=${String(marker.sample)}`);

  const afterEnd = moveTo(marker, 700, 130, 50, 4);
  check('a move after the session ended is not consumed',
    !afterEnd, `consumed=${afterEnd}`);

  marker.cancelDrag();
  marker.cancelDrag();
  check('cancelDrag is idempotent and leaves no session',
    !marker.isDragging && marker.pointerId === null && marker.sample === 640,
    `dragging=${marker.isDragging}, pointerId=${String(marker.pointerId)}, ` +
    `sample=${String(marker.sample)}`);
}

{
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(500, 1000);
  grab(marker);
  moveTo(marker, 640, 120, 50);
  marker.setSample(250, 1000);
  check('an external setSample write cancels the drag instead of leaving it live',
    !marker.isDragging && marker.pointerId === null && marker.sample === 250,
    `dragging=${marker.isDragging}, pointerId=${String(marker.pointerId)}, ` +
    `sample=${String(marker.sample)}`);
  const afterSet = moveTo(marker, 700, 130, 50);
  check('a move through the cancelled pointer id is not consumed',
    !afterSet, `consumed=${afterSet}`);

  marker.setSample(500, 1000);
  grab(marker);
  marker.setSample(null, 1000);
  check('a null external write during a drag clears both the sample and the session',
    !marker.isDragging && marker.sample === null,
    `dragging=${marker.isDragging}, sample=${String(marker.sample)}`);

  marker.setSample(500, 1000);
  grab(marker);
  marker.clear();
  check('clear cancels the drag and empties the marker',
    !marker.isDragging && marker.sample === null,
    `dragging=${marker.isDragging}, sample=${String(marker.sample)}`);
  const afterClear = moveTo(marker, 700, 140, 50);
  check('a move after clear is not consumed',
    !afterClear, `consumed=${afterClear}`);
}

{
  const markerSource = fs.readFileSync('src/ui/waveformMarker.ts', 'utf8');
  const geometrySource = fs.readFileSync('src/ui/markerGeometry.ts', 'utf8');
  const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');

  const markerImports = markerSource.match(/^import .*$/gm) ?? [];
  check('the marker class depends only on the pure geometry helpers',
    markerImports.length === 1 &&
    markerImports[0] === "import { clampMarkerSample, isMarkerGrab } from './markerGeometry.js';",
    `imports=${JSON.stringify(markerImports)}`);

  const forbidden = [
    'document', 'window', 'addEventListener', 'requestAnimationFrame', 'setInterval',
    'SampleStore', 'ViewTransform', 'Overlay', 'store', 'Map', 'Set', 'push(',
  ];
  const hits = forbidden.filter((token) => markerSource.includes(token));
  check('the marker class has no DOM, store, transform, listener, or rAF dependency',
    hits.length === 0, `hits=${JSON.stringify(hits)}`);

  const geometryImports = geometrySource.match(/^import .*$/gm) ?? [];
  const geometryForbidden = ['document', 'window', 'addEventListener', 'SampleStore', 'store'];
  const geometryHits = geometryForbidden.filter((token) => geometrySource.includes(token));
  check('the geometry helpers import nothing and touch no browser or store state',
    geometryImports.length === 0 && geometryHits.length === 0,
    `imports=${JSON.stringify(geometryImports)}, hits=${JSON.stringify(geometryHits)}`);

  const grabSource = between(geometrySource, 'export function isMarkerGrab(', 'export function clampMarkerSample(');
  const classGrab = between(markerSource, 'tryGrab(request: MarkerGrabRequest): boolean {', 'move(request: MarkerMoveRequest): boolean {');
  check('grabbing is horizontal-only: the band reads x and the class passes the CSS x pair',
    grabSource.length > 0 && !grabSource.includes('clientY') && !grabSource.includes('cssY') &&
    classGrab.includes('isMarkerGrab(request.pointerCssX, request.markerCssX)'),
    `len=${grabSource.length}, clientY=${grabSource.includes('clientY')}, ` +
    `bands=${classGrab.includes('isMarkerGrab(request.pointerCssX, request.markerCssX)')}`);

  const constructions = appSource.match(/new WaveformMarker\(/g) ?? [];
  check('the application constructs exactly one marker with the A identity',
    constructions.length === 1 && appSource.includes("new WaveformMarker('A', MEASURE_COLORS[0]!)"),
    `constructions=${constructions.length}`);

  const draws = appSource.match(/\.draw\(this\.overlay, /g) ?? [];
  check('the application paints the marker through the class exactly once',
    draws.length === 1, `draws=${draws.length}`);

  check('the marker is the only owner of the A sample',
    !appSource.includes('cursorA'), `cursorA=${appSource.includes('cursorA')}`);

  check('no marker collection or manager API exists in the class or the app',
    !/markers\s*[:=]|WaveformMarkers|MarkerManager/.test(markerSource + appSource),
    `markerSource=${/markers\s*[:=]|WaveformMarkers|MarkerManager/.test(markerSource)}, ` +
    `appSource=${/markers\s*[:=]|WaveformMarkers|MarkerManager/.test(appSource)}`);

  const bTraces = ['cursorB', 'setCursors', "'B'", '|B-A|', '1/|B-A|']
    .filter((token) => appSource.includes(token));
  check('marker B leaves no state, draw, status segment, or debug parameter behind',
    bTraces.length === 0, `traces=${JSON.stringify(bTraces)}`);

  const aStatus = appSource.match(/parts\.push\(`A /g) ?? [];
  check('the A status segment has exactly one producing path',
    aStatus.length === 1, `segments=${aStatus.length}`);

  const downSource = between(appSource, "plot.addEventListener('pointerdown'", "plot.addEventListener('pointermove'");
  const pinchBranch = between(downSource, 'if (pointers.size === 2) {', '} else if (pointers.size === 1) {');
  check('a second pointer cancels only the marker session and keeps both pointers mapped and captured',
    pinchBranch.includes('this.markerA.cancelDrag();') &&
    !pinchBranch.includes('pointers.delete') &&
    !pinchBranch.includes('releasePointerCapture') &&
    !pinchBranch.includes('endDrag') &&
    downSource.indexOf('plot.setPointerCapture(e.pointerId);') < downSource.indexOf('if (pointers.size === 2)'),
    `len=${pinchBranch.length}, cancel=${pinchBranch.includes('this.markerA.cancelDrag();')}, ` +
    `delete=${pinchBranch.includes('pointers.delete')}, ` +
    `release=${pinchBranch.includes('releasePointerCapture')}, ` +
    `endDrag=${pinchBranch.includes('endDrag')}`);

  const grabCall = downSource.indexOf('const grabbed = this.tryGrabMarker(');
  check('the first pointer arbitrates the marker grab before ordinary pan',
    grabCall >= 0 && grabCall > downSource.indexOf('if (pointers.size === 2)') &&
    downSource.indexOf('dragging = !grabbed;') > grabCall,
    `grabAt=${grabCall}, panAt=${downSource.indexOf('dragging = !grabbed;')}`);

  const moveSource = between(appSource, "plot.addEventListener('pointermove'", 'const end = (e: PointerEvent) => {');
  const markerMove = moveSource.indexOf('this.markerA.move({');
  const pinchAt = moveSource.indexOf('if (pinch && pointers.size >= 2)');
  const panAt = moveSource.indexOf('if (dragging) {');
  const hoverAt = moveSource.indexOf('this.updateHover(');
  const markerBranch = between(moveSource, 'if (this.markerA.isDragging) {', 'if (pinch');
  check('marker moves are handled before pinch, pan, and hover',
    markerMove >= 0 && markerMove < pinchAt && pinchAt >= 0 && pinchAt < panAt &&
    panAt >= 0 && panAt < hoverAt,
    `move=${markerMove}, pinch=${pinchAt}, pan=${panAt}, hover=${hoverAt}`);
  check('the marker move branch never pans, zooms, or changes follow state',
    markerBranch.length > 0 && !markerBranch.includes('panPixels') &&
    !markerBranch.includes('zoomAt') && !markerBranch.includes('setFollow'),
    `len=${markerBranch.length}, pan=${markerBranch.includes('panPixels')}, ` +
    `zoom=${markerBranch.includes('zoomAt')}, follow=${markerBranch.includes('setFollow')}`);

  const endSource = between(appSource, 'const end = (e: PointerEvent) => {', "plot.addEventListener('pointerup', end);");
  const endRelease = 'const markerEnded = this.markerA.endDrag(e.pointerId);';
  const endDragAt = endSource.indexOf(endRelease);
  const deleteAt = endSource.indexOf('pointers.delete(e.pointerId);');
  const captureReleaseAt = endSource.indexOf(
    'if (plot.hasPointerCapture(e.pointerId)) plot.releasePointerCapture(e.pointerId);');
  const endPinchAt = endSource.indexOf('if (pinch && pointers.size >= 2)');
  const clickAt = endSource.indexOf('this.markerA.setSample(s, this.store.length);');
  check('a matching pointer release ends the session before capture release and click placement',
    deleteAt >= 0 && deleteAt < endDragAt && endDragAt < captureReleaseAt &&
    captureReleaseAt < endPinchAt && endPinchAt < clickAt &&
    endSource.includes('if (markerEnded) { this.dirty = true; return; }') &&
    !endSource.includes('shiftKey'),
    `delete=${deleteAt}, endDrag=${endDragAt}, release=${captureReleaseAt}, ` +
    `pinch=${endPinchAt}, click=${clickAt}, shift=${endSource.includes('shiftKey')}`);

  const lost = appSource.match(/addEventListener\('lostpointercapture'/g) ?? [];
  const lostSource = between(appSource, "plot.addEventListener('lostpointercapture'", "plot.addEventListener('pointerleave'");
  check('exactly one lost-capture path exists and it ignores non-marker pointers',
    lost.length === 1 && lostSource.includes('if (this.markerA.pointerId !== e.pointerId) return;') &&
    lostSource.includes('pointers.delete(e.pointerId);') &&
    lostSource.includes('this.markerA.cancelDrag();'),
    `listeners=${lost.length}, guard=${lostSource.includes('if (this.markerA.pointerId !== e.pointerId) return;')}, ` +
    `delete=${lostSource.includes('pointers.delete(e.pointerId);')}`);

  const releaseSource = between(appSource, 'this.releaseMarkerPointer = () => {', "plot.addEventListener('pointerdown'");
  check('terminal cleanup is a no-op without a session and touches only the marker pointer',
    releaseSource.includes('const id = this.markerA.pointerId;') &&
    releaseSource.includes('if (id === null) return;') &&
    releaseSource.includes('this.markerA.cancelDrag();') &&
    releaseSource.includes('pointers.delete(id);') &&
    releaseSource.includes('if (plot.hasPointerCapture(id)) plot.releasePointerCapture(id);') &&
    !releaseSource.includes('pointers.clear()'),
    `len=${releaseSource.length}, guard=${releaseSource.includes('if (id === null) return;')}, ` +
    `clear=${releaseSource.includes('pointers.clear()')}`);

  const setIndices = [...appSource.matchAll(/this\.storeRef\.set\(/g)].map((m) => m.index!);
  const guarded = setIndices.map((index) =>
    appSource.slice(Math.max(0, index - 120), index).includes('this.releaseMarkerPointer();'));
  check('every store replacement releases the marker pointer immediately before installation',
    setIndices.length === 3 && guarded.every((g) => g),
    `swaps=${setIndices.length}, guarded=${JSON.stringify(guarded)}`);

  const adoptSource = between(appSource, 'private adoptCapture(', 'private save()');
  const startSource = between(appSource, 'private async startCapture()', 'private async stopCapture(');
  const escapeAt = appSource.indexOf("if (e.key === 'Escape') {");
  const escapeSource = escapeAt >= 0 ? appSource.slice(escapeAt, escapeAt + 200) : '';
  check('file/demo adoption clears the marker while hardware start retains its sample',
    adoptSource.includes('this.markerA.clear();') &&
    startSource.length > 0 && !startSource.includes('this.markerA.clear();'),
    `adoptClear=${adoptSource.includes('this.markerA.clear();')}, ` +
    `startClear=${startSource.includes('this.markerA.clear();')}`);
  check('Escape cancels marker dragging before clearing the sample',
    escapeSource.length > 0 &&
    escapeSource.indexOf('this.releaseMarkerPointer();') >= 0 &&
    escapeSource.indexOf('this.releaseMarkerPointer();') < escapeSource.indexOf('this.markerA.clear();'),
    `len=${escapeSource.length}`);

  const debugStart = appSource.indexOf('readonly debug = {');
  const hoverAtDebug = appSource.indexOf('hoverAt: (cssX: number, cssY: number)', debugStart);
  const debugSource = debugStart >= 0 && hoverAtDebug > debugStart
    ? appSource.slice(debugStart, hoverAtDebug) : '';
  const setMarkerSource = between(debugSource, 'setMarker: (sample: number | null) => {', 'marker: () => ({');
  check('the programmatic setter cancels dragging before the clamped write',
    setMarkerSource.indexOf('this.releaseMarkerPointer();') >= 0 &&
    setMarkerSource.indexOf('this.releaseMarkerPointer();') <
      setMarkerSource.indexOf('this.markerA.setSample(sample, this.store.length);'),
    `len=${setMarkerSource.length}`);
  check('the debug surface exposes one single-marker setter and drag-state readout',
    debugSource.includes('setMarker: (sample: number | null) => {') &&
    debugSource.includes('marker: () => ({') &&
    debugSource.includes('sample: this.markerA.sample,') &&
    debugSource.includes('dragging: this.markerA.isDragging,') &&
    debugSource.includes('started: this.markerA.started,') &&
    debugSource.includes('pointerId: this.markerA.pointerId,') &&
    debugSource.includes('channel: this.markerA.channel,') &&
    !debugSource.includes('cursorB'),
    `len=${debugSource.length}, markerSetters=${(debugSource.match(/set[A-Z]\w*: \(/g) ?? []).join(',')}`);

  const rowAtSource = between(appSource, 'private rowAt(cssY: number)', 'private tryGrabMarker(');
  const grabMarkerSource = between(appSource, 'private tryGrabMarker(', 'private updateHover(');
  const hoverSource = between(appSource, 'private updateHover(', 'private setFollow(');
  check('the hover and marker press paths share one row hit-test',
    rowAtSource.includes('cssY >= box.top && cssY < box.top + box.height') &&
    grabMarkerSource.includes('const row = this.rowAt(e.clientY - rect.top);') &&
    hoverSource.includes('const box = this.rowAt(cssY);') &&
    hoverSource.includes("if (!box || box.spec.kind !== 'channel')"),
    `rowAt=${rowAtSource.length}, grab=${grabMarkerSource.length}, hover=${hoverSource.length}`);
  check('the marker press accepts channel and lane rows while hover stays channel-only',
    grabMarkerSource.length > 0 && !grabMarkerSource.includes("kind === 'channel'") &&
    grabMarkerSource.includes('channel: row?.spec.channel ?? null,') &&
    grabMarkerSource.includes('captureLength: this.store.length,') &&
    markerSource.includes('request.channel !== null && !Number.isInteger(request.channel)') &&
    markerSource.includes('channel: number | null;'),
    `grabLen=${grabMarkerSource.length}, filter=${grabMarkerSource.includes("kind === 'channel'")}, ` +
    `nullChannel=${grabMarkerSource.includes('channel: row?.spec.channel ?? null,')}, ` +
    `classGuard=${markerSource.includes('request.channel !== null && !Number.isInteger(request.channel)')}`);

  const overlaySource = fs.readFileSync('src/ui/overlay.ts', 'utf8');
  const metricsSource = fs.readFileSync('src/ui/metrics.ts', 'utf8');
  const hoverFreq = (hoverSource.match(/formatFreq\(/g) ?? []).length;
  const hoverFreqReadout = hoverSource.includes("t('hover.freq'");
  const sharedPalette = metricsSource.includes(
    "export const MEASURE_COLORS: readonly string[] = ['#CD427E', '#00994D', '#2683D9', '#DB4C39'];");
  const sharedCursor = overlaySource.includes(
    'drawCursor(x: number, color: string, label: string): void {');
  check('the shared palette, overlay cursor API, and hover frequency readout survive B removal',
    sharedPalette && sharedCursor && hoverFreq === 2 && hoverFreqReadout &&
    !hoverSource.includes('|B-A|') && !hoverSource.includes('cursorB'),
    `palette=${sharedPalette}, overlay=${sharedCursor}, hoverFreq=${hoverFreq}, ` +
    `freqReadout=${hoverFreqReadout}, len=${hoverSource.length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
