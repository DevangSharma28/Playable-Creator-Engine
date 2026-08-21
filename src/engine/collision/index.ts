/**
 * The ION Collider & Area system's public surface — one import path for
 * gameplay code:
 *
 *   import { BoxCollider, CylinderCollider } from "../engine/collision";
 *
 * The manager itself is usually reached through the facade instead
 * (`Ion.colliders`), which is bound before Game.create() runs, so entity
 * constructors can register their own volumes without any boot-order
 * ceremony. See src/engine/Ion.ts.
 */
export { Collider, type ColliderEventHandler, type ColliderEventHandle, type ColliderInit } from "./Collider";
export { BoxCollider, type BoxColliderInit } from "./BoxCollider";
export { SphereCollider, type SphereColliderInit } from "./SphereCollider";
export { CylinderCollider, type CylinderColliderInit } from "./CylinderCollider";
export { ColliderManager, COLLIDERS_GROUP_NAME, type ColliderStats } from "./ColliderManager";
export { loadColliders, colliderFromData, colliderToData } from "./ColliderSerialization";
export type { ColliderData, CollidersFileData, ColliderShape, ColliderTransformData, ShapeWorld, BoxWorld, SphereWorld, CylinderWorld } from "./ColliderTypes";
export { shapesOverlap, shapeContainsPoint } from "./intersect";
