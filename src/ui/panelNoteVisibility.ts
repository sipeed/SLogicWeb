export const hiddenCapturePanelNotes: ReadonlySet<string> = new Set<string>([
  'capturePanel.analogRateNote',
  'capturePanel.dacNote',
  'capturePanel.dacNoteAdvised',
  'capturePanel.singleFiniteNote',
  'capturePanel.repeatFiniteNote',
  'capturePanel.repeatLayersNote',
  'capturePanel.loopWindowLimit',
]);

export function capturePanelNoteHidden(key: string): boolean {
  return hiddenCapturePanelNotes.has(key);
}
