// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { isLogicDecoder, listDecoders } from '../../decode/registry.js';
import {
  decoderDescriptionKey, decoderDescriptionText, decoderLongNameKey, decoderLongNameText,
  decoderOptionKey, decoderOptionLabel, decoderOptionValueKey, decoderOptionValueLabel,
  decoderOptionValueTuples, decoderPickerLabel, type DecoderMetadata,
  type DecoderOptionMetadata,
} from '../decoderI18n.js';
import {
  getLocale, loadCatalog, onLocaleChange, setLocale, setLocaleLoaderForTest, t,
  translateDecoder, type DecoderMessages,
} from '../i18n.js';
import { en } from '../locales/en.js';
import { fr, frDecoder } from '../locales/fr.js';
import { ru, ruDecoder } from '../locales/ru.js';
import { zhCNDecoder } from '../locales/zh-CN.js';
import { frDecoder as frDecoderLeaf } from '../locales/decoder/fr.js';
import { ruDecoder as ruDecoderLeaf } from '../locales/decoder/ru.js';
import { zhCNDecoder as zhCNDecoderLeaf } from '../locales/decoder/zh-CN.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: {
      exit(code: number): never;
      getBuiltinModule?(name: string): unknown;
    };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface FsLike {
  readFileSync(p: string, enc: 'utf8'): string;
  existsSync(p: string): boolean;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const fs = (() => {
  const mod = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!mod || typeof mod.readFileSync !== 'function' || typeof mod.existsSync !== 'function') {
    throw new Error('node fs module unavailable');
  }
  return mod;
})();

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const I2C: DecoderMetadata = {
  id: 'i2c',
  longname: 'Inter-Integrated Circuit',
  desc: 'Two-wire, multi-master, serial bus.',
};

const ADDRESS_FORMAT: DecoderOptionMetadata = {
  id: 'address_format',
  desc: 'Displayed slave address format',
};

function normalizeSpace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function copiesSource(translation: string, source: string): boolean {
  return normalizeSpace(translation) === normalizeSpace(source);
}

function usableTranslation(translation: string, source: string): boolean {
  return translation.trim() !== '' && !copiesSource(translation, source);
}

const LOGIC_DECODERS = listDecoders()
  .filter(isLogicDecoder)
  .sort((a, b) => a.id.localeCompare(b.id));
const REACHABLE_DECODER_COUNT = 68;
const NON_ENGLISH_CATALOGS: readonly (readonly [string, DecoderMessages])[] = [
  ['zh-CN', zhCNDecoder], ['ru', ruDecoder], ['fr', frDecoder],
];

// ------------------------------------------------------------------ key schema

{
  const built = [
    decoderDescriptionKey('i2c'),
    decoderLongNameKey('i2c'),
    decoderOptionKey('i2c', 'address_format'),
    decoderOptionValueKey('shifted'),
    decoderOptionValueKey(1.5),
  ];
  const expected = [
    'decoder.i2c.desc',
    'decoder.i2c.longname',
    'decoder.i2c.opt.address_format',
    'decoder.optval.shifted',
    'decoder.optval.1.5',
  ];
  check('key builders emit the documented decoder metadata schema',
    built.join('|') === expected.join('|'), built.join(' | '));
}

{
  const ids = ['i2c', 'uart', 'spi', 'ir_nec'];
  const optionIds = ['address_format', 'baudrate', 'word_size'];
  const rawValues = ['shifted', 'unshifted', '1.5', '0.5', '2.5', '-1', 'both'];
  const keys = [
    ...ids.flatMap((id) => [decoderDescriptionKey(id), decoderLongNameKey(id)]),
    ...ids.flatMap((id) => optionIds.map((optionId) => decoderOptionKey(id, optionId))),
    ...rawValues.map((value) => decoderOptionValueKey(value)),
  ];
  check('representative surface keys stay unique and dot-bearing raw values stay whole',
    new Set(keys).size === keys.length && decoderOptionValueKey('1.5') === 'decoder.optval.1.5',
    `${keys.length} keys, ${new Set(keys).size} unique`);
}

{
  const ids = LOGIC_DECODERS.map((d) => d.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  check('the reachable picker inventory reserves the optval namespace for value labels',
    ids.length > 0 && duplicates.length === 0 && !ids.includes('optval'),
    `${ids.length} logic decoders, duplicate ids: ${duplicates.join(', ') || 'none'}`);
}

// ------------------------------------------------------------ English fallback

{
  const desc = decoderDescriptionText(I2C);
  const longname = decoderLongNameText(I2C);
  const picker = decoderPickerLabel(I2C);
  const label = decoderOptionLabel('i2c', ADDRESS_FORMAT);
  check('English presentation helpers fall through to sigrok source text byte-for-byte',
    desc === I2C.desc && longname === I2C.longname &&
    picker === `i2c - ${I2C.longname}` && label === ADDRESS_FORMAT.desc,
    `${JSON.stringify(picker)} / ${JSON.stringify(label)}`);
}

{
  const dict = await loadCatalog('en');
  check('English resolves to the shell catalog with no decoder catalog registered',
    dict === en && translateDecoder(decoderDescriptionKey(I2C.id), I2C.desc) === I2C.desc &&
    translateDecoder('decoder.absent.desc', 'source text') === 'source text',
    `identity=${dict === en}, locale=${getLocale()}`);
}

{
  const labels = [
    decoderOptionValueLabel('shifted'),
    decoderOptionValueLabel(3),
    decoderOptionValueLabel(1.5),
  ];
  check('option value labels fall back to the exact raw string',
    labels.join('|') === 'shifted|3|1.5', labels.join('|'));
}

{
  const rawValues = ['shifted', 'unshifted', 3, 1.5] as const;
  const tuples = decoderOptionValueTuples(rawValues);
  const rawKept = tuples.every(([value], i) => value === String(rawValues[i]));
  check('option tuples keep the raw value in slot 0 and a display label in slot 1',
    tuples.length === rawValues.length && rawKept &&
    tuples.map(([value]) => value).join('|') === 'shifted|unshifted|3|1.5',
    JSON.stringify(tuples));
}

// ------------------------------------------------------- translation predicate

{
  const source = I2C.desc;
  const cases: [string, string, boolean][] = [
    ['', source, false],
    ['   ', source, false],
    ['\n\t', source, false],
    ['Two-wire,  multi-master, serial bus.', source, false],
    ['  Two-wire, multi-master, serial bus. ', source, false],
    ['Inter-Integrated Circuit', 'Inter-Integrated Circuit', false],
    ['Двухпроводная шина.', source, true],
    ['Bus série à deux fils.', source, true],
  ];
  const bad = cases.filter(([translation, src, want]) => usableTranslation(translation, src) !== want);
  check('the translation gate rejects blank and whitespace-copied source text',
    bad.length === 0,
    bad.length === 0 ? `${cases.length}/${cases.length} predicate cases match`
      : bad.map(([translation, , want]) => `${JSON.stringify(translation)}→${want}`).join('; '));
}

// -------------------------------------------------------------- catalog shape

{
  const catalogs: [string, DecoderMessages][] =
    [['zh-CN', zhCNDecoder], ['ru', ruDecoder], ['fr', frDecoder]];
  const bad: string[] = [];
  let entries = 0;
  for (const [locale, dict] of catalogs) {
    for (const [key, value] of Object.entries(dict)) {
      entries += 1;
      if (!key.startsWith('decoder.')) bad.push(`${locale}:${key} outside the decoder namespace`);
      if (value.trim() === '') bad.push(`${locale}:${key} blank`);
    }
  }
  check('every decoder catalog entry stays inside the decoder namespace with non-blank text',
    bad.length === 0,
    bad.length === 0 ? `${entries} entries across ${catalogs.length} catalogs` : bad.join('; '));
}

{
  const keySets = [zhCNDecoder, ruDecoder, frDecoder]
    .map((dict) => Object.keys(dict).sort().join('\n'));
  check('decoder catalogs share one key set across the non-English locales',
    new Set(keySets).size === 1,
    keySets.map((keys) => keys.split('\n').filter(Boolean).length).join(' / '));
}

{
  check('shell locale modules re-export their leaf decoder catalog by identity',
    zhCNDecoder === zhCNDecoderLeaf && ruDecoder === ruDecoderLeaf && frDecoder === frDecoderLeaf,
    `${zhCNDecoder === zhCNDecoderLeaf}, ${ruDecoder === ruDecoderLeaf}, ${frDecoder === frDecoderLeaf}`);
}

{
  const present = fs.existsSync('src/ui/locales/decoder/en.ts');
  check('no English decoder catalog duplicates sigrok source text',
    !present, present ? 'en.ts exists' : 'en.ts absent');
}

{
  const files = ['zh-CN', 'ru', 'fr'].map((locale) => `src/ui/locales/decoder/${locale}.ts`);
  const bad: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      const statement = line.trim();
      if (statement.startsWith('import ') && !statement.startsWith('import type ')) {
        bad.push(`${file}: value import "${statement}"`);
      }
      if (statement.startsWith('export ') && !statement.startsWith('export const ')) {
        bad.push(`${file}: non-data export "${statement}"`);
      }
    }
    if (source.includes('import(')) bad.push(`${file}: dynamic import`);
  }
  check('decoder catalogs are plain data modules with no value import edges',
    bad.length === 0, bad.length === 0 ? `${files.length} leaf modules are data-only` : bad.join('; '));
}

{
  const source = fs.readFileSync('src/ui/i18n.ts', 'utf8');
  const specifiers = [...source.matchAll(/import\('([^']+)'\)/g)].map((m) => m[1]);
  const shellLoaders = specifiers.filter((specifier) => specifier.startsWith('./locales/'));
  check('i18n.ts keeps one dynamic-import family for the shell locale chunks',
    specifiers.length === 3 && shellLoaders.length === 3 &&
    !specifiers.some((specifier) => specifier.includes('locales/decoder/')),
    specifiers.join(', '));
}

// ---------------------------------------------------- description inventory

const DESCRIPTION_KEYS = LOGIC_DECODERS.map((d) => decoderDescriptionKey(d.id));

check('the reachable picker inventory pins one description key per logic decoder',
  LOGIC_DECODERS.length === REACHABLE_DECODER_COUNT &&
  LOGIC_DECODERS.every((d) => d.id.trim() !== '' && d.desc.trim() !== '') &&
  new Set(LOGIC_DECODERS.map((d) => d.id)).size === REACHABLE_DECODER_COUNT &&
  new Set(DESCRIPTION_KEYS).size === REACHABLE_DECODER_COUNT,
  `${LOGIC_DECODERS.length} reachable decoders, ${new Set(DESCRIPTION_KEYS).size} unique description keys`);

{
  const missing: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const decoder of LOGIC_DECODERS) {
      const key = decoderDescriptionKey(decoder.id);
      if (!Object.prototype.hasOwnProperty.call(dict, key)) {
        missing.push(`${locale}:${decoder.id}:missing`);
      } else if (!usableTranslation(dict[key], decoder.desc)) {
        missing.push(`${locale}:${decoder.id}:${JSON.stringify(dict[key])}`);
      }
    }
  }
  check('every reachable decoder description is translated in all non-English locales',
    missing.length === 0,
    missing.length === 0
      ? `${LOGIC_DECODERS.length} descriptions × ${NON_ENGLISH_CATALOGS.length} locales`
      : missing.slice(0, 8).join('; '));
}

{
  const reachable = new Set(LOGIC_DECODERS.map((d) => d.id));
  const stale: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const key of Object.keys(dict)) {
      if (!key.endsWith('.desc')) continue;
      const id = key.slice('decoder.'.length, key.length - '.desc'.length);
      if (!key.startsWith('decoder.') || !reachable.has(id)) stale.push(`${locale}:${key}`);
    }
  }
  check('decoder catalogs carry no stale, invented, or stacked-only description key',
    stale.length === 0, stale.length === 0 ? `${reachable.size} reachable ids covered` : stale.join('; '));
}

{
  const sets = NON_ENGLISH_CATALOGS.map(([, dict]) =>
    Object.keys(dict).filter((key) => key.endsWith('.desc')).sort().join('\n'));
  const counts = sets.map((set) => set.split('\n').filter(Boolean).length);
  check('description keys match one-to-one across the non-English locales',
    new Set(sets).size === 1 && counts.every((n) => n === REACHABLE_DECODER_COUNT),
    counts.join(' / '));
}

{
  const groups = new Map<string, string[]>();
  for (const decoder of LOGIC_DECODERS) {
    const source = normalizeSpace(decoder.desc);
    groups.set(source, [...(groups.get(source) ?? []), decoder.id]);
  }
  const repeated = [...groups.values()].filter((ids) => ids.length > 1);
  const shapes = repeated.map((ids) => ids.slice().sort().join('+')).sort();
  const inconsistent: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const ids of repeated) {
      const texts = ids.map((id) => dict[decoderDescriptionKey(id)]);
      if (new Set(texts).size !== 1) inconsistent.push(`${locale}:${ids.join('+')}`);
    }
  }
  check('decoders sharing one sigrok description share one translation in every locale',
    shapes.join('|') === 'cjtag+jtag|i2s+spdif' && inconsistent.length === 0,
    `${shapes.join(' | ')}${inconsistent.length ? ` — ${inconsistent.join('; ')}` : ''}`);
}

// ---------------------------------------------------- atomic registration path

{
  const attempts: [string, () => Promise<unknown>][] = [
    ['throwing decoder catalog', () => Promise.reject(new Error('decoder catalog unavailable'))],
    ['absent decoder catalog', () => Promise.resolve({ messages: en })],
    ['malformed decoder catalog',
      () => Promise.resolve({ messages: en, decoder: { 'decoder.i2c.desc': 42 } })],
  ];
  const baselineLocale = getLocale();
  const priorText = decoderDescriptionText(I2C);
  const bad: string[] = [];
  for (const [label, loader] of attempts) {
    setLocaleLoaderForTest('ru', loader);
    const first = await setLocale('ru');
    const second = await setLocale('ru');
    let cached = false;
    try {
      await loadCatalog('ru');
      cached = true;
    } catch {
      cached = false;
    }
    const stayed = getLocale() === baselineLocale && decoderDescriptionText(I2C) === priorText;
    if (first !== 'failed' || second !== 'failed' || cached || !stayed) {
      bad.push(`${label}: first=${first} second=${second} cached=${cached} locale=${getLocale()}`);
    }
  }
  setLocaleLoaderForTest('ru', null);
  check('a partial shell/decoder load registers neither catalog and keeps the active locale',
    bad.length === 0,
    bad.length === 0 ? `${attempts.length} failure shapes stayed atomic` : bad.join('; '));
}

{
  let loads = 0;
  setLocaleLoaderForTest('ru', () => {
    loads += 1;
    return import('../locales/ru.js').then((m) => ({ messages: m.ru, decoder: m.ruDecoder }));
  });
  const first = await loadCatalog('ru');
  const second = await loadCatalog('ru');
  const committed = await setLocale('ru');
  const translated = t('toolbar.start');
  const fallback = translateDecoder('decoder.absent.desc', I2C.desc);
  const ruMismatches = LOGIC_DECODERS
    .filter((d) => decoderDescriptionText(d) !== ruDecoder[decoderDescriptionKey(d.id)])
    .map((d) => d.id);
  setLocaleLoaderForTest('ru', null);
  const restored = await setLocale('en');
  const enMismatches = LOGIC_DECODERS
    .filter((d) => decoderDescriptionText(d) !== d.desc)
    .map((d) => d.id);
  check('a cached catalog pair loads once, commits, and keeps English source fallback',
    loads === 1 && first === second && first === ru && committed === 'committed' &&
    translated === ru['toolbar.start'] && fallback === I2C.desc &&
    restored === 'committed' && decoderDescriptionText(I2C) === I2C.desc &&
    decoderOptionValueLabel('shifted') === 'shifted',
    `loads=${loads}, ru=${JSON.stringify(translated)}, en=${JSON.stringify(decoderDescriptionText(I2C))}`);
  check('the real registered catalog drives every description and English stays byte-identical',
    ruMismatches.length === 0 && enMismatches.length === 0 && restored === 'committed',
    ruMismatches.length === 0 && enMismatches.length === 0
      ? `${LOGIC_DECODERS.length} descriptions resolve in ru and fall through in en`
      : `ru=${ruMismatches.slice(0, 8).join(',')} en=${enMismatches.slice(0, 8).join(',')}`);
}

// ------------------------------------------------ committed-locale render path

{
  const frenchDecoder: DecoderMessages = {
    'decoder.i2c.desc': 'Bus série à deux fils.',
    'decoder.i2c.longname': 'Circuit intégré inter-IC',
    'decoder.i2c.opt.address_format': 'Format d’adresse esclave affiché',
    'decoder.optval.shifted': 'décalé',
  };
  const aliased = Object.keys(frenchDecoder).filter((key) => frDecoder[key] === frenchDecoder[key]);
  check('the injected listener catalog is a partial test double, not the shipping catalog',
    frenchDecoder !== frDecoder && aliased.length === 0,
    aliased.length === 0
      ? `${Object.keys(frenchDecoder).length} injected keys differ from the leaf catalog`
      : aliased.join(', '));
  interface Snapshot {
    locale: string;
    desc: string;
    longname: string;
    option: string;
    value: string;
  }
  setLocaleLoaderForTest('fr', () => Promise.resolve({ messages: fr, decoder: frenchDecoder }));
  const seen: Snapshot[] = [];
  const unsubscribe = onLocaleChange(() => {
    seen.push({
      locale: getLocale(),
      desc: decoderDescriptionText(I2C),
      longname: decoderLongNameText(I2C),
      option: decoderOptionLabel('i2c', ADDRESS_FORMAT),
      value: decoderOptionValueLabel('shifted'),
    });
  });
  const switched = await setLocale('fr');
  unsubscribe();
  setLocaleLoaderForTest('fr', null);
  const first = seen[0];
  check('locale listeners observe the committed locale on every metadata surface',
    switched === 'committed' && getLocale() === 'fr' && seen.length === 1 &&
    first?.locale === 'fr' && first.desc === frenchDecoder['decoder.i2c.desc'] &&
    first.longname === frenchDecoder['decoder.i2c.longname'] &&
    first.option === frenchDecoder['decoder.i2c.opt.address_format'] &&
    first.value === frenchDecoder['decoder.optval.shifted'] &&
    decoderPickerLabel(I2C) === `i2c - ${frenchDecoder['decoder.i2c.longname']}`,
    JSON.stringify(seen));
}

{
  const tuples = decoderOptionValueTuples(['shifted', 'unshifted', 3]);
  const first = tuples[0];
  const second = tuples[1];
  const third = tuples[2];
  check('constrained option tuples keep raw values while their labels localize',
    tuples.length === 3 && first?.[0] === 'shifted' && first[1] === 'décalé' &&
    second?.[0] === 'unshifted' && second[1] === 'unshifted' &&
    third?.[0] === '3' && third[1] === '3',
    JSON.stringify(tuples));
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
