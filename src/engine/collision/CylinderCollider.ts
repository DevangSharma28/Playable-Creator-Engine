import * as THREE from "three";
import { Collider, type ColliderInit } from "./Collider";
import type { ColliderData, ColliderShape, CylinderWorld } from "./ColliderTypes";

export interface CylinderColliderInit extends ColliderInit {
  radius?: number;
  /** Full height along the cylinder's local +Y. */
  height?: number;
}

/**
 * An upright capped cylinder — upright in its *own* local space, so it
 * still tips and turns with whatever it's attached to.
 *
 * This is the shape a character wants. A box around a person is wrong the
 * moment they turn (the footprint changes with facing, so walking into the
 * same doorway sideways behaves differently), and a sphere is wrong for
 * anything taller than it is wide. A cylinder is rotation-invariant about
 * the up axis and still has a real height, which is why it's the standard
 * character volume and why the Player's collider here is one.
 *
 * Radius takes the larger of the two horizontal scale axes and height takes
 * the vertical one — same conservative reasoning as SphereCollider's.
 */
export class CylinderCollider extends Collider {
  readonly shape: ColliderShape = "cylinder";

  radius: number;
  /** Full height, not half. */
  height: number;

  private readonly worldShape: CylinderWorld = {
    kind: "cylinder",
    center: new THREE.Vector3(),
    axis: new THREE.Vector3(0, 1, 0),
    axisX: new THREE.Vector3(1, 0, 0),
    axisZ: new THREE.Vector3(0, 0, 1),
    halfHeight: 0.5,
    radius: 0.5,
  };
  private cachedBoundingRadius = 0.71;

  constructor(init: CylinderColliderInit = {}) {
    super({ name: "Cylinder Collider", ...init });
    this.radius = init.radius ?? 0.5;
    this.height = init.height ?? 1;
  }

  get world(): CylinderWorld {
    return this.worldShape;
  }

  get boundingRadius(): number {
    return this.cachedBoundingRadius;
  }

  setRadius(radius: number): this {
    this.radius = radius;
    return this;
  }

  setHeight(height: number): this {
    this.height = height;
    return this;
  }

  protected updateWorldShape(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3): void {
    this.worldShape.center.copy(position);
    // All three axes, not just the up one: the box↔cylinder path builds the
    // cylinder's tight OBB out of them, and deriving two arbitrary
    // perpendiculars per test instead would both cost more and pick a
    // different (still valid, but non-reproducible) pair every frame.
    this.worldShape.axisX.set(1, 0, 0).applyQuaternion(quaternion);
    this.worldShape.axis.set(0, 1, 0).applyQuaternion(quaternion);
    this.worldShape.axisZ.set(0, 0, 1).applyQuaternion(quaternion);
    this.worldShape.radius = Math.abs(this.radius) * Math.max(Math.abs(scale.x), Math.abs(scale.z));
    this.worldShape.halfHeight = Math.abs(this.height * scale.y) * 0.5;
    this.cachedBoundingRadius = Math.hypot(this.worldShape.radius, this.worldShape.halfHeight);
  }

  shapeData(): Partial<ColliderData> {
    return { radius: this.radius, height: this.height };
  }

  describeShape(): string {
    return `r ${round(this.radius)} · h ${round(this.height)}`;
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
