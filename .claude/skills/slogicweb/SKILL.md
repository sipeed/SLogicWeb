---
name: slogicweb
description: Operate the slogicweb logic analyzer page from an AI agent over CDP. Use when asked to connect a SLogic board, start/stop a capture, configure channels, triggers or decoders, inspect samples, drive the viewport/cursors, or summarize the current capture. slogicweb has no AI chat column; this skill is the agent interface.
---

# Operating slogicweb as an AI agent

slogicweb is a browser-based logic analyzer for the SLogic16U3/32U3. The page is the
application. There is **no AI chat column and no network service**: an agent drives the
running page directly, and reads compact summaries through the same host object the
tool library was written against.

Two rules come first:

1. **The user owns the USB permission gesture.** WebUSB only shows its device chooser
   from a real user activation. Ask the user to click **Connect**, or drive a trusted
   click through CDP. Never claim a board on the user's behalf, and never touch a shared
   board unless the user has explicitly cleared hardware use for this session.
2. **Do not dump raw samples.** A capture is hundreds of millions of samples. Use
   `debug.snapshot()` and the `agentHost()` tools; they return statistics, capped edge
   lists and decoded annotations.

## 1. Serve the app

From the repository root:

```sh
npm run dev          # Vite, default http://localhost:5173
npm run dev:lan      # HTTPS on the LAN, for a phone (see docs/DEPLOY.md)
```

Open the printed URL in a Chromium-based browser with WebUSB. Vite serves the
TypeScript modules directly, so `import('/src/assistant/tools.ts')` also works in dev.

## 2. Connect to the page over CDP

Launch the browser with a debugging port, or attach to an existing session:

```sh
chromium --remote-debugging-port=9222 http://localhost:5173
```

Then evaluate in the page. `Runtime.evaluate` options to use:
`awaitPromise: true`, `returnByValue: true`, and `userGesture: true` only for the
connect click.

```js
// Wait for boot: main.ts sets this after the first render.
window.slogicweb && window.slogicweb.debug.snapshot()
```

If `window.slogicweb` is undefined, the app failed to start; read the console and the
full-page error overlay that `main.ts` installs.

## 3. Connect the board (user gesture required)

The only connection path is the toolbar's Connect button. `debug.connect()` calls
WebUSB's `requestDevice()`, which the browser rejects without transient activation.
Drive a trusted click, then **ask the user to pick the board in the browser chooser**:

```js
document.getElementById('btn-connect').click()   // inside a CDP userGesture evaluation
```

or dispatch `Input.dispatchMouseEvent` at the button's center. The chooser is native
and cannot be automated. After the user picks the device, poll:

```js
window.slogicweb.debug.snapshot().device   // non-null once connected
```

## 4. The debug surface

`window.slogicweb.debug` is the supported control surface (the same methods the buttons
call). Useful entry points:

| Call | Effect |
| --- | --- |
| `debug.snapshot()` | capture/device/trigger/view/analyzer summary |
| `debug.agentHost()` | the `AssistantHost` tool view (see below) |
| `debug.connect()` | WebUSB chooser; needs a user gesture |
| `debug.start()` / `debug.stop()` | capture transport |
| `debug.setSettings(patch)` | clamped capture settings (width, rate, mode, trigger) |
| `debug.attach(id, channels, options)` | attach a decoder |
| `debug.addBus(cfg)` / `debug.removeBus(id)` / `debug.buses()` | parallel-bus (ADC) views |
| `debug.setViewportSeconds(a, b)` | move the visible time window |
| `debug.setMarker(sample)` / `debug.addCursor(sample)` / `debug.cursors()` | cursors |
| `debug.edges(channel, lo, hi)` | edge positions in a sample window |
| `debug.setPanel('device' \| 'analyzers' \| null)` | open a side panel page |
| `debug.setLocale(l)` / `debug.setTheme(id)` | chrome only |

A typical capture:

```js
const d = window.slogicweb.debug;
d.setSettings({ channels: 16, samplerate: 100e6, mode: 'single', seconds: 0.05 });
await d.start();
// start() returns when the acquisition has been requested; poll while running.
while (d.snapshot().running) await new Promise((r) => setTimeout(r, 50));
d.snapshot();
```

## 5. Summaries and tools: `agentHost()`

`debug.agentHost()` returns the `AssistantHost` from `src/assistant/tools.ts`:
`snapshot()`, `store()`, `analyzers()`, `levelAt()`, `attach()`, `startAndWait()`,
`stop()`, `setViewportSeconds()`, `zoomToAnnotation()`, bus methods, and so on. It is
the same object the removed chat panel used, and every method routes through the path
a button uses, so a tool cannot reach a state the UI could not.

The tool library lives in the source tree:

```js
const { TOOLS, toolByName } = await import('/src/assistant/tools.ts');
const stateTool = toolByName('get_state');
const out = await stateTool.run({}, window.slogicweb.debug.agentHost(), new AbortController().signal);
```

`TOOLS` covers: `get_state`, `get_channel_stats`, `get_edges`, `list_decoders`,
`describe_decoder`, `get_annotations`, `set_viewport`, `zoom_to_annotation`,
`set_capture_settings`, `start_capture`, `stop_capture`, `attach_decoder`,
`remove_decoder`, `add_bus_view`, `update_bus_view`, `remove_bus_view`,
`get_bus_values`.

Tool risk is declared: `read` and `view` are safe to run; `act` tools change the
device, settings or capture. Ask the user before running an `act` tool. The host is a
plain runtime object — do not patch it, and do not reach past it into App internals.

In a production build the tool module may be tree-shaken out (the UI no longer imports
it). Use the dev server, or bundle `src/assistant/tools.ts` yourself, when the page is a
built `dist/`.

## 6. Guardrails

- **Never auto-claim USB.** No background scans, no `requestDevice()` without the
  user's gesture and their pick in the native chooser.
- **Never reset a wedged board.** Stop the capture and ask the user; a bus reset can
  make the shared device unusable for the next person.
- **Respect the capture budget.** Prefer `get_channel_stats`/`get_edges` over reading
  the store; tools cap edge and annotation lists and report truncation.
- **Stay in the page.** Do not add a server, proxy or background daemon; the agent
  connects to the same browser session the user is looking at.
- **Ask before `act`.** Starting a capture, changing settings, attaching a decoder or
  editing a bus view are user-visible changes.

## 7. What this replaces

The old toolbar Assistant button and conversation panel are gone from the UI. The
provider clients and settings module under `src/assistant/` remain as a library, but
there is no chat tab or column to reach. This skill plus `debug`/`agentHost()` is the
supported path for an AI agent.
