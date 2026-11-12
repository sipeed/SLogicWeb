// SPDX-License-Identifier: GPL-3.0-or-later

export const TOOLBAR_HINT_ATTRIBUTE = 'data-hint-title';

const HINT_SELECTOR = `#toolbar [title], #toolbar [${TOOLBAR_HINT_ATTRIBUTE}]`;

export function applyToolbarHints(root: ParentNode, detailedLabels: boolean): number {
  const from = detailedLabels ? 'title' : TOOLBAR_HINT_ATTRIBUTE;
  const to = detailedLabels ? TOOLBAR_HINT_ATTRIBUTE : 'title';
  let moved = 0;
  for (const element of root.querySelectorAll(HINT_SELECTOR)) {
    const text = element.getAttribute(from);
    if (text === null || text === '') continue;
    element.setAttribute(to, text);
    element.removeAttribute(from);
    moved++;
  }
  return moved;
}
