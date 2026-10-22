// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * Every appearance constant the shell uses, with where it came from.
 *
 * Rules, same as the rest of this project:
 *   [MEASURED] - read off rendered output on this machine,
 *                which converts through the embedded ICC profile first and which carries
 *                a control that proves it can fail.
 *   [CHOSEN]   - a design decision, with the reasoning stated inline.
 *   [CHOICE]   - ours. Not in the spec, not in a screenshot, and labelled so nobody later
 *                mistakes it for an observation.
 *
 * All lengths are CSS px. The screenshots are 3200x2000 at devicePixelRatio 2, so a
 * measurement of 96 device px is written here as 48.
 */

/**
 * [CHOSEN] The 8 digital-channel colours, cycled so that every group of eight reads
 * red, orange, yellow, green, brown, blue, cyan, magenta: D8k+0..D8k+7 are those in that
 * order, and D8(k+1)+0 starts the cycle again.
 *
 * This list drives the labels, chips and strips; the waveform itself uses
 * LOGIC2_CHANNEL_COLORS in src/render/theme.ts. The two are identical on purpose -
 * change both together, or a channel is drawn in one colour and named in another.
 */
export const CHANNEL_COLORS: readonly string[] = [
  '#C81A21', // D8k+0 red
  '#E4602A', // D8k+1 orange
  '#997100', // D8k+2 yellow
  '#5A7100', // D8k+3 green
  '#B0733C', // D8k+4 brown
  '#3191D9', // D8k+5 blue
  '#007971', // D8k+6 cyan
  '#E94D95', // D8k+7 magenta
];

/**
 * [CHOSEN] Dialog preset colors. The existing eight defaults come first so familiar
 * channel colors are always one click away; seven bright additions widen the hue range
 * while remaining visible on the dark plot. This is picker content only, not a second
 * default cycle: CHANNEL_COLORS and LOGIC2_CHANNEL_COLORS stay unchanged.
 */
export const CHANNEL_COLOR_PRESETS: readonly string[] = [
  ...CHANNEL_COLORS,
  '#FB7185', // rose
  '#F472B6', // pink
  '#E879F9', // fuchsia
  '#C084FC', // purple
  '#818CF8', // indigo
  '#22D3EE', // cyan
  '#2DD4BF', // teal
];


/** [CHOSEN] . */
export const COLORS = {
  /** Darkest background, used for the toolbar's inactive areas. */
  bg00: '#141415',
  /** [MEASURED] The plot background, the label column and the toolbar are all this. */
  bg10: '#1B1B1C',
  bg20: '#212224',
  /** [SOURCE] background-30. [MEASURED] also the badge background on a multi-bubble. */
  bg30: '#2C2C2E',
  /** [MEASURED] the right icon rail and the status bar. [SOURCE] calls this "hover". */
  panel: '#3A3A3E',
  borderLow: '#303136',
  borderHigh: '#57575E',
  text: '#FFFFFF',
  text80: '#E0E0E0',
  text50: '#909091',
  accent: '#775AD2',
  selection: '#26A3D9',
  negative: '#f52a66',
  warning: '#fbd86f',
  stop: '#db4c39',
} as const;

export function chipForeground(fill: string): string {
  const v = parseInt(fill.slice(1), 16);
  const linear = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * linear((v >> 16) & 255) + 0.7152 * linear((v >> 8) & 255) +
    0.0722 * linear(v & 255);
  return lum < 0.2 ? '#FFFDF4' : '#141415';
}

export const LIGHT_CHROME_TOKENS: Record<string, string> = {
  '--background': '#FDF6E3',
  '--foreground': '#57534A',
  '--card': '#EEE8D5',
  '--card-foreground': '#3C3836',
  '--popover': '#F6F0DE',
  '--popover-foreground': '#3C3836',
  '--secondary': '#DED5BA',
  '--secondary-foreground': '#3C3836',
  '--muted': '#E6DEC6',
  '--muted-foreground': '#6F6A5A',
  '--primary': '#775AD2',
  '--primary-foreground': '#FFFFFF',
  '--destructive': '#C43B2A',
  '--destructive-foreground': '#FFFFFF',
  '--border': '#DDD5BE',
  '--input': '#CDC3A6',
  '--ring': '#775AD2',
  '--shadow': 'oklch(0 0 0 / 18%)',
  '--backdrop': 'rgb(0 0 0 / 35%)',
  '--radius': '0.625rem',
  '--console-fg': '#1F6B4A',
  '--bg00': '#E6DEC7',
  '--bg10': '#FDF6E3',
  '--bg20': 'var(--card)',
  '--bg30': '#FFFDF4',
  '--panel': '#DED5BB',
  '--border-low': 'var(--border)',
  '--border-high': '#B4AB90',
  '--text': '#3C3836',
  '--text80': '#57534A',
  '--text50': '#6F6A5A',
  '--accent': '#775AD2',
  '--negative': '#B31246',
  '--stop': 'var(--destructive)',
};

/**
 * [MEASURED] on 01-idle-empty-session.png, and identical on 02/03/04/05.
 * Device px in the comments, CSS px in the values.
 */
export const CHROME = {
  /** device y 66..125 */
  toolbarHeight: 56,
  /** device y 128..185 */
  axisHeight: 29,
  /** device y 1922..1999 */
  statusHeight: 39,
  /** [CHOICE] widened for the per-channel Trigger Enabled control. */
  labelColWidth: 170,
  /** device x 0..9, filled with the channel colour */
  colorStripWidth: 5,
  /** every border between two panels is 2 device px */
  borderWidth: 1,
} as const;

/**
 * Row geometry.
 *
 * `baseRowHeight` is NOT a constant - it is derived per capture, and the app
 * fits the stack to the window. [MEASURED] 48 CSS px in 02 and 05, 49 in 04, 53 in 03,
 * and in every one of them `rows * height + lanes * 20` lands within a few px of the
 * available height. So the shell computes it the same way and this is only the fallback.
 */
export const ROWS = {
  /** [CHOICE] fallback when the stack has no height yet. */
  baseRowHeight: 48,
  /**
   * [CHOSEN] The reserved channel card needs 46 px: 6 px of cell insets, 2 px of card
   * border, 4 px of body padding, an 18 px head, a 2 px gap and a 14 px decoder strip.
   * Keep 2 px of slack rather than letting dense captures clip the controls.
   */
  minRowHeight: 48,
  /** [CHOICE] Upper auto-fit clamp, so a 1-channel capture is not one 800 px row. */
  maxRowHeight: 72,
  /** [MEASURED] src/render/theme.ts, 4 device px of #57575E at every row boundary. */
  separator: 2,
  /** [MEASURED] 16 device px of clear space above the high line and below the low one. */
  gutter: 8,
  /** [SOURCE] ALWAYS_HIGH / ALWAYS_LOW are 1 px fillRects in CSS space. */
  lineWidth: 1,
  /**
   * [MEASURED] An annotated row is exactly 40 device px taller than a plain one in 02,
   * 04 and 05, and the lane sits ABOVE a trace band that keeps its plain height - see
   * NOTES.md section 2 for the idle-line offsets that establish this.
   * [SOURCE] agrees: "bubble rows are 16 px tall for low-level analyzers with 4 px top
   * padding" = 20.
   */
  laneHeight: 20,
  /** [MEASURED] device y rowTop+8 .. rowTop+40 */
  lanePadTop: 4,
  /** [MEASURED] 32 device px */
  bubbleHeight: 16,
} as const;

/**
 * Time axis.
 *
 * [SOURCE] "Minor tick spacing is chosen as the smallest power of ten that keeps ticks at
 * least 45 px apart; major spacing is exactly 10x the minor spacing."
 * [MEASURED] minor ticks 46.3 CSS px apart on 01, majors at 0/10/20/30 ms with 1 ms
 * minors - i.e. exactly that rule, at its boundary.
 */
export const AXIS = {
  /** [SOURCE] minimumHorizontalTickSpacingPx */
  minTickSpacing: 45,
  /** [SOURCE] "Tick text is 11 px bold, left-aligned, bottom baseline." */
  tickFont: 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  /** [MEASURED] major label ink at device y 136..152 -> baseline at CSS y 76 of the window,
   *  i.e. 12.5 CSS px below the top of the 29 px axis. */
  majorBaseline: 12.5,
  /** [MEASURED] minor label ink at device y 159..176. */
  minorBaseline: 24,
  /** [MEASURED] minor tick marks occupy device y 179..185 = the bottom 3.5 CSS px. */
  minorTickLength: 3.5,
  /** [SOURCE] "Major ticks draw a vertical line from half the axis height downward." */
  majorTickFraction: 0.5,
  /** [SOURCE] a 4x6 px left-pointing arrow marks a major tick pinned to x=0. */
  pinnedArrow: { w: 4, h: 6 },
} as const;

/**
 * [MEASURED] Vertical gridlines are dropped from every minor tick through the whole row
 * stack, 1 CSS px wide, dashed 3 CSS px on / 3 off.
 *
 * The surprise, and it is measured rather than assumed: the gridline at a MAJOR tick is
 * DIMMER than the one at a minor tick (#262629 against #39393D), not brighter. Checked on
 * all four majors of 01-idle-empty-session.png (device x 210, 1136, 2062, 2990) against
 * their neighbouring minors. Intuition said the opposite; the pixels did not.
 */
export const GRID = {
  minorColor: '#39393D',
  majorColor: '#262629',
  width: 1,
  dash: [3, 3] as [number, number],
} as const;

/**
 * Annotation bubbles.
 *
 * [CHOSEN] all of it: the multi-bubble count saturates at 99+, the badge
 * is a 9 px 2 px-padded 5 px-radius chip in background-30, an overflowing bubble is
 * clamped to the viewport and grows a 3 px triangle, tooltips cap at 80 characters.
 */
export const BUBBLE = {
  font: '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  /** [CHOICE] Pick the longest variant with `text.length * 6 < bubbleWidth`
   *  (CHAR_WIDTH = 6 at font-size 14). We measure the string instead, which is the same
   *  rule done exactly rather than approximately - see NOTES.md section 7. */
  padX: 4,
  radius: 2,
  /** [SOURCE] MAX_BUBBLES_COUNT */
  maxCount: 99,
  badgeFontPx: 9,
  badgePad: 2,
  badgeRadius: 5,
  /** [SOURCE] 3 px solid triangle on the overflowing side. */
  overflowTriangle: 3,
  /** [CHOICE] below this width a bubble cannot show even its shortest text, so it merges
   *  with its neighbours into a counted multi-bubble. */
  minLegibleWidth: 14,
  /** [SOURCE] tooltips cap at 80 characters. */
  tooltipChars: 80,
} as const;

/**
 * [CHOSEN] six analyzer colours -
 * I2C, Async Serial and SPI in that order, then three more in the same register.
 */
export const ANALYZER_COLORS: readonly string[] = [
  '#9A7B2E', '#A8504E', '#6E6A55', '#5A6579', '#4A7D5C', '#6E5F94',
];

/** [SOURCE] Range measurements have their own four-colour palette. */
export const MEASURE_COLORS: readonly string[] = ['#CD427E', '#00994D', '#2683D9', '#DB4C39'];

/** [CHOSEN] Zoom-in clamps at 20 samples across the full width. Re-exported from
 *  src/render so the UI cannot drift from the renderer's own clamp. */
export { MIN_SAMPLES_ON_SCREEN } from '../render/transform.js';
