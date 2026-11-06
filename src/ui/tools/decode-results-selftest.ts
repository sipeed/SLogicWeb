// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Node entry point for the decoder workflow suite: the results list model (M6), the
 * analyzer form helpers (M5), protocol alias search (M8) and analyzer carry-over (M9).
 *
 *   node_modules/.bin/esbuild src/ui/tools/decode-results-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/decode-results-selftest.mjs && node /tmp/decode-results-selftest.mjs
 *
 * Run from the repository root (checks read sources from the CWD).
 */

import { getDecoder, hydrateDecoders, isLogicDecoder, listDecoders } from '../../decode/registry.js';
import {
  changedOptions, defaultChannelMapping, mapsNoChannel, reconcileAnalyzers, splitDecoderOptions,
} from '../analyzerForm.js';
import {
  CLIPBOARD_LINE_CAP, TEXT_LINE_CAP, annotationLine, defaultResultRows, filterResults,
  joinTextLines, resultSeconds, resultsCsv, resultsText, usedRows, virtualWindow,
  type ExportNames, type ResultSource,
} from '../decodeResults.js';
import {
  DECODER_SEARCH_ALIASES, decoderPickerAliases, decoderPickerSearchText,
} from '../decoderI18n.js';
import { ALIAS_EXACT, aliasRank, foldAlias } from '../fuzzy.js';
import { getLocale, setLocale } from '../i18n.js';

interface FsLike { readFileSync(p: string, enc: 'utf8'): string }
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs) throw new Error('node fs module unavailable');

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

// ------------------------------------------------------------------ a synthetic UART result

interface Ann { s: number; e: number; cls: number; texts: string[] }
/** rows: 0 = rx-data-bits (cls 12), 1 = rx-data-vals (cls 0), 2 = rx-warnings (cls 10). */
const rowOfClass = new Int32Array(18).fill(-1);
rowOfClass[12] = 0; rowOfClass[0] = 1; rowOfClass[10] = 2;
const ROW_IDS = ['rx-data-bits', 'rx-data-vals', 'rx-warnings'];
const ROW_NAMES = ['RX bits', 'RX data', 'RX warnings'];

function source(anns: readonly Ann[]): ResultSource {
  return {
    start: Int32Array.from(anns, (a) => a.s),
    end: Int32Array.from(anns, (a) => a.e),
    cls: Uint16Array.from(anns, (a) => a.cls),
    rowOfClass,
    textsOf: (i) => anns[i]!.texts,
  };
}

/** One 10-sample character per byte, back to back, plus a data bit per character. */
function uart(text: string, at = 0, gap = 0): Ann[] {
  const out: Ann[] = [];
  let s = at;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const shown = code >= 32 && code <= 126 ? ch : `[${code.toString(16).toUpperCase().padStart(2, '0')}]`;
    out.push({ s: s + 1, e: s + 2, cls: 12, texts: ['1'] });
    out.push({ s, e: s + 10, cls: 0, texts: [shown] });
    s += 10 + gap;
  }
  return out;
}

const order = (anns: readonly Ann[]): number[] =>
  anns.map((_, i) => i).sort((a, b) => anns[a]!.s - anns[b]!.s);

{
  const anns = uart('Hello');
  const src = source(anns);
  const ord = order(anns);
  const used = usedRows(src, ord);
  const rows = defaultResultRows(ROW_IDS, used);
  check('the default rows drop the per-bit row and keep the data row',
    used.join() === '0,1' && rows.has(1) && !rows.has(0) && rows.size === 1,
    `used=${used} rows=${[...rows]}`);
  const onlyBits = defaultResultRows(ROW_IDS, [0]);
  check('a decoder with only bit rows still lists them', onlyBits.has(0) && onlyBits.size === 1,
    `${[...onlyBits]}`);

  const hits = filterResults(src, ord, { rows, query: '', range: null }, ROW_NAMES);
  check('event view: one listed row per data annotation, ordered by start',
    hits.length === 5 && hits.map((i) => anns[i]!.texts[0]).join('') === 'Hello' &&
    hits.every((i, k) => k === 0 || anns[i]!.s > anns[hits[k - 1]!]!.s),
    hits.map((i) => anns[i]!.texts[0]).join(','));

  const lines = joinTextLines(src, hits);
  check('text view joins UART ascii characters into "Hello"',
    lines.length === 1 && lines[0]!.text === 'Hello' && lines[0]!.start === 0 &&
    lines[0]!.cls === -1 && lines[0]!.row === 1 && lines[0]!.ann === hits[0],
    JSON.stringify(lines));

  const q = filterResults(src, ord, { rows, query: 'L', range: null }, ROW_NAMES);
  check('the search filter is a case-insensitive substring over the texts',
    q.length === 2 && q.every((i) => anns[i]!.texts[0] === 'l'), `${q.length}`);
  const byRow = filterResults(src, ord, { rows: null, query: 'rx bits', range: null }, ROW_NAMES);
  check('the search also matches the row name', byRow.length === 5 && byRow.every((i) => anns[i]!.cls === 12),
    `${byRow.length}`);
  const ranged = filterResults(src, ord, { rows, query: '', range: [15, 31] }, ROW_NAMES);
  check('the visible-window range keeps the annotations that overlap it',
    ranged.map((i) => anns[i]!.texts[0]).join('') === 'ell', ranged.map((i) => anns[i]!.texts[0]).join(''));
  const sliced = [
    ...filterResults(src, ord, { rows, query: '', range: null }, ROW_NAMES, 0, 4),
    ...filterResults(src, ord, { rows, query: '', range: null }, ROW_NAMES, 4, 99),
  ];
  check('filtering in slices gives the same rows as one pass', sliced.join() === hits.join(),
    `${sliced} vs ${hits}`);
}

{
  const anns = [...uart('Hi\r\nOK\n'), ...uart('late', 10_000)];
  const src = source(anns);
  const ord = order(anns);
  const hits = filterResults(src, ord, { rows: new Set([1]), query: '', range: null }, ROW_NAMES);
  const lines = joinTextLines(src, hits);
  check('[0A] ends a line, [0D] is dropped, and an idle gap starts a new line',
    lines.map((l) => l.text).join('|') === 'Hi|OK|late' && lines[2]!.start === 10_000,
    JSON.stringify(lines.map((l) => [l.start, l.text])));
}

{
  const anns: Ann[] = [0x48, 0x65, 0x6c].map((b, k) => ({
    s: k * 10, e: k * 10 + 10, cls: 0, texts: [b.toString(16).toUpperCase()],
  }));
  const lines = joinTextLines(source(anns), [0, 1, 2]);
  check('non-character rows (hex bytes) join with a space',
    lines.length === 1 && lines[0]!.text === '48 65 6C', JSON.stringify(lines));
  const warn: Ann[] = [
    { s: 0, e: 10, cls: 0, texts: ['A'] },
    { s: 5, e: 6, cls: 10, texts: ['Frame error'] },
    { s: 10, e: 20, cls: 0, texts: ['B'] },
  ];
  const mixed = joinTextLines(source(warn), [0, 1, 2]);
  check('rows join independently, so a warning does not split the data text',
    mixed.map((l) => `${l.row}:${l.text}`).join('|') === '1:AB|2:Frame error', JSON.stringify(mixed));
}

{
  // sigrok's uart puts the start/stop bits in the data row next to the characters.
  const framed: Ann[] = [];
  'Hi'.split('').forEach((ch, k) => {
    const s = k * 10;
    framed.push({ s, e: s + 1, cls: 2, texts: ['Start bit'] });
    framed.push({ s: s + 1, e: s + 9, cls: 0, texts: [ch] });
    framed.push({ s: s + 9, e: s + 10, cls: 8, texts: ['Stop bit'] });
  });
  const map = Int32Array.from(rowOfClass);
  map[2] = 1; map[8] = 1;
  const classIds = Array.from({ length: 18 }, (_, c) =>
    ({ 0: 'rx-data', 2: 'rx-start', 8: 'rx-stop', 10: 'rx-warning', 12: 'rx-data-bit' } as Record<number, string>)[c] ?? `c${c}`);
  const src: ResultSource = { ...source(framed), rowOfClass: map, classIds };
  const lines = joinTextLines(src, order(framed));
  const events = filterResults(src, order(framed), { rows: null, query: '', range: null }, ROW_NAMES);
  check('the text view leaves out framing (start/stop) annotations; the event view keeps them',
    lines.length === 1 && lines[0]!.text === 'Hi' && lines[0]!.ann === 1 && events.length === 6,
    JSON.stringify(lines));
}

{
  const long = 'x'.repeat(TEXT_LINE_CAP + 10);
  const anns = uart(long);
  const src = source(anns);
  const hits = filterResults(src, order(anns), { rows: new Set([1]), query: '', range: null }, ROW_NAMES);
  const lines = joinTextLines(src, hits);
  check('a joined line wraps at the cap instead of growing without bound',
    lines.length === 2 && lines[0]!.text.length === TEXT_LINE_CAP && lines[1]!.text.length === 10,
    lines.map((l) => l.text.length).join(','));
}

{
  const w = virtualWindow(0, 240, 20, 1_000_000);
  const mid = virtualWindow(20 * 500_000, 240, 20, 1_000_000);
  const end = virtualWindow(20 * 999_990, 240, 20, 1_000_000);
  const empty = virtualWindow(0, 240, 20, 0);
  check('the virtual window builds only the visible rows plus overscan, at any scroll',
    w.first === 0 && w.end === 20 && mid.first === 499_992 && mid.end === 500_020 &&
    end.end === 1_000_000 && end.end - end.first <= 30 && empty.first === 0 && empty.end === 0,
    JSON.stringify({ w, mid, end, empty }));
}

{
  // A million-annotation result: filtering stays index-based and fast.
  const n = 1_000_000;
  const start = new Int32Array(n);
  const endA = new Int32Array(n);
  const cls = new Uint16Array(n);
  for (let i = 0; i < n; i++) { start[i] = i * 10; endA[i] = i * 10 + 10; cls[i] = i % 2 ? 0 : 12; }
  const texts = ['A'];
  const src: ResultSource = { start, end: endA, cls, rowOfClass, textsOf: () => texts };
  const ord = Int32Array.from({ length: n }, (_, i) => i);
  const t0 = performance.now();
  const hits = filterResults(src, ord, { rows: new Set([1]), query: '', range: null }, ROW_NAMES, 0, 50_000);
  const ms = performance.now() - t0;
  check('one filter slice of a huge result is bounded work (50 k of 1 M annotations)',
    hits.length === 25_000 && ms < 200, `${hits.length} hits in ${ms.toFixed(1)} ms`);
}

{
  const anns = uart('a,"b');
  const src = source(anns);
  const names: ExportNames = {
    secondsOf: (s) => resultSeconds(s, 20, 1000),
    timeOf: (s) => `${resultSeconds(s, 20, 1000) * 1000} ms`,
    rowName: (r) => ROW_NAMES[r]!,
    className: (c) => (c === 0 ? 'RX data' : 'RX bit'),
  };
  const hits = filterResults(src, order(anns), { rows: new Set([1]), query: '', range: null }, ROW_NAMES);
  const lines = hits.map((i) => annotationLine(src, i));
  const csv = resultsCsv(lines, names);
  const txt = resultsText(lines, names);
  check('CSV export writes raw seconds from the displayed origin, sample, row, class and quoted text',
    csv === 'time_s,sample,row,class,text\r\n-0.02,0,RX data,RX data,a\r\n-0.01,10,RX data,RX data,","\r\n' +
      '0,20,RX data,RX data,""""\r\n0.01,30,RX data,RX data,b\r\n',
    JSON.stringify(csv));
  check('Copy/TXT writes the displayed time, the row and the text, tab separated',
    txt.split('\n')[0] === '-20 ms\tRX data\ta' && txt.endsWith('\n') && txt.split('\n').length === 5,
    JSON.stringify(txt));
  check('times are relative to the displayed origin (negative before T)',
    resultSeconds(0, 500, 1e6) === -0.0005 && resultSeconds(500, 500, 1e6) === 0 &&
    resultSeconds(1, 0, 0) === 0, `${resultSeconds(0, 500, 1e6)}`);
  check('the clipboard cap is large but finite', CLIPBOARD_LINE_CAP === 100_000, `${CLIPBOARD_LINE_CAP}`);
}

// ------------------------------------------------------------------ analyzer form (M5)

await hydrateDecoders();
{
  const uartInfo = getDecoder('uart');
  const blank = Array.from({ length: 16 }, (_, i) => ({ index: i, name: '' }));
  const m = defaultChannelMapping(uartInfo, blank);
  check('UART (all-optional channels) starts with RX mapped instead of nothing',
    m[0] === 0 && m[1] === undefined && !mapsNoChannel(uartInfo, m), JSON.stringify(m));
  check('a mapping that reads no channel is reported', mapsNoChannel(uartInfo, {}), 'empty');
  const named = blank.map((c) => (c.index === 9 ? { ...c, name: 'RX' } : c.index === 4 ? { ...c, name: 'tx' } : c));
  const mn = defaultChannelMapping(uartInfo, named);
  check('channels named like the decoder channel are picked first', mn[0] === 9 && mn[1] === 4,
    JSON.stringify(mn));
  const i2c = getDecoder('i2c');
  const mi = defaultChannelMapping(i2c, blank.map((c) => (c.index === 7 ? { ...c, name: 'SDA' } : c)));
  check('required channels fill in order around a name match', mi[0] === 0 && mi[1] === 7,
    JSON.stringify(mi));

  const { primary, advanced } = splitDecoderOptions('uart', uartInfo.options);
  check('UART shows baud rate, framing and format up front; packet/invert options are advanced',
    primary.map((o) => o.id).join() === 'baudrate,data_bits,parity,stop_bits,format' &&
    advanced.some((o) => o.id === 'rx_packet_delim') && advanced.some((o) => o.id === 'invert_rx') &&
    primary.length + advanced.length === uartInfo.options.length,
    `${primary.map((o) => o.id)} | ${advanced.map((o) => o.id)}`);
  const spi = splitDecoderOptions('spi', getDecoder('spi').options);
  check('an uncurated decoder keeps its first options up front', spi.primary.length === 5 &&
    spi.advanced.length === 0, `${spi.primary.length}/${spi.advanced.length}`);

  const changed = changedOptions(uartInfo, { format: 'ascii', baudrate: 115200, parity: 'none' });
  check('only options that differ from the decoder default are stored',
    JSON.stringify(changed) === '{"format":"ascii"}', JSON.stringify(changed));

  const analyzers = [
    { id: 'uart-0', channels: { 0: 9 } },
    { id: 'i2c-1', channels: { 0: 0, 1: 1 } },
    { id: 'spi-2', channels: { 0: 2, 3: -1 } },
  ];
  const r8 = reconcileAnalyzers(analyzers, 8);
  const r16 = reconcileAnalyzers(analyzers, 16);
  check('opening a file keeps analyzers whose channels exist and drops the rest',
    r8.kept.map((a) => a.id).join() === 'i2c-1,spi-2' && r8.dropped.map((a) => a.id).join() === 'uart-0' &&
    r16.kept.length === 3 && r16.dropped.length === 0,
    `${r8.kept.map((a) => a.id)} / ${r8.dropped.map((a) => a.id)}`);
}

// ------------------------------------------------------------------ alias search (M8)

{
  const logic = listDecoders().filter(isLogicDecoder).sort((a, b) => a.id.localeCompare(b.id));
  const aliases = decoderPickerAliases(logic);
  const unknown = Object.keys(DECODER_SEARCH_ALIASES).filter((id) => !logic.some((d) => d.id === id));
  check('every alias entry names a decoder the picker lists', unknown.length === 0, JSON.stringify(unknown));
  const bad: string[] = [];
  for (const locale of ['zh-CN', 'en', 'fr', 'ru'] as const) {
    await setLocale(locale);
    const corpus = logic.map((d) => decoderPickerSearchText(d));
    const top = (q: string): string => logic[aliasRank(q, corpus, aliases)[0]?.index ?? -1]?.id ?? '-';
    const want: [string, string][] = [
      ['串口', 'uart'], ['uart', 'uart'], ['UART', 'uart'], ['IIC', 'i2c'], ['I²C', 'i2c'],
      ['i2c', 'i2c'], ['单总线', 'onewire_link'], ['1-Wire', 'onewire_link'], ['1wire', 'onewire_link'],
      ['SPI', 'spi'], ['串行外设接口', 'spi'], ['CAN', 'can'], ['USB', 'usb_signalling'],
      ['spi', 'spi'],
    ];
    for (const [q, id] of want) if (top(q) !== id) bad.push(`${locale}:${q}->${top(q)}`);
    const ir = aliasRank('红外', corpus, aliases).slice(0, 5).map((r) => logic[r.index]!.id);
    if (!ir.every((id) => id.startsWith('ir_'))) bad.push(`${locale}:红外->${ir}`);
    const irEn = aliasRank('IR', corpus, aliases)[0];
    if (!irEn || !logic[irEn.index]!.id.startsWith('ir_') || irEn.score < ALIAS_EXACT) bad.push(`${locale}:IR`);
  }
  await setLocale('en');
  check('protocol aliases rank the expected decoder first in every locale ("串口" finds uart)',
    bad.length === 0 && getLocale() === 'en', bad.join('; ') || 'all hits first');

  const plain = ['uart - x', 'spi - y'];
  const noAliases = aliasRank('spi', plain, [[], []]);
  check('without aliases the ranking is the fuzzy ranking', noAliases.length === 1 && noAliases[0]!.index === 1,
    JSON.stringify(noAliases));
  const prefix = aliasRank('串', ['a', 'b'], [['串口'], []]);
  check('an alias prefix still finds the decoder', prefix.length === 1 && prefix[0]!.index === 0 &&
    prefix[0]!.positions.length === 0, JSON.stringify(prefix));
  check('alias folding ignores case, width, separators and the superscript two',
    foldAlias('I²C') === 'i2c' && foldAlias('1-Wire') === '1wire' && foldAlias(' S/PDIF ') === 'spdif',
    `${foldAlias('I²C')} ${foldAlias('1-Wire')} ${foldAlias(' S/PDIF ')}`);
}

// ------------------------------------------------------------------ wiring (M5/M9)

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const panel = fs.readFileSync('src/ui/analyzerPanel.ts', 'utf8');
  const fin = app.slice(app.indexOf('private finishCapture('), app.indexOf('// ------------------------------------------------------------------ analyzers'));
  const adopt = app.slice(app.indexOf('private adoptCapture('), app.indexOf('private save(): void'));
  const ingest = app.slice(app.indexOf('private async startCapture('), app.indexOf('private async stopCapture('));
  check('auto-decode runs after a capture stops and after a file loads, never in the capture start/ingest path',
    fin.includes('this.scheduleAutoDecode();') && adopt.includes('this.scheduleAutoDecode();') &&
    !ingest.includes('scheduleAutoDecode') && adopt.includes('reconcileAnalyzers(this.analyzers, store.channelCount)'),
    `finish=${fin.includes('this.scheduleAutoDecode();')} adopt=${adopt.includes('this.scheduleAutoDecode();')} ingest=${ingest.includes('scheduleAutoDecode')}`);
  const sched = app.slice(app.indexOf('private scheduleAutoDecode('), app.indexOf('private async updateAnalyzer('));
  check('an auto-decode pass is deferred and abandons itself when the data or capture state changes',
    sched.includes('setTimeout(') && sched.includes('gen !== this.autoDecodeGen') &&
    sched.includes('this.running || this.stopping') && sched.includes('if (!this.autoDecode'),
    sched.slice(0, 120));
  const upd = app.slice(app.indexOf('private async updateAnalyzer('), app.indexOf('private panToAnnotation('));
  check('applying an edit replaces the options and drops the old result before re-decoding',
    upd.includes('a.options = options;') && upd.includes('a.result = null;') &&
    upd.includes('await this.runDecode(a.id)'), 'updateAnalyzer');
  check('the attached name loads the analyzer into the form and the form applies via onUpdate',
    panel.includes('else this.edit(a);') && panel.includes('this.cb.onUpdate(id, channels, options);') &&
    panel.includes('pick.disabled = editing !== null;'), 'analyzerPanel');
  const attachAt = panel.indexOf("button(t('analyzerPanel.attach'), 'primary')");
  const advancedAt = panel.indexOf("more.className = 'analyzer-advanced';");
  check('the Attach/Apply action precedes the collapsed advanced options',
    attachAt > 0 && advancedAt > attachAt && panel.includes('more.open = this.advancedOpen;'),
    `attach@${attachAt} advanced@${advancedAt}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
