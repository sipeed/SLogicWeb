// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The custom digital threshold (thresholdOptions.ts, capturePanel.ts `thresholdField`):
 * the range comes from the vref DAC math, an entry snaps only to the DAC grid (never to
 * a preset), a custom value survives the workspace round trip, and the panel offers
 * "Custom…" in all four locales. Pure apart from reading sources as text.
 */

import { vrefCode, vrefVolts } from '../../device/index.js';
import {
  isRestorableThreshold, parseCustomThreshold, snapThreshold, thresholdChoice, thresholdRange,
} from '../thresholdOptions.js';
import { THRESHOLD_VOLT_OPTIONS } from '../state.js';
import { parseWorkspaceSnapshot } from '../workspacePreferences.js';
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

const range = thresholdRange();
{
  // Codes 0 and the top code clip (app.ts refuses them), so the range is one code in.
  const top = vrefCode(Number.POSITIVE_INFINITY);
  check('the custom range is the DAC span minus the two clipping codes, one code per step',
    range.min === vrefVolts(1) && range.max === vrefVolts(top - 1) &&
      Math.abs(range.step - (vrefVolts(1) - vrefVolts(0))) < 1e-12 &&
      range.min > 0.43 && range.min < 0.44 && range.max > 5.7 && range.max < 5.72,
    `min=${range.min} max=${range.max} step=${range.step} top=${top}`);
}

{
  const typed = parseCustomThreshold('1.0');
  const comma = parseCustomThreshold('1,0 V');
  const code = vrefCode(1.0);
  check('an entry snaps to its DAC code only, not to the nearest preset',
    typed !== null && Math.abs(typed - vrefVolts(code)) < 1e-4 && vrefCode(typed) === code &&
      !THRESHOLD_VOLT_OPTIONS.includes(typed as never) && comma === typed,
    `1.0 -> ${typed} (code ${code}), "1,0 V" -> ${comma}`);
  const presetKept = THRESHOLD_VOLT_OPTIONS.every((preset) => snapThreshold(preset) === preset);
  check('a preset entered by hand stays that preset', presetKept, THRESHOLD_VOLT_OPTIONS.join(','));
  const refused = ['0.2', '6', 'abc', '', '-1', '1.2.3'].map((text) => parseCustomThreshold(text));
  check('out-of-range or non-numeric entries are refused',
    refused.every((value) => value === null), refused.map(String).join(','));
  const edges = [range.min, range.max].map((volts) => snapThreshold(volts));
  check('the range ends are accepted and never land on a clipping code',
    edges.every((volts) => volts !== null && vrefCode(volts) > 0 && vrefCode(volts) < 1023),
    edges.map(String).join(','));
  check('the select shows a preset by value and anything else as custom',
    thresholdChoice(1.65) === '1.65' && thresholdChoice(typed ?? 0) === 'custom', thresholdChoice(typed ?? 0));
}

{
  const custom = parseCustomThreshold('2.0')!;
  const restore = (volts: number): number | undefined =>
    parseWorkspaceSnapshot(JSON.stringify({ version: 1, capture: { thresholdVolts: volts } }))?.capture?.thresholdVolts;
  check('a custom DAC-grid threshold restores; an off-grid or out-of-range one does not',
    isRestorableThreshold(custom) && restore(custom) === custom &&
      !isRestorableThreshold(1.3) && restore(1.3) !== 1.3 && restore(9) !== 9 && restore(1.65) === 1.65,
    `custom=${custom} -> ${restore(custom)}, 1.3 -> ${restore(1.3)}, 9 -> ${restore(9)}`);
}

{
  const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
  const wired = panel.includes('export function thresholdField(') &&
    panel.includes("['custom', t('capturePanel.thresholdCustom')]") &&
    panel.includes("input.type = 'number'") &&
    panel.includes('input.min = range.min.toFixed(4)') && panel.includes('input.max = range.max.toFixed(4)') &&
    panel.includes('parseCustomThreshold(input.value)') &&
    panel.includes('private thresholdEdit: string | null = null;') &&
    !panel.includes('nearest(THRESHOLD_VOLT_OPTIONS');
  check('the panel turns "Custom…" into a ranged number field and never snaps to a preset', wired, String(wired));
  const keys = ['capturePanel.thresholdCustom', 'capturePanel.thresholdRange'] as const;
  const missing = keys.flatMap((key) => [['zh-CN', zhCN], ['fr', fr], ['ru', ru]]
    .filter(([, dict]) => {
      const text = (dict as typeof en)[key];
      return !text || text === en[key] ||
        (key === 'capturePanel.thresholdRange' && !(text.includes('{min}') && text.includes('{max}')));
    })
    .map(([locale]) => `${String(locale)}:${key}`));
  check('"Custom…" and its range hint are translated', missing.length === 0, missing.join(', ') || 'ok');
  check('the zh-CN entry reads 自定义…', zhCN['capturePanel.thresholdCustom'] === '自定义…',
    zhCN['capturePanel.thresholdCustom']);
}

{
  // DAC note: the plain fact first, the code at the end; the rate/width sentence stays.
  const bad = [['en', en], ['zh-CN', zhCN], ['fr', fr], ['ru', ru]].flatMap(([locale, dict]) =>
    (['capturePanel.dacNote', 'capturePanel.dacNoteAdvised'] as const).filter((key) => {
      const text = (dict as typeof en)[key];
      const code = text.indexOf('{code}');
      return code < text.indexOf('{rate}') || !text.trimEnd().match(/[)）]$/) ||
        !text.startsWith(locale === 'en' ? 'Actual threshold {volts} V' : locale === 'zh-CN'
          ? '实际阈值 {volts} V' : locale === 'fr' ? 'Seuil réel {volts} V' : 'Фактический порог {volts} В');
    }).map((key) => `${String(locale)}:${key}`));
  check('the DAC note leads with the actual threshold and ends with the code in parentheses',
    bad.length === 0, bad.join(', ') || 'ok');
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
