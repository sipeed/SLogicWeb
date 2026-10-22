// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza

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
  };
}
