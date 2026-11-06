import { MenuStack, type ExclusiveMenu } from '../menuStack.js';
import type { CloseReason } from '../settingsMenu.js';

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

interface CloseCall {
  id: string;
  reason: CloseReason;
}

class SpyMenu implements ExclusiveMenu {
  readonly calls: CloseReason[] = [];

  constructor(readonly id: string) {}

  close(reason: CloseReason): void {
    this.calls.push(reason);
  }
}

const ids = ['language-menu', 'theme-menu'] as const;

const spies = (): SpyMenu[] => ids.map((id) => new SpyMenu(id));

const callsOf = (menus: readonly SpyMenu[]): CloseCall[] =>
  menus.flatMap((menu) => menu.calls.map((reason): CloseCall => ({ id: menu.id, reason })));

const expectClosed = (except: SpyMenu | null, reason: CloseReason): CloseCall[] =>
  ids.filter((id) => id !== except?.id).map((id): CloseCall => ({ id, reason }));

const sameCalls = (a: readonly CloseCall[], b: readonly CloseCall[]): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [items.slice()]
    : items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));

{
  const stack = new MenuStack();
  const menus = spies();
  for (const menu of menus) stack.register(menu);
  stack.closeOthers(menus[1]!, 'outside');
  check(
    'closeOthers closes every other registered menu with the exact reason and never the kept one',
    sameCalls(callsOf(menus), expectClosed(menus[1]!, 'outside')),
    `calls=${JSON.stringify(callsOf(menus))}`,
  );
}

{
  const stack = new MenuStack();
  const menus = spies();
  for (const menu of menus) stack.register(menu);
  stack.closeOthers(null, 'resize');
  check(
    'closeOthers with no kept menu closes every registered menu',
    sameCalls(callsOf(menus), expectClosed(null, 'resize')),
    `calls=${JSON.stringify(callsOf(menus))}`,
  );
}

{
  const stack = new MenuStack();
  const menus = spies();
  for (const menu of menus) stack.register(menu);
  stack.closeAll('theme');
  check(
    'closeAll closes every registered menu, including the one a closeOthers call would keep',
    sameCalls(callsOf(menus), expectClosed(null, 'theme')),
    `calls=${JSON.stringify(callsOf(menus))}`,
  );
}

{
  const stack = new MenuStack();
  const menus = spies();
  for (const menu of menus) {
    stack.register(menu);
    stack.register(menu);
  }
  stack.closeOthers(menus[0]!, 'escape');
  stack.closeAll('retranslate');
  const calls = menus.map((menu) => menu.calls.join());
  check(
    'registering the same instance twice never duplicates a close call',
    calls.join('|') === 'retranslate|escape,retranslate',
    `calls=${JSON.stringify(calls)}, all=${JSON.stringify(callsOf(menus))}`,
  );
}

{
  const failures: string[] = [];
  for (const order of permutations(ids)) {
    const stack = new MenuStack();
    const menus = spies();
    for (const id of order) stack.register(menus[ids.indexOf(id)]!);
    const keep = menus[ids.indexOf('language-menu')]!;
    keep.calls.length = 0;
    stack.closeOthers(keep, 'escape');
    if (!sameCalls(callsOf(menus), expectClosed(keep, 'escape'))) {
      failures.push(`${order.join('>')}:${JSON.stringify(callsOf(menus))}`);
    }
  }
  check(
    'registration order never changes which menus close or with which reason',
    failures.length === 0,
    `permutations=${permutations(ids).length}, failures=${JSON.stringify(failures)}`,
  );
}

{
  const stack = new MenuStack();
  const registered = new SpyMenu('language-menu');
  const stranger = new SpyMenu('theme-menu');
  stack.register(registered);
  stack.closeOthers(null, 'outside');
  stack.closeAll('theme');
  const empty = new MenuStack();
  let threw = false;
  try {
    empty.closeOthers(null, 'outside');
    empty.closeAll('retranslate');
  } catch {
    threw = true;
  }
  check(
    'an empty stack is a silent no-op and unregistered menus are never touched',
    !threw && stranger.calls.length === 0 &&
      registered.calls.join() === 'outside,theme',
    `threw=${threw}, stranger=${stranger.calls.length}, registered=${registered.calls.join()}`,
  );
}

{
  const stack = new MenuStack();
  const menus = spies();
  for (const menu of menus) stack.register(menu);
  stack.closeOthers(menus[1]!, 'pick');
  const order = menus.map((menu) => `${menu.id}:${menu.calls.join() || '-'}`);
  check(
    'each menu sees exactly one close call per closeOthers pass',
    order.join(' ') === 'language-menu:pick theme-menu:-',
    `order=${order.join(' ')}`,
  );
}

{
  const losingKeep = (menus: SpyMenu[], _keep: SpyMenu | null, reason: CloseReason): CloseCall[] => {
    for (const menu of menus) menu.close(reason);
    return callsOf(menus);
  };
  const realKeep = (menus: SpyMenu[], keep: SpyMenu | null, reason: CloseReason): CloseCall[] => {
    const stack = new MenuStack();
    for (const menu of menus) stack.register(menu);
    stack.closeOthers(keep, reason);
    return callsOf(menus);
  };
  const wrongReason = (menus: SpyMenu[], keep: SpyMenu | null): CloseCall[] => {
    const stack = new MenuStack();
    for (const menu of menus) stack.register(menu);
    stack.closeOthers(keep, 'theme');
    return callsOf(menus);
  };
  const predicate = (run: (menus: SpyMenu[], keep: SpyMenu | null, reason: CloseReason) => CloseCall[]): boolean => {
    const menus = spies();
    return sameCalls(run(menus, menus[0]!, 'outside'), expectClosed(menus[0]!, 'outside'));
  };
  const wrongReasonPredicate = (): boolean => {
    const menus = spies();
    return sameCalls(wrongReason(menus, menus[0]!), expectClosed(menus[0]!, 'outside'));
  };
  check(
    'control: a stack that closes the kept menu and one that closes with the wrong reason both fail the same predicate',
    predicate(realKeep) && !predicate(losingKeep) && !wrongReasonPredicate(),
    `real=${predicate(realKeep)}, losingKeep=${predicate(losingKeep)}, wrongReason=${wrongReasonPredicate()}`,
  );
}

{
  const source = readSource('src/ui/menuStack.ts');
  const domNeedles = ['document.', 'window.', 'addEventListener', 'innerHTML', 'querySelector', 'createElement'];
  const hits = domNeedles.filter((needle) => source.includes(needle));
  const mutated = `${source}\ndocument.addEventListener('keydown', () => {});\n`;
  check(
    'the stack module owns no DOM, no listeners and no markup',
    hits.length === 0 && domNeedles.some((needle) => mutated.includes(needle)),
    `hits=${JSON.stringify(hits)}`,
  );
}

{
  const source = readSource('src/ui/menuStack.ts');
  const mutated = source.replace('if (menu !== keep) menu.close(reason);', 'menu.close(reason);');
  const guardsKeep = (text: string): boolean => text.includes('if (menu !== keep) menu.close(reason);');
  check(
    'control: dropping the kept-menu guard in the source is detected by the same needle',
    mutated !== source && guardsKeep(source) && !guardsKeep(mutated),
    `real=${guardsKeep(source)}, mutated=${guardsKeep(mutated)}`,
  );
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
