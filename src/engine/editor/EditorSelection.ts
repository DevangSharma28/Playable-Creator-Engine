import type * as THREE from "three";

/**
 * Where a selection change came from. Panels use this to skip work that
 * would fight the user: the hierarchy doesn't scroll-into-view a row the
 * user just clicked *in the hierarchy*, for instance, but does when the
 * same object was picked in the viewport.
 */
export type SelectionSource = "hierarchy" | "viewport" | "script-panel" | "api";

export interface EditorSelectionState {
  /** The selected scene object, if any. */
  object: THREE.Object3D | undefined;
  /** The selected script, as the repo-relative path Control Desk/Scripts use as their id (e.g. "entities/Player.ts"). */
  scriptPath: string | undefined;
  source: SelectionSource;
}

type Listener = (state: EditorSelectionState) => void;

/**
 * The one place "what is selected" lives while the 3D Viewer/Editor is
 * open — scene object and script alike.
 *
 * Before this existed, SceneInspector owned an internal `selected` field
 * and every panel that cared either reached into it or kept its own copy,
 * which is how the hierarchy, the viewport gizmo, and the inspector could
 * disagree about what was selected (each learned about a change only if
 * the code path that made it happened to remember to tell them). Now every
 * panel is a subscriber and nothing owns selection privately: a viewport
 * raycast, a hierarchy row click, and a `select()` call from a dev hook
 * all funnel through the same setter and every panel hears about it in the
 * same order.
 *
 * Object and script are deliberately two independent channels on one
 * store, not two stores — Control Desk's "assign this scene object to that
 * script field" flow needs both at once, and a single subscribe() means a
 * panel showing both can't get a half-updated view of them.
 */
export class EditorSelection {
  private selectedObject: THREE.Object3D | undefined;
  private selectedScript: string | undefined;
  private lastSource: SelectionSource = "api";
  private readonly listeners = new Set<Listener>();

  get object(): THREE.Object3D | undefined {
    return this.selectedObject;
  }

  get scriptPath(): string | undefined {
    return this.selectedScript;
  }

  get state(): EditorSelectionState {
    return { object: this.selectedObject, scriptPath: this.selectedScript, source: this.lastSource };
  }

  /** Selecting the object that's already selected is a no-op — panels re-render on every emit, so a redundant emit would rebuild DOM (and steal focus from a field being typed into) for no reason. */
  selectObject(object: THREE.Object3D | undefined, source: SelectionSource = "api"): void {
    if (this.selectedObject === object) return;
    this.selectedObject = object;
    this.lastSource = source;
    this.emit();
  }

  selectScript(scriptPath: string | undefined, source: SelectionSource = "script-panel"): void {
    if (this.selectedScript === scriptPath) return;
    this.selectedScript = scriptPath;
    this.lastSource = source;
    this.emit();
  }

  /** Returns an unsubscribe function — callers hold it and call it in their own dispose(), so a panel torn down mid-session can't keep receiving updates into detached DOM. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    if (!this.selectedObject && !this.selectedScript) return;
    this.selectedObject = undefined;
    this.selectedScript = undefined;
    this.lastSource = "api";
    this.emit();
  }

  dispose(): void {
    this.listeners.clear();
    this.selectedObject = undefined;
    this.selectedScript = undefined;
  }

  private emit(): void {
    const state = this.state;
    // Snapshot: a listener is allowed to subscribe/unsubscribe (or select
    // something else) in response to this emit without corrupting the
    // iteration we're in the middle of — same reasoning as EventBus.emit.
    for (const listener of [...this.listeners]) listener(state);
  }
}
