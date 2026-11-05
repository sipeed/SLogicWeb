# logicweb interface design

This document is the interface contract for the browser application. Its shape follows
HSync's `DESIGN.md`; the rules are logicweb's. It owns what the user sees and does:
layout, controls, interaction, user-visible lifecycle, visual tokens, copy,
accessibility and the interface review gate.

**Document map.** `docs/ARCHITECTURE.md` owns how the system is built and what the engine
guarantees: module boundaries, trigger/session semantics, state ownership, the settings
transaction, acquisition lifecycle and capability, the panel/view-model contract,
persistence and verification. `src/ui/NOTES.md` is historical measurement and
implementation evidence. A fact is normative in exactly one file; this file links to
`ARCHITECTURE.md` for engine and state facts, and `ARCHITECTURE.md` links here for
interface facts. If they conflict, the owning file wins: engine/state in
`ARCHITECTURE.md`, interface here. When the interface changes, update this file in the
same change.

The current code does not yet satisfy every rule in this file (see §16). The rules are
the target; the deviation list is the migration queue.

## 1. Principles

- **One primary action.** The top bar's Capture/Stop button is the only control that
  starts or stops an acquisition. Panels configure; they never acquire.
- **One setting, one home.** A value has one editor. Elsewhere it may be shown read-only,
  or changed by direct manipulation of the same value (dragging a trigger line), but a
  second editor is a bug.
- **Every control declares when it applies.** Each editable value is exactly one of
  *live* (affects the running acquisition now), *next* (affects the next acquisition),
  *view* (display only) or *workspace* (persisted preference). The UI must show which,
  especially while a capture runs.
- **Never silently reconfigure a running acquisition.** A change either applies live, is
  staged for the next acquisition, or is a named restart that the interface announces.
  No control may stop or restart a capture as an unexplained side effect.
- **State, not prose.** A lifecycle state is a chip, a badge, a disabled control or a
  short status line. A paragraph is not a state machine. Long explanations belong in
  tooltips and documentation.
- **One interaction mechanism per job.** Choose among direct manipulation, row slot,
  popover, dialog, menu and panel; do not expose the same job through three of them.
- **One source of truth.** Derived values are computed, never stored beside their
  source. A view model is a snapshot; a panel never reads the device, store or App
  directly.
- **One time origin.** When a capture has a trigger, T is 0 s and pre-trigger time is
  negative. Without a trigger, the origin is the sweep start. Every axis, cursor,
  readout and annotation uses that origin.
- **Colour has one job.** Channel colours identify channels. Primary violet marks
  actions, focus and selection. Amber marks an armed trigger. Red marks errors and
  Stop. No colour is decorative.
- **Flat, tokenised, measured.** Surfaces are flat; hierarchy comes from fill, weight
  and spacing. Components use tokens from §13, never raw colours or ad-hoc sizes.
- **Failures are visible.** Every asynchronous action ends in a visible status or an
  error in the status bar. No silent `catch`, no console-only failure.
- **Tests describe behaviour.** UI tests assert rendered state, view models and
  transitions. A test that greps a source file freezes today's structure and is not an
  acceptable test of a UI behaviour.

The state ownership, settings transaction, acquisition lifecycle, panel/view-model,
persistence and verification rules behind these principles are normative in
`docs/ARCHITECTURE.md` (`## UI runtime contract`, `## Verification`). This file owns how
they look and how the user experiences them.

## 2. Vocabulary

| Term | Meaning |
| --- | --- |
| **Acquisition** | One Capture → Stop run. It owns a session, one or more sweeps and the view policy. |
| **Sweep** | One device RUN → STOP. Single has one; Repeat has one per Interval; Loop has one unbounded sweep. |
| **Retention** | The sample range a sweep keeps: the Duration, or the Loop window. |
| **Viewport** | The visible sample range. Its policy is FollowLive, Fixed or TriggerLocked. |
| **Cursor** | A user-placed time marker used for readouts and distance/edge measurements. |
| **Bus** | A parallel view built from channel bits (including an ADC group). Not a device channel. |
| **Analyzer** | A protocol decoder attached to channels. |
| **Workspace** | Persisted user state in local storage (channels, settings, buses, analyzers); theme, locale and panel width are preferences in a separate tier. |
| **Capture file** | A saved `.lwcap` or imported `.sr`; data plus its channel names, not the workspace. |
| **T** | The trigger sample. T = 0 s when present; otherwise the sweep start is 0 s. |

## 3. Layout

```
┌ top bar ─────────────────────────────────────────────────────────────────────┐
│ [Device] [Capture/Stop] │ [Open] [Save] │ [Fit] [Fullscreen] │ [Panel] [Settings] │
├───────────────────────────────────────────────┬──────────────────────────────┤
│ overview strip (whole capture / loop window)  │ side panel                    │
├ label column ┬ plot: ruler + rows ────────────┤ one of:                       │
│ D0  ◇ trigger│ waveform / analog / bus / lanes│   Device                      │
│ D1  ◇ trigger│ annotations / cursors / T       │   Analyzers                   │
│ …            │                                 │   Assistant                   │
├──────────────┴─────────────────────────────────┴──────────────────────────────┤
│ status bar: state · samples · duration · view · cursor        error / progress │
└───────────────────────────────────────────────────────────────────────────────┘
```

| Region | Owns | Must not |
| --- | --- | --- |
| Top bar | device connection, Capture/Stop, file I/O, view fit/fullscreen, panel and settings entry | acquisition settings, trigger conditions, measurements |
| Label column | channel identity, trigger slot, row order/height, analyzer lanes, bus row entry | global settings |
| Plot | overview, ruler, waveforms, analog scope, annotations, cursors, T marker, viewport gestures | acquisition configuration |
| Side panel | the one active panel's settings and readouts | the primary Capture action |
| Status bar | acquisition state, counts, active readout, errors, progress | controls that change acquisition settings |

**Dimensions** (CSS px; chrome values are theme-independent, from `style.css` and
`metrics.ts`): top bar 57 content height (auto if labels wrap); axis 30; overview 56;
status 40; label column 128 (104 below 760 px); channel strip 5; side panel 296 default,
240–560 by drag; resizer 6 hit width.

**Budgets.** These are merge gates, not suggestions:

- Top bar: at most **8** top-level controls. A new command must replace one, move into a
  menu, or live inside a panel.
- Side panel: at most **4** sections per panel. Group or collapse before adding a fifth.
- Channel row: at most **2** inline controls (the trigger slot and the row entry). Every
  other per-channel action belongs in the editor popover.
- One overlay open at a time (menu, popover, dialog or drawer).
- One active side panel at a time.

**Responsive.** Three breakpoints, each with a named rule:

| Width | Panel | Label column | Toolbar |
| --- | --- | --- | --- |
| ≥ 1000 px | Docked column, 296 px default, 240–560 by drag; plot keeps at least 480 px | 128 px | Icon + label, one row |
| 760–999 px | Docked column, at least 240 px; persisted width clamped so the plot keeps 480 px | 128 px | Icon + label, one row |
| < 760 px | Full-height drawer over the plot, with a scrim and an explicit Close; no resizer; width min(296, viewport − 48) | 104 px | Icon only, one row at 360 px |

The page never scrolls horizontally. Toolbar labels are a workspace preference; below
400 px only icons remain, and the compact rules must win by construction, not by a
specificity accident. A persisted width may never exceed viewport minus the minimum for
the other pane.

**Global state stays visible.** Acquisition and trigger state are not owned by a panel.
With the side panel closed, the top bar's capture summary and the status bar still show
whether a capture runs, its mode/duration and the trigger state. A panel mode must never
be the only place a user can see that a trigger is armed or waiting.

## 4. Top bar

Target control order (left to right):

| Control | Appearance | Behaviour |
| --- | --- | --- |
| Device | Icon + short label; a dot/state tint when connected | Shows the connected device name and opens the device menu: connect/reconnect, permission state, disconnect. Disabled when WebUSB is unavailable. |
| Capture / Stop | Primary split button: Capture/Stop plus a chevron; the label or adjacent summary names the mode and duration (`Single · 10 ms`, `Loop · 1.0 s`) | The only start/stop action. The chevron chooses Single / Repeat / Loop; the panel keeps the mode's duration/interval/window details and shows the chosen mode read-only. While stopping the button is disabled, except that a pending automatic arm may be cancelled. It is disabled with the same `canRun` guard for click, Space, assistant and debug; connect never happens through it. |
| Open | Icon + label | Opens `.sr`/`.lwcap`; stops a running acquisition first, after confirmation if data would be lost. |
| Save | Icon + label | Saves the displayed capture as `.lwcap`. Disabled without samples. |
| Fit | Icon + label | Fits the viewport to the current retention window; `F` does the same. Double-clicking the plot adds a cursor, not a fit. |
| Fullscreen | Toggle icon | View-only. `aria-pressed` reflects the state. |
| Panel | Toggle icon; opens the last active tab | Shows or hides the side panel. It does not choose a tab by itself. |
| Settings | Icon | Opens the settings menu/page: language, theme, toolbar labels, shortcuts, diagnostics. |

Rules:

- The transport has exactly two actions, **Capture** and **Stop**, plus a non-interactive
  Stopping state. Every activation path (click, `Space`, assistant, debug) goes through
  the same `canRun` guard, so the input method never changes the effect. Connect is the
  Device control's job only.
- The primary action must name what it will run. Hiding the side panel must not hide the
  mode or duration; the split button's summary and the Start tooltip carry them.
- A preference (language, theme, toolbar density, shortcuts) is **not** a top-level
  command. It lives in Settings. A top-level toggle is allowed only for a view action
  with an on/off state (fullscreen, panel).
- The Assistant is a side-panel tab, not a second toolbar button. The panel switcher is
  the only way to choose a tab.
- The top bar may show read-only summaries in button labels (device name, capture mode,
  trigger summary) but never becomes an acquisition-settings editor.
- Disabled commands keep their place and explain themselves in a tooltip; they do not
  disappear. The control that is unavailable on a phone (fullscreen) is disabled, not
  hidden.
- A control titled "Toggle" must toggle. A three-way or list choice is a menu and says
  so (chevron, checked items).

Current deviation: the bar has 11 commands (Assistant, Language and Theme are top-level;
the sidebar menu duplicates the assistant entry). See §16.

## 5. Label column and channel rows

A digital row, top to bottom, is:

1. A 5 px channel-colour strip.
2. The channel tag (`D0`), the editable name, and the trigger slot at the right.
3. Zero or more analyzer lanes, each named after its analyzer.
4. Bus rows and ADC rows as separate rows above the digital channels, with the same
   label structure and their own entry control.

Interactions:

| Gesture | Result |
| --- | --- |
| Click the trigger slot | Opens the condition menu for that channel: None, Rising, Falling, Any edge, High, Low. The current mode is checked. |
| Double-click the name | Opens the name editor for that channel: the name field and a reset-to-default action. Enter commits; Esc or an outside click discards the draft. |
| Drag the row's bottom edge | Sets that row's height in whole pixels, bounded. Double-click the edge restores the default. |
| Drag a row by its label | Reorders display rows; capture channel indices do not change. |
| Click a bus row's entry | Opens the bus editor. An ADC row is configured by its Analog button in Device; its scope controls are on the row. |
| Click an analyzer lane's remove button | Detaches that analyzer. |

Rules:

- The **trigger slot is the only editor for a digital condition**. The Global trigger
  panel may list and remove conditions; it must not offer a second mode editor.
- The ADC row's trigger button is the only editor for an analog condition (slope and
  level). The draggable trigger line on the plot edits the same value; it is an
  alternate input, not a second home.
- Configured conditions are neutral; the selected, enabled source is the only bright
  one. Switching source never makes the other family look armed.
- Name and colour are channel identity. Colour is not editable in the row; a custom
  colour picker, if restored, belongs in the channel editor as an explicit identity
  action.
- A row's inline controls never include destructive actions. Destructive actions live
  in the editor with a labelled button.
- **One row anatomy across the label/plot seam.** A row is either a full-bleed band with
  one separator token, or a card inset on both sides; it is never a card on the label
  side and a band on the plot side. Row hover, selection, trigger-armed state and channel
  colour are painted from the same state on both halves. Separator thickness/colour and
  row pitch come from one shared token read by CSS and canvas.

## 6. Plot, overview and time

### 6.1 Overview strip

- Shows the whole capture, or the fixed Loop data window D while a Loop runs. It never
  follows the retained length in Loop; its scale, ticks and viewport frame are stable.
- While locked, its true start is T − f·L, so the 64-sample front-drop residue cannot
  shift it; in free run it shows the newest window. The density rolls inside it.
- A manual pan/zoom does not pause the roll: the chosen viewport keeps its coordinates in
  D, and each period-aligned roll replaces the samples under it, so a sub-window such as
  30+5 µs stays at 30+5 µs while its waveform updates in place.
- Click centres the viewport; drag pans; wheel zooms. A gesture sets the view policy to
  Fixed (except under a trigger lock, where it moves only V inside D).
- The viewport is drawn as a 1.5 px frame; the trigger origin and the current view are
  legible without colour alone.

### 6.2 Ruler and time

- The ruler is sticky. Major ticks carry values; minor ticks do not. The time unit is
  shown once, at the origin or the last tick.
- With a trigger, the origin is T and the label says so; pre-trigger time is negative.
- Without a trigger, the origin is the sweep start.
- During a held Repeat front, the origin is the held wave's T, not the running wave's
  trigger. All readouts use the same origin; the single accessor and its held-front test
  are specified in `docs/ARCHITECTURE.md` (`UI runtime contract` → State ownership).
- The trigger line is dashed and labelled with its time; T is a distinct marker. They
  are not the same object and must not be confused.
- Zoom is bounded by the retention window; panning cannot leave the retention window.
  A Fixed viewport that no longer fits falls back to the mode default, never to a
  silent Fit.

### 6.3 Pointer grammar

The plot, the time axis and the overview strip share one grammar; only the object under
the pointer changes what a gesture acts on.

| Input | Plot | Time axis | Overview | Keyboard twin |
| --- | --- | --- | --- | --- |
| Drag | Pan the viewport; an edge drag starts a measurement (future) | Pan | Pan the viewport frame; a click centres | Arrow keys pan |
| Plain wheel | Scroll the channel rows when they overflow; no view change otherwise | Scroll rows | No view change | — |
| Ctrl/⌘ + wheel, pinch | Zoom around the pointer | Zoom around the pointer | Zoom around the pointer | `+` / `-` |
| Shift + wheel | Pan | Pan | Pan | Arrow keys |
| Double-click | Add a cursor | Reset the analog scope when over a ruler/handle | No action | — |
| Esc | Cancel the active gesture | Cancel the active gesture | Cancel the active gesture | Esc |

Rules:

- The same gesture means the same thing on all three surfaces, or the target visibly
  explains why not. A plain wheel that does nothing must not silently scroll the page.
- Every pointer gesture has a keyboard twin where the action is not inherently spatial
  (zoom, pan, fit, add cursor). The Shortcuts dialog is generated from the same table
  that dispatches the keys.
- Double-click has exactly one meaning per object, stated in that object's tooltip:
  plot = add cursor; analog ruler/trigger handle = reset the scope scale. It never means
  Fit.
- Gestures never start, stop or reconfigure an acquisition.

### 6.4 Viewport policies

| Policy | When | Behaviour |
| --- | --- | --- |
| FollowLive | Default at session start; no user gesture | The right edge follows the newest sample. |
| Fixed | After a pan/zoom | The interval is stored relative to the display origin and survives Repeat waves while it fits the retention. |
| TriggerLocked | Loop with an armed trigger after a match | D is fixed; V is stored as offsets from T; Fit resets V to D. Zoom/pan move V only. A digital Loop lock is one-shot and releases when T leaves retention; an analog Loop detector can re-lock when edges return. |

Rules:

- The engine owns one viewport state; a gesture never writes a second viewport model.
  The ownership and transition tests are in `docs/ARCHITECTURE.md` (`UI runtime contract`
  → Viewport and display).
- A view gesture never starts, stops or reconfigures an acquisition.
- A trigger lock never turns a viewport gesture into a re-arm or a data change.
- Fit is explicit: toolbar, `F`, or the mode's documented default. No automatic Fit
  except on a new capture/file, and the status says so.
- The held-Repeat, trigger-locked and released cases are visible to the user as separate
  states; their transition rows and tests are architectural, their appearance is here.

### 6.5 Cursors and measurements

- The Measurements section has an explicit **Add cursor** control. Double-clicking the
  plot is an accelerator for the same command, never the only way to create one.
- Dragging a cursor moves it; the panel lists cursors and their times; removal is a
  per-row action. There is no global "clear all" on `Esc`.
- A cursor has a label and a colour; the active cursor is the one whose readout appears
  in the status bar. Only one cursor is active.
- Distance and edge rows reference named cursors. Missing references are shown as empty
  selects, not silently dropped.
- Measurements are display/session state. They are cleared by a new capture only with a
  visible notice, or kept when the capture is replaced by one that still makes sense;
  the chosen rule is stated in the panel and the spec. `Esc` cancels the active gesture
  or clears the selection; it never deletes measurements.
- Cursors are session state and are not restored on reload; the section header says
  "Session only". If a capture format later carries measurements, the persistence tiers
  in `docs/ARCHITECTURE.md` change first.

### 6.6 Analog scope rows

- ADC rows share one vertical coordinate system across trace, graticule, voltage ruler,
  0 V line and trigger line.
- V/div and zero position are view settings; they persist with the workspace or bus
  view, not with the capture file unless the file format says so.
- Dragging the trigger line edits the analog trigger level through the same value as
  the ADC editor; it does not create a second trigger.
- Analog test-mode patterns are not a supported voltage source; the UI says so where
  the test mode is selected.

## 7. Acquisition settings

### 7.1 Modes

| Mode | Sweeps | Retention | Default viewport | Trigger |
| --- | --- | --- | --- | --- |
| Single | One | Duration, or Unlimited until Stop | FollowLive, then fixed at the end | One-shot; a waiting matcher may wait indefinitely. |
| Repeat | One per Interval | One Duration per wave | FollowLive per wave; Fixed survives waves while it fits | One sweep's budget per wave; a miss reports and the next Interval retries. |
| Loop | One unbounded | Loop window L (sample count), rolling | FollowLive; TriggerLocked when armed and matched | One-shot digital lock, or live analog local roll. |

The sweep, retention, budget and loop-window semantics behind this table are normative in
`docs/ARCHITECTURE.md` (`src/device` → software trigger and session semantics). This file
owns how each mode is presented and which controls remain available.

### 7.2 Lifecycle of every setting

The following table is the interface policy: which controls look and behave live, next,
view or workspace. The underlying `mayEdit(feature, state)` table is normative in
`docs/ARCHITECTURE.md` (`UI runtime contract` → Acquisition lifecycle). Keep the two in
step; the capability table decides, this table presents.

| Setting | While idle | While running |
| --- | --- | --- |
| Capture mode | Editable, next | Locked |
| Channel width | Editable, next | Editable, **next** (running store keeps its width) |
| Enabled channels | Editable, next | Editable, **next** |
| Sample rate | Editable, next | Editable, **next** |
| Threshold | Editable, next | Editable, **next** |
| Duration / Unlimited | Editable, next | **Live** in Loop; next in Single/Repeat |
| Repeat interval | Editable | Editable, next wave |
| Loop window | Editable | **Live** (re-clamps V) |
| Test mode | Editable | Locked; diagnostic only |
| Trigger enable mask | Editable | Live retune while waiting; off after match = release in place; on in a free-run capture = named restart |
| Trigger source | Editable | Live retune while waiting; pending after match |
| Digital conditions | Editable | Live retune while waiting; pending after match |
| Analog condition | Editable | Live retune while waiting; Loop display detector live after match |
| Pre-trigger % | Editable | Locked (sizes the ring) |
| Cursors / measurements | Editable | Editable, display only |
| Bus views / analog scale | Editable | Editable, display only |
| Panel, theme, language, labels | Editable | Editable, no acquisition effect |

Rules:

- A control marked **next** must show a persistent "Next capture" badge while a capture
  runs. The section header may carry the badge instead of every control, but the
  control's tooltip must state it.
- A control marked **live** must show a "Live" badge only while running; it must not
  silently change the displayed data's meaning without a status line.
- A control that cannot apply to the current run and has no useful next-run meaning is
  disabled, with a tooltip. Controls are not hidden.
- A mode change while running is Locked. Do not offer "will apply after stop" for a
  setting whose next use is ambiguous.
- An automatic restart is allowed only as a named transition: the trigger section and
  the status bar must say "Restarting to arm the matcher" (or equivalent), and the
  displayed capture must not be discarded silently. A restart from an unrelated control
  is forbidden.
- Duration edits in Loop apply to the retention window on the next frame; rate and
  width edits never reinterpret an existing store. If the panel cannot express that in
  one chip, it must disable the edit until the capture stops.

### 7.3 State presentation

The acquisition states (`idle`, `arming`, `waiting`, `running`, `stopping`, `restarting`,
`retrying`, `lost`) and the single `mayEdit(feature, state)` capability table are
normative in `docs/ARCHITECTURE.md` (`UI runtime contract` → Acquisition lifecycle). The
interface does not invent its own predicates or booleans; it renders the resulting state
as:

- a state chip in the Device panel and the status bar;
- a Live or Next badge on the affected control (or its section header);
- a disabled control with the typed reason in its tooltip when the capability table
  refuses the edit;
- a named "Restarting…" state when a configuration restart is in flight.

A refused edit shows the same reason everywhere, including the assistant and the
debug/test surface. The UI never restarts a capture as an unmentioned side effect.

### 7.4 Progress and empty states

- Without a capture, the plot shows one short empty-state line: open a file or connect
  a device. The side panel may show the last settings and the device state.
- While running, the top bar says Stop, the panel shows a state chip and a progress
  line, and the status bar shows the live counts. The same state is not repeated as a
  paragraph in three places.
- On completion, the status bar reports samples, duration and trigger state once. The
  panel's status chip is the short form.

## 8. Trigger

The matcher, budgets, pre-trigger ring and Loop data-window semantics are normative in
`docs/ARCHITECTURE.md` (`src/device`). This section owns the editor model, the visible
states and the copy.

### 8.1 Model

```
per-channel conditions (digital) ─┐
                                  ├─ AND ─> matcher (one sample, all conditions) ─> T
one ADC crossing (analog) ────────┘
enable mask ──────────────────────┘   (off = free run, conditions retained but neutral)
pre-trigger % ───────────────────────> ring size / T's position in D
```

- Digital conditions are per-channel modes from the trigger slot. All configured
  conditions are ANDed; the exact matcher semantics are normative in
  `docs/ARCHITECTURE.md` (`src/device`). Missing mode = don't care.
- Analog uses exactly one ADC group crossing (rising or falling, with a level). It is
  exclusive with digital conditions: the level must fix one time base. Choosing an
  analog trigger switches the source to Analog; choosing a digital condition switches it
  back.
- The enable mask is an arming decision, not a condition. Off leaves every condition
  stored and shows them neutral. On arms the selected source if it has at least one
  effective condition. Configuring or removing a condition never changes the mask; if
  the UI wants to help the user arm, it offers an explicit "Arm" action, it does not
  flip the switch behind their back.
- Pre-trigger is the percentage of the retention window before T. It sizes the ring in
  Single/Repeat and fixes T's position in D in Loop. It is locked while a capture runs.
- **One owner per property.** A channel row owns that channel's digital condition; an
  ADC row owns its slope and level; the Global trigger section owns the mask, source,
  pre-trigger and a read-only summary. The plot's drag, the assistant and the debug
  surface dispatch the same command to the owner; they never write a parallel model.

### 8.2 Condition glyphs and states

| Mode | Glyph | Meaning |
| --- | --- | --- |
| don't care | short dash | no condition |
| rising | rising edge | previous 0, current 1 |
| falling | falling edge | previous 1, current 0 |
| edge | both edges | any transition |
| high | high level | current 1 |
| low | low level | current 0 |

States:

- **Configured** (mask off or source inactive): neutral ink, visible.
- **Armed** (mask on, source selected): warning colour, one family only.
- **Pending** (matched, edit staged for next acquisition): neutral + "Next" badge.
- **Live-retuned** (waiting, edit applied): a brief "Retuned" note, not a restart.

### 8.3 Lifecycle

| State | Editing a condition | Turning the mask off | Turning it on |
| --- | --- | --- | --- |
| Idle / completed | Next acquisition | Disarms | Arms next start |
| Running, waiting | Live retune; no restart | Live: restarts free-running (named) | Already armed |
| Running, matched (one-shot) | Pending for next acquisition | Release in place, tear down detector | Named restart to arm |
| Loop, analog locked | Live retune of the page detector; lock survives while edges remain | Release; detector torn down | Named restart |
| Loop, released | Pending / next acquisition | Free run | Named restart to re-arm |
| Stopping | Locked | Locked | Locked |

Additional rules:

- The Loop data-window (D), viewport (V), pre-trigger cap and early-match accounting are
  engine semantics owned by `docs/ARCHITECTURE.md` (`src/device`); the rules below are
  their visible consequences.
- A Loop's two windows are distinct: **D** is the data window (fixed span L, T at the
  pre-trigger fraction); **V** is the user's viewport (offsets from T). The panel and
  the overview must use D's scale while locked. A gesture moves V only.
- The digital Loop lock is one-shot. The UI must not imply it can re-lock; the status
  says "released" and how to re-arm.
- The analog Loop display detector is live after the match. Its edits are not "pending";
  the chip says "live detector".
- The pre-trigger buffer cap is a hard constraint: the panel says "up to" and never
  promises more history than the ring can hold.
- Early match: the total budget is preserved and the post-trigger span may be longer
  than the requested split. The note says "up to" rather than hiding the case.

### 8.4 Trigger UI

- The Global trigger section header carries the enable toggle and a state chip
  (`Off`, `Armed · waiting`, `Triggered`, `Released`, `Not found`).
- The source control is a two-option segmented control (Digital / Analog), disabled when
  the device has no analog groups. The condition list is a read-only preview with a
  remove shortcut; clicking a row focuses the owning channel/ADC row.
- The pre-trigger control shows a percentage and the resulting time; the cap note is a
  tooltip plus a one-line warning only when the cap binds.
- The panel never prints a paragraph explaining a state that the chip already carries.

## 9. Side panel

One panel is visible at a time. Target tabs: **Device**, **Analyzers**, **Assistant**.
The panel switcher (top bar or tab strip) is the only way to change tabs. The panel is
resizable by its left edge; width is persisted; clicking the active tab's toggle closes
the panel.

**Panel contract.** `PanelId`, one host per panel, the `render(view)`/`update(view)`
contract and the overlay stack are normative in `docs/ARCHITECTURE.md`
(`UI runtime contract` → Panel and view-model contract). This section owns the tabs,
labels, section order, collapse defaults and appearance. Adding a panel means adding one
registry entry there and one panel module here, not editing every toolbar handler.

### 9.1 Device

Section order (target; at most four sections):

1. **Acquisition** — the current mode as a read-only summary (the Capture split menu is
   its editor), channel width and enable chips, sample rate, threshold, duration /
   interval / loop window, plus the one-line consequence note.
2. **Trigger** — enable, source, condition preview, pre-trigger, state chip.
3. **Measurements** — cursors, distance rows, edge rows. Collapsed by default when there
   are no measurements.
4. **Advanced** — test mode, USB console, loop instrumentation. Collapsed by default;
   not part of the normal workflow.

Rules: sections are collapsible and remember their state; the panel opens with
Acquisition and Trigger expanded and Measurements/Advanced collapsed; a section with an
active error or pending state may open itself once, with a visible reason.

### 9.2 Analyzers

- Attached analyzers with status, re-decode and remove.
- Add an analyzer: decoder picker, channels, options, validation errors in place.
- Bus views: attached buses, edit/remove, add. A bus is a display construct; it does
  not change capture channels or trigger conditions (except an ADC group's analog
  marker).
- **One bus editor.** `BusPanel` owns every bus property: wiring, clock, encoding,
  style, height, hide-sources. The left row shows status and at most one
  direct-manipulation mirror (the analog height or trigger level) that commits through
  the same update path. Creating an analog bus funnels through the Device panel's Analog
  control; the bus editor does not create a second one.
- Opening the bus editor selects the Analyzers panel explicitly; it never switches the
  panel as a hidden side effect of clicking a row. If switching is necessary, the UI
  says so (the tab changes, and the editor has focus).
- Decoder/bus operations are analysis-only: they never start/stop a capture and never
  change retention.

### 9.3 Assistant

- The assistant is a tab with its own scroll and input. It is mounted once and is not
  re-rendered by capture updates.
- It can read the app state through the documented host interface; it must not mutate
  state except through the same commands a user has (set settings, start/stop, etc.).
- One entry point. Remove the duplicate toolbar button when the tab lands.

### 9.4 Panel rules

- Each panel has exactly one header that names its scope (`Device, capture and trigger`,
  `Analyzers`, `Assistant`). A panel never renders two headers or another panel's
  header.
- No primary Capture action in the panel.
- No second editor for a value whose home is a row or the plot.
- No nested scrolling regions unless the section itself is the scroll container.
- Long notes are one sentence; details go to tooltips or the docs.
- Error text is red and actionable; it does not replace the status bar's error.
- A panel mode's title and contents agree. If a panel holds measurement or developer
  tools, its name says so; if those tools are production features, they do not appear
  only in one sidebar mode.

## 10. Menus, popovers and dialogs

| Surface | Use | Rules |
| --- | --- | --- |
| Menu | Choose one of a short list (device, panel, settings, language, theme) | Anchored to its button; one level; Esc/outside closes; focus returns to the anchor on Esc/pick. |
| Popover | Small anchored editor for one row (channel trigger/name, ADC trigger) | No backdrop; one at a time; Enter commits, Esc cancels, outside commits or closes per the field's rule; focus returns to the row. |
| Dialog | Complex or destructive edits (shortcuts, confirmations, future channel/colour editor) | Backdrop; focus trap; Esc/backdrop closes; title names the object; primary action is explicit. |
| Inline section | A value that belongs to a panel and applies immediately or next | No overlay; must obey the lifecycle badge rules. |

Global rules:

- One overlay at a time. The overlay stack, mutual exclusion and focus-return token are
  owned by `docs/ARCHITECTURE.md` (`UI runtime contract` → Panel and view-model
  contract); the interface rules below are what the user experiences.
- No nested popovers. A popover that needs a second chooser opens a dialog or a
  one-level menu inside itself.
- A menu item that opens another surface ends in a chevron; a checkmark means a choice,
  not navigation.
- Focus never gets lost when an overlay closes. Destructive actions name their object
  and their consequence.
- Tooltips are one sentence; they never carry the only copy of a critical instruction.
- When an interaction is replaced, its old markup, CSS, test selectors, docs and comments
  are deleted in the same change. A dead selector must fail the suite, not be required
  by it.

**One primitive per job.** Use one menu/popover primitive with `role="menu"`, roving
tabindex, Arrow/Escape/Enter, and `menuitemradio` + `aria-checked` for exclusive choices.
Use one selection contract: `aria-pressed` for toggles, `aria-checked` for exclusive
choices, never a visual-only `.on`/`.selected` class. Use one commit model:

| Surface | Commit |
| --- | --- |
| Command and single-value choice | Apply immediately; the control shows the new value. |
| Multi-field editor (bus, future channel settings) | Explicit Apply and Cancel; Cancel restores the opening draft. |
| Text field in a popover | Enter commits; Esc/outside discards (or the field documents "commits on blur"). |

`aria-haspopup` matches the real surface. Focus returns on close. Escape closes only the
topmost layer. The keyboard map is documented in this file and in the Shortcuts dialog.

## 11. Status bar, errors and progress

The bar has three fixed zones and never wraps; a long value truncates with a tooltip and
its full text in the title. Its height is a frozen token (`--status-h`) that relayout
reads.

| Zone | Contents |
| --- | --- |
| Left | Acquisition state, trigger state, sample count, duration, view span, active cursor time. Each value appears once; do not repeat what the capture label already says. |
| Centre | Viewport controls: zoom out, time/div (fixed width, tabular), zoom in, fit. Until they land, the zone is reserved; the status bar never fills it with duplicated statistics. |
| Right | A fixed-width notice/error slot, save/import progress, or the too-slow-port warning. It does not grow the bar. |

- The status bar is the single place where a fatal error is guaranteed to appear. A
  panel may add context; it must not be the only surface.
- Every asynchronous action has a busy state and a terminal state. A progress bar is
  cancellable unless the operation cannot be interrupted; if it cannot, say so.
- Errors name the operation and keep the diagnostic code in the console prefix; the
  user-facing text is localised. No silent catch blocks.
- The status bar never grows into a log. Long diagnostics go to the Advanced console or
  the docs.

## 12. Keyboard and accessibility

- Every action reachable by pointer is reachable by keyboard, except direct-manipulation
  gestures that have an explicit alternative (Fit, cursor add/remove, trigger level
  fields).
- Icon buttons have `aria-label`; toggles have `aria-pressed`; menus have
  `aria-expanded`/`aria-controls`; dialogs trap focus and restore it; the panel resizer
  is a separator with keyboard steps.
- Focus ring: 2 px `--ring`, offset 2 px. Never remove it without a replacement.
- Current global shortcuts: `Space` starts/stops the capture, `F` fits the viewport, and
  `Esc` closes the topmost overlay or, with none open, clears the cursor selection.
  Shortcuts never fire while a text field, the assistant composer, or a dialog is
  focused.
- Shortcut suppression is one semantic `isEditableTarget(event)` helper
  (`input, select, textarea, [contenteditable]`, open dialogs, and overlay roots
  registered in the overlay stack), not a growing DOM-class denylist. A new overlay
  registers once; it does not require editing the keyboard handler.
- Arrow keys move within a menu/segmented control; Home/End go to the ends; Enter picks.
- Reduced motion: transitions collapse to 1 ms; no viewport glide.
- Hit targets: at least 20×16 for a row slot, 24×24 for an icon button, 32×32 for a
  toolbar control. If a visual is smaller, its hit area is larger.

## 13. Visual system

### 13.1 Surfaces and text

Canonical semantic tokens (dark / light come from `style.css`):

| Token | Use |
| --- | --- |
| `--background` | app ground, canvas surround |
| `--card` | side-panel sections, raised groups |
| `--popover` | menus and popovers |
| `--secondary` | inset controls, secondary buttons |
| `--muted` | hover/quiet fill |
| `--muted-foreground` | secondary text |
| `--foreground` | primary text |
| `--border` / `--input` | dividers and control borders |
| `--primary` | primary action, focus, selected option |
| `--warning` | armed trigger, waiting state |
| `--destructive` | Stop, errors, disconnect |
| `--ring` | focus ring |
| `--radius` | control radius |

Chrome metrics are theme-independent: `--toolbar-h`, `--axis-h`, `--overview-h`,
`--status-h`, `--labels-w`, `--strip-w`, `--panel-w`. Legacy names (`--bg00`…`--text50`)
remain aliases for the canvas and older rules; new code uses the semantic names. Do not
add a third naming layer.

Rules:

- One token contract, one source per value. The theme switch changes token values only;
  component rules do not have per-theme override blocks. A component that needs a
  different surface uses a semantic token, not a `:is(html[data-theme=…])` copy.
- The canvas reads the same token source as CSS (a generated TS module or a single
  exported palette), not a hand-copied hex table. A test asserts the copies agree.
- A raw colour, radius, font size or spacing value in a component rule is a review
  blocker; dynamic geometry/colour from data may use inline styles.
- `--labels-w` and the canvas's row geometry come from one shared metric; a TS constant
  and a CSS value that disagree is a bug, not a tuning knob.
- Theme modes are exactly `light`, `dark`, `system`; `system` is the default. The
  pre-paint inline script and the runtime resolver share one implementation or are
  generated from it, and a test asserts first paint equals the resolved theme.

### 13.2 Colour roles

| Role | Colour | Never |
| --- | --- | --- |
| Channel identity | `CHANNEL_COLORS` cycle, one per channel, with per-theme trace/wash/label variants | status or error |
| Action / focus / selection | `--primary` violet only | data, channel identity, or "armed" |
| Armed trigger / waiting | `--warning` amber, reserved | generic highlights |
| Stop / error / disconnect | `--destructive` red, reserved | channel identity |
| Analog group | a dedicated `--analog` blue token | digital trigger state |

- Channel 0's red is a data colour, not the error red; they must be visibly distinct and
  never share a token.
- A triggered or waiting state is not "primary"; it uses the warning token or a neutral
  state chip. Primary is for actions and selection only.
- Disabled is opacity, not a new grey, and never hides the control.

The channel palette has one source of truth. Today it is duplicated between
`src/ui/metrics.ts`, `src/render/theme.ts` and CSS variables; new code must consume one
exported palette, and a test must assert the copies agree until they are merged.

### 13.3 Type and density

Five type roles only:

| Role | Size / weight | Use |
| --- | --- | --- |
| Page title | 16 / 600 | panel or dialog title |
| Section title | 13 / 600 | section header |
| Body | 12 / 400 | labels, controls, values |
| Metadata | 11 / 500 | secondary text, ticks, captions |
| Eyebrow | 10 / 600, uppercase | group labels and badges |

- Nothing below 10 px. Numeric readouts use tabular figures. A control's label never
  changes size or weight by location.
- Line height 1.35–1.5. Text never overlaps a waveform; labels that would collide are
  omitted, not shrunk.
- Control heights: **24 compact, 28 default, 32 prominent**. Top-bar buttons keep their
  44/38/34 px responsive sizes.
- Radii: **4 px for controls, 8 px for containers**; pills and avatars may be 999 px.
- Spacing: 4 px scale (4/8/12/16/24). Adjacent controls in a row share height and radius.
- Exactly one implementation per control class: one input, one select, one segmented
  control, one checkbox. The selected state is one rule in both themes, not inverted.
- Density is a token, not a per-component choice; the toolbar labels toggle is the only
  user-facing density preference today.

### 13.4 Motion

- `--motion-fast: 120ms`, ease. Menus/popovers fade/pop; dialogs fade the backdrop;
  panels may slide; nothing else animates.
- No motion for viewport gestures, waveform redraws, hover readouts, or while the
  renderer is busy. Motion never competes with the canvas for the main thread.
- Reduced motion sets duration to 1 ms and removes the glide.

## 14. Copy, numbers and i18n

- Locales: `en`, `zh-CN`, `fr`, `ru` (plus decoder catalogs). Default follows the browser
  language; the stored choice wins.
- Every user-visible string goes through the catalog. Sentences are whole messages with
  parameters; never concatenate fragments. A new key must be added to every locale.
- Terms are fixed: **Capture** (not Start), **Stop**, **Interval**, **Duration**,
  **Window** (Loop), **Global trigger**, **Trigger condition**, **Cursor**,
  **Analyzer / Decoder** (one concept; use "Analyzer" for the attached instance and
  "Decoder" for the protocol), **Bus**, **Device**. Do not introduce a second word for
  the same concept.
- A control's label states its scope. "Display preferences" for a menu that also holds
  shortcuts is wrong; "Settings" for a menu that holds only labels and a read-only
  shortcut list is also wrong. Read-only lists are labelled "View …", not "Edit …".
- No copy promises behaviour the code does not implement. The empty-trigger note must
  not tell the user to double-click a channel name to set a trigger if that gesture
  opens the name editor.
- Units: ns/µs/ms/s, Hz/kHz/MHz, MS/s, V, CH. One space between value and unit; numbers
  use the locale's grouping. Times at the trigger origin are negative before T.
- Decoder-produced names/fields pass through untranslated; the surrounding labels are
  localised.
- A tooltip or note is not a substitute for a localised label.

## 15. Interface review gate

### 15.1 Interface anti-patterns

The following are review blockers, not style preferences:

- A second Capture/Stop button, or a panel control that starts an acquisition.
- A setting that silently stops, restarts or reconfigures a running acquisition.
- A lifecycle state explained only by a paragraph while the control looks unchanged.
- A new top-level toolbar command without removing one.
- A new always-open panel section without a group or collapse.
- A second editor for a value whose home is a channel row or the plot.
- A raw colour, font size or spacing value in a component rule; a per-theme component
  override block instead of a token value.
- Dead markup, CSS, test selectors or docs for an interaction that no longer ships.
- A status bar that repeats a value already shown in the capture label, or wraps.
- A label that promises behaviour the code does not implement.
- A panel with two headers, or a mode that hides global acquisition/trigger state.
- An icon-only control without an `aria-label`, or an overlay that loses focus.

State, commit, persistence and test anti-patterns (a second settings assignment, a
duplicated derived value, a source-text behaviour test, a console-only failure) are
review blockers in `docs/ARCHITECTURE.md` (`## Verification`).

### 15.2 Implementation references

Do not restate these here; they are normative in `docs/ARCHITECTURE.md`:

| Topic | Where |
| --- | --- |
| State ownership, lifetimes, persistence tiers | `UI runtime contract` → State ownership; Persistence |
| Single settings transaction and field patches | `UI runtime contract` → Settings transaction |
| Acquisition state machine and `mayEdit` | `UI runtime contract` → Acquisition lifecycle |
| Viewport/display ownership and transitions | `UI runtime contract` → Viewport and display |
| Panel registry, render/update and view-model shape | `UI runtime contract` → Panel and view-model contract |
| Overlay stack and focus return | `UI runtime contract` → Panel and view-model contract |
| Testing, design-contract test, typecheck/build | `## Verification` |

### 15.3 Feature admission checklist

A UI change is not mergeable until every answer is in the PR/commit description:

1. **Home** — which region and panel owns it? Which existing control moves or goes away
   to stay within the budgets?
2. **Source of truth** — which field stores it? What is derived? (Ownership:
   `ARCHITECTURE.md` → State ownership.)
3. **Lifecycle** — live / next / view / workspace? What does the badge say while
   running, waiting, matched, stopping? (Capability: `ARCHITECTURE.md` → Acquisition
   lifecycle.)
4. **Running state** — does it restart, retune, or stage? Is the restart named? Does it
   discard data?
5. **Trigger** — does it arm, disarm, retune or freeze the matcher? What happens in
   Single, Repeat and Loop? (Engine: `ARCHITECTURE.md` → `src/device`.)
6. **Persistence** — workspace, capture file, session only, or none? What is the
   migration? (Tiers: `ARCHITECTURE.md` → Persistence.)
7. **View model** — which panel view field and callback? Does the panel stay unable to
   reach App/Device/Store? (Contract: `ARCHITECTURE.md` → Panel and view-model contract.)
8. **Accessibility** — label, role, keyboard path, focus return, hit target.
9. **Copy** — keys in all locales, whole sentences, no concatenation; terms match §2/§14.
10. **Tests** — behavioural tests named, not source greps; `npm test`, typecheck and
    build pass. (Policy: `ARCHITECTURE.md` → Verification.)
11. **Docs** — this file updated; `NOTES.md` updated if a measurement or assumption
    changed.

### 15.4 Definition of done

A UI change is done only when:

- the interface rules above are satisfied;
- the engineering definition of done is met (`ARCHITECTURE.md` → `## Verification`);
- the change was checked at 1400 px and 360 px wide, in the dark and light themes, in
  `en` and `zh-CN`, with reduced motion on;
- the keyboard path was exercised, including focus return from any overlay;
- no new console error or unhandled rejection appears during the change;
- this document matches the shipped behaviour.

## 16. Current deviations and migration order

These are the places where the current code does not follow the contract. The order is
chosen so the foundational rules land before the visible changes that depend on them.
Where an item is a state, commit, persistence or test rule, its normative contract is in
`docs/ARCHITECTURE.md`; this table is the migration plan, not a second specification.

| # | Deviation | Fix | Visible |
| --- | --- | --- | --- |
| 1 | **Trigger state is stored six ways** (`triggerModes`, `triggerConditions`, `triggerChannel/kind/level`, `softwareTrigger`, analog map, enable mask) and synced by hand (`state.ts:80-89`, `app.ts:5375-5465`). | Keep `triggerModes` as the only condition source; derive a `TriggerPlan`; migrate and delete the legacy fields. | no |
| 2 | **No single acquisition state machine or capability table.** The lifecycle is seven booleans plus a manual generation counter; `restart` reuses the user-facing stop path (`stopCapture('manual')` then `startCapture`); `captureLocked` is `stopping`; the assistant refuses edits the panel allows; BusPanel/addBus disagree (`app.ts:302-315,775-806,921-957,3565`, `busPanel.ts:27`, `assistant/tools.ts:612`). | Add `AcquisitionState` (idle/arming/waiting/running/stopping/restarting/retrying/lost) and pure `mayEdit(feature, state)`; make restart a first-class transition; route UI, assistant and debug through it. | no |
| 3 | **Nine paths assign `settings`; only `applySettings` runs the full pipeline.** `configureChannel`, `afterChannelChange`, the analog drag preview, `adoptCapture`, `adoptDeviceChannels`, `finishCapture` and the constructor each apply a different subset; `busViews` is pushed/filtered outside any commit. | One `commitSettings(next, reason)` pipeline; panels send field patches; previews use a separate draft; `busViews` gets the same commit/draft split. | no |
| 4 | **Lifecycle rules live in comments and prose.** Rate/threshold have no disabled state; duration stays live; trigger edits retune; pre-trigger locks; only Advanced has a note (`capturePanel.ts:543-560,582-735,762-1032`). | Add the `settingPolicy` registry (§7.2) and render Live/Next badges from it. | yes |
| 5 | **Transport has five meanings.** It is disabled without a device but `Space` starts/opens the chooser; its disabled title says Connect; a pending automatic restart is a hidden third click (`app.ts:3573-3642,4028-4036`, `shortcuts.ts:13`). | Two actions, one `canRun` guard for every input path, connect only on Device, restart as a visible state. | yes |
| 6 | **No overlay owner.** Every toolbar button hand-closes four menus plus the channel editor; ShortcutsDialog is outside the scheme; a stale comment still describes a removed native dialog (`app.ts:3189-3225`, `settingsMenu.ts:23-25`). | `OverlayController` stack; focus returns by token. | partly |
| 7 | **Device panel is an unbounded stack with no page header.** Seven always-open sections in implementation order; analyzers mode renders two headers; the panel title does not match its contents. | Group to Acquisition / Trigger / Measurements / Advanced; one header per panel; collapsible with stable defaults. | yes |
| 8 | **Panels render through two pipelines.** A full `host.replaceChildren()` rebuild (46 call sites) plus a 500 ms frame path patching text through twelve cached refs; a missing ref silently skips, so a field can be stale. `CapturePanelView` mixes raw flags, derived state, sixteen trigger booleans and cursor tables, and the panel re-derives armed/hidden inputs/caps. | One `render(view)` contract plus a complete `update(view)` if needed; view models are presentation-ready; missing nodes throw; panels stop re-deriving shared selectors. | no |
| 9 | **Eleven top-level commands** and three duplicate entry points (Assistant button + sidebar row; Language/Theme as top-level preferences; panel menu). | Remove the Assistant button; move Language/Theme into Settings; one panel switcher; target 8 commands. | yes |
| 10 | **Cursors are undiscoverable and destructive.** Only a plot double-click adds one; the panel has no Add control; `Esc` clears them; a new capture silently drops them; they are not persisted (`app.ts:2200-2205,2253-2257,3786`, `capturePanel.ts:1052-1089`). | Explicit Add; per-row delete; non-destructive Esc; declare the persistence tier. | yes |
| 11 | **Viewport gestures are implemented per surface.** Plot, axis and overview do not share a grammar; keyboard has no zoom/pan; double-click means different things (`app.ts:2039-2231`, `overviewStrip.ts:339-385`). | Publish §6.3 and route all surfaces through it; generate the shortcut table. | yes |
| 12 | **Two viewport owners and two display owners.** `captureSession.ts` has a pure ViewPolicy but Loop skips it and uses App fields; which store is displayed is spread across `storeRef`, `waveStore`, `repeatFront`, `repeatComposite`, `repeatShowingFront`, `repeatHeldTrigger`, and session teardown is copied in three paths that already diverge (`captureSession.ts:81-112,247-262`, `app.ts:232-265,2820-2852,3745-3760,3846-3858,4792-4806`). | One `ViewState` in the session (Loop lock is a policy variant) and one `DisplayState`; one `applyViewEvent` and one `endSessionDisplay(reason)`; table-driven tests for every transition. | no |
| 13 | **Bus ownership is split across four homes.** Left cell (gear, trigger, height), BusPanel, Device Analog button, assistant; opening the editor silently switches the panel (`channelList.ts:400-540`, `app.ts:1007-1015`, `busPanel.ts:327-389`). | One bus editor; one creation path; explicit navigation. | yes |
| 14 | **Status bar duplicates statistics and carries no state.** The capture label already renders samples/rate/duration, then `renderStatus` appends them again; no trigger state; no zoom/timebase; a long error can wrap the bar (`app.ts:3645-3694`, `style.css:1699-1713`). | Three fixed zones per §11; each value once; no wrap; trigger state always visible even with the panel closed. | yes |
| 15 | **Responsive rules never take effect.** The labelled-toolbar selector outranks the 760/400 px rules, so phones keep 48×58 px buttons and wrap; the panel overlays without a scrim or Close; a persisted 560 px width ignores the remaining plot (`style.css:321-356,1141-1161`, `panelWidth.ts:3-7`). | Breakpoints, drawer with scrim/Close, clamped persisted width, compact rules that win by construction, one row at 360 px. | yes |
| 16 | **Three token layers, nine type sizes and ad-hoc geometry.** `--bg00`…`--text50` and shadcn names coexist; 104 per-theme component override blocks; the ADC blue `#4C9AFF` is literal; heights range 18–58 px and radii 1–999 px; `--labels-w` is 128 in CSS and 170 in `CHROME` (`style.css:13-172,590-631`, `metrics.ts:94-137`). | One semantic token layer, five type roles, 24/28/32 px controls, 4/8 px radii, one palette source, no per-theme component blocks. | yes |
| 17 | **Label and plot use different row grammars.** The label side is an inset rounded card in themed mode; the plot paints a full-bleed band; hover/selection/armed/colour exist only on the label side (`style.css:590-631`, `render/theme.ts:86-99`). | One row anatomy across the seam; paint row state on both halves from one token. | yes |
| 18 | **Copy is inconsistent and sometimes false.** The sidebar calls the panel "Device and capture settings" while it holds measurements and developer tools; "Analyzers" and "decoders" name one concept; the empty-trigger note tells users to double-click a channel name, which opens the name editor (`locales/en.ts:62,433`, `channelList.ts:620-629`). | Vocabulary and scope rules in §14; every label reviewed with the UI and all locales. | yes |
| 19 | **i18n and time readouts have two implementations.** Static `data-i18n` attributes and imperative toolbar assignments both set the same titles; numbers mix a hardcoded `en-US` formatter with `toLocaleString()`; cursor rows use `triggerSampleIndex` while the status uses the held Repeat origin, so they disagree on screen (`index.html:50-164`, `format.ts:142-145`, `app.ts:2459-2474,2966-2974,3645-3694`). | All strings and accessible names at render time from the catalog; one number formatter; all presentation time through `displayOriginSample()`; a held-front test. | yes |
| 20 | **Source-text tests freeze the structure.** ~239 `readFileSync` calls across the UI tool suites; 25 of 49 UI selftests read `app.ts`; `cursor-panel-selftest.ts` has 534 `.includes(` calls and asserts append order by `indexOf`; `runtime-settings-selftest.ts` asserts statement spelling. | Replace with view-model/DOM tests per `ARCHITECTURE.md` → Verification; keep an allowlist for static contracts only; add the design-contract test. | no |
| 21 | **A replaced interaction generation still ships in tests/docs.** The native channel-settings dialog's CSS and motion self-test remain, and NOTES describes it as current (`style.css:635-860`, `tools/motion-selftest.ts:85-134`, `NOTES.md:667,712`). | Delete dead markup/CSS/tests/docs in the same change that replaces an interaction. | no |
| 22 | **`app.ts` is the growth point.** 5,490 lines mix composition, rendering, capture state, trigger state and panel policy. | Move panel markup and pure decisions into modules; app keeps composition and transitions. | no |
| 23 | **Persistence has no registry and its schema is hand-copied.** The workspace schema is maintained in four places; the pre-paint script restates keys, version and clamps; workspace has no cursors/viewport; theme and panel width use separate keys (`workspacePreferences.ts:29-46,129-199,380-451`, `app.ts:3291-3326`, `index.html:14-44`, `panelWidth.ts:1-7,49-77`). | Declare one field table with tiers; derive restore/serialize/boot from it; route all persistence through one store; show "session only" where true. | partly |

Done criteria: one capture action, one panel switcher, ≤8 top-bar controls, ≤4 Device
sections, one trigger condition store, a visible Live/Next badge on every running-state
edit, one overlay controller, one bus editor, a declared persistence tier for every
field, and a behavioural test for each panel transition.
