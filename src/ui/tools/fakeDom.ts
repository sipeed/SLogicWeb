// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * A minimal DOM for self-tests that build real panel elements under node: enough of
 * Element, the document, focus and events for `selectControl`, the analog gain cell and
 * the bus editor dialog. It is not a browser - layout, CSS and the popover/top layer do
 * not exist - so tests drive controls the way the code listens to them (click, input,
 * keydown, blur, cancel) and assert on the resulting tree, values and callbacks.
 *
 * Focus follows the browser rules the panels depend on: focusing an element blurs the
 * previous one, and removing the focused element from the tree moves focus to the body
 * and fires `blur` on it (Chrome's behaviour; the panels must ignore that blur).
 */

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  key?: string;
  target?: FakeElement | null;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export function fakeEvent(type: string, init: { key?: string } = {}): FakeEvent {
  return {
    type,
    ...init,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

class FakeText {
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string { return this.data; }
}

type FakeChild = FakeElement | FakeText;

const camelToKebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

interface SimpleSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
  pseudo: string[];
}

function parseCompound(text: string): SimpleSelector {
  const sel: SimpleSelector = { tag: null, id: null, classes: [], attrs: [], pseudo: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]|:([\w-]+)/gy;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < text.length && (m = re.exec(text)) !== null) {
    if (m[1]) sel.tag = m[1].toLowerCase();
    else if (m[2]) sel.classes.push(m[2]);
    else if (m[3]) sel.id = m[3];
    else if (m[4]) sel.attrs.push({ name: m[4], value: m[5] === undefined ? null : m[5].replace(/\\(.)/g, '$1') });
    else if (m[6]) sel.pseudo.push(m[6]);
  }
  if (re.lastIndex !== text.length && text.length > 0) throw new Error(`fakeDom: unsupported selector ${text}`);
  return sel;
}

function matchesCompound(el: FakeElement, sel: SimpleSelector): boolean {
  if (sel.tag && el.localName !== sel.tag) return false;
  if (sel.id && el.id !== sel.id) return false;
  const classes = el.className.split(/\s+/).filter(Boolean);
  if (!sel.classes.every((c) => classes.includes(c))) return false;
  for (const a of sel.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  // No popover is ever shown here.
  if (sel.pseudo.includes('popover-open')) return false;
  return true;
}

/** Compound selectors joined by descendant (space) or child (`>`) combinators. */
function matchesSelector(el: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
    const matchFrom = (node: FakeElement | null, i: number): boolean => {
      // tokens[i] must match node; then the left side must match an ancestor.
      if (!node || !matchesCompound(node, parseCompound(tokens[i]!))) return false;
      if (i === 0) return true;
      if (tokens[i - 1] === '>') return matchFrom(node.parentNode, i - 2);
      for (let at = node.parentNode; at; at = at.parentNode) {
        if (matchFrom(at, i - 1)) return true;
      }
      return false;
    };
    return matchFrom(el, tokens.length - 1);
  });
}

export class FakeElement {
  readonly localName: string;
  parentNode: FakeElement | null = null;
  childNodes: FakeChild[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();
  className = '';
  title = '';
  hidden = false;
  disabled = false;
  type = '';
  value = '';
  checked = false;
  placeholder = '';
  inputMode = '';
  autocomplete = '';
  spellcheck = true;
  translate = true;
  min = '';
  max = '';
  step = '';
  htmlFor = '';
  open = false;
  validationMessage = '';
  reported = 0;
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  readonly dataset: Record<string, string | undefined>;

  constructor(readonly doc: FakeDocument, tag: string) {
    this.localName = tag.toLowerCase();
    const style: Record<string, string> = {};
    this.style = Object.assign(style, {
      setProperty(name: string, value: string) { style[name] = value; },
    }) as FakeElement['style'];
    const attrs = this.attributes;
    this.dataset = new Proxy({}, {
      get: (_t, key) => typeof key === 'string' ? attrs.get(`data-${camelToKebab(key)}`) : undefined,
      set: (_t, key, value) => {
        if (typeof key === 'string') attrs.set(`data-${camelToKebab(key)}`, String(value));
        return true;
      },
      deleteProperty: (_t, key) => {
        if (typeof key === 'string') attrs.delete(`data-${camelToKebab(key)}`);
        return true;
      },
      has: (_t, key) => typeof key === 'string' && attrs.has(`data-${camelToKebab(key)}`),
    });
  }

  get tagName(): string { return this.localName.toUpperCase(); }

  get id(): string { return this.attributes.get('id') ?? ''; }
  set id(v: string) { this.attributes.set('id', v); }

  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  get classList() {
    const self = this;
    const list = (): string[] => self.className.split(/\s+/).filter(Boolean);
    return {
      add(...names: string[]) { self.className = [...new Set([...list(), ...names])].join(' '); },
      remove(...names: string[]) { self.className = list().filter((c) => !names.includes(c)).join(' '); },
      contains(name: string) { return list().includes(name); },
      toggle(name: string, force?: boolean) {
        const on = force ?? !list().includes(name);
        if (on) this.add(name); else this.remove(name);
        return on;
      },
    };
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    this.replaceChildren(...(text === '' ? [] : [text]));
  }

  get isConnected(): boolean {
    let at: FakeElement | null = this;
    while (at) {
      if (at === this.doc.body) return true;
      at = at.parentNode;
    }
    return false;
  }

  get parentElement(): FakeElement | null { return this.parentNode; }

  setAttribute(name: string, value: string): void {
    if (name === 'class') this.className = value;
    else this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    if (name === 'class') return this.className || null;
    if (name === 'open' && (this.localName === 'details' || this.localName === 'dialog')) {
      return this.open ? '' : null;
    }
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }

  private adopt(node: FakeChild | string): FakeChild {
    const child = typeof node === 'string' ? new FakeText(node) : node;
    if (child.parentNode) child.parentNode.detach(child);
    child.parentNode = this;
    return child;
  }

  /** Remove one child; a focused element inside it loses focus (and blurs). */
  detach(child: FakeChild): void {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    if (child instanceof FakeElement) this.doc.noteRemoved(child);
  }

  append(...nodes: (FakeChild | string)[]): void {
    for (const node of nodes) this.childNodes.push(this.adopt(node));
  }
  appendChild<T extends FakeChild>(node: T): T {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes: (FakeChild | string)[]): void {
    for (const child of [...this.childNodes]) this.detach(child);
    this.append(...nodes);
  }
  remove(): void { this.parentNode?.detach(this); }

  contains(other: unknown): boolean {
    let at = other instanceof FakeElement ? other : null;
    while (at) {
      if (at === this) return true;
      at = at.parentNode;
    }
    return false;
  }

  matches(selector: string): boolean { return matchesSelector(this, selector); }
  closest(selector: string): FakeElement | null {
    let at: FakeElement | null = this;
    while (at) {
      if (at.matches(selector)) return at;
      at = at.parentNode;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return !event.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(fakeEvent('click'));
  }
  /** Like a browser: a detached or disabled element does not take focus. */
  focus(): void { if (this.isConnected && !this.disabled) this.doc.setFocus(this); }
  blur(): void { if (this.doc.activeElement === this) this.doc.setFocus(this.doc.body); }

  // input
  setCustomValidity(message: string): void { this.validationMessage = message; }
  reportValidity(): boolean {
    this.reported++;
    return this.validationMessage === '';
  }
  setSelectionRange(): void {}
  scrollIntoView(): void {}

  // dialog / popover
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  showPopover(): void {}
  hidePopover(): void {}
}

export class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement;

  constructor() {
    this.body = new FakeElement(this, 'body');
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }
  createElementNS(_ns: string, tag: string): FakeElement { return new FakeElement(this, tag); }
  createTextNode(text: string): FakeText { return new FakeText(text); }
  querySelector(selector: string): FakeElement | null { return this.body.querySelector(selector); }
  querySelectorAll(selector: string): FakeElement[] { return this.body.querySelectorAll(selector); }

  setFocus(next: FakeElement): void {
    const prev = this.activeElement;
    if (prev === next) return;
    this.activeElement = next;
    if (prev !== this.body) prev.dispatchEvent(fakeEvent('blur'));
  }

  noteRemoved(el: FakeElement): void {
    if (el.contains(this.activeElement)) this.setFocus(this.body);
  }
}

/** Install a fresh fake document as the global `document` (and `CSS.escape`). */
export function installFakeDom(): FakeDocument {
  const doc = new FakeDocument();
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.CSS ??= { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
  return doc;
}

/** Every element under `root` (inclusive) whose own text is exactly `text`. */
export function byText(root: FakeElement, text: string): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (el: FakeElement): void => {
    if (el.textContent === text) out.push(el);
    for (const child of el.children) walk(child);
  };
  walk(root);
  return out;
}
