import type * as THREE from "three";

/**
 * How the runtime reaches the ION Editor without importing it.
 *
 * ## Why inversion of control rather than a direct import
 *
 * The editor is a separate, dev-only package. If the runtime imported it —
 * even lazily, even behind `import.meta.env.DEV` — then every consumer of the
 * runtime would need it resolvable, a production bundle would have to prove
 * the branch was dead, and the commercial boundary would leak: client code
 * would transitively name editor modules.
 *
 * Instead the *dev entry* imports the editor and calls `registerEditorHost`.
 * Production entries never do. The runtime holds a nullable slot and behaves
 * correctly when it's empty, so a shipped playable contains no editor
 * reference of any kind — not a dead import, not a string.
 *
 * The two sides agree on the shapes below and nothing else.
 */

export interface EditorOpenOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  /** A getter, because the environment panel can switch the rig's projection mid-session and that changes the camera's identity. */
  getGameplayCamera: () => THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** The live scene environment — the editor edits this instance, never a copy. */
  environment: unknown;
  /** Where to point the orbit camera on entry. */
  initialTarget?: THREE.Vector3;
  /** Resolves a texture path through the project's own AssetLoader — the editor never loads assets itself. */
  resolveTexture?: (path: string) => THREE.Texture | undefined;
}

/**
 * One open editor session.
 *
 * Deliberately structural: the runtime declares the shape it needs and the
 * editor package asserts its adapter satisfies it. Neither imports the other's
 * types, so the packages version independently.
 */
export interface EditorSession {
  readonly camera: THREE.PerspectiveCamera;
  update(): void;
  /** Anything that must draw after the main render — the view-helper widget. */
  afterRender(activeCamera: THREE.Camera): void;
  dispose(): void;

  setGizmoMode(mode: string): void;
  onGizmoModeChange(cb: (mode: string) => void): void;
  onInspectorStateChange(cb: (state: { grid: boolean; helpers: boolean; snap: boolean; space: string }) => void): void;
  toggleGrid(): boolean | undefined;
  toggleHelpers(): boolean | undefined;
  toggleSnap(): boolean | undefined;
  toggleSpace(): string | undefined;
  frameSelected(): void;

  setColliderMode(active: boolean): boolean | undefined;
  createCollider(shape: string): void;
  deleteSelectedCollider(): boolean;
  toggleColliderVisible(): boolean | undefined;
  serializeColliders(): unknown[] | undefined;
  hasColliderChanges(): boolean;
  markCollidersSaved(): void;
  onColliderDirty(cb: () => void): void;
  setColliderDebug(visible: boolean): boolean | undefined;
  toggleColliderDebug(): boolean | undefined;
  getColliderStats(): { total: number; enabled: number; narrowTests: number; activePairs: number } | undefined;

  setParticleMode(active: boolean): boolean | undefined;
  createParticleSystem(presetKey?: string): void;
  addParticleEmitter(): void;
  deleteSelectedEmitter(): boolean;
  duplicateSelectedEmitter(): boolean;
  particlePlay(): void;
  particlePause(): void;
  particleStop(): void;
  particleRestart(): void;
  particleClear(): void;
  isParticlePreviewPlaying(): boolean;
  toggleParticleGizmo(kind: string): boolean | undefined;
  getParticlePresets(): { key: string; label: string; description: string }[];
  setParticleQuality(quality: string): void;
  serializeParticles(): unknown[] | undefined;
  hasParticleChanges(): boolean;
  markParticlesSaved(): void;
  onParticleDirty(cb: () => void): void;
  getParticleStats(): unknown;

  serializeEnvironment(): unknown;
  hasEnvironmentChanges(): boolean;
  markEnvironmentSaved(): void;
  onEnvironmentDirty(cb: () => void): void;

  editorUndo(): boolean;
  editorRedo(): boolean;
  getEditorHistory(): unknown;
  onEditorHistoryChange(cb: () => void): void;
  getEditorViewportInfo(): unknown;

  requestObjectPick(declaredType: string | undefined, callbacks: unknown): boolean;
  cancelObjectPick(): void;
  editorDragAssign(declaredType: string | undefined, commit: boolean, uuid?: string): unknown;
  editorAssignmentFor(declaredType: string | undefined, object: unknown): unknown;
}

/**
 * The collider/trigger wireframe overlay, drawn over the *running* game.
 *
 * Separate from an editor session on purpose: "Show Colliders" works with no
 * editor open and gameplay proceeding normally, which is the whole point of
 * it — you watch a trigger turn red as the player walks into it. It is still
 * dev-only, so it lives behind the same registration hook.
 */
export interface DebugLayer {
  setVisible(visible: boolean): boolean;
  toggle(): boolean;
  update(): void;
  dispose(): void;
}

export interface EditorHost {
  open(options: EditorOpenOptions): EditorSession | undefined;
  /** Built once per game, whether or not an editor session is ever opened. */
  createDebugLayer(): DebugLayer | undefined;
}

let host: EditorHost | undefined;

/**
 * Called by `@ion-engine/editor` from a dev entry. Never called in production —
 * which is what makes the editor genuinely absent from a shipped build rather
 * than merely unreachable.
 */
export function registerEditorHost(next: EditorHost | undefined): void {
  host = next;
}

export function getEditorHost(): EditorHost | undefined {
  return host;
}

/** True when a dev entry has installed the editor. Useful for hiding UI that would otherwise do nothing. */
export function isEditorAvailable(): boolean {
  return host !== undefined;
}
