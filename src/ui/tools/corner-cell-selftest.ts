// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The corner cell (DESIGN §3.4): its pure readouts, its markup, and the App wiring that
 * moved Fit out of the top bar.
 *
 *   node src/tools/run-all-tests.mjs --filter corner-cell
 */

import {
  captureSummaryText, cornerView, cornerViewEqual, viewSpanText,
} from '../cornerCell.js';
import { interactionAreaOf, interactionHints } from '../interactionHints.js';
import { en, type Messages } from '../locales/en.js';
import { zhCN } from '../locales/zh-CN.js';
import { ru } from '../locales/ru.js';
import { fr } from '../locales/fr.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
}

// ------------------------------------------------------------------ pure readouts

{
  const summary = captureSummaryText({ samples: 2_000_000, samplerate: 100e6, channels: 16 });
  const slow = captureSummaryText({ samples: 1_000, samplerate: 50e3, channels: 4 });
  const long = captureSummaryText({ samples: 1_000_000_000, samplerate: 1e9, channels: 32 });
  check('the summary is rate · length with three significant figures',
    summary === '100 MS/s · 20.0 ms' && slow === '50 kS/s · 20.0 ms' && long === '1000 MS/s · 1.00 s',
    `summary=${summary}, slow=${slow}, long=${long}`);
}

{
  const empty = [
    captureSummaryText(null),
    captureSummaryText({ samples: 0, samplerate: 100e6, channels: 16 }),
    captureSummaryText({ samples: 10, samplerate: 0, channels: 16 }),
    captureSummaryText({ samples: 10, samplerate: Number.NaN, channels: 16 }),
  ];
  check('no samples, or no usable rate, is "no capture" rather than a number',
    empty.every((text) => text === null), JSON.stringify(empty));
}

{
  const span = viewSpanText(130_000, 100e6);
  const tiny = viewSpanText(5, 1e9);
  const none = [viewSpanText(0, 100e6), viewSpanText(-3, 100e6), viewSpanText(10, 0)];
  check('the Fit span is the view width in time (1.30 ms) and empty for no span',
    span === '1.30 ms' && tiny === '5.00 ns' && none.every((text) => text === null),
    `span=${span}, tiny=${tiny}, none=${JSON.stringify(none)}`);
}

{
  const view = cornerView({ samples: 2_000_000, samplerate: 100e6, channels: 16 },
    { storeSamples: 2_000_000, spanSamples: 130_000, samplerate: 100e6 });
  check('a capture shows its summary, a sample-count tooltip and an enabled Fit with its span',
    view.hasCapture && !view.fitDisabled && view.summary === '100 MS/s · 20.0 ms' &&
    view.summaryTitle === '2,000,000 samples · 16 channels. Click to open the Capture panel.' &&
    view.span === '1.30 ms' && view.fitLabel === 'Fit, view span 1.30 ms' &&
    view.fitTitle === en['corner.fitTitle'] && view.addDecoder === '+ Decoder' &&
    view.addDecoderLabel === 'Add decoder' && view.groupLabel === en['corner.label'],
    JSON.stringify(view));
}

{
  const none = cornerView(null, { storeSamples: 0, spanSamples: 0, samplerate: 100e6 });
  const nothing = cornerView(null, null);
  check('no capture: "No capture", Fit disabled with its reason, + Decoder still offered',
    !none.hasCapture && none.fitDisabled && none.summary === 'No capture' && none.span === '' &&
    none.fitTitle === en['corner.fitDisabledTitle'] && none.summaryTitle === en['corner.summaryEmptyTitle'] &&
    none.fitLabel === en['toolbar.fit'] && none.addDecoder === '+ Decoder' &&
    cornerViewEqual(none, nothing),
    JSON.stringify(none));
}

{
  // A Repeat composite keeps the previous wave on screen while the new wave is empty: the
  // summary reads the wave, Fit acts on the displayed store.
  const view = cornerView(null, { storeSamples: 500, spanSamples: 500, samplerate: 1e6 });
  check('Fit follows the displayed store even while the current wave has no samples yet',
    !view.fitDisabled && view.summary === 'No capture' && view.span === '500 µs',
    JSON.stringify(view));
}

{
  const a = cornerView(null, null);
  const b = cornerView({ samples: 1, samplerate: 1e6, channels: 8 },
    { storeSamples: 1, spanSamples: 1, samplerate: 1e6 });
  check('the change guard sees equal views as equal and any string change as a change',
    cornerViewEqual(a, cornerView(null, null)) && !cornerViewEqual(a, b) && cornerViewEqual(b, b),
    'ok');
}

// ------------------------------------------------------------------ i18n

{
  const catalogs: Record<string, Messages> = { en, 'zh-CN': zhCN, ru, fr };
  const keys = (Object.keys(en) as (keyof Messages)[])
    .filter((key) => key.startsWith('corner.') || key.startsWith('hints.corner.') || key === 'hints.area.corner');
  const bad: string[] = [];
  for (const [locale, dict] of Object.entries(catalogs)) {
    for (const key of keys) {
      const text = dict[key];
      if (typeof text !== 'string' || text.trim() === '') bad.push(`${locale}:${key} missing`);
      else if (locale !== 'en' && text === en[key]) bad.push(`${locale}:${key} is still English`);
    }
  }
  check('every corner key is translated in all four catalogs',
    keys.length >= 16 && bad.length === 0 && zhCN['corner.noCapture'] === '无采集' &&
    zhCN['corner.addDecoder'] === '+ 解码器' && en['corner.addDecoder'] === '+ Decoder',
    bad.length === 0 ? `${keys.length} keys × 4 locales` : bad.join('; '));
}

// ------------------------------------------------------------------ markup and wiring

const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');
const corner = between(html, '<div id="labels-spacer"', '<div id="channel-list">');
const toolbar = between(html, '<div id="toolbar"', '<div id="main">') || between(html, 'id="toolbar"', '<div id="main">');

{
  const summaryAt = corner.indexOf('id="corner-summary"');
  const fitAt = corner.indexOf('id="corner-fit"');
  const addAt = corner.indexOf('id="corner-add-decoder"');
  const triggerAt = corner.indexOf('id="corner-trigger"');
  const overview = between(corner, 'class="corner-overview"', 'class="corner-ruler"');
  const ruler = corner.slice(corner.indexOf('class="corner-ruler"'));
  check('the corner holds the summary and Fit over the overview, + Decoder and T over the ruler',
    summaryAt >= 0 && fitAt > summaryAt && addAt > fitAt && triggerAt > addAt &&
    overview.includes('id="corner-summary"') && overview.includes('id="corner-fit"') &&
    ruler.includes('id="corner-add-decoder"') && ruler.includes('id="corner-trigger"') &&
    /id="corner-fit"[^>]*\bdisabled\b/.test(corner) &&
    /id="corner-fit"[^>]*aria-label="Fit"/.test(corner) &&
    /id="corner-add-decoder"[^>]*aria-label="Add decoder"/.test(corner) &&
    /id="labels-spacer"[^>]*role="group"/.test(corner),
    `summary@${summaryAt}, fit@${fitAt}, add@${addAt}, T@${triggerAt}`);
}

{
  // The numeric readouts are data: the label column is translate="no" and the readouts
  // inherit it; only the "+ Decoder" word opts back in.
  const labelsCol = /<div id="labels-col"[^>]*>/.exec(html)?.[0] ?? '';
  check('numeric readouts are never machine-translated',
    labelsCol.includes('translate="no"') && !/corner-(summary|fit)[^>]*translate="yes"/.test(corner) &&
    /corner-add-text[^>]*translate="yes"/.test(corner),
    labelsCol);
}

{
  const noToolbarFit = !html.includes('btn-fit') && !app.includes('btn-fit') &&
    !app.includes('this.el.fit') && !toolbar.includes('toolbar.shortFit') && toolbar.length > 0;
  check('Fit is gone from the top bar (markup, element map and wiring)', noToolbarFit,
    `html=${html.includes('btn-fit')}, app=${app.includes('btn-fit')}, toolbar=${toolbar.length}`);
}

{
  const wire = between(app, 'private wireCorner(): void {', 'private openAddDecoder(');
  const shortcut = between(app, "} else if (shortcut === 'view.fit') {", "} else if (shortcut === 'cursors.clear') {");
  const fitBody = between(app, 'private fitViewport(): void {', 'private fitLockedViewport(');
  check('the corner Fit is the F action: both fit the lock or zoom to fit and record intent',
    wire.includes("this.el.cornerFit.addEventListener('click', () => {\n      this.fitViewport();") &&
    shortcut.includes('this.beginViewportGesture();') &&
    shortcut.includes('if (!this.fitLockedViewport()) this.stack.zoomToFit();') &&
    fitBody.includes('this.beginViewportGesture();') &&
    fitBody.includes('if (!this.fitLockedViewport()) this.stack.zoomToFit();'),
    `wire=${wire.length}, shortcut=${shortcut.length}, fit=${fitBody.length}`);

  const open = between(app, 'private openAddDecoder(): void {', '\n  }\n');
  check('+ Decoder opens the Decoders panel with the picker focused; the summary opens Capture',
    wire.includes("this.el.cornerAddDecoder.addEventListener('click', () => this.openAddDecoder());") &&
    wire.includes("this.el.cornerSummary.addEventListener('click', () => this.selectPanel('device'));") &&
    open.includes("this.selectPanel('analyzers');") &&
    open.indexOf('requestPickerFocus()') < open.indexOf("this.selectPanel('analyzers');") &&
    open.lastIndexOf('requestPickerFocus()') > open.indexOf("this.selectPanel('analyzers');") &&
    !open.includes('store.length'),
    open);

  const wheel = between(app, "this.el.cornerFit.addEventListener('wheel'", '}, { passive: false });');
  check('the wheel over Fit runs the ruler path with the Fit wheel decision',
    wheel.includes("wheelNavigate(e, e.clientX - this.el.plot.clientWidth / 2, 'fit');") &&
    app.includes("if (target === 'fit') return fitWheelAction(e, this.store.length > 0);") &&
    app.includes('const action = this.wheelActionFor(e, target);'),
    `wheel=${wheel.length}`);
}

{
  const render = between(app, 'private renderCorner(): void {', 'private wireCorner(');
  const draw = between(app, 'private draw(', 'private frameFingerprint(');
  const clock = between(app, 'private frame = (): void => {', 'private recordFrameCost(');
  const retranslate = between(app, 'private retranslate(): void {', '\n  }\n');
  check('the readouts refresh on draw, the running clock and locale change, guarded by a text compare',
    render.includes('if (last !== null && cornerViewEqual(last, next)) return;') &&
    draw.includes('this.renderCorner();') && clock.includes('this.renderCorner();') &&
    retranslate.includes('this.renderCorner();') &&
    render.includes('this.captureStore') && render.includes('storeSamples: shown.length'),
    `render=${render.length}, draw=${draw.includes('this.renderCorner();')}, ` +
    `clock=${clock.includes('this.renderCorner();')}, locale=${retranslate.includes('this.renderCorner();')}`);
}

{
  const compact = /@media \(max-width: 760px\) \{\s*#labels-spacer \{[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
  check('compact keeps only the two 40 px icon buttons and hides the summary',
    compact.includes('.corner-summary, .corner-trigger, .corner-fit-span, .corner-add-text { display: none; }') &&
    compact.includes('width: 40px;') && compact.includes('height: 40px;') &&
    compact.includes('.corner-add-decoder .corner-icon { display: block; }') &&
    css.includes('.corner-btn:focus-visible { outline: 2px solid var(--ring);'),
    `compact=${compact.length}`);
}

{
  const stub = (...matches: string[]) => ({
    closest: (selector: string) => (matches.includes(selector) ? {} : null),
  });
  const area = interactionAreaOf(stub('#labels-spacer', '#labels-col'));
  const keys = interactionHints('corner', { hasCapture: true }).map((spec) => spec.key);
  const empty = interactionHints('corner', { hasCapture: false }).map((spec) => spec.key);
  check('the hint bar maps the corner and names its real gestures',
    area === 'corner' &&
    keys.join(',') === 'hints.corner.fit,hints.corner.zoom,hints.corner.pan,' +
      'hints.corner.summary,hints.corner.addDecoder' &&
    empty.join(',') === 'hints.noCapture,hints.corner.summary,hints.corner.addDecoder',
    `area=${area}, keys=${keys.join(',')}, empty=${empty.join(',')}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
