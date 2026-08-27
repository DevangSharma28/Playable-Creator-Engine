import * as THREE from "three";
import { getActiveGame, type SimpleGameHost } from "./context";
import { disposeObject3D } from "../../../../src/engine/core/disposeScene";
import type { Collider } from "../../../../src/engine/collision";

/** Reused by distanceTo so a per-frame distance check allocates nothing. */
const scratch = new THREE.Vector3();

/**
 * Marks a mesh whose geometry and material this entity may free.
 *
 * `ION.scene.box()` and friends build a fresh geometry and material per call,
 * so an entity that owns one can release it. A model instantiated from the
 * asset manifest shares both with every other clone of that GLB and with the
 * loader's cache, so freeing it on one entity's destroy() would blank every
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
 * Anything in your game world: a player, an enemy, a pickup, a door.
 *
 * Creating one puts it in the scene and starts updating it. There is no
 * register step and nothing to remember to call — that wiring is the engine's
 * job and it happens in the constructor.
 *
 * ```ts
 * export class Player extends Entity {
 *   speed = 6;
 *   start() { this.shape = ION.scene.box({ color: "orange" }); }
 *   update(dt: number) {
 *     const a = ION.input.axis;
 *     this.moveBy(a.x * this.speed * dt, 0, a.y * this.speed * dt);
 *   }
 * }
 * ```
 */
export class Entity {
  /**
   * The three.js object behind this entity.
   *
   * Not needed for ordinary work — position, rotation, scale and the move
   * helpers cover that. It is here so an advanced case is possible rather
   * than blocked.
   */
  readonly object3D: THREE.Object3D;

  private destroyed = false;
  /**
   * The game this entity registered with, held rather than looked up again.
   *
   * destroy() used to ask for the *current* active game, which during teardown
   * is a different game or none at all — so an entity destroyed on the way out
   * silently skipped its own unregister.
   */
  private readonly owner: SimpleGameHost;
  /** Built once. The degrees view below is read every frame by anything that spins. */
  private rotationView: Vec3Like | undefined;
  /** Colliders given to this entity by `ION.colliders.attach`, retired with it. */
  private readonly bodies: Collider[] = [];

  constructor(name?: string) {
    this.object3D = new THREE.Group();
    this.object3D.name = name ?? this.constructor.name;
    const game = getActiveGame();
    if (!game) {
      throw new Error(
        `new ${this.constructor.name}() ran before the game existed.\n` +
          "  Create entities inside start() or update(), not at module top level."
      );
    }
    this.owner = game;
    game.registerEntity(this);
  }

  /** Runs once, right after the entity is created. Build its visuals here. */
  start(): void {}

  /** Runs every frame while the entity is alive. `dt` is seconds since the last frame. */
  update(_dt: number): void {}

  /** Runs when the entity is destroyed. */
  stop(): void {}

  /** Where the entity is. Writable: `this.position.y = 2`. */
  get position(): Vec3Like {
    return this.object3D.position;
  }

  /**
   * Rotation in **degrees**, because that is what people think in.
   *
   * The view is built once and kept. It used to be rebuilt — a fresh object
   * and seven closures — on every read, which for the ordinary
   * `this.rotation.y += 90 * dt` in an update() meant an allocation per entity
   * per frame, and a GC pause is exactly the kind of jank a playable cannot
   * afford.
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

  /** Show or hide the entity. It keeps updating either way. */
  get visible(): boolean {
    return this.object3D.visible;
  }
  set visible(v: boolean) {
    this.object3D.visible = v;
  }

  /** Put the entity at an exact spot. */
  moveTo(x: number, y: number, z: number): this {
    this.object3D.position.set(x, y, z);
    return this;
  }

  /** Shift the entity by an amount — the usual way to move something each frame. */
  moveBy(x: number, y: number, z: number): this {
    this.object3D.position.x += x;
    this.object3D.position.y += y;
    this.object3D.position.z += z;
    return this;
  }

  /** Turn the entity by an amount, in degrees. */
  rotateBy(x: number, y: number, z: number): this {
    const r = THREE.MathUtils.degToRad;
    this.object3D.rotation.x += r(x);
    this.object3D.rotation.y += r(y);
    this.object3D.rotation.z += r(z);
    return this;
  }

  /** Face a point or another entity. */
  lookAt(target: Entity | { x: number; y: number; z: number }): this {
    const p = target instanceof Entity ? target.object3D.position : target;
    this.object3D.lookAt(p.x, p.y, p.z);
    return this;
  }

  /** Straight-line distance to another entity or point. */
  distanceTo(target: Entity | { x: number; y: number; z: number }): number {
    if (target instanceof Entity) return this.object3D.position.distanceTo(target.object3D.position);
    // A shared scratch vector rather than a new one: distance checks are the
    // most common thing in an update(), and this is called from inside loops.
    return this.object3D.position.distanceTo(scratch.set(target.x, target.y, target.z));
  }

  /** Attach something so it moves with this entity. */
  add(child: Entity | THREE.Object3D): this {
    this.object3D.add(child instanceof Entity ? child.object3D : child);
    return this;
  }

  /** @internal — `ION.colliders.attach` records the collider here so destroy() takes it back out of the world. */
  trackCollider(collider: Collider): void {
    this.bodies.push(collider);
  }

  /** The entity's visual. Assign what `ION.scene.box()` and friends return. */
  set shape(object: THREE.Object3D | undefined) {
    if (object) this.object3D.add(object);
  }

  /**
   * Remove the entity from the game. Safe to call twice.
   *
   * Frees the GPU memory behind anything `ION.scene.*` built for this entity.
   * Without that, a game that spawns and destroys pickups — which is most
   * playables — uploaded a new geometry and material per spawn and never gave
   * one back, so GPU memory climbed for as long as the ad ran. Meshes cloned
   * from the asset manifest are left alone; see ION_OWNED.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.stop();
    } catch (err) {
      // One entity's teardown must not abort the rest of the sweep during a
      // game-wide dispose.
      console.error(`ION: ${this.object3D.name}.stop() threw during destroy()`, err);
    }
    this.object3D.removeFromParent();
    this.object3D.traverse((node) => {
      if (node.userData[ION_OWNED]) disposeObject3D(node);
    });
    this.object3D.clear();
    // A collider outliving the thing it was attached to keeps overlapping at
    // whatever transform it last saw, so a destroyed pickup would go on firing
    // the zone it was standing in.
    for (const body of this.bodies) body.destroy();
    this.bodies.length = 0;
    this.owner.unregisterEntity(this);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }
}
