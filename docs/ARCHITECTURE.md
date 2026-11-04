# logicweb - module contracts

The point of this file is that several agents build in parallel without colliding. **Own
your directory, import across boundaries only through the interfaces below, do not edit
another module's files.** If you need a contract changed, say so in your report instead of
changing it unilaterally.

Stack: TypeScript, Vite, no UI framework unless a builder makes a case for one. Browser is
Brave (Chromium) - the only WebUSB-capable browser installed on this machine.

## Layout

```
src/
  device/     WebUSB transport for SLogic U3 devices         (owner: device builder)
  data/       sample storage + multiresolution query         (owner: data builder)
  render/     WebGL2 waveform canvas                         (owner: render builder)
  ui/         shell, channel rows, timebase, cursors         (owner: ui builder)
  decode/     protocol decoders in a worker                  (owner: decode builder)
bench/        the three measured numbers                     (owner: bench builder)
fixtures/     .sr captures from our own hardware, for the suites
docs/         specs, this file, progress                     (owner: lead)
```

## Contracts

### `src/device`

```ts
export interface CaptureConfig {
  channels: 4 | 8 | 16 | 32 | 64 | 128;
  samplerate: number;        // Hz, from the table in PROTOCOL-SLOGIC16U3.md
  thresholdVolts: number;    // mapped to the DAC code by the device layer
}

export interface Device {
  readonly name: string;
  readonly serial: string;
  start(cfg: CaptureConfig, sink: (chunk: Uint8Array) => void,
        onDropout?: (samplePosition: number, missingSamples: number) => void,
        options?: CaptureStartOptions): Promise<void>;
  stop(): Promise<void>;
}

export function requestDevice(): Promise<Device>;   // triggers the WebUSB picker
```

`onDropout` is reserved for a controller-level loss signal. A successful WebUSB short packet
is still delivered at its actual length and does not imply a gap; callers should not infer
missing samples from `data.byteLength < requestedLength`. If a future transport reports a
real loss, `samplePosition` and `missingSamples` identify the span for `SampleStore.noteGap`.
Samples are little-endian and occupy `ceil(channels / 8)` bytes after sub-8-channel wire
packing is expanded, so downstream code does not need a new representation at 32/64/128.

`chunk` is raw device bytes with the 4 junk head bytes already removed and sub-8-channel
packing already expanded. Samples are little-endian and occupy `ceil(channels / 8)` bytes
(2 at 16 channels, 4 at 32 channels).

### `src/data`

```ts
export interface SampleStore {
  readonly channelCount: number;
  readonly samplerate: number;
  readonly length: number;                 // samples
  /** Samples dropped from the front over this store's life - the loop window's left
   *  edge. Absolute position = store-relative position + droppedSamples. 0 for stores
   *  that never drop (RLE/imported captures). */
  readonly droppedSamples: number;
  append(chunk: Uint8Array): void;
  /** Forget the oldest `samples` (a multiple of DROP_FRONT_QUANTUM): every position
   *  shifts down and `length` shrinks, so a loop capture keeps only the newest
   *  window. Callers needing absolute positions keep their own drop offset.
   *  Imported captures cannot retain and throw; every live width (planar 4/64/128ch
   *  and interleaved 8/16/32ch) implements it, against absolute-addressed pyramids. */
  dropFront(samples: number): void;
  /** Downsampled view for rendering: for each of `bins` pixel columns over
   *  [startSample, endSample), the low bit, the high bit and whether the column
   *  contains at least one edge. Must be O(bins), not O(samples). */
  query(channel: number, startSample: number, endSample: number, bins: number): ColumnView;
  /** Exact edge positions, for cursors, measurement and decoders. */
  edges(channel: number, startSample: number, endSample: number): Int32Array;
  /** Count-only edge preflight without materialising the result, when implemented. */
  edgeCount?(channel: number, startSample: number, endSample: number): number;
  /** Record that samples [startSample, endSample) are unknown (a transfer dropout).
   *  Overlapping notes are merged. */
  noteGap(startSample: number, endSample: number): void;
  /** The unknown spans, sorted and non-overlapping; [] for a store without gaps. */
  gaps(): GapSpan[];
}
```

`CaptureStartOptions.softwareTrigger` enables a bounded host-side trigger. It accepts
one or more per-channel `level`, `rising`, `falling` or `edge` conditions; all confirmed
conditions must match the same complete sample (logical AND). While waiting, only the
single shared rolling pre-trigger window is retained; a match emits that window and
post-trigger samples to the sink. The `triggered` callback also reports the trigger
sample's zero-based position in that emitted stream. The UI uses it as `T=0`, draws a
vertical T marker, and labels every retained pre-trigger sample with negative time. The right
panel owns the global pre-trigger percentage and `Enable Mask`; disabling that mask leaves all
per-channel modes intact and merely bypasses the matcher. The UI's search allowance is
mode-specific: Repeat inspects one sweep's sample budget (output plus retained prefix) and
then reports `not-found`, so a missed wave ends as completed and the next Interval retries
(see B1 below); Single waits indefinitely for its one trigger, and Loop is unbounded. The
allowance is what makes a trigger at the nominal budget boundary still produce its final
post-trigger sample. If that
allowance is exhausted or the user stops first, `onTriggerState('not-found')` is reported
and the search prefix is discarded. Trigger-disabled captures keep the direct streaming path.
The implementation is tested for 4/8/16/32/64/128-channel sample widths and carries
partial wide samples across USB transfer boundaries.

When a software trigger is enabled, a timer capture's duration starts at the trigger sample,
not at `start()`: a Single matcher waits indefinitely while refreshing its bounded pre-trigger
ring. The matcher arms immediately, so a condition that is already true can match before
that ring fills. The emitted total remains the configured pre+post budget, which makes the
post-trigger span longer than the requested post by the missing prefix; the session
retained-range model still assumes the requested split, so a Fixed view that depends on the
extended tail can fall back to follow. That early-match split is a known limitation. A
manual stop before the match reports no trigger and discards the ring.

In Loop mode a software trigger also owns the viewport after it fires. The reported index
is in emitted-stream coordinates, so the App converts it to `reported - droppedSamples`
before using it as `T=0`; the retained window may already have dropped front samples while
the matcher was emitting. Two windows are kept apart: the data window D (Loop Duration L,
with T at the configured pre-trigger fraction, 0% on D's 0 s left edge) and the user's
ViewWindow V, stored as offsets from T. D's span is fixed and D never pans; V can be
zoomed and panned anywhere inside D, and Fit resets V to all of D.

An analog loop trigger advances D in local, phase-aligned steps. The page scans the ADC
group byte of each chunk at a bounded stride (about twenty million reads per second) and
records crossings. Only when samples exist beyond D's right edge does it plan a step: a
local block budget (whole signal periods when known, at most L/4, never more than the
fresh data) and the latest reported edge T' in `(T, T + budget]`, searched back from the
budget's end. It drops the front of D by `T' - T` and appends exactly that many new
samples at the tail; the rest of the new data waits for the next step. A strided scan
reports a crossing at the scanned sample; the scanner re-checks the scanned interval at
sample resolution, so the anchor is sample-exact except when a crossing straddles a chunk
boundary. The step is edge-to-edge - an integer number of signal periods for a periodic
input - so D keeps its phase and V updates in place. The store front drop is floored to
the 64-sample quantum, but that residue changes only store-relative coordinates: V's
offsets from T are unchanged, so it cannot shift the displayed waveform.

The lock means "the current data and trigger configuration still produce edges". It is
taken on the match, kept by every local step, and released only when no new edge has
appeared for one whole D (the data/config no longer triggers). If edges return while a
Loop runs free, the page locks again automatically. Fit, zoom and pan never release the
lock. While waiting, the store may carry a bounded excess over D (at most one window;
otherwise the larger of 50 ms and 65,536 samples, capped by 64 MiB of samples). While
locked, it also retains the new data the next local step needs: one crossing gap and, if
the signal stops, the quiet-window tail (f*D). The post-enforce bound is therefore
D + slack + max(f*D, one gap), plus at most one delivery block before the enforce pass; a
hard cap below the 2^31-sample store ceiling disarms the trigger and trims to D instead
of letting an append overflow (the panel says so; restart to re-arm). Follow-latest
resumes on a release only if it was
active at the lock. Digital loop triggers keep a one-shot lock: they never roll, so the
front drops normally and the view releases to follow once T leaves the retained window
(the status line says so). The lock and the crossing record are display state: no sample
is copied and the trigger ring keeps its existing bounds. Single and Repeat captures and
a trigger-disabled Loop keep their normal viewport rules.

A trigger-locked Loop keeps T on its trigger phase and D's span fixed. A viewport gesture
moves only V: zoom changes V's span (bounded by D), pan moves V inside D, and the stored
offsets from T are then applied unchanged on every local step. The waveform under V
therefore does not scroll, and T may sit off-screen after a pan; the axis still puts 0 s
at T. The overview strip maps the same fixed D window, and its gestures clamp V the same
way.

Sessions and sweeps are modelled explicitly in `captureSession.ts`. A new session starts
FollowLive; a user pan/zoom records a Fixed interval relative to the display origin (T when
the sweep has a trigger, else its start); Fixed survives Repeat waves while it fits the
sweep's retained range and otherwise falls back to the mode default, never an automatic
Fit. A Repeat sweep therefore never leaves a Fixed viewport empty: the previous completed
wave is retained as a layer (`repeatDisplay.ts`), and while the running sweep waits for its
trigger or has not reached the viewport, the old wave (with its own T) stays displayed. Once
the new sweep has data, `RepeatCompositeStore` serves its samples up to the frontier and the
old wave's samples beyond it in the same time frame; a mixed query merges every source bin
into each overlapping composite column (a source bin crossing a column boundary may
contribute to both - a bounded, conservative smear), while NO_DATA is decided from the
display's exact gap spans so `query` and `gaps()` agree. `Overlay.drawRegionTint` distinguishes
the old and current regions with two background surfaces (no vertical rule). FollowLive
reads the running store directly. A Repeat sweep that finds no trigger inspects one sweep's
sample budget, stops as completed with an empty store, reports the miss, and lets the next
Interval retry. Stopping a session while the previous wave is held adopts that wave as the
capture, so the plot, Save, measurement and the assistant all describe the same samples; a
marker placed on the old layer is remapped by the same origin offset. While the composite
is displayed the analog bus pyramid is suspended (its length is stable while its contents
change behind the frontier), and the bounded live/provisional envelope reads the composite
directly with the frontier in its frame-cache key. The Loop display's
local block plan (`displaySwap.ts`) is instrumentation for the matcher stride, anchor step,
budget block and retained bytes; the auto-roll itself still advances one scanned crossing at
a time.

The host matcher also has a `mode: 'continuous'` form for a device-side loop path
(`SoftwareTriggerConfig.mode`). After its first match it re-arms on the same unbounded
emitted stream and reports every later match at its absolute emitted-stream sample index;
`matchCount` and `lastTriggerSampleIndex` are authoritative even when `reportGapSamples`
throttles the callback, and `reconfigure()` remains live until the stream is terminal.
A `level` condition matches every emitted sample that still holds it, so a continuous
level trigger can produce one match per sample; use a rising/falling/edge condition (or
`reportGapSamples`) for pulse-rate events. Continuous scanning may stride
(`SoftwareTriggerConfig.scan`, default stride 1) to bound
CPU; a strided candidate hit is refined at stride 1 so the reported index is exact, but
candidates are `stride + 1` apart, so a pulse that lies entirely in the `stride` samples
between two candidates can be missed - keep the stride below the narrowest pulse that must
be caught. When a finite output budget ends between candidates, the remaining samples up to
the budget are refined at stride 1, so a crossing in the final tail is still reported. The
two scan buffers (history and refinement scratch) are capped at 64 MiB together, in
addition to the pre-trigger ring's own 64 MiB prefix cap; one-shot matching allocates
neither. Sample packing and whole-sample carry across USB transfers are unchanged. A live
retune after the first match recompiles only what changed: a condition or scan-policy edit
restarts edge continuity at the next sample, while a tuning-only edit (`reportGapSamples`
or an identical scan policy) keeps the scan state so an edge straddling the edit is not
lost. The App does not select this mode yet; until it does, Loop keeps the page-side analog
scanner and the one-shot digital lock described above, and Single/Repeat always use
one-shot.

The overview strip maps a fixed loop window while a loop runs (its true start `T - f*L`
while locked, so the 64-sample front-drop residue cannot shift it; the newest window in
free run), so its scale, ticks and viewport frame do not
follow the retained length; the density inside it rolls. A manual pan/zoom does not pause
the roll: the chosen viewport keeps its coordinates in that fixed window, and each
period-aligned roll replaces the samples under it, so a sub-window such as 30+5 us stays
at 30+5 us while its waveform updates in place. A new capture re-arms the trigger lock.

While the matcher is still waiting, its conditions can be retuned in place
(`SoftwareTrigger.reconfigure`, reached through `Device.updateSoftwareTrigger`): the
condition set is recompiled, edge continuity restarts so no transition is invented across
the edit, and the pre-trigger ring, emitted-stream accounting and inspected-sample budget
are preserved. Digital modes, the source family, condition removal and the analog level can
therefore be adjusted during the wait; removing every condition restarts the capture so it
runs free. The capture width, retained-prefix size and output budget are fixed for a running
capture and cannot be retuned. In one-shot mode, once the matcher has matched, the
capture's trigger is frozen: later edits are pending for the next acquisition, except
that a Loop's page-side analog detector is retuned in place and the lock survives only
while the new condition keeps producing edges. Global trigger is an arming decision for
the acquisition: turning it off while waiting restarts the capture free-running, turning
it off after a match releases the view in place and tears the page detector down so it
cannot re-lock, and turning it on in a capture that started free-running restarts the
acquisition because the one-shot matcher cannot begin matching mid-stream. In continuous
mode the matcher stays live after a match (see above) and accepts edits until it completes
or reports no trigger.

`query` being sublinear in sample count is the whole ballgame for the framerate metric.
Build the mip pyramid on append. Two implementations satisfy the contract:

- `PlanarSampleStore` - the live-capture store for 4/64/128-channel captures. One bit
  per sample per channel plus a pyramid.
- `InterleavedSampleStore` - the 8/16/32-channel live-capture store. It preserves
  byte-aligned little-endian uint8/uint16/uint32 samples and uses the same two-plane
  pyramid, avoiding synchronous sample rearrangement on the USB consumer path.
  `createSampleStore()` selects this layout automatically for 8, 16 and 32 channels.
- `RleSampleStore` - the import store, built from per-channel transition lists
  (`createTransitionStore()` quantises transition times to sample positions with the same
  rule the planar resample used: first sample at or after the transition, same-sample
  toggles cancel pairwise; `createEdgeStore()` takes transitions already in sample space).
  O(edges) to build and O(log edges-per-segment) per column to query; `append` throws -
  it is immutable. Loads are flat with capture size because nothing expands to samples.

`ColumnView` was left undefined here originally, which was a gap in this contract. The data
builder defined it in `src/data/types.ts` and flagged it rather than assuming the renderer
would agree. It is now the contract:

```ts
export interface ColumnView {
  readonly channel: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly bins: number;
  readonly low: Uint8Array;    // min sample value in the column
  readonly high: Uint8Array;   // max sample value in the column
  readonly edge: Uint8Array;   // 1 if a transition falls in [colStart-1, colEnd)
  readonly packed: Uint8Array; // bit0=high, bit1=low, bit2=edge, bit3=gap
}
```

`GAP_BIT` (bit3 of `packed`, value 8) is set on every column that overlaps a `noteGap`
span. The renderer draws NO_DATA there and ignores the other bits; `edges()` never
reports a transition inside a gap - unknown is not idle.

Two properties the renderer must not undo. The `-1` in the edge span makes a transition
landing exactly on a column boundary belong to the column it enters, so an edge can never
fall in the gap between two columns and vanish. And `low != high` implies `edge`, but not
the reverse: a column that is entirely 0 but was preceded by a 1 has a real falling edge at
its left border and reports `edge=1, low=0, high=0`. Render from `edge`, not from
`low != high`, or narrow pulses disappear at zoom-out.

`packed` is laid out for direct upload as a WebGL2 R8UI texture.

### `src/render`

Consumes `SampleStore.query` only. Owns the canvas, the transform (samples <-> pixels), and
nothing else. Exposes `setViewport(startSample, endSample)` and `render()`.

### `src/ui`

Owns layout, channel enable/rename/reorder, timebase readout, cursors and measurements,
trigger settings, capture controls. Calls into device/data/render; never touches WebUSB or
WebGL directly.

### `src/decode`

Runs in a Web Worker. Takes `edges()` output, produces annotation spans. Whether that is
libsigrokdecode compiled with emscripten, or Pyodide running the stock `.py` decoders
against a JS-side `sigrokdecode` shim, is the decode builder's call - **measure both before
choosing, and report the numbers.** libsigrokdecode is not checked out on this machine;
clone it from `git://sigrok.org/libsigrokdecode` if needed.

### `bench/`

Three numbers, measured on this machine, reported with the method used:

1. Sustained pan/zoom framerate on a 100M-sample 16-channel capture.
2. Seconds from opening a capture file to an interactive waveform.
3. Decoder count, and annotations per second on a fixed capture.

Each must be produced by a script that can be re-run, not by eyeballing devtools.

## Shipping it as a static site

There is no server-side anything. `npm run build` emits a self-contained `dist/` that any
static host serves - GitHub Pages, Netlify, S3, `npx serve`, `python3 -m http.server`. The
"Python" in this project is Pyodide, CPython compiled to WASM running **in the browser**
for the sigrok decoders; it is vendored into `public/pyodide/` and nothing executes Python
server-side.

Two things the build has to get right, both of which were broken:

- **Every run-time asset must be in `dist/`.** `public/pyodide/` and `public/decoders/`
  are gitignored and staged by `npm run vendor`; `reference/data/bin{,120}` live outside
  `public/` and are copied by the `logicweb:reference-captures` plugin in
  `vite.config.ts`. That plugin also *checks* all four at `buildStart` and fails the build
  if any are missing, because the failure mode otherwise is a bundle that looks fine and
  404s at run time - which is exactly how the Reference buttons shipped broken.
- **Sub-directory hosting needs `--base`.** Four run-time paths are built from
  `import.meta.env.BASE_URL` (`/pyodide/`, `/decoders/decoders.zip` in the decode worker,
  and the two reference captures in `app.ts`). It defaults to `/`, so a domain root needs
  nothing; for `example.com/logicweb/` build with `vite build --base=/logicweb/`.
  [MEASURED] with the base set, the app loads, the reference capture opens and the decode
  worker reaches Pyodide; without it, served from a sub-directory, the page cannot even
  load its own bundle.

`base: './'` is deliberately **not** used: a relative base resolves against the decode
worker's own URL (`/assets/`) rather than the document, pointing Pyodide at
`/assets/pyodide/`.

Two limits worth knowing before choosing a host:

- **`file://` does not work and cannot be made to.** [MEASURED] Chrome blocks ES module
  scripts from `origin 'null'` even with correct relative paths, and the same applies to
  the decode worker and Pyodide's `.wasm` fetches. (`file://` *is* a secure context and
  does expose `navigator.usb` - that part is not the obstacle.)
- **No COOP/COEP means no `SharedArrayBuffer`**, so decode cancellation kills and respawns
  the worker instead of interrupting it, costing a Pyodide reload on the next decode
  (~870 ms against 13-46 ms warm). That is already true in dev and is not a regression
  from deploying - see `src/decode/NOTES.md`, where this was recorded backwards.
  WebUSB needs `https` or `localhost` either way.

## Rules for every builder

- Check the reply of every device command before trusting what follows.
- Fail loudly and early. No silent catch blocks.
- Report what you measured, including misses. A tested wrong hypothesis is progress.
