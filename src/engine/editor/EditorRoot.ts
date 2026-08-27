import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SceneInspector, type GizmoMode, type InspectorToolState } from "../core/SceneInspector";
import { EditorSelection } from "./EditorSelection";
import { EditorViewport } from "./EditorViewport";
import { EditorResizeManager } from "./EditorResizeManager";
import { EditorObjectPicker } from "./EditorObjectPicker";
import { EditorHierarchy } from "./EditorHierarchy";
import { EditorInspector } from "./EditorInspector";
import { checkAssignable, isColliderField } from "./objectAssignment";
import type { ColliderVisuals } from "./ColliderVisuals";
import { EditorDragSource, OBJECT_DRAG_MIME } from "./EditorDragSource";
import { sceneObjectPath } from "../SceneBindings";
import { EditorColliders } from "./EditorColliders";
import { EditorParticles } from "./EditorParticles";
import { EditorHistory } from "./EditorHistory";
import { EditorEnvironment } from "./EditorEnvironment";
import type { ParticleVisuals } from "./ParticleVisuals";
import type { ParticleManager } from "../particles/ParticleManager";
import type { ParticleSystemConfig } from "../particles/ParticleTypes";
import { serializeParticles } from "../particles/ParticleSerialization";
import { captureSceneOverrides, snapshotScene } from "../scene/SceneOverrides";
import type { SceneObjectOverride, SceneSnapshot } from "../scene/SceneOverrides";
import type { ColliderManager } from "../collision/ColliderManager";
import type { ColliderData, ColliderShape } from "../collision/ColliderTypes";
import type { SceneEnvironment } from "../scene/SceneEnvironment";
import type { SceneEnvData } from "../scene/SceneEnvTypes";

export interface EditorRootOptions {
  scene: THREE.Scene;
  /**
   * The real gameplay camera. Never orbited or resized by the editor — it
   * stays exactly as gameplay left it so the CameraHelper frustum keeps
   * showing the shape the playable actually ships at.
   *
   * A getter rather than a value because the Environment panel can switch
   * the rig between perspective and orthographic mid-session, which changes
   * the camera's *identity* — a reference captured once would leave the
   * editor drawing the frustum of a camera the game stopped rendering
   * through (see update(), which re-syncs it every frame).
   */
  getGameplayCamera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  /** The element the canvas fills — measured continuously; the single source of truth for viewport size. */
  viewportContainer: HTMLElement;
  hierarchyEl: HTMLElement;
  inspectorEl: HTMLElement;
  /** The Environment dock's pane. Its own element, not the Inspector's — the environment isn't a property of the selected object. */
  environmentEl: HTMLElement;
  /**
   * The scene as the game built it, before any authored override was applied.
   *
   * The editor's scene Save diffs the live graph against this, so what it
   * writes is the full set of deviations from the model rather than only this
   * session's edits. Undefined only when a host opens the editor without a
   * game having taken one, in which case scene overrides simply cannot be
   * saved — better than saving an empty file over the user's work.
   */
  sceneBaseline?: SceneSnapshot;
  /**
   * The overrides the game booted with, so a session that does not touch an
   * object still writes the record the file already had for it.
   */
  sceneOverridesOnLoad?: readonly { objectPath: string }[];
  /** Fired the first time a scene-graph edit happens, so the Exit button can count it. */
  onSceneDirty?: () => void;
  /** Where to point the orbit camera on entry (typically the player). */
  initialTarget?: THREE.Vector3;
  /** The live ION Collider registry — the editor edits the same colliders gameplay runs against, never a copy. */
  colliderManager: ColliderManager;
  /** The collider wireframe layer. Owned by Game (it also drives the in-game DEV debug toggle), borrowed by the editor for the duration of a session. */
  colliderVisuals: ColliderVisuals;
  /** Fired the first time a collider edit happens in a session, so the dev page's Exit button can show there's something to save. */
  onColliderDirty?: () => void;
  /** The live ION Particle registry — the editor edits the same emitters gameplay runs, never a copy. */
  particleManager: ParticleManager;
  /** The particle gizmo layer. Owned by Game for the same reason ColliderVisuals is, borrowed here for the session. */
  particleVisuals: ParticleVisuals;
  /** Fired the first time a particle edit happens, so the Exit button can count it alongside collider and binding changes. */
  onParticleDirty?: () => void;
  /** The live scene environment — camera framing, lighting, and world settings. The editor edits the same instance gameplay runs against, never a copy. */
  environment: SceneEnvironment;
  /** Fired the first time an environment edit happens, so the Exit button can count it alongside the rest. */
  onEnvironmentDirty?: () => void;
  /** Resolves a particle texture path through the game's AssetLoader — the editor never loads assets itself. */
  resolveTexture?: (path: string) => THREE.Texture | undefined;
}

/**
 * Where an assignment ends up and how to write it down.
 *
 * `value` and `object` are deliberately separate: for a collider field the
 * value written onto the script is the `Collider` instance, while `object`
 * is the node that was clicked — the thing the panel names in its readout.
 * For an ordinary scene-object field they're the same reference.
 */
export interface FieldAssignment {
  value: unknown;
  object: THREE.Object3D;
  /** Stable scene path, for persisting an Object3D assignment. */
  objectPath: string;
  objectName: string;
  /** Set instead of relying on objectPath when the value is a collider — see SceneFieldBinding.colliderId. */
  colliderId?: string;
}

/** Resolution of a Control Desk "Pick" — reported back so the panel can show what happened without knowing anything about raycasting. */
export interface FieldPickCallbacks {
  onResolve: (assignment: FieldAssignment) => void;
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
  /**
   * One undo stack for every mode.
   *
   * Owned here rather than per-editor precisely so that switching between
   * Configure Colliders and Particle System doesn't lose it — the two
   * editors push into the same history and a single Undo walks back
   * through whichever actions actually happened, in order, regardless of
   * which mode each was performed in.
   */
  readonly history = new EditorHistory();
  private readonly dragSource = new EditorDragSource();

  private readonly editorCamera: THREE.PerspectiveCamera;
  private readonly orbitControls: OrbitControls;
  private readonly viewport: EditorViewport;
  private readonly resizeManager: EditorResizeManager;
  private readonly sceneInspector: SceneInspector;
  private readonly picker: EditorObjectPicker;
  private readonly hierarchy: EditorHierarchy;
  private readonly inspector: EditorInspector;
  /** "Configure Colliders" mode: authoring, wireframe visualization, and the Inspector's collider panel. */
  private readonly editorColliders: EditorColliders;
  /** "Particle System" mode: authoring, emission-volume gizmos, live preview transport, and the Inspector's sixteen module panels. */
  private readonly editorParticles: EditorParticles;
  /** The Environment dock: Camera, Lighting, World. Always present while the editor is open — unlike the two modes above, it isn't something you switch into. */
  private readonly editorEnvironment: EditorEnvironment;
  /** The pre-override scene a scene Save diffs against. See EditorRootOptions.sceneBaseline. */
  private readonly sceneBaseline: SceneSnapshot | undefined;
  /** Serialized form as of the last write, for hasSceneChanges(). */
  private savedSceneSignature = "[]";
  /**
   * The scene as this editor session found it.
   *
   * Diffed against, so a game's own animation — a spinning coin, a walking
   * character — is not mistaken for authoring. Gameplay is paused for the
   * whole session, so anything that moves after this point moved because
   * someone moved it.
   */
  private readonly sessionBaseline: SceneSnapshot;
  /** Baseline paths the loaded scene.json already covered. */
  private readonly loadedScenePaths: Set<string>;
  private unsubscribeSceneHistory: (() => void) | undefined;
  private onPickStateChange: ((pending: boolean) => void) | undefined;
  private readonly rendererRef: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly colliderManager: ColliderManager;
  private readonly colliderVisuals: ColliderVisuals;
  private readonly particleManager: ParticleManager;
  private readonly particleVisuals: ParticleVisuals;
  private readonly viewportContainerRect: () => DOMRect;
  /** Wall clock for the particle preview. Gameplay is paused for the whole session, so the editor has to carry its own clock or nothing would animate. */
  private lastFrameMs = performance.now();
  private readonly unsubscribeDrag: () => void;

  /** Held so dispose() can hand the particle system's camera back — see its own note there. Called rather than captured, since the rig's camera identity can change mid-session. */
  private readonly getGameplayCamera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly environment: SceneEnvironment;
  /** Last environment revision the editor reconciled its scene helpers against — see update(). */
  private lastEnvironmentVersion = -1;

  constructor(opts: EditorRootOptions) {
    this.rendererRef = opts.renderer;
    this.scene = opts.scene;
    this.getGameplayCamera = opts.getGameplayCamera;
    this.environment = opts.environment;
    this.viewportContainerRect = () => opts.viewportContainer.getBoundingClientRect();

    // The editor always orbits with a perspective camera, whatever the game
    // is set to: orbiting an orthographic view gives no depth cue at all,
    // and the projection you author *for the game* is a property of the
    // game, not of how you look at it. Cloned when the game is already
    // perspective so the starting near/far/FOV match what it ships with.
    const gameplayCamera = opts.getGameplayCamera();
    this.editorCamera =
      gameplayCamera instanceof THREE.PerspectiveCamera
        ? gameplayCamera.clone()
        : new THREE.PerspectiveCamera(50, 1, gameplayCamera.near, gameplayCamera.far);
    if (!(gameplayCamera instanceof THREE.PerspectiveCamera)) {
      this.editorCamera.position.copy(gameplayCamera.position);
      this.editorCamera.quaternion.copy(gameplayCamera.quaternion);
    }
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
      gameplayCamera,
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
      // Clicking a collider's translucent volume selects the collider, and
      // an emission-volume wireframe selects its emitter — never the
      // drawing itself, which would attach the gizmo to the gizmo. See
      // each mode's own resolveHit.
      resolveHit: (object) => {
        const asCollider = this.editorColliders.resolveHit(object);
        if (asCollider !== object) return asCollider;
        return this.editorParticles.resolveHit(object);
      },
    });

    // Before the picker's consumers below, and before the Inspector, so its
    // wireframes are already in the shared `excluded` set (which the
    // Hierarchy and the picker both read) by the time either is built.
    this.colliderManager = opts.colliderManager;
    this.colliderVisuals = opts.colliderVisuals;
    // The wireframes are the editor's to hide from the tree and refuse to
    // gizmo for the duration of this session only — outside the editor
    // they're just debug drawing with nothing to exclude them from.
    this.colliderVisuals.setExclusionSink(this.sceneInspector.ownedHelpers);
    this.editorColliders = new EditorColliders({
      manager: opts.colliderManager,
      visuals: opts.colliderVisuals,
      scene: opts.scene,
      selection: this.selection,
      picker: this.picker,
      getFocusPoint: () => this.orbitControls.target.clone(),
      history: this.history,
      onDirty: opts.onColliderDirty,
    });

    // Same shape and the same ordering reason as the collider block above:
    // its gizmos must be in the shared `excluded` set before the Hierarchy
    // and Inspector are built, or they'd be listed as scene content.
    this.particleManager = opts.particleManager;
    this.particleVisuals = opts.particleVisuals;
    this.particleVisuals.setExclusionSink(this.sceneInspector.ownedHelpers);
    // The editor renders through its own camera, so the particle system has
    // to billboard and distance-sort against *that* one for the session —
    // otherwise every particle faces wherever the gameplay camera happens
    // to be pointing while you orbit around them.
    this.particleManager.setCamera(this.editorCamera);
    this.editorParticles = new EditorParticles({
      manager: opts.particleManager,
      visuals: opts.particleVisuals,
      scene: opts.scene,
      selection: this.selection,
      picker: this.picker,
      getFocusPoint: () => this.orbitControls.target.clone(),
      resolveTexture: opts.resolveTexture,
      history: this.history,
      onDirty: opts.onParticleDirty,
    });

    // Not a mode: unlike Configure Colliders and Particle System, the
    // Environment dock is simply present for the whole session. It edits
    // the same live SceneEnvironment gameplay runs against, so every change
    // is visible in the viewport the instant it's made — and pushes onto
    // the same shared history, so one Ctrl+Z walks back through
    // environment, collider, and particle edits in the order they happened.
    this.editorEnvironment = new EditorEnvironment({
      container: opts.environmentEl,
      environment: opts.environment,
      history: this.history,
      onDirty: opts.onEnvironmentDirty,
      getViewCamera: () => this.editorCamera,
    });

    this.sceneBaseline = opts.sceneBaseline;
    this.sessionBaseline = snapshotScene(opts.scene);
    this.loadedScenePaths = new Set((opts.sceneOverridesOnLoad ?? []).map((record) => record.objectPath));
    // What is already on disk, so a session that changes nothing reports
    // clean. Anything the model was loaded with is a deviation the file
    // already records, not an unsaved edit.
    this.savedSceneSignature = JSON.stringify(this.serializeScene());

    // One gizmo drag = one undo entry. Both editors get the begin/end
    // edge; each ignores it unless the drag is actually on something it
    // owns, so there's no need to know which mode is active here.
    this.unsubscribeDrag = this.sceneInspector.onGizmoDrag((dragging) => {
      this.editorColliders.onGizmoDrag(dragging);
      this.editorParticles.onGizmoDrag(dragging);
      // A finished drag is the moment a scene transform becomes worth saving.
      // Fired on the end edge only — the Exit button counts sessions, not
      // frames of a gesture.
      if (!dragging && this.hasSceneChanges()) opts.onSceneDirty?.();
    });
    // Every other route to a scene edit — an Inspector field, a Hierarchy
    // rename or re-parent, an undo, a redo — lands in the shared history, so
    // one subscription covers all of them without each call site remembering.
    this.unsubscribeSceneHistory = this.history.subscribe(() => {
      if (this.hasSceneChanges()) opts.onSceneDirty?.();
    });

    this.hierarchy = new EditorHierarchy({
      scene: opts.scene,
      container: opts.hierarchyEl,
      excluded: this.sceneInspector.ownedHelpers,
      selection: this.selection,
      picker: this.picker,
      dragSource: this.dragSource,
    });

    this.inspector = new EditorInspector(opts.inspectorEl, this.selection, {
      resolveDraggedObject: (uuid) => this.dragSource.resolve(uuid),
      dragMime: OBJECT_DRAG_MIME,
    });
    // The Inspector renders whatever sections its providers hand back and
    // knows nothing about colliders or particles — see InspectorSections.ts.
    this.inspector.addSectionProvider(this.editorColliders);
    this.inspector.addSectionProvider(this.editorParticles);
  }

  /** "Configure Colliders" mode and its authoring operations. */
  get colliders(): EditorColliders {
    return this.editorColliders;
  }

  /** "Particle System" mode and its authoring operations. */
  get particles(): EditorParticles {
    return this.editorParticles;
  }

  // -----------------------------------------------------------------------
  // Undo / redo — one stack across every mode.
  // -----------------------------------------------------------------------

  undo(): boolean {
    return this.history.undo();
  }
  redo(): boolean {
    return this.history.redo();
  }
  /** Everything the toolbars need to paint their Undo/Redo/Save buttons in one read. */
  getHistoryState(): { canUndo: boolean; canRedo: boolean; undoLabel: string; redoLabel: string; colliderDirty: boolean; particleDirty: boolean; environmentDirty: boolean; depth: number } {
    return {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      undoLabel: this.history.undoLabel ?? "",
      redoLabel: this.history.redoLabel ?? "",
      colliderDirty: this.editorColliders.hasChanges,
      particleDirty: this.editorParticles.hasChanges,
      environmentDirty: this.editorEnvironment.hasChanges,
      depth: this.history.depth,
    };
  }
  /** Lets the dev page repaint its buttons the moment anything is pushed, undone, or redone, rather than polling. */
  onHistoryChange(cb: () => void): () => void {
    return this.history.subscribe(cb);
  }

  // There is deliberately no "mark everything saved" call.
  //
  // There used to be, and it silently destroyed work: colliders and
  // particles are two independent files, but one shared call cleared both
  // dirty flags. Saving one therefore disarmed the other — `flushParticles`
  // would see `hasParticleChanges === false` and return without writing, so
  // the particle edits lived only in memory and vanished on the next
  // reload. Exit Editor hit it every time, since it flushes colliders
  // first.
  //
  // Each file now marks only itself (markCollidersSaved /
  // markParticlesSaved below), which makes the cross-clear unrepresentable
  // rather than merely fixed.

  // -----------------------------------------------------------------------
  // Scene environment — thin passthroughs; the behavior is EditorEnvironment's.
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Scene graph — transforms, visibility, names, parenting.
  //
  // The fourth editor-authored file, and the one that was missing. Everything
  // the gizmo and the Hierarchy do is a direct mutation of a live Object3D,
  // and every one of those is rebuilt from the model on the next boot — so
  // without this the edits survived Exit (the objects really had moved) and
  // vanished on reload (they were parsed fresh). See SceneOverrides.ts.
  // -----------------------------------------------------------------------

  /** Everything that differs from the model, as records for src/game/scene.json. */
  serializeScene(): SceneObjectOverride[] {
    if (!this.sceneBaseline) return [];
    return captureSceneOverrides(this.scene, this.sceneBaseline, {
      touchedSince: this.sessionBaseline,
      alsoKeep: this.loadedScenePaths,
    });
  }

  /**
   * True when the live scene differs from what was last written.
   *
   * Computed by comparing serialized forms rather than tracked with a flag:
   * a gizmo drag, an Inspector field, an undo and a redo all mutate the same
   * objects through different code paths, and a flag would have to be set
   * correctly in every one of them. Comparing the output cannot miss one, and
   * it correctly reports *clean* after an undo returns the scene to where it
   * started.
   */
  hasSceneChanges(): boolean {
    if (!this.sceneBaseline) return false;
    return JSON.stringify(this.serializeScene()) !== this.savedSceneSignature;
  }

  /** Called after a successful write — see the note above getHistoryState on why each file marks only itself. */
  markSceneSaved(): void {
    this.savedSceneSignature = JSON.stringify(this.serializeScene());
  }

  /** The whole authored environment, as JSON-ready records for src/game/environment.json. */
  serializeEnvironment(): SceneEnvData {
    return this.editorEnvironment.serialize();
  }
  hasEnvironmentChanges(): boolean {
    return this.editorEnvironment.hasChanges;
  }
  /** Called after a successful write — see the note above getHistoryState on why each file marks only itself. */
  markEnvironmentSaved(): void {
    this.editorEnvironment.markSaved();
  }

  /** The camera the scene is rendered through while the editor is open. */
  get camera(): THREE.PerspectiveCamera {
    return this.editorCamera;
  }

  /** Once per frame, from Game.render(). */
  update(): void {
    this.orbitControls.update();
    this.sceneInspector.update();
    // Before the panels: this is what folds a gizmo drag back into the
    // collider's offset and refreshes the overlap tint, so the Hierarchy
    // and Inspector below read this frame's numbers rather than last
    // frame's. Gameplay is paused while the editor is open, so nothing else
    // is syncing colliders.
    this.editorColliders.update();

    // The editor's own clock. Gameplay's dt never arrives here (IonEngine
    // stops calling update() the moment the editor opens), so a live
    // particle preview has to be driven from wall time — capped for the
    // same reason the engine's own loop caps it: a stalled frame must not
    // advance the simulation by a whole second at once.
    const now = performance.now();
    const dt = Math.min((now - this.lastFrameMs) / 1000, 0.05);
    this.lastFrameMs = now;
    this.editorParticles.update(dt);

    // The Environment panel's own rows, and — only when something in the
    // environment actually changed — the scene chrome that depends on it.
    // A light created or deleted from the panel needs its helper added or
    // dropped, and a perspective/orthographic switch changes the camera's
    // identity, which CameraHelper binds to at construction. The Hierarchy
    // needs no prompting: it already notices graph-shape changes on its
    // own (see refreshIfChanged).
    this.editorEnvironment.update();
    if (this.lastEnvironmentVersion !== this.environment.version) {
      this.lastEnvironmentVersion = this.environment.version;
      this.sceneInspector.setGameplayCamera(this.getGameplayCamera());
      this.sceneInspector.refreshLightHelpers();
    }

    this.hierarchy.refreshIfChanged();
    this.inspector.refresh();
  }

  // -----------------------------------------------------------------------
  // Collider authoring — thin passthroughs; the behavior is EditorColliders'.
  // -----------------------------------------------------------------------

  /** Toolbar "Configure Colliders". Returns the new mode state. */
  setColliderMode(active: boolean): boolean {
    return this.editorColliders.setActive(active);
  }
  createCollider(shape: ColliderShape): void {
    this.editorColliders.create(shape);
  }
  deleteSelectedCollider(): boolean {
    return this.editorColliders.removeSelected();
  }
  toggleColliderVisible(): boolean {
    return this.editorColliders.toggleVisible();
  }
  /** Every collider that belongs in src/game/colliders.json, as JSON-ready records. */
  serializeColliders(): ColliderData[] {
    return this.editorColliders.serialize();
  }
  get hasColliderChanges(): boolean {
    return this.editorColliders.hasChanges;
  }
  /** Called after colliders.json is written. Also advances the shared history's clean point, so undoing back to here reports clean. */
  markCollidersSaved(): void {
    this.editorColliders.markSaved();
    this.history.markSaved();
  }

  // -----------------------------------------------------------------------
  // Particle authoring — thin passthroughs; the behavior is EditorParticles'.
  // -----------------------------------------------------------------------

  /** Toolbar "Particle System". Returns the new mode state. */
  setParticleMode(active: boolean): boolean {
    return this.editorParticles.setActive(active);
  }
  createParticleSystem(presetKey?: string): void {
    this.editorParticles.createSystem(presetKey);
  }
  addParticleEmitter(): void {
    this.editorParticles.addEmitter();
  }
  deleteSelectedEmitter(): boolean {
    return this.editorParticles.removeSelected();
  }
  duplicateSelectedEmitter(): boolean {
    const selected = this.editorParticles.selected;
    if (!selected) return false;
    return !!this.editorParticles.duplicateEmitter(selected);
  }
  particlePlay(): void {
    this.editorParticles.play();
  }
  particlePause(): void {
    this.editorParticles.pause();
  }
  particleStop(): void {
    this.editorParticles.stop();
  }
  particleRestart(): void {
    this.editorParticles.restart();
  }
  particleClear(): void {
    this.editorParticles.clearParticles();
  }
  get isParticlePreviewPlaying(): boolean {
    return this.editorParticles.isPreviewPlaying;
  }
  toggleParticleGizmos(kind: "shapes" | "direction" | "bounds"): boolean {
    if (kind === "shapes") {
      this.particleVisuals.setShowShapes(!this.particleVisuals.showingShapes);
      return this.particleVisuals.showingShapes;
    }
    if (kind === "direction") {
      this.particleVisuals.setShowDirection(!this.particleVisuals.showingDirection);
      return this.particleVisuals.showingDirection;
    }
    this.particleVisuals.setShowBounds(!this.particleVisuals.showingBounds);
    return this.particleVisuals.showingBounds;
  }
  /** Every system the editor owns, as one file's worth of records for src/game/particles.json. */
  serializeParticles(): ParticleSystemConfig[] {
    return serializeParticles(this.particleManager, this.scene);
  }
  get hasParticleChanges(): boolean {
    return this.editorParticles.hasChanges;
  }
  /** Called after particles.json is written. Marks only the particle side — see the note above markCollidersSaved. */
  markParticlesSaved(): void {
    this.editorParticles.markSaved();
    this.history.markSaved();
  }
  getParticleStats(): ReturnType<ParticleManager["getStats"]> {
    return this.particleManager.getStats();
  }
  /**
   * The preset list the toolbar's dropdown is built from.
   *
   * Reached through here rather than imported directly by Game, so the
   * preset table stays inside the editor module tree and tree-shakes out
   * of a production build. Importing it game-side shipped all thirteen
   * preset configs into dist/index.html for a dropdown that only ever
   * exists in the editor — verified by grepping the built file.
   */
  getParticlePresets(): { key: string; label: string; description: string }[] {
    return EditorParticles.presets;
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
      validate: (object) => checkAssignable(declaredType, object, this.colliderManager.fromNode(object)),
      onResolve: (object) => callbacks.onResolve(this.assignmentFor(declaredType, object)),
      onReject: callbacks.onReject,
      onCancel: callbacks.onCancel,
    });
  }

  /**
   * What a field should actually receive for a given clicked object, plus
   * the identifiers needed to persist it.
   *
   * One place decides this for both entry points (⊙ Pick and a Hierarchy
   * row dropped on the field), so a collider assigned by dragging and a
   * collider assigned by picking can't end up as different things — which
   * is exactly the kind of drift that would only show up after a reload.
   */
  assignmentFor(declaredType: string | undefined, object: THREE.Object3D): FieldAssignment {
    const base = { object, objectPath: sceneObjectPath(object, this.scene), objectName: object.name || "" };
    if (!isColliderField(declaredType)) return { ...base, value: object };
    const collider = this.colliderManager.fromNode(object);
    if (!collider) return { ...base, value: object };
    // The collider's *name* rides in objectName so the binding stays
    // recoverable if the id ever changes — see resolveCollider.
    return { ...base, value: collider, colliderId: collider.id, objectName: collider.name };
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
  dragAssign(declaredType: string | undefined, commit: boolean, uuid?: string): { ok: boolean; reason: string; name?: string; value?: unknown; objectPath?: string; objectName?: string; colliderId?: string } {
    const object = uuid ? this.dragSource.resolve(uuid) : this.dragSource.object;
    if (!object) return { ok: false, reason: "Nothing is being dragged." };
    const collider = this.colliderManager.fromNode(object);
    const verdict = checkAssignable(declaredType, object, collider);
    const label = collider?.name || object.name || object.type;
    if (!verdict.ok) return { ok: false, reason: verdict.reason, name: label };
    if (!commit) return { ok: true, reason: "", name: label };
    const assignment = this.assignmentFor(declaredType, object);
    // Select what was just dropped, same as a completed Pick does — the
    // gizmo and Inspector then show the thing you just wired up.
    this.selection.selectObject(object, "hierarchy");
    return { ok: true, reason: "", name: label, value: assignment.value, objectPath: assignment.objectPath, objectName: assignment.objectName, colliderId: assignment.colliderId };
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
    this.unsubscribeDrag();
    // Releases anything a delete command was holding alive. Deliberately
    // the last word on those objects: a detached collider or emitter that
    // no command can ever restore has nothing else keeping it reachable.
    this.history.clear();
    this.unsubscribeSceneHistory?.();
    this.resizeManager.dispose();
    // Before sceneInspector: the collider wireframes live in that class's
    // `ownedHelpers` set, and removing them after it has cleared the set
    // would leave them parented in the scene with nothing tracking them.
    this.editorColliders.dispose();
    // Hands the wireframes back to Game: they outlive the session (the
    // in-game DEV debug toggle draws the same ones), so they're released
    // from the editor's exclusion set rather than destroyed.
    this.colliderVisuals.setExclusionSink(undefined);
    // Same ordering and the same hand-back for the particle gizmos.
    this.editorParticles.dispose();
    this.particleVisuals.setExclusionSink(undefined);
    // Point the particle system back at gameplay's own camera. The editor
    // camera stops existing with this instance, and a billboard shader
    // reading a dead camera's matrix would freeze every particle facing
    // wherever the editor was last looking.
    this.particleManager.setCamera(this.getGameplayCamera());
    this.editorEnvironment.dispose();
    this.picker.dispose();
    this.hierarchy.dispose();
    this.inspector.dispose();
    this.sceneInspector.dispose();
    this.selection.dispose();
    this.orbitControls.dispose();
  }
}
