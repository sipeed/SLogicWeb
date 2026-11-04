import { t } from './i18n.js';
import {
  SIDEBAR_PAGES, sidebarTabs, tabTargetIndex,
  type SidebarPage, type SidebarState,
} from './sidebar.js';

export interface SidebarHostCallbacks {
  mount(page: SidebarPage, container: HTMLElement): void;
  select(page: SidebarPage): void;
  collapse(): void;
  expand(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function button(className: string, label: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  return el;
}

function chevron(direction: 'left' | 'right'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', direction === 'right' ? 'M9 18l6-6-6-6' : 'M15 18l-6-6 6-6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function iconButton(className: string, direction: 'left' | 'right'): HTMLButtonElement {
  const el = button(`analyzer-act ${className}`, '');
  el.setAttribute('aria-controls', 'side-panel');
  el.appendChild(chevron(direction));
  return el;
}

function pageContainerId(page: SidebarPage): string {
  return `side-page-${page}`;
}

export class SidebarHost {
  private readonly strip: HTMLDivElement;
  private readonly tablist: HTMLDivElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly tabs = new Map<SidebarPage, HTMLButtonElement>();
  private readonly pages = new Map<SidebarPage, HTMLElement>();
  private readonly mounted = new Set<SidebarPage>();
  private readonly layer: HTMLDivElement;
  private covered = false;

  constructor(private readonly root: HTMLElement, private readonly cb: SidebarHostCallbacks) {
    this.strip = div('side-tabs');
    this.collapseButton = iconButton('side-collapse', 'right');
    this.collapseButton.setAttribute('aria-expanded', 'true');
    this.collapseButton.addEventListener('click', () => this.cb.collapse());

    this.tablist = div('segmented side-pages');
    this.tablist.setAttribute('role', 'tablist');
    for (const page of SIDEBAR_PAGES) {
      const tab = button('seg', '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', pageContainerId(page));
      tab.setAttribute('aria-selected', 'false');
      tab.tabIndex = -1;
      tab.addEventListener('click', () => this.cb.select(page));
      tab.addEventListener('keydown', (event) => this.onTabKey(event, page));
      this.tabs.set(page, tab);
      this.tablist.appendChild(tab);
    }
    this.strip.append(this.collapseButton, this.tablist);
    this.root.appendChild(this.strip);

    for (const page of SIDEBAR_PAGES) {
      const container = div('side-page');
      container.id = pageContainerId(page);
      container.dataset.page = page;
      container.hidden = true;
      this.pages.set(page, container);
      this.root.appendChild(container);
    }

    this.layer = div('side-assistant');
    this.layer.hidden = true;
    this.root.appendChild(this.layer);

    this.expandButton = iconButton('side-expand', 'left');
    this.expandButton.setAttribute('aria-expanded', 'false');
    this.expandButton.hidden = true;
    this.expandButton.addEventListener('click', () => this.cb.expand());
    (this.root.parentElement ?? this.root).appendChild(this.expandButton);
    this.syncNames();
  }

  containerFor(page: SidebarPage): HTMLElement {
    const container = this.pages.get(page);
    if (container === undefined) throw new Error(`unknown sidebar page: ${page}`);
    if (!this.mounted.has(page)) {
      this.mounted.add(page);
      this.cb.mount(page, container);
    }
    return container;
  }

  assistantLayer(): HTMLElement {
    return this.layer;
  }

  show(state: SidebarState): void {
    const tabs = sidebarTabs(state);
    const anySelected = tabs.some((tab) => tab.selected);
    const covered = state.visible && state.assistant;
    this.root.dataset.page = state.page;
    this.root.dataset.assistant = String(state.assistant);
    this.root.classList.toggle('hidden', !state.visible);
    this.collapseButton.setAttribute('aria-expanded', String(state.visible));
    this.expandButton.hidden = state.visible;
    this.strip.inert = state.assistant;
    if (covered && !this.covered) this.root.scrollTop = 0;
    this.covered = covered;
    for (const tab of tabs) {
      const container = this.pages.get(tab.page);
      if (container !== undefined) {
        container.hidden = covered || tab.page !== state.page;
        container.inert = state.assistant;
      }
      const node = this.tabs.get(tab.page);
      if (node === undefined) continue;
      node.textContent = t(tab.labelKey);
      node.classList.toggle('on', tab.selected);
      node.setAttribute('aria-selected', String(tab.selected));
      node.tabIndex = tab.selected || (!anySelected && tab.page === state.page) ? 0 : -1;
    }
    this.layer.hidden = !covered;
    this.syncNames();
  }

  focusAfterCollapse(): void {
    this.expandButton.focus({ preventScroll: true });
  }

  focusAfterExpand(): void {
    this.collapseButton.focus({ preventScroll: true });
  }

  dispose(): void {
    this.strip.remove();
    for (const page of this.pages.values()) page.remove();
    this.pages.clear();
    this.mounted.clear();
    this.tabs.clear();
    this.layer.remove();
    this.expandButton.remove();
  }

  private syncNames(): void {
    const collapse = t('sidebar.collapse');
    this.tablist.setAttribute('aria-label', t('sidebar.pagesLabel'));
    this.collapseButton.setAttribute('aria-label', collapse);
    this.collapseButton.title = collapse;
    const expand = t('sidebar.expand');
    this.expandButton.setAttribute('aria-label', expand);
    this.expandButton.title = expand;
  }

  private onTabKey(event: KeyboardEvent, page: SidebarPage): void {
    const index = SIDEBAR_PAGES.indexOf(page);
    const target = tabTargetIndex(index, event.key, SIDEBAR_PAGES.length);
    if (target === null) return;
    event.preventDefault();
    const next = SIDEBAR_PAGES[target];
    if (next === undefined) return;
    this.tabs.get(next)?.focus({ preventScroll: true });
    this.cb.select(next);
  }
}
