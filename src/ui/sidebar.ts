import type { MessageKey } from './i18n.js';

export type SidebarPage = 'capture' | 'cursors' | 'decoders';

export const SIDEBAR_PAGES: readonly SidebarPage[] = ['capture', 'cursors', 'decoders'];

export interface SidebarState {
  readonly visible: boolean;
  readonly page: SidebarPage;
  readonly assistant: boolean;
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  visible: true,
  page: 'capture',
  assistant: false,
};

const LABEL_KEYS: Record<SidebarPage, MessageKey> = {
  capture: 'sidebar.pageCapture',
  cursors: 'sidebar.pageCursors',
  decoders: 'sidebar.pageDecoders',
};

export function selectSidebarPage(state: SidebarState, page: SidebarPage): SidebarState {
  if (state.visible && !state.assistant && state.page === page) return state;
  return { visible: true, page, assistant: false };
}

export function toggleSidebarVisible(state: SidebarState): SidebarState {
  return { visible: !state.visible, page: state.page, assistant: state.assistant };
}

export function hideSidebar(state: SidebarState): SidebarState {
  return { visible: false, page: state.page, assistant: false };
}

export function toggleAssistant(state: SidebarState): SidebarState {
  if (state.assistant) return { visible: state.visible, page: state.page, assistant: false };
  return showAssistant(state);
}

export function showAssistant(state: SidebarState): SidebarState {
  if (state.visible && state.assistant) return state;
  return { visible: true, page: state.page, assistant: true };
}

export function parseSidebarPage(raw: unknown): SidebarPage | null {
  if (typeof raw !== 'string') return null;
  switch (raw) {
    case 'capture':
    case 'cursors':
    case 'decoders':
      return raw;
    case 'device':
      return 'capture';
    case 'analyzers':
      return 'decoders';
    default:
      return null;
  }
}

export interface SidebarTab {
  readonly page: SidebarPage;
  readonly labelKey: MessageKey;
  readonly selected: boolean;
}

export function sidebarTabs(state: SidebarState): readonly SidebarTab[] {
  return SIDEBAR_PAGES.map((page) => ({
    page,
    labelKey: LABEL_KEYS[page],
    selected: state.visible && state.page === page,
  }));
}

export function tabTargetIndex(currentIndex: number, key: string, count: number): number | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  const step = key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0;
  if (step === 0) return null;
  const base = Number.isFinite(currentIndex)
    ? Math.min(Math.max(Math.trunc(currentIndex), 0), count - 1)
    : 0;
  return (base + step + count) % count;
}
