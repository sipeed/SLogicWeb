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
  'toolbar.demo': 'Demo',
  'toolbar.open': 'Open…',
  'toolbar.save': 'Save',
  'toolbar.fit': 'Fit',
  'toolbar.startTitle': 'Start a capture on the connected device',
  'toolbar.stopTitle': 'Stop the running capture',
  'toolbar.stoppingTitle': 'Waiting for pending USB transfers to be cancelled',
  'toolbar.demoTitle': 'Load the I2C, SPI and UART protocol demo capture',
  'toolbar.demoLoading': 'Loading the protocol demo…',
  'toolbar.openTitle': 'Load a sigrok .sr session or a .lwcap',
  'toolbar.saveTitle': 'Save this capture as .lwcap',
  'toolbar.fitTitle': 'Zoom to the whole capture',
  'toolbar.sidebarTitle': 'Choose right sidebar',
  'toolbar.themeTitle': 'Toggle theme',
  'toolbar.sidebarDevice': 'Device and capture settings',
  'toolbar.sidebarAnalyzers': 'Protocol analyzers',
  'toolbar.sidebarNone': 'No sidebar',

  // ---------------------------------------------------------- side panel
  'panel.resizeLabel': 'Resize sidebar',
  'panel.resizeTitle': 'Drag to resize the sidebar',

  // ---------------------------------------------------- capture title
  'capture.none': 'no capture',
  'capture.capturing': 'capturing {channels} ch @ {rate}',
  'capture.loaded': '{source} · loaded in {ms} ms',
  'capture.demo': 'protocol demo',
  'capture.stoppedNoTrigger': 'no trigger · {samples} samples retained',
  'capture.live': 'live capture · {samples} samples @ {rate} · {duration}',

  // ------------------------------------------------------------- status
  'status.summary': '{samples} samples @ {rate}',
  'status.total': '{duration} total',
  'status.view': 'view {duration}',

  // -------------------------------------------------------- empty hint
  'emptyHint.line1': 'No capture loaded.',
  'emptyHint.line2': 'Open a .sr or .lwcap file, or connect an SLogic16/32 U3.',

  // ------------------------------------- error prefixes (App.fail sites)
  'error.render': 'render',
  'error.device': 'device',
  'error.openCapture': 'open capture',
  'error.demo': 'demo',
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
  'channels.triggerMode': 'Trigger mode',
  'channels.cancel': 'Cancel',
  'channels.removeAnalyzer': 'Remove {label}',
  'channels.triggerHigh': 'High level',
  'channels.triggerLow': 'Low level',
  'channels.triggerAny': 'Any value (X)',

  // ------------------------------------------------------- capture panel
  'capturePanel.digital': 'Digital',
  'capturePanel.all': 'All',
  'capturePanel.clear': 'Clear',
  'capturePanel.sampleRate': 'Sample rate',
  'capturePanel.threshold': 'Threshold',
  'capturePanel.dacNote': 'DAC code {code} = {volts} V actual. Capture width {channels} ch (ceiling {rate}).',
  'capturePanel.capture': 'Capture',
  'capturePanel.freeRun': 'Free run',
  'capturePanel.timer': 'Timer',
  'capturePanel.durationS': 'Duration (s)',
  'capturePanel.ceilingNote': 'Ceiling {samples} samples = {duration} at {rate}. A free run stops itself there.',
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
  'analyzerNote.timeout': 'timed out',
  'analyzerNote.cancelled': 'cancelled',

  // -------------------------------------------------------- settings menu
  'settings.title': 'Settings',
  'settings.titleHint': 'Language and display preferences',
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
