import { Cta } from "../Cta";

export interface CrashOverlayOptions {
  message?: string;
}

const OVERLAY_ID = "ion-crash-overlay";

/**
 * The store URL the recovery button's Cta.open() call uses — set once by
 * game code (Game.ts calling setCrashRecoveryUrl(STORE_URL), same URL its
 * own CTA buttons use), not threaded through IonEngineOptions/boot(). That
 * keeps main.ts genuinely identical across every playable built on this
 * engine (see ENGINE.md's "Building a new playable ad" step 2) — the
 * store URL is game-specific data, and a crash can only be recovered from
 * *after* Game already exists to know it, so there's no meaningful way to
 * pass it any earlier anyway.
 *
 * Safe to leave unset: the three network-owned Cta paths (Mindworks/Meta/
 * Google) never read a URL at all, so recovery still works fine inside
 * those hosts even without this; only the MRAID/ironSource/plain-browser
 * fallback paths would open a blank target without it.
 */
let crashRecoveryUrl = "";

export function setCrashRecoveryUrl(url: string): void {
  crashRecoveryUrl = url;
}

/**
 * The guaranteed-safe fallback IonEngine shows when gameplay throws
 * mid-frame — see IonEngine.ts's own crash-guard doc comment for why this
 * exists at all (a crashed playable is 100% wasted ad spend: the ad ran,
 * the click can't happen, nothing is billed).
 *
 * Deliberately built independent of Game/HUD/UILayout: plain DOM nodes,
 * inline styles only, one call to Cta (stateless, feature-detects off
 * `window`, can't itself depend on whatever just broke). Whatever threw
 * could have left Game, the UI layers, or the DOM UILayout manages in an
 * unknown state — reusing any of that machinery to show the recovery UI
 * would risk the recovery path throwing too. This has nothing to depend
 * on but the real DOM, which still works.
 */
export function showCrashOverlay(opts: CrashOverlayOptions = {}): void {
  if (document.getElementById(OVERLAY_ID)) return; // already showing — never double-inject

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#000;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;padding:24px;box-sizing:border-box;";

  const msg = document.createElement("div");
  msg.textContent = opts.message ?? "Something went wrong.";
  msg.style.cssText = "font-size:16px;opacity:0.85;line-height:1.4;";
  overlay.appendChild(msg);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Continue";
  btn.style.cssText =
    "font-size:16px;font-weight:700;padding:14px 36px;border-radius:999px;border:none;background:#ffcc4d;color:#1a1204;cursor:pointer;font-family:inherit;";
  btn.addEventListener("click", () => Cta.open(crashRecoveryUrl));
  overlay.appendChild(btn);

  document.body.appendChild(overlay);
}

/** Removes the overlay if present — called at the start of every IonEngine boot (including an in-place hot-reload) so a crash during one dev iteration doesn't linger visually over the next. */
export function removeCrashOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
}
