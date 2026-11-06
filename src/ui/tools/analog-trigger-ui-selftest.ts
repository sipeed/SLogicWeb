// SPDX-License-Identifier: GPL-3.0-or-later

import { analogTriggerAutoArms } from '../state.js';

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(id: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

interface TestResult { name: string; pass: boolean; detail: string }
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const state = fs.readFileSync('src/ui/state.ts', 'utf8');
const workspace = fs.readFileSync('src/ui/workspacePreferences.ts', 'utf8');
const device = fs.readFileSync('src/device/slogic16u3.ts', 'utf8');
const worker = fs.readFileSync('src/device/usbWorker.ts', 'utf8');
const protocol = fs.readFileSync('src/device/usbWorkerProtocol.ts', 'utf8');
const transport = fs.readFileSync('src/device/workerTransport.ts', 'utf8');
const deviceTypes = fs.readFileSync('src/device/types.ts', 'utf8');
const triggerEngine = fs.readFileSync('src/data/softwareTrigger.ts', 'utf8');
const en = fs.readFileSync('src/ui/locales/en.ts', 'utf8');
const zh = fs.readFileSync('src/ui/locales/zh-CN.ts', 'utf8');
const fr = fs.readFileSync('src/ui/locales/fr.ts', 'utf8');
const ru = fs.readFileSync('src/ui/locales/ru.ts', 'utf8');
const channel = fs.readFileSync('src/ui/channelList.ts', 'utf8');
const overlay = fs.readFileSync('src/ui/overlay.ts', 'utf8');
const sheet = fs.readFileSync('src/ui/style.css', 'utf8');

function cssRules(selector: string): string[] {
  const bodies: string[] = [];
  for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(match[2]!);
  }
  return bodies;
}

{
  const rows = channel.includes("triggerButton.className = 'bus-trigger'") &&
    channel.includes('this.openAnalogTriggerMenu(triggerButton!, cell)') &&
    channel.includes('private openAnalogTriggerMenu(') &&
    channel.includes("t('channels.triggerLevel')") &&
    channel.includes('this.cb.onBusTrigger?.(cell.id, selected') &&
    !channel.includes('bus-trigger-value') &&
    overlay.includes('const triggerLabel =') &&
    overlay.includes('formatScopeVolts(scope.triggerVolts!)') &&
    panel.includes("div('global-trigger-list')") &&
    panel.includes("t('capturePanel.noAnalogTrigger')") &&
    !panel.includes('analog-trigger-slope');
  const styled = sheet.includes('.bus-trigger {') && !sheet.includes('.bus-trigger-value') &&
    sheet.includes('.ch-trigger-level {');
  check('the analog trigger is configured on its ADC row; Global Trigger only previews it',
    rows && styled, `rows=${rows}, styled=${styled}`);
}

{
  const armed = panel.includes("s.triggerSource === 'analog'") &&
    panel.includes('digitalWhat.length > 0 || analogWhat.length > 0') &&
    panel.includes('`A${start / CHANNEL_BANK_SIZE} `') &&
    panel.includes('analogTriggerVolts(setting.kind, setting.volts, gainAt(start)).toFixed(4)');
  check('the armed note reports analog crossings when the analog source is armed',
    armed, `armed=${armed}`);
}

{
  const derive = app.includes('private activeAnalogTriggers(') &&
    app.includes('s.analogTriggers?.[start]') &&
    app.includes("clamped.triggerSource === 'digital'") &&
    app.includes("clamped.triggerSource === 'analog'");
  const config = app.includes('const plan = this.triggerPlan(this.settings);') &&
    app.includes('const analogTriggers = plan.analog.filter(') &&
    app.includes('analog: analogTriggers.map((a) => (') &&
    app.includes('level: analogCodeFromVolts(a.volts, a.gain)') &&
    app.includes('const triggerConditions = plan.digital;');
  check('the source plan arms one family and the start config carries its conditions',
    derive && config, `derive=${derive}, config=${config}`);
}

{
  const model = state.includes('analogTriggers: Record<number, AnalogTriggerSetting>') &&
    state.includes("kind: 'rising' | 'falling'") &&
    state.includes('analogTriggers: {},');
  const persisted = workspace.includes('analogTriggers?: Record<string,') &&
    workspace.includes("start % 8 !== 0") &&
    workspace.includes('capture.analogTriggers = restored') &&
    workspace.includes('analogTriggers: { ...(capture.analogTriggers ?? {}) },') &&
    app.includes('analogTriggers: { ...this.settings.analogTriggers },') &&
    app.includes('triggerSource: this.settings.triggerSource,');
  check('analog trigger settings and their source persist through the App snapshot',
    model && persisted, `model=${model}, persisted=${persisted}`);
}

{
  const guards = app.includes('?? allowed[0]!') &&
    app.includes('bus.analogGroup === undefined') &&
    app.includes('const plan = this.triggerPlan(this.settings);') &&
    device.includes('analog triggers are only available on the SLogic32U3');
  check('the slowest ADC rate is the fallback, buses carry an explicit analog marker, and the 16U3 rejects analog',
    guards, `guards=${guards}`);
}

{
  const plan = app.includes("if (s.triggerSource === 'analog')") &&
    app.includes('digital: [], analog: this.activeAnalogTriggers(s).slice(0, 1)') &&
    app.includes('analog: [],') &&
    app.includes("clamped.triggerSource === 'digital'") &&
    app.includes("clamped.triggerSource === 'analog'");
  const ui = panel.includes("div('segmented trigger-source')") &&
    panel.includes("button.dataset.triggerSource = source") &&
    panel.includes("div('global-trigger-list')") &&
    panel.includes("className = 'global-trigger-remove'") &&
    panel.includes('[condition.channel]: \'dont-care\' as const') &&
    panel.includes("t('capturePanel.noDigitalTrigger')") &&
    panel.includes("t('capturePanel.analogSingleNote')") &&
    panel.includes("t('capturePanel.noAnalogTrigger')") &&
    channel.includes('private openAnalogTriggerMenu(') &&
    channel.includes('onBusTrigger?.(cell.id, selected') &&
    app.includes('private configureAnalogTrigger(') &&
    app.includes('const analogStarts = Object.keys(analogTriggers).map(Number).sort((a, b) => a - b);') &&
    app.includes("this.settings.triggerSource === 'analog'") &&
    app.includes('const triggerConditions = plan.digital;');
  const title = en.includes("'capturePanel.softwareTrigger': 'Global trigger',") &&
    zh.includes("'capturePanel.softwareTrigger': '全局触发',");
  check('the Global trigger source arms one family, lists its conditions and removes with X',
    plan && ui && title, `plan=${plan}, ui=${ui}, title=${title}`);
}

{
  const active = channel.includes("(cell.triggerActive === true ? ' armed' : ' configured')") &&
    channel.includes("cell.trigger.armed ? ' armed' : ' configured'") &&
    app.includes("armed: this.settings.triggerEnableMask && this.settings.triggerSource === 'digital'") &&
    app.includes("triggerActive: this.settings.triggerEnableMask &&") &&
    app.includes("this.settings.triggerSource === 'analog'");
  const configured = ['.ch-trigger.configured', '.bus-trigger.configured'].map(cssRules);
  const neutral = configured.every((rules) => rules.length > 0 && rules.every((rule) =>
    rule.includes('color: var(--text80)') && rule.includes('border-color: var(--border-high)') &&
    !rule.includes('var(--accent)') && !rule.includes('var(--primary)') &&
    !rule.includes('var(--warning)')));
  const digitalArmed = cssRules('.ch-trigger.armed');
  const analogArmed = cssRules('.bus-trigger.armed');
  const bright = digitalArmed.length > 0 &&
    JSON.stringify(digitalArmed) === JSON.stringify(analogArmed) &&
    digitalArmed.every((rule) => rule.includes('color: var(--warning)') &&
      rule.includes('border-color: var(--warning)'));
  const draft = channel.includes("let selected: 'rising' | 'falling' | null") &&
    channel.includes('const syncSelected = (): void =>') &&
    channel.includes('selected = kind;') && channel.includes('level.focus();') &&
    channel.includes('const commitSelected = (): void =>') &&
    channel.includes("apply.textContent = t('bus.confirm')");
  check('digital and analog rows share neutral configured and bright selected-source states',
    active && neutral && bright && draft,
    `active=${active}, neutral=${neutral}, bright=${bright}, draft=${draft}`);
}

{
  const configureStart = app.indexOf('private configureAnalogTrigger(');
  const configureEnd = app.indexOf('private syncActiveTrigger(', configureStart);
  const configure = app.slice(configureStart,
    configureEnd > configureStart ? configureEnd : app.indexOf('/** Live scope controls', configureStart));
  const dragStart = app.indexOf('private dragScopeTrigger(');
  const drag = app.slice(dragStart, app.indexOf('private drawBusRows(', dragStart));
  const analogPanelStart = panel.indexOf("const note = div('panel-note');", panel.indexOf("if (s.triggerSource === 'digital')"));
  const analogPanel = panel.slice(analogPanelStart, panel.indexOf('const preOptions', analogPanelStart));
  const planAt = app.indexOf('const plan = this.triggerPlan(this.settings);',
    app.indexOf('private async startCapture'));
  const deviceStartAt = app.indexOf('await device.start(cfg', planAt);
  const runtime = configureStart >= 0 && dragStart >= 0 && analogPanelStart >= 0 &&
    !/if\s*\([^)]*this\.(?:running|stopping)/.test(configure) &&
    !/if\s*\([^)]*this\.(?:running|stopping)[^)]*\)\s*return;/.test(drag) &&
    drag.includes('if (!this.running && !this.stopping && triggerSettingsChanged(this.settings, next))') &&
    app.includes('const visible = trigger.volts >= geometry.bottomV && trigger.volts <= geometry.topV;') &&
    !channel.includes('triggerDisabled') && !analogPanel.includes('remove.disabled') &&
    panel.includes("t('capturePanel.pendingTrigger')") &&
    panel.includes("div(v.running || v.stopping ? 'panel-note' : 'panel-note error')") &&
    planAt >= 0 && deviceStartAt > planAt;
  const popover = channel.includes('private editorBusId: string | null = null;') &&
    channel.includes('const keepAnalogDraft =') &&
    channel.includes('this.editorBusId = cell.id;') &&
    channel.includes('this.positionEditor(anchor);');
  // Edits retune a matcher that is still waiting. After the match the device matcher is
  // frozen; a Loop analog lock retunes the page detector, a disarm tears it down, and a
  // capture that started unarmed restarts to arm.
  const retune = app.includes('private syncActiveTrigger()') &&
    app.includes('reconcileTrigger({') &&
    app.includes('const phase: TriggerReconcilePhase =') &&
    app.includes("if (action === 'restart') {") &&
    app.includes('this.restartCaptureForTrigger();') &&
    app.includes("if (action === 'disable') {") &&
    app.includes('this.disableRunningTrigger();') &&
    app.includes("const update = this.device?.updateSoftwareTrigger as Retune | undefined;") &&
    app.includes('this.triggerRetuneRequested = applied === false;') &&
    app.includes('this.triggerRetuneRejected = liveAnalog !== undefined && !analogAllowed;') &&
    app.includes('if (this.triggerRetuneRejected) {') &&
    panel.includes('v.triggerRetuneRejected') && panel.includes("'capturePanel.triggerRetuneRejected'") &&
    en.includes("'capturePanel.triggerRetuneRejected':") && zh.includes("'capturePanel.triggerRetuneRejected':") &&
    app.includes('if (triggerChanged) this.syncActiveTrigger();') &&
    (app.match(/this\.syncActiveTrigger\(\);/g) ?? []).length >= 4 &&
    app.includes("const editable = !this.stopping;") &&
    app.includes("disabled: this.stopping,") &&
    panel.includes("const triggerEditable = !v.stopping;") &&
    panel.includes('button.disabled = !triggerEditable || analogUnavailable;') &&
    panel.includes('remove.disabled = !triggerEditable;') &&
    panel.includes("mask.disabled = v.stopping;") &&
    panel.includes('triggerPanelNotes({') &&
    panel.includes('notes.pending') && panel.includes('notes.arming') &&
    panel.includes('notes.armedSummary') && panel.includes('notes.memoryReleased') &&
    device.includes('updateSoftwareTrigger(config: SoftwareTriggerConfig): boolean') &&
    device.includes('return trigger.reconfigure(config);') &&
    deviceTypes.includes('updateSoftwareTrigger?(config:') &&
    protocol.includes("kind: 'updateTrigger'") &&
    transport.includes("post(this.worker, { kind: 'updateTrigger', config });") &&
    worker.includes("case 'updateTrigger':") &&
    worker.includes('device.updateSoftwareTrigger?.(message.config);') &&
    triggerEngine.includes('if (config.maxSamples !== this.maxSamples) return false;') &&
    // Live analog retune keeps the start-time ADC guards (32U3 PLL rates only).
    device.includes('if (config.analog?.length) {') &&
    device.includes('if (rate < 100e6 || 800e6 % rate !== 0) return false;') &&
    // A restart requested while start() arms is deferred, not overlapped.
    app.includes('this.captureArming = true;') &&
    app.includes('this.captureArming = false;') &&
    app.includes('this.triggerSyncDeferred = true;');
  check('runtime trigger edits retune, restart or disable according to the live state',
    runtime && popover && retune,
    `runtime=${runtime}, popover=${popover}, retune=${retune}`);
}

{
  const keys = en.includes("'channels.triggerOn':") &&
    en.includes("'channels.triggerLevel':") && en.includes("'bus.triggerDragTip':") &&
    zh.includes("'channels.triggerOn':") && zh.includes("'channels.triggerLevel':") &&
    zh.includes("'bus.triggerDragTip':") && en.includes("'capturePanel.pendingTrigger':") &&
    zh.includes("'capturePanel.pendingTrigger':");
  check('the analog row editor, ruler and pending-run note are localized',
    keys, `keys=${keys}`);
}

{
  const disabled = panel.includes('triggerSec.body.hidden = !s.triggerEnableMask') &&
    app.includes('const softwareTrigger = this.settings.triggerEnableMask &&') &&
    channel.includes("(cell.triggerActive === true ? ' armed' : ' configured')") &&
    channel.includes("cell.trigger.armed ? ' armed' : ' configured'");
  check('disabling Global trigger hides its panel and leaves every condition neutral',
    disabled, `disabled=${disabled}`);
}

{
  const rows: { kind: 'rising' | 'falling' | null; mask: boolean; arms: boolean }[] = [
    { kind: 'rising', mask: false, arms: true },
    { kind: 'falling', mask: false, arms: true },
    { kind: 'rising', mask: true, arms: false },
    { kind: 'falling', mask: true, arms: false },
    { kind: null, mask: false, arms: false },
    { kind: null, mask: true, arms: false },
  ];
  const bad = rows.filter(({ kind, mask, arms }) => analogTriggerAutoArms(kind, mask) !== arms);
  check('an analog rise/fall arms the global trigger; removal never forces it off',
    bad.length === 0,
    bad.length === 0
      ? 'rising/falling arm only while the mask is off; null leaves the mask untouched'
      : bad.map(({ kind, mask, arms }) =>
        `kind=${kind}, mask=${mask}: expected=${arms}, ` +
        `actual=${analogTriggerAutoArms(kind, mask)}`).join('; '));
}

{
  const configureStart = app.indexOf('private configureAnalogTrigger(');
  const configureEnd = app.indexOf('private syncActiveTrigger(', configureStart);
  const configure = configureStart >= 0
    ? app.slice(configureStart, configureEnd > configureStart ? configureEnd : undefined)
    : '';
  const usesHelper = configure.includes(
    'analogTriggerAutoArms(kind, this.settings.triggerEnableMask)') &&
    configure.includes('triggerEnableMask: true');
  const noForcedDisarm = configure.length > 0 && !configure.includes('triggerEnableMask: false');
  check('App.configureAnalogTrigger delegates the auto-arm decision to the tested helper',
    usesHelper && noForcedDisarm,
    `slice=${configure.length}, usesHelper=${usesHelper}, noForcedDisarm=${noForcedDisarm}`);
}

{
  const sites = panel.includes('triggerSec.el.appendChild(enableHelp)') &&
    panel.includes("t('capturePanel.triggerEnableHelp')") &&
    panel.includes("t('capturePanel.triggerSourceHelp')") &&
    panel.includes("t('capturePanel.testModeHelp')");
  const catalogs = [en, zh, fr, ru].every((source) =>
    source.includes("'capturePanel.triggerEnableHelp':") &&
    source.includes("'capturePanel.triggerSourceHelp':") &&
    source.includes("'capturePanel.testModeHelp':"));
  check('trigger and test-mode toggles carry localized help, with the enable note outside the hidden body',
    sites && catalogs, `sites=${sites}, catalogs=${catalogs}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);

export {};
