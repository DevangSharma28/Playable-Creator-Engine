/**
 * One undo/redo stack, shared by every editor mode.
 *
 * ## Commands, not snapshots
 *
 * Each entry carries its own `undo()`/`redo()` closures rather than a
 * before/after copy of the whole scene. Whole-scene snapshots are simpler
 * to write and wrong in the way that matters here: restoring one destroys
 * and rebuilds every object, so a script field holding a `Collider`, a
 * sub-emitter resolving a sibling by name, or the current selection all
 * end up pointing at objects that no longer exist. Commands mutate exactly
 * what changed and leave every other object's identity intact — which is
 * what "correctly restore deleted objects and their properties/
 * references" actually requires.
 *
 * ## Deleted objects are kept alive, not recreated
 *
 * A delete command holds the real removed object in its closure (the
 * registries take a `keepAlive` flag for exactly this), so undoing a
 * delete puts *the same instance* back — every existing reference to it
 * keeps working. That's also why `discard()` exists: an object held alive
 * by a command that can never be replayed again is a leak, so the history
 * tells a command which side it was on when it fell off the stack and the
 * command releases whatever it was holding.
 *
 * ## Coalescing
 *
 * A slider fires an `input` event per pixel of travel; without merging,
 * one drag would bury the previous action under two hundred undo steps.
 * Consecutive pushes sharing a `mergeKey` within `MERGE_WINDOW_MS` collapse
 * into one entry that undoes to the *first* state and redoes to the *last*.
 * Gizmo drags don't need this — they have a real begin/end from
 * TransformControls, so they push exactly one command on release.
 */

/** How long two same-key changes can be apart and still count as one gesture. Long enough to cover a slider's event gaps, short enough that a deliberate second edit is its own undo step. */
const MERGE_WINDOW_MS = 700;

/** Beyond this the oldest entries are dropped. Bounded because delete commands hold real objects (and their GPU buffers) alive. */
const MAX_ENTRIES = 200;

export interface HistoryCommand {
  /** Shown on the Undo/Redo buttons' tooltips: "Undo Move Emitter". */
  label: string;
  /**
   * Consecutive commands sharing this key merge into one. Omit for
   * discrete actions (create, delete, toggle) that should each be their
   * own step.
   */
  mergeKey?: string;
  undo(): void;
  redo(): void;
  /**
   * Called when this command falls out of the history for good.
   *
   * `state` says which side it was on: `"applied"` means its `redo` is the
   * live state (it was on the undo stack), `"unapplied"` means its `undo`
   * is (it was on the redo stack). A create command holds nothing while
   * applied and holds a detached object while unapplied; a delete command
   * is the exact mirror. Without this distinction, releasing resources on
   * discard would free objects that are still in the scene.
   */
  discard?(state: "applied" | "unapplied"): void;
}

type Listener = () => void;

export class EditorHistory {
  /** Applied commands, oldest first. The top is what `undo()` reverses. */
  private readonly undoStack: HistoryCommand[] = [];
  /** Unapplied commands. The top is what `redo()` re-applies. */
  private readonly redoStack: HistoryCommand[] = [];
  private readonly listeners = new Set<Listener>();

  /** `undoStack.length` as of the last save — what `isDirty` compares against, so undoing back to the saved point correctly reports clean. */
  private savedDepth = 0;
  private lastPushAt = 0;
  /**
   * True while undo()/redo() is running.
   *
   * Applying a command mutates editor state, and the editors' own change
   * handlers would otherwise record that mutation as a *new* user action —
   * an undo that immediately pushes its own inverse, making the stack
   * unusable. Every push site checks this.
   */
  private applying = false;

  get isApplying(): boolean {
    return this.applying;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this.redoStack[this.redoStack.length - 1]?.label;
  }

  /** True when the current state differs from the last save. Tracked by stack depth rather than a boolean, so undoing back past your edits correctly reports clean again. */
  get isDirty(): boolean {
    return this.undoStack.length !== this.savedDepth;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /**
   * Records a command that has *already been applied*.
   *
   * Callers mutate first and push after, so the command's `redo()` is a
   * re-application rather than the first application — that keeps the
   * normal (non-undo) path free of any indirection through the history.
   */
  push(command: HistoryCommand): void {
    if (this.applying) return; // see `applying`

    // A new action invalidates the redo branch. Those commands can never
    // be replayed, so anything they were holding alive is released now.
    if (this.redoStack.length > 0) {
      for (const dropped of this.redoStack) dropped.discard?.("unapplied");
      this.redoStack.length = 0;
    }

    const now = Date.now();
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && command.mergeKey && top.mergeKey === command.mergeKey && now - this.lastPushAt <= MERGE_WINDOW_MS) {
      // Same gesture continuing: keep the original `undo` (the state
      // before the gesture started) and take the newest `redo` (its latest
      // state). The merged entry therefore spans the whole drag.
      top.redo = command.redo;
      top.label = command.label;
      this.lastPushAt = now;
      this.emit();
      return;
    }

    this.undoStack.push(command);
    this.lastPushAt = now;

    if (this.undoStack.length > MAX_ENTRIES) {
      const evicted = this.undoStack.shift();
      evicted?.discard?.("applied");
      // The saved marker slides with the window. Once the entry that made
      // the file dirty is gone, depth can no longer reach savedDepth, so
      // without this the editor would report dirty forever.
      this.savedDepth = Math.max(0, this.savedDepth - 1);
    }
    this.emit();
  }

  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    this.applying = true;
    try {
      command.undo();
    } finally {
      this.applying = false;
    }
    this.redoStack.push(command);
    // A merge must never span an undo — otherwise the next slider tweak
    // would fold itself into the entry that was just reversed.
    this.lastPushAt = 0;
    this.emit();
    return true;
  }

  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    this.applying = true;
    try {
      command.redo();
    } finally {
      this.applying = false;
    }
    this.undoStack.push(command);
    this.lastPushAt = 0;
    this.emit();
    return true;
  }

  /** Called after a successful write to disk — the current depth becomes the clean point. */
  markSaved(): void {
    this.savedDepth = this.undoStack.length;
    this.emit();
  }

  /**
   * Drops the whole history, releasing anything either side was holding.
   *
   * Called on editor teardown. Deliberately *not* called when switching
   * between collider and particle modes — one history serves both, which
   * is what makes an undo still available after you've switched modes and
   * come back.
   */
  clear(): void {
    for (const command of this.undoStack) command.discard?.("applied");
    for (const command of this.redoStack) command.discard?.("unapplied");
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.savedDepth = 0;
    this.lastPushAt = 0;
    this.emit();
  }

  /** Returns an unsubscribe function, same contract as EditorSelection.subscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    // Snapshot before iterating — a listener may subscribe or unsubscribe
    // in response, same reasoning as EventBus.emit.
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Builds a command that restores a plain-data snapshot of one object.
 *
 * The overwhelmingly common shape: capture the object's serialized form
 * before an edit, capture it after, and restore by writing the fields back
 * onto the *same live object*. Identity is preserved, so every reference
 * to it keeps working — which a create/destroy round trip would break.
 */
export function propertyCommand<T>(options: {
  label: string;
  mergeKey?: string;
  before: T;
  after: T;
  apply(data: T): void;
}): HistoryCommand {
  return {
    label: options.label,
    mergeKey: options.mergeKey,
    undo: () => options.apply(options.before),
    redo: () => options.apply(options.after),
  };
}
