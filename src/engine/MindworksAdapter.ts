/**
 * Bridges to the window-global-function handshake Mintegral's Mindworks
 * playable review tool expects — see https://www.playturbo.com/review/doc.
 * This is a separate, simpler, network-specific convention from standard
 * IAB MRAID (see MraidAdapter.ts for that): the host defines
 * window.install/gameEnd/gameReady, which we call at the right lifecycle
 * moments; the host calls window.gameStart/gameRetry/gameClose, which we
 * expose for it to find and invoke on its own. Every call here is
 * optional-chained — a safe no-op outside a Mindworks host (this dev
 * preview, a browser demo link, a raw-MRAID-only network).
 *
 * Per the doc: a playable must never redirect on its own — install()
 * must be the *only* thing a CTA click does when this host is present;
 * see Game.ts's CTA handler for how that's composed with MraidAdapter's
 * fallback for hosts that only speak MRAID.
 */

type MindworksWindow = Window & {
  install?: () => void;
  gameEnd?: () => void;
  gameReady?: () => void;
  gameRetry?: () => void;
  gameStart?: () => void;
  gameClose?: () => void;
};

export class MindworksAdapter {
  /** Resolved per call, never captured at import — see MraidAdapter.win for why. */
  private static get win(): MindworksWindow {
    return (typeof window === "undefined" ? ({} as MindworksWindow) : (window as MindworksWindow));
  }

  /** True once window.install exists — the review tool's own signal that this host is actually present, distinct from (and not implied by) MraidAdapter.isPresent. */
  static get isPresent(): boolean {
    return typeof MindworksAdapter.win.install === "function";
  }

  /** Call once every asset finishes preloading, right before the playable becomes interactive — the review tool's own loading overlay waits for this before it'll consider the playable loaded at all; a playable that never calls it looks stuck/blank in review even though it actually booted fine. */
  static gameReady(): void {
    MindworksAdapter.win.gameReady?.();
  }

  /** Call from the install/CTA button's click handler. The host owns all redirects — do not also open a URL yourself when this host is present (see Game.ts). */
  static install(): void {
    MindworksAdapter.win.install?.();
  }

  /** Call once, the instant the playable reaches a win/lose end state (endcard shown). */
  static gameEnd(): void {
    MindworksAdapter.win.gameEnd?.();
  }

  /** Call if/when the player retries after an end state. Omit entirely for a playable with no retry flow — the doc explicitly allows that. */
  static gameRetry(): void {
    MindworksAdapter.win.gameRetry?.();
  }

  /**
   * Registers the two functions Mindworks calls *into* the playable
   * rather than the other way around — gameStart (fired once at the very
   * beginning: start countdowns/music here) and gameClose (fired once at
   * the very end: stop music/cleanup here). Call once, e.g. from Game's
   * constructor. Real no-op functions are registered even with nothing
   * to do yet, since the review tool checks these exist as callable
   * functions regardless of whether the host ever actually invokes them.
   */
  static exposeLifecycleHooks(onStart: () => void, onClose: () => void): void {
    MindworksAdapter.win.gameStart = onStart;
    MindworksAdapter.win.gameClose = onClose;
  }
}
