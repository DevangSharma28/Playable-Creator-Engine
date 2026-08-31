import { UILayout } from "../../engine/ui/UILayout";
import { applyBindings, type BindingsData } from "../../engine/Bindings";
import { Ion } from "../../engine/Ion";
import type { CoinCollected } from "../Game";
import bindingsRaw from "./bindings.json";

const bindingsData = bindingsRaw as BindingsData;

/**
 * All game text/visuals now come from two editor-authored layouts:
 * `main` (score, drag hint, and anything else visible during play) and
 * `endcard` (shown only once the game ends). Nothing here is hardcoded
 * HTML — element names below (e.g. "score", "endcard-title") must match
 * the `name` given to that element in tools/ui-editor.html.
 */
export class HUD {
  public moneyIcon: HTMLElement | undefined;

  private hintHidden = false;

  public inGameCTA: HTMLElement | undefined

  constructor(
    private readonly main: UILayout,
    private readonly endcard: UILayout
  ) {
    this.endcard.setVisible(false);

    // Wires up any public field the UI editor's Scripts panel drag-and-drop
    // (or ⊙ Pick) assigned — e.g. moneyIcon gets whichever designed element
    // was dropped onto it there, no manual `main.get("...")` call needed.
    // Self-contained here (rather than the composition root, Game.ts,
    // calling this externally) so HUD owns its own wiring, and the log
    // below reflects the real, final value right where it's actually used.
    applyBindings(this, "HUD", bindingsData, this.main, this.endcard);

    // The worked example of the shared event bus. HUD holds no reference to
    // CoinField and CoinField holds none to HUD — the score arrives because
    // this class asked to hear about it, not because gameplay code was
    // written to remember to tell it.
    //
    // Nothing to unsubscribe: IonEngine clears the whole bus in its teardown
    // (see its __disposeGame hook), which is what stops a hot-reloaded
    // bundle's listeners firing into the new one. A subscription taken here
    // and never released would be a leak in any other lifecycle; in this one
    // it's the same lifetime as the Game itself.
    //
    // Safe this early because IonEngine binds Ion *before* Game.create()
    // runs — the same ordering that lets an entity register a collider in
    // its own constructor.
    Ion.on<CoinCollected>("coin-collected", ({ collected, total }) => this.setScore(collected, total));

    this.pulseMoneyIcon();
  }

  set moneyVisible(v: boolean) {
    if (this.moneyIcon) this.moneyIcon.style.display = v ? "" : "none";
  }

  get moneyVisible(): boolean {
    return this.moneyIcon ? this.moneyIcon.style.display !== "none" : false;
  }

  pulseMoneyIcon(): void {
    if (!this.moneyIcon) return;
  }

  setScore(collected: number, total: number): void {
    this.main.setText("score", `${collected} / ${total}`);
  }

  hideDragHint(): void {
    if (this.hintHidden) return;
    this.hintHidden = true;
    this.main.hide("drag-hint");
  }

  showEndCard(won: boolean): void {
    this.endcard.setText("endcard-title", won ? "All coins collected!\nGet the full game!" : "Nice rolling!\nGet the full game!");
    this.endcard.setVisible(true);
  }

  /** Wire up the install button — see Game.ts's constructor for the actual handler (routes through MraidAdapter.openStoreUrl and STORE_URL there, not hardcoded here). */
  onCtaClick(handler: () => void): void {
    this.endcard.setInteractive("cta-button-bg", handler);
  }

  onInGameCtaClick(handler: () => void): void {
    // Passing the element directly (not a name) — which instance this is
    // called through doesn't actually matter functionally (see
    // setInteractive's own doc comment), but `main` is the semantically
    // correct one: an "in-game" CTA lives on the main HUD, not the
    // endcard.
    this.main.setInteractive(this.inGameCTA, handler);
  }
}
