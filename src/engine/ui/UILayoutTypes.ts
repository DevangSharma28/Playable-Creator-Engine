/**
 * Data schema for a designed UI layout (tools/ui-editor.html produces
 * exactly this shape; UILayout.ts consumes it). Keeping this in one file
 * that both "sides" conceptually follow means the editor's live preview
 * and the actual in-game render always match pixel-for-pixel.
 *
 * Geometry is anchor + unit based (see MeasureUnit) relative to a fixed
 * design resolution, never raw device pixels — so a layout designed at
 * 400x711 still looks right on a 1200x2133 phone. Same idea as Unity's
 * RectTransform anchors.
 *
 * BACKWARD COMPATIBILITY RULE: every field added after v1 is optional and
 * must have a runtime default that reproduces pre-field behavior exactly.
 * A layout saved by an older editor has to keep rendering identically —
 * there is no migration step anywhere in the pipeline, layouts are read
 * straight out of JSON at boot (see Game.ts's mainLayoutRaw import).
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

/**
 * The original five types are unchanged. Everything after them was added
 * for the "professional UI builder" pass — each one exists in BOTH
 * tools/ui-editor.html's renderCanvas() and UILayout.ts's buildContent(),
 * because an element the editor can author but the runtime can't render
 * is exactly the editor-only/runtime-only split the architecture forbids.
 *
 * Deliberately NOT here, because they're better expressed as fields on the
 * types that already exist:
 *   - "mask"     -> `clipContent` on a group (a mask IS a clipping group)
 *   - "gradient" -> `fillType`/`gradient` on any box-ish element
 *   - "panel"    -> a group with a backgroundColor (already possible)
 *   - "container"-> a group (already possible)
 * Adding a distinct type for each would have meant four more render
 * branches that produce markup already reachable another way.
 */
export type UIElementType =
  | "image"
  | "text"
  | "rect"
  | "joystick"
  | "group"
  | "button"
  | "progress"
  | "slider"
  | "toggle"
  | "checkbox"
  | "sprite"
  | "video"
  | "shape"
  | "icon";

export type UIAnimation = "none" | "pulse" | "bob" | "spin" | "fadeIn" | "float" | "shake" | "popIn" | "slideInUp" | "glow";

/**
 * "pct" (default): tracks this axis's own current size, like a Unity
 * anchor — the correct choice for anything that should stay proportionally
 * placed or centered on any screen shape.
 *
 * "px": a *design-resolution* pixel value, converted to the live screen by
 * one uniform factor (see UILayout.ts's pxScale) — the same real
 * proportions on every device, never stretched per-axis. For size, that's
 * what stops a locked-aspect element (e.g. the joystick) from ballooning.
 * For position, it's an offset from the *anchor's own point*, not always
 * the container's top-left — mirrors Unity's anchoredPosition. A
 * middle-center anchor's point is the true center, so xPx/yPx: 0 sits
 * exactly there on any device. A corner anchor's point is that corner, so
 * bottom-left + xPx/yPx: 32 sits 32px in from it.
 *
 * Defaults to "pct" when absent.
 */
export type MeasureUnit = "pct" | "px";

/** How a box-ish element paints its background. "solid" (default) is the pre-gradient behavior: plain `backgroundColor`. */
export type UIFillType = "solid" | "linear" | "radial";

export interface UIGradientStop {
  /** Any CSS color. */
  color: string;
  /** 0-100, position along the gradient axis. */
  pos: number;
}

export interface UIGradient {
  /** Degrees, CSS convention (0 = to top, 90 = to right). Ignored for "radial". */
  angle: number;
  stops: UIGradientStop[];
}

/**
 * Interaction states an element can visually respond to. Only applied at
 * runtime for elements that actually receive pointer events (see
 * `interactive`, and the types that imply it like "button") — a
 * decorative element has no way to enter a hover/pressed state anyway.
 */
export type UIElementState = "hover" | "pressed" | "disabled";

/**
 * A partial visual override applied while an element is in a given state.
 * Deliberately a small, fixed set rather than "any field": these are the
 * ones that can be swapped as pure CSS on an already-built node, with no
 * geometry recomputation and no re-render — so state changes stay free at
 * runtime and can't desync from the layout pass.
 */
export interface UIStateOverride {
  backgroundColor?: string;
  color?: string;
  borderColor?: string;
  opacity?: number;
  /** Multiplier on the content node's transform, e.g. 0.96 for a press-down. */
  scale?: number;
  /** Swap an image/sprite/button-icon source for this state. */
  src?: string;
}

/**
 * What a click on an interactive element does, declared in the editor
 * instead of wired by hand in game code.
 *
 * "emit" is the escape hatch and the reason this stays engine-generic: it
 * fires a named event through the callback the game registers via
 * UILayout.onAction(), so the *engine* never learns any game's vocabulary
 * — src/game/ decides what "start-game" or "buy-skin" means. The other
 * action types are pure UI operations the runtime can carry out with no
 * game knowledge at all (show/hide another element by name, set text, open
 * the store URL through the existing Cta module).
 */
export type UIActionType = "none" | "cta" | "show" | "hide" | "toggleVisible" | "setText" | "emit";

export interface UIAction {
  type: UIActionType;
  /** Element `name` this acts on, for show/hide/toggleVisible/setText. */
  target?: string;
  /** setText's new string, or emit's event name. */
  value?: string;
}

export interface UIElementData {
  id: string;
  type: UIElementType;
  /** Human label — shown in the editor's layer list and used for UILayout.get(name). */
  name: string;
  /**
   * id of a "group"-type element this one is nested inside, if any (absent = top-level,
   * positioned relative to the canvas). Every geometry field below (xPct, anchor, etc.)
   * is then relative to the *parent group's* box instead of the canvas, so moving or
   * resizing a group moves/scales everything nested inside it, the same way Unity's
   * RectTransform parenting or a Figma frame works. Set by the editor's
   * "Group Selected" / "Ungroup" actions, not hand-edited.
   */
  parentId?: string;

  /** Position of the anchor point, as % of container width/height (0-100). Used when xUnit/yUnit is "pct" (the default). */
  xPct: number;
  yPct: number;
  /** Element size, as % of container width/height (0-100). Used when widthUnit/heightUnit is "pct" (the default). */
  widthPct: number;
  heightPct: number;
  /** Design-resolution px — used instead of the *Pct field when the matching *Unit is "px". */
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
  /** Seconds the animation waits before its first cycle. Defaults to 0. */
  animationDelay?: number;
  /** Seconds one animation cycle takes. Defaults to each animation's own designed duration. */
  animationDuration?: number;
  /**
   * Makes this element clickable at render time — sets pointer-events:auto
   * and cursor:pointer automatically (see UILayout.ts's buildElement), so
   * a class binding it via the Scripts panel just needs
   * `UILayout.setInteractive(this.field, handler)`, no manual style
   * boilerplate per element. Off by default like every other UI element
   * (most aren't buttons) — toggle it in the editor's Properties panel.
   * Implied true for "button", "slider", "toggle" and "checkbox".
   */
  interactive?: boolean;

  /**
   * EDITOR-ONLY. Blocks selection/drag on the canvas so a finished
   * background can't be grabbed by accident while working on things on top
   * of it. Deliberately has no runtime meaning whatsoever — UILayout.ts
   * never reads it — which is why it's safe for it to live in the same
   * saved JSON as everything else rather than a sidecar file.
   */
  locked?: boolean;

  /** Keep the element's on-screen ratio fixed across canvas/device shapes. Always true for "joystick". */
  lockAspect?: boolean;
  /** Fixed ratio (real screen pixels) applied when lockAspect is set — captured once, not re-derived on render. */
  aspectRatio?: number;

  /** data: URI — images are embedded directly so the layout JSON is self-contained. */
  src?: string;

  text?: string;
  /** Font size as a percentage of the container's *live height*. */
  fontSizePct?: number;
  color?: string;
  fontWeight?: string;
  textAlign?: "left" | "center" | "right";
  /** Vertical alignment inside the element's own box. Defaults to "center", which is what the pre-field flex layout always did. */
  textVerticalAlign?: "top" | "center" | "bottom";
  /** CSS font-family stack. Defaults to the system sans-serif stack. */
  fontFamily?: string;
  /** Letter spacing as a fraction of font size (0.05 = 5%). Defaults to 0. */
  letterSpacingEm?: number;
  /** Multiplier on font size. Defaults to 1.2. */
  lineHeight?: number;
  /** Uppercases the rendered text without changing the stored string. */
  uppercase?: boolean;
  /** Outline around glyphs, in design px, scaled by pxScale at runtime — heavily used on playable-ad titles over busy backgrounds. */
  textStrokeWidthPx?: number;
  textStrokeColor?: string;
  /** Drop shadow behind glyphs. Offsets/blur in design px. */
  textShadow?: { x: number; y: number; blur: number; color: string };

  /** Box fill/border — used by "rect", "group", "button", "shape", "progress", "slider", "toggle", "checkbox". */
  backgroundColor?: string;
  borderRadiusPct?: number;
  borderWidthPx?: number;
  borderColor?: string;
  /**
   * Scale `borderWidthPx` by pxScale like every other px field, instead of
   * emitting it as a literal CSS px.
   *
   * Defaults to false, which is NOT the theoretically-correct behavior —
   * it's the behavior that shipped. Borders were literal px in both this
   * renderer and the editor's preview from the start, so the two never
   * disagreed and every layout already authored was drawn against that.
   * Turning scaling on globally would visibly change borders in playables
   * that are already built. The editor sets this to true on newly-created
   * elements, so new work gets borders that scale with everything else
   * and old work keeps rendering exactly as designed.
   */
  borderScales?: boolean;
  /** "solid" (default, uses backgroundColor) | "linear" | "radial" (uses `gradient`). */
  fillType?: UIFillType;
  gradient?: UIGradient;
  /** Box shadow. Offsets/blur/spread in design px, scaled by pxScale at runtime. */
  boxShadow?: { x: number; y: number; blur: number; spread: number; color: string; inset?: boolean };
  /** CSS mix-blend-mode. Defaults to "normal". */
  blendMode?: string;

  /**
   * "group" only: clip descendants to this group's own box (plus its
   * border radius) — i.e. use the group as a mask. Off by default, which
   * is the pre-field behavior (children could overhang freely).
   */
  clipContent?: boolean;
  /**
   * "group" only, EDITOR-ONLY: collapsed in the Layers panel. No runtime
   * meaning, same reasoning as `locked`.
   */
  collapsed?: boolean;

  /** "joystick" fields */
  baseColor?: string;
  knobColor?: string;
  knobSizePct?: number;

  /** "button": an optional icon rendered beside the label. */
  iconSrc?: string;
  iconSide?: "left" | "right";
  /** "button"/"icon": icon size as a % of the element's own height. Defaults to 60. */
  iconSizePct?: number;

  /** "icon": the glyph itself (emoji or any unicode character). */
  icon?: string;

  /** "progress"/"slider": current value. Progress is 0-1; slider is in min..max. */
  value?: number;
  /** "slider" range. Default 0..1. */
  min?: number;
  max?: number;
  step?: number;
  /** "progress"/"slider": the filled portion's color, and the unfilled track behind it. */
  fillColor?: string;
  trackColor?: string;
  /** "progress" fill direction. Defaults to "lr". */
  direction?: "lr" | "rl" | "tb" | "bt";
  /** "slider": draggable handle. */
  handleColor?: string;
  handleSizePct?: number;

  /** "toggle": on/off state and its two track colors. */
  on?: boolean;
  onColor?: string;
  offColor?: string;

  /** "checkbox": checked state, the tick's color, and the box behind it. */
  checked?: boolean;
  checkColor?: string;

  /** "sprite": a spritesheet laid out as a uniform frameCols x frameRows grid over `src`. */
  frameCols?: number;
  frameRows?: number;
  /** Which frame to show when not playing (0-based, row-major). */
  frameIndex?: number;
  /** How many of the grid's cells are real frames — trailing cells in a partly-filled sheet are skipped. Defaults to frameCols * frameRows. */
  frameCount?: number;
  /** Frames per second while playing. Defaults to 12. */
  fps?: number;
  /** Animate through frames at runtime. Defaults to false (shows frameIndex only). */
  playing?: boolean;

  /** "video" playback flags. muted defaults to true — a playable ad may not autoplay with sound. */
  loop?: boolean;
  muted?: boolean;
  autoplay?: boolean;
  poster?: string;
  /** "image"/"video"/"sprite": CSS object-fit. Defaults to "contain" for image/sprite, "cover" for video. */
  objectFit?: "contain" | "cover" | "fill" | "none";

  /** "shape": which silhouette to clip the box to. */
  shape?: "circle" | "triangle" | "star" | "hexagon" | "diamond" | "pentagon" | "arrow" | "heart" | "cross";

  /** Visual overrides while hovered/pressed/disabled. Only meaningful on an element that receives pointer events. */
  states?: Partial<Record<UIElementState, UIStateOverride>>;
  /** What a click does. Runs in order; an empty/absent list means "nothing beyond whatever code bound a handler". */
  actions?: UIAction[];
}

export interface UILayoutData {
  version: number;
  /** Reference design resolution every px field on every element is measured against. */
  canvasWidth: number;
  canvasHeight: number;
  elements: UIElementData[];
  /** Free-form label shown in the editor's Load list ("hud", "endcard", ...). Editor-only. */
  tag?: string;
  /**
   * EDITOR-ONLY. The safe-area inset preview (percent of each edge) the
   * layout was authored against — ad networks and notched devices both
   * eat into the usable box. Never read at runtime; it's a guide, not a
   * constraint on where elements may actually go.
   */
  safeArea?: { top: number; right: number; bottom: number; left: number };
}

export const EMPTY_LAYOUT: UILayoutData = {
  version: 1,
  canvasWidth: 400,
  canvasHeight: 711,
  elements: [],
};

/** Types whose whole point is being clicked/dragged — `interactive` is implied for these regardless of the saved flag. */
export const IMPLICITLY_INTERACTIVE: readonly UIElementType[] = ["button", "slider", "toggle", "checkbox"];

/** Every type that paints a box background/border (and can therefore take a gradient, shadow, or radius). */
export const BOX_TYPES: readonly UIElementType[] = ["rect", "group", "button", "shape", "progress", "slider", "toggle", "checkbox"];
