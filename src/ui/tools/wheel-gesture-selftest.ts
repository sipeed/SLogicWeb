// Pins the one wheel decision shared by the plot, axis, overview strip and hint bar.
import { fitWheelAction, wheelAction, type WheelAction } from '../wheelGesture.js';
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

interface Mods {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

const MODIFIERS: ReadonlyArray<readonly [string, Mods]> = [
  ['plain', { ctrlKey: false, metaKey: false, shiftKey: false }],
  ['ctrl', { ctrlKey: true, metaKey: false, shiftKey: false }],
  ['meta', { ctrlKey: false, metaKey: true, shiftKey: false }],
  ['shift', { ctrlKey: false, metaKey: false, shiftKey: true }],
  ['ctrl+shift', { ctrlKey: true, metaKey: false, shiftKey: true }],
  ['meta+shift', { ctrlKey: false, metaKey: true, shiftKey: true }],
];

type Row = readonly [boolean, boolean, readonly WheelAction[]];

// [wheelZooms, hasCapture] -> one action per MODIFIERS row.
const TABLE: readonly Row[] = [
  [false, true, ['native', 'zoom', 'zoom', 'pan', 'pan', 'pan']],
  [true, true, ['zoom', 'zoom', 'zoom', 'pan', 'pan', 'pan']],
  [false, false, ['native', 'block', 'block', 'block', 'block', 'block']],
  [true, false, ['native', 'block', 'block', 'block', 'block', 'block']],
];

function cells(): { wheelZooms: boolean; hasCapture: boolean; mod: string; got: WheelAction }[] {
  return TABLE.flatMap(([wheelZooms, hasCapture]) =>
    MODIFIERS.map(([mod, mods]) => ({
      wheelZooms, hasCapture, mod, got: wheelAction(mods, { wheelZooms, hasCapture }),
    })));
}

{
  const bad: string[] = [];
  for (const [wheelZooms, hasCapture, want] of TABLE) {
    MODIFIERS.forEach(([mod, mods], i) => {
      const got = wheelAction(mods, { wheelZooms, hasCapture });
      if (got !== want[i]) bad.push(`zooms=${wheelZooms} cap=${hasCapture} ${mod}: ${got}`);
    });
  }
  const total = TABLE.length * MODIFIERS.length;
  check('wheelAction matches the full setting x capture x modifier table, combined modifiers included',
    bad.length === 0, bad.length === 0 ? `${total} cells` : bad.join('; '));
}

{
  // Ctrl/Command+wheel must never reach the browser (it would zoom the whole page), in any state.
  const combined = MODIFIERS.filter(([mod]) =>
    (mod === 'ctrl' || mod === 'meta'));
  const leaks = TABLE.flatMap(([wheelZooms, hasCapture]) =>
    combined.map(([mod, mods]) => ({ wheelZooms, hasCapture, mod, got: wheelAction(mods, { wheelZooms, hasCapture }) })))
    .filter((cell) => cell.got !== (cell.hasCapture ? 'zoom' : 'block'));
  check('Ctrl/Command+wheel zooms with a capture and is swallowed without one, whatever the option says',
    leaks.length === 0,
    leaks.length === 0 ? `${TABLE.length * combined.length} ctrl/meta cells`
      : leaks.map((c) => `zooms=${c.wheelZooms} cap=${c.hasCapture} ${c.mod}: ${c.got}`).join('; '));
}

{
  const shifted = cells().filter((cell) => cell.mod.includes('shift'));
  const wrong = shifted.filter((cell) => cell.got !== (cell.hasCapture ? 'pan' : 'block'));
  check('Shift wins over Ctrl and over Command: every shifted combination pans or is swallowed',
    wrong.length === 0 && shifted.length === TABLE.length * 3,
    wrong.length === 0 ? `${shifted.length} shifted cells` : wrong.map((c) => `${c.mod}: ${c.got}`).join('; '));
}

{
  const changed = MODIFIERS
    .filter(([, mods]) => [true, false].some((hasCapture) =>
      wheelAction(mods, { wheelZooms: true, hasCapture }) !==
        wheelAction(mods, { wheelZooms: false, hasCapture })))
    .map(([mod]) => mod);
  check('the "wheel zooms" preference changes only the plain wheel, never a modified one',
    changed.length === 1 && changed[0] === 'plain', `changed=${changed.join(',')}`);
}

{
  const swap = (mods: Mods, ctx: { wheelZooms: boolean; hasCapture: boolean }): WheelAction => {
    const ctrl = mods.ctrlKey || mods.metaKey;
    if (mods.shiftKey) return ctx.hasCapture ? 'pan' : 'block';
    if (ctrl) return ctx.wheelZooms ? 'native' : (ctx.hasCapture ? 'zoom' : 'block');
    if (!ctx.hasCapture) return 'native';
    return ctx.wheelZooms ? 'zoom' : 'native';
  };
  const divergent = TABLE.flatMap(([wheelZooms, hasCapture, want]) =>
    MODIFIERS.map(([mod, mods], index) => ({ wheelZooms, hasCapture, mod, mods, index }))
      .filter((cell) => swap(cell.mods, cell) !== want[cell.index]));
  check('control: the retired swap rule diverges from the table in the enabled Ctrl/Command cells only',
    divergent.length === 4 && divergent.every((cell) => cell.wheelZooms &&
      !cell.mod.includes('shift') && (cell.mod.includes('ctrl') || cell.mod.includes('meta'))),
    `divergent=${divergent.map((c) => `zooms=${c.wheelZooms} cap=${c.hasCapture} ${c.mod}`).join('; ')}`);
}

{
  // The corner Fit button zooms on a plain wheel and on Ctrl/⌘+wheel and pans on Shift,
  // independent of the preference; without a capture it keeps wheelAction's guards.
  const order = MODIFIERS.slice(0, 4);
  const got = (hasCapture: boolean): string =>
    order.map(([, mods]) => fitWheelAction(mods, hasCapture)).join(',');
  check('the Fit button wheel zooms with or without Ctrl, pans with Shift, and is inert without a capture',
    got(true) === 'zoom,zoom,zoom,pan' && got(false) === 'native,block,block,block',
    `capture=${got(true)}, none=${got(false)}`);
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
