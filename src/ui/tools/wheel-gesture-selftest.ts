// Pins the one wheel decision shared by the plot, axis, overview strip and hint bar.
import { wheelAction, wheelDeltaPixels, type WheelAction } from '../wheelGesture.js';
import {
  parseWorkspaceSnapshot, serializeWorkspaceSnapshot, WORKSPACE_SCHEMA_VERSION,
} from '../workspacePreferences.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

type Mod = 'plain' | 'ctrl' | 'meta' | 'shift';
const mods = (mod: Mod) => ({
  ctrlKey: mod === 'ctrl', metaKey: mod === 'meta', shiftKey: mod === 'shift',
});

// [wheelZooms, rowsOverflow, hasCapture] -> plain, ctrl, meta, shift
const TABLE: Array<[boolean, boolean, boolean, [WheelAction, WheelAction, WheelAction, WheelAction]]> = [
  [false, true, true, ['native', 'zoom', 'zoom', 'pan']],
  [false, false, true, ['zoom', 'zoom', 'zoom', 'pan']],
  [true, true, true, ['zoom', 'scroll-rows', 'scroll-rows', 'pan']],
  [true, false, true, ['zoom', 'scroll-rows', 'scroll-rows', 'pan']],
  [false, true, false, ['native', 'block', 'block', 'block']],
  [false, false, false, ['native', 'block', 'block', 'block']],
  [true, true, false, ['native', 'scroll-rows', 'scroll-rows', 'block']],
  [true, false, false, ['native', 'scroll-rows', 'scroll-rows', 'block']],
];

{
  const bad: string[] = [];
  for (const [wheelZooms, rowsOverflow, hasCapture, want] of TABLE) {
    (['plain', 'ctrl', 'meta', 'shift'] as const).forEach((mod, i) => {
      const got = wheelAction(mods(mod), { wheelZooms, rowsOverflow, hasCapture });
      if (got !== want[i]) bad.push(`zooms=${wheelZooms} overflow=${rowsOverflow} cap=${hasCapture} ${mod}: ${got}`);
    });
  }
  check('wheelAction matches the full setting x overflow x capture x modifier table',
    bad.length === 0, bad.length === 0 ? `${TABLE.length * 4} cells` : bad.join('; '));
}

{
  // Ctrl+wheel must never reach the browser (it would zoom the whole page), in any state.
  const leaks = TABLE.filter(([wheelZooms, rowsOverflow, hasCapture]) =>
    wheelAction(mods('ctrl'), { wheelZooms, rowsOverflow, hasCapture }) === 'native');
  check('Ctrl+wheel is always swallowed, so the page never zooms over the waveform',
    leaks.length === 0, `leaks=${leaks.length}`);
}

{
  const both = wheelAction({ ctrlKey: true, shiftKey: true },
    { wheelZooms: false, rowsOverflow: true, hasCapture: true });
  check('Shift wins over Ctrl: Ctrl+Shift+wheel pans', both === 'pan', `got=${both}`);
}

{
  const px = wheelDeltaPixels(3, 0, 500);
  const lines = wheelDeltaPixels(3, 1, 500);
  const pages = wheelDeltaPixels(1, 2, 500);
  check('wheel deltas convert pixel, line and page modes to pixels',
    px === 3 && lines === 48 && pages === 500, `px=${px}, lines=${lines}, pages=${pages}`);
}

{
  const base = { version: WORKSPACE_SCHEMA_VERSION, detailedLabels: true };
  const on = parseWorkspaceSnapshot(serializeWorkspaceSnapshot({ ...base, wheelZooms: true }));
  const offRaw = serializeWorkspaceSnapshot({ ...base, wheelZooms: false });
  const off = parseWorkspaceSnapshot(offRaw);
  const legacy = parseWorkspaceSnapshot(JSON.stringify(base));
  const junk = parseWorkspaceSnapshot(JSON.stringify({ ...base, wheelZooms: 'yes' }));
  check('the "wheel zooms" preference round-trips and defaults off for old or invalid snapshots',
    on?.wheelZooms === true && off?.wheelZooms === undefined && !offRaw.includes('wheelZooms') &&
    legacy?.wheelZooms === undefined && junk?.wheelZooms === undefined,
    `on=${on?.wheelZooms}, off=${off?.wheelZooms}, legacy=${legacy?.wheelZooms}, junk=${junk?.wheelZooms}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
