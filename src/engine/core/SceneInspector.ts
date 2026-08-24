import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { EditorSelection } from "../editor/EditorSelection";

export type GizmoMode = "none" | "translate" | "rotate" | "scale";

/** Grid/helper visibility, snap-on-drag, and gizmo space — surfaced to the editor toolbar via addStateChangeListener so its buttons stay in sync whether toggled by keyboard shortcut or by clicking the button itself (same pattern as GizmoMode/onModeChange). */
export interface InspectorToolState {
  grid: boolean;
  helpers: boolean;
  snap: boolean;
  space: "local" | "world";
}

export interface SceneInspectorOptions {
  scene: THREE.Scene;
  /** The real gameplay camera — its frustum is drawn via CameraHelper so you can see what it sees while freely orbiting with a different camera. Deliberately keeps the *game's* aspect, not the editor viewport's, so the frustum shows the shape the playable actually ships at. */
  gameplayCamera: THREE.PerspectiveCamera;
  /** The camera actually being rendered through (freecam) — what the transform gizmo operates against. */
  viewCamera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  /** Disabled while dragging a gizmo handle so orbiting and transforming never fight over the same drag gesture. */
  orbitControls: OrbitControls;
  /** The shared selection store — this class reacts to it, and never stores its own copy of "what's selected". */
  selection: EditorSelection;
}

/**
 * Scene-space editing visuals: the transform gizmo, the selection outline,
 * and the debug helpers (camera frustum, lights, grid), plus the keyboard
 * shortcuts and toggles that drive them.
 *
 * Scope note: this class used to *also* own the hierarchy panel, the
 * inspector fields, click-to-select raycasting, and the selection itself.
 * Those moved out to EditorHierarchy / EditorInspector / EditorObjectPicker
 * / EditorSelection, which is what lets the hierarchy, the viewport, the
 * inspector, and Control Desk's Pick flow all agree about what's selected —
 * previously each learned about a change only if whichever code path made
 * it remembered to tell them, and they drifted. What's left here is the
 * part that genuinely belongs to the 3D scene rather than to a DOM panel.
 *
 * Nothing here persists — edits are live/in-session only, since (unlike
 * src/game/ui/*.json for the 2D layouts) there's no data-driven description
 * of the 3D scene to save back to yet.
 *
 * Entirely self-contained: dispose() removes every helper/listener it added
 * and leaves the scene exactly as it found it.
 */
export class SceneInspector {
  private readonly scene: THREE.Scene;
  private readonly gameplayCamera: THREE.PerspectiveCamera;
  private readonly viewCamera: THREE.Camera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly orbitControls: OrbitControls;
  private readonly selection: EditorSelection;
  private readonly unsubscribe: () => void;

  private readonly cameraHelper: THREE.CameraHelper;
  private readonly lightHelpers: THREE.Object3D[] = [];
  private readonly gridHelper: THREE.GridHelper;
  /** Every visual this class added to the scene. Exposed so the picker and hierarchy can exclude them — they're debug chrome, not scene content, and must be neither selectable nor listed. */
  private readonly helpers = new Set<THREE.Object3D>();
  private readonly transformControls: TransformControls;
  /** Subscribers to gizmo drag begin/end — see onGizmoDrag. */
  private readonly dragListeners = new Set<(dragging: boolean) => void>();
  /** TransformControls itself isn't an Object3D (it extends the newer three.js Controls base) — its rendered gizmo lives on this helper, returned by getHelper(), which is what actually needs adding to the scene and toggling visible. */
  private readonly gizmoHelper: THREE.Object3D;

  private selectionHelper: THREE.BoxHelper | undefined;
  private mode: GizmoMode = "translate";
  private readonly onModeChange = new Set<(mode: GizmoMode) => void>();

  /** Off by default — the camera/light helpers below were always-on before this existed, grid is opt-in and would just be clutter until asked for. */
  private gridVisible = false;
  private helpersVisible = true;
  private snapEnabled = false;
  private readonly onStateChange = new Set<(state: InspectorToolState) => void>();

  constructor(opts: SceneInspectorOptions) {
    this.scene = opts.scene;
    this.gameplayCamera = opts.gameplayCamera;
    this.viewCamera = opts.viewCamera;
    this.renderer = opts.renderer;
    this.orbitControls = opts.orbitControls;
    this.selection = opts.selection;

    this.cameraHelper = new THREE.CameraHelper(this.gameplayCamera);
    this.scene.add(this.cameraHelper);
    this.helpers.add(this.cameraHelper);

    this.gridHelper = new THREE.GridHelper(20, 20, 0x666666, 0x333333);
    this.gridHelper.visible = this.gridVisible;
    this.scene.add(this.gridHelper);
    this.helpers.add(this.gridHelper);

    this.scene.traverse((obj) => {
      const helper = this.makeLightHelper(obj);
      if (helper) {
        this.lightHelpers.push(helper);
        this.scene.add(helper);
        this.helpers.add(helper);
      }
    });

    this.transformControls = new TransformControls(this.viewCamera, this.renderer.domElement);
    this.transformControls.setMode("translate");
    this.gizmoHelper = this.transformControls.getHelper();
    this.scene.add(this.gizmoHelper);
    this.helpers.add(this.gizmoHelper);
    // Prevents orbiting and dragging a gizmo handle from fighting over the
    // same mouse gesture — the instant a handle-drag starts, hand control
    // of the pointer over to TransformControls exclusively.
    this.transformControls.addEventListener("dragging-changed", (event) => {
      const dragging = (event as unknown as { value: boolean }).value;
      this.orbitControls.enabled = !dragging;
      // Broadcast the gesture boundary. The editors' undo history needs a
      // real begin/end here rather than the time-window coalescing sliders
      // fall back on — a gizmo drag emits a continuous stream of transform
      // writes, and this is what collapses the whole stream into exactly
      // one undo step.
      for (const listener of [...this.dragListeners]) listener(dragging);
    });

    this.unsubscribe = this.selection.subscribe((state) => this.applySelection(state.object));
    this.applySelection(this.selection.object);

    window.addEventListener("keydown", this.onKeyDown);
  }

  /** Editor-owned scene visuals — the picker and hierarchy exclude these so debug chrome is never selectable or listed as scene content. */
  get ownedHelpers(): Set<THREE.Object3D> {
    return this.helpers;
  }

  /** True while a gizmo handle owns the pointer — the picker checks this so a handle drag never doubles as a selection click. */
  isGizmoBusy(): boolean {
    return this.transformControls.dragging || this.transformControls.axis !== null;
  }

  /**
   * Notified with `true` when a gizmo drag starts and `false` when it
   * ends.
   *
   * Exposed so the collider and particle editors can record one undo entry
   * per drag: capture the transform on the leading edge, push the command
   * on the trailing edge. Returns an unsubscribe function, same contract
   * as EditorSelection.subscribe.
   */
  onGizmoDrag(listener: (dragging: boolean) => void): () => void {
    this.dragListeners.add(listener);
    return () => this.dragListeners.delete(listener);
  }

  /** Call once per frame while active — refreshes helper gizmos. TransformControls' own gizmo re-syncs to the selected object automatically via the normal scene render (its helper overrides updateMatrixWorld), so it needs no explicit update() call here. */
  update(): void {
    this.cameraHelper.update();
    for (const helper of this.lightHelpers) {
      (helper as { update?: () => void }).update?.();
    }
    this.selectionHelper?.update();
  }

  /** Move / Rotate / Scale / off — also switchable via the W/E/R/Q keys (see onKeyDown). */
  setMode(mode: GizmoMode): void {
    this.mode = mode;
    if (mode === "none") {
      this.transformControls.detach();
      this.transformControls.enabled = false;
      this.gizmoHelper.visible = false;
    } else {
      this.transformControls.enabled = true;
      this.gizmoHelper.visible = true;
      this.transformControls.setMode(mode);
      // Re-attach here, not only on selection change. Previously the gizmo
      // was attached exclusively inside select(), and only when the mode
      // wasn't "none" — so selecting an object in Select (Q) mode and then
      // pressing W left the gizmo enabled and visible but attached to
      // nothing, and you had to click the object a second time to get a
      // usable gizmo.
      const selected = this.selection.object;
      if (selected) this.transformControls.attach(selected);
      else this.transformControls.detach();
    }
    for (const cb of this.onModeChange) cb(mode);
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  /** Notified whenever setMode()/the W/E/R/Q shortcuts change the active gizmo mode — lets outer UI keep its own toolbar buttons in sync. */
  addModeChangeListener(cb: (mode: GizmoMode) => void): void {
    this.onModeChange.add(cb);
  }

  /** Toggleable via G or the editor toolbar — off by default, see gridVisible's field comment. */
  toggleGrid(): boolean {
    this.gridVisible = !this.gridVisible;
    this.gridHelper.visible = this.gridVisible;
    this.emitStateChange();
    return this.gridVisible;
  }

  /** Camera frustum + light helpers, toggleable via H — separate from the grid since it's existing always-on debug visuals, not a new opt-in. */
  toggleHelpers(): boolean {
    this.helpersVisible = !this.helpersVisible;
    this.cameraHelper.visible = this.helpersVisible;
    for (const helper of this.lightHelpers) helper.visible = this.helpersVisible;
    this.emitStateChange();
    return this.helpersVisible;
  }

  /** Fixed increments (0.25 world units / 15° / 0.1 scale) rather than a configurable amount — this is a quick on/off for "line things up roughly," not a precision-authoring feature yet. */
  toggleSnap(): boolean {
    this.snapEnabled = !this.snapEnabled;
    this.transformControls.setTranslationSnap(this.snapEnabled ? 0.25 : null);
    this.transformControls.setRotationSnap(this.snapEnabled ? THREE.MathUtils.degToRad(15) : null);
    this.transformControls.setScaleSnap(this.snapEnabled ? 0.1 : null);
    this.emitStateChange();
    return this.snapEnabled;
  }

  /** World (default) vs. the selected object's own local axes — same toggle Blender/Unity expose next to their gizmo. */
  toggleSpace(): "local" | "world" {
    const next = this.transformControls.space === "world" ? "local" : "world";
    this.transformControls.setSpace(next);
    this.emitStateChange();
    return next;
  }

  /** F — recenters the orbit target on the selected object and dollies the camera back just far enough to fit it, keeping the camera's current look direction rather than snapping to a canned angle. No-op with nothing selected. */
  frameSelected(): void {
    const selected = this.selection.object;
    if (!selected) return;
    const box = new THREE.Box3().setFromObject(selected);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.5);

    const dir = this.viewCamera.position.clone().sub(this.orbitControls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    this.orbitControls.target.copy(center);
    this.viewCamera.position.copy(center).addScaledVector(dir, radius * 3);
    this.orbitControls.update();
  }

  getToolState(): InspectorToolState {
    return { grid: this.gridVisible, helpers: this.helpersVisible, snap: this.snapEnabled, space: this.transformControls.space as "local" | "world" };
  }

  /** Notified whenever grid/helpers/snap/space change, by keyboard shortcut or toolbar click alike — same reasoning as addModeChangeListener. */
  addStateChangeListener(cb: (state: InspectorToolState) => void): void {
    this.onStateChange.add(cb);
  }

  private emitStateChange(): void {
    const state = this.getToolState();
    for (const cb of this.onStateChange) cb(state);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.unsubscribe();
    this.transformControls.detach();
    this.transformControls.dispose();
    for (const helper of this.helpers) this.scene.remove(helper);
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper = undefined;
    }
    this.helpers.clear();
    this.onModeChange.clear();
    this.onStateChange.clear();
  }

  /** Attaches/detaches the gizmo and redraws the yellow outline for whatever the shared selection now holds. */
  private applySelection(obj: THREE.Object3D | undefined): void {
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.helpers.delete(this.selectionHelper);
      this.selectionHelper = undefined;
    }

    if (!obj) {
      this.transformControls.detach();
      return;
    }

    this.selectionHelper = new THREE.BoxHelper(obj, 0xffe066);
    this.scene.add(this.selectionHelper);
    // The outline must be in `helpers`, or it becomes a pickable scene
    // child in its own right — clicking it would attach TransformControls
    // to the BoxHelper instead of the real object, which then crashes the
    // gizmo's own render (it expects a normal scene-graph parent).
    this.helpers.add(this.selectionHelper);

    if (this.mode !== "none") this.transformControls.attach(obj);
  }

  private makeLightHelper(obj: THREE.Object3D): THREE.Object3D | undefined {
    // AmbientLight has no position/direction — nothing meaningful to draw.
    if (obj instanceof THREE.DirectionalLight) return new THREE.DirectionalLightHelper(obj, 1);
    if (obj instanceof THREE.PointLight) return new THREE.PointLightHelper(obj, 0.3);
    if (obj instanceof THREE.SpotLight) return new THREE.SpotLightHelper(obj);
    if (obj instanceof THREE.HemisphereLight) return new THREE.HemisphereLightHelper(obj, 1);
    return undefined;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    const active = document.activeElement as HTMLElement | null;
    if (active?.tagName === "INPUT" || active?.tagName === "TEXTAREA" || active?.isContentEditable) return;
    const key = e.key.toLowerCase();
    if (key === "q") this.setMode("none");
    else if (key === "w") this.setMode("translate");
    else if (key === "e") this.setMode("rotate");
    else if (key === "r") this.setMode("scale");
    else if (key === "escape") this.selection.selectObject(undefined, "api");
    else if (key === "f") this.frameSelected();
    else if (key === "g") this.toggleGrid();
    else if (key === "h") this.toggleHelpers();
    else if (key === "x") this.toggleSnap();
    else if (key === "c") this.toggleSpace();
    else return;
    // Only reached when a shortcut actually matched. W/E/R/Q/F/G/H/X/C are
    // editor shortcuts, and W in particular collides with InputManager's
    // WASD gameplay fallback — that's handled by suspending InputManager
    // for the editor session (see Game.setFreecam), not here: both
    // listeners sit on `window`, so stopPropagation between them would do
    // nothing, and stopImmediatePropagation only stops listeners added
    // *after* this one (InputManager's is added first, in Game's
    // constructor). preventDefault is still worth it to stop the browser's
    // own default for these keys (quick-find on "/"-style shortcuts, etc.)
    // while the editor has focus.
    e.preventDefault();
  };
}
