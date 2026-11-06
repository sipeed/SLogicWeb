// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The ADC module's declared hardware gain: one conversion (`analogVoltsPerCode`) used by
 * the display, the trigger level, the V/div scale and the workspace. The 1x scale is
 * profile data (1.6 V * 20 / 255 per code, 0 V at code 128; hardware team, 2026-11-06)
 * and a gain G divides it, so 3x reads ±5.33 V at 41.8 mV per code.
 */

import {
  ADC_LSB_V, ADC_MAX_CODE, ADC_ZERO_CODE, ANALOG_GAIN_MAX, ANALOG_GAIN_MIN, ANALOG_GAIN_PRESETS,
  ANALOG_MAX_HALF_RANGE_V, analogBusConfig, analogCodeFromVolts, analogDefaultVoltsPerDiv,
  analogGainOf, analogHalfRangeV, analogSpan, analogTriggerCode, analogTriggerVolts,
  analogVoltsFromCode, analogVoltsPerCode, analogVoltsPerDivValues, clampAnalogVolts,
  formatAnalogGain, isAnalogGain,
} from '../channelBanks.js';
import { busLabel, type BusViewConfig } from '../busView.js';
import {
  SCOPE_DIVISIONS_MIN, SCOPE_VDIV_VALUES, nextScopeVoltsPerDiv, scopeGeometry, scopeTickIndices,
} from '../scopeScale.js';
import { parseWorkspaceSnapshot, serializeWorkspaceSnapshot } from '../workspacePreferences.js';
import { defaultChannels } from '../state.js';
import { analogGainChoice, parseAnalogGain } from '../capturePanel.js';
import { SLOGIC32U3_PROFILE } from '../../device/index.js';
import { SoftwareTrigger } from '../../data/softwareTrigger.js';

interface FsLike { readFileSync(path: string, encoding: 'utf8'): string }

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
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;

const GAINS = [1, 2, 3, 5, 10, 0.1, 2.5, 100];
/** The profile's 1x scale, restated here only to check the derivation. */
const LSB = 1.6 * 20 / 255;

// ---- conversion ------------------------------------------------------------

for (const gain of GAINS) {
  let identity = true;
  let firstBad = -1;
  for (let code = 0; code <= 255; code++) {
    if (analogCodeFromVolts(analogVoltsFromCode(code, gain), gain) !== code) {
      identity = false;
      if (firstBad < 0) firstBad = code;
    }
  }
  const lo = analogVoltsFromCode(0, gain);
  const hi = analogVoltsFromCode(255, gain);
  const step = analogVoltsFromCode(129, gain) - analogVoltsFromCode(128, gain);
  const formula = near(analogVoltsFromCode(77, gain), (77 - 128) * LSB / gain) &&
    analogCodeFromVolts(1.7 / gain, gain) === Math.round(1.7 / LSB + 128);
  check(`G=${gain}: code->volts->code is the identity over 0..255, range -128..+127 LSB/G, step LSB/G`,
    identity && near(lo, -128 * LSB / gain) && near(hi, 127 * LSB / gain) &&
      near(step, LSB / gain) && near(analogVoltsPerCode(gain), LSB / gain) &&
      near(analogHalfRangeV(gain), 16 / gain) && analogVoltsFromCode(128, gain) === 0 && formula,
    `firstBad=${firstBad}, lo=${lo}, hi=${hi}, step=${step}, formula=${formula}`);
}

{
  const span = analogSpan(3);
  const g1 = analogSpan(1);
  const bad = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1000].map((g) => analogSpan(g));
  check('the profile fixes LSB, zero and top code; analogSpan divides by the gain, invalid reads 1x',
    near(ADC_LSB_V, LSB, 1e-15) && ADC_ZERO_CODE === 128 && ADC_MAX_CODE === 255 &&
      near(span.offsetV, -128 * LSB / 3) && near(span.fullScaleV, 32 / 3) &&
      near(g1.offsetV, -128 * LSB) && near(g1.fullScaleV, 32) &&
      bad.every((s) => s.offsetV === g1.offsetV && s.fullScaleV === g1.fullScaleV),
    JSON.stringify({ span, g1, bad }));
}

{
  const valid = [ANALOG_GAIN_MIN, 0.5, 1, 3, 10, ANALOG_GAIN_MAX].every(isAnalogGain);
  const invalid = [0, -3, 0.05, 101, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined]
    .every((g) => !isAnalogGain(g));
  const fallback = analogGainOf(undefined) === 1 && analogGainOf({}) === 1 &&
    analogGainOf({ analogGain: 0 }) === 1 && analogGainOf({ analogGain: 1e6 }) === 1 &&
    analogGainOf({ analogGain: 3 }) === 3;
  check('declarable gains are finite ratios inside the profile bounds; anything else reads 1x',
    valid && invalid && fallback && ANALOG_GAIN_MIN === 0.1 && ANALOG_GAIN_MAX === 100 &&
      near(ANALOG_MAX_HALF_RANGE_V, 160),
    `valid=${valid}, invalid=${invalid}, fallback=${fallback}, bounds=${ANALOG_GAIN_MIN}..${ANALOG_GAIN_MAX}`);
}

{
  const fromProfile = SLOGIC32U3_PROFILE.analog.groups[0]!.gains.join(',');
  check('the UI presets are the profile\'s AnalogGroup.gains, not a model branch',
    ANALOG_GAIN_PRESETS.join(',') === fromProfile && fromProfile === '1,2,5,10' &&
      formatAnalogGain(3) === '×3' && formatAnalogGain(0.5) === '×0.5' &&
      analogGainChoice(5) === '5' && analogGainChoice(3) === 'custom' &&
      parseAnalogGain(' 3 ') === 3 && parseAnalogGain('×2.5') === 2.5 && parseAnalogGain('3x') === 3 &&
      parseAnalogGain('0,5') === 0.5 && parseAnalogGain('0') === null &&
      parseAnalogGain('500') === null && parseAnalogGain('abc') === null && parseAnalogGain('') === null,
    `presets=${ANALOG_GAIN_PRESETS.join(',')}, profile=${fromProfile}`);
}

{
  const cfg = analogBusConfig(0, 16, '#123456', 3);
  const plain = analogBusConfig(8, 16, '#123456');
  const invalid = analogBusConfig(0, 8, '#123456', 0);
  const mid = busLabel(cfg, 128);
  check('an analog bus carries its gain and the derived span, so every reading shows true volts',
    cfg.analogGain === 3 && near(cfg.fullScaleV!, 32 / 3) && near(cfg.offsetV, -128 * LSB / 3) &&
      cfg.voltsPerDiv === 5 && busLabel(cfg, 255) === '5.312 V' && busLabel(cfg, 0) === '-5.354 V' &&
      Math.abs(Number.parseFloat(mid)) < 1e-9 &&
      plain.analogGain === 1 && near(plain.fullScaleV!, 32) && near(plain.offsetV, -128 * LSB) &&
      plain.voltsPerDiv === 10 && invalid.analogGain === 1 && near(invalid.fullScaleV!, 32),
    `cfg=${cfg.analogGain}:${cfg.offsetV}..${cfg.fullScaleV}@${cfg.voltsPerDiv}, ` +
      `labels=${busLabel(cfg, 0)}/${busLabel(cfg, 255)}, plain=${plain.analogGain}:${plain.fullScaleV}`);
}

// ---- trigger level -----------------------------------------------------------

{
  // 3x: +2.5 V -> round(2.5 * 3 / 0.12549 + 128) = round(187.77) = 188.
  const code = analogCodeFromVolts(2.5, 3);
  const level = analogTriggerVolts('rising', 2.5, 3);
  const atOneX = analogCodeFromVolts(2.5, 1);
  check('a configured level selects its code through the gain (3x: +2.5 V -> 188)',
    code === 188 && near(level, Number(analogVoltsFromCode(188, 3).toFixed(4))) &&
      analogCodeFromVolts(level, 3) === 188 && atOneX === 148 &&
      analogTriggerCode('rising', 2.5, 3) === 188,
    `code=${code}, level=${level}, at1x=${atOneX}`);
}

{
  const clampedHigh = clampAnalogVolts(9, 3);
  const clampedLow = clampAnalogVolts(-9, 3);
  const rising = analogTriggerVolts('rising', -99, 3);
  const falling = analogTriggerVolts('falling', 99, 3);
  const tenX = analogTriggerVolts('falling', 10, 10);
  check('levels clamp to the codes the gain reads and the unreachable endpoints move one code inward',
    near(clampedHigh, 127 * LSB / 3) && near(clampedLow, -128 * LSB / 3) &&
      analogCodeFromVolts(rising, 3) === 1 && analogCodeFromVolts(falling, 3) === 254 &&
      tenX === 1.5812 && analogCodeFromVolts(9, 3) === 255 && analogCodeFromVolts(-9, 3) === 0,
    `clamp=${clampedLow}..${clampedHigh}, rising=${rising}, falling=${falling}, tenX=${tenX}`);
}

{
  // The keyboard nudge is one code at the group's gain: a snapped level moves by exactly
  // one code per press (Shift: 1 V / G, about 8 codes).
  let ok = true;
  const trace: string[] = [];
  for (const gain of [1, 3, 10]) {
    const step = analogVoltsPerCode(gain);
    let volts = analogTriggerVolts('rising', 0.3 / gain, gain);
    const start = analogCodeFromVolts(volts, gain);
    for (let press = 1; press <= 5; press++) {
      volts = analogTriggerVolts('rising', volts + step, gain);
      if (analogCodeFromVolts(volts, gain) !== start + press) ok = false;
    }
    const shift = analogCodeFromVolts(analogTriggerVolts('rising', volts + 1 / gain, gain), gain) -
      analogCodeFromVolts(volts, gain);
    if (shift < 7 || shift > 9) ok = false;
    trace.push(`G${gain}:${start}->${analogCodeFromVolts(volts, gain)} shift=${shift}`);
  }
  check('the level nudge steps one converter code at every gain', ok, trace.join(', '));
}

{
  // A gain change keeps the user's volts and recomputes the code, clamped to the new
  // range (`clampCaptureSettings` re-snaps through analogTriggerVolts).
  const at1 = analogTriggerVolts('rising', 1.2, 1);
  const at3 = analogTriggerVolts('rising', at1, 3);
  const keeps = Math.abs(at3 - at1) <= analogVoltsPerCode(3) / 2 + 1e-4;
  const codeAt3 = analogCodeFromVolts(at3, 3);
  const at2p5 = analogTriggerVolts('rising', at1, 2.5);
  const high = analogTriggerVolts('rising', 10, 1);
  const highAt10 = analogTriggerVolts('rising', high, 10);
  const back = analogTriggerVolts('rising', highAt10, 1);
  check('a gain change keeps a level\'s volts, recomputes its code and clamps it into the new range',
    // 1.2549 V is code 138 at 1x and exactly code 158 at 3x (ten 1x codes are thirty 3x
    // codes): the volts stay equal while the code changes, which is why the app retunes
    // on every gain change of a group with a level rather than on a volts change.
    keeps && codeAt3 === analogCodeFromVolts(at1, 3) && codeAt3 === 158 &&
      analogCodeFromVolts(at1, 1) === 138 && at3 === at1 &&
      Math.abs(at2p5 - at1) <= analogVoltsPerCode(2.5) / 2 + 1e-4 &&
      highAt10 === 1.5937 && Math.abs(back - 1.5937) < analogVoltsPerCode(1),
    `at1=${at1}, at3=${at3}, code3=${codeAt3}, high=${high}->${highAt10}->${back}`);
}

// ---- V/div and ruler -----------------------------------------------------------

{
  const want: Record<string, number> = { 1: 10, 2: 5, 3: 5, 5: 2, 10: 1, 0.1: 100, 100: 0.1, 2.5: 5 };
  const lists: string[] = [];
  let ok = true;
  for (const gain of GAINS) {
    const vdiv = analogDefaultVoltsPerDiv(gain);
    const half = analogHalfRangeV(gain);
    const values = analogVoltsPerDivValues(gain);
    const finer = SCOPE_VDIV_VALUES.filter((v) => v < vdiv).pop();
    // Four divisions centred on 0 V show the whole range; the next finer step would not.
    const shows = vdiv * SCOPE_DIVISIONS_MIN / 2 >= half - 1e-9 &&
      (finer === undefined || finer * SCOPE_DIVISIONS_MIN / 2 < half);
    const g = scopeGeometry(0, 120, vdiv, 0.5);
    const ticks = scopeTickIndices(g, vdiv);
    const inBand = g.yVolts(half) >= 0 && g.yVolts(-half) <= 120;
    if (vdiv !== want[String(gain)] || !shows || !values.includes(vdiv) ||
        ticks.join(',') !== '-2,-1,0,1,2' || !inBand) ok = false;
    lists.push(`G${gain}:${vdiv}[${values[0]}..${values[values.length - 1]}]`);
  }
  const oneX = analogVoltsPerDivValues(1).join(',') === '0.5,1,2,5,10,20';
  const tenX = analogVoltsPerDivValues(10).join(',') === '0.05,0.1,0.2,0.5,1,2';
  const walk = nextScopeVoltsPerDiv(1, -1, analogVoltsPerDivValues(10)) === 0.5 &&
    nextScopeVoltsPerDiv(0.05, -1, analogVoltsPerDivValues(10)) === 0.05 &&
    nextScopeVoltsPerDiv(2, 1, analogVoltsPerDivValues(10)) === 2 &&
    nextScopeVoltsPerDiv(1, -1) === 0.5 && nextScopeVoltsPerDiv(0.5, -1, analogVoltsPerDivValues(1)) === 0.5;
  check('each gain defaults to the finest 1-2-5 V/div that shows its range, with a consistent ruler',
    ok && oneX && tenX && walk, `${lists.join(' ')}, 1x=${oneX}, 10x=${tenX}, walk=${walk}`);
}

// ---- workspace -------------------------------------------------------------------

function roundTrip(views: unknown[], analogTriggers?: Record<string, unknown>): ReturnType<typeof parseWorkspaceSnapshot> {
  const base = JSON.parse(serializeWorkspaceSnapshot({
    version: 1, detailedLabels: true, channels: defaultChannels(16),
  })) as Record<string, unknown>;
  base.busViews = views;
  if (analogTriggers) {
    base.capture = { ...(base.capture as object | undefined), analogTriggers, triggerSource: 'analog' };
  }
  return parseWorkspaceSnapshot(JSON.stringify(base));
}

{
  const withGain = JSON.parse(JSON.stringify(analogBusConfig(0, 16, '#112233', 3))) as Record<string, unknown>;
  const legacy = JSON.parse(JSON.stringify(analogBusConfig(8, 16, '#112233'))) as Record<string, unknown>;
  delete legacy.analogGain;
  const parsed = roundTrip([withGain, legacy]);
  const a0 = parsed?.busViews?.[0] as BusViewConfig | undefined;
  const a1 = parsed?.busViews?.[1] as BusViewConfig | undefined;
  // A hand-edited span cannot disagree with the saved gain.
  const tampered = roundTrip([{ ...withGain, fullScaleV: 30, offsetV: -15 }]);
  const t0 = tampered?.busViews?.[0];
  // A pre-marker save (A0 name, the old ±15 V span) still migrates, onto today's scale.
  const old = { ...legacy, name: 'A0', fullScaleV: 30, offsetV: -15, spec: withGain.spec };
  delete (old as Record<string, unknown>).analogGroup;
  const migrated = roundTrip([old])?.busViews?.[0];
  check('workspace: a saved gain round-trips with its span; a missing gain (older saves) is 1x',
    a0?.analogGain === 3 && near(a0.fullScaleV!, 32 / 3) && near(a0.offsetV, -128 * LSB / 3) &&
      a1 !== undefined && a1.analogGain === undefined && analogGainOf(a1) === 1 &&
      near(a1.fullScaleV!, 32) && t0?.analogGain === 3 && near(t0.fullScaleV!, 32 / 3) &&
      migrated?.analogGroup === 0 && near(migrated.fullScaleV!, 32) && near(migrated.offsetV, -128 * LSB),
    JSON.stringify({ a0, a1, t0, migrated }));
}

{
  const ok = JSON.parse(JSON.stringify(analogBusConfig(0, 16, '#112233', 3))) as Record<string, unknown>;
  const rejected = [0, -2, 1000, 'x', null, Number.NaN].map((analogGain) =>
    roundTrip([{ ...ok, analogGain }])?.busViews?.length ?? -1);
  check('workspace: an invalid saved gain is rejected, not coerced',
    rejected.every((count) => count === 0), `kept=${rejected.join(',')}`);
}

{
  const cfg = JSON.parse(JSON.stringify(analogBusConfig(0, 16, '#112233', 0.1))) as Record<string, unknown>;
  const parsed = roundTrip([cfg], {
    0: { kind: 'rising', volts: 100 }, 8: { kind: 'falling', volts: -999 },
  });
  const triggers = parsed?.capture?.analogTriggers ?? {};
  check('workspace: a stored level is kept in volts up to the widest declarable range (±160 V)',
    triggers['0']?.volts === 100 && near(triggers['8']?.volts ?? 0, -160),
    JSON.stringify(triggers));
}

// ---- wiring (source pins) --------------------------------------------------------

{
  const fs = (nodeProcess.getBuiltinModule?.('node:fs') ?? null) as FsLike | null;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const list = fs.readFileSync('src/ui/channelList.ts', 'utf8');
  const start = app.indexOf('  private configureAnalogGain(');
  const end = app.indexOf('\n  }\n', start);
  const body = start >= 0 && end > start ? app.slice(start, end) : '';
  const gainPath = body.includes('this.clampSettings(this.settings)') &&
    body.includes("if (after !== undefined && this.settings.triggerSource === 'analog') this.syncActiveTrigger();") &&
    body.includes('this.analogLevelClamped = before !== undefined && after !== undefined &&') &&
    body.includes('...analogSpan(gain), voltsPerDiv: this.scopeDefaultVoltsPerDiv(bus, gain)') &&
    !body.includes('restartCapture') && !body.includes('stopCapture') &&
    !body.includes('this.device') && !body.includes('applySettings') &&
    !body.includes('clearTriggerSample');
  const triggerPath = app.includes('volts: analogTriggerVolts(value.kind, clampAnalogVolts(volts, gain), gain),') &&
    app.includes('volts: analogTriggerVolts(kind, clampAnalogVolts(volts, gain), gain),') &&
    app.includes('last = clampAnalogVolts(scopeVoltsAtY(atY, top, band, perDiv, zeroPosition), gain);') &&
    app.includes('const step = event.shiftKey ? 1 / gain : analogVoltsPerCode(gain);') &&
    app.includes('level: analogCodeFromVolts(trigger.volts, trigger.gain)') &&
    app.includes('level: analogCodeFromVolts(analogStart.volts, analogStart.gain)') &&
    app.includes('level: analogCodeFromVolts(a.volts, a.gain)') &&
    !app.includes('Math.max(-15, Math.min(15') && !app.includes('ADC_FULL_SCALE_V');
  const ui = app.includes('onAnalogGain: (start, gain) => this.configureAnalogGain(start, gain),') &&
    panel.includes('this.cb.onAnalogGain(start, next)') &&
    panel.includes("t('capturePanel.analogGainHelp')") &&
    list.includes("t('channels.analogGainSub', {") && list.includes('level.max = String(half);');
  check('a gain change is conversion only: re-snapped through the settings clamp, retuned live, never restarted',
    gainPath && triggerPath && ui, `gainPath=${gainPath}, triggerPath=${triggerPath}, ui=${ui}`);
}

// End to end: a level declared in volts at a gain reaches the matcher as the code the
// gain selects, and fires (or not) on raw ADC bytes exactly at that code.
{
  // The module wires its bus MSB first: input 0 of the group carries the code's MSB.
  const raw = (code: number): number => {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((code >> bit) & 1);
    return reversed;
  };
  const run = (codes: number[], kind: 'rising' | 'falling', volts: number, gain: number) => {
    const level = analogCodeFromVolts(analogTriggerVolts(kind, volts, gain), gain);
    const out: number[] = [];
    const trigger = new SoftwareTrigger({
      config: {
        channels: 8, conditions: [], analog: [{ start: 0, kind, level }],
        preTriggerSamples: 0, maxSamples: 2, searchLimitSamples: codes.length,
      },
      emit: (chunk) => out.push(...chunk),
    });
    trigger.feed(Uint8Array.from(codes.map(raw)));
    trigger.finish();
    // No pre-trigger, so the first emitted sample is the one that matched.
    return { level, stats: trigger.stats, first: out.length > 0 ? raw(out[0]!) : null };
  };
  const rising = run([170, 180, 187, 188, 200], 'rising', 2.5, 3);
  const falling = run([210, 200, 189, 188, 150], 'falling', 2.5, 3);
  const none = run([170, 180, 187, 186, 150], 'rising', 2.5, 3);
  const oneX = run([140, 145, 150, 160], 'rising', 2.5, 1);
  check('3x +2.5 V arms the matcher on code 188: rising, falling and no trigger',
    rising.level === 188 && rising.stats.matched && rising.first === 188 &&
    falling.level === 188 && falling.stats.matched && falling.first === 188 &&
    none.stats.noTrigger && !none.stats.matched &&
    oneX.level === 148 && oneX.stats.matched && oneX.first === 150,
    `rising=${rising.level}@${rising.first}, falling=${falling.level}@${falling.first}, ` +
    `none=${none.stats.noTrigger}, 1x=${oneX.level}@${oneX.first}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
