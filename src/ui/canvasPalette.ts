// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Sipeed Co., Ltd.

import { DARK_THEME, LIGHT_THEME, type Theme } from '../render/index.js';
import { COLORS, GRID, LIGHT_CHROME_TOKENS } from './metrics.js';
import type { ThemeId } from './theme.js';

export interface CanvasPalette {
  bg: string;
  text: string;
  text80: string;
  text50: string;
  bubbleBg: string;
  bubbleBorder: string;
  bubbleInk: string;
  gridMinor: string;
  gridMajor: string;
  axisTickMinor: string;
  axisTickMajor: string;
  warning: string;
  negative: string;
  selection: string;
  noDataColor: string;
  /**
   * Repeat display surfaces. The plot is split into the region still showing the
   * PREVIOUS sweep and the region already filled by the CURRENT one. They are opaque
   * because `Overlay.drawRegionTint` paints them on the grid canvas, whose
   * `lighten`/`darken` compositing is what keeps the traces on top: a dark surface wins
   * over the dark plot background but loses to a brighter trace; in the light theme the
   * comparison is inverted. Both stay close to the plot background so they read as a
   * region, not as a highlight.
   */
  repeatPreviousSurface: string;
  repeatCurrentSurface: string;
}

export function baseTheme(id: ThemeId): Theme {
  return id === 'light' ? LIGHT_THEME : DARK_THEME;
}

export function canvasPalette(id: ThemeId): CanvasPalette {
  const base = baseTheme(id);
  if (id === 'light') {
    return {
      bg: base.background,
      text: LIGHT_CHROME_TOKENS['--text']!,
      text80: LIGHT_CHROME_TOKENS['--text80']!,
      text50: LIGHT_CHROME_TOKENS['--text50']!,
      bubbleBg: LIGHT_CHROME_TOKENS['--bg30']!,
      bubbleBorder: LIGHT_CHROME_TOKENS['--border-high']!,
      bubbleInk: base.background,
      gridMinor: '#eaeef2',
      gridMajor: '#f6f8fa',
      axisTickMinor: '#d1d9e0',
      axisTickMajor: '#818b98',
      warning: '#9a6700',
      negative: LIGHT_CHROME_TOKENS['--negative']!,
      selection: '#0969da',
      noDataColor: base.noDataColor,
      // [CHOSEN] Cool grey-blue for the outgoing sweep, warm cream for the incoming one.
      // On white both are far lighter than any trace colour, so `darken` leaves the
      // trace untouched; the hue difference separates the two regions without becoming
      // a highlight.
      repeatPreviousSurface: '#e4ecf7',
      repeatCurrentSurface: '#fff0d2',
    };
  }
  return {
    bg: base.background,
    text: COLORS.text,
    text80: COLORS.text80,
    text50: COLORS.text50,
    bubbleBg: COLORS.bg30,
    bubbleBorder: COLORS.borderHigh,
    bubbleInk: base.background,
    gridMinor: GRID.minorColor,
    gridMajor: GRID.majorColor,
    axisTickMinor: GRID.minorColor,
    axisTickMajor: GRID.majorColor,
    warning: COLORS.warning,
    negative: COLORS.negative,
    selection: COLORS.selection,
    noDataColor: base.noDataColor,
    // [CHOSEN] Cool navy for the outgoing sweep, warm amber for the incoming one. Both
    // are a little lighter than the #1B1B1C plot, so `lighten` shows them; they differ
    // from each other in both hue and luminance, which is what makes the boundary
    // readable while the new sweep fills in. Neither is bright enough to compete with a
    // channel trace.
    repeatPreviousSurface: '#1e2634',
    repeatCurrentSurface: '#3a301b',
  };
}
