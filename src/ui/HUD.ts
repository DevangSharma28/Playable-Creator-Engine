import { UILayout } from "./UILayout";

/**
 * All game text/visuals now come from two editor-authored layouts:
 * `main` (score, drag hint, and anything else visible during play) and
 * `endcard` (shown only once the game ends). Nothing here is hardcoded
 * HTML — element names below (e.g. "score", "endcard-title") must match
 * the `name` given to that element in tools/ui-editor.html.
 */
export class HUD {
  private moneyIcon: HTMLElement | undefined;
  private hintHidden = false;

  constructor(
    private readonly main: UILayout,
    private readonly endcard: UILayout
  ) {
    this.endcard.setVisible(false);
    this.moneyIcon = this.main.get("Hire-Cost");
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
    this.moneyIcon.style.animation = "pulse 2s";
    setTimeout(() => {
      this.moneyIcon!.style.animation = "";
    }, 2000);
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

  /** Wire up the install button. Swap the handler's contents for a real store URL. */
  onCtaClick(handler: () => void): void {
    this.endcard.setInteractive("cta-button-bg", handler);
  }
}
