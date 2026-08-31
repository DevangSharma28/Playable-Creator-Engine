import * as THREE from "three";
import { disposeMaterial } from "../../../../src/engine/core/disposeScene";
import { LoopAnimator } from "../../../../src/engine/core/Animator";
import type { Collider } from "../../../../src/engine/collision";

/** Reused by distanceTo so a per-frame distance check allocates nothing. */
const scratch = new THREE.Vector3();

/**
 * Marks a mesh whose geometry and material ION built and may therefore free.
 *
 * `ION.scene.box()` and friends build a fresh geometry and material per call,
 * so whatever ends up owning one can release it. A model instantiated from the
 * asset manifest shares both with every other clone of that GLB and with the
 * loader's cache, so freeing it on one handle's destroy() would blank every
 * other copy in the scene. The flag is what tells the two apart.
 */
export const ION_OWNED = "__ionOwned";

/** A live x/y/z view. Reading and writing go straight through — no copies, no sync step. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): void;
}

/**
 * Everything in the world you can move, turn, scale, hide or throw away.
 *
 * The shared half of `Entity` and `Prop`. It exists so there is **one**
 * vocabulary to learn rather than two: whether you are holding something you
 * wrote a class for or something `ION.scene.box()` handed back, `moveBy`,
 * `rotation.y`, `lookAt` and `destroy()` mean the same thing and take the same
 * units.
 *
 * ## Why this is not "just use the three.js object"
 *
 * Because the units and the lifecycle are both wrong for game code:
 *
 * - `Object3D.rotation` is in **radians**. Every playable that ever span a
 *   coin wrote `rotation.y += dt * 2` and then had to reason about what
 *   `2` meant. Here it is degrees, and `2` is two degrees.
 * - `removeFromParent()` takes something out of the scene and **leaks its
 *   geometry and material**, because three.js frees GPU memory only when
 *   something calls `.dispose()`. A playable that spawns and destroys pickups
 *   — which is most of them — climbed in GPU memory for as long as the ad ran.
 *   `destroy()` here does both, and knows which resources are safe to free.
 * - `.material.color.set(0xff0000)` requires knowing that a mesh has a
 *   material, that the material has a color, and that the color is not a
 *   number. `handle.color = "red"` requires knowing none of it.
 *
 * The three.js object is still right there on `.object3D` for the cases this
 * does not cover. It is an escape hatch, not the main road.
 */
export abstract class SceneNode {
  /**
   * The three.js object behind this handle.
   *
   * Not needed for ordinary work. It is here so an advanced case is possible
   * rather than blocked.
   */
  abstract readonly object3D: THREE.Object3D;

  /** Colliders attached through `ION.colliders.attach`, retired when this is destroyed. */
  protected readonly bodies: Collider[] = [];
  /** Built once, then kept — see `rotation`. */
  private rotationView: Vec3Like | undefined;
  private spinner: LoopAnimator | undefined;

  /** The name this was given — what `ION.scene.find()` looks up. */
  get name(): string {
    return this.object3D.name;
  }
  set name(value: string) {
    this.object3D.name = value;
  }

  /** Where it is. Writable: `thing.position.y = 2`. */
  get position(): Vec3Like {
    return this.object3D.position;
  }

  /**
   * Rotation in **degrees**, because that is what people think in.
   *
   * The view is built once and kept. Rebuilding it — a fresh object and seven
   * closures — on every read meant an allocation per object per frame for the
   * ordinary `thing.rotation.y += 90 * dt`, and a GC pause is exactly the kind
   * of jank a playable cannot afford.
   */
  get rotation(): Vec3Like {
    if (this.rotationView) return this.rotationView;
    const e = this.object3D.rotation;
    const d = THREE.MathUtils.radToDeg;
    const r = THREE.MathUtils.degToRad;
    this.rotationView = {
      get x() { return d(e.x); },
      set x(v: number) { e.x = r(v); },
      get y() { return d(e.y); },
      set y(v: number) { e.y = r(v); },
      get z() { return d(e.z); },
      set z(v: number) { e.z = r(v); },
      set(x: number, y: number, z: number) { e.set(r(x), r(y), r(z)); },
    } as Vec3Like;
    return this.rotationView;
  }

  get scale(): Vec3Like {
    return this.object3D.scale;
  }

  /** Scale every axis at once. `thing.size = 2` is twice as big. */
  set size(value: number) {
    this.object3D.scale.setScalar(value);
  }

  /** Show or hide it. An Entity keeps updating either way. */
  get visible(): boolean {
    return this.object3D.visible;
  }
  set visible(v: boolean) {
    this.object3D.visible = v;
  }

  /** Put it at an exact spot. */
  moveTo(x: number, y: number, z: number): this {
    this.object3D.position.set(x, y, z);
    return this;
  }

  /** Shift it by an amount — the usual way to move something each frame. */
  moveBy(x: number, y: number, z: number): this {
    this.object3D.position.x += x;
    this.object3D.position.y += y;
    this.object3D.position.z += z;
    return this;
  }

  /** Turn it by an amount, in degrees. */
  rotateBy(x: number, y: number, z: number): this {
    const r = THREE.MathUtils.degToRad;
    this.object3D.rotation.x += r(x);
    this.object3D.rotation.y += r(y);
    this.object3D.rotation.z += r(z);
    return this;
  }

  /**
   * Turn forever, at `degreesPerSecond`. Negative goes the other way; `0`
   * stops. Returns this, so `ION.scene.box().spin(120)` reads as one thing.
   *
   * This is the single most common thing a playable does to a prop — a
   * spinning coin, a rotating reward, a turning arrow — and writing it by hand
   * means keeping the object, finding it every frame, and remembering that
   * `rotation` is radians. It runs on **game time**, so it freezes with
   * gameplay while an editor is open instead of spinning behind it, and it is
   * cancelled by `destroy()`.
   */
  spin(degreesPerSecond: number, axis: "x" | "y" | "z" = "y"): this {
    this.spinner?.cancel();
    this.spinner = undefined;
    if (!degreesPerSecond) return this;

    const euler = this.object3D.rotation;
    const direction = Math.sign(degreesPerSecond);
    const turn = THREE.MathUtils.degToRad(360) * direction;
    let previous = 0;
    // Applied as a *delta* rather than an absolute angle, so a spin composes
    // with whatever else turns the object instead of fighting it — and so the
    // wrap at the end of each cycle is seamless rather than a snap back to
    // where the spin happened to start.
    this.spinner = new LoopAnimator({ time: 360 / Math.abs(degreesPerSecond) }, (t) => {
      const delta = t >= previous ? t - previous : t + 1 - previous;
      previous = t;
      euler[axis] += delta * turn;
    });
    return this;
  }

  /** Stop a `spin()`. Leaves it wherever it got to. */
  stopSpin(): this {
    this.spinner?.cancel();
    this.spinner = undefined;
    return this;
  }

  /** Face a point or another thing. */
  lookAt(target: SceneNode | { x: number; y: number; z: number }): this {
    const p = target instanceof SceneNode ? target.object3D.position : target;
    this.object3D.lookAt(p.x, p.y, p.z);
    return this;
  }

  /** Straight-line distance to another thing or a point. */
  distanceTo(target: SceneNode | { x: number; y: number; z: number }): number {
    if (target instanceof SceneNode) return this.object3D.position.distanceTo(target.object3D.position);
    // A shared scratch vector rather than a new one: distance checks are the
    // most common thing in an update(), and this is called from inside loops.
    return this.object3D.position.distanceTo(scratch.set(target.x, target.y, target.z));
  }

  /** Attach something so it moves with this. */
  add(child: SceneNode | THREE.Object3D): this {
    this.object3D.add(child instanceof SceneNode ? child.object3D : child);
    return this;
  }

  /** @internal — `ION.colliders.attach` records the collider here so destroy() takes it back out of the world. */
  trackCollider(collider: Collider): void {
    this.bodies.push(collider);
  }

  /**
   * Everything `destroy()` has to do regardless of which kind of handle this
   * is: stop the spin, unparent, free the GPU resources ION built for it, and
   * retire any collider attached to it.
   *
   * A collider outliving the thing it was attached to keeps overlapping at
   * whatever transform it last saw, so a destroyed pickup would go on firing
   * the zone it was standing in.
   */
  protected releaseSceneResources(): void {
    this.stopSpin();
    this.object3D.removeFromParent();
    // Each marked node's **own** geometry and material, and nothing below it.
    // This used to hand the marked node to `disposeObject3D`, which walks the
    // whole subtree — so anything parented under an ION-built shape was freed
    // along with it, marker or no marker. Attach a model from the asset
    // manifest to a box and destroying the box blanked every other clone of
    // that GLB in the scene, because they all share one geometry. The marker
    // means "these resources are ION's to free", and that claim is about one
    // node, not its descendants.
    this.object3D.traverse((node) => {
      if (!node.userData[ION_OWNED]) return;
      const mesh = node as Partial<THREE.Mesh> & THREE.Object3D;
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      if (Array.isArray(material)) for (const entry of material) disposeMaterial(entry);
      else if (material) disposeMaterial(material);
    });
    for (const body of this.bodies) body.destroy();
    this.bodies.length = 0;
  }
}
