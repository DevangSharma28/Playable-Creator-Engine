import * as THREE from "three";
import { Collider, type ColliderInit } from "./Collider";
import type { ColliderData, ColliderShape, SphereWorld } from "./ColliderTypes";

export interface SphereColliderInit extends ColliderInit {
  radius?: number;
}

/**
 * A sphere. The cheapest volume in the system — sphere↔sphere is one
 * squared distance — and the one to reach for when a pickup or a proximity
 * prompt just needs "within this far of that point".
 *
 * Non-uniform parent scale has no honest sphere answer (a squashed sphere
 * is an ellipsoid, which the intersection tests don't model), so the
 * largest scale axis wins. That's deliberately the conservative direction:
 * the volume can come out slightly too big, never too small, so a trigger
 * still fires rather than silently missing.
 */
export class SphereCollider extends Collider {
  readonly shape: ColliderShape = "sphere";

  radius: number;

  private readonly worldShape: SphereWorld = { kind: "sphere", center: new THREE.Vector3(), radius: 0.5 };

  constructor(init: SphereColliderInit = {}) {
    super({ name: "Sphere Collider", ...init });
    this.radius = init.radius ?? 0.5;
  }

  get world(): SphereWorld {
    return this.worldShape;
  }

  get boundingRadius(): number {
    return this.worldShape.radius;
  }

  setRadius(radius: number): this {
    this.radius = radius;
    return this;
  }

  protected updateWorldShape(position: THREE.Vector3, _quaternion: THREE.Quaternion, scale: THREE.Vector3): void {
    this.worldShape.center.copy(position);
    this.worldShape.radius = Math.abs(this.radius) * Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z));
  }

  shapeData(): Partial<ColliderData> {
    return { radius: this.radius };
  }

  describeShape(): string {
    return `r ${Math.round(this.radius * 1000) / 1000}`;
  }
}
