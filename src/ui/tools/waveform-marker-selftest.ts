// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

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

{
  const marker = new WaveformMarker('A', '#CD427E');
  check('a new marker owns its label, colour, and an absent sample',
    marker.label === 'A' && marker.color === '#CD427E' && marker.sample === null,
    `label=${marker.label}, color=${marker.color}, sample=${String(marker.sample)}`);

  const before = marker.sample;
  marker.sample = 42;
  const assigned = marker.sample === 42;
  check('the sample setter replaces the readout with the exact value',
    assigned, `expected=42, actual=${String(marker.sample)}`);
  check('control: the sample readout is not a stale snapshot',
    before !== marker.sample,
    `before=${String(before)}, after=${String(marker.sample)}`);

  marker.clear();
  check('clear returns the marker to an absent sample',
    marker.sample === null, `actual=${String(marker.sample)}`);

  marker.sample = 7.5;
  check('the class stores the supplied sample without rounding or clamping',
    marker.sample === 7.5, `actual=${String(marker.sample)}`);
}

{
  const calls: DrawCall[] = [];
  const target = recordingTarget(calls);
  const marker = new WaveformMarker('A', '#CD427E');
  const toPx = (sample: number) => sample / 2 + 0.25;

  marker.draw(target, toPx);
  check('an absent sample paints nothing',
    calls.length === 0, `draws=${calls.length}`);

  marker.sample = 10;
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
  const markerSource = fs.readFileSync('src/ui/waveformMarker.ts', 'utf8');
  const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');

  const forbidden = [
    'import ', 'document', 'window', 'addEventListener', 'requestAnimationFrame',
    'setInterval', 'SampleStore', 'ViewTransform', 'Overlay', 'store', 'Map', 'Set',
    'push(',
  ];
  const hits = forbidden.filter((token) => markerSource.includes(token));
  check('the marker class has no import, DOM, store, transform, listener, or rAF dependency',
    hits.length === 0, `hits=${JSON.stringify(hits)}`);

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
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
