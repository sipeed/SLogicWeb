// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.

import {
  MARKER_GRAB_RADIUS_CSS, MARKER_SNAP_RADIUS_CSS, clampMarkerSample, isMarkerGrab,
  markerEdgeWindow, markerPointerCursor, markerSnapRadii, nearestMarkerEdge,
} from '../markerGeometry.js';
import {
  WaveformMarker, type MarkerPaintTarget, type MarkerSnapContext,
} from '../waveformMarker.js';

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
}

function recordingTarget(calls: DrawCall[]): MarkerPaintTarget {
  return {
    drawCursor: (x: number, color: string) => { calls.push({ x, color }); },
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
  snap?: MarkerSnapContext | null,
): boolean {
  return marker.move({
    pointerId, clientX, clientY, sample, captureLength, snap: snap ?? null,
  });
}

interface EdgeReads {
  count: number;
  windows: Array<[number, number]>;
}

function snapContext(
  edges: readonly number[],
  exactRadiusSamples: number,
  queryRadiusSamples: number,
  reads: EdgeReads,
): MarkerSnapContext {
  return {
    exactRadiusSamples,
    queryRadiusSamples,
    readEdges: (lo, hi) => {
      reads.count++;
      reads.windows.push([lo, hi]);
      return edges.filter((edge) => edge >= lo && edge < hi);
    },
  };
}

function freshReads(): EdgeReads {
  return { count: 0, windows: [] };
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
  marker.setLabel('3');
  marker.setColor('#00994D');
  check('the label and colour are mutable without touching the sample or the drag session',
    marker.label === '3' && marker.color === '#00994D' && marker.sample === null &&
    !marker.isDragging,
    `label=${marker.label}, color=${marker.color}, sample=${String(marker.sample)}, ` +
    `dragging=${marker.isDragging}`);

  marker.setSample(42, 1000);
  grab(marker);
  marker.setLabel('4');
  marker.setColor('#2683D9');
  check('control: relabelling a dragged cursor keeps its sample and its live session',
    marker.label === '4' && marker.color === '#2683D9' && marker.sample === 42 &&
    marker.isDragging,
    `label=${marker.label}, color=${marker.color}, sample=${String(marker.sample)}, ` +
    `dragging=${marker.isDragging}`);
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
  check('an absent sample paints no line',
    calls.length === 0, `draws=${calls.length}`);

  marker.setSample(10, 1000);
  marker.draw(target, toPx);
  const exact = calls.length === 1 && calls[0]!.x === 5.25 && calls[0]!.color === '#CD427E';
  check('one present sample produces exactly one draw at the supplied pixel',
    exact, `draws=${calls.length}, calls=${JSON.stringify(calls)}`);

  marker.clear();
  const clearedDraws = calls.length;
  marker.draw(target, toPx);
  check('clearing the marker removes its line',
    calls.length === clearedDraws, `draws=${calls.length}`);

  marker.setSample(10, 1000);
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
  const inBand = markerPointerCursor(10, 12, false);
  const atBoundary = markerPointerCursor(10, 14, false);
  const pastBoundary = markerPointerCursor(10, 14.0001, false);
  const mirrored = markerPointerCursor(14, 10, false);
  check('the pointer announces grab inside the inclusive 4 CSS px band and nothing outside it',
    inBand === 'grab' && atBoundary === 'grab' && pastBoundary === null && mirrored === 'grab',
    `in=${String(inBand)}, at4=${String(atBoundary)}, past4=${String(pastBoundary)}, ` +
    `mirrored=${String(mirrored)}`);

  const nullPointer = markerPointerCursor(null, 12, false);
  const nullMarker = markerPointerCursor(10, null, false);
  const nanPointer = markerPointerCursor(Number.NaN, 12, false);
  const nanMarker = markerPointerCursor(10, Number.NaN, false);
  const infinitePointer = markerPointerCursor(Number.NEGATIVE_INFINITY, 12, false);
  const infiniteMarker = markerPointerCursor(10, Number.POSITIVE_INFINITY, false);
  check('absent or non-finite pointer and marker positions never announce a cursor',
    nullPointer === null && nullMarker === null && nanPointer === null &&
    nanMarker === null && infinitePointer === null && infiniteMarker === null,
    `nullPointer=${String(nullPointer)}, nullMarker=${String(nullMarker)}, ` +
    `nan=${String(nanPointer)},${String(nanMarker)}, ` +
    `infinite=${String(infinitePointer)},${String(infiniteMarker)}`);

  const draggedOutOfBand = markerPointerCursor(100, 0, true);
  const draggedNullInputs = markerPointerCursor(null, null, true);
  const control = markerPointerCursor(10, 12, false);
  check('a live drag announces grabbing past the band and with absent inputs while the control stays grab',
    draggedOutOfBand === 'grabbing' && draggedNullInputs === 'grabbing' && control === 'grab',
    `dragged=${String(draggedOutOfBand)}, draggedNull=${String(draggedNullInputs)}, ` +
    `control=${String(control)}`);
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
  check('the snap radius is the literal 6 CSS px',
    MARKER_SNAP_RADIUS_CSS === 6, `radius=${MARKER_SNAP_RADIUS_CSS}`);

  const exact = nearestMarkerEdge([100], 106, 6);
  const past = nearestMarkerEdge([100], 106.0001, 6);
  check('edge eligibility is the inclusive 6 sample radius at the exact boundary',
    exact === 100 && past === null, `at6=${String(exact)}, past6=${String(past)}`);
  check('control: an edge inside the radius is still selected',
    nearestMarkerEdge([100], 103, 6) === 100,
    `inside=${String(nearestMarkerEdge([100], 103, 6))}`);

  const unit = markerSnapRadii(1, 1);
  const fractionalDpr = markerSnapRadii(1.25, 1);
  const retina = markerSnapRadii(2, 1);
  const zoomedIn = markerSnapRadii(1, 0.5);
  check('the exact radius converts 6 CSS px through DPR and samples per pixel',
    unit?.exactRadiusSamples === 6 && unit?.queryRadiusSamples === 6 &&
    fractionalDpr?.exactRadiusSamples === 7.5 && fractionalDpr?.queryRadiusSamples === 8 &&
    retina?.exactRadiusSamples === 12 && retina?.queryRadiusSamples === 12 &&
    zoomedIn?.exactRadiusSamples === 3 && zoomedIn?.queryRadiusSamples === 3,
    `unit=${JSON.stringify(unit)}, fractional=${JSON.stringify(fractionalDpr)}, ` +
    `retina=${JSON.stringify(retina)}, zoomedIn=${JSON.stringify(zoomedIn)}`);

  const ceiled = markerSnapRadii(1.25, 0.5);
  const narrow = ceiled?.exactRadiusSamples ?? 0;
  const wide = ceiled?.queryRadiusSamples ?? 0;
  const window = markerEdgeWindow(100, wide, 1000);
  const eligible = nearestMarkerEdge([103], 100, narrow);
  const excluded = nearestMarkerEdge([104], 100, narrow);
  check('the ceiled query radius never widens exact-radius eligibility',
    narrow === 3.75 && wide === 4 && window?.lo === 96 && window?.hi === 105 &&
    eligible === 103 && excluded === null,
    `exact=${narrow}, query=${wide}, window=${JSON.stringify(window)}, ` +
    `eligible=${String(eligible)}, excluded=${String(excluded)}`);

  check('invalid DPR or samples-per-pixel disables the snap radii',
    markerSnapRadii(0, 1) === null && markerSnapRadii(1, 0) === null &&
    markerSnapRadii(Number.NaN, 1) === null &&
    markerSnapRadii(1, Number.POSITIVE_INFINITY) === null,
    `dpr0=${String(markerSnapRadii(0, 1))}, spp0=${String(markerSnapRadii(1, 0))}, ` +
    `nanDpr=${String(markerSnapRadii(Number.NaN, 1))}, ` +
    `infiniteSpp=${String(markerSnapRadii(1, Number.POSITIVE_INFINITY))}`);
  check('control: the same radii helper still returns finite radii',
    markerSnapRadii(2, 2)?.queryRadiusSamples === 24,
    `actual=${JSON.stringify(markerSnapRadii(2, 2))}`);
}

{
  const inside = markerEdgeWindow(10, 3, 1000);
  const atStart = markerEdgeWindow(0, 6, 1000);
  const atEnd = markerEdgeWindow(999, 6, 1000);
  const fractional = markerEdgeWindow(5.5, 2, 1000);
  check('the query window is end-exclusive with the design floor arithmetic',
    inside?.lo === 7 && inside?.hi === 14 &&
    atStart?.lo === 0 && atStart?.hi === 7 &&
    atEnd?.lo === 993 && atEnd?.hi === 1000 &&
    fractional?.lo === 3 && fractional?.hi === 8,
    `inside=${JSON.stringify(inside)}, start=${JSON.stringify(atStart)}, ` +
    `end=${JSON.stringify(atEnd)}, fractional=${JSON.stringify(fractional)}`);

  check('the query window rejects invalid centers, radii, and capture lengths',
    markerEdgeWindow(Number.NaN, 3, 1000) === null &&
    markerEdgeWindow(10, Number.NaN, 1000) === null &&
    markerEdgeWindow(10, -1, 1000) === null &&
    markerEdgeWindow(10, 3, 0) === null &&
    markerEdgeWindow(10, 3, Number.NaN) === null,
    `nan=${String(markerEdgeWindow(Number.NaN, 3, 1000))}, ` +
    `nanRadius=${String(markerEdgeWindow(10, Number.NaN, 1000))}, ` +
    `negative=${String(markerEdgeWindow(10, -1, 1000))}, ` +
    `empty=${String(markerEdgeWindow(10, 3, 0))}`);
  check('centers outside the capture domain never produce a query window',
    markerEdgeWindow(-5, 10, 100) === null &&
    markerEdgeWindow(2000, 3000, 100) === null &&
    markerEdgeWindow(-0.5, 6, 100) === null &&
    markerEdgeWindow(99.5, 6, 100) === null,
    `below=${String(markerEdgeWindow(-5, 10, 100))}, ` +
    `above=${String(markerEdgeWindow(2000, 3000, 100))}, ` +
    `fractionalBelow=${String(markerEdgeWindow(-0.5, 6, 100))}, ` +
    `fractionalAbove=${String(markerEdgeWindow(99.5, 6, 100))}`);
  check('control: in-domain centers at both capture endpoints still produce a window',
    markerEdgeWindow(0, 6, 100)?.lo === 0 && markerEdgeWindow(0, 6, 100)?.hi === 7 &&
    markerEdgeWindow(99, 6, 100)?.lo === 93 && markerEdgeWindow(99, 6, 100)?.hi === 100,
    `start=${JSON.stringify(markerEdgeWindow(0, 6, 100))}, ` +
    `end=${JSON.stringify(markerEdgeWindow(99, 6, 100))}`);

  check('the nearest edge wins and an equal distance keeps the earlier sample',
    nearestMarkerEdge([100, 110], 105, 10) === 100 &&
    nearestMarkerEdge([100, 110], 108, 10) === 110 &&
    nearestMarkerEdge([110, 100], 105, 10) === 100,
    `tie=${String(nearestMarkerEdge([100, 110], 105, 10))}, ` +
    `nearer=${String(nearestMarkerEdge([100, 110], 108, 10))}, ` +
    `unsortedTie=${String(nearestMarkerEdge([110, 100], 105, 10))}`);
  check('empty or entirely out-of-radius edge lists select nothing',
    nearestMarkerEdge([], 100, 6) === null &&
    nearestMarkerEdge([50, 150], 100, 6) === null,
    `empty=${String(nearestMarkerEdge([], 100, 6))}, ` +
    `outside=${String(nearestMarkerEdge([50, 150], 100, 6))}`);
  check('invalid nearest-edge inputs select nothing',
    nearestMarkerEdge([100], Number.NaN, 6) === null &&
    nearestMarkerEdge([100], 100, Number.NaN) === null &&
    nearestMarkerEdge([100], 100, -1) === null,
    `nanCenter=${String(nearestMarkerEdge([100], Number.NaN, 6))}, ` +
    `nanRadius=${String(nearestMarkerEdge([100], 100, Number.NaN))}, ` +
    `negative=${String(nearestMarkerEdge([100], 100, -1))}`);
  check('control: a zero radius still selects an edge exactly under the center',
    nearestMarkerEdge([100], 100, 0) === 100,
    `actual=${String(nearestMarkerEdge([100], 100, 0))}`);
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
  const reads = freshReads();
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(400, 1000);
  grab(marker, { clientX: 100, clientY: 50, channel: 2 });
  const snap = snapContext([402, 990], 6, 6, reads);
  const consumed = moveTo(marker, 400, 120, 50, 1, 1000, snap);
  check('an eligible edge inside the radius becomes the exact dragged sample',
    consumed && marker.sample === 402 && reads.count === 1,
    `consumed=${consumed}, sample=${String(marker.sample)}, reads=${reads.count}`);
  check('the single edge query uses the ceiling-derived bounded window',
    reads.windows.length === 1 && reads.windows[0]![0] === 394 && reads.windows[0]![1] === 407,
    `windows=${JSON.stringify(reads.windows)}`);
}

{
  const reads = freshReads();
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(400, 1000);
  grab(marker);
  moveTo(marker, 400, 120, 50, 1, 1000, snapContext([397, 403], 6, 6, reads));
  check('a symmetric tie snaps to the earlier edge sample',
    marker.sample === 397, `sample=${String(marker.sample)}`);

  const elsewhere = new WaveformMarker('A', '#CD427E');
  elsewhere.setSample(400, 1000);
  grab(elsewhere);
  const controlReads = freshReads();
  moveTo(elsewhere, 400, 120, 50, 1, 1000, snapContext([396, 404], 6, 6, controlReads));
  check('control: the same tie logic is not hard-wired to one side',
    elsewhere.sample === 396, `sample=${String(elsewhere.sample)}`);
}

{
  const reads = freshReads();
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(400, 1000);
  grab(marker);
  moveTo(marker, 400, 120, 50, 1, 1000, snapContext([407], 6, 7, reads));
  check('an in-window edge outside the exact radius falls back to the pointer sample',
    marker.sample === 400 && reads.count === 1 && reads.windows[0]![1] === 408,
    `sample=${String(marker.sample)}, reads=${reads.count}, ` +
    `windows=${JSON.stringify(reads.windows)}`);

  const empty = new WaveformMarker('A', '#CD427E');
  empty.setSample(400, 1000);
  grab(empty);
  const emptyReads = freshReads();
  moveTo(empty, 420, 130, 50, 1, 1000, snapContext([], 6, 6, emptyReads));
  check('no edges in the window falls back to the exact rounded pointer sample',
    empty.sample === 420 && emptyReads.count === 1,
    `sample=${String(empty.sample)}, reads=${emptyReads.count}`);
}

{
  const reads = freshReads();
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(500, 1000);
  grab(marker);
  const snap = snapContext([], 6, 6, reads);
  moveTo(marker, 500, 110, 50, 1, 1000, snap);
  moveTo(marker, 520, 120, 50, 1, 1000, snap);
  moveTo(marker, 540, 130, 50, 1, 1000, snap);
  const bounded = reads.windows.every(([lo, hi]) => lo >= 0 && hi <= 1000 && hi - lo <= 13);
  check('each eligible move performs exactly one bounded edge query',
    reads.count === 3 && bounded,
    `reads=${reads.count}, windows=${JSON.stringify(reads.windows)}, bounded=${bounded}`);
}

{
  const reads = freshReads();
  const marker = new WaveformMarker('A', '#CD427E');
  marker.setSample(400, 1000);
  grab(marker, { clientX: 100, clientY: 50 });
  const snap = snapContext([402], 6, 6, reads);

  const same = moveTo(marker, 402, 100, 50, 1, 1000, snap);
  check('a same-coordinate pre-start move consumes without an edge query',
    same && reads.count === 0 && marker.sample === 400 && !marker.started,
    `consumed=${same}, reads=${reads.count}, sample=${String(marker.sample)}, ` +
    `started=${marker.started}`);

  const latched = moveTo(marker, 400, 120, 50, 1, 1000, snapContext([], 6, 6, reads));
  const afterLatch = reads.count;
  check('control: the first differing move is the one that queries',
    latched && marker.started && afterLatch === 1 && marker.sample === 400,
    `consumed=${latched}, started=${marker.started}, reads=${afterLatch}, ` +
    `sample=${String(marker.sample)}`);

  const nanMove = moveTo(marker, Number.NaN, 130, 50, 1, 1000, snap);
  const infiniteMove = moveTo(marker, Number.POSITIVE_INFINITY, 140, 50, 1, 1000, snap);
  const emptyMove = moveTo(marker, 300, 150, 50, 1, 0, snap);
  const nanLengthMove = moveTo(marker, 300, 155, 50, 1, Number.NaN, snap);
  check('non-finite or empty-capture moves never query and keep the last valid sample',
    nanMove && infiniteMove && emptyMove && nanLengthMove &&
    reads.count === afterLatch && marker.sample === 400,
    `consumed=${nanMove},${infiniteMove},${emptyMove},${nanLengthMove}, ` +
    `reads=${reads.count}, sample=${String(marker.sample)}`);

  moveTo(marker, -5, 160, 50, 1, 1000, snap);
  const below = marker.sample;
  moveTo(marker, 5000, 170, 50, 1, 1000, snap);
  const above = marker.sample;
  check('out-of-domain raw samples clamp without an edge query',
    below === 0 && above === 999 && reads.count === afterLatch,
    `below=${String(below)}, above=${String(above)}, reads=${reads.count}`);

  const badExact = moveTo(marker, 400, 180, 50, 1, 1000,
    snapContext([402], Number.NaN, 6, reads));
  const badExactReads = reads.count;
  const badQuery = moveTo(marker, 400, 190, 50, 1, 1000,
    snapContext([402], 6, Number.NaN, reads));
  check('invalid snap radii disable snapping without querying and keep the pointer sample',
    badExact && badQuery && badExactReads === afterLatch && reads.count === afterLatch &&
    marker.sample === 400,
    `consumed=${badExact},${badQuery}, reads=${reads.count}, sample=${String(marker.sample)}`);

  const noContext = moveTo(marker, 402, 200, 50, 1, 1000, null);
  check('a move without snap context follows the pointer and queries nothing',
    noContext && marker.sample === 402 && reads.count === afterLatch,
    `consumed=${noContext}, sample=${String(marker.sample)}, reads=${reads.count}`);

  const ended = marker.endDrag(1);
  const afterEnd = moveTo(marker, 800, 210, 50, 1, 1000, snapContext([402], 6, 6, reads));
  check('a move after the session ended performs no query and is not consumed',
    ended && !afterEnd && reads.count === afterLatch && marker.sample === 402,
    `ended=${ended}, consumed=${afterEnd}, reads=${reads.count}, ` +
    `sample=${String(marker.sample)}`);

  grab(marker, { clientX: 100, clientY: 50 });
  marker.cancelDrag();
  const afterCancel = moveTo(marker, 800, 220, 50, 1, 1000, snapContext([402], 6, 6, reads));
  check('a move after cancellation performs no query and is not consumed',
    !afterCancel && reads.count === afterLatch,
    `consumed=${afterCancel}, reads=${reads.count}`);
}

{
  const markerSource = fs.readFileSync('src/ui/waveformMarker.ts', 'utf8');
  const geometrySource = fs.readFileSync('src/ui/markerGeometry.ts', 'utf8');
  const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');

  const markerImports = markerSource.match(/^import .*$/gm) ?? [];
  const importSpecifiers = [...markerSource.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  const geometryImport = between(markerSource, 'import {', "} from './markerGeometry.js';");
  const geometryNames = (geometryImport.match(/[A-Za-z_$][\w$]*/g) ?? []).slice(1).sort();
  check('the marker class depends only on the pure geometry helpers',
    markerImports.length === 1 && markerImports[0] === 'import {' &&
    importSpecifiers.length === 1 && importSpecifiers[0] === './markerGeometry.js' &&
    geometryNames.join(',') ===
      ['clampMarkerSample', 'isMarkerGrab', 'markerEdgeWindow', 'nearestMarkerEdge'].join(','),
    `imports=${JSON.stringify(markerImports)}, specifiers=${JSON.stringify(importSpecifiers)}, ` +
    `names=${JSON.stringify(geometryNames)}`);

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
  check('the application constructs one marker per placement from the positional colour',
    constructions.length === 1 &&
    appSource.includes("new WaveformMarker('', cursorColor(this.cursors.length))") &&
    !appSource.includes("new WaveformMarker('A'"),
    `constructions=${constructions.length}`);

  const drawBlock = between(appSource, 'private draw(', 'private drawAxisCanvas(');
  const draws = appSource.match(/\.draw\(this\.overlay, /g) ?? [];
  check('the application paints every cursor through the class in one list-order loop',
    draws.length === 1 &&
    drawBlock.includes('for (const cursor of this.cursors) cursor.marker.draw(this.overlay,') &&
    !drawBlock.includes('markerA'),
    `draws=${draws.length}`);

  check('the retired single A marker field leaves no state, draw, or status path behind',
    !appSource.includes('markerA') && !appSource.includes('cursorA'),
    `markerA=${appSource.includes('markerA')}, cursorA=${appSource.includes('cursorA')}`);

  check('the marker class stays single-instance while the application owns the list',
    !/markers\s*[:=]|WaveformMarkers|MarkerManager/.test(markerSource) &&
    appSource.includes('interface CursorLine {') &&
    appSource.includes('private cursors: CursorLine[] = [];'),
    `classCollection=${/markers\s*[:=]|WaveformMarkers|MarkerManager/.test(markerSource)}`);

  check('the application keeps a plain cursor list with no manager or marker registry',
    !appSource.includes('MarkerManager') && !appSource.includes('WaveformMarkers') &&
    !appSource.includes('markers:') &&
    appSource.includes('private cursors: CursorLine[] = [];'),
    `manager=${appSource.includes('MarkerManager')}, ` +
    `registry=${appSource.includes('WaveformMarkers')}, ` +
    `markers=${appSource.includes('markers:')}`);

  const bTokens = ['setCursors', "'B'", '|B-A|', '1/|B-A|'];
  const bTraces = [
    ...bTokens.filter((token) => appSource.includes(token)),
    ...(/\bcursorB\b/.test(appSource) ? ['cursorB'] : []),
  ];
  check('marker B leaves no state, draw, readout, or debug parameter behind',
    bTraces.length === 0, `traces=${JSON.stringify(bTraces)}`);

  const barSource = between(appSource, 'private renderInteractionBar(', 'private fail(');
  const barDropsCursorReadout = barSource.length > 0 &&
    !barSource.includes('activeCursor(') && !barSource.includes('markerSample') &&
    !barSource.includes('formatDuration(');
  check('the bottom interaction bar renders gestures, not the active cursor position',
    barDropsCursorReadout && !appSource.includes('renderStatus'),
    `len=${barSource.length}, cursor=${barSource.includes('activeCursor(')}, ` +
    `renderStatus=${appSource.includes('renderStatus')}`);

  const downSource = between(appSource, "plot.addEventListener('pointerdown'", "plot.addEventListener('pointermove'");
  const pinchBranch = between(downSource, 'if (pointers.size === 2) {', '} else if (pointers.size === 1) {');
  check('a second pointer cancels only the cursor sessions and keeps both pointers mapped and captured',
    pinchBranch.includes('this.cancelMarkerDrags();') &&
    !pinchBranch.includes('pointers.delete') &&
    !pinchBranch.includes('releasePointerCapture') &&
    !pinchBranch.includes('endDrag') &&
    downSource.indexOf('plot.setPointerCapture(e.pointerId);') < downSource.indexOf('if (pointers.size === 2)'),
    `len=${pinchBranch.length}, cancel=${pinchBranch.includes('this.cancelMarkerDrags();')}, ` +
    `delete=${pinchBranch.includes('pointers.delete')}, ` +
    `release=${pinchBranch.includes('releasePointerCapture')}, ` +
    `endDrag=${pinchBranch.includes('endDrag')}`);

  const grabCall = downSource.indexOf('const grabbed = this.tryGrabMarker(');
  check('the first pointer arbitrates the cursor grab before ordinary pan',
    grabCall >= 0 && grabCall > downSource.indexOf('if (pointers.size === 2)') &&
    downSource.indexOf('dragging = !grabbed;') > grabCall,
    `grabAt=${grabCall}, panAt=${downSource.indexOf('dragging = !grabbed;')}`);

  const moveSource = between(appSource, "plot.addEventListener('pointermove'", 'const end = (e: PointerEvent) => {');
  const markerMove = moveSource.indexOf('cursor.marker.move({');
  const pinchAt = moveSource.indexOf('if (pinch && pointers.size >= 2)');
  const panAt = moveSource.indexOf('if (dragging) {');
  const hoverAt = moveSource.indexOf('this.updateHover(');
  const markerBranch = between(moveSource, 'const cursor = this.draggingCursor();', 'if (pinch');
  check('dragging cursor moves are handled before pinch, pan, and hover',
    markerMove >= 0 && markerMove < pinchAt && pinchAt >= 0 && pinchAt < panAt &&
    panAt >= 0 && panAt < hoverAt,
    `move=${markerMove}, pinch=${pinchAt}, pan=${panAt}, hover=${hoverAt}`);
  const moveCalls = markerBranch.match(/cursor\.marker\.move\(\{/g) ?? [];
  const snapCalls = markerBranch.match(/snap: this\.snapContext\(cursor\.marker\.channel, sample\),/g) ?? [];
  check('the dragging cursor move branch supplies exactly one snap context to the single move',
    moveCalls.length === 1 && snapCalls.length === 1 &&
    markerBranch.indexOf('const sample = this.toSample(') >= 0 &&
    markerBranch.indexOf('snap: this.snapContext(cursor.marker.channel, sample),') >
      markerBranch.indexOf('const sample = this.toSample('),
    `moves=${moveCalls.length}, snaps=${snapCalls.length}, len=${markerBranch.length}`);
  check('the cursor move branch never pans, zooms, changes follow state, or queries edges itself',
    markerBranch.length > 0 && !markerBranch.includes('panPixels') &&
    !markerBranch.includes('zoomAt') && !markerBranch.includes('setFollow') &&
    !markerBranch.includes('store.edges('),
    `len=${markerBranch.length}, pan=${markerBranch.includes('panPixels')}, ` +
    `zoom=${markerBranch.includes('zoomAt')}, follow=${markerBranch.includes('setFollow')}, ` +
    `branchEdges=${markerBranch.includes('store.edges(')}`);

  const snapSource = between(appSource, 'private snapContext(', 'private placeCursorAt(');
  const snapQueries = snapSource.match(/store\.edges\(/g) ?? [];
  check('the snap context revalidates channel, domain, and radii then makes one bounded read',
    snapSource.includes('private snapContext(channel: number | null, center: number): MarkerSnapContext | null {') &&
    snapSource.includes('!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount') &&
    snapSource.includes('this.channels[channel]?.enabled !== true') &&
    snapSource.includes('center < 0 || center > store.length - 1') &&
    snapSource.includes('markerSnapRadii(') &&
    snapSource.includes('globalThis.devicePixelRatio || 1, this.stack.view.samplesPerPixel') &&
    snapQueries.length === 1 && snapSource.includes('readEdges: (lo, hi) => store.edges(channel, lo, hi),') &&
    !snapSource.includes('while') && !snapSource.includes('win *= ') &&
    !snapSource.includes('0, store.length)'),
    `len=${snapSource.length}, queries=${snapQueries.length}, ` +
    `loop=${snapSource.includes('while')}, widening=${snapSource.includes('win *= ')}`);

  const snappedAt = markerSource.indexOf('private snappedSample(');
  const snappedSource = snappedAt >= 0 ? markerSource.slice(snappedAt) : '';
  const edgeReads = snappedSource.match(/snap\.readEdges\(/g) ?? [];
  check('the class derives the window, queries once, and selects by exact radius',
    edgeReads.length === 1 &&
    snappedSource.includes('markerEdgeWindow(center, snap.queryRadiusSamples, captureLength)') &&
    snappedSource.includes('snap.readEdges(edgeWindow.lo, edgeWindow.hi)') &&
    snappedSource.includes('center, snap.exactRadiusSamples,') &&
    snappedSource.includes('!Number.isFinite(snap.exactRadiusSamples) || snap.exactRadiusSamples < 0') &&
    snappedSource.includes('!Number.isFinite(snap.queryRadiusSamples) || snap.queryRadiusSamples < 0') &&
    snappedSource.includes('captureLength < 1 || center < 0 || center > captureLength - 1') &&
    !snappedSource.includes('for (') && !snappedSource.includes('while'),
    `len=${snappedSource.length}, reads=${edgeReads.length}, ` +
    `loop=${snappedSource.includes('for (') || snappedSource.includes('while')}`);

  const endSource = between(appSource, 'const end = (e: PointerEvent) => {', "plot.addEventListener('pointerup', end);");
  const endDragAt = endSource.indexOf('if (cursor.marker.endDrag(e.pointerId)) markerEnded = true;');
  const deleteAt = endSource.indexOf('pointers.delete(e.pointerId);');
  const captureReleaseAt = endSource.indexOf(
    'if (plot.hasPointerCapture(e.pointerId)) plot.releasePointerCapture(e.pointerId);');
  const endPinchAt = endSource.indexOf('if (pinch && pointers.size >= 2)');
  check('a pointer release ends every matching session before capture release and pinch bookkeeping',
    deleteAt >= 0 && deleteAt < endDragAt && endDragAt < captureReleaseAt &&
    captureReleaseAt < endPinchAt &&
    endSource.includes('for (const cursor of this.cursors) {') &&
    endSource.includes('if (markerEnded) { this.renderPanels(); this.dirty = true; return; }') &&
    !endSource.includes('setSample(') && !endSource.includes('shiftKey'),
    `delete=${deleteAt}, endDrag=${endDragAt}, release=${captureReleaseAt}, ` +
    `pinch=${endPinchAt}, shift=${endSource.includes('shiftKey')}`);
  check('a single click never places, moves, or selects a cursor',
    endSource.length > 0 && !endSource.includes('toSample(') &&
    !endSource.includes('addCursor') && !/\bmoved\b/.test(appSource) &&
    !appSource.includes('downX'),
    `len=${endSource.length}, moved=${/\bmoved\b/.test(appSource)}, ` +
    `downX=${appSource.includes('downX')}`);

  const lost = appSource.match(/addEventListener\('lostpointercapture'/g) ?? [];
  const lostSource = between(appSource, "plot.addEventListener('lostpointercapture'", "plot.addEventListener('pointerleave'");
  // Two owners can hold a marker drag's capture: the plot, and the axis (a cursor dragged
  // by its numbered chip). Each cancels only the cursor that owns the lost pointer.
  const axisLostSource = between(appSource, "axis.addEventListener('lostpointercapture'", "axis.addEventListener('pointerleave'");
  check('one lost-capture path per drag owner (plot, axis chip), each cancels only the owning cursor',
    lost.length === 2 &&
    axisLostSource.includes('const cursor = this.cursors.find((c) => c.marker.pointerId === e.pointerId);') &&
    axisLostSource.includes('if (cursor === undefined) return;') &&
    axisLostSource.includes('cursor.marker.cancelDrag();') &&
    lostSource.includes('const cursor = this.cursors.find((c) => c.marker.pointerId === e.pointerId);') &&
    lostSource.includes('if (cursor === undefined) return;') &&
    lostSource.includes('pointers.delete(e.pointerId);') &&
    lostSource.includes('cursor.marker.cancelDrag();'),
    `listeners=${lost.length}, ` +
    `owner=${lostSource.includes('const cursor = this.cursors.find((c) => c.marker.pointerId === e.pointerId);')}, ` +
    `delete=${lostSource.includes('pointers.delete(e.pointerId);')}`);

  const releaseSource = between(appSource, 'this.releaseMarkerPointer = () => {', "plot.addEventListener('pointerdown'");
  check('terminal cleanup is a no-op without a live session and touches only the dragging cursor',
    releaseSource.includes('const cursor = this.draggingCursor();') &&
    releaseSource.includes('const id = cursor?.marker.pointerId ?? null;') &&
    releaseSource.includes('if (cursor === null || id === null) return;') &&
    releaseSource.includes('cursor.marker.cancelDrag();') &&
    releaseSource.includes('pointers.delete(id);') &&
    releaseSource.includes('if (plot.hasPointerCapture(id)) plot.releasePointerCapture(id);') &&
    !releaseSource.includes('pointers.clear()') &&
    !releaseSource.includes('cancelMarkerDrags'),
    `len=${releaseSource.length}, guard=${releaseSource.includes('if (cursor === null || id === null) return;')}, ` +
    `clear=${releaseSource.includes('pointers.clear()')}`);

  const allSets = [...appSource.matchAll(/this\.storeRef\.set\(/g)].map((m) => m.index!);
  // `setDisplayStore` swaps the Repeat display layer inside one capture shape; the
  // marker and its sample coordinates stay valid, so it deliberately does not release
  // the pointer. Every actual capture replacement does.
  const displaySwap = between(appSource, 'private setDisplayStore(', 'private applyTriggerViewAnchor');
  const setIndices = allSets.filter((index) =>
    !displaySwap.includes(appSource.slice(index, index + 40)));
  const guarded = setIndices.map((index) =>
    appSource.slice(Math.max(0, index - 120), index).includes('this.releaseMarkerPointer();'));
  const displaySwapIsUnguarded = displaySwap.includes('this.storeRef.set(store);') &&
    !displaySwap.includes('releaseMarkerPointer');
  check('every store replacement releases the marker pointer immediately before installation',
    setIndices.length === 3 && guarded.every((g) => g) && displaySwapIsUnguarded,
    `swaps=${setIndices.length}, guarded=${JSON.stringify(guarded)}, ` +
    `display=${displaySwapIsUnguarded}`);

  const adoptSource = between(appSource, 'private adoptCapture(', 'private saveItems()');
  const startSource = between(appSource, 'private async startCapture(', 'private async stopCapture(');
  const escapeSource = between(appSource, "case 'cursors.clear':", 'this.dirty = true;');
  check('capture adoption clears every cursor while hardware start retains their samples',
    adoptSource.includes('this.clearCursors();') &&
    startSource.length > 0 && !startSource.includes('this.clearCursors();') &&
    startSource.includes('this.releaseMarkerPointer();'),
    `adoptClear=${adoptSource.includes('this.clearCursors();')}, ` +
    `startClear=${startSource.includes('this.clearCursors();')}, ` +
    `startRelease=${startSource.includes('this.releaseMarkerPointer();')}`);
  check('Escape cancels cursor dragging before clearing the list and rebuilding the panel',
    escapeSource.length > 0 &&
    escapeSource.indexOf('this.releaseMarkerPointer();') >= 0 &&
    escapeSource.indexOf('this.releaseMarkerPointer();') < escapeSource.indexOf('this.clearCursors();') &&
    escapeSource.indexOf('this.clearCursors();') < escapeSource.indexOf('this.renderPanels();'),
    `len=${escapeSource.length}`);

  const debugStart = appSource.indexOf('readonly debug = {');
  const hoverAtDebug = appSource.indexOf('hoverAt: (cssX: number, cssY: number)', debugStart);
  const debugSource = debugStart >= 0 && hoverAtDebug > debugStart
    ? appSource.slice(debugStart, hoverAtDebug) : '';
  const setMarkerSource = between(debugSource, 'setMarker: (sample: number | null) => {', 'marker: () => {');
  check('the programmatic setter cancels dragging before replacing the whole list',
    setMarkerSource.indexOf('this.releaseMarkerPointer();') >= 0 &&
    setMarkerSource.indexOf('this.releaseMarkerPointer();') <
      setMarkerSource.indexOf('this.clearCursors();') &&
    setMarkerSource.includes('this.addCursor(sample);') &&
    !setMarkerSource.includes('markerA'),
    `len=${setMarkerSource.length}`);
  check('the debug surface exposes the active cursor, the list, and add/remove entry points',
    debugSource.includes('setMarker: (sample: number | null) => {') &&
    debugSource.includes('marker: () => {') &&
    debugSource.includes('id: cursor?.id ?? null,') &&
    debugSource.includes('label: cursor?.marker.label ?? null,') &&
    debugSource.includes('color: cursor?.marker.color ?? null,') &&
    debugSource.includes('sample: cursor?.marker.sample ?? null,') &&
    debugSource.includes('dragging: cursor?.marker.isDragging ?? false,') &&
    debugSource.includes('started: cursor?.marker.started ?? false,') &&
    debugSource.includes('pointerId: cursor?.marker.pointerId ?? null,') &&
    debugSource.includes('channel: cursor?.marker.channel ?? null,') &&
    debugSource.includes('cursors: () => this.cursors.map((cursor) => ({') &&
    debugSource.includes('active: cursor.id === this.activeCursorId,') &&
    debugSource.includes('addCursor: (sample: number) => this.addCursor(sample),') &&
    debugSource.includes('removeCursor: (id: number) => this.removeCursor(id),') &&
    !/\bcursorB\b/.test(debugSource),
    `len=${debugSource.length}, markerSetters=${(debugSource.match(/set[A-Z]\w*: \(/g) ?? []).join(',')}`);

  const debugEdges = between(
    appSource, 'edges: (channel: number, lo: number, hi: number) => {', 'hoverAt:');
  check('the debug edge reader guards the channel and integral bounds and rejects invalid input',
    debugSource.includes('edges: (channel: number, lo: number, hi: number) => {') &&
    debugEdges.includes('if (!Number.isInteger(channel) || channel < 0 || channel >= store.channelCount) return [];') &&
    debugEdges.includes('if (!Number.isInteger(lo) || !Number.isInteger(hi)) return [];') &&
    debugEdges.includes('const start = Math.max(0, lo);') &&
    debugEdges.includes('const end = Math.min(store.length, hi);') &&
    debugEdges.includes('if (start >= end) return [];') &&
    debugEdges.includes('return Array.from(store.edges(channel, start, end));') &&
    !debugEdges.includes('Math.floor(lo)') && !debugEdges.includes('Math.ceil(hi)') &&
    !/\bcursorB\b/.test(debugEdges),
    `len=${debugEdges.length}, window=${debugEdges.includes('store.edges(channel, start, end)')}, ` +
    `floorLo=${debugEdges.includes('Math.floor(lo)')}, ceilHi=${debugEdges.includes('Math.ceil(hi)')}`);

  const rowAtSource = between(appSource, 'private rowAt(cssY: number)', 'private tryGrabMarker(');
  const grabMarkerSource = between(appSource, 'private tryGrabMarker(', 'private measuredAxisChips(');
  const hoverSource = between(appSource, 'private updateHover(', 'private setFollow(');
  check('the hover and marker press paths share one row hit-test',
    rowAtSource.includes('cssY >= box.top && cssY < box.top + box.height') &&
    grabMarkerSource.includes('const row = this.rowAt(e.clientY - rect.top);') &&
    hoverSource.includes('const box = this.rowAt(cssY);') &&
    hoverSource.includes("if (!box || box.spec.kind === 'lane' || box.spec.kind === 'blank')"),
    `rowAt=${rowAtSource.length}, grab=${grabMarkerSource.length}, hover=${hoverSource.length}`);
  // A blank row (a channel outside the capture on screen) borrows channel 0 for the
  // renderer, so it must not hand that channel to the marker as a snap target.
  check('the marker press accepts channel and lane rows while hover skips lane rows',
    grabMarkerSource.length > 0 && !grabMarkerSource.includes("kind === 'channel'") &&
    grabMarkerSource.includes("channel: row && row.spec.kind !== 'blank' ? row.spec.channel : null,") &&
    grabMarkerSource.includes('captureLength: this.store.length,') &&
    markerSource.includes('request.channel !== null && !Number.isInteger(request.channel)') &&
    markerSource.includes('channel: number | null;'),
    `grabLen=${grabMarkerSource.length}, filter=${grabMarkerSource.includes("kind === 'channel'")}, ` +
    `nullChannel=${grabMarkerSource.includes("channel: row && row.spec.kind !== 'blank' ? row.spec.channel : null,")}, ` +
    `classGuard=${markerSource.includes('request.channel !== null && !Number.isInteger(request.channel)')}`);

  const overlaySource = fs.readFileSync('src/ui/overlay.ts', 'utf8');
  const metricsSource = fs.readFileSync('src/ui/metrics.ts', 'utf8');
  const hoverFreq = (hoverSource.match(/formatFreq\(/g) ?? []).length;
  const hoverFreqReadout = hoverSource.includes("t('hover.freq'");
  const sharedPalette = metricsSource.includes(
    "export const MEASURE_COLORS: readonly string[] = ['#CD427E', '#00994D', '#2683D9', '#DB4C39'];");
  const sharedCursor = overlaySource.includes(
    'drawCursor(x: number, color: string): void {');
  const drawCursorSource = between(
    overlaySource, 'drawCursor(x: number, color: string): void {', 'drawTrigger(');
  const chipPainter = overlaySource.includes(
    'export function paintMarkerChip(') &&
    overlaySource.includes('roundRect(c, chip.boxX - w / 2, top, w, height, radius);');
  check('the overlay cursor paints its line only and the axis chip painter owns the box',
    sharedCursor && chipPainter && drawCursorSource.length > 0 &&
    !drawCursorSource.includes('roundRect(') &&
    !drawCursorSource.includes('measureText(label)'),
    `overlay=${sharedCursor}, painter=${chipPainter}, len=${drawCursorSource.length}, ` +
    `roundRect=${drawCursorSource.includes('roundRect(')}, ` +
    `measure=${drawCursorSource.includes('measureText(label)')}`);
  const chipSource = between(
    overlaySource, 'export function paintMarkerChip(', '\nfunction roundRect(');
  const connectorStroke = /strokeStyle\s*=\s*chip\.color/.test(chipSource) &&
    chipSource.includes('if (chip.row === 0) {') &&
    /moveTo\(anchor,\s*top \+ height\)/.test(chipSource) &&
    /lineTo\(anchor,\s*heightCss\)/.test(chipSource) &&
    chipSource.includes('Math.abs(chip.boxX - chip.anchorX) > 0.5') &&
    chipSource.includes('const top = rowTop + chip.row * (height + rowGap);') &&
    !chipSource.includes('setLineDash');
  const connectorAt = chipSource.search(/\.stroke\(\)/);
  const chipFillAt = chipSource.indexOf('roundRect(');
  check('the axis chip paints a solid connector from its box to the axis bottom before the box',
    connectorStroke && connectorAt >= 0 && chipFillAt > connectorAt &&
    chipSource.includes('c.lineWidth = 1;'),
    `len=${chipSource.length}, connector=${connectorStroke}, stroke=${connectorAt}, ` +
    `fill=${chipFillAt}, dash=${chipSource.includes('setLineDash')}`);
  check('the shared palette, overlay cursor API, and hover frequency readout survive B removal',
    sharedPalette && sharedCursor && hoverFreq === 2 && hoverFreqReadout &&
    !hoverSource.includes('|B-A|') && !hoverSource.includes('cursorB'),
    `palette=${sharedPalette}, overlay=${sharedCursor}, hoverFreq=${hoverFreq}, ` +
    `freqReadout=${hoverFreqReadout}, len=${hoverSource.length}`);

  const axisCanvasSource = between(
    appSource, 'private drawAxisCanvas(', 'private drawLaneSurfaces(');
  const axisPaint = axisCanvasSource.indexOf(
    'drawAxis(ctx, ticks, wCss, hCss, this.palette);');
  const fontAt = axisCanvasSource.indexOf('ctx.font = AXIS.markerChip.font;');
  const layoutAt = axisCanvasSource.indexOf('const placed = this.cursorChipPlacements(');
  const chipPaint = axisCanvasSource.indexOf(
    'ctx, { ...chip, color: cursor.marker.color }, wCss, hCss, this.palette,');
  check('the axis canvas lays out cursor chips after the axis background fill',
    axisCanvasSource.length > 0 && axisPaint >= 0 && fontAt > axisPaint &&
    layoutAt > fontAt && chipPaint > layoutAt &&
    axisCanvasSource.includes(
      '(label) => ctx.measureText(label).width + 2 * AXIS.markerChip.padX, wCss,') &&
    axisCanvasSource.includes("if (cursor === null) continue;") &&
    !axisCanvasSource.includes('markerA'),
    `len=${axisCanvasSource.length}, axis=${axisPaint}, font=${fontAt}, ` +
    `layout=${layoutAt}, chip=${chipPaint}`);
  const placementSite = between(
    appSource, 'private cursorChipPlacements(', 'private drawLaneSurfaces(');
  const placementCalls = (appSource.match(/this\.cursorChipPlacements\(/g) ?? []).length;
  check('one placement site feeds the axis painter and the debug cursor-chip surface',
    placementSite.includes('layoutCursorChips(chips, measure, width)') &&
    placementSite.includes('chips.push({ id: cursor.id, label: cursor.marker.label, cssX: this.toPx(sample) });') &&
    (appSource.match(/layoutCursorChips\(/g) ?? []).length === 1 &&
    placementCalls === 2 &&
    appSource.includes('cursorChips: (): Array<PlacedCursorChip & { width: number }> => this.measuredAxisChips(),'),
    `len=${placementSite.length}, calls=${placementCalls}, ` +
    `layout=${(appSource.match(/layoutCursorChips\(/g) ?? []).length}`);
  // The debug surface and the axis chip hit-test share one measured placement.
  const debugChipsSite = between(
    appSource, 'private measuredAxisChips(): MeasuredCursorChip[] {', 'private axisChipAt(');
  const debugMeasure = debugChipsSite.indexOf('ctx.font = AXIS.markerChip.font;');
  const debugPad = debugChipsSite.indexOf('2 * AXIS.markerChip.padX');
  check('the debug cursor-chip surface measures from the axis ctx with the chip font and padding',
    debugChipsSite.length > 0 && debugMeasure >= 0 && debugPad > debugMeasure &&
    debugChipsSite.includes('cursorChipPlacements(measure, this.el.plot.clientWidth)') &&
    debugChipsSite.includes('width: measure(chip.label)'),
    `len=${debugChipsSite.length}, font=${debugMeasure}, pad=${debugPad}`);

  const dblSource = between(
    appSource, "plot.addEventListener('dblclick'", '// Dragging the axis');
  const dblListeners = appSource.match(/plot\.addEventListener\('dblclick'/g) ?? [];
  check('a double-click places one cursor from the pointer sample and bails on an empty store',
    dblListeners.length === 1 &&
    dblSource.includes('if (this.store.length === 0) return;') &&
    dblSource.includes('const raw = Math.round(this.toSample(e.clientX - rect.left));') &&
    dblSource.includes('this.placeCursorAt(raw, e.clientY - rect.top);') &&
    (dblSource.match(/this\.addCursor\(/g) ?? []).length === 0,
    `listeners=${dblListeners.length}, len=${dblSource.length}`);
  check('double-click no longer zooms to fit or invalidates the viewport continuation anchor',
    dblSource.length > 0 && !dblSource.includes('zoomToFit') &&
    !dblSource.includes('noteViewportIntent'),
    `len=${dblSource.length}, fit=${dblSource.includes('zoomToFit')}, ` +
    `intent=${dblSource.includes('noteViewportIntent')}`);

  const placementSource = between(appSource, 'private placeCursorAt(', 'private grabCandidates(');
  check('placement snaps through the shared window and edge helpers, never a second radius rule',
    placementSource.includes('this.addCursor(this.snapPlacement(raw, cssY) ?? raw);') &&
    placementSource.includes('const snap = this.snapContext(this.rowAt(cssY)?.spec.channel ?? null, raw);') &&
    placementSource.includes('markerEdgeWindow(raw, snap.queryRadiusSamples, this.store.length)') &&
    placementSource.includes('nearestMarkerEdge(') &&
    placementSource.includes('raw, snap.exactRadiusSamples,') &&
    !placementSource.includes('MARKER_SNAP_RADIUS_CSS') &&
    !placementSource.includes('store.edges('),
    `len=${placementSource.length}, row=${placementSource.includes('this.rowAt(cssY)')}, ` +
    `literals=${placementSource.includes('MARKER_SNAP_RADIUS_CSS')}`);
  const axisMoveSource = between(appSource, "axis.addEventListener('pointermove', (e) => {", "axis.addEventListener('pointerup'");
  check('placement and dragging (plot and axis chip) derive their snap context from the same helper',
    placementSource.includes('this.snapContext(') &&
    markerBranch.includes('snap: this.snapContext(cursor.marker.channel, sample),') &&
    axisMoveSource.includes('snap: this.snapContext(channel, sample),') &&
    (appSource.match(/this\.snapContext\(/g) ?? []).length === 3,
    `contexts=${(appSource.match(/this\.snapContext\(/g) ?? []).length}`);

  check('the press grabs the nearest cursor in band and calls tryGrab on that cursor only',
    grabMarkerSource.includes('const candidate = nearestCursorGrab(this.grabCandidates(), pointerCssX);') &&
    grabMarkerSource.includes('if (candidate === null) return false;') &&
    grabMarkerSource.includes('const cursor = this.cursorById(candidate.id);') &&
    grabMarkerSource.includes('markerCssX: candidate.cssX,') &&
    (grabMarkerSource.match(/\.tryGrab\(/g) ?? []).length === 1,
    `len=${grabMarkerSource.length}, grabs=${(grabMarkerSource.match(/\.tryGrab\(/g) ?? []).length}`);
  const consumedBlock = between(moveSource, 'if (consumed) {', 'if (pinch && pointers.size >= 2) {');
  check('a press alone never changes the active cursor while a started drag activates it',
    grabMarkerSource.length > 0 && !grabMarkerSource.includes('activeCursorId') &&
    consumedBlock.includes('if (cursor.marker.started) this.activeCursorId = cursor.id;'),
    `grabActive=${grabMarkerSource.includes('activeCursorId')}, ` +
    `started=${consumedBlock.includes('if (cursor.marker.started) this.activeCursorId = cursor.id;')}`);
  const candidateSource = between(appSource, 'private grabCandidates(', 'private cursorById(');
  check('grab candidates come from every cursor that has a sample',
    candidateSource.includes('for (const cursor of this.cursors) {') &&
    candidateSource.includes('if (sample === null) continue;') &&
    candidateSource.includes('candidates.push({ id: cursor.id, cssX: this.toPx(sample) });'),
    `len=${candidateSource.length}`);

  const addSource = between(appSource, 'private addCursor(', 'private removeCursor(');
  check('adding a cursor clamps first, ignores an impossible sample, and marks one frame',
    addSource.includes('marker.setSample(sample, this.store.length);') &&
    addSource.includes('if (marker.sample === null) return;') &&
    addSource.includes('const id = this.nextCursorId++;') &&
    addSource.includes('this.cursors.push({ id, marker });') &&
    addSource.includes('this.renumberCursors();') &&
    addSource.indexOf('this.renumberCursors();') < addSource.indexOf('this.activeCursorId = id;') &&
    addSource.includes('this.renderPanels();') && addSource.includes('this.dirty = true;'),
    `len=${addSource.length}`);
  const removeSource = between(appSource, 'private removeCursor(', 'private clearCursors(');
  check('removing a cursor renumbers, recolours, and repaints the survivors',
    removeSource.includes('const index = this.cursors.findIndex((cursor) => cursor.id === id);') &&
    removeSource.includes('this.cursors.splice(index, 1);') &&
    removeSource.includes('this.renumberCursors();') &&
    removeSource.includes('this.renderPanels();') && removeSource.includes('this.dirty = true;'),
    `len=${removeSource.length}`);
  const renumberSource = between(appSource, 'private renumberCursors(', 'private addCursor(');
  check('order labels and colours are recomputed from the list position on every mutation',
    renumberSource.includes('const labels = cursorLabels(this.cursors.length);') &&
    renumberSource.includes('marker.setLabel(labels[index]!);') &&
    renumberSource.includes('marker.setColor(cursorColor(index));'),
    `len=${renumberSource.length}`);
  const clearSource = between(appSource, 'private clearCursors(', 'private cancelMarkerDrags(');
  check('clearing the list drops every cursor and the active identity',
    clearSource.includes('this.cursors = [];') && clearSource.includes('this.activeCursorId = null;'),
    `len=${clearSource.length}`);
  check('the cursor list has no count cap',
    !/MAX_CURSORS|CURSOR_LIMIT|maxCursors|CURSOR_MAX/.test(appSource) &&
    (appSource.match(/this\.nextCursorId\+\+/g) ?? []).length === 1,
    `limit=${/MAX_CURSORS|CURSOR_LIMIT|maxCursors|CURSOR_MAX/.test(appSource)}`);

  const cancelSource = between(appSource, 'private cancelMarkerDrags(): void {', '}');
  check('the pinch cancellation cancels every live session and never mutates the list',
    cancelSource.includes('for (const cursor of this.cursors) cursor.marker.cancelDrag();') &&
    !cancelSource.includes('clearCursors') && !cancelSource.includes('this.cursors =') &&
    !cancelSource.includes('endDrag'),
    `len=${cancelSource.length}, clear=${cancelSource.includes('clearCursors')}, ` +
    `assign=${cancelSource.includes('this.cursors =')}, end=${cancelSource.includes('endDrag')}`);

  const retentionSource = between(appSource, 'private enforceLoopRetention(', 'private async stopCapture(');
  check('loop retention drops cursors whose sample fell off the front and rebuilds once',
    retentionSource.includes('const beforeDrop = this.cursors.length;') &&
    retentionSource.includes('this.cursors = this.cursors.filter((cursor) => cursor.marker.sample !== null);') &&
    retentionSource.includes('if (this.cursors.length !== beforeDrop) {') &&
    retentionSource.indexOf('this.cursors = this.cursors.filter(') <
      retentionSource.indexOf('this.renumberCursors();') &&
    retentionSource.indexOf('this.renumberCursors();') < retentionSource.indexOf('this.renderPanels();') &&
    retentionSource.includes('if (this.activeCursorId !== null && this.cursorById(this.activeCursorId) === null) {') &&
    retentionSource.includes('this.activeCursorId = last === undefined ? null : last.id;') &&
    (retentionSource.match(/this\.renderPanels\(\);/g) ?? []).length === 1,
    `len=${retentionSource.length}, filter=${retentionSource.includes('this.cursors = this.cursors.filter(')}, ` +
    `renumber=${retentionSource.includes('this.renumberCursors();')}, ` +
    `render=${retentionSource.includes('this.renderPanels();')}, ` +
    `active=${retentionSource.includes('this.cursorById(this.activeCursorId) === null')}, ` +
    `renders=${(retentionSource.match(/this\.renderPanels\(\);/g) ?? []).length}`);

  const workspaceSource = fs.readFileSync('src/ui/workspacePreferences.ts', 'utf8');
  const snapshotSource = between(appSource, 'private workspaceSnapshot()', 'private persistWorkspace()');
  check('cursor state is session-only and never enters the workspace snapshot',
    !/cursor/i.test(workspaceSource) && !/cursor/i.test(snapshotSource),
    `workspace=${/cursor/i.test(workspaceSource)}, snapshot=${/cursor/i.test(snapshotSource)}`);
  check('the application takes colours and labels from the shared cursor-set model',
    appSource.includes("from './cursorSet.js'") &&
    appSource.includes('cursorColor(this.cursors.length)') &&
    appSource.includes('cursorLabels(this.cursors.length)') &&
    !appSource.includes('MEASURE_COLORS'),
    `set=${appSource.includes("from './cursorSet.js'")}, ` +
    `palette=${appSource.includes('MEASURE_COLORS')}`);
}

{
  const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
  const cssSource = fs.readFileSync('src/ui/style.css', 'utf8');
  const cssCode = cssSource.replace(/\/\*[\s\S]*?\*\//g, '');

  const grabRule = /#plot\.marker-grab\s*\{\s*cursor:\s*grab;\s*\}/.test(cssCode);
  const grabbingRule = /#plot\.marker-grabbing\s*\{\s*cursor:\s*grabbing;\s*\}/.test(cssCode);
  const baseCursor = /#plot\s*\{[^}]*?cursor:\s*url\("data:image\/svg\+xml,/.test(cssCode);
  check('the plot advertises grab and grabbing through two native-keyword class rules over its image cursor',
    grabRule && grabbingRule && baseCursor,
    `grab=${grabRule}, grabbing=${grabbingRule}, baseCursor=${baseCursor}`);

  const toggleGrab = appSource.includes("classList.toggle('marker-grab', next === 'grab')");
  const toggleGrabbing =
    appSource.includes("classList.toggle('marker-grabbing', next === 'grabbing')");
  const syncBody = between(appSource, 'private syncMarkerCursor(', 'private wireToolbar(');
  check('the cursor setter toggles both state classes through the shared nearest-grab band',
    toggleGrab && toggleGrabbing &&
    syncBody.includes('markerPointerCursor(') &&
    syncBody.includes('nearestCursorGrab(this.grabCandidates(), pointerCssX)') &&
    syncBody.includes('nearest?.cssX ?? null, this.draggingCursor() !== null,') &&
    syncBody.includes('if (next === this.markerCursor) return;') &&
    !syncBody.includes('this.dirty') && !syncBody.includes('Math.abs('),
    `grab=${toggleGrab}, grabbing=${toggleGrabbing}, len=${syncBody.length}, ` +
    `dirty=${syncBody.includes('this.dirty')}, band=${syncBody.includes('Math.abs(')}`);

  const syncCalls = appSource.match(/this\.syncMarkerCursor\(/g) ?? [];
  check('every pointer entry, exit, release, and wheel site resyncs the cursor',
    syncCalls.length === 7, `calls=${syncCalls.length}`);

  const syncAt = appSource.indexOf('private syncMarkerCursor(');
  check('the cursor setter sits after setFollow so every hover slice keeps its bounds',
    syncAt > appSource.indexOf('private setFollow(') &&
    syncAt < appSource.indexOf('private wireToolbar('),
    `sync=${syncAt}, follow=${appSource.indexOf('private setFollow(')}`);

  const markerDebug = between(appSource, 'marker: () => {', 'cursors: () =>');
  check('the debug readout exposes the live cursor state',
    markerDebug.includes('cursor: this.markerCursor,'),
    `len=${markerDebug.length}, cursor=${markerDebug.includes('cursor: this.markerCursor,')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
