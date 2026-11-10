// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The aborted-capture model: which failures count as a host overload, the banner
 * remedy's rate, and the panel's "requested / actual" line in two locales. Pure; no DOM,
 * no device.
 */

import { DiagnosticError } from '../../diagnostics.js';
import { SAMPLERATES_HZ, SLOGIC32U3_PROFILE, recommendedSamplerateHzFor } from '../../device/index.js';
import {
  captureAbortCause, captureAbortDetail, lowerSamplerate, type CaptureAbort,
} from '../captureAbort.js';
import { setLocale } from '../i18n.js';

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

{
  // The wire form the worker transport rebuilds is a DiagnosticError too, so the code is
  // the only thing classification may read.
  const rows: [string, unknown, string][] = [
    ['underrunStalled', new DiagnosticError('device.underrunStalled', { channels: 32 }), 'hostOverload'],
    ['underrunClean', new DiagnosticError('device.underrunClean', { channels: 32 }), 'hostOverload'],
    ['disconnected', new DiagnosticError('device.disconnected', { device: 'x' }), 'disconnected'],
    ['bulkStatus', new DiagnosticError('device.bulkStatus', { status: 'stall' }), 'device'],
    ['plain error', new Error('device.underrunStalled'), 'device'],
    ['string', 'boom', 'device'],
  ];
  const got = rows.map(([name, error, want]) => ({ name, want, got: captureAbortCause(error) }));
  check('only the transport overload codes classify as a host overload',
    got.every((row) => row.got === row.want),
    got.map((row) => `${row.name}→${row.got}`).join(', '));
}

{
  const offered32 = SAMPLERATES_HZ.filter((hz) => hz <= 200e6);
  const advice = recommendedSamplerateHzFor(SLOGIC32U3_PROFILE, null)[32];
  const at = (samplerate: number, cause: CaptureAbort['cause'] = 'hostOverload'): CaptureAbort =>
    ({ cause, requestedSeconds: 1, channels: 32, samplerate });
  const rows: [string, number | null, number | null][] = [
    // The reported case: 32ch @ 100 MHz aborts; one click goes to the measured-clean 50 MHz.
    ['100M above the advice', lowerSamplerate(at(100e6), offered32, advice), 50e6],
    ['200M above the advice', lowerSamplerate(at(200e6), offered32, advice), 50e6],
    // At or below the advice, the remedy is one offered step down.
    ['50M at the advice', lowerSamplerate(at(50e6), offered32, advice), 40e6],
    ['16M with no advice', lowerSamplerate(at(16e6), offered32), 10e6],
    ['100M with no advice', lowerSamplerate(at(100e6), offered32), 80e6],
    ['lowest rate', lowerSamplerate(at(offered32[0]!), offered32, advice), null],
    ['advice not offered', lowerSamplerate(at(100e6), [10e6, 80e6, 100e6], 50e6), 80e6],
    ['disconnect has no rate remedy', lowerSamplerate(at(100e6, 'disconnected'), offered32, advice), null],
    ['device error has no rate remedy', lowerSamplerate(at(100e6, 'device'), offered32, advice), null],
  ];
  check('the banner remedy moves to the advice first, then one offered step down',
    advice === 50e6 && rows.every(([, got, want]) => got === want),
    rows.map(([name, got, want]) => `${name}: ${got}${got === want ? '' : ` (want ${want})`}`).join(', '));
}

{
  // The reported capture: 1 s requested, 10,952,704 samples at 100 MHz arrived.
  const result = { samples: 10_952_704, seconds: 10_952_704 / 100e6 };
  const finite = { cause: 'hostOverload' as const, requestedSeconds: 1 };
  const open = { cause: 'disconnected' as const, requestedSeconds: null };
  const en = captureAbortDetail(finite, result);
  const enOpen = captureAbortDetail(open, result);
  await setLocale('zh-CN');
  const zh = captureAbortDetail(finite, result);
  await setLocale('en');
  check('the aborted status names the cause and compares requested with actual',
    en.startsWith('Host overload') && en.includes('requested 1.000 s') &&
      en.includes('actual 109.5 ms') && en.includes('10,952,704') &&
      zh.startsWith('主机过载') && zh.includes('请求 1.000 s') && zh.includes('实际 109.5 ms'),
    `en=${en} | zh=${zh}`);
  check('a Loop abort reports only what arrived',
    enOpen.startsWith('Device disconnected') && !enOpen.includes('requested') &&
      enOpen.includes('actual 109.5 ms'),
    enOpen);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
