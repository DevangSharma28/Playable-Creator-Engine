import * as THREE from "three";

/** Matches the renderer's own cap elsewhere in the engine — a 3x-DPR phone would otherwise render 9x the pixels for no visible gain. */
const MAX_PIXEL_RATIO = 2;

/**
 * Owns "how big is the editor's 3D view, and what projection makes that
 * box look undistorted" — nothing else.
 *
 * This is the fix for the viewport-stretching bug. The old freecam took a
 * `camera.clone()` of the gameplay camera and never touched its `aspect`
 * again: `CameraHandler.handleResize()` is the only code in the engine
 * that writes `.aspect`, and it holds the *gameplay* camera exclusively.
 * So the editor camera kept whatever aspect the gameplay camera happened
 * to have at the instant it was cloned — which, entering the editor from a
 * Portrait or Landscape device preview, is a letterboxed 9:16 or 16:9
 * ratio being projected into a full-width editor viewport. The scene came
 * out visibly stretched, and resizing the window never corrected it.
 *
 * Two rules keep it fixed:
 *  - **The container is the only source of truth for size.** Sizes arrive
 *    from a real measurement of the element the canvas actually lives in
 *    (see EditorResizeManager's ResizeObserver), never from
 *    `window.innerWidth`, never from a size someone *intends* the box to
 *    become. A CSS transition, a dragged panel divider, and a device-frame
 *    mode switch all land here identically, after the fact, at the box's
 *    real final size.
 *  - **Projection follows the box; the world never scales.** Only the
 *    camera's projection is recomputed (`aspect` for perspective, frustum
 *    bounds for orthographic) — no object transform, no scene-level scale,
 *    no renderer style hack. World coordinates and camera framing are left
 *    exactly as they were, so an object at (3, 0, -2) stays at (3, 0, -2)
 *    at 9:16, 1:1, 16:9, or any dragged-panel ratio in between; the view
 *    just shows more or less of the world around it.
 *
 * `updateStyle: false` on setSize() is deliberate and load-bearing: `#game`
 * is CSS-sized `width:100%;height:100%` of its container, so letting CSS
 * own the *displayed* size while this class owns only the *drawing buffer*
 * means the two can never disagree — even for the frame or two where a
 * resize is still settling. Writing inline px onto the canvas instead (the
 * setSize default) is what let a stale buffer size stretch across a
 * differently-sized box in the first place.
 */
export class EditorViewport {
  private camera: THREE.Camera | undefined;
  private width = 0;
  private height = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    /** The element the canvas actually fills — measured, never assumed. */
    private readonly container: HTMLElement
  ) {}

  /** The camera whose projection tracks this viewport. Swapping cameras re-applies the current size immediately, so a newly-attached camera is never left with a stale projection for a frame. */
  setCamera(camera: THREE.Camera | undefined): void {
    this.camera = camera;
    if (camera && this.width > 0 && this.height > 0) this.applyCameraProjection(this.width, this.height);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  get aspect(): number {
    return this.height > 0 ? this.width / this.height : 1;
  }

  /** Measures the container and applies that size. Call on entry (before the first frame) so the very first render is already correct rather than being fixed up by the first ResizeObserver callback. */
  syncToContainer(): void {
    const rect = this.container.getBoundingClientRect();
    this.applySize(rect.width, rect.height);
  }

  /**
   * The single write path for renderer size + camera projection.
   * Idempotent — a ResizeObserver can fire repeatedly with an unchanged
   * box (a sibling's layout settling, a scrollbar appearing elsewhere),
   * and re-running setSize would needlessly reallocate the drawing buffer.
   */
  applySize(rawWidth: number, rawHeight: number): void {
    // Round, and never zero: a hidden or mid-layout container legitimately
    // measures 0, and 0 would make aspect NaN and blow up the projection
    // matrix permanently — it survives long past the frame that caused it.
    const width = Math.max(1, Math.round(rawWidth));
    const height = Math.max(1, Math.round(rawHeight));
    if (width === this.width && height === this.height) return;

    this.width = width;
    this.height = height;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false); // false: CSS owns the displayed size — see this class's own doc comment
    this.applyCameraProjection(width, height);
  }

  private applyCameraProjection(width: number, height: number): void {
    const camera = this.camera;
    if (!camera) return;
    const aspect = width / height;

    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const perspective = camera as THREE.PerspectiveCamera;
      perspective.aspect = aspect;
      perspective.updateProjectionMatrix();
      return;
    }

    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera;
      // Preserve the *vertical* extent and derive the horizontal one from
      // the new aspect. Scaling both axes to the box instead is precisely
      // the anisotropic stretch this whole class exists to prevent — the
      // 3D equivalent of the fixed-resolution "stage" mistake documented
      // in ENGINE.md's UI-scaling section.
      const halfHeight = (ortho.top - ortho.bottom) / 2;
      const centerY = (ortho.top + ortho.bottom) / 2;
      const centerX = (ortho.right + ortho.left) / 2;
      const halfWidth = halfHeight * aspect;
      ortho.top = centerY + halfHeight;
      ortho.bottom = centerY - halfHeight;
      ortho.left = centerX - halfWidth;
      ortho.right = centerX + halfWidth;
      ortho.updateProjectionMatrix();
    }
  }
}
