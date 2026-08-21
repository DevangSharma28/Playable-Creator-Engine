import * as THREE from "three";
import type { EditorSelection } from "./EditorSelection";

/** Pointer travel (px) above which a press is an orbit drag, not a click. OrbitControls uses the same left button on the same canvas, so without this every orbit would end in a selection change. */
const CLICK_MAX_TRAVEL = 5;

export interface PickRequest {
  /** Rejects an incompatible object and explains why — Control Desk supplies the field's type check (see objectAssignment.checkAssignable). */
  validate: (object: THREE.Object3D) => { ok: boolean; reason: string };
  /** Called with the object once one passes validation. */
  onResolve: (object: THREE.Object3D) => void;
  /** Called if the pick is abandoned (Escape, a second click on the same Pick button, editor teardown). */
  onCancel?: () => void;
  /** Called when a click landed on something that failed `validate` — the pick stays armed so the user can just click a different object. */
  onReject?: (reason: string) => void;
}

export interface EditorObjectPickerOptions {
  scene: THREE.Scene;
  domElement: HTMLElement;
  /** Read per-raycast rather than captured — the editor camera is created per session, so a captured reference would go stale. */
  getCamera: () => THREE.Camera | undefined;
  /** Editor-owned debug visuals (grid, helpers, gizmo, selection outline) — never selectable. */
  excluded: Set<THREE.Object3D>;
  selection: EditorSelection;
  /** True while a transform gizmo owns the pointer — that click is a handle drag, not a selection. */
  isGizmoBusy: () => boolean;
  /** Notified when a pick request arms or disarms, so the UI can show/clear "click an object…" affordances. */
  onPickStateChange?: (pending: boolean) => void;
  /**
   * Last chance to substitute what a viewport click actually selected.
   *
   * Exists for collider volumes: their translucent wireframe is a child of
   * the collider's node, so a raw hit would select the drawing and attach
   * the transform gizmo to it — dragging the picture of the volume away
   * from the volume. This maps such a hit back to the collider's own node.
   * Left as a hook rather than special-cased here so the picker keeps
   * knowing nothing about colliders.
   */
  resolveHit?: (object: THREE.Object3D) => THREE.Object3D;
}

/**
 * Turns a click into a selection — and, when Control Desk has armed a
 * "Pick" request, into a field assignment instead.
 *
 * Both entry points funnel through the same `offerObject()`, which is what
 * makes clicking a hierarchy row and clicking the object in the 3D
 * viewport genuinely interchangeable: the hierarchy doesn't know anything
 * about pick mode, it just offers whatever the user clicked and lets this
 * class decide whether that resolves a pending assignment or moves the
 * selection.
 *
 * Selection itself is never stored here — it goes straight into
 * EditorSelection, so the gizmo, inspector, and hierarchy all learn about
 * it through the same subscription rather than this class having to know
 * they exist.
 */
export class EditorObjectPicker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly opts: EditorObjectPickerOptions;
  private pressPos: { x: number; y: number } | null = null;
  private request: PickRequest | null = null;

  constructor(opts: EditorObjectPickerOptions) {
    this.opts = opts;
    opts.domElement.addEventListener("pointerdown", this.onPointerDown);
    opts.domElement.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
  }

  get isPickPending(): boolean {
    return this.request !== null;
  }

  /** Arms a pick. A second request replaces the first (its onCancel fires) — clicking Pick on field B while field A is armed should move the pick, not queue it. */
  beginPickRequest(request: PickRequest): void {
    if (this.request) this.request.onCancel?.();
    this.request = request;
    this.opts.domElement.style.cursor = "crosshair";
    this.opts.onPickStateChange?.(true);
  }

  cancelPickRequest(): void {
    if (!this.request) return;
    const request = this.request;
    this.request = null;
    this.opts.domElement.style.cursor = "";
    request.onCancel?.();
    this.opts.onPickStateChange?.(false);
  }

  /**
   * The single entry point for "the user indicated this object", from the
   * viewport raycast or a hierarchy row alike.
   *
   * Returns true when a pending pick consumed it — the caller should then
   * leave selection alone, since the user was assigning a field, not
   * browsing the scene. A failed type check deliberately keeps the request
   * armed and returns true as well: the click was still *aimed at* the
   * pick, and disarming on a near-miss would force re-clicking Pick for
   * every wrong guess.
   */
  offerObject(object: THREE.Object3D, source: "viewport" | "hierarchy"): boolean {
    const request = this.request;
    if (!request) {
      this.opts.selection.selectObject(object, source);
      return false;
    }
    const verdict = request.validate(object);
    if (!verdict.ok) {
      request.onReject?.(verdict.reason);
      return true;
    }
    this.request = null;
    this.opts.domElement.style.cursor = "";
    request.onResolve(object);
    this.opts.onPickStateChange?.(false);
    // Select what was just assigned too: the user's attention is on that
    // object, and it makes the assignment visible in the gizmo/inspector
    // without a second click.
    this.opts.selection.selectObject(object, source);
    return true;
  }

  dispose(): void {
    this.opts.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.opts.domElement.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("keydown", this.onKeyDown);
    this.cancelPickRequest();
    this.opts.domElement.style.cursor = "";
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.request) {
      // Swallow it so SceneInspector's own Escape (deselect) doesn't also
      // fire — cancelling a pick and clearing the selection on one keypress
      // would be two undo-able-feeling actions at once.
      e.stopPropagation();
      this.cancelPickRequest();
    }
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    this.pressPos = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.pressPos) return;
    const travel = Math.hypot(event.clientX - this.pressPos.x, event.clientY - this.pressPos.y);
    this.pressPos = null;
    if (travel > CLICK_MAX_TRAVEL) return; // an orbit drag, not a click
    if (this.opts.isGizmoBusy()) return; // the press belonged to a gizmo handle

    const hit = this.raycastAt(event.clientX, event.clientY);
    if (hit) {
      this.offerObject(hit, "viewport");
      return;
    }
    // Clicking empty space clears the selection, but must NOT silently
    // cancel an armed pick — a misjudged click past the edge of a small
    // object would otherwise throw away the assignment the user is in the
    // middle of making.
    if (!this.request) this.opts.selection.selectObject(undefined, "viewport");
  };

  private raycastAt(clientX: number, clientY: number): THREE.Object3D | undefined {
    const camera = this.opts.getCamera();
    if (!camera) return undefined;
    const rect = this.opts.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, camera);
    // Editor visuals are all added at scene top level, so filtering the
    // top level is enough to keep them unpickable even with the recursive
    // intersect below.
    const pickable = this.opts.scene.children.filter((child) => !this.opts.excluded.has(child));
    const hits = this.raycaster.intersectObjects(pickable, true);
    if (hits.length === 0) return undefined;
    const hit = hits[0].object;
    return this.opts.resolveHit ? this.opts.resolveHit(hit) : hit;
  }
}
