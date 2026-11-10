# slogicweb MSO - interface design

**Status: v2 target.** This document specifies what the user sees and does: layout,
controls, interaction, visible lifecycle, visual tokens, copy, accessibility and the
interface review gate. The current code implements the earlier LA-only interface; §17 is
the migration plan. Interface facts are normative here; engine and state facts are
normative in `docs/ARCHITECTURE.md`. `src/ui/NOTES.md` is historical measurement
evidence. A fact lives in exactly one file.

**Document map.** `docs/ARCHITECTURE.md` owns module boundaries, platform/WebUSB
constraints, LinkSession, DeviceProfile, SignalStore, TriggerPlan, the composite state
machine, the settings transaction, panel/view-model contracts, persistence, decoding
runtime, security (C1) and verification. This file owns the window/pointer model, shell,
channel rows, plot, touch grammar, trigger and acquisition UI, presenters, status,
visual system, copy and the UI review gate. C3 (migration) is §17 here; split it into
`docs/MIGRATION.md` when it outgrows this document.

## 1. Principles and scope

- **One instrument, one time axis.** Digital, analog and decoded signals share one
  timeline and one origin. A second axis is a bug.
- **Acquisition first.** Display, measurement, decoding and recording never block the
  capture path. A busy UI must not cost samples.
- **One primary action.** Capture/Stop is the only control that starts or stops an
  acquisition. It has exactly one instance per layout: top bar on wide, bottom action bar
  on compact.
- **One setting, one home.** A value has one editor. Elsewhere it may be read-only or
  directly manipulated; it never has a second editor.
- **Every control declares when it applies.** Live / next acquisition / view / preference.
  The UI shows which, especially while a capture or record runs.
- **Never silently reconfigure.** A change applies live, is staged, or is a named restart
  the interface announces. A running capture is never a hidden side effect.
- **State, not prose.** A lifecycle state is a chip, a badge, a disabled control or a
  short hint. Long explanations belong in tooltips and documentation.
- **One interaction mechanism per job.** Direct manipulation, row slot, popover, sheet,
  dialog or panel; not three of them for the same job.
- **Capability-driven.** Every offered value/action is validated against the
  `DeviceProfile` and the current platform; an unsupported action is disabled with the
  typed reason, never silently absent or failing later.
- **Touch and mouse are peers.** Every action is reachable on a phone with one hand; every
  gesture has a menu or keyboard equivalent. No hover-only information.
- **One source of truth.** Derived values are computed; view models are presentation-ready
  snapshots; panels do not reach App/Device/Store.
- **One time origin.** `displayOrigin()` is T when the current wave has a trigger, else
  the sweep start, else the held wave's T. All axes/readouts/measurements use it.
- **Colour has one job.** Channel/analog colours identify signals. Primary marks actions,
  focus and selection. Amber marks an armed/waiting trigger. Red marks errors and Stop.
- **Flat, tokenised, measured.** Surfaces are flat; tokens from §14; no raw component
  colours/sizes; no per-theme component override blocks.
- **Failures are visible.** Every async action ends in a state or a typed error in the
  top alert banner; nothing only reaches the console.
- **Tests describe behaviour.** UI tests assert view models/DOM/transitions, not source
  text.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Acquisition** | One Capture→Stop run. It owns a session, sweeps, retention and display. |
| **Sweep** | One device RUN→STOP. Single one; Repeat one per Interval; Loop unbounded. |
| **Retention** | The display window kept in RAM: a finite duration or the Loop window. |
| **Record** | An archive in OPFS, independent of retention; may run while Loop rolls. |
| **Viewport** | The visible time range; policy FollowLive, Fixed or TriggerLocked. |
| **Signal / channel** | A digital channel (D0…) or an analog channel (A0…). |
| **Group** | Signals sharing one sample rate and position space. |
| **Bus** | A display construct built from signal bits; not a device channel. |
| **Analyzer / Decoder** | An attached protocol decoder instance / its protocol implementation. |
| **Profile** | The `DeviceProfile` that declares a device's capabilities. |
| **Link** | The USB session; its state is separate from acquisition/record/view. |
| **T** | The trigger sample; 0 s. Without a trigger the sweep start is 0 s. |
| **Pointer class** | Mouse, touch, pen or keyboard; the active input grammar. |
| **Window class** | Wide, Medium or Compact; the layout grammar. |

## 3. Layout and window classes

```
┌ shell ───────────────────────────────────────────────────────────────────────┐
│ [Device] [Capture ▾] │ [Open] [Save] │ [Panel] [Settings]                    │
├ corner cell ─┬───────────────────────────────────────────────────────────────┤
│ 100 MS/s     │ overview strip (retention / record ranges, viewport frame)    │
│ ⤢ 1.30 ms    │                                                               │
│ + Decoder  T │ ruler                                       ┬ presenter ──────┤
├ label column ┼ plot: grouped rows ─────────────────────────┤ Docked          │
│ D0  ◇ trigger│ digital / analog / math / bus / lanes      │ or Sheet/Dialog │
│ A0  ◇ trigger│ annotations / cursors / T / record band   │                 │
├──────────────┴───────────────────────────────────────────┴──────────────────┤
│ interaction hints for the area under the pointer (never status)              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Budgets (merge gates):** at most 8 top-bar commands; at most 4 sections per panel;
at most 2 inline actions per row; exactly one Capture/Stop instance per layout; one
presenter and one overlay open at a time. A new command/control must replace one, move
into a menu/section, or wait for a milestone.

### 3.1 Window classes

| Class | Width | Layout |
| --- | --- | --- |
| Wide | ≥ 1000 px | Docked presenter column; toolbar icon + label; plot keeps ≥ 480 px |
| Medium | 760–999 px | Docked presenter ≥ 280 px; toolbar icon + label; plot ≥ 480 px |
| Compact | < 760 px | Presenter is a bottom sheet (or full-height sheet for complex panels); top bar compacts; a bottom action bar holds Capture; labels 104 px; plot keeps ≥ 240 px (rows scroll horizontally below that) |

- The page never scrolls horizontally. Rows may scroll horizontally only when their
  minimum width cannot shrink further.
- Compact is not a shrunken desktop: controls reflow, labels truncate, secondary actions
  move into overflow menus, and the primary action moves to the bottom action bar.
- Safe areas: `env(safe-area-inset-*)` on the shell, bottom interaction bar and sheets.
  The bottom interaction bar sits above the system navigation area.
- Orientation: portrait and landscape are both supported; the sheet height is capped at
  `min(72dvh, viewport − 96px)` and can be dragged between peek and full.
- A persisted pane width is clamped so the other pane keeps its minimum (§15).

### 3.2 Pointer classes

| Class | Grammar |
| --- | --- |
| Mouse | Hover readout, wheel scroll/zoom, drag pan, double-click cursor, right-click context |
| Touch | Tap select, drag pan, two-finger pinch zoom, two-finger drag pan, long-press context, 48 px targets |
| Pen | Hover readout, barrel-button context, drag pan, pinch only when a second touch is present |
| Keyboard | Every action reachable by a shortcut or a focusable control; arrows/Enter/Esc |

The active class is detected from the event (`pointerType`), not from the device; a
hybrid laptop switches grammars per input. Touch layouts never require hover and never
show a control smaller than 48×48 CSS px (24 px for an in-row trigger slot with a 48 px
hit area).

### 3.3 Presenters

One panel view model is rendered by one of three presenters:

| Presenter | When | Behaviour |
| --- | --- | --- |
| Docked | Wide/Medium with mouse or pen | Column beside the plot, resizable; close button; panel switcher in the toolbar. |
| Sheet | Compact, or Medium touch | Bottom sheet over the plot, scrim, drag handle, Close and back; one sheet at a time; height persists per panel. |
| Dialog | A destructive/complex confirmation, or a panel that must block the plot | Centred modal; focus trap; Esc/back/Close; no nested dialogs. |

- The presenter owns placement, dismissal and focus; the panel owns content and callbacks.
  The same panel view model is used by all three.
- A sheet never opens a second sheet; it opens a dialog or a one-level menu.
- Android back closes the topmost overlay, then the sheet; if none is open it is left to
  the browser (never trapped).
- The panel switcher is the only way to change panels. It has one entry per layout:
  toolbar on wide/medium, a "Panels" control in the compact bottom action bar.

### 3.4 Corner cell

The cell where the label column meets the overview strip and the ruler (`#labels-spacer`,
`--labels-w` × `--overview-h + --axis-h`) is the view's own control point, not padding:

- **Overview half — capture summary and Fit.** First line: the displayed capture's rate and
  length (`100 MS/s · 20.0 ms`; the sample count and channel width in its tooltip). It is
  the readout the old status line carried; clicking it opens the Acquire panel. Second
  line: **Fit** with the current view span (`⤢ 1.30 ms`): click fits the viewport to
  retention (`F` is the same action), wheel/Ctrl+wheel over it zoom like the ruler. Fit
  exists only here and in the long-press/context menus — not in the top bar.
- **Ruler half — Add decoder and the trigger column.** `+ Decoder` (HSync's "Add
  decoder" place) opens the Decoders panel with the picker focused; it is enabled without
  a capture, because attached analyzers re-run when data arrives. At the right, a small
  `T` caption heads the column of per-row trigger slots below it.
- With no capture the summary reads "No capture" and Fit is disabled with a reason.
- Compact: the cell keeps only two 40 px icon buttons (Fit, Add decoder); the summary
  moves into the Acquire panel. The hint bar names the cell's gestures like any other area.

## 4. Shell and primary action

Target top bar, left to right (≤ 8 commands):

| Control | Appearance | Behaviour |
| --- | --- | --- |
| Device | Icon + short label; connected tint; connected label is the model and `· Connected` (the state word drops on compact). Disconnected (WebUSB present) it reads `Connect device` and is the bar's highlighted primary control, while Capture stays unhighlighted and disabled; any disabled command is plain grey, never filled | Idle: opens the WebUSB chooser. Connected: opens the device menu (model, serial, USB link — `unknown`, WebUSB reports no speed and throughput is not evidence; Disconnect, Connect another device, Firmware update ↗ which releases the board and opens the public updater). Target: the Link panel. Disabled, with a reason tooltip, when WebUSB is unsupported. |
| Capture / Stop | Primary split button; label/summary names mode and retention (`Single · 10 ms`, `Loop · 1.0 s`, `Record`) | The only start/stop action. Chevron: Single, Repeat, Loop, Autoset. Disabled with the same `canRun` guard for click, keyboard, host interface and debug. |
| Open | Icon + label | Imports a capture. Today it opens a two-row menu: Open file… (`.sr`/`.lwcap`) and Open example (a bundled UART `.sr`, inlined in every build, that loads through the same import path and auto-decodes, so the app can be tried without a device). While the displayed capture is unsaved (device data - running, or completed and not yet saved in any format; an opened file never counts) Open, the example and drag-drop first ask a destructive confirmation (`unsaved.*`; the button asks before the menu's file chooser), and leaving the page triggers the browser's `beforeunload` prompt; the listener exists only while something is unsaved. A confirmed Open stops a running acquisition first. Starting a new capture over unsaved data is deliberately not guarded. A `.sr`/`.lwcap` dropped anywhere on the window opens the same way; while files are dragged over the page the plot shows a dashed "Drop .sr / .lwcap to open" overlay (cleared on drop, leave or dragend), and the empty hint says files can be dragged in. |
| Save / Export | Icon + label | Saves the displayed capture or exports the record; opens the export sheet. Disabled without data. Today it opens a four-row format menu: `.lwcap` (first; lossless, keeps gaps), `.sr` (sigrok session for PulseView), `.vcd` (value change dump: one `$var wire` per channel, the largest exact timescale) and `.csv` (one row per transition: `time_s,sample,channel,level`, after one initial-level row per channel). `.sr`/`.vcd`/`.csv` write the enabled digital channels only. With the File System Access picker every type is offered (the chosen one first) and the picked extension decides the format; otherwise the file downloads. Default name: `<model>_<N>ch_<rate>_<local YYYYMMDD-HHMMSS>` (model = the device's reported name without spaces, `capture` without one), or the opened file's base name. |
| Panel | Icon + label | Shows/hides the presenter and opens the panel switcher. |
| Settings | Icon | App preferences: theme, locale, density, units, shortcuts, about/diagnostics. |
| — | — | No Assistant, Language, Theme or fullscreen as top-level commands; they live in Settings or the compact overflow. |

Fullscreen, language, theme, density and shortcuts live in Settings or the compact
overflow; they never take a top-bar slot.

**Compact bottom action bar:** one Capture/Stop split button, a Panels control and an
overflow menu (Open/Save/Settings; Fit is in the corner cell, §3.4). It has no duplicate Capture; the top bar on compact
shows Device and status only. The bar respects safe areas and stays reachable one-handed.

**Capture split menu:**

- Single: one sweep; duration or Unlimited; retention only.
- Repeat: one sweep per Interval; retention per wave; the previous wave is held when the
  next is waiting.
- Loop: one unbounded sweep; retention window L; recording may run independently.
- Autoset: a Capture variant that chooses a valid timebase and analog range for the
  current signals, then captures once. It never changes decoder/trigger configuration
  silently; the applied values are shown before start.

**Autoset and recording:**

- Recording is a toggle in the Capture menu and a control in the Record panel; both
  dispatch the same command, not two states. It is disabled with a typed reason when the
  profile or OPFS cannot record.
- A record can start/stop independently of the acquisition; stopping the acquisition
  pauses the record and offers "Finish record".
- No control starts two acquisitions. A second Capture click while running is Stop, never
  "start another".

## 5. Channel rows and analog signals

Rows are grouped: digital groups, analog groups, math/FFT, buses, then decoder lanes.
Every row is one horizontal band aligned with the plot; the label and plot halves share
one anatomy (band or inset card, one separator token).

### 5.1 Digital rows

- 5 px signal-colour strip; `D0` tag; editable name; trigger slot at the right; decoder
  lanes below; row height handle.
- Interactions: click trigger slot → condition menu; double-click name (the row entry;
  Enter/F2 from the keyboard) → settings popover with the name and the signal colour;
  drag label → reorder; drag bottom edge (mouse/pen) or row menu (touch) → height; tap
  decoder lane remove.
- A row's inline controls: trigger slot and row entry (settings/gear), at most two.
- Colour is editable from the row entry (HSV picker plus reset to the index colour of
  §14.2); it applies live and persists with the workspace like the name.
- Touch: the whole row is 48 px minimum; the trigger slot has a 48 px hit area even when
  its glyph is 24 px.

### 5.2 Analog rows (first-class)

Analog channels are not bus rows. Each analog signal has a row with:

- Signal colour strip; `A0` tag; editable name; probe/range chip; `V/div`; zero marker;
  overload badge; trigger slot. The range/V-div/zero/overload are readouts; the only row
  actions are the trigger slot and the row entry (editor). Dragging the ruler is direct
  manipulation of the same values, not a third action.
- **Range is hardware, scale is view.** Range (e.g. ±1 V, ±16 V) and coupling/attenuation
  are probe settings in the channel editor and require a profile capability. `V/div` and
  zero position are view state and can be changed without affecting the device.
- **Gain is declared, not set.** A group whose profile lists `gains` carries its one gain
  control inside the group's cell in the Acquire panel — the cell that replaces the eight
  D chips reads `A0 [×1 ▾] ±16 V`, the select holding the profile presets and "Custom…";
  Custom turns the select into a ratio field in place (Enter/blur applies, Esc reverts).
  There is no separate gain row. The cell's "?" tip says the gain must match the module's
  own setting and is used to convert codes to true voltages, and gives bits and volts per
  code (`8-bit · 125.5 mV/code`). The row label names the gain and range ("×2 · ±8 V"). Changing it rescales the display, V/div (reset to the gain's
  default, the finest 1-2-5 step showing the whole range) and trigger level, never the
  device, and is allowed while a capture runs without restarting it. A configured trigger
  level keeps its volts, re-snapped to the new code grid and moved to the range edge when
  outside it (not restored if the gain is changed back); a waiting or Loop trigger is
  retuned live, like a level drag, and a finished capture keeps its T.
- The row's right ruler carries the graticule, `V/div` and the trigger level. Dragging
  the trigger line edits the same analog condition as the editor; it is not a second
  trigger.
- An overload badge (amber/red, with text) appears when the ADC clips; it never auto-ranges
  silently. Autoset may choose a new range once, with the change shown. The row's own
  vertical autoset (`A` on the focused ruler, or the ruler's context menu, which also
  holds Reset = double-click/`Home`) is view state only, allowed while running: it fits
  the visible window's min..max into about 80% of the row's divisions with the finest
  1-2-5 V/div of the gain's steps and centres it (zero clamped to the row); a flat or
  empty window gets the gain's default. The ruler animates to and labels the new V/div.
- The trace is drawn as sampled: below one sample per pixel (and for holds at least
  8 px wide) a held code is a flat line to its last sample, then the one-sample step,
  never a ramp across the hold; denser data is the smooth curve through the samples.
- The analog trace uses the channel colour; the grid is a shared graticule token; 0 V is
  a solid line, other divisions dashed.
- No analog row exists without a profile analog group; the panel says why the control is
  disabled.

### 5.3 Buses, math and decoder lanes

- A bus row is a display construct built from signal bits; its editor owns wiring, clock,
  encoding, style, height and hide-sources. The row shows status and one edit entry.
- Math/FFT rows are derived signals (A+B, A−B, ×, FFT magnitude/phase, etc.). Their
  sources are signals, not device channels; they have no trigger slot. Math/FFT runs on
  the visible retention window (or a selected window), never on an unbounded capture.
- Decoder lanes sit under the signal that carries them; the analyzer label, status and
  remove action are in the row. Decoding follows the retention window and states whether
  it is a snapshot.
- The analyzer form lists channel mapping first, then the decoder's main options, then the
  Attach/Apply action; the remaining options sit in a collapsed "Advanced options"
  disclosure under the action. A decoder whose channels are all optional (UART) starts
  with its first channel mapped, and a mapping that reads no channel is refused in the
  form. Clicking an attached analyzer's name loads its mapping and current options into
  the same form ("Edit UART", decoder locked); Apply replaces the old result by
  re-decoding with the new options.
- The decoder picker shows sigrok's short name and the localized long name
  ("UART - 通用异步收发器"); the stored value is the id. Its search ranks protocol aliases
  first (串口 → uart, IIC/I²C → i2c, 单总线/1-Wire → onewire_link, 红外/IR → ir_*; a prefix
  of a shown name counts as an alias), one alias table for every locale; then the fuzzy
  match on name, localized long name and id. Common protocols (uart, i2c, spi,
  onewire_link, can, usb_signalling, ...) rank first among hits of one tier.
- Channels are matched by name when the form seeds a mapping: a capture channel whose
  name, or one word of it, is a decoder channel's id, name or a common synonym
  (UART_TX → TX, I2C_SDA → SDA, MOSI0 → MOSI, SCK → CLK) is prefilled and the form says
  "Matched by channel name". A channel the user set by hand is never moved again.
- sigrok's "-1 = off" for a free integer option (UART packet delimiter/length) shows as
  an empty field reading "off"; the stored value stays -1.
- **New data re-decodes.** With "Auto-decode" on (per session, default on), every attached
  analyzer re-runs after a capture stops and after a file opens — never during ingest;
  Repeat waves between intervals are not decoded, the session's last wave is. Opening a
  file keeps an analyzer only when every channel it maps exists in the file; the others
  are removed and named in a dismissible panel note. Channel names are not compared
  (sigrok files usually carry generic D0..Dn names). A decode that finds nothing says
  "no annotations" on the row.
- **Bus views** are a section whose header row carries one `Add` button at its right; Add
  opens the bus editor in a dialog (the presenter's Dialog form), not an inline form. Each
  listed bus view has exactly two inline actions, `Edit` (the same dialog, prefilled) and
  `Remove`; bit-order swap lives in the editor. An analog bank's row is managed by its
  Analog button and shows `Remove` only.
- A bus/decoder never changes capture channels or trigger conditions.

### 5.4 Row height and groups

- Wide: digital rows 26–34 px, analog 80–480 px, lane rows 18–26 px; compact touch:
  digital 48 px, analog 96–480 px, lanes 32 px. Analog heights snap to 80, 120, 160, 240,
  320, 400, 480 px (handle drag, arrow keys); a new analog row starts at 160 px.
- **An analog row's graticule follows its height**: about 38 px per division, an even
  count from 4 to 8 (≤ 160 px: 4, 240 px: 6, ≥ 320 px: 8), so 0 V stays on a line. Resizing
  keeps V/div and the zero position; a taller row shows more divisions and a wider range,
  exactly like a scope with a bigger screen. A gain's default V/div is the finest 1-2-5
  step showing the whole range on the row's current division count.
- Row height is per-channel view/workspace state; double-click/row menu restores the
  default. Group headers are 32 px (compact 40 px) and collapse their rows.
- Group headers show the group's rate and channel range; an analog group shows its
  hardware range and resolution.
- Reordering never changes signal identity or capture indices.
- **Row density.** Digital rows auto-fit the plot between a 48 px floor and 72 px; when
  that floor does not fit, the stack scrolls. Settings → **Compact rows** (persisted
  workspace preference, default off) lowers the digital floor to 24 px: the cell keeps
  only its head line (name, original id, trigger slot) and drops the reserved decoder
  strip — an attached decoder keeps its own 20 px lane — so 32 channels fit a 768 px
  plot. Analog rows and lanes keep their sizes. It is an opt-in mouse density: it gives
  up the 48 px touch row (§5.1), which is why it is off by default.
- **Hide idle channels.** Settings → **Hide idle channels (no edges in the capture)**
  (persisted, default off) hides rows whose channel has no edge anywhere in the capture
  on screen (one whole-capture summary column per channel, `low ≠ high`). A note row
  after the last row, pinned to the bottom of the stack, says how many are hidden
  ("12 idle channels hidden (no edges) · Show"); clicking it turns the setting off.
  Unsupported/assumed: the filter applies only to a capture at rest — while an
  acquisition runs or stops every row shows; a channel carrying a decoder lane is never
  hidden; a capture with no edges anywhere hides nothing; rows the capture does not have
  (a widened width) are not idle, they are blank.
- **Capture-panel channel chips show/hide rows; they never change what is acquired**
  (the channel width does). Each chip's tooltip and accessible name say so
  ("D3: click to show/hide (does not affect capture)"); a hidden chip has a dashed
  outline in its channel colour and a muted, struck-through label.
- **The ruler, overview and corner stay pinned while rows scroll.** The label and plot
  columns grow to the row stack's height (`#scroll-area` `align-items: flex-start`, both
  columns `min-height: 100%`): a sticky box only pins inside its containing block, and a
  column capped at the viewport height let them scroll away past the first screen.

## 6. Time, plot, overview and measurements

### 6.1 One timeline

- The ruler is sticky and shows time relative to `displayOrigin()`. T is labelled; time
  before T is negative. The unit appears once per axis.
- Tick labels are absolute, signed times ("-100 ms", "0 ms", "1.4 ms"), all in one unit
  with one decimal count derived from the labelled step; no label is relative to another
  tick. A unit is promoted before a label needs four integer digits. Only a fine step far
  from T (e.g. 100 µs at 4.97 s) shows a single base at the left ("4.972 s") with signed
  offsets ("+0.4 ms"). Labels are placed by measured width and dropped, never
  overprinted, when they would collide (`axisLabels.ts`, `timeAxis.ts`).
- Multi-rate groups share the time axis; group headers show rates. A digital edge is drawn
  at its exact position; an analog group is resampled by time for the viewport, never by
  raw index.
- The trigger marker and T marker are distinct: the trigger marker is the configured
  condition; T is the matched sample. Both can be shown, never conflated.
- The viewport is bounded by retention; panning cannot leave it. A Fixed viewport that no
  longer fits falls back to the mode default, never a silent Fit.

### 6.2 Overview strip

- Shows the whole retention window, or the fixed Loop D window while locked; in Loop it
  never follows the retained length. Its scale and ticks are stable.
- The viewport is a 1.5 px frame; the record range is a separate band when recording.
- Click/tap centres; drag pans; pinch/wheel zooms. A gesture sets Fixed (except under a
  trigger lock, where it moves only V inside D).
- While locked, the true start is `T − f·L`; the 64-sample front-drop residue cannot
  shift it. A manual pan/zoom keeps coordinates in D, so a sub-window stays put while
  the waveform updates in place.
- The record band shows recorded ranges and gaps; it is not the same as the viewport.

### 6.3 Cursors and measurements

- The Measure panel has an explicit **Add cursor**; plot double-click/double-tap is an
  accelerator only. One command has one implementation: the button, double-click,
  double-tap and the long-press menu all dispatch "add cursor here"; none is a separate
  editor. A cursor is dragged by its handle (48 px touch target); per-row
  delete; no global destructive Esc.
- A cursor's numbered chip on the ruler is a handle too: a press on a chip (its painted
  box; 48 px target on touch, nearest chip wins where targets overlap) drags that cursor
  instead of panning, through the same grab/move path as the plot — the drag keeps the
  press offset (no jump), and snaps to edges of the row under the pointer once it is
  dragged down over the plot. Over a chip the ruler shows a grab pointer; elsewhere a
  ruler drag still pans.
- Cursors are session state and say "Session only"; they are not restored on reload. A
  new acquisition clears them with a visible notice; a Repeat wave inside the same
  session remaps them by the display-origin delta and keeps them.
- Measurement rows reference named cursors; missing references are empty selects.
- Automatic measurements (Vpp, mean, RMS, frequency, period, duty, rise/fall, overshoot)
  update when the visible window or signal set changes; they show their window and never
  run in the background.
- Math/FFT rows are measurements too: they state their sources, window function, bins and
  units; they never silently change the acquisition.

### 6.4 Plot painting

- Digital: 1 px traces, channel-colour wash below high; dense transitions become byte
  blocks; a busy line omits the wash.
- Analog: 1.5 px trace with a min/max envelope when zoomed out; dots when samples are far
  apart; clipping at row edges; overload badge. Below four samples per device-pixel column
  the trace is a monotone cubic through the samples (no overshoot, never folds back in x),
  not an envelope; an envelope column is the min/max of the samples timestamped inside it.
- Gaps: a hatched neutral pattern with a text/tooltip reason; pending data: a dotted
  neutral pattern. Neither is drawn as a level.
- Decode blocks use role colours (framing, address, command, control, data, check,
  handshake, line, error) and never guess protocol meaning. Errors are red and shaped,
  not colour alone.
- Cursors, T, trigger line and record band are overlay layers; the waveform moves under
  them in the same frame.

### 6.5 Decoded results

- The Analyze panel lists the events of the selected decoder: time, kind and fields, one
  row per event; the list states its window (retention or record) and whether it is a
  snapshot.
- Implemented as "Decode results" on the decoders page (`decodeResultsPanel.ts`): time
  from the displayed origin (T, else the capture start; negative before T), annotation
  class, text. Rows default to the decoder's main rows (per-bit rows left out, as on the
  lanes). A Text view joins consecutive annotations of a row into lines (UART ascii
  "H" "e" "l" "l" "o" reads "Hello"; `[0A]` ends a line, framing start/stop bits are left
  out, an idle gap starts a new line). The list is virtual and filtering runs in slices,
  so a million-annotation result does not block the page. Copy (selected/all, capped at
  100 k lines) and Export CSV/TXT write the listed lines; the range is the whole decode or
  the visible window at the time it is chosen. Selecting a row pans its block into view;
  selecting a block on the plot does not yet select the row.
- Selecting a row highlights the matching block and pans it into view; selecting a block
  selects the row. A search/filter uses the same field model.
- Copy/export writes the listed fields; the range control offers the visible window or
  the whole decoded window.
- Decoder errors are rows with the error role, not a traceback; unsupported fields are
  shown as text, never silently dropped.
- A running Loop's decode result does not claim to track every roll; it says "snapshot at
  …" and can be refreshed.

## 7. Input grammar

The plot, axis and overview share one grammar; the target under the pointer selects the
object. Every gesture has a visible equivalent.

| Input | Plot | Axis / ruler | Overview | Keyboard |
| --- | --- | --- | --- | --- |
| Mouse drag | Pan; drag a cursor/trigger handle | Pan; drag a cursor's chip moves that cursor | Pan frame | Arrows pan |
| Mouse wheel | Scroll rows (zoom with "wheel zooms" on) | Same | Same | — |
| Ctrl/⌘ wheel, pinch | Zoom at pointer | Zoom at pointer | Zoom at pointer | `+` / `=` / `-` |
| Shift wheel | Pan | Pan | Pan | `←` / `→` (Shift: half a screen) |
| Mouse double-click | Add cursor | Reset analog scale over a ruler | No action; use Fit | — |
| Touch double-tap | Add cursor | Reset analog scale over a ruler | No action; use Fit | — |
| Right-click | Context menu | Context menu | Context menu | Context-menu key / long-press |
| Touch tap | Select row/nearest edge; tap a trace shows the readout | Select/centre | Centre | Enter |
| Touch drag | Pan | Pan | Pan frame | Arrows |
| Two-finger pinch | Zoom at midpoint | Zoom | Zoom | `+` / `-` |
| Two-finger drag | Pan | Pan | Pan | Arrows |
| Long-press | Context menu (Add cursor, Measure, Fit, Trigger level) | Context menu | Context menu | Context-menu key |
| Pen hover | Readout; barrel button context | Readout | Readout | Focus readout |
| Pen double-tap | Add cursor | Reset analog scale | No action | — |

Wheel rules (one decision, `wheelGesture.ts` `wheelAction`, shared by the plot, axis,
overview and the hint bar):

- Default: a plain wheel only scrolls the rows (when every row fits it does nothing; it
  never zooms) and Ctrl/⌘+wheel zooms. Shift+wheel always pans.
- Settings > "Wheel zooms (no Ctrl needed)" (PulseView habit, persisted in the
  workspace, off by default): a plain wheel always zooms and Ctrl/⌘+wheel scrolls rows.
- Ctrl/⌘+wheel is always swallowed over these areas, so the page itself never zooms.
- Keyboard `+`/`=`/`-` zoom one wheel notch about the view centre; `←`/`→` pan a tenth of
  the view, Shift half of it. Ctrl/⌘/Alt chords stay the browser's.

Rules:

- One active gesture at a time. A drag that moves more than 3 px is not a tap. A pinch
  cancels a pan; a second finger never starts a second action.
- Touch targets: 48×48 CSS px; in-row trigger slots 24 px visually but 48 px hit area.
  Row height handles have a 24 px visible band and a 48 px touch band.
- No hover-only information: every hover readout is available by tap/long-press/focus.
- Browser gestures that would reload/scroll the page are suppressed only on the plot and
  only when the gesture is ours; text inputs, accessibility gestures and system back
  still work. `touch-action` and `overscroll-behavior` are scoped.
- Android back: close the topmost overlay, then the sheet; never trap it. A destructive
  dialog requires an explicit choice; back cancels it.
- The magnifier (touch/pen) shows the sample under the finger at 2× while dragging a
  cursor or trigger level; it never changes the data.
- Micro-adjust: after a tap selects a cursor/trigger, +/− buttons or arrow keys step one
  sample/one ADC code; a long drag is coarse.

## 8. Trigger UI

- **Conditions are owned by rows.** A digital row's trigger slot opens the six modes;
  an analog row's trigger slot opens rising/falling + level + hysteresis (profile-
  dependent). The Trigger panel previews, removes and explains; it is not a second
  editor.
- **Trigger panel:** enable, source/summary, condition list, pre-trigger, execution owner
  (read-only), state chip. For a profile with `mixed: false`, a Digital/Analog family
  choice is shown; switching retains the other family's stored conditions but they are
  not armed. For `mixed: true`, both families' conditions are ANDed and no family switch
  is shown.
- **States:** configured (neutral), armed (warning), filling (pre-fill holdoff), waiting,
  triggered, auto (an analog sweep - Single, Repeat or Loop - that forced after one window without a crossing: shows
  the untriggered data, labelled "Auto (not triggered)", no T marker), released, pending
  (Next badge), not-found (digital only: analog never ends as not-found). Only one family/state is bright;
  the other family is neutral, never falsely armed.
- **Enable:** turning it off leaves conditions stored and neutral; removing a condition
  never turns it off. Configuring the *first* condition while the trigger is off (a
  digital edge mode, or an analog rising/falling crossing) turns it on: that is the
  user's intent to arm (`edgeTriggerAutoArms`, `analogTriggerAutoArms`). Level and
  don't-care modes do not auto-arm. While a capture is running, this auto-arm never
  restarts it: the capture keeps free-running, the panel says the trigger arms the next
  capture (Repeat: the next interval), and Stop → Capture arms it now
  (`autoArmDefersToNextCapture`). Turning the enable on explicitly during a free-running
  capture is the named restart-to-arm transition and says "Restarting…".
- **Pre-trigger:** percentage/time, with the profile cap and the resulting history;
  per-group sample counts are read-only. The panel never promises more history than the
  ring can hold. The trigger waits until that window has filled (pre-fill holdoff), so a
  triggered capture holds the full window; if it ever holds less, the status shows the
  actual pre-trigger obtained. During the holdoff the status says "Filling the
  pre-trigger window (elapsed / total)… the trigger cannot fire" instead of "Waiting";
  the elapsed time is estimated from wall time since the stream armed at the capture
  rate (the page receives nothing from the matcher while it waits). Loop shows it only
  before its first match.
- **Retune/restart:** while waiting, edits retune and say "Retuned"; after a match they
  are pending for the next acquisition. A restart is a named "Restart to apply" action
  and never a hidden side effect. A Loop analog display detector may retune live; the
  chip says "Live detector".
- **Loop:** D/V are visible in the panel and overview; a digital one-shot lock says
  "Released" and how to re-arm; an analog detector says "Live". The UI never implies a
  released digital lock can re-lock.
- **Execution:** device vs host is a read-only fact in the panel; the user edits the plan,
  not the execution path.

## 9. Acquisition, retention and recording UI

- **Modes:** Single/Repeat/Loop in the Capture split menu; the Acquire panel shows the
  mode read-only plus duration/interval/window and retention.
- **Lifecycle:** every editable control displays Live/Next/View/Preference according to
  `ARCHITECTURE.md` §5.3. While running, the panel lists "Pending for next capture" when
  any Next edit exists. A restart action is explicit.
- **Link bandwidth:** a profile's `RateTier.recommendedHz` is the rate the USB link was
  measured to sustain at that width (5 Gbit/s: 200 MB/s, so 4/8/16/32 ch =
  400/200/100/50 MS/s; 400 MB/s aborts at every width). It is the connect default, never
  a ceiling. When the effective rate is above it — chosen by the user or forced by an
  analog group — the Acquire panel shows a warning under the rate ("32 CH @ 100 MS/s may
  exceed the USB link bandwidth (sustains 50 MS/s)"). **At-risk combination:** an
  analog group needs an ADC rate of at least 100 MS/s, so 32 channels plus analog on a
  5 Gbit/s link cannot stay inside the recommendation; the warning says the analog input
  forced the rate and that fewer channels lower the load. The UI never narrows the
  channel selection to avoid it. WebUSB cannot name the link class, so a 10 Gbit/s link
  gets the same (conservative) warning.
  The rate list marks every option above the recommendation ("200 MS/s (may exceed
  bandwidth)") so the risk is visible before choosing; the options stay selectable.
  Every rate the app moves on the user's behalf is announced under the rate ("Sample rate
  raised from 10 MS/s to 100 MS/s (required by the analog input)"). Turning the last
  analog group off restores the rate the first one replaced, re-clamped, unless the user
  picked a rate in between.
- **Memory ceiling:** Single/Repeat stores share the Loop window's 2 GiB packed-sample
  budget (`maxCaptureSamples`: 8 ch 2^31 - 1, 16 ch 2^30, 32 ch 2^29 samples). Unlimited
  shows the ceiling and, while running, "about x s left at this rate" on the 500 ms panel
  clock, in warning style within 10% of it. Reaching it, or an allocation failure, ends
  the capture as "Aborted · Memory limit reached" with the samples kept, never a crashed
  tab. A big .lwcap save streams bounded parts with "Saving… x%" and fails with a plain
  "out of memory" notice, not the raw allocation error.
- **Retention:** the panel shows kept bytes/time, the limit and the loop window; when the
  limit binds, a warning names the consequence. It never silently trims the trigger lock.
- **Record:** a separate state (`off/armed/recording/paused/exporting/error/full`), with
  bytes, duration, OPFS quota and a "Recover unfinished record" action. Recording is
  independent of the capture mode; a Loop may record while rolling.
- **Suspended/lost:** a backgrounded page shows `Suspended` with a resume action; a lost
  device shows `Lost` with reconnect, never a fake running state. A record in progress is
  marked paused/recoverable.
- **Progress:** one progress line per active operation (capture, record, export, import);
  cancel is offered unless the operation cannot be interrupted (then it says so).
- **Autoset:** a Capture variant; it shows the chosen timebase/range in a review line
  before starting. It does not change trigger/decoder configuration silently.

## 10. Panels and presenters

Target panels (each with at most four sections):

| Panel | Sections |
| --- | --- |
| Device | Link, Profile, Notes |
| Acquire | Acquisition, Retention, Notes |
| Trigger | Enable/source, Conditions preview, Pre-trigger, State |
| Measure | Cursors, Automatic measurements, Math/FFT |
| Analyze | Analyzers, Buses, Results, Status |
| Record | State, Capacity, Export, Recovery |
| Settings | Appearance, Behaviour, Shortcuts, About |
| Diagnostics | Test mode, USB register console (only with Settings > Developer tools on; persisted, off by default), Loop/decoder metrics |

On a platform without WebUSB, the Device panel states the typed reason and offers file
replay/Demo; Capture is disabled. The rest of the interface still works on imported data.
Until that panel exists, a dismissible browser-support notice (neutral surface, warning
icon, `role=status`, below the error banner) says the browser can only view and decode
files and names Chrome/Edge; it mentions HTTPS/localhost only when the cause is an
insecure context. The empty-state hint then offers files only; with a device connected it
prompts Capture instead of inviting a connection.

Settings › About shows the app version, PWA/update state, licenses and the storage
clear-data action; an update is an explicit prompt, never a silent reload. Today it is a
modal dialog from the Settings menu: name, version and build id (package version and
short git hash, `dev` when absent), `GPL-3.0-or-later · no warranty`, the copyright, and
plain links to the source repository, LICENSE and NOTICE.md.
The update state
comes from `getUpdateState()` / `onUpdateStateChange()` / `applyUpdate()` in
`src/ui/pwaUpdate.ts` (`off` without a service worker, `idle`, `ready`). A waiting version
also shows a notice under the platform notice — "A new version is ready. Reload to use it."
with Reload and Later; Later hides it for this page load, the state stays `ready`.

- One panel at a time; one presenter. The panel switcher opens it; the same control closes
  it. A collapsed panel leaves a full-height 24 px reopen strip at the right edge (in flow,
  covering no plot; 32 px with a 48 px hit area on touch).
- Each panel has exactly one header naming its scope; a panel never renders another
  panel's header or two headers.
- Panels never contain the primary Capture action or a second editor for a row-owned
  value.
- A panel's view model is presentation-ready; the presenter does not re-derive values.
- On compact, the panel switcher is in the compact bottom action bar and the sheet is
  the presenter; on wide, the switcher is in the top bar and the presenter is docked.
- The Assistant chat entry is removed from the baseline. External AI agents use the
  debug `agentHost` surface and the repository Skill; the top alert banner remains a
  first-class UI surface.

## 11. Interaction hints, errors and progress

The bottom bar is a context-sensitive mouse hint bar. It names the area under the
pointer and lists only the gestures that area's handlers implement, each with a small
inline mouse glyph (the used wheel or button lit) and any Ctrl/Shift keycaps. It is a
polite live region, so assistive technology reads the area and hints when they change.

| Area | Hints |
| --- | --- |
| Waveform | wheel per §7 (scroll rows, or zoom with "wheel zooms" on); the other of Ctrl+wheel; Shift+wheel pans time; drag pans; double-click adds a cursor |
| Time axis | wheel per §7; Shift+wheel pans; drag pans; dragging a cursor's numbered chip moves that cursor |
| Overview | wheel per §7; Shift+wheel pans the timeline; click or drag centers the view |
| Channel labels | wheel scrolls rows; double-click a name renames it; the trigger icon opens the trigger editor |
| Side panel | wheel scrolls the panel |
| Toolbar | click activates the command |

- Hints are mapped from handler behaviour, not from aspirational documentation: an
  area never advertises a gesture its code does not implement.
- With no capture, zoom/pan/cursor gestures are omitted because their handlers no-op.
  The bar keeps the gestures that still work (scrolling, opening a file) and says how
  to get a capture.
- A fatal error appears only in the prominent top alert banner; the bottom bar does
  not summarize errors. The banner has a dismiss action and uses the destructive
  token pair in both themes.
- A capture ended by a device or link failure is reported as Aborted with its cause
  and requested vs actual duration, never as Completed. For a failure with a known
  remedy the banner leads with the plain conclusion and what to do, keeps the
  diagnostic under a collapsed "Technical details", and may offer one remedy button
  that only changes settings (e.g. lower the rate); Capture/Stop still starts the next
  capture.
- The same plain-first-sentence rule covers a file that will not open (wrong type,
  unsupported content, damaged), a failed or oversized decode, the decoders failing to
  load, and a capture the board ended with no data or a dead USB transfer
  (`failureNotice.ts`); the raw diagnostic stays under "Technical details".
- Errors are typed (`unsupported-platform`, `permission`, `busy`, `handshake`,
  `profile`, `transfer`, `lost`, `suspended`, `memory`, `quota`, `record-full`, ...) and
  actionable; the diagnostic code stays in the console prefix.
- A failed device acquisition (Connect, the silent re-acquire, Retry) is classified as
  busy (another tab or program such as PulseView/DSView holds the interface; narrowed to
  "another slogicweb tab" when one answers a same-origin presence probe), permission
  (udev rule / exclusive holder), lost or unsupported. The banner shows the diagnostic,
  then the remedy on its own line, and a Retry action (granted device first, then the
  chooser) for every kind except unsupported. There is no forced takeover.
- Every async operation has a busy and terminal state; no silent catch.
- The bar never becomes a log; diagnostics go to the Diagnostics panel.

## 12. Menus, popovers, sheets and dialogs

| Surface | Use | Rules |
| --- | --- | --- |
| Menu | Choose one of a short list (device, capture mode, panel, export) | Anchored; one level; Esc/back/outside closes; focus returns. |
| Popover | Small anchored editor for one row (trigger, name, probe) | No scrim; one at a time; Enter commits, Esc/back discards; focus returns. |
| Sheet | A panel on medium/compact touch | Scrim, handle, Close/back; one sheet; height persisted. |
| Dialog | Complex/destructive edits or confirmations | Focus trap; Esc/back/Close; title names the object; primary action explicit. |
| Inline section | A panel value that applies immediately or next | No overlay; lifecycle badge rules apply. |

- One `OverlayController` (ARCHITECTURE §6) owns the stack: opening a transient surface
  closes its siblings; Escape/back closes the topmost; focus returns by token.
- No nested popovers or sheets. A second chooser is a dialog or a one-level menu.
- A menu item that opens another surface ends in a chevron; a checkmark is a choice.
- Destructive actions name the object and consequence; they are never adjacent to a
  primary action without confirmation.
- A control titled "Toggle" toggles; a three-way choice is a menu with a chevron/checked
  items.
- Replacing an interaction deletes its old markup, CSS, test selectors and docs in the
  same change.

## 13. Accessibility and keyboard

- Every icon button has `aria-label`; toggles `aria-pressed`; menus
  `aria-expanded`/`aria-controls`; sheets/dialogs trap focus and restore it; the resizer
  is a separator with keyboard steps.
- Focus ring 2 px `--ring`, offset 2 px; never removed without a replacement.
- Keyboard: `Space` Capture/Stop, `F` Fit, `Esc` close/cancel, `+`/`=`/`-` zoom, `←`/`→`
  pan (Shift: half a screen),
  `Tab` moves focus, `Enter` activates. Shortcuts never fire in a text field, the
  debug/test composer or a dialog.
- Touch: 48 px targets, visible labels, no gesture-only action; TalkBack labels for rows,
  trigger slots, cursors and charts; back closes the top layer.
- Screen reader: charts expose a summary and the focused cursor/measurement; the decoded
  list is a table/list with headings; errors are live regions.
- Reduced motion collapses transitions to 1 ms; no viewport glide.
- Contrast: text ≥ 4.5:1, graphical marks ≥ 3:1; colour is never the only encoding for
  gap/pending/error/armed.
- Orientation change preserves the viewport and focus where possible; sheets reflow.

## 14. Visual system

### 14.1 Surfaces and text

| Token | Use |
| --- | --- |
| `--canvas` | plot background and waveform field |
| `--chrome` | shell, label column, bottom interaction bar |
| `--raise` | dialogs and sheets |
| `--menu` | menus/popovers |
| `--control` / `--control-hover` | inputs and buttons |
| `--line` / `--line-2` | dividers and rules |
| `--ink` / `--ink-2` / `--ink-3` | primary/secondary/caption text |
| `--primary` | actions, focus, selection |
| `--warning` | armed/waiting trigger; overload warning |
| `--alert` / `--alert-wash` | errors, Stop, destructive |
| `--grid` / `--veil` | graticule and segment/record bands |
| `--analog` | analog signal accent, distinct from primary/warning |

- One semantic token contract; no per-theme component override blocks; theme switching
  changes values only. The canvas reads the same palette source as CSS.
- Light and dark are selected pairs, not an automatic flip; each meets contrast.
- Chrome metrics (`--toolbar-h`, `--axis-h`, `--overview-h`, `--status-h`, `--labels-w`,
  `--panel-w`) are shared by CSS and canvas layout.

### 14.2 Signal and role colours

- Digital channels cycle through eight probe-wire colours; the cycle is by channel index,
  not by display order. Analog channels have their own cycle/accent (`--analog` family).
- Channel 0's red is a data colour, never the error red. Errors, Stop and destructive
  actions use `--alert`.
- Decode roles: framing (neutral), address (blue), command (violet), control (green),
  data (teal), check (magenta), handshake (olive), line (ink/pattern), error (red).
  Roles are protocol-independent; a block's lane names its decoder.
- Gaps use a neutral hatch; pending uses a dotted neutral; neither uses a channel colour.
- Armed/waiting uses amber; a configured but inactive condition is neutral.

### 14.3 Type and density

| Role | Size / weight | Use |
| --- | --- | --- |
| Page title | 18 / 600 | sheet/dialog/panel title |
| Section | 14 / 600 | section header |
| Body | 13 / 400 | controls, labels |
| Metadata | 11 / 500 | ticks, captions, chips |
| Eyebrow | 10 / 600 uppercase | group labels |

- Touch density: body 14 px, controls 48 px high, minimum 16 px gutters; desktop density:
  body 12–13 px, controls 28–32 px. Density is a token, not a per-component choice.
- Numbers use tabular figures; no text below 10 px; labels that would collide are omitted.
- Radii: 4 px controls, 8 px containers, 999 px pills. Spacing 4 px scale.
- Exactly one implementation per control class: input, select, segmented control,
  checkbox, toggle, menu, chip.

### 14.4 Motion

- 120 ms enter, 100 ms exit, ease; sheets slide, menus/popovers pop/fade, dialogs fade the
  backdrop. No motion for viewport gestures, waveform draw, hover readout or while the
  canvas is busy.
- Reduced motion sets durations to 1 ms and removes glides.
- The waveform, annotations, ruler and overlays move together in every frame; a panel
  opening does not stretch the old canvas.

## 15. Copy, numbers and i18n

- Locales: `en`, `zh-CN`, `fr`, `ru`; default follows the browser, stored choice wins.
- Every user-visible string, including accessible names/titles, comes from the catalog at
  render time; static HTML carries only a bootstrap fallback with the same key. No
  concatenation; whole sentences with parameters.
- Terms: Capture (not Start), Stop, Interval, Duration, Window, Retention, Record,
  Trigger condition, Cursor, Measurement, Analyzer/Decoder, Bus, Signal, Profile, Link.
- Units: ns/µs/ms/s, Hz/kHz/MHz/GHz, MS/s, V, A, dB, CH. One space between value/unit;
  locale grouping; times at the origin are negative before T.
- Touch copy says "Tap", mouse copy says "Click"; shared copy avoids both. A hint never
  relies on hover alone.
- Decoder-produced names/fields pass through untranslated; surrounding labels localise.
  Annotation row and class names ("RX data", "Address write") are metadata and localize
  through `decoder.<id>.row.<rowId>` / `decoder.<id>.ann.<classId>` (uart, i2c, spi,
  onewire_link, can; others show sigrok's English), in the results list and the lane
  labels. The annotation payload text stays English: the decoder builds it at run time
  with values spliced in, and it must match sigrok/PulseView output and exported files.
- `<html lang>` and the tab title (`app.title`) follow the active locale. The label column,
  the plot (waveforms, annotations, scales) and numeric readouts carry `translate="no"` so
  browser page translation never rewrites data; the empty hint opts back in.
- Every key switch (channel width, Analog, trigger enable/source, capture mode, test mode)
  carries one plain sentence: what it does, when to use it, its effect. Longer detail goes
  in a "?" help tip (`.help-tip`, tooltip on hover/focus/tap), never a panel paragraph.
  No implementation terms ("matcher", "local step", "wave"): say "trigger", "capture",
  "previous capture". Test mode 2 is a "test pattern", never "simulator" (confusable with
  Analog).
- Threshold choices name the logic family they suit (`thresholdOptions.ts`), e.g.
  "1.65 V (3.3 V logic)"; the plain voltage is still what the device receives.
- The Shortcuts dialog lists the keyboard keys and the mouse/touch gestures, following the
  "wheel zooms" setting; the hint bar and the dialog never disagree with the handlers.
- Errors name the operation and keep the diagnostic code in the console prefix.

## 16. Interface review gate

### 16.1 Anti-patterns

Review blockers:

- A second Capture/Stop, or a panel control that starts an acquisition.
- A setting that silently restarts/reconfigures a running acquisition or record.
- A lifecycle state explained only by prose while the control looks unchanged.
- A new top-level command without removing one; a new always-open section without a
  group/collapse; a second editor for a row/plot value.
- A raw colour/size in a component rule; a per-theme component override block.
- A touch action that requires hover, or a target below 48 px.
- Dead markup/CSS/tests/docs for a replaced interaction.
- A hint bar that advertises a gesture the area does not implement, or does not wrap
  at compact widths.
- A label that promises behaviour the code does not implement.
- A panel with two headers, or a mode that hides link/capture/trigger state.
- A console-only failure.

State/commit/persistence/test anti-patterns are in `ARCHITECTURE.md` §10.

### 16.2 Feature admission checklist

1. **Home** — which window class/presenter/panel owns it? Which existing control moves or
   goes away to stay within the budgets?
2. **Profile** — which capability key gates it? What is the disabled reason when absent?
3. **Source of truth** — which field stores it? What is derived? (`ARCHITECTURE.md` §4-5)
4. **Lifecycle** — live/next/view/preference? What does the badge say while running,
   waiting, matched, recording, suspended, lost?
5. **Running state** — restart/retune/stage? Is the restart named? Does it discard data?
6. **Trigger/record** — arm/disarm/retune, record start/pause, Single/Repeat/Loop.
7. **Persistence** — workspace, record, preferences, session only, or none? Migration?
8. **View model/presenter** — which view field/callback? Does the panel stay unable to
   reach App/Device/Store? Does it work in Docked, Sheet and Dialog?
9. **Input parity** — mouse, touch, pen, keyboard; 48 px targets; no hover-only.
10. **Accessibility** — label, role, focus return, back behaviour, screen reader.
11. **Copy** — all locales, whole sentences, terms match §2/§15.
12. **Security/platform** — any new network/file/USB behaviour updates the security
    contract (`ARCHITECTURE.md` §9).
13. **Tests** — behaviour/view-model tests, SimDriver where relevant; typecheck/build.
14. **Docs** — this file and `ARCHITECTURE.md` updated as owners require.

### 16.3 Definition of done

- Interface rules satisfied; engineering checks (`ARCHITECTURE.md` §10) pass.
- Checked at 1400 px (mouse), 900 px (pen/mouse) and 360 px (touch), portrait and
  landscape, dark/light, `en`/`zh-CN`, reduced motion.
- Touch path tested on Android with OTG (or SimDriver until hardware exists); back
  behaviour verified.
- Keyboard and screen reader path exercised; focus returns.
- No new console error/unhandled rejection; CSP has no new violations.
- This document matches the shipped interface.

## 17. Migration (C3)

The current code is the pre-v2 LA interface. Migration is staged; each stage keeps the app
runnable and updates the owning contract first.

| Stage | Work | Owner document |
| --- | --- | --- |
| 0 | Docs split and cross-links; v2 contracts accepted | ARCHITECTURE/DESIGN |
| 1 | `platform/` probes, `LinkSession`, `DeviceProfile`, SimDriver; no model branches | ARCHITECTURE §1-3 |
| 2 | `SignalStore` digital + gaps + float64 positions; old `SampleStore` adapter | ARCHITECTURE §4 |
| 3 | `TriggerPlan` single source; composite state machine; `mayEdit`; one settings transaction | ARCHITECTURE §5 |
| 4 | Shell/presenters: Docked/Sheet/Dialog; bottom action bar; panel registry | DESIGN §3-4, §10 |
| 5 | Analog signals as first-class rows; range vs scale; overload; multi-rate timeline | DESIGN §5-6; ARCHITECTURE §4 |
| 6 | Mixed TriggerPlan P1; analog trigger UI; Loop D/V under the new model | ARCHITECTURE §5.1; DESIGN §8 |
| 7 | Recording/OPFS; export/recovery; retention vs record UI | ARCHITECTURE §4.3, §7; DESIGN §9 |
| 8 | Touch grammar, magnifier, long-press/back, 48 px audit | DESIGN §3, §7, §13 |
| 9 | First-party decode default, Pyodide optional; worker protocol | ARCHITECTURE §8 |
| 10 | PWA/offline, CSP/security, T0/T1/T2, Android/device matrix | ARCHITECTURE §9-10 |
| 11 | Remove Assistant entry; keep host interface debug/test only | ARCHITECTURE §6; DESIGN §10 |
| 12 | Delete replaced generations (CSS, selectors, docs, tests) and finish the migration | both |

The 23-item current-interface debt list is superseded by this table; keep the item-level
detail in `src/ui/NOTES.md` and the issue tracker, not in this contract. A stage is done
only when its contract tests and the UI/migration checklist pass.

M0 also carries the current-interface debt that the new contracts expose: one trigger
condition store; one `commitSettings`; `AcquisitionState` + `mayEdit`; explicit cursor
add and session-only label; one viewport owner; one panel render/update path; one bus
editor; one semantic token layer; behavioural tests instead of source-text suites; delete
the replaced channel-dialog generation; move panel logic out of `app.ts`; one persistence
registry. These are prerequisites for stages 3–4, not separate product features.
