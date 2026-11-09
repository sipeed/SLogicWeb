# slogicweb MSO - system architecture and module contracts

**Status: v2 target.** This document specifies the engine and platform contracts for the
MSO application (digital + analog + decode on one time axis). The current code implements
the earlier LA-only architecture; the gap is tracked in `docs/DESIGN.md` §17. Engine and
state facts are normative here; interface facts are normative in `docs/DESIGN.md`;
`src/ui/NOTES.md` is historical measurement evidence. A fact lives in exactly one file.

**Document map.** This file owns module boundaries, platform/WebUSB constraints, link and
device profiles, the signal store and time base, trigger/acquisition/recording/view state,
panel/view-model contracts, persistence, decoding runtime, security, verification and the
roadmap. `docs/DESIGN.md` owns layout, controls, interaction, user-visible lifecycle,
visual tokens, copy, accessibility and the interface review gate. C1 (security) is
currently §9 here and C3 (migration) is §17 of `DESIGN.md`; split them into
`docs/SECURITY.md` and `docs/MIGRATION.md` when either outgrows its section.

## 1. Scope and platform

### 1.1 Product scope

**Do:** a buyer-facing, driverless, accountless, fully local MSO. Digital and analog
signals share one time axis with protocol decoding, cursors, measurements, math/FFT,
recording and offline replay. PC Chromium is the functional baseline; Android
phone/tablet Chrome with USB OTG is a first-class touch target.

**Do not:** scripting, macros, user decoder code or expressions; SCPI/REST/WebSocket
remote control; scheduled or unattended capture; accounts, cloud sync, share links or
collaboration; device-side deep storage (segmented or single deep captures); iOS/iPadOS;
multiple devices at once; the Assistant in the baseline.

**Grey areas:** Autoset and automatic measurements are in (instrument features); loop
recording is in (a storage policy, not automation); mask/limit tests are P2 and run only
on demand; threshold alarms are visual only, never audible or remote. Firmware flashing is
out of scope; a version mismatch is a typed refusal with the required version and vendor
instructions.

### 1.2 Runtime environments

| Environment | WebUSB | Status |
| --- | --- | --- |
| Chromium browsers on Windows/macOS/Linux/ChromeOS (Chrome, Edge, Brave) | yes | Functional baseline; minimum versions fixed by the M0 matrix |
| Chrome on Android phone/tablet with USB OTG | yes | First-class touch target |
| Firefox, Safari, iOS/iPadOS | no | Out of scope; file replay and Demo only |
| Android WebView / in-app browsers | not guaranteed | Unsupported |

### 1.3 Platform and WebUSB rules

- **P1 Feature detection, never UA sniffing.** `src/platform` probes `navigator.usb`,
  `isSecureContext`, `crossOriginIsolated`, `OffscreenCanvas`, WebGL2, OPFS (including
  `FileSystemSyncAccessHandle`), `navigator.locks`, Wake Lock, `navigator.share`,
  `showSaveFilePicker` and `navigator.storage.persist`. A missing capability becomes a
  typed `unsupported-platform` reason or a named degradation; without WebUSB the link
  state is `unsupported`.
- **P2 Permission.** `requestDevice()` runs only from a user gesture, with fixed product
  VID/PID filters. Permissions are per origin, so the deployment domain is fixed; a
  granted device reconnects with `getDevices()` without a chooser.
- **P3 Interface class.** The device exposes a vendor-specific interface (0xFF); HID,
  mass storage and audio/video classes cannot be claimed from a page.
- **P4 Windows driverless.** Firmware provides a BOS MS OS 2.0 descriptor and declares a
  WinUSB-compatible ID; otherwise buyers must install a driver by hand.
- **P5 Linux.** A udev rule is required; the app offers a copyable snippet and
  instructions.
- **P6 Serial number.** A missing or duplicated serial prevents reliable reconnect after
  a port change or replug; the app warns and asks the user to reselect.
- **P7 Exclusivity.** One interface has one owner at a time (another tab, desktop software,
  or a system driver). The link reports `busy`; tabs within this origin coordinate with
  Web Locks.
- **P8 Link rate is invisible.** `USBDevice` does not expose FS/HS/SS. The injected
  `LinkPort` supplies the negotiated class from a platform capability; a future firmware
  identity record may also report it. The session never infers the class from control
  latency or probe throughput. If no source is available, the UI must offer only the
  HS-safe tiers until the adapter can name the class (§3.1, §3.2).
- **P9 Android.** OTG is required; phone-port power is limited, so the UI recommends a
  powered Y-cable or hub. The system may add its own USB permission prompt. Backgrounding
  or screen-off may suspend the page; the acquisition reports `suspended` (§5.2).
- **P10 Export.** OPFS is not user-visible; export uses the save picker, the share sheet
  or a download, chosen by feature detection.

### 1.4 Hosting tiers

| Tier | Example | Headers | Consequences |
| --- | --- | --- | --- |
| T0 headerless static | GitHub Pages | cannot set | No COOP/COEP, so no `SharedArrayBuffer`; decode cancellation kills and respawns the worker. CSP only through `<meta>`: no `frame-ancestors`, no Permissions-Policy, no control over http(s) workers; use a top-level frame check. |
| T1 managed static | Netlify / Cloudflare Pages / own server | settable | Full CSP, COOP/COEP (`SharedArrayBuffer` for the pipeline ring and decode interruption), `Permissions-Policy`. Recommended. |
| T2 local package | bundled static server on `localhost` | settable | Isolated-network PCs; `file://` is unusable ([MEASURED]); Android not applicable. |

WebUSB requires https or `localhost` in all tiers. `src/platform` exposes capability bits
such as `isolated`; the engine selects the ring-buffer and decode-cancellation strategy
from them. Tier differences are invisible to the user.

### 1.5 Key decisions

| ID | Decision | Contract |
| --- | --- | --- |
| D1 | Engine + Profile: UI, state machine and pipeline generic; device differences only in `DeviceProfile`; no model branches. | §2, §3.2 |
| D2 | One timeline: float64 sample positions, seconds for display, one `displayOrigin()`; multi-rate groups aligned by time. | §4.1 |
| D3 | Retention and recording are orthogonal: retention is the RAM display window; recording is an OPFS archive; Loop may roll and record. | §4.3 |
| D4 | Assistant is out of the baseline; its host interface remains only for debug/test. | §6, `DESIGN.md` §10 |
| D5 | One `TriggerPlan`; P0 keeps the single family, P1 enables mixed digital+analog when the profile supports it. | §5.1 |
| D6 | Composite state machine: connection × acquisition × recording × view; `suspended`; typed refusal reasons. | §5.2 |
| D7 | Capture remains the only start/stop entry; compact layouts move it to the bottom action bar; Autoset is a Capture variant. | `DESIGN.md` §4 |
| D8 | One view model, three presenters: Docked / Sheet / Dialog; touch tokens follow the pointer class. | §6, `DESIGN.md` §3.3 |
| D9 | Decode runtime: first-party TS/WASM default; Pyodide optional and on demand. | §8 |
| D10 | Local trust: same-origin CSP, no third-party runtime, no telemetry; the security boundary is documented. | §9 |

## 2. Module layout and ownership

```
src/
  platform/  capability probes, Wake Lock, share/export, visibility, storage estimate
  link/      WebUSB session: pairing, open/claim, handshake, link probe, reconnect
  device/    frame codecs + DeviceProfile table + SimDriver
  data/      SignalStore (digital + analog), pyramids, gaps, RAM -> OPFS, files
  dsp/       calibration, trigger matcher, measurements, FFT/math
  render/    WebGL2 canvas (digital and analog), tiles, overlays
  decode/    decode worker: first-party TS/WASM + optional Pyodide
  ui/        shell, presenters, rows, input grammar, panels
bench/       re-runnable measurement scripts
fixtures/    captures from our hardware
docs/        contracts, migration, NOTES
```

- **Cross the boundary only through the contracts below.** Own your directory; do not
  edit another module's files. A contract change is a report to its owner, not a
  unilateral edit.
- **Dependency direction.** `ui → device/data/dsp/render/decode/platform`; `render`, `dsp`
  and `decode → data`; `device → link → platform`; `data → platform` (OPFS and quotas).
  No module imports `ui`; `ui` never touches WebUSB or WebGL.
- **Workers.** USB, DSP, storage, render and decode communicate through typed,
  serialisable messages declared in their module contracts. Hot paths use transferable
  buffers; with `isolated`, use a `SharedArrayBuffer` ring (§5.5).
- **Device differences live in a `DeviceProfile`.** Code has no model branches; a missing
  capability is a typed refusal, not a model check.
- **Platform contract.** `src/platform` owns feature probes, Wake Lock, visibility,
  share/export and storage estimates. It exposes capabilities and typed degradations; it
  never owns device or UI state.
- **DSP contract.** `src/dsp` compiles `TriggerPlan`, runs the bounded host matcher
  (`hostTrigger.ts`, plus the `captureTriggerPlan.ts` legacy bridge), computes
  measurements and FFT on complete samples, and does not touch the DOM, USB or storage.
  Pure and deterministic.
- **Render contract.** `src/render` consumes `SignalStore.query`/`edges` only; it owns the
  canvas, the time/sample transform, tiles and overlay layers, and exposes
  `setViewport(startSeconds, endSeconds)` and `render()`. It never mutates the store,
  device or settings.
- **Tests.** Contract tests live beside each module; hardware tests use a separate
  harness and are not part of `npm test`.
- **Stack.** TypeScript + Vite; no UI framework unless a builder argues for one. DSP and
  decode hotspots may use Rust → WASM (SIMD).
- **Builder rules.** Check every device reply; fail early and loudly; no silent catches;
  report measured values including misses; capabilities come from Profile; the capture
  path is never blocked by display or measurement; any network behaviour requires a
  security-contract change (§9).

## 3. Link and device contracts

### 3.1 LinkSession

One `LinkSession` owns the physical connection. States:

| State | Meaning |
| --- | --- |
| `unsupported` | WebUSB absent or the page is not a secure context. |
| `idle` | No device selected; `requestDevice()` is available from a gesture. |
| `selecting` | The browser chooser is open. |
| `opening` | `device.open()` / interface claim in progress. |
| `claiming` | Interface and endpoint claim in progress; Web Locks held. |
| `handshaking` | Descriptor identity, optional control-plane identity and link probe. |
| `ready` | Streaming commands are accepted. |
| `busy` | Another owner holds the interface; a typed reason names the conflict. |
| `suspended` | The page is hidden/backgrounded; the device may have paused. |
| `lost` | The device vanished or the transfer failed; no more samples. |
| `closed` | The user disconnected. |

Rules:

- Pairing uses the fixed product VID/PID filters and a user gesture; reconnect uses
  `getDevices()`. The origin/domain must not change without re-pairing.
- Claim the vendor interface exclusively; hold a Web Lock for the origin. On failure,
  report `busy` with the owner if known.
- Handshake identity comes from the USB descriptors first: VID/PID, serial and the
  negotiated link class. The stock U3 protocol exposes no firmware-version register, so
  `firmware.min` is documentation, not an enforced gate. A future firmware may add the
  `LW` identity record and inventory reply; when the port implements that optional
  control plane, the session validates profile id, firmware, channel/analog inventory and
  reported link rate, and a mismatch is a typed refusal, never a fallback that guesses.
  When the control plane is absent or returns `unsupported`, the session stays on the
  descriptor identity, reports the unknown fields as `null`, and skips the probe.
- The optional link probe measures sustained throughput and latency for one short transfer
  burst. The result selects the streaming tile and record chunk sizes. Probe failures
  other than `unsupported` remain typed `handshake`/`transfer` errors.
- The concrete browser adapter is `src/link/webUsbPort.ts`: it claims the vendor
  interface, maps USB failures to typed `LinkError`s, implements descriptor-only identity,
  and never calls `USBDevice.reset()`. WebUSB exposes no negotiated speed, so the
  platform adapter supplies `linkClass`; the per-origin Web Lock is owned by that platform
  layer, not the port.
- Reconnect is bounded: `connect`/`disconnect` events trigger at most one attempt per
  event; a failed attempt surfaces `lost` and offers "Reconnect". No unbounded retry loop.
- `visibilitychange`/`freeze` moves to `suspended`; on resume the session re-handshakes
  and checks the device still holds the stream. If not, `lost`.
- Every failure has a typed `LinkError` reason (`unsupported`, `denied`, `busy`,
  `handshake`, `profile`, `transfer`, `lost`, `suspended`).

### 3.2 DeviceProfile

A `DeviceProfile` is data, loaded from `src/device/profiles/`. It declares:

```ts
interface DeviceProfile {
  id: string;                         // stable profile id, never a model check
  name: string;
  vid: number; pid: number;
  serial?: { required: boolean };
  link: {
    interfaceClass: 0xff;
    endpoints: { in: number; out: number | null }; // null = no OUT endpoint, EP0 control writes only
    maxTransferBytes: number;
    rates: readonly LinkRate[];       // FS/HS/SS5/SS10 as reported/probed
    probe: { bytes: number; bursts: number };
  };
  digital: {
    maxChannels: 4 | 8 | 16 | 32 | 64 | 128;
    groups: readonly DigitalGroup[];  // channel ranges that share a rate
    widths: readonly ChannelCount[];
    rates: readonly RateTier[];       // per width/group, per link rate
    sampleratesHz?: readonly number[]; // discrete rates the device accepts
    thresholdVolts: readonly number[] | null;
    testModes: readonly TestMode[];
    emulationPattern?: 'slogic16u3' | 'slogic32u3'; // test-mode-2 table, required when offered
  };
  analog: {
    groups: readonly AnalogGroup[];   // group start, channels, ranges, resolution, maxRate
    calibration: CalibrationRef;
  };
  trigger: {
    execution: 'device' | 'host';
    digital: readonly TriggerKind[];
    analog: readonly AnalogTriggerKind[];
    mixed: boolean;                   // false in P0, true when the profile supports it
    preTriggerMaxPercent: number;
    preTriggerMaxBytes: number;
  };
  modes: { single: boolean; repeat: boolean; loop: boolean; record: boolean };
  firmware: { min: string };          // opaque documentation floor (often a hardware S/N), never enforced
  quirks?: readonly ProfileQuirk[];
}
```

Supporting types:

```ts
type LinkRate = 'fs' | 'hs' | 'ss5' | 'ss10';   // 5G vs 5G+ SuperSpeed are distinct tiers
type ChannelCount = 4 | 8 | 16 | 32 | 64 | 128;
type TestMode = 0 | 1 | 2;
type TriggerKind = 'level' | 'rising' | 'falling' | 'edge' | 'high' | 'low';
type AnalogTriggerKind = 'rising' | 'falling';

interface DigitalGroup {
  start: number;
  channels: number;
}

interface RateTier {
  channels: ChannelCount;
  hz: Readonly<Partial<Record<LinkRate, number>>>;
  recommendedHz?: Readonly<Partial<Record<LinkRate, number>>>; // measured sustainable default, <= hz
}

interface AnalogGroup {
  start: number;
  channels: number;
  ranges: readonly number[];        // bipolar range in volts, e.g. 1, 5, 16 (±1 V, ±5 V, ±16 V)
  adcSpanV: number;                 // converter input span, e.g. 1.6
  frontEndAttenuation: number;      // fixed front-end attenuation, e.g. 20
  codeDenominator: number;          // LSB = adcSpanV * frontEndAttenuation / codeDenominator
  zeroCode: number;                 // code reading 0 V; volts = (code - zeroCode) * LSB / gain
  gains: readonly number[];         // declarable hardware gain presets, ascending, include 1
  customGain?: { min: number; max: number }; // bounds of a custom declared ratio
  resolutionBits: number;
  maxHz: Readonly<Partial<Record<LinkRate, number>>>;
}

interface CalibrationRef { id: string; version: number }
interface ProfileQuirk { id: string; note: string }
```

- The profile declares capability, not behaviour code. `src/device` implements the frame
  codec and the commands; `src/link` implements USB; `src/dsp` compiles triggers. Profile
  values (rates, channel counts, ranges) are copied from the protocol documents and
  verified by the M0 device matrix; this contract defines the shape, not the numbers.
- A capture request is validated against the profile before any device command: the rate
  must be one of `digital.sampleratesHz` and at or below the selected width's ceiling for
  the current link class. A refusal carries a typed reason (`unsupported-channel-count`,
  `unsupported-rate`, `no-analog`, `trigger-unsupported`, `record-unsupported`, ...).
- Rate tiers may depend on the enabled channel count, analog groups and the negotiated
  link rate. `ss5` is capped by the 5 Gbit/s payload (3200 Mbit/s / channels), while
  `ss10` carries the native per-width ceiling; the 16U3 declares no `ss10` tier. The UI
  reads the same profile and renders only offered values.
- Analog groups are hardware-defined ranges; vertical scale and offset are view state,
  not profile capability. The code-to-volt mapping is profile data, converted in one
  place (`src/ui/channelBanks.ts`): `volts = (code - zeroCode) * LSB / G` and
  `code = clamp(round(volts * G / LSB + zeroCode), 0, 2^bits - 1)`. The 32U3 values
  (1.6 V, 20x, /255, zero 128: 0.12549 V per code, -16.063..+15.937 V at 1x) were
  confirmed by the hardware team on 2026-11-06; HSync and scopehal used ±15 V with zero
  at 127.5. G is the gain the user declares for the module's front-end stage, which the
  host cannot read or program; it lives on the analog bus view in the workspace
  (`analogGain`, absent = 1x, invalid saved values are rejected) and the bus offset/span
  are derived from it. `.lwcap` stores transitions only, so a file does not carry the
  gain. Trigger levels are stored in volts and re-snapped to the gain's code grid by the
  settings clamp; the matcher always receives a code.

### 3.3 Device commands and framing

The device layer exposes commands (`open`, `configure`, `run`, `stop`, `updateTrigger`,
`setTestMode`, `console`) and a sample sink. Every command checks its reply before the
next step. A short USB packet is delivered at its actual length and never implies a gap;
a real dropout is reported through the gap API.

- Samples are little-endian, `ceil(channels/8)` bytes per digital sample (plus analog
  group bytes when present). The 4-channel wire mode packs two samples per byte; the
  transport expands it before the sink, so the sink and SignalStore see one byte per
  sample. A sample carried across a transfer boundary is completed before matching or
  storing.
- The frame codec owns the run header/trailer, timestamps/counters and error flags.
  Timestamps reconstruct absolute sample positions; a discontinuity becomes a `GapSpan`
  with a reason, never a silent splice.
- `DeviceProfile` test modes are diagnostic only; they are not a supported analog voltage
  source unless the profile says so.

### 3.4 SimDriver

`SimDriver` implements the same commands and profile shape without USB. It must be
deterministic for a seed and support fault injection: short packets, stalled transfers,
dropouts, disconnects, malformed headers, slow handshakes and quota errors. Contract and
UI tests use it; hardware tests remain separate.

## 4. SignalStore and time base

### 4.1 One timeline

- A **signal** is a digital channel or an analog channel. Signals belong to **groups**;
  each group has one sample rate and one position space.
- A position is a **float64 sample index** at the group's rate. The canonical timeline is
  seconds; `Timeline` maps `positionToSeconds(group, pos)` and
  `secondsToPosition(group, s)`. Removing the 2^31-sample ceiling is deliberate; the
  practical limit is memory/OPFS, and positions above 2^53 are unsupported. Until the
  paged store lands (M1), the array-backed M0 store still has a `MAX_SAMPLES` (2^31)
  implementation ceiling; it is surfaced as typed `store-full`, never as an unhandled
  append.
- There is exactly one display origin, `displayOrigin()` in seconds: T when the current
  wave has a trigger, otherwise the sweep start, otherwise the held wave's T. Every
  readout, axis, cursor, debug/test output and export uses it. No presentation code
  reads a raw trigger index.
- Multi-rate groups are aligned by time, not by index. Digital edges are preserved;
  analog queries return min/max/mean for the covered interval.
- A column has a status: `ok`, `pending` (data not yet delivered) or `gap` (unknown).
  `pending` is not a gap; `gap` is not idle. Edges never cross a gap.

### 4.2 SignalStore contract

```ts
interface SignalStore {
  readonly groups: readonly SignalGroup[];
  readonly signals: readonly SignalInfo[];
  readonly retainedFrom: number;         // canonical seconds; the display window's left edge
  readonly newest: Readonly<Record<string, SamplePos>>; // per group
  append(groupId: string, chunk: Uint8Array, start: SamplePos): void;
  dropBefore(seconds: number): void;
  query(signal: SignalId, start: SamplePos, end: SamplePos, bins: number): SignalColumns;
  sample(signal: SignalId, position: SamplePos): number | null; // digital 0/1, analog volts
  edges(signal: SignalId, start: SamplePos, end: SamplePos): Float64Array;
  noteGap(gap: GapSpan): void;
  gaps(): readonly GapSpan[];
  record: RecordController;
}
```

Supporting types:

```ts
type SamplePos = number;              // float64 sample index at the group's rate
type SignalId = string;               // stable, e.g. "d0" or "a1"
type GapReason = 'dropout' | 'overrun' | 'suspend' | 'record-gap' | 'import-gap' | 'store-full';

interface SignalGroup {
  id: string;
  kind: 'digital' | 'analog';
  start: number;
  channels: number;
  rateHz: number;
}

interface SignalInfo {
  id: SignalId;
  group: string;
  index: number;
  kind: 'digital' | 'analog';
  name: string;
}

interface SignalColumns {
  signal: SignalId;
  start: SamplePos;
  end: SamplePos;
  bins: number;
  status: Uint8Array;                 // 0 ok, 1 pending, 2 gap
  digital?: { low: Uint8Array; high: Uint8Array; edge: Uint8Array; packed: Uint8Array };
  analog?: { min: Float32Array; max: Float32Array; mean: Float32Array };
}

interface GapSpan { group: string; signal?: SignalId; start: SamplePos; end: SamplePos; reason: GapReason }

interface RecordController {
  readonly state: 'off' | 'armed' | 'recording' | 'paused' | 'exporting' | 'error' | 'full';
  readonly bytes: number;
  arm(): void;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
  export(): Promise<void>;
}
```

- `query` is O(bins), never O(samples), for digital and analog. The pyramid is built on
  append; a bounded provisional envelope may be used when a builder is behind. Analog
  samples are stored as calibrated volts; the raw codes and calibration id stay in the
  record manifest.
- Digital columns carry low/high/edge/pending; analog columns carry min/max/mean and
  status. `packed` is laid out for direct upload as a WebGL2 texture.
- `GapSpan` carries `reason` (`dropout`, `overrun`, `suspend`, `record-gap`, `import-gap`,
  `store-full`) and a range. Overlaps merge; `gaps()` and `query` agree.
- The first non-empty `append` establishes the group's **origin** (its absolute sample
  position); positions before it are gap, never pending. Later appends stay contiguous,
  and `dropBefore` never renumbers positions.
- `noteGap` may report a span ending past `newest`: it is a pending gap watermark, so a
  device can report a dropout before the bytes after it arrive. An append that starts
  beyond `newest` is accepted only when a group-wide gap covers the skipped span; the
  store pads that span internally and continues to report it as gap. Uncovered skips
  remain a typed `non-contiguous` error.
- Retention is bounded by `maxSamples` (the profile/UI budget); exceeding it is a typed
  `store-full` error, never an unhandled append or a silent truncation.
- `dropBefore` drops every group before a canonical time, so multi-rate groups stay
  aligned; the record is never affected. The quantum is a store detail, not a time-base
  change.

### 4.3 Retention and recording are orthogonal

- **Retention** is the display window in RAM: a finite capture length, or the rolling
  Loop window. It is bounded by a per-profile budget and a hard store ceiling; exceeding
  it yields a typed `store-full` state, not an unhandled append.
- **Record** is an archive in OPFS: chunked, checksummed, crash-recoverable, independent
  of the display window. A Loop can roll in RAM while recording every delivered sample.
- Record states: `off`, `armed`, `recording`, `paused`, `exporting`, `error`, `full`.
  A record manifest lists chunks, byte ranges, absolute time ranges, gaps, profile and
  calibration; an interrupted record is recoverable. `src/data/opfsRecord.ts` implements
  the storage-agnostic chunk writer/reader and manifest recovery; `opfsStorage.ts` is the
  browser OPFS adapter, and `recordController.ts` connects it to SignalStore. The
  acquisition/display path never awaits record I/O; a record failure surfaces as typed
  state and does not stop the capture. The Record UI still needs its presenter wiring.
- Export writes `.lwcap` v2 (signals, rates, gaps, trigger metadata, profile id) through
  the save picker/share/download. Raw CSV and VCD/FST are optional exporters; the format
  header states which signals/rates/gaps it can represent.
- `.sr` export (`src/ui/srSave.ts`) writes a sigrok session v2 zip: `version`=2, a
  `metadata` INI (`capturefile=logic-1`, `total probes`, `samplerate`, `total analog=0`,
  `probeN` = channel names, `unitsize = ceil(probes/8)`) and `logic-1-K` sample members of
  at most 4 MiB, deflated through `CompressionStream('deflate-raw')` when available. The
  probes are the enabled channels in channel order. It represents no gaps (a probe holds
  its level across a gap, as `.lwcap`'s `channelAcrossGaps`), no trigger position (no
  documented metadata key) and no sigrok analog channels: an analog group is written as
  its eight raw digital inputs. Members are generated chunk by chunk from a synchronous
  snapshot of each probe's edge list and streamed to the picker's writable (or collected
  as Blob parts), never concatenated; archives past 4 GiB are refused (no ZIP64).

### 4.4 Memory and quota

- RAM budget and OPFS quota are separate. The UI shows retention bytes, record bytes and
  the remaining quota; a refusal is typed (`memory`, `quota`, `record-full`).
- Eviction never changes absolute positions or the record. A forced trim is a visible
  state and never silently changes the trigger lock.
- OPFS writes are chunked and asynchronous; the acquisition/display path never waits on
  storage. A storage failure marks the record `error` and keeps acquisition running.

### 4.5 Import

- Import parses in a worker with size/structure limits; untrusted files never execute.
- `.sr`/`.lwcap` and waveform files map to signals and groups; missing rates are inferred
  only when the file states them, otherwise the import asks or refuses.
- Imported data is record-tier (immutable) and can be viewed/decoded but not appended to.
- An old `.sr` whose `total probes` exceeds what `unitsize` bytes carry (sigrok-dumps'
  DS1307: 32 probes, unitsize 1) loads its first `unitsize * 8` probes; the rest have no
  bits in the data and are dropped. A dismissible file notice names how many; it clears on
  the next Open and when a capture starts.

## 5. Trigger, acquisition, recording and view

### 5.1 TriggerPlan

A single compiled plan drives device and host execution:

```ts
interface TriggerPlan {
  source: 'digital' | 'analog' | 'mixed';
  conditions: readonly TriggerCondition[]; // AND on one complete sample
  execution: 'device' | 'host';
  preTrigger: {
    percent: number; seconds: number; capBytes: number;
    samples?: number; capBytesIsBound?: boolean;
  };
  budget: TriggerBudget;
  loop?: { seconds: number; anchor: 'trigger' | 'free' };
  compiledAt: number;
}
```

```ts
// SignalId/SamplePos: §4.2; ChannelCount/LinkRate: §3.2.
type TriggerCondition =
  | { kind: 'digital'; signal: SignalId; mode: TriggerKind; level?: 0 | 1 }
  | { kind: 'analog'; signal: SignalId; mode: AnalogTriggerKind; volts: number; hysteresis?: number };

type TriggerBudget =
  | { kind: 'samples'; value: number }
  | { kind: 'time'; value: number }
  | { kind: 'unlimited' };
```

- Digital conditions: level, rising, falling, edge, high, low. Analog conditions: rising
  or falling crossing of a level, optional hysteresis, one or more analog groups when the
  profile supports it. Conditions are ANDed. (P0/P1 here are trigger phases; platform
  rules are P1–P10 in §1.3.)
- **Analog crossings are qualified, never raw.** The ADC module's bus is sampled
  asynchronously to its code transitions, so at a carry boundary the host can read the OR
  of the old and new codes (143→144 reads 159, 127→128 reads 255) for up to ~140 ns —
  measured 2026-11-06 on a 32U3 at 100 MS/s: 1338 such runs in 10 ms, every one at a carry
  boundary, 1–14 samples long. A raw "previous < level ≤ current" test therefore fires on
  the falling slope of a Rising condition. Every analog executor (the `SoftwareTrigger`
  matcher behind Single/Repeat and the host plan, and the Loop page scanner) applies one
  rule: **hysteresis** — rising arms only after a code ≤ `level − h`, falling after a code
  ≥ `level + h`, h = 4 codes — and **persistence** — a candidate (the first armed sample
  at or past the level) is confirmed only when the code stays at or past the level for
  `P = ceil(240 ns × samplerate)` samples (24 at 100 MS/s); a sample back across the level
  drops the candidate and keeps the arm. The arm persists too: it needs P consecutive
  codes past `level ∓ h`. The OR only ever raises a code, so it fakes a rising candidate
  and a *falling arm* (111→112 reads 127, arming Falling 112 on the rising slope); with
  P = 1 both rules are one sample. T is the candidate sample, not the confirming one.
  Candidate state carries across transfers and gaps reset it; the matcher keeps at most
  P − 1 samples beyond the pre-trigger ring so the emitted prefix still ends at T, the
  persistence samples count toward the search limit, and a candidate inside the pre-fill
  holdoff is consumed. Mixed digital + analog: the digital part must hold on T. On the
  measured trace this confirms 1000/1000 crossings on the right slope (raw: 8651 of 17985
  detections on the wrong one) with T −0.2…+0.7 µs from the smoothed crossing. h and the
  240 ns window are constants beside the ADC scale data; displayed and saved samples are
  not filtered.
- **P0 keeps the single-family rule** (digital *or* analog) to preserve current
  behaviour. **P1 allows mixed digital + analog** when `profile.trigger.mixed` is true.
  The UI does not offer mixed conditions on a profile that cannot execute them.
- `execution` comes from the profile. A host plan runs in `dsp` on complete samples; a
  device plan is downloaded and its match is reported by the firmware. Both report T in
  absolute emitted-stream coordinates and use the same pre-trigger/budget rules. M0 ships
  the compiler, the SimDriver executor and the digital host executor adapter
  (`src/dsp/hostTrigger.ts`, reusing the bounded `SoftwareTrigger` matcher); analog/mixed
  plan execution and production device/capture wiring remain M1 work.
- `budget.kind='samples'` is expressed on the reference digital group's rate; a
  mixed/multi-rate plan uses `time` so every group shares one budget.
- The pre-trigger ring is bounded by `preTrigger.capBytes`, which is also T's position in
  the Loop window (0% on the left edge). When the compiler has no capture rate/width it
  reports the profile's hard byte cap and sets `capBytesIsBound`, so consumers do not
  mistake an upper bound for T's position. `preTrigger.samples` is the authoritative exact
  whole-sample prefix when the compiler can derive it; consumers must not recover the
  count by flooring `seconds * samplerate` (the float round-trip can lose a sample). The
  percentage applies to the requested post-trigger budget for Single/Repeat and to the
  Loop window for Loop; it is not a percentage of total retained bytes. A Loop plan is
  accepted only with an `unlimited` post-trigger budget, so it cannot carry a second
  finite window. A finite acquisition retires `preTrigger.samples + post-trigger samples`
  in total.
- **Pre-fill holdoff.** Like an oscilloscope, an executor ignores matches until
  `preTrigger.samples` complete samples have been observed since arming, so a dense
  trigger signal cannot fire on its first edge with an empty prefix: T is exactly
  `preTrigger.samples` in the emitted stream and the split is pre before T, post from T.
  Edge/crossing state at the first eligible sample is its true predecessor (the newest
  ring sample, including one carried across a transfer boundary), so an edge landing on
  that sample is valid. Holdoff samples are inspected and count toward the search limit
  (Repeat's limit is therefore `pre + (pre + post)`: after the holdoff a sweep can still
  match anywhere in one sweep's `pre + post` window, as it could before the holdoff). A
  continuity reset or gap (`resetContinuity`/`noteGap`, or a SimDriver waiting dropout)
  empties the ring and restarts the holdoff so the prefix never spans the gap; a retune
  keeps the ring and the remaining holdoff. Each Repeat wave and each Single starts a new
  acquisition and so a new holdoff; Loop holds off only its first match (later matches are
  on the already-emitted stream, which the D window owns). The ring stays the only
  pre-trigger storage. If a triggered Single/Repeat capture still holds less pre-trigger
  than configured, the trigger status reports the actual amount
  (`capturePanel.preTriggerObtained`). While the holdoff runs the status shows its
  progress (`preTriggerFill`, `capturePanel.preTriggerFilling`): elapsed is wall time
  since `device.start()` resolved at the capture rate, total is the effective
  `preTrigger.samples`. It is an estimate (the matcher sends nothing while waiting) that
  can end up to the RUN-to-first-byte latency early, never noticeably late.
- Retune: while waiting, a new plan is recompiled and sent; edge continuity restarts.
  After a match, edits are pending for the next acquisition unless the profile supports a
  live detector (analog Loop). A restart is a named transition with a typed reason; it
  never reuses the user Stop path. Explicitly enabling the trigger during a free-running
  capture restarts it to arm (with a visible "Restarting" note); an auto-arm from
  configuring the first condition does not restart (`armDeferred` in `reconcileTrigger`),
  and arms the next acquisition instead.
- Loop: D is the fixed data window, V the user viewport. A digital Lock is one-shot and
  releases when T leaves retention; an analog detector can re-lock when edges return. The
  plan owns the anchor, not the UI. The acquisition executor enforces D by calling
  `dropBefore` after delivered chunks; SignalStore does not infer a window from the plan,
  so a consumer that forgets the drop is the bug, and the store's `maxSamples` remains the
  hard backstop.

### 5.2 Composite state machine

Four state zones are tracked independently; the UI renders their tuple:

| Zone | States |
| --- | --- |
| Connection | `unsupported`, `idle`, `selecting`, `opening`, `claiming`, `handshaking`, `ready`, `busy`, `suspended`, `lost`, `closed` |
| Acquisition | `idle`, `arming`, `waiting`, `running`, `stopping`, `restarting`, `retrying`, `suspended`, `lost` |
| Recording | `off`, `armed`, `recording`, `paused`, `exporting`, `error`, `full` |
| View | `follow`, `fixed`, `triggerLocked` |

- Commands are events (`connect`, `disconnect`, `start`, `stop`, `retune`, `restart`,
  `pause`, `resume`, `export`, `record-error`, `record-full`, `lost`, `completed`); each
  returns the next tuple and a declared side-effect list in one pure module.
- A record can start or be armed only while the connection is `ready`; there is no fake
  recording state over an idle, closed, suspended or lost link.
- `suspended` freezes acquisition and recording; on resume the link re-handshakes. A
  device that no longer holds the stream becomes `lost`, never a fake continuation.
- `mayEdit(feature, context)` is the only capability decision. It returns `allow`,
  `next`, `restart` or a typed refusal with a stable code plus diagnostic prose; the UI,
  host interface and debug surface use it. No local `captureLocked` predicates.
- The transition function's refusals are typed the same way (`invalid-event`,
  `link-state`, `acquisition-state`, `record-state`, `trigger-state`, `no-op`,
  `lost`, `suspended`, `stopping`, `unknown-state`).
- A restart is a first-class transition with its own visible phase. It must not tear down
  the session as a user stop would, and it must not discard a displayed capture silently.

Key transitions (the full table is generated in one pure module):

| From | Event | To |
| --- | --- | --- |
| acquisition `idle` | `start` | `arming` |
| `arming` | device ready, plan waits | `waiting` |
| `arming` | device ready, free run | `running` |
| `waiting` | match | `running` |
| `waiting` / `running` | `stop` | `stopping` |
| `stopping` | drained | `idle` |
| `waiting` / `running` | `restart` | `restarting` |
| `restarting` | re-armed | `arming` |
| any | page hidden / device suspend | `suspended` |
| any | device/transport loss | `lost` |
| record `off` | `arm` | `armed` |
| record `off` | user starts recording | `recording` |
| record `armed` | acquisition starts | `recording` |
| record `recording` | `pause` | `paused` |
| record `paused` | `resume` | `recording` |
| record `recording` | acquisition stops / user stops | `paused` → explicit export → `off` |
| record any active | `record-error` / `record-full` | `error` / `full`, exported explicitly |
| view `follow` | pan/zoom | `fixed` |
| view `fixed` | Fit | `follow` |
| view `follow` | trigger match (Loop) | `triggerLocked` |
| view `fixed` | trigger match (Loop) | `fixed` (the user's view wins) |
| view `triggerLocked` | lock release | prior policy |

### 5.3 Settings transaction

- `settings` is private to `commitSettings(next, reason)`. The pipeline:
  clamp/validate against profile/capabilities → carry duration → apply live/pending
  classification → device acknowledgement for device-side settings → trigger recompile →
  persist → relayout → render.
- A commit returns both the canonical `next` configuration (including pending/restart
  keys) and the `applied` configuration the active acquisition actually uses. It compiles
  `activePlan` from `applied` and `nextPlan` from `next`; a pending edit never retunes or
  recompiles the active plan. `recompile-trigger` is emitted only when the active plan
  changed, and `disarm-trigger` when an active mask is turned off.
- **Viewed capture vs next capture.** `settings` (and `widthExplicit`) are always the
  *next* capture's setup: width, rate, trigger, mode. An opened `.sr`/`.lwcap` is only
  the *viewed* capture: `adoptCapture` swaps in the file's store and rows and never
  commits, clamps or persists settings from it. While the label is `loaded`,
  `displayChannelCount()` follows the file's rows, the width tiers still follow the
  device (and edit the next capture), and the device channel layout (names, colours,
  enabled, order) is set aside in `deviceLayout`; the workspace keeps persisting that
  layout, and the next Start restores it before growing the model to the device width.
  A device reconnect while a file is shown leaves both untouched. Not carried across a
  file: bus/analog views and decoders that address channels the file lacks are still
  dropped (and an analog trigger level with its view) - they belong to the rows shown.
- Recording is an acquisition command, not a `CaptureConfig` setting: the Capture menu and
  the Record panel dispatch the same record command, so there is one owner of record state.
- Panels send field patches, never whole snapshots. A preview gesture writes a draft;
  the canonical settings change only on commit.
- A device-side setting is not committed until the device acknowledges it. A refusal
  leaves the previous value, shows the typed reason and keeps the draft for correction.
- Every setting has a `settingPolicy`: `live`, `next`, `view` or `preference`, plus a
  profile capability key. A new field without a policy entry fails the design-contract
  test.

### 5.4 Session and sweep

- An **acquisition** is one Capture→Stop run. A **sweep** is one device RUN→STOP: Single
  has one, Repeat one per Interval, Loop one unbounded. Retention is the sweep's kept
  data; recording is independent.
- A new session starts FollowLive. A user pan/zoom stores a Fixed interval relative to
  `displayOrigin`; Fixed survives Repeat waves while it fits retention and otherwise falls
  back to the mode default, never an automatic Fit.
- A Single that completes while still FollowLive shows the whole capture (T stays the
  origin). A manual stop, a Fixed view, a Repeat wave and Loop keep their view.
- Repeat never shows a vacuum: while the next wave waits or has no data at the viewport,
  the previous completed wave (with its own T) is displayed as a composite layer. A miss
  ends the wave as completed and the next Interval retries.
- One `DisplayState` (`wave`, `front`, `composite`, `showingFront`, `heldTrigger`) has
  named transitions; one `endSessionDisplay(reason)` is used by stop, import, device
  loss, restart and pending-repeat cancel.

### 5.5 View state and workers

- The session owns one `ViewState { policy, anchor, offsets, follow }`; the Loop lock is a
  policy variant. Gestures, Fit, overview, trigger match/release and session adoption
  emit one view event into one transition function.
- With `crossOriginIsolated`, the pipeline ring and DSP/decode work use a
  `SharedArrayBuffer`; without it, use transferable buffers and cancellation by worker
  restart. The capability is exposed by `src/platform`, never sniffed.

## 6. Panels and view models

- `PanelId` is declared once: `device`, `acquire`, `trigger`, `measure`, `analyze`,
  `record`, `settings`, `diagnostics`. Each panel owns exactly one host it may clear.
- **One view model, three presenters.** The same immutable panel view model is rendered by
  `Docked` (wide mouse/pen), `Sheet` (medium/compact touch) or `Dialog` (modal). The
  DOM-free decision table and single-slot invariant live in `src/ui/presenters.ts`; the
  actual panel hosts still adopt it. The
  presenter owns placement, dismissal, focus and back; the panel owns content and
  callbacks.
- A panel exposes `render(view)` and, if needed, `update(view)` over every field that can
  change without a rebuild. Missing nodes throw; cached element references are not a
  second source of truth. View models are presentation-ready; panels do not re-derive
  armed/capability/formatting values.
- One `OverlayController` owns the stack of menus, popovers, sheets and dialogs. Opening
  one closes its transient siblings; Escape/back closes the topmost; focus returns to the
  invoker by token.
- The Assistant chat is not part of the baseline and has no toolbar/panel entry. The same
  host interface remains available to external AI agents through the debug
  `agentHost` surface; the repository Skill documents the CDP/user-gesture workflow.

## 7. Persistence and delivery

### 7.1 Persistence tiers

| Tier | Contents | Restored |
| --- | --- | --- |
| Link/device | selected device, serial, profile id; permissions live in the browser | on reload with `getDevices()` |
| Workspace | channel/analog layout, names, colors, trigger configuration, decode setup, panel layout | on reload |
| Record | OPFS chunks, manifest, gaps, trigger metadata, calibration reference | on resume/import |
| Preferences | theme, locale, density, unit system, touch layout | on reload, separate store |
| Transient | progress, hover, open overlays, drafts | never |

- The workspace schema is one field table (name, type, default, clamp, version,
  migration); restore, serialize and the pre-paint boot script derive from it. No pre-paint
  script restates keys or clamps.
- A record manifest is versioned; recovery validates chunk checksums and marks an
  interrupted record as recoverable, never silently truncated.
- A saved capture carries profile id, group rates, calibration reference, gaps and trigger
  metadata so it replays without the device.

### 7.2 Offline and delivery

- PWA shell caches only first-party assets; versioned precache, explicit update prompt,
  no background sync of user data. Offline replay works; acquisition requires the device.
  **[SHIPPED]** for hosted builds (`src/pwa/sw.js`, hand-written, no workbox;
  `src/pwa/shell.mjs` from a Vite `closeBundle` step; `src/ui/pwaUpdate.ts`):
  - The build enumerates `dist/` into the worker: **shell** = `index.html`, hashed worker /
    locale / lazy chunks, favicon, icons, `manifest.webmanifest`; **runtime** = every
    `pyodide/<hash>/` file and `decoders/decoders-<hash>.zip`. Source maps, licences,
    host files and the entry JS/CSS already inlined into `index.html` are never listed.
    The version hashes every listed byte plus the worker template, and `index.html` is
    stamped with it (`<meta name="slogicweb-build">`).
  - Caches are `slogicweb:<scope>:shell-<version>` (one per version; activation deletes
    every other version of the scope) and `slogicweb:<scope>:runtime` (name-stable, pruned to
    the URLs the active build lists, so an unchanged Pyodide survives a shell update).
  - Install fetches `index.html` with `cache: 'reload'` and a version query, and refuses a
    copy without the matching stamp (a stale CDN copy fails the install; it retries later).
    Hashed files are reused from any older cache, else fetched normally.
  - `index.html` is network-first with a 4 s timeout and 5xx fallback to the install-time
    copy; the network copy is never stored. Listed shell files are cache-first. Cross-origin,
    non-GET, range and unlisted requests (e.g. `/ota/`) pass through untouched.
  - Pyodide/decoders (~14 MB): filled **best effort at install** while App warms the decode
    worker at boot (the page downloads those bytes on its first visit anyway, and the HTTP
    cache answers the fill), and otherwise cached on first use. A failed fill never fails
    the install. If warm-up becomes on-demand, drop the fill: the runtime is then purely
    lazy, so a phone that never decodes never pays for it.
  - No `skipWaiting` on install. A waiting version raises a localized notice with Reload;
    only that click posts `SKIP_WAITING`, and the page reloads on `controllerchange`.
    Registration happens after App constructs, only when `__SLOGICWEB_PWA__` (false for
    `vite` dev and for the portable build), `navigator.serviceWorker`, a secure context and
    an http(s) URL all hold — never from `file://`. The portable build also emits no
    manifest, icons or worker file.
  - Deploy: purge `index.html` and `sw.js` (docs/DEPLOY.md).
- T0/T1/T2 hosting per §1.4. T1 is recommended for COOP/COEP and full CSP; T0 ships with
  the documented limitations; T2 serves isolated PCs from `localhost`.
- Export uses the save picker/share/download; OPFS is never presented as a user folder.
- Every runtime asset is staged into `dist/` before the build; the build fails if a
  vendored Pyodide/decoder or reference capture is missing. A sub-directory deployment
  builds with `--base`; `file://` is not usable ([MEASURED]). A T0 deployment without
  COOP/COEP has no `SharedArrayBuffer`; decode cancellation respawns the worker.

## 8. Decoding

- Decode runs in a worker. The default runtime is first-party TS/WASM decoders; Pyodide
  is an optional, on-demand extension for stock sigrok decoders. Pyodide's measured cold
  start is ~870 ms (13–46 ms warm), which the phone default must not pay.
- The worker receives edges/gaps and a decode request (decoder id, options, channel map),
  returns typed annotations and progress, and can be cancelled. With `isolated`, cancel
  interrupts; without it, the worker is killed and respawned.
- Decoding is snapshot-based for a running Loop: the result states which window it
  describes and does not pretend to track every roll. A decode failure is a typed error
  in the panel, never a traceback.
- Bus views are display constructs built from signals; they do not change capture
  channels or trigger conditions. Decode never blocks acquisition.
- Only shipped decoders run; user-supplied decoder code is out of scope. Licensing and
  notices are part of the delivery artifact.

## 9. Security and local trust

**Threat model:** malicious capture/import files, a malicious or compromised device,
cross-site scripting through imported strings, a compromised dependency/CDN, another tab
claiming the interface, and accidental data loss. The app is local-first; it does not
protect a compromised OS or browser.

- **No third-party runtime, no network dependency.** All scripts, WASM and decoders are
  first-party or vendored build assets; no CDN, analytics, telemetry or remote logging.
- **CSP.** T1 uses `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <hashes>;
  style-src 'self'; style-src-attr 'unsafe-inline'; worker-src 'self' blob:;
  img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'`. T0 uses the same directives possible in a `<meta>` policy plus
  a top-level frame check. Inline boot scripts are hashed or moved to files; no `eval` on
  imported data. The inline-style allowance is limited to dynamic geometry/signal colour
  values, never untrusted strings.
- **USB.** Fixed VID/PID filters, user-gesture permission, exclusive claim, no
  auto-claiming of unknown devices. Device strings are untrusted text and are sanitised
  before display. A device that claims impossible capabilities is rejected by the
  profile handshake.
- **Files.** Imports are untrusted; parse in a worker with size/structure limits; never
  execute file content; never write outside the chosen export target.
- **OPFS.** Records stay in the origin's private storage; clearing site data deletes
  them; the UI explains this. No record bytes leave the device unless the user exports.
- **Supply chain.** Lockfile, vendored assets, build-time integrity check, license
  notices; dependency changes follow the security review.
- **Android.** USB permission is requested by the system; the app does not request
  unrelated permissions. Background suspension is handled, not bypassed.
- **Boundary.** Security is self-responsibility for the local machine/network; the app
  documents what it does and does not protect.

## 10. Verification and benchmarks

- **Contract tests** for Profile validation, LinkSession transitions, SignalStore query
  semantics (including `pending`/`gap` and multi-rate), TriggerPlan compilation, the
  composite state machine, settings transaction, persistence round-trip and security
  headers.
- **SimDriver fault injection:** short packets, stalls, dropouts, malformed frames,
  disconnects, suspend/resume, quota exhaustion. Fuzz the frame/import parsers.
- **Behaviour tests** for panels/presenters; no source-text assertions for behaviour. A
  design-contract test validates the ownership/capability tables, the profile schema and
  the absence of model branches.
- **Soak:** a multi-hour Loop with recording enabled, memory/OPFS watch, no unbounded
  growth. **Device matrix:** confirmed profiles on Windows/Linux/macOS and Android OTG.
- **Performance:** sustained pan/zoom framerate on a 100M-sample digital capture; open
  time for a large `.lwcap`; decode annotations/s; link throughput and record throughput;
  touch frame pacing on a mid-range Android device. Scripts are re-runnable.
- **Security tests:** CSP violations, third-party request checks, imported-file fuzz,
  frame-embedding check on T0, OPFS quota handling.
- **Release gates:** M0 = link/profile/SignalStore digital/trigger/state/docs; M1 = analog
  first-class, mixed trigger, multi-rate, touch shell, record; M2 = PWA/offline, decode
  runtime, full matrix, security hardening.

## 11. Roadmap

| Milestone | Scope |
| --- | --- |
| M0 | Platform probes, LinkSession, DeviceProfile, SignalStore digital, TriggerPlan P0, composite state machine, settings transaction, docs split, SimDriver |
| M1 | Analog groups as first-class signals, multi-rate timeline, mixed trigger P1, analog/mixed and device executors plus capture wiring, touch shell and presenters, recording/OPFS, measurements/math/FFT |
| M2 | First-party decode runtime default, Pyodide optional, PWA/offline (shell shipped, §7.2), security hardening, Android/device matrix, migration completion |

The M0/M1/M2 gates are product decisions, not estimates. A feature that is not in the
current milestone is not merged behind a hidden flag; it waits for its milestone.

## 12. Rules for every builder

- Check the reply of every device command before trusting what follows.
- Fail loudly and early. No silent catch blocks.
- Report what you measured, including misses.
- Capabilities come from `DeviceProfile`; no model branches.
- The capture path is never blocked by display, measurement or storage.
- Any network behaviour requires a security-contract change (§9).
- Interface changes follow `docs/DESIGN.md`; update both contracts in the same change.
