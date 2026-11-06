// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

import { getDecoder, hydrateDecoders, isLogicDecoder, listDecoders } from '../../decode/registry.js';
import {
  decoderDescriptionKey, decoderDescriptionText, decoderLongNameKey, decoderLongNameText,
  decoderOptionKey, decoderOptionLabel, decoderOptionValueKey, decoderOptionValueLabel,
  decoderOptionValueTuples, decoderPickerLabel, decoderPickerOptions, decoderPickerSearchText,
  decoderAnnotationClassName, decoderAnnotationKey, decoderRowKey, decoderRowName,
  LOCALIZED_ANNOTATION_DECODER_IDS, PRESERVED_LONGNAME_DECODER_IDS,
  PRESERVED_OPTION_VALUES, type DecoderMetadata, type DecoderOptionMetadata,
} from '../decoderI18n.js';
import { fuzzyMatch, fuzzyRank } from '../fuzzy.js';
import {
  getLocale, loadCatalog, onLocaleChange, setLocale, setLocaleLoaderForTest, t,
  translateDecoder, type DecoderMessages, type Locale,
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

function localNameQuery(text: string): string {
  return normalizeSpace(text.replace(/[./():,]/g, ' ')).split(' ')[0] ?? '';
}

/** The expected picker label, built independently of decoderPickerLabel. */
function pickerLabelOf(decoder: { readonly id: string; readonly name?: string }, longText: string): string {
  const name = decoder.name ?? decoder.id;
  const flat = (x: string): string => x.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return flat(name) === flat(longText) ? name : `${name} - ${longText}`;
}

const LOGIC_DECODERS = listDecoders()
  .filter(isLogicDecoder)
  .sort((a, b) => a.id.localeCompare(b.id));
const REACHABLE_DECODER_COUNT = 68;
const NON_ENGLISH_CATALOGS: readonly (readonly [Exclude<Locale, 'en'>, DecoderMessages])[] = [
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
  check('option keys are per-decoder identities and never enter the optval namespace',
    decoderOptionKey('uart', 'baudrate') === 'decoder.uart.opt.baudrate' &&
    decoderOptionKey('uart', 'baudrate') !== decoderOptionKey('miller', 'baudrate') &&
    !decoderOptionKey('uart', 'baudrate').startsWith('decoder.optval.'),
    decoderOptionKey('uart', 'baudrate'));
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
  const corpus = decoderPickerSearchText(I2C);
  const label = decoderOptionLabel('i2c', ADDRESS_FORMAT);
  check('English presentation helpers fall through to sigrok source text byte-for-byte',
    desc === I2C.desc && longname === I2C.longname &&
    picker === `i2c - ${I2C.longname}` && corpus === `i2c - ${I2C.longname} i2c` &&
    label === ADDRESS_FORMAT.desc,
    `${JSON.stringify(picker)} / ${JSON.stringify(corpus)} / ${JSON.stringify(label)}`);
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

// --------------------------------------------------------- long-name inventory

const LONGNAME_KEYS = LOGIC_DECODERS.map((d) => decoderLongNameKey(d.id));
const EXPECTED_PRESERVED_LONGNAME_IDS: readonly string[] = [
  'am230x', 'cec', 'em4100', 'em4305', 'flexray', 'ieee488', 'ir_irmp',
  'ir_nec', 'ir_rc5', 'ir_rc6', 'ir_sirc', 'mcs48', 'microwire', 'ps2',
  'sae_j1850_vpw', 'sda2506', 'sdq', 'st7735', 't55xx', 'tlc5620', 'usb_power_delivery',
  'z80',
];
const TRANSLATED_LONGNAME_DECODERS = LOGIC_DECODERS
  .filter((d) => !PRESERVED_LONGNAME_DECODER_IDS.has(d.id));
const TRANSLATED_LONGNAME_KEYS = TRANSLATED_LONGNAME_DECODERS
  .map((d) => decoderLongNameKey(d.id));
const LONGNAME_PRESERVED_COUNT = 22;
const LONGNAME_TRANSLATED_COUNT = 46;

check('the reachable picker inventory pins one long-name key per logic decoder',
  LOGIC_DECODERS.length === REACHABLE_DECODER_COUNT &&
  LOGIC_DECODERS.every((d) => d.longname.trim() !== '') &&
  new Set(LONGNAME_KEYS).size === REACHABLE_DECODER_COUNT &&
  new Set([...LONGNAME_KEYS, ...DESCRIPTION_KEYS]).size === 2 * REACHABLE_DECODER_COUNT &&
  !LONGNAME_KEYS.some((key) => key.includes('.opt.') || key.startsWith('decoder.optval.')),
  `${LONGNAME_KEYS.length} reachable decoders, ${new Set(LONGNAME_KEYS).size} unique ` +
  `long-name keys`);

{
  const production = [...PRESERVED_LONGNAME_DECODER_IDS].sort();
  const expected = [...EXPECTED_PRESERVED_LONGNAME_IDS].sort();
  const reachable = new Set(LOGIC_DECODERS.map((d) => d.id));
  const unreachable = expected.filter((id) => !reachable.has(id));
  check('the resolver long-name preserve classification equals the independent literal inventory',
    production.join('|') === expected.join('|') && unreachable.length === 0,
    production.join('|') === expected.join('|') && unreachable.length === 0
      ? `${production.length} preserved decoder ids match the literal inventory`
      : `production=${production.length} expected=${expected.length} ` +
        `unreachable=${unreachable.join(',') || 'none'}`);
}

{
  const preserved = [...PRESERVED_LONGNAME_DECODER_IDS];
  const translated = TRANSLATED_LONGNAME_DECODERS.map((d) => d.id);
  const overlap = translated.filter((id) => PRESERVED_LONGNAME_DECODER_IDS.has(id));
  check('every reachable long name is either translated prose or preserved terminology',
    preserved.length === LONGNAME_PRESERVED_COUNT &&
    translated.length === LONGNAME_TRANSLATED_COUNT &&
    preserved.length + translated.length === REACHABLE_DECODER_COUNT &&
    overlap.length === 0,
    `${preserved.length} preserved + ${translated.length} translated ` +
    `= ${REACHABLE_DECODER_COUNT} reachable long names`);
}

{
  const missing: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const decoder of TRANSLATED_LONGNAME_DECODERS) {
      const key = decoderLongNameKey(decoder.id);
      if (!Object.prototype.hasOwnProperty.call(dict, key)) {
        missing.push(`${locale}:${decoder.id}:missing`);
      } else if (!usableTranslation(dict[key], decoder.longname)) {
        missing.push(`${locale}:${decoder.id}:${JSON.stringify(dict[key])}`);
      }
    }
  }
  check('every descriptive decoder long name is translated in all non-English locales',
    missing.length === 0,
    missing.length === 0
      ? `${TRANSLATED_LONGNAME_DECODERS.length} long names × ${NON_ENGLISH_CATALOGS.length} locales`
      : missing.slice(0, 8).join('; '));
}

{
  const expected = new Set(TRANSLATED_LONGNAME_KEYS);
  const preservedKeys: string[] = [];
  const stale: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const decoder of LOGIC_DECODERS) {
      const key = decoderLongNameKey(decoder.id);
      if (PRESERVED_LONGNAME_DECODER_IDS.has(decoder.id) &&
        Object.prototype.hasOwnProperty.call(dict, key)) {
        preservedKeys.push(`${locale}:${key}`);
      }
    }
    for (const key of Object.keys(dict)) {
      if (key.endsWith('.longname') && !expected.has(key)) stale.push(`${locale}:${key}`);
    }
  }
  check('preserved long names carry no catalog key and no stale long-name key survives',
    preservedKeys.length === 0 && stale.length === 0 &&
    new Set(TRANSLATED_LONGNAME_KEYS).size === TRANSLATED_LONGNAME_KEYS.length,
    preservedKeys.length === 0 && stale.length === 0
      ? `${expected.size} translated keys, no preserved-name keys`
      : `preserved=${preservedKeys.join(',')} stale=${stale.join(',')}`);
}

{
  const sets = NON_ENGLISH_CATALOGS.map(([, dict]) =>
    Object.keys(dict).filter((key) => key.endsWith('.longname')).sort().join('\n'));
  const counts = sets.map((set) => set.split('\n').filter(Boolean).length);
  check('long-name keys match one-to-one across the non-English locales',
    new Set(sets).size === 1 && counts.every((n) => n === LONGNAME_TRANSLATED_COUNT),
    counts.join(' / '));
}

{
  const groups = new Map<string, string[]>();
  for (const decoder of LOGIC_DECODERS) {
    const source = normalizeSpace(decoder.longname);
    groups.set(source, [...(groups.get(source) ?? []), decoder.id]);
  }
  const repeated = [...groups.values()].filter((ids) => ids.length > 1);
  const shapes = repeated.map((ids) => ids.slice().sort().join('+')).sort();
  const inconsistent: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const ids of repeated) {
      const texts = ids.map((id) => dict[decoderLongNameKey(id)]);
      if (new Set(texts).size !== 1) inconsistent.push(`${locale}:${ids.join('+')}`);
    }
  }
  check('no two reachable long names share one source, so no translation could diverge',
    shapes.join('|') === '' && inconsistent.length === 0,
    repeated.length === 0
      ? `${groups.size} distinct long names, none shared`
      : `shared=${shapes.join(' | ')} ${inconsistent.join('; ')}`);
}

{
  const I2C_INDEX = LOGIC_DECODERS.findIndex((d) => d.id === 'i2c');
  const bad: string[] = [];
  const summary: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    const switched = await setLocale(locale);
    if (switched !== 'committed' || getLocale() !== locale) bad.push(`${locale}:switch=${switched}`);
    const labels = LOGIC_DECODERS.map((d) => decoderPickerLabel(d));
    const corpus = LOGIC_DECODERS.map((d) => decoderPickerSearchText(d));
    LOGIC_DECODERS.forEach((decoder, i) => {
      const text = decoderLongNameText(decoder);
      const shown = pickerLabelOf(decoder, text);
      if (labels[i] !== shown) {
        bad.push(`${locale}:${decoder.id}:label=${JSON.stringify(labels[i])}`);
      }
      if (corpus[i] !== `${shown} ${decoder.id}`) {
        bad.push(`${locale}:${decoder.id}:corpus=${JSON.stringify(corpus[i])}`);
      }
      if (!corpus[i]?.startsWith(labels[i] ?? '\u0000')) bad.push(`${locale}:${decoder.id}:prefix`);
      if (PRESERVED_LONGNAME_DECODER_IDS.has(decoder.id)) {
        if (text !== decoder.longname) {
          bad.push(`${locale}:${decoder.id}:preserved=${JSON.stringify(text)}`);
        }
      } else if (text !== dict[decoderLongNameKey(decoder.id)]) {
        bad.push(`${locale}:${decoder.id}:text=${JSON.stringify(text)}`);
      }
      if (fuzzyMatch(decoder.id, corpus[i] ?? '') === null) bad.push(`${locale}:${decoder.id}:id-search`);
    });
    if (new Set(labels).size !== labels.length) bad.push(`${locale}:duplicate-labels`);
    if (fuzzyRank('i2c', corpus)[0]?.index !== I2C_INDEX) bad.push(`${locale}:id-rank`);
    for (const decoder of TRANSLATED_LONGNAME_DECODERS) {
      const text = decoderLongNameText(decoder);
      const index = LOGIC_DECODERS.indexOf(decoder);
      if (fuzzyMatch(localNameQuery(text), corpus[index] ?? '') === null) {
        bad.push(`${locale}:${decoder.id}:name-search`);
      }
      if (decoder.id === 'i2c' &&
        fuzzyRank(normalizeSpace(text.replace(/[./():,]/g, ' ')), corpus)[0]?.index !== index) {
        bad.push(`${locale}:${decoder.id}:name-rank`);
      }
    }
    summary.push(`${locale}:${labels.length}`);
  }
  const restored = await setLocale('en');
  const english = LOGIC_DECODERS.every((d) =>
    decoderLongNameText(d) === d.longname && decoderPickerLabel(d) === pickerLabelOf(d, d.longname) &&
    decoderPickerSearchText(d) === `${pickerLabelOf(d, d.longname)} ${d.id}`);
  check('picker labels show the short name and localized long name; the id stays searchable',
    bad.length === 0 && restored === 'committed' && getLocale() === 'en' && english,
    bad.length === 0
      ? `${summary.join(' ')}; ids searchable, localized names rank first`
      : bad.slice(0, 8).join('; '));
}

// -------------------------------------------------------- option inventory

await hydrateDecoders();

interface ReachableOption {
  readonly decoderId: string;
  readonly optionId: string;
  readonly desc: string;
  readonly constrained: boolean;
  readonly values: readonly (string | number)[];
}

const REACHABLE_OPTIONS: readonly ReachableOption[] = LOGIC_DECODERS.flatMap((d) =>
  getDecoder(d.id).options.map((opt) => ({
    decoderId: d.id,
    optionId: opt.id,
    desc: opt.desc,
    constrained: opt.values.length > 0,
    values: opt.values,
  })));
const OPTION_KEYS = REACHABLE_OPTIONS.map((o) => decoderOptionKey(o.decoderId, o.optionId));
const REACHABLE_OPTION_COUNT = 123;
const CONSTRAINED_OPTION_COUNT = 75;
const FREE_OPTION_COUNT = 48;

check('the reachable picker inventory pins every logic-decoder option identity',
  REACHABLE_OPTIONS.length === REACHABLE_OPTION_COUNT &&
  REACHABLE_OPTIONS.filter((o) => o.constrained).length === CONSTRAINED_OPTION_COUNT &&
  REACHABLE_OPTIONS.filter((o) => !o.constrained).length === FREE_OPTION_COUNT &&
  REACHABLE_OPTIONS.every((o) => o.optionId.trim() !== '' && o.desc.trim() !== '') &&
  new Set(OPTION_KEYS).size === REACHABLE_OPTION_COUNT &&
  !OPTION_KEYS.some((key) => key.startsWith('decoder.optval.')),
  `${REACHABLE_OPTIONS.length} options, ${new Set(OPTION_KEYS).size} unique keys, ` +
  `${REACHABLE_OPTIONS.filter((o) => o.constrained).length} constrained`);

{
  const missing: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const option of REACHABLE_OPTIONS) {
      const key = decoderOptionKey(option.decoderId, option.optionId);
      if (!Object.prototype.hasOwnProperty.call(dict, key)) {
        missing.push(`${locale}:${key}:missing`);
      } else if (!usableTranslation(dict[key], option.desc)) {
        missing.push(`${locale}:${key}:${JSON.stringify(dict[key])}`);
      }
    }
  }
  check('every reachable option label is translated in all non-English locales',
    missing.length === 0,
    missing.length === 0
      ? `${REACHABLE_OPTION_COUNT} labels × ${NON_ENGLISH_CATALOGS.length} locales`
      : missing.slice(0, 8).join('; '));
}

{
  const expected = new Set(OPTION_KEYS);
  const stale: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const key of Object.keys(dict)) {
      if (key.includes('.opt.') && !expected.has(key)) stale.push(`${locale}:${key}`);
    }
  }
  check('decoder catalogs carry no stale, invented, or stacked-only option key',
    stale.length === 0,
    stale.length === 0 ? `${expected.size} reachable option identities covered` : stale.join('; '));
}

{
  const sets = NON_ENGLISH_CATALOGS.map(([, dict]) =>
    Object.keys(dict).filter((key) => key.includes('.opt.')).sort().join('\n'));
  const counts = sets.map((set) => set.split('\n').filter(Boolean).length);
  check('option keys match one-to-one across the non-English locales',
    new Set(sets).size === 1 && counts.every((n) => n === REACHABLE_OPTION_COUNT),
    counts.join(' / '));
}

{
  const groups = new Map<string, string[]>();
  for (const option of REACHABLE_OPTIONS) {
    const source = normalizeSpace(option.desc);
    groups.set(source, [...(groups.get(source) ?? []),
      decoderOptionKey(option.decoderId, option.optionId)]);
  }
  const repeated = [...groups.entries()].filter(([, keys]) => keys.length > 1);
  const sources = repeated.map(([source]) => source).sort();
  const SHARED = [
    'Averaging period', 'Baud rate', 'Bit order', 'Clock edge to sample on',
    'Coil frequency', 'EM4100 decode', 'Polarity', 'Sample point (%)',
    'Write gap min', 'Write one max',
  ];
  const inconsistent: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const [source, keys] of repeated) {
      const texts = keys.map((key) => dict[key]);
      if (new Set(texts).size !== 1) inconsistent.push(`${locale}:${source}`);
    }
  }
  check('options sharing one sigrok label share one translation in every locale',
    sources.join('|') === SHARED.join('|') &&
    repeated.reduce((n, [, keys]) => n + keys.length, 0) === 28 &&
    inconsistent.length === 0,
    `${sources.length} shared labels, 28 keys` +
    `${inconsistent.length ? ` — ${inconsistent.join('; ')}` : ''}`);
}

{
  const bad: string[] = [];
  const perDecoder = new Map<string, string[]>();
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    perDecoder.clear();
    for (const option of REACHABLE_OPTIONS) {
      const label = dict[decoderOptionKey(option.decoderId, option.optionId)];
      const bucket = perDecoder.get(option.decoderId) ?? [];
      bucket.push(label);
      perDecoder.set(option.decoderId, bucket);
    }
    for (const [decoderId, labels] of perDecoder) {
      if (new Set(labels).size !== labels.length) {
        bad.push(`${locale}:${decoderId}:${labels.length - new Set(labels).size}`);
      }
    }
  }
  check('localized option labels stay unique inside each decoder control group',
    bad.length === 0,
    bad.length === 0
      ? `${new Set(REACHABLE_OPTIONS.map((o) => o.decoderId)).size} decoder groups × 3 locales`
      : bad.join('; '));
}

// ---------------------------------------------- option value classification

const REACHABLE_OPTION_VALUES: readonly (string | number)[] =
  REACHABLE_OPTIONS.flatMap((o) => o.values);
const UNIQUE_OPTION_VALUES: readonly string[] =
  [...new Set(REACHABLE_OPTION_VALUES.map((value) => String(value)))].sort();
const CONSTRAINED_VALUE_OCCURRENCE_COUNT = 214;
const UNIQUE_OPTION_VALUE_COUNT = 102;
const EXPECTED_PRESERVED_OPTION_VALUES: readonly string[] = [
  '-', '0', '0.5', '1', '1.5', '2', '3', '4', '5', '6', '7', '8', '9', '10', '16', '32',
  '64', '1010', '1111', '2500000', '5000000', '10000000',
  'A', 'B',
  'BGR', 'BRG', 'GBR', 'GRB', 'RBG', 'RGB', 'RGB[W]', 'RGBW', 'RGWB', 'RWBG',
  'am230x/rht', 'dht11', 'maplin_l95ar', 'SC52x2/HX22x2', 'xx1527',
  'ascii', 'bin', 'dec', 'enum', 'eol', 'fixpoint', 'fixsigned', 'hex', 'ieee754', 'oct',
  'big', 'little', 'lsb-first', 'msb-first',
  'inch', 'mm',
  'Diff Manchester', 'Manchester', 'NRZ', 'full-speed', 'low-speed',
  'terse-auto', 'terse-ms', 'terse-ns', 'terse-ps', 'terse-s', 'terse-us',
];
const TRANSLATED_OPTION_VALUES: readonly string[] =
  UNIQUE_OPTION_VALUES.filter((value) => !PRESERVED_OPTION_VALUES.has(value));
const OPTION_VALUE_KEYS = TRANSLATED_OPTION_VALUES.map((value) => decoderOptionValueKey(value));
const CONSTRAINED_OPTIONS = REACHABLE_OPTIONS.filter((option) => option.constrained);

check('the reachable constrained inventory pins every raw option value occurrence',
  REACHABLE_OPTION_VALUES.length === CONSTRAINED_VALUE_OCCURRENCE_COUNT &&
  UNIQUE_OPTION_VALUES.length === UNIQUE_OPTION_VALUE_COUNT &&
  REACHABLE_OPTION_VALUES.every((value) => String(value).trim() !== '') &&
  CONSTRAINED_OPTIONS.every((option) => option.values.length > 0) &&
  REACHABLE_OPTIONS.filter((option) => !option.constrained)
    .every((option) => option.values.length === 0),
  `${REACHABLE_OPTION_VALUES.length} occurrences, ${UNIQUE_OPTION_VALUES.length} unique, ` +
  `${CONSTRAINED_OPTIONS.length} constrained options`);

{
  const production = [...PRESERVED_OPTION_VALUES].sort();
  const expected = [...EXPECTED_PRESERVED_OPTION_VALUES].sort();
  const reachable = new Set(UNIQUE_OPTION_VALUES);
  const unreachable = expected.filter((value) => !reachable.has(value));
  check('the resolver preserve classification equals the independent literal inventory',
    production.join('|') === expected.join('|') && unreachable.length === 0,
    production.join('|') === expected.join('|') && unreachable.length === 0
      ? `${production.length} preserved values match the literal inventory`
      : `production=${production.length} expected=${expected.length} ` +
        `unreachable=${unreachable.join(',') || 'none'}`);
}

{
  const overlap = TRANSLATED_OPTION_VALUES.filter((value) => PRESERVED_OPTION_VALUES.has(value));
  check('every reachable raw value is either translated prose or preserved notation',
    PRESERVED_OPTION_VALUES.size === 66 && TRANSLATED_OPTION_VALUES.length === 36 &&
    PRESERVED_OPTION_VALUES.size + TRANSLATED_OPTION_VALUES.length === UNIQUE_OPTION_VALUES.length &&
    overlap.length === 0,
    `${PRESERVED_OPTION_VALUES.size} preserved + ${TRANSLATED_OPTION_VALUES.length} translated ` +
    `= ${UNIQUE_OPTION_VALUES.length} reachable values`);
}

{
  const missing: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const raw of TRANSLATED_OPTION_VALUES) {
      const key = decoderOptionValueKey(raw);
      if (!Object.prototype.hasOwnProperty.call(dict, key)) {
        missing.push(`${locale}:${key}:missing`);
      } else if (!usableTranslation(dict[key], raw)) {
        missing.push(`${locale}:${key}:${JSON.stringify(dict[key])}`);
      }
    }
  }
  check('every human-language constrained value is translated in all non-English locales',
    missing.length === 0,
    missing.length === 0
      ? `${TRANSLATED_OPTION_VALUES.length} values × ${NON_ENGLISH_CATALOGS.length} locales`
      : missing.slice(0, 8).join('; '));
}

// The I2C address_format option's raw values are operation tokens whose shift
// direction is ambiguous across vendors; upstream libsigrokdecode displays the
// 7-bit slave address for 'shifted' (the wire byte right-shifted) and the raw
// 8-bit address byte including the R/W bit for 'unshifted'. Pin the displayed
// representation in every locale so the labels cannot silently regress to
// literal token translations that carry no addressing meaning.
{
  const bad: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    const shifted = dict[decoderOptionValueKey('shifted')];
    const unshifted = dict[decoderOptionValueKey('unshifted')];
    if (shifted === undefined || !shifted.includes('7')) {
      bad.push(`${locale}:shifted=${JSON.stringify(shifted)}`);
    }
    if (unshifted === undefined || !unshifted.includes('8')) {
      bad.push(`${locale}:unshifted=${JSON.stringify(unshifted)}`);
    }
  }
  check('I2C address format values name the displayed 7-bit/8-bit representation',
    bad.length === 0,
    bad.length === 0
      ? `${NON_ENGLISH_CATALOGS.length} locales pin 7-bit shifted / 8-bit unshifted`
      : bad.join('; '));
}

{
  const expected = new Set(OPTION_VALUE_KEYS);
  const stale: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    for (const key of Object.keys(dict)) {
      if (key.startsWith('decoder.optval.') && !expected.has(key)) stale.push(`${locale}:${key}`);
    }
  }
  check('decoder catalogs carry no stale, preserved, or invented option value key',
    stale.length === 0 && new Set(OPTION_VALUE_KEYS).size === OPTION_VALUE_KEYS.length &&
    !OPTION_VALUE_KEYS.some((key) => key.includes('.opt.')),
    stale.length === 0
      ? `${expected.size} translated value keys, no preserved-value keys`
      : stale.join('; '));
}

{
  const sets = NON_ENGLISH_CATALOGS.map(([, dict]) =>
    Object.keys(dict).filter((key) => key.startsWith('decoder.optval.')).sort().join('\n'));
  const counts = sets.map((set) => set.split('\n').filter(Boolean).length);
  check('option value keys match one-to-one across the non-English locales',
    new Set(sets).size === 1 && counts.every((n) => n === TRANSLATED_OPTION_VALUES.length),
    counts.join(' / '));
}

// -------------------------------------------------------- expected key union

// ------------------------------------------------- annotation row/class names

const ANNOTATION_DECODERS = LOCALIZED_ANNOTATION_DECODER_IDS.map((id) => getDecoder(id));
const ANNOTATION_KEYS: readonly string[] = ANNOTATION_DECODERS.flatMap((d) => [
  ...d.annotation_rows.map((r) => decoderRowKey(d.id, r.id)),
  ...d.annotations.map((a) => decoderAnnotationKey(d.id, a.id)),
]);
const ANNOTATION_KEY_COUNT = 85;

check('row/class keys follow decoder.<id>.row.<rowId> / decoder.<id>.ann.<classId>',
  decoderRowKey('uart', 'rx-data-vals') === 'decoder.uart.row.rx-data-vals' &&
  decoderAnnotationKey('i2c', 'address-write') === 'decoder.i2c.ann.address-write' &&
  LOCALIZED_ANNOTATION_DECODER_IDS.join() === 'uart,i2c,spi,onewire_link,can' &&
  new Set(ANNOTATION_KEYS).size === ANNOTATION_KEY_COUNT,
  `${ANNOTATION_KEYS.length} keys, ${new Set(ANNOTATION_KEYS).size} unique`);

{
  const bad: string[] = [];
  const sample: string[] = [];
  for (const locale of ['en', 'zh-CN', 'fr', 'ru'] as const) {
    const switched = await setLocale(locale);
    if (switched !== 'committed') bad.push(`${locale}:switch=${switched}`);
    const dict = NON_ENGLISH_CATALOGS.find(([l]) => l === locale)?.[1] ?? null;
    for (const d of ANNOTATION_DECODERS) {
      for (const r of d.annotation_rows) {
        const got = decoderRowName(d, r);
        const want = dict ? dict[decoderRowKey(d.id, r.id)] : r.desc;
        if (got !== want || got.trim() === '') bad.push(`${locale}:${d.id}.row.${r.id}=${JSON.stringify(got)}`);
      }
      for (const a of d.annotations) {
        const got = decoderAnnotationClassName(d.id, a);
        const want = dict ? dict[decoderAnnotationKey(d.id, a.id)] : a.desc;
        if (got !== want || got.trim() === '') bad.push(`${locale}:${d.id}.ann.${a.id}=${JSON.stringify(got)}`);
      }
    }
    const uart = getDecoder('uart');
    const i2c = getDecoder('i2c');
    sample.push(`${locale}:${decoderAnnotationClassName('uart', uart.annotations.find((a) => a.id === 'rx-start')!)}` +
      `/${decoderAnnotationClassName('i2c', i2c.annotations.find((a) => a.id === 'address-write')!)}`);
  }
  await setLocale('zh-CN');
  const uart = getDecoder('uart');
  const i2c = getDecoder('i2c');
  const zhSpot = decoderAnnotationClassName('uart', uart.annotations.find((a) => a.id === 'rx-stop')!) === 'RX 停止位' &&
    decoderAnnotationClassName('i2c', i2c.annotations.find((a) => a.id === 'address-write')!) === '写地址' &&
    decoderRowName(i2c, i2c.annotation_rows.find((r) => r.id === 'addr-data')!) === '地址/数据';
  // A decoder outside the covered set, and one with no declared rows, fall back to sigrok's English.
  const pwm = getDecoder('pwm');
  const pwmRow = pwm.annotation_rows[0];
  const swd = getDecoder('swd');
  const synth = { id: swd.annotations[0]!.id, desc: swd.annotations[0]!.desc };
  const fallback = (pwmRow === undefined || decoderRowName(pwm, pwmRow) === pwmRow.desc) &&
    decoderAnnotationClassName('pwm', pwm.annotations[0]!) === pwm.annotations[0]!.desc &&
    decoderRowName({ id: 'nosuch', annotations: [synth], annotation_rows: [] }, synth) === synth.desc &&
    decoderRowName({ id: 'nosuch', annotations: [], annotation_rows: [{ id: 'r', desc: 'Raw row' }] },
      { id: 'r', desc: 'Raw row' }) === 'Raw row';
  const restored = await setLocale('en');
  check('covered decoders resolve every row and class name in all four locales; others fall back to English',
    bad.length === 0 && zhSpot && fallback && restored === 'committed',
    bad.length === 0 ? `${sample.join(' ')}; zh spot=${zhSpot}, fallback=${fallback}` : bad.slice(0, 8).join('; '));
}

{
  const source = fs.readFileSync('src/ui/decodeResultsPanel.ts', 'utf8');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const design = fs.readFileSync('docs/DESIGN.md', 'utf8');
  check('the results list and the lane labels name rows/classes through the catalog, payload text stays sigrok',
    source.includes('rows.map((r) => decoderRowName(info, r))') &&
    source.includes('decoderAnnotationClassName(info.id, x)') &&
    source.includes('textsOf: (i) => annotationTexts(result, i)') &&
    !source.includes('rows.map((r) => r.desc)') &&
    app.includes('decoderRowName(info, row)') &&
    /payload text[^.]*stays? (in )?English/i.test(design),
    'decodeResultsPanel + app lane labels + DESIGN.md');
}

const EXPECTED_DECODER_KEYS: readonly string[] = [
  ...DESCRIPTION_KEYS,
  ...TRANSLATED_LONGNAME_KEYS,
  ...OPTION_KEYS,
  ...OPTION_VALUE_KEYS,
  ...ANNOTATION_KEYS,
];
const EXPECTED_DECODER_KEY_SET: ReadonlySet<string> = new Set(EXPECTED_DECODER_KEYS);
const EXPECTED_DECODER_KEY_COUNT = REACHABLE_DECODER_COUNT + LONGNAME_TRANSLATED_COUNT +
  REACHABLE_OPTION_COUNT + TRANSLATED_OPTION_VALUES.length + ANNOTATION_KEY_COUNT;

check('the five localized surfaces build one disjoint expected decoder key union',
  EXPECTED_DECODER_KEY_SET.size === EXPECTED_DECODER_KEYS.length &&
  EXPECTED_DECODER_KEY_SET.size === EXPECTED_DECODER_KEY_COUNT,
  `${DESCRIPTION_KEYS.length} descriptions + ${TRANSLATED_LONGNAME_KEYS.length} long names + ` +
  `${OPTION_KEYS.length} option labels + ${OPTION_VALUE_KEYS.length} value labels + ` +
  `${ANNOTATION_KEYS.length} row/class names = ` +
  `${EXPECTED_DECODER_KEY_COUNT} expected keys, ${EXPECTED_DECODER_KEYS.length} built, ` +
  `${EXPECTED_DECODER_KEY_SET.size} unique`);

{
  const missing: string[] = [];
  const extra: string[] = [];
  const sizes: string[] = [];
  for (const [locale, dict] of NON_ENGLISH_CATALOGS) {
    const actual = new Set(Object.keys(dict));
    for (const key of EXPECTED_DECODER_KEY_SET) {
      if (!actual.has(key)) missing.push(`${locale}:${key}`);
    }
    for (const key of actual) {
      if (!EXPECTED_DECODER_KEY_SET.has(key)) extra.push(`${locale}:${key}`);
    }
    if (actual.size !== EXPECTED_DECODER_KEY_SET.size) sizes.push(`${locale}:${actual.size}`);
  }
  check('every non-English decoder catalog key set equals the expected union exactly',
    missing.length === 0 && extra.length === 0 && sizes.length === 0,
    missing.length === 0 && extra.length === 0 && sizes.length === 0
      ? `${NON_ENGLISH_CATALOGS.length} catalogs × ${EXPECTED_DECODER_KEY_SET.size} keys`
      : `missing=${missing.slice(0, 8).join(',') || 'none'} ` +
        `extra=${extra.slice(0, 8).join(',') || 'none'} ` +
        `sizes=${sizes.join(',') || 'match'}`);
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

{
  const committed = await setLocale('ru');
  const ruLabelMismatches = REACHABLE_OPTIONS
    .filter((o) => decoderOptionLabel(o.decoderId, { id: o.optionId, desc: o.desc })
      !== ruDecoder[decoderOptionKey(o.decoderId, o.optionId)])
    .map((o) => `${o.decoderId}.${o.optionId}`);
  const ruSourceLeaks = REACHABLE_OPTIONS
    .filter((o) => decoderOptionLabel(o.decoderId, { id: o.optionId, desc: o.desc }) === o.desc)
    .map((o) => `${o.decoderId}.${o.optionId}`);
  const restored = await setLocale('en');
  const enLabelMismatches = REACHABLE_OPTIONS
    .filter((o) => decoderOptionLabel(o.decoderId, { id: o.optionId, desc: o.desc }) !== o.desc)
    .map((o) => `${o.decoderId}.${o.optionId}`);
  check('the real registered catalog drives every option label and English stays byte-identical',
    committed === 'committed' && restored === 'committed' &&
    ruLabelMismatches.length === 0 && ruSourceLeaks.length === 0 &&
    enLabelMismatches.length === 0,
    ruLabelMismatches.length === 0 && enLabelMismatches.length === 0
      ? `${REACHABLE_OPTION_COUNT} labels resolve in ru and fall through in en`
      : `ru=${ruLabelMismatches.slice(0, 8).join(',')} ` +
        `leaks=${ruSourceLeaks.slice(0, 8).join(',')} ` +
        `en=${enLabelMismatches.slice(0, 8).join(',')}`);
}

// ------------------------------------------------ committed-locale render path

{
  const valueLocales: readonly (readonly ['zh-CN' | 'ru' | 'fr', DecoderMessages])[] = [
    ['zh-CN', zhCNDecoder], ['ru', ruDecoder], ['fr', frDecoder],
  ];
  const bad: string[] = [];
  const summary: string[] = [];
  for (const [locale, dict] of valueLocales) {
    const switched = await setLocale(locale);
    if (switched !== 'committed' || getLocale() !== locale) {
      bad.push(`${locale}:switch=${switched}`);
    }
    const preservedLeaks = [...PRESERVED_OPTION_VALUES].filter((raw) =>
      decoderOptionValueLabel(raw) !== raw ||
      Object.prototype.hasOwnProperty.call(dict, decoderOptionValueKey(raw)));
    if (preservedLeaks.length) {
      bad.push(`${locale}:preserved=${preservedLeaks.slice(0, 5).join(',')}`);
    }
    let occurrences = 0;
    for (const option of CONSTRAINED_OPTIONS) {
      const built = decoderOptionValueTuples(option.values);
      if (built.length !== option.values.length) {
        bad.push(`${locale}:${option.decoderId}.${option.optionId}:length`);
      }
      const labels = new Set<string>();
      built.forEach(([value, label], i) => {
        const raw = String(option.values[i]);
        const expected = PRESERVED_OPTION_VALUES.has(raw)
          ? raw
          : dict[decoderOptionValueKey(raw)];
        if (value !== raw) bad.push(`${locale}:${option.decoderId}.${option.optionId}:value=${value}`);
        if (label !== expected) {
          bad.push(`${locale}:${option.decoderId}.${option.optionId}:label=${JSON.stringify(label)}`);
        }
        if (labels.has(label)) bad.push(`${locale}:${option.decoderId}:duplicate=${label}`);
        labels.add(label);
      });
      occurrences += built.length;
    }
    summary.push(`${locale}:${occurrences}`);
  }
  const restored = await setLocale('en');
  const englishPurity = CONSTRAINED_OPTIONS.every((option) =>
    decoderOptionValueTuples(option.values).every(([value, label]) => value === label));
  check('constrained tuples keep raw values and localized labels in every locale',
    bad.length === 0 && restored === 'committed' && getLocale() === 'en' && englishPurity,
    bad.length === 0
      ? `${summary.join(' ')}; English labels equal raw values`
      : bad.slice(0, 8).join('; '));
}

{
  const frenchDecoder: DecoderMessages = {
    'decoder.i2c.desc': 'Bus série à deux fils.',
    'decoder.i2c.longname': 'Circuit intégré inter-IC',
    'decoder.i2c.opt.address_format': 'Format d’adresse esclave (double de test)',
    'decoder.optval.shifted': 'décalé',
    'decoder.optval.1.25': '1,25',
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
    decoderPickerLabel(I2C) === `i2c - ${frenchDecoder['decoder.i2c.longname']}` &&
    decoderPickerSearchText(I2C) === `i2c - ${frenchDecoder['decoder.i2c.longname']} i2c`,
    JSON.stringify(seen));
  check('dot-bearing raw values resolve as whole keys, never split on the dot',
    decoderOptionValueKey('1.25') === 'decoder.optval.1.25' &&
    decoderOptionValueLabel('1.25') === frenchDecoder['decoder.optval.1.25'] &&
    translateDecoder('decoder.optval.125', '1.25') === '1.25',
    `${JSON.stringify(decoderOptionValueLabel('1.25'))} / ` +
    `${JSON.stringify(translateDecoder('decoder.optval.125', '1.25'))}`);
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

{
  const tuples = decoderPickerOptions(LOGIC_DECODERS);
  const i2c = tuples[LOGIC_DECODERS.findIndex((d) => d.id === 'i2c')];
  const badSlots = tuples.filter((tuple, i) => {
    const decoder = LOGIC_DECODERS[i];
    return decoder === undefined ||
      tuple[0] !== decoder.id || tuple[1] !== decoderPickerLabel(decoder) ||
      tuple[2] !== `${decoderPickerLabel(decoder)} ${decoder.id}`;
  });
  check('picker option tuples keep the raw id value with the localized label and corpus',
    tuples.length === LOGIC_DECODERS.length && badSlots.length === 0 &&
    i2c?.[1] === `I²C - ${translateDecoder('decoder.i2c.longname', I2C.longname)}` &&
    i2c?.[2] === `I²C - ${translateDecoder('decoder.i2c.longname', I2C.longname)} i2c`,
    badSlots.length === 0
      ? `${tuples.length} tuples: value=id, label "${i2c?.[1]}"`
      : JSON.stringify(badSlots.slice(0, 2)));
}

// ---------------------------------------------------------------------- report

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
