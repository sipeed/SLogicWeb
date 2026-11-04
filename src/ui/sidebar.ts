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

const LABEL_KEYS: Record<SidebarPage, string> = {
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
  readonly labelKey: string;
  readonly selected: boolean;
}

export function sidebarTabs(state: SidebarState): readonly SidebarTab[] {
  return SIDEBAR_PAGES.map((page) => ({
    page,
    labelKey: LABEL_KEYS[page],
    selected: state.visible && state.page === page,
  }));
}
