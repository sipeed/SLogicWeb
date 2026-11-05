// SPDX-License-Identifier: GPL-3.0-or-later

import { FRAME_COST_RING, FrameCostRing, framesPerSecond } from '../frameStats.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

function referencePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p / 100 * sorted.length)));
  return sorted[rank - 1]!;
}

{
  const ring = new FrameCostRing();
  const empty = ring.count === 0 && ring.percentile(50) === 0 && ring.percentile(95) === 0 &&
    ring.percentile(100) === 0 && ring.max === 0;
  check('an empty ring reports no samples and zero cost',
    empty, `count=${ring.count}, p50=${ring.percentile(50)}, p100=${ring.percentile(100)}, ` +
    `max=${ring.max}, ring=${FRAME_COST_RING}`);
}

{
  const values = [7.5, 2.25, 11, 0.5, 4, 19.75, 3.125, 8, 15.5, 1, 6.75, 12.5, 9.5, 0.25];
  const ring = new FrameCostRing();
  for (const value of values) ring.push(value);
  const probes = [0, 1, 10, 25, 50, 75, 90, 95, 99, 100];
  const bad = probes.filter((p) => ring.percentile(p) !== referencePercentile(values, p));
  const monotone = probes.every((p, i) =>
    i === 0 || ring.percentile(p) >= ring.percentile(probes[i - 1]!));
  check('percentiles match a brute-force sort of the stored costs',
    bad.length === 0 && monotone && ring.count === values.length,
    bad.length === 0
      ? `${probes.length} probes of ${values.length} costs match; counts=${ring.count}`
      : bad.map((p) => `p${p} ${ring.percentile(p)} != ${referencePercentile(values, p)}`).join('; '));
}

{
  const ring = new FrameCostRing();
  const pushed = FRAME_COST_RING + 37;
  for (let i = 0; i < pushed; i++) ring.push(i);
  const retained: number[] = [];
  for (let i = pushed - FRAME_COST_RING; i < pushed; i++) retained.push(i);
  const newest = pushed - 1;
  const oldest = pushed - FRAME_COST_RING;
  const reference = [0, 50, 95, 100].map((p) => referencePercentile(retained, p));
  const actual = [0, 50, 95, 100].map((p) => ring.percentile(p));
  check('the ring keeps only the newest costs after it wraps',
    ring.count === FRAME_COST_RING && ring.percentile(100) === newest &&
    ring.percentile(0) === oldest && reference.every((want, i) => actual[i] === want),
    `count=${ring.count}, max=${ring.percentile(100)}/${newest}, min=${ring.percentile(0)}/${oldest}, ` +
    `p0/p50/p95/p100=${actual.join('/')} want ${reference.join('/')}`);
}

{
  const ring = new FrameCostRing();
  for (let i = 0; i < 5; i++) ring.push(20 + i);
  ring.reset();
  const cleared = ring.count === 0 && ring.percentile(50) === 0 && ring.max === 0;
  ring.push(3);
  const fresh = ring.count === 1 && ring.percentile(100) === 3 && ring.max === 3;
  check('reset clears the count and the stored costs',
    cleared && fresh, `cleared=${cleared}, fresh=${fresh}, count=${ring.count}, p100=${ring.percentile(100)}`);
}

{
  const cases: [number, number, number][] = [
    [60, 1000, 60],
    [10, 500, 20],
    [0, 1000, 0],
    [10, 0, 0],
    [10, -5, 0],
    [1, 33.3, 1000 / 33.3],
  ];
  const bad = cases.filter(([count, elapsed, want]) => framesPerSecond(count, elapsed) !== want);
  check('framesPerSecond converts a count over an interval and guards a zero interval',
    bad.length === 0,
    bad.length === 0
      ? `${cases.length} cases match`
      : bad.map(([count, elapsed, want]) => `${count}/${elapsed} want ${want}`).join('; '));
}

{
  const fs = nodeProcess.getBuiltinModule?.('fs') as {
    readFileSync(path: string, encoding: string): string;
  } | undefined;
  if (!fs) throw new Error('node fs module unavailable');
  const app = fs.readFileSync('src/ui/app.ts', 'utf8');
  const start = app.indexOf('private frame = ');
  const end = start >= 0 ? app.indexOf('private frameStats():', start) : -1;
  const frame = end > start ? app.slice(start, end) : '';
  const permitted = frame.includes('this.liveFramesPermitted += 1;');
  const drawnAt = frame.indexOf('this.liveFramesDrawn += 1;');
  const costStart = frame.indexOf('const drawStartedAt = performance.now();');
  const drawCall = frame.indexOf('this.draw();');
  const recorded = frame.indexOf('this.recordFrameCost(performance.now() - drawStartedAt, liveDue);');
  const finallyBlock = recorded > 0 && frame.lastIndexOf('} finally {', recorded) > 0;
  const timed = costStart >= 0 && drawCall > costStart && recorded > drawCall && finallyBlock;
  check('the frame loop counts permitted frames and times draw() around the call',
    frame.length > 0 && permitted && timed && drawnAt > 0,
    `frame=${frame.length}, permitted=${permitted}, timed=${timed}, drawn=${drawnAt > 0}`);
  const exposed = app.includes('frameStats: (): FrameStatsSnapshot => this.frameStats(),') &&
    app.includes('resetFrameStats: (): void => this.resetFrameStats(),');
  check('the debug surface exposes the live frame statistics and their reset',
    exposed, `frameStats=${app.includes('frameStats: (): FrameStatsSnapshot =>')}, ` +
    `reset=${app.includes('resetFrameStats: (): void =>')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
