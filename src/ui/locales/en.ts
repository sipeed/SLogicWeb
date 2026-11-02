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
  'toolbar.start': 'Start',
  'toolbar.stop': 'Stop',
  'toolbar.stopping': 'Stopping…',
  'toolbar.open': 'Open…',
  'toolbar.save': 'Save',
  'toolbar.fit': 'Fit',
  'toolbar.shortDevice': 'Device',
  'toolbar.shortStart': 'Start',
  'toolbar.shortStop': 'Stop',
  'toolbar.shortStopping': 'Stopping…',
  'toolbar.shortOpen': 'Open',
  'toolbar.shortSave': 'Save',
  'toolbar.shortFit': 'Fit',
  'toolbar.shortSettings': 'Settings',
  'toolbar.shortAssistant': 'Assistant',
  'toolbar.shortLanguage': 'Language',
  'toolbar.shortTheme': 'Theme',
  'toolbar.shortSidebar': 'Sidebar',
  'toolbar.startTitle': 'Start a capture on the connected device',
  'toolbar.stopTitle': 'Stop the running capture',
  'toolbar.stoppingTitle': 'Waiting for pending USB transfers to be cancelled',
  'toolbar.openTitle': 'Load a sigrok .sr session or a .lwcap',
  'toolbar.saveTitle': 'Save this capture as .lwcap',
  'toolbar.fitTitle': 'Zoom to the whole capture',
  'toolbar.sidebarTitle': 'Choose right sidebar',
  'toolbar.themeTitle': 'Toggle theme',
  'toolbar.languageTitle': 'Choose language',
  'toolbar.switchGroup': 'Language and theme',
  'toolbar.assistantTitle': 'AI assistant',
  'toolbar.sidebarDevice': 'Device and capture settings',
  'toolbar.sidebarAnalyzers': 'Protocol analyzers',
  'toolbar.sidebarAssistant': 'AI assistant',
  'toolbar.sidebarNone': 'No sidebar',

  // ---------------------------------------------------------- side panel
  'panel.resizeLabel': 'Resize sidebar',
  'panel.resizeTitle': 'Drag to resize the sidebar',

  // ---------------------------------------------------- capture title
  'capture.none': 'no capture',
  'capture.capturing': 'capturing {channels} ch @ {rate}',
  'capture.loaded': '{source} · loaded in {ms} ms',
  'capture.stoppedNoTrigger': 'no trigger · {samples} samples retained',
  'capture.live': 'live capture · {samples} samples @ {rate} · {duration}',

  // ------------------------------------------------------------- status
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
  'diagnostic.device.unsupportedSamplerate':
    'unsupported samplerate {samplerate} Hz; the device offers {offered}',
  'diagnostic.device.rateCeiling':
    '{rate} MHz exceeds the {channels}-channel ceiling of {ceiling} MHz',
  'diagnostic.device.threshold': 'threshold must be a number, got {threshold}',
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

  // -------------------------------------------------------- hover readout
  'hover.width': 'Width: {duration}',
  'hover.widthInv': 'width⁻¹: {freq}',
  'hover.freq': 'Freq: {freq}',
  'hover.duty': 'Duty: {pct} %',
  'hover.noTransition': 'no transition in view',

  // ---------------------------------------------------- trigger summary
  'trigger.level': 'Level {level}',
  'trigger.rising': 'Rising edge',
  'trigger.falling': 'Falling edge',
  'trigger.anyEdge': 'Any edge',
  'trigger.summary': '{condition} · {pct}% pre-trigger',
  'trigger.summaryAnd': '{condition} · {pct}% pre-trigger · AND {count} conditions',

  // -------------------------------------------------------- channel list
  'channels.settings': 'D{index} settings',
  'channels.resetName': 'Reset name to D{index}',
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

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': 'Digital',
  'capturePanel.channelWidth': 'Channel width',
  'capturePanel.channelWidthBusy': 'Channel width is locked while capture is running',
  'capturePanel.oscilloscopeConfig': '{range} analog oscilloscope configuration: {state}',
  'capturePanel.oscilloscopeEnabled': 'enabled',
  'capturePanel.oscilloscopeDisabled': 'disabled',
  'capturePanel.channelLocked': '{name}: enabled and locked by the {range} analog oscilloscope',
  'capturePanel.oscilloscopeActive': 'Analog oscilloscope enabled',
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
  'capturePanel.repeatInterval': 'Repeat every',
  'capturePanel.loopRetention': 'Retained window',
  'capturePanel.timeUnit': 'Unit',
  'capturePanel.loopWindow': 'Window {kept} / {limit} samples · {dropped} dropped',
  'capturePanel.loopWindowLimit': 'Window ceiling {samples} samples = {duration} at {rate}.',
  'capturePanel.singleFiniteNote': 'Finite capture up to {max} {unit}; drag to the right segment for Unlimited.',
  'capturePanel.singleUnlimitedNote': 'Unlimited capture; the finite duration draft and unit are kept.',
  'capturePanel.repeatFiniteNote': 'Finite capture up to {max} {unit}; each completed run waits for the repeat interval.',
  'capturePanel.softwareTrigger': 'Software trigger',
  'capturePanel.enableTrigger': 'Enable software trigger',
  'capturePanel.noPreTrigger': 'No pre-trigger',
  'capturePanel.preTriggerBuffer': 'Pre-trigger buffer',
  'capturePanel.noCondition': 'No condition set - the capture will run untriggered. Click the settings button on a channel row (left column) and pick an edge or a level.',
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
  'capturePanel.triggerNotFound': 'Stopped without a trigger; nothing was recorded.',
  'capturePanel.recording': 'Recording {seconds} s · {samples} samples · {megabytes} MB',
  'capturePanel.dropped': '{samples} samples lost to dropouts, marked as gaps',
  'capturePanel.advanced': 'Advanced',
  'capturePanel.testMode': 'Device test mode (next capture)',
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
  'bus.bankDialogTitle': '{range} oscilloscope mode',
  'bus.defaultName': 'Analog waveform',
  'bus.enableBank': 'Enable oscilloscope mode',
  'bus.channelOrder': 'Channels and decoding order',
  'bus.confirm': 'Confirm',
  'bus.bits': 'Bits',
  'bus.start': 'Start channel',
  'bus.perBit': 'Assign each bit',
  'bus.swap': 'Swap MSB/LSB',
  'bus.swapShort': 'MSB↔LSB',
  'bus.msbFirst': 'Start channel is the MSB',
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
  'assistant.suggest3': 'Set up a 1 s capture at 10 MHz on D0-D3 and start it.',
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
  'settings.language': 'Language',
  'settings.theme': 'Theme',

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
