// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { en } from '../locales/en.js';
import {
  CHANNEL_LABEL_MODES, CHANNEL_LABEL_MODE_HINT_KEYS, CHANNEL_LABEL_MODE_LABEL_KEYS,
  CHANNEL_LABEL_MODE_STORAGE_KEY, DEFAULT_CHANNEL_LABEL_MODE, getChannelLabelMode,
  initChannelLabelMode, onChannelLabelModeChange, pickChannelLabelMode, setChannelLabelMode,
  type ChannelLabelMode,
} from '../channelLabelMode.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function defineGlobal(name: 'localStorage', value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

// ------------------------------------------------------------------ registry

{
  const ids = [...CHANNEL_LABEL_MODES].join(',');
  check('CHANNEL_LABEL_MODES is exactly name,legacy with name as the default and logicweb.channelLabelMode as the key',
    ids === 'name,legacy' && DEFAULT_CHANNEL_LABEL_MODE === 'name' &&
    CHANNEL_LABEL_MODE_STORAGE_KEY === 'logicweb.channelLabelMode',
    `modes=[${ids}], default=${DEFAULT_CHANNEL_LABEL_MODE}, key=${CHANNEL_LABEL_MODE_STORAGE_KEY}`);
}

// ------------------------------------------------------ pickChannelLabelMode

{
  const table: [string | null, ChannelLabelMode][] = [
    [null, 'name'],
    ['', 'name'],
    ['name', 'name'],
    ['legacy', 'legacy'],
    ['foo', 'name'],
    ['LEGACY', 'name'],
    ['legacy ', 'name'],
  ];
  const wrong = table
    .map(([stored, want]) => ({ stored, want, got: pickChannelLabelMode(stored) }))
    .filter((row) => row.got !== row.want);
  check('pickChannelLabelMode honors only exact registry members and falls back to name',
    wrong.length === 0,
    wrong.length === 0
      ? table.map(([stored, want]) => `${JSON.stringify(stored)}→${want}`).join(', ')
      : wrong.map((r) => `${JSON.stringify(r.stored)}→${r.got} (want ${r.want})`).join('; '));
}

// ------------------------------------------- key registries ↔ en catalog

{
  const catalog = en as Record<string, string>;
  const labelKeys = CHANNEL_LABEL_MODES.map((mode) => CHANNEL_LABEL_MODE_LABEL_KEYS[mode]);
  const hintKeys = CHANNEL_LABEL_MODES.map((mode) => CHANNEL_LABEL_MODE_HINT_KEYS[mode]);
  const missing = [...labelKeys, ...hintKeys]
    .filter((key) => (catalog[key] ?? '').trim() === '');
  const extra = [
    ...Object.keys(CHANNEL_LABEL_MODE_LABEL_KEYS),
    ...Object.keys(CHANNEL_LABEL_MODE_HINT_KEYS),
  ].filter((key) => !(CHANNEL_LABEL_MODES as readonly string[]).includes(key));
  check('every mode has non-empty label and hint keys in the en catalog and no extra registry ids',
    missing.length === 0 && extra.length === 0,
    missing.length === 0 && extra.length === 0
      ? `${labelKeys.join(',')} / ${hintKeys.join(',')}`
      : `missing=${missing.join(',') || '(none)'} extra=${extra.join(',') || '(none)'}`);

  const nameHint = catalog[CHANNEL_LABEL_MODE_HINT_KEYS.name] ?? '';
  const legacyHint = catalog[CHANNEL_LABEL_MODE_HINT_KEYS.legacy] ?? '';
  const labelTexts = labelKeys.map((key) => catalog[key] ?? '');
  check('the two hint keys resolve to different texts and the two labels differ too',
    nameHint !== '' && legacyHint !== '' && nameHint !== legacyHint &&
    labelTexts[0] !== labelTexts[1],
    `hintsDiffer=${nameHint !== legacyHint}, labels=${JSON.stringify(labelTexts)}`);
}

// ------------------------------------------------- fresh-state node boot

{
  const boot = getChannelLabelMode();
  check('a fresh module boots to name before any storage stub',
    boot === 'name', `getChannelLabelMode()=${boot}`);
}

// ------------------------------------------- init is read-only (fresh visitor)

{
  const reads: string[] = [];
  const writes: [string, string][] = [];
  defineGlobal('localStorage', {
    getItem: (key: string) => { reads.push(key); return null; },
    setItem: (key: string, value: string) => { writes.push([key, value]); },
  });
  const booted = initChannelLabelMode();
  check('a fresh initChannelLabelMode reads the key and writes no storage entry',
    booted === 'name' && getChannelLabelMode() === 'name' &&
    reads.length === 1 && reads[0] === CHANNEL_LABEL_MODE_STORAGE_KEY && writes.length === 0,
    `booted=${booted}, reads=${JSON.stringify(reads)}, writes=${writes.length}`);
}

// ------------------------------------------- persist + notify

{
  const writes: [string, string][] = [];
  let stored: string | null = null;
  defineGlobal('localStorage', {
    getItem: () => stored,
    setItem: (key: string, value: string) => { writes.push([key, value]); stored = value; },
  });
  let notified = 0;
  const unsubscribe = onChannelLabelModeChange(() => { notified += 1; });

  setChannelLabelMode('legacy');
  const afterFirst = { mode: getChannelLabelMode(), writes: writes.length, notified };
  setChannelLabelMode('legacy');
  unsubscribe();
  const restored = initChannelLabelMode();

  const ok = afterFirst.mode === 'legacy' && afterFirst.writes === 1 && afterFirst.notified === 1 &&
    writes.length === 1 && writes[0]?.[0] === CHANNEL_LABEL_MODE_STORAGE_KEY &&
    writes[0]?.[1] === 'legacy' && notified === 1 && restored === 'legacy';
  check('setChannelLabelMode persists and notifies once, repeats are silent, init restores it',
    ok,
    `mode=${getChannelLabelMode()}, writes=${writes.length}, notified=${notified}, restored=${restored}`);
}

// ------------------------------------------- unsubscribe stops notifications

{
  let fired = 0;
  const unsubscribe = onChannelLabelModeChange(() => { fired += 1; });
  setChannelLabelMode('name');
  const afterReal = fired;
  setChannelLabelMode('name');
  unsubscribe();
  setChannelLabelMode('legacy');
  check('onChannelLabelModeChange fires once per real change and unsubscribe stops it',
    afterReal === 1 && fired === 1 && getChannelLabelMode() === 'legacy',
    `afterReal=${afterReal}, fired=${fired}, mode=${getChannelLabelMode()}`);
}

// ------------------------------------------- throwing storage (both directions)

{
  defineGlobal('localStorage', {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
  });
  let booted: ChannelLabelMode = 'legacy';
  let bootThrew = false;
  try {
    booted = initChannelLabelMode();
  } catch {
    bootThrew = true;
  }
  let notified = 0;
  const unsubscribe = onChannelLabelModeChange(() => { notified += 1; });
  let switchThrew = false;
  try {
    setChannelLabelMode('legacy');
  } catch {
    switchThrew = true;
  }
  unsubscribe();
  check('throwing getItem and setItem break neither boot nor the in-memory switch',
    !bootThrew && booted === 'name' && !switchThrew && getChannelLabelMode() === 'legacy' &&
    notified === 1,
    `boot=${booted}, bootThrew=${bootThrew}, switchThrew=${switchThrew}, ` +
    `notified=${notified}, mode=${getChannelLabelMode()}`);
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
