import { connectSamplerate } from '../connectDefaults.js';
import {
  SAMPLERATES_HZ, SLOGIC16U3_PROFILE, SLOGIC32U3_PROFILE, recommendedSamplerateHzFor,
} from '../../device/index.js';
import { maxSamplerateHzForProfile } from '../../device/slogic16u3.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
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

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const source = fs.readFileSync('src/ui/connectDefaults.ts', 'utf8');
// The shipped 32U3 numbers: the native 200 MHz ceiling (the link class is unknown) and
// the profile's ss5 recommendations (200 MB/s per width: 4/8/16/32 ch = 400/200/100/50 MHz).
const ceilings32 = maxSamplerateHzForProfile(SLOGIC32U3_PROFILE);
const advice32 = recommendedSamplerateHzFor(SLOGIC32U3_PROFILE, null);
const advice16 = recommendedSamplerateHzFor(SLOGIC16U3_PROFILE, null);
const ceiling50: Readonly<Record<number, number>> = { 32: 50e6 };
const ceiling40: Readonly<Record<number, number>> = { 32: 40e6 };
const ceiling16Only: Readonly<Record<number, number>> = { 16: 200e6 };

check('the U3 profiles supply the connect defaults: 32U3 200 MHz ceiling, 50 MHz recommended at 32ch',
  ceilings32[32] === 200e6 && advice32[32] === 50e6 && advice32[16] === 100e6 &&
    advice32[8] === 200e6 && advice32[4] === 400e6 &&
    JSON.stringify(advice16) === JSON.stringify({ 4: 400e6, 8: 200e6, 16: 100e6 }),
  `ceilings=${JSON.stringify(ceilings32)}, 32U3=${JSON.stringify(advice32)}, 16U3=${JSON.stringify(advice16)}`);

const nonExplicit = [16e6, 50e6, 100e6, 200e6].map((current) => ({
  current,
  got: connectSamplerate({
    current, explicit: false, channels: 32, ceilings: ceilings32, recommended: advice32,
  }),
}));
check('H1: a fresh 32ch connection lands on the recommended 50 MHz regardless of the saved rate',
  nonExplicit.every((row) => row.got === 50e6),
  nonExplicit.map((row) => `${row.current}→${row.got}`).join(', '));

const explicitTable = [
  { current: 16e6, expected: 16e6 },
  { current: 50e6, expected: 50e6 },
  { current: 100e6, expected: 100e6 },
  { current: 200e6, expected: 200e6 },
];
const explicitRows = explicitTable.map((row) => ({
  ...row,
  got: connectSamplerate({
    current: row.current, explicit: true, channels: 32, ceilings: ceilings32, recommended: advice32,
  }),
}));
check('an explicit 32ch rate is honoured up to the ceiling, above the recommendation too',
  explicitRows.every((row) => row.got === row.expected),
  explicitRows.map((row) => `${row.current}→${row.got} (want ${row.expected})`).join(', '));

const cappedExplicit = connectSamplerate({
  current: 200e6, explicit: true, channels: 32, ceilings: ceiling50, recommended: advice32,
});
const cappedNonExplicit = connectSamplerate({
  current: 200e6, explicit: false, channels: 32, ceilings: ceiling40, recommended: advice32,
});
check('a ceiling below the request wins over an explicit rate and over the recommendation',
  cappedExplicit === 50e6 && cappedNonExplicit === 40e6,
  `explicit=${cappedExplicit}, non-explicit=${cappedNonExplicit}`);

const missingKey = connectSamplerate({
  current: 16e6, explicit: false, channels: 32, ceilings: ceiling16Only, recommended: advice32,
});
check('a missing ceiling entry still takes the recommendation',
  missingKey === 50e6, `non-explicit=${missingKey}`);

const otherWidths = [64, 128].flatMap((channels) => [16e6, 200e6].flatMap((current) =>
  [false, true].map((explicit) => ({
    channels,
    current,
    explicit,
    got: connectSamplerate({
      current, explicit, channels, ceilings: { [channels]: 100e6 }, recommended: advice32,
    }),
  }))));
check('a width without a recommendation, including wider models, keeps the current rate',
  otherWidths.every((row) => row.got === row.current),
  otherWidths.map((row) => `${row.channels}ch ${row.current}/${row.explicit}→${row.got}`).join(', '));

const sixteen = [false, true].map((explicit) => connectSamplerate({
  current: 200e6, explicit, channels: 16, ceilings: maxSamplerateHzForProfile(SLOGIC16U3_PROFILE),
  recommended: advice16,
}));
check('a fresh 16U3 16ch connection lands on 100 MHz; an explicit 200 MHz is honoured',
  sixteen[0] === 100e6 && sixteen[1] === 200e6, sixteen.join(', '));

const propertyRows = [16e6, 50e6, 100e6, 200e6].flatMap((current) => [false, true].flatMap((explicit) =>
  [ceilings32, ceiling50, ceiling40].map((ceilings) => {
    const got = connectSamplerate({ current, explicit, channels: 32, ceilings, recommended: advice32 });
    const ceiling = ceilings[32]!;
    const bounded = got <= ceiling && (explicit || got <= advice32[32]!);
    return { current, explicit, ceiling, got, listed: SAMPLERATES_HZ.includes(got), bounded };
  })));
check('every 32ch decision is an offered rate, under the ceiling, and under the advice unless chosen',
  propertyRows.every((row) => row.listed && row.bounded),
  propertyRows.filter((row) => !row.listed || !row.bounded)
    .map((row) => `${row.current}/${row.explicit}/${row.ceiling}→${row.got}`).join(', ') || 'all bounded');

const importFree = !/^import\s/m.test(source) && !/\bfrom '/.test(source);
const modelFree = !/32|16U3|32U3|slogic/i.test(source);
const exported = source.includes('export interface ConnectRateInput {') &&
  source.includes('recommended: Readonly<Record<number, number>>;') &&
  source.includes('export function connectSamplerate(input: ConnectRateInput): number {');
check('the decision module is import-free, names no width or model, and declares the contract',
  importFree && modelFree && exported,
  `importFree=${importFree}, modelFree=${modelFree}, exported=${exported}`);

const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
const adoptStart = appSource.indexOf('private adoptDeviceChannels(device: Device): void {');
const adoptEnd = adoptStart === -1 ? -1 : appSource.indexOf('\n  private async startCapture', adoptStart);
const adoptBody = adoptStart === -1 || adoptEnd === -1 ? '' : appSource.slice(adoptStart, adoptEnd);
const decisionAt = adoptBody.indexOf('connectSamplerate({');
const decisionEnd = decisionAt === -1 ? -1 : adoptBody.indexOf('});', decisionAt);
const decisionBlock = decisionAt === -1 || decisionEnd === -1 ? '' : adoptBody.slice(decisionAt, decisionEnd);
const clampAt = adoptBody.indexOf('clampSettings(');
const clampEnd = clampAt === -1 ? -1 : adoptBody.indexOf(');', clampAt);
const clampBlock = clampAt === -1 || clampEnd === -1 ? '' : adoptBody.slice(clampAt, clampEnd);
const wiredImport = appSource.includes("import { connectSamplerate } from './connectDefaults.js';");
const decisionFields = [
  'current: this.settings.samplerate,',
  'explicit: this.samplerateExplicit,',
  'channels: width,',
  'ceilings: this.rateCeilings,',
  'recommended: this.rateRecommendations,',
].filter((needle) => decisionBlock.includes(needle));
const clampTakesDecision = clampBlock.includes('channels: width, samplerate');
const storeTakesDecision = adoptBody.includes('createSampleStore(max, samplerate)');
const persists = adoptBody.includes('this.persistWorkspace();');
const adoptsAdvice = adoptBody.includes('this.rateRecommendations = device.recommendedSamplerateHz ?? {};');
const decisionBeforeClamp = decisionAt !== -1 && clampAt !== -1 && decisionAt < clampAt;
check('C4: adoptDeviceChannels feeds the connect decision into the store and the clamp before writing',
  wiredImport && adoptsAdvice && decisionFields.length === 5 && clampTakesDecision && storeTakesDecision && persists &&
    decisionBeforeClamp,
  `import=${wiredImport}, advice=${adoptsAdvice}, fields=${decisionFields.length}/5, clamp=${clampTakesDecision}, ` +
    `store=${storeTakesDecision}, persist=${persists}, order=${decisionBeforeClamp}\n` +
    `decision=[${decisionBlock}]\nclamp=[${clampBlock}]\nbody=[${adoptBody}]`);

let failures = 0;
for (const result of results) {
  if (!result.pass) failures++;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
if (failures) nodeProcess.exit(1);
