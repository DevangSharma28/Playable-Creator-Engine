import type * as THREE from "three";

/**
 * Shared vocabulary for the ION Collider & Area system — the shapes, the
 * serialized form that ships in src/game/colliders.json, and the
 * world-space shape descriptions the intersection tests actually consume.
 *
 * Deliberately physics-free. Nothing here has mass, velocity, restitution,
 * or a solver: a collider is a *volume with a transform*, and the only
 * question the system ever answers is "do these two volumes overlap right
 * now". Rapier and friends stay entirely out of it — see ColliderManager's
 * own doc comment for why a playable ad wants this and not a physics
 * engine.
 */

/** The three supported volumes. Deliberately small — every one of these has an exact, cheap overlap test against the other two (see intersect.ts). */
export type ColliderShape = "box" | "sphere" | "cylinder";

/** A collider's offset from whatever it's attached to, in that object's local space. Euler angles are degrees, matching what the Inspector shows. */
export interface ColliderTransformData {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

/**
 * One collider as persisted in src/game/colliders.json.
 *
 * The attachment is recorded by *path*, not uuid, for exactly the reason
 * SceneBindings.ts records its own assignments that way: three.js
 * regenerates uuids on every GLB parse, so a uuid written in one session
 * resolves to nothing in the next.
 */
export interface ColliderData {
  /** Stable across sessions — the identity the editor and the JSON agree on. */
  id: string;
  name: string;
  shape: ColliderShape;
  /** Box only: full width/height/depth (not half-extents — this is what the Inspector shows). */
  size?: [number, number, number];
  /** Sphere and cylinder. */
  radius?: number;
  /** Cylinder only: full height along its local +Y. */
  height?: number;
  /** Fires enter/stay/exit instead of acting as a solid volume. */
  isTrigger: boolean;
  enabled: boolean;
  /** Free-form gameplay label — "Player", "PlayerZone", "Pickup", ... */
  tag: string;
  /** Tags this collider will pair with at all. Empty means "every tag" — see ColliderManager.canPair for the AND semantics between two colliders' masks. */
  mask: string[];
  /** Slash-separated scene path of the object this collider follows, or "" for a world-space collider. Same format as SceneBindings.sceneObjectPath. */
  attachPath: string;
  /** Last path segment, kept as a name-only fallback exactly like SceneFieldBinding.objectName. */
  attachName: string;
  offset: ColliderTransformData;
}

/** The whole file. `version` is here for the same reason the layout/binding files carry one: a future format change needs somewhere to branch on. */
export interface CollidersFileData {
  version: number;
  colliders: ColliderData[];
}

/**
 * World-space shape descriptions — what intersect.ts operates on.
 *
 * These are rebuilt (in place, into pre-allocated vectors) once per frame
 * per collider by Collider.syncWorld(), never allocated per test. A
 * playable ad's frame budget doesn't tolerate a few hundred Vector3s of
 * garbage per frame, and the overlap tests are the hottest loop in the
 * system.
 */
export interface BoxWorld {
  kind: "box";
  center: THREE.Vector3;
  /** The box's three unit axes in world space — its orientation. */
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  /** Half-extents, already multiplied by world scale. */
  half: THREE.Vector3;
}

export interface SphereWorld {
  kind: "sphere";
  center: THREE.Vector3;
  /** Already multiplied by the largest world-scale axis — a sphere can't be squashed, so the largest axis is the honest (conservative) reading. */
  radius: number;
}

export interface CylinderWorld {
  kind: "cylinder";
  center: THREE.Vector3;
  /** Unit vector along the cylinder's local +Y, in world space. */
  axis: THREE.Vector3;
  /** The other two unit axes — precomputed here rather than derived per test, since the box-vs-cylinder path needs them to build the cylinder's tight OBB. */
  axisX: THREE.Vector3;
  axisZ: THREE.Vector3;
  halfHeight: number;
  radius: number;
}

export type ShapeWorld = BoxWorld | SphereWorld | CylinderWorld;
