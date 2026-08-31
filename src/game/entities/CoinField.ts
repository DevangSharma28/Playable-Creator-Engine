import * as THREE from "three";
import { Coin } from "./Coin";
import type { World } from "../world/World";

const PICKUP_RADIUS = 0.7;
/** How far in from the play area's edge a coin may spawn — keeps them off the walls rather than flush against them. */
const SPAWN_MARGIN = 0.3;
/** Coins float this far above the floor. */
const COIN_HEIGHT = 0.55;

/**
 * Owns every Coin in the scene: spawning, per-frame animation, and
 * pickup detection against the player's position. Game.ts just calls
 * update() each frame and gets a callback when a coin is collected.
 */
export class CoinField {
  private readonly coins: Coin[] = [];

  /**
   * `world` rather than a single half-extent: the play area is a measured,
   * off-centre box (see World), and scattering coins across a square
   * centred on the origin put most of them outside the room.
   */
  constructor(scene: THREE.Scene, count: number, private readonly world: World) {
    for (let i = 0; i < count; i++) {
      this.coins.push(new Coin(scene, this.randomPosition()));
    }
  }

  get total(): number {
    return this.coins.length;
  }

  update(dt: number, elapsed: number, playerPosition: THREE.Vector3, onCollect: () => void): void {
    for (const coin of this.coins) {
      coin.update(dt, elapsed);
      if (coin.collected) continue;

      const dx = coin.object3D.position.x - playerPosition.x;
      const dz = coin.object3D.position.z - playerPosition.z;
      if (Math.sqrt(dx * dx + dz * dz) < PICKUP_RADIUS) {
        coin.collect();
        onCollect();
      }
    }
  }

  private randomPosition(): THREE.Vector3 {
    // randomPoint only writes x/z, so the height set here survives.
    return this.world.randomPoint(SPAWN_MARGIN, new THREE.Vector3(0, COIN_HEIGHT, 0));
  }
}
