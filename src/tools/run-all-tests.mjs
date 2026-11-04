#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Aggregate offline test entry point: type-check, then bundle and run every self-test
 * that does not need the real device.
 *
 *   npm test
 *   npm test -- --filter trigger     # only entries whose path contains "trigger"
 *
 * The hardware suites (src/device/selftest.ts, src/device/selftestPlan.ts) are not run:
 * they need a SLogic board attached, and the offline tests already cover the encoder,
 * parser and capture-state paths they would otherwise duplicate.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const ESBUILD = join(ROOT, 'node_modules/.bin/esbuild');
const TSC = join(ROOT, 'node_modules/.bin/tsc');

const filterArg = process.argv.indexOf('--filter');
const filter = filterArg >= 0 ? process.argv[filterArg + 1] ?? '' : '';

const entries = [
  'src/data/bench/runtests.ts',
  'src/device/offline-test.ts',
  'src/device/emulationPatternTest.ts',
  ...spawnSync('sh', ['-c', `ls ${ROOT}src/ui/tools/*-selftest.ts`], { encoding: 'utf8' })
    .stdout.trim().split('\n')
    .filter(Boolean)
    .map((p) => p.slice(ROOT.length)),
];

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { label, pass: result.status === 0, out };
}

const selected = entries.filter((entry) => entry.includes(filter));
if (selected.length === 0) {
  console.error(`no test entry matches "${filter}"`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'logicweb-test-'));
const failures = [];
let passed = 0;

try {
  const typecheck = run('type-check', TSC, ['--noEmit']);
  if (typecheck.pass) {
    passed++;
    console.log('PASS  type-check');
  } else {
    failures.push(typecheck);
    console.log('FAIL  type-check\n' + typecheck.out.split('\n').slice(0, 20).join('\n'));
  }

  for (const entry of selected) {
    const bundle = join(scratch, entry.replace(/[\\/]/g, '_').replace(/\.ts$/, '.mjs'));
    const built = run('bundle', ESBUILD, [entry, '--bundle', '--format=esm', '--platform=node',
      `--outfile=${bundle}`, '--log-level=error']);
    if (!built.pass) {
      failures.push({ label: entry, out: built.out });
      console.log(`FAIL  ${entry} (bundle)\n${built.out.split('\n').slice(0, 20).join('\n')}`);
      continue;
    }
    const result = run(entry, process.execPath, [bundle]);
    const summary = result.out.trim().split('\n').filter((line) => line.trim()).pop() ?? '';
    if (result.pass) {
      passed++;
      console.log(`PASS  ${entry}${summary ? `  ${summary.trim()}` : ''}`);
    } else {
      failures.push({ label: entry, out: result.out });
      console.log(`FAIL  ${entry}`);
      const failLines = result.out.split('\n').filter((line) => line.startsWith('FAIL'));
      console.log((failLines.length ? failLines.join('\n') : summary) || '(no output)');
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s), ${passed} suite(s) passed`);
  process.exit(1);
}
console.log(`\nall ${passed} suites passed`);
