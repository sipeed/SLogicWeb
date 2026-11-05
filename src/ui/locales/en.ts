// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Daniel Tralamazza
/**
 * English message catalog - the source of truth for the shell's i18n key set.
 *
 * Every key is flat and dotted ('toolbar.start'), so it maps 1:1 onto the
 * `data-i18n` attributes in index.html and keeps `Messages` a trivially checkable
 * Record. The other locale catalogs (src/ui/locales/<locale>.ts) are declared as
 * `: Messages`, which makes a missing, extra, or renamed key a tsc error.
 *
 * Values are character-identical to the strings the shell rendered before
 * externalization (tools/i18n-selftest.ts pins the index.html side of that). Text
 * that is data or notation is NOT here on purpose: SI/number formatting
 * (format.ts), decoder names/descriptions, diagnostic error payloads,
 * `sourceDescription` (baked into .lwcap files), canvas glyphs, and the
 * A/B/|B-A| status symbols.
 */

export const en = {
  // ------------------------------------------------------------- toolbar
  'toolbar.device': 'Device',
  'toolbar.connect': 'Connect device',
  'toolbar.reconnect': 'Reconnect',
  'toolbar.webusbUnavailable': 'WebUSB unavailable',
  'toolbar.connectHint': 'Click Connect and pick an SLogic16/32 U3. The grant is remembered for this origin.',
  'toolbar.noWebusb': 'WebUSB is unavailable in this browser. Use Brave or Chrome over http://127.0.0.1.',
  'toolbar.start': 'Capture',
  'toolbar.stop': 'Stop',
  'toolbar.stopping': 'Stopping…',
  'toolbar.open': 'Open…',
  'toolbar.save': 'Save',
  'toolbar.fit': 'Fit',
  'toolbar.fullscreen': 'Fullscreen',
  'toolbar.shortDevice': 'Device',
  'toolbar.shortStart': 'Capture',
  'toolbar.shortStop': 'Stop',
  'toolbar.shortStopping': 'Stopping…',
  'toolbar.shortOpen': 'Open',
  'toolbar.shortSave': 'Save',
  'toolbar.shortFit': 'Fit',
  'toolbar.shortFullscreen': 'Fullscreen',
  'toolbar.shortSettings': 'Settings',
  'toolbar.shortAssistant': 'Assistant',
  'toolbar.shortLanguage': 'Language',
  'toolbar.shortTheme': 'Theme',
  'toolbar.startTitle': 'Capture on the connected device',
  'toolbar.stopTitle': 'Stop the running capture',
  'toolbar.stoppingTitle': 'Waiting for pending USB transfers to be cancelled',
  'toolbar.openTitle': 'Load a sigrok .sr session or a .lwcap',
  'toolbar.saveTitle': 'Save this capture as .lwcap',
  'toolbar.fitTitle': 'Zoom to the whole capture',
  'toolbar.enterFullscreenTitle': 'Enter fullscreen',
  'toolbar.exitFullscreenTitle': 'Exit fullscreen',
  'toolbar.fullscreenUnavailable': 'Fullscreen unavailable',
  'toolbar.themeTitle': 'Toggle theme',
  'toolbar.languageTitle': 'Choose language',
  'toolbar.switchGroup': 'Language and theme',
  'toolbar.viewGroup': 'View and settings',
  'toolbar.assistantTitle': 'AI assistant',

  // ---------------------------------------------------------- side panel
  'sidebar.pageCapture': 'Capture',
  'sidebar.pageCursors': 'Cursors',
  'sidebar.pageDecoders': 'Decoders',
  'sidebar.pagesLabel': 'Sidebar pages',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',
  'panel.resizeLabel': 'Resize sidebar',
  'panel.resizeTitle': 'Drag to resize the sidebar',

  // ---------------------------------------------------- capture title
  'capture.none': 'no capture',
  'capture.capturing': 'capturing {channels} ch @ {rate}',
  'capture.loaded': '{source} · loaded in {ms} ms',
  'capture.stoppedNoTrigger': 'no trigger · {samples} samples retained',
  'capture.live': 'live capture · {samples} samples @ {rate} · {duration}',

  // ------------------------------------------------------------- status
  'status.previousWave': 'previous wave shown',
  'status.summary': '{samples} samples @ {rate}',
  'status.total': '{duration} total',
  'status.loop': '{kept} kept · {total} total',
  'status.view': 'view {duration}',

  // -------------------------------------------------------- empty hint
  'emptyHint.line1': 'No capture loaded.',
  'emptyHint.line2': 'Open a .sr or .lwcap file, or connect an SLogic16/32 U3.',

  // ------------------------------------- error prefixes (App.fail sites)
  'error.render': 'render',
  'error.device': 'device',
  'error.openCapture': 'open capture',
  'error.save': 'save',
  'error.reconnect': 'reconnect',
  'error.connect': 'connect',
  'error.start': 'start',
  'error.startCapture': 'start capture',
  'error.stopCapture': 'stop capture',
  'error.dropoutAccounting': 'dropout accounting',
  'error.decodeWorkerWarmup': 'decode worker warmup',
  'error.decode': 'decode {id}',
  'error.localeLoad': 'Could not load the language catalog',

  // ---------------------------------------- status error detail codes
  'diagnostic.ui.localeLoad': '"{locale}" failed to load',
  'diagnostic.ui.axisContext': 'axis 2D context unavailable',
  'diagnostic.ui.captureLocked':
    'bank oscilloscope settings are locked while capture is running or stopping',
  'diagnostic.io.nothingToSave': 'nothing to save',
  'diagnostic.file.noFiles': 'no files selected',
  'diagnostic.file.unsupported':
    'nothing loadable in {names}; expected a sigrok .sr session or a .lwcap',
  'diagnostic.file.lwcap.header':
    'truncated .lwcap: {bytes} bytes is shorter than the {need}-byte header',
  'diagnostic.file.lwcap.magic': 'not a .lwcap file (magic {magic})',
  'diagnostic.file.lwcap.channels':
    'channel count {channels} is not a supported width ({widths})',
  'diagnostic.file.lwcap.length': 'implausible capture length {length}',
  'diagnostic.file.lwcap.samplerate': 'implausible .lwcap samplerate {samplerate}',
  'diagnostic.file.lwcap.namesTruncated':
    'truncated .lwcap: name blob of {bytes} bytes runs past the end',
  'diagnostic.file.lwcap.namesInvalid': 'invalid .lwcap channel names',
  'diagnostic.file.lwcap.gapTruncated':
    'truncated .lwcap: gap span {index} runs past the end',
  'diagnostic.file.lwcap.gapSpan': 'corrupt gap span [{start}, {end}) in {source}',
  'diagnostic.file.lwcap.gapOrder': 'gap spans overlap or are unsorted at index {index}',
  'diagnostic.file.lwcap.channelHeaders':
    'truncated .lwcap: channel headers run past the end',
  'diagnostic.file.lwcap.initial':
    'corrupt .lwcap: channel {channel} starts at level {level}',
  'diagnostic.file.lwcap.edgeBytes':
    'truncated or trailing bytes in .lwcap ({actual} vs {expected})',
  'diagnostic.file.lwcap.edgeRange':
    'corrupt .lwcap: channel {channel} edge {index} = {value} outside [1, {length})',
  'diagnostic.file.lwcap.edgeOrder':
    'corrupt .lwcap: channel {channel} edges are not strictly increasing at index {index}',
  'diagnostic.file.sr.notZip': 'not a zip archive',
  'diagnostic.file.sr.multiDisk': 'multi-disk zip archives are not supported',
  'diagnostic.file.sr.corruptDirectory':
    'corrupt zip: the central directory runs past the end-of-central-directory record',
  'diagnostic.file.sr.directoryBounds':
    'corrupt zip: central directory entry {index} runs past the directory',
  'diagnostic.file.sr.zip64': 'ZIP64 archives are not supported',
  'diagnostic.file.sr.entrySignature':
    'corrupt zip: central entry {index} has no signature',
  'diagnostic.file.sr.dataDescriptor':
    'member {member} uses a data descriptor, which is not supported',
  'diagnostic.file.sr.memberZip64':
    'member {member} needs ZIP64, which is not supported',
  'diagnostic.file.sr.compression':
    'member {member} uses compression method {method}; only stored and deflate are supported',
  'diagnostic.file.sr.noLocalHeader':
    'member {member} has no local header where the directory says it is',
  'diagnostic.file.sr.localHeaderBounds':
    'member {member}’s local header runs past the end of the file',
  'diagnostic.file.sr.memberPastEnd': 'member {member} runs past the end of the file',
  'diagnostic.file.sr.memberSize': 'member {member} size mismatch',
  'diagnostic.file.sr.inflateFailed': 'could not decompress member {member}',
  'diagnostic.file.sr.inflateSize':
    'member {member} inflates to {actual} bytes, the directory says {expected}',
  'diagnostic.file.sr.noMetadata':
    '{source} has no metadata member, so it is not a sigrok session',
  'diagnostic.file.sr.duplicateCapturefile':
    'metadata has two capturefiles in one device section',
  'diagnostic.file.sr.analogCapture':
    'capturefile {capturefile} is not a logic unit; analog captures are not supported',
  'diagnostic.file.sr.noCapturefile': 'no logic capturefile in the metadata',
  'diagnostic.file.sr.noSamplerate': 'no samplerate in the metadata',
  'diagnostic.file.sr.probes': 'total probes {probes} is outside 1..128',
  'diagnostic.file.sr.analogChannels':
    'analog channels in this capture are not supported ({count} present)',
  'diagnostic.file.sr.unitsize': 'unitsize {unitsize} is outside 1..16 bytes',
  'diagnostic.file.sr.unitsizeProbes':
    'unitsize {unitsize} cannot carry {probes} probes',
  'diagnostic.file.sr.samplerate': 'unparsable samplerate {value}',
  'diagnostic.file.sr.dataLength':
    'data length {bytes} is not a whole number of {unitsize}-byte samples',
  'diagnostic.file.sr.tooLong': 'capture is too long ({samples} samples)',
  'diagnostic.file.sr.noData':
    '{source} has no data members for capturefile {capturefile}',
  'diagnostic.device.transportDead': 'the USB transport is dead ({reason})',
  'diagnostic.device.disconnected': '{device} was disconnected',
  'diagnostic.device.workerUnavailable':
    'the background USB worker is unavailable in this browser',
  'diagnostic.device.workerCrashed': 'the USB worker failed',
  'diagnostic.device.workerTimeout':
    'the USB worker did not answer "{kind}" within {ms} ms',
  'diagnostic.device.workerNoDevice': 'the USB worker did not report a device',
  'diagnostic.device.workerTerminated': 'the USB worker transport was terminated',
  'diagnostic.device.workerNoStats': 'the USB worker answered with no statistics',
  'diagnostic.device.workerNoConsole': 'the USB worker answered with no console result',
  'diagnostic.device.workerUnclaimed':
    'the USB worker answered "{kind}" with nobody waiting',
  'diagnostic.device.stopTimedOut':
    'the capture did not stop within {ms} ms; the USB transport was reset',
  'diagnostic.device.loopUnsettled':
    'the previous capture\'s read loop never settled after the interface was released',
  'diagnostic.device.loopUnsettledClosed':
    'the read loop never settled after the interface was released, so the device handle was closed',
  'diagnostic.device.reclaimFailed':
    'the interface could not be re-claimed after the capture was cancelled, so the device was closed',
  'diagnostic.device.unsupportedChannels':
    'unsupported channel count {channels}; this device offers {offered}',
  'diagnostic.device.unknownWidth':
    'device reported unsupported channel count {channels}',
  'diagnostic.device.unsupportedSamplerate':
    'unsupported samplerate {samplerate} Hz; the device offers {offered}',
  'diagnostic.device.rateCeiling':
    '{rate} MHz exceeds the {channels}-channel ceiling of {ceiling} MHz',
  'diagnostic.device.threshold': 'threshold must be a number, got {threshold}',
  'diagnostic.device.thresholdClips':
    'threshold {volts} V clips the DAC (code {code})',
  'diagnostic.device.testMode': 'test mode must be 0, 1 or 2, got {mode}',
  'diagnostic.device.tuningPacket':
    'transferBytes {bytes} is not a multiple of the {packet}-byte packet size',
  'diagnostic.device.tuningDepth':
    'transfer depth {depth} is below the 4 the device needs to not overrun',
  'diagnostic.device.tuningTransfer':
    'transferBytes {bytes} exceeds Chromium WebUSB’s {limit}-byte limit',
  'diagnostic.device.tuningQueue':
    'transfer queue {depth} x {bytes} B exceeds the safe {budget}-byte usbfs budget; raise usbfs_memory_mb and queueBudgetBytes together',
  'diagnostic.device.startRunning': 'start() called while already running',
  'diagnostic.device.startStopping':
    'start() called before the previous capture finished stopping',
  'diagnostic.device.startBeforeOpen': 'start() called before open()',
  'diagnostic.device.triggerLimitConflict':
    'softwareTrigger and deviceSampleLimit are mutually exclusive; bound a triggered capture with softwareTrigger.maxSamples',
  'diagnostic.device.coalescePacket':
    'coalesceBytes {bytes} is not a multiple of the {packet}-byte sample size',
  'diagnostic.device.triggerWidth':
    'software trigger width {width} does not match capture width {channels}',
  'diagnostic.device.bulkStatus': 'bulk IN returned status "{status}"',
  'diagnostic.device.bulkEmpty': 'bulk IN returned no data with status "ok"',
  'diagnostic.device.consoleBusy':
    'USB console is unavailable while a capture is running or stopping',
  'diagnostic.device.notOpen': 'device is not open',
  'diagnostic.device.notConnected': 'no device connected',
  'diagnostic.device.noConsole': 'this device does not expose a USB console',
  'diagnostic.device.sampleAccounting':
    'device counted {counted} samples delivered, store holds {stored}',
  'diagnostic.device.noData':
    '{device} delivered no data within {deadline} ms of RUN ({channels}ch @ {rate} MHz). A board in this state answers every control transfer and sends nothing on the bulk endpoint: unplug it and plug it back in.',
  'diagnostic.device.underrunStalled':
    '{device} overran the host: {channels}ch @ {rate} MHz offers {offered} MB/s for {count} consecutive transfers: {transferMs} ms for {bytes} B (limit {limitMs} ms), {avg} MB/s average over {runMs} ms (minimum {minimum} MB/s). Capture aborted before the device FIFO overflow wedged the endpoint. The {thread} thread was blocked {stalls} time(s) during the capture, worst {worstMs} ms at {atMs} ms; the queue covers {coverMs} ms.',
  'diagnostic.device.underrunClean':
    '{device} overran the host: {channels}ch @ {rate} MHz offers {offered} MB/s for {count} consecutive transfers: {transferMs} ms for {bytes} B (limit {limitMs} ms), {avg} MB/s average over {runMs} ms (minimum {minimum} MB/s). Capture aborted before the device FIFO overflow wedged the endpoint. The {thread} thread was never blocked for more than {thresholdMs} ms, so this is the device or the USB path.',
  'diagnostic.device.openFailed': 'could not open the USB device',
  'diagnostic.device.configureFailed': 'could not select the device configuration',
  'diagnostic.device.claimFailed': 'could not claim interface 0',
  'diagnostic.device.controlReadTimeout':
    'control read of reg {addr} did not complete within {ms} ms; the board stopped answering control transfers',
  'diagnostic.device.controlWriteTimeout':
    'control write to reg {addr} did not complete within {ms} ms; the board stopped answering control transfers',
  'diagnostic.device.controlWriteStatus':
    'control write to reg {addr} returned status "{status}"',
  'diagnostic.device.controlWriteLength':
    'control write to reg {addr} moved {bytes} bytes, expected 4',
  'diagnostic.device.controlReadStatus':
    'control read of reg {addr} returned status "{status}"',
  'diagnostic.device.controlReadLength':
    'control read of reg {addr} returned {bytes} bytes, expected 4',
  'diagnostic.device.controlRequestTimeout':
    'the USB console request {request} did not complete within {ms} ms; the board stopped answering control transfers',
  'diagnostic.device.registerStuck':
    '{where}={wanted} never stuck across {cycles} read/write/read cycles (wrote {wrote}, read back {readBack})',
  'diagnostic.device.sampleLengthRejected':
    'sample length not accepted: wrote {value}, read back {readBack} (compared over the {advertised} advertised byte(s))',
  'diagnostic.device.auxReadyTimeout':
    'aux selector {selector}: ready bit never set after {reads} reads',
  'diagnostic.device.auxEcho': 'aux selector {selector}: device echoed {echoed}',
  'diagnostic.device.auxZeroLength':
    'aux selector {selector}: device reported a zero-length payload',
  'diagnostic.device.auxValueTooWide':
    'aux selector {selector}: value {value} does not fit the {advertised} byte(s) the device advertised for payload word {word}',
  'diagnostic.device.auxWordOutside':
    'aux selector {selector}: payload word {word} is entirely outside the {bytes}-byte payload the device advertised',
  'diagnostic.device.auxFieldOutside':
    'aux selector {selector}: field ends at payload byte {endByte} but the device only accepts {accepted} bytes',
  'diagnostic.device.channelMaskRejected':
    'channel mask not accepted: wrote {mask}, read back {readBack} (compared over the {advertised} advertised byte(s))',
  'diagnostic.device.channelMaskRejectedPadded':
    'channel mask not accepted: wrote {mask}, read back {readBack} (compared over the complete four-byte padded word)',
  'diagnostic.device.sampleratePayload':
    'samplerate aux payload is {bytes} bytes, need at least 8 for the divider',
  'diagnostic.device.samplerateStuck':
    'could not configure {rate} MHz on base[{index}] = {base} MHz: the divider never stuck (wrote {wrote}, read back {readBack}, base before the write {before} MHz) across {cycles} read/write/read cycles',
  'diagnostic.device.samplerateBaseChanged':
    'could not configure {rate} MHz: the base clock moved from {before} MHz to {after} MHz (wrote divider {divider}, the device answered index {index}) across {cycles} read/write/read cycles',
  'diagnostic.device.samplerateAnswered':
    'could not configure {rate} MHz: wrote divider {wrote} on base {before} MHz, the device answered index {index} base {after} MHz divider {readBack} across {cycles} read/write/read cycles',
  'diagnostic.device.samplerateNotDivided':
    'could not configure {rate} MHz: base[{index}] = {baseMHz} MHz does not divide it ({count} bases checked; index {maxIndex} is the last one that exists)',
  'diagnostic.device.samplerateNotExpressible':
    'could not configure {rate} MHz: base[{index}] = {baseMHz} MHz needs divider {divider}, past the {maxDivider} the sampler honours ({count} bases checked; index {maxIndex} is the last one that exists)',
  'diagnostic.device.samplerateUnwalked':
    'could not configure {rate} MHz: the divider never stuck and no base clock became usable within {passes} passes',
  'diagnostic.device.thresholdRejected':
    'threshold not accepted: wrote code {code}, read back {readBack} (compared over the {advertised} advertised byte(s))',
  'diagnostic.device.testModeRejected':
    'test mode not accepted: wrote {mode}, read back {readBack} (compared over the {advertised} advertised byte(s))',
  'diagnostic.usb.unavailable': 'WebUSB is not available in this browser',
  'diagnostic.usb.blocked': 'the browser blocked access to USB devices',
  'diagnostic.usb.notVisible':
    'device {vendor}:{product} is not visible to the USB worker; grant it from the page first',
  'diagnostic.decode.cancelled': 'decode cancelled',
  'diagnostic.decode.noCapture': 'no capture to decode',
  'diagnostic.decode.channelOutOfRange':
    'channel {channel} is not in this capture ({channels} channels)',
  'diagnostic.decode.timeout': 'decode exceeded {ms} ms and was cancelled',
  'diagnostic.decode.disposed': 'the decode worker has been retired',
  'diagnostic.decode.workerCrashed': 'the decode worker failed',
  'diagnostic.decode.workerFailed': 'the decoder failed',
  'diagnostic.decode.workerUnexpected': 'the decode worker answered {got}, expected {want}',
  'diagnostic.decode.terminated': 'the decode worker was terminated',
  'diagnostic.decode.tooLong':
    'capture is {samples} samples; decoding is limited to {max} ({window} at 200 MSa/s). Decode a sub-range instead.',
  'diagnostic.decode.tooLongLoop':
    'capture is {samples} samples; decoding is limited to {max} ({window} at 200 MSa/s). Shrink the loop window instead.',
  'diagnostic.decode.edgeBudget':
    '{edges} edges on the mapped channels exceed the {budget} decode budget. Disable a channel or zoom the capture down.',
  'diagnostic.decode.edgeBudgetLoop':
    '{edges} edges on the mapped channels exceed the {budget} decode budget. Disable a channel or shrink the loop window.',
  'diagnostic.render.contextLost': 'WebGL context was lost; the renderer is dead',

  // -------------------------------------------------------- hover readout
  'hover.width': 'Width: {duration}',
  'hover.widthInv': 'width⁻¹: {freq}',
  'hover.freq': 'Freq: {freq}',
  'hover.duty': 'Duty: {pct} %',
  'hover.noTransition': 'no transition in view',

  // ---------------------------------------------------- trigger summary
  'trigger.level': 'Level {level}',
  'trigger.none': 'None',
  'trigger.off': 'Off',
  'trigger.rising': 'Rising edge',
  'trigger.falling': 'Falling edge',
  'trigger.anyEdge': 'Any edge',
  'trigger.summary': '{condition} · {pct}% pre-trigger',
  'trigger.summaryAnd': '{condition} · {pct}% pre-trigger · AND {count} conditions',

  // -------------------------------------------------------- channel list
  'channels.settings': 'D{index} settings',
  'channels.resetName': 'Reset name to D{index}',
  'channels.triggerOn': 'Trigger on {name}',
  'channels.triggerLevel': 'Level',
  'channels.triggerTip': 'Trigger on {name}: {mode}. Click to set',
  'channels.triggerAllNote': 'With conditions on several channels, all must hold at once.',
  'channels.renameHint': 'Double-click to rename',
  'channels.name': 'Channel name',
  'channels.color': 'Channel color',
  'channels.customColor': 'Custom color',
  'channels.colorField': 'Saturation and brightness',
  'channels.hue': 'Hue',
  'channels.triggerMode': 'Trigger mode',
  'channels.cancel': 'Cancel',
  'channels.removeAnalyzer': 'Remove {label}',
  'channels.triggerHigh': 'High level',
  'channels.triggerLow': 'Low level',
  'channels.triggerAny': 'Any value (X)',

  'overview.originTrigger': 'Trigger',
  'overview.originStart': 'Start',
  'overview.viewport': 'Showing {from} – {to}',

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': 'Digital',
  'capturePanel.channelWidth': 'Channel width',
  'capturePanel.channelWidthBusy': 'Channel width is locked while the capture is stopping',
  'capturePanel.analog': 'Analog',
  'capturePanel.analogCell': '{name} · analog ±15 V',
  'capturePanel.analogEnable': 'Read {range} as the ADC module\'s analog channel {name}',
  'capturePanel.analogDisable': 'Stop reading {name} as an analog channel',
  'capturePanel.analogBusy': 'Analog channels are locked while the capture is stopping',
  'capturePanel.analogNeedsEight': 'The ADC module reads eight inputs at a time',
  'capturePanel.analogUnsupported': 'The ADC module is only available on the SLogic32U3',
  'capturePanel.analogRateNote': 'Analog channels read the ADC module: rates follow its 800 MHz clock from 100 MHz up, and trigger conditions on their inputs are ignored while the group is analog.',
  'capturePanel.noAnalogTrigger': 'No analog trigger. Enable an ADC group, then use its Trigger control in the left channel column.',
  'capturePanel.analogSingleNote': 'Analog triggering locks the time base to one ADC group; choosing another moves the trigger.',
  'capturePanel.removeTrigger': 'Remove trigger on {channel}',
  'capturePanel.noDigitalTrigger': 'No digital trigger. Click a channel\'s trigger glyph in the left column to add one.',
  'capturePanel.triggerAnalog': 'Analog',
  'capturePanel.triggerDigital': 'Digital',
  'capturePanel.triggerSource': 'Trigger source',
  'capturePanel.pendingApply': 'Changes apply to the next capture; the running one keeps its configuration.',
  'capturePanel.pendingApplyLoop': 'Duration and Analog apply now; rate, channels and threshold apply to the next capture.',
  'capturePanel.pendingTrigger': 'This acquisition keeps the matcher it started with. New trigger settings apply to the next capture (Repeat: the next Interval; restart a Loop to re-arm). A Loop analog display detector retunes live.',
  'capturePanel.triggerMemoryReleased': 'Trigger released to keep the loop store within its memory ceiling. Restart the capture to arm it again.',
  'capturePanel.sampleRate': 'Sample rate',
  'capturePanel.threshold': 'Threshold',
  'capturePanel.dacNote': 'DAC code {code} = {volts} V actual. Capture width {channels} CH (ceiling {rate}).',
  'capturePanel.capture': 'Capture',
  'capturePanel.modeSingle': 'Single',
  'capturePanel.modeRepeat': 'Repeat',
  'capturePanel.modeLoop': 'Loop',
  'capturePanel.statusReady': 'Ready',
  'capturePanel.statusCapturing': 'Capturing',
  'capturePanel.statusStopping': 'Stopping',
  'capturePanel.statusWaiting': 'Waiting',
  'capturePanel.statusCompleted': 'Completed',
  'capturePanel.statusReadyDetail': 'Ready to capture',
  'capturePanel.statusFiniteDetail': 'Finite capture in progress',
  'capturePanel.statusUnlimitedDetail': 'Unlimited capture in progress; stop when done',
  'capturePanel.statusLoopDetail': 'Loop capture in progress; the latest window is retained',
  'capturePanel.statusStoppingDetail': 'Stopping; the current view is kept',
  'capturePanel.statusWaitingDetail': 'Next capture after {interval}. Stop to cancel; the view is kept.',
  'capturePanel.statusCompletedDetail': '{samples} samples · {duration}',
  'capturePanel.progress': 'Capture progress',
  'capturePanel.unlimited': 'Unlimited',
  'capturePanel.duration': 'Duration',
  'capturePanel.repeatInterval': 'Interval',
  'capturePanel.loopWindow': 'Window {kept} / {limit} samples · {dropped} dropped',
  'capturePanel.loopWindowLimit': 'Window ceiling {samples} samples = {duration} at {rate}.',
  'capturePanel.singleFiniteNote': 'Finite capture up to {max}; drag to the right segment for Unlimited.',
  'capturePanel.singleUnlimitedNote': 'Unlimited capture; the finite duration draft and unit are kept.',
  'capturePanel.repeatFiniteNote': 'Finite capture up to {max}; each completed run waits for the interval.',
  'capturePanel.repeatLayersNote':
    'Repeat keeps the previous wave behind the current one: the warm background is the current sweep, the blue-grey background is the previous sweep, until the current one has filled the view.',
  'capturePanel.repeatSearchNote':
    'A Repeat trigger search lasts one wave (Duration); if it finds no trigger, the miss is reported and retried at the next Interval.',
  'capturePanel.softwareTrigger': 'Global trigger',
  'capturePanel.enableTrigger': 'Enable global trigger',
  'capturePanel.noPreTrigger': 'No pre-trigger',
  'capturePanel.preTriggerBuffer': 'Pre-trigger buffer',
  'capturePanel.loopTriggerNote':
    'Loop: when the analog trigger fires, T is fixed at the pre-trigger position in the loop window (0% = 0 s, the left edge). The loop window advances in local steps to new analog edges, so the waveform under your view updates in place. Zoom and pan move only the view inside the window; Fit resets that view to the whole window.',
  'capturePanel.loopTriggerNoteDigital':
    'Loop: when the digital trigger fires, T is fixed at the pre-trigger position in the loop window (0% = 0 s, the left edge). A digital lock is one-shot: it holds until T leaves the retained window. Zoom and pan move only the view inside the window; Fit resets it to the whole window.',
  'capturePanel.loopMatcher':
    'Display matcher: every {stride} samples ({rate}); the first match stays precise.',
  'capturePanel.loopSwap':
    'Anchor step {step} samples; local block up to {block} at {refresh} (at most 1/4 of one loop window); retained {retained}.',
  'capturePanel.noCondition': 'No condition set - the capture will run untriggered. Double-click a channel name or click its trigger glyph; analog groups set R/F and a level below.',
  'capturePanel.condHigh': 'high',
  'capturePanel.condLow': 'low',
  'capturePanel.condRising': 'rising',
  'capturePanel.condFalling': 'falling',
  'capturePanel.condEdge': 'edge',
  'capturePanel.condJoiner': ' AND ',
  'capturePanel.armed': 'Armed: {what}. T=0 at the trigger; up to {duration} before it is kept as negative time.',
  'capturePanel.armedCapped': 'Armed: {what}. T=0 at the trigger; up to {duration} before it is kept as negative time (capped by the {megabytes} MiB pre-trigger buffer).',
  'capturePanel.waitingTrigger': 'Waiting for the trigger condition…',
  'capturePanel.triggered': 'Triggered - recording the post-trigger window.',
  'capturePanel.triggeredLoopDigital': 'Triggered - the view is anchored on T (digital, one-shot).',
  'capturePanel.triggeredLoop': 'Triggered - the view is anchored on T and advances in local steps on each new analog edge.',
  'capturePanel.triggerLoopReleased': 'Released - no new analog edge for a whole loop window. The loop is free-running; a new edge locks the view again.',
  'capturePanel.triggerLoopReleasedDigital': 'Released - the one-shot digital lock left the retained window. The loop is free-running; restart the capture to arm it again.',
  'capturePanel.armingTrigger': 'Global trigger is enabled but this acquisition started free-running. Restarting it so the matcher can arm.',
  'capturePanel.triggerRetuneRejected': 'The active capture cannot arm this analog trigger (board or sample-rate limit); it applies to the next acquisition.',
  'capturePanel.triggerViewLost': 'Triggered, but the loop window was shorter than one USB transfer, so T was dropped before the view could lock. Increase the loop duration.',
  'capturePanel.triggerNotFound': 'Stopped without a trigger; nothing was recorded.',
  'capturePanel.repeatMissRetry':
    'The previous interval found no trigger; the session is retrying at the next interval.',
  'capturePanel.recording': 'Recording {seconds} s · {samples} samples · {megabytes} MB',
  'capturePanel.dropped': '{samples} samples lost to dropouts, marked as gaps',
  'capturePanel.cursors': 'Cursors',
  'capturePanel.cursorEmpty': 'Double-click the waveform to place a cursor.',
  'capturePanel.cursorFormat': 'time / sample',
  'capturePanel.removeCursor': 'Remove cursor {label}',
  'capturePanel.focusCursor': 'Centre the view on cursor {label}',
  'capturePanel.cursorDistance': 'Cursor distance',
  'capturePanel.cursorDistanceFormat': 'Δtime/Δsamples',
  'capturePanel.cursorDistanceEmpty': 'Place two cursors on the waveform to read the distance between them.',
  'capturePanel.cursorDistanceNoRows': 'Add a row to compare two cursors.',
  'capturePanel.cursorDistanceAdd': 'Add a distance row',
  'capturePanel.cursorDistanceRemove': 'Remove distance row {row}',
  'capturePanel.cursorDistanceStart': 'Choose the first cursor for row {row}',
  'capturePanel.cursorDistanceEnd': 'Choose the second cursor for row {row}',
  'capturePanel.cursorDistanceUnset': 'not set',
  'capturePanel.cursorEdges': 'Edges',
  'capturePanel.cursorEdgesFormat': 'Rising/Falling/Edges',
  'capturePanel.cursorEdgesEmpty': 'Place two cursors on the waveform to count edges between them.',
  'capturePanel.cursorEdgesNoRows': 'Add a row to count edges between two cursors.',
  'capturePanel.cursorEdgesAdd': 'Add an edge row',
  'capturePanel.cursorEdgesRemove': 'Remove edge row {row}',
  'capturePanel.cursorEdgesStart': 'Choose the first cursor for edge row {row}',
  'capturePanel.cursorEdgesEnd': 'Choose the second cursor for edge row {row}',
  'capturePanel.cursorEdgesChannel': 'Choose the channel for edge row {row}',
  'capturePanel.cursorEdgesUnset': '–',
  'capturePanel.advanced': 'Advanced',
  'capturePanel.testMode': 'Device test mode (next capture)',
  'capturePanel.testModeAnalog': 'Analog voltage display and triggering require Normal mode; built-in patterns are unsupported.',
  'capturePanel.testNormal': 'Normal',
  'capturePanel.testSimulator': 'Simulator',
  'capturePanel.testUsbMax': 'USB MAX SPEED',
  'capturePanel.usbConsole': 'USB control console',
  'capturePanel.usbPlaceholder': 'read 0x000c 4',
  'capturePanel.usbSend': 'Send',
  'capturePanel.usbHelp': 'Commands: read <addr> [len], write <addr> <byte>..., ctrl <value>, flags, clear-fifo, in <request> <value> <index> <len>, out <request> <value> <index> [byte]...',
  'capturePanel.consoleSeed': 'Enter help for commands. Numbers are decimal or 0x-prefixed hex.',
  'capturePanel.consoleError': 'error: {detail}',

  // ------------------------------------------------------ analyzer panel
  'analyzerPanel.title': 'Analyzers',
  'analyzerPanel.subWarm': '{count} stock sigrok decoders. Worker warm.',
  'analyzerPanel.subCold': '{count} stock sigrok decoders. Worker warming up (~850 ms, once per session).',
  'analyzerPanel.decoding': 'decoding…',
  'analyzerPanel.attached': 'Attached',
  'analyzerPanel.decodeAction': 'Decode {label}',
  'analyzerPanel.removeAction': 'Remove {label}',
  'analyzerPanel.cancelDecode': 'Cancel decode',
  'analyzerPanel.add': 'Add',
  'analyzerPanel.decoder': 'Decoder',
  'analyzerPanel.decoderSearchLabel': 'Search protocols',
  'analyzerPanel.decoderSearchPlaceholder': 'Type to filter protocols',
  'analyzerPanel.decoderNoMatch': 'No protocol matches "{query}"',
  'analyzerPanel.stacked': '{id} consumes {inputs}, so it must be stacked on a producer. Stacking is not exposed in this panel.',
  'analyzerPanel.optionalSuffix': ' (optional)',
  'analyzerPanel.attach': 'Attach',
  'analyzerPanel.loadFirst': 'Load or record a capture first; a decoder needs edges to read.',

  // ----------------------------- analyzer status notes (formatted at render)
  'analyzerNote.pending': 'not decoded',
  'analyzerNote.edges': '{count} edges',
  'analyzerNote.stats': '{anns} anns, {decodeMs} ms ({wallMs} ms wall)',
  'analyzerNote.snapshot': 'snapshot of a running loop - does not track the capture',
  'analyzerNote.timeout': 'timed out',
  'analyzerNote.cancelled': 'cancelled',

  // ---------------------------------------------------- parallel bus / ADC
  'bus.title': 'Parallel bus / ADC',
  'bus.sub': 'Combine data lines into one value and draw it as an analog waveform.',
  'bus.attached': 'Bus views',
  'bus.add': 'Add a bus view',
  'bus.edit': 'Edit bus view',
  'bus.name': 'Name',
  'bus.defaultName': 'Analog waveform',
  'bus.confirm': 'Confirm',
  'bus.bits': 'Bits',
  'bus.start': 'Start channel',
  'bus.perBit': 'Assign each bit',
  'bus.swap': 'Swap MSB/LSB',
  'bus.swapShort': 'MSB↔LSB',
  'bus.bitOrder': 'Bit order',
  'bus.bitOrderAuto': 'Auto (MSB on input, LSB on test patterns)',
  'bus.bitOrderMsb': 'Start channel is the MSB',
  'bus.bitOrderLsb': 'Start channel is the LSB',
  'bus.bit': 'Bit {k}',
  'bus.bitLsb': 'Bit {k} (LSB)',
  'bus.bitMsb': 'Bit {k} (MSB)',
  'bus.clock': 'Clock',
  'bus.clockNone': 'None (any bit change)',
  'bus.edge': 'Latch on',
  'bus.edgeRising': 'Rising edge',
  'bus.edgeFalling': 'Falling edge',
  'bus.encoding': 'Encoding',
  'bus.encUnsigned': 'Unsigned',
  'bus.encTwos': 'Two’s complement',
  'bus.encOffset': 'Offset binary',
  'bus.fullScale': 'Full scale (V)',
  'bus.offset': 'Offset (V)',
  'bus.scaleHint': 'Leave full scale empty to show raw values. Volts = offset + value / 2^n × full scale.',
  'bus.style': 'Draw as',
  'bus.styleLine': 'Line',
  'bus.styleStep': 'Steps',
  'analog.finer': 'Analog finer for {channel}',
  'analog.coarser': 'Analog coarser for {channel}',
  'bus.voltsPerDiv': 'V/div',
  'bus.triggerDragTip': 'Drag to set the analog trigger level',
  'bus.scaleBarTip': 'Drag to move the trace; wheel to change V/div; double-click or Home to reset',
  'bus.zeroPosition': '0 V position',
  'bus.height': 'Row height',
  'bus.hideSources': 'Hide the source bit rows',
  'bus.addButton': 'Add',
  'bus.save': 'Save',
  'bus.cancel': 'Cancel',
  'bus.editButton': 'Edit',
  'bus.remove': 'Remove',
  'bus.building': 'building overview {pct}%',
  'bus.liveNote': 'Zoom in to see the bus during a capture',
  'bus.badChannels': 'This capture does not have all of the bus channels',
  'bus.unknown': 'unknown',
  'plot.notCaptured': 'Not in this capture - the next capture includes it',
  'bus.code': 'value',

  // ------------------------------------------------------- AI assistant
  'assistant.title': 'AI assistant',
  'assistant.settings': 'Settings',
  'assistant.newChat': 'New chat',
  'assistant.new': 'New',
  'assistant.provider': 'Provider',
  'assistant.providerClaude': 'Claude',
  'assistant.providerOpenai': 'OpenAI-compatible',
  'assistant.preset': 'Preset',
  'assistant.presetCustom': 'Custom',
  'assistant.baseUrl': 'Base URL',
  'assistant.baseUrlHint': 'Leave Base URL empty for the official endpoint. If it is unreachable from your network, enter an API relay or reverse proxy address here, or turn on a system/browser proxy. A web page cannot use an HTTP or SOCKS5 proxy by itself.',
  'assistant.apiKey': 'API key',
  'assistant.keyHint': 'The key stays in this browser and is sent only to the Base URL above. Unless you tick “remember”, it is forgotten when the tab closes.',
  'assistant.rememberKey': 'Remember the key on this device',
  'assistant.model': 'Model',
  'assistant.modelPlaceholder': 'model name from the provider docs',
  'assistant.noticeTitle': 'Before you start',
  'assistant.notice': 'Your messages and the capture summaries the assistant reads with its tools (settings, edge statistics, decoded data) are sent to the provider you choose, under its terms. Nothing else leaves this page. Changing settings or starting a capture always asks you first.',
  'assistant.noticeAccept': 'I understand',
  'assistant.placeholder': 'Ask about your signals… (Enter to send, Shift+Enter for a new line)',
  'assistant.send': 'Send',
  'assistant.stop': 'Stop',
  'assistant.needKey': 'Enter an API key in the settings first.',
  'assistant.needModel': 'Enter a model name in the settings first.',
  'assistant.empty': 'Ask me to capture, measure or decode signals. For example:',
  'assistant.suggest1': 'Which channels are active, and at what frequencies?',
  'assistant.suggest2': 'Find the UART in this capture and decode it.',
  'assistant.suggest3': 'Set up a 1 s capture at 10 MHz on D0-D3 and capture it.',
  'assistant.thinking': 'Thinking',
  'assistant.toolRunning': 'running…',
  'assistant.toolPending': 'waiting for you',
  'assistant.toolDone': 'done',
  'assistant.toolError': 'failed',
  'assistant.toolDeclined': 'declined',
  'assistant.approveTitle': 'The assistant wants to run this. Allow it?',
  'assistant.allow': 'Allow',
  'assistant.deny': 'Deny',
  'assistant.allowAlways': 'Allow all in this chat',
  'assistant.result': 'Result',
  'assistant.newConversation': 'Settings changed, so a new conversation starts here.',
  'assistant.stopped.aborted': 'Stopped.',
  'assistant.stopped.refusal': 'The model declined to answer{detail}.',
  'assistant.stopped.max_tokens': 'The answer hit the length limit.',
  'assistant.stopped.max_turns': 'Stopped after many tool steps. Send a message to continue.',
  'assistant.stopped.other': 'The model stopped{detail}.',
  'assistant.error.auth': 'The API key was rejected ({status}). Check the key and the provider.',
  'assistant.error.rate': 'The provider is rate limiting ({status}). Wait a moment and try again.',
  'assistant.error.network': 'Could not reach {url}. Check the Base URL and your network or proxy. Some providers do not accept requests from web pages (CORS); an API relay helps there.',
  'assistant.error.invalid': 'The provider rejected the request ({status}). Check the model name and the Base URL.',
  'assistant.error.server': 'The provider reported an error ({status}). Try again.',
  'assistant.error.other': 'The request failed.',
  'assistant.error.load': 'Could not load the Claude client.',

  // -------------------------------------------------------- settings menu
  'settings.title': 'Settings',
  'settings.titleHint': 'Display preferences',
  'settings.detailedLabels': 'Detailed labels',
  'settings.shortcuts': 'Keyboard shortcuts',
  'settings.language': 'Language',
  'settings.theme': 'Theme',

  // ----------------------------------------------------------- shortcuts
  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.close': 'Close',
  'shortcuts.clearCursors': 'Clear cursors',

  // ------------------------------------------------------------ theme
  'theme.default': 'Default',
  'theme.dark': 'Dark',
  'theme.light': 'Light',
  'theme.system': 'System',
};

/**
 * The key contract every locale catalog must satisfy: same keys, string values.
 * Declared here, next to the source of truth, so a locale file is just
 * `export const fr: Messages = {...}` and tsc does the completeness proof.
 */
export type Messages = Record<keyof typeof en, string>;
