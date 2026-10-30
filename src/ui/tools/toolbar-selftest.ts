import { settingsMenuRight } from '../settingsMenu.js';
import { sameUsbDevice } from '../deviceIdentity.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const process = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!process || typeof process.exit !== 'function') {
    throw new Error('this entry point only runs under node');
  }
  return process;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const capturePanel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const settingsMenuSrc = fs.readFileSync('src/ui/settingsMenu.ts', 'utf8');
const css = fs.readFileSync('src/ui/style.css', 'utf8');
const deviceTypes = fs.readFileSync('src/device/types.ts', 'utf8');
const pageTransport = fs.readFileSync('src/device/slogic16u3.ts', 'utf8');
const workerTransportSrc = fs.readFileSync('src/device/workerTransport.ts', 'utf8');
const metricsSrc = fs.readFileSync('src/ui/metrics.ts', 'utf8');
const toolbarStart = html.indexOf('<div id="toolbar">');
const mainStart = html.indexOf('<div id="main">');
const toolbar = toolbarStart >= 0 && mainStart > toolbarStart
  ? html.slice(toolbarStart, mainStart)
  : '';
const connectIndex = toolbar.indexOf('id="btn-connect"');
const transportIndex = toolbar.indexOf('id="transport"');
const connectCount = toolbar.match(/\bid="btn-connect"/g)?.length ?? 0;
const firstCommand = /^<div id="toolbar">\s*<button\b[^>]*\bid="btn-connect"[^>]*>/.test(toolbar);
check(
  'device connection is the sole first toolbar command',
  toolbar.length > 0 && connectCount === 1 && connectIndex >= 0 &&
    transportIndex > connectIndex && firstCommand,
  `toolbar=${toolbar.length}, connectCount=${connectCount}, connect@${connectIndex}, transport@${transportIndex}, first=${firstCommand}`,
);

const callbackPattern = /this\.el\.connect\.addEventListener\('click',\s*\(\)\s*=>\s*void this\.connect\(\)\)/;
const callback = callbackPattern.test(app);
const element = app.includes("connect: must<HTMLButtonElement>('btn-connect')");
check(
  'toolbar connection binds the existing App.connect path once',
  callback && element,
  `callback=${callback}, element=${element}`,
);

const removedPanelMembers = ['onConnect', 'webusbAvailable', 'panel-head', 'capturePanel.connect']
  .filter((needle) => capturePanel.includes(needle));
const consoleDeviceState = capturePanel.includes('deviceName: string | null;') &&
  capturePanel.includes('!v.deviceName');
check(
  'capture panel drops only its connection header and retains console device state',
  removedPanelMembers.length === 0 && consoleDeviceState,
  `leftovers=${JSON.stringify(removedPanelMembers)}, consoleDeviceState=${consoleDeviceState}`,
);

const stateNeedles = [
  "deviceName ? `${t('toolbar.device')}: ${deviceName}` : t('toolbar.device')",
  'this.el.connect.disabled = !webusbAvailable',
  'this.el.connect.title =',
  "t('toolbar.noWebusb')",
  "t('toolbar.reconnect')",
];
const missingState = stateNeedles.filter((needle) => !app.includes(needle));
check(
  'App renders disconnected, connected, and WebUSB-unavailable connection state',
  missingState.length === 0,
  `missing=${JSON.stringify(missingState)}`,
);

const actionNeedles = [
  "this.el.transport.addEventListener('click'",
  "must<HTMLButtonElement>('btn-open').addEventListener('click'",
  "must<HTMLButtonElement>('btn-save').addEventListener('click'",
  "must<HTMLButtonElement>('btn-fit').addEventListener('click'",
  "must<HTMLButtonElement>('btn-settings').addEventListener('click'",
];
const missingActions = actionNeedles.filter((needle) => !app.includes(needle));
check(
  'existing toolbar command bindings remain intact',
  missingActions.length === 0,
  `missing=${JSON.stringify(missingActions)}`,
);

const primaryStart = app.indexOf('private primaryAction(): void {');
const primaryEnd = primaryStart >= 0 ? app.indexOf('\n  }', primaryStart) : -1;
const primaryBody = primaryStart >= 0 && primaryEnd > primaryStart
  ? app.slice(primaryStart, primaryEnd)
  : '';
const primaryRoutes = primaryBody.includes('if (this.stopping) return;') &&
  primaryBody.includes('if (this.running) void this.stopCapture();') &&
  primaryBody.includes('else if (this.device) void this.startCapture();') &&
  !primaryBody.includes('loadDemo');
const clickDispatch = app.includes(
  "this.el.transport.addEventListener('click', () => this.primaryAction())");
const spaceStart = app.indexOf("if (e.key === ' ') {");
const spaceEnd = spaceStart >= 0 ? app.indexOf('\n      }', spaceStart) : -1;
const spaceBody = spaceStart >= 0 && spaceEnd > spaceStart ? app.slice(spaceStart, spaceEnd) : '';
const spaceDispatch = spaceBody.includes('this.primaryAction();') &&
  !spaceBody.includes('startCapture') && !spaceBody.includes('stopCapture');
check(
  'toolbar click and Space share one primary action preferring Stop, then Start',
  primaryRoutes && clickDispatch && spaceDispatch,
  `routes=${primaryRoutes}, click=${clickDispatch}, space=${spaceDispatch}, ` +
    `spaceBody=${JSON.stringify(spaceBody.replace(/\s+/g, ' '))}`,
);

const transportStateNeedles = [
  ": this.running ? t('toolbar.stop') : t('toolbar.start')",
  ": this.running ? t('toolbar.shortStop') : t('toolbar.shortStart')",
  'btn.disabled = this.stopping || (this.device === null && !this.running);',
  ": this.device ? t('toolbar.startTitle') : t('toolbar.connectHint')",
];
const missingTransportState = transportStateNeedles.filter((needle) => !app.includes(needle));
const transportWebusbGated = /btn\.disabled[^;]*webusbAvailable/.test(app);
const demoActionAbsent = ['loadDemo', 'demoBusy', 'createProtocolDemoCapture',
  "t('toolbar.demo'", "t('toolbar.shortDemo'"]
  .filter((needle) => app.includes(needle));
check(
  'the transport disables while disconnected and the demo action is retired',
  missingTransportState.length === 0 && !transportWebusbGated && demoActionAbsent.length === 0,
  `missing=${JSON.stringify(missingTransportState)}, webusbGated=${transportWebusbGated}, ` +
    `demo=${JSON.stringify(demoActionAbsent)}`,
);

const debugDemoDelegates = app.includes('demo: () => this.loadDemo(),');
const retiredConnectFirst = ['connectFirstTitle', 'toolbar.connectFirstTitle']
  .filter((needle) => app.includes(needle));
check(
  'the debug surface no longer drives a demo loader and the unreachable connect-first string is retired',
  !debugDemoDelegates && retiredConnectFirst.length === 0,
  `debug=${debugDemoDelegates}, retired=${JSON.stringify(retiredConnectFirst)}`,
);

function methodBody(marker: string): string {
  const start = app.indexOf(marker);
  const end = start >= 0 ? app.indexOf('\n  }', start) : -1;
  return start >= 0 && end > start ? app.slice(start, end) : '';
}

const discardBody = methodBody('private discardDecodeState(): void {');
const adoptBody = methodBody('private adoptCapture(');
const startBody = methodBody('private async startCapture(): Promise<void> {');
const runDecodeBody = methodBody('private async runDecode(id: string): Promise<void> {');

const discardDeviceBody = methodBody('private discardDevice(): number {');
const detachBody = methodBody('private detachDevice(): number {');
const teardownBody =
  methodBody('private async teardownDevice(device: Device | null): Promise<void> {');
const stopCaptureBody = methodBody('private async stopCapture(): Promise<void> {');
const connectBody = methodBody('private async connect(): Promise<void> {');
const reconnectBody = methodBody('private async reconnectGranted(): Promise<void> {');

const escapeHatch = /^ {2}terminate\(\): void;$/m.test(deviceTypes) &&
  !/terminate\?\(\)/.test(deviceTypes) &&
  pageTransport.includes('terminate(): void {') &&
  workerTransportSrc.includes('terminate(): void {');
const stopRecovers = teardownBody.includes("this.fail('error.stopCapture', e)") &&
  teardownBody.indexOf('this.discardDevice();') >
    teardownBody.indexOf("this.fail('error.stopCapture', e)") &&
  teardownBody.includes('void this.reconnectGranted();') &&
  teardownBody.includes('if (this.device === device)') &&
  stopCaptureBody.includes('this.teardownDevice(this.device)');
const discardTerminates = discardDeviceBody.includes('this.deviceEpoch += 1;') &&
  discardDeviceBody.includes('device.onError = null;') &&
  discardDeviceBody.includes('device.terminate();');
check(
  'a failed stop drops the transport and re-acquires it instead of leaving a dead button',
  stopRecovers && discardTerminates && escapeHatch,
  `recovers=${stopRecovers}, discard=${discardTerminates}, escape=${escapeHatch}`,
);

const detachFinishes = detachBody.includes('const epoch = this.discardDevice();') &&
  detachBody.includes('this.running = false;') && detachBody.includes('this.stopping = false;') &&
  detachBody.includes('this.finishCapture();');
const installBody = methodBody('private installDevice(d: Device, epoch: number): boolean {');
const installReplaces = installBody.includes('if (epoch !== this.deviceEpoch && this.device !== null) {') &&
  installBody.indexOf('d.terminate();') < installBody.indexOf('const previous = this.device;') &&
  installBody.includes('previous.onError = null;') &&
  installBody.includes('previous.terminate();') &&
  installBody.includes('this.finishCapture();');
const cancelReturnAt = connectBody.indexOf('if (cancelledByUser(error)) return;');
const detachAt = connectBody.indexOf('epoch = this.detachDevice();');
const keepsOnCancel = cancelReturnAt >= 0 && detachAt > cancelReturnAt &&
  connectBody.includes('if (this.device === null) throw error;') &&
  app.includes("return error instanceof DOMException && error.name === 'NotFoundError';");
const acquireFirst = connectBody.indexOf('requestDeviceOnBestThread()') <
    connectBody.indexOf('this.detachDevice()') &&
  reconnectBody.indexOf('getGrantedDevicesOnBestThread()') <
    reconnectBody.indexOf('this.detachDevice()') &&
  connectBody.includes('this.installDevice(d, epoch);') &&
  reconnectBody.includes('this.installDevice(d, epoch);');
check(
  'device acquisition replaces the transport it supersedes and keeps a working one on failure',
  detachFinishes && installReplaces && acquireFirst && keepsOnCancel,
  `detach=${detachFinishes}, replace=${installReplaces}, acquireFirst=${acquireFirst}, ` +
    `keepsOnCancel=${keepsOnCancel}`,
);

const startRecovers = startBody.includes('e instanceof TransportDeadError') &&
  startBody.includes('this.discardDevice();') &&
  startBody.includes('void this.reconnectGranted();');
check(
  'a dead transport on start is dropped and re-acquired, not reported forever',
  startRecovers,
  `recovers=${startRecovers}`,
);

const startIssuedTo = startBody.indexOf('const device = this.device;') >= 0 &&
  startBody.includes('await device.start(cfg, (chunk) => {');
const armingStop = ['if (!this.running) {', 'await this.stopPending',
  'else if (this.device === device) await this.teardownDevice(device);']
  .filter((needle) => !startBody.includes(needle));
check(
  'a stop that lands during arming tears down the device start() was issued to',
  startIssuedTo && armingStop.length === 0 &&
    startBody.indexOf('await this.stopPending') >
      startBody.indexOf('await device.start(cfg, (chunk) => {'),
  `issuedTo=${startIssuedTo}, missing=${JSON.stringify(armingStop)}`,
);

const identityCases: [string, { serialNumber?: string | null }, boolean][] = [
  ['same', { serialNumber: 'same' }, true],
  ['one', { serialNumber: 'other' }, false],
  ['', { serialNumber: 'other' }, true],
  ['one', {}, true],
  ['one', { serialNumber: null }, true],
];
const identityBad = identityCases.filter(([serial, usb, want]) => sameUsbDevice(serial, usb) !== want);
check(
  'USB disconnect matching accepts an absent serial and rejects a different reported one',
  identityBad.length === 0,
  identityBad.map(([serial, usb, want]) => `${serial}/${usb.serialNumber ?? 'null'}->${want}`).join('; '),
);

const disconnectListenerCount =
  (app.match(/navigator\.usb\?\.addEventListener\('disconnect'/g) ?? []).length;
const c6ConstructorBody = methodBody('constructor() {');
const disconnectWiring =
  "navigator.usb?.addEventListener('disconnect', (e) => this.usbDisconnected(e.device));";
const usbDisconnectedBody = methodBody('private usbDisconnected(usb: USBDevice): void {');
const deviceLostBody = methodBody('private deviceLost(error: unknown, report = true): void {');
const disconnectGuard = usbDisconnectedBody.includes(
  'if (!device || !sameUsbDevice(device.serial, usb)) return;') &&
  usbDisconnectedBody.includes('this.deviceLost(new Error(');
const lostFailAt = deviceLostBody.indexOf("this.fail('error.device', error)");
const lostDetachAt = deviceLostBody.indexOf('this.detachDevice();');
const lostRenderAt = deviceLostBody.indexOf('this.renderPanels();');
const lostCleans = deviceLostBody.includes('if (this.device === null) return;') &&
  lostFailAt >= 0 && lostFailAt < lostDetachAt && lostDetachAt < lostRenderAt &&
  !deviceLostBody.includes('recoverDevice');
check(
  'a matching USB disconnect drops the transport once and finishes the capture',
  disconnectListenerCount === 1 && c6ConstructorBody.includes(disconnectWiring) &&
    disconnectGuard && lostCleans,
  `listeners=${disconnectListenerCount}, inCtor=${c6ConstructorBody.includes(disconnectWiring)}, ` +
    `guard=${disconnectGuard}, cleans=${lostCleans}, order=${lostFailAt},${lostDetachAt},${lostRenderAt}`,
);

const ownershipAbsent = !app.includes('demoAnalyzers') && !app.includes('demoOwned');
const manualAttachUnmarked = app.includes(
  "onAttach: (id, ch, opts) => void this.attachAnalyzer(id, ch, opts)") &&
  app.includes('this.attachAnalyzer(id, ch, opts),');
check(
  'analyzer mounts carry no demo ownership',
  ownershipAbsent && manualAttachUnmarked,
  `ownership=${ownershipAbsent}, manual=${manualAttachUnmarked}`,
);

const discardsInFlight = discardBody.includes('this.abort?.abort();') &&
  discardBody.includes('this.abort = null;') && discardBody.includes('this.decodeBusy = false;');
const discardKeepsMounts = !discardBody.includes('this.analyzers') &&
  !discardBody.includes('demoAnalyzers');
const adoptDiscardsFirst = adoptBody.indexOf('this.discardDecodeState();') >= 0 &&
  adoptBody.indexOf('this.discardDecodeState();') < adoptBody.indexOf('this.storeRef.set(store);');
const startDiscardsAtReplacement = startBody.indexOf('this.discardDecodeState();') >
  startBody.indexOf('vrefCode(cfg.thresholdVolts)') &&
  startBody.indexOf('this.discardDecodeState();') < startBody.indexOf('this.storeRef.set(store);');
check(
  'capture replacement discards in-flight decode state without dropping mounts',
  discardsInFlight && discardKeepsMounts && adoptDiscardsFirst && startDiscardsAtReplacement,
  `abort=${discardsInFlight}, keepsMounts=${discardKeepsMounts}, adopt=${adoptDiscardsFirst}, start=${startDiscardsAtReplacement}`,
);

const stalePredicate = runDecodeBody.includes(
  'const stale = (): boolean => this.store !== store || !this.analyzers.includes(a);');
const staleGuardCount = runDecodeBody.match(/if \(stale\(\)\) return;/g)?.length ?? 0;
const resultPublishedAfterGuard = staleGuardCount === 2 &&
  runDecodeBody.indexOf('if (stale()) return;') < runDecodeBody.indexOf('a.result = result;') &&
  runDecodeBody.indexOf('if (stale()) return;', runDecodeBody.indexOf('} catch (e) {')) <
    runDecodeBody.indexOf("a.status = 'error';");
check(
  'decode results and errors are published only for the capture and analyzer they started on',
  stalePredicate && resultPublishedAfterGuard,
  `predicate=${stalePredicate}, guards=${staleGuardCount}, ordered=${resultPublishedAfterGuard}`,
);

const localController = runDecodeBody.includes('const controller = new AbortController();') &&
  runDecodeBody.includes('signal: controller.signal') &&
  !runDecodeBody.includes('signal: this.abort.signal');
const finallyGuarded = /finally \{\s*if \(this\.abort === controller\) \{\s*this\.decodeBusy = false;\s*this\.abort = null;/.test(runDecodeBody);
const publishesController = runDecodeBody.indexOf('this.abort = controller;') >= 0 &&
  runDecodeBody.indexOf('this.abort = controller;') < runDecodeBody.indexOf('await this.decodeClient.decode(');
const cancelBindingKept = app.includes('onCancel: () => this.abort?.abort()');
check(
  'an older decode cannot clear a newer one: controller identity owns busy and abort cleanup',
  localController && finallyGuarded && publishesController && cancelBindingKept,
  `local=${localController}, guardedFinish=${finallyGuarded}, publish=${publishesController}, cancel=${cancelBindingKept}`,
);

const leftCommandIds = ['btn-connect', 'transport', 'btn-open', 'btn-save', 'btn-fit', 'btn-settings'];
const assistantCommandId = 'btn-assistant';
const languageCommandId = 'btn-language';
const themeCommandId = 'btn-theme';
const sidebarCommandId = 'btn-sidebar';
const commandIds = [...leftCommandIds, assistantCommandId, languageCommandId, themeCommandId, sidebarCommandId];

function commandMarkup(id: string): string {
  const idIndex = toolbar.indexOf(`id="${id}"`);
  if (idIndex < 0) return '';
  const start = toolbar.lastIndexOf('<button', idIndex);
  const end = toolbar.indexOf('</button>', idIndex);
  return start >= 0 && end > idIndex ? toolbar.slice(start, end + '</button>'.length) : '';
}

const sharedAnatomyNeedles = [
  'class="toolbar-item',
  'class="toolbar-item-media"',
  'aria-hidden="true"',
  'focusable="false"',
  'data-icon="inline-start"',
];
const retiredAnatomyNeedles = [
  'toolbar-item-content', 'toolbar-item-title', 'toolbar-item-description',
];
const anatomyFailures: string[] = [];
const iconSignatures = new Set<string>();
const iconBody = (markup: string): string =>
  /<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(markup)?.[1]?.replace(/\s+/g, '') ?? '';
for (const id of commandIds) {
  const markup = commandMarkup(id);
  const missing = sharedAnatomyNeedles.filter((needle) => !markup.includes(needle));
  if (missing.length > 0) anatomyFailures.push(`${id}:${missing.join(',')}`);
  const retired = retiredAnatomyNeedles.filter((needle) => markup.includes(needle));
  if (retired.length > 0) anatomyFailures.push(`${id}:label(${retired.join(',')})`);
  const mediaCount = markup.match(/class="toolbar-item-media"/g)?.length ?? 0;
  if (mediaCount !== 1) anatomyFailures.push(`${id}:media=${mediaCount}`);
  const labelCount = markup.match(/class="toolbar-item-label"/g)?.length ?? 0;
  if (labelCount !== 1) anatomyFailures.push(`${id}:labels=${labelCount}`);
  const labelText = /<span class="toolbar-item-label" aria-hidden="true" data-i18n="toolbar\.short[A-Za-z]+">([^<]+)<\/span>/.exec(markup)?.[1];
  if (labelText === undefined) anatomyFailures.push(`${id}:short-label`);
  const mediaAt = markup.indexOf('class="toolbar-item-media"');
  const labelAt = markup.indexOf('class="toolbar-item-label"');
  if (mediaAt < 0 || labelAt < mediaAt) anatomyFailures.push(`${id}:label-order`);
  const allText = markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (allText !== labelText) anatomyFailures.push(`${id}:extra-text`);
  if (!/\saria-label="[^"]+"/.test(markup)) anatomyFailures.push(`${id}:aria-label`);
  const icon = iconBody(markup);
  if (icon) iconSignatures.add(icon);
  else anatomyFailures.push(`${id}:icon`);
}
const languageMarkup = commandMarkup(languageCommandId);
const languageDisclosure = languageMarkup.includes('aria-controls="language-menu"') &&
  languageMarkup.includes('aria-expanded="false"') &&
  languageMarkup.includes('data-i18n-title="toolbar.languageTitle"') &&
  /\saria-label="[^"]+"/.test(languageMarkup);
const languageWiringNeedles = [
  "new SettingsMenu(this.el.language, 'language-menu')",
  'this.languageMenu.toggle(this.languageItems())',
  "this.el.language.addEventListener('click'",
  "this.languageMenu.close('outside')",
  "this.languageMenu.close('retranslate')",
  "this.languageMenu.close('theme')",
  "this.el.language.setAttribute('aria-label', t('toolbar.languageTitle'))",
];
const missingLanguageWiring = languageWiringNeedles.filter((needle) => !app.includes(needle));
const languageItemsBody = methodBody('private languageItems(');
const languageItemsShape = languageItemsBody.includes('LOCALES.map') &&
  languageItemsBody.includes('label: LOCALE_LABELS[l]') &&
  languageItemsBody.includes('checked: l === getLocale()') &&
  languageItemsBody.includes('setLocale(l).then') &&
  languageItemsBody.includes("this.fail('error.localeLoad', l)") &&
  !languageItemsBody.includes('children') && !languageItemsBody.includes('hint');
check(
  'the language disclosure reuses a distinct settings menu with four direct native-name choices',
  languageDisclosure && missingLanguageWiring.length === 0 && languageItemsShape,
  `disclosure=${languageDisclosure}, missing=${JSON.stringify(missingLanguageWiring)}, items=${languageItemsShape}`,
);

const menuRightCases = [
  { viewport: 1280, anchor: 1100, width: 150, expected: 180 },
  { viewport: 400, anchor: 65, width: 147, expected: 247 },
  { viewport: 400, anchor: 399, width: 150, expected: 6 },
  { viewport: 320, anchor: 176, width: 147, expected: 144 },
  { viewport: 390, anchor: 65, width: 147, expected: 237 },
  { viewport: 360, anchor: 123, width: 147, expected: 207 },
];
const menuRightFailures = menuRightCases.flatMap((item) => {
  const right = settingsMenuRight(item.anchor, item.width, item.viewport);
  const left = item.viewport - right - item.width;
  return right === item.expected && (left >= 6 || item.viewport - right === item.anchor)
    ? [] : [`${item.viewport}/${item.anchor}: right=${right}, left=${left}, expected=${item.expected}`];
});
const menuPositioningWired = settingsMenuSrc.includes('const menuWidth = menu.offsetWidth;') &&
  settingsMenuSrc.includes('settingsMenuRight(rect.right, menuWidth, window.innerWidth)') &&
  !settingsMenuSrc.includes('menu.style.right = `${Math.round(window.innerWidth - rect.right)}px`');
check(
  'settings menus preserve right alignment and clamp both horizontal viewport edges',
  menuRightFailures.length === 0 && menuPositioningWired,
  `failures=${JSON.stringify(menuRightFailures)}, wired=${menuPositioningWired}`,
);

const sidebarMarkup = commandMarkup(sidebarCommandId);
const separatorCount = toolbar.match(/role="separator"/g)?.length ?? 0;
const verticalSeparatorCount = toolbar.match(/aria-orientation="vertical"/g)?.length ?? 0;
check(
  'ten commands expose shadcn anatomy, one media wrapper and decorative short label each, distinct icons, and separators',
  anatomyFailures.length === 0 && iconSignatures.size === commandIds.length &&
    separatorCount === 2 && verticalSeparatorCount === 2,
  `failures=${JSON.stringify(anatomyFailures)}, icons=${iconSignatures.size}, separators=${separatorCount}/${verticalSeparatorCount}`,
);

const fitIndex = toolbar.indexOf('id="btn-fit"');
const spacerIndex = toolbar.indexOf('class="spacer"');
const settingsIndex = toolbar.indexOf('id="btn-settings"');
const settingsSeparatorIndex = settingsIndex >= 0
  ? toolbar.lastIndexOf('role="separator"', settingsIndex)
  : -1;
const settingsBeforeSpacer = fitIndex >= 0 && settingsSeparatorIndex > fitIndex &&
  settingsIndex > settingsSeparatorIndex && spacerIndex > settingsIndex;
const earlierCommandIndexes = leftCommandIds
  .filter((id) => id !== 'btn-settings')
  .map((id) => toolbar.indexOf(`id="${id}"`));
const settingsIsLastLeftCommand = settingsIndex >= 0 &&
  earlierCommandIndexes.every((index) => index >= 0 && index < settingsIndex) &&
  spacerIndex > settingsIndex;
check(
  'settings is the last left-aligned toolbar command before the spacer',
  settingsBeforeSpacer && settingsIsLastLeftCommand,
  `fit@${fitIndex}, settingsSeparator@${settingsSeparatorIndex}, settings@${settingsIndex}, spacer@${spacerIndex}`,
);

const settingsToSpacer = settingsIndex >= 0 && spacerIndex > settingsIndex
  ? toolbar.slice(settingsIndex, spacerIndex)
  : '';
const settingsDirectlyBeforeSpacer = settingsToSpacer.length > 0 &&
  !settingsToSpacer.includes('<button') && !settingsToSpacer.includes('role="separator"');
check(
  'no command or separator sits between settings and the spacer',
  settingsDirectlyBeforeSpacer,
  `segment=${JSON.stringify(settingsToSpacer.replace(/\s+/g, ' '))}`,
);

const assistantIndex = toolbar.indexOf(`id="${assistantCommandId}"`);
const assistantButtonStart = assistantIndex >= 0 ? toolbar.lastIndexOf('<button', assistantIndex) : -1;
const assistantButtonEnd = assistantIndex >= 0 ? toolbar.indexOf('</button>', assistantIndex) : -1;
const spacerToAssistant = spacerIndex >= 0 && assistantButtonStart > spacerIndex
  ? toolbar.slice(spacerIndex, assistantButtonStart) : '';
const assistantDirectlyAfterSpacer = spacerToAssistant.length > 0 &&
  !spacerToAssistant.includes('<button') && !spacerToAssistant.includes('role="separator"');
const switchGroupStart = toolbar.indexOf('<div class="toolbar-switch-group"');
const switchGroupClose = switchGroupStart >= 0 ? toolbar.indexOf('</div>', switchGroupStart) : -1;
const switchGroupEnd = switchGroupClose >= 0 ? switchGroupClose + '</div>'.length : -1;
const switchGroupMarkup = switchGroupStart >= 0 && switchGroupEnd > switchGroupStart
  ? toolbar.slice(switchGroupStart, switchGroupEnd) : '';
const languageIndex = switchGroupMarkup.indexOf(`id="${languageCommandId}"`);
const themeIndex = switchGroupMarkup.indexOf(`id="${themeCommandId}"`);
const switchGroupButtons = switchGroupMarkup.match(/<button\b/g)?.length ?? 0;
const switchGroupOrder = languageIndex >= 0 && themeIndex > languageIndex && switchGroupButtons === 2;
const switchGroupAccessible = switchGroupMarkup.includes('role="group"') &&
  switchGroupMarkup.includes('aria-label="Language and theme"') &&
  switchGroupMarkup.includes('data-i18n-aria-label="toolbar.switchGroup"');
const assistantToGroup = assistantButtonEnd > assistantButtonStart && switchGroupStart > assistantButtonEnd
  ? toolbar.slice(assistantButtonEnd, switchGroupStart) : '';
const groupDirectlyAfterAssistant = assistantDirectlyAfterSpacer && assistantToGroup.length > 0 &&
  !assistantToGroup.includes('<button') && !assistantToGroup.includes('role="separator"');

const sidebarIndex = toolbar.indexOf(`id="${sidebarCommandId}"`);
const sidebarButtonStart = sidebarIndex >= 0 ? toolbar.lastIndexOf('<button', sidebarIndex) : -1;
const groupToSidebar = switchGroupEnd > switchGroupStart && sidebarButtonStart > switchGroupEnd
  ? toolbar.slice(switchGroupEnd, sidebarButtonStart) : '';
const sidebarDirectlyAfterGroup = groupToSidebar.length > 0 &&
  !groupToSidebar.includes('<button') && !groupToSidebar.includes('role="separator"');
const lastButtonIndex = toolbar.lastIndexOf('<button');
const sidebarIsFinalCommand = lastButtonIndex >= 0 && lastButtonIndex === sidebarButtonStart &&
  toolbar.indexOf('role="separator"', sidebarIndex) === -1;
check(
  'assistant, the language/theme group and sidebar follow the spacer in that order, sidebar last',
  switchGroupOrder && switchGroupAccessible && groupDirectlyAfterAssistant &&
    sidebarDirectlyAfterGroup && sidebarIsFinalCommand,
  `spacer@${spacerIndex}, assistant@${assistantIndex}, group@${switchGroupStart}, sidebar@${sidebarIndex}, ` +
  `groupOrder=${switchGroupOrder}, accessible=${switchGroupAccessible}, afterAssistant=${groupDirectlyAfterAssistant}, ` +
  `between=${sidebarDirectlyAfterGroup}, final=${sidebarIsFinalCommand}`,
);

const switchGroupRule = /#toolbar \.toolbar-switch-group \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
const switchGroupRules = [...css.matchAll(/#toolbar \.toolbar-switch-group[^{}]*\{([^{}]*)\}/g)]
  .map((match) => match[1]);
const switchGroupPlain = switchGroupRule.includes('display: flex') && switchGroupRules.length >= 2 &&
  switchGroupRules.every((rule) => !/(background|border|border-radius|overflow)\s*:/.test(rule));
check(
  'the language/theme wrapper groups ordinary unclipped buttons without pill decoration',
  switchGroupPlain,
  `plain=${switchGroupPlain}, rules=${switchGroupRules.length}`,
);

const assistantMarkup = commandMarkup(assistantCommandId);
const assistantWiring = [
  "this.el.assistant.addEventListener('click'",
  'this.toggleAssistant();',
  "this.selectPanel('assistant');",
  'this.selectPanel(this.panelBeforeAssistant);',
  "this.el.assistant.setAttribute('aria-pressed', String(this.panel === 'assistant'))",
  "this.el.assistant.setAttribute('aria-label', t('toolbar.assistantTitle'))",
].filter((needle) => !app.includes(needle));
check(
  'the assistant button is a toggle: aria-pressed, translated title, and the shared selectPanel path',
  assistantMarkup.includes('aria-pressed="false"') && assistantMarkup.includes('aria-controls="side-panel"') &&
    assistantMarkup.includes('data-i18n-title="toolbar.assistantTitle"') && assistantWiring.length === 0,
  `missing=${JSON.stringify(assistantWiring)}`,
);

const disclosureNeedles = [
  'aria-controls="sidebar-menu"',
  'aria-expanded="false"',
  'data-i18n-title="toolbar.sidebarTitle"',
];
const missingDisclosure = disclosureNeedles.filter((needle) => !sidebarMarkup.includes(needle));
const sidebarHasAccessibleName = /\saria-label="[^"]+"/.test(sidebarMarkup);
check(
  'the sidebar selector is a disclosure with a translated tooltip and accessible name',
  missingDisclosure.length === 0 && sidebarHasAccessibleName,
  `missing=${JSON.stringify(missingDisclosure)}, ariaLabel=${sidebarHasAccessibleName}`,
);

const sidebarWiringNeedles = [
  "new SettingsMenu(this.el.sidebar, 'sidebar-menu')",
  'this.sidebarMenu.toggle(this.sidebarItems())',
  "this.el.sidebar.addEventListener('click'",
  "this.sidebarMenu.close('outside')",
  "this.settingsMenu.close('outside')",
  "this.sidebarMenu.close('retranslate')",
  "this.settingsMenu.close('retranslate')",
  "this.sidebarMenu.close('theme')",
  "this.settingsMenu.close('theme')",
  "this.el.sidebar.setAttribute('aria-label', t('toolbar.sidebarTitle'))",
];
const missingSidebarWiring = sidebarWiringNeedles.filter((needle) => !app.includes(needle));
const menuIdConstructor = /constructor\([\s\S]*?menuId: string = 'settings-menu'/.test(settingsMenuSrc) &&
  settingsMenuSrc.includes('menu.id = this.menuId;');
check(
  'the sidebar selector reuses the settings menu with a distinct id and mutual overlay closure',
  missingSidebarWiring.length === 0 && menuIdConstructor,
  `missing=${JSON.stringify(missingSidebarWiring)}, menuId=${menuIdConstructor}`,
);

const themeMarkup = commandMarkup(themeCommandId);
const themeSvgTags = themeMarkup.match(/<svg\b[^>]*>/g) ?? [];
const themeIconClasses = ['light', 'dark', 'system']
  .map((id) => `class="toolbar-item-icon theme-icon-${id}"`);
const themeSvgAnatomy = themeSvgTags.length === 3 &&
  themeSvgTags.every((tag) => tag.includes('aria-hidden="true"') &&
    tag.includes('focusable="false"') && tag.includes('data-icon="inline-start"')) &&
  themeIconClasses.every((cls) => themeSvgTags.some((tag) => tag.includes(cls)));
const themeGlyphGeometry = themeMarkup.includes('<circle cx="12" cy="12" r="4"></circle>') &&
  themeMarkup.includes('M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41') &&
  themeMarkup.includes('M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z') &&
  themeMarkup.includes('<rect x="2" y="3" width="20" height="14" rx="2"></rect>') &&
  themeMarkup.includes('M8 21h8M12 17v4');
const themeDisclosure = themeMarkup.includes('aria-controls="theme-menu"') &&
  themeMarkup.includes('aria-expanded="false"') &&
  themeMarkup.includes('data-i18n-title="toolbar.themeTitle"') &&
  /\saria-label="[^"]+"/.test(themeMarkup);
const themeNoBootMode = !/\sdata-mode=/.test(themeMarkup);
const themeBaseIconRule = css.includes('#toolbar .toolbar-item-icon { display: block;');
const themeHideAll = css.includes('#toolbar .toolbar-theme .toolbar-item-icon { display: none; }');
const themeResolvedFallback = css.includes(
  'html:not([data-theme]) #toolbar .toolbar-theme:not([data-mode]) .theme-icon-light,\n' +
  'html[data-theme="light"] #toolbar .toolbar-theme:not([data-mode]) .theme-icon-light,\n' +
  'html[data-theme="dark"] #toolbar .toolbar-theme:not([data-mode]) .theme-icon-dark { display: block; }');
const themeModeRules = css.includes(
  '#toolbar .toolbar-theme[data-mode="light"] .theme-icon-light,\n' +
  '#toolbar .toolbar-theme[data-mode="dark"] .theme-icon-dark,\n' +
  '#toolbar .toolbar-theme[data-mode="system"] .theme-icon-system { display: block; }');
const themeFallbackAt = css.indexOf('html[data-theme="light"] #toolbar .toolbar-theme:not([data-mode])');
const themeModeRuleAt = css.indexOf('#toolbar .toolbar-theme[data-mode="light"] .theme-icon-light');
const themeRuleOrder = themeFallbackAt >= 0 && themeModeRuleAt > themeFallbackAt;
const themeWiringNeedles = [
  "new SettingsMenu(this.el.theme, 'theme-menu')",
  'this.themeMenu.toggle(this.themeItems())',
  "this.el.theme.addEventListener('click'",
  "this.themeMenu.close('outside')",
  "this.themeMenu.close('retranslate')",
  "this.themeMenu.close('theme')",
  "this.el.theme.setAttribute('aria-label', t('toolbar.themeTitle'))",
];
const missingThemeWiring = themeWiringNeedles.filter((needle) => !app.includes(needle));
const themeWrites = app.match(/this\.el\.theme\.dataset\.mode = getMode\(\);/g) ?? [];
const themeMenuCtorAt = app.indexOf("new SettingsMenu(this.el.theme, 'theme-menu')");
const themeResizerAt = app.indexOf('this.resizer = new PanelResizer(');
const themeHandlerAt = app.indexOf('onThemeChange(() =>');
const themeHandlerEnd = themeHandlerAt >= 0 ? app.indexOf('\n    });', themeHandlerAt) : -1;
const themeFirstWriteAt = app.indexOf('this.el.theme.dataset.mode = getMode();');
const themeSecondWriteAt = themeFirstWriteAt >= 0
  ? app.indexOf('this.el.theme.dataset.mode = getMode();', themeFirstWriteAt + 1) : -1;
const themeWritePlacement = themeWrites.length === 2 &&
  themeMenuCtorAt >= 0 && themeFirstWriteAt > themeMenuCtorAt &&
  themeResizerAt > themeFirstWriteAt &&
  themeHandlerAt >= 0 && themeSecondWriteAt > themeHandlerAt &&
  themeHandlerEnd > themeSecondWriteAt;
const themeItemsStart = app.indexOf('private themeItems(');
const themeItemsEnd = themeItemsStart >= 0 ? app.indexOf('\n  }', themeItemsStart) : -1;
const themeItemsBody = themeItemsStart >= 0 && themeItemsEnd > themeItemsStart
  ? app.slice(themeItemsStart, themeItemsEnd) : '';
const themeItemsShape = themeItemsBody.includes('THEME_MODES.map') &&
  themeItemsBody.includes('label: t(THEME_MODE_LABEL_KEYS[m])') &&
  themeItemsBody.includes('checked: m === getMode()') &&
  themeItemsBody.includes('onPick: () => setMode(m)') &&
  !themeItemsBody.includes('children') && !themeItemsBody.includes('hint');
check(
  'the theme button shows one per-mode glyph and resolves its icon from data-theme before boot writes data-mode',
  themeSvgAnatomy && themeGlyphGeometry && themeDisclosure && themeNoBootMode &&
    themeBaseIconRule && themeHideAll && themeResolvedFallback && themeModeRules &&
    themeRuleOrder && themeWritePlacement && missingThemeWiring.length === 0 && themeItemsShape,
  `svgs=${themeSvgTags.length}, anatomy=${themeSvgAnatomy}, glyphs=${themeGlyphGeometry}, ` +
  `disclosure=${themeDisclosure}, noBootMode=${themeNoBootMode}, base=${themeBaseIconRule}, ` +
  `hideAll=${themeHideAll}, fallback=${themeResolvedFallback}, modeRules=${themeModeRules}, ` +
  `order=${themeRuleOrder}, writes=${themeWrites.length}@${themeFirstWriteAt}/${themeSecondWriteAt}, ` +
  `missing=${JSON.stringify(missingThemeWiring)}, itemsShape=${themeItemsShape}`,
);

const sidebarChoiceNeedles = [
  "t('toolbar.sidebarDevice')",
  "t('toolbar.sidebarAnalyzers')",
  "t('toolbar.sidebarAssistant')",
  "t('toolbar.sidebarNone')",
  "checked: this.panel === 'device'",
  "checked: this.panel === 'analyzers'",
  "checked: this.panel === 'assistant'",
  'checked: this.panel === null',
  "this.selectPanel('device')",
  "this.selectPanel('analyzers')",
  "this.selectPanel('assistant')",
  'this.selectPanel(null)',
];
const missingSidebarChoices = sidebarChoiceNeedles.filter((needle) => !app.includes(needle));
const selectPanelStart = app.indexOf('private selectPanel(');
const selectPanelEnd = selectPanelStart >= 0 ? app.indexOf('\n  }', selectPanelStart) : -1;
const selectPanelBody = selectPanelStart >= 0 && selectPanelEnd > selectPanelStart
  ? app.slice(selectPanelStart, selectPanelEnd)
  : '';
const selectPanelShape = selectPanelBody.includes("this.sidebarMenu.close('outside')") &&
  selectPanelBody.includes('this.panel = p;') &&
  selectPanelBody.includes('this.renderPanels();') &&
  selectPanelBody.includes('this.relayout();');
const sidebarItemsStart = app.indexOf('private sidebarItems(');
const sidebarItemsEnd = sidebarItemsStart >= 0 ? app.indexOf('\n  }', sidebarItemsStart) : -1;
const sidebarItemsBody = sidebarItemsStart >= 0 && sidebarItemsEnd > sidebarItemsStart
  ? app.slice(sidebarItemsStart, sidebarItemsEnd)
  : '';
const setPanelStart = app.indexOf("setPanel: (p: 'device' | 'analyzers' | 'assistant' | null) => {");
const setPanelEnd = setPanelStart >= 0 ? app.indexOf('\n    },', setPanelStart) : -1;
const setPanelBody = setPanelStart >= 0 && setPanelEnd > setPanelStart
  ? app.slice(setPanelStart, setPanelEnd)
  : '';
const sidebarDelegations = sidebarItemsBody.match(/this\.selectPanel\(/g)?.length ?? 0;
const sharedPanelPath = sidebarDelegations === 4 && setPanelBody.includes('this.selectPanel(');
check(
  'four checked direct choices drive the panel through one shared selection path',
  missingSidebarChoices.length === 0 && selectPanelShape && sharedPanelPath,
  `missing=${JSON.stringify(missingSidebarChoices)}, shape=${selectPanelShape}, shared=${sharedPanelPath}, delegations=${sidebarDelegations}`,
);

const sidebarRowCount = sidebarItemsBody.match(/onPick:/g)?.length ?? 0;
const sidebarLeavesOnly = sidebarRowCount === 4 &&
  !sidebarItemsBody.includes('children:') && !sidebarItemsBody.includes('hint:');
const sidebarLabelsTranslated = ['sidebarDevice', 'sidebarAnalyzers', 'sidebarAssistant', 'sidebarNone']
  .every((key) => sidebarItemsBody.includes(`t('toolbar.${key}')`));
check(
  'the selector menu offers four direct leaf choices built with translated labels',
  sidebarLeavesOnly && sidebarLabelsTranslated,
  `rows=${sidebarRowCount}, leaves=${sidebarLeavesOnly}, translated=${sidebarLabelsTranslated}`,
);

const toolbarHandler = (needle: string): string => {
  const start = app.indexOf(needle);
  const end = start >= 0 ? app.indexOf('\n    });', start) : -1;
  return start >= 0 && end > start ? app.slice(start, end) : '';
};
const settingsHandler = toolbarHandler("must<HTMLButtonElement>('btn-settings').addEventListener('click'");
const sidebarHandler = toolbarHandler("this.el.sidebar.addEventListener('click'");
const languageHandler = toolbarHandler("this.el.language.addEventListener('click'");
const themeHandler = toolbarHandler("this.el.theme.addEventListener('click'");
const assistantHandler = toolbarHandler("this.el.assistant.addEventListener('click'");
const menuHandlerCases = [
  { name: 'settings', body: settingsHandler, menu: 'settingsMenu', items: 'settingsItems', others: ['sidebarMenu', 'languageMenu', 'themeMenu'] },
  { name: 'sidebar', body: sidebarHandler, menu: 'sidebarMenu', items: 'sidebarItems', others: ['settingsMenu', 'languageMenu', 'themeMenu'] },
  { name: 'language', body: languageHandler, menu: 'languageMenu', items: 'languageItems', others: ['settingsMenu', 'sidebarMenu', 'themeMenu'] },
  { name: 'theme', body: themeHandler, menu: 'themeMenu', items: 'themeItems', others: ['settingsMenu', 'sidebarMenu', 'languageMenu'] },
];
const menuHandlerFailures: string[] = [];
for (const item of menuHandlerCases) {
  if (!item.body.includes('this.channelList.closeDialog()') ||
      !item.body.includes(`this.${item.menu}.toggle(this.${item.items}())`)) {
    menuHandlerFailures.push(`${item.name}:open`);
  }
  for (const other of item.others) {
    if (!item.body.includes(`this.${other}.close('outside')`)) menuHandlerFailures.push(`${item.name}:${other}`);
  }
}
const assistantClosesMenus = ['settingsMenu', 'sidebarMenu', 'languageMenu', 'themeMenu']
  .every((menu) => assistantHandler.includes(`this.${menu}.close('outside')`));
const assistantOpensSharedPath = assistantHandler.includes('this.channelList.closeDialog()') &&
  assistantHandler.includes('this.toggleAssistant()');
check(
  'every toolbar menu and the assistant close competing overlays and the channel dialog',
  menuHandlerFailures.length === 0 && assistantClosesMenus && assistantOpensSharedPath,
  `failures=${JSON.stringify(menuHandlerFailures)}, assistant=${assistantClosesMenus && assistantOpensSharedPath}`,
);

const retranslateBody = methodBody('private retranslate(): void {');
const themeChangeBody = themeHandlerAt >= 0 && themeHandlerEnd > themeHandlerAt
  ? app.slice(themeHandlerAt, themeHandlerEnd) : '';
const lifecycleCloseFailures = ['settingsMenu', 'sidebarMenu', 'languageMenu', 'themeMenu'].flatMap((menu) => [
  ...(!retranslateBody.includes(`this.${menu}.close('retranslate')`) ? [`retranslate:${menu}`] : []),
  ...(!themeChangeBody.includes(`this.${menu}.close('theme')`) ? [`theme:${menu}`] : []),
]);
check(
  'all four toolbar menus close for retranslation and theme changes',
  lifecycleCloseFailures.length === 0,
  `missing=${JSON.stringify(lifecycleCloseFailures)}`,
);

const settingsItemsBody = methodBody('private settingsItems(');
const detailedLabelsToggle = settingsItemsBody.includes("label: t('settings.detailedLabels')") &&
  settingsItemsBody.includes('checked: this.detailedLabels') &&
  settingsItemsBody.includes('this.detailedLabels = !this.detailedLabels;') &&
  settingsItemsBody.includes('this.reflectDetailedLabels();');
const detailedLabelsDefault = app.includes('private detailedLabels = true;');
const settingsDisplayOnly = !settingsItemsBody.includes("t('settings.language')") &&
  !settingsItemsBody.includes('LOCALES.map') && !settingsItemsBody.includes('children:') &&
  (settingsItemsBody.match(/onPick:/g)?.length ?? 0) === 1;
const constructorBody = methodBody('constructor() {');
const detailedLabelsReflection = app.includes("document.documentElement.removeAttribute('data-toolbar-labels')") &&
  app.includes("document.documentElement.setAttribute('data-toolbar-labels', 'off')") &&
  (app.match(/this\.reflectDetailedLabels\(\);/g)?.length ?? 0) === 2 &&
  constructorBody.includes('this.reflectDetailedLabels();') &&
  settingsItemsBody.includes('this.reflectDetailedLabels();');
check(
  'settings owns only the checked default-on detailed-label display toggle',
  detailedLabelsToggle && detailedLabelsDefault && detailedLabelsReflection && settingsDisplayOnly,
  `toggle=${detailedLabelsToggle}, default=${detailedLabelsDefault}, reflection=${detailedLabelsReflection}, displayOnly=${settingsDisplayOnly}`,
);

const viewportRestoreOrder = [
  'const { start, end } = this.stack.view;',
  'const follow = this.stack.followLatest;',
  'this.pendingToolbarViewport = { start, end, follow };',
  'this.reflectDetailedLabels();',
  'this.relayout();',
].map((needle) => settingsItemsBody.indexOf(needle));
const noTransientWidthSync = !settingsItemsBody.includes('this.stack.syncSize();');
const noImmediateViewportMutation = !settingsItemsBody.includes('this.stack.setViewport') &&
  !settingsItemsBody.includes('this.stack.setFollowLatest');
const drawBody = methodBody('private draw(): void {');
const frameRestoreOrder = [
  'this.pendingToolbarViewport = null;',
  'this.stack.view.start === pendingViewport.start',
  'this.stack.syncSize();',
  'this.stack.setViewport(pendingViewport.start, pendingViewport.end);',
  'this.stack.setFollowLatest(pendingViewport.follow);',
].map((needle) => drawBody.indexOf(needle));
const followRestored = drawBody.includes('this.stack.setFollowLatest(pendingViewport.follow);');
const relayoutBody = methodBody('private relayout(): void {');
const overlayLayoutSyncs = relayoutBody.match(
  /this\.overlay\.syncSize\(this\.el\.plot\.clientWidth, this\.el\.plot\.clientHeight\);/g,
)?.length ?? 0;
check(
  'layout refreshes overlay geometry and the frame restores viewport/follow only when no newer command won',
  viewportRestoreOrder.every((index) => index >= 0) && noTransientWidthSync && noImmediateViewportMutation &&
    followRestored && overlayLayoutSyncs === 2 &&
    viewportRestoreOrder.every((index, i) => i === 0 || index > viewportRestoreOrder[i - 1]!) &&
    frameRestoreOrder.every((index) => index >= 0) &&
    frameRestoreOrder.every((index, i) => i === 0 || index > frameRestoreOrder[i - 1]!),
  `toggle=${JSON.stringify(viewportRestoreOrder)}, frame=${JSON.stringify(frameRestoreOrder)}, noSync=${noTransientWidthSync}, immediate=${!noImmediateViewportMutation}, follow=${followRestored}, overlay=${overlayLayoutSyncs}`,
);

const railMarkupAbsent = !html.includes('id="rail"') && !html.includes('rail-btn') &&
  !html.includes('rail-device') && !html.includes('rail-analyzers') &&
  !toolbar.includes('rail');
const railWiringAbsent = !app.includes('wireRail') &&
  !app.includes("'rail-device'") && !app.includes("'rail-analyzers'");
const railStylesAbsent = !css.includes('#rail') && !css.includes('.rail-btn') &&
  !css.includes('--rail-w');
const railMetricAbsent = !metricsSrc.includes('railWidth');
check(
  'the legacy rail markup, wiring, styles, and both width metrics are absent',
  railMarkupAbsent && railWiringAbsent && railStylesAbsent && railMetricAbsent,
  `markup=${railMarkupAbsent}, wiring=${railWiringAbsent}, styles=${railStylesAbsent}, tsMetric=${railMetricAbsent}`,
);

const directButtonTranslations = commandIds.filter((id) => /<button\b[^>]*\sdata-i18n\s*=/.test(commandMarkup(id)));
const dynamicNames = [
  "deviceName ? `${t('toolbar.device')}: ${deviceName}` : t('toolbar.device')",
  "this.el.open.setAttribute('aria-label', t('toolbar.open'))",
  "this.el.save.setAttribute('aria-label', t('toolbar.save'))",
  "this.el.fit.setAttribute('aria-label', t('toolbar.fit'))",
  "this.el.settings.setAttribute('aria-label', t('settings.title'))",
  "this.el.language.setAttribute('aria-label', t('toolbar.languageTitle'))",
  "this.el.sidebar.setAttribute('aria-label', t('toolbar.sidebarTitle'))",
];
const missingDynamicNames = dynamicNames.filter((needle) => !app.includes(needle));
const dynamicTransportName = app.includes("btn.setAttribute('aria-label', this.stopping ? t('toolbar.stopping')") &&
  app.includes(": this.running ? t('toolbar.stop') : t('toolbar.start'));");
const retiredVisibleLabelTargets = [
  'connectTitle', 'connectDescription', 'transportTitle',
  "'device-title'", "'device-description'", "'transport-title'",
].filter((needle) => app.includes(needle));
const retiredTransportDescription = ['transportDescription', 'transport-description']
  .filter((needle) => app.includes(needle) || toolbar.includes(needle));
const preservedClasses = app.includes("btn.classList.toggle('primary', !this.running)") &&
  app.includes("btn.classList.toggle('danger', this.running)") && !app.includes('btn.className =');
check(
  'renderToolbarState refreshes toolbar accessible names from state and t()',
  directButtonTranslations.length === 0 && missingDynamicNames.length === 0 &&
    dynamicTransportName && retiredVisibleLabelTargets.length === 0 &&
    retiredTransportDescription.length === 0 && preservedClasses,
  `direct=${JSON.stringify(directButtonTranslations)}, missingNames=${JSON.stringify(missingDynamicNames)}, ` +
    `transportName=${dynamicTransportName}, retired=${JSON.stringify(retiredVisibleLabelTargets)}, ` +
    `retiredDescription=${JSON.stringify(retiredTransportDescription)}, classes=${preservedClasses}`,
);

const dynamicTransportLabel = app.includes("label.textContent = this.stopping ? t('toolbar.shortStopping')") &&
  app.includes(": this.running ? t('toolbar.shortStop') : t('toolbar.shortStart');");
check(
  'the visual transport shorthand follows stopping, running and connected states',
  dynamicTransportLabel,
  `dynamic=${dynamicTransportLabel}`,
);

const toolbarSummaryAbsent = !toolbar.includes('toolbar-session') &&
  !html.includes('capture-title') &&
  !css.includes('toolbar-session');
const titleLookupAbsent = !app.includes("'capture-title'") && !app.includes('this.el.title');
const toolbarStateStart = app.indexOf('private renderToolbarState(): void {');
const statusStart = app.indexOf('private renderStatus(): void {');
const statusEnd = statusStart >= 0 ? app.indexOf('\n  private fail(', statusStart) : -1;
const toolbarStateBody = toolbarStateStart >= 0 && statusStart > toolbarStateStart
  ? app.slice(toolbarStateStart, statusStart)
  : '';
const statusBody = statusStart >= 0 && statusEnd > statusStart
  ? app.slice(statusStart, statusEnd)
  : '';
const toolbarStateDescribesCapture = toolbarStateBody.length === 0 ||
  toolbarStateBody.includes('formatCaptureLabel') || toolbarStateBody.includes('captureLabel');
const statusOwnsCaptureLabel = statusBody.includes('parts.push(formatCaptureLabel(this.captureLabel))');
check(
  'the toolbar carries no capture summary and the status bar is the sole description site',
  toolbarSummaryAbsent && titleLookupAbsent && !toolbarStateDescribesCapture && statusOwnsCaptureLabel,
  `toolbarAbsent=${toolbarSummaryAbsent}, appAbsent=${titleLookupAbsent}, toolbarDescribes=${toolbarStateDescribesCapture}, status=${statusOwnsCaptureLabel}`,
);

const capturePanelKeepsLabelKey = capturePanel.includes("t('capturePanel.capture')");
check(
  'the capture panel retains the capturePanel.capture catalog key after the toolbar removal',
  capturePanelKeepsLabelKey,
  `capturePanel.capture=${capturePanelKeepsLabelKey}`,
);

const labelClassCounts = ['toolbar-item-content', 'toolbar-item-title', 'toolbar-item-description']
  .map((needle) => toolbar.split(needle).length - 1);
const shortLabelKeys = commandIds.map((id) => (
  /class="toolbar-item-label" aria-hidden="true" data-i18n="([^"]+)"/.exec(commandMarkup(id))?.[1] ?? ''
));
const shortLabelsComplete = shortLabelKeys.every((key) => /^toolbar\.short[A-Za-z]+$/.test(key)) &&
  new Set(shortLabelKeys).size === commandIds.length;
const offLabelRule = css.includes('#toolbar .toolbar-item-label { display: none; }');
const onToolbarSizing = css.includes('html:not([data-toolbar-labels="off"]) #toolbar {\n  height: max(var(--toolbar-height, 0px), min-content);\n}');
const onButtonRule = /html:not\(\[data-toolbar-labels="off"\]\) #toolbar button\.toolbar-item \{[^}]*flex-direction: column;[^}]*width: auto;[^}]*height: 58px;/s.test(css);
const onLabelRule = /html:not\(\[data-toolbar-labels="off"\]\) #toolbar \.toolbar-item-label \{[^}]*display: block;[^}]*white-space: nowrap;/s.test(css);
check(
  'every command has a unique concise label; default-on layout and icon-only off layout are both explicit',
  shortLabelsComplete && labelClassCounts.every((count) => count === 0) &&
    offLabelRule && onToolbarSizing && onButtonRule && onLabelRule,
  `keys=${JSON.stringify(shortLabelKeys)}, retired=${JSON.stringify(labelClassCounts)}, off=${offLabelRule}, sizing=${onToolbarSizing}, on=${onButtonRule && onLabelRule}`,
);

const retiredDescriptionStyles = [
  '#toolbar .primary .toolbar-item-description',
  '#toolbar .danger .toolbar-item-description',
  '#toolbar button.toolbar-item:not(.toolbar-device) .toolbar-item-description { display: none; }',
].filter((needle) => css.includes(needle));
check(
  'retired command description styles stay absent',
  retiredDescriptionStyles.length === 0,
  `leftovers=${JSON.stringify(retiredDescriptionStyles)}`,
);

const presentationNeedles = [
  '#toolbar button.toolbar-item:focus-visible',
  '#toolbar .toolbar-device.connected .toolbar-item-media { color: var(--primary); }',
  '#toolbar button.toolbar-item.primary {',
  '#toolbar button.toolbar-item.danger {',
  'button:disabled { opacity: 0.45; cursor: default; }',
  '#toolbar .spacer { display: none; }',
  '#toolbar .toolbar-sidebar { margin-left: auto; }',
];
const missingPresentation = presentationNeedles.filter((needle) => !css.includes(needle));
check(
  'toolbar styles keep focus, connection, transport state, disabled, and mobile placement contracts',
  missingPresentation.length === 0,
  `missing=${JSON.stringify(missingPresentation)}`,
);

const plotCursorDecl = /#plot\s*\{[^}]*?cursor:\s*([^;]+);/.exec(css)?.[1] ?? '';
const plotCursorUri = /url\("([^"]+)"\)/.exec(plotCursorDecl)?.[1] ?? '';
const plotCursorSvg = decodeURIComponent(plotCursorUri.replace(/^data:image\/svg\+xml,/, ''));
const plotCursorPaths = plotCursorSvg.match(/<path\b[^>]*>/g) ?? [];
const haloInkAt = plotCursorSvg.indexOf("stroke='#FFFDF4'");
const coreInkAt = plotCursorSvg.indexOf("stroke='#141415'");
check(
  'the plot pointer is a dual-tone image cursor with a centered hotspot and a native fallback',
  plotCursorDecl.includes('url("data:image/svg+xml,') &&
    plotCursorDecl.trim().endsWith('") 12 12, crosshair') &&
    plotCursorDecl.includes('%23FFFDF4') && plotCursorDecl.includes('%23141415') &&
    plotCursorPaths.length === 2 &&
    plotCursorSvg.includes("stroke='#FFFDF4' stroke-width='3.6'") &&
    plotCursorSvg.includes("stroke='#141415' stroke-width='1.6'") &&
    haloInkAt >= 0 && coreInkAt > haloInkAt &&
    (plotCursorSvg.match(/M12 2v20M2 12h20/g) ?? []).length === 2 &&
    (plotCursorSvg.match(/stroke-linecap='round'/g) ?? []).length === 2 &&
    plotCursorSvg.includes("xmlns='http://www.w3.org/2000/svg'") &&
    plotCursorSvg.includes("width='24' height='24'") &&
    plotCursorSvg.includes("viewBox='0 0 24 24'"),
  `decl=${JSON.stringify(plotCursorDecl.trim().slice(-60))}, paths=${plotCursorPaths.length}, ` +
  `inkAt=${haloInkAt}/${coreInkAt}, svgLen=${plotCursorSvg.length}`,
);

const mobileBlockStart = css.indexOf('@media (max-width: 760px) {');
const mobileBlockEnd = mobileBlockStart >= 0 ? css.indexOf('\n}', mobileBlockStart) : -1;
const mobileBlock = mobileBlockStart >= 0 && mobileBlockEnd > mobileBlockStart
  ? css.slice(mobileBlockStart, mobileBlockEnd)
  : '';
const sidebarMobileAutoMargin = mobileBlock.includes('#toolbar .toolbar-sidebar { margin-left: auto; }');
check(
  'the sidebar selector stays far-right at the mobile breakpoint where the spacer is hidden',
  mobileBlock.includes('#toolbar .spacer { display: none; }') && sidebarMobileAutoMargin,
  `mobileBlock=${mobileBlock.length}, autoMargin=${sidebarMobileAutoMargin}`,
);

function mediaBlockContaining(needle: string): string {
  let from = 0;
  for (;;) {
    const start = css.indexOf('@media (max-width: 760px) {', from);
    if (start < 0) return '';
    const end = css.indexOf('\n}', start);
    if (end < 0) return '';
    const block = css.slice(start, end);
    if (block.includes(needle)) return block;
    from = end + 1;
  }
}
const sidePanelMobileBlock = mediaBlockContaining('#side-panel');
const sidePanelMobileFlushRight = sidePanelMobileBlock.includes('right: 0;');
const sidePanelMobileFullWidth = sidePanelMobileBlock.includes('width: min(var(--panel-w), 100%);');
const sidePanelMobileNoRailGutter = sidePanelMobileBlock.length > 0 &&
  !sidePanelMobileBlock.includes('--rail-w') && !sidePanelMobileBlock.includes('calc(100%');
check(
  'the mobile side panel is flush to the right edge with no rail gutter',
  sidePanelMobileFlushRight && sidePanelMobileFullWidth && sidePanelMobileNoRailGutter,
  `rightFlush=${sidePanelMobileFlushRight}, fullWidth=${sidePanelMobileFullWidth}, noGutter=${sidePanelMobileNoRailGutter}`,
);

function ruleBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  const end = start >= 0 ? source.indexOf('}', start) : -1;
  return start >= 0 && end > start ? source.slice(start, end + 1) : '';
}

function pxValue(rule: string, property: string): number | null {
  const match = new RegExp(`[\\s{;]${property}:\\s*(\\d+)px;`).exec(rule);
  return match ? Number(match[1]) : null;
}

const desktopButtonRule = ruleBlock(css, '#toolbar button.toolbar-item');
const mobileButtonRule = ruleBlock(mobileBlock, '#toolbar button.toolbar-item');
const mediaWrapperRule = ruleBlock(css, '#toolbar .toolbar-item-media');
const toolbarRule = ruleBlock(css, '#toolbar');
const mediaBoxPx = 28;
const buttonBorderPx = 2 * 1;
const desktopWidth = pxValue(desktopButtonRule, 'width');
const desktopHeight = pxValue(desktopButtonRule, 'height');
const desktopPadding = pxValue(desktopButtonRule, 'padding');
const mobileWidth = pxValue(mobileButtonRule, 'width');
const mobileHeight = pxValue(mobileButtonRule, 'height');
const mobilePadding = pxValue(mobileButtonRule, 'padding');
const mediaWrapperKept = ['flex: none;', 'width: 28px;', 'height: 28px;']
  .every((needle) => mediaWrapperRule.includes(needle));
const desktopFitsMedia = desktopWidth !== null && desktopPadding !== null &&
  desktopWidth - 2 * desktopPadding - buttonBorderPx === mediaBoxPx;
check(
  'icon-only base/off rules keep every command a 44x44 desktop square with the retained 28x28 media wrapper',
  desktopWidth === 44 && desktopHeight === 44 && desktopPadding === 7 &&
    desktopFitsMedia && mediaWrapperKept &&
    desktopButtonRule.includes('flex: 0 0 auto;') &&
    desktopButtonRule.includes('justify-content: center;'),
  `width=${desktopWidth}, height=${desktopHeight}, padding=${desktopPadding}, ` +
    `fits=${desktopFitsMedia}, media=${mediaWrapperKept}`,
);
const mobileFitsMedia = mobileWidth !== null && mobilePadding !== null &&
  mobileWidth - 2 * mobilePadding - buttonBorderPx === mediaBoxPx;
check(
  'the 760px breakpoint shrinks every toolbar command to a 38x38 square',
  mobileWidth === 38 && mobileHeight === 38 && mobilePadding === 4 && mobileFitsMedia,
  `width=${mobileWidth}, height=${mobileHeight}, padding=${mobilePadding}, fits=${mobileFitsMedia}`,
);

const buttonRuleDeclaresMinHeight =
  /(?:^|\n)\s*#toolbar button\.toolbar-item[^{]*\{[^}]*min-height/m.test(css);
const deviceOverrideAbsent = !/^\s*#toolbar button\.toolbar-device\s*\{/m.test(css) &&
  !buttonRuleDeclaresMinHeight && !desktopButtonRule.includes('min-height') &&
  !mobileButtonRule.includes('min-height');
const textEraSizing = ['fit-content', 'max-width', 'text-overflow', 'white-space', 'text-align']
  .filter((needle) => desktopButtonRule.includes(needle) || mobileButtonRule.includes(needle));
check(
  'icon-only base/off button rules retire the device min-height override and text-era intrinsic sizing',
  deviceOverrideAbsent && textEraSizing.length === 0,
  `deviceOverrideAbsent=${deviceOverrideAbsent}, textEra=${JSON.stringify(textEraSizing)}`,
);

const fixedSizingNeedles = [
  'flex: 0 1 240px',
  'min-width: 180px',
  'flex: 1 1 96px',
  'flex: 1 1 100%',
];
const fixedSizing = fixedSizingNeedles.filter((needle) => css.includes(needle));
const nonSquareSizing = ['width: 100%', 'max-width: 100%', 'flex: 1 1 0', 'flex-grow: 1']
  .filter((needle) => desktopButtonRule.includes(needle) || mobileButtonRule.includes(needle));
check(
  'toolbar buttons retire fixed, equal, and full-row sizing',
  fixedSizing.length === 0 && nonSquareSizing.length === 0,
  `fixed=${JSON.stringify(fixedSizing)}, nonSquare=${JSON.stringify(nonSquareSizing)}`,
);

const toolbarWraps = toolbarRule.includes('flex-wrap: wrap;');
check(
  'the toolbar keeps wrap as its overflow fallback instead of shrinking the square commands',
  toolbarRule.length > 0 && toolbarWraps && !toolbarRule.includes('flex-wrap: nowrap;'),
  `rule=${JSON.stringify(toolbarRule.replace(/\s+/g, ' '))}, wraps=${toolbarWraps}`,
);

console.log(results.map((result) => (
  `${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`
)).join('\n'));
const failed = results.filter((result) => !result.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
