// SPDX-License-Identifier: GPL-3.0-or-later

import {
  MAX_SAMPLERATE_HZ, MAX_SAMPLERATE_HZ_SLOGIC32_U3, SAMPLERATES_HZ,
} from '../../device/index.js';
import {
  SCOPE_MIN_SAMPLERATE_HZ, maxScopesAtRate, maxWidthAtRate, scopeEnableVerdict, scopeRateBlockAt,
  scopeRateOptions, type ScopeEnableVerdict,
} from '../scopeRateLimits.js';

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

const SL16 = MAX_SAMPLERATE_HZ;
const SL32 = MAX_SAMPLERATE_HZ_SLOGIC32_U3;

check('scope floor is a real device samplerate', SAMPLERATES_HZ.includes(SCOPE_MIN_SAMPLERATE_HZ),
  `floor=${SCOPE_MIN_SAMPLERATE_HZ}`);

{
  const table: [number, number][] = [
    [5e6, 16], [100e6, 16], [200e6, 16], [200e6 + 1, 8], [400e6, 8], [400e6 + 1, 4], [800e6, 4], [800e6 + 1, 0],
  ];
  const bad = table.filter(([rate, want]) => maxWidthAtRate(rate, SL16) !== want);
  check('maxWidthAtRate SLogic16 table', bad.length === 0,
    bad.map(([r, w]) => `${r}->${maxWidthAtRate(r, SL16)}!=${w}`).join(',') || 'exact');
}
{
  const table: [number, number][] = [
    [200e6, 32], [200e6 + 1, 16], [400e6, 16], [800e6, 8], [1.4e9, 4], [1.4e9 + 1, 0],
  ];
  const bad = table.filter(([rate, want]) => maxWidthAtRate(rate, SL32) !== want);
  check('maxWidthAtRate SLogic32 table', bad.length === 0,
    bad.map(([r, w]) => `${r}->${maxWidthAtRate(r, SL32)}!=${w}`).join(',') || 'exact');
}

{
  const table: [number, number, number][] = [
    [100e6, 16, 2], [200e6, 16, 2], [400e6, 16, 1], [800e6, 16, 0],
  ];
  const bad = table.filter(([rate, dev, want]) => maxScopesAtRate(rate, SL16, dev) !== want);
  check('maxScopesAtRate SLogic16 table', bad.length === 0,
    bad.map(([r, d, w]) => `${r}/${d}->${maxScopesAtRate(r, SL16, d)}!=${w}`).join(',') || 'exact');
}
{
  const table: [number, number, number][] = [
    [100e6, 32, 4], [200e6, 32, 4], [400e6, 32, 2], [800e6, 32, 1], [1.4e9, 32, 0],
    [100e6, 16, 2], [800e6, 8, 1], [800e6, 4, 0],
  ];
  const bad = table.filter(([rate, dev, want]) => maxScopesAtRate(rate, SL32, dev) !== want);
  check('maxScopesAtRate SLogic32 table incl. device-width clamp', bad.length === 0,
    bad.map(([r, d, w]) => `${r}/${d}->${maxScopesAtRate(r, SL32, d)}!=${w}`).join(',') || 'exact');
}

function verdictEq(v: ScopeEnableVerdict, want: ScopeEnableVerdict): string | null {
  const keys = ['ok', 'effectiveRate', 'requiredWidth', 'bankWidth', 'maxRate', 'maxScopes'] as const;
  const diff = keys.filter((k) => v[k] !== want[k]);
  return diff.length === 0 ? null : diff.map((k) => `${k}=${String(v[k])}!=${String(want[k])}`).join(',');
}

{
  const cases: [string, Parameters<typeof scopeEnableVerdict>[0], ScopeEnableVerdict][] = [
    ['floor raise keeps enable ok at tight ceiling',
      { start: 0, clockChannel: null, currentWidth: 16, rate: 16e6, ceilings: SL16, deviceChannels: 16 },
      { ok: true, effectiveRate: 100e6, requiredWidth: 16, bankWidth: 8, maxRate: 200e6, maxScopes: 2 }],
    ['rate exactly at the floor',
      { start: 0, clockChannel: null, currentWidth: 8, rate: 100e6, ceilings: SL16, deviceChannels: 16 },
      { ok: true, effectiveRate: 100e6, requiredWidth: 8, bankWidth: 8, maxRate: 400e6, maxScopes: 2 }],
    ['800M supports no bank on SLogic16',
      { start: 0, clockChannel: null, currentWidth: 4, rate: 800e6, ceilings: SL16, deviceChannels: 16 },
      { ok: false, effectiveRate: 800e6, requiredWidth: 8, bankWidth: 8, maxRate: 400e6, maxScopes: 0 }],
    ['second bank needs 16ch at 400M on SLogic16',
      { start: 8, clockChannel: null, currentWidth: 8, rate: 400e6, ceilings: SL16, deviceChannels: 16 },
      { ok: false, effectiveRate: 400e6, requiredWidth: 16, bankWidth: 16, maxRate: 200e6, maxScopes: 1 }],
    ['rate exactly at the required ceiling stays ok',
      { start: 8, clockChannel: null, currentWidth: 8, rate: 200e6, ceilings: SL16, deviceChannels: 16 },
      { ok: true, effectiveRate: 200e6, requiredWidth: 16, bankWidth: 16, maxRate: 200e6, maxScopes: 2 }],
    ['external clock above the bank widens the requirement',
      { start: 0, clockChannel: 8, currentWidth: 8, rate: 400e6, ceilings: SL16, deviceChannels: 16 },
      { ok: false, effectiveRate: 400e6, requiredWidth: 16, bankWidth: 16, maxRate: 200e6, maxScopes: 1 }],
    ['external clock inside the bank changes nothing',
      { start: 0, clockChannel: 7, currentWidth: 8, rate: 400e6, ceilings: SL16, deviceChannels: 16 },
      { ok: true, effectiveRate: 400e6, requiredWidth: 8, bankWidth: 8, maxRate: 400e6, maxScopes: 1 }],
    ['unrelated enabled channels dominate the requirement',
      { start: 0, clockChannel: null, currentWidth: 32, rate: 400e6, ceilings: SL32, deviceChannels: 32 },
      { ok: false, effectiveRate: 400e6, requiredWidth: 32, bankWidth: 8, maxRate: 200e6, maxScopes: 2 }],
    ['SLogic32 third bank at 400M needs 32ch',
      { start: 16, clockChannel: null, currentWidth: 16, rate: 400e6, ceilings: SL32, deviceChannels: 32 },
      { ok: false, effectiveRate: 400e6, requiredWidth: 32, bankWidth: 32, maxRate: 200e6, maxScopes: 2 }],
    ['SLogic32 second bank at 800M stays blocked, first is fine',
      { start: 0, clockChannel: null, currentWidth: 8, rate: 800e6, ceilings: SL32, deviceChannels: 32 },
      { ok: true, effectiveRate: 800e6, requiredWidth: 8, bankWidth: 8, maxRate: 800e6, maxScopes: 1 }],
    ['widths without a ceiling entry block everything',
      { start: 56, clockChannel: null, currentWidth: 64, rate: 100e6, ceilings: SL32, deviceChannels: 128 },
      { ok: false, effectiveRate: 100e6, requiredWidth: 64, bankWidth: 64, maxRate: 0, maxScopes: 4 }],
    ['SLogic32 first bank is blocked at 1.4G',
      { start: 0, clockChannel: null, currentWidth: 4, rate: 1.4e9, ceilings: SL32, deviceChannels: 32 },
      { ok: false, effectiveRate: 1.4e9, requiredWidth: 8, bankWidth: 8, maxRate: 800e6, maxScopes: 0 }],
  ];
  const bad = cases.flatMap(([name, args, want]) => {
    const diff = verdictEq(scopeEnableVerdict(args), want);
    return diff === null ? [] : [`${name}: ${diff}`];
  });
  check('scopeEnableVerdict matrix', bad.length === 0, bad.join(' | ') || `${cases.length} cases exact`);
}

{
  const floor = scopeRateBlockAt(5e6, 16, SL16, true);
  const okAtFloor = scopeRateBlockAt(100e6, 16, SL16, true);
  const ceiling = scopeRateBlockAt(400e6, 16, SL16, true);
  const okAtCeiling = scopeRateBlockAt(200e6, 16, SL16, true);
  const noScope = scopeRateBlockAt(50e6, 4, SL16, false) === null && scopeRateBlockAt(400e6, 16, SL16, false) === null;
  const missing = scopeRateBlockAt(100e6, 64, SL32, true);
  const top32 = scopeRateBlockAt(1.4e9, 32, SL32, true);
  check('scopeRateBlockAt tri-state',
    floor?.kind === 'floor' && okAtFloor === null &&
    ceiling?.kind === 'ceiling' && ceiling.width === 16 && ceiling.maxRate === 200e6 &&
    okAtCeiling === null && noScope &&
    missing?.kind === 'ceiling' && missing.maxRate === 0 &&
    top32?.kind === 'ceiling' && top32.width === 32 && top32.maxRate === 200e6,
    `floor=${floor?.kind}, okAtFloor=${String(okAtFloor)}, ceiling=${JSON.stringify(ceiling)}, ` +
    `okAtCeiling=${String(okAtCeiling)}, noScope=${noScope}, missing=${JSON.stringify(missing)}, top32=${JSON.stringify(top32)}`);
}

{
  const everyRate = SAMPLERATES_HZ.map((rate) => {
    const width = maxWidthAtRate(rate, SL16);
    const scopes = maxScopesAtRate(rate, SL16, 16);
    const enabledOnly = width > 0 && scopes > 0;
    return scopeEnableVerdict({
      start: 0, clockChannel: null, currentWidth: 4, rate, ceilings: SL16, deviceChannels: 16,
    }).ok === enabledOnly;
  });
  check('SLogic16 every device rate agrees with the width/scopes derivation', everyRate.every(Boolean),
    `${everyRate.filter(Boolean).length}/${everyRate.length}`);
}

function optionSummary(
  rates: readonly number[], width: number, ceilings: Readonly<Record<number, number>>, active: boolean,
): string {
  return scopeRateOptions(rates, width, ceilings, active)
    .map((option) => `${option.rate / 1e6}:${option.block === null ? 'on' : option.block.kind}`)
    .join(',');
}

{
  const legacy = optionSummary(SAMPLERATES_HZ, 16, SL16, false);
  check('inactive scope keeps the legacy ceiling-filtered option set',
    legacy === '5:on,8:on,10:on,16:on,20:on,25:on,32:on,40:on,50:on,80:on,100:on,160:on,200:on', legacy);
  const scope16 = optionSummary(SAMPLERATES_HZ, 16, SL16, true);
  check('SLogic16 scope at 16ch lists up to the device cap with floor and ceiling blocks',
    scope16 === '5:floor,8:floor,10:floor,16:floor,20:floor,25:floor,32:floor,40:floor,50:floor,80:floor,' +
      '100:on,160:on,200:on,400:ceiling,800:ceiling', scope16);
  const scope8of32 = optionSummary(SAMPLERATES_HZ, 8, SL32, true);
  check('SLogic32 scope at 8ch reaches 800M and caps 1.4G as a ceiling block',
    scope8of32 === '5:floor,8:floor,10:floor,16:floor,20:floor,25:floor,32:floor,40:floor,50:floor,80:floor,' +
      '100:on,160:on,200:on,400:on,800:on,1400:ceiling', scope8of32);
  const scope32 = optionSummary(SAMPLERATES_HZ, 32, SL32, true);
  check('SLogic32 scope at 32ch allows exactly the 100M-200M window',
    scope32 === '5:floor,8:floor,10:floor,16:floor,20:floor,25:floor,32:floor,40:floor,50:floor,80:floor,' +
      '100:on,160:on,200:on,400:ceiling,800:ceiling,1400:ceiling', scope32);
  const empty = scopeRateOptions(SAMPLERATES_HZ, 16, {}, true).length === 0 &&
    optionSummary(SAMPLERATES_HZ, 16, {}, false) === '5:on,8:on,10:on,16:on,20:on,25:on,32:on,40:on,50:on,80:on,' +
      '100:on,160:on,200:on';
  check('empty ceilings fall back to the 200M legacy ceiling and never list options when scoped',
    empty, `empty=${empty}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as
    { readFileSync(path: string, encoding: 'utf8'): string } | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const src = fs.readFileSync('src/ui/scopeRateLimits.ts', 'utf8');
  const imports = [...src.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);
  const allowed = ['../types.js', './channelBanks.js'];
  check('module imports only the shared width policy and its own layer',
    imports.length === allowed.length && allowed.every((edge) => imports.includes(edge)),
    `imports=${imports.join(',')}`);
  const foreign = [/\bdocument\b/, /\bwindow\b/, /\bHTMLElement\b/, /\blocalStorage\b/,
    /from '\.\/i18n\.js'/, /\bt\(/]
    .filter((needle) => needle.test(src)).map((needle) => String(needle));
  check('module is DOM- and i18n-free at the source level', foreign.length === 0,
    foreign.length === 0 ? 'no DOM/i18n tokens' : `found ${foreign.join(',')}`);
  const comments = src.split('\n').filter((line) => /^\s*(\/\/|\/\*)/.test(line));
  check('module carries no agent-authored comments beyond the SPDX header',
    comments.length === 1 && comments[0]!.trim() === '// SPDX-License-Identifier: GPL-3.0-or-later',
    `comment lines=${comments.length}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
