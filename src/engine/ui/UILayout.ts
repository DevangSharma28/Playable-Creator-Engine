import type {
  AnchorPreset,
  UIAction,
  UIAnimation,
  UIElementData,
  UILayoutData,
  UIStateOverride,
} from "./UILayoutTypes";
import { IMPLICITLY_INTERACTIVE } from "./UILayoutTypes";

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

/**
 * Default seconds per cycle for each animation. Split out (rather than
 * baked into the shorthand below) so `animationDuration` can override a
 * single element's speed without the editor having to reconstruct the
 * whole CSS shorthand string itself.
 */
const ANIMATION_DURATION: Record<Exclude<UIAnimation, "none">, number> = {
  pulse: 1.2,
  bob: 1.6,
  spin: 2.5,
  fadeIn: 0.4,
  float: 3,
  shake: 0.6,
  popIn: 0.45,
  slideInUp: 0.5,
  glow: 1.8,
};

/** Timing function + iteration count per animation — the parts that aren't duration and aren't the keyframe name. */
const ANIMATION_TIMING: Record<Exclude<UIAnimation, "none">, string> = {
  pulse: "ease-in-out infinite",
  bob: "ease-in-out infinite",
  spin: "linear infinite",
  fadeIn: "ease-out both",
  float: "ease-in-out infinite",
  shake: "ease-in-out infinite",
  popIn: "cubic-bezier(0.34, 1.56, 0.64, 1) both",
  slideInUp: "cubic-bezier(0.22, 1, 0.36, 1) both",
  glow: "ease-in-out infinite",
};

/**
 * CSS silhouettes for the "shape" type. Percentage-based clip-path
 * polygons, so a shape stays correct at any size with no per-element
 * recomputation — the element's own box does all the sizing work.
 */
const SHAPE_CLIP: Record<NonNullable<UIElementData["shape"]>, string> = {
  circle: "circle(50% at 50% 50%)",
  triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
  star: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)",
  hexagon: "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)",
  diamond: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
  pentagon: "polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)",
  arrow: "polygon(0% 30%, 60% 30%, 60% 0%, 100% 50%, 60% 100%, 60% 70%, 0% 70%)",
  heart: "path('M 50,90 C 20,65 0,45 0,28 A 28,28 0 0 1 50,15 A 28,28 0 0 1 100,28 C 100,45 80,65 50,90 Z')",
  cross: "polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%)",
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
    @keyframes ui-anim-float { 0%, 100% { transform: translateY(0) rotate(-1.5deg); } 50% { transform: translateY(-4%) rotate(1.5deg); } }
    @keyframes ui-anim-shake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-4%); } 40% { transform: translateX(4%); } 60% { transform: translateX(-2.5%); } 80% { transform: translateX(2.5%); } }
    @keyframes ui-anim-popIn { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes ui-anim-slideInUp { from { transform: translateY(40%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes ui-anim-glow { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.35); } }
  `;
  document.head.appendChild(style);
}

/**
 * Per-(cols x rows) spritesheet keyframes, injected on demand and reused
 * across every sprite that shares the same grid.
 *
 * Pure CSS on purpose — no rAF ticker, no per-frame JS, and so nothing
 * that has to be torn down on a hot reload or that keeps running behind a
 * paused game. The trick: an absolutely-positioned sheet node sized
 * `cols*100%` x `rows*100%` inside an `overflow:hidden` window, whose
 * `left`/`top` step through whole window-widths/heights. `left`/`top`
 * percentages resolve against the *containing block* (the window), so
 * `left: -100%` is exactly one frame over — and because they're two
 * separate properties, the column and row animations compose instead of
 * fighting the way two `transform` animations on one node would.
 *
 * `steps(n)` over `0% -> -n*100%` lands on 0, -100%, ... -(n-1)*100%,
 * which is precisely the n frames that exist and never the wrapped-around
 * n-th one.
 */
const injectedSpriteGrids = new Set<string>();
function ensureSpriteKeyframes(cols: number, rows: number): void {
  const key = `${cols}x${rows}`;
  if (injectedSpriteGrids.has(key)) return;
  injectedSpriteGrids.add(key);
  const style = document.createElement("style");
  style.textContent = `
    @keyframes ui-sprite-x-${cols} { from { left: 0%; } to { left: -${cols * 100}%; } }
    @keyframes ui-sprite-y-${rows} { from { top: 0%; } to { top: -${rows * 100}%; } }
  `;
  document.head.appendChild(style);
}

/** Whether this element receives pointer events at runtime — the saved flag, plus the types whose whole purpose is being clicked. */
function isInteractive(data: UIElementData): boolean {
  return data.interactive === true || IMPLICITLY_INTERACTIVE.includes(data.type);
}

/** The value an element wants to stack by: renderOrder when present, else the legacy zIndex (see UIElementData.renderOrder). */
function effectiveOrder(d: UIElementData): number {
  return d.renderOrder ?? d.zIndex;
}

/**
 * Maps every element's stacking value onto a *contiguous integer* rank,
 * preserving relative order.
 *
 * This is not cosmetic. CSS `z-index` is defined as `auto | <integer>` —
 * a fractional value is invalid, and browsers drop invalid declarations
 * outright. The editor seeds renderOrder at 0 and steps it by 0.1 (a
 * float on purpose, so inserting between two elements never renumbers
 * everything above it), which meant every element after the first was
 * emitting `z-index: 0.1`, `0.2`, `0.3` … and getting *no z-index at
 * all*. Stacking silently fell back to DOM order, so the Properties
 * panel's "R Order" control looked like it worked only whenever DOM
 * order happened to agree with it.
 *
 * Ranking here keeps the float authoring model (which is genuinely nicer
 * to edit) while emitting something CSS will actually honor. Ties keep
 * their relative array order, so two elements sharing a renderOrder still
 * resolve by zOrder/DOM order exactly as before.
 *
 * tools/ui-editor.html has the identical function — they must stay in
 * step, or the editor preview and the shipped playable disagree about
 * what is on top.
 */
function buildStackRanks(elements: UIElementData[]): Map<string, number> {
  const ordered = elements
    .map((el, index) => ({ id: el.id, order: effectiveOrder(el), index }))
    .sort((a, b) => a.order - b.order || a.index - b.index);
  const ranks = new Map<string, number>();
  ordered.forEach((entry, rank) => ranks.set(entry.id, rank + 1));
  return ranks;
}

/**
 * Renders a UILayoutData (produced by tools/ui-editor.html) into real DOM
 * elements inside `container`. Purely decorative/presentational by
 * default — every element has `pointer-events: none` so it never steals
 * touches from the joystick or buttons underneath. Call `setInteractive()`
 * (or mark the element Interactable in the editor) if you want a specific
 * element to be clickable.
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
 *
 * DEFAULTS ARE PART OF THE CONTRACT. Every `?? fallback` in here has a
 * character-for-character twin in tools/ui-editor.html's renderCanvas().
 * They used to be `||` on the editor side, which silently diverged for
 * any *meaningfully falsy* authored value — `fontSizePct: 0` previewed as
 * 4% in the editor and rendered at 0px in the shipped playable, and the
 * same trap sat under every `|| "#color"` for an empty string. Both sides
 * are `??` now. If you add a defaulted field, add it to both files with
 * the same operator, or you have reintroduced that bug class.
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
  /**
   * Nodes carrying a px-denominated *visual* style (shadow spread, text
   * stroke, an opted-in scaling border) rather than a px geometry field.
   * Separate list from geometryElements because these live on the content
   * node, not the positioning wrapper, and because most elements have
   * none of them — walking every element on every resize to re-derive
   * styles that are almost always absent would be pure waste.
   */
  private readonly scaledStyleNodes: { data: UIElementData; node: HTMLElement }[] = [];
  /** Elements whose value drives a visual fill (progress/slider), for setValue() to update in place without a rebuild. */
  private readonly valueNodes = new Map<string, { data: UIElementData; fill: HTMLElement; handle?: HTMLElement }>();
  /** Registered handler for `emit` actions — the one seam that lets an authored button do something game-specific without the engine knowing any game's vocabulary. */
  private actionHandler: ((event: string, element: UIElementData) => void) | undefined;
  /** Every listener this instance attached to a node it built, so dispose() can drop them (and the closures over game objects they capture) on a hot reload. */
  private readonly listeners: { node: HTMLElement; type: string; fn: EventListener }[] = [];

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
    const stackRanks = buildStackRanks(data.elements);
    const nodesById = new Map<string, { wrapper: HTMLElement; content: HTMLElement }>();
    for (const el of sorted) {
      nodesById.set(el.id, this.buildElement(el, stackRanks.get(el.id) ?? 1));
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
    for (const { data, node } of this.scaledStyleNodes) {
      this.applyScaledStyles(data, node);
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

  /** `fontSizePct`% of the container's current real height, as a literal px value — mirrors tools/ui-editor.html's own text font-size formula exactly. */
  private applyFontSize(data: UIElementData, node: HTMLElement): void {
    node.style.fontSize = `${((data.fontSizePct ?? 4) / 100) * this.liveHeight}px`;
  }

  /**
   * Re-applies the px-denominated *visual* styles (shadows, text stroke,
   * an opted-in scaling border) at the current pxScale.
   *
   * `borderWidthPx` is the one field here that deliberately does NOT
   * scale by default. It shipped unscaled, both this renderer and the
   * editor's preview agreed on that, and every layout already authored
   * was drawn against it — silently multiplying every existing border by
   * the device's pxScale would change how already-shipped playables look.
   * `borderScales: true` opts in; the editor sets it on newly-created
   * elements, so new work gets the correct behavior and old work keeps
   * rendering the way it was designed.
   */
  private applyScaledStyles(data: UIElementData, node: HTMLElement): void {
    const px = this.pxScale();

    if (data.borderWidthPx) {
      const width = data.borderScales ? data.borderWidthPx * px : data.borderWidthPx;
      node.style.border = `${width}px solid ${data.borderColor ?? "#ffffff"}`;
    }

    if (data.boxShadow) {
      const s = data.boxShadow;
      node.style.boxShadow = `${s.inset ? "inset " : ""}${s.x * px}px ${s.y * px}px ${s.blur * px}px ${s.spread * px}px ${s.color}`;
    }

    if (data.textStrokeWidthPx) {
      // -webkit-text-stroke is the only cross-browser way to outline live
      // text without duplicating the node; `paint-order` keeps the stroke
      // behind the fill so a thick outline doesn't eat into the glyph.
      node.style.setProperty("-webkit-text-stroke", `${data.textStrokeWidthPx * px}px ${data.textStrokeColor ?? "#000000"}`);
      node.style.setProperty("paint-order", "stroke fill");
    }

    if (data.textShadow) {
      const t = data.textShadow;
      node.style.textShadow = `${t.x * px}px ${t.y * px}px ${t.blur * px}px ${t.color}`;
    }
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
   * included — and, since the `||`-vs-`??` divergence it used to warn
   * about here is fixed on both sides, tools/ui-editor.html's real inline
   * font-size line as well. `fontSizePct: 0` now means 0 in the editor
   * preview and 0 in the shipped playable, instead of 4 in one and 0 in
   * the other.
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
    else if (node) node.style.backgroundImage = `url(${JSON.stringify(src)})`;
  }

  /** Update a text element's content at runtime. Also covers a "button"/"icon", whose label lives in a nested node rather than the content node itself. */
  setText(name: string, text: string): void {
    const node = this.elements.get(name);
    if (!node) return;
    const label = node.querySelector<HTMLElement>('[data-role="label"]');
    if (label) label.textContent = text;
    else node.textContent = text;
  }

  /**
   * Drive a "progress" or "slider" element's fill from code — the runtime
   * half of the editor's own value field. Progress takes 0-1; a slider
   * takes a value in its authored min..max and is normalized here.
   */
  setValue(name: string, value: number): void {
    const entry = this.valueNodes.get(name);
    if (!entry) return;
    const { data, fill, handle } = entry;
    const min = data.min ?? 0;
    const max = data.max ?? 1;
    const t = data.type === "slider" ? (max === min ? 0 : (value - min) / (max - min)) : value;
    const clamped = Math.max(0, Math.min(1, t));
    data.value = value;
    this.applyFillGeometry(data, fill, handle, clamped);
  }

  /** Current value of a "progress"/"slider" element, or undefined if there's no such element. */
  getValue(name: string): number | undefined {
    return this.valueNodes.get(name)?.data.value;
  }

  /** On/off state of a "toggle" or "checkbox". */
  isOn(name: string): boolean | undefined {
    const node = this.elements.get(name);
    if (!node) return undefined;
    return node.dataset.on === "true";
  }

  /**
   * Registers the receiver for `emit` actions authored in the editor —
   * the single seam that keeps declarative UI actions from teaching the
   * engine any game's vocabulary. Everything the runtime can do on its own
   * (show/hide another element, set text, fire the CTA) is handled inside
   * runActions(); anything else arrives here as a plain event name for
   * src/game/ to interpret.
   */
  onAction(handler: (event: string, element: UIElementData) => void): void {
    this.actionHandler = handler;
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
    if (onClick) this.listen(node, "click", onClick as EventListener);
  }

  /**
   * Drops every listener this instance attached and clears the action
   * handler. Not required for correctness of the DOM itself (a rebuild
   * wipes the container's children, and their listeners with them), but
   * the closures those listeners captured reach into the *Game* — so on a
   * dev in-place reload, holding them alive holds a disposed Game alive
   * too. Same class of teardown as IonEngine's scheduler/bus/collider
   * clearing, for the same reason.
   */
  dispose(): void {
    for (const { node, type, fn } of this.listeners) node.removeEventListener(type, fn);
    this.listeners.length = 0;
    this.actionHandler = undefined;
  }

  /** addEventListener + remember it, so dispose() can take it back off again. */
  private listen(node: HTMLElement, type: string, fn: EventListener): void {
    node.addEventListener(type, fn);
    this.listeners.push({ node, type, fn });
  }

  /**
   * Two nodes per element: `wrapper` carries position/anchor/rotation (a
   * static transform), `content` carries the animation transform (scale/
   * translate/rotate keyframes). Keeping them separate means an animation
   * never clobbers the anchor placement — a CSS animation's `transform`
   * replaces the element's whole transform each frame, so animating the
   * same node that positions the element would fight the anchor offset.
   */
  private buildElement(data: UIElementData, stackRank: number): { wrapper: HTMLElement; content: HTMLElement } {
    const wrapper = document.createElement("div");
    wrapper.style.position = "absolute";
    wrapper.style.opacity = `${data.opacity}`;
    // An integer rank derived from renderOrder/zIndex, never the raw value
    // — CSS rejects a fractional z-index outright. See buildStackRanks.
    wrapper.style.zIndex = `${stackRank}`;
    wrapper.style.pointerEvents = "none";
    if (data.blendMode && data.blendMode !== "normal") wrapper.style.mixBlendMode = data.blendMode;
    // Position/size aren't set here — the constructor's own updateScale()
    // call, right after every element is built, applies the real
    // first-ever geometry via applyGeometry() (see geometryElements).
    this.geometryElements.push({ data, wrapper });

    const content = this.buildContent(data);
    content.style.width = "100%";
    content.style.height = "100%";
    if (data.visible === false) content.style.display = "none";
    if (data.animation && data.animation !== "none") {
      const duration = data.animationDuration ?? ANIMATION_DURATION[data.animation];
      const delay = data.animationDelay ?? 0;
      content.style.animation = `ui-anim-${data.animation} ${duration}s ${delay}s ${ANIMATION_TIMING[data.animation]}`;
    }
    // Same two style writes setInteractive(name, ...) makes by hand below
    // — baked in at render time instead for anything the editor's
    // Properties panel marked interactive (or any type that's inherently
    // a control), so a class binding this element via the Scripts panel
    // only ever needs UILayout.setInteractive(...) to add the actual
    // handler, no per-element style boilerplate.
    if (isInteractive(data)) {
      content.style.pointerEvents = "auto";
      content.style.cursor = "pointer";
      this.wireStates(data, content);
      this.wireActions(data, content);
    }
    wrapper.appendChild(content);

    return { wrapper, content };
  }

  /**
   * Paints an element's background/border/radius/shadow/clip — everything
   * shared by the box-ish types, in one place so a rect, a group, a
   * button and a progress track can't drift apart in how they read the
   * same fields.
   */
  private applyBoxStyle(data: UIElementData, node: HTMLElement, defaultBackground?: string): void {
    node.style.boxSizing = "border-box";

    const fill = data.fillType ?? "solid";
    if (fill !== "solid" && data.gradient && data.gradient.stops.length > 0) {
      const stops = [...data.gradient.stops].sort((a, b) => a.pos - b.pos).map((s) => `${s.color} ${s.pos}%`).join(", ");
      node.style.backgroundImage = fill === "radial" ? `radial-gradient(circle at 50% 50%, ${stops})` : `linear-gradient(${data.gradient.angle}deg, ${stops})`;
    } else {
      const background = data.backgroundColor ?? defaultBackground;
      if (background) node.style.backgroundColor = background;
    }

    const radius = data.borderRadiusPct ?? 0;
    if (radius) node.style.borderRadius = radius >= 50 ? "9999px" : `${radius}%`;

    // Border/shadow are px-denominated, so they're applied (and re-applied
    // on every resize) by applyScaledStyles instead of inline here.
    if (data.borderWidthPx || data.boxShadow) this.scaledStyleNodes.push({ data, node });

    if (data.clipContent) node.style.overflow = "hidden";
    if (data.shape && data.type === "shape") node.style.clipPath = SHAPE_CLIP[data.shape];
  }

  /** Positions a progress/slider fill (and a slider's handle) for a normalized 0-1 value. */
  private applyFillGeometry(data: UIElementData, fill: HTMLElement, handle: HTMLElement | undefined, t: number): void {
    const pct = `${t * 100}%`;
    const direction = data.direction ?? "lr";
    // Reset both axes every time — a direction change between calls would
    // otherwise leave the previous axis pinned at its old size.
    fill.style.left = "";
    fill.style.right = "";
    fill.style.top = "";
    fill.style.bottom = "";
    if (direction === "lr" || direction === "rl") {
      fill.style.width = pct;
      fill.style.height = "100%";
      if (direction === "rl") fill.style.right = "0";
      else fill.style.left = "0";
    } else {
      fill.style.width = "100%";
      fill.style.height = pct;
      if (direction === "bt") fill.style.bottom = "0";
      else fill.style.top = "0";
    }
    if (handle) handle.style.left = pct;
  }

  private buildContent(data: UIElementData): HTMLElement {
    if (data.type === "group") {
      // A group has no visual content of its own by default — it exists so
      // nested elements can be positioned/sized relative to *it* (via
      // parentId) instead of the canvas, and moved/resized together as one
      // unit. `position: relative` here is what makes that work: it's the
      // containing block every nested child's own `position: absolute` +
      // percentage geometry resolves against, exactly like the canvas
      // itself does at the top level. `clipContent` turns the same node
      // into a mask, clipping descendants to its box and radius.
      const group = document.createElement("div");
      group.style.position = "relative";
      this.applyBoxStyle(data, group);
      return group;
    }

    if (data.type === "image") {
      const img = document.createElement("img");
      img.src = data.src ?? "";
      img.style.objectFit = data.objectFit ?? "contain";
      img.draggable = false;
      return img;
    }

    if (data.type === "rect" || data.type === "shape") {
      const rect = document.createElement("div");
      this.applyBoxStyle(data, rect, data.type === "shape" ? "#ffffff" : "rgba(0,0,0,0.3)");
      return rect;
    }

    if (data.type === "video") {
      const video = document.createElement("video");
      video.src = data.src ?? "";
      if (data.poster) video.poster = data.poster;
      video.loop = data.loop ?? true;
      // Defaults chosen for the deployment target, not for the browser's
      // own defaults: a playable ad is very often loaded into a WebView
      // with no user gesture yet, where an unmuted autoplay is refused
      // outright and the video silently never starts. muted + playsInline
      // is the combination that actually plays there.
      video.muted = data.muted ?? true;
      video.autoplay = data.autoplay ?? true;
      video.playsInline = true;
      video.style.objectFit = data.objectFit ?? "cover";
      return video;
    }

    if (data.type === "sprite") {
      // See ensureSpriteKeyframes' doc comment for why this is three
      // nested nodes and a pair of left/top animations rather than one
      // node and a background-position tween.
      const cols = Math.max(1, Math.floor(data.frameCols ?? 1));
      const rows = Math.max(1, Math.floor(data.frameRows ?? 1));
      const window_ = document.createElement("div");
      window_.style.position = "relative";
      window_.style.overflow = "hidden";

      const sheet = document.createElement("div");
      sheet.dataset.role = "sprite-sheet";
      sheet.style.position = "absolute";
      sheet.style.width = `${cols * 100}%`;
      sheet.style.height = `${rows * 100}%`;
      sheet.style.backgroundImage = data.src ? `url(${JSON.stringify(data.src)})` : "";
      sheet.style.backgroundSize = "100% 100%";
      sheet.style.backgroundRepeat = "no-repeat";

      if (data.playing) {
        ensureSpriteKeyframes(cols, rows);
        const fps = data.fps ?? 12;
        const colCycle = cols / fps;
        sheet.style.animation = `ui-sprite-x-${cols} ${colCycle}s steps(${cols}) infinite, ui-sprite-y-${rows} ${colCycle * rows}s steps(${rows}) infinite`;
        sheet.style.left = "0%";
        sheet.style.top = "0%";
      } else {
        const index = Math.max(0, Math.floor(data.frameIndex ?? 0));
        const total = Math.max(1, data.frameCount ?? cols * rows);
        const frame = index % total;
        sheet.style.left = `${-(frame % cols) * 100}%`;
        sheet.style.top = `${-Math.floor(frame / cols) * 100}%`;
      }
      window_.appendChild(sheet);
      return window_;
    }

    if (data.type === "progress" || data.type === "slider") {
      const track = document.createElement("div");
      track.style.position = "relative";
      track.style.overflow = "hidden";
      this.applyBoxStyle(data, track, data.trackColor ?? "rgba(0,0,0,0.35)");
      // trackColor is the type-specific name for the same thing
      // backgroundColor means elsewhere; honor it when set so the
      // Properties panel can label the field for what it actually is.
      if (data.trackColor) track.style.backgroundColor = data.trackColor;

      const fill = document.createElement("div");
      fill.dataset.role = "fill";
      fill.style.position = "absolute";
      fill.style.backgroundColor = data.fillColor ?? "#4ade80";
      if (data.borderRadiusPct) fill.style.borderRadius = "inherit";

      let handle: HTMLElement | undefined;
      if (data.type === "slider") {
        handle = document.createElement("div");
        handle.dataset.role = "handle";
        handle.style.position = "absolute";
        handle.style.top = "50%";
        const size = data.handleSizePct ?? 140;
        handle.style.height = `${size}%`;
        handle.style.aspectRatio = "1";
        handle.style.borderRadius = "50%";
        handle.style.backgroundColor = data.handleColor ?? "#ffffff";
        handle.style.transform = "translate(-50%, -50%)";
        // A handle bigger than the track would be clipped away by the
        // track's own overflow:hidden (which the fill needs), so it sits
        // outside the clipping context rather than inside it.
        track.style.overflow = "visible";
        fill.style.overflow = "hidden";
      }

      track.appendChild(fill);
      if (handle) track.appendChild(handle);

      const min = data.min ?? 0;
      const max = data.max ?? 1;
      const raw = data.value ?? (data.type === "slider" ? min : 0);
      const t = data.type === "slider" ? (max === min ? 0 : (raw - min) / (max - min)) : raw;
      this.applyFillGeometry(data, fill, handle, Math.max(0, Math.min(1, t)));
      this.valueNodes.set(data.name, { data, fill, handle });

      if (data.type === "slider") this.wireSliderDrag(data, track, fill, handle!);
      return track;
    }

    if (data.type === "toggle") {
      const track = document.createElement("div");
      track.style.position = "relative";
      track.style.borderRadius = "9999px";
      const on = data.on ?? false;
      track.dataset.on = String(on);
      track.style.backgroundColor = on ? data.onColor ?? "#4ade80" : data.offColor ?? "rgba(255,255,255,0.25)";
      track.style.transition = "background-color 0.18s ease";

      const knob = document.createElement("div");
      knob.dataset.role = "knob";
      knob.style.position = "absolute";
      knob.style.top = "50%";
      knob.style.height = "82%";
      knob.style.aspectRatio = "1";
      knob.style.borderRadius = "50%";
      knob.style.backgroundColor = data.knobColor ?? "#ffffff";
      knob.style.left = on ? "100%" : "0%";
      knob.style.transform = on ? "translate(-105%, -50%)" : "translate(5%, -50%)";
      knob.style.transition = "left 0.18s ease, transform 0.18s ease";
      track.appendChild(knob);

      this.listen(track, "click", () => {
        const next = track.dataset.on !== "true";
        track.dataset.on = String(next);
        track.style.backgroundColor = next ? data.onColor ?? "#4ade80" : data.offColor ?? "rgba(255,255,255,0.25)";
        knob.style.left = next ? "100%" : "0%";
        knob.style.transform = next ? "translate(-105%, -50%)" : "translate(5%, -50%)";
      });
      return track;
    }

    if (data.type === "checkbox") {
      const box = document.createElement("div");
      box.style.position = "relative";
      box.style.display = "flex";
      box.style.alignItems = "center";
      box.style.justifyContent = "center";
      this.applyBoxStyle(data, box, "rgba(255,255,255,0.14)");
      const checked = data.checked ?? false;
      box.dataset.on = String(checked);

      const tick = document.createElement("div");
      tick.dataset.role = "tick";
      tick.textContent = "✓";
      tick.style.color = data.checkColor ?? "#ffffff";
      tick.style.fontWeight = "800";
      tick.style.lineHeight = "1";
      tick.style.opacity = checked ? "1" : "0";
      tick.style.transition = "opacity 0.14s ease";
      box.appendChild(tick);
      this.textNodes.push({ data, node: tick });

      this.listen(box, "click", () => {
        const next = box.dataset.on !== "true";
        box.dataset.on = String(next);
        tick.style.opacity = next ? "1" : "0";
      });
      return box;
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

    if (data.type === "button") {
      // A button is a box that centers a label (and optionally an icon)
      // — deliberately built from the same applyBoxStyle/text pieces a
      // rect and a text element already use, rather than a parallel
      // implementation, so a gradient or a radius behaves identically
      // whichever type it's authored on.
      const button = document.createElement("div");
      button.style.position = "relative";
      button.style.display = "flex";
      button.style.alignItems = "center";
      button.style.justifyContent = "center";
      button.style.gap = "0.4em";
      button.style.userSelect = "none";
      this.applyBoxStyle(data, button, "#e8961e");

      const label = this.buildTextNode(data);
      label.dataset.role = "label";
      label.style.width = "auto";
      label.style.height = "auto";
      label.style.justifyContent = "center";

      if (data.iconSrc) {
        const icon = document.createElement("img");
        icon.src = data.iconSrc;
        icon.style.height = `${data.iconSizePct ?? 60}%`;
        icon.style.objectFit = "contain";
        icon.draggable = false;
        if ((data.iconSide ?? "left") === "left") button.appendChild(icon);
        button.appendChild(label);
        if ((data.iconSide ?? "left") === "right") button.appendChild(icon);
      } else {
        button.appendChild(label);
      }
      return button;
    }

    if (data.type === "icon") {
      const icon = this.buildTextNode(data);
      icon.textContent = data.icon ?? "★";
      icon.style.justifyContent = "center";
      return icon;
    }

    return this.buildTextNode(data);
  }

  /**
   * The text node itself — shared by "text", "icon" and a "button"'s
   * label so all three read the typography fields identically.
   *
   * Font-size isn't set here: it depends on the container's current real
   * height, which isn't known this early (see applyFontSize, called for
   * every registered text node from the constructor's own initial
   * updateScale() call, same timing as applyGeometry).
   */
  private buildTextNode(data: UIElementData): HTMLElement {
    const text = document.createElement("div");
    text.textContent = data.text ?? "";
    text.style.display = "flex";
    const vAlign = data.textVerticalAlign ?? "center";
    text.style.alignItems = vAlign === "top" ? "flex-start" : vAlign === "bottom" ? "flex-end" : "center";
    text.style.color = data.color ?? "#ffffff";
    text.style.fontWeight = data.fontWeight ?? "700";
    text.style.textAlign = data.textAlign ?? "left";
    text.style.justifyContent = data.textAlign === "center" ? "center" : data.textAlign === "right" ? "flex-end" : "flex-start";
    text.style.whiteSpace = "pre-wrap";
    text.style.overflow = "hidden";
    text.style.fontFamily = data.fontFamily ?? "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    // em/unitless units, so these track font-size on their own and never
    // need recomputing on resize the way the px-denominated stroke and
    // shadow do.
    if (data.letterSpacingEm) text.style.letterSpacing = `${data.letterSpacingEm}em`;
    text.style.lineHeight = `${data.lineHeight ?? 1.2}`;
    if (data.uppercase) text.style.textTransform = "uppercase";
    this.textNodes.push({ data, node: text });
    if (data.textStrokeWidthPx || data.textShadow) this.scaledStyleNodes.push({ data, node: text });
    return text;
  }

  /**
   * Hover/press/disabled visuals for an interactive element. Applied as
   * direct style writes on the content node (not a class swap) because the
   * override values are authored data, not stylesheet-known constants —
   * and reverted by restoring the exact base values captured here at build
   * time, so a state can't permanently overwrite what the element looked
   * like.
   */
  private wireStates(data: UIElementData, node: HTMLElement): void {
    const states = data.states;
    if (!states || (!states.hover && !states.pressed && !states.disabled)) return;

    const base: UIStateOverride = {
      backgroundColor: node.style.backgroundColor,
      color: node.style.color,
      borderColor: data.borderColor,
      opacity: 1,
      scale: 1,
    };

    const apply = (override: UIStateOverride | undefined): void => {
      const o = override ?? base;
      if (o.backgroundColor !== undefined) node.style.backgroundColor = o.backgroundColor;
      if (o.color !== undefined) node.style.color = o.color;
      if (o.borderColor !== undefined && data.borderWidthPx) node.style.borderColor = o.borderColor;
      node.style.opacity = `${o.opacity ?? 1}`;
      // Composes with the animation transform rather than replacing it:
      // an animated button would otherwise snap back to its keyframe's
      // own transform the moment a state wrote here. Scale on a separate
      // custom property keeps both alive.
      node.style.setProperty("--ui-state-scale", `${o.scale ?? 1}`);
      if (o.scale !== undefined && o.scale !== 1) node.style.transform = `scale(${o.scale})`;
      else node.style.transform = "";
      if (o.src) this.swapSource(node, o.src);
    };

    if (states.disabled) {
      // Disabled is a persistent state, not a pointer response — an
      // element authored as disabled starts disabled and stops taking
      // clicks entirely.
      node.dataset.disabled = "true";
      node.style.pointerEvents = "none";
      apply(states.disabled);
      return;
    }

    if (states.hover) {
      this.listen(node, "pointerenter", () => apply(states.hover));
      this.listen(node, "pointerleave", () => apply(undefined));
    }
    if (states.pressed) {
      this.listen(node, "pointerdown", () => apply(states.pressed));
      this.listen(node, "pointerup", () => apply(states.hover ?? undefined));
      this.listen(node, "pointercancel", () => apply(undefined));
    }
  }

  /** Points an image/sprite/button-icon node at a different source, whichever of those three shapes it turns out to be. */
  private swapSource(node: HTMLElement, src: string): void {
    if (node instanceof HTMLImageElement) {
      node.src = src;
      return;
    }
    const img = node.querySelector("img");
    if (img) {
      img.src = src;
      return;
    }
    const sheet = node.querySelector<HTMLElement>('[data-role="sprite-sheet"]');
    if (sheet) sheet.style.backgroundImage = `url(${JSON.stringify(src)})`;
  }

  /** Runs an element's authored click actions, in order. */
  private wireActions(data: UIElementData, node: HTMLElement): void {
    const actions = data.actions;
    if (!actions || actions.length === 0) return;
    this.listen(node, "click", () => {
      for (const action of actions) this.runAction(action, data);
    });
  }

  private runAction(action: UIAction, source: UIElementData): void {
    switch (action.type) {
      case "show":
        if (action.target) this.show(action.target);
        break;
      case "hide":
        if (action.target) this.hide(action.target);
        break;
      case "toggleVisible": {
        if (!action.target) break;
        const node = this.elements.get(action.target);
        if (node) node.style.display = node.style.display === "none" ? "" : "none";
        break;
      }
      case "setText":
        if (action.target) this.setText(action.target, action.value ?? "");
        break;
      case "cta":
      case "emit":
        // Both route out through the same seam rather than being handled
        // here: "cta" needs the store URL the *game* was configured with
        // (see src/engine/Cta.ts, wired in Game.ts), and "emit" is
        // game-defined by definition. Neither belongs in the renderer.
        this.actionHandler?.(action.type === "cta" ? "cta" : action.value ?? "", source);
        break;
      case "none":
      default:
        break;
    }
  }

  /** Pointer-drag handling for a "slider" — updates the fill/handle live and leaves the authored value on `data` for getValue(). */
  private wireSliderDrag(data: UIElementData, track: HTMLElement, fill: HTMLElement, handle: HTMLElement): void {
    const min = data.min ?? 0;
    const max = data.max ?? 1;
    const step = data.step ?? 0;

    const setFromPointer = (clientX: number): void => {
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      let t = (clientX - rect.left) / rect.width;
      t = Math.max(0, Math.min(1, t));
      let value = min + t * (max - min);
      if (step > 0) value = Math.round(value / step) * step;
      data.value = value;
      this.applyFillGeometry(data, fill, handle, max === min ? 0 : (value - min) / (max - min));
      this.actionHandler?.(`${data.name}:change`, data);
    };

    this.listen(track, "pointerdown", ((e: PointerEvent) => {
      track.setPointerCapture(e.pointerId);
      setFromPointer(e.clientX);
    }) as EventListener);
    this.listen(track, "pointermove", ((e: PointerEvent) => {
      if (!track.hasPointerCapture(e.pointerId)) return;
      setFromPointer(e.clientX);
    }) as EventListener);
    this.listen(track, "pointerup", ((e: PointerEvent) => {
      if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
    }) as EventListener);
  }
}
