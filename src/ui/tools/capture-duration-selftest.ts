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
  // The window rounds up to whole quanta (24,000 -> 24,576); the entered 1.5 ms does not.
  const entered = loop.loopSamples === 24_576 && loop.seconds === 0.0015;
  const back = carryCaptureDuration(loop, { ...loop, mode: 'single' });
  const left = back.seconds === 0.0015;
  check('entering Loop takes the duration Single was using, and leaving Loop gives it back',
    entered && left,
    `loopSamples=${loop.loopSamples}, loopSeconds=${loop.seconds}, singleSeconds=${back.seconds}`);
}

{
  // Reported on hardware: Single 1000 ms -> Loop -> Single came back as 1000.01 ms,
  // because 1 s at 100 MHz is not a whole number of 1024-sample quanta.
  const rows = [100e6, 50e6, 16e6, 12e6, 200e6].map((samplerate) => {
    const single = { ...base, mode: 'single' as const, samplerate, seconds: 1 };
    const loop = carryCaptureDuration(single, { ...single, mode: 'loop' });
    const back = carryCaptureDuration(loop, { ...loop, mode: 'single' });
    const again = carryCaptureDuration(
      carryCaptureDuration(back, { ...back, mode: 'loop' }), { ...back, mode: 'single' });
    return { samplerate, window: loop.loopSamples, loop: loop.seconds, back: back.seconds,
      again: again.seconds };
  });
  check('Single -> Loop -> Single never rewrites the entered duration, at any rate',
    rows.every((row) => row.loop === 1 && row.back === 1 && row.again === 1 &&
      row.window % 1024 === 0 && row.window >= row.samplerate),
    rows.map((row) => `${row.samplerate / 1e6}M window=${row.window} loop=${row.loop} ` +
      `back=${row.back} again=${row.again}`).join(', '));
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
  const loop = { ...base, mode: 'loop' as const, loopSamples: 2_000_896, seconds: 2_000_896 / 16e6 };
  const patched = 0.001;
  const samePatch = carryCaptureDuration(loop, { ...loop, mode: 'single' as const, seconds: patched });
  const overwritten = samePatch.seconds !== patched &&
    samePatch.seconds === loop.loopSamples / loop.samplerate;
  const followUp = carryCaptureDuration(samePatch, { ...samePatch, seconds: patched });
  check('a Loop-to-Single commit overwrites a same-patch seconds patch; a later Single commit keeps it',
    overwritten && followUp.seconds === patched && followUp.mode === 'single',
    `samePatch=${samePatch.seconds}, followUp=${followUp.seconds}`);
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
  const derived = app.includes(
    'seconds: s.mode === \'loop\'\n      ? loopDurationSeconds([s.seconds], loopSamples, samplerate, s.channels)');
  const adopted = app.includes('carryCaptureDuration(this.settings, adopted)');
  check('App carries the duration through its single settings commit path and device adoption',
    wired && derived && adopted, `apply=${wired}, derive=${derived}, adopt=${adopted}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const sources = new Map([
    ['src/device/tools/flickerHarness.ts',
      fs.readFileSync('src/device/tools/flickerHarness.ts', 'utf8')],
    ['src/device/tools/appLoopHarness.ts',
      fs.readFileSync('src/device/tools/appLoopHarness.ts', 'utf8')],
  ]);
  const settingsCommits = (file: string, marker: string): string[] => {
    const source = sources.get(file) ?? '';
    const start = source.indexOf(marker);
    const nextExport = start < 0 ? -1 : source.indexOf('\nexport ', start + marker.length);
    const body = start < 0 ? '' : source.slice(start, nextExport < 0 ? undefined : nextExport);
    const calls: string[] = [];
    let at = body.indexOf('setSettings(');
    while (at >= 0) {
      let depth = 0;
      let cursor = at + 'setSettings'.length;
      for (; cursor < body.length; cursor++) {
        const char = body[cursor];
        if (char === '(') depth += 1;
        else if (char === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      calls.push(body.slice(at, cursor + 1));
      at = body.indexOf('setSettings(', cursor);
    }
    return calls;
  };
  const paths = [
    { file: 'src/device/tools/flickerHarness.ts', marker: 'export async function runFlickerProbe(',
      name: 'flicker single probe', loopSetup: true },
    { file: 'src/device/tools/flickerHarness.ts', marker: 'export async function runIdleFlickerProbe(',
      name: 'flicker idle prime', loopSetup: false },
    { file: 'src/device/tools/appLoopHarness.ts', marker: 'export async function startFixedWindowProbe(',
      name: 'fixed-window probe', loopSetup: false },
  ].map((path) => {
    const calls = settingsCommits(path.file, path.marker);
    const modeCommit = calls.findIndex((call) => /\bmode\b/.test(call));
    const secondsCommit = calls.findIndex((call) => call.includes('maxCaptureSeconds('));
    const separate = modeCommit >= 0 && secondsCommit > modeCommit &&
      !/\bmode\b/.test(calls[secondsCommit] ?? '');
    const loopKept = !path.loopSetup || (calls[modeCommit] ?? '').includes('loopSamples');
    return { name: path.name, pass: separate && loopKept,
      detail: `modeCommit=${modeCommit}, secondsCommit=${secondsCommit}, ` +
        `separate=${separate}, loopSetupKept=${loopKept}, commits=${calls.length}` };
  });
  check('every finite single-capture harness commits its duration after the mode commit',
    paths.every((path) => path.pass),
    paths.map((path) => `${path.name}: ${path.detail}`).join('; '));
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
