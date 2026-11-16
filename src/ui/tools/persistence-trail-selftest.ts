// SPDX-License-Identifier: GPL-3.0-or-later

import {
  PERSISTENCE_FRAMES, clearReason, effectivePersistence, persistenceOf, persistenceSignature,
  shouldCommitPersistence, trailClearKey, trailDecay,
  type PersistenceClearKeyInput, type PersistenceCommitInput, type PersistenceFrames,
  type PersistenceSourceKey, type PersistenceSurfaceView,
} from '../persistenceTrail.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function near(got: number, want: number, epsilon: number): boolean {
  return Math.abs(got - want) <= epsilon;
}

{
  const list = [...PERSISTENCE_FRAMES];
  check('PERSISTENCE_FRAMES is exactly the Off/8/16/32 global set',
    list.length === 4 && list[0] === 0 && list[1] === 8 && list[2] === 16 && list[3] === 32,
    `list=${JSON.stringify(list)}`);
  check('PERSISTENCE_FRAMES has no duplicate entries',
    new Set(list).size === list.length, `size=${new Set(list).size}`);
}

{
  const accepted = [0, 8, 16, 32].map((raw) => persistenceOf(raw));
  const rejected = ['8', '32', 4, 64, 8.5, -8, null, undefined, Number.NaN, Number.POSITIVE_INFINITY,
    true, {}, [8]]
    .map((raw) => persistenceOf(raw));
  check('persistenceOf accepts only the four global trail lengths',
    JSON.stringify(accepted) === '[0,8,16,32]', `accepted=${JSON.stringify(accepted)}`);
  check('persistenceOf falls back to Off for every non-member value',
    rejected.every((value) => value === 0), `rejected=${JSON.stringify(rejected)}`);
  check('persistenceOf normalises negative zero to Off',
    Object.is(persistenceOf(-0), 0) && !Object.is(persistenceOf(-0), -0),
    `value=${String(persistenceOf(-0))}`);
}

{
  const loop = effectivePersistence(8, true);
  const off = effectivePersistence(0, true);
  const stacked = effectivePersistence(32, false);
  check('effectivePersistence forces Off under Loop and keeps the setting otherwise',
    loop === 0 && off === 0 && stacked === 32 && effectivePersistence(16, false) === 16,
    `loop=${loop}, off=${off}, stacked=${stacked}`);
  check('effectivePersistence retains no hidden accumulation under Loop',
    effectivePersistence(32, true) === 0 && effectivePersistence(32, true) === 0,
    `repeat=${effectivePersistence(32, true)}`);
}

{
  const table = [trailDecay(8), trailDecay(16), trailDecay(32)];
  const expected = [0.875, 0.9375, 0.96875];
  check('trailDecay matches the independent 1 - 1/N table for 8/16/32',
    table.every((value, index) => near(value, expected[index]!, 1e-15)),
    `got=${JSON.stringify(table)}, want=${JSON.stringify(expected)}`);
  check('trailDecay(Off) clears instead of retaining',
    trailDecay(0) === 0, `value=${trailDecay(0)}`);
  check('trailDecay is monotone in N and strictly inside (0,1)',
    trailDecay(8) < trailDecay(16) && trailDecay(16) < trailDecay(32) &&
    trailDecay(32) < 1 && trailDecay(8) > 0,
    `values=${JSON.stringify(table)}`);
}

{
  const retained = (frames: PersistenceFrames, waves: number): number => {
    let weight = 1;
    for (let i = 0; i < waves; i++) weight *= trailDecay(frames);
    return weight;
  };
  const eight = retained(8, 8);
  const sixteen = retained(16, 16);
  const thirtyTwo = retained(32, 32);
  check('N waves retain (1-1/N)^N of the oldest wave, never zero',
    near(eight, 0.34360891580581665, 1e-12) &&
    near(sixteen, 0.3560741304517928, 1e-12) &&
    near(thirtyTwo, 0.3620552892563166, 1e-12),
    `8=${eight}, 16=${sixteen}, 32=${thirtyTwo}`);
  check('Persistence N is a time constant, not a ring that drops the oldest at N+1',
    eight > 0.34 && sixteen > 0.35 && thirtyTwo > 0.36 && retained(8, 9) > 0,
    `wave8=${eight}, wave9=${retained(8, 9)}`);
  check('a hypothetical N-frame ring would be falsified by the same numbers',
    retained(8, 8) > 0 && !near(retained(8, 8), 0, 1e-6),
    `ringWouldBe=0, trail=${retained(8, 8)}`);
}

const SOURCE_A: PersistenceSourceKey = {
  busId: 'bus-a',
  gain: 2,
  fullScaleV: 1.65,
  voltsPerDiv: 0.5,
  zeroPosition: 0.5,
  offsetV: 0,
  color: '#2683D9',
  visible: true,
};

const SOURCE_B: PersistenceSourceKey = {
  busId: 'bus-b',
  gain: 1,
  fullScaleV: null,
  voltsPerDiv: null,
  zeroPosition: 0.25,
  offsetV: 0.25,
  color: '#CD427E',
  visible: false,
};

const KEY_INPUT: PersistenceClearKeyInput = {
  viewportStart: 1024,
  viewportEnd: 3072,
  widthCss: 800,
  heightCss: 480,
  dpr: 1.25,
  analogLayout: 'stacked',
  bandTop: 0,
  bandHeight: 160,
  samplerate: 100_000_000,
  sources: [SOURCE_A, SOURCE_B],
};

{
  const base = trailClearKey(KEY_INPUT);
  const again = trailClearKey({ ...KEY_INPUT, sources: [SOURCE_A, SOURCE_B] });
  check('trailClearKey is deterministic for the same inputs',
    base === again && base.length > 0, `key=${base}`);
  check('trailClearKey ignores source array order',
    trailClearKey({ ...KEY_INPUT, sources: [SOURCE_B, SOURCE_A] }) === base,
    `ordered=${base}`);
}

{
  const base = trailClearKey(KEY_INPUT);
  const inputChanges: Array<[string, PersistenceClearKeyInput]> = [
    ['viewportStart', { ...KEY_INPUT, viewportStart: 1025 }],
    ['viewportEnd', { ...KEY_INPUT, viewportEnd: 3073 }],
    ['widthCss', { ...KEY_INPUT, widthCss: 801 }],
    ['heightCss', { ...KEY_INPUT, heightCss: 481 }],
    ['dpr', { ...KEY_INPUT, dpr: 2 }],
    ['analogLayout', { ...KEY_INPUT, analogLayout: 'merged' }],
    ['bandTop', { ...KEY_INPUT, bandTop: 1 }],
    ['bandHeight', { ...KEY_INPUT, bandHeight: 240 }],
    ['samplerate', { ...KEY_INPUT, samplerate: 50_000_000 }],
    ['gain', { ...KEY_INPUT, sources: [{ ...SOURCE_A, gain: 1 }, SOURCE_B] }],
    ['fullScaleV', { ...KEY_INPUT, sources: [{ ...SOURCE_A, fullScaleV: 3.3 }, SOURCE_B] }],
    ['fullScaleV to null', { ...KEY_INPUT, sources: [{ ...SOURCE_A, fullScaleV: null }, SOURCE_B] }],
    ['voltsPerDiv', { ...KEY_INPUT, sources: [{ ...SOURCE_A, voltsPerDiv: 1 }, SOURCE_B] }],
    ['voltsPerDiv to null', { ...KEY_INPUT, sources: [{ ...SOURCE_A, voltsPerDiv: null }, SOURCE_B] }],
    ['zeroPosition', { ...KEY_INPUT, sources: [{ ...SOURCE_A, zeroPosition: 0.4 }, SOURCE_B] }],
    ['offsetV', { ...KEY_INPUT, sources: [{ ...SOURCE_A, offsetV: 0.1 }, SOURCE_B] }],
    ['color', { ...KEY_INPUT, sources: [{ ...SOURCE_A, color: '#00994D' }, SOURCE_B] }],
    ['visible', { ...KEY_INPUT, sources: [{ ...SOURCE_A, visible: false }, SOURCE_B] }],
    ['source removed', { ...KEY_INPUT, sources: [SOURCE_A] }],
    ['source added', { ...KEY_INPUT, sources: [SOURCE_A, SOURCE_B, { ...SOURCE_A, busId: 'bus-c' }] }],
    ['source id', { ...KEY_INPUT, sources: [{ ...SOURCE_A, busId: 'bus-z' }, SOURCE_B] }],
  ];
  const unchanged = inputChanges.filter(([, input]) => trailClearKey(input) === base)
    .map(([name]) => name);
  check('every clear-key input changes the key',
    unchanged.length === 0, `unchanged=${JSON.stringify(unchanged)}`);
  check('the clear-key mutation table is not vacuous',
    inputChanges.length === 21, `rows=${inputChanges.length}`);
}

{
  const base = trailClearKey(KEY_INPUT);
  const withViewMode = (viewMode: string): string => trailClearKey(
    { ...KEY_INPUT, viewMode } as unknown as PersistenceClearKeyInput,
  );
  check('viewMode never enters the clear key (Time/FFT/XY only hides)',
    withViewMode('fft') === base && withViewMode('xy') === base && withViewMode('time') === base,
    `fft=${withViewMode('fft') === base}, xy=${withViewMode('xy') === base}`);
  check('a viewMode-only change yields no clear reason',
    clearReason(base, withViewMode('fft'), 'none') === null,
    `reason=${clearReason(base, withViewMode('fft'), 'none')}`);
}

{
  const throws = (run: () => unknown): boolean => {
    try {
      run();
      return false;
    } catch (error) {
      return error instanceof RangeError;
    }
  };
  const badLayout = throws(() => trailClearKey(
    { ...KEY_INPUT, analogLayout: 'overlay' } as unknown as PersistenceClearKeyInput,
  ));
  const badWidth = throws(() => trailClearKey({ ...KEY_INPUT, widthCss: Number.NaN }));
  const badGain = throws(() => trailClearKey({
    ...KEY_INPUT, sources: [{ ...SOURCE_A, gain: Number.POSITIVE_INFINITY }],
  }));
  const zeroIsDistinct = trailClearKey({ ...KEY_INPUT, bandTop: -0 }) !==
    trailClearKey({ ...KEY_INPUT, bandTop: 0 });
  check('trailClearKey rejects an unknown layout and non-finite geometry',
    badLayout && badWidth && badGain,
    `layout=${badLayout}, width=${badWidth}, gain=${badGain}`);
  check('trailClearKey keeps -0 and 0 distinguishable',
    zeroIsDistinct,
    `distinct=${zeroIsDistinct}`);
}

{
  const base = trailClearKey(KEY_INPUT);
  const changed = trailClearKey({ ...KEY_INPUT, bandHeight: 240 });
  check('clearReason passes explicit lifecycle events through',
    clearReason(null, null, 'capture-session') === 'capture-session' &&
    clearReason(null, null, 'capture-replacement') === 'capture-replacement' &&
    clearReason(null, null, 'clear') === 'clear' &&
    clearReason(null, null, 'band-removed') === 'band-removed',
    `session=${clearReason(null, null, 'capture-session')}`);
  check('clearReason reports a display key change only',
    clearReason(base, changed, 'none') === 'display-change' &&
    clearReason(base, base, 'none') === null &&
    clearReason(null, base, 'none') === null &&
    clearReason(base, null, 'none') === null,
    `changed=${clearReason(base, changed, 'none')}, same=${clearReason(base, base, 'none')}`);
}

const COMMIT_BASE: PersistenceCommitInput = {
  enabled: true,
  loop: false,
  reason: 'completed',
  samples: 2048,
  missed: false,
  viewMode: 'time',
  visible: true,
  waveKey: '7:0',
  lastWaveKey: null,
};

interface TrailDriver {
  lastWaveKey: string | null;
  commits: number;
}

function feed(driver: TrailDriver, overrides: Partial<PersistenceCommitInput>): boolean {
  const input: PersistenceCommitInput = {
    ...COMMIT_BASE, ...overrides, lastWaveKey: driver.lastWaveKey,
  };
  const commit = shouldCommitPersistence(input);
  if (commit) {
    driver.lastWaveKey = input.waveKey;
    driver.commits += 1;
  }
  return commit;
}

{
  const driver: TrailDriver = { lastWaveKey: null, commits: 0 };
  const frames: boolean[] = [];
  for (let generation = 0; generation < 6; generation++) {
    const key = `7:${generation}`;
    frames.push(feed(driver, { waveKey: key }));
    for (let refresh = 0; refresh < 4; refresh++) frames.push(feed(driver, { waveKey: key }));
    frames.push(feed(driver, { waveKey: key, reason: 'manual' }));
    frames.push(feed(driver, { waveKey: key, reason: 'error' }));
  }
  const commits = frames.filter(Boolean).length;
  check('Repeat N completed waves commits exactly N, animation and status frames none',
    commits === 6 && driver.commits === 6 && frames.length === 42,
    `commits=${commits}, driver=${driver.commits}, frames=${frames.length}`);
}

{
  const single: TrailDriver = { lastWaveKey: null, commits: 0 };
  const first = feed(single, { waveKey: '9:0' });
  const replay = feed(single, { waveKey: '9:0' });
  check('Single produces exactly one commit and a replayed notification none',
    first && !replay && single.commits === 1,
    `first=${first}, replay=${replay}, commits=${single.commits}`);
}

{
  const stop: TrailDriver = { lastWaveKey: '4:3', commits: 0 };
  const manual = feed(stop, { reason: 'manual', waveKey: '4:4' });
  const error = feed(stop, { reason: 'error', waveKey: '4:5' });
  check('Stop and error frames never commit and never advance the last wave',
    !manual && !error && stop.commits === 0 && stop.lastWaveKey === '4:3',
    `manual=${manual}, error=${error}, last=${stop.lastWaveKey}`);
}

{
  const loop: TrailDriver = { lastWaveKey: null, commits: 0 };
  const enabledLoop = feed(loop, { loop: true, waveKey: '5:0' });
  const offLoop = feed(loop, { loop: true, enabled: false, waveKey: '5:1' });
  check('Loop never commits and retains no hidden history',
    !enabledLoop && !offLoop && loop.commits === 0 && loop.lastWaveKey === null,
    `enabledLoop=${enabledLoop}, offLoop=${offLoop}, last=${loop.lastWaveKey}`);
}

{
  const empty: TrailDriver = { lastWaveKey: null, commits: 0 };
  const emptyWave = feed(empty, { samples: 0, waveKey: '6:0' });
  const missedWave = feed(empty, { missed: true, waveKey: '6:1' });
  const offWave = feed(empty, { enabled: false, waveKey: '6:2' });
  check('Empty, missed and Off waves never commit',
    !emptyWave && !missedWave && !offWave && empty.commits === 0,
    `empty=${emptyWave}, missed=${missedWave}, off=${offWave}`);
}

{
  const hidden: TrailDriver = { lastWaveKey: null, commits: 0 };
  const skipped = [0, 1, 2, 3, 4]
    .map((generation) => feed(hidden, { visible: false, waveKey: `8:${generation}` }));
  const beforeReturn = hidden.commits;
  const returned = feed(hidden, { waveKey: '8:5' });
  check('hidden surfaces commit nothing and the next visible wave commits once',
    skipped.every((value) => !value) && beforeReturn === 0 && returned && hidden.commits === 1,
    `skipped=${JSON.stringify(skipped)}, commits=${hidden.commits}`);
}

{
  const analysis: TrailDriver = { lastWaveKey: null, commits: 0 };
  const fft = feed(analysis, { viewMode: 'fft', waveKey: '10:0' });
  const xy = feed(analysis, { viewMode: 'xy', waveKey: '10:1' });
  const backToTime = feed(analysis, { viewMode: 'time', waveKey: '10:2' });
  check('analysis views pause commits and Time resumes them without a clear',
    !fft && !xy && backToTime && analysis.commits === 1,
    `fft=${fft}, xy=${xy}, time=${backToTime}, commits=${analysis.commits}`);
}

{
  const surfaceA: PersistenceSurfaceView = {
    id: 'band-a', top: 0, height: 160, width: 800, generation: 3, commits: 12,
  };
  const surfaceB: PersistenceSurfaceView = {
    id: 'band-b', top: 160, height: 120, width: 800, generation: 1, commits: 4,
  };
  const base = persistenceSignature(8, [surfaceA, surfaceB]);
  const mutations: Array<[string, string]> = [
    ['frames', persistenceSignature(16, [surfaceA, surfaceB])],
    ['off', persistenceSignature(0, [surfaceA, surfaceB])],
    ['top', persistenceSignature(8, [{ ...surfaceA, top: 8 }, surfaceB])],
    ['height', persistenceSignature(8, [{ ...surfaceA, height: 240 }, surfaceB])],
    ['width', persistenceSignature(8, [{ ...surfaceA, width: 801 }, surfaceB])],
    ['generation', persistenceSignature(8, [{ ...surfaceA, generation: 4 }, surfaceB])],
    ['commits', persistenceSignature(8, [{ ...surfaceA, commits: 13 }, surfaceB])],
    ['id', persistenceSignature(8, [{ ...surfaceA, id: 'band-z' }, surfaceB])],
    ['surface removed', persistenceSignature(8, [surfaceA])],
  ];
  const unchanged = mutations.filter(([, value]) => value === base).map(([name]) => name);
  check('persistenceSignature changes with frames, geometry, generation and commits',
    unchanged.length === 0, `unchanged=${JSON.stringify(unchanged)}`);
  check('persistenceSignature is deterministic and surface-order independent',
    persistenceSignature(8, [surfaceB, surfaceA]) === base &&
    persistenceSignature(8, [surfaceA, surfaceB]) === base &&
    persistenceSignature(0, []) === '0' && persistenceSignature(32, []) === '32',
    `reordered=${persistenceSignature(8, [surfaceB, surfaceA]) === base}, empty=${persistenceSignature(0, [])}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
