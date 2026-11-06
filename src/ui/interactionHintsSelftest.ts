// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Node entry point for the bottom interaction-hint bar.
 *
 *   node src/tools/run-all-tests.mjs --filter interactionHints
 *
 * It pins the DOM-free mapping against the real handlers, the hover-area lookup, the
 * locale key set, and the shell contract (old #status gone, #interaction-bar present,
 * errors still owned by the top alert banner). Run from the repository root.
 */

import {
  INTERACTION_AREAS, INTERACTION_AREA_SELECTORS, MOUSE_PART_LABEL_KEYS,
  interactionAreaLabelKey, interactionAreaOf, interactionHints,
  type HintSpec, type InteractionArea, type InteractionContext,
} from './interactionHints.js';
import { en, type Messages } from './locales/en.js';
import { zhCN } from './locales/zh-CN.js';
import { ru } from './locales/ru.js';
import { fr } from './locales/fr.js';

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

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const readSource = (path: string): string => {
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  return fs.readFileSync(path, 'utf8');
};

const context = (hasCapture: boolean, running = false): InteractionContext =>
  ({ hasCapture, running });

/** One-line signature: modifiers first, then the lit mouse part, then the catalog key. */
const signature = (spec: HintSpec): string =>
  `${spec.modifiers.length > 0 ? `${spec.modifiers.join('+')}+` : ''}${spec.mouse}:${spec.key}`;
const signatures = (area: InteractionArea, hasCapture: boolean, running = false): string =>
  interactionHints(area, context(hasCapture, running)).map(signature).join('|');

{
  const expected = new Map<InteractionArea, string>([
    ['plot',
      'wheel:hints.plot.scroll|Ctrl+wheel:hints.plot.zoom|Shift+wheel:hints.plot.pan|' +
      'left:hints.plot.dragPan|left:hints.plot.addCursor'],
    ['axis',
      'wheel:hints.axis.scroll|Ctrl+wheel:hints.axis.zoom|Shift+wheel:hints.axis.pan|' +
      'left:hints.axis.dragPan|left:hints.axis.dragCursor'],
    ['overview',
      'wheel:hints.overview.scroll|Ctrl+wheel:hints.overview.zoom|' +
      'Shift+wheel:hints.overview.pan|left:hints.overview.center'],
    ['labels',
      'wheel:hints.labels.scroll|left:hints.labels.rename|left:hints.labels.trigger'],
    ['side-panel', 'wheel:hints.sidePanel.scroll'],
    ['toolbar', 'left:hints.toolbar.activate'],
    ['corner',
      'left:hints.corner.fit|wheel:hints.corner.zoom|Shift+wheel:hints.corner.pan|' +
      'left:hints.corner.summary|left:hints.corner.addDecoder'],
    ['none', 'none:hints.general'],
  ]);
  const bad = [...expected.entries()]
    .filter(([area, want]) => signatures(area, true) !== want)
    .map(([area, want]) => `${area}: got ${signatures(area, true)} want ${want}`);
  check('each area maps to the gestures its handlers implement, in a stable order',
    bad.length === 0, bad.length === 0 ? `${expected.size} areas pinned` : bad.join('; '));
}

{
  const forbidden = [
    'hints.plot.zoom', 'hints.plot.pan', 'hints.plot.addCursor',
    'hints.axis.zoom', 'hints.axis.pan', 'hints.axis.dragPan', 'hints.axis.dragCursor',
    'hints.overview.zoom', 'hints.overview.pan', 'hints.overview.center',
    'hints.corner.fit', 'hints.corner.zoom', 'hints.corner.pan',
  ];
  const bad: string[] = [];
  for (const area of INTERACTION_AREAS) {
    const specs = interactionHints(area, context(false));
    const keys = specs.map((spec) => spec.key);
    const leaked = keys.filter((key) => forbidden.includes(key));
    if (leaked.length > 0) bad.push(`${area}: ${leaked.join(',')}`);
    if (!expectedStillWorks(area, specs)) bad.push(`${area}: no working gesture or guidance`);
  }
  // Without a capture the mapping must still say what to do: scroll works, and the
  // plot/axis/overview/labels areas explain how to get a capture instead of promising
  // zoom/pan gestures that their handlers no-op on an empty store.
  check('no capture removes only non-functional gestures and keeps guidance',
    bad.length === 0, bad.length === 0 ? `all ${INTERACTION_AREAS.length} areas clean` : bad.join('; '));

  function expectedStillWorks(area: InteractionArea, specs: readonly HintSpec[]): boolean {
    if (area === 'labels') {
      // Rename and trigger-slot editing work before a capture; only zoom/pan/cursor
      // hints are capture-dependent.
      return specs.some((spec) => spec.key === 'hints.labels.rename') &&
        specs.some((spec) => spec.key === 'hints.labels.trigger') &&
        specs.some((spec) => spec.mouse === 'wheel');
    }
    if (area === 'corner') {
      // Fit is disabled without a capture; the summary and + Decoder still open panels.
      return specs.some((spec) => spec.key === 'hints.noCapture' && spec.mouse === 'none') &&
        specs.some((spec) => spec.key === 'hints.corner.summary') &&
        specs.some((spec) => spec.key === 'hints.corner.addDecoder');
    }
    if (area === 'plot' || area === 'axis' || area === 'overview') {
      return specs.some((spec) => spec.key === 'hints.noCapture' && spec.mouse === 'none') &&
        specs.some((spec) => spec.mouse === 'wheel');
    }
    return specs.length > 0;
  }
}

{
  // The three wheel variants. Each is read off `wheelAction`, the function the plot,
  // axis and overview handlers call, so the bar and the handlers cannot disagree.
  const variant = (area: InteractionArea, wheelZooms: boolean, rowsOverflow: boolean): string =>
    interactionHints(area, { hasCapture: true, wheelZooms, rowsOverflow }).map(signature).join('|');
  const expected: Array<[InteractionArea, boolean, boolean, string]> = [
    ['plot', false, true,
      'wheel:hints.plot.scroll|Ctrl+wheel:hints.plot.zoom|Shift+wheel:hints.plot.pan|' +
      'left:hints.plot.dragPan|left:hints.plot.addCursor'],
    ['plot', false, false,
      'wheel:hints.plot.zoom|Shift+wheel:hints.plot.pan|left:hints.plot.dragPan|left:hints.plot.addCursor'],
    ['plot', true, true,
      'wheel:hints.plot.zoom|Ctrl+wheel:hints.wheel.scrollRows|Shift+wheel:hints.plot.pan|' +
      'left:hints.plot.dragPan|left:hints.plot.addCursor'],
    ['plot', true, false,
      'wheel:hints.plot.zoom|Ctrl+wheel:hints.wheel.scrollRows|Shift+wheel:hints.plot.pan|' +
      'left:hints.plot.dragPan|left:hints.plot.addCursor'],
    ['axis', false, false, 'wheel:hints.axis.zoom|Shift+wheel:hints.axis.pan|left:hints.axis.dragPan|left:hints.axis.dragCursor'],
    ['axis', true, true,
      'wheel:hints.axis.zoom|Ctrl+wheel:hints.wheel.scrollRows|Shift+wheel:hints.axis.pan|left:hints.axis.dragPan|left:hints.axis.dragCursor'],
    ['overview', false, false,
      'wheel:hints.overview.zoom|Shift+wheel:hints.overview.pan|left:hints.overview.center'],
    ['overview', true, true,
      'wheel:hints.overview.zoom|Ctrl+wheel:hints.wheel.scrollRows|Shift+wheel:hints.overview.pan|' +
      'left:hints.overview.center'],
  ];
  const bad = expected.filter(([area, zooms, overflow, want]) => variant(area, zooms, overflow) !== want)
    .map(([area, zooms, overflow]) => `${area}/${zooms}/${overflow}: ${variant(area, zooms, overflow)}`);
  // Labels, side panel and toolbar have no wheel handler of their own; the setting must
  // not change what they advertise.
  const steady = (['labels', 'side-panel', 'toolbar', 'corner', 'none'] as const).every((area) =>
    variant(area, true, false) === signatures(area, true));
  // Without a capture a plain wheel stays native scrolling in every variant.
  const noCapture = (['plot', 'axis', 'overview'] as const).every((area) =>
    interactionHints(area, { hasCapture: false, wheelZooms: true, rowsOverflow: false })
      .map(signature).join('|') === signatures(area, false));
  check('the wheel hints follow the "wheel zooms" setting and row overflow exactly as wheelAction does',
    bad.length === 0 && steady && noCapture,
    bad.length === 0 ? `${expected.length} variants, steady=${steady}, noCapture=${noCapture}` : bad.join('; '));
}

{
  const before = INTERACTION_AREAS.map((area) => signatures(area, true));
  const after = INTERACTION_AREAS.map((area) => signatures(area, true, true));
  check('a running capture does not silently change the advertised gestures',
    before.join('\n') === after.join('\n'), `areas=${INTERACTION_AREAS.length}`);
}

{
  const stable = INTERACTION_AREAS.every((area) => {
    const first = interactionHints(area, context(true));
    const second = interactionHints(area, context(true));
    return first === second && Object.isFrozen(first) &&
      first.every((spec) => Object.isFrozen(spec) && Object.isFrozen(spec.modifiers));
  });
  check('the mapping is deterministic and defensively frozen',
    stable, `areas=${INTERACTION_AREAS.length}`);
}

{
  const want = 'corner:#labels-spacer,plot:#plot,axis:#axis,overview:#overview,labels:#labels-col,' +
    'side-panel:#side-panel,toolbar:#toolbar';
  const got = INTERACTION_AREA_SELECTORS.map((entry) => `${entry.area}:${entry.selector}`).join(',');
  check('the hover areas are exactly the seven interactive shell regions (corner before its label column)',
    got === want, `got ${got}`);

  interface Stub {
    closest(selector: string): unknown;
  }
  const stub = (...matches: string[]): Stub => ({
    closest: (selector) => (matches.includes(selector) ? {} : null),
  });
  const cases: [InteractionArea, Stub | null][] = [
    ['plot', stub('#plot')],
    ['axis', stub('#axis')],
    ['overview', stub('#overview')],
    ['labels', stub('#labels-col')],
    // The corner cell is inside the label column: the more specific area wins.
    ['corner', stub('#labels-spacer', '#labels-col')],
    ['side-panel', stub('#side-panel')],
    ['toolbar', stub('#toolbar')],
    ['none', stub('#panel-resizer')],
    ['none', null],
  ];
  const bad = cases.filter(([area, target]) => interactionAreaOf(target) !== area)
    .map(([area, target]) => `${area}/${target === null ? 'null' : 'stub'}`);
  check('closest() selects the area and everything else is none',
    bad.length === 0, bad.length === 0 ? `${cases.length} lookup cases` : bad.join(', '));
}

{
  const want = 'none:hints.area.none,toolbar:hints.area.toolbar,labels:hints.area.labels,' +
    'plot:hints.area.plot,axis:hints.area.axis,overview:hints.area.overview,' +
    'side-panel:hints.area.sidePanel,corner:hints.area.corner';
  const got = INTERACTION_AREAS.map((area) => `${area}:${interactionAreaLabelKey(area)}`).join(',');
  check('every area has its own localized label', got === want, `got ${got}`);
}

{
  const catalogs: Record<string, Messages> = { en, 'zh-CN': zhCN, ru, fr };
  const keys = new Set<string>([
    'hints.barLabel',
    ...INTERACTION_AREAS.map(interactionAreaLabelKey),
    ...Object.values(MOUSE_PART_LABEL_KEYS),
    ...INTERACTION_AREAS.flatMap((area) => [
      ...interactionHints(area, context(true)).map((spec) => spec.key),
      ...interactionHints(area, context(false)).map((spec) => spec.key),
    ]),
  ]);
  const missing: string[] = [];
  for (const [locale, dict] of Object.entries(catalogs)) {
    for (const key of keys) {
      const text = dict[key as keyof Messages];
      if (typeof text !== 'string' || text.trim() === '') missing.push(`${locale}:${key}`);
    }
  }
  const statusKeys = Object.keys(en).filter((key) => key.startsWith('status.'));
  check('every hint key exists in all four catalogs and the old status keys are retired',
    missing.length === 0 && statusKeys.length === 0,
    missing.length === 0 && statusKeys.length === 0
      ? `${keys.size} keys × ${Object.keys(catalogs).length} locales`
      : `missing=${missing.join(',')} status=${statusKeys.join(',')}`);
}

// ---------------------------------------------------------------- shell contract

{
  const html = readSource('index.html');
  const app = readSource('src/ui/app.ts');
  const css = readSource('src/ui/style.css');

  const barTag = /<div id="interaction-bar"[^>]*>/.exec(html)?.[0] ?? '';
  const oldStatus = /id="status"/.test(html) || /#status\b/.test(css) ||
    app.includes('renderStatus') || app.includes("must<HTMLDivElement>('status')") ||
    app.includes('this.el.status');
  check('index.html replaces #status with the hint bar and App drops renderStatus',
    barTag !== '' && barTag.includes('aria-live="polite"') &&
    html.includes('id="interaction-area"') && html.includes('id="interaction-hints"') &&
    html.includes('data-i18n-aria-label="hints.barLabel"') && !oldStatus,
    `bar=${barTag.length}, area=${html.includes('id="interaction-area"')}, ` +
    `list=${html.includes('id="interaction-hints"')}, old=${oldStatus}`);

  const wire = app.slice(
    app.indexOf('private wireInteractionHints()'),
    app.indexOf('private wireToolbar()'),
  );
  const render = app.slice(
    app.indexOf('private renderInteractionBar('),
    app.indexOf('private interactionHintItem('),
  );
  const appContract = wire.length > 0 && wire.includes('interactionAreaOf(target)') &&
    wire.includes('{ passive: true }') && wire.includes('this.el.interactionBar.contains(target)') &&
    render.includes('interactionHints(area, { hasCapture, running: this.running, wheelZooms, rowsOverflow })') &&
    render.includes('rowsOverflow === this.renderedInteractionOverflow') &&
    render.includes('this.el.interactionHints.replaceChildren(') &&
    render.includes('area === this.renderedInteractionArea') &&
    app.includes('this.renderInteractionBar(true)') &&
    app.includes('MOUSE_PART_LABEL_KEYS[part]') &&
    app.includes("class: `hint-mouse-part hint-mouse-left${active('left')}`") &&
    app.includes("class: `hint-mouse-part hint-mouse-wheel${active('wheel')}`");
  check('App tracks the hovered area, guards rebuilds, and renders the glyph/keycaps',
    appContract,
    `wire=${wire.length}, render=${render.length}, ` +
    `passive=${wire.includes('{ passive: true }')}`);

  const banner = app.slice(
    app.indexOf('private renderErrorBanner('),
    app.indexOf('private fail('),
  );
  const dismiss = app.slice(
    app.indexOf("this.el.errorDismiss.addEventListener('click'"),
    app.indexOf('private async toggleFullscreen('),
  );
  const fail = app.slice(
    app.indexOf('private fail('),
    app.indexOf('private deviceFailed('),
  );
  check('errors stay in the top alert banner and the dismiss path no longer paints a bar',
    banner.includes('this.el.errorBanner.hidden = err === null;') &&
    banner.includes('this.el.errorBannerText.textContent =') &&
    dismiss.includes('this.renderErrorBanner();') &&
    !dismiss.includes('renderInteractionBar') && fail.includes('this.renderErrorBanner();'),
    `banner=${banner.length}, dismiss=${dismiss.length}, fail=${fail.length}`);

  const barStart = css.indexOf('#interaction-bar {');
  const barEnd = css.indexOf('@media (max-width: 760px)', barStart);
  const barCss = barStart >= 0 && barEnd > barStart ? css.slice(barStart, barEnd) : '';
  const cssContract = barCss.includes('min-height: var(--status-h);') &&
    barCss.includes('flex-wrap: wrap;') &&
    css.includes('.hint-mouse-part.active {') &&
    css.includes('fill: var(--primary);') &&
    css.includes('.hint-key {') &&
    css.includes('.interaction-hints {\n  display: flex;\n  flex-wrap: wrap;') &&
    /@media \(max-width: 760px\) \{[\s\S]*?\.interaction-hint \{ white-space: normal; \}/.test(css);
  check('the bar keeps the bottom-bar height token, wraps, and styles the glyph/keycaps',
    cssContract, `bar=${barCss.length}, mouse=${css.includes('.hint-mouse-part.active {')}`);
}

const failed = results.filter((result) => !result.pass).length;
console.log(results.map((result) =>
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
