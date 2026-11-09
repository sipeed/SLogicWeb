// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.
/**
 * Node entry point for the analyzer panel row-action suite.
 *
 *   node_modules/.bin/esbuild src/ui/tools/analyzer-panel-selftest.ts --bundle --format=esm \
 *     --platform=node --outfile=/tmp/analyzer-panel-selftest.mjs && node /tmp/analyzer-panel-selftest.mjs
 *
 * Run from the repository root (checks read sources from the CWD).
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 */

import { formatMessage, translate } from '../i18n.js';
import { formatMountedAnalyzerNote, formatStatusDetail, statusDetailOf } from '../format.js';
import { DiagnosticError, diagnosticOf, fromWireDiagnostic } from '../../diagnostics.js';
import { mappedCaptureChannels, type AnalyzerNote } from '../state.js';
import { createSampleStore } from '../../data/index.js';
import { en } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const process = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!process || typeof process.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return process;
})();

const fs = (() => {
  const get = nodeProcess.getBuiltinModule;
  return (typeof get === 'function'
    ? get.call(nodeProcess, 'node:fs')
    : undefined) as FsLike | undefined;
})();
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const TEXT_MINI_COUNT = 1;
const ANALYZER_ACT_NEEDLES = 3;

const panel = fs.readFileSync('src/ui/analyzerPanel.ts', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');
const clientSource = fs.readFileSync('src/decode/client.ts', 'utf8');
const workerSource = fs.readFileSync('src/decode/worker.ts', 'utf8');
const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const count = (haystack: string, re: RegExp): number => (haystack.match(re) ?? []).length;

check(
  'the decode action is no longer a text button',
  !panel.includes("button(t('analyzerPanel.decode'"),
  `needle present=${panel.includes("button(t('analyzerPanel.decode'")}`,
);

check(
  'the remove action is no longer a text button',
  !panel.includes("button(t('analyzerPanel.remove'"),
  `needle present=${panel.includes("button(t('analyzerPanel.remove'")}`,
);

check(
  'no icon library import and no shared icons module crept in',
  !/from 'lucide/.test(panel) && !fs.readdirSync('src/ui').includes('icons.ts'),
  `lucide=${/from 'lucide/.test(panel)}, icons.ts=${fs.readdirSync('src/ui').includes('icons.ts')}`,
);

const DECODE_ARC = 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8';
const DECODE_ARROW = 'M21 3v5h-5';
check(
  'the decode glyph keeps its rotate-cw geometry',
  panel.includes(DECODE_ARC) && panel.includes(DECODE_ARROW),
  `arc=${panel.includes(DECODE_ARC)}, arrow=${panel.includes(DECODE_ARROW)}`,
);

const builderNeedles = [
  "document.createElementNS(SVG_NS, 'svg')",
  "document.createElementNS(SVG_NS, 'path')",
  "svg.setAttribute('viewBox', '0 0 24 24')",
  "svg.setAttribute('aria-hidden', 'true')",
  "path.setAttribute('fill', 'none')",
  "path.setAttribute('stroke', 'currentColor')",
  "path.setAttribute('stroke-width', '2')",
  "path.setAttribute('stroke-linecap', 'round')",
  "path.setAttribute('stroke-linejoin', 'round')",
];
const builderCounts = builderNeedles.map((n) => count(panel, new RegExp(n.replace(/[.*+?^${}()[\]\\|]/g, '\\$&'), 'g')));
check(
  'both glyphs share one inline-SVG builder with the house stroke attributes',
  builderCounts.every((c) => c === 1),
  `counts=${JSON.stringify(builderCounts)}`,
);

check(
  'title and aria-label come from one string on the action button',
  panel.includes('b.title = label;') &&
    panel.includes("b.setAttribute('aria-label', label);") &&
    !/aria-label',\s*t\(/.test(panel),
  `title=${panel.includes('b.title = label;')}, aria=${panel.includes("b.setAttribute('aria-label', label);")}, divergent=${/aria-label',\s*t\(/.test(panel)}`,
);

check(
  'the decode action names its decoder',
  panel.includes("t('analyzerPanel.decodeAction', { label: a.label })"),
  `callsite=${panel.includes("t('analyzerPanel.decodeAction', { label: a.label })")}`,
);

check(
  'the decode action string interpolates the decoder label',
  formatMessage(en['analyzerPanel.decodeAction'], { label: 'UART' }) === 'Decode UART',
  `got=${formatMessage(en['analyzerPanel.decodeAction'], { label: 'UART' })}`,
);

check(
  'the remove action string interpolates the decoder label',
  formatMessage(en['analyzerPanel.removeAction'], { label: 'UART' }) === 'Remove UART',
  `got=${formatMessage(en['analyzerPanel.removeAction'], { label: 'UART' })}`,
);

const catalogs: Record<string, Record<string, string>> = { en, fr, ru, zhCN };
const coverage = Object.entries(catalogs).map(([locale, dict]) => {
  const d = dict['analyzerPanel.decodeAction'];
  const r = dict['analyzerPanel.removeAction'];
  const translated = locale === 'en' || (d !== en['analyzerPanel.decodeAction'] && r !== en['analyzerPanel.removeAction']);
  return `${locale}:${d && r && d.includes('{label}') && r.includes('{label}') && translated ? 'ok' : 'bad'}`;
});
check(
  'both action keys exist, carry {label}, and are translated in every catalog',
  coverage.every((c) => c.endsWith(':ok')),
  coverage.join(', '),
);

const MOUNTED_STATUS = 'st.textContent = formatMountedAnalyzerNote(a.note, a.status);';
check(
  'the mounted status span uses the mounted-row note formatter, not the generic one',
  panel.includes(MOUNTED_STATUS) &&
    panel.includes("st.className = 'analyzer-status';") &&
    !panel.includes('formatAnalyzerNote(a.note)'),
  `mounted=${panel.includes(MOUNTED_STATUS)}, span=${panel.includes("st.className = 'analyzer-status';")}, generic=${panel.includes('formatAnalyzerNote(a.note)')}`,
);

const DESCRIPTION_CALL = 'desc.textContent = decoderDescriptionText(info);';
const DECODER_I18N_IMPORT = "} from './decoderI18n.js';";
const DESCRIPTION_IMPORT =
  'decoderDescriptionText, decoderLongNameText, decoderOptionLabel, decoderOptionValueTuples,';
const RAW_DESCRIPTION_CALL = 'desc.textContent = info.desc;';
check(
  'the decoder description note renders through the metadata resolver',
  panel.includes(DESCRIPTION_CALL) &&
    panel.includes(DESCRIPTION_IMPORT) && panel.includes(DECODER_I18N_IMPORT) &&
    !panel.includes(RAW_DESCRIPTION_CALL),
  `resolved=${panel.includes(DESCRIPTION_CALL)}, import=${panel.includes(DECODER_I18N_IMPORT)}, raw=${panel.includes(RAW_DESCRIPTION_CALL)}`,
);

const DETAIL_CLASS = "div('decoder-detail')";
const DETAIL_CALL = 'longName.textContent = decoderLongNameText(info);';
const detailIndex = panel.indexOf(DETAIL_CLASS);
const detailRule = css.match(/\.decoder-detail\s*\{([^}]*)\}/)?.[1] ?? '';
const detailTwin =
  /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.decoder-detail\s*\{[^}]*var\(--foreground\)[^}]*\}/.test(css);
const detailRules = [...css.matchAll(/[^{}]*\.decoder-detail[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
check(
  'the add page shows the decoder long name above its description',
  detailIndex >= 0 && detailIndex < panel.indexOf(DESCRIPTION_CALL) &&
    panel.includes(DETAIL_CALL) &&
    /font-size:\s*11px/.test(detailRule) && /color:\s*var\(--text80\)/.test(detailRule) &&
    detailTwin && detailRules.length === 2 &&
    detailRules.every((rule) => !/#[0-9a-fA-F]{3,8}/.test(rule)),
  `detail@${detailIndex}, desc@${panel.indexOf(DESCRIPTION_CALL)}, rule=${JSON.stringify(detailRule)}, twin=${detailTwin}, rules=${detailRules.length}`,
);

const OPTION_SELECT_CALL =
  '`analyzer.option.${opt.id}`, decoderOptionLabel(info.id, opt), optionValues, String(cur));';
const OPTION_INPUT_CALL = 'labelled(decoderOptionLabel(info.id, opt), inp)';
const RAW_OPTION_READ = panel.includes('opt.desc');
check(
  'both option-control branches render their label through the metadata resolver',
  panel.includes(OPTION_SELECT_CALL) &&
    panel.includes(OPTION_INPUT_CALL) &&
    !RAW_OPTION_READ,
  `select=${panel.includes(OPTION_SELECT_CALL)}, input=${panel.includes(OPTION_INPUT_CALL)}, raw=${RAW_OPTION_READ}`,
);

check(
  'constrained option values resolve display labels while state keeps the raw select value',
  panel.includes('const optionValues: SelectOptionTuple[] = decoderOptionValueTuples(opt.values);') &&
    panel.includes('this.draftOptions[opt.id] = coerce(opt.type, sel.value);') &&
    panel.includes('this.draftOptions[opt.id] = coerce(opt.type, optionFieldRaw(opt, inp.value));') &&
    !panel.includes('(x) => [String(x), String(x)] as SelectOptionTuple,') &&
    !panel.includes('[decoderOptionValueLabel('),
  `tuples=${panel.includes('decoderOptionValueTuples(opt.values)')}, coerce=${count(panel, /coerce\(opt\.type, (sel|inp)\.value\)/g)}`,
);

const PICKER_CALL = 'decoderPickerOptions(logic)';
const RAW_PICKER_LABEL = '${d.id} - ${d.longname}';
check(
  'the decoder picker renders localized labels backed by the localized search corpus',
  panel.includes(PICKER_CALL) &&
    panel.includes('decoderPickerOptions,') && panel.includes(DECODER_I18N_IMPORT) &&
    panel.includes('this.chosen = pick.value;') &&
    !panel.includes('decoderPickerLabel') &&
    !panel.includes(RAW_PICKER_LABEL),
  `resolved=${panel.includes(PICKER_CALL)}, raw=${panel.includes(RAW_PICKER_LABEL)}, rawValue=${panel.includes('this.chosen = pick.value;')}`,
);

check(
  'the decode disabled condition is preserved verbatim',
  panel.includes("re.disabled = !v.hasCapture || a.status === 'decoding';"),
  `needle=${panel.includes("re.disabled = !v.hasCapture || a.status === 'decoding';")}`,
);

check(
  'the decode click wiring still reaches onRedecode exactly once',
  count(panel, /this\.cb\.onRedecode\(a\.id\)/g) === 1,
  `count=${count(panel, /this\.cb\.onRedecode\(a\.id\)/g)}`,
);

const REMOVE_ARM_A = 'M18 6 6 18';
const REMOVE_ARM_B = 'm6 6 12 12';
check(
  'the remove glyph keeps its cross geometry',
  panel.includes(REMOVE_ARM_A) && panel.includes(REMOVE_ARM_B),
  `armA=${panel.includes(REMOVE_ARM_A)}, armB=${panel.includes(REMOVE_ARM_B)}`,
);

check(
  'the remove action names its decoder and carries the destructive variant',
  panel.includes("t('analyzerPanel.removeAction', { label: a.label })") &&
    panel.includes("actionButton('analyzer-act analyzer-act--remove',") &&
    count(panel, /this\.cb\.onRemove\(a\.id\)/g) === 1,
  `callsite=${panel.includes("t('analyzerPanel.removeAction', { label: a.label })")}, variant=${panel.includes("actionButton('analyzer-act analyzer-act--remove',")}, onRemove=${count(panel, /this\.cb\.onRemove\(a\.id\)/g)}`,
);

const actNeedles = count(panel, /analyzer-act/g);
check(
  'the row actions carry the analyzer-act class the expected number of times',
  actNeedles === ANALYZER_ACT_NEEDLES,
  `count=${actNeedles}, expected=${ANALYZER_ACT_NEEDLES}`,
);

const miniNeedles = count(panel, /'mini'/g);
check(
  'only the not-yet-swapped actions remain text .mini buttons',
  miniNeedles === TEXT_MINI_COUNT,
  `count=${miniNeedles}, expected=${TEXT_MINI_COUNT}`,
);

const actRule = css.match(/\.analyzer-act\s*\{([^}]*)\}/)?.[1] ?? '';
const actDeclarations = [
  'flex: none',
  'display: flex',
  'align-items: center',
  'justify-content: center',
  'width: 22px',
  'height: 18px',
  'padding: 0',
  'border: 1px solid var(--border-low)',
  'background: var(--bg20)',
  'color: var(--text50)',
  'cursor: pointer',
];
const missingDeclarations = actDeclarations.filter((d) => !actRule.includes(d));
check(
  'the analyzer-act rule pins the chip geometry and quiet-chrome colors',
  actRule.length > 0 && missingDeclarations.length === 0,
  `missing=${JSON.stringify(missingDeclarations)}`,
);

check(
  'the svg sizing gate keeps the glyph at 13px (no 300x150 default box)',
  /\.analyzer-act svg\s*\{[^}]*display:\s*block[^}]*width:\s*13px[^}]*height:\s*13px[^}]*\}/.test(css),
  `match=${/\.analyzer-act svg\s*\{[^}]*display:\s*block[^}]*width:\s*13px[^}]*height:\s*13px[^}]*\}/.test(css)}`,
);

check(
  'the base hovers use the accent pair and the remove hover the negative pair',
  /\.analyzer-act:hover\s*\{[^}]*var\(--accent\)[^}]*var\(--text80\)[^}]*\}/.test(css) &&
    /\.analyzer-act--remove:hover\s*\{[^}]*var\(--negative\)[^}]*var\(--negative\)[^}]*\}/.test(css),
  `accent=${/\.analyzer-act:hover\s*\{[^}]*var\(--accent\)[^}]*var\(--text80\)[^}]*\}/.test(css)}, negative=${/\.analyzer-act--remove:hover\s*\{[^}]*var\(--negative\)[^}]*var\(--negative\)[^}]*\}/.test(css)}`,
);

const themed = /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act\s*\{([^}]*)\}/.test(css) &&
  /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act:hover\s*\{[^}]*var\(--primary\)[^}]*var\(--foreground\)[^}]*\}/.test(css) &&
  /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act--remove:hover\s*\{[^}]*var\(--destructive\)[^}]*var\(--destructive\)[^}]*\}/.test(css);
const themedBase = css.match(/:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.analyzer-act\s*\{([^}]*)\}/)?.[1] ?? '';
const themedTokens = ['var(--background)', 'var(--input)', 'var(--muted-foreground)', 'border-radius: calc(var(--radius) - 4px)'];
check(
  'the dark/light twins map the chip onto theme tokens',
  themed && themedTokens.every((tok) => themedBase.includes(tok)),
  `themed=${themed}, missing=${JSON.stringify(themedTokens.filter((tok) => !themedBase.includes(tok)))}`,
);

const actRules = [...css.matchAll(/[^{}]*\.analyzer-act[^{}]*\{[^}]*\}/g)].map((m) => m[0]);
check(
  'no raw hex inside the analyzer-act rules (tokens only)',
  actRules.length === 7 && actRules.every((rule) => !/#[0-9a-fA-F]{3,8}/.test(rule)),
  `rules=${actRules.length}, hex=${actRules.filter((rule) => /#[0-9a-fA-F]{3,8}/.test(rule)).length}`,
);

const TRACEBACK =
  'Traceback (most recent call last):\n' +
  '  File "/decoders/uart.py", line 118, in decode\n' +
  'srdengine.SigrokDecodeError: bad parity';
const failedFrame = formatStatusDetail(statusDetailOf(fromWireDiagnostic({
  message: 'the decoder failed', code: 'decode.workerFailed', payload: TRACEBACK,
})));
check(
  'a failed decode renders a translated frame followed by the raw decoder diagnostic',
  failedFrame === `${en['diagnostic.decode.workerFailed']}: ${TRACEBACK}` &&
    failedFrame.startsWith('the decoder failed: Traceback') &&
    failedFrame.endsWith(TRACEBACK),
  `frame=${JSON.stringify(failedFrame)}`,
);

const cancelledWire = fromWireDiagnostic({ message: 'decode cancelled', code: 'decode.cancelled' });
const cancelledDetail = statusDetailOf(cancelledWire);
check(
  'a cancelled decode resolves as its own diagnostic code, not raw worker text',
  cancelledWire instanceof DiagnosticError && cancelledWire.code === 'decode.cancelled' &&
    cancelledDetail.kind === 'diagnostic' && cancelledDetail.diag.code === 'decode.cancelled',
  `code=${cancelledWire instanceof DiagnosticError ? cancelledWire.code : 'none'}, ` +
    `detail=${cancelledDetail.kind}`,
);

check(
  'the decode control-flow errors keep their class identity on top of DiagnosticError',
  clientSource.includes('export class DecodeCancelledError extends DiagnosticError') &&
    clientSource.includes("super('decode.cancelled')") &&
    clientSource.includes('export class DecodeTimeoutError extends DiagnosticError') &&
    clientSource.includes("super('decode.timeout', { ms })"),
  `cancelled=${clientSource.includes('export class DecodeCancelledError extends DiagnosticError')}, ` +
    `timeout=${clientSource.includes('export class DecodeTimeoutError extends DiagnosticError')}`,
);

check(
  'the client selects a cancelled decode by its diagnostic code',
  clientSource.includes("res.code === 'decode.cancelled'") &&
    clientSource.includes('new DecodeCancelledError()') &&
    !clientSource.includes("res.message === 'decode cancelled'"),
  `code=${clientSource.includes("res.code === 'decode.cancelled'")}, ` +
    `legacyText=${clientSource.includes("res.message === 'decode cancelled'")}`,
);

check(
  'the client rebuilds a coded failure and frames an uncoded one as a decoder failure',
  clientSource.includes('fromWireDiagnostic(res)') &&
    clientSource.includes("'decode.workerFailed', undefined, res.message)") &&
    clientSource.includes('if (res.stack) e.stack = res.stack;') &&
    !clientSource.includes('${res.message}\\n${res.stack}') &&
    clientSource.includes("'decode.workerCrashed', undefined,"),
  `rebuilt=${clientSource.includes('fromWireDiagnostic(res)')}, ` +
    `failed=${clientSource.includes("'decode.workerFailed', undefined, res.message)")}, ` +
    `stack=${clientSource.includes('if (res.stack) e.stack = res.stack;')}, ` +
    `joined=${clientSource.includes('${res.message}\\n${res.stack}')}`,
);

check(
  'the decode worker reports cancellation and third-party failures through the wire fields',
  workerSource.includes("throw new DiagnosticError('decode.cancelled')") &&
    workerSource.includes('...(wireDiagnostic(e) ?? {})'),
  `cancel=${workerSource.includes("throw new DiagnosticError('decode.cancelled')")}, ` +
    `wire=${workerSource.includes('...(wireDiagnostic(e) ?? {})')}`,
);

check(
  'the analyzer row keeps the cancelled note variant and the raw diagnostic detail',
  appSource.includes("e instanceof DecodeCancelledError ? { kind: 'cancelled' as const }") &&
    appSource.includes('detail: diag?.payload ?? (e instanceof Error ? e.message : String(e))') &&
    appSource.includes('...(diag ? { diag } : {})') &&
    !appSource.includes("kind: 'error' as const, detail: e.message"),
  `cancelled=${appSource.includes("e instanceof DecodeCancelledError ? { kind: 'cancelled' as const }")}, ` +
    `diag=${appSource.includes('...(diag ? { diag } : {})')}, ` +
    `rawCoercion=${appSource.includes("kind: 'error' as const, detail: e.message")}`,
);

check(
  'a mounted row for a payload-free decode failure reads the translated sentence, not the code',
  (() => {
    const mounted = formatMountedAnalyzerNote({
      kind: 'error', detail: 'decode.edgeBudget',
      diag: { code: 'decode.edgeBudget', vars: { edges: '51.2 M', budget: '48 M' } },
    }, 'error');
    return mounted ===
      '51.2 M edges on the mapped channels exceed the 48 M decode budget. ' +
        'Disable a channel or zoom the capture down.' &&
      !mounted.includes('decode.edgeBudget') && !mounted.includes('diagnostic.');
  })(),
  `mounted=${JSON.stringify(formatMountedAnalyzerNote({
    kind: 'error', detail: 'decode.edgeBudget',
    diag: { code: 'decode.edgeBudget', vars: { edges: '51.2 M', budget: '48 M' } },
  }, 'error'))}`,
);

check(
  'the decode limits pick the loop or sub-range wording from the capture state',
  appSource.includes("this.captureIsLoop ? 'decode.tooLongLoop' : 'decode.tooLong'") &&
    appSource.includes('window: formatDuration(MAX_SAMPLE / 200e6)') &&
    appSource.includes("this.captureIsLoop ? 'decode.edgeBudgetLoop' : 'decode.edgeBudget'") &&
    !appSource.includes('decode is limited to') &&
    !appSource.includes('decode budget. Disable a channel or '),
  `tooLong=${appSource.includes("this.captureIsLoop ? 'decode.tooLongLoop' : 'decode.tooLong'")}, ` +
    `window=${appSource.includes('window: formatDuration(MAX_SAMPLE / 200e6)')}, ` +
    `edgeBudget=${appSource.includes("this.captureIsLoop ? 'decode.edgeBudgetLoop' : 'decode.edgeBudget'")}, ` +
    `prose=${appSource.includes('decode is limited to')}`,
);

check(
  'a stale analyzer mapping on a narrower capture reports the out-of-range code, not the store prose',
  (() => {
    const narrow = createSampleStore(4, 1e6);
    narrow.append(new Uint8Array(16));
    const mapping: Record<number, number> = { 0: 7 };
    let raw = 'no throw';
    try { narrow.edges(7, 0, narrow.length); } catch (e) { raw = e instanceof Error ? e.message : String(e); }
    const mapped = mappedCaptureChannels(mapping, narrow.channelCount);
    const error = mapped.outside === null
      ? new Error('the guard let the stale mapping through')
      : new DiagnosticError('decode.channelOutOfRange', {
        channel: mapped.outside, channels: narrow.channelCount,
      });
    const diag = diagnosticOf(error);
    const note: AnalyzerNote = {
      kind: 'error',
      detail: diag?.payload ?? (error instanceof Error ? error.message : String(error)),
      ...(diag ? { diag } : {}),
    };
    const mounted = formatMountedAnalyzerNote(note, 'error');
    return raw === 'channel 7 out of range 0..3' &&
      mapped.outside === 7 && mapped.used.join(',') === '7' &&
      error instanceof DiagnosticError && error.code === 'decode.channelOutOfRange' &&
      error.message === 'decode.channelOutOfRange' &&
      mounted === 'channel 7 is not in this capture (4 channels)' &&
      !mounted.includes('out of range') && !mounted.includes('diagnostic.');
  })(),
  'D7 mapped, capture replaced by a 4-channel one: the data layer still throws the raw English ' +
    'text, and the guard turns it into decode.channelOutOfRange before the edges are read. ' +
    'Removing the guard from runDecode fails the source pin below.',
);

check(
  'the mapped-channel width check flags exactly the channels the capture lacks',
  (() => {
    const cases: [string, Record<number, number>, number, number | null, string][] = [
      ['stale D7 on a 4-channel capture', { 0: 7 }, 4, 7, '7'],
      ['in-range mapping is left alone', { 0: 3, 1: 3 }, 4, null, '3'],
      ['unmapped decoder channels (-1) are dropped', { 0: -1 }, 4, null, ''],
      ['first stale channel in mapping order', { 0: 5, 1: 2, 2: 9 }, 4, 5, '5,2,9'],
      ['the width boundary itself is outside', { 0: 4 }, 4, 4, '4'],
      ['one below the boundary is inside', { 0: 3, 1: 0 }, 4, null, '3,0'],
    ];
    const bad = cases.filter(([, mapping, width, outside, used]) => {
      const got = mappedCaptureChannels(mapping, width);
      return got.outside !== outside || got.used.join(',') !== used;
    }).map(([name]) => name);
    return bad.length === 0;
  })(),
  'the discriminating rows are the `>=` boundary (channel 4 of 4 is outside) and the dropped -1 ' +
    'sentinel; flipping the comparison or the filter fails this table',
);

check(
  'the out-of-range sentence names the channel and the capture width in every locale',
  (() => {
    const vars = { channel: 7, channels: 4 };
    const expected: [string, typeof en, string][] = [
      ['en', en, 'channel 7 is not in this capture (4 channels)'],
      ['zh-CN', zhCN, '通道 7 不在当前采集（共 4 个通道）'],
      ['ru', ru, 'канала 7 нет в этом захвате (всего каналов: 4)'],
      ['fr', fr, 'le canal 7 ne fait pas partie de cette capture (4 canaux)'],
    ];
    const bad = expected.filter(([, dict, want]) =>
      translate(dict, 'diagnostic.decode.channelOutOfRange', vars) !== want).map(([locale]) => locale);
    return bad.length === 0;
  })(),
  'each catalog renders the two measured values as vars, so the translated sentence can never ' +
    'absorb the channel index or the width',
);

check(
  'runDecode rejects a mapping the capture lacks before it reads any channel',
  (() => {
    const guard = appSource.indexOf('mappedCaptureChannels(a.channels, store.channelCount)');
    const thrown = appSource.indexOf("new DiagnosticError('decode.channelOutOfRange'");
    const edgeCount = appSource.indexOf('store.edgeCount');
    const edges = appSource.indexOf('store.edges(c, 0, store.length)');
    return guard >= 0 && thrown > guard && edgeCount > thrown && edges > thrown &&
      count(appSource, /mappedCaptureChannels\(/g) === 1;
  })(),
  `guard=${appSource.indexOf('mappedCaptureChannels(a.channels, store.channelCount)')}, ` +
    `throw=${appSource.indexOf("new DiagnosticError('decode.channelOutOfRange'")}, ` +
    `edgeCount=${appSource.indexOf('store.edgeCount')}, ` +
    `helperCalls=${count(appSource, /mappedCaptureChannels\(/g)}`,
);

console.log(results.map((result) => (
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`
)).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
