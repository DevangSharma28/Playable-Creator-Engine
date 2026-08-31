import * as THREE from "three";
import { getActiveGame, type SimpleGameHost } from "./context";
import { SceneNode } from "./node";
import { Prop } from "./prop";

// Re-exported from their new home so every existing import path still resolves.
// The transform vocabulary these belong to is shared with `Prop` now, so it
// lives in node.ts — see SceneNode.
export { ION_OWNED, type Vec3Like } from "./node";

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
export class Entity extends SceneNode {
  /** The three.js object behind this entity. See SceneNode — ordinary work never needs it. */
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
  constructor(name?: string) {
    super();
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

  /** The entity's visual. Assign what `ION.scene.box()` and friends return. */
  set shape(object: Prop | THREE.Object3D | undefined) {
    if (object) this.object3D.add(object instanceof Prop ? object.object3D : object);
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
    // Unparent, free what ION built, retire attached colliders, stop any spin.
    this.releaseSceneResources();
    this.object3D.clear();
    this.owner.unregisterEntity(this);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }
}
