// SPDX-License-Identifier: GPL-3.0-or-later

import {
  MERGED_ANALOG_BAND_ID, analogBandSignature, analogBands, analogLayoutOf, analogRowProjection,
  focusedAnalogSource, pruneAnalogState, resolveAnalogFocus, toggleAnalogVisibility,
  toggleSourceVisibility,
  visibleAnalogSources,
  type AnalogBand, type AnalogBandSource, type AnalogLayout, type PrunedAnalogState,
} from '../analogBands.js';

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

const COLORS = ['#CD427E', '#00994D', '#2683D9', '#DB4C39'];

function source(group: number, overrides: Partial<AnalogBandSource> = {}): AnalogBandSource {
  return {
    busId: `bus-${group}`,
    group,
    start: group * 8,
    name: `A${group}`,
    color: COLORS[group % COLORS.length]!,
    heightCss: 120 + group * 10,
    gain: 1,
    signature: `sig-${group}`,
    ...overrides,
  };
}

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

function bandProjectionIsAuthoritative(text: string): boolean {
  const relayout = methodBody(text, 'private relayout(): void');
  const specs = methodBody(text, 'private analogRowSpecs(): RowSpec[]');
  const bands = methodBody(
    text, 'private analogBandsFor(entries: readonly AnalogRowEntry[]): AnalogBand[]');
  const entries = methodBody(text, 'private analogRowEntries(): AnalogRowEntry[]');
  return relayout.length > 0 && specs.length > 0 && bands.length > 0 && entries.length > 0 &&
    relayout.includes('this.analogRowSpecs()') &&
    !relayout.includes('rowHeightOf(') &&
    !relayout.includes('analogRows.push(') &&
    specs.includes('this.analogBandsFor(entries)') &&
    specs.includes('analogRowProjection(bands') &&
    specs.includes('channel: row.channel') &&
    specs.includes('bus: row.bus') &&
    specs.includes('heightCss: row.heightCss') &&
    bands.includes('this.analogLayout') &&
    bands.includes('this.analogFocusId') &&
    bands.includes("return analogBands('stacked', entries.map((entry) => entry.source), null);") &&
    bands.includes('entry.source.group >= 0') &&
    bands.includes('entries.filter((entry) => entry.source.group >= 0).map((entry) => entry.source),') &&
    (entries.match(/heightCss: this\.rowHeightOf\(bus\)/g) ?? []).length === 1;
}

const A = source(0);
const B = source(1);
const C = source(2);
const THREE = [A, B, C];

const ids = (list: readonly { id: string }[]): string => list.map((entry) => entry.id).join(',');
const busIds = (list: readonly AnalogBandSource[]): string =>
  list.map((entry) => entry.busId).join(',');
const hiddenOf = (...entries: string[]): ReadonlySet<string> => new Set(entries);
const EMPTY_HIDDEN: ReadonlySet<string> = new Set<string>();

{
  const bands = analogBands('stacked', THREE, 'bus-2');
  check('stacked keeps one band per source in row order',
    bands.length === 3 && ids(bands) === 'bus-0,bus-1,bus-2',
    `ids=${ids(bands)}, count=${bands.length}`);

  const projection = THREE.map((entry) => ({
    id: entry.busId,
    sources: [entry],
    focusedId: entry.busId,
    heightCss: entry.heightCss,
  }));
  check('stacked is a 1:1 projection of the input rows',
    JSON.stringify(bands) === JSON.stringify(projection),
    `bands=${JSON.stringify(bands)}`);

  check('stacked keeps each row height, colour, name and gain untouched',
    bands.every((band, index) => {
      const entry = THREE[index]!;
      return band.sources.length === 1 && band.sources[0] === entry &&
        band.heightCss === entry.heightCss && band.sources[0]!.name === entry.name &&
        band.sources[0]!.color === entry.color && band.sources[0]!.gain === entry.gain &&
        band.sources[0]!.start === entry.start && band.sources[0]!.group === entry.group;
    }),
    bands.map((band) => `${band.id}:${band.heightCss}`).join(','));

  check('stacked focus is each band itself, whatever focused id the caller passes',
    bands.every((band) => band.focusedId === band.id) &&
    JSON.stringify(analogBands('stacked', THREE, null)) === JSON.stringify(bands) &&
    JSON.stringify(analogBands('stacked', THREE, 'bus-9')) === JSON.stringify(bands),
    `focus=${bands.map((band) => band.focusedId).join(',')}`);

  check('stacked leaves layout to the caller: no top is assigned',
    bands.every((band) => !('top' in band)),
    `tops=${bands.map((band) => String(band.top)).join(',')}`);
}

{
  const empty = analogBands('stacked', [], 'bus-0');
  const merged = analogBands('merged', [], 'bus-0');
  check('zero sources produce no band in either layout',
    empty.length === 0 && merged.length === 0,
    `stacked=${empty.length}, merged=${merged.length}`);
}

{
  const bands = analogBands('merged', THREE, 'bus-1');
  const band = bands[0];
  check('merged produces exactly one band holding every source in row order',
    bands.length === 1 && band !== undefined && busIds(band.sources) === 'bus-0,bus-1,bus-2' &&
    band.id === MERGED_ANALOG_BAND_ID,
    `count=${bands.length}, sources=${band ? busIds(band.sources) : 'none'}, id=${band?.id ?? 'none'}`);

  check('merged height is the maximum participant height',
    band !== undefined && band.heightCss === 140,
    `height=${band?.heightCss}, source heights=${THREE.map((entry) => entry.heightCss).join(',')}`);

  check('merged focus is the requested source when it participates',
    band !== undefined && band.focusedId === 'bus-1' &&
    focusedAnalogSource(band)?.busId === 'bus-1',
    `focus=${band?.focusedId}, resolved=${band ? focusedAnalogSource(band)?.busId : 'none'}`);

  check('merged maximum is not a sum or a mean of the participants',
    band !== undefined && band.heightCss !== 390 && band.heightCss !== 130,
    `height=${band?.heightCss}, sum=${THREE.reduce((sum, entry) => sum + entry.heightCss, 0)}`);
}

{
  const fallback = analogBands('merged', THREE, 'bus-9')[0]!;
  const nullish = analogBands('merged', THREE, null)[0]!;
  check('merged focus falls back to the first source when the id is absent',
    fallback.focusedId === 'bus-0' && nullish.focusedId === 'bus-0' &&
    focusedAnalogSource(fallback)?.busId === 'bus-0',
    `absent=${fallback.focusedId}, null=${nullish.focusedId}`);

  const single = analogBands('merged', [B], 'bus-7')[0]!;
  check('merged with one source keeps that source, its height and its focus',
    single.sources.length === 1 && single.focusedId === 'bus-1' && single.heightCss === 130,
    `sources=${busIds(single.sources)}, focus=${single.focusedId}, height=${single.heightCss}`);

  const custom = source(3, { heightCss: 173 });
  const reordered = analogBands('merged', [custom, A], 'bus-0')[0]!;
  check('merged keeps caller row order and takes the taller custom height',
    busIds(reordered.sources) === 'bus-3,bus-0' && reordered.heightCss === 173,
    `sources=${busIds(reordered.sources)}, height=${reordered.heightCss}`);

  const partial = analogBands('merged', [source(0, { heightCss: Number.NaN }), B], 'bus-1')[0]!;
  check('a non-finite participant height cannot poison the merged maximum',
    partial.heightCss === 130 && partial.sources.length === 2,
    `height=${partial.heightCss}, sources=${busIds(partial.sources)}`);

  const allNonFinite = analogBands('merged', [
    source(0, { heightCss: Number.NaN }),
    source(1, { heightCss: Number.POSITIVE_INFINITY }),
    source(2, { heightCss: Number.NEGATIVE_INFINITY }),
  ], null)[0]!;
  check('a merged band with no finite height falls back to a usable number',
    Number.isFinite(allNonFinite.heightCss) && allNonFinite.heightCss >= 0,
    `height=${allNonFinite.heightCss}`);

  const negative = analogBands('merged', [source(0, { heightCss: -40 }), B], null)[0]!;
  check('a finite merged height is never reported as negative',
    negative.heightCss === 130 && analogBands('merged', [source(0, { heightCss: -40 })], null)[0]!
      .heightCss === 0,
    `mixed=${negative.heightCss}`);

  const finiteFirst = analogBands('merged', [
    source(0, { heightCss: 96 }), source(1, { heightCss: Number.NaN }),
  ], null)[0]!;
  check('one finite participant supplies the merged height whatever its position',
    finiteFirst.heightCss === 96,
    `height=${finiteFirst.heightCss}`);
}

{
  const input = [A, B];
  const band = analogBands('merged', input, 'bus-0')[0]!;
  input.push(C);
  check('merged band sources are a copy, not the caller array',
    band.sources.length === 2 && busIds(band.sources) === 'bus-0,bus-1',
    `afterPush=${band.sources.length}`);

  const stackedList = [A, B];
  const stackedBands = analogBands('stacked', stackedList, null);
  stackedList.pop();
  check('stacked bands keep their own per-row source list',
    stackedBands.length === 2 && stackedBands.every((entry) => entry.sources.length === 1),
    `bands=${stackedBands.length}`);
}

{
  const table: [string, readonly AnalogBandSource[], string | null | undefined, string | null][] = [
    ['present id', THREE, 'bus-2', 'bus-2'],
    ['absent id', THREE, 'bus-9', 'bus-0'],
    ['null id', THREE, null, 'bus-0'],
    ['undefined id', THREE, undefined, 'bus-0'],
    ['empty list', [], 'bus-0', null],
    ['empty list and null', [], null, null],
  ];
  const wrong = table.filter(([, sources, focused, expected]) =>
    resolveAnalogFocus(sources, focused) !== expected);
  check('focus resolution always names a participating source',
    wrong.length === 0,
    wrong.map(([label]) => label).join(',') || `rows=${table.length}`);
}

{
  const band: AnalogBand = {
    id: 'x', sources: [A, B], focusedId: 'bus-1', heightCss: 130,
  };
  const stale: AnalogBand = { id: 'y', sources: [A, B], focusedId: 'bus-8', heightCss: 130 };
  const empty: AnalogBand = { id: 'z', sources: [], focusedId: 'bus-0', heightCss: 0 };
  check('focusedAnalogSource resolves the focused participant and falls back to the first',
    focusedAnalogSource(band)?.busId === 'bus-1' && focusedAnalogSource(stale)?.busId === 'bus-0' &&
    focusedAnalogSource(empty) === null,
    `band=${focusedAnalogSource(band)?.busId}, stale=${focusedAnalogSource(stale)?.busId}`);

  const shared = analogBands('merged', THREE, 'bus-2')[0]!;
  check('merged focus always names a participant, so a ruler has one owner',
    focusedAnalogSource(shared) !== null &&
    shared.sources.some((entry) => entry.busId === shared.focusedId),
    `focus=${shared.focusedId}`);
}

{
  const visible = visibleAnalogSources(THREE, hiddenOf('bus-1'));
  check('visibility filters in row order and keeps the rest untouched',
    busIds(visible) === 'bus-0,bus-2',
    `visible=${busIds(visible)}`);

  const unknown = visibleAnalogSources(THREE, hiddenOf('bus-9'));
  check('hiding an unknown bus changes nothing',
    busIds(unknown) === 'bus-0,bus-1,bus-2', `visible=${busIds(unknown)}`);

  const none = visibleAnalogSources(THREE, hiddenOf('bus-0', 'bus-1', 'bus-2'));
  const band = analogBands('merged', THREE, 'bus-0')[0]!;
  check('all hidden leaves the band and its height intact with no visible source',
    none.length === 0 && band.heightCss === 140 && band.sources.length === 3,
    `visible=${none.length}, height=${band.heightCss}, bandSources=${band.sources.length}`);
}

{
  const before = hiddenOf('bus-0');
  const added = toggleAnalogVisibility(before, 'bus-1');
  const removed = toggleAnalogVisibility(before, 'bus-0');
  check('visibility toggle adds a missing id and removes a present one',
    [...added].sort().join(',') === 'bus-0,bus-1' && removed.size === 0,
    `added=${[...added].join(',')}, removed=${removed.size}`);

  check('visibility toggle never mutates the set it was given',
    before.size === 1 && before.has('bus-0') && added !== before && removed !== before,
    `before=${[...before].join(',')}`);

  const twice = toggleAnalogVisibility(toggleAnalogVisibility(before, 'bus-1'), 'bus-1');
  check('toggling the same id twice restores the previous set',
    [...twice].join(',') === [...before].join(','),
    `twice=${[...twice].join(',')}`);
}

{
  const focusedFirst = toggleSourceVisibility(THREE, { focusedId: 'bus-0', hidden: EMPTY_HIDDEN }, 'bus-0');
  check('hiding the focused source retargets focus to the next visible row',
    focusedFirst.focusedId === 'bus-1' && [...focusedFirst.hidden].join(',') === 'bus-0',
    `focus=${focusedFirst.focusedId}, hidden=${[...focusedFirst.hidden].join(',')}`);

  const focusedMiddle = toggleSourceVisibility(
    THREE, { focusedId: 'bus-1', hidden: EMPTY_HIDDEN }, 'bus-1');
  check('retargeted focus is the first remaining visible source in row order',
    focusedMiddle.focusedId === 'bus-0',
    `focus=${focusedMiddle.focusedId}`);

  const lastVisible = toggleSourceVisibility(
    THREE, { focusedId: 'bus-2', hidden: hiddenOf('bus-0', 'bus-1') }, 'bus-2');
  const band = analogBands('merged', THREE, lastVisible.focusedId)[0]!;
  check('hiding the last visible source keeps focus and leaves zero visible sources',
    lastVisible.focusedId === 'bus-2' &&
    visibleAnalogSources(THREE, lastVisible.hidden).length === 0 &&
    band.heightCss === 140 && band.sources.length === 3,
    `focus=${lastVisible.focusedId}, visible=${visibleAnalogSources(THREE, lastVisible.hidden).length}, height=${band.heightCss}`);

  const unfocused = toggleSourceVisibility(
    THREE, { focusedId: 'bus-0', hidden: EMPTY_HIDDEN }, 'bus-2');
  check('hiding an unfocused source leaves focus alone',
    unfocused.focusedId === 'bus-0', `focus=${unfocused.focusedId}`);

  const shown = toggleSourceVisibility(
    THREE, { focusedId: 'bus-2', hidden: hiddenOf('bus-0') }, 'bus-0');
  const shownOwn = toggleSourceVisibility(
    THREE, { focusedId: 'bus-2', hidden: hiddenOf('bus-0', 'bus-1') }, 'bus-1');
  check('showing a source never steals focus',
    shown.focusedId === 'bus-2' && shownOwn.focusedId === 'bus-2' &&
    shownOwn.hidden.size === 1,
    `shown=${shown.focusedId}, shownFocused=${shownOwn.focusedId}`);

  const nullFocus = toggleSourceVisibility(THREE, { focusedId: null, hidden: EMPTY_HIDDEN }, 'bus-0');
  check('hiding with no focus keeps the empty focus', nullFocus.focusedId === null,
    `focus=${nullFocus.focusedId}`);
}

{
  const valid = hiddenOf('bus-0', 'bus-2');
  const kept = pruneAnalogState({ focusedId: 'bus-2', hidden: hiddenOf('bus-2', 'bus-9') }, valid);
  check('pruning keeps a valid focus and drops hidden buses that no longer exist',
    kept.focusedId === 'bus-2' && [...kept.hidden].join(',') === 'bus-2',
    `focus=${kept.focusedId}, hidden=${[...kept.hidden].join(',')}`);

  const dropped = pruneAnalogState({ focusedId: 'bus-9', hidden: hiddenOf('bus-9') }, valid);
  check('pruning clears a focus whose bus was removed and keeps no stale hidden id',
    dropped.focusedId === null && dropped.hidden.size === 0,
    `focus=${dropped.focusedId}, hidden=${[...dropped.hidden].join(',')}`);

  const emptyValid = pruneAnalogState(
    { focusedId: 'bus-0', hidden: hiddenOf('bus-0', 'bus-1') }, new Set<string>());
  check('a capture with no analog source prunes focus and visibility to empty',
    emptyValid.focusedId === null && emptyValid.hidden.size === 0,
    `focus=${emptyValid.focusedId}, hidden=${emptyValid.hidden.size}`);

  check('pruning returns only focus and visibility, never source configuration',
    JSON.stringify(Object.keys(kept).sort()) === JSON.stringify(['focusedId', 'hidden']),
    `keys=${Object.keys(kept).join(',')}`);

  const unrelated = pruneAnalogState(
    { focusedId: 'bus-1', hidden: hiddenOf('bus-1') }, valid);
  check('pruning keeps hidden ids in their original order',
    [...pruneAnalogState({ focusedId: null, hidden: hiddenOf('bus-2', 'bus-0') }, valid).hidden]
      .join(',') === 'bus-2,bus-0' && unrelated.focusedId === null,
    `order=${[...pruneAnalogState({ focusedId: null, hidden: hiddenOf('bus-2', 'bus-0') }, valid).hidden].join(',')}`);
}

function writableHidden(state: PrunedAnalogState): Set<string> {
  // @ts-expect-error - an exposed analog hidden set is read-only.
  return state.hidden;
}

{
  const kept = pruneAnalogState({ focusedId: 'bus-1', hidden: hiddenOf('bus-1') }, hiddenOf('bus-1'));
  const widened = writableHidden(kept);
  const readonlyToggle: ReadonlySet<string> = toggleAnalogVisibility(EMPTY_HIDDEN, 'bus-1');
  check('exposed hidden sets are read-only to consumers',
    widened === kept.hidden && readonlyToggle.size === 1,
    `same=${widened === kept.hidden}, toggle=${[...readonlyToggle].join(',')}`);
}

{
  const table: [unknown, AnalogLayout][] = [
    ['merged', 'merged'],
    ['stacked', 'stacked'],
    [undefined, 'stacked'],
    [null, 'stacked'],
    ['', 'stacked'],
    ['Merged', 'stacked'],
    [' merged', 'stacked'],
    ['overlay', 'stacked'],
    [1, 'stacked'],
    [true, 'stacked'],
    [{ layout: 'merged' }, 'stacked'],
    [['merged'], 'stacked'],
  ];
  const wrong = table.filter(([raw, expected]) => analogLayoutOf(raw) !== expected);
  check('a persisted mode selects merged only for the exact guarded value',
    wrong.length === 0,
    wrong.map(([raw, expected]) => `${JSON.stringify(raw)}→${analogLayoutOf(raw)}!=${expected}`).join(',') ||
    `rows=${table.length}`);
}

{
  const stacked = analogBands('stacked', THREE, null);
  const merged = analogBands('merged', THREE, 'bus-0');
  const sig = (bands: readonly AnalogBand[], layout: AnalogLayout, hidden: ReadonlySet<string>) =>
    analogBandSignature(bands, layout, hidden);

  check('identical inputs produce an identical signature',
    sig(merged, 'merged', EMPTY_HIDDEN) === sig(merged, 'merged', EMPTY_HIDDEN) &&
    sig(stacked, 'stacked', EMPTY_HIDDEN) === sig(stacked, 'stacked', EMPTY_HIDDEN),
    sig(merged, 'merged', EMPTY_HIDDEN));

  check('layout alone changes the signature',
    sig(merged, 'merged', EMPTY_HIDDEN) !== sig(merged, 'stacked', EMPTY_HIDDEN) &&
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(stacked, 'merged', EMPTY_HIDDEN),
    `${sig(merged, 'merged', EMPTY_HIDDEN)} vs ${sig(merged, 'stacked', EMPTY_HIDDEN)}`);

  const focusA = analogBands('merged', THREE, 'bus-0');
  const focusB = analogBands('merged', THREE, 'bus-2');
  check('focus changes the merged signature',
    sig(focusA, 'merged', EMPTY_HIDDEN) !== sig(focusB, 'merged', EMPTY_HIDDEN),
    `${sig(focusA, 'merged', EMPTY_HIDDEN)} vs ${sig(focusB, 'merged', EMPTY_HIDDEN)}`);

  check('visibility changes the merged signature, independent of insertion order',
    sig(merged, 'merged', EMPTY_HIDDEN) !== sig(merged, 'merged', hiddenOf('bus-1')) &&
    sig(merged, 'merged', hiddenOf('bus-2', 'bus-0')) ===
      sig(merged, 'merged', hiddenOf('bus-0', 'bus-2')),
    `${sig(merged, 'merged', hiddenOf('bus-2', 'bus-0'))}`);

  check('stacked visibility is overlay-only and leaves the signature unchanged',
    sig(stacked, 'stacked', EMPTY_HIDDEN) === sig(stacked, 'stacked', hiddenOf('bus-1')),
    `${sig(stacked, 'stacked', hiddenOf('bus-1'))}`);

  const taller = analogBands('stacked', [A, source(1, { heightCss: 200 }), C], null);
  check('a source height change changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(taller, 'stacked', EMPTY_HIDDEN),
    `${sig(taller, 'stacked', EMPTY_HIDDEN)}`);

  const renamed = analogBands('stacked', [A, source(1, { name: 'Shunt' }), C], null);
  check('a source name change changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(renamed, 'stacked', EMPTY_HIDDEN),
    `${sig(renamed, 'stacked', EMPTY_HIDDEN)}`);

  const recolored = analogBands('stacked', [A, source(1, { color: '#123456' }), C], null);
  check('a source colour change changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(recolored, 'stacked', EMPTY_HIDDEN),
    `${sig(recolored, 'stacked', EMPTY_HIDDEN)}`);

  const gained = analogBands('stacked', [A, source(1, { gain: 10 }), C], null);
  check('a source gain change changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(gained, 'stacked', EMPTY_HIDDEN),
    `${sig(gained, 'stacked', EMPTY_HIDDEN)}`);

  const moved = analogBands('stacked', [A, source(1, { start: 16, group: 2 }), C], null);
  check('a source bank change changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(moved, 'stacked', EMPTY_HIDDEN),
    `${sig(moved, 'stacked', EMPTY_HIDDEN)}`);

  const resigned = analogBands('stacked', [A, source(1, { signature: 'sig-1-rotated' }), C], null);
  check('a source display signature change changes the band signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(resigned, 'stacked', EMPTY_HIDDEN),
    `${sig(resigned, 'stacked', EMPTY_HIDDEN)}`);

  const swapped = analogBands('stacked', [B, A, C], null);
  check('row order changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(swapped, 'stacked', EMPTY_HIDDEN),
    `${sig(swapped, 'stacked', EMPTY_HIDDEN)}`);

  const mergedSwapped = analogBands('merged', [B, A, C], 'bus-0');
  check('merged participant order changes the signature',
    sig(merged, 'merged', EMPTY_HIDDEN) !== sig(mergedSwapped, 'merged', EMPTY_HIDDEN),
    `${sig(mergedSwapped, 'merged', EMPTY_HIDDEN)}`);

  const placed: AnalogBand[] = [{ ...stacked[0]!, top: 48 }, ...stacked.slice(1)];
  check('a resolved band top changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(placed, 'stacked', EMPTY_HIDDEN),
    `${sig(placed, 'stacked', EMPTY_HIDDEN)}`);

  const removed = analogBands('stacked', [A, B], null);
  check('removing a source changes the signature',
    sig(stacked, 'stacked', EMPTY_HIDDEN) !== sig(removed, 'stacked', EMPTY_HIDDEN),
    `${sig(removed, 'stacked', EMPTY_HIDDEN)}`);
}

{
  const one = analogBands('merged', [A], 'bus-0');
  const many = analogBands('merged', THREE, 'bus-0');
  check('every produced band has a unique id and a focus inside its own sources',
    [one, many, analogBands('stacked', THREE, null)].every((bands) => {
      const bandIds = new Set(bands.map((band) => band.id));
      return bandIds.size === bands.length && bands.every((band) =>
        band.sources.some((entry) => entry.busId === band.focusedId));
    }),
    `${one.length}/${many.length}/${analogBands('stacked', THREE, null).length} bands`);

  check('merged never claims more height than its tallest participant and stacked sums them',
    many[0]!.heightCss === Math.max(...THREE.map((entry) => entry.heightCss)) &&
    analogBands('stacked', THREE, null).reduce((sum, band) => sum + band.heightCss, 0) ===
      THREE.reduce((sum, entry) => sum + entry.heightCss, 0),
    `merged=${many[0]!.heightCss}, stacked=${analogBands('stacked', THREE, null).reduce((sum, band) => sum + band.heightCss, 0)}`);
}

{
  const table = new Map<string, { channel: number; bus: number }>([
    [A.busId, { channel: 8, bus: 0 }],
    [B.busId, { channel: 16, bus: 1 }],
    [C.busId, { channel: 24, bus: 2 }],
  ]);
  const rowOf = (busId: string): { channel: number; bus: number } | null =>
    table.get(busId) ?? null;
  const stacked = analogRowProjection(analogBands('stacked', THREE, null), rowOf);
  const merged = analogRowProjection(analogBands('merged', THREE, 'bus-1'), rowOf);
  const fallback = analogRowProjection(analogBands('merged', THREE, 'bus-9'), rowOf);
  const empty = analogRowProjection(analogBands('merged', [], 'bus-0'), rowOf);
  const unknown = analogRowProjection(analogBands('merged', THREE, 'bus-0'), () => null);
  check('stacked projects one row per source while merged projects one row at the tallest height for the focused channel and bus',
    stacked.map((row) => `${row.channel}:${row.bus}:${row.heightCss}`).join(',') ===
      '8:0:120,16:1:130,24:2:140' &&
    merged.length === 1 && merged[0]!.channel === 16 && merged[0]!.bus === 1 &&
    merged[0]!.heightCss === 140 && fallback.length === 1 && fallback[0]!.channel === 8 &&
    empty.length === 0 && unknown.length === 0,
    `stacked=${stacked.map((row) => `${row.channel}:${row.bus}:${row.heightCss}`).join(',')}, ` +
    `merged=${merged.map((row) => `${row.channel}:${row.bus}:${row.heightCss}`).join(',')}, ` +
    `fallback=${fallback[0]?.channel}, empty=${empty.length}, unknown=${unknown.length}`);

  const taller = analogRowProjection(
    analogBands('merged', [A, source(1, { heightCss: 480 }), C], 'bus-1'), rowOf);
  const focusedOnly = analogRowProjection(analogBands('merged', [A], 'bus-0'), rowOf);
  const wrongFocus = analogRowProjection(analogBands('merged', THREE, 'bus-0'), rowOf);
  check('the merged projection control detects a focused-height leak or a lost focus mapping',
    merged[0]!.heightCss === 140 && THREE[1]!.heightCss === 130 &&
    taller[0]!.heightCss === 480 && focusedOnly[0]!.heightCss === 120 &&
    wrongFocus[0]!.channel === 8 && merged[0]!.channel !== wrongFocus[0]!.channel,
    `merged=${merged[0]!.heightCss}, focusedHeight=${THREE[1]!.heightCss}, ` +
    `taller=${taller[0]!.heightCss}, single=${focusedOnly[0]!.heightCss}, ` +
    `wrongFocus=${wrongFocus[0]!.channel}`);

  const rowInputs = (rows: readonly { channel: number; bus: number; heightCss: number }[]): string =>
    JSON.stringify(rows.map((row) => [row.channel, row.bus, row.heightCss]));
  check('the row fingerprint inputs change for layout and focus and never for a repeated stacked read',
    rowInputs(stacked) !== rowInputs(merged) && rowInputs(merged) !== rowInputs(wrongFocus) &&
    rowInputs(stacked) === rowInputs(analogRowProjection(analogBands('stacked', THREE, null), rowOf)),
    `stacked=${rowInputs(stacked)}, merged=${rowInputs(merged)}, wrongFocus=${rowInputs(wrongFocus)}`);

  const valid = new Set(THREE.map((entry) => entry.busId));
  const afterRemoval = pruneAnalogState(
    { focusedId: 'bus-1', hidden: new Set<string>() }, new Set(['bus-0', 'bus-2']));
  const afterWidth = pruneAnalogState(
    { focusedId: 'bus-2', hidden: new Set<string>() }, new Set(['bus-0']));
  const kept = pruneAnalogState({ focusedId: 'bus-1', hidden: new Set<string>() }, valid);
  check('a removed or out-of-width focus is pruned to null while a valid one survives',
    kept.focusedId === 'bus-1' && afterRemoval.focusedId === null &&
    afterWidth.focusedId === null,
    `kept=${kept.focusedId}, removed=${afterRemoval.focusedId}, width=${afterWidth.focusedId}`);
}

{
  const rows = [A, B, C];
  const projected = analogBands('stacked', rows, null).map((band) => `${band.id}:${band.heightCss}`);
  const expected = rows.map((entry) => `${entry.busId}:${entry.heightCss}`);
  check('stacked rows project to the caller order and heights unchanged',
    projected.join(',') === expected.join(','),
    `projected=${projected.join(',')}`);

  const reordered = analogBands('stacked', [B, A, C], null)
    .map((band) => `${band.id}:${band.heightCss}`);
  const resized = analogBands('stacked', [A, source(1, { heightCss: 999 }), C], null)
    .map((band) => `${band.id}:${band.heightCss}`);
  check('the stacked projection control detects a reordered or resized row',
    reordered.join(',') !== expected.join(',') && resized.join(',') !== expected.join(','),
    `reordered=${reordered.join(',')}, resized=${resized.join(',')}`);
}

{
  const sourceText = fs.readFileSync('src/ui/analogBands.ts', 'utf8');
  const lines = sourceText.split('\n');
  const commentLines = lines.filter((line) => line.trim().startsWith('//') ||
    line.trim().startsWith('/*') || line.trim().startsWith('*'));
  check('the model carries no comment beyond its licence header',
    commentLines.length === 1 && commentLines[0]!.includes('SPDX-License-Identifier'),
    `comments=${JSON.stringify(commentLines)}`);

  const forbidden = ['document', 'window', 'addEventListener', 'requestAnimationFrame',
    'innerHTML', 'localStorage', 'SampleStore', 'import '];
  const hits = forbidden.filter((token) => sourceText.includes(token));
  check('the model touches no DOM, storage, store, or another module',
    hits.length === 0, `hits=${JSON.stringify(hits)}`);

  check('the merged id is one stable exported constant',
    MERGED_ANALOG_BAND_ID === 'analog-merged' &&
    sourceText.split("'analog-merged'").length - 1 === 1,
    `id=${MERGED_ANALOG_BAND_ID}, literals=${sourceText.split("'analog-merged'").length - 1}`);
}

{
  const appSource = fs.readFileSync('src/ui/app.ts', 'utf8');
  check('relayout takes its analog rows from the selected band model',
    bandProjectionIsAuthoritative(appSource),
    `projection=${bandProjectionIsAuthoritative(appSource)}`);

  const heightControl = appSource.replace('heightCss: row.heightCss',
    'heightCss: entries[0]!.source.heightCss');
  const relayoutControl = appSource.replace(
    'const analogRows: RowSpec[] = this.analogRowSpecs();',
    'const analogRows: RowSpec[] = [];');
  const layoutControl = appSource.replace(
    "return analogBands('stacked', entries.map((entry) => entry.source), null);",
    'return [];');
  const focusControl = appSource.replace('\n      this.analogFocusId);', '\n      null);');
  const groupControl = appSource.replace(
    'entries.filter((entry) => entry.source.group >= 0).map((entry) => entry.source),',
    'entries.map((entry) => entry.source),');
  const mappingControl = appSource.replace('bus: row.bus', 'bus: row.channel');
  const projectionControl = appSource.replace('analogRowProjection(bands',
    'analogRowProjection([] as readonly AnalogBand[]');
  check('the projection contract rejects a resized, skipped, layout-blind, focus-blind, group-blind or mis-mapped row',
    !bandProjectionIsAuthoritative(heightControl) &&
    !bandProjectionIsAuthoritative(relayoutControl) &&
    !bandProjectionIsAuthoritative(layoutControl) &&
    !bandProjectionIsAuthoritative(focusControl) &&
    !bandProjectionIsAuthoritative(groupControl) &&
    !bandProjectionIsAuthoritative(mappingControl) &&
    !bandProjectionIsAuthoritative(projectionControl),
    `height=${bandProjectionIsAuthoritative(heightControl)}, relayout=${bandProjectionIsAuthoritative(relayoutControl)}, layout=${bandProjectionIsAuthoritative(layoutControl)}, focus=${bandProjectionIsAuthoritative(focusControl)}, group=${bandProjectionIsAuthoritative(groupControl)}, mapping=${bandProjectionIsAuthoritative(mappingControl)}, projection=${bandProjectionIsAuthoritative(projectionControl)}`);

  const entryBody = methodBody(appSource, 'private analogRowEntries(): AnalogRowEntry[]');
  check('one source collection feeds the bands, the pruning and the focus setter',
    (appSource.match(/private analogRowEntries\(\): AnalogRowEntry\[\]/g) ?? []).length === 1 &&
    (appSource.match(/this\.analogRowEntries\(\)/g) ?? []).length === 3 &&
    (appSource.match(/this\.analogRowSpecs\(\)/g) ?? []).length === 1 &&
    entryBody.includes('signature: JSON.stringify(busFrameSignatureParts(bus))'),
    `definitions=${(appSource.match(/private analogRowEntries\(\): AnalogRowEntry\[\]/g) ?? []).length}, uses=${(appSource.match(/this\.analogRowEntries\(\)/g) ?? []).length}, relayouts=${(appSource.match(/this\.analogRowSpecs\(\)/g) ?? []).length}`);

  const relayoutBody = methodBody(appSource, 'private relayout(): void');
  const prefixAt = relayoutBody.indexOf('const rows: RowSpec[] = [...analogRows];');
  const laneAt = relayoutBody.indexOf("kind: 'lane'");
  const channelAt = relayoutBody.indexOf('rows.push(this.captured(c.index)');
  check('digital, decoder and blank rows keep their order below the analog prefix',
    prefixAt >= 0 && prefixAt < laneAt && laneAt < channelAt &&
    !relayoutBody.includes("kind: 'analog', channel"),
    `prefix=${prefixAt}, lane=${laneAt}, channel=${channelAt}`);

  const frameBody = methodBody(
    appSource, 'private busSignature(viewStart: number, viewEnd: number): number');
  check('the bus frame field list has one owner shared by the row and frame signatures',
    (appSource.match(/busFrameSignatureParts\(bus\)/g) ?? []).length === 2 &&
    (appSource.match(/bus\.builder\?\.pyramid\.doneUpTo/g) ?? []).length === 1 &&
    frameBody.includes('busFrameSignatureParts(bus)'),
    `uses=${(appSource.match(/busFrameSignatureParts\(bus\)/g) ?? []).length}, frame=${frameBody.includes('busFrameSignatureParts(bus)')}`);
}

console.log(results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`).join('\n'));
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
nodeProcess.exit(failed === 0 ? 0 : 1);
