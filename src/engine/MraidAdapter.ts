/**
 * Thin wrapper around the IAB MRAID API most ad networks inject into the
 * WebView hosting a playable (Mintegral/Mindworks, AppLovin, Unity Ads,
 * ironSource, Meta Audience Network, Google Ad Manager, ...). Falls back to
 * plain browser behavior when `window.mraid` isn't present — this dev
 * preview, a browser demo link — so game code never needs its own "am I
 * inside an ad network" branch; it just calls MraidAdapter either way.
 */

interface MraidApi {
  getState(): "loading" | "default" | "ready" | "expanded" | "hidden";
  addEventListener(event: string, cb: () => void): void;
  removeEventListener(event: string, cb: () => void): void;
  open(url: string): void;
  close(): void;
  isViewable(): boolean;
  getMaxSize?(): { width: number; height: number };
}

type MraidWindow = Window & { mraid?: MraidApi };

export class MraidAdapter {
  private static win = window as MraidWindow;

  /** True once window.mraid actually exists — the most reliable "are we inside an ad network's WebView" check available; every other method here only behaves differently because of this. */
  static get isPresent(): boolean {
    return !!MraidAdapter.win.mraid;
  }

  /**
   * Opens the store listing / click-through URL. Inside an MRAID host,
   * plain `window.open()` / `location.href` navigation is routinely
   * blocked or silently swallowed by the WebView's own navigation policy
   * — networks require going through `mraid.open()` instead, which is
   * also what actually fires the install-click event the network bills
   * on, so a plain `window.open()` CTA can look like it "does nothing" in
   * a real network even though it works fine in a normal browser tab.
   */
  static openStoreUrl(url: string): void {
    const mraid = MraidAdapter.win.mraid;
    if (!mraid) {
      window.open(url, "_blank");
      return;
    }
    MraidAdapter.onReady(() => mraid.open(url));
  }

  /** Closes the ad. Only meaningful inside a real MRAID host — a no-op everywhere else, since there's nothing sensible to do with a "close" action in a plain browser tab. */
  static close(): void {
    MraidAdapter.win.mraid?.close();
  }

  /**
   * Runs `fn` once MRAID reports "ready" — every method on the real API
   * is explicitly undefined/unreliable to call before that state per the
   * spec every network implements against, and some hosts (Mintegral's
   * Mindworks among them) fire `ready` only after their own SDK init
   * finishes, which can land after this script has already run. Runs
   * immediately if MRAID isn't present, or already past "loading".
   *
   * Also the fix for a specific "blank screen in the ad network, works
   * fine in a normal browser" failure mode: the WebView hosting the ad
   * can still be mid-layout (wrong size, sometimes literally 0×0) at the
   * exact moment this script starts running, and unlike a real browser
   * window, an MRAID host isn't guaranteed to ever dispatch a native DOM
   * `resize` event once it settles — it has its own `ready`/`sizeChange`
   * events instead, which nothing was listening to before. A renderer
   * sized once at construction and never revisited stays wrong (possibly
   * invisible) for the entire session. Game.ts calls this to force a
   * fresh resize once MRAID confirms ready, independent of whatever a
   * native `resize` listener does or doesn't fire.
   */
  static onReady(fn: () => void): void {
    const mraid = MraidAdapter.win.mraid;
    if (!mraid || mraid.getState() !== "loading") {
      fn();
      return;
    }
    const onReadyEvent = (): void => {
      mraid.removeEventListener("ready", onReadyEvent);
      fn();
    };
    mraid.addEventListener("ready", onReadyEvent);
  }

  /**
   * Runs `fn` whenever MRAID reports its size or viewable state changing
   * (expand/collapse, a rotation the host handles itself, ...) — the
   * MRAID-native equivalent of a window `resize` listener, for hosts that
   * resize the WebView without ever dispatching one. No-op if MRAID isn't
   * present; the regular window `resize` listener already covers that
   * case.
   */
  static onSizeChange(fn: () => void): void {
    const mraid = MraidAdapter.win.mraid;
    if (!mraid) return;
    mraid.addEventListener("sizeChange", fn);
    mraid.addEventListener("viewableChange", fn);
  }
}
