// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Guards around the one capture the app holds: the "unsaved capture" rule and the
 * drag-and-drop overlay counter. DOM-free so the self-tests can pin them.
 *
 * Unsaved: a capture is unsaved when its data came from the device (not from an opened
 * file), it holds samples, and it is not exactly the store/length a successful save (in
 * any format: .lwcap, .sr, .vcd, .csv) last wrote. A running or stopping capture is
 * always unsaved - it keeps appending, and a Loop window can keep its length constant
 * while its contents move. Opening a file replaces the capture (label `loaded`), so the
 * flag clears without a separate reset. While unsaved, the page asks before unload and
 * before Open/drag-drop replaces the capture.
 *
 * Not guarded (deliberately, for now): starting a new capture over an unsaved one. Start
 * is the primary action and is pressed repeatedly; a confirm there would be noise.
 */

import type { SampleStore } from '../data/types.js';

export interface UnsavedCaptureInput {
  /** `captureLabel.kind`: `loaded` means the data came from a file. */
  labelKind: string;
  /** Samples the displayed capture holds. */
  length: number;
  running: boolean;
  /** The length a successful save wrote for this very store, if any. */
  savedLength: number | undefined;
}

export function captureUnsaved(input: UnsavedCaptureInput): boolean {
  if (input.labelKind === 'loaded' || input.length === 0) return false;
  if (input.running) return true;
  return input.savedLength !== input.length;
}

/**
 * What each store's last successful save wrote. Weakly keyed: remembering a save must
 * not keep a discarded multi-GiB capture (an earlier Repeat wave) alive.
 */
export class SavedCaptures {
  private readonly lengths = new WeakMap<SampleStore, number>();
  mark(store: SampleStore, length: number): void { this.lengths.set(store, length); }
  lengthOf(store: SampleStore): number | undefined { return this.lengths.get(store); }
}

/** Whether a drag carries files (not text or a link dragged out of the page). */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
  return false;
}

/**
 * `dragenter`/`dragleave` fire for every child element the pointer crosses, so the
 * overlay follows a depth count rather than the last event: it shows on the first enter
 * and hides when the count returns to zero, on drop, or on dragend.
 */
export class FileDragDepth {
  private depth = 0;

  get active(): boolean { return this.depth > 0; }

  /** Returns whether the overlay should now show. */
  enter(types: ArrayLike<string> | null | undefined): boolean {
    if (this.depth > 0 || dragHasFiles(types)) this.depth++;
    return this.active;
  }

  leave(): boolean {
    if (this.depth > 0) this.depth--;
    return this.active;
  }

  reset(): boolean {
    this.depth = 0;
    return false;
  }
}
