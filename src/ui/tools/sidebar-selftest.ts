import {
  DEFAULT_SIDEBAR_STATE,
  hideSidebar,
  parseSidebarPage,
  selectSidebarPage,
  SIDEBAR_PAGES,
  sidebarTabs,
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
    'parseSidebarPage', 'sidebarTabs']
    .filter((name) => source.includes(`export function ${name}(`));
  check('the model is DOM-free, locale-free, comment-free, and exports the whole reducer surface',
    hits.length === 0 && api.length === 6,
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

const failed = results.filter((r) => !r.pass).length;
console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
