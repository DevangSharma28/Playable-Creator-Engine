import { MraidAdapter } from "./MraidAdapter";
import { MindworksAdapter } from "./MindworksAdapter";
import { Telemetry } from "./Telemetry";

/**
 * The one call a playable's CTA/install button should ever make.
 *
 * Every ad network wants the click routed through *its own* API, and
 * several of them explicitly forbid doing anything else on top (Mintegral's
 * Mindworks: install() must be the only thing a CTA click does; Meta's
 * playable spec says the same about FbPlayableAd.onCTAClick). A plain
 * window.open() is simultaneously the only thing that works in a browser
 * demo link and the thing that gets a playable rejected — or silently
 * swallowed by the WebView's navigation policy — inside a real network.
 *
 * So the branch has to exist somewhere. Before this file it lived in
 * game code, duplicated once per CTA button (Game.ts had the same five
 * lines twice, for the HUD button and the endcard button) — which is
 * exactly the kind of thing that rots: add a network, or add a third CTA,
 * and the copies drift. It belongs here, in engine/, because it's the
 * same for every playable ever built on this engine; only the store URL
 * differs, and that's an argument.
 *
 * Ordering below is deliberate and load-bearing: the most specific,
 * network-mandated handler wins, and exactly one handler ever runs. MRAID
 * is checked second-to-last because several networks inject *both* their
 * own API and MRAID, and the network-specific one is the one that
 * actually fires the install-click event they bill on.
 *
 * Each network's hook is optional-chained and feature-detected — nothing
 * here assumes any of them exist, so this is a safe plain-browser
 * window.open() in the dev preview and in a demo link.
 *
 * Worth re-verifying each hook against the target network's current doc
 * before a real submission — these APIs do change, and a silently-wrong
 * CTA is the single most expensive bug a playable can ship (the ad runs,
 * the click does nothing, the spend is wasted).
 */

/** Which host actually handled the click — returned by open() so a dev panel/log can show the detected network, and so this is testable without a real WebView. */
export type CtaNetwork = "mindworks" | "facebook" | "google" | "ironsource" | "mraid" | "browser";

type CtaWindow = Window & {
  /** Meta / Facebook Audience Network playable spec. */
  FbPlayableAd?: { onCTAClick?: () => void };
  /** Google (Ad Manager / AdMob) playable spec. */
  ExitApi?: { exit?: () => void };
  /** ironSource DAPI — injected alongside MRAID by some ironSource placements. */
  dapi?: { openStoreUrl?: (url: string) => void };
};

export class Cta {
  private static get win(): CtaWindow {
    return window as CtaWindow;
  }

  /**
   * Which network host is present, without doing anything. Same detection
   * order (and therefore same answer) as open() below — so a dev readout
   * of this is guaranteed to match what a real click would actually do,
   * rather than being a second, separately-drifting guess.
   */
  static detect(): CtaNetwork {
    const win = Cta.win;
    if (MindworksAdapter.isPresent) return "mindworks";
    if (typeof win.FbPlayableAd?.onCTAClick === "function") return "facebook";
    if (typeof win.ExitApi?.exit === "function") return "google";
    if (typeof win.dapi?.openStoreUrl === "function") return "ironsource";
    if (MraidAdapter.isPresent) return "mraid";
    return "browser";
  }

  /** True inside any recognized ad-network host — i.e. detect() is anything but "browser". */
  static get isAdNetwork(): boolean {
    return Cta.detect() !== "browser";
  }

  /**
   * Fire the install/click-through. Call this from every CTA button; it
   * is the whole contract. `storeUrl` is only consulted on the paths that
   * actually take one — the network-owned handlers (Mindworks, Meta,
   * Google) redirect to the listing the *network* has configured, and
   * passing a URL to them is both unnecessary and, per their docs, wrong.
   *
   * Returns the network that handled it, for logging/dev display.
   */
  static open(storeUrl: string): CtaNetwork {
    const win = Cta.win;
    const network = Cta.detect();

    switch (network) {
      case "mindworks":
        // Host owns the redirect entirely — must be the only thing a click does.
        MindworksAdapter.install();
        break;
      case "facebook":
        win.FbPlayableAd?.onCTAClick?.();
        break;
      case "google":
        win.ExitApi?.exit?.();
        break;
      case "ironsource":
        win.dapi?.openStoreUrl?.(storeUrl);
        break;
      case "mraid":
        // Goes through mraid.open() (never window.open) — see MraidAdapter.openStoreUrl.
        MraidAdapter.openStoreUrl(storeUrl);
        break;
      case "browser":
        // Dev preview / demo link: a plain new tab is the only thing available, and the right thing.
        window.open(storeUrl, "_blank");
        break;
    }

    // The click-through is the one event every campaign is actually judged
    // on, and this is the single place in the engine that knows one
    // happened *and* which host handled it — so reporting it here means a
    // playable gets it for free rather than having to remember to call
    // Ion.track alongside every CTA button. Telemetry never throws and
    // no-ops with no sink installed, so this cannot affect the click.
    Telemetry.track("ion:cta", { network });

    return network;
  }
}
