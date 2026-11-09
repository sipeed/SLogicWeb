// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the .lwcap round-trip suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/lwcap-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/slogicweb-lwcap-tests.mjs && node /tmp/slogicweb-lwcap-tests.mjs
 *
 * Exits non-zero on the first failure. The format is ours (src/ui/captureIO.ts), so a
 * bug here is a silent data-loss bug for every user who saves a capture: the suite pins
 *
 *   - gapless round trip stays byte-identical (edges, initial levels, queries),
 *   - gap spans survive save -> load -> save,
 *   - a gapped capture loads with the same bit3 columns and the same bits on BOTH sides of
 *     the gap (the post-gap half is the one that caught the parity inversion),
 *   - v1 files (written before gap support) still load as gapless,
 *   - corrupt v2 spans throw instead of being silently merged.
 */

import { PlanarSampleStore, generateCapture } from '../../data/index.js';
import type { SampleStore } from '../../data/index.js';
import { diagnosticOf } from '../../diagnostics.js';
import type { Diagnostic } from '../../diagnostics.js';
import { CHANNEL_COUNTS } from '../../types.js';
import { formatDiagnostic } from '../format.js';
import { saveLwcap, loadLwcap, loadFiles, levelAt } from '../captureIO.js';
import { defaultChannels } from '../state.js';

const nodeProcess = (() => {
  const p = (globalThis as { process?: { exit(code: number): never } }).process;
  if (!p || typeof p.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return p;
})();

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: TestResult[] = [];

function buildPlanar(chunkSamples: number): PlanarSampleStore {
  const total = 200000;
  const store = new PlanarSampleStore({ channelCount: 16, samplerate: 10e6 });
  for (const chunk of generateCapture({ totalSamples: total, chunkSamples })) {
    store.append(chunk);
  }
  return store;
}

async function thrown(
  fn: () => unknown,
): Promise<{ code: string; diag: Diagnostic | null; payload: string | null }> {
  try {
    await fn();
  } catch (e) {
    const d = diagnosticOf(e);
    if (d) return { code: d.code, diag: d, payload: d.payload ?? null };
    return {
      code: `not a diagnostic: ${e instanceof Error ? e.message : String(e)}`,
      diag: null,
      payload: null,
    };
  }
  return { code: 'did not throw', diag: null, payload: null };
}

function compareStores(a: SampleStore, b: SampleStore, tag: string): string | null {
  if (a.length !== b.length) return `${tag}: length ${a.length} != ${b.length}`;
  const n = a.length;
  for (let c = 0; c < 16; c++) {
    const ea = a.edges(c, 0, n);
    const eb = b.edges(c, 0, n);
    if (ea.length !== eb.length || ea.some((v, i) => v !== eb[i])) return `${tag}: ch${c} edges differ`;
    if (levelAt(a, c, 0) !== levelAt(b, c, 0)) return `${tag}: ch${c} initial differs`;
  }
  for (const [s, e, bins] of [[0, n, 1000], [0, n, 97], [12345, 54321, 3200], [n - 100, n, 1000]] as Array<[number, number, number]>) {
    for (let c = 0; c < 16; c++) {
      const va = a.query(c, s, e, bins);
      const vb = b.query(c, s, e, bins);
      for (let i = 0; i < bins; i++) {
        if (va.packed[i] !== vb.packed[i]) return `${tag}: ch${c} [${s},${e}) x${bins} col ${i}: ${va.packed[i]} vs ${vb.packed[i]}`;
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const names = Array.from({ length: 16 }, (_, i) => `Channel ${i}`);

  // 1. Gapless round trip.
  {
    const store = buildPlanar(4099);
    const blob = saveLwcap(store, names);
    const loaded = loadLwcap(await blob.arrayBuffer(), 'gapless.lwcap');
    const fail = compareStores(store, loaded.store, 'gapless round trip');
    results.push({
      name: 'gapless round trip byte-identical',
      pass: fail === null,
      detail: fail ?? `${blob.size} bytes, ${store.length} samples, edges and queries verified`,
    });
  }

  // 2. Gapped round trip: spans survive, bit3 identical, bits identical on both sides of
  //    the gap. Only columns intersecting the gap are exempt.
  {
    const store = buildPlanar(4099);
    store.noteGap(40000, 90000);
    store.noteGap(120000, 120001);
    store.noteGap(60000, 150000); // merges into [40000, 150000)
    const G0 = 40000, G1 = 150000;
    const blob = saveLwcap(store, names);
    const loaded = loadLwcap(await blob.arrayBuffer(), 'gapped.lwcap');

    const spans = loaded.store.gaps();
    const spansOk = spans.length === 1 && spans[0]!.startSample === G0 && spans[0]!.endSample === G1;

    const n = store.length;
    let qFail = '';
    let checked = 0;
    for (const [s, e, bins] of [[0, n, 1000], [0, n, 97], [50000, 140000, 3200], [n - 100, n, 1000]] as Array<[number, number, number]>) {
      if (qFail) break;
      for (let c = 0; c < 16 && !qFail; c++) {
        const a = store.query(c, s, e, bins);
        const b = loaded.store.query(c, s, e, bins);
        const width = e - s;
        for (let i = 0; i < bins && !qFail; i++) {
          const c0 = s + Math.floor((i * width) / bins);
          const c1 = s + Math.floor(((i + 1) * width) / bins);
          const gapHit = c0 < G1 && c1 > G0;
          if (((a.packed[i]! ^ b.packed[i]!) & 8) !== 0) {
            qFail = `ch${c} [${s},${e}) x${bins} col ${i}: bit3 differs`;
            break;
          }
          if (!gapHit && (a.low[i] !== b.low[i] || a.high[i] !== b.high[i] || a.edge[i] !== b.edge[i])) {
            qFail = `ch${c} [${s},${e}) x${bins} col ${i}: ${c0 >= G1 ? 'post' : 'pre'}-gap bits differ`;
            break;
          }
          checked++;
        }
      }
    }
    // Round-trip stability: save the loaded store again, spans must be unchanged.
    const blob2 = saveLwcap(loaded.store, names);
    const loaded2 = loadLwcap(await blob2.arrayBuffer(), 'gapped2.lwcap');
    const spans2 = loaded2.store.gaps();
    const stable = spans2.length === 1 && spans2[0]!.startSample === G0 && spans2[0]!.endSample === G1;

    results.push({
      name: 'gap spans survive save -> load -> save',
      pass: spansOk && qFail === '' && stable,
      detail: qFail
        ? qFail
        : (spansOk && stable ? `[${G0}, ${G1}), ${checked} columns verified` : `spans: first=${spansOk}, second=${stable}`),
    });

    // Edges: the gapped round trip filters gap transitions like the source store.
    let eFail = '';
    for (let c = 0; c < 16 && !eFail; c++) {
      const a = store.edges(c, 0, n);
      const b = loaded.store.edges(c, 0, n);
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) eFail = `ch${c} (${a.length} vs ${b.length})`;
    }
    results.push({
      name: 'gapped round trip filters the same edges',
      pass: eFail === '',
      detail: eFail ? eFail : '16 channels byte-identical',
    });
  }

  // 3. A v1 file still loads as gapless.
  {
    const store = buildPlanar(4099);
    const blob = saveLwcap(store, names);
    const u8 = new Uint8Array(await blob.arrayBuffer());
    for (let i = 0; i < 8; i++) u8[i] = 'LWCAP1\0\0'.charCodeAt(i);
    u8[12] = 0; u8[13] = 0; u8[14] = 0; u8[15] = 0;
    const loaded = loadLwcap(u8.buffer, 'v1.lwcap');
    const fail = compareStores(store, loaded.store, 'v1 file');
    const gapless = loaded.store.gaps().length === 0;
    results.push({
      name: 'v1 file loads and carries no gaps',
      pass: fail === null && gapless,
      detail: fail ?? `loaded, gaps=${loaded.store.gaps().length}`,
    });
  }

  // 4. Corrupt v2 spans throw, not merge.
  {
    const store = buildPlanar(4099);
    store.noteGap(40000, 90000);
    const blob = saveLwcap(store, names);
    const ab = await blob.arrayBuffer();
    const bad: string[] = [];
    for (const [name, s, e] of [
      ['reversed span', 90000, 40000],
      ['span past length', 1000, 99999999],
    ] as Array<[string, number, number]>) {
      const u8 = new Uint8Array(ab.slice(0));
      const dv = new DataView(u8.buffer);
      const nameLen = dv.getUint32(32, true);
      const o = 36 + nameLen;
      dv.setUint32(o, s, true);
      dv.setUint32(o + 4, e, true);
      const got = await thrown(() => loadLwcap(u8.buffer, `corrupt-${name}.lwcap`));
      if (got.code !== 'file.lwcap.gapSpan') bad.push(`${name}: ${got.code}`);
    }
    results.push({
      name: 'corrupt v2 spans throw instead of loading',
      pass: bad.length === 0,
      detail: bad.length === 0
        ? 'reversed and past-length spans both threw file.lwcap.gapSpan'
        : `wrong code: ${bad.join(', ')}`,
    });
  }

  // 5. Default and custom channel names round trip.
  {
    const store = buildPlanar(4099);
    const defaults = defaultChannels(16).map((c) => c.name);
    const wantDefaults = Array.from({ length: 16 }, (_, i) => `D${i}`);
    const loadedDefaults = loadLwcap(await saveLwcap(store, defaults).arrayBuffer(), 'default-names.lwcap');
    const defaultsSame = loadedDefaults.channelNames.length === wantDefaults.length &&
      loadedDefaults.channelNames.every((n, i) => n === wantDefaults[i]);
    const noEmpties = loadedDefaults.channelNames.every((n) => n !== '');
    const defaultFail = compareStores(store, loadedDefaults.store, 'default names');
    results.push({
      name: 'default channel names save as D<index> and load back non-empty',
      pass: defaultsSame && noEmpties && defaultFail === null,
      detail: defaultsSame && noEmpties && defaultFail === null
        ? loadedDefaults.channelNames.join(', ')
        : defaultFail ?? `${JSON.stringify(loadedDefaults.channelNames)} (want ${wantDefaults.join(', ')})`,
    });

    const custom = defaults.map((n, i) => (i === 1 ? 'SDA' : i === 4 ? 'I2C SCL' : n));
    const loadedCustom = loadLwcap(await saveLwcap(store, custom).arrayBuffer(), 'custom-names.lwcap');
    const customFail = compareStores(store, loadedCustom.store, 'custom names');
    const customSame = loadedCustom.channelNames.length === custom.length &&
      loadedCustom.channelNames.every((n, i) => n === custom[i]);
    results.push({
      name: 'custom channel names round trip unchanged',
      pass: customSame && customFail === null,
      detail: customSame && customFail === null
        ? loadedCustom.channelNames.join(', ')
        : customFail ?? `${JSON.stringify(loadedCustom.channelNames)} (want ${JSON.stringify(custom)})`,
    });
  }

  {
    const store = buildPlanar(4099);
    store.noteGap(100, 200);
    store.noteGap(300, 400);
    const ab = await saveLwcap(store, names).arrayBuffer();
    const dv0 = new DataView(ab);
    const nameLen = dv0.getUint32(32, true);
    const gapOff = 36 + nameLen;
    const channelCount = dv0.getUint32(8, true);
    const gapCount = dv0.getUint32(12, true);
    const headerOff = gapOff + gapCount * 8;
    const sampleLength = dv0.getFloat64(24, true);
    const layout: { header: number; edges: number; count: number }[] = [];
    let edgeCursor = headerOff + channelCount * 8;
    for (let c = 0; c < channelCount; c++) {
      const count = dv0.getUint32(headerOff + c * 8 + 4, true);
      layout.push({ header: headerOff + c * 8, edges: edgeCursor, count });
      edgeCursor += count * 4;
    }
    const busy = layout.find((c) => c.count >= 2);
    if (!busy) throw new Error('fixture: expected a channel with two edges');
    const mutate = (edit: (dv: DataView, u8: Uint8Array) => void): ArrayBuffer => {
      const u8 = new Uint8Array(ab.slice(0));
      edit(new DataView(u8.buffer), u8);
      return u8.buffer;
    };
    const badMagic = (): ArrayBuffer => mutate((_dv, u8) => { u8[0] = 0x58; });
    const reversedSpan = (): ArrayBuffer => mutate((dv) => {
      dv.setUint32(gapOff, 90000, true);
      dv.setUint32(gapOff + 4, 40000, true);
    });
    const badChannelCount = (): ArrayBuffer => mutate((dv) => dv.setUint32(8, 7, true));
    const badNames = (): ArrayBuffer => mutate((dv, u8) => {
      u8.set([0x7b, 0x7b, 0x7b, 0x7b], 36);
      dv.setUint32(32, 4, true);
    });
    const badNamesShape = (): ArrayBuffer => mutate((_dv, u8) => {
      const text = new TextEncoder().encode('[1,2,3,4]');
      u8.fill(0x20, 36, 36 + nameLen);
      u8.set(text, 36);
    });
    const cases: [string, string, () => unknown][] = [
      ['short buffer', 'file.lwcap.header',
        () => loadLwcap(ab.slice(0, 4), 'short-buffer.lwcap')],
      ['truncated header after a valid magic', 'file.lwcap.header',
        () => loadLwcap(ab.slice(0, 20), 'short-header.lwcap')],
      ['bad magic', 'file.lwcap.magic',
        () => loadLwcap(badMagic(), 'bad-magic.lwcap')],
      ['unsupported channel count', 'file.lwcap.channels',
        () => loadLwcap(badChannelCount(), 'bad-channels.lwcap')],
      ['implausible length', 'file.lwcap.length',
        () => loadLwcap(mutate((dv) => dv.setFloat64(24, -1, true)), 'bad-length.lwcap')],
      ['fractional length', 'file.lwcap.length',
        () => loadLwcap(
          mutate((dv) => dv.setFloat64(24, sampleLength + 0.5, true)), 'fractional-length.lwcap')],
      ['zero samplerate', 'file.lwcap.samplerate',
        () => loadLwcap(mutate((dv) => dv.setFloat64(16, 0, true)), 'zero-samplerate.lwcap')],
      ['NaN samplerate', 'file.lwcap.samplerate',
        () => loadLwcap(mutate((dv) => dv.setFloat64(16, Number.NaN, true)), 'nan-samplerate.lwcap')],
      ['name blob past the end', 'file.lwcap.namesTruncated',
        () => loadLwcap(mutate((dv) => dv.setUint32(32, 0xfffffff0, true)), 'bad-names-len.lwcap')],
      ['unreadable names JSON', 'file.lwcap.namesInvalid',
        () => loadLwcap(badNames(), 'bad-names-json.lwcap')],
      ['channel names that are not strings', 'file.lwcap.namesInvalid',
        () => loadLwcap(badNamesShape(), 'bad-names-shape.lwcap')],
      ['gap span past the end', 'file.lwcap.gapTruncated',
        () => loadLwcap(ab.slice(0, gapOff), 'gap-past-end.lwcap')],
      ['reversed gap span', 'file.lwcap.gapSpan',
        () => loadLwcap(reversedSpan(), 'corrupt-gap.lwcap')],
      ['overlapping gap spans', 'file.lwcap.gapOrder',
        () => loadLwcap(mutate((dv) => dv.setUint32(gapOff + 8, 150, true)), 'gap-order.lwcap')],
      ['channel headers past the end', 'file.lwcap.channelHeaders',
        () => loadLwcap(ab.slice(0, gapOff + 16 + names.length * 8 - 1), 'headers-past-end.lwcap')],
      ['initial level outside 0 or 1', 'file.lwcap.initial',
        () => loadLwcap(mutate((dv) => dv.setUint8(busy.header, 2)), 'bad-initial.lwcap')],
      ['trailing bytes', 'file.lwcap.edgeBytes', () => {
        const u8 = new Uint8Array(ab.byteLength + 1);
        u8.set(new Uint8Array(ab));
        return loadLwcap(u8.buffer, 'trailing.lwcap');
      }],
      ['edge at sample 0', 'file.lwcap.edgeRange',
        () => loadLwcap(mutate((dv) => dv.setInt32(busy.edges, 0, true)), 'edge-zero.lwcap')],
      ['edge at the capture length', 'file.lwcap.edgeRange',
        () => loadLwcap(
          mutate((dv) => dv.setInt32(busy.edges, sampleLength, true)), 'edge-past-length.lwcap')],
      ['edges that are not strictly increasing', 'file.lwcap.edgeOrder',
        () => loadLwcap(mutate((dv) =>
          dv.setInt32(busy.edges + 4, dv.getInt32(busy.edges, true), true)), 'edge-order.lwcap')],
      ['no files', 'file.noFiles', () => loadFiles([])],
      ['nothing loadable', 'file.unsupported',
        () => loadFiles([new File(['x'], 'notes.txt'), new File(['y'], 'readme.md')])],
    ];
    const mismatched: string[] = [];
    const unrendered: string[] = [];
    for (const [label, want, run] of cases) {
      const got = await thrown(run);
      if (got.code !== want) mismatched.push(`${label}: want ${want} got ${got.code}`);
      if (!got.diag) continue;
      const vars = Object.values(got.diag.vars ?? {}).map(String);
      const sentence = formatDiagnostic({
        code: got.diag.code,
        ...(got.diag.vars ? { vars: got.diag.vars } : {}),
      });
      const rendered = formatDiagnostic(got.diag);
      const lost = vars.filter((v) => !sentence.includes(v));
      const payloadLost = got.diag.payload !== undefined && !rendered.includes(got.diag.payload);
      if (/[{}]/.test(sentence) || lost.length > 0 || payloadLost) {
        unrendered.push(
          `${label}: ${JSON.stringify(sentence)} missing ${lost.join(',')}${payloadLost ? ' payload' : ''}`);
      }
    }
    results.push({
      name: 'malformed and unsupported inputs throw their diagnostic code',
      pass: mismatched.length === 0,
      detail: mismatched.length === 0
        ? `${cases.length} cases: ${cases.map(([, want]) => want).join(', ')}`
        : mismatched.join('; '),
    });
    results.push({
      name: 'every thrown diagnostic renders its vars with no leftover placeholder',
      pass: unrendered.length === 0,
      detail: unrendered.length === 0
        ? `${cases.length} rendered sentences, all vars present`
        : unrendered.join('; '),
    });

    const gapRendered = await thrown(() => loadLwcap(reversedSpan(), 'corrupt-gap.lwcap'));
    const widthRendered = await thrown(() => loadLwcap(badChannelCount(), 'bad-channels.lwcap'));
    const gapSentence = gapRendered.diag ? formatDiagnostic(gapRendered.diag) : '';
    const widthSentence = widthRendered.diag ? formatDiagnostic(widthRendered.diag) : '';
    const wantGap = 'corrupt gap span [90000, 40000) in corrupt-gap.lwcap';
    const wantWidths = `channel count 7 is not a supported width (${CHANNEL_COUNTS.join('/')})`;
    results.push({
      name: 'rendered sentences carry the source name and the supported widths',
      pass: gapSentence === wantGap && widthSentence === wantWidths,
      detail: `gap ${JSON.stringify(gapSentence)}, widths ${JSON.stringify(widthSentence)}`,
    });

    const invalidNames = await thrown(() => loadLwcap(badNames(), 'bad-names-json.lwcap'));
    const unsupported = await thrown(
      () => loadFiles([new File(['x'], 'notes.txt'), new File(['y'], 'readme.md')]));
    results.push({
      name: 'unreadable names keep the JSON error and file names keep their own vars',
      pass: invalidNames.code === 'file.lwcap.namesInvalid' &&
        (invalidNames.payload ?? '').length > 0 &&
        unsupported.code === 'file.unsupported' &&
        unsupported.payload === null,
      detail: `names payload ${JSON.stringify(invalidNames.payload)}, ` +
        `unsupported payload ${JSON.stringify(unsupported.payload)}`,
    });
  }

  console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  nodeProcess.exit(failed === 0 ? 0 : 1);
}

void main();
