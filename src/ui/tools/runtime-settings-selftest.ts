// SPDX-License-Identifier: GPL-3.0-or-later

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

function between(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = a >= 0 ? source.indexOf(end, a) : -1;
  return a >= 0 && b > a ? source.slice(a, b) : '';
}

const fs = nodeProcess.getBuiltinModule?.('fs') as {
  readFileSync(path: string, encoding: string): string;
} | undefined;
if (!fs) throw new Error('node fs module unavailable');
const app = fs.readFileSync('src/ui/app.ts', 'utf8');
const panel = fs.readFileSync('src/ui/capturePanel.ts', 'utf8');
const en = fs.readFileSync('src/ui/locales/en.ts', 'utf8');
const zh = fs.readFileSync('src/ui/locales/zh-CN.ts', 'utf8');

{
  const editable = panel.includes('b.disabled = v.stopping;') &&
    panel.includes('const analogBusy = v.stopping;');
  const sharedLock = panel.includes('const captureLocked = captureOptionsLocked(v);') &&
    panel.includes('b.disabled = captureLocked') &&
    (panel.match(/disabled: captureLocked/g) ?? []).length === 3 &&
    (panel.match(/applyCaptureLock\(/g) ?? []).length === 4 &&
    !panel.includes('const modeLocked') && !panel.includes('timeLocked');
  const guard = app.includes('.ch-editor-popover, button, [role="button"], [role="slider"]');
  check('width and analog stay editable while running; mode and all three time controls lock on one predicate',
    editable && sharedLock && guard,
    `editable=${editable}, sharedLock=${sharedLock}, guard=${guard}`);
}

{
  const notes = panel.includes("pending.textContent = t('capturePanel.pendingApply');") &&
    !panel.includes("t(s.mode === 'loop'") &&
    !panel.includes('pendingApplyLoop') &&
    en.includes("'capturePanel.pendingApply':") &&
    zh.includes("'capturePanel.pendingApply':") &&
    !en.includes("'capturePanel.pendingApplyLoop':") &&
    !zh.includes("'capturePanel.pendingApplyLoop':");
  check('the panel explains that capture settings apply next time in one sentence for every mode',
    notes, `notes=${notes}`);
}

{
  const render = between(app, 'private renderChannelCount(): number {', '\n  }');
  const rows = app.includes('const width = this.renderChannelCount();') &&
    app.includes('return index < Math.min(this.renderChannelCount(), this.store.channelCount);') &&
    app.includes('if (index >= this.renderChannelCount()) return;') &&
    app.includes('lockedChannelBanks(this.busViews, this.renderChannelCount())');
  check('the running store keeps its own width for rows, availability and bank locks',
    render.includes('this.running || this.stopping ? this.store.channelCount') && rows,
    `render=${render.length}, rows=${rows}`);
}

{
  const width = between(app, 'private setChannelWidth(channels: number): void {', 'private afterChannelChange');
  const analog = between(app, 'private toggleAnalog(start: number): void {', 'private analogGroups');
  check('width and analog view changes are accepted while running and blocked only while stopping',
    width.includes('if (this.stopping) return;') && !width.includes('if (this.running || this.stopping) return;') &&
    width.includes('if (!this.running && !this.loadedCapture()) {') &&
    analog.includes('if (this.stopping) return;') && !analog.includes('if (this.running || this.stopping) return;'),
    `width=${width.includes('if (this.stopping) return;')}, filter=${width.includes('if (!this.running && !this.loadedCapture()) {')}, ` +
    `analog=${analog.includes('if (this.stopping) return;')}`);
}

{
  const apply = between(app, 'private applySettings(s: CaptureSettings): void {',
    '  private configureChannel(channel: number, config: ChannelConfiguration): void {');
  const live = apply.includes('const liveLoopWindow = this.running && this.captureIsLoop &&') &&
    apply.includes('next.loopSamples !== this.settings.loopSamples &&') &&
    apply.includes('next.samplerate === this.settings.samplerate &&') &&
    apply.includes('next.channels === this.settings.channels;') &&
    apply.includes('this.loopRetentionLen = clampLoopSamples(next.loopSamples, storeChannels);') &&
    apply.includes('this.enforceLoopRetention(capture);') &&
    !apply.includes('this.enforceLoopRetention(this.storeRef)');
  const start = app.includes('const cfg: CaptureConfig = {') &&
    app.includes('channels: this.settings.channels,') &&
    app.includes('samplerate: this.settings.samplerate,') &&
    app.includes('thresholdVolts: this.settings.thresholdVolts,');
  check('a Loop Duration edit applies next frame; rate, width and threshold wait for the next start',
    live && start, `live=${live}, start=${start}`);
}

{
  const startLabel = en.includes("'toolbar.start': 'Capture',") &&
    en.includes("'toolbar.shortStart': 'Capture',") &&
    zh.includes("'toolbar.start': '采集',") &&
    zh.includes("'toolbar.shortStart': '采集',") &&
    en.includes("'capturePanel.repeatInterval': 'Interval',") &&
    zh.includes("'capturePanel.repeatInterval': '间隔',");
  check('the primary action reads Capture and Repeat reads Interval in both locales',
    startLabel, `labels=${startLabel}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
