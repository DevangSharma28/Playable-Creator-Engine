import * as THREE from "three";
import { Coin } from "./Coin";

const PICKUP_RADIUS = 0.7;

/**
 * Owns every Coin in the scene: spawning, per-frame animation, and
 * pickup detection against the player's position. Game.ts just calls
 * update() each frame and gets a callback when a coin is collected.
 */
export class CoinField {
  private readonly coins: Coin[] = [];
  private readonly spawnExtent: number;

  constructor(scene: THREE.Scene, count: number, playAreaBound: number) {
    // Keep coins a little further inside the walls than the player can travel.
    this.spawnExtent = Math.max(playAreaBound - 0.3, 0.5);
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
    return new THREE.Vector3(
      (Math.random() * 2 - 1) * this.spawnExtent,
      0.55,
      (Math.random() * 2 - 1) * this.spawnExtent
    );
  }
}
