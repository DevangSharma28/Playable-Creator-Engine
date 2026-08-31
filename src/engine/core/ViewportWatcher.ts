import { MraidAdapter } from "../MraidAdapter";

/**
 * How long after a change signal to re-measure, in milliseconds.
 *
 * Two passes, not one, and both fairly late. A rotation on iOS Safari
 * dispatches `resize` *before* layout has settled, so the size read in that
 * handler is frequently the pre-rotation one (or a transient mid-animation
 * value); Android WebViews doing a soft-keyboard show/hide behave the same
 * way. A single deferred pass fixes the common case and still loses to a
 * slow device, which is what the second one is for. Both are cheap: the
 * watcher only calls back when the measured size actually differs from
 * what it last reported, so a settle pass that finds nothing new does
 * nothing at all.
 */
const DEFAULT_SETTLE_DELAYS_MS = [120, 400];

export interface ViewportWatcherOptions {
  /** Override the deferred re-measure schedule. Empty array disables the settle passes entirely. */
  settleDelaysMs?: number[];
  /** Measures the size to compare against. Defaults to the window's inner size — the same numbers the renderer is sized from. */
  measure?: () => { width: number; height: number };
}

/**
 * One place that answers "the viewport changed, re-size everything".
 *
 * ## Why this isn't just `window.addEventListener("resize", ...)`
 *
 * A playable ad does not run in a normal browser window, and every one of
 * the following is a real failure that a bare `resize` listener produces:
 *
 *  - **An ad-network WebView can be mid-layout — sometimes literally 0×0 —
 *    at the moment the game constructs**, and is not guaranteed to ever
 *    dispatch a native `resize` once it settles. It signals through
 *    MRAID's own `ready`/`sizeChange`/`viewableChange` events instead. A
 *    renderer sized once at construction and never revisited stays wrong,
 *    and in the 0×0 case stays invisible, for the entire session.
 *  - **Rotation reports stale dimensions.** `resize` (and
 *    `orientationchange`, which is worse) fire before layout settles on
 *    iOS Safari, so the handler measures the size the page had *before*
 *    the rotation. The playable then renders letterboxed or cropped until
 *    something else happens to trigger another resize — often nothing
 *    does.
 *  - **`visualViewport` moves without `window` resizing**, which is how a
 *    soft keyboard, a pinch-zoom, or a collapsing browser chrome shows up.
 *
 * So the watcher listens to every one of those signals, and after each one
 * re-measures again on a short schedule (see DEFAULT_SETTLE_DELAYS_MS)
 * rather than trusting the first reading.
 *
 * ## Why it de-duplicates
 *
 * `onChange` fires only when the measured size actually differs from the
 * last size it reported. That's what makes it safe to point four noisy
 * event sources and two timers at one handler that resizes a renderer,
 * re-projects two cameras and re-lays-out two UI layouts: the redundant
 * signals collapse instead of multiplying.
 *
 * ## Why `setTimeout` and not `Ion.after`
 *
 * `Ion.after` runs on game time, which deliberately stops while the UI
 * editor or the 3D editor is open. A viewport that changed size while an
 * editor is open still needs the renderer resized — arguably more so. This
 * is host/browser plumbing, not gameplay, so it belongs on the wall clock.
 * Every timer it starts is cleared by `dispose()`.
 */
/** `screen.orientation`, or undefined wherever `screen` itself doesn't exist. */
function orientationTarget(): EventTarget | undefined {
  const scr = (globalThis as { screen?: { orientation?: EventTarget } }).screen;
  return scr?.orientation;
}

/** addEventListener on a target that may be absent, or may predate the method. */
function listen(target: EventTarget | null | undefined, type: string, fn: () => void): void {
  target?.addEventListener?.(type, fn);
}

function unlisten(target: EventTarget | null | undefined, type: string, fn: () => void): void {
  target?.removeEventListener?.(type, fn);
}

export class ViewportWatcher {
  private readonly settleDelays: number[];
  private readonly measure: () => { width: number; height: number };
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private lastWidth = -1;
  private lastHeight = -1;
  private disposed = false;

  constructor(
    private readonly onChange: () => void,
    options: ViewportWatcherOptions = {}
  ) {
    this.settleDelays = options.settleDelaysMs ?? DEFAULT_SETTLE_DELAYS_MS;
    this.measure = options.measure ?? (() => ({ width: window.innerWidth, height: window.innerHeight }));

    const size = this.measure();
    this.lastWidth = size.width;
    this.lastHeight = size.height;

    window.addEventListener("resize", this.onSignal);
    window.addEventListener("orientationchange", this.onSignal);
    // Not implied by `resize`: `screen.orientation` change and `resize`
    // fire independently, in an order that differs between browsers, and
    // on some Android WebViews only this one arrives.
    //
    // Every target below is reached through `listen`, which tolerates it
    // being absent. That isn't defensive habit: `screen.orientation` and
    // `visualViewport` are genuinely missing in older WebViews, and the
    // whole set is missing in the jsdom-shaped environments this runtime
    // is unit-tested in. A hard reference to `screen` here threw
    // `ReferenceError: screen is not defined` out of a game's constructor.
    listen(orientationTarget(), "change", this.onSignal);
    // A soft keyboard or pinch-zoom moves this without touching
    // window.innerWidth/innerHeight at all.
    listen(typeof window === "undefined" ? undefined : window.visualViewport, "resize", this.onSignal);

    // Only when a host is actually present. `onReady` invokes its callback
    // synchronously when MRAID is absent (which is correct — "ready" is
    // immediately true in a plain browser), and taking that as a viewport
    // signal would schedule a pair of settle timers on every single boot,
    // including every unit test, for a size that by definition hasn't
    // changed yet.
    //
    // Neither subscription has an `off` counterpart — MRAID's own
    // addEventListener is all the spec gives us, and the adapter doesn't
    // hand back a handle. The `disposed` guard inside onSignal is what
    // makes a retired watcher inert instead of leaking a callback into a
    // hot-reloaded game.
    if (MraidAdapter.isPresent) {
      MraidAdapter.onReady(this.onSignal);
      MraidAdapter.onSizeChange(this.onSignal);
    }
  }

  /**
   * Re-measures now and fires `onChange` if the size moved. For a host
   * that changed the viewport in a way none of the watched events cover —
   * or to force a first sizing pass at boot.
   */
  poll(): void {
    if (this.disposed) return;
    const { width, height } = this.measure();
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.onChange();
  }

  /** Fires `onChange` unconditionally and re-bases the de-duplication against the current size. For a host that resized something the watcher can't measure. */
  forceUpdate(): void {
    if (this.disposed) return;
    const { width, height } = this.measure();
    this.lastWidth = width;
    this.lastHeight = height;
    this.onChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("resize", this.onSignal);
    window.removeEventListener("orientationchange", this.onSignal);
    unlisten(orientationTarget(), "change", this.onSignal);
    unlisten(typeof window === "undefined" ? undefined : window.visualViewport, "resize", this.onSignal);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }

  private readonly onSignal = (): void => {
    if (this.disposed) return;
    this.poll();
    for (const delay of this.settleDelays) {
      const timer = setTimeout(() => {
        const index = this.timers.indexOf(timer);
        if (index >= 0) this.timers.splice(index, 1);
        this.poll();
      }, delay);
      this.timers.push(timer);
    }
  };
}
