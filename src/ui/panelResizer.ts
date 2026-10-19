import {
  applyPanelWidth, clampPanelWidth, getPanelWidth, maxPanelWidth, onPanelWidthChange,
  PANEL_WIDTH_DEFAULT, PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, setPanelWidth,
  widthFromKey, widthFromPointer,
} from './panelWidth.js';

interface DragState {
  pointerId: number;
  startWidth: number;
  startX: number;
  maxWidth: number;
  pending: number;
  abort: AbortController;
}

export class PanelResizer {
  private drag: DragState | null = null;

  constructor(
    private readonly handle: HTMLElement,
    private readonly panel: HTMLElement,
    private readonly row: HTMLElement,
  ) {
    handle.setAttribute('aria-valuemin', String(PANEL_WIDTH_MIN));
    handle.setAttribute('aria-valuemax', String(PANEL_WIDTH_MAX));
    handle.addEventListener('pointerdown', this.onPointerDown);
    handle.addEventListener('pointermove', this.onPointerMove);
    handle.addEventListener('pointerup', this.onPointerUp);
    handle.addEventListener('pointercancel', this.onPointerCancel);
    handle.addEventListener('lostpointercapture', this.onLostPointerCapture);
    handle.addEventListener('keydown', this.onKeyDown);
    handle.addEventListener('dblclick', this.onDoubleClick);
    onPanelWidthChange(() => { this.syncValue(); });
    this.syncValue();
  }

  setHidden(hidden: boolean): void {
    this.handle.classList.toggle('hidden', hidden);
    this.endDrag(false);
  }

  private syncValue(): void {
    this.handle.setAttribute('aria-valuenow', String(getPanelWidth() ?? PANEL_WIDTH_DEFAULT));
  }

  private currentMaxWidth(): number {
    return maxPanelWidth(this.row.getBoundingClientRect().width);
  }

  private endDrag(commit: boolean): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;
    if (commit) setPanelWidth(drag.pending);
    else applyPanelWidth(getPanelWidth());
    drag.abort.abort();
    this.handle.classList.remove('resizing');
    document.documentElement.classList.remove('resizing');
    if (this.handle.hasPointerCapture(drag.pointerId)) {
      this.handle.releasePointerCapture(drag.pointerId);
    }
    this.syncValue();
  }

  private readonly onDragKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    this.endDrag(false);
  };

  private readonly onWindowBlur = (): void => {
    this.endDrag(false);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (this.drag !== null) return;
    event.preventDefault();
    const abort = new AbortController();
    const startWidth = this.panel.getBoundingClientRect().width;
    this.drag = {
      pointerId: event.pointerId,
      startWidth,
      startX: event.clientX,
      maxWidth: this.currentMaxWidth(),
      pending: clampPanelWidth(startWidth),
      abort,
    };
    this.handle.setPointerCapture(event.pointerId);
    this.handle.classList.add('resizing');
    document.documentElement.classList.add('resizing');
    window.addEventListener('keydown', this.onDragKeyDown, { signal: abort.signal });
    window.addEventListener('blur', this.onWindowBlur, { signal: abort.signal });
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag.pending = widthFromPointer(drag.startWidth, drag.startX, event.clientX, drag.maxWidth);
    applyPanelWidth(drag.pending);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    this.endDrag(true);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    this.endDrag(false);
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    this.endDrag(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const next = widthFromKey(
      getPanelWidth() ?? PANEL_WIDTH_DEFAULT,
      event.key,
      event.shiftKey,
      this.currentMaxWidth(),
    );
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (this.drag !== null) return;
    setPanelWidth(next);
  };

  private readonly onDoubleClick = (): void => {
    setPanelWidth(null);
  };
}
