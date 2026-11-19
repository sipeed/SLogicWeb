// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.

import type { TriggerMode } from './state.js';

/**
 * The trigger glyph. In a row's trigger slot an unset trigger is a faint dashed rising
 * edge - recognisably "the trigger control" - rather than a bare dash, which read as
 * collapse/delete (UX review L3). Inside the mode menu the "none" item keeps the flat
 * dash, where its label explains it.
 */
export function triggerIcon(mode: TriggerMode, place: 'slot' | 'menu' = 'slot'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const unsetSlot = mode === 'dont-care' && place === 'slot';
  const d = mode === 'falling' ? 'M1 4H8V12H23'
    : mode === 'rising' ? 'M1 12H8V4H23'
      : mode === 'edge' ? 'M1 4H6L18 12H23M1 12H6L18 4H23'
        : mode === 'high' ? 'M1 4H23'
          : mode === 'low' ? 'M1 12H23'
            : unsetSlot ? 'M2 12H9V4H22'
              : 'M6 8H18';
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  if (unsetSlot) {
    path.setAttribute('stroke-dasharray', '2 3');
    svg.dataset['triggerIcon'] = 'unset';
  }
  svg.appendChild(path);
  return svg;
}
