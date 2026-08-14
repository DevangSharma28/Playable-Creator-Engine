import * as THREE from "three";

/**
 * Common contract for anything that lives in the scene and needs a
 * per-frame update. New gameplay objects (Enemy, Worker, Particle,
 * Pickup, ...) should follow this same shape — one class, one file,
 * under src/entities/ — so Game.ts can treat them uniformly.
 *
 * Objects with extra per-frame inputs (Player needs joystick axis, for
 * example) can widen their own update() signature; the interface is a
 * minimum contract, not a strict override.
 */
export interface Entity {
  readonly object3D: THREE.Object3D;
  update(dt: number, elapsed: number): void;
  /** Optional cleanup (geometry/material/texture disposal) for entities spawned/despawned at runtime. */
  dispose?(): void;
}
