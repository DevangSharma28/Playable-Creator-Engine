/**
 * `@ion-engine/editor` — ION Studio.
 *
 * A **development-only** package. Importing it is what makes the 3D editor,
 * the collider and particle authoring modes, the Environment dock and the
 * Show Colliders overlay exist at all; a production entry never imports it,
 * so a shipped playable contains none of it — not a dead branch, not a string.
 *
 * The runtime does not import this package. This package registers itself
 * with the runtime through `registerEditorHost`, which is what keeps the
 * dependency pointing one way (see `editor-host` in the runtime).
 */
import * as THREE from "three";
import {
  Ion,
  registerEditorHost,
  type DebugLayer,
  type EditorHost,
  type EditorOpenOptions,
  type EditorSession,
} from "@ion-engine/runtime";
import { EditorRoot } from "../../../src/engine/editor/EditorRoot";
import { ColliderVisuals } from "../../../src/engine/editor/ColliderVisuals";
import { ParticleVisuals } from "../../../src/engine/editor/ParticleVisuals";
import { ViewHelperWidget } from "../../../src/engine/core/ViewHelperWidget";
import type { SceneEnvironment } from "../../../src/engine/scene";
import type { GizmoMode } from "../../../src/engine/core/SceneInspector";
import type { ColliderShape } from "../../../src/engine/collision";

/** Wraps ColliderVisuals so "Show Colliders" works with no editor session open. */
class ColliderDebugLayer implements DebugLayer {
  private visible = false;
  constructor(private readonly visuals: ColliderVisuals) {}
  setVisible(visible: boolean): boolean {
    this.visible = visible;
    this.visuals.setDebugVisible(visible);
    return this.visible;
  }
  toggle(): boolean {
    return this.setVisible(!this.visible);
  }
  update(): void {
    this.visuals.update();
  }
  dispose(): void {
    this.visuals.dispose();
  }
}

class Session implements EditorSession {
  private readonly viewHelper: ViewHelperWidget | undefined;
  constructor(private readonly root: EditorRoot, viewHelperCanvas: HTMLCanvasElement | null) {
    this.viewHelper = viewHelperCanvas ? new ViewHelperWidget(viewHelperCanvas) : undefined;
  }
  get camera(): THREE.PerspectiveCamera { return this.root.camera; }
  update(): void { this.root.update(); }
  afterRender(activeCamera: THREE.Camera): void { this.viewHelper?.update(activeCamera); }
  dispose(): void { this.viewHelper?.dispose(); this.root.dispose(); }

  setGizmoMode(mode: string): void { this.root.setGizmoMode(mode as GizmoMode); }
  onGizmoModeChange(cb: (mode: string) => void): void { this.root.addModeChangeListener(cb); }
  onInspectorStateChange(cb: (s: { grid: boolean; helpers: boolean; snap: boolean; space: string }) => void): void { this.root.addStateChangeListener(cb); }
  toggleGrid(): boolean { return this.root.toggleGrid(); }
  toggleHelpers(): boolean { return this.root.toggleHelpers(); }
  toggleSnap(): boolean { return this.root.toggleSnap(); }
  toggleSpace(): string { return this.root.toggleSpace(); }
  frameSelected(): void { this.root.frameSelected(); }

  setColliderMode(active: boolean): boolean { return this.root.setColliderMode(active); }
  createCollider(shape: string): void { this.root.createCollider(shape as ColliderShape); }
  deleteSelectedCollider(): boolean { return this.root.deleteSelectedCollider(); }
  toggleColliderVisible(): boolean { return this.root.toggleColliderVisible(); }
  serializeColliders(): unknown[] { return this.root.serializeColliders(); }
  hasColliderChanges(): boolean { return this.root.hasColliderChanges; }
  markCollidersSaved(): void { this.root.markCollidersSaved(); }
  onColliderDirty(_cb: () => void): void { /* wired at construction — see open() */ }
  setColliderDebug(): boolean | undefined { return undefined; }
  toggleColliderDebug(): boolean | undefined { return undefined; }
  getColliderStats(): { total: number; enabled: number; narrowTests: number; activePairs: number } { return Ion.colliders.getStats(); }

  setParticleMode(active: boolean): boolean { return this.root.setParticleMode(active); }
  createParticleSystem(presetKey?: string): void { this.root.createParticleSystem(presetKey); }
  addParticleEmitter(): void { this.root.addParticleEmitter(); }
  deleteSelectedEmitter(): boolean { return this.root.deleteSelectedEmitter(); }
  duplicateSelectedEmitter(): boolean { return this.root.duplicateSelectedEmitter(); }
  particlePlay(): void { this.root.particlePlay(); }
  particlePause(): void { this.root.particlePause(); }
  particleStop(): void { this.root.particleStop(); }
  particleRestart(): void { this.root.particleRestart(); }
  particleClear(): void { this.root.particleClear(); }
  isParticlePreviewPlaying(): boolean { return this.root.isParticlePreviewPlaying; }
  toggleParticleGizmo(kind: string): boolean { return this.root.toggleParticleGizmos(kind as "shapes" | "direction" | "bounds"); }
  getParticlePresets(): { key: string; label: string; description: string }[] { return this.root.getParticlePresets(); }
  setParticleQuality(quality: string): void { Ion.particles.setQuality(quality as "high" | "medium" | "low"); }
  serializeParticles(): unknown[] { return this.root.serializeParticles(); }
  hasParticleChanges(): boolean { return this.root.hasParticleChanges; }
  markParticlesSaved(): void { this.root.markParticlesSaved(); }
  onParticleDirty(_cb: () => void): void { /* wired at construction */ }
  getParticleStats(): unknown { return Ion.particles.getStats(); }

  serializeEnvironment(): unknown { return this.root.serializeEnvironment(); }
  hasEnvironmentChanges(): boolean { return this.root.hasEnvironmentChanges(); }
  markEnvironmentSaved(): void { this.root.markEnvironmentSaved(); }
  onEnvironmentDirty(_cb: () => void): void { /* wired at construction */ }
  serializeScene(): unknown[] { return this.root.serializeScene(); }
  hasSceneChanges(): boolean { return this.root.hasSceneChanges(); }
  markSceneSaved(): void { this.root.markSceneSaved(); }
  onSceneDirty(_cb: () => void): void { /* wired at construction */ }

  editorUndo(): boolean { return this.root.undo(); }
  editorRedo(): boolean { return this.root.redo(); }
  getEditorHistory(): unknown { return this.root.getHistoryState(); }
  onEditorHistoryChange(cb: () => void): void { this.root.onHistoryChange(cb); }
  getEditorViewportInfo(): unknown { return this.root.getViewportInfo(); }

  requestObjectPick(declaredType: string | undefined, callbacks: unknown): boolean {
    this.root.requestObjectPick(declaredType, callbacks as Parameters<EditorRoot["requestObjectPick"]>[1]);
    return this.root.isPickPending;
  }
  cancelObjectPick(): void { this.root.cancelObjectPick(); }
  editorDragAssign(declaredType: string | undefined, commit: boolean, uuid?: string): unknown { return this.root.dragAssign(declaredType, commit, uuid); }
  editorAssignmentFor(declaredType: string | undefined, object: unknown): unknown { return this.root.assignmentFor(declaredType, object as THREE.Object3D); }
}

/** Fires the dev page's dirty callbacks. Held per host so the Session's on*Dirty methods can stay simple. */
const dirtyListeners = {
  collider: [] as (() => void)[],
  particle: [] as (() => void)[],
  environment: [] as (() => void)[],
  scene: [] as (() => void)[],
};

/**
 * One collider wireframe layer for the whole page, shared by the "Show
 * Colliders" overlay and the editor's Configure Colliders mode.
 *
 * It has to be one instance, and the reason is not tidiness. `ColliderVisuals`
 * is reconciled once per frame from `IonGame.render()`, which ticks the *debug
 * layer* — and `EditorColliders.update()` deliberately does not redraw,
 * precisely so the same layer is not reconciled twice a frame.
 *
 * Constructing a second instance for the editor therefore produced a layer
 * that nothing ever ticked: entering Configure Colliders set `editorVisible`
 * on it, `update()` was never called, `createVisual()` never ran, and the
 * collider nodes stayed childless. Colliders existed and detection ran — the
 * stats panel proved it — but not one wireframe was ever drawn, so the mode
 * looked completely dead.
 *
 * The reference game has always shared one instance between the two. This is
 * the packaged equivalent of that, and lives at module scope because both
 * entry points below need it and neither owns the other.
 */
/**
 * Keyed by the registry it draws, not cached outright: `IonEngine` builds a
 * fresh `ColliderManager` on every boot, so a dev hot reload replaces
 * `Ion.colliders` wholesale. A layer held across that would keep reconciling
 * against the retired registry and draw nothing for the live one — the same
 * silent-blank failure this whole mechanism exists to fix, arriving one reload
 * later instead of immediately.
 */
let sharedColliderVisuals: { manager: typeof Ion.colliders; visuals: ColliderVisuals } | undefined;
function colliderVisuals(): ColliderVisuals {
  if (!sharedColliderVisuals || sharedColliderVisuals.manager !== Ion.colliders) {
    sharedColliderVisuals = { manager: Ion.colliders, visuals: new ColliderVisuals(Ion.colliders) };
  }
  return sharedColliderVisuals.visuals;
}

/**
 * The particle gizmo layer, shared for the same reason.
 *
 * Only one thing draws it today (the editor), so a second instance would not
 * currently break anything — but the two layers are a matched pair and the
 * failure mode above is invisible until someone looks at the screen. Keeping
 * both on the same rule means the next reader does not have to work out why
 * they differ.
 */
let sharedParticleVisuals: { manager: typeof Ion.particles; visuals: ParticleVisuals } | undefined;
function particleVisuals(): ParticleVisuals {
  if (!sharedParticleVisuals || sharedParticleVisuals.manager !== Ion.particles) {
    sharedParticleVisuals = { manager: Ion.particles, visuals: new ParticleVisuals(Ion.particles) };
  }
  return sharedParticleVisuals.visuals;
}

const host: EditorHost = {
  createDebugLayer() {
    return new ColliderDebugLayer(colliderVisuals());
  },
  open(options: EditorOpenOptions): EditorSession | undefined {
    const hierarchyEl = document.getElementById("si-hierarchy");
    const inspectorEl = document.getElementById("si-inspector");
    const environmentEl = document.getElementById("si-environment");
    if (!hierarchyEl || !inspectorEl || !environmentEl) {
      console.warn("ION Editor: the Studio panel isn't in this page — is this the dev entry?");
      return undefined;
    }
    const viewportContainer =
      (document.getElementById("device-frame") as HTMLElement | null) ?? options.renderer.domElement.parentElement ?? options.renderer.domElement;

    const root = new EditorRoot({
      scene: options.scene,
      getGameplayCamera: options.getGameplayCamera,
      renderer: options.renderer,
      viewportContainer: viewportContainer as HTMLElement,
      hierarchyEl,
      inspectorEl,
      environmentEl,
      initialTarget: options.initialTarget,
      colliderManager: Ion.colliders,
      colliderVisuals: colliderVisuals(),
      particleManager: Ion.particles,
      particleVisuals: particleVisuals(),
      environment: options.environment as SceneEnvironment,
      sceneBaseline: options.sceneBaseline as ConstructorParameters<typeof EditorRoot>[0]["sceneBaseline"],
      sceneOverridesOnLoad: options.sceneOverridesOnLoad,
      resolveTexture: options.resolveTexture,
      onColliderDirty: () => dirtyListeners.collider.forEach((f) => f()),
      onParticleDirty: () => dirtyListeners.particle.forEach((f) => f()),
      onEnvironmentDirty: () => dirtyListeners.environment.forEach((f) => f()),
      onSceneDirty: () => dirtyListeners.scene.forEach((f) => f()),
    });

    return new Session(root, document.getElementById("er-viewhelper") as HTMLCanvasElement | null);
  },
};

/** Call once from a dev entry. After this, `IonGame.setFreecam(true)` opens Studio. */
export function installEditor(): void {
  registerEditorHost(host);
}

/** Removes the editor host. Any open session must already be closed. */
export function uninstallEditor(): void {
  registerEditorHost(undefined);
}

/** Subscribed by the Engine Room so its Exit button can count unsaved work. */
export function onDirty(kind: "collider" | "particle" | "environment" | "scene", cb: () => void): void {
  dirtyListeners[kind].push(cb);
}
