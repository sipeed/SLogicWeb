# src/ui - the application shell

Owner: ui builder. Owns layout, the channel list, the time axis, cursors and measurement,
capture controls, analyzer attachment, and the app entry point. Calls into
`src/device`, `src/data`, `src/render` and `src/decode` through their published
interfaces only; never touches WebUSB or WebGL directly.

Written as the work happened, not at the end.

## Run it

```
npm run dev                    # http://127.0.0.1:5173/
node src/ui/tools/run-ui.mjs all      # the whole evidence run, headed Brave, real device
python3 src/ui/tools/measure-chrome.py --selftest    # the measuring tool's own controls
```

`run-ui.mjs` writes screenshots and `report.json` to `/tmp/logicweb-ui/`. It deletes
nothing - not its output, not the throwaway Brave profile, whose path it prints.

---

## 1. Everything about appearance is measured, not invented

Tool: `src/ui/tools/measure-chrome.py`. It reports panel boundaries, band heights, border
colours and row pitch for any PNG, converting through the embedded ICC profile first - the
Screenshots are in the display's wide gamut, and skipping that makes 7 of the 8
channel colours read wrong while the neutrals read right, which is the hardest kind of
error to notice.

**The tool carries controls and they are run every time.** `--selftest` builds a synthetic
PNG with known band boundaries and requires exact recovery, *and* builds a second one with
one band moved 20 px and requires the tool to report a difference. The first check alone
would pass for a tool that printed a constant.

```
$ python3 src/ui/tools/measure-chrome.py --selftest
control 1 PASS: synthetic bands recovered exactly
control 2 PASS: 20 px shift detected (120:2#57575F -> 140:2#57575F)
```

Everything below is **device px at dpr 2** from the 3200x2000 screenshots.

### Text placement in the label column, measured at y=240

- 5 CSS px of the channel colour at the far left (device x 0..9).
- the `D0` tag **in the channel colour**, device x 37..59.
- the channel name in `#E0E0E0` from device x 106.
- below it, one line per attached analyzer: a filled square in the analyzer's colour then
  its name in small grey text, exactly as `05-analyzer-annotations.png` shows
  `I2C - SDA` under `D0`.

### Time axis

- Major label ink at device y 136..152, minor at 159..176. 11 px bold, left aligned
  `[SOURCE]`, which the measurement agrees with.
- Minor tick marks 2 device px wide in the **bottom 7 device px** of the axis; `[SOURCE]`
  says "a short line in the bottom 3 px" (3.5 CSS px, so both are right).
- Major ticks run from **half the axis height** downward `[SOURCE]`, measured from
  device y 156 of a 58 px axis.
- Minor spacing measured 92.6 device px = 46.3 CSS px, i.e. the smallest power of ten at
  least 45 CSS px apart `[SOURCE]`, at the boundary of the rule. Majors at 0/10/20/30 ms
  with 1 ms minors: major = 10x minor, confirmed.

### Gridlines, and a measurement that contradicted intuition

Vertical, dropped from every minor tick through the whole stack, 1 CSS px wide, dashed
**3 CSS px on / 3 off**.

The gridline at a **major** tick is **dimmer** than at a minor one - `#262629` against
`#39393D`. Checked on all four majors of `01-idle-empty-session.png` (device x 210, 1136,
2062, 2990) against their neighbouring minors. Intuition said majors would be brighter.
The pixels said otherwise and the pixels win.

## 2. The annotation lane, and the thing that would have lost the A/B

`[MEASURED]` A row that displays annotations is exactly **40 device px (20 CSS px) taller**
than a plain row, in every screenshot that has one:

| screenshot | plain row | annotated row |
|---|---|---|
| `02-capture-in-progress` | 96 | 136 |
| `05-analyzer-annotations` | 96 | 136 |
| `04-zoomed-in-edges` | 98 | 138 |

20 CSS px is `[SOURCE]` the spec's "bubble rows are 16 px tall for low-level analyzers with
4 px top padding". Measured and source agree exactly. The bubble in `05` row 0 occupies
device y 196..227 = rowTop+8 to rowTop+40: 8 device px (4 CSS) of padding then 32 device
px (16 CSS) of bubble.

**The lane is inserted ABOVE the trace band and the band keeps its plain height.** This is
the part that is easy to get wrong, and `src/render`'s layout does the opposite - it
derives the band from the row height, so a taller row stretches the trace.

Idle-line offsets from the row top, measured on `05-analyzer-annotations.png` by scanning
each row band for the dense horizontal run:

| row | height | line offset | reading |
|---|---|---|---|
| D1 (plain) | 96 | +74 | band 92, gutter 16, line 2: low line = 92-16-2 |
| D6 (plain) | 96 | +74 | same |
| D2 (annotated) | 136 | **+56** | 40 + 16: the **high** line of a 92 px band pushed down by the lane |
| D0 (annotated) | 136 | **+114** | 40 + 74: the **low** line of the same |
| D4 (annotated) | 136 | **+114** | same |

If the band were stretched to the full 132 px the two lines would be 98 px apart. They are
58 apart, the same as in a plain row. So a lane is prepended and the band left alone.

Passing tall row heights straight to `WaveformRenderer` gives yHi at +16 and yLo at +114:
the low line lands right and the high line is 40 px too high. That would look plausible in
isolation and be wrong against the bar in exactly the rows a critic looks at hardest.

### How this is handled without editing src/render

The lane is given to the renderer as **its own row**, 20 CSS px tall, drawing the same
channel; the overlay then paints an opaque `#1B1B1C` rectangle over the whole lane before
drawing bubbles into it. Whatever the renderer drew there is hidden, separator included,
and the *real* channel row underneath is a plain base-height row - so its band, gutter and
both idle lines are what a plain row gets, by construction.

Verified on our own output: in `/tmp/logicweb-ui/05-annotations.png` the D0 lane occupies
device y 122..161 and the row's band runs 162..253, giving a 92 device px band identical
to every other row's.

Cost: one extra `store.query` per annotated channel per frame, ~30-60 us.

### Which forces a second canvas

`src/render`'s `MAX_ROWS` is **16** - a shader uniform array size the UI cannot raise - and
16 channels plus one annotation lane is 17 rows.

`WaveformStack` therefore owns **one `WaveformRenderer` per 16 rows**, on canvases stacked
vertically with no gap, all driven from one viewport. Two things make the seam exact:
every row height is a whole number of CSS px and each canvas's CSS height is the exact sum
of its rows', so `round((edge-offset)*dpr) + round(offset*dpr) === round(edge*dpr)`; and
the viewport is applied to renderer 0, read back after its own clamp, then pushed to the
rest.

Measured, with 17 rows across two canvases (`05-annotations.png`): row separators at
device y 254, 350, 446, ... 1694 in **both** the label column and the plot, pitch a uniform
96 device px across the canvas boundary, no discontinuity. The seam is not merely
approximately aligned; it is invisible.

**A live capture never splits.** Annotations are cleared when a capture starts, so during
streaming there are no lanes and the row count is the channel count, at most 16. That
matters because in follow-the-live-edge mode each renderer snapshots `store.length` for
itself, and two canvases a frame apart would put a horizontal step across the screen at the
live edge.

## 3. Gridlines are drawn with `mix-blend-mode: lighten`

The waveform canvas is opaque (`alpha: false`, cleared to the background), so gridlines
cannot be painted underneath it. Painting them on top at full opacity would let a gridline
cut a notch through a trace, which we do not do: `[MEASURED]` where a gridline
crosses a row separator the separator's `#57575F` survives, and over background the
gridline's `#39393D` survives. That is a per-channel maximum, so the grid gets its own
canvas with `mix-blend-mode: lighten` and the compositor reproduces the observed order
exactly rather than approximating it.

Confirmed on our own screenshots: gridlines read `#39393D` over background and `#262629`
at majors - the exact measured colours - and row separators read `#57575E` where the two
cross.

## 4. Layout ownership

```
index.html               app entry point (project root, as ARCHITECTURE assigns it)
src/ui/main.ts           bootstrap; a failure to construct paints the stack trace
src/ui/app.ts            state, wiring, the frame loop, the debug surface
src/ui/metrics.ts        every measured constant, each tagged MEASURED / SOURCE / CHOICE
src/ui/style.css         the chrome
src/ui/format.ts         time and frequency formats
src/ui/timeAxis.ts       tick selection and the axis canvas
src/ui/waveformStack.ts  the multi-canvas WaveformRenderer stack and the row model
src/ui/overlay.ts        grid, level markers, cursors, hover measurement, bubbles
src/ui/annotationLayout.ts  bubble text selection, multi-bubble merging, clamping
src/ui/channelList.ts    enable / rename / reorder / analyzer chips
src/ui/capturePanel.ts   device, samplerate, channels, threshold, mode, start/stop
src/ui/analyzerPanel.ts  attach a decoder to channels
src/ui/captureIO.ts      load .sr sessions, save/load .lwcap
src/ui/storeRef.ts       a SampleStore delegate whose inner store can be swapped
src/ui/state.ts          the session model
src/ui/tools/            the measuring tool and the browser driver
```

`storeRef.ts` exists because `WaveformRenderer` takes its store at construction and a new
capture means a new `PlanarSampleStore`; rebuilding the renderer per capture would leak a
WebGL context each time and Chromium caps a page at roughly 16.

## 5. What works end to end

The following was produced in headed Brave with the SLogic16 U3 attached. The browser
harness that drove it has been removed along with the capture files it loaded, so these
rows are a record, not something currently re-runnable.

| | result |
|---|---|
| **Zoom / pan / fit** | zoom ladder 5.038 s -> 1 ms -> 100 us, all shots crisp |
| **Cursors + measurement** | A/B cursors with chips, status shows A, B, \|B-A\| 27.00 us, 1/\|B-A\| 37.0 kHz; hover readout Duty / Freq / Width / width^-1 |
| **Channel enable** | 16 rows -> 14 after disabling D9 and D10, remaining rows auto-refit |
| **Channel rename** | D3 renamed to "SPI CS", persists through relayout |
| **Channel reorder** | drag D0 to position 5: order becomes 1,2,3,4,0,5,... |
| **Attach a decoder (file capture)** | `i2c` on D0/D1 -> **1,826 annotations, 33-38 ms decode**, one lane, 17 rows across 2 canvases |
| **Live capture from the device** | 16 ch @ 16 MSa/s, 0.30 s timer -> **4,800,000 samples in 460-470 ms**, live edge followed during streaming (2,303,998 samples at the mid-capture snapshot) |
| **Decode real captured signal** | `i2c` on D13/D15 -> **2,178-2,244 annotations, 22-44 ms**, bubble reads **`Address write: 50`** against a generator commanded `i2c 100k 0x50 00 ff` - a known-answer match |
| **Save and reload** | `.lwcap` round trip: 17,787 bytes, 4,356 edges, **every edge on every channel identical**, 0 problems |
| **Production build** | `npm run build` clean: 257 kB JS (65 kB gzip) + 186 kB worker + 6 kB CSS |
| **Page errors** | `report.json` `pageErrors: []` - no uncaught exception in any run |

The stimulus generator is left in a stated known state; the last thing the run does is
`stop` then `status`, and the reply is recorded:

```
[stim] status -> ok mode=stopped samples=0 txstall=no dma=idle proto=idle
```

### The WebUSB click

The permission prompt is a native chooser and cannot be clicked from JavaScript. The
driver uses CDP's `DeviceAccess` domain, which is what a human's click does, issued over
the debugger. **A human running the app by hand still clicks once**; the grant then
persists for that origin and profile.

Two failures on the way to that, both recorded because both produced a confident wrong
answer first:

1. `Runtime.evaluate` without `userGesture: true` makes `requestDevice` throw
   `SecurityError`. Obvious in hindsight, invisible in the failure message.
2. Waiting for `DeviceAccess.deviceRequestPrompted` **times out**: on this Brave build
   enabling the domain makes `requestDevice` resolve directly without emitting the event.
   The first version reported "no device" for a device that had in fact been granted. The
   driver now arms the prompt handler but polls the app's own state instead of waiting on
   an event that may never come.

A third, in the stimulus path: `fs.openSync(port, 'r+')` on a CDC device gives a
**blocking** fd, and a `readSync` with nothing pending never returns - the run wedged
silently after the first command. `O_NONBLOCK`, the way the generator's own
`tools/console.py` does it.

## 6. Open time, and why imports stay transitions

Open time used to grow with capture size, and that was architectural: imports were
expanded into a full `PlanarSampleStore` at O(samples), so a 120 s capture cost hundreds
of milliseconds of store building before anything could be drawn. Imports now stay
transitions end to end in `src/data/rleStore.ts`, which loads in O(edges) and is flat
with sample count. On the captures measured at the time this landed, open time went from
167 ms to ~11 ms at 5 s and from 528 ms to ~30 ms at 120 s.

Those figures were taken against capture files that are no longer in the repo, so they
are a record rather than a reproducible measurement. What remains testable is the
equivalence, and that is not asserted but tested: `src/data/selftest.ts` derives an RLE
store from a planar store and holds it to the same brute-force zoom ladder as the planar
store - edges byte-identical on all 16 channels, `query()` output byte-identical across
128 channel-views per capture.

A side effect worth keeping: query at the operating point is faster on imports - 0.8 ms
for a 3200-column 16-channel frame on a 120 s capture where the planar store measures
3.51 ms, and 2.1 ms on a synthetic dense worst case of 2M edges per channel. Measured in
node; the browser frame-loop numbers for the edge store are not separately benchmarked.

Two other honest gaps:

- **Cold decode.** `src/decode` is ~850 ms cold and 0.9-4.9 ms warm; a native tool is 119-682 ms
  every time. The shell calls `warmup()` on construction so the cold start is paid before
  a user asks for anything, but the first ~1 s after page load is slower than the bar.
- **No analog channels, no data table, no marker pairs.** (A parallel bus can now be drawn as an analog row - section 21 - but there are still no native analog channels.) Software triggering is now
  available beside each channel label. It is host-side (the SLogic firmware has no
  trigger register): a single bounded rolling pre-trigger buffer supports per-channel
  level/rising/falling/edge conditions combined with logical AND, and reports Waiting,
  Triggered or No trigger. Each channel has one of five glyph modes (falling Z, rising
  mirrored-Z, high, low, or X/don't-care). The right panel owns the global pre-trigger
  buffer and Enable Mask; turning the mask off preserves all glyph modes. After a match,
  a vertical `T` marker identifies the shared AND-match sample; it is time zero and the
  retained pre-trigger region is negative time.
  Timer captures follow the same convention: their duration starts only after the shared
  trigger matches; while waiting, the ring continues to roll indefinitely until Stop.

## 7. Limits surfaced in the UI rather than hit

- **2^31 samples**, which `src/data`'s `append` throws past, and which is **10.7 s at
  200 MSa/s**. The capture panel prints the ceiling in samples *and* as a duration for the
  selected rate ("Ceiling 2,147,483,648 samples = 134.2 s at 16 MS/s. A free run stops
  itself there."), and a free-running capture truncates its last chunk and stops itself
  instead of letting `append` throw mid-stream.
- **`EDGE_BUDGET` = 48,000,000 edges** across the channels a stack reads
  (`src/decode/limits.ts`; past ~80 M Pyodide corrupts rather than failing cleanly). The
  analyzer path counts edges with `edgeCount()` - which does not materialise them - before
  requesting a decode, and refuses with the count and a suggestion.
- **`MAX_SAMPLE` = 2^31 - 1** for decode spans, checked separately from the store limit
  because a decode can be asked for a sub-range.
## 9. What is stubbed, and what is not verified

- **Hardware trigger configuration is not implemented.** The available trigger is the
  bounded host-side matcher described in section 6.
- **`.sr` (sigrok) sessions load, logic-only.** `src/ui/srLoad.ts` reads the zip
  (stored + deflated members, v1 and v2 member naming) and builds an edge store from the
  per-probe transition lists, so `reference/hwcaptures/{i2c,spi,uart}.sr` open straight
  into the shell. Analog .sr data is refused with that reason; the format carries no
  gaps. Pinned by `src/ui/tools/sr-selftest.ts` (12/12: the three real files, .lwcap
  round trips, synthetic zips, corrupt inputs, and an independent 8N1 framer recovering
  the generator's "Hello" from uart.sr's D9).
- **Decoder stacking is not exposed.** The analyzer panel lists only sample-driven
  decoders (`inputs == ['logic']`); `eeprom24xx` on top of `i2c` works in `src/decode` and
  has no UI here. Stated in the panel rather than hidden.
- **Only `i2c` has been driven end to end through the UI.** `uart` and `spi` decode
  correctly in `src/decode`'s own suite against the same hardware, but the shell has not
  been screenshotted with them attached.
- **Analyzer bubble colours** are the three chosen in
  `05-analyzer-annotations.png` (`#D2B56F` I2C, `#F69998` Async Serial, `#ABA48B` SPI) then
  the spec's stated default `#95A0B4`, then two of ours. Which analyzer gets which colour is
  ours; there is no external rule being matched.
- **The multi-bubble merge threshold is ours.** `[SOURCE]` says frames merge "when frames
  are narrower than legibility allows" and that the badge saturates at `99+`; it does not
  give the width. We merge while a group's *average* width is below 14 CSS px. The
  saturation, the badge geometry, the viewport clamping and the 3 px overflow triangle are
  all `[SOURCE]` and implemented as specified - but a dense multi-bubble has not been
  screenshotted, because neither test capture produced one.
- **Physical wheel vs trackpad is a guess.** `[SOURCE]` gives the zoom exponent exactly
  (one notch is `sqrt(2)`, Shift is 10x finer) and that is implemented from
  `src/render`'s `wheelSpanFactor`; how to tell the two apart reliably is unsettled and a
  browser does not report it. We use "large, quantised `deltaY`, no `deltaX`".
- **Row auto-fit is inferred.** Row height is persisted per capture and varies
  across the five screenshots (48, 49, 53 CSS px), and in each one the stack fills the
  available height to within a few px. We derive the height the same way. That the *rule*
  is auto-fit rather than a stored value that happens to fit is an inference from five
  samples.
- **The hover measurement window is bounded and could miss.** `edges()` is a linear scan,
  so the pulse under the pointer is found by widening a window up to 8 times rather than
  scanning the capture. On a channel with one transition in 120 s the readout says
  "no transition in view" instead of searching 240 MB.
- **Nothing here has been reviewed by anyone but me.** The band
  table in section 1 is a property-by-property match produced by a tool that can fail; it
  is not the same thing as a critic looking at two pictures.

## 10. Tooling safety

`run-ui.mjs` creates a throwaway Brave profile in the OS temp directory and **does not
delete it**; the path is printed at the end of each run. Nothing in `src/ui` recursively
removes any directory, including ones it created itself.

## 11. i18n: catalogs, the core, and what is deliberately not translated

The shell is being taught more than English. The mechanism is house-built (`src/ui/i18n.ts`
+ `src/ui/locales/<locale>.ts`), not a dependency: four locales do not make the case
for i18next in a tree whose only runtime dependency is pyodide.

- **The English catalog is the key contract.** `locales/en.ts` exports the catalog and
  `Messages = Record<keyof typeof en, string>`; every other locale declares
  `: Messages`, so a missing/extra/renamed key is a tsc error, not a runtime hole.
  Keys are flat and dotted so they map 1:1 onto `data-i18n` attributes in index.html.
- **Interpolation is `{var}` with a visible-failure contract**: an unknown variable
  stays literal in the output (swallowed would look identical to a correct translation
  until someone counts). Pinned by `src/ui/tools/i18n-selftest.ts`, run like the other
  ui suites:

  ```
  node_modules/.bin/esbuild src/ui/tools/i18n-selftest.ts --bundle --format=esm \
    --platform=node --outfile=/tmp/i18n-selftest.mjs && node /tmp/i18n-selftest.mjs
  ```

- **Default is English, deliberately not the browser's language** - the choice is only
  ever the user's explicit one, persisted in localStorage['logicweb.lang'] [CHOSEN];
  absent or unknown stored values mean 'en'. The stored locale is read by
  `initLocale()` at boot, never at module evaluation.
- **The non-English catalogs are code-split, not shipped in the entry chunk.** `en`
  stays statically imported as the fallback, but zh-CN/ru/fr sit behind literal
  `import()` specifiers in the `LOADERS` registry (`i18n.ts`) and reach the browser
  only when that language is selected - a menu pick or a persisted preference.
  `vite build` emits one chunk per locale at the **dist root** (`dist/zh-CN-*.js`,
  `ru-*.js`, `fr-*.js`), not under `assets/`: `inlineEntryForFileOpen` inlines the
  entry script into `index.html` in every build, so a relative dynamic-import
  specifier resolves against the document URL, and an `assets/`-placed chunk would
  be requested from `<origin-root>/<chunk>.js` and 404. [MEASURED] The split took
  the entry from 594.53 kB / gzip 149.72 kB (after the loader seam landed) to
  572.20 kB / gzip 143.46 kB, against a pre-task baseline of 593.53 kB / gzip
  149.32 kB; the zh-CN/ru/fr chunks measure 7.07/9.82/7.68 kB. The
  standard-build `chunkSizeWarningLimit` is `2048` KB [CHOSEN], replacing the
  historical `500` KB value; the portable build retains `20_000` KB for its inlined
  assets. `i18n-selftest.ts` pins both configuration branches without evaluating the
  asset-dependent portable config. The suite passed 29/29; temporarily restoring `500`
  made only the new threshold check fail (28/29), and restoring `2048` returned it to
  29/29 [MEASURED]. Loading the standard config through Vite's `loadConfigFromFile`
  also returned `2048` KB [MEASURED]. Known limitation: rollup renders the specifier as
  `../<chunk>.js`,
  which is correct at the origin root and for the live `--base=/` build, but hosting
  `dist/` below a sub-path breaks locale chunk loading (and a sub-path `--base`
  crashes the inline plugin independently - pre-existing). Sub-path hosting needs a
  coordinated fix (base-aware plugin, co-located entry/chunks, worker map
  placement), not yet scheduled.
- **`LOGICWEB_PORTABLE=1` folds every dynamic import back into the entry** via
  `inlineDynamicImports`, so the single-file `index.html` performs no sibling
  `file://` import. Laziness is lost there by design, and the setting is not
  locale-specific: any FUTURE dynamic import is silently folded too. Locale
  switching over `file://` was browser-verified (ru/fr/zh-CN/en all commit with zero
  external requests; `check:portable`'s request capture shows only the document and
  the Pyodide worker blob).
- **Switching locale is asynchronous; the render path is not.** `setLocale(locale)`
  resolves a `Promise<LocaleSwitchResult>` - `'committed'`, `'superseded'` (a newer
  pick won; a normal race outcome, not an error), or `'failed'` (the catalog could
  not load). A monotonic `requestToken` is bumped FIRST, so even picking the active
  locale cancels an in-flight switch and the last pick always wins with exactly one
  re-render; the check pass reproduced a settle-on-wrong-locale bug before this
  ordering landed. `current` never names a locale whose catalog is absent from
  `DICTS` (the load-before-commit invariant), and `t()` / `applyStaticI18n` keep
  reading `DICTS` synchronously with English as the constructed fallback.
  `initLocale()` preloads the persisted catalog before `new App()` so the first
  render paints in it; `main.ts` boots through an async IIFE because Vite's default
  target rejects top-level await. `App.debug.setLocale` returns that promise now, so
  scripts must `await logicweb.debug.setLocale('fr')`.
- **A failed catalog load is visible, not fatal.** The switch keeps the current
  locale, warns to the console, and leaves the persisted choice intact so a transient
  error retries next session; a menu pick surfaces it as `error.localeLoad` through
  the ordinary status-error path (the detail half renders the locale id, e.g.
  `...: fr`). A failure on a pick the user has already superseded stays silent.
- **One known limitation: a persisted non-English locale can flash English static
  chrome at boot.** Module scripts are deferred, so `data-i18n` markup can paint
  before `initLocale()` resolves the persisted chunk; there is no fix short of
  embedding the catalogs in the HTML.
- **The core is node-safe at module top level** (storage behind a typeof guard, no DOM
  touch outside functions) because the self-test bundles it for node.
- **Session state that used to be pre-formatted English is structured data now.**
  `captureLabel` (five shapes) and `statusError` are unions/records in state.ts,
  formatted by `formatCaptureLabel` / `formatStatusError` (format.ts) at render time -
  the only way a mid-session locale switch can retranslate them. `debug.snapshot()`
  still returns the formatted strings, so the script contract is unchanged. The
  console.error prefix in `fail()` is now the stable message KEY (`error.openCapture`
  and friends), greppable in every locale; the status bar still shows the translated
  prefix followed by the raw diagnostic detail.
- **Analyzer status notes are structured too** (`AnalyzerNote` in state.ts): pending /
  edges / stats / timeout / cancelled are translated at render time, while decoder
  diagnostics (`error.detail`, `stats.firstError`) pass through raw. The USB console's
  seed line is chrome in the then-current locale; the scrollback after it (echoed
  commands, device replies) is history and deliberately does not retranslate.
  Percent-notation option labels and glyphs (`×`, `···`, rail icons, `>` echo) are
  notation, not prose - they stay literal.
- **`triggerSummary` moved to `formatTriggerSummary` in format.ts.** app.ts is not
  node-importable, so the summary string could not be pinned by the self-test while it
  lived there; format.ts is the display-formatting home and the move is a pure key
  substitution, pinned with five exact cases. The channel list's tooltips, aria labels
  and picker names, and the hover readout labels (`Width:`/`Freq:`/`Duty:`/
  `no transition in view`), all render through t() now; `width⁻¹` and the `D<n>`/
  `A`/`B`/`|B-A|` notations stay symbolic.
- **The settings menu is a transient disclosure, not an ARIA menu.** Built on open,
  destroyed on close (`settingsMenu.ts`), right-anchored via the CSS `right` property
  (never measures its own width), its flyout a positioned CHILD of the menu so one
  `contains()` answers click-outside for both. Its three document/window listeners are
  open-scoped (events-and-lifecycle rule), it closes on resize and on locale change,
  and only one overlay may be open: opening it dismisses the channel trigger picker.
  The surface constants are shared with `.trigger-inline-picker` in one joint
  declaration so the measured values cannot drift; the picker's scaleX entrance stays
  picker-specific. Focus returns to the Settings button on Escape/pick, but an outside
  click keeps the focus the user chose.
- **Four catalogs ship**: en (source of truth), zh-CN, ru, fr. tsc proves completeness
  (`: Messages`), and the self-test re-proves it at runtime (catching an `as Messages`
  cheat) plus a salient-probe check so a wholesale-untranslated catalog cannot pass.
  It also drives the async path: per-locale loader object identity + key parity, an
  fr round-trip, pick-current cancellation, and a superseded-pick single-notification
  guard.
  Russian and French counts use the count-neutral "Noun: {n}" shape - plural rules are
  out of scope. Command syntax (`read 0x000c 4`), device mode names (USB MAX SPEED),
  and percent notation stay English in every catalog. End-to-end switching (menu pick,
  reload persistence, `<html lang>`, corrupt-storage fallback, byte-identical English
  restoration) was exercised with headless-Chrome CDP drives during development;
  those drives are throwaway scripts, not committed tooling. One known limit: the
  hover readout's lines are formatted when the hover is taken, so a scripted
  locale switch with an active hover keeps the old language until the next hover -
  unreachable through the UI itself, because moving the pointer to the toolbar fires
  pointerleave on the plot and clears the hover.
- **Not translated, on purpose**: SI/number formatting (format.ts), decoder names and
  descriptions (sigrok metadata), diagnostic error payloads after the chrome prefix,
  `sourceDescription` (it is baked into .lwcap files at save time - translating it
  would make saved files locale-dependent), canvas glyphs and the A/B/|B-A| status
  symbols, and the boot-failure message in main.ts.

## 12. Themes: the token layer, the dark theme, and the pre-paint apply

The settings menu is Language-only again: the Theme sub-option (`default` | `dark`)
was retired once `dark` became the default theme for every visitor - keeping a hidden
picker reachable would have been pointless, and keeping a stored light pick honored
would have stranded those users on a theme they can no longer change. `default` is
the measured Logic2-style palette this app shipped with; `dark` is a shadcn-style
dark theme. The theme is chrome-only CSS - canvases, capture state and layout metrics
never move. The machinery is deliberately NOT torn out: `theme.ts`, the label keys,
the catalog entries and `debug.setTheme` all stay live, so re-showing the row is a
one-item revert in `settingsItems()`.

- **`src/ui/theme.ts` is `i18n.ts` shrunk to fit a synchronous problem.** Same module
  shape (module state, guarded `localStorage['logicweb.theme']`, subscribers, node-safe
  top level), but `setTheme` is sync: there is no catalog to fetch, so no Promise, no
  request race, no 'superseded'. `pickTheme` resolves absent or garbage storage - AND
  a stored legacy `default` pick - to the dark fallback (`DEFAULT_THEME`): the old
  light pick predates dark-by-default and the retired picker, so it migrates instead
  of stranding its owner. Only `dark` is a live stored id today. The module owns the
  DOM side effect (`document.documentElement.dataset.theme`), the same ownership
  split as `setLocale` owning `<html lang>`. Scriptable through
  `App.debug.setTheme/getTheme`; `snapshot().theme` carries it.
- **Pre-paint apply is a small inline script in `index.html`** (module scripts are
  deferred, so waiting for `boot()` would flash the light chrome). It mirrors
  `pickTheme()`: a stored live id wins; absent, garbage, migrated-`default`, and
  throwing-storage paths all set `data-theme="dark"` before the stylesheet loads.
  The duplication of the storage key is drift-proof: `theme-selftest.ts` builds its
  needle from `THEME_STORAGE_KEY` as the exact quoted `getItem('<key>')` literal - a
  substring match would not catch a drift to a longer key, which is why the needle is
  quoted. The portable build's `inlineEntryForFileOpen` only rewrites module scripts
  and stylesheet links, so the bare inline script passes through untouched (verified
  in dist).
- **Three CSS layers, one stylesheet.** Layer A is the legacy `:root`, untouched, so
  `default` is pixel-identical by construction (gated on a 0-byte-diff headless-Chrome
  screenshot against the pre-theme baseline, not on hope). Layer B is a shadcn semantic
  token block that only *aliases* the legacy variables (`--card: var(--bg20)`, ...), so
  adopting a token cannot change the default render either. Layer C is one
  `html[data-theme="dark"]` block with the shadcn dark palette in oklch plus a legacy
  remap, so rules not yet migrated to semantic tokens still follow the theme.
- **The `--accent` collision is settled by never introducing shadcn's.** logicweb's
  `--accent` is the brand violet; shadcn's `--accent` is a hover surface. Brand maps to
  `--primary`, hover surfaces to `--muted`/`--secondary`, `--accent` keeps its legacy
  meaning everywhere.
- **`--bg10` stays `#1B1B1C` under dark - the canvas seam wins over palette purity.**
  The axis canvas *paints* `COLORS.bg10` from metrics.ts, and the labels column, labels
  spacer and plot CSS background must meet that pixel seamlessly (the measured seam in
  this file's §1). Mapping `--bg10` to the near-black `--background` would have stepped
  the label column against every waveform row. The dark shell differentiation comes from
  explicit semantic overrides on the toolbar, side panel, rail and status bar instead,
  and the plot reads as an inset well by tonal contrast alone. A `#plot` frame was
  evaluated and rejected: a `border-top` doubles the axis hairline and (border-box)
  shifts the waveform canvases 1 px out of row alignment, an inset `box-shadow` paints
  *under* the child canvases (invisible), and a `border-radius` reveals the body's
  identical background (also invisible).
- **The metric freeze is enforced, not promised.** `theme-selftest.ts` scans the sheet
  (comments stripped - the token-layer header itself mentions the dark selector, and a
  naive scan would attribute the next block's declarations to it) and fails if any
  `html[data-theme="dark"]` block redefines `--toolbar-h/--axis-h/--status-h/--labels-w/
  --rail-w/--strip-w/--panel-w`, or if any `[data-theme="default"]` rule exists.
- **Specificity traps that were designed around**: `.ch-trigger.active.triggered` (green)
  and `.not-found` (red) sit one specificity step below a naive dark `.active` override,
  so the dark rule excludes them with `:not()`; `#toolbar button` out-specifies
  `.primary`, so the dark button restyle excludes `.primary`/`.danger` the same way. The
  waiting pulse's peak colour moved into `--accent-hi` (default `#a98ff0`, dark an oklch
  violet) so `@keyframes trigger-waiting` retunes per theme without an override block -
  custom properties in keyframes resolve against the animated element.
- **Switching themes is chrome-only by construction and by measurement.** `App`'s
  `onThemeChange` handler closes the transient settings menu (new `'theme'` close
  reason, no focus hand-off - same class as `'retranslate'`) and nothing else: no
  re-render, no relayout, no canvas repaint. Measured with a loaded 200k-sample
  capture: `debug.snapshot()` deep-equal across a switch (minus the `theme` field), and
  a full-viewport screenshot byte-identical across a default->dark->default round-trip.
  A running capture differs from a loaded one only by more canvas paints of the same
  frozen palette, which the theme never touches.
- **Pressed feedback is one veil, not a family of tokens.** Every `<button>` -
  momentary or toggle - darkens while held via `button:active { box-shadow: inset
  0 0 0 999px rgb(0 0 0 / 25%) }`. An inset veil was chosen over per-family pressed
  background tokens because it darkens WHATEVER is showing - base, hover, `.on`,
  `.primary`/`.danger`, and the inline `channelColor` of an enabled `.chip`, which no
  token swap could reach - and because `box-shadow` is additive, it composes over
  `:hover` with no cascade-order fragility and no new tokens in either theme. No
  button class sets its own `box-shadow` (only overlay containers do), the dark focus
  ring is `outline`-based, and a disabled native button never matches `:active`, so
  the veil clobbers nothing and needs no disabled guard. The 25% figure is [CHOSEN],
  tuned for readability on `--bg20`/`--secondary` without washing out channel chips.
- **The dark segmented active state inverts; a tonal shift there is provably
  invisible.** The first dark pass styled `.seg.on` after the ToggleGroup idiom (a
  `--secondary` surface), but in the dark token set `--secondary` equals BOTH the base
  `.seg` surface and `--muted` (all `oklch(0.269 0 0)`), so free-run vs timed was
  indistinguishable - in the theme that is now the default. `.seg.on` under dark now
  mirrors the default theme's inversion instead: `--foreground` surface,
  `--background` text, `--foreground` border, at 0-3-1 specificity over the 0-2-1 base
  rule. The remaining toggle families were audited rather than assumed: `.chip.on`
  (inline channel colour), `.ch-trigger.active` (violet surface both themes),
  `.trigger-inline-option.selected` (`--accent`/`--primary`), and `.rail-btn.on`
  (`--bg20` on the `--panel` rail; `--secondary` on the `--background` rail) already
  read as active in both themes and were left untouched.

## 13. The waveform table as cards: channel-card structure, consistent decoder height, themed scrollbars

The waveform table (label column + plot rows) was the last square-edged surface:
flat cells with a 2 px separator each, and stock scrollbars. It now renders after
the shadcn Item idiom under the dark theme - one rounded card per channel - while
the plot, the renderer and the row geometry are byte-for-byte untouched. Three
ideas carry the design; all were verified against the screenshot matrix (empty,
uart.sr, uart.sr + decoder, narrow-overflow; default x dark), not by eyeball alone.

- **The wrappers are layout-invisible until a theme opts in.** `.ch-card` (around
  strip+body) and `.ch-analyzers` (around the decoder chips) are `display: contents`
  in the base sheet, so the default theme renders exactly as before - pixel identity
  is structural, and the zero-pixel screenshot diff is the proof, not the hope.
  Under dark, `.ch-card` becomes the real card: `--card` surface, `--border`
  hairline, `calc(var(--radius) - 2px)` radius, `overflow: hidden` to clip the
  colour strip to the corner. The cell box keeps its measured pitch - alignment
  with the waveform rows is still by construction, only the card insets ([CHOSEN]
  3 px vertical, 4/2 px horizontal).
- **Cards are one consistent height, decoder or not.** A decoded channel's cell is
  taller by its lane strips (the stack needs those rows), which used to make its
  label visibly taller and shifted the tag/name row on attach/detach. The cell now
  reports the lane part as `ChannelCell.laneCss`, set inline as the
  `--ch-lane-offset` custom property, and the dark card reads it as `margin-top`:
  every card is exactly `band - insets` tall and hugs its trace band, with the lane
  strip transparent above it - visually part of the plot's annotation lane. A
  custom property rather than inline padding because a property is inert until a
  rule reads it: TS stays theme-blind and the default theme cannot move. Measured:
  all 16 cards 48 px on a 54 px pitch; the decoded card's top equals cell top +
  lane + inset exactly. Inside the card, `.ch-analyzers` reserves a fixed one-line
  strip ([MEASURED] 14 px = the 12 px chip line + its 2 px gap) in EVERY card, so
  the head row is collinear across channels and never shifts. Edge cases accepted,
  no regression either way: a second chip on one card wraps and can clip like
  today's overflow does, and at the 26 px minimum row height the strip clips before
  the head.
- **State moves with the card, not the pitch box.** Hover (dark-only affordance)
  steps `--card` -> `--muted` + `--border` -> `--input` - verified by token VALUE
  (oklch 0.205 -> 0.269), per the rule-10 lesson. The drop-target outline was
  redirected from the cell (whose box now has transparent insets) to the card.
- **Scrollbars: quiet by token, not by hiding.** `#scroll-area` and `#side-panel`
  under dark: transparent track, slim 8 px rounded thumb in `--border-high`
  brightening to `--muted-foreground` on hover; Firefox takes
  `scrollbar-width: thin` + `scrollbar-color`, WebKit/Blink the pseudo-elements.
  [CHOSEN] 8 px is about half the native width but stays grabbable; the thumb at
  15% white sits just above the shell's contrast floor. `.usb-console-output` keeps
  its native bar this round - an embedded console surface, not chrome.

Rejected at the mockup gate (four options were built and served for review):
**B** (one rounded frame around the whole table + hairline separators + full-row
hover wash) - needs a new scroll-container wrapper with sticky-axis interplay for
moderate gain; **C** (per-row islands with real gaps across label and plot) - the
only render-layer option (per-row rounded cards in the shader), highest risk;
**D** (separate rounded frames for labels and plot with a gutter) - loosens the
strip/trace adjacency the label column exists for.

## 14. Adaptive channel pitch with a readable minimum

**Prediction, recorded before the layout measurements.** The current card geometry needs
46 CSS px of pitch: 6 px of cell insets, 2 px of card border, 4 px of body padding, an
18 px head, a 2 px gap and the reserved 14 px decoder strip. A [CHOSEN] 48 px minimum
should therefore keep both the head and the reserved strip inside the card with 2 px of
slack. The existing auto-fit rule and 72 px maximum stay in place. At 32 channels the
minimum-sized stack should be 1,536 px plus annotation lanes, so a short viewport must
scroll instead of compressing the cards. The browser check must also prove that the
label cells and waveform rows still share the same pitch after a resize.

**Result: HELD.** [MEASURED] in headless Chrome through the normal capture-loading path.
At 1000x500 with 32 channels, every label cell and channel row was 48 px, the stack was
1,536 px split across two 768 px canvases, and the scroll area was 1,566 px tall for a
429 px viewport (the sticky axis accounts for the 30 px difference). Every card kept its
head and reserved decoder strip inside its body; no horizontal overflow or uncaught page
error appeared. Resizing to 1280x1000 retained that geometry and overflow. With eight enabled
channels the same browser then grew the rows to the unchanged 72 px maximum (576 px
stack, no overflow); shrinking to 1000x500 recomputed a 49 px pitch and a 392 px stack,
again without overflow. Overlay canvases matched the plot height in every pass.

The sizing arithmetic now lives in the pure UI-owned `computeChannelRowHeight` rather
than a second test-only row model. Nine exact node checks cover fit, integer flooring,
both clamps, annotation lanes, the 1,536 px 32-channel fit boundary and App's delegation
to that policy. The theme suite adds the exact 48 px card-minimum guard; mutating its
bundled input back to 26 px makes that check fail, so the guard has a working control.

**Not measured in this pass.** The browser capture had no decoder attached, so annotation
lane arithmetic is covered by the exact node checks and the pre-existing lane model, not
by a new 32-channel decoded browser scene. Arbitrary numbers of decoder chips still use
the existing one-line reservation and can clip as documented in section 13.

## 15. Channel name and trigger settings in a native dialog

**Prediction, recorded before the dialog browser checks.** Replacing the 30x18 CSS px
trigger button with a 24x18 gear and rendering the name as an 18 px-line read-only span
should preserve the 18 px channel head and the 46 px card-content requirement from
section 14. The 48 px minimum pitch therefore stays valid. Moving name and trigger
editing into one native `<dialog>` should also remove the picker's two document-level
listeners without changing the five existing trigger mappings.

**Implementation, before measurement.** The row checkbox, editable name input, trigger
button and inline picker are gone. Each row now has a D-tag, read-only name and gear
button. `ChannelSettingsDialog` follows the shadcn Dialog header / field-group / footer
anatomy with `showModal()`, a visible labelled title, a native text field, five native
radio choices and Cancel/Save actions. Save trims the name and emits one callback;
Cancel, Escape and backdrop dismissal emit nothing. Trigger choices alone are disabled
while running or stopping, so name metadata remains editable. App applies the callback
through the existing clamp/condition pipeline and resets a stale trigger origin only
when trigger settings actually change. The dialog is persistent, has no document-level
listeners, closes before row re-renders, and refreshes every translated string on open.
Earlier inline-trigger descriptions in sections 6 and 11-13 are historical; this
section describes the current interaction.

**Result: HELD.** [MEASURED] in headless Chrome at 1280x800 and 500x700 through the
shipping DOM. All 26 browser checks passed: 16 rows had no inputs, their names were
read-only spans, and every 18 px gear was exactly centered in an 18 px head. The dialog
matched `:modal`, received initial name-input focus, exposed five radios, and returned
focus to the gear after Save, Cancel and Escape. Save trimmed names and preserved an
empty name; Cancel, Escape and a real backdrop click discarded drafts. All five modes
preserved their condition mapping, the other channel's AND condition, Enable Mask and
the 25% pre-trigger setting. Digital-chip disable/re-enable, reorder callbacks and all
four locale titles also passed. The narrow scene kept 48 px label/waveform rows,
centering and zero horizontal overflow, with no uncaught page error.

Running and stopping were injected separately as browser-state preconditions, then the
ordinary settings render path and actual dialog/save path were used. In both states the
trigger field set was disabled while the name input and gear stayed enabled; Save
changed the name but retained the stored mode. This proves the UI state guard, not a
hardware capture lifecycle.

The node suites also passed: 12/12 channel-layout checks (nine layout checks plus three
source-integrity guards for row structure, native-modal save and listener-free close
paths), 27/27 i18n checks with the new labels added to the translated-probe set, and
`tsc --noEmit`. No decoder was attached in this pass, so annotation-lane alignment is
covered by the existing layout checks rather than a new decoded browser scene.

## 16. Per-channel colors through the same settings dialog

**Prediction, recorded before the color browser checks.** Moving the default
`channelColor(index)` result into `ChannelState.color` should be behavior-neutral for
untouched channels. Passing one absolute-channel-index palette to every
`WaveformRenderer` through its existing `setTheme()` API should then make a dialog color
edit agree across the card, Digital chip, waveform and hover marker, including after
reorder and across 16-row canvas groups. No renderer implementation or capture-format
change should be necessary.

**Implementation, before measurement.** `defaultChannels()` initializes the required
color field from the unchanged eight-color cycle. The native color input joins name and
trigger in the existing atomic dialog payload. Row strips/tags and Digital chips now read
the channel object rather than recalculating by index; hover uses the same object with a
loud default fallback for an absent channel. `WaveformStack.setRows()` accepts the
index-aligned palette, applies it when constructing renderer groups, and refreshes
existing groups with `setTheme({ ...DARK_THEME, channelColors })`. Capture replacement
still creates default channel models, so colors are session-only and no file version
changes.

**Result: HELD.** [MEASURED] through the normal `i2c.sr` capture-loading path in
headless Chrome. The combined Pair-1 and color run passed 40/40 checks. A #12ab34 edit
reached the native color field, card strip/tag, enabled and disabled Digital chips,
real-pointer hover color and both renderer groups. Cancel discarded color with the other
draft fields; reopening restored the saved value. Reorder moved D0 and its color together.
One decoded I2C lane produced two visible canvases, each with the custom absolute-index
palette. Running and stopping separately left name/color enabled, locked trigger choices,
and propagated another color to both groups without changing the stored trigger. Capture
replacement restored D0 #FF4D4D and D1 #FF9E2C.

Seven independent PNG pixel checks also passed. In the default scene D0 contained 779
exact #FF4D4D pixels and D1 contained 773 #FF9E2C pixels. After Save, D0 contained 773
exact #12AB34 pixels and zero old-red pixels while D1 stayed orange. After reorder, the
first row was orange and the second row contained those 773 green pixels, proving the
waveform follows capture channel rather than row position.

The first color-harness run was not accepted as evidence: it contained three setup
mistakes (a previous locale still active, a detached chip read after re-render, and UART
decoding an idle channel). The harness was corrected to restore English, reacquire the
chip, and use the known I2C capture/channels; no production defect was found on the
successful rerun. As in section 15, running/stopping were injected state preconditions,
not a hardware capture lifecycle.

Node checks passed with 13/13 channel-layout results, 13/13 theme results (including the
exact 17-channel UI/renderer default-color cycle), 27/27 i18n results with the color
label in the translated-probe set, and `tsc --noEmit`.

## 17. Key/value channel settings fields

**Prediction, recorded before the KV browser checks.** Giving the name and trigger rows
a 104 CSS px label column and a flexible control column should put labels on the left and
controls on the right without a breakpoint. The trigger choices may wrap inside their own
column on narrow screens. Color must remain a vertical field and the final configuration
item, while the existing modal draft, focus and Save behavior stays unchanged.

**Implementation, before measurement.** The name and trigger fields now share the
`channel-settings-kv` grid. A visible external span labels the native trigger field set
through `aria-labelledby`, avoiding field set/legend grid layout while retaining its
group semantics and single running/stopping disabled flag. The header has only its
required visible title: the description element, ARIA relationship, dead CSS and four
`channels.dialogDescription` catalog entries are removed. Color retains its native input
and vertical field class in this pair. No trigger mapping, channel color, App state or
row-pitch code changed.

**Repair, before the focus rerun.** The first real-mouse backdrop check discarded the
draft but left focus on `body`: preventing the backdrop pointerdown's default action is
necessary so the completed click cannot retarget focus after the handler restores it.

**Result: HELD after one focus repair.** [MEASURED] in headless Chrome at 1280x800 and
320x700: 9/9 checks passed. At desktop the 420 px dialog gave both KV labels 104 px and
both controls 270 px; at 320 px the 288 px dialog retained the 104 px labels and shrank
the controls to 138 px, wrapping trigger choices without page or dialog horizontal
overflow. Color remained vertical and last, the visible title remained, and no
description element or ARIA relationship existed. Save trimmed a name and retained its
trigger/color payload; Cancel, real Escape and a real backdrop click discarded drafts.
Save, Cancel, Escape and backdrop all returned focus to the D0 settings button. A zh-CN
switch preserved the layout and description-free header, and no uncaught page error
occurred.

The first backdrop run was not accepted: it exposed a real post-click focus move to
`body`. The repair above prevents that default focus action; the rerun then passed the
same real-mouse check. The earlier driver startup timeouts were target/navigation setup
issues, not product evidence, and were discarded rather than counted as application
failures.

Node checks passed with 16/16 channel-layout results, including exact KV/color-order,
description and backdrop-focus guards; 28/28 i18n results, including description-key
absence in all four catalogs; and `tsc --noEmit`.

## 18. Six trigger modes with an explicit any-value default

**Prediction, recorded before the trigger browser checks.** The software trigger already
matches `edge`, so adding it to the UI-owned mode union and moving the pure mode/condition
transforms beside the state types should expose dual-edge without touching capture code.
A shared `DEFAULT_TRIGGER_MODE = 'dont-care'` should preserve the existing unconfigured
X behavior, while `triggerModeFromCondition` should stop legacy/debug edge conditions
from degrading to X. Six 36 px choices should fit the desktop KV control column and wrap
without changing the measured dialog widths.

**Implementation, before measurement.** `state.ts` now owns the six-mode union, default,
and both pure transforms; App imports them and retains all clamping, origin reset and
redraw ownership. The radio order is falling, rising, dual-edge, high, low and any-value,
with the existing `trigger.anyEdge` translation reused. Every glyph was redrawn as a
coherent stepped-edge, level or X family with rounded stroke joins. The dual-edge glyph
shows rising and falling steps side by side. All trigger colors, channel colors, global
mask and pre-trigger logic are unchanged.

**Result: HELD.** [MEASURED] in the combined headless-Chrome scene: 12/12 checks passed,
including all Pair-1 regressions. The six icons had distinct path data and translated
accessible names, fit one row in the 270 px desktop control column, and an unconfigured
channel selected X. Saving each mode produced its exact expected condition: dual-edge
produced `kind: 'edge'`, X removed only its own channel's condition, and every saved
selection survived reopen. The other channel's condition, Enable Mask and pre-trigger
percentage stayed unchanged. Running and stopping were injected separately as UI state
preconditions, not a hardware lifecycle: in both, all radios were disabled while name and
color stayed editable, and metadata Save retained the stored edge mode. No uncaught page
error occurred.

Node checks passed with 20/20 channel-layout results, including exact six-mode mapping,
round-trip, sorted mixed-condition and shared-default tables; 28/28 i18n results with
`trigger.anyEdge` added to the translated probes; and `tsc --noEmit`.

## 19. Preset color grid and a custom-color Popover

**Prediction, recorded before the color-grid browser checks.** Fifteen preset buttons plus
one custom invoker in an eight-column CSS grid should produce exactly two rows at both
desktop and narrow widths. A native Popover anchored to the 16th swatch can provide
shadcn-style rounded, token-colored arbitrary color input without document listeners or
a new dependency. Keeping `selectedColor` as dialog-only draft data and using the existing
configure callback should leave every card/chip/waveform color consumer unchanged.

**Implementation, before measurement.** `CHANNEL_COLOR_PRESETS` starts with the unchanged
eight channel defaults and adds seven bright hues. The last vertical field now owns a
role-labelled 2x8 button grid. Presets use `aria-pressed` and visible ring selection; the
custom swatch always previews the current draft and carries a token-backed + badge. Its
native Popover contains the existing full-width color input, focuses it on open, updates
the draft on `input`, and closes/returns focus on `change`. Opening a saved preset selects
its button; any other saved value selects custom. Dialog close and Submit both hide the
Popover before proceeding, and only Submit reaches App.

**Result: HELD.** [MEASURED] in the combined headless-Chrome scene: 17/17 checks passed,
including every Pair-1/2 regression. The grid had 16 cells in exactly two rows of eight at
1280x800 and 320x700. A #F472B6 preset and arbitrary #12AB34 custom color each reached the
card and Digital chip, retained the trigger mode, and reopened with the correct
preset-versus-custom selection. Cancel, real light dismiss and two-stage Escape discarded
drafts; the first Escape closed only the Popover and the second closed the outer dialog
and restored gear focus.

The open Popover remained modal-owned, focused its native color input and used a measured
7.5 px radius with a 220x82 px box. At 320 px it stayed inside the viewport
(left=100, top=457, right=320, bottom=539). No uncaught page error occurred.

Through the tracked `fixtures/i2c.sr` loading path, three exact waveform PNG checks also
passed: D0 contained 797 #F472B6 pixels after preset Save; after custom Save it contained
790 #12AB34 pixels and zero remaining pink pixels; untouched D1 retained 791 #FF9E2C
pixels and zero green pixels. The browser-owned OS color chooser surface itself was not
automated; the shipping input was exercised through its standard input/change events,
while the Popover, draft lifecycle and downstream rendering were measured.

Node checks passed with 21/21 channel-layout results, 28/28 i18n results with the custom
color label in translated probes, and 14/14 theme results including 15 unique valid
presets and unchanged UI/renderer defaults. `tsc --noEmit` and the production Vite build
also passed; only the pre-existing chunk-size warning remained.

## 20. AI assistant sidebar

A fourth sidebar choice (after Device, Analyzers) opens a chat with a model the user
reaches with their **own API key**: Claude through the official `@anthropic-ai/sdk`, or
any OpenAI-compatible chat-completions endpoint (OpenAI, DeepSeek, Qwen, Kimi, GLM or a
relay). There is no server: the page calls the provider directly.

**Layers.** `src/assistant/` is provider-neutral and DOM-free, so it runs under node:
`settings.ts` (persistence), `tools.ts` (what the model may see and do, through an
`AssistantHost` that App implements), `loop.ts` (model turn -> tools -> results), the two
providers and `systemPrompt.ts`. `src/ui/assistantPanel.ts` is the view. App mounts it
**once** and only toggles `hidden`: `renderPanels()` clears the other panels on every state
change, which here would drop a streaming answer, a pending approval and the draft.

**Tools.** Read tools (`get_state`, `get_channel_stats`, `get_edges`, `list_decoders`,
`describe_decoder`, `get_annotations`) and view tools (`set_viewport`,
`zoom_to_annotation`) run at once. Tools that change the capture (`set_capture_settings`,
`start_capture`, `stop_capture`, `load_demo`, `attach_decoder`, `remove_decoder`) wait
for the user's Allow on an approval card ("Allow all in this chat" skips the rest of the
chat). Each tool goes through the path a button uses (`debug.setSettings`,
`startCapture`, `attachAnalyzer`...), so the assistant cannot reach a state the UI cannot.
Tools return compact summaries - statistics, a capped edge list, decoded annotations -
never raw samples, and say when they truncated. `start_capture` resolves when
`stopCapture` finishes (`captureWaiters`). Connecting a device stays the user's click: the
WebUSB prompt needs a user gesture.

**Loop invariants.** Every tool call of a turn gets exactly one result in one message,
including declined, invalid (validated against the tool's JSON Schema before it runs) and
cancelled calls - an unanswered call makes the next request fail. A turn that ended in a
refusal, or hit `max_tokens` with a tool call, never runs its tools and is not appended
(a truncated input can look valid). Claude's transcript is append-only.

**Claude request.** `claude-opus-5-5` by default (Sonnet/Haiku 5.5 offered), adaptive
thinking with `display: "summarized"` (shown as a collapsible "Thinking"), explicit
`effort: "medium"`, top-level `cache_control` over a byte-stable system prompt and tool
list, `eager_input_streaming` on every tool. On the official endpoint only, safety
declines are retried server-side with `fallbacks: "default"`
(`server-side-fallback-2026-07-01`); relays tend to reject unknown parameters. The SDK 1.x
sends the key as `Authorization: Bearer`.

**The lazy chunk.** The SDK (329 KB, 74 KB gzip) is imported on the first Claude message,
so the entry grew only by the assistant itself (~43 KB). The SDK has dynamic imports of
its own, which Vite wraps in its preload helper; left alone, rollup put that helper in the
entry and the chunk imported the entry asset - which would boot a second App (0340d7a).
`manualChunks` gives the helper a chunk of its own (hosted builds only - it conflicts with
the portable build's `inlineDynamicImports`). `claude.ts` imports nothing at runtime but
the SDK. `assistant-selftest` checks both, the latter against the built `dist/`.

**Network and privacy.** A web page cannot use an HTTP or SOCKS5 proxy by itself; where
the official endpoint is unreachable the user sets a **Base URL** (an API relay or reverse
proxy) or turns on a system/browser proxy. The key stays in sessionStorage unless the
user ticks "remember" (then localStorage), is never written into the settings record, and
is redacted from any error text shown. A one-time notice explains that messages and the
summaries the tools read go to the chosen provider. Untested so far: whether the official
APIs accept the `null` origin of the portable build opened from `file://`, and which
OpenAI-compatible providers allow browser (CORS) requests at all - a relay covers both.

**Follow-ups after first use.**
- *Markdown.* Answers and thinking summaries render through `src/ui/markdown.ts`: DOM
  nodes only, never innerHTML; HTML stays literal text; only http(s) links become links.
  Streaming re-renders the accumulated text at most once per animation frame. Single
  `_`/`__` emphasis only off word boundaries, so identifiers stay literal.
- *Keyboard.* The plot's shortcuts (Space start/stop, f fit, Escape) ignored inputs and
  selects but not textareas, so Space in the chat started a capture. They now also skip
  textareas, contenteditables and anything inside `.assistant-panel`.
- *Header.* One row: title, a gear (settings toggle) and a small New button.
- *Time scale across resizes.* The view used to keep its sample range when the plot
  width changed, so opening the sidebar squeezed the waveform and closing it stretched it.
  `WaveformStack.syncSize` now keeps samples per CSS pixel (left edge fixed, or the right
  edge in live follow mode) and shows more or less time instead.

`src/ui/tools/assistant-selftest.ts` (81 checks) replays recorded SSE streams through
both real providers, runs every tool against the protocol demo capture, and drives the
loop's approval, abort, refusal and truncation paths with a scripted provider.

## 21. Parallel bus (ADC) as an analog row

The analyzers sidebar has a "Parallel bus / ADC" section. It turns n capture channels
(bits, LSB first, contiguous or any wiring) into one value and draws it as an analog
row above the channels. This reconstructs an ADC's output from its parallel data lines.

**Reading** (`src/data/busValue.ts`; data NOTES has the detail).
- With a clock channel, the value is latched on its active edge and held until the next
  one. This is what DCLK means, and it hides the glitches of bits that switch a few
  samples apart.
- Without a clock, any bit change makes a new value. Those values are drawn as steps,
  because a combinational value holds between changes.
- Encodings: unsigned, two's complement, offset binary.
- A full scale in volts relabels the axis: `V = offset + value / 2^n x full scale`.

**Drawing** (`busView.ts`, `Overlay.drawAnalog`).
- The analog row is a renderer row (`RowSpec.kind = 'analog'`), covered with `fillLane`
  and drawn on the overlay. This is the same trick annotation lanes use.
- Zoomed in to at most 256 samples per device pixel (and at most a 4 M-sample window),
  it uses the exact value timeline for the window. That is points joined by lines (or
  steps) while there are fewer values than pixels, otherwise a min/max bar per pixel
  column.
- Zoomed out, it uses the min/max pyramid, which `pumpBusBuilders` builds a 6 ms slice
  per frame once a capture is complete. The part not built yet stays empty and fills in.
- During a live capture there is no pyramid, so wide windows show a "zoom in" note.
- Frames are cached by window, so hover redraws are free.
- Trace colours are the vivid channel tones (`busColor`). The muted analyzer palette sank
  into the grid as a 1 px trace.

**MSB/LSB.** ADC data lines are often wired MSB-first.
- The editor takes a width, a **start channel** (the lowest channel of the run) and a
  **"start channel is the MSB"** checkbox. Unticked, the start channel is the LSB;
  ticked, the same channels are read in reverse order (`runBits`).
- `runStart` reads that state back from the bits, so a reversed bus opens with the box
  ticked, and changing the width or the start channel keeps it ticked.
- Each listed bus also has a one-click `MSB↔LSB` button that reverses its order at once
  (`swapBusOrder`).
- Summaries always read LSB first, so a reversed bus shows as `D11–D0`.
- `bus-view-selftest` checks that a swap reads every code bit-reversed.

**Hide source bits** removes those rows from the plot (`visibleChannels`). It is display
only: `enabledChannels()` still decides the capture width, so hiding never changes what
the next capture records. Drag reordering numbers the visible channel cells, and the bus
cells above them are not draggable.

**Panel placement.** `BusPanel` has its own host under the analyzers sidebar.
AnalyzerPanel clears its host whenever it re-renders itself (on decoder hydration, for
one), and a section appended after it disappeared at random until it had its own host.

Hover over the analog row reads the value at the pointer (and volts when a full scale is
set). Bus views are session state, like analyzers: not persisted, kept across captures,
and rebuilt for each new one.
