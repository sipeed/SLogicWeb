// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The banner's plain first sentence for non-overload failures (failureNotice.ts): which
 * failure key + diagnostic code maps to which notice, that connect failures and the host
 * overload abort are left alone, that every notice exists in all four locales with the
 * same placeholders, and that app.ts keeps the raw diagnostic under Technical details.
 * Pure apart from reading app.ts as text.
 */

import { DiagnosticError } from '../../diagnostics.js';
import { classifyFailureNotice, failureNoticeKey, type FailureNoticeKind } from '../failureNotice.js';
import { en } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as { readFileSync(p: string, e: 'utf8'): string };

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

{
  const cases: Array<[Parameters<typeof classifyFailureNotice>[0], unknown, FailureNoticeKind | null]> = [
    ['error.openCapture', new DiagnosticError('file.unsupported', { names: 'a.txt' }), 'fileType'],
    ['error.openCapture', new DiagnosticError('file.sr.notZip'), 'fileType'],
    ['error.openCapture', new DiagnosticError('file.lwcap.magic', { magic: 'x' }), 'fileType'],
    ['error.openCapture', new DiagnosticError('file.sr.analogChannels', { count: 2 }), 'fileUnsupported'],
    ['error.openCapture', new DiagnosticError('file.sr.tooLong', { samples: 1 }), 'fileTooLong'],
    ['error.openCapture', new DiagnosticError('file.sr.inflateFailed'), 'fileDamaged'],
    ['error.openCapture', new DiagnosticError('file.lwcap.header', { bytes: 1, need: 2 }), 'fileDamaged'],
    // The browser failing to read the file has no code; it is still a file that won't open.
    ['error.openCapture', new Error('NotReadableError'), 'fileDamaged'],
    ['error.decode', new DiagnosticError('decode.tooLong', { samples: 1, max: 1, window: '1 s' }), 'decodeTooLarge'],
    ['error.decode', new DiagnosticError('decode.timeout', { ms: 1 }), 'decodeTooLarge'],
    ['error.decode', new DiagnosticError('decode.workerFailed'), 'decodeFailed'],
    ['error.decode', new Error('boom'), 'decodeFailed'],
    ['error.decode', new DiagnosticError('decode.cancelled'), null],
    ['error.decodeWorkerWarmup', new Error('pyodide'), 'decodeUnavailable'],
    ['error.device', new DiagnosticError('device.noData', { device: 'x', deadline: 1, channels: 16, rate: 1 }), 'noData'],
    ['error.device', new DiagnosticError('device.transportDead', { reason: 'x' }), 'linkFailed'],
    ['error.device', new DiagnosticError('device.bulkStatus', { status: 'babble' }), 'linkFailed'],
    // The host-overload abort keeps its own notice and remedy (captureAbort.ts).
    ['error.device', new DiagnosticError('device.underrunStalled'), null],
    ['error.device', new DiagnosticError('device.disconnected', { device: 'x' }), null],
    // Connect failures are classified by connectFailure.ts, not here.
    ['error.connect', new DiagnosticError('device.claimFailed'), null],
    ['error.reconnect', new DiagnosticError('device.openFailed'), null],
    ['error.save', new DiagnosticError('io.nothingToSave'), null],
  ];
  const wrong = cases.filter(([what, e, want]) => classifyFailureNotice(what, e) !== want)
    .map(([what, e, want]) => `${what}/${(e as Error).message}: got ${classifyFailureNotice(what, e)}, want ${want}`);
  check('each failure key + diagnostic maps to its plain notice; overload/connect stay untouched',
    wrong.length === 0, wrong.length === 0 ? `${cases.length} cases` : wrong.join('; '));
}

{
  const kinds: FailureNoticeKind[] = [
    'fileType', 'fileUnsupported', 'fileTooLong', 'fileDamaged', 'decodeTooLarge', 'decodeFailed',
    'decodeUnavailable', 'noData', 'linkFailed',
  ];
  const placeholders = (text: string): string => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const problems: string[] = [];
  for (const kind of kinds) {
    const key = failureNoticeKey(kind);
    const want = placeholders(en[key]);
    for (const [locale, dict] of [['zh-CN', zhCN], ['fr', fr], ['ru', ru]] as const) {
      const text = dict[key];
      if (!text || text === en[key]) problems.push(`${locale}:${key} untranslated`);
      else if (placeholders(text) !== want) problems.push(`${locale}:${key} placeholders`);
    }
    // A plain first sentence: no diagnostic jargon in the lead.
    if (/DAC|bulk|transfer|worker|unitsize|zip|magic/i.test(en[key])) problems.push(`en:${key} jargon`);
  }
  check('every notice is translated in zh-CN/fr/ru with the same placeholders and no jargon',
    problems.length === 0, problems.length === 0 ? `${kinds.length} notices` : problems.join(', '));
}

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = app.indexOf('  private fail(');
  const body = app.slice(start, app.indexOf('\n  }\n', start));
  check('fail() attaches the classified notice unless one is given, keeping the diagnostic',
    body.includes('extra?.notice ? null : classifyFailureNotice(what, e)') &&
      body.includes('detail: statusDetailOf(e)') && body.includes('...notice, ...extra') &&
      app.includes("this.el.errorDetailText.textContent = err !== null && notice ? formatStatusError(err) : ''"),
    `fail() at ${start}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
