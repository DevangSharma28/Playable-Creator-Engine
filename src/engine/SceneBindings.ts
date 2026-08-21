import type * as THREE from "three";

/**
 * One "Pick" assignment from the 3D Viewer/Editor's Control Desk — "this
 * class's field gets that object out of the scene graph."
 *
 * The scene object is identified by *path*, not by uuid: three.js
 * regenerates uuids every time a GLB is parsed, so a uuid saved in one
 * session resolves to nothing in the next — which is exactly why an
 * assignment made in the editor came back `undefined` after a reload.
 * `objectName` is kept alongside it as a fallback for the common case
 * where the model gets re-exported with a slightly different hierarchy but
 * the same node names (the same name-based lookup `Game.ts` already relies
 * on for `walkablearea`/`cinemafloor`/`Colliders`, and that
 * scripts/compress-assets.mjs deliberately preserves node names to keep
 * working).
 */
export interface SceneFieldBinding {
  className: string;
  fieldName: string;
  /** Slash-separated names from the scene root down to the object, e.g. "Scene/props/popcornMachine". Unnamed nodes appear as "#<childIndex>". */
  objectPath: string;
  /** Last segment of objectPath — used as a fallback getObjectByName() lookup if the full path no longer resolves. */
  objectName: string;
}

export interface SceneBindingsData {
  version: number;
  bindings: SceneFieldBinding[];
}

/** Path segment for one node — its name, or a positional "#index" for the unnamed nodes GLB exports are full of. */
function segmentFor(obj: THREE.Object3D): string {
  if (obj.name) return obj.name;
  const index = obj.parent ? obj.parent.children.indexOf(obj) : 0;
  return `#${index}`;
}

/**
 * The path to record for an object, relative to (and excluding) the scene
 * root — the inverse of resolveSceneObject below.
 */
export function sceneObjectPath(object: THREE.Object3D, scene: THREE.Scene): string {
  const segments: string[] = [];
  let node: THREE.Object3D | null = object;
  while (node && node !== scene) {
    segments.unshift(segmentFor(node));
    node = node.parent;
  }
  return segments.join("/");
}

/**
 * Finds the object a binding refers to: exact path first, then a
 * name-only search anywhere in the scene. Returns undefined rather than
 * throwing — a binding pointing at content that's since been renamed or
 * removed should leave the field alone, not break the boot.
 */
export function resolveSceneObject(scene: THREE.Scene, binding: SceneFieldBinding): THREE.Object3D | undefined {
  if (binding.objectPath) {
    let node: THREE.Object3D | undefined = scene;
    for (const segment of binding.objectPath.split("/")) {
      if (!node) break;
      const children: THREE.Object3D[] = node.children;
      node = segment.startsWith("#") ? children[Number(segment.slice(1))] : children.find((child) => child.name === segment);
    }
    if (node) return node;
  }
  return binding.objectName ? scene.getObjectByName(binding.objectName) : undefined;
}

/**
 * Resolves every scene binding for `className` and writes each onto
 * `instance` — the runtime half of Control Desk's "⊙ Pick" flow, and the
 * exact counterpart of Bindings.ts's `applyBindings` for UI elements
 * (same explicit, no-reflection call shape, same "first thing that
 * resolves wins, otherwise leave the field alone" behavior).
 *
 * Call it after the scene graph is fully assembled — a binding can only
 * resolve against objects that are actually in the scene by then. In this
 * game `Game.ts` runs it over every entry in its `inspectables` map at the
 * end of the constructor, so any class registered there gets persisted
 * scene assignments for free without naming itself here.
 */
export function applySceneBindings(instance: object, className: string, data: SceneBindingsData, scene: THREE.Scene): void {
  for (const binding of data.bindings) {
    if (binding.className !== className) continue;
    const object = resolveSceneObject(scene, binding);
    if (object !== undefined) {
      (instance as Record<string, unknown>)[binding.fieldName] = object;
    } else if (import.meta.env.DEV) {
      // Worth saying out loud in dev: unlike a UI binding (where a missing
      // element usually means "not designed yet"), a scene binding that
      // stops resolving means real content moved or got renamed, and the
      // field will silently stay undefined at runtime.
      console.warn(`SceneBindings: ${className}.${binding.fieldName} -> "${binding.objectPath}" no longer resolves in the scene.`);
    }
  }
}
