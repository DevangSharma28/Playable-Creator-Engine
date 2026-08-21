import * as THREE from "three";
import { Collider, type ColliderInit } from "./Collider";
import type { BoxWorld, ColliderData, ColliderShape } from "./ColliderTypes";

export interface BoxColliderInit extends ColliderInit {
  /** Full extents, not half — width (X), height (Y), depth (Z). Defaults to a 1×1×1 unit box. */
  size?: THREE.Vector3 | [number, number, number];
}

/**
 * An oriented box. Rotates and scales with whatever it's attached to, so
 * it stays a true OBB rather than degrading into an axis-aligned
 * approximation the moment its parent turns — see intersect.ts's boxBox,
 * which is a full 15-axis SAT test for exactly that reason.
 *
 * `size` is the box's own dimensions; the offset scale multiplies it. Both
 * exist because they mean different things in the editor: size is what you
 * type ("this zone is 4 units wide"), offset scale is what the transform
 * gizmo's scale handles write.
 */
export class BoxCollider extends Collider {
  readonly shape: ColliderShape = "box";

  /** Full width/height/depth in the collider's own local space. */
  readonly size = new THREE.Vector3(1, 1, 1);

  private readonly worldShape: BoxWorld = {
    kind: "box",
    center: new THREE.Vector3(),
    axes: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
    half: new THREE.Vector3(0.5, 0.5, 0.5),
  };
  private cachedBoundingRadius = 0.87;

  constructor(init: BoxColliderInit = {}) {
    super({ name: "Box Collider", ...init });
    if (init.size) {
      if (Array.isArray(init.size)) this.size.set(init.size[0], init.size[1], init.size[2]);
      else this.size.copy(init.size);
    }
  }

  get world(): BoxWorld {
    return this.worldShape;
  }

  get boundingRadius(): number {
    return this.cachedBoundingRadius;
  }

  setSize(x: number, y: number, z: number): this {
    this.size.set(x, y, z);
    return this;
  }

  protected updateWorldShape(position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3): void {
    this.worldShape.center.copy(position);
    this.worldShape.axes[0].set(1, 0, 0).applyQuaternion(quaternion);
    this.worldShape.axes[1].set(0, 1, 0).applyQuaternion(quaternion);
    this.worldShape.axes[2].set(0, 0, 1).applyQuaternion(quaternion);
    this.worldShape.half.set(
      Math.abs(this.size.x * scale.x) * 0.5,
      Math.abs(this.size.y * scale.y) * 0.5,
      Math.abs(this.size.z * scale.z) * 0.5
    );
    this.cachedBoundingRadius = this.worldShape.half.length();
  }

  shapeData(): Partial<ColliderData> {
    return { size: [this.size.x, this.size.y, this.size.z] };
  }

  describeShape(): string {
    return `${round(this.size.x)} × ${round(this.size.y)} × ${round(this.size.z)}`;
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
