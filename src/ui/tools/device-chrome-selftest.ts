// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Device chrome: typed connect failures (connectFailure.ts), the other-tab presence probe
 * (deviceTabPresence.ts), the Device command / device menu / empty hint / browser notice
 * view models (deviceChrome.ts), and the index.html + App wiring that renders them.
 */

import { DiagnosticError } from '../../diagnostics.js';
import {
  classifyConnectFailure, connectFailureRetryable, connectGuidanceKey, refineWithPeerTabs,
} from '../connectFailure.js';
import {
  FIRMWARE_UPDATE_URL, deviceMenuItems, deviceSupport, deviceToolbarView, emptyHintKey,
  platformNoticeKey,
} from '../deviceChrome.js';
import {
  DeviceTabPresence, presenceAnswer, presenceReply, type PresenceChannel, type PresenceMessage,
} from '../deviceTabPresence.js';
import { en, type Messages } from '../locales/en.js';
import { fr } from '../locales/fr.js';
import { ru } from '../locales/ru.js';
import { zhCN } from '../locales/zh-CN.js';

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
  if (!process || typeof process.exit !== 'function') throw new Error('this entry point only runs under node');
  return process;
})();
const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

// ------------------------------------------------------------ failure classification

const cases: [string, unknown, ReturnType<typeof classifyConnectFailure>][] = [
  ['claimInterface rejected (another holder)',
    new DiagnosticError('device.claimFailed', { dom: 'NetworkError' }, 'Unable to claim interface.'), 'busy'],
  ['claim failure without a DOMException name',
    new DiagnosticError('device.claimFailed', undefined, 'Unable to claim interface.'), 'busy'],
  ['a re-claim after stop failed', new DiagnosticError('device.reclaimFailed'), 'busy'],
  ['open() SecurityError (udev permission)',
    new DiagnosticError('device.openFailed', { dom: 'SecurityError' }, 'Access denied.'), 'permission'],
  ['"Access denied" text without a name',
    new DiagnosticError('device.openFailed', undefined, 'Access denied.'), 'permission'],
  ['open() NotFoundError (unplugged mid-open)',
    new DiagnosticError('device.openFailed', { dom: 'NotFoundError' }, 'The device was disconnected.'), 'lost'],
  ['device.disconnected diagnostic', new DiagnosticError('device.disconnected', { device: 'SLogic32 U3' }), 'lost'],
  ['no WebUSB', new DiagnosticError('usb.unavailable'), 'unsupported'],
  ['a raw browser DOMException', new DOMException('Access denied.', 'SecurityError'), 'permission'],
  ['a raw "Unable to claim interface 0" Error', new Error('Unable to claim interface 0'), 'busy'],
  ['an unrelated failure stays unclassified', new Error('CTRL stop write failed'), null],
  ['a configure failure with no evidence stays unclassified',
    new DiagnosticError('device.configureFailed', { dom: 'NetworkError' }, 'Unable to set device configuration.'), null],
];
const wrong = cases.filter(([, error, want]) => classifyConnectFailure(error) !== want)
  .map(([name, error, want]) => `${name}: got ${String(classifyConnectFailure(error))}, want ${String(want)}`);
check('connect failures map to busy / permission / lost / unsupported from code, DOMException name, then text',
  wrong.length === 0, wrong.length === 0 ? `${cases.length} cases` : wrong.join('; '));

check('a busy failure narrows to busy-tab only when a slogicweb peer answered',
  refineWithPeerTabs('busy', true) === 'busy-tab' && refineWithPeerTabs('busy', false) === 'busy' &&
    refineWithPeerTabs('permission', true) === 'permission' && refineWithPeerTabs(null, true) === null,
  'busy+peer=busy-tab; others unchanged');

check('every kind has a guidance sentence; Retry is offered except when WebUSB is absent',
  connectGuidanceKey('busy') === 'connectHelp.busy' &&
    connectGuidanceKey('busy-tab') === 'connectHelp.busyTab' &&
    connectGuidanceKey('permission') === 'connectHelp.permission' &&
    connectGuidanceKey('lost') === 'connectHelp.lost' &&
    connectGuidanceKey('unsupported') === 'connectHelp.unsupported' &&
    connectFailureRetryable('busy') && connectFailureRetryable(null) &&
    !connectFailureRetryable('unsupported'),
  'guidance keys + retryable');

const zhBusy = zhCN['connectHelp.busy'];
check('the zh-CN busy guidance names other tabs and PulseView/DSView and asks to close and retry',
  zhBusy.includes('其他标签页或程序') && zhBusy.includes('PulseView/DSView') && zhBusy.includes('关闭后重试'),
  zhBusy);

const slogic = fs.readFileSync('src/device/slogic16u3.ts', 'utf8');
check('the device layer carries the DOMException name on open/configure/claim rejections',
  /new DiagnosticError\(code, cause\.name \? \{ dom: cause\.name \} : undefined,/.test(slogic),
  'usbRejection passes { dom }');

// ------------------------------------------------------------ tab presence

{
  const self = 'tab-a';
  const query: PresenceMessage = { kind: 'query', from: 'tab-b', nonce: 'n1' };
  const reply = presenceReply(query, self, 'SLogic32 U3');
  check('a holding tab answers a peer query; idle tabs and its own echoes stay silent',
    reply?.kind === 'holding' && reply.to === 'tab-b' && reply.nonce === 'n1' &&
      reply.device === 'SLogic32 U3' &&
      presenceReply(query, self, null) === null &&
      presenceReply({ kind: 'query', from: self, nonce: 'n1' }, self, 'X') === null &&
      presenceReply('junk', self, 'X') === null && presenceReply(null, self, 'X') === null,
    JSON.stringify(reply));
  check('a probe only accepts replies addressed to it with its nonce',
    presenceAnswer({ kind: 'holding', to: self, nonce: 'n1', device: 'D' }, self, 'n1') === 'D' &&
      presenceAnswer({ kind: 'holding', to: 'other', nonce: 'n1', device: 'D' }, self, 'n1') === null &&
      presenceAnswer({ kind: 'holding', to: self, nonce: 'n2', device: 'D' }, self, 'n1') === null &&
      presenceAnswer({ kind: 'query', from: 'x', nonce: 'n1' }, self, 'n1') === null,
    'addressed + nonce-matched only');
}

/** An in-memory same-origin bus: like BroadcastChannel, a post never reaches its sender. */
class Bus {
  readonly ends: FakeChannel[] = [];
  open(): FakeChannel {
    const end = new FakeChannel(this);
    this.ends.push(end);
    return end;
  }
}
class FakeChannel implements PresenceChannel {
  readonly listeners = new Set<(event: { data: unknown }) => void>();
  constructor(private readonly bus: Bus) {}
  postMessage(message: PresenceMessage): void {
    for (const end of this.bus.ends) {
      if (end === this) continue;
      for (const l of [...end.listeners]) queueMicrotask(() => l({ data: message }));
    }
  }
  addEventListener(_type: 'message', l: (event: { data: unknown }) => void): void { this.listeners.add(l); }
  removeEventListener(_type: 'message', l: (event: { data: unknown }) => void): void { this.listeners.delete(l); }
}

async function presenceRoundTrip(): Promise<void> {
  const bus = new Bus();
  let heldByB: string | null = 'SLogic16 U3';
  const a = new DeviceTabPresence(() => null, bus.open());
  const aChannel = bus.ends[0]!;
  new DeviceTabPresence(() => heldByB, bus.open());
  new DeviceTabPresence(() => null, bus.open());
  const found = await a.probe(20);
  heldByB = null;
  const none = await a.probe(20);
  const listenersLeft = aChannel.listeners.size;
  const lonely = await new DeviceTabPresence(() => 'X', null).probe(5);
  check('a probe collects the holding peer, then nothing once it releases, and cleans up its listener',
    found.length === 1 && found[0] === 'SLogic16 U3' && none.length === 0 && listenersLeft === 1 &&
      lonely.length === 0,
    `found=${JSON.stringify(found)}, none=${JSON.stringify(none)}, listeners=${listenersLeft}, ` +
      `noChannel=${JSON.stringify(lonely)}`);
}

// ------------------------------------------------------------ chrome view models

check('device support: WebUSB present, absent in a secure context, or hidden by an insecure one',
  deviceSupport({ usb: true, secureContext: true }) === 'ok' &&
    deviceSupport({ usb: false, secureContext: true }) === 'unsupported' &&
    deviceSupport({ usb: false, secureContext: false }) === 'insecure',
  'ok / unsupported / insecure');

{
  const idle = deviceToolbarView(null, 'ok');
  const on = deviceToolbarView('SLogic32 U3', 'ok');
  const none = deviceToolbarView(null, 'unsupported');
  const insecure = deviceToolbarView(null, 'insecure');
  check('the Device command: idle opens the chooser, connected shows the model and state, no WebUSB disables',
    idle.label === en['toolbar.connect'] && idle.ariaLabel === en['toolbar.connect'] &&
      idle.state === null && !idle.disabled && !idle.connected && idle.primary &&
      idle.title === en['toolbar.connectHint'] && !on.primary && !none.primary && !insecure.primary &&
      on.label === 'SLogic32 U3' && on.state === en['toolbar.deviceConnected'] && on.connected &&
      on.ariaLabel === `${en['toolbar.device']}: SLogic32 U3` &&
      on.title === en['toolbar.deviceMenuTitle'].replace('{device}', 'SLogic32 U3') &&
      none.disabled && none.title === en['toolbar.noWebusb'] &&
      insecure.disabled && insecure.title === en['toolbar.noWebusbInsecure'],
    JSON.stringify({ idle, on, none, insecure }));
  check('the connected title no longer says Reconnect and the no-WebUSB tooltip has no dev-only wording',
    !on.title.toLowerCase().includes('reconnect') &&
      !(['en', 'zh-CN', 'fr', 'ru'] as const).some((l) => {
        const m: Messages = l === 'en' ? en : l === 'zh-CN' ? zhCN : l === 'fr' ? fr : ru;
        return /127\.0\.0\.1|Brave/.test(m['toolbar.noWebusb']);
      }),
    on.title);
}

check('disconnected, the Device command reads Connect device and every connect hint names that label',
  (['en', 'zh-CN', 'fr', 'ru'] as const).every((l) => {
    const m: Messages = l === 'en' ? en : l === 'zh-CN' ? zhCN : l === 'fr' ? fr : ru;
    return m['toolbar.connectHint'].includes(m['toolbar.connect']);
  }),
  `${en['toolbar.connectHint']} | ${zhCN['toolbar.connectHint']}`);

check('the empty hint follows the connection: connect invite, Capture prompt, or files only',
  emptyHintKey(false, 'ok') === 'emptyHint.line2' &&
    emptyHintKey(true, 'ok') === 'emptyHint.line2Connected' &&
    emptyHintKey(false, 'unsupported') === 'emptyHint.line2NoUsb' &&
    emptyHintKey(false, 'insecure') === 'emptyHint.line2NoUsb' &&
    !/connect/i.test(en['emptyHint.line2NoUsb']) && en['emptyHint.line2Connected'].includes('{device}'),
  'line2 / line2Connected / line2NoUsb');

check('the browser notice appears only without WebUSB and names HTTPS only for an insecure context',
  platformNoticeKey('ok') === null && platformNoticeKey('unsupported') === 'notice.noUsb' &&
    platformNoticeKey('insecure') === 'notice.noUsbInsecure' &&
    !/HTTPS/.test(en['notice.noUsb']) && /HTTPS/.test(en['notice.noUsbInsecure']) &&
    zhCN['notice.noUsb'] === '当前浏览器只能查看和解码文件，连接设备请使用 Chrome 或 Edge。',
  `${en['notice.noUsb']} | ${en['notice.noUsbInsecure']}`);

{
  const picked: string[] = [];
  const items = deviceMenuItems({ name: 'SLogic32 U3', serial: '' }, {
    disconnect: () => picked.push('disconnect'),
    connectAnother: () => picked.push('another'),
    firmwareUpdate: () => picked.push('firmware'),
  });
  const info = items.filter((i) => i.info === true);
  const actions = items.filter((i) => i.info !== true);
  for (const a of actions) a.onPick?.();
  check('the device menu lists model, serial (unknown when empty) and link (unknown), then three actions',
    info.length === 3 && info[0]!.hint === 'SLogic32 U3' && info[1]!.hint === en['deviceMenu.unknown'] &&
      info[2]!.hint === en['deviceMenu.linkUnknown'] && info.every((i) => i.onPick === undefined) &&
      actions.map((a) => a.label).join('|') ===
        [en['deviceMenu.disconnect'], en['deviceMenu.connectAnother'], en['deviceMenu.firmware']].join('|') &&
      picked.join(',') === 'disconnect,another,firmware' &&
      FIRMWARE_UPDATE_URL === 'https://slogic.sipeed.com/ota/',
    JSON.stringify(items.map((i) => [i.label, i.hint ?? '', i.info === true])));
}

// ------------------------------------------------------------ wiring

const html = fs.readFileSync('index.html', 'utf8');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
check('the tab title is localized, and waveform/label areas opt out of machine translation',
  html.includes('<title data-i18n="app.title">SLogic Logic Analyzer</title>') &&
    en['app.title'] === 'SLogic Logic Analyzer' && zhCN['app.title'] === 'SLogic 逻辑分析仪' &&
    html.includes('<div id="labels-col" translate="no">') &&
    html.includes('<div id="plot" translate="no">') &&
    html.includes('<div id="empty-hint" translate="yes">') &&
    app.includes('document.documentElement.lang = getLocale();'),
  'title + translate attributes + <html lang>');

check('the banner has guidance and Retry slots, and the notice is a separate dismissible status',
  html.includes('id="error-banner-guidance"') && /id="error-banner-retry"[^>]*hidden/.test(html) &&
    /<div id="platform-notice"[^>]*role="status"[^>]*hidden/.test(html) &&
    html.includes('id="platform-notice-dismiss"') &&
    app.includes("this.el.errorRetry.hidden = err?.retry !== true;") &&
    app.includes('this.el.errorGuidance.hidden = guidance === undefined;'),
  'markup + renderErrorBanner');

check('both acquisition paths report through failAcquire; the connected Device click opens the menu',
  app.includes("this.failAcquire('error.connect', e);") &&
    app.includes("this.failAcquire('error.reconnect', e);") &&
    !app.includes("this.fail('error.connect', e);") &&
    app.includes('this.menuStack.register(this.deviceMenu);') &&
    app.includes("this.el.errorRetry.addEventListener('click', () => void this.retryAcquire());"),
  'failAcquire + device menu + retry');

async function main(): Promise<void> {
  await presenceRoundTrip();
  let failures = 0;
  for (const result of results) {
    if (!result.pass) failures++;
    console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n        ${result.detail}`);
  }
  console.log(`\n${results.length - failures}/${results.length} passed`);
  if (failures) nodeProcess.exit(1);
}

void main();
