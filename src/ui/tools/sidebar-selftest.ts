import {
  DEFAULT_SIDEBAR_STATE,
  hideSidebar,
  parseSidebarPage,
  selectSidebarPage,
  SIDEBAR_PAGES,
  showAssistant,
  sidebarTabs,
  tabTargetIndex,
  toggleAssistant,
  toggleSidebarVisible,
  type SidebarPage,
  type SidebarState,
} from '../sidebar.js';

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

const state = (visible: boolean, page: SidebarPage, assistant: boolean): SidebarState =>
  ({ visible, page, assistant });

const describe = (s: SidebarState): string =>
  `visible=${s.visible}, page=${s.page}, assistant=${s.assistant}`;

{
  const order = SIDEBAR_PAGES.join(',');
  const defaults = DEFAULT_SIDEBAR_STATE;
  check('three pages in strip order with a visible capture page and no assistant',
    order === 'capture,cursors,decoders' &&
    SIDEBAR_PAGES.length === 3 &&
    defaults.visible === true && defaults.page === 'capture' && defaults.assistant === false,
    `order=${order}, count=${SIDEBAR_PAGES.length}, defaults=${describe(defaults)}`);
}

{
  const failures: string[] = [];
  let noopIdentity = false;
  for (const from of SIDEBAR_PAGES) {
    for (const target of SIDEBAR_PAGES) {
      for (const visible of [true, false]) {
        for (const assistant of [true, false]) {
          const before = state(visible, from, assistant);
          const after = selectSidebarPage(before, target);
          const label = `${from}->${target}[${describe(before)}]`;
          if (after.page !== target || after.assistant !== false || after.visible !== true) {
            failures.push(`${label} => ${describe(after)}`);
          }
          const unchanged = visible && !assistant && from === target;
          if (unchanged && after !== before) failures.push(`${label} => lost identity`);
          if (!unchanged && after === before) failures.push(`${label} => reused identity`);
          if (unchanged && from === 'capture' && target === 'capture' && visible) {
            noopIdentity = after === DEFAULT_SIDEBAR_STATE || after === before;
          }
        }
      }
    }
  }
  check('selecting a page sets it, closes the assistant, and opens the dock from every state',
    failures.length === 0, failures.length === 0 ? '36 transitions matched' : `failed=${JSON.stringify(failures)}`);
  check('a selection that changes nothing returns the same object',
    noopIdentity && selectSidebarPage(DEFAULT_SIDEBAR_STATE, 'capture') === DEFAULT_SIDEBAR_STATE,
    `noopIdentity=${noopIdentity}`);
}

{
  const opener = toggleSidebarVisible(state(true, 'decoders', false));
  const closer = toggleSidebarVisible(state(true, 'cursors', true));
  const reopened = toggleSidebarVisible(closer);
  check('the visibility toggle flips only visible and keeps page and assistant',
    opener.visible === false && opener.page === 'decoders' && opener.assistant === false &&
    closer.visible === false && closer.page === 'cursors' && closer.assistant === true &&
    reopened.visible === true && reopened.page === 'cursors' && reopened.assistant === true,
    `open=${describe(opener)}, close=${describe(closer)}, reopen=${describe(reopened)}`);
}

{
  const failures: string[] = [];
  let states = 0;
  for (const page of SIDEBAR_PAGES) {
    for (const visible of [true, false]) {
      for (const assistant of [true, false]) {
        const before = state(visible, page, assistant);
        const after = hideSidebar(before);
        states += 1;
        const label = `${page}[${describe(before)}]`;
        if (after.visible !== false || after.page !== page || after.assistant !== false) {
          failures.push(`${label} => ${describe(after)}`);
        }
      }
    }
  }
  check('closing the sidebar hides the dock, keeps the page, and clears the assistant from every state',
    failures.length === 0, failures.length === 0 ? `${states} transitions matched` : `failed=${JSON.stringify(failures)}`);
}

{
  const failures: string[] = [];
  for (const page of SIDEBAR_PAGES) {
    for (const visible of [true, false]) {
      const before = state(visible, page, false);
      const opened = toggleAssistant(before);
      const closed = toggleAssistant(opened);
      const label = `${page}[visible=${visible}]`;
      if (!opened.assistant || !opened.visible || opened.page !== page) {
        failures.push(`${label} open => ${describe(opened)}`);
      }
      if (closed.assistant || closed.page !== page || closed.visible !== true) {
        failures.push(`${label} close => ${describe(closed)}`);
      }
    }
    const collapsed = state(false, page, true);
    const closedCollapsed = toggleAssistant(collapsed);
    if (closedCollapsed.assistant || closedCollapsed.visible !== false || closedCollapsed.page !== page) {
      failures.push(`${page} close-collapsed => ${describe(closedCollapsed)}`);
    }
  }
  const roundTrip = toggleAssistant(toggleAssistant(state(true, 'cursors', false)));
  check('the assistant toggle opens the dock, keeps the page, and returns to that page on close',
    failures.length === 0 && roundTrip.page === 'cursors' && !roundTrip.assistant && roundTrip.visible,
    failures.length === 0 ? `roundTrip=${describe(roundTrip)}` : `failed=${JSON.stringify(failures)}`);
}

{
  const failures: string[] = [];
  let states = 0;
  let identity = 0;
  for (const page of SIDEBAR_PAGES) {
    for (const visible of [true, false]) {
      for (const assistant of [true, false]) {
        const before = state(visible, page, assistant);
        const after = showAssistant(before);
        states += 1;
        const label = `${page}[${describe(before)}]`;
        if (!after.visible || !after.assistant || after.page !== page) {
          failures.push(`${label} => ${describe(after)}`);
        }
        const already = visible && assistant;
        if (already && after !== before) failures.push(`${label} => lost identity`);
        if (!already && after === before) failures.push(`${label} => reused identity`);
        if (already) identity += 1;
      }
    }
  }
  check('showing the assistant opens the dock on the current page and is identity only when already showing',
    failures.length === 0 && states === 12 && identity === 3,
    failures.length === 0 ? `${states} states matched, ${identity} identity`
      : `failed=${JSON.stringify(failures)}`);
}

{
  const accepted: [string, SidebarPage][] = [
    ['capture', 'capture'],
    ['cursors', 'cursors'],
    ['decoders', 'decoders'],
    ['device', 'capture'],
    ['analyzers', 'decoders'],
  ];
  const rejected: [string, unknown][] = [
    ['assistant', 'assistant'],
    ['empty', ''],
    ['blank', ' '],
    ['upper case', 'Capture'],
    ['padded', ' capture '],
    ['null', null],
    ['undefined', undefined],
    ['number', 3],
    ['object', { page: 'capture' }],
    ['array', ['capture']],
    ['boolean', true],
    ['prototype key', 'constructor'],
    ['nan', Number.NaN],
  ];
  const badAccepted = accepted.filter(([raw, want]) => parseSidebarPage(raw) !== want);
  const badRejected = rejected.filter(([, raw]) => parseSidebarPage(raw) !== null);
  check('the guard accepts the three literals plus the two legacy aliases and rejects everything else',
    badAccepted.length === 0 && badRejected.length === 0,
    badAccepted.length === 0 && badRejected.length === 0
      ? `${accepted.length} accepted, ${rejected.length} rejected`
      : `acceptedFailures=${JSON.stringify(badAccepted)}, rejectedFailures=${JSON.stringify(badRejected.map(([label]) => label))}`);
}

{
  const mutated = (raw: unknown): SidebarPage | null =>
    raw === 'assistant' ? 'capture' : parseSidebarPage(raw);
  check('a mutated predicate that accepts assistant would turn the guard check red',
    mutated('assistant') === 'capture' && parseSidebarPage('assistant') === null,
    `mutated=${mutated('assistant')}, actual=${parseSidebarPage('assistant')}`);
}

{
  const probe: TestResult[] = [];
  const collect = (name: string, pass: boolean, detail: string): void => {
    probe.push({ name, pass, detail });
  };
  const probeGot: number = 1;
  const probeWant: number = 2;
  collect('deliberately false', probeGot === probeWant, 'control');
  collect('deliberately true', probeGot === 1, 'control');
  const failedProbe = probe.filter((r) => !r.pass).length;
  check('the collector reports a false expectation as failed (failing control)',
    failedProbe === 1 && results.every((r) => r.pass),
    `probeFailed=${failedProbe}, probeTotal=${probe.length}, collected=${results.length}`);
}

{
  const visibleTabs = sidebarTabs(state(true, 'cursors', false));
  const hiddenTabs = sidebarTabs(state(false, 'decoders', false));
  const assistantTabs = sidebarTabs(state(true, 'decoders', true));
  const tabLabel = (tabs: readonly { page: SidebarPage; labelKey: string; selected: boolean }[]): string =>
    tabs.map((t) => `${t.page}:${t.labelKey}:${t.selected}`).join('|');
  const selectedPages = (tabs: readonly { selected: boolean; page: SidebarPage }[]): string =>
    tabs.filter((t) => t.selected).map((t) => t.page).join(',');
  check('tabs follow the strip order with the catalog label keys and exactly one selected when visible',
    tabLabel(visibleTabs) ===
      'capture:sidebar.pageCapture:false|cursors:sidebar.pageCursors:true|decoders:sidebar.pageDecoders:false' &&
    tabLabel(assistantTabs) ===
      'capture:sidebar.pageCapture:false|cursors:sidebar.pageCursors:false|decoders:sidebar.pageDecoders:true' &&
    selectedPages(visibleTabs) === 'cursors' && selectedPages(assistantTabs) === 'decoders',
    `visible=${tabLabel(visibleTabs)}, assistant=${tabLabel(assistantTabs)}`);
  check('a collapsed dock selects no tab',
    hiddenTabs.length === 3 && selectedPages(hiddenTabs) === '' &&
    tabLabel(hiddenTabs) ===
      'capture:sidebar.pageCapture:false|cursors:sidebar.pageCursors:false|decoders:sidebar.pageDecoders:false',
    `hidden=${tabLabel(hiddenTabs)}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const source = fs.readFileSync('src/ui/sidebar.ts', 'utf8');
  const forbidden = ['document', 'window', 'addEventListener', 'innerHTML', '//', '/*', ' t('];
  const hits = forbidden.filter((token) => source.includes(token));
  const api = ['selectSidebarPage', 'toggleSidebarVisible', 'hideSidebar', 'toggleAssistant',
    'showAssistant', 'parseSidebarPage', 'sidebarTabs']
    .filter((name) => source.includes(`export function ${name}(`));
  check('the model is DOM-free, locale-free, comment-free, and exports the whole reducer surface',
    hits.length === 0 && api.length === 7,
    `hits=${JSON.stringify(hits)}, api=${JSON.stringify(api)}`);
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = app.indexOf('private selectPanel(');
  const end = start >= 0 ? app.indexOf('\n  }', start) : -1;
  const body = start >= 0 && end > start ? app.slice(start, end) : '';
  const routed = body.includes('hideSidebar(this.sidebar)');
  const viaToggle = body.includes('toggleSidebarVisible');
  const nullBranch = body.includes('p === null');
  check('closing the sidebar routes through hideSidebar and never through the visibility toggle',
    start >= 0 && nullBranch && routed && !viaToggle,
    `body=${body.length} chars, nullBranch=${nullBranch}, routed=${routed}, viaToggle=${viaToggle}`);
}

{
  const rows: [number, string, number, number | null][] = [
    [0, 'ArrowRight', 3, 1],
    [1, 'ArrowRight', 3, 2],
    [2, 'ArrowRight', 3, 0],
    [0, 'ArrowLeft', 3, 2],
    [2, 'ArrowLeft', 3, 1],
    [1, 'ArrowLeft', 3, 0],
    [2, 'Home', 3, 0],
    [0, 'End', 3, 2],
    [1, 'End', 3, 2],
    [0, 'ArrowRight', 1, 0],
    [0, 'ArrowLeft', 1, 0],
    [0, 'Home', 1, 0],
    [0, 'End', 1, 0],
    [-5, 'ArrowRight', 3, 1],
    [9, 'ArrowLeft', 3, 1],
    [Number.NaN, 'ArrowRight', 3, 1],
    [1.9, 'ArrowRight', 3, 2],
    [0, 'ArrowRight', 0, null],
    [0, 'End', 0, null],
    [0, 'ArrowLeft', -2, null],
    [0, 'Home', Number.NaN, null],
    [0, 'ArrowUp', 3, null],
    [0, 'ArrowDown', 3, null],
    [0, 'Enter', 3, null],
    [0, 'Tab', 3, null],
    [0, '', 3, null],
    [0, 'a', 3, null],
  ];
  const bad = rows.filter(([index, key, count, want]) => tabTargetIndex(index, key, count) !== want);
  check('the tab walk wraps on the arrows, pins Home/End, degrades on one or zero tabs, and ignores other keys',
    bad.length === 0 && rows.length === 27,
    bad.length === 0 ? `${rows.length} cases matched`
      : `failed=${JSON.stringify(bad.map(([i, k, c, w]) => `${i}/${k}/${c}=>${w}`))}`);
}

{
  const unwrapped = (currentIndex: number, key: string, count: number): number | null => {
    if (key === 'ArrowRight') return Math.min(currentIndex + 1, count - 1);
    if (key === 'ArrowLeft') return Math.max(currentIndex - 1, 0);
    return tabTargetIndex(currentIndex, key, count);
  };
  const wrapBroken = unwrapped(2, 'ArrowRight', 3) === 2 && tabTargetIndex(2, 'ArrowRight', 3) === 0;
  const leftBroken = unwrapped(0, 'ArrowLeft', 3) === 0 && tabTargetIndex(0, 'ArrowLeft', 3) === 2;
  check('a clamping walk instead of a wrapping one would turn the arrow cases red',
    wrapBroken && leftBroken,
    `right=${unwrapped(2, 'ArrowRight', 3)}/${tabTargetIndex(2, 'ArrowRight', 3)}, ` +
    `left=${unwrapped(0, 'ArrowLeft', 3)}/${tabTargetIndex(0, 'ArrowLeft', 3)}`);
}

{
  const host = readSource('src/ui/sidebarHost.ts');
  const collapseAt = host.indexOf("this.collapseButton = iconButton('side-collapse', 'right')");
  const tablistClassAt = host.indexOf("this.tablist = div('side-tablist')");
  const tablistAt = host.indexOf("this.tablist.setAttribute('role', 'tablist')");
  const tabAt = host.indexOf("const tab = button('side-tab', '')");
  const tabAppendAt = host.indexOf('this.tablist.appendChild(tab);');
  const stripAppendAt = host.indexOf('this.strip.append(this.collapseButton, this.tablist);');
  const tabAria = [
    "tab.setAttribute('role', 'tab')",
    'tab.setAttribute(\'aria-controls\', pageContainerId(page))',
    "tab.setAttribute('aria-selected', 'false')",
    'tab.tabIndex = -1',
    'container.dataset.page = page',
    'this.root.dataset.page = state.page',
    'this.root.dataset.assistant = String(state.assistant)',
    "this.root.classList.toggle('hidden', !state.visible)",
    'this.expandButton.hidden = state.visible',
    "el.setAttribute('aria-controls', 'side-panel')",
    "this.collapseButton.setAttribute('aria-expanded', 'true')",
    'tabTargetIndex(index, event.key, SIDEBAR_PAGES.length)',
    'this.strip.inert = state.assistant',
    'container.inert = state.assistant',
    'this.cb.mount(page, container)',
    'if (!this.mounted.has(page)) {',
    'container.hidden = covered || tab.page !== state.page;',
    'this.root.appendChild(container);',
    'this.layer.hidden = !covered;',
    "this.expandButton.setAttribute('aria-expanded', 'false')",
    "this.tablist.setAttribute('aria-label', t('sidebar.pagesLabel'))",
  ].filter((needle) => !host.includes(needle));
  check('the host builds the strip collapse-first, then role=tab buttons with roving tabindex and data-page',
    collapseAt >= 0 && tablistClassAt > collapseAt && tablistAt > tablistClassAt &&
    tabAt > tablistAt && tabAppendAt > tabAt && stripAppendAt > tabAppendAt && tabAria.length === 0,
    `collapse@${collapseAt}, tablist@${tablistClassAt}, role@${tablistAt}, ` +
    `tab@${tabAt}, tabAppend@${tabAppendAt}, stripAppend@${stripAppendAt}, missing=${JSON.stringify(tabAria)}`);

  const forbidden = ['document.addEventListener', 'window.addEventListener', 'innerHTML', ' as any'];
  const hits = forbidden.filter((token) => host.includes(token));
  const mountSites = host.match(/this\.cb\.mount\(/g) ?? [];
  check('the host installs no document/window listener, never builds markup from strings, and mounts each page once',
    hits.length === 0 && mountSites.length === 1,
    `hits=${JSON.stringify(hits)}, mountSites=${mountSites.length}`);

  const sections = [
    'containerFor(page: SidebarPage): HTMLElement {',
    'assistantLayer(): HTMLElement {',
    'show(state: SidebarState): void {',
    'focusAfterCollapse(): void {',
    'focusAfterExpand(): void {',
    'dispose(): void {',
  ].filter((needle) => !host.includes(needle));
  const focusCollapseAt = host.indexOf('this.expandButton.focus({ preventScroll: true });');
  const focusExpandAt = host.indexOf('this.collapseButton.focus({ preventScroll: true });');
  const disposeAt = host.indexOf('dispose(): void {');
  const disposeBody = disposeAt >= 0 ? host.slice(disposeAt) : '';
  const disposeRemovals = ['this.strip.remove();', 'page.remove();', 'this.layer.remove();',
    'this.expandButton.remove();']
    .filter((needle) => !disposeBody.includes(needle));
  check('the host API is complete, collapse hands focus to the expand button, expand hands it back, and dispose clears everything',
    sections.length === 0 && focusCollapseAt >= 0 && focusExpandAt >= 0 && disposeRemovals.length === 0,
    `missing=${JSON.stringify(sections)}, focus@${focusCollapseAt}/${focusExpandAt}, ` +
    `disposeMissing=${JSON.stringify(disposeRemovals)}`);
}

{
  const host = readSource('src/ui/sidebarHost.ts');
  const css = readSource('src/ui/style.css');
  const rule = (selector: string): string =>
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  const strip = rule('.side-tabs');
  const tablist = rule('.side-tablist');
  const tab = rule('.side-tab');
  const collapse = rule('#side-panel .side-collapse');
  const fullBleed = /\bdisplay: flex;/.test(strip) && /\balign-items: stretch;/.test(strip) &&
    /\bposition: sticky;/.test(strip) && !/\bpadding:/.test(strip) && !/\bgap:/.test(strip) &&
    /\bborder-bottom: 1px solid var\(--border-low\);/.test(strip) &&
    /\bbackground: var\(--secondary\);/.test(strip);
  const equalTabs = /\bflex: 1 1 0;/.test(tablist) && /\bmin-width: 0;/.test(tablist) &&
    /\bflex: 1 1 0;/.test(tab) && /\bmin-width: 0;/.test(tab) &&
    /\bbackground: transparent;/.test(tab) && /\bcolor: var\(--text50\);/.test(tab);
  const collapseInRow = host.includes('this.strip.append(this.collapseButton, this.tablist);') &&
    /\bwidth: 24px;/.test(collapse) && /\balign-self: stretch;/.test(collapse) &&
    /\bborder: 0;/.test(collapse) && /\bbackground: transparent;/.test(collapse);
  check('the strip is full-bleed: a sticky band with no padding or gap, a leading flush collapse control, and three equal-width tabs',
    fullBleed && equalTabs && collapseInRow,
    `fullBleed=${fullBleed}, equalTabs=${equalTabs}, collapseInRow=${collapseInRow}, strip=${JSON.stringify(strip)}`);

  const active = rule('.side-tab.on');
  const themedActive = /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.side-tab\.on \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const hover = rule('.side-tab:hover:not(.on)');
  const pageGround = /\bbackground: var\(--bg20\);/.test(active) &&
    /\bbackground: var\(--background\);/.test(themedActive);
  const tabShape = /\bborder-color: var\(--border-low\);/.test(active) &&
    /\bmargin-bottom: -1px;/.test(active) && /\bcolor: var\(--text\);/.test(active) &&
    !/\bmargin-bottom:/.test(tab) &&
    /\bborder-bottom: 0;/.test(tab) && /\bborder-radius: 6px 6px 0 0;/.test(tab);
  const hoverSurface = /\bbackground: var\(--panel\);/.test(hover) && /\bcolor: var\(--text\);/.test(hover);
  const retired = !host.includes('segmented side-pages') && !host.includes("button('seg'") &&
    !/\.side-pages/.test(css) && !/\.side-tab[^{]*\{[^}]*background: var\(--text80\)/.test(css) &&
    !/(^|[^-])\bheight:/.test(tab) && !/\.side-expand:hover/.test(css) &&
    !/\[aria-selected="true"\]/.test(css);
  const themedPanel =
    /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) #side-panel \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const groundToken = (body: string): string => /\bbackground:\s*(var\(--[a-z0-9-]+\));/.exec(body)?.[1] ?? '';
  const tabGround = groundToken(themedActive);
  const panelGround = groundToken(themedPanel);
  const sharedGround = tabGround === 'var(--background)' && tabGround === panelGround;
  check('the active tab takes the page ground with top radii and no bottom border, breaks the strip hairline, and drops the segmented group',
    pageGround && tabShape && hoverSurface && sharedGround && retired,
    `pageGround=${pageGround}, tabShape=${tabShape}, hoverSurface=${hoverSurface}, ` +
    `ground=${tabGround}/${panelGround}, retired=${retired}, ` +
    `active=${JSON.stringify(active.trim())}, themed=${JSON.stringify(themedActive.trim())}`);

  const expand = rule('.side-expand');
  const iconFamily = host.includes("iconButton('side-collapse', 'right')") &&
    host.includes("iconButton('side-expand', 'left')") &&
    host.includes("button(`analyzer-act ${className}`, '')");
  const floatingExpand = /\bposition: absolute;/.test(expand) && /\btop: 8px;/.test(expand) &&
    /\bright: 0;/.test(expand) && /#main > \.side-expand\[hidden\] \{ display: none; \}/.test(css);
  const onMirrorsAria = host.includes("node.classList.toggle('on', tab.selected)") &&
    host.includes("node.setAttribute('aria-selected', String(tab.selected))");
  check('collapse and expand keep the shared icon-button family, the collapsed expand stays floating, and the on class mirrors aria-selected',
    iconFamily && floatingExpand && onMirrorsAria,
    `iconFamily=${iconFamily}, floatingExpand=${floatingExpand}, onMirrorsAria=${onMirrorsAria}`);
}

{
  const css = readSource('src/ui/style.css');
  const pageHidden = css.includes('> .side-page[hidden] { display: none; }');
  const assistantHidden = css.includes('> .side-assistant[hidden] { display: none; }');
  const assistantPanelHidden = css.includes('.assistant-panel[hidden] { display: none; }');
  const relative = /#side-panel \{[^}]*position: relative;/.test(css);
  const covered = css.includes('#side-panel[data-assistant="true"] { overflow: hidden; }');
  const layer = /\.side-assistant \{[^}]*position: absolute;[^}]*inset: 0;/.test(css);
  const stack = /:is\(html\[data-theme="dark"\], html\[data-theme="light"\]\) \.side-page \{[^}]*display: flex;[^}]*gap: 8px;[^}]*padding: 8px;/.test(css);
  const retired = ['assistant-mode', 'panel-host', 'bus-host'].filter((token) => css.includes(token));
  check('the sheet hides pages, the assistant layer and the assistant panel explicitly, covers a relative panel, and retires the old host classes',
    pageHidden && assistantHidden && assistantPanelHidden && relative && covered && layer && stack &&
    retired.length === 0,
    `pageHidden=${pageHidden}, assistantHidden=${assistantHidden}, ` +
    `assistantPanelHidden=${assistantPanelHidden}, relative=${relative}, ` +
    `covered=${covered}, layer=${layer}, stack=${stack}, retired=${JSON.stringify(retired)}`);
}

{
  const host = readSource('src/ui/sidebarHost.ts');
  const ctorAt = host.indexOf('constructor(');
  const ctorEnd = ctorAt >= 0 ? host.indexOf('\n  containerFor(', ctorAt) : -1;
  const ctorBody = ctorAt >= 0 && ctorEnd > ctorAt ? host.slice(ctorAt, ctorEnd) : '';
  const containerAt = host.indexOf('containerFor(page: SidebarPage): HTMLElement {');
  const containerEnd = containerAt >= 0 ? host.indexOf('\n  }', containerAt) : -1;
  const containerBody = containerAt >= 0 && containerEnd > containerAt
    ? host.slice(containerAt, containerEnd) : '';
  const eagerPages = (ctorBody.match(/this\.pages\.set\(page, container\);/g) ?? []).length === 1 &&
    ctorBody.includes('for (const page of SIDEBAR_PAGES) {') &&
    ctorBody.includes('container.id = pageContainerId(page);') &&
    ctorBody.includes('container.hidden = true;') &&
    ctorBody.includes('this.root.appendChild(container);') &&
    ctorBody.indexOf("tab.setAttribute('aria-controls', pageContainerId(page))") >= 0;
  const lazyMount = containerBody.includes('if (!this.mounted.has(page)) {') &&
    !containerBody.includes("div('side-page')") &&
    !containerBody.includes('insertBefore');
  check('every page container exists at construction so each tab aria-controls resolves, and only the mount stays lazy',
    eagerPages && lazyMount,
    `ctor=${ctorBody.length} chars, eagerPages=${eagerPages}, lazyMount=${lazyMount}`);

  const coveredShape = (src: string): boolean => {
    const at = src.indexOf('show(state: SidebarState): void {');
    const end = at >= 0 ? src.indexOf('\n  }', at) : -1;
    if (at < 0 || end <= at) return false;
    const body = src.slice(at, end);
    const covered = body.indexOf('const covered = state.visible && state.assistant;');
    const guard = body.indexOf('container.hidden = covered || tab.page !== state.page;');
    const reset = body.indexOf('if (covered && !this.covered) this.root.scrollTop = 0;');
    const inert = body.indexOf('container.inert = state.assistant;');
    const keepsMounts = !body.includes('containerFor(') && !body.includes('replaceChildren') &&
      !body.includes('.remove()');
    return covered >= 0 && guard > covered && reset > covered && inert > covered && keepsMounts;
  };
  const inertOnly = host.replace(
    'container.hidden = covered || tab.page !== state.page;',
    'container.hidden = tab.page !== state.page;',
  );
  const noReset = host.replace('if (covered && !this.covered) this.root.scrollTop = 0;', '');
  check('a covered assistant hides the page containers and resets the panel scroll, so no scrolled page can clip the layer',
    coveredShape(host) && !coveredShape(inertOnly) && !coveredShape(noReset),
    `covered=${coveredShape(host)}, inertOnly=${coveredShape(inertOnly)}, noReset=${coveredShape(noReset)}`);
}

{
  const app = readSource('src/ui/app.ts');
  const html = readSource('index.html');
  const retired = ['assistant-mode', 'panelHost', 'busHost', 'this.busPanel.hidden',
    'this.el.side.appendChild(', 'renderCursorsPlaceholder', 'side-placeholder',
    'btn-sidebar', 'sidebar-menu', 'sidebarItems(', 'this.sidebarMenu', 'this.el.sidebar']
    .filter((token) => app.includes(token));
  const retiredToolbar = ['btn-sidebar', 'sidebar-menu'].filter((token) => html.includes(token));
  const wiring = [
    'new SidebarHost(this.el.side, {',
    "this.sidebarHost.containerFor('cursors');",
    "this.sidebarHost.containerFor('capture');",
    "this.sidebarHost.containerFor('decoders');",
    'mount: (page, container) => this.mountSidebarPage(page, container),',
    "cursors: this.sidebarHost.containerFor('cursors'),",
    'this.capturePanel.render(this.capturePanelView());',
    'this.sidebarHost.show(this.sidebar);',
    'this.sidebarHost.focusAfterCollapse();',
    'this.sidebarHost.focusAfterExpand();',
    'private selectPage(page: SidebarPage): void {',
    'this.applySidebar(toggleSidebarVisible(this.sidebar));',
  ].filter((needle) => !app.includes(needle));
  const mountStart = app.indexOf('private mountSidebarPage(');
  const mountEnd = mountStart >= 0 ? app.indexOf('\n  }', mountStart) : -1;
  const mountBody = mountStart >= 0 && mountEnd > mountStart ? app.slice(mountStart, mountEnd) : '';
  const panels = (mountBody.match(/new CapturePanel\(/g) ?? []).length === 1 &&
    (mountBody.match(/new AnalyzerPanel\(/g) ?? []).length === 1 &&
    (mountBody.match(/new BusPanel\(/g) ?? []).length === 1 &&
    (mountBody.match(/new DecodeResultsPanel\(/g) ?? []).length === 1 &&
    mountBody.includes("container.append(analyzerRoot, resultsRoot, busRoot);");
  check('App owns the host wiring, mounts one panel per page, and carries no retired host, assistant-mode flag or toolbar sidebar selector',
    retired.length === 0 && retiredToolbar.length === 0 && wiring.length === 0 && panels,
    `retired=${JSON.stringify(retired)}, retiredToolbar=${JSON.stringify(retiredToolbar)}, ` +
    `missing=${JSON.stringify(wiring)}, panels=${panels}`);
}

{
  const app = readSource('src/ui/app.ts');
  const restoreAt = app.indexOf('this.sidebar = {');
  const restoreEnd = restoreAt >= 0 ? app.indexOf('};', restoreAt) : -1;
  const restore = restoreAt >= 0 && restoreEnd > restoreAt ? app.slice(restoreAt, restoreEnd) : '';
  const bootShape = (body: string): boolean =>
    body.includes('visible: workspace?.sidebar?.visible !== false,') &&
    body.includes("page: workspace?.sidebar?.page ?? 'capture',") &&
    body.includes('assistant: false,') && !body.includes('workspace?.sidebar?.assistant');
  const withAssistant = restore.replace('assistant: false,',
    'assistant: workspace?.sidebar?.assistant === true,');
  const forcedPage = restore.replace(
    "page: workspace?.sidebar?.page ?? 'capture',", "page: 'capture',");
  const forcedVisible = restore.replace(
    'visible: workspace?.sidebar?.visible !== false,', 'visible: true,');
  const constructorStart = app.indexOf('constructor() {');
  const constructorEnd = constructorStart >= 0
    ? app.indexOf('\n  // ------------------------------------------------------------------ layout', constructorStart) : -1;
  const constructor = constructorStart >= 0 && constructorEnd > constructorStart
    ? app.slice(constructorStart, constructorEnd) : '';
  const forced = ['selectSidebarPage(', 'toggleSidebarVisible(', 'showAssistant(', 'toggleAssistant(']
    .filter((needle) => constructor.includes(needle));
  check('a reloaded page restores with the assistant closed and a hidden dock keeps the stored page',
    restore.length > 0 && bootShape(restore) && !bootShape(withAssistant) &&
    !bootShape(forcedPage) && !bootShape(forcedVisible) && forced.length === 0,
    `boot=${bootShape(restore)}, assistant=${bootShape(withAssistant)}, ` +
    `page=${bootShape(forcedPage)}, visible=${bootShape(forcedVisible)}, reducers=${JSON.stringify(forced)}`);
}

{
  const html = readSource('index.html');
  const widthSource = readSource('src/ui/panelWidth.ts');

  const prePaintScript = (source: string): string => {
    const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    return scripts.find((s) => s.includes('--side-panel-w'))
      ?? scripts.find((s) => s.includes('panelWidth'))
      ?? '';
  };
  const numericConstant = (source: string, name: string): number | null => {
    const match = new RegExp(`${name}\\s*=\\s*(\\d+);`).exec(source);
    return match ? Number(match[1]) : null;
  };
  const functionBody = (source: string, name: string): string => {
    const start = source.indexOf(`function ${name}(`);
    const end = start >= 0 ? source.indexOf('\n}', start) : -1;
    return start >= 0 && end > start ? source.slice(start, end) : '';
  };
  type PrePaintSlot = 'key' | 'min' | 'max' | 'guard' | 'target';
  const contract = (page: string, source: string): Record<PrePaintSlot, boolean> => {
    const script = prePaintScript(page);
    const widthKey = /PANEL_WIDTH_STORAGE_KEY = '([^']+)';/.exec(source)?.[1] ?? null;
    const min = numericConstant(source, 'PANEL_WIDTH_MIN');
    const max = numericConstant(source, 'PANEL_WIDTH_MAX');
    const property = /const WIDTH_PROPERTY = '([^']+)';/.exec(source)?.[1] ?? null;
    const scriptKey = /localStorage\.getItem\('([^']+)'\)/.exec(script)?.[1] ?? null;
    const bounds = /Math\.min\((\d+), Math\.max\((\d+), Math\.round\(n\)\)\)/.exec(script);
    const sanitize = functionBody(source, 'sanitizePanelWidth');
    const rounded = functionBody(source, 'clampWidth');
    return {
      key: widthKey !== null && widthKey === scriptKey,
      min: min !== null && bounds !== null && Number(bounds[2]) === min,
      max: max !== null && bounds !== null && Number(bounds[1]) === max,
      guard: sanitize.includes('Number.isFinite(') && sanitize.includes('<= 0') &&
        rounded.includes('Math.round(') &&
        script.includes('Number.isFinite(n) && n > 0') && script.includes('Math.round(n)'),
      target: property !== null && script.includes(`setProperty('${property}'`),
    };
  };

  const verdict = contract(html, widthSource);
  const slots: PrePaintSlot[] = ['key', 'min', 'max', 'guard', 'target'];
  const disagreeing = slots.filter((slot) => !verdict[slot]);
  const min = numericConstant(widthSource, 'PANEL_WIDTH_MIN');
  const max = numericConstant(widthSource, 'PANEL_WIDTH_MAX');
  const key = /PANEL_WIDTH_STORAGE_KEY = '([^']+)';/.exec(widthSource)?.[1] ?? '';
  const detail = `key=${verdict.key}, min=${verdict.min}, max=${verdict.max}, ` +
    `guard=${verdict.guard}, target=${verdict.target}, disagreeing=${JSON.stringify(disagreeing)}`;
  check("index.html's pre-paint clamp and panelWidth.ts agree on the storage key, both bounds, the rounding and the positive-value guard",
    disagreeing.length === 0 && min !== null && max !== null && key !== '',
    `min=${min}, max=${max}, key=${JSON.stringify(key)}, ${detail}`);

  const drifts: [string, string, string, PrePaintSlot[]][] = [
    ['index.html minimum', html.replace(`Math.max(${min},`, `Math.max(${min! + 1},`), widthSource, ['min']],
    ['index.html maximum', html.replace(`Math.min(${max},`, `Math.min(${max! + 1},`), widthSource, ['max']],
    ['index.html storage key', html.replace(`localStorage.getItem('${key}')`,
      `localStorage.getItem('${key}.v2')`), widthSource, ['key']],
    ['index.html rounding', html.replace('Math.round(n)', 'Math.trunc(n)'), widthSource, ['min', 'max']],
    ['index.html positive guard', html.replace('n > 0', 'n >= 0'), widthSource, ['guard']],
    ['index.html property', html.replace('--side-panel-w', '--panel-w'), widthSource, ['target']],
    ['panelWidth.ts minimum', html, widthSource.replace(`PANEL_WIDTH_MIN = ${min};`,
      `PANEL_WIDTH_MIN = ${min! + 1};`), ['min']],
    ['panelWidth.ts maximum', html, widthSource.replace(`PANEL_WIDTH_MAX = ${max};`,
      `PANEL_WIDTH_MAX = ${max! + 1};`), ['max']],
    ['panelWidth.ts storage key', html, widthSource.replace(`PANEL_WIDTH_STORAGE_KEY = '${key}';`,
      `PANEL_WIDTH_STORAGE_KEY = '${key}.v2';`), ['key']],
    ['panelWidth.ts rounding', html, widthSource.replace('Math.round(value)', 'Math.trunc(value)'), ['guard']],
    ['panelWidth.ts positive guard', html, widthSource.replace('parsed <= 0', 'parsed < 0'), ['guard']],
  ];
  const untouched: string[] = [];
  const undetected: string[] = [];
  const unpinned: string[] = [];
  for (const [label, page, source, targets] of drifts) {
    if (page === html && source === widthSource) untouched.push(label);
    const mutated = contract(page, source);
    if (targets.some((slot) => mutated[slot])) undetected.push(label);
    if (targets.some((slot) => !verdict[slot])) unpinned.push(label);
  }
  check('a drifted pre-paint clamp on either side turns the agreement check red',
    drifts.length === 11 && untouched.length === 0 && undetected.length === 0 &&
    unpinned.length === 0,
    untouched.length === 0 && undetected.length === 0 && unpinned.length === 0
      ? `${drifts.length} mutations detected`
      : `undetected=${JSON.stringify(undetected)}, baselineBroken=${JSON.stringify(unpinned)}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
