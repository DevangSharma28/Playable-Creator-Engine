/**
 * A joystick that's invisible until you touch the screen, then appears
 * centered exactly where you touched — anywhere across the full play area,
 * not pinned to one fixed on-screen spot. Releasing hides it again, ready
 * to reappear wherever the next touch lands.
 *
 * Reuses the exact base/knob visuals UILayout.getJoystick() already
 * resolves (whatever color/size was designed in tools/ui-editor.html still
 * applies) — this only changes *where* and *when* they appear, not how
 * they look. Same public shape as the old fixed-position InputHandler
 * (axis / isActive / dispose()) it replaces, so Player.update() needs no
 * changes to consume it.
 */
export class DynamicJoystick {
  /** Normalized -1..1 input axis. Read this each frame; do not mutate it. */
  readonly axis = { x: 0, y: 0 };

  private active = false;
  private pointerId: number | null = null;
  /** Where the current drag started (real viewport px) — the base is centered here for the whole gesture, not re-measured from its own box each move. */
  private readonly center = { x: 0, y: 0 };
  private readonly radius: number;
  /** Full-screen invisible hit layer this class creates and owns — the visible base/knob are purely decorative now (no pointer-events of their own), since dragging is tracked from here + window, not from the base's own (now-roaming) box. */
  private readonly catcher: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly base: HTMLElement,
    private readonly knob: HTMLElement,
    radius = 45,
    private readonly onFirstInput?: () => void
  ) {
    this.radius = radius;

    this.catcher = document.createElement("div");
    this.catcher.style.position = "absolute";
    this.catcher.style.inset = "0";
    // Behind any real authored UI element — renderOrder always starts at (or
    // above) 0 and only climbs from there (see UIElementData's doc comment),
    // so a button/etc. placed via the UI editor still wins its own clicks
    // instead of this catcher stealing them first.
    this.catcher.style.zIndex = "-1";
    // `parent` (custom-ui-layer) is pointer-events:none by default so
    // decorative elements never steal touches — this opts just the catcher
    // in, the same convention UILayout.setInteractive() uses for a real
    // designed button.
    this.catcher.style.pointerEvents = "auto";
    this.catcher.style.touchAction = "none";
    parent.appendChild(this.catcher);

    // Lock in whatever size the UI editor configured (widthPx/heightPx or
    // %, resolved against the joystick's normal anchored box) as an
    // explicit pixel size *before* reparenting/switching it to
    // position:fixed below — once fixed, "100%/100%" (what UILayout.ts's
    // buildElement sets on every content node) would otherwise resolve
    // against the viewport instead of its old wrapper, ballooning it to
    // fill the whole screen.
    const rect = this.base.getBoundingClientRect();
    this.base.style.width = `${rect.width}px`;
    this.base.style.height = `${rect.height}px`;
    // Same reason as width/height above: UILayout.ts's buildElement sets
    // *opacity* on the wrapper too (`wrapper.style.opacity = data.opacity`,
    // straight from the Properties panel's Opacity slider), not on `base`
    // itself — reparenting base out from under that wrapper below would
    // otherwise silently drop whatever value was configured there back to
    // the browser default (fully opaque), with no obvious link back to a
    // slider that visibly still shows the value you set.
    const wrapperOpacity = this.base.parentElement?.style.opacity;
    if (wrapperOpacity) this.base.style.opacity = wrapperOpacity;

    // Move it all the way out to <body> — UILayout.ts's buildElement sets a
    // CSS `transform` on its original parent wrapper (the anchor position/
    // rotation), and per spec a transformed ancestor becomes the
    // *containing block* for any position:fixed descendant instead of the
    // viewport. Left nested there, the left/top set in handlePointerDown
    // below would resolve against that wrapper's own (anchored, possibly
    // rotated) box, not the real screen — the joystick would never
    // actually land under the pointer. `knob` comes along for free, it's
    // already a DOM child of `base`.
    document.body.appendChild(this.base);

    // Detached from the UI editor's anchored layout entirely — this base
    // gets repositioned straight to the live touch point on every press
    // (see handlePointerDown), so it can never stay pinned to the one spot
    // the editor originally placed it at.
    this.base.style.position = "fixed";
    this.base.style.transform = "translate(-50%, -50%)"; // left/top below always mean "this point is the center", not a corner
    // Now a direct <body> child instead of nested under custom-ui-layer's
    // own stacking context — always above every other designed element
    // while a drag is actually happening, which is the one moment nothing
    // should be able to cover it.
    this.base.style.zIndex = "1000";
    this.base.style.display = "none";

    this.catcher.addEventListener("pointerdown", this.handlePointerDown);
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerUp);
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Removes the catcher layer, the body-reparented base (see the
   * constructor's doc comment — it's no longer inside `container`, so
   * whatever tears that down doesn't reach it), and every listener this
   * registered. Called by Game.dispose() before the dev preview's in-place
   * reload builds a fresh instance into the same, persisting DOM — without
   * this, `base` would stay orphaned on <body> forever, and every save
   * would leave another stale, invisible joystick base behind.
   */
  dispose(): void {
    this.catcher.removeEventListener("pointerdown", this.handlePointerDown);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerUp);
    this.catcher.remove();
    this.base.remove();
  }

  private handlePointerDown = (e: PointerEvent): void => {
    this.active = true;
    this.pointerId = e.pointerId;
    this.center.x = e.clientX;
    this.center.y = e.clientY;

    this.base.style.left = `${e.clientX}px`;
    this.base.style.top = `${e.clientY}px`;
    this.base.style.display = "";
    // this.base.style.opacity = "1.0";

    this.updateStick(e.clientX, e.clientY);
    this.catcher.setPointerCapture(e.pointerId);
    this.onFirstInput?.();
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.active || e.pointerId !== this.pointerId) return;
    this.updateStick(e.clientX, e.clientY);
  };

  private handlePointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.active = false;
    this.pointerId = null;
    this.axis.x = 0;
    this.axis.y = 0;
    this.knob.style.transform = "translate(0%, 0%)";
    this.base.style.display = "none";
  };

  private updateStick(clientX: number, clientY: number): void {
    let dx = clientX - this.center.x;
    let dy = clientY - this.center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > this.radius) {
      dx = (dx / dist) * this.radius;
      dy = (dy / dist) * this.radius;
    }
    this.knob.style.transform = `translate(calc(0% + ${dx}px), calc(0% + ${dy}px))`;
    this.axis.x = dx / this.radius;
    this.axis.y = dy / this.radius;
  }
}
