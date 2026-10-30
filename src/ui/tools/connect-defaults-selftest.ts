import { CONNECT_SAMPLERATE_32CH_HZ, connectSamplerate } from '../connectDefaults.js';
import { SAMPLERATES_HZ } from '../../device/index.js';

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
const ceiling200: Readonly<Record<number, number>> = { 32: 200e6 };
const ceiling50: Readonly<Record<number, number>> = { 32: 50e6 };
const ceiling16Only: Readonly<Record<number, number>> = { 16: 200e6 };

check('the 32-channel connect ceiling is 100 MHz and every decision reads it',
  CONNECT_SAMPLERATE_32CH_HZ === 100e6,
  `constant=${CONNECT_SAMPLERATE_32CH_HZ}`);

const nonExplicit = [16e6, 50e6, 200e6].map((current) => ({
  current,
  got: connectSamplerate({ current, explicit: false, channels: 32, ceilings: ceiling200 }),
}));
check('AC1: 32ch without an explicit choice lands on 100 MHz regardless of the saved rate',
  nonExplicit.every((row) => row.got === 100e6),
  nonExplicit.map((row) => `${row.current}→${row.got}`).join(', '));

const explicitTable = [
  { current: 16e6, expected: 16e6 },
  { current: 50e6, expected: 50e6 },
  { current: 100e6, expected: 100e6 },
  { current: 200e6, expected: 100e6 },
];
const explicitRows = explicitTable.map((row) => ({
  ...row,
  got: connectSamplerate({ current: row.current, explicit: true, channels: 32, ceilings: ceiling200 }),
}));
check('AC2: an explicit 32ch rate is capped at 100 MHz and kept below it',
  explicitRows.every((row) => row.got === row.expected),
  explicitRows.map((row) => `${row.current}→${row.got} (want ${row.expected})`).join(', '));

const cappedExplicit = connectSamplerate({ current: 200e6, explicit: true, channels: 32, ceilings: ceiling50 });
const cappedNonExplicit = connectSamplerate({ current: 200e6, explicit: false, channels: 32, ceilings: ceiling50 });
check('AC3: a lower 32ch ceiling wins over both the 100 MHz default and an explicit rate',
  cappedExplicit === 50e6 && cappedNonExplicit === 50e6,
  `explicit=${cappedExplicit}, non-explicit=${cappedNonExplicit}`);

const missingKey = connectSamplerate({ current: 16e6, explicit: false, channels: 32, ceilings: ceiling16Only });
const missingKeyExplicit = connectSamplerate({ current: 200e6, explicit: true, channels: 32, ceilings: ceiling16Only });
const fallbackPinned = source.includes('?? CONNECT_SAMPLERATE_32CH_HZ;');
check('a missing 32ch ceiling entry falls back to the 100 MHz default',
  missingKey === 100e6 && missingKeyExplicit === 100e6 && fallbackPinned,
  `non-explicit=${missingKey}, explicit=${missingKeyExplicit}, fallback=${fallbackPinned}`);

const otherWidths = [16, 8, 4, 64, 128].flatMap((channels) => [16e6, 200e6].map((current) => ({
  channels,
  current,
  got: connectSamplerate({ current, explicit: false, channels, ceilings: { [channels]: 200e6 } }),
})));
check('AC4: every non-32 width, including wider models, returns the current rate untouched',
  otherWidths.every((row) => row.got === row.current),
  otherWidths.map((row) => `${row.channels}ch ${row.current}→${row.got}`).join(', '));

const narrowed = connectSamplerate({ current: 400e6, explicit: true, channels: 16, ceilings: { 16: 200e6 } });
check('control: removing the non-32 short-circuit would clamp 16ch 400 MHz to the 200 MHz ceiling',
  narrowed === 400e6,
  `400e6@16ch→${narrowed}`);

const propertyTable = [
  { current: 16e6, explicit: false, ceilings: ceiling200 },
  { current: 50e6, explicit: false, ceilings: ceiling200 },
  { current: 200e6, explicit: false, ceilings: ceiling200 },
  { current: 16e6, explicit: true, ceilings: ceiling200 },
  { current: 50e6, explicit: true, ceilings: ceiling200 },
  { current: 100e6, explicit: true, ceilings: ceiling200 },
  { current: 200e6, explicit: true, ceilings: ceiling200 },
  { current: 200e6, explicit: true, ceilings: ceiling50 },
  { current: 200e6, explicit: false, ceilings: ceiling50 },
  { current: 16e6, explicit: false, ceilings: ceiling16Only },
];
const propertyRows = propertyTable.map((row) => {
  const got = connectSamplerate({ current: row.current, explicit: row.explicit, channels: 32, ceilings: row.ceilings });
  const ceiling = row.ceilings[32] ?? CONNECT_SAMPLERATE_32CH_HZ;
  return { ...row, got, ceiling, listed: SAMPLERATES_HZ.includes(got), bounded: got <= Math.min(100e6, ceiling) };
});
check('every 32ch decision stays inside SAMPLERATES_HZ and under min(100 MHz, ceiling)',
  propertyRows.every((row) => row.listed && row.bounded),
  propertyRows.map((row) => `${row.current}/${row.explicit}→${row.got} listed=${row.listed} bound=${row.bounded}`).join(', '));

const importFree = !/^import\s/m.test(source) && !/\bfrom '/.test(source);
const exported = source.includes('export const CONNECT_SAMPLERATE_32CH_HZ = 100e6;') &&
  source.includes('export interface ConnectRateInput {') &&
  source.includes('ceilings: Readonly<Record<number, number>>;') &&
  source.includes('export function connectSamplerate(input: ConnectRateInput): number {');
const commentFree = !source.includes('//') && !source.includes('/*');
check('the decision module is import-free, declares the designed contract shape and carries no comments',
  importFree && exported && commentFree,
  `importFree=${importFree}, exported=${exported}, commentFree=${commentFree}`);

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
].filter((needle) => decisionBlock.includes(needle));
const clampTakesDecision = clampBlock.includes('channels: width, samplerate');
const storeTakesDecision = adoptBody.includes('createSampleStore(max, samplerate)');
const persists = adoptBody.includes('this.persistWorkspace();');
const decisionBeforeClamp = decisionAt !== -1 && clampAt !== -1 && decisionAt < clampAt;
check('C4: adoptDeviceChannels feeds the connect decision into the store and the clamp before writing',
  wiredImport && decisionFields.length === 4 && clampTakesDecision && storeTakesDecision && persists &&
    decisionBeforeClamp,
  `import=${wiredImport}, fields=${decisionFields.length}/4, clamp=${clampTakesDecision}, ` +
    `store=${storeTakesDecision}, persist=${persists}, order=${decisionBeforeClamp}\n` +
    `decision=[${decisionBlock}]\nclamp=[${clampBlock}]\nbody=[${adoptBody}]`);

let failures = 0;
for (const result of results) {
  if (!result.pass) failures++;
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
if (failures) nodeProcess.exit(1);
