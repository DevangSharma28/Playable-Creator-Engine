/**
 * Watches one element's real box and reports every change, coalesced to
 * one callback per animation frame.
 *
 * A ResizeObserver rather than a `window.resize` listener, deliberately:
 * the editor viewport changes size for reasons the window never hears
 * about — entering/leaving the editor (side panels claim horizontal
 * space), a device-frame mode switch, a dragged panel divider, the 150ms
 * CSS transition on `#device-frame` actually settling. A window listener
 * misses all of those, and the old code's alternative (recomputing from
 * the size someone *intended* the box to become, at the moment they set
 * it) reports the pre-transition box and bakes in a stale aspect. Observing
 * the element reports what actually happened, after it happened, whatever
 * caused it.
 *
 * The rAF coalescing matters for the transition case specifically: a 150ms
 * animated resize fires this observer on essentially every frame it moves,
 * and each one would otherwise reallocate the WebGL drawing buffer.
 * Batching to one callback per frame keeps that to a single resize per
 * rendered frame, which is the most that can ever be visible anyway.
 */
export class EditorResizeManager {
  private readonly observer: ResizeObserver;
  private frameId: number | null = null;
  private pending: { width: number; height: number } | null = null;
  private disposed = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly onResize: (width: number, height: number) => void
  ) {
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      // contentRect is the post-layout truth for this element; falling back
      // to getBoundingClientRect covers the (rare) entry without one.
      const rect = entry.contentRect ?? this.target.getBoundingClientRect();
      this.queue(rect.width, rect.height);
    });
    this.observer.observe(target);
  }

  /** Force a measurement now, outside the observer — used on editor entry so the first rendered frame already has the right projection instead of waiting a frame for the observer's own initial callback. */
  measureNow(): void {
    if (this.disposed) return;
    const rect = this.target.getBoundingClientRect();
    this.onResize(rect.width, rect.height);
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId);
      this.frameId = null;
    }
    this.pending = null;
  }

  private queue(width: number, height: number): void {
    if (this.disposed) return;
    this.pending = { width, height };
    if (this.frameId !== null) return;
    this.frameId = requestAnimationFrame(() => {
      this.frameId = null;
      const size = this.pending;
      this.pending = null;
      // Disposal can land between scheduling this frame and it running —
      // firing the callback then would resize a renderer the editor has
      // already handed back to gameplay.
      if (size && !this.disposed) this.onResize(size.width, size.height);
    });
  }
}
