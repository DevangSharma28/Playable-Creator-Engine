import type * as THREE from "three";

/** MIME type carried on the drag. Custom rather than "text/plain" so an unrelated text drag (a filename, selected prose) can never look like a scene object to a drop target. */
export const OBJECT_DRAG_MIME = "application/x-ion-scene-object";

/**
 * The one live scene object currently being dragged out of the Hierarchy,
 * if any.
 *
 * Exists because `DataTransfer` is deliberately unreadable during
 * `dragover` — the browser only exposes the *types* on the payload until
 * the actual `drop`, for privacy. That's a problem here: a drop target
 * wants to say "this field accepts what you're holding" (or refuse it)
 * while you're still hovering, and it can't do that from a uuid it isn't
 * allowed to read yet. Holding the real object alongside the drag solves
 * it without weakening the payload — the uuid still travels in the
 * DataTransfer as the authoritative identifier for the drop itself, and
 * this is only consulted for hover feedback and to resolve that uuid back
 * to a live object.
 *
 * Deliberately not part of EditorSelection: dragging something is not
 * selecting it, and a drag that ends in a cancel should leave the
 * selection exactly as it was.
 */
export class EditorDragSource {
  private dragged: THREE.Object3D | undefined;

  get object(): THREE.Object3D | undefined {
    return this.dragged;
  }

  get isDragging(): boolean {
    return this.dragged !== undefined;
  }

  begin(object: THREE.Object3D): void {
    this.dragged = object;
  }

  /** Called from `dragend`, which fires whether the drop succeeded, was refused, or was cancelled with Escape — so this can't leak a stale object into the next drag. */
  end(): void {
    this.dragged = undefined;
  }

  /** Resolves the uuid a drop actually carried, guarding against a payload from some other source that happens to use the same MIME type. */
  resolve(uuid: string): THREE.Object3D | undefined {
    return this.dragged && this.dragged.uuid === uuid ? this.dragged : undefined;
  }
}
