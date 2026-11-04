// SPDX-License-Identifier: GPL-3.0-or-later

import { carryCaptureDuration } from '../capturePolicy.js';
import { defaultCaptureSettings } from '../state.js';

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

const base = defaultCaptureSettings();

{
  const single = { ...base, mode: 'single' as const, seconds: 0.0015 };
  const loop = carryCaptureDuration(single, { ...single, mode: 'loop' });
  const entered = loop.loopSamples === 24_576 && loop.seconds === 24_576 / 16e6;
  const back = carryCaptureDuration(loop, { ...loop, mode: 'single' });
  const left = back.seconds === 24_576 / 16e6;
  check('entering Loop takes the duration Single was using, and leaving Loop gives it back',
    entered && left,
    `loopSamples=${loop.loopSamples}, loopSeconds=${loop.seconds}, singleSeconds=${back.seconds}`);
}

{
  // A caller that set a window explicitly (the assistant, or a restored draft) keeps it.
  const single = { ...base, mode: 'single' as const, seconds: 1 };
  const explicit = carryCaptureDuration(single, {
    ...single, mode: 'loop', loopSamples: 2_000_000,
  });
  // Loop windows are whole 1024-sample quanta: 2,000,000 rounds up to 2,000,896.
  check('an explicit loop window is not overwritten by the carried duration',
    explicit.loopSamples === 2_000_896 && explicit.seconds === 2_000_896 / 16e6,
    `samples=${explicit.loopSamples}, seconds=${explicit.seconds}`);
}

{
  // HSync: a rate change keeps the capture about as long, so the sample window moves.
  const loop = { ...base, mode: 'loop' as const, loopSamples: 160_000, seconds: 0.01 };
  const faster = carryCaptureDuration(loop, { ...loop, samplerate: 100e6 });
  const slower = carryCaptureDuration(faster, { ...faster, samplerate: 16e6 });
  // Each conversion rounds up to the next 1024-sample quantum, hence the small drift.
  const quantumSeconds = 1024 / 16e6;
  check('a rate change while looping rescales the window to hold its duration',
    faster.loopSamples === 1_000_448 && Math.abs(faster.seconds - 0.01) <= quantumSeconds &&
    slower.loopSamples === 160_768 && Math.abs(slower.seconds - 0.01) <= 2 * quantumSeconds,
    `fast=${faster.loopSamples}/${faster.seconds}, slow=${slower.loopSamples}/${slower.seconds}`);
}

{
  // Dragging the loop window edits the one duration both ways.
  const loop = { ...base, mode: 'loop' as const, loopSamples: 160_000, seconds: 0.01 };
  const bigger = carryCaptureDuration(loop, { ...loop, loopSamples: 320_000 });
  // 320,000 samples also round up to a 1024-sample quantum.
  check('a loop-window edit updates the duration the other modes will inherit',
    bigger.loopSamples === 320_512 && bigger.seconds === 320_512 / 16e6,
    `samples=${bigger.loopSamples}, seconds=${bigger.seconds}`);
}

{
  const single = { ...base, mode: 'single' as const, seconds: 0.25 };
  const same = carryCaptureDuration(single, { ...single, seconds: 0.5 });
  const repeat = carryCaptureDuration(
    { ...base, mode: 'repeat' as const, seconds: 0.25 },
    { ...base, mode: 'repeat' as const, seconds: 0.5 },
  );
  check('Single and Repeat keep their seconds untouched',
    same.seconds === 0.5 && repeat.seconds === 0.5,
    `single=${same.seconds}, repeat=${repeat.seconds}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const applyStart = app.indexOf('private applySettings(s: CaptureSettings): void {');
  const applyEnd = applyStart >= 0 ? app.indexOf('\n  }', applyStart) : -1;
  const apply = applyEnd > applyStart ? app.slice(applyStart, applyEnd) : '';
  const wired = apply.includes('carryCaptureDuration(this.settings, this.clampSettings(s))');
  const derived = app.includes('seconds: s.mode === \'loop\'\n      ? loopSamples / samplerate');
  const adopted = app.includes('carryCaptureDuration(this.settings, adopted)');
  check('App carries the duration through its single settings commit path and device adoption',
    wired && derived && adopted, `apply=${wired}, derive=${derived}, adopt=${adopted}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
