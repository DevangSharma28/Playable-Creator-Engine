import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SceneInspector, type GizmoMode, type InspectorToolState } from "../core/SceneInspector";
import { EditorSelection } from "./EditorSelection";
import { EditorViewport } from "./EditorViewport";
import { EditorResizeManager } from "./EditorResizeManager";
import { EditorObjectPicker } from "./EditorObjectPicker";
import { EditorHierarchy } from "./EditorHierarchy";
import { EditorInspector } from "./EditorInspector";
import { checkAssignable } from "./objectAssignment";
import { EditorDragSource } from "./EditorDragSource";
import { sceneObjectPath } from "../SceneBindings";

export interface EditorRootOptions {
  scene: THREE.Scene;
  /** The real gameplay camera. Never orbited or resized by the editor — it stays exactly as gameplay left it so the CameraHelper frustum keeps showing the shape the playable actually ships at. */
  gameplayCamera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** The element the canvas fills — measured continuously; the single source of truth for viewport size. */
  viewportContainer: HTMLElement;
  hierarchyEl: HTMLElement;
  inspectorEl: HTMLElement;
  /** Where to point the orbit camera on entry (typically the player). */
  initialTarget?: THREE.Vector3;
}

/** Resolution of a Control Desk "Pick" — reported back so the panel can show what happened without knowing anything about raycasting. */
export interface FieldPickCallbacks {
  onResolve: (object: THREE.Object3D) => void;
  onReject?: (reason: string) => void;
  onCancel?: () => void;
}

/**
 * Composition root for the dev 3D Viewer/Editor: owns the editor camera,
 * orbit controls, and every editor subsystem, wired together and torn down
 * as one unit.
 *
 * Deliberately thin — it constructs, connects, and disposes. Every actual
 * behavior lives in a focused class it holds (EditorSelection,
 * EditorViewport, EditorResizeManager, EditorObjectPicker, EditorHierarchy,
 * EditorInspector, SceneInspector), so this file stays readable as a wiring
 * diagram rather than growing into the one giant editor class.
 *
 * Two things it is careful about:
 *
 *  - **The editor camera is its own camera.** A clone of the gameplay
 *    camera, so orbiting never disturbs what the game thinks its camera is
 *    doing — and, critically, its projection is driven by EditorViewport
 *    against the real panel-bounded container, not by the gameplay
 *    camera's own resize path. That separation is what keeps the game's
 *    logical/design resolution independent from the editor viewport's, and
 *    is the fix for the scene appearing stretched when the editor opened
 *    over a Portrait or Landscape device preview.
 *  - **It cleans up completely.** dispose() releases the orbit controls,
 *    every subsystem, the ResizeObserver, and every scene helper. Game
 *    calls it both on exit and on teardown, so an in-place hot reload with
 *    the editor open can't leak a live inspector into the next bundle.
 */
export class EditorRoot {
  readonly selection = new EditorSelection();
  private readonly dragSource = new EditorDragSource();

  private readonly editorCamera: THREE.PerspectiveCamera;
  private readonly orbitControls: OrbitControls;
  private readonly viewport: EditorViewport;
  private readonly resizeManager: EditorResizeManager;
  private readonly sceneInspector: SceneInspector;
  private readonly picker: EditorObjectPicker;
  private readonly hierarchy: EditorHierarchy;
  private readonly inspector: EditorInspector;
  private onPickStateChange: ((pending: boolean) => void) | undefined;
  private readonly rendererRef: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly viewportContainerRect: () => DOMRect;

  constructor(opts: EditorRootOptions) {
    this.rendererRef = opts.renderer;
    this.scene = opts.scene;
    this.viewportContainerRect = () => opts.viewportContainer.getBoundingClientRect();

    this.editorCamera = opts.gameplayCamera.clone();
    this.orbitControls = new OrbitControls(this.editorCamera, opts.renderer.domElement);
    this.orbitControls.enableDamping = true;
    if (opts.initialTarget) this.orbitControls.target.copy(opts.initialTarget);

    // Viewport before anything renders: syncToContainer() below gives the
    // camera a correct projection for the real container box on frame one,
    // instead of inheriting the gameplay camera's cloned (possibly
    // letterboxed) aspect until the first observer callback lands.
    this.viewport = new EditorViewport(opts.renderer, opts.viewportContainer);
    this.viewport.setCamera(this.editorCamera);
    this.viewport.syncToContainer();
    this.resizeManager = new EditorResizeManager(opts.viewportContainer, (w, h) => this.viewport.applySize(w, h));

    this.sceneInspector = new SceneInspector({
      scene: opts.scene,
      gameplayCamera: opts.gameplayCamera,
      viewCamera: this.editorCamera,
      renderer: opts.renderer,
      orbitControls: this.orbitControls,
      selection: this.selection,
    });

    this.picker = new EditorObjectPicker({
      scene: opts.scene,
      domElement: opts.renderer.domElement,
      getCamera: () => this.editorCamera,
      excluded: this.sceneInspector.ownedHelpers,
      selection: this.selection,
      isGizmoBusy: () => this.sceneInspector.isGizmoBusy(),
      onPickStateChange: (pending) => this.onPickStateChange?.(pending),
    });

    this.hierarchy = new EditorHierarchy({
      scene: opts.scene,
      container: opts.hierarchyEl,
      excluded: this.sceneInspector.ownedHelpers,
      selection: this.selection,
      picker: this.picker,
      dragSource: this.dragSource,
    });

    this.inspector = new EditorInspector(opts.inspectorEl, this.selection);
  }

  /** The camera the scene is rendered through while the editor is open. */
  get camera(): THREE.PerspectiveCamera {
    return this.editorCamera;
  }

  /** Once per frame, from Game.render(). */
  update(): void {
    this.orbitControls.update();
    this.sceneInspector.update();
    this.hierarchy.refreshIfChanged();
    this.inspector.refresh();
  }

  /**
   * Arms Control Desk's "Pick" for a field of the given declared TS type.
   * The next object the user clicks — in the 3D viewport or in the
   * Hierarchy, they behave identically — is type-checked against that
   * declaration and handed back, or rejected with a reason while the pick
   * stays armed for another try.
   */
  requestObjectPick(declaredType: string | undefined, callbacks: FieldPickCallbacks): void {
    this.picker.beginPickRequest({
      validate: (object) => checkAssignable(declaredType, object),
      onResolve: callbacks.onResolve,
      onReject: callbacks.onReject,
      onCancel: callbacks.onCancel,
    });
  }

  cancelObjectPick(): void {
    this.picker.cancelPickRequest();
  }

  /**
   * Validates (and optionally completes) a Hierarchy row dropped onto a
   * Control Desk field declared as `declaredType`.
   *
   * One call serves both phases so the type rules stay in one place:
   * `commit: false` is the hover check that decides whether a drop target
   * highlights as accepting or refusing, `commit: true` is the drop
   * itself and additionally returns the live object plus the identifiers
   * needed to persist the assignment.
   */
  dragAssign(declaredType: string | undefined, commit: boolean, uuid?: string): { ok: boolean; reason: string; name?: string; object?: THREE.Object3D; objectPath?: string; objectName?: string } {
    const object = uuid ? this.dragSource.resolve(uuid) : this.dragSource.object;
    if (!object) return { ok: false, reason: "Nothing is being dragged." };
    const verdict = checkAssignable(declaredType, object);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, name: object.name || object.type };
    if (!commit) return { ok: true, reason: "", name: object.name || object.type };
    const id = this.objectPath(object);
    // Select what was just dropped, same as a completed Pick does — the
    // gizmo and Inspector then show the thing you just wired up.
    this.selection.selectObject(object, "hierarchy");
    return { ok: true, reason: "", name: object.name || object.type, object, ...id };
  }

  /** Stable identifier for a scene object, for persisting a Pick assignment — see SceneBindings.sceneObjectPath for why this isn't the uuid. */
  objectPath(object: THREE.Object3D): { objectPath: string; objectName: string } {
    return { objectPath: sceneObjectPath(object, this.scene), objectName: object.name || "" };
  }

  get isPickPending(): boolean {
    return this.picker.isPickPending;
  }

  /** Lets the panel show/clear its own "click an object…" affordance without polling. */
  setPickStateListener(cb: ((pending: boolean) => void) | undefined): void {
    this.onPickStateChange = cb;
  }

  /**
   * Dev/diagnostic readout of the viewport invariant this class exists to
   * hold: the renderer's drawing buffer and the editor camera's projection
   * must both match the *container's* real aspect. Exposed because silent
   * geometry drift has a track record in this codebase (see ENGINE.md's
   * UI-scaling section and tests/geometry-parity.test.mjs) — an invariant
   * that can be read back is one a test can assert instead of a person
   * having to eyeball a stretched scene.
   */
  getViewportInfo(): { containerWidth: number; containerHeight: number; containerAspect: number; rendererWidth: number; rendererHeight: number; cameraAspect: number; pixelRatio: number } {
    const rect = this.viewportContainerRect();
    const drawing = new THREE.Vector2();
    this.rendererRef.getSize(drawing);
    return {
      containerWidth: rect.width,
      containerHeight: rect.height,
      containerAspect: rect.height > 0 ? rect.width / rect.height : 0,
      rendererWidth: drawing.x,
      rendererHeight: drawing.y,
      cameraAspect: this.editorCamera.aspect,
      pixelRatio: this.rendererRef.getPixelRatio(),
    };
  }

  /** Re-measures and re-applies the viewport size right now. Used on entry, after the surrounding panels have actually taken their space, so the first visible frame is already correct. */
  syncViewport(): void {
    this.resizeManager.measureNow();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.sceneInspector.setMode(mode);
  }
  addModeChangeListener(cb: (mode: GizmoMode) => void): void {
    this.sceneInspector.addModeChangeListener(cb);
  }
  addStateChangeListener(cb: (state: InspectorToolState) => void): void {
    this.sceneInspector.addStateChangeListener(cb);
  }
  toggleGrid(): boolean {
    return this.sceneInspector.toggleGrid();
  }
  toggleHelpers(): boolean {
    return this.sceneInspector.toggleHelpers();
  }
  toggleSnap(): boolean {
    return this.sceneInspector.toggleSnap();
  }
  toggleSpace(): "local" | "world" {
    return this.sceneInspector.toggleSpace();
  }
  frameSelected(): void {
    this.sceneInspector.frameSelected();
  }

  dispose(): void {
    this.onPickStateChange = undefined;
    this.resizeManager.dispose();
    this.picker.dispose();
    this.hierarchy.dispose();
    this.inspector.dispose();
    this.sceneInspector.dispose();
    this.selection.dispose();
    this.orbitControls.dispose();
  }
}
