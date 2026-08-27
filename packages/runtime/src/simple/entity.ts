import * as THREE from "three";
import { getActiveGame } from "./context";

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

  /** Rotation in **degrees**, because that is what people think in. */
  get rotation(): Vec3Like {
    const e = this.object3D.rotation;
    const d = THREE.MathUtils.radToDeg;
    const r = THREE.MathUtils.degToRad;
    return {
      get x() { return d(e.x); },
      set x(v: number) { e.x = r(v); },
      get y() { return d(e.y); },
      set y(v: number) { e.y = r(v); },
      get z() { return d(e.z); },
      set z(v: number) { e.z = r(v); },
      set(x: number, y: number, z: number) { e.set(r(x), r(y), r(z)); },
    } as Vec3Like;
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
    const p = target instanceof Entity ? target.object3D.position : target;
    return this.object3D.position.distanceTo(new THREE.Vector3(p.x, p.y, p.z));
  }

  /** Attach something so it moves with this entity. */
  add(child: Entity | THREE.Object3D): this {
    this.object3D.add(child instanceof Entity ? child.object3D : child);
    return this;
  }

  /** The entity's visual. Assign what `ION.scene.box()` and friends return. */
  set shape(object: THREE.Object3D | undefined) {
    if (object) this.object3D.add(object);
  }

  /** Remove the entity from the game. Safe to call twice. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    this.object3D.removeFromParent();
    getActiveGame()?.unregisterEntity(this);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }
}
