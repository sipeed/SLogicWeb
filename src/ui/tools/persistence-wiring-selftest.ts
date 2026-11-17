// SPDX-License-Identifier: GPL-3.0-or-later

import {
  CapturePanel, persistenceLengthLabel, persistenceNoteText,
  type CapturePanelCallbacks, type CapturePanelView, type PersistencePanelView,
} from '../capturePanel.js';
import { defaultCaptureSettings } from '../state.js';
import type { MeasurementSectionView } from '../measurementState.js';
import { installFakeDom, type FakeElement } from './fakeDom.js';

interface FsLike {
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface TestResult {
  name: string;
  pass: boolean;
  detail: string;
}

const nodeProcess = (() => {
  const p = (globalThis as {
    process?: { exit(code: number): never; getBuiltinModule?(name: string): unknown };
  }).process;
  if (!p || typeof p.exit !== 'function') throw new Error('this entry point only runs under node');
  return p;
})();

const fs = nodeProcess.getBuiltinModule?.('fs') as FsLike | undefined;
if (!fs || typeof fs.readFileSync !== 'function') throw new Error('node fs module unavailable');

const results: TestResult[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
}

const read = (path: string): string => fs.readFileSync(path, 'utf8');
const slice = (source: string, from: string, to: string): string => {
  const start = source.indexOf(from);
  if (start < 0) return '';
  const end = source.indexOf(to, start + from.length);
  return end < 0 ? '' : source.slice(start, end);
};
function methodBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  if (start < 0) return '';
  const open = text.indexOf('{', start + signature.length - 1);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return '';
}
const count = (text: string, needle: string): number => text.split(needle).length - 1;

const app = read('src/ui/app.ts');
const panel = read('src/ui/capturePanel.ts');
const overlay = read('src/ui/overlay.ts');
const surfaces = read('src/ui/persistenceSurfaces.ts');
const sheet = read('src/ui/style.css');
const design = read('docs/DESIGN.md');
const captureDraw = slice(panel, 'const measureSec = section(', 'cursorPage.appendChild(measureSec.el)');
const frameBody = methodBody(app, 'private frame = (): void => {');
const drawBody = methodBody(app, 'private draw(force = true): void {');
const submitBody = methodBody(app, 'private submitPersistenceWave(');
const setBody = methodBody(app, 'private setPersistence(');
const clearBody = methodBody(app, 'private clearPersistence(');
const syncBody = slice(app, 'private syncPersistenceTrail(', 'private settlePersistenceCommit(');
const settleBody = slice(app, 'private settlePersistenceCommit(', 'private submitPersistenceWave(');
const sourcesBody = methodBody(app, 'private persistenceSources(');
const busRowsBody = methodBody(app, 'private drawBusRows(');
const busSigBody = methodBody(app, 'private busSignature(viewStart: number, viewEnd: number): number {');
const measurementBody = methodBody(app, 'private measurementView(): MeasurementSectionView {');
const recordBody = methodBody(app, 'private recordMeasurementWave(');
const stopBody = methodBody(app, 'private async stopCapture(');
const finishBody = methodBody(app, 'private finishCapture(');
const adoptionBody = methodBody(app, 'private adoptCapture(');
const startBody = methodBody(app, 'private async startCapture(');

{
  check('one submit call site, and it shares the acquisition predicate through the pure model',
    count(app, 'shouldCommitPersistence(') === 1 &&
    submitBody.includes('shouldCommitPersistence({') &&
    submitBody.includes('samples: this.captureStore.length,') &&
    submitBody.includes("missed: this.triggerState === 'not-found',") &&
    submitBody.includes("reason: this.captureAbort === null ? reason : 'error',") &&
    submitBody.includes('lastWaveKey: this.persistenceLastWaveKey,') &&
    !submitBody.includes('acquisitionWaveCompleted(') &&
    !surfaces.includes('acquisitionWaveCompleted(') &&
    read('src/ui/persistenceTrail.ts').includes('acquisitionWaveCompleted({'),
    `calls=${count(app, 'shouldCommitPersistence(')}, ` +
    `shared=${read('src/ui/persistenceTrail.ts').includes('acquisitionWaveCompleted({')}`);

  const persistenceBodies = [
    finishBody, submitBody, settleBody, syncBody, setBody, clearBody,
  ].join('\n');
  const submitAt = count(app, 'this.submitPersistenceWave(reason);');
  check('a completed Single/Repeat wave is the only submitter: Stop, status and animation frames never submit',
    submitAt === 1 &&
    finishBody.includes('this.recordMeasurementWave(reason);\n    this.submitPersistenceWave(reason);') &&
    !stopBody.includes('submitPersistenceWave') &&
    !frameBody.includes('submitPersistenceWave') &&
    !frameBody.includes('shouldCommitPersistence') &&
    !persistenceBodies.includes('setInterval') &&
    !persistenceBodies.includes('setTimeout') &&
    !app.includes('setInterval(() => this.submitPersistenceWave') &&
    !app.includes('setTimeout(() => this.submitPersistenceWave') &&
    !app.includes('requestAnimationFrame(() => this.submitPersistenceWave') &&
    count(app, 'persistencePendingKey = waveKey;') === 1,
    `calls=${submitAt}, finish=${finishBody.includes('submitPersistenceWave(reason)')}, ` +
    `stop=${stopBody.includes('submitPersistenceWave')}, frame=${frameBody.includes('submitPersistenceWave')}, ` +
    `timer=${persistenceBodies.includes('setInterval') || persistenceBodies.includes('setTimeout')}`);

  const idempotent = submitBody.includes(
    'const waveKey = acquisitionWaveKey(this.captureSessionId, this.captureWaveGeneration);') &&
    submitBody.includes('this.persistenceLastWaveKey = waveKey;') &&
    submitBody.includes('this.persistencePendingKey = waveKey;') &&
    submitBody.indexOf('this.persistenceLastWaveKey = waveKey;') <
      submitBody.indexOf('this.persistencePendingKey = waveKey;');
  check('the session:generation wave key makes a duplicated completion notification idempotent',
    idempotent && !submitBody.includes('Date.now') && !submitBody.includes('performance.now'),
    `idempotent=${idempotent}`);
}

{
  const writes = ['this.settings', 'applySettings(', 'startCapture(', 'persistWorkspace()',
    'this.pause', 'this.session =', 'this.captureIsLoop ='];
  const leaking = writes.filter((needle) =>
    setBody.includes(needle) || clearBody.includes(needle) || submitBody.includes(needle));
  check('enabling, changing or clearing Persistence never writes acquisition or settings state',
    leaking.length === 0 && setBody.includes('this.persistenceFrames = next;') &&
    !app.includes('persistenceFrames: this.persistenceFrames,'),
    `leaking=${JSON.stringify(leaking)}`);
  check('Persistence is session-only: the workspace snapshot never carries it',
    !read('src/ui/workspacePreferences.ts').includes('ersistence') &&
    !read('src/ui/state.ts').includes('ersistence'),
    `workspace=${read('src/ui/workspacePreferences.ts').includes('ersistence')}`);
}

{
  const reportBody = slice(app, 'persistence: () => ({', 'setPersistence: (raw: unknown)');
  const sidebarGate = app.replace('      visible: true,\n',
    '      visible: this.cursorsPageShown(),\n');
  const gatedSubmit = methodBody(sidebarGate, 'private submitPersistenceWave(');
  check('a completed wave commits under whichever sidebar page is docked: no page gate pauses it',
    submitBody.includes('visible: true,') &&
    !submitBody.includes('cursorsPageShown') && !submitBody.includes('this.sidebar') &&
    gatedSubmit !== submitBody && gatedSubmit.includes('visible: this.cursorsPageShown(),') &&
    reportBody.includes('loop: this.persistenceLoop(),'),
    `visible=${submitBody.includes('visible: true,')}, ` +
    `gated=${gatedSubmit.includes('cursorsPageShown')}, ` +
    `report=${reportBody.includes('loop: this.persistenceLoop(),')}`);
  const staleReason = app.replace('    this.persistenceClearReason = null;\n' +
    '    if (next === 0)', '    if (next === 0)');
  const staleBody = methodBody(staleReason, 'private setPersistence(');
  check('changing the trail length or switching it off drops the previous clear notice',
    setBody.includes('this.persistenceClearReason = null;') &&
    staleBody !== setBody && !staleBody.includes('this.persistenceClearReason = null;'),
    `reset=${setBody.includes('this.persistenceClearReason = null;')}, ` +
    `control=${!staleBody.includes('this.persistenceClearReason = null;')}`);
}

{
  const secondSubmit = app.replace('private frame = (): void => {',
    "private frame = (): void => {\n    this.submitPersistenceWave('completed');");
  const viewedPersistence = app.replace(
    'private measurementView(): MeasurementSectionView {',
    'private measurementView(): MeasurementSectionView {\n    void this.persistenceFrames;');
  const perFrameCommit = app.replace(
    '    this.settlePersistenceCommit(commitsTrail, analogRows);',
    '    this.settlePersistenceCommit(commitsTrail, analogRows);\n' +
    "    this.persistencePendingKey = 'x';");
  const frameSubmits = methodBody(secondSubmit, 'private frame = (): void => {')
    .includes('submitPersistenceWave');
  const measurementReads = methodBody(
    viewedPersistence, 'private measurementView(): MeasurementSectionView {')
    .includes('ersistence');
  const frameCommits = methodBody(perFrameCommit, 'private drawBusRows(')
    .includes("this.persistencePendingKey = 'x';");
  check('control: a second submitter, a measurement that reads the setting or a frame-driven commit fails the same predicates',
    count(secondSubmit, 'this.submitPersistenceWave(') === 2 && frameSubmits &&
    measurementReads && frameCommits &&
    !frameBody.includes('submitPersistenceWave') &&
    !measurementBody.includes('ersistence') &&
    !busRowsBody.includes("this.persistencePendingKey = 'x';"),
    `submits=${count(secondSubmit, 'this.submitPersistenceWave(')}, frame=${frameSubmits}, ` +
    `measurement=${measurementReads}, frameCommit=${frameCommits}`);
}

{
  check('Stop freezes the surface: only a new session or a replacement clears it',
    !stopBody.includes('clearPersistence') && !finishBody.includes('clearPersistence') &&
    startBody.includes("this.clearPersistence('capture-session');") &&
    adoptionBody.includes("this.clearPersistence('capture-replacement');") &&
    count(app, "this.clearPersistence('capture-session');") === 1 &&
    count(app, "this.clearPersistence('capture-replacement');") === 1,
    `session=${count(app, "clearPersistence('capture-session')")}, ` +
    `replacement=${count(app, "clearPersistence('capture-replacement')")}`);
  const loopBody = methodBody(app, 'private persistenceLoop(): boolean {');
  check('Loop (selected or displayed) forces the effective setting off while the stored choice survives',
    loopBody.includes("return this.captureIsLoop || this.settings.mode === 'loop';") &&
    methodBody(app, 'private effectivePersistenceFrames(')
      .includes('effectivePersistence(this.persistenceFrames, this.persistenceLoop())') &&
    count(app, 'loop: this.persistenceLoop(),') === 3 &&
    read('src/ui/persistenceTrail.ts').includes('return loop ? 0 : persistenceOf(frames);'),
    `loop=${loopBody.includes('settings.mode')}, ` +
    `effective=${methodBody(app, 'private effectivePersistenceFrames(').includes('persistenceLoop()')}`);
}

{
  const geometry = syncBody.includes('width: this.overlay.widthCss,') &&
    syncBody.includes('dpr: globalThis.devicePixelRatio || 1,') &&
    syncBody.includes('viewportStart: view.start,') &&
    syncBody.includes('viewportEnd: view.end,') &&
    syncBody.includes('analogLayout: this.analogLayout,') &&
    syncBody.includes('samplerate: this.store.samplerate,') &&
    syncBody.includes('event: this.persistenceClearEvent,') &&
    syncBody.includes('sources: this.persistenceSources(band, hidden),') &&
    syncBody.includes("this.persistenceClearEvent = 'none';");
  check('the clear key is built from the live viewport span, geometry, layout, rate and every source',
    geometry && sourcesBody.includes('gain: analogGainOf(bus),') &&
    sourcesBody.includes('voltsPerDiv: this.scopeTargetVoltsPerDiv(bus),') &&
    sourcesBody.includes('zeroPosition: Math.min(1, Math.max(0, bus.zeroPosition ?? 0.5)),') &&
    sourcesBody.includes('offsetV: bus.offsetV,') &&
    sourcesBody.includes('visible: !hidden.has(bus.id),'),
    `geometry=${geometry}`);

  check('the surfaces are built from the current analog bands only, and released when a band leaves',
    busRowsBody.includes('const band = this.analogRowBands[analogIndex];') &&
    busRowsBody.includes('analogRows.push({ band, box });') &&
    busRowsBody.includes('this.syncPersistenceTrail(analogRows, hidden);') &&
    surfaces.includes("this.surfaces.delete(id);") &&
    surfaces.includes('removed.push(id);') &&
    count(app, 'this.persistenceTrail.sync(') === 1,
    `sync=${count(app, 'this.persistenceTrail.sync(')}`);

  check('the trail enters the bus signature, and a reallocation latches a bus repaint',
    busSigBody.includes('this.persistenceSignatureValue(),') &&
    syncBody.includes('if (result.reallocated || result.removed.length > 0) this.persistenceLatched = true;') &&
    drawBody.includes('const persistenceLatched = this.persistenceLatched;') &&
    drawBody.includes('bus: overlayInvalidation.bus || persistenceLatched,'),
    `sig=${busSigBody.includes('persistenceSignatureValue')}, ` +
    `latch=${drawBody.includes('persistenceLatched')}`);
}

{
  const commitAt = busRowsBody.indexOf(
    'const trail = this.persistenceTrail.trailOf(band.id, persistenceFrames, commitsTrail);');
  check('an eligible wave attenuates and repaints each band once, then blits under the live trace',
    busRowsBody.includes('const commitsTrail = this.persistencePendingKey !== null && store.length > 0;') &&
    commitAt > busRowsBody.indexOf('this.syncPersistenceTrail(analogRows, hidden);') &&
    commitAt < busRowsBody.indexOf('this.overlay.drawAnalog(view);') &&
    busRowsBody.includes('...(trail === undefined ? {} : { trail }),') &&
    busRowsBody.includes('this.settlePersistenceCommit(commitsTrail, analogRows);') &&
    settleBody.includes('for (const { band } of rows) this.persistenceTrail.commit(band.id);') &&
    settleBody.includes('this.persistenceClearReason = null;') &&
    settleBody.includes('if (this.persistencePendingKey === null) return;') &&
    overlay.includes('if (o.trail?.commit) this.commitAnalogTrail(o, o.trail);') &&
    overlay.indexOf('if (o.trail?.commit) this.commitAnalogTrail(o, o.trail);') <
      overlay.indexOf('if (o.trail) c.drawImage(o.trail.canvas, 0, o.top, this.wCss, o.band);'),
    `commitAt=${commitAt}`);
  const commitOverlay = methodBody(overlay, '  private commitAnalogTrail(');
  check('the commit attenuates by the exponential decay and paints only the band traces',
    commitOverlay.includes("g.globalCompositeOperation = 'destination-in';") &&
    commitOverlay.includes('g.globalAlpha = trail.decay;') &&
    commitOverlay.includes('this.paintAnalogTraces(g, { ...o, top: 0 });') &&
    !commitOverlay.includes('references') && !commitOverlay.includes('o.note') &&
    !commitOverlay.includes('geometry') &&
    surfaces.includes('decay: trailDecay(frames),'),
    `attenuate=${commitOverlay.includes('destination-in')}, ` +
    `traces=${commitOverlay.includes('paintAnalogTraces')}`);
}

{
  check('Persistence never feeds measurements, statistics, references, capture files or the workspace',
    measurementBody.length > 0 && !measurementBody.includes('ersistence') &&
    recordBody.length > 0 && !recordBody.includes('ersistence') &&
    !read('src/ui/measurementState.ts').includes('ersistence') &&
    !read('src/ui/measurementStats.ts').includes('ersistence') &&
    !read('src/ui/measureSamples.ts').includes('ersistence') &&
    !read('src/ui/measurementCatalog.ts').includes('ersistence') &&
    !read('src/ui/referenceTraces.ts').includes('ersistence') &&
    !read('src/ui/acquisitionWave.ts').includes('ersistence') &&
    !read('src/dsp/analogScan.ts').includes('ersistence') &&
    !read('src/ui/captureIO.ts').includes('ersistence') &&
    !read('src/ui/srSave.ts').includes('ersistence'),
    `measurementView=${measurementBody.includes('ersistence')}, ` +
    `record=${recordBody.includes('ersistence')}`);
  check('the reference pass is outside the persistence surface: only band traces are committed',
    !methodBody(overlay, '  private paintAnalogTraces(').includes('o.references') &&
    !overlay.slice(
      overlay.indexOf('  private commitAnalogTrail('),
      overlay.indexOf('  private paintAnalogTraces(')).includes('reference'),
    `paint=${methodBody(overlay, '  private paintAnalogTraces(').includes('o.references')}`);
}

{
  check('the Off/8/16/32 control lives inside the measurement section, not the capture page or a ruler menu',
    captureDraw.includes("div('measure-persistence')") &&
    captureDraw.includes("'measure.persistence',") &&
    captureDraw.includes('PERSISTENCE_FRAMES.map(') &&
    !slice(panel, 'const chSec = section(', 'const measureSec = section(')
      .includes('measure.persistence') &&
    !read('src/ui/scopeMenu.ts').includes('ersistence') &&
    !read('src/ui/busView.ts').includes('ersistence') &&
    panel.includes("onPickPersistence(raw: unknown): void;") &&
    app.includes('onPickPersistence: (raw) => this.setPersistence(raw),'),
    `section=${captureDraw.includes("'measure.persistence'")}`);

  check('the control is disabled in Loop with a reason, and Clear never touches live data',
    captureDraw.includes('persistenceLength.disabled = v.persistence.loop;') &&
    captureDraw.includes('persistenceClear.disabled = v.persistence.effective === 0;') &&
    captureDraw.includes("persistenceClear.dataset.persistenceClear = '';") &&
    captureDraw.includes("t('capturePanel.persistenceClear')") &&
    captureDraw.includes('this.cb.onClearPersistence()') &&
    panel.includes("onClearPersistence(): void;") &&
    app.includes("onClearPersistence: () => this.clearPersistence('clear'),") &&
    !clearBody.includes('this.references =') && !clearBody.includes('this.cursors =') &&
    !clearBody.includes('this.storeRef'),
    `loop=${captureDraw.includes('persistenceLength.disabled = v.persistence.loop;')}`);
}

{
  const gestureBody = methodBody(app, 'private beginViewportGesture(): void {');
  const explicitBody = methodBody(app, 'private noteExplicitViewport(): void {');
  const fitBody = methodBody(app, 'private fitViewport(): void {');
  const keySource = read('src/ui/persistenceTrail.ts');
  const surfacesSource = read('src/ui/persistenceSurfaces.ts');
  check('an explicit viewport gesture clears the trail, while a following live window does not',
    gestureBody.includes("this.clearPersistence('display-change');") &&
    explicitBody.includes('this.beginViewportGesture();') &&
    fitBody.includes('this.beginViewportGesture();') &&
    count(app, "clearPersistence('display-change')") === 1 &&
    !frameBody.includes('clearPersistence') && !frameBody.includes('beginViewportGesture') &&
    keySource.includes("numberText('viewportSpan', input.viewportSpan)") &&
    !keySource.includes('viewportStart') && !keySource.includes('viewportEnd') &&
    surfacesSource.includes(
      'viewportSpan: finite(input.viewportEnd) - finite(input.viewportStart),'),
    `gesture=${gestureBody.includes("clearPersistence('display-change')")}, ` +
    `frame=${frameBody.includes('clearPersistence')}, ` +
    `spanKey=${keySource.includes('viewportSpan')}`);
  const withoutClear = app.replace('    this.clearPersistence(\'display-change\');\n', '');
  const mutatedGesture = methodBody(withoutClear, 'private beginViewportGesture(): void {');
  const absoluteKey = keySource.replace(
    "numberText('viewportSpan', input.viewportSpan),",
    "numberText('viewportStart', input.viewportSpan),");
  check('control: dropping the gesture clear or pinning an absolute window fails the same predicates',
    mutatedGesture !== gestureBody &&
    !mutatedGesture.includes("clearPersistence('display-change')") &&
    absoluteKey !== keySource && absoluteKey.includes('viewportStart'),
    `mutated=${mutatedGesture !== gestureBody}, absolute=${absoluteKey !== keySource}`);
}

{
  const doc = installFakeDom();
  const capture = doc.createElement('div');
  const cursors = doc.createElement('div');
  doc.body.append(capture, cursors);
  const emptyMeasurements: MeasurementSectionView = {
    sources: [],
    filter: null,
    range: { kind: 'viewport', a: null, b: null },
    cursors: [],
    rows: [],
    allRows: [],
    rowCount: 0,
    undoCount: null,
    addStart: null,
    window: null,
    unavailable: null,
    capture: null,
    statsSkipped: 0,
    statsLoopUnavailable: false,
  };
  const picks: unknown[] = [];
  let clears = 0;
  const view = (persistence: PersistencePanelView): CapturePanelView => ({
    settings: defaultCaptureSettings(),
    channels: [],
    widthOptions: [16],
    buses: [],
    analogGroups: 0,
    deviceName: 'fixture',
    running: false,
    stopping: false,
    repeatPending: false,
    captureState: 'ready',
    result: null,
    progress: null,
    maxSamplerateHz: { 16: 200e6 },
    triggerState: 'off',
    cursors: [],
    cursorDistances: [],
    cursorEdges: [],
    cursorEdgeChannels: [],
    triggerViewLost: false,
    triggerViewPending: false,
    triggerLocked: false,
    triggerRetuneRejected: false,
    triggerAnalogRolling: false,
    triggerArmed: false,
    triggerAutoDisarmed: false,
    settingsArmed: false,
    activeTriggerPreSamples: undefined,
    measurement: emptyMeasurements,
    persistence,
  });
  const instance = new CapturePanel({
    capture: capture as unknown as HTMLElement,
    cursors: cursors as unknown as HTMLElement,
  }, {
    onPickPersistence: (raw: unknown) => picks.push(raw),
    onClearPersistence: () => { clears += 1; },
  } as unknown as CapturePanelCallbacks);
  const render = (persistence: PersistencePanelView): void => instance.render(view(persistence));
  const triggerOf = (): FakeElement | null =>
    cursors.querySelector('[data-select-key="measure.persistence"]');
  const clearOf = (): FakeElement | null => cursors.querySelector('[data-persistence-clear]');
  const noteOf = (): FakeElement | null => cursors.querySelector('[data-persistence-note]');
  const fieldOf = (): FakeElement | null => triggerOf()?.parentElement ?? null;
  const items = (): string[] =>
    (fieldOf()?.querySelectorAll('.select-item') ?? [])
      .map((item) => item.textContent ?? '');

  render({ frames: 8, effective: 8, loop: false, clear: null });
  const enabled = triggerOf();
  const labels = items();
  check('the rendered control offers exactly Off, 8, 16 and 32 and shows the stored length',
    enabled !== null && !enabled.disabled && labels.length === 4 &&
    labels[0] === 'Off' && labels[1] === '✓8 waves' && labels[2] === '16 waves' &&
    labels[3] === '32 waves' &&
    (enabled.querySelector('.select-value')?.textContent ?? '') === '8 waves' &&
    clearOf() !== null && !clearOf()!.disabled && noteOf() !== null &&
    noteOf()!.hidden === true,
    `labels=${JSON.stringify(labels)}, ` +
    `value=${enabled?.querySelector('.select-value')?.textContent}`);

  render({ frames: 8, effective: 8, loop: false, clear: 'display-change' });
  check('a clear states its reason instead of leaving history unexplained',
    (noteOf()?.textContent ?? '') ===
      'History cleared: the view or calibration changed.' &&
    noteOf()!.hidden === false,
    `note=${noteOf()?.textContent}`);

  render({ frames: 8, effective: 0, loop: true, clear: 'display-change' });
  check('Loop disables the control and explains why, keeping the stored choice visible',
    triggerOf() !== null && triggerOf()!.disabled &&
    (noteOf()?.textContent ?? '').includes('Loop has no finite acquisition wave') &&
    clearOf() !== null && clearOf()!.disabled &&
    persistenceNoteText({ frames: 8, effective: 0, loop: true, clear: null })
      .includes('Loop has no finite acquisition wave'),
    `disabled=${triggerOf()?.disabled}, note=${noteOf()?.textContent}`);

  render({ frames: 0, effective: 0, loop: false, clear: null });
  check('Off leaves no note and disables both the length control and Clear',
    triggerOf() !== null && !triggerOf()!.disabled && clearOf() !== null &&
    clearOf()!.disabled && noteOf()!.hidden === true &&
    (triggerOf()!.querySelector('.select-value')?.textContent ?? '') === 'Off',
    `clear=${clearOf()?.disabled}, note=${noteOf()?.hidden}`);

  render({ frames: 8, effective: 8, loop: false, clear: null });
  clearOf()?.click();
  check('pressing Clear reaches the host exactly once',
    clears === 1, `clears=${clears}`);

  const third = fieldOf()?.querySelectorAll('.select-item')[2];
  third?.click();
  check('picking a length reports the chosen frame count through the host',
    picks.length === 1 && picks[0] === 16,
    `picks=${JSON.stringify(picks)}`);

  check('the panel text composes from the catalogs, not from the view',
    persistenceLengthLabel(0) === 'Off' && persistenceLengthLabel(32) === '32 waves' &&
    persistenceNoteText({ frames: 16, effective: 16, loop: false, clear: 'clear' }) ===
      'History cleared: cleared by hand.' &&
    persistenceNoteText({ frames: 16, effective: 16, loop: false, clear: null }) === '',
    `label=${persistenceLengthLabel(32)}, ` +
    `note=${persistenceNoteText({ frames: 16, effective: 16, loop: false, clear: 'clear' })}`);
}

{
  const keyNames = [
    'capturePanel.persistence',
    'capturePanel.persistenceOff',
    'capturePanel.persistenceWaves',
    'capturePanel.persistenceClear',
    'capturePanel.persistenceLoopOff',
    'capturePanel.persistenceCleared',
    'capturePanel.persistenceReasonCaptureSession',
    'capturePanel.persistenceReasonCaptureReplacement',
    'capturePanel.persistenceReasonClear',
    'capturePanel.persistenceReasonBandRemoved',
    'capturePanel.persistenceReasonDisplayChange',
  ];
  const files = ['en', 'zh-CN', 'fr', 'ru'].map((locale) => read(`src/ui/locales/${locale}.ts`));
  const missing = files.flatMap((text, index) =>
    keyNames.filter((key) => !text.includes(`'${key}':`)).map((key) => `${index}:${key}`));
  const placeholders = files.filter((text) => {
    const waves = text.slice(text.indexOf("'capturePanel.persistenceWaves':"));
    const cleared = text.slice(text.indexOf("'capturePanel.persistenceCleared':"));
    return !waves.slice(0, 120).includes('{count}') || !cleared.slice(0, 120).includes('{reason}');
  });
  check('all four catalogs carry the eleven keys with their placeholders',
    missing.length === 0 && placeholders.length === 0 && files.length === 4,
    `missing=${JSON.stringify(missing)}, placeholders=${placeholders.length}`);
}

{
  const rules = ['.measure-persistence {', '.measure-persistence > .field {',
    '.analyzer-act.measure-persistence-clear {'];
  const present = rules.filter((rule) => sheet.includes(rule));
  const block = slice(sheet, '.measure-persistence {', '.analyzer-act.measure-add {');
  check('the persistence row styles use the shared sheet and tokens only',
    present.length === 3 && block.includes('display: flex;') &&
    block.includes('flex-wrap: wrap;') && !/#[0-9a-fA-F]{3,8}/.test(block) &&
    !block.includes('!important') && !block.includes('@media'),
    `present=${JSON.stringify(present)}, hex=${/#[0-9a-fA-F]{3,8}/.test(block)}`);
}

{
  const trail = design.slice(
    design.indexOf('The persistence trail is display, never data'),
    design.indexOf('### 5.3'));
  const host = design.slice(design.indexOf('The trail length is global'), design.indexOf('### 5.3'));
  const height = design.slice(
    design.indexOf("A band's trail surface is the band's box"),
    design.indexOf('\n## 6. Time, plot, overview and measurements'));
  const measurement = design.slice(design.indexOf('**Persistence'), design.indexOf('### 6.4'));
  check('DESIGN.md records the exponential trail, the global control host, Stop, Loop and display-only semantics',
    trail.includes('exponential') && trail.includes('1 - 1/N') &&
    trail.includes('Never a ring') && trail.includes('keep out of the surface') &&
    host.includes('global') && host.includes('Automatic measurements') &&
    height.includes('reallocates') && height.includes('releases its surface') &&
    measurement.includes('Stop') && measurement.includes('Loop') &&
    measurement.includes('display-only'),
    `trail=${trail.length}, host=${host.length}, height=${height.length}, ` +
    `measurement=${measurement.length}`);
}

{
  check('the debug surface exposes the commit, generation and surface dimensions',
    app.includes('persistence: () => ({') &&
    app.includes('surfaces: this.persistenceTrail.views(),') &&
    app.includes('signature: this.persistenceSignatureValue(),') &&
    app.includes('lastWaveKey: this.persistenceLastWaveKey,') &&
    app.includes('pendingWaveKey: this.persistencePendingKey,') &&
    app.includes('setPersistence: (raw: unknown) => this.setPersistence(raw),') &&
    app.includes("clearPersistence: () => this.clearPersistence('clear'),") &&
    slice(app, 'persistence: () => ({', 'setPersistence: (raw: unknown)')
      .includes('clear: this.persistenceClearReason,'),
    `debug=${app.includes('surfaces: this.persistenceTrail.views(),')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
