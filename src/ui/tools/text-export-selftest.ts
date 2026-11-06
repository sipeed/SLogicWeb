// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * `.vcd` / `.csv` export (src/ui/textExport.ts).
 *
 *   npm test -- --filter text-export
 *
 * Pinned by an independent tiny VCD reader (timescale, $var count, unique identifiers,
 * $dumpvars, strictly increasing #times, value changes rebuilt into per-channel edge
 * lists that must equal the store's) and a CSV reader (line count = 1 + channels + edges,
 * rows in sample order, levels alternating from the initial level), for every store width
 * 4..128, with tiny chunks so lines split across parts. Boundedness: every part stays
 * within the chunk budget, and a 2^31-sample capture with a handful of edges exports in
 * milliseconds to a few hundred bytes - the work follows edges, never samples.
 */

import { channelAcrossGaps, createEdgeStore } from '../../data/index.js';
import type { SampleStore } from '../../data/types.js';
import type { ChannelCount } from '../../types.js';
import { MAX_SAMPLES } from '../../types.js';
import { diagnosticOf } from '../../diagnostics.js';
import {
  EdgeMerger, csvExportParts, csvField, vcdExportParts, vcdIdentifier, vcdName, vcdTimescale,
  type ExportChannel,
} from '../textExport.js';

const nodeProcess = (globalThis as { process?: { exit(code: number): never } }).process!;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`PASS  ${name}`); } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function generatedStore(width: ChannelCount, length: number, seed: number, rate = 25e6, gaps = false): SampleStore {
  let x = seed >>> 0 || 1;
  const rnd = (): number => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
  const channels = Array.from({ length: width }, (_, c) => {
    const edges: number[] = [];
    let p = 0;
    const meanGap = 1 + (c % 7) * 3;
    for (;;) {
      p += 1 + Math.floor(rnd() * meanGap * 2);
      if (p >= length) break;
      edges.push(p);
    }
    return { initial: (c & 1) as 0 | 1, edges: new Int32Array(edges) };
  });
  const spans = gaps ? [{ startSample: Math.floor(length / 3), endSample: Math.floor(length / 3) + 17 }] : undefined;
  return createEdgeStore(width, rate, length, channels, spans);
}

function text(parts: Iterable<Uint8Array>): { text: string; sizes: number[] } {
  const dec = new TextDecoder();
  let out = '';
  const sizes: number[] = [];
  for (const p of parts) { sizes.push(p.length); out += dec.decode(p, { stream: true }); }
  return { text: out + dec.decode(), sizes };
}

interface ParsedVcd {
  timescale: string;
  vars: Array<{ id: string; name: string }>;
  initial: Map<string, number>;
  /** id -> sample positions of value changes */
  changes: Map<string, number[]>;
  times: number[];
  end: number;
  problems: string[];
}

/** An independent, deliberately small VCD reader for the subset the exporter writes. */
function parseVcd(src: string, ticksPerSample: number): ParsedVcd {
  const problems: string[] = [];
  const header = src.split('$enddefinitions $end')[0] ?? '';
  const body = src.split('$enddefinitions $end')[1] ?? '';
  const timescale = /\$timescale\s+(\S+ \S+)\s+\$end/.exec(header)?.[1] ?? '';
  const vars = [...header.matchAll(/\$var wire 1 (\S+) (\S+) \$end/g)].map((m) => ({ id: m[1]!, name: m[2]! }));
  const initial = new Map<string, number>();
  const changes = new Map<string, number[]>(vars.map((v) => [v.id, []]));
  const times: number[] = [];
  let now = -1;
  let inDump = false;
  for (const line of body.split('\n')) {
    if (line === '') continue;
    if (line === '$dumpvars') { inDump = true; continue; }
    if (line === '$end') { inDump = false; continue; }
    if (line.startsWith('#')) {
      const t = Number(line.slice(1));
      if (!(t > now)) problems.push(`time ${t} after ${now}`);
      now = t;
      times.push(t);
      continue;
    }
    const v = Number(line[0]);
    const id = line.slice(1);
    if (!changes.has(id)) { problems.push(`unknown id ${id}`); continue; }
    if (inDump) { initial.set(id, v); continue; }
    if (now % ticksPerSample !== 0) problems.push(`time ${now} is not a whole sample`);
    changes.get(id)!.push(now / ticksPerSample);
  }
  return { timescale, vars, initial, changes, times, end: times[times.length - 1] ?? -1, problems };
}

function sameList(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function allChannels(store: SampleStore): ExportChannel[] {
  return Array.from({ length: store.channelCount }, (_, i) => ({ index: i, name: `ch ${i}` }));
}

// ---------------------------------------------------------------- timescale & ids
{
  const cases: Array<[number, string, number, boolean]> = [
    [25e6, '10 ns', 4, true], [16e6, '100 ps', 625, true], [1e9, '1 ns', 1, true],
    [1.6e9, '1 ps', 625, true], [100, '10 ms', 1, true], [1, '1 s', 1, true],
    [200e6, '1 ns', 5, true], [3e6, '1 ps', 1e12 / 3e6, false],
  ];
  const wrong = cases.filter(([rate, label, ticks, exact]) => {
    const ts = vcdTimescale(rate);
    return ts.label !== label || Math.abs(ts.ticksPerSample - ticks) > 1e-6 || ts.exact !== exact;
  }).map(([rate]) => `${rate}=${JSON.stringify(vcdTimescale(rate))}`);
  check('the timescale is the largest unit holding a whole sample period (1 ps rounded otherwise)',
    wrong.length === 0, wrong.join('; '));
  const ids = Array.from({ length: 9000 }, (_, i) => vcdIdentifier(i));
  check('identifier codes are printable, whitespace-free and unique',
    ids[0] === '!' && ids[93] === '~' && ids[94] === '!!' && new Set(ids).size === ids.length &&
    ids.every((id) => /^[!-~]+$/.test(id)), `${ids[0]} ${ids[93]} ${ids[94]} ${ids[8999]}`);
  check('var names lose whitespace, never empty',
    vcdName('SDA line', 3) === 'SDA_line' && vcdName('  ', 5) === 'D5' && vcdName('a\tb\nc', 0) === 'a_b_c');
  check('CSV fields are quoted when needed and never read as formulas',
    csvField('SDA') === 'SDA' && csvField('a,b') === '"a,b"' && csvField('say "hi"') === '"say ""hi"""' &&
    csvField('=1+1') === "'=1+1" && csvField('-x') === "'-x" && csvField('@a,b') === `"'@a,b"`);
}

// ---------------------------------------------------------------- merge
{
  const m = new EdgeMerger([new Int32Array([5, 9]), new Int32Array([1, 5]), new Int32Array(0), new Int32Array([7])]);
  const got: string[] = [];
  while (m.next()) got.push(`${m.pos}:${m.channel}`);
  check('edges merge in time order, ties in channel order', got.join(',') === '1:1,5:0,5:1,7:3,9:0', got.join(','));
}

// ---------------------------------------------------------------- VCD round trip
{
  const bad: string[] = [];
  for (const width of [4, 8, 16, 32, 64, 128] as ChannelCount[]) {
    for (const gaps of [false, true]) {
      const store = generatedStore(width, 3000, width * 7 + (gaps ? 1 : 0), 25e6, gaps);
      const chans = allChannels(store);
      const { text: vcd } = text(vcdExportParts(store, chans, { chunkChars: 97 }));
      const ts = vcdTimescale(store.samplerate);
      const parsed = parseVcd(vcd, ts.ticksPerSample);
      const tag = `${width}ch${gaps ? '+gap' : ''}`;
      if (parsed.timescale !== '10 ns') bad.push(`${tag} timescale ${parsed.timescale}`);
      if (parsed.vars.length !== width) bad.push(`${tag} vars ${parsed.vars.length}`);
      if (parsed.vars[1]?.name !== 'ch_1') bad.push(`${tag} name ${parsed.vars[1]?.name}`);
      if (parsed.problems.length) bad.push(`${tag} ${parsed.problems.slice(0, 3).join('; ')}`);
      if (parsed.end !== store.length * ts.ticksPerSample) bad.push(`${tag} end ${parsed.end}`);
      for (let c = 0; c < width; c++) {
        const want = channelAcrossGaps(store, c);
        const id = parsed.vars[c]!.id;
        if (parsed.initial.get(id) !== want.initial) bad.push(`${tag} ch${c} initial`);
        if (!sameList(parsed.changes.get(id)!, want.edges)) { bad.push(`${tag} ch${c} edges`); break; }
      }
    }
  }
  check('VCD of every width (and across a gap) rebuilds each channel\'s edges exactly',
    bad.length === 0, bad.slice(0, 6).join(' | '));

  // A subset in another order of names, at an inexact rate: times are rounded, still ordered.
  const store = generatedStore(16, 2000, 99, 3e6);
  const subset = [{ index: 9, name: 'CLK' }, { index: 2, name: 'DATA' }];
  const { text: vcd } = text(vcdExportParts(store, subset, { date: 'Fri Nov  6 2026' }));
  const lines = vcd.split('\n');
  const times = lines.filter((l) => l.startsWith('#')).map((l) => Number(l.slice(1)));
  const ordered = times.every((t, i) => i === 0 || t > times[i - 1]!);
  const expectT = Math.round(channelAcrossGaps(store, 9).edges[0]! * 1e12 / 3e6);
  check('an inexact rate rounds to 1 ps, keeps times ordered, and exports only the chosen channels',
    vcd.includes('$timescale 1 ps $end') && vcd.includes('times rounded to 1 ps') &&
    vcd.startsWith('$date\n  Fri Nov  6 2026\n$end') && ordered &&
    (vcd.match(/\$var wire/g) ?? []).length === 2 && vcd.includes('$var wire 1 ! CLK $end') &&
    times.includes(expectT), `ordered=${ordered}, first CLK at ${expectT}`);
}

// ---------------------------------------------------------------- CSV
{
  const bad: string[] = [];
  for (const width of [4, 8, 16, 32, 64, 128] as ChannelCount[]) {
    const store = generatedStore(width, 2500, width + 3);
    const chans = allChannels(store);
    const { text: csv } = text(csvExportParts(store, chans, { chunkChars: 61 }));
    const lines = csv.split('\n');
    if (lines.pop() !== '') bad.push(`${width}: no trailing newline`);
    let edges = 0;
    for (let c = 0; c < width; c++) edges += channelAcrossGaps(store, c).edges.length;
    if (lines.length !== 1 + width + edges) bad.push(`${width}: ${lines.length} lines, want ${1 + width + edges}`);
    if (lines[0] !== 'time_s,sample,channel,level') bad.push(`${width}: header ${lines[0]}`);
    const level = new Map<string, number>();
    let lastSample = 0;
    for (let i = 1; i < lines.length; i++) {
      const [time, sample, name, lv] = lines[i]!.split(',');
      const p = Number(sample);
      if (p < lastSample) { bad.push(`${width}: row ${i} out of order`); break; }
      lastSample = p;
      if (Math.abs(Number(time) - p / store.samplerate) > 1e-12) { bad.push(`${width}: time ${time} for ${p}`); break; }
      const prev = level.get(name!);
      if (i <= width) {
        if (p !== 0) bad.push(`${width}: initial row at ${p}`);
      } else if (prev === undefined || Number(lv) !== 1 - prev) {
        bad.push(`${width}: ${name} level ${lv} after ${prev}`); break;
      }
      level.set(name!, Number(lv));
    }
  }
  check('CSV of every width: header + one initial row per channel + one row per edge, in order',
    bad.length === 0, bad.slice(0, 6).join(' | '));
}

// ---------------------------------------------------------------- boundedness
{
  const store = generatedStore(128, 20000, 5);
  const chans = allChannels(store);
  const limit = 4096;
  const v = text(vcdExportParts(store, chans, { chunkChars: limit }));
  const c = text(csvExportParts(store, chans, { chunkChars: limit }));
  const maxV = Math.max(...v.sizes);
  const maxC = Math.max(...c.sizes);
  // The header of 128 $var lines is the one part allowed past the budget.
  const bodyV = Math.max(...v.sizes.slice(1));
  check('parts stay within the chunk budget (a part may exceed it by one line)',
    v.sizes.length > 10 && c.sizes.length > 10 && bodyV <= limit + 64 && maxC <= limit + 64 &&
    maxV <= limit + 64 * 128, `vcd parts=${v.sizes.length} max=${maxV} body=${bodyV}, csv parts=${c.sizes.length} max=${maxC}`);

  const huge = createEdgeStore(8, 1e9, MAX_SAMPLES - 1, Array.from({ length: 8 }, (_, ch) => ({
    initial: 0 as const, edges: new Int32Array([1000 + ch, 2 ** 30, 2 ** 31 - 10]),
  })));
  const t0 = performance.now();
  const hv = text(vcdExportParts(huge, allChannels(huge)));
  const hc = text(csvExportParts(huge, allChannels(huge)));
  const ms = performance.now() - t0;
  const bytes = hv.text.length + hc.text.length;
  check('a 2^31-sample capture with few edges exports in edge time, not sample time',
    ms < 1000 && bytes < 4000 && hv.text.trimEnd().endsWith(`#${MAX_SAMPLES - 1}`) &&
    hc.text.split('\n').length === 1 + 1 + 8 + 24, `${ms.toFixed(1)} ms, ${bytes} chars`);
}

// ---------------------------------------------------------------- refusals
{
  const empty = createEdgeStore(4, 1e6, 0, Array.from({ length: 4 }, () => ({ initial: 0 as const, edges: new Int32Array(0) })));
  const codeOf = (run: () => unknown): string => {
    try { run(); return 'no throw'; } catch (e) { return diagnosticOf(e)?.code ?? String(e); }
  };
  const store = generatedStore(4, 100, 1);
  // Thrown at the call, before any part is pulled (the caller snapshots before awaiting).
  const codes = [
    codeOf(() => vcdExportParts(empty, allChannels(empty))),
    codeOf(() => csvExportParts(empty, allChannels(empty))),
    codeOf(() => vcdExportParts(store, [])),
    codeOf(() => csvExportParts(store, [])),
  ];
  check('an empty capture or no channel refuses at the call with a typed diagnostic',
    codes.join(',') === 'io.nothingToSave,io.nothingToSave,io.exportNoChannels,io.exportNoChannels', codes.join(','));
}

console.log(`\n${passed}/${passed + failures.length} passed`);
nodeProcess.exit(failures.length === 0 ? 0 : 1);
