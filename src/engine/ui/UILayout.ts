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

/** Where each anchor preset's own point sits in the container, as a fraction of its width/height — the origin PX position offsets from (see buildElement). */
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

/** Mirrors tools/ui-editor.html's needsLockedAspect() — a joystick is always locked. */
function needsLockedAspect(data: UIElementData): boolean {
  return data.type === "joystick" || data.lockAspect === true;
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
 */
export class UILayout {
  /** Maps a placed element's name to its content node (the img/text/rect/joystick — not the positioning wrapper). */
  private readonly elements = new Map<string, HTMLElement>();

  constructor(private readonly container: HTMLElement, data: UILayoutData) {
    ensureKeyframes();
    // Position/inset are the caller's responsibility via CSS, not forced
    // here — an inline style always wins over a stylesheet rule, so
    // hardcoding "fixed" would silently override a container meant to sit
    // relative to something other than the real viewport (e.g. the dev
    // device-frame simulator's letterboxed box in public/index.html).
    // Production's #custom-ui-layer/#endcard-layer use position:fixed in
    // their own CSS and are unaffected either way.
    this.container.style.pointerEvents = "none";
    // Idempotent: a fresh page load's container is already empty, so this
    // is a no-op there. It matters when a new Game instance is built into
    // the *same*, persisting DOM — the dev preview's in-place reload after
    // a Save (see public/index.html/main.ts) never navigates, so without
    // this every save-triggered rebuild would stack a second full set of
    // wrappers (score, drag-hint, cta-button, endcard-title, ...) on top of
    // whatever the previous Game instance already built here.
    this.container.innerHTML = "";

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

  /** Opt a specific element into receiving pointer events (e.g. a designed button). */
  setInteractive(name: string, onClick?: () => void): void {
    const node = this.elements.get(name);
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
    // "px" is a literal, unscaled CSS px value — same real size/margin on
    // every device, never derived from container %. For size, that's what
    // stops a locked-aspect element (e.g. the joystick) from ballooning.
    //
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
    wrapper.style.left = data.xUnit === "px" ? `calc(${originX}% + ${signX * (data.xPx ?? 0)}px)` : `${data.xPct}%`;
    wrapper.style.top = data.yUnit === "px" ? `calc(${originY}% + ${signY * (data.yPx ?? 0)}px)` : `${data.yPct}%`;
    wrapper.style.width = data.widthUnit === "px" ? `${data.widthPx ?? 0}px` : `${data.widthPct}%`;
    if (needsLockedAspect(data)) {
      wrapper.style.aspectRatio = `${data.aspectRatio ?? 1}`;
      wrapper.style.height = "auto";
    } else if (data.heightUnit === "px") {
      wrapper.style.height = `${data.heightPx ?? 0}px`;
    } else {
      wrapper.style.height = `${data.heightPct}%`;
    }
    wrapper.style.opacity = `${data.opacity}`;
    // renderOrder is the real visual-stacking value; fall back to zIndex for
    // layouts saved before renderOrder existed (see its doc comment).
    wrapper.style.zIndex = `${data.renderOrder ?? data.zIndex}`;
    wrapper.style.transform = `${ANCHOR_TRANSFORM[data.anchor]} rotate(${data.rotation}deg)`;
    wrapper.style.pointerEvents = "none";

    const content = this.buildContent(data);
    content.style.width = "100%";
    content.style.height = "100%";
    if (data.visible === false) content.style.display = "none";
    if (data.animation && data.animation !== "none") {
      content.style.animation = ANIMATION_CSS[data.animation];
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
    text.style.fontSize = `${data.fontSizePct ?? 4}vh`;
    text.style.color = data.color ?? "#ffffff";
    text.style.fontWeight = data.fontWeight ?? "700";
    text.style.textAlign = data.textAlign ?? "left";
    text.style.justifyContent = data.textAlign === "center" ? "center" : data.textAlign === "right" ? "flex-end" : "flex-start";
    text.style.whiteSpace = "pre-wrap";
    text.style.overflow = "hidden";
    text.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    return text;
  }
}
