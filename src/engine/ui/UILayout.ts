import type { AnchorPreset, UIAnimation, UIElementData, UILayoutData } from "./UILayoutTypes";

/** How far the element's own box shifts so that (xPct, yPct) lands on the chosen anchor point. */
const ANCHOR_TRANSFORM: Record<AnchorPreset, string> = {
  "top-left": "translate(0%, 0%)",
  "top-center": "translate(-50%, 0%)",
  "top-right": "translate(-100%, 0%)",
  "middle-left": "translate(0%, -50%)",
  "middle-center": "translate(-50%, -50%)",
  "middle-right": "translate(-100%, -50%)",
  "bottom-left": "translate(0%, -100%)",
  "bottom-center": "translate(-50%, -100%)",
  "bottom-right": "translate(-100%, -100%)",
};

/** Where each anchor preset's own point sits in the container, as a fraction of its width/height — the origin PX position offsets from (see applyGeometry). */
const ANCHOR_FRAC: Record<AnchorPreset, { x: number; y: number }> = {
  "top-left": { x: 0, y: 0 },
  "top-center": { x: 0.5, y: 0 },
  "top-right": { x: 1, y: 0 },
  "middle-left": { x: 0, y: 0.5 },
  "middle-center": { x: 0.5, y: 0.5 },
  "middle-right": { x: 1, y: 0.5 },
  "bottom-left": { x: 0, y: 1 },
  "bottom-center": { x: 0.5, y: 1 },
  "bottom-right": { x: 1, y: 1 },
};

/** Mirrors tools/ui-editor.html's needsLockedAspect() exactly — a joystick is always locked. */
function needsLockedAspect(data: UIElementData): boolean {
  return data.type === "joystick" || data.lockAspect === true;
}

/** Mirrors tools/ui-editor.html's visualAspectRatio() exactly — the ratio is captured once at lock time (see UILayoutTypes.ts's aspectRatio field), never recomputed from live width/height. */
function visualAspectRatio(d: UIElementData): number {
  return d.aspectRatio ?? 1;
}

const ANIMATION_CSS: Record<Exclude<UIAnimation, "none">, string> = {
  pulse: "ui-anim-pulse 1.2s ease-in-out infinite",
  bob: "ui-anim-bob 1.6s ease-in-out infinite",
  spin: "ui-anim-spin 2.5s linear infinite",
  fadeIn: "ui-anim-fadeIn 0.4s ease-out both",
};

let keyframesInjected = false;
/** Injects the shared @keyframes once per page — cheaper than per-element <style> tags. */
function ensureKeyframes(): void {
  if (keyframesInjected) return;
  keyframesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ui-anim-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
    @keyframes ui-anim-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6%); } }
    @keyframes ui-anim-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes ui-anim-fadeIn { from { opacity: 0; } to { opacity: 1; } }
  `;
  document.head.appendChild(style);
}

/**
 * Renders a UILayoutData (produced by tools/ui-editor.html) into real DOM
 * elements inside `container`. Purely decorative/presentational by
 * default — every element has `pointer-events: none` so it never steals
 * touches from the joystick or buttons underneath. Call `setInteractive()`
 * if you want a specific element (e.g. a designed button sprite) to be
 * clickable.
 *
 * Deliberately the SAME geometry formulas tools/ui-editor.html's own
 * renderCanvas()/pxScale() use, element for element — that editor preview
 * is the source of truth for "what this layout should look like", so this
 * renderer is written to reproduce it exactly rather than to be "an
 * equivalent, differently-built system": every element (top-level or
 * nested inside a group) is appended as a real DOM descendant of its real
 * parent (the container itself, or the parent group's own content node) —
 * no intermediate fixed-resolution "stage" wrapper — so a `%` field
 * resolves natively against whatever its real containing block's current
 * size is, exactly like plain CSS `%` always has, with zero extra math
 * needed. A `px` field is a *design-resolution* value (canvasWidth/
 * canvasHeight below, matching the editor's designWidth/designHeight) —
 * pxScale() converts it to the current live size, uniformly (never
 * stretched differently per axis just because the live aspect ratio isn't
 * the design's own) — see pxScale()'s own doc comment.
 */
export class UILayout {
  /** Maps a placed element's name to its content node (the img/text/rect/joystick — not the positioning wrapper). */
  private readonly elements = new Map<string, HTMLElement>();
  /** The layout's own fixed reference resolution — what every px value on every element means "at" (matches tools/ui-editor.html's designWidth/designHeight, pinned from this same canvasWidth/canvasHeight when a layout loads there). */
  private readonly canvasWidth: number;
  private readonly canvasHeight: number;
  /** Live container size from the most recent updateScale() call — scaleX/scaleY are `live / canvasWidth-or-Height`; liveHeight feeds text's font-size (see buildContent's text branch). */
  private scaleX = 1;
  private scaleY = 1;
  private liveHeight = 0;
  /** Every placed element, for updateScale() to re-run applyGeometry() on after a resize. */
  private readonly geometryElements: { data: UIElementData; wrapper: HTMLElement }[] = [];
  /** Every text element's own content node, for updateScale() to re-apply its font-size after a resize — see buildContent's text branch. */
  private readonly textNodes: { data: UIElementData; node: HTMLElement }[] = [];

  constructor(private readonly container: HTMLElement, data: UILayoutData) {
    ensureKeyframes();
    // Position/inset are the caller's responsibility via CSS, not forced
    // here — an inline style always wins over a stylesheet rule, so
    // hardcoding "fixed" would silently override a container meant to sit
    // relative to something other than the real viewport (e.g. the dev
    // device-frame simulator's letterboxed box in index.html).
    // Production's #custom-ui-layer/#endcard-layer use position:fixed in
    // their own CSS and are unaffected either way.
    this.container.style.pointerEvents = "none";
    // Idempotent: a fresh page load's container is already empty, so this
    // is a no-op there. It matters when a new Game instance is built into
    // the *same*, persisting DOM — the dev preview's in-place reload after
    // a Save (see index.html/main.ts) never navigates, so without
    // this every save-triggered rebuild would stack a second full set of
    // wrappers (score, drag-hint, cta-button, endcard-title, ...) on top of
    // whatever the previous Game instance already built here.
    this.container.innerHTML = "";

    this.canvasWidth = data.canvasWidth;
    this.canvasHeight = data.canvasHeight;

    // Two passes so a "group" element's own node exists before any child
    // that references it as `parentId` needs to be appended into it —
    // order in the JSON array isn't guaranteed to put parents first.
    const sorted = [...data.elements].sort((a, b) => a.zIndex - b.zIndex);
    const nodesById = new Map<string, { wrapper: HTMLElement; content: HTMLElement }>();
    for (const el of sorted) {
      nodesById.set(el.id, this.buildElement(el));
    }
    // Append order uses zOrder, not zIndex/array order — it's the DOM-order
    // tie-breaker for touch/pointer hit-priority among elements that share
    // the same renderOrder (see UIElementData.zOrder's doc comment). Visual
    // stacking itself is unaffected either way: it's driven by the CSS
    // z-index buildElement already set from renderOrder, independent of
    // where in the DOM each node actually landed.
    const appendOrder = [...data.elements].sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
    for (const el of appendOrder) {
      const { wrapper, content } = nodesById.get(el.id)!;
      const parent = el.parentId ? nodesById.get(el.parentId)?.content : undefined;
      (parent ?? this.container).appendChild(wrapper);
      this.elements.set(el.name, content);
    }

    this.updateScale(this.container.getBoundingClientRect().width, this.container.getBoundingClientRect().height);
  }

  /**
   * Re-derives every element's geometry for the container's current real
   * size — call after anything that might change it (window resize, MRAID
   * ready/sizeChange, the dev device-frame simulator's own resizeTo — see
   * Game.ts's handleResize/resizeTo, which already do).
   *
   * Takes the target width/height explicitly rather than re-measuring
   * `container.getBoundingClientRect()` itself — deliberately, not for
   * consistency's sake alone: `#device-frame` (the dev device-frame
   * simulator's letterboxed box, `#custom-ui-layer`'s real containing
   * block there — see index.html) animates its own width/height
   * over a 150ms CSS transition. Measuring the DOM synchronously, in the
   * same tick `resizeTo()` sets the new target size, reads the box
   * *before* that transition has moved at all — capturing and baking in
   * the stale pre-resize size permanently, since nothing re-measures it
   * again once the transition actually finishes. Every caller already
   * has (or already computed) the real target size on hand — Game.ts's
   * resizeTo(width, height) directly, handleResize() from
   * window.innerWidth/innerHeight — so there's no reason to re-derive it
   * from a DOM read that can be caught mid-transition.
   */
  updateScale(width: number, height: number): void {
    if (width <= 0 || height <= 0) return; // not laid out yet (e.g. a hidden container) — the next real resize call will supply real numbers
    this.scaleX = width / this.canvasWidth;
    this.scaleY = height / this.canvasHeight;
    this.liveHeight = height;
    for (const { data, wrapper } of this.geometryElements) {
      this.applyGeometry(data, wrapper);
    }
    for (const { data, node } of this.textNodes) {
      this.applyFontSize(data, node);
    }
  }

  /** Sets an element's left/top/width/height/transform for the current live size — called for every element both from updateScale() (after a resize) and once at construction time (via the constructor's own initial updateScale() call). Mirrors tools/ui-editor.html's renderCanvas() geometry block exactly. */
  private applyGeometry(data: UIElementData, wrapper: HTMLElement): void {
    const px = this.pxScale();

    // For position, it's an offset from the anchor's OWN point — not always
    // the container's top-left. The anchor's point is itself a fraction of
    // the container (ANCHOR_FRAC), expressed as a % so it still tracks the
    // live container size correctly; the px part is just the fixed nudge
    // away from it. So middle-center + (0,0) sits exactly at the true
    // center on any screen shape (0 offset from a point that's always 50%
    // across); bottom-left + (32,32) sits 32px in from that corner, same as
    // the real joystick-base's hardcoded `left: 32px; bottom: 32px`. This
    // mirrors Unity's anchoredPosition, where the offset is always relative
    // to the anchor, not a fixed page origin.
    // A positive offset always means "inward, toward center" regardless of
    // which side the anchor is on — matching CSS's own left/right and
    // top/bottom conventions (bottom: 32px moves an element UP from the
    // bottom edge, even though `top` and `bottom` count in opposite
    // directions). Since every anchor here is placed via `left`/`top`
    // specifically, an anchor on the far edge (right/bottom, frac 1) needs
    // its offset flipped to negative to move inward the same way.
    const originX = ANCHOR_FRAC[data.anchor].x * 100;
    const originY = ANCHOR_FRAC[data.anchor].y * 100;
    const signX = ANCHOR_FRAC[data.anchor].x === 1 ? -1 : 1;
    const signY = ANCHOR_FRAC[data.anchor].y === 1 ? -1 : 1;
    wrapper.style.left = data.xUnit === "px" ? `calc(${originX}% + ${signX * (data.xPx ?? 0) * px}px)` : `${data.xPct}%`;
    wrapper.style.top = data.yUnit === "px" ? `calc(${originY}% + ${signY * (data.yPx ?? 0) * px}px)` : `${data.yPct}%`;
    wrapper.style.width = data.widthUnit === "px" ? `${(data.widthPx ?? 0) * px}px` : `${data.widthPct}%`;
    if (needsLockedAspect(data)) {
      wrapper.style.aspectRatio = `${data.aspectRatio ?? 1}`;
      wrapper.style.height = "auto";
    } else if (data.heightUnit === "px") {
      wrapper.style.height = `${(data.heightPx ?? 0) * px}px`;
    } else {
      wrapper.style.height = `${data.heightPct}%`;
    }
    wrapper.style.transform = `${ANCHOR_TRANSFORM[data.anchor]} rotate(${data.rotation}deg)`;
  }

  /** `fontSizePct`% of the container's current real height, as a literal px value — mirrors tools/ui-editor.html's own text font-size formula exactly (there: `fontSizePct * (canvasEl's real height / 100)`). */
  private applyFontSize(data: UIElementData, node: HTMLElement): void {
    node.style.fontSize = `${((data.fontSizePct ?? 4) / 100) * this.liveHeight}px`;
  }

  // ─── GEOMETRY:BEGIN ───
  // Pure-number twins of applyGeometry()'s own calc()-string geometry and
  // applyFontSize()'s own font-size formula, additive only (neither of
  // those two methods is touched or called from here) — this fence and
  // tests/geometry-parity.test.mjs are what make ENGINE.md's "these
  // formulas are written to be identical to tools/ui-editor.html's own
  // pxScale()/elemScreenWidth()/elemScreenHeight()/elemScreenX()/
  // elemScreenY()/renderCanvas() geometry and its text font-size formula"
  // claim mechanically enforced instead of just asserted in prose. Written
  // to mirror each side's REAL existing formula exactly, operator for
  // operator and operation-order for operation-order — not a rewritten
  // "equivalent" version — so a genuine divergence between the two files
  // shows up here instead of being normalized away. If you change the
  // *meaning* of any formula in this fence, change tools/ui-editor.html's
  // matching GEOMETRY fence in the same commit, or this suite fails on
  // purpose.

  /**
   * The one, uniform design-space-px -> live-screen-px factor for EVERY px
   * field — mirrors tools/ui-editor.html's own pxScale() exactly (see its
   * doc comment there, and applyGeometry()'s own doc comment above, for
   * the full reasoning).
   */
  private pxScale(): number {
    return Math.min(this.scaleX, this.scaleY);
  }

  /** Mirrors tools/ui-editor.html's elemScreenWidth() exactly. */
  private elemScreenWidth(d: UIElementData, rectW: number): number {
    return d.widthUnit === "px" ? (d.widthPx ?? 0) * this.pxScale() : (d.widthPct / 100) * rectW;
  }

  /** Mirrors tools/ui-editor.html's elemScreenHeight() exactly. */
  private elemScreenHeight(d: UIElementData, rectW: number, rectH: number): number {
    if (needsLockedAspect(d)) return this.elemScreenWidth(d, rectW) / visualAspectRatio(d);
    return d.heightUnit === "px" ? (d.heightPx ?? 0) * this.pxScale() : (d.heightPct / 100) * rectH;
  }

  /** Mirrors tools/ui-editor.html's pxSignX() exactly. */
  private pxSignX(d: UIElementData): number {
    return ANCHOR_FRAC[d.anchor].x === 1 ? -1 : 1;
  }

  /** Mirrors tools/ui-editor.html's pxSignY() exactly. */
  private pxSignY(d: UIElementData): number {
    return ANCHOR_FRAC[d.anchor].y === 1 ? -1 : 1;
  }

  /** Mirrors tools/ui-editor.html's elemScreenX() exactly. */
  private elemScreenX(d: UIElementData, rectW: number): number {
    return d.xUnit === "px" ? ANCHOR_FRAC[d.anchor].x * rectW + this.pxSignX(d) * (d.xPx ?? 0) * this.pxScale() : (d.xPct / 100) * rectW;
  }

  /** Mirrors tools/ui-editor.html's elemScreenY() exactly. */
  private elemScreenY(d: UIElementData, rectH: number): number {
    return d.yUnit === "px" ? ANCHOR_FRAC[d.anchor].y * rectH + this.pxSignY(d) * (d.yPx ?? 0) * this.pxScale() : (d.yPct / 100) * rectH;
  }

  /**
   * Mirrors applyFontSize()'s own formula exactly, operation-order
   * included — NOT tools/ui-editor.html's inline font-size line (that one
   * is a real, deliberately-uncorrected divergence: it defaults a falsy
   * `fontSizePct` (including an explicit `0`) to 4, this one only
   * defaults a missing one (`?? `) — see tests/geometry-parity.test.mjs's
   * own findings if that's ever resolved.
   */
  private elemFontSizePx(d: UIElementData, liveH: number): number {
    return ((d.fontSizePct ?? 4) / 100) * liveH;
  }
  // ─── GEOMETRY:END ───

  /**
   * Test-only seam (tests/lib/geometry-source.mjs) — bound pure functions
   * for every formula in the GEOMETRY fence above, so a Node test can call
   * them without constructing a real UILayout (which needs a live
   * `HTMLElement` container and touches `document`). Additive: nothing
   * above is changed to support this, and nothing else in this class
   * calls it.
   */
  public __geometry() {
    return {
      pxScale: () => this.pxScale(),
      elemScreenWidth: (d: UIElementData, rectW: number) => this.elemScreenWidth(d, rectW),
      elemScreenHeight: (d: UIElementData, rectW: number, rectH: number) => this.elemScreenHeight(d, rectW, rectH),
      pxSignX: (d: UIElementData) => this.pxSignX(d),
      pxSignY: (d: UIElementData) => this.pxSignY(d),
      elemScreenX: (d: UIElementData, rectW: number) => this.elemScreenX(d, rectW),
      elemScreenY: (d: UIElementData, rectH: number) => this.elemScreenY(d, rectH),
      elemFontSizePx: (d: UIElementData, liveH: number) => this.elemFontSizePx(d, liveH),
    };
  }

  /** Look up a placed element's content node by the `name` you gave it in the editor. */
  get(name: string): HTMLElement | undefined {
    return this.elements.get(name);
  }

  /** Show or hide every element this instance placed, as one group (e.g. toggling a whole end-card layout on/off). Individual elements' own `visible`/show()/hide() state is preserved underneath and takes effect again once this is set back to true. */
  setVisible(visible: boolean): void {
    this.container.style.display = visible ? "" : "none";
  }

  /**
   * For a "joystick"-type element: the draggable base and the knob that
   * should visually follow the touch, for wiring real input (see
   * DynamicJoystick) to a designed joystick instead of a hardcoded one. The
   * knob returned is a plain, untransformed node nested inside the
   * centering anchor built in buildContent — DynamicJoystick can set its
   * `transform` directly on every move without needing to know about (or
   * fight) the centering, the same way it always has.
   */
  getJoystick(name: string): { base: HTMLElement; knob: HTMLElement } | undefined {
    const base = this.elements.get(name);
    if (!base) return undefined;
    const knob = base.querySelector<HTMLElement>('[data-role="joystick-knob"]');
    if (!knob) return undefined;
    return { base, knob };
  }

  /** Swap an image element's source at runtime (e.g. a dynamic badge or icon). */
  setImage(name: string, src: string): void {
    const node = this.elements.get(name);
    if (node instanceof HTMLImageElement) node.src = src;
  }

  /** Update a text element's content at runtime. */
  setText(name: string, text: string): void {
    const node = this.elements.get(name);
    if (node) node.textContent = text;
  }

  show(name: string): void {
    const node = this.elements.get(name);
    if (node) node.style.display = "";
  }

  hide(name: string): void {
    const node = this.elements.get(name);
    if (node) node.style.display = "none";
  }

  /**
   * Opt an element into receiving pointer events, either by name (a
   * designed button not bound to a field) or by passing the element
   * itself directly — the latter is what a Scripts-panel-bound field
   * already holds (see Bindings.ts): `this.endcard.setInteractive(this.someButton, handler)`.
   * Style/pointer-events are set here either way (idempotent alongside
   * the editor's "🖱 Interactable" toggle, which does the same thing at
   * render time — see buildElement) so this always works even if that
   * toggle was left off. No-op if the name doesn't resolve or the
   * element is undefined (nothing assigned in the editor yet).
   */
  setInteractive(nameOrElement: string | HTMLElement | undefined, onClick?: () => void): void {
    const node = typeof nameOrElement === "string" ? this.elements.get(nameOrElement) : nameOrElement;
    if (!node) return;
    node.style.pointerEvents = "auto";
    node.style.cursor = "pointer";
    if (onClick) node.addEventListener("click", onClick);
  }

  /**
   * Two nodes per element: `wrapper` carries position/anchor/rotation (a
   * static transform), `content` carries the animation transform (scale/
   * translate/rotate keyframes). Keeping them separate means an animation
   * never clobbers the anchor placement — a CSS animation's `transform`
   * replaces the element's whole transform each frame, so animating the
   * same node that positions the element would fight the anchor offset.
   */
  private buildElement(data: UIElementData): { wrapper: HTMLElement; content: HTMLElement } {
    const wrapper = document.createElement("div");
    wrapper.style.position = "absolute";
    wrapper.style.opacity = `${data.opacity}`;
    // renderOrder is the real visual-stacking value; fall back to zIndex for
    // layouts saved before renderOrder existed (see its doc comment).
    wrapper.style.zIndex = `${data.renderOrder ?? data.zIndex}`;
    wrapper.style.pointerEvents = "none";
    // Position/size aren't set here — the constructor's own updateScale()
    // call, right after every element is built, applies the real
    // first-ever geometry via applyGeometry() (see geometryElements).
    this.geometryElements.push({ data, wrapper });

    const content = this.buildContent(data);
    content.style.width = "100%";
    content.style.height = "100%";
    if (data.visible === false) content.style.display = "none";
    if (data.animation && data.animation !== "none") {
      content.style.animation = ANIMATION_CSS[data.animation];
    }
    // Same two style writes setInteractive(name, ...) makes by hand below
    // — baked in at render time instead for anything the editor's
    // Properties panel marked interactive, so a class binding this
    // element via the Scripts panel only ever needs UILayout.onClick(...)
    // to add the actual handler, no per-element style boilerplate.
    if (data.interactive) {
      content.style.pointerEvents = "auto";
      content.style.cursor = "pointer";
    }
    wrapper.appendChild(content);

    return { wrapper, content };
  }

  private buildContent(data: UIElementData): HTMLElement {
    if (data.type === "group") {
      // A group has no visual content of its own by default — it exists so
      // nested elements can be positioned/sized relative to *it* (via
      // parentId) instead of the canvas, and moved/resized together as one
      // unit. `position: relative` here is what makes that work: it's the
      // containing block every nested child's own `position: absolute` +
      // percentage geometry resolves against, exactly like the canvas
      // itself does at the top level.
      const group = document.createElement("div");
      group.style.position = "relative";
      group.style.boxSizing = "border-box";
      if (data.backgroundColor) group.style.backgroundColor = data.backgroundColor;
      const radius = data.borderRadiusPct ?? 0;
      if (radius) group.style.borderRadius = radius >= 50 ? "9999px" : `${radius}%`;
      if (data.borderWidthPx) group.style.border = `${data.borderWidthPx}px solid ${data.borderColor ?? "#ffffff"}`;
      return group;
    }

    if (data.type === "image") {
      const img = document.createElement("img");
      img.src = data.src ?? "";
      img.style.objectFit = "contain";
      img.draggable = false;
      return img;
    }

    if (data.type === "rect") {
      const rect = document.createElement("div");
      rect.style.boxSizing = "border-box";
      rect.style.backgroundColor = data.backgroundColor ?? "rgba(0,0,0,0.3)";
      const radius = data.borderRadiusPct ?? 0;
      rect.style.borderRadius = radius >= 50 ? "9999px" : `${radius}%`;
      if (data.borderWidthPx) rect.style.border = `${data.borderWidthPx}px solid ${data.borderColor ?? "#ffffff"}`;
      return rect;
    }

    if (data.type === "joystick") {
      const base = document.createElement("div");
      base.style.boxSizing = "border-box";
      base.style.position = "relative";
      base.style.borderRadius = "50%";
      base.style.backgroundColor = data.baseColor ?? "rgba(255,255,255,0.22)";
      base.style.border = "2px solid rgba(255,255,255,0.6)";
      // Harmless whether or not this element itself ends up receiving
      // pointer events — DynamicJoystick actually tracks the drag on its
      // own full-screen catcher (which sets this too), not on `base`
      // directly, but a stray scroll/zoom gesture starting here is still
      // worth suppressing on principle.
      base.style.touchAction = "none";

      // The knob's centering (left/top 50% + translate -50%,-50%) lives on
      // this static anchor, never touched again after creation.
      // DynamicJoystick sets `transform` directly on the *inner* knob for
      // every move — if it set transform on this centered node instead,
      // each update would wipe out the centering along with it (a CSS
      // transform assignment replaces the whole property, it doesn't
      // compose with what was there before).
      const knobAnchor = document.createElement("div");
      const knobSize = data.knobSizePct ?? 45;
      knobAnchor.style.position = "absolute";
      knobAnchor.style.left = "50%";
      knobAnchor.style.top = "50%";
      knobAnchor.style.transform = "translate(-50%, -50%)";
      knobAnchor.style.width = `${knobSize}%`;
      knobAnchor.style.height = `${knobSize}%`;

      const knob = document.createElement("div");
      knob.dataset.role = "joystick-knob";
      knob.style.width = "100%";
      knob.style.height = "100%";
      knob.style.borderRadius = "50%";
      knob.style.backgroundColor = data.knobColor ?? "rgba(255,255,255,0.9)";
      knobAnchor.appendChild(knob);
      base.appendChild(knobAnchor);
      return base;
    }

    const text = document.createElement("div");
    text.textContent = data.text ?? "";
    text.style.display = "flex";
    text.style.alignItems = "center";
    text.style.color = data.color ?? "#ffffff";
    text.style.fontWeight = data.fontWeight ?? "700";
    text.style.textAlign = data.textAlign ?? "left";
    text.style.justifyContent = data.textAlign === "center" ? "center" : data.textAlign === "right" ? "flex-end" : "flex-start";
    text.style.whiteSpace = "pre-wrap";
    text.style.overflow = "hidden";
    text.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    // Font-size isn't set here — it depends on the container's current
    // real height, which isn't known yet this early (see applyFontSize,
    // called for every text node from the constructor's own initial
    // updateScale() call, same timing as applyGeometry above).
    this.textNodes.push({ data, node: text });
    return text;
  }
}
