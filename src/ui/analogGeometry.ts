// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Analog trace geometry, canvas-free so `analog-geometry-selftest.ts` can assert on the
 * exact polyline the overlay strokes.
 *
 * The overlay draws an analog frame (`busView.ts` `AnalogFrame`) one of two ways:
 *
 *   - `points`: a Catmull-Rom curve through the sample values. `busView` keeps this form
 *     until a device-pixel column holds {@link SMOOTH_POINTS_MAX_SPP} samples, so the
 *     1.4-2 samples-per-column zoom that used to switch to a per-column envelope (and
 *     read as stair steps over rectangles) is a curve.
 *   - `columns`: a min/max band per column plus a centreline, both smoothed.
 */

/** Below this many samples per device-pixel column the exact points are drawn as a curve. */
export const SMOOTH_POINTS_MAX_SPP = 4;

/**
 * A smooth curve through the analog points, as a function of x: `visit` receives the
 * first point and then every interpolated sample, and every input point is visited
 * exactly. `steps` is the samples per span; callers working from one column per device
 * pixel can lower it, since the source is already resolved in x.
 *
 * Catmull-Rom tangents (the centred difference, in x, so uneven spacing is handled)
 * limited the Fritsch-Carlson way, i.e. a monotone cubic Hermite spline. x advances
 * linearly inside a span, so the curve can never step back in x; and each span stays
 * monotone between its two end values, so a local extremum is a sample, never an
 * overshoot. Plain parametric Catmull-Rom loops backwards where a held value makes the
 * spacing uneven (points 0, 10, 11, 21 px), which draws as a riser - a stair edge.
 * `xs` must be increasing.
 */
export function catmullRomWalk(
  xs: readonly number[], ys: readonly number[],
  visit: (x: number, sample: number) => void, steps = 12,
): void {
  const n = xs.length;
  if (n === 0) return;
  visit(xs[0]!, ys[0]!);
  if (n === 1) return;
  const secant = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const h = xs[i + 1]! - xs[i]!;
    secant[i] = h > 0 ? (ys[i + 1]! - ys[i]!) / h : 0;
  }
  const m = new Float64Array(n);
  m[0] = secant[0]!;
  m[n - 1] = secant[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const a = secant[i - 1]!;
    const b = secant[i]!;
    // A turning point (or a flat neighbour) gets a flat tangent: the extremum is the sample.
    if (a * b <= 0) { m[i] = 0; continue; }
    const h = xs[i + 1]! - xs[i - 1]!;
    m[i] = h > 0 ? (ys[i + 1]! - ys[i - 1]!) / h : 0;
  }
  for (let i = 0; i < n - 1; i++) {
    const d = secant[i]!;
    if (d === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const alpha = m[i]! / d;
    const beta = m[i + 1]! / d;
    const r = alpha * alpha + beta * beta;
    if (r > 9) {
      const tau = 3 / Math.sqrt(r);
      m[i] = tau * alpha * d;
      m[i + 1] = tau * beta * d;
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const x1 = xs[i]!, y1 = ys[i]!;
    const x2 = xs[i + 1]!, y2 = ys[i + 1]!;
    const h = x2 - x1;
    const m1 = m[i]! * h;
    const m2 = m[i + 1]! * h;
    for (let step = 1; step <= steps; step++) {
      if (step === steps) { visit(x2, y2); break; }
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const py = (2 * t3 - 3 * t2 + 1) * y1 + (t3 - 2 * t2 + t) * m1 +
        (-2 * t3 + 3 * t2) * y2 + (t3 - t2) * m2;
      visit(x1 + t * h, py);
    }
  }
}

/**
 * Subdivisions per span for a curve through `xs` (CSS px): about one per CSS px of
 * spacing, 1..12. A run of points a fraction of a pixel apart is already resolved in x,
 * so the path stays O(points) - bounded by the four points per device column the points
 * form allows - instead of twelve segments per sample.
 */
export function traceSteps(xs: readonly number[]): number {
  if (xs.length < 2) return 1;
  const spacing = (xs[xs.length - 1]! - xs[0]!) / (xs.length - 1);
  return Math.max(1, Math.min(12, Math.ceil(spacing)));
}

/** The polyline a points run is stroked as (the curve `smoothTrace` draws), in data y. */
export function smoothPolyline(
  xs: readonly number[], ys: readonly number[],
): { x: number[]; y: number[] } {
  const x: number[] = [];
  const y: number[] = [];
  catmullRomWalk(xs, ys, (px, py) => { x.push(px); y.push(py); }, traceSteps(xs));
  return { x, y };
}

/**
 * The two edges of a column frame's min/max band, as Catmull-Rom curves through the
 * per-column maxima and minima.
 *
 * A straight envelope through one column per device pixel is a staircase, and the old
 * polygon fill built that way read as a rectangular backdrop behind the centreline at
 * some zoom windows. Smoothing both edges turns the band into a curve at every zoom.
 *
 * Both edges are sampled at the same x positions so they can be clamped against each
 * other: a spline through a steep jump can overshoot, and an unclamped upper edge would
 * cross below the lower edge where the band is thin, filling as a bow-tie.
 */
export function smoothBandEdges(
  xs: readonly number[], mins: readonly number[], maxs: readonly number[],
): { x: number[]; upper: number[]; lower: number[] } {
  // A span is already about one device pixel wide in the columns path; twelve
  // subdivisions per span would only add path points, not visible smoothness.
  const steps = Math.max(2, Math.min(12, Math.ceil(480 / Math.max(1, xs.length))));
  const x: number[] = [];
  const upper: number[] = [];
  const rawLower: number[] = [];
  catmullRomWalk(xs, maxs, (px, py) => { x.push(px); upper.push(py); }, steps);
  catmullRomWalk(xs, mins, (_px, py) => { rawLower.push(py); }, steps);
  const lower: number[] = [];
  for (let i = 0; i < upper.length; i++) {
    let hi = upper[i]!;
    let lo = rawLower[i]!;
    if (hi < lo) {
      const mid = (hi + lo) / 2;
      hi = mid;
      lo = mid;
    }
    upper[i] = hi;
    lower.push(lo);
  }
  return { x, upper, lower };
}
