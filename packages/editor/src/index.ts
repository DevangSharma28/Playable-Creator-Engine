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
const dirtyListeners = { collider: [] as (() => void)[], particle: [] as (() => void)[], environment: [] as (() => void)[] };

const host: EditorHost = {
  createDebugLayer() {
    return new ColliderDebugLayer(new ColliderVisuals(Ion.colliders));
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
      colliderVisuals: new ColliderVisuals(Ion.colliders),
      particleManager: Ion.particles,
      particleVisuals: new ParticleVisuals(Ion.particles),
      environment: options.environment as SceneEnvironment,
      resolveTexture: options.resolveTexture,
      onColliderDirty: () => dirtyListeners.collider.forEach((f) => f()),
      onParticleDirty: () => dirtyListeners.particle.forEach((f) => f()),
      onEnvironmentDirty: () => dirtyListeners.environment.forEach((f) => f()),
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
export function onDirty(kind: "collider" | "particle" | "environment", cb: () => void): void {
  dirtyListeners[kind].push(cb);
}
