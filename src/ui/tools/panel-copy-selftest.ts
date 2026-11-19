// Pins the plain-language copy of the capture panel's key switches (UX review M13/L6/L8/L10).
import { THRESHOLD_VOLT_OPTIONS } from '../state.js';
import { ADC_THRESHOLD_VOLTS, thresholdFamily, thresholdOptionLabel } from '../thresholdOptions.js';
import { analogInputHint } from '../capturePanel.js';
import { en, type Messages } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const catalogs: Array<[string, Messages]> = [['en', en], ['zh-CN', zhCN], ['ru', ru], ['fr', fr]];

{
  const labels = THRESHOLD_VOLT_OPTIONS.map((volts) => thresholdOptionLabel(volts));
  const want = [
    '0.6 V (1.2 V logic)', '0.9 V (1.8 V logic)', '1.2 V (2.5 V logic)',
    '1.5 V (3 V logic, official ADC)',
    '1.65 V (3.3 V logic)', '1.8 V', '2.5 V (5 V logic)', '3.3 V',
  ];
  check('every threshold option is annotated with the logic family it suits, or left bare',
    labels.join('|') === want.join('|'), labels.join('|'));
  // A family's threshold is about half its supply, including the ADC module's 3 V bus.
  const off = THRESHOLD_VOLT_OPTIONS.filter((volts) => {
    const family = thresholdFamily(volts);
    if (family === null) return false;
    return Math.abs(volts - family.supplyVolts / 2) > 0.06;
  });
  check('each annotation is within the family mid-swing', off.length === 0, `off=${off.join(',')}`);
  check('the zh-CN option forms are "1.65 V（3.3 V 逻辑）" and "1.5 V（3 V 逻辑，官方 ADC 专用）"',
    zhCN['capturePanel.thresholdLogic'] === '{volts} V（{logic} V 逻辑）' &&
    zhCN['capturePanel.thresholdLogicAdc'] === '{volts} V（{logic} V 逻辑，官方 ADC 专用）',
    `${zhCN['capturePanel.thresholdLogic']} | ${zhCN['capturePanel.thresholdLogicAdc']}`);
  check('the 1.5 V choice is the official ADC module annotation, not a TTL one',
    thresholdFamily(ADC_THRESHOLD_VOLTS)?.officialAdc === true &&
    labels.some((label) => label.includes('official ADC')) &&
    !labels.some((label) => /TTL/i.test(label)),
    labels.find((label) => label.includes('official ADC')) ?? 'absent');
}

{
  const hint = analogInputHint(8, 32);
  check('the analog button names the group, its D inputs, the ADC input and its range',
    hint.includes('A1') && hint.includes('D8–D15') && hint.includes('±16 V') && hint.includes('8-bit') &&
    hint.includes("ADC module's input"), hint);
  const missing = catalogs.filter(([, dict]) =>
    !['{name}', '{range}', '{span}', '{bits}'].every((p) => dict['capturePanel.analogEnable'].includes(p)))
    .map(([locale]) => locale);
  check('every locale says which inputs and range the analog button reads', missing.length === 0,
    `missing=${missing.join(',')}`);
  const noteMissing = catalogs.filter(([, dict]) => {
    const text = dict['capturePanel.analogThresholdNote'];
    return !text.includes('{volts}') || !/3\s*[VBВ]/.test(text);
  }).map(([locale]) => locale);
  check('every locale prompts the 3 V ADC bus threshold in the capture panel', noteMissing.length === 0,
    `missing=${noteMissing.join(',')}, volts=${ADC_THRESHOLD_VOLTS}`);
}

{
  // Implementation jargon the UX review flagged; none may survive in user-visible text.
  const jargon: Array<[string, RegExp]> = [
    ['zh-CN', /数字锁定|显示匹配器|局部步进|上一波|匹配器|实时采集|模拟器|Repeat|Duration|Trigger 控件|MSa\/s|双击通道名/],
    ['en', /matcher|local step|previous wave|one-shot|Simulator|MSa\/s|Double-click a channel name/i],
    ['fr', /détecteur d’affichage|pas locaux|Repeat|Duration|Simulateur|MSa\/s|Trigger dans|Double-cliquez un nom de voie/],
    ['ru', /сопоставител|локальными шагами|Repeat|Duration|Симулятор|MSa\/s|Trigger в|Дважды щёлкните имя канала/],
  ];
  const hits: string[] = [];
  for (const [locale, pattern] of jargon) {
    const dict = catalogs.find(([name]) => name === locale)![1];
    for (const [key, text] of Object.entries(dict)) {
      if (!key.startsWith('capturePanel.') && key !== 'capture.live' && !key.startsWith('diagnostic.decode.')) continue;
      if (key === 'capturePanel.usbHelp' || key === 'capturePanel.usbPlaceholder') continue;
      if (pattern.test(text)) hits.push(`${locale}:${key}`);
    }
  }
  check('no flagged jargon or mixed-language term remains in the capture panel copy',
    hits.length === 0, hits.length === 0 ? 'clean' : hits.join(', '));
}

{
  const free = catalogs.filter(([, dict]) => {
    const text = dict['capturePanel.triggerEnableHelp'];
    return !/free-running|自由运行|libre|свободн/.test(text);
  }).map(([locale]) => locale);
  check('the global-trigger sentence says that "on" with no condition is free-running',
    free.length === 0, `missing=${free.join(',')}`);
  const names = catalogs.map(([, dict]) => dict['capturePanel.testSimulator']).join('|');
  check('test mode 2 is called a test pattern, never the analog-confusable "simulator"',
    names === 'Test pattern|测试图案|Тестовый шаблон|Motif de test', names);
}

{
  // Legacy UX review #18/#29: no security jargon for a waiting trigger, durations rather
  // than raw sample counts in the Loop notes, no "draft".
  const hits: string[] = [];
  for (const [locale, dict] of catalogs) {
    for (const [key, text] of Object.entries(dict)) {
      if (/布防|взвед|Взвед/.test(text)) hits.push(`${locale}:${key} arm-jargon`);
      if (key.startsWith('capturePanel.') && /draft|草稿|brouillon|черновик/i.test(text)) {
        hits.push(`${locale}:${key} draft`);
      }
    }
    for (const key of ['capturePanel.loopWindow', 'capturePanel.loopWindowLimit', 'capturePanel.loopSwap'] as const) {
      if (/\{samples\}|samples|样本|échantillons|отсчёт/.test(dict[key])) hits.push(`${locale}:${key} counts`);
    }
  }
  check('waiting-trigger, Loop and capture-panel copy is plain in every locale',
    hits.length === 0 &&
      zhCN['capturePanel.triggerArmNext'].includes('即可立即开始等待触发') &&
      zhCN['capturePanel.loopWindowLimit'] === '最长保留 {duration}（{rate}）。',
    hits.join(', ') || 'clean');
}

{
  const streamKeys: Array<keyof Messages> = [
    'capturePanel.modeLoop', 'capturePanel.pendingTrigger', 'capturePanel.triggerSourceHelp',
    'capturePanel.triggerMemoryReleased', 'capturePanel.triggerLoopReleased',
    'capturePanel.triggerLoopReleasedDigital', 'capturePanel.triggeredLoop',
    'capturePanel.triggeredLoopDigital', 'capturePanel.triggerViewLost',
    'capturePanel.persistenceLoopOff', 'capturePanel.measureStatusLoop',
    'capturePanel.measureStatsLoop', 'notice.cursorZoomLoopLimited',
    'analyzerNote.snapshot', 'diagnostic.decode.tooLongLoop', 'diagnostic.decode.edgeBudgetLoop',
  ];
  const retiredMode = /循环|(?<![a-z])loops?|boucles?|цикл/i;
  const labels: Record<string, string> = { en: 'Stream', 'zh-CN': '流式', ru: 'Поток', fr: 'Flux' };
  const varNames = (text: string): string =>
    [...new Set((text.match(/\{(\w+)\}/g) ?? []).map((v) => v.slice(1, -1)))].sort().join(',');
  const bad: string[] = [];
  for (const [locale, dict] of catalogs) {
    if (dict['capturePanel.modeLoop'] !== labels[locale]) {
      bad.push(`${locale}:capturePanel.modeLoop is "${dict['capturePanel.modeLoop']}" not "${labels[locale]}"`);
    }
    for (const key of streamKeys) {
      const hit = retiredMode.exec(dict[key]);
      if (hit) bad.push(`${locale}:${key} keeps "${hit[0]}"`);
      const want = varNames(en[key]);
      if (varNames(dict[key]) !== want) {
        bad.push(`${locale}:${key} vars "${varNames(dict[key])}" not "${want}"`);
      }
    }
  }
  const withVars = streamKeys.filter((key) => varNames(en[key]) !== '').length;
  check('every name of the third capture mode reads as Stream in all four catalogs, with no retired loop vocabulary and matching placeholders',
    bad.length === 0,
    bad.length === 0
      ? `${streamKeys.length} keys x ${catalogs.length} locales, ${withVars} placeholder-bearing; labels Stream|流式|Поток|Flux`
      : bad.join('; '));
}

const failed = results.filter((r) => !r.pass).length;

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
