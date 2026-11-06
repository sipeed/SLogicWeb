import { rateAdvice } from '../rateAdvice.js';
import { analogSamplerates } from '../channelBanks.js';
import {
  SAMPLERATES_HZ, SLOGIC16U3_PROFILE, SLOGIC32U3_PROFILE, recommendedSamplerateHzFor,
} from '../../device/index.js';
import { maxSamplerateHzForProfile } from '../../device/slogic16u3.js';
import { en } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

const nodeProcess = (() => {
  const process = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!process || typeof process.exit !== 'function') throw new Error('this entry point only runs under node');
  return process;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const advice32 = recommendedSamplerateHzFor(SLOGIC32U3_PROFILE, null);
const advice16 = recommendedSamplerateHzFor(SLOGIC16U3_PROFILE, null);
const ceilings32 = maxSamplerateHzForProfile(SLOGIC32U3_PROFILE);
/** The analog floor the capture panel derives for a width: the ADC-legal rates below its ceiling. */
function analogMin(channels: number): number {
  const allowed = analogSamplerates(SAMPLERATES_HZ.filter((hz) => hz <= (ceilings32[channels] ?? 0)));
  return Math.min(...allowed);
}

// Rate at or below the recommendation: no warning, analog or not.
const quiet = [
  rateAdvice({ channels: 32, samplerate: 50e6, recommended: advice32 }),
  rateAdvice({ channels: 32, samplerate: 16e6, recommended: advice32 }),
  rateAdvice({ channels: 16, samplerate: 100e6, recommended: advice32, analogMinHz: analogMin(16) }),
  rateAdvice({ channels: 8, samplerate: 200e6, recommended: advice32 }),
  rateAdvice({ channels: 4, samplerate: 400e6, recommended: advice16 }),
];
check('a rate at or below the recommendation gives no warning',
  quiet.every((advice) => advice === null), JSON.stringify(quiet));

// User-chosen rate above the recommendation, every width of both profiles.
const above = [
  { channels: 32, samplerate: 100e6, advice: advice32, advised: 50e6 },
  { channels: 32, samplerate: 80e6, advice: advice32, advised: 50e6 },
  { channels: 16, samplerate: 200e6, advice: advice32, advised: 100e6 },
  { channels: 16, samplerate: 160e6, advice: advice16, advised: 100e6 },
  { channels: 8, samplerate: 400e6, advice: advice32, advised: 200e6 },
  { channels: 4, samplerate: 800e6, advice: advice16, advised: 400e6 },
].map((row) => ({
  ...row,
  got: rateAdvice({ channels: row.channels, samplerate: row.samplerate, recommended: row.advice }),
}));
check('a rate above the recommendation warns with the generic key and the advised rate',
  above.every((row) => row.got?.key === 'capturePanel.rateAboveAdvised' && row.got.advised === row.advised),
  above.map((row) => `${row.channels}ch@${row.samplerate}→${JSON.stringify(row.got)}`).join(', '));

// The analog-forced case: 32 ch with an analog group cannot go below 100 MS/s.
const forced = rateAdvice({
  channels: 32, samplerate: 100e6, recommended: advice32, analogMinHz: analogMin(32),
});
check('32 ch + analog at the ADC minimum says the analog input forced the rate',
  analogMin(32) === 100e6 && forced?.key === 'capturePanel.rateAnalogForced' &&
    forced.advised === 50e6 && forced.analogMinHz === 100e6,
  `min=${analogMin(32)} got=${JSON.stringify(forced)}`);

// Above the analog floor by the user's choice, the warning is the generic one.
const chosen = rateAdvice({
  channels: 32, samplerate: 200e6, recommended: advice32, analogMinHz: analogMin(32),
});
check('32 ch + analog above the ADC minimum is the user\'s choice, not analog-forced',
  chosen?.key === 'capturePanel.rateAboveAdvised', JSON.stringify(chosen));

// No recommendation for the width (ss10-only tiers, wider models): never warns.
const unadvised = [64, 128].map((channels) =>
  rateAdvice({ channels, samplerate: 1e9, recommended: advice32, analogMinHz: 100e6 }));
const emptyAdvice = rateAdvice({ channels: 32, samplerate: 200e6, recommended: {} });
check('a width without a recommendation never warns',
  unadvised.every((advice) => advice === null) && emptyAdvice === null,
  JSON.stringify([...unadvised, emptyAdvice]));

// Copy: every locale has both keys with the placeholders the panel fills.
const locales = { en, zhCN, fr, ru } as Record<string, Record<string, string>>;
const placeholders = {
  'capturePanel.rateAboveAdvised': ['{channels}', '{rate}', '{advised}'],
  'capturePanel.rateAnalogForced': ['{channels}', '{rate}', '{advised}', '{min}'],
};
const copyProblems = Object.entries(locales).flatMap(([name, table]) =>
  Object.entries(placeholders).flatMap(([key, needed]) => {
    const text = table[key];
    if (typeof text !== 'string') return [`${name}:${key} missing`];
    return needed.filter((p) => !text.includes(p)).map((p) => `${name}:${key} lacks ${p}`);
  }));
check('both warnings exist in every locale with their placeholders',
  copyProblems.length === 0, copyProblems.join(', ') || 'complete');

const source = fs.readFileSync('src/ui/rateAdvice.ts', 'utf8');
const pure = !/^import\s/m.test(source) && !/16U3|32U3|slogic/i.test(source.replace(/\/\*[\s\S]*?\*\//g, ''));
const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const wired = panel.includes('rateAdvice({') && panel.includes("div('panel-note warning')") &&
  panel.includes('recommended: v.recommendedSamplerateHz ?? {}');
check('the decision is import-free and model-free, and the capture panel renders it',
  pure && wired, `pure=${pure}, wired=${wired}`);

let failures = 0;
for (const result of results) {
  if (!result.pass) failures++;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
if (failures) nodeProcess.exit(1);
