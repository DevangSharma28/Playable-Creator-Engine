/**
 * Data schema for a designed UI layout (tools/ui-editor.html produces
 * exactly this shape; UILayout.ts consumes it). Keeping this in one file
 * that both "sides" conceptually follow means the editor's live preview
 * and the actual in-game render always match pixel-for-pixel.
 *
 * Everything is percentage-based (0-100) relative to a reference canvas
 * size, never fixed pixels — so a layout designed at 400x711 still looks
 * right on a 1200x2133 phone. This is the same idea as Unity's
 * RectTransform anchors.
 */

export type AnchorPreset =
  | "top-left"
  | "top-center"
  | "top-right"
  | "middle-left"
  | "middle-center"
  | "middle-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type UIElementType = "image" | "text" | "rect" | "joystick" | "group";

export type UIAnimation = "none" | "pulse" | "bob" | "spin" | "fadeIn";

/**
 * "pct" (default): tracks this axis's own current size, like a Unity
 * anchor — the correct choice for anything that should stay proportionally
 * placed or centered on any screen shape.
 *
 * "px": a literal, unscaled CSS px value — same real size on every device,
 * never stretches. For size, that's what stops a locked-aspect element
 * (e.g. the joystick) from ballooning. For position, it's an offset from
 * the *anchor's own point*, not always the container's top-left — mirrors
 * Unity's anchoredPosition. A middle-center anchor's point is the true
 * center (50%, 50%) regardless of screen shape, so xPx/yPx: 0 sits exactly
 * there on any device. A corner anchor's point is that corner, so
 * bottom-left + xPx/yPx: 32 sits 32px in from it — matching the real
 * joystick-base's hardcoded `left: 32px; bottom: 32px` in
 * public/index.html. "%" remains correct for stretchy/proportional sizing
 * either way; it's unaffected by any of this.
 *
 * Defaults to "pct" when absent.
 */
export type MeasureUnit = "pct" | "px";

export interface UIElementData {
  id: string;
  type: UIElementType;
  /** Human label — shown in the editor's layer list and used for UILayout.get(name). */
  name: string;
  /**
   * id of a "group"-type element this one is nested inside, if any (absent = top-level,
   * positioned relative to the canvas). Every geometry field below (xPct, anchor, etc.)
   * is then relative to the *parent group's* box instead of the canvas — moving or
   * resizing a group therefore moves/scales everything nested inside it, the same way
   * Unity's RectTransform parenting or a Figma frame works. Set by the editor's
   * "Group Selected" / "Ungroup" actions, not hand-edited.
   */
  parentId?: string;

  /** Position of the anchor point, as % of canvas width/height (0-100). Used when xUnit/yUnit is "pct" (the default). */
  xPct: number;
  yPct: number;
  /** Element size, as % of canvas width/height (0-100). Used when widthUnit/heightUnit is "pct" (the default). */
  widthPct: number;
  heightPct: number;
  /** Literal, unscaled CSS px — used instead of the *Pct field when the matching *Unit is "px". */
  xPx?: number;
  yPx?: number;
  widthPx?: number;
  heightPx?: number;
  xUnit?: MeasureUnit;
  yUnit?: MeasureUnit;
  widthUnit?: MeasureUnit;
  heightUnit?: MeasureUnit;

  /** Which point *within the element's own box* sits at (xPct, yPct). */
  anchor: AnchorPreset;

  rotation: number; // degrees
  opacity: number; // 0-1
  zIndex: number;
  /**
   * Visual stacking order — the actual CSS z-index applied at render (see
   * UILayout.ts's buildElement). A float, not an int: the editor seeds it
   * at 0 for the first element placed and +0.1 for each one after (see
   * tools/ui-editor.html's nextRenderOrder), so inserting between two
   * existing elements never forces renumbering everything above it, the
   * way a plain integer counter would. Falls back to zIndex when absent,
   * for layouts saved before this field existed. zIndex itself keeps its
   * other job — list/array order (layers panel, two-pass DOM build,
   * group-selection bounding-box math) — independent of this.
   */
  renderOrder?: number;
  /**
   * Touch/pointer hit-priority — independent of renderOrder. CSS z-index
   * governs both paint order *and* which element wins a click where two
   * overlap; this is the tie-breaker specifically for elements that share
   * the same renderOrder, controlling DOM append order (see UILayout.ts's
   * constructor) rather than the z-index itself, since decoupling touch
   * routing from paint order entirely isn't possible with native browser
   * hit-testing. Defaults to 0.
   */
  zOrder?: number;
  /** Hidden at game start when false; toggle at runtime via UILayout.show()/hide(). */
  visible?: boolean;
  animation?: UIAnimation;
  /**
   * Makes this element clickable at render time — sets pointer-events:auto
   * and cursor:pointer automatically (see UILayout.ts's buildElement), so
   * a class binding it via the Scripts panel just needs
   * `UILayout.onClick(this.field, handler)`, no manual style/listener
   * boilerplate per element. Off by default like every other UI element
   * (most aren't buttons) — toggle it in the editor's Properties panel.
   */
  interactive?: boolean;

  /** Keep widthPct/heightPct's on-screen ratio fixed across canvas/device shapes. Always true for "joystick". */
  lockAspect?: boolean;
  /** Fixed ratio (real screen pixels) applied when lockAspect is set — captured once, not re-derived on render. */
  aspectRatio?: number;

  /** data: URI — images are embedded directly so the layout JSON is self-contained. */
  src?: string;

  text?: string;
  /** Font size as a percentage of canvas *height* — maps directly to a `vh` unit at runtime. */
  fontSizePct?: number;
  color?: string;
  fontWeight?: string;
  textAlign?: "left" | "center" | "right";

  /** "rect" fields — also reused by "group" for an optional visible frame/background around its contents (defaults to fully transparent/borderless, i.e. a purely organizational group). */
  backgroundColor?: string;
  borderRadiusPct?: number;
  borderWidthPx?: number;
  borderColor?: string;

  /** "joystick" fields */
  baseColor?: string;
  knobColor?: string;
  knobSizePct?: number;
}

export interface UILayoutData {
  version: number;
  /** Reference design resolution used while placing elements in the editor. Purely informational at runtime. */
  canvasWidth: number;
  canvasHeight: number;
  elements: UIElementData[];
}

export const EMPTY_LAYOUT: UILayoutData = {
  version: 1,
  canvasWidth: 400,
  canvasHeight: 711,
  elements: [],
};
