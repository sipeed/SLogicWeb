// Pins the plain-language copy of the capture panel's key switches (UX review M13/L6/L8/L10).
import { THRESHOLD_VOLT_OPTIONS } from '../state.js';
import { thresholdFamily, thresholdOptionLabel } from '../thresholdOptions.js';
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
    '0.6 V (1.2 V logic)', '0.9 V (1.8 V logic)', '1.2 V (2.5 V logic)', '1.5 V (5 V TTL)',
    '1.65 V (3.3 V logic)', '1.8 V', '2.5 V (5 V logic)', '3.3 V',
  ];
  check('every threshold option is annotated with the logic family it suits, or left bare',
    labels.join('|') === want.join('|'), labels.join('|'));
  // A family's threshold is about half its supply; TTL switches near 1.4 V.
  const off = THRESHOLD_VOLT_OPTIONS.filter((volts) => {
    const family = thresholdFamily(volts);
    if (family === null) return false;
    if (family.kind === 'ttl') return Math.abs(volts - 1.4) > 0.15;
    return Math.abs(volts - family.supplyVolts / 2) > 0.06;
  });
  check('each annotation is within the family mid-swing', off.length === 0, `off=${off.join(',')}`);
  check('the zh-CN option form is "1.65 V（3.3 V 逻辑）"',
    zhCN['capturePanel.thresholdLogic'] === '{volts} V（{logic} V 逻辑）', zhCN['capturePanel.thresholdLogic']);
}

{
  const hint = analogInputHint(8, 32);
  check('the analog button names the group, its D inputs, the ADC input and its range',
    hint.includes('A1') && hint.includes('D8–D15') && hint.includes('±15 V') && hint.includes('8-bit') &&
    hint.includes("ADC module's input"), hint);
  const missing = catalogs.filter(([, dict]) =>
    !['{name}', '{range}', '{span}', '{bits}'].every((p) => dict['capturePanel.analogEnable'].includes(p)))
    .map(([locale]) => locale);
  check('every locale says which inputs and range the analog button reads', missing.length === 0,
    `missing=${missing.join(',')}`);
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

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
