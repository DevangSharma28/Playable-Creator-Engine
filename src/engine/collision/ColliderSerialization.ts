import * as THREE from "three";
import type { Collider } from "./Collider";
import type { ColliderManager } from "./ColliderManager";
import { BoxCollider } from "./BoxCollider";
import { SphereCollider } from "./SphereCollider";
import { CylinderCollider } from "./CylinderCollider";
import type { ColliderData, CollidersFileData } from "./ColliderTypes";
import { resolveSceneObject, sceneObjectPath } from "../SceneBindings";

/**
 * The bridge between src/game/colliders.json and a live ColliderManager.
 *
 * Same shape, and the same reasoning, as SceneBindings.ts: the JSON is a
 * real import in the module graph, so what you author in the 3D editor is
 * what ships — colliders authored in the editor exist in the production
 * build with no export step, and attachments are recorded by *scene path*
 * rather than uuid because three.js regenerates uuids on every GLB parse.
 *
 * Nothing here is editor-only. `loadColliders` runs in production; only
 * `colliderToData` (the save direction) is exclusively the editor's.
 */

/**
 * Builds every collider in `data` into `manager`, resolving attachments
 * against `scene`.
 *
 * Call it once the scene graph is assembled — an attachment can only
 * resolve against objects that are actually in the scene by then, exactly
 * like applySceneBindings. A collider whose attachment no longer resolves
 * is still created, as a world-space collider at its recorded offset, and
 * warns in dev: dropping it silently would make a renamed GLB node look
 * like a collision system that stopped working for no reason.
 */
export function loadColliders(manager: ColliderManager, data: CollidersFileData, scene: THREE.Scene): Collider[] {
  const built: Collider[] = [];
  for (const record of data.colliders ?? []) {
    const attachTo = record.attachPath || record.attachName ? resolveSceneObject(scene, { className: "", fieldName: "", objectPath: record.attachPath, objectName: record.attachName }) : undefined;
    if (!attachTo && (record.attachPath || record.attachName) && import.meta.env.DEV) {
      console.warn(`Colliders: "${record.name}" is attached to "${record.attachPath || record.attachName}", which no longer resolves — loading it as a world-space collider instead.`);
    }
    built.push(manager.add(colliderFromData(record, attachTo)));
  }
  return built;
}

/** One record -> one live collider (not yet registered). Exported for the editor, which builds colliders one at a time as you click. */
export function colliderFromData(record: ColliderData, attachTo: THREE.Object3D | undefined): Collider {
  const common = {
    id: record.id,
    name: record.name,
    isTrigger: record.isTrigger,
    enabled: record.enabled,
    tag: record.tag,
    mask: record.mask,
    attachTo,
    position: record.offset.position,
    rotation: record.offset.rotation,
    scale: record.offset.scale,
  };
  const collider =
    record.shape === "sphere"
      ? new SphereCollider({ ...common, radius: record.radius ?? 0.5 })
      : record.shape === "cylinder"
        ? new CylinderCollider({ ...common, radius: record.radius ?? 0.5, height: record.height ?? 1 })
        : new BoxCollider({ ...common, size: record.size ?? [1, 1, 1] });
  // Came from the file, so it goes back into the file — see Collider.persisted.
  collider.persisted = true;
  return collider;
}

/**
 * Writes a record's fields onto an **existing** collider, in place.
 *
 * The undo path's counterpart to `colliderFromData`. Rebuilding a collider
 * from data would be simpler, but it destroys and recreates the object —
 * so a script field assigned through Control Desk, or anything else
 * holding the instance, would be left pointing at a dead collider after a
 * single undo. Mutating in place keeps identity, which is the whole reason
 * the editor's history uses commands rather than scene snapshots.
 *
 * Shape *kind* is deliberately not applied: a BoxCollider can't become a
 * SphereCollider, and the editor offers no way to change it, so a record
 * whose kind disagrees with the live collider is a caller error rather
 * than something to silently half-apply.
 */
export function applyColliderData(collider: Collider, record: ColliderData, scene: THREE.Scene): void {
  collider.name = record.name;
  collider.tag = record.tag;
  collider.mask = [...record.mask];
  collider.isTrigger = record.isTrigger;
  collider.setEnabled(record.enabled);

  collider.offsetPosition.set(record.offset.position[0], record.offset.position[1], record.offset.position[2]);
  collider.offsetRotation.set(
    THREE.MathUtils.degToRad(record.offset.rotation[0]),
    THREE.MathUtils.degToRad(record.offset.rotation[1]),
    THREE.MathUtils.degToRad(record.offset.rotation[2])
  );
  collider.offsetScale.set(record.offset.scale[0], record.offset.scale[1], record.offset.scale[2]);

  if (collider instanceof BoxCollider && record.size) {
    collider.setSize(record.size[0], record.size[1], record.size[2]);
  } else if (collider instanceof SphereCollider && record.radius !== undefined) {
    collider.setRadius(record.radius);
  } else if (collider instanceof CylinderCollider) {
    if (record.radius !== undefined) collider.setRadius(record.radius);
    if (record.height !== undefined) collider.setHeight(record.height);
  }

  const target = record.attachPath || record.attachName ? resolveSceneObject(scene, { className: "", fieldName: "", objectPath: record.attachPath, objectName: record.attachName }) : undefined;
  // preserveWorld: false — the offset above is already the intended local
  // transform relative to this attachment, so re-deriving it from the
  // collider's current world position (what attachToObject does by
  // default) would move the volume instead of restoring it.
  collider.attachToObject(target, false);
}

/** The save direction — a live collider back into its persisted record. */
export function colliderToData(collider: Collider, scene: THREE.Scene): ColliderData {
  const attachPath = collider.attached ? sceneObjectPath(collider.attached, scene) : "";
  return {
    id: collider.id,
    name: collider.name,
    shape: collider.shape,
    isTrigger: collider.isTrigger,
    enabled: collider.enabled,
    tag: collider.tag,
    mask: [...collider.mask],
    attachPath,
    attachName: collider.attached?.name ?? "",
    offset: {
      position: [r(collider.offsetPosition.x), r(collider.offsetPosition.y), r(collider.offsetPosition.z)],
      rotation: [r(THREE.MathUtils.radToDeg(collider.offsetRotation.x)), r(THREE.MathUtils.radToDeg(collider.offsetRotation.y)), r(THREE.MathUtils.radToDeg(collider.offsetRotation.z))],
      scale: [r(collider.offsetScale.x), r(collider.offsetScale.y), r(collider.offsetScale.z)],
    },
    ...collider.shapeData(),
  };
}

/** Rounded on write, not on read: raw gizmo output is full float noise ("2.0000000000000004"), and a diff on colliders.json should show what changed, not float dust. */
function r(v: number): number {
  return Math.round(v * 10000) / 10000;
}
