// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * "Use it longer": the memory ceiling for a request above it,
 * the panel's ceiling/remaining readout, the typed 'memory' abort, the streamed .lwcap
 * writer (byte-identical to the old one-buffer encoder, with progress and a typed
 * out-of-memory notice), the rate list's over-bandwidth marking, and the analog rate
 * remember/restore/user-override rule. Pure or source-level; no DOM, no device.
 */

import { PlanarSampleStore, channelAcrossGaps, createEdgeStore, generateCapture } from '../../data/index.js';
import type { SampleStore } from '../../data/index.js';
import { SAMPLERATES_HZ } from '../../device/index.js';
import { CHANNEL_COUNTS, bytesPerSampleForChannels, type ChannelCount } from '../../types.js';
import {
  analogRateAfterClamp, analogRateBeforeClamp, analogRateUserEdit, rateChangeMessageKey,
  type AnalogRateMemory, type RateChangeNote,
} from '../analogRateMemory.js';
import {
  captureAbortDetail, isAllocationFailure, saveFailureNotice,
} from '../captureAbort.js';
import { loadLwcap, planLwcap, saveLwcap, writeLwcap } from '../captureIO.js';
import { samplerateOptions } from '../capturePanel.js';
import {
  captureMemoryReadout, capturePostTriggerSamples, captureStoreBudget,
} from '../capturePolicy.js';
import { maxCaptureSeconds } from '../captureTime.js';
import { analogSamplerates } from '../channelBanks.js';
import { formatRate } from '../format.js';
import { setLocale, t } from '../i18n.js';
import { CAPTURE_MEMORY_MAX_BYTES, defaultCaptureSettings, maxCaptureSamples } from '../state.js';

interface FsLike { readFileSync(path: string, encoding: 'utf8'): string }
const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

// ---------------------------------------------------------------- memory ceiling

{
  const want: Record<ChannelCount, number> = {
    4: 2 ** 31 - 1, 8: 2 ** 31 - 1, 16: 2 ** 30, 32: 2 ** 29, 64: 2 ** 28, 128: 2 ** 27,
  };
  const rows = CHANNEL_COUNTS.map((c) => {
    const cap = maxCaptureSamples(c);
    return { c, cap, bytes: cap * bytesPerSampleForChannels(c) };
  });
  check('the capture ceiling is 2 GiB of packed samples per width, under the 2^31 store limit',
    rows.every((r) => r.cap === want[r.c] && r.bytes <= CAPTURE_MEMORY_MAX_BYTES),
    rows.map((r) => `${r.c}ch=${r.cap}`).join(' '));

  const base = { ...defaultCaptureSettings(), channels: 32 as const, samplerate: 50e6 };
  const maximum = captureStoreBudget(
    capturePostTriggerSamples({ ...base, mode: 'single', seconds: maxCaptureSeconds(50e6) }), 32);
  const tooLong = captureStoreBudget(
    capturePostTriggerSamples({ ...base, mode: 'single', seconds: 20 }), 32);
  const fits = captureStoreBudget(
    capturePostTriggerSamples({ ...base, mode: 'single', seconds: 1 }), 32);
  check('a maximum finite request and an over-long request are memory-bound; a request that fits is not',
    maximum.memoryBound && maximum.samples === 2 ** 29 &&
      tooLong.memoryBound && tooLong.samples === 2 ** 29 &&
      !fits.memoryBound && fits.samples === 50e6,
    `maximum=${JSON.stringify(maximum)} tooLong=${JSON.stringify(tooLong)} fits=${JSON.stringify(fits)}`);

  const fresh = captureMemoryReadout(0, 16, 100e6);
  const half = captureMemoryReadout(2 ** 29, 16, 100e6);
  const near = captureMemoryReadout(Math.ceil(2 ** 30 * 0.91), 16, 100e6);
  const full = captureMemoryReadout(2 ** 30 + 5, 16, 100e6);
  check('the readout gives the ceiling and the time left at the rate, warning within 10%',
    fresh.capSamples === 2 ** 30 && fresh.capBytes === 2 ** 31 &&
      Math.abs(fresh.remainingSeconds - 2 ** 30 / 100e6) < 1e-9 && !fresh.warn &&
      Math.abs(half.remainingSeconds - 2 ** 29 / 100e6) < 1e-9 && !half.warn &&
      near.warn && full.warn && full.remainingSeconds === 0,
    `fresh=${JSON.stringify(fresh)} near=${JSON.stringify(near)} full=${JSON.stringify(full)}`);
}

// ---------------------------------------------------------------- typed abort

{
  const result = { samples: 2 ** 29, seconds: 2 ** 29 / 50e6 };
  const en = captureAbortDetail({ cause: 'memory', requestedSeconds: null }, result);
  await setLocale('zh-CN');
  const zh = captureAbortDetail({ cause: 'memory', requestedSeconds: null }, result);
  const zhSave = t('error.saveOutOfMemory');
  const zhRaise = t('capturePanel.rateRaisedAnalog', {
    from: formatRate(10e6), to: formatRate(100e6),
  });
  await setLocale('en');
  check('reaching the ceiling reads "Memory limit reached" (已达内存上限), not Completed',
    en.startsWith('Memory limit reached') && zh.startsWith('已达内存上限'),
    `en=${en} | zh=${zh}`);

  const allocation = new RangeError('Array buffer allocation failed');
  const ceiling = new Error('capture would exceed the 2^31 sample ceiling (2147483648)');
  const notice = saveFailureNotice(allocation);
  check('an allocation failure is recognised; the store ceiling error and others are not',
    isAllocationFailure(allocation) && isAllocationFailure(new Error('Array buffer allocation failed')) &&
      !isAllocationFailure(ceiling) && !isAllocationFailure(new Error('disk full')),
    `ceiling=${isAllocationFailure(ceiling)}`);
  check('a failed save from an allocation surfaces the typed "out of memory" notice',
    notice?.notice.key === 'error.saveOutOfMemory' && saveFailureNotice(ceiling) === undefined &&
      zhSave.startsWith('保存失败：内存不足'),
    `notice=${JSON.stringify(notice)} zh=${zhSave}`);
  check('a forced rate change is announced with both rates',
    zhRaise === '采样率已从 10 MS/s 提高到 100 MS/s（模拟输入需要）。', zhRaise);
}

// ---------------------------------------------------------------- streamed .lwcap

/** The pre-streaming encoder, verbatim in behaviour: one buffer for the whole file. */
function referenceLwcap(store: SampleStore, names: readonly string[]): Uint8Array {
  const n = store.channelCount;
  const len = store.length;
  const edges: Int32Array[] = [];
  const initials: number[] = [];
  for (let c = 0; c < n; c++) {
    const ch = channelAcrossGaps(store, c);
    edges.push(ch.edges);
    initials.push(ch.initial);
  }
  const gaps = store.gaps();
  const nameBlob = new TextEncoder().encode(JSON.stringify(names));
  let bytes = 8 + 4 + 4 + 8 + 8 + 4 + nameBlob.length + gaps.length * 8 + n * 8;
  for (const e of edges) bytes += e.length * 4;
  const buf = new ArrayBuffer(bytes);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const magic = 'LWCAP2\0\0';
  for (let i = 0; i < 8; i++) dv.setUint8(i, magic.charCodeAt(i));
  dv.setUint32(8, n, true);
  dv.setUint32(12, gaps.length, true);
  dv.setFloat64(16, store.samplerate, true);
  dv.setFloat64(24, len, true);
  dv.setUint32(32, nameBlob.length, true);
  u8.set(nameBlob, 36);
  let o = 36 + nameBlob.length;
  for (const g of gaps) { dv.setUint32(o, g.startSample, true); dv.setUint32(o + 4, g.endSample, true); o += 8; }
  for (let c = 0; c < n; c++) {
    dv.setUint8(o, initials[c]!);
    dv.setUint32(o + 4, edges[c]!.length, true);
    o += 8;
  }
  for (const e of edges) for (let i = 0; i < e.length; i++) { dv.setInt32(o, e[i]!, true); o += 4; }
  return u8;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

{
  const planar = new PlanarSampleStore({ channelCount: 16, samplerate: 10e6 });
  for (const chunk of generateCapture({ totalSamples: 120_000, chunkSamples: 7_000 })) planar.append(chunk);
  // A gapped 8-channel edge store: the gap swallows an odd number of edges on ch0, so
  // the writer must carry channelAcrossGaps' synthetic edge exactly as before.
  const gapped = createEdgeStore(8, 1e6, 1_000, Array.from({ length: 8 }, (_, c) => ({
    initial: (c & 1) as 0 | 1,
    edges: Int32Array.from({ length: 20 + c }, (_, i) => 10 + i * 30 + c),
  })), [{ startSample: 205, endSample: 260 }]);
  const names16 = Array.from({ length: 16 }, (_, i) => `D${i}`);
  const names8 = Array.from({ length: 8 }, (_, i) => `ch ${i}`);

  for (const [tag, store, names] of [['planar16', planar, names16], ['gapped8', gapped, names8]] as const) {
    const ref = referenceLwcap(store, names);
    const whole = new Uint8Array(await saveLwcap(store, names).arrayBuffer());
    let partsOk = true;
    let progressOk = true;
    let detail = '';
    for (const partBytes of [4, 12, 1000, 4096, 1 << 20]) {
      const plan = planLwcap(store, names, partBytes);
      const parts: Uint8Array[] = [];
      const seen: number[] = [];
      await writeLwcap(plan, (part) => { parts.push(part); }, (written, total) => {
        if (total !== plan.totalBytes) progressOk = false;
        seen.push(written);
      });
      const bytes = concat(parts);
      // Header plus edge parts, each edge part a whole number of edges within the bound.
      const bounded = parts.slice(1).every((p) => p.byteLength <= Math.max(4, partBytes) &&
        p.byteLength % 4 === 0);
      if (!sameBytes(bytes, ref) || !bounded || plan.totalBytes !== ref.byteLength) {
        partsOk = false;
        detail += ` ${partBytes}:len=${bytes.byteLength}/${ref.byteLength},bounded=${bounded}`;
      }
      const monotonic = seen.every((w, i) => i === 0 || w > seen[i - 1]!);
      if (seen.length !== parts.length || seen[seen.length - 1] !== plan.totalBytes || !monotonic) {
        progressOk = false;
        detail += ` progress@${partBytes}=${seen.length}/${parts.length}`;
      }
    }
    const back = loadLwcap(whole.slice().buffer, `${tag}.lwcap`).store;
    let parsesSame = back.length === store.length && back.gaps().length === store.gaps().length;
    for (let c = 0; c < store.channelCount && parsesSame; c++) {
      const a = channelAcrossGaps(store, c).edges;
      const b = back.edges(c, 0, back.length);
      parsesSame = a.length === b.length && a.every((v, i) => v === b[i]);
    }
    check(`${tag}: the chunked writer emits the old encoder's bytes at every part size`,
      partsOk && sameBytes(whole, ref), detail || `${ref.byteLength} bytes`);
    check(`${tag}: progress fires once per part and ends at the total`, progressOk, detail || 'ok');
    check(`${tag}: the streamed file parses back through the lwcap loader identically`,
      parsesSame, `length ${back.length}/${store.length}`);
  }

  // The sink's allocation failure (or the encoder's) propagates as itself, so save()
  // can turn it into the typed notice instead of a raw "allocation failed" line.
  const plan = planLwcap(planar, names16, 4096);
  let caught: unknown = null;
  let writes = 0;
  try {
    await writeLwcap(plan, () => {
      writes++;
      if (writes === 3) throw new RangeError('Array buffer allocation failed');
    });
  } catch (e) {
    caught = e;
  }
  check('an allocation failure mid-save stops the stream and maps to the typed notice',
    caught instanceof RangeError && writes === 3 &&
      saveFailureNotice(caught)?.notice.key === 'error.saveOutOfMemory',
    `caught=${String(caught)} writes=${writes}`);
}

// ---------------------------------------------------------------- rate list marking

{
  const rates = SAMPLERATES_HZ.filter((hz) => hz <= 200e6);
  const marked = (locale: Parameters<typeof setLocale>[0]) => setLocale(locale).then(() => {
    const opts = samplerateOptions(rates, 50e6);
    return { opts, suffix: t('capturePanel.rateOptionOverAdvised', { rate: '' }).trim() };
  });
  const rows: string[] = [];
  let ok = true;
  for (const locale of ['en', 'zh-CN', 'fr', 'ru'] as const) {
    const { opts } = await marked(locale);
    for (const [value, label] of opts) {
      const plain = formatRate(Number(value));
      const over = Number(value) > 50e6;
      if (over ? !(label.startsWith(plain) && label.length > plain.length) : label !== plain) ok = false;
      if (Number(value) === 100e6) rows.push(`${locale}:${label}`);
    }
    if (opts.length !== rates.length) ok = false;
  }
  await setLocale('zh-CN');
  const zh = samplerateOptions([100e6], 50e6)[0]![1];
  await setLocale('en');
  const none = samplerateOptions(rates, undefined).every(([v, l]) => l === formatRate(Number(v)));
  check('rates above the recommendation are marked before choosing, in all four locales',
    ok && none && zh === '100 MS/s（可能超带宽）', rows.join(' | '));
}

// ---------------------------------------------------------------- analog rate memory

/** The settings clamp's analog rule (`clampCaptureSettings`), for a 200 MS/s ceiling. */
function clamp(rate: number, analog: boolean): number {
  const offered = SAMPLERATES_HZ.filter((hz) => hz <= 200e6);
  if (!analog) return Math.min(rate, 200e6);
  const allowed = analogSamplerates(offered);
  if (allowed.includes(rate)) return rate;
  const below = allowed.filter((hz) => hz <= rate);
  return below[below.length - 1] ?? allowed[0]!;
}

/** One `afterChannelChange` step, as app.ts runs it. */
function toggle(
  state: { rate: number; memory: AnalogRateMemory | null; analog: boolean }, isAnalog: boolean,
): { rate: number; memory: AnalogRateMemory | null; analog: boolean; note: RateChangeNote | null } {
  const input = { wasAnalog: state.analog, isAnalog, rateBefore: state.rate };
  const before = analogRateBeforeClamp(state.memory, input);
  const rateAfter = clamp(before.rate, isAnalog);
  const after = analogRateAfterClamp(before.memory, { ...input, rateAfter, restoring: before.restoring });
  return { rate: rateAfter, memory: after.memory, analog: isAnalog, note: after.note };
}

{
  // Remember on the first group, keep across a second, restore on the last.
  const s0 = { rate: 10e6, memory: null, analog: false };
  const on = toggle(s0, true);
  const second = toggle(on, true);
  const off = toggle(second, false);
  check('the first analog group remembers the pending rate and announces the raise',
    on.rate === 100e6 && on.memory?.pending === 10e6 && on.memory.applied === 100e6 &&
      on.note !== null && rateChangeMessageKey(on.note) === 'capturePanel.rateRaisedAnalog' &&
      on.note.from === 10e6 && on.note.to === 100e6,
    JSON.stringify(on));
  check('another group keeps the memory; the last one off restores and announces it',
    second.note === null && second.memory?.pending === 10e6 &&
      off.rate === 10e6 && off.memory === null && off.note !== null &&
      rateChangeMessageKey(off.note) === 'capturePanel.rateRestoredAnalog',
    `second=${JSON.stringify(second)} off=${JSON.stringify(off)}`);

  // A user pick in between wins: no restore, no note.
  const picked = { ...on, memory: analogRateUserEdit(on.memory, 200e6), rate: 200e6 };
  const offPicked = toggle(picked, false);
  const same = { ...on, memory: analogRateUserEdit(on.memory, 100e6) };
  check('a rate the user picked in between is kept when the last group goes off',
    picked.memory === null && offPicked.rate === 200e6 && offPicked.note === null &&
      same.memory?.pending === 10e6,
    `picked=${JSON.stringify(offPicked)}`);

  // An analog-legal rate is not moved, so there is nothing to restore or announce.
  const legal = toggle(toggle({ rate: 200e6, memory: null, analog: false }, true), false);
  // A rate above the ADC floor that is not a PLL divisor is lowered, and said so.
  const lowered = toggle({ rate: 125e6, memory: null, analog: false }, true);
  check('an ADC-legal rate is untouched; a non-divisor is lowered with its own note',
    legal.rate === 200e6 && legal.note === null &&
      (!SAMPLERATES_HZ.includes(125e6) || (lowered.rate === 100e6 && lowered.note !== null &&
        rateChangeMessageKey(lowered.note) === 'capturePanel.rateLoweredAnalog')),
    `legal=${JSON.stringify(legal)} lowered=${JSON.stringify(lowered)}`);
}

// ---------------------------------------------------------------- wiring

{
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const sinkStart = app.indexOf('await device.start(cfg, (chunk) => {');
  const sink = app.slice(sinkStart, app.indexOf('onTriggerState: (state, triggerSampleIndex) => {', sinkStart));
  const save = app.slice(app.indexOf('private async save(format: CaptureFileFormat)'),
    app.indexOf('private setSaveProgress('));
  check('the sink stops through captureFilled and turns allocation failures into a typed abort',
    sinkStart > 0 && !sink.includes("stopCapture('completed')") &&
      (sink.match(/this\.captureFilled\(\)/g) ?? []).length >= 4 &&
      (sink.match(/this\.captureOutOfMemory\(e\)/g) ?? []).length === 4 &&
      app.includes('this.applyCaptureMemoryCeiling(isLoop, cfg.channels);') &&
      app.includes("cause: 'memory',"),
    `filled=${(sink.match(/this\.captureFilled\(\)/g) ?? []).length}`);
  check('both save paths stream bounded parts with progress and the typed failure notice',
    save.includes('planLwcap(store, this.channels.map((c) => c.name))') &&
    !save.includes('saveLwcap(store,') &&
      (save.match(/this\.writeLwcapWithProgress\(/g) ?? []).length === 2 &&
      save.includes("this.fail('error.save', e, undefined, saveFailureNotice(e));"),
    'save()');
  const toggleAt = app.indexOf('private afterChannelChange(): void {');
  const after = app.slice(toggleAt, app.indexOf('private reorder(', toggleAt));
  check('the analog toggle path remembers, restores and announces the rate',
    after.includes('analogRateBeforeClamp(this.analogRateMemory, transition)') &&
      after.includes('this.rateChange = after.note;') &&
      app.includes('this.analogRateMemory = analogRateUserEdit(this.analogRateMemory, next.samplerate);'),
    'afterChannelChange');
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
